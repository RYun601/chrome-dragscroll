# 滚动截图 · 拖拽即滚 — 设计文档

> 日期：2026-08-11 ｜ 状态：v0.1 设计定稿（用户不在场，由助手自主决策，待用户复核）

## 背景与调研结论

- 用户想做一个 Chrome 截图插件，支持两种「拖动」：
  1. 当前屏内拖动框选（调整宽高）——主流插件都支持
  2. **继续向下/向边缘拖动 → 页面滚动 → 框选区域跨越视口**——用户以为没有插件支持
- 经核实，**该功能已有插件实现**（用户判断有误）：
  - Chrome：「Full Page Screenshot - Scroll, Area & Full Capture」（开源，`axagon79/full-page-screenshot`），明确支持 *"drag past the edge of the screen and the page follows you"*
  - Edge：「滚动截屏 / ScrollSnap」也支持 *"supports scrolling during selection"*
- **但是**：用户实测发现现有插件在「固定布局 + 内部滚动容器」页面会失效，例如 `http://projm.gooddr.loc/project-requirement/list` 无法向下滚动。

## 失效根因

此类后台列表页是「固定外壳 + 内部滚动」布局：侧边栏/顶栏固定，真正滚动的是主内容区一个 `<div style="overflow:auto">`，**`window` 本身不滚动**。现有插件默认对 `window` 调用滚动，自然无效；其对「滚动容器智能检测」的兜底也不够健壮。

## 本插件差异化定位

**「容器感知」的拖拽式滚动截图**：

- 按下瞬间，通过 `document.elementsFromPoint` 找到光标下真正的可滚动元素（任意嵌套 div，纵向/横向均可），对其执行滚动；
- 找不到局部滚动容器时回退到 `window` 滚动；
- 拖拽到容器/视口边缘 → 自动滚动（上下左右四向），选区在文档坐标系中持续增长；
- 释放后按「滚动 + 截屏 + 拼接」的方式生成跨屏长图。

### 滚动容器识别（findScroller）

真实后台页（如 `projm.gooddr.loc` 的 Color Admin 模板）常用 **PerfectScrollbar** 等自定义滚动条库：滚动容器被设为 `overflow:hidden`，由 JS 接管滚动。因此识别逻辑需要：

1. **兼容 `overflow:hidden` 容器**：只要 `scrollHeight/scrollWidth` 有实际溢出、`scrollTop/scrollLeft` 可编程设置，就视为可滚动（自动滚动本就通过 JS 设置 scrollTop/Left，与原生滚动条无关）；
2. **纵向优先**：向上遍历时，只「横向溢出」的容器（如宽表格 `table-responsive`，`maxY=0`）不阻断查找，继续向上找「纵向可滚动」的祖先，否则会误选导致向下拖不动；
3. **横向兜底**：若没有纵向容器，仍回退到最近的仅横向容器，保证纯横向截图可用。
4. 以上都找不到才回退 `window` 滚动。

## 技术方案（Manifest V3）

- 权限最小化：`activeTab`、`scripting`、`storage`、`downloads`、`clipboardWrite`，无 `<all_urls>`。
- 点击工具栏图标 / `Alt+Shift+S` → 注入 `content.js` 并发送 `START` 消息。
- 内容脚本用 **Shadow DOM** 承载覆盖层，避免被页面样式污染。
- 覆盖层视觉（2026-08-11 优化）：柔和暗色遮罩（`.ss-layer` `rgba(15,23,42,.12)` + 选区外 `rgba(15,23,42,.30)`）；选区框为圆角蓝框 + 四角手柄 + 微光晕；悬浮信息卡为玻璃拟态（白底半透明 + `backdrop-filter: blur`），突出显示尺寸 + 提示；另有跟随选区右下角的尺寸浮标（超出视口自动夹紧）。
- 滚动容器抽象：`window` 与元素两种 scroller 统一接口（`scrollLeft/Top`、`maxX/Y`、`viewBox`）。
- 选区坐标模型：文档坐标 = 视口坐标 + 容器滚动偏移；自动滚动时在 rAF 里累加，选区随内容增长。
- 拼合：按容器 client 尺寸分块滚动并 `chrome.tabs.captureVisibleTab`，按设备像素比裁剪后画到目标 canvas。
- 固定/悬浮元素：截图时对与容器视框重叠的 `fixed/sticky` 元素临时 `visibility:hidden`，完成后恢复，避免长图里重复出现页头/悬浮按钮。
- **产出**：保存 PNG（`chrome.downloads`）+ 复制剪贴板（`navigator.clipboard` + `ClipboardItem`），**默认手动**：截图完成后在结果面板点按钮才保存/复制，不自动弹窗；「复制」仅在安全上下文（HTTPS/localhost）时显示。

