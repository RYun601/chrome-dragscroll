# Capture Reliability Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 在不依赖 Chrome 148 structured clone 的前提下，让滚动截图的真实捕获、取消、PNG 下载和大图保护可靠工作。

**Architecture:** 内容脚本负责 canvas 编码、可取消的捕获 session 和 JSON 安全的 PNG 分块；Service Worker 负责截图队列、活动标签校验、分块协调和下载状态持久化；按需创建的 Offscreen Document 负责重组 Blob 并创建 object URL，随后把 URL 字符串交回 Service Worker 调用下载 API。

**Tech Stack:** Chrome Manifest V3、原生 JavaScript、Offscreen Document、chrome.runtime/chrome.downloads/chrome.storage.session、浏览器测试页、Node 内置 node:test（无 npm 依赖）。

## Global Constraints

- 兼容范围固定为 Chrome 109–147；Chrome 108 及更早版本不在本批次范围内。
- 不启用 message_serialization: structured_clone；默认 JSON 消息模式必须可用。
- 只新增 offscreen 权限；不新增 host permission、网络权限或数据收集。
- Offscreen Document 只能通过 chrome.runtime 通信，不能调用 chrome.downloads；URL.createObjectURL() 只允许出现在 Offscreen Document。
- 保持原生 JavaScript、无 npm、无打包器、无第三方运行时依赖。
- 保留现有滚动容器识别、单轴方向锁定和用户手动选区宽高行为。
- 新增用户可见文案、注释和文档使用简体中文；Chrome API 字段保持英文原名。
- 每个任务先让对应测试失败，再写最小实现，运行该任务测试后提交一次 Git。

## File Map

- Modify: manifest.json — 声明 offscreen 权限和 Chrome 109 最低版本。
- Modify: background.js — 截图队列、活动标签校验、取消标记、Offscreen 生命周期、分块下载协调和终态通知。
- Create: offscreen.html — 只加载本地 offscreen.js。
- Create: offscreen.js — 通过 runtime 接收分块、重组 Blob、创建/释放 object URL，不调用下载 API。
- Modify: content/content.js — 测试开关、capture session、取消清理、队列消息字段、首瓦片复用、输出像素限制、分块上传、下载状态 UI 和事件清理。
- Create: test/reliability-contract.test.js — Node 内置静态契约测试，防止清单/权限/跨上下文职责回归。
- Create: test/capture-cancel-regression.html — 捕获取消和旧会话隔离回归页。
- Create: test/capture-budget-regression.html — 高 DPR 输出预算、首瓦片复用和 PNG 字节预算回归页。
- Modify: test/capture-engine.html — 增加全流程事件和测试钩子读数。
- Modify: README.md — 更新权限、限制、保存状态和取消行为。
- Modify: docs/design.md — 记录实际实现、Offscreen 限制和验收结果。

---

### Task 1: 建立可靠性契约并实现 Offscreen 分块下载

**Files:**

- Create: test/reliability-contract.test.js
- Modify: manifest.json:2-9
- Create: offscreen.html
- Create: offscreen.js
- Modify: background.js:1-94
- Modify: content/content.js:62-81,741-777

**Interfaces:**

- Consumes: 现有 sendMessage、savePng、chrome.runtime.onMessage 和 chrome.downloads。
- Produces: DOWNLOAD_BEGIN、DOWNLOAD_CHUNK、DOWNLOAD_END、DOWNLOAD_URL_READY、DOWNLOAD_STARTED、DOWNLOAD_COMPLETE、DOWNLOAD_ERROR、DOWNLOAD_CANCEL、DOWNLOAD_RELEASE_URL；offscreen.html/offscreen.js 可由 Service Worker 按需创建。

- [ ] **Step 1: Write the failing contract tests**

创建 test/reliability-contract.test.js，使用 Node 内置模块读取项目文件并验证跨上下文职责：

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('manifest declares the offscreen permission and Chrome floor', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.minimum_chrome_version, '109');
  assert.ok(manifest.permissions.includes('offscreen'));
  assert.ok(!('message_serialization' in manifest));
});

