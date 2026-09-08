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
 */
let current = null;

async function getWorker(langs, onProgress) {
  if (current && current.langs === langs) return current.worker;
  await terminate();
  const worker = await Tesseract.createWorker(langs, 1 /* LSTM only */, {
    workerPath: assetUrl(WORKER),
    corePath: assetUrl(CORE),
    langPath: assetUrl(LANG_DIR),
    // Load the worker straight from the extension instead of wrapping it in a
    // blob: URL, so the page policy does not have to allow blob workers.
    workerBlobURL: false,
    gzip: true,
    logger: onProgress
      ? (m) => { if (m && m.status) onProgress(m.status, typeof m.progress === 'number' ? m.progress : 0); }
      : undefined
  });
  current = { langs, worker };
  return worker;
}

async function terminate() {
  if (!current) return;
  const { worker } = current;
  current = null;
  try { await worker.terminate(); } catch (e) { /* already gone */ }
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
  const worker = await getWorker(o.langs, o.onProgress);
  const result = await worker.recognize(canvas, {}, { blocks: true });
  return itemsFromResult(result && result.data, 72 / (o.dpi || 200));
}

/**
 * Recognised words become the same positioned runs pdf.js would have produced,
 * so groupLines and groupParagraphs can do their usual work on them.
 *
 * `scale` converts image pixels to PDF points.
 */
function itemsFromResult(data, scale) {
  const items = [];
  if (!data) return items;

  const words = [];
  const blocks = data.blocks || [];
  for (const block of blocks) {
    for (const para of (block.paragraphs || [])) {
      for (const line of (para.lines || [])) {
        for (const word of (line.words || [])) words.push(word);
      }
    }
  }
  // Some builds report only a flat word list.
  if (!words.length && data.words) words.push(...data.words);

  for (const w of words) {
    const text = (w.text || '').trim();
    if (!text) continue;
    if (typeof w.confidence === 'number' && w.confidence < MIN_CONFIDENCE) continue;
    const b = w.bbox;
    if (!b) continue;
    const x = b.x0 * scale;
    const y = b.y0 * scale;
    const width = (b.x1 - b.x0) * scale;
    const height = (b.y1 - b.y0) * scale;
    if (width <= 0 || height <= 0) continue;
    // groupLines works from the baseline; the bottom of the box is close
    // enough for text that has already been laid out on a page.
    const size = Math.round(height * 100) / 100;
    items.push({
      str: text,
      x,
      baseline: y + height * 0.82,
      y,
      w: width,
      h: height,
      size,
      angle: 0,
      rotated: false,
      font: 'OCR',
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
  }
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
  const items = await recognizeCanvas(canvas, o);
  if (!items.length) return null;

  const { lines } = PSExtract.groupLines(items);
  if (!lines.length) return null;
  const width = pageData ? pageData.width : (canvas.width * 72) / o.dpi;
  const { paragraphs, bodySize, bodyLeft } = PSExtract.groupParagraphs(lines, width);
  const table = PSExtract.detectTable(lines);

  return Object.assign({}, pageData, {
    items,
    lines,
    paragraphs,
    table,
    bodySize,
    bodyLeft,
    isEmpty: false,
    ocr: true,
    confidence: averageConfidence(items)
  });
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
