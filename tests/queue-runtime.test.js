import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,turn,R,U,A} from './host-fixture.js';
import {Database} from '../src/storage.js';
import {makeAnalysisInput} from '../src/analysis.js';
import {hash,id} from '../src/util.js';

const empty=JSON.stringify({events:[],appraisals:[],proposals:[],summaries:[]});
const settings={analysisEnabled:true,autoAnalyze:false,useJsonSchema:false,dailyLimit:100,sessionLimit:100,analysisMaxTotalRequests:100};
const scope=f=>[f.ctl.timeline.stream.id,A.avatar];
const facts=f=>f.ctl.db.readQueueFacts(...scope(f));
const O=q=>({callerOwner:q.claimOwner,fencingToken:q.fencingToken});
const waitFor=async fn=>{for(let i=0;i<2000;i++){if(fn())return;await new Promise(r=>setTimeout(r,1));}throw Error('fixture did not reach checkpoint');};
const isolate=f=>{f.ctl.pumpAnalysis=()=>Promise.resolve();return f;};
const faultQueue=async(f,patch)=>{const q=(await facts(f)).queue;await f.ctl.db.transaction(['usage'],'readwrite',tx=>tx.objectStore('usage').put({...q,...patch}));};
async function reserveOnly(f){
 const c=f.ctl,[stream,actor]=scope(f);await c.admitManualSources(actor);
 const lease=await c.db.claimQueue(stream,actor,c.queueOwner,60000);await c.registerSources(actor,O(lease));
 const p=c.analyzer.getProfile(),input=makeAnalysisInput({...c.options(actor),includeCard:p.sendBaseline,maxInput:p.input,contract:p.contract});
 const q=await facts(f),owners=new Map(q.mappings.flatMap(m=>m.sourceIds.map(x=>[x,m.anchorId])));
 const frozen={batchId:id(),streamId:stream,actorId:actor,originalBranchHead:c.timeline.node.hash,originalRevision:c.timeline.node.revision,sourceIds:input.fresh.map(x=>x.id),anchorIds:[...new Set(input.fresh.map(x=>owners.get(x.id)))],
  sourceFingerprint:await hash(JSON.stringify(input.fresh.map(x=>[x.id,x.node,x.rawStart,x.rawEnd,x.text]))),payloadFingerprint:await c.analyzer.inputFingerprint(input,p),providerProfileId:p.id,modelId:p.model||'st-current',contractVersion:p.contract||'full'};
 const jobId=id();await c.db.reserveBatchAttempt(frozen,{...O(lease),jobId,session:c.session,expectedAttemptNo:0,previousJobId:null,limits:{total:100,day:100,session:100,interval:0,timeout:60}});
 return {frozen,jobId,lease,input};
}

test('B01: admission failure never reports accepted or leaves a memory-only anchor',async t=>{
 const f=isolate(await fixture({chat:[R('沈青核对母带。')],settings:{...settings,autoAnalyze:true,minTurns:100}}));t.after(()=>f.ctl.dispose());
 await f.ctl.queueWork;
 f.ctl.db.appendQueueAnchors=async()=>{throw Error('disk full');};
 await assert.rejects(f.ctl.scheduleAnalysis(A.avatar,f.ctl.timeline.node.hash),/disk full/);
 assert.equal(f.ctl.sessions.size,0);assert.deepEqual((await facts(f)).anchors,[]);
 assert.equal((await f.ctl.auditQueueState(A.avatar)).acceptedCount,0);
});

test('B02: full floor mapping precedes batch selection; a partial floor is not ACKed',async t=>{
 let calls=0,f,atDispatch;
 f=await fixture({chat:[R('沈青核对母带。沈青标记时间。沈青保存副本。')],settings:{...settings,batchSize:2},ctx:{generateRaw:async()=>{calls++;atDispatch=await facts(f);return empty;}}});t.after(()=>f.ctl.dispose());
 await f.ctl.analyze(A.avatar);
 assert.equal(atDispatch.mappings[0].sourceIds.length,3);assert.equal(atDispatch.mappings[0].mappingComplete,true);
 assert.equal(atDispatch.queue.activeBatch.sourceIds.length,2);assert.equal((await facts(f)).anchors.length,1);
 await f.ctl.analyze(A.avatar);assert.equal(calls,2);assert.equal((await facts(f)).anchors.length,0);
 assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});

