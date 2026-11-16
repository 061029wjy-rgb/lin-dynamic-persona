// Browser IndexedDB primitives. All reads, checks and writes in a command share one transaction.
import { id } from './util.js';

export const LAYOUT = 6; // Physical layout. Persona data/backup format stays at v5.
export const LEDGER = 'queueLedger', ROLLBACK = 'v6Rollback';
const U = 'usage', OBS = [U, LEDGER], COMMIT = ['streams','nodes','journal',U,LEDGER];
const WAIT = new Set(['queued','waiting_host','waiting_profile','waiting_budget','waiting_capacity']);
const TERMINAL = new Set(['committed','explicitly_cancelled','stale_branch','stale_source']);
const FAILURE = 'failed_retained';
const STATES = ['accepted_pending','queued','inflight',FAILURE,...TERMINAL];
export class QueueError extends Error {
 constructor(code,message){super(message);this.name='QueueError';this.code=code;}
}
function need(v,code,msg){if(!v)throw new QueueError(code,msg||code);}
function sid(x){need(typeof x==='string'&&x.length>0&&x.length<=1024&&!/[\x00-\x1f]/.test(x),'BAD_INPUT','无效或缺少标识。');return x;}
function ids(xs,strict=false){need(Array.isArray(xs)||xs instanceof Set,'BAD_INPUT','标识必须是列表。');const v=Array.from(xs,sid),uniq=[...new Set(v)];need(!strict||v.length===uniq.length,'SOURCE_MISMATCH','列表含重复标识。');return uniq;}
function reason(s){need(typeof s==='string'&&s.trim()&&s.length<=220,'REASON_REQUIRED','必须给出简明原因（最多 220 字）。');return s;}
function revision(v){need((Number.isSafeInteger(v)&&v>=0)||(typeof v==='string'&&sid(v)),'BAD_INPUT','缺少分支修订。');return v;}
function scope(s,a){need(!sid(s).includes(':'),'BAD_INPUT','streamId 不能含冒号。');return 'queue:'+s+':'+sid(a);}
function same(a,b){return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>x===b[i]);}
function sameSet(a,b){const newSetB=new Set(b);return a.length===b.length&&new Set(a).size===a.length&&new Set(b).size===b.length&&a.every(x=>newSetB.has(x));}
function key(k,...parts){return JSON.stringify([k,...parts]);}
const lease=q=>Boolean(q?.claimOwner&&q.claimUntil>Date.now());
function own(q,o){need(q&&o?.callerOwner&&Number.isSafeInteger(o.fencingToken)&&o.fencingToken>0,'LEASE_REQUIRED','需要有效租约持有人和 Fencing Token。');need(q.fencingToken===o.fencingToken,'FENCE_CONFLICT','队列租约 Fencing Token 已过期，拒绝写入。');need(lease(q)&&q.claimOwner===o.callerOwner,'LEASE_CONFLICT','租约已过期或由另一标签页持有。');}
function cas(q,o){if(o?.expectedRevision!==undefined)need(q?.queueRevision===o.expectedRevision,'REVISION_CONFLICT','队列内容版本已变化，请重新读取。');}
function empty(s,a){return {key:scope(s,a),stream:s,actor:a,anchors:[],queueRevision:0,fencingToken:0,claimOwner:null,claimUntil:0,status:'queued',reason:'',room:'',sent:false,activeBatch:null,failedBatch:null,acknowledgedSourceIds:[]};}
function writeQ(u,q){q.queueRevision=(q.queueRevision||0)+1;q.anchorCount=q.anchors.length;q.overflowCount=Math.max(0,q.anchorCount-100);q.backpressure=!!q.overflowCount||q.status==='waiting_capacity';q.updatedAt=Date.now();u.put(q);return q;}
function unlock(q){q.claimOwner=null;q.claimUntil=0;}
function getQ(u,s,a){return u.get(scope(s,a));}
function qIdentity(q,s,a){need(!q||q.stream===s&&q.actor===a&&q.key===scope(s,a),'SCOPE_MISMATCH','队列身份不匹配。');}
function copyFields(obj,names){return Object.fromEntries(names.filter(k=>Object.hasOwn(obj||{},k)).map(k=>[k,obj[k]]));}

// Yield only IDBRequests. No async callback, timers or network may suspend a live transaction.
export async function atomic(db,names,mode,body){let value;
 await db.transaction(names,mode,(tx,abort)=>{
  const it=body(tx);function step(arg){try{const n=it.next(arg);if(n.done){value=n.value;return;}const req=n.value;req.onsuccess=()=>step(req.result);}catch(e){abort(e);}}step();
 });return value;
}
function scoped(l,k){return typeof l.index==='function'?l.index('scope').getAll(k):l.getAll();}
function receiptKey(k,unit,ref){return key(k,'receipt',unit,ref);}
function itemKey(k,unit,ref){return key(k,'item',unit,ref);}
function add(l,k,kind,unit,ref,fields){const row={key:key(k,kind,unit,ref),scope:k,kind,unit,ref,...fields};l.put(row);return row;}
function event(l,x,state,ctx={}){
 const at=Date.now(),op=ctx.operationId||id();
 const e={key:key(x.scope,'event',x.unit,x.ref,op),order:(x.historySeq||0)+1,scope:x.scope,kind:'event',unit:x.unit,ref:x.ref,anchorId:x.anchorId,at,state,operationId:op,branchRevision:ctx.branchRevision??x.branchRevision,reason:ctx.reason||null,batchId:ctx.batchId||null,jobId:ctx.jobId||null,journalKey:ctx.journalKey||null};
 // append-only; operation keys may not silently overwrite a prior event
 if(typeof l.add==='function')l.add(e);else l.put(e);
 Object.assign(x,{state,historySeq:e.order,lastOperationId:op,updatedAt:at,batchId:e.batchId,jobId:e.jobId});l.put(x);return x;
}
function admission(l,q,unit,ref,anchorId,finger,branch,legacy=false){
 const k=q.key,now=Date.now(),meta={streamId:q.stream,actorId:q.actor,anchorId,sourceFingerprint:finger,branchRevision:branch,acceptedAt:legacy?null:now,observedAt:now,legacy};
 add(l,k,'receipt',unit,ref,{...meta,state:legacy?'legacy_observed':'accepted_pending'});
 const x=add(l,k,'item',unit,ref,{...meta,sourceIds:[],mappingComplete:false,emptyReason:null,state:'accepted_pending'});event(l,x,'queued',{reason:legacy?'legacy_observed':'accepted'});return x;
}
function* item(l,q,unit,r){const x=yield l.get(itemKey(q.key,unit,r));need(x,'TRACKING_MISSING','找不到已接受来源的状态：'+r);return x;}
function* append(u,l,q,list,meta){
 const set=new Set(q.anchors);let changed=false;
 for(const h of list){
  if(set.has(h)){
   const r=yield l.get(receiptKey(q.key,'anchor',h)),x=yield* item(l,q,'anchor',h);
   need(r&&!TERMINAL.has(x.state),'TRACKING_MISSING','成员缺少有效入队凭据：'+h);continue;
  }
  const old=yield l.get(receiptKey(q.key,'anchor',h));
  if(old){const x=yield* item(l,q,'anchor',h);need(TERMINAL.has(x.state),'TRACKING_MISSING','入队凭据存在但队列成员失踪：'+h);continue;} // tombstone; never resurrect a stale snapshot
  admission(l,q,'anchor',h,h,meta.sourceFingerprint||h,meta.branchRevision??h);
  set.add(h);changed=true;
 }
 if(changed){q.anchors=[...set];if(!q.room&&meta.room)q.room=String(meta.room).slice(0,220);
  if(!q.claimOwner&&!q.activeBatch&&!q.failedBatch&&(!q.queueRevision||TERMINAL.has(q.status))){q.status=WAIT.has(meta.status)?meta.status:'queued';q.reason=String(meta.reason||'').slice(0,220);}
  writeQ(u,q);}
 return {...q,anchorCount:q.anchors.length};
}

