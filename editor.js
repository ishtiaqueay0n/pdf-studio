'use strict';
/* global pdfjsLib, PDFLib, chrome */

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('libs/pdf.worker.min.js');
const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } = PDFLib;

/* ============================== helpers ============================== */

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}

function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const v = m ? parseInt(m[1], 16) : 0;
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

function normRot(a) {
  return ((Math.round(a / 90) * 90) % 360 + 360) % 360;
}

function suffixName(name, suf) {
  if (!suf) return name;
  return /\.pdf$/i.test(name)
    ? name.replace(/\.pdf$/i, suf + '.pdf')
    : name + suf + '.pdf';
}

function downloadBytes(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

/* ============================== elements ============================== */

const viewerEl = $('#viewer');
const pagesEl = $('#pages');
const emptyState = $('#empty-state');
const bannerEl = $('#banner');
const metaEl = $('#meta');
const hintEl = $('#hint');
const zoomLabel = $('#zoom-label');

const toolBtns = $$('.tool[data-tool]');
const btnSignature = $('#btn-signature');
const btnImage = $('#btn-image');
const btnDownload = $('#btn-download');
const btnResize = $('#btn-resize');
const btnOpenTop = $('#btn-open-top');
const btnOpenFile = $('#btn-open-file');

const ctxText = $('#ctx-text');
const ctxPen = $('#ctx-pen');
const textSizeInput = $('#text-size');
const textColorInput = $('#text-color');
const penSizeInput = $('#pen-size');
const penColorInput = $('#pen-color');
const btnUndoStroke = $('#btn-undo-stroke');
const btnDeleteObj = $('#btn-delete-obj');

const pdfInput = $('#pdf-input');
const imageInput = $('#image-input');
const sigFileInput = $('#sig-file-input');

const sigModal = $('#sig-modal');
const sigPadCanvas = $('#sig-pad');
const sigPreview = $('#sig-preview');
const sigPenColor = $('#sig-pen-color');
const sigPenSize = $('#sig-pen-size');
const sigClear = $('#sig-clear');
const sigUploadBtn = $('#sig-upload-btn');
const sigThreshold = $('#sig-threshold');
const sigInk = $('#sig-ink');
const sigBoost = $('#sig-boost');
const sigUse = $('#sig-use');
const sigUseLast = $('#sig-use-last');

const resizeModal = $('#resize-modal');
const pagePreset = $('#page-preset');
const pageScaleWrap = $('#page-scale-wrap');
const pageScaleInput = $('#page-scale');
const btnPageRun = $('#btn-page-run');
const cmpLossless = $('#cmp-lossless');
const cmpLossy = $('#cmp-lossy');
const cmpPreset = $('#cmp-preset');
const cmpCustom = $('#cmp-custom');
const cmpDpi = $('#cmp-dpi');
const cmpDpiV = $('#cmp-dpi-v');
const cmpQuality = $('#cmp-quality');
const cmpQualityV = $('#cmp-quality-v');
const btnCmpRun = $('#btn-cmp-run');
const cmpProgress = $('#cmp-progress');
const cmpBar = $('#cmp-bar');
const cmpText = $('#cmp-text');
const resultRow = $('#result-row');
const resultText = $('#result-text');
const btnResultLoad = $('#btn-result-load');
const btnResultDownload = $('#btn-result-download');

/* ============================== state ============================== */

const state = {
  bytes: null,
  name: 'document.pdf',
  doc: null,
  pages: [],          // { index, page, viewport1, wrap, canvas, ink, overlay, renderedScale, renderTask, visible }
  io: null,
  fitScale: 1,
  zoom: 1,
  tool: 'select',
  objects: [],        // { id, type, pageIndex, x, y, w, h, ... } in base units (viewport scale = 1)
  undoStack: [],
  selection: null,
  place: null,        // { kind: 'image'|'sig', url, w, h }
  sig: null,          // last signature { url, w, h }
  pen: { size: 3, color: '#16213e' },
  textDefaults: { size: 16, color: '#111318' }
};
let uid = 1;

const curScale = () => state.fitScale * state.zoom;

/* ============================== status ui ============================== */

function showBanner(msg, type) {
  if (!msg) {
    bannerEl.classList.add('hidden');
    return;
  }
  bannerEl.textContent = msg;
  bannerEl.title = 'Click to dismiss';
  bannerEl.classList.toggle('info', type === 'info');
  bannerEl.classList.remove('hidden');
}
bannerEl.addEventListener('click', () => showBanner(null));

function setMeta(text) {
  metaEl.textContent = text;
}

function needDoc() {
  if (state.doc) return true;
  showBanner('Open a PDF first — drop one anywhere on this page or use "Open PDF".', 'info');
  return false;
}

const TOOL_HINTS = {
  select: '',
  text: 'Click on a page to add a text box',
  draw: 'Draw directly on the page',
  whiteout: 'Drag to cover an area with white',
  place: 'Click on a page to place it'
};

function setTool(t) {
  state.tool = t;
  if (t !== 'place') state.place = null;
  for (const b of toolBtns) b.classList.toggle('active', b.dataset.tool === t);
  pagesEl.classList.remove('tool-select', 'tool-text', 'tool-draw', 'tool-whiteout', 'tool-place');
  pagesEl.classList.add('tool-' + t);
  hintEl.textContent = TOOL_HINTS[t] || '';
  updateCtx();
}

function updateCtx() {
  const sel = state.selection;
  ctxText.classList.toggle('hidden', !(state.tool === 'text' || (sel && sel.type === 'text')));
  ctxPen.classList.toggle('hidden', state.tool !== 'draw');
  btnDeleteObj.classList.toggle('hidden', !sel);
  if (sel && sel.type === 'text') {
    textSizeInput.value = sel.size;
    textColorInput.value = sel.color;
  }
}

/* ============================== loading ============================== */

async function handleNewFile(file) {
  if (!file) return;
  if (state.doc && state.objects.length &&
      !window.confirm('Loading a new PDF will discard your current edits. Continue?')) return;
  try {
    const buf = await file.arrayBuffer();
    await loadBytes(new Uint8Array(buf), file.name || 'document.pdf');
  } catch (err) {
    showBanner('Could not read that file. ' + (err && err.message ? err.message : ''));
  }
}

async function loadFromUrl(u) {
  setMeta('Fetching PDF…');
  try {
    const res = await fetch(u, { credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    let name = 'document.pdf';
    try {
      const last = decodeURIComponent(new URL(u).pathname.split('/').pop() || '');
      if (last) name = /\.pdf$/i.test(last) ? last : last + '.pdf';
    } catch (e) { /* keep default */ }
    await loadBytes(new Uint8Array(buf), name);
  } catch (err) {
    if (/^file:/i.test(u)) {
      showBanner('Chrome blocked access to this local file. Go to chrome://extensions → PDF Studio → Details → enable "Allow access to file URLs", then reload this tab — or simply choose the file below.', 'info');
    } else {
      showBanner('Could not fetch this PDF (' + ((err && err.message) || err) + '). Download it and open the file here instead.');
    }
    setMeta('No document loaded');
  }
}

async function loadBytes(bytes, name) {
  showBanner(null);
  setMeta('Opening…');
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  } catch (err) {
    showBanner('Could not open this file as a PDF. ' + ((err && err.message) || ''));
    setMeta(state.doc ? metaText() : 'No document loaded');
    return;
  }
  if (state.doc) { try { state.doc.destroy(); } catch (e) { /* ignore */ } }
  if (state.io) state.io.disconnect();
  clearSelection();
  state.bytes = bytes;
  state.name = name || 'document.pdf';
  state.doc = doc;
  state.objects = [];
  state.undoStack = [];
  state.place = null;
  state.zoom = 1;
  await buildPages();
  emptyState.classList.add('hidden');
  btnDownload.disabled = false;
  btnResize.disabled = false;
  setMeta(metaText());
  setTool('select');
}

function metaText() {
  const n = state.doc.numPages;
  return state.name + ' · ' + n + (n > 1 ? ' pages' : ' page') + ' · ' + formatBytes(state.bytes.length);
}

async function buildPages() {
  pagesEl.textContent = '';
  state.pages = [];
  const n = state.doc.numPages;
  let maxW = 0;
  for (let i = 1; i <= n; i++) {
    const page = await state.doc.getPage(i);
    const viewport1 = page.getViewport({ scale: 1 });
    maxW = Math.max(maxW, viewport1.width);
    state.pages.push({
      index: i - 1, page, viewport1,
      wrap: null, canvas: null, ink: null, overlay: null,
      renderedScale: null, renderTask: null, visible: false
    });
  }
  updateFitScale(maxW);

  state.io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const idx = Number(en.target.dataset.index);
      const p = state.pages[idx];
      if (!p) continue;
      p.visible = en.isIntersecting;
      if (en.isIntersecting) renderPage(idx);
    }
  }, { root: viewerEl, rootMargin: '600px 0px' });

  for (const p of state.pages) {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.index = p.index;

    const canvas = document.createElement('canvas');
    canvas.className = 'page-canvas';
    const ink = document.createElement('canvas');
    ink.className = 'ink-canvas';
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const num = document.createElement('div');
    num.className = 'page-num';
    num.textContent = 'Page ' + (p.index + 1);

    wrap.appendChild(canvas);
    wrap.appendChild(ink);
    wrap.appendChild(overlay);
    wrap.appendChild(num);
    overlay.addEventListener('pointerdown', (ev) => onOverlayDown(ev, p.index));

    p.wrap = wrap;
    p.canvas = canvas;
    p.ink = ink;
    p.overlay = overlay;
    pagesEl.appendChild(wrap);
    state.io.observe(wrap);
  }
  layoutAll();
}

