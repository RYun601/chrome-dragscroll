import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
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

function loadBackgroundForDownloadTest() {
  const sentMessages = [];
  const downloadCalls = [];
  const noopEvent = { addListener() {} };
  const chrome = {
    runtime: {
      getURL: (file) => 'chrome-extension://test/' + file,
      sendMessage: (message) => sentMessages.push(message),
      onConnect: noopEvent,
      onMessage: noopEvent,
    },
    offscreen: { createDocument: async () => {} },
    downloads: {
      download: (options, callback) => {
        downloadCalls.push(options);
        callback(downloadCalls.length);
      },
      search: (_query, callback) => callback([{ state: 'in_progress' }]),
      onChanged: noopEvent,
    },
    storage: {
      session: {
        set: (_items, callback) => callback(),
        get: (_key, callback) => callback({}),
        remove: (_key, callback) => callback(),
      },
    },
    tabs: {
      sendMessage: () => {},
      onRemoved: noopEvent,
      onUpdated: noopEvent,
      query: () => {},
      captureVisibleTab: () => {},
    },
    action: { onClicked: noopEvent },
    commands: { onCommand: noopEvent },
    scripting: { executeScript: async () => {} },
  };
  const context = { chrome, console, Promise, setTimeout };
  vm.runInNewContext(
    read('background.js') + '\n;globalThis.__downloadTestApi = { endDownload, startChromeDownload, downloadSessions };',
    context,
    { filename: 'background.js' },
  );
  return { api: context.__downloadTestApi, sentMessages, downloadCalls };
}

test('one completed request forwards one end and creates one Chrome download', () => {
  const { api, sentMessages, downloadCalls } = loadBackgroundForDownloadTest();
  const port = { postMessage() {} };
  const session = {
    requestId: 'request-1',
    port,
    expectedBytes: 4,
    bytes: 4,
    nextIndex: 1,
    filename: 'capture.png',
    tabId: 1,
    frameId: 0,
    downloadId: null,
    createdAt: 0,
    phase: 'receiving',
    downloadStarting: false,
    offscreenReady: true,
    pendingMessages: [],
  };
  api.downloadSessions.set(session.requestId, session);

  const end = { requestId: session.requestId, count: 1, byteLength: 4 };
  api.endDownload(end, port);
  api.endDownload(end, port);
  assert.equal(sentMessages.filter((message) => message.type === 'DOWNLOAD_END').length, 1);

  api.startChromeDownload(session, 'blob:first');
  api.startChromeDownload(session, 'blob:duplicate');
  assert.equal(downloadCalls.length, 1);
});

test('README documents the offscreen-only Blob URL permission', () => {
  const readme = read('README.md');
  assert.match(readme, /offscreen/);
  assert.match(readme, /本地隐藏文档/);
  assert.match(readme, /Blob URL/);
  assert.match(readme, /无 `?<all_urls>`?、无网络请求、无数据收集/);
});