test('B03: zero visible fragments retire with a reason and never reserve quota',async t=>{
 let calls=0;const f=await fixture({chat:[R('')],settings,ctx:{generateRaw:async()=>{calls++;return empty;}}});t.after(()=>f.ctl.dispose());
 await f.ctl.db.appendQueueAnchors(...scope(f),[f.ctl.timeline.node.hash],{room:f.ctl.capture.room});
 await f.ctl.analyze(A.avatar,false,1,null,false,{queueTask:true});
 const q=await facts(f);assert.equal(calls,0);assert.equal(await f.ctl.db.get('usage','account'),undefined);
 assert.equal(q.anchors.length,0);assert.equal(q.mappings[0].emptyReason,'no_visible_sources_for_actor');
 assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});

test('B04: another tab appends while a request is in flight; exact ACK preserves it',async t=>{
 let f,h2;f=await fixture({chat:[R('沈青核对母带。'),R('沈青记录排期。')],settings,ctx:{generateRaw:async()=>{
  const peer=new Database('fixture',f.factory);await peer.appendQueueAnchors(...scope(f),[h2],{room:f.ctl.capture.room});peer.close();return empty;
 }}});t.after(()=>f.ctl.dispose());
 const h1=f.ctl.timeline.path[1].hash;h2=f.ctl.timeline.path[2].hash;
 await f.ctl.db.appendQueueAnchors(...scope(f),[h1],{room:f.ctl.capture.room});
 await f.ctl.analyze(A.avatar,false,1,null,false,{queueTask:true});
 assert.deepEqual((await facts(f)).anchors,[h2]);assert.equal(f.ctl.sessions.get(scope(f).join(':')).anchors.has(h2),true);
 assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});

test('B05: explicit partial-source retirement is not resent and permits exact floor completion',async t=>{
 let calls=[];const f=await fixture({chat:[R('沈青核对母带。沈青标记时间。')],settings,ctx:{generateRaw:async r=>{calls.push(JSON.parse(r.prompt));return empty;}}});t.after(()=>f.ctl.dispose());
 await f.ctl.admitManualSources(A.avatar);const lease=await f.ctl.db.claimQueue(...scope(f),f.ctl.queueOwner,60000);
 const q=await f.ctl.registerSources(A.avatar,O(lease)),[cancelled,remaining]=q.mappings[0].sourceIds;
 await f.ctl.db.retireQueueAnchors(...scope(f),[],{...O(lease),sourceIds:[cancelled],state:'explicitly_cancelled',reason:'player_excluded_fragment',branchRevision:f.ctl.timeline.node.hash,operationId:id()});
 await f.ctl.releaseOwned(...scope(f),O(lease));await f.ctl.analyze(A.avatar);
 assert.equal(calls[0].messages.length,1);assert.deepEqual((await facts(f)).processedSourceIds,[remaining]);
 assert.equal((await facts(f)).anchors.length,0);assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});

test('B06: a failed retry reservation retains the last charged job and frozen batch',async t=>{
 let calls=0;const f=await fixture({chat:[R('沈青核对母带。')],settings:{...settings,analysisMaxTotalRequests:1},ctx:{generateRaw:async()=>{calls++;throw Error('network');}}});t.after(()=>f.ctl.dispose());
 await assert.rejects(f.ctl.analyze(A.avatar));const before=await facts(f),bid=before.queue.failedBatch.batchId,old=await f.ctl.db.readBatchAttempt(bid);
 await assert.rejects(f.ctl.analyze(A.avatar,false,1,null,true),/预算/);
 const after=await f.ctl.db.readBatchAttempt(bid);assert.equal(calls,1);assert.deepEqual(after,old);
 assert.equal((await facts(f)).queue.failedBatch.batchId,bid);assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});

