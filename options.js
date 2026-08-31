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

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  const v = { ...DEFAULTS, ...s };
  $('edgeMargin').value = v.edgeMargin;
  $('scrollSpeed').value = v.scrollSpeed;
  $('settleDelay').value = v.settleDelay;
  $('hideFixed').checked = !!v.hideFixed;
  $('filenamePrefix').value = v.filenamePrefix;
}

async function save() {
  const v = {
    edgeMargin: parseInt($('edgeMargin').value, 10) || DEFAULTS.edgeMargin,
    scrollSpeed: parseInt($('scrollSpeed').value, 10) || DEFAULTS.scrollSpeed,
    settleDelay: parseInt($('settleDelay').value, 10) || DEFAULTS.settleDelay,
    hideFixed: $('hideFixed').checked,
    filenamePrefix: ($('filenamePrefix').value.trim() || DEFAULTS.filenamePrefix),
  };
  await chrome.storage.sync.set(v);
  const st = $('status');
  st.textContent = '已保存 ✓';
  setTimeout(() => (st.textContent = ''), 1600);
}

document.addEventListener('DOMContentLoaded', load);
$('save').addEventListener('click', save);
