import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { IDBFactory } from './shims/indexeddb.js';
import { Window } from './shims/dom.js';
import { onEnable, onDisable } from '../index.js';
import { Controller, DEFAULTS } from '../src/controller.js';
import { Database } from '../src/storage.js';
import { KEY, clone } from '../src/util.js';
import {
    emptyState,
    userEdit,
    removeInfluence,
    editExperience,
    setBaselineOverride,
    setVariable,
    discoverVariables,
    detectWorldContext,
    extractLatestSceneFromText,
} from '../src/model.js';
import { buildLocalAnalysisResult, applyAnalysis } from '../src/analysis.js';
import { compose } from '../src/prompt.js';
import { sampleEmotionDirective, analyzeBaselineStance } from '../src/emotion-engine.js';
import { rank, RETRIEVAL_CAPABILITY_MODES } from '../src/retrieval.js';

const events = Object.fromEntries([
    'GENERATION_STARTED',
    'GENERATION_STOPPED',
    'GENERATION_ENDED',
    'CHARACTER_MESSAGE_RENDERED',
    'CHAT_CHANGED',
    'CHAT_LOADED',
    'MESSAGE_SWIPED',
    'MESSAGE_EDITED',
    'MESSAGE_UPDATED',
    'MESSAGE_DELETED',
    'MESSAGE_SENT',
    'APP_READY',
].map(e => [e, e]));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const noopAbort = () => {};

function createHostContext(chatId = 'worldline-A') {
    const prompts = [];
    const ctx = {
        extensionSettings: {},
        chatMetadata: {},
        chatId,
        name1: '林檩',
        characterId: 0,
        characters: [{
            name: '方亦楷',
            avatar: 'fang.png',
            description: '方亦楷是严谨克制的建筑设计师，重诺守时，外冷内热。\n底线原则：绝不无故迁怒他人，绝不违背职业操守。\n说话语气：言辞简练沉稳，极少直接抱怨。',
            personality: '克制、冷静、守时、外冷内热、重诺',
            scenario: '与林檩相识多年，近期有多次工作与私下约会交集。【信任度: 75】',
        }, {
            name: '辛言',
            avatar: 'xin.png',
            personality: '敏锐、直率',
        }],
        chat: [],
        eventTypes: events,
        eventSource: new EventEmitter(),
        getCurrentChatId() { return this.chatId; },
        saveSettingsDebounced() {},
        saveMetadataDebounced() {},
        getTokenCountAsync: async s => Math.ceil(s.length / 2),
        setExtensionPrompt: (...args) => prompts.push(args),
    };
    return { ctx, prompts };
}

async function simulateTurn(ctrl, ctx, { userMes, charReply, kind = 'normal', speaker = '方亦楷', avatar = 'fang.png' }) {
    if (userMes) {
        ctx.chat.push({ name: '林檩', is_user: true, mes: userMes });
    }
    ctx.eventSource.emit(events.GENERATION_STARTED, kind, {}, false);
    if (kind === 'regenerate') ctx.chat.pop();
    await ctrl.intercept(ctx.chat, 16384, noopAbort, kind);
    const injectedPrompt = ctrl.lastPrompt;
    if (kind === 'swipe' || kind === 'continue') {
        ctx.chat.at(-1).mes = charReply;
    } else {
        ctx.chat.push({ name: speaker, original_avatar: avatar, mes: charReply });
    }
    ctx.eventSource.emit(events.GENERATION_ENDED);
    ctx.eventSource.emit(events.CHARACTER_MESSAGE_RENDERED, ctx.chat.length - 1, kind);
    await sleep(640);
    await ctrl.chain;
    return injectedPrompt;
}

test('Adversarial Guard 1: Ordinary questions, reminders, future hypotheticals and third-party remarks NEVER fabricate experiences or permanent traits', () => {
    const actor = { id: 'fang.png', name: '方亦楷' };
    const state = emptyState();
    const falsePositiveInputs = [
        '你明天可千万别迟到。',
        '我们要不要把下周的会议改期？',
        '他今天又迟到了，跟你没关系。',
        '你要记得照顾你自己。',
        '如果下次有人失约你会怎么办？',
        '别忘了带设计图纸。',
    ];
    for (const [idx, text] of falsePositiveInputs.entries()) {
        const msg = { node: `fp_${idx}`, index: idx, actorOwn: false, speaker: '林檩', text };
        const res = buildLocalAnalysisResult({ actor, fresh: [msg], known: [msg], state });
        assert.equal(res.experiences.length, 0, `Must NOT fabricate experience for: "${text}"`);
        assert.equal(res.changes.length, 0, `Must NOT propose persona change for: "${text}"`);
    }

    const singleFact = { node: 'single_1', index: 0, actorOwn: false, speaker: '林檩', text: '抱歉，我今天因为堵车迟到了半个小时。' };
    const singleRes = buildLocalAnalysisResult({ actor, fresh: [singleFact], known: [singleFact], state });
    assert.equal(singleRes.experiences.length, 1);
    assert.equal(singleRes.changes.some(c => c.influence?.layer === 'acquired'), false, 'Single isolated event must not directly create permanent L1 acquired persona');
});

test('Adversarial Guard 2: Zero emotion sliders (dark=0, unpredict=0, eventRate=0, intensity=0) strictly produce 0% trigger probability', () => {
    const actor = { id: 'fang.png', name: '方亦楷' };
    const state = emptyState();
    for (let i = 0; i < 500; i++) {
        const sampled = sampleEmotionDirective({
            actor,
            state,
            settings: { ...DEFAULTS, intensity: 0, dark: 0, unpredict: 0, eventRate: 0 },
            seed: `seed_${i}`,
        });
        assert.equal(sampled.emotionCard, null);
        assert.equal(sampled.darkMotive, null);
        assert.equal(sampled.unpredictAction, null);
        assert.equal(sampled.lifeEpisode, null);
    }
});