function updateFitScale(maxW) {
  if (maxW == null) {
    maxW = 0;
    for (const p of state.pages) maxW = Math.max(maxW, p.viewport1.width);
  }
  if (!maxW) return;
  const avail = Math.max(320, viewerEl.clientWidth - 56);
  state.fitScale = clamp(avail / maxW, 0.25, 1.6);
}

function layoutAll() {
  const S = curScale();
  for (const p of state.pages) {
    p.wrap.style.width = (p.viewport1.width * S) + 'px';
    p.wrap.style.height = (p.viewport1.height * S) + 'px';
    p.renderedScale = null;
  }
  for (const p of state.pages) if (p.visible) renderPage(p.index);
  for (const o of state.objects) applyObjectLayout(o);
  zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
}

async function renderPage(idx) {
  const p = state.pages[idx];
  if (!p) return;
  const S = curScale();
  if (p.renderedScale === S) return;
  if (p.renderTask) { try { p.renderTask.cancel(); } catch (e) { /* ignore */ } }

  const vp = p.page.getViewport({ scale: S });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  p.canvas.width = Math.floor(vp.width * dpr);
  p.canvas.height = Math.floor(vp.height * dpr);
  p.canvas.style.width = vp.width + 'px';
  p.canvas.style.height = vp.height + 'px';

  p.ink.width = Math.floor(vp.width * dpr);
  p.ink.height = Math.floor(vp.height * dpr);
  p.ink.style.width = vp.width + 'px';
  p.ink.style.height = vp.height + 'px';
  p.ink.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawInk(idx);

  const ctx = p.canvas.getContext('2d');
  const task = p.page.render({
    canvasContext: ctx,
    viewport: vp,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
  });
  p.renderTask = task;
  try {
    await task.promise;
    p.renderedScale = S;
  } catch (e) { /* render cancelled — a newer render owns the canvas */ }
  if (p.renderTask === task) p.renderTask = null;
}

/* ============================== zoom ============================== */

function setZoom(z) {
  if (!state.doc) return;
  state.zoom = clamp(z, 0.4, 3);
  layoutAll();
}
$('#zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.15));
$('#zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.15));
$('#zoom-fit').addEventListener('click', () => { updateFitScale(); setZoom(1); });

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!state.doc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { updateFitScale(); layoutAll(); }, 200);
});

