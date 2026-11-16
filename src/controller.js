import {KEY,OLD_KEY,VERSION,id,clone,effective,visible,ooc,fingerprintMessage,deadline,hash,text} from './util.js';
import {Database} from './storage.js';import {Timeline,actors,chatOwner,messageActor} from './timeline.js';
import {knownMessages,diskChat,sameRows,permittedParts,USER} from './sources.js';
import {AnalysisService} from './service.js';
import {undoAdoption} from './growth.js';
import {QueueRuntime} from './queue-runtime.js';
import {estimateAnalysisCost,reviewEvent,decide,makeSummary} from './analysis.js';
import {buildIndex} from './retrieval.js';import {compose,legacyEnabled,arbitrateLegacyPlugin,sampleEmotionDirective} from './prompt.js';
import {computeStateDiff,detectWorldContext,active,inScope} from './model.js';
export const DEFAULTS=Object.freeze({enabled:true,inject:true,immediate:true,approval:'conservative',profiles:null,activeProfile:'main',reviewProfile:'',queueLimit:8,analysisEnabled:false,autoAnalyze:false,recoveryPopup:false,promptBudget:700,prepareTimeoutMs:900,analysisBudgetMaxRequests:2,analysisMaxTotalRequests:20,dailyLimit:3,sessionLimit:3,minTurns:9,batchSize:14,timeoutMs:45000,analysisRequestsUsed:0,analysisTokensUsed:0,useJsonSchema:false,conflictMode:'coexist',expressive:false,intensity:65,dark:35,unpredict:40,eventRate:20,userAccess:45,independent:true,memory:true,scope:'all',shareVariables:false,rerollNonce:0});
const snooze=ms=>new Promise(ok=>setTimeout(ok,ms)),types=new Set(['normal','swipe','regenerate','continue']);
const limit=(v,lo,hi,def)=>Number.isFinite(Number(v))?Math.max(lo,Math.min(hi,Math.floor(Number(v)))):def;
const currentRoom=c=>JSON.stringify([chatOwner(c),c.chatMetadata?.integrity||'']);
function newSession(){try{let s=sessionStorage.getItem(KEY);if(!s){s=id();sessionStorage.setItem(KEY,s);}return s;}catch{return id();}}
function speaker(c){const cast=actors(c);return cast.find(a=>a.id===c.characters?.[c.characterId]?.avatar)||(c.groupId==null&&cast.length===1?cast[0]:null);}
// Collected only after a disk-confirmed sync. Rendering must not tokenize or hash the history.
const flags=m=>!!(m?.extra?.tool_calls?.length||m?.extra?.tool_invocations?.length||m?.extra?.aborted||m?.extra?.error||m?.extra?.is_error||m?.extra?.isSmallSys);
const stamp=m=>[m?.mes,m?.name,m?.original_avatar,!!m?.is_user,!!m?.is_system,m?.swipe_id??0,m?.send_date??'',flags(m)];
const identical=(a,m)=>!!a&&!!m&&a[0]===m.mes&&a[1]===m.name&&a[2]===m.original_avatar&&a[3]===!!m.is_user&&a[4]===!!m.is_system&&a[5]===(m.swipe_id??0)&&a[6]===(m.send_date??'')&&a[7]===flags(m);
function sameWitness(w,chat,count){if(!w||!chat||w.length<count||chat.length<count)return false;for(let i=0;i<count;i++)if(!identical(w[i],chat[i]))return false;return true;}
export class Controller extends QueueRuntime{
 constructor(context,{db,update=()=>{},recovery=async()=>'cancel',readSaved=diskChat,delays=[250,700,1400]}={}){
 super();this.context=context;this.update=update;this.recovery=recovery;this.readSaved=readSaved;this.delays=delays;const c=context(),old=c.extensionSettings[OLD_KEY]||c.extensionSettings.lin_dynamic_persona||{};this.needsMigration=!!c.extensionSettings[OLD_KEY];
 if(!c.extensionSettings[KEY]){const preserved=Object.fromEntries(['promptBudget','intensity','dark','unpredict','eventRate','independent','memory','expressive','conflictMode'].filter(k=>old[k]!=null).map(k=>[k,old[k]]));c.extensionSettings[KEY]={...DEFAULTS,...preserved,approval:old.accountId?'manual':'conservative',analysisEnabled:false,autoAnalyze:false,accountId:old.accountId||id()};c.saveSettingsDebounced?.();}
 this.db=db||new Database(c.extensionSettings[KEY].accountId);this.timeline=new Timeline(this.db);this.analyzer=new AnalysisService(this);this.session=newSession();this.chain=Promise.resolve();this.views=new Map();this.listeners=[];this.epoch=0;this.roomEpoch=0;this.swipeCount=0;this.sessions=new Map();this.failedBatches=new Map();this.inflightBatches=new Set();this.staleSourceRecords=new Map();this.lastQueueState=new Map();this.pending=new Set();this.jobs=new Set();this.suspended=false;this.status='等待核对选中存档';this.lastPrompt='';this.excluded=new Set();this.trace=[];this.generation=null;this.pumpTask=Promise.resolve();}
 settings(){return {...DEFAULTS,...this.context().extensionSettings[KEY]};}
 say(msg){this.status=String(msg);this.trace.push(this.status);this.trace=this.trace.slice(-25);try{this.update(this);}catch{}}
 fail(e){this.clearPrompt();this.say('人格扩展已跳过：'+(e?.message||e));}
 enqueue(fn,isolated=false){const r=this.chain.then(()=>this.disposed?undefined:fn());this.chain=r.catch(e=>isolated?this.say('后台分析未提交：'+e.message):this.fail(e));return r;}
 task(p){this.jobs.add(p);p.catch(e=>{if(!this.disposed)this.say('后台任务已跳过：'+e.message);}).finally(()=>this.jobs.delete(p));}
 async idle(){for(let i=0;i<4;i++){await this.chain;await this.queueWork;await Promise.allSettled([...this.jobs]);await this.pumpTask;if(!this.jobs.size)break;}await this.chain;}
 clearPrompt(){try{this.context().setExtensionPrompt(KEY,'',0,0,false,0);}catch{}}
 cancel(){this.epoch++;this.analyzer.cancel();this.stopQueuePump();}
 changeSettings(patch){const c=this.context(),safe={};for(const k of Object.keys(DEFAULTS))if(k in patch)safe[k]=patch[k];const s={...this.settings(),...safe};if(!s.analysisEnabled)s.autoAnalyze=false;
 c.extensionSettings[KEY]=s;c.saveSettingsDebounced?.();this.cancel();this.clearPrompt();this.lastPrompt='';
 if(!s.enabled){this.generation=null;for(const p of this.pending)p.stopped=true;}else if(patch.enabled===true&&this.capture)this.task(this.enqueue(()=>this.sync()));
 if(['dailyLimit','sessionLimit','analysisMaxTotalRequests','analysisBudgetMaxRequests','minTurns','batchSize','activeProfile','analysisEnabled','autoAnalyze','enabled','cooldowns','queueLimit'].some(k=>k in patch))this.wakeWaitingQueues();
 this.say('设置已保存。');}
 resetApiUsage(){this.say('累计派发账本不清零；需要更多额度可手动提高硬上限。');}
 usageSummary(pid){return this.analyzer.usageSummary(pid);}
 arbitrationStatus(){return arbitrateLegacyPlugin(this.context(),this.settings());}
 rerollEmotion(){if(!this.arbitrationStatus().allowEmotionEngine){this.say('旧插件负责演出，本插件不重抽。');return;}this.changeSettings({rerollNonce:(this.settings().rerollNonce||0)+1});this.forceDraw=true;this.say('下次生成重抽；没有改动现有剧情或扣除寿命。');}
 snapshot(){const c=this.context();return {owner:chatOwner(c),metadata:clone(c.chatMetadata?.[KEY]||c.chatMetadata?.[OLD_KEY]),chat:c.chat||[],cast:actors(c),group:c.groupId!=null&&c.groupId!=='',userName:c.name1||'玩家',integrity:c.chatMetadata?.integrity||'',parentName:c.chatMetadata?.main_chat||'',room:currentRoom(c)};}
 async disk(){const ctrl=new AbortController(),tm=setTimeout(()=>ctrl.abort(),4000);try{return await this.readSaved(this.context(),ctrl.signal);}finally{clearTimeout(tm);}}
 sameRoom(r){return !this.disposed&&currentRoom(this.context())===r;}
 mark(){if(!this.capture||!this.sameRoom(this.capture.room)||this.suspended||!this.settings().enabled)return;const c=this.context(),ptr=this.timeline.pointer();if(c.chatMetadata&&ptr&&this.timeline.stream.seq&&JSON.stringify(c.chatMetadata[KEY])!==JSON.stringify(ptr)){c.chatMetadata[KEY]=ptr;c.saveMetadataDebounced?.();}}
 async sync({recovery=false,forcePopup=false,confirmed=null,force=false}={}){
 if(this.needsMigration){await this.db.migrate4();this.needsMigration=false;}const cap=this.snapshot();if(!cap.owner){this.capture=null;this.views.clear();this.clearPrompt();return;}
 const disk=confirmed||await this.disk();if(!this.sameRoom(cap.room))return;
 const live=this.context().chat||[],same=sameRows(disk,live,Math.min(disk.length,live.length));
 if(!same||disk.length>live.length||live.length-disk.length>1||live.length>disk.length&&!live.at(-1)?.is_user){this.suspended=true;this.views.clear();this.clearPrompt();this.say('酒馆选中历史与已存文件不一致。暂不注入；可在恢复面板重新核对。');return;}
 cap.chat=disk;cap.witness=live.slice(0,disk.length).map(stamp);const previous=this.capture?.room;const prior=this.timeline.node;const prevHead=this.timeline.path.at(-1)?.hash;
 const res=await this.timeline.sync({...cap,force});if(!this.sameRoom(cap.room))return;
 this.capture=cap;const unexplained=previous===cap.room&&prevHead&&!this.timeline.path.some(r=>r.hash===prevHead)&&!this.knownSelection;
 const checking=recovery||previous!==cap.room||unexplained||forcePopup;
 if(checking){this.suspended=!!(res.mismatch||unexplained);this.clearPrompt();
 if((this.suspended&&(this.settings().recoveryPopup&&!this.timeline.node.state.recoverySilent)||forcePopup)&&this.settings().enabled){
  const t=this.timeline.token(),head=this.timeline.node.hash,room=cap.room;
  const candidates=await this.timeline.listSnapshotsForStream();const diff=computeStateDiff(previous===room?prior?.state:undefined,this.timeline.node.state);
  // Never await a UI decision on the host generation event or in the mutation queue.
  const dialogTask=Promise.resolve(this.recovery({...res,diff,candidates,current:this.timeline.node,prior})).then(answer=>this.enqueue(async()=>{
   if(!this.sameRoom(room)||!this.timeline.matching(t)||this.timeline.node.hash!==head||!this.matchesLive())return;const action=answer?.action||answer;
   if(action==='cancel'||!action)return;
   if(action==='select_snapshot')await this.timeline.adopt(this.timeline.stream.id,answer.snapshotHash);
   else if(action==='restore'){if(res.revisionMismatch&&res.priorHead===head)await this.timeline.adopt(this.timeline.stream.id,head,res.priorRevision);
    else if(res.missing||!res.exact&&res.mismatch)throw Error('没有完全匹配的快照，请手动采用已核实的备份或选择重建。');}
   else if(action==='rebuild')await this.timeline.rebuild();else if(action==='disable')await this.timeline.update(s=>({...s,disabled:true}),'停用此聊天');else return;
   if(answer?.dontRemindGlobal)this.changeSettings({recoveryPopup:false});if(answer?.dontRemindChat)await this.timeline.update(s=>({...s,recoverySilent:true}),'今后不弹窗');
   this.suspended=false;this.mark();await this.prepare();await this.restoreQueues();this.say('已应用玩家选择的恢复操作。');}));this.task(dialogTask);
 }}
 this.knownSelection=false;await this.prepare();if(!this.suspended){this.mark();await this.restoreQueues();}this.say(this.suspended?'恢复未匹配：已暂停此聊天人格，酒馆照常。':'已核对存档 · 本地中文全文索引');return res;}
 queueSummary(actorId){
  const s=this.settings(),sid=this.timeline.stream?.id,key=sid&&actorId?sid+':'+actorId:null,q=key?this.sessions.get(key):null,last=actorId?this.lastQueueState.get(actorId):null;
  const min=limit(s.minTurns,2,100,9);
  if(!s.enabled)return {status:'disabled',label:'动态人格已停用',anchors:0,minTurns:min,backpressure:false,overflowCount:0};
  if(q&&(q.anchors?.size||q.failedBatch)){
   const n=q.anchors.size,st=q.status||'queued',bp=n>100||st==='waiting_capacity'||!!q.backpressure,ov=Math.max(0,n-100);
   const bpTag=bp?`［背压保护：共保留 ${n} 条锚点，等待分批处理］`:'';
   const labels={
    queued:(n<min?`等待积累本人有效回复（${n}/${min}）`:`已排队待发（${n} 条锚点）`)+bpTag,
    waiting_capacity:`背压等待并发槽位（保留 ${n} 条锚点，不丢弃）`,
    waiting_host:`等主生成或另一窗口完成（保留 ${n} 条锚点）`,
    waiting_budget:`等配额：${q.reason||'已达预算上限'}（保留 ${n} 条锚点）`,
    waiting_profile:`等配置授权或冷却：${q.reason||'配置暂不可用'}（保留 ${n} 条锚点）`,
    preparing:`正在准备分析输入（${n} 条锚点）`,
    reserved:`已预留额度，准备发送（${n} 条锚点）`,
    sending:`已登记派发意图，等待响应（${n} 条锚点）`,
    received:`已收到响应，准备校验`,
    validating:`正在校验原文引文与归因`,
    failed_retryable:`未发送失败（可恢复）：${q.reason||''}`,
    failed_requires_review:`派发结果未采用（可能已计费，需手动确认重发）：${q.reason||''}`,
    stale_branch:`分支已切换，过时结果已丢弃`,
    stale_source:`部分原来源已失效，待复核`,
    cancelled:`已取消自动派发（保留 ${n} 条锚点）`
   };
   return {status:st,label:labels[st]||q.reason||st,anchors:n,minTurns:min,sent:!!q.sent,lastJob:q.lastJob||null,failedBatch:q.failedBatch||null,backpressure:bp,overflowCount:ov,fencingToken:q.fencingToken||0};
  }
  if(!s.analysisEnabled)return {status:'local_only',label:'纯本地模式（额外模型请求关闭）',anchors:0,minTurns:min,backpressure:false,overflowCount:0};
  if(!s.autoAnalyze)return {status:last?.status||'manual_mode',label:last?.reason||'手动分析模式（自动排队关闭）',anchors:0,minTurns:min,backpressure:false,overflowCount:0};
  return {status:last?.status||'idle',label:last?.reason||`等待新回复（每满 ${min} 次本人有效回复触发）`,anchors:0,minTurns:min,backpressure:false,overflowCount:0};
 }
 // Visible-text partition only. It does not prove conservation; auditQueueState reads the independent ledger.
 auditSourceConservation(actorId){
  const sid=this.timeline.stream?.id,key=sid&&actorId?sid+':'+actorId:null,q=key?this.sessions.get(key):null;
  const view=this.views.get(actorId),allSources=view?.source||[],path=this.timeline.path;
  const processedSet=new Set(this.timeline.node?.state?.processed?.[actorId]||[]);
  const failedSet=new Set(q?.failedBatch?.sourceIds||[]);
  const inflightSet=new Set(q?.activeBatch?.sourceIds||[]);
  const allowNodes=new Set(q?.anchors||[]);
  for(const [i,r] of path.entries())if(allowNodes.has(r.hash)&&i>1&&this.capture?.chat?.[i-2]?.is_user)allowNodes.add(path[i-1].hash);
  const queuedIds=[],acknowledgedIds=[],inflightIds=[],failedRetainedIds=[],unqueuedIds=[];
  for(const s of allSources){
   if(processedSet.has(s.id))acknowledgedIds.push(s.id);
   else if(inflightSet.has(s.id))inflightIds.push(s.id);
   else if(failedSet.has(s.id))failedRetainedIds.push(s.id);
   else if(allowNodes.has(s.node))queuedIds.push(s.id);
   else unqueuedIds.push(s.id);
  }
  const staleAnchors=key?(this.staleSourceRecords.get(key)||[]):[];
  return {
   actorId,
   totalVisible:allSources.length,
   acknowledged:acknowledgedIds,
   inflight:inflightIds,
   failedRetained:failedRetainedIds,
   queued:queuedIds,
   unqueued:unqueuedIds,
   staleAnchors,
   partitionComplete:acknowledgedIds.length+inflightIds.length+failedRetainedIds.length+queuedIds.length+unqueuedIds.length===allSources.length
  };
 }
 matchesLive(allowUser=false){
 const c=this.capture;if(!c||!this.sameRoom(c.room))return false;const chat=this.context().chat;
 return (chat.length===c.chat.length||allowUser&&chat.length===c.chat.length+1&&chat.at(-1)?.is_user)&&sameWitness(c.witness,chat,c.chat.length);}
 async prepare(){const cap=this.capture,t=this.timeline;if(!cap||!this.sameRoom(cap.room))return;this.views=new Map();if(this.suspended||!this.settings().enabled)return;
 const old=this.previousViews,views=new Map(),cacheSame=this.termStream===t.stream.id;this.termStream=t.stream.id;
 if(!cacheSame){this.termCache=new Map((await this.db.all('terms',t.stream.id)).map(r=>[r.key,r]));}
 const excluded=new Set([...this.excluded,...[...t.map.values()].filter(n=>n.receipt?.ok===false).map(n=>n.hash)]);
 const alive=()=>this.sameRoom(cap.room)&&!this.disposed&&this.settings().enabled;
 for(const actor of cap.cast){if(!alive())return;const prev=cacheSame?old?.get(actor.id):null,perm=JSON.stringify([t.node.state.grants,t.node.state.presence,t.node.state.revokes,t.node.state.world?.groupVisibilityMode,[...excluded].sort()]);let n=0;
 if(prev?.perm===perm){const max=Math.min(prev.path.length,t.path.length)-1;while(n<max&&prev.path[n+1].hash===t.path[n+1].hash&&prev.raw[n]===cap.chat[n]?.mes)n++;}
 let storyBefore=true;if(n){for(let j=n-1;j>=0;j--)if(cap.chat[j]?.is_user){storyBefore=!ooc(cap.chat[j].mes);break;}}
 const source=[...(n?prev.source.filter(v=>v.index<n):[]),...knownMessages({...cap,state:t.node.state,path:t.path,actorId:actor.id,excluded,start:n,storyBefore})];const byId=new Map(source.map(v=>[v.id,v])),byFloor=new Map();for(const part of source){const row=byFloor.get(part.node)||[];row.push(part);byFloor.set(part.node,row);}const pre=t.stream.id+'|'+actor.id+'|';
 const cached={get:key=>this.termCache.get(pre+key)};const save=async rows=>{if(!alive())return;const prepared=rows.map(v=>({...v,key:pre+v.id,stream:t.stream.id}));await this.db.transaction(['terms'],'readwrite',tx=>{const st=tx.objectStore('terms');for(const v of prepared)st.put(v);});for(const v of prepared)this.termCache.set(v.key,v);};
 const index=await buildIndex(actor,t.node.state,source,{old:cacheSame?old?.get(actor.id)?.index:null,cached,save,alive});if(!index||!alive())return;views.set(actor.id,{index,source,byId,byFloor,actor,perm,path:t.path,raw:cap.chat.map(m=>m.mes),room:cap.room,head:t.node.hash});}
 if(alive()){this.views=views;this.previousViews=views;}
 }
 async refreshRetrieval(){const room=this.capture?.room,sid=this.timeline.stream?.id;if(!sid||!this.sameRoom(room))throw Error('请先打开有效存档。');const rows=await this.db.all('terms',sid);await this.db.transaction(['terms'],'readwrite',tx=>{const st=tx.objectStore('terms');for(const r of rows)st.delete(r.key);});this.termCache?.clear();this.previousViews=null;await this.prepare();this.say('已从当前角色获准的原文重建本地全文索引。');}
 bind(){const c=this.context(),bus=c.eventSource,names=c.eventTypes||c.event_types;const on=(n,fn)=>{if(!names?.[n])return;const cb=(...args)=>{if(!this.disposed)try{const r=fn(...args);r?.catch?.(e=>this.fail(e));}catch(e){this.fail(e);}};bus.on(names[n],cb);this.listeners.push([names[n],cb]);};
 on('GENERATION_STARTED',(kind='normal',opts={},dry=false)=>{if(dry)return;if(this.analyzer.busy&&kind==='quiet')return;this.cancel();this.clearPrompt();this.lastPrompt='';this.lastActor='';this.generation=null;
 if(!this.settings().enabled||!types.has(kind||'normal')||opts.quiet_prompt||opts.quietToLoud||opts.quietImage||opts.signal?.aborted)return;
 const ctx=this.context(),chat=ctx.chat||[];this.swipeCount=['swipe','regenerate'].includes(kind)?this.swipeCount+1:0;
 this.generation={kind:kind||'normal',busy:true,room:currentRoom(ctx),owner:chatOwner(ctx),seq:this.roomEpoch,signal:opts.signal,stopped:false,initialLength:chat.length,before:chat.at(-1)&&{...chat.at(-1)},previous:this.timeline.node};});
 on('GENERATION_ENDED',()=>{if(this.generation)this.generation.busy=false;this.clearPrompt();this.pumpAnalysis();});
 on('GENERATION_STOPPED',()=>{if(this.generation){this.generation.stopped=true;this.generation.busy=false;}this.cancel();this.clearPrompt();});
 for(const n of ['MESSAGE_RECEIVED','CHARACTER_MESSAGE_RENDERED'])on(n,(i,k)=>{this.received(i,k);});
 const schedule=(recovery,selection=false)=>{this.cancel();this.clearPrompt();this.lastPrompt='';if(selection){this.knownSelection=true;}
 clearTimeout(this.syncTimer);this.syncTimer=setTimeout(()=>this.task(this.enqueue(()=>this.sync({recovery,force:recovery}))),100);};
 on('CHAT_CHANGED',()=>{this.roomEpoch++;this.generation=null;this.views.clear();this.sessions.clear();this.previousViews=null;this.suspended=true;schedule(true);});
 for(const n of ['MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPE_DELETED','MESSAGE_SWIPED'])on(n,()=>{if(!this.generation?.busy)schedule(false,true);});
 on('MESSAGE_SENT',()=>{if(!this.generation?.busy)schedule(false);});on('APP_READY',()=>{if(!this.capture)schedule(true);});return this;}
 async intercept(chat,_contextSize,_abort,type){
 const g=this.generation,s=this.settings(),ctx=this.context(),ticket=this.epoch;if(!g?.busy||g.used||g.stopped||g.signal?.aborted||this.suspended||!s.enabled||!types.has(type||'normal')||g.kind!==(type||'normal')||!this.capture||!this.sameRoom(g.room))return;
 const a=speaker(ctx),view=a&&this.views.get(a.id);if(!view||view.room!==g.room||view.head!==this.timeline.node?.hash)return;
 const queriedModel=()=>ctx.getChatCompletionModel?.()||'';if(s.scope==='gemini4'&&!/gemini[-_ ]?4[-_ ]?(argon|carbon|hydrogen|hydrgon)(?:$|[^a-z])/i.test(queriedModel()))return;
 const live=ctx.chat||[],last=live.at(-1),replace=!last?.is_user&&['swipe','continue','regenerate'].includes(g.kind)&&live.length===g.initialLength;
 const index=live.length-(replace?1:0),old=this.capture.chat,depth=old.length;const prefixN=Math.min(index,depth);
 if(!sameWitness(this.capture.witness,live,prefixN)||index<depth-1||index>depth+1||index===depth+1&&!last?.is_user||index===depth-1&&(!['swipe','regenerate','continue'].includes(g.kind)||!effective(old.at(-1))))return;
 const lastU=live.findLast(m=>m.is_user&&!m.is_system);if(ooc(lastU?.mes))return;
 let state=index===depth-1?this.timeline.prior?.state:this.timeline.node.state;if(!state||state.disabled)return;
 g.used=true;g.actor=a;g.index=index;const witness=this.capture.witness,extra=index>depth?stamp(live[depth]):null;g.prefixOK=rows=>sameWitness(witness,rows,prefixN)&&(!extra||identical(extra,rows[depth]));g.previous=replace&&g.kind==='continue'?this.timeline.node:null;
 if(!s.inject)return;
 // A prefix view must not query the index belonging to the discarded final reply.
 const casting=arbitrateLegacyPlugin(ctx,s);if(!casting.allowPersona)return;
 const ix=index<depth?null:view.index;let lo=0,hi=view.source.length;while(lo<hi){const mid=(lo+hi)>>>1;if(view.source[mid].index<index)lo=mid+1;else hi=mid;}const ownRecent=view.source.slice(Math.max(0,lo-4),lo);
 const ui=lastU?live.lastIndexOf(lastU):-1,unode=ui>=0&&ui<depth?this.timeline.path[ui+1]?.hash:null;const userParts=!lastU?[]:unode?(view.byFloor.get(unode)||[]):permittedParts(lastU,a,this.capture.cast,state,'live',this.capture.group);const query=[...ownRecent.map(x=>x.text),...userParts.map(x=>x.text)].join(' ').slice(-1000);
 const recent=new Set(ownRecent.map(x=>x.node));const hits=ix?.search(query,{limit:7,before:index,skip:recent,aliases:state.aliases?.[a.id]||{}})||[];
 const seen=new Set(),memories=[];for(let h of hits){if(/目录|导航/.test(h.kind)){const src=h.sourceIds.map(k=>view.byId.get(k)).find(x=>x&&!x.hints.length&&!recent.has(x.node)&&!seen.has(x.node));if(!src)continue;h={id:h.id,kind:'导航命中的原文提及',text:src.text,index:src.index,nodes:[src.node]};}
 if(h.nodes?.some(n=>seen.has(n)))continue;for(const n of h.nodes||[])seen.add(n);memories.push(h);}
 const guardedChat=[...ownRecent.map(v=>({name:v.speaker,is_user:v.speakerId===USER,mes:v.text})),...userParts.map(v=>({name:v.speaker,is_user:true,mes:v.text}))];
 const userName=this.capture.userName;const world=detectWorldContext({chat:guardedChat,cast:this.capture.group?[a]:this.capture.cast,state,userName});
 const manual=state.world||{},bounded=!Number.isInteger(manual.untilFloor)||index<=manual.untilFloor;
 const people=new Set(bounded?manual.people||[]:[]);people.add(a.id);people.add(a.name);const previous=live[index-1];if(previous?.is_user&&userParts.length){people.add(USER);people.add(userName);}
 if(!previous?.is_user&&previous){const source=ownRecent.findLast(v=>v.index===index-1);if(source){people.add(source.speakerId);people.add(source.speaker);}}
 world.people=[...people];world.query=query;world.scene=bounded?manual.scene||'':'';world.scenes=world.scene?[world.scene]:[];world.relationships=bounded?manual.relationships||[]:[];world.behaviors=bounded?manual.behaviors||[]:[];
 const available=x=>!x.sourceKeys?.length||x.sourceKeys.every(k=>view.byId.has(k)&&view.byId.get(k).index<index);const rejected=state.influences.filter(x=>x.actorId===a.id&&!available(x)).map(x=>({key:x.id,why:'来源已撤销、不在当前分支或尚未发生'}));const safe={...state,variables:{[a.id]:(state.variables?.[a.id]||[]).filter(v=>(!v.session||v.session===this.session)&&(!v.home||v.area!=='chat'||v.home===this.timeline.stream.id)&&(!v.life||(state.turns[a.id]||0)-v.born<v.life)&&(v.area!=='relationship'||world.people.includes(v.target)))},influences:state.influences.filter(x=>x.actorId===a.id&&(!x.sourceKeys?.length||x.sourceKeys.every(k=>view.byId.has(k)&&view.byId.get(k).index<index)))};
 const seed=this.timeline.stream.id+':'+(this.timeline.path[index]?.hash||this.timeline.node.hash)+':'+a.id;
 const sample=casting.allowEmotionEngine&&g.kind!=='continue'?sampleEmotionDirective({actor:a,state:safe,settings:s,seed,swipeOffset:this.swipeCount,forceReroll:this.forceDraw,targetPerson:userParts.length?userName:''}):null;this.forceDraw=false;
 const report={};const result=await deadline(compose({actor:a,state:safe,memories,settings:{...s,expressive:!!sample},legacy:casting.legacyActive,persons:{[USER]:this.capture.userName,...Object.fromEntries(this.capture.cast.map(a=>[a.id,a.name])),...state.peopleRegistry?.[a.id]},world,chat:guardedChat,cast:[a],seed,sample,countTokens:ctx.getTokenCountAsync?.bind(ctx),report}),s.prepareTimeoutMs,'');
 report.skipped?.push(...rejected);if(ticket!==this.epoch||this.generation!==g||g.stopped||g.signal?.aborted||!this.sameRoom(g.room)||this.suspended||!this.settings().enabled||!g.prefixOK(this.context().chat))return;
 if(result){ctx.setExtensionPrompt(KEY,result,0,0,false,0);if(s.memory&&sample?.emotionCard&&report.included?.includes('draw')&&!sample.carryPhase.includes('延续'))g.carry={card:sample.emotionCard,carryRemaining:2,rerollNonce:s.rerollNonce};}
 this.lastPrompt=result;this.lastActor=a.id;this.diag={...report,turn:g.kind,room:g.owner,branch:this.timeline.node.hash,memories:memories.map(m=>m.id),mode:'本地全文 BM25',coop:casting.mode};this.say(result?'本轮已注入一段角色资料。':'本轮无可用资料或超出预算。');}
 received(i,kind='normal'){const g=this.generation,ctx=this.context(),m=ctx.chat?.[i];if(!g?.used||g.seen||g.index!==i||!m||!this.sameRoom(g.room)||!this.settings().enabled)return;
 if(!['normal','regenerate','swipe','continue','append','appendfinal'].includes(kind||'normal'))return;
 if((g.kind==='continue')!==['append','appendfinal','continue'].includes(kind))return;g.seen=true;
 const signature=fingerprintMessage(m),raw=String(m.mes||''),sp=ctx.streamingProcessor,scope=()=>this.sameRoom(g.room)&&g.seq===this.roomEpoch&&this.settings().enabled&&!this.suspended&&g.prefixOK(this.context().chat)&&fingerprintMessage(this.context().chat[i])===signature;
 const stopped=()=>g.stopped||g.signal?.aborted||(sp?.messageId===i&&(sp.isStopped||sp.abortController?.signal?.aborted||sp.toolCalls?.length))||!effective(m);
 this.pending.add(g);this.task((async()=>{try{for(const d of this.delays){if(d)await snooze(d);if(!scope())return;let disk;try{disk=await this.disk();}catch{continue;}if(!scope()||disk.length<=i||!sameRows(disk,this.context().chat,i+1))continue;
 await this.enqueue(async()=>{if(!scope())return;const cap=this.snapshot(),who=messageActor(m,cap.cast);if(who!==g.actor.id)return;
 const before=g.previous,continuing=g.kind==='continue';if(continuing&&(!g.before||!raw.startsWith(String(g.before.mes))||raw===g.before.mes))return;
 await this.timeline.sync({...cap,chat:disk.slice(0,i+1)});if(!scope())return;await this.timeline.confirm(i,who,!stopped(),{from:continuing?before:null,carry:g.carry});
 await this.sync({confirmed:disk});if(!stopped()&&scope()){const h=this.timeline.path[i+1]?.hash;await this.scheduleAnalysis(who,h);} });return;
 }if(scope())this.say('未核实酒馆已保存这条回复；未扣次数、未学习。');}finally{this.pending.delete(g);}})());}
 live(actorId){const view=this.views.get(actorId);if(!view||!this.matchesLive()||this.suspended)throw Error('当前历史/角色尚未核对，请稍后重试。');const persons={...this.timeline.node.state.peopleRegistry?.[actorId],...Object.fromEntries([[USER,this.capture.userName],...this.capture.cast.map(a=>[a.id,a.name])])};
 return {...view,actorId,persons,chat:this.context().chat,path:this.timeline.path,elapsed:es=>{const last=Math.max(...es.flatMap(e=>e.quotes.map(q=>q.index)));return this.timeline.path.slice(last+2).filter(r=>this.timeline.map.get(r.hash)?.receipt?.ok&&this.timeline.map.get(r.hash).receipt.actor===actorId).length;}};}
 async mutate(fn,label){this.cancel();this.clearPrompt();const cap=this.snapshot(),t=this.timeline.token();return this.enqueue(async()=>{if(!this.sameRoom(cap.room)||!this.timeline.matching(t)||!this.matchesLive()||this.suspended)throw Error('存档、角色或修订已变化；请重新打开面板。');await this.timeline.update(fn,label,t);this.mark();await this.prepare();this.say(label+'：已保存。');});}
 options(actorId){const v=this.live(actorId);return {actor:v.actor,known:v.source,state:this.timeline.node.state,index:v.index,batchSize:limit(this.settings().batchSize,2,24,14),cast:[...this.capture.cast,...Object.entries(this.timeline.node.state.peopleRegistry?.[actorId]||{}).map(([id,name])=>({id,name}))],userName:this.capture.userName};}
 estimatePendingAnalysis(a){try{return estimateAnalysisCost({...this.options(a),maxBatches:this.settings().analysisBudgetMaxRequests});}catch{return {pendingMessages:0,totalBatches:0,plannedBatches:0,estimatedTokens:0};}}
 async undoAuto(actor,entry){return this.mutate(s=>undoAdoption(s,actor,entry),'撤销自动采用并屏蔽同证据');}
 async evolveLocally(a){await this.refreshRetrieval(a);this.say('本地只建立文字索引；没有调用模型或新增人格。');}
 async reviewEvent(a,e,patch){return this.mutate(s=>reviewEvent(s,a,e,patch,this.live(a)),'审核事件归因');}
 async decide(a,p,d,o={}){return this.mutate(s=>decide(s,a,p,d,o,this.live(a)),'审核人格提案');}
 async summary(a,f){return this.mutate(s=>makeSummary(s,a,f,this.live(a)),'保存导航摘要');}
 async adopt(sid,h){const room=this.capture?.room;return this.enqueue(async()=>{if(!this.sameRoom(room)||!this.matchesLive())throw Error('聊天已变化。');await this.timeline.adopt(sid,h);this.suspended=false;this.mark();await this.prepare();this.say('已采用当前世界线可核实的快照。');});}
 async resumeRecovery(forcePopup=true){return this.enqueue(()=>this.sync({recovery:true,forcePopup,force:true}));}
 dispose(){this.disposed=true;this.roomEpoch++;this.cancel();clearTimeout(this.syncTimer);this.analyzer.clearSecrets();for(const p of this.pending)p.stopped=true;const bus=this.context().eventSource;for(const [k,f] of this.listeners)(bus.removeListener||bus.off)?.call(bus,k,f);this.clearPrompt();this.db.close();}
}
