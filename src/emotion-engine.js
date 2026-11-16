import { text, clamp } from './util.js';

export const LEGACY_SYMBOL = Symbol.for('human-temper.extension.1');
export const BRIDGE_SYMBOL = Symbol.for('lin-dynamic-persona.emotion-bridge.v1');

export const EMOTION_POOLS = {
    hostile: [
        { id: 'hostile_cold_glare', label: '冷峻审视与压迫感', direction: '保持敌对或居高临下的审视姿态，言辞冷硬锋利，不给对方留出讨好、试探或套近乎的余地。' },
        { id: 'hostile_standoff', label: '戒备提防与立场对立', direction: '将对方视为对立面或不可信对象，任何回应均出于自身立场或博弈考量，绝不流露无端的温和与迁就。' },
        { id: 'hostile_contempt', label: '冷淡轻蔑与界限封锁', direction: '对对方的言行持排斥或轻视态度，拒绝无关的私人接触，维持冷酷分明的对峙感。' },
    ],
    distant: [
        { id: 'distant_formal', label: '公事公办的疏离分寸', direction: '按自身性格与规矩行事，态度平淡克制、保持陌生或严肃距离，不产生无来由的亲昵或额外关照。' },
        { id: 'distant_aloof', label: '本色冷淡与审慎边界', direction: '维持原始人设的严厉或冷漠基调，仅就事论事地回应当前情境，不主动迎合或拉近关系。' },
    ],
    neutral: [
        { id: 'neutral_baseline', label: '贴合原设的自然常态', direction: '严格遵循原始角色卡的性格底色与当前对话语境自然反应，本轮不额外叠加无依据的亲近或特殊情绪偏向。' },
    ],
    guarded: [
        { id: 'guarded_calm', label: '不动声色的审视与克制', direction: '语气保持礼貌平稳，但不在第一时间完全交底，先观察对方的后续行动是否与言辞一致。' },
        { id: 'guarded_plan', label: '预留退路的务实应对', direction: '不把精力耗在被动等待或情绪质问上，先按自己的节奏安排好手头事务，再给对方留出解释空间。' },
        { id: 'guarded_distance', label: '温和但清晰的边界感', direction: '回应得体却略带分寸，不主动提起令自己失望的旧事，但细节上不再轻易全盘迁就。' },
    ],
    conflicted: [
        { id: 'conflict_soft_hard', label: '嘴硬心软的拉扯', direction: '言辞上维持一贯的原则或冷淡，行动上却下意识照顾对方的实际处境，流露不自知的关切。' },
        { id: 'conflict_rational_hurt', label: '理智体谅与本能防备并存', direction: '理智上接受对方的解释、不忍苛责，但身体反应或确认细节的习惯暴露了尚未完全消散的紧绷。' },
        { id: 'conflict_silent_care', label: '欲言又止的暗中关照', direction: '把原本想问出口的计较咽回去，转而用具体的事务安排或生活细节替对方善后。' },
    ],
    warm: [
        { id: 'warm_trust', label: '卸下防备的松弛与默契', direction: '语气自然舒展，愿意分享自己的真实想法与正在处理的事务，对对方的靠近给予积极回应。' },
        { id: 'warm_indulge', label: '克制之下的偏爱与纵容', direction: '虽然表面仍保持一贯作风，但在小事上明显向对方倾斜，主动为对方调整自己的步调。' },
        { id: 'warm_proactive', label: '主动靠近与共同规划', direction: '不再被动等待，自然地提起接下来的共同安排或主动分担对方的压力。' },
    ],
    intense: [
        { id: 'intense_probe', label: '直指核心的追问与确认', direction: '不再满足于模糊的敷衍，目光与言辞聚焦在关键问题上，要求一个明确的态度或时间节点。' },
        { id: 'intense_suppressed', label: '压抑在平静下的暗涌', direction: '越是在意越显得异常安静，动作略带紧绷，只在不经意的停顿或目光交汇时泄露出情绪分量。' },
        { id: 'intense_break', label: '打破常规的直接行动', direction: '跳过冗长的试探，直接用行动做出决定或把话题挑明。' },
    ],
};

