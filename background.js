/**
 * 滚动截图 · 拖拽即滚 — 后台 Service Worker
 * 职责：注入内容脚本、代理截屏，以及协调 Offscreen Document 分块下载。
 */
const CONTENT_FILE = 'content/content.js';
const OFFSCREEN_URL = 'offscreen.html';
const DOWNLOAD_PORT_NAME = 'scrollshot-download';
const DOWNLOAD_CHUNK_BYTES = 192 * 1024;
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_STORAGE_PREFIX = 'scrollshot-download:';

const downloadSessions = new Map();
const downloadIds = new Map();
let creatingOffscreen = null;

function lastErrorMessage(fallback) {
  return chrome.runtime.lastError ? chrome.runtime.lastError.message : fallback;
}

function isValidRequestId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160;
}

function isValidFilename(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240;
}

function base64ByteLength(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return -1;
  const padding = value.endsWith('==') ? 2 : (value.endsWith('=') ? 1 : 0);
  return (value.length / 4) * 3 - padding;
}

function postToPort(session, message) {
  if (!session.port) return;
  try {
    session.port.postMessage(message);
  } catch (err) {
    // 端口可能已断开；终态仍会通过 tabs.sendMessage 通知内容脚本。
  }
}

function sendToTab(session, message) {
  if (session.tabId == null) return;
  const options = session.frameId == null ? undefined : { frameId: session.frameId };
  try {
    chrome.tabs.sendMessage(session.tabId, message, options, () => {
      // 页面已关闭或导航时没有接收端是正常情况，但必须读取 lastError。
      lastErrorMessage('');
    });
  } catch (err) {
    // tabs API 同步抛错时原标签已不可用，无需影响已创建的下载。
  }
}

function sendToOffscreen(message) {
  // 不带回调，避免无响应消息在旧版 Chrome 产生无意义的 callback lastError。
  chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

async function hasOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [documentUrl],
    });
    return contexts.some((context) => context.documentUrl === documentUrl);
  }

  // Chrome 109–115 没有 runtime.getContexts；Service Worker 可用 clients.matchAll。
  const matched = await clients.matchAll();
  return matched.some((client) => client.url === documentUrl);
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = (async () => {
    if (await hasOffscreenDocument()) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: '为滚动截图创建临时 Blob 下载 URL',
    });
  })();

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

function deleteSession(session) {
  downloadSessions.delete(session.requestId);
  if (session.downloadId != null) downloadIds.delete(session.downloadId);
}

function releaseUnstartedSession(session) {
  if (!session || session.downloadId != null) return;
  sendToOffscreen({ type: 'DOWNLOAD_CANCEL', requestId: session.requestId });
  deleteSession(session);
}

function failBeforeDownload(session, error) {
  if (!session || !downloadSessions.has(session.requestId)) return;
  const message = { type: 'DOWNLOAD_ERROR', requestId: session.requestId, error };
  postToPort(session, message);
  sendToTab(session, message);
  sendToOffscreen({ type: 'DOWNLOAD_RELEASE_URL', requestId: session.requestId });
  deleteSession(session);
}

function sessionStorageKey(downloadId) {
  return DOWNLOAD_STORAGE_PREFIX + downloadId;
}

function persistDownloadSession(session) {
  const key = sessionStorageKey(session.downloadId);
  const value = {
    requestId: session.requestId,
    tabId: session.tabId,
    frameId: session.frameId,
    filename: session.filename,
    createdAt: session.createdAt,
  };
  return new Promise((resolve, reject) => {
    chrome.storage.session.set({ [key]: value }, () => {
      const error = lastErrorMessage('');
      if (error) reject(new Error(error));
      else resolve();
    });
  });
}

function readStoredDownload(downloadId) {
  const key = sessionStorageKey(downloadId);
  return new Promise((resolve) => {
    chrome.storage.session.get(key, (items) => {
      const error = lastErrorMessage('');
      resolve(error ? null : items[key] || null);
    });
  });
}

function removeStoredDownload(downloadId) {
  chrome.storage.session.remove(sessionStorageKey(downloadId), () => {
    lastErrorMessage('');
  });
}