test('Adversarial Guard 3: Scene and present people update dynamically when leaving hospital for home/studio without locking old locations', async () => {
    const db = new Database('adv3', new IDBFactory());
    const { ctx } = createHostContext('scene-switch');
    const ctrl = new Controller(() => ctx, { db });
    ctrl.bind();
    await ctrl.enqueue(() => ctrl.sync());

    await ctrl.mutate(st => {
        let next = userEdit(st, {
            id: 'hosp_only',
            layer: 'acquired',
            concept: '医院环境下的紧张感',
            description: '在医院诊室闻到消毒水味会不自觉绷紧神经',
            scope: { scenes: ['医院'] },
        }, 'fang.png');
        next = userEdit(next, {
            id: 'home_only',
            layer: 'acquired',
            concept: '居家环境下的放松习惯',
            description: '回到家里客厅会卸下防备泡一杯热茶',
            scope: { scenes: ['家中'] },
        }, 'fang.png');
        return next;
    }, '添加场景限定倾向');

    await simulateTurn(ctrl, ctx, {
        userMes: '我们在医院急诊室等检查结果，辛言也在旁边。',
        charReply: '嗯，先在诊室外的长椅坐一下吧。',
    });
    const worldAtHospital = detectWorldContext({ chat: ctx.chat, cast: ctx.characters.map(c => ({ id: c.avatar, name: c.name })), state: ctrl.timeline.node.state, userName: '林檩' });
    assert.equal(worldAtHospital.scene, '医院/诊室');

    ctx.chat.push({ name: '旁白', is_user: true, mes: '辛言离开了。方亦楷和林檩离开医院，回到了家里的客厅休息。' });
    ctx.eventSource.emit(events.GENERATION_STARTED, 'normal', {}, false);
    await ctrl.intercept(ctx.chat, 16384, noopAbort, 'normal');

    const worldAtHome = detectWorldContext({ chat: ctx.chat, cast: ctx.characters.map(c => ({ id: c.avatar, name: c.name })), state: ctrl.timeline.node.state, userName: '林檩' });
    assert.equal(worldAtHome.scene, '家中/居所');
    assert.equal(worldAtHome.scenes.includes('医院'), false);
    assert.equal(worldAtHome.people.includes('辛言'), false);
    assert.ok(ctrl.lastPrompt.includes('居家环境下的放松习惯'));
    assert.equal(ctrl.lastPrompt.includes('医院环境下的紧张感'), false);
    ctrl.dispose();
});

test('Adversarial Guard 4: 10 long-term L1 traits NEVER crowd out active L3 immediate emotion or emotion sampling across 500, 700, 1000, and 2000 token budgets', async () => {
    const state = emptyState();
    for (let i = 0; i < 10; i++) {
        state.influences.push({
            id: `acq_${i}`,
            actorId: 'fang.png',
            layer: 'acquired',
            concept: `长期性格倾向编号_${i}`,
            description: `这是一段较长的后天长期性格倾向描述（编号 ${i}），包含对工作流程、细节把控、人际边界与沟通习惯的详细说明。`,
            selfView: `我认为保持这种习惯（${i}）能提高效率`,
            behavior: `在实际行动中始终坚持按步骤核验细节（${i}）`,
            actionDecision: `遇到相关情境时优先执行核验方案（${i}）`,
            rationale: `由过往多次项目合作经历沉淀形成（${i}）`,
            intensity: 0.7,
            confidence: 0.8,
            priority: 'medium',
            scope: { people: [], scenes: [], relationships: [], behaviors: [] },
            personRules: {},
            duration: { mode: 'permanent', remaining: null, until: null, endCondition: '' },
            enabled: true,
            frozen: false,
            allowConsolidation: true,
            expression: 'natural',
            status: 'active',
            evidence: [],
            evolutionLog: [],
            managedBy: 'auto',
        });
    }
    state.influences.push({
        id: 'imm_active',
        actorId: 'fang.png',
        layer: 'immediate',
        concept: '关键即时情绪：被打断后的微愠',
        description: '因刚泡好的热茶被打翻而产生持续两次回复的即时懊恼',
        selfView: '小事而已',
        behavior: '眉头微蹙地擦拭桌面',
        actionDecision: '一边清理桌面一边简短回应',
        rationale: '刚才发生的突发插曲',
        intensity: 0.75,
        confidence: 0.9,
        priority: 'high',
        scope: { people: [], scenes: [], relationships: [], behaviors: [] },
        personRules: {},
        duration: { mode: 'turns', remaining: 2, until: null, endCondition: '' },
        enabled: true,
        frozen: false,
        allowConsolidation: false,
        expression: 'natural',
        status: 'active',
        evidence: [],
        evolutionLog: [],
        managedBy: 'user',
    });

    for (const budget of [500, 700, 1000, 2000]) {
        const prompt = await compose({
            actor: { id: 'fang.png', name: '方亦楷', baseline: '克制守时' },
            state,
            settings: { ...DEFAULTS, expressive: true, promptBudget: budget },
            seed: 'budget-test',
        });
        assert.ok(prompt.includes('关键即时情绪：被打断后的微愠') || prompt.includes('因刚泡好的热茶被打翻'), `Immediate emotion must be preserved at ${budget} tokens`);
        assert.ok(prompt.includes('演出抽样'), `Emotion sampling must be preserved at ${budget} tokens`);
    }
});

