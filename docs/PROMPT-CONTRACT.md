# 两套提示合同（v0.6.0 · LDP-0.6.0-handoff.1）
## 送给分析模型：psychology/5.0
`src/analysis.js`：`makeAnalysisInput`、`SCHEMA`、`FOCUS_SCHEMA`、`stageAnalysis`、`diagnoseAnalysisResponse`、`verifyQuote`（`src/sources.js`）和 `src/growth.js`。输入只含目标 `actor`、获准姓名、按**最早未完成顺序（FIFO）**或冻结批次 `exactSourceIds` 选出的可见文字（含群聊现场公开动作 `public_action` 与点名对白 `addressed`）、原作者、已审核/受保护参考（含活跃目标的 `step` 与 `endCondition`）、可选卡片节选；`s1…sN` 仅对本批有效。请求体不重复内嵌 12.5KB 的 Schema 定义。完整合同输出 `events/appraisals/proposals/summaries` 四个数组，均为空合法，非严格模式下允许省略可选的 `null`/空数组字段（由 `parseAnalysis` 安全归一化并拦截未知字段）。见 [完整 JSON Schema](analysis-schema.json) 与 [小模型 Schema](focus-schema.json)。

引文在已保存选中 Swipe 的精确 UTF-16 位置复核；模态、主体、对象、权限、来源和支持／反证再检。本人说过不等于事情客观发生；真实情绪可以不外显。支持言行不一的行为观察提案（`basis: 'observed'`，同时记录 `self_view` 与 `observed_behavior` 反差及替代解释 `alternative`），此类观察推断在 A/B/C 档默认保留在待审箱（附明确 `pendingReason`）供玩家使用 `previewProposalDiff` 干运行预览后确认。若提案任何字段包含疑似越权系统指令（`detectPromptInjection`），`decidePolicy` 直接拦截并转人工待审。C 档在核对基线后支持两个独立日期或两个独立地点/场次（`indepKey`）新建 L1、对已有 L1 记录基于新证据修订（`revise`）、基于反证或新自述削弱（`weaken`）以及基于明确结果表述（`explicit_outcome`）完成并退役自主目标（`goal`）。同时按角色独立维护认知修正链 `cognitiveHistory`（`initial_recognition → revised_understanding`）。手工冻结和墓碑屏蔽永远最高优先。

## 送给主模型：projection/5.0（含 P0-01 否定与条件语义保真）
`src/prompt.js` 只接受当前已采用记录；看当前角色、分支、可见原文、人物/话题/场景、有效期限，并结合当前回合语境的词汇相关度（`lexical`）竞争排序，最多选 4 项（高相关性未置顶条目可击败无关置顶条目，无相关记录时允许零注入）。

### 字段数据安全处理与指令边界隔离（P0-01）
1. **严禁破坏自然语言否定与条件语义**：`clean()` 仅负责长度控制、控制字符与换行归一化、SillyTavern 宏转义（`{{ → ｛｛`）与尖括号转义（`< → ＜`），**100% 保留**「不、没、无、未、不能、绝不、绝对不能、切勿、禁止、必须、强制、不愿、只有…才、除非、仅当、不再、尚未、自认为、据说」等全部自然语言语义，绝不将「面对陌生人绝对不能透露真实身份」删改成「面对陌生人透露真实身份」。
2. **越权指令边界检测与整条隔离**：`inspectRecordSafety()` 与 `detectPromptInjection()` 检查所有受控字段是否包含伪造角色头（`### System:`、`### Assistant:`）、方括号/XML 控制标签（`[SYSTEM]`、`<system>`）、中英文忽略规则指令（`ignore previous instructions`、`忽略以上规则`）或代写玩家指令。一旦命中，该记录被整条隔离跳过，在 `report.skipped` 与 `report.fieldAudit` 中明确记录 `blocked_reason`，绝不“删掉敏感词后把残句拼进主提示”。
3. **语义保真复核与 Inspector 对照**：每条选入记录均通过 `verifySemanticPreservation()` 复核否定词、条件词与主观标记未丢失，并在 Inspector 的 `fieldAudit` 中记录原始受控字段与最终投影字段的脱敏对照。
4. **事实、自认为、外在表现与应对策略严格区分**：主提示清晰区分客观描述、`自认为：…`（`selfView`）、`外在常表现为：…`（`observedBehavior`）、`可考虑：…`（`actionDecision/coping`）、`下一步：…`（`currentStep`）与 `受限于：…`（`blockers`）。当包含长期倾向或个人打算时，尾部指令引导模型仅在当前情境涉及相关事务或对象时自然体现上述倾向与打算（若当前对话仅为日常寒暄、饮食、路况等无关话题则自然回应，不必刻意提及或复述提示字面）。

实收例（SillyTavern 1.19.0、系统槽、宿主计 74 tokens），与面板预览逐字相同：

> 【Seraphina的本轮权衡】  
> 当下感受：先核实工作清单，才放心把交接留给别人。  
> 可自行取舍，感受可以不外显；不替玩家作决定。

一次生成只出现一份该文本，禁用后下一次接收记录中为零。见 `evidence/st-wire.json` 和 `st-wire-coexist.json`。