/* ============================== objects ============================== */

function addObject(o) {
  o.id = uid++;
  state.objects.push(o);
  mountObject(o);
  state.undoStack.push(o.id);
  return o;
}

function mountObject(o) {
  if (o.type === 'ink') { redrawInk(o.pageIndex); return; }
  const p = state.pages[o.pageIndex];
  const el = document.createElement('div');
  el.className = 'obj obj-' + o.type;
  el.dataset.id = o.id;

  if (o.type === 'image' || o.type === 'sig') {
    const img = document.createElement('img');
    img.src = o.url;
    img.draggable = false;
    el.appendChild(img);
  } else if (o.type === 'text') {
    const t = document.createElement('div');
    t.className = 'txt';
    t.textContent = o.text;
    el.appendChild(t);
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); startTextEdit(o); });
  }

  el.addEventListener('pointerdown', (e) => beginDrag(e, o));
  o.el = el;
  p.overlay.appendChild(el);
  applyObjectLayout(o);
}

function applyObjectLayout(o) {
  if (o.type === 'ink' || !o.el) return;
  const S = curScale();
  o.el.style.left = (o.x * S) + 'px';
  o.el.style.top = (o.y * S) + 'px';
  o.el.style.width = (o.w * S) + 'px';
  if (o.type === 'text') {
    const t = o.el.querySelector('.txt');
    t.style.fontSize = (o.size * S) + 'px';
    t.style.color = o.color;
    o.el.style.height = 'auto';
    o.h = Math.max(o.size * 1.25, o.el.offsetHeight / S);
  } else {
    o.el.style.height = (o.h * S) + 'px';
  }
}

function select(o) {
  if (state.selection === o) { updateCtx(); return; }
  clearSelection();
  state.selection = o;
  if (o.el) {
    o.el.classList.add('selected');
    const h = document.createElement('div');
    h.className = 'handle';
    h.addEventListener('pointerdown', (e) => beginResize(e, o));
    o.el.appendChild(h);
  }
  updateCtx();
}

function clearSelection() {
  const o = state.selection;
  if (o && o.el) {
    o.el.classList.remove('selected');
    const h = o.el.querySelector('.handle');
    if (h) h.remove();
  }
  state.selection = null;
  updateCtx();
}

function deleteObject(id) {
  const i = state.objects.findIndex((o) => o.id === id);
  if (i < 0) return;
  const o = state.objects[i];
  state.objects.splice(i, 1);
  state.undoStack = state.undoStack.filter((x) => x !== id);
  if (state.selection === o) state.selection = null;
  if (o.el) o.el.remove();
  if (o.type === 'ink') redrawInk(o.pageIndex);
  updateCtx();
}

function undo() {
  const id = state.undoStack.pop();
  if (id != null) deleteObject(id);
}

