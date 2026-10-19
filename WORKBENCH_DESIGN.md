# 工作台与可扩展工作面板详细设计

日期：2026-10-18。状态：A、B 批次已在本地实现；C、D 为后续设计。

本文件记录已确认的产品方向、设计依据和实施顺序。第 1–12 节保留设计时的拟议契约；OpenUI 的默认右侧预览方案已被本次行内交互设计替代。当前实际 Interface、文件落点和范围以第 13 节及 TypeScript 源码为准。

## 1. 已确认的产品范围

- 使用统一、可折叠的左侧边栏。
- 导航包含 Agent、定时任务和插件市场；首页保持 Agent。
- 最近聊天与账号设置保留在同一侧栏。
- Agent 页右侧是开发者可扩展的工作面板（Workbench Panel）。
- 模板默认提供产出预览；浏览器、云端电脑和其他内容由开发者注册对应 Adapter。
- 插件市场本期提供入口和占位页，安装、目录与包协议留待后续设计。
- 本次交付本地应用改动；提交和部署另行执行。

## 2. 现有工程事实

以下事实已按本次 checkout 核对。

| 现有位置                                      | 可复用能力                          | 接入时需要处理的事项                |
| --------------------------------------------- | ----------------------------------- | ----------------------------------- |
| `src/browser/app/AppShell.tsx`                | 可折叠侧栏、手机 Sheet、账号区域    | 将聊天目录壳扩展为工作台导航        |
| `src/browser/app/App.tsx`                     | 身份、目录、设置、聊天创建和选择    | 分开工作台状态与当前聊天展示        |
| `src/routes/index.tsx`                        | `/?chat=...` 深链及 `mcp` 回调参数  | 增加导航目的地并保持现有入口可用    |
| `src/browser/chat/session/`                   | 单次创建/提交身份、观察、历史、恢复 | 聊天与面板共同使用同一次会话绑定    |
| `src/browser/extensions/extension-loading.ts` | 账号级贡献发现与下载缓存            | 复用加载结果收集面板贡献            |
| `src/browser/extensions/extensions.ts`        | Toolkit 与 UI 装饰贡献              | 增加独立于消息装饰的面板贡献字段    |
| `src/extensions/openui/browser.tsx`           | 工具内展示、流式预览、资源引用      | 将完整内容接入右侧，消息内保留入口  |
| `src/extensions/openui/Panel.tsx`             | 资源读取、交互、继续分析            | 作为首个产出预览 Adapter 的实现基础 |
| `src/extensions/openui/panel/session.ts`      | 输入 epoch、计算溯源、卸载清理      | 保持现有计算与晚到结果隔离规则      |
| `src/browser/extensions/ResourceDrafts.tsx`   | 跨聊天展示卸载的草稿存续            | 放在账号工作台生命周期内            |
| `src/server/chat/resources.ts`                | 已授权资源读取及输入状态 CAS        | 继续作为 OpenUI 资源入口            |

当前 OpenUI 资源的 `revision` 是交互输入状态的 CAS 修订号。它不等同于报告、图片或视频的内容版本。

当前 `timing` 记录工具和回复耗时。用户级定时计划及其管理页面仍需新增。

## 3. Module 与 Seam

```text
WorkbenchShell
├── UnifiedSidebar
└── AgentWorkspace / ScheduledPage / PluginPlaceholder
    └── AgentWorkspace
        ├── 当前 Conversation 的唯一浏览器会话绑定
        ├── assistant-ui 聊天展示
        └── WorkbenchPanelHost
            └── 已注册的面板 Adapter
                ├── 模板：产出预览
                ├── 应用扩展：浏览器
                └── 应用扩展：云端电脑等
```

