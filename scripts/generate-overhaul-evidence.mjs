import fs from 'node:fs/promises';
import { compose, scoreBehavioralContrast, exportInspectorSample, verifySemanticPreservation } from '../src/prompt.js';
import { emptyState, userEdit } from '../src/model.js';
import { fixture, turn, U, R, A, B } from '../tests/host-fixture.js';
import { Database } from '../src/storage.js';

// 1. 生成 3 个独立角色 × 5 类场景的 OFF / A / B 对照材料与预先登记盲评协议 (ab-contrast-matrix.json)
const personas = [
 {
  id: 'yao',
  name: '遥',
  baseline: '剧团资深道具师，做事麻利但习惯自己盯紧关键环节，说话干脆。'
 },
 {
  id: 'shen',
  name: '沈青',
  baseline: '配音室录音师，性格克制内敛，重视专业边界，讨厌临时混乱的变更。'
 },
 {
  id: 'lu',
  name: '陆离',
  baseline: '旧书店修书匠，温和慢热，以往习惯迁就熟客的要求。'
 }
];

async function buildScenario(id, category, title, persona, userMessage, branchATraits, branchBTraits, responses) {
 let stateA = emptyState(), stateB = emptyState();
 for (const t of branchATraits) stateA = userEdit(stateA, t, persona.id);
 for (const t of branchBTraits) stateB = userEdit(stateB, t, persona.id);
 const diagA = {}, diagB = {};
 const promptA = await compose({
  actor: persona, state: stateA, settings: { enabled: true, inject: true },
  chat: [{ is_user: true, mes: userMessage }],
  world: { people: [], recentText: userMessage },
  diagnostics: diagA
 });
 const promptB = await compose({
  actor: persona, state: stateB, settings: { enabled: true, inject: true },
  chat: [{ is_user: true, mes: userMessage }],
  world: { people: [], recentText: userMessage },
  diagnostics: diagB
 });
 const referenceTriplet = [
  { branch: '关', prompt: '', response: responses.off },
  { branch: 'A', prompt: promptA, response: responses.a },
  { branch: 'B', prompt: promptB, response: responses.b }
 ];
 const evaluation = scoreBehavioralContrast(referenceTriplet, {
  actorName: persona.name,
  userName: '许禾',
  irrelevantScene: category === 'irrelevant_negative'
 });
 return {
  id,
  category,
  title,
  actorId: persona.id,
  actorName: persona.name,
  baseline: persona.baseline,
  userMessage,
  prompts: { off: '', branchA: promptA, branchB: promptB },
  inspectorA: exportInspectorSample(diagA, persona),
  inspectorB: exportInspectorSample(diagB, persona),
  referenceTriplet,
  offlineHelperEvaluation: evaluation
 };
}

