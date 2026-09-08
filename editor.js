'use strict';
/* global pdfjsLib, PDFLib, chrome, PSExtract, PSDocOps, PSTheme */
/*
 * The editor: viewer, annotation tools, side panels and export.
 *
 * Annotations live as plain objects in `state.objects`, positioned in the
 * coordinate space of a pdf.js viewport at scale 1, and are only turned into
 * PDF content on export. That keeps editing cheap and undoable, and means the
 * original file is never modified until you save.
 *
 * `window.PS` is the surface ui.js builds the Workbench on.
 */

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('libs/pdf.worker.min.js');
const { PDFDocument, StandardFonts, PDFName, PDFNumber, PDFString, PDFArray,
        rgb, degrees, LineCapStyle } = PDFLib;

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

// A document's own name reaches this from the PDF or its URL, so it is stripped
// of anything that could steer where the file lands.
function safeFileName(name) {
  const clean = String(name || 'document')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  // Windows resolves these as devices whatever the extension is, so a document
  // titled "CON" or "LPT1.pdf" would not save as an ordinary file.
  const safe = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(clean) ? '_' + clean : clean;
  return safe.slice(0, 180) || 'document';
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = safeFileName(name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 15000);
}

function downloadBytes(bytes, name) {
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
}

/**
 * Parse a page range such as "1-3, 8, 12-" into zero-based indexes.
 * An empty or unparseable string means "every page".
 */
function parseRange(text, pageCount) {
  const trimmed = String(text || '').trim();
  if (!trimmed || /^all$/i.test(trimmed)) return null;
  const out = new Set();
  for (const part of trimmed.split(/[,;]/)) {
    const chunk = part.trim();
    if (!chunk) continue;
    const m = /^(\d+)?\s*(?:-|–|to)\s*(\d+)?$/i.exec(chunk);
    if (m) {
      const from = m[1] ? parseInt(m[1], 10) : 1;
      const to = m[2] ? parseInt(m[2], 10) : pageCount;
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
        if (i >= 1 && i <= pageCount) out.add(i - 1);
      }
    } else if (/^\d+$/.test(chunk)) {
      const n = parseInt(chunk, 10);
      if (n >= 1 && n <= pageCount) out.add(n - 1);
    }
  }
  return out.size ? Array.from(out).sort((a, b) => a - b) : null;
}

/* ============================== elements ============================== */

const viewerEl = $('#viewer');
const pagesEl = $('#pages');
const emptyState = $('#empty-state');
const bannerEl = $('#banner');
const metaEl = $('#meta');
const hintEl = $('#hint');
const zoomLabel = $('#zoom-label');
const sidebarEl = $('#sidebar');

const toolBtns = $$('.tool[data-tool]');
const btnSignature = $('#btn-signature');
const btnStamp = $('#btn-stamp');
const btnImage = $('#btn-image');
const btnDownload = $('#btn-download');
const btnWorkbench = $('#btn-workbench');
const btnOpenTop = $('#btn-open-top');
const btnOpenFile = $('#btn-open-file');

const ctxText = $('#ctx-text');
const ctxPen = $('#ctx-pen');
const ctxHighlight = $('#ctx-highlight');
const ctxShape = $('#ctx-shape');
const textSizeInput = $('#text-size');
const textColorInput = $('#text-color');
const textBoldInput = $('#text-bold');
const textItalicInput = $('#text-italic');
const textFamilyInput = $('#text-family');
const textOriginLabel = $('#text-origin');
const penSizeInput = $('#pen-size');
const penColorInput = $('#pen-color');
const hlColorInput = $('#hl-color');
const hlOpacityInput = $('#hl-opacity');
const shapeKindInput = $('#shape-kind');
const shapeStrokeInput = $('#shape-stroke');
const shapeWidthInput = $('#shape-width');
const shapeFillInput = $('#shape-fill');
const shapeFilledInput = $('#shape-filled');
const btnUndoStroke = $('#btn-undo-stroke');
const btnDeleteObj = $('#btn-delete-obj');
const btnDuplicateObj = $('#btn-duplicate-obj');

const pdfInput = $('#pdf-input');
const imageInput = $('#image-input');
const btnReplaceImg = $('#btn-replace-img');
const sigFileInput = $('#sig-file-input');

const sigModal = $('#sig-modal');
const sigPadCanvas = $('#sig-pad');
const sigPreview = $('#sig-preview');
const sigTypePreview = $('#sig-type-preview');
const sigTypeText = $('#sig-type-text');
const sigTypeFont = $('#sig-type-font');
const sigTypeColor = $('#sig-type-color');
const sigPenColor = $('#sig-pen-color');
const sigPenSize = $('#sig-pen-size');
const sigClear = $('#sig-clear');
const sigUploadBtn = $('#sig-upload-btn');
const sigThreshold = $('#sig-threshold');
const sigInk = $('#sig-ink');
const sigBoost = $('#sig-boost');
const sigUse = $('#sig-use');
const sigUseLast = $('#sig-use-last');

const stampModal = $('#stamp-modal');
const pwModal = $('#pw-modal');
const keysModal = $('#keys-modal');

/* ============================== state ============================== */

const state = {
  bytes: null,
  name: 'document.pdf',
  doc: null,
  pages: [],          // { index, page, viewport1, wrap, canvas, ink, overlay, ... }
  io: null,
  fitScale: 1,
  zoom: 1,
  tool: 'select',
  objects: [],
  undoStack: [],
  selection: null,
  place: null,        // { kind: 'image'|'sig'|'stamp', ... }
  sig: null,
  currentPage: 1,
  pen: { size: 3, color: '#16213e' },
  textDefaults: { size: 16, color: '#111318', bold: false, italic: false },
  highlight: { color: '#ffe14d', opacity: 0.38 },
  shape: { kind: 'rect', stroke: '#d92d20', width: 2, fill: '#ffffff', filled: false },
  pagePlan: null,     // staged organiser changes
  selectedPages: new Set(),
  search: { term: '', hits: [], index: -1, cache: new Map() },
  night: false,
  present: false,
  locked: false,      // encrypted and not decryptable here: saving is blocked
  wasProtected: false // opened from a protected file, now decrypted in memory
};
let uid = 1;

const curScale = () => state.fitScale * state.zoom;

/* ============================== status ui ============================== */

let bannerTimer = null;

function showBanner(msg, type) {
  clearTimeout(bannerTimer);
  if (!msg) {
    bannerEl.classList.add('hidden');
    return;
  }
  bannerEl.textContent = msg;
  bannerEl.title = 'Click to dismiss';
  bannerEl.classList.toggle('info', type === 'info');
  bannerEl.classList.toggle('ok', type === 'ok');
  bannerEl.classList.remove('hidden');
  if (type === 'ok' || type === 'info') {
    bannerTimer = setTimeout(() => bannerEl.classList.add('hidden'), 7000);
  }
}
bannerEl.addEventListener('click', () => showBanner(null));

function setMeta(text) {
  metaEl.textContent = text;
}

function needDoc() {
  if (state.doc) return true;
  showBanner('Open a PDF first — drop one anywhere on this page or use "Open".', 'info');
  return false;
}

const TOOL_HINTS = {
  select: '',
  text: 'Click on a page to add a text box',
  draw: 'Draw directly on the page',
  highlight: 'Drag across the text you want to highlight',
  shape: 'Drag to draw a shape',
  whiteout: 'Drag to cover an area with white',
  redact: 'Drag over anything that must be removed for good',
  note: 'Click to drop a sticky note',
  pictures: 'Click an outlined picture to lift it off the page and edit it',
  edittext: 'Click an outlined paragraph to edit the words already in the document',
  place: 'Click on a page to place it'
};

function setTool(t) {
  state.tool = t;
  if (t !== 'place') state.place = null;
  for (const b of toolBtns) b.classList.toggle('active', b.dataset.tool === t);
  pagesEl.className = '';
  pagesEl.classList.add('tool-' + t);
  hintEl.textContent = TOOL_HINTS[t] || '';
  refreshImageMarks();
  refreshTextMarks();
  updateCtx();
}

