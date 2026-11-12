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

function assetUrl(path) {
  return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL
    ? chrome.runtime.getURL(path)
    : path;
}

pdfjsLib.GlobalWorkerOptions.workerSrc = assetUrl('libs/pdf.worker.min.js');
const { PDFDocument, StandardFonts, PDFName, PDFNumber, PDFString, PDFArray,
        rgb, degrees, LineCapStyle, LineJoinStyle, BlendMode } = PDFLib;

/*
 * pdf-lib pauses on a timer while it reads and writes, to keep a page
 * responsive. Chrome holds the timers of a background tab to one a second, so
 * a large document takes minutes to save the moment the user looks away.
 * Reading and writing in one go is quicker in front and immune behind.
 */
const PDF_LOAD = { ignoreEncryption: true, parseSpeed: PDFLib.ParseSpeeds.Fastest };
const PDF_SAVE = { useObjectStreams: true, objectsPerTick: Infinity };

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
const askModal = $('#ask-modal');
const btnUndo = $('#btn-undo');
const btnRedo = $('#btn-redo');

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
  selection: null,
  place: null,        // { kind: 'image'|'sig'|'stamp', ... }
  sig: null,
  currentPage: 1,
  dirty: false,       // something would be lost if the tab closed now
  pen: { size: 3, color: '#16213e' },
  textDefaults: { size: 16, color: '#111318', bold: false, italic: false, family: 'sans' },
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

/** An icon from the sprite in editor.html, as an element. */
function icon(name, extra) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon' + (extra ? ' ' + extra : ''));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.appendChild(use);
  return svg;
}

/*
 * Messages.
 *
 * Each is a small card at the bottom corner of the document. Something that
 * went wrong stays until it is dismissed, because it has to be read; a
 * confirmation or a hint leaves on its own, and waits while the pointer is on
 * it. The same message said twice restarts its clock instead of piling up.
 *
 * `opts.action` — { label, run } — puts a button on the card: "Undo".
 */
const TOAST_LIFE = 6500;
const TOAST_MAX = 4;

function dismissToast(el) {
  if (!el || el.dataset.leaving) return;
  el.dataset.leaving = '1';
  clearTimeout(el.psTimer);
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 200);
}

function showBanner(msg, type, opts) {
  if (!msg) {
    for (const el of Array.from(bannerEl.children)) dismissToast(el);
    return;
  }
  const kind = type === 'ok' ? 'ok' : type === 'info' ? 'info' : 'error';
  for (const el of Array.from(bannerEl.children)) {
    if (el.dataset.msg === msg) el.remove();
  }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.dataset.msg = msg;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.appendChild(icon(kind === 'ok' ? 'check' : kind === 'info' ? 'info' : 'alert'));
  const text = document.createElement('div');
  text.className = 'toast-text';
  text.textContent = msg;
  el.appendChild(text);
  const action = opts && opts.action;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => { dismissToast(el); action.run(); });
    el.appendChild(b);
  }
  const close = document.createElement('button');
  close.className = 'icon-btn';
  close.setAttribute('aria-label', 'Dismiss');
  close.appendChild(icon('x', 'sm'));
  close.addEventListener('click', () => dismissToast(el));
  el.appendChild(close);

  bannerEl.appendChild(el);
  while (bannerEl.children.length > TOAST_MAX) bannerEl.firstElementChild.remove();
  if (kind !== 'error') {
    const life = (opts && opts.life) || TOAST_LIFE;
    const arm = () => { el.psTimer = setTimeout(() => dismissToast(el), life); };
    el.addEventListener('pointerenter', () => clearTimeout(el.psTimer));
    el.addEventListener('pointerleave', arm);
    arm();
  }
}

/*
 * The line at the top says which document is open. Once there is one, its
 * name stands apart from the rest — pages, size — because the name is the one
 * part that can be changed: it is what the saved file will be called.
 */
const docNameEl = $('#doc-name');

function setMeta(text) {
  const named = !!state.doc && text.indexOf(state.name + ' · ') === 0;
  docNameEl.classList.toggle('hidden', !named);
  if (named) {
    docNameEl.textContent = state.name;
    metaEl.textContent = text.slice(state.name.length + 3);
  } else {
    metaEl.textContent = text;
  }
}

docNameEl.addEventListener('click', async () => {
  if (!state.doc) return;
  const typed = await textDialog({
    title: 'File name',
    text: 'The name the PDF is saved under.',
    value: state.name.replace(/\.pdf$/i, ''),
    ok: 'Rename',
    single: true
  });
  const name = typed == null ? '' : typed.trim();
  if (!name) return;
  state.name = safeFileName(/\.pdf$/i.test(name) ? name : name + '.pdf');
  document.title = state.name + ' — PDF Studio';
  setMeta(metaText());
  syncDirty();
});

/*
 * The words on a button. Most buttons are an icon and a label side by side, so
 * "Working…" is written into the label rather than over the whole button —
 * which would take the icon with it, for good.
 */
function buttonLabel(button, text) {
  const holder = button.querySelector('span') || button;
  if (text === undefined) return holder.textContent;
  holder.textContent = text;
  return text;
}

/** A thin moving line under the app bar while something slow is going on. */
let busyCount = 0;
function setBusy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  document.body.classList.toggle('busy', busyCount > 0);
}

/** Keep the unsaved-changes mark, on the page and in the tab, in step. */
function syncDirty() {
  document.body.dataset.dirty = state.dirty ? 'true' : 'false';
  if (state.doc) document.title = (state.dirty ? '• ' : '') + state.name + ' — PDF Studio';
}

function setDirty(value) {
  state.dirty = !!value;
  syncDirty();
}

function needDoc() {
  if (state.doc) return true;
  showBanner('Open a PDF first — drop one anywhere on this page or use "Open".', 'info');
  return false;
}

const TOOL_HINTS = {
  select: 'Click anything you added to move or resize it · double-click text or a picture on the page to edit it',
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
  hintEl.textContent = state.doc ? (TOOL_HINTS[t] || '') : 'Open a PDF to start — drop one anywhere, or press Ctrl+O';
  refreshImageMarks();
  refreshTextMarks();
  updateCtx();
}

function updateCtx() {
  const sel = state.selection;
  const kind = sel ? sel.type : '';
  // The controls for a kind of mark show while its tool is in hand and while
  // one of its marks is selected — so a shape's colour can be changed after
  // it has been drawn, not only before.
  ctxText.classList.toggle('hidden', !(state.tool === 'text' || kind === 'text'));
  ctxPen.classList.toggle('hidden', !(state.tool === 'draw' || kind === 'ink'));
  ctxHighlight.classList.toggle('hidden', !(state.tool === 'highlight' || kind === 'highlight'));
  ctxShape.classList.toggle('hidden', !(state.tool === 'shape' || kind === 'shape'));
  btnDeleteObj.classList.toggle('hidden', !sel);
  btnDuplicateObj.classList.toggle('hidden', !sel || sel.type === 'ink');
  btnReplaceImg.classList.toggle('hidden', !sel || (sel.type !== 'image' && sel.type !== 'sig'));
  if (kind === 'shape') {
    shapeKindInput.value = sel.kind;
    shapeStrokeInput.value = safeColor(sel.stroke, '#d92d20');
    shapeWidthInput.value = sel.width;
    shapeFillInput.value = safeColor(sel.fill, '#ffffff');
    shapeFilledInput.checked = !!sel.filled;
  } else if (kind === 'highlight') {
    hlColorInput.value = sel.color;
    hlOpacityInput.value = Math.round(sel.opacity * 100);
    paintChips(hlColorInput, $('#hl-chips'));
  }
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
  if (state.doc && state.dirty && !(await confirmDialog({
    title: 'Open another PDF?',
    text: 'The changes you have not saved in this one will be lost.',
    ok: 'Open it',
    danger: true
  }))) return;
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
  setBusy(true);
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
  } finally {
    setBusy(false);
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

/**
 * @param {object} [opts] { dirty } — set when the bytes are the product of
 *                        work in this tab rather than a file as it was opened
 */
async function loadBytes(bytes, name, opts) {
  setBusy(true);
  try {
    return await openBytes(bytes, name, opts);
  } finally {
    setBusy(false);
  }
}

async function openBytes(bytes, name, opts) {
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
  for (const p of state.pages) {
    if (p.renderTask) { try { p.renderTask.cancel(); } catch (e) { /* already done */ } }
    PSExtract.releaseCanvas(p.canvas);
    PSExtract.releaseCanvas(p.ink);
  }
  renderQueue.wanted.clear();
  state.bytes = bytes;
  state.name = name || 'document.pdf';
  state.doc = doc;
  state.objects = [];
  forgetPageImages();
  forgetPageParagraphs();
  resetHistory();
  setDirty(opts && opts.dirty);
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
      'Tools → Protect → Remove a password to rebuild it as an unprotected copy.');
  } else if (state.wasProtected) {
    showBanner('This document was password-protected. It has been unlocked for editing — use ' +
      'Tools → Protect to protect the copy you save.', 'info');
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
  const doc = state.doc;
  const n = doc.numPages;
  let maxW = 0;
  // Asked for a batch at a time: each request is a round trip to the worker,
  // and a thousand of them one after another is a noticeable wait.
  for (let first = 1; first <= n; first += 64) {
    const batch = [];
    for (let i = first; i <= Math.min(n, first + 63); i++) batch.push(doc.getPage(i));
    const pages = await Promise.all(batch);
    pages.forEach((page, k) => {
      const viewport1 = page.getViewport({ scale: 1 });
      maxW = Math.max(maxW, viewport1.width);
      state.pages.push({
        index: first - 1 + k, page, viewport1,
        wrap: null, canvas: null, ink: null, overlay: null,
        renderedKey: null, renderTask: null, visible: false
      });
    });
    if (n > 256) setMeta('Opening… ' + Math.min(n, first + 63) + ' of ' + n + ' pages');
  }
  updateFitScale(maxW);

  state.io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const idx = Number(en.target.dataset.index);
      const p = state.pages[idx];
      if (!p) continue;
      p.visible = en.isIntersecting;
      if (en.isIntersecting) {
        requestRender(idx);
        redrawInk(idx);
        if (state.tool === 'pictures') markPageImages(idx);
        if (state.tool === 'edittext') markPageParagraphs(idx);
      } else {
        scheduleEviction();
      }
    }
    syncCurrentPage();
  }, { root: viewerEl, rootMargin: '600px 0px', threshold: [0, 0.45] });

  const fragment = document.createDocumentFragment();
  for (const p of state.pages) {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.index = p.index;

    // Both start empty: a canvas holds memory from the moment it has a size,
    // and most pages of a long document are never scrolled to.
    const canvas = document.createElement('canvas');
    canvas.className = 'page-canvas';
    canvas.width = canvas.height = 0;
    const ink = document.createElement('canvas');
    ink.className = 'ink-canvas';
    ink.width = ink.height = 0;
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
    fragment.appendChild(wrap);
  }
  // Sized before they are observed, so the first report of what is in view is
  // made against pages of the right height rather than a stack of empty ones.
  pagesEl.appendChild(fragment);
  layoutAll();
  for (const p of state.pages) state.io.observe(p.wrap);
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

