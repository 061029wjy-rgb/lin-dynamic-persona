// Test-only transport. Used without changes inside each real browser tab and by the Node IDB fixture.
import { Database } from '../src/storage.js';
import { emptyState } from '../src/model.js';
const oldStores=['streams','nodes','journal','usage','terms','archives'];
export class QueueTestPeer {
 constructor(factory){this.factory=factory;this.clients=new Map();}
 async call(account,cmd,args=[]){
  let db=this.clients.get(account);if(!db){db=new Database(account,this.factory);this.clients.set(account,db);}
  if(cmd==='close'){db.close();this.clients.delete(account);return;}
  if(cmd==='specCommit'){
   const c=args[0],state=emptyState();state.processed[c.actor||'char']=c.processed;state.influences=c.influences||[];
   const s={key:'s',id:'s',owner:'room',seq:c.seq||0},n={stream:'s',key:'s:'+c.head,hash:c.head,revision:c.revision??1,history:[{state:{processed:{char:c.prior||[]}}}],state};
   return db.commitAnalysis(s,n,c.expected??-1,'测试提交',()=>c.guard!==false,{...c,injectFault:c.fault?(_tx,abort)=>abort(Object.assign(Error('injected after writes'),{code:'INJECTED'})):null});
  }
  if(cmd==='specReserve'){if(args[1].fault)args[1].injectFault=()=>{throw Object.assign(Error('injected during reservation'),{code:'INJECTED'});};return db.reserveBatchAttempt(...args);}
  if(cmd==='damage'){// Low-level fixture simulates old or corrupt on-disk bytes; never use this in the extension.
   const [action,k,v]=args;return db.transaction([action==='killBatch'?'usage':action==='dropMember'?'usage':'queueLedger'],'readwrite',tx=>{
    if(action==='killBatch'){tx.objectStore('usage').delete('batch:'+k);return;}
    if(action==='dropMember'){const st=tx.objectStore('usage'),r=st.get(k);r.onsuccess=()=>st.put({...r.result,anchors:r.result.anchors.filter(x=>x!==v)});return;}
    const st=tx.objectStore('queueLedger'),r=st.getAll();r.onsuccess=()=>{
     const x=r.result.find(x=>x.scope===k&&x.unit==='source'&&x.ref===v&&x.kind===(action==='doubleEnd'?'event':'item')&&(action!=='doubleEnd'||x.state==='committed'));
     if(action==='doubleEnd')st.put({...x,key:x.key+'COPY',operationId:x.operationId+'COPY'});else if(action==='wrongAnchor')st.put({...x,anchorId:'foreign'});else st.delete(x.key);
    };
   });
  }
  if(cmd==='seed5'){const usage=args[0],str={key:'s',id:'s',owner:'legacy',seq:1},j={key:'s:1',stream:'s',seq:1,anchor:'root'};
   return new Promise((ok,no)=>{const r=this.factory.open(db.name,5);r.onupgradeneeded=()=>{for(const k of oldStores){const st=r.result.createObjectStore(k,{keyPath:'key'});if(['nodes','terms','journal'].includes(k))st.createIndex?.('stream','stream');}};
    r.onerror=()=>no(r.error);r.onsuccess=()=>{const d=r.result,t=d.transaction(oldStores,'readwrite');for(const x of usage)t.objectStore('usage').put(x);t.objectStore('streams').put(str);t.objectStore('journal').put(j);t.oncomplete=()=>{d.close();ok();};t.onerror=()=>no(t.error);};});}
  if(cmd==='openOld'){return new Promise((ok,no)=>{const r=this.factory.open(db.name,5);r.onsuccess=()=>{r.result.close();ok(true);};r.onerror=()=>no(r.error);});}
  if(cmd==='restore5')return Database.restoreV6Rollback(account,args[0],this.factory);
  if(cmd==='read5'){return new Promise((ok,no)=>{const r=this.factory.open(db.name,5);r.onsuccess=()=>{const d=r.result,t=d.transaction(oldStores,'readonly'),out={};for(const k of oldStores){const g=t.objectStore(k).getAll();g.onsuccess=()=>out[k]=g.result;}t.oncomplete=()=>{d.close();ok(out);};};r.onerror=()=>no(r.error);});}
  return db[cmd](...args);
 }
}