test('Adversarial Guard 5: Failed and unparseable AI analysis requests are counted toward API consumption, and cumulative budget cap blocks excess calls', async () => {
    const db = new Database('adv5', new IDBFactory());
    const { ctx } = createHostContext('api-budget');
    ctx.chat.push({ name: '林檩', is_user: true, mes: '今天我因为急诊失约了，真的很抱歉。' });
    const ctrl = new Controller(() => ctx, { db });
    ctrl.bind();
    ctrl.changeSettings({ analysisMaxTotalRequests: 2 });
    await ctrl.enqueue(() => ctrl.sync());

    ctx.generateRaw = async () => 'NOT_VALID_JSON_OUTPUT';
    await assert.rejects(() => ctrl.analyze('fang.png'));
    assert.equal(ctrl.settings().analysisRequestsUsed, 1);
    assert.equal(ctrl.analyzer.stats.parseFailed, 1);

    ctx.generateRaw = async () => { throw new Error('Vertex 503 overloaded'); };
    await assert.rejects(() => ctrl.analyze('fang.png'));
    assert.equal(ctrl.settings().analysisRequestsUsed, 2);

    let calledThirdTime = false;
    ctx.generateRaw = async () => { calledThirdTime = true; return '{"experiences":[],"changes":[]}'; };
    await assert.rejects(() => ctrl.analyze('fang.png'), /已达到累计 AI 分析请求上限/);
    assert.equal(calledThirdTime, false);
    ctrl.dispose();
});

test('Adversarial Guard 6 (P0-1): Hostile, cold, or stranger characters with zero acquired history NEVER enter warm pool or get affectionate prompts', async () => {
    const villainActor = {
        id: 'villain.png',
        name: '沈执',
        baseline: '反派完全不认识主角，当前双方敌对，未和解。性格严厉、冷漠、鄙视用户。',
    };
    const state = emptyState();
    for (let i = 0; i < 100; i++) {
        const sampled = sampleEmotionDirective({
            actor: villainActor,
            state,
            settings: DEFAULTS,
            seed: `villain_seed_${i}`,
        });
        assert.equal(sampled.category, 'hostile', 'Hostile villain must enter hostile pool, never warm');
        assert.equal(sampled.userAccess.level, 'hostile_closed', 'Hostile villain must have hostile_closed userAccess');
    }

    const prompt = await compose({
        actor: villainActor,
        state,
        settings: DEFAULTS,
        seed: 'villain_prompt_seed',
    });
    assert.equal(prompt.includes('偏爱'), false, 'Prompt must NEVER inject 偏爱 for hostile/stranger character');
    assert.equal(prompt.includes('纵容'), false, 'Prompt must NEVER inject 纵容 for hostile/stranger character');
    assert.equal(prompt.includes('常态开放'), false, 'Prompt must NEVER inject 常态开放 for hostile character');
    assert.ok(prompt.includes('封闭对立'), 'Prompt must reflect hostile closed userAccess');

    const strangerActor = {
        id: 'stranger.png',
        name: '陆凛',
        baseline: '完全不认识用户，初次见面，性格冷漠严厉、公事公办。',
    };
    const strangerSample = sampleEmotionDirective({ actor: strangerActor, state, settings: DEFAULTS, seed: 'stranger_1' });
    assert.equal(strangerSample.category, 'distant');
    assert.equal(strangerSample.userAccess.level, 'stranger_distant');
});

test('Adversarial Guard 7 (P0-2): Negated clauses, counterfactual near-misses, actor-own breaches, and third-party recipients NEVER misattribute experiences', () => {
    const actor = { id: 'fang.png', name: '方亦楷' };
    const state = emptyState();
    const cases = [
        '林檩没有失约，她已经准时到了。',
        '我没有撒谎，已经解释过了。',
        '方亦楷差点迟到，但最终提前到了。',
        '林檩把杯子递给服务生。',
        '昨晚方亦楷失约了。',
        '我没失约，只是他昨晚迟到了。',
    ];
    for (const [idx, text] of cases.entries()) {
        const msg = { node: `neg_${idx}`, index: idx, actorOwn: false, speaker: '林檩', text };
        const res = buildLocalAnalysisResult({ actor, fresh: [msg], known: [msg], state });
        assert.equal(res.experiences.length, 0, `Must NOT misattribute experience for: "${text}" (got: ${JSON.stringify(res.experiences)})`);
        assert.equal(res.changes.length, 0, `Must NOT create persona change for: "${text}" (got: ${JSON.stringify(res.changes)})`);
    }
});

test('Adversarial Guard 8 (P0-3): Single tardiness + unrelated work completion reply NEVER fabricates a permanent L1 acquired persona', () => {
    const actor = { id: 'fang.png', name: '方亦楷' };
    const state = emptyState();
    const m1 = { node: 'c1', index: 0, actorOwn: false, speaker: '林檩', text: '林檩今天迟到了。' };
    const m2 = { node: 'c2', index: 1, actorOwn: true, speaker: '方亦楷', text: '我已经完成了项目计划。' };
    const res = buildLocalAnalysisResult({ actor, fresh: [m1, m2], known: [m1, m2], state });
    const hasPermanentAcquired = res.changes.some(c => c.influence?.layer === 'acquired');
    assert.equal(hasPermanentAcquired, false, 'Unrelated work completion must NOT be treated as causal evidence for a permanent L1 trait');
});