test('offscreen document is local and Blob-only', () => {
  const html = read('offscreen.html');
  const script = read('offscreen.js');
  assert.match(html, /offscreen\.js/);
  assert.match(script, /URL\.createObjectURL/);
  assert.match(script, /DOWNLOAD_URL_READY/);
  assert.match(script, /DOWNLOAD_RELEASE_URL/);
  assert.doesNotMatch(script, /chrome\.downloads\./);
});

test('service worker delegates Blob URL creation to offscreen', () => {
  const background = read('background.js');
  assert.doesNotMatch(background, /URL\.createObjectURL/);
  assert.match(background, /chrome\.offscreen\.createDocument/);
  assert.match(background, /DOWNLOAD_URL_READY/);
  assert.match(background, /chrome\.downloads\.onChanged/);
});

test('content script exposes JSON-safe download and capture cancellation messages', () => {
  const content = read(path.join('content', 'content.js'));
  assert.match(content, /DOWNLOAD_BEGIN/);
  assert.match(content, /DOWNLOAD_CHUNK/);
  assert.match(content, /DOWNLOAD_END/);
  assert.match(content, /CAPTURE_CANCEL/);
  assert.match(content, /64_000_000/);
  assert.match(content, /128 MiB|128 \* 1024 \* 1024/);
});
~~~

- [ ] **Step 2: Run contract tests and confirm they fail**

Run:

~~~powershell
node --test test/reliability-contract.test.js
~~~

Expected: FAIL because the current manifest has no minimum_chrome_version/offscreen, no Offscreen files exist, background.js still calls URL.createObjectURL, and content/content.js has no download protocol constants.

- [ ] **Step 3: Add the manifest declaration and Offscreen document**

在 manifest.json 中加入：

~~~json
"minimum_chrome_version": "109",
"permissions": ["activeTab", "scripting", "storage", "downloads", "clipboardWrite", "offscreen"]
~~~

创建 offscreen.html：

~~~html
<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>滚动截图后台处理</title></head>
<body><script src="offscreen.js"></script></body>
</html>
~~~

创建 offscreen.js，实现以下确定接口：

~~~js
const sessions = new Map();

function send(message) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

function release(requestId) {
  const session = sessions.get(requestId);
  if (!session) return;
  if (session.blobUrl) URL.revokeObjectURL(session.blobUrl);
  sessions.delete(requestId);
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== 'offscreen') return;
  if (message.type === 'DOWNLOAD_BEGIN') {
    release(message.requestId);
    sessions.set(message.requestId, {
      filename: message.filename,
      mime: message.mime,
      expectedBytes: message.byteLength,
      nextIndex: 0,
      bytes: 0,
      chunks: [],
      blobUrl: null,
    });
  } else if (message.type === 'DOWNLOAD_CHUNK') {
    const session = sessions.get(message.requestId);
    if (!session || message.index !== session.nextIndex) {
      send({ type: 'DOWNLOAD_ERROR', requestId: message.requestId, error: '下载分块顺序无效' });
      return;
    }
    const binary = atob(message.base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    session.chunks.push(bytes);
    session.bytes += bytes.byteLength;
    session.nextIndex += 1;
  } else if (message.type === 'DOWNLOAD_END') {
    const session = sessions.get(message.requestId);
    if (!session || session.bytes !== session.expectedBytes || session.nextIndex !== message.count) {
      send({ type: 'DOWNLOAD_ERROR', requestId: message.requestId, error: '下载数据长度校验失败' });
      release(message.requestId);
      return;
    }
    const blob = new Blob(session.chunks, { type: session.mime });
    session.blobUrl = URL.createObjectURL(blob);
    send({
      type: 'DOWNLOAD_URL_READY',
      requestId: message.requestId,
      blobUrl: session.blobUrl,
      filename: session.filename,
    });
  } else if (message.type === 'DOWNLOAD_RELEASE_URL' || message.type === 'DOWNLOAD_CANCEL') {
    release(message.requestId);
  }
});
~~~

Offscreen Document 只使用 chrome.runtime；下载 API 仍由 Service Worker 调用。

Offscreen 的 runtime listener 只接受来自扩展自身 Service Worker 的消息（sender.id 等于当前扩展 id 且 sender.url 为扩展 URL），拒绝网页 content script 直接伪造的 target=offscreen 消息。

- [ ] **Step 4: Implement Service Worker download session coordination**

在 background.js 中加入：