function updateMeta(q,p,o){
 const allowed=['status','reason','errorKind','waitingDay'];need(p&&Object.keys(p).every(k=>allowed.includes(k)),'PATCH_FIELD','状态接口禁止更新成员、租约、批次或派发凭据。');
 cas(q,o);const status=p.status??q.status;
 if(o?.fencingToken!=null||q.claimOwner||!WAIT.has(status))own(q,o);
 if(q.activeBatch||q.failedBatch){
  need(lease(q)&&o?.callerOwner===q.claimOwner,'LEASE_REQUIRED','存在未决批次。');
  need(!p.status||p.status===q.status||q.sent&&q.activeBatch&&['received','validating'].includes(p.status),'BATCH_BUSY','必须通过批次接口变更未决批次。');
 }else need(WAIT.has(status)||status==='preparing','PATCH_STATE','状态须由相应事务推进。');
 if(p.status)q.status=p.status;if(p.reason!==undefined)q.reason=String(p.reason).slice(0,220);
 for(const k of ['errorKind','waitingDay'])if(k in p)q[k]=p[k]==null?null:String(p[k]).slice(0,80);
}
const frozenFields=['batchId','streamId','actorId','originalBranchHead','originalRevision','sourceIds','anchorIds','sourceFingerprint','payloadFingerprint','providerProfileId','modelId','contractVersion'];
function freeze(input){
 const f=copyFields(input,frozenFields);
 for(const k of frozenFields.filter(k=>!['anchorIds','sourceIds','originalRevision'].includes(k)))sid(f[k]);
 revision(f.originalRevision);f.sourceIds=ids(f.sourceIds,true);f.anchorIds=ids(f.anchorIds,true);
 need(f.sourceIds.length&&f.anchorIds.length,'SOURCE_MISMATCH','空来源不能作为分析成功。');return f;
}
function brief(b){return {batchId:b.batchId,sourceIds:b.sourceIds,anchorIds:b.anchorIds,attemptNo:b.attemptNo,lastJobId:b.lastJobId,sent:!!b.sent};}
function batchRef(l,q,b){add(l,q.key,'batchRef','batch',b.batchId,{streamId:q.stream,actorId:q.actor});}
function* bindings(l,q,f){
 const rows=new Map();
 for(const h of f.anchorIds){need(q.anchors.includes(h),'ANCHOR_MISSING','该批锚点不再处于队列：'+h);
  const x=yield* item(l,q,'anchor',h);need(x.mappingComplete&&x.sourceIds.length&&!TERMINAL.has(x.state),'SOURCE_MISMATCH','须先登记完整的可见片段映射。');rows.set(h,x);}
 const seen=new Set();
 for(const s of f.sourceIds){const x=yield* item(l,q,'source',s);
  need(rows.get(x.anchorId)?.sourceIds.includes(s)&&!TERMINAL.has(x.state),'SOURCE_MISMATCH','来源不属于本批活动锚点或已经终结。');seen.add(x.anchorId);}
 need(seen.size===rows.size,'SOURCE_MISMATCH','每个责任锚点都须有实际派发来源。');return rows;
}
function* moveBatch(l,q,b,state,why,job){
 const meta={batchId:b.batchId,reason:why,jobId:job};for(const [unit,list] of [['source',b.sourceIds],['anchor',b.anchorIds]])for(const ref of list){const x=yield* item(l,q,unit,ref);need(!TERMINAL.has(x.state),'SOURCE_MISMATCH','来源已经终结。');event(l,x,state,meta);}
}

const LIMITS=['total','day','session','profileTotal','profileDay','profileSession','actorLimit'];
const limitNames=['账户累计','每日（UTC）','本页会话','配置档累计','配置档每日','配置档会话','该角色每日'];
// Shared by ordinary v0.6 manual requests and atomic v0.7 queue reservations.
export function* reserveQuota(u,job,lim,session,extra={}){
 sid(job);sid(session);const now=Date.now(),day=new Date(now).toISOString().slice(0,10),pid=sid(lim.profile||'main'),actor=sid(lim.actor||'@test'),pk='profile:'+pid,dk=pk+':'+day,sk=pk+':'+session;
 const keys=['account','day:'+day,'session:'+session,pk,dk,sk,dk+':actor:'+actor];
 need(new Set(keys).size===keys.length,'BAD_INPUT','预算计数键冲突。');
 need(!(yield u.get('job:'+job)),'DUPLICATE_JOB','这批证据已发起过分析，不重复收费。');
 const rows=[];for(const k of keys)rows.push((yield u.get(k))||{key:k});
 need(!rows[3].activeJob||rows[3].activeUntil<=now,'PROFILE_BUSY','另一标签页或请求正在使用该配置档，请等待完成。');
 for(const [i,key] of LIMITS.entries()){const cap=lim[key]??Infinity;need(cap===Infinity||Number.isSafeInteger(cap)&&cap>=0,'BAD_INPUT','预算上限无效。');
  if((rows[i][i?'count':'total']||0)>=cap)throw Object.assign(new QueueError('BUDGET_LIMIT','已达当前分析预算（'+limitNames[i]+'上限），未发出模型请求。'),{budgetKind:limitNames[i]});}
 for(const v of ['interval','timeout','estimate'])if(lim[v]!=null)need(Number.isFinite(lim[v])&&lim[v]>=0,'BAD_INPUT','预算参数无效。');
 if(now-(rows[3].last||0)<(lim.interval||0)*1000)throw Object.assign(new QueueError('BUDGET_INTERVAL','配置尚在最短间隔内，没有派发。'),{budgetKind:'最短间隔'});
 const prevLast=rows[3].last||0;
 rows.forEach((r,i)=>{if(!i){r.total=(r.total||0)+1;r.estimate=(r.estimate||0)+(lim.estimate||0);}else r.count=(r.count||0)+1;
 if(i===3)Object.assign(r,{last:now,activeJob:job,activeUntil:now+Math.max(5000,(lim.timeout||45)*1000)});u.put(r);});
 const rec={key:'job:'+job,keys,pid,actor,batchId:lim.batchId||null,attemptNo:lim.attemptNo||1,at:now,day,prevLast,estimate:lim.estimate||0,kind:lim.kind||'analysis',status:'reserved',sent:false,result:'已预留',...extra};
 u.put(rec);return {usage:rows[0],job:rec};
}
export function* refund(u,j){
 need(!j.sent&&!j.finished&&j.keys?.length===7,'ALREADY_SENT','只允许退回未派发、未结算的预留。');
 for(const [i,k] of j.keys.entries()){
  const r=yield u.get(k);need(r&&(r[i?'count':'total']||0)>0,'QUOTA_INCONSISTENT','预留计数不一致。');
  if(!i){r.total--;r.estimate=Math.max(0,(r.estimate||0)-j.estimate);}else r.count--;
  if(i===3&&r.activeJob===j.key.slice(4)){delete r.activeJob;delete r.activeUntil;r.last=j.prevLast||0;}u.put(r);
 }
}
export function* freeProfile(u,j){const p=yield u.get('profile:'+j.pid);if(p?.activeJob===j.key.slice(4)){delete p.activeJob;delete p.activeUntil;u.put(p);}}
function* batchContext(u,s,a,batchId,o){const q=yield getQ(u,s,a);qIdentity(q,s,a);own(q,o);cas(q,o);
 const b=yield u.get('batch:'+sid(batchId));need(b?.managed===7&&b.streamId===s&&b.actorId===a,'BATCH_MISMATCH','批次不属于本角色或尚未登记。');return {q,b};}
