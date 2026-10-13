# 项目规范

## UI 组件与样式

- 所有应用 UI 必须统一使用 **shadcn/ui + Tailwind CSS**，优先复用仓库已有组件与主题，不引入其他 UI 组件库。
- 涉及 Agent 的组件（聊天、消息、输入框、思考过程、工具调用、附件、回复操作与 Footer 等）必须使用 **assistant-ui** 提供的组件与原语，并结合 shadcn/ui 与 Tailwind CSS 保持统一样式。
- 新增或修改 UI 前，先检查 shadcn/ui、assistant-ui 和仓库中是否已有可复用组件；不使用未封装的浏览器原生控件或自建组件替代已有能力。