async function finishDownload(downloadId, state, error) {
  let session = downloadIds.get(downloadId);
  if (!session) {
    const stored = await readStoredDownload(downloadId);
    if (!stored) return;
    session = { ...stored, downloadId, port: null, blobUrl: null };
  }

  if (state === 'complete') {
    sendToTab(session, { type: 'DOWNLOAD_COMPLETE', requestId: session.requestId });
  } else {
    sendToTab(session, {
      type: 'DOWNLOAD_ERROR',
      requestId: session.requestId,
      error: error || '保存被中断或取消',
    });
  }
  sendToOffscreen({ type: 'DOWNLOAD_RELEASE_URL', requestId: session.requestId });
  removeStoredDownload(downloadId);
  deleteSession(session);
}

function searchForTerminalDownload(session) {
  chrome.downloads.search({ id: session.downloadId }, (items) => {
    const error = lastErrorMessage('');
    if (error || !items || !items[0]) return;
    const item = items[0];
    if (item.state === 'complete') finishDownload(session.downloadId, 'complete');
    else if (item.state === 'interrupted') finishDownload(session.downloadId, 'interrupted', item.error || '保存被中断或取消');
  });
}

function startChromeDownload(session, blobUrl) {
  session.blobUrl = blobUrl;
  chrome.downloads.download({ url: blobUrl, filename: session.filename }, (downloadId) => {
    const error = lastErrorMessage('');
    if (error || downloadId == null) {
      failBeforeDownload(session, error || '保存失败');
      return;
    }
    session.downloadId = downloadId;
    downloadIds.set(downloadId, session);
    persistDownloadSession(session)
      .then(() => {
        if (downloadIds.get(downloadId) !== session) {
          // onChanged 可能在 storage.session 写入回调之前抵达；不要复活已完成会话。
          removeStoredDownload(downloadId);
          return;
        }
        postToPort(session, { type: 'DOWNLOAD_STARTED', requestId: session.requestId });
        // 存储映射写入后立即查询，覆盖极快完成且 onChanged 先到的竞态。
        searchForTerminalDownload(session);
      })
      .catch((err) => {
        // 下载已经创建，继续保留内存映射并通知真实的持久化失败原因。
        postToPort(session, { type: 'DOWNLOAD_ERROR', requestId: session.requestId, error: err.message || String(err) });
      });
  });
}

function flushToOffscreen(session) {
  if (!downloadSessions.has(session.requestId)) return;
  session.offscreenReady = true;
  for (const message of session.pendingMessages) sendToOffscreen(message);
  session.pendingMessages.length = 0;
}

function queueForOffscreen(session, message) {
  if (session.offscreenReady) sendToOffscreen(message);
  else session.pendingMessages.push({ target: 'offscreen', ...message });
}

function beginDownload(message, port) {
  const sender = port.sender;
  if (!isValidRequestId(message.requestId) || !isValidFilename(message.filename)
    || message.mime !== 'image/png' || !Number.isSafeInteger(message.byteLength)
    || message.byteLength < 0 || message.byteLength > MAX_DOWNLOAD_BYTES
    || downloadSessions.has(message.requestId)) {
    postToPort({ port }, { type: 'DOWNLOAD_ERROR', requestId: message.requestId, error: '下载请求参数无效' });
    return;
  }

  const session = {
    requestId: message.requestId,
    port,
    tabId: sender.tab.id,
    frameId: sender.frameId == null ? 0 : sender.frameId,
    filename: message.filename,
    expectedBytes: message.byteLength,
    bytes: 0,
    nextIndex: 0,
    blobUrl: null,
    downloadId: null,
    createdAt: Date.now(),
    offscreenReady: false,
    pendingMessages: [{
      target: 'offscreen',
      type: 'DOWNLOAD_BEGIN',
      requestId: message.requestId,
      filename: message.filename,
      mime: message.mime,
      byteLength: message.byteLength,
    }],
  };
  downloadSessions.set(session.requestId, session);
  ensureOffscreenDocument().then(() => flushToOffscreen(session)).catch((err) => {
    failBeforeDownload(session, err && err.message ? err.message : String(err));
  });
}

function acceptChunk(message, port) {
  const session = downloadSessions.get(message.requestId);
  if (!session || session.port !== port || !Number.isSafeInteger(message.index)
    || message.index !== session.nextIndex) {
    postToPort({ port }, { type: 'DOWNLOAD_ERROR', requestId: message && message.requestId, error: '下载分块顺序无效' });
    return;
  }
  const bytes = base64ByteLength(message.base64);
  if (bytes < 0 || bytes > DOWNLOAD_CHUNK_BYTES || session.bytes + bytes > session.expectedBytes) {
    failBeforeDownload(session, '下载分块大小无效');
    return;
  }
  session.bytes += bytes;
  session.nextIndex += 1;
  queueForOffscreen(session, {
    type: 'DOWNLOAD_CHUNK', requestId: session.requestId, index: message.index, base64: message.base64,
  });
}

