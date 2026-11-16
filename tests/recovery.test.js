import test from 'node:test';import assert from 'node:assert/strict';import {fixture,add,turn,get,U,R,A} from './host-fixture.js';import {Database} from '../src/storage.js';import {IDBFactory} from './shims/indexeddb.js';import {KEY,hash,legacySignature} from '../src/util.js';import {emptyState,normalizeInfluence} from '../src/model.js';
test('有历史差异且弹窗关 → 静默停止，不选择未来或同层 sibling；逐字共同前缀才可显式载入',async()=>{
 const f=await fixture();await add(f,'early','旧点已学会整理资料。');const first=structuredClone(f.c.chat),sid=f.ctl.timeline.stream.id,head=f.ctl.timeline.node.hash;await turn(f,'沈青去码头提交文件。');await add(f,'future','只在后来见到那条船。');const future=f.ctl.timeline.node.hash;
 f.c.chatId='checkpoint';f.c.chatMetadata={integrity:'child',main_chat:'world-A',[KEY]:{version:4,stream:sid,head:future}};f.c.chat=first;f.save();await f.ctl.sync({recovery:true,force:true});assert.ok(f.ctl.suspended);
 await assert.rejects(f.ctl.adopt(sid,future),/共同历史/);assert.equal(f.ctl.suspended,true);await f.ctl.adopt(sid,head);assert.ok(get(f,'early'));assert.equal(get(f,'future'),undefined);assert.ok(!f.ctl.suspended);await add(f,'fork','只发生在子线。');f.ctl.dispose();
});
test('文本相同但修订不同 → 恢复指定人工历史；取消操作不改变档案',async()=>{
 let action='cancel';const f=await fixture({recovery:async()=>action,settings:{recoveryPopup:true}});await add(f,'one','第一次编辑。');const pointer=structuredClone(f.c.chatMetadata[KEY]);await add(f,'two','第二次编辑。');f.c.chatMetadata[KEY]=pointer;
 const seq=f.ctl.timeline.stream.seq;await f.ctl.sync({recovery:true});await f.ctl.idle();assert.ok(f.ctl.suspended);assert.equal(f.ctl.timeline.stream.seq,seq);action='restore';await f.ctl.resumeRecovery();await f.ctl.idle();assert.ok(!f.ctl.suspended);assert.ok(get(f,'one'));assert.equal(get(f,'two'),undefined);f.ctl.dispose();
});
test('导入旧 v3 快照：原对象原库不变，人工锁定保留，自动推论隔离，同文不同 swipe 有歧义时拒绝',async()=>{
 const f=await fixture({chat:[U('工作室见。'),R('沈青找到原稿。')]});let parent='root',h;for(const m of f.c.chat){h=await hash(parent+'\n'+legacySignature(m));if(m===f.c.chat.at(-1))break;parent=h;}
 const st=emptyState();st.influences.push(normalizeInfluence({id:'oldauto',layer:'acquired',description:'旧程序推测的关系。'},A.avatar),normalizeInfluence({id:'locked',layer:'acquired',description:'玩家明确写下的旧态度。',managedBy:'user',frozen:true},A.avatar));
 const room=f.ctl.timeline.stream.owner,node={key:'v3:'+h,stream:'v3',hash:h,parent,length:2,state:st,revision:3,history:[]},backup={format:'lin-dynamic-persona',version:3,streams:[{id:'v3',key:'v3',owner:room,head:h}],nodes:[node]};const old=JSON.stringify(backup);
 const [candidate]=await f.ctl.db.import(backup);assert.equal(JSON.stringify(backup),old);await f.ctl.adopt(candidate.id,h);assert.equal(get(f,'oldauto').enabled,false);assert.equal(get(f,'oldauto').reviewState,'legacy');assert.ok(get(f,'locked').frozen);
 f.c.chat.at(-1).swipes=['沈青找到原稿。','沈青找到原稿。'];f.save();await f.ctl.sync();assert.equal((await f.ctl.timeline.listSnapshotsForStream(candidate.id)).length,0);f.ctl.dispose();
});
test('完整备份跨库；增量只能补到同一来源及精确的起始修订；活动库不被覆盖',async()=>{
 const f=await fixture();await add(f,'one','初始人格。');const before=await f.ctl.db.export(),seq=f.ctl.timeline.stream.seq,sid=f.ctl.timeline.stream.id;await add(f,'two','新增的经历。');const delta=await f.ctl.db.delta(sid,seq),target=new Database('new',new IDBFactory());
 await assert.rejects(target.import(delta),/完整备份/);const [copy]=await target.import(before);await target.import(delta);const rec=await target.get('nodes',copy.id+':'+f.ctl.timeline.node.hash);assert.ok(rec.state.influences.some(x=>x.id==='two'));await assert.rejects(target.import(delta),/完整备份/);assert.equal((await target.all('streams')).length,1);
 const bad=structuredClone(before);bad.nodes[0].key='wrong';await assert.rejects(target.import(bad),/索引/);assert.equal((await target.all('streams')).length,1);target.close();f.ctl.dispose();
});
test('新设备仅有聊天元数据：无库时不伪造状态，玩家可选从已存文本重新建立索引',async()=>{
 const f=await fixture();await add(f,'one','只在设备一保存。');const metadata=structuredClone(f.c.chatMetadata);
 const d=await fixture({ctx:{chatMetadata:metadata},settings:{recoveryPopup:true},recovery:async()=>'rebuild'});await d.ctl.idle();assert.equal(get(d,'one'),undefined);assert.ok(!d.ctl.suspended);assert.ok(d.ctl.live(A.avatar).source.length);f.ctl.dispose();d.ctl.dispose();
});
test('旧设备同时编辑：过时修订不能覆写新窗口玩家修改',async()=>{
 const f=await fixture();await add(f,'one','第一份。');const d=await fixture({db:new Database('fixture',f.factory),ctx:{chatMetadata:structuredClone(f.c.chatMetadata)}});await add(f,'two','随后新增。');await assert.rejects(add(d,'bad','旧窗口不能落盘。'),/另一窗口|版本|覆/);
 await d.ctl.sync({force:true});assert.ok(get(d,'two'));assert.equal(get(d,'bad'),undefined);f.ctl.dispose();d.ctl.dispose();
});
