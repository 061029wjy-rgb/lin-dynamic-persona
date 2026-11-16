import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const s='s',a='char',k='queue:s:char',A='anchor-A',B='anchor-B',X='src-X',Y='src-Y',Z='src-Z';
const bad=(p,code)=>assert.rejects(p,e=>e.code===code,'expected '+code);
const auth=q=>({callerOwner:q.claimOwner,fencingToken:q.fencingToken});
const get=(c,key)=>c('get','usage',key);
const append=(c,...hs)=>c('appendQueueAnchors',s,a,hs,{branchRevision:'world-A'});
const claim=async(c,owner='甲',ms=60000)=>auth(await c('claimQueue',s,a,owner,ms));
const facts=c=>c('readQueueFacts',s,a),audit=c=>c('auditQueueLedger',s,a);
const map=(c,h,ss,o,extra={})=>c('registerQueueSources',s,a,h,ss,'finger-'+h,{...o,...extra});
const manifest=(batch='batch-1',anchors=[A],ss=[X])=>({batchId:batch,streamId:s,actorId:a,originalBranchHead:'head-A',originalRevision:0,anchorIds:anchors,sourceIds:ss,sourceFingerprint:'batch-finger',payloadFingerprint:'payload-finger',providerProfileId:'p',modelId:'local',contractVersion:'full'});
const opts=(lease,job='j1',extras={})=>({...lease,jobId:job,expectedAttemptNo:0,previousJobId:null,session:'session1',limits:{total:100,day:100,session:100,interval:0,timeout:60},...extras});
async function prepared(c,ms=60000){await append(c,A);const o=await claim(c,'甲',ms);await map(c,A,[X],o);return o;}
const reserve=(c,f,o)=>c('specReserve',f,o);
const mark=(c,f,job,o)=>c('markBatchAttemptSent',s,a,f.batchId,job,f.sourceIds,{...o,payloadFingerprint:f.payloadFingerprint});
const commit=(c,o,extra={})=>c('specCommit',{queueKey:k,actor:a,batchId:'batch-1',job:'j1',consumedAnchors:[A],consumedSourceIds:[X],processed:[X],head:'head-A',...o,...extra});
const fail=(c,o)=>c('failBatchAttempt',s,a,'batch-1','j1',{...o,reason:'network_unknown'});
async function failed(c){const o=await prepared(c);const f=manifest();await reserve(c,f,opts(o));await mark(c,f,'j1',o);await fail(c,o);return f;}
const ret=(c,hs,o,state='stale_branch',other={})=>c('retireQueueAnchors',s,a,hs,{...o,state,reason:'selected_swipe_changed',operationId:'op-retire',branchRevision:'A:3',...other});