### 截图捕获阶段的坑（2026-08-11 修复）

真实页面上捕获时发现三连问题，均源于「**截图期间覆盖层未隐藏**」：

1. **整体偏色**：覆盖层 `.ss-layer` 的暗色蒙层 `rgba(15,23,42,.14)` 进入每块瓦片，整图被压暗偏蓝；
2. **行间亮度不一致**：选区框 `.ss-selection` 的 `box-shadow: 0 0 0 9999px rgba(15,23,42,.35)` 固定在某视口位置，随内容滚动，不同瓦片里行被不同程度压暗，出现亮度分界（表现为「某行之后样式不一致」）；
3. **大片黑色/缺行**：9999px 巨型投影在某些环境下导致 `captureVisibleTab` 返回黑帧/失败，瓦片被跳过，canvas 未绘制区域保存后呈黑色。

修复：

- **捕获期间隐藏覆盖层**（`els.layer.style.background='transparent'` + `els.sel.style.display='none'`），完成后恢复；
- **捕获失败自动重试**（`requestCapture` 重试 3 次），仍失败则抛出明确错误而非静默保存残缺图；
- **`settle()` 加超时兜底**（`settleDelay*6`），避免标签页后台/不可见时 rAF 被节流导致截图卡死。

### 隐藏固定/悬浮元素误伤表格固定列（2026-08-11 追加修复）

`hideFixedElements` 原逻辑会隐藏所有与容器视框重叠的 `position: fixed/sticky` 元素。
但在「宽表格 + 固定操作列」的后台页（如 projm 页 `.col-actions` 是 `position: sticky`）会**误删表格列**：

- `hideFixedElements` 在拖拽结束时的滚动位置（已滚到底部）执行，此时第 8 行起的操作列单元格恰好与视框重叠 → 被 `visibility:hidden`；
- 该隐藏状态贯穿整个捕获 → 截图里**第 8 行起的「操作」列变空白**，而前 7 行（视框上方）正常 → 表现为「前 7 行对、第 8 行开始样式与页面不一致」。

修复：`hideFixedElements` 只隐藏相对「被捕获的滚动容器」粘住的 sticky 元素
（会随滚动在该容器内重复出现）；若 sticky 元素粘在更内层的容器
（如宽表格的固定列，`nearestScrollContainer(el) !== sc.el`），则属于内容、随内容滚动，不隐藏。
`position: fixed`（相对视口，如页头/侧边栏）仍照常隐藏。

### DataTables FixedColumns 左固定列拖拽失效（2026-08-11 追加修复）

DataTables 插件（`FixedColumns`）会在表格左侧生成**主表的克隆列**（`DTFC_LeftBodyLiner` 等），
用于固定左侧列。该克隆列是独立的滚动容器，且几乎不可滚（横向 maxX≈1）：

- 此前在左固定列区域按下拖拽 → `findScroller` 命中 `DTFC_LeftBodyLiner` 克隆 → 滚动的只是克隆本身，
  **主表完全不动**（上下左右四向均失效），表现为「拖到最右/最下后表格滚动条没滚动」。
- 修复：新增 `normalizeScroller(el)`。若命中元素类名以 `DTFC_Left` 开头、或其祖先含 `.DTFC_LeftWrapper`，
  则沿 `DTFC_LeftWrapper → parentElement` 找到真正的 `.dataTables_scrollBody` 主表并返回；
  找不到或相同则原样返回。`findScroller` 的两条返回路径（纵向优先 / 横向兜底）均套用该归一化。

验证（`admin.drs.cn` DataTables + FixedColumns 页，双向 4 项拖拽矩阵）：

| 拖拽起点 | 方向 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| 左固定列 | 拖下 | ❌ 主表 scrollTop 恒 0 | ✓ 0→1201（识别到 `DIV.dataTables_scrollBody`） |
| 左固定列 | 拖右 | ❌ 克隆 maxX≈1 无效果 | ✓ scrollLeft 0→1216 |
| 主体 | 拖下 | ✓ | ✓ 0→1202（无回归） |
| 主体 | 拖右 | ✓ | ✓ 0→1199（无回归） |

**捕获对齐（Fix ② 评估为不需要）**：DTFC 左列克隆跟随主表滚动的同步延迟实测仅 5–19ms
（1~2 个 rAF 帧内），远小于 `settle()` 的 130ms 稳定等待 → 开始捕获时左列必然已对齐，
拼接长图中左固定列不会错位，无需在捕获期间隐藏克隆或额外等待。

### 拖拽方向锁定：只做单轴长图，不做 2D 矩形（2026-08-11）

