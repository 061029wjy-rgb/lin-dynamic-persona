import { clone, id, text, clamp, visible, ooc } from './util.js';

export const LAYERS = ['acquired', 'short', 'immediate', 'goal'];
export const LABELS = { acquired: '后天人格', short: '短期心理', immediate: '即时影响', goal: '自主目标' };
export const EVIDENCE_TYPES = {
    fact: '客观事实',
    self_statement: '角色自述/承诺',
    appraisal: '角色主观理解',
    hypothesis: '心理推测',
    secret: '单方秘密/未公开',
};

export const emptyState = () => ({
    adoptions: [], presence: [], mentions: [], occurrences: [], appraisals: [], proposals: [], summaries: [], aliases: {}, notes: [],
    influences: [],
    experiences: [],
    blocks: [],
    processed: {},
    grants: {},
    revokes: {},
    baselines: {},
    variables: {},
    emotionState: {},
    world: { time: 0, scene: '', people: [], relationships: [], behaviors: [], autoDetect: true },
    turns: {},
    disabled: false,
    recoverySilent: false,
});

const list = v => Array.isArray(v) ? [...new Set(v.map(x => text(x, 160)).filter(Boolean))].slice(0, 64) : [];

export function normalizePersonRules(rules) {
    if (!rules || typeof rules !== 'object') return {};
    const out = {};
    for (const [person, rule] of Object.entries(rules)) {
        const k = text(person, 80).trim();
        const v = text(rule, 400).trim();
        if (k && v) out[k] = v;
    }
    return out;
}

export function normalizeEvolutionEntry(entry = {}) {
    return {
        id: text(entry.id || id(), 80),
        at: Number(entry.at) || Date.now(),
        node: text(entry.node || '', 80),
        type: ['formed', 'reinforced', 'weakened', 'revised', 'contradiction', 'retired', 'user_edit'].includes(entry.type) ? entry.type : 'revised',
        intensityBefore: entry.intensityBefore != null ? clamp(entry.intensityBefore, 0, 1, .5) : null,
        intensityAfter: entry.intensityAfter != null ? clamp(entry.intensityAfter, 0, 1, .5) : null,
        confidenceBefore: entry.confidenceBefore != null ? clamp(entry.confidenceBefore, 0, 1, .5) : null,
        confidenceAfter: entry.confidenceAfter != null ? clamp(entry.confidenceAfter, 0, 1, .5) : null,
        reason: text(entry.reason || '', 600),
        evidenceIds: list(entry.evidenceIds || []),
    };
}

export function normalizeInfluence(v, actorId) {
    if (!LAYERS.includes(v.layer) || !actorId || !String(v.description || '').trim()) throw new Error('影响需要角色、层级和描述');
    const duration = v.duration || {}, mode = ['turns', 'world', 'permanent'].includes(duration.mode) ? duration.mode :
        ['acquired', 'goal'].includes(v.layer) ? 'permanent' : 'turns';
    const count = Math.round(clamp(duration.remaining, 0, 10000, v.layer === 'short' ? 8 : 3));
    const intensity = clamp(v.intensity, 0, 1, .5);
    const confidence = clamp(v.confidence, 0, 1, v.layer === 'acquired' ? .75 : .65);
    const createdAt = v.createdAt || Date.now();
    const rawLog = Array.isArray(v.evolutionLog) ? v.evolutionLog.map(normalizeEvolutionEntry).slice(-40) : [];
    if (!rawLog.length) {
        rawLog.push(normalizeEvolutionEntry({
            at: createdAt,
            type: 'formed',
            intensityBefore: 0,
            intensityAfter: intensity,
            confidenceBefore: 0,
            confidenceAfter: confidence,
            reason: v.rationale || v.description,
            evidenceIds: list(v.evidence),
        }));
    }
    const planSteps = Array.isArray(v.planSteps) ? v.planSteps.map(s => text(s, 240)).filter(Boolean).slice(0, 16) : [];
    return {
        pinned:!!v.pinned,sourceKind:text(v.sourceKind,35),psyche:v.psyche?Object.fromEntries(Object.entries(v.psyche).filter(([k])=>['felt_state','appraisal','coping','habit','self_view','observed_behavior','valence','arousal','intensity'].includes(k)).map(([k,z])=>[k,typeof z==='number'?Math.max(-1,Math.min(1,z)):z==null?null:text(z,320)])):null,blockers:text(v.blockers,240),nextReview:text(v.nextReview,120),reviewState: v.reviewState || null, counterEvidence: list(v.counterEvidence), legacyEnabled:v.legacyEnabled, sourceKeys:list(v.sourceKeys),
        id: text(v.id || id(), 100),
        actorId,
        layer: v.layer,
        description: text(v.description),
        concept: text(v.concept || v.description, 220),
        selfView: text(v.selfView || v.psyche?.self_view, 600),
        behavior: text(v.behavior || v.observedBehavior || v.psyche?.observed_behavior, 600),
        observedBehavior: text(v.observedBehavior || v.psyche?.observed_behavior || v.behavior, 600),
        triggerCondition: text(v.triggerCondition || '', 400),
        actionDecision: text(v.actionDecision || v.behavior || '', 600),
        contradiction: text(v.contradiction || (v.selfView && v.behavior && v.selfView !== v.behavior ? `认知「${text(v.selfView, 120)}」与行动「${text(v.behavior, 120)}」并存` : ''), 500),
        rationale: text(v.rationale, 1200),
        intensity,
        confidence,
        priority: ['high', 'medium', 'low'].includes(v.priority) ? v.priority : (intensity >= 0.7 ? 'high' : intensity >= 0.4 ? 'medium' : 'low'),
        scope: {
            people: list(v.scope?.people),topics:list(v.scope?.topics),
            scenes: list(v.scope?.scenes),
            relationships: list(v.scope?.relationships),
            behaviors: list(v.scope?.behaviors),
        },
        personRules: normalizePersonRules(v.personRules),
        duration: {
            mode,
            remaining: mode === 'turns' ? count : null,
            until: mode === 'world' ? clamp(duration.until, 0, 1e12) : null,
            endCondition: text(duration.endCondition, 500),
        },
        motivation: text(v.motivation || v.rationale || '', 400),
        planSteps,
        currentStep: text(v.currentStep || planSteps[0] || '', 240),
        progress: Math.round(clamp(v.progress, 0, 100, 0)),
        goalStatus: ['active', 'paused', 'completed', 'abandoned', 'failed'].includes(v.goalStatus) ? v.goalStatus : (v.status === 'retired' ? 'completed' : 'active'),
        enabled: v.enabled !== false,
        frozen: !!v.frozen,
        allowConsolidation: v.allowConsolidation !== false,
        expression: ['latent', 'natural'].includes(v.expression) ? v.expression : 'natural',
        status: v.status === 'retired' ? 'retired' : 'active',
        evidence: list(v.evidence),
        evolutionLog: rawLog,
        managedBy: v.managedBy === 'user' ? 'user' : 'auto',
        createdAt,
        updatedAt: v.updatedAt || Date.now(),
    };
}

