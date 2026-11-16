# Lin Dynamic Persona 0.7.0｜阶段 B 完成记录

构建 `LDP-0.7.0-stage-B.1`，2026-11-17。**这是隔离测试构建，尚不能作为正式替换包。** 阶段 B 调度、派发、失败处理和 Inspector 已接入来源账本；本地 108/108 测试通过。真实浏览器复测被当前进程权限阻止，真实 SillyTavern、Tauri 与付费供应商未验收。

## 唯一开发起点与复核

开发完全从用户提供的阶段 A 包及其 Git bundle 还原，没有下载其他版本作开发基线。

| 输入 | 已核对的 SHA-256 / 提交 |
|---|---|
| `lin-dynamic-persona-0.7.0-stage-A.zip` | `896e41088967ef30e14c391f8e65afbd3bb0c07937fc3b96ab92773682888838` |
| 阶段 A 的 `handoff/stage-A.bundle` | `27aa5986731afbe3f83fc8ae72d3869e8f9b268999d7ced8e65c03e79784cbfd` |
| 阶段 A 源码提交 | `c55bd0bcddaccbf9ede39d29d4118dd2e5231849` |

原包清单 111 个成员校验通过。首先阅读了 `HANDOFF-TO-B.md`、`docs/QUEUE-API-CONTRACT.md`、`docs/QUEUE-TEST-REPORT.md`，复现阶段 A 的静态通过及全量 74/78、4 项旧集成失败。历史报告和阶段 A 原始证据继续保留，不将历史结论改写为阶段 B 的实测。

## 已完成的接线

| 环节 | 本次行为 |
|---|---|
| 入队、恢复、等待与取消 | 事务完成后才返回 accepted；只追加、状态补丁或具名撤销，UI 随后重读数据库。取消操作保留并发新楼。 |
| 来源登记 | 完整登记每个锚点的全部角色可见片段，再选实际发送子集。无可见来源时登记原因并撤销，不占发行额度。 |
| 派发 | 冻结批、七项额度和 job 原子预留；网络调用前登记精确来源与请求指纹；一次尝试只有一次网络调用。 |
| 失败与恢复 | 未派发的预留才退款；派发后断网、超时、取消、切聊天均保留可能计费的失败。不会自动重发；迟到响应不能补交。 |
| 提交与 ACK | 收到响应不提前结束 job。人格、processed、job、批次及精确 ACK 在同一存储事务提交；保留部分楼和期间新增楼。 |
| 显式重试 | 从数据库读取当前失败尝试；核对冻结来源、完整楼层映射、配置/实际模型/合同/请求指纹。面板确认绑定具体批次和 job，过期确认不能授权另一个尝试。 |
| 归档重建 | 保留旧费用和尝试记录；重建后停在待人工决定状态，不因归档按钮再发请求。取消只作用于确认过的锚点。 |
| Inspector | 显示真正的账本 audit、失踪 ID、孤批、来源不符与历史未核实；区分仅预留、已登记派发、未派发已退款。读取失败明确显示无法判断。 |

额外修复：恢复流程不再释放本页正在准备的租约；队列持有人使用每次运行独立的 ID，避免复制标签页沿用同一 sessionStorage 后冒用租约；派发前已超时不再调用模型；原请求未真正结束前保留本页服务互斥；已明确撤销的片段不被再次选入。

## 改动边界

新增 `src/queue-runtime.js` 承担队列运行逻辑，Controller 继承并接入其异步接口。修改 `src/service.js`、`src/ui.js`，对 `src/queue-ledger.js` 仅增加终态来源的只读投影和失败尝试的已知用量元数据。`src/storage.js` 的保护和原子提交机制未放宽。

人格规则、两套分析提示、成长策略、情绪抽样、providers、gateway、拦截器入口、样式均与阶段 A 相同。物理数据库版本仍为 6，人格备份格式仍为 5；无需新增数据库迁移。

## 测试证据与边界

- 原 63 项及阶段 A 新增 15 项全部保留；新增 30 项，共 **108/108，通过；无跳过**。
- `npm run check` 通过；`npm run test:queue` 保留的 15/15 通过。
- 原测试准备中的裸队列写改为仅测试使用的显式故障注入；入队调用改为 await；守恒断言改查独立账本，同时保留原有来源数、预算、租约和回滚断言。没有恢复整份快照覆盖、裸删或无租约 ACK。
- 新测试覆盖原子受理失败、完整映射与部分楼、跨连接追加、取消前后额度、恢复、过期租约、1/5/20 轮后重试、模型/Schema 变化、可见范围变化、误报守恒、中文面板及确认范围。
- 原生 Chromium 复测启动失败：`socket() failed: Operation not permitted (1)`。阶段 A 的 10 页原生 IndexedDB 15/15 属于阶段 A 历史证据，不算本次复测通过。
- 本次没有购买或调用真实模型；本地测试通过不能证明 Google AI Studio、Vertex、Tauri 或实际供应商计费行为。

完整条目与原始日志见 `docs/QUEUE-B-TEST-REPORT.md` 和 `docs/evidence/phase-b/`。

## 交付、恢复和下一步

ZIP 仍只有一个 `lin-dynamic-persona/` 扩展顶层目录，包含全部源码、gateway 源码、原测试、增补测试、报告与完整 Git bundle。在扩展目录执行 `sha256sum -c SHA256SUMS.txt` 校验文件。`BUILD.json` 和本报告的打包身份标明源码提交；ZIP 哈希写在包外报告，避免自包含哈希。

需要保留历史时，从扩展目录恢复到新的空目录：

```sh
git init ../dev-work
git -C ../dev-work fetch "$PWD/handoff/stage-B.bundle" HEAD
git -C ../dev-work switch -c verify-stage-b FETCH_HEAD
```

运行 `npm run check`、`npm test`、`npm run test:queue`。原生复测需环境允许启动 Chromium 并提供 Playwright，执行 `npm run test:queue:native`。`npm run package` 只从已提交的 HEAD 打阶段 B 开发包，不再误用阶段 A 的运行时范围校验，也不会落到旧正式包分支。

后续发布门槛：在独立资料运行真实宿主事件链、原生 IndexedDB 多页并发、刷新恢复、中文面板的重试/归档/取消、所需供应商与设备验收；证据通过后再明确决定正式发布。沿用 `docs/QUEUE-MIGRATION.md` 的备份和退回流程；勿在活动新库上降级或删表。普通人格 JSON 不包含队列、失败尝试与额度，不能作为完整待办搬迁包。

## 本次打包身份

源码提交：64aa16aa0fb41f02d774a0afd155f4bfd9eaf408

完整源码 bundle SHA-256：c019829a7c03475c2ed21a9a6bbc056032158af0408d533f5ad69083061079e1
