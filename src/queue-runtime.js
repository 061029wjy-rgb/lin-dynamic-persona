import {id,hash} from './util.js';
import {makeAnalysisInput,stageAnalysis} from './analysis.js';
import {applyPolicy} from './growth.js';

const terminal=new Set(['committed','explicitly_cancelled','stale_branch','stale_source']);
const waiting=new Set(['queued','waiting_host','waiting_profile','waiting_budget','waiting_capacity']);
const limit=(v,lo,hi,def)=>Number.isFinite(Number(v))?Math.max(lo,Math.min(hi,Math.floor(Number(v)))):def;
const auth=q=>({callerOwner:q.claimOwner,fencingToken:q.fencingToken});
const held=q=>q.claimOwner&&q.claimUntil>Date.now();
const failure=(code,message)=>Object.assign(Error(message),{code});
const sourceDigest=rows=>hash(JSON.stringify(rows.map(x=>[x.id,x.node,x.rawStart,x.rawEnd,x.text])));
const withLength=xs=>Object.defineProperty(new Set(xs),'length',{get(){return this.size;}});

// This layer never writes a queue snapshot. The UI is a projection of completed ledger transactions.
export class QueueRuntime {
 // SessionStorage can be copied by a duplicated browser tab. Billing session and lease owner must differ.
 constructor(){this.queueWork=Promise.resolve();this.queueOwner=id();}
 queueAction(fn){const run=this.queueWork.then(()=>this.disposed?undefined:fn());this.queueWork=run.catch(()=>{});this.task(run);return run;}
 stopQueuePump(){clearTimeout(this.analysisTimer);this.analysisTimer=null;this.pumpResolve?.();this.pumpResolve=null;}
 async refreshQueue(stream,actor){
  const facts=await this.db.readQueueFacts(stream,actor),q=facts.queue,key=stream+':'+actor,old=this.sessions.get(key);
  if(old&&(old.queueRevision||0)>facts.queueRevision)return facts;
  // Preserve the object used by an open Inspector, but replace its contents only from a fresh read.
  const value=Object.assign(old||{},{...q,anchors:withLength(facts.anchors),waitReason:q.reason||'',facts});
  if(facts.anchors.length||q.activeBatch||q.failedBatch)this.sessions.set(key,value);else this.sessions.delete(key);
  if(q.failedBatch)this.failedBatches.set(key,q.failedBatch);else this.failedBatches.delete(key);
  return facts;
 }
 async patchWaiting(stream,actor,patch){
  const facts=await this.refreshQueue(stream,actor),q=facts.queue;
  if(!facts.anchors.length||q.activeBatch||q.failedBatch||q.sent||held(q))return facts;
  // An expired owner must first be fenced out; never borrow a token from a display snapshot.
  let lease=null;
  try{if(q.claimOwner)lease=await this.db.claimQueue(stream,actor,this.queueOwner,60000);
   await this.db.patchQueueState(stream,actor,patch,lease?auth(lease):{expectedRevision:q.queueRevision});
  }catch(e){if(!['LEASE_CONFLICT','FENCE_CONFLICT','REVISION_CONFLICT','LEASE_EXPIRED_SENT'].includes(e.code))throw e;}
  finally{if(lease)await this.releaseOwned(stream,actor,auth(lease));}
  return this.refreshQueue(stream,actor);
 }
 async releaseOwned(stream,actor,O){
  const facts=await this.refreshQueue(stream,actor),q=facts.queue;
  if(q.claimOwner===O.callerOwner&&q.fencingToken===O.fencingToken&&held(q)&&!q.activeBatch)
   await this.db.releaseQueueLease(stream,actor,O.callerOwner,O.fencingToken);
  return this.refreshQueue(stream,actor);
 }
 scheduleAnalysis(actor,anchor){
  const s=this.settings(),stream=this.timeline.stream?.id,room=this.capture?.room;
  if(!actor||!anchor||!stream||this.suspended||!s.enabled||!s.autoAnalyze||!s.analysisEnabled)return Promise.resolve({accepted:false});
  return this.queueAction(async()=>{
   const max=limit(s.queueLimit,1,16,8),others=(await this.db.loadQueues(stream)).filter(q=>q.actor!==actor&&q.status!=='waiting_capacity'&&q.anchors.length).length;
   await this.db.appendQueueAnchors(stream,actor,[anchor],{room,status:others>=max?'waiting_capacity':'queued',reason:'等待有效回复达到分析阈值',branchRevision:anchor});
   const facts=await this.refreshQueue(stream,actor),accepted=facts.anchors.includes(anchor);
   if(accepted&&this.sameRoom(room))this.pumpAnalysis();
   return {accepted,queueRevision:facts.queueRevision};
  });
 }
 wakeWaitingQueues(){return this.queueAction(async()=>{
  const stream=this.timeline.stream?.id;if(!stream)return;
  for(const row of await this.db.loadQueues(stream))if(waiting.has(row.status))
   await this.patchWaiting(stream,row.actor,{status:'queued',reason:'设置已更新，等待重新检查派发条件',waitingDay:null,errorKind:null});
  if(this.settings().autoAnalyze)this.pumpAnalysis();
 });}
 async recoverQueue(stream,actor){
  let facts=await this.refreshQueue(stream,actor),q=facts.queue;
  if(!facts.anchors.length&&!q.activeBatch&&!q.failedBatch)return facts;
  if(this.analysisLock&&this.activeQueue===stream+':'+actor)return facts;
  const oursInFlight=q.activeBatch&&this.inflightBatches.has(q.activeBatch.batchId);
  if(oursInFlight||held(q)&&q.claimOwner!==this.queueOwner)return facts;
  let lease;
  try{
   if(q.activeBatch||q.claimOwner){
    lease=await this.db.claimQueue(stream,actor,this.queueOwner,60000);
    if(!lease)return facts;
    const O=auth(lease);
    if(lease.activeBatch){
     const attempt=await this.db.readBatchAttempt(lease.activeBatch.batchId);
     if(attempt?.pending&&!attempt.pending.sent)
      await this.db.releaseBatchReservation(stream,actor,attempt.manifest.batchId,attempt.pending.key.slice(4),{...O,reason:'recovered_unsent_reservation'});
     else if(attempt?.last?.sent&&!attempt.last.finished)
      await this.db.failBatchAttempt(stream,actor,attempt.manifest.batchId,attempt.last.key.slice(4),{...O,reason:'recovered_unknown_sent_result'});
     else throw failure('LEGACY_REVIEW','遗留派发状态无法核实，请在审计面板复核。');
    }
   }
  }catch(e){if(!['LEASE_EXPIRED_SENT','LEASE_CONFLICT','FENCE_CONFLICT'].includes(e.code))throw e;}
  finally{if(lease)await this.releaseOwned(stream,actor,auth(lease));}
  return this.refreshQueue(stream,actor);
 }
 async restoreQueues({schedule=true}={}){
  const stream=this.timeline.stream?.id,room=this.capture?.room;
  if(!stream||this.suspended||!this.settings().enabled)return;
  for(const row of await this.db.loadQueues(stream)){
   if(!this.sameRoom(room)||stream!==this.timeline.stream?.id)return;
   let facts=await this.recoverQueue(stream,row.actor),q=facts.queue;
   // An unknown sent batch is retained for explicit review even after a branch change.
   if(this.analysisLock&&this.activeQueue===stream+':'+row.actor)continue;
   if(!q.activeBatch&&!q.failedBatch&&!q.sent&&(!held(q)||q.claimOwner===this.queueOwner)){
    const live=new Set(this.timeline.path.map(r=>r.hash)),stale=facts.anchors.filter(h=>!live.has(h));
    if(stale.length){let lease;
     try{lease=await this.db.claimQueue(stream,row.actor,this.queueOwner,60000);
      if(lease){await this.db.retireQueueAnchors(stream,row.actor,stale,{...auth(lease),state:'stale_branch',reason:'selected_branch_changed',branchRevision:this.timeline.node.hash,operationId:id()});
       this.staleSourceRecords.set(stream+':'+row.actor,[...new Set([...(this.staleSourceRecords.get(stream+':'+row.actor)||[]),...stale])]);}
     }catch(e){if(!['LEASE_CONFLICT','FENCE_CONFLICT','LEASE_EXPIRED_SENT'].includes(e.code))throw e;}
     finally{if(lease)await this.releaseOwned(stream,row.actor,auth(lease));}
    }
   }
  }
  if(schedule&&this.settings().analysisEnabled&&this.settings().autoAnalyze)this.pumpAnalysis();
 }
 pumpAnalysis(){
  this.stopQueuePump();const s=this.settings();
  if(this.disposed||!s.enabled||!s.analysisEnabled||!s.autoAnalyze)return this.pumpTask;
  this.pumpTask=new Promise(resolve=>{this.pumpResolve=resolve;this.analysisTimer=setTimeout(async()=>{
   this.analysisTimer=null;
   try{await this.pumpQueueOnce();}catch(e){if(!this.disposed)this.say('自动分析已暂缓：'+e.message);}
   finally{if(this.pumpResolve===resolve)this.pumpResolve=null;resolve();}
  },this.delays?.[0]===0?5:500);});return this.pumpTask;
 }
 async pumpQueueOnce(){
  await this.queueWork;
  const s=this.settings(),stream=this.timeline.stream?.id;
  if(this.disposed||this.suspended||!stream||!s.enabled||!s.analysisEnabled||!s.autoAnalyze)return;
  await this.restoreQueues({schedule:false});
  const rows=[...this.sessions.values()].filter(q=>q.stream===stream&&this.sameRoom(q.room));
  if(this.pending.size||this.generation?.busy||this.analyzer.busy||this.analysisLock){
   for(const q of rows)if(q.status==='queued')await this.patchWaiting(stream,q.actor,{status:'waiting_host',reason:'等待主生成、落盘或当前分析完成'});return;
  }
  const min=limit(s.minTurns,2,100,9),max=limit(s.queueLimit,1,16,8),today=new Date().toISOString().slice(0,10);
  let active=rows.filter(q=>q.status!=='waiting_capacity'&&q.anchors.size).length;
  for(const row of rows){
   let facts=await this.refreshQueue(stream,row.actor),q=facts.queue;
   if(q.failedBatch||q.activeBatch||q.sent||held(q)||q.errorKind==='manual_review')continue;
   if(q.status==='waiting_capacity'&&active<max){facts=await this.patchWaiting(stream,q.actor,{status:'queued',reason:'已取得角色队列处理槽位'});active++;}
   else if(q.status==='waiting_host'||q.status==='waiting_budget'&&q.waitingDay&&q.waitingDay!==today)
    facts=await this.patchWaiting(stream,q.actor,{status:'queued',reason:'重新检查可用条件',waitingDay:null});
   q=facts.queue;if(q.status!=='queued')continue;
   const mapped=facts.mappings.some(m=>facts.anchors.includes(m.anchorId)&&m.mappingComplete&&m.sourceIds.length);
   if(facts.anchors.length<min&&!mapped)continue;
   try{await this.analyze(q.actor,false,1,null,false,{automatic:true,queueTask:this.sessions.get(stream+':'+q.actor)});}
   catch(e){this.say('自动分析未提交：'+e.message);}
   if(!this.disposed&&[...this.sessions.values()].some(x=>x.stream===stream&&['queued','waiting_capacity'].includes(x.status)&&x.anchors.size))this.pumpAnalysis();
   break;
  }
 }
 async admitManualSources(actor,filter){
  const stream=this.timeline.stream.id,view=this.live(actor),facts=await this.refreshQueue(stream,actor);
  const owned=new Set(facts.mappings.flatMap(m=>m.sourceIds||[])),done=new Set(this.timeline.node.state.processed[actor]||[]),anchors=new Set();
  for(const src of view.source)if(!done.has(src.id)&&!owned.has(src.id)&&(!filter||filter.has(src.id))){
   let h=src.node;
   // A preceding user floor belongs to the actor reply that will analyze it; isolated manual floors own themselves.
   if(this.capture.chat[src.index]?.is_user){const next=this.timeline.path[src.index+2];
    if(next&&(this.capture.chat[src.index+1]?.original_avatar===actor||this.capture.chat[src.index+1]?.name===view.actor.name&&!this.capture.chat[src.index+1]?.is_user))h=next.hash;}
   anchors.add(h);
  }
  if(anchors.size)await this.db.appendQueueAnchors(stream,actor,[...anchors],{room:this.capture.room,reason:'player_requested_analysis',branchRevision:this.timeline.node.hash});
  return this.refreshQueue(stream,actor);
 }
 async registerSources(actor,O){
  const stream=this.timeline.stream.id,view=this.live(actor),path=this.timeline.path,live=new Set(path.map(r=>r.hash));
  let facts=await this.refreshQueue(stream,actor);
  const owned=new Map(facts.mappings.flatMap(m=>(m.sourceIds||[]).map(x=>[x,m.anchorId]))),mapped=new Map(facts.mappings.map(m=>[m.anchorId,m]));
  const retire=async(h,state,reason)=>this.db.retireQueueAnchors(stream,actor,[h],{...O,state,reason,branchRevision:this.timeline.node.hash,operationId:id()});
  for(const h of facts.anchors){
   if(!live.has(h)){await retire(h,'stale_branch','selected_branch_changed');continue;}
   const index=path.findIndex(r=>r.hash===h),nodes=new Set([h]);
   if(index>1&&this.capture.chat[index-2]?.is_user)nodes.add(path[index-1].hash);
   const full=view.source.filter(x=>nodes.has(x.node)&&(!owned.has(x.id)||owned.get(x.id)===h));
   const existing=mapped.get(h),finger=await sourceDigest(full);
   if(existing?.mappingComplete&&existing.mappingFingerprint!==finger){
    // A frozen floor cannot be silently overwritten or re-admitted under a different ID.
    await retire(h,'stale_source','visibility_or_source_mapping_changed');continue;
   }
   await this.db.registerQueueSources(stream,actor,h,full.map(x=>x.id),finger,{...O,...(!full.length?{emptyReason:'no_visible_sources_for_actor'}:{})});
   full.forEach(x=>owned.set(x.id,h));
   if(!full.length)await retire(h,'stale_source','no_visible_sources_for_actor');
  }
  return this.refreshQueue(stream,actor);
 }
 async validateBatchSources(actor,facts,frozen){
  const view=this.live(actor),path=this.timeline.path,owned=new Map(facts.mappings.flatMap(m=>m.sourceIds.map(x=>[x,m.anchorId])));
  for(const h of frozen.anchorIds){
   const m=facts.mappings.find(x=>x.anchorId===h),index=path.findIndex(x=>x.hash===h),nodes=new Set([h]);
   if(index>1&&this.capture.chat[index-2]?.is_user)nodes.add(path[index-1].hash);
   const rows=view.source.filter(x=>nodes.has(x.node)&&(!owned.has(x.id)||owned.get(x.id)===h));
   if(index<0||!m?.mappingComplete||await sourceDigest(rows)!==m.mappingFingerprint)
    throw failure('SOURCE_MISMATCH','原批次完整楼层来源已被编辑或可见范围改变，无法直接重发或采用。');
  }
 }
 async computeFullyAckedAnchors(actor,candidateAnchors,_processed,batchSourceIds){
  const stream=this.timeline.stream.id,facts=await this.db.readQueueFacts(stream,actor),batch=new Set(batchSourceIds),done=new Set(facts.terminalSourceIds),out=[];
  for(const m of facts.mappings){
   if(!candidateAnchors.includes(m.anchorId)||!m.mappingComplete||!m.sourceIds.length||!m.sourceIds.some(x=>batch.has(x)))continue;
   let all=true;
   for(const ref of m.sourceIds)if(!done.has(ref)&&!batch.has(ref)){
    const history=await this.db.listQueueHistory(stream,actor,'source',ref);
    if(!terminal.has(history.filter(x=>x.kind==='event').at(-1)?.state)){all=false;break;}
   }
   if(all)out.push(m.anchorId);
  }
  return out;
 }
 async auditQueueState(actor){const stream=this.timeline.stream?.id;if(!stream)throw Error('请先打开聊天。');return this.db.auditQueueLedger(stream,actor);}
 async inspectQueue(actor,stream=this.timeline.stream?.id){
  if(!stream)throw Error('请先打开聊天。');
  const [facts,audit]=await Promise.all([this.db.readQueueFacts(stream,actor),this.db.auditQueueLedger(stream,actor)]);
  const ids=[...new Set([facts.queue.activeBatch?.batchId,facts.queue.failedBatch?.batchId].filter(Boolean))];
  const attempts=await Promise.all(ids.map(id=>this.db.readBatchAttempt(id)));
  return {stream,actor,facts,audit,attempts};
 }
 async discardFailedBatch(actor,{rebuildQueue=true,expectedBatchId,anchorIds}={}){
  if(this.analysisLock)throw Error('请先取消当前分析并等待本地结算，再处理待办。');
  await this.queueWork;const stream=this.timeline.stream?.id;if(!stream)return false;
  await this.recoverQueue(stream,actor);let lease;
  try{lease=await this.db.claimQueue(stream,actor,this.queueOwner,60000);if(!lease)return false;
   const O=auth(lease);
   if(lease.activeBatch)throw Error('当前尝试尚未结算，不能归档。');
   if(expectedBatchId!==undefined&&(lease.failedBatch?.batchId??null)!==expectedBatchId)throw Error('失败批次已变化，请重新核对后确认。');
   if(lease.failedBatch)await this.db.archiveFailedBatch(stream,actor,lease.failedBatch.batchId,{...O,operationId:id(),branchRevision:this.timeline.node.hash,reason:'player_archived_failed_attempt',confirmLegacy:true});
   let facts=await this.refreshQueue(stream,actor);
   const selected=anchorIds?facts.anchors.filter(h=>anchorIds.includes(h)):facts.anchors;
   if(!rebuildQueue&&selected.length)
    await this.db.retireQueueAnchors(stream,actor,selected,{...O,state:'explicitly_cancelled',reason:'player_cancelled_queue_sources',branchRevision:this.timeline.node.hash,operationId:id()});
   else if(rebuildQueue){await this.registerSources(actor,O);
    await this.db.patchQueueState(stream,actor,{status:'queued',errorKind:'manual_review',reason:'已归档并核对待办；请手动决定是否发送新批次'},O);}
  }finally{if(lease)await this.releaseOwned(stream,actor,auth(lease));}
  return true;
 }
 async analyze(actor,all=false,maxOverride=null,sourceFilter=null,retry=false,queueOpts={}){
  queueOpts||={};const s=this.settings();
  if(!s.enabled||!s.analysisEnabled)throw Error('请先在设置主动启用分析（每批是一次额外请求）。');
  if(this.generation?.busy||this.analyzer.busy||this.analysisLock||this.pending.size)throw Error('等待本轮生成、保存或上一次分析结束。');
  this.analysisLock=true;const initialEpoch=this.epoch,stream=this.timeline.stream?.id,room=this.capture?.room;
  this.activeQueue=stream+':'+actor;
  let lease=null,batchId=null,job=null;
  try{
   await this.queueWork;this.live(actor);
   const profile=this.analyzer.getProfile(),model=profile.model||(profile.kind==='st'?'st-current':''),contract=profile.contract||'full';
   let facts=await this.refreshQueue(stream,actor),priorAttempt=null;
   if(retry){
    const failed=facts.queue.failedBatch;
    priorAttempt=failed?await this.db.readBatchAttempt(failed.batchId):null;
    if(!priorAttempt?.last?.finished||!priorAttempt.last.sent||priorAttempt.last.status==='committed')throw Error('只能显式重发曾失败或失效的当前同批。');
    if(queueOpts.retryBatchId&&queueOpts.retryBatchId!==failed.batchId||queueOpts.retryJobId&&queueOpts.retryJobId!==priorAttempt.manifest.lastJobId)throw Error('失败批次或尝试已变化，请重新核对后确认重发。');
    const frozen=priorAttempt.frozen;
    if(frozen.providerProfileId!==profile.id||frozen.modelId!==model||frozen.contractVersion!==contract)throw Error('当前配置档、模型或分析合同已变更，请恢复原配置或明确归档旧批重建。');
    const byId=this.live(actor).byId,rows=frozen.sourceIds.map(x=>byId.get(x));
    if(rows.some(x=>!x)||await sourceDigest(rows)!==frozen.sourceFingerprint)throw Error('原失败批次来源已被编辑、删除或撤回权限，无法直接重发旧批次。');
    if(priorAttempt.manifest.managed===7)await this.validateBatchSources(actor,facts,frozen);
   }else if(facts.queue.failedBatch||facts.queue.sent)throw Error('存在可能已计费的失败请求，必须手动确认同批重发，避免重复收费。');
   if(!queueOpts.automatic&&!queueOpts.queueTask&&!retry)facts=await this.admitManualSources(actor,sourceFilter);
   const rounds=all?Math.min(limit(maxOverride??s.analysisBudgetMaxRequests,1,12,2),limit(s.analysisBudgetMaxRequests,1,12,2)):1;
   for(let n=0;n<rounds;n++){
    if(initialEpoch!==this.epoch||!this.sameRoom(room))throw Error('发送前来源或设置已过时。');
    facts=await this.refreshQueue(stream,actor);
    if(!facts.anchors.length){this.say('当前角色没有待分析的新原文。');break;}
    lease=await this.db.claimQueue(stream,actor,this.queueOwner,(profile.timeout||45)*1000+15000);
    if(!lease)break;const O=auth(lease);
    if(lease.activeBatch)throw Error('队列存在未决预留或派发，请先核实。');
    if(!retry){await this.db.patchQueueState(stream,actor,{status:'preparing',errorKind:null,reason:'正在核对完整楼层来源'},O);facts=await this.registerSources(actor,O);}
    else {
     // Legacy adoption is explicit, and is possible only when its old job can actually be verified.
     if(priorAttempt.manifest.managed!==7){facts=await this.registerSources(actor,O);
      const owners=new Map(facts.mappings.flatMap(m=>m.sourceIds.map(x=>[x,m.anchorId])));
      await this.db.adoptLegacyFailure({...priorAttempt.frozen,anchorIds:[...new Set(priorAttempt.frozen.sourceIds.map(x=>owners.get(x)))]},{...O,confirmLegacy:true,previousJobId:priorAttempt.manifest.lastJobId,reason:'player_confirmed_legacy_retry'});
      priorAttempt=await this.db.readBatchAttempt(priorAttempt.manifest.batchId);
     }
     facts=await this.refreshQueue(stream,actor);
    }
    const owners=new Map(facts.mappings.filter(m=>facts.anchors.includes(m.anchorId)&&m.mappingComplete).flatMap(m=>m.sourceIds.map(x=>[x,m.anchorId])));
    const allowed=new Set([...owners.keys()].filter(x=>!facts.terminalSourceIds.includes(x)&&(!sourceFilter||sourceFilter.has(x))));
    const input=makeAnalysisInput({...this.options(actor),includeCard:profile.sendBaseline,maxInput:profile.input,contract:profile.contract,
     sourceFilter:allowed,exactSourceIds:retry?priorAttempt.frozen.sourceIds:null,latest:!!queueOpts.latest&&!retry});
    if(!input){
     // No visible input is not a successful analysis. Record an explicit local retirement instead of an empty ACK.
     const done=new Set([...(this.timeline.node.state.processed[actor]||[]),...facts.terminalSourceIds]);
     const alreadyDone=facts.mappings.filter(m=>facts.anchors.includes(m.anchorId)&&m.mappingComplete&&m.sourceIds.length&&m.sourceIds.every(x=>done.has(x))).map(m=>m.anchorId);
     if(alreadyDone.length&&!facts.queue.failedBatch)await this.db.retireQueueAnchors(stream,actor,alreadyDone,{...O,state:'stale_source',reason:'already_processed_before_queue_admission',branchRevision:this.timeline.node.hash,operationId:id()});
     this.say('当前角色没有可派发的新原文，未占用请求额度。');break;
    }
    const token=this.timeline.token(),actorAtStart=this.context().characters?.[this.context().characterId]?.avatar;
    const valid=()=>initialEpoch===this.epoch&&!this.disposed&&this.sameRoom(room)&&this.matchesLive()&&this.timeline.matching(token)&&!this.suspended&&this.settings().analysisEnabled&&this.settings().enabled&&!this.generation?.busy&&this.context().characters?.[this.context().characterId]?.avatar===actorAtStart;
    const sourceIds=input.fresh.map(x=>x.id),anchorIds=[...new Set(sourceIds.map(x=>owners.get(x)))];
    if(anchorIds.some(x=>!x))throw failure('SOURCE_MISMATCH','实际输入缺少责任映射。');
    const sourceFingerprint=await sourceDigest(input.fresh),payloadFingerprint=await this.analyzer.inputFingerprint(input,profile,{},priorAttempt?.frozen.payloadFingerprint);
    if(retry&&(payloadFingerprint!==priorAttempt.frozen.payloadFingerprint||sourceFingerprint!==priorAttempt.frozen.sourceFingerprint))throw Error('原失败批次的分析输入或配置已改变，请明确归档旧批后重建。');
    batchId=retry?priorAttempt.frozen.batchId:id();job=id();
    const frozen=retry?priorAttempt.frozen:{batchId,streamId:stream,actorId:actor,originalBranchHead:this.timeline.node.hash,originalRevision:this.timeline.node.revision,sourceIds,anchorIds,sourceFingerprint,payloadFingerprint,providerProfileId:profile.id,modelId:model,contractVersion:contract};
    const attempt=await this.db.readBatchAttempt(batchId),queue={...O,stream,actor,frozen,expectedAttemptNo:attempt?.manifest.attemptNo||0,previousJobId:attempt?.manifest.lastJobId||null,confirmResend:retry,dispatchHead:this.timeline.node.hash,dispatchRevision:this.timeline.node.revision};
    this.inflightBatches.add(batchId);input.origin=profile.kind;
    let response;
    try{
     response=await this.analyzer.send(input,profile,'analysis',actor,job,valid,{queue,onState:async()=>{await this.refreshQueue(stream,actor);}});
     if(!valid())throw Error('响应返回前分支或聊天已变化。');
     await this.validateBatchSources(actor,await this.db.readQueueFacts(stream,actor),frozen);
     await this.db.patchQueueState(stream,actor,{status:'validating',reason:'正在核验结构、出处和人物归因'},O);
     const live=this.live(actor),base=this.timeline.node.state,staged=stageAnalysis(base,response.text,input,live);
     const result=applyPolicy(base,staged.state,live,{mode:s.approval,baselineChecked:!!(profile.sendBaseline&&(input.actor.baseline||base.baselines?.[actor])),model:response.model,profile:profile.id,room,revision:token.seq});
     const consumedAnchors=await this.computeFullyAckedAnchors(actor,anchorIds,null,sourceIds);
     const applied=await this.enqueue(async()=>{
      if(!valid())return false;
      return this.timeline.commitAnalysis(()=>result.state,'剧情心理分析 · '+s.approval,token,valid,{...O,queueKey:'queue:'+stream+':'+actor,job,batchId,supersededJob:queue.previousJobId,consumedAnchors,consumedSourceIds:sourceIds,
       injectFault:queueOpts.injectCommitFault||null,resultMeta:{http:response.status,finish:response.finish,model:response.model,provider:response.provider,requestId:response.requestId,usage:response.usage,cost:response.cost,sent:true}});
     },true);
     if(!applied)throw Error('写入事务前证据已变化，结果未采用。');
     await this.refreshQueue(stream,actor);lease=null;
     const msg=staged.events===0&&staged.proposals===0?'已核对本批原文：无可信心理变化（已标记处理）':'已核对 '+staged.events+' 条事件候选；自动采用 '+result.adopted+' 项，待审 '+result.pending+' 项。';
     this.lastQueueState.set(actor,{status:'committed',reason:msg,at:Date.now(),batchId,ackedSources:sourceIds.length,ackedAnchors:consumedAnchors.length});
     this.mark();await this.prepare();this.say(msg);
    }catch(e){
     const record=await this.db.readBatchAttempt(batchId);
     if(record?.last?.key==='job:'+job&&record.last.sent&&!record.last.finished)
      await this.analyzer.finish(job,'未通过来源、结构或事务校验',response?{http:response.status,finish:response.finish,model:response.model,provider:response.provider,requestId:response.requestId,usage:response.usage,cost:response.cost}: {},queue);
     await this.refreshQueue(stream,actor);throw e;
    }finally{this.inflightBatches.delete(batchId);}
    if(retry)break;
   }
  }catch(e){
   if(stream){const facts=await this.refreshQueue(stream,actor);
    if(!facts.queue.activeBatch&&!facts.queue.failedBatch){
     if(lease){await this.releaseOwned(stream,actor,auth(lease));lease=null;}
     const status=e.queueState&&waiting.has(e.queueState)?e.queueState:/BUDGET|预算|上限|间隔/.test(e.code||e.message)?'waiting_budget':'waiting_host';
     await this.patchWaiting(stream,actor,{status,reason:e.sent?'结果需人工复核':String(e.message).slice(0,160),waitingDay:new Date().toISOString().slice(0,10),errorKind:e.sent?'manual_review':e.code||e.errorKind||null});
    }
   }
   throw e;
  }finally{try{if(lease)await this.releaseOwned(stream,actor,auth(lease));}finally{this.analysisLock=false;this.activeQueue=null;}}
 }
}