test('Adversarial Guard 9 (P0-4): Clicking rerollEmotion or setting rerollNonce=1,2,5 NEVER breaks subsequent cross-turn emotion inheritance', () => {
    const actor = { id: 'fang.png', name: '方亦楷', baseline: '克制守时' };
    const state = emptyState();
    const targetCard = { id: 'custom_carry_card', label: '持续发酵的克制审视', direction: '延续上一轮的审视态度。' };
    state.emotionState['fang.png'] = { card: targetCard, carryRemaining: 2 };

    for (const nonce of [0, 1, 2, 5]) {
        const sampled = sampleEmotionDirective({
            actor,
            state,
            settings: { ...DEFAULTS, rerollNonce: nonce },
            seed: 'carry_test_seed',
            swipeOffset: 0,
        });
        assert.equal(sampled.emotionCard.id, 'custom_carry_card', `Cross-turn emotion must still inherit when rerollNonce=${nonce}`);
        assert.ok(sampled.carryPhase.includes('跨回合延续'));
    }
});

test('Adversarial Guard 10 (P1-1 & P1-2): Scene semantics distinguish physical room from phone calls and discussed past places; retrieval labels modes clearly', () => {
    assert.equal(extractLatestSceneFromText('在家里拿起手机打电话'), '家中/居所');
    assert.equal(extractLatestSceneFromText('坐在餐厅谈论昨天的医院经历'), '餐厅/咖啡馆');
    assert.equal(extractLatestSceneFromText('在工作室询问宿舍生活'), '办公室/职场');

    const rankedFallback = rank([{ id: 'e1', summary: '医院急诊失约', appraisal: '理解', sources: [{ quote: '急诊' }] }], '暴雨晚点到', new Map(), null, 1);
    assert.equal(rankedFallback[0].retrievalMode, 'rule_concept_fallback');
    assert.ok(RETRIEVAL_CAPABILITY_MODES.rule_concept_fallback.includes('非开放式语义模型'));

    const rankedExternal = rank([{ id: 'e1', summary: '医院急诊失约', appraisal: '理解', sources: [{ quote: '急诊' }] }], '暴雨晚点到', new Map([['e1', [0.9, 0.1]]]), [0.9, 0.1], 1);
    assert.equal(rankedExternal[0].retrievalMode, 'external_embedding');
});

test('Adversarial Guard 11 (v0.3.0 Req 1, 2 & 4): Reported speech, kinship/possessive third parties, epistemic/perception complements, dreams/pretenses, and solo activities NEVER misattribute', () => {
    const actor = { id: 'fang.png', name: '方亦楷' };
    const state = emptyState();
    const complexCases = [
        '林檩说她妹妹昨天迟到了。',
        '林檩的同事今天迟到了。',
        '我知道你昨天失约了。',
        '林檩梦见自己昨天失约了。',
        '我看见方亦楷刚才迟到了。',
        '我听说她朋友昨晚爽约了。',
        '林檩假装自己今天迟到了。',
        '我误以为林檩昨晚失约了。',
        '林檩今天特意提前去图书馆上课了。',
        '我今天早上赶去公司上班迟到了。',
        '她的室友把热粥递给了护士。',
    ];
    for (const [idx, text] of complexCases.entries()) {
        const msg = { node: `v3_complex_${idx}`, index: idx, actorOwn: false, speaker: '林檩', text };
        const res = buildLocalAnalysisResult({ actor, fresh: [msg], known: [msg], state });
        assert.equal(res.experiences.length, 0, `Must NOT fabricate experience for: "${text}" (got: ${JSON.stringify(res.experiences)})`);
        assert.equal(res.changes.length, 0, `Must NOT create persona change for: "${text}" (got: ${JSON.stringify(res.changes)})`);
    }
});

test('Adversarial Guard 12 (v0.3.0 Req 3): Repeating identical or near-duplicate event descriptions across floors NEVER duplicates evidence or forms permanent L1 traits', async () => {
    const actor = { id: 'fang.png', name: '方亦楷' };
    const path = [
        { hash: 'root', parent: null, index: -1 },
        { hash: 'n1', parent: 'root', index: 0 },
        { hash: 'n2', parent: 'n1', index: 1 },
    ];
    const m1 = { node: 'n1', index: 0, actorOwn: false, effective: false, speaker: '林檩', text: '林檩今天迟到了。' };
    const m2 = { node: 'n2', index: 1, actorOwn: false, effective: false, speaker: '林檩', text: '林檩今天迟到了。' };

    // Case A: Both floors in the same batch
    const batchRes = buildLocalAnalysisResult({ actor, fresh: [m1, m2], known: [m1, m2], state: emptyState() });
    assert.equal(batchRes.experiences.length, 1, 'Duplicate descriptions of the same event must be deduplicated to 1 experience');
    assert.equal(batchRes.changes.some(c => c.influence?.layer === 'acquired'), false, 'Repeated same event must NEVER form a permanent L1 acquired persona');

    // Case B: Sequential turn-by-turn processing across floors
    let state = emptyState();
    const res1 = buildLocalAnalysisResult({ actor, fresh: [m1], known: [m1], state });
    state = await applyAnalysis(state, res1, { actorId: 'fang.png', known: [m1], fresh: [m1], path: path.slice(0, 2), actor });
    assert.equal(state.experiences.length, 1);
    assert.equal(state.influences.some(x => x.layer === 'acquired'), false);

    const res2 = buildLocalAnalysisResult({ actor, fresh: [m2], known: [m1, m2], state });
    assert.equal(res2.experiences.length, 0, 'Second floor repeating the same event must produce 0 new experiences');
    assert.equal(res2.changes.length, 0, 'Second floor repeating the same event must produce 0 new changes');

    // Case C: Repeating a dream twice also produces 0 experiences and 0 changes
    const d1 = { node: 'd1', index: 0, actorOwn: false, speaker: '林檩', text: '林檩梦见自己昨天失约了。' };
    const d2 = { node: 'd2', index: 1, actorOwn: false, speaker: '林檩', text: '林檩梦见自己昨天失约了。' };
    const dreamRes = buildLocalAnalysisResult({ actor, fresh: [d1, d2], known: [d1, d2], state: emptyState() });
    assert.equal(dreamRes.experiences.length, 0);
    assert.equal(dreamRes.changes.length, 0);
});