function updateCtx() {
  const sel = state.selection;
  ctxText.classList.toggle('hidden', !(state.tool === 'text' || (sel && sel.type === 'text')));
  ctxPen.classList.toggle('hidden', state.tool !== 'draw');
  ctxHighlight.classList.toggle('hidden', state.tool !== 'highlight');
  ctxShape.classList.toggle('hidden', state.tool !== 'shape');
  btnDeleteObj.classList.toggle('hidden', !sel);
  btnDuplicateObj.classList.toggle('hidden', !sel || sel.type === 'ink');
  btnReplaceImg.classList.toggle('hidden', !sel || (sel.type !== 'image' && sel.type !== 'sig'));
  if (sel && sel.type === 'text') {
    textSizeInput.value = Math.round(sel.size * 10) / 10;
    textColorInput.value = sel.color;
    textBoldInput.checked = !!sel.bold;
    textItalicInput.checked = !!sel.italic;
    textFamilyInput.value = sel.family || 'sans';
    // Say which font the block came from, and at what size. The standard PDF
    // fonts are the only ones that can be embedded, so what is drawn is a
    // match by kind rather than the original face — showing the name makes
    // that visible, and every control beside it can correct a bad guess.
    textOriginLabel.textContent = sel.origin
      ? sel.origin + ' · ' + (Math.round(sel.size * 10) / 10) + 'pt'
      : '';
    textOriginLabel.title = sel.origin ? 'The font this text was set in originally' : '';
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

// The editor fetches with the user's cookies so that PDFs behind a login work.
// That is only ever meant for a document the user is already looking at, so the
// target is restricted to the schemes a PDF can actually be served over.
const FETCHABLE_SCHEMES = ['http:', 'https:', 'file:', 'blob:', 'data:'];

function isFetchableUrl(u) {
  try {
    return FETCHABLE_SCHEMES.includes(new URL(u).protocol);
  } catch (e) {
    return false;
  }
}

async function loadFromUrl(u) {
  if (!isFetchableUrl(u)) {
    showBanner('That address cannot be opened here. Choose a PDF file instead.', 'info');
    setMeta('No document loaded');
    return;
  }
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

function askPassword(wrong) {
  return new Promise((resolve) => {
    const input = $('#pw-input');
    const error = $('#pw-error');
    error.classList.toggle('hidden', !wrong);
    input.value = '';
    pwModal.classList.remove('hidden');
    setTimeout(() => input.focus(), 30);
    const done = (value) => {
      pwModal.classList.add('hidden');
      $('#pw-ok').removeEventListener('click', ok);
      $('#pw-cancel').removeEventListener('click', cancel);
      input.removeEventListener('keydown', key);
      resolve(value);
    };
    const ok = () => done(input.value);
    const cancel = () => done(null);
    const key = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); ok(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    $('#pw-ok').addEventListener('click', ok);
    $('#pw-cancel').addEventListener('click', cancel);
    input.addEventListener('keydown', key);
  });
}

async function openWithPdfjs(bytes) {
  let password;
  for (let attempt = 0; attempt < 4; attempt++) {
    const params = { data: bytes.slice(), isEvalSupported: false };
    if (password != null) params.password = password;
    try {
      return { doc: await pdfjsLib.getDocument(params).promise, password: password || '' };
    } catch (err) {
      const name = err && err.name;
      const needsPassword = name === 'PasswordException' ||
        /password/i.test((err && err.message) || '');
      if (!needsPassword) throw err;
      password = await askPassword(attempt > 0);
      if (password == null) throw new Error('CANCELLED');
    }
  }
  throw new Error('Too many password attempts.');
}

/**
 * Editing works on the raw bytes, and pdf-lib cannot write into an encrypted
 * file — it would emit new objects in the clear next to an /Encrypt trailer and
 * produce a document no reader can open. So a protected document is decrypted
 * up front. When that is not possible the file stays viewable and convertible,
 * but saving is blocked rather than silently corrupting the result.
 */
async function unlockForEditing(bytes, password) {
  const info = await PSCrypt.inspect(bytes);
  if (!info.encrypted) return { bytes, protectedSource: false, locked: false };
  try {
    const clear = await PSCrypt.removePassword(bytes, password || '');
    return { bytes: clear, protectedSource: true, locked: false };
  } catch (err) {
    return { bytes, protectedSource: true, locked: true };
  }
}

async function loadBytes(bytes, name) {
  showBanner(null);
  setMeta('Opening…');
  let opened;
  try {
    opened = await openWithPdfjs(bytes);
  } catch (err) {
    if (err && err.message === 'CANCELLED') {
      setMeta(state.doc ? metaText() : 'No document loaded');
      return;
    }
    showBanner('Could not open this file as a PDF. ' + ((err && err.message) || ''));
    setMeta(state.doc ? metaText() : 'No document loaded');
    return;
  }
  const doc = opened.doc;
  const unlocked = await unlockForEditing(bytes, opened.password);
  bytes = unlocked.bytes;
  if (state.doc) { try { state.doc.destroy(); } catch (e) { /* ignore */ } }
  if (state.io) state.io.disconnect();
  clearSelection();
  state.bytes = bytes;
  state.name = name || 'document.pdf';
  state.doc = doc;
  state.objects = [];
  forgetPageImages();
  forgetPageParagraphs();
  state.undoStack = [];
  state.place = null;
  state.zoom = 1;
  state.currentPage = 1;
  state.pagePlan = null;
  state.selectedPages = new Set();
  state.locked = false;
  state.wasProtected = false;
  state.search = { term: '', hits: [], index: -1, cache: new Map() };
  state.locked = unlocked.locked;
  state.wasProtected = unlocked.protectedSource;
  await buildPages();
  emptyState.classList.add('hidden');
  btnDownload.disabled = state.locked;
  btnWorkbench.disabled = false;
  setMeta(metaText());
  setTool('select');
  $('#page-total').textContent = '/ ' + doc.numPages;
  $('#page-current').value = 1;
  if (state.locked) {
    showBanner('This document stays encrypted: its structure cannot be rewritten here, so editing ' +
      'and saving are switched off. Reading, searching and converting still work — or use ' +
      'Workbench → Security → Remove a password to rebuild it as an unprotected copy.');
  } else if (state.wasProtected) {
    showBanner('This document was password-protected. It has been unlocked for editing — use ' +
      'Workbench → Security to protect the copy you save.', 'info');
  }
  document.dispatchEvent(new CustomEvent('ps:document-loaded'));
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
      if (en.isIntersecting) {
        renderPage(idx);
        if (state.tool === 'pictures') markPageImages(idx);
        if (state.tool === 'edittext') markPageParagraphs(idx);
        if (en.intersectionRatio > 0.4) setCurrentPage(idx + 1);
      }
    }
  }, { root: viewerEl, rootMargin: '600px 0px', threshold: [0, 0.45] });

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
    overlay.addEventListener('dblclick', (ev) => onOverlayDoubleClick(ev, p.index));

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
  refreshImageMarks();
  refreshTextMarks();
  positionSearchHits();
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

/* ============================== zoom & navigation ============================== */

function setZoom(z) {
  if (!state.doc) return;
  state.zoom = clamp(z, 0.25, 5);
  layoutAll();
}
$('#zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.15));
$('#zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.15));
$('#zoom-fit').addEventListener('click', () => { updateFitScale(); setZoom(1); });

function setCurrentPage(n) {
  if (state.currentPage === n) return;
  state.currentPage = n;
  const input = $('#page-current');
  if (document.activeElement !== input) input.value = n;
  const active = $('.thumb.current');
  if (active) active.classList.remove('current');
  const thumb = $('.thumb[data-index="' + (n - 1) + '"]');
  if (thumb) thumb.classList.add('current');
}

function goToPage(n) {
  const p = state.pages[clamp(n, 1, state.pages.length) - 1];
  if (!p) return;
  p.wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setCurrentPage(p.index + 1);
}

$('#page-prev').addEventListener('click', () => goToPage(state.currentPage - 1));
$('#page-next').addEventListener('click', () => goToPage(state.currentPage + 1));
$('#page-current').addEventListener('change', () => {
  goToPage(parseInt($('#page-current').value, 10) || 1);
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!state.doc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { updateFitScale(); layoutAll(); }, 200);
});

$('#btn-sidebar').addEventListener('click', () => {
  sidebarEl.classList.toggle('collapsed');
  $('#btn-sidebar').classList.toggle('on', !sidebarEl.classList.contains('collapsed'));
  setTimeout(() => { updateFitScale(); layoutAll(); }, 0);
});
$('#btn-sidebar').classList.add('on');

// The interface theme. Separate from night mode below, which inverts the
// document rather than the interface.
PSTheme.register($('#btn-theme'));

$('#btn-night').addEventListener('click', () => {
  state.night = !state.night;
  document.body.classList.toggle('night', state.night);
  $('#btn-night').classList.toggle('on', state.night);
});

function setPresent(on) {
  state.present = on;
  document.body.classList.toggle('present', on);
  $('#btn-present').classList.toggle('on', on);
  if (on && !document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => { /* permission denied */ });
  } else if (!on && document.fullscreenElement) {
    document.exitFullscreen().catch(() => { /* already exiting */ });
  }
  setTimeout(() => { updateFitScale(); layoutAll(); }, 60);
}
$('#btn-present').addEventListener('click', () => setPresent(!state.present));
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && state.present) setPresent(false);
});

/* ============================== objects ============================== */

function addObject(o) {
  o.id = uid++;
  state.objects.push(o);
  mountObject(o);
  state.undoStack.push(o.id);
  document.dispatchEvent(new CustomEvent('ps:objects-changed'));
  return o;
}

// Colours reach the SVG as raw attribute text, so they are pinned to a literal
// hex triple rather than trusted to be whatever a colour input last held.
function safeColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
}

function shapeSvg(o) {
  const stroke = safeColor(o.stroke, '#000000');
  const w = Math.max(o.w, 1);
  const h = Math.max(o.h, 1);
  const sw = Number(o.width) || 1;
  const fill = o.filled ? safeColor(o.fill, '#ffffff') : 'none';
  let inner;
  if (o.kind === 'rect') {
    inner = '<rect x="' + sw / 2 + '" y="' + sw / 2 + '" width="' + Math.max(0, w - sw) +
      '" height="' + Math.max(0, h - sw) + '" fill="' + fill + '" stroke="' + stroke +
      '" stroke-width="' + sw + '"/>';
  } else if (o.kind === 'ellipse') {
    inner = '<ellipse cx="' + w / 2 + '" cy="' + h / 2 + '" rx="' + Math.max(0, w / 2 - sw / 2) +
      '" ry="' + Math.max(0, h / 2 - sw / 2) + '" fill="' + fill + '" stroke="' + stroke +
      '" stroke-width="' + sw + '"/>';
  } else {
    const p = linePoints(o);
    inner = '<line x1="' + p.x1 + '" y1="' + p.y1 + '" x2="' + p.x2 + '" y2="' + p.y2 +
      '" stroke="' + stroke + '" stroke-width="' + sw + '" stroke-linecap="round"/>';
    if (o.kind === 'arrow') {
      const head = arrowHead(p, Math.max(6, sw * 3.2));
      inner += '<path d="M' + head[0].x + ' ' + head[0].y + ' L' + p.x2 + ' ' + p.y2 +
        ' L' + head[1].x + ' ' + head[1].y + '" fill="none" stroke="' + stroke +
        '" stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round"/>';
    }
  }
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' + inner + '</svg>';
}

