# 0.7.0 阶段 A｜队列存储合同（给阶段 B）

本合同以 `src/storage.js` 导出的 `Database` 为调用入口；队列方法继承自 `src/queue-ledger.js::QueueDatabase`。全部方法返回 Promise，只有 IDB 事务的 `oncomplete` 才算成功。失败会 reject；业务错误有 `error.code`，磁盘配额、事务/约束错误保留原生错误。生成主流程可以跳过分析，但**不要把 catch 当成已入队／已派发／已处理**。不改聊天、卡、提示词、主连接或网关。版本：`LDP-0.7.0-stage-A.1`。

## 身份、可见范围与单位

- `s` 是独立世界的 streamId（现有 UUID，无冒号），`a` 是稳定角色标识，`k = 'queue:'+s+':'+a`。不同角色/stream 的同名来源互不相通。分支锚点是选中消息链的 hash，不是随楼层移动的整数。
- `Q` 为实际持久队列：`key/stream/actor/anchors`（首次接受顺序）、`status/reason/room`、`activeBatch/failedBatch/sent`、`claimOwner/claimUntil/fencingToken/queueRevision`、`acknowledgedSourceIds/backpressure/overflowCount` 等。返回的修改结果含 `anchorCount`；旧快照未写回前可能没有此冗余字段，请使用 `facts.anchors.length`。无待办时空队列留存代号，`loadQueues` 不把它作为待分析队列返回。
- `O={callerOwner,fencingToken,expectedRevision?}`。B 必须使用自己刚领到的租约。owner 和 token 均严格相等，时间以事务内本机时钟为准；过期也不能释放或提交。token 阻挡跨租约旧写者，revision 检查同租约内容版本，两者不可互代。token 不是同源恶意脚本的安全凭证。需要 CAS 时填刚读取的 `expectedRevision`；追加 B 后，旧 revision 明确冲突。普通追加不需要持租约。
- 入队责任分两层：楼锚点和可知片段。`acceptedCount = acceptedAnchorCount + acceptedSourceCount`，不能当成独立消息数。先登记锚点，后登记完整片段集合；配对 user 楼的片段归到此次负责分析它的角色回复锚点。`frozen.anchorIds` 指**队列责任锚点**，不是无条件使用 `fresh.map(x=>x.node)`。同一 stream/角色内，每个 sourceId 只归一个责任锚点；冲突必须解决，不能给同一段复制两份责任。
- 映射包含身份及指纹，不包括 RP 原句。B 从已保存的选中 Swipe、该角色的权限和正文计算稳定指纹，在发送前和提交前重验。只传 ID、指纹、简短理由，不把提示词、原文、密钥或整段错误响应放进理由。存储层能比对指纹，不能替 B 判断角色是否亲眼看见，也不能证明服务商收到了哪段文本。

## 队列和来源 API

