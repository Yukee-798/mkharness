# MkHarness

**搭建拥有持久化执行与可扩展 UI 的 Agent 应用。**

[English](README.md) · [简体中文](README.zh-CN.md)

MkHarness 是一个开源 Agent 应用模板，提供流式聊天、持久化执行，以及工具与交互结果的扩展能力。基于 **TanStack、Cloudflare、Pi 和 assistant-ui**，帮助你从可运行的工程开始搭建自己的 Agent 产品。

本地启动无需登录，在界面配置自己的 API Key，同一套应用可部署到 Cloudflare。

[快速开始](#快速开始) · [核心能力](#核心能力) · [扩展](#扩展-mkharness) · [部署](#部署到-cloudflare) · [常见问题](#常见问题) · [MIT 许可证](LICENSE)

[体验在线示例](https://template.mkharness.com)：使用 Google 登录后，无需填写 API Key 即可使用 `openrouter/free`。免费额度由示例站共享，模型效果与可用性可能波动，耗尽或限流时会停止并提示，不会切换至付费模型。个人配置可覆盖默认配置。

## 快速开始

准备 **Node.js 24**、**pnpm 11.17.0** 和一个受支持的模型 API Key。本地开发不需要 Cloudflare 账号，也不需要配置 Google OAuth。

```sh
git clone https://github.com/Yukee-798/mkharness.git
cd mkharness
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm setup
pnpm db:migrate
pnpm dev
```

打开 **http://localhost:5173**：

1. 在输入框选择模型。
2. 点击侧栏底部的访客菜单 → **Settings → Models & API Key**，填写 **模型名**、**Base URL** 和 **API Key**，点击 **Save configuration**。
3. 发送第一条消息。

应用界面默认英文。可在 **Settings → General → Language** 切换中文，在 **Appearance** 选择浅色、深色或跟随系统。偏好保存在当前浏览器，默认主题跟随系统。

可以先尝试提问、生成交互式计划或读取公开网页。网页搜索需要单独配置搜索 Key；`describe_text` 示例默认关闭。

> 在界面填写的 Key 会发送给当前部署，并在服务端加密保存，用于后台执行与恢复。请在自己的部署或可信部署填写。保存 Key 不会测试连接，首次模型请求才会实际使用它。

`pnpm setup` 生成缺失的本地认证与加密密钥。重启时保留 `.dev.vars`，该文件已被 Git 忽略。本地数据存储在 Cloudflare 本地 SQLite 中。统一使用 `localhost`，不要与 `127.0.0.1` 混用。应用界面默认英文，支持在设置中切换中文；两份 README 的配置说明保持一致。

## 核心能力

- **图片附件。** 复用 assistant-ui 预览与移除 PNG、JPEG、WebP、GIF；支持图片加文字或纯图片提交，需选择支持图片的模型。每条消息最多 4 张、合计 512 KiB，随 Pi 历史保留，用于重试和恢复。
- **可编辑的持久化队列。** 待执行消息在刷新后恢复。重新编辑会撤回尚未开始的消息并回填文字与图片；引导在 Pi 原生边界加入当前任务；移除只撤回选中的排队消息。已开始的任务不能通过队列操作撤回，Pi 始终是唯一队列权威。
- **可用的聊天应用。** 流式回复、思考过程、工具活动、模型与思考强度选择、聊天历史，以及回复和工具耗时。使用 assistant-ui、shadcn/ui 与 Tailwind CSS。
- **持久化 Agent 执行。** 每个聊天由独立 Durable Object 承载 PiHarness。支持提交排队、历史持久化和执行中断后重建；关闭浏览器只断开观察，Stop 是独立操作。删除在持久化受理并移除聊天目录后返回 `202`；原生生命周期 alarm 等待 runtime 关闭后清空存储，中断后继续清理。
- **前后端扩展。** 服务端接入 Pi 原生工具、提示词与 hooks；浏览器注册 assistant-ui Toolkit、工具标题装饰和回复 Footer。
- **交互式生成 UI。** 可选 OpenUI 扩展支持表单、表格、图表、输入保存，以及有资源限制的 QuickJS 计算。
- **远程集成。** 用户可添加远程 MCP 并通过原生 SDK 完成 OAuth，也支持部署级 HTTPS MCP 工具、静态 Skills，以及包含 submit/query/cancel 和恢复引用保存的异步服务示例。
- **免登录与个人 Key。** Better Auth 匿名会话隔离各浏览器的数据；用户自行配置模型名、Base URL 与 API Key，也可启用 Google 登录和部署默认 Key。

你可以在此基础上搭建调研助手、数据工作流，或调用自有服务的创作 Agent。MkHarness 提供应用与执行基础设施；业务工具、生图/视频服务、计费与订阅由你按需接入。

## 扩展 MkHarness

目录职责见[源码架构](ARCHITECTURE.md)；本轮清理、问题修复与剩余架构风险见[工程审查](ENGINEERING_REVIEW.md)。

扩展是经你审核、随应用部署发布的受信任代码。服务端能力与浏览器展示各有独立的静态装配入口，工具可以接入专属 renderer，无需在核心聊天逻辑增加工具名分支。

| 扩展内容                             | 从这里开始                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Agent 工具、提示词片段、hooks        | [`src/extensions/server.ts`](src/extensions/server.ts) — Pi 原生 Extension                                |
| 工具 renderer、标题装饰、回复 Footer | [`src/extensions/browser.ts`](src/extensions/browser.ts) — assistant-ui Toolkit 与浏览器贡献              |
| 生成 UI、资源、输入状态、继续动作    | [`src/extensions/openui/`](src/extensions/openui/) — 完整的可选扩展                                       |
| 静态 Skills                          | [`src/server/skills/static.ts`](src/server/skills/static.ts)                                              |
| 部署级 MCP 工具                      | [`src/server/mcp/deployment.ts`](src/server/mcp/deployment.ts) — `MCP_SERVERS` 配置                       |
| 异步服务                             | [`src/extensions/async-example/`](src/extensions/async-example/) — 按实际服务契约接入 submit/query/cancel |

最小工具示例只需在 [`extensions.config.ts`](extensions.config.ts) 将 `example.enabled` 设为 `true`。其[服务端工具、提示词与 hook](src/extensions/example/server.ts)及[浏览器 renderer](src/extensions/example/browser.tsx) 统一放在 `src/extensions/example/`，默认不启用。[耗时扩展](src/extensions/timing/)演示如何装饰已有工具和回复。

成功的网页读取和搜索从 Pi 已提交结果生成 Sources 来源卡片。回复扩展使用 assistant-ui 原生后续提问按钮，并在操作栏增加重新生成。后续提问是随语言切换的通用提示，不额外调用模型。重新生成以新操作引用原始提交内容（含表单上下文），保留原回答，使用当前模型设置；它不会授权自动重放结果未知的远端副作用。

所有扩展启停统一在 [`extensions.config.ts`](extensions.config.ts) 配置：`openui.enabled: false` 同时关闭 OpenUI 的工具、提示词、资源、动作、界面和计算；`skills-example.enabled: true` 启用静态 Skill 示例。timing、web、reply、async-example、example 和宿主 MCP 接入使用同一个文件，`openui.inspect` 控制开发检查器。修改后重新构建部署，或重启本地开发服务；原有扩展专用环境变量不再使用。网页搜索仅在配置 `TAVILY_API_KEY` 时注册，读取网页不需要搜索 Key。

OpenUI 表单目录已包含单值或范围滑块、开关、日期、下拉选择、复选框与文本输入。`Progress` 使用 shadcn/ui 展示实际测量或计算得到的进度。例如，以下内容在滑块改变后本地更新进度条，编辑时不调用 Agent：

```text
$amount = [40]
root = Stack([
  Slider("amount", "continuous", 0, 100, 1, null, "数值", null, $amount),
  Progress($amount[0], "目标", 100, true)
])
```

范围滑块使用两个值，例如 `[20, 80]`。进度未知时使用 `Progress(null, "等待数据")`；它不会自动追踪后台 Agent 任务。

具体接口与配置见[服务端契约](src/server/extensions/contributions.ts)、[浏览器契约](src/browser/extensions/extensions.ts)及 [.dev.vars.example](.dev.vars.example)。不包含运行时插件安装器或外部插件市场兼容层。

异步服务示例以 `async-example` contribution 接入服务端与浏览器注册表。配置 `ASYNC_SERVICE_URL` 后安装其原生工具和任务；未配置服务时，扩展仍可展示和保护已有任务的未知结果。服务协议、重试与复查授权、原生任务恢复和进度卡片都位于该扩展目录。要完全停用示例，在统一配置中将 `async-example.enabled` 设为 `false`，基础聊天、历史、Stop 和 MCP 保持独立。

宿主提供三个执行接入点：模型请求前的 `beforeModel`、队列空闲且新请求入站时的 `beforeSubmit`、恢复时遇到不兼容任务的 `taskUnavailable`。原生文档通过 `stateDocuments` 和 `projectState` 投影到公开状态，浏览器通过 `composerFooter` 展示会话级控件，执行仍由 Pi Durable 管理。已有任务和文档的持久化标识保持不变；已接受的旧动作仅由示例内部兼容解析。新的重试、复查统一使用 `extension_action`，指定 `extensionId: "async-example"` 与经过校验的 `{ taskId }`。MCP 保留独立保护逻辑，对旧共享文档中的示例字段只做不透明保留，不导入示例代码。

通用 JSON 校验、大小限制和规范化比较位于 `src/shared/json.ts`，不导入计算引擎。QuickJS、计算预算、浏览器 Worker、WASM 接入和构建集成都属于 `src/extensions/openui/`。构建时关闭 OpenUI 会排除该扩展的浏览器与服务端入口及计算资源；核心聊天、MCP、请求处理和 JSON 工具不导入 QuickJS。模板的依赖清单仍保留相关包，供启用 OpenUI 时构建使用。服务地址、API Key 和 MCP 连接定义仍放在服务端绑定中，它们负责连接参数，不负责扩展启停。关闭 MCP 会停止建立连接及注册工具，宿主仍保留已有未知结果的保护记录。

## 自定义远程 MCP 连接

在 **设置 → 连接 → 添加连接** 中填写名称和公开 HTTPS Streamable HTTP 地址（例如 `https://mcp.notion.com/mcp`）。自动 OAuth 复用 Cloudflare Agents SDK 的服务发现、客户端注册、PKCE、回调校验、令牌交换与刷新。HTTPS 部署通过 `/api/mcp/client-metadata` 发布客户端元数据；不支持动态注册或客户端元数据的服务，可在高级设置填写预注册 Client ID 和 secret。兼容性取决于服务端，未内置各家非标准 OAuth 流程。本地匿名身份与云端登录账号均拥有各自的连接。

新发现的工具默认 **每次询问**，也可逐个禁用或自动允许。新聊天固定当时启用的工具定义，真正派发前再次检查当前权限和连接状态；工具定义或授权身份变化后需创建新聊天。确认卡片跟随对应的工具调用展示，刷新后可恢复；拒绝和 Stop 会阻止尚未派发的请求。已派发但未确认结果的操作标记为 **结果未知**，不会自动重发，该连接在外部核对前保持阻塞；本版尚未提供手动核对结果的操作。断开连接会删除本地令牌；如需撤销服务商授权，还需在服务商处单独操作。

配置界面复用 `@assistant-ui/react-mcp` 原语，通过展示适配器操作现有后端；确认卡片复用 assistant-ui 官方 registry 组件。连接、OAuth 凭据和工具执行仍由服务端管理，浏览器不启用默认 MCP Manager、不持久化连接凭据，也不注册前端工具。确认决定通过扩展 control 接口更新已有 Pi 任务。

`mcp.enabled` 管理所有 MCP 接入，`mcp.custom` 单独管理用户自定义连接。现有部署需先应用 D1 增量迁移 `0007_mcp_connections.sql`，并配置 `MCP_CONNECTIONS` SQLite Durable Object 绑定。Bearer、OAuth 客户端 secret 和令牌使用 `CREDENTIAL_ENCRYPTION_KEY` 在连接 DO 内加密保存；该密钥应保持稳定，凭据不会进入聊天绑定或公开状态。

模块分工：

- `src/server/mcp/connections/`：账号归属、连接目录、加密存储、原生 SDK 适配、HTTP 路由和端点策略。
- `src/extensions/mcp/`：通过 Pi 原生工具、任务和文档实现确认与中断恢复，通过现有扩展插槽呈现界面。确认决定走通用扩展 control 接口，不会启动第二次模型请求。
- `src/server/mcp/deployment.ts`：保留部署级 `MCP_SERVERS`，与用户连接凭据独立。

首版支持公开 HTTPS Streamable HTTP、受限 JSON 工具 schema、文本和结构化 JSON 结果。不支持的 schema 会展示但无法启用。不会执行本地 stdio 命令或抓取远程 schema 引用，暂未将 MCP Apps、sampling、resources 和 prompts 作为产品能力开放。MCP 和 OAuth 请求均限制私网/保留地址、重定向、超时和响应大小，并做 DNS 预检；DNS 预检属于纵深防御，需要严格抵御 DNS 重绑定的部署还应配置网络出口隔离。

## 用户技能

在 **设置 → 技能 → 导入技能** 上传 Markdown `SKILL.md`，或仅包含一个技能目录的 ZIP，预览说明、文件清单与兼容性提示后保存。Skill 需要 YAML frontmatter 中的 `name`、`description` 与非空 Markdown 正文；如包裹在目录中，目录名应与 `name` 一致。支持参考文档和文本模板，脚本仅保存/读取为文本，不会执行；二进制资源会保留，但本版 Agent 暂不支持读取。Skill 不授予工具权限，也不提供凭据。

新聊天默认选择账号已启用技能，可在设置 → 技能中管理启停。服务端创建聊天时绑定不可变内容版本；更新、停用或从库中删除仅影响新聊天，已有聊天保留绑定版本与已加载说明。删除是移出技能库，不会擦除历史版本。最多保存 32 个在库技能、每个聊天最多选择 8 个；上传最多 1 MiB、解压后最多 2 MiB、单文件最多 128 KiB、每包最多 64 个文件。

运行时复用 `agents/harness/pi` 的 `skills(sources)`，通过 `SkillSource` 读取已经校验归属的固定版本。原生 `activate_skill` 与 `read_skill_resource` 将正文和资源作为普通工具结果提交到 Pi 历史。目录先进入提示词，正文在激活时进入模型上下文；SDK 目前仍会在初始化时读取正文，因此只装载当前聊天选择的版本，参考文件按需读取。技能调用与版本保留在工具记录中，输入框不常驻展示技能或连接摘要。MCP 调用继续使用现有权限与确认机制，不增加 CLI 宿主、第二套执行循环、自动脚本运行器或 OpenUI/QuickJS 耦合。

`extensions.config.ts` 中的 `skills.enabled` 控制启停。现有部署启用前需应用 `0008_skills.sql`，并为 `SKILL_FILES` 配置**私有 R2 存储桶**。D1 保存账号归属、修订、版本元数据与聊天绑定，R2 保存不可变文件，读取时验证内容哈希。请创建目标 Wrangler 环境配置中的桶，例如样例生产配置使用 `pnpm exec wrangler r2 bucket create mkharness-template-skills`；这是 D1 迁移之外的新资源。旧的 `skills-example` 仍可单独启用；同时启用时，两类来源共用一个原生 Skills 扩展。

- `src/server/skills/`：受限导入校验、D1/R2 目录、固定版本来源和鉴权管理路由。Frontmatter 使用与 SDK 相同的 YAML 库，避免其公共解析入口连带加载可选脚本运行器依赖。
- `src/extensions/skills/`：原生 Pi 接入、结果投影、浏览器选择与展示。用户上传的包是数据，不会成为可执行扩展模块。

## 部署到 Cloudflare

应用运行在 **Workers + D1 + SQLite-backed Durable Objects** 上。首次部署需要完成以下资源与密钥配置。

### 1. 创建资源

安装依赖后执行：

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create mkharness
```

修改 [`wrangler.jsonc`](wrangler.jsonc) 的**顶层配置**：

| 配置                                            | 填写内容                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `name`                                          | `mkharness`，或自己的 Worker 名称                                |
| `d1_databases[0].database_name` / `database_id` | `d1 create` 返回的名称和 ID，替换全零本地占位 ID                 |
| `vars.APP_URL`                                  | 实际公开 origin，例如 `https://mkharness.<你的子域>.workers.dev` |
| `vars.AUTH_MODE`                                | `guest`，无需登录页面即可使用                                    |
| `vars.ALLOW_SERVER_MODEL_KEY`                   | `0`，只使用个人 API Key                                          |

保留 `DB` 和 `CONVERSATIONS` binding、`ConversationAgent` 类名及迁移定义。仓库的 `env.test` 是开发参考资源；使用该环境时替换为自己的资源。

### 2. 设置 Secrets 并部署

编辑配置后先构建，让 Wrangler 使用对应的生成部署配置：

```sh
pnpm build
pnpm exec wrangler secret put BETTER_AUTH_SECRET
pnpm exec wrangler secret put CREDENTIAL_ENCRYPTION_KEY
pnpm exec wrangler d1 migrations apply DB --remote
pnpm deploy
```

执行两次 `openssl rand -base64 32`，生成**两个独立密钥**，在对应的 Secret 提示中输入。加密密钥必须编码恰好 32 字节随机值。设置首个 Secret 时若 Wrangler 提示创建 Worker，可同意创建。

跨部署保留这两项密钥，更换加密密钥会导致已有凭据无法解密。已有安装也需要保留 Worker 名称、数据库 ID 与 Durable Object 身份。[环境在构建时选择](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/)，修改配置或切换环境后重新构建。

### 3. 打开应用

访问部署网址，通过侧栏菜单配置个人 API Key。访客模式不需要 Google 凭据，也不需要部署默认模型 Key。

需要 Google 登录时，设为 `AUTH_MODE=account`，通过 Secrets 配置 `GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET`，并注册 `https://YOUR_DOMAIN/api/auth/callback/google` 回调；来源须与 `APP_URL` 一致。

Cloudflare 与模型调用分别计费，请核对账号的 [Durable Object 限制](https://developers.cloudflare.com/durable-objects/platform/limits/)。资源需要手动创建，模板不提供自动化一键部署或费用硬上限。

## 架构

```mermaid
flowchart LR
  UI[浏览器：TanStack + assistant-ui] -->|HTTP 提交 / SSE 观察| API[Workers：Hono + Better Auth]
  API --> DB[(D1：身份、目录、加密凭据)]
  API --> DO[聊天 Durable Object：PiHarness]
  DO --> History[(DO SQLite：执行历史)]
  DO --> Tools[Pi Extensions / Skills / MCP / 远程服务]
```

**Pi 负责执行历史与结果，Query 负责读取缓存，assistant-ui 负责聊天展示。** 提交、观察与 Stop 独立。远程副作用需要供应商提供幂等或调和能力，持久化执行本身不保证操作只执行一次。

如需在自己的部署提供同样的免费默认配置，设置 `MODEL_PROVIDER=openrouter`、`MODEL_ID=openrouter/free`、`MODEL_THINKING_LEVEL=off`、`ALLOW_SERVER_MODEL_KEY=1`，将 OpenRouter Key 保存为 Worker 的 `MODEL_API_KEY` Secret。部署 Key 只允许 `MODEL_ID` / `MODEL_IDS` 明确配置的模型；个人 Key 可使用其他已注册模型。未配置付费回退。Agent 每轮推理及压缩都会消耗一次供应商请求，一次聊天可能使用多次免费请求。[OpenRouter 免费路由说明](https://openrouter.ai/docs/guides/routing/routers/free-router)。

## 常见问题

<details>
<summary><strong>访客身份和 API Key 如何保存？</strong></summary>

每个浏览器拥有经过认证的 Better Auth 匿名会话。清除 Cookie 或更换浏览器后无法找回原访客身份；不包含跨浏览器恢复和访客到账号的数据迁移。

Key 在 D1 中使用 AES-256-GCM 加密保存，不写入聊天历史。可选的“在此浏览器记住 API Key”会将明文副本保存在当前身份的 localStorage，退出时清除；不会自动重新上传。部署者持有加密密钥，可以解密凭据。最近保存的个人模型成为新提交的默认选择；同一供应商的个人 Key 优先于部署默认 Key。默认 `ALLOW_SERVER_MODEL_KEY=0` 要求用户提供 Key；设为 `1` 并配置 `MODEL_API_KEY` 可提供由部署者承担费用的默认 Key。

本地模板的默认模型列表只显示 DeepSeek-V4.1-Flash（`deepseek-flash`）。填写的模型名必须已在 Pi 原生目录中注册；可通过 `MODEL_IDS` 配置额外模型。

已知供应商地址会选择对应的 Pi 原生供应商。自定义 Base URL 必须是公开 HTTPS 地址，并支持所选供应商的 API 协议；修改自定义网关地址不会推断其他协议。拒绝重定向和私有网络地址。

</details>

<details>
<summary><strong>执行过程中修改模型设置会怎样？</strong></summary>

每条新接受的消息更新当前会话配置。Pi 在每次模型调用准备上下文前，快照模型、思考强度和不可变凭据引用。排队消息和工具后的下一轮使用当前会话配置；已准备的请求 checkpoint 在恢复时保留原版本。

单独保存 Key 或 Base URL 不更新运行中的会话，下一条新接受的消息才将该版本应用到尚未准备的调用。生成重试重新进入 prepare 时使用当前配置；压缩独立选择配置，之后的恢复和重试保留其摘要 checkpoint。

退休凭据版本最多保留七天。移除 Key 会撤销该供应商全部版本。快照凭据无效、撤销、过期或不可读取时明确失败，不静默回退到新 Key 或部署默认 Key。行为验证见[逐步骤配置测试](tests/workers/task-binding.test.ts)。

</details>

<details>
<summary><strong>模板不包含哪些能力？</strong></summary>

未内置附件、R2 素材、云端电脑/沙箱、支付和订阅。图片与视频生成需要接入服务扩展。接口可能随模板迭代调整。

</details>

<details>
<summary><strong>是否对依赖打了补丁？</strong></summary>

Pi Durable 使用未打补丁的原生逐步骤配置。`agents` 仅保留两个独立修复：Skills 结果桥接和失败 Session 缓存释放。原因及移除条件见[补丁说明](patches/README.md)。

</details>

## 开发与贡献

```sh
pnpm check                          # lint、格式、类型、unit/workerd 测试及构建
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:hmr
```

E2E 使用隔离的 `.wrangler/e2e-build` 产物运行 Cloudflare Vite 生产预览。组件夹具单独打包，不进入正常部署产物；HMR 测试独立验证开发服务器。

测试使用受控模型 I/O。请在自己的环境验收真实供应商请求、刷新/重连、Stop 和跨部署恢复；这些测试不代表真实云端验收。

欢迎[提交 Issue](https://github.com/Yukee-798/mkharness/issues) 或 Pull Request。报告问题时附上复现步骤、依赖版本与脱敏日志，不要包含 API Key 或 `.dev.vars`。

## 许可证

[MIT](LICENSE)。上游依赖与借用组件归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