test('B07: cancellation after reservation but before dispatch refunds all seven counters',async t=>{
 let calls=0;const f=await fixture({settings,ctx:{generateRaw:async()=>{calls++;return empty;}}});t.after(()=>f.ctl.dispose());
 const reserve=f.ctl.db.reserveBatchAttempt.bind(f.ctl.db);f.ctl.db.reserveBatchAttempt=async(...args)=>{const x=await reserve(...args);f.ctl.cancel();return x;};
 await assert.rejects(f.ctl.analyze(A.avatar),/过时/);
 const rows=await f.ctl.db.all('usage'),j=rows.find(x=>x.key.startsWith('job:'));
 assert.equal(calls,0);assert.equal(j.sent,false);assert.equal(j.status,'released_unsent');
 for(const [i,k] of j.keys.entries())assert.equal(rows.find(x=>x.key===k)[i?'count':'total'],0);
 const u=await f.ctl.usageSummary();assert.equal(u.releasedUnsentCount,1);assert.equal(u.unknownUsageCount,0);
 assert.equal((await facts(f)).queue.activeBatch,null);assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});

test('B08: cancellation after dispatch intent retains uncertain cost even before HTTP starts',async t=>{
 let calls=0;const f=await fixture({settings,ctx:{generateRaw:async()=>{calls++;return empty;}}});t.after(()=>f.ctl.dispose());
 const mark=f.ctl.db.markBatchAttemptSent.bind(f.ctl.db);f.ctl.db.markBatchAttemptSent=async(...args)=>{const x=await mark(...args);f.ctl.cancel();return x;};
 await assert.rejects(f.ctl.analyze(A.avatar));const q=await facts(f);
 assert.equal(calls,0);assert.equal(q.queue.status,'failed_requires_review');assert.equal((await f.ctl.db.get('usage','account')).total,1);
 assert.equal(f.ctl.analyzer.busy,false);await f.ctl.restoreQueues();assert.equal(calls,0);
 const u=await f.ctl.usageSummary();assert.equal(u.sentIntentCount,1);assert.equal(u.failedBilledCount,1);
});

test('B09: in-flight cancellation retains failure; a late response cannot commit or auto-resend',async t=>{
 let calls=0,resolve;const f=await fixture({settings,ctx:{generateRaw:()=>{calls++;return new Promise(r=>resolve=r);}}});t.after(()=>f.ctl.dispose());
 const result=f.ctl.analyze(A.avatar);const rejected=assert.rejects(result,/取消/);await waitFor(()=>!!resolve);f.ctl.cancel();await rejected;
 assert.equal(f.ctl.analyzer.busy,true);assert.equal((await facts(f)).queue.status,'failed_requires_review');
 await f.ctl.restoreQueues();assert.equal(calls,1);resolve(empty);await waitFor(()=>!f.ctl.analyzer.busy);
 assert.equal(f.ctl.timeline.node.state.processed[A.avatar],undefined);assert.equal((await f.ctl.usageSummary()).totalRequests,1);
 assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});

test('B10: expired sent lease is recovered as unknown; a late commit cannot acquire new authority',async t=>{
 const f=await fixture({settings,ctx:{generateRaw:async()=>empty}});t.after(()=>f.ctl.dispose());
 const commit=f.ctl.timeline.commitAnalysis.bind(f.ctl.timeline),revision=f.ctl.timeline.node.revision;
 f.ctl.timeline.commitAnalysis=async(...args)=>{
  await faultQueue(f,{claimUntil:Date.now()-1000});const peer=new Database('fixture',f.factory);
  await assert.rejects(peer.claimQueue(...scope(f),'other-tab',60000),e=>e.code==='LEASE_EXPIRED_SENT');peer.close();return commit(...args);
 };
 await assert.rejects(f.ctl.analyze(A.avatar),/租约|Fencing/);
 assert.equal(f.ctl.timeline.node.revision,revision);assert.equal((await facts(f)).processedSourceIds.length,0);
 assert.equal((await facts(f)).queue.status,'failed_requires_review');assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});

