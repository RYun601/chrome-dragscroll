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