- ensureOffscreenDocument()：优先使用 chrome.runtime.getContexts 检查 offscreen.html；Chrome 116 之前回退到 Service Worker 的 clients.matchAll()；以全局 creatingOffscreen Promise 避免并发创建；缺少文档时调用 chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: '为滚动截图创建临时 Blob 下载 URL' })。
- downloadSessions：按 requestId 保存 port、tabId、frameId、filename、blobUrl、downloadId、createdAt。
- chrome.runtime.onConnect：只处理 name 为 scrollshot-download 且 sender.tab 存在的连接；校验每条消息的 request id、文件名、分块大小和累计字节；收到 BEGIN 后确保 Offscreen Document 存在并转发；收到 CHUNK/END 后按会话转发。
- DOWNLOAD_URL_READY：只接受 sender.url 等于 chrome.runtime.getURL('offscreen.html') 的消息，验证 blobUrl 为 blob: 字符串后调用 chrome.downloads.download({ url: blobUrl, filename })；后台自身不得调用 URL.createObjectURL。
- chrome.downloads.onChanged 顶层监听：将 complete/interrupted 映射为 DOWNLOAD_COMPLETE/DOWNLOAD_ERROR，通知原 tabId，发送 DOWNLOAD_RELEASE_URL，清理 session。
- 在 downloadId 写入 chrome.storage.session 后立刻调用 chrome.downloads.search({ id })，处理创建后立即完成的竞态。
- tabs.onRemoved 和主框架导航清理失效 tab 的状态映射；已经创建的下载不主动取消。

sendResponse 和 Promise 错误必须读取 chrome.runtime.lastError 并传递真实错误，不再把所有错误折叠成空对象。

- [ ] **Step 5: Replace savePng() with the JSON-safe port upload**

在 content/content.js 中创建 runtime.Port：

~~~js
const DOWNLOAD_CHUNK_BYTES = 192 * 1024;

async function sendBlobInChunks(blob, filename, onStatus) {
  const requestId = createRequestId();
  const port = chrome.runtime.connect({ name: 'scrollshot-download' });
  let index = 0;
  port.onMessage.addListener((message) => onStatus(message, requestId));
  port.postMessage({ type: 'DOWNLOAD_BEGIN', requestId, filename, mime: 'image/png', byteLength: blob.size });
  for (let offset = 0; offset < blob.size; offset += DOWNLOAD_CHUNK_BYTES) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + DOWNLOAD_CHUNK_BYTES).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    port.postMessage({ type: 'DOWNLOAD_CHUNK', requestId, index, base64: btoa(binary) });
    index += 1;
  }
  port.postMessage({ type: 'DOWNLOAD_END', requestId, count: index, byteLength: blob.size });
  return { requestId, port };
}
~~~

savePng() 在 canvas.toBlob() 后先检查 blob.size 不超过 128 * 1024 * 1024，再调用 sendBlobInChunks()；保存状态由 DOWNLOAD_STARTED、DOWNLOAD_COMPLETE 和 DOWNLOAD_ERROR 驱动。用户关闭面板只关闭 UI，不取消已经创建的 Chrome 下载；在下载创建前关闭则发送 DOWNLOAD_CANCEL 并断开 port。

- [ ] **Step 6: Run contract tests and syntax checks**

Run:

~~~powershell
node --test test/reliability-contract.test.js
node --check background.js
node --check content\content.js
node --check offscreen.js
~~~

Expected: all contract tests pass and all four JavaScript files report no syntax error.

- [ ] **Step 7: Commit the download transport**

~~~powershell
git add manifest.json background.js content\content.js offscreen.html offscreen.js test\reliability-contract.test.js
git commit -m "fix: use offscreen document for reliable png downloads"
~~~

### Task 2: Add capture session cancellation and stale-result protection

**Files:**

- Create: test/capture-cancel-regression.html
- Modify: content/content.js:42-57,262-332,334-447,450-490,575-604,779-817

**Interfaces:**

- Consumes: Task 1 的 CAPTURE_CANCEL 消息和 captureId 字段。
- Produces: captureSession 对象、cancelCaptureSession(reason)、isSessionCurrent(session)、测试模式 window.__CAPTURE_TEST_HOOKS__。

- [ ] **Step 1: Write the failing browser regression page**