// Line-like shapes remember which corners the drag started and ended at.
function linePoints(o) {
  return {
    x1: o.flipX ? o.w : 0,
    y1: o.flipY ? o.h : 0,
    x2: o.flipX ? 0 : o.w,
    y2: o.flipY ? 0 : o.h
  };
}

function arrowHead(p, size) {
  const angle = Math.atan2(p.y2 - p.y1, p.x2 - p.x1);
  const spread = Math.PI / 7;
  return [
    { x: p.x2 - size * Math.cos(angle - spread), y: p.y2 - size * Math.sin(angle - spread) },
    { x: p.x2 - size * Math.cos(angle + spread), y: p.y2 - size * Math.sin(angle + spread) }
  ];
}

function mountObject(o) {
  if (o.type === 'ink') { redrawInk(o.pageIndex); return; }
  const p = state.pages[o.pageIndex];
  if (!p) return;
  const el = document.createElement('div');
  el.className = 'obj obj-' + o.type;
  if (o.fromPage) el.classList.add('from-page');
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
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startTextEdit(o, { clientX: e.clientX, clientY: e.clientY });
    });
  } else if (o.type === 'cover') {
    el.style.background = safeColor(o.color, '#ffffff');
  } else if (o.type === 'highlight') {
    el.style.background = o.color;
    el.style.opacity = String(o.opacity);
  } else if (o.type === 'shape') {
    el.innerHTML = shapeSvg(o);
  } else if (o.type === 'note') {
    el.textContent = '✎';
    el.title = o.text || 'Sticky note';
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); editNote(o); });
  } else if (o.type === 'stamp') {
    const box = document.createElement('div');
    box.className = 'stamp-box';
    box.textContent = o.text;
    box.style.color = o.color;
    el.appendChild(box);
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
    // Never rewrite the text while the caret is in it; outside editing the DOM
    // has to follow the object, or a change made from the toolbar shows
    // nothing until the box is next opened.
    if (!o.el.classList.contains('editing') && t.textContent !== o.text) {
      t.textContent = o.text;
    }
    t.style.fontSize = (o.size * S) + 'px';
    t.style.lineHeight = String(o.leading || 1.25);
    t.style.color = o.color;
    t.style.fontWeight = o.bold ? '700' : '400';
    t.style.fontStyle = o.italic ? 'italic' : 'normal';
    // Matching the export's typeface and alignment on screen keeps the preview
    // wrapping close to what the saved file will do.
    t.style.fontFamily = CSS_FAMILY[o.family] || '';
    t.style.textAlign = o.align === 'center' || o.align === 'right' ? o.align : '';
    o.el.style.height = 'auto';
    o.h = Math.max(o.size * 1.25, o.el.offsetHeight / S);
  } else {
    o.el.style.height = (o.h * S) + 'px';
  }
  if (o.type === 'shape') o.el.innerHTML = shapeSvg(o);
  if (o.type === 'stamp') {
    const box = o.el.querySelector('.stamp-box');
    if (box) box.style.fontSize = (o.h * 0.42 * S) + 'px';
  }
}

