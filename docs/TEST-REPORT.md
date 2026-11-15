# 测试结果 · 0.1.0

日期：2026-11-15（Asia/Shanghai）。本报告区分离线行为测试、源码兼容检查与实际服务测试。

## 已完成

- **31 项自动测试通过，0 失败。** Node v24.20.0，`node --test tests/*.test.js`。
- **9 个参考源码组合检查通过**：lin-prefill-guard 实际 `planInjection` 的 observe/enhance/gemini4/gemini4-story 四模式 × 旧情绪前部说明的两种先后顺序，另检查 quiet 排除。enhance 分支验证实际发生规划，Gemini 模式按其原有适用条件执行；没有伪造真实服务商输出。
- `npm run check`：所有 JS 语法、manifest 入口、版本一致性、宿主危险写入 API 静态检查通过。
- 开发依赖仅 fake-indexeddb 与 happy-dom；安装时审计结果 0 漏洞。运行扩展无这些依赖。

| 测试组 | 实际覆盖 |
| --- | --- |
| P0 状态与分支 | 本人计时、他人不消耗、冻结、删除屏蔽、人工编辑保护、正文指纹、Swipe/重生成替换不双扣、独立存档/检查点复制、编辑回退、祖先修订逐级失效、戏外回复不计时 |
| P1 演化与检索 | 证据引用/当前权限校验、强化削弱修订消退、自我认知矛盾、冻结/禁用/人工管理保护、同证据换名防重建、禁止沉淀、NPC 授权、完整历史分批、旧情绪过期、中文关键词、向量维度检查、失败降级、模型/分支缓存隔离与实际向量排名 |
| P2 集成与恢复 | ENDED 先于 RENDERED、连续 Swipe/重生成/续写、停止后重载、quiet/dry-run/impersonate、旧异步结果丢弃、恢复取消不阻塞聊天、数据库错误安全跳过、单槽位和预算、范围过滤、旧情绪协作、备份原子导入、跨标签页修订竞争 |
| P2 界面 | 在 DOM 环境执行真实中文面板创建/冻结/删除/设置操作，文本不能执行 HTML；恢复弹窗四种选择 |

## 实机边界

曾在工作目录内创建隔离的官方 SillyTavern 1.19.0 临时实例。服务成功编译、识别本扩展目录并返回正确 manifest；页面到达首次启动欢迎界面。随后用户要求仅检查三个 Lin 插件的源码，已停止临时服务并停止实机联调。

**没有进入或修改用户原有 ST；没有验证真实模型输出、真实 Vertex Gemini 请求成功、或用户自己的插件配置组合。** 上述 31 项是代码/存储/宿主事件模拟与 DOM 测试，不冒充完整酒馆实机回归。

## 可复现

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run package
```

安装 ZIP 包含完整源码、测试、文档与 manifest，不包含 node_modules、临时 ST、个人聊天、API Key 或参考项目代码。

源码兼容检查所用参考版本与结论见 [COMPATIBILITY.md](COMPATIBILITY.md)。其独立脚本可以通过 `node scripts/compat-check.mjs /path/to/lin-prefill-guard /path/to/lin-emotional-control` 重跑，不需要 ST 或真实模型。
