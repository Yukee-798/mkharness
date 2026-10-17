# Pi 1.3.0 修复与复审记录

## template 免费默认恢复：2026-10-17

用户确认免费模型仅用于 `template.mkharness.com` 对外展示。已在该 production Worker 恢复 `MODEL_PROVIDER=openrouter`、`MODEL_ID=openrouter/free`、`MODEL_THINKING_LEVEL=off`、`ALLOW_SERVER_MODEL_KEY=1`，并通过加密 Secret 配置 `MODEL_API_KEY`。当前线上版本 `4dc246e5-3a01-484a-80bf-cf1ba3edd1db`，流量 100%。此次仅修正部署配置，没有修改运行时代码或引入历史兼容路径。

本地和 test 环境仍为 `ALLOW_SERVER_MODEL_KEY=0`；远端 test 未配置该模型 Secret。宿主的现有凭据授权仅允许部署 Key 调用明确配置的 `openrouter/free`，限额或不可用时返回错误，不自动切换付费模型。个人 Key 继续独立使用。

验证：7 项 execution-models 单元回归与 10 项 OpenRouter/credentials Worker 回归通过，包含付费请求拒绝、免费限流终态及冷恢复不重放；typecheck、格式检查、生产构建和 dry-run 通过。用同一部署 Key 直连 `openrouter/free` 的真实请求返回 200，所选模型为 `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`，`usage.cost=0`。这项供应商调用验证与线上登录后的聊天验收分别记录，当前浏览器未登录。

正式域名的页面、鉴权、OAuth 初始化和 Chat 资源 SHA-256 冒烟检查再次通过；Cloudflare 远端绑定确认 production 为免费默认、test 为 BYOK。记录：`/tmp/mkharness-template-free-unit.log`、`/tmp/mkharness-template-free-workers.log`、`/tmp/mkharness-template-free-deploy.log`、`/tmp/mkharness-template-free-smoke.log`。

## 首次生产部署记录：2026-10-17

已按用户确认将 `https://template.mkharness.com` 切换到新 Worker `mkharness-native`，切换时版本为 `173c81d7-2fb9-4fcd-9757-93f6b612e19e`，流量比例 100%。正式环境关闭 workers.dev 和预览地址，仅使用此自定义域名。

新生产 D1 为 `mkharness-native`（`a063ea46-7733-492c-bd22-c95ff4493b6c`），仅应用 `0001_initial.sql`；R2 为私有桶 `mkharness-native-skills`；`ChatSession` 与 `McpConnection` 均使用新 namespace，已核对与旧部署不同。发布前账号、聊天、模型凭据、MCP 连接和 Skills 数量全部为 0，没有导入旧数据。会话签名和凭据加密使用两个新生成的独立密钥；Google OAuth 配置到新 Worker，仍使用原公开域名的回调地址。首次切换时为 account 模式与个人 Key 模式，`ALLOW_SERVER_MODEL_KEY=0`；template 展示用免费默认模型随后按上方记录恢复。

先在独立 workers.dev 地址完成页面、鉴权和静态资源检查，再切换正式域名。切换后重新验证：首页 200，bootstrap 为 account，未登录 session 为 null，聊天/模型设置/MCP/Skills 接口返回 401；线上 Chat JS 的 SHA-256 与本次生产构建一致。浏览器显示正常登录页。Google OAuth 初始化成功，provider 与回调 `https://template.mkharness.com/api/auth/callback/google` 正确；未完成真实账号登录、模型请求或 MCP/Skills 外部验收。

发布时重新生成 Wrangler 绑定类型，移除生成文件中残留的 ConversationAgent 类型引用；HMR 夹具改为声明自身的 HmrEnv，避免将应用 ChatSession stub 强转为夹具 stub。随后 typecheck、定向 lint/format、HMR、生产构建与 dry-run 通过。HMR 再次验证并发单 runtime、依赖更新重启、SQLite 保留和 client-only HMR。