test('Adversarial Guard 13 (v0.3.0 Req 5): Per-person and temporal-transition initial relationship baselines resolve current stance toward the specific target', () => {
    const state = emptyState();
    state.world.people = ['林檩'];

    const exLoverCard = { id: 'c1', name: '方亦楷', baseline: '他和林檩原本是恋人，现在已经分手。' };
    assert.equal(analyzeBaselineStance(exLoverCard, state, '林檩'), 'distant', 'Ex-lovers who broke up must be distant, NOT warm');

    const reconciledEnemyCard = { id: 'c2', name: '方亦楷', baseline: '她是他的仇人，却已经彻底和解。' };
    assert.equal(analyzeBaselineStance(reconciledEnemyCard, state, '林檩'), 'neutral', 'Reconciled former enemies must be neutral, NOT hostile');

    const coldButWarmToTargetCard = { id: 'c3', name: '方亦楷', baseline: '他性格冷漠，但对林檩温柔体贴。' };
    assert.equal(analyzeBaselineStance(coldButWarmToTargetCard, state, '林檩'), 'warm', 'Cold to others but warm to target must be warm toward target');

    const roleConditionCard = { id: 'c4', name: '方亦楷', baseline: '对敌人敌对，对亲友温柔。' };
    assert.equal(analyzeBaselineStance(roleConditionCard, state, '林檩'), 'neutral', 'Generic role rules must not mark user as hostile enemy');
});

test('Adversarial Guard 14 (v0.3.0 Req 6): Scene extraction separates outer narrative frame from quoted past speech and resolves past-to-present transitions', () => {
    assert.equal(
        extractLatestSceneFromText('林檩在餐厅里说：“我昨晚在医院等了你很久。”'),
        '餐厅/咖啡馆',
        'Quoted past location (昨晚在医院) must NOT override current narrative scene (在餐厅里)'
    );
    assert.equal(
        extractLatestSceneFromText('上次在医院见过他，今天终于回家了。'),
        '家中/居所',
        'Past clause (上次在医院见过他) must NOT override present arrival (今天终于回家了)'
    );
    assert.equal(
        extractLatestSceneFromText('方亦楷在工作室里抬头道：“以前在学校宿舍的时候经常熬夜画图。”'),
        '办公室/职场'
    );
});

test('Adversarial Guard 15 (v0.3.0 Req 7): End condition verification checks who apologized to whom and rejects apologies to third parties', async () => {
    const actor = { id: 'fang.png', name: '方亦楷' };
    let state = emptyState();
    state = userEdit(state, {
        id: 'cold_short',
        layer: 'short',
        concept: '因林檩失约而冷淡',
        description: '因林檩失约而保持冷淡克制',
        duration: { mode: 'turns', remaining: 6, endCondition: '林檩道歉' },
    }, 'fang.png');
    // Set managedBy to auto so automatic endCondition retirement is allowed to manage it
    state.influences[0].managedBy = 'auto';

    // 1. Apologizing to a third party ("我刚才向别人道歉了，对不起") MUST NOT end the state!
    const wrongTargetMsg = { node: 'ap_wrong', index: 0, actorOwn: false, speaker: '林檩', text: '我刚才向别人道歉了，对不起。' };
    const wrongRes = buildLocalAnalysisResult({ actor, fresh: [wrongTargetMsg], known: [wrongTargetMsg], state });
    assert.equal(wrongRes.changes.some(c => c.action === 'retire'), false, 'Apologizing to a third party must NOT trigger endCondition for actor');

    // 2. Negated apology ("我没有向你道歉") MUST NOT end the state!
    const negatedMsg = { node: 'ap_neg', index: 1, actorOwn: false, speaker: '林檩', text: '我没有向你道歉。' };
    const negRes = buildLocalAnalysisResult({ actor, fresh: [negatedMsg], known: [negatedMsg], state });
    assert.equal(negRes.changes.some(c => c.action === 'retire'), false, 'Negated apology must NOT trigger endCondition');

    // 3. Direct apology from 林檩 to 方亦楷 ("我向你道歉了") MUST end the state!
    const rightTargetMsg = { node: 'ap_right', index: 2, actorOwn: false, speaker: '林檩', text: '我向你道歉了，是我不好。' };
    const rightRes = buildLocalAnalysisResult({ actor, fresh: [rightTargetMsg], known: [rightTargetMsg], state });
    assert.equal(rightRes.changes.some(c => c.action === 'retire' && c.targetId === 'cold_short'), true, 'Direct apology from 林檩 to 方亦楷 must fulfill "林檩道歉"');
});

