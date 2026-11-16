import './shims/indexeddb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, removeInfluence } from '../src/model.js';
import { knownMessages, applyAnalysis, makeAnalysisInput, parseAnalysis, Analyzer } from '../src/analysis.js';
import { eligible, rank, cosine, Embeddings, SEMANTIC_CLUSTERS, semanticConceptVector } from '../src/retrieval.js';
const a = 'fang.png', node = 'branchA', bnode = 'branchB';
const source = { node, index: 0, speaker: '林', text: '我因为急诊失约了，之后会提前告知。' };
const opts = { actorId: a, known: [source], fresh: [source], path: [{ hash: node }] };
const result = () => ({ experiences: [{ ref: 'e1', summary: '对方因急诊失约并说明原因', appraisal: '可以理解原因但希望下次告知', sources: [{ node, quote: '因为急诊失约了' }] }],
 changes: [{ action: 'create', evidence: ['e1'], influence: { layer: 'acquired', concept: '约定需提前告知', description: '能理解意外，开始在约定时确认沟通方式', rationale: '急诊解释减轻不信任，但沟通缺失促使角色建立确认习惯', selfView: '我信任她', behavior: '仍会确认时间', scope: { people: ['林'] } } }] });
test('P1: evidence-grounded evolution supports revision, weakening, retirement and contradiction', async () => {
 const s = await applyAnalysis(emptyState(), result(), opts); assert.equal(s.influences.length, 1); assert.notEqual(s.influences[0].selfView, s.influences[0].behavior);
 const r = result(); r.changes[0].action = 'revise'; r.changes[0].targetId = s.influences[0].id; r.changes[0].influence.intensity = .2;
 const next = await applyAnalysis(s, r, opts); assert.equal(next.influences[0].intensity, .2);
 r.changes[0].action = 'retire'; assert.equal((await applyAnalysis(next, r, opts)).influences[0].status, 'retired');
});
test('P1: exact quotations and actor/branch permissions are mandatory', async () => {
 const bad = result(); bad.experiences[0].sources[0].quote = '我恨你'; await assert.rejects(() => applyAnalysis(emptyState(), bad, opts));
 bad.experiences[0].sources[0] = { node: bnode, quote: '因为急诊失约了' }; await assert.rejects(() => applyAnalysis(emptyState(), bad, opts));
 assert.throws(() => parseAnalysis('non json')); assert.throws(() => parseAnalysis('{"experiences":[]}'));
});
test('P1: tombstones block paraphrases; user, frozen and disabled records resist changes', async () => {
 const s = await applyAnalysis(emptyState(), result(), opts), removed = removeInfluence(s, s.influences[0].id);
 const retry = result(); retry.changes[0].influence.concept = '换名后的谨慎'; assert.equal((await applyAnalysis(removed, retry, opts)).influences.length, 0);
 for (const mode of ['user', 'frozen', 'disabled']) {
  const copy = structuredClone(s); if (mode === 'user') copy.influences[0].managedBy = 'user'; if (mode === 'frozen') copy.influences[0].frozen = true; if (mode === 'disabled') copy.influences[0].enabled = false;
  retry.changes[0].action = 'revise'; retry.changes[0].targetId = s.influences[0].id;
  assert.equal((await applyAnalysis(copy, retry, opts)).influences[0].concept, s.influences[0].concept);
 }
});
test('P1: disallowed consolidation cannot create acquired traits', async () => {
 const s = await applyAnalysis(emptyState(), result(), opts); s.influences[0].layer = 'immediate'; s.influences[0].allowConsolidation = false;
 const r = result(); r.changes[0].influence.concept = '新长期倾向'; assert.equal((await applyAnalysis(s, r, opts)).influences.length, 1);
});
test('P1: group chat automatically distinguishes public dialogue from secrets, private whispers and absence, with manual grant/revoke override', () => {
 const state = emptyState();
 const chat = [
  { name: '辛', original_avatar: 'xin.png', mes: '（心里暗想：这是我的秘密）' },
  { is_user: true, mes: '大家一起讨论接下来的行程吧' },
  { name: '辛', original_avatar: 'xin.png', mes: '私下对林说：别让方知道这件事' },
  { name: '旁白', is_user: true, mes: '方离开了房间去接电话' },
  { name: '辛', original_avatar: 'xin.png', mes: '趁他不在，我们商量一下惊喜' },
  { name: '旁白', is_user: true, mes: '方走进了房间' },
  { name: '辛', original_avatar: 'xin.png', mes: '“方，你回来得正好！”' }
 ];
 const path = [{ hash: 'root' }, { hash: 'n1' }, { hash: 'n2' }, { hash: 'n3' }, { hash: 'n4' }, { hash: 'n5' }, { hash: 'n6' }, { hash: 'n7' }];
 const data = { chat, path, cast: [{ id: a, name: '方' }, { id: 'xin.png', name: '辛' }], actorId: a, state, group: true };
 const known = knownMessages(data);
 assert.deepEqual(known.map(m => m.node), ['n2', 'n6', 'n7']);
 state.grants['n1'] = [a];
 state.revokes['n2'] = [a];
 assert.deepEqual(knownMessages(data).map(m => m.node), ['n1', 'n6', 'n7']);
});
test('P1: history discovery is chronological and not a last-three-turn summary', () => {
 const state = emptyState(), known = Array.from({ length: 35 }, (_, i) => ({ node: `n${i}`, index: i, text: '剧情' + i }));
 let x = makeAnalysisInput({ actor: { id: a }, known, state, path: [] }); assert.equal(x.fresh.length, 12); assert.equal(x.fresh[0].index, 0);
 state.processed[a] = x.fresh.map(v => v.node); x = makeAnalysisInput({ actor: { id: a }, known, state, path: [] }); assert.equal(x.fresh[0].index, 12);
});
test('P1: filter before ranking; 32-dim semantic vector, CJK search and dimension validation', async () => {
 assert.equal(SEMANTIC_CLUSTERS.length, 32);
 assert.equal(semanticConceptVector('急诊失约与暴雨延误').length, 32);
 const s = await applyAnalysis(emptyState(), result(), opts); s.experiences.push({ ...s.experiences[0], id: 'foreign', sources: [{ node: bnode }], summary: '急诊 急诊' }); s.experiences.push({ ...s.experiences[0], id: 'secret', knownTo: ['xin.png'] });
 const allowed = eligible(s, a, opts.path); assert.equal(allowed.length, 1); assert.equal(rank(allowed, '急诊')[0].id, s.experiences[0].id);
 assert.equal(cosine([1, 0], [1, 0]), 1); assert.equal(cosine([1], [1, 2]), 0); assert.equal(cosine([NaN], [1]), 0);
});
test('P1: embedding failure falls back without sending foreign records', async () => {
 const s = await applyAnalysis(emptyState(), result(), opts); s.experiences.push({ ...s.experiences[0], id: 'foreign', sources: [{ node: bnode }], summary: '秘密' });
 const sent = [], service = new Embeddings({ get: async () => null, put: async () => {} }, async (url, req) => { sent.push(JSON.parse(req.body)); return { ok: false, status: 500 }; });
 const found = await service.retrieve({ state: s, actorId: a, path: opts.path, stream: 'A', query: '失约', settings: { embeddingEnabled: true, embeddingURL: 'https://example.test/embeddings', embeddingModel: 'x' } });
 assert.equal(found.length, 1); assert.equal(JSON.stringify(sent).includes('秘密'), false);
});
test('P2: generateRaw never overrides responseLength/prefill/schema/provider settings', async () => {
 let params; await new Analyzer().run({ prompt: 'story', systemPrompt: 'analysis' }, { analysisProvider: 'st' }, { generateRaw: async p => { params = p; return '{"experiences":[],"changes":[]}'; } }); assert.deepEqual(Object.keys(params).sort(), ['prompt', 'systemPrompt', 'trimNames']);
});
test('P1: old transient feelings expire during historical catch-up while the event survives', async () => {
 const r = result(); r.changes[0].influence.layer = 'immediate'; r.changes[0].influence.duration = { mode: 'turns', remaining: 3 };
 const known = [source, ...Array.from({ length: 10 }, (_, i) => ({ node: `later${i}`, index: i + 1, actorOwn: true, effective: true, text: '后续剧情' }))];
 const s = await applyAnalysis(emptyState(), r, { ...opts, known }); assert.equal(s.influences[0].duration.remaining, 0); assert.equal(s.experiences.length, 1);
});
test('P1: nonconsolidating evidence cannot bypass protection by changing summary', async () => {
 const s = await applyAnalysis(emptyState(), result(), opts); s.influences[0].layer = 'immediate'; s.influences[0].allowConsolidation = false;
 const r = result(); r.experiences[0].summary = '同一事件换个说法'; r.changes[0].influence.concept = '换名的长期倾向';
 assert.equal((await applyAnalysis(s, r, opts)).influences.length, 1);
});
test('P1: valid embeddings are cached by scope/model and used in similarity ranking', async () => {
 const state = await applyAnalysis(emptyState(), result(), opts), cache = new Map(); let calls = 0;
 const service = new Embeddings({ get: async (s, k) => cache.get(k), put: async (s, v) => cache.set(v.key, v) }, async (u, req) => {
  calls++; return { ok: true, json: async () => ({ data: JSON.parse(req.body).input.map((_, index) => ({ index, embedding: [1, .5] })) }) };
 });
 const params = { state, actorId: a, path: opts.path, stream: 'A', query: '无相同关键词', settings: { embeddingEnabled: true, embeddingURL: 'https://example.test/embeddings', embeddingModel: 'x' } };
 const first = await service.retrieve(params); assert.ok(first[0].score >= .3); assert.equal(calls, 2);
 await service.retrieve(params); assert.equal(calls, 3); await service.retrieve({ ...params, stream: 'B' }); assert.equal(calls, 5);
});