export function computeCanonicalEventSignature({ themeKey = '', quote = '', summary = '' } = {}) {
    const rawQuote = String(quote || summary || '').trim();
    const normalizedText = rawQuote
        .replace(/[\s，,。！？!?；;：:“"”'‘’「」『』（）()【】\[\]—…·]/g, '')
        .replace(/^(?:哎呀|抱歉|对不起|其实|说实话|跟你说|你知道吗)+/g, '')
        .replace(/[了的呢啊吧嘛呀哦哈]/g, '');
    const timeMatch = rawQuote.match(/(?:今天|今晚|今早|刚才|刚刚|昨晚|昨天|前天|上次|那次|周[一二三四五六日天]|上午|下午)/);
    const timeBucket = timeMatch ? timeMatch[0] : 'default_time';
    const baseKey = themeKey || 'general';
    return {
        eventSignature: text(`${baseKey}|${normalizedText}`, 180),
        occasionSignature: text(`${baseKey}|${timeBucket}`, 120),
    };
}

export function normalizeExperience(e, actorId) {
    const owner = actorId || e.actorId;
    if (!owner || !String(e.summary || '').trim()) throw new Error('经历需要角色与事件摘要');
    const evidenceType = Object.hasOwn(EVIDENCE_TYPES, e.evidenceType) ? e.evidenceType : 'appraisal';
    const firstQuote = e.sources?.[0]?.quote || '';
    const sigs = computeCanonicalEventSignature({ themeKey: e.themeKey, quote: firstQuote, summary: e.summary });
    return {
        reviewState:e.reviewState||null, occurrenceId:e.occurrenceId||null,
        id: text(e.id || id(), 100),
        actorId: owner,
        knownTo: list(e.knownTo?.length ? e.knownTo : [owner]),
        excludedFrom: list(e.excludedFrom || []),
        evidenceType,
        themeKey: text(e.themeKey || '', 80),
        eventSignature: text(e.eventSignature || sigs.eventSignature, 180),
        occasionSignature: text(e.occasionSignature || sigs.occasionSignature, 120),
        participants: list(e.participants || []),
        summary: text(e.summary, 1000),
        appraisal: text(e.appraisal || e.summary, 1000),
        attribution: text(e.attribution || '', 600),
        impactDirection: text(e.impactDirection || '', 240),
        salience: clamp(e.salience, 0, 1, .6),
        userCorrected: !!e.userCorrected,
        sources: Array.isArray(e.sources) ? e.sources.map(s => ({
            start: s.start, end:s.end, rawStart:s.rawStart, rawEnd:s.rawEnd, speakerId:s.speakerId, swipe:s.swipe,
            node: text(s.node, 100),
            quote: text(s.quote, 600),
            key: text(s.key || s.node, 100),
            index: Number.isInteger(s.index) ? s.index : 0,
        })) : [],
        createdAt: e.createdAt || Date.now(),
        updatedAt: e.updatedAt || Date.now(),
    };
}

export function migrateState(rawState) {
    if (!rawState || typeof rawState !== 'object') return emptyState();
    const base = emptyState();
    const s = {
        ...base,
        ...clone(rawState),
        revokes: rawState.revokes && typeof rawState.revokes === 'object' ? clone(rawState.revokes) : {},
        baselines: rawState.baselines && typeof rawState.baselines === 'object' ? clone(rawState.baselines) : {},
        variables: rawState.variables && typeof rawState.variables === 'object' ? clone(rawState.variables) : {},
        emotionState: rawState.emotionState && typeof rawState.emotionState === 'object' ? clone(rawState.emotionState) : {},
        world: {
            ...base.world,
            ...(rawState.world || {}),
            people: list(rawState.world?.people),
            relationships: list(rawState.world?.relationships),
            behaviors: list(rawState.world?.behaviors),
        },
    };
    s.influences = Array.isArray(rawState.influences)
        ? rawState.influences.map(x => {
            try { return normalizeInfluence(x, x.actorId); } catch { return x; }
        })
        : [];
    s.experiences = Array.isArray(rawState.experiences)
        ? rawState.experiences.map(e => {
            try { return normalizeExperience(e, e.actorId); } catch { return e; }
        })
        : [];
    return s;
}

export function editExperience(state, expPatch, actorId, propagate = true) {
    const s = clone(state);
    const idx = s.experiences.findIndex(x => x.id === expPatch.id);
    const prev = idx >= 0 ? s.experiences[idx] : null;
    const updated = normalizeExperience({ ...prev, ...expPatch, userCorrected: true }, actorId || prev?.actorId);
    if (idx >= 0) s.experiences[idx] = updated;
    else s.experiences.push(updated);

    if (propagate) {
        for (const inf of s.influences) {
            if (inf.actorId === updated.actorId && inf.evidence.includes(updated.id) && !inf.frozen) {
                const oldReason = inf.rationale;
                const attributionNote = updated.attribution ? `（用户校正归因：${updated.attribution}）` : '';
                inf.rationale = text(`${updated.appraisal}${attributionNote}`, 1200);
                if (expPatch.syncDescription && expPatch.correctedBehavior) {
                    inf.behavior = text(expPatch.correctedBehavior, 600);
                    inf.actionDecision = text(expPatch.correctedBehavior, 600);
                }
                inf.evolutionLog = [...(inf.evolutionLog || []), normalizeEvolutionEntry({
                    type: 'user_edit',
                    intensityBefore: inf.intensity,
                    intensityAfter: inf.intensity,
                    confidenceBefore: inf.confidence,
                    confidenceAfter: Math.max(inf.confidence, 0.85),
                    reason: `用户纠正事件解释与归因：${oldReason} -> ${inf.rationale}`,
                    evidenceIds: [updated.id],
                })].slice(-40);
                inf.confidence = Math.max(inf.confidence, 0.85);
                inf.updatedAt = Date.now();
            }
        }
    }
    return s;
}

export function extractBaseline(actor, override = null) {
    const raw = String(actor?.baseline || '').trim();
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const traitKeywords = ['克制', '冷静', '温柔', '敏感', '骄傲', '理智', '谨慎', '守时', '果断', '内敛', '毒舌', '外冷内热', '重诺', '敏锐', '孤独', '偏执', '直率', '温和', '严谨', '护短', '慢性子', '强势', '严厉', '冷漠', '冷酷'];
    const foundTraits = traitKeywords.filter(k => raw.includes(k));
    const coreTraits = override?.coreTraits?.length
        ? list(override.coreTraits)
        : (foundTraits.length ? foundTraits : lines.slice(0, 3).map(l => text(l, 80))).slice(0, 12);

    const redlineSentences = lines.filter(l => /(?:绝不|底线|原则|从不|禁忌|不会背叛|不能容忍|坚守|核心)/.test(l));
    const bottomLines = override?.bottomLines?.length
        ? list(override.bottomLines)
        : (redlineSentences.length ? redlineSentences.map(l => text(l, 140)) : [`保持「${actor?.name || '角色'}」原始性格基调，不无故崩坏或顺从无理要求`]);

    const speechMatches = lines.filter(l => /(?:说话|语气|言辞|口吻|表达|习惯用语|声线|称呼)/.test(l));
    const speechStyle = text(override?.speechStyle ?? (speechMatches[0] || '贴合原卡设定，言行与心理层次分明'), 300);

    const relMatches = lines.filter(l => /(?:关系|搭档|恋人|青梅竹马|上下级|朋友|妻子|丈夫|死敌|敌对|同事|不认识|陌生|对.*态度)/.test(l));
    const initialRelationships = override?.initialRelationships?.length
        ? list(override.initialRelationships)
        : relMatches.map(l => text(l, 140)).slice(0, 8);

    return {
        actorId: actor?.id || '',
        actorName: actor?.name || '',
        rawText: text(raw, 4000),
        summary: text(override?.summary ?? (lines.slice(0, 4).join('；') || '按原始角色卡设定'), 600),
        coreTraits,
        bottomLines,
        speechStyle,
        initialRelationships,
        calibratedByUser: !!override?.calibratedByUser,
        locked: !!override?.locked,
        updatedAt: override?.updatedAt || Date.now(),
    };
}

export function setBaselineOverride(state, actorId, override) {
    const s = clone(state);
    s.baselines ||= {};
    s.baselines[actorId] = {
        ...s.baselines[actorId],
        ...override,
        coreTraits: list(override.coreTraits),
        bottomLines: list(override.bottomLines),
        initialRelationships: list(override.initialRelationships),
        speechStyle: text(override.speechStyle || '', 300),
        summary: text(override.summary || '', 600),
        calibratedByUser: true,
        locked: override.locked !== false,
        updatedAt: Date.now(),
    };
    return s;
}

export function normalizeVariable(v, actorId = '__world__') {
    const key = text(v.key, 80).trim();
    if (!key) throw new Error('变量名不能为空');
    return {
        id: text(v.id || `${actorId}:${key}`, 120),
        actorId,
        key,
        value: Array.isArray(v.value)?v.value.map(x=>text(x,160)).slice(0,48):typeof v.value === 'number' || typeof v.value === 'boolean' ? v.value : text(v.value ?? '', 400),
        category: ['relationship', 'psychology', 'status', 'custom'].includes(v.category) ? v.category : 'custom',
        description: text(v.description || '', 300),
        autoUpdate: v.autoUpdate !== false,
        source: v.source === 'user' ? 'user' : 'auto',
        history: Array.isArray(v.history) ? v.history.slice(-20) : [],
        updatedAt: Date.now(),
    };
}

export function setVariable(state, actorId, variableInput, reason = '手动设置') {
    const s = clone(state);
    s.variables ||= {};
    const bucket = s.variables[actorId] ? [...s.variables[actorId]] : [];
    const idx = bucket.findIndex(x => x.key === variableInput.key);
    const prev = idx >= 0 ? bucket[idx] : null;
    const norm = normalizeVariable({
        ...prev,
        ...variableInput,
        history: [
            ...(prev?.history || []),
            { at: Date.now(), from: prev?.value ?? null, to: variableInput.value, reason: text(reason, 200) },
        ].slice(-20),
    }, actorId);
    if (idx >= 0) bucket[idx] = norm;
    else bucket.push(norm);
    s.variables[actorId] = bucket;
    return s;
}

export function deleteVariable(state, actorId, key) {
    const s = clone(state);
    if (!s.variables?.[actorId]) return s;
    s.variables[actorId] = s.variables[actorId].filter(v => v.key !== key);
    return s;
}

export function discoverVariables({ actor, chat = [], state }) {
    const discovered = [];
    const existingKeys = new Set((state?.variables?.[actor?.id] || []).map(v => v.key));
    const sources = [actor?.baseline || '', ...chat.slice(-15).map(m => visible(m?.mes || ''))].join('\n');

    const kvRegex = /[【\[（(]?\s*([\p{Script=Han}A-Za-z0-9_]{2,14})\s*[：:=]\s*([^\n\]】）),，;；]{1,36})\s*[】\])）]?/gu;
    const ignoreKeys = new Set(['时间', '地点', '场景', '人物', '注意', '提示', '示例', '说明', '系统', '输出', '思考', '总结', 'http', 'https']);
    for (const match of sources.matchAll(kvRegex)) {
        const key = match[1].trim();
        const rawVal = match[2].trim();
        if (ignoreKeys.has(key.toLowerCase()) || existingKeys.has(key)) continue;
        if (/(?:度|值|率|感|状态|阶段|关系|次数|心情|防备|信任|默契|压力|精力|好感|距离|承诺)/.test(key)) {
            const num = Number(rawVal.replace(/%$/, ''));
            discovered.push(normalizeVariable({
                key,
                value: Number.isFinite(num) && rawVal !== '' ? num : rawVal,
                category: /(?:关系|信任|好感|默契|距离|承诺)/.test(key) ? 'relationship' : /(?:心情|防备|压力|状态)/.test(key) ? 'psychology' : 'status',
                description: '从角色卡/剧情状态中自动发现的自定义变量',
                autoUpdate: true,
                source: 'auto',
            }, actor?.id || '__world__'));
            existingKeys.add(key);
        }
    }

    const actorInfluences = (state?.influences || []).filter(x => x.actorId === actor?.id && x.status === 'active');
    if (!existingKeys.has('当前主导倾向') && actorInfluences.some(x => x.layer === 'acquired')) {
        const latest = actorInfluences.find(x => x.layer === 'acquired');
        discovered.push(normalizeVariable({
            key: '当前主导倾向',
            value: text(latest.concept || latest.description, 40),
            category: 'psychology',
            description: '当前已沉淀的后天主导倾向变量',
            autoUpdate: true,
            source: 'auto',
        }, actor?.id));
    }
    return discovered;
}