test('Acceptance 1: Same character card evolves distinct acquired personas and proactive coping behaviors across two worldlines without extra API calls', async () => {
    const db = new Database('acc1', new IDBFactory());
    const { ctx } = createHostContext('worldline-A');
    const ctrl = new Controller(() => ctx, { db });
    ctrl.bind();
    ctrl.changeSettings({ promptBudget: 1800 });
    await ctrl.enqueue(() => ctrl.sync());

    await simulateTurn(ctrl, ctx, {
        userMes: '今晚七点我们在老地方餐厅见面，我有事想和你聊。',
        charReply: '好，七点我准时到。我先把设计图收尾。',
    });
    const checkpointMeta = clone(ctx.chatMetadata[KEY]);
    const prefixChat = clone(ctx.chat);

    // Worldline A: Explicit causal coping response to perfunctory breach
    await simulateTurn(ctrl, ctx, {
        userMes: '哎呀我忘了今晚约会的事，跟朋友去玩了没能来，多大点事嘛改天再说。',
        charReply: '知道了，既然你没来，我已经回事务所继续做方案了。',
    });
    await ctrl.evolveLocally('fang.png');
    const stateA = clone(ctrl.timeline.node.state);
    const acquiredA = stateA.influences.find(x => x.layer === 'acquired');
    assert.ok(acquiredA, 'Worldline A forms an acquired persona trait from corroborated breach and causal coping response');
    assert.ok(acquiredA.concept.includes('戒备') || acquiredA.actionDecision.includes('预先安排'));

    // Switch to Worldline B from common checkpoint prefix
    ctx.chatId = 'worldline-B';
    ctx.chatMetadata[KEY] = clone(checkpointMeta);
    ctx.chat = clone(prefixChat);
    await ctrl.enqueue(() => ctrl.sync());

    await simulateTurn(ctrl, ctx, {
        userMes: '对不起亦楷，医院临时有急诊手术我失约了，刚才才下手术台。',
        charReply: '急诊要紧，先去忙吧。我刚好带了电脑在旁边把图纸处理完了。',
    });
    await ctrl.evolveLocally('fang.png');
    const stateB1 = clone(ctrl.timeline.node.state);
    const acquiredB1 = stateB1.influences.find(x => x.layer === 'acquired');
    assert.ok(acquiredB1, 'Worldline B forms an understanding yet organized acquired trait');
    assert.notEqual(acquiredB1.concept, acquiredA.concept);
    assert.notEqual(acquiredB1.selfView, acquiredB1.behavior);

    // Follow-up in Worldline B: Sincere fulfillment softens/revises the trait
    await simulateTurn(ctrl, ctx, {
        userMes: '今天我特意提前到了半小时，还带了你喜欢的胃药和热粥来照顾你。',
        charReply: '……谢谢。我已经把下午的会议推后了，坐下吃吧。',
    });
    await ctrl.evolveLocally('fang.png');
    const stateB2 = clone(ctrl.timeline.node.state);
    const acquiredB2 = stateB2.influences.find(x => x.layer === 'acquired');
    assert.ok(acquiredB2.evolutionLog.length >= 2);
    assert.ok(acquiredB2.intensity < acquiredB1.intensity);

    ctx.chatId = 'worldline-A';
    ctx.chatMetadata = {};
    ctx.chat = [
        ...prefixChat,
        { name: '林檩', is_user: true, mes: '哎呀我忘了今晚约会的事，跟朋友去玩了没能来，多大点事嘛改天再说。' },
        { name: '方亦楷', original_avatar: 'fang.png', mes: '知道了，既然你没来，我已经回事务所继续做方案了。' },
    ];
    await ctrl.enqueue(() => ctrl.sync());
    assert.equal(ctrl.timeline.node.state.influences.find(x => x.layer === 'acquired').concept, acquiredA.concept);
    ctrl.dispose();
});

test('Acceptance 2: Semantic recall retrieves non-keyword-overlapping past experiences across >15 competing records (both vector API and local semantic engine)', async () => {
    const db = new Database('acc2', new IDBFactory());
    const { ctx } = createHostContext('semantic-chat');
    const ctrl = new Controller(() => ctx, { db });
    ctrl.bind();
    ctrl.changeSettings({ promptBudget: 2400 });
    ctx.chat.push({ name: '林檩', is_user: true, mes: '上次在餐厅没露面是因为医院临时有一台急诊手术。' });
    await ctrl.enqueue(() => ctrl.sync());
    const targetNode = ctrl.timeline.node.hash;

    await ctrl.mutate(st => {
        for (let i = 0; i < 16; i++) {
            st.experiences.push({
                id: `filler_${i}`,
                actorId: 'fang.png',
                knownTo: ['fang.png'],
                evidenceType: 'fact',
                summary: `日常闲聊记录编号 ${i}：讨论了城南建筑建材与图纸归档琐事`,
                appraisal: `普通的事务性交流 ${i}`,
                attribution: '日常工作沟通',
                salience: 0.4,
                sources: [{ node: targetNode, key: targetNode, index: 0, quote: '上次在餐厅' }],
            });
        }
        st.experiences.unshift({
            id: 'target_emergency_exp',
            actorId: 'fang.png',
            knownTo: ['fang.png'],
            evidenceType: 'fact',
            summary: '对方因医院临时急诊手术未能在餐厅露面',
            appraisal: '体谅突发医疗状况导致的爽约，但形成了提前确认与带工作备选的习惯',
            attribution: '医院急诊突发不可抗力',
            salience: 0.85,
            sources: [{ node: targetNode, key: targetNode, index: 0, quote: '医院临时有一台急诊手术' }],
        });
        return st;
    }, '注入测试经历库');

    ctx.chat.push({
        name: '林檩',
        is_user: true,
        mes: '窗外下起大暴雨，路上严重堵车，我今晚可能会晚点到。',
    });

    ctx.eventSource.emit(events.GENERATION_STARTED, 'normal', {}, false);
    await ctrl.intercept(ctx.chat, 16384, noopAbort, 'normal');
    assert.ok(ctrl.lastPrompt.includes('医院临时急诊手术未能在餐厅露面'));
    ctx.eventSource.emit(events.GENERATION_STOPPED);

    ctrl.embeddings.fetcher = async (_url, req) => {
        const body = JSON.parse(req.body);
        const embeddings = body.input.map(txt => {
            if (txt.includes('急诊手术') || txt.includes('晚点到')) return [0.98, 0.2];
            return [0.05, 0.99];
        });
        return { ok: true, json: async () => ({ data: embeddings.map((embedding, index) => ({ index, embedding })) }) };
    };
    ctrl.changeSettings({ embeddingEnabled: true, embeddingURL: 'https://embedding.example.test/v1/embeddings', embeddingModel: 'text-embedding-3-small' });
    ctx.eventSource.emit(events.GENERATION_STARTED, 'normal', {}, false);
    await ctrl.intercept(ctx.chat, 16384, noopAbort, 'normal');
    assert.ok(ctrl.lastPrompt.includes('医院临时急诊手术未能在餐厅露面'));
    ctrl.dispose();
});