test('B11: restart refunds an abandoned unsent reservation but never dispatches its old job',async t=>{
 let calls=0;const f=await fixture({settings,ctx:{generateRaw:async()=>{calls++;return empty;}}});t.after(()=>f.ctl.dispose());
 const x=await reserveOnly(f);await faultQueue(f,{claimUntil:Date.now()-1});await f.ctl.restoreQueues({schedule:false});
 const old=await f.ctl.db.readBatchAttempt(x.frozen.batchId);assert.equal(old.pending,null);assert.equal(old.last,null);
 assert.equal(old.manifest.status,'released_unsent');assert.equal((await f.ctl.usageSummary()).totalRequests,0);assert.equal(calls,0);
 await f.ctl.analyze(A.avatar);assert.equal(calls,1);assert.equal((await f.ctl.db.get('usage','job:'+x.jobId)).sent,false);
 assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});

test('B12: restart with expired sent intent does not refund or resend',async t=>{
 let calls=0;const f=isolate(await fixture({settings,ctx:{generateRaw:async()=>{calls++;return empty;}}}));t.after(()=>f.ctl.dispose());
 const x=await reserveOnly(f);await f.ctl.db.markBatchAttemptSent(...scope(f),x.frozen.batchId,x.jobId,x.frozen.sourceIds,{...O(x.lease),payloadFingerprint:x.frozen.payloadFingerprint});
 await faultQueue(f,{claimUntil:Date.now()-1});await f.ctl.restoreQueues();
 assert.equal(calls,0);assert.equal((await facts(f)).queue.status,'failed_requires_review');
 assert.equal((await f.ctl.usageSummary()).totalRequests,1);assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});

test('B13: same-profile wire model/schema changes reject frozen retries without consuming quota',async t=>{
 let model='gemini-4-carbon',calls=0;const f=await fixture({settings,ctx:{getChatCompletionModel:()=>model,generateRaw:async()=>{calls++;throw Error('network');}}});t.after(()=>f.ctl.dispose());
 await assert.rejects(f.ctl.analyze(A.avatar));const bid=(await facts(f)).queue.failedBatch.batchId,old=await f.ctl.db.readBatchAttempt(bid);
 model='gemini-4-argon';await assert.rejects(f.ctl.analyze(A.avatar,false,1,null,true),/输入或配置/);
 model='gemini-4-carbon';f.ctl.changeSettings({useJsonSchema:true});await assert.rejects(f.ctl.analyze(A.avatar,false,1,null,true),/输入或配置/);
 assert.equal(calls,1);assert.deepEqual(await f.ctl.db.readBatchAttempt(bid),old);
});

test('B14: a source filter that selects nothing cannot retire unrelated accepted floors',async t=>{
 let calls=0;const f=await fixture({chat:[R('沈青核对母带。')],settings,ctx:{generateRaw:async()=>{calls++;return empty;}}});t.after(()=>f.ctl.dispose());
 await f.ctl.admitManualSources(A.avatar);const before=(await facts(f)).anchors;
 await f.ctl.analyze(A.avatar,false,1,new Set(),false,{queueTask:true});
 assert.equal(calls,0);assert.deepEqual((await facts(f)).anchors,before);assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});

test('B15: Inspector exposes missing admissions even when visible-text partition is complete',async t=>{
 const f=await fixture({chat:[R('沈青核对母带。')],settings});t.after(()=>f.ctl.dispose());
 await f.ctl.admitManualSources(A.avatar);const h=(await facts(f)).anchors[0];await faultQueue(f,{anchors:[]});await f.ctl.refreshQueue(...scope(f));
 assert.equal(f.ctl.auditSourceConservation(A.avatar).partitionComplete,true);
 const q=await f.ctl.inspectQueue(A.avatar);assert.equal(q.audit.ok,false);assert.ok(q.audit.unexpectedMissingIds.includes(h));
});