发布日志：`/tmp/mkharness-native-production-deploy.log`；线上检查：`/tmp/mkharness-native-production-smoke.log`；HMR：`/tmp/mkharness-native-production-hmr.log`。下方保留提交 `55f499b` 之前各轮修复与审查的时间点证据，其中“未提交、推送或部署”描述的是相应记录当时的状态。

## 修复与复审范围

本轮范围：修复先前确认的 S1–S5、D1–D3 共 8 项；优先处理两个 P1，并在修复中补齐故障注入、冷启动和产品 Interface 回归。只使用 Pi 1.3.0 当前格式及公开接口，没有恢复旧运行时、增加历史兼容分支或执行数据迁移。

## 后续 P3 清理

前轮遗留的 5 类清理项，以及另列的 MCP 查询性能项均已处理：

| 项目               | 处理结果                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 未消费的宿主状态   | 删除 AdmissionReceipt.sequence、bindingKey、PendingAdmissions.sequence 和 ConversationControl.epoch；保留实际使用的绑定键计算函数及 ExecutionBinding 文档 |
| 冗余 locator 字段  | 当前建表定义与原子写入同时移除 task.kind、submission.request_id；原生 task/submission 记录继续提供权威事实                                                |
| 未使用类型         | 删除 ConversationCreation export                                                                                                                          |
| OAuth 冗余字段     | connectionId 保留为构造参数，移除没有读取的实例字段                                                                                                       |
| MCP 过宽 Interface | McpScope 只保留 ownerId/chatId，删除无消费者的 conversationId 和调用处的占位值                                                                            |
| 未结算 unsafe 查询 | 添加部分索引，仅覆盖 dispatching/unknown/responded；已确认 tombstone 不进入索引，继续保留幂等回执                                                         |

凭据相关测试不再读取仅供测试消费的 Admission bindingKey：在命令受理时通过原生 AgentDoc 定位绑定，冷恢复后按保存的原生 model ref 重新验证不可变绑定。没有把执行凭据元数据添加到浏览器可见 input，也没有为了保留旧断言增加生产字段。

新增 3 项 MCP 回归：每项加入 1,000 条 acknowledged 历史回执，检查真实 SQLite 查询计划使用部分索引；分别验证三种未结算状态在冷恢复后仍阻断新 unsafe 调用，并验证 responded 经过确认后可接受下一次调用。该证据验证索引选择及安全行为，不是线上规模或延迟基准。

本轮直接更新当前空环境格式，没有 ALTER/backfill、旧字段 fallback 或历史运行时逻辑；没有修改远端数据。

### P3 清理后的验证

| 验证                      | 结果                                                                 | 记录                                                                                                  |
| ------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 单元全量                  | 61 文件，258/258 通过                                                | `/tmp/mkharness-p3-unit.log`                                                                          |
| 原生 Storage/Runtime      | 6 文件，68/68 通过，包含两套 Storage conformance 与 locator 原子回滚 | `/tmp/mkharness-p3-native.log`                                                                        |
| MCP 专项                  | 43/43 通过，包含三种未结算状态的索引与冷恢复回归                     | `/tmp/mkharness-p3-mcp.log`                                                                           |
| Workers 全量              | 47 文件，279/279 通过                                                | `/tmp/mkharness-p3-workers.log`                                                                       |
| 浏览器全量                | 95/95 通过                                                           | `/tmp/mkharness-p3-e2e.log`                                                                           |
| lint / typecheck / format | 通过                                                                 | `/tmp/mkharness-p3-lint.log`、`/tmp/mkharness-p3-typecheck.log`、`/tmp/mkharness-p3-format-check.log` |
| 生产构建                  | 通过；与浏览器构建串行执行                                           | `/tmp/mkharness-p3-build.log`                                                                         |

以上为本轮 P3 清理后的验证，下面的前轮验证表仅保留历史证据。本轮未提交、推送或部署。

## 修复实现

