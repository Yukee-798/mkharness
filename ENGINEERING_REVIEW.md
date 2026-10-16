# 工程审查与优化实施记录

日期：2026-10-16。范围包含整个源码目录、扩展装配、HTTP/DO 调用链、浏览器会话、存储恢复、测试与构建。以下实现位于本地工作区；本轮未提交、推送或部署，也不代表真实模型/OAuth/MCP 服务验收。

## 已完成的修复与职责归并

| 优先级 | 问题与影响                                                                           | 实施结果                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1     | Skill 发布已提交但确认丢失时，异常清理可能删除已发布版本引用的 R2 文件。             | 删除前核对不可变版本引用；核对失败保留文件。真实 D1/R2 回归覆盖确认丢失。                                                                              |
| P2     | 扩展初始化的 rejected Promise 被长期缓存。                                           | 失败后释放缓存；成功和并发调用继续共享。                                                                                                               |
| P2     | 队列动作在 schema 校验前缓冲无限长请求体。                                           | 统一通过限长读取，最大 1 KiB；超限不调用 DO。                                                                                                          |
| P2     | MCP factory 丢失传入配置，重新读取全局 `custom`。                                    | 解析配置贯穿装配；`custom: false` 不读取用户连接。为已有 `custom`、`inspect` 布尔选项补充类型和运行时校验。                                            |
| P2     | 展示代码与 runtime 共同掌握恢复 revision、queue epoch、活动 run 过滤和重新附着协议。 | 聚合为 `browser/chat/session/`，由 `useConversationSession` 提供视图与动作。HTTP/SSE 载荷共享契约，网络 Adapter 解码；测试可注入内存远端。             |
| P2     | 快照和观察分别组合事实、投影、watch、结束竞争与清理。                                | `ConversationReadModel` 统一读取生命周期；`observe.ts` 负责 SSE 转换，不再依赖整个 Agent。移除已无生产消费者的 `progressProjector()`。                 |
| P2     | 浏览器首次打开拉完全部分页；扩展投影和冷启动反复读取完整历史/输入。                  | 新客户端使用最近窗口、顶部渐进加载和窗口 SSE 合并；task/submission 派生定位索引与紧凑执行绑定降低重复读取，保留原始 receipt。                          |
| P2     | OpenUI 的输入 epoch、计算 provenance、写入限制散落于上下文和组件。                   | `PanelSession` 集中持有协议；StateSync 只保留绑定身份，三次自动写入限制仍按绑定及用户编辑链计算。旧计算迟到的结果被丢弃；相同输入保留 Query 缓存复用。 |
| P3     | `PanelGuard.halted` 有写入但没有生产读取者；测试固定其内部字段。                     | 删除无效字段和断言，保留非收敛时停止及错误提示的行为测试。                                                                                             |
| P2     | Web 工具夹带通用 body/DNS/IP 策略，模型凭据反向依赖扩展。                            | 通用策略归入 `server/http/`，Web 工具归入 `extensions/web/`。                                                                                          |
| P3     | 重复装配封装、未消费的样式导出和独立 Separator。                                     | 删除 `applicationExtensions()`、`SwapLabel` 及其独占样式、其它未用样式和无消费者的 Separator 文件。                                                    |

已有源文件按 app、chat、models、extensions、MCP、Skills、HTTP 等职责归并。MCP/Skills 设置与具体扩展同目录；聊天会话协议、OpenUI panel 协议进一步聚合。直接消费者、构建配置、HMR fixture、README 和第三方声明中的路径同步更新，旧路径没有转发文件。目录和公开接口说明见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 渐进式历史与升级边界

- 新快照使用 `?view=window`，目标为最近 100 条 native entries；为了完整输入/回复及工具轮次可以超出此软上限。旧客户端保留原有升序分页。
- 顶部向上滚动触发旧页读取。单次请求、失败重试、阅读锚点和草稿焦点均由真实浏览器验证；生成中分页不重复连接，不丢失当前草稿或已加载旧消息。
- 回复建议、来源、计时和 loaded Skills 使用逐消息 annotations，与当前会话状态分离。旧页和新事件按 native ID 和 revision 合并。
- task/submission 索引仅保存定位元数据。native 写入和派生更新处于同一存储事务，实际结果仍通过公共 Pi Storage 读取。
- 旧数据按 100 条一批回填并保存进度，可在中断后继续。索引就绪前回退旧响应。旧请求执行绑定也只在升级时分批解析，原始大输入、图片和动作上下文保留。
- 自定义扩展若只提供未声明范围的 `projectState`，继续使用完整投影，直到扩展声明窗口范围。当前运行的 Pi 原生上下文恢复和首次旧数据升级仍可能有随历史增长的成本。

## 保留的后续工作

Skill 不可变版本和 tombstone 尚无引用感知的回收策略。应先定义旧会话绑定及版本存活规则，再引入引用核对和宽限期；不能根据库页面不可见便删除文件。

`ConversationAgent` 仍负责 admission、原生 runtime bootstrap、停止/删除、队列动作和扩展资源写入。这些写入共享原有序列；本轮没有为了缩短文件拆出第二个调度器或可写 runtime。后续仅在改动频率证明必要时继续收敛资源写入和 runtime 初始化 Interface。

## 静态扫描的判断边界

- 未引用候选通过模块/符号关系和实际消费者核对，包含动态 imports、alias、Worker URL、路由和 DO 导出。
- OpenUI devtools alias、compute Worker、可启用 example/Skills 示例不是 dead code。
- `@openuidev/react-headless` 和 `zustand` 是已使用 OpenUI 包的 peer dependencies，保留显式依赖。
- 不删除仍被使用组件的官方接口，不为减少未使用计数破坏扩展或测试入口。

## 验证记录

| 检查                                             | 结果                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 单元测试                                         | 58 个文件，234 项通过                                                               |
| workerd 集成测试                                 | 全量 43 个文件、234 项通过；随后新增的工具结果分页边界回归通过，窗口专项共 5 项通过 |
| Playwright                                       | 全量 93 项通过，包含历史分页、历史 annotations、长运行后快照刷新与焦点/滚动保持     |
| Durable Object HMR                               | 通过：并发只启动一个 Pi runtime、依赖变更重启、SQLite 数据保留、浏览器变更继续 HMR  |
| TypeScript / ESLint / Prettier / diff whitespace | 通过                                                                                |
| 默认 / production / 移除 OpenUI 构建             | 全部通过；移除 OpenUI 构建的模块图守卫确认无 OpenUI 实现与依赖                      |

已通过的专项检查包含：配置来源隔离、内存远端单次分页与卸载取消、旧 epoch 计算失效、分页读上限、并发新消息下的旧游标、旧页计时/工具状态、首条为最终工具结果时的完整回复扩展、回填中断续跑、native/索引事务回滚、冷启动紧凑执行绑定、观察初始化竞争，以及浏览器滚动/重试/焦点/生成中分页，以及长运行超过一页后刷新仍保留中间已提交消息。

本地 1,000 与 10,000 条历史 fixture 均只返回最近 100 条；测试限制 idle 窗口快照读取 `pi_entries` 的 rowsRead 不超过 220。这不是生产延迟或内存压测结果。

上游 sourcemap、bundle 大小提示及 workerd alarm/drain 诊断仍可能出现在日志中，以检查退出状态和行为断言判断结果。

存储与异步工作检查参考 [Cloudflare SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) 和 [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。
