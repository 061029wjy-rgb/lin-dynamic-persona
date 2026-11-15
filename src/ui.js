import { KEY, clone, id, text } from './util.js';
import { actors, chatOwner } from './timeline.js';
import { LABELS, active, userEdit, removeInfluence } from './model.js';
const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') n.className = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k in n) n[k] = v;
        else n.setAttribute(k, v);
    }
    for (const child of children.flat()) if (child != null) n.append(typeof child === 'string' ? document.createTextNode(child) : child);
    return n;
};
const button = (label, fn, cls = '') => el('button', { type: 'button', class: `menu_button ldp-button ${cls}`, onclick: fn }, label);
const field = (label, input, hint) => el('label', { class: 'ldp-field' }, el('span', {}, label), input, hint ? el('small', {}, hint) : null);
const input = (value = '', type = 'text') => el('input', { type, value: String(value ?? ''), class: 'text_pole' });
const textarea = (value = '', rows = 3) => el('textarea', { value, rows, class: 'text_pole' });
const select = (options, value) => { const node = el('select', { class: 'text_pole' }, Object.entries(options).map(([k, v]) => el('option', { value: k }, v))); node.value = value; return node; };
const toggle = (label, checked, fn) => { const c = el('input', { type: 'checkbox', checked, onchange: () => fn(c.checked) }); return el('label', { class: 'ldp-check' }, c, label); };
const split = value => value.split(/[,，\n]/).map(x => x.trim()).filter(Boolean);
export function modal(title, build) {
    const dialog = el('dialog', { class: 'ldp-dialog' }), content = el('div', { class: 'ldp-dialog-body' });
    const close = () => { dialog.close(); dialog.remove(); };
    dialog.append(el('div', { class: 'ldp-modal-title' }, el('h3', {}, title), button('关闭', close)), content);
    build(content, close, dialog); document.body.append(dialog); dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove());
    return dialog;
}
export function recoveryDialog(info) {
    return new Promise(resolve => {
        let settled = false;
        const done = (answer, close) => { settled = true; resolve(answer); close(); };
        const dialog = modal('人格快照一致性检查', (body, close) => {
            body.append(el('p', {}, info.missing ? '此聊天携带的人格数据库标记在当前浏览器中不存在。可导入备份，或从当前分支重新分析。' : '检测到聊天恢复、检查点或分支切换。将依据当前所选正文恢复状态，未来剧情不会带入。'),
                el('p', {}, info.exact ? '已找到与当前正文完全匹配的快照。' : '没有完整匹配的快照；已退回共同前缀，后续自动状态需要重新分析。'),
                el('div', { class: 'ldp-actions' },
                    button('恢复匹配状态', () => done('restore', close)), button('重建自动人格', () => done('rebuild', close)),
                    button('停用此存档', () => done('disable', close)), button('取消', () => done('cancel', close))));
        });
        dialog.addEventListener('close', () => { if (!settled) resolve('cancel'); });
    });
}
function download(name, body, type = 'application/json') {
    const url = URL.createObjectURL(new Blob([body], { type })), a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export class Panel {
    constructor(controller) { this.c = controller; this.actorId = ''; this.filter = 'all'; }
    safe(fn) { const owner = this.c.timeline.stream?.owner; return async () => { try { if (owner && (owner !== this.c.timeline.stream?.owner || owner !== chatOwner(this.c.context()))) throw new Error('聊天已切换，请重新打开面板操作'); await fn(); this.render(); } catch (e) { this.c.say(`操作未完成：${e.message}`); } }; }
    mount() {
        if (this.root?.isConnected) return;
        const target = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
        if (!target) return;
        this.status = el('p', { class: 'ldp-status', 'aria-live': 'polite' });
        this.content = el('div', { class: 'ldp-content' });
        const details = el('details', { open: false }, el('summary', {}, 'Lin Dynamic Persona · 动态人格'), this.status, this.content);
        this.root = el('section', { id: 'lin-dynamic-persona', class: 'ldp' }, details); target.append(this.root); this.render();
    }
    render() {
        this.mountIfNeeded?.(); if (!this.root) return;
        this.status.textContent = this.c.status;
        const cast = actors(this.c.context()), s = this.c.settings(), state = this.c.timeline.node?.state;
        if (!cast.some(a => a.id === this.actorId)) this.actorId = cast[0]?.id || '';
        const actorSelect = select(Object.fromEntries(cast.map(a => [a.id, `${a.name} · ${a.id}`])), this.actorId);
        actorSelect.addEventListener('change', () => { this.actorId = actorSelect.value; this.render(); });
        const layerSelect = select({ all: '全部层级', ...LABELS }, this.filter); layerSelect.onchange = () => { this.filter = layerSelect.value; this.render(); };
        const toolbar = el('div', { class: 'ldp-actions' }, button('＋ 创建影响', () => this.edit()), button('设置', () => this.settings()),
            button('分析当前角色', this.safe(() => this.c.analyze(this.actorId))), button('原始人设（只读）', () => this.baseline()));
        const top = el('div', {}, toggle('启用动态人格', s.enabled, v => this.c.changeSettings({ enabled: v })),
            el('p', { class: 'ldp-muted' }, '经历改变角色，玩家保留编辑权。数据保存在本浏览器独立数据库中；换设备请导出备份。'),
            field('当前角色', actorSelect), field('显示层级', layerSelect), toolbar);
        const records = el('div', { class: 'ldp-records' });
        const rows = (state?.influences || []).filter(x => x.actorId === this.actorId && (this.filter === 'all' || x.layer === this.filter));
        if (!rows.length) records.append(el('p', { class: 'ldp-empty' }, '还没有此类影响。可以手动创建，或让分析器从已知剧情中发现。'));
        for (const x of rows) {
            const life = x.duration.mode === 'turns' ? `剩余 ${x.duration.remaining} 次本人回复` : x.duration.mode === 'world' ? `至剧情分钟 ${x.duration.until}` : '持续存在';
            const tags = [LABELS[x.layer], life, !active(x, state.world) ? '未生效/已消退' : '', x.frozen ? '已冻结' : '', x.managedBy === 'user' ? '人工管理' : '自动演化'].filter(Boolean);
            const card = el('article', { class: 'ldp-card' }, el('div', { class: 'ldp-tags' }, tags.join(' · ')), el('strong', {}, x.concept),
                el('p', {}, x.description), el('small', {}, `强度 ${Math.round(x.intensity * 100)}% · ${x.evidence.length} 条依据 · ${x.expression === 'latent' ? '允许全程内隐' : '按场景自然表达'}`),
                el('div', { class: 'ldp-actions' }, button('编辑', () => this.edit(x)), button(x.frozen ? '解冻' : '冻结', this.safe(() => this.c.mutate(st => { st.influences.find(i => i.id === x.id).frozen = !x.frozen; return st; }, x.frozen ? '解冻' : '冻结'))),
                    button(x.enabled ? '禁用' : '启用', this.safe(() => this.c.mutate(st => { st.influences.find(i => i.id === x.id).enabled = !x.enabled; return st; }, '切换影响启用状态'))),
                    button('依据', () => this.evidence(x)), button('删除', () => this.remove(x), 'ldp-danger')));
            records.append(card);
        }
        const tools = el('details', {}, el('summary', {}, '剧情范围、记忆与恢复'), el('div', { class: 'ldp-actions' },
            button('场景与剧情时间', () => this.world()), button('角色知情授权', () => this.knowledge()), button('全部经历', () => this.evidence()),
            button('修订与回退', () => this.history()), button('证据屏蔽', () => this.blocks()), button('检查恢复', this.safe(() => this.c.resumeRecovery())),
            button('导出完整备份', this.safe(async () => download(`lin-persona-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await this.c.db.export(), null, 2)))),
            button('导入备份', () => this.importBackup()), button('采用备份快照', this.safe(() => this.adopt())),
            button('重建人格', () => this.rebuild()), button('重建向量索引', this.safe(async () => { await this.c.db.clearVectors(); this.c.retrieved = null; await this.c.refreshRetrieval(this.actorId); this.c.say('向量索引已重建当前批次；更多经历会在后续检索中逐批填充'); })),
            button('查看本轮注入', () => modal('本轮注入预览', b => b.append(el('pre', {}, this.c.lastPrompt || '本轮未注入'))))));
        if (state?.disabled) top.append(button('重新启用此存档', this.safe(() => this.c.mutate(st => ({ ...st, disabled: false }), '启用此存档'))));
        this.content.replaceChildren(top, records, tools);
    }
    baseline() { const actor = actors(this.c.context()).find(a => a.id === this.actorId); modal('原始角色卡 · 只读', b => b.append(el('pre', {}, actor?.baseline || '没有可读取的角色描述'))); }
    edit(record) {
        if (!this.actorId || !this.c.timeline.node) return this.c.say('请先打开角色聊天');
        const actorId = record?.actorId || this.actorId;
        modal(record ? '编辑影响' : '创建影响', (body, close) => {
            const v = record || { id: id(), layer: 'immediate', description: '', duration: { mode: 'turns', remaining: 3 }, scope: {}, intensity: .55, allowConsolidation: true };
            const layer = select(LABELS, v.layer), concept = input(v.concept), description = textarea(v.description), rationale = textarea(v.rationale), selfView = textarea(v.selfView, 2), behavior = textarea(v.behavior, 2);
            const strength = input(Math.round(v.intensity * 100), 'number'); strength.min = '0'; strength.max = '100';
            const mode = select({ turns: '本角色有效回复次数', world: '剧情时间（手动推进）', permanent: '持续存在' }, v.duration.mode), remaining = input(v.duration.remaining ?? 3, 'number'), until = input(v.duration.until || 0, 'number'), end = input(v.duration.endCondition);
            const scope = Object.fromEntries(['people', 'scenes', 'relationships', 'behaviors'].map(k => [k, input((v.scope[k] || []).join(', '))]));
            const expression = select({ natural: '按场景自然选择，可不表现', latent: '允许全程内隐' }, v.expression || 'natural');
            let allow = v.allowConsolidation, frozen = !!v.frozen, enabled = v.enabled !== false, managed = v.managedBy || 'user';
            const ownership = select({ user: '人工管理：自动分析不可改写', auto: '允许自动演化' }, managed);
            body.append(field('层级', layer), field('倾向名称', concept), field('描述', description), field('形成原因/反证', rationale), field('自我认知', selfView), field('实际行为与矛盾', behavior),
                field('影响强度（0–100）', strength), field('生命周期', mode), field('剩余回复次数', remaining), field('结束剧情分钟', until), field('结束条件', end, '自然语言条件由后续分析判断，也可手动结束。'),
                field('人物范围', scope.people, '逗号分隔的角色 avatar ID 或当前场景人物名称；空为不限。'), field('场景范围', scope.scenes), field('关系范围', scope.relationships), field('行为范围', scope.behaviors),
                field('外在表现', expression), field('编辑权限', ownership), toggle('允许长期沉淀', allow, x => { allow = x; }), toggle('冻结内容和生命周期', frozen, x => { frozen = x; }), toggle('参与生成', enabled, x => { enabled = x; }));
            body.append(button('保存到当前分支', this.safe(async () => {
                if (!description.value.trim()) throw new Error('请填写描述');
                await this.c.mutate(st => {
                    const next = userEdit(st, { ...v, layer: layer.value, concept: concept.value, description: description.value, rationale: rationale.value, selfView: selfView.value, behavior: behavior.value,
                        intensity: Number(strength.value) / 100, scope: Object.fromEntries(Object.entries(scope).map(([k, x]) => [k, split(x.value)])),
                        duration: { mode: mode.value, remaining: Number(remaining.value), until: Number(until.value), endCondition: end.value }, expression: expression.value, allowConsolidation: allow, frozen, enabled }, actorId);
                    next.influences.find(x => x.id === v.id).managedBy = ownership.value; return next;
                }, '保存影响'); close();
            })));
        });
    }
    remove(x) {
        modal('删除影响', (b, close) => {
            let prevent = true;
            b.append(el('p', {}, `删除「${x.concept}」。源经历仍保留，可单独管理。`), toggle('屏蔽相同证据与概念，禁止自动重建', true, v => { prevent = v; }),
                button('确认删除', this.safe(async () => { await this.c.mutate(st => removeInfluence(st, x.id, prevent), '删除影响'); close(); })));
        });
    }
    evidence(influence) {
        const state = this.c.timeline.node?.state; if (!state) return;
        modal('经历与剧情依据', b => {
            const rows = state.experiences.filter(e => e.actorId === this.actorId && (!influence || influence.evidence.includes(e.id)));
            if (!rows.length) b.append(el('p', {}, '没有自动证据。人工创建的影响可以没有剧情引用。'));
            for (const e of rows) b.append(el('article', { class: 'ldp-card' }, el('strong', {}, e.summary), el('p', {}, `主观理解：${e.appraisal}`),
                ...e.sources.map(s => el('blockquote', {}, `#${s.index + 1}：${s.quote}`)), el('small', {}, `知情者：${e.knownTo.join(', ')}`),
                button('删除经历并屏蔽证据', this.safe(async () => {
                    await this.c.mutate(st => {
                        st.blocks.push({ id: id(), actorId: e.actorId, concept: '', evidence: e.sources.map(s => s.key), reason: '用户删除经历' });
                        st.experiences = st.experiences.filter(x => x.id !== e.id);
                        // Dependent automatic claims cannot remain active after their evidence is deleted.
                        for (const x of st.influences) if (x.evidence.includes(e.id)) { x.evidence = x.evidence.filter(y => y !== e.id); x.enabled = false; }
                        return st;
                    }, '删除经历'); b.closest('dialog').close();
                }))));
        });
    }
    world() {
        const world = this.c.timeline.node?.state.world; if (!world) return;
        modal('当前场景与剧情时间', (b, close) => {
            const scene = input(world.scene), time = input(world.time, 'number'), people = input(world.people.join(', ')), relationships = input(world.relationships.join(', ')), behaviors = input(world.behaviors.join(', '));
            b.append(field('场景标识', scene), field('剧情分钟（例如今晚结束设为 1440）', time), field('当前互动人物', people), field('当前关系', relationships), field('当前行为', behaviors),
                el('p', {}, '范围采取精确匹配。未指定场景时，限定场景的影响不参与注入。剧情时间不会跟随现实时间自动走动。'),
                button('更新场景', this.safe(async () => { await this.c.mutate(st => ({ ...st, world: { scene: scene.value, time: Math.max(0, Number(time.value)), people: split(people.value), relationships: split(relationships.value), behaviors: split(behaviors.value) } }), '更新剧情范围'); close(); })));
        });
    }
    knowledge() {
        const c = this.c; if (!c.timeline.node) return;
        modal('角色知情授权', (b, close) => {
            const actorId = this.actorId, path = c.timeline.path, grants = clone(c.timeline.node.state.grants);
            b.append(el('p', {}, '本人的发言和单聊中用户的内容默认可供分析。群聊中的他人消息需逐条授权；只授权角色确实看到或被告知的事实。取消授权会移除依赖该消息的自动记录。'));
            const choices = [];
            for (let i = 0; i < (c.capture?.chat.length || 0); i++) {
                const m = c.capture.chat[i], row = path[i + 1]; if (m.is_system || !row) continue;
                const checked = !!grants[row.hash]?.includes(actorId); choices.push({ node: row.hash, checked, original: checked });
                const choice = choices.at(-1);
                b.append(toggle(`#${i + 1} ${m.name || '用户'}：${text(m.mes, 160)}`, checked, v => { choice.checked = v; }));
            }
            b.append(button('保存知情范围', this.safe(async () => { await c.mutate(st => {
                const revoked = new Set(choices.filter(x => x.original && !x.checked).map(x => x.node));
                for (const x of choices) { st.grants[x.node] = (st.grants[x.node] || []).filter(a => a !== actorId); if (x.checked) st.grants[x.node].push(actorId); }
                const removed = new Set(st.experiences.filter(e => e.actorId === actorId && e.sources.some(z => revoked.has(z.node))).map(e => e.id));
                st.experiences = st.experiences.filter(e => !removed.has(e.id));
                st.influences = st.influences.filter(x => x.actorId !== actorId || !x.evidence.some(e => removed.has(e)));
                st.processed[actorId] = (st.processed[actorId] || []).filter(n => !revoked.has(n)); return st;
            }, '更新知情权限'); close(); })));
        });
    }
    history() {
        const revisions = this.c.timeline.node?.history || [];
        modal('当前节点的修订历史', (b, close) => {
            if (!revisions.length) b.append(el('p', {}, '当前节点没有修订。切换聊天分支会自动恢复对应节点。'));
            revisions.forEach((r, i) => b.append(button(`回到 ${new Date(r.at).toLocaleString()}「${r.label}」之前`, this.safe(async () => { this.c.cancel(); await this.c.enqueue(() => this.c.timeline.undo(i)); this.c.say('已回退人格修订'); close(); }))));
        });
    }
    blocks() {
        modal('禁止自动重建的证据', (b, close) => {
            const blocks = this.c.timeline.node?.state.blocks || [];
            if (!blocks.length) b.append(el('p', {}, '当前分支没有屏蔽规则。'));
            for (const x of blocks) b.append(el('article', { class: 'ldp-card' }, el('p', {}, `${x.concept || '剧情证据'} · ${x.evidence.length} 条 · ${x.reason}`),
                button('解除屏蔽', this.safe(async () => { await this.c.mutate(st => ({ ...st, blocks: st.blocks.filter(z => z.id !== x.id) }), '解除证据屏蔽'); close(); }))));
        });
    }
    importBackup() {
        const file = input('', 'file'); file.accept = '.json,application/json';
        file.onchange = this.safe(async () => {
            const f = file.files[0]; if (!f) return; if (f.size > 100 * 1024 * 1024) throw new Error('备份超过 100 MB');
            const streams = await this.c.db.import(JSON.parse(await f.text())); this.c.say(`已导入 ${streams.length} 个独立备份存档；可选择采用完全匹配的快照`);
        }); file.click();
    }
    async adopt() {
        const streams = (await this.c.db.all('streams')).filter(s => s.imported);
        modal('从备份恢复当前分支', (b, close) => {
            if (!streams.length) b.append(el('p', {}, '请先导入 JSON 备份。'));
            for (const s of streams) b.append(button(s.importedOwner, this.safe(async () => { this.c.cancel(); await this.c.enqueue(() => this.c.timeline.adopt(s.id)); this.c.suspended = false; this.c.say('已恢复正文匹配的人格备份'); close(); })));
        });
    }
    rebuild() {
        modal('重建自动人格', (b, close) => b.append(el('p', {}, '保留人工管理、冻结记录与证据屏蔽。按时间顺序分析当前角色的已授权剧情，每批最多 12 条，会产生独立模型请求。最多连续分析 100 批，生成新剧情会中止。'),
            button('开始重建', this.safe(async () => { this.c.cancel(); await this.c.enqueue(() => this.c.timeline.rebuild()); close(); await this.c.analyze(this.actorId, true); }))));
    }
    settings() {
        const c = this.c, s = c.settings();
        modal('动态人格设置', (b, close) => {
            const values = {}, checks = {};
            const addInput = (key, label, type = 'text', hint) => { values[key] = input(s[key], type); b.append(field(label, values[key], hint)); };
            const addSelect = (key, label, options) => { values[key] = select(options, s[key]); b.append(field(label, values[key])); };
            const addCheck = (key, label) => { checks[key] = s[key]; b.append(toggle(label, s[key], v => { checks[key] = v; })); };
            addCheck('autoAnalyze', '自动发现经历（会额外调用模型）'); addCheck('recoveryPopup', '恢复不一致时弹窗');
            addInput('promptBudget', '单次注入 token 预算', 'number');
            addSelect('analysisProvider', '剧情分析连接', { st: '当前 ST 连接（generateRaw）', external: '独立 OpenAI 兼容接口' });
            addInput('analysisURL', '分析接口完整 URL', 'url', '例如 https://你的服务/v1/chat/completions；需允许浏览器 CORS。'); addInput('analysisModel', '分析模型');
            const akey = input(c.secrets.analysis || '', 'password'); b.append(field('分析 API Key（仅本页内存）', akey));
            addCheck('embeddingEnabled', '启用语义向量检索'); addInput('embeddingURL', 'Embedding 完整 URL', 'url', '例如 https://你的服务/v1/embeddings；只发送当前分支、当前角色已知经历。'); addInput('embeddingModel', 'Embedding 模型');
            const ekey = input(c.secrets.embedding || '', 'password'); b.append(field('Embedding API Key（仅本页内存）', ekey));
            addSelect('conflictMode', '旧情绪插件冲突策略', { coexist: '协作：旧插件负责即时情绪与自主落点', takeover: '完全接管：需先在旧插件中停用它', pause: '检测到旧插件时暂停本插件注入' });
            addCheck('expressive', '启用情绪/自主行为演出尺度'); addCheck('independent', '自主目标');
            for (const [key, label] of Object.entries({ intensity: '情绪烈度', dark: '阴暗面权重', unpredict: '行为随机性', eventRate: '生活插曲权重' })) { addInput(key, `${label}（0–100）`, 'number'); values[key].min = '0'; values[key].max = '100'; }
            b.append(el('p', {}, '这些数值只调叙事权重，不是好感度，也不会凭空生成长期人格。原始卡、世界书、预设始终不被写入。'), button('保存设置', this.safe(async () => {
                const patch = { ...checks };
                for (const [key, v] of Object.entries(values)) patch[key] = v.type === 'number' ? Math.max(0, Number(v.value) || 0) : v.value.trim();
                c.secrets.analysis = akey.value; c.secrets.embedding = ekey.value; c.changeSettings(patch); close();
            })));
        });
    }
    dispose() { this.root?.remove(); for (const d of document.querySelectorAll('.ldp-dialog')) d.close(); }
}