创建 test/capture-cancel-regression.html，在引入内容脚本前安装一个永不自动完成的测试截图钩子：

~~~html
<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>捕获取消回归</title><style>#scroller{height:240px;width:420px;overflow:auto}#content{height:1800px;width:900px;background:repeating-linear-gradient(#fff 0 39px,#e5e7eb 40px)}#result{white-space:pre;font:13px monospace}</style></head>
<body>
<div id="scroller"><div id="content"></div></div><pre id="result">测试准备中…</pre>
<script>
  let releaseCapture;
  window.__CAPTURE_TEST__ = true;
  window.__CAPTURE_TEST_HOOKS__ = {
    requestCapture: () => new Promise((resolve) => { releaseCapture = resolve; }),
  };
</script>
<script src="../content/content.js"></script>
<script>
  (async () => {
    const result = document.getElementById('result');
    const host = document.querySelector('#__scrollshot-host__');
    const layer = host.shadowRoot.querySelector('.ss-layer');
    const scroller = document.getElementById('scroller');
    const box = scroller.getBoundingClientRect();
    const x = box.left + 80;
    const y = box.top + 70;
    const origin = scroller.scrollTop;
    layer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 21, clientX: x, clientY: y }));
    layer.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1, pointerId: 21, clientX: x + 100, clientY: box.bottom - 2 }));
    layer.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 21, clientX: x + 100, clientY: box.bottom - 2 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    window.__scrollshotStop();
    if (typeof releaseCapture === 'function') releaseCapture(null);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const lateDone = window.__scrollshotEvents.some((event) => event.ev === 'capture-done');
    if (Math.abs(scroller.scrollTop - origin) > 1 || lateDone) throw new Error('取消后仍继续滚动或显示迟到结果');
    result.textContent = 'PASS\n取消后未继续滚动，也没有迟到结果';
  })().catch((error) => { document.getElementById('result').textContent = 'FAIL\n' + (error.message || error); });
</script>
</body>
</html>
~~~

- [ ] **Step 2: Run the new page and confirm it fails**

Open file:///F:/chrome-dragscroll/test/capture-cancel-regression.html in Chrome and wait for PASS or FAIL.

Expected: FAIL or never reaches the assertion because the current script ignores __CAPTURE_TEST_HOOKS__ and has no capture session cancellation boundary.

- [ ] **Step 3: Implement the session model and test hook**

在状态中增加：

~~~js
captureSession: null,
captureSerial: 0,
capturing: false,
~~~

新增：

~~~js
function createCaptureSession(sc, hostAtStart) {
  const id = ++state.captureSerial;
  return {
    id,
    captureId: 'capture-' + id,
    cancelled: false,
    cleaned: false,
    scroller: sc,
    originalScroll: { x: sc.scrollLeft, y: sc.scrollTop },
    hiddenElements: [],
    hostAtStart,
    abortController: new AbortController(),
  };
}

function isSessionCurrent(session) {
  return !!session && !session.cancelled && state.captureSession === session && host === session.hostAtStart;
}

function cancelCaptureSession(reason) {
  const session = state.captureSession;
  if (!session || session.cleaned) return;
  session.cancelled = true;
  session.abortController.abort(reason);
  if (session.captureId && !IS_TEST) sendMessage({ type: 'CAPTURE_CANCEL', captureId: session.captureId });
  cleanupCaptureSession(session);
}
~~~

runCapture(session, rect)、captureRegion(session, rect) 和所有异步等待点都在前后调用 isSessionCurrent()；不可中断的 API 返回后只允许释放 Bitmap 和执行幂等清理。finishDrag() 设置 state.capturing = true 并保存 state.captureSession；捕获期间 onPointerDown 直接忽略。

测试模式的 requestCapture() 在 window.__CAPTURE_TEST_HOOKS__.requestCapture 存在时调用该钩子，否则保持原来的 return null。

- [ ] **Step 4: Make teardown and pointer cancellation abort safely**

调整行为：

- teardown() 先调用 cancelCaptureSession('teardown')，再移除宿主节点；
- pointercancel 调用 teardown() 或取消当前拖拽，不再调用 finishDrag() 开始截图；
- showResult() 和 showError() 在显示前验证当前 session；
- cleanupCaptureSession() 恢复原始滚动、fixed/sticky 可见性、scroll behavior、object URL，并保证重复调用无副作用；
- document 的 keydown 监听在 teardown 中移除，或者由一个 AbortController 统一绑定/解除；
- 新一轮 start() 创建新 session 时，旧 session 的晚到结果不能写入新 els。

