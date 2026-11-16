# 变更记录

## 0.7.0 阶段 B（隔离测试构建）

- 接入追加受理、完整来源映射、原子额度预留、派发标记、失败结算与带租约的精确提交；并发新楼与部分楼均保留。
- 断网、取消、超时和切换聊天后不自动重发；只退未派发预留。冻结重试核对来源、请求与配置，并绑定用户确认过的批次和尝试。
- 修复本页准备任务被恢复流程误接管、复制标签页沿用会话冒用租约、派发前已超时仍可能调用模型的问题。
- 归档重建后等待手动发送决定；取消仅处理确认范围，保留并发新增来源。Inspector 接入真实来源账本，显示异常及历史未核实，区分预留、派发意图和退款。
- 原 78 项测试保留，新增 30 项，合计 108/108 通过。原生浏览器复测受环境权限阻止，真实宿主和付费模型尚未验收；继续保留开发标记。详见 [阶段 B 测试](docs/QUEUE-B-TEST-REPORT.md)。

## 0.7.0 阶段 A（开发交接）

修复持有有效租约的旧快照覆盖后来追加来源的问题；增加可交叉核验的来源责任账本、精确原子 ACK、冻结批和尝试预留/退还，以及 v5 旧库升级与退回镜像。阶段 A 不单独投产，调度与 UI 由 B 接入。见 [阶段 A 测试](docs/QUEUE-TEST-REPORT.md)。

## 0.6.0 · 接力构建 1（LDP-0.6.0-handoff.1，基于 LDP-0.5.0-handoff.3 全面修复 P0-01~P0-04）
- **P0-01 主提示词否定与条件语义保真及指令边界分离（`src/prompt.js`、`src/growth.js`）**：
  - 修复 `src/prompt.js::clean()` 此前移除 `/必须|强制|绝对不能/` 导致自然语言人格含义反转（如将「面对陌生人绝对不能透露真实身份」删成「面对陌生人透露真实身份」）的严重缺陷。
  - 将**字段数据纯文本化（`clean`）**与**越权指令边界检测（`detectPromptInjection` / `inspectRecordSafety`）**彻底分离：`clean()` 100% 保留「绝对不能、绝不、不能、不愿、只有…才、除非、仅当、不再、尚未、自认为、据说」等所有否定、条件、程度与主观词；仅做控制字符清理、宏/尖括号转义与独立调试代号清理。
  - 对含越权系统指令（如 `### System:`、`ignore previous instructions`、`替玩家决定`）的不可信记录，在提案审核阶段（`decidePolicy`）与投影阶段（`compose`）直接整条隔离，绝不“删词后带病拼入提示”，并在 Inspector 中输出 `blocked_reason` 与 `fieldAudit`（原始受控字段与最终投影字段的脱敏对照）及 `verifySemanticPreservation` 校验。
  - 修正 `scoreBehavioralContrast()`：允许角色自然语言边界合法包含「绝对不能/必须」，改为检验是否存在越权模型指令、代写玩家或内部标签泄露。
- **P0-02 源级/批次级精确子集 ACK、楼层多片段完整性与无损背压保护（`src/controller.js`、`src/analysis.js`、`src/storage.js`）**：
  - 修复 `pumpAnalysis()` 与 `analyze()` 将全部 `j.anchors` 作为 `consumedAnchors` 整批删除，而 `makeAnalysisInput()` 仅截取 `batchSize` 或 5300 字符上限导致未分析剧情静默丢失的缺陷。
  - 实现 `computeFullyAckedAnchors`：建立 `sourceId → nodeHash/anchor → batchId` 映射，仅当某楼层（及其配对用户楼层）的所有应处理可见片段均已进入 `processed` 时才移除该楼层 `anchor`；同楼层拆出多片段而本批仅处理部分片段时，保留该楼层锚点直至剩余片段全部处理完毕。
  - 队列默认按**最早未完成顺序（FIFO，`latest: false`）**逐批推进；移除 `task.anchors.size > 100` 时删除最早锚点及 `sessions.size >= queueLimit` 时直接丢弃新角色队列的逻辑，改为 `backpressure` 与 `waiting_capacity` 无损保留；新增 `auditSourceConservation` 验证来源状态守恒（`queued + inflight + failedRetained + acknowledged + unqueued === totalVisible`）。
- **P0-03 冻结持久化 `BatchManifest` 与失败后继续 RP 的同批重试保护（`src/controller.js`、`src/storage.js`、`src/analysis.js`）**：
  - 修复 `analyze()` 按当前最新 `branchHead/revision` 动态重算 `fullJob` 且在预检前改写队列状态，导致失败后继续 RP 新增消息使旧批无法重试并破坏失败状态的缺陷。
  - 首次准备时冻结持久化不可变 `BatchManifest`（`batch:<batchId>`，记录 `sourceIds`、`anchorIds`、`sourceFingerprint`、`providerProfileId`、`modelId`、`contractVersion`、`payloadFingerprint`、`attemptNo`）。
  - 失败后继续 RP 新增的 1/5/20 楼归入后续排队，绝不篡改 `failedBatch`；显式 `retry=true` 时在任何状态变更前执行严格预检（核对原来源仍在当前分支且指纹未变、配置档/模型/合同未变、无并发在途尝试），预检失败保持 `failed_requires_review` 原状不变；预检通过则严格仅重发 `failedBatch.sourceIds`，成功后新楼留在队列等待下一批；新增 `discardFailedBatch` 供用户显式丢弃旧失败批次并从当前分支重建。
- **P0-04 租约感知 CAS / Fencing Token 防旧快照覆盖与超时防重发（`src/storage.js`、`src/controller.js`）**：
  - 修复 `saveQueue()` 盲目整行 `put` 覆盖 `claimOwner/claimUntil` 的缺陷。
  - 拆分为 `appendQueueAnchors`（仅追加合并锚点，严格保留现有租约、状态与失败批次）与租约感知 CAS `saveQueue` / `claimQueue` / `releaseQueueLease`。
  - 引入单调递增 `fencingToken` 与 `queueRevision`：未持有有效租约的旧内存快照调用 `saveQueue` 只能合并新锚点，绝不能清空或篡改活跃租约；持有过期 `fencingToken` 的旧标签页迟到写回或 `commitAnalysis` 在事务内被直接拒绝并回滚；若前序租约到期时任务处于 `sent=true` 且结果未知，自动原子转为 `failed_requires_review` 并拒绝自动重发，防止重复计费。

## 0.5.0 · 接力构建 3（LDP-0.5.0-handoff.3）
- 初步引入队列状态枚举、`commitAnalysis` 事务、`markJobSent`、无日期多场次 L1 校验、群聊现场公开动作 `public_action` 与 3 角色 × 5 情境对照矩阵。

## 0.5.0 · 接力构建 2（LDP-0.5.0-handoff.2）
- 提示词词汇相关度重排、完整合同移除 12.5KB Schema 复写、`diagnoseAnalysisResponse` 离线分类诊断、C 档 L1 修订/削弱/目标完成退役与独立网关 `stateFile` 原子日配额。

## 0.5.0 · 接力构建 1（LDP-0.5.0-handoff.1）
- 分离分析与演出合同、L0–L4 五层结构、A/B/C 三档审批、多副 API 配置档、v0.4 只读镜像迁移与可选服务端网关。