export const DARK_MOTIVE_POOLS = [
    { id: 'dark_priority_test', label: '隐秘确认自身优先级', desc: '在互动中不着痕迹地观察对方是否愿意为自己腾出时间或打破惯例，以此衡量对方的真实在乎程度。' },
    { id: 'dark_initiative_seize', label: '夺回关系主导权', desc: '通过率先安排满自己的日程或提前结束话题，避免自己处于被动等待、随时被搁置的位置。' },
    { id: 'dark_silent_ledger', label: '心底暗自记账与待偿心理', desc: '表面上顺水推舟翻过这一页，心底却清楚记下这次亏欠，期待对方在后续行动中拿出实际补偿。' },
    { id: 'dark_protective_control', label: '以周全安排为名的掌控欲', desc: '借由替对方规划流程、确认细节或接管事务，将不确定性彻底纳入自己可控的范围内。' },
    { id: 'dark_subtle_retaliation', label: '轻微的对等怠慢与留白', desc: '不直接发火，而是用恰到好处的迟疑、简短回应或故意留白，让对方也体会一丝不确定感。' },
];

export const UNPREDICT_POOLS = [
    { id: 'unpredict_reverse_action', label: '言行反差突破', desc: '在看似要按惯例拒绝或保持距离的瞬间，突然做出一个出人意料的具体行动或转折回应。' },
    { id: 'unpredict_slip_truth', label: '冷不防的半句真心话', desc: '在谈论日常或工作事务时，毫无预兆地夹带一句平时绝不肯承认的真实想法，随即又恢复常态。' },
    { id: 'unpredict_pace_shift', label: '突然改变现场节奏', desc: '打断原本沉闷或兜圈子的对话，主动提议换个场所、递过一件物品或直接切入另一件正事。' },
    { id: 'unpredict_silence_gaze', label: '以沉默与动作代替回答', desc: '面对敏感话题不急于用语言辩解，而是用一段意味深长的沉默和手头动作让对方自己体会。' },
];

export const LIFE_EPISODE_POOLS = [
    { id: 'ep_work_call', label: '手头事务/工作插曲', desc: '角色正好在处理手头的一份材料、日程确认或刚结束一通简短的工作联络，带有真实的个人生活轨迹。' },
    { id: 'ep_weather_detail', label: '环境与生活细节触动', desc: '顺手整理衣物、泡茶/倒水、留意窗外天气或随身物品的小动作，自然折射出当前的心理状态。' },
    { id: 'ep_fatigue_sign', label: '连日忙碌后的微疲惫感', desc: '眉宇间或动作里带着一点处理完正事后的微倦，但仍保持自身节奏处理眼前的互动。' },
    { id: 'ep_habit_memory', label: '后天养成的小习惯自然流露', desc: '不经意间看了一眼时间、备忘录或提前准备好的物品，体现出过往经历留下的真实行为印记。' },
];

