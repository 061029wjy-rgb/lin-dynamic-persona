import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from './shims/dom.js';
import { IDBFactory } from './shims/indexeddb.js';
import { EventEmitter } from 'node:events';
import { Controller } from '../src/controller.js';
import { Database } from '../src/storage.js';
import { Panel, recoveryDialog } from '../src/ui.js';
import { KEY } from '../src/util.js';
const tick = () => new Promise(r => setTimeout(r, 20));
const click = label => [...document.querySelectorAll('button')].find(n => n.textContent === label)?.click();
test('P2: actual Chinese panel creates, edits, freezes and deletes safely; no HTML execution', async () => {
 const window = new Window({ url: 'https://st.test/' }); globalThis.document = window.document; document.body.innerHTML = '<div id="extensions_settings2"></div>';
 const c = { extensionSettings: {}, chatMetadata: {}, chatId: 'test', characterId: 0, characters: [{ name: '方', avatar: 'fang.png', personality: '<script>danger()</script>' }], chat: [{ is_user: true, mes: 'hi' }], eventTypes: {}, eventSource: new EventEmitter(), setExtensionPrompt() {}, saveSettingsDebounced() {}, saveMetadataDebounced() {} };
 const ctrl = new Controller(() => c, { db: new Database('ui', new IDBFactory()) }); await ctrl.sync(); const panel = new Panel(ctrl); panel.mount();
 click('＋ 创建影响'); const fields = [...document.querySelectorAll('dialog label')];
 fields.find(l => l.firstChild?.textContent === '描述').querySelector('textarea').value = '<img src=x onerror=alert(1)>短暂开心';
 click('保存到当前分支'); await tick(); await ctrl.chain; assert.equal(ctrl.timeline.node.state.influences.length, 1);
 assert.equal(document.querySelectorAll('article img').length, 0); click('冻结'); await tick(); assert.equal(ctrl.timeline.node.state.influences[0].frozen, true);
 click('删除'); click('确认删除'); await tick(); assert.equal(ctrl.timeline.node.state.influences.length, 0); assert.equal(ctrl.timeline.node.state.blocks.length, 1);
 click('设置'); click('保存设置'); await tick(); assert.ok(c.extensionSettings[KEY].accountId);
 panel.dispose(); ctrl.dispose(); window.happyDOM.abort(); delete globalThis.document;
});
test('P2: recovery dialog exposes restore/rebuild/disable/cancel and resolves cancellation', async () => {
 const window = new Window(); globalThis.document = window.document;
 const p = recoveryDialog({ exact: true, missing: false });
 for (const label of ['恢复匹配状态','重建自动人格','停用此存档','取消']) assert.ok([...document.querySelectorAll('button')].some(b => b.textContent === label));
 click('取消'); assert.equal(await p, 'cancel'); window.happyDOM.abort(); delete globalThis.document;
});