| Module             | Interface 承担的行为                 | Implementation 的职责                                      |
| ------------------ | ------------------------------------ | ---------------------------------------------------------- |
| WorkbenchShell     | 导航和当前页面                       | 统一侧栏、目录、设置、布局偏好、页面切换                   |
| WorkbenchPanelHost | 接受打开目标、收起和恢复面板         | 注册表、目标校验、实例身份、激活规则、尺寸、窄屏与故障隔离 |
| Conversation       | 现有提交、观察、停止和历史 Interface | 复用会话恢复和 Pi 事实投影                                 |
| 产出预览           | 打开资源并呈现其可用操作             | OpenUI、图片、报告和视频各自的内容语义                     |
| Schedules          | 保存计划、暂停、立即运行和读取记录   | 时间计算、触发投递、稳定运行身份与结果关联                 |

主要 Seam 位于浏览器贡献和 WorkbenchPanelHost 之间。Host 对具体内容的知识集中在贡献声明中；资源读取、版本、浏览器连接和电脑控制属于各自 Adapter。

宿主注册表是 WorkbenchPanelHost 的内部 Implementation，不单独拆成只有转发作用的 Module。

## 4. 工作面板的拟议 Interface

### 4.1 开发者注册

在现有 `BrowserExtension` 上增加可选的 `panels` 字段。Toolkit、消息装饰和面板贡献共享启用状态与模块下载缓存。

```tsx
type BrowserExtension = {
  toolkit?: Toolkit;
  activity?: Record<string, 'visible' | 'hidden'>;
  ui?: ExtensionUI;
  panels?: Readonly<Record<string, WorkbenchPanelDefinition>>;
};
```

`panels` 使用扩展内的局部名称。加载器结合扩展 ID 形成 `extensionId/localName`，例如 `openui/preview`。加载器必须验证声明，并保留现有声明顺序和局部失败语义。

开发者定义一个面板需要声明以下内容；具体 TypeScript 泛型封装留在 Implementation 内收敛：

```tsx
type PanelDefinition<T> = {
  scope: 'conversation' | 'workspace';
  parse: (input: unknown) => T;
  key: (target: T) => string;
  title: (target: T) => string;
  Content: React.ComponentType<{
    target: T;
    visible: boolean;
    conversation?: ConversationPort;
  }>;
};
```

- `parse` 在首次打开和恢复引用时执行，校验有限 JSON 与目标结构。
- `key` 为同一实际资源返回稳定标识，返回值与请求体积均需有界。
- `scope` 由开发者声明，账号和聊天归属由 Host 补入；打开请求不能自行选择其他账号。
- `title` 是同步展示标签。需要异步资源名称时，由 Adapter 加载后在内容区呈现。
- `Content` 自己加载资源、呈现状态、提供内容工具栏并处理资源错误。
- `visible` 告知当前是否实际展示，供视频、画面解码或高频绘制暂停显示工作。
- `ConversationPort` 只投影当前聊天身份与已存在的提交能力，不暴露 Pi、密钥或任意存储写入。

关闭、最大化和通用重试属于 Host。下载、内容版本、地址栏、断开连接、关机等操作放在内容工具栏中；出现实际复用需求后再提取工具栏插槽。

### 4.2 调用方打开面板

```ts
type OpenPanelRequest = {
  type: `${string}/${string}`;
  target: Json;
  activation: 'explicit' | 'suggested';
};

type OpenPanelResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'unavailable' | 'invalid_target' | 'conversation_required';
    };

openPanel(request: OpenPanelRequest): OpenPanelResult;
hidePanel(): void;
```

```ts
openPanel({
  type: 'openui/preview',
  target: { ref: panelRef },
  activation: 'explicit',
});
```

`openPanel` 接受一个展示请求，不等待远端内容完成加载。远端加载中的状态、权限失效和资源不存在，由 Adapter 的内容展示承接。注册缺失和目标无效不会打开新的活动面板。

同一个作用域、面板类型和资源 key 再次显式打开时，复用同一实例身份并更新目标。建议请求先应用激活规则，即使 key 相同也不能静默替换当前目标。Host 不推断目标里的字段是否为版本、网址或电脑 ID。

### 4.3 激活规则