| 原问题                 | 当前实现                                                                                                                                                  | 回归位置                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| S1 删除恢复            | local deleting 与 alarm 同事务持久化后再更新 D1；关闭 writer、完成外部确认义务后才擦除；清理后阻止延迟 alarm 重建数据                                     | `tests/workers/deletion-recovery.test.ts`、`auth.test.ts`                                       |
| S2 MCP 确认丢失        | native result 与 acknowledgement task 同事务；后台任务持久重试，Stop 原子交接；删除通过公开 Storage 读取当前调用身份，仅执行 cancel/known-result/ack 收尾 | `tests/workers/mcp.test.ts`、`mcp-connections.test.ts`                                          |
| S3 压缩后 Regenerate   | ReadContext 精确查询可见 answer、权威 done submission 和原 input；不用 active context 定位旧回复                                                          | `tests/workers/reply.test.ts`                                                                   |
| S4 fork 耗时缺失       | 可见 output 的 byTaskId 证明 generation 可见，允许其正常 `{}` input                                                                                       | `tests/workers/fork-history.test.ts`                                                            |
| S5 fork 混入未来终态   | 按 assistant entry、callId、原生 task 和 exact result entry 联合验证；截断前未可见的结果不能提供 endedAt                                                  | `tests/workers/fork-history.test.ts`                                                            |
| D1 Queue Edit 回执丢失 | 先复制完整草稿，再撤回原生 input；target + 原 runId 为稳定编辑身份。snapshot 可发现未领取回执；浏览器显式恢复后确认，或 24 小时过期；最多 32 份未领取草稿 | `tests/workers/queue-edit-recovery.test.ts`、`tests/e2e/task-queue.spec.ts`                     |
| D2 压缩绕过预算        | 原生 input 固定持久 execution scope；native TaskId 预留去重，模型/工具累计不会因压缩、重试或恢复清零                                                      | `tests/unit/limits.test.ts`、`tests/native/policy.test.ts`                                      |
| D3 child/fork 策略缺口 | 同创建事务写收缩 policy；共享 scope、模型/工具/深度/总数/并发限制；旧后台 owner 固定旧授权；task-owned child 对外返回 404                                 | `tests/native/policy.test.ts`、`tests/workers/native-controls.test.ts`、`policy-budget.test.ts` |

## 修复后的独立复审

工程实现与方案符合性分别复审，并复现、继续修复了三个交互遗漏：

- 服务端 Edit 回执可重试，但刷新后原内存失败状态消失。新增只读回执发现和显式恢复入口，已有 composer 内容受到保护。
- 排队命令合法变更模型后，新策略曾误拒当前执行的下一步。根配置授权与 input 预算分离；后续尚未 prepare 的步骤可使用已授权配置，子会话仍保持收缩权限。
- 远端 MCP 已 responded、但调用任务尚未提交原生结果时，直接关闭 runtime 会漏掉 acknowledgement task。当前调用 input 持久保存完整目标身份；冷删除直接根据当前任务记录收尾，不需要恢复 Harness 或重放远程操作。已断开的用户连接也允许结束其旧 operation。

此外，对外无权访问 task-owned child 的错误统一为 404，符合方案契约。上述复审发现都纳入同轮修复和回归。

### 工程轴最终结论

未发现尚未处理的确定性 P1/P2。QueueEditTransfers 封装草稿转交与确认，原生 Inbox 保持唯一可执行队列；ReadModel/浏览器只负责投影和交互。删除在唯一 writer 关闭后收尾当前 MCP 记录，再执行擦除；RootModelGrant 不改变旧任务的固定作用域。删除/MCP 提交间隙、刷新后的草稿发现两项复审发现均已修复。

### 方案轴最终结论

未发现新的确定性 P1/P2，也未发现需要单列的范围扩张。原模型切换复现脚本原样重跑，A/B 均为 done；外部 child 目标统一 404；Edit 形成保存、重取、发现、显式恢复、确认与到期清理闭环。历史定位和分支事实保持精确原生关系，没有全历史兼容扫描。模型切换和 404 契约两项复审发现均已处理。

两轴均检查了前轮 8 项修复，结论范围是当时源码、故障注入与自动化回归，不代表不存在其他缺陷。原审查中的 P3 小残留和连接索引建议随后也已处理，详见上方 P3 清理记录；下方保留修复前证据。

## 前轮 8 项修复验证