/*
 * Laying out is immediate and cheap: the pages take their new size and the
 * pictures already drawn are stretched to fit by the stylesheet. Drawing them
 * again at the new size is what costs, so that waits until the size has
 * stopped changing — a zoom by wheel passes through a dozen sizes on the way.
 */
let renderTimer = null;

function layoutAll() {
  const S = curScale();
  for (const p of state.pages) {
    p.wrap.style.width = (p.viewport1.width * S) + 'px';
    p.wrap.style.height = (p.viewport1.height * S) + 'px';
  }
  for (const o of state.objects) applyObjectLayout(o);
  refreshImageMarks();
  refreshTextMarks();
  positionSearchHits();
  zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderVisible, 110);
}

function renderVisible() {
  for (const p of state.pages) {
    if (!p.visible) continue;
    requestRender(p.index);
    redrawInk(p.index);
  }
}

/*
 * How many canvas pixels to give a page point.
 *
 * It follows the zoom and the screen's density, up to a budget: a page at 500%
 * on a dense screen would otherwise ask for a canvas of half a gigabyte. Past
 * the budget the picture is drawn as large as the budget allows and stretched
 * the rest of the way.
 */
const PAGE_PIXEL_BUDGET = (navigator.deviceMemory && navigator.deviceMemory <= 4) ? 9e6 : 16e6;

function pixelScale(p) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let k = curScale() * dpr;
  const area = p.viewport1.width * p.viewport1.height * k * k;
  if (area > PAGE_PIXEL_BUDGET) k *= Math.sqrt(PAGE_PIXEL_BUDGET / area);
  return k;
}

/*
 * Pages are drawn two at a time, nearest the one being read first. Started
 * all at once they share the one thread between them and every page —
 * including the one in front of the reader — arrives late.
 */
const renderQueue = { active: 0, wanted: new Set() };

function requestRender(idx) {
  renderQueue.wanted.add(idx);
  pumpRenders();
}

function pumpRenders() {
  while (renderQueue.active < 2 && renderQueue.wanted.size) {
    let best = -1, bestD = Infinity;
    for (const idx of renderQueue.wanted) {
      const d = Math.abs(idx + 1 - state.currentPage);
      if (d < bestD) { bestD = d; best = idx; }
    }
    renderQueue.wanted.delete(best);
    const p = state.pages[best];
    if (!p || !p.visible) continue;
    renderQueue.active++;
    renderPage(best).then(() => {
      renderQueue.active--;
      pumpRenders();
    });
  }
}

/** What a page's picture depends on: its scale, and which words are hidden. */
function renderKey(p) {
  return pixelScale(p).toFixed(4) + '|' + hiddenTextKey(p.index);
}

/**
 * Draw a page.
 *
 * It is drawn on a canvas of its own and swapped in when finished, so the
 * page never goes blank: until then the old picture stays up, stretched to
 * the new size.
 */
async function renderPage(idx) {
  const p = state.pages[idx];
  if (!p) return;
  const key = renderKey(p);
  if (p.renderedKey === key) return;
  // Already being drawn exactly like this: let it finish rather than start over.
  if (p.renderTask && p.renderingKey === key) return;
  if (p.renderTask) { try { p.renderTask.cancel(); } catch (e) { /* ignore */ } }
  p.renderingKey = key;

  const doc = state.doc;
  const k = pixelScale(p);
  const vp = p.page.getViewport({ scale: k });
  const canvas = document.createElement('canvas');
  canvas.className = 'page-canvas';
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  applyHiddenText(canvas, idx, k);

  const task = p.page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
  p.renderTask = task;
  let done = false;
  try {
    await task.promise;
    done = true;
  } catch (e) { /* cancelled — a newer render owns the page */ }
  if (p.renderTask === task) p.renderTask = null;
  // Another document may have been opened while this was drawing.
  if (!done || state.doc !== doc || state.pages[idx] !== p) {
    PSExtract.releaseCanvas(canvas);
    return;
  }
  const old = p.canvas;
  old.replaceWith(canvas);
  PSExtract.releaseCanvas(old);
  p.canvas = canvas;
  p.renderedKey = key;
  settleHiddenText(idx, canvas);
  // The scale may have moved on while this was being drawn.
  if (p.visible && renderKey(p) !== key) requestRender(idx);
}

/*
 * A long document scrolled from end to end would otherwise keep a full-size
 * picture of every page it passed. Pages that have gone out of view, and are
 * not next to the one being read, give theirs back; they are drawn again if
 * they come back.
 */
let evictionTimer = null;

function scheduleEviction() {
  clearTimeout(evictionTimer);
  evictionTimer = setTimeout(evictFarPages, 1500);
}

function evictFarPages() {
  for (const p of state.pages) {
    if (p.visible || Math.abs(p.index + 1 - state.currentPage) <= 2) continue;
    if (p.renderTask) { try { p.renderTask.cancel(); } catch (e) { /* ignore */ } }
    if (p.canvas.width) {
      PSExtract.releaseCanvas(p.canvas);
      p.renderedKey = null;
      try { p.page.cleanup(); } catch (e) { /* still in use; next time */ }
    }
    if (p.ink.width) PSExtract.releaseCanvas(p.ink);
  }
}

/* ============================== zoom & navigation ============================== */

/**
 * Remember what is under a point of the window — the middle of the viewer
 * unless told otherwise — as a page and a position within it, so the same
 * spot can be put back there after the pages change size.
 */
function captureAnchor(point) {
  if (!state.pages.length) return null;
  const box = viewerEl.getBoundingClientRect();
  const x = point ? point.x : box.left + box.width / 2;
  const y = point ? point.y : box.top + box.height / 2;
  let best = null, bestD = Infinity;
  const near = state.pages.filter((p) => p.visible);
  if (!near.length && state.pages[state.currentPage - 1]) near.push(state.pages[state.currentPage - 1]);
  for (const p of near) {
    const r = p.wrap.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < bestD) { bestD = d; best = { p, r }; }
  }
  if (!best || !best.r.width || !best.r.height) return null;
  return {
    p: best.p, fx: (x - best.r.left) / best.r.width, fy: (y - best.r.top) / best.r.height, x, y,
    // At the very top, with no pointer to zoom about, the top is what is being
    // looked at. Holding the middle instead would creep down the page each time
    // a panel opened and closed again.
    top: !point && viewerEl.scrollTop < 2
  };
}

function restoreAnchor(a) {
  if (!a) return;
  const r = a.p.wrap.getBoundingClientRect();
  viewerEl.scrollLeft += r.left + a.fx * r.width - a.x;
  if (a.top) viewerEl.scrollTop = 0;
  else viewerEl.scrollTop += r.top + a.fy * r.height - a.y;
}

/** Lay out again, keeping what the reader was looking at where it was. */
function relayout(point) {
  const anchor = captureAnchor(point);
  layoutAll();
  restoreAnchor(anchor);
}

function setZoom(z, point) {
  if (!state.doc) return;
  const next = clamp(z, 0.25, 5);
  if (next === state.zoom) return;
  const anchor = captureAnchor(point);
  state.zoom = next;
  layoutAll();
  restoreAnchor(anchor);
}

function fitWidth() {
  if (!state.doc) return;
  const anchor = captureAnchor();
  updateFitScale();
  state.zoom = 1;
  layoutAll();
  restoreAnchor(anchor);
}

/** Zoom so one whole page fits the height of the viewer. */
function fitPage() {
  const p = state.pages[state.currentPage - 1];
  if (!p) return;
  updateFitScale();
  const room = Math.max(120, viewerEl.clientHeight - 56);
  setZoom(room / (p.viewport1.height * state.fitScale));
}

/** Zoom so a point on the page is a point on the screen. */
function actualSize() {
  if (!state.doc) return;
  updateFitScale();
  setZoom((96 / 72) / state.fitScale);
}

$('#zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.15));
$('#zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.15));
$('#zoom-fit').addEventListener('click', fitWidth);
for (const item of $$('#zoom-menu [data-zoom]')) {
  item.addEventListener('click', () => {
    closeMenu();
    const z = item.dataset.zoom;
    if (z === 'fit-width') fitWidth();
    else if (z === 'fit-page') fitPage();
    else if (z === 'actual') actualSize();
    else setZoom(parseFloat(z));
  });
}

// Ctrl + wheel, which is also what a pinch on a trackpad arrives as, zooms
// about the pointer rather than about the top of the document.
viewerEl.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !state.doc) return;
  e.preventDefault();
  setZoom(state.zoom * Math.exp(-e.deltaY * 0.0025), { x: e.clientX, y: e.clientY });
}, { passive: false });

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

/*
 * The page being read is the one under a line a third of the way down the
 * viewer — not whichever page last came near the screen, which on a small
 * zoom is the page after the one in front of the reader. At either end of the
 * document it is the first or the last page, which may never reach that line.
 */
function syncCurrentPage() {
  const near = state.pages.filter((p) => p.visible);
  if (!near.length) return;
  if (viewerEl.scrollTop < 2) { setCurrentPage(near[0].index + 1); return; }
  if (viewerEl.scrollTop + viewerEl.clientHeight >= viewerEl.scrollHeight - 2) {
    setCurrentPage(near[near.length - 1].index + 1);
    return;
  }
  const box = viewerEl.getBoundingClientRect();
  const y = box.top + box.height / 3;
  let best = null, bestD = Infinity;
  for (const p of near) {
    const r = p.wrap.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < bestD) { bestD = d; best = p; }
  }
  if (best) setCurrentPage(best.index + 1);
}

let pageSyncQueued = false;
viewerEl.addEventListener('scroll', () => {
  if (pageSyncQueued) return;
  pageSyncQueued = true;
  requestAnimationFrame(() => { pageSyncQueued = false; syncCurrentPage(); });
}, { passive: true });

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
  resizeTimer = setTimeout(() => { updateFitScale(); relayout(); }, 200);
});

