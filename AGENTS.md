# AGENTS.md

## 项目概览

这是一个原生 JavaScript 编写的 Chrome Manifest V3 浏览器扩展，名称为“滚动截图 · 拖拽即滚”。核心能力是识别光标下的真实滚动容器，在拖拽到边缘时自动滚动，并将多个视口截图拼接为 PNG。

项目当前不使用 npm、打包器、框架或第三方运行时依赖。源码、测试页和图标均直接从扩展根目录加载。

## 目录与职责

- `manifest.json`：MV3 清单、权限、Service Worker、快捷键和设置页声明。
- `background.js`：注入 `content/content.js`，代理 `captureVisibleTab`、下载和运行时消息。
- `content/content.js`：覆盖层、拖拽状态、滚动容器识别、边缘滚动、分块捕获和拼图。
- `options.html` / `options.js`：设置页及 `chrome.storage.sync` 读写。
- `test/*.html`：不安装扩展即可运行的交互式引擎测试页，通过 `window.__CAPTURE_TEST__` 跳过真实截屏。
- `docs/design.md`：设计决策、问题根因、已知限制和历史验证记录。
- `build-icons.ps1`：使用 .NET `System.Drawing` 重新生成 `icons/icon16.png`、`icon48.png` 和 `icon128.png`。

## 开发约定

- 保持现有的原生 JavaScript 风格；除非明确提出，不引入框架、构建系统或外部依赖。
- 用户可见文案、注释和项目文档使用简体中文；Chrome API 名称、事件名和协议字段保留英文原名。
- 先理解 `content/content.js` 的状态机和坐标模型，再修改滚动、选区或捕获逻辑。`window` 与元素滚动容器应继续通过统一 scroller 接口处理。
- 维持内容脚本的幂等注入行为（`window.__SCROLLSHOT_INJECTED__`），不要让重复注入创建多个覆盖层或事件监听器。
- 保持权限最小化。新增 manifest 权限、网络请求、数据收集或持久化数据前，必须同步更新 README 的权限说明并说明必要性。
- 不要把 `icons/` 下的 PNG 当作构建缓存忽略；它们是 manifest 引用的已提交资源。
- 修改交互行为、默认设置、权限或已知限制时，同步更新 `README.md`，必要时更新 `docs/design.md`。

## 验证方式

本项目没有 npm test 或自动化测试命令。修改后按变更范围执行：

1. 用浏览器直接打开相关 `test/*.html`，验证拖拽、边缘自动滚动、窗口回退、嵌套容器和横向滚动；涉及容器识别时至少检查 `demo-page.html`、`perfect-scrollbar.html` 和 `capture-engine.html`。
2. 在 `chrome://extensions/` 开启开发者模式，加载项目根目录，验证工具栏按钮、`Alt+Shift+S`、`Esc`、设置页、保存 PNG 和复制图片。真实截屏链路必须在扩展环境中验证，测试页会跳过该步骤。
3. 修改 JavaScript 后可使用 `node --check background.js`、`node --check content/content.js` 和 `node --check options.js` 做语法检查（若本机未安装 Node，则说明无法执行，不要为此引入运行时）。
4. 修改图标生成逻辑后运行 `./build-icons.ps1`，确认三个 PNG 均存在且 manifest 中的路径有效。

验证报告应写明实际执行的页面/命令和结果；不要把“已阅读代码”当作测试通过。

## 交付检查

- 检查 `git diff`，确保没有把本地配置、临时截图或无关文件带入提交。
- 检查 `git status --short`，确认新增文件是否确实应纳入版本控制。
- 不要提交浏览器配置、编辑器个人设置、日志、覆盖率目录或构建输出；具体忽略规则见 `.gitignore`。
- 若真实 Chrome 截屏、剪贴板或特定页面仍未验证，应在交付说明中明确标注。
