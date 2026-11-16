// Run from repository root: node tests/browser/queue-storage.cjs (Playwright + system Chromium).
// Only serves local ES modules on loopback. Ten actual same-origin tabs use the browser's native IndexedDB.
const {createServer}=require('node:http'),{readFile}=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{const root=process.cwd(),http=createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://localhost');if(url.pathname==='/'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>IndexedDB local QA</title>');return;}
 const old=url.pathname.startsWith('/v06/')&&process.env.LDP_V6_SOURCE,base=old?path.resolve(process.env.LDP_V6_SOURCE):root;
 const f=path.resolve(base,'.'+decodeURIComponent(old?url.pathname.slice(4):url.pathname));if(!f.startsWith(base+path.sep)||!f.endsWith('.js'))throw Error();
 const b=await readFile(f);res.writeHead(200,{'content-type':'text/javascript'});res.end(b);
 }catch{res.writeHead(404);res.end();}});await new Promise(ok=>http.listen(0,'127.0.0.1',ok));
 let browser,ok=0,failed=0;
 try{browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 const {cases}=await import('../queue-cases.mjs');const ctx=await browser.newContext();const url='http://127.0.0.1:'+http.address().port;
 const pages=await Promise.all(Array.from({length:10},async()=>{const p=await ctx.newPage();await p.goto(url);await p.evaluate(async()=>{const {QueueTestPeer}=await import('/tests/queue-driver.js');globalThis.peer=new QueueTestPeer(indexedDB);});return p;}));
 console.log('Chromium '+browser.version()+' | native IndexedDB | '+pages.length+' same-origin pages | loopback only');
 if(process.env.LDP_V6_SOURCE){
  for(const p of pages.slice(0,2))await p.evaluate(async()=>{const {Database}=await import('/v06/src/storage.js');globalThis.oldDB=new Database('negative-control');});
  const x=await pages[0].evaluate(async()=>{await oldDB.appendQueueAnchors('s','c',['A']);globalThis.snap=await oldDB.claimQueue('s','c','甲');return snap.anchors;});
  const y=await pages[1].evaluate(async()=>(await oldDB.appendQueueAnchors('s','c',['B'])).anchors);
  await pages[0].evaluate(()=>oldDB.saveQueue('s','c',{...snap,status:'preparing'},{callerOwner:'甲',fencingToken:snap.fencingToken,replaceAnchors:true}));
  const z=await pages[1].evaluate(async()=>{const q=await oldDB.get('usage','queue:s:c'),{Controller}=await import('/v06/src/controller.js');const mem={timeline:{stream:{id:'s'},path:[],node:{state:{processed:{}}}},sessions:new Map([['s:c',{...q,anchors:new Set(q.anchors)}]]),views:new Map([['c',{source:[{id:'X',node:'B'}]}]]),staleSourceRecords:new Map()};return {members:q.anchors,audit:Controller.prototype.auditSourceConservation.call(mem,'c')};});
  assert.deepEqual(x,['A']);assert.deepEqual(y,['A','B']);assert.deepEqual(z.members,['A']);assert.equal(z.audit.conserved,true);assert.deepEqual(z.audit.unqueued,['X']);
  console.log('BASELINE 0.6.0 negative control '+JSON.stringify({claim:x,append:y,staleSave:z.members,oldAudit:z.audit}));
 }
 const route=(p,account)=>async(cmd,...args)=>{const r=await p.evaluate(async({account,cmd,args})=>{try{return {ok:true,value:await peer.call(account,cmd,args)};}catch(e){return {ok:false,code:e.code||e.name,message:e.message,stack:e.stack};}},{account,cmd,args});
 if(!r.ok)throw Object.assign(Error(r.message),{code:r.code,remoteStack:r.stack});return r.value;};
 for(const [i,[name,run]] of cases.entries()){const account='native-'+i;
 try{const start=performance.now();await run({peers:pages.map(p=>route(p,account)),fork:k=>route(pages[0],account+k),clean:async()=>{const other=await browser.newContext(),p=await other.newPage();await p.goto(url);await p.evaluate(async()=>{const {QueueTestPeer}=await import('/tests/queue-driver.js');globalThis.peer=new QueueTestPeer(indexedDB);});return route(p,account);},native:true});ok++;console.log('PASS '+name+' ('+Math.round(performance.now()-start)+' ms)');}
 catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack+'\n'+(e.remoteStack||''));}}
 console.log('RESULT '+ok+' passed / '+failed+' failed');assert.equal(failed,0);
 }finally{await browser?.close();await new Promise(ok=>http.close(ok));}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