/** Show or hide the side panel; the document takes up or gives back the room. */
function setSidebar(open) {
  sidebarEl.classList.toggle('collapsed', !open);
  for (const tab of $$('.side-tab')) {
    tab.setAttribute('aria-selected', String(open && tab.classList.contains('active')));
  }
  setTimeout(() => { updateFitScale(); relayout(); }, 0);
}
$('#btn-sidebar').addEventListener('click', () => setSidebar(sidebarEl.classList.contains('collapsed')));

/*
 * In a narrow window the side panel floats over the document instead of
 * sitting beside it (the same 980px as in editor.css). There it starts put
 * away, and steps aside again when a wide window is narrowed past that point;
 * opened by hand, it stays until it is closed.
 */
const NARROW_WINDOW = 980;
let wasNarrow = window.innerWidth < NARROW_WINDOW;
if (wasNarrow) setSidebar(false);
window.addEventListener('resize', () => {
  const narrow = window.innerWidth < NARROW_WINDOW;
  if (narrow && !wasNarrow && !sidebarEl.classList.contains('collapsed')) setSidebar(false);
  wasNarrow = narrow;
});

/*
 * Menus: the "more" menu in the app bar and the zoom presets in the dock.
 * One is open at a time; a click anywhere else, Escape, or choosing something
 * closes it.
 */
let openMenu = null;

function closeMenu() {
  if (!openMenu) return;
  openMenu.menu.classList.add('hidden');
  openMenu.button.setAttribute('aria-expanded', 'false');
  openMenu = null;
}

function toggleMenu(button, menu) {
  const again = openMenu && openMenu.menu === menu;
  closeMenu();
  if (again) return;
  menu.classList.remove('hidden');
  button.setAttribute('aria-expanded', 'true');
  openMenu = { button, menu };
}

document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.menu.contains(e.target) && !openMenu.button.contains(e.target)) closeMenu();
});
$('#btn-more').addEventListener('click', () => toggleMenu($('#btn-more'), $('#more-menu')));
$('#zoom-label').addEventListener('click', () => toggleMenu($('#zoom-label'), $('#zoom-menu')));

// The interface theme. Separate from night mode below, which inverts the
// document rather than the interface.
for (const b of $$('[data-theme-set]')) {
  b.addEventListener('click', () => PSTheme.set(b.dataset.themeSet));
}
function paintThemeChoice() {
  for (const b of $$('[data-theme-set]')) {
    b.setAttribute('aria-checked', String(b.dataset.themeSet === PSTheme.mode()));
  }
}
PSTheme.onChange(paintThemeChoice);
paintThemeChoice();

$('#btn-night').addEventListener('click', () => {
  state.night = !state.night;
  document.body.classList.toggle('night', state.night);
  $('#btn-night').classList.toggle('on', state.night);
  $('#btn-night').setAttribute('aria-checked', String(state.night));
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
$('#btn-present').addEventListener('click', () => { closeMenu(); setPresent(!state.present); });
$('#btn-keys').addEventListener('click', () => { closeMenu(); openModal(keysModal); });
$('#quick-keys').addEventListener('click', () => openModal(keysModal));
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && state.present) setPresent(false);
});

/* ============================== objects ============================== */

/*
 * History.
 *
 * Every change to the annotations — adding, deleting, moving, resizing,
 * retyping, recolouring — ends with commit(), which keeps a copy of the whole
 * list. Undo and redo put a copy back. Copies are cheap: the objects are
 * small, and the two heavy things they point at, a picture's data URL and a
 * pen stroke's points, are never changed in place, so every copy shares them.
 */
const history = { stack: [], index: -1, limit: 150 };

function snapshotObjects() {
  return state.objects.map((o) => {
    const copy = Object.assign({}, o);
    delete copy.el;
    return copy;
  });
}

function refreshHistoryButtons() {
  if (btnUndo) btnUndo.disabled = history.index <= 0;
  if (btnRedo) btnRedo.disabled = history.index >= history.stack.length - 1;
}

function resetHistory() {
  history.stack = [snapshotObjects()];
  history.index = 0;
  refreshHistoryButtons();
}

function commit() {
  history.stack.length = history.index + 1;
  history.stack.push(snapshotObjects());
  if (history.stack.length > history.limit) history.stack.shift();
  history.index = history.stack.length - 1;
  setDirty(true);
  refreshHistoryButtons();
  document.dispatchEvent(new CustomEvent('ps:objects-changed'));
}

// A colour picker or a slider reports dozens of values on the way to the one
// that is wanted; they are one step to undo, not dozens.
let commitTimer = null;
function commitSoon() {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(commit, 450);
}

function flushCommit() {
  if (!commitTimer) return;
  clearTimeout(commitTimer);
  commitTimer = null;
  commit();
}

function restoreObjects(snapshot) {
  const wanted = new Map(snapshot.map((o) => [o.id, o]));
  const selectedId = state.selection ? state.selection.id : null;
  clearSelection();
  const inkPages = new Set();
  const live = new Map();
  for (const o of state.objects) {
    if (wanted.has(o.id)) { live.set(o.id, o); continue; }
    if (o.el) o.el.remove();
    if (o.type === 'ink') inkPages.add(o.pageIndex);
  }
  state.objects = snapshot.map((saved) => {
    let o = live.get(saved.id);
    if (o) {
      // The same object, so anything holding on to it still holds the right thing.
      const el = o.el;
      for (const key of Object.keys(o)) delete o[key];
      Object.assign(o, saved);
      if (el) { o.el = el; syncObjectElement(o); }
    } else {
      o = Object.assign({}, saved);
      if (o.type !== 'ink') mountObject(o);
    }
    if (o.type === 'ink') inkPages.add(o.pageIndex);
    return o;
  });
  // Put the elements back in list order: what was added later lies on top.
  for (const o of state.objects) {
    if (!o.el) continue;
    const p = state.pages[o.pageIndex];
    if (p) p.overlay.appendChild(o.el);
    applyObjectLayout(o);
  }
  for (const pi of inkPages) redrawInk(pi);
  refreshHiddenText();
  const again = selectedId != null && state.objects.find((o) => o.id === selectedId && o.el);
  if (again) select(again);
  refreshImageMarks();
  refreshTextMarks();
  setDirty(true);
  refreshHistoryButtons();
  document.dispatchEvent(new CustomEvent('ps:objects-changed'));
}

function undo() {
  flushCommit();
  if (history.index <= 0) return;
  history.index--;
  restoreObjects(history.stack[history.index]);
}

function redo() {
  flushCommit();
  if (history.index >= history.stack.length - 1) return;
  history.index++;
  restoreObjects(history.stack[history.index]);
}

function objectById(id) {
  return id == null ? null : state.objects.find((o) => o.id === id) || null;
}

/**
 * @param {object} [opts] { silent } — add without a history step, for a change
 *                        made of several objects that commits once at the end
 */
function addObject(o, opts) {
  o.id = uid++;
  state.objects.push(o);
  mountObject(o);
  if (!(opts && opts.silent)) commit();
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
  } else if (o.type === 'note') {
    el.textContent = '✎';
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); editNote(o); });
  } else if (o.type === 'stamp') {
    const box = document.createElement('div');
    box.className = 'stamp-box';
    el.appendChild(box);
  }

  el.addEventListener('pointerdown', (e) => beginDrag(e, o));
  o.el = el;
  syncObjectElement(o);
  p.overlay.appendChild(el);
  applyObjectLayout(o);
}

/**
 * Make an object's element show what the object now says: its colour, its
 * picture, its words. Used when it is first mounted and again whenever undo
 * or the toolbar changes it.
 */
function syncObjectElement(o) {
  const el = o.el;
  if (!el) return;
  if (o.type === 'image' || o.type === 'sig') {
    const img = el.querySelector('img');
    if (img && img.getAttribute('src') !== o.url) img.src = o.url;
  } else if (o.type === 'cover') {
    el.style.background = safeColor(o.color, '#ffffff');
    // A cover over words that have really been taken out of the picture has
    // nothing left to hide.
    el.classList.toggle('clean', !!o.clean);
  } else if (o.type === 'highlight') {
    el.style.background = safeColor(o.color, '#ffe14d');
    el.style.opacity = String(o.opacity);
  } else if (o.type === 'note') {
    el.title = o.text || 'Sticky note';
  } else if (o.type === 'stamp') {
    const box = el.querySelector('.stamp-box');
    if (box) { box.textContent = o.text; box.style.color = safeColor(o.color, '#d92d20'); }
  }
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
    t.style.textAlign = o.align === 'center' || o.align === 'right' || o.align === 'justify' ? o.align : '';
    /*
     * Text lifted off the page knows exactly where its first baseline was.
     * The browser puts a first baseline wherever the face's own metrics and
     * the line height happen to land it, which is close but not the same, so
     * the difference is taken up here — and the saved file uses the same
     * figure, so what is shown is what is written.
     */
    const shift = (textRise(o) - domBaselineRatio(o) * o.size) * S;
    t.style.transform = Math.abs(shift) > 0.05 ? 'translateY(' + shift.toFixed(2) + 'px)' : '';
    o.el.style.height = 'auto';
    o.h = Math.max(o.size * 1.25, o.el.offsetHeight / S);
  } else {
    o.el.style.height = (o.h * S) + 'px';
  }
  if (o.type === 'shape') {
    // Only the drawing is replaced; the resize handles beside it stay.
    const old = o.el.querySelector('svg');
    if (old) old.remove();
    o.el.insertAdjacentHTML('afterbegin', shapeSvg(o));
  }
  if (o.type === 'stamp') {
    const box = o.el.querySelector('.stamp-box');
    if (box) box.style.fontSize = (o.h * 0.42 * S) + 'px';
  }
  if (o === state.selection) positionSelbar();
}

/*
 * Which handles an object is resized by. A text box only has a width to
 * change — its height follows its words — so it gets one each side. A sticky
 * note is a fixed-size marker and gets none. Everything else is pulled by its
 * corners.
 */
function handlesFor(o) {
  if (o.type === 'note') return [];
  if (o.type === 'text') return ['w', 'e'];
  return ['nw', 'ne', 'sw', 'se'];
}

const selbarEl = $('#selbar');
// A press on the bar must not reach the page under it, which would read it as
// a click on empty paper and drop the selection.
selbarEl.addEventListener('pointerdown', (e) => e.stopPropagation());
selbarEl.addEventListener('dblclick', (e) => e.stopPropagation());

