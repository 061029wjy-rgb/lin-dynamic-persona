import {LEGACY_VERSIONS,clone,id} from './util.js';
import {validateState,migrateState} from './model.js';
import { QueueDatabase, QueueError, atomic, reserveQuota, refund, freeProfile, installLedgerUpgrade, LAYOUT, LEDGER, ROLLBACK } from './queue-ledger.js';
const stores=['streams','nodes','journal','usage','terms','archives'];
const anchor=s=>s==='root'||typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
export const QUEUE_STATES=Object.freeze([
 'queued','waiting_host','waiting_profile','waiting_budget','waiting_capacity',
 'preparing','reserved','sending','received','validating','committed',
 'failed_retryable','failed_requires_review','stale_branch','stale_source','cancelled'
]);
export class Database extends QueueDatabase{
 constructor(accountId,factory=globalThis.indexedDB){super();this.account=accountId;this.name='lin-dynamic-persona-v5-'+accountId;this.indexedDB=factory;}
 async open(){if(this.db)return this;if(this.opening)return this.opening;if(!this.indexedDB)throw Error('浏览器不支持独立人格数据库。');
  this.opening=new Promise((resolve,reject)=>{let blocked=false;const r=this.indexedDB.open(this.name,LAYOUT);
   r.onupgradeneeded=()=>{if(blocked){r.transaction?.abort();return;}const db=r.result,hadV5=db.objectStoreNames.contains('usage');
    for(const name of stores){if(!db.objectStoreNames.contains(name)){const st=db.createObjectStore(name,{keyPath:'key'});if(['nodes','journal','terms'].includes(name))st.createIndex?.('stream','stream');}}
    if(!db.objectStoreNames.contains(LEDGER))installLedgerUpgrade(db,r.transaction||db.transaction(stores,'readonly'),stores,hadV5);};
   r.onsuccess=()=>{if(blocked){r.result.close();return;}this.db=r.result;this.db.onversionchange=()=>this.close();resolve(this);};
   r.onblocked=()=>{blocked=true;reject(new QueueError('UPGRADE_BLOCKED','请关闭账户的旧插件标签页再迁移。'));};
   r.onerror=()=>reject(r.error||Error('无法打开人格数据库。'));
  }).finally(()=>{this.opening=null;});return this.opening;}
 close(){this.db?.close();this.db=null;}
 async transaction(names,mode,fn){await this.open();return new Promise((ok,no)=>{const tx=this.db.transaction(names,mode);let why;tx.oncomplete=()=>ok();tx.onabort=tx.onerror=()=>no(why||tx.error||Error('版本已变化，未覆盖另一页数据。'));try{fn(tx,e=>{why=e;tx.abort();});}catch(e){why=e;tx.abort();}});}
 async get(s,k){let v;await this.transaction([s],'readonly',tx=>{const r=tx.objectStore(s).get(k);r.onsuccess=()=>{v=r.result;};});return v;}
 async all(s,stream){let rows;await this.transaction([s],'readonly',tx=>{const t=tx.objectStore(s),r=stream&&typeof t.index==='function'?t.index('stream').getAll(stream):t.getAll();r.onsuccess=()=>{rows=stream?r.result.filter(x=>x.stream===stream):r.result;};});return rows;}
 async put(s,v){guardRawWrite(s,v.key);return this.transaction([s],'readwrite',tx=>tx.objectStore(s).put(v));}
 async remove(s,k){guardRawWrite(s,k);return this.transaction([s],'readwrite',tx=>tx.objectStore(s).delete(k));}
 async exportV6Rollback(){const rows=await this.all(ROLLBACK),meta=rows.find(x=>x.key==='meta');if(!meta)return null;
  return {...meta,account:this.account,tables:Object.fromEntries(stores.map(s=>[s,rows.filter(x=>x.store===s).map(x=>x.row)]))};}
 // Import the exact pre-upgrade image only into a fresh, separate browser profile/DB.
 static async restoreV6Rollback(account,pack,factory=globalThis.indexedDB){
  if(pack?.account!==account||pack.format!=='lin-persona-v6-rollback'||pack.layout!==5||stores.some(s=>!Array.isArray(pack.tables?.[s])))throw new QueueError('BAD_BACKUP','账户或旧库存档不匹配。');
  const name='lin-dynamic-persona-v5-'+account;return new Promise((ok,no)=>{let fresh=false,why;const r=factory.open(name,5);
   r.onupgradeneeded=e=>{if(e.oldVersion!==0){why=new QueueError('DEST_NOT_EMPTY','不会覆盖原有数据库。');r.transaction.abort();return;}fresh=true;
    try{for(const s of stores){const st=r.result.createObjectStore(s,{keyPath:'key'});if(['nodes','journal','terms'].includes(s))st.createIndex('stream','stream');for(const row of pack.tables[s])st.add(row);}}catch(err){why=err;r.transaction.abort();}};
   r.onsuccess=()=>{r.result.close();if(fresh)ok(name);else no(new QueueError('DEST_NOT_EMPTY','不会覆盖原有数据库。'));};r.onerror=()=>no(why||r.error);r.onblocked=()=>no(new QueueError('UPGRADE_BLOCKED','目标数据库正在使用。'));});}
 async commit(stream,node,expected=-1,label='变更',guard){
 const rev=stream.seq||0,next={...stream,seq:rev+1,updatedAt:Date.now(),head:node.hash},updated={...node,seq:next.seq},log={key:stream.id+':'+next.seq,stream:stream.id,seq:next.seq,anchor:node.hash,at:Date.now(),label,nodeRevision:node.revision};
 await this.transaction(['streams','nodes','journal'],'readwrite',(tx,abort)=>{const w=tx.objectStore('streams'),n=tx.objectStore('nodes'),s=w.get(stream.id);s.onsuccess=()=>{if((s.result?.seq||0)!==rev){abort(Error('另一窗口已改变存档，未覆盖。'));return;}const r=n.get(node.key);r.onsuccess=()=>{if(guard&&!guard())return abort(Error('证据在写入事务前已变化。'));if((r.result?.revision??-1)!==expected){abort(Error('该楼人格已被修改，未覆盖。'));return;}n.put(updated);w.put(next);tx.objectStore('journal').put(log);};};});return {stream:next,node:updated};}
 async commitAnalysis(stream,node,expected=-1,label='剧情心理分析',guard,opts={}){
  if(opts.queueKey!=null)return this.commitQueuedAnalysis(stream,node,expected,label,guard,opts);
  const {job,supersededJob,batchId,consumedSourceIds=[],injectFault,resultMeta={}}=opts;
  // Pure manual analysis has no queue ACK authority. Managed jobs cannot fall back to this path.
  return atomic(this,['streams','nodes','journal','usage'],'readwrite',function*(tx){const u=tx.objectStore('usage'),w=tx.objectStore('streams'),n=tx.objectStore('nodes');
   const s=yield w.get(stream.id),cur=yield n.get(node.key);if((s?.seq||0)!==(stream.seq||0)||(cur?.revision??-1)!==expected)throw Error('另一窗口已改变存档，未覆盖。');
   const b=batchId?yield u.get('batch:'+batchId):null,j=job?yield u.get('job:'+job):null,prev=supersededJob?yield u.get('job:'+supersededJob):null;
   if([b,j,prev].some(r=>r?.managed===7))throw new QueueError('LEASE_REQUIRED','队列批次不能省略 queueKey 和租约。');
   if(j?.result==='已提交'||b?.status==='committed')throw Error('该批次已提交，拒绝重复写入。');
   if(guard&&!guard())throw Error('证据在写入事务前已变化。');
   const at=Date.now(),seq=(stream.seq||0)+1,next={...stream,seq,updatedAt:at,head:node.hash},updated={...node,seq};
   n.put(updated);w.put(next);tx.objectStore('journal').put({key:stream.id+':'+seq,stream:stream.id,seq,anchor:node.hash,at,label,nodeRevision:node.revision});
   if(batchId)u.put({...b,key:'batch:'+batchId,batchId,status:'committed',lastJobId:job||b?.lastJobId||null,committedAt:at,committedSourceIds:consumedSourceIds});
   if(j){u.put({...j,...resultMeta,key:j.key,managed:j.managed,status:'committed',result:'已提交',committedSourceIds:consumedSourceIds,finished:true,finishedAt:at});yield* freeProfile(u,j);}
   if(prev)u.put({...prev,supersededBy:job,status:'superseded',result:'已由重发提交'});
   if(injectFault)injectFault(tx,e=>{throw e;});return {stream:next,node:updated};
  });
 }
 async saveBatchManifest(m){
  if(!m?.batchId)throw Error('缺少批次标识 batchId。');
  return atomic(this,['usage'],'readwrite',function*(tx){const u=tx.objectStore('usage'),k='batch:'+m.batchId,old=yield u.get(k);
   if(old?.managed===7||m.managed===7||old?.status==='committed')throw new QueueError('PROTECTED_BATCH','不得覆盖受保护或已提交的批次。');
   const queue=m.streamId&&m.actorId?yield u.get('queue:'+m.streamId+':'+m.actorId):null;
   if(queue&&(queue.anchors?.length||queue.activeBatch||queue.failedBatch))throw new QueueError('MANAGED_ATTEMPT_REQUIRED','有来源责任的队列不能通过旧快照声明批次或尝试。');
   if(old&&['batchId','streamId','actorId','originalBranchHead','originalRevision','sourceIds','anchorIds','sourceFingerprint','payloadFingerprint','providerProfileId','modelId','contractVersion'].some(k=>JSON.stringify(old[k])!==JSON.stringify(m[k])))throw new QueueError('MANIFEST_CONFLICT','不能修改冻结批次。');
   const j=m.lastJobId?yield u.get('job:'+m.lastJobId):null;
   if(!j||j.batchId!==m.batchId){if(old)return old;const draft={...clone(m),key:k,status:'prepared',sent:false,lastJobId:null,attemptNo:0,jobHistory:[],updatedAt:Date.now()};u.put(draft);return draft;}
   const val={...clone(m),key:k,lastJobId:j&&j.batchId===m.batchId?m.lastJobId:old?.lastJobId||null,attemptNo:j?.attemptNo||old?.attemptNo||0,jobHistory:[...new Set([...(old?.jobHistory||[]),...(j&&j.batchId===m.batchId?[m.lastJobId]:[])])],updatedAt:Date.now()};
   u.put(val);return val;});
 }
 async export(){let streams,nodes,journal;await this.transaction(['streams','nodes','journal'],'readonly',tx=>{for(const [k,save] of [['streams',v=>streams=v],['nodes',v=>nodes=v],['journal',v=>journal=v]]){const q=tx.objectStore(k).getAll();q.onsuccess=()=>save(q.result);}});return {format:'lin-dynamic-persona',version:5,exportedAt:new Date().toISOString(),streams,nodes,journal};}
 async delta(streamId,base){const b=await this.export(),s=b.streams.find(x=>x.id===streamId);if(!s||!Number.isSafeInteger(base)||base<0||base>s.seq)throw Error('起始修订无效。');return {...b,delta:{base,through:s.seq,stream:streamId},streams:[s],nodes:b.nodes.filter(x=>x.stream===s.id&&x.seq>base),journal:b.journal.filter(x=>x.stream===s.id&&x.seq>base)};}
 async import(data){const pack=clone(data);validateBackup(pack);if(pack.delta)return this.importDelta(pack);const mapping=new Map(pack.streams.map(s=>[s.id,id()]));
 const streams=pack.streams.map(s=>({...s,key:mapping.get(s.id),id:mapping.get(s.id),owner:'import:'+mapping.get(s.id),importedOwner:s.importedOwner||s.owner,originId:s.originId||s.id,imported:true,legacy:pack.version<4||s.legacy,seq:s.seq||0}));
 await this.transaction(['streams','nodes','journal'],'readwrite',tx=>{for(const s of streams)tx.objectStore('streams').put(s);for(const n of pack.nodes){const stream=mapping.get(n.stream);tx.objectStore('nodes').put({...n,stream,key:stream+':'+n.hash});}for(const j of pack.journal||[]){const stream=mapping.get(j.stream);tx.objectStore('journal').put({...j,stream,key:stream+':'+j.seq});}});return streams;}
 async importDelta(p){const d=p.delta, [origin]=p.streams;if(!origin||origin.id!==d.stream||origin.seq!==d.through||d.base>d.through||d.base<0||!Number.isSafeInteger(d.base)||p.streams.length!==1||p.nodes.some(n=>n.seq<=d.base||n.seq>d.through))throw Error('增量范围无效。');
 const sources=(await this.all('streams')).filter(s=>s.imported&&s.originId===d.stream&&s.seq===d.base);if(sources.length!==1)throw Error('请先导入对应起始版本的完整备份；不能覆写活动世界。');const src=sources[0];
 await this.transaction(['streams','nodes','journal'],'readwrite',(tx,abort)=>{const w=tx.objectStore('streams'),r=w.get(src.id);r.onsuccess=()=>{if(r.result?.seq!==d.base)return abort(Error('增量版本冲突。'));for(const n of p.nodes)tx.objectStore('nodes').put({...n,stream:src.id,key:src.id+':'+n.hash});for(const j of p.journal||[])tx.objectStore('journal').put({...j,stream:src.id,key:src.id+':'+j.seq});w.put({...src,head:origin.head,seq:d.through});};});return [src];}
 async reserve(job,lim,session){return atomic(this,['usage'],'readwrite',function*(tx){const u=tx.objectStore('usage');
  if(lim.batchId){const b=yield u.get('batch:'+lim.batchId);if(!b||b.managed===7||b?.streamId&&b.actorId&&(yield u.get('queue:'+b.streamId+':'+b.actorId))?.anchors?.length)throw new QueueError('MANAGED_ATTEMPT_REQUIRED','自动队列须先接入阶段 B 的原子预留；没有派发。');}
  return (yield* reserveQuota(u,job,lim,session)).usage;});}
 async markJobSent(job){return atomic(this,['usage'],'readwrite',function*(tx){const u=tx.objectStore('usage'),j=yield u.get('job:'+job);if(j?.managed===7)throw new QueueError('LEASE_REQUIRED','请使用 markBatchAttemptSent。');if(j&&!j.finished)u.put({...j,sent:true,sentAt:Date.now(),status:'sending',result:'已派发'});});}
 async releaseUnsent(job){return atomic(this,['usage'],'readwrite',function*(tx){const u=tx.objectStore('usage'),j=yield u.get('job:'+job);if(j?.managed===7)throw new QueueError('LEASE_REQUIRED','请使用 releaseBatchReservation。');if(!j||j.finished||j.sent||!j.keys)return;yield* refund(u,j);u.delete(j.key);});}
 async finishJob(job,result,meta={}){return atomic(this,['usage'],'readwrite',function*(tx){const u=tx.objectStore('usage'),j=yield u.get('job:'+job);if(!j)return;if(j.managed===7)throw new QueueError('LEASE_REQUIRED','队列尝试只能通过事务确认或记录失败。');
  u.put({...j,...meta,key:j.key,managed:j.managed,result,finished:true,finishedAt:Date.now()});yield* freeProfile(u,j);});}
 async migrate4(){
 if(await this.get('archives','migration4'))return;const name='lin-dynamic-persona-v4-'+this.account;
 const exists=this.indexedDB.databases?await this.indexedDB.databases():null;if(exists&&!exists.some(x=>x.name===name))return;
 const old=await new Promise((ok,no)=>{const q=this.indexedDB.open(name);let missing=false;q.onupgradeneeded=()=>{missing=true;q.transaction?.abort();};q.onerror=()=>missing?ok(null):no(Error('旧库无法只读打开；未迁移。'));q.onsuccess=()=>ok(q.result);});if(!old)return;
 let pack;try{pack=await new Promise((ok,no)=>{const keys=['streams','nodes','journal','usage'],tx=old.transaction(keys,'readonly'),o={format:'lin-dynamic-persona',version:4,exportedAt:new Date().toISOString()};for(const k of keys){const q=tx.objectStore(k).getAll();q.onsuccess=()=>o[k]=q.result;}tx.oncomplete=()=>ok(o);tx.onabort=tx.onerror=()=>no(Error('旧库快照读取失败。'));});}finally{old.close();}
 validateBackup(pack);const upgraded=structuredClone(pack.nodes);const guard=st=>{for(const x of st?.influences||[])if(x.managedBy!=='user'&&!x.frozen&&(x.reviewState!=='approved'||!x.sourceKeys?.length))x.reviewState='review';};for(const n of upgraded){guard(n.state);for(const h of n.history)guard(h.state);}
 const usage=pack.usage.map(u=>({key:u.key,...Object.fromEntries(['total','daily','estimate','at','count','day','finished'].filter(k=>u[k]!=null).map(k=>[k,u[k]]))}));delete pack.usage;
 await this.transaction(['archives','streams','nodes','journal','usage'],'readwrite',(tx,abort)=>{const ar=tx.objectStore('archives'),r=ar.get('migration4');r.onsuccess=()=>{if(r.result)return;const count=tx.objectStore('streams').getAll();count.onsuccess=()=>{if(count.result.length)return abort(Error('v5 已有独立数据；请从旧版导出后合并备份。'));ar.put({key:'migration4',pack,usage});for(const [k,rows]of [['streams',pack.streams],['nodes',upgraded],['journal',pack.journal],['usage',usage]])for(const v of rows)tx.objectStore(k).put(v);
 const acct=usage.find(x=>x.key==='account');if(acct?.day)tx.objectStore('usage').put({key:'day:'+acct.day,count:acct.daily||0});};};});}
 async legacyBackup(){const known=this.indexedDB.databases?await this.indexedDB.databases():null;const name='lin-dynamic-persona-v1-'+this.account;if(known&&!known.some(x=>x.name===name))throw Error('本浏览器找不到旧库，请使用 0.3 的 JSON 导出。');
 const db=await new Promise((ok,no)=>{const q=this.indexedDB.open(name);q.onupgradeneeded=()=>{q.transaction?.abort();};q.onerror=()=>no(Error('未找到可只读访问的旧库。'));q.onsuccess=()=>ok(q.result);});try{return await new Promise((ok,no)=>{const t=db.transaction(['streams','nodes'],'readonly'),b={format:'lin-dynamic-persona',version:3,exportedAt:new Date().toISOString()};for(const n of ['streams','nodes']){const r=t.objectStore(n).getAll();r.onsuccess=()=>b[n]=r.result;}t.oncomplete=()=>ok(b);t.onabort=t.onerror=()=>no(t.error);});}finally{db.close();}}
}
function guardRawWrite(store,k){if(store===LEDGER||store===ROLLBACK||store==='usage'&&/^(queue|batch|job):/.test(k))throw new QueueError('PROTECTED_WRITE','禁止直接改写队列、派发记录、责任账本与迁移快照。');}
export function validateBackup(p){
 if(p?.format!=='lin-dynamic-persona'||!LEGACY_VERSIONS.includes(p.version)||!Array.isArray(p.streams)||!Array.isArray(p.nodes)||p.nodes.length>100000)throw Error('备份格式或版本不正确。');
 if((p.journal&&!Array.isArray(p.journal))||p.streams.length>12000)throw Error('备份表格式无效。');
 if(p.delta){const d=p.delta,js=(p.journal||[]).map(j=>j.seq).sort((a,b)=>a-b);if(!Number.isSafeInteger(d.through)||js.length!==d.through-d.base||js.some((v,i)=>v!==d.base+i+1))throw Error('增量日志不完整。');}
 const ids=new Set();for(const s of p.streams){if(!s.id||s.key!==s.id||typeof s.owner!=='string'||ids.has(s.id))throw Error('重复或非法的世界。');ids.add(s.id);}
 const keys=new Set();for(const n of p.nodes){if(!ids.has(n.stream)||n.key!==n.stream+':'+n.hash||!anchor(n.hash)||keys.has(n.key)||n.parent!=null&&!anchor(n.parent)||!Number.isSafeInteger(n.revision)||n.revision<0)throw Error('分支索引无效。');keys.add(n.key);
 if(n.state)validateState(n.state);else if(p.version<4||!n.receipt)throw Error('缺失人格存档。');if(!Array.isArray(n.history))throw Error('缺少修订历史。');for(const h of n.history)validateState(h.state);}
 for(const j of p.journal||[])if(!ids.has(j.stream)||!anchor(j.anchor)||!Number.isSafeInteger(j.seq)||j.seq<1)throw Error('无效的修订日志。');
 return p;
}