// Physical locations vs Remote communication channel
const PHYSICAL_SCENE_DICT = [
    ['医院/诊室', /(?:医院|急诊室?|病房|诊室|手术室|药房|挂号处|护士站)/g],
    ['办公室/职场', /(?:办公室|公司|会议室|工位|写字楼|工作室|事务所|项目组|桌前办公)/g],
    ['家中/居所', /(?:回家|回到家|到家|家里|家中|宅邸|住处|居所|客厅|卧室|书房|厨房|阳台|公寓|玄关|沙发上|床边|房间里)/g],
    ['餐厅/咖啡馆', /(?:餐厅|饭店|咖啡馆|咖啡厅|茶馆|酒吧|包厢|餐桌旁?)/g],
    ['户外/街道', /(?:街头|街道|马路|公园|广场|天桥|路口|雨中|夜路)/g],
    ['交通/旅途', /(?:车里|车内|副驾|地铁|车站|机场|航班|高铁|出租车)/g],
    ['校园/教室', /(?:学校|教室|图书馆|操场|实验室|宿舍|校园)/g],
];

const COMM_SCENE_REGEX = /(?:通过电话|视频通话中|语音通话中|在电话里|屏幕那头)/;

const RELATIONSHIP_DICT = [
    ['恋人/伴侣', /(?:恋人|男友|女友|伴侣|夫妻|妻子|丈夫|结婚|约会|亲吻|拥抱)/],
    ['搭档/同事', /(?:同事|搭档|合作|项目|上下级|上司|下属|甲方|团队)/],
    ['朋友/熟人', /(?:朋友|好友|老友|同学|室友|青梅竹马)/],
    ['照料/依赖', /(?:照顾|探病|喂药|陪伴|接送|担心|守候)/],
    ['试探/拉扯', /(?:试探|冷战|沉默|对峙|僵持|疏远|防备|敷衍)/],
    ['承诺/约定', /(?:约定|承诺|答应|守约|失约|爽约|迟到|准时|赴约)/],
    ['和解/解释', /(?:道歉|解释|原谅|理解|弥补|和好|坦白)/],
];