| 精确调用 | 成功返回及约束 |
|---|---|
| `appendQueueAnchors(s,a,anchors,meta={})` | 最新 Q，含 revision/数量。只增不减、FIFO 去重；只接受 `room/reason/status/branchRevision/sourceFingerprint`，其中初始状态限等待态。禁止传正文；每楼有不同指纹时分别追加，或直接用链 hash 作为初始指纹。已终结身份再次追加为幂等忽略；检测到有凭据但成员失踪会报错，不自动“修复”证据。 |
| `readQueueFacts(s,a,{branchAnchors?}={})` | 一个只读事务的 `{queue,queueRevision,anchors,lease,processedSourceIds,processedSources,mappings}`；`lease={callerOwner,fencingToken,claimUntil}`。可为已处理来源和映射提供当前祖先链锚点；原始 queue/anchors 仍是整个责任队列。无过滤时已处理列表是历史核验记录，不是当前人物一定知道的事实。迁移前的处理状态仍须读取该分支原人格投影。 |
| `claimQueue(s,a,tabId,leaseMs=60000)` | Q 或 null（没有工作）。同持有人在有效期内重复获取返回同一租约，不延长；别人持有报冲突。过期且派发结果未知时，先在事务中保留失败，再以 `LEASE_EXPIRED_SENT` 拒绝本次领取。下一次领取仅用于复核、退款、归档或经确认的重发。 |
| `renewQueueLease(s,a,ms,O)`；`releaseQueueLease(s,a,tabId,token,patch={},opts={})` | Q；延长但不缩短有效租期，不换 token。释放必须拥有租约；有 activeBatch 时先退回未派发预留或结束当前尝试。opts 支持 expectedRevision。旧 release 的 `patch.anchors` **完全忽略**。 |
| `patchQueueState(s,a,patch,O={})` | 最新 Q；字段仅 `status/reason/errorKind/waitingDay`。未被占用且无未决批次可无租约设置 queued/waiting_host/waiting_profile/waiting_budget/waiting_capacity。preparing 需租约；received/validating 需可核对的在途批次。sent、批次、已处理 ID、成员及租约均不能由 patch 写入。 |
| `registerQueueSources(s,a,h,sourceIds,sourceFingerprint,{...O,complete=true,emptyReason?})` | 返回该锚点的映射记录，含 `sourceIds/mappingComplete/mappingFingerprint/emptyReason`。默认一次封存完整有序清单；分块登记时用 `complete:false` 和相同楼级指纹，最后用全清单封存。重复登记幂等，不能删掉曾登记的片段。空可见清单必须有原因，不能派发或假 ACK，可用 stale_source 明确归档。封存后权限/内容变化不能用新数据覆盖旧证据。 |
| `retireQueueAnchors(s,a,anchorIds,{...O,sourceIds=[],state,reason,branchRevision,operationId})` | 返回撤销凭据：`operationId/at/state/branchRevision/reason/anchors/sources/retiredSourceIds`。state 仅 explicitly_cancelled、stale_branch、stale_source。可仅指定片段；撤销整楼会终结其非终态片段，不改写已提交来源。仅退指定成员；未被选中的其他候选仍待处理。同一 op/范围幂等，变更内容报冲突。尚有相关未发预留/在途调用时先结算。 |
| `archiveFailedBatch(s,a,batchId,{...O,operationId,branchRevision,reason,confirmLegacy?})` | 返回批次归档凭据。明确撤掉失败批的派发意图，**不删锚点**；仍待处理的成员回到 queued。用于玩家让 B 重建批次；重建用新 batchId，不擦掉原工作历史。旧批缺少可核实 job 时只允许明确确认归档，不能冒充提交。 |
| `loadQueues(s?)`；`listQueueHistory(s,a,'anchor'或'source',ref)` | 活动队列列表；单项的接受凭据及有序状态事件（含原因、操作 ID、时间与适用的 job/batch）。 |
| `saveQueue(s,a,entry,opts={})`（仅旧代码过渡） | 只合并成员；`replaceAnchors:true` 也不删、不重新激活终态、不信任 entry 的租约、sent、失败批或 acknowledgedSourceIds。可更新有限等待元数据；提供正 token 或要求 release/strict 时严格校验。**B 不应再使用它写整份会话。** |
| `clearQueues(...)`；普通 `put/remove` | clearQueues 始终拒绝。直接 put/remove 的 queue:/batch:/job: 行、queueLedger、v6Rollback 均拒绝。用户清理必须读实际成员、claim、逐队列做具名 retire。低层 transaction 只用于存储实现、迁移及测试故障注入，业务层不得调用。 |

已取消、过时或已提交的同一锚点保持终态。重选另一 Swipe、编辑正文通常会形成新链 hash；仅改变权限而锚点没变时，不能借换随机 ID 偷偷重启旧任务。若未来要重新接受同一原文，应新增显式的责任代次协议；本阶段没有提供此操作。

## 冻结批次、预留和单次尝试

`F` 的确切字段：`batchId,streamId,actorId,originalBranchHead,originalRevision,sourceIds,anchorIds,sourceFingerprint,payloadFingerprint,providerProfileId,modelId,contractVersion`。sourceIds 有序且无重复；anchorIds 为其责任楼。sourceFingerprint 为选中片段清单及内容/偏移的指纹，payloadFingerprint 为实际分析输入指纹。冻结的模型/配置或请求变更需另行明确重建；不能复用旧 batchId 偷换请求。

