import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { IDBFactory } from './shims/indexeddb.js';
import { Controller, DEFAULTS } from '../src/controller.js';
import { Database } from '../src/storage.js';
import { KEY, clone } from '../src/util.js';
import { userEdit } from '../src/model.js';
import { compose } from '../src/prompt.js';
const events = Object.fromEntries(['GENERATION_STARTED','GENERATION_STOPPED','GENERATION_ENDED','CHARACTER_MESSAGE_RENDERED','CHAT_CHANGED','CHAT_LOADED','MESSAGE_SWIPED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SENT','APP_READY'].map(e => [e,e]));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const noopAbort = () => {};
async function fixture(recovery = async () => 'restore') {
 const prompts = [], c = { extensionSettings: {}, chatMetadata: {}, chatId: 'a', characterId: 0, characters: [{ name: '方', avatar: 'fang.png', personality: '克制' }], chat: [{ name: '林', is_user: true, mes: '工作来了' }], eventTypes: events, eventSource: new EventEmitter(), getCurrentChatId() { return this.chatId; }, saveSettingsDebounced() {}, saveMetadataDebounced() {}, getTokenCountAsync: async s => s.length, setExtensionPrompt: (...p) => prompts.push(p) };
 const db = new Database('test', new IDBFactory()), ctrl = new Controller(() => c, { db, recovery }); ctrl.bind(); ctrl.changeSettings({ autoAnalyze: false, localEvolution: false, expressive: false, promptBudget: 1200 }); await ctrl.enqueue(() => ctrl.sync());
 await ctrl.mutate(s => userEdit(s, { id: 'mood', layer: 'immediate', description: '工作带来的暂时烦躁', duration: { mode: 'turns', remaining: 3 } }, 'fang.png'), '添加');
 return { ctrl, c, prompts };
}
async function generate(f, kind, message) {
 f.c.eventSource.emit(events.GENERATION_STARTED, kind, {}, false);
 if (kind === 'regenerate') f.c.chat.pop();
 await f.ctrl.intercept(f.c.chat, 10000, noopAbort, kind);
 if (kind === 'swipe' || kind === 'continue') f.c.chat.at(-1).mes = message;
 else f.c.chat.push({ name: '方', mes: message });
 f.c.eventSource.emit(events.GENERATION_ENDED);
 f.c.eventSource.emit(events.CHARACTER_MESSAGE_RENDERED, f.c.chat.length - 1, kind);
 await sleep(650); await f.ctrl.chain;
}
test('P0: defaults disable extra AI analysis and recovery popup while enabling local evolution', () => {
 assert.equal(DEFAULTS.autoAnalyze, false);
 assert.equal(DEFAULTS.recoveryPopup, false);
 assert.equal(DEFAULTS.localEvolution, true);
 assert.equal(DEFAULTS.embeddingEnabled, false);
});
test('P2: end-before-render order, repeated swipes, regeneration and continue never double-tick', async () => {
 const f = await fixture(); await generate(f, 'normal', '第一稿'); assert.equal(f.ctrl.timeline.node.state.influences[0].duration.remaining, 2);
 await generate(f, 'swipe', '第二稿'); assert.equal(f.ctrl.timeline.node.state.influences[0].duration.remaining, 2);
 await generate(f, 'regenerate', '第三稿'); assert.equal(f.ctrl.timeline.node.state.influences[0].duration.remaining, 2);
 await generate(f, 'continue', '第三稿追加'); assert.equal(f.ctrl.timeline.node.state.influences[0].duration.remaining, 2);
 f.ctrl.dispose();
});
test('P2: stopped generation never consumes a turn and reload retains that decision', async () => {
 const f = await fixture(); f.c.eventSource.emit(events.GENERATION_STARTED, 'normal', {}, false); await f.ctrl.intercept(f.c.chat, 10000, noopAbort, 'normal');
 f.c.chat.push({ name: '方', mes: '部分输出' }); f.c.eventSource.emit(events.GENERATION_STOPPED); f.c.eventSource.emit(events.CHARACTER_MESSAGE_RENDERED, 1, 'normal');
 await sleep(30); await f.ctrl.chain; assert.equal(f.ctrl.timeline.node.state.influences[0].duration.remaining, 3);
 f.ctrl.skipHashes.clear(); await f.ctrl.enqueue(() => f.ctrl.sync()); assert.equal(f.ctrl.timeline.node.state.influences[0].duration.remaining, 3); f.ctrl.dispose();
});
test('P2: dry-run/quiet/impersonate bypass and main payload fields remain untouched under 4-parameter ST interceptor', async () => {
 const f = await fixture(); const settings = { vertex: 'gemini', thinking: { budget: 1200 }, prefill: 'Hello' }; const before = clone(settings); f.c.chatCompletionSettings = settings;
 for (const kind of ['quiet','impersonate']) { f.c.eventSource.emit(events.GENERATION_STARTED, kind, {}, false); await f.ctrl.intercept(f.c.chat, 10000, noopAbort, kind); }
 assert.equal(f.prompts.some(p => p[1]), false);
 f.c.eventSource.emit(events.GENERATION_STARTED, 'normal', {}, true); await f.ctrl.intercept(f.c.chat, 10000, noopAbort, 'normal'); assert.equal(f.prompts.some(p => p[1]), false);
 f.c.eventSource.emit(events.GENERATION_STARTED, 'normal', {}, false); await f.ctrl.intercept(f.c.chat, 10000, noopAbort, 'normal');
 assert.equal(f.prompts.filter(p => p[1]).length, 1); assert.deepEqual(settings, before); assert.equal(f.prompts.at(-1)[2], 0); f.ctrl.dispose();
});
test('P2: asynchronous analysis cannot land in another chat or overwrite a manual edit', async () => {
 const f = await fixture(); let finish; f.c.generateRaw = () => new Promise(resolve => { finish = resolve; });
 const pending = f.ctrl.analyze(); await sleep(10); f.c.chatId = 'b'; f.c.chatMetadata = {}; f.c.chat = [{ is_user: true, mes: 'B' }];
 f.c.eventSource.emit(events.CHAT_CHANGED); finish('{"experiences":[],"changes":[]}'); await pending; await sleep(80); await f.ctrl.chain;
 assert.equal(f.ctrl.timeline.node.state.influences.length, 0); assert.deepEqual(f.ctrl.timeline.node.state.processed, {}); f.ctrl.dispose();
});
test('P2: recovery cancellation skips persona injection without stopping normal generation', async () => {
 const f = await fixture(async () => 'cancel');
 f.ctrl.changeSettings({ recoveryPopup: true });
 f.c.chatMetadata[KEY].head = 'unknown'; await f.ctrl.enqueue(() => f.ctrl.sync({ recovery: true }));
 assert.equal(f.ctrl.suspended, true); f.c.eventSource.emit(events.GENERATION_STARTED, 'normal', {}, false); await f.ctrl.intercept(f.c.chat, 10000, noopAbort, 'normal');
 assert.equal(f.prompts.some(p => p[1]), false); f.ctrl.dispose();
});
test('P2: shared branch database unavailable fails open; no rejected interceptor reaches host', async () => {
 const f = await fixture(); f.ctrl.timeline.sync = async () => { throw new Error('quota'); };
 f.c.eventSource.emit(events.GENERATION_STARTED, 'normal', {}, false); await f.ctrl.intercept(f.c.chat, 10000, noopAbort, 'normal'); assert.equal(f.prompts.some(p => p[1]), false); assert.equal(f.ctrl.lastPrompt, ''); f.ctrl.dispose();
});
test('P2: prompt scopes, strict budget, deterministic guidance and legacy coexistence', async () => {
 const f = await fixture(), state = f.ctrl.timeline.node.state, settings = { ...f.ctrl.settings(), expressive: true, promptBudget: 900 };
 const args = { actor: { id: 'fang.png', name: '方' }, state, settings, seed: 'fixed', countTokens: s => s.length };
 assert.equal(await compose(args), await compose(args)); assert.ok((await compose(args)).length <= 900);
 assert.equal((await compose({ ...args, legacy: true })).includes('暂时烦躁'), false);
 state.influences[0].scope.people = ['甲方']; assert.equal((await compose({ ...args, settings: { ...settings, expressive: false } })), '');
 state.world.people = ['甲方']; assert.ok((await compose(args)).includes('暂时烦躁')); f.ctrl.dispose();
});