test('B16: archive/cancel is explicit, costs stay, and cancelled sources cannot be resurrected',async t=>{
 let calls=0;const f=await fixture({chat:[R('沈青核对母带。')],settings,ctx:{generateRaw:async()=>{calls++;throw Error('network');}}});t.after(()=>f.ctl.dispose());
 await assert.rejects(f.ctl.analyze(A.avatar));const q=await facts(f),bid=q.queue.failedBatch.batchId;
 await f.ctl.discardFailedBatch(A.avatar,{rebuildQueue:false});assert.equal(calls,1);
 assert.equal((await facts(f)).anchors.length,0);assert.equal((await f.ctl.usageSummary()).totalRequests,1);
 assert.ok((await f.ctl.db.readBatchAttempt(bid)).last.sent);
 await f.ctl.db.appendQueueAnchors(...scope(f),q.anchors,{room:f.ctl.capture.room});await f.ctl.analyze(A.avatar);
 assert.equal(calls,1);assert.equal((await facts(f)).anchors.length,0);assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});

test('B17: recovery cannot release a locally preparing lease before the batch is registered',async t=>{
 let calls=0;const f=await fixture({settings,ctx:{generateRaw:async()=>{calls++;return empty;}}});t.after(()=>f.ctl.dispose());
 const register=f.ctl.registerSources.bind(f.ctl);f.ctl.registerSources=async(...args)=>{await f.ctl.restoreQueues({schedule:false});return register(...args);};
 await f.ctl.analyze(A.avatar);assert.equal(calls,1);assert.equal((await facts(f)).anchors.length,0);
});

test('B18: usable response metadata survives local validation failure without committing persona',async t=>{
 const f=await fixture({settings,ctx:{generateRaw:async()=>'not json'}});t.after(()=>f.ctl.dispose());
 const send=f.ctl.analyzer.send.bind(f.ctl.analyzer);f.ctl.analyzer.send=async(...args)=>({...await send(...args),usage:{input:17,output:3},cost:0.02});
 await assert.rejects(f.ctl.analyze(A.avatar));const q=await facts(f),a=await f.ctl.db.readBatchAttempt(q.queue.failedBatch.batchId);
 assert.equal(a.last.finished,true);assert.equal(a.last.sent,true);assert.equal(a.last.status,'failed_requires_review');
 assert.deepEqual(a.last.usage,{input:17,output:3});assert.equal(a.last.cost,0.02);assert.equal((await f.ctl.usageSummary()).reportedInputTokens,17);
 assert.equal(f.ctl.timeline.node.state.processed[A.avatar],undefined);assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});

for(const extra of [1,5,20])test(`B19-${extra}: frozen retry after ${extra} new RP turns dispatches the original sources only`,async t=>{
 let fail=true,calls=[];const f=isolate(await fixture({chat:[R('沈青核对母带。')],settings,ctx:{generateRaw:async r=>{calls.push(JSON.parse(r.prompt).messages);if(fail)throw Error('network');return empty;}}}));t.after(()=>f.ctl.dispose());
 await assert.rejects(f.ctl.analyze(A.avatar));const old=(await facts(f)).queue.failedBatch;
 f.ctl.changeSettings({autoAnalyze:true,minTurns:100});await f.ctl.queueWork;
 for(let i=0;i<extra;i++)await turn(f,`沈青记下第${i}条排期。`,{user:`检查第${i}条。`});
 fail=false;await f.ctl.analyze(A.avatar,false,1,null,true);
 assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0]);assert.equal((await facts(f)).anchors.length,extra);
 assert.equal((await f.ctl.db.readBatchAttempt(old.batchId)).manifest.attemptNo,2);assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});