- `explicit` 用于用户点击消息入口或其他明确操作，可选中目标并展开面板。
- `suggested` 用于新产出的展示建议；仅在当前无活动内容且用户没有主动收起时展开。
- 已有活动内容时，新建议进入一个可点击提示，保留当前阅读或操作位置。
- 主动收起后，建议不会强行重新展开；用户点击入口恢复。
- 面板挂载和恢复本身不能发送模型请求或创建收费资源。
- Agent 工具只产生经宿主识别的资源引用和状态，不能提供可执行的浏览器模块 URL。

首期同时只展示一个面板。暂不增加通用多标签管理器或任意分屏布局编辑器。

## 5. 状态、生命周期和恢复

### 5.1 三种不同状态

| 状态         | 归属                      | 例子                                    |
| ------------ | ------------------------- | --------------------------------------- |
| 展示状态     | WorkbenchPanelHost        | 展开、宽度、最大化、当前选择            |
| 内容交互状态 | 对应 Adapter 及其草稿机制 | OpenUI 输入、报告编辑草稿、视频播放位置 |
| 远端资源状态 | 对应服务端能力            | 浏览器会话、电脑电源、生成任务状态      |

Host 保留资源引用与展示偏好。具体资源是否存在、是否有权读取以及如何结束，由该资源自己的服务端 Interface 决定。

### 5.2 实例身份与作用域

- 会话面板身份包含账号、ChatId、服务端返回的原生 conversation target、面板类型和资源 key。
- 工作台面板身份包含账号、面板类型和资源 key。
- 原生 target 从快照和现有授权读写链路获得；新聊天占位值 `conversationId=0` 不能形成可持久化资源身份。
- 账号切换后清理活动面板、恢复引用和账号缓存，停止上一账号的观察与画面传输。
- 删除聊天后清理其面板引用和草稿，并沿用当前服务端删除协议。
- 工作台资源的真实授权归属仍由 Adapter 的服务端验证，UI scope 不扩大权限。

### 5.3 生命周期约定

| 操作               | Host 行为                                                      | Adapter 行为                                      |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------------- |
| 收起               | 隐藏活动面板，保留选择                                         | 根据 `visible=false` 暂停展示工作，保留可恢复状态 |
| 最大化或拖动       | 更新布局                                                       | 保持相同资源身份与草稿                            |
| 打开另一个资源     | 切换活动实例                                                   | 旧实例卸载时释放订阅；未保存草稿按其既有机制保留  |
| 切换聊天           | 当前为会话面板时恢复新聊天的选择；当前为工作台面板时继续展示它 | 会话级内容释放旧观察，不停止服务端任务            |
| 进入定时任务或市场 | Agent 展示区退出活动展示                                       | 释放视图订阅；保留可恢复引用                      |
| 返回 Agent         | 恢复选择并重新验证目标                                         | 重新读取或连接已存在的资源                        |
| 资源结束或授权失效 | 保留可理解的错误展示                                           | 提供该资源适用的重连、返回或明确创建操作          |

卸载只释放本地观察、连接句柄和显示计算。主动销毁远端资源需要资源自身的明确命令。Adapter 的自动空闲回收策略属于其服务端资源生命周期，不通过 React cleanup 实现。

### 5.4 恢复数据

- 本地只保存有界的布局偏好、可序列化目标和选择信息，包含账号与作用域键。
- 保存目标前要求 Adapter 的目标结构适合本地恢复；敏感凭据、签名连接地址、文件正文和电脑画面不进入本地引用记录。
- 第一批 OpenUI 目标仅保存不含凭据的资源 ref。
- localStorage 不可用时保留当前页面可用性。
- 恢复先检查贡献是否启用，再由 Adapter 经授权入口读取目标。404、过期和撤权保留为明确状态。
- 模块加载、授权读取和页面恢复都不能自动创建替代浏览器、云电脑或生成任务。

## 6. 模板默认的产出预览

首个正式 Adapter 使用 `openui/preview`：将现有 OpenUI Panel 接入 Host，作为模板默认产出预览。浏览器与云端电脑在本文件中定义接入方式，首批不接入真实提供方。

