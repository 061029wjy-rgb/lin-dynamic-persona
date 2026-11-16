# Lin Dynamic Persona v0.6.0 · 完整整改与交接报告（LDP-0.6.0-handoff.1）
**唯一基线：承接 `LDP-0.5.0-handoff.3`（提交 `1afb9c3b7eb5c84e6a45dbe62613b7ca06a71e96`），完成《Lin Dynamic Persona v0.5.0（handoff.3）｜完整整改要求与验收规范》全部 P0-01～P0-04 缺陷修复与 T01–T15 本地及宿主验收，升级版本号为 `0.6.0`（构建标识 `LDP-0.6.0-handoff.1`），`npm run check && npm test` 63/63 通过。**

---

## 一、架构与核心机制设计说明（P0-01 ～ P0-04）

### 1. 提示字段语义保真与越权指令边界分离方案（P0-01）
- **问题根因**：`handoff.3` 的 `src/prompt.js::clean()` 使用 `.replace(/必须|强制|绝对不能|\bL[0-4]\b/g, '')` 粗暴删除自然语言词汇，导致角色设定或后天倾向中的「面对陌生人绝对不能透露真实身份」被反转成「面对陌生人透露真实身份」，且 `scoreBehavioralContrast()` 将自然语言边界词「必须/强制/绝对不能」误判为失败。
- **v0.6.0 解决方案**：
  1. **职责分离**：`clean()` 只做非破坏性纯文本格式化（长度限制、控制字符与换行归一化、`{{ → ｛｛` 宏转义、`< → ＜` 尖括号转义及移除独立的 `\bL[0-4]\b` 调试前缀），**100% 保留**「绝对不能、绝不、不能、不愿、只有…才、除非、仅当、不再、尚未、自认为、据说」等所有否定、条件、程度与主观词。
  2. **越权指令检测与整条隔离**：新增 `detectPromptInjection()` 与 `inspectRecordSafety()`，专门识别伪造角色指令头（`### System:`、`### Assistant:`）、方括号/XML 控制标签（`[SYSTEM]`、`<system>`）、中英文忽略规则指令（`ignore previous instructions`、`忽略以上规则`）及代写玩家指令。一旦某条记录的任何字段命中越权注入，在提案审核阶段（`decidePolicy`）拒绝自动采用并转待审；在主提示投影阶段（`compose`）**整条隔离跳过**，在 `report.skipped` 与 `report.fieldAudit` 中记录 `blocked_reason`，绝不“删词后把半截残句拼入主提示”。
  3. **语义保真复核与 Inspector 对照**：新增 `verifySemanticPreservation()` 自动校验投影前后否定词、条件词与 `自认为` 标记无丢失；Inspector（`exportInspectorSample`）同时导出原始受控字段与最终投影字段的脱敏对照 `fieldAudit`。

### 2. 批次与源 ID 四层关系模型、精确子集 ACK 与无损背压（P0-02）
- **四层显式身份模型**：
  1. **待分析队列（Queue，`queue:<stream>:<actor>`）**：持有该角色所有待处理楼层锚点 `anchors`。
  2. **冻结批次清单（BatchManifest，`batch:<batchId>`）**：按 **FIFO（最早未完成顺序，`latest: false`）** 从队列选出本批实际覆盖的 `sourceIds` 与 `anchorIds`，生成不可变 `batchId`。
  3. **实际派发来源（Dispatched `input.fresh`）**：严格等于 `BatchManifest.sourceIds`。
  4. **已核验提交来源（Committed `state.processed[actor]`）**：在 `commitAnalysis` 事务内写入 `processed[actor]`。
- **同楼层多片段完整性与精确 ACK（`computeFullyAckedAnchors`）**：
  - 建立 `anchor → requiredVisibleSourceIds` 映射。某楼层锚点 `anchor` **仅当该楼层（及配对用户楼层）的所有可见片段 ID 均已进入 `processedSet` 时**，才从队列 `anchors` 中移除。若某楼层拆出多个片段而本批仅处理了部分片段，该楼层锚点继续保留，直至剩余片段在后续批次全部处理完毕。
