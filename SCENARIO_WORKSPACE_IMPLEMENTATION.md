# 多布局与场景包开发指南

首期入口是 **Agent** 与 **创作画布**。报告是 Agent 场景中的工具能力，不是单独的创建模式。定时任务和插件市场保持入口占位。

## 运行与迁移

```sh
pnpm install
pnpm setup
pnpm dev
```

本地固定使用 `http://localhost:5173`。`0003_scenarios.sql` 是增量迁移：旧聊天的 ChatId、创建回执、DO 名、原生会话和文件路径均保留；实例目录只补充映射。迁移和兼容触发器可重复应用而不会重复映射。新实例的 scenarioId / workspaceId / ChatId / runtimeName 分别生成，内部 runtimeName 不从请求接受。

目录仍以 conversations 的 owner、generation、lifecycle 授权；scenario_instances 存放稳定身份和主聊天/运行定位。普通聊天在首次发送时创建，画布项目在点击创建时初始化空工作区与主聊天。创建重试沿用 requestId；不确认的初始化可通过目录重新打开。删除保留最小目录回执，先关闭 Pi 写入，再清除文件与存储，拒绝迟到初始化。不要直接删除目录行来代替项目删除。

## 扩展入口

- `scenarios.config.ts`：可信场景包 manifest 和场景组合。
- `src/scenarios/server.ts`：可信 server 入口注册，检查重复领域命令/查询。
- `src/scenarios/browser.ts`：可信 browser 懒加载视图入口，检查 manifest 引用。
- `extensions.config.ts` 的 `workspace`：复用现有 Extension 激活机制，向 Pi 安装工具与提示段。

不从服务器数据或用户输入动态 import 代码。使用本地目录或固定版本 npm 包，分别导入 manifest/server/browser；随应用构建部署。注册表诊断重复 ID、缺失依赖、依赖环、缺失视图/服务端入口、布局不支持与重复命令。

manifest 声明 `id / version / dependencies / views / layouts` 及可选 JSON config。scene 声明组合的 packs、默认 layout、主 view，以及可选 `activationObjectTypes`。普通聊天的 `report` 对象首次出现时可打开 Split。Studio 默认以工作区为主、聊天在右侧。`LayoutHost` 提供 conversation / primary / inspector 插槽；布局代码不创建新运行时、不提交输入。包的 browser 入口可导出现有 BrowserExtension 的 toolkit/ui/panels 和 layouts（布局 Adapter 元数据），与主 Extension 机制共用加载与诊断；领域对象不依赖 React Flow nodes/edges。

### 添加最小自定义包

`src/scenarios/example/` 提供无需修改宿主业务分支的例子：

1. 在 scenarios.config.ts 导入 exampleManifest，加入 packs，并把 `example-workspace` 加入 canvas scene 的 packs。
2. 在 scenarios/server.ts 导入 exampleWorkspacePack 并加入 serverPacks。
3. 把 example/browser 入口加入 scenarios/browser-loaders.ts 的 packageBrowserEntries。例子复用已注册的 canvas view，无需新增浏览器视图；独立视图则将对应 loader 加入 packViews，并在 manifest.views 声明。
4. 调用 `example.note` 后生成一个文字节点，继续使用同一工作区、撤销与订阅链。

`WorkspaceServerPack.commands` 注册命名领域操作，`queries` 注册按需读。包可通过 contribute(host, {env,config}) 返回原生工具/任务/钩子与现有宿主贡献，以 scenario.包名注册；不建立另一套执行系统。处理器使用 context.require / expect / put / remove 和原生 tx；使用 Zod 限定输入。`model:true` 允许 Agent 调用，否则仅用户可调用。`undoable:true` 为可逆编辑记录补偿操作。用户和 Agent 使用同一处理器；普通认证用户只能访问自己的实例。

包可选提供纯函数 `restoreObject(object, state)`：宿主解释撤销/重做快照时调用，将已完成的原生任务结果合入对象。它不能启动任务、发请求或复活已删除对象；仅规范化已有快照。画布包用此接口保留生成结果，使移动撤销与删除恢复都不会恢复过期的生成中状态。此接口也适用于修复升级前保存的撤销历史。

浏览器工作区命令的待确认回执按账号、实例保存在 Query mutation cache；路由变化只切换投影，重试始终携带原实例及原 requestId。输入引用与文本共用草稿版本，编辑排队消息时完整恢复引用后再确认接收。

应用 UI 使用 `src/browser/ui` 中的 shadcn 组件。业务 TSX 的裸表单控件由 ESLint 拦截；基础 UI 实现以及报告源码不在此限制范围。聊天输入和操作组合 assistant-ui 原语，通过宿主 HTTP 表单执行提交及停止，不启用第二条 AG-UI 提交路径。

## 工作区 Interface

通过已授权实例访问：

- `POST /api/scenarios/:id/workspace/read` `{query,input}`：snapshot / object / 包定义的有界查询。
- `POST /api/scenarios/:id/workspace/execute` `{requestId,name,input,expected}`。
- `GET /api/scenarios/:id/workspace/events`：独立于 runId 的 SSE。

execute 返回 `{status:'committed',objectIds}` 或 `{status:'accepted',objectIds,operationId}`。相同调用主体＋requestId＋相同命令重放原回执；改动命令内容返回 request_conflict。已有对象写入必须带 expected[id]=version。回执、对象和原生任务创建属于同一 Pi Session commit。处理器不发起外部请求；长任务用 tx.createTask，外部 I/O 放在原生 Task phase。

快照的 watermark 来自原生提交序号；失效帧用于合并刷新，不是可永久回放的事件日志。连接立即发当前水位，每60秒重连重新授权，15秒心跳。客户端断线保持现有快照，恢复后核对水位。对象 version 用于写入 CAS；contentVersion 只随内容变化推进，移动节点不使选区失效。