/**
 * Put the selected object's own actions beside it: above its top-right
 * corner, or below it when there is no room above. The bar lives inside the
 * page's overlay, so it scrolls and zooms with the page without being told.
 */
function positionSelbar() {
  const o = state.selection;
  const p = o && state.pages[o.pageIndex];
  if (!o || !o.el || !p) {
    selbarEl.classList.add('hidden');
    return;
  }
  if (selbarEl.parentNode !== p.overlay) p.overlay.appendChild(selbarEl);
  selbarEl.classList.remove('hidden');
  const S = curScale();
  const pageW = p.viewport1.width * S, pageH = p.viewport1.height * S;
  const barW = selbarEl.offsetWidth, barH = selbarEl.offsetHeight;
  const top = o.y * S - barH - 10;
  const below = (o.y + o.h) * S + 10;
  selbarEl.style.top = (top >= 0 ? top : Math.min(below, pageH - barH)) + 'px';
  selbarEl.style.left = clamp((o.x + o.w) * S - barW, 0, Math.max(0, pageW - barW)) + 'px';
}

function select(o) {
  if (state.selection === o) { updateCtx(); positionSelbar(); return; }
  clearSelection();
  state.selection = o;
  if (o && o.el) {
    o.el.classList.add('selected');
    for (const corner of handlesFor(o)) {
      const h = document.createElement('div');
      h.className = 'handle';
      h.dataset.corner = corner;
      h.addEventListener('pointerdown', (e) => beginResize(e, o, corner));
      o.el.appendChild(h);
    }
  }
  updateCtx();
  positionSelbar();
}

function clearSelection() {
  const o = state.selection;
  if (o && o.el) {
    o.el.classList.remove('selected');
    for (const h of o.el.querySelectorAll('.handle')) h.remove();
  }
  state.selection = null;
  updateCtx();
  positionSelbar();
}

function deleteObject(id, opts) {
  const i = state.objects.findIndex((o) => o.id === id);
  if (i < 0) return;
  const o = state.objects[i];
  state.objects.splice(i, 1);
  if (state.selection === o) state.selection = null;
  if (o.el) o.el.remove();
  if (o.type === 'ink') redrawInk(o.pageIndex);
  updateCtx();
  if (opts && opts.silent) document.dispatchEvent(new CustomEvent('ps:objects-changed'));
  else commit();
}

function duplicateObject(o) {
  if (!o || o.type === 'ink' || o.type === 'cover') return;
  const copy = Object.assign({}, o);
  delete copy.el;
  delete copy.id;
  copy.x = o.x + 12;
  copy.y = o.y + 12;
  select(addObject(copy));
}

/** Move the selection with the arrow keys: a point at a time, ten with Shift. */
function nudgeSelection(dx, dy) {
  const o = state.selection;
  const p = o && state.pages[o.pageIndex];
  if (!p) return;
  o.x = clamp(o.x + dx, -o.w * 0.5, p.viewport1.width - o.w * 0.5);
  o.y = clamp(o.y + dy, -o.h * 0.5, p.viewport1.height - o.h * 0.5);
  applyObjectLayout(o);
  commitSoon();
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
    // Out of the way while the object is on the move; back when it lands.
    if (o.x !== ox || o.y !== oy) selbarEl.classList.add('dragging');
    applyObjectLayout(o);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    selbarEl.classList.remove('dragging');
    positionSelbar();
    if (o.x !== ox || o.y !== oy) commit();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/**
 * Resize from a handle. `corner` says which — 'nw', 'ne', 'sw', 'se', or 'w' /
 * 'e' for the sides of a text box — and the opposite corner stays where it is.
 * Pictures keep their proportions.
 */
function beginResize(e, o, corner) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const S = curScale();
  const pull = corner || 'se';
  const west = pull.includes('w'), north = pull.includes('n'), south = pull.includes('s');
  const sx = e.clientX, sy = e.clientY, ox = o.x, oy = o.y, ow = o.w, oh = o.h;
  const ratio = oh / ow;
  const move = (ev) => {
    const dx = (ev.clientX - sx) / S, dy = (ev.clientY - sy) / S;
    let nw = Math.max(o.type === 'text' ? 40 : 8, ow + (west ? -dx : dx));
    let nh = oh;
    if (o.type === 'image' || o.type === 'sig') {
      nh = nw * ratio;
    } else if (o.type !== 'text') {
      nh = Math.max(6, oh + (north ? -dy : south ? dy : 0));
    }
    o.w = nw;
    if (o.type !== 'text') o.h = nh;
    // Whatever was not pulled stays put: the far edge is the anchor.
    o.x = west ? ox + ow - nw : ox;
    if (o.type !== 'text') o.y = north ? oy + oh - nh : oy;
    applyObjectLayout(o);
  };
  selbarEl.classList.add('dragging');
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    selbarEl.classList.remove('dragging');
    positionSelbar();
    if (o.w !== ow || o.h !== oh || o.x !== ox || o.y !== oy) commit();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
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

  const before = o.text;
  const fresh = !!o.fresh;
  delete o.fresh;
  const onInput = () => {
    o.text = t.innerText;
    applyObjectLayout(o);
  };
  const onBlur = () => {
    t.removeEventListener('input', onInput);
    t.removeEventListener('blur', onBlur);
    t.contentEditable = 'false';
    o.el.classList.remove('editing');
    finishTextEdit(o, t, before, fresh);
  };
  t.addEventListener('input', onInput);
  t.addEventListener('blur', onBlur);
}

function finishTextEdit(o, t, before, fresh) {
  o.text = t.innerText.replace(/ /g, ' ').replace(/\n$/, '');
  if (!o.text.trim()) {
    // A box that was opened and left empty never happened, as far as undo is
    // concerned; one that had words in it was deleted.
    deleteObject(o.id, { silent: fresh });
    return;
  }
  t.textContent = o.text;
  applyObjectLayout(o);
  if (fresh || o.text !== before) commit();
}

async function editNote(o) {
  const text = await textDialog({ title: 'Note', value: o.text || '', ok: 'Save note' });
  if (text === null || !state.objects.includes(o)) return;
  if (!text.trim()) { deleteObject(o.id); return; }
  if (text === o.text) return;
  o.text = text;
  syncObjectElement(o);
  commit();
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
  // Not a step in the history until something has been typed into it.
  const o = addObject({
    type: 'text', pageIndex: pi, x, y: by, w,
    h: state.textDefaults.size * 1.3,
    text: '', size: state.textDefaults.size, color: state.textDefaults.color,
    bold: state.textDefaults.bold, italic: state.textDefaults.italic,
    family: state.textDefaults.family, fresh: true
  }, { silent: true });
  setTool('select');
  select(o);
  startTextEdit(o);
}

