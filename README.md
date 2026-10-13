# MkHarness

可复制和修改的远程 Agent 应用基础模板。应用入口采用 TanStack Start / Router / Query + Cloudflare Workers，推理、队列和完整历史仍由 PiHarness / Pi Durable 管理。默认免登录，以原生匿名会话隔离用户；可选择 Google 账号模式。用户可在客户端保存个人模型 Key；开发者可以静态装配 Extension、Skills、远程 MCP 与异步服务。已有 assistant-ui、OpenUI 与 QuickJS 交互继续保留。

任务提交、观察和停止分开。关闭页面只断开观察，Durable Object 中的 PiHarness 继续执行；返回后从完整 Pi 历史恢复。程序、数据和界面使用成功工具历史，不建立第二套产物表。

当前为开源基础模板 **v0.1.0**，现有数据用于本地开发与测试。迭代优先保证能力契约一致、职责明确和恢复正确，可以直接重构接口及实现，不为旧版测试数据增加兼容分支。断线、进程重建和同一次任务的恢复仍属于核心功能；业务算法及付费服务流程由应用的 Extension 实现，模板只提供基础能力和最小接入示例。

## 本地启动

使用 Node.js 24 和 pnpm 11.17.0。核心依赖固定在 lockfile；升级时一起检查 OpenUI / assistant-ui / AG-UI / Pi 的兼容性。

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm setup
# guest 默认免登录；进入侧栏账号菜单 → 模型与 API Key，填写自己的供应商 Key。
pnpm db:migrate
pnpm dev
```

打开 `http://localhost:5173`。默认 D1 ID 为本地占位值，仅本地使用；部署前必须替换。`APP_URL` 在 `wrangler.jsonc` 中配置，须等于实际访问的同源地址。不要混用 localhost 和 127.0.0.1。

本地默认关闭 Miniflare 的持久日志/调用链采集，终端错误输出保留。当前工具版本的本地诊断库没有自动过期清理；必要时使用 `X_LOCAL_OBSERVABILITY=true pnpm dev` 临时开启，排查后关闭。只有在开发服务完全停止后，才可以清理 `.wrangler/state/v3/observability`；不要删除相邻的 D1、DO 或整个 state 目录。该开关属于当前 Cloudflare 工具版本的实验能力，升级工具后需重新验证。

本地改动 ConversationAgent 或其依赖时，开发服务重启 Worker，并保留 SQLite；前端单独改动继续使用 React 热更新。当前 Cloudflare Vite runner 直接热替换 DO 类会保留旧实例中的异步 Pi runtime，不能用于恢复同一份存储。`config/durable-reload.ts` 在开发环境阻止这类替换。

正常删除由应用单飞并等待关闭；DO 重建使用新实例恢复原 SQLite，不复用已 dispose 的 Harness。生命周期与 HMR 对照通过后已移除关闭补丁，证据见 [未补丁 Pi 接缝验证](docs/validation/2026-10-12-unpatched-pi-seams.md)。当前仅为逐任务模型绑定使用两个 [临时公开 API 补丁](patches/README.md)：Pi Durable 保存提交配置并向生成/压缩继承，Agents wrapper 转发该配置；不修改生命周期。升级时运行 `pnpm test:workers` 和 `pnpm test:hmr`。开发热重启异常时，可以完整停止开发进程再启动，保留原持久化目录；不要用清空数据库替代恢复。

线上 Workers Logs 默认采样 10% 的请求；这不是硬性写入量上限，也不是按错误采样。Pi onReport 逐次输出异常分类和类型，不做应用层节流。线上保留期、配额和计费由 Cloudflare 管理，部署前按实际流量调整采样并配置用量告警。应用聊天和 Pi 历史与诊断日志分开保存。