test('B20: unchanged selected sources do not excuse a changed full-floor visibility mapping',async t=>{
 let calls=0;const f=await fixture({chat:[R('沈青核对母带。')],settings,ctx:{generateRaw:async()=>{calls++;throw Error('network');}}});t.after(()=>f.ctl.dispose());
 await assert.rejects(f.ctl.analyze(A.avatar));const q=await facts(f),view=f.ctl.views.get(A.avatar),old=await f.ctl.db.readBatchAttempt(q.queue.failedBatch.batchId);
 // Simulate an additional permitted fragment from the same floor without changing the dispatched fragment.
 view.source.push({...view.source[0],id:'new-visible-fragment',text:'新增可见片段。'});
 await assert.rejects(f.ctl.analyze(A.avatar,false,1,null,true),/完整楼层来源/);
 assert.equal(calls,1);assert.deepEqual(await f.ctl.db.readBatchAttempt(old.manifest.batchId),old);
});

test('B21: an explicitly requested retry cancelled before dispatch retains its older sent failure',async t=>{
 let calls=0;const f=await fixture({settings,ctx:{generateRaw:async()=>{calls++;throw Error('network');}}});t.after(()=>f.ctl.dispose());
 await assert.rejects(f.ctl.analyze(A.avatar));const bid=(await facts(f)).queue.failedBatch.batchId,old=await f.ctl.db.readBatchAttempt(bid);
 const reserve=f.ctl.db.reserveBatchAttempt.bind(f.ctl.db);f.ctl.db.reserveBatchAttempt=async(...args)=>{const x=await reserve(...args);f.ctl.cancel();return x;};
 await assert.rejects(f.ctl.analyze(A.avatar,false,1,null,true),/过时/);
 const after=await f.ctl.db.readBatchAttempt(bid);assert.equal(calls,1);assert.deepEqual(after.last,old.last);assert.deepEqual(after.frozen,old.frozen);
 assert.equal(after.pending,null);assert.equal(after.history.length,2);assert.equal((await facts(f)).queue.failedBatch.batchId,bid);
 const u=await f.ctl.usageSummary();assert.equal(u.totalRequests,1);assert.equal(u.releasedUnsentCount,1);assert.equal(u.sentIntentCount,1);
 assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});

test('B23: timeout during pre-dispatch fingerprinting releases reservation without network I/O',async t=>{
 let calls=0,fingerprints=0;const f=await fixture({settings,ctx:{generateRaw:async()=>{calls++;return empty;}}});t.after(()=>f.ctl.dispose());
 const profile=f.ctl.analyzer.getProfile.bind(f.ctl.analyzer),fp=f.ctl.analyzer.inputFingerprint.bind(f.ctl.analyzer);
 f.ctl.analyzer.getProfile=(...a)=>({...profile(...a),timeout:0.001});
 f.ctl.analyzer.inputFingerprint=async(...a)=>{if(++fingerprints===2)await new Promise(r=>setTimeout(r,20));return fp(...a);};
 await assert.rejects(f.ctl.analyze(A.avatar),/派发前分析超时/);
 assert.equal(calls,0);assert.equal((await f.ctl.usageSummary()).totalRequests,0);assert.equal((await facts(f)).queue.failedBatch,null);
});

test('B24: managed request timeout keeps the native request lock until the late call settles',async t=>{
 let calls=0,resolve;const f=await fixture({settings,ctx:{generateRaw:()=>{calls++;return new Promise(r=>resolve=r);}}});t.after(()=>f.ctl.dispose());
 const profile=f.ctl.analyzer.getProfile.bind(f.ctl.analyzer);f.ctl.analyzer.getProfile=(...a)=>({...profile(...a),timeout:0.02});
 await assert.rejects(f.ctl.analyze(A.avatar),/超时/);assert.equal(calls,1);assert.equal(f.ctl.analyzer.busy,true);
 await assert.rejects(f.ctl.analyze(A.avatar,false,1,null,true),/上一次分析结束/);
 resolve(empty);await waitFor(()=>!f.ctl.analyzer.busy);
 assert.equal((await facts(f)).queue.status,'failed_requires_review');assert.equal((await f.ctl.usageSummary()).totalRequests,1);
 assert.equal(f.ctl.timeline.node.state.processed[A.avatar],undefined);
});

