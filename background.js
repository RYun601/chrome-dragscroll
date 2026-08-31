/**
 * 滚动截图 · 拖拽即滚 — 后台 Service Worker
 * 职责：注入内容脚本、代理截屏/下载/设置读写。
 */
const CONTENT_FILE = 'content/content.js';

async function startCapture(tabId) {
  // 注入内容脚本（已注入过则直接复用，脚本内部有幂等守卫）
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
    // 内容脚本可能尚未就绪，稍后重试一次
    setTimeout(send, 200);
  }
}

// 点击工具栏图标 → 开始框选
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) startCapture(tab.id);
});

// 快捷键 Alt+Shift+S → 开始/退出
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd !== 'toggle-capture') return;
  const tabId = tab && tab.id != null ? tab.id : null;
  if (tabId != null) {
    startCapture(tabId);
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) startCapture(tabs[0].id);
    });
  }
});

// 内容脚本消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender || !sender.tab) return false;

  if (msg.type === 'CAPTURE_VISIBLE') {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.error('[scrollshot] captureVisibleTab 失败：', chrome.runtime.lastError.message);
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ dataUrl });
    });
    return true; // 异步响应
  }

  if (msg.type === 'DOWNLOAD') {
    // Blob 直存：content 传二进制 Blob，这里转 objectURL 供下载，避免超大 base64 字符串
    const url = msg.dataUrl || (msg.blob ? URL.createObjectURL(msg.blob) : null);
    if (!url) {
      sendResponse({ ok: false, error: '没有可保存的图片数据' });
      return true;
    }
    chrome.downloads.download(
      { url, filename: msg.filename || 'screenshot.png' },
      (id) => {
        if (chrome.runtime.lastError || id == null) {
          if (url.startsWith('blob:')) URL.revokeObjectURL(url);
          sendResponse({ ok: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : '保存失败' });
          return;
        }
        // 等文件真正保存完成（用户确认「另存为」对话框并写入磁盘）后再回 ok，
        // 避免在「已开始下载」时误报「已保存」。
        const onChanged = (delta) => {
          if (delta.id !== id) return;
          if (delta.state && delta.state.current === 'complete') {
            chrome.downloads.onChanged.removeListener(onChanged);
            if (url.startsWith('blob:')) URL.revokeObjectURL(url);
            sendResponse({ ok: true, state: 'complete' });
          } else if (delta.state && delta.state.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(onChanged);
            if (url.startsWith('blob:')) URL.revokeObjectURL(url);
            sendResponse({ ok: false, error: '保存被中断或取消' });
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);
      }
    );
    return true;
  }

  return false;
});