| 调用 | 成功结果／故障语义 |
|---|---|
| `readBatchAttempt(batchId)` | null 或 `{manifest,frozen,pending,last,history}`。manifest 含恒增 attemptNo、pendingJobId、lastJobId、jobHistory、status；pending 和 last 是同一只读事务读到的 job 行（若有）。last 是最后登记过派发意图的有效 job。history 是所有预留成功的 job ID，包括未发送后退还的尝试。`getBatchManifest(batchId)` 只读原行。 |
| `reserveBatchAttempt(F,{...O,jobId,session,limits,expectedAttemptNo,previousJobId,confirmResend?,dispatchHead?,dispatchRevision?})` | 一次 readwrite 事务完成冻结清单、验证责任映射、CAS 当前尝试、预算/配置独占预留、job、历史、队列，返回 `{manifest,job,usage,queueRevision}`。首次传 `0,null`；随后使用数据库实读的序号和 lastJobId。本批曾派发必须 `confirmResend:true`。limits 必填非负整数 total；可提供 day/session/profileTotal/profileDay/profileSession/actorLimit/interval（秒）/timeout（秒）/estimate，其余计数沿用原账本。配置、角色从 F 取。输入 key 或竞争/配额不符时全不写；绝不能先做一次旧 reserve。 |
| `markBatchAttemptSent(s,a,batchId,jobId,actualSourceIds,{...O,payloadFingerprint})` | 返回 manifest。再次检查来源映射、实际有序来源、精确 payload 指纹、原租约和有效配置预留，然后才改 lastJobId、记录 sending 与派发意图。紧贴真实传输前执行并 await；事务失败禁止发送。崩溃发生在此事务和 HTTP 之间也只能判“可能已发送”，不能据此退款/自动重发。 |
| `releaseBatchReservation(s,a,batchId,jobId,{...O,reason})` | 只退未标记派发的 pendingJob。原子退还同七项计数、释放本 job 的配置占用、保留 released_unsent 历史；lastJobId 仍指上一次真正登记派发的 job。返回 manifest。刷新/接管后，使用**当前有效租约**退回遗留预留，再另行预留；新租约不能直接发送旧租约的 pendingJob。 |
| `failBatchAttempt(s,a,batchId,jobId,{...O,reason})` | 同一事务把当前已派发尝试、自身楼和片段转为 failed_retained，持久化失败凭据、释放配置和队列租约；不退已派发配额。返回 manifest。解析失败、超时、网络结果未知都可保留，B 决定显示的原因。 |
| `adoptLegacyFailure(F,{...O,confirmLegacy:true,previousJobId,reason})` | 只用于 0.6 原有失败批。先由 B 重验原剧情及指纹并 register 映射，核对旧 manifest、确实存在的同批同角色同配置 job、已发送且已失败状态与 attemptNo；满足才接管至 failed_retained。旧 source node 与新的责任 anchor 分开保存；旧 job 不会被填入虚构的 dispatchedSourceIds。历史仍报告 legacy。无法核对则拒绝，改由玩家选择保留或明确归档。 |
| `commitAnalysis(stream,node,expectedNodeRevision,label,guard,opts)` | opts 必须含有效 `queueKey,callerOwner,fencingToken,batchId,job,consumedAnchors,consumedSourceIds`；可含 expectedRevision、supersededJob、resultMeta。guard 同步核对房间/角色/分支/原文。检查 dispatchHead、dispatchRevision、数据库 stream.seq 与 node.revision；再在 **streams、nodes、journal、usage、queueLedger 五表一事务**写人格、processed、job、batch、来源与终态、成员、租约和预算锁。返回 `{stream,node,queueRevision,acknowledgedAnchors,acknowledgedSourceIds}`。用现有 Timeline 封装时返回 boolean，之后仍须 readQueueFacts。 |
| 旧 `reserve/releaseUnsent/markJobSent/finishJob/saveBatchManifest` | 只适用于独立的无队列手动调用等 v0.6 用例；不能代替上述受控流程。不能通过省略 queueKey 把已登记的阶段 A job/batch 走手动提交。 |

**精确 ACK**：成功的完整分析必须提交实际派发的那组片段；集合不相等、外加 processed、漏一个有资格完成的楼，整个事务拒绝。一次只处理某楼的一部分时，实际提交本批片段即可，楼继续排队；等已登记片段全部已提交或有分别核实的撤销记录，才可在本批确认该楼。不要为了清空队列而给未知片段补写 processed。失败、空可见来源和玩家主动取消都不等于成功。`supersededJob` 只能是本尝试真实前驱。

若追加新 RP 后仍要重试原失败批，F 保持身份不变；dispatchHead/dispatchRevision 必须来自**本次**针对有效原文重新验证的 Timeline。存储层不替调用方判断老来源是否位于当前祖先链。首次不传这两项时默认用 F 中原值；重试时 B 应明确传入。

## 可核验审计

`await db.auditQueueLedger(s,a)` 在同一只读事务中读 usage、queueLedger、journal，交叉检查接受记录、当前投影、历史、队列成员、反向映射、批次/尝试、确认日志和撤销凭据。它不用“当前聊天全文数”作分母。