| 验证                      | 结果                                                             | 记录                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 单元                      | 61 文件全量 257/257 通过；追加 fork 回归后 limits 14/14 通过     | `/tmp/mkharness-fix-unit-final.log`、`/tmp/mkharness-fix-limits-final.log`                                           |
| 原生 Storage/Runtime      | 6 文件，68/68 通过                                               | `/tmp/mkharness-fix-native-final.log`                                                                                |
| Workers 全量              | 47 文件，276/276 通过                                            | `/tmp/mkharness-fix-workers-final.log`                                                                               |
| 浏览器全量                | 95/95 通过                                                       | `/tmp/mkharness-fix-e2e-final.log`                                                                                   |
| MCP 专项                  | 40/40 通过，包含删除提交间隙和 unknown unsafe 保护               | `/tmp/mkharness-delete-ack-fixed.log`                                                                                |
| lint / typecheck / format | 通过                                                             | `/tmp/mkharness-fix-lint-final.log`、`/tmp/mkharness-fix-typecheck-final.log`、`/tmp/mkharness-fix-format-final.log` |
| 生产构建                  | 通过                                                             | `/tmp/mkharness-fix-build.log`                                                                                       |
| HMR                       | 并发仅一个 runtime；依赖重启、SQLite 保留及 client-only HMR 通过 | `/tmp/mkharness-fix-hmr.log`                                                                                         |

完整验证过程中修正了两项测试问题，未通过放宽生产检查掩盖失败：BYOK 后台压缩 fixture 补齐当前 Pi 的 `LiveDoc.compactions` 记录，保留旧凭据、旧预算 scope 和冷恢复去重断言；浏览器首屏产品态断言增加到 10 秒语义等待，保留内容与刷新断言。一次独立浏览器补跑被并行正常构建覆盖共享 Wrangler 预览配置，造成 Not Found，已通过串行重建预览排除；随后完整 95 项通过。

本轮尚未提交、推送或部署；既有 `mkharness-native-test` 仍对应此前部署版本。本轮没有重新配置远端账号、模型密钥、MCP OAuth 或 Skills，也没有把本地 fixture 结果表述为真实供应商验收。

---

## 修复前的审查证据

日期：2026-10-17。范围：基线 `300eefb69d8438b63b5451936b9cd97609964c28` 至当前未提交工作区，包含新增文件。基线与 HEAD 当前相同，因此不能只用提交之间的 diff 代替本次审查。

初次审查结论：**发现 2 项 P1、5 项 P2 行为问题，以及 1 项 P2 方案缺口。** 下述内容保留修复前的触发条件与复现证据，并不表示这些缺陷仍存在于当前实现。

本轮按 codebase-design 检查 Module/Interface/Seam/Adapter、Locality 和状态权威，并按 code-review 分别审查工程实现和方案符合性。未修改生产代码，未提交、推送、重新部署或修改远程数据。

## 工程实现审查：5 项

### S1 · P1：删除失败后可能永久停在 deleting，内容没有被擦除

位置：[session-object.ts:849](/Users/yukee-798/Downloads/agent-generative-ui/src/server/chat/session-object.ts:849)。

当前顺序是更新 D1 lifecycle → 写本地 deleting → 设置 alarm。对没有既有 alarm 的冷、空闲 ChatSession，D1 成功后，本地标记或 alarm 写入失败，再发生 eviction，就会出现：目录已隐藏聊天、后续读取返回 404、私有内容仍在，但没有未来唤醒负责清理。用户列表中也没有可重试删除的入口。

已实际注入两种故障并复现：D1 为 deleting；重建 DO 后 `getAlarm() === null`；私有标记仍存在。现有 interrupted-delete 用例依靠再次 DELETE 才恢复，没有证明自动清理。

修复方向：在跨 D1 副作用之前，持久记录可恢复的删除意图和唤醒；明确提前到达的 alarm 如何完成 D1 状态推进与清理。以删除每一步后崩溃的矩阵验证，不只验证显式重试。

证据：[2 个复现用例日志](/tmp/mkharness-review-delete-gap.log)，[源码](/tmp/mkharness-review-delete-gap.test.ts)。