const BEHAVIOR_DICT = [
    ['工作/规划', /(?:工作|加班|处理文件|报表|安排|日程|备选|先忙)/],
    ['等待/赴约', /(?:等待|等了|赴约|见面|碰面|迟到|失约|改期)/],
    ['沟通/确认', /(?:确认|通知|告知|报备|发消息|打电话|拿起手机|询问|解释)/],
    ['照顾/关怀', /(?:买药|煮粥|披上|倒水|照顾|休息|擦干|叮嘱)/],
    ['争执/防备', /(?:争吵|质问|冷淡|反问|沉默|避开|拒绝)/],
];

const PAST_OR_MEMORY_CLAUSE_RE = /(?:昨晚|昨天|昨日|前天|那天|上次|上回|上周|上个月|去年|以前|过去|曾经|当初|早些时候|之前在|刚才在.*时|那时候|小时候|在.*等了你|在.*见过|梦见|梦到|做梦|回忆起?|想起|说起|谈论|聊起|提起|谈到|聊到|询问|问起|打听|讨论)/;
const FUTURE_OR_PLAN_CLAUSE_RE = /^(?:明天|下周|下个月|改天|下次|以后|将来)|(?:明天|下周|下个月|改天|下次|要不要|打算|准备|想|如果|假如)(?:去|到|在|回|来)/;
const PRESENT_ARRIVAL_OVERRIDE_RE = /(?:今天终于|现在已经|如今在|现在我们|此刻在|终于回到|终于到|已经回到|已经到)/;