function beginDrag(e, o) {
  if (state.tool !== 'select' || e.button !== 0) return;
  if (o.el.classList.contains('editing')) return;
  e.stopPropagation();
  e.preventDefault();
  select(o);
  const S = curScale();
  const p = state.pages[o.pageIndex];
  const sx = e.clientX, sy = e.clientY, ox = o.x, oy = o.y;
  const move = (ev) => {
    o.x = clamp(ox + (ev.clientX - sx) / S, -o.w * 0.5, p.viewport1.width - o.w * 0.5);
    o.y = clamp(oy + (ev.clientY - sy) / S, -o.h * 0.5, p.viewport1.height - o.h * 0.5);
    applyObjectLayout(o);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function beginResize(e, o) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const S = curScale();
  const sx = e.clientX, sy = e.clientY, ow = o.w, oh = o.h;
  const ratio = oh / ow;
  const move = (ev) => {
    const nw = Math.max(10, ow + (ev.clientX - sx) / S);
    if (o.type === 'image' || o.type === 'sig') {
      o.w = nw;
      o.h = nw * ratio;
    } else if (o.type === 'whiteout') {
      o.w = nw;
      o.h = Math.max(6, oh + (ev.clientY - sy) / S);
    } else if (o.type === 'text') {
      o.w = Math.max(40, nw);
    }
    applyObjectLayout(o);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startTextEdit(o) {
  if (!o.el) return;
  select(o);
  const t = o.el.querySelector('.txt');
  o.el.classList.add('editing');
  try { t.contentEditable = 'plaintext-only'; } catch (err) { t.contentEditable = 'true'; }
  t.focus();
  const r = document.createRange();
  r.selectNodeContents(t);
  r.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);

  const onInput = () => {
    o.text = t.innerText;
    applyObjectLayout(o);
  };
  const onBlur = () => {
    t.removeEventListener('input', onInput);
    t.removeEventListener('blur', onBlur);
    t.contentEditable = 'false';
    o.el.classList.remove('editing');
    o.text = t.innerText.replace(/\u00a0/g, ' ').replace(/\n$/, '');
    if (!o.text.trim()) { deleteObject(o.id); return; }
    t.textContent = o.text;
    applyObjectLayout(o);
  };
  t.addEventListener('input', onInput);
  t.addEventListener('blur', onBlur);
}

/* ============================== overlay tools ============================== */

function onOverlayDown(ev, pi) {
  if (ev.button !== 0) return;
  const p = state.pages[pi];
  const S = curScale();
  const rect = p.overlay.getBoundingClientRect();
  const bx = clamp((ev.clientX - rect.left) / S, 0, p.viewport1.width);
  const by = clamp((ev.clientY - rect.top) / S, 0, p.viewport1.height);

  if (state.tool === 'select') { clearSelection(); return; }
  ev.preventDefault();
  if (state.tool === 'text') { createTextAt(pi, bx, by); return; }
  if (state.tool === 'whiteout') { beginRubber(p, pi, bx, by); return; }
  if (state.tool === 'draw') { beginStroke(p, pi, bx, by); return; }
  if (state.tool === 'place' && state.place) { placeAt(pi, bx, by); }
}

function createTextAt(pi, bx, by) {
  const p = state.pages[pi];
  let w = Math.min(240, p.viewport1.width * 0.6);
  let x = bx;
  if (x + w > p.viewport1.width) x = Math.max(0, p.viewport1.width - w);
  const o = addObject({
    type: 'text', pageIndex: pi, x, y: by, w,
    h: state.textDefaults.size * 1.3,
    text: '', size: state.textDefaults.size, color: state.textDefaults.color
  });
  setTool('select');
  select(o);
  startTextEdit(o);
}

function beginRubber(p, pi, sx, sy) {
  const S = curScale();
  const rubber = document.createElement('div');
  rubber.className = 'rubber';
  p.overlay.appendChild(rubber);
  let box = null;
  const move = (e) => {
    const rect = p.overlay.getBoundingClientRect();
    const cx = clamp((e.clientX - rect.left) / S, 0, p.viewport1.width);
    const cy = clamp((e.clientY - rect.top) / S, 0, p.viewport1.height);
    box = {
      x: Math.min(sx, cx), y: Math.min(sy, cy),
      w: Math.abs(cx - sx), h: Math.abs(cy - sy)
    };
    rubber.style.left = (box.x * S) + 'px';
    rubber.style.top = (box.y * S) + 'px';
    rubber.style.width = (box.w * S) + 'px';
    rubber.style.height = (box.h * S) + 'px';
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    rubber.remove();
    if (box && box.w >= 4 && box.h >= 4) {
      addObject({ type: 'whiteout', pageIndex: pi, x: box.x, y: box.y, w: box.w, h: box.h });
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function beginStroke(p, pi, sx, sy) {
  const S = curScale();
  const ictx = p.ink.getContext('2d');
  ictx.strokeStyle = state.pen.color;
  ictx.lineWidth = state.pen.size * S;
  ictx.lineCap = 'round';
  ictx.lineJoin = 'round';
  ictx.beginPath();
  ictx.moveTo(sx * S, sy * S);
  const pts = [{ x: sx, y: sy }];
  let last = { x: sx, y: sy };
  const move = (e) => {
    const rect = p.overlay.getBoundingClientRect();
    const cx = clamp((e.clientX - rect.left) / S, 0, p.viewport1.width);
    const cy = clamp((e.clientY - rect.top) / S, 0, p.viewport1.height);
    const dx = cx - last.x, dy = cy - last.y;
    if (dx * dx + dy * dy < 0.9) return;
    pts.push({ x: cx, y: cy });
    ictx.lineTo(cx * S, cy * S);
    ictx.stroke();
    ictx.beginPath();
    ictx.moveTo(cx * S, cy * S);
    last = { x: cx, y: cy };
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    addObject({ type: 'ink', pageIndex: pi, points: pts, size: state.pen.size, color: state.pen.color });
    redrawInk(pi);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function placeAt(pi, bx, by) {
  const p = state.pages[pi];
  const pl = state.place;
  const maxW = pl.kind === 'sig'
    ? Math.min(190, p.viewport1.width * 0.4)
    : Math.min(pl.w, p.viewport1.width * 0.5);
  const w = Math.max(24, maxW);
  const h = w * (pl.h / pl.w);
  const x = clamp(bx - w / 2, 0, Math.max(0, p.viewport1.width - w));
  const y = clamp(by - h / 2, 0, Math.max(0, p.viewport1.height - h));
  const o = addObject({
    type: pl.kind === 'sig' ? 'sig' : 'image',
    pageIndex: pi, x, y, w, h, url: pl.url
  });
  state.place = null;
  setTool('select');
  select(o);
}

function beginPlace(payload) {
  state.place = payload;
  setTool('place');
  hintEl.textContent = payload.kind === 'sig'
    ? 'Click on a page to place your signature'
    : 'Click on a page to place the image';
}

/* ============================== ink rendering ============================== */

function drawSmoothStroke(ctx, pts, widthPx, color, S) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = widthPx;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x * S, pts[0].y * S, widthPx / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x * S, pts[0].y * S);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = ((pts[i].x + pts[i + 1].x) / 2) * S;
    const my = ((pts[i].y + pts[i + 1].y) / 2) * S;
    ctx.quadraticCurveTo(pts[i].x * S, pts[i].y * S, mx, my);
  }
  ctx.lineTo(pts[pts.length - 1].x * S, pts[pts.length - 1].y * S);
  ctx.stroke();
}

function redrawInk(pi) {
  const p = state.pages[pi];
  if (!p || !p.ink) return;
  const ctx = p.ink.getContext('2d');
  ctx.clearRect(0, 0, p.ink.width, p.ink.height);
  const S = curScale();
  for (const o of state.objects) {
    if (o.type === 'ink' && o.pageIndex === pi) {
      drawSmoothStroke(ctx, o.points, o.size * S, o.color, S);
    }
  }
}

/* ============================== signature: pad ============================== */

const sigPad = { strokes: [], cur: null, color: '#141821', size: 2.5 };

function sigPadSetup() {
  const c = sigPadCanvas;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = c.clientWidth || 560;
  const h = c.clientHeight || 220;
  c.width = Math.floor(w * dpr);
  c.height = Math.floor(h * dpr);
  c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  sigPadRedraw();
}

function sigPadRedraw() {
  const ctx = sigPadCanvas.getContext('2d');
  ctx.clearRect(0, 0, sigPadCanvas.width, sigPadCanvas.height);
  for (const st of sigPad.strokes) drawSmoothStroke(ctx, st.points, st.size, st.color, 1);
  if (sigPad.cur) drawSmoothStroke(ctx, sigPad.cur.points, sigPad.cur.size, sigPad.cur.color, 1);
}

sigPadCanvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  sigPadCanvas.setPointerCapture(e.pointerId);
  const r = sigPadCanvas.getBoundingClientRect();
  sigPad.cur = {
    points: [{ x: e.clientX - r.left, y: e.clientY - r.top }],
    size: sigPad.size, color: sigPad.color
  };
  sigPadRedraw();
});
sigPadCanvas.addEventListener('pointermove', (e) => {
  if (!sigPad.cur) return;
  const r = sigPadCanvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const pts = sigPad.cur.points;
  const lp = pts[pts.length - 1];
  const dx = x - lp.x, dy = y - lp.y;
  if (dx * dx + dy * dy < 1.2) return;
  pts.push({ x, y });
  sigPadRedraw();
});
function sigPadUp() {
  if (!sigPad.cur) return;
  sigPad.strokes.push(sigPad.cur);
  sigPad.cur = null;
  sigPadRedraw();
  updateSigUse();
}
sigPadCanvas.addEventListener('pointerup', sigPadUp);
sigPadCanvas.addEventListener('pointercancel', sigPadUp);

sigClear.addEventListener('click', () => {
  sigPad.strokes = [];
  sigPad.cur = null;
  sigPadRedraw();
  updateSigUse();
});
sigPenColor.addEventListener('change', () => { sigPad.color = sigPenColor.value; });
sigPenSize.addEventListener('input', () => { sigPad.size = parseFloat(sigPenSize.value) || 2.5; });

function trimCanvas(c, pad) {
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  if (!w || !h) return null;
  const d = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function canvasToSig(c) {
  return { url: c.toDataURL('image/png'), w: c.width, h: c.height };
}

function sigFromPad() {
  if (!sigPad.strokes.length) return null;
  const SC = 2;
  const w = sigPadCanvas.clientWidth || 560;
  const h = sigPadCanvas.clientHeight || 220;
  const c = document.createElement('canvas');
  c.width = w * SC;
  c.height = h * SC;
  const ctx = c.getContext('2d');
  ctx.setTransform(SC, 0, 0, SC, 0, 0);
  for (const st of sigPad.strokes) drawSmoothStroke(ctx, st.points, st.size, st.color, 1);
  const t = trimCanvas(c, 8);
  return t ? canvasToSig(t) : null;
}

/* ============================== signature: scan cleanup ============================== */

const sigScan = { src: null };

function sigOpts() {
  return {
    threshold: parseInt(sigThreshold.value, 10) || 205,
    ink: sigInk.value,
    boost: sigBoost.checked
  };
}

function processScan(srcData, opts) {
  const w = srcData.width, h = srcData.height;
  const s = srcData.data;
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    lum[i] = 0.299 * s[j] + 0.587 * s[j + 1] + 0.114 * s[j + 2];
  }
  let lo = 0, hi = 255;
  if (opts.boost) {
    const sample = [];
    const step = Math.max(1, Math.floor(n / 40000));
    for (let i = 0; i < n; i += step) sample.push(lum[i]);
    sample.sort((a, b) => a - b);
    lo = sample[Math.floor(sample.length * 0.02)];
    hi = sample[Math.floor(sample.length * 0.97)];
    if (hi - lo < 20) { lo = 0; hi = 255; }
  }
  const range = Math.max(1, hi - lo);
  const soft = 34;
  const out = new ImageData(w, h);
  const d = out.data;
  const inks = { black: [18, 20, 26], blue: [26, 63, 168] };
  const inkCol = inks[opts.ink] || null;
  for (let i = 0; i < n; i++) {
    let L = lum[i];
    if (opts.boost) L = clamp(((L - lo) / range) * 255, 0, 255);
    let a = clamp(((opts.threshold - L) / soft) * 255, 0, 255);
    if (a < 10) a = 0;
    const j = i * 4;
    if (inkCol) {
      d[j] = inkCol[0]; d[j + 1] = inkCol[1]; d[j + 2] = inkCol[2];
    } else {
      d[j] = s[j]; d[j + 1] = s[j + 1]; d[j + 2] = s[j + 2];
    }
    d[j + 3] = a;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(out, 0, 0);
  return trimCanvas(c, 6);
}

let sigRafPending = false;
function scheduleSigPreview() {
  if (sigRafPending) return;
  sigRafPending = true;
  requestAnimationFrame(() => { sigRafPending = false; renderSigPreview(); });
}

function previewMessage(msg) {
  const c = sigPreview;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = 'rgba(20,24,33,0.6)';
  ctx.font = '14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(msg, c.width / 2, c.height / 2);
}

function renderSigPreview() {
  if (!sigScan.src) {
    previewMessage('Choose a photo of your signature to preview it here');
    return;
  }
  const res = processScan(sigScan.src, sigOpts());
  if (!res) {
    previewMessage('Nothing detected — raise the background removal slider');
    return;
  }
  const c = sigPreview;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const sc = Math.min(c.width / res.width, c.height / res.height, 3) * 0.92;
  const dw = res.width * sc, dh = res.height * sc;
  ctx.drawImage(res, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
}

sigUploadBtn.addEventListener('click', () => sigFileInput.click());
sigFileInput.addEventListener('change', () => {
  const file = sigFileInput.files && sigFileInput.files[0];
  sigFileInput.value = '';
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => {
    const img = new Image();
    img.onload = () => {
      const cap = 1600;
      const sc = Math.min(1, cap / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * sc));
      c.height = Math.max(1, Math.round(img.naturalHeight * sc));
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, c.width, c.height);
      sigScan.src = ctx.getImageData(0, 0, c.width, c.height);
      renderSigPreview();
      updateSigUse();
    };
    img.onerror = () => previewMessage('That image could not be read');
    img.src = fr.result;
  };
  fr.readAsDataURL(file);
});
sigThreshold.addEventListener('input', scheduleSigPreview);
sigInk.addEventListener('change', scheduleSigPreview);
sigBoost.addEventListener('change', scheduleSigPreview);

/* ============================== signature: modal ============================== */

function openModal(el) { el.classList.remove('hidden'); }
function closeModal(el) { el.classList.add('hidden'); }

for (const wrap of $$('.modal-wrap')) {
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target === wrap) closeModal(wrap);
  });
}

