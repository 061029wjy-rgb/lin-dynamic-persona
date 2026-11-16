# 可选：Lin 分析网关 0.5.0
主前端和纯本地人格不用这个包。服务端由你信任的管理员安装。普通 Tauri 前端不能加载 Node 服务端插件。

1. 将 `lin-persona-gateway/` 解压到 ST 根目录的 `plugins/` 内，目录下直接有 package.json。执行 `npm ci --omit=dev`（Node 20+）。在 ST 的 config.yaml 启用 `enableServerPlugins: true`，重启前完成后面配置。
2. 将 config.example.json 复制到不对外公开处，例如 /etc/lin-persona/slots.json；环境变量 LDP_GATEWAY_CONFIG 指向其绝对路径。示例模型文字需替换。每槽设置 kind、实际 model、授权的 ST 用户 handle 和日限额；keyEnv/headerEnv 只引用服务器环境变量名 LDP_...。目标由管理员固定。
3. Vertex 槽：填实际项目 ID、地域、模型 ID 与 v1 或 v1beta1。使用服务器工作负载身份或 ADC；如用服务账号文件，仅在服务端配置 GOOGLE_APPLICATION_CREDENTIALS，确保该身份有项目权限。网页不接收私钥。
4. 前端选相同协议、模型、槽名；Vertex 项目/地域/版本应一致。点无剧情测试（1 次）。路径 POST /api/plugins/lin-persona-gateway/analyze，使用 ST 用户认证和 CSRF 头。403 检查用户，409 检查两端配置。
5. 独立模式：`node remote.js` 默认只监听 127.0.0.1:8733，将可信 HTTPS 反向代理的 /analyze 转给它。origins 须为精确 Origin；clients 形如 {"player":"LDP_REMOTE_PLAYER"}，值指向至少 24 字符的独立随机登录令牌。将 player 加入槽 users。前端选独立 HTTPS 网关；只填网关令牌。不要公开代理、放行任意来源或记录请求体/认证头。手机 localhost 指手机。
6. 服务端日计数在进程重启时重置、实例间不共享；前端另有持久账本。生产多实例另设持久额度。Vertex 是否独立付费取决于实际项目与结算账号，不取决于插件的配置档名称。
真实 ST 已测试组件加载、同源转发和拒绝未授权槽；Google ADC/云端和 Tauri 远端部署待验。