Session 文档：WorkspaceDoc（对象/资产/任务引用/有界撤销）、WorkspaceReceipts（命令回执摘要）、WorkspaceSelections（输入引用守卫）、ReportSources（不可变报告源码版本）。Pi 继续负责队列、执行、停止和恢复。浏览器只有投影，未增加任务调度器。

## 选择与 Agent

画布工作视图调用 `useWorkspace().select(refs)`，引用会显示在聊天输入框上方，可以删除。发送时复制到 RunCommand；服务端在写入接纳回执的同一事务中验证并保存有界摘要。改选不改变已提交输入。

首次模型执行前重新检查；每次工具写入再次检查。过期或删除目标返回 workspace_selection_conflict，需重新选择。Agent 自己成功修改选中对象后，只推进该轮输入的内部守卫；其他人的写入仍会产生冲突。源码通过 workspace_read 按需读取，不将整份报告加入常规上下文。

## 创作画布

React Flow 12 核心 MIT 包只充当视图 Adapter。支持文字/图片/生成中节点、拖动、多选、缩放、方向分组标签、重命名、删除、选定标记、派生关系、预览/下载、素材复用及有界撤销重做。组是组织标签，不是可执行流程。撤销只补偿业务编辑，不回滚任务或取消已付费生成。

canvas.generate 使用 images.generate 原生 Task：提交不确定性围栏、远端 ID、轮询、R2 存储和恢复与行内图片工具共用。unknown 不自动再次 POST。画布后台任务不依赖浏览器或一次回复的存活。删除节点保留素材、不会取消远端任务；迟到结果只进入素材列表，不重建节点。继续探索只是新文生图候选，不是参考图编辑。

## HTML 报告

workspace_execute 的 report.publish 创建/更新报告：`{id?,title,summary?,source,template}`，更新必须带 expected。summary 为不超过 240 字符的纯文本简介，用于消息中的报告卡片；旧回执没有简介时显示查看提示。标题和简介随源码逐版本保存，恢复历史版本时同步恢复。报告有稳定 ID，源文件和模板依赖逐版本冻结，整份源代码原子发布。发布前检查 JS 语法、未声明脚本/图片/嵌套资源和资产归属；失败保留旧稿。report.restore 创建新的当前版本，不改历史。

模板在 `src/scenarios/reports/template.ts` 声明固定依赖和基础样式。内置 general@1 使用 ECharts 5.6.0，加载完成后再执行报告源码。源码支持 HTML/CSS/JS；图片用 `workspace-asset:ASSET_ID` 或 data URL。交互组件可以修改报告自己的状态，不能直接调用宿主写入或访问凭据。动态运行错误显示在预览中，用户可要求 Agent 修复或恢复旧版本。

预览：opaque-origin iframe（仅 allow-scripts）、CSP 默认禁止网络/表单/嵌套页面，脚本仅内联及精确模板 CDN。应用内置 Penpal 8 的 bundle，通过一次性 MessageChannel 与版本 token 握手；宿主只暴露 ready/error；报告不采集文字选区或章节点击，不向聊天添加报告引用。切换对象/版本销毁旧连接和 Blob URL。宿主不接受报告发起任意 workspace.execute。浏览器 iframe 不提供 CPU/内存硬隔离。

导出：`GET /api/scenarios/:id/reports/:reportId/export?revision=N`，基于保存源码和冻结依赖组装一个 HTML，受管图片内嵌 data URL，完全不包含宿主桥接、账号接口或登录请求。打开文件仍需要网络加载 CDN；依赖失败有提示。嵌入图片总量限制20MiB，报告源码最大1M字符，每实例最多20份报告、每份100个版本。首期不打包离线依赖、不提供 PDF/DOCX。

## 验收与诊断

- `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test:unit`、`pnpm test:native`、`pnpm test:workers`、`pnpm build`。
- 浏览器通过 Ego Lite，使用同一 TaskSpace。可使用独立 native-e2e-state 的认证测试账号，不改变应用登录分支。
- 画布：生成三个方向→拖动/分组→选定→带引用继续探索→下载→刷新；生成中移动/删除节点不会重置任务。
- 报告：普通聊天请求交互报告→阅读与图表交互→切换旧版本→恢复→下载 HTML→关闭应用后打开文件检查 ECharts。
- workspace_conflict / workspace_selection_conflict：重新读取并明确选择，不自动重定向写入。
- image_submission_unknown：不自动重试付费提交，查看 provider 记录或由用户明确发起新请求。
- 配置缺失、任务停止/丢失、CDN 失败必须与生成成功区分。

单元/原生模拟验证、浏览器真实链路、真实模型/Kie付费生成及生产部署分别记录。未部署不代表线上已更新。

### 工作台多语言

工作台复用 `LocaleProvider / useLocale`，默认英文，支持设置中切换简体中文。项目目录、画布、报告、工具卡片、提示与无障碍标签的应用文案集中在 `src/browser/app/workspace-messages.ts`。新增场景视图应在渲染时调用 `t()`；请求失败优先保留稳定错误码，再在展示时翻译，避免语言切换后遗留旧语言的错误。

用户命名、节点正文、报告标题/简介/HTML 和 Agent 回复不作为翻译键。系统默认项目名通过 `titleCustom` 与用户命名区分，不改写存储内容。语言不参与查询键、实例身份或操作回执，也不重新提交任务。报告 iframe 的宿主依赖错误提示通过现有隔离通信更新，避免为切换语言重载图表；导出 HTML 的应用错误提示使用下载时的界面语言，报告正文保持原文。
