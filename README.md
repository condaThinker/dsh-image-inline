# dsh-image-inline

让 DeepSeek Harness (DSH) 的 Web UI 支持**模型主动把一张图片渲染进对话流**（QQ/微信聊天式：图片显示在会话里、可上翻、和对话同步）。

对话流消息内容里**只保留路径文本**，图片本身**不进入模型上下文**（模型上下文保持干净，纯文本模型路由不受影响）。

## 工作方式

模型调用新增的 `show_image` 工具（传入磁盘图片路径）时：

1. **host**（`dsh/index.js`）：校验路径/格式/大小 → 读取字节 → 通过附件服务 `saveImage` 存成内容寻址附件 → 返回**纯文本**结果（路径 + 元数据摘要）。图片的展示载荷（attachmentId/宽高/字节数）通过工具的 `presentationMeta` 放进 `tool/result` 事件的 `meta` 字段——**不进模型上下文、不进会话日志的 image 块**。
2. **client**（`dsh/client.js`）：注册 `tool.call.toolview` 键控槽位（key = `show_image`），在对话流中该工具调用的位置渲染图片卡片（复用官方 `MessageImage` 组件：缩略图、点击看原图、加载失败可重试）。图片 URL 走插件自己的内容寻址 HTTP 端点。

```
模型 → show_image(path) → 附件服务存图 → 纯文本结果（路径+摘要）
                                   │
                                   ├─ tool/result meta ─→ client toolview 渲染图片卡片
                                   └─ 注册表（$DSH_HOME/plugins/dsh-image-inline/registry.json）
                                        └─ GET /plugin/show-image/<attachmentId> → 图片字节
```

### 为什么需要插件自己的 HTTP 端点？

DSH 内置的 `conversation.resolveImage` → `session.attachment` RPC 只服务"会话日志的 image 块里被引用的附件"（`api-proxy` 的 `referencedImage` 授权）。本插件的结果**故意不包含 image 块**（否则图片会进入模型上下文），因此附件永远不会被日志引用，必须由插件自己提供读取通道。

安全性：attachmentId 是 `sha256:<hex>` 内容哈希——**内容寻址 capability URL**，不知道图片内容就无法猜测；id 只出现在用户可读的会话日志与插件注册表中。服务默认绑定 loopback，与整个 Web UI 同一信任模型。

## 安装

```bash
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:condaThinker/dsh-image-inline
sudo systemctl restart dsh   # 或按你的方式重启 web profile
```

> 本插件零构建（纯 JS），GitHub 直接分发源码，安装时无需执行任何构建脚本。

卸载：

```bash
npx -p @deepseek-ai/dsh dsh plugin --profile web remove dsh-image-inline
sudo systemctl restart dsh
```

## 配置

`cordis.patch.yml` 中的 `config`（可覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `maxImageBytes` | `26214400` (25MiB) | 单张图片编码字节上限（实际生效值 = min(本配置, 附件服务配置)） |
| `maxImagePixels` | `40000000` (40MP) | 宽×高上限；`0` 关闭该检查 |
| `mediaTypes` | png/jpeg/webp/gif | 接受的格式白名单 |

## 使用

在会话中让模型显示一张图片，例如：

> 用 show_image 显示 /path/to/your/image.png

模型调用后，对话流里该工具调用处会出现图片卡片（缩略图，点击看原图），可上翻查看历史。若图片不存在/格式不支持/超限，卡片显示错误文案，会话不中断。

## 测试

```bash
cd dsh-image-inline
node --test "tests/*.spec.mjs"   # 33 个用例：host 24 + client 7 + 并发/路由回归
```

client 渲染用例从 DSH checkout 的 `node_modules` 解析 react/react-dom（默认 `/deepseekHarness/deepseek-harness/node_modules`；在其他机器上用 `DSH_HARNESS_NODE_MODULES` 环境变量指向任何装有 react@18 + react-dom@18 的 checkout）。找不到 react 时该套件自动跳过并提示，host 用例不受影响。

## 已知限制

- **像素超限孤儿附件**：`saveImage` 先落盘后检查 `maxImagePixels`——若插件配置比部署默认（40MP）更严，超限图片会留下一个无引用的附件对象（内容寻址、无害）。
- **注册表单调增长**：每张展示的图在 `$DSH_HOME/plugins/dsh-image-inline/registry.json` 留一条记录（约 200 字节/条）。
- **无构建步骤**：host/client 均为纯 JS（modlens 同款零构建协议），`link:` 安装下改代码即生效，但**新增/修改 bundle 行需重启 profile**（HMR 覆盖不了 bundle 图变化）。
- 模型上下文纯净是设计目标：`show_image` 的结果永远是文本，图片只通过 `meta` + HTTP 端点到达浏览器。

## 开发者笔记（事故复盘）

- client bundle 必须遵循惰性 CJS 协议：`window.__ModuleLoader__.load({id, factory: (require) => {...; return module.exports}})`——`require` 是 factory 的注入参数，写成自由变量会在浏览器抛 `require is not defined`。
- host 注入服务只能通过注入作用域访问：`ctx.inject(['webServer'], (scope) => scope.webServer.register(...))`，在外层 ctx 上属性访问会抛 `cannot get property "webServer" without inject`。
- 注册表写入已串行化（进程内 promise 队列），并行 `show_image` 调用不会丢条目。
