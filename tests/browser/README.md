# 可选浏览器验证：仅在自己的隔离测试酒馆运行
前端单元测试不需要 Playwright。此处使用 Playwright 与本地 Chromium；可通过 PLAYWRIGHT_MODULE、CHROMIUM_PATH 或 CHROMIUM_MODULE 指定已安装模块。测试在 localhost:18765 使用受控 ST 1.19.0，脚本从源码根目录运行、证据写 docs/evidence/。不要把它们指向日常聊天。
- host-e2e.cjs：需有默认 Seraphina，已走完首次引导。安装当前扩展，需共存验证时同时安装旧两扩展；主后端设置为 custom、非流式。本脚本建立临时 QA 聊天，本机 18768 接收/固定回复；比对面板与实际主请求，关闭后再验证。没有购买模型调用。
- gw-browser.cjs：先将 server/lin-persona-gateway 安装为测试宿主的服务端插件、启用；在服务端配置一个 slot 名 fixture，kind compat、model wire-test、url http://127.0.0.1:18769/v1、allowLAN true、授权 default-user。keyEnv=LDP_QA_TOKEN，进程环境中设为字面值 fixture-only（虚构测试标志，不是供应商密钥）；程序验证授权转发与无权槽。
- migration-browser.cjs：在该测试宿主的 public/qa-original-persona/src/ 临时提供未改动 v0.4.0 的 src/，而非安装为另一活跃扩展。脚本在独立浏览器上下文中创建 v4 数据并用 v5 读取，再演示坏数据拒绝。
- perf-browser.cjs：原生 IndexedDB、十人合成对话、Chromium CDP 4× 节流；不需要模型。运行前后将测试结果分别留存。
上述脚本的可选浏览器工具不是扩展安装依赖。仓库内不附浏览器、模型权重、用户资料、测试宿主数据目录或身份凭证。
