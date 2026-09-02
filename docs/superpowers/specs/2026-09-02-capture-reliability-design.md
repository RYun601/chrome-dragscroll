# 截图可靠性改造设计

> 日期：2026-09-02
> 状态：待用户审核
> 范围：滚动截图的下载、捕获调度、取消、标签完整性、内存保护与验证；不改变拖拽选区模型。

## 1. 目标与约束

本次改造解决以下已确认的问题：

1. Chrome 默认 JSON 消息传递不能可靠传输 `Blob`，当前“内容脚本 Blob → Service Worker object URL → 下载”链路无法工作；
2. MV3 Service Worker 不支持 `URL.createObjectURL()`，即使 Blob 可到达后台也不能在那里创建下载 URL；
3. 当前瓦片捕获频率高于 `captureVisibleTab` 的每秒两次上限，靠失败重试实现节流；
4. `Esc` 或再次启动时不会真正停止在途捕获，旧任务可能继续滚动页面或污染新会话；
5. 截图 API 只按窗口抓取当前激活标签，用户切换标签后可能产生错图；
6. canvas 上限只按 CSS 像素计算，高 DPR 下可能分配数 GB 内存。

必须满足的约束：

- 继续支持 Chrome 109–147；Offscreen API 在 Chrome 109 才可用，Chrome 108 及更早版本不在本批次范围内；不依赖 Chrome 148 的 `message_serialization: structured_clone`；
- 保留真实下载完成后才显示“已保存”的交互；
- 不新增主机权限、网络权限或数据收集；
- 允许新增 MV3 `offscreen` 权限，因为隐藏扩展文档是旧版 Chrome 下安全处理 Blob URL 的必要 DOM 容器；
- 保持原生 JavaScript、无 npm、无打包器、无第三方依赖；
- 保留现有滚动容器识别、单轴锁定和用户手动选区宽高规则。

## 2. 方案选择

### 选择：Offscreen Document + JSON 安全分块协议

新增 `offscreen.html` 与 `offscreen.js`。内容脚本将 PNG Blob 切分为 JSON 可传输的 base64 小块；Service Worker 作为会话协调器转发小块；Offscreen Document 重组 Blob、创建并持有 object URL，再通过 `chrome.runtime` 将 URL 字符串交给 Service Worker；Service Worker 调用 `chrome.downloads.download()`，终态后通知 Offscreen Document 回收 URL。

该选择的原因：

- Blob 不经过默认 JSON 消息通道的隐式序列化；
- `URL.createObjectURL()` 在有 DOM 的 Offscreen Document 中可用，不再错误地在 Service Worker 中调用；
- `chrome.downloads.download()` 与 `downloads.onChanged` 保留精确的下载完成/中断状态；下载 API 仍由 Service Worker 调用，Offscreen Document 只处理 Blob URL 和 runtime 消息；
- 与 Chrome 148+ structured clone 相比，不缩窄兼容范围；
- 与内容脚本 `<a download>` 相比，不依赖页面 CSP、用户激活时序或页面下载策略，也不牺牲完成状态。

### 明确不采用的方案

| 方案 | 不采用原因 |
| --- | --- |
| 仅启用 `message_serialization: structured_clone` | 需要 Chrome 148+，不满足旧版兼容目标。 |
| Service Worker 直接 `URL.createObjectURL(blob)` | MV3 Service Worker 无该 API；object URL 必须由 Offscreen Document 创建并持有。 |
| 后台拼接单一 data URL | 大 PNG 会产生额外 base64 内存和超长字符串，可靠性较低。 |
| 内容脚本 `<a download>` | 难以可靠报告最终写盘完成，也受页面用户激活和策略影响。 |

## 3. 架构与数据流

```text
结果 canvas
  │ canvas.toBlob('image/png')
  ▼
Content Script
  │ runtime.Port：DOWNLOAD_BEGIN / DOWNLOAD_CHUNK / DOWNLOAD_END
  ▼
Service Worker
  │ 校验发送者、管理请求 id、转发 JSON 安全块
  ▼
Offscreen Document
  │ 重组 Blob → URL.createObjectURL(blob) → runtime 发送 URL 字符串
  ▼
Service Worker
  │ chrome.downloads.download({ url: blobUrl })
  ▼
chrome.downloads.onChanged
  │ 状态经 Service Worker 定向通知原 content script
  ▼
结果面板：正在准备下载 → 浏览器正在保存 → 已保存 / 保存失败
```