function activeSigPane() {
  const t = $('.tab.active', sigModal);
  return t ? t.dataset.pane : 'sig-pane-draw';
}

for (const tab of $$('.tab', sigModal)) {
  tab.addEventListener('click', () => {
    for (const t of $$('.tab', sigModal)) t.classList.toggle('active', t === tab);
    $('#sig-pane-draw').classList.toggle('hidden', tab.dataset.pane !== 'sig-pane-draw');
    $('#sig-pane-upload').classList.toggle('hidden', tab.dataset.pane !== 'sig-pane-upload');
    if (tab.dataset.pane === 'sig-pane-draw') requestAnimationFrame(sigPadSetup);
    else renderSigPreview();
    updateSigUse();
  });
}

function updateSigUse() {
  const pane = activeSigPane();
  sigUse.disabled = pane === 'sig-pane-draw'
    ? sigPad.strokes.length === 0
    : !sigScan.src;
}

btnSignature.addEventListener('click', () => {
  if (!needDoc()) return;
  sigUseLast.classList.toggle('hidden', !state.sig);
  openModal(sigModal);
  requestAnimationFrame(sigPadSetup);
  if (activeSigPane() === 'sig-pane-upload') renderSigPreview();
  updateSigUse();
});
$('#sig-close').addEventListener('click', () => closeModal(sigModal));
$('#sig-cancel').addEventListener('click', () => closeModal(sigModal));

