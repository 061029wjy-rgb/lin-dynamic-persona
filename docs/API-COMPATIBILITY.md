# 分析 API 兼容表
核对日期：2026-11-16。运行入口：src/providers.js（前端协议）、src/service.js（隔离/费用）、server/lin-persona-gateway（可选服务端）。表中“HTTP 测试”指通过实际 TCP 向本机测试接收器收发，不能据此声称已连通云厂商。

|来源|目的地及鉴权|响应、错误与当前验证|
|---|---|---|
|ST 当前模型|getContext().generateRaw({prompt,systemPrompt,jsonSchema?})，沿用已有连接|独立额外请求。原始接口未返回 usage/finish 时标未知。不接管主生成停止键，底层结束前不使用相同分析锁并发。宿主契约测试；实际 ST 前后端负责主聊天的系统提示已观察。|
|OpenAI Chat / 自填兼容|base 后接 /chat/completions 或原样使用完整 endpoint；Bearer。OpenAI 用 max_completion_tokens，自定义用 max_tokens。|choices[0].message.content，usage；拒收工具、拒答、length。HTTP 测试通过；自填兼容另用本地 Qwen2.5-1.5B-Instruct 真推理采样并完成离线重放诊断。未测 OpenAI 付费账号。|
|DeepSeek|https://api.deepseek.com/v1/chat/completions；Bearer|Chat 协议。仅可见 content，不把 reasoning_content 送入剧情。HTTP 测试；云端未测。|
|OpenRouter|https://openrouter.ai/api/v1/chat/completions；Bearer|默认单一 provider.only 与 allow_fallbacks=false，要求明确模型及供应商。记录上游提供的 model/provider/cost；返回缺省则未知。HTTP 测试；真实路由、账单未测。|
|Gemini AI Studio|generativelanguage.googleapis.com/{version}/models/{model}:generateContent；x-goog-api-key|contents、systemInstruction、generationConfig；只读非 thought 的文本，需 STOP。区分拒绝、无候选、截断。HTTP 测试；真实账号未测。|
|Vertex Gemini 原生|{region}-aiplatform.googleapis.com/{version}/projects/{project}/locations/{region}/publishers/google/models/{model}:generateContent；global 使用无前缀主机。网关端 ADC OAuth Bearer。|不会向浏览器传私钥。HTTP 路径、替代令牌签发器、权限、跨重启持久原子日配额（`stateFile`）和真实 ST 网关已测；没有 Google 项目测试身份，未测真实 IAM、自动刷新、费用和渠道别名。|
|Claude Messages|https://api.anthropic.com/v1/messages；x-api-key、anthropic-version（默认 2023-06-01）|system 单独字段、content 文本 blocks、usage 与 stop_reason。原生 Messages 不套 Chat 格式；本构建不用 Claude 原生 JSON Schema。HTTP 测试；云端未测。|
|Ollama 原生|默认 http://localhost:11434/api/chat；可选认证|messages / options.num_predict / format；读取 message.content、done、eval_count。HTTP 测试；未以真实 Ollama daemon 验收。已测的 Qwen 是 llama.cpp 兼容 HTTP 服务，并非 Ollama。|
|OpenAI Responses|未实现|不能把 /v1/responses 填入兼容档冒充支持。|

所有已实现 HTTP 协议均测试 401/403/404/429/5xx、空文本/截断或安全结束、usage 缺失。另测取消、无效 JSON、单档暂停、多标签页同档在途原子互斥、地址模式、不自动回退、服务端固定目标及持久日配额。对于仅返回字符串的 ST generateRaw，无法直接获知云端结束原因。原生 Schema 是模型能力；无剧情测试可显式探测。请求提交后无自动二次计费重试；当兼容端点或服务商在 `schema` 模式下返回 HTTP 400 时，系统会自动将该配置档下次请求的 JSON 策略降级为普通 JSON 文本校验，并在错误摘要中明确说明，本次绝不自动补发第二次请求。

参考官方协议：[SillyTavern 前端](https://docs.sillytavern.app/for-contributors/writing-extensions/) · [服务端插件](https://docs.sillytavern.app/for-contributors/server-plugins/) · [ST release 源码](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions.js) · [OpenAI Chat](https://developers.openai.com/api/reference/resources/chat) · [Google generateContent](https://ai.google.dev/api/generate-content) · [Vertex](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference) · [ADC](https://cloud.google.com/docs/authentication/application-default-credentials) · [Anthropic Messages](https://platform.claude.com/docs/en/api/messages) · [OpenRouter 路由](https://openrouter.ai/docs/features/provider-routing) · [Ollama chat](https://docs.ollama.com/api/chat) · [DeepSeek](https://api-docs.deepseek.com/api/create-chat-completion/)。未使用真实用户凭证。各模型和端点可能随供应商变化。