async function createNoteAt(pi, bx, by) {
  const text = await textDialog({ title: 'Note', value: '', ok: 'Add note' });
  if (text === null || !text.trim() || !state.pages[pi]) { setTool('select'); return; }
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
  // The ink layer is drawn in page points; its context carries the scale.
  const ictx = inkContext(p);
  ictx.strokeStyle = state.pen.color;
  ictx.lineWidth = state.pen.size;
  ictx.lineCap = 'round';
  ictx.lineJoin = 'round';
  ictx.beginPath();
  ictx.moveTo(sx, sy);
  const pts = [{ x: sx, y: sy }];
  let last = { x: sx, y: sy };
  const move = (e) => {
    const rect = p.overlay.getBoundingClientRect();
    const cx = clamp((e.clientX - rect.left) / S, 0, p.viewport1.width);
    const cy = clamp((e.clientY - rect.top) / S, 0, p.viewport1.height);
    const dx = cx - last.x, dy = cy - last.y;
    if (dx * dx + dy * dy < 0.9) return;
    pts.push({ x: cx, y: cy });
    ictx.lineTo(cx, cy);
    ictx.stroke();
    ictx.beginPath();
    ictx.moveTo(cx, cy);
    last = { x: cx, y: cy };
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    addObject({ type: 'ink', pageIndex: pi, points: pts, size: state.pen.size, color: state.pen.color });
    redrawInk(pi);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
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

/**
 * The page's ink canvas, sized for the current zoom, with a context that
 * draws in page points. The canvas has no size until it is first needed: a
 * layer of ink for every page of a document nobody has drawn on is memory
 * spent on nothing.
 */
function inkContext(p) {
  const k = pixelScale(p);
  const w = Math.max(1, Math.floor(p.viewport1.width * k));
  const h = Math.max(1, Math.floor(p.viewport1.height * k));
  if (p.ink.width !== w || p.ink.height !== h) {
    p.ink.width = w;
    p.ink.height = h;
  }
  const ctx = p.ink.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  return ctx;
}

function redrawInk(pi) {
  const p = state.pages[pi];
  if (!p || !p.ink) return;
  const strokes = state.objects.filter((o) => o.type === 'ink' && o.pageIndex === pi);
  if (!strokes.length) {
    if (p.ink.width) PSExtract.releaseCanvas(p.ink);
    return;
  }
  if (!p.visible) return;   // drawn when the page comes into view
  const ctx = inkContext(p);
  ctx.clearRect(0, 0, p.viewport1.width, p.viewport1.height);
  for (const o of strokes) drawSmoothStroke(ctx, o.points, o.size, o.color, 1);
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

const drawerEl = $('#hub-modal');
// `a[href]`, not `[href]`: every icon is a <use href>, which cannot take focus.
const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), ' +
  'select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
const modalReturn = new Map();   // dialog -> what had focus before it opened

function visibleFocusables(el) {
  // Only what Tab would stop at: the rows of the action search are buttons,
  // but they are reached with the arrow keys and Tab passes them by.
  return $$(FOCUSABLE, el).filter((n) => n.tabIndex >= 0 && n.getClientRects().length > 0);
}

/**
 * Show a dialog, or the Tools drawer.
 *
 * A dialog takes the keyboard with it — focus moves inside and Tab goes round
 * within it — and gives it back to wherever it was when it closes. The drawer
 * is not a dialog: the document beside it stays live, so it only makes room.
 */
function openModal(el) {
  const wasOpen = !el.classList.contains('hidden');
  el.classList.remove('hidden');
  if (el === drawerEl) {
    $('#btn-workbench').setAttribute('aria-expanded', 'true');
    if (!wasOpen) {
      // On a narrow window the drawer and the side panel together leave the
      // document a sliver; the panel steps aside for the drawer.
      if (window.innerWidth < 1180 && !sidebarEl.classList.contains('collapsed')) setSidebar(false);
      else setTimeout(() => { updateFitScale(); relayout(); }, 0);
    }
    return;
  }
  if (wasOpen) return;
  closeMenu();
  modalReturn.set(el, document.activeElement);
  // Dialogs that put the caret somewhere particular do so themselves, a
  // moment later; this is the fallback for the ones that do not.
  setTimeout(() => {
    if (el.classList.contains('hidden') || el.contains(document.activeElement)) return;
    // The close button is the last choice, but it is a choice: a dialog with
    // nothing else in it still has to take the keyboard.
    const nodes = visibleFocusables(el);
    const first = nodes.find((n) => !n.classList.contains('x')) || nodes[0];
    if (first) first.focus();
  }, 40);
}

function closeModal(el) {
  const wasOpen = !el.classList.contains('hidden');
  el.classList.add('hidden');
  if (el === drawerEl) {
    $('#btn-workbench').setAttribute('aria-expanded', 'false');
    if (wasOpen) setTimeout(() => { updateFitScale(); relayout(); }, 0);
    return;
  }
  const back = modalReturn.get(el);
  modalReturn.delete(el);
  if (back && document.contains(back) && typeof back.focus === 'function') back.focus();
}

// Tab stays inside whichever dialog is open.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const open = $$('.modal-wrap, .palette-wrap').find((m) => !m.classList.contains('hidden'));
  if (!open) return;
  const nodes = visibleFocusables(open);
  if (!nodes.length) return;
  const first = nodes[0], last = nodes[nodes.length - 1];
  if (e.shiftKey && (document.activeElement === first || !open.contains(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !open.contains(document.activeElement))) {
    e.preventDefault();
    first.focus();
  }
}, true);

// A click on the dimmed backdrop closes a dialog — except the two that are
// waiting for an answer, which have to be answered.
for (const wrap of $$('.modal-wrap')) {
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target === wrap && wrap !== pwModal && wrap !== askModal) closeModal(wrap);
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
        syncObjectElement(replacing);
        replacing.h = replacing.w * (img.naturalHeight / img.naturalWidth);
        applyObjectLayout(replacing);
        select(replacing);
        commit();
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
  // What was lifted is remembered by id, not by object: undo and redo put
  // back copies, and the picture on the page must still know its own.
  const already = objectById(im.liftedId);
  if (already) {
    select(already);
    return already;
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
  if (!objectById(im.coverId)) {
    im.coverId = addObject({
      type: 'cover', pageIndex: index,
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      color: sampleBackdrop(index, rect)
    }, { silent: true }).id;
  }
  const obj = addObject({
    type: 'image', pageIndex: index, url, fromPage: true,
    x: rect.x, y: rect.y, w: rect.w, h: rect.h
  }, { silent: true });
  im.liftedId = obj.id;
  commit();   // the cover and the picture are one step to undo
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
    if (objectById(im.liftedId)) continue;
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
  // Paragraphs, and each cell of each table: a cell is edited on its own, not
  // as part of a row that runs through its neighbours.
  const job = PSExtract.extractPage(p.page, index, {})
    .then((d) => PSExtract.textBlocks(d).filter((q) => q.text.trim() && !q.invisible))
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

/**
 * Where the glyphs of a block sit, as one thin box per run of text: from just
 * above the tallest letter to just below the deepest, and no wider than the
 * run. A glyph whose origin falls in one of these is one of the block's own.
 *
 * The boxes are built run by run rather than as one rectangle round the block
 * so that nothing else that happens to stand inside that rectangle — the end
 * of the line above, a neighbouring cell — is taken with it.
 */
function eraseRects(para) {
  const rects = [];
  for (const line of para.lines) {
    for (const it of line.items) {
      const pad = Math.max(0.5, it.size * 0.1);
      const width = it.w > 0 ? it.w : it.size * 0.5 * it.str.length;
      rects.push({
        x0: it.x - pad, x1: it.x + width + pad,
        y0: it.baseline - it.size * 0.75, y1: it.baseline + it.size * 0.3
      });
    }
  }
  return rects;
}

function liftParagraph(index, para, at) {
  const already = objectById(para.liftedId);
  if (already) {
    select(already);
    startTextEdit(already, at);
    return already;
  }
  // A little slack so ascenders and descenders are covered too.
  const pad = Math.max(1.5, para.size * 0.22);
  const rect = {
    x: Math.max(0, para.x - pad),
    y: Math.max(0, para.y - pad),
    w: para.w + pad * 2,
    h: para.h + pad * 2
  };
  let glyphs = 0;
  for (const line of para.lines) for (const it of line.items) glyphs += it.str.replace(/\s/g, '').length;
  // A block lifted, undone and lifted again must not end up under two covers.
  if (!objectById(para.coverId)) {
    para.coverId = addObject({
      type: 'cover', pageIndex: index,
      x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      color: sampleBackdrop(index, rect),
      erase: eraseRects(para),
      glyphs
    }, { silent: true }).id;
  }
  // Every word that is about to be hidden goes into the box, a list marker
  // included; the paragraph's own text has that taken off.
  const text = PSExtract.buildRuns(para.lines).map((r) => r.text).join('') || para.text;
  const first = para.lines[0];
  // Room for a substitute face that runs a touch wider, on the side the text
  // does not hang from.
  const slack = para.align === 'justify' ? 0.5 : 2;
  const x = para.align === 'right' ? para.x - slack : para.align === 'center' ? para.x - slack / 2 : para.x;
  const obj = addObject({
    type: 'text', pageIndex: index, fromPage: true,
    x, y: para.y,
    w: Math.max(12, para.w + slack),
    h: Math.max(para.size * 1.25, para.h),
    text,
    size: para.size,
    color: para.color || '#000000',
    bold: !!para.bold,
    italic: !!para.italic,
    family: familyFor(para),
    align: para.align || 'left',
    leading: para.leading || 1.2,
    // How far below the top of the block its first baseline was.
    rise: first ? first.baseline - para.y : undefined,
    origin: cleanFontName(para.font)
  }, { silent: true });
  para.liftedId = obj.id;
  keepOriginalBreaks(obj, para);
  commit();
  refreshHiddenText();
  setTool('select');
  select(obj);
  startTextEdit(obj, at);
  return obj;
}

/**
 * Make a lifted paragraph break its lines where the original did.
 *
 * The box is the width the paragraph was, but the stand-in face is not quite
 * the width of the face it stands in for — and a phrase that was bold is now
 * plain — so the browser may fit a word more, or a word fewer, on a line, and
 * every line after it shifts. Lifting a paragraph to fix one letter should
 * not rearrange it, so a few widths either side are tried and the first that
 * reproduces the original breaks is kept. If none does the box stays as it
 * was: the words still flow, just not where they used to.
 */
function keepOriginalBreaks(obj, para) {
  if (para.lines.length < 2 || (obj.align !== 'left' && obj.align !== 'justify')) return;
  const firstWord = (s) => s.trim().split(/\s+/)[0];
  const want = para.lines.map((l) => firstWord(l.text));
  const same = () => {
    const got = domLines(obj);
    return !!got && got.length === want.length && got.every((g, i) => firstWord(g.text) === want[i]);
  };
  if (same()) return;
  const base = obj.w;
  for (const f of [0.994, 1.006, 0.988, 1.012, 0.98, 1.02, 0.97, 1.03]) {
    obj.w = base * f;
    applyObjectLayout(obj);
    if (same()) return;
  }
  obj.w = base;
  applyObjectLayout(obj);
}

/* --------------------- hiding the words that were lifted --------------------- */
/*
 * A lifted paragraph's original words are not painted over on screen: they
 * are left out of the page's picture altogether, so whatever was behind them
 * — a tint, a rule, a photograph — is still there. pdf.js paints text a glyph
 * at a time, and each glyph is checked against the boxes of what was lifted.
 *
 * Where that cannot be done — a font pdf.js draws as outlines rather than as
 * text — too few glyphs are caught, and the cover falls back to showing its
 * flat colour, which is what it did before.
 */

function hiddenCovers(idx) {
  return state.objects.filter((o) => o.type === 'cover' && o.pageIndex === idx && o.erase && o.erase.length);
}

function hiddenTextKey(idx) {
  const covers = hiddenCovers(idx);
  return covers.length ? covers.map((o) => o.id).join(',') : '';
}

function applyHiddenText(canvas, idx, k) {
  const covers = hiddenCovers(idx);
  if (!covers.length) return;
  const rects = [];
  for (const c of covers) {
    for (const r of c.erase) rects.push({ x0: r.x0 * k, x1: r.x1 * k, y0: r.y0 * k, y1: r.y1 * k, id: c.id });
  }
  const hits = new Map();
  canvas.psHits = hits;
  PSExtract.setTextRule(canvas, (ctx, x, y) => {
    const m = ctx.getTransform();
    const px = m.a * x + m.c * y + m.e, py = m.b * x + m.d * y + m.f;
    for (const r of rects) {
      if (px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1) {
        hits.set(r.id, (hits.get(r.id) || 0) + 1);
        return true;
      }
    }
    return false;
  });
}

function settleHiddenText(idx, canvas) {
  const hits = canvas.psHits;
  for (const c of hiddenCovers(idx)) {
    const clean = !!hits && (hits.get(c.id) || 0) >= Math.max(1, (c.glyphs || 1) * 0.85);
    if (!!c.clean !== clean) {
      c.clean = clean;
      syncObjectElement(c);
    }
  }
}

/** Redraw the pages whose set of hidden words has changed. */
function refreshHiddenText() {
  for (const p of state.pages) {
    if (p.visible && p.renderedKey && renderKey(p) !== p.renderedKey) requestRender(p.index);
  }
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
    if (objectById(para.liftedId) || objectById(para.coverId)) continue;
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

/**
 * Break text into lines no wider than `maxW`. Each line says whether it ended
 * because it ran out of room (`soft`) or because the text said so — only the
 * first kind is stretched when a paragraph is justified.
 */
function wrapLines(text, maxW, measure) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    if (!raw) { out.push({ text: '', soft: false }); continue; }
    const words = raw.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const cand = line + w;
      if (line && measure(cand) > maxW) {
        out.push({ text: line.trimEnd(), soft: true });
        line = w.trimStart();
      } else {
        line = cand;
      }
      // A token wider than the box has to be broken even when it starts a line.
      while (measure(line) > maxW && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > maxW) cut--;
        out.push({ text: line.slice(0, cut), soft: true });
        line = line.slice(cut);
      }
    }
    out.push({ text: line.trimEnd(), soft: false });
  }
  return out;
}

