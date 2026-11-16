# 迁移、备份与回滚说明（v0.4 / v0.5 → v0.6.0）
1. **数据库与存储兼容性**：
   - `0.4.0` 使用 `lin-dynamic-persona-v4-<accountId>`；`0.5.0` 与 `0.6.0` 共享兼容的 `lin-dynamic-persona-v5-<accountId>`（`VERSION = 5`，向下兼容 `LEGACY_VERSIONS = [1, 2, 3, 4, 5]`）。
   - 从 `0.4.0` 升级至 `0.6.0` 时，首次打开会自动执行 `migrate4()`：先只读读取 v4 快照并校验结构，再在单个 IndexedDB 事务中将 `streams`、`nodes`（含全部 L1–L4 记录、手工冻结、证据屏蔽、修订历史）、`journal` 与已用配额账本复制到 v5 数据库，并将原 v4 快照保存在 `archives` 表（`key: 'migration4'`）备查，**原 v4 数据库保持只读不修改**。
   - 从 `0.5.0`（含 `handoff.1 / handoff.2 / handoff.3`）升级至 `0.6.0` 时，直接无缝沿用现有 `v5` 数据库中的 `streams`、`nodes`、`journal`、`terms` 与 `usage` 表：
     - 已采用的 L1–L4、手工管理记录、冻结状态、证据屏蔽（`blocks`）与认知修正历史（`cognitiveHistory`）100% 保留。
     - 旧库中若存在包含越权指令注入模板（如 `### System:`、`ignore previous instructions`）的记录，在 `0.6.0` 投影时会被 `inspectRecordSafety` 自动标记 `blocked_reason` 隔离待核，不会静默篡改用户已冻结的人格文本。
     - `usage` 表中的既有待发队列（`queue:<stream>:<actor>`）在 `restoreQueues()` 时自动升级补齐 `fencingToken`、`queueRevision`、`backpressure` 与 `failedBatch` 字段；若升级前存在 `sent: true` 且处于 `sending/received/validating` 的未决任务，自动转为 `failed_requires_review` 供用户核对，**绝不自动重发**。
2. **计费授权隔离原则**：
   - 无论从 `0.4.0` 还是导入外部备份升级，**绝不自动开启 `analysisEnabled` 或 `autoAnalyze`**；外部副 API 配置档导入后 `allowSend` 强制重置为 `false`，会话密钥不写入备份文件。
3. **跨设备迁移与增量备份**：
   - 在旧设备点击「导出完整备份」生成 JSON；在新设备导入聊天后点击「导入备份」，再从「采用备份快照」选择与当前聊天分支共同前缀匹配的快照。增量备份（`delta`）必须基于同一 `stream` 且精确匹配起始 `seq` 版本，绝不覆盖当前活动世界。
4. **安全回滚步骤**：
   - 若需从 `0.6.0` 回退至 `0.5.0 (handoff.3)`：直接用 `0.5.0` 扩展目录替换同名目录并刷新即可（底层同为 `v5` 库结构）。
   - 若需从 `0.6.0` 回退至 `0.4.0`：先在 `0.6.0` 面板导出完整备份 JSON 留存，再换回 `0.4.0` 同名扩展目录并刷新；`0.4.0` 会继续读取未被修改的原 `v4` 数据库（注：`0.4.0` 看不到升级至 `0.5/0.6` 期间新做的编辑，请勿将 `v5` 导出文件直接导入 `0.4.0`）。
5. **实测证据**：`docs/evidence/migration.json` 记录了 Chromium 原生 IndexedDB 从 `0.4.0` 迁移至新版的完整核验结果（冻结记录 `"登记交接条件"` 完好保留、累计次数保留、损坏旧库事务拒绝且新库写入数为 0）。