消息内入口继续通过 assistant-ui 的 Toolkit 与消息原语呈现；右侧完整视图复用 `Panel`、`PanelSession`、`ResourceDrafts` 和服务端 resource/action Interface。

完整交互编辑器在同一活动资源上只存在一份。消息内保留生成状态、摘要与打开入口。需要轻量预览时使用只读展示，避免两个独立编辑器争用同一个 CAS revision。

### 6.1 流式草稿与提交后的内容

- 流式生成阶段根据工具调用身份展示草稿，使用当前已有的进度与消息身份映射。
- 草稿可以在右侧只读预览，交互要等到可授权读取的资源 ref 提交成功后启用。
- 草稿到正式资源的身份衔接由 OpenUI Adapter 管理；Host 不解析工具参数或原始 UI 文本。
- 草稿身份使用现有 canonical message/tool identity；正式提交后保留该工具与资源 ref 的关系。
- 失败或停止保留明确状态，之前已提交的其他资源仍可打开。

### 6.2 图片、报告、视频的演进

后续产出批次为实际生成工具定义资源描述：名称、媒体类型、内容版本、来源、就绪状态、私有文件引用和可用操作，并接入相同 Host。

当前资源 ref 与输入状态 CAS 可以支持首个 OpenUI Adapter。跨工具资产目录、文件导出和内容版本账本是产出 Module 的新增能力，不能将当前 CAS revision 直接复用为内容版本。

产出目录使用独立、可恢复的定位投影，使未加载到聊天视口的旧消息产出仍能找到。Pi 原生工具结果和资源事实保持权威，目录负责定位。文件按需读取，大型媒体不进入实时聊天帧。

图片、报告和视频在具体生成工具接入后拥有相应 Adapter。等到实际共享列表、版本与文件交互形成稳定需求，再将它们聚合成统一产出选择器；通用 Host 无需随之更改。

## 7. 与 Conversation 的接入

`WorkbenchProvider` 和 `ResourceDrafts` 存活于账号工作台生命周期。当前 Conversation 的绑定存活于 AgentWorkspace，不由某个面板创建。

需要将当前 `ChatRuntime` 中承担上下文提供的部分与 `ThreadPrimitive` 展示部分分开，使聊天消息及需要这些上下文的面板共享同一份现有 runtime/config。所有抽取均保留现有 `useConversationSession` 的提交、历史与恢复行为。

工作台级面板依赖可更新的 `ConversationPort`，不保留上一聊天的闭包。无活动聊天时，会话相关操作需要先选择聊天或由用户明确发起新聊天。

OpenUI 的“继续分析”继续使用既有 `extension_action` source 与服务端 `actions.continue.normalize`。新工作面板的注册本身不新增工具权限。

页面离开时本地观察可以释放；服务端 Pi 继续持有执行与恢复职责。输入区未发送文本、附件和已接受但确认未完成的提交回执需要按账号与聊天保留，避免导航时丢失。附件仍走现有有界数据与生命周期规则，不复制到面板恢复存储。

## 8. 导航和布局

首批建议沿用现有根路由，在 search 中增加有界的 `view`：

| 地址                     | 页面                     |
| ------------------------ | ------------------------ |
| `/` 或 `/?view=agent`    | Agent 欢迎与新聊天       |
| `/?chat=<id>`            | 现有聊天深链，默认 Agent |
| `/?view=agent&chat=<id>` | 显式 Agent 聊天          |
| `/?view=schedules`       | 定时任务                 |
| `/?view=plugins`         | 插件市场占位             |

保留 `mcp=connected/error` 回调处理。导航通过同一个地址编码位置来更新，避免聊天选择覆盖 `view` 或错误消费 OAuth 回调参数。无需为壳改造同时迁移全部 URL。

点击 Agent 返回上次选择的聊天；点击新聊天回到欢迎页。最近聊天在其他页面仍可直接进入对应聊天。

