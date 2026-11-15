import { clone, id, Fingerprints, effective, VERSION, ooc } from './util.js';
import { emptyState, tick } from './model.js';
export function chatOwner(c) {
    const chatId = c.getCurrentChatId?.() ?? c.chatId;
    const cast = c.groupId ? `group:${c.groupId}` : `character:${c.characters?.[c.characterId]?.avatar || ''}`;
    return chatId && (c.groupId || c.characters?.[c.characterId]) ? JSON.stringify([cast, String(chatId)]) : null;
}
export function actors(c) {
    const group = c.groups?.find(g => String(g.id) === String(c.groupId));
    return (c.characters || []).filter((x, i) => c.groupId ? group?.members?.includes(x.avatar) : i === Number(c.characterId))
        .map(x => ({ id: x.avatar, name: x.name, baseline: [x.description || x.data?.description, x.personality || x.data?.personality, x.scenario || x.data?.scenario].filter(Boolean).join('\n') }));
}
export function messageActor(m, cast) {
    if (!m || m.is_user || m.is_system) return null;
    if (m.original_avatar) return cast.find(a => a.id === m.original_avatar)?.id ?? null;
    const matches = cast.filter(a => a.name === m.name);
    return matches.length === 1 ? matches[0].id : cast.length === 1 ? cast[0].id : null;
}
export class Timeline {
    constructor(db) { this.db = db; this.fingerprints = new Fingerprints(); this.stream = null; this.node = null; this.path = []; }
    async locate(owner, metadata) {
        if (metadata?.version && metadata.version !== VERSION) throw new Error('人格元数据版本不兼容，请升级扩展或导入匹配备份');
        const streams = await this.db.all('streams');
        const bound = metadata?.stream && streams.find(s => s.id === metadata.stream && s.owner === owner);
        const own = bound || streams.filter(s => s.owner === owner).sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (own) return { stream: own, source: null, missing: false };
        const source = metadata?.stream ? streams.find(s => s.id === metadata.stream) : null;
        const streamId = id();
        return { stream: { key: streamId, id: streamId, owner, head: 'root', createdAt: Date.now(), updatedAt: Date.now() }, source, missing: !!metadata?.stream && !source };
    }
    async sync({ owner, metadata, chat, cast, skipHashes = new Set() }) {
        const found = await this.locate(owner, metadata);
        const stream = found.stream, path = await this.fingerprints.of(chat);
        let prev, exact = false, inherited = false, story = true;
        for (const row of path) {
            let node = await this.db.get('nodes', `${stream.id}:${row.hash}`);
            const stale = !!node && !!prev && node.parentRevision !== prev.revision;
            const staleRevision = stale ? node.revision + 1 : 0;
            const currentMessage = chat[row.index];
            if (currentMessage?.is_user) story = !ooc(currentMessage.mes);
            if (stale) node = null;
            if (!node && !stale && found.source) {
                const original = await this.db.get('nodes', `${found.source.id}:${row.hash}`);
                if (original) { node = { ...clone(original), key: `${stream.id}:${row.hash}`, stream: stream.id }; inherited = true; }
            }
            if (!node) {
                const state = prev ? clone(prev.state) : emptyState();
                const m = chat[row.index];
                node = { key: `${stream.id}:${row.hash}`, stream: stream.id, hash: row.hash, parent: row.parent,
                    length: row.index + 1, parentRevision: prev?.revision ?? null, revision: staleRevision, history: [], state: story && effective(m) && !skipHashes.has(row.hash) ? tick(state, messageActor(m, cast)) : state };
            } else if (row === path.at(-1)) exact = true;
            // Idempotent snapshots; descendants cannot read siblings or future evidence.
            if (stale || !await this.db.get('nodes', node.key)) await this.db.put('nodes', node);
            prev = node;
        }
        stream.head = prev.hash; stream.updatedAt = Date.now();
        await this.db.put('streams', stream);
        this.stream = stream; this.node = prev; this.path = path;
        return { missing: found.missing, inherited, exact, mismatch: !!metadata?.head && metadata.head !== prev.hash,
            metadata: { version: VERSION, stream: stream.id, owner, head: prev.hash } };
    }
    async update(fn, label = '编辑', expected) {
        if (!this.node || !this.stream) throw new Error('请先打开聊天');
        const n = clone(this.node);
        if (expected && (expected.key !== n.key || expected.revision !== n.revision)) return false;
        const next = fn(clone(n.state));
        n.history.push({ at: Date.now(), label, state: clone(n.state) });
        n.history = n.history.slice(-40); n.state = next; n.revision++;
        await this.db.commit({ ...this.stream, updatedAt: Date.now() }, n, this.node.revision);
        this.node = n;
        return true;
    }
    async undo(index = this.node?.history.length - 1) {
        const revision = this.node?.history[index];
        if (!revision) return false;
        return this.update(() => clone(revision.state), `回退：${revision.label}`);
    }
    async rebuild() {
        return this.update(s => ({ ...emptyState(), blocks: s.blocks, grants: s.grants, world: s.world,
            influences: s.influences.filter(x => x.managedBy === 'user' || x.frozen),
            experiences: s.experiences.filter(e => s.influences.some(x => (x.managedBy === 'user' || x.frozen) && x.evidence.includes(e.id))) }), '重建自动人格（保留人工记录和屏蔽）');
    }
    async adopt(streamId) {
        const source = await this.db.get('nodes', `${streamId}:${this.node.hash}`);
        if (!source) throw new Error('备份中没有与当前正文完全匹配的快照');
        return this.update(() => clone(source.state), '恢复匹配的备份快照');
    }
    token() { return this.node ? { key: this.node.key, revision: this.node.revision } : null; }
}