/**
 * The lines of a text box exactly as the browser has broken them.
 *
 * Working the breaks out again from the font's metrics gives the same answer
 * nearly always, and a different one — a word on the wrong line, a paragraph
 * a line longer than it looked — just often enough to matter. Reading them off
 * the screen means the saved file has the lines the user was looking at.
 * Returns null when the box is not laid out, and the metrics are used instead.
 */
function domLines(o) {
  const t = o.el && o.el.querySelector('.txt');
  if (!t || t.childNodes.length !== 1 || t.firstChild.nodeType !== 3 || !t.getClientRects().length) return null;
  const node = t.firstChild;
  const text = node.data;
  if (text !== o.text || text.length > 20000) return null;
  const step = parseFloat(getComputedStyle(t).fontSize) * 0.5 || 4;
  const range = document.createRange();
  const out = [];
  let start = 0;
  let top = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      out.push({ text: text.slice(start, i), soft: false });
      start = i + 1;
      top = null;
      continue;
    }
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const rects = range.getClientRects();
    if (!rects.length) continue;
    const y = rects[0].top;
    if (top != null && y > top + step) {
      out.push({ text: text.slice(start, i), soft: true });
      start = i;
    }
    top = y;
  }
  out.push({ text: text.slice(start), soft: false });
  for (const line of out) line.text = line.text.replace(/\s+$/, '');
  return out;
}

/**
 * A pen stroke as one path of curves through the midpoints of its samples —
 * the same curve the screen draws — rather than a chain of straight pieces,
 * each stroked on its own. One path is smaller, and it is the line that was
 * drawn.
 */