sigUse.addEventListener('click', () => {
  let sig = null;
  if (activeSigPane() === 'sig-pane-draw') {
    sig = sigFromPad();
  } else if (sigScan.src) {
    const res = processScan(sigScan.src, sigOpts());
    if (res) sig = canvasToSig(res);
  }
  if (!sig) return;
  state.sig = sig;
  closeModal(sigModal);
  beginPlace({ kind: 'sig', url: sig.url, w: sig.w, h: sig.h });
});

sigUseLast.addEventListener('click', () => {
  if (!state.sig) return;
  closeModal(sigModal);
  beginPlace({ kind: 'sig', url: state.sig.url, w: state.sig.w, h: state.sig.h });
});

/* ============================== images ============================== */

btnImage.addEventListener('click', () => {
  if (!needDoc()) return;
  imageInput.click();
});

imageInput.addEventListener('change', () => {
  const file = imageInput.files && imageInput.files[0];
  imageInput.value = '';
  if (!file) return;
  const fr = new FileReader();
  fr.onerror = () => showBanner('Could not read that image.');
  fr.onload = () => {
    const img = new Image();
    img.onload = () => {
      let url = fr.result;
      if (!/^data:image\/(png|jpeg)/i.test(url)) {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        url = c.toDataURL('image/png');
      }
      beginPlace({ kind: 'image', url, w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => showBanner('That image format is not supported.');
    img.src = fr.result;
  };
  fr.readAsDataURL(file);
});

/* ============================== export ============================== */

function pdfBox(vp1, x, y, w, h) {
  const a = vp1.convertToPdfPoint(x, y);
  const b = vp1.convertToPdfPoint(x + w, y + h);
  return {
    L: Math.min(a[0], b[0]), R: Math.max(a[0], b[0]),
    B: Math.min(a[1], b[1]), T: Math.max(a[1], b[1])
  };
}

function anchorFor(rot, box) {
  if (rot === 90) return [box.R, box.B];
  if (rot === 180) return [box.R, box.T];
  if (rot === 270) return [box.L, box.T];
  return [box.L, box.B];
}

function wrapLines(text, maxW, measure) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    if (!raw) { out.push(''); continue; }
    const words = raw.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const cand = line + w;
      if (line && measure(cand) > maxW) {
        out.push(line.trimEnd());
        line = w.trimStart();
        while (measure(line) > maxW && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && measure(line.slice(0, cut)) > maxW) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        line = cand;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

function drawInkToPdf(page, vp1, o) {
  const col = hexToRgb01(o.color);
  const pts = o.points;
  if (pts.length === 1) {
    const c = vp1.convertToPdfPoint(pts[0].x, pts[0].y);
    page.drawCircle({ x: c[0], y: c[1], size: Math.max(0.4, o.size / 2), color: col });
    return;
  }
  let prev = vp1.convertToPdfPoint(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const cur = vp1.convertToPdfPoint(pts[i].x, pts[i].y);
    page.drawLine({
      start: { x: prev[0], y: prev[1] },
      end: { x: cur[0], y: cur[1] },
      thickness: o.size,
      color: col,
      lineCap: LineCapStyle.Round
    });
    prev = cur;
  }
}

async function drawTextToPdf(srcDoc, page, helv, vp1, rot, o) {
  const color = hexToRgb01(o.color);
  const size = o.size;
  const lh = size * 1.25;
  let vector = rot === 0;
  if (vector) {
    try { helv.widthOfTextAtSize(o.text.replace(/\n/g, ' '), size); }
    catch (e) { vector = false; }
  }
  if (vector) {
    const lines = wrapLines(o.text, Math.max(8, o.w - 2), (s2) => helv.widthOfTextAtSize(s2, size));
    const b = pdfBox(vp1, o.x, o.y, o.w, o.h);
    const asc = size * 0.8;
    lines.forEach((ln, i) => {
      if (ln) {
        page.drawText(ln, { x: b.L + 1, y: b.T - asc - i * lh, size, font: helv, color });
      }
    });
    return;
  }
  // Raster fallback: non-Latin text (e.g. Bangla) or rotated pages — rendered by the
  // browser's own fonts at 3x, embedded as a transparent PNG.
  const SC = 3;
  const mc = document.createElement('canvas');
  let mctx = mc.getContext('2d');
  const fontCss = (size * SC) + 'px Helvetica, Arial, sans-serif';
  mctx.font = fontCss;
  const lines = wrapLines(o.text, Math.max(8, o.w - 2), (s2) => mctx.measureText(s2).width / SC);
  const hUnits = Math.max(lh, lines.length * lh);
  mc.width = Math.max(2, Math.ceil(o.w * SC));
  mc.height = Math.max(2, Math.ceil(hUnits * SC));
  mctx = mc.getContext('2d');
  mctx.font = fontCss;
  mctx.fillStyle = o.color;
  mctx.textBaseline = 'top';
  lines.forEach((ln, i) => {
    if (ln) mctx.fillText(ln, SC, (i * lh + size * 0.1) * SC);
  });
  const img = await srcDoc.embedPng(mc.toDataURL('image/png'));
  const b = pdfBox(vp1, o.x, o.y, o.w, hUnits);
  const anchor = anchorFor(rot, b);
  page.drawImage(img, { x: anchor[0], y: anchor[1], width: o.w, height: hUnits, rotate: degrees(rot) });
}

async function exportAnnotated() {
  const srcDoc = await PDFDocument.load(state.bytes, { ignoreEncryption: true });
  const helv = await srcDoc.embedFont(StandardFonts.Helvetica);
  const pdfPages = srcDoc.getPages();
  const imgCache = new Map();
  const embed = async (url) => {
    if (imgCache.has(url)) return imgCache.get(url);
    const img = /^data:image\/jpeg/i.test(url)
      ? await srcDoc.embedJpg(url)
      : await srcDoc.embedPng(url);
    imgCache.set(url, img);
    return img;
  };

  for (const o of state.objects) {
    const page = pdfPages[o.pageIndex];
    const pinfo = state.pages[o.pageIndex];
    if (!page || !pinfo) continue;
    const vp1 = pinfo.viewport1;
    const rot = normRot(page.getRotation().angle);

    if (o.type === 'ink') {
      drawInkToPdf(page, vp1, o);
    } else if (o.type === 'whiteout') {
      const b = pdfBox(vp1, o.x, o.y, o.w, o.h);
      page.drawRectangle({ x: b.L, y: b.B, width: b.R - b.L, height: b.T - b.B, color: rgb(1, 1, 1) });
    } else if (o.type === 'image' || o.type === 'sig') {
      const img = await embed(o.url);
      const b = pdfBox(vp1, o.x, o.y, o.w, o.h);
      const anchor = anchorFor(rot, b);
      page.drawImage(img, { x: anchor[0], y: anchor[1], width: o.w, height: o.h, rotate: degrees(rot) });
    } else if (o.type === 'text') {
      await drawTextToPdf(srcDoc, page, helv, vp1, rot, o);
    }
  }
  return srcDoc.save({ useObjectStreams: true });
}

btnDownload.addEventListener('click', async () => {
  if (!state.doc) return;
  const orig = btnDownload.textContent;
  btnDownload.disabled = true;
  btnDownload.textContent = 'Preparing…';
  try {
    const bytes = await exportAnnotated();
    downloadBytes(bytes, suffixName(state.name, state.objects.length ? '-edited' : ''));
  } catch (err) {
    showBanner('Export failed: ' + ((err && err.message) || err));
  }
  btnDownload.textContent = orig;
  btnDownload.disabled = false;
});

/* ============================== resize & compress ============================== */

const PAGE_FORMATS = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008]
};

async function resizePages(bytes, preset, pct) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  for (const page of doc.getPages()) {
    if (preset === 'pct') {
      const f = pct / 100;
      page.scale(f, f);
    } else {
      const fmt = PAGE_FORMATS[preset];
      const size = page.getSize();
      let TW = fmt[0], TH = fmt[1];
      if ((size.width > size.height) !== (TW > TH)) { TW = fmt[1]; TH = fmt[0]; }
      const f = Math.min(TW / size.width, TH / size.height);
      page.scale(f, f);
      const nw = size.width * f, nh = size.height * f;
      page.setMediaBox(0, 0, TW, TH);
      page.setCropBox(0, 0, TW, TH);
      page.translateContent((TW - nw) / 2, (TH - nh) / 2);
    }
  }
  return doc.save({ useObjectStreams: true });
}

async function compressRasterize(bytes, dpi, quality, onProgress) {
  const task = pdfjsLib.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  try {
    const out = await PDFDocument.create();
    const sc = dpi / 72;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: sc });
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(vp.width));
      c.height = Math.max(1, Math.ceil(vp.height));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
      if (!blob) throw new Error('Page ' + i + ' could not be encoded.');
      const jpg = await out.embedJpg(await blob.arrayBuffer());
      const wPt = vp.width / sc, hPt = vp.height / sc;
      const np = out.addPage([wPt, hPt]);
      np.drawImage(jpg, { x: 0, y: 0, width: wPt, height: hPt });
      if (onProgress) onProgress(i, doc.numPages);
      await new Promise((r) => setTimeout(r, 0));
    }
    return await out.save({ useObjectStreams: true });
  } finally {
    try { doc.destroy(); } catch (e) { /* ignore */ }
  }
}