test('Acceptance 3: Immediate emotion decays strictly over 3 valid owner replies, ignoring NPC replies, OOC, stop, empty replies, and swipes', async () => {
    const db = new Database('acc3', new IDBFactory());
    const { ctx } = createHostContext('group-lifecycle');
    ctx.groupId = 'group-1';
    ctx.groups = [{ id: 'group-1', members: ['fang.png', 'xin.png'] }];
    const ctrl = new Controller(() => ctx, { db });
    ctrl.bind();
    ctrl.changeSettings({ localEvolution: false, autoAnalyze: false });
    ctx.chat.push({ name: '林檩', is_user: true, mes: '大家都在会议室。' });
    await ctrl.enqueue(() => ctrl.sync());

    await ctrl.mutate(st => userEdit(st, {
        id: 'imm3',
        layer: 'immediate',
        concept: '会议被打断的微恼',
        description: '因方案讨论被打断而略感烦躁，但表面维持克制',
        duration: { mode: 'turns', remaining: 3 },
        expression: 'latent',
    }, 'fang.png'), '添加3回合即时情绪');

    ctx.characterId = 1;
    await simulateTurn(ctrl, ctx, { userMes: null, charReply: '我觉得这个方案还可以再改改。', speaker: '辛言', avatar: 'xin.png' });
    assert.equal(ctrl.timeline.node.state.influences[0].duration.remaining, 3);

    ctx.characterId = 0;
    await simulateTurn(ctrl, ctx, { userMes: '【OOC】先暂停一下对戏', charReply: '好的，我们戏外沟通。', speaker: '方亦楷', avatar: 'fang.png' });
    assert.equal(ctrl.timeline.node.state.influences[0].duration.remaining, 3);

    await simulateTurn(ctrl, ctx, { userMes: '我们回到正题继续开会吧。', charReply: '好，翻到第三页图纸。', speaker: '方亦楷', avatar: 'fang.png' });
    assert.equal(ctrl.timeline.node.state.influences[0].duration.remaining, 2);

    await simulateTurn(ctrl, ctx, { userMes: null, charReply: '好，我们先看第三页的结构图。', kind: 'swipe', speaker: '方亦楷', avatar: 'fang.png' });
    assert.equal(ctrl.timeline.node.state.influences[0].duration.remaining, 2);

    await simulateTurn(ctrl, ctx, { userMes: '这部分承重没问题吗？', charReply: '我已经验算过两次，数据合格。', speaker: '方亦楷', avatar: 'fang.png' });
    assert.equal(ctrl.timeline.node.state.influences[0].duration.remaining, 1);

    await simulateTurn(ctrl, ctx, { userMes: '太好了，那辛苦你了。', charReply: '分内之事，接下来看预算表。', speaker: '方亦楷', avatar: 'fang.png' });
    assert.equal(ctrl.timeline.node.state.influences[0].duration.remaining, 0);

    ctx.eventSource.emit(events.GENERATION_STARTED, 'normal', {}, false);
    await ctrl.intercept(ctx.chat, 16384, noopAbort, 'normal');
    assert.equal(ctrl.lastPrompt.includes('会议被打断的微恼'), false);
    ctrl.dispose();
});

test('Acceptance 4: User edits to experience attribution, persona traits, batch actions and deletions are strictly respected by automatic evolution', async () => {
    const db = new Database('acc4', new IDBFactory());
    const { ctx } = createHostContext('user-authority');
    const ctrl = new Controller(() => ctx, { db });
    ctrl.bind();
    await ctrl.enqueue(() => ctrl.sync());

    await simulateTurn(ctrl, ctx, {
        userMes: '对不起，我今天因为急诊手术迟到了一个小时。',
        charReply: '急诊要紧，我已经带了电脑在旁边把报表处理完了。',
    });
    await ctrl.evolveLocally('fang.png');

    let state = ctrl.timeline.node.state;
    assert.ok(state.experiences.length >= 1);
    assert.ok(state.influences.length >= 1);

    const expId = state.experiences[0].id;
    await ctrl.mutate(st => editExperience(st, {
        id: expId,
        evidenceType: 'fact',
        summary: '林檩因协助路人送医而迟到一小时',
        appraisal: '得知她是为了救人而迟到，内心不仅毫无责怪，反而更加敬重她的善良',
        attribution: '见义勇为的突发善举',
        syncDescription: true,
        correctedBehavior: '主动替她分担后续工作并准备热饮',
    }, 'fang.png', true), '人工纠正事件解释与归因');

    state = ctrl.timeline.node.state;
    const updatedExp = state.experiences.find(e => e.id === expId);
    assert.equal(updatedExp.userCorrected, true);
    assert.equal(updatedExp.attribution, '见义勇为的突发善举');
    const linkedInf = state.influences.find(x => x.evidence.includes(expId));
    assert.ok(linkedInf.rationale.includes('见义勇为的突发善举'));
    assert.equal(linkedInf.actionDecision, '主动替她分担后续工作并准备热饮');

    const infToDelete = state.influences[0];
    await ctrl.mutate(st => removeInfluence(st, infToDelete.id, true), '删除并屏蔽');
    await ctrl.evolveLocally('fang.png');
    assert.equal(ctrl.timeline.node.state.influences.some(x => x.id === infToDelete.id), false);
    ctrl.dispose();
});

