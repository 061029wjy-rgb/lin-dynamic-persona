# Lin Dynamic Persona 0.7.0｜阶段 A → 账号 B

**构建 LDP-0.7.0-stage-A.1。仅用于阶段 B 接力和隔离环境测试，不能单独替换正式插件。**

给接手 AI 的第一句话：**以这个包为唯一开发起点。先读本报告、docs/QUEUE-API-CONTRACT.md 和 docs/QUEUE-TEST-REPORT.md，再将现有 controller、AnalysisService 和 Inspector 接入已验证的存储接口。保留原 63 项测试及新增 15 项。不要为了让旧断言变绿恢复整份快照覆盖、裸删或无租约 ACK。**

## 用哪一份源码

ZIP 只有一个扩展顶层目录 `lin-dynamic-persona/`。直接打开该目录可见 `manifest.json`、全部前端源码、原 gateway 源码、测试和文档。无需再下载 0.5 或去 GitHub 找包。测试所用浏览器二进制、真实账号数据均不在包内。日常使用者继续用正式版本。

若需保留 Git 历史，从解压出的扩展目录运行（dev-work 是新的空目录）：

```sh
git init ../dev-work
git -C ../dev-work fetch "$PWD/handoff/stage-A.bundle" HEAD
git -C ../dev-work switch -c stage-b FETCH_HEAD
```

BUILD.json 记录本次开发提交、目标版本、基线和产物身份。`SHA256SUMS.txt` 可在解压出的扩展目录中用 `sha256sum -c SHA256SUMS.txt` 核对全部成员。包内报告列出可独立还原全部已提交源码的 Git bundle SHA-256；包外同名内容的报告另列**整个交付 ZIP** 的 SHA-256，避免让压缩包试图包含自身哈希。

## 唯一输入的校验值

| 输入 | SHA-256 / 提交 |
|---|---|
| 用户的 lin-dynamic-persona-0.6.0.zip | `737a1b286a621870ce75eddeaf26ceb22e3665df7a0f69fb9d8aaaa226a5ec0a` |
| 用户的 lin-dynamic-persona-handoff-0.6.0.zip | `c00682318faeae2e06f92dbc92e65b6cf66363770a514dcf00099a4f82ddb6c1` |
| 两包的 src/storage.js | `e4998faa9dee4d8f272172417a42950a286e0d489cee06e6edaf3fd80f3f66a3` |
| 两包的 src/controller.js | `d6ec48eb2b28e36d3a57b41b5ffd22ddabe2a1c1c34302fb6bd330b4b78b53a4` |
| 原构建 / 原 Git 提交 | `LDP-0.6.0-handoff.1` / `47052916585dcd3a7d55980dc5171380c6343f30` |

## 已经修好的问题

- 真实浏览器里，原版甲领取 [A]、乙追加 B、甲写回，队列退为 [A]。甲的租约合法，快照却过时。修复后状态改变不删/替换成员；ACK 和过时撤销必须有精确来源，已终结成员不会被旧快照复活。
- 原版把消失的 X 归到 unqueued，依然报告 conserved=true。现在受理凭据与实际队列、映射、批次、job、终态操作和提交日志分别保存、交叉核验。主动破坏成员后会报告具体 missing IDs 并令 ok=false。不开插件时未受理的聊天不算失踪；迁移前有痕迹但不能证明的历史单列。
- 收到分析结果后，五表单事务提交人格和来源；真正注入 abort 时没有留下半份新状态。新尝试把冻结批、有效预算预留和 job 原子登记。预算不够或预留出错，旧有效失败 job 仍能找到。标记派发以后结果未知，不能退款或自动发第二次。

## B 的接线清单与边界