function* failSent(u,l,q,b,j,why){
 need(j?.sent&&!j.finished&&b.lastJobId===j.key.slice(4)&&b.status==='inflight','ATTEMPT_CONFLICT','没有可标记失败的当前已派发尝试。');
 j.status='failed_requires_review';j.result=why;j.finished=true;j.finishedAt=Date.now();u.put(j);yield* freeProfile(u,j);
 b.status='failed_retained';b.sent=true;b.failureReason=why;u.put(b);yield* moveBatch(l,q,b,FAILURE,why,b.lastJobId);
 q.activeBatch=null;q.failedBatch=brief(b);q.sent=true;q.status='failed_requires_review';q.reason=why;
}

export class QueueDatabase {
 async appendQueueAnchors(s,a,anchors,meta={}){const k=scope(s,a),list=ids(anchors);meta=copyFields(meta,['room','reason','status','branchRevision','sourceFingerprint']);if(meta.branchRevision!=null)revision(meta.branchRevision);if(meta.sourceFingerprint!=null)sid(meta.sourceFingerprint);
  return atomic(this,OBS,'readwrite',function*(tx){const u=tx.objectStore(U),l=tx.objectStore(LEDGER);const q=(yield u.get(k))||empty(s,a);qIdentity(q,s,a);return yield* append(u,l,q,list,meta);});
 }
 async patchQueueState(s,a,p,o={}){return atomic(this,[U],'readwrite',function*(tx){const u=tx.objectStore(U),q=yield getQ(u,s,a);need(q,'QUEUE_MISSING');qIdentity(q,s,a);updateMeta(q,p,o);return writeQ(u,q);});}
 async saveQueue(s,a,entry={},o={}){const list=ids(entry.anchors||[]);return atomic(this,OBS,'readwrite',function*(tx){
  const u=tx.objectStore(U),l=tx.objectStore(LEDGER),q=(yield getQ(u,s,a))||empty(s,a);qIdentity(q,s,a);cas(q,o);
  // Old snapshots can add real new members, never remove or resurrect a tombstone.
  if(o.fencingToken>0||o.strictLease||o.releaseLease)own(q,o);
  yield* append(u,l,q,list,{room:entry.room});if(!q.queueRevision)return null;
  if(!q.activeBatch&&!q.failedBatch&&(!q.claimOwner||lease(q)&&q.claimOwner===o.callerOwner&&q.fencingToken===o.fencingToken)){
   if(WAIT.has(entry.status)||entry.status==='preparing'&&lease(q))updateMeta(q,copyFields(entry,['status','reason','errorKind','waitingDay']),q.claimOwner?o:{});
  }
  if(o.releaseLease){need(!q.activeBatch,'BATCH_BUSY','请先完成或退还当前尝试。');unlock(q);}
  return writeQ(u,q);
 });}
 async claimQueue(s,a,tab,ms=60000){sid(tab);need(Number.isSafeInteger(ms)&&ms>0&&ms<=86400000,'BAD_INPUT','租期无效。');
  const r=await atomic(this,OBS,'readwrite',function*(tx){const u=tx.objectStore(U),l=tx.objectStore(LEDGER),q=yield getQ(u,s,a);if(!q||!q.anchors?.length&&!q.failedBatch)return {q:null};qIdentity(q,s,a);
   if(lease(q)){need(q.claimOwner===tab,'LEASE_CONFLICT','另一标签页正在处理该角色的自动分析队列。');return {q};}
   q.fencingToken=(q.fencingToken||0)+1;
   if(q.claimOwner&&q.sent&&(q.activeBatch||['sending','received','validating'].includes(q.status))){
    const why='前序请求可能已计费，租约超时；保留来源，禁止自动重发。';
    if(q.activeBatch?.batchId){const b=yield u.get('batch:'+q.activeBatch.batchId);if(b?.managed===7){const j=yield u.get('job:'+b.lastJobId);yield* failSent(u,l,q,b,j,why);}else{q.failedBatch=q.activeBatch;q.activeBatch=null;}}
    q.status='failed_requires_review';q.reason=why;unlock(q);writeQ(u,q);return {expired:true,q};
   }
   q.claimOwner=tab;q.claimUntil=Date.now()+ms;if(!q.failedBatch&&!q.activeBatch&&!q.sent)q.status='preparing';return {q:writeQ(u,q)};
  });if(r.expired)throw Object.assign(new QueueError('LEASE_EXPIRED_SENT',r.q.reason),{sent:true,queueState:'failed_requires_review',fencingToken:r.q.fencingToken});return r.q;
 }
 async renewQueueLease(s,a,ms,o){need(Number.isSafeInteger(ms)&&ms>0&&ms<=86400000,'BAD_INPUT');return atomic(this,[U],'readwrite',function*(tx){const u=tx.objectStore(U),q=yield getQ(u,s,a);own(q,o);cas(q,o);q.claimUntil=Math.max(q.claimUntil,Date.now()+ms);return writeQ(u,q);});}
 async releaseQueueLease(s,a,tab,token,patch={},o={}){if(Object.hasOwn(patch,'anchors')){patch={...patch};delete patch.anchors;}return atomic(this,[U],'readwrite',function*(tx){const u=tx.objectStore(U),q=yield getQ(u,s,a),auth={...o,callerOwner:tab,fencingToken:token};own(q,auth);cas(q,auth);need(!q.activeBatch,'BATCH_BUSY','不能释放含未决尝试的租约。');if(Object.keys(patch).length)updateMeta(q,patch,auth);unlock(q);return writeQ(u,q);});}
 async registerQueueSources(s,a,h,sourceIds,fingerprint,o={}){
  sid(h);sid(fingerprint);const list=ids(sourceIds,true),complete=o.complete!==false;
  if(!list.length){need(complete,'BAD_INPUT','不要登记空的增量块。');reason(o.emptyReason);}else need(!o.emptyReason,'BAD_INPUT','有片段时不能声明不可见。');
  return atomic(this,OBS,'readwrite',function*(tx){const u=tx.objectStore(U),l=tx.objectStore(LEDGER),q=yield getQ(u,s,a);own(q,o);cas(q,o);
   need(q.anchors.includes(h),'ANCHOR_MISSING');const x=yield* item(l,q,'anchor',h);
   if(x.mappingFingerprint)need(x.mappingFingerprint===fingerprint,'MAPPING_CONFLICT','相同责任不能改写原文指纹。');
   if(x.mappingComplete){need((complete?same(x.sourceIds,list):list.every(ref=>x.sourceIds.includes(ref)))&&x.emptyReason===(o.emptyReason||null),'MAPPING_CONFLICT','映射已冻结；不能覆盖旧证据。');return x;}
   need(!TERMINAL.has(x.state),'ANCHOR_TERMINAL');const all=[...new Set([...x.sourceIds,...list])];
   if(complete)need(same(all,list),'MAPPING_CONFLICT','封存时须提交完整有序清单，不能删改已登记片段。');
   if(!complete&&all.length===x.sourceIds.length)return x;
   for(const ref of list){if(x.sourceIds.includes(ref))continue;const old=yield l.get(receiptKey(q.key,'source',ref));need(!old,'SOURCE_MISMATCH','片段已归属另一责任记录：'+ref);admission(l,q,'source',ref,h,fingerprint,x.branchRevision);}
   Object.assign(x,{mappingComplete:complete,mappingFingerprint:fingerprint,sourceIds:all,emptyReason:o.emptyReason||null,mappedAt:Date.now()});l.put(x);own(q,o);writeQ(u,q);return x;
  });
 }
 // A legacy sent receipt is provenance, not proof of the exact wire payload. Preserve this distinction.
 async adoptLegacyFailure(input,o){const f=freeze(input);reason(o?.reason);return atomic(this,OBS,'readwrite',function*(tx){
  const u=tx.objectStore(U),l=tx.objectStore(LEDGER),q=yield getQ(u,f.streamId,f.actorId);own(q,o);cas(q,o);
  const old=yield u.get('batch:'+f.batchId);
  need(o.confirmLegacy===true&&old&&!old.managed&&!q.activeBatch&&q.failedBatch?.batchId===f.batchId&&!['committed','cancelled_by_user','archived'].includes(old.status),'LEGACY_REVIEW');
  for(const k of frozenFields.filter(k=>k!=='anchorIds'))need(JSON.stringify(f[k])===JSON.stringify(old[k]),'MANIFEST_CONFLICT','旧批次身份或证据指纹不匹配。');
  const jid=sid(o.previousJobId),j=yield u.get('job:'+jid);need(jid===old.lastJobId&&j?.batchId===f.batchId&&j.actor===q.actor&&j.pid===f.providerProfileId&&j.sent&&j.finished&&!['已提交','已由重发提交'].includes(j.result)&&j.status!=='committed'&&j.attemptNo===old.attemptNo&&Number.isSafeInteger(j.attemptNo)&&j.attemptNo>0,'LEGACY_REVIEW','缺少可核实的旧失败尝试；不能创建替代凭据。');
  yield* bindings(l,q,f);
  const b={...f,key:old.key,scope:q.key,managed:7,legacyOrigin:true,legacyAnchorIds:old.anchorIds,legacyJobHistory:old.jobHistory||[],jobHistory:[jid],attemptNo:j.attemptNo,lastJobId:jid,pendingJobId:null,status:FAILURE,sent:true};
  u.put({...j,scope:q.key,managed:7,legacyOrigin:true,legacyStatus:j.status,status:'failed_requires_review'});u.put(b);batchRef(l,q,b);yield* moveBatch(l,q,b,FAILURE,o.reason,jid);
  q.failedBatch=brief(b);q.sent=true;q.status='failed_requires_review';own(q,o);writeQ(u,q);return b;
 });}
 async archiveFailedBatch(s,a,batchId,o){const why=reason(o?.reason),op=sid(o?.operationId),branch=revision(o?.branchRevision);return atomic(this,OBS,'readwrite',function*(tx){
  const u=tx.objectStore(U),l=tx.objectStore(LEDGER),q=yield getQ(u,s,a);own(q,o);cas(q,o);
  need(!q.activeBatch&&q.failedBatch?.batchId===batchId,'ATTEMPT_CONFLICT');const b=yield u.get('batch:'+sid(batchId));
  need(!b||b.streamId===s&&b.actorId===a,'SCOPE_MISMATCH');
  if(b?.managed===7){need(b.status===FAILURE,'ATTEMPT_CONFLICT');yield* moveBatch(l,q,b,'queued',why,b.lastJobId);}
  else need(o.confirmLegacy===true,'LEGACY_REVIEW','未核实的旧失败批次需明确确认归档。');
  const log={key:key(q.key,'batch-archive',op),scope:q.key,kind:'batchArchive',batchId,reason:why,branchRevision:branch,operationId:op,at:Date.now(),legacy:b?.managed!==7};
  need(!(yield l.get(log.key)),'OP_CONFLICT');l.put(log);if(b)u.put({...b,status:'archived',archivedBy:op});
  q.failedBatch=null;q.sent=false;q.status='queued';q.reason=why;own(q,o);writeQ(u,q);return log;
 });}
 async getBatchManifest(batchId){return batchId?this.get(U,'batch:'+sid(batchId)):null;}
 async readBatchAttempt(batchId){return atomic(this,[U],'readonly',function*(tx){const u=tx.objectStore(U),b=yield u.get('batch:'+sid(batchId));if(!b)return null;return {manifest:b,frozen:copyFields(b,frozenFields),pending:b.pendingJobId?(yield u.get('job:'+b.pendingJobId)):null,last:b.lastJobId?(yield u.get('job:'+b.lastJobId)):null,history:b.jobHistory||[]};});}
 async reserveBatchAttempt(input,o){const f=freeze(input);sid(o?.jobId);sid(o?.session);need(o.limits&&Number.isSafeInteger(o.limits.total)&&o.limits.total>=0,'BAD_INPUT','必须提供非负整数的累计硬预算。');
  return atomic(this,OBS,'readwrite',function*(tx){const u=tx.objectStore(U),l=tx.objectStore(LEDGER),q=yield getQ(u,f.streamId,f.actorId);own(q,o);cas(q,o);
   const saved=yield u.get('batch:'+f.batchId);const b=saved||{...f,key:'batch:'+f.batchId,managed:7,scope:q.key,status:'new',attemptNo:0,lastJobId:null,pendingJobId:null,jobHistory:[],sent:false};
   need(b.managed===7&&JSON.stringify(copyFields(b,frozenFields))===JSON.stringify(f),'MANIFEST_CONFLICT','批次的冻结内容或来源指纹不一致。');
   need(!q.activeBatch&&!b.pendingJobId&&['new','released_unsent','failed_retained'].includes(b.status)&&(!q.failedBatch||q.failedBatch.batchId===f.batchId)&&(!q.sent||q.failedBatch?.batchId===f.batchId),'ATTEMPT_CONFLICT','队列已有未决、历史未核实或已终结的尝试。');
   need(o.expectedAttemptNo===b.attemptNo&&o.previousJobId===b.lastJobId,'ATTEMPT_CONFLICT','尝试序号或上一次有效 job 已改变。');
   if(b.lastJobId){const prev=yield u.get('job:'+b.lastJobId);need(prev?.sent&&prev.finished&&prev.status==='failed_requires_review'&&o.confirmResend===true,'CONFIRM_RESEND','上次派发可能已计费，须由玩家显式确认。');}
   yield* bindings(l,q,f);const num=b.attemptNo+1;
   const r=yield* reserveQuota(u,o.jobId,{...o.limits,profile:f.providerProfileId,actor:f.actorId,batchId:f.batchId,attemptNo:num},o.session,{managed:7,scope:q.key,previousJobId:b.lastJobId,leaseToken:q.fencingToken,dispatchHead:sid(o.dispatchHead??f.originalBranchHead),dispatchRevision:o.dispatchRevision??f.originalRevision});
   need(Number.isSafeInteger(r.job.dispatchRevision)&&r.job.dispatchRevision>=0,'BAD_INPUT','派发修订必须是非负整数。');
   Object.assign(b,{attemptNo:num,pendingJobId:o.jobId,status:'reserved',jobHistory:[...b.jobHistory,o.jobId]});u.put(b);batchRef(l,q,b);
   q.activeBatch=brief(b);q.activeBatch.pendingJobId=o.jobId;q.sent=false;q.status='reserved';writeQ(u,q);own(q,o);
   o.injectFault?.();return {manifest:b,job:r.job,usage:r.usage,queueRevision:q.queueRevision};
  });
 }
 async releaseBatchReservation(s,a,batchId,jobId,o){const why=reason(o?.reason);return atomic(this,OBS,'readwrite',function*(tx){const u=tx.objectStore(U),{q,b}=yield* batchContext(u,s,a,batchId,o);
  need(b.pendingJobId===jobId&&q.activeBatch?.batchId===batchId,'ATTEMPT_CONFLICT');const j=yield u.get('job:'+sid(jobId));need(j?.managed===7,'JOB_MISSING');yield* refund(u,j);
  Object.assign(j,{status:'released_unsent',finished:true,result:why,finishedAt:Date.now()});u.put(j);b.pendingJobId=null;b.status=b.lastJobId?'failed_retained':'released_unsent';u.put(b);
  q.activeBatch=null;q.sent=!!b.lastJobId;q.status=b.lastJobId?'failed_requires_review':'queued';q.reason=why;own(q,o);writeQ(u,q);return b;
 });}
 async markBatchAttemptSent(s,a,batchId,jobId,actualSourceIds,o){const actual=ids(actualSourceIds,true);
  return atomic(this,OBS,'readwrite',function*(tx){const u=tx.objectStore(U),l=tx.objectStore(LEDGER),{q,b}=yield* batchContext(u,s,a,batchId,o);
   need(b.status==='reserved'&&b.pendingJobId===jobId&&q.activeBatch?.batchId===batchId,'ATTEMPT_CONFLICT');need(same(actual,b.sourceIds)&&o.payloadFingerprint===b.payloadFingerprint,'SOURCE_MISMATCH','实际待发送来源顺序或请求指纹不符。');
   const j=yield u.get('job:'+sid(jobId));need(j?.managed===7&&!j.sent&&!j.finished&&j.leaseToken===o.fencingToken,'ATTEMPT_CONFLICT','接管的新租约只能退还旧未发预留。');
   const p=yield u.get('profile:'+j.pid);need(p?.activeJob===jobId&&p.activeUntil>Date.now(),'RESERVATION_EXPIRED','配置档预留已失效；未派发。');
   yield* bindings(l,q,b);Object.assign(j,{sent:true,sentAt:Date.now(),status:'sending',result:'已登记派发意图',dispatchedSourceIds:actual,payloadFingerprint:o.payloadFingerprint});u.put(j);
   b.lastJobId=jobId;b.pendingJobId=null;b.status='inflight';b.sent=true;u.put(b);yield* moveBatch(l,q,b,'inflight','dispatch_intent',jobId);
   q.activeBatch=brief(b);q.failedBatch=null;q.status='sending';q.sent=true;q.lastJob=jobId;own(q,o);writeQ(u,q);return b;
  });
 }
 async failBatchAttempt(s,a,batchId,jobId,o){const why=reason(o?.reason);return atomic(this,OBS,'readwrite',function*(tx){const u=tx.objectStore(U),l=tx.objectStore(LEDGER),{q,b}=yield* batchContext(u,s,a,batchId,o);
  need(b.lastJobId===jobId&&q.activeBatch?.batchId===batchId,'ATTEMPT_CONFLICT');const j=yield u.get('job:'+sid(jobId));
  if(j)Object.assign(j,copyFields(o.resultMeta,['http','finish','model','provider','requestId','usage','cost']));
  yield* failSent(u,l,q,b,j,why);own(q,o);unlock(q);writeQ(u,q);return b;
 });}