| 字段 | 意义 |
|---|---|
| acceptedCount / acceptedAnchorCount / acceptedSourceCount | 迁移后可证明曾被接受的责任总数 / 其中楼数 / 片段数。不是历来所有可见片段数。 |
| counts / observedCounts / unverifiedAcceptedCount | counts 只计交叉验证通过的类别；observedCounts 是投影上的标签数，仅诊断。未得到有效分类的责任不凑进 counts。accepted_pending 是受理阶段，正常追加事务未完成时外部看不到半条。其他类别为 queued、inflight、failed_retained、committed、explicitly_cancelled、stale_branch、stale_source。 |
| unexpectedMissingIds | 曾接受但缺失状态/成员或合法终结依据的标识。 |
| duplicateTerminalIds / orphanedBatchIds / sourceMismatchIds | 重复或矛盾终态 / 孤立或不一致的批次、尝试 / 映射、派发、processed 证明等不符。异常列表可能重叠。任一非空即 ok=false。 |
| legacyUnverifiedCount / coverage / ok | 旧数据能识别但无完整历史的标识数；legacy_partial 或 recorded_admissions_only；ok 仅就可检查数据，不能证明账本启用前从未丢过消息。 |

举例：A 尚在排队但其实际队列成员被旧代码清走，关联片段也无独立终态，则 A 和片段都出现在 unexpectedMissingIds；即使旧 Inspector 的 unqueued 完全“对得上”，此审计也会失败。普通数据库交叉验证不是防篡改签名，若清空整个浏览器或同时销毁所有独立凭据，无法从空库证明过去接受过什么。

## 接线顺序（伪代码；字段名为实际 API）

```js
const q = await db.claimQueue(s, a, tab, 60000);
if (!q) return;
const O = { callerOwner: tab, fencingToken: q.fencingToken };
await db.registerQueueSources(s, a, H, [X,Y], floorDigest, O); // 本楼全部可知片段
// 这一次只发送 X；Y 仍在队列。B 负责权限、分支和实际发送输入的指纹。
const F = { batchId, streamId:s, actorId:a, originalBranchHead:head, originalRevision:rev,
  anchorIds:[H], sourceIds:[X], sourceFingerprint:srcDigest, payloadFingerprint:payloadDigest,
  providerProfileId:profileId, modelId, contractVersion };
await db.reserveBatchAttempt(F,{...O,jobId,session,limits,expectedAttemptNo:0,previousJobId:null});
if (!stillValid()) return db.releaseBatchReservation(s,a,batchId,jobId,{...O,reason:'source_changed_before_send'});
await db.markBatchAttemptSent(s,a,batchId,jobId,actualInput.fresh.map(x=>x.id),{...O,payloadFingerprint:actualDigest});
// 此处才调用一次 adapter；失败走 failBatchAttempt，绝不自动重发。
// stage/apply 只变更当前选中角色与世界线。
await timeline.commitAnalysis(() => stagedState, '心理分析', timelineToken, stillValid,
  { ...O, queueKey:q.key, batchId, job:jobId, consumedSourceIds:[X], consumedAnchors:[] });
const live = await db.readQueueFacts(s,a,{branchAnchors:currentAncestorHashes});
```

## 错误与恢复

- `LEASE_REQUIRED/LEASE_CONFLICT/FENCE_CONFLICT/LEASE_EXPIRED_SENT/REVISION_CONFLICT`：停止写入，读数据库；已派发未知时转人工。不要把冲突“修复”为取新 token 继续提交旧结果。
- `PATCH_FIELD/PATCH_STATE/PROTECTED_WRITE/PROTECTED_BATCH/EXPLICIT_RETIRE_REQUIRED/BAD_INPUT/REASON_REQUIRED/OP_CONFLICT`：调用契约错误，修调用方，不自动重试。
- `QUEUE_MISSING/ANCHOR_MISSING/ANCHOR_TERMINAL/TRACKING_MISSING/MAPPING_CONFLICT/SOURCE_MISMATCH/INCOMPLETE_ACK/SCOPE_MISMATCH/BRANCH_CHANGED`：保留现场、展示具体来源或重做**本地**核验。
- `ATTEMPT_CONFLICT/BATCH_BUSY/BATCH_MISMATCH/MANIFEST_CONFLICT/MANAGED_ATTEMPT_REQUIRED/DUPLICATE_JOB/CONFIRM_RESEND/LEGACY_REVIEW/JOB_MISSING`：重读 readBatchAttempt 与 readQueueFacts。确认角色/实际证据、是否已预留或已发送；不要自行改 job ID 后再请求。
- `BUDGET_LIMIT/BUDGET_INTERVAL/PROFILE_BUSY/RESERVATION_EXPIRED/QUOTA_INCONSISTENT/ALREADY_SENT`：保留旧失败，只有可靠未发的预留允许退款。`UPGRADE_BLOCKED/BAD_BACKUP/DEST_NOT_EMPTY` 见迁移说明。
- 注入故障的回调仅供测试。各类配额与状态只在本地浏览器 profile 内原子；扣费以供应商为准。发生未知结果时禁止自动补发。