侧栏展开宽度以现有 16rem 为起点；收起以现有 3.5rem 为起点。右侧按内容需要分配宽度，并为聊天保留可读的最小空间。空间不足时使用手机 Sheet 或独立阅读层，保持相同的资源身份和草稿，不在窄屏挂载第二个编辑器。

应用 UI 统一使用 shadcn/ui 与 Tailwind CSS。先复用当前 Button、Sheet、Dialog、Tabs、Tooltip、ScrollArea 和主题；如需 Sidebar、Resizable，使用同一体系补齐。聊天、工具、附件和回复操作继续使用 assistant-ui 原语。

## 9. 定时任务的详细范围

定时任务页面区分计划与每次运行。计划定义任务要求、时区、触发规则、模型配置和所需能力；每次运行拥有稳定 occurrenceId、计划版本快照、提交 runId、聊天引用及结果。

- 默认每次运行建立独立执行上下文，通过计划归组。
- 保存计划、后台触发和手动“立即运行”都通过同一个调度 Interface 处理。
- 投递重试复用已保存的聊天创建 requestId 与提交 runId。
- 暂停影响后续触发；停止当前运行沿用会话 Stop。
- 修改影响后续尚未开始的运行；已开始的运行使用已保存快照。
- 计划明确保存所选 MCP、Skill 和版本/修订引用；运行时重新校验有效性，生成该轮冻结绑定。权限撤销或所选版本不可用时标记需要处理，不静默扩大到账号全部默认能力。
- 同一计划默认不重叠执行，跳过的触发进入运行记录。
- 漏过多次触发时默认合并为最近一次到期工作，并记录遗漏；不批量补跑全部历史时点。
- 等待用户决定、凭据失效和外部结果未知分别呈现，重试遵守原有执行与外部操作语义。
- 每次接纳冻结实际模型、端点与凭据版本，恢复不静默替换。

调度存储拥有计划和投递回执，Pi 拥有实际执行和任务队列。独立调度唤醒位置向现有 ChatSession command Interface 投递，避免多个持有者竞争聊天现有的恢复与清理 alarm。

计划与运行列表的权限、限额、到期策略和调度存储分区，需要在定时任务批次结合实际实现再细化；它们不进入工作面板 Interface。

## 10. 建议代码落点

以下为计划路径：

```text
src/browser/workbench/
  WorkbenchShell.tsx          导航壳，承接现有 AppShell
  AgentWorkspace.tsx          当前聊天与面板的组合
  panels.ts                  贡献类型与有界目标契约
  panel-host.tsx             注册收集、实例选择、布局与故障隔离

src/browser/extensions/
  extensions.ts              增加 panels 贡献
  extension-config.tsx       复用加载结果收集贡献

src/extensions/openui/
  browser.tsx                保留工具入口，声明 preview 面板
  WorkbenchPanel.tsx         OpenUI 目标到现有 Panel 的 Adapter

src/browser/schedules/       定时任务批次新增
src/server/schedules/        定时任务批次新增
```

新文件按实际职责产生；不为目录对称提前创建空 Module。原有 `App.tsx` 保留身份和账号工作台装配，逐步将壳和页面组合职责移出。

面板定义跟随现有受控 browser loader 打包加载。通用壳不静态导入 OpenUI 的 Renderer、CSS、QuickJS 或计算 Worker，保留关闭扩展后的构建裁剪能力。

## 11. 实施批次与验收

### A. 工作台骨架

交付统一侧栏、Agent / 定时任务 / 插件市场导航、账号设置和地址状态。插件市场呈现占位；定时任务在真正接入前明确呈现尚未创建或暂未开放状态，不填充模拟运行记录。

验收：旧聊天深链和 MCP 回调可用；切页后能返回聊天；未发送输入、附件和提交回执可恢复；账号切换隔离；手机可导航。

### B. 工作面板宿主与 OpenUI Adapter

交付面板贡献、打开与建议激活规则、收起、最大化、宽度调整、账号/聊天作用域和现有 OpenUI 接入。完成流式草稿到已提交资源的衔接。

