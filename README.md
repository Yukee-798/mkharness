# Agent Generative UI

可复制和修改的远程 Agent 应用基础模板。应用入口采用 TanStack Start / Router / Query + Cloudflare Workers，推理、队列和完整历史仍由 PiHarness / Pi Durable 管理。用户通过 Google 登录；开发者可以静态装配 Extension、Skills、远程 MCP 与异步服务。已有 assistant-ui、OpenUI 与 QuickJS 交互继续保留。

任务提交、观察和停止分开。关闭页面只断开观察，Durable Object 中的 PiHarness 继续执行；返回后从完整 Pi 历史恢复。程序、数据和界面使用成功工具历史，不建立第二套产物表。

## 本地启动

使用 Node.js 24 和 pnpm 11.17.0。核心依赖固定在 lockfile；升级时一起检查 OpenUI / assistant-ui / AG-UI / Pi 的兼容性。

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填写 Google OAuth、Better Auth secret 和模型配置
pnpm db:migrate
pnpm dev
```

打开 `http://localhost:5173`。默认 D1 ID 为本地占位值，仅本地使用；部署前必须替换。`APP_URL` 在 `wrangler.jsonc` 中配置，须等于实际访问的同源地址。不要混用 localhost 和 127.0.0.1。

| 配置                                        | 用途                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`                        | 至少 32 字符的随机 secret，每个环境独立                                                          |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Web OAuth 应用                                                                            |
| `MODEL_PROVIDER`                            | 当前提供 `openai`、`anthropic` 或 `deepseek`                                                     |
| `MODEL_ID`                                  | 已安装 Pi catalog 中的完整 ID，`pnpm models` 可列出                                              |
| `MODEL_API_KEY`                             | 仅服务端使用的供应商密钥                                                                         |
| `MODEL_IDS`                                 | 可选，同一 provider 下用逗号分隔的模型白名单，须包含 `MODEL_ID`；留空展示已安装 Pi provider 目录 |
| `MODEL_THINKING_LEVEL`                      | 默认 `low`；`off` 可关闭，也可配置 minimal/medium/high/xhigh/max，默认值按模型能力调整           |
| `TAVILY_API_KEY`                            | 可选；缺少时搜索工具明确报告未配置                                                               |

生产 `MODEL_PROVIDER` / `MODEL_ID` 使用 Wrangler `vars`；密钥使用 Cloudflare Secrets。没有默认模型、用户 API key 输入或浏览器密钥。缺少认证配置返回 503；缺少模型配置在接受任务前返回 503。

聊天展示模型实际返回的推理文本或摘要，生成时可展开查看，完成后默认收起。历史恢复保留已有推理；没有提供推理的模型和旧记录不补造思考过程。推理配置应用于后续任务，不会重写历史。加密推理、redacted blocks 和供应商签名不会传到前端。

输入框左下角使用 assistant-ui ModelSelector 的独立组件，选择服务端允许的模型和该模型实际支持的思考强度。当前 provider 共用服务端密钥；增加其他 provider 需在 `src/server/models.ts` 注册和配置，不会展示未配置的供应商。DeepSeek 目录包含 `deepseek-flash` 与 `deepseek-v4-pro`；后者不支持低档思考。

每次 HTTP 提交携带 `config: { modelId, thinkingLevel }`。后端校验白名单和能力，将实际选择冻结在现有 `app_requests.payload` 中；重试包含同一配置，改动配置需新的 runId。模型调度从 Pi 的当前运行 operation 读取选择，因此切换选择器只影响下一次提交，不改变运行中或排队的任务。刷新会恢复最近一次提交的选择。请求记录没有凭据，未添加设置表或新的公共接口。Pi 继续管理队列、完整历史、压缩和恢复；应用在 `Models.streamSimple` 边界分发模型及思考选项。

Pi 的压缩阈值仍采用会话默认 `MODEL_ID` 的目录窗口；当前两种 DeepSeek 模型的窗口一致。扩展到不同窗口的模型时，以白名单中窗口最小的模型作为 `MODEL_ID`，让共享聊天的压缩阈值适用于全部选择。

Google 控制台选择 Web 应用，添加授权 JavaScript 来源 `http://localhost:5173`，授权重定向 URI：