export function fnvHash(seed) {
    let h = 2166136261;
    for (const ch of String(seed || '')) {
        h ^= ch.codePointAt(0);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
}

export function pickFromPool(pool, seed, offset = 0) {
    if (!pool?.length) return null;
    const r = fnvHash(`${seed}:pool:${offset}`);
    return pool[Math.floor(r * pool.length) % pool.length];
}

export function legacyEnabled(c) {
    const vars=c?.extensionSettings||{},disabled=vars.disabledExtensions||[];if(vars.human_temper_v1?.enabled===false)return false;
    const names=['human-temper','lin-emotional-control'];if(names.some(k=>disabled.includes(k)||disabled.includes('third-party/'+k)))return false;
    if(names.some(k=>c?.getExtensionManifest?.(k)))return true;
    return !!vars.human_temper_v1; // ambiguous install: yield the draw rather than drawing twice

}

export function arbitrateLegacyPlugin(c, settings = {}) {
    const isRunning = legacyEnabled(c)||settings.conflictMode==='partner';
    const legacySettings = c?.extensionSettings?.human_temper_v1 || null;
    const mode = (settings.conflictMode==='partner'?'coexist':settings.conflictMode) || 'coexist';
    if (mode==='growth') return {legacyActive:isRunning,mode:'growth',allowPersona:true,allowImmediate:true,allowEmotionEngine:false,summary:'仅成长：本插件不抽签，按真实经历采用的心理与目标照常使用。'};
    if (!isRunning) {
        return {
            legacyActive: false,
            mode: 'standalone',
            allowPersona: true,
            allowImmediate: true,
            allowEmotionEngine: !!settings.expressive,
            summary: '独立完整运行（内置完整情绪抽样、阴暗动机、userAccess 与跨回合情绪引擎）',
        };
    }
    if (mode === 'pause') {
        return {
            legacyActive: true,
            mode: 'pause',
            allowPersona: false,
            allowImmediate: false,
            allowEmotionEngine: false,
            summary: '检测到旧版 lin-emotional-control 运行中：按策略暂停本插件注入',
        };
    }
    if (mode === 'takeover') {
        return {
            legacyActive: true,
            mode: 'takeover_blocked',
            allowPersona: false,
            allowImmediate: false,
            allowEmotionEngine: false,
            summary: '完全接管模式需先在扩展设置中停用旧版 lin-emotional-control，避免双引擎重复抽签',
        };
    }
    return {
        legacyActive: true,
        mode: 'coexist',
        allowPersona: true,
        allowImmediate: true,
        allowEmotionEngine: false,
        legacySettings,
        summary: '配置级避让：随机演出由旧插件负责；不读取旧插件本轮落点。',
    };
}

function classifyClauseStance(clause) {
    const c = String(clause || '').trim();
    if (!c) return null;

    // 1. Explicit current breakup / estrangement / severance -> distant
    if (/(?:已经分手|分了手|分手了?|已经决裂|决裂了?|形同陌路|不再往来|恩断义绝|早已分开|毫无交集|完全不认识|素不相识|不认识|陌生人)/.test(c)) {
        return 'distant';
    }
    // 2. Explicit current reconciliation (resolving prior enmity) -> neutral (or warm if accompanied by explicit affection)
    if (/(?:彻底和解|已经和解|早已和解|已和解|冰释前嫌|放下恩怨|化干戈为玉帛|早已和好|已经和好)/.test(c) && !/未和解/.test(c)) {
        if (/(?:温柔|体贴|宠溺|深爱|伴侣|恋人|夫妻|挚友|知己)/.test(c)) return 'warm';
        return 'neutral';
    }
    // 3. Explicit turning hostile / active enmity
    if (/(?:反目成仇|未和解|死敌|仇视|仇人|鄙视|厌恶|憎恨|轻蔑|杀意|敌对|死对头|宿敌|审讯|阶下囚)/.test(c)) {
        return 'hostile';
    }
    // 4. Explicit warmth / affection
    if (/(?:温柔体贴|温柔|体贴|宠溺|偏爱|纵容|深爱|恋人|伴侣|夫妻|青梅竹马|知己|关照|呵护)/.test(c)) {
        return 'warm';
    }
    // 5. General coldness / distance
    if (/(?:冷漠|严厉|冷酷|无情|生人勿近|高冷|孤僻|排斥|疏离|公事公办|保持距离)/.test(c)) {
        return 'distant';
    }
    return null;
}

// Target-Aware & Temporal-Transition-Aware Baseline Stance Parser (v0.3.0 Requirement 5):
// Resolves stance specifically toward `targetPerson` (or user/protagonist) and prioritizes current state over past history:
// - "他和林檩原本是恋人，现在已经分手" -> 'distant' (NOT 'warm')
// - "她是他的仇人，却已经彻底和解" -> 'neutral' (NOT 'hostile')
// - "他性格冷漠，但对林檩温柔体贴" -> 'warm' toward 林檩 (NOT 'distant')
// - "对敌人敌对，对亲友温柔" -> 'neutral' (conditional role rules do not make user an enemy)
export function analyzeBaselineStance(actor, state, targetPerson = '') {
    const actorId = actor?.id || '';
    const actorName = actor?.name || '';
    const override = state?.baselines?.[actorId];
    const resolvedTarget = targetPerson ||
        (state?.world?.people || []).find(p => p && p !== actorName && p !== actorId) ||
        '';

    const rawBaseline = [
        actor?.baseline || '',
        actor?.personality || '',
        actor?.description || '',
        override?.summary || '',
        ...(override?.coreTraits || []),
        ...(override?.initialRelationships || []),
    ].join('\n');

    if (!rawBaseline.trim()) return 'neutral';

    const sentences = rawBaseline.split(/[。！？!?\n；;]+/).map(s => s.trim()).filter(Boolean);
    const targetStances = [];
    const generalStances = [];

    const escapedTarget = resolvedTarget ? resolvedTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
    const targetRefRe = escapedTarget
        ? new RegExp(`(?:${escapedTarget}|主角|用户|user|对方|双方)`, 'i')
        : /(?:主角|用户|user|对方|双方)/i;
    const explicitTargetDirectiveRe = escapedTarget
        ? new RegExp(`(?:对|待|唯独对?|只对|面对|在)${escapedTarget}|(?:对|待|视)(?:主角|用户|user)`, 'i')
        : /(?:对|待|视)(?:主角|用户|user)/i;
    const otherCategoryTargetRe = /(?:对|待|对待|面对)(?:敌人|对手|仇敌|外人|别人|旁人|陌生人|其他人|无关的人|甲方|客户|下属|同事|亲友|朋友|家人)/;

    for (const sent of sentences) {
        const subClauses = sent.split(/[，,]+/).map(c => c.trim()).filter(Boolean);

        // Check for temporal transition or adversative transition across sub-clauses in this sentence:
        // e.g. "原本是恋人，现在已经分手", "她是他的仇人，却已经彻底和解", "他性格冷漠，但对林檩温柔体贴"
        let effectiveSubClauses = subClauses;
        const transitionIdx = subClauses.findIndex((c, idx) =>
            idx > 0 && (
                /(?:现在|如今|目前|已经|早已|后来|却已|但已|却|但|不过|然而|唯独|只是现在)/.test(c) ||
                /(?:原本|曾经|以前|过去|起初|曾是|原是)/.test(subClauses[idx - 1])
            )
        );
        if (transitionIdx > 0) {
            effectiveSubClauses = subClauses.slice(transitionIdx);
        }

        for (const sub of effectiveSubClauses) {
            // Skip pure conditional role rules aimed at generic categories ("对敌人敌对", "对亲友温柔", "对外人冷漠")
            // unless this same sub-clause explicitly names the target/user!
            if (otherCategoryTargetRe.test(sub) && !explicitTargetDirectiveRe.test(sub)) {
                continue;
            }
            // Skip clauses explicitly marked as past-only if not already sliced
            if (/(?:原本是|曾经是|以前是|过去是|曾是)/.test(sub) && !/(?:现在|依然|仍然|还是)/.test(sub)) {
                continue;
            }

            const stance = classifyClauseStance(sub);
            if (!stance) continue;

            if (explicitTargetDirectiveRe.test(sub) || (targetRefRe.test(sent) && transitionIdx > 0)) {
                targetStances.push(stance);
            } else if (targetRefRe.test(sub)) {
                targetStances.push(stance);
            } else {
                generalStances.push(stance);
            }
        }
    }

    // Target-specific stances ("但对林檩温柔体贴", "和林檩现在已经分手", "与主角敌对") take strict priority over general personality traits
    if (targetStances.length > 0) {
        return targetStances.at(-1);
    }

    if (generalStances.includes('hostile')) return 'hostile';
    if (generalStances.includes('warm') && !generalStances.includes('distant')) return 'warm';
    if (generalStances.includes('distant')) return 'distant';
    return 'neutral';
}

export function computeUserAccess({ actor, actorId, state, settings, seed, targetPerson = '' }) {
    const resolvedActorId = actorId || actor?.id || '';
    const influences = (state?.influences || []).filter(x => x.actorId === resolvedActorId && x.enabled && x.status === 'active');
    const guardedScore = influences
        .filter(x => /(?:防备|谨慎|戒备|疏远|失约|迟到|失望|烦躁|保持距离|越界|隐瞒)/.test(x.concept + x.description + x.behavior))
        .reduce((acc, x) => acc + (x.intensity || 0.5), 0);
    const warmScore = influences
        .filter(x => /(?:信任|理解|体谅|亲近|关心|和解|默契|照顾|心软|回护)/.test(x.concept + x.description + x.selfView))
        .reduce((acc, x) => acc + (x.intensity || 0.5), 0);

    const baseStance = analyzeBaselineStance(actor || { id: resolvedActorId }, state, targetPerson);
    const roll = fnvHash(`${seed}:userAccess`);

    if (guardedScore > warmScore + 0.35) {
        if (warmScore > 0.2 || (baseStance !== 'hostile' && roll < 0.55)) {
            return {
                level: 'guarded_window',
                label: '设防中留有解释与行动窗口（userAccess: 条件性开放）',
                opportunity: '角色因过往经历保持谨慎或已提前安排自身事务，不会轻易被口头承诺打动；但只要用户给出真诚具体的解释或实际行动，角色愿意倾听并给出台阶。',
            };
        }
        return {
            level: 'busy_boundary',
            label: '专注自身节奏与边界（userAccess: 审慎受限）',
            opportunity: '角色当前优先推进自己的工作或计划以规避被动等待，对敷衍试探较为冷淡；需用户主动配合角色节奏或解决核心症结才能拉近距离。',
        };
    }

    if (warmScore > guardedScore && warmScore >= 0.4) {
        return {
            level: 'open_reciprocation',
            label: '双向磨合后的默契开放（userAccess: 积极可及）',
            opportunity: '角色对用户抱有基于经历的信任或体谅，留出自然的互动与亲近机会，会在细节上主动接应用户的意图。',
        };
    }

    if (baseStance === 'hostile') {
        return {
            level: 'hostile_closed',
            label: '敌对或排斥封锁（userAccess: 封闭对立）',
            opportunity: '角色与用户处于敌对、鄙视或严重对立状态，拒绝任何无理由的亲近或讨好；唯有符合角色核心利益、实力制衡或强逻辑转折的行动才可能引起其正视。',
        };
    }
    if (baseStance === 'distant') {
        return {
            level: 'stranger_distant',
            label: '陌生或疏离边界（userAccess: 审慎距离）',
            opportunity: '角色与用户尚无深厚交集、关系已疏远或性格冷漠严厉，保持清晰的社交与心理距离，不会无故偏爱、迁就或主动亲近。',
        };
    }
    if (baseStance === 'warm') {
        return {
            level: 'natural_window',
            label: '日常自然互动窗口（userAccess: 常态开放）',
            opportunity: '角色与用户具有良好关系基础，可通过具体对话、共同事务或情绪共鸣自然互动。',
        };
    }
    return {
        level: 'baseline_neutral',
        label: '遵循原设关系基线（userAccess: 按原卡关系自然互动）',
        opportunity: '严格遵循原始角色卡设定的人物关系与性格底色回应，不无故制造亲昵或敌意。',
    };
}

export function sampleEmotionDirective({ actor, state, settings = {}, seed = 'default', swipeOffset = 0, forceReroll = false, targetPerson = '' }) {
    const actorId = actor?.id || '';
    const rerollNonce = Number(settings.rerollNonce) || 0;
    const effectiveSeed = `${seed}:swipe:${swipeOffset}:${rerollNonce}`;
    const influences = (state?.influences || []).filter(x => x.actorId === actorId && x.enabled && x.status === 'active');

    const hasConflict = influences.some(x => x.selfView && x.behavior && x.selfView !== x.behavior);
    const hasGuarded = influences.some(x => /(?:谨慎|防备|失约|戒备|等待|烦躁|疏远|越界|隐瞒)/.test(x.concept + x.description));
    const hasWarm = influences.some(x => /(?:理解|信任|和解|关心|体谅|默契|回护)/.test(x.concept + x.description) && (x.intensity || 0.5) >= 0.4);

    const intensity = clamp(settings.intensity, 0, 100, 65);
    const darkWeight = clamp(settings.dark, 0, 100, 35);
    const unpredictWeight = clamp(settings.unpredict, 0, 100, 40);
    const eventRate = clamp(settings.eventRate, 0, 100, 20);

    const baseStance = analyzeBaselineStance(actor, state, targetPerson);

    let primaryCategory = baseStance; // 'hostile' | 'distant' | 'neutral' | 'warm'
    if (hasConflict || (hasGuarded && hasWarm)) {
        primaryCategory = 'conflicted';
    } else if (hasGuarded) {
        primaryCategory = baseStance === 'hostile' ? 'hostile' : 'guarded';
    } else if (hasWarm && baseStance !== 'hostile') {
        primaryCategory = 'warm';
    } else if (intensity >= 80 && baseStance !== 'neutral') {
        primaryCategory = baseStance === 'hostile' ? 'hostile' : 'intense';
    }

    const prevCarry = state?.emotionState?.[actorId];
    let emotionCard = null;
    let carryPhase = '初起/当回合';
    if (intensity > 0) {
        const shouldInheritCarry = settings.memory !== false && swipeOffset === 0 && !forceReroll && !settings.forceReroll && prevCarry?.card && prevCarry.carryRemaining > 0;
        if (shouldInheritCarry) {
            emotionCard = prevCarry.card;
            carryPhase = prevCarry.carryRemaining === 1 ? '跨回合延续（余韵消退期）' : '跨回合延续（持续发酵期）';
        } else {
            emotionCard = pickFromPool(EMOTION_POOLS[primaryCategory] || EMOTION_POOLS.neutral, effectiveSeed, 1);
        }
    }

    const darkRoll = fnvHash(`${effectiveSeed}:dark`) * 100;
    const darkMotive = darkWeight > 0 && darkRoll < darkWeight
        ? pickFromPool(DARK_MOTIVE_POOLS, effectiveSeed, 2)
        : null;

    const unpredictRoll = fnvHash(`${effectiveSeed}:unpredict`) * 100;
    const unpredictAction = unpredictWeight > 0 && unpredictRoll < unpredictWeight
        ? pickFromPool(UNPREDICT_POOLS, effectiveSeed, 3)
        : null;

    const episodeRoll = fnvHash(`${effectiveSeed}:episode`) * 100;
    const lifeEpisode = settings.independent !== false && eventRate > 0 && episodeRoll < eventRate
        ? pickFromPool(LIFE_EPISODE_POOLS, effectiveSeed, 4)
        : null;

    const userAccess = clamp(settings.userAccess,0,100,45)>0 && fnvHash(effectiveSeed+":accessRoll")*100 < clamp(settings.userAccess,0,100,45) ? computeUserAccess({ actor, actorId, state, settings, seed: effectiveSeed, targetPerson }) : null;

    return {
        category: primaryCategory,
        baseStance,
        carryPhase,
        emotionCard,
        darkMotive,
        unpredictAction,
        lifeEpisode,
        userAccess,
        weights: { intensity, dark: darkWeight, unpredict: unpredictWeight, eventRate },
        seed: effectiveSeed,
    };
}

export function formatEmotionDirective(sampled, settings = {}) {
    if (!sampled || !settings.expressive) return '';
    const parts = [];
    if (sampled.emotionCard) {
        parts.push(`演出抽样（${sampled.carryPhase} · 烈度${sampled.weights.intensity}/100）：【${sampled.emotionCard.label}】${sampled.emotionCard.direction}`);
    }
    if(sampled.userAccess)parts.push('互动机会：'+sampled.userAccess.label+'。可以错过，不要求对方介入。');
    if (sampled.darkMotive) {
        parts.push(`深层复杂动机（权重${sampled.weights.dark}/100）：【${sampled.darkMotive.label}】${sampled.darkMotive.desc}`);
    }
    if (sampled.unpredictAction) {
        parts.push(`行为变化与张力（随机性${sampled.weights.unpredict}/100）：【${sampled.unpredictAction.label}】${sampled.unpredictAction.desc}`);
    }
    if (sampled.lifeEpisode) {
        parts.push(`生活插曲（若场景自然契合可采用）：【${sampled.lifeEpisode.label}】${sampled.lifeEpisode.desc}`);
    }
    return parts.join('\n');
}