function select(o) {
  if (state.selection === o) { updateCtx(); return; }
  clearSelection();
  state.selection = o;
  if (o && o.el) {
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
  document.dispatchEvent(new CustomEvent('ps:objects-changed'));
}

function duplicateObject(o) {
  if (!o || o.type === 'ink') return;
  const copy = Object.assign({}, o);
  delete copy.el;
  delete copy.id;
  copy.x = o.x + 12;
  copy.y = o.y + 12;
  select(addObject(copy));
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
    const nw = Math.max(8, ow + (ev.clientX - sx) / S);
    const nh = Math.max(6, oh + (ev.clientY - sy) / S);
    if (o.type === 'image' || o.type === 'sig') {
      o.w = nw;
      o.h = nw * ratio;
    } else if (o.type === 'text') {
      o.w = Math.max(40, nw);
    } else {
      o.w = nw;
      o.h = nh;
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

/**
 * Open a text box for editing.
 *
 * `at` is the pointer position that asked for it, if there was one, so the
 * caret lands on the word that was clicked instead of at the end of the block.
 */
function startTextEdit(o, at) {
  if (!o.el) return;
  /*
   * Double-clicking a word inside a box that is already open must select that
   * word. Restarting the edit here collapsed the caret to the end of the text
   * instead, and stacked another pair of input/blur listeners every time.
   */
  if (o.el.classList.contains('editing')) return;
  select(o);
  const t = o.el.querySelector('.txt');
  o.el.classList.add('editing');
  try { t.contentEditable = 'plaintext-only'; } catch (err) { t.contentEditable = 'true'; }
  t.focus();

  const sel = window.getSelection();
  let placed = false;
  if (at && document.caretRangeFromPoint) {
    try {
      const hit = document.caretRangeFromPoint(at.clientX, at.clientY);
      if (hit && t.contains(hit.startContainer)) {
        sel.removeAllRanges();
        sel.addRange(hit);
        placed = true;
      }
    } catch (err) { /* fall back to the end of the text */ }
  }
  if (!placed) {
    const r = document.createRange();
    r.selectNodeContents(t);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  const onInput = () => {
    o.text = t.innerText;
    applyObjectLayout(o);
  };
  const onBlur = () => {
    t.removeEventListener('input', onInput);
    t.removeEventListener('blur', onBlur);
    t.contentEditable = 'false';
    o.el.classList.remove('editing');
    o.text = t.innerText.replace(/ /g, ' ').replace(/\n$/, '');
    if (!o.text.trim()) { deleteObject(o.id); return; }
    t.textContent = o.text;
    applyObjectLayout(o);
  };
  t.addEventListener('input', onInput);
  t.addEventListener('blur', onBlur);
}

function editNote(o) {
  const text = window.prompt('Note', o.text || '');
  if (text === null) return;
  o.text = text;
  if (o.el) o.el.title = text || 'Sticky note';
  if (!text.trim()) { deleteObject(o.id); return; }
  document.dispatchEvent(new CustomEvent('ps:objects-changed'));
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
  if (state.tool === 'pictures' || state.tool === 'edittext') { return; }
  ev.preventDefault();
  if (state.tool === 'text') { createTextAt(pi, bx, by); return; }
  if (state.tool === 'note') { createNoteAt(pi, bx, by); return; }
  if (state.tool === 'draw') { beginStroke(p, pi, bx, by); return; }
  if (state.tool === 'place' && state.place) { placeAt(pi, bx, by); return; }
  if (['whiteout', 'redact', 'highlight', 'shape'].includes(state.tool)) {
    beginRubber(p, pi, bx, by, state.tool);
  }
}

function createTextAt(pi, bx, by) {
  const p = state.pages[pi];
  const w = Math.min(240, p.viewport1.width * 0.6);
  let x = bx;
  if (x + w > p.viewport1.width) x = Math.max(0, p.viewport1.width - w);
  const o = addObject({
    type: 'text', pageIndex: pi, x, y: by, w,
    h: state.textDefaults.size * 1.3,
    text: '', size: state.textDefaults.size, color: state.textDefaults.color,
    bold: state.textDefaults.bold, italic: state.textDefaults.italic
  });
  setTool('select');
  select(o);
  startTextEdit(o);
}

function createNoteAt(pi, bx, by) {
  const text = window.prompt('Note');
  if (text === null || !text.trim()) { setTool('select'); return; }
  const o = addObject({
    type: 'note', pageIndex: pi, x: bx, y: by, w: 18, h: 18,
    text: text.trim(), color: '#ffd666'
  });
  setTool('select');
  select(o);
}

function beginRubber(p, pi, sx, sy, kind) {
  const S = curScale();
  const rubber = document.createElement('div');
  rubber.className = 'rubber';
  p.overlay.appendChild(rubber);
  let box = null;
  let flipX = false, flipY = false;
  const move = (e) => {
    const rect = p.overlay.getBoundingClientRect();
    const cx = clamp((e.clientX - rect.left) / S, 0, p.viewport1.width);
    const cy = clamp((e.clientY - rect.top) / S, 0, p.viewport1.height);
    flipX = cx < sx;
    flipY = cy < sy;
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
    if (!box) return;
    const isLine = kind === 'shape' && (state.shape.kind === 'line' || state.shape.kind === 'arrow');
    const big = isLine ? Math.max(box.w, box.h) >= 6 : (box.w >= 4 && box.h >= 4);
    if (!big) return;
    if (kind === 'whiteout' || kind === 'redact') {
      addObject({ type: kind, pageIndex: pi, x: box.x, y: box.y, w: box.w, h: box.h });
    } else if (kind === 'highlight') {
      addObject({
        type: 'highlight', pageIndex: pi, x: box.x, y: box.y, w: box.w, h: box.h,
        color: state.highlight.color, opacity: state.highlight.opacity
      });
    } else if (kind === 'shape') {
      addObject({
        type: 'shape', pageIndex: pi, kind: state.shape.kind,
        x: box.x, y: box.y, w: Math.max(box.w, 1), h: Math.max(box.h, 1),
        stroke: state.shape.stroke, width: state.shape.width,
        fill: state.shape.fill, filled: state.shape.filled,
        flipX, flipY
      });
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
  if (pl.kind === 'stamp') {
    const w = Math.min(190, p.viewport1.width * 0.4);
    const h = w * 0.28;
    const o = addObject({
      type: 'stamp', pageIndex: pi,
      x: clamp(bx - w / 2, 0, Math.max(0, p.viewport1.width - w)),
      y: clamp(by - h / 2, 0, Math.max(0, p.viewport1.height - h)),
      w, h, text: pl.text, color: pl.color
    });
    state.place = null;
    setTool('select');
    select(o);
    return;
  }
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
    : payload.kind === 'stamp'
      ? 'Click on a page to place the stamp'
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

/* ============================== signature: typed ============================== */

function renderTypedSignature(forExport) {
  const text = (sigTypeText.value || '').trim();
  const canvas = sigTypePreview;
  const ctx = canvas.getContext('2d');
  const dpr = forExport ? 3 : Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 560;
  const cssH = 160;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!text) {
    ctx.fillStyle = 'rgba(20,24,33,0.6)';
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Type your name to see it here', cssW / 2, cssH / 2);
    return null;
  }
  let size = 64;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = sigTypeColor.value;
  do {
    ctx.font = size + 'px ' + sigTypeFont.value;
    if (ctx.measureText(text).width <= cssW - 40) break;
    size -= 3;
  } while (size > 14);
  ctx.fillText(text, cssW / 2, cssH / 2);
  return canvas;
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
sigTypeText.addEventListener('input', () => { renderTypedSignature(false); updateSigUse(); });
sigTypeFont.addEventListener('change', () => renderTypedSignature(false));
sigTypeColor.addEventListener('change', () => renderTypedSignature(false));

/* ============================== modals ============================== */

function openModal(el) { el.classList.remove('hidden'); }
function closeModal(el) { el.classList.add('hidden'); }

for (const wrap of $$('.modal-wrap')) {
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target === wrap && wrap !== pwModal) closeModal(wrap);
  });
}

function activeSigPane() {
  const t = $('.tab.active', sigModal);
  return t ? t.dataset.pane : 'sig-pane-draw';
}

for (const tab of $$('.tab', sigModal)) {
  tab.addEventListener('click', () => {
    for (const t of $$('.tab', sigModal)) t.classList.toggle('active', t === tab);
    for (const pane of ['sig-pane-draw', 'sig-pane-type', 'sig-pane-upload']) {
      $('#' + pane).classList.toggle('hidden', tab.dataset.pane !== pane);
    }
    if (tab.dataset.pane === 'sig-pane-draw') requestAnimationFrame(sigPadSetup);
    else if (tab.dataset.pane === 'sig-pane-type') requestAnimationFrame(() => renderTypedSignature(false));
    else renderSigPreview();
    updateSigUse();
  });
}

function updateSigUse() {
  const pane = activeSigPane();
  sigUse.disabled = pane === 'sig-pane-draw'
    ? sigPad.strokes.length === 0
    : pane === 'sig-pane-type'
      ? !(sigTypeText.value || '').trim()
      : !sigScan.src;
}

btnSignature.addEventListener('click', () => {
  if (!needDoc()) return;
  sigUseLast.classList.toggle('hidden', !state.sig);
  openModal(sigModal);
  requestAnimationFrame(sigPadSetup);
  if (activeSigPane() === 'sig-pane-upload') renderSigPreview();
  if (activeSigPane() === 'sig-pane-type') requestAnimationFrame(() => renderTypedSignature(false));
  updateSigUse();
});
$('#sig-close').addEventListener('click', () => closeModal(sigModal));
$('#sig-cancel').addEventListener('click', () => closeModal(sigModal));

sigUse.addEventListener('click', () => {
  let sig = null;
  const pane = activeSigPane();
  if (pane === 'sig-pane-draw') {
    sig = sigFromPad();
  } else if (pane === 'sig-pane-type') {
    const canvas = renderTypedSignature(true);
    const trimmed = canvas ? trimCanvas(canvas, 10) : null;
    if (trimmed) sig = canvasToSig(trimmed);
    renderTypedSignature(false);
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

/* ============================== stamps ============================== */

const STAMP_PRESETS = [
  { text: 'APPROVED', color: '#1f9254' },
  { text: 'REJECTED', color: '#d92d20' },
  { text: 'DRAFT', color: '#6b7280' },
  { text: 'CONFIDENTIAL', color: '#d92d20' },
  { text: 'REVIEWED', color: '#1d4ed8' },
  { text: 'URGENT', color: '#c2410c' },
  { text: 'PAID', color: '#1f9254' },
  { text: 'COPY', color: '#6b7280' },
  { text: 'FINAL', color: '#1d4ed8' },
  { text: 'VOID', color: '#d92d20' }
];
let stampChoice = STAMP_PRESETS[0];

function buildStampGrid() {
  const grid = $('#stamp-grid');
  grid.textContent = '';
  for (const preset of STAMP_PRESETS) {
    const b = document.createElement('button');
    b.className = 'stamp-opt';
    b.textContent = preset.text;
    b.style.color = preset.color;
    b.addEventListener('click', () => {
      stampChoice = preset;
      $('#stamp-custom').value = '';
      $('#stamp-color').value = preset.color;
      for (const other of $$('.stamp-opt', grid)) other.classList.toggle('active', other === b);
    });
    grid.appendChild(b);
  }
  const first = $('.stamp-opt', grid);
  if (first) first.classList.add('active');
}
buildStampGrid();

btnStamp.addEventListener('click', () => {
  if (!needDoc()) return;
  openModal(stampModal);
});
$('#stamp-close').addEventListener('click', () => closeModal(stampModal));
$('#stamp-cancel').addEventListener('click', () => closeModal(stampModal));
$('#stamp-use').addEventListener('click', () => {
  const custom = $('#stamp-custom').value.trim();
  let text = custom || stampChoice.text;
  if ($('#stamp-date').checked) text += '  ' + new Date().toLocaleDateString();
  closeModal(stampModal);
  beginPlace({ kind: 'stamp', text, color: $('#stamp-color').value });
});

/* ============================== images ============================== */

btnImage.addEventListener('click', () => {
  if (!needDoc()) return;
  imageInput.click();
});

let replacingImage = null;

btnReplaceImg.addEventListener('click', () => {
  const sel = state.selection;
  if (!sel || (sel.type !== 'image' && sel.type !== 'sig')) return;
  replacingImage = sel;
  imageInput.click();
});

imageInput.addEventListener('change', () => {
  const file = imageInput.files && imageInput.files[0];
  imageInput.value = '';
  const replacing = replacingImage;
  replacingImage = null;
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
      if (replacing && state.objects.includes(replacing)) {
        // Keep the hole the old picture filled; only the artwork changes.
        replacing.url = url;
        const el = replacing.el && replacing.el.querySelector('img');
        if (el) el.src = url;
        replacing.h = replacing.w * (img.naturalHeight / img.naturalWidth);
        applyObjectLayout(replacing);
        select(replacing);
        document.dispatchEvent(new CustomEvent('ps:objects-changed'));
        return;
      }
      beginPlace({ kind: 'image', url, w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => showBanner('That image format is not supported.');
    img.src = fr.result;
  };
  fr.readAsDataURL(file);
});

/* ======================= pictures already on the page ======================= */
/*
 * A picture that came with the document is edited by lifting it out of the page
 * and into the overlay: the area it occupied is covered with the colour of the
 * paper around it, and a copy of the bitmap becomes an ordinary image object.
 * Moving, resizing, deleting and replacing then work exactly as they do for a
 * picture you placed yourself, and the export path needs no new case.
 *
 * The original bytes stay in the file underneath the cover, in the same way a
 * whiteout leaves the text beneath it. Flattening the page on save is what
 * actually removes them.
 */

const pageImageCache = new Map();

function forgetPageImages() {
  pageImageCache.clear();
}

function pageImages(index) {
  if (pageImageCache.has(index)) return pageImageCache.get(index);
  const p = state.pages[index];
  if (!p) return Promise.resolve([]);
  const job = PSExtract.pageEditableImages(p.page, { minPoints: 16 }).catch(() => []);
  pageImageCache.set(index, job);
  return job;
}

/**
 * The colour of the paper immediately around a rectangle, read from the page as
 * it is drawn on screen.
 *
 * Four thin strips just outside the edge are sampled and the most common colour
 * wins, so a picture sitting on a tinted panel is covered with that tint rather
 * than with white. It is one flat colour by design: a picture lying over a
 * gradient, a pattern or text will leave a visible patch behind, which is the
 * trade made when the cover is a colour rather than a re-render of the page.
 */
function sampleBackdrop(index, rect) {
  const p = state.pages[index];
  if (!p || !p.canvas || !p.canvas.width) return '#ffffff';
  let ctx;
  try {
    ctx = p.canvas.getContext('2d', { willReadFrequently: true });
  } catch (e) {
    return '#ffffff';
  }
  if (!ctx) return '#ffffff';

  const S = p.canvas.width / p.viewport1.width; // device pixels per point
  const buckets = new Map();

  const strip = (sx, sy, sw, sh) => {
    const x = Math.max(0, Math.round(sx * S));
    const y = Math.max(0, Math.round(sy * S));
    const w = Math.min(p.canvas.width - x, Math.max(1, Math.round(sw * S)));
    const h = Math.min(p.canvas.height - y, Math.max(1, Math.round(sh * S)));
    if (w <= 0 || h <= 0) return;
    let d;
    try { d = ctx.getImageData(x, y, w, h).data; } catch (e) { return; }
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      // Bucketed to 8 levels a channel, so near-identical paper counts as one.
      const key = ((d[i] >> 5) << 10) | ((d[i + 1] >> 5) << 5) | (d[i + 2] >> 5);
      const seen = buckets.get(key);
      if (seen) { seen.n++; seen.r += d[i]; seen.g += d[i + 1]; seen.b += d[i + 2]; }
      else buckets.set(key, { n: 1, r: d[i], g: d[i + 1], b: d[i + 2] });
    }
  };

  const pad = 4;
  strip(rect.x - pad, rect.y - pad, rect.w + pad * 2, pad);       // above
  strip(rect.x - pad, rect.y + rect.h, rect.w + pad * 2, pad);    // below
  strip(rect.x - pad, rect.y, pad, rect.h);                       // left
  strip(rect.x + rect.w, rect.y, pad, rect.h);                    // right

  let best = null;
  for (const v of buckets.values()) if (!best || v.n > best.n) best = v;
  if (!best) return '#ffffff';
  return PSExtract.hexColor(best.r / best.n, best.g / best.n, best.b / best.n);
}

// pageEditableImages sorts largest first, so walking backwards finds the
// smallest picture under the pointer — the one lying on top.
function imageAt(list, x, y) {
  for (let i = list.length - 1; i >= 0; i--) {
    const im = list[i];
    if (x >= im.x && x <= im.x + im.w && y >= im.y && y <= im.y + im.h) return im;
  }
  return null;
}

function liftImage(index, im) {
  if (im.lifted && state.objects.includes(im.lifted)) {
    select(im.lifted);
    return im.lifted;
  }
  let url;
  try {
    url = im.canvas.toDataURL('image/png');
  } catch (e) {
    showBanner('That picture could not be read out of the page.');
    return null;
  }
  const rect = { x: im.x, y: im.y, w: im.w, h: im.h };
  // The cover goes down first so it sits behind the picture, and only once:
  // lifting, undoing and lifting again must not stack two of them.
  if (!(im.cover && state.objects.includes(im.cover))) {
    im.cover = addObject({
      type: 'cover', pageIndex: index,
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      color: sampleBackdrop(index, rect)
    });
  }
  const obj = addObject({
    type: 'image', pageIndex: index, url, fromPage: true,
    x: rect.x, y: rect.y, w: rect.w, h: rect.h
  });
  im.lifted = obj;
  setTool('select');
  select(obj);
  showBanner('Picture lifted off the page. Drag to move, corner dot to resize, ' +
             'Delete to remove it, Replace to swap it.', 'ok');
  return obj;
}

async function pickImageAt(pi, bx, by) {
  const list = await pageImages(pi);
  const im = list.length ? imageAt(list, bx, by) : null;
  if (!im) return false;
  return !!liftImage(pi, im);
}

/** Outline every editable picture on a page while the Pictures tool is active. */
async function markPageImages(pi) {
  const p = state.pages[pi];
  if (!p || !p.overlay) return;
  const list = await pageImages(pi);
  if (state.tool !== 'pictures') return;
  clearImageMarks(pi);
  const S = curScale();
  for (const im of list) {
    if (im.lifted && state.objects.includes(im.lifted)) continue;
    const el = document.createElement('div');
    el.className = 'imgpick';
    el.style.left = (im.x * S) + 'px';
    el.style.top = (im.y * S) + 'px';
    el.style.width = (im.w * S) + 'px';
    el.style.height = (im.h * S) + 'px';
    el.title = 'Click to edit this picture';
    el.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      liftImage(pi, im);
    });
    p.overlay.appendChild(el);
  }
}

function clearImageMarks(pi) {
  const pages = pi == null ? state.pages : [state.pages[pi]];
  for (const p of pages) {
    if (!p || !p.overlay) continue;
    for (const el of p.overlay.querySelectorAll('.imgpick')) el.remove();
  }
}

function refreshImageMarks() {
  clearImageMarks();
  if (state.tool !== 'pictures') return;
  for (const p of state.pages) if (p.visible) markPageImages(p.index);
}

/* ========================= text already on the page ========================= */
/*
 * Editing a paragraph works the same way a picture does: the block is covered
 * with the colour of the paper around it and a text box carrying the same
 * words, size, weight, colour, typeface and alignment takes its place. Typing
 * re-wraps inside that box.
 *
 * A whole paragraph is the unit. Editing one word in place is not possible
 * without rewriting the page's content stream, and a paragraph is the smallest
 * block that can be re-wrapped without disturbing anything around it.
 *
 * The original glyphs stay in the file underneath the cover, so pages holding
 * an edit are re-rendered as images on save — see exportAnnotated. That is what
 * makes the replaced words actually go away.
 */

const pageParaCache = new Map();

function forgetPageParagraphs() {
  pageParaCache.clear();
}

function pageParagraphs(index) {
  if (pageParaCache.has(index)) return pageParaCache.get(index);
  const p = state.pages[index];
  if (!p) return Promise.resolve([]);
  const job = PSExtract.extractPage(p.page, index, {})
    .then((d) => d.paragraphs.filter((q) => q.text.trim() && !q.invisible))
    .catch(() => []);
  pageParaCache.set(index, job);
  return job;
}

/** The smallest paragraph under the pointer, so a caption inside a block wins. */
function paragraphAt(list, x, y) {
  let best = null;
  for (const q of list) {
    if (x < q.x || x > q.x + q.w || y < q.y || y > q.y + q.h) continue;
    if (!best || q.w * q.h < best.w * best.h) best = q;
  }
  return best;
}

// Embedded fonts are usually subsets, and a subset carries a six-letter tag in
// front of its real name — "ABCDEF+Arial-BoldMT". The tag is noise to a reader.
function cleanFontName(name) {
  if (!name) return '';
  return String(name).replace(/^[A-Z]{6}\+/, '').replace(/[_-]+/g, ' ').trim();
}

// pdf.js reports the family only as a name, and the standard PDF fonts are the
// only ones that can be embedded without a font toolkit, so the typeface is
// matched by kind rather than by name.
function familyFor(para) {
  if (para.mono) return 'mono';
  if (para.serif) return 'serif';
  return 'sans';
}

function liftParagraph(index, para, at) {
  if (para.lifted && state.objects.includes(para.lifted)) {
    select(para.lifted);
    startTextEdit(para.lifted, at);
    return para.lifted;
  }
  // A little slack so ascenders and descenders are covered too.
  const pad = Math.max(1.5, para.size * 0.22);
  const rect = {
    x: Math.max(0, para.x - pad),
    y: Math.max(0, para.y - pad),
    w: para.w + pad * 2,
    h: para.h + pad * 2
  };
  // A block lifted, undone and lifted again must not end up under two covers.
  if (!(para.cover && state.objects.includes(para.cover))) {
    para.cover = addObject({
      type: 'cover', pageIndex: index,
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      color: sampleBackdrop(index, rect)
    });
  }
  const obj = addObject({
    type: 'text', pageIndex: index, fromPage: true,
    x: para.x, y: para.y,
    w: Math.max(40, para.w + 2),
    h: Math.max(para.size * 1.25, para.h),
    text: para.text,
    size: para.size,
    color: para.color || '#000000',
    bold: !!para.bold,
    italic: !!para.italic,
    family: familyFor(para),
    align: para.align || 'left',
    leading: para.leading || 1.2,
    origin: cleanFontName(para.font)
  });
  para.lifted = obj;
  setTool('select');
  select(obj);
  startTextEdit(obj, at);
  return obj;
}

async function pickTextAt(pi, bx, by, at) {
  const list = await pageParagraphs(pi);
  const para = list.length ? paragraphAt(list, bx, by) : null;
  if (!para) return false;
  liftParagraph(pi, para, at);
  return true;
}

/** Outline every editable paragraph while the Edit text tool is active. */
async function markPageParagraphs(pi) {
  const p = state.pages[pi];
  if (!p || !p.overlay) return;
  const list = await pageParagraphs(pi);
  if (state.tool !== 'edittext') return;
  clearTextMarks(pi);
  const S = curScale();
  for (const para of list) {
    if (para.lifted && state.objects.includes(para.lifted)) continue;
    const el = document.createElement('div');
    el.className = 'txtpick';
    el.style.left = (para.x * S) + 'px';
    el.style.top = (para.y * S) + 'px';
    el.style.width = (para.w * S) + 'px';
    el.style.height = (para.h * S) + 'px';
    el.title = 'Click to edit this paragraph';
    el.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      liftParagraph(pi, para, { clientX: ev.clientX, clientY: ev.clientY });
    });
    p.overlay.appendChild(el);
  }
}

function clearTextMarks(pi) {
  const pages = pi == null ? state.pages : [state.pages[pi]];
  for (const p of pages) {
    if (!p || !p.overlay) continue;
    for (const el of p.overlay.querySelectorAll('.txtpick')) el.remove();
  }
}

function refreshTextMarks() {
  clearTextMarks();
  if (state.tool !== 'edittext') return;
  for (const p of state.pages) if (p.visible) markPageParagraphs(p.index);
}

/** Pages carrying an edit to text that was already in the document. */
function editedTextPages() {
  const set = new Set();
  for (const o of state.objects) if (o.fromPage && o.type === 'text') set.add(o.pageIndex);
  return Array.from(set).sort((a, b) => a - b);
}

async function onOverlayDoubleClick(ev, pi) {
  if (state.tool !== 'select' && state.tool !== 'pictures' && state.tool !== 'edittext') return;
  const p = state.pages[pi];
  if (!p) return;
  const S = curScale();
  const rect = p.overlay.getBoundingClientRect();
  const bx = (ev.clientX - rect.left) / S;
  const by = (ev.clientY - rect.top) / S;
  // Text is tried first: it is the smaller, more specific target, and a
  // paragraph sitting on top of a background picture is what was meant.
  const at = { clientX: ev.clientX, clientY: ev.clientY };
  if (state.tool !== 'pictures' && await pickTextAt(pi, bx, by, at)) return;
  if (await pickImageAt(pi, bx, by)) return;
  showBanner('Nothing to edit there. Press E to outline the paragraphs on the page, ' +
             'or P to outline the pictures.', 'info');
}

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
      } else {
        line = cand;
      }
      // A token wider than the box has to be broken even when it starts a line.
      while (measure(line) > maxW && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > maxW) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
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

function drawShapeToPdf(page, vp1, o) {
  const stroke = hexToRgb01(o.stroke);
  const fill = hexToRgb01(o.fill);
  const b = pdfBox(vp1, o.x, o.y, o.w, o.h);
  if (o.kind === 'rect') {
    page.drawRectangle({
      x: b.L, y: b.B, width: b.R - b.L, height: b.T - b.B,
      borderColor: stroke, borderWidth: o.width,
      color: o.filled ? fill : undefined
    });
  } else if (o.kind === 'ellipse') {
    page.drawEllipse({
      x: (b.L + b.R) / 2, y: (b.B + b.T) / 2,
      xScale: Math.max(0.5, (b.R - b.L) / 2), yScale: Math.max(0.5, (b.T - b.B) / 2),
      borderColor: stroke, borderWidth: o.width,
      color: o.filled ? fill : undefined
    });
  } else {
    const p = linePoints(o);
    const start = vp1.convertToPdfPoint(o.x + p.x1, o.y + p.y1);
    const end = vp1.convertToPdfPoint(o.x + p.x2, o.y + p.y2);
    page.drawLine({
      start: { x: start[0], y: start[1] }, end: { x: end[0], y: end[1] },
      thickness: o.width, color: stroke, lineCap: LineCapStyle.Round
    });
    if (o.kind === 'arrow') {
      const size = Math.max(6, o.width * 3.2);
      const head = arrowHead(p, size);
      for (const h of head) {
        const hp = vp1.convertToPdfPoint(o.x + h.x, o.y + h.y);
        page.drawLine({
          start: { x: end[0], y: end[1] }, end: { x: hp[0], y: hp[1] },
          thickness: o.width, color: stroke, lineCap: LineCapStyle.Round
        });
      }
    }
  }
}

/**
 * A real /Text annotation, so sticky notes open as popups in any PDF reader
 * instead of being flattened into the page.
 */
function addNoteAnnotation(doc, page, vp1, o) {
  const b = pdfBox(vp1, o.x, o.y, o.w, o.h);
  const rect = doc.context.obj([b.L, b.B, b.L + 20, b.B + 20]);
  const annot = doc.context.obj({});
  annot.set(PDFName.of('Type'), PDFName.of('Annot'));
  annot.set(PDFName.of('Subtype'), PDFName.of('Text'));
  annot.set(PDFName.of('Name'), PDFName.of('Comment'));
  annot.set(PDFName.of('Rect'), rect);
  annot.set(PDFName.of('Contents'), PDFString.of(o.text || ''));
  annot.set(PDFName.of('T'), PDFString.of('PDF Studio'));
  annot.set(PDFName.of('C'), doc.context.obj([1, 0.84, 0.4]));
  annot.set(PDFName.of('F'), PDFNumber.of(4));
  const ref = doc.context.register(annot);

  let annots = page.node.get(PDFName.of('Annots'));
  if (annots && annots instanceof PDFLib.PDFRef) annots = doc.context.lookup(annots);
  if (!annots || typeof annots.push !== 'function') {
    annots = PDFArray.withContext(doc.context);
    page.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(ref);
}

// How far in from the left edge a line starts, for the alignment a lifted
// paragraph was written with.
function alignOffset(align, avail, lineWidth) {
  if (align === 'center') return Math.max(0, (avail - lineWidth) / 2);
  if (align === 'right') return Math.max(0, avail - lineWidth);
  return 0;
}

const CSS_FAMILY = {
  serif: 'Times New Roman, Times, serif',
  mono: 'Consolas, Courier New, monospace',
  sans: 'Helvetica, Arial, sans-serif'
};

async function drawTextToPdf(srcDoc, page, fonts, vp1, rot, o) {
  const color = hexToRgb01(o.color);
  const size = o.size;
  const lh = size * (o.leading || 1.25);
  const font = await fonts.for(o.family || 'sans', o.bold, o.italic);
  let vector = rot === 0;
  if (vector) {
    try { font.widthOfTextAtSize(o.text.replace(/\n/g, ' '), size); }
    catch (e) { vector = false; }
  }
  if (vector) {
    const avail = Math.max(8, o.w - 2);
    const lines = wrapLines(o.text, avail, (s2) => font.widthOfTextAtSize(s2, size));
    const b = pdfBox(vp1, o.x, o.y, o.w, o.h);
    const asc = size * 0.8;
    lines.forEach((ln, i) => {
      if (!ln) return;
      const dx = alignOffset(o.align, avail, font.widthOfTextAtSize(ln, size));
      page.drawText(ln, { x: b.L + 1 + dx, y: b.T - asc - i * lh, size, font, color });
    });
    return;
  }
  // Raster fallback: non-Latin text (e.g. বাংলা) or rotated pages — rendered by
  // the browser's own fonts at 3x, embedded as a transparent PNG. The standard
  // PDF fonts only cover WinAnsi, and embedding the document's own font would
  // need a font toolkit this extension does not bundle.
  const SC = 3;
  const mc = document.createElement('canvas');
  let mctx = mc.getContext('2d');
  const weight = (o.bold ? '700 ' : '') + (o.italic ? 'italic ' : '');
  const fontCss = weight + (size * SC) + 'px ' + (CSS_FAMILY[o.family] || CSS_FAMILY.sans);
  mctx.font = fontCss;
  const avail = Math.max(8, o.w - 2);
  const lines = wrapLines(o.text, avail, (s2) => mctx.measureText(s2).width / SC);
  const hUnits = Math.max(lh, lines.length * lh);
  mc.width = Math.max(2, Math.ceil(o.w * SC));
  mc.height = Math.max(2, Math.ceil(hUnits * SC));
  mctx = mc.getContext('2d');
  mctx.font = fontCss;
  mctx.fillStyle = o.color;
  mctx.textBaseline = 'top';
  lines.forEach((ln, i) => {
    if (!ln) return;
    const dx = alignOffset(o.align, avail, mctx.measureText(ln).width / SC);
    mctx.fillText(ln, (1 + dx) * SC, (i * lh + size * 0.1) * SC);
  });
  const img = await srcDoc.embedPng(mc.toDataURL('image/png'));
  const b = pdfBox(vp1, o.x, o.y, o.w, hUnits);
  const anchor = anchorFor(rot, b);
  page.drawImage(img, { x: anchor[0], y: anchor[1], width: o.w, height: hUnits, rotate: degrees(rot) });
}

function drawStampToPdf(page, font, vp1, rot, o) {
  const b = pdfBox(vp1, o.x, o.y, o.w, o.h);
  const color = hexToRgb01(o.color);
  const size = o.h * 0.42;
  page.drawRectangle({
    x: b.L, y: b.B, width: b.R - b.L, height: b.T - b.B,
    borderColor: color, borderWidth: Math.max(1.2, o.h * 0.06), opacity: 0, borderOpacity: 0.88
  });
  const text = String(o.text).replace(/[^\x20-\x7E]/g, '');
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: b.L + Math.max(2, ((b.R - b.L) - w) / 2),
    y: b.B + ((b.T - b.B) - size * 0.72) / 2,
    size, font, color, opacity: 0.88
  });
}

/**
 * Bake every annotation into a copy of the document.
 *
 * Redactions are handled last and differently: the pages holding them are
 * re-rendered as images with the boxes burned in, because painting a black
 * rectangle over text leaves the text sitting underneath, selectable.
 */
async function exportAnnotated(opts) {
  if (state.locked) {
    throw new Error(
      'this document is still encrypted, so it cannot be rewritten. Use Workbench → Security ' +
      '→ Remove a password first.'
    );
  }
  const o = Object.assign({ applyRedactions: true, redactDpi: 200 }, opts);
  const srcDoc = await PDFDocument.load(state.bytes, { ignoreEncryption: true });
  // Only the fourteen standard fonts can be embedded without a font toolkit,
  // so a lifted paragraph is matched by kind — serif, monospace or sans — and
  // by weight and slope, rather than by the name it carried in the document.
  const FONT_TABLE = {
    sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold,
           StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
    serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold,
            StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
    mono: [StandardFonts.Courier, StandardFonts.CourierBold,
           StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique]
  };
  const fontCache = new Map();
  const fontFor = async (family, bold, italic) => {
    const fam = FONT_TABLE[family] ? family : 'sans';
    const key = fam + (bold ? 'b' : '') + (italic ? 'i' : '');
    if (fontCache.has(key)) return fontCache.get(key);
    const f = await srcDoc.embedFont(FONT_TABLE[fam][(bold ? 1 : 0) + (italic ? 2 : 0)]);
    fontCache.set(key, f);
    return f;
  };
  const fonts = {
    regular: await fontFor('sans', false, false),
    bold: await fontFor('sans', true, false),
    italic: await fontFor('sans', false, true),
    boldItalic: await fontFor('sans', true, true),
    for: fontFor
  };
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

  const redactBoxes = {};
  for (const obj of state.objects) {
    const page = pdfPages[obj.pageIndex];
    const pinfo = state.pages[obj.pageIndex];
    if (!page || !pinfo) continue;
    const vp1 = pinfo.viewport1;
    const rot = normRot(page.getRotation().angle);

    if (obj.type === 'ink') {
      drawInkToPdf(page, vp1, obj);
    } else if (obj.type === 'cover') {
      const b = pdfBox(vp1, obj.x, obj.y, obj.w, obj.h);
      page.drawRectangle({
        x: b.L, y: b.B, width: b.R - b.L, height: b.T - b.B,
        color: hexToRgb01(safeColor(obj.color, '#ffffff'))
      });
    } else if (obj.type === 'whiteout') {
      const b = pdfBox(vp1, obj.x, obj.y, obj.w, obj.h);
      page.drawRectangle({ x: b.L, y: b.B, width: b.R - b.L, height: b.T - b.B, color: rgb(1, 1, 1) });
    } else if (obj.type === 'redact') {
      const b = pdfBox(vp1, obj.x, obj.y, obj.w, obj.h);
      page.drawRectangle({ x: b.L, y: b.B, width: b.R - b.L, height: b.T - b.B, color: rgb(0, 0, 0) });
      (redactBoxes[obj.pageIndex] = redactBoxes[obj.pageIndex] || [])
        .push({ x: obj.x, y: obj.y, w: obj.w, h: obj.h, color: '#000000' });
    } else if (obj.type === 'highlight') {
      const b = pdfBox(vp1, obj.x, obj.y, obj.w, obj.h);
      page.drawRectangle({
        x: b.L, y: b.B, width: b.R - b.L, height: b.T - b.B,
        color: hexToRgb01(obj.color), opacity: obj.opacity
      });
    } else if (obj.type === 'shape') {
      drawShapeToPdf(page, vp1, obj);
    } else if (obj.type === 'note') {
      addNoteAnnotation(srcDoc, page, vp1, obj);
    } else if (obj.type === 'stamp') {
      drawStampToPdf(page, fonts.bold, vp1, rot, obj);
    } else if (obj.type === 'image' || obj.type === 'sig') {
      const img = await embed(obj.url);
      const b = pdfBox(vp1, obj.x, obj.y, obj.w, obj.h);
      const anchor = anchorFor(rot, b);
      page.drawImage(img, { x: anchor[0], y: anchor[1], width: obj.w, height: obj.h, rotate: degrees(rot) });
    } else if (obj.type === 'text') {
      await drawTextToPdf(srcDoc, page, fonts, vp1, rot, obj);
    }
  }

  let bytes = await srcDoc.save({ useObjectStreams: true });

  // Redaction and editing the document's own text both need the page turned
  // into a picture. Covering something does not remove it: the redacted content
  // and the words that were replaced are still in the byte stream underneath,
  // recoverable by any reader that looks. Re-rendering is what removes them.
  const burnIn = new Set();
  if (o.applyRedactions !== false) {
    for (const k of Object.keys(redactBoxes)) burnIn.add(Number(k));
  }
  if (o.flattenEdits !== false) {
    for (const i of editedTextPages()) burnIn.add(i);
  }
  if (burnIn.size) {
    bytes = await PSDocOps.rasterizePages(bytes, {
      pages: Array.from(burnIn).sort((a, b) => a - b),
      dpi: o.redactDpi,
      quality: 0.94,
      boxes: redactBoxes
    });
  }
  return bytes;
}

btnDownload.addEventListener('click', async () => {
  if (!state.doc) return;
  const orig = btnDownload.textContent;
  btnDownload.disabled = true;
  btnDownload.textContent = 'Preparing…';
  try {
    const hasRedactions = state.objects.some((o) => o.type === 'redact');
    const editedPages = editedTextPages();
    const subject = hasRedactions && editedPages.length
      ? 'This document has redactions, and text you edited in place.'
      : hasRedactions
        ? 'This document has redactions.'
        : 'You have edited text that was already in this document.';
    if ((hasRedactions || editedPages.length) && !window.confirm(
      subject + '\n\nThose pages will be re-rendered as images, so the covered and ' +
      'replaced words genuinely stop existing rather than sitting under a box. Text ' +
      'on those pages stops being selectable, and the file gets larger.\n\nContinue?'
    )) {
      btnDownload.textContent = orig;
      btnDownload.disabled = false;
      return;
    }
    const bytes = await exportAnnotated();
    downloadBytes(bytes, suffixName(state.name, state.objects.length ? '-edited' : ''));
  } catch (err) {
    showBanner('Export failed: ' + ((err && err.message) || err));
  }
  btnDownload.textContent = orig;
  btnDownload.disabled = false;
});

/* ============================== search ============================== */

async function pageSearchData(index) {
  if (state.search.cache.has(index)) return state.search.cache.get(index);
  const p = state.pages[index];
  const { items } = await PSExtract.pageItems(p.page);
  const { lines } = PSExtract.groupLines(items);
  const entries = lines.map((line) => {
    let text = '';
    const map = [];
    let prev = null;
    for (const it of line.items) {
      // Skip pdf.js's synthetic gap-spanning blanks; they carry no glyphs and
      // their width would distort the highlight rectangle.
      if (!it.str.trim()) continue;
      if (prev) {
        const gap = it.x - (prev.x + prev.w);
        if (gap > it.size * 0.16) { text += ' '; map.push(null); }
      }
      for (let c = 0; c < it.str.length; c++) {
        text += it.str[c];
        map.push({ item: it, offset: c, len: it.str.length });
      }
      prev = it;
    }
    return { text, map, line };
  });
  state.search.cache.set(index, entries);
  return entries;
}

function rectForMatch(entry, start, end) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = start; i < end; i++) {
    const m = entry.map[i];
    if (!m) continue;
    const per = m.item.w / Math.max(1, m.len);
    const x0 = m.item.x + per * m.offset;
    minX = Math.min(minX, x0);
    maxX = Math.max(maxX, x0 + per);
    minY = Math.min(minY, m.item.y);
    maxY = Math.max(maxY, m.item.y + m.item.h);
  }
  if (minX === Infinity) {
    return { x: entry.line.x, y: entry.line.y, w: entry.line.w, h: entry.line.h };
  }
  return { x: minX, y: minY, w: Math.max(2, maxX - minX), h: Math.max(4, maxY - minY) };
}