| B 必须改的地方 | 采用 A 的接口 | 最小验收 |
|---|---|---|
| Controller.scheduleAnalysis、restoreQueues、pumpAnalysis、cancel、wakeWaitingQueues | appendQueueAnchors / patchQueueState / retireQueueAnchors / readQueueFacts | 入队成功才报 accepted；失效有原因，过时快照不写回 |
| Controller.analyze / makeAnalysisInput 调用处 | registerQueueSources → reserveBatchAttempt | 完整登记楼层可知片段，再取实际输入子集。零可见片段不进发行额度 |
| AnalysisService.send / finish | markBatchAttemptSent / releaseBatchReservation / failBatchAttempt | 一次网络操作一次预算；断网未知、超时、切聊天不自动重发；未派发才退款 |
| Controller.analyze 的 computeFullyAckedAnchors / Timeline.commitAnalysis / setQ | commitAnalysis（必传有效租约）；随后 readQueueFacts | 实际来源与派发一致，保留部分楼及并发新增楼；读数据库而不重用前一份 Set |
| Controller.discardFailedBatch、重试流程、Inspector | readBatchAttempt / archiveFailedBatch / adoptLegacyFailure / auditQueueLedger | 明确授权后重发；曾发与仅预留区分；显示失踪、孤批、历史未核实，而非把 unqueued 当证明 |

职责分界：A 已实现数据库原语，**没有把 B 的派发调度、失败重试交互、审计面板做成“已完成”**。Controller、service、analysis、growth、prompt、providers、原情绪插件及 gateway 均未改。旧面板中的守恒统计仍指 v0.6.0 旧算法，不能据此验收新账本。若旧程序试图用无映射/无原子预留的自动路径发请求，本阶段会拒绝；这是开发包不能单独上线的具体原因。

## 改动文件与证据

- 产品：`src/storage.js`，新增 `src/queue-ledger.js`；manifest/package 声明 0.7.0 阶段 A。原人格演化和提示内容不变。
- 测试：`tests/queue-storage.test.js`、`tests/queue-cases.mjs`、`tests/queue-driver.js`、`tests/browser/queue-storage.cjs`；`tests/shims/indexeddb.js` 修正模拟事务的回滚镜像时点。`tests/services.test.js` 原断言保留。
- 文档：本报告、`docs/QUEUE-API-CONTRACT.md`（参数、错误码、事务和示例）、`docs/QUEUE-MIGRATION.md`（备份与退回）、`docs/QUEUE-TEST-REPORT.md`（逐项验收）、`docs/evidence/phase-a/`（原始日志）。README/CHANGELOG 和打包元数据标明开发阶段。精确文件列表可用 `git diff --name-status 47052916585dcd3a7d55980dc5171380c6343f30 HEAD`。
- 原版先跑 `npm run check`、`npm test`，63/63。阶段 A 静态通过；`npm run test:queue` 15/15；10 个实际 Chromium 页面跑同一套原生 IndexedDB 15/15，含 A-T01～A-T12。全量 `npm test` 为 **74/78，退出码 1**，没有跳过旧用例。原 T06、T02、T03 等 B 接线；原 T04/T05 的测试准备直接覆写受保护队列，须改成真实到期或测试专用故障入口。完整服务、Tauri、真实 Vertex 及供应商计费没有实测。本次没调用模型。

## 安全退回与后续发布

只读核查/隔离测试后，可留在原 0.6.0 浏览器资料。对升级过的测试库，`exportV6Rollback()` 可导出升级前的镜像，`Database.restoreV6Rollback(...)` 在同账号的全新资料恢复；不覆盖活动 v7A。升级后新增的账本不能假装是 v6 的既有历史。更换浏览器前保留其完整资料，不能只靠酒馆 JSONL 或旧人格导出搬运待办。详见迁移说明。

现有 `npm run package` 对这个阶段只打开发接力包。若需重新构建，把原 0.6.0 安装包路径传给环境变量 `LDP_BASE_ZIP`（解压交接包的 handoff/ 下已有），可用 `LDP_DIST` 指定输出。B 完成全部接线、修复旧集成测试并完成宿主验收后，再明确更新正式发布目标与元数据，不要把本开发标记去掉后直接发布。