### 3.1 新增文件与清单

- `manifest.json`
  - 在 `permissions` 中增加 `offscreen`；
  - 保留现有 `activeTab`、`scripting`、`storage`、`downloads`、`clipboardWrite`；
  - 不增加 host permission、`<all_urls>` 或网络权限。
- `offscreen.html`
  - 只加载 `offscreen.js`，不包含用户界面、外部资源或网络请求。
- `offscreen.js`
  - 仅承担 Blob 重组、object URL 生命周期和 `chrome.runtime` 消息；
  - 不直接调用 `chrome.downloads`，因为 Offscreen Document 只开放 `chrome.runtime` 扩展 API；
  - 不读取页面 DOM，不接触网页数据以外的下载字节。

Service Worker 通过 `ensureOffscreenDocument()` 按需创建且复用唯一的 Offscreen Document，创建理由为 `BLOBS`。该文档从收到首个 `DOWNLOAD_BEGIN` 起保持打开，直到没有在途传输且所有已创建的下载都到达终态后才关闭；这样 object URL 在 Chrome 读取下载数据期间始终有所属文档。

### 3.2 分块下载协议

内容脚本在用户点击“保存 PNG”后才创建下载会话，避免提前占用内存或启动 Service Worker。

| 消息 | 方向 | 必填字段 | 语义 |
| --- | --- | --- | --- |
| `DOWNLOAD_BEGIN` | content → background | `requestId`、`filename`、`mime`、`byteLength` | 声明一次下载及预期大小。 |
| `DOWNLOAD_CHUNK` | content → background → offscreen | `requestId`、`index`、`base64` | 按顺序传送 PNG 字节块。 |
| `DOWNLOAD_END` | content → background → offscreen | `requestId`、`count`、`byteLength` | 声明上传完成，触发完整性检查与下载。 |
| `DOWNLOAD_URL_READY` | offscreen → background | `requestId`、`blobUrl` | Offscreen Document 已创建并持有 Blob URL。 |
| `DOWNLOAD_STARTED` | background → content | `requestId`、`downloadId` | Chrome 已创建下载任务。 |
| `DOWNLOAD_COMPLETE` | background → content | `requestId`、`downloadId` | 下载状态变为 `complete`。 |
| `DOWNLOAD_ERROR` | background/offscreen → content | `requestId`、`error` | 传输、校验、创建下载或写盘失败。 |
| `DOWNLOAD_CANCEL` | content → background → offscreen | `requestId` | 用户关闭面板、取消会话或端口断开。 |
| `DOWNLOAD_RELEASE_URL` | background → offscreen | `requestId`、`blobUrl` | 下载进入终态后回收 object URL 与 Blob。 |

协议规则：

- 原始分块大小固定为 192 KiB，保证 base64 不会在分块中间产生填充；每条 JSON 消息显著低于 Chrome 的消息上限；
- `requestId` 由内容脚本生成，下载会话期间唯一；
- 后台和 Offscreen Document 都验证消息来源、请求是否存在、序号是否连续、累计字节是否超过声明值；
- `filename` 只允许普通文件名；移除路径分隔符、控制字符和 Windows 保留字符，并限制为 120 个字符以内；
- 内容脚本、后台和 Offscreen Document 任一端报错、取消、端口断开或序号错误时，都释放该请求的临时字节；
- 每个请求的 PNG Blob 上限为 128 MiB。超限时不开始下载，提示用户缩小选区；
- 下载创建成功后，Service Worker 将 `{ requestId, tabId, downloadId, createdAt }` 写入 `chrome.storage.session`，供 Service Worker 回收/重启后继续处理最终下载状态；
- Offscreen Document 收到 `DOWNLOAD_END` 后只通过 `chrome.runtime` 返回 `DOWNLOAD_URL_READY`；Service Worker 用该 URL 字符串调用 `chrome.downloads.download()`，不在自身调用 `URL.createObjectURL()`；
- 全局 `chrome.downloads.onChanged` 监听在 Service Worker 顶层注册；收到终态后读取 session 映射、向原标签内容脚本发送状态、请求 Offscreen Document 回收对应 object URL/Blob，再清除映射。
- `downloads.download()` 返回 `downloadId` 到 session 映射写入之间可能出现极快完成的竞态。写入映射后必须立即执行一次 `chrome.downloads.search({ id: downloadId })`；若已是 `complete` 或 `interrupted`，走与 `onChanged` 相同的终态处理流程。
- `tabs.onRemoved` 与原标签的主框架导航事件清理未完成下载的状态映射，并通知 Offscreen Document 回收资源；已由 Chrome 创建的下载不取消，只停止向不存在页面回传状态。