test('Acceptance 5: Auto scene/people adaptation, L0 baseline calibration, L4 autonomous goals, custom variables, and full lin-emotional-control sampling', async () => {
    const db = new Database('acc5', new IDBFactory());
    const { ctx } = createHostContext('auto-adapt');
    const ctrl = new Controller(() => ctx, { db });
    ctrl.bind();
    ctrl.changeSettings({ promptBudget: 2600, expressive: true, intensity: 75, dark: 60, unpredict: 55, eventRate: 80 });
    ctx.chat.push({ name: '林檩', is_user: true, mes: '亦楷，我们在办公室聊聊下周的项目约定吧。' });
    await ctrl.enqueue(() => ctrl.sync());

    await ctrl.mutate(st => setBaselineOverride(st, 'fang.png', {
        summary: '克制守时但内心重情的建筑师',
        coreTraits: ['克制', '守时', '外冷内热'],
        bottomLines: ['绝不背叛原则与伴侣'],
        speechStyle: '沉稳简练',
        initialRelationships: ['与林檩是深度信任的伴侣与搭档'],
    }), '校正L0基线');

    await ctrl.mutate(st => userEdit(st, {
        id: 'scoped_lin',
        layer: 'acquired',
        concept: '对林檩的承诺保持确认并预留工作退路',
        description: '面对林檩的约会或承诺会提前确认时间，并随身携带工作资料以防空等',
        selfView: '我完全体谅她的忙碌',
        behavior: '提前备好手头工作，嘴上平淡但行动周全',
        triggerCondition: '当林檩提出约定或讨论日程时',
        actionDecision: '主动确认具体时间节点，同时安排好自己的备选工作计划',
        personRules: { '林檩': '嘴硬心软，预先留出弹性时间但绝不口头抱怨' },
        scope: { people: ['林檩'], scenes: ['办公室'] },
    }, 'fang.png'), '添加限定林檩与办公室的后天倾向');

    await ctrl.mutate(st => userEdit(st, {
        id: 'goal_1',
        layer: 'goal',
        concept: '完成美术馆改建终版蓝图',
        description: '在本周内独立完成美术馆结构蓝图审核',
        motivation: '确保项目按期交付，维持生活与工作主动权',
        priority: 'high',
        planSteps: ['核对荷载数据', '完成三层平面图', '提交甲方终审'],
        currentStep: '完成三层平面图',
        progress: 60,
        actionDecision: '在对话间隙推进平面图细节确认',
    }, 'fang.png'), '添加L4自主目标');

    await ctrl.mutate(st => {
        const actor = ctx.characters[0];
        const found = discoverVariables({ actor: { id: 'fang.png', name: '方亦楷', baseline: actor.scenario }, chat: ctx.chat, state: st });
        let next = st;
        for (const v of found) next = setVariable(next, 'fang.png', v, '自动发现');
        return next;
    }, '自动发现变量');

    ctx.eventSource.emit(events.GENERATION_STARTED, 'normal', {}, false);
    await ctrl.intercept(ctx.chat, 16384, noopAbort, 'normal');
    const p1 = ctrl.lastPrompt;

    assert.ok(p1.includes('L0 原始人格基线与底线保护'));
    assert.ok(p1.includes('对林檩的承诺保持确认'));
    assert.ok(p1.includes('嘴硬心软，预先留出弹性时间'));
    assert.ok(p1.includes('完成美术馆改建终版蓝图') && p1.includes('60%'));
    assert.ok(p1.includes('演出抽样') && p1.includes('关联机会（userAccess）'));
    assert.ok(p1.includes('角色动态变量') && p1.includes('信任度'));
    ctrl.dispose();
});

test('Acceptance 6: Real index.js lifecycle, 1200-turn long chat incremental sync performance (<350ms), budget cap, UI modals, and clean disable', async () => {
    const window = new Window();
    globalThis.document = window.document;
    document.body.innerHTML = '<div id="extensions_settings2"></div>';
    globalThis.indexedDB = new IDBFactory();

    const { ctx, prompts } = createHostContext('long-chat-1200');
    for (let i = 0; i < 600; i++) {
        ctx.chat.push({ name: '林檩', is_user: true, mes: `第 ${i + 1} 轮讨论：关于约定与方案推进的细节记录。` });
        ctx.chat.push({ name: '方亦楷', original_avatar: 'fang.png', mes: `第 ${i + 1} 轮回应：我已记录并预先安排好相应进度。` });
    }

    globalThis.SillyTavern = { getContext: () => ctx };
    onEnable();
    assert.equal(typeof globalThis.linDynamicPersonaIntercept, 'function');
    await sleep(80);

    ctx.chat.push({ name: '林檩', is_user: true, mes: '现在第601轮了，如果我今晚因为堵车晚点到，你会怎么安排？' });
    const startMs = Date.now();
    ctx.eventSource.emit(events.GENERATION_STARTED, 'normal', {}, false);
    await globalThis.linDynamicPersonaIntercept(ctx.chat, 32000, noopAbort, 'normal');
    const elapsedMs = Date.now() - startMs;

    assert.ok(elapsedMs < 350, `1,200-message intercept took ${elapsedMs}ms`);
    assert.ok(prompts.some(p => p[0] === KEY && p[1].includes('Lin 动态人格')));

    onDisable();
    assert.equal(globalThis.linDynamicPersonaIntercept, undefined);
    assert.equal(prompts.at(-1)[1], '');

    delete globalThis.SillyTavern;
    delete globalThis.indexedDB;
    window.happyDOM.abort();
    delete globalThis.document;
});