- **无损背压保护与状态守恒（`auditSourceConservation`）**：
  - 移除 `anchors.size > 100` 时删除最早锚点及 `sessions.size >= queueLimit` 时直接忽略新角色队列的逻辑；超量时启用 `backpressure` 与 `waiting_capacity` 状态保留全部锚点并向 UI 报告。任意时刻满足守恒：`acknowledged + inflight + failedRetained + queued + unqueued === totalVisible`。

### 3. 冻结 `BatchManifest` 与失败后继续 RP 的同批重试状态机（P0-03）
- **批次冻结与后续 RP 隔离**：首次准备批次时将 `BatchManifest`（含 `batchId`、`sourceIds`、`anchorIds`、`sourceFingerprint`、`providerProfileId`、`modelId`、`contractVersion`、`payloadFingerprint`、`attemptNo`）持久化至 `usage` 表 `batch:<batchId>` 及队列 `failedBatch`。失败后玩家继续 RP 新增的 1/5/20 楼正常追加进 `qTask.anchors`，但**绝不修改 `failedBatch` 的来源范围或 `batchId`**。
- **重试前只读预检（Pre-flight Check）**：显式调用 `analyze(..., retry=true)` 时，在修改任何队列状态（如 `preparing`）或释放租约之前，先只读核对：① 存在未提交的 `failedBatch` 且无并发在途尝试；② `failedBatch.sourceIds` 仍在当前分支可见且正文/偏移指纹与 `sourceFingerprint` 完全一致；③ 当前配置档、模型与分析合同未发生变更；④ 当前账户/日/会话配额充足。任何一项预检未通过，立即拒绝并**保持原 `failed_requires_review` 状态毫发无损**。预检通过后仅重发冻结的 `failedBatch.sourceIds`，成功后仅 ACK 该批锚点，失败后新增的楼层继续留在队列中等待下一批。同时提供 `discardFailedBatch` 供用户显式丢弃旧批次并从当前分支重建。

### 4. 多标签页 Fencing Token / CAS 租约感知机制（P0-04）
- **拆分追加与状态转移**：日常消息入队调用 `appendQueueAnchors()`，在事务内只合并新锚点，严格保留数据库现有的 `claimOwner`、`claimUntil`、`fencingToken`、`status` 与 `failedBatch`。
- **单调递增 `fencingToken` 与 CAS 校验**：每次 `claimQueue()` 成功时递增 `fencingToken` 与 `queueRevision`。`saveQueue()`、`releaseQueueLease()` 与 `commitAnalysis()` 均在事务内核对 `callerOwner` 与 `fencingToken`：未持有有效租约的旧内存快照调用 `saveQueue()` 只能合并新锚点，绝不能清空活跃租约；持有旧 `fencingToken` 的过期标签页迟到写回或提交会被直接 `abort` 回滚。
- **租约超时防重发守卫**：若前序标签页租约已到期，但数据库记录 `sent === true` 且处于 `sending/received/validating`（结果未知），新标签页调用 `claimQueue()` 时会将其原子转为 `failed_requires_review` 并中止自动领取，**绝不因租约到期而自动重发可能已计费的请求**。

---

## 二、源码变更表（v0.5.0 handoff.3 → v0.6.0 handoff.1）