若用户在下载完成前离开原页面，后台仍清理 session 映射和 Offscreen 资源；无法投递给已不存在的内容脚本不视为下载失败。

## 4. 可取消捕获会话

### 4.1 Session 模型

每次有效 `pointerup` 创建一个独立的 capture session：

```js
{
  id,                 // 单调递增或随机唯一 id
  cancelled,          // 取消标记
  cleaned,            // 清理幂等标记
  scroller,
  originalScroll: { x, y },
  hiddenElements,
  hostAtStart,
  abortController
}
```

`state.captureSession` 只能指向当前活跃会话。所有异步边界（稳定等待、队列等待、截图响应、Bitmap 解码、重试、画图、显示结果）前后均检查会话仍是当前会话且未取消。

### 4.2 取消规则

以下操作均取消当前 capture session：

- `Esc`；
- 再次点击工具栏或快捷键以退出；
- 用户关闭正在显示的加载/结果覆盖层；
- 新 capture session 创建前仍有旧会话；
- 后台返回“原标签已不再激活”；
- 内容脚本卸载或 Port 断开。

取消后立即执行一次幂等清理：停止 rAF、恢复滚动位置、恢复 `scroll-behavior`、恢复 fixed/sticky 元素、隐藏/移除覆盖层，并释放下载/缩略图 URL。已发起但不可中断的浏览器截图响应回来后只做资源释放，不再滚动、绘制或显示 UI。

`pointercancel` 改为取消拖拽，而不是将不完整手势当成 `pointerup` 开始截图。

### 4.3 新旧会话隔离

`runCapture()`、`captureRegion()` 和 `showResult()` 接收 session 参数。只有 `session === state.captureSession` 且 `host === session.hostAtStart` 时才允许修改 UI。这样旧任务即使在新覆盖层开启后晚到，也不能展示旧截图或影响新任务。

文档级 `keydown` 监听使用显式 `removeEventListener` 或 `AbortSignal` 管理，确保每次 `teardown()` 后不残留监听。

## 5. 截图调度、标签完整性和内存保护

### 5.1 全局截图队列

Service Worker 为全部标签页共享一条 `captureVisibleTab` 队列：

- 相邻调用开始时间至少相隔 550ms；
- 所有首次调用、瓦片调用和重试调用都必须进入该队列；
- 内容脚本的 `CAPTURE_VISIBLE` 消息携带 `captureId`；取消时发送 `CAPTURE_CANCEL { captureId }`，让后台将尚未开始的同会话队列项直接拒绝；
- 队列内请求开始前检查 `captureId` 未取消且标签仍有效；
- 若调用被取消，队列中的未开始任务直接拒绝，不调用 Chrome API；
- 内容脚本保留有限次数的异常重试，但不再依赖速率超限失败作为正常流程。

第一张实际瓦片负责同时确定截图像素比例和绘制输出，删除仅用于探测比例的额外 `captureVisibleTab` 调用。

### 5.2 标签完整性

在 Service Worker 真正调用 `captureVisibleTab(sender.tab.windowId)` 前，查询 `sender.tab.id` 并确认：

- tab 仍存在；
- tab 的 `windowId` 与 sender 相同；
- `tab.active === true`。

任一条件不成立时不截图，返回明确错误；内容脚本取消当前 capture session 并恢复页面。这样不会把同窗口另一个标签页的画面拼入原图。

### 5.3 输出像素预算

输出限制在加载首张真实 bitmap、获得实际 scale 后执行：

- 单边：`outW <= 32000` 且 `outH <= 32000`；
- 总输出：`outW * outH <= 64_000_000`；
- 预估 RGBA canvas 内存：`outW * outH * 4` 字节；
- PNG Blob：`<= 128 MiB`，超过时不进入传输协议。

错误消息需展示输出尺寸与超限原因，建议用户缩小选区或降低浏览器缩放。原有 CSS 面积检查可保留为快速前置检查，但不能替代实际输出像素检查。