### S2 · P1：MCP 成功结果的确认 RPC 丢失，会让连接一直 busy

位置：[deployment.ts:204](/Users/yukee-798/Downloads/agent-generative-ui/src/server/mcp/deployment.ts:204)、[user MCP:235](/Users/yukee-798/Downloads/agent-generative-ui/src/extensions/mcp/server.ts:235)、[connection.ts:538](/Users/yukee-798/Downloads/agent-generative-ui/src/server/mcp/connections/connection.ts:538)。

远程调用结果先提交到原生 child task，再 acknowledge 连接 DO，这个顺序正确。但 acknowledge 失败被 catch 忽略，外层工具继续完成，没有持久待确认意图和重试路径。连接 DO 的 responded unsafe receipt 会持续挡住新的 unsafe 调用。

已通过生产 buildMcp、原生 Harness 和真实 McpConnection fixture 复现：第一次调用成功、原生任务结束；确认 RPC 在送达前失败；receipt 停在 responded；另一聊天的新调用返回 `mcp_connection_busy`，远程只执行一次。用户管理的 MCP 包含相同的吞错路径。

修复方向：把结果与待确认阶段持久化到原生 task/checkpoint 或宿主当前格式文档，通过恢复/alarm 重试幂等 acknowledge，成功后再清理。应继续禁止重放原 unsafe 调用，不能用超时自动解除保护代替确认协议。

证据：[复现日志](/tmp/mkharness-review-mcp-ack.log)，[源码](/tmp/mkharness-review-mcp-ack.test.ts)。

### S3 · P2：历史回复在 compaction 后仍可见，但无法重新生成

位置：[session-object.ts:887](/Users/yukee-798/Downloads/agent-generative-ui/src/server/chat/session-object.ts:887)、[reply/server.ts:91](/Users/yukee-798/Downloads/agent-generative-ui/src/extensions/reply/server.ts:91)。

新的 ReadContext.entries 返回 native active context。Regenerate 的 Implementation 仍用这个 Interface 查找历史 assistant 和前置 input。成功 compaction 后，旧条目退出 active context，但仍可通过产品历史读取，按钮也仍展示，点击得到 `reply_not_found`。

已用真实原生成功 compaction 复现：snapshot 包含原回复；active context 不含原 input/answer；生产 submitRun 的 regenerate 返回 404。

修复方向：提供精确、经过 target 可见性校验的 answer→accepted input 查询，让 Regenerate 通过这个 Interface 定位来源。不要恢复全历史扫描。

证据：[复现日志](/tmp/mkharness-review-regenerate-history.log)，[源码](/tmp/mkharness-review-regenerate-history.test.ts)。

### S4 · P2：fork 继承的正常回复丢失耗时 annotation

位置：[facts-index.ts:81](/Users/yukee-798/Downloads/agent-generative-ui/src/server/chat/facts-index.ts:81)。

祖先 task 的过滤只接受带 input.assistant 和 input.callId 的工具任务。GenerationInput 不含这两个字段，因此可见 answer.byTaskId 指向的 generation receipt 被过滤。fork 正常显示继承的回复，但 timing 无法找到其执行回执，耗时消失。

已复现父 snapshot 有 timing、fork snapshot 中同一 answer 的 timing 不存在。

修复方向：通过可见输出 entry 的精确 byTaskId 关系接纳对应 generation，仍然过滤 fork 截断点以后的任务事实。

证据：[两个 fork 用例日志](/tmp/mkharness-review-fork-facts.log)，[源码](/tmp/mkharness-review-fork-facts.test.ts)。

### S5 · P2：复用 tool callId 时，fork 会引入截断点以后的终态事实

位置：[facts-index.ts:43](/Users/yukee-798/Downloads/agent-generative-ui/src/server/chat/facts-index.ts:43)、[facts-index.ts:94](/Users/yukee-798/Downloads/agent-generative-ui/src/server/chat/facts-index.ts:94)。

results 只记录 callId，没有关联 assistant round。供应商在两轮中复用 callId 时，第一轮已可见的结果会被用来证明第二轮任务也已完成。