验收：

- 同一资源反复打开保持身份；点击不同资源正确切换。
- 新建议不抢占当前内容，主动收起后不强行重开。
- 修改 OpenUI 输入后收起、切聊天和返回，草稿按现有规则保留。
- 旧计算结果不能在资源切换后写入当前资源。
- 同一资源没有两个完整编辑器争写 CAS。
- 关闭 OpenUI 的构建仍能加载工作台，且不加载 OpenUI 专属执行依赖。
- 未启用或失败的面板只影响自身；聊天和其他导航仍可用。
- 仅用于验证的静态 Adapter 可以证明扩展 Seam，无需接入真实浏览器或云电脑。

### C. 通用产出与文件

交付实际生成工具的产出描述、按需内容读取、内容版本、跨历史窗口的产出目录和对应文件预览。以已接入的工具为验收对象。

验收：产出来源消息未加载时仍能找回；旧版本可重开；继续修改携带正确来源；文件权限失效可理解；大型文件不进入聊天流。

### D. 定时执行

交付计划编辑、后台触发、暂停、立即运行、运行记录和聊天/产出关联。

验收：浏览器离线仍能触发；重复投递只接纳同一提交；暂停与停止分开；时区和重叠规则明确；授权失效和等待决定可处理；可从运行记录查看实际结果。

## 12. 验证方式与范围

- 工作面板的验证从其打开 Interface 与可见行为穿过 Seam，覆盖身份、选择、恢复、失败和卸载。
- 复用现有 PanelSession、草稿、extension ablation、conversation session、队列和恢复验证；补充与新组合行为直接相关的覆盖。
- 对调度使用可控时钟与受控投递 Adapter，验证稳定身份与到期策略，再做真实离线唤醒验收。
- A、B 批次执行项目检查与桌面、手机浏览器回归；C、D 在相应实现批次验证。
- 本地检查、部署和真实认证/提供方验收分开记录。

## 13. 首期实际实现与开发者接入

### 13.1 当前交付

统一侧栏提供 Agent、定时任务、插件市场、新建聊天、历史和账号设置。后两项页面均为“即将开放”，没有模拟任务、安装或包加载。地址继续使用 `/?chat=...`，新增 `view=schedules|plugins`；导航保留当前聊天，聊天选择返回 Agent，MCP 回调入口仍保留。

`src/browser/workbench/panel-state.ts` 拥有选择、建议、隐藏、宽度与资源引用恢复；`panel-host.tsx` 收集启用扩展的贡献并提供桌面分栏、最大化、手机全屏 Sheet 和局部故障展示。`navigation.tsx` 提供导航和占位页，`composer-drafts.tsx` 保存账号生命周期内各聊天的未发送文字、图片与模型选择。现有 `AppShell` 直接复用，没有额外的空壳 Module。

`Chat` 保持唯一的 `useConversationSession`；面板布局放在已有 `ChatRuntime` Provider 内，通过 `ConversationPort` 取得当前主会话 `nativeTarget` 与提交方法。切换占位页保持该聊天挂载，切换聊天则恢复对应内存草稿。草稿不跨刷新持久化。发送回执只清理实际提交的文字版本和图片身份。

OpenUI 现在以带细边框、圆角和内边距的行内片段显示在消息中，流式生成和历史恢复均不打开右侧工作面板。普通说明、结论、来源和静态表格使用 Markdown；只有计算参数调整、方案二次选择或有助理解数据趋势与对比的局部图表使用 OpenUI。`present_openui` 成功仅提交该片段，允许模型继续输出后续正文，不再结束整个回复。默认每次回复不使用组件，或使用一个有明确用途的小组件；不把整篇回答做成页面或复杂仪表盘。输入保存、计算隔离和显式继续分析沿用原机制。

### 13.2 注册 Interface

在现有受控的 BrowserExtension Module 中导出 `panels`。`defineWorkbenchPanel` 位于 `src/browser/workbench/panels.ts`，当前字段为 `scope`、`parse`、`key`、`title`、`Content` 和可选 `restore`：