## 6. UI、错误与恢复

结果面板状态统一为：

| 状态 | 用户可见文案 | 可继续操作 |
| --- | --- | --- |
| 编码中 | 正在准备下载… | 关闭/取消 |
| 传输中 | 正在传送图片数据… | 关闭/取消 |
| 已创建下载 | 浏览器正在保存… | 关闭；后台继续跟踪最终状态 |
| 完成 | 已保存 ✓ | 保存、复制、关闭 |
| 失败 | 保存失败：具体原因 | 重试保存、复制、关闭 |
| 取消 | 已取消 | 关闭或重新开始 |

“关闭”不取消已经由 Chrome 创建且正在写盘的下载，只取消尚未创建下载的传输；避免把用户已确认的浏览器下载误判为失败。

## 7. 验证策略

### 7.1 新增/调整浏览器回归页

在不引入外部依赖的前提下，增加测试钩子和自运行回归页，验证：

1. `window.__CAPTURE_TEST__` 明确触发测试模式；
2. 取消时不继续滚动、恢复原始滚动位置、不会显示结果；
3. 旧会话完成后不污染新会话；
4. `pointercancel` 不触发截图；
5. mock 高 DPR 截图触发实际输出像素上限；
6. 第一张实际瓦片被绘制而不是被浪费为 probe；
7. 现有宽度、高度、window 回退、内部 `overflow:auto` 和 PerfectScrollbar 测试无回归。

### 7.2 真实扩展人工验收

在 `chrome://extensions/` 加载项目目录后验证：

1. 3 块以上的截图中，相邻 `captureVisibleTab` 调用间隔不小于 550ms；
2. 捕获中按 `Esc` 后页面立即回到起始滚动位置，且不出现迟到结果；
3. 捕获中切换到同窗口另一标签，原截图任务取消且不保存错图；
4. 小图、中图 PNG 保存成功；取消保存和磁盘错误显示具体提示；
5. 125%、150%、200% 浏览器缩放下，输出尺寸正确；
6. 超过 6400 万输出像素和超过 128 MiB PNG 的场景均被明确拒绝；
7. `demo-page.html`、`perfect-scrollbar.html`、`capture-engine.html`、`window-scroll.html` 与两个宽高回归页均通过；
8. 安全上下文中的复制图片能力保持可用。

### 7.3 自动检查

- `node --check background.js`；
- `node --check content/content.js`；
- `node --check options.js`；
- 对新增 `offscreen.js` 执行 `node --check offscreen.js`；
- `git diff --check`；
- 检查 `git status --short`，确认不包含临时截图、Lighthouse 输出或浏览器配置。

## 8. 文档更新

`README.md` 与 `docs/design.md` 同步更新：

- 权限说明增加 `offscreen`：仅用于本地隐藏文档处理 Blob/object URL 下载，不读取页面额外数据、不发起网络请求；
- 大图限制改为“单边 32000px、实际输出不超过 6400 万像素、PNG 传输不超过 128 MiB”；
- 说明捕获期间切换标签会自动取消，以防止错图；
- 说明保存状态分为“准备/传输/浏览器正在保存/已保存或失败”；
- 记录真实 Chrome 截图与下载验收结果，不将测试模式结果视为真实下载验证。

## 9. 非目标

本次不处理以下项目：

- iframe、跨域 iframe 或 closed Shadow DOM 内的滚动识别；
- 虚拟列表/无限列表的渲染稳定策略；
- 双轴二维拼图；
- 截图编辑、标注、PDF 导出；
- 设置页的完整无障碍整改（可作为后续独立小批次）。

## 10. 完成标准

以下条件全部满足才视为本批次完成：

1. 默认 JSON 消息模式下保存 PNG 可工作，不依赖 Chrome 148；最低运行版本为 Chrome 109；
2. Service Worker 不调用 `URL.createObjectURL()`；
3. 下载会话在成功、失败、取消、端口断开时均无临时数据泄漏；
4. 截图调用不超过每秒两次，且首块截图被复用；
5. 取消、重新启动和标签切换不会继续滚动或显示错图；
6. 高 DPR 下的实际输出像素和 PNG 字节上限生效；
7. 现有容器识别与选区回归页通过，新增会话回归页通过；
8. README、设计文档、权限说明与实际行为一致；
9. 语法检查、`git diff --check`、真实扩展人工验收均有记录。