| 配置                                        | 用途                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `AUTH_MODE`                                 | 默认 `guest`，`account` 使用 Google 登录；模式不合的身份明确拒绝                  |
| `BETTER_AUTH_SECRET`                        | 稳定的独立随机 Secret，本地 `pnpm setup` 只补缺失值                               |
| `CREDENTIAL_ENCRYPTION_KEY`                 | 32 字节随机值的标准 Base64，生产使用 Cloudflare Secret；必须跨重启保留            |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 仅 account 模式必需                                                               |
| `MODEL_PROVIDER` / `MODEL_ID`               | 默认 `openai/gpt-5-mini`，静态注册 openai/anthropic/deepseek；不依赖 Key 读取目录 |
| `MODEL_API_KEY` / `ALLOW_SERVER_MODEL_KEY`  | 只有显式设为 `1` 才允许部署 Key；默认 `0`，个人 Key 优先                          |
| `MODEL_IDS`                                 | 可选，仅约束默认 provider 的模型目录，必须包含默认模型                            |
| `MODEL_THINKING_LEVEL`                      | 默认 low，按实际模型能力调整                                                      |
| `TAVILY_API_KEY`                            | 可选搜索工具凭据                                                                  |

私人 BYOK 不使用独立网关。客户端输入通过同源认证接口发送给本部署，在 D1 使用 AES-256-GCM 加密保存，owner/provider/version 进入 AAD。部署者持有主密钥，能够解密；只在可信部署填写。浏览器不持久保存 Key，Query 只缓存元数据。保存不代表供应商已验证。匿名身份属于该浏览器 Cookie，清除 Cookie 或更换浏览器无法找回；无自动升级、共享访客或跨浏览器恢复。

替换 Key 创建不可变版本，只影响新请求；退休版本最多保留七天以恢复已提交任务，每 owner/provider 最多二十个版本。移除撤销该 provider 的全部版本，但不能撤回已经发给供应商的请求。版本过期、撤销、主密钥不匹配、部署 Key 轮换或策略关闭都会明确失败，不回退到其他 Key。过期版本在该 owner 后续写入时清理，读取无额外写入。

本地 `.dev.vars` 可配置全部启用开关、可选参数与扩展凭据；生产非敏感配置放在对应环境的 Wrangler `vars`，凭据使用 Secrets。配置不使用 `secrets.required`：Wrangler 会将它作为本地变量加载白名单，导致未列出的可选配置和 MCP 自定义凭据被静默忽略。必需认证与模型配置由服务端准入校验，缺失时明确拒绝服务。

聊天展示模型实际返回的推理文本或摘要，生成时可展开查看，完成后默认收起。历史恢复保留已有推理；没有提供推理的模型和旧记录不补造思考过程。推理配置应用于后续任务，不会重写历史。加密推理、redacted blocks 和供应商签名不会传到前端。

输入框复用 assistant-ui 模型选择组件，使用 `{ provider, modelId, thinkingLevel }` 二元模型身份。空聊天把欢迎语和输入框整体居中，GET/预加载不创建聊天；首次发送创建一次聊天，提交回执缺口保留已有 chatId 和 runId 供明确重试。

服务端在首次准入将模型、思考强度与凭据版本引用冻结到 `app_requests`，重试先比较原请求再复用冻结记录。Pi 的公开执行接口在 prepare、窗口判断之前绑定，排队、后续生成、自动压缩和 DO 重建沿用原操作配置。凭据在每次实际模型调用前按真实 owner/provider/id 解密，不保存到 Pi 历史、消息或日志；没有原输入绑定的模型调用不会借用其他请求的 Key。内部 provider 身份只用于原生执行，不进入公开模型目录。切换选择只影响下一次提交。

account 模式才需要下列 Google 配置。

Google 控制台选择 Web 应用，添加授权 JavaScript 来源 `http://localhost:5173`，授权重定向 URI：

```text
http://localhost:5173/api/auth/callback/google
https://YOUR_WORKER_DOMAIN/api/auth/callback/google
```

测试 OAuth 应用需在同意屏幕添加测试用户。生产域名也要加入来源及回调，`APP_URL` 与之一致。应用没有测试登录、session 注入或认证绕过路由。

## Cloudflare 部署

工程品牌名为 **MkHarness**。首次安装建议使用 `mkharness` 作为 Worker 和数据库名称；仓库中的旧 Worker/D1 名称是现有资源身份，不是页面品牌。已有安装改名会切换 DO 命名空间，因此保留其名称及数据库 ID。历史验收中的资源、分支与文件路径记录保持原值。