// A search runs page by page with yields in between, so a newer one can start
// while an older is still walking. Results accumulate locally and are only
// published while this run is still the current one.
let searchRun = 0;

async function runSearch(term, matchCase) {
  const run = ++searchRun;
  clearSearchHits();
  state.search.term = term;
  state.search.hits = [];
  state.search.index = -1;
  const resultsEl = $('#search-results');
  resultsEl.textContent = '';
  if (!state.doc || !term || term.length < 2) {
    $('#search-count').textContent = '';
    return;
  }
  $('#search-count').textContent = 'searching…';
  const needle = matchCase ? term : term.toLowerCase();
  const hits = [];

  for (let i = 0; i < state.pages.length; i++) {
    const entries = await pageSearchData(i);
    if (run !== searchRun) return;
    for (const entry of entries) {
      const hay = matchCase ? entry.text : entry.text.toLowerCase();
      let from = 0;
      for (;;) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        hits.push({
          pageIndex: i,
          rect: rectForMatch(entry, at, at + needle.length),
          preview: entry.text,
          at,
          len: needle.length
        });
        from = at + needle.length;
      }
    }
    $('#search-count').textContent = hits.length + ' so far…';
    await new Promise((r) => setTimeout(r, 0));
    if (run !== searchRun) return;
  }

  state.search.hits = hits;
  $('#search-count').textContent = hits.length
    ? hits.length + ' match' + (hits.length === 1 ? '' : 'es')
    : 'no matches';
  renderSearchResults();
  paintSearchHits();
  if (hits.length) gotoHit(0);
}

