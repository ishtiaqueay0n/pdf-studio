'use strict';
/* global Tesseract, PSExtract */
/*
 * Optical character recognition for pages that carry no text.
 *
 * A scanned PDF has pictures where its words should be. Everything downstream —
 * paragraphs, headings, tables, Word, HTML, CSV — is built from the item shape
 * that extract.js produces, so the whole job here is to turn recognised words
 * into that same shape and hand them back. Nothing else in the pipeline needs
 * to know OCR happened.
 *
 * Everything runs locally. Tesseract, its WebAssembly core and both language
 * models are vendored under libs/; no page, image or word ever leaves the
 * machine. See the security note in the README about what this costs: running
 * WebAssembly means the extension policy has to allow 'wasm-unsafe-eval'.
 */
(function (root) {

const CORE = 'libs/tesseract-core.wasm.js';
const WORKER = 'libs/tesseract-worker.min.js';
const LANG_DIR = 'libs/tessdata';

const LANGUAGES = {
  eng: 'English',
  ben: 'Bengali'
};
const DEFAULT_LANGS = 'eng+ben';

// Tesseract reports a confidence per word. Below this the "word" is usually
// speckle from the scan, and letting it through would put noise into the
// converted document.
const MIN_CONFIDENCE = 40;

function assetUrl(path) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(path);
  }
  return path;
}

function available() {
  return typeof Tesseract !== 'undefined' && !!Tesseract.createWorker;
}

/*
 * One worker is kept alive across pages because starting it costs a second or
 * two and loading a language model costs more. It is keyed by the language set
 * so switching languages replaces it rather than silently using the old one.
 *
 * The worker is shared, so what it is told about progress goes through one
 * slot that each call fills in for the length of its own recognition.
 */
let current = null;
let listener = null;

async function getWorker(langs) {
  if (current && current.langs === langs) return current.worker;
  await terminate();
  const starting = Tesseract.createWorker(langs, 1 /* LSTM only */, {
    workerPath: assetUrl(WORKER),
    corePath: assetUrl(CORE),
    langPath: assetUrl(LANG_DIR),
    // Load the worker straight from the extension instead of wrapping it in a
    // blob: URL, so the page policy does not have to allow blob workers.
    workerBlobURL: false,
    gzip: true,
    logger: (m) => {
      if (listener && m && m.status) listener(m.status, typeof m.progress === 'number' ? m.progress : 0);
    }
  });
  // Remember the start itself, so two pages asking at once share one worker
  // instead of each starting their own.
  current = { langs, worker: starting };
  try {
    return await starting;
  } catch (err) {
    if (current && current.worker === starting) current = null;
    throw err;
  }
}

async function terminate() {
  if (!current) return;
  const pending = current.worker;
  current = null;
  try { (await pending).terminate(); } catch (e) { /* already gone */ }
}

/**
 * Recognise a rendered page and return items in extract.js's shape.
 *
 * @param {HTMLCanvasElement} canvas  the page, rendered at `dpi`
 * @param {object} opts  { dpi, langs, onProgress }
 */
async function recognizeCanvas(canvas, opts) {
  const o = Object.assign({ dpi: 200, langs: DEFAULT_LANGS }, opts);
  if (!available()) throw new Error('The OCR engine is not available.');
  const worker = await getWorker(o.langs);
  listener = o.onProgress || null;
  try {
    const result = await worker.recognize(canvas, {}, { blocks: true });
    return itemsFromResult(result && result.data, 72 / (o.dpi || 200));
  } finally {
    listener = null;
  }
}

/** Where a line's baseline is at a given x, from the two points Tesseract gives. */
function baselineAt(baseline, x, fallback) {
  if (!baseline || typeof baseline.y0 !== 'number' || typeof baseline.y1 !== 'number') return fallback;
  const dx = baseline.x1 - baseline.x0;
  if (!dx) return baseline.y0;
  return baseline.y0 + (baseline.y1 - baseline.y0) * ((x - baseline.x0) / dx);
}

/**
 * Recognised words become the same positioned runs pdf.js would have produced,
 * so the layout code can do its usual work on them.
 *
 * The size and the baseline of every word are taken from its line, not from
 * the word's own box. A word's box is only as tall as its letters — "one" is
 * half the height of "play" — so sizing words one at a time gives every line
 * a different size from word to word, and headings stop being recognisable as
 * headings.
 *
 * `scale` converts image pixels to PDF points.
 */
