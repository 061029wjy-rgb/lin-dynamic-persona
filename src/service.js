import {KEY,id,text,hash} from './util.js';
import {profile,routeFingerprint,safeUrl,buildAdapter,caps,publicFailure} from './providers.js';
import {SCHEMA} from './analysis.js';

const MAIN=()=>profile({id:'main',name:'酒馆当前模型',kind:'st',interval:0,allowSend:true,input:20000});
const checked=(p)=>{if(p.url)safeUrl(p.url,p.allowLAN||(p.kind==='ollama'&&p.transport!=='direct'));if(p.gateway)safeUrl(p.gateway,false);return p;};
const sum=v=>[...new TextEncoder().encode(v)].length;
const safeErr=(e,schemaRequested=false)=>e?.status?('HTTP '+e.status+' · '+(e.status===400&&schemaRequested?'参数、模型或结构化 Schema 不被接受（已为下次请求切回普通 JSON，本次不自动重发）':e.status>=400?publicFailure(e.status):'响应未完成、被过滤或结构无效')+(e.detail?.finish?' · '+String(e.detail.finish).slice(0,36):'')):/schema|structured/i.test(e?.message||'')?'不支持结构化 schema。':/超时|取消|过时|预算|重复收费|最短间隔|正在使用|正在处理|没有返回|JSON|STOP|空候选/.test(e?.message||'')?String(e.message).slice(0,100):'连接或模型请求失败，请检查地址、认证、CORS 和宿主连接。';
export class AnalysisService{
 constructor(c){this.c=c;this.memory=new Map();this.busy=false;this.logs=[];this.generation=0;}
 get profiles(){const a=this.c.settings().profiles;return Array.isArray(a)?a.map(v=>profile(v)):[MAIN()];}
 getProfile(id=this.c.settings().activeProfile||'main'){const p=this.profiles.find(x=>x.id===id);if(!p)throw Error('没有选定有效配置；不会借用其他模型。');return p;}
 save(v,secret={},imported=false,newConsent=false){const p=checked(profile(v)),prev=this.profiles.find(x=>x.id===p.id);if(!prev&&this.profiles.length>=24)throw Error('配置档上限为 24。');
 if(imported)p.allowSend=false;const fp=routeFingerprint(p);if(prev&&routeFingerprint(prev)!==fp){this.memory.delete(p.id);if(!newConsent)p.allowSend=false;}
 if(Object.keys(secret).length)this.memory.set(p.id,{fp,data:{...(this.memory.get(p.id)?.fp===fp?this.memory.get(p.id).data:{}),...Object.fromEntries(['key','header','gatewayKey'].filter(k=>typeof secret[k]==='string'&&secret[k]).map(k=>[k,secret[k]]))}});
 this.c.changeSettings({profiles:[...this.profiles.filter(x=>x.id!==p.id),p]});this.c.wakeWaitingQueues?.();return p;}
 drop(pid){this.memory.delete(pid);this.c.changeSettings({profiles:this.profiles.filter(x=>x.id!==pid),...(this.c.settings().activeProfile===pid?{activeProfile:'@none',autoAnalyze:false}:{} )});}
 clearSecrets(){this.memory.clear();}
 cancel(){this.generation++;this.wake?.();}
 requestOptions(input,p,opts={}){const requested=opts.json??(p.kind==='st'&&this.c.settings().useJsonSchema?'schema':p.json);
  const json=requested==='schema'&&!caps(p.kind).schema?'text':requested==='json'&&!caps(p.kind).json?'text':requested;
  return {requested,r:{system:input.systemPrompt,prompt:input.prompt,output:opts.output||p.output,json,schema:json==='schema'?(opts.schema||input.schema||SCHEMA):undefined}};}
 async inputFingerprint(input,p,opts={},previous=null){
  if(previous&&!previous.startsWith('request-v1:'))return hash(input.systemPrompt+'\n'+input.prompt);
  return 'request-v1:'+await hash(JSON.stringify([this.requestOptions(input,p,opts).r,routeFingerprint(p),p.kind==='st'?this.c.context().getChatCompletionModel?.()||'st-current':p.model]));
 }
 async finish(job,result,extra={},queue=null){
  if(queue){const {stream,actor,frozen,callerOwner,fencingToken}=queue;
   return this.c.db.failBatchAttempt(stream,actor,frozen.batchId,job,{callerOwner,fencingToken,reason:String(result).slice(0,220),resultMeta:extra});}
  const meta={};if(extra.status)meta.http=extra.status;for(const k of ['http','finish','model','provider','requestId','usage','cost','sent','status'])if(extra[k]!=null)meta[k]=extra[k];
  await this.c.db.finishJob(job,result,meta);
 }
 async send(input,p,kind,actor,job,valid,opts={}){
 const c=this.c,s=c.settings();if(!s.enabled||!s.analysisEnabled)throw Object.assign(Error('请先主动启用额外模型请求。'),{sent:false,queueState:'waiting_profile'});
 if((s.cooldowns?.[p.id]||0)>Date.now())throw Object.assign(Error('此配置刚被限流，冷却期间不发送。'),{sent:false,queueState:'waiting_budget'});
 if(this.busy||c.generation?.busy)throw Object.assign(Error('等待主生成或上一次分析结束。'),{sent:false,queueState:'waiting_host'});
 const memo=this.memory.get(p.id),secret=memo?.fp===routeFingerprint(p)?memo.data:{};
 let adapter,wire;
 const {requested,r}=this.requestOptions(input,p,opts),queue=opts.queue;
 const ceiling=sum(r.system+r.prompt);if(ceiling>p.input)throw Object.assign(Error('超出配置档单次输入硬上限，未发送。'),{sent:false,queueState:'waiting_budget'});
 try{adapter=buildAdapter(p,c.context(),{secrets:secret});wire=adapter.prepare(r);}catch(e){throw Object.assign(e,{sent:false,queueState:'waiting_profile'});}
 if(!valid())throw Object.assign(Error('发送前来源已过时。'),{sent:false,queueState:'stale_branch'});
 this.busy=true;const epoch=this.generation,ac=new AbortController();let sent=false,reserved=false,rawStarted=false,timer,meta={},log='已取消';const started=Date.now();
 try{const limits={total:s.analysisMaxTotalRequests,day:s.dailyLimit,session:s.sessionLimit,profileTotal:p.total,profileDay:p.daily,profileSession:p.sessionLimit,actorLimit:p.actorLimit,interval:p.interval,timeout:p.timeout,estimate:input.estimatedTokens||Math.ceil(ceiling/3)};
 const u=queue?(await c.db.reserveBatchAttempt(queue.frozen,{...queue,jobId:job,session:c.session,limits})).usage:
  await c.db.reserve(job,{...limits,profile:p.id,actor,kind,batchId:opts.batchId||null,attemptNo:opts.attemptNo||1},c.session);reserved=true;
 await opts.onState?.('reserved','已原子预留本次请求额度，尚未派发');
 if(!valid()||this.generation!==epoch)throw Object.assign(Error('请求未发送，证据已过时。'),{sent:false,queueState:'stale_branch'});
 const pref=c.context().extensionSettings[KEY];pref.analysisRequestsUsed=u.total;pref.analysisTokensUsed=u.estimate;c.context().saveSettingsDebounced?.();
 const halt=new Promise((_,no)=>{this.wake=()=>{ac.abort();no(Error('已取消采用；已发请求可能计费。'));};timer=setTimeout(()=>{ac.abort();no(Error('分析超时；不会自动重试。'));},p.timeout*1000);});halt.catch(()=>{});
 if(queue){const payloadFingerprint=await this.inputFingerprint(input,p,opts,queue.frozen.payloadFingerprint);
  if(ac.signal.aborted)throw Object.assign(Error('派发前分析超时或取消，未发送。'),{sent:false,queueState:'waiting_host'});
  if(!valid()||this.generation!==epoch)throw Object.assign(Error('派发前来源已过时。'),{sent:false,queueState:'waiting_host'});
  await c.db.markBatchAttemptSent(queue.stream,queue.actor,queue.frozen.batchId,job,input.fresh.map(x=>x.id),{callerOwner:queue.callerOwner,fencingToken:queue.fencingToken,payloadFingerprint});
 }else await c.db.markJobSent(job);
 sent=true;await opts.onState?.('sending','已登记派发意图，等待分析模型响应');
 rawStarted=true;const raw=Promise.resolve().then(()=>{if(ac.signal.aborted||!valid()||this.generation!==epoch)throw Error('派发标记后超时或取消，结果未知。');return adapter[kind==='test'?'testConnection':'analyze'](r,ac.signal,wire);});raw.finally(()=>{this.busy=false;}).catch(()=>{});
 const x=await Promise.race([raw,halt]);meta=x;if(!valid()||this.generation!==epoch)throw Object.assign(Error('结果已过时。'),{sent:true,queueState:'stale_branch'});log='已收到响应';
 if(queue)await c.db.patchQueueState(queue.stream,queue.actor,{status:'received',reason:'已收到响应，尚未提交人格'},{callerOwner:queue.callerOwner,fencingToken:queue.fencingToken});
 await opts.onState?.('received','已收到模型响应，正在校验结构与原文出处');return {...x,sent:true};
 }catch(e){if(!sent){const qState=e.queueState||(/预算|间隔|限流/.test(e.message||'')?'waiting_budget':/另一标签页|正在使用/.test(e.message||'')?'waiting_host':'failed_retryable');throw Object.assign(e,{sent:false,queueState:qState});}
 const rawMsg=String(e?.message||'');
 const errKind=e.status===429?'rate_limit':[401,402,403].includes(e.status)?'auth':/JSON|结构|schema/i.test(rawMsg)?'bad_json':/network|socket|fetch|ECONN|Failed to fetch|50\d/i.test(rawMsg)||e.status>=500?'network':'failed';
 meta={...e.detail,http:e.status||undefined,sent:true,status:'failed_requires_review',errorKind:errKind};log=safeErr(e,requested==='schema');
 if(e.status===429){const x=c.context().extensionSettings[KEY];x.cooldowns={...(x.cooldowns||{}),[p.id]:Date.now()+60000};c.context().saveSettingsDebounced?.();}if([401,402,403].includes(e.status)){const x=c.context().extensionSettings[KEY];x.profiles=this.profiles.map(q=>q.id===p.id?{...q,enabled:false}:q);c.context().saveSettingsDebounced?.();}
 if((e.status===400||/schema|structured|不支持结构/.test(log))&&requested==='schema'){const x=c.context().extensionSettings[KEY];if(p.kind==='st')x.useJsonSchema=false;x.profiles=this.profiles.map(q=>q.id===p.id?{...q,json:'text'}:q);c.context().saveSettingsDebounced?.();}
 if(queue){try{await this.finish(job,log,meta,queue);}catch(settle){
  // A superseded/expired lease cannot authorize a late failure write either. Recovery reads the ledger.
  if(!['LEASE_CONFLICT','FENCE_CONFLICT','ATTEMPT_CONFLICT'].includes(settle.code))throw settle;
 }}
 throw Object.assign(Error(log),{sent:true,status:e.status,errorKind:errKind,queueState:e.queueState||([401,402,403].includes(e.status)?'waiting_profile':'failed_requires_review')});
 }finally{clearTimeout(timer);this.wake=null;if(!rawStarted)this.busy=false;if(!sent){this.busy=false;if(reserved){if(queue)await c.db.releaseBatchReservation(queue.stream,queue.actor,queue.frozen.batchId,job,{callerOwner:queue.callerOwner,fencingToken:queue.fencingToken,reason:'not_dispatched'});else await c.db.releaseUnsent(job);}}
 else{if(!queue)await this.finish(job,log,meta);this.logs.push({at:started,profile:p.name,status:log,estimatedTokens:input.estimatedTokens,usage:meta.usage,cost:meta.cost,sent:true,kind});this.logs=this.logs.slice(-40);}}}
 async probe(pid){const p=this.getProfile(pid),job=id(),epoch=this.generation,valid=()=>epoch===this.generation;const r=await this.send({systemPrompt:'Return JSON only.',prompt:'Reply with {"ok":true}. No story is attached.'},p,'test','@test',job,valid,{output:48,json:p.json,schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}});
 try{if(JSON.parse(r.text).ok!==true)throw Error();}catch{await this.finish(job,'测试返回结构不符合预期',{sent:true,status:'failed_requires_review'});throw Error('已连接，但模型未返回约定测试结构；本次已计数。');}await this.finish(job,'无剧情连接测试通过',{...r,sent:true,status:'committed'});const {text:_,...meta}=r;return meta;}
 async usageSummary(pid=this.c.settings().activeProfile||'main'){
  const all=await this.c.db.all('usage'),s=this.c.settings(),day=new Date().toISOString().slice(0,10),p=this.profiles.find(x=>x.id===pid)||MAIN();
  const jobs=all.filter(x=>x.key?.startsWith('job:')).sort((a,b)=>b.at-a.at);
  const acct=all.find(x=>x.key==='account')||{total:0,estimate:0},dayRec=all.find(x=>x.key==='day:'+day)||{count:0},sessRec=all.find(x=>x.key==='session:'+this.c.session)||{count:0};
  const profRec=all.find(x=>x.key==='profile:'+pid)||{count:0},profDay=all.find(x=>x.key==='profile:'+pid+':'+day)||{count:0};
  let reportedInput=0,reportedOutput=0,unknownUsageCount=0,failedBilledCount=0,knownCost=0,sentIntentCount=0,reservedOnlyCount=0,releasedUnsentCount=0,legacyUnknownDispatchCount=0;
  for(const j of jobs){
   if(j.sent===false){if(j.finished)releasedUnsentCount++;else reservedOnlyCount++;continue;}
   if(j.sent!==true){legacyUnknownDispatchCount++;continue;}sentIntentCount++;
   if(j.usage&& (Number.isFinite(j.usage.input)||Number.isFinite(j.usage.output))){reportedInput+=j.usage.input||0;reportedOutput+=j.usage.output||0;}else unknownUsageCount++;
   if(j.sent!==false&&j.finished&&!['已提交','无剧情连接测试通过','沙盒已核对，无存档写入','第二意见 · 只读'].includes(j.result))failedBilledCount++;
   if(Number.isFinite(j.cost))knownCost+=j.cost;
  }
  const blockers=[];
  if((acct.total||0)>=(s.analysisMaxTotalRequests??Infinity))blockers.push('已达账户累计上限');
  if((dayRec.count||0)>=(s.dailyLimit??Infinity))blockers.push('已达账户每日上限（UTC）');
  if((sessRec.count||0)>=(s.sessionLimit??Infinity))blockers.push('已达本页会话上限');
  if((profRec.count||0)>=(p.total??Infinity))blockers.push('已达本配置档累计上限');
  if((profDay.count||0)>=(p.daily??Infinity))blockers.push('已达本配置档每日上限');
  if((s.cooldowns?.[pid]||0)>Date.now())blockers.push('429 限流冷却中');
  if(!p.enabled||!p.allowSend)blockers.push('当前配置档未启用或未授权');
  return {total:acct.total||0,totalRequests:acct.total||0,dailyRequests:dayRec.count||0,sessionRequests:sessRec.count||0,profileRequests:profRec.count||0,profileDailyRequests:profDay.count||0,estimatedInputTokens:acct.estimate||0,reportedInputTokens:reportedInput,reportedOutputTokens:reportedOutput,unknownUsageCount,failedBilledCount,failedPossibleBillCount:failedBilledCount,sentIntentCount,reservedOnlyCount,releasedUnsentCount,legacyUnknownDispatchCount,knownCost:+knownCost.toFixed(6),blockers,jobs:jobs.slice(0,35)};
 }
}
