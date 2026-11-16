import {profilesPanel} from './profile-ui.js';
import {secondOpinion} from './lab.js';
import {PSY_FIELDS, reviewEvent, mergeOccurrences, makeSummary} from './analysis.js';
import {previewProposalDiff} from './growth.js';
import {exportInspectorSample} from './prompt.js';
import { KEY, clone, id, text } from './util.js';
import { actors, chatOwner } from './timeline.js';
import {
    LABELS,
    EVIDENCE_TYPES,
    active,
    userEdit,
    removeInfluence,
    batchOperateInfluences,
    editExperience,
    extractBaseline,
    setBaselineOverride,
    setVariable,
    deleteVariable,
    discoverVariables,
    detectWorldContext,
} from './model.js';
import { permittedParts, verifyQuote, USER } from './sources.js';
import { RETRIEVAL_CAPABILITY_MODES } from './retrieval.js';

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
const field = (label, inputNode, hint) => el('label', { class: 'ldp-field' }, el('span', {}, label), inputNode, hint ? el('small', {}, hint) : null);
const input = (value = '', type = 'text') => el('input', { type, value: String(value ?? ''), class: 'text_pole' });
const textarea = (value = '', rows = 3) => el('textarea', { value, rows, class: 'text_pole' });
const select = (options, value) => {
    const node = el('select', { class: 'text_pole' }, Object.entries(options).map(([k, v]) => el('option', { value: k }, v)));
    node.value = value;
    return node;
};
const toggle = (label, checked, fn) => {
    const c = el('input', { type: 'checkbox', checked, onchange: () => fn(c.checked) });
    return el('label', { class: 'ldp-check' }, c, label);
};
const split = value => String(value || '').split(/[,，\n]/).map(x => x.trim()).filter(Boolean);

function parsePersonRulesInput(str) {
    const out = {};
    for (const line of String(str || '').split(/\r?\n/)) {
        const idx = line.search(/[:：]/);
        if (idx > 0) {
            const p = line.slice(0, idx).trim();
            const r = line.slice(idx + 1).trim();
            if (p && r) out[p] = r;
        }
    }
    return out;
}

function formatPersonRulesInput(rules = {}) {
    return Object.entries(rules).map(([k, v]) => `${k}：${v}`).join('\n');
}

export function modal(title, build) {
    const dialog = el('dialog', { class: 'ldp-dialog' }), content = el('div', { class: 'ldp-dialog-body' });
    const close = () => { if(dialog.close)dialog.close();else dialog.dispatchEvent(new Event('close'));dialog.remove(); };
    dialog.append(el('div', { class: 'ldp-modal-title' }, el('h3', {}, title), button('关闭', close)), content);
    build(content, close, dialog);
    document.body.append(dialog);
    if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');
    dialog.addEventListener('close', () => dialog.remove());
    return dialog;
}

export function recoveryDialog(info = {}) {
    return new Promise(resolve => {
        let settled = false;
        let dontRemindGlobal = false;
        let dontRemindChat = false;
        let selectedHash = '';

        const wrapAnswer = baseAction => {
            if (!dontRemindGlobal && !dontRemindChat && !selectedHash) return baseAction;
            return {
                action: selectedHash && baseAction === 'restore' ? 'select_snapshot' : baseAction,
                snapshotHash: selectedHash || null,
                dontRemindGlobal,
                dontRemindChat,
            };
        };

        const done = (answer, close) => { settled = true; resolve(wrapAnswer(answer)); close(); };
        const dialog = modal('人格快照一致性与版本差异检查', (body, close) => {
            body.append(
                el('p', {}, info.missing
                    ? '此聊天携带的人格数据库标记在当前浏览器中不存在。可导入备份，或从当前分支重新分析。'
                    : '检测到聊天恢复、检查点或分支切换。将依据当前所选正文恢复状态，未来剧情不会带入。'),
                el('p',{},'存档 '+(info.current?.stream||'').slice(0,12)+' · 当前楼层 '+(info.current?.length??'—')+' · '+(info.candidates?.length||0)+' 个共同历史版本'),
                el('p', {}, info.exact
                    ? '已找到与当前正文完全匹配的快照。'
                    : '没有完整匹配的快照；已退回共同前缀，后续自动状态可轻量演化或重新分析。')
            );

            if (info.diff?.hasChanges) {
                const diffBox = el('div', { class: 'ldp-card' }, el('strong', {}, '版本差异预览（对比切换前状态）'));
                if (info.diff.addedInfluences?.length) diffBox.append(el('p', {}, `＋ 新增/恢复影响：${info.diff.addedInfluences.join('、')}`));
                if (info.diff.removedInfluences?.length) diffBox.append(el('p', {}, `－ 移除/回退影响：${info.diff.removedInfluences.join('、')}`));
                if (info.diff.modifiedInfluences?.length) diffBox.append(el('p', {}, `Δ 变化影响：${info.diff.modifiedInfluences.join('、')}`));
                if (info.diff.addedExperiences?.length || info.diff.removedExperiences?.length) {
                    diffBox.append(el('small', {}, `经历变动：+${info.diff.addedExperiences?.length || 0} / -${info.diff.removedExperiences?.length || 0}`));
                }
                body.append(diffBox);
            }

            if (Array.isArray(info.candidates) && info.candidates.length > 0) {
                const opts = { '': '默认：采用当前正文匹配节点或最近共同前缀' };
                for (const c of info.candidates) {
                    opts[c.hash] = `节点 #${c.length || 0} (${String(c.hash).slice(0, 8)} · ${c.state?.influences?.length || 0}条影响 / 修订v${c.revision || 0})`;
                }
                const snapSelect = select(opts, '');
                snapSelect.onchange = () => { selectedHash = snapSelect.value; };
                body.append(field('选择要恢复的历史快照版本', snapSelect));
            }

            body.append(
                toggle('本聊天今后自动不再提示（不匹配时仍暂停）', false, v => { dontRemindChat = v; }),
                toggle('全局关闭恢复弹窗（不一致时静默暂停）', false, v => { dontRemindGlobal = v; }),
                el('div', { class: 'ldp-actions' },
                    button('恢复匹配状态', () => done('restore', close)),
                    button('重建自动人格', () => done('rebuild', close)),
                    button('停用此存档', () => done('disable', close)),
                    button('取消', () => done('cancel', close)))
            );
        });
        dialog.addEventListener('close', () => { if (!settled) resolve('cancel'); });
    });
}