已有部署升级时，保持 Worker 名称、DB / CONVERSATIONS binding、D1 database_id、DO namespace、ConversationAgent 类名和 migrations 不变；仅更换构建入口不需要创建新存储。下面“创建新资源”的步骤仅适用于复制模板首次安装。发布前检查已运行任务所依赖的 Extension/task 定义仍存在，不支持运行中热换代码或无迁移地改变 task 语义。

先登录 Wrangler，创建全新的 D1 数据库，将返回 ID 写入对应配置。首个 DO `v1` 迁移创建 SQLite-backed `ConversationAgent`；不要手工创建或迁移上游 Pi 表。

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create YOUR_NEW_DATABASE
# 首次安装将 name 设为 mkharness，填写 APP_URL、D1 database_name/database_id
# 配置 MODEL_PROVIDER / MODEL_ID，然后使用交互提示逐项输入 secret
pnpm exec wrangler secret put BETTER_AUTH_SECRET
pnpm exec wrangler secret put CREDENTIAL_ENCRYPTION_KEY
# account 模式另设 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
# 使用部署 Key 时另设 MODEL_API_KEY 并显式 ALLOW_SERVER_MODEL_KEY=1
pnpm exec wrangler d1 migrations apply DB --remote
pnpm deploy
```

Cloudflare Vite 插件输出客户端静态资源和 Worker 部署配置，Wrangler 使用生成配置部署。先构建目标环境，再操作该环境，不要将测试构建当作生产构建部署。

`env.test` 提供独立 Worker 名称和 D1/DO 绑定。**复制模板时，请改成自己的新测试资源名称和 D1 ID**，不要保留本次验收资源 ID。环境不会继承 D1/DO 绑定。测试命令：

```sh
pnpm exec wrangler d1 create YOUR_NEW_TEST_DATABASE
# 写入 env.test.d1_databases，填写 env.test.vars
pnpm exec wrangler secret put BETTER_AUTH_SECRET --env test
pnpm exec wrangler secret put CREDENTIAL_ENCRYPTION_KEY --env test
# account 模式按需设置 Google secrets
pnpm db:migrate:test
pnpm deploy:test
```

当前测试环境允许先部署未配置的外壳，认证仍拒绝服务并返回清楚错误。此行为只为独立环境启动验证；不能据此声称完成 Google 登录、任务续跑或模型验收。用自己的隔离测试凭据完成 [云端验收清单](docs/validation/acceptance.md)。

## TanStack 入口与私有缓存

`src/server.ts` 将 `/api/*` 转交已有 Hono，其余请求交 Start，具名导出原 `ConversationAgent`。`src/router.tsx` 每次创建独立 QueryClient；文件路由验证 `/?chat=<id>`。聊天子树延迟加载到客户端，SSR 不读取 localStorage、启动浏览器 Worker 或建立 SSE。页面与 API 返回 private/no-store。

Query 负责用户目录、独立模型设置和快照读取；缓存键包含 userId / chatId，退出或切换账号清理旧用户缓存。预加载、窗口聚焦及普通读取更新不提交任务，不重新导入消息或 attach。HTTP Composer、AG-UI attach 和 Stop 保持独立；Query 不替代流式消息 runtime。

## 原生扩展与远端服务

开发者装配入口是 `src/extensions/server.ts` 的静态能力定义，返回原生 Extension 的 `ServerContribution`；`src/server/assembly.ts` 负责验证并收集；`ConversationAgent.extensions()` 在此基础上安装会话内的 MCP 和异步示例。工具、task kind、section 与 Extension 名称必须稳定且不重名；需要包装时使用原生 wraps。保留旧 kind/version 才能恢复 pending task，删除定义会产生明确恢复失败。

可选配置：

| 配置                   | 默认与含义                                                     |
| ---------------------- | -------------------------------------------------------------- |
| `ENABLE_GENERATIVE_UI` | 默认开启；`0` 关闭 UI 工具及其提示词，基础 Agent 仍可用        |
| `ENABLE_EXAMPLE_SKILL` | `1` 启用静态来源示例                                           |
| `TOOL_CALL_LIMIT`      | 默认 40，每提交的正整数工具预算；模型仍最多 20 轮              |
| `MCP_SERVERS`          | 默认 `[]`，开发者配置的 HTTPS Streamable HTTP 服务             |
| `ASYNC_SERVICE_URL`    | 未设置则关闭具体异步服务示例                                   |
| `ASYNC_SERVICE_TOKEN`  | 可选服务端 Bearer 凭据                                         |
| `ASYNC_RECOVERY`       | `none` / `key` / `lookup`，默认 `none`；必须匹配真实供应商契约 |

`src/server/extensions.ts` 提供最小原生示例。`example` 已登记在 `src/extensions/server.ts`，默认启用 `describe_text`（tool / section / hook），无需额外环境变量；移除登记即可关闭。前端在 `src/extensions/example/browser.tsx` 提供原生 Toolkit，并由 `src/extensions/browser.ts` 静态懒加载。renderer 复用 assistant-ui 工具详情，结果展示由能力自己组合。未知工具保留有界请求/结果详情。部署代码可信，终端用户不能安装代码；没有插件市场或第二套 SDK。

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

将 JSON 写入 `MCP_SERVERS`，凭据放入对应 Cloudflare Secret。连接/发现 15 秒，调用 30 秒；输入、结果及绑定定义各有 1 MiB 上限。仅接入支持的 JSON Schema、文本、structuredContent 和 isError；不支持的块明确失败，不执行 HTML、自动读取资源 URI 或启动 stdio。工具映射为 `mcp_<serverId>_<toolName>`，超过 64 字符或冲突时拒绝，不截断。首次接受的定义保存在 Pi conversation document；重建重新连接并验证原定义，schema、endpoint、描述或 replay 策略变化不能静默替换。启动时按当前部署配置重装传输的超时、大小、重定向限制和凭据，再交给 SDK 恢复连接。可选服务离线时本地工具仍可用；已绑定工具在后续调用时有界重连，并核对在线定义，暂时离线不会永久禁用工具。

默认 replay unsafe。仅当开发者已验证整个调用可安全恢复时，才在配置的 `safeTools` 中列出工具。供应商提示的 readOnly/idempotent annotations 不代替验收。Google 登录不表示用户已授权外部账号；本期使用应用服务凭据，每用户 MCP OAuth 延后。

凭据仅在请求发出时经原生 `transport.fetch` 从部署 Secret 注入，连接配置及 Pi 文档不保存 Key 副本；重建时仍按当前部署配置装配。模型逐任务凭据版本绑定与 MCP 部署凭据是不同边界。

`replay: unsafe` 仅约束原工具任务的恢复，并不能阻止模型另外发起同一副作用。宿主在发出 unsafe MCP 请求之前，把意图保存到既有 Pi 远端意图文档；仅在有效响应和原生工具结果均已提交后解除保护。丢失回执、无效响应或未提交结果会阻止本会话中同 serverId 或 endpoint 的后续 unsafe 调用及当前自动执行，重建后仍有效；safe 工具可继续读取。通用 MCP 没有供应商调和契约，此时不能自动重提，也没有通用的“再次执行”授权接口。需要开发者查明原操作结果；需要可恢复提交与显式重试的服务应实现下述具体异步 Extension 契约。

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

Stop 使用子任务的新 abort invocation 尝试有界取消；本地 idle 与远端 canceled 分开。取消不支持、失败、未知及等待到期都保留引用，用户可以复查。轮询和复查使用相同的响应契约：completed 必须携带 result，null 也是有效结果；缺失结果不能结束操作或清理未决引用。无沙箱时不能强杀不合作的宿主代码；stopping 必须等待实际收束。成功且结果已写入 Pi 历史的冗余意图，在下一次空闲准入时清理；未决引用保留。进度从已提交 documents 投影到现有快照/AG-UI，浏览器没有远端凭据或 ID。

恢复元数据只有 MCP 定义绑定、远端调用意图/引用两类 Pi documents；未新增任务、插件或结果表。附件、R2、沙箱、媒体业务、支付订阅及人工审批留作后续扩展。

双端静态装配、资源/CAS、冻结来源动作、公开进度和未来 Adapter 的完整契约见 [扩展接入说明](docs/extensions/README.md)。OpenUI 可整体关闭或移除，不需要核心 Chat 增加工具名称分支。

`timing` 是默认启用的纯展示扩展：工具标题旁显示原生任务耗时，回复 Footer 使用 assistant-ui ActionBar 提供复制及 Markdown 导出，下面展示完整回复执行时间。执行时间从 Pi 记录恢复，不增加模型工具、计时结果表或独立订阅。浏览器扩展可通过 `ui.toolTitleMeta / ui.assistantFooter` 装饰共享组件，无需覆盖已有工具 renderer。

## 代码入口与扩展

界面优先复用 assistant-ui 的消息、Markdown、Viewport 与滚动组件。连续工具调用使用官方 ToolGroup ghost 变体，详情复用 ToolFallback 的只读展示组件；请求参数与结果独立滚动，桌面高度最多 256px、手机 176px。思考区使用官网示例的 Reasoning ghost 变体与 DisclosureTrigger，运行标签通过官方 tw-shimmer 循环扫光。组件源码位于 `src/browser/tool-group.tsx`、`tool-fallback.tsx`、`tool-call.tsx`、`reasoning.tsx`、`reasoning.aui.tsx`、`trace.tsx` 与 `surfaces.tsx`，可以直接修改；应用补充真实失败/停止状态、中文标签和无障碍适配。登录、个人聊天目录、状态提示与自定义控件使用 shadcn/ui + Tailwind CSS。生成内容仍由 OpenUI 的原生目录渲染。Composer 使用 assistant-ui 表单包装和 shadcn Textarea，但发送、排队与停止保持独立 HTTP 接口，不调用 runtime 的默认发送或取消行为。

新增应用控件可执行 `pnpm dlx shadcn@latest add <component>`，新增 assistant-ui 展示组件可执行 `pnpm dlx shadcn@latest add @assistant-ui/<component>`。配置在 `components.json`，主题变量在 `src/browser/styles.css`；安装后检查依赖版本、导入路径及许可证记录。不要用默认 ThreadList 替代现有聊天目录，除非也明确接入应用的认证、D1 目录和 Pi 历史。

OpenUI 在自身 renderer 内通过局部 `ThemeProvider` 共享 shadcn 的颜色、字体和圆角。全局品牌调整优先修改 `styles.css` 的变量；生成组件的字号、间距和主题映射在 `src/extensions/openui/theme.ts`。正文与聊天同为 14px，手机输入保持 16px；外层面板不重复加卡片边框，只留焦点环所需空间，组件自己负责分组和表格滚动。图表仍保留可区分的系列颜色。原生目录和 ThemeProvider 从同一个包入口导入，避免 OpenUI 0.17.0 的独立子入口创建另一套上下文，导致弹层或图表主题自定义失效。需要新应用控件时继续使用 shadcn/ui + Tailwind；主题调整无需改动输入绑定、验证或动作。

应用外壳在 `src/browser/AppShell.tsx`：account 的 Google 登录入口位于侧栏底部，guest 直接显示浏览器访客菜单；菜单包含模型与 API Key 设置，退出仍通过 Better Auth。桌面侧栏支持展开和窄栏模式，偏好保存在浏览器本地；手机通过 Sheet 抽屉显示目录和底部账号。收起只改变布局，保持聊天和草稿挂载，不重新提交任务。侧栏沿用应用的个人目录，不接入第二套 ThreadList 后端。

OpenUI Inspect 调试浮框默认禁用，避免 SDK 在开发页自动挂载调试界面和加载其 CDN 脚本；需要该工具时使用 `OPENUI_INSPECT=1 pnpm dev` 启动。仅关闭浮框，不改变程序/UI 校验或 Pi 工具历史。Inspect 的 Autofix 推广不代表本模板已启用该服务。

| 位置                                                 | 修改什么                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `src/browser/App.tsx` / `styles.css` / `ui/`         | 登录、个人目录、主题和 shadcn 页面组件                         |
| `src/browser/Chat.tsx` / `transport.ts`              | assistant-ui 历史、独立 HTTP Composer、只 attach 的 AG-UI 观察 |
| `src/extensions/openui/Panel.tsx`                    | OpenUI 内容、计算绑定和动作                                    |
| `src/browser/draft.ts` / `ResourceDrafts.tsx`        | 通用资源草稿、500ms 保存与冲突反馈                             |
| `src/extensions/openui/catalog.tsx`                  | 原生组件目录和可选 StateSync；修改目录后同时运行界面契约检查   |
| `src/shared/compute.ts` / 两端 `compute.ts`          | 有限 JSON、QuickJS 资源限制与 WASM 加载                        |
| `src/server/conversation.ts`                         | PiHarness、提交调和、队列准入与持久停止意图                    |
| `src/extensions/openui/tools.ts` / `instructions.ts` | 生成程序/UI 的工具、指令和有限修正                             |
| `src/server/limits.ts`                               | 必需的通用模型和工具预算                                       |
| `src/server/web.ts`                                  | 公开网页读取与单一 Tavily 搜索；其他数据源在这里或同层增加工具 |
| `src/server/models.ts`                               | 注册其他 Pi provider；保留提交时绑定与凭据隔离                 |
| `src/server/auth.ts` / `index.ts`                    | Better Auth、归属验证和聊天业务 API                            |

生成程序遵循 `export function compute(inputs,data)`，同步返回有限 JSON。没有 imports、网络、DOM、文件、时间或随机数；外部能力通过应用开放的后端工具完成。无需预置业务算法。`prepare_program` 在后端试算成功后，`present_openui` 引用已提交的程序；发布不等待浏览器回执。

Agent 默认优先使用生成式 UI 组织有实质内容的回答，配合简短文字、卡片、对比表、步骤和有依据的图表；简短问候、单个事实或用户明确要求纯文本时可直接用文字。图片使用用户提供或可信来源中已有的真实 URL，并说明来源与替代文本；模板目前没有图片生成或搜图工具，不编造图片地址或图表数据。

缺少会影响答案的用户信息或需要选择方案时，Agent 可直接发布原生澄清表单：单选、多选及补充文字，明确必填项和选项含义。推荐项不会自动视为用户的选择。编辑只更新本地状态并保存，用户点击提交后才向 Agent 发送当前答案快照；Agent 据此继续，避免重复提问。说明面板和澄清表单不需要计算程序，只有复杂计算才使用 `prepare_program` 与绑定的 Query。

程序验证用例的 `expected` 必须是完整输出，对象字段顺序无关，数组顺序与值仍严格比较。不匹配时返回用例编号、首个差异的 JSON Pointer、预期/实际值及有界结果预览（诊断最多 8 KiB）；不会发放 `programRef`。Agent 应根据意图和可独立核算的小用例修正，不应直接照抄实际输出来通过验证。

聊天不显示逐条回复的复制操作栏。生成界面的工具、校验与修正细节保留在 Pi 历史中；用户看到渐进内容和最终回答，不额外展示生成交互界面的 loading 文案。最终失败使用简明提示。Agent 文案用自然语言解释结果与用法；普通 Markdown 代码块仍有复制代码功能。

思考、正文与工具事件复用 assistant-ui runtime。供应商可能交错追加思考和正文，Pi 观察接口提供累计快照；出现后续内容时结束当前思考展示阶段，真实迟到追加复用同一个思考 ID，不重置整段消息。完成后的快照同步也保留当前 runtime 已展示的消息身份，不因读取刷新重新挂载组件。没有提供原生 thinking_end 时，不声称精确还原供应商每个 token 的结束时点。

原生 `Query("run_program", args, fallback)` 在绑定面板内计算，`Set` / `Reset` 管理输入；`ToAssistant` 将点击时的原始输入快照作为新请求提交，并保留有限 JSON 动作上下文（最多 16 KiB）。`OpenUrl` 在用户点击时同步打开完整 HTTP(S) 链接，不调用模型；发布时检查静态链接和动作，动态链接在点击时再次校验。模型不能凭空新增宿主动作。派生值通常直接显示。仅需自动写回输入时使用：

```text
StateSync($target,result.next,result.ready,{result:result,inputs:currentArgs})
```

`result` 须为完整 Query 对象，`currentArgs` 须与当前 Query 参数一致，用于拒绝旧结果和错误来源。自动回写每个用户编辑链最多三次。动态 UI 最终渲染为原生组件，没有任意前端 eval 或生成 React 执行。

组件目录提示显式启用 OpenUI 的 `toolCalls` 和 `bindings`，声明本地 `run_program` 工具，并仅约束 `present_openui.ui` 字符串。带程序的面板必须含计算 Query；输入绑定 `$variables`，派生内容读取 Query 结果。`@Reset` 接受已声明的变量，不接受表单名称。发布时仍拒绝 Mutation 和其他 Query 工具。

原生 Slider 要求有限的 min < max、正步长，离散模式最多 256 个选项；超过时应增加步长或改用 continuous。这是一项通用渲染资源限制，不预置业务算法。发布和动态渲染均检查；错误局限在面板中，聊天仍可继续。

会话按个人隔离，聊天内串行执行；运行中提交排队，上限 10 项。停止撤回当前及排队任务，Pi 真正 idle 前保持 stopping 并拒绝新提交。客户端 run UUID 对应 Pi operationId；不确定是否收到接受回执时，原样重试使用相同 UUID。

聊天行的操作菜单提供重命名和删除，桌面悬停或键盘聚焦时显示，移动端直接显示。重命名接受去除首尾空白后的 1–120 字符标题；手动名称不会被首条消息覆盖。删除需确认，会停止当前任务、撤回队列，并删除历史、面板输入和目录记录；删除完成后切换到另一段聊天，最后一段删除后返回起始页。失败保留确认框并允许重试，其他标签页返回时自动同步目录。

对应接口为 `PATCH /api/conversations/:id`（`{"title":"新名称"}`）和 `DELETE /api/conversations/:id`，沿用登录、同源和归属验证。删除意图写入现有 DO 元数据，复用任务调和机制恢复；等待工具结束后通过 Agent 的 `destroy()` 清理持久存储，不增加历史副本表。已有安装在更新后运行 `pnpm db:migrate`，部署环境执行对应的远端 D1 迁移。

程序限制：代码 64 KiB，输入＋数据及输出分别 1 MiB，VM 堆 16 MiB，栈 256 KiB，interrupt 1024 次。浏览器开始实际执行后 500ms 超时会终止 Worker，加载另有 15s watchdog；输入使旧计算失效或组件卸载时主动取消并释放 Worker。后端使用 interrupt 预算，不能承诺等价的 500ms CPU 上限。每个运行默认最多 20 次模型调用、40 次通用工具调用；OpenUI 初次失败后最多两次修正。

保存使用聊天内扩展资源引用和 CAS revision。未保存输入和 409 冲突草稿在同一用户 Workspace 中保留，聊天切换或 runtime 恢复不会丢失；整页刷新或退出前请复制冲突改动。应用不会静默强制覆盖。OpenUI 资源 handler 从本聊天 Pi 完整历史恢复程序引用，即使模型上下文已压缩。第一版没有附件、知识库、多用户共享、计费或任意代码沙箱工具。

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
pnpm test:hmr
pnpm test:e2e
pnpm build
pnpm exec wrangler deploy --dry-run
```

首次浏览器测试需 `pnpm exec playwright install chromium`。测试夹具替换模型 I/O，但 PiHarness / D1 / SQLite / workerd 真实运行；浏览器测试使用真实 QuickJS WASM、OpenUI 和 assistant-ui。workerd 测试显式配置 Miniflare bindings，不载入本地 `.dev.vars`。夹具入口只在测试配置中，不进入生产构建。原有研究消融仅为基线，产品验证记录在 [implementation.md](docs/validation/implementation.md)，真实模型与云端结果另列，未完成不会用模拟结果填充。基础层迁移与故障矩阵见 [foundation.md](docs/validation/foundation.md)，v0.1.0 架构与交互审查见 [framework-review.md](docs/validation/2026-10-11-framework-review.md)。浏览器验收使用独立端口 5174 和 `.wrangler/e2e` 本地存储，不改动产品开发端口 5173 或其 SQLite 数据。

MIT；上游和借用组件归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

双端扩展整合后的独立 review 与根因修复见 [architecture-review.md](docs/validation/2026-10-12-architecture-review.md)，包含 SSE 初始化、原生输出预算、来源冻结、装配身份和本地计算生命周期的验证边界。

当前源码、实验与补丁移除的后续审查见 [整体架构审查](docs/validation/2026-10-12-global-architecture-review.md)，分别记录本地验证、剩余成本边界和未执行的云端验收。

免登录、个人 Key 加密存储与逐任务绑定的证据见 [BYOK 验证记录](docs/validation/2026-10-12-guest-byok.md)。真实供应商与云端部署单列为待验收，不用模拟 I/O 代替。