function renderSearchResults() {
  const el = $('#search-results');
  el.textContent = '';
  state.search.hits.slice(0, 400).forEach((hit, i) => {
    const b = document.createElement('button');
    b.className = 'result-item';
    b.dataset.hit = i;
    const before = hit.preview.slice(Math.max(0, hit.at - 28), hit.at);
    const match = hit.preview.substr(hit.at, hit.len);
    const after = hit.preview.substr(hit.at + hit.len, 34);
    b.innerHTML = '<span class="rpage">p.' + (hit.pageIndex + 1) + '</span> ' +
      escapeText(before) + '<mark>' + escapeText(match) + '</mark>' + escapeText(after);
    b.addEventListener('click', () => gotoHit(i));
    el.appendChild(b);
  });
}

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clearSearchHits() {
  for (const el of $$('.find-hit')) el.remove();
}

function paintSearchHits() {
  clearSearchHits();
  const S = curScale();
  state.search.hits.forEach((hit, i) => {
    const p = state.pages[hit.pageIndex];
    if (!p) return;
    const el = document.createElement('div');
    el.className = 'find-hit';
    el.dataset.hit = i;
    el.style.left = (hit.rect.x * S) + 'px';
    el.style.top = (hit.rect.y * S) + 'px';
    el.style.width = (hit.rect.w * S) + 'px';
    el.style.height = (hit.rect.h * S) + 'px';
    p.wrap.appendChild(el);
  });
}

