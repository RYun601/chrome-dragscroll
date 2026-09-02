/**
 * 滚动截图 · 设置页逻辑
 */
const DEFAULTS = {
  edgeMargin: 44,
  scrollSpeed: 800,
  settleDelay: 130,
  hideFixed: true,
  filenamePrefix: 'screenshot',
};

const $ = (id) => document.getElementById(id);

function boundedNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function normalizeSettings(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    edgeMargin: boundedNumber(value.edgeMargin, 8, 200, DEFAULTS.edgeMargin),
    scrollSpeed: boundedNumber(value.scrollSpeed, 100, 5000, DEFAULTS.scrollSpeed),
    settleDelay: boundedNumber(value.settleDelay, 0, 2000, DEFAULTS.settleDelay),
    hideFixed: value.hideFixed === true,
    filenamePrefix: String(value.filenamePrefix || DEFAULTS.filenamePrefix)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || DEFAULTS.filenamePrefix,
  };
}

function applySettings(value) {
  $('edgeMargin').value = value.edgeMargin;
  $('scrollSpeed').value = value.scrollSpeed;
  $('settleDelay').value = value.settleDelay;
  $('hideFixed').checked = value.hideFixed;
  $('filenamePrefix').value = value.filenamePrefix;
}

function setStatus(message) {
  $('status').textContent = message;
}

async function load() {
  try {
    const s = await chrome.storage.sync.get(DEFAULTS);
    applySettings(normalizeSettings({ ...DEFAULTS, ...s }));
  } catch (err) {
    applySettings(normalizeSettings(DEFAULTS));
    setStatus('读取设置失败：' + (err.message || err));
  }
}

async function save() {
  const v = normalizeSettings({
    edgeMargin: $('edgeMargin').value,
    scrollSpeed: $('scrollSpeed').value,
    settleDelay: $('settleDelay').value,
    hideFixed: $('hideFixed').checked,
    filenamePrefix: $('filenamePrefix').value,
  });
  applySettings(v);
  try {
    await chrome.storage.sync.set(v);
    setStatus('已保存 ✓');
    setTimeout(() => setStatus(''), 1600);
  } catch (err) {
    setStatus('保存失败：' + (err.message || err));
  }
}

document.addEventListener('DOMContentLoaded', load);
$('save').addEventListener('click', save);
