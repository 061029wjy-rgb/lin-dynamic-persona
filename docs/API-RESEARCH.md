# SillyTavern 接口与参考源码核对

核对日期：2026-11-15（Asia/Shanghai）。只将已经读取的官方源码作为接口依据。

## 固定基线

- SillyTavern release：`06bde939fb1e9c4c8d8641d810f0a916b5bce127`，`package.json` 版本 1.19.0。
- 参考情绪扩展：`061029wjy-rgb/lin-emotional-control`，`479e942f7af61d3ecbd9bbe45294f64120d1eff5`，manifest 1.2.0。
- 官方 [扩展文档](https://docs.sillytavern.app/for-contributors/writing-extensions/)。

## 已核对入口

| 来源 | 核对结果 | 本扩展决策 |
| --- | --- | --- |
| [`st-context.js`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/st-context.js) | 暴露 `eventSource`、`eventTypes`、`setExtensionPrompt`、`generateRaw`、`getTokenCountAsync`、`extensionSettings`、`chatMetadata` | 通过 `SillyTavern.getContext()` 获取；不依赖相对导入 ST 内部模块 |
| [`script.js`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js) `Generate` | STARTED 在命令处理前，AFTER_COMMANDS 在用户消息最终加入前；interceptor 位于核心历史构建后、提示组装前 | 用 STARTED 记录生成类型，用 manifest interceptor 读实际当前 chat；不用 AFTER_COMMANDS 猜新消息 |
| 同文件 `finalizeIntermediaryMessage` | 流式 UI 解锁可能先发 ENDED，再 RECEIVED、CHARACTER_MESSAGE_RENDERED，之后 saveChat | ENDED 不直接计时；保留事务，等待最终渲染正文；停止与工具调用不计数 |
| 同文件 `setExtensionPrompt` | 位置 0 = IN_PROMPT，role 0 = SYSTEM，scan 可关 | 一个固定 KEY 槽位、故事/系统区域、不扫世界书，不动最终 JSON 或消息尾部 |
| 同文件 `generateRawData` | quiet 请求；可选 responseLength 会经过临时全局参数；内部 AbortController 不暴露外部 signal | 不传 responseLength/prefill/schema，主生成与后台分析分离；取消后丢弃结果，外部接口模式可主动 abort |
| 同文件 `saveChat`/`saveChatConditional` | 部分保存错误内部捕获，返回值不能可靠确认服务端落盘 | 明确记录限制；按本地选中且最终渲染的有效回复维护可恢复快照，不假称获得 durable-save 事件 |
| [`events.js`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/events.js) | CHAT_CHANGED 实际字符串 `chat_id_changed`，CHAT_LOADED 为 `chatLoaded`；没有统一 QUICK_RESTORE | 取 eventTypes，检测恢复后正文指纹，未知恢复入口在下次生成前仍有防护 |
| [`bookmarks.js`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/bookmarks.js) | branch/checkpoint 创建新 integrity，saveChat 合并原 metadata 并截断所选正文 | 元数据携带源存档标记；新 owner 隔离复制共同前缀的快照，忽略源 head 的未来内容 |
| [`group-chats.js`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/group-chats.js) | 每位成员 Generate 前设 characterId 并发 GROUP_MEMBER_DRAFTED；消息记录 original_avatar；群聊重生成使用 normal | 以 avatar 识别与正文前缀计数，不依赖 regenerate 类型判断群聊回退 |

## 旧插件审查

已实际读取 manifest、README、index、controller、engine、history/access 相关结构。参考源码链接：

- [controller.js](https://github.com/061029wjy-rgb/lin-emotional-control/blob/479e942f7af61d3ecbd9bbe45294f64120d1eff5/controller.js)
- [engine.js](https://github.com/061029wjy-rgb/lin-emotional-control/blob/479e942f7af61d3ecbd9bbe45294f64120d1eff5/engine.js)
- [index.js](https://github.com/061029wjy-rgb/lin-emotional-control/blob/479e942f7af61d3ecbd9bbe45294f64120d1eff5/index.js)

旧插件的运行标记是 `Symbol.for('human-temper.extension.1')`，设置键 `human_temper_v1`。它在 `CHAT_COMPLETION_SETTINGS_READY` 中修改已组装的 messages，自行做一次抽样，以自有 history 管理情绪。没有供别的插件调用的同步协议。因此协作策略是明确分配层级，不访问或写入其私有数据、不猴子补丁全局 fetch、不复制其抽签表。

## 未宣称验证的事项

- 没有接入付费/真实 Vertex Gemini、Claude 或 OpenAI 模型生成；通过参数不变和请求路径测试只能证明本插件没有主动改写这些参数。
- 无法保证未知第三方插件自己不篡改提示或事件顺序。可切换冲突策略，并安全停用本插件。
- 角色的认知边界还依赖剧情视角与模型判断；程序验证的是授权消息、逐字引文、分支来源，不是人类语言的完美语义理解。