## 阶段 B 必须替换的旧调用点

1. `Controller.scheduleAnalysis/restoreQueues/wakeWaitingQueues/pumpAnalysis/cancel`：await 入队后再报告接受。别再用 saveQueue(整份 Set) 或 remove(queueKey)；失效用 retire，暂缓用 patch。取消尚未发出的**尝试**不等于取消**来源责任**。按修订从 readQueueFacts 合并 UI；数据库竞争不能 catch 后显示成功。
2. `Controller.analyze` 的 makeAnalysisInput 之后：为当前责任楼构建完整可见映射（含符合权限的前置 user 楼），不能只登记被当前 token 预算截取的 fresh 子集。无可见片段先注明原因；冻结、派发只使用实际输入的子集。重试不要先保存带新 lastJobId 的旧 manifest。
3. `AnalysisService.send/finish`：自动队列路径改用 reserveBatchAttempt/markBatchAttemptSent/releaseBatchReservation/failBatchAttempt；不要再额外走一次 reserve 或把“收到响应”提前记作人格提交。守住预算、一次派发、取消及 late response。非队列手动探测仍用原接口。
4. `Controller.analyze` 的 computeFullyAckedAnchors/Timeline.commitAnalysis/setQ：按映射和真实 processed 精确 ACK，不把零可见片段当完成；成功后 readQueueFacts 重新装载，不拿旧 qTask 再写。冲突或写入失败时先查最新 batch/lease 再决定如何记录失败。
5. `Controller.discardFailedBatch` 改用 archiveFailedBatch 或明确的逐项 retire；`auditSourceConservation` 保留作可见文本分布，不再当“零丢失”结论。Inspector 要显示 auditQueueLedger 的核验、失踪、异常、历史未核实数。阶段 A 没有改这些函数。

## 阶段 B 的兼容增补（2026-11-17）

存储保护、物理布局和已有必填授权均不变。以下为向后兼容的补充：

- `readQueueFacts` 新增 `terminalSourceIds`，同一只读事务列出 committed / explicitly_cancelled / stale_branch / stale_source 来源 ID；`branchAnchors` 过滤同样适用。`processedSourceIds` 仍只表示 committed，不能用终态列表给人格 processed 造记录。
- `failBatchAttempt(..., O)` 可附 `resultMeta`；仅接收 http、finish、model、provider、requestId、usage、cost，保留已知的响应元数据，不改变失败判定、预算或租约要求。
- `Controller.scheduleAnalysis` 是异步受理接口；必须 await，事务成功后返回 `{accepted, queueRevision}`。内存 sessions 只是数据库投影，禁止以 Set 改动来替代入队或 ACK。
- Controller 每次运行生成独立 `queueOwner`；不得以可跨复制标签页共享的预算 session ID 当租约持有人。刷新后的实例等待其他有效租约到期，再按未知/未发分类恢复。
- `analyze(..., true, {retryBatchId,retryJobId})` 的最后一项是 queueOpts，UI 的显式确认应绑定这两个当前持久化标识。派发仍用 expectedAttemptNo / previousJobId 做事务检查。来源相同但模型、请求选项或必要上下文已变时，要求归档后重建，不能把新请求称为旧批精确重试。
- `discardFailedBatch(actor,{rebuildQueue,expectedBatchId,anchorIds})`：expectedBatchId 为确认过的失败批次（没有时传 null）；取消只撤销 anchorIds 中仍待办的来源。重建保留旧尝试，置 manual_review，后续发送另由玩家决定。
- `inspectQueue` 从存储读取 facts、audit 与相关 readBatchAttempt；这些读数是各自事务快照，不承诺供应商收单、计费或跨读事务冻结。

派发意图是网络调用前的本地登记，不等于已经收到远端响应。登记后发生中断仍按未知保留预算；不得用“未观察到 HTTP 返回”推导退款许可。