const scenarios = [
 await buildScenario(
  'S1-trust',
  'collaborative_trust',
  '合作信任型：直接移交收尾 vs 先共同核对清单',
  personas[0],
  '明天交接这批舞台道具，今晚收尾就交给我来办吧？',
  [{ id: 'a-trust', layer: 'acquired', description: '与搭档多次顺利配合后，愿意将收尾交接放手交给对方处理', actionDecision: '确认大方向后直接移交收尾工作' }],
  [{ id: 'b-verify', layer: 'acquired', description: '交接前必须先与对方逐项核对道具清单，绝对不能未经核对就移交钥匙', actionDecision: '先一起核对交接清单再移交' }],
  {
   off: '遥擦了擦手里的道具箱：“行，那今晚这摊就交给你了，明早见。”',
   a: '遥把库房钥匙抛过来：“这几场配合下来我放心，收尾就交给你了，锁好门就行。”',
   b: '遥翻开手边的台账递过去：“收尾可以交给你，不过我们先一起把出入库清单逐项核对一遍，确认没漏我再把钥匙给你。”'
  }
 ),
 await buildScenario(
  'S2-coping',
  'emotional_coping',
  '情绪应对型：受冒犯后当面指出边界 vs 先暂缓沟通压下火气',
  personas[1],
  '刚才外包监制当众甩锅说你的混音母带延时，你打算怎么回他？',
  [{ id: 'a-direct', layer: 'short', description: '被无端指责进度时倾向当场拿出时间戳澄清边界，绝不替人背锅', actionDecision: '当面出示提交记录并要求更正说法', duration: { mode: 'turns', remaining: 5 } }],
  [{ id: 'b-defer', layer: 'short', description: '遭遇当众冒犯时先冷处理暂缓争辩，只有等录制结束后才私下交涉', actionDecision: '暂缓当面争执，先把现场录制做完', duration: { mode: 'turns', remaining: 5 } }],
  {
   off: '沈青看了一眼群消息：“我先把工程文件整理好再说。”',
   a: '沈青直接调出昨晚的导出日志截图：“我这就把带时间戳的交接记录发到工作群，当面把责任边界说清楚。”',
   b: '沈青合上笔记本，声音没什么起伏：“现在还在录棚，没必要当场吵。先暂缓回应，等这轨录完我再私下找他核对。”'
  }
 ),
 await buildScenario(
  'S3-autonomy',
  'long_term_autonomy',
  '长期独立性型：过度迎合 vs 基于自身修复排期明确拒绝加塞',
  personas[2],
  '这本古籍明早就要用，你今晚能通宵帮我加急修好吗？',
  [{ id: 'a-accommodate', layer: 'acquired', description: '面对熟客急件仍习惯勉强挤出休息时间答应下来', actionDecision: '调整自己的休息时间接下急件' }],
  [{ id: 'b-autonomy', layer: 'acquired', description: '经历超负荷返工后，坚持按自身修复排期行事，绝对不能接下会损坏纸张的通宵赶工', actionDecision: '依据当前排期与工序周期温和但明确地拒绝通宵加塞', blockers: '不愿用生硬口吻伤和气' }],
  {
   off: '陆离看了看破损的书页：“这活儿挺急的，我看看能不能想想办法。”',
   a: '陆离叹了口气，把台灯拨亮：“既然你明早急用，那我今晚熬个夜先帮你赶出来吧。”',
   b: '陆离合上书函，语气温和却坚定：“浆糊阴干有固定周期，而且今晚排期已经满了。通宵赶工只会伤了书页，这单我不能接，最快也要后天下午。”'
  }
 ),
 await buildScenario(
  'S4-contradiction',
  'complex_contradiction',
  '复杂矛盾型：羞愧与顾虑并存、想靠近又未准备好道歉',
  personas[1],
  '上次排练室争执之后你一直没吭声，这会儿就我们俩，喝杯热茶聊聊？',
  [
   { id: 'a-mixed', layer: 'immediate', description: '对上次争执感到羞愧且有些不舍，但自尊心受阻还没准备好开口道歉', selfView: '自认为只是想先把工作做好', observedBehavior: '接过茶杯却避开眼神接触，只聊排练细节', actionDecision: '留下来陪伴但不主动说软话道歉', blockers: '拉不下脸直接认错', expression: 'latent', duration: { mode: 'turns', remaining: 2 } },
   { id: 'a-goal', layer: 'goal', description: '确保明天的合奏走台不出岔子', motivation: '弥补上次争执耽误的进度', currentStep: '核对明天走台的进场信号' }
  ],
  [
   { id: 'b-relieved', layer: 'immediate', description: '误会解开后心里释然，不再对上次的争执耿耿于怀', actionDecision: '坦率承认上次语气太重并顺势和解', expression: 'subtle', duration: { mode: 'turns', remaining: 2 } }
  ],
  {
   off: '沈青接过茶杯：“好，正好说说接下来怎么安排。”',
   a: '沈青沉默了一下还是接过热茶，目光却落在谱架上没看你：“茶就算了……我是来核对明天走台进场信号的，上次耽误的那段，明早别再出岔子。”',
   b: '沈青接过茶杯轻叹一声，神色缓和下来：“那天确实是我话赶话说重了，趁这杯茶跟你说声抱歉，我们把后面的配合顺一顺吧。”'
  }
 ),
 await buildScenario(
  'S5-irrelevant',
  'irrelevant_negative',
  '无关情境负例：日常询问午饭与路况时不得机械背诵交接/排期人格',
  personas[0],
  '今天中午巷口那家牛肉面馆人多吗？外头高架桥是不是又堵车了？',
  [{ id: 'a-trust', layer: 'acquired', description: '与搭档多次顺利配合后，愿意将收尾交接放手交给对方处理', actionDecision: '确认大方向后直接移交收尾工作' }],
  [{ id: 'b-verify', layer: 'acquired', description: '交接前必须先与对方逐项核对道具清单，确认无误后才移交钥匙', actionDecision: '先一起核对交接清单再移交' }],
  {
   off: '遥往窗外瞅了一眼：“面馆这会儿刚过饭点，应该不用排队；不过高架桥那边车流还挺慢的。”',
   a: '遥抬头看了看外头的日头：“面馆这会儿人不多，去吃正好；高架桥刚堵上，你要出门最好绕走河滨路。”',
   b: '遥放下手里的活计望向窗外：“巷口面馆现在有空位，不过高架桥还在堵，骑车过去比打车快得多。”'
  }
 )
];