 async retireQueueAnchors(s,a,anchorIds,o){
  const hs=ids(anchorIds,true),ss=ids(o?.sourceIds||[],true),why=reason(o?.reason),op=sid(o?.operationId),branch=revision(o?.branchRevision),state=o?.state;
  need(hs.length||ss.length,'BAD_INPUT','必须指明撤销的确切来源或锚点。');need(TERMINAL.has(state)&&state!=='committed','PATCH_STATE');
  return atomic(this,OBS,'readwrite',function*(tx){
   const u=tx.objectStore(U),l=tx.objectStore(LEDGER),q=yield getQ(u,s,a);own(q,o);cas(q,o);
   const rk=key(q.key,'retirement',op),old=yield l.get(rk);
   if(old){need(old.state===state&&old.reason===why&&old.branchRevision===branch&&same(hs,old.anchors)&&same(ss,old.sources),'OP_CONFLICT');return old;}
   const targets=new Set(ss);for(const h of hs){need(q.anchors.includes(h),'ANCHOR_MISSING');const x=yield* item(l,q,'anchor',h);for(const ref of x.sourceIds){const y=yield* item(l,q,'source',ref);if(!TERMINAL.has(y.state))targets.add(ref);}}
   for(const ref of targets){const x=yield* item(l,q,'source',ref);need(q.anchors.includes(x.anchorId)&&!TERMINAL.has(x.state),'SOURCE_MISMATCH');}
   const touches=b=>b&&(hs.some(h=>b.anchorIds?.includes(h))||[...targets].some(r=>b.sourceIds?.includes(r)));
   need(!touches(q.activeBatch),'BATCH_BUSY','先退回未发预留 / 将在途尝试标记失败，再撤销其来源。');
   const fb=q.failedBatch;
   if(touches(fb)){
    const b=yield u.get('batch:'+fb.batchId);need(b?.managed===7&&b.status===FAILURE,'LEGACY_REVIEW','旧批次必须先核实，不能伪造已迁移的派发。');
    // Retire only the selected units. Other members of this failed batch go back to queued.
    yield* moveBatch(l,q,b,'queued','failed_batch_archived',b.lastJobId);
    Object.assign(b,{status:state,retirementOperationId:op,retirementReason:why});u.put(b);q.failedBatch=null;q.sent=false;
   }
   const ctx={operationId:op,reason:why,branchRevision:branch,batchId:touches(fb)?fb.batchId:null};
   for(const r of targets)event(l,yield* item(l,q,'source',r),state,ctx);
   for(const h of hs)event(l,yield* item(l,q,'anchor',h),state,ctx);
   q.anchors=q.anchors.filter(h=>!hs.includes(h));if(!q.activeBatch&&!q.failedBatch){q.status=q.anchors.length?'queued':state;q.reason=why;q.sent=false;}
   const rec={key:rk,scope:q.key,kind:'retirement',operationId:op,state,branchRevision:branch,reason:why,at:Date.now(),anchors:hs,sources:ss,retiredSourceIds:[...targets]};l.put(rec);own(q,o);writeQ(u,q);return rec;
  });
 }
 async clearQueues(){throw new QueueError('EXPLICIT_RETIRE_REQUIRED','禁止批量直接删除。请读取队列、领取租约并逐队列显式撤销，附来源、分支修订和原因。');}
 async loadQueues(s){const rows=await this.all(U);return rows.filter(x=>x.key?.startsWith('queue:')&&(!s||x.stream===s)&&(x.anchors?.length||x.failedBatch||x.activeBatch));}
 async readQueueFacts(s,a,o={}){const k=scope(s,a),active=o.branchAnchors===undefined?null:new Set(ids(o.branchAnchors));
  return atomic(this,OBS,'readonly',function*(tx){const u=tx.objectStore(U),l=tx.objectStore(LEDGER),q=(yield u.get(k))||empty(s,a),rs=(yield typeof l.index==='function'?l.index('scopeKind').getAll([k,'item']):l.getAll()).filter(x=>x.scope===k&&x.kind==='item');qIdentity(q,s,a);
   const processed=rs.filter(x=>x.unit==='source'&&x.state==='committed'&&(!active||active.has(x.anchorId)));
   return {queue:q,queueRevision:q.queueRevision,anchors:[...q.anchors],lease:{callerOwner:q.claimOwner,fencingToken:q.fencingToken,claimUntil:q.claimUntil},processedSourceIds:processed.map(x=>x.ref),terminalSourceIds:rs.filter(x=>x.unit==='source'&&TERMINAL.has(x.state)&&(!active||active.has(x.anchorId))).map(x=>x.ref),processedSources:processed.map(x=>({sourceId:x.ref,anchorId:x.anchorId,branchRevision:x.branchRevision,batchId:x.batchId})),mappings:rs.filter(x=>x.unit==='anchor'&&(!active||active.has(x.ref))).map(x=>copyFields(x,['anchorId','mappingComplete','mappingFingerprint','sourceIds','emptyReason','state','branchRevision','legacy']))};
  });
 }
 async commitQueuedAnalysis(stream,node,expected,label,guard,o){
  return atomic(this,COMMIT,'readwrite',function*(tx){
   const u=tx.objectStore(U),l=tx.objectStore(LEDGER),n=tx.objectStore('nodes'),w=tx.objectStore('streams');
   const q=yield u.get(o.queueKey);own(q,o);qIdentity(q,stream.id,q.actor);cas(q,o);
   need(q.key===o.queueKey&&node.stream===q.stream&&node.key===q.stream+':'+node.hash&&stream.key===q.stream,'SCOPE_MISMATCH');
   need(typeof guard==='function'&&guard(),'BRANCH_CHANGED','必须提供仍然有效的角色、分支与来源校验。');
   need(o.batchId&&o.job,'MANAGED_ATTEMPT_REQUIRED','队列 ACK 需要已登记并派发的尝试。');
   const b=yield u.get('batch:'+o.batchId),j=yield u.get('job:'+o.job);
   need(b?.managed===7&&j?.managed===7,'MANAGED_ATTEMPT_REQUIRED','须经 registerQueueSources/reserveBatchAttempt 派发后再提交。');
   need(b.streamId===q.stream&&b.actorId===q.actor&&j.scope===q.key&&q.activeBatch?.batchId===b.batchId&&b.status==='inflight'&&b.lastJobId===o.job&&j.sent&&!j.finished&&j.batchId===b.batchId&&j.leaseToken===o.fencingToken,'ATTEMPT_CONFLICT');
   need(node.hash===j.dispatchHead&&node.revision===j.dispatchRevision+1,'BRANCH_CHANGED','响应不属于派发时的分支头和修订。');
   const streamOld=yield w.get(stream.id),nodeOld=yield n.get(node.key);
   need((streamOld?.seq||0)===(stream.seq||0)&&(nodeOld?.revision??-1)===expected,'REVISION_CONFLICT','另一窗口已改变人格或分支。');
   const hs=ids(o.consumedAnchors||[],true),ss=ids(o.consumedSourceIds||[],true),batchSrc=new Set(ss);
   need(ss.length&&sameSet(ss,b.sourceIds)&&same(j.dispatchedSourceIds,b.sourceIds)&&j.payloadFingerprint===b.payloadFingerprint,'SOURCE_MISMATCH','提交来源与实际派发不一致。');
   const processed=node.state?.processed?.[q.actor]||[];need(Array.isArray(processed)&&ss.every(x=>processed.includes(x)),'SOURCE_MISMATCH','人格投影缺少待 ACK 的来源。');
   const prior=(nodeOld?.base===node.base?nodeOld?.state?.processed?.[q.actor]:null)??node.history?.at(-1)?.state?.processed?.[q.actor]??[];
   need(sameSet(ids(processed,true),[...new Set([...prior,...ss])]),'SOURCE_MISMATCH','人格已处理集合的变化超出实际派发来源。');
   const bound=yield* bindings(l,q,b);const complete=[];
   for(const [h,x] of bound){let all=true;for(const ref of x.sourceIds){const y=yield* item(l,q,'source',ref);if(!TERMINAL.has(y.state)&&!batchSrc.has(ref))all=false;}if(all)complete.push(h);}
   need(sameSet(hs,complete),'INCOMPLETE_ACK','锚点 ACK 必须等于登记的全部片段已解决的锚点。');
   const now=Date.now(),seq=(stream.seq||0)+1,next={...(streamOld||stream),seq,updatedAt:now,head:node.hash},updated={...node,seq},jk=q.stream+':'+seq;
   const ctx={batchId:b.batchId,jobId:o.job,reason:'analysis_committed',branchRevision:node.revision,journalKey:jk};
   for(const ref of ss)event(l,yield* item(l,q,'source',ref),'committed',ctx);
   for(const [h,x] of bound)event(l,x,hs.includes(h)?'committed':'queued',{...ctx,reason:hs.includes(h)?ctx.reason:'partial_ack'});
   n.put(updated);w.put(next);tx.objectStore('journal').put({key:jk,stream:q.stream,seq,anchor:node.hash,at:now,label,nodeRevision:node.revision,batchId:b.batchId,jobId:o.job,actorId:q.actor,consumedAnchors:hs,consumedSourceIds:ss});
   Object.assign(j,copyFields(o.resultMeta,['http','finish','model','provider','requestId','usage','cost']),{status:'committed',finished:true,finishedAt:now,result:'已提交',committedSourceIds:ss});u.put(j);yield* freeProfile(u,j);
   need(!o.supersededJob||o.supersededJob===j.previousJobId,'ATTEMPT_CONFLICT','不能替代无关的 job。');if(j.previousJobId){const prev=yield u.get('job:'+j.previousJobId);need(prev?.batchId===b.batchId&&prev.finished,'ATTEMPT_CONFLICT');prev.supersededBy=o.job;u.put(prev);}
   Object.assign(b,{status:'committed',committedAt:now,committedSourceIds:ss,consumedAnchors:hs,journalKey:jk});u.put(b);
   q.anchors=q.anchors.filter(h=>!hs.includes(h));q.acknowledgedSourceIds=[...new Set([...(q.acknowledgedSourceIds||[]),...ss])];q.activeBatch=null;q.failedBatch=null;q.sent=false;q.status=q.anchors.length?'queued':'committed';q.reason='精确确认实际派发来源';own(q,o);need(guard(),'BRANCH_CHANGED');unlock(q);writeQ(u,q);
   // Run after writes have actually executed (not merely before the first put).
   yield u.get(q.key);if(o.injectFault)o.injectFault(tx,e=>{throw e;});
   return {stream:next,node:updated,queueRevision:q.queueRevision,acknowledgedAnchors:hs,acknowledgedSourceIds:ss};
  });
 }
 async auditQueueLedger(s,a){const k=scope(s,a);return atomic(this,[...OBS,'journal'],'readonly',function*(tx){
  const u=tx.objectStore(U),l=tx.objectStore(LEDGER),q=(yield u.get(k))||empty(s,a),rows=(yield scoped(l,k)).filter(x=>x.scope===k);
  const tracked=rows.filter(x=>x.kind==='receipt'),items=new Map(),events=new Map(),retirements=new Map(),legacy=new Set(),manifests=new Map(),jobs=new Map(),journals=new Map();
  const missing=new Set(),duplicate=new Set(),orphan=new Set(),mismatch=new Set(),counts=Object.fromEntries(STATES.map(v=>[v,0]));
  const uid=(u,r)=>key('',u,r),members=new Set(q.anchors),receiptIDs=new Set(tracked.map(x=>uid(x.unit,x.ref)));
  const batchIDs=new Set([q.activeBatch?.batchId,q.failedBatch?.batchId].filter(Boolean));
  const inventory=(yield typeof u.index==='function'?u.index('queueScope').getAll(k):u.getAll()).filter(v=>v.scope===k&&v.managed===7);
  const refs=new Set(rows.filter(x=>x.kind==='batchRef').map(x=>x.ref));
  for(const row of inventory){batchIDs.add(row.batchId);if(!refs.has(row.batchId))orphan.add(row.batchId);}
  const validators=inventory.filter(v=>v.key.startsWith('job:'));
  for(const row of rows){const i=uid(row.unit,row.ref);
   if(row.kind==='item'){items.set(i,row);if(!receiptIDs.has(i))mismatch.add(row.ref);}
   if(row.kind==='event'){if(!events.has(i))events.set(i,[]);events.get(i).push(row);if(!receiptIDs.has(i))mismatch.add(row.ref);if(row.batchId)batchIDs.add(row.batchId);}
   if(row.kind==='retirement')retirements.set(row.operationId,row);
   if(row.kind==='legacy'||row.kind==='receipt'&&row.legacy)legacy.add(i);
   if(row.kind==='batchRef')batchIDs.add(row.ref);
  }
  if(members.size!==q.anchors.length)for(const h of q.anchors)mismatch.add(h);
  for(const h of members)if(!receiptIDs.has(uid('anchor',h)))mismatch.add(h);
  for(const bid of batchIDs){
   const b=yield u.get('batch:'+bid);if(!b||b.streamId!==s||b.actorId!==a){orphan.add(bid);continue;}
   manifests.set(bid,b);if(b.managed!==7)continue;
   if((b.status==='inflight'||b.status==='reserved')&&q.activeBatch?.batchId!==bid||b.status===FAILURE&&q.failedBatch?.batchId!==bid)orphan.add(bid);
   for(const jid of new Set([...(b.jobHistory||[]),b.lastJobId,b.pendingJobId].filter(Boolean))){const j=yield u.get('job:'+jid);if(!j||j.scope!==k||j.batchId!==bid)orphan.add(bid);else jobs.set(jid,j);}
   if(b.lastJobId&&!b.jobHistory?.includes(b.lastJobId)||b.pendingJobId&&!b.jobHistory?.includes(b.pendingJobId))orphan.add(bid);
   for(const jid of b.jobHistory||[]){const j=jobs.get(jid);if(j?.sent&&!j.legacyOrigin&&!same(j.dispatchedSourceIds,b.sourceIds))for(const r of [...(j.dispatchedSourceIds||[]),...b.sourceIds])mismatch.add(r);}
   if(b.journalKey)journals.set(b.journalKey,yield tx.objectStore('journal').get(b.journalKey));
   if(b.status==='committed'&&(!sameSet(b.committedSourceIds||[],b.sourceIds)||!journals.get(b.journalKey)))orphan.add(bid);
   for(const r of b.sourceIds){const x=items.get(uid('source',r));if(!x||!b.anchorIds.includes(x.anchorId))mismatch.add(r);}
   if(b.status==='reserved'){const j=jobs.get(b.pendingJobId);if(!j||j.sent||j.finished||j.attemptNo!==b.attemptNo||q.activeBatch?.pendingJobId!==b.pendingJobId)orphan.add(bid);}
   const checking=b.status==='reserved'&&b.lastJobId?FAILURE:b.status;
   if(checking==='inflight'||checking===FAILURE||checking==='committed'){
    const j=jobs.get(b.lastJobId);
    if(!j?.sent||checking==='inflight'&&j.finished||checking===FAILURE&&(!j.finished||j.status!=='failed_requires_review')||checking==='committed'&&j.status!=='committed')orphan.add(bid);
    for(const [unit,refs] of [['source',b.sourceIds],['anchor',checking==='committed'?b.consumedAnchors||[]:b.anchorIds]])for(const ref of refs){
     const x=items.get(uid(unit,ref));if(x?.state!==checking||x.batchId!==bid||x.jobId!==b.lastJobId)mismatch.add(ref);
    }
   }
  }
  for(const j of validators){const b=manifests.get(j.batchId);if(!b?.jobHistory?.includes(j.key.slice(4)))orphan.add(j.batchId);}
  if(q.activeBatch){const b=manifests.get(q.activeBatch.batchId);if(b?.managed===7&&!['reserved','inflight'].includes(b.status))orphan.add(b.batchId);}
  if(q.failedBatch){const b=manifests.get(q.failedBatch.batchId);if(b?.managed===7&&![FAILURE,'reserved'].includes(b.status))orphan.add(b.batchId);}
  const committed=new Set();
  for(const r of tracked){
   const i=uid(r.unit,r.ref),x=items.get(i),ev=events.get(i)||[],ts=ev.filter(e=>TERMINAL.has(e.state));
   if(ts.length>1)duplicate.add(r.ref);
   if(x&&(ev.length!==x.historySeq||new Set(ev.map(e=>e.order)).size!==ev.length))mismatch.add(r.ref);
   if(!x){missing.add(r.ref);continue;}
   if(x.anchorId!==r.anchorId||x.branchRevision!==r.branchRevision||x.sourceFingerprint!==r.sourceFingerprint||x.streamId!==s||x.actorId!==a)mismatch.add(r.ref);
   const last=ev.find(e=>e.operationId===x.lastOperationId);
   if(!last||last.state!==x.state||!STATES.includes(x.state)){missing.add(r.ref);continue;}
   if(!r.legacy)counts[x.state]++;
   if(r.unit==='source'){const p=items.get(uid('anchor',r.anchorId));if(!p||!p.sourceIds.includes(r.ref)||p.mappingFingerprint!==r.sourceFingerprint)mismatch.add(r.ref);}
   else for(const ref of x.sourceIds||[]){if(items.get(uid('source',ref))?.anchorId!==r.ref)mismatch.add(ref);}
   if(TERMINAL.has(x.state)){
    if(ts.length!==1||!last.reason||last.branchRevision==null||!last.at)missing.add(r.ref);
    if(r.unit==='anchor'&&members.has(r.ref))mismatch.add(r.ref);
    if(x.state==='committed'){
     if(r.unit==='source')committed.add(r.ref);
     const b=manifests.get(last.batchId),j=jobs.get(last.jobId),journal=journals.get(last.journalKey);
     const field=r.unit==='source'?'committedSourceIds':'consumedAnchors',jx=r.unit==='source'?'consumedSourceIds':'consumedAnchors';
     if(b?.status!=='committed'||j?.status!=='committed'||b.lastJobId!==last.jobId||!b[field]?.includes(r.ref)||journal?.actorId!==a||journal?.jobId!==last.jobId||!journal?.[jx]?.includes(r.ref)||r.unit==='source'&&!j.committedSourceIds?.includes(r.ref)){mismatch.add(r.ref);missing.add(r.ref);}
    }else{const act=retirements.get(last.operationId);if(!act||act.reason!==last.reason||act.state!==x.state||act.branchRevision!==last.branchRevision||!(r.unit==='source'?act.retiredSourceIds:act.anchors)?.includes(r.ref))missing.add(r.ref);}
   }else{
    if(ts.length)duplicate.add(r.ref);
    if(!members.has(r.anchorId))missing.add(r.ref);
    if(x.state==='inflight'||x.state===FAILURE){const b=manifests.get(x.batchId),j=jobs.get(x.jobId);const pointer=x.state==='inflight'?q.activeBatch:q.failedBatch;
     if(!b||!j?.sent||pointer?.batchId!==b.batchId||!(r.unit==='source'?b.sourceIds:b.anchorIds).includes(r.ref)||b.lastJobId!==x.jobId||!((x.state===FAILURE&&b.status==='reserved')||b.status===x.state))orphan.add(x.batchId||r.ref);}
   }
  }
  for(const ref of q.acknowledgedSourceIds||[])if(!committed.has(ref)&&!legacy.has(uid('source',ref)))mismatch.add(ref);
  const acknowledged=new Set(q.acknowledgedSourceIds||[]);for(const ref of committed)if(!acknowledged.has(ref))mismatch.add(ref);
  const verified=Object.fromEntries(STATES.map(v=>[v,0]));
  for(const r of tracked){const x=items.get(uid(r.unit,r.ref));if(!r.legacy&&x&&STATES.includes(x.state)&&!missing.has(r.ref)&&!duplicate.has(r.ref)&&!mismatch.has(r.ref)&&!orphan.has(x.batchId))verified[x.state]++;}
  const unverifiedAcceptedCount=tracked.filter(x=>!x.legacy).length-Object.values(verified).reduce((a,b)=>a+b,0);
  const arr=s=>[...s].sort();return {ok:![missing,duplicate,orphan,mismatch].some(x=>x.size),acceptedCount:tracked.filter(x=>!x.legacy).length,acceptedAnchorCount:tracked.filter(x=>!x.legacy&&x.unit==='anchor').length,acceptedSourceCount:tracked.filter(x=>!x.legacy&&x.unit==='source').length,counts:verified,observedCounts:counts,unverifiedAcceptedCount,unexpectedMissingIds:arr(missing),duplicateTerminalIds:arr(duplicate),orphanedBatchIds:arr(orphan),sourceMismatchIds:arr(mismatch),legacyUnverifiedCount:legacy.size,coverage:legacy.size?'legacy_partial':'recorded_admissions_only'};
 });}
 async listQueueHistory(s,a,unit,ref){need(['source','anchor'].includes(unit),'BAD_INPUT');sid(ref);const k=scope(s,a);return atomic(this,[LEDGER],'readonly',function*(tx){const l=tx.objectStore(LEDGER),rows=yield typeof l.index==='function'?l.index('scopeItem').getAll([k,unit,ref]):l.getAll();return rows.filter(x=>x.scope===k&&x.unit===unit&&x.ref===ref&&(x.kind==='receipt'||x.kind==='event')).sort((a,b)=>(a.at||a.observedAt)-(b.at||b.observedAt)||((a.order||0)-(b.order||0)));});}
}