function itemsFromResult(data, scale) {
  const items = [];
  if (!data) return items;

  const pushWord = (w, line) => {
    const text = (w.text || '').trim();
    if (!text) return;
    if (typeof w.confidence === 'number' && w.confidence < MIN_CONFIDENCE) return;
    const b = w.bbox;
    if (!b) return;
    const x = b.x0 * scale;
    const width = (b.x1 - b.x0) * scale;
    const boxTop = b.y0 * scale;
    const boxHeight = (b.y1 - b.y0) * scale;
    if (width <= 0 || boxHeight <= 0) return;

    let size = boxHeight;
    let baseline = boxTop + boxHeight * 0.82;
    if (line && line.bbox) {
      const lineHeight = (line.bbox.y1 - line.bbox.y0) * scale;
      const attrs = line.rowAttributes || line.row_attributes || {};
      const rowHeight = (attrs.rowHeight || attrs.row_height || 0) * scale;
      // The row height is ascender to descender; without it, a line's box is
      // about that tall as long as the line holds both kinds of letter. The
      // row height is believed only while it agrees roughly with the box: on
      // a line taken from inside a ruled table it can be the height of the
      // cell rather than of the type.
      size = rowHeight > 2
        ? Math.min(Math.max(rowHeight, lineHeight * 0.75), lineHeight * 1.35)
        : lineHeight;
      if (size > 2) {
        const guess = line.bbox.y1 * scale - size * 0.22;
        const read = baselineAt(line.baseline, (b.x0 + b.x1) / 2, null);
        baseline = read != null ? read * scale : guess;
        // A baseline outside its own line's box is a misread; fall back.
        if (baseline < line.bbox.y0 * scale || baseline > line.bbox.y1 * scale + size * 0.2) baseline = guess;
      } else {
        size = boxHeight;
      }
    }
    size = Math.round(size * 100) / 100;
    items.push({
      str: text,
      x,
      baseline,
      y: baseline - size * 0.8,
      w: width,
      h: size,
      size,
      ascent: 0.8,
      descent: 0.2,
      angle: 0,
      rotated: false,
      font: 'OCR',
      fontId: null,
      face: 'Arial',
      bold: false,
      italic: false,
      mono: false,
      serif: false,
      hasEOL: false,
      color: '#000000',
      invisible: false,
      confidence: typeof w.confidence === 'number' ? w.confidence : null,
      ocr: true
    });
  };

  let found = false;
  for (const block of data.blocks || []) {
    for (const para of (block.paragraphs || [])) {
      for (const line of (para.lines || [])) {
        for (const word of (line.words || [])) { pushWord(word, line); found = true; }
      }
    }
  }
  // Some builds report only a flat word list.
  if (!found && data.words) for (const word of data.words) pushWord(word, word.line || null);
  return items;
}

/**
 * Read a page that has no text of its own and return it in the shape
 * extractPage would have produced, so a converter can use it unchanged.
 *
 * @param {object} pdfPage   a pdf.js page proxy
 * @param {object} pageData  what extractPage already returned for it
 * @param {object} opts      { dpi, langs, onProgress }
 */
async function readPage(pdfPage, pageData, opts) {
  const o = Object.assign({ dpi: 200, langs: DEFAULT_LANGS }, opts);
  const canvas = await PSExtract.renderPageToCanvas(pdfPage, o.dpi, '#ffffff');
  // The canvas may have been made smaller than asked to fit the browser's
  // limits; the scale it was really drawn at is what maps pixels to points.
  const dpi = canvas.psScale ? canvas.psScale * 72 : o.dpi;
  const base = Object.assign({}, pageData);
  if (!base.width) {
    base.width = (canvas.width * 72) / dpi;
    base.height = (canvas.height * 72) / dpi;
  }
  let items;
  try {
    items = await recognizeCanvas(canvas, Object.assign({}, o, { dpi }));
  } finally {
    PSExtract.releaseCanvas(canvas);
  }
  if (!items.length) return null;
  // A page that was mostly picture but carried a little typed text — a stamp,
  // a number — keeps that text; the recognised words go round it.
  const typed = (pageData && pageData.items ? pageData.items : []).filter((it) => it.str && it.str.trim());
  const merged = typed.length
    ? typed.concat(items.filter((w) => !typed.some((t) => overlaps(t, w))))
    : items;
  const page = PSExtract.pageFromItems(merged, base);
  if (!page.rows.length) return null;
  page.ocr = true;
  page.confidence = averageConfidence(items);
  return page;
}

function overlaps(a, b) {
  const ax1 = a.x + a.w, bx1 = b.x + b.w;
  const x = Math.min(ax1, bx1) - Math.max(a.x, b.x);
  const y = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return x > Math.min(a.w, b.w) * 0.4 && y > Math.min(a.h, b.h) * 0.4;
}

function averageConfidence(items) {
  let sum = 0, n = 0;
  for (const it of items) if (typeof it.confidence === 'number') { sum += it.confidence; n++; }
  return n ? Math.round(sum / n) : null;
}

root.PSOCR = {
  available,
  readPage,
  recognizeCanvas,
  itemsFromResult,
  terminate,
  LANGUAGES,
  DEFAULT_LANGS,
  MIN_CONFIDENCE
};

})(typeof window !== 'undefined' ? window : globalThis);
