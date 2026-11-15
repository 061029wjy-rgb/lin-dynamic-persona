import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { Database } from '../src/storage.js';
import { Timeline } from '../src/timeline.js';
import { emptyState, userEdit } from '../src/model.js';
const cast = [{ id: 'fang.png', name: '方' }, { id: 'xin.png', name: '辛' }];
const user = mes => ({ name: '林', is_user: true, mes });
const reply = (mes, who = '方') => ({ name: who, original_avatar: who === '方' ? 'fang.png' : 'xin.png', mes });
async function fixture() { const db = new Database('test', new IDBFactory()); await db.open(); return { db, t: new Timeline(db) }; }
const sync = (t, chat, owner = 'A', metadata) => t.sync({ owner, chat, cast, metadata });
async function add(t) { await t.update(s => userEdit(s, { id: 'mood', layer: 'immediate', description: '暂时烦躁', duration: { mode: 'turns', remaining: 3 } }, 'fang.png')); }
test('P0: regeneration, swipe and replacement count exactly one owner reply', async () => {
 const { db, t } = await fixture(); const chat = [user('工作来了')]; await sync(t, chat); await add(t);
 await sync(t, [...chat, reply('第一稿')]); assert.equal(t.node.state.influences[0].duration.remaining, 2); const first = t.node.hash;
 await sync(t, [...chat, reply('第二稿')]); assert.equal(t.node.state.influences[0].duration.remaining, 2);
 await sync(t, [...chat, reply('第二稿追加')]); assert.equal(t.node.state.influences[0].duration.remaining, 2);
 await sync(t, [...chat, reply('第一稿')]); assert.equal(t.node.hash, first); assert.equal(t.node.state.influences[0].duration.remaining, 2);
 await sync(t, [...chat, reply('第一稿'), reply('辛在说话', '辛')]); assert.equal(t.node.state.influences[0].duration.remaining, 2); db.close();
});
test('P0: separate saves and copied checkpoints never borrow future or sibling changes', async () => {
 const { db, t } = await fixture(); const a = [user('约定'), reply('我记住了')];
 const initial = await sync(t, a); await add(t); const source = { ...initial.metadata, head: t.node.hash };
 await sync(t, [...a, user('A独有'), reply('A后果')]); await t.update(s => { s.influences[0].description = '只属于A的创伤'; return s; });
 await sync(t, a, 'B', source); assert.equal(t.node.state.influences[0].description, '暂时烦躁');
 await t.update(s => { s.influences[0].description = '只属于B的成长'; return s; });
 await sync(t, [...a, user('A独有'), reply('A后果')], 'A'); assert.equal(t.node.state.influences[0].description, '只属于A的创伤');
 await sync(t, a, 'new-save'); assert.equal(t.node.state.influences.length, 0); db.close();
});
test('P0: edit/delete ancestor rolls back; manual past edits invalidate stale descendants', async () => {
 const { db, t } = await fixture(); const a = [user('约定')]; await sync(t, a); await add(t);
 await sync(t, [...a, reply('答应')]); await t.update(s => { s.experiences.push({ id: 'future', actorId: 'fang.png', knownTo: ['fang.png'], sources: [] }); return s; });
 await sync(t, [user('改成陌生故事')]); assert.equal(t.node.state.influences.length, 0);
 await sync(t, a); await t.update(s => { s.influences[0].duration.remaining = 10; return s; });
 await sync(t, [...a, reply('答应')]); assert.equal(t.node.state.influences[0].duration.remaining, 9); assert.equal(t.node.state.experiences.length, 0); db.close();
});
test('P2: import uses fresh namespaces and rejects malformed backups atomically', async () => {
 const { db, t } = await fixture(); await sync(t, [user('开始')]); await add(t);
 const backup = await db.export(), imported = await db.import(backup); assert.notEqual(imported[0].id, t.stream.id);
 await t.adopt(imported[0].id); assert.equal(t.node.state.influences[0].description, '暂时烦躁');
 const invalid = structuredClone(backup); invalid.nodes[0].state = {};
 await assert.rejects(() => db.import(invalid)); assert.equal((await db.all('streams')).length, 2); assert.equal(backup.vectors, undefined); db.close();
});
test('P2: multi-tab stale revision cannot overwrite user edits', async () => {
 const { db, t } = await fixture(); await sync(t, [user('开始')]); const second = new Timeline(db); await sync(second, [user('开始')]);
 await add(t); await assert.rejects(() => second.update(() => emptyState())); assert.equal((await db.get('nodes', t.node.key)).state.influences.length, 1); db.close();
});
test('P0: ancestor revision invalidates multiple generations of descendants', async () => {
 const { db, t } = await fixture(); const a = [user('开始')]; await sync(t, a); await add(t);
 const future = [...a, reply('第一条'), user('继续'), reply('第二条')]; await sync(t, future);
 await t.update(s => { s.influences[0].description = '过时的未来'; return s; });
 await sync(t, a); await t.update(s => { s.influences[0].description = '重新选择'; s.influences[0].duration.remaining = 10; return s; });
 await sync(t, future); assert.equal(t.node.state.influences[0].description, '重新选择'); assert.equal(t.node.state.influences[0].duration.remaining, 8); db.close();
});
test('P0: out-of-story replies do not age roleplay state', async () => {
 const { db, t } = await fixture(); const a = [user('开始')]; await sync(t, a); await add(t);
 await sync(t, [...a, user('【戏外】修改一下风格'), reply('好的，接下来改写')]); assert.equal(t.node.state.influences[0].duration.remaining, 3); db.close();
});
