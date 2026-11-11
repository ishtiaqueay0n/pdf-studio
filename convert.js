'use strict';
/* global pdfjsLib, PDFLib, docx, XLSX, PptxGenJS, JSZip, PSExtract, PSOCR */
/*
 * Format conversion, in and out of PDF.
 *
 * Out: Word, Excel, PowerPoint, images, HTML, Markdown, plain text, CSV, JSON.
 * In:  images, plain text, Word, Excel/CSV.
 *
 * Every converter returns { blob, filename } and never touches the network.
 * Fidelity notes live next to each converter — a PDF has no paragraphs, no
 * tables and no headings, only positioned glyphs, so all of that is inferred
 * (see extract.js) and none of it is guaranteed to be right.
 *
 * The converters that produce a document to be read — Word, HTML, Markdown,
 * text — all work from the same list of blocks in reading order, built once by
 * flowOf: paragraphs with their runs, tables, pictures and page breaks.
 */
(function (root) {

const { PDFDocument, StandardFonts, rgb } = PDFLib;

const PT_PER_INCH = 72;
const TWIP_PER_PT = 20;
const PX_PER_PT = 96 / 72;
const SAVE_OPTIONS = { useObjectStreams: true, objectsPerTick: Infinity };

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

function baseName(name) {
  return String(name || 'document').replace(/\.[a-z0-9]+$/i, '') || 'document';
}

function noop() {}

function progressFn(opts) {
  return (opts && opts.onProgress) || noop;
}

function pageIndexes(pdf, opts) {
  if (opts && opts.pages && opts.pages.length) return opts.pages.slice().sort((a, b) => a - b);
  return Array.from({ length: pdf.numPages }, (_, i) => i);
}

// pdf-lib's built-in fonts only cover WinAnsi; anything else is replaced so a
// conversion never dies on a single exotic character.
const WIN_ANSI_KEEP =
  /[^\t\n\r\x20-\x7E -ÿ€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g;

function winAnsiSafe(str) {
  return String(str == null ? '' : str).replace(WIN_ANSI_KEEP, '?');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function rowsToCsv(rows, delimiter) {
  const d = delimiter || ',';
  return rows.map((r) => r.map(csvCell).join(d)).join('\r\n');
}

function textBlob(text, mime) {
  return new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
}

function canvasDataUrl(canvas, format, quality) {
  return format === 'png'
    ? canvas.toDataURL('image/png')
    : canvas.toDataURL('image/jpeg', quality == null ? 0.82 : quality);
}

function canRender() {
  return typeof document !== 'undefined';
}

async function canvasBytes(canvas, type, quality) {
  const blob = await PSExtract.canvasToBlob(canvas, type || 'image/png', quality);
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * A picture of each page `want(position)` selects, keyed by its position in
 * `indexes` rather than by page number. A page that will not render yields
 * null instead of aborting the whole conversion.
 *
 * With `noText` the picture is the page without its text, for exports that
 * lay real, editable text over it: with the words already in the picture
 * every one of them would be there twice.
 */
async function renderPagePictures(pdf, indexes, opts, want) {
  const o = Object.assign({ dpi: 110, type: 'image/png', quality: 0.86, noText: false }, opts);
  const out = new Array(indexes.length).fill(null);
  if (!canRender()) return out;
  for (let n = 0; n < indexes.length; n++) {
    if (want && !want(n)) continue;
    let page = null;
    let canvas = null;
    try {
      page = await pdf.getPage(indexes[n] + 1);
      canvas = await PSExtract.renderPageToCanvas(page, o.dpi, '#ffffff', {
        noText: o.noText, factory: pdf.psCanvasFactory
      });
      out[n] = {
        data: await canvasBytes(canvas, o.type, o.quality),
        type: o.type === 'image/jpeg' ? 'jpg' : 'png',
        mime: o.type
      };
    } catch (err) {
      if (err && err.name === 'JobCancelled') throw err;
      out[n] = null;
    } finally {
      PSExtract.releaseCanvas(canvas);
      if (page) { try { page.cleanup(); } catch (err) { /* already gone */ } }
    }
    if (o.onProgress) o.onProgress(n + 1, indexes.length);
    await PSExtract.tick();
  }
  return out;
}

/**
 * The pictures and drawings the layout found, cut out of a rendering of their
 * page. Cutting them from the page, rather than digging out the bitmap behind
 * each, gets a drawing made of vectors and a photograph the same way, already
 * clipped, masked and turned as the page shows them.
 *
 * Returns a Map from the layout's picture block to { data, url, width, height }.
 */
async function renderPictures(pdf, doc, opts) {
  const o = Object.assign({ dpi: 160, urls: false }, opts);
  const out = new Map();
  if (!canRender() || o.images === false) return out;
  for (const pageData of doc.pages) {
    const blocks = pageData.blocks.filter((b) => b.type === 'image');
    if (!blocks.length) continue;
    let page = null;
    let canvas = null;
    try {
      page = await pdf.getPage(pageData.index + 1);
      canvas = await PSExtract.renderPageToCanvas(page, o.dpi, '#ffffff');
      const scale = canvas.width / pageData.width;
      for (const block of blocks) {
        const im = block.image;
        const pad = im.kind === 'figure' ? 2 : 0;
        const sx = Math.max(0, Math.floor((im.x - pad) * scale));
        const sy = Math.max(0, Math.floor((im.y - pad) * scale));
        const sw = Math.min(canvas.width - sx, Math.ceil((im.w + pad * 2) * scale));
        const sh = Math.min(canvas.height - sy, Math.ceil((im.h + pad * 2) * scale));
        if (sw < 2 || sh < 2) continue;
        const crop = document.createElement('canvas');
        crop.width = sw;
        crop.height = sh;
        crop.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        out.set(im, {
          data: o.urls ? null : await canvasBytes(crop, 'image/png'),
          url: o.urls ? crop.toDataURL('image/png') : null,
          width: im.w + pad * 2,
          height: im.h + pad * 2
        });
        PSExtract.releaseCanvas(crop);
      }
    } catch (err) {
      if (err && err.name === 'JobCancelled') throw err;
      /* a page that will not render simply carries no pictures */
    } finally {
      PSExtract.releaseCanvas(canvas);
      if (page) { try { page.cleanup(); } catch (err) { /* already gone */ } }
    }
    await PSExtract.tick();
  }
  return out;
}

/*
 * A page carrying no text of its own gets one pass through OCR before a
 * converter gives up on it. It only ever runs on a page that would otherwise
 * convert to nothing, so an ordinary document never pays for it, and it is off
 * when the caller passes ocr: false or the engine is not loaded.
 */
function ocrHook(o) {
  if (!o || o.ocr === false) return null;
  if (typeof PSOCR === 'undefined' || !PSOCR.available()) return null;
  const onProgress = progressFn(o);
  return async (page, data) => {
    try {
      return await PSOCR.readPage(page, data, {
        dpi: o.ocrDpi || 200,
        langs: o.ocrLangs || PSOCR.DEFAULT_LANGS,
        onProgress: (status, fraction) => {
          onProgress(Math.round((fraction || 0) * 100), 100,
            'Page ' + data.number + ': reading the picture — ' + status);
        }
      });
    } catch (err) {
      if (err && err.name === 'JobCancelled') throw err;
      return null; // still unreadable; warningsForDocument says so
    }
  };
}

function readDocument(pdf, o, extra) {
  const onProgress = progressFn(o);
  const indexes = pageIndexes(pdf, o);
  return PSExtract.extractDocument(pdf, Object.assign({
    pages: indexes,
    onProgress: (i, n) => onProgress(i, n + 1, 'Reading page ' + i + ' of ' + n),
    onEmptyPage: ocrHook(o)
  }, extra));
}

function pageHasContent(p) {
  return p.blocks.some((b) => b.type !== 'paragraph' || b.para.text.trim());
}

/**
 * What went wrong that the caller should be told about. Producing a file that
 * is quietly empty is worse than producing one with a warning attached.
 */
function warningsForDocument(doc, note) {
  const warnings = [];
  const unreadable = doc.pages.filter((p) => p.unreadable).map((p) => p.number);
  const scanned = doc.pages.filter((p) => !p.unreadable && !pageHasContent(p)).map((p) => p.number);
  if (unreadable.length) {
    warnings.push('Could not read ' + describePages(unreadable) + ' — ' +
      ((doc.failed && doc.failed.length && doc.failed[0].message) || 'the page was skipped') + '.');
  }
  const recognised = doc.pages.filter((p) => p.ocr).map((p) => p.number);
  if (recognised.length) {
    const one = recognised.length === 1;
    warnings.push(capitalise(describePages(recognised)) +
      (one ? ' had no text of its own and was read by OCR'
           : ' had no text of their own and were read by OCR') +
      ' — check the words against the original before relying on them.');
  }
  if (scanned.length) {
    const one = scanned.length === 1;
    const subject = scanned.length === doc.pages.length
      ? 'No page in this document holds selectable text'
      : capitalise(describePages(scanned)) + (one ? ' holds' : ' hold') + ' no selectable text';
    warnings.push(subject + (one ? ' — it is a scan or a picture. ' : ' — they are scans or pictures. ') +
      (note || 'There was nothing to convert into words.'));
  }
  return warnings;
}

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function describePages(numbers) {
  if (numbers.length === 1) return 'page ' + numbers[0];
  if (numbers.length <= 6) return 'pages ' + numbers.join(', ');
  return numbers.length + ' pages';
}

/* ------------------------------------------------------------------ *
 * The document as a flow
 * ------------------------------------------------------------------ */

function sameStyle(a, b) {
  return a.key === b.key;
}

/** Append the runs of a carried-over paragraph to the runs of its first half. */
function joinRuns(head, tail) {
  const out = head.map((r) => Object.assign({}, r));
  const last = out[out.length - 1];
  const first = tail[0];
  if (!last || !first) return out.concat(tail);
  const joined = PSExtract.joinContinued(last.text, first.text);
  // joinContinued either closed a hyphenated word or put one space between.
  last.text = joined.slice(0, joined.length - first.text.length);
  for (const run of tail) {
    const prev = out[out.length - 1];
    if (sameStyle(prev, run)) prev.text += run.text;
    else out.push(Object.assign({}, run));
  }
  return out;
}

/**
 * Every block of the document in the order it is read, as one list:
 *
 *   { type: 'paragraph', para, runs, text }
 *   { type: 'table', table }
 *   { type: 'image', image }
 *   { type: 'pageimage', index }   a page with nothing readable on it
 *   { type: 'break' }              where a new page began
 *
 * Running headers and footers are left out, and a paragraph that a column or
 * a page had cut in two is one paragraph again.
 */
function flowOf(doc, opts) {
  const o = Object.assign({ dropRunning: true, pageBreaks: true }, opts);
  const out = [];
  let open = null;
  doc.pages.forEach((page, pi) => {
    let started = false;
    const begin = () => {
      if (!started && pi > 0 && o.pageBreaks && out.length) out.push({ type: 'break' });
      started = true;
    };
    for (const block of page.blocks) {
      if (block.type === 'paragraph') {
        const p = block.para;
        if (!p.text.trim()) continue;
        if (o.dropRunning && p.artifact) continue;
        if (p.continues && open) {
          open.runs = joinRuns(open.runs, p.runs);
          open.text = PSExtract.joinContinued(open.text, p.text);
          started = true;       // the page carried straight on; no break belongs here
          continue;
        }
        begin();
        open = { type: 'paragraph', para: p, runs: p.runs, text: p.text, page };
        out.push(open);
      } else if (block.type === 'table') {
        begin();
        out.push({ type: 'table', table: block.table, page });
      } else if (block.type === 'image') {
        begin();
        out.push({ type: 'image', image: block.image, page });
      }
    }
    if (!started) {
      if (pi > 0 && o.pageBreaks && out.length) out.push({ type: 'break' });
      out.push({ type: 'pageimage', index: pi, page });
      open = null;
    }
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * PDF -> Word
 * ------------------------------------------------------------------ */

function hexFromColor(c) {
  return (c || '000000').replace('#', '').toUpperCase();
}

/*
 * Colours travel as '#rrggbb' from extract.js, which builds them from clamped
 * integers. They are still document-derived, so anything that does not look
 * like a hex colour is dropped rather than written into a Word attribute or a
 * CSS declaration.
 */
function isHexColor(c) {
  return /^#[0-9a-f]{6}$/i.test(c || '');
}

/** Word wants 'RRGGBB'. Black is the default, so it is left unsaid. */
function docxColor(c) {
  if (!isHexColor(c)) return undefined;
  const hex = hexFromColor(c);
  return hex === '000000' ? undefined : hex;
}

/** A `color:` declaration, or nothing when the colour is absent or black. */
function cssColor(c) {
  return isHexColor(c) && c.toLowerCase() !== '#000000' ? 'color:' + c.toLowerCase() : '';
}

/** Only web and mail addresses become links; anything else stays as text. */
function safeLink(url) {
  return /^(https?:\/\/|mailto:|ftp:\/\/)[^\s"<>]+$/i.test(url || '') ? url : null;
}

function twip(points) {
  return Math.round(points * TWIP_PER_PT);
}

function docxRun(run, o, base, extra) {
  const D = docx;
  // Word shrinks a superscript itself, so it is given the size of the text it
  // sits in rather than the size it was drawn at.
  const size = run.script ? Math.max(run.size, base || run.size) : run.size;
  const conf = {
    text: run.text,
    bold: run.bold || undefined,
    italics: run.italic || undefined,
    size: Math.round(Math.max(5, size) * 2),
    color: o.color === false ? undefined : docxColor(run.color),
    font: o.font || run.face || 'Arial',
    superScript: run.script === 'sup' || undefined,
    subScript: run.script === 'sub' || undefined,
    underline: run.underline ? {} : undefined
  };
  return new D.TextRun(Object.assign(conf, extra));
}

/** Runs as Word inline content, with neighbouring linked runs under one link. */
function docxInline(runs, o, base, firstExtra) {
  const D = docx;
  const out = [];
  let i = 0;
  let first = true;
  while (i < runs.length) {
    const link = safeLink(runs[i].link);
    const extraFor = () => {
      const e = first ? firstExtra : undefined;
      first = false;
      return e;
    };
    if (!link) {
      out.push(docxRun(runs[i], o, base, extraFor()));
      i++;
      continue;
    }
    const kids = [];
    while (i < runs.length && runs[i].link === runs[i - kids.length].link && safeLink(runs[i].link)) {
      kids.push(docxRun(runs[i], o, base, Object.assign({ color: '0563C1', underline: {} }, extraFor())));
      i++;
    }
    out.push(new D.ExternalHyperlink({ link, children: kids }));
  }
  return out;
}

function docxAlignment(align) {
  const D = docx;
  if (align === 'center') return D.AlignmentType.CENTER;
  if (align === 'right') return D.AlignmentType.RIGHT;
  if (align === 'justify') return D.AlignmentType.BOTH;
  return D.AlignmentType.LEFT;
}

const DOCX_HEADINGS = [null, 'Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6'];

function docxParagraph(entry, o) {
  const D = docx;
  const p = entry.para;
  const conf = {
    children: docxInline(entry.runs, o, p.size),
    alignment: docxAlignment(p.align),
    spacing: { after: 120 }
  };
  // Text set with wide leading — double-spaced, say — keeps it. Single
  // spacing in Word is about 1.2 times the size of the type.
  if (p.leading >= 1.45) conf.spacing.line = Math.round(Math.min(3, p.leading / 1.2) * 240);

  if (p.heading && DOCX_HEADINGS[p.heading]) {
    conf.heading = DOCX_HEADINGS[p.heading];
    conf.spacing.before = 200;
    conf.keepNext = true;
  } else if (p.bullet) {
    const level = Math.min(p.listLevel || 0, 8);
    conf.spacing.after = 60;
    if (p.ordered) {
      /*
       * The number is written out rather than left to Word's own numbering.
       * A list that starts at 4, or runs (a), (b), (c), then stays exactly as
       * it was, and two separate lists cannot run on into one.
       */
      const lead = entry.runs[0] || { size: p.size, face: p.face, color: p.color };
      conf.children.unshift(new D.TextRun({
        children: [p.marker, new D.Tab()],
        size: Math.round(Math.max(5, lead.size) * 2),
        font: o.font || lead.face || 'Arial',
        color: o.color === false ? undefined : docxColor(lead.color)
      }));
      conf.indent = { left: 540 + 360 * level, hanging: 400 };
    } else {
      conf.bullet = { level };
    }
  } else if (p.align === 'left' || p.align === 'justify') {
    const em = p.size;
    const indent = {};
    if (p.left > em * 0.75) indent.left = twip(Math.min(p.left, 216));
    if (p.indent > em * 0.4) indent.firstLine = twip(Math.min(p.indent, 72));
    else if (p.indent < -em * 0.4) {
      indent.hanging = twip(Math.min(-p.indent, 72));
      indent.left = (indent.left || 0) + indent.hanging;
    }
    if (indent.left || indent.firstLine || indent.hanging) conf.indent = indent;
  }
  return new D.Paragraph(conf);
}

function docxTable(table, o) {
  const D = docx;
  const widths = [];
  for (let c = 0; c < table.ncols; c++) widths.push(Math.max(18, table.colX[c + 1] - table.colX[c]));
  const total = widths.reduce((a, b) => a + b, 0);
  const fit = o.availWidth && total > o.availWidth ? o.availWidth / total : 1;
  const colTwips = widths.map((w) => twip(w * fit));

  const line = table.ruled
    ? { style: D.BorderStyle.SINGLE, size: 4, color: '808080' }
    : { style: D.BorderStyle.NONE, size: 0, color: 'auto' };

  const rows = table.cells.map((row, r) => new D.TableRow({
    tableHeader: r < table.header || undefined,
    cantSplit: true,
    children: row.filter(Boolean).map((cell) => {
      const runs = PSExtract.buildRuns(cell.lines);
      let width = 0;
      for (let c = cell.col; c < cell.col + cell.colspan; c++) width += colTwips[c] || 0;
      return new D.TableCell({
        width: { size: width, type: D.WidthType.DXA },
        columnSpan: cell.colspan > 1 ? cell.colspan : undefined,
        rowSpan: cell.rowspan > 1 ? cell.rowspan : undefined,
        margins: { top: 40, bottom: 40, left: 80, right: 80 },
        children: [new D.Paragraph({
          alignment: docxAlignment(cell.align),
          spacing: { after: 0 },
          children: runs.length ? docxInline(runs, o, runs[0].size) : []
        })]
      });
    })
  }));

  return new D.Table({
    rows,
    width: { size: colTwips.reduce((a, b) => a + b, 0), type: D.WidthType.DXA },
    columnWidths: colTwips,
    layout: D.TableLayoutType.FIXED,
    borders: {
      top: line, bottom: line, left: line, right: line,
      insideHorizontal: line, insideVertical: line
    }
  });
}

function docxPicture(pic, maxWidth) {
  const D = docx;
  const scale = Math.min(1, maxWidth / Math.max(1, pic.width));
  return new D.Paragraph({
    alignment: D.AlignmentType.CENTER,
    spacing: { before: 80, after: 120 },
    children: [new D.ImageRun({
      data: pic.data,
      type: pic.type || 'png',
      transformation: {
        width: Math.round(pic.width * scale * PX_PER_PT),
        height: Math.round(pic.height * scale * PX_PER_PT)
      }
    })]
  });
}

function docxFlowChildren(flow, o, pictures, pageImages) {
  const D = docx;
  const children = [];
  let pendingBreak = false;
  const add = (node) => {
    if (pendingBreak) {
      children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
      pendingBreak = false;
    }
    children.push(node);
  };
  for (const entry of flow) {
    if (entry.type === 'break') {
      pendingBreak = true;
    } else if (entry.type === 'paragraph') {
      add(docxParagraph(entry, o));
    } else if (entry.type === 'table') {
      add(docxTable(entry.table, o));
      children.push(new D.Paragraph({ spacing: { after: 60 }, children: [] }));
    } else if (entry.type === 'image') {
      const pic = pictures.get(entry.image);
      if (pic) add(docxPicture(pic, o.availWidth));
    } else if (entry.type === 'pageimage') {
      // A page with no text at all — a scan, or one pdf.js could not read. A
      // picture of it is not editable text, but it is the content.
      const img = pageImages && pageImages[entry.index];
      if (img) {
        add(docxPicture({
          data: img.data, type: img.type, width: entry.page.width, height: entry.page.height
        }, o.availWidth));
      } else {
        add(new D.Paragraph({ children: [] }));
      }
    }
  }
  if (!children.length) children.push(new D.Paragraph({ children: [] }));
  return children;
}

function floatingAt(x, y, behind) {
  const D = docx;
  return {
    horizontalPosition: { relative: D.HorizontalPositionRelativeFrom.PAGE, offset: Math.round(x * 12700) },
    verticalPosition: { relative: D.VerticalPositionRelativeFrom.PAGE, offset: Math.round(y * 12700) },
    behindDocument: behind !== false,
    allowOverlap: true,
    zIndex: 0
  };
}

/*
 * One box of text per paragraph and per table cell, placed where it sat on the
 * page, with a line break wherever the original broke. That keeps the look of
 * the page while leaving each paragraph one thing to click into and retype,
 * rather than a stack of single lines.
 */
function docxLayoutSections(doc, o, backgrounds, pictures, pageImages) {
  const D = docx;
  return doc.pages.map((page, pi) => {
    const children = [];
    const floats = [];
    const bg = backgrounds && backgrounds[pi];
    if (bg) {
      floats.push(new D.ImageRun({
        data: bg.data,
        type: bg.type,
        transformation: {
          width: Math.round(page.width * PX_PER_PT), height: Math.round(page.height * PX_PER_PT)
        },
        floating: floatingAt(0, 0)
      }));
    } else {
      for (const block of page.blocks) {
        if (block.type !== 'image') continue;
        const pic = pictures.get(block.image);
        if (!pic) continue;
        floats.push(new D.ImageRun({
          data: pic.data,
          type: 'png',
          transformation: {
            width: Math.round(pic.width * PX_PER_PT), height: Math.round(pic.height * PX_PER_PT)
          },
          floating: floatingAt(block.image.x, block.image.y)
        }));
      }
    }
    if (floats.length) children.push(new D.Paragraph({ children: floats }));

    for (const b of PSExtract.textBlocks(page)) {
      if (!b.text.trim()) continue;
      // The invisible layer under a scan would print on top of the scan.
      if (bg && b.invisible) continue;
      const lines = b.lines;
      const size = b.size;
      const pitch = lines.length > 1
        ? (lines[lines.length - 1].baseline - lines[0].baseline) / (lines.length - 1)
        : size * 1.2;
      const kids = [];
      lines.forEach((line, li) => {
        const runs = PSExtract.lineRuns(line);
        for (const node of docxInline(runs, o, size, li > 0 ? { break: 1 } : undefined)) kids.push(node);
      });
      // A substituted face runs a little wider or narrower than the original;
      // the slack keeps a line from wrapping, and goes on the side the text
      // does not hang from.
      const slack = b.align === 'justify' ? 1 : size * 1.5;
      const x = b.align === 'right' ? b.x - slack : b.align === 'center' ? b.x - slack / 2 : b.x;
      children.push(new D.Paragraph({
        frame: {
          type: 'absolute',
          position: { x: twip(Math.max(0, x)), y: twip(Math.max(0, lines[0].baseline - pitch * 0.8)) },
          width: twip(b.w + slack),
          height: twip(pitch * lines.length + size * 0.3),
          anchor: { horizontal: D.FrameAnchorType.PAGE, vertical: D.FrameAnchorType.PAGE },
          wrap: 'none'
        },
        alignment: docxAlignment(b.align),
        spacing: { before: 0, after: 0, line: twip(Math.max(pitch, size)), lineRule: D.LineRuleType.EXACT },
        children: kids
      }));
    }

    if (!children.length) {
      const img = pageImages && pageImages[pi];
      children.push(img
        ? docxPicture({ data: img.data, type: img.type, width: page.width, height: page.height }, page.width)
        : new D.Paragraph({ children: [] }));
    }
    return {
      properties: {
        type: pi === 0 ? undefined : D.SectionType.NEXT_PAGE,
        page: {
          size: {
            width: twip(page.width),
            height: twip(page.height),
            orientation: page.width > page.height
              ? D.PageOrientation.LANDSCAPE
              : D.PageOrientation.PORTRAIT
          },
          margin: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0, gutter: 0 }
        }
      },
      children
    };
  });
}

/** The margins the text was set inside, for the pages of a reflowed document. */
function flowMargins(doc) {
  const lefts = [], rights = [];
  for (const p of doc.pages) {
    if (!p.paragraphs.length || !p.frame) continue;
    lefts.push(p.frame.x0);
    rights.push(p.width - p.frame.x1);
  }
  const mid = (v, fallback) => {
    if (!v.length) return fallback;
    v.sort((a, b) => a - b);
    return Math.min(108, Math.max(36, v[Math.floor(v.length / 2)]));
  };
  return { left: mid(lefts, 60), right: mid(rights, 60) };
}

/**
 * PDF -> .docx
 *
 * mode 'flow'   — reflowable paragraphs, headings, lists, tables and
 *                 pictures, in reading order. Best for editing; the page
 *                 layout itself is not preserved.
 * mode 'layout' — every paragraph and table cell becomes a box placed where
 *                 it sat, so the page looks close to the original but is
 *                 awkward to restructure.
 */
async function toDocx(pdf, opts) {
  const o = Object.assign({ mode: 'flow', tables: true, background: false, dpi: 110 }, opts);
  const onProgress = progressFn(o);
  const indexes = pageIndexes(pdf, o);
  onProgress(0, indexes.length + 1, 'Reading text');
  const doc = await readDocument(pdf, o, { detectTables: o.tables !== false });
  const warnings = warningsForDocument(doc, 'A picture of each was used instead.');
  const layout = o.mode === 'layout';

  let backgrounds = null;
  if (layout && o.background) {
    onProgress(indexes.length, indexes.length + 1, 'Drawing the pages');
    backgrounds = await renderPagePictures(pdf, indexes, {
      dpi: Math.max(o.dpi, 130), type: 'image/jpeg', quality: 0.88, noText: true
    }, () => true);
  }
  const pictures = backgrounds ? new Map() : await renderPictures(pdf, doc, o);

  // Pages that carry no text at all used to come out as an empty Word page
  // with no explanation.
  let pageImages = null;
  if (o.imageFallback !== false) {
    const empty = doc.pages.map((p) => !pageHasContent(p));
    if (empty.some(Boolean)) {
      pageImages = await renderPagePictures(pdf, indexes, { dpi: o.dpi }, (n) => empty[n]);
    }
  }

  const D = docx;
  const first = doc.pages[0] || { width: 595, height: 842 };
  let sections;
  if (layout) {
    sections = docxLayoutSections(doc, o, backgrounds, pictures, pageImages);
  } else {
    const margins = flowMargins(doc);
    o.availWidth = first.width - margins.left - margins.right;
    sections = [{
      properties: {
        page: {
          size: {
            width: twip(first.width),
            height: twip(first.height),
            orientation: first.width > first.height
              ? D.PageOrientation.LANDSCAPE
              : D.PageOrientation.PORTRAIT
          },
          margin: { top: twip(54), bottom: twip(54), left: twip(margins.left), right: twip(margins.right) }
        }
      },
      children: docxFlowChildren(flowOf(doc, o), o, pictures, pageImages)
    }];
  }

  const body = Math.round((doc.bodySize || 11) * 2);
  const document = new D.Document({
    creator: 'PDF Studio',
    title: o.title || baseName(o.filename),
    description: 'Converted from PDF by PDF Studio',
    styles: { default: { document: { run: { size: body, font: 'Arial' } } } },
    sections
  });
  onProgress(indexes.length + 1, indexes.length + 1, 'Writing document');
  const blob = await D.Packer.toBlob(document);
  return { blob, filename: baseName(o.filename) + '.docx', warnings };
}

/* ------------------------------------------------------------------ *
 * PDF -> Excel
 * ------------------------------------------------------------------ */

const BENGALI_DIGITS = /[০-৯]/g;

/**
 * Read a cell as a number, if it is unmistakably one.
 *
 * Returns { v, z } — the value and a number format that shows it the way it
 * was printed — or null when the text should stay text. It is deliberately
 * hard to please: a part number with a leading zero, a telephone number and a
 * figure too long to hold exactly all stay as they are, because turning
 * "00123" into 123 loses something nobody can put back.
 */
function parseNumber(text) {
  let s = String(text == null ? '' : text).trim()
    .replace(BENGALI_DIGITS, (d) => String(d.charCodeAt(0) - 0x09E6))
    .replace(/[   ]/g, ' ');
  if (!s || !/\d/.test(s)) return null;
  let negative = false;
  let percent = false;
  let currency = '';
  if (/^\(.+\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  if (/^[-−–]/.test(s)) { negative = !negative; s = s.slice(1).trim(); }
  const cur = /^([$€£¥৳₹])\s*/.exec(s);
  if (cur) { currency = cur[1]; s = s.slice(cur[0].length); }
  if (/^[-−–]/.test(s)) { negative = !negative; s = s.slice(1).trim(); }
  if (/%$/.test(s)) { percent = true; s = s.slice(0, -1).trim(); }

  let digits = null;
  let grouped = false;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) || /^\d{1,2}(,\d{2})+,\d{3}(\.\d+)?$/.test(s)) {
    digits = s.replace(/,/g, '');             // 1,234,567.89 and 12,34,567.89
    grouped = true;
  } else if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) {
    digits = s.replace(/\./g, '').replace(',', '.');   // 1.234.567,89
    grouped = true;
  } else if (/^\d{1,3}( \d{3})+([.,]\d+)?$/.test(s)) {
    digits = s.replace(/ /g, '').replace(',', '.');    // 1 234 567,89
    grouped = true;
  } else if (/^\d+(\.\d+)?$/.test(s)) {
    if (/^0\d/.test(s)) return null;                    // 007, 00123
    digits = s;
  } else if (/^\d+,\d{1,2}$/.test(s)) {
    if (/^0\d/.test(s)) return null;
    digits = s.replace(',', '.');                       // 12,50
  } else {
    return null;
  }
  const whole = digits.split('.')[0];
  if (whole.length > 15) return null;
  let v = Number(digits);
  if (!isFinite(v)) return null;
  const decimals = (digits.split('.')[1] || '').length;
  const frac = decimals ? '.' + '0'.repeat(Math.min(decimals, 8)) : '';
  let z = (grouped || currency ? '#,##0' : '0') + frac;
  if (percent) { v = v / 100; z = '0' + frac + '%'; }
  if (currency) z = '"' + currency + '"' + z;
  if (negative) v = -v;
  if (!percent && !currency && !grouped && !decimals) z = null;   // a plain whole number
  return { v, z };
}

function sheetCell(text, numbers) {
  const s = String(text == null ? '' : text);
  if (numbers) {
    const n = parseNumber(s);
    if (n) return n.z ? { t: 'n', v: n.v, z: n.z } : n.v;
  }
  return s;
}

/**
 * PDF -> .xlsx
 *
 * mode 'tables' — one sheet per page holding the detected tables.
 * mode 'lines'  — one sheet per page, one row per text line.
 * mode 'single' — every page appended to a single sheet.
 */
async function toXlsx(pdf, opts) {
  const o = Object.assign({ mode: 'tables', numbers: true, sheetPerPage: true }, opts);
  const doc = await readDocument(pdf, o, { detectTables: o.mode !== 'lines' });

  const wb = XLSX.utils.book_new();
  const usedNames = new Set();
  const sheetName = (want) => {
    let name = String(want).replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'Sheet';
    let i = 2;
    while (usedNames.has(name)) name = (String(want).slice(0, 24) + ' ' + i++).trim();
    usedNames.add(name);
    return name;
  };

  // The rows of a page, and the cells its merged cells cover.
  const pageRows = (page) => {
    const rows = [];
    const merges = [];
    if (page.tables && page.tables.length) {
      page.tables.forEach((table, ti) => {
        if (ti > 0) rows.push([]);
        const base = rows.length;
        table.cells.forEach((row) => {
          rows.push(row.map((cell) => (cell ? sheetCell(cell.text, o.numbers) : '')));
          for (const cell of row) {
            if (cell && (cell.rowspan > 1 || cell.colspan > 1)) {
              merges.push({
                s: { r: base + cell.row, c: cell.col },
                e: { r: base + cell.row + cell.rowspan - 1, c: cell.col + cell.colspan - 1 }
              });
            }
          }
        });
      });
    } else {
      for (const row of PSExtract.pageToGrid(page)) rows.push(row.map((c) => sheetCell(c, o.numbers)));
    }
    return { rows, merges };
  };

  const finishSheet = (rows, merges) => {
    const ws = XLSX.utils.aoa_to_sheet(rows.length ? rows : [['']]);
    const widths = [];
    for (const row of rows) {
      row.forEach((cell, c) => {
        const shown = cell && typeof cell === 'object' ? String(cell.v) : String(cell == null ? '' : cell);
        widths[c] = Math.min(60, Math.max(widths[c] || 8, shown.length + 2));
      });
    }
    ws['!cols'] = widths.map((w) => ({ wch: w || 8 }));
    if (merges.length) ws['!merges'] = merges;
    return ws;
  };

  if (o.mode === 'single' || !o.sheetPerPage) {
    const all = [];
    const merges = [];
    for (const page of doc.pages) {
      if (doc.pages.length > 1) all.push(['Page ' + page.number]);
      const part = pageRows(page);
      for (const m of part.merges) {
        merges.push({ s: { r: m.s.r + all.length, c: m.s.c }, e: { r: m.e.r + all.length, c: m.e.c } });
      }
      for (const row of part.rows) all.push(row);
      all.push([]);
    }
    XLSX.utils.book_append_sheet(wb, finishSheet(all, merges), sheetName('Document'));
  } else {
    for (const page of doc.pages) {
      const part = pageRows(page);
      XLSX.utils.book_append_sheet(wb, finishSheet(part.rows, part.merges), sheetName('Page ' + page.number));
    }
  }

  if (!wb.SheetNames.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['']]), 'Sheet1');
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
  return {
    blob: new Blob([out], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }),
    filename: baseName(o.filename) + '.xlsx',
    warnings: warningsForDocument(doc)
  };
}

/* ------------------------------------------------------------------ *
 * PDF -> PowerPoint
 * ------------------------------------------------------------------ */

/**
 * PDF -> .pptx, one slide per page.
 *
 * mode 'image'   — the page as a full-bleed picture. Pixel-perfect, not editable.
 * mode 'text'    — text boxes only, on a blank slide. Fully editable.
 * mode 'overlay' — a picture of everything on the page except its text, with
 *                  the text on top as real, editable boxes (the default).
 */
async function toPptx(pdf, opts) {
  const o = Object.assign(
    { mode: 'overlay', dpi: 130, quality: 0.82, imageFormat: 'jpeg' },
    opts
  );
  const onProgress = progressFn(o);
  const indexes = pageIndexes(pdf, o);

  const firstPage = await pdf.getPage(indexes[0] + 1);
  const vp1 = firstPage.getViewport({ scale: 1 });
  const slideW = vp1.width / PT_PER_INCH;
  const slideH = vp1.height / PT_PER_INCH;
  firstPage.cleanup();

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'PDFPAGE', width: slideW, height: slideH });
  pptx.layout = 'PDFPAGE';
  pptx.author = 'PDF Studio';
  pptx.title = baseName(o.filename);

  const wantText = o.mode !== 'image';
  const wantImage = o.mode !== 'text';
  const hook = wantText ? ocrHook(o) : null;
  const recognised = [];

  for (let n = 0; n < indexes.length; n++) {
    const idx = indexes[n];
    const page = await pdf.getPage(idx + 1);
    const pvp = page.getViewport({ scale: 1 });
    const slide = pptx.addSlide();

    // Slides all share one size, so pages of other dimensions are letterboxed.
    const fit = Math.min(slideW / (pvp.width / PT_PER_INCH), slideH / (pvp.height / PT_PER_INCH));
    const drawW = (pvp.width / PT_PER_INCH) * fit;
    const drawH = (pvp.height / PT_PER_INCH) * fit;
    const offX = (slideW - drawW) / 2;
    const offY = (slideH - drawH) / 2;

    let data = null;
    if (wantText) {
      data = await PSExtract.extractPage(page, idx, { detectTables: true });
      if ((data.isEmpty || data.scanLike) && hook) {
        const read = await hook(page, data);
        if (read) { data = read; recognised.push(idx + 1); }
      }
    }
    // Text read off a scan cannot be taken out of the picture it was read
    // from, so on those pages it is laid over the picture unseen.
    const scan = !!(data && data.ocr);
    const blocks = data ? PSExtract.textBlocks(data).filter((b) => b.text.trim()) : [];

    if (wantImage) {
      const canvas = await PSExtract.renderPageToCanvas(page, o.dpi, '#ffffff', {
        noText: o.mode === 'overlay' && blocks.length > 0 && !scan,
        factory: pdf.psCanvasFactory
      });
      slide.addImage({
        data: canvasDataUrl(canvas, o.imageFormat, o.quality),
        x: offX, y: offY, w: drawW, h: drawH
      });
      PSExtract.releaseCanvas(canvas);
    } else {
      slide.background = { color: 'FFFFFF' };
    }

    for (const b of blocks) {
      const hidden = wantImage && (scan || b.invisible);
      const lines = b.lines;
      const size = b.size;
      const pitch = lines.length > 1
        ? (lines[lines.length - 1].baseline - lines[0].baseline) / (lines.length - 1)
        : size * 1.2;
      const parts = [];
      lines.forEach((line, li) => {
        const runs = PSExtract.lineRuns(line);
        runs.forEach((run, k) => {
          const link = safeLink(run.link);
          parts.push({
            text: run.text,
            options: {
              fontSize: Math.max(5, Math.round(run.size * fit * 10) / 10),
              fontFace: run.face || 'Arial',
              bold: !!run.bold,
              italic: !!run.italic,
              color: hexFromColor(o.textColor || (isHexColor(run.color) ? run.color : '000000')),
              superscript: run.script === 'sup' || undefined,
              subscript: run.script === 'sub' || undefined,
              hyperlink: link ? { url: link } : undefined,
              breakLine: k === runs.length - 1 && li < lines.length - 1
            }
          });
        });
      });
      if (!parts.length) continue;
      const slack = size * 1.5;
      const x = b.align === 'right' ? b.x - slack : b.align === 'center' ? b.x - slack / 2 : b.x;
      slide.addText(parts, {
        x: offX + (Math.max(0, x) / PT_PER_INCH) * fit,
        y: offY + (Math.max(0, lines[0].baseline - pitch * 0.8) / PT_PER_INCH) * fit,
        w: Math.min(((b.w + slack) / PT_PER_INCH) * fit, slideW),
        h: Math.max(((pitch * lines.length + size * 0.3) / PT_PER_INCH) * fit, 0.16),
        align: b.align === 'center' ? 'center' : b.align === 'right' ? 'right' : 'left',
        valign: 'top',
        margin: 0,
        lineSpacing: Math.max(pitch, size) * fit,
        isTextBox: true,
        transparency: hidden ? 100 : 0,
        fit: 'none',
        wrap: false
      });
    }

    page.cleanup();
    onProgress(n + 1, indexes.length, 'Slide ' + (n + 1) + ' of ' + indexes.length);
    await PSExtract.tick();
  }

  const blob = await pptx.write({ outputType: 'blob' });
  const warnings = [];
  if (recognised.length) {
    warnings.push(capitalise(describePages(recognised)) + (recognised.length === 1 ? ' was' : ' were') +
      ' read by OCR — check the words against the original before relying on them.');
  }
  return { blob, filename: baseName(o.filename) + '.pptx', warnings };
}

/* ------------------------------------------------------------------ *
 * PDF -> images
 * ------------------------------------------------------------------ */

async function toImages(pdf, opts) {
  const o = Object.assign({ dpi: 150, format: 'png', quality: 0.9, zip: 'auto' }, opts);
  const onProgress = progressFn(o);
  const indexes = pageIndexes(pdf, o);
  const ext = o.format === 'jpeg' ? 'jpg' : o.format;
  const results = [];

  for (let n = 0; n < indexes.length; n++) {
    const page = await pdf.getPage(indexes[n] + 1);
    const { blob } = await PSExtract.renderPageToBlob(page, o.dpi, o.format, o.quality);
    results.push({ name: baseName(o.filename) + '-page-' + String(indexes[n] + 1).padStart(3, '0') + '.' + ext, blob });
    page.cleanup();
    onProgress(n + 1, indexes.length, 'Page ' + (n + 1) + ' of ' + indexes.length);
    await PSExtract.tick();
  }

  const wantZip = o.zip === true || (o.zip === 'auto' && results.length > 1);
  if (!wantZip) return { blob: results[0].blob, filename: results[0].name };

  const zip = new JSZip();
  for (const r of results) zip.file(r.name, r.blob);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  return { blob, filename: baseName(o.filename) + '-pages.zip' };
}

async function extractImagesZip(pdf, opts) {
  const o = Object.assign({ minPixels: 4000 }, opts);
  const onProgress = progressFn(o);
  const indexes = pageIndexes(pdf, o);
  const zip = new JSZip();
  let count = 0;

  for (let n = 0; n < indexes.length; n++) {
    const page = await pdf.getPage(indexes[n] + 1);
    let images = [];
    try {
      images = await PSExtract.extractPageImages(page, o.minPixels);
    } catch (e) { /* a page whose images will not decode simply yields none */ }
    for (let k = 0; k < images.length; k++) {
      const blob = await PSExtract.canvasToBlob(images[k].canvas, 'image/png');
      PSExtract.releaseCanvas(images[k].canvas);
      zip.file(
        'page-' + String(indexes[n] + 1).padStart(3, '0') + '-image-' + (k + 1) + '.png',
        blob
      );
      count++;
    }
    page.cleanup();
    onProgress(n + 1, indexes.length, 'Page ' + (n + 1) + ' — ' + count + ' image(s) found');
    await PSExtract.tick();
  }
  if (!count) throw new Error('No embedded images were found in the selected pages.');
  // PNG is already compressed; deflating it again buys nothing and costs time.
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  return { blob, filename: baseName(o.filename) + '-images.zip', count };
}

/* ------------------------------------------------------------------ *
 * PDF -> text, HTML, Markdown, CSV, JSON
 * ------------------------------------------------------------------ */

async function toPlainText(pdf, opts) {
  const o = Object.assign({ layout: false }, opts);
  const doc = await readDocument(pdf, o);
  return {
    blob: textBlob(PSExtract.documentToText(doc, o), 'text/plain'),
    filename: baseName(o.filename) + '.txt',
    warnings: warningsForDocument(doc)
  };
}

const CSS_FACES = { serif: 'Georgia,"Times New Roman",serif', mono: 'ui-monospace,Consolas,"Courier New",monospace' };

function htmlRuns(runs, base) {
  let out = '';
  for (const run of runs) {
    let text = escapeHtml(run.text);
    if (run.mono && !(base && base.mono)) text = '<code>' + text + '</code>';
    if (run.script === 'sup') text = '<sup>' + text + '</sup>';
    else if (run.script === 'sub') text = '<sub>' + text + '</sub>';
    if (run.bold && !(base && base.bold)) text = '<strong>' + text + '</strong>';
    if (run.italic && !(base && base.italic)) text = '<em>' + text + '</em>';
    if (run.underline && !run.link) text = '<u>' + text + '</u>';
    const colour = base && run.color !== base.color ? cssColor(run.color) : '';
    if (colour) text = '<span style="' + colour + '">' + text + '</span>';
    const link = safeLink(run.link);
    if (link) text = '<a href="' + escapeHtml(link) + '">' + text + '</a>';
    out += text;
  }
  return out;
}

function htmlTable(table) {
  const parts = ['<table' + (table.ruled ? '' : ' class="plain"') + '>'];
  table.cells.forEach((row, r) => {
    const tag = r < table.header ? 'th' : 'td';
    parts.push('<tr>' + row.filter(Boolean).map((cell) => {
      const attrs = (cell.colspan > 1 ? ' colspan="' + cell.colspan + '"' : '') +
        (cell.rowspan > 1 ? ' rowspan="' + cell.rowspan + '"' : '') +
        (cell.align !== 'left' ? ' style="text-align:' + cell.align + '"' : '');
      return '<' + tag + attrs + '>' + htmlRuns(PSExtract.buildRuns(cell.lines), { bold: tag === 'th' }) + '</' + tag + '>';
    }).join('') + '</tr>');
  });
  parts.push('</table>');
  return parts.join('\n');
}

function htmlForFlow(doc, title, o, pictures) {
  const parts = ['<article>'];
  let list = null;      // 'ul' | 'ol' while a list is open
  const closeList = () => { if (list) { parts.push('</' + list + '>'); list = null; } };
  for (const entry of flowOf(doc, o)) {
    if (entry.type === 'paragraph') {
      const p = entry.para;
      const decls = [
        p.align !== 'left' && !p.bullet ? 'text-align:' + p.align : '',
        cssColor(p.color),
        p.bullet && p.listLevel ? 'margin-left:' + (p.listLevel * 1.5) + 'em' : '',
        p.mono ? 'font-family:' + CSS_FACES.mono : ''
      ].filter(Boolean).join(';');
      const style = decls ? ' style="' + decls + '"' : '';
      const inner = htmlRuns(entry.runs, p);
      if (p.bullet) {
        const want = p.ordered ? 'ol' : 'ul';
        if (list !== want) { closeList(); parts.push('<' + want + '>'); list = want; }
        const value = p.ordered && /^\(?(\d+)/.test(p.marker) ? ' value="' + RegExp.$1 + '"' : '';
        parts.push('<li' + value + style + '>' + inner + '</li>');
        continue;
      }
      closeList();
      if (p.heading) parts.push('<h' + p.heading + style + '>' + inner + '</h' + p.heading + '>');
      else parts.push('<p' + style + '>' + inner + '</p>');
    } else {
      closeList();
      if (entry.type === 'table') {
        parts.push(htmlTable(entry.table));
      } else if (entry.type === 'image') {
        const pic = pictures.get(entry.image);
        if (pic && pic.url) {
          parts.push('<figure><img src="' + pic.url + '" width="' + Math.round(pic.width * PX_PER_PT) +
            '" alt=""></figure>');
        }
      } else if (entry.type === 'break') {
        parts.push('<hr class="page">');
      }
    }
  }
  closeList();
  parts.push('</article>');
  return wrapHtml(title, FLOW_CSS, parts.join('\n'));
}

function htmlForExact(doc, title, backgrounds) {
  const parts = [];
  doc.pages.forEach((page, pi) => {
    parts.push('<section class="page" style="width:' + page.width + 'pt;height:' + page.height + 'pt">');
    const bg = backgrounds && backgrounds[pi];
    if (bg) parts.push('<img class="bg" src="' + bg + '" alt="">');
    for (const line of page.lines) {
      if (!line.text.trim()) continue;
      // Each piece is placed on its own, so text that stood apart on the line
      // stays apart instead of being run together behind two spaces.
      for (const seg of line.segments) {
        const lead = seg.items[0] || line;
        const face = lead.mono ? CSS_FACES.mono : lead.serif ? CSS_FACES.serif : '';
        const style = [
          'left:' + seg.x.toFixed(2) + 'pt',
          'top:' + (line.baseline - line.size * 0.9).toFixed(2) + 'pt',
          'font-size:' + line.size.toFixed(2) + 'pt',
          lead.bold ? 'font-weight:700' : '',
          lead.italic ? 'font-style:italic' : '',
          face ? 'font-family:' + face : '',
          // The words of a scan's hidden layer stay hidden, and selectable.
          line.invisible && bg ? 'color:transparent' : cssColor(lead.color || line.color)
        ].filter(Boolean).join(';');
        parts.push('<span style="' + style + '">' + escapeHtml(seg.text) + '</span>');
      }
    }
    parts.push('</section>');
  });
  return wrapHtml(title, EXACT_CSS, parts.join('\n'));
}

const FLOW_CSS = `
:root { color-scheme: light dark; }
body { margin:0; padding:2rem 1rem; font:16px/1.6 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;
       background:#f6f7f9; color:#15181f; }
@media (prefers-color-scheme: dark) { body { background:#14161b; color:#e7e9ee; } article { background:#1c1f26 !important; } }
article { max-width:52rem; margin:0 auto 2rem; background:#fff; padding:2.5rem 3rem; border-radius:10px;
          box-shadow:0 1px 3px rgba(0,0,0,.12); }
h1,h2,h3,h4,h5,h6 { line-height:1.25; margin:1.4em 0 .5em; }
p { margin:0 0 .8em; }
li { margin:.2em 0; }
code { font:.92em ui-monospace,Consolas,monospace; }
figure { margin:1.2em 0; text-align:center; }
figure img { max-width:100%; height:auto; }
hr.page { border:0; border-top:1px dashed rgba(128,128,128,.4); margin:2em 0; }
table { border-collapse:collapse; margin:1em 0; font-size:.92em; }
th,td { border:1px solid rgba(128,128,128,.35); padding:.4em .6em; text-align:left; vertical-align:top; }
th { background:rgba(128,128,128,.12); font-weight:600; }
table.plain th, table.plain td { border-color:transparent; border-bottom-color:rgba(128,128,128,.18); }
`;

const EXACT_CSS = `
body { margin:0; padding:24px; background:#5a5d66; }
.page { position:relative; margin:0 auto 24px; background:#fff; overflow:hidden;
        box-shadow:0 2px 10px rgba(0,0,0,.35); }
.page .bg { position:absolute; inset:0; width:100%; height:100%; }
.page span { position:absolute; white-space:pre; transform-origin:0 0;
             font-family:ui-sans-serif,system-ui,Segoe UI,Helvetica,Arial,sans-serif;
             line-height:1.15; color:#000; }
`;

function wrapHtml(title, css, body) {
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + escapeHtml(title) + '</title>\n<style>' + css + '</style>\n</head>\n<body>\n' +
    body + '\n</body>\n</html>\n';
}

async function toHtml(pdf, opts) {
  const o = Object.assign({ mode: 'flow', background: false, dpi: 110 }, opts);
  const indexes = pageIndexes(pdf, o);
  const doc = await readDocument(pdf, o);
  const title = baseName(o.filename);
  let html;
  if (o.mode === 'exact') {
    let backgrounds = null;
    if (o.background && canRender()) {
      backgrounds = [];
      for (const idx of indexes) {
        const page = await pdf.getPage(idx + 1);
        const canvas = await PSExtract.renderPageToCanvas(page, o.dpi, '#ffffff', {
          noText: true, factory: pdf.psCanvasFactory
        });
        backgrounds.push(canvasDataUrl(canvas, 'jpeg', 0.78));
        PSExtract.releaseCanvas(canvas);
        page.cleanup();
        await PSExtract.tick();
      }
    }
    html = htmlForExact(doc, title, backgrounds);
  } else {
    const pictures = await renderPictures(pdf, doc, Object.assign({}, o, { urls: true, dpi: 144 }));
    html = htmlForFlow(doc, title, o, pictures);
  }
  return { blob: textBlob(html, 'text/html'), filename: title + '.html', warnings: warningsForDocument(doc) };
}

/* Only what would otherwise be read as markup is escaped: a full stop or a
   bracket in ordinary prose is left alone. */
function mdEscape(s) {
  return String(s).replace(/([\\`*_[\]<>])/g, '\\$1');
}

function mdRuns(runs, base) {
  let out = '';
  for (const run of runs) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(run.text);
    let text = m[2];
    if (!text) { out += run.text; continue; }
    if (run.mono && !(base && base.mono)) text = '`' + text.replace(/`/g, '\'') + '`';
    else text = mdEscape(text);
    if (run.bold && run.italic && !(base && base.heading)) text = '***' + text + '***';
    else if (run.bold && !(base && (base.heading || base.bold))) text = '**' + text + '**';
    else if (run.italic && !(base && base.italic)) text = '*' + text + '*';
    const link = safeLink(run.link);
    if (link) text = '[' + text + '](' + link.replace(/[()]/g, encodeURIComponent) + ')';
    out += m[1] + text + m[3];
  }
  return out;
}

function mdTable(table) {
  const cell = (c) => (c ? mdEscape(c.text).replace(/\|/g, '\\|') : '');
  // A pipe table has no merged cells; a merged cell's text sits in its first.
  const grid = table.cells.map((row) => row.map(cell));
  const rule = table.aligns.map((a) => (a === 'right' ? ' ---: ' : a === 'center' ? ' :---: ' : ' --- '));
  const out = ['| ' + grid[0].join(' | ') + ' |', '|' + rule.join('|') + '|'];
  for (let r = 1; r < grid.length; r++) out.push('| ' + grid[r].join(' | ') + ' |');
  return out.join('\n');
}

async function toMarkdown(pdf, opts) {
  const o = Object.assign({ tables: true, pageBreaks: true }, opts);
  const doc = await readDocument(pdf, o, { detectTables: o.tables !== false });
  const out = [];
  let inList = false;
  for (const entry of flowOf(doc, o)) {
    if (entry.type === 'paragraph') {
      const p = entry.para;
      const text = mdRuns(entry.runs, p);
      if (p.bullet) {
        out.push('  '.repeat(p.listLevel || 0) + (p.ordered ? p.marker.replace(/^\(|\)$/g, '').replace(/\.?$/, '.') : '-') + ' ' + text);
        inList = true;
        continue;
      }
      if (inList) { out.push(''); inList = false; }
      if (p.heading) out.push('#'.repeat(Math.min(6, p.heading)) + ' ' + text);
      else out.push(text.replace(/^(#{1,6} |[-+>] |\d+[.)] )/, '\\$1'));
      out.push('');
    } else {
      if (inList) { out.push(''); inList = false; }
      if (entry.type === 'table') { out.push(mdTable(entry.table)); out.push(''); }
      else if (entry.type === 'break') { out.push('---'); out.push(''); }
    }
  }
  return {
    blob: textBlob(out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', 'text/markdown'),
    filename: baseName(o.filename) + '.md',
    warnings: warningsForDocument(doc)
  };
}

async function toCsv(pdf, opts) {
  const o = Object.assign({ delimiter: ',' }, opts);
  const doc = await readDocument(pdf, o);
  const chunks = [];
  for (const page of doc.pages) {
    if (doc.pages.length > 1) chunks.push(csvCell('Page ' + page.number));
    chunks.push(rowsToCsv(PSExtract.pageToGrid(page), o.delimiter));
    chunks.push('');
  }
  return {
    blob: textBlob(chunks.join('\r\n'), 'text/csv'),
    filename: baseName(o.filename) + '.csv',
    warnings: warningsForDocument(doc)
  };
}

async function toJson(pdf, opts) {
  const o = Object.assign({ items: false, pretty: true }, opts);
  const doc = await readDocument(pdf, o);
  const round = (v) => Math.round(v * 100) / 100;
  const paragraph = (q) => ({
    text: q.text, x: round(q.x), y: round(q.y), w: round(q.w), h: round(q.h),
    size: q.size, bold: q.bold, italic: q.italic, font: q.font,
    heading: q.heading, bullet: q.bullet, ordered: q.ordered || false, marker: q.marker || null,
    level: q.listLevel || 0, align: q.align, color: q.color,
    artifact: q.artifact || null, continues: !!q.continues,
    runs: q.runs.length > 1 ? q.runs.map((r) => ({
      text: r.text, bold: r.bold, italic: r.italic, size: r.size, color: r.color,
      script: r.script, link: r.link
    })) : undefined
  });
  const tableOut = (t) => ({
    x: round(t.x), y: round(t.y), w: round(t.w), h: round(t.h),
    ruled: t.ruled, header: t.header, columns: t.columns.map(round), aligns: t.aligns, rows: t.rows,
    spans: [].concat(...t.cells.map((row) => row.filter((c) => c && (c.rowspan > 1 || c.colspan > 1))
      .map((c) => ({ row: c.row, col: c.col, rowspan: c.rowspan, colspan: c.colspan }))))
  });
  const payload = {
    source: o.filename || 'document.pdf',
    generator: 'PDF Studio',
    pageCount: doc.numPages,
    bodySize: doc.bodySize,
    pages: doc.pages.map((p) => ({
      number: p.number,
      width: p.width,
      height: p.height,
      rotation: p.rotation,
      ocr: !!p.ocr,
      // In reading order: what a person would read, in the order they would.
      blocks: p.blocks.map((b) => (b.type === 'paragraph'
        ? Object.assign({ type: 'paragraph' }, paragraph(b.para))
        : b.type === 'table'
          ? Object.assign({ type: 'table' }, tableOut(b.table))
          : { type: b.image.kind === 'figure' ? 'figure' : 'image',
              x: round(b.image.x), y: round(b.image.y), w: round(b.image.w), h: round(b.image.h) })),
      table: p.table ? { columns: p.table.columns.map(round), rows: p.table.rows } : null,
      lines: p.lines.map((l) => ({
        text: l.text, x: round(l.x), y: round(l.y), w: round(l.w), h: round(l.h), size: l.size,
        bold: l.bold, italic: l.italic, color: l.color, invisible: l.invisible
      })),
      items: o.items ? p.items : undefined
    }))
  };
  return {
    blob: textBlob(JSON.stringify(payload, null, o.pretty ? 2 : 0), 'application/json'),
    filename: baseName(o.filename) + '.json',
    warnings: warningsForDocument(doc)
  };
}

/* ------------------------------------------------------------------ *
 * Images -> PDF
 * ------------------------------------------------------------------ */

const PAGE_SIZES = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008]
};

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Could not read ' + file.name));
    fr.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That image could not be decoded.'));
    img.src = src;
  });
}

/**
 * Build a PDF from image files. Anything the browser can decode works; formats
 * PDF cannot carry natively are re-encoded to PNG first.
 */
async function imagesToPdf(files, opts) {
  const o = Object.assign(
    { pageSize: 'fit', orientation: 'auto', margin: 0, quality: 0.9, filename: 'images' },
    opts
  );
  const onProgress = progressFn(o);
  const out = await PDFDocument.create();
  out.setProducer('PDF Studio');
  out.setCreator('PDF Studio');

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const dataUrl = await readAsDataUrl(file);
    const img = await loadImage(dataUrl);
    let embedded;
    if (/^data:image\/jpe?g/i.test(dataUrl)) {
      embedded = await out.embedJpg(dataUrl);
    } else if (/^data:image\/png/i.test(dataUrl)) {
      embedded = await out.embedPng(dataUrl);
    } else {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      embedded = await out.embedPng(c.toDataURL('image/png'));
    }

    const iw = embedded.width, ih = embedded.height;
    let pw, ph;
    if (o.pageSize === 'fit') {
      pw = iw + o.margin * 2;
      ph = ih + o.margin * 2;
    } else {
      const size = PAGE_SIZES[o.pageSize] || PAGE_SIZES.A4;
      const landscape = o.orientation === 'landscape' ||
        (o.orientation === 'auto' && iw > ih);
      pw = landscape ? size[1] : size[0];
      ph = landscape ? size[0] : size[1];
    }
    const page = out.addPage([pw, ph]);
    const availW = Math.max(1, pw - o.margin * 2);
    const availH = Math.max(1, ph - o.margin * 2);
    const scale = Math.min(availW / iw, availH / ih);
    const dw = iw * scale, dh = ih * scale;
    page.drawImage(embedded, {
      x: (pw - dw) / 2,
      y: (ph - dh) / 2,
      width: dw,
      height: dh
    });
    onProgress(i + 1, files.length, file.name);
    await PSExtract.tick();
  }

  if (!out.getPageCount()) throw new Error('No images could be read.');
  const bytes = await out.save(SAVE_OPTIONS);
  return {
    blob: new Blob([bytes], { type: 'application/pdf' }),
    bytes,
    filename: baseName(o.filename) + '.pdf'
  };
}

/* ------------------------------------------------------------------ *
 * Text-like input -> PDF
 * ------------------------------------------------------------------ */

const FONT_SETS = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique]
};

