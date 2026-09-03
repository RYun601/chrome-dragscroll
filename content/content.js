/**
 * 滚动截图 · 拖拽即滚 — 内容脚本
 *
 * 核心能力：
 *  1. 当前屏内拖拽框选（调整选区宽高）
 *  2. 拖到视口/滚动容器边缘 → 自动滚动（上下左右四向），选区在文档坐标系中持续增长
 *  3. 容器感知：自动识别光标下真实的可滚动元素（任意嵌套 div），找不到则回退 window 滚动
 *  4. 释放后按「滚动 + 截屏 + 拼接」生成跨屏长图
 *
 * 说明：本脚本兼容「测试模式」（无 chrome API 环境，window.__CAPTURE_TEST__ 为真时自动启动，
 * 截屏步骤被跳过，仅用于在浏览器里验证拖拽/滚动/选区逻辑）。
 */
(() => {
  'use strict';

  if (window.__SCROLLSHOT_INJECTED__) return;
  window.__SCROLLSHOT_INJECTED__ = true;

  // 测试页即使运行在带有 chrome 对象的环境中，也必须显式进入无真实截图模式。
  const IS_TEST = window.__CAPTURE_TEST__ === true || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id;
  const DOWNLOAD_CHUNK_BYTES = 192 * 1024;
  const MAX_OUTPUT_PIXELS = 64_000_000;
  const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
  const CAPTURE_CANCEL = 'CAPTURE_CANCEL';

  const DEFAULTS = {
    edgeMargin: 44,      // 边缘触发距离（px）
    scrollSpeed: 800,    // 滚动速度（px/秒）
    settleDelay: 130,    // 滚动后稳定等待（ms）
    hideFixed: true,     // 截图时隐藏固定/悬浮元素
    filenamePrefix: 'screenshot',
  };

  function boundedNumber(value, min, max, fallback) {
    if (typeof value === 'string' && value.trim() === '') return fallback;
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

  let settings = { ...DEFAULTS };
  let host = null;   // 覆盖层宿主
  let root = null;   // shadow root
  let els = null;    // 覆盖层内部元素引用
  let eventsBound = false;

  // 生命周期事件日志（调试/自动化验证用）
  const events = [];
  window.__scrollshotEvents = events;
  function logEvent(evt) {
    events.push({ t: Date.now(), ...evt });
    if (events.length > 200) events.shift();
  }

  const state = {
    dragging: false,
    resultMode: false,
    scroller: null,     // 当前滚动容器抽象
    vb: null,           // 滚动容器在视口中的 box
    startContent: null, // 按下点（文档坐标）
    curContent: null,   // 当前点（文档坐标）
    lastMouse: null,    // 最近鼠标位置（视口坐标）
    autoScrollDir: { x: 0, y: 0 },
    axis: null,         // 拖拽方向锁定：'v' 纵向长图 / 'h' 横向长图 / null 未锁定
    lastCaptureError: null, // 最近一次 captureVisibleTab 的真实错误（诊断用）
    rafId: 0,
    lastTs: 0,
    lastCanvas: null,   // 最近一次结果 canvas（保存/复制时按需取图）
    thumbUrl: null,     // 结果缩略图 objectURL（teardown 时回收）
    download: null,     // 当前 PNG 下载传输会话
    captureSession: null,
    captureSerial: 0,
    capturing: false,
    dragOriginalScroll: null,
  };

  // ---------- 工具 ----------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function validateOutputBudget(cssW, cssH, scale) {
    const outW = Math.max(1, Math.round(cssW * scale));
    const outH = Math.max(1, Math.round(cssH * scale));
    if (outW > 32000 || outH > 32000) {
      throw new Error('截图尺寸 ' + outW + ' × ' + outH + ' 超出浏览器单边限制 32000px');
    }
    if (outW * outH > MAX_OUTPUT_PIXELS) {
      throw new Error('输出 ' + outW + ' × ' + outH + ' 像素过大，请缩小选区或降低浏览器缩放');
    }
    return { outW, outH };
  }

  if (IS_TEST) window.__scrollshotTestApi = { validateOutputBudget };

  function createCaptureSession(sc, hostAtStart) {
    const id = ++state.captureSerial;
    const origin = state.dragOriginalScroll || { x: sc.scrollLeft, y: sc.scrollTop };
    return {
      id,
      captureId: 'capture-' + id,
      cancelled: false,
      cleaned: false,
      scroller: sc,
      originalScroll: { x: origin.x, y: origin.y },
      hiddenElements: [],
      hostAtStart,
      abortController: new AbortController(),
      instantScroll: false,
      settleRafIds: new Set(),
      settleTimerIds: new Set(),
    };
  }

  function isSessionCurrent(session) {
    return !!session && !session.cancelled && state.captureSession === session && host === session.hostAtStart;
  }

  function clearSettleWork(session) {
    if (!session) return;
    for (const id of session.settleRafIds || []) cancelAnimationFrame(id);
    for (const id of session.settleTimerIds || []) clearTimeout(id);
    if (session.settleRafIds) session.settleRafIds.clear();
    if (session.settleTimerIds) session.settleTimerIds.clear();
  }

  function cleanupCaptureSession(session) {
    if (!session || session.cleaned) return;
    session.cleaned = true;
    clearSettleWork(session);
    if (session.instantScroll) {
      setInstantScroll(session.scroller, false);
      session.instantScroll = false;
    }
    restoreElements(session.hiddenElements);
    session.hiddenElements = [];
    session.scroller.setScroll(session.originalScroll.x, session.originalScroll.y);
    if (state.captureSession === session) {
      state.captureSession = null;
      state.capturing = false;
    }
  }

  function cancelCaptureSession(reason) {
    const session = state.captureSession;
    if (!session || session.cleaned) return;
    session.cancelled = true;
    try { session.abortController.abort(reason); } catch (err) { /* 忽略 */ }
    if (session.captureId && !IS_TEST) sendMessage({ type: CAPTURE_CANCEL, captureId: session.captureId });
    cleanupCaptureSession(session);
  }

  function waitForSession(session, ms) {
    return new Promise((resolve) => {
      if (!isSessionCurrent(session)) { resolve(false); return; }
      let done = false;
      const finish = (current) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        session.abortController.signal.removeEventListener('abort', onAbort);
        resolve(current && isSessionCurrent(session));
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(true), ms);
      session.abortController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function sendMessage(msg) {
    if (IS_TEST) return Promise.resolve({});
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          const error = chrome.runtime.lastError;
          resolve(error ? { error: error.message } : (resp || {}));
        });
      } catch (e) {
        resolve({});
      }
    });
  }

  async function loadSettings() {
    if (IS_TEST) return;
    try {
      const s = await chrome.storage.sync.get(DEFAULTS);
      settings = normalizeSettings({ ...DEFAULTS, ...s });
    } catch (e) {
      settings = normalizeSettings(DEFAULTS);
    }
  }

  // ---------- 滚动容器抽象（window 或任意元素统一接口） ----------
  function makeScroller(el) {
    if (!el) {
      const se = () => document.scrollingElement || document.documentElement;
      return {
        isWindow: true,
        get scrollLeft() { return window.scrollX || se().scrollLeft; },
        get scrollTop() { return window.scrollY || se().scrollTop; },
        setScroll(x, y) { window.scrollTo(x, y); },
        get clientW() { return document.documentElement.clientWidth; },
        get clientH() { return document.documentElement.clientHeight; },
        get maxX() { return Math.max(0, se().scrollWidth - this.clientW); },
        get maxY() { return Math.max(0, se().scrollHeight - this.clientH); },
        get contentW() { return se().scrollWidth; },
        get contentH() { return se().scrollHeight; },
        viewBox() { return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }; },
      };
    }
    return {
      isWindow: false,
      el,
      get scrollLeft() { return el.scrollLeft; },
      get scrollTop() { return el.scrollTop; },
      setScroll(x, y) { el.scrollLeft = x; el.scrollTop = y; },
      get clientW() { return el.clientWidth; },
      get clientH() { return el.clientHeight; },
      get maxX() { return Math.max(0, el.scrollWidth - el.clientWidth); },
      get maxY() { return Math.max(0, el.scrollHeight - el.clientHeight); },
      get contentW() { return el.scrollWidth; },
      get contentH() { return el.scrollHeight; },
      viewBox() {
        const r = el.getBoundingClientRect();
        return { left: r.left + el.clientLeft, top: r.top + el.clientTop, width: el.clientWidth, height: el.clientHeight };
      },
    };
  }

  // 把 DataTables FixedColumns 的左固定列克隆滚动器归一到主 .dataTables_scrollBody。
  // 否则在左侧固定列上拖拽时，扩展会选中 DTFC_LeftBodyLiner（克隆滚动器）：
  // 滚动它不带动主表（纵向不同步），横向又几乎为 0（maxX≈0），导致"拖到最右/最下滚动条不动"。
  function normalizeScroller(el) {
    if (!el) return el;
    const cls = String(el.className || '');
    const isDftcClone = cls.indexOf('DTFC_Left') === 0 || !!(el.closest && el.closest('.DTFC_LeftWrapper'));
    if (!isDftcClone) return el;
    const wrap = (el.closest && el.closest('.DTFC_LeftWrapper')) || (el.closest && el.closest('.dataTables_scroll'));
    const parent = wrap && wrap.parentElement;
    if (parent) {
      const main = parent.querySelector('.dataTables_scrollBody');
      if (main && main !== el) return main;
    }
    return el;
  }

  // 从节点向上找到最近的「可滚动」祖先；找不到返回 null（表示 window 滚动）
  //
  // 兼容两类滚动容器：
  //  1. 原生：overflow 为 auto/scroll/overlay 且有实际溢出；
  //  2. 自定义滚动条库（PerfectScrollbar / slimScroll / OverlayScrollbars 等）：
  //     容器 overflow:hidden，由 JS 接管滚动，scrollTop/scrollLeft 仍可编程设置，
  //     常见于后台模板（如 Color Admin），按可滚动处理。
  // 优先级：优先「纵向可滚动」的容器（拖拽长截图以纵向为主）；仅横向溢出的容器
  // 不阻断向上查找，避免宽表格外层还有纵向容器时误选（maxY=0 滚不动）。
  function findScroller(node) {
    let cur = node && node.nodeType === 1 ? node : null;
    let hOnly = null; // 兜底：最近的「仅横向可滚动」容器
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const cs = getComputedStyle(cur);
      const scrollable = /(auto|scroll|overlay|hidden)/.test(cs.overflowY + cs.overflowX);
      const overY = cur.scrollHeight > cur.clientHeight + 1;
      const overX = cur.scrollWidth > cur.clientWidth + 1;
      if (scrollable && (overY || overX)) {
        if (overY) return normalizeScroller(cur);   // 纵向可滚动 → 立即返回
        if (!hOnly) hOnly = cur; // 仅横向可滚动 → 记录兜底，继续向上找纵向容器
      }
      cur = cur.parentElement;
    }
    return normalizeScroller(hOnly); // 无纵向容器时退回仅横向容器；均无 → null（window 滚动）
  }

  // 取光标下第一个「非覆盖层」的页面元素（覆盖层在 shadow 中，elementsFromPoint 返回宿主，需过滤）
  function elementUnderPoint(x, y) {
    const list = document.elementsFromPoint(x, y);
    for (const el of list) {
      if (el === host) continue;
      if (host && host.contains(el)) continue;
      if (el === document.documentElement || el === document.body) continue;
      return el;
    }
    return null;
  }

  // ---------- 覆盖层 ----------
  function buildOverlay() {
    host = document.createElement('div');
    host.id = '__scrollshot-host__';
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
    root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .ss-layer { position:fixed; inset:0; cursor:crosshair; user-select:none; -webkit-user-select:none;
        touch-action:none; overflow:hidden; background: rgba(15,23,42,.18);
        font-family: "Segoe UI", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
      .ss-selection { position:absolute; border:1.5px solid #4c8dff; background: transparent;
        box-shadow: 0 0 0 9999px rgba(15,23,42,.35), 0 0 14px rgba(76,141,255,.20);
        border-radius:3px; display:none; pointer-events:none; }
      .ss-selection .c { position:absolute; width:9px; height:9px; background:#fff; border:2px solid #4c8dff;
        border-radius:2px; box-shadow:0 1px 4px rgba(15,23,42,.25); }
      .ss-selection .c.tl { left:-6px; top:-6px; }
      .ss-selection .c.tr { right:-6px; top:-6px; }
      .ss-selection .c.bl { left:-6px; bottom:-6px; }
      .ss-selection .c.br { right:-6px; bottom:-6px; }
      .ss-badge { position:fixed; left:14px; top:14px; display:none; flex-direction:column; gap:1px;
        padding:10px 14px 11px; background: rgba(255,255,255,.94); color:#1f2937;
        border:1px solid rgba(15,23,42,.08); border-radius:12px;
        box-shadow:0 10px 30px rgba(15,23,42,.18), 0 2px 6px rgba(15,23,42,.06);
        font-size:12px; line-height:1.4; pointer-events:none;
        backdrop-filter:blur(10px) saturate(1.2); -webkit-backdrop-filter:blur(10px) saturate(1.2); }
      .ss-badge .ss-size { font-weight:700; font-size:16px; letter-spacing:.2px; display:flex; align-items:center; gap:8px;
        font-variant-numeric:tabular-nums; }
      .ss-badge .ss-size::before { content:''; width:9px; height:9px; border-radius:2.5px; flex:none;
        background:linear-gradient(135deg,#4c8dff,#7aa8ff); box-shadow:0 0 0 3px rgba(76,141,255,.16); }
      .ss-badge .ss-hint { color:#6b7280; font-size:11px; padding-left:17px; }
      .ss-size-tip { position:fixed; display:none; padding:4px 9px; background:rgba(17,24,39,.88); color:#fff;
        font-size:11px; font-weight:600; border-radius:7px; pointer-events:none; letter-spacing:.2px;
        box-shadow:0 4px 14px rgba(15,23,42,.32); font-variant-numeric:tabular-nums; white-space:nowrap; }
      .ss-result { position:fixed; right:16px; bottom:16px; width:340px; max-width:calc(100vw - 32px);
        background:#fff; color:#111; border-radius:12px; box-shadow:0 12px 40px rgba(0,0,0,.32);
        padding:14px; font-size:13px; }
      .ss-result .rr-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
      .ss-result .rr-title { font-weight:700; font-size:14px; }
      .ss-result .rr-size { color:#666; font-size:12px; }
      .ss-result .rr-img { width:100%; max-height:220px; object-fit:contain; background:#f4f6fa; border-radius:8px; margin-bottom:10px; }
      .ss-result .rr-actions { display:flex; gap:8px; }
      .ss-result button { flex:1; padding:8px 10px; border:1px solid #d3dae6; background:#fff; color:#222;
        border-radius:8px; cursor:pointer; font-size:13px; }
      .ss-result button:hover { background:#f0f4ff; }
      .ss-result button.primary { background:#3d7bff; border-color:#3d7bff; color:#fff; }
      .ss-result button.primary:hover { background:#2f67e6; }
      .ss-result .rr-msg { margin-top:10px; font-size:12px; color:#16a34a; min-height:16px; }
      .ss-result .rr-msg.err { color:#dc2626; }
      .ss-result .rr-loading { text-align:center; color:#6b7280; padding:20px 0; font-size:13px; }
    `;
    root.appendChild(style);

    const layer = document.createElement('div');
    layer.className = 'ss-layer';
    layer.innerHTML = `
      <div class="ss-selection" id="sel">
        <i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i>
      </div>
      <div class="ss-badge" id="badge">
        <div class="ss-size" id="size">—</div>
        <div class="ss-hint" id="hint"></div>
      </div>
      <div class="ss-size-tip" id="sizetip"></div>
      <div class="ss-result" id="result" style="display:none"></div>`;
    root.appendChild(layer);

    els = {
      layer,
      sel: layer.querySelector('#sel'),
      badge: layer.querySelector('#badge'),
      size: layer.querySelector('#size'),
      hint: layer.querySelector('#hint'),
      sizeTip: layer.querySelector('#sizetip'),
      result: layer.querySelector('#result'),
    };

    bindEvents();
    document.documentElement.appendChild(host);
    logEvent({ ev: 'overlay-built' });
  }

  // ---------- 拖拽引擎 ----------
  function contentX(clientX) { return state.scroller.scrollLeft + (clientX - state.vb.left); }
  function contentY(clientY) { return state.scroller.scrollTop + (clientY - state.vb.top); }

  function onPointerDown(e) {
    if (state.resultMode) return; // 结果面板打开时忽略
    if (state.capturing) return; // 截图会话尚未结束时不接受新的拖拽
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    state.scroller = makeScroller(findScroller(elementUnderPoint(e.clientX, e.clientY)));
    state.dragOriginalScroll = { x: state.scroller.scrollLeft, y: state.scroller.scrollTop };
    state.vb = state.scroller.viewBox();
    state.startContent = { x: contentX(e.clientX), y: contentY(e.clientY) };
    state.curContent = { ...state.startContent };
    state.lastMouse = { x: e.clientX, y: e.clientY };
    state.dragging = true;
    state.resultMode = false;
    state.axis = null; // 每次拖拽重新锁定方向
    els.layer.classList.add('ss-dragging');
    try { els.layer.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }

    els.badge.style.display = 'flex';
    els.size.textContent = '0 × 0';
    els.hint.textContent = '拖到边缘自动滚动 · Esc 取消';
    updateSelection();
    state.lastTs = 0;
    state.rafId = requestAnimationFrame(tick);
  }

  function onPointerMove(e) {
    if (!state.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    state.lastMouse = { x: e.clientX, y: e.clientY };
    state.curContent.x = contentX(e.clientX);
    state.curContent.y = contentY(e.clientY);
    updateAutoScroll();
    updateSelection();
  }

  function onPointerUp(e) {
    if (!state.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    finishDrag(e.pointerId);
  }

  function finishDrag(pointerId) {
    state.dragging = false;
    cancelAnimationFrame(state.rafId);
    els.layer.classList.remove('ss-dragging');
    try { els.layer.releasePointerCapture(pointerId); } catch (err) { /* 忽略 */ }

    const sc = state.scroller;
    const w0 = Math.abs(state.curContent.x - state.startContent.x);
    const h0 = Math.abs(state.curContent.y - state.startContent.y);
    // 无论最终滚动方向如何，选区宽高都由用户手动拖出。
    const tooSmall = w0 < 5 || h0 < 5;
    if (tooSmall) { teardown(); return; } // 视为取消

    // 选区限制在容器内容范围内；自动滚动只延伸用户拖出的滚动方向。
    let rect = {
      x: Math.min(state.startContent.x, state.curContent.x),
      y: Math.min(state.startContent.y, state.curContent.y),
      w: w0,
      h: h0,
    };
    rect.x = Math.max(0, rect.x);
    rect.y = Math.max(0, rect.y);
    rect.w = Math.min(rect.w, Math.max(0, sc.contentW - rect.x));
    rect.h = Math.min(rect.h, Math.max(0, sc.contentH - rect.y));
    if (rect.w < 5 || rect.h < 5) { teardown(); return; }
    logEvent({ ev: 'drag-end', rect });
    const session = createCaptureSession(sc, host);
    state.captureSession = session;
    state.capturing = true;
    runCapture(session, rect);
  }

  // 自动滚动主循环
  function tick(ts) {
    if (!state.dragging) return;
    const dt = state.lastTs ? (ts - state.lastTs) / 1000 : 0.016;
    state.lastTs = ts;
    const sc = state.scroller;
    let dir = state.autoScrollDir;
    // 首次触发自动滚动时锁定方向：只滚一个方向，避免生成 2D 矩形长图。
    // 不按手势提前锁，是为了保留「先横向拖动设定宽度、再纵向滚」的纵向自定义宽度用法。
    if (!state.axis && (dir.x || dir.y)) {
      if (dir.x && dir.y) {
        state.axis = Math.abs(dir.y) >= Math.abs(dir.x) ? 'v' : 'h';
      } else {
        state.axis = dir.y ? 'v' : 'h';
      }
      // 锁定瞬间即显示方向，不必等下一次指针移动
      if (els && els.hint) {
        const pfx = state.axis === 'v' ? '纵向长图 · ' : '横向长图 · ';
        if (els.hint.textContent.indexOf(pfx) !== 0) {
          els.hint.textContent = pfx + els.hint.textContent;
        }
      }
    }
    if (state.axis === 'v') dir = { x: 0, y: dir.y };
    if (state.axis === 'h') dir = { x: dir.x, y: 0 };
    if (dir.x || dir.y) {
      const nx = clamp(sc.scrollLeft + dir.x * dt, 0, sc.maxX);
      const ny = clamp(sc.scrollTop + dir.y * dt, 0, sc.maxY);
      sc.setScroll(nx, ny);
      if (state.lastMouse) {
        state.curContent.x = contentX(state.lastMouse.x);
        state.curContent.y = contentY(state.lastMouse.y);
      }
      updateSelection();
    }
    state.rafId = requestAnimationFrame(tick);
  }

  // 光标在滚动区域边缘内的速度（正=向下/右，负=向上/左）
  function edgeVelocity(pos, size, max) {
    if (max <= 0) return 0;
    const m = settings.edgeMargin;
    if (pos >= size - m) {
      return clamp((pos - (size - m)) / m, 0, 1) * settings.scrollSpeed;
    }
    if (pos <= m) {
      return -clamp((m - pos) / m, 0, 1) * settings.scrollSpeed;
    }
    return 0;
  }

  function updateAutoScroll() {
    const sc = state.scroller;
    if (!sc || !state.lastMouse || !state.vb) {
      state.autoScrollDir = { x: 0, y: 0 };
      return;
    }
    const dx = state.lastMouse.x - state.vb.left;
    const dy = state.lastMouse.y - state.vb.top;
    let vx = edgeVelocity(dx, state.vb.width, sc.maxX);
    let vy = edgeVelocity(dy, state.vb.height, sc.maxY);
    // 锁定方向后只滚单轴：纵向长图禁横向滚，横向长图禁纵向滚
    if (state.axis === 'v') vx = 0;
    if (state.axis === 'h') vy = 0;
    state.autoScrollDir = { x: vx, y: vy };
    const dir = state.autoScrollDir;
    let hint = '';
    if (state.axis === 'v') hint += '纵向长图 · ';
    else if (state.axis === 'h') hint += '横向长图 · ';
    if (dir.y > 0) hint += '↓ 向下滚动中 ';
    else if (dir.y < 0) hint += '↑ 向上滚动中 ';
    if (dir.x > 0) hint += '→ 向右滚动中 ';
    else if (dir.x < 0) hint += '← 向左滚动中 ';
    els.hint.textContent = hint || '拖到边缘自动滚动 · Esc 取消';
  }

  function updateSelection() {
    let x = Math.min(state.startContent.x, state.curContent.x);
    let y = Math.min(state.startContent.y, state.curContent.y);
    let w = Math.abs(state.curContent.x - state.startContent.x);
    let h = Math.abs(state.curContent.y - state.startContent.y);
    const sl = state.scroller.scrollLeft;
    const st = state.scroller.scrollTop;
    const sx = x - sl + state.vb.left;
    const sy = y - st + state.vb.top;
    els.sel.style.display = w < 2 && h < 2 ? 'none' : 'block';
    els.sel.style.left = sx + 'px';
    els.sel.style.top = sy + 'px';
    els.sel.style.width = w + 'px';
    els.sel.style.height = h + 'px';
    const sizeText = Math.round(w) + ' × ' + Math.round(h);
    els.size.textContent = sizeText;
    const show = w >= 2 && h >= 2;
    // 选区出现时去掉整体蒙层，让选区内部保持清晰（外部由选区的 9999px 投影负责压暗）；
    // 未拖选时保留蒙层，提示截图模式已启动。
    els.layer.style.background = show ? 'transparent' : '';
    // 尺寸浮标：跟随选区右下角，超出视口时夹紧
    if (show) {
      els.sizeTip.textContent = sizeText;
      els.sizeTip.style.display = 'block';
      const tw = els.sizeTip.offsetWidth;
      const th = els.sizeTip.offsetHeight;
      let tx = sx + w + 10;
      let ty = sy + h + 10;
      if (tx + tw > window.innerWidth) tx = sx - tw - 10;
      if (ty + th > window.innerHeight) ty = sy - th - 10;
      if (tx < 0) tx = 0;
      if (ty < 0) ty = 0;
      els.sizeTip.style.left = tx + 'px';
      els.sizeTip.style.top = ty + 'px';
    } else {
      els.sizeTip.style.display = 'none';
    }
  }

  // ---------- 截屏拼合 ----------
  async function runCapture(session, rect) {
    if (!isSessionCurrent(session)) return;
    const sc = session.scroller;
    session.hiddenElements = settings.hideFixed ? hideFixedElements(sc, rect) : [];

    // 截图期间：透明化覆盖层暗色蒙层 + 隐藏选区框（含 9999px 投影）与浮标。
    // 否则每块瓦片都会带上暗色蒙层（整体偏色）与选区阴影（行间亮度不一致），
    // 巨型投影还可能导致 captureVisibleTab 返回黑帧。
    if (isSessionCurrent(session) && els) {
      els.layer.style.background = 'transparent';
      els.sel.style.display = 'none';
      els.sizeTip.style.display = 'none';
      // 捕获期间隐藏信息卡：它带 backdrop-filter（某些 Chrome 版本会让 captureVisibleTab
      // 对含 backdrop-filter 的固定元素返回空/报错），且卡片会污染每块瓦片的画面。
      els.badge.style.display = 'none';
      els.layer.style.cursor = 'wait';
    }

    logEvent({ ev: 'capture-start', rect, container: sc.isWindow ? 'window' : sc.el.id || sc.el.tagName });
    try {
      const canvas = await captureRegion(session, rect);
      if (!canvas || !isSessionCurrent(session)) return;
      logEvent({ ev: 'capture-done', w: canvas.width, h: canvas.height });
      // 捕获期间可能被 teardown（Esc / 再点图标），旧会话不可写入新覆盖层。
      if (!isSessionCurrent(session) || !els) return;
      els.layer.style.background = '';
      showResult(session, canvas);
    } catch (err) {
      if (!isSessionCurrent(session)) return;
      console.error('[scrollshot] 截图失败：', err);
      logEvent({ ev: 'capture-error', error: String((err && err.message) || err) });
      if (isSessionCurrent(session) && els) {
        els.layer.style.background = '';
        els.layer.style.cursor = 'default';
        els.badge.style.display = 'none';
        showError(session, String((err && err.message) || err));
      }
    } finally {
      cleanupCaptureSession(session);
    }
  }

  async function captureRegion(session, R) {
    if (!isSessionCurrent(session)) return null;
    const sc = session.scroller;
    if (R.w * R.h > 250_000_000) throw new Error('选区过大，请缩小选区');
    const clientW = sc.clientW;
    const clientH = sc.clientH;
    const vb = sc.viewBox();
    let canvas = null;

    setInstantScroll(sc, true);
    session.instantScroll = true;
    try {
      const cols = [];
      for (let sx = Math.max(0, R.x); sx < R.x + R.w; sx += clientW) cols.push(sx);
      const rows = [];
      for (let sy = Math.max(0, R.y); sy < R.y + R.h; sy += clientH) rows.push(sy);
      const tiles = [];
      for (const sy of rows) for (const sx of cols) tiles.push({ sx, sy });

      const scrollTo = (t) => {
        if (!isSessionCurrent(session)) return false;
        sc.setScroll(Math.min(t.sx, sc.maxX), Math.min(t.sy, sc.maxY));
        return isSessionCurrent(session);
      };

      // 第一块真实瓦片既确定截图像素比，也直接绘制到输出；不再发出仅用于 DPR 的 probe。
      const captureTileData = async (t) => {
        if (!isSessionCurrent(session) || !(await settle(session)) || !isSessionCurrent(session)) return null;
        const dataUrl = await requestCapture(session);
        if (!isSessionCurrent(session)) return null;
        return dataUrl;
      };

      if (!tiles.length || !scrollTo(tiles[0])) return null;
      const firstDataUrl = await captureTileData(tiles[0]);
      if (!isSessionCurrent(session)) return null;
      if (!firstDataUrl && !IS_TEST) throw new Error('首块区域未能捕获，请重试');

      let firstBitmap = null;
      if (firstDataUrl) {
        firstBitmap = await loadBitmap(firstDataUrl);
        if (!isSessionCurrent(session)) {
          if (firstBitmap.close) firstBitmap.close();
          return null;
        }
      }
      const hooks = IS_TEST ? window.__CAPTURE_TEST_HOOKS__ : null;
      const requestedScale = hooks && Number(hooks.captureScale);
      const imgScale = firstBitmap ? firstBitmap.width / Math.max(1, window.innerWidth)
        : (Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : (window.devicePixelRatio || 1));
      const { outW, outH } = validateOutputBudget(R.w, R.h, imgScale);
      canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');

      const drawTile = (t, bmp) => {
        if (!bmp || !isSessionCurrent(session)) return false;
        const cLeft = Math.max(R.x, t.sx);
        const cRight = Math.min(R.x + R.w, t.sx + clientW);
        const cTop = Math.max(R.y, t.sy);
        const cBottom = Math.min(R.y + R.h, t.sy + clientH);
        if (cLeft < cRight && cTop < cBottom) {
          const srcX = (vb.left + (cLeft - sc.scrollLeft)) * imgScale;
          const srcY = (vb.top + (cTop - sc.scrollTop)) * imgScale;
          const srcW = (cRight - cLeft) * imgScale;
          const srcH = (cBottom - cTop) * imgScale;
          ctx.drawImage(bmp, srcX, srcY, srcW, srcH, (cLeft - R.x) * imgScale, (cTop - R.y) * imgScale, srcW, srcH);
        }
        return isSessionCurrent(session);
      };

      if (firstBitmap) {
        const drawn = drawTile(tiles[0], firstBitmap);
        if (firstBitmap.close) firstBitmap.close();
        if (!drawn) return null;
      }
      if (!(await waitForSession(session, 30))) return null;

      // 捕获单个后续瓦片并绘制到 canvas；取消时返回 null。
      const captureTile = async (t, isRetry) => {
        const dataUrl = await captureTileData(t);
        if (!isSessionCurrent(session)) return null;
        if (!dataUrl) return IS_TEST; // 测试模式跳过真实 bitmap
        const bmp = await loadBitmap(dataUrl);
        if (!isSessionCurrent(session)) {
          if (bmp.close) bmp.close();
          return null;
        }
        const drawn = drawTile(t, bmp);
        if (bmp.close) bmp.close();
        if (!drawn) return null;
        // 捕获成功后稍作喘息，降低 captureVisibleTab 连续调用失败率
        if (!isRetry && !(await waitForSession(session, 30))) return null;
        return true;
      };

      // 第 1 遍：尽量捕获全部瓦片；失败的不立即中止，暂存待重试
      const failed = [];
      for (const t of tiles.slice(1)) {
        if (!scrollTo(t)) return null;
        const captured = await captureTile(t, false);
        if (captured === null || !isSessionCurrent(session)) return null;
        if (!captured) failed.push(t);
      }

      // 第 2 遍：对失败瓦片「先滚走再滚回」强制合成器出帧，再重试捕获
      if (failed.length) {
        if (!(await waitForSession(session, 120))) return null;
        for (const t of failed) {
          if (!isSessionCurrent(session)) return null;
          sc.setScroll(Math.min(t.sx, sc.maxX), Math.min(sc.maxY, t.sy + clientH * 2));
          if (!(await settle(session)) || !scrollTo(t)) return null;
          const captured = await captureTile(t, true);
          if (captured === null || !isSessionCurrent(session)) return null;
          if (!captured) {
            const why = state.lastCaptureError ? `（浏览器返回：${state.lastCaptureError}）` : '';
            throw new Error(`截图过程中有 ${failed.length} 块区域未能捕获${why}，请重试或调大「滚动稳定等待」`);
          }
        }
      }
    } finally {
      if (session.instantScroll && !session.cleaned) {
        setInstantScroll(sc, false);
        session.instantScroll = false;
      }
    }
    return isSessionCurrent(session) ? canvas : null;
  }

  function settle(session) {
    return new Promise((resolve) => {
      if (!isSessionCurrent(session)) { resolve(false); return; }
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          clearSettleWork(session);
          session.abortController.signal.removeEventListener('abort', onAbort);
          resolve(isSessionCurrent(session));
        }
      };
      const onAbort = () => finish();
      // rAF 在标签页后台/不可见时会被节流甚至暂停，加超时兜底避免截图卡死
      const timer = setTimeout(finish, Math.max(50, settings.settleDelay * 6));
      session.settleTimerIds.add(timer);
      const raf1 = requestAnimationFrame(() => {
        session.settleRafIds.delete(raf1);
        if (!isSessionCurrent(session)) { finish(); return; }
        const raf2 = requestAnimationFrame(() => {
          session.settleRafIds.delete(raf2);
          if (!isSessionCurrent(session)) { finish(); return; }
          const timer2 = setTimeout(() => {
            session.settleTimerIds.delete(timer2);
            finish();
          }, settings.settleDelay);
          session.settleTimerIds.add(timer2);
        });
        session.settleRafIds.add(raf2);
      });
      session.settleRafIds.add(raf1);
      session.abortController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function requestCapture(session) {
    if (!isSessionCurrent(session)) return null;
    if (IS_TEST) {
      const hooks = window.__CAPTURE_TEST_HOOKS__;
      // 测试页可声明 DPR，供首瓦片后的输出预算路径使用；绝不访问 Chrome API。
      if (hooks && Number.isFinite(Number(hooks.captureScale))) {
        hooks.captureCount = Number(hooks.captureCount || 0) + 1;
      }
      if (!hooks || typeof hooks.requestCapture !== 'function') return null;
      const dataUrl = await hooks.requestCapture();
      return isSessionCurrent(session) ? dataUrl : null;
    }
    // captureVisibleTab 偶发失败/返回空（连续快速调用、合成器忙碌、含 backdrop-filter 等），
    // 指数退避重试；仍失败时记录真实错误便于诊断
    const delays = [150, 250, 400, 650, 1000];
    for (const d of delays) {
      const resp = await sendMessage({ type: 'CAPTURE_VISIBLE', captureId: session.captureId });
      if (!isSessionCurrent(session)) return null;
      if (resp && resp.dataUrl) return resp.dataUrl;
      const err = resp && resp.error ? resp.error : null;
      state.lastCaptureError = err;
      // 切换标签或窗口失焦后，captureVisibleTab 的结果不再可信；立即结束本次会话，
      // 不能继续滚动后续瓦片，更不能把结果写入可能已重新打开的覆盖层。
      if (err && /(focused window|focus|not active|inactive|不再激活|未激活)/i.test(err)) {
        if (isSessionCurrent(session)) showError(session, '截图已取消：原截图标签或窗口已不再激活');
        cancelCaptureSession('capture-target-inactive');
        return null;
      }
      if (!(await waitForSession(session, d))) return null;
    }
    return null;
  }

  async function loadBitmap(dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    return await createImageBitmap(blob);
  }

  function setInstantScroll(sc, on) {
    const el = sc.isWindow ? (document.scrollingElement || document.documentElement) : sc.el;
    if (on) {
      el.dataset.__ssScrollBehavior = el.style.scrollBehavior || '';
      el.style.scrollBehavior = 'auto';
    } else {
      el.style.scrollBehavior = el.dataset.__ssScrollBehavior || '';
      delete el.dataset.__ssScrollBehavior;
    }
  }

  // 找元素最近的「滚动容器」祖先（overflow 为 auto/scroll/overlay/hidden）
  function nearestScrollContainer(el) {
    let cur = el && el.parentElement ? el.parentElement : null;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const cs = getComputedStyle(cur);
      if (/(auto|scroll|overlay|hidden)/.test(cs.overflowY + cs.overflowX)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  // 隐藏与容器视框重叠、会在长图里重复出现的 fixed/sticky 元素。
  // 注意：sticky 但粘在「内部容器」上的元素属于页面内容、随内容一起滚动
  // （如宽表格的固定「操作」列 .col-actions），不应隐藏，否则会误删表格列，
  // 造成截图与页面不一致。只有当 sticky 元素相对「被捕获的容器」粘住时才隐藏。
  function hideFixedElements(sc, R) {
    const out = [];
    const vb = sc.viewBox();
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (sc.el && el === sc.el) continue;
      if (host && (el === host || host.contains(el))) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 && r.height < 2) continue;
      if (r.bottom < vb.top || r.top > vb.bottom || r.right < vb.left || r.left > vb.right) continue;
      if (cs.position === 'sticky') {
        const ns = nearestScrollContainer(el);
        const sticksToSc = sc.isWindow
          ? ns == null || ns === document.body || ns === document.documentElement
          : ns === sc.el;
        if (!sticksToSc) continue; // 内部内容（如表格固定列），不隐藏
      }
      out.push({ el, vis: el.style.visibility });
      el.style.visibility = 'hidden';
    }
    return out;
  }

  function restoreElements(list) {
    for (const it of list) it.el.style.visibility = it.vis;
  }

  // ---------- 结果面板 ----------
  function showResult(session, canvas) {
    if (!isSessionCurrent(session) || !els) return;
    state.resultMode = true;
    els.sel.style.display = 'none';
    els.sizeTip.style.display = 'none';
    els.badge.style.display = 'none';
    els.layer.style.cursor = 'default';

    // 不提前生成整图 dataURL（避免超大 base64 字符串长期占内存），保存/复制时按需取图
    state.lastCanvas = canvas;
    const outW = canvas.width;
    const outH = canvas.height;

    // 剪贴板图片仅在安全上下文（HTTPS/localhost）可用；HTTP 页面不支持时隐藏「复制」按钮
    const canCopy = typeof ClipboardItem !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.write === 'function';

    els.result.style.display = 'block';
    els.result.innerHTML = `
      <div class="rr-head">
        <span class="rr-title">截图完成</span>
        <span class="rr-size">${outW} × ${outH} px</span>
      </div>
      <img class="rr-img" id="rr-img" alt="预览" />
      <div class="rr-actions">
        <button class="primary" data-act="save">保存 PNG</button>
        ${canCopy ? '<button data-act="copy">复制</button>' : ''}
        <button data-act="close">关闭</button>
      </div>
      <div class="rr-msg" id="rr-msg"></div>`;

    // 缩略图用 Blob 直存 + objectURL（小图），避免大图 dataURL 塞进 DOM / 常驻内存
    const imgEl = els.result.querySelector('#rr-img');
    (async () => {
      try {
        let tc = canvas;
        if (canvas.width > 460) {
          tc = document.createElement('canvas');
          const th = Math.max(1, Math.round(canvas.height * (460 / canvas.width)));
          tc.width = 460;
          tc.height = th;
          tc.getContext('2d').drawImage(canvas, 0, 0, 460, th);
        }
        const blob = await new Promise((res) => tc.toBlob(res, 'image/png'));
        // 缩略图编码不能把旧会话的异步结果写入重新打开的覆盖层。
        if (host !== session.hostAtStart || !els || !els.result.contains(imgEl)) return;
        const url = URL.createObjectURL(blob);
        if (host !== session.hostAtStart || !els || !els.result.contains(imgEl)) {
          URL.revokeObjectURL(url);
          return;
        }
        if (state.thumbUrl) URL.revokeObjectURL(state.thumbUrl);
        state.thumbUrl = url;
        imgEl.src = url;
      } catch (e) { /* 预览失败忽略 */ }
    })();

    const msgEl = els.result.querySelector('#rr-msg');
    els.result.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'save') savePng(state.lastCanvas, outW, outH, msgEl);
        else if (act === 'copy') copyPng(state.lastCanvas, msgEl);
        else if (act === 'close') teardown();
      });
    });
    // 不自动保存/复制：由用户在结果面板手动选择，避免截图后立即弹出保存对话框
  }

  function showError(session, msg) {
    if (!isSessionCurrent(session) || !els) return;
    state.resultMode = true;
    els.sel.style.display = 'none';
    els.layer.style.cursor = 'default';
    els.result.style.display = 'block';
    els.result.innerHTML = `
      <div class="rr-head"><span class="rr-title">截图失败</span></div>
      <div class="rr-msg err">${String(msg).replace(/</g, '&lt;')}</div>
      <div class="rr-actions"><button data-act="close">关闭</button></div>`;
    els.result.querySelector('[data-act="close"]').addEventListener('click', () => teardown());
  }

  function createRequestId() {
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'download-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  function encodeChunk(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function updateDownloadStatus(message, requestId, msgEl) {
    if (!message || message.requestId !== requestId || !state.download
      || state.download.requestId !== requestId) return;
    if (message.type === 'DOWNLOAD_STARTED') {
      state.download.downloadCreated = true;
      if (msgEl && !state.download.silent) {
        msgEl.textContent = '浏览器正在保存…';
        msgEl.className = 'rr-msg';
      }
      return;
    }
    if (message.type === 'DOWNLOAD_COMPLETE') {
      if (msgEl && !state.download.silent) {
        msgEl.textContent = '已保存 ✓';
        msgEl.className = 'rr-msg';
      }
      const port = state.download.port;
      state.download = null;
      try { port.disconnect(); } catch (err) { /* 忽略 */ }
      return;
    }
    if (message.type === 'DOWNLOAD_ERROR') {
      if (msgEl && !state.download.silent) {
        msgEl.textContent = '保存失败：' + (message.error || '未知错误');
        msgEl.className = 'rr-msg err';
      }
      const port = state.download.port;
      state.download = null;
      try { port.disconnect(); } catch (err) { /* 忽略 */ }
    }
  }

  async function sendBlobInChunks(blob, filename, onStatus, silent) {
    const requestId = createRequestId();
    const port = chrome.runtime.connect({ name: 'scrollshot-download' });
    const transfer = { requestId, port, downloadCreated: false, silent: !!silent };
    port.onMessage.addListener((message) => onStatus(message, requestId));
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      // 理论上下载只会在捕获完成后开始；仍将异常断开视为会话取消，防止未来
      // 流程调整后遗留正在运行的截图。
      if (state.captureSession) cancelCaptureSession('download-port-disconnect');
      if (state.download && state.download.requestId === requestId && !state.download.downloadCreated) {
        onStatus({ type: 'DOWNLOAD_ERROR', requestId, error: error ? error.message : '下载连接已断开' }, requestId);
      }
    });

    state.download = transfer;
    port.postMessage({ type: 'DOWNLOAD_BEGIN', requestId, filename, mime: 'image/png', byteLength: blob.size });
    let index = 0;
    for (let offset = 0; offset < blob.size; offset += DOWNLOAD_CHUNK_BYTES) {
      if (!state.download || state.download.requestId !== requestId) return transfer;
      const bytes = new Uint8Array(await blob.slice(offset, offset + DOWNLOAD_CHUNK_BYTES).arrayBuffer());
      if (!state.download || state.download.requestId !== requestId) return transfer;
      port.postMessage({ type: 'DOWNLOAD_CHUNK', requestId, index, base64: encodeChunk(bytes) });
      index += 1;
    }
    if (state.download && state.download.requestId === requestId) {
      port.postMessage({ type: 'DOWNLOAD_END', requestId, count: index, byteLength: blob.size });
    }
    return transfer;
  }

  async function savePng(canvas, w, h, msgEl, silent) {
    const filename = settings.filenamePrefix + '-' + w + 'x' + h + '.png';
    if (msgEl && !silent) {
      msgEl.textContent = '正在准备保存…';
      msgEl.className = 'rr-msg';
    }
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('PNG 编码失败');
    if (blob.size > MAX_OUTPUT_BYTES) {
      if (msgEl && !silent) {
        msgEl.textContent = '图片文件过大，请缩小选区后重试';
        msgEl.className = 'rr-msg err';
      }
      return;
    }
    if (IS_TEST) {
      if (msgEl && !silent) msgEl.textContent = '测试模式：未真正保存';
      return;
    }
    try {
      await sendBlobInChunks(blob, filename, (message, requestId) => {
        updateDownloadStatus(message, requestId, msgEl);
      }, silent);
    } catch (err) {
      if (msgEl && !silent) {
        msgEl.textContent = '保存失败：' + (err.message || err);
        msgEl.className = 'rr-msg err';
      }
    }
  }

  async function copyPng(canvas, msgEl, silent) {
    try {
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      if (typeof ClipboardItem === 'undefined') throw new Error('当前浏览器不支持剪贴板图片');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      if (msgEl && !silent) {
        msgEl.textContent = '已复制到剪贴板 ✓';
        msgEl.className = 'rr-msg';
      }
    } catch (err) {
      if (msgEl && !silent) {
        msgEl.textContent = '复制失败：' + (err.message || err);
        msgEl.className = 'rr-msg err';
      }
    }
  }

  // ---------- 生命周期 ----------
  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;
    els.layer.addEventListener('pointerdown', onPointerDown);
    els.layer.addEventListener('pointermove', onPointerMove);
    els.layer.addEventListener('pointerup', onPointerUp);
    els.layer.addEventListener('pointercancel', (e) => {
      if (state.dragging) teardown();
    });
    els.layer.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    els.layer.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pagehide', onPageHide);
  }

  function unbindEvents() {
    if (!eventsBound) return;
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('pagehide', onPageHide);
    eventsBound = false;
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && host) teardown();
  }

  function onPageHide() {
    // 导航、刷新、frame 卸载以及 bfcache 冻结前都必须终止当前会话。
    // teardown 会先发送 CAPTURE_CANCEL（非测试模式）并恢复滚动、隐藏元素和定时资源。
    if (host || state.captureSession) teardown();
  }

  async function start() {
    if (host) { teardown(); return; } // 再点一次 = 退出
    await loadSettings();
    logEvent({ ev: 'start' });
    buildOverlay();
  }

  function teardown() {
    logEvent({ ev: 'teardown' });
    cancelCaptureSession('teardown');
    unbindEvents();
    if (state.download) {
      const transfer = state.download;
      if (!transfer.downloadCreated) {
        try { transfer.port.postMessage({ type: 'DOWNLOAD_CANCEL', requestId: transfer.requestId }); } catch (err) { /* 忽略 */ }
      }
      try { transfer.port.disconnect(); } catch (err) { /* 忽略 */ }
      state.download = null;
    }
    if (state.rafId) cancelAnimationFrame(state.rafId);
    if (state.thumbUrl) { URL.revokeObjectURL(state.thumbUrl); state.thumbUrl = null; }
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    root = null;
    els = null;
    Object.assign(state, {
      dragging: false, resultMode: false, scroller: null, vb: null,
      startContent: null, curContent: null, lastMouse: null,
      autoScrollDir: { x: 0, y: 0 }, rafId: 0, lastTs: 0,
      lastCanvas: null, thumbUrl: null, download: null, capturing: false,
      captureSession: null, dragOriginalScroll: null,
    });
  }

  // 调试钩子（测试/自动化用）
  window.__scrollshotStart = () => start();
  window.__scrollshotStop = () => teardown();
  window.__scrollshotDebug = () => {
    const sc = state.scroller;
    if (!host) return null;
    return {
      active: true,
      dragging: state.dragging,
      resultMode: state.resultMode,
      axis: state.axis,
      hint: els.hint ? els.hint.textContent : '',
      container: sc ? (sc.isWindow ? 'window' : sc.el.tagName + '.' + String(sc.el.className).split(' ')[0]) : null,
      scrollLeft: sc ? Math.round(sc.scrollLeft) : 0,
      scrollTop: sc ? Math.round(sc.scrollTop) : 0,
      maxX: sc ? Math.round(sc.maxX) : 0,
      maxY: sc ? Math.round(sc.maxY) : 0,
      selW: state.startContent ? Math.round(Math.abs(state.curContent.x - state.startContent.x)) : 0,
      selH: state.startContent ? Math.round(Math.abs(state.curContent.y - state.startContent.y)) : 0,
    };
  };

  // ---------- 启动 ----------
  if (IS_TEST) {
    const boot = () => start();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  } else {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && (msg.type === 'DOWNLOAD_STARTED' || msg.type === 'DOWNLOAD_COMPLETE' || msg.type === 'DOWNLOAD_ERROR')) {
        if (state.download) updateDownloadStatus(msg, state.download.requestId, els && els.result && els.result.querySelector('#rr-msg'));
        return false;
      }
      if (msg && msg.type === 'START') {
        start().then(() => sendResponse({ ok: true }));
        return true;
      }
    });
  }
})();