- [ ] **Step 5: Run the cancellation regression and existing interaction pages**

Run browser pages:

- test/capture-cancel-regression.html — Expected: PASS。
- test/selection-width-regression.html — Expected: PASS。
- test/selection-height-regression.html — Expected: PASS。
- test/perfect-scrollbar.html — Expected: internal container continues scrolling。
- test/window-scroll.html — Expected: window fallback continues scrolling。

- [ ] **Step 6: Commit the capture session**

~~~powershell
git add content\content.js test\capture-cancel-regression.html
git commit -m "fix: make capture sessions cancellable"
~~~

### Task 3: Add global screenshot throttling, active-tab checks and output budgets

**Files:**

- Create: test/capture-budget-regression.html
- Modify: background.js:42-94
- Modify: content/content.js:334-604

**Interfaces:**

- Consumes: Task 2 的 captureId/session checks。
- Produces: CAPTURE_VISIBLE { captureId }、CAPTURE_CANCEL { captureId }、background capture queue、MAX_OUTPUT_PIXELS = 64_000_000、PNG limit 128 * 1024 * 1024。

- [ ] **Step 1: Write the failing budget and test-mode contract**

在 test/reliability-contract.test.js 追加：

~~~js
test('capture path has queue, active-tab guard and output budget', () => {
  const background = read('background.js');
  const content = read(path.join('content', 'content.js'));
  assert.match(background, /CAPTURE_VISIBLE/);
  assert.match(background, /captureQueue/);
  assert.match(background, /tabs\.get/);
  assert.match(background, /550/);
  assert.match(content, /MAX_OUTPUT_PIXELS/);
  assert.match(content, /outW \* outH/);
  assert.match(content, /captureId/);
});
~~~

创建 test/capture-budget-regression.html，先验证测试钩子和预算 API 存在：

~~~html
<script>
  window.__CAPTURE_TEST__ = true;
  window.__CAPTURE_TEST_HOOKS__ = { captureScale: 2, captureCount: 0 };
</script>
<script src="../content/content.js"></script>
<script>
  const result = document.body.appendChild(document.createElement('pre'));
  try {
    if (!window.__scrollshotTestApi || typeof window.__scrollshotTestApi.validateOutputBudget !== 'function') throw new Error('缺少输出预算测试 API');
    let rejected = false;
    try { window.__scrollshotTestApi.validateOutputBudget(16000, 16000, 2); } catch (error) { rejected = true; }
    if (!rejected) throw new Error('高 DPR 超大输出未被拒绝');
    result.textContent = 'PASS\n高 DPR 超大输出已被拒绝';
  } catch (error) {
    result.textContent = 'FAIL\n' + (error.message || error);
  }
</script>
~~~

- [ ] **Step 2: Run the budget checks and confirm they fail**

Run:

~~~powershell
node --test test/reliability-contract.test.js
~~~

Open the new browser page. Expected: Node test fails because there is no queue/active-tab guard, and the page reports FAIL because no test budget API exists.

- [ ] **Step 3: Implement the Service Worker capture queue**

在 background.js 中定义一个跨标签共享的队列：

~~~js
const CAPTURE_INTERVAL_MS = 550;
const captureQueue = [];
const cancelledCaptures = new Set();
let capturePump = Promise.resolve();
let lastCaptureAt = 0;

function captureKey(tabId, captureId) {
  return String(tabId) + ':' + String(captureId);
}

function cancelCapture(tabId, captureId) {
  if (tabId != null && captureId) cancelledCaptures.add(captureKey(tabId, captureId));
}

function queueVisibleCapture({ tabId, windowId, captureId }) {
  const key = captureKey(tabId, captureId);
  return new Promise((resolve, reject) => {
    captureQueue.push({ key, tabId, windowId, captureId, resolve, reject });
    pumpCaptureQueue();
  });
}

