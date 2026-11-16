import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from './shims/dom.js';
import { IDBFactory } from './shims/indexeddb.js';
import { EventEmitter } from 'node:events';
import { Controller } from '../src/controller.js';
import { Database } from '../src/storage.js';
import { Panel, recoveryDialog } from '../src/ui.js';
import { KEY } from '../src/util.js';
import { makeAnalysisInput, stageAnalysis } from '../src/analysis.js';
import { fixture, R, A } from './host-fixture.js';
const tick = () => new Promise(r => setTimeout(r, 20));
const click = label => [...document.querySelectorAll('button')].find(n => n.textContent === label)?.click();
test('P2: actual Chinese panel creates, edits, freezes and deletes safely; no HTML execution; mobile profile modal resets consent on model rename; proposal diff preview & cost ledger modal work', async () => {
 const window = new Window({ url: 'https://st.test/', width: 390, height: 844 }); globalThis.document = window.document; document.body.innerHTML = '<div id="extensions_settings2"></div>';
 const c = { extensionSettings: {}, chatMetadata: {}, chatId: 'test', characterId: 0, characters: [{ name: '方', avatar: 'fang.png', personality: '<script>danger()</script>' }], chat: [{ is_user: true, mes: 'hi' }, { name: '方', original_avatar: 'fang.png', mes: '方记下了排期。' }], eventTypes: {}, eventSource: new EventEmitter(), setExtensionPrompt() {}, saveSettingsDebounced() {}, saveMetadataDebounced() {} };
 const ctrl = new Controller(() => c, { db: new Database('ui', new IDBFactory()),readSaved:async()=>structuredClone(c.chat) }); await ctrl.sync(); const panel = new Panel(ctrl); panel.mount();panel.details.open=true;panel.render();
 click('＋ 创建影响'); const fields = [...document.querySelectorAll('dialog label')];
 fields.find(l => l.firstChild?.textContent === '描述').querySelector('textarea').value = '<img src=x onerror=alert(1)>短暂开心';
 click('保存到当前分支'); await tick(); await ctrl.chain; assert.equal(ctrl.timeline.node.state.influences.length, 1);
 assert.equal(document.querySelectorAll('article img').length, 0); click('冻结'); await tick(); assert.equal(ctrl.timeline.node.state.influences[0].frozen, true);
 click('删除'); click('确认删除'); await tick(); assert.equal(ctrl.timeline.node.state.influences.length, 0); assert.equal(ctrl.timeline.node.state.blocks.length, 1);
 click('设置'); click('保存设置'); await tick(); assert.ok(c.extensionSettings[KEY].accountId);
 ctrl.analyzer.save({ id: 'p-mobile', name: '移动副档', kind: 'compat', transport: 'direct', url: 'https://api.example/v1', model: 'm-v1', allowSend: true }, { key: 'sec-1' }, false, true);
 ctrl.changeSettings({ activeProfile: 'p-mobile' });
 click('副 API 与自动成长'); await tick();
 const modelInput = [...document.querySelectorAll('dialog label')].find(l => l.firstChild?.textContent === '实际模型 ID')?.querySelector('input');
 assert.ok(modelInput); modelInput.value = 'm-v2'; modelInput.dispatchEvent({ type: 'input' });
 click('保存并选为日常分析'); await tick();
 assert.equal(ctrl.analyzer.getProfile('p-mobile').allowSend, false);
 assert.equal(ctrl.analyzer.memory.has('p-mobile'), false);
 click('关闭'); await tick();

 // 测试待审提案的干运行差异预览弹窗与账本成本明细弹窗
 const live = ctrl.live('fang.png');
 const input = makeAnalysisInput(ctrl.options('fang.png'));
 const s1 = input.fresh.at(-1);
 const staged = stageAnalysis(ctrl.timeline.node.state, JSON.stringify({
  events: [{ ref: 'e1', sources: [{ sourceId: s1.id, quote: s1.text, offset: 0 }], agent: 'fang.png', action: '记下排期', modality: 'claim' }],
  proposals: [{ action: 'create', layer: 'short', description: '对近期排期保持关注', reason: '记下排期', support: ['e1'], psyche: { coping: '提前核对排期' }, basis: 'self_report', basisQuote: s1.text }]
 }), input, live);
 await ctrl.mutate(() => staged.state, '载入待审提案');
 panel.render();
 click('待审提案与事件 (1)'); await tick();
 click('预览拟更新状态差异（不写入）'); await tick();
 const activeDialog = () => [...document.querySelectorAll('dialog')].at(-1);
 assert.ok(activeDialog()?.textContent.includes('拟生成记录'));
 assert.equal(ctrl.timeline.node.state.influences.length, 0, '预览差异不写入状态');
 click('关闭'); await tick();
 click('分析预算与日志'); await tick();
 assert.ok(activeDialog()?.textContent.includes('Token与费用口径'));
 click('关闭'); await tick();

 panel.dispose(); ctrl.dispose(); window.happyDOM.abort(); delete globalThis.document;
});
test('P2: recovery dialog exposes restore/rebuild/disable/cancel and resolves cancellation', async () => {
 const window = new Window(); globalThis.document = window.document;
 const p = recoveryDialog({ exact: true, missing: false });
 for (const label of ['恢复匹配状态','重建自动人格','停用此存档','取消']) assert.ok([...document.querySelectorAll('button')].some(b => b.textContent === label));
 click('取消'); assert.equal(await p, 'cancel'); window.happyDOM.abort(); delete globalThis.document;
});

test('B22: Chinese Inspector renders ledger anomalies and retry requires explicit confirmation',async t=>{
 const window=new Window();globalThis.document=window.document;document.body.innerHTML='<div id="extensions_settings2"></div>';
 const previousConfirm=globalThis.confirm;let confirmed=0,calls=0;
 globalThis.confirm=()=>{confirmed++;return false;};
 const f=await fixture({chat:[R('沈青核对母带。')],settings:{analysisEnabled:true},ctx:{generateRaw:async()=>{calls++;throw Error('network');}}});
 const panel=new Panel(f.ctl);panel.mount();panel.details.open=true;panel.render();
 t.after(()=>{panel.dispose();f.ctl.dispose();window.happyDOM.abort();delete globalThis.document;if(previousConfirm===undefined)delete globalThis.confirm;else globalThis.confirm=previousConfirm;});
 await assert.rejects(f.ctl.analyze(A.avatar));await panel.analyzeDialog();
 assert.ok(document.querySelector('dialog').textContent.includes('已登记派发意图'));
 click('确认重发原失败批（额外 1 次）');await tick();assert.equal(confirmed,1);assert.equal(calls,1);
 click('关闭');await tick();
 const stream=f.ctl.timeline.stream.id,q=(await f.ctl.db.readQueueFacts(stream,A.avatar)).queue;
 await f.ctl.db.transaction(['usage'],'readwrite',tx=>tx.objectStore('usage').put({...q,anchors:[]}));
 panel.analysisLogsModal();await tick();const body=[...document.querySelectorAll('dialog')].at(-1).textContent;
 assert.ok(body.includes('"ok": false'));assert.ok(body.includes('unexpectedMissingIds'));assert.ok(body.includes(q.anchors[0]));
 assert.ok(body.includes('legacyUnverifiedCount'));assert.ok(body.includes('仅预留'));assert.ok(!body.includes('来源状态守恒'));
});