let lastResult = null;

function showResult(bytes, name) {
  lastResult = { bytes, name };
  const orig = state.bytes.length;
  let txt = 'Ready — ' + formatBytes(bytes.length) + ' (original ' + formatBytes(orig) + ')';
  const delta = 1 - bytes.length / orig;
  if (delta > 0.01) txt += ' · ' + Math.round(delta * 100) + '% smaller';
  resultText.textContent = txt;
  resultRow.classList.remove('hidden');
}

btnResize.addEventListener('click', () => {
  if (!needDoc()) return;
  resultRow.classList.add('hidden');
  cmpProgress.classList.add('hidden');
  openModal(resizeModal);
});
$('#resize-close').addEventListener('click', () => closeModal(resizeModal));

pagePreset.addEventListener('change', () => {
  pageScaleWrap.classList.toggle('hidden', pagePreset.value !== 'pct');
});

cmpLossless.addEventListener('change', () => {
  cmpLossy.classList.toggle('hidden', cmpLossless.checked);
});

cmpPreset.addEventListener('change', () => {
  const custom = cmpPreset.value === 'custom';
  cmpCustom.classList.toggle('hidden', !custom);
  if (!custom) {
    const parts = cmpPreset.value.split(',');
    cmpDpi.value = parts[0];
    cmpQuality.value = Math.round(parseFloat(parts[1]) * 100);
    cmpDpiV.textContent = cmpDpi.value;
    cmpQualityV.textContent = cmpQuality.value;
  }
});
cmpDpi.addEventListener('input', () => { cmpDpiV.textContent = cmpDpi.value; });
cmpQuality.addEventListener('input', () => { cmpQualityV.textContent = cmpQuality.value; });