已复现：在第二轮工具结果之前 fork，随后父分支完成；fork 的第二轮工具仍为 pending，timing 却包含父分支后来写入的 endedAt。读取混入了 fork 截断点以后的状态。

修复方向：用精确 assistant entry + callId + 对应结果/任务关系证明可见性，不能只按 callId 判断。S4/S5 都应保留独立回归断言，避免修好一侧又放宽另一侧。

当前没有分支管理 UI，S4/S5 主要影响已承诺的原生 fork 接入和其读取 Interface，优先级低于普通聊天路径中的恢复问题。

## 方案符合性审查：3 项

### D1 · P2：Queue Edit 丢回执后，草稿无法再次获取

位置：[session-object.ts:652](/Users/yukee-798/Downloads/agent-generative-ui/src/server/chat/session-object.ts:652)、[session-object.ts:675](/Users/yukee-798/Downloads/agent-generative-ui/src/server/chat/session-object.ts:675)。

方案第 183 行要求所有写命令有稳定 requestId，相同 ID/payload 返回原回执。当前 Edit 先 abort 原生 queued input、清理 Admission payload，再把完整 draft 放在一次 HTTP 响应中。响应丢失后，同一个 runId 再 Edit 返回 request_withdrawn；队列、Inbox、Admission 和原生历史都没有可恢复的草稿。

生产 command/read 复现确认：第一次结果有 draft（模拟丢弃）；重试没有 draft；队列空、receipt 无 entry、pendingInput 已清除。前端失败时只刷新队列，尚未把 draft 放入 composer。

修复方向：为编辑操作分配稳定命令身份，保存可重复读取的草稿回执，并定义明确的确认/清理周期。只给 remove 做幂等无法保护 Edit。

证据：[复现日志](/tmp/mkharness-review-edit-receipt.log)，[源码](/tmp/mkharness-review-edit-receipt.test.ts)。

### D2 · P2：Compaction 使同一轮执行的轮次和工具预算重新计数

位置：[limits.ts:18](/Users/yukee-798/Downloads/agent-generative-ui/src/server/limits.ts:18)、[limits.ts:58](/Users/yukee-798/Downloads/agent-generative-ui/src/server/limits.ts:58)、[limits.ts:106](/Users/yukee-798/Downloads/agent-generative-ui/src/server/limits.ts:106)。

当前限制依赖 conversation.context 的 entries，而不是持久的执行身份与累计事实。压缩会移除旧 assistant/toolResult，检查随之忘记已消耗的预算，违反方案第 290 行的 root execution scope 预算要求。

实际安装的 Pi 1.3.0 公开 Harness + MemoryStorage 与生产 checkRunLimits 复现：同一 app.input 后先 19 个 assistant round，执行成功 compaction，再追加 2 个 round；完整历史累计 21，active context 只有 3，检查仍允许继续。自动 compaction 使用相同的 active context 语义。

修复方向：按原生运行/根作用域持久累计预算，并在授权检查时使用；压缩和子会话创建不应重置累计值。加入压缩前后边界，以及没有新用户输入时的工具预算用例。

证据：[原生 compaction 复现记录](/tmp/mkharness-review-compaction-budget.log)，[可重跑源码](/tmp/mkharness-review-compaction-budget.mjs)。

### D3 · P2：Fork/child 的权限收缩与共享预算仍是方案缺口

位置：[runtime.ts:55](/Users/yukee-798/Downloads/agent-generative-ui/src/server/chat/runtime.ts:55)、[session-object.ts:348](/Users/yukee-798/Downloads/agent-generative-ui/src/server/chat/session-object.ts:348)。

方案第 286–290 行要求创建事务写入缩小后的 ConversationPolicy，限制整个 root scope 的轮次、工具、深度、总量和并发。当前 creation hook 只写 ModelTarget，target 只检查数字和会话存在，没有这些策略和资源限制。

公开原生 fixture 确认 child/fork 继承父 model/thinking；父预算已耗尽时，新 child 检查仍获准。

当前生产源码没有创建 child/fork 的产品入口，所以这属于未完成的设计与 fixture 验收要求，不能表述为已存在可直接利用的外部越权漏洞。应补齐策略与共享预算，或者先显式收窄本次交付范围，避免把原生可创建等同于产品授权已完成。

