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

test('README documents the implemented capture reliability facts', () => {
  const readme = read('README.md');
  assert.match(readme, /offscreen/);
  assert.match(readme, /本地隐藏文档/);
  assert.match(readme, /Chrome\s*109\+/);
  assert.match(readme, /structured clone/);
  assert.match(readme, /32000px/);
  assert.match(readme, /6400\s*万像素|64[,，]?\s*000[,，]?\s*000/);
  assert.match(readme, /128\s*MiB/);
  assert.match(readme, /保存状态/);
  assert.match(readme, /切换标签.*取消|标签.*取消/);
  assert.match(readme, /Esc.*恢复|恢复.*滚动位置/);
  assert.match(readme, /测试模式.*真实截屏|跳过真实截屏/);
  assert.doesNotMatch(readme, /2\.5\s*亿像素|250\s*000\s*000/);
});

test('options page labels every form control and exposes a main landmark', () => {
  const html = read('options.html');
  for (const id of ['edgeMargin', 'scrollSpeed', 'settleDelay', 'hideFixed', 'filenamePrefix']) {
    assert.match(html, new RegExp('for=["' + String.fromCharCode(39) + ']' + id + '["' + String.fromCharCode(39) + ']'));
  }
  assert.match(html, /<main>/);
  assert.match(html, /aria-live=["']polite["']/);
});

test('options and content settings are normalized', () => {
  assert.match(read('options.js'), /normalizeSettings/);
  assert.match(read('options.js'), /Math\.min/);
  assert.match(read(path.join('content', 'content.js')), /normalizeSettings/);
  assert.match(read(path.join('content', 'content.js')), /Math\.min/);
});

test('content script removes the document keydown listener', () => {
  assert.match(read(path.join('content', 'content.js')), /removeEventListener\(['"]keydown/);
});

function loadOptionsSettingsApi() {
  const element = { addEventListener() {} };
  const context = {
    chrome: { storage: { sync: {} } },
    document: {
      addEventListener() {},
      getElementById() { return element; },
    },
  };
  vm.runInNewContext(
    read('options.js') + '\n;globalThis.__settingsTestApi = { boundedNumber, normalizeSettings };',
    context,
    { filename: 'options.js' },
  );
  return context.__settingsTestApi;
}

function loadContentSettingsApi() {
  const context = {
    window: { __CAPTURE_TEST__: true },
    document: { readyState: 'loading', addEventListener() {} },
  };
  const script = read(path.join('content', 'content.js')).replace(
    /\}\)\(\);\s*$/,
    'window.__settingsTestApi = { boundedNumber, normalizeSettings };\n})();',
  );
  vm.runInNewContext(script, context, { filename: 'content/content.js' });
  return context.window.__settingsTestApi;
}

test('blank numeric settings fall back to defaults in both contexts', () => {
  for (const api of [loadOptionsSettingsApi(), loadContentSettingsApi()]) {
    const value = api.normalizeSettings({
      edgeMargin: '   ',
      scrollSpeed: '',
      settleDelay: '\t',
      filenamePrefix: 'report',
    });
    assert.equal(value.edgeMargin, 44);
    assert.equal(value.scrollSpeed, 800);
    assert.equal(value.settleDelay, 130);
    assert.equal(value.filenamePrefix, 'report');
  }
});

test('options status color has AA contrast on its white background', () => {
  const html = read('options.html');
  const match = html.match(/#status\s*\{[^}]*color:\s*(#[0-9a-f]{6})/i);
  assert.ok(match, '状态区域必须声明六位十六进制文字颜色');
  const channels = [1, 3, 5].map((index) => parseInt(match[1].slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  const contrast = 1.05 / (luminance + 0.05);
  assert.ok(contrast >= 4.5, '状态文字对比度必须至少为 4.5:1，实际为 ' + contrast.toFixed(2) + ':1');
});
