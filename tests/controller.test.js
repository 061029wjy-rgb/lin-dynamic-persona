import test from 'node:test';import assert from 'node:assert/strict';import {fixture,turn,add,mood,get,U,R,A,B} from './host-fixture.js';import {KEY} from '../src/util.js';import {diskChat} from '../src/sources.js';
test('真实事件顺序模型：先结束再渲染双通知，只扣一次；五次其他 NPC 回复不消耗两次即时影响',async()=>{
 const f=await fixture({group:true});await mood(f,2);await turn(f,'沈青把杯子拿到窗边。');assert.equal(get(f,'mood').duration.remaining,1);
 for(let i=0;i<5;i++)await turn(f,'余宁在做自己的工作。'+i,{who:B,user:'余宁，轮到你了。'});assert.equal(get(f,'mood').duration.remaining,1);
 await turn(f,'沈青合上琴盖。',{user:'沈青，准备好了吗？'});assert.equal(get(f,'mood').duration.remaining,0);assert.equal(f.ctl.timeline.node.state.turns[B.avatar],5);f.ctl.dispose();
});
test('同文不同 swipe、续写、重生和返回 A 仅按当前选中分支推进',async()=>{
 const f=await fixture();await mood(f,3);await turn(f,'沈青在本上写下一个字。');await add(f,'red','只在 A 中记录红纸。');const branch=structuredClone(f.c.chat);assert.equal(get(f,'mood').duration.remaining,2);
 await turn(f,'沈青在本上写下一个字。',{type:'swipe',swipe:1});assert.equal(get(f,'red'),undefined);await add(f,'blue','B 中选择蓝纸。');await turn(f,'沈青在本上写下一个字。又补了一行。',{type:'continue',swipe:1});assert.equal(get(f,'mood').duration.remaining,2);assert.ok(get(f,'blue'));assert.equal(f.ctl.timeline.node.state.turns[A.avatar],1);
 f.c.chat=branch;f.save();f.ctl.knownSelection=true;await f.ctl.sync();assert.ok(get(f,'red'));assert.equal(get(f,'blue'),undefined);
 await turn(f,'沈青换了一种新的安排。',{type:'regenerate'});assert.equal(get(f,'red'),undefined);assert.equal(get(f,'mood').duration.remaining,2);f.ctl.dispose();});
test('未落盘、仅思考、停止、工具、戏外输出不学习；单独重载已停止的部分文本仍不算',async()=>{
 for(const [label,value,opts] of [['unsaved','尚未持久化。',{save:false}],['hidden','<!--Lin_CoT 秘密-->',{}],['stop','这段只写到一半',{stop:true}],['tool','工具中间内容',{tool:true}],['OOC','别写进剧情',{user:'OOC: 修改规则'}]]){
 const f=await fixture();await mood(f,2);await turn(f,value,opts);assert.equal(get(f,'mood').duration.remaining,2,label);if(label==='stop'){await f.ctl.sync({recovery:true,force:true});assert.equal(get(f,'mood').duration.remaining,2);assert.ok(!f.ctl.views.get(A.avatar)?.source.some(x=>x.text===value));}f.ctl.dispose();}
});
test('实际宿主形状四参数；不改卡/消息/预填充、关闭无残留；宏只在输出副本中转义',async()=>{
 const f=await fixture();await add(f,'r','排练时自己记一份 {{getvar::secret}}。');const raw=JSON.stringify([f.c.characters,f.c.chat]),{ctl,c}=f;
 f.event('GENERATION_STARTED','normal',{},false);await ctl.intercept(c.chat,9999,()=>assert.fail(),'normal');await ctl.intercept(c.chat,9999,()=>assert.fail(),'normal');
 const nonempty=f.prompts.filter(v=>v[1]);assert.equal(nonempty.length,1);assert.deepEqual(nonempty[0].slice(2),[0,0,false,0]);assert.ok(nonempty[0][1].includes('自己记一份'));assert.ok(!nonempty[0][1].includes('{{'));assert.equal(JSON.stringify([c.characters,c.chat]),raw);
 for(const kind of ['quiet','impersonate','tool']){f.event('GENERATION_STARTED',kind,{},false);await ctl.intercept(c.chat,100,()=>{},kind);assert.equal(f.prompts.at(-1)[1],'');}
 ctl.changeSettings({enabled:false});f.event('GENERATION_STARTED','normal',{},false);await ctl.intercept(c.chat,100,()=>{},'normal');assert.equal(f.prompts.at(-1)[1],'');ctl.dispose();});
test('旧情绪插件只做公开配置级避让，已审 L1 保留且无情绪双抽',async()=>{
 const f=await fixture({settings:{expressive:true},ctx:{getExtensionManifest:n=>n==='lin-emotional-control'?{version:'1.2.0'}:null}});await add(f,'habit','会把原稿另存一份。');await mood(f,2);f.event('GENERATION_STARTED','normal',{},false);await f.ctl.intercept(f.c.chat,1000,()=>{},'normal');assert.ok(f.ctl.lastPrompt.includes('另存'));assert.ok(f.ctl.lastPrompt.includes('被夸以后'));assert.ok(!f.ctl.lastPrompt.includes('可略过的一时念头'));assert.equal(f.ctl.diag.coop,'coexist');f.ctl.dispose();});
test('单人、群聊分别读取酒馆已存文件而非回传实时数组；检查 integrity',async()=>{
 const f=await fixture();f.c.getRequestHeaders=()=>({'Content-Type':'application/json'});let last;
 const fetcher=async (url,opt)=>{last={url,opt};return Response.json([{chat_metadata:{integrity:'sA'}},...f.c.chat]);};
 assert.deepEqual(await diskChat(f.c,null,fetcher),f.c.chat);assert.equal(last.url,'/api/chats/get');assert.equal(last.opt.credentials,'same-origin');f.c.groupId='g';await diskChat(f.c,null,fetcher);assert.equal(last.url,'/api/chats/group/get');f.c.chatMetadata.integrity='B';await assert.rejects(diskChat(f.c,null,fetcher),/身份/);f.ctl.dispose();});