async function pumpCaptureQueue() {
  capturePump = capturePump.then(async () => {
    while (captureQueue.length) {
      const item = captureQueue.shift();
      try {
        if (cancelledCaptures.has(item.key)) throw new Error('截图会话已取消');
        const wait = Math.max(0, CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt));
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        if (cancelledCaptures.has(item.key)) throw new Error('截图会话已取消');
        const tab = await chrome.tabs.get(item.tabId);
        if (!tab || tab.windowId !== item.windowId || !tab.active) throw new Error('原截图标签已不再激活');
        lastCaptureAt = Date.now();
        await new Promise((resolve, reject) => {
          try {
            chrome.tabs.captureVisibleTab(item.windowId, { format: 'png' }, (dataUrl) => {
              const error = chrome.runtime.lastError;
              if (error) reject(new Error(error.message));
              else resolve(dataUrl);
            });
          } catch (error) { reject(error); }
        }).then(item.resolve, item.reject);
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        cancelledCaptures.delete(item.key);
      }
    }
  }).catch(() => {});
  return capturePump;
}
~~~

消息处理器对 CAPTURE_VISIBLE 读取 sender.tab.id/windowId 和 msg.captureId，调用队列并返回真实错误；CAPTURE_CANCEL 调用 cancelCapture() 并清理已完成的取消标记。

- [ ] **Step 4: Rework captureRegion to reuse the first real tile**

删除单独的 probe 请求。捕获流程改为：

1. 计算瓦片坐标并滚到第一块；
2. settle(session) 后请求第一块真实截图；
3. 从第一块 bitmap 计算 scale，创建 canvas 并绘制第一块；
4. 对剩余瓦片按队列顺序滚动、等待、捕获和绘制；
5. 每次 await 前后检查 session 是否有效，失败瓦片按原有有限次数重试。

requestCapture(session) 在真实扩展中发送 { type: 'CAPTURE_VISIBLE', captureId: session.captureId }；测试模式读取 captureScale，不访问 Chrome API。

- [ ] **Step 5: Add actual output budget checks**

在 content/content.js 统一定义：

~~~js
const MAX_OUTPUT_PIXELS = 64_000_000;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

function validateOutputBudget(cssW, cssH, scale) {
  const outW = Math.max(1, Math.round(cssW * scale));
  const outH = Math.max(1, Math.round(cssH * scale));
  if (outW > 32000 || outH > 32000) throw new Error('截图尺寸 ' + outW + ' × ' + outH + ' 超出浏览器单边限制 32000px');
  if (outW * outH > MAX_OUTPUT_PIXELS) throw new Error('输出 ' + outW + ' × ' + outH + ' 像素过大，请缩小选区或降低浏览器缩放');
  return { outW, outH };
}
~~~

将 validateOutputBudget 暴露到 window.__scrollshotTestApi 仅限 IS_TEST；真实路径在创建 canvas 之前调用。canvas.toBlob() 结果在分块下载之前检查 blob.size <= MAX_OUTPUT_BYTES。

- [ ] **Step 6: Run queue, budget and interaction checks**

Run:

~~~powershell
node --test test/reliability-contract.test.js
node --check background.js
node --check content\content.js
~~~

Browser checks:

- test/capture-budget-regression.html — Expected: PASS for 16000×16000 CSS at scale 2 being rejected with a readable message。
- Existing width/height regression pages — Expected: PASS。
- test/capture-engine.html — Expected: one-axis scroll and capture-start/capture-done event order unchanged。

- [ ] **Step 7: Commit queue and budgets**

~~~powershell
git add background.js content\content.js test\reliability-contract.test.js test\capture-budget-regression.html
git commit -m "fix: throttle captures and enforce output budgets"
~~~

### Task 4: Harden settings, lifecycle cleanup and accessibility

**Files:**

- Modify: options.html:7-57
- Modify: options.js:4-39
- Modify: content/content.js:779-839

**Interfaces:**

- Consumes: Existing DEFAULTS and chrome.storage.sync settings。
- Produces: normalizeSettings(value)、可见的保存失败状态、无残留 keydown 监听、带 label/main/aria 的设置页。

- [ ] **Step 1: Write failing settings/accessibility contract tests**

在 test/reliability-contract.test.js 追加：