// Physical v5 -> v6 versionchange transaction. No legacy text is copied to the audit ledger.
// The rollback store is a separate, immutable pre-upgrade image of the original six stores.
export function installLedgerUpgrade(db,tx,oldStores,hadV5){
 tx.objectStore(U).createIndex?.('queueScope','scope');
 const l=db.createObjectStore(LEDGER,{keyPath:'key'});l.createIndex?.('scope','scope');l.createIndex?.('scopeKind',['scope','kind']);l.createIndex?.('scopeItem',['scope','unit','ref']);
 const backup=db.createObjectStore(ROLLBACK,{keyPath:'key'});
 if(!hadV5)return;
 const observe=row=>{
  if(row.key?.startsWith('queue:')&&row.stream&&row.actor){
   const q=row;for(const h of new Set(q.anchors||[]))admission(l,q,'anchor',h,h,h,h,true);
   for(const ref of new Set([...(q.acknowledgedSourceIds||[]),...(q.activeBatch?.sourceIds||[]),...(q.failedBatch?.sourceIds||[])]))add(l,q.key,'legacy','source',ref,{origin:'v0.6_queue',observedAt:Date.now()});
  }else if(row.key?.startsWith('batch:')&&row.streamId&&row.actorId){
   const k=scope(row.streamId,row.actorId);for(const ref of new Set([...(row.sourceIds||[]),...(row.committedSourceIds||[])]))add(l,k,'legacy','source',ref,{origin:'v0.6_batch',observedAt:Date.now()});
  }
 };
 backup.put({key:'meta',format:'lin-persona-v6-rollback',layout:5,stores:oldStores,at:Date.now()});
 for(const store of oldStores){
  const src=tx.objectStore(store),visit=row=>{backup.put({key:key('snapshot',store,row.key),store,row});if(store===U)observe(row);};
  if(src.openCursor){const c=src.openCursor();c.onsuccess=()=>{const it=c.result;if(it){visit(it.value);it.continue();}};}
  else{const req=src.getAll();req.onsuccess=()=>req.result.forEach(visit);}
 }
}