test('B25: duplicated billing session cannot impersonate another tab queue lease owner',async t=>{
 let resolve,calls=0;const f=await fixture({settings,ctx:{generateRaw:()=>new Promise(r=>resolve=r)}});t.after(()=>f.ctl.dispose());
 const run=f.ctl.analyze(A.avatar);await waitFor(()=>!!resolve);
 const other=await fixture({chat:structuredClone(f.c.chat),db:new Database('fixture',f.factory),settings,ctx:{chatMetadata:structuredClone(f.c.chatMetadata),generateRaw:async()=>{calls++;return empty;}}});t.after(()=>other.ctl.dispose());
 other.ctl.session=f.ctl.session;assert.notEqual(other.ctl.queueOwner,f.ctl.queueOwner);
 await other.ctl.restoreQueues();const q=await facts(f);assert.equal(q.queue.claimOwner,f.ctl.queueOwner);assert.ok(q.queue.activeBatch);
 await assert.rejects(other.ctl.analyze(A.avatar),/另一标签页|重复收费/);assert.equal(calls,0);
 resolve(empty);await run;assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);assert.equal((await facts(f)).queue.failedBatch,null);
});

test('B26: stale retry/archive confirmation cannot authorize a different failed attempt',async t=>{
 let calls=0;const f=await fixture({settings,ctx:{generateRaw:async()=>{calls++;throw Error('network');}}});t.after(()=>f.ctl.dispose());
 await assert.rejects(f.ctl.analyze(A.avatar));const q=await facts(f),old=await f.ctl.db.readBatchAttempt(q.queue.failedBatch.batchId);
 await assert.rejects(f.ctl.analyze(A.avatar,false,1,null,true,{retryBatchId:old.manifest.batchId,retryJobId:'different-job'}),/已变化/);
 await assert.rejects(f.ctl.discardFailedBatch(A.avatar,{expectedBatchId:'different-batch'}),/已变化/);
 assert.equal(calls,1);assert.deepEqual(await f.ctl.db.readBatchAttempt(old.manifest.batchId),old);
});

test('B27: cancelling a reviewed snapshot preserves concurrently appended unreviewed anchors',async t=>{
 const f=await fixture({chat:[R('沈青核对母带。'),R('沈青保存副本。')],settings});t.after(()=>f.ctl.dispose());
 const [h1,h2]=f.ctl.timeline.path.slice(1).map(x=>x.hash);
 await f.ctl.db.appendQueueAnchors(...scope(f),[h1],{room:f.ctl.capture.room});const selected=(await facts(f)).anchors;
 await f.ctl.db.appendQueueAnchors(...scope(f),[h2],{room:f.ctl.capture.room});
 await f.ctl.discardFailedBatch(A.avatar,{rebuildQueue:false,expectedBatchId:null,anchorIds:selected});
 assert.deepEqual((await facts(f)).anchors,[h2]);assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});

test('B28: archiving a charged failure rebuilds locally and requires a separate sending decision',async t=>{
 let calls=0;const f=await fixture({chat:[R('沈青核对母带。')],settings,ctx:{generateRaw:async()=>{calls++;throw Error('network');}}});t.after(()=>f.ctl.dispose());
 await assert.rejects(f.ctl.analyze(A.avatar));f.ctl.changeSettings({autoAnalyze:true,minTurns:2});await f.ctl.queueWork;f.ctl.stopQueuePump();
 await f.ctl.discardFailedBatch(A.avatar,{rebuildQueue:true});await f.ctl.pumpQueueOnce();
 const q=await facts(f);assert.equal(q.queue.failedBatch,null);assert.equal(q.queue.errorKind,'manual_review');assert.equal(q.anchors.length,1);assert.equal(calls,1);
 assert.equal((await f.ctl.usageSummary()).totalRequests,1);assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
});
