# 阶段 A｜测试记录（2026-11-17，北京时间）

唯一输入为上传件。安装 ZIP 与交接源码比对了 storage.js、controller.js 的 SHA-256；版本 0.6.0、构建 LDP-0.6.0-handoff.1、提交 47052916585dcd3a7d55980dc5171380c6343f30。未使用早先其他版本的修改分支。没有调用模型，没有 ST/Vertex/Tauri 真机或人格 A/B 盲评。旧包已有的其他报告不算本阶段结果。

| 运行 | 实际结果 | 原始输出（相对本目录 evidence/phase-a/） |
|---|---:|---|
| 原始 0.6.0：npm run check；npm test | 静态检查通过；63/63 | baseline-check.log、baseline-tests.log |
| 原版反例：领取 [A] → 对方追加 B → 原主带 replaceAnchors 回写 | [A,B] 退回 [A] | baseline-T01.log；原生双标签重复取证在 stage-queue-native.log 的 BASELINE 行 |
| 原版审计负例：上述消失的 B 对应可见 X，原 Controller 的实际审计函数 | unqueued=[X]，conserved=true | stage-queue-native.log 的 BASELINE 行 |
| 阶段 A：npm run check | 通过 | stage-check.log |
| npm run test:queue | 15/15（12 个任务用例 + 3 个补充） | stage-queue-shim.log |
| npm run test:queue:native，Chromium 133.0.6943.0 headless，10 个同源页面，使用真实 IndexedDB | 同一套 15/15；无网络模型 | stage-queue-native.log |
| 阶段 A：原有测试 + 新用例，npm test | 74/78，4 红；未删除、跳过或改写原有 63 项断言 | stage-all.log |

原生运行采用 Playwright、本地回环静态服务器、合成数据、独立的 IDB 连接。10 个标签页竞争真实数据库，并在另一隔离浏览器上下文核验 v5 退回。真实浏览器执行的是这份源码的存储层，**不是完整酒馆**。shim 的事务以微任务逐笔执行，已修正其回滚镜像建立时机：在事务实际开始时取镜像，不能在排队时取，否则后一个模拟事务 abort 会撤销前一个已成功事务。生产实现不依赖 shim；原生测试不加载它。

| 用例 | 核对内容 |
|---|---|
| A-T01 | 有效持有人的旧集合不能覆盖追加；CAS 拒绝过时版本；释放带 anchors 不删成员 |
| A-T02 | 追加与提交的交错、同楼多片段分块登记与精确 ACK；新 B/C、别的片段不丢 |
| A-T03 | 实际时间到期后被下一持有人领取；旧、未来、遗漏 token 无权 patch/release/commit；空队列再入队代号不回绕 |
| A-T04 | 十个独立连接同时接受同一个楼，只留一份责任；重复映射幂等 |
| A-T05 | 人为破坏真实持久数据，分别查出失踪、重复终态、孤儿批次、错误映射。失踪不计入已核实 queued 数 |
| A-T06 | 自动分析关闭期的旧库文本不计丢失；无可见片段必须说明原因，不能空 ACK |
| A-T07 | 在写请求已执行后、事务完成前注入 abort，检查 nodes/streams/journal/job/batch/ACK/账本均回滚；旧派发可转失败保留 |
| A-T08 | 换分支、正文编辑、单片段失效和玩家取消留分开的终态；不同角色/分支的已处理来源不混算 |
| A-T09 | 已有 v5 真实升级；历史标 legacy，旧行保持，原有身份不重复接受；原生另验拒绝降版本、同账号空白环境还原 |
| A-T10 | 同批同代预留同时竞争只成功一次；旧失败 job 保留；无确认不得重发 |
| A-T11 | 超预算、登记中途失败、恢复未发送预留，一项项核实 quota、sent、历史和 lastJobId |
| A-T12 | 101/120/500 楼，三个角色，关闭重开后逐项核对 FIFO、背压和局部处理 |
| A-X01 | 已派发后同一 tab 超时也需复核；新租约只能释放/重新预留，不能发送旧预留 |
| A-X02 | 管理删除、整行 put、旧 finish、旧 markSent、篡改冻结清单均被拒；续租不换 fencing |
| A-X03 | 0.6 失败 job 可核实才接管并重试；无有效 job 只能归档；历史 sent 不冒充已知实际派发片段 |

## 为什么完整套件还有 4 项失败

原文件 `tests/services.test.js` 未改动。原 63 项中有 59 项仍通过；4 项记录的是当前开发边界，不应把这个包作为正式版本。

| 原用例 | 这次失败的具体原因 | B 的验收动作 |
|---|---|---|
| T06：9 楼超预算、刷新再处理 | 旧 service 走 reserve；存储在真实预算派发前拒绝旧入口，内存显示 failed_retryable 而非 waiting_budget | 接 reserveBatchAttempt 的预算错误，保留队列和 UI 等待；再测配额解除后的精确 ACK |
| T02：小批分段派发 | 旧 controller 没登记每楼来源；旧 reserve 返回 MANAGED_ATTEMPT_REQUIRED | 建立完整楼映射再对本批实际 fresh 预留、派发、提交；本批之外楼层仍在 |
| T03：失败后点重试 | 旧 service 尚未走新派发入口，fixture 期望的第一次模拟网络调用实际为 0 | 串行接入 reserve/mark/fail，复核冻结内容，授权后重试 |
| T04/T05：旧租约与故障注入 | 原 fixture 用 db.put('usage', 整份队列) 强行造过期，现报 PROTECTED_WRITE | 保留测试意图，改为真实到期或明确 test-only fixture，再透过 B 跑全控制器；A-T03/A-T07 已从数据库层验证。禁止恢复生产裸写入口 |

## 独立复现

```sh
npm run check
npm test                          # 阶段 A 预期为退出 1，详见上述四项
npm run test:queue                # Node 24 / 仓库的 shim，无模型
# 准备已安装的 Playwright 与本机 Chromium/Headless Shell；不要在酒馆生产环境安装测试依赖。
# LDP_V6_SOURCE 指向从原始提交 git archive 解出的 0.6.0 完整源码根目录，使同一浏览器先运行旧版负例。
CHROMIUM=/path/to/chromium LDP_V6_SOURCE=/path/to/v06-source npm run test:queue:native
```

所用 Node v24.22.1、npm 11.9.0；原生测试二进制来自测试用 @sparticuz/chromium@133.0.0。可用环境的 CHROMIUM 路径替代；浏览器/Playwright/测试账号都不打进插件运行时。去掉 LDP_V6_SOURCE 只跳过旧版负例重放，仍运行新版所有用例。全量原始 stdout/stderr 均已保存；日志有本地临时路径和合成角色名，无玩家实际存档。