**问题**：横纵都可滚的页面（如 admin 的 `.dataTables_scrollBody`，clientW=1330×clientH=379，
内容 maxX=6469×maxY=2895），对角线拖拽会同时触发横+纵自动滚动 → 选区变成 2D 矩形 →
瓦片数 = `ceil(2895/379)≈8 行 × ceil(6469/1330)≈5 列 ≈ 40 块`。40 次连续快速
`chrome.tabs.captureVisibleTab` 在带 sticky 固定列/DataTables 的重页上会偶发返回 lastError，
当前 `requestCapture` 只重试 3 次（150/300/450ms），单块连续失败即中止整图，弹「有区域未能捕获」。

**决策**：**不支持「横+纵」双向长图**——一次拖拽只锁一个方向（纵向或横向），
产物永远是 1 维长条，便于查看与处理；同时也把瓦片数降到单列/单行（≤ 每屏一块），
从根上消除 2D 网格瓦片过多导致的截屏失败。

**实现（content.js）**：
- 新增 `state.axis`（'v' / 'h' / null）。**不在按下时按手势抢锁**，而是**首次触发边缘自动滚动时**锁定：
  - 只有纵向自动滚动 → `axis='v'`；只有横向 → `axis='h'`；两者同时（拖到角落）→ 按速度较大者，默认纵向。
  - 这样「先横向拖动设定宽度、再往下滚」的纵向自定义宽度用法不受影响（屏内横向移动不触发自动滚动）。
- 锁定后**只滚单轴**（`tick`/`updateAutoScroll` 把另一轴速度置 0）；`clampToAxis()` 把非滚动方向坐标
  限制在容器当前可视范围内：纵向长图宽度 ≤ clientW（单列瓦片），横向长图高度 ≤ clientH（单行瓦片）。
- 提示条显示「纵向长图 / 横向长图 · …」，锁定瞬间即出现。
- `__scrollshotDebug` 增加 `axis`/`hint` 字段便于测试。

**验证（admin 页，真实容器）**：

| 拖拽手势 | 锁定轴 | 自动滚动 | 选区 | 结果 |
| --- | --- | --- | --- | --- |
| 对角线→右下 | `v` | 仅纵向（bodySL 恒 0） | 单列 | ✓ 纵向长图 |
| 纯横向拖右 | `h` | 仅横向（bodyST 恒 0） | 单行 | ✓ 横向长图 |
| 纯纵向拖下 | `v` | 仅纵向 | 单列 | ✓ 纵向长图 |

> 说明：后来（见下）改为「纵向自动全宽 / 横向自动全高」，上表中的「自定义宽度（先设宽度再向下滚）」已被替换。

完整捕获链路 `drag-end → capture-start → capture-done`，无错误。

### 纵向长图自动全表宽（2026-08-11 追加，解决「表格右列截不全」）

**问题**：单轴方案下，纵向长图宽度=用户手动横向拖出的距离（夹在一屏内）。
用户只往下拖时宽度趋近 0 → 截图变成窄条/只截一屏宽 → 比一屏宽的表格右列被截掉（截图 1949 宽=全可视宽仍截不全）。

**决策（用户不在场，自主拍板：方案 A）**：纵向长图宽度**自动=容器全部内容宽**（含所有列），
横向长图高度**自动=全部内容高**（含所有行）。只需朝一个方向拖，产物即为完整表格长图；
捕获内部会按「列 × 行」瓦片网格横向+纵向滚动拼全宽（2D 网格），由可靠性加固兜底。

**实现（content.js）**：
- `finishDrag`：锁定 `v` 时强制 `rect.x=0; rect.w=sc.contentW`；锁定 `h` 时 `rect.y=0; rect.h=sc.contentH`。
- 单轴下不再要求另一维手动拖出（`tooSmall` 判断按轴跳过）。
- `updateSelection` 同样强制全宽/全高，让选区框与尺寸浮标实时反映真实捕获范围。
- 提示条：`纵向长图（全宽）· …` / `横向长图（全高）· …`。

**验证**：纯纵向拖拽（横向几乎不动）→ `drag-end rect={x:0, w:790(全内容宽), h:836}`，提示「纵向长图（全宽）· ↓」。

> 权衡：宽表格的纵向长图产物会很宽（= 表格全宽），这是「完整表格」的必然结果；若只需某几列，可后续加「截图后裁剪」或恢复自定义宽度。

### 捕获可靠性加固（2026-08-11，真实扩展仍报「有区域未能捕获」）

即使做了单轴锁定，真实 Chrome 里 admin 页（8 块单列瓦片）仍会偶发报「截图过程中有区域未能捕获」，
即某块瓦片的 `chrome.tabs.captureVisibleTab` 连续失败。加固措施：

