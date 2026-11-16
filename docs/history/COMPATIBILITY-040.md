# Lin 与 SillyTavern 兼容性边界

固定核对基线为 SillyTavern 1.19.0 release 源码。manifest 使用真实 `generate_interceptor`，全局函数显式声明 `(chat, contextSize, abort, type)`。人格通过一个独立 `setExtensionPrompt` 槽位注入；禁用、停止或异常时清空，不修改 `chat` 数组、卡、世界书、预设、预填充和模型参数。

| 组合 | 处理 |
|---|---|
| Lin 2.8.2 预设 | 只作为正常主上下文存在；插件不解析、改写或复制预设条目 |
| Gemini 4 Argon/Carbon/Hydrogen 别名 | 可按模型作用域开关；别名不能证明真实上游型号 |
| lin-prefill-guard 1.3.0 | 使用不同键和提示阶段；不占用尾部 assistant/user 承接位置 |
| lin-emotional-control 1.2.0 | 默认配置级协作，避免重复抽签；不偷读闭包、不改 DOM、不猴补 fetch |
| quiet/tool/OOC/失败/停止 | 不扣 TTL、不学习、不触发递归分析 |

源码复放覆盖 3 种生成类型、3 个模型别名、system prompt 开关、两类 Lin 尾部和两种旧插件时序，共 72 种独立组合。它验证消息顺序与参数未被本插件改动，不等于真实 Vertex 请求成功。