function positionSearchHits() {
  const S = curScale();
  for (const el of $$('.find-hit')) {
    const hit = state.search.hits[Number(el.dataset.hit)];
    if (!hit) continue;
    el.style.left = (hit.rect.x * S) + 'px';
    el.style.top = (hit.rect.y * S) + 'px';
    el.style.width = (hit.rect.w * S) + 'px';
    el.style.height = (hit.rect.h * S) + 'px';
  }
}

function gotoHit(i) {
  const hits = state.search.hits;
  if (!hits.length) return;
  state.search.index = ((i % hits.length) + hits.length) % hits.length;
  const hit = hits[state.search.index];
  for (const el of $$('.find-hit')) {
    el.classList.toggle('current', Number(el.dataset.hit) === state.search.index);
  }
  for (const el of $$('.result-item')) {
    el.classList.toggle('active', Number(el.dataset.hit) === state.search.index);
  }
  const p = state.pages[hit.pageIndex];
  if (p) {
    const S = curScale();
    const top = p.wrap.offsetTop + hit.rect.y * S - viewerEl.clientHeight / 3;
    viewerEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    setCurrentPage(hit.pageIndex + 1);
  }
}

let searchTimer = null;
$('#search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    runSearch($('#search-input').value.trim(), $('#search-case').checked);
  }, 280);
});
$('#search-case').addEventListener('change', () => {
  runSearch($('#search-input').value.trim(), $('#search-case').checked);
});
$('#search-next').addEventListener('click', () => gotoHit(state.search.index + 1));
$('#search-prev').addEventListener('click', () => gotoHit(state.search.index - 1));