~~~js
test('options page labels every form control and exposes a main landmark', () => {
  const html = read('options.html');
  for (const id of ['edgeMargin', 'scrollSpeed', 'settleDelay', 'hideFixed', 'filenamePrefix']) {
    assert.match(html, new RegExp('for=[\"' + String.fromCharCode(39) + ']' + id + '[\"' + String.fromCharCode(39) + ']'));
  }
  assert.match(html, /<main>/);
  assert.match(html, /aria-live=[\"']polite[\"']/);
});

test('options values are normalized in code', () => {
  const script = read('options.js');
  assert.match(script, /normalizeSettings/);
  assert.match(script, /Math\.min/);
  assert.match(script, /storage\.sync/);
});

test('content script removes the document keydown listener', () => {
  const content = read(path.join('content', 'content.js'));
  assert.match(content, /removeEventListener\(['"]keydown/);
});
~~~

- [ ] **Step 2: Run tests and confirm they fail**

~~~powershell
node --test test/reliability-contract.test.js
~~~

Expected: new tests fail because labels have no for, no main/aria-live, values are not normalized, and keydown is never removed.

- [ ] **Step 3: Implement settings normalization and error feedback**

在 options.js 和 content/content.js 中分别增加同样边界的 normalizeSettings()；两个上下文不共享 JavaScript 模块，必须各自校验同步数据。

在 options.js 中增加：

~~~js
function boundedNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function normalizeSettings(raw = {}) {
  return {
    edgeMargin: boundedNumber(raw.edgeMargin, 8, 200, DEFAULTS.edgeMargin),
    scrollSpeed: boundedNumber(raw.scrollSpeed, 100, 5000, DEFAULTS.scrollSpeed),
    settleDelay: boundedNumber(raw.settleDelay, 0, 2000, DEFAULTS.settleDelay),
    hideFixed: raw.hideFixed === true,
    filenamePrefix: String(raw.filenamePrefix || DEFAULTS.filenamePrefix)
      .replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || DEFAULTS.filenamePrefix,
  };
}
~~~

load() 读取后调用 normalizeSettings；save() 同样先归一化，使用 try/catch 显示“保存失败：…”；状态元素加 aria-live=polite。

content/content.js 的 loadSettings() 将 storage.sync 返回值交给同样的 normalizeSettings()，读取异常或越界值回退到 DEFAULTS。

- [ ] **Step 4: Implement semantic labels and lifecycle cleanup**

将设置页包在 main 中，并为每个 label 添加 for：

~~~html
<main>
  <div class="field">
    <label for="edgeMargin">边缘触发距离 (px)<span class="help">光标靠近滚动区域边缘多少像素内开始自动滚动</span></label>
    <input type="number" id="edgeMargin" min="8" max="200" />
  </div>
  <div class="field">
    <label for="hideFixed">截图时隐藏固定/悬浮元素<span class="help">避免页头/悬浮按钮在长图中重复出现</span></label>
    <input type="checkbox" id="hideFixed" />
  </div>
  <span id="status" aria-live="polite"></span>
</main>
~~~

在内容脚本中保存绑定状态：

~~~js
let eventsBound = false;

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;
  // 绑定 layer 监听
  document.addEventListener('keydown', onKeyDown, true);
}

function unbindEvents() {
  if (!eventsBound) return;
  document.removeEventListener('keydown', onKeyDown, true);
  eventsBound = false;
}
~~~

teardown() 调用 unbindEvents()；宿主节点移除后不得留下 document 监听。

- [ ] **Step 5: Run settings and accessibility checks**

Run:

~~~powershell
node --test test/reliability-contract.test.js
node --check options.js
~~~

Open options.html in the extension options context and verify each field is keyboard-labelable, invalid values are clamped, storage errors are visible, and save status is announced.

- [ ] **Step 6: Commit settings and lifecycle hardening**

~~~powershell
git add options.html options.js content\content.js test\reliability-contract.test.js
git commit -m "fix: harden settings and overlay lifecycle"
~~~

### Task 5: Update project documentation and complete acceptance

**Files:**

- Modify: README.md:40-103
- Modify: docs/design.md
- Modify: test/capture-engine.html

**Interfaces:**

- Consumes: Tasks 1–4 的实际实现、测试输出和真实扩展验收结果。
- Produces: 与实现一致的权限、限制、状态文案和验收记录。

- [ ] **Step 1: Write documentation consistency checks**

在 test/reliability-contract.test.js 追加：

~~~js
test('readme documents the implemented limits and permission', () => {
  const readme = read('README.md');
  assert.match(readme, /offscreen/);
  assert.match(readme, /6400 万|64.?000.?000/);
  assert.match(readme, /128 MiB|128.?MB/);
  assert.match(readme, /切换标签|标签.*取消/);
});
~~~

- [ ] **Step 2: Run the new documentation check and confirm it fails**

~~~powershell
node --test test/reliability-contract.test.js
~~~

Expected: the documentation test fails until README is updated.

- [ ] **Step 3: Update README and design history**

在 README 中准确说明：

- 权限列表增加 offscreen，解释它只用于本地隐藏文档处理 Blob URL；
- 兼容范围为 Chrome 109+，不依赖 Chrome 148 structured clone；
- 输出限制为单边 32000px、实际输出不超过 6400 万像素、PNG 不超过 128 MiB；
- 保存状态为“准备/传输/浏览器正在保存/已保存/失败”；
- 捕获期间切换标签会取消任务，按 Esc 会恢复滚动位置；
- 测试模式不会执行真实 captureVisibleTab，真实保存需加载扩展验收。

在 docs/design.md 追加本次修复的日期、原因、Offscreen API 约束、队列/取消/预算设计和实际测试结果；不要写入未执行的“通过”。

- [ ] **Step 4: Run the complete automated checks**

~~~powershell
node --test test/reliability-contract.test.js
node --check background.js
node --check content\content.js
node --check offscreen.js
node --check options.js
git diff --check
~~~

Expected: all Node tests pass, all syntax checks pass, and git diff --check has no output。

- [ ] **Step 5: Run browser regression pages**

In Chrome, open and record the result for each:

- test/capture-cancel-regression.html — cancellation and stale-result isolation。
- test/capture-budget-regression.html — actual output pixel budget。
- test/selection-width-regression.html — manual width retained after vertical scroll。
- test/selection-height-regression.html — manual height retained after horizontal scroll。
- test/demo-page.html — nested overflow:auto container。
- test/perfect-scrollbar.html — overflow:hidden vertical container plus horizontal child。
- test/capture-engine.html — nested scrolling and event order。
- test/window-scroll.html — window fallback。

Expected: every page reports PASS or the documented interactive behavior; no uncaught console error。

- [ ] **Step 6: Load the unpacked extension and perform real acceptance**

在 chrome://extensions/ 开发者模式加载项目目录，执行：

1. 工具栏按钮与 Alt+Shift+S 开始/退出；
2. 在 demo-page.html 和 perfect-scrollbar.html 上分别截图至少 3 块瓦片；
3. 记录 Service Worker 控制台中相邻 captureVisibleTab 调用间隔，确认不小于 550ms；
4. 捕获中按 Esc，确认页面恢复起始滚动位置且无迟到结果；
5. 捕获中切换同窗口另一标签，确认任务取消且不保存错图；
6. 保存小图和中图，确认下载任务最终显示“已保存”；
7. 点击取消保存或制造磁盘失败，确认显示明确错误；
8. 在 125%、150%、200% 缩放下检查输出尺寸；
9. 验证超 6400 万像素或超 128 MiB 的图片被拒绝；
10. 在 HTTPS 或 localhost 测试复制图片。

- [ ] **Step 7: Inspect diff and commit the complete implementation**

~~~powershell
git status --short
git diff --stat
git diff --check
git add README.md docs\design.md test\capture-engine.html
git commit -m "docs: document capture reliability acceptance"
git status --short
~~~

Expected: only intended source, test and documentation files are committed; final git status --short is empty。

## Final Acceptance Checklist

- [ ] node --test test/reliability-contract.test.js passes。
- [ ] node --check background.js、content/content.js、offscreen.js、options.js all pass。
- [ ] Existing and new browser regression pages pass。
- [ ] Real extension PNG save works through Offscreen Document and does not call URL.createObjectURL() in Service Worker。
- [ ] Real capture calls are globally throttled to at most two per second。
- [ ] Cancel, restart, tab switch and port disconnect do not scroll or display stale results。
- [ ] Actual output pixel and PNG byte budgets stop unsafe exports。
- [ ] README and design history match the implementation and actual verification。
- [ ] Git worktree is clean after the final commit。
