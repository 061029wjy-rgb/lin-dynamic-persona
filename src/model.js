import { clone, id, text, clamp } from './util.js';
export const LAYERS = ['acquired', 'short', 'immediate', 'goal'];
export const LABELS = { acquired: '后天人格', short: '短期心理', immediate: '即时影响', goal: '自主目标' };
export const emptyState = () => ({ influences: [], experiences: [], blocks: [], processed: {}, grants: {},
    world: { time: 0, scene: '', people: [], relationships: [], behaviors: [] }, turns: {}, disabled: false });
const list = v => Array.isArray(v) ? [...new Set(v.map(x => text(x, 160)).filter(Boolean))].slice(0, 64) : [];
export function normalizeInfluence(v, actorId) {
    if (!LAYERS.includes(v.layer) || !actorId || !String(v.description || '').trim()) throw new Error('影响需要角色、层级和描述');
    const duration = v.duration || {}, mode = ['turns', 'world', 'permanent'].includes(duration.mode) ? duration.mode :
        ['acquired', 'goal'].includes(v.layer) ? 'permanent' : 'turns';
    const count = Math.round(clamp(duration.remaining, 0, 10000, v.layer === 'short' ? 8 : 3));
    return { id: text(v.id || id(), 100), actorId, layer: v.layer, description: text(v.description),
        concept: text(v.concept || v.description, 220), selfView: text(v.selfView, 600), behavior: text(v.behavior, 600),
        rationale: text(v.rationale, 1200), intensity: clamp(v.intensity, 0, 1, .5), confidence: clamp(v.confidence, 0, 1, .5),
        scope: { people: list(v.scope?.people), scenes: list(v.scope?.scenes), relationships: list(v.scope?.relationships), behaviors: list(v.scope?.behaviors) },
        duration: { mode, remaining: mode === 'turns' ? count : null, until: mode === 'world' ? clamp(duration.until, 0, 1e12) : null,
            endCondition: text(duration.endCondition, 500) },
        enabled: v.enabled !== false, frozen: !!v.frozen, allowConsolidation: v.allowConsolidation !== false,
        expression: ['latent', 'natural'].includes(v.expression) ? v.expression : 'natural',
        status: v.status === 'retired' ? 'retired' : 'active', evidence: list(v.evidence),
        managedBy: v.managedBy === 'user' ? 'user' : 'auto', createdAt: v.createdAt || Date.now(), updatedAt: Date.now() };
}
export function active(x, world) {
    return x.enabled && x.status === 'active' && (x.frozen || x.duration.mode === 'permanent' ||
        (x.duration.mode === 'turns' ? x.duration.remaining > 0 : world.time < x.duration.until));
}
export function inScope(x, world) {
    const s = x.scope;
    return (!s.people.length || s.people.some(p => world.people.includes(p))) &&
        (!s.scenes.length || s.scenes.includes(world.scene)) &&
        (!s.relationships.length || s.relationships.some(p => world.relationships.includes(p))) &&
        (!s.behaviors.length || s.behaviors.some(p => world.behaviors.includes(p)));
}
export function tick(state, actorId) {
    const s = clone(state);
    if (!actorId || s.disabled) return s;
    s.turns[actorId] = (s.turns[actorId] || 0) + 1;
    for (const x of s.influences) if (x.actorId === actorId && active(x, s.world) && !x.frozen && x.duration.mode === 'turns')
        x.duration.remaining = Math.max(0, x.duration.remaining - 1);
    return s;
}
export function blocked(state, actorId, concept, evidence) {
    return state.blocks.some(b => b.actorId === actorId && (b.concept === concept || evidence.some(e => b.evidence.includes(e))));
}
export function userEdit(state, value, actorId) {
    const s = clone(state), x = normalizeInfluence({ ...value, managedBy: 'user' }, actorId);
    const old = s.influences.findIndex(i => i.id === x.id);
    if (old < 0) s.influences.push(x); else s.influences[old] = x;
    return s;
}
export function removeInfluence(state, influenceId, prevent = true) {
    const s = clone(state), x = s.influences.find(i => i.id === influenceId);
    if (!x) return s;
    if (prevent) {
        const evidence = s.experiences.filter(e => x.evidence.includes(e.id));
        s.blocks.push({ id: id(), actorId: x.actorId, concept: x.concept, evidence: evidence.flatMap(e => e.sources.map(z => z.key)), reason: '用户删除并禁止自动重建' });
    }
    s.influences = s.influences.filter(i => i.id !== influenceId);
    return s;
}
export function validateState(s) {
    if (!s || !Array.isArray(s.influences) || !Array.isArray(s.experiences) || !Array.isArray(s.blocks) || !s.world || !s.processed || !s.turns || !s.grants) throw new Error('快照结构无效');
    for (const x of s.influences) {
        if (!x.id || !x.actorId || !LAYERS.includes(x.layer) || !x.duration || !x.scope ||
            !['people', 'scenes', 'relationships', 'behaviors'].every(k => Array.isArray(x.scope[k]))) throw new Error('影响数据无效');
    }
    for (const e of s.experiences) if (!e.id || !e.actorId || !Array.isArray(e.sources) || !Array.isArray(e.knownTo)) throw new Error('经历数据无效');
    for (const b of s.blocks) if (!b.actorId || !Array.isArray(b.evidence)) throw new Error('屏蔽数据无效');
    return s;
}
