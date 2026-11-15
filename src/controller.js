import { KEY, id, clone, effective, visible, ooc, deadline } from './util.js';
import { Database } from './storage.js';
import { Timeline, actors, chatOwner, messageActor } from './timeline.js';
import { Analyzer, knownMessages, makeAnalysisInput, applyAnalysis } from './analysis.js';
import { Embeddings, eligible, rank } from './retrieval.js';
import { compose, legacyEnabled } from './prompt.js';
export const DEFAULTS = Object.freeze({ enabled: true, autoAnalyze: true, recoveryPopup: true, promptBudget: 700,
    analysisProvider: 'st', analysisURL: '', analysisModel: '', embeddingEnabled: false, embeddingURL: '', embeddingModel: '',
    conflictMode: 'coexist', expressive: true, intensity: 65, dark: 35, unpredict: 40, eventRate: 20, independent: true });
export class Controller {
    constructor(context, { db, update = () => {}, recovery = async () => 'cancel' } = {}) {
        this.context = context; this.update = update; this.recovery = recovery; this.listeners = []; this.disposed = false;
        const c = context(); c.extensionSettings[KEY] ||= { ...DEFAULTS, accountId: id() };
        c.extensionSettings[KEY].accountId ||= id(); c.saveSettingsDebounced?.();
        this.db = db || new Database(c.extensionSettings[KEY].accountId); this.timeline = new Timeline(this.db);
        this.analyzer = new Analyzer(); this.embeddings = new Embeddings(this.db); this.chain = Promise.resolve();
        this.status = '正在打开人格数据库'; this.generation = null; this.epoch = 0; this.suspended = false; this.skipHashes = new Set(); this.secrets = {};
    }
    settings() { return { ...DEFAULTS, ...this.context().extensionSettings[KEY] }; }
    say(status) { this.status = status; try { this.update(this); } catch (e) { console.warn('[Lin Persona UI]', e); } }
    fail(error) { this.clearPrompt(); this.say(`已安全跳过：${error?.message || error}`); }
    enqueue(job) { const result = this.chain.then(() => this.disposed ? undefined : job()); this.chain = result.catch(e => this.fail(e)); return result; }
    clearPrompt() { try { this.context().setExtensionPrompt(KEY, '', 0, 0, false, 0); } catch { /* host may be unloading */ } }
    changeSettings(patch) {
        const c = this.context(); c.extensionSettings[KEY] = { ...this.settings(), ...patch }; c.saveSettingsDebounced?.();
        this.cancel(); this.clearPrompt(); this.retrieved = null; this.say('设置已保存');
    }
    cancel() { this.epoch++; this.analyzer.cancel(); this.embeddings.cancel(); clearTimeout(this.analysisTimer); }
    snapshot() {
        const c = this.context();
        return { owner: chatOwner(c), metadata: clone(c.chatMetadata?.[KEY]), chat: clone(c.chat || []), cast: actors(c), group: !!c.groupId };
    }
    async sync({ recovery = false, allowDuringGeneration = false, beforeSwipe = false, detectUnexpected = false } = {}) {
        if (this.generation?.busy && !allowDuringGeneration) return;
        const capture = this.snapshot(); if (!capture.owner) { this.clearPrompt(); this.say('请打开一个角色聊天'); return; }
        if (beforeSwipe && effective(capture.chat.at(-1))) capture.chat.pop();
        const prior = this.timeline.node, previousOwner = this.timeline.stream?.owner;
        const result = await this.timeline.sync({ ...capture, skipHashes: this.skipHashes });
        if (this.disposed || chatOwner(this.context()) !== capture.owner) return;
        this.capture = capture;
        // Restore the current selected story, never a metadata head that points into the future.
        const unexpected = detectUnexpected && previousOwner === capture.owner && prior && !this.timeline.path.some(p => p.hash === prior.hash);
        if ((recovery && (result.missing || result.mismatch)) || unexpected) {
            this.clearPrompt(); this.suspended = true; this.say('恢复检查：聊天正文与人格快照标记不一致');
            if (this.settings().recoveryPopup) {
                const answer = await this.recovery({ ...result, current: this.timeline.node });
                if (this.disposed || chatOwner(this.context()) !== capture.owner) return;
                if (answer === 'rebuild') await this.timeline.rebuild();
                if (answer === 'disable') await this.timeline.update(s => ({ ...s, disabled: true }), '恢复后停用此存档');
                this.suspended = answer === 'cancel';
            } else this.suspended = false; // deterministic exact/nearest-prefix reconciliation, never foreign/future state
        } else if (previousOwner !== capture.owner) this.suspended = false;
        if (!this.suspended) {
            const c = this.context(); c.chatMetadata[KEY] = result.metadata;
            c.saveMetadataDebounced?.();
        }
        if (previousOwner !== capture.owner) this.retrieved = null;
        this.say(this.suspended ? '已取消人格恢复；正常聊天仍可使用。面板可重新检查。' : `已匹配当前分支 · ${this.timeline.node.state.influences.length} 条影响 · ${this.timeline.node.state.experiences.length} 条经历`);
        return result;
    }
    bind() {
        const c = this.context(), events = c.eventTypes || c.event_types;
        const on = (name, fn) => {
            if (!events?.[name]) return;
            const safe = (...args) => { if (this.disposed) return; try { const p = fn(...args); p?.catch?.(e => this.fail(e)); } catch (e) { this.fail(e); } };
            c.eventSource.on(events[name], safe); this.listeners.push([events[name], safe]);
        };
        on('GENERATION_STARTED', (type, options = {}, dry = false) => {
            if (dry) return;
            this.cancel(); this.clearPrompt();
            const kind = type || 'normal';
            if (!['normal', 'swipe', 'regenerate', 'continue'].includes(kind) || options.quiet_prompt || options.quietToLoud) { this.generation = null; return; }
            this.generation = { kind, busy: true, owner: chatOwner(this.context()), stopped: false, signal: options.signal,
                before: clone(this.context().chat || []), previousNode: clone(this.timeline.node) };
        });
        on('GENERATION_STOPPED', () => { if (this.generation) { this.generation.stopped = true; this.generation.busy = false; } this.cancel(); this.clearPrompt(); });
        // ST may emit ENDED before RECEIVED. Keep the transaction receipt until the rendered message arrives.
        on('GENERATION_ENDED', () => { if (this.generation) this.generation.busy = false; });
        on('CHARACTER_MESSAGE_RENDERED', (index, type) => this.received(index, type));
        for (const name of ['CHAT_CHANGED', 'CHAT_LOADED']) on(name, () => {
            this.cancel(); this.generation = null; this.clearPrompt();
            clearTimeout(this.syncTimer); this.syncTimer = setTimeout(() => this.enqueue(() => this.sync({ recovery: true })).catch(() => {}), 50);
        });
        for (const name of ['MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_SENT', 'MORE_MESSAGES_LOADED']) on(name, () => {
            if (this.generation?.busy) return;
            this.cancel(); this.clearPrompt(); clearTimeout(this.syncTimer);
            this.syncTimer = setTimeout(() => this.enqueue(async () => { await this.sync(); this.scheduleAnalysis(); }).catch(() => {}), 150);
        });
        on('APP_READY', () => { setTimeout(() => this.enqueue(() => this.sync({ recovery: true })).catch(() => {}), 0); });
        return this;
    }
    async received(index, type) {
        const g = this.generation, c = this.context(), m = c.chat?.[index];
        if (!g || !Number.isInteger(index) || g.owner !== chatOwner(c) || !['normal', 'swipe', 'regenerate', 'continue', 'append', 'appendfinal'].includes(type || 'normal')) return;
        const aborted = g.stopped || g.signal?.aborted || (c.streamingProcessor?.messageId === index && c.streamingProcessor?.abortController?.signal?.aborted);
        g.busy = false;
        const capture = this.snapshot(), paths = await this.timeline.fingerprints.of(capture.chat);
        if (aborted || !effective(m) || c.streamingProcessor?.toolCalls?.length) {
            if (paths[index + 1]) this.skipHashes.add(paths[index + 1].hash);
            this.generation = null; this.clearPrompt(); await this.enqueue(() => this.sync()); this.say('停止、空回或工具回复：不推进人格寿命'); return;
        }
        // Defer past ST's rendering/save call stack. Re-check selection and chat before committing.
        clearTimeout(this.receiptTimer);
        this.receiptTimer = setTimeout(() => this.enqueue(async () => {
            if (g !== this.generation || chatOwner(this.context()) !== capture.owner || visible(this.context().chat[index]?.mes) !== visible(capture.chat[index]?.mes)) return;
            const before = g.before[index];
            if (g.kind === 'continue' && before && visible(m.mes).startsWith(visible(before.mes)) && g.previousNode?.length === capture.chat.length) {
                const row = paths.at(-1), oldHash = g.previousNode.hash, n = clone(g.previousNode), stream = this.timeline.stream;
                if (stream && n.stream === stream.id && n.parent === row.parent) {
                    n.hash = row.hash; n.key = `${stream.id}:${row.hash}`;
                    for (const e of n.state.experiences) for (const s of e.sources) if (s.node === oldHash && visible(m.mes).includes(s.quote)) { s.node = row.hash; s.key = row.hash; }
                    for (const b of n.state.blocks) b.evidence = b.evidence.map(x => x === oldHash ? row.hash : x);
                    if (n.state.grants[oldHash]) n.state.grants[row.hash] = clone(n.state.grants[oldHash]);
                    await this.db.put('nodes', n);
                }
            }
            this.generation = null;
            await this.sync(); this.scheduleAnalysis();
        }).catch(() => {}), 600);
    }
    async intercept(_chat, _maxContext, type = 'normal') {
        this.clearPrompt(); const g = this.generation, c = this.context();
        if (this.disposed || !this.settings().enabled || !g || !g.busy || g.owner !== chatOwner(c) || g.kind !== (type || 'normal') || g.signal?.aborted || this.suspended) return;
        const ticket = this.epoch;
        const work = this.enqueue(async () => {
            await this.sync({ allowDuringGeneration: true, beforeSwipe: g.kind === 'swipe', detectUnexpected: g.kind === 'normal' });
            const current = this.context(), state = this.timeline.node?.state;
            if (!state || this.suspended || ticket !== this.epoch || this.disposed || g !== this.generation) return '';
            const cast = actors(current), actor = cast.find(a => a.id === current.characters?.[current.characterId]?.avatar);
            if (!actor) return '';
            const lastUser = current.chat?.findLast(m => m.is_user && !m.is_system);
            if (ooc(lastUser?.mes)) return '';
            const legacy = legacyEnabled(current);
            if (legacy && this.settings().conflictMode === 'takeover') { this.say('请先在旧情绪插件设置中停用它，再使用完全接管'); return ''; }
            const known = knownMessages({ ...this.capture, path: this.timeline.path, actorId: actor.id, state });
            const query = known.slice(-4).map(x => x.text).join('\n');
            const cached = this.retrieved;
            const permitted = eligible(state, actor.id, this.timeline.path);
            const memories = rank(permitted, query, new Map(), null, 12);
            if (cached?.stream === this.timeline.stream.id && cached.actorId === actor.id && this.timeline.path.some(p => p.hash === cached.head)) {
                for (const m of memories) m.score += .32 * (cached.memories.find(e => e.id === m.id)?.score || 0);
                memories.sort((a, b) => b.score - a.score);
            }
            memories.splice(6);
            return compose({ actor, state, memories, settings: this.settings(), legacy,
                seed: `${this.timeline.stream.id}:${this.timeline.node.hash}:${actor.id}`, countTokens: current.getTokenCountAsync?.bind(current) });
        });
        const prompt = await deadline(work.catch(e => { this.fail(e); return ''; }), 450, '');
        if (ticket !== this.epoch || g !== this.generation || this.disposed || this.suspended || g.owner !== chatOwner(this.context())) return;
        this.context().setExtensionPrompt(KEY, prompt || '', 0, 0, false, 0);
        this.lastPrompt = prompt || ''; this.say(prompt ? `本轮已注入一段人格资料（预算 ${this.settings().promptBudget} tokens）` : '本轮没有适用的资料，已跳过注入');
    }
    scheduleAnalysis() {
        clearTimeout(this.analysisTimer);
        if (!this.settings().autoAnalyze || !this.settings().enabled || this.suspended) return;
        this.analysisTimer = setTimeout(async () => {
            const epoch = this.epoch;
            for (const actor of actors(this.context())) {
                if (epoch !== this.epoch || this.disposed || this.generation?.busy) break;
                try { await this.analyze(actor.id); } catch (e) { this.fail(e); break; }
            }
        }, 1000);
    }
    async analyze(actorId, all = false) {
        if (this.disposed || this.generation?.busy || this.analyzer.busy || this.suspended || !this.timeline.node || !this.settings().enabled) return;
        let rounds = 0;
        do {
            const capture = this.snapshot();
            if (capture.owner !== this.timeline.stream?.owner) return;
            const state = clone(this.timeline.node.state); if (state.disabled) return;
            const actor = capture.cast.find(x => x.id === actorId) || capture.cast.find(x => x.id === messageActor(capture.chat.findLast(m => effective(m)), capture.cast)) || capture.cast[0];
            if (!actor) return;
            const known = knownMessages({ ...capture, state, path: this.timeline.path, actorId: actor.id });
            const input = makeAnalysisInput({ actor, known, state, path: this.timeline.path });
            if (!input) { await this.refreshRetrieval(actor.id); this.say('当前角色的已授权剧情已分析完毕'); return; }
            const token = this.timeline.token(), epoch = this.epoch, path = clone(this.timeline.path);
            this.say(`正在分析 ${actor.name} 的 ${input.fresh.length} 条已知剧情${all ? '（重建中）' : ''}`);
            let result;
            try { result = await this.analyzer.run(input, this.settings(), this.context(), this.secrets.analysis); }
            catch (error) { if (epoch !== this.epoch || this.disposed) return; throw error; }
            if (epoch !== this.epoch || this.disposed || capture.owner !== chatOwner(this.context())) return;
            const next = await applyAnalysis(state, result, { actorId: actor.id, ...input, path });
            const saved = await this.enqueue(() => this.timeline.update(() => next, '依据剧情演化', token));
            if (!saved) { this.say('分析期间状态已变化，旧结果已丢弃'); return; }
            const query = known.slice(-4).map(x => x.text).join('\n');
            const updatedToken = this.timeline.token();
            const memories = await this.embeddings.retrieve({ state: next, actorId: actor.id, path, stream: this.timeline.stream.id, query, settings: this.settings(), secret: this.secrets.embedding });
            if (epoch === this.epoch && !this.disposed) this.retrieved = { ...updatedToken, stream: this.timeline.stream.id, head: this.timeline.node.hash, actorId: actor.id, memories };
            this.say(`分析完成：${next.influences.length} 条影响、${next.experiences.length} 条经历`);
        } while (all && ++rounds < 100 && !this.generation?.busy && !this.disposed);
    }
    async refreshRetrieval(actorId) {
        if (!this.timeline.node || this.disposed) return;
        const capture = this.snapshot(), state = clone(this.timeline.node.state), path = clone(this.timeline.path), stream = this.timeline.stream.id, head = this.timeline.node.hash, epoch = this.epoch;
        const known = knownMessages({ ...capture, path, state, actorId });
        const memories = await this.embeddings.retrieve({ state, actorId, path, stream, query: known.slice(-4).map(x => x.text).join('\n'), settings: this.settings(), secret: this.secrets.embedding });
        if (epoch === this.epoch && !this.disposed && capture.owner === chatOwner(this.context())) this.retrieved = { stream, head, actorId, memories };
    }
    async mutate(fn, label) {
        this.cancel(); this.clearPrompt(); const owner = chatOwner(this.context());
        return this.enqueue(async () => {
            if (owner !== this.timeline.stream?.owner || owner !== chatOwner(this.context())) throw new Error('聊天已切换，请重新操作');
            await this.timeline.update(fn, label); this.retrieved = null; this.say(`${label}：已保存到当前分支`);
        });
    }
    async resumeRecovery() { this.suspended = false; return this.enqueue(() => this.sync({ recovery: true })); }
    dispose() {
        this.disposed = true; this.cancel(); for (const t of ['syncTimer', 'receiptTimer', 'analysisTimer']) clearTimeout(this[t]);
        const bus = this.context().eventSource; for (const [event, fn] of this.listeners) (bus.removeListener || bus.off)?.call(bus, event, fn);
        this.listeners = []; this.clearPrompt(); this.db.close();
    }
}