export const cases=[
['A-T01 有效持有人的旧快照不能覆盖其他写者追加；CAS、租约字段和释放都不替换成员',async h=>{
 const [c,d]=h.peers;await append(c,A);const snap=await c('claimQueue',s,a,'甲'),o=auth(snap);
 await d('appendQueueAnchors',s,a,[B],{claimOwner:'rogue',sent:true,activeBatch:{batchId:'rogue'},fencingToken:80,status:'sending'});
 const res=await c('saveQueue',s,a,{...snap,status:'preparing'},{...o,replaceAnchors:true});assert.deepEqual(res.anchors,[A,B]);assert.equal(res.claimOwner,'甲');assert.equal(res.sent,false);
 await bad(c('patchQueueState',s,a,{status:'preparing'},{...o,expectedRevision:snap.queueRevision}),'REVISION_CONFLICT');
 await bad(c('patchQueueState',s,a,{anchors:[A]},o),'PATCH_FIELD');
 await bad(d('patchQueueState',s,a,{status:'queued'}),'LEASE_REQUIRED');
 await c('patchQueueState',s,a,{reason:'assembled'},o);await c('releaseQueueLease',s,a,'甲',o.fencingToken,{anchors:[A],status:'queued'});
 assert.deepEqual((await facts(d)).anchors,[A,B]);assert.equal((await audit(d)).acceptedAnchorCount,2);assert.equal((await d('listQueueHistory',s,a,'anchor',B))[0].kind,'receipt');
}],
['A-T02 不同事件循环交错两种顺序；实际来源精确 ACK；同楼部分提交不删未处理片段',async h=>{
 const [c,d]=h.peers;await append(c,A);const o=await claim(c);await map(c,A,[X],o,{complete:false});assert.equal((await audit(c)).ok,true);
 await bad(reserve(c,manifest(),opts(o)),'SOURCE_MISMATCH');await map(c,A,[Y],o,{complete:false});await map(c,A,[X,Y],o);await map(c,A,[X],o,{complete:false});
 const f=manifest();await reserve(c,f,opts(o));await mark(c,f,'j1',o);
 await bad(commit(c,o),'INCOMPLETE_ACK');await bad(commit(c,o,{consumedAnchors:[],processed:[X,Z]}),'SOURCE_MISMATCH');
 await Promise.all([delay(0).then(()=>d('appendQueueAnchors',s,a,[B])),commit(c,o,{consumedAnchors:[]})]);
 let live=await facts(d);assert.deepEqual(live.anchors,[A,B]);assert.deepEqual(live.processedSourceIds,[X]);assert.equal((await audit(d)).ok,true);
 const o2=await claim(d,'乙'),f2={...manifest('batch-2',[A],[Y]),originalRevision:1};
 await reserve(d,f2,opts(o2,'j2'));await mark(d,f2,'j2',o2);
 await Promise.all([commit(d,o2,{batchId:'batch-2',job:'j2',expected:1,seq:1,revision:2,consumedSourceIds:[Y],processed:[X,Y]}).then(()=>delay(0)),delay(2).then(()=>append(c,'C'))]);
 live=await facts(c);assert.deepEqual(live.anchors,[B,'C']);assert.deepEqual([...live.processedSourceIds].sort(),[X,Y]);
 assert.equal((await audit(c)).ok,true);assert.deepEqual((await append(c,A)).anchors,[B,'C']);assert.equal((await get(c,'job:j1')).status,'committed');
}],
['A-T03 实际租约到期、换主、旧/未来/省略 token 的 patch/release/commit 全部拒绝；空队列不发生 ABA',async h=>{
 const [c,d]=h.peers;await append(c,A);const old=await claim(c,'甲',45);await delay(70);await bad(c('patchQueueState',s,a,{status:'preparing'},old),'LEASE_CONFLICT');
 const fresh=await claim(d,'乙');assert.ok(fresh.fencingToken>old.fencingToken);
 for(const [who,t] of [['甲',old.fencingToken],['乙',fresh.fencingToken+50]]){const x={callerOwner:who,fencingToken:t};await bad(c('patchQueueState',s,a,{status:'queued'},x),'FENCE_CONFLICT');await bad(c('releaseQueueLease',s,a,who,t,{}),'FENCE_CONFLICT');await bad(commit(c,x),'FENCE_CONFLICT');}
 await bad(commit(c,{}),'LEASE_REQUIRED');await bad(c('releaseQueueLease',s,a,'乙',null,{}),'LEASE_REQUIRED');assert.deepEqual((await facts(c)).anchors,[A]);
 assert.equal((await facts(c)).lease.callerOwner,'乙');await ret(d,[A],fresh);await d('releaseQueueLease',s,a,'乙',fresh.fencingToken);await append(c,B);const later=await claim(c,'乙');assert.ok(later.fencingToken>fresh.fencingToken);await bad(commit(c,fresh),'FENCE_CONFLICT');
}],
['A-T04 十个独立连接同时追加同一锚点，重复登记只留一个责任条目',async h=>{
 await Promise.all(h.peers.map(c=>append(c,A)));const c=h.peers[0],o=await claim(c);const v=await map(c,A,[X],o);assert.deepEqual(v.sourceIds,[X]);await map(c,A,[X],o);
 await bad(c('registerQueueSources',s,a,A,[Y],'changed',o),'MAPPING_CONFLICT');
 const report=await audit(c);assert.equal(report.ok,true);assert.equal(report.acceptedCount,2);assert.equal(report.acceptedSourceCount,1);assert.deepEqual((await facts(c)).anchors,[A]);
}],
['A-T05 故障注入：队列丢成员、重复终态、孤儿批次、映射错归属各有独立证据',async h=>{
 const c=h.peers[0];const o=await prepared(c);await c('damage','dropMember',k,A);
 let v=await audit(c);assert.equal(v.ok,false);assert.equal(v.counts.queued,0);assert.equal(v.observedCounts.queued,2);assert.equal(v.unverifiedAcceptedCount,2);assert.deepEqual(new Set(v.unexpectedMissingIds),new Set([X,A]));await bad(append(c,A),'TRACKING_MISSING');
 const d=h.fork('other');const p=await prepared(d);const f=manifest();await reserve(d,f,opts(p));await mark(d,f,'j1',p);await commit(d,p);await d('damage','doubleEnd',k,X);await d('damage','wrongAnchor',k,X);await d('damage','killBatch',f.batchId);
 v=await audit(d);assert.equal(v.ok,false);assert.ok(v.duplicateTerminalIds.includes(X));assert.ok(v.sourceMismatchIds.includes(X));assert.ok(v.orphanedBatchIds.includes(f.batchId));assert.equal(o.callerOwner,'甲');
}],
['A-T06 未接受的旧聊天不进入分母；零可见片段有原因且不能空分析成功',async h=>{
 const c=h.peers[0];await c('put','streams',{key:'s',id:'s',owner:'offline',seq:0});await c('put','nodes',{key:'s:old',stream:'s',hash:'old',receipt:{ok:true}});
 let r=await audit(c);assert.equal(r.acceptedCount,0);assert.equal(r.ok,true);
 await append(c,A);const o=await claim(c);await bad(map(c,A,[],o),'REASON_REQUIRED');await map(c,A,[],o,{emptyReason:'not_known_to_actor'});await bad(reserve(c,manifest(),opts(o)),'SOURCE_MISMATCH');
 await ret(c,[A],o,'stale_source',{reason:'no_visible_fragments'});r=await audit(c);assert.equal(r.ok,true);assert.equal(r.counts.stale_source,1);assert.deepEqual((await facts(c)).processedSourceIds,[]);
}],
['A-T07 四表加账本提交中途真实 abort，已派发证据仍在，可转人工；不能省略租约或伪造 ACK',async h=>{
 const c=h.peers[0],o=await prepared(c),f=manifest();await reserve(c,f,opts(o));
 await bad(c('markBatchAttemptSent',s,a,f.batchId,'j1',[Y],{...o,payloadFingerprint:f.payloadFingerprint}),'SOURCE_MISMATCH');await mark(c,f,'j1',o);
 await bad(commit(c,o,{queueKey:null}),'LEASE_REQUIRED');await bad(commit(c,o,{consumedSourceIds:[Z]}),'SOURCE_MISMATCH');
 await bad(commit(c,o,{fault:true,influences:[{id:'must-not-exist'}]}),'INJECTED');
 for(const [t,key] of [['streams','s'],['nodes','s:head-A'],['journal','s:1']])assert.equal(await c('get',t,key),undefined);
 assert.deepEqual((await facts(c)).processedSourceIds,[]);assert.equal((await get(c,'job:j1')).status,'sending');assert.equal((await get(c,'batch:batch-1')).status,'inflight');assert.deepEqual((await facts(c)).anchors,[A]);
 assert.equal((await audit(c)).counts.inflight,2);await fail(c,o);assert.equal((await audit(c)).counts.failed_retained,2);assert.equal((await get(c,'account')).total,1);assert.equal((await c('readBatchAttempt',f.batchId)).last.sent,true);
}],
['A-T08 编辑/Swipe/玩家撤销有明确归档；不能复活旧分支或跨人物，过滤已处理来源',async h=>{
 const c=h.peers[0],o=await prepared(c),f=manifest();await reserve(c,f,opts(o));await mark(c,f,'j1',o);
 await bad(commit(c,o,{head:'head-B'}),'BRANCH_CHANGED');await bad(commit(c,o,{guard:false}),'BRANCH_CHANGED');
 await fail(c,o);const o2=await claim(c);await ret(c,[A],o2);await append(c,A,B);let z=await facts(c);assert.deepEqual(z.anchors,[B]);assert.deepEqual(z.processedSourceIds,[]);
 assert.equal((await get(c,'batch:batch-1')).status,'stale_branch');await map(c,B,[Y,Z],o2);await ret(c,[],o2,'stale_source',{sourceIds:[Z],reason:'edited',branchRevision:'B:4',operationId:'op-edit'});
 const f2={...manifest('b2',[B],[Y]),originalBranchHead:'head-B'};await reserve(c,f2,opts(o2,'j2'));await mark(c,f2,'j2',o2);await commit(c,o2,{batchId:'b2',job:'j2',head:'head-B',consumedAnchors:[B],consumedSourceIds:[Y],processed:[Y]});
 assert.deepEqual((await c('readQueueFacts',s,a,{branchAnchors:[A]})).processedSourceIds,[]);assert.deepEqual((await c('readQueueFacts',s,a,{branchAnchors:[B]})).processedSourceIds,[Y]);
 assert.equal((await c('auditQueueLedger',s,'another')).acceptedCount,0);await append(c,'other');const o3=await claim(c);await ret(c,['other'],o3,'explicitly_cancelled',{operationId:'op-cancel',reason:'user_cancel'});await append(c,'other');
 z=await audit(c);assert.equal(z.ok,true);assert.equal(z.counts.explicitly_cancelled,1);assert.equal(z.counts.stale_branch,2);assert.equal(z.counts.stale_source,1);
}],
['A-T09 真实 v5 布局升级：保留历史、运行中旧批/已处理来源标 legacy，不能假定历史齐全',async h=>{
 const c=h.peers[0];const legacy={key:k,stream:s,actor:a,anchors:[A],acknowledgedSourceIds:['prev'],queueRevision:7,fencingToken:4,status:'queued'};
 await c('seed5',[legacy]);const snap=await c('exportV6Rollback');assert.deepEqual(snap.tables.usage,[legacy]);
 assert.deepEqual(await get(c,k),legacy);assert.equal((await c('export')).version,5);let z=await audit(c);assert.equal(z.acceptedCount,0);assert.equal(z.legacyUnverifiedCount,2);assert.equal(z.coverage,'legacy_partial');assert.equal(z.ok,true);
 await append(c,B);z=await audit(c);assert.equal(z.acceptedAnchorCount,1);assert.equal(z.legacyUnverifiedCount,2);assert.deepEqual((await facts(c)).anchors,[A,B]);assert.deepEqual((await c('exportV6Rollback')).tables.usage,[legacy]);
 if(h.native){await assert.rejects(c('openOld'));const fresh=await h.clean();await fresh('restore5',snap);await bad(fresh('restore5',snap),'DEST_NOT_EMPTY');assert.deepEqual((await fresh('read5')).usage,[legacy]);}
}],
['A-T10 两页争抢同批下一尝试：只一份预留、有序历史、旧失败 job 保留；未授权重发不会派发',async h=>{
 const [c,d]=h.peers,f=await failed(c);const o=await claim(d,'乙');const next={expectedAttemptNo:1,previousJobId:'j1',confirmResend:true};
 await bad(reserve(d,f,opts(o,'no-consent',{...next,confirmResend:false})),'CONFIRM_RESEND');
 const old=await reserve(c,f,opts({...o,callerOwner:'甲'},'old-tab',next)).then(()=>null,e=>e.code);assert.equal(old,'LEASE_CONFLICT');
 const race=await Promise.allSettled([reserve(c,f,opts(o,'j2-a',next)),reserve(d,f,opts(o,'j2-b',next))]);
 assert.equal(race.filter(x=>x.status==='fulfilled').length,1);assert.equal(race.find(x=>x.status==='rejected').reason.code,'ATTEMPT_CONFLICT');const job=race.find(x=>x.status==='fulfilled').value.job.key.slice(4);
 let v=await d('readBatchAttempt',f.batchId);assert.equal(v.last.key,'job:j1');assert.equal(v.pending.key,'job:'+job);assert.equal((await get(d,'account')).total,2);assert.equal((await audit(d)).ok,true);
 await mark(d,f,job,o);v=await d('readBatchAttempt',f.batchId);assert.equal(v.last.key,'job:'+job);assert.deepEqual(v.history,['j1',job]);assert.equal((await get(d,'job:j1')).status,'failed_requires_review');
 await commit(d,o,{job});assert.equal((await get(d,'job:j1')).supersededBy,job);assert.equal((await audit(d)).ok,true);
}],
['A-T11 预留超额/事务故障/刷新后未发退款；旧失败指针、真实 quota 和派发历史不被破坏',async h=>{
 const [c,d]=h.peers,f=await failed(c),o=await claim(c,'甲',15000),more={expectedAttemptNo:1,previousJobId:'j1',confirmResend:true};
 await bad(reserve(c,f,opts(o,'over',{...more,limits:{total:1}})),'BUDGET_LIMIT');await bad(reserve(c,f,opts(o,'fault',{...more,fault:true})),'INJECTED');
 for(const job of ['over','fault'])assert.equal(await get(c,'job:'+job),undefined);assert.equal((await c('readBatchAttempt',f.batchId)).manifest.attemptNo,1);assert.equal((await get(c,'account')).total,1);
 await reserve(c,f,opts(o,'reserved',more));await c('close');let v=await d('readBatchAttempt',f.batchId);assert.equal(v.pending.sent,false);assert.equal(v.last.key,'job:j1');
 await bad(d('releaseUnsent','reserved'),'LEASE_REQUIRED');await d('releaseBatchReservation',s,a,f.batchId,'reserved',{...o,reason:'cancel_before_transport'});
 assert.equal((await get(d,'account')).total,1);assert.equal((await get(d,'job:reserved')).sent,false);v=await d('readBatchAttempt',f.batchId);assert.equal(v.last.key,'job:j1');assert.equal(v.pending,null);assert.equal(v.manifest.attemptNo,2);assert.equal((await audit(d)).ok,true);
}],
['A-T12 101/120/500 个锚点，三个角色，重载及局部处理后 FIFO、溢出数、账本计数可核验',async h=>{
 const [c,d]=h.peers;
 for(const n of [101,120,500]){const arr=Array.from({length:n},(_,i)=>'h'+i);await c('appendQueueAnchors',s,'char'+n,arr.slice(0,100));await d('appendQueueAnchors',s,'char'+n,arr.slice(99));}
 await c('close');for(const n of [101,120,500]){const actor='char'+n,arr=Array.from({length:n},(_,i)=>'h'+i),v=await c('readQueueFacts',s,actor);assert.deepEqual(v.anchors,arr);assert.equal(v.queue.overflowCount,n-100);assert.equal(v.queue.backpressure,true);let audit=await c('auditQueueLedger',s,actor);assert.equal(audit.ok,true);assert.equal(audit.acceptedCount,n);
 const o=auth(await c('claimQueue',s,actor,'worker'));await c('retireQueueAnchors',s,actor,['h0'],{...o,state:'stale_source',reason:'removed_by_author',operationId:'edit0',branchRevision:1});
 const after=await d('readQueueFacts',s,actor);assert.deepEqual(after.anchors,arr.slice(1));assert.equal(after.queue.overflowCount,n-101);}
}]
];