1. **捕获期间隐藏信息卡 `.ss-badge`**（`display:none`）：
   - 它带 `backdrop-filter: blur`，某些 Chrome 版本对含 backdrop-filter 的固定元素 `captureVisibleTab`
     会返回空/报错；
   - 且卡片会污染每块瓦片（拼合长图左上角会重复出现提示卡）。改为捕获时隐藏。
2. **瓦片失败不中止整图**：`captureRegion` 改为「瓦片列表 + 第 1 遍 + 失败瓦片第 2 遍」——
   失败瓦片先滚走再滚回（强制合成器重新出帧）后重试；第 2 遍仍失败才抛错，并附带真实浏览器错误。
3. **`requestCapture` 指数退避重试**（150/250/400/650/1000ms，5 次），并记录 `state.lastCaptureError`；
   若错误是「窗口未聚焦」（`captureVisibleTab` 要求活动窗口在前台）则重试无用，立即抛明确中文提示。
4. **background 打印真实 lastError**：`console.error('[scrollshot] captureVisibleTab 失败：…')`，
   便于在 Service Worker 控制台定位根因。

## 实测验证结果（2026-08-11，集成浏览器）

通过 `test/*.html`（`__CAPTURE_TEST__` 模式直接跑 `content.js`，跳过真实截屏）验证：

| 验证项 | 结果 |
| --- | --- |
| 嵌套滚动容器识别 | ✓ `#scroller` 被识别为滚动容器 |
| 纵向边缘自动滚动 | ✓ 拖到容器底边，`scrollTop` 持续增长 |
| 横向边缘自动滚动 | ✓ 拖到容器右边，`scrollLeft` 增长到 985 |
| 选区跨屏增长 | ✓ 文档坐标选区长到 1867×1624 |
| 窗口滚动回退 | ✓ `container:"window"`，`window.scrollY` 增长 |
| 复刻页（固定布局+内部滚动） | ✓ `demo-page.html`（overflow:auto）容器滚动 1107px，`window.scrollY` 始终为 0 |
| **PerfectScrollbar 场景**（修复回归） | ✓ `perfect-scrollbar.html`：光标在宽表格上按下，识别到 `overflow:hidden` 的 `#app-content`（而非横向容器），拖到底边 `scrollTop` 0→296 持续增长，`window.scrollY` 恒为 0 |
| 横向容器兜底 | ✓ 无纵向祖先时仍识别仅横向容器（保留横向截图能力） |
| **捕获时隐藏覆盖层**（修复回归） | ✓ 捕获中 `layer.background=transparent`、选区框隐藏，完成后恢复，消除偏色与行间亮度分界 |
| **捕获完成链路**（修复回归） | ✓ `drag-end → capture-start → capture-done`，结果面板正常；`settle` 超时兜底使不可见标签页也能完成 |
| **表格固定列不被误隐藏**（修复回归） | ✓ 真实捕获全宽选区：第 8 行起「操作」列暗像素比例与 1-7 行一致（~0.05-0.09），不再空白 |
| 拼合尺寸 | ✓ 输出 = 选区 × DPR（如 200×1880 → 250×2350） |
| **DataTables FixedColumns 左固定列**（修复回归） | ✓ 左固定列区域按下：主表纵向/横向均正常滚动；主体拖拽无回归 |
| **拖拽方向锁定**（单轴长图） | ✓ 对角线拖拽不再 2D：锁定纵向/横向单轴 |
| **纵向自动全表宽**（方案A） | ✓ 纯纵向拖拽 `drag-end rect={x:0,w:全内容宽}`，提示「纵向长图（全宽）」 |
| **捕获可靠性重构**（回归） | ✓ `capture-done` 正常、结果面板显示；瓦片失败走第 2 遍重试路径，捕获期间信息卡隐藏 |
| Esc 取消 | ✓ 框选中和结果面板均可用 |

> 真实 `chrome.tabs.captureVisibleTab` 截屏与拼图需装扩展后在真实页面验证（见 README 安装与使用）。

## 已知限制（v1 明确不做）

- 虚拟滚动/懒加载列表：滚到哪才渲染到哪，跨屏拼接可能出现空白（可调大「滚动稳定等待」缓解，但无法根治）。
- 页面内容在 Shadow DOM 内部（如某些 Web Component 应用）：`elementsFromPoint` 无法穿透，可能识别不到内部滚动容器。
- 超大长图（单边 > 32000px 或选区 > 2.5 亿像素）：canvas 内存限制，会给出提示。
- 无限滚动（永远滚不到底）：由用户手动控制滚多少（这正是「拖拽式」相比「自动滚到底」的优势）。
- iframe 内滚动、跨域：v1 不处理。

## 体验目标

- 点图标即进入框选，拖到边缘自动滚，松手出图。
- 结果面板：缩略图 + 尺寸 + 保存/复制/关闭。
- Esc 随时取消。