```tsx
import { z } from 'zod';
import { defineWorkbenchPanel } from '../../browser/workbench/panels';

const targetSchema = z.object({ resourceId: z.string().min(1) });
export const panels = {
  report: defineWorkbenchPanel({
    scope: 'conversation',
    parse: (value) => targetSchema.parse(value),
    key: (target) => target.resourceId,
    title: () => 'Report',
    Content: ({ target, visible, conversation }) => (
      <Report resourceId={target.resourceId} visible={visible} conversation={conversation} />
    ),
    restore: (target) => ({ resourceId: target.resourceId }),
  }),
};
```

`Report` 由应用实现，继续使用 shadcn/ui + Tailwind，涉及 Agent 交互时复用 assistant-ui。扩展本身沿用 `src/extensions/browser.ts` 和 `extensions.config.ts` 的构建时注册与启用机制。此 Interface 不加载市场下载的任意代码。

扩展后代从 `useWorkbench()` 获取宿主：

```tsx
const workbench = useWorkbench();
const result = workbench?.openPanel({
  type: 'my-extension/report',
  target: { resourceId: 'report-123' },
  activation: 'explicit',
});
```

宿主将扩展 ID 与局部名称拼接，`my-extension/report` 是示例；OpenUI 不注册右侧面板。局部名称为字母开头的字母、数字、下划线或短横线，长度最多 128。`parse` 必须校验有限 JSON，目标总量最多 1 MiB，`key` 为非空且最多 1024 字符的稳定资源身份；`Content` 使用函数或 class React Component。失败返回 `unavailable`、`invalid_target` 或 `conversation_required`，保持已有选择。无 Provider 的独立嵌入场景需要调用方处理空值。

`explicit` 切换当前选择；`suggested` 仅在无当前内容且未主动收起时展开，否则保留一个“查看新内容”入口。`updatePanel(type, target)` 只更新相同聊天、类型和 key 的当前或待查看内容，不激活另一目标。收起之后同一资源的流式更新不会强制重开。

`scope: 'conversation'` 按当前聊天保存选择；`scope: 'workspace'` 跨聊天保留选择，并将 `conversation` 作为随当前聊天变化的可选上下文。工作区 Adapter 自行拥有浏览器、电脑连接等业务会话，不能将该上下文当成永久连接身份。

`visible` 是实际显示状态。Adapter 应用它暂停非必要观察，并在卸载时释放订阅。桌面收起保留已挂载内容，手机 Sheet 收起可能卸载；业务草稿应置于 Module 自己的会话或外部草稿存储。

### 13.3 恢复与限制

布局按账号隔离，只保存面板宽度、工作区选择、隐藏状态及最多 32 个资源引用，总量最多 64 KiB。`restore` 为明确选择加入；不声明时面板仅存在当前内存中。返回值重新经过 `parse`，只应包含可重新鉴权读取的小型引用，禁止返回令牌、签名 URL、文件字节或完整生成内容。存储不可用时继续使用内存布局。不可用类型的旧选择不再展开面板；对应扩展恢复后可恢复选择。校验失败的旧目标移除。删除聊天移除对应引用与输入草稿。

右侧工作面板继续保留给开发者的资源查看器、浏览器、云电脑等扩展；模板 OpenUI 使用行内片段，不再提供默认右侧 Adapter。本期不新增图片、视频和通用文件产出协议，也不提供真实浏览器、云电脑或调度执行。它们后续通过对应 Adapter 接入。当前面板身份按账号、聊天、类型、资源 key 隔离；宿主只绑定主会话，未来增加子会话导航时需把 nativeTarget 纳入选择身份，避免复用主会话选择。

本地验证包含面板状态 Interface、已有 OpenUI 与会话回归，以及桌面、手机上的真实工作台组合检查。认证、资源和提交在浏览器回归中使用受控响应；这些结果不代表生产部署或真实模型/外部提供方验收。