cases.push(
['A-X01 派发后租约过期即使同一 tab 也只转人工；待发预留由新租约退款，旧页不能发送',async h=>{
 const [c,d]=h.peers;await append(c,A);
 let o=await claim(c,'old');await map(c,A,[X],o);await c('releaseQueueLease',s,a,'old',o.fencingToken);
 const leaseMs=h.native?900:150;o=await claim(c,'same',leaseMs);const f=manifest();await reserve(c,f,opts(o));await mark(c,f,'j1',o);await delay(leaseMs+25);await bad(claim(d,'same'),'LEASE_EXPIRED_SENT');let q=(await facts(d)).queue;assert.equal(q.status,'failed_requires_review');assert.equal(q.claimOwner,null);
 const p=await claim(d,'new',leaseMs);await reserve(d,f,opts(p,'j2',{expectedAttemptNo:1,previousJobId:'j1',confirmResend:true}));await delay(leaseMs+25);
 const next=await claim(c,'third');await bad(mark(d,f,'j2',p),'FENCE_CONFLICT');await bad(mark(c,f,'j2',next),'ATTEMPT_CONFLICT');await c('releaseBatchReservation',s,a,f.batchId,'j2',{...next,reason:'recover_reserved_after_crash'});
 assert.equal((await get(c,'account')).total,1);assert.equal((await c('readBatchAttempt',f.batchId)).manifest.lastJobId,'j1');assert.equal((await audit(c)).ok,true);
}],
['A-X02 管理接口与兼容方法不能绕过账本；续租保持 token，冻结批次不可改写或擅改派发',async h=>{
 const c=h.peers[0],o=await prepared(c),f=manifest();const before=(await facts(c)).queue;
 await bad(c('remove','usage',k),'PROTECTED_WRITE');await bad(c('put','usage',{...before,anchors:[]}),'PROTECTED_WRITE');await bad(c('clearQueues',s),'EXPLICIT_RETIRE_REQUIRED');
 const renew=await c('renewQueueLease',s,a,120000,{...o,expectedRevision:before.queueRevision});assert.equal(renew.fencingToken,o.fencingToken);assert.ok(renew.claimUntil>=before.claimUntil);
 await reserve(c,f,opts(o));await bad(c('saveBatchManifest',{...f,sourceIds:['unrelated']}),'PROTECTED_BATCH');await bad(c('markJobSent','j1'),'LEASE_REQUIRED');await bad(c('finishJob','j1','已提交'),'LEASE_REQUIRED');await bad(c('releaseQueueLease',s,a,'甲',o.fencingToken),'BATCH_BUSY');
 await bad(c('registerQueueSources',s,a,A,[X,Y],'redefined',o),'MAPPING_CONFLICT');await bad(c('patchQueueState',s,a,{sent:true},o),'PATCH_FIELD');const report=await audit(c);assert.equal(report.ok,true);
}],
['A-X03 旧失败批次核验接管或具名归档；幽灵 job 不可修补为已发送',async h=>{
 const c=h.peers[0],f=manifest(),old={...f,key:'batch:'+f.batchId,status:'failed_requires_review',sent:true,lastJobId:'old',attemptNo:1,jobHistory:['old']};
 const q={key:k,stream:s,actor:a,anchors:[A],status:'failed_requires_review',sent:true,failedBatch:old,fencingToken:0,queueRevision:2};const j={key:'job:old',pid:'p',actor:a,batchId:f.batchId,attemptNo:1,sent:true,finished:true,result:'network',status:'failed_requires_review'};
 await c('seed5',[q,old,j]);const o=await claim(c);await map(c,A,[X],o);
 await c('adoptLegacyFailure',f,{...o,confirmLegacy:true,previousJobId:'old',reason:'user_verified_source_ids'});let report=await audit(c);assert.equal(report.ok,true);assert.ok(report.legacyUnverifiedCount>=2);assert.equal((await c('readBatchAttempt',f.batchId)).last.dispatchedSourceIds,undefined);
 await reserve(c,f,opts(o,'new',{expectedAttemptNo:1,previousJobId:'old',confirmResend:true}));await mark(c,f,'new',o);await bad(commit(c,o,{job:'new',seq:0}),'REVISION_CONFLICT');await commit(c,o,{job:'new',seq:(await c('get','streams',s)).seq});report=await audit(c);assert.equal(report.ok,true);assert.ok(report.legacyUnverifiedCount>=2);
 const d=h.fork('dangling');await d('seed5',[q,{...old,lastJobId:'phantom'}]);const p=await claim(d);await map(d,A,[X],p);await bad(d('adoptLegacyFailure',f,{...p,confirmLegacy:true,previousJobId:'phantom',reason:'review'}),'LEGACY_REVIEW');
 await d('archiveFailedBatch',s,a,f.batchId,{...p,confirmLegacy:true,reason:'no_verifiable_job',operationId:'archive-old',branchRevision:'A:v6'});assert.deepEqual((await facts(d)).anchors,[A]);assert.equal(await get(d,'job:phantom'),undefined);await ret(d,[A],p,'explicitly_cancelled');assert.equal((await audit(d)).ok,true);
}]
);