function resolvePresentSceneFromClauses(segment, { requireExplicitPresent = false } = {}) {
    if (!segment || !segment.trim()) return null;

    // Strip departed places within clauses ("离开医院回到家") and discussed topic complements ("谈论昨天的医院经历", "聊聊下周的项目")
    const preCleaned = segment
        .replace(/(?:离开|走出|告别|搬出|撤离|从)([^，。！？；\s]{1,12}?)(?:出来|离开|回到|来到|前往|去了|走|后)/g, ' 回到 ')
        .replace(/(?:谈论|说起|聊起|聊聊|谈谈|说说|商量|提起|谈到|聊到|询问|问起|打听|回忆起?|想起|讨论|说起关于|聊着)[^，。！？；\n]*/g, '')
        .replace(/[\p{Script=Han}]{1,6}(?:经历|生活|往事|故事|话题|传闻|记忆)/gu, '');

    const clauses = preCleaned.split(/[，,。！？!?；;\n]+/).map(c => c.trim()).filter(Boolean);
    const presentClauses = [];

    for (const clause of clauses) {
        const hasPresentOverride = PRESENT_ARRIVAL_OVERRIDE_RE.test(clause);
        if (!hasPresentOverride && PAST_OR_MEMORY_CLAUSE_RE.test(clause)) {
            continue;
        }
        if (FUTURE_OR_PLAN_CLAUSE_RE.test(clause)) {
            continue;
        }
        if (requireExplicitPresent && !/(?:现在|此刻|目前|今天终于|已经到|回到|来到|坐在|站在|身处|身在|我们正在)/.test(clause)) {
            continue;
        }
        presentClauses.push(clause);
    }

    if (!presentClauses.length) return null;
    const joined = presentClauses.join('，');

    // Priority 1: Explicit physical presence / arrival anchors
    let bestAnchorLabel = null;
    let bestAnchorPos = -1;
    for (const [label, regex] of PHYSICAL_SCENE_DICT) {
        const anchorPattern = new RegExp(`(?:在|坐在|站在|躺在|身在|身处|留在|待在|回到|来到|走进|抵达|置身|终于)[^，。！？；\\n]{0,6}?(?:${regex.source})`, 'g');
        for (const m of joined.matchAll(anchorPattern)) {
            if (m.index >= bestAnchorPos) {
                bestAnchorPos = m.index;
                bestAnchorLabel = label;
            }
        }
    }
    if (bestAnchorLabel) return bestAnchorLabel;

    // Priority 2: General physical scene nouns in surviving present clauses
    let bestPhysicalLabel = null;
    let bestPhysicalPos = -1;
    for (const [label, regex] of PHYSICAL_SCENE_DICT) {
        const r = new RegExp(regex.source, 'g');
        for (const m of joined.matchAll(r)) {
            if (m.index >= bestPhysicalPos) {
                bestPhysicalPos = m.index;
                bestPhysicalLabel = label;
            }
        }
    }
    return bestPhysicalLabel;
}