function drawInkToPdf(page, vp1, o) {
  const col = hexToRgb01(o.color);
  const pts = o.points.map((p) => vp1.convertToPdfPoint(p.x, p.y));
  if (pts.length === 1) {
    page.drawCircle({ x: pts[0][0], y: pts[0][1], size: Math.max(0.4, o.size / 2), color: col });
    return;
  }
  const P = PDFLib;
  const ops = [
    P.pushGraphicsState(), P.setStrokingColor(col), P.setLineWidth(o.size),
    P.setLineCap(LineCapStyle.Round), P.setLineJoin(LineJoinStyle.Round),
    P.moveTo(pts[0][0], pts[0][1])
  ];
  let cx = pts[0][0], cy = pts[0][1];
  for (let i = 1; i < pts.length - 1; i++) {
    const qx = pts[i][0], qy = pts[i][1];
    const ex = (qx + pts[i + 1][0]) / 2, ey = (qy + pts[i + 1][1]) / 2;
    // A quadratic curve, written as the cubic a PDF has.
    ops.push(P.appendBezierCurve(
      cx + (qx - cx) * 2 / 3, cy + (qy - cy) * 2 / 3,
      ex + (qx - ex) * 2 / 3, ey + (qy - ey) * 2 / 3,
      ex, ey
    ));
    cx = ex; cy = ey;
  }
  const last = pts[pts.length - 1];
  ops.push(P.lineTo(last[0], last[1]), P.stroke(), P.popGraphicsState());
  for (let i = 0; i < ops.length; i += 400) page.pushOperators(...ops.slice(i, i + 400));
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

/*
 * The faces a text box is shown in. Each is the browser's counterpart of the
 * standard PDF font the saved file will use — Arial for Helvetica, Times New
 * Roman for Times, Courier New for Courier — and each pair shares its letter
 * widths, so a line that fits on screen fits in the file.
 */
const CSS_FAMILY = {
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace',
  sans: 'Helvetica, Arial, sans-serif'
};

/**
 * How far below the top of a text box the browser puts its first baseline, as
 * a multiple of the type size. It depends on the face's own metrics and on the
 * line height, so it is measured once for each combination rather than
 * assumed.
 */
const baselineRatios = new Map();

function domBaselineRatio(o) {
  const family = CSS_FAMILY[o.family] || CSS_FAMILY.sans;
  const leading = o.leading || 1.25;
  const key = family + '|' + (o.bold ? 'b' : '') + (o.italic ? 'i' : '') + '|' + leading;
  let ratio = baselineRatios.get(key);
  if (ratio == null) {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;' +
      'font-size:100px;line-height:' + leading + ';font-family:' + family +
      ';font-weight:' + (o.bold ? 700 : 400) + ';font-style:' + (o.italic ? 'italic' : 'normal');
    // An empty inline block sits with its bottom edge on the baseline.
    const mark = document.createElement('span');
    mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    probe.appendChild(mark);
    probe.appendChild(document.createTextNode('Hxg'));
    document.body.appendChild(probe);
    ratio = (mark.getBoundingClientRect().bottom - probe.getBoundingClientRect().top) / 100;
    probe.remove();
    if (!(ratio > 0.3 && ratio < 3)) ratio = 0.9;
    baselineRatios.set(key, ratio);
  }
  return ratio;
}

/** Where a text box's first baseline is, in points below its top. */
function textRise(o) {
  return o.rise != null ? o.rise : domBaselineRatio(o) * o.size;
}

/** Draw one line, spreading its words to the full width when it is justified. */
function placeLine(line, align, avail, width, put) {
  const text = line.text.replace(/\t/g, '    ');
  if (!text) return;
  const words = text.trim().split(/\s+/);
  if (align === 'justify' && line.soft && words.length > 1) {
    const used = words.reduce((n, w) => n + width(w), 0);
    const gap = (avail - used) / (words.length - 1);
    // A line that would need absurd gaps was never a full line.
    if (gap > 0 && gap < width('m') * 3) {
      let x = 0;
      for (const w of words) { put(w, x); x += width(w) + gap; }
      return;
    }
  }
  put(text, alignOffset(align, avail, width(text)));
}

async function drawTextToPdf(srcDoc, page, fonts, vp1, rot, o) {
  const color = hexToRgb01(o.color);
  const size = o.size;
  const lh = size * (o.leading || 1.25);
  const rise = textRise(o);
  const avail = Math.max(8, o.w);
  const font = await fonts.for(o.family || 'sans', o.bold, o.italic);
  const shown = domLines(o);
  let vector = rot === 0;
  if (vector) {
    try { font.widthOfTextAtSize(o.text.replace(/\s+/g, ' '), size); }
    catch (e) { vector = false; }
  }
  if (vector) {
    const width = (s2) => font.widthOfTextAtSize(s2, size);
    const lines = shown || wrapLines(o.text, avail, width);
    const b = pdfBox(vp1, o.x, o.y, o.w, o.h);
    lines.forEach((ln, i) => {
      placeLine(ln, o.align, avail, width, (text, dx) => {
        page.drawText(text, { x: b.L + dx, y: b.T - rise - i * lh, size, font, color });
      });
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
  const weight = (o.italic ? 'italic ' : '') + (o.bold ? '700 ' : '');
  const fontCss = weight + (size * SC) + 'px ' + (CSS_FAMILY[o.family] || CSS_FAMILY.sans);
  mctx.font = fontCss;
  const width = (s2) => mctx.measureText(s2).width / SC;
  const lines = shown || wrapLines(o.text, avail, width);
  const hUnits = Math.max(lh, rise + (lines.length - 1) * lh + size * 0.4);
  mc.width = Math.max(2, Math.ceil(o.w * SC));
  mc.height = Math.max(2, Math.ceil(hUnits * SC));
  mctx = mc.getContext('2d');
  mctx.font = fontCss;
  mctx.fillStyle = o.color;
  mctx.textBaseline = 'alphabetic';
  lines.forEach((ln, i) => {
    placeLine(ln, o.align, avail, width, (text, dx) => {
      mctx.fillText(text, dx * SC, (rise + i * lh) * SC);
    });
  });
  const img = await srcDoc.embedPng(mc.toDataURL('image/png'));
  PSExtract.releaseCanvas(mc);
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
      'this document is still encrypted, so it cannot be rewritten. Use Tools → Protect ' +
      '→ Remove a password first.'
    );
  }
  const o = Object.assign({ applyRedactions: true, redactDpi: 200 }, opts);
  flushCommit();
  // Nothing has been added, so there is nothing to bake in: the document is
  // itself, byte for byte, and reading it in and writing it out again would
  // only cost time.
  if (!state.objects.length) return state.bytes;
  const srcDoc = await PDFDocument.load(state.bytes, PDF_LOAD);
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
  // Fonts are embedded as they are first asked for; one that is never used
  // is never written into the file.
  const fonts = { for: fontFor };
  const pdfPages = srcDoc.getPages();

  // The words of every lifted paragraph come out of the page first, before
  // anything is drawn on it. `erased` holds the covers this worked for; they
  // have nothing left to cover.
  const erased = await eraseLiftedText(srcDoc, pdfPages);
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
  const coveredText = new Set();   // pages whose old words are only painted over
  for (const obj of state.objects) {
    const page = pdfPages[obj.pageIndex];
    const pinfo = state.pages[obj.pageIndex];
    if (!page || !pinfo) continue;
    const vp1 = pinfo.viewport1;
    const rot = normRot(page.getRotation().angle);

    if (obj.type === 'ink') {
      drawInkToPdf(page, vp1, obj);
    } else if (obj.type === 'cover') {
      if (erased.has(obj.id)) continue;
      if (obj.erase) coveredText.add(obj.pageIndex);
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
      // Multiplied onto the page, as on screen: the text under a highlight
      // stays black instead of being washed out by a film of colour.
      page.drawRectangle({
        x: b.L, y: b.B, width: b.R - b.L, height: b.T - b.B,
        color: hexToRgb01(obj.color), opacity: obj.opacity, blendMode: BlendMode.Multiply
      });
    } else if (obj.type === 'shape') {
      drawShapeToPdf(page, vp1, obj);
    } else if (obj.type === 'note') {
      addNoteAnnotation(srcDoc, page, vp1, obj);
    } else if (obj.type === 'stamp') {
      drawStampToPdf(page, await fontFor('sans', true, false), vp1, rot, obj);
    } else if (obj.type === 'image' || obj.type === 'sig') {
      const img = await embed(obj.url);
      const b = pdfBox(vp1, obj.x, obj.y, obj.w, obj.h);
      const anchor = anchorFor(rot, b);
      page.drawImage(img, { x: anchor[0], y: anchor[1], width: obj.w, height: obj.h, rotate: degrees(rot) });
    } else if (obj.type === 'text') {
      await drawTextToPdf(srcDoc, page, fonts, vp1, rot, obj);
    }
  }

  /*
   * Covering something does not remove it: what is under a redaction, and any
   * replaced words that could not be taken out of the page above, are still in
   * the byte stream, recoverable by any reader that looks. Those pages are
   * re-rendered as pictures, which is what removes them.
   */
  const burnIn = new Set();
  if (o.applyRedactions !== false) {
    for (const k of Object.keys(redactBoxes)) burnIn.add(Number(k));
  }
  if (o.flattenEdits !== false) {
    for (const i of coveredText) burnIn.add(i);
  }
  if (burnIn.size && o.confirmRaster) {
    const go = await o.confirmRaster({
      pages: Array.from(burnIn).sort((a, b) => a - b).map((i) => i + 1),
      redactions: Object.keys(redactBoxes).length > 0,
      text: coveredText.size > 0
    });
    if (!go) {
      const stop = new Error('Cancelled');
      stop.name = 'ExportCancelled';
      throw stop;
    }
  }

  let bytes = await srcDoc.save(PDF_SAVE);
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

/**
 * Take the original words of every lifted paragraph out of their pages.
 *
 * Each page is rewritten, the document is written out once and read back, and
 * every rewritten page is checked glyph by glyph against what it was meant to
 * become. A page that passes keeps the change; one that does not is put back
 * exactly as it was, and its covers fall back to painting over the words and
 * having the page re-rendered — the way it was always done before.
 *
 * Returns the ids of the covers whose words are really gone.
 */
async function eraseLiftedText(srcDoc, pdfPages) {
  const done = new Set();
  if (typeof PSContentEdit === 'undefined') return done;
  const byPage = new Map();
  for (const obj of state.objects) {
    if (obj.type !== 'cover' || !obj.erase || !obj.erase.length) continue;
    if (!byPage.has(obj.pageIndex)) byPage.set(obj.pageIndex, []);
    byPage.get(obj.pageIndex).push(obj);
  }
  if (!byPage.size) return done;

  const plans = [];
  for (const [index, covers] of byPage) {
    const pinfo = state.pages[index];
    const page = pdfPages[index];
    if (!pinfo || !page) continue;
    try {
      const rects = [];
      for (const c of covers) for (const r of c.erase) rects.push(r);
      const plan = await PSContentEdit.erase(srcDoc, page, pinfo.page, rects);
      if (plan) plans.push({ index, covers, plan });
    } catch (err) { /* this page falls back */ }
  }
  if (!plans.length) return done;

  let check = null;
  try {
    const bytes = await srcDoc.save(PDF_SAVE);
    check = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
    for (const p of plans) {
      let ok = false;
      try {
        ok = await PSContentEdit.verify(await check.getPage(p.index + 1), p.plan);
      } catch (err) { ok = false; }
      if (ok) {
        p.plan.commit();
        for (const c of p.covers) done.add(c.id);
      } else {
        p.plan.revert();
      }
    }
  } catch (err) {
    for (const p of plans) { try { p.plan.revert(); } catch (e) { /* already back */ } }
    done.clear();
  } finally {
    if (check) { try { check.destroy(); } catch (e) { /* ignore */ } }
  }
  return done;
}

function describeRaster(info) {
  const pages = info.pages.length === 1 ? 'Page ' + info.pages[0] : 'Pages ' + info.pages.join(', ');
  const will = info.pages.length === 1 ? ' will be saved as a picture.' : ' will be saved as pictures.';
  const why = info.redactions && info.text
    ? 'That is what makes a redaction permanent, and on some of these pages the words you ' +
      'replaced could not be taken out any other way.'
    : info.redactions
      ? 'That is what makes a redaction permanent: what is under the box stops existing, ' +
        'rather than sitting beneath it.'
      : 'The words you replaced there could not be taken out of the page cleanly, and ' +
        'painting over them would leave them in the file.';
  return pages + will + ' ' + why + ' Text on ' +
    (info.pages.length === 1 ? 'that page' : 'those pages') +
    ' will no longer be selectable, and the file will be larger.';
}

btnDownload.addEventListener('click', async () => {
  if (!state.doc || btnDownload.disabled) return;
  const orig = buttonLabel(btnDownload);
  btnDownload.disabled = true;
  buttonLabel(btnDownload, 'Preparing…');
  setBusy(true);
  try {
    const edited = state.objects.length > 0;
    const bytes = await exportAnnotated({
      confirmRaster: (info) => confirmDialog({
        title: info.pages.length === 1 ? 'One page will become a picture' : 'Some pages will become pictures',
        text: describeRaster(info),
        ok: 'Save'
      })
    });
    downloadBytes(bytes, suffixName(state.name, edited ? '-edited' : ''));
    setDirty(false);
  } catch (err) {
    if (!(err && err.name === 'ExportCancelled')) {
      showBanner('Export failed: ' + ((err && err.message) || err));
    }
  }
  setBusy(false);
  buttonLabel(btnDownload, orig);
  btnDownload.disabled = state.locked;
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

/*
 * Where each character of a text item starts and ends, as fractions of the
 * item's width. The PDF gives only the width of the whole run, so the
 * proportions are measured in a browser font of the same kind — serif, sans or
 * mono, bold, italic — and scaled to that width. Glyph shapes differ between
 * faces but their relative widths are close, which is far nearer than treating
 * every character as equally wide ("i" against "m" is a factor of three).
 */
const glyphCtx = document.createElement('canvas').getContext('2d');
const glyphStops = new WeakMap();

function charStops(item) {
  let stops = glyphStops.get(item);
  if (stops) return stops;
  const family = item.mono ? 'monospace' : item.serif ? 'Georgia, serif' : 'Arial, sans-serif';
  glyphCtx.font = (item.italic ? 'italic ' : '') + (item.bold ? 'bold ' : '') + '100px ' + family;
  const total = glyphCtx.measureText(item.str).width;
  stops = [0];
  for (let c = 1; c <= item.str.length; c++) {
    stops.push(total > 0 ? glyphCtx.measureText(item.str.slice(0, c)).width / total : c / item.str.length);
  }
  glyphStops.set(item, stops);
  return stops;
}

function rectForMatch(entry, start, end) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = start; i < end; i++) {
    const m = entry.map[i];
    if (!m) continue;
    const stops = charStops(m.item);
    const x0 = m.item.x + m.item.w * stops[m.offset];
    const x1 = m.item.x + m.item.w * stops[m.offset + 1];
    minX = Math.min(minX, x0);
    maxX = Math.max(maxX, x1);
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
    await PSExtract.tick();
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

// The rail is a single stop for the Tab key; the arrow keys move along it.
const railButtons = $$('.rail .tool, .rail .side-tab');
railButtons.forEach((b, i) => {
  b.tabIndex = i === 0 ? 0 : -1;
  b.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const n = railButtons.length;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1
      : (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    for (const other of railButtons) other.tabIndex = -1;
    railButtons[next].tabIndex = 0;
    railButtons[next].focus();
  });
});

/*
 * The highlighter's colours are shown as chips. The control the rest of the
 * code reads is still the select they stand in for: a chip sets it and fires
 * its change, so nothing else has to know the chips are there.
 */
function buildChips(select, holder) {
  holder.textContent = '';
  for (const option of Array.from(select.options)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.style.background = option.value;
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-label', option.textContent);
    chip.title = option.textContent;
    chip.addEventListener('click', () => {
      select.value = option.value;
      select.dispatchEvent(new Event('change'));
    });
    holder.appendChild(chip);
  }
  select.addEventListener('change', () => paintChips(select, holder));
  paintChips(select, holder);
}

function paintChips(select, holder) {
  Array.from(holder.children).forEach((chip, i) => {
    chip.setAttribute('aria-checked', String(select.options[i] && select.options[i].value === select.value));
  });
}

buildChips(hlColorInput, $('#hl-chips'));

/*
 * Each control sets what the next mark of its kind will look like, and — when
 * a mark of that kind is selected — changes that mark too. `change` runs on
 * the selected object and reports whether it applied.
 */
function applyToSelection(type, change) {
  const sel = state.selection;
  if (!sel || sel.type !== type) return;
  change(sel);
  syncObjectElement(sel);
  applyObjectLayout(sel);
  commitSoon();
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
  applyToSelection('text', (sel) => {
    // The first baseline was measured for the old size; let it follow the new.
    if (sel.rise != null && sel.size > 0) sel.rise = sel.rise * (v / sel.size);
    sel.size = v;
  });
});
textColorInput.addEventListener('input', () => {
  state.textDefaults.color = textColorInput.value;
  applyToSelection('text', (sel) => { sel.color = textColorInput.value; });
});
textBoldInput.addEventListener('change', () => {
  state.textDefaults.bold = textBoldInput.checked;
  applyToSelection('text', (sel) => { sel.bold = textBoldInput.checked; });
});
textItalicInput.addEventListener('change', () => {
  state.textDefaults.italic = textItalicInput.checked;
  applyToSelection('text', (sel) => { sel.italic = textItalicInput.checked; });
});
textFamilyInput.addEventListener('change', () => {
  state.textDefaults.family = textFamilyInput.value;
  applyToSelection('text', (sel) => { sel.family = textFamilyInput.value; });
});

penSizeInput.addEventListener('input', () => {
  state.pen.size = parseFloat(penSizeInput.value) || 3;
});
penColorInput.addEventListener('input', () => {
  state.pen.color = penColorInput.value;
});

hlColorInput.addEventListener('change', () => {
  state.highlight.color = hlColorInput.value;
  applyToSelection('highlight', (sel) => { sel.color = hlColorInput.value; });
});
hlOpacityInput.addEventListener('input', () => {
  state.highlight.opacity = (parseInt(hlOpacityInput.value, 10) || 38) / 100;
  applyToSelection('highlight', (sel) => { sel.opacity = state.highlight.opacity; });
});

shapeKindInput.addEventListener('change', () => {
  state.shape.kind = shapeKindInput.value;
  applyToSelection('shape', (sel) => { sel.kind = shapeKindInput.value; });
});
shapeStrokeInput.addEventListener('input', () => {
  state.shape.stroke = shapeStrokeInput.value;
  applyToSelection('shape', (sel) => { sel.stroke = shapeStrokeInput.value; });
});
shapeWidthInput.addEventListener('input', () => {
  state.shape.width = parseFloat(shapeWidthInput.value) || 2;
  applyToSelection('shape', (sel) => { sel.width = state.shape.width; });
});
shapeFillInput.addEventListener('input', () => {
  state.shape.fill = shapeFillInput.value;
  applyToSelection('shape', (sel) => { sel.fill = shapeFillInput.value; });
});
shapeFilledInput.addEventListener('change', () => {
  state.shape.filled = shapeFilledInput.checked;
  applyToSelection('shape', (sel) => { sel.filled = shapeFilledInput.checked; });
});

btnUndoStroke.addEventListener('click', undo);
if (btnUndo) btnUndo.addEventListener('click', undo);
if (btnRedo) btnRedo.addEventListener('click', redo);
/** Delete what is selected, and leave a way straight back. */
function deleteSelection() {
  if (!state.selection) return;
  deleteObject(state.selection.id);
  showBanner('Deleted.', 'info', { action: { label: 'Undo', run: undo }, life: 4500 });
}
btnDeleteObj.addEventListener('click', deleteSelection);
btnDuplicateObj.addEventListener('click', () => duplicateObject(state.selection));

btnOpenTop.addEventListener('click', () => pdfInput.click());
btnOpenFile.addEventListener('click', () => pdfInput.click());
pdfInput.addEventListener('change', () => {
  const f = pdfInput.files && pdfInput.files[0];
  pdfInput.value = '';
  handleNewFile(f);
});

/* ============================== dialogs ============================== */

/*
 * Questions are asked in the page rather than with the browser's own confirm
 * and prompt boxes. Those freeze the whole tab while they are up, cannot be
 * styled or given a sensible button label, and a note typed into prompt() is
 * one line that cannot be broken.
 *
 * ask() resolves to true or false, or — with `input` — to the text entered,
 * or null if the question was dismissed.
 */
let askOpen = null;

function ask(opts) {
  const o = Object.assign({ title: '', text: '', ok: 'OK', cancel: 'Cancel', danger: false, input: null }, opts);
  if (askOpen) askOpen(o.input ? null : false);
  return new Promise((resolve) => {
    // A note gets a box it can run to several lines in; a name gets one line.
    const single = !!(o.input && o.input.single);
    const field = single ? $('#ask-line') : $('#ask-input');
    const okBtn = $('#ask-ok');
    const cancelBtn = $('#ask-cancel');
    $('#ask-title').textContent = o.title;
    $('#ask-text').textContent = o.text;
    $('#ask-text').classList.toggle('hidden', !o.text);
    okBtn.textContent = o.ok;
    cancelBtn.textContent = o.cancel;
    okBtn.classList.toggle('danger-btn', !!o.danger);
    $('#ask-input').classList.toggle('hidden', !o.input || single);
    $('#ask-line').classList.toggle('hidden', !single);
    if (o.input) field.value = o.input.value || '';
    openModal(askModal);
    setTimeout(() => {
      (o.input ? field : okBtn).focus();
      if (single) field.select();
    }, 30);

    const finish = (value) => {
      askOpen = null;
      closeModal(askModal);
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onOk = () => finish(o.input ? field.value : true);
    const onCancel = () => finish(o.input ? null : false);
    // Captured ahead of the page's own shortcuts, so a letter typed into a
    // note does not pick a tool, and Escape answers the question.
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
      if (e.key === 'Enter' && (!o.input || single || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        onOk();
        return;
      }
      // Tab is left to the handler that keeps it inside the dialog.
      if (e.key !== 'Tab') e.stopPropagation();
    };
    askOpen = finish;
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey, true);
  });
}

function confirmDialog(opts) {
  return ask(opts);
}

function textDialog(opts) {
  return ask(Object.assign({}, opts, {
    input: { value: (opts && opts.value) || '', single: !!(opts && opts.single) }
  }));
}

/* ============================== leaving ============================== */

// Closing the tab, or following a link out of it, throws away every edit that
// has not been saved. The browser asks first — in its own words; a page is not
// allowed to supply them.
window.addEventListener('beforeunload', (e) => {
  if (!state.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

/* ============================== drag & drop ============================== */

/*
 * A file dropped anywhere in the window is taken, not only one dropped on the
 * pages. Left to the browser, a PDF let go over the toolbar opens in place of
 * the editor and takes the work in it along.
 */
const OFFICE_FILE = /\.(docx|xlsx|xls|csv)$/i;
const TEXT_FILE = /\.(txt|md|log)$/i;

function draggingFiles(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  return !!types && Array.from(types).includes('Files');
}

window.addEventListener('dragover', (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  document.body.classList.remove('dragging');
  if (!draggingFiles(e)) return;
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) handleDroppedFiles(files);
});

async function handleDroppedFiles(files) {
  const first = files[0];
  if (/\.pdf$/i.test(first.name) || first.type === 'application/pdf') {
    handleNewFile(first);
    return;
  }
  // Anything else that can become a PDF is made into one and opened.
  const images = files.filter((f) => /^image\//.test(f.type));
  let make = null;
  if (images.length) {
    make = () => PSConvert.imagesToPdf(images, { filename: images.length === 1 ? images[0].name : 'images' });
  } else if (/\.docx$/i.test(first.name)) {
    make = () => PSConvert.docxToPdf(first, {});
  } else if (OFFICE_FILE.test(first.name)) {
    make = () => PSConvert.spreadsheetToPdf(first, {});
  } else if (TEXT_FILE.test(first.name) || first.type === 'text/plain') {
    make = async () => PSConvert.textToPdf(await first.text(), { filename: first.name });
  }
  if (!make) {
    showBanner('That file cannot be opened here. Drop a PDF, a picture, a Word document, ' +
               'a spreadsheet or a text file.');
    return;
  }
  if (state.doc && state.dirty && !(await confirmDialog({
    title: 'Open another document?',
    text: 'The changes you have not saved in this one will be lost.',
    ok: 'Open it',
    danger: true
  }))) return;
  setMeta('Making a PDF…');
  try {
    const res = await make();
    await loadBytes(res.bytes, res.filename, { dirty: true });
    showBanner('Made a PDF from ' + (images.length > 1 ? images.length + ' pictures' : first.name) +
               '. Use "Save PDF" to keep it.', 'ok');
  } catch (err) {
    showBanner('Could not make a PDF from that file. ' + ((err && err.message) || ''));
    setMeta(state.doc ? metaText() : 'No document loaded');
  }
}

/* ============================== keyboard ============================== */

const SHORTCUTS = [
  ['V', 'Select and move'], ['T', 'Text box'], ['D', 'Freehand pen'],
  ['H', 'Highlighter'], ['R', 'Shapes'], ['W', 'Whiteout'], ['X', 'Redact'],
  ['N', 'Sticky note'], ['S', 'Signature'], ['M', 'Stamp'], ['I', 'Insert an image'],
  ['P', 'Edit a picture already in the document'],
  ['E', 'Edit text already in the document'],
  ['Ctrl + O', 'Open a PDF'], ['Ctrl + S', 'Save the PDF'], ['Ctrl + F', 'Find in document'],
  ['Ctrl + Z', 'Undo'], ['Ctrl + Shift + Z', 'Redo'], ['Ctrl + D', 'Duplicate the selection'],
  ['Arrow keys', 'Nudge the selection (Shift: further)'],
  ['Delete', 'Remove the selection'], ['Esc', 'Cancel / deselect'],
  ['F4', 'Show or hide the side panel'], ['F5', 'Presentation mode'],
  ['Ctrl + +', 'Zoom in'], ['Ctrl + −', 'Zoom out'], ['Ctrl + 0', 'Fit width'],
  ['Ctrl + wheel', 'Zoom about the pointer'],
  ['Ctrl + K', 'Search every tool and action'],
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

  // Escape backs out of one thing at a time, innermost first.
  if (e.key === 'Escape') {
    if (openMenu) { closeMenu(); return; }
    if (state.present) { setPresent(false); return; }
    if (openModalEl && openModalEl !== pwModal && openModalEl !== askModal) { closeModal(openModalEl); return; }
    if (typing) { t.blur(); return; }
    if (state.selection || state.tool !== 'select') {
      clearSelection();
      setTool('select');
      return;
    }
    if (!drawerEl.classList.contains('hidden')) closeModal(drawerEl);
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); pdfInput.click(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); btnDownload.click(); return; }
  if (mod && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    showSidePanel('panel-search');
    $('#search-input').focus();
    return;
  }
  if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); setZoom(state.zoom * 1.15); return; }
  if (mod && e.key === '-') { e.preventDefault(); setZoom(state.zoom / 1.15); return; }
  if (mod && e.key === '0') { e.preventDefault(); fitWidth(); return; }

  if (typing) {
    if (e.key === 'Enter' && t.id === 'search-input') {
      e.preventDefault();
      gotoHit(state.search.index + (e.shiftKey ? -1 : 1));
    }
    return;
  }
  if (openModalEl) return;

  if (e.key === 'F4') { e.preventDefault(); setSidebar(sidebarEl.classList.contains('collapsed')); return; }
  if (e.key === 'F5') { e.preventDefault(); setPresent(!state.present); return; }
  if (e.key === '?') { e.preventDefault(); openModal(keysModal); return; }

  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection) {
    e.preventDefault();
    deleteSelection();
    return;
  }
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    duplicateObject(state.selection);
    return;
  }
  if (!state.doc) return;

  if (state.selection && !mod && /^Arrow/.test(e.key)) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    nudgeSelection(
      e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
      e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
    );
    return;
  }

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
  for (const tab of $$('.side-tab')) {
    const on = tab.dataset.panel === id;
    tab.classList.toggle('active', on);
    if (on) $('#side-title').textContent = tab.getAttribute('aria-label') || '';
  }
  for (const panel of $$('.side-panel')) panel.classList.toggle('hidden', panel.id !== id);
  if (sidebarEl.classList.contains('collapsed')) setSidebar(true);
  else for (const tab of $$('.side-tab')) tab.setAttribute('aria-selected', String(tab.classList.contains('active')));
  document.dispatchEvent(new CustomEvent('ps:panel-shown', { detail: { id } }));
}
// A panel's button opens it; pressed again while it is showing, it puts the
// panel away and gives the room back to the document.
for (const tab of $$('.side-tab')) {
  tab.addEventListener('click', () => {
    const showing = tab.classList.contains('active') && !sidebarEl.classList.contains('collapsed');
    if (showing) setSidebar(false);
    else showSidePanel(tab.dataset.panel);
  });
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
  askPassword,
  icon,
  setZoom,
  fitWidth,
  fitPage,
  relayout,
  updateFitScale,
  setSidebar,
  closeMenu,
  setBusy,
  buttonLabel,
  setDirty,
  setPresent,
  confirmDialog,
  textDialog,
  undo,
  redo
};

/* ============================== boot ============================== */

setTool('select');
const srcParam = new URLSearchParams(location.search).get('src');
if (srcParam) loadFromUrl(srcParam);
