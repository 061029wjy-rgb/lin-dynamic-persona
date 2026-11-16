import test from 'node:test';
import {IDBFactory} from './shims/indexeddb.js';
import {QueueTestPeer} from './queue-driver.js';
import {cases} from './queue-cases.mjs';
for(const [i,[name,run]] of cases.entries())test(name,async()=>{
 const factory=new IDBFactory(),peers=Array.from({length:10},()=>new QueueTestPeer(factory)),account='fixture-'+i;
 const route=(p,k)=>(cmd,...args)=>p.call(k,cmd,args);
 await run({peers:peers.map(p=>route(p,account)),fork:k=>route(peers[0],account+k),forkAccount:k=>account+k,native:false});
});
