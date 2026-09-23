/**
 * 复制中介页（chrome-extension:// 扩展页，属于安全上下文）。
 *
 * 存在意义：普通 HTTP 页面里 navigator.clipboard 整个 API 都不存在（非安全上下文），
 * 无法直接写剪贴板；Offscreen Document 永远没有焦点，clipboard.write 同样被拒。
 * 扩展页 + clipboardWrite 权限 + 窗口聚焦即可写入，因此由它代劳。
 *
 * 数据流：本页通过 chrome.tabs.sendMessage 向内容脚本分批索取 base64 分块
 * （Blob 无法通过扩展消息传递），重组为 Blob 后写入剪贴板，结果回传内容脚本。
 */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const requestId = params.get('req');
  const tabId = Number(params.get('tab'));
  const statusEl = document.getElementById('st');
  const COPY_CHUNK_BATCH = 8; // 与 content.js 保持一致

  function base64ToBlob(base64, mime) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function finish(text, ok, delay) {
    statusEl.textContent = text;
    statusEl.className = ok ? 'ok' : 'err';
    setTimeout(() => window.close(), delay);
  }

  function report(payload) {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'COPY_RESULT', requestId, ...payload }, () => void chrome.runtime.lastError);
    } catch (err) { /* 页面可能已关闭 */ }
  }

  function fetchChunks(from) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, { type: 'COPY_CHUNKS', requestId, from, count: COPY_CHUNK_BATCH }, (resp) => {
          const err = chrome.runtime.lastError;
          resolve(err ? { error: err.message } : (resp || { error: '内容脚本无响应' }));
        });
      } catch (err) {
        resolve({ error: String(err && err.message) || String(err) });
      }
    });
  }

  // 剪贴板写入要求文档可见。浏览器在后台时本弹窗可能是隐藏状态，此时
  // navigator.clipboard.write() 会正常 resolve 但剪贴板并不会写入数据，
  // 因此先等窗口显示，避免把「没复制成功」报成成功。
  function waitUntilVisible(timeoutMs) {
    if (document.visibilityState === 'visible') return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = 0;
      const cleanup = () => {
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', check);
      };
      const check = () => {
        if (document.visibilityState !== 'visible') return;
        cleanup();
        resolve(true);
      };
      timer = setTimeout(() => {
        cleanup();
        resolve(document.visibilityState === 'visible');
      }, timeoutMs);
      document.addEventListener('visibilitychange', check);
    });
  }

  (async () => {
    if (!requestId || !Number.isFinite(tabId) || tabId <= 0) {
      finish('复制参数无效', false, 2000);
      return;
    }

    // 分批索取全部分块
    const parts = [];
    let from = 0;
    let total = Infinity;
    for (let guard = 0; guard < 1e6; guard++) {
      const resp = await fetchChunks(from);
      if (resp.error) {
        report({ ok: false, error: '读取图片数据失败：' + resp.error });
        finish('读取图片数据失败', false, 2500);
        return;
      }
      parts.push(...resp.chunks);
      total = resp.total;
      from += resp.chunks.length;
      if (!resp.chunks.length || from >= total) break;
    }
    if (from < total) {
      report({ ok: false, error: '图片数据不完整' });
      finish('图片数据不完整', false, 2500);
      return;
    }

    try {
      const visible = await waitUntilVisible(4000);
      if (!visible) {
        report({ ok: false, error: '浏览器窗口不在前台，复制未执行（请点击浏览器窗口后重试）' });
        finish('浏览器窗口不在前台，复制未执行', false, 2500);
        return;
      }
      const blob = base64ToBlob(parts.join(''), 'image/png');
      if (typeof ClipboardItem === 'undefined') throw new Error('当前浏览器不支持剪贴板图片');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      report({ ok: true });
      finish('已复制到剪贴板 ✓', true, 320);
    } catch (err) {
      const message = String((err && err.message) || err);
      report({ ok: false, error: message });
      finish('复制失败：' + message, false, 2500);
    }
  })();
})();