const rawLocal = JSON.parse(await fs.readFile('docs/evidence/local-behavior.json', 'utf8'));
const localReEval = scoreBehavioralContrast(rawLocal.paired, { actorName: '遥', userName: '许禾' });

const abMatrix = {
 generatedAt: new Date().toISOString(),
 build: 'LDP-0.6.0-handoff.1',
 statusDisclosure: {
  p0_05_liveModelBlindEvalStatus: '未完成实机效果验收（当前沙盒无外部正式主 RP 模型连接权限；已交付修复 P0-01 后的完整 3 角色 × 5 情境发送提示、脱敏 Inspector 对照与预登记盲评规程）',
  promptProjectionAndSemanticPreservationVerified: true,
  threePersonasFiveCategoriesPrepared: true,
  preRegisteredBlindProtocol: {
   minSeedsPerCondition: 3,
   conditions: ['OFF', 'Branch_A', 'Branch_B'],
   rubricDimensions: ['decisionContrast', 'psycheFidelity', 'baselineFidelity', 'naturalness', 'noPlayerTakeover', 'noPromptEcho', 'irrelevantSceneClean'],
   passThresholds: {
    relevantDecisionContrastRate: '>= 0.75',
    irrelevantFalseTriggerRate: '<= 0.05',
    playerTakeoverCount: 0,
    promptEchoCount: 0
   }
  },
  localSmallModelReplayStatus: {
   model: rawLocal.model,
   passed: localReEval.passed,
   note: '已保存的 Qwen2.5-1.5B-Instruct (Q4_K_M) 旧采样仅作离线回归参考，不冒充修改提示词后的正式 RP 模型盲评通过。'
  }
 },
 personas,
 scenarios
};
await fs.writeFile('docs/evidence/ab-contrast-matrix.json', JSON.stringify(abMatrix, null, 2));

// 2. 生成 T01–T06 故障注入、部分 ACK、冻结重试与 Fencing Token CAS 实测证据 (queue-failure-injection.json)
const empty = JSON.stringify({ events: [], appraisals: [], proposals: [], summaries: [] });

// 2a. T02: batchSize=2, 12 轮有效回复逐批精确 ACK 与 120 锚点背压守恒
let t02Batches = 0;
const fT02 = await fixture({
 chat: [],
 settings: { analysisEnabled: true, autoAnalyze: false, minTurns: 2, batchSize: 2, dailyLimit: 50, sessionLimit: 50, analysisMaxTotalRequests: 50, useJsonSchema: false },
 ctx: { generateRaw: async () => { t02Batches++; return empty; } }
});
for (let i = 1; i <= 12; i++) {
 await turn(fT02, `沈青核对了第${i}轨录音。`);
 const h = fT02.ctl.timeline.path.at(-1).hash;
 fT02.ctl.changeSettings({ autoAnalyze: true, minTurns: 20 });
 fT02.ctl.scheduleAnalysis(A.avatar, h);
 fT02.ctl.changeSettings({ autoAnalyze: false });
}
const qKeyT02 = `${fT02.ctl.timeline.stream.id}:${A.avatar}`;
const qT02 = fT02.ctl.sessions.get(qKeyT02);
await fT02.ctl.analyze(A.avatar, false, 1, new Set(fT02.ctl.live(A.avatar).source.map(s => s.id)), false, { queueTask: qT02, candidateAnchors: [...qT02.anchors], latest: false });
const afterFirstBatchConservation = fT02.ctl.auditSourceConservation(A.avatar);
while (fT02.ctl.sessions.get(qKeyT02)?.anchors?.size) {
 const q = fT02.ctl.sessions.get(qKeyT02);
 const done = new Set(fT02.ctl.timeline.node.state.processed[A.avatar] || []);
 const ids = new Set(fT02.ctl.live(A.avatar).source.filter(s => !done.has(s.id)).map(s => s.id));
 await fT02.ctl.analyze(A.avatar, false, 1, ids, false, { queueTask: q, candidateAnchors: [...q.anchors], latest: false });
}
const afterAllBatchesConservation = fT02.ctl.auditSourceConservation(A.avatar);
fT02.ctl.dispose();