function wrapToWidth(text, maxWidth, measure) {
  const out = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    if (!rawLine.trim()) { out.push(''); continue; }
    const words = rawLine.split(/(\s+)/);
    let line = '';
    for (const word of words) {
      const candidate = line + word;
      if (line && measure(candidate) > maxWidth) {
        out.push(line.replace(/\s+$/, ''));
        line = word.replace(/^\s+/, '');
      } else {
        line = candidate;
      }
      // A single token wider than the column has to be broken, whether it
      // arrived mid-line or started one — long URLs and base64 do both.
      while (measure(line) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > maxWidth) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

/**
 * A tiny flowing-text typesetter shared by the plain-text and Word importers.
 * `blocks` is a list of { text, size, bold, italic, align, bullet, spaceBefore }.
 */
async function typesetBlocks(blocks, opts) {
  const o = Object.assign(
    { pageSize: 'A4', orientation: 'portrait', margin: 56, fontFamily: 'sans', fontSize: 11, lineHeight: 1.35 },
    opts
  );
  const doc = await PDFDocument.create();
  doc.setProducer('PDF Studio');
  doc.setCreator('PDF Studio');
  if (o.title) doc.setTitle(o.title);

  const set = FONT_SETS[o.fontFamily] || FONT_SETS.sans;
  const fonts = {
    regular: await doc.embedFont(set[0]),
    bold: await doc.embedFont(set[1]),
    italic: await doc.embedFont(set[2]),
    boldItalic: await doc.embedFont(set[3])
  };
  const pick = (b, i) => (b && i ? fonts.boldItalic : b ? fonts.bold : i ? fonts.italic : fonts.regular);

  const size = PAGE_SIZES[o.pageSize] || PAGE_SIZES.A4;
  const landscape = o.orientation === 'landscape';
  const pw = landscape ? size[1] : size[0];
  const ph = landscape ? size[0] : size[1];
  const maxW = pw - o.margin * 2;

  let page = doc.addPage([pw, ph]);
  let y = ph - o.margin;
  const newPage = () => { page = doc.addPage([pw, ph]); y = ph - o.margin; };

  for (const block of blocks) {
    const fontSize = block.size || o.fontSize;
    const font = pick(block.bold, block.italic);
    const leading = fontSize * o.lineHeight;
    const indent = block.bullet ? fontSize * 1.2 : 0;
    const text = winAnsiSafe(block.text || '');
    y -= block.spaceBefore != null ? block.spaceBefore : fontSize * 0.5;

    const lines = text.trim()
      ? wrapToWidth(text, maxW - indent, (s) => font.widthOfTextAtSize(s, fontSize))
      : [''];

    for (let li = 0; li < lines.length; li++) {
      if (y - leading < o.margin) newPage();
      const line = lines[li];
      let x = o.margin + indent;
      if (block.align === 'center') {
        x = o.margin + (maxW - font.widthOfTextAtSize(line, fontSize)) / 2;
      } else if (block.align === 'right') {
        x = pw - o.margin - font.widthOfTextAtSize(line, fontSize);
      }
      y -= leading;
      if (block.bullet && li === 0) {
        page.drawText('•', {
          x: o.margin, y, size: fontSize, font: fonts.regular, color: rgb(0.2, 0.2, 0.2)
        });
      }
      if (line) {
        page.drawText(line, {
          x, y, size: fontSize, font,
          color: block.color ? block.color : rgb(0.06, 0.07, 0.09)
        });
      }
    }
  }

  const bytes = await doc.save(SAVE_OPTIONS);
  return { blob: new Blob([bytes], { type: 'application/pdf' }), bytes };
}

async function textToPdf(text, opts) {
  const o = Object.assign({ filename: 'document' }, opts);
  const blocks = String(text).split(/\n{2,}/).map((chunk) => ({
    text: chunk.replace(/\n/g, ' '),
    size: o.fontSize || 11
  }));
  const res = await typesetBlocks(blocks, o);
  return { blob: res.blob, bytes: res.bytes, filename: baseName(o.filename) + '.pdf' };
}

/* ------------------------------------------------------------------ *
 * Word -> PDF
 * ------------------------------------------------------------------ */

function xmlText(node) {
  return node.textContent || '';
}

function localName(el) {
  return el.localName || el.nodeName.replace(/^.*:/, '');
}

/**
 * Read the text of a .docx well enough to re-typeset it: paragraphs, headings,
 * bold/italic runs, alignment, lists and simple tables. Floating shapes,
 * columns, footnotes and images are not carried over.
 */
function parseDocxDocument(xmlString) {
  const dom = new DOMParser().parseFromString(xmlString, 'application/xml');
  if (dom.getElementsByTagName('parsererror').length) {
    throw new Error('The Word file could not be parsed.');
  }
  const body = dom.getElementsByTagNameNS('*', 'body')[0];
  if (!body) throw new Error('The Word file has no document body.');

  const blocks = [];
  const readParagraph = (p, insideTable) => {
    const pPr = p.getElementsByTagNameNS('*', 'pPr')[0];
    let style = '';
    let align = 'left';
    let bullet = false;
    if (pPr) {
      const pStyle = pPr.getElementsByTagNameNS('*', 'pStyle')[0];
      if (pStyle) style = pStyle.getAttribute('w:val') || pStyle.getAttribute('val') || '';
      const jc = pPr.getElementsByTagNameNS('*', 'jc')[0];
      if (jc) {
        const v = jc.getAttribute('w:val') || jc.getAttribute('val') || '';
        if (v === 'center') align = 'center';
        else if (v === 'right' || v === 'end') align = 'right';
      }
      if (pPr.getElementsByTagNameNS('*', 'numPr').length) bullet = true;
    }

    let text = '';
    let boldChars = 0, italicChars = 0, chars = 0, sizeSum = 0, sizeChars = 0;
    for (const run of Array.from(p.getElementsByTagNameNS('*', 'r'))) {
      const rPr = run.getElementsByTagNameNS('*', 'rPr')[0];
      const isBold = !!(rPr && rPr.getElementsByTagNameNS('*', 'b').length);
      const isItalic = !!(rPr && rPr.getElementsByTagNameNS('*', 'i').length);
      const szEl = rPr && rPr.getElementsByTagNameNS('*', 'sz')[0];
      const sz = szEl ? parseFloat(szEl.getAttribute('w:val') || szEl.getAttribute('val') || '') / 2 : 0;
      let runText = '';
      for (const child of Array.from(run.childNodes)) {
        if (child.nodeType !== 1) continue;
        const name = localName(child);
        if (name === 't') runText += xmlText(child);
        else if (name === 'tab') runText += '\t';
        else if (name === 'br' || name === 'cr') runText += '\n';
      }
      if (!runText) continue;
      text += runText;
      chars += runText.length;
      if (isBold) boldChars += runText.length;
      if (isItalic) italicChars += runText.length;
      if (sz) { sizeSum += sz * runText.length; sizeChars += runText.length; }
    }

    const headingMatch = /^Heading(\d)$/i.exec(style);
    const level = headingMatch ? parseInt(headingMatch[1], 10) : 0;
    const baseSize = sizeChars ? sizeSum / sizeChars : 0;
    blocks.push({
      text: text.replace(/\t/g, '    '),
      bold: level > 0 || (chars > 0 && boldChars / chars > 0.6),
      italic: chars > 0 && italicChars / chars > 0.6,
      align,
      bullet,
      heading: level,
      size: level ? [0, 20, 16, 14, 12.5, 11.5, 11][Math.min(6, level)] : (baseSize || 0),
      spaceBefore: insideTable ? 0 : (level ? 10 : undefined)
    });
  };

  const walk = (node, insideTable) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue;
      const name = localName(child);
      if (name === 'p') readParagraph(child, insideTable);
      else if (name === 'tbl') {
        for (const row of Array.from(child.getElementsByTagNameNS('*', 'tr'))) {
          const cells = Array.from(row.getElementsByTagNameNS('*', 'tc'))
            .map((tc) => xmlText(tc).replace(/\s+/g, ' ').trim());
          blocks.push({ text: cells.join('    |    '), mono: true, spaceBefore: 2 });
        }
        blocks.push({ text: '', spaceBefore: 4 });
      } else if (name === 'sdt' || name === 'sdtContent' || name === 'body') {
        walk(child, insideTable);
      }
    }
  };
  walk(body, false);
  return blocks;
}

