import test from 'node:test';import assert from 'node:assert/strict';import {fixture,turn,add,U,R,A,B} from './host-fixture.js';import {Analyzer} from '../src/analysis.js';import {Database} from '../src/storage.js';
// Deliberate corruption/expiry belongs in tests only; production raw queue writes stay forbidden.
async function injectQueueFault(db,row){await db.transaction(['usage'],'readwrite',tx=>tx.objectStore('usage').put(row));}
const empty=JSON.stringify({events:[],appraisals:[],proposals:[],summaries:[]}),failure='{"events":[';
test('默认不调用模型；主动开启后沿用 generateRaw，不传外部地址/模型/思考参数；历史不自动再收费',async()=>{
 let calls=[];const f=await fixture({ctx:{generateRaw:async args=>{calls.push(args);return empty;}}});await turn(f,'沈青收好琴谱。');assert.equal(calls.length,0);await assert.rejects(f.ctl.analyze(A.avatar),/主动启用/);
 f.ctl.changeSettings({analysisEnabled:true,useJsonSchema:false});await f.ctl.analyze(A.avatar);assert.deepEqual(Object.keys(calls[0]).sort(),['prompt','systemPrompt']);assert.equal(f.ctl.settings().analysisRequestsUsed,1);assert.equal(f.ctl.timeline.node.state.proposals.length,0);await f.ctl.analyze(A.avatar);assert.equal(calls.length,1);f.ctl.dispose();
});
test('JSON 截断和服务错误也占额度；同批不静默重试，显式 retry 才允许重发失败批次，累计/日/会话上限可设 0',async()=>{
 for(const [label,fn] of [['bad',()=>failure],['net',()=>{throw Error('503')}]]){
 let calls=0,succeedNext=false;const f=await fixture({settings:{analysisEnabled:true,analysisMaxTotalRequests:2},ctx:{generateRaw:()=>{calls++;return succeedNext?empty:fn();}}});
 await assert.rejects(f.ctl.analyze(A.avatar,false,null,null,true),/曾失败/);
 await assert.rejects(f.ctl.analyze(A.avatar));assert.equal((await f.ctl.db.get('usage','account')).total,1);assert.equal(f.ctl.timeline.node.state.processed[A.avatar],undefined);
 await assert.rejects(f.ctl.analyze(A.avatar),/重复收费/);
 succeedNext=true;await f.ctl.analyze(A.avatar,false,null,null,true);assert.equal(calls,2,label);assert.equal((await f.ctl.db.get('usage','account')).total,2);
 await turn(f,'沈青试着从不同角度听母带。');await assert.rejects(f.ctl.analyze(A.avatar),/预算/);f.ctl.dispose();}
 for(const field of ['dailyLimit','sessionLimit','analysisMaxTotalRequests']){const f=await fixture({settings:{analysisEnabled:true,[field]:0},ctx:{generateRaw(){assert.fail();}}});await assert.rejects(f.ctl.analyze(A.avatar),/预算/);f.ctl.dispose();}
});
test('显式 schema 只影响独立分析；不支持时下次改普通 JSON，不自动补第二次请求',async()=>{
 let calls=0;const f=await fixture({settings:{analysisEnabled:true,useJsonSchema:true},ctx:{generateRaw:async args=>{calls++;assert.ok(args.jsonSchema.value.properties.proposals);throw Error('structured schema unsupported');}}});await assert.rejects(f.ctl.analyze(A.avatar));assert.equal(calls,1);assert.equal(f.ctl.settings().useJsonSchema,false);f.ctl.dispose();
});
test('在途分析遇到编辑/聊天切换/分支更换：丢弃结果，不使用宿主停止键；真正底层结束前不并发',async()=>{
 for(const mode of ['edit','switch','swipe']){
 let launch,release,stop=0;const started=new Promise(ok=>launch=ok);const f=await fixture({chat:[U('要不要去排练？'),R('沈青整理了一份短谱。')],settings:{analysisEnabled:true},ctx:{stopGeneration:()=>stop++,generateRaw:()=>{launch();return new Promise(ok=>release=ok);}}});
 const task=f.ctl.analyze(A.avatar).catch(()=>null);await started;
 if(mode==='edit')await add(f,'manual','只采用玩家的措辞。');else if(mode==='switch'){f.c.chatId='B';f.event('CHAT_CHANGED');}else{f.c.chat.at(-1).swipe_id=3;f.c.chat.at(-1).mes='另一候选';f.save();f.event('MESSAGE_SWIPED');}
 await task;assert.equal(f.ctl.analyzer.busy,true);release(empty);await new Promise(ok=>setTimeout(ok,0));assert.equal(f.ctl.analyzer.busy,false);assert.equal(stop,0);assert.equal(f.ctl.timeline.node.state.processed[A.avatar],undefined);f.ctl.dispose();}
});
test('超时返回控制权；迟到结果被丢弃，直到原始调用 settled 才释放独占分析锁',async()=>{
 const analyzer=new Analyzer();let release;await assert.rejects(analyzer.run({prompt:'p',systemPrompt:'s',estimatedTokens:10},{timeoutMs:15},{generateRaw:()=>new Promise(ok=>release=ok)},async()=>{}),/超时/);assert.equal(analyzer.busy,true);
 await assert.rejects(analyzer.run({}, {},{generateRaw(){}},async()=>{}),/上一次/);release(empty);await new Promise(ok=>setTimeout(ok,0));assert.equal(analyzer.busy,false);
});
test('多标签页同配置档在途原子互斥与自动分析待发队列跨刷新恢复',async()=>{
 const f=await fixture({chat:[U('第一句。'),R('沈青记下要点。')],settings:{analysisEnabled:true,autoAnalyze:true,minTurns:4}});
 const db2=new Database('fixture',f.factory);
 await f.ctl.db.reserve('tab1-job',{total:10,day:10,session:10,profile:'main',actor:A.avatar,timeout:30},'s1');
 await assert.rejects(db2.reserve('tab2-job',{total:10,day:10,session:10,profile:'main',actor:A.avatar,timeout:30},'s2'),/另一标签页|正在使用/);
 await f.ctl.db.finishJob('tab1-job','已提交');
 await db2.reserve('tab2-job',{total:10,day:10,session:10,profile:'main',actor:A.avatar,timeout:30},'s2');
 await db2.releaseUnsent('tab2-job');
 await turn(f,'沈青继续整理第二份记录。');
 const savedQueues=await f.ctl.db.loadQueues(f.ctl.timeline.stream.id);
 assert.equal(savedQueues.length,1);assert.equal(savedQueues[0].anchors.length,1);
 const reloaded=await fixture({chat:structuredClone(f.c.chat),db:new Database('fixture',f.factory),ctx:{chatMetadata:structuredClone(f.c.chatMetadata)},settings:{analysisEnabled:true,autoAnalyze:true,minTurns:4}});
 assert.equal(reloaded.ctl.sessions.size,1);
 db2.close();f.ctl.dispose();reloaded.ctl.dispose();
});
test('T06：达到9次后因日限额失败保留锚点，刷新并提升限额后按批次精确 ACK，不丢剩余片段且不造假人格',async()=>{
 let calls=0;
 const f=await fixture({
  chat:[U('开始排练记录。')],
  settings:{analysisEnabled:true,autoAnalyze:true,minTurns:9,batchSize:24,dailyLimit:0,useJsonSchema:false},
  ctx:{generateRaw:async()=>{calls++;return empty;}}
 });
 for(let i=1;i<=9;i++){
  await turn(f,`沈青核对了第${i}段录音母带。`,{user:`请看第${i}段。`});
 }
 await f.ctl.pumpTask;
 await f.ctl.idle();
 assert.equal(calls,0,'日配额为0时不得发出请求');
 const qKey=`${f.ctl.timeline.stream.id}:${A.avatar}`;
 const memEntry=f.ctl.sessions.get(qKey);
 assert.ok(memEntry,'队列必须在内存中保留，不能提前 delete');
 assert.equal(memEntry.anchors.length,9,'9个有效锚点必须完整保留');
 assert.equal(memEntry.status,'waiting_budget');
 assert.match(memEntry.waitReason,/配额|上限|预算/);
 const persistedQueues=await f.ctl.db.loadQueues(f.ctl.timeline.stream.id);
 assert.equal(persistedQueues.length,1);
 assert.equal(persistedQueues[0].anchors.length,9);
 assert.equal(persistedQueues[0].status,'waiting_budget');

 const reloaded=await fixture({
  chat:structuredClone(f.c.chat),
  db:new Database('fixture',f.factory),
  ctx:{
   chatMetadata:structuredClone(f.c.chatMetadata),
   generateRaw:async()=>{calls++;return empty;}
  },
  settings:{analysisEnabled:true,autoAnalyze:true,minTurns:9,batchSize:24,dailyLimit:0,useJsonSchema:false}
 });
 assert.equal(reloaded.ctl.sessions.get(qKey)?.anchors.length,9,'刷新后仍保留9个待分析锚点');
 assert.equal(reloaded.ctl.sessions.get(qKey)?.status,'waiting_budget');

 reloaded.ctl.changeSettings({dailyLimit:5});
 await reloaded.ctl.pumpTask;
 await reloaded.ctl.idle();
 assert.equal(calls,1,'调高限额后发送分析请求');
 assert.equal(reloaded.ctl.sessions.size,0,'全部可见片段均被本批覆盖并提交后，队列才完成 ACK 清空');
 assert.equal((await reloaded.ctl.db.loadQueues(reloaded.ctl.timeline.stream.id)).length,0,'IndexedDB 持久化队列已原子清理');
 assert.equal((await reloaded.ctl.auditQueueState(A.avatar)).ok,true);
 assert.equal(reloaded.ctl.auditSourceConservation(A.avatar).queued.length,0);
 assert.equal(reloaded.ctl.timeline.node.state.influences.length,0,'合法空结果绝不伪造人格条目');
 f.ctl.dispose();
 reloaded.ctl.dispose();
});
test('T02 & P0-02：batchSize=2 累计12次有效回复仅逐批 ACK 实际覆盖来源（含同楼多片段完整性）；101/120锚点与超 queueLimit 背压零丢弃；来源状态严格守恒',async()=>{
 let dispatchedBatches=[];
 const f=await fixture({
  chat:[],
  settings:{analysisEnabled:true,autoAnalyze:false,minTurns:2,batchSize:2,dailyLimit:50,sessionLimit:50,analysisMaxTotalRequests:50,useJsonSchema:false},
  ctx:{generateRaw:async args=>{
   const parsed=JSON.parse(args.prompt);
   dispatchedBatches.push(parsed.messages.map(m=>m.text));
   return empty;
  }}
 });
 // 制造 12 次角色有效回复（其中第 1 楼包含 2 个分句片段，其余各 1 个片段，共 13 个可见片段）
 for(let i=1;i<=12;i++){
  const text=i===1?'沈青先检查了第1轨母带。沈青又标注了第1轨时间码。':`沈青核对了第${i}轨录音。`;
  await turn(f,text);
  const h=f.ctl.timeline.path.at(-1).hash;
  // 手动入队测试积累 12 个锚点后开启自动分析
  f.ctl.changeSettings({autoAnalyze:true,minTurns:20});
  await f.ctl.scheduleAnalysis(A.avatar,h);
  f.ctl.changeSettings({autoAnalyze:false});
 }
 const qKey=`${f.ctl.timeline.stream.id}:${A.avatar}`;
 assert.equal(f.ctl.sessions.get(qKey).anchors.size,12,'12个锚点全部在列');
 assert.equal(f.ctl.auditSourceConservation(A.avatar).queued.length,13,'13个可见片段全部处于 queued 状态');

 // 第一次仅分析 1 批（batchSize=2）：正好覆盖第 1 楼的 2 个片段，仅第 1 楼锚点可被 ACK，剩余 11 个锚点必须保留！
 await f.ctl.analyze(A.avatar,false,1,new Set(f.ctl.live(A.avatar).source.map(s=>s.id)),false,{queueTask:f.ctl.sessions.get(qKey),candidateAnchors:[...f.ctl.sessions.get(qKey).anchors],latest:false});
 assert.equal(dispatchedBatches.length,1);
 assert.equal(dispatchedBatches[0].length,2,'第一批只发送最早的 2 个片段');
 assert.equal(f.ctl.sessions.get(qKey).anchors.size,11,'仅第1楼2个片段全部完成后 ACK 第1楼，剩余11个锚点绝不能被整批删除！');
 const consAfter1=f.ctl.auditSourceConservation(A.avatar);
 assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true);
 assert.equal(consAfter1.acknowledged.length,2);
 assert.equal(consAfter1.queued.length,11);

 // 若某楼有 2 个片段但本批只分析了其中 1 个片段，该楼锚点不得提前 ACK
 await turn(f,'沈青记录了第13轨上半段。沈青记录了第13轨下半段。');
 const h13=f.ctl.timeline.path.at(-1).hash;
 await f.ctl.db.appendQueueAnchors(f.ctl.timeline.stream.id,A.avatar,[h13],{room:f.ctl.capture.room});
 await f.ctl.refreshQueue(f.ctl.timeline.stream.id,A.avatar);
 // 此时队列头是第 2 楼（1个片段）+ 第 3 楼（1个片段），逐批排空直到全部 13 楼（15个片段）处理完毕
 while(f.ctl.sessions.get(qKey)?.anchors?.size){
  const q=f.ctl.sessions.get(qKey);
  const done=new Set(f.ctl.timeline.node.state.processed[A.avatar]||[]);
  const ids=new Set(f.ctl.live(A.avatar).source.filter(s=>!done.has(s.id)).map(s=>s.id));
  await f.ctl.analyze(A.avatar,false,1,ids,false,{queueTask:q,candidateAnchors:[...q.anchors],latest:false});
  const c=f.ctl.auditSourceConservation(A.avatar);
  assert.equal((await f.ctl.auditQueueState(A.avatar)).ok,true,'每批提交后受理账本交叉核验通过');
  assert.equal(c.partitionComplete,true);
 }
 const finalCons=f.ctl.auditSourceConservation(A.avatar);
 assert.equal(finalCons.acknowledged.length,15,'全部15个片段均被精确分析并提交，零静默丢失');
 assert.equal(finalCons.queued.length,0);
 assert.equal(f.ctl.sessions.size,0);

 // 验证 101 / 120 个锚点不删除最早锚点，且超出 queueLimit 的多角色排队触发 waiting_capacity 背压保护
 f.ctl.changeSettings({autoAnalyze:true,minTurns:200,queueLimit:1});
 // This fixture checks admission capacity only; synthetic anchors are not real chat floors.
 f.ctl.pumpAnalysis=()=>Promise.resolve();
 for(let i=1;i<=120;i++){
  await f.ctl.scheduleAnalysis(A.avatar,`fake_anchor_${i.toString().padStart(4,'0')}`);
 }
 const q120=f.ctl.sessions.get(qKey);
 assert.equal(q120.anchors.size,120,'120个锚点必须100%保留，严禁在 >100 时删除最早锚点');
 assert.ok(q120.anchors.has('fake_anchor_0001'),'最早的第1个锚点完好保留');
 assert.equal(q120.backpressure,true);
 assert.equal(q120.overflowCount,20);

 // 第 2 个角色入队时，虽已达 queueLimit=1，但绝不静默丢弃，而是进入 waiting_capacity
 const qKeyB=`${f.ctl.timeline.stream.id}:${B.avatar}`;
 await f.ctl.scheduleAnalysis(B.avatar,'ning_anchor_01');
 const qB=f.ctl.sessions.get(qKeyB);
 assert.ok(qB,'超出 queueLimit 的新角色队列必须保留，不得静默丢弃');
 assert.equal(qB.status,'waiting_capacity');
 assert.equal(qB.anchors.has('ning_anchor_01'),true);
 f.ctl.dispose();
});
test('T03 & P0-03：发出断网后继续 1/5/20 楼 RP → 点击重试旧批仅重发原冻结 BatchManifest 来源，新楼留在队列；原消息被改或改配置时预检拒绝且不破坏失败状态',async()=>{
 let calls=[],shouldFail=true;
 const f=await fixture({
  chat:[U('第一轮提问。')],
  settings:{analysisEnabled:true,autoAnalyze:true,minTurns:2,batchSize:4,dailyLimit:20,sessionLimit:20,analysisMaxTotalRequests:20,useJsonSchema:false},
  ctx:{generateRaw:async args=>{calls.push(JSON.parse(args.prompt));if(shouldFail)throw Error('network socket hang up');return empty;}}
 });
 await turn(f,'沈青完成了第一轮调音。');
 await turn(f,'沈青完成了第二轮调音。');
 await f.ctl.pumpTask;
 await f.ctl.idle();
 assert.equal(calls.length,1);
 const qKey=`${f.ctl.timeline.stream.id}:${A.avatar}`;
 const qTask=f.ctl.sessions.get(qKey);
 assert.equal(qTask.status,'failed_requires_review');
 assert.ok(qTask.failedBatch,'失败批次必须冻结保存 BatchManifest');
 const frozenBatchId=qTask.failedBatch.batchId;
 const frozenSources=[...qTask.failedBatch.sourceIds];
 assert.equal(frozenSources.length,3,'原失败批次冻结了前3个可见片段（1用户+2角色）');

 // 在失败之后继续玩 RP 新增 5 楼（第 3..7 轮回复）
 for(let extra=3;extra<=7;extra++){
  await turn(f,`沈青继续推进第${extra}轮新剧情。`,{user:`继续第${extra}轮。`});
 }
 assert.equal(qTask.status,'failed_requires_review','继续 RP 不得冲掉 failed_requires_review 状态');
 assert.deepEqual(qTask.failedBatch.sourceIds,frozenSources,'继续 RP 新增楼层绝不篡改原失败批次的 sourceIds');
 assert.equal(qTask.anchors.size,7,'原2个锚点 + 新增5个锚点均在队列中');

 // 预检测试 1：若用户临时切换了配置档/合同，点击重试必须拒绝且保持 failed_requires_review 状态不变
 f.ctl.analyzer.save({id:'p-other',name:'另一配置档',kind:'st',contract:'focused',allowSend:true},{},false,true);
 f.ctl.changeSettings({activeProfile:'p-other'});
 await assert.rejects(f.ctl.analyze(A.avatar,false,1,null,true),/配置档、模型或分析合同已变更/);
 assert.equal(qTask.status,'failed_requires_review','预检失败不得把状态改成 preparing 或清除失败记录');
 assert.equal(qTask.failedBatch.batchId,frozenBatchId);

 // 切回原配置档 main，执行显式重试（retry=true）：必须只重发原冻结的 3 个片段！
 f.ctl.changeSettings({activeProfile:'main'});
 shouldFail=false;
 await f.ctl.analyze(A.avatar,false,1,null,true);
 assert.equal(calls.length,2,'显式重试发出第2次请求');
 assert.equal(calls[1].messages.length,3,'重试请求严格只包含原失败批次冻结的3个片段，未混入后续新增的5楼');
 assert.equal(qTask.failedBatch,null,'原失败批次重试成功后清除 failedBatch');
 assert.equal(qTask.anchors.size,5,'原批次的2个锚点已 ACK，而失败后新增的5楼锚点完整保留等待下一批');
 assert.equal(qTask.status,'queued');

 // 预检测试 2：若失败后原消息被编辑篡改，拒绝旧批重试且状态不变，支持显式 discardFailedBatch 重建
 shouldFail=true;
 await assert.rejects(f.ctl.analyze(A.avatar,false,1,new Set(f.ctl.live(A.avatar).source.filter(s=>!f.ctl.timeline.node.state.processed[A.avatar].includes(s.id)).map(s=>s.id)),false,{queueTask:qTask,candidateAnchors:[...qTask.anchors]}),/连接或模型请求失败/);
 assert.equal(qTask.status,'failed_requires_review');
 // 篡改原消息正文导致当前分支与失败批次来源不匹配
 f.c.chat[3].mes='沈青改写了第三轮剧情的正文。';f.save();f.ctl.knownSelection=true;
 await f.ctl.sync({confirmed:f.raw()});
 await assert.rejects(f.ctl.analyze(A.avatar,false,1,null,true),/已被编辑|无法直接重发/);
 assert.equal(f.ctl.sessions.get(qKey)?.status||'failed_requires_review','failed_requires_review');
 await f.ctl.discardFailedBatch(A.avatar,{rebuildQueue:true});
 assert.equal(f.ctl.failedBatches.has(qKey),false,'显式丢弃旧失败批次后清除冻结批次');
 f.ctl.dispose();
});
test('T04 & T05（P0-04 & 事务回滚）：Tab A claim 后旧内存 saveQueue 不覆盖租约；租约到期后过期 fencingToken 迟到提交被拒绝且当 sent=true 时转人工核验不重发；commitAnalysis 故障注入全回滚',async()=>{
 const f=await fixture({
  chat:[U('开始并发测试。'),R('沈青记录第一条。'),R('沈青记录第二条。')],
  settings:{analysisEnabled:true,autoAnalyze:false,minTurns:2,useJsonSchema:false},
  ctx:{generateRaw:async()=>empty}
 });
 const streamId=f.ctl.timeline.stream.id,actorId=A.avatar;
 const h1=f.ctl.timeline.path[2].hash,h2=f.ctl.timeline.path[3].hash;
 await f.ctl.db.appendQueueAnchors(streamId,actorId,[h1,h2],{room:f.ctl.capture.room,status:'queued'});

 // 1. Tab A 领取租约（获得 fencingToken = 1）
 const claimA=await f.ctl.db.claimQueue(streamId,actorId,'tab-A',10000);
 assert.equal(claimA.claimOwner,'tab-A');
 assert.equal(claimA.fencingToken,1);

 // 2. Tab B（或旧内存快照）调用 saveQueue 试图写入 claimOwner: null 及新锚点 h_extra
 await f.ctl.db.saveQueue(streamId,actorId,{
  stream:streamId,actor:actorId,anchors:[h1,h2,'h_extra'],
  status:'queued',claimOwner:null,claimUntil:0
 });
 const afterStaleSave=(await f.ctl.db.loadQueues(streamId)).find(q=>q.actor===actorId);
 assert.equal(afterStaleSave.claimOwner,'tab-A','旧内存 saveQueue 绝不能清空 Tab A 持有的有效租约！');
 assert.equal(afterStaleSave.fencingToken,1);
 assert.ok(afterStaleSave.anchors.includes('h_extra'),'新追加的锚点被安全合并，不丢数据');

 // 3. 此时 Tab B 尝试 claimQueue 必须失败
 const dbTabB=new Database('fixture',f.factory);
 await assert.rejects(dbTabB.claimQueue(streamId,actorId,'tab-B',10000),/另一标签页/);

 // 4. 模拟 Tab A 租约超时，且 Tab B 领取了更高 fencingToken = 2；Tab A 拿着旧 fencingToken = 1 迟到写回或 commitAnalysis 必须被拒绝！
 await injectQueueFault(f.ctl.db,{...afterStaleSave,claimUntil:Date.now()-1000,sent:false,status:'preparing'});
 const claimB=await dbTabB.claimQueue(streamId,actorId,'tab-B',10000);
 assert.equal(claimB.claimOwner,'tab-B');
 assert.equal(claimB.fencingToken,2);
 await assert.rejects(
  f.ctl.db.saveQueue(streamId,actorId,{...afterStaleSave,status:'queued'},{callerOwner:'tab-A',fencingToken:1}),
  /Fencing Token 已过期/
 );
 await assert.rejects(
  f.ctl.timeline.commitAnalysis(s=>s,'迟到提交',f.ctl.timeline.token(),()=>true,{
   queueKey:`queue:${streamId}:${actorId}`,
   consumedAnchors:[h1],
   fencingToken:1,
   callerOwner:'tab-A'
  }),
  /Fencing Token 已过期|另一标签页/
 );

 // 5. 若前序标签页已发出请求（sent=true, status='sending'）后租约超时，新标签页 claimQueue 必须转为 failed_requires_review 且抛出 LEASE_EXPIRED_SENT，绝不自动重发！
 await injectQueueFault(f.ctl.db,{...claimB,claimOwner:'tab-B',claimUntil:Date.now()-1000,sent:true,status:'sending'});
 await assert.rejects(
  f.ctl.db.claimQueue(streamId,actorId,'tab-C',10000),
  err=>err.code==='LEASE_EXPIRED_SENT'&&/可能已计费/.test(err.message)
 );
 const afterExpiredSent=(await f.ctl.db.loadQueues(streamId)).find(q=>q.actor===actorId);
 assert.equal(afterExpiredSent.status,'failed_requires_review','已发出但租约超时的任务持久转入 failed_requires_review');
 assert.equal(afterExpiredSent.claimOwner,null);

 // 6. T05：commitAnalysis 中途注入写入故障，验证节点、processed、账本与队列 ACK 全量原子回滚
 await injectQueueFault(f.ctl.db,{...afterExpiredSent,status:'preparing',sent:false,claimOwner:f.ctl.queueOwner,claimUntil:Date.now()+10000,fencingToken:10,anchors:[h1,h2]});
 const revBefore=f.ctl.timeline.node.revision;
 await assert.rejects(
  f.ctl.analyze(actorId,false,1,null,false,{
   injectCommitFault:(_tx,abort)=>abort(Error('模拟 IndexedDB 写入中途故障'))
  }),
  /模拟 IndexedDB 写入中途故障/
 );
 assert.equal(f.ctl.timeline.node.revision,revBefore,'事务回滚后节点 revision 不变');
 assert.equal(f.ctl.timeline.node.state.processed[actorId],undefined,'事务回滚后 processed 不被污染');
 const qAfterRollback=(await f.ctl.db.loadQueues(streamId)).find(q=>q.actor===actorId);
 assert.ok(qAfterRollback.anchors.includes(h1)&&qAfterRollback.anchors.includes(h2),'事务回滚后队列锚点未丢失');
 dbTabB.close();
 f.ctl.dispose();
});
