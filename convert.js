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
 */
(function (root) {

const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;

const PT_PER_INCH = 72;
const TWIP_PER_PT = 20;

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
  /[^\t\n\r\x20-\x7E -ÿ€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g;

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

async function blobFromCanvas(canvas, type, quality) {
  return PSExtract.canvasToBlob(canvas, type, quality);
}

function canvasDataUrl(canvas, format, quality) {
  return format === 'png'
    ? canvas.toDataURL('image/png')
    : canvas.toDataURL('image/jpeg', quality == null ? 0.82 : quality);
}

/**
 * PNG bytes for the pages `want(position)` selects, keyed by their position in
 * `indexes` rather than by page number. A page that will not render yields
 * null instead of aborting the whole conversion.
 */
async function renderPagePngs(pdf, indexes, dpi, want) {
  const out = new Array(indexes.length).fill(null);
  for (let n = 0; n < indexes.length; n++) {
    if (want && !want(n)) continue;
    let page = null;
    try {
      page = await pdf.getPage(indexes[n] + 1);
      const canvas = await PSExtract.renderPageToCanvas(page, dpi || 110, '#ffffff');
      const blob = await blobFromCanvas(canvas, 'image/png');
      out[n] = { data: new Uint8Array(await blob.arrayBuffer()) };
    } catch (err) {
      out[n] = null;
    } finally {
      if (page) { try { page.cleanup(); } catch (err) { /* already gone */ } }
    }
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
      return null; // still unreadable; warningsForDocument says so
    }
  };
}

/**
 * What went wrong that the caller should be told about. Producing a file that
 * is quietly empty is worse than producing one with a warning attached.
 */
function warningsForDocument(doc, note) {
  const warnings = [];
  const unreadable = doc.pages.filter((p) => p.unreadable).map((p) => p.number);
  const scanned = doc.pages.filter((p) => !p.unreadable && !p.paragraphs.length && !p.table)
    .map((p) => p.number);
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
 * PDF -> Word
 * ------------------------------------------------------------------ */

const HEADING_LEVELS = [null, 'Heading1', 'Heading2', 'Heading3', 'Heading4'];

function docxRunsForParagraph(p, opts) {
  const D = docx;
  const size = Math.round(Math.max(6, p.size) * 2); // half-points
  return [new D.TextRun({
    text: p.text,
    bold: p.bold || undefined,
    italics: p.italic || undefined,
    size,
    color: opts.color === false ? undefined : docxColor(p.color),
    font: p.mono ? 'Consolas' : (opts.font || 'Calibri')
  })];
}

function docxAlignment(align) {
  const D = docx;
  if (align === 'center') return D.AlignmentType.CENTER;
  if (align === 'right') return D.AlignmentType.RIGHT;
  return D.AlignmentType.LEFT;
}

function docxTable(table, opts) {
  const D = docx;
  const rows = table.rows.map((cells, ri) => new D.TableRow({
    tableHeader: ri === 0 || undefined,
    children: cells.map((text) => new D.TableCell({
      children: [new D.Paragraph({
        children: [new D.TextRun({
          text: String(text || ''),
          bold: ri === 0 || undefined,
          size: Math.round((opts.tableFontSize || 10) * 2),
          font: opts.font || 'Calibri'
        })]
      })]
    }))
  }));
  return new D.Table({ rows, width: { size: 100, type: D.WidthType.PERCENTAGE } });
}

function docxParagraph(p, opts) {
  const D = docx;
  const conf = {
    children: docxRunsForParagraph(p, opts),
    alignment: docxAlignment(p.align),
    spacing: { after: 120 }
  };
  if (p.heading && HEADING_LEVELS[p.heading]) conf.heading = HEADING_LEVELS[p.heading];
  if (p.bullet) conf.bullet = { level: 0 };
  return new D.Paragraph(conf);
}

/**
 * A paragraph belongs to the table when most of the lines it was built from
 * became table rows. Table detection is a guess, so a page holding a table
 * usually holds prose as well — that prose has to survive.
 */
function paragraphInTable(p, sourceLines) {
  if (!sourceLines || !p.lines || !p.lines.length) return false;
  let n = 0;
  for (const line of p.lines) if (sourceLines.has(line)) n++;
  return n * 2 > p.lines.length;
}

/** A picture of the page, for pages with no text to convert. */
function docxPageImage(img, page) {
  const D = docx;
  const scale = Math.min(1, 468 / Math.max(1, page.width)); // fit the text column
  return new D.Paragraph({
    children: [new D.ImageRun({
      data: img.data,
      type: 'png',
      transformation: {
        width: Math.round(page.width * scale),
        height: Math.round(page.height * scale)
      }
    })]
  });
}

function docxFlowChildren(pages, opts, pageImages) {
  const D = docx;
  const children = [];
  pages.forEach((page, pi) => {
    if (pi > 0) {
      children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
    }

    const table = (opts.tables && page.table) ? page.table : null;
    const sourceLines = table ? table.sourceLines : null;
    let tableWritten = false;
    let wrote = false;

    for (const p of page.paragraphs) {
      if (paragraphInTable(p, sourceLines)) {
        // The table stands in for its own paragraphs, once, where they began.
        if (!tableWritten) {
          children.push(docxTable(table, opts));
          children.push(new D.Paragraph({ text: '' }));
          tableWritten = true;
          wrote = true;
        }
        continue;
      }
      if (!p.text.trim()) continue;
      children.push(docxParagraph(p, opts));
      wrote = true;
    }

    // Older extractions carry no line provenance; the table still belongs.
    if (table && !tableWritten) {
      children.push(docxTable(table, opts));
      children.push(new D.Paragraph({ text: '' }));
      wrote = true;
    }
    if (wrote) return;

    const img = pageImages && pageImages[pi];
    if (img) { children.push(docxPageImage(img, page)); return; }
    children.push(new D.Paragraph({ text: '' }));
  });
  return children;
}

function docxLayoutSections(pages, opts, backgrounds, pageImages) {
  const D = docx;
  return pages.map((page, pi) => {
    const children = [];
    if (backgrounds && backgrounds[pi]) {
      const bg = backgrounds[pi];
      children.push(new D.Paragraph({
        children: [new D.ImageRun({
          data: bg.data,
          type: 'png',
          transformation: { width: Math.round(page.width), height: Math.round(page.height) },
          floating: {
            horizontalPosition: { offset: 0 },
            verticalPosition: { offset: 0 },
            behindDocument: true,
            zIndex: 0
          }
        })]
      }));
    }
    for (const line of page.lines) {
      if (!line.text.trim()) continue;
      children.push(new D.Paragraph({
        frame: {
          type: 'absolute',
          position: {
            x: Math.round(line.x * TWIP_PER_PT),
            y: Math.round(line.y * TWIP_PER_PT)
          },
          width: Math.round(Math.max(line.w + line.size, line.size) * TWIP_PER_PT),
          height: Math.round(Math.max(line.h, line.size * 1.25) * TWIP_PER_PT),
          anchor: { horizontal: 'page', vertical: 'page' },
          wrap: 'none'
        },
        spacing: { before: 0, after: 0, line: Math.round(line.size * 1.05 * TWIP_PER_PT) },
        children: [new D.TextRun({
          text: line.text.replace(/\t/g, '  '),
          bold: line.bold || undefined,
          italics: line.italic || undefined,
          size: Math.round(Math.max(6, line.size) * 2),
          color: opts.color === false ? undefined : docxColor(line.color),
          font: line.mono ? 'Consolas' : (opts.font || 'Calibri')
        })]
      }));
    }
    if (!children.length) {
      const img = pageImages && pageImages[pi];
      children.push(img ? docxPageImage(img, page) : new D.Paragraph({ text: '' }));
    }
    return {
      properties: {
        type: pi === 0 ? undefined : D.SectionType.NEXT_PAGE,
        page: {
          size: {
            width: Math.round(page.width * TWIP_PER_PT),
            height: Math.round(page.height * TWIP_PER_PT),
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

/**
 * PDF -> .docx
 *
 * mode 'flow'   — reflowable paragraphs, headings, lists and tables. Best for
 *                 editing; the visual layout is not preserved.
 * mode 'layout' — every text line becomes an absolutely positioned frame, so
 *                 the page looks close to the original but is awkward to edit.
 */
async function toDocx(pdf, opts) {
  const o = Object.assign({ mode: 'flow', tables: true, font: 'Calibri', background: false, dpi: 110 }, opts);
  const onProgress = progressFn(o);
  const indexes = pageIndexes(pdf, o);
  onProgress(0, indexes.length + 1, 'Reading text');
  const doc = await PSExtract.extractDocument(pdf, {
    pages: indexes,
    onProgress: (i, n) => onProgress(i, n + 1, 'Reading page ' + i + ' of ' + n),
    onEmptyPage: ocrHook(o)
  });

  const warnings = warningsForDocument(doc, 'A picture of each was used instead.');

  let backgrounds = null;
  if (o.mode === 'layout' && o.background) {
    backgrounds = await renderPagePngs(pdf, indexes, o.dpi, () => true);
  }

  // Pages that carry no text at all — scans, or pages pdf.js could not read —
  // used to come out as an empty Word page with no explanation. A picture of
  // the page is not editable text, but it is the content.
  let pageImages = null;
  if (o.imageFallback !== false) {
    const empty = doc.pages.map((p) => !p.paragraphs.length && !p.table);
    if (empty.some(Boolean)) {
      pageImages = await renderPagePngs(pdf, indexes, o.dpi, (n) => empty[n]);
    }
  }

  const D = docx;
  const first = doc.pages[0] || { width: 595, height: 842 };
  const sections = o.mode === 'layout'
    ? docxLayoutSections(doc.pages, o, backgrounds, pageImages)
    : [{
        properties: {
          page: {
            size: {
              width: Math.round(first.width * TWIP_PER_PT),
              height: Math.round(first.height * TWIP_PER_PT),
              orientation: first.width > first.height
                ? D.PageOrientation.LANDSCAPE
                : D.PageOrientation.PORTRAIT
            },
            margin: {
              top: Math.round(36 * TWIP_PER_PT),
              bottom: Math.round(36 * TWIP_PER_PT),
              left: Math.round(Math.min(72, Math.max(24, first.bodyLeft || 54)) * TWIP_PER_PT),
              right: Math.round(36 * TWIP_PER_PT)
            }
          }
        },
        children: docxFlowChildren(doc.pages, o, pageImages)
      }];

  const document = new D.Document({
    creator: 'PDF Studio',
    title: o.title || baseName(o.filename),
    description: 'Converted from PDF by PDF Studio',
    sections
  });
  onProgress(indexes.length + 1, indexes.length + 1, 'Writing document');
  const blob = await D.Packer.toBlob(document);
  return { blob, filename: baseName(o.filename) + '.docx', warnings };
}

/* ------------------------------------------------------------------ *
 * PDF -> Excel
 * ------------------------------------------------------------------ */

function coerceCell(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const numeric = s.replace(/[\s,](?=\d)/g, '').replace(/^\((.*)\)$/, '-$1');
  if (/^-?\d+(\.\d+)?%$/.test(numeric)) {
    const n = parseFloat(numeric);
    if (!isNaN(n)) return n / 100;
  }
  if (/^[-+]?\d{1,15}(\.\d+)?$/.test(numeric)) {
    const n = Number(numeric);
    if (!isNaN(n)) return n;
  }
  return s;
}

/**
 * PDF -> .xlsx
 *
 * mode 'tables' — one sheet per page holding the detected grid.
 * mode 'lines'  — one sheet per page, one row per text line.
 * mode 'single' — every page appended to a single sheet.
 */
async function toXlsx(pdf, opts) {
  const o = Object.assign({ mode: 'tables', numbers: true, sheetPerPage: true }, opts);
  const onProgress = progressFn(o);
  const indexes = pageIndexes(pdf, o);
  const doc = await PSExtract.extractDocument(pdf, {
    pages: indexes,
    detectTables: o.mode !== 'lines',
    onProgress: (i, n) => onProgress(i, n, 'Reading page ' + i + ' of ' + n),
    onEmptyPage: ocrHook(o)
  });

  const wb = XLSX.utils.book_new();
  const usedNames = new Set();
  const sheetName = (want) => {
    let name = String(want).replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'Sheet';
    let i = 2;
    while (usedNames.has(name)) name = (String(want).slice(0, 24) + ' ' + i++).trim();
    usedNames.add(name);
    return name;
  };

  const convertRow = (row) => (o.numbers ? row.map(coerceCell) : row.map((c) => String(c == null ? '' : c)));

  if (o.mode === 'single' || !o.sheetPerPage) {
    const all = [];
    for (const page of doc.pages) {
      if (doc.pages.length > 1) all.push(['Page ' + page.number]);
      for (const row of PSExtract.pageToGrid(page)) all.push(convertRow(row));
      all.push([]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(all), sheetName('Document'));
  } else {
    for (const page of doc.pages) {
      const rows = PSExtract.pageToGrid(page).map(convertRow);
      const ws = XLSX.utils.aoa_to_sheet(rows.length ? rows : [['']]);
      const widths = [];
      for (const row of rows) {
        row.forEach((cell, c) => {
          const len = String(cell == null ? '' : cell).length;
          widths[c] = Math.min(60, Math.max(widths[c] || 8, len + 2));
        });
      }
      ws['!cols'] = widths.map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, sheetName('Page ' + page.number));
    }
  }

  if (!wb.SheetNames.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['']]), 'Sheet1');
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
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

/**
 * PDF -> .pptx, one slide per page.
 *
 * mode 'image'   — the page as a full-bleed picture. Pixel-perfect, not editable.
 * mode 'text'    — text boxes only, on a blank slide. Fully editable.
 * mode 'overlay' — the picture behind editable text boxes (the default).
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

    if (wantImage) {
      const canvas = await PSExtract.renderPageToCanvas(page, o.dpi, '#ffffff');
      slide.addImage({
        data: canvasDataUrl(canvas, o.imageFormat, o.quality),
        x: offX, y: offY, w: drawW, h: drawH
      });
    } else {
      slide.background = { color: 'FFFFFF' };
    }

    if (wantText) {
      let data = await PSExtract.extractPage(page, idx, { detectTables: false });
      if (data.isEmpty) {
        const hook = ocrHook(o);
        if (hook) data = (await hook(page, data)) || data;
      }
      const source = o.mode === 'overlay' ? data.lines : data.paragraphs;
      for (const block of source) {
        const text = (block.text || '').replace(/\t/g, '  ').trim();
        if (!text) continue;
        const w = Math.max(block.w || 0, block.size * 2) / PT_PER_INCH * fit;
        slide.addText(text, {
          x: offX + (block.x / PT_PER_INCH) * fit,
          y: offY + (block.y / PT_PER_INCH) * fit,
          w: Math.min(w + 0.12, slideW),
          h: Math.max((block.h || block.size * 1.3) / PT_PER_INCH * fit, 0.16),
          fontSize: Math.max(6, Math.round(block.size * fit)),
          bold: !!block.bold,
          italic: !!block.italic,
          color: hexFromColor(o.textColor || (isHexColor(block.color) ? block.color : '000000')),
          align: block.align === 'center' ? 'center' : block.align === 'right' ? 'right' : 'left',
          valign: 'top',
          margin: 0,
          isTextBox: true,
          transparency: o.mode === 'overlay' && o.hideOverlayText ? 100 : 0,
          fit: 'none',
          wrap: o.mode !== 'overlay'
        });
      }
    }

    page.cleanup();
    onProgress(n + 1, indexes.length, 'Slide ' + (n + 1) + ' of ' + indexes.length);
    await new Promise((r) => setTimeout(r, 0));
  }

  const blob = await pptx.write({ outputType: 'blob' });
  return { blob, filename: baseName(o.filename) + '.pptx' };
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
    await new Promise((r) => setTimeout(r, 0));
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
      const blob = await blobFromCanvas(images[k].canvas, 'image/png');
      zip.file(
        'page-' + String(indexes[n] + 1).padStart(3, '0') + '-image-' + (k + 1) + '.png',
        blob
      );
      count++;
    }
    page.cleanup();
    onProgress(n + 1, indexes.length, 'Page ' + (n + 1) + ' — ' + count + ' image(s) found');
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!count) throw new Error('No embedded images were found in the selected pages.');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { blob, filename: baseName(o.filename) + '-images.zip', count };
}

/* ------------------------------------------------------------------ *
 * PDF -> text, HTML, Markdown, CSV, JSON
 * ------------------------------------------------------------------ */

async function toPlainText(pdf, opts) {
  const o = Object.assign({ layout: false }, opts);
  const doc = await PSExtract.extractDocument(pdf, {
    pages: pageIndexes(pdf, o),
    onProgress: (i, n) => progressFn(o)(i, n, 'Reading page ' + i + ' of ' + n),
    onEmptyPage: ocrHook(o)
  });
  return {
    blob: textBlob(PSExtract.documentToText(doc, o), 'text/plain'),
    filename: baseName(o.filename) + '.txt',
    warnings: warningsForDocument(doc)
  };
}

function htmlForFlow(doc, title) {
  const parts = [];
  for (const page of doc.pages) {
    parts.push('<section class="page" id="page-' + page.number + '">');
    parts.push('<div class="page-label">Page ' + page.number + '</div>');
    if (page.table) {
      parts.push('<table>');
      page.table.rows.forEach((row, ri) => {
        const tag = ri === 0 ? 'th' : 'td';
        parts.push('<tr>' + row.map((c) => '<' + tag + '>' + escapeHtml(c) + '</' + tag + '>').join('') + '</tr>');
      });
      parts.push('</table>');
    }
    let inList = false;
    const sourceLines = page.table ? page.table.sourceLines : null;
    for (const p of page.paragraphs) {
      if (!p.text.trim()) continue;
      // The table above already carries these lines; repeating them as prose
      // printed the same content twice.
      if (paragraphInTable(p, sourceLines)) continue;
      if (p.bullet && !inList) { parts.push('<ul>'); inList = true; }
      if (!p.bullet && inList) { parts.push('</ul>'); inList = false; }
      const decls = [p.align !== 'left' ? 'text-align:' + p.align : '', cssColor(p.color)]
        .filter(Boolean).join(';');
      const style = decls ? ' style="' + decls + '"' : '';
      if (p.bullet) parts.push('<li' + style + '>' + escapeHtml(p.text) + '</li>');
      else if (p.heading) parts.push('<h' + p.heading + style + '>' + escapeHtml(p.text) + '</h' + p.heading + '>');
      else parts.push('<p' + style + '>' + escapeHtml(p.text) + '</p>');
    }
    if (inList) parts.push('</ul>');
    parts.push('</section>');
  }
  return wrapHtml(title, FLOW_CSS, parts.join('\n'));
}

function htmlForExact(doc, title, backgrounds) {
  const parts = [];
  doc.pages.forEach((page, pi) => {
    parts.push('<section class="page" style="width:' + page.width + 'pt;height:' + page.height + 'pt">');
    if (backgrounds && backgrounds[pi]) {
      parts.push('<img class="bg" src="' + backgrounds[pi] + '" alt="">');
    }
    for (const line of page.lines) {
      if (!line.text.trim()) continue;
      const style = [
        'left:' + line.x.toFixed(2) + 'pt',
        'top:' + line.y.toFixed(2) + 'pt',
        'font-size:' + line.size.toFixed(2) + 'pt',
        line.bold ? 'font-weight:700' : '',
        line.italic ? 'font-style:italic' : '',
        line.mono ? 'font-family:ui-monospace,Consolas,monospace' : '',
        cssColor(line.color)
      ].filter(Boolean).join(';');
      parts.push('<span style="' + style + '">' + escapeHtml(line.text.replace(/\t/g, '  ')) + '</span>');
    }
    parts.push('</section>');
  });
  return wrapHtml(title, EXACT_CSS, parts.join('\n'));
}

const FLOW_CSS = `
:root { color-scheme: light dark; }
body { margin:0; padding:2rem 1rem; font:16px/1.6 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;
       background:#f6f7f9; color:#15181f; }
@media (prefers-color-scheme: dark) { body { background:#14161b; color:#e7e9ee; } .page { background:#1c1f26 !important; } }
.page { max-width:52rem; margin:0 auto 2rem; background:#fff; padding:2.5rem 3rem; border-radius:10px;
        box-shadow:0 1px 3px rgba(0,0,0,.12); }
.page-label { font-size:.75rem; letter-spacing:.08em; text-transform:uppercase; opacity:.45; margin-bottom:1.2rem; }
h1,h2,h3,h4 { line-height:1.25; margin:1.4em 0 .5em; }
p { margin:0 0 .8em; }
table { border-collapse:collapse; width:100%; margin:1em 0; font-size:.92em; }
th,td { border:1px solid rgba(128,128,128,.35); padding:.4em .6em; text-align:left; vertical-align:top; }
th { background:rgba(128,128,128,.12); font-weight:600; }
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
  const doc = await PSExtract.extractDocument(pdf, {
    pages: indexes,
    onProgress: (i, n) => progressFn(o)(i, n, 'Reading page ' + i + ' of ' + n),
    onEmptyPage: ocrHook(o)
  });
  let backgrounds = null;
  if (o.mode === 'exact' && o.background) {
    backgrounds = [];
    for (const idx of indexes) {
      const page = await pdf.getPage(idx + 1);
      const canvas = await PSExtract.renderPageToCanvas(page, o.dpi, '#ffffff');
      backgrounds.push(canvasDataUrl(canvas, 'jpeg', 0.7));
      page.cleanup();
    }
  }
  const title = baseName(o.filename);
  const html = o.mode === 'exact'
    ? htmlForExact(doc, title, backgrounds)
    : htmlForFlow(doc, title);
  return { blob: textBlob(html, 'text/html'), filename: title + '.html', warnings: warningsForDocument(doc) };
}

function mdEscape(s) {
  return String(s).replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1');
}

async function toMarkdown(pdf, opts) {
  const o = Object.assign({ tables: true, pageBreaks: true }, opts);
  const doc = await PSExtract.extractDocument(pdf, {
    pages: pageIndexes(pdf, o),
    onProgress: (i, n) => progressFn(o)(i, n, 'Reading page ' + i + ' of ' + n),
    onEmptyPage: ocrHook(o)
  });
  const out = [];
  doc.pages.forEach((page, pi) => {
    if (pi > 0 && o.pageBreaks) out.push('\n---\n');
    if (o.tables && page.table) {
      const rows = page.table.rows;
      out.push('| ' + rows[0].map(mdEscape).join(' | ') + ' |');
      out.push('|' + rows[0].map(() => ' --- ').join('|') + '|');
      for (let r = 1; r < rows.length; r++) {
        out.push('| ' + rows[r].map(mdEscape).join(' | ') + ' |');
      }
      out.push('');
      return;
    }
    for (const p of page.paragraphs) {
      if (!p.text.trim()) continue;
      if (p.heading) out.push('#'.repeat(Math.min(6, p.heading)) + ' ' + p.text);
      else if (p.bullet) out.push('- ' + p.text);
      else out.push(p.text);
      out.push('');
    }
  });
  return {
    blob: textBlob(out.join('\n').replace(/\n{3,}/g, '\n\n'), 'text/markdown'),
    filename: baseName(o.filename) + '.md',
    warnings: warningsForDocument(doc)
  };
}

async function toCsv(pdf, opts) {
  const o = Object.assign({ delimiter: ',' }, opts);
  const doc = await PSExtract.extractDocument(pdf, {
    pages: pageIndexes(pdf, o),
    onProgress: (i, n) => progressFn(o)(i, n, 'Reading page ' + i + ' of ' + n),
    onEmptyPage: ocrHook(o)
  });
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
  const doc = await PSExtract.extractDocument(pdf, {
    pages: pageIndexes(pdf, o),
    onProgress: (i, n) => progressFn(o)(i, n, 'Reading page ' + i + ' of ' + n),
    onEmptyPage: ocrHook(o)
  });
  const payload = {
    source: o.filename || 'document.pdf',
    generator: 'PDF Studio',
    pageCount: doc.numPages,
    pages: doc.pages.map((p) => ({
      number: p.number,
      width: p.width,
      height: p.height,
      rotation: p.rotation,
      bodySize: p.bodySize,
      table: p.table ? { columns: p.table.columns, rows: p.table.rows } : null,
      paragraphs: p.paragraphs.map((q) => ({
        text: q.text, x: q.x, y: q.y, w: q.w, h: q.h,
        size: q.size, bold: q.bold, italic: q.italic,
        heading: q.heading, bullet: q.bullet, align: q.align, color: q.color
      })),
      lines: p.lines.map((l) => ({
        text: l.text, x: l.x, y: l.y, w: l.w, h: l.h, size: l.size, bold: l.bold,
        italic: l.italic, color: l.color, invisible: l.invisible
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
    await new Promise((r) => setTimeout(r, 0));
  }

  if (!out.getPageCount()) throw new Error('No images could be read.');
  const bytes = await out.save({ useObjectStreams: true });
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

  const bytes = await doc.save({ useObjectStreams: true });
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
  const bytes = await doc.save({ useObjectStreams: true });
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
