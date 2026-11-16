import './shims/indexeddb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, normalizeInfluence, tick, removeInfluence, userEdit } from '../src/model.js';
import { Fingerprints, visible } from '../src/util.js';
const mood = (n = 3) => normalizeInfluence({ layer: 'immediate', description: '因工作需求反复修改而烦躁', duration: { mode: 'turns', remaining: n } }, 'fang.png');
test('P0: lifetime advances only for its owner and freezes completely', () => {
 const s = emptyState(); s.influences.push(mood());
 assert.equal(tick(s, 'npc.png').influences[0].duration.remaining, 3);
 assert.equal(tick(s, 'fang.png').influences[0].duration.remaining, 2);
 assert.equal(s.influences[0].duration.remaining, 3);
 s.influences[0].frozen = true; assert.equal(tick(s, 'fang.png').influences[0].duration.remaining, 3);
});
test('P0: delete creates evidence block; user edits own the record', () => {
 const s = emptyState(), x = mood(); x.evidence = ['e']; s.influences.push(x);
 s.experiences.push({ id: 'e', sources: [{ key: 'source' }] });
 const deleted = removeInfluence(s, x.id); assert.equal(deleted.influences.length, 0); assert.deepEqual(deleted.blocks[0].evidence, ['source']);
 assert.equal(userEdit(s, { ...x, description: '玩家改写' }, 'fang.png').influences[0].managedBy, 'user');
});
test('P0: selected story determines fingerprint, including swipe index but excluding hidden reasoning', async () => {
 const f = new Fingerprints(), a = [{ name: '方', mes: '回来了', extra: { reasoning: 'secret' } }];
 const p = await f.of(a); a[0].swipe_id = 3; a[0].extra.reasoning = 'changed';
 assert.notEqual((await f.of(a))[1].hash,p[1].hash);a[0].swipe_id=0;assert.equal((await f.of(a))[1].hash,p[1].hash);
 a[0].mes = '没有回来'; assert.notEqual((await f.of(a))[1].hash, p[1].hash);
 assert.equal(visible('<think>secret</think>你好'), '你好');
});