function endDownload(message, port) {
  const session = downloadSessions.get(message.requestId);
  if (!session || session.port !== port || !Number.isSafeInteger(message.count)
    || message.count !== session.nextIndex || message.byteLength !== session.expectedBytes
    || session.bytes !== session.expectedBytes) {
    if (session) failBeforeDownload(session, '下载数据长度校验失败');
    else postToPort({ port }, { type: 'DOWNLOAD_ERROR', requestId: message && message.requestId, error: '下载会话不存在' });
    return;
  }
  queueForOffscreen(session, {
    type: 'DOWNLOAD_END', requestId: session.requestId, count: message.count, byteLength: message.byteLength,
  });
}

function cancelDownload(message, port) {
  const session = downloadSessions.get(message.requestId);
  if (session && session.port === port) releaseUnstartedSession(session);
}

chrome.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  if (port.name !== DOWNLOAD_PORT_NAME || !sender || !sender.tab || sender.tab.id == null) {
    port.disconnect();
    return;
  }

  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'DOWNLOAD_BEGIN') beginDownload(message, port);
    else if (message.type === 'DOWNLOAD_CHUNK') acceptChunk(message, port);
    else if (message.type === 'DOWNLOAD_END') endDownload(message, port);
    else if (message.type === 'DOWNLOAD_CANCEL') cancelDownload(message, port);
  });
  port.onDisconnect.addListener(() => {
    for (const session of downloadSessions.values()) {
      if (session.port === port) releaseUnstartedSession(session);
    }
    lastErrorMessage('');
  });
});

// 必须在 Service Worker 顶层注册，避免 worker 重启后错过下载终态。
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  if (delta.state.current === 'complete') finishDownload(delta.id, 'complete');
  else if (delta.state.current === 'interrupted') finishDownload(delta.id, 'interrupted', '保存被中断或取消');
});

function detachTab(tabId) {
  for (const session of Array.from(downloadSessions.values())) {
    if (session.tabId !== tabId) continue;
    if (session.downloadId == null) {
      releaseUnstartedSession(session);
    } else {
      // 已创建的 Chrome 下载不主动取消；仅移除无效标签映射。
      session.tabId = null;
      persistDownloadSession(session).catch(() => {});
    }
  }
}

chrome.tabs.onRemoved.addListener((tabId) => detachTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') detachTab(tabId);
});

async function startCapture(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILE] });
  } catch (err) {
    console.warn('[scrollshot] 注入失败（可能是不允许的页面）：', err);
    return;
  }
  const send = () => chrome.tabs.sendMessage(tabId, { type: 'START' }).catch(() => {});
  try {
    await send();
  } catch (err) {
    setTimeout(send, 200);
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) startCapture(tab.id);
});

chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd !== 'toggle-capture') return;
  const tabId = tab && tab.id != null ? tab.id : null;
  if (tabId != null) startCapture(tabId);
  else chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) startCapture(tabs[0].id);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  const isOffscreen = sender && sender.id === chrome.runtime.id && sender.url === offscreenUrl;
  if (isOffscreen && msg && msg.type === 'DOWNLOAD_URL_READY') {
    const session = downloadSessions.get(msg.requestId);
    if (!session || typeof msg.blobUrl !== 'string' || !msg.blobUrl.startsWith('blob:')) {
      if (session) failBeforeDownload(session, '下载 Blob URL 无效');
      return false;
    }
    startChromeDownload(session, msg.blobUrl);
    return false;
  }
  if (isOffscreen && msg && msg.type === 'DOWNLOAD_ERROR') {
    const session = downloadSessions.get(msg.requestId);
    if (session) failBeforeDownload(session, msg.error || '下载处理失败');
    return false;
  }

  if (!msg || !sender || !sender.tab) return false;
  if (msg.type === 'CAPTURE_VISIBLE') {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
      const error = lastErrorMessage('');
      if (error) {
        console.error('[scrollshot] captureVisibleTab 失败：', error);
        sendResponse({ error });
        return;
      }
      sendResponse({ dataUrl });
    });
    return true;
  }
  return false;
});