export function extractLatestSceneFromText(msgText) {
    const s = String(msgText || '');
    if (!s) return null;

    // Step 1: Extract outer narrative frame (text outside quotation marks)
    const narrativeFrame = s.replace(/[“"「『][^”"」』]*[”"」』]/g, ' ');
    const narrativeScene = resolvePresentSceneFromClauses(narrativeFrame, { requireExplicitPresent: false });
    if (narrativeScene) return narrativeScene;

    // Step 2: If no scene in narrative frame, inspect full text with strict temporal filtering on clauses
    const fullScene = resolvePresentSceneFromClauses(s, { requireExplicitPresent: false });
    if (fullScene) return fullScene;

    // Step 3: Only fall back to '线上/通讯' if NO physical location exists and explicit remote communication is occurring
    if (COMM_SCENE_REGEX.test(s)) {
        return '线上/通讯';
    }
    return null;
}

export function detectWorldContext({ chat = [], cast = [], state = {}, userName = '' }) {
    const manual = state?.world || { time: 0, scene: '', people: [], relationships: [], behaviors: [] };
    if (manual.autoDetect === false) return clone(manual);

    const validChat = (chat || []).filter(m => m && !m.is_system && !ooc(m.mes));
    const recentWindow = validChat.slice(-4);
    const activeWindow = validChat.slice(-2);
    const recentText = recentWindow.map(m => `${m.name || ''}：${visible(m.mes)}`).join('\n');
    const activeText = activeWindow.map(m => `${m.name || ''}：${visible(m.mes)}`).join('\n');

    let detectedScene = manual.scene || '';
    if (!detectedScene) {
        for (let i = recentWindow.length - 1; i >= 0; i--) {
            const found = extractLatestSceneFromText(visible(recentWindow[i].mes));
            if (found) {
                detectedScene = found;
                break;
            }
        }
    }
    const autoScenes = new Set();
    if (detectedScene) {
        autoScenes.add(detectedScene);
        for (const part of detectedScene.split('/')) autoScenes.add(part);
    }

    const peopleSet = new Set(manual.people || []);
    const departedNames = new Set();
    for (const m of recentWindow) {
        const txt = visible(m.mes);
        for (const match of txt.matchAll(/([\p{Script=Han}A-Za-z0-9_]{1,10})(?:离开了|走出了|先行离开|不在场|已经走了)/gu)) {
            departedNames.add(match[1]);
        }
        for (const match of txt.matchAll(/([\p{Script=Han}A-Za-z0-9_]{1,10})(?:走进了|回到了|推门进来|赶到了)/gu)) {
            departedNames.delete(match[1]);
        }
    }

    for (const m of activeWindow) {
        if (m.name && !departedNames.has(m.name)) peopleSet.add(text(m.name, 60));
        if (m.is_user && userName && !departedNames.has(userName)) peopleSet.add(text(userName, 60));
        if (m.original_avatar) peopleSet.add(text(m.original_avatar, 60));
    }
    if (userName && !departedNames.has(userName)) peopleSet.add(text(userName, 60));
    for (const a of cast) {
        if (a.name && !departedNames.has(a.name) && (activeText.includes(a.name) || cast.length === 1)) {
            peopleSet.add(a.name);
            peopleSet.add(a.id);
        }
    }
    for (const inf of state?.influences || []) {
        for (const p of inf.scope?.people || []) {
            if (p && !departedNames.has(p) && activeText.includes(p)) peopleSet.add(p);
        }
        for (const p of Object.keys(inf.personRules || {})) {
            if (p && !departedNames.has(p) && activeText.includes(p)) peopleSet.add(p);
        }
    }

    const relSet = new Set(manual.relationships || []);
    for (const [label, regex] of RELATIONSHIP_DICT) {
        if (regex.test(activeText || recentText)) {
            relSet.add(label);
            for (const part of label.split('/')) relSet.add(part);
        }
    }

    const behSet = new Set(manual.behaviors || []);
    for (const [label, regex] of BEHAVIOR_DICT) {
        if (regex.test(activeText || recentText)) {
            behSet.add(label);
            for (const part of label.split('/')) behSet.add(part);
        }
    }

    const autoTime = Number(manual.time) || 0;
    // Only a player-confirmed story clock may expire a timed influence.
    return {
        time: autoTime,
        scene: detectedScene,
        scenes: [...autoScenes],
        people: [...peopleSet],
        relationships: [...relSet],
        behaviors: [...behSet],
        recentText: activeText || recentText,
        autoDetect: manual.autoDetect !== false,
    };
}

export function active(x, world = {}) {
    return !['legacy','review','invalid'].includes(x.reviewState) && x.enabled && x.status === 'active' && x.goalStatus !== 'completed' && x.goalStatus !== 'abandoned' && x.goalStatus !== 'paused' && x.goalStatus !== 'failed' &&
        (x.frozen || x.duration.mode === 'permanent' ||
        (x.duration.mode === 'turns' ? x.duration.remaining > 0 : (world?.time || 0) < x.duration.until));
}

function fuzzyMatchList(scopeItems, worldItems = []) {
    if (!scopeItems?.length) return true;
    return scopeItems.some(target => {
        const t = String(target || '').trim();
        if (!t) return true;
        return worldItems.some(w => w === t);
    });
}

export function inScope(x, world = {}) {
    const s = x.scope || {};
    const worldScenes = [world?.scene, ...(world?.scenes || [])].filter(Boolean);
    return (!s.topics?.length||s.topics.some(t=>String(world.query||world.recentText||world.scene||'').includes(t))) && fuzzyMatchList(s.people, world?.people || []) &&
        fuzzyMatchList(s.scenes, worldScenes) &&
        fuzzyMatchList(s.relationships, world?.relationships || []) &&
        fuzzyMatchList(s.behaviors, world?.behaviors || []);
}

export function tick(state, actorId, inPlace = false) {
    const s = inPlace ? state : clone(state);
    if (!actorId || s.disabled) return s;
    s.turns[actorId] = (s.turns[actorId] || 0) + 1;
    for (const x of s.influences) {
        if (x.actorId === actorId && active(x, s.world) && !x.frozen && x.duration.mode === 'turns') {
            x.duration.remaining = Math.max(0, x.duration.remaining - 1);
        }
    }
    if (s.emotionState?.[actorId]?.carryRemaining > 0) {
        s.emotionState[actorId].carryRemaining = Math.max(0, s.emotionState[actorId].carryRemaining - 1);
    }
    return s;
}

export function blocked(state, actorId, concept, evidence) {
    return state.blocks.some(b => b.actorId === actorId && (b.concept && b.concept === concept || evidence.some(e => b.evidence.includes(e))));
}

export function userEdit(state, value, actorId) {
    const s = clone(state);
    const oldIdx = s.influences.findIndex(i => i.id === value.id);if(oldIdx>=0&&s.influences[oldIdx].actorId!==actorId)throw Error('不能用另一角色的标识覆盖本角色记录。');
    const prev = oldIdx >= 0 ? s.influences[oldIdx] : null;
    const x = normalizeInfluence({ ...prev, ...value, updatedAt:Date.now(), managedBy: 'user' }, actorId);
    if (prev) {
        x.evolutionLog = [
            ...(prev.evolutionLog || []),
            normalizeEvolutionEntry({
                type: 'user_edit',
                intensityBefore: prev.intensity,
                intensityAfter: x.intensity,
                confidenceBefore: prev.confidence,
                confidenceAfter: x.confidence,
                reason: `用户手动编辑：${x.description}`,
                evidenceIds: x.evidence,
            }),
        ].slice(-40);
    }
    if (oldIdx < 0) s.influences.push(x); else s.influences[oldIdx] = x;
    return s;
}

export function removeInfluence(state, influenceId, prevent = true) {
    const s = clone(state), x = s.influences.find(i => i.id === influenceId);
    if (!x) return s;
    if (prevent) {
        const evidence = s.experiences.filter(e => x.evidence.includes(e.id));
        s.blocks.push({ id: id(), actorId: x.actorId, concept: x.concept, evidence: [...(x.sourceKeys||[]),...evidence.flatMap(e => e.sources.map(z => z.key))], reason: '用户删除并禁止自动重建' });
    }
    s.influences = s.influences.filter(i => i.id !== influenceId);
    return s;
}

export function batchOperateInfluences(state, ids, action, payload = {}) {
    const s = clone(state);
    const targetSet = new Set(ids || []);
    if (!targetSet.size) return s;
    if (action === 'delete') {
        for (const targetId of targetSet) {
            const x = s.influences.find(i => i.id === targetId);
            if (!x) continue;
            if (payload.prevent !== false) {
                const evidence = s.experiences.filter(e => x.evidence.includes(e.id));
                s.blocks.push({ id: id(), actorId: x.actorId, concept: x.concept, evidence: [...(x.sourceKeys||[]),...evidence.flatMap(e => e.sources.map(z => z.key))], reason: '用户批量删除并屏蔽' });
            }
        }
        s.influences = s.influences.filter(i => !targetSet.has(i.id));
        return s;
    }
    for (const x of s.influences) {
        if (!targetSet.has(x.id)) continue;
        if (action === 'freeze') x.frozen = true;
        else if (action === 'unfreeze') x.frozen = false;
        else if (action === 'enable') x.enabled = true;
        else if (action === 'disable') x.enabled = false;
        else if (action === 'setUser') x.managedBy = 'user';
        else if (action === 'setAuto') x.managedBy = 'auto';
        x.updatedAt = Date.now();
    }
    return s;
}

export function computeStateDiff(stateA = emptyState(), stateB = emptyState()) {
    const aInf = new Map((stateA?.influences || []).map(x => [x.id, x]));
    const bInf = new Map((stateB?.influences || []).map(x => [x.id, x]));
    const addedInfluences = [];
    const removedInfluences = [];
    const modifiedInfluences = [];

    for (const [idKey, x] of bInf) {
        if (!aInf.has(idKey)) addedInfluences.push(x.concept || x.description);
        else {
            const prev = aInf.get(idKey);
            if (prev.description !== x.description || prev.intensity !== x.intensity || prev.status !== x.status || prev.duration?.remaining !== x.duration?.remaining) {
                modifiedInfluences.push(`${x.concept || x.description}（强度 ${Math.round((prev.intensity || 0) * 100)}% → ${Math.round((x.intensity || 0) * 100)}%）`);
            }
        }
    }
    for (const [idKey, x] of aInf) {
        if (!bInf.has(idKey)) removedInfluences.push(x.concept || x.description);
    }

    const aExp = new Set((stateA?.experiences || []).map(e => e.id));
    const bExp = new Set((stateB?.experiences || []).map(e => e.id));
    const addedExperiences = (stateB?.experiences || []).filter(e => !aExp.has(e.id)).map(e => e.summary);
    const removedExperiences = (stateA?.experiences || []).filter(e => !bExp.has(e.id)).map(e => e.summary);

    return {
        addedInfluences,
        removedInfluences,
        modifiedInfluences,
        addedExperiences,
        removedExperiences,
        hasChanges: !!(addedInfluences.length || removedInfluences.length || modifiedInfluences.length || addedExperiences.length || removedExperiences.length),
    };
}

export function validateState(s) {
    if (!s || !Array.isArray(s.influences) || !Array.isArray(s.experiences) || !Array.isArray(s.blocks) || !s.world || !s.processed || !s.turns || !s.grants) throw new Error('快照结构无效');
    for(const k of ['adoptions','presence','mentions','occurrences','appraisals','proposals','summaries','notes'])if(s[k]!=null&&!Array.isArray(s[k]))throw Error('分支表无效：'+k);
    for(const k of ['turns','processed','grants','revokes','aliases','peopleRegistry','variables','cognitiveHistory'])if(s[k]!=null&&(!s[k]||typeof s[k]!=='object'||Array.isArray(s[k])||Object.keys(s[k]).some(k=>['__proto__','constructor','prototype'].includes(k))))throw Error('权限或索引结构无效');
    for(const z of s.presence||[])if(!Number.isInteger(z.from)||!Number.isInteger(z.to)||z.from<0||z.to<z.from||z.to-z.from>=100||typeof z.anchor!=='string'||!Array.isArray(z.actors)||!z.actors.every(k=>typeof k==='string'))throw Error('公开场景来源无效');
    for (const x of s.influences) {
        if (!x.id || !x.actorId || !LAYERS.includes(x.layer) || !x.duration || !x.scope ||
            !['people', 'scenes', 'relationships', 'behaviors'].every(k => Array.isArray(x.scope[k]))) throw new Error('影响数据无效');
    }
    for (const e of s.experiences) if (!e.id || !e.actorId || !Array.isArray(e.sources) || !Array.isArray(e.knownTo)) throw new Error('经历数据无效');
    for (const b of s.blocks) if (!b.actorId || !Array.isArray(b.evidence)) throw new Error('屏蔽数据无效');
    return s;
}