证据：[child/fork 复现记录](/tmp/mkharness-review-child-budget.log)，[可重跑源码](/tmp/mkharness-review-child-budget.mjs)。

## Module 与残留清理判断

- ChatRuntime、ChatResources、ChatDirectory、storage/facts、ReadModel/SSE 的拆分有实际 Depth 和 Locality；没有必要单凭 ChatSession 约一千行继续机械切文件。
- ReadContext.entries 的含义变化使 S3 暴露：调用者需要的是历史定位，Interface 却交付活动执行上下文。应该把这两种语义显式分开。
- command/read/observe 外部 Interface 足够小；写命令的持久回执和恢复顺序尚未统一。应先修正具体状态转换，再决定哪些内部知识需要集中到 Commands Module。
- MCP 的传输与授权已聚合到独立连接 DO。后续可把 intent/result/ack/cancel 的共同状态转换集中到内部 DispatchReceipts Module，由 user/deployment 两个实际 Adapter 共用；S2 说明单纯共用 dispatch 还没有封装完整确认协议。
- 未发现旧 Agent/PiHarness 聊天执行入口、旧协议 fallback 或启动回填被重新保留。Agents SDK 仍用于独立 MCP 传输/OAuth，有实际用途。

修复前确认的 P3 小残留（现已全部清理）：

| 位置                                    | 残留                                                                                                                             | 建议                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `src/server/chat/documents.ts`          | AdmissionReceipt.sequence/bindingKey 仅保存；PendingAdmissions.sequence 仅为这个未消费序号递增；ConversationControl.epoch 仅自增 | 删除无消费者状态，避免让维护者误以为存在排序/fencing 保证 |
| `src/server/chat/storage.ts`            | locator 的 task.kind、submission.request_id 仅写入，无产品查询消费者                                                             | 移除无用列与写放大；当前空环境无需兼容迁移                |
| `src/shared/contracts.ts:74`            | ConversationCreation 没有引用                                                                                                    | 删除未使用 export                                         |
| `src/server/mcp/connections/oauth.ts:9` | connectionId 被声明为字段，但只在构造参数作用域使用                                                                              | 保留参数，去掉无用字段                                    |
| `src/server/mcp/deployment.ts:28`       | McpScope.conversationId 没有消费者                                                                                               | 收紧 Interface，实际 target 已来自原生 task/tool context  |

修复前另一个低优先级性能点：mcp_dispatch 只有 id 主键索引，outstanding 查询扫描全表。现已加入未结算 unsafe receipt 部分索引，并通过三种状态和 1,000 条历史回执验证查询计划；未进行实际线上规模基准。此项不计入前轮 8 项。

## 验证和验收限制

本轮新增的临时 focused 用例共 **7 个**，分别是删除 2、fork 2、Regenerate 1、MCP ack 1、Queue Edit 1，均通过断言证明缺陷存在。另有 2 个公开 Pi 的直接复现，分别证明 compaction 预算和 child/fork 策略缺口。它们不是“修复后测试通过”。临时测试退出工作区，源码与日志保存在上述 `/tmp` 路径。

只进行了定向审查/故障注入，没有重复运行前一轮整个单元、Worker、浏览器和部署流程；没有新的产品源码变更。真实 BYOK、Google 登录、远端 MCP OAuth/外部副作用、Skill 激活和模型生成 OpenUI 的新环境验收仍按先前记录等待重新配置，这些外部验收缺口与本轮已复现的代码问题分别记录。

建议修复顺序：S1 删除恢复和 S2 MCP 确认协议 → Queue Edit、compaction 预算与 Regenerate → S4/S5 分支投影 → child/fork 策略与共享额度 → P3 残留清理。修复过程中保留本轮每个触发条件，通过相同产品 Interface 做回归。

两轴统计：工程实现 **5 项，最严重为 P1 删除恢复/MCP 确认**；方案符合性 **3 项，最严重为 P2 草稿回执/预算/child 策略缺口**。未发现需单列的范围扩张。
