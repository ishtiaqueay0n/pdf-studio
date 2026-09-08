'use strict';
/* global pdfjsLib, PDFLib, JSZip, PSExtract */
/*
 * Document-level operations: page management, watermarks, numbering, headers
 * and footers, cropping, imposition, metadata, forms, attachments, redaction
 * and sanitising. Everything here takes and returns raw PDF bytes.
 */
(function (root) {

const { PDFDocument, StandardFonts, PDFName, PDFDict, PDFArray, PDFRef,
        PDFHexString, PDFString, rgb, degrees } = PDFLib;

const PAGE_SIZES = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
  Tabloid: [792, 1224]
};

function normRotation(angle) {
  return ((Math.round((angle || 0) / 90) * 90) % 360 + 360) % 360;
}

function load(bytes) {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

function save(doc) {
  return doc.save({ useObjectStreams: true });
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#000000');
  const v = m ? parseInt(m[1], 16) : 0;
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

/* ------------------------------------------------------------------ *
 * Page plans
 * ------------------------------------------------------------------ */

/**
 * Rebuild a document from a plan. Each entry is
 *   { source: <0-based page index in the input>, rotate: <extra degrees> }
 * or { blank: true, width, height } for an inserted empty page.
 *
 * One plan covers reordering, deleting, duplicating, rotating and inserting,
 * which keeps the organiser's undo history to a single representation.
 */
async function applyPagePlan(bytes, plan) {
  const src = await load(bytes);
  const out = await PDFDocument.create();
  out.setProducer('PDF Studio');

  // A page may appear more than once in a plan, and a copied pdf-lib page can
  // only be added once, so every occurrence gets its own copy.
  const sources = plan.filter((s) => !s.blank).map((s) => s.source);
  const copied = sources.length ? await out.copyPages(src, sources) : [];

  let next = 0;
  for (const step of plan) {
    if (step.blank) {
      out.addPage([step.width || 595.28, step.height || 841.89]);
      continue;
    }
    const page = copied[next++];
    if (!page) continue;
    if (step.rotate) {
      page.setRotation(degrees(normRotation(page.getRotation().angle + step.rotate)));
    }
    out.addPage(page);
  }

  if (!out.getPageCount()) throw new Error('The result would have no pages.');
  copyMetadata(src, out);
  return save(out);
}

function copyMetadata(src, out) {
  try {
    if (src.getTitle && src.getTitle()) out.setTitle(src.getTitle());
    if (src.getAuthor && src.getAuthor()) out.setAuthor(src.getAuthor());
    if (src.getSubject && src.getSubject()) out.setSubject(src.getSubject());
    if (src.getKeywords && src.getKeywords()) out.setKeywords([src.getKeywords()]);
  } catch (e) { /* metadata is optional */ }
}

async function extractPages(bytes, indexes) {
  return applyPagePlan(bytes, indexes.map((i) => ({ source: i })));
}

async function deletePages(bytes, indexes) {
  const drop = new Set(indexes);
  const src = await load(bytes);
  const keep = [];
  for (let i = 0; i < src.getPageCount(); i++) if (!drop.has(i)) keep.push({ source: i });
  if (!keep.length) throw new Error('At least one page has to remain.');
  return applyPagePlan(bytes, keep);
}

async function rotatePages(bytes, indexes, delta) {
  const doc = await load(bytes);
  const pages = doc.getPages();
  const target = indexes && indexes.length ? indexes : pages.map((_, i) => i);
  for (const i of target) {
    const page = pages[i];
    if (!page) continue;
    page.setRotation(degrees(normRotation(page.getRotation().angle + delta)));
  }
  return save(doc);
}

async function reversePages(bytes) {
  const doc = await load(bytes);
  const n = doc.getPageCount();
  return applyPagePlan(bytes, Array.from({ length: n }, (_, i) => ({ source: n - 1 - i })));
}

/* ------------------------------------------------------------------ *
 * Merging and splitting
 * ------------------------------------------------------------------ */

/**
 * @param {Array<{bytes: Uint8Array, pages?: number[]}>} sources
 */
async function mergeDocuments(sources, opts) {
  const o = opts || {};
  const out = await PDFDocument.create();
  out.setProducer('PDF Studio');
  if (o.title) out.setTitle(o.title);

  for (const source of sources) {
    const doc = await load(source.bytes);
    const indexes = source.pages && source.pages.length
      ? source.pages
      : doc.getPageIndices();
    const pages = await out.copyPages(doc, indexes);
    for (const p of pages) out.addPage(p);
    if (o.onProgress) o.onProgress(sources.indexOf(source) + 1, sources.length);
  }
  if (!out.getPageCount()) throw new Error('Nothing to merge.');
  return save(out);
}

/**
 * Split into several documents. `mode` is 'every' (chunks of `size` pages),
 * 'at' (break before each index in `boundaries`) or 'single'.
 */
async function splitDocument(bytes, opts) {
  const o = Object.assign({ mode: 'every', size: 1, boundaries: [], baseName: 'document' }, opts);
  const doc = await load(bytes);
  const n = doc.getPageCount();

  let groups = [];
  if (o.mode === 'single') {
    groups = Array.from({ length: n }, (_, i) => [i]);
  } else if (o.mode === 'at') {
    const cuts = Array.from(new Set(o.boundaries.filter((b) => b > 0 && b < n))).sort((a, b) => a - b);
    let start = 0;
    for (const cut of cuts.concat([n])) {
      if (cut > start) groups.push(Array.from({ length: cut - start }, (_, k) => start + k));
      start = cut;
    }
  } else {
    const size = Math.max(1, o.size);
    for (let i = 0; i < n; i += size) {
      groups.push(Array.from({ length: Math.min(size, n - i) }, (_, k) => i + k));
    }
  }
  if (groups.length < 2) throw new Error('Those settings produce only one document.');

  const zip = new JSZip();
  for (let g = 0; g < groups.length; g++) {
    const part = await extractPages(bytes, groups[g]);
    const first = groups[g][0] + 1;
    const last = groups[g][groups[g].length - 1] + 1;
    const label = first === last ? String(first) : first + '-' + last;
    zip.file(o.baseName + '-pages-' + label + '.pdf', part);
    if (o.onProgress) o.onProgress(g + 1, groups.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  return { blob, filename: o.baseName + '-split.zip', parts: groups.length };
}

/* ------------------------------------------------------------------ *
 * Cropping and imposition
 * ------------------------------------------------------------------ */

/**
 * Crop pages. `box` holds fractions of the page (0..1) measured from the
 * top-left, so one box can be applied to pages of differing sizes.
 */
async function cropPages(bytes, box, indexes) {
  const doc = await load(bytes);
  const pages = doc.getPages();
  const target = indexes && indexes.length ? indexes : pages.map((_, i) => i);
  for (const i of target) {
    const page = pages[i];
    if (!page) continue;
    const { width, height } = page.getSize();
    const media = page.getMediaBox();
    const left = media.x + box.left * width;
    const bottom = media.y + (1 - box.top - box.height) * height;
    const w = Math.max(1, box.width * width);
    const h = Math.max(1, box.height * height);
    page.setCropBox(left, bottom, w, h);
    if (box.hard) page.setMediaBox(left, bottom, w, h);
  }
  return save(doc);
}

/**
 * Scale pages by a percentage, or fit them to a named paper size. Vector
 * content stays vector, so this is lossless.
 */
async function resizePages(bytes, preset, percent) {
  const doc = await load(bytes);
  for (const page of doc.getPages()) {
    if (preset === 'pct') {
      const f = (percent || 100) / 100;
      page.scale(f, f);
      continue;
    }
    const fmt = PAGE_SIZES[preset];
    if (!fmt) continue;
    const size = page.getSize();
    let targetW = fmt[0], targetH = fmt[1];
    if ((size.width > size.height) !== (targetW > targetH)) {
      targetW = fmt[1];
      targetH = fmt[0];
    }
    const f = Math.min(targetW / size.width, targetH / size.height);
    page.scale(f, f);
    page.setMediaBox(0, 0, targetW, targetH);
    page.setCropBox(0, 0, targetW, targetH);
    page.translateContent((targetW - size.width * f) / 2, (targetH - size.height * f) / 2);
  }
  return save(doc);
}

/**
 * A plain re-save. pdf-lib rewrites the object structure with object streams,
 * which usually shaves a little off without touching quality.
 */
async function resaveLossless(bytes) {
  const doc = await load(bytes);
  return save(doc);
}

/**
 * Place several source pages on each sheet (2-up, 4-up, ...).
 */
async function nUp(bytes, opts) {
  const o = Object.assign({ perSheet: 2, pageSize: 'A4', margin: 18, gap: 10, border: false }, opts);
  const src = await load(bytes);
  const out = await PDFDocument.create();
  out.setProducer('PDF Studio');

  const per = [2, 4, 6, 8, 9, 16].includes(o.perSheet) ? o.perSheet : 2;
  const grid = { 2: [1, 2], 4: [2, 2], 6: [2, 3], 8: [2, 4], 9: [3, 3], 16: [4, 4] }[per];
  const cols = grid[0], rows = grid[1];

  const size = PAGE_SIZES[o.pageSize] || PAGE_SIZES.A4;
  const landscape = o.orientation === 'landscape' || (per === 2 && o.orientation !== 'portrait');
  const sheetW = landscape ? size[1] : size[0];
  const sheetH = landscape ? size[0] : size[1];

  const indices = src.getPageIndices();
  const embedded = await out.embedPages(src.getPages());

  const cellW = (sheetW - o.margin * 2 - o.gap * (cols - 1)) / cols;
  const cellH = (sheetH - o.margin * 2 - o.gap * (rows - 1)) / rows;

  for (let i = 0; i < indices.length; i += per) {
    const sheet = out.addPage([sheetW, sheetH]);
    for (let k = 0; k < per && i + k < indices.length; k++) {
      const ep = embedded[i + k];
      const col = k % cols;
      const row = Math.floor(k / cols);
      const scale = Math.min(cellW / ep.width, cellH / ep.height);
      const w = ep.width * scale;
      const h = ep.height * scale;
      const x = o.margin + col * (cellW + o.gap) + (cellW - w) / 2;
      const y = sheetH - o.margin - (row + 1) * cellH - row * o.gap + (cellH - h) / 2;
      sheet.drawPage(ep, { x, y, xScale: scale, yScale: scale });
      if (o.border) {
        sheet.drawRectangle({
          x, y, width: w, height: h,
          borderColor: rgb(0.75, 0.76, 0.8), borderWidth: 0.5
        });
      }
    }
  }
  return save(out);
}

/* ------------------------------------------------------------------ *
 * Watermarks
 * ------------------------------------------------------------------ */

const WATERMARK_POSITIONS = {
  center: [0.5, 0.5], 'top-left': [0.12, 0.88], 'top-center': [0.5, 0.9],
  'top-right': [0.88, 0.88], 'bottom-left': [0.12, 0.12],
  'bottom-center': [0.5, 0.1], 'bottom-right': [0.88, 0.12]
};

/**
 * Stamp text or an image across the chosen pages.
 *
 * `behind: true` rebuilds each page with the mark underneath the existing
 * content, which also drops interactive annotations from those pages.
 */
async function addWatermark(bytes, opts) {
  const o = Object.assign({
    type: 'text', text: 'CONFIDENTIAL', fontSize: 54, color: '#ff2d55', opacity: 0.18,
    rotation: 45, position: 'center', tile: false, tileGap: 1.6, behind: false,
    bold: true, scale: 0.5
  }, opts);

  let doc = await load(bytes);
  let pages = doc.getPages();
  const targets = new Set(o.pages && o.pages.length ? o.pages : pages.map((_, i) => i));

  if (o.behind) {
    const out = await PDFDocument.create();
    out.setProducer('PDF Studio');
    const embedded = await out.embedPages(pages);
    for (let i = 0; i < pages.length; i++) {
      const { width, height } = pages[i].getSize();
      const sheet = out.addPage([width, height]);
      sheet.setRotation(pages[i].getRotation());
      sheet.drawPage(embedded[i]);
    }
    doc = out;
    pages = out.getPages();
  }

  const font = await doc.embedFont(o.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
  let image = null;
  if (o.type === 'image' && o.imageData) {
    image = /^data:image\/jpe?g/i.test(o.imageData)
      ? await doc.embedJpg(o.imageData)
      : await doc.embedPng(o.imageData);
  }
  if (o.type === 'image' && !image) throw new Error('Choose a watermark image first.');

  const text = o.type === 'text'
    ? String(o.text || '').replace(/[^\x20-\x7E -ÿ]/g, '?')
    : '';
  if (o.type === 'text' && !text.trim()) throw new Error('Enter some watermark text.');

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (!targets.has(i)) continue;
    const { width, height } = page.getSize();

    const drawOne = (cx, cy) => {
      if (image) {
        const w = width * o.scale;
        const h = w * (image.height / image.width);
        page.drawImage(image, {
          x: cx - w / 2, y: cy - h / 2, width: w, height: h,
          opacity: o.opacity, rotate: degrees(o.rotation)
        });
      } else {
        const w = font.widthOfTextAtSize(text, o.fontSize);
        const rad = (o.rotation * Math.PI) / 180;
        // drawText rotates about its own origin, so shift by half the rotated
        // advance to land the visual centre on (cx, cy).
        const dx = (w / 2) * Math.cos(rad) - (o.fontSize * 0.35) * Math.sin(rad);
        const dy = (w / 2) * Math.sin(rad) + (o.fontSize * 0.35) * Math.cos(rad);
        page.drawText(text, {
          x: cx - dx, y: cy - dy, size: o.fontSize, font,
          color: hexToRgb(o.color), opacity: o.opacity, rotate: degrees(o.rotation)
        });
      }
    };

    if (o.tile) {
      const stepX = width / 3 * (o.tileGap / 1.6);
      const stepY = height / 4 * (o.tileGap / 1.6);
      for (let x = stepX * 0.35; x < width; x += stepX) {
        for (let y = stepY * 0.35; y < height; y += stepY) drawOne(x, y);
      }
    } else {
      const pos = WATERMARK_POSITIONS[o.position] || WATERMARK_POSITIONS.center;
      drawOne(width * pos[0], height * pos[1]);
    }
  }
  return save(doc);
}

/* ------------------------------------------------------------------ *
 * Page numbers, headers and footers
 * ------------------------------------------------------------------ */

function expandTokens(template, ctx) {
  return String(template || '')
    .replace(/\{page\}/gi, String(ctx.page))
    .replace(/\{pages\}/gi, String(ctx.pages))
    .replace(/\{n\}/gi, String(ctx.page))
    .replace(/\{date\}/gi, ctx.date)
    .replace(/\{time\}/gi, ctx.time)
    .replace(/\{filename\}/gi, ctx.filename)
    .replace(/\{bates\}/gi, ctx.bates);
}

/**
 * Draw a header and/or footer band. Tokens: {page} {pages} {date} {time}
 * {filename} {bates}. Bates numbering is just a zero-padded counter with an
 * optional prefix and suffix, so it shares this code path.
 */
async function addHeaderFooter(bytes, opts) {
  const o = Object.assign({
    header: { left: '', center: '', right: '' },
    footer: { left: '', center: '{page} / {pages}', right: '' },
    fontSize: 9, color: '#4a4f5a', margin: 28, filename: 'document.pdf',
    startNumber: 1, bates: { enabled: false, prefix: '', digits: 6, start: 1 },
    skipFirst: false, font: 'sans'
  }, opts);

  const doc = await load(bytes);
  const fontName = o.font === 'serif' ? StandardFonts.TimesRoman
    : o.font === 'mono' ? StandardFonts.Courier : StandardFonts.Helvetica;
  const font = await doc.embedFont(fontName);
  const pages = doc.getPages();
  const targets = new Set(o.pages && o.pages.length ? o.pages : pages.map((_, i) => i));
  const now = new Date();
  const colour = hexToRgb(o.color);

  const batesStart = (o.bates && o.bates.start) || 1;

  for (let i = 0; i < pages.length; i++) {
    if (!targets.has(i)) continue;
    if (o.skipFirst && i === 0) continue;
    const page = pages[i];
    const { width, height } = page.getSize();
    // Both counters follow the page's own position, so leaving a page unstamped
    // does not shift the numbering of the pages after it.
    const ctx = {
      page: o.startNumber + i,
      pages: pages.length,
      date: now.toLocaleDateString(),
      time: now.toLocaleTimeString(),
      filename: o.filename,
      bates: (o.bates && o.bates.prefix ? o.bates.prefix : '') +
             String(batesStart + i).padStart((o.bates && o.bates.digits) || 6, '0')
    };

    const bands = [
      { band: o.header, y: height - o.margin },
      { band: o.footer, y: o.margin - o.fontSize * 0.25 }
    ];
    for (const { band, y } of bands) {
      if (!band) continue;
      for (const slot of ['left', 'center', 'right']) {
        const raw = band[slot];
        if (!raw) continue;
        const text = expandTokens(raw, ctx).replace(/[^\x20-\x7E -ÿ]/g, '?');
        if (!text) continue;
        const w = font.widthOfTextAtSize(text, o.fontSize);
        const x = slot === 'left' ? o.margin
          : slot === 'center' ? (width - w) / 2
          : width - o.margin - w;
        page.drawText(text, { x, y, size: o.fontSize, font, color: colour });
      }
    }
  }
  return save(doc);
}

/* ------------------------------------------------------------------ *
 * Metadata
 * ------------------------------------------------------------------ */

async function getMetadata(bytes) {
  const doc = await load(bytes);
  const safe = (fn) => { try { return fn() || ''; } catch (e) { return ''; } };
  return {
    title: safe(() => doc.getTitle()),
    author: safe(() => doc.getAuthor()),
    subject: safe(() => doc.getSubject()),
    keywords: safe(() => doc.getKeywords()),
    creator: safe(() => doc.getCreator()),
    producer: safe(() => doc.getProducer()),
    creationDate: safe(() => { const d = doc.getCreationDate(); return d ? d.toISOString() : ''; }),
    modificationDate: safe(() => { const d = doc.getModificationDate(); return d ? d.toISOString() : ''; }),
    pageCount: doc.getPageCount()
  };
}

async function setMetadata(bytes, meta) {
  const doc = await load(bytes);
  const set = (fn, value) => { try { fn(value); } catch (e) { /* ignore bad values */ } };
  set((v) => doc.setTitle(v), meta.title || '');
  set((v) => doc.setAuthor(v), meta.author || '');
  set((v) => doc.setSubject(v), meta.subject || '');
  set((v) => doc.setKeywords(
    String(meta.keywords || '').split(/[,;]\s*/).filter(Boolean)
  ), null);
  set((v) => doc.setCreator(v), meta.creator || 'PDF Studio');
  set((v) => doc.setProducer(v), meta.producer || 'PDF Studio');
  if (meta.creationDate) set((v) => doc.setCreationDate(v), new Date(meta.creationDate));
  set((v) => doc.setModificationDate(v), new Date());
  return save(doc);
}

/* ------------------------------------------------------------------ *
 * Forms
 * ------------------------------------------------------------------ */

function fieldKind(field) {
  const name = field.constructor && field.constructor.name;
  if (/TextField/.test(name)) return 'text';
  if (/CheckBox/.test(name)) return 'checkbox';
  if (/RadioGroup/.test(name)) return 'radio';
  if (/Dropdown/.test(name)) return 'dropdown';
  if (/OptionList/.test(name)) return 'optionlist';
  if (/Button/.test(name)) return 'button';
  if (/Signature/.test(name)) return 'signature';
  return 'unknown';
}

async function readForm(bytes) {
  const doc = await load(bytes);
  let form;
  try { form = doc.getForm(); } catch (e) { return { fields: [] }; }
  const fields = [];
  for (const field of form.getFields()) {
    const kind = fieldKind(field);
    const entry = { name: field.getName(), kind, value: '', options: [], readOnly: false };
    try { entry.readOnly = field.isReadOnly(); } catch (e) { /* optional */ }
    try {
      if (kind === 'text') entry.value = field.getText() || '';
      else if (kind === 'checkbox') entry.value = field.isChecked();
      else if (kind === 'radio') {
        entry.value = field.getSelected() || '';
        entry.options = field.getOptions();
      } else if (kind === 'dropdown') {
        entry.value = (field.getSelected() || [])[0] || '';
        entry.options = field.getOptions();
      } else if (kind === 'optionlist') {
        entry.value = (field.getSelected() || []).join(', ');
        entry.options = field.getOptions();
      }
    } catch (e) { /* some fields refuse to report a value */ }
    fields.push(entry);
  }
  return { fields };
}

async function fillForm(bytes, values, opts) {
  const o = opts || {};
  const doc = await load(bytes);
  const form = doc.getForm();
  const problems = [];
  for (const field of form.getFields()) {
    const name = field.getName();
    if (!(name in values)) continue;
    const value = values[name];
    try {
      const kind = fieldKind(field);
      if (kind === 'text') field.setText(String(value == null ? '' : value));
      else if (kind === 'checkbox') { value ? field.check() : field.uncheck(); }
      else if (kind === 'radio' && value) field.select(String(value));
      else if (kind === 'dropdown' && value) field.select(String(value));
      else if (kind === 'optionlist' && value) {
        field.select(String(value).split(/,\s*/).filter(Boolean));
      }
    } catch (err) {
      problems.push(name + ': ' + ((err && err.message) || err));
    }
  }
  if (o.flatten) {
    try { form.flatten(); } catch (err) { problems.push('Flatten failed: ' + err.message); }
  }
  return { bytes: await save(doc), problems };
}

async function flattenForm(bytes) {
  const doc = await load(bytes);
  try {
    doc.getForm().flatten();
  } catch (err) {
    throw new Error('This document has no fillable form, or it could not be flattened.');
  }
  return save(doc);
}

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */

async function addAttachment(bytes, file) {
  const doc = await load(bytes);
  await doc.attach(new Uint8Array(await file.arrayBuffer()), file.name, {
    mimeType: file.type || 'application/octet-stream',
    description: 'Attached with PDF Studio',
    creationDate: new Date(),
    modificationDate: new Date()
  });
  return save(doc);
}

function nameTreeEntries(context, node, out) {
  if (!node || !node.get) return;
  const names = node.get(PDFName.of('Names'));
  if (names && names.size) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const key = context.lookup(names.get(i));
      const value = context.lookup(names.get(i + 1));
      const label = key instanceof PDFHexString || key instanceof PDFString
        ? key.decodeText ? key.decodeText() : String(key)
        : String(key);
      out.push({ name: label, spec: value });
    }
  }
  const kids = node.get(PDFName.of('Kids'));
  if (kids && kids.size) {
    for (let i = 0; i < kids.size(); i++) {
      nameTreeEntries(context, context.lookup(kids.get(i)), out);
    }
  }
}

async function listAttachments(bytes) {
  const doc = await load(bytes);
  const context = doc.context;
  const catalog = doc.catalog;
  const namesDict = catalog.get(PDFName.of('Names'));
  const resolvedNames = namesDict instanceof PDFRef ? context.lookup(namesDict) : namesDict;
  if (!resolvedNames || !resolvedNames.get) return [];
  const embedded = context.lookup(resolvedNames.get(PDFName.of('EmbeddedFiles')));
  const raw = [];
  nameTreeEntries(context, embedded, raw);

  const out = [];
  for (const entry of raw) {
    const spec = entry.spec;
    if (!spec || !spec.get) continue;
    const ef = context.lookup(spec.get(PDFName.of('EF')));
    if (!ef || !ef.get) continue;
    const streamRef = ef.get(PDFName.of('F')) || ef.get(PDFName.of('UF'));
    const stream = context.lookup(streamRef);
    if (!stream || !stream.getContents) continue;
    let data;
    try {
      data = PDFLib.decodePDFRawStream
        ? PDFLib.decodePDFRawStream(stream).decode()
        : stream.getContents();
    } catch (e) {
      data = stream.getContents();
    }
    out.push({ name: entry.name, size: data.length, data });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Sanitising
 * ------------------------------------------------------------------ */

// Action types that do something rather than just move the reader somewhere in
// the same file: run script, start a program, post data, play media, or fetch
// another document.
const ACTIVE_ACTIONS = [
  '/JavaScript', '/Launch', '/SubmitForm', '/ImportData', '/ResetForm',
  '/Movie', '/Sound', '/Rendition', '/GoToR', '/GoToE'
];

/**
 * Strip the parts of a PDF that can act on their own: document-level
 * JavaScript, open/additional actions, embedded files, form-field scripts and
 * launch or submit actions on links. Page content and text are untouched.
 */
async function sanitize(bytes) {
  const doc = await load(bytes);
  const context = doc.context;
  const catalog = doc.catalog;
  const removed = [];

  const dropFromDict = (dict, key, label) => {
    if (!dict || !dict.get) return;
    if (dict.get(PDFName.of(key))) {
      dict.delete(PDFName.of(key));
      removed.push(label);
    }
  };

  dropFromDict(catalog, 'OpenAction', 'document open action');
  dropFromDict(catalog, 'AA', 'document additional actions');

  const namesDict = context.lookup(catalog.get(PDFName.of('Names')));
  if (namesDict && namesDict.get) {
    dropFromDict(namesDict, 'JavaScript', 'document JavaScript');
    dropFromDict(namesDict, 'EmbeddedFiles', 'embedded files');
  }
  const dropAction = (dict, label) => {
    if (!dict || !dict.get) return;
    const action = context.lookup(dict.get(PDFName.of('A')));
    if (!action || !action.get) return;
    const type = action.get(PDFName.of('S'));
    const kind = type && type.asString ? type.asString() : '';
    if (ACTIVE_ACTIONS.includes(kind)) {
      dict.delete(PDFName.of('A'));
      removed.push(label + ' ' + kind);
    }
  };

  // XFA lives inside the interactive form dictionary, not on the catalog.
  const acroForm = context.lookup(catalog.get(PDFName.of('AcroForm')));
  if (acroForm && acroForm.get) {
    dropFromDict(acroForm, 'XFA', 'XFA form');
    // Calculation order only lists fields whose actions are about to go.
    dropFromDict(acroForm, 'CO', 'field calculation order');

    /*
     * Field logic lives on the field tree, not only on the widgets drawn on
     * pages. A field that has /Kids is not itself an annotation, so the page
     * walk below never reaches it — and a parent node is exactly where a
     * document puts keystroke, format, validate and calculate JavaScript.
     * Walking the tree is what makes "strip document JavaScript" true.
     *
     * The tree comes from an untrusted file, so it is walked with a visited
     * set and a depth cap: /Kids pointing back at an ancestor would otherwise
     * loop for ever.
     */
    const seen = new Set();
    const stripField = (entry, depth) => {
      if (!entry || depth > 32 || seen.has(entry)) return;
      seen.add(entry);
      const field = context.lookup(entry);
      if (!field || !field.get) return;
      dropFromDict(field, 'AA', 'form field scripts');
      dropAction(field, 'form field action');
      const kids = context.lookup(field.get(PDFName.of('Kids')));
      if (kids && kids.size) {
        for (let i = 0; i < kids.size(); i++) stripField(kids.get(i), depth + 1);
      }
    };
    const fields = context.lookup(acroForm.get(PDFName.of('Fields')));
    if (fields && fields.size) {
      for (let i = 0; i < fields.size(); i++) stripField(fields.get(i), 0);
    }
  }

  for (const page of doc.getPages()) {
    const node = page.node;
    dropFromDict(node, 'AA', 'page actions');
    const annots = context.lookup(node.get(PDFName.of('Annots')));
    if (!annots || !annots.size) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const annot = context.lookup(annots.get(i));
      if (!annot || !annot.get) continue;

      // Some annotation types exist only to play or run something.
      const subtypeName = annot.get(PDFName.of('Subtype'));
      const subtype = subtypeName && subtypeName.asString ? subtypeName.asString() : '';
      if (['/Screen', '/Movie', '/Sound', '/RichMedia', '/3D', '/FileAttachment'].includes(subtype)) {
        annots.remove(i);
        removed.push('annotation ' + subtype);
        continue;
      }

      dropFromDict(annot, 'AA', 'annotation actions');
      dropAction(annot, 'link action');
    }
  }

  return { bytes: await save(doc), removed: Array.from(new Set(removed)) };
}

/* ------------------------------------------------------------------ *
 * Rasterising — used for redaction and full flattening
 * ------------------------------------------------------------------ */

/**
 * Replace pages with pictures of themselves. This is what makes a redaction
 * permanent: the text under a black box is not hidden, it stops existing.
 *
 * @param {Uint8Array} bytes
 * @param {object} opts  { pages, dpi, quality, boxes: { [pageIndex]: [{x,y,w,h,color}] } }
 *                       Box coordinates are in points from the page's top-left.
 */
/**
 * Rebuild a document from an already-open pdf.js document, page by page, as
 * images. Used to unlock a protected file whose objects cannot be rewritten:
 * pdf.js already holds it decrypted, so no password is needed a second time.
 */
async function rebuildFromDocument(source, opts) {
  const o = Object.assign({ dpi: 200, quality: 0.94 }, opts);
  const out = await PDFDocument.create();
  out.setProducer('PDF Studio');
  const scale = o.dpi / 72;

  for (let i = 0; i < source.numPages; i++) {
    const page = await source.getPage(i + 1);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(vp.width));
    canvas.height = Math.max(1, Math.ceil(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const blob = await PSExtract.canvasToBlob(canvas, 'image/jpeg', o.quality);
    const jpg = await out.embedJpg(await blob.arrayBuffer());
    const np = out.addPage([vp.width / scale, vp.height / scale]);
    np.drawImage(jpg, { x: 0, y: 0, width: vp.width / scale, height: vp.height / scale });
    page.cleanup();
    if (o.onProgress) o.onProgress(i + 1, source.numPages);
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!out.getPageCount()) throw new Error('That document has no pages to rebuild.');
  return save(out);
}

async function rasterizePages(bytes, opts) {
  const o = Object.assign({ dpi: 150, quality: 0.92, boxes: null }, opts);
  const task = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const source = await task.promise;
  try {
    const out = await PDFDocument.create();
    out.setProducer('PDF Studio');
    const targets = new Set(o.pages && o.pages.length
      ? o.pages
      : Array.from({ length: source.numPages }, (_, i) => i));

    const original = await load(bytes);
    const keepPages = [];
    for (let i = 0; i < source.numPages; i++) if (!targets.has(i)) keepPages.push(i);
    const copied = keepPages.length ? await out.copyPages(original, keepPages) : [];
    const copiedByIndex = new Map();
    keepPages.forEach((idx, k) => copiedByIndex.set(idx, copied[k]));

    for (let i = 0; i < source.numPages; i++) {
      if (!targets.has(i)) {
        out.addPage(copiedByIndex.get(i));
        if (o.onProgress) o.onProgress(i + 1, source.numPages);
        continue;
      }
      const page = await source.getPage(i + 1);
      const scale = o.dpi / 72;
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(vp.width));
      canvas.height = Math.max(1, Math.ceil(vp.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      const boxes = o.boxes && o.boxes[i];
      if (boxes) {
        for (const b of boxes) {
          ctx.fillStyle = b.color || '#000000';
          ctx.fillRect(b.x * scale, b.y * scale, b.w * scale, b.h * scale);
        }
      }

      const blob = await PSExtract.canvasToBlob(canvas, 'image/jpeg', o.quality);
      const jpg = await out.embedJpg(await blob.arrayBuffer());
      const wPt = vp.width / scale;
      const hPt = vp.height / scale;
      const np = out.addPage([wPt, hPt]);
      np.drawImage(jpg, { x: 0, y: 0, width: wPt, height: hPt });
      page.cleanup();
      if (o.onProgress) o.onProgress(i + 1, source.numPages);
      await new Promise((r) => setTimeout(r, 0));
    }
    return save(out);
  } finally {
    try { source.destroy(); } catch (e) { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ *
 * Outline
 * ------------------------------------------------------------------ */

async function readOutline(pdf) {
  let outline;
  try { outline = await pdf.getOutline(); } catch (e) { return []; }
  if (!outline) return [];

  const resolve = async (items, depth) => {
    const out = [];
    for (const item of items) {
      let pageIndex = null;
      try {
        const dest = typeof item.dest === 'string'
          ? await pdf.getDestination(item.dest)
          : item.dest;
        if (Array.isArray(dest) && dest[0]) {
          pageIndex = await pdf.getPageIndex(dest[0]);
        }
      } catch (e) { /* a bookmark without a resolvable target still lists */ }
      out.push({
        title: item.title || '(untitled)',
        depth,
        pageIndex,
        bold: !!item.bold,
        italic: !!item.italic
      });
      if (item.items && item.items.length) {
        out.push(...await resolve(item.items, depth + 1));
      }
    }
    return out;
  };
  return resolve(outline, 0);
}

root.PSDocOps = {
  applyPagePlan,
  extractPages,
  deletePages,
  rotatePages,
  reversePages,
  mergeDocuments,
  splitDocument,
  cropPages,
  resizePages,
  resaveLossless,
  nUp,
  addWatermark,
  addHeaderFooter,
  getMetadata,
  setMetadata,
  readForm,
  fillForm,
  flattenForm,
  addAttachment,
  listAttachments,
  sanitize,
  rasterizePages,
  rebuildFromDocument,
  readOutline,
  PAGE_SIZES
};

})(typeof window !== 'undefined' ? window : globalThis);