function download(name, body, type = 'application/json') {
    const url = URL.createObjectURL(new Blob([body], { type })), a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class Panel {
    constructor(controller) {
        this.c = controller;
        this.actorId = '';
        this.filter = 'all';
        this.statusFilter = 'all';
        this.searchQuery = '';
        this.selectedIds = new Set();
    }

    safe(fn) {
        const owner = this.c.timeline.stream?.owner, token=this.c.timeline.token?.();
        return async () => {
            try {
                if (owner && (owner !== this.c.timeline.stream?.owner || owner !== chatOwner(this.c.context()))) {
                    throw new Error('聊天已切换，请重新打开面板操作');
                }
                if(token && this.c.timeline.matching && !this.c.timeline.matching(token))throw Error('打开界面后修订或 Swipe 已改变；请重新打开。');
                await fn();
                this.render();
            } catch (e) {
                this.c.say(`操作未完成：${e.message}`);
            }
        };
    }

    mount() {
        if (this.root?.isConnected) return;
        const target = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
        if (!target) return;
        this.status = el('p', { class: 'ldp-status', 'aria-live': 'polite' });
        this.content = el('div', { class: 'ldp-content' });
        const details = el('details', { open: false }, el('summary', {}, 'Lin Dynamic Persona · 动态人格 v0.6.0'), this.status, this.content);
        this.root = el('section', { id: 'lin-dynamic-persona', class: 'ldp' }, details);
        target.append(this.root);this.details=details;details.addEventListener("toggle",()=>{if(details.open)this.render();});
        this.render();
    }

    render() {
        this.mountIfNeeded?.();
        if (!this.root) return;
        this.status.textContent = this.c.status;if(this.details&&!this.details.open)return;
        const ctx = this.c.context();
        const cast = actors(ctx), s = this.c.settings(), state = this.c.timeline.node?.state;
        if (!cast.some(a => a.id === this.actorId)) this.actorId = cast[0]?.id || '';

        const actorSelect = select(Object.fromEntries(cast.map(a => [a.id, `${a.name} · ${a.id}`])), this.actorId);
        actorSelect.addEventListener('change', () => { this.actorId = actorSelect.value; this.selectedIds.clear(); this.render(); });

        const layerSelect = select({ all: '全部层级', ...LABELS }, this.filter);
        layerSelect.onchange = () => { this.filter = layerSelect.value; this.render(); };

        const statusSelect = select({
            all: '全部状态与权限',
            active: '当前生效中',
            retired: '已消退/已完成',
            frozen: '已冻结',
            user: '人工管理',
            auto: '自动演化',
        }, this.statusFilter);
        statusSelect.onchange = () => { this.statusFilter = statusSelect.value; this.render(); };

        const searchInput = input(this.searchQuery, 'search');
        searchInput.placeholder = '搜索倾向名称、描述、触发条件、行为策略或人物范围...';
        searchInput.onchange = () => { this.searchQuery = searchInput.value.trim(); this.render(); };

        const effectiveWorld = state ? detectWorldContext({ chat: ctx.chat || [], cast, state, userName: ctx.name1 || '' }) : { people: [], scene: '' };
        const arb = this.c.arbitrationStatus();
        const qInfo = this.c.queueSummary?.(this.actorId) || { label: '' };
        const pendingCount = (state?.proposals || []).filter(p => p.owner === this.actorId && p.reviewState === 'pending').length;
        const toolbar=el('div',{class:'ldp-actions'},button('＋ 创建影响',()=>this.edit()),button('副 API 与自动成长',()=>profilesPanel(this,{el,field,input,textarea,select,toggle,button,modal,download})),button('采用与撤销',()=>this.adoptionPanel()),button('待审提案与事件'+(pendingCount?` (${pendingCount})`:''),()=>this.inbox()),button('文字记忆与原文',()=>this.library()),button('设置',()=>this.settings()),button('分析本段',()=>this.analyzeDialog()),button('原始人设（只读）',()=>this.baseline()),button('人格成长树',()=>this.evolutionTree()),button('重抽情绪落点',()=>this.c.rerollEmotion()));
        const autoContextSummary=el('small',{class:'ldp-muted'},(s.analysisEnabled?'分析档：'+(s.activeProfile||'无')+' · 审批：'+s.approval+' · 队列状态：'+(qInfo.label||'空闲')+' · 预留/派发占用 '+s.analysisRequestsUsed+' 次':'纯本地 · 额外模型请求关闭')+' · '+RETRIEVAL_CAPABILITY_MODES.local+' · '+arb.summary);
        const top = el('div', {},
            toggle('启用动态人格', s.enabled, v => this.c.changeSettings({ enabled: v })),
            el('p', { class: 'ldp-muted' }, '经历改变角色，玩家掌握最高编辑权。尊重原始角色卡关系与冷漠/敌对设定，绝不无依据强制亲近。'),
            autoContextSummary,
            field('当前角色', actorSelect),
            field('显示层级', layerSelect),
            field('状态筛选', statusSelect),
            field('检索记录', searchInput),
            toolbar
        );

        const records = el('div', { class: 'ldp-records' });
        const q = this.searchQuery.toLowerCase();
        const rows = (state?.influences || []).filter(x => {
            if (x.actorId !== this.actorId) return false;
            if (this.filter !== 'all' && x.layer !== this.filter) return false;
            if (this.statusFilter === 'active' && !active(x, effectiveWorld)) return false;
            if (this.statusFilter === 'retired' && x.status !== 'retired' && active(x, effectiveWorld)) return false;
            if (this.statusFilter === 'frozen' && !x.frozen) return false;
            if (this.statusFilter === 'user' && x.managedBy !== 'user') return false;
            if (this.statusFilter === 'auto' && x.managedBy !== 'auto') return false;
            if (q) {
                const hay = `${x.concept} ${x.description} ${x.rationale} ${x.selfView} ${x.behavior} ${x.actionDecision || ''} ${(x.scope?.people || []).join(' ')}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });

        if (rows.length > 0) {
            const batchBar = el('div', { class: 'ldp-actions ldp-batch-bar' },
                el('small', {}, `已选 ${this.selectedIds.size}/${rows.length} 条：`),
                button('全选/反选', () => {
                    if (this.selectedIds.size === rows.length) this.selectedIds.clear();
                    else rows.forEach(r => this.selectedIds.add(r.id));
                    this.render();
                }),
                button('批量冻结', this.safe(async () => {
                    await this.c.mutate(st => batchOperateInfluences(st, [...this.selectedIds], 'freeze'), '批量冻结');
                })),
                button('批量解冻', this.safe(async () => {
                    await this.c.mutate(st => batchOperateInfluences(st, [...this.selectedIds], 'unfreeze'), '批量解冻');
                })),
                button('转人工保护', this.safe(async () => {
                    await this.c.mutate(st => batchOperateInfluences(st, [...this.selectedIds], 'setUser'), '批量设为人工管理');
                })),
                button('允许自动演化', this.safe(async () => {
                    await this.c.mutate(st => batchOperateInfluences(st, [...this.selectedIds], 'setAuto'), '批量设为自动演化');
                })),
                button('批量删除', this.safe(async () => {
                    const targets = [...this.selectedIds];
                    this.selectedIds.clear();
                    await this.c.mutate(st => batchOperateInfluences(st, targets, 'delete', { prevent: true }), '批量删除并屏蔽');
                }), 'ldp-danger')
            );
            records.append(batchBar);
        } else {
            records.append(el('p', { class: 'ldp-empty' }, '还没有匹配的影响记录。可以手动创建，或在对话中由演化引擎自动发现。'));
        }

        for (const x of rows) {
            const life = x.duration.mode === 'turns' ? `剩余 ${x.duration.remaining} 次本人回复` : x.duration.mode === 'world' ? `至剧情分钟 ${x.duration.until}` : '持续存在';
            const tags = [
                LABELS[x.layer],
                life,
                `优先级:${x.priority || 'medium'}`,
                !active(x, effectiveWorld) ? '未生效/已消退' : '',
                x.frozen ? '已冻结' : '',
                x.managedBy === 'user' ? '人工管理' : '自动演化',
            ].filter(Boolean);

            const selectBox = el('input', {
                type: 'checkbox',
                checked: this.selectedIds.has(x.id),
                onchange: e => {
                    if (e.target.checked) this.selectedIds.add(x.id);
                    else this.selectedIds.delete(x.id);
                    this.render();
                },
            });

            const detailLines = [];
            if (x.selfView || x.behavior) {
                detailLines.push(el('p', { class: 'ldp-subtext' }, `认知 vs 行为：${x.selfView || '未设'} ↔ ${x.behavior || '未设'}`));
            }
            if (x.actionDecision && x.actionDecision !== x.behavior) {
                detailLines.push(el('p', { class: 'ldp-subtext' }, `主动后天策略：${x.actionDecision}`));
            }
            if (x.layer === 'goal') {
                detailLines.push(el('p', { class: 'ldp-subtext' }, `目标进度：${x.progress || 0}% · 当前步骤：${x.currentStep || '推进中'}${x.blockers ? ` · 障碍：${x.blockers}` : ''}`));
            }

            const card = el('article', { class: 'ldp-card' },
                el('div', { class: 'ldp-tags' }, selectBox, ' ', tags.join(' · ')),
                el('strong', {}, x.concept),
                el('p', {}, x.description),
                ...detailLines,
                el('small', {}, `强度 ${Math.round(x.intensity * 100)}% · 置信度 ${Math.round((x.confidence ?? 0.7) * 100)}% · ${x.evidence.length} 条依据 · 演化 ${x.evolutionLog?.length || 1} 次 · ${x.expression === 'latent' ? '允许全程内隐' : '按场景自然表达'}`),
                el('div', { class: 'ldp-actions' },
                    button('编辑', () => this.edit(x)),
                    button(x.frozen ? '解冻' : '冻结', this.safe(() => this.c.mutate(st => { st.influences.find(i => i.id === x.id).frozen = !x.frozen; return st; }, x.frozen ? '解冻' : '冻结'))),
                    button(x.enabled ? '禁用' : '启用', this.safe(() => this.c.mutate(st => { st.influences.find(i => i.id === x.id).enabled = !x.enabled; return st; }, '切换影响启用状态'))),
                    button('依据', () => this.evidence(x)),
                    button('演化轨迹', () => this.evolutionTree(x)),
                    button('删除', () => this.remove(x), 'ldp-danger'))
            );
            records.append(card);
        }

        const tools = el('details', {}, el('summary', {}, '剧情范围、记忆、变量与恢复'), el('div', { class: 'ldp-actions' },
            button('场景与剧情时间', () => this.world()),
            button('角色知情授权', () => this.knowledge()),
            button('全部经历', () => this.evidence()),
            button('可选手工字段', () => this.variablesModal()),
            button('人格成长树', () => this.evolutionTree()),
            button('修订与回退', () => this.history()),
            button('证据屏蔽', () => this.blocks()),
            button('分析预算与日志', () => this.analysisLogsModal()),
            button('检查恢复', this.safe(() => this.c.resumeRecovery(true))),
            button('导出完整备份', this.safe(async () => download(`lin-persona-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await this.c.db.export(), null, 2)))),
            button('导入备份', () => this.importBackup()),
            button('采用备份快照', this.safe(() => this.adopt())),
            button('重建人格', () => this.rebuild()),
            button('重建全文索引',this.safe(()=>this.c.refreshRetrieval(this.actorId))),button('旧版迁移与增量备份',()=>this.transfer()),
            button('查看本轮注入', () => modal('本轮主模型注入预览（非副 API 发送预览）', b => {
                const promptStr = (this.c.lastActor===this.actorId?this.c.lastPrompt:'') || '本角色本轮未注入';
                const sampleObj = exportInspectorSample(this.c.diag, this.c.lastActor===this.actorId?this.c.lastPrompt:'', { redact: true });
                b.append(
                    el('p', { class: 'ldp-muted' }, '此处仅展示主 RP 模型收到的角色心理增量（Single System Slot），绝不包含副 API 分析 JSON 或历史原文。'),
                    el('pre', {}, promptStr),
                    el('div', { class: 'ldp-actions' },
                        button('复制注入文本', () => { globalThis.navigator?.clipboard?.writeText?.(promptStr); this.c.say('已复制本轮注入文本'); }),
                        button('导出脱敏 Inspector 样本', () => download(`lin-inspector-sample-${Date.now()}.json`, JSON.stringify(sampleObj, null, 2)))
                    )
                );
            }))
        ));
        if (state?.disabled) top.append(button('重新启用此存档', this.safe(() => this.c.mutate(st => ({ ...st, disabled: false }), '启用此存档'))));
        this.content.replaceChildren(top, records, tools);
    }

    baseline() {
        const actor = actors(this.c.context()).find(a => a.id === this.actorId);
        const state = this.c.timeline.node?.state;
        const extracted = extractBaseline(actor, state?.baselines?.[this.actorId]);
        modal('L0 原始角色卡基线 · 提取与人工校正', (b, close) => {
            const summaryInput = textarea(extracted.summary, 2);
            const traitsInput = input((extracted.coreTraits || []).join(', '));
            const redlinesInput = textarea((extracted.bottomLines || []).join('\n'), 2);
            const speechInput = input(extracted.speechStyle || '');
            const relInput = textarea((extracted.initialRelationships || []).join('\n'), 2);
            b.append(
                el('p', { class: 'ldp-muted' }, '原始角色卡文件保持只读不被篡改。您可以在此校正本分支的 L0 基线特征与红线底线，防止演化偏离原人设核心。'),
                field('L0 基线摘要', summaryInput),
                field('核心性格特征（逗号分隔）', traitsInput),
                field('不可违背的人格底线/红线（每行一条）', redlinesInput),
                field('语言与外在表达基调', speechInput),
                field('初始人物关系认知（每行一条）', relInput),
                el('details', {}, el('summary', {}, '查看原角色卡原始文本（只读）'), el('pre', {}, actor?.baseline || '没有可读取的角色描述')),
                button('保存 L0 基线校正到当前分支', this.safe(async () => {
                    await this.c.mutate(st => setBaselineOverride(st, this.actorId, {
                        summary: summaryInput.value,
                        coreTraits: split(traitsInput.value),
                        bottomLines: split(redlinesInput.value),
                        speechStyle: speechInput.value,
                        initialRelationships: split(relInput.value),
                    }), '校正 L0 原始人设基线');
                    close();
                }))
            );
        });
    }

    edit(record) {
        if (!this.actorId || !this.c.timeline.node) return this.c.say('请先打开角色聊天');
        const actorId = record?.actorId || this.actorId;
        modal(record ? '编辑影响' : '创建影响', (body, close) => {
            const v = record || {
                id: id(),
                layer: 'immediate',
                description: '',
                duration: { mode: 'turns', remaining: 3 },
                scope: {},
                personRules: {},
                intensity: .55,
                confidence: .75,
                priority: 'medium',
                allowConsolidation: true,
            };
            const layer = select(LABELS, v.layer);const gs=select({active:'进行中',paused:'暂停',completed:'已完成',failed:'失败',abandoned:'放弃'},v.goalStatus||'active');body.append(field('自主目标状态（仅 L4）',gs));
            const concept=input(v.concept),blockers=input(v.blockers),nextReview=input(v.nextReview);let pinned=!!v.pinned;const psycheFields=Object.fromEntries(PSY_FIELDS.map(k=>[k,textarea(v.psyche?.[k]||'',2)]));
            const psycheBox=el('details',{},el('summary',{},'心理侧面、目标与置顶（可留空）'));const labels=['本人感受','主观解释','应对方式','习惯','自我看法','可见行为'];
            PSY_FIELDS.forEach((k,i)=>psycheBox.append(field(labels[i],psycheFields[k])));psycheBox.append(field('目标障碍',blockers),field('目标复核时间／条件',nextReview),toggle('相同范围内优先选入提示',pinned,z=>pinned=z));body.append(psycheBox);
            const description = textarea(v.description);
            const rationale = textarea(v.rationale);
            const selfView = textarea(v.selfView, 2);
            const behavior = textarea(v.behavior, 2);
            const triggerCondition = input(v.triggerCondition || '');
            const actionDecision = textarea(v.actionDecision || v.behavior || '', 2);
            const personRulesInput = textarea(formatPersonRulesInput(v.personRules), 2);
            const strength = input(Math.round((v.intensity ?? 0.55) * 100), 'number'); strength.min = '0'; strength.max = '100';
            const confidence = input(Math.round((v.confidence ?? 0.75) * 100), 'number'); confidence.min = '0'; confidence.max = '100';
            const priority = select({ high: '高优先级', medium: '中优先级', low: '低优先级' }, v.priority || 'medium');
            const mode = select({ turns: '本角色有效回复次数', world: '剧情时间（玩家确认）', permanent: '持续存在' }, v.duration.mode);
            const remaining = input(v.duration.remaining ?? 3, 'number');
            const until = input(v.duration.until || 0, 'number');
            const end = input(v.duration.endCondition);
            const scope = Object.fromEntries(['people', 'scenes', 'relationships', 'behaviors','topics'].map(k => [k, input((v.scope[k] || []).join(', '))]));
            const planStepsInput = textarea((v.planSteps || []).join('\n'), 2);
            const currentStepInput = input(v.currentStep || '');
            const progressInput = input(v.progress || 0, 'number'); progressInput.min = '0'; progressInput.max = '100';
            const expression = select({ natural: '按场景自然选择，可不表现', latent: '允许全程内隐' }, v.expression || 'natural');
            let allow = v.allowConsolidation, frozen = !!v.frozen, enabled = v.enabled !== false, managed = 'user';
            const ownership = select({ user: '人工管理：自动分析不可改写', auto: '允许自动演化' }, managed);

            const refs=this.c.timeline.node.state.experiences.filter(e=>e.actorId===actorId&&e.reviewState!=='legacy'&&e.reviewState!=='invalid');const plus=new Set(v.evidence||[]),minus=new Set(v.counterEvidence||[]),details=el('details',{},el('summary',{},'支持与反证（已审核经历）'));
            for(const e of refs){details.append(toggle('支持：'+text(e.summary,55),plus.has(e.id),on=>on?plus.add(e.id):plus.delete(e.id)),toggle('反证：'+text(e.summary,55),minus.has(e.id),on=>on?minus.add(e.id):minus.delete(e.id)));}body.append(details);
            body.append(
                field('层级', layer),
                field('倾向名称', concept),
                field('描述', description),
                field('形成原因/反证', rationale),
                field('自我认知', selfView),
                field('实际行为与矛盾', behavior),
                field('触发情境条件', triggerCondition, '遇到何种情境时主动激活该行为模式'),
                field('主动后天行为策略', actionDecision, '角色在此情境下采取的具体应对决策（例如：预先安排工作避免空等）'),
                field('对不同人物的专属态度（每行「姓名：态度策略」）', personRulesInput),
                field('影响强度（0–100）', strength),
                field('置信度（0–100）', confidence),
                field('调度优先级', priority),
                field('生命周期', mode),
                field('剩余回复次数', remaining),
                field('结束剧情分钟', until),
                field('结束条件', end, '在事件审核里勾选达到条件，或直接手动结束。'),
                field('人物范围', scope.people, '逗号分隔的角色名或 avatar ID；空为不限（自动识别当前互动人物）。'),
                field('话题范围',scope.topics),field('场景范围', scope.scenes),
                field('关系范围', scope.relationships),
                field('行为范围', scope.behaviors),
                field('L4目标计划步骤（每行一步，仅自主目标层使用）', planStepsInput),
                field('L4当前执行步骤', currentStepInput),
                field('L4目标完成度（0–100）', progressInput),
                field('外在表现', expression),
                field('编辑权限', ownership),
                toggle('允许长期沉淀', allow, x => { allow = x; }),
                toggle('冻结内容和生命周期', frozen, x => { frozen = x; }),
                toggle('参与生成', enabled, x => { enabled = x; })
            );
            body.append(button('保存到当前分支', this.safe(async () => {
                if (!description.value.trim()) throw new Error('请填写描述');
                await this.c.mutate(st => {
                    const next = userEdit(st, {
                        ...v,
                        layer: layer.value,
                        concept: concept.value,
                        description: description.value,
                        rationale: rationale.value,
                        selfView: selfView.value,
                        behavior: behavior.value,
                        triggerCondition: triggerCondition.value,
                        actionDecision: actionDecision.value,
                        personRules: parsePersonRulesInput(personRulesInput.value),
                        intensity: Number(strength.value) / 100,
                        confidence: Number(confidence.value) / 100,
                        priority: priority.value,
                        planSteps: split(planStepsInput.value),
                        pinned,psyche:{...v.psyche,...Object.fromEntries(PSY_FIELDS.map(k=>[k,psycheFields[k].value||null]))},blockers:blockers.value,nextReview:nextReview.value,currentStep: currentStepInput.value, goalStatus:gs.value,
                        progress: Number(progressInput.value) || 0,
                        scope: Object.fromEntries(Object.entries(scope).map(([k, x]) => [k, split(x.value)])),
                        duration: { mode: mode.value, remaining: Number(remaining.value), until: Number(until.value), endCondition: end.value },
                        expression: expression.value,
                        allowConsolidation: allow,
                        frozen,
                        enabled,
                        managedBy: ownership.value,
                    }, actorId);
                    const saved=next.influences.find(x=>x.id===v.id);if([...plus].some(x=>minus.has(x)))throw Error('同一经历不能同时选为支持和反证。');saved.evidence=[...plus];saved.counterEvidence=[...minus];saved.sourceKeys=[...new Set(refs.filter(e=>plus.has(e.id)||minus.has(e.id)).flatMap(e=>e.sources.map(q=>q.key)))];saved.managedBy=ownership.value;saved.reviewState='approved';
                    return next;
                }, '保存影响');
                close();
            })));
        });
    }

    remove(x) {
        modal('删除影响', (b, close) => {
            let prevent = true;
            b.append(
                el('p', {}, `删除「${x.concept}」。源经历仍保留，可单独管理。`),
                toggle('屏蔽相同证据与概念，禁止自动重建', true, v => { prevent = v; }),
                button('确认删除', this.safe(async () => { await this.c.mutate(st => removeInfluence(st, x.id, prevent), '删除影响'); close(); }))
            );
        });
    }

    evidence(influence) {
        const state = this.c.timeline.node?.state;
        if (!state) return;
        modal('经历与剧情依据（支持直接修订解释与归因）', (b, close) => {
            const rows = state.experiences.filter(e => e.actorId === this.actorId && (!influence || [...influence.evidence,...(influence.counterEvidence||[])].includes(e.id)));
            b.append(el('div', { class: 'ldp-actions' },
                button('从原文创建经历', () => { close(); this.library(); })
            ));
            if (!rows.length) b.append(el('p', {}, '没有自动证据。人工创建的影响可以没有剧情引用，也可点击上方按钮新增。'));
            for (const e of rows) {
                const typeLabel = EVIDENCE_TYPES[e.evidenceType] || '角色主观理解';
                b.append(el('article', { class: 'ldp-card' },
                    el('div', { class: 'ldp-tags' }, `${typeLabel} · 显著度 ${Math.round((e.salience || 0.5) * 100)}%${e.userCorrected ? ' · 已人工校正' : ''}${e.cognitiveHistory?.length > 1 ? ` · 认知修订 ${e.cognitiveHistory.length} 次` : ''}`),
                    el('strong', {}, e.summary),
                    el('p', {}, `主观理解：${e.appraisal}`),
                    e.attribution ? el('p', { class: 'ldp-subtext' }, `因果归因：${e.attribution}`) : null,
                    ...(e.sources || []).map(s => el('blockquote', {}, `#${s.index + 1}：${s.quote}`)),
                    el('small', {}, `知情者：${(e.knownTo || []).join(', ')}`),
                    el('div', { class: 'ldp-actions' },
                        button('编辑解释与归因', () => { close(); this.editEvidenceModal(e); }),
                        button('删除经历并屏蔽证据', this.safe(async () => {
                            await this.c.mutate(st => {
                                st.blocks.push({ id: id(), actorId: e.actorId, concept: '', evidence: e.sources.map(s => s.key), reason: '用户删除经历' });
                                st.experiences = st.experiences.filter(x => x.id !== e.id);const occ=st.occurrences.find(x=>x.id===e.id);if(occ)occ.reviewState='rejected';
                                for (const x of st.influences) if (x.evidence.includes(e.id)) { x.evidence = x.evidence.filter(y => y !== e.id); x.enabled = false; }
                                return st;
                            }, '删除经历');
                            close();
                        }), 'ldp-danger')
                    )
                ));
            }
        });
    }

    editEvidenceModal(exp){const e=this.c.timeline.node?.state.occurrences.find(e=>e.id===exp?.occurrenceId);if(e)return this.eventEditor(e);this.library();}
    evolutionTree(focusInfluence = null) {
        const state = this.c.timeline.node?.state;
        if (!state) return;
        const expMap = new Map((state.experiences || []).map(e => [e.id, e]));
        const listToShow = focusInfluence
            ? [focusInfluence]
            : (state.influences || []).filter(x => x.actorId === this.actorId);

        modal(focusInfluence ? `人格演化轨迹 · ${focusInfluence.concept}` : '角色后天人格成长树与演化历史', b => {
            if (!listToShow.length) {
                b.append(el('p', {}, '当前角色尚无后天人格演化记录。'));
                return;
            }
            const typeMap = {
                formed: '🌱 初步形成',
                reinforced: '📈 经历强化',
                weakened: '📉 反证削弱',
                revised: '🔄 认知修订',
                contradiction: '⚡ 心理矛盾共存',
                retired: '🍂 自然消退/完成',
                user_edit: '✍️ 玩家最高权限校准',
            };
            for (const inf of listToShow) {
                const treeCard = el('article', { class: 'ldp-card' },
                    el('div', { class: 'ldp-tags' }, `${LABELS[inf.layer]} · 当前强度 ${Math.round(inf.intensity * 100)}% · 置信度 ${Math.round((inf.confidence ?? 0.7) * 100)}% · 状态:${inf.status}`),
                    el('strong', {}, inf.concept),
                    el('p', {}, `当前倾向：${inf.description}`),
                    inf.actionDecision ? el('p', { class: 'ldp-subtext' }, `形成的主动行为模式：${inf.actionDecision}`) : null,
                    inf.contradiction ? el('p', { class: 'ldp-subtext' }, `内在矛盾张力：${inf.contradiction}`) : null
                );
                const logs = inf.evolutionLog || [];
                for (const step of logs) {
                    const linkedExps = (step.evidenceIds || []).map(eid => expMap.get(eid)).filter(Boolean);
                    const quoteStr = linkedExps.flatMap(e => (e.sources || []).map(s => `#${s.index + 1}「${s.quote}」`)).join('；');
                    treeCard.append(el('blockquote', {},
                        `${typeMap[step.type] || step.type}（强度 ${Math.round((step.intensityBefore ?? 0) * 100)}% → ${Math.round((step.intensityAfter ?? inf.intensity) * 100)}%）：${step.reason || inf.rationale}${quoteStr ? `\n依据引文：${quoteStr}` : ''}`
                    ));
                }
                b.append(treeCard);
            }
        });
    }

    variablesModal(){const actor=this.actorId,st=this.c.timeline.node?.state;if(!st)return;modal('可选手工字段（不参与人格学习）',(b,close)=>{
        b.append(el('p',{},'不用填写。字段只在本插件保存；明确勾选允许发送的字段还需打开设置中的分享开关。'));
        for(const v of st.variables[actor]||[])b.append(el('p',{},v.key+' = '+JSON.stringify(v.value)),button('删除 '+v.key,this.safe(async()=>{await this.c.mutate(s=>deleteVariable(s,actor,v.key),'删除字段');close();})));
        const k=input(),val=input(),kind=select({string:'文本',number:'数字',bool:'布尔（true / false）',enum:'枚举（选项用逗号分隔）',list:'列表（逗号分隔）'},'string'),choices=input(),life=input(0,'number'),scope=select({actor:'角色',relationship:'关系',chat:'当前聊天',branch:'当前选中世界线',session:'本页面会话'},'actor'),target=input();let share=false,locked=true;
        b.append(field('名称',k),field('类型',kind),field('值',val),field('枚举选项',choices),field('范围',scope),field('关系对象（仅关系字段）',target),field('寿命（本人有效回复，0 为永久）',life),toggle('锁定字段',true,v=>locked=v),toggle('允许作为备注发送',false,v=>share=v),button('保存手工字段',this.safe(async()=>{
        const allowed=split(choices.value),name=k.value.trim();if(!name)throw Error('请输入名称。');const raw=val.value.trim();
        if(kind.value==='number'&&(!raw||!Number.isFinite(Number(raw)))||kind.value==='bool'&&!['true','false'].includes(raw)||kind.value==='enum'&&!allowed.includes(raw)||scope.value==='relationship'&&!target.value.trim())throw Error('值或作用对象不符合所选类型。');
        const value=kind.value==='number'?Number(raw):kind.value==='bool'?raw==='true':kind.value==='list'?split(raw):raw;
        await this.c.mutate(s=>{const out=setVariable(s,actor,{key:name,value:raw,source:'user',autoUpdate:false},'手动设置');Object.assign(out.variables[actor].find(x=>x.key===name),{value,kind:kind.value,choices:allowed,area:scope.value,target:target.value.trim(),locked,share,life:Math.max(0,Math.floor(+life.value)||0),born:s.turns[actor]||0,home:this.c.timeline.stream.id,session:scope.value==='session'?this.c.session:null});return out;},'保存字段');close();})));});}
    world() {
        const state = this.c.timeline.node?.state;
        if (!state) return;
        const world = state.world;
        const ctx = this.c.context();
        const detected = detectWorldContext({ chat: ctx.chat || [], cast: actors(ctx), state, userName: ctx.name1 || '' });
        modal('当前场景与剧情时间（动态感知 + 手动锁定覆盖）', (b, close) => {
            let autoDetect = world.autoDetect !== false;
            const scene = input(world.scene);
            const time = input(world.time || 0, 'number');
            const people = input((world.people || []).join(', '));
            const relationships = input((world.relationships || []).join(', '));
            const behaviors = input((world.behaviors || []).join(', '));
            b.append(
                el('p', { class: 'ldp-muted' }, `当前动态感知结果：所在地「${detected.scene || '未特定'}」· 在场人物「${(detected.people || []).join('、') || '无'}」。自动区分实际所在地、谈论的过去地点与通讯动作。`),
                toggle('面板显示情境线索（不向人物授予知情权限）', autoDetect, v => { autoDetect = v; }),
                field('实际场景（未确认则不用于场景限定的心理）', scene),
                field('手动基准剧情分钟（例如今晚结束设为 1440）', time),
                field('手动附加在场人物（最多沿用 12 楼，可提前更改）', people),
                field('手动附加当前关系', relationships),
                field('手动附加当前行为', behaviors),
                button('更新场景设置', this.safe(async () => {
                    await this.c.mutate(st => ({
                        ...st,
                        world: {
                            ...st.world,
                            autoDetect,
                            scene: scene.value.trim(),
                            time: Math.max(0, Number(time.value)),
                            people:split(people.value),untilFloor:this.c.capture.chat.length+12,
                            relationships: split(relationships.value),
                            behaviors: split(behaviors.value),
                        },
                    }), '更新剧情范围');
                    close();
                }))
            );
        });
    }

    knowledge() {
        const c = this.c;
        if (!c.timeline.node) return;
        modal('角色知情范围（自动区分公开对话/现场动作/私聊/离场/秘密 + 手动纠正）', (b, close) => {
            const actorId = this.actorId, path = c.timeline.path;
            const state = c.timeline.node.state;
            const cast = c.capture?.cast || actors(c.context());
            const modeSelect = select({
                auto: '保守模式：本人视角、点名对白及直接面向该角色的现场公开动作',
                manual: '严格手动授权（群聊他人消息需逐条勾选）',
            }, state.world?.groupVisibilityMode || 'auto');

            b.append(
                field('群聊与多角色知情判定模式', modeSelect),
                el('p', { class: 'ldp-muted' }, '勾选表示知情，取消勾选表示对该角色隐瞒（撤销授权后依赖该原文的资料不会再发给模型，保留审计历史）。')
            );

            const choices = [];
            for (let i = 0; i < (c.capture?.chat.length || 0); i++) {
                const m = c.capture.chat[i], row = path[i + 1];
                if (m.is_system || !row) continue;
                const who=cast.find(x=>x.id===actorId);const parts=who?permittedParts(m,who,cast,state,row.hash,!!c.capture?.group):[];const vis={visible:!!parts.length,reason:parts.length?parts.map(p=>p.visibility).join(','):'默认不可见'};
                const checked = vis.visible;
                choices.push({ node: row.hash, checked, original: checked });
                const choice = choices.at(-1);
                b.append(toggle(`#${i + 1} [${vis.reason}] ${m.name || '用户'}：${text(m.mes, 120)}`, checked, v => { choice.checked = v; }));
            }

            b.append(button('保存知情范围', this.safe(async () => {
                await c.mutate(st => {
                    st.world ||= {};
                    st.world.groupVisibilityMode = modeSelect.value;
                    st.revokes ||= {};
                    for (const x of choices.filter(x=>x.checked!==x.original)) {
                        st.grants[x.node] = (st.grants[x.node] || []).filter(a => a !== actorId);
                        st.revokes[x.node] = (st.revokes[x.node] || []).filter(a => a !== actorId);
                        if (x.checked) st.grants[x.node].push(actorId);
                        else st.revokes[x.node].push(actorId);
                    }
                    // Revocation filters all derived materials on read; preserve audit and allow undo.
                    return st;
                }, '更新知情权限');
                close();
            })));
        });
    }

    history() {
        const revisions = this.c.timeline.node?.history || [];
        modal('当前节点的修订历史', (b, close) => {
            if (!revisions.length) b.append(el('p', {}, '当前节点没有修订。切换聊天分支会自动恢复对应节点。'));
            revisions.forEach((r, i) => b.append(button(`回到 ${new Date(r.at).toLocaleString()}「${r.label}」之前`, this.safe(async () => {
                await this.c.mutate(()=>clone(revisions[i].state),'玩家回到旧修订');
                this.c.say('已回退人格修订');
                close();
            }))));
        });
    }

    blocks() {
        modal('禁止自动重建的证据', (b, close) => {
            const blocks = this.c.timeline.node?.state.blocks || [];
            if (!blocks.length) b.append(el('p', {}, '当前分支没有屏蔽规则。'));
            for (const x of blocks) b.append(el('article', { class: 'ldp-card' },
                el('p', {}, `${x.concept || '剧情证据'} · ${x.evidence.length} 条 · ${x.reason}`),
                button('解除屏蔽', this.safe(async () => {
                    await this.c.mutate(st => ({ ...st, blocks: st.blocks.filter(z => z.id !== x.id) }), '解除证据屏蔽');
                    close();
                }))
            ));
        });
    }

    analysisLogsModal(){const c=this.c,a=this.actorId,stream=c.timeline.stream?.id;modal('分析预算、队列账本与注入 Inspector',b=>{
        const s=c.settings(),summaryBox=el('pre',{class:'ldp-wrap'},'正在读取持久化账本...');
        Promise.all([c.analyzer.usageSummary(),c.inspectQueue(a,stream)]).then(([u,q])=>{
            const attempt=x=>x?{批次:x.manifest.batchId,历史来源:x.manifest.managed===7?'新账本管理':'历史未核实',
                仅预留未派发:x.pending?{job:x.pending.key,状态:x.pending.status}:null,
                最近派发:x.last?{job:x.last.key,已登记派发意图:x.last.sent===true,已本地结算:!!x.last.finished,状态:x.last.status}:null}:null;
            summaryBox.textContent=JSON.stringify({
                当前队列:{存档:stream,角色:a,版本:q.facts.queueRevision,状态:q.facts.queue.status,原因:q.facts.queue.reason,待办锚点:q.facts.anchors.length},
                请求占用:{账户累计:`${u.totalRequests}/${s.analysisMaxTotalRequests}`,今日UTC:`${u.dailyRequests}/${s.dailyLimit}`,本页会话:`${u.sessionRequests}/${s.sessionLimit}`,当前配置档累计:u.profileRequests,当前配置档今日:u.profileDailyRequests},
                派发记录:{已登记派发意图:u.sentIntentCount,仅预留:u.reservedOnlyCount,未派发已退款:u.releasedUnsentCount,历史派发未核实:u.legacyUnknownDispatchCount},
                Token与费用口径:{上游报告输入:u.reportedInputTokens,上游报告输出:u.reportedOutputTokens,已登记派发但未报告Usage:u.unknownUsageCount,失败可能计费:u.failedBilledCount,已报告费用:u.knownCost,本地输入估算:u.estimatedInputTokens},
                限额阻塞:u.blockers,来源账本核验:q.audit,待核实尝试:q.attempts.map(attempt)
            },null,2);
        }).catch(()=>{summaryBox.textContent='账本读取失败，无法判断完整性。请重新打开面板核验。';});
        const inspectorPayload=c.lastActor===a?{...c.diag,最终演出提示:c.lastPrompt}:{说明:'当前角色本轮尚未触发主模型注入'};
        b.append(el('p',{},'派发意图在网络调用前登记；无法据此确认供应商收到了请求或实际收费。仅预留且未派发才可退款。'),summaryBox,
            el('p',{},'账本仅核验已受理来源；未开启插件时的历史聊天不算失踪。legacyUnverifiedCount 为尚无法证明的旧历史；unexpectedMissingIds、orphanedBatchIds、sourceMismatchIds 分别列出失踪、孤批和来源不符。'),
            el('p',{},'最近调用结果：'),
            ...c.analyzer.logs.slice(-12).map(l=>el('p',{},new Date(l.at).toLocaleTimeString()+' · '+l.status+' · 预计 '+(l.estimatedTokens??'未知')+(l.usage?.total?` · 实报 ${l.usage.total} tokens`:' · 用量未知'))),
            el('div',{class:'ldp-actions'},
                button('复制脱敏 Inspector 诊断',()=>{const sample=exportInspectorSample(c.diag,c.lastActor===a?c.lastPrompt:'',{redact:true});globalThis.navigator?.clipboard?.writeText?.(JSON.stringify(sample,null,2));c.say('已复制脱敏 Inspector JSON');}),
                button('下载脱敏 Inspector 样本',()=>{const sample=exportInspectorSample(c.diag,c.lastActor===a?c.lastPrompt:'',{redact:true});download(`lin-inspector-${Date.now()}.json`,JSON.stringify(sample,null,2));})
            ),el('pre',{},JSON.stringify(inspectorPayload,null,2)),el('pre',{},c.trace.slice(-8).join('\n')));
    });}
    importBackup() {
        const file = input('', 'file');
        file.accept = '.json,application/json';
        file.onchange = this.safe(async () => {
            const f = file.files[0];
            if (!f) return;
            if (f.size > 100 * 1024 * 1024) throw new Error('备份超过 100 MB');
            const streams = await this.c.db.import(JSON.parse(await f.text()));
            this.c.say(`已导入 ${streams.length} 个独立备份存档；可选择采用完全匹配的快照`);
        });
        file.click();
    }

    async adopt(){const c=this.c,streams=(await c.db.all('streams')).filter(s=>c.timeline.eligibleStream(s));const options=[];for(const s of streams)for(const n of (await c.timeline.listSnapshotsForStream(s.id)).slice(0,80))options.push({s,n});
      modal('加载共同历史上的人格快照',(b,close)=>{if(!options.length)b.append(el('p',{},'尚无同一人物、存档且原文一致的候选；可先导入备份。'));for(const {s,n} of options)b.append(button((s.legacy?'旧版待复核 · ':s.imported?'备份 · ':'本机 · ')+'第 '+n.length+' 楼 / r'+n.revision+' / '+n.hash.slice(0,9),this.safe(async()=>{await c.adopt(s.id,n.hash);close();})));});}
    rebuild(){modal('从当前已保存的聊天重建导航',(b,close)=>b.append(el('p',{},'重新读取当前酒馆存档和原文。不会重新解释旧剧情、还原丢失的玩家判断或调用模型。'),button('核实并重建',this.safe(async()=>{await this.c.enqueue(()=>this.c.sync({recovery:true,force:true}));if(this.c.suspended)throw Error('请先在检查恢复中决定如何处理差异。');await this.c.refreshRetrieval();close();}))));}
    async analyzeDialog(){const c=this.c,a=this.actorId,stream=c.timeline.stream?.id;let q;
     try{q=await c.inspectQueue(a,stream);}catch(e){c.say('无法读取待办：'+e.message);return;}
     if(c.timeline.stream?.id!==stream||this.actorId!==a)return;
     const s=c.settings(),est=c.estimatePendingAnalysis(a),failed=q.facts.queue.failedBatch,attempt=q.attempts.find(x=>x?.manifest.batchId===failed?.batchId);
     const stillHere=()=>{if(c.timeline.stream?.id!==stream||this.actorId!==a)throw Error('聊天或角色已切换，请重新打开分析面板。');};
     modal('用当前分析档分析已保存原文',(b,close)=>{
      b.append(el('p',{},s.analysisEnabled?'每批是独立的额外模型请求，可能收费。只发送角色获准的原文和必要心理。':'当前为纯本地模式；需要分析时请先启用额外模型请求。'),el('p',{},'待分析 '+est.pendingMessages+' 段；累计上限 '+s.analysisMaxTotalRequests+' 次。输入约 '+(est.estimatedTokens||0)+' tokens（估算，非账单）。'),el('p',{},'持久化队列：'+q.facts.queue.status+' · '+(q.facts.queue.reason||'无待办')));
      if(failed||q.facts.queue.sent){
       b.append(el('p',{},attempt?.last?.sent?'该批已登记派发意图，可能已计费。再次发送须确认；仅重发冻结来源，不混入新楼层。':'历史派发凭据无法完整核实；请先查看账本，不能将它当作未发送。'));
       if(s.analysisEnabled&&attempt?.last?.sent&&attempt.last.finished)b.append(button('确认重发原失败批（额外 1 次）',this.safe(async()=>{stillHere();if(confirm('原请求可能已计费。确认再发送一次完全相同的失败批次？')){close();await c.analyze(a,false,1,null,true,{retryBatchId:failed.batchId,retryJobId:attempt.manifest.lastJobId});}})));
       b.append(button('归档失败记录，重新核对待办',this.safe(async()=>{stillHere();if(confirm('保留旧尝试和可能产生的费用，归档失败状态并按当前可见原文重建待办？重建后由你手动决定是否再次分析。')){await c.discardFailedBatch(a,{rebuildQueue:true,expectedBatchId:failed?.batchId??null});close();}})));
      }else if(s.analysisEnabled)b.append(
       button('优先分析最新片段（1 次）',this.safe(async()=>{stillHere();const recent=new Set(c.live(a).source.slice(-s.batchSize).map(v=>v.id));close();await c.analyze(a,false,1,recent,false,{latest:true});})),
       button('分析一批',this.safe(async()=>{stillHere();close();await c.analyze(a);})),
       button('按已设置批数上限分析',this.safe(async()=>{stillHere();close();await c.analyze(a,true);})));
      if(q.facts.anchors.length)b.append(button('取消当前待办',this.safe(async()=>{stillHere();if(confirm('明确取消当前队列的待办来源？原派发记录及费用仍保留；相同来源不会自动重新入队。')){await c.discardFailedBatch(a,{rebuildQueue:false,expectedBatchId:failed?.batchId??null,anchorIds:q.facts.anchors});close();}})));
      b.append(button('取消采用运行中的分析结果',()=>{c.cancel();close();}));
     });}
    jump(index){const el=document.querySelector('#chat [mesid="'+Number(index)+'"]');if(el?.scrollIntoView)el.scrollIntoView({block:'center'});else this.c.say('第 '+(index+1)+' 楼尚未显示。可先在聊天中加载更早消息。');}
    inbox(){const c=this.c,a=this.actorId,m=c.timeline.node?.state;if(!m)return;modal('待审提案与事件',(b,close)=>{
     const list=m.proposals.filter(p=>p.owner===a&&p.reviewState==='pending');b.append(el('p',{},'先核对事件：这是谁的说法？当时是否真的发生？再决定是否采用人格解释。未批准的内容不会进入角色提示。'));
     for(const e of m.occurrences.filter(e=>e.actorId===a).slice().reverse().slice(0,120))b.append(button((e.reviewState==='approved'?'已核对 · ':e.reviewState==='rejected'?'已否决 · ':'待核对 · ')+e.action,()=>{close();this.eventEditor(e);}));
     for(const p of list.slice(-80).reverse()){const card=el('article',{class:'ldp-card'},el('strong',{},LABELS[p.layer]+' · '+p.description),el('p',{},'理由：'+p.reason),el('small',{},'来源性质：'+(p.basis||'未知')+' · 待审原因：'+(p.reviewReason||'人工复核')+(p.alternative?` · 替代解释：${p.alternative}`:'')),el('p',{},Object.entries(p.psyche||{}).filter(([_,v])=>v!=null).map(([k,v])=>k+'：'+v).join('；')));
      for(const [label,ids] of [['支持',p.support],['反证',p.counter]])for(const eid of ids){const e=m.occurrences.find(x=>x.id===eid);if(e){card.append(el('span',{},label+' · '+e.action+' · '+e.reviewState),...e.quotes.map(q=>el('blockquote',{},'第'+(q.index+1)+'楼 · '+q.quote)));}}
      if(c.settings().reviewProfile){const adv=el('p',{});card.append(button('请求第二意见（1 次，仅供审阅）',this.safe(async()=>{const r=await secondOpinion(c,a,p.id);adv.textContent=(r.agree?'支持：':'存疑：')+r.reason;})),adv);}
      const desc=textarea(p.description),layer=select(LABELS,p.layer),num=input(p.remaining??(p.layer==='immediate'?2:8),'number');let exception=false,freeze=false,now=false;
      const diffPreviewBox=el('pre',{class:'ldp-wrap'});
      card.append(field('批准前可改写',desc),field('层级（可降级短时）',layer),field('持续次数（短期或即时）',num),toggle('这是一项确有理由的单次重大例外；我已核对证据',false,v=>exception=v),toggle('批准后冻结',false,v=>freeze=v),toggle('短时影响从现在开始（默认扣除已确认的后续回复）',false,v=>now=v),
      button('预览拟更新状态差异（不写入）',()=>{try{const {diff,record}=previewProposalDiff(m,a,p.id,{description:desc.value,layer:layer.value,remaining:Math.max(0,Number(num.value)||0),freeze,exception,fromNow:now},c.live(a));diffPreviewBox.textContent=JSON.stringify({新增:diff.addedInfluences,修改:diff.modifiedInfluences,移除:diff.removedInfluences,拟生成记录:record?{layer:record.layer,description:record.description,intensity:record.intensity,status:record.status}:null},null,2);}catch(err){diffPreviewBox.textContent='预览提示：'+err.message;}}),diffPreviewBox);
      for(const [d,label] of [['approve','按当前内容批准'],['reject','退回'],['block','拒绝并屏蔽同证据']])card.append(button(label,this.safe(async()=>{await c.decide(a,p.id,d,{description:desc.value,layer:layer.value,remaining:Math.max(0,Number(num.value)||0),freeze,exception,fromNow:now});close();this.inbox();})));b.append(card);}
     if(!list.length)b.append(el('p',{},'目前没有待审人格提案。'));for(const x of m.summaries.filter(s=>s.actorId===a&&s.reviewState==='pending'))b.append(button('审核导航摘要：'+text(x.text,55),()=>{close();this.summaryEditor(x);}));
    });}
    eventEditor(e,src){const c=this.c,a=this.actorId,v=c.live(a),fresh=!e;
      if(fresh){const q=verifyQuote({quote:src.text.slice(0,390),offset:0},src,v.chat,v.path);e={id:id(),actorId:a,action:'',agent:null,recipient:null,time:null,place:null,modality:'unknown',sourceKeys:[src.id],quotes:[q],hints:src.hints,knownBy:[a],refs:[],reviewState:'candidate',anchor:v.path.at(-1).hash};}
      const m=c.timeline.node.state,ex=m.experiences.find(x=>x.occurrenceId===e.id),people={'':'未知 / 未确定',...v.persons};modal('核对出处、事件与角色的理解',(b,close)=>{
      for(const q of e.quotes)b.append(el('blockquote',{},'第'+(q.index+1)+'楼 · Swipe '+(q.swipe??0)+' · 发言署名 '+(v.persons[q.speakerId]||q.speakerId)+' · 原文位置 '+q.rawStart+'–'+q.rawEnd+'：'+q.quote),button('定位第'+(q.index+1)+'楼',()=>this.jump(q.index)));
      b.append(el('p',{},'归因未明就留空。原文里的对话可能只是传闻；回忆可以是真的，但重复回忆不能算多次发生。'));
      const action=textarea(e.action),agent=select(people,e.agent||''),recipient=select(people,e.recipient||''),time=input(e.time||''),place=input(e.place||''),occ=input(e.occasion||''),mode=select({unknown:'未知',actual:'我已核实：剧情中确实发生',claim:'人物说法，未证实',dream:'梦境',hypothetical:'假设',negative:'否定',reported:'转述或谣言',remembered:'回忆',performed:'表演'},e.modality);
      let overrideMode=false;b.append(el('small',{},'文字警示：'+(e.hints?.join('、')||'无；仍需人工判断。')),toggle('若原文带梦境、否定等标记，我已核对上下文并确认现实归因',false,v=>overrideMode=v));
      const app=textarea(ex?.appraisal||m.appraisals.filter(x=>x.eventId===e.id&&x.owner===a).map(x=>x.text).join('；'));
      b.append(field('谁做了什么（事件描述）',action),field('行动主体',agent),field('对象',recipient),field('事件如何出现',mode),field('剧情时间（未知留空）',time),field('地点',place),field('独立发生场次',occ,'同一件事请用同一标识，例如“11月12日第一次取件”。不明确请留空。'),field('这个角色的主观理解',app));
      const others=m.occurrences.filter(x=>x.actorId===a&&x.id!==e.id&&x.reviewState==='approved');if(!fresh&&others.length){const same=select(Object.fromEntries(others.map(x=>[x.id,x.action+' · '+(x.time||'时间未知')])),others[0].id);
      b.append(field('同一件事的再次提及？',same),button('并入所选已审事件',this.safe(async()=>{await c.mutate(s=>mergeOccurrences(s,a,e.id,same.value,c.live(a)),'合并同一事件的提及');close();this.inbox();})));}
      const ended=select({'':'不结束任何影响',...Object.fromEntries(m.influences.filter(x=>x.actorId===a&&['short','immediate','goal'].includes(x.layer)&&x.enabled).map(x=>[x.id,text(x.description,50)]))},'');b.append(field('由我明确确认：本事件结束哪项影响？',ended));
      for(const [reject,label] of [[false,'确认归因并保存'],[true,'标记不成立']])b.append(button(label,this.safe(async()=>{await c.mutate(st=>{if(fresh){st.occurrences.push(e);st.mentions.push({id:id(),owner:a,sourceId:src.id,...e.quotes[0]});}const next=reviewEvent(st,a,e.id,{action:action.value||'未定事件',agent:agent.value,recipient:recipient.value,time:time.value,place:place.value,occasion:occ.value,modality:mode.value,overrideMode,appraisal:app.value,reject},c.live(a));
       if(!reject&&ended.value){const x=next.influences.find(x=>x.id===ended.value&&x.actorId===a);if(x){x.status='retired';x.managedBy='user';x.evolutionLog.push({id:id(),at:Date.now(),type:'retired',reason:'玩家核实本事件满足结束条件',evidenceIds:[e.id]});}}return next;},'核对剧情依据');close();this.inbox();})));
      });}
    summaryEditor(old,chosen=[]){const c=this.c,a=this.actorId,st=c.timeline.node.state,ids=old?.sourceIds||chosen;modal('原文导航摘要',(b,close)=>{const tx=textarea(old?.text||''),tags=input((old?.tags||[]).join('，')),level=select({scene:'场景',chapter:'篇章'},old?.level||'scene'),tm=input(old?.time||''),pl=input(old?.place||'');
      b.append(field('层级',level),field('摘要（只是导航）',tx),field('检索主题或别称',tags),field('时间',tm),field('地点',pl));
      for(const k of ids){const s=c.live(a).byId.get(k);if(s)b.append(el('blockquote',{},'第'+(s.index+1)+'楼：'+s.text));}
      b.append(button('保存并启用导航',this.safe(async()=>{await c.summary(a,{id:old?.id,text:tx.value,tags:split(tags.value),level:level.value,time:tm.value,place:pl.value,sourceIds:ids});close();})));
      if(old)b.append(button('删除摘要',this.safe(async()=>{await c.mutate(s=>({...s,summaries:s.summaries.filter(v=>v.id!==old.id||v.actorId!==a)}),'删除摘要');close();})));});}
    library(){const c=this.c,a=this.actorId,v=c.live(a),st=c.timeline.node.state;modal('本地文字记忆 · 原文、场景与篇章',(b,close)=>{const query=input('','search'),results=el('div'),selected=new Set();b.append(field('搜索人物、时间、别名、简述或原句',query),el('p',{},'搜索只在本存档与该角色可知的资料中进行。勾选原文可以编写导航摘要。'));
      const paint=()=>{results.replaceChildren();const q=query.value.trim();const docs=q?v.index.search(q,{limit:50,aliases:st.aliases?.[a]||{}}):v.source.slice(-32).reverse().map(s=>({text:s.text,index:s.index,kind:'原文提及',sourceIds:[s.id]}));
       if(!docs.length)results.append(el('p',{},'没有字面或别名匹配。可尝试相关人物、日期或更短的词。'));
       for(const d of docs){const source=v.byId.get(d.sourceIds?.[0]),card=el('article',{class:'ldp-card'},el('small',{},d.kind+(d.index>=0?' · 第'+(d.index+1)+'楼':'')),el('p',{},d.text));if(source)card.append(toggle('选取出处',selected.has(source.id),on=>on?selected.add(source.id):selected.delete(source.id)),button('查看原楼',()=>this.jump(source.index)),button('引用此段登记事件',()=>{close();this.eventEditor(null,source);}),button('钉住原文',this.safe(async()=>{await c.mutate(s=>{if(!s.notes.some(n=>n.owner===a&&n.sourceId===source.id))s.notes.push({id:id(),owner:a,sourceId:source.id,text:source.text});return s;},'原文已钉住');close();})));results.append(card);}};query.oninput=paint;paint();
      b.append(results,button('为所选原文写摘要',()=>{if(!selected.size)return c.say('请先选择至少一段原文。');close();this.summaryEditor(null,[...selected]);}));
      for(const x of st.summaries.filter(x=>x.actorId===a))b.append(button((x.level==='chapter'?'篇章':'场景')+'：'+text(x.text,42),()=>{close();this.summaryEditor(x);}));
      for(const n of st.notes.filter(n=>n.owner===a&&v.byId.has(n.sourceId)))b.append(button('取消钉住：'+text(n.text,32),this.safe(async()=>{await c.mutate(s=>({...s,notes:s.notes.filter(x=>x.id!==n.id)}),'取消钉住');close();})));
      const word=input(),alt=input();b.append(field('检索用的人名或词',word),field('别名 / 同义词（逗号分隔）',alt),button('保存检索别名',this.safe(async()=>{const key=word.value.trim();if(!key||['__proto__','constructor','prototype'].includes(key))throw Error('无效的检索词。');await c.mutate(s=>{s.aliases[a]={...(s.aliases[a]||{}),[text(key,50)]:split(alt.value).slice(0,12)};return s;},'更新本角色检索别名');close();})));
      const name=input();b.append(field('登记剧情中的其他人（不合并角色卡）',name),button('创建人物身份',this.safe(async()=>{if(!name.value.trim())throw Error('请输入称呼。');await c.mutate(s=>{s.peopleRegistry||={};s.peopleRegistry[a]={...(s.peopleRegistry[a]||{}),['person:'+id()]:text(name.value.trim(),50)};return s;},'登记角色所知人物');close();})));});}
    transfer(){const c=this.c;modal('旧版迁移与增量备份',(b,close)=>{b.append(el('p',{},'0.5 使用新的独立数据库。升级前的 0.4 数据库保留原样；导入时创建备份候选。不会覆盖正在使用的存档，也不会重新解释旧资料。'),
     button('只读导出升级前 0.4 快照',this.safe(async()=>{const a=await c.db.get('archives','migration4');if(!a)throw Error('本机没有已迁移的 0.4 快照。');download('lin-persona-original-v4.json',JSON.stringify(a.pack));})),button('只读导出原 0.3 人格库 JSON',this.safe(async()=>download('lin-persona-original-v3.json',JSON.stringify(await c.db.legacyBackup())))),button('导入 JSON 为备份候选',()=>{close();this.importBackup();}));
     if(c.timeline.stream){const base=input(0,'number');b.append(el('p',{},'当前世界修订 r'+c.timeline.stream.seq),field('增量起始修订（对应已导出的完整备份）',base),button('导出该修订以后的增量',this.safe(async()=>{const x=await c.db.delta(c.timeline.stream.id,Number(base.value));download('lin-persona-delta.json',JSON.stringify(x));})));}});}

    adoptionPanel(){const c=this.c,a=this.actorId,st=c.timeline.node?.state;if(!st)return c.say('请先打开聊天。');modal('自动采用与撤销',(b,close)=>{const list=st.adoptions.filter(x=>x.actor===a).slice(-60).reverse();if(!list.length)b.append(el('p',{},'该角色当前分支没有自动采用的记录。'));for(const x of list){const card=el('article',{class:'ldp-card'},el('strong',{},x.description),el('p',{},new Date(x.at).toLocaleString()+' · '+x.mode+' · '+(x.model||x.profile)+' · '+x.support.length+' 项依据，'+x.counter.length+' 项反证'));
    for(const k of x.sources){const v=c.views.get(a)?.byId.get(k);if(v)card.append(button('第'+(v.index+1)+'楼：'+text(v.text,48),()=>this.jump(v.index)));}if(!x.undone)card.append(button('撤销本次并屏蔽同证据',this.safe(async()=>{await c.undoAuto(a,x.id);close();})));b.append(card);}if(c.capture?.group){const cast=Object.fromEntries([[USER,c.capture.userName],...c.capture.cast.map(x=>[x.id,x.name])]);const who=new Set([a]);const from=input(c.capture.chat.length,'number'),to=input(c.capture.chat.length,'number');
    b.append(el('h4',{},'确认公开互动的在场角色'),el('p',{},'只对下列已保存楼层有效。独白或离场提示仍不向旁观者开放。'),field('起始楼（从 1 算起）',from),field('结束楼',to));for(const [k,n]of Object.entries(cast))b.append(toggle(n,who.has(k),v=>v?who.add(k):who.delete(k)));b.append(button('记录所选范围的知情权限',this.safe(async()=>{const i=Number(from.value)-1,j=Number(to.value)-1;if(!Number.isInteger(i)||!Number.isInteger(j)||i<0||j<i||j-i>=100||j>=c.capture.chat.length||who.size<2)throw Error('请指定已保存的 1–100 楼和至少两位在场者。');const anchor=c.timeline.path[i+1].hash;await c.mutate(s=>({...s,presence:[...(s.presence||[]),{id:id(),from:i,to:j,anchor,actors:[...who]}]}),'确认公开场景');close();})));for(const z of st.presence||[])b.append(button('撤销公开授权 '+(z.from+1)+'–'+(z.to+1)+' 楼',this.safe(async()=>{await c.mutate(s=>({...s,presence:s.presence.filter(y=>y.id!==z.id)}),'撤销场景授权');close();})));}});}
    settings() {
        const c = this.c, s = c.settings();
        modal('动态人格设置', (b, close) => {
            const values = {}, checks = {};
            const addInput = (key, label, type = 'text', hint) => { values[key] = input(s[key], type); b.append(field(label, values[key], hint)); };
            const addSelect = (key, label, options) => { values[key] = select(options, s[key]); b.append(field(label, values[key])); };
            const addCheck = (key, label) => { checks[key] = s[key]; b.append(toggle(label, s[key], v => { checks[key] = v; })); };

            addCheck('inject','允许单段临时注入');addCheck('immediate','允许即时状态参与演出');
            addCheck('analysisEnabled','允许所选分析档独立调用（额外请求，可能收费）');
            addCheck('autoAnalyze','达到阈值且空闲时自动分析；关闭时仅手动');
            addCheck('recoveryPopup','存档不一致时询问（默认静默暂停）');
            addInput('minTurns','自动分析至少积累几次本人有效回复（2–100）','number');
            addInput('batchSize','每批最多几个原文片段（2–24）','number');
            addInput('analysisBudgetMaxRequests','一次手动批量分析的请求上限（1–12）','number');
            addInput('analysisMaxTotalRequests','本机账户累计请求硬上限（0 禁止）','number');
            addInput('dailyLimit','每日请求上限（UTC，0 禁止）','number');addInput('sessionLimit','本页面会话请求上限（0 禁止）','number');
            addInput('promptBudget','单次注入 token 预算','number');
            addCheck('useJsonSchema','分析单独使用 Structured Outputs（默认普通 JSON）');
            addSelect('scope','主聊天适用范围',{all:'全部兼容聊天',gemini4:'仅 Gemini 4 Argon / Carbon / Hydrogen 别名'});
            addCheck('shareVariables','发送已逐项授权的手工字段（默认关）');
            addSelect('conflictMode', '旧情绪插件冲突策略', {growth:'仅成长（保留所有已审心理、关闭抽签）',
                partner:'始终让旧插件负责演出（改名安装时使用）',coexist: '协作：旧插件负责即时情绪抽签，本插件负责已审人格与全文检索',
                takeover: '完全接管：使用本插件完整情绪抽样/userAccess/阴暗动机引擎（需先停用旧插件）',
                pause: '检测到旧插件时暂停本插件注入',
            });
            addCheck('expressive', '启用完整情绪抽样、阴暗动机、userAccess 与跨回合情绪引擎');
            addCheck('independent','允许独立演出中的生活目标');addCheck('memory','允许随机情绪跨本人回复延续');
            for (const [key, label] of Object.entries({ intensity: '情绪烈度', dark: '阴暗面权重', unpredict: '行为随机性', eventRate: '生活插曲权重',userAccess:'与玩家的关联机会' })) {
                addInput(key, `${label}（0–100，设为 0 则完全关闭对应抽样）`, 'number');
                values[key].min = '0';
                values[key].max = '100';
            }
            const preset=(v)=>Object.entries(v).forEach(([k,n])=>values[k].value=String(n));b.append(button('均衡',()=>preset({intensity:65,dark:35,unpredict:40,eventRate:20,userAccess:45})),button('烈性',()=>preset({intensity:100,dark:95,unpredict:95,eventRate:40,userAccess:40})));
            b.append(
                el('p', {}, '这些数值驱动情绪卡池、阴暗面动机、userAccess 窗口与生活插曲抽样（设为 0 即 0% 触发），不是好感度。原始角色卡、世界书、预设始终不被写入。'),
                button('保存设置', this.safe(async () => {
                    const patch = { ...checks };
                    for (const [key, v] of Object.entries(values)) patch[key] = v.type === 'number' ? Math.max(0, Number(v.value) || 0) : v.value.trim();
                    c.changeSettings(patch);
                    close();
                }))
            );
        });
    }

    dispose() {
        this.root?.remove();
        for (const d of document.querySelectorAll('.ldp-dialog')) d.close?.();
    }
}