/* ============================== toolbar & inputs ============================== */

for (const b of toolBtns) {
  b.addEventListener('click', () => {
    if (!needDoc()) return;
    setTool(b.dataset.tool);
  });
}

textSizeInput.addEventListener('input', () => {
  // parseFloat, not parseInt: text lifted off a page is very often a fractional
  // size such as 10.8pt, and truncating it changed the size the moment the box
  // was touched. An empty or half-typed field is left alone rather than being
  // read as 16, so the field can be cleared and retyped.
  const raw = parseFloat(textSizeInput.value);
  if (!isFinite(raw)) return;
  const v = clamp(raw, 6, 144);
  state.textDefaults.size = v;
  const sel = state.selection;
  if (sel && sel.type === 'text') { sel.size = v; applyObjectLayout(sel); }
});
textColorInput.addEventListener('input', () => {
  state.textDefaults.color = textColorInput.value;
  const sel = state.selection;
  if (sel && sel.type === 'text') { sel.color = textColorInput.value; applyObjectLayout(sel); }
});
textBoldInput.addEventListener('change', () => {
  state.textDefaults.bold = textBoldInput.checked;
  const sel = state.selection;
  if (sel && sel.type === 'text') { sel.bold = textBoldInput.checked; applyObjectLayout(sel); }
});
textFamilyInput.addEventListener('change', () => {
  const sel = state.selection;
  if (sel && sel.type === 'text') {
    sel.family = textFamilyInput.value;
    applyObjectLayout(sel);
  }
});

textItalicInput.addEventListener('change', () => {
  state.textDefaults.italic = textItalicInput.checked;
  const sel = state.selection;
  if (sel && sel.type === 'text') { sel.italic = textItalicInput.checked; applyObjectLayout(sel); }
});
penSizeInput.addEventListener('input', () => {
  state.pen.size = parseFloat(penSizeInput.value) || 3;
});
penColorInput.addEventListener('input', () => {
  state.pen.color = penColorInput.value;
});
hlColorInput.addEventListener('change', () => { state.highlight.color = hlColorInput.value; });
hlOpacityInput.addEventListener('input', () => {
  state.highlight.opacity = (parseInt(hlOpacityInput.value, 10) || 38) / 100;
});
shapeKindInput.addEventListener('change', () => { state.shape.kind = shapeKindInput.value; });
shapeStrokeInput.addEventListener('input', () => { state.shape.stroke = shapeStrokeInput.value; });
shapeWidthInput.addEventListener('input', () => {
  state.shape.width = parseFloat(shapeWidthInput.value) || 2;
});
shapeFillInput.addEventListener('input', () => { state.shape.fill = shapeFillInput.value; });
shapeFilledInput.addEventListener('change', () => { state.shape.filled = shapeFilledInput.checked; });

btnUndoStroke.addEventListener('click', undo);
btnDeleteObj.addEventListener('click', () => {
  if (state.selection) deleteObject(state.selection.id);
});
btnDuplicateObj.addEventListener('click', () => duplicateObject(state.selection));

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

const SHORTCUTS = [
  ['V', 'Select and move'], ['T', 'Text box'], ['D', 'Freehand pen'],
  ['H', 'Highlighter'], ['R', 'Shapes'], ['W', 'Whiteout'], ['X', 'Redact'],
  ['N', 'Sticky note'], ['S', 'Signature'], ['M', 'Stamp'], ['I', 'Insert an image'],
  ['P', 'Edit a picture already in the document'],
  ['E', 'Edit text already in the document'],
  ['Ctrl + O', 'Open a PDF'], ['Ctrl + S', 'Save the PDF'], ['Ctrl + F', 'Find in document'],
  ['Ctrl + Z', 'Undo the last addition'], ['Ctrl + D', 'Duplicate the selection'],
  ['Delete', 'Remove the selection'], ['Esc', 'Cancel / deselect'],
  ['F4', 'Show or hide the side panel'], ['F5', 'Presentation mode'],
  ['Ctrl + +', 'Zoom in'], ['Ctrl + −', 'Zoom out'], ['Ctrl + 0', 'Fit width'],
  ['Page Up / Down', 'Previous / next page'], ['?', 'This list']
];

function buildShortcuts() {
  const el = $('#keys-list');
  el.textContent = '';
  for (const [key, label] of SHORTCUTS) {
    const row = document.createElement('div');
    const name = document.createElement('span');
    name.textContent = label;
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    row.appendChild(name);
    row.appendChild(kbd);
    el.appendChild(row);
  }
}
buildShortcuts();
$('#keys-close').addEventListener('click', () => closeModal(keysModal));

document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t && (t.isContentEditable || t.tagName === 'INPUT' ||
                       t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
  const openModalEl = $$('.modal-wrap').find((m) => !m.classList.contains('hidden'));

  if (e.key === 'Escape') {
    if (state.present) { setPresent(false); return; }
    if (openModalEl && openModalEl !== pwModal) { closeModal(openModalEl); return; }
    if (typing) { t.blur(); return; }
    clearSelection();
    setTool('select');
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); pdfInput.click(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); btnDownload.click(); return; }
  if (mod && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    sidebarEl.classList.remove('collapsed');
    showSidePanel('panel-search');
    $('#search-input').focus();
    return;
  }
  if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); setZoom(state.zoom * 1.15); return; }
  if (mod && e.key === '-') { e.preventDefault(); setZoom(state.zoom / 1.15); return; }
  if (mod && e.key === '0') { e.preventDefault(); updateFitScale(); setZoom(1); return; }

  if (typing) {
    if (e.key === 'Enter' && t.id === 'search-input') {
      e.preventDefault();
      gotoHit(state.search.index + (e.shiftKey ? -1 : 1));
    }
    return;
  }
  if (openModalEl) return;

  if (e.key === 'F4') { e.preventDefault(); $('#btn-sidebar').click(); return; }
  if (e.key === 'F5') { e.preventDefault(); setPresent(!state.present); return; }
  if (e.key === '?') { e.preventDefault(); openModal(keysModal); return; }

  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection) {
    e.preventDefault();
    deleteObject(state.selection.id);
    return;
  }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    duplicateObject(state.selection);
    return;
  }
  if (!state.doc) return;

  if (e.key === 'PageDown') { e.preventDefault(); goToPage(state.currentPage + 1); return; }
  if (e.key === 'PageUp') { e.preventDefault(); goToPage(state.currentPage - 1); return; }
  if (mod) return;

  const k = e.key.toLowerCase();
  if (k === 'v') setTool('select');
  else if (k === 't') setTool('text');
  else if (k === 'd') setTool('draw');
  else if (k === 'h') setTool('highlight');
  else if (k === 'r') setTool('shape');
  else if (k === 'w') setTool('whiteout');
  else if (k === 'x') setTool('redact');
  else if (k === 'n') setTool('note');
  else if (k === 's') btnSignature.click();
  else if (k === 'm') btnStamp.click();
  else if (k === 'i') btnImage.click();
  else if (k === 'p') setTool('pictures');
  else if (k === 'e') setTool('edittext');
});

/* ============================== side panel switching ============================== */

function showSidePanel(id) {
  for (const tab of $$('.side-tab')) tab.classList.toggle('active', tab.dataset.panel === id);
  for (const panel of $$('.side-panel')) panel.classList.toggle('hidden', panel.id !== id);
  document.dispatchEvent(new CustomEvent('ps:panel-shown', { detail: { id } }));
}
for (const tab of $$('.side-tab')) {
  tab.addEventListener('click', () => showSidePanel(tab.dataset.panel));
}

/* ============================== public surface ============================== */

window.PS = {
  state,
  $, $$, clamp,
  formatBytes,
  parseRange,
  suffixName,
  downloadBlob,
  downloadBytes,
  safeFileName,
  showBanner,
  setMeta,
  metaText,
  needDoc,
  openModal,
  closeModal,
  loadBytes,
  exportAnnotated,
  setTool,
  select,
  clearSelection,
  deleteObject,
  goToPage,
  showSidePanel,
  curScale,
  layoutAll,
  renderPage,
  askPassword
};

/* ============================== boot ============================== */

setTool('select');
const srcParam = new URLSearchParams(location.search).get('src');
if (srcParam) loadFromUrl(srcParam);
