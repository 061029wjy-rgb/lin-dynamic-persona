import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {once} from 'node:events';import {profile,target,makeWire,httpWire,unpack,buildAdapter,safeUrl} from '../src/providers.js';import {buildService} from '../server/lin-persona-gateway/index.js';import {fixture,A} from './host-fixture.js';import {KEY} from '../src/util.js';
const kinds=['openai','compat','deepseek','router','gemini','vertex','claude','ollama'],req={system:'sys',prompt:'deidentified fixture',output:66,json:'text'},pFor=k=>profile({id:'probe',kind:k,model:'fixture-model',project:'fixture-project',region:'global',pin:'Provider',allowSend:true,allowLAN:true,transport:k==='vertex'?'server':'direct',...(k==='compat'?{url:'https://compat.example/v1'}:{})});
const response=(k,txt='{"ok":true}')=>['vertex','gemini'].includes(k)?{modelVersion:'fixture',candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'hidden'},{text:txt}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:5,totalTokenCount:15}}:k==='claude'?{model:'fixture',stop_reason:'end_turn',content:[{type:'thinking',thinking:'private'},{type:'text',text:txt}],usage:{input_tokens:10,output_tokens:5}}:k==='ollama'?{model:'fixture',done:true,done_reason:'stop',message:{content:txt},prompt_eval_count:10,eval_count:5}:{id:'fixture-id',model:'fixture',provider:k==='router'?'Provider':undefined,choices:[{finish_reason:'stop',message:{content:txt}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,cost:0}};
async function receiver(t,fn){const h=http.createServer(fn);h.listen(0,'127.0.0.1');await once(h,'listening');t.after(()=>{h.closeAllConnections();h.close();});return 'http://127.0.0.1:'+h.address().port;}
for(const k of kinds)test('协议实际 HTTP 收发及拒绝矩阵 · '+k,async t=>{
 let saved,mode=200;const host=await receiver(t,async(q,s)=>{let body='';for await(const x of q)body+=x;saved={path:q.url,headers:q.headers,body:JSON.parse(body)};s.writeHead(mode,{'Content-Type':'application/json'});s.end(mode===200?JSON.stringify(response(k)):'sensitive-error-fixture');});
 const p=pFor(k),w=makeWire(p,req,{key:'unit-test-only'},true),send=(u,o)=>fetch(host+new URL(u).pathname,o);const received=await httpWire(p,req,{key:'unit-test-only'},undefined,send,true,w);assert.equal(received.text,'{"ok":true}');assert.equal(received.usage.output,5);
 if(k==='vertex'||k==='gemini'){assert.ok(saved.body.contents);assert.equal(saved.body.systemInstruction.parts[0].text,'sys');assert.equal(saved.body.messages,undefined);assert.match(saved.path,/:generateContent$/);assert.equal(saved.headers[k==='vertex'?'authorization':'x-goog-api-key'],k==='vertex'?'Bearer unit-test-only':'unit-test-only');}
 else if(k==='claude'){assert.equal(saved.path,'/v1/messages');assert.equal(saved.body.system,'sys');assert.equal(saved.body.messages.length,1);assert.ok(saved.headers['anthropic-version']);}
 else if(k==='ollama'){assert.equal(saved.path,'/api/chat');assert.equal(saved.body.options.num_predict,66);}
 else{assert.match(saved.path,/\/chat\/completions$/);assert.deepEqual(saved.body.messages.map(v=>v.role),['system','user']);if(k==='router')assert.deepEqual(saved.body.provider,{allow_fallbacks:false,only:['Provider']});}
 for(const code of [401,403,404,429,500]){mode=code;await assert.rejects(httpWire(p,req,{},undefined,send,true,w),e=>e.status===code&&!e.message.includes('sensitive-error'));}
 for(const empty of ['',null])assert.throws(()=>unpack(p,response(k,empty)),/完整可见/);
 const blocked=response(k);if(k==='claude')blocked.stop_reason='max_tokens';else if(k==='gemini'||k==='vertex')blocked.candidates[0].finishReason='SAFETY';else if(k==='ollama')blocked.done_reason='length';else blocked.choices[0].finish_reason='length';
 assert.throws(()=>unpack(p,blocked),e=>e.detail.usage.output===5);const without=response(k);delete without.usage;delete without.usageMetadata;delete without.eval_count;assert.equal(unpack(p,without).usage.output,undefined);
});
test('Vertex 只信任服务端账号、固定目标、ADC；浏览器无法指定私钥、额外 URL 或借用别人的槽位；独立网关日配额跨重启持久原子计数',async()=>{
 const tmpDir=await fs.mkdtemp(path.join(os.tmpdir(),'ldp-gw-')),stateFile=path.join(tmpDir,'quota.json');
 const p=pFor('vertex'),slot={...p,users:['a'],serverDaily:1};let n=0;
 const makeGw=()=>buildService({stateFile,getConfig:async()=>({slots:{x:slot}}),token:async()=>{n++;return 'server-test-only';},fetcher:async(u,o)=>{assert.equal(u,target(p));assert.match(o.headers.Authorization,/server-test-only/);return Response.json(response('vertex'));}});
 const gateway1=makeGw();
 const packet={slot:'x',expected:{kind:p.kind,model:p.model,region:p.region,project:p.project,apiVersion:'v1'},request:req,url:'https://not-selected.example'};
 await assert.rejects(gateway1('b',packet),e=>e.status===403);await assert.rejects(gateway1('a',{...packet,expected:{...packet.expected,region:'us-central1'}}),e=>e.status===409);assert.equal(n,0);
 const out=await gateway1('a',packet);assert.equal(n,1);assert.ok(out.ok);assert.doesNotMatch(JSON.stringify(out),/server-test-only/);assert.throws(()=>makeWire(p,req,{key:'x'}),/服务端/);
 const gatewayRestarted=makeGw();
 await assert.rejects(gatewayRestarted('a',packet),e=>e.status===429);
 await fs.rm(tmpDir,{recursive:true,force:true});
});
test('地址类型、重定向策略、固定路由、HTTP 局域网、响应层隔离',()=>{
 const p=pFor('compat');assert.equal(target(p),'https://compat.example/v1/chat/completions');assert.throws(()=>target({...p,url:'https://compat.example/v1/chat/completions'}));assert.equal(target({...p,urlMode:'endpoint',url:'https://compat.example/custom'}),'https://compat.example/custom');
 for(const u of ['https://u:pass@site.example','https://site.example/x?key=secret','http://public.example','file:///etc/passwd'])assert.throws(()=>safeUrl(u,true));assert.equal(safeUrl('http://127.0.0.1:2233',true),'http://127.0.0.1:2233');
 assert.throws(()=>makeWire({...pFor('router'),pin:''},req,{key:'x'}));assert.throws(()=>unpack(p,{output:[{content:[]}]}));
});
test('配置/账本/人格备份无会话凭证；401只暂停该档，绝不回退主模型；换目标清除授权凭证；HTTP 400 自动关闭 Schema 且不重发',async t=>{
 let calls=0,st=0,auth,statusCode=401;const url=await receiver(t,async(q,s)=>{calls++;auth=q.headers.authorization;s.writeHead(statusCode);s.end('private text');});const f=await fixture({settings:{analysisEnabled:true},ctx:{generateRaw:()=>{st++;}}});t.after(()=>f.ctl.dispose());
 const svc=f.ctl.analyzer,p=svc.save({...pFor('compat'),url,model:'fixture',interval:0},{key:'session-unit-test'});f.ctl.changeSettings({activeProfile:p.id});await assert.rejects(svc.probe(p.id),/401/);assert.equal(auth,'Bearer session-unit-test');assert.equal(calls,1);assert.equal(st,0);assert.equal(svc.getProfile(p.id).enabled,false);
 assert.equal((await f.ctl.db.get('usage','account')).total,1);assert.doesNotMatch(JSON.stringify([f.c.extensionSettings[KEY],await f.ctl.db.export(),await f.ctl.db.all('usage')]),/session-unit-test|private text/);
 statusCode=400;const pSchema=svc.save({...p,id:'schema-prof',enabled:true,allowSend:true,json:'schema'},{key:'session-unit-test'},false,true);
 await assert.rejects(svc.probe(pSchema.id),/400.*Schema/);assert.equal(calls,2);assert.equal(svc.getProfile(pSchema.id).json,'text');
 svc.save({...p,model:'different'});assert.equal(svc.memory.has(p.id),false);svc.drop(p.id);assert.throws(()=>svc.getProfile(),/不会借用/);});
test('供应商返回损坏 JSON/流截断、取消和成功连接诊断都走同一计费入口',async t=>{
 let mode='bad';const url=await receiver(t,async(q,s)=>{if(mode==='wait'){q.on('close',()=>s.destroy());return;}s.writeHead(200,{'Content-Type':'application/json'});s.end(mode==='bad'?'{':JSON.stringify(response('compat')));});const f=await fixture({settings:{analysisEnabled:true},ctx:{generateRaw(){throw Error('禁止主模型');}}});t.after(()=>f.ctl.dispose());
 const svc=f.ctl.analyzer,p=svc.save({...pFor('compat'),url,interval:0});await assert.rejects(svc.probe(p.id));mode='ok';const meta=await svc.probe(p.id);assert.equal(meta.usage.total,15);mode='wait';const task=svc.probe(p.id);const spin=async()=>{for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,5));if((await f.ctl.db.get('usage','account'))?.total===3)break;}};await spin();svc.cancel();await assert.rejects(task);assert.equal((await f.ctl.db.get('usage','account')).total,3);});