async function docxToPdf(file, opts) {
  const o = Object.assign({ fontFamily: 'sans', fontSize: 11, pageSize: 'A4' }, opts);
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('That does not look like a Word (.docx) file.');
  const blocks = parseDocxDocument(await entry.async('string'))
    .map((b) => Object.assign({}, b, { size: b.size || o.fontSize }));
  const res = await typesetBlocks(blocks, Object.assign({}, o, { title: baseName(file.name) }));
  return { blob: res.blob, bytes: res.bytes, filename: baseName(file.name) + '.pdf' };
}

/* ------------------------------------------------------------------ *
 * Spreadsheet -> PDF
 * ------------------------------------------------------------------ */

async function spreadsheetToPdf(file, opts) {
  const o = Object.assign(
    { pageSize: 'A4', orientation: 'landscape', margin: 32, fontSize: 8.5, gridLines: true },
    opts
  );
  const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
  const doc = await PDFDocument.create();
  doc.setProducer('PDF Studio');
  doc.setCreator('PDF Studio');
  doc.setTitle(baseName(file.name));

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = PAGE_SIZES[o.pageSize] || PAGE_SIZES.A4;
  const landscape = o.orientation === 'landscape';
  const pw = landscape ? size[1] : size[0];
  const ph = landscape ? size[0] : size[1];
  const rowH = o.fontSize * 1.8;

  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });
    if (!rows.length) continue;
    const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
    if (!colCount) continue;

    // Column widths follow the longest cell, then get squeezed to fit the page.
    const raw = new Array(colCount).fill(o.fontSize * 3);
    for (const row of rows) {
      for (let c = 0; c < colCount; c++) {
        const text = winAnsiSafe(row[c]);
        raw[c] = Math.max(raw[c], font.widthOfTextAtSize(text, o.fontSize) + o.fontSize);
      }
    }
    const avail = pw - o.margin * 2;
    const total = raw.reduce((a, b) => a + b, 0);
    const widths = total > avail ? raw.map((w) => (w / total) * avail) : raw;

    let page = doc.addPage([pw, ph]);
    let y = ph - o.margin;
    page.drawText(winAnsiSafe(name), {
      x: o.margin, y: y - o.fontSize * 1.4, size: o.fontSize * 1.5, font: bold,
      color: rgb(0.1, 0.11, 0.14)
    });
    y -= o.fontSize * 2.6;

    rows.forEach((row, ri) => {
      if (y - rowH < o.margin) {
        page = doc.addPage([pw, ph]);
        y = ph - o.margin;
      }
      let x = o.margin;
      for (let c = 0; c < colCount; c++) {
        const w = widths[c];
        if (o.gridLines) {
          page.drawRectangle({
            x, y: y - rowH, width: w, height: rowH,
            borderColor: rgb(0.78, 0.79, 0.82), borderWidth: 0.5,
            color: ri === 0 ? rgb(0.94, 0.95, 0.97) : undefined
          });
        }
        const text = winAnsiSafe(row[c]);
        if (text) {
          const f = ri === 0 ? bold : font;
          let shown = text;
          while (shown.length > 1 && f.widthOfTextAtSize(shown, o.fontSize) > w - 4) {
            shown = shown.slice(0, -1);
          }
          page.drawText(shown, {
            x: x + 2, y: y - rowH + o.fontSize * 0.55, size: o.fontSize, font: f,
            color: rgb(0.08, 0.09, 0.12)
          });
        }
        x += w;
      }
      y -= rowH;
    });
  }

  if (!doc.getPageCount()) throw new Error('That spreadsheet has no readable rows.');
  const bytes = await doc.save(SAVE_OPTIONS);
  return {
    blob: new Blob([bytes], { type: 'application/pdf' }),
    bytes,
    filename: baseName(file.name) + '.pdf'
  };
}

/* ------------------------------------------------------------------ *
 * Entry point used by the UI
 * ------------------------------------------------------------------ */

const EXPORTERS = {
  docx: toDocx,
  xlsx: toXlsx,
  pptx: toPptx,
  images: toImages,
  embeddedImages: extractImagesZip,
  txt: toPlainText,
  html: toHtml,
  md: toMarkdown,
  csv: toCsv,
  json: toJson
};

async function convertFromPdf(pdf, format, opts) {
  const fn = EXPORTERS[format];
  if (!fn) throw new Error('Unknown output format: ' + format);
  return fn(pdf, opts);
}

root.PSConvert = {
  convertFromPdf,
  flowOf,
  parseNumber,
  toDocx,
  toXlsx,
  toPptx,
  toImages,
  extractImagesZip,
  toPlainText,
  toHtml,
  toMarkdown,
  toCsv,
  toJson,
  imagesToPdf,
  textToPdf,
  docxToPdf,
  spreadsheetToPdf,
  typesetBlocks,
  parseDocxDocument,
  winAnsiSafe,
  rowsToCsv,
  PAGE_SIZES
};

})(typeof window !== 'undefined' ? window : globalThis);
