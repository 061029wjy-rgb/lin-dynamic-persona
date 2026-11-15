import { hash, safeURL } from './util.js';
export function terms(value) {
    const s = String(value || '').toLowerCase(), words = s.match(/[a-z0-9_]{2,}/g) || [], han = s.match(/[\p{Script=Han}]+/gu) || [];
    for (const part of han) { if (part.length === 1) words.push(part); for (let i = 0; i < part.length - 1; i++) words.push(part.slice(i, i + 2)); }
    return new Set(words);
}
export function lexical(a, b) {
    const x = terms(a), y = terms(b); let hit = 0;
    for (const w of x) if (y.has(w)) hit++;
    return hit / Math.max(1, Math.sqrt(x.size * y.size));
}
export function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length || !a.every(Number.isFinite) || !b.every(Number.isFinite)) return 0;
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
    return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
export function eligible(state, actorId, path) {
    const allowed = new Set(path.map(x => x.hash));
    return state.experiences.filter(e => e.actorId === actorId && e.knownTo.includes(actorId) &&
        e.sources.length && e.sources.every(s => allowed.has(s.node)) &&
        !state.blocks.some(b => b.actorId === actorId && e.sources.some(s => b.evidence.includes(s.key))));
}
export function rank(experiences, query, vectors = new Map(), queryVector, limit = 6) {
    return experiences.map((e, i) => ({ ...e, score: .58 * lexical(query, `${e.summary} ${e.appraisal}`) +
        .32 * Math.max(0, cosine(queryVector, vectors.get(e.id))) + .08 * (i + 1) / Math.max(1, experiences.length) + .02 * (e.salience || 0) }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
export class Embeddings {
    constructor(db, fetcher = globalThis.fetch) { this.db = db; this.fetcher = fetcher; this.controller = null; }
    cancel() { this.controller?.abort(); }
    async embed(input, settings, secret, signal) {
        const endpoint = safeURL(settings.embeddingURL);
        const r = await this.fetcher(endpoint, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
            body: JSON.stringify({ model: settings.embeddingModel, input }) });
        if (!r.ok) throw new Error(`Embedding HTTP ${r.status}`);
        const json = await r.json(), data = json.data?.sort((a, b) => a.index - b.index);
        if (!Array.isArray(data) || data.length !== input.length || data.some(x => !Array.isArray(x.embedding) || !x.embedding.length || x.embedding.length > 65536 || !x.embedding.every(Number.isFinite))) throw new Error('Embedding 返回格式无效');
        if (!data.every(x => x.embedding.length === data[0].embedding.length)) throw new Error('Embedding 维度不一致');
        return data.map(x => x.embedding);
    }
    async retrieve({ state, actorId, path, stream, query, settings, secret }) {
        const permitted = eligible(state, actorId, path); // Permissions checked BEFORE any remote transmission/search.
        if (!settings.embeddingEnabled || !settings.embeddingURL || !permitted.length) return rank(permitted, query);
        this.cancel(); this.controller = new AbortController();
        const { signal } = this.controller, timer = setTimeout(() => this.controller?.abort(), 8000);
        try {
            const modelKey = await hash(`${settings.embeddingURL}|${settings.embeddingModel}`), vectors = new Map();
            const pending = [];
            for (const e of permitted) {
                const content = `${e.summary}\n${e.appraisal}`, key = `${stream}:${actorId}:${modelKey}:${e.id}:${await hash(content)}`;
                const saved = await this.db.get('vectors', key);
                if (saved) vectors.set(e.id, saved.vector); else pending.push({ e, key, content });
            }
            // Bounded work per pass; repeated rebuilds fill older entries without deleting authoritative memories.
            const batch = pending.slice(-24);
            if (batch.length) {
                const values = await this.embed(batch.map(x => x.content), settings, secret, signal);
                for (let i = 0; i < batch.length; i++) { await this.db.put('vectors', { key: batch[i].key, vector: values[i] }); vectors.set(batch[i].e.id, values[i]); }
            }
            const [q] = await this.embed([query.slice(-3000)], settings, secret, signal);
            return rank(permitted, query, vectors, q);
        } catch { return rank(permitted, query); }
        finally { clearTimeout(timer); }
    }
}
