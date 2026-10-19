# 图片生成扩展

## 用户行为

用户明确要求生成图片时，Agent 调用 `generate_image`。等待状态和成功后的图片都在 assistant-ui 消息中；普通说明继续使用 Markdown。成功提交不会结束整轮回复，也不通过 OpenUI 绘制图片。

图片首次出现及点击查看均不打开右侧工作台。点击图片使用 shadcn Dialog 展示透明容器与半透明深色遮罩，支持 25%–400% 缩放、放大后拖动、适应窗口、右上角关闭及 Escape 退出；窄屏复用同一查看器。消息内与预览中均提供原图下载。预览状态不持久化，刷新后恢复消息图片，查看器保持关闭。查看、调整预览和下载不发起模型请求或新生成。

## Module 与 Seam

- `images` 是完整的图片生成 Module，拥有工具、异步生成、资源元数据、文件存储和两个浏览器展示入口。
- `ImageProvider` 是服务提供方的 Seam。Interface 仅有不含凭据的配置身份、`submit(request, signal)` 和 `inspect(taskId, signal)`。Adapter 负责请求格式、鉴权、状态翻译；不负责排队、轮询计时、消息或工作台。
- 默认 Adapter 是 Kie，模型 `gpt-image-2-5-sunburst-text-to-image`。未来提供方实现同一 Interface，并在 `configuredImages` 中替换工厂，不修改聊天或工作台。
- `ImageFiles` 隐藏临时 URL 下载、校验、原始字节和私有 R2 manifest，模型与 UI 只接触短资源引用。提供方下载 URL 不进入公开工具结果。
- 宿主新增通用的只读文件 Interface：`resources.readFile(ref, name, ReadContext)`。这与现有 JSON `read` 并列；不在宿主里加入 Kie 或图片专用逻辑。已有聊天授权和 native target 校验在 DO 入口执行，扩展再按成功工具回执检查可见性。

## 执行与恢复

1. 接受的用户请求拥有一次生成调用；native tool task 创建并持久化一个归属自己的 Pi child task。
2. 在提交外部请求之前持久化 `uncertain` 检查点。提交成功后立即持久化 provider task ID，转入 `poll`。
3. 通过 Pi 的等待原语查询状态，不依赖浏览器，不引入第二套调度器或数据库队列。
4. 收到结果后转入 `store`，下载并保存原始 PNG/JPEG/WebP 文件与 manifest，再提交消息中的资源回执。
5. 刷新、断线与 DO 重建使用已持久化的 task ID。文件读取失败可重试下载，不能重新生成。
6. Kie 提交目前没有已核实的幂等提交契约。丢失提交回执时返回明确的结果未知；同一轮模型不能自动提交替代生成。用户明确发起新请求才创建新任务。
7. 停止只停止本地等待，不声称已取消提供方任务或退费。生成与下载均有有界等待。

## 配置

`extensions.config.ts` 的 `images.enabled` 控制扩展。服务端环境变量：

```dotenv
KIE_API_KEY=配置在本地 .dev.vars 或部署 secret
KIE_BASE_URL=https://api.kie.ai
KIE_IMAGE_MODEL=gpt-image-2-5-sunburst-text-to-image
```

没有 `KIE_API_KEY` 时不向模型注册生成工具；仍可在扩展启用且存储可用时读取历史图片。API Key 不进入浏览器、消息或任务检查点。`ARTIFACT_FILES` 是独立的私有 R2 binding，本地与测试使用本地模拟存储；部署前需实际配置该 bucket 和密钥。

首期是文生图，默认 1K、1:1。工具接受标题、提示词、画幅和分辨率；提供方特定参数和凭据不由模型传入。下载导出保留提供方原始文件格式，不做有损转码，也不承诺修改已有图片。

## 验证

- Kie 请求、状态映射、任务身份、明确拒绝和提交结果未知。
- 在 workerd 中构造真实 Request，验证提交与查询使用兼容的重定向选项，并拒绝重定向响应；Node 提供方测试不能替代 Workers 运行时验证。
- 原生 Pi 工具、child task、真实 DO 重建、同一任务不重复生成。
- 私有文件、聊天归属、成功工具可见性、非法文件名与伪造图片格式。
- 消息展示、点击打开模态预览、移动端、关闭与下载响应及刷新恢复；展示操作不得调用生成。
- 实际提供方生成单独验收，测试 fixture 和构建成功不能代替真实 Kie 调用。

## 已核对的来源

- [Kie Sunburst 文生图](https://docs.kie.ai/43286810e0)：模型 ID、创建接口、输入限制。
- [Kie 查询任务](https://docs.kie.ai/market/common/get-task-detail)：taskId、state、resultJson.resultUrls；HTTP 200 内还需检查 code。
- [Cloudflare RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/)：Response 与文件流通过 RPC 返回。
- [R2 Workers Interface](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)：私有对象写入、读取与元数据。