|问题编号|修改文件与函数|新设计摘要|兼容性与回滚影响|验证测试 ID|仍存风险与工程边界|
|---|---|---|---|---|---|
|**P0-01**|`src/prompt.js`：`clean`、`detectPromptInjection`、`inspectRecordSafety`、`verifySemanticPreservation`、`compose`、`scoreBehavioralContrast`、`exportInspectorSample`；`src/growth.js`：`decidePolicy`|分离纯文本转义与越权指令检测；保留全部否定/条件/主观词；越权记录整条隔离并输出 `blocked_reason` 与 `fieldAudit` 对照。|完全兼容既有 L1–L4 记录；旧库含越权指令的记录自动隔离待审，不静默改写冻结记录。|**T01、T08、T15**|正则/模式检测拦截已知指令注入模板；自然语言深层隐喻诱导仍依赖外围固定系统指令约束。|
|**P0-02**|`src/controller.js`：`scheduleAnalysis`、`pumpAnalysis`、`computeFullyAckedAnchors`、`auditSourceConservation`；`src/analysis.js`：`makeAnalysisInput`、`stageAnalysis`|FIFO 分批；按楼层可见片段 100% 完成度计算 ACK 子集；移除 100 锚点删除上限与 `queueLimit` 丢弃，改为 `backpressure / waiting_capacity`。|旧队列自动补齐背压字段；不丢失任何已排队锚点。|**T02、T06**|超长积压（如 >500 楼未分析）需按配额分多批逐步消化。|
|**P0-03**|`src/controller.js`：`analyze`、`discardFailedBatch`；`src/storage.js`：`saveBatchManifest`、`getBatchManifest`；`src/analysis.js`：`makeAnalysisInput(exactSourceIds)`|首次准备冻结不可变 `BatchManifest`；失败后继续 RP 不影响旧批重试；重试前只读预检不破坏失败状态；支持显式丢弃旧批重建。|向下兼容旧 `job:` 幂等记录；新增 `batch:<batchId>` 记录。|**T03、T06**|若远端服务商在断网前已实际收到请求，用户手动点击重发会产生第二次远端请求（UI 已明确提示可能再次计费）。|
|**P0-04**|`src/storage.js`：`appendQueueAnchors`、`saveQueue`、`claimQueue`、`releaseQueueLease`、`commitAnalysis`；`src/controller.js`|引入单调递增 `fencingToken` 与 `queueRevision` CAS 校验；防止旧内存覆盖租约；拦截迟到提交；`sent=true` 租约超时转人工复核。|在现有 `usage` 表内扩展字段，无需新建 IndexedDB 表或破坏 v5 结构。|**T04、T05**|保障同浏览器 profile 下多标签页强一致；跨不同浏览器/设备的并发需依赖备份导入的版本号检查。|
|**P1-01~07**|`src/ui.js`、`src/service.js`、`scripts/generate-overhaul-evidence.mjs`、`docs/*`|升级至 v0.6.0；面板展示队列背压、来源守恒报表与字段投影审计；生成预登记盲评规程与故障注入证据。|与 `v0.4 / v0.5` 备份及 `lin-emotional-control` 保持兼容。|**T01–T15**|正式主 RP 模型盲评、付费云端账户与 Tauri/iOS 真机仍需在目标环境实机验收。|

---

## 三、明确未完成项及运行限制（严禁虚报通过）

1. **远端计费原子性边界**：本地 IndexedDB 事务只能保证「本地分支修订 + 本地账本记录 + 本地队列 ACK」的原子性，**无法与外部模型服务商的计费系统构成跨网络分布式事务**。当请求已发出（`sent=true`）但遭遇断网或超时时，插件无法获知服务商是否已扣费；插件承诺的是**绝不未经用户授权自动重发、本地同一批次最多提交一次**。
2. **正式主 RP 模型 A/B 真人盲评（P0-05 / T07）**：本包已完成 P0-01 否定语义保真修复，并在 `docs/evidence/ab-contrast-matrix.json` 中交付了 3 角色 × 5 情境的完整发送提示、Inspector 脱敏对照与预登记盲评规程；但当前构建环境无外部商用 RP 大模型访问权限，故**状态明确标为「未完成实机效果验收」**。
3. **付费云供应商与 Tauri/iOS 实体设备（T12 / T13）**：8 类 HTTP 协议适配器与独立网关已通过本机真实 TCP 接收器与 SillyTavern 1.19.0 桌面端验证；真实 Google Cloud Vertex AI IAM/ADC、OpenAI/Anthropic/OpenRouter 付费账户及 Tauri/iOS WebView 实体机留待目标环境验收。
4. **BM25 与 LLM 推断边界**：本地中文 BM25 仅负责无向量词汇/同义词表召回，不负责认定事实；语言模型对复杂潜台词与心理动机的推断无法承诺 100% 零误判，因此高风险与言行不一推断默认保留在待审箱由玩家最终把关。
