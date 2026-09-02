/* 全局 Offscreen Document：只重组分块 PNG 并持有 Blob URL。 */
const sessions = new Map();

function send(message) {
  chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

function release(requestId) {
  const session = sessions.get(requestId);
  if (!session) return;
  if (session.blobUrl) URL.revokeObjectURL(session.blobUrl);
  sessions.delete(requestId);
}

function isServiceWorker(sender) {
  return sender && sender.id === chrome.runtime.id
    && sender.url === chrome.runtime.getURL('background.js');
}

chrome.runtime.onMessage.addListener((message, sender) => {
  // 内容脚本同样能够使用 runtime.sendMessage，必须只接受当前扩展的 Service Worker。
  if (!isServiceWorker(sender) || !message || message.target !== 'offscreen') return;

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
      phase: 'receiving',
    });
    return;
  }

  if (message.type === 'DOWNLOAD_CHUNK') {
    const session = sessions.get(message.requestId);
    if (session && session.phase !== 'receiving') return;
    if (!session || message.index !== session.nextIndex) {
      send({ type: 'DOWNLOAD_ERROR', requestId: message.requestId, error: '下载分块顺序无效' });
      return;
    }
    try {
      const binary = atob(message.base64);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      session.chunks.push(bytes);
      session.bytes += bytes.byteLength;
      session.nextIndex += 1;
    } catch (err) {
      send({ type: 'DOWNLOAD_ERROR', requestId: message.requestId, error: '下载分块编码无效' });
      release(message.requestId);
    }
    return;
  }

  if (message.type === 'DOWNLOAD_END') {
    const session = sessions.get(message.requestId);
    // 终态一旦被接受即不可重复处理，避免重复创建 Blob URL。
    if (session && session.phase !== 'receiving') return;
    if (!session || session.bytes !== session.expectedBytes || session.nextIndex !== message.count
      || message.byteLength !== session.expectedBytes) {
      send({ type: 'DOWNLOAD_ERROR', requestId: message.requestId, error: '下载数据长度校验失败' });
      release(message.requestId);
      return;
    }
    session.phase = 'ending';
    const blob = new Blob(session.chunks, { type: session.mime });
    session.blobUrl = URL.createObjectURL(blob);
    send({
      type: 'DOWNLOAD_URL_READY',
      requestId: message.requestId,
      blobUrl: session.blobUrl,
      filename: session.filename,
    });
    return;
  }

  if (message.type === 'DOWNLOAD_RELEASE_URL' || message.type === 'DOWNLOAD_CANCEL') {
    release(message.requestId);
  }
});