btnPageRun.addEventListener('click', async () => {
  if (!state.doc) return;
  const orig = btnPageRun.textContent;
  btnPageRun.disabled = true;
  btnPageRun.textContent = 'Working…';
  resultRow.classList.add('hidden');
  try {
    const base = await exportAnnotated();
    const pct = clamp(parseFloat(pageScaleInput.value) || 100, 10, 400);
    const out = await resizePages(base, pagePreset.value, pct);
    showResult(out, suffixName(state.name, '-resized'));
  } catch (err) {
    showBanner('Resize failed: ' + ((err && err.message) || err));
  }
  btnPageRun.textContent = orig;
  btnPageRun.disabled = false;
});

btnCmpRun.addEventListener('click', async () => {
  if (!state.doc) return;
  const orig = btnCmpRun.textContent;
  btnCmpRun.disabled = true;
  btnCmpRun.textContent = 'Working…';
  resultRow.classList.add('hidden');
  try {
    const base = await exportAnnotated();
    let out;
    if (cmpLossless.checked) {
      cmpProgress.classList.remove('hidden');
      cmpBar.style.width = '50%';
      cmpText.textContent = 'Re-saving…';
      const doc = await PDFDocument.load(base, { ignoreEncryption: true });
      out = await doc.save({ useObjectStreams: true });
      showResult(out, suffixName(state.name, '-optimized'));
    } else {
      let dpi, q;
      if (cmpPreset.value === 'custom') {
        dpi = parseInt(cmpDpi.value, 10) || 120;
        q = (parseInt(cmpQuality.value, 10) || 75) / 100;
      } else {
        const parts = cmpPreset.value.split(',');
        dpi = parseFloat(parts[0]);
        q = parseFloat(parts[1]);
      }
      cmpProgress.classList.remove('hidden');
      cmpBar.style.width = '0%';
      out = await compressRasterize(base, dpi, q, (i, n) => {
        cmpBar.style.width = Math.round((i / n) * 100) + '%';
        cmpText.textContent = 'Page ' + i + ' / ' + n;
      });
      showResult(out, suffixName(state.name, '-compressed'));
    }
  } catch (err) {
    showBanner('Compression failed: ' + ((err && err.message) || err));
  }
  cmpProgress.classList.add('hidden');
  btnCmpRun.textContent = orig;
  btnCmpRun.disabled = false;
});

btnResultDownload.addEventListener('click', () => {
  if (lastResult) downloadBytes(lastResult.bytes, lastResult.name);
});
btnResultLoad.addEventListener('click', async () => {
  if (!lastResult) return;
  closeModal(resizeModal);
  await loadBytes(lastResult.bytes, lastResult.name);
});

/* ============================== toolbar & inputs ============================== */

for (const b of toolBtns) {
  b.addEventListener('click', () => {
    if (!needDoc()) return;
    setTool(b.dataset.tool);
  });
}

textSizeInput.addEventListener('input', () => {
  const v = clamp(parseInt(textSizeInput.value, 10) || 16, 8, 96);
  state.textDefaults.size = v;
  const sel = state.selection;
  if (sel && sel.type === 'text') { sel.size = v; applyObjectLayout(sel); }
});
textColorInput.addEventListener('input', () => {
  state.textDefaults.color = textColorInput.value;
  const sel = state.selection;
  if (sel && sel.type === 'text') { sel.color = textColorInput.value; applyObjectLayout(sel); }
});
penSizeInput.addEventListener('input', () => {
  state.pen.size = parseFloat(penSizeInput.value) || 3;
});
penColorInput.addEventListener('input', () => {
  state.pen.color = penColorInput.value;
});
btnUndoStroke.addEventListener('click', undo);
btnDeleteObj.addEventListener('click', () => {
  if (state.selection) deleteObject(state.selection.id);
});

btnOpenTop.addEventListener('click', () => pdfInput.click());
btnOpenFile.addEventListener('click', () => pdfInput.click());
pdfInput.addEventListener('change', () => {
  const f = pdfInput.files && pdfInput.files[0];
  pdfInput.value = '';
  handleNewFile(f);
});

/* ============================== drag & drop ============================== */

viewerEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  viewerEl.classList.add('drag');
});
viewerEl.addEventListener('dragleave', () => viewerEl.classList.remove('drag'));
viewerEl.addEventListener('drop', (e) => {
  e.preventDefault();
  viewerEl.classList.remove('drag');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && (/\.pdf$/i.test(f.name) || f.type === 'application/pdf')) handleNewFile(f);
  else if (f) showBanner('That does not look like a PDF file.');
});

/* ============================== keyboard ============================== */

document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t && (t.isContentEditable || t.tagName === 'INPUT' ||
                       t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
  if (e.key === 'Escape') {
    if (!sigModal.classList.contains('hidden')) { closeModal(sigModal); return; }
    if (!resizeModal.classList.contains('hidden')) { closeModal(resizeModal); return; }
    if (typing) { t.blur(); return; }
    clearSelection();
    setTool('select');
    return;
  }
  if (typing) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection) {
    e.preventDefault();
    deleteObject(state.selection.id);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  if (!state.doc) return;
  const k = e.key.toLowerCase();
  if (k === 'v') setTool('select');
  else if (k === 't') setTool('text');
  else if (k === 'd') setTool('draw');
  else if (k === 'w') setTool('whiteout');
  else if (k === 's') btnSignature.click();
  else if (k === 'i') btnImage.click();
});

/* ============================== boot ============================== */

setTool('select');
const srcParam = new URLSearchParams(location.search).get('src');
if (srcParam) loadFromUrl(srcParam);