```text
http://localhost:5173/api/auth/callback/google
https://YOUR_WORKER_DOMAIN/api/auth/callback/google
```

测试 OAuth 应用需在同意屏幕添加测试用户。生产域名也要加入来源及回调，`APP_URL` 与之一致。应用没有测试登录、session 注入或认证绕过路由。

## Cloudflare 部署

已有部署升级时，保持 Worker 名称、DB / CONVERSATIONS binding、D1 database_id、DO namespace、ConversationAgent 类名和 migrations 不变；仅更换构建入口不需要创建新存储。下面“创建新资源”的步骤仅适用于复制模板首次安装。发布前检查已运行任务所依赖的 Extension/task 定义仍存在，不支持运行中热换代码或无迁移地改变 task 语义。

先登录 Wrangler，创建全新的 D1 数据库，将返回 ID 写入对应配置。首个 DO `v1` 迁移创建 SQLite-backed `ConversationAgent`；不要手工创建或迁移上游 Pi 表。

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create YOUR_NEW_DATABASE
# 修改 wrangler.jsonc 的 name、APP_URL、D1 database_name/database_id
# 配置 MODEL_PROVIDER / MODEL_ID，然后使用交互提示逐项输入 secret
pnpm exec wrangler secret put BETTER_AUTH_SECRET
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put MODEL_API_KEY
pnpm exec wrangler d1 migrations apply DB --remote
pnpm deploy
```

Cloudflare Vite 插件输出客户端静态资源和 Worker 部署配置，Wrangler 使用生成配置部署。先构建目标环境，再操作该环境，不要将测试构建当作生产构建部署。

`env.test` 提供独立 Worker 名称和 D1/DO 绑定。**复制模板时，请改成自己的新测试资源名称和 D1 ID**，不要保留本次验收资源 ID。环境不会继承 D1/DO 绑定。测试命令：

```sh
pnpm exec wrangler d1 create YOUR_NEW_TEST_DATABASE
# 写入 env.test.d1_databases，填写 env.test.vars
pnpm exec wrangler secret put BETTER_AUTH_SECRET --env test
pnpm exec wrangler secret put GOOGLE_CLIENT_ID --env test
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --env test
pnpm exec wrangler secret put MODEL_API_KEY --env test
pnpm db:migrate:test
pnpm deploy:test
```

当前测试环境允许先部署未配置的外壳：`secrets.required` 为空，认证仍拒绝服务并返回清楚错误。完成配置后可将它设为与根配置相同的四个 required secrets。此行为只为独立环境启动验证；不能据此声称完成 Google 登录、任务续跑或模型验收。用自己的隔离测试凭据完成 [云端验收清单](docs/validation/acceptance.md)。

## TanStack 入口与私有缓存

`src/server.ts` 将 `/api/*` 转交已有 Hono，其余请求交 Start，具名导出原 `ConversationAgent`。`src/router.tsx` 每次创建独立 QueryClient；文件路由验证 `/?chat=<id>`。聊天子树延迟加载到客户端，SSR 不读取 localStorage、启动浏览器 Worker 或建立 SSE。页面与 API 返回 private/no-store。

Query 负责用户目录和快照读取（模型目录仍随快照返回）；缓存键包含 userId / chatId，退出或切换账号清理旧用户缓存。预加载、窗口聚焦及普通读取更新不提交任务，不重新导入消息或 attach。HTTP Composer、AG-UI attach 和 Stop 保持独立；Query 不替代流式消息 runtime。

## 原生扩展与远端服务

开发者装配入口是 `src/server/assembly.ts`，返回 `Extension[] | Promise<Extension[]>`；`ConversationAgent.extensions()` 在此基础上安装会话内的 MCP 和异步示例。工具、task kind、section 与 Extension 名称必须稳定且不重名；需要包装时使用原生 wraps。保留旧 kind/version 才能恢复 pending task，删除定义会产生明确恢复失败。

可选配置：

| 配置                       | 默认与含义                                                     |
| -------------------------- | -------------------------------------------------------------- |
| `ENABLE_GENERATIVE_UI`     | 默认开启；`0` 关闭 UI 工具及其提示词，基础 Agent 仍可用        |
| `ENABLE_EXAMPLE_EXTENSION` | `1` 启用 `describe_text` 示例（tool / section / hook）         |
| `ENABLE_EXAMPLE_SKILL`     | `1` 启用静态来源示例                                           |
| `TOOL_CALL_LIMIT`          | 默认 40，每提交的正整数工具预算；模型仍最多 20 轮              |
| `MCP_SERVERS`              | 默认 `[]`，开发者配置的 HTTPS Streamable HTTP 服务             |
| `ASYNC_SERVICE_URL`        | 未设置则关闭具体异步服务示例                                   |
| `ASYNC_SERVICE_TOKEN`      | 可选服务端 Bearer 凭据                                         |
| `ASYNC_RECOVERY`           | `none` / `key` / `lookup`，默认 `none`；必须匹配真实供应商契约 |

`src/server/extensions.ts` 提供最小原生示例；前端静态结果组件注册在 `src/browser/tool-results.tsx`，与 assistant-ui 工具详情分开显示。未知工具保留有界请求/结果详情。部署代码可信，终端用户不能安装代码；没有插件市场或第二套 SDK。

Skills 使用 `src/server/skills.ts` 的预检与原生 `skills(sources)` 桥接。正文和资源在装配时从部署内的受信任来源读取，模型只先看到目录，激活后才得到正文。增加自己的 `SkillSource` 和静态 Markdown / 文本资源即可；不要通过浏览器或模型提供任意 URL / 路径。资源读取保留在 Pi 历史，脚本文本不会执行，也不会注册新工具。仅作类型使用的 `agents/skills` 必须 type-only 导入，避免把未启用的脚本执行依赖引入构建。

MCP 配置示例（只包含凭据变量名）：

```json
[
  {
    "serverId": "reference",
    "endpoint": "https://YOUR_MCP_HOST/mcp",
    "allowlist": ["lookup"],
    "credential": "REFERENCE_MCP_TOKEN"
  }
]
```

将 JSON 写入 `MCP_SERVERS`，凭据放入对应 Cloudflare Secret。连接/发现 15 秒，调用 30 秒；输入、结果及绑定定义各有 1 MiB 上限。仅接入支持的 JSON Schema、文本、structuredContent 和 isError；不支持的块明确失败，不执行 HTML、自动读取资源 URI 或启动 stdio。工具映射为 `mcp_<serverId>_<toolName>`，超过 64 字符或冲突时拒绝，不截断。首次接受的定义保存在 Pi conversation document；重建重新连接并验证原定义，schema、endpoint、描述或 replay 策略变化不能静默替换。调用前也核对 SDK 已缓存的在线目录，已知变更会禁用对应绑定，不新增网络轮询。可选服务离线时本地工具仍可用。

默认 replay unsafe。仅当开发者已验证整个调用可安全恢复时，才在配置的 `safeTools` 中列出工具。供应商提示的 readOnly/idempotent annotations 不代替验收。Google 登录不表示用户已授权外部账号；本期使用应用服务凭据，每用户 MCP OAuth 延后。

### 具体异步服务示例

`src/server/remote-example.ts` 是一个具体接入示例，服务必须自行实现：

| HTTP                          | 示例契约                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `POST <base>/requests`        | `{prompt}` + `Idempotency-Key` → `{id}`                                                  |
| `GET <base>/requests?key=…`   | 仅 `lookup` 模式：按原键查 `{id}`，不创建新任务                                          |
| `GET <base>/requests/<id>`    | `{status:"pending"}` 或 `{status:"completed",result:…}`；失败/取消分别为 failed/canceled |
| `DELETE <base>/requests/<id>` | `{status:"canceled"}`；不支持取消使用 405/409/501                                        |

这不是所有供应商通用的 Job API；对接供应商时修改具体 Extension 的 submit/query/cancel，不新增调度器。`key` 模式要求同键、同参数的 POST 永远返回同一操作；`lookup` 模式要求稳定查询原键。无法证明时保持 `none`，不能以重试 HTTP 请求模拟幂等。

父工具在一次 `api.commit` 中创建普通所有权子任务并保存 childTaskId。子任务先提交意图，再进行远端副作用；得到 ID 后保存引用，等待期间使用 Pi checkpoint / sleep / Lifecycle，不调用模型轮询。默认等待 10 分钟，间隔 1/2/5/10/15 秒封顶，单次请求最多 30 秒；deadline 和 nextPollAt 跨重启保留。引用绑定原服务地址，配置重指后不会向新服务发送旧 ID。

已知 ID 只查询原任务；已接受但 ID 未保存时通过供应商契约调和，否则返回 `remote_outcome_unknown`。宿主 beforeTool 和执行入口均阻止新副作用调用，当前自动流程在模型边界结束；普通只读回答仍可用。显式“重新执行（可能重复执行）”引用原 Pi task，走已有 `/runs` 接口，以新 runId 一次性授权对应操作，宿主绑定原输入。复查只读取原操作；客户端不能提供任意 remoteId/serverId/toolName。重复接受请求使用同一个 runId。

Stop 使用子任务的新 abort invocation 尝试有界取消；本地 idle 与远端 canceled 分开。取消不支持、失败、未知及等待到期都保留引用，用户可以复查。无沙箱时不能强杀不合作的宿主代码；stopping 必须等待实际收束。成功且结果已写入 Pi 历史的冗余意图，在下一次空闲准入时清理；未决引用保留。进度从已提交 documents 投影到现有快照/AG-UI，浏览器没有远端凭据或 ID。

恢复元数据只有 MCP 定义绑定、远端调用意图/引用两类 Pi documents；未新增任务、插件或结果表。附件、R2、沙箱、媒体业务、支付订阅及人工审批留作后续扩展。

## 代码入口与扩展

界面优先复用 assistant-ui 的消息、Markdown、Viewport 与滚动组件。连续工具调用使用官方 ToolGroup ghost 变体，详情复用 ToolFallback 的只读展示组件；请求参数与结果独立滚动，桌面高度最多 256px、手机 176px。思考区使用官网示例的 Reasoning ghost 变体与 DisclosureTrigger，运行标签通过官方 tw-shimmer 循环扫光。组件源码位于 `src/browser/tool-group.tsx`、`tool-fallback.tsx`、`tool-call.tsx`、`reasoning.tsx`、`reasoning.aui.tsx`、`trace.tsx` 与 `surfaces.tsx`，可以直接修改；应用补充真实失败/停止状态、中文标签和无障碍适配。登录、个人聊天目录、状态提示与自定义控件使用 shadcn/ui + Tailwind CSS。生成内容仍由 OpenUI 的原生目录渲染。Composer 使用 assistant-ui 表单包装和 shadcn Textarea，但发送、排队与停止保持独立 HTTP 接口，不调用 runtime 的默认发送或取消行为。

新增应用控件可执行 `pnpm dlx shadcn@latest add <component>`，新增 assistant-ui 展示组件可执行 `pnpm dlx shadcn@latest add @assistant-ui/<component>`。配置在 `components.json`，主题变量在 `src/browser/styles.css`；安装后检查依赖版本、导入路径及许可证记录。不要用默认 ThreadList 替代现有聊天目录，除非也明确接入应用的认证、D1 目录和 Pi 历史。

OpenUI 通过根 `ThemeProvider` 共享 shadcn 的颜色、字体和圆角。全局品牌调整优先修改 `styles.css` 的变量；生成组件的字号、间距和主题映射在 `src/browser/openui-theme.ts`。正文与聊天同为 14px，手机输入保持 16px；外层面板不重复加卡片边框，只留焦点环所需空间，组件自己负责分组和表格滚动。图表仍保留可区分的系列颜色。原生目录和 ThemeProvider 从同一个包入口导入，避免 OpenUI 0.17.0 的独立子入口创建另一套上下文，导致弹层或图表主题自定义失效。需要新应用控件时继续使用 shadcn/ui + Tailwind；主题调整无需改动输入绑定、验证或动作。

应用外壳在 `src/browser/AppShell.tsx`：Google 登录入口位于侧栏底部，登录后替换为个人账号菜单，退出仍通过 Better Auth。桌面侧栏支持展开和窄栏模式，偏好保存在浏览器本地；手机通过 Sheet 抽屉显示目录和底部账号。收起只改变布局，保持聊天和草稿挂载，不重新提交任务。侧栏沿用应用的个人目录，不接入第二套 ThreadList 后端。

OpenUI Inspect 调试浮框默认禁用，避免 SDK 在开发页自动挂载调试界面和加载其 CDN 脚本；需要该工具时使用 `OPENUI_INSPECT=1 pnpm dev` 启动。仅关闭浮框，不改变程序/UI 校验或 Pi 工具历史。Inspect 的 Autofix 推广不代表本模板已启用该服务。

| 位置                                                     | 修改什么                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `src/browser/App.tsx` / `styles.css` / `ui/`             | 登录、个人目录、主题和 shadcn 页面组件                         |
| `src/browser/Chat.tsx` / `transport.ts`                  | assistant-ui 历史、独立 HTTP Composer、只 attach 的 AG-UI 观察 |
| `src/browser/Panel.tsx` / `draft.ts` / `PanelDrafts.tsx` | OpenUI 面板、输入快照、用户内存草稿、500ms 保存与冲突反馈      |
| `src/shared/catalog.tsx`                                 | 原生组件目录和可选 StateSync；修改目录后同时运行界面契约检查   |
| `src/shared/compute.ts` / 两端 `compute.ts`              | 有限 JSON、QuickJS 资源限制与 WASM 加载                        |
| `src/server/conversation.ts`                             | PiHarness、提交调和、队列准入与持久停止意图                    |
| `src/server/panel-tools.ts` / `limits.ts`                | 生成程序/UI 的工具、指令和有限修正                             |
| `src/server/web.ts`                                      | 公开网页读取与单一 Tavily 搜索；其他数据源在这里或同层增加工具 |
| `src/server/models.ts`                                   | 注册其他 Pi provider；保持显式模型和服务端凭据                 |
| `src/server/auth.ts` / `index.ts`                        | Better Auth、归属验证和聊天业务 API                            |

生成程序遵循 `export function compute(inputs,data)`，同步返回有限 JSON。没有 imports、网络、DOM、文件、时间或随机数；外部能力通过应用开放的后端工具完成。无需预置业务算法。`prepare_program` 在后端试算成功后，`present_openui` 引用已提交的程序；发布不等待浏览器回执。

Agent 默认优先使用生成式 UI 组织有实质内容的回答，配合简短文字、卡片、对比表、步骤和有依据的图表；简短问候、单个事实或用户明确要求纯文本时可直接用文字。图片使用用户提供或可信来源中已有的真实 URL，并说明来源与替代文本；模板目前没有图片生成或搜图工具，不编造图片地址或图表数据。

缺少会影响答案的用户信息或需要选择方案时，Agent 可直接发布原生澄清表单：单选、多选及补充文字，明确必填项和选项含义。推荐项不会自动视为用户的选择。编辑只更新本地状态并保存，用户点击提交后才向 Agent 发送当前答案快照；Agent 据此继续，避免重复提问。说明面板和澄清表单不需要计算程序，只有复杂计算才使用 `prepare_program` 与绑定的 Query。

程序验证用例的 `expected` 必须是完整输出，对象字段顺序无关，数组顺序与值仍严格比较。不匹配时返回用例编号、首个差异的 JSON Pointer、预期/实际值及有界结果预览（诊断最多 8 KiB）；不会发放 `programRef`。Agent 应根据意图和可独立核算的小用例修正，不应直接照抄实际输出来通过验证。

聊天不显示逐条回复的复制操作栏。生成界面的工具、校验与修正细节保留在 Pi 历史中；用户只看到当前一条“正在生成交互界面…”提示、渐进界面和最终回答。完成后收起内部步骤，最终失败使用简明提示。与生成工具同条消息的技术过程文案也收起，Agent 后续文案用产品语义解释结果与用法；普通 Markdown 代码块仍有复制代码功能。

原生 `Query("run_program", args, fallback)` 在绑定面板内计算，`Set` / `Reset` 管理输入；`ToAssistant` 将点击时的原始输入快照作为新请求提交。派生值通常直接显示。仅需自动写回输入时使用：

```text
StateSync($target,result.next,result.ready,{result:result,inputs:currentArgs})
```

`result` 须为完整 Query 对象，`currentArgs` 须与当前 Query 参数一致，用于拒绝旧结果和错误来源。自动回写每个用户编辑链最多三次。动态 UI 最终渲染为原生组件，没有任意前端 eval 或生成 React 执行。

组件目录提示显式启用 OpenUI 的 `toolCalls` 和 `bindings`，声明本地 `run_program` 工具，并仅约束 `present_openui.ui` 字符串。带程序的面板必须含计算 Query；输入绑定 `$variables`，派生内容读取 Query 结果。`@Reset` 接受已声明的变量，不接受表单名称。发布时仍拒绝 Mutation 和其他 Query 工具。

原生 Slider 要求有限的 min < max、正步长，离散模式最多 256 个选项；超过时应增加步长或改用 continuous。这是一项通用渲染资源限制，不预置业务算法。发布和动态渲染均检查；错误局限在面板中，聊天仍可继续。

会话按个人隔离，聊天内串行执行；运行中提交排队，上限 10 项。停止撤回当前及排队任务，Pi 真正 idle 前保持 stopping 并拒绝新提交。客户端 run UUID 对应 Pi operationId；不确定是否收到接受回执时，原样重试使用相同 UUID。

聊天行的操作菜单提供重命名和删除，桌面悬停或键盘聚焦时显示，移动端直接显示。重命名接受去除首尾空白后的 1–120 字符标题；手动名称不会被首条消息覆盖。删除需确认，会停止当前任务、撤回队列，并删除历史、面板输入和目录记录；删除完成后切换到另一段聊天，最后一段删除后返回起始页。失败保留确认框并允许重试，其他标签页返回时自动同步目录。

对应接口为 `PATCH /api/conversations/:id`（`{"title":"新名称"}`）和 `DELETE /api/conversations/:id`，沿用登录、同源和归属验证。删除意图写入现有 DO 元数据，复用任务调和机制恢复；等待工具结束后通过 Agent 的 `destroy()` 清理持久存储，不增加历史副本表。已有安装在更新后运行 `pnpm db:migrate`，部署环境执行对应的远端 D1 迁移。

程序限制：代码 64 KiB，输入＋数据及输出分别 1 MiB，VM 堆 16 MiB，栈 256 KiB，interrupt 1024 次。浏览器开始实际执行后 500ms 超时会终止 Worker，加载另有 15s watchdog。后端使用 interrupt 预算，不能承诺等价的 500ms CPU 上限。每个任务最多 20 次模型调用、初次失败后最多两次修正。

保存使用聊天内面板引用和 CAS revision。未保存输入和 409 冲突草稿在同一用户 Workspace 中保留，聊天切换或 runtime 恢复不会丢失；整页刷新或退出前请复制冲突改动。应用不会静默强制覆盖。历史程序引用从 Pi 的公开完整 entries 恢复，即使模型上下文已压缩。第一版没有附件、知识库、多用户共享、计费或任意代码沙箱工具。

## 验证

ESLint 检查 JavaScript / TypeScript、未使用变量和 React Hooks；Prettier 统一格式，ESLint 的格式冲突规则已关闭。编辑器推荐配置支持保存时格式化和 ESLint 自动修复。

```sh
pnpm lint          # 检查源码、配置和测试，警告也会失败
pnpm lint:fix      # 自动修复可处理的 lint 问题
pnpm format        # 格式化当前源码、配置和维护文档
pnpm format:check  # 只检查格式，不改文件
pnpm check         # lint、格式、类型、单元/workerd 测试及构建
```

生成的 Worker 类型、构建/测试产物、历史研究与设计快照、本地密钥文件不参与格式化。ESLint 使用 TypeScript 6 兼容 API；`pnpm typecheck` 仍由 TypeScript 7.0.2 执行。这采用 [TypeScript 官方的并行安装方式](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0)，并在 lockfile 中固定两个版本。

```sh
pnpm typecheck
pnpm test:unit
pnpm test:workers
pnpm test:e2e
pnpm build
pnpm exec wrangler deploy --dry-run
```

首次浏览器测试需 `pnpm exec playwright install chromium`。测试夹具替换模型 I/O，但 PiHarness / D1 / SQLite / workerd 真实运行；浏览器测试使用真实 QuickJS WASM、OpenUI 和 assistant-ui。夹具入口只在测试配置中，不进入生产构建。原有研究消融仅为基线，产品验证记录在 [implementation.md](docs/validation/implementation.md)，真实模型与云端结果另列，未完成不会用模拟结果填充。基础层迁移与故障矩阵见 [foundation.md](docs/validation/foundation.md)。浏览器验收使用独立端口 5174 和 `.wrangler/e2e` 本地存储，不改动产品开发端口 5173 或其 SQLite 数据。

MIT；上游和借用组件归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
