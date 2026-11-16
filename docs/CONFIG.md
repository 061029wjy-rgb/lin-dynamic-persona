# 配置速查
|范围|字段|默认与意义|
|---|---|---|
|主生成|enabled / inject / immediate|开启；控制扩展、人格注入、即时感受。不调整主模型输出上限。|
|成本|analysisEnabled / autoAnalyze|均关闭。使用既有人格时无需开启。|
|审批|approval|新装 conservative；老账户迁移 manual。auto 由用户显式选择，独立于是否发请求。|
|协作|conflictMode / expressive|默认共存、独立随机抽样关；仅成长不抽；旧插件运行时不会双抽。|
|注入|promptBudget|默认 700 tokens；酒馆分词不可用或超时则以 UTF-8 字节保守限量。|
|调度|minTurns / batchSize / analysisBudgetMaxRequests|9 次本人保存回复 / 14 个原文片段 / 一次手动批量最多 2 请求。片段不是消息楼数。|
|总账|analysisMaxTotalRequests / dailyLimit / sessionLimit|默认累计 20、UTC 日 3、本页会话 3。0 表示禁止，失败计数。|
|恢复|recoveryPopup|默认关闭。关闭弹窗不绕过快照检查。|
|配置档|activeProfile / reviewProfile|日常使用一档；指定复核档后，只在手动点第二意见时派发。|
|协议|kind / transport / urlMode / model|原生或 Chat；ST、服务端槽、可信 HTTPS 远端或会话直连；区分 base 和完整 endpoint；不猜型号。|
|目的地|serverId / gateway / project / region / apiVersion / pin / fallback|管理员槽标识、远端根地址、Vertex 项目地域、API 版本、OpenRouter 固定供应商；默认无回退。|
|隐私|allowSend / sendBaseline / allowLAN|外部服务明确授权；卡片节选默认关。局域网 HTTP 须显式允许；直连凭证不持久化。|
|单档请求|input / output / timeout / interval|普通新档 12000 UTF-8 字节、2100 输出 tokens、45 秒、15 秒；内置 ST 档输入 20000、无间隔。ST 输出沿用宿主。|
|单档配额|daily / total / sessionLimit / actorLimit|普通新档 8/80/8/8；角色上限按 UTC 日，总账上限同时生效。|
|合同|contract / json|完整演化或精简即时感受；普通 JSON / 原生 JSON / Schema。能力取决于具体模型。|
|分档状态|enabled / cooldowns|可停用、删除。401/402/403 暂停该档；429 暂时冷却，不重发。|
|可选手工字段|shareVariables|默认关，仅玩家逐项授权的备注。无需卡片或世界书变量。|
输入估算不等于账单。渠道的缓存、思考和文本 token 口径不同；没有 usage 时为未知。直连密钥在浏览器内存和请求中可见；刷新即失效。