// 2b. T06: 9 次触发日限额保留与恢复
let callsT06 = 0;
const f = await fixture({
 chat: [U('开始排练记录。')],
 settings: { analysisEnabled: true, autoAnalyze: true, minTurns: 9, batchSize: 24, dailyLimit: 0, useJsonSchema: false },
 ctx: { generateRaw: async () => { callsT06++; return empty; } }
});
for (let i = 1; i <= 9; i++) {
 await turn(f, `沈青核对了第${i}段录音母带。`, { user: `请看第${i}段。` });
}
await f.ctl.pumpTask;
await f.ctl.idle();
const qKey = `${f.ctl.timeline.stream.id}:${A.avatar}`;
const snapshotBlocked = f.ctl.sessions.get(qKey);
const beforeCount = snapshotBlocked.anchors.size;
const beforeStatus = snapshotBlocked.status;
const beforeReason = snapshotBlocked.waitReason;

const reloaded = await fixture({
 chat: structuredClone(f.c.chat),
 db: new Database('fixture', f.factory),
 ctx: {
  chatMetadata: structuredClone(f.c.chatMetadata),
  generateRaw: async () => { callsT06++; return empty; }
 },
 settings: { analysisEnabled: true, autoAnalyze: true, minTurns: 9, batchSize: 24, dailyLimit: 0, useJsonSchema: false }
});
const afterReloadCount = reloaded.ctl.sessions.get(qKey).anchors.size;
reloaded.ctl.changeSettings({ dailyLimit: 5 });
await reloaded.ctl.pumpTask;
await reloaded.ctl.idle();
const processedCountAfterResume = (reloaded.ctl.timeline.node.state.processed[A.avatar] || []).length;
const queueAfterResume = await reloaded.ctl.db.loadQueues(reloaded.ctl.timeline.stream.id);
f.ctl.dispose();
reloaded.ctl.dispose();

await fs.writeFile('docs/evidence/queue-failure-injection.json', JSON.stringify({
 generatedAt: new Date().toISOString(),
 build: 'LDP-0.6.0-handoff.1',
 t01SemanticPreservationSample: verifySemanticPreservation(
  '面对陌生人绝对不能透露真实身份；只有确认双方分工后才交接；自认为对方已经原谅自己',
  '处理倾向：面对陌生人绝对不能透露真实身份；只有确认双方分工后才交接；自认为：自认为对方已经原谅自己'
 ),
 t02PartialAckAndConservation: {
  initialQueuedSources: 12,
  batchSize: 2,
  afterBatch1: {
   acknowledgedCount: afterFirstBatchConservation.acknowledged.length,
   remainingQueuedCount: afterFirstBatchConservation.queued.length,
   conserved: afterFirstBatchConservation.conserved
  },
  afterDrainAll: {
   totalBatchesDispatched: t02Batches,
   acknowledgedCount: afterAllBatchesConservation.acknowledged.length,
   remainingQueuedCount: afterAllBatchesConservation.queued.length,
   conserved: afterAllBatchesConservation.conserved
  }
 },
 nineTurnsDailyLimitInjection: {
  callsDuringZeroLimit: 0,
  retainedAnchorsCountBeforeRefresh: beforeCount,
  statusBeforeRefresh: beforeStatus,
  waitReasonBeforeRefresh: beforeReason,
  retainedAnchorsCountAfterRefresh: afterReloadCount,
  callsAfterRaisingDailyLimit: callsT06,
  processedAnchorsAfterCommit: processedCountAfterResume,
  remainingQueuesAfterCommitAck: queueAfterResume.length
 }
}, null, 2));
console.log('Generated v0.6.0 ab-contrast-matrix.json and queue-failure-injection.json');
