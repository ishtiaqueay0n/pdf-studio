'use strict';
/* global pdfjsLib */
/*
 * Text and structure extraction.
 *
 * pdf.js hands back a flat bag of positioned glyph runs. Everything that makes
 * a converted document readable — lines, paragraphs, headings, lists, tables,
 * columns, reading order — has to be reconstructed from those positions. That
 * reconstruction lives here so every converter, and the editor, share one
 * interpretation of the page.
 *
 * The page is read in four passes:
 *
 *  1. Items.     Text runs with their size, face, weight, slope and colour.
 *  2. Graphics.  One walk of the operator list for the things text alone does
 *                not say: where the pictures sit, which thin lines are table
 *                rulings, which small filled shapes are list bullets.
 *  3. Layout.    Ruled tables are lifted out first, because their grid is
 *                drawn and need not be guessed. What is left is cut into
 *                columns and borderless tables by the white space between
 *                them, which gives the order a person would read it in.
 *  4. Blocks.    Lines become paragraphs, list items and headings, with the
 *                inline styling of each run kept.
 *
 * All coordinates are in PDF points with a top-left origin, matching a
 * pdf.js viewport at scale 1 (page rotation already applied).
 */
(function (root) {

/* ------------------------------------------------------------------ *
 * Scheduling
 * ------------------------------------------------------------------ */

/**
 * Give the browser a turn between pages of a long job.
 *
 * Not setTimeout: Chrome clamps timers in a background tab to one a second,
 * and to one a minute after a while, so a 300-page conversion that yields
 * with a timer takes five minutes — or five hours — the moment the user looks
 * at another tab. Messages on a MessageChannel are not throttled.
 */
const tick = (function () {
  if (typeof window === 'undefined' || typeof MessageChannel !== 'function') {
    return () => new Promise((resolve) => {
      if (typeof setImmediate === 'function') setImmediate(resolve);
      else setTimeout(resolve, 0);
    });
  }
  const waiting = [];
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const next = waiting.shift();
    if (next) next();
  };
  return () => new Promise((resolve) => {
    waiting.push(resolve);
    channel.port2.postMessage(0);
  });
})();

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/* ------------------------------------------------------------------ *
 * Font heuristics
 * ------------------------------------------------------------------ */

const BOLD_RE = /bold|black|heavy|ultra|extrab|semib|demib|medi(?:um)?(?![a-z])|[-_,]bd[-_,.]?|[-_,](?:600|700|800|900)\b|cmbx|cmb\d/i;
const ITALIC_RE = /italic|oblique|kursiv|slant|[-_,]it[-_,.]?|ital\b|cmti|cmsl/i;
const MONO_RE = /mono|courier|consol|typewriter|cmtt/i;
const SERIF_RE = /serif|times|georgia|garamond|roman|minion|cambria|book\b|caslon|baskerville/i;

/*
 * The typeface a font name stands for, as a family a word processor or a
 * browser will actually have.
 *
 * Only names that are installed almost everywhere are passed through. Anything
 * else is reduced to the nearest of Times New Roman, Arial and Courier New: a
 * document asking Word for a face it does not have gets Word's default
 * instead, and that turns a sans-serif page into a serif one.
 *
 * Matched against the PostScript name with its subset tag and every
 * non-alphanumeric character removed, in lower case.
 */
const FAMILIES = [
  [/arialnarrow/, 'Arial Narrow', 'sans'],
  [/arialblack/, 'Arial Black', 'sans'],
  [/couriernew|courier|nimbusmon|liberationmono|cousine|^cmtt|^lmmono|^sftt/, 'Courier New', 'mono'],
  [/consolas/, 'Consolas', 'mono'],
  [/lucidaconsole/, 'Lucida Console', 'mono'],
  [/timesnewroman|times|nimbusrom|liberationserif|tinos|termes|^cm(?:r|bx|ti|sl|b|csc|u|mi|sy|ex)\d|^lmroman|^sfrm|^sfbx|^sfti/, 'Times New Roman', 'serif'],
  [/calibrilight/, 'Calibri Light', 'sans'],
  [/calibri|carlito/, 'Calibri', 'sans'],
  [/cambriamath/, 'Cambria Math', 'serif'],
  [/cambria|caladea/, 'Cambria', 'serif'],
  [/georgia/, 'Georgia', 'serif'],
  [/verdana/, 'Verdana', 'sans'],
  [/tahoma/, 'Tahoma', 'sans'],
  [/trebuchet/, 'Trebuchet MS', 'sans'],
  [/segoeui/, 'Segoe UI', 'sans'],
  [/garamond/, 'Garamond', 'serif'],
  [/palatino|pagella|bookantiqua/, 'Palatino Linotype', 'serif'],
  [/centurygothic/, 'Century Gothic', 'sans'],
  [/centuryschoolbook|newcenturyschlbk|schola/, 'Century Schoolbook', 'serif'],
  [/bookman/, 'Bookman Old Style', 'serif'],
  [/comicsans/, 'Comic Sans MS', 'sans'],
  [/candara/, 'Candara', 'sans'],
  [/constantia/, 'Constantia', 'serif'],
  [/corbel/, 'Corbel', 'sans'],
  [/franklingothic/, 'Franklin Gothic Medium', 'sans'],
  [/gillsans/, 'Gill Sans MT', 'sans'],
  [/impact/, 'Impact', 'sans'],
  [/nirmala|vrinda|notosansbengali|solaimanlipi|kalpurush|siyamrupali|shonarbangla/, 'Nirmala UI', 'sans'],
  [/arial|helvetica|nimbussan|liberationsans|arimo|^cmss|^lmsans|^sfss/, 'Arial', 'sans']
];

function cleanFontName(name) {
  return String(name || '').replace(/^[A-Z]{6}\+/, '');
}

function familyFor(name, hint) {
  const key = cleanFontName(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key) {
    for (const [pattern, family, kind] of FAMILIES) {
      if (pattern.test(key)) return { family, kind, known: true };
    }
  }
  const kind = hint && hint.mono ? 'mono' : hint && hint.serif ? 'serif' : 'sans';
  return {
    family: kind === 'mono' ? 'Courier New' : kind === 'serif' ? 'Times New Roman' : 'Arial',
    kind,
    known: false
  };
}

/**
 * What can be told about the font behind a run of text.
 *
 * Three sources, in order of how much they can be trusted:
 *
 *  - `styles[fontName].fontFamily` is set by pdf.js to exactly "serif",
 *    "monospace" or "sans-serif", decided from the font descriptor's own
 *    flags. Those flags are often wrong — a Times clone is routinely marked
 *    sans-serif — so a name that is recognised overrules them.
 *  - `commonObjs` carries the font's real PostScript name — "ABCDEF+Arial-
 *    BoldMT" and the like — which is the only thing most PDFs say about
 *    weight and slope. It is only there once the page's operator list has
 *    been run, which is why pageItems fetches that first.
 *  - `font.bold` / `font.italic` exist only for fonts pdf.js had to
 *    substitute because they were not embedded; for an embedded font they
 *    are undefined. They are used when present and ignored when not.
 */
function fontInfo(page, textContent, fontName) {
  let name = '';
  let flaggedBold = false;
  let flaggedItalic = false;
  try {
    if (page.commonObjs.has(fontName)) {
      const f = page.commonObjs.get(fontName);
      if (f) {
        name = f.name || f.loadedName || '';
        flaggedBold = f.bold === true || f.black === true;
        flaggedItalic = f.italic === true;
      }
    }
  } catch (e) { /* the name is only a hint; the style map still works */ }

  const style = textContent.styles && textContent.styles[fontName];
  const family = style ? style.fontFamily || '' : '';
  const ascent = style && typeof style.ascent === 'number' && style.ascent > 0
    ? style.ascent : null;
  const descent = style && typeof style.descent === 'number' && style.descent < 0
    ? -style.descent : null;

  // pdf.js normally reduces the family to one of three generic words, which say
  // nothing about weight — but a build that reports a real family name there
  // would, so both are looked at and neither is required.
  const probe = cleanFontName(name) + ' ' + family;
  const guessMono = family === 'monospace' || MONO_RE.test(probe);
  const guessSerif = family === 'serif' || (SERIF_RE.test(probe) && !/sans/i.test(probe));
  const face = familyFor(name, { mono: guessMono, serif: guessSerif });

  return {
    name: name || family || fontName,
    family,
    face: face.family,
    ascent,
    descent,
    bold: flaggedBold || BOLD_RE.test(probe),
    italic: flaggedItalic || ITALIC_RE.test(probe),
    mono: face.known ? face.kind === 'mono' : guessMono,
    serif: face.known ? face.kind === 'serif' : guessSerif
  };
}

/* ------------------------------------------------------------------ *
 * Colour and geometry helpers
 * ------------------------------------------------------------------ */

function hexColor(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

function nearWhite(hex) {
  if (!hex) return false;
  const v = parseInt(hex.slice(1), 16);
  return ((v >> 16) & 255) > 244 && ((v >> 8) & 255) > 244 && (v & 255) > 244;
}

/** m1 after m2 — the same composition order as pdf.js's Util.transform. */
function matMul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ];
}

function applyMat(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/* ------------------------------------------------------------------ *
 * Graphics: one walk of the operator list
 *
 * getTextContent() reports what the text says and where it sits, but not what
 * colour it is painted in, and nothing at all about what is drawn around it.
 * That lives in the operator list, so it is read separately and joined back.
 * ------------------------------------------------------------------ */

function glyphText(glyphs) {
  if (!Array.isArray(glyphs)) return '';
  let s = '';
  for (const g of glyphs) {
    if (g == null || typeof g === 'number') continue; // kerning adjustment
    if (typeof g === 'string') { s += g; continue; }
    if (typeof g.unicode === 'string') s += g.unicode;
    else if (typeof g.fontChar === 'string') s += g.fontChar;
  }
  return s;
}

function pushRun(runs, text, color, invisible, stroked) {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && last.color === color && last.invisible === invisible && last.stroked === stroked) {
    last.text += text;
    return;
  }
  runs.push({ text, color, invisible, stroked: !!stroked });
}

/** [x0, y0, x1, y1] when the points are the corners of an upright rectangle. */
function asRect(points) {
  if (points.length < 4 || points.length > 5) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  const eps = 0.35;
  for (const p of points) {
    const onX = Math.abs(p[0] - x0) < eps || Math.abs(p[0] - x1) < eps;
    const onY = Math.abs(p[1] - y0) < eps || Math.abs(p[1] - y1) < eps;
    if (!onX || !onY) return null;
  }
  return [x0, y0, x1, y1];
}

/**
 * Follow one constructPath operator and report what it draws, in page space:
 * the upright rectangles, the straight segments, and the box around it all.
 */
function tracePath(fns, coords, m, OPS) {
  const out = { rects: [], segs: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, curved: false };
  const edge = (a, b) => {
    out.segs.push([a, b]);
    // Neither level nor upright: a diagram's arrow, a chart's line.
    if (Math.abs(a[0] - b[0]) > 0.6 && Math.abs(a[1] - b[1]) > 0.6) out.curved = true;
  };
  const grow = (p) => {
    if (p[0] < out.x0) out.x0 = p[0];
    if (p[0] > out.x1) out.x1 = p[0];
    if (p[1] < out.y0) out.y0 = p[1];
    if (p[1] > out.y1) out.y1 = p[1];
  };
  let j = 0;
  let sub = null;
  let subCurved = false;
  const endSub = (closed) => {
    if (sub && sub.length >= 2 && !subCurved) {
      const rect = (closed || sub.length >= 4) ? asRect(sub) : null;
      if (rect) {
        out.rects.push(rect);
      } else {
        for (let i = 0; i + 1 < sub.length; i++) edge(sub[i], sub[i + 1]);
        if (closed) edge(sub[sub.length - 1], sub[0]);
      }
    }
    sub = null;
    subCurved = false;
  };

  for (const fn of fns) {
    if (fn === OPS.rectangle) {
      endSub(false);
      const x = coords[j++], y = coords[j++], w = coords[j++], h = coords[j++];
      const corners = [applyMat(m, x, y), applyMat(m, x + w, y), applyMat(m, x + w, y + h), applyMat(m, x, y + h)];
      corners.forEach(grow);
      const rect = asRect(corners);
      if (rect) out.rects.push(rect);
      else out.curved = true;
    } else if (fn === OPS.moveTo) {
      endSub(false);
      const p = applyMat(m, coords[j++], coords[j++]);
      grow(p);
      sub = [p];
    } else if (fn === OPS.lineTo) {
      const p = applyMat(m, coords[j++], coords[j++]);
      grow(p);
      if (sub) sub.push(p); else sub = [p];
    } else if (fn === OPS.curveTo) {
      grow(applyMat(m, coords[j++], coords[j++]));
      grow(applyMat(m, coords[j++], coords[j++]));
      const p = applyMat(m, coords[j++], coords[j++]);
      grow(p);
      if (sub) sub.push(p); else sub = [p];
      subCurved = true;
      out.curved = true;
    } else if (fn === OPS.curveTo2 || fn === OPS.curveTo3) {
      grow(applyMat(m, coords[j++], coords[j++]));
      const p = applyMat(m, coords[j++], coords[j++]);
      grow(p);
      if (sub) sub.push(p); else sub = [p];
      subCurved = true;
      out.curved = true;
    } else if (fn === OPS.closePath) {
      endSub(true);
    }
  }
  endSub(false);
  return out;
}

const graphicsCache = new WeakMap();

const EMPTY_GRAPHICS = Object.freeze({
  runs: [], images: [], hRules: [], vRules: [], fills: [], marks: [], drawings: []
});

/**
 * Everything the page paints that is not text content, read in one pass and
 * remembered for as long as the page proxy lives:
 *
 *   runs      text in stream order with its fill colour (see alignColors)
 *   images    the rectangle each painted bitmap occupies
 *   hRules /
 *   vRules    thin straight lines — table rulings, underlines, separators
 *   fills     larger filled rectangles — cell shading, panels
 *   marks     small filled shapes — the bullets a browser draws as vectors
 *   drawings  the box of every painted path, for finding figures
 */
function pageGraphics(page) {
  let job = graphicsCache.get(page);
  if (!job) {
    job = readGraphics(page).catch(() => EMPTY_GRAPHICS);
    graphicsCache.set(page, job);
  }
  return job;
}

async function readGraphics(page) {
  const ops = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const viewport = page.getViewport({ scale: 1 });
  const pageW = viewport.width, pageH = viewport.height;

  const out = { runs: [], images: [], hRules: [], vRules: [], fills: [], marks: [], drawings: [] };
  const IMAGE_OPS = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);
  const STROKES = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke,
                           OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const FILLS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke,
                         OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const RULE_CAP = 12000;

  let ctm = [1, 0, 0, 1, 0, 0];
  let fill = null;     // null means the PDF default, which is black
  let stroke = null;
  let mode = 0;
  const stack = [];
  const fnArray = ops.fnArray, argsArray = ops.argsArray;

  const addRule = (x0, y0, x1, y1) => {
    if (out.hRules.length + out.vRules.length >= RULE_CAP) return;
    const w = x1 - x0, h = y1 - y0;
    if (w >= h) {
      if (w >= 4) out.hRules.push({ y: (y0 + y1) / 2, x0, x1 });
    } else if (h >= 4) {
      out.vRules.push({ x: (x0 + x1) / 2, y0, y1 });
    }
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];

    if (fn === OPS.save) {
      stack.push({ ctm, fill, stroke, mode });
    } else if (fn === OPS.restore) {
      const s = stack.pop();
      if (s) { ctm = s.ctm; fill = s.fill; stroke = s.stroke; mode = s.mode; }
    } else if (fn === OPS.transform) {
      ctm = matMul(ctm, args);
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ctm, fill, stroke, mode });
      if (args && args[0]) ctm = matMul(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) {
      const s = stack.pop();
      if (s) { ctm = s.ctm; fill = s.fill; stroke = s.stroke; mode = s.mode; }
    } else if (fn === OPS.setFillRGBColor) {
      /*
       * pdf.js converts gray, CMYK, ICC, indexed, Lab and separation colours
       * into this one operator, with 0-255 components, before the list gets
       * here. A pattern or shading fill arrives as setFillColorN and has no
       * single colour; text painted that way is left null and falls back to
       * black.
       */
      fill = hexColor(args[0], args[1], args[2]);
    } else if (fn === OPS.setFillColorN) {
      fill = null;
    } else if (fn === OPS.setStrokeRGBColor) {
      stroke = hexColor(args[0], args[1], args[2]);
    } else if (fn === OPS.setTextRenderingMode) {
      mode = args[0] | 0;
    } else if (fn === OPS.showText) {
      // pdf.js rewrites TJ, ' and " into plain showText, so this is the only
      // text operator there is. Modes 3 and 7 are invisible text — the
      // searchable layer under a scan. Modes 1, 2, 5 and 6 stroke the glyphs
      // as well as filling them, which is how a document fakes a bold face.
      const stroked = mode === 1 || mode === 2 || mode === 5 || mode === 6;
      pushRun(out.runs, glyphText(args[0]), fill, mode === 3 || mode === 7, stroked);
    } else if (IMAGE_OPS.has(fn)) {
      /*
       * A PDF image is always drawn into the unit square and placed by the
       * current transformation matrix, so mapping the unit square gives the
       * rectangle on the page. Tiling and repeating variants are skipped: they
       * are a pattern rather than one picture.
       */
      const place = matMul(viewport.transform, ctm);
      const corners = [applyMat(place, 0, 0), applyMat(place, 1, 0),
                       applyMat(place, 1, 1), applyMat(place, 0, 1)];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of corners) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      const w = maxX - minX, h = maxY - minY;
      if (isFinite(w) && isFinite(h) && w >= 1 && h >= 1) {
        const arg = args[0];
        out.images.push({
          op: i,
          name: typeof arg === 'string' ? arg : null,
          inline: typeof arg !== 'string',
          mask: fn === OPS.paintImageMaskXObject,
          x: minX, y: minY, w, h
        });
      }
    } else if (fn === OPS.constructPath) {
      let k = i + 1;
      if (fnArray[k] === OPS.clip || fnArray[k] === OPS.eoClip) k++;
      const paint = fnArray[k];
      const stroked = STROKES.has(paint) && !nearWhite(stroke);
      const filled = FILLS.has(paint) && !nearWhite(fill);
      if (!stroked && !filled) continue;   // a clip, or white on white

      const path = tracePath(args[0], args[1], matMul(viewport.transform, ctm), OPS);
      const bw = path.x1 - path.x0, bh = path.y1 - path.y0;
      if (!isFinite(bw) || !isFinite(bh)) continue;
      // A page-sized panel is the paper, not something on it.
      if (bw >= pageW * 0.9 && bh >= pageH * 0.9) continue;

      for (const r of path.rects) {
        const w = r[2] - r[0], h = r[3] - r[1];
        const thin = Math.min(w, h) <= 2.6;
        if (thin) {
          addRule(r[0], r[1], r[2], r[3]);
        } else if (stroked) {
          addRule(r[0], r[1], r[2], r[1]);
          addRule(r[0], r[3], r[2], r[3]);
          addRule(r[0], r[1], r[0], r[3]);
          addRule(r[2], r[1], r[2], r[3]);
        } else if (w >= 8 && h >= 8 && out.fills.length < 4000) {
          out.fills.push({ x: r[0], y: r[1], w, h, color: fill || '#000000' });
        }
      }
      if (stroked) {
        for (const [a, b] of path.segs) {
          const dx = Math.abs(a[0] - b[0]), dy = Math.abs(a[1] - b[1]);
          if (dy <= 0.6 && dx >= 4) addRule(Math.min(a[0], b[0]), a[1], Math.max(a[0], b[0]), b[1]);
          else if (dx <= 0.6 && dy >= 4) addRule(a[0], Math.min(a[1], b[1]), b[0], Math.max(a[1], b[1]));
        }
      }
      // A small filled blob is how a browser draws a list bullet.
      if (filled && bw >= 1.5 && bw <= 9 && bh >= 1.5 && bh <= 9 &&
          bw / bh > 0.55 && bw / bh < 1.8 && out.marks.length < 2000) {
        out.marks.push({ x: path.x0, y: path.y0, w: bw, h: bh });
      }
      if (out.drawings.length < 20000) {
        out.drawings.push({ x0: path.x0, y0: path.y0, x1: path.x1, y1: path.y1, curved: path.curved, filled, stroked });
      }
    }
  }
  return out;
}

async function pageTextRuns(page) {
  return (await pageGraphics(page)).runs;
}

async function pageImagePlacements(page) {
  return (await pageGraphics(page)).images;
}

/**
 * Give every text item the colour of the run that painted it.
 *
 * Both streams carry the same glyphs in the same order, so a running pointer
 * into the operator-list text is enough. It is resynchronised rather than
 * trusted, because getTextContent inserts synthetic spacing items that have no
 * counterpart among the glyphs, and font quirks can make the two disagree by a
 * character or two.
 */
function alignColors(items, runs) {
  let flat = '';
  const colors = [];
  const invisible = [];
  const stroked = [];
  for (const r of runs) {
    for (let i = 0; i < r.text.length; i++) {
      colors.push(r.color);
      invisible.push(r.invisible);
      stroked.push(r.stroked);
    }
    flat += r.text;
  }
  if (!flat.length) return;

  let p = 0;
  let lastColor = null;
  let lastInvisible = false;
  let lastStroked = false;

  for (const it of items) {
    const s = it.str || '';
    const first = s.search(/\S/);
    if (first < 0) {
      it.color = lastColor; it.invisible = lastInvisible;
      if (lastStroked) it.bold = true;
      continue;
    }

    let k = -1;
    const limit = Math.min(flat.length, p + s.length + 96);
    for (let i = p; i < limit; i++) if (flat[i] === s[first]) { k = i; break; }
    if (k < 0) {
      it.color = lastColor; it.invisible = lastInvisible;
      if (lastStroked) it.bold = true;
      continue;
    }

    it.color = colors[k];
    it.invisible = invisible[k];
    // Stroked glyphs are a faked bold face; the font name never says so.
    if (stroked[k]) it.bold = true;
    lastColor = it.color;
    lastInvisible = it.invisible;
    lastStroked = stroked[k];

    let i = k, j = first;
    while (i < flat.length && j < s.length) {
      if (flat[i] === s[j]) { i++; j++; }
      else if (/\s/.test(s[j])) j++;
      else if (/\s/.test(flat[i])) i++;
      else break;
    }
    p = i;
  }
}

/** The font most of a set of items' characters are set in. */
function dominantFont(items) {
  const weight = new Map();
  for (const it of items) {
    if (!it.str || !it.str.trim() || !it.font) continue;
    weight.set(it.font, (weight.get(it.font) || 0) + it.str.trim().length);
  }
  let best = '', most = 0;
  for (const [name, n] of weight) if (n > most) { most = n; best = name; }
  return best;
}

/** The colour most of a set of text-carrying pieces is painted in. */
function dominantColor(pieces) {
  const weight = new Map();
  for (const piece of pieces) {
    const text = piece.str != null ? piece.str : piece.text;
    if (!text || !text.trim() || piece.invisible) continue;
    const c = piece.color || '#000000';
    weight.set(c, (weight.get(c) || 0) + text.trim().length);
  }
  let best = null, most = 0;
  for (const [c, n] of weight) if (n > most) { most = n; best = c; }
  return best;
}

/* ------------------------------------------------------------------ *
 * Raw items
 * ------------------------------------------------------------------ */

/**
 * Cut an item in two at a horizontal position.
 *
 * pdf.js joins text that sits close together into one run, and "close" does
 * not respect a table ruling or the edge of a hyperlink. The cut lands on the
 * nearest space when there is one within a few characters, because the
 * per-character position is only an average of the run's width.
 */
function splitItem(it, cutX) {
  const n = it.str.length;
  if (n < 2 || !(it.w > 0)) return null;
  const per = it.w / n;
  let k = Math.round((cutX - it.x) / per);
  for (let d = 0; d <= 3; d++) {
    if (it.str[k + d] === ' ') { k = k + d; break; }
    if (it.str[k - d] === ' ') { k = k - d; break; }
  }
  if (k <= 0 || k >= n) return null;
  const left = Object.assign({}, it, { str: it.str.slice(0, k), w: per * k, source: it.source || it });
  const right = Object.assign({}, it, {
    str: it.str.slice(k), x: it.x + per * k, w: it.w - per * k, source: it.source || it
  });
  if (!left.str.trim() || !right.str.trim()) return null;
  return [left, right];
}

/**
 * Drop the second copy of text that was painted twice.
 *
 * A document without a bold face often fakes one by drawing the same words
 * again a fraction of a point to the side. Both copies come back as text, and
 * a converter that keeps both writes every such word twice.
 */
function dropDoubleStrikes(items) {
  if (items.length < 2) return items;
  const order = items.slice().sort((a, b) => (a.baseline - b.baseline) || (a.x - b.x));
  const dead = new Set();
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    if (dead.has(a) || !a.str.trim()) continue;
    for (let j = i + 1; j < order.length && j <= i + 6; j++) {
      const b = order[j];
      if (dead.has(b)) continue;
      const near = Math.max(0.3, a.size * 0.09);
      if (b.baseline - a.baseline > near) break;
      if (b.str === a.str && Math.abs(b.x - a.x) <= near && Math.abs(b.size - a.size) < 0.05 &&
          !!a.invisible === !!b.invisible) {
        dead.add(b);
        a.bold = true;
      }
    }
  }
  return dead.size ? items.filter((it) => !dead.has(it)) : items;
}

/** The hyperlinks on a page, as rectangles in viewport space. */
async function pageLinks(page, viewport) {
  let annotations;
  try {
    annotations = await page.getAnnotations();
  } catch (e) {
    return [];
  }
  const out = [];
  for (const a of annotations || []) {
    if (a.subtype !== 'Link' || !a.url || !a.rect) continue;
    if (!/^(https?|mailto|ftp):/i.test(a.url)) continue;
    const r = viewport.convertToViewportRectangle(a.rect);
    out.push({
      url: a.url,
      x0: Math.min(r[0], r[2]), x1: Math.max(r[0], r[2]),
      y0: Math.min(r[1], r[3]), y1: Math.max(r[1], r[3])
    });
  }
  return out;
}

function applyLinks(items, links) {
  if (!links.length) return items;
  const out = [];
  const visit = (it, depth) => {
    const mid = it.baseline - it.size * 0.3;
    for (const link of links) {
      if (mid < link.y0 - 1 || mid > link.y1 + 1) continue;
      const right = it.x + it.w;
      const overlap = Math.min(right, link.x1) - Math.max(it.x, link.x0);
      if (overlap <= Math.min(it.w * 0.5, it.size)) continue;
      // The run sticks out of the link on one side: cut it there and look again.
      if (depth < 4) {
        const slack = it.size * 0.6;
        const cut = it.x < link.x0 - slack ? link.x0 : right > link.x1 + slack ? link.x1 : null;
        if (cut != null) {
          const parts = splitItem(it, cut);
          if (parts) { visit(parts[0], depth + 1); visit(parts[1], depth + 1); return; }
        }
      }
      it.link = link.url;
      break;
    }
    out.push(it);
  };
  for (const it of items) visit(it, 0);
  return out;
}

async function pageItems(page, opts) {
  const viewport = page.getViewport({ scale: 1 });

  /*
   * The operator list is read before the text, not after, and that ordering
   * matters: executing it is what puts the page's fonts on commonObjs. Ask for
   * the text first and every font is still anonymous, so the PostScript name —
   * the only place most PDFs record that a face is bold or italic — is not
   * there to read. pdf.js caches the list, so this costs one pass, not two.
   *
   * Callers that want nothing but text and position, such as the search index,
   * skip it and accept that the type will be reported as plain.
   */
  const wantFonts = !!(opts && opts.colors);
  const runs = wantFonts ? await pageTextRuns(page) : [];

  const tc = await page.getTextContent();
  let items = [];
  const fonts = new Map();
  for (const it of tc.items) {
    if (!it.str || !it.transform) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
    const angle = Math.atan2(tx[1], tx[0]);
    /*
     * The height of the em, which is the size the text was set at.
     *
     * Not hypot(c, d): on sheared text — a faked italic — that vector leans
     * over and comes out longer than the type actually is, reporting 12.3pt
     * for 12pt. The perpendicular distance between the baseline and the
     * up-vector is the real height, and it is the same number for upright and
     * rotated text.
     */
    const baseLen = Math.hypot(tx[0], tx[1]);
    const size = (baseLen > 0 ? Math.abs(tx[0] * tx[3] - tx[1] * tx[2]) / baseLen : 0) ||
      Math.hypot(tx[2], tx[3]) || Math.abs(tx[3]) || 10;
    const w = it.width || 0;
    if (!it.str.trim() && w <= 0) continue;
    let f = fonts.get(it.fontName);
    if (!f) {
      f = fontInfo(page, tc, it.fontName);
      fonts.set(it.fontName, f);
    }
    /*
     * A text matrix that shears the glyphs is a faked italic, which documents
     * do when they have no italic face for the family they are using.
     *
     * Upright text has its up-vector (c, d) at a right angle to its baseline
     * (a, b), so the normalised dot product of the two is zero; shearing tilts
     * them together and the dot product becomes the sine of the slant. Taking
     * the angle of (c, d) on its own would not work, because the viewport
     * flips Y and every upright glyph would look slanted by half a turn.
     */
    const upLen = Math.hypot(tx[2], tx[3]);
    const shear = baseLen > 0 && upLen > 0
      ? Math.abs((tx[0] * tx[2] + tx[1] * tx[3]) / (baseLen * upLen))
      : 0;
    const ascent = f.ascent || 0.82;
    items.push({
      str: it.str,
      x: tx[4],
      baseline: tx[5],
      y: tx[5] - size * ascent,
      w,
      h: size,
      size: Math.round(size * 100) / 100,
      ascent,
      descent: f.descent || 0.2,
      angle,
      rotated: Math.abs(angle) > 0.08,
      font: f.name,
      fontId: it.fontName,
      face: f.face,
      family: f.family,
      bold: f.bold,
      italic: f.italic || shear > 0.12,   // about 7 degrees of slant
      mono: f.mono,
      serif: f.serif,
      hasEOL: !!it.hasEOL,
      color: null,
      invisible: false
    });
  }
  if (wantFonts) alignColors(items, runs);
  items = dropDoubleStrikes(items);
  if (opts && opts.links) {
    const links = await pageLinks(page, viewport);
    if (links.length) items = applyLinks(items, links);
  }
  return { viewport, items };
}

/* ------------------------------------------------------------------ *
 * Lines
 * ------------------------------------------------------------------ */

const BULLET_MARK = /^\s*([•●○◦▪▫■□◆◇▶►➢➤✓✔‣⁃·∙*–—-]|[-])[ \t ]+/;
const ORDERED_MARK = /^\s*(\(?(?:\d{1,3}|[a-z]|x{0,3}(?:ix|iv|v?i{1,3}|v))[.)]|\((?:[A-Z]|X{0,3}(?:IX|IV|V?I{1,3}|V))\)|(?:[A-Z]|X{0,3}(?:IX|IV|V?I{1,3}|V))\))[ \t ]+/;
const MARK_ONLY = /^\s*(?:[•●○◦▪▫■□◆◇▶►➢➤✓✔‣⁃·∙*–—-]|[-]|\(?(?:\d{1,3}|[a-zA-Z]|[ivxIVX]{1,5})[.)]|\((?:\d{1,3}|[a-zA-Z]|[ivxIVX]{1,5})\))\s*$/;

/** The list marker a line of text opens with, if it opens with one. */
function parseMarker(text) {
  let m = BULLET_MARK.exec(text);
  if (m) return { kind: 'bullet', marker: m[1], length: m[0].length };
  m = ORDERED_MARK.exec(text);
  if (m) return { kind: 'ordered', marker: m[1], length: m[0].length };
  return null;
}

/** How far an item reaches, for text that reports no width of its own. */
function itemRight(it) {
  return it.x + (it.w > 0 ? it.w : it.size * 0.5 * it.str.length);
}

/**
 * Turn a set of items sharing a baseline into a line: reading order, text with
 * the right spaces in it, and the size, weight and colour most of it is in.
 *
 * `seps[k]` is what was put in front of `items[k]` — nothing, a space, or a tab
 * where the gap was wide enough to be a column — so the runs can be rebuilt
 * later without measuring the gaps again.
 */
function makeLine(source) {
  const its = source.filter((it) => it.str && it.str.trim()).sort((a, b) => a.x - b.x);
  const line = { items: its, seps: [] };

  // The size most of the line is set in. An average would be dragged down by
  // a footnote marker and up by a drop cap.
  const tally = new Map();
  for (const it of its) {
    const key = Math.round(it.size * 2) / 2;
    tally.set(key, (tally.get(key) || 0) + Math.max(1, it.str.trim().length));
  }
  let bucket = 10, most = -1;
  for (const [key, n] of tally) if (n > most) { most = n; bucket = key; }

  let chars = 0, boldChars = 0, italicChars = 0, monoChars = 0, serifChars = 0;
  let x = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  let sizeSum = 0, baseSum = 0, mainChars = 0;
  for (const it of its) {
    const n = Math.max(1, it.str.trim().length);
    chars += n;
    if (it.bold) boldChars += n;
    if (it.italic) italicChars += n;
    if (it.mono) monoChars += n;
    if (it.serif) serifChars += n;
    x = Math.min(x, it.x);
    right = Math.max(right, itemRight(it));
    if (Math.abs(it.size - bucket) <= 0.5) {
      sizeSum += it.size * n;
      baseSum += it.baseline * n;
      mainChars += n;
      top = Math.min(top, it.y);
      bottom = Math.max(bottom, it.y + it.h);
    }
  }
  const size = mainChars ? sizeSum / mainChars : bucket;
  const baseline = mainChars ? baseSum / mainChars : (its[0] ? its[0].baseline : 0);

  let text = '';
  const segments = [];
  let seg = null;
  let prev = null;
  for (const it of its) {
    // Smaller type sitting off the baseline is a superscript or a subscript.
    it.script = null;
    if (it.size < size * 0.82) {
      const lift = baseline - it.baseline;
      if (lift > size * 0.12) it.script = 'sup';
      else if (lift < -size * 0.06) it.script = 'sub';
    }
    // pdf.js bridges the space between two pieces of text with a synthetic
    // blank run whose width covers the whole gap; those were dropped above, so
    // gaps are always measured between runs that carry real glyphs.
    const gap = prev ? it.x - itemRight(prev) : 0;
    const ref = Math.max(it.size, prev ? prev.size : 0);
    let sep = '';
    if (prev) {
      if (gap > ref * 1.1) sep = '\t';
      else if (gap > ref * 0.16 && !/\s$/.test(text) && !/^\s/.test(it.str)) sep = ' ';
    }
    // A list marker standing clear of its text is still one piece with it:
    // split there and every list looks like a two-column table.
    if (sep === '\t' && segments.length === 1 && MARK_ONLY.test(seg.text)) sep = ' ';
    line.seps.push(sep);
    text += sep + it.str;
    if (!seg || sep === '\t') {
      seg = { x: it.x, right: itemRight(it), text: it.str, items: [it] };
      segments.push(seg);
    } else {
      seg.text += sep + it.str;
      seg.right = Math.max(seg.right, itemRight(it));
      seg.items.push(it);
    }
    prev = it;
  }

  line.text = text.replace(/\s+$/, '');
  line.x = x === Infinity ? 0 : x;
  line.right = right === -Infinity ? 0 : right;
  line.baseline = baseline;
  line.y = top === Infinity ? baseline - size * 0.82 : top;
  line.bottom = bottom === -Infinity ? baseline + size * 0.18 : bottom;
  line.w = Math.max(0, line.right - line.x);
  line.h = Math.max(1, line.bottom - line.y);
  line.size = Math.round(size * 100) / 100;
  line.chars = chars;
  line.bold = chars > 0 && boldChars / chars > 0.6;
  line.italic = chars > 0 && italicChars / chars > 0.6;
  line.mono = chars > 0 && monoChars / chars > 0.6;
  line.serif = chars > 0 && serifChars / chars > 0.6;
  line.font = dominantFont(its);
  line.color = dominantColor(its) || '#000000';
  // Invisible only when nothing on the line is meant to be seen — a searchable
  // layer under a scan, rather than one hidden word inside a visible sentence.
  line.invisible = its.length > 0 && its.every((i) => i.invisible);
  line.segments = segments.map((s) => ({ x: s.x, right: s.right, text: s.text.trim(), items: s.items }));
  return line;
}

/** Items that share a baseline, as arrays, top to bottom. */
function clusterRows(upright) {
  const order = upright.slice().sort((a, b) => (a.baseline - b.baseline) || (a.x - b.x));
  const rows = [];
  let cur = null;
  for (const it of order) {
    const tol = Math.max(1.6, it.size * 0.45);
    if (cur && Math.abs(it.baseline - cur.baseline) <= tol) {
      cur.items.push(it);
      cur.baseline = (cur.baseline * (cur.items.length - 1) + it.baseline) / cur.items.length;
    } else {
      cur = { baseline: it.baseline, items: [it] };
      rows.push(cur);
    }
  }
  return rows.map((r) => r.items);
}

function buildLines(upright) {
  const lines = clusterRows(upright).map(makeLine).filter((l) => l.items.length);
  lines.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return lines;
}

/**
 * The angle most of the text on the page is drawn at, weighted by how many
 * characters sit at it, in five-degree buckets.
 */
function dominantAngle(items) {
  const buckets = new Map();
  let total = 0;
  for (const it of items) {
    const deg = Math.round((it.angle * 180 / Math.PI) / 5) * 5;
    const n = Math.max(1, it.str.length);
    buckets.set(deg, (buckets.get(deg) || 0) + n);
    total += n;
  }
  let deg = 0, weight = 0;
  for (const [d, n] of buckets) if (n > weight) { weight = n; deg = d; }
  return { deg, share: total ? weight / total : 0 };
}

/**
 * Turn every item on the page by `radians` about the origin, then shift the
 * result back into positive space. Only the relative layout matters to the
 * line and paragraph grouping that follows, so the translation is arbitrary.
 */
function rotateItems(items, radians) {
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const out = items.map((it) => {
    const x = it.x * cos - it.baseline * sin;
    const baseline = it.x * sin + it.baseline * cos;
    const angle = it.angle + radians;
    return Object.assign({}, it, {
      x,
      baseline,
      y: baseline - it.size * 0.82,
      angle,
      rotated: Math.abs(angle) > 0.08
    });
  });
  let minX = Infinity, minY = Infinity;
  for (const it of out) { minX = Math.min(minX, it.x); minY = Math.min(minY, it.y); }
  if (!isFinite(minX)) return out;
  for (const it of out) { it.x -= minX; it.baseline -= minY; it.y -= minY; }
  return out;
}

/**
 * The page's text as rows: everything on one baseline, right across the page.
 *
 * A page whose text is uniformly rotated — a landscape scan, or a page whose
 * /Rotate pdf.js has folded into the text matrix — yields items that are all
 * "rotated". Grouping only the upright ones then leaves no lines at all, and
 * every text export silently produces a blank page. When the upright pass
 * finds nothing and the rotated items agree on an angle, the page is turned
 * back upright and regrouped so the content survives.
 *
 * `bounds` reports the width the caller should treat the page as having:
 * turning a landscape page upright swaps its width and height, and paragraph
 * alignment is measured against that width.
 */
function groupLines(items) {
  const upright = items.filter((i) => !i.rotated);
  const rotated = items.filter((i) => i.rotated);
  const lines = buildLines(upright);
  if (lines.length || rotated.length < 2) return { lines, rotated, bounds: null };

  const { deg, share } = dominantAngle(rotated);
  if (share < 0.6 || deg === 0) return { lines, rotated, bounds: null };

  const turned = rotateItems(rotated, -deg * Math.PI / 180);
  const recovered = buildLines(turned.filter((i) => !i.rotated));
  if (!recovered.length) return { lines, rotated, bounds: null };

  let width = 0;
  for (const l of recovered) width = Math.max(width, l.right);
  return {
    lines: recovered,
    rotated: turned.filter((i) => i.rotated),
    bounds: { width: width || null, angle: deg }
  };
}

/* ------------------------------------------------------------------ *
 * Ruled tables
 *
 * A table with its grid drawn is the one piece of structure a PDF does state:
 * the lines are there to be read. Following them gives exact cells, including
 * the merged ones and the ones holding several lines of text, none of which
 * can be told from the positions of the words alone.
 * ------------------------------------------------------------------ */

/** Join the pieces of one drawn line: borders usually arrive a cell at a time. */
function mergeRules(rules, horizontal) {
  let list = rules.map((r) => (horizontal
    ? { p: r.y, a: r.x0, b: r.x1 }
    : { p: r.x, a: r.y0, b: r.y1 }));
  for (let pass = 0; pass < 3; pass++) {
    list.sort((u, v) => (u.p - v.p) || (u.a - v.a));
    const out = [];
    let changed = false;
    for (const r of list) {
      let merged = false;
      for (let k = out.length - 1; k >= 0 && r.p - out[k].p <= 1.5; k--) {
        const o = out[k];
        if (r.a <= o.b + 2 && r.b >= o.a - 2) {
          o.a = Math.min(o.a, r.a);
          o.b = Math.max(o.b, r.b);
          merged = true;
          changed = true;
          break;
        }
      }
      if (!merged) out.push({ p: r.p, a: r.a, b: r.b });
    }
    list = out;
    if (!changed) break;
  }
  return list;
}

function clusterValues(values, tolerance) {
  const sorted = values.slice().sort((a, b) => a - b);
  const out = [];
  let sum = 0, n = 0, last = null;
  for (const v of sorted) {
    if (last != null && v - last > tolerance) {
      out.push(sum / n);
      sum = 0; n = 0;
    }
    sum += v; n++;
    last = v;
  }
  if (n) out.push(sum / n);
  return out;
}

/** Sets of rulings that cross each other often enough to be a grid. */
function findLattices(hRules, vRules) {
  if (hRules.length < 2 || vRules.length < 2) return [];
  const H = mergeRules(hRules, true);
  const V = mergeRules(vRules, false);
  if (H.length < 2 || V.length < 2 || H.length > 3000 || V.length > 3000) return [];

  const parent = new Array(H.length + V.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const tol = 2;
  for (let i = 0; i < H.length; i++) {
    const h = H[i];
    for (let j = 0; j < V.length; j++) {
      const v = V[j];
      if (v.p >= h.a - tol && v.p <= h.b + tol && h.p >= v.a - tol && h.p <= v.b + tol) {
        parent[find(i)] = find(H.length + j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < parent.length; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) { g = { h: [], v: [] }; groups.set(r, g); }
    if (i < H.length) g.h.push(H[i]); else g.v.push(V[i - H.length]);
  }

  const out = [];
  for (const g of groups.values()) {
    if (g.h.length < 2 || g.v.length < 2) continue;
    const ys = clusterValues(g.h.map((r) => r.p), 1.5);
    const xs = clusterValues(g.v.map((r) => r.p), 1.5);
    // A grid drawn without its outer frame still has outer cells: the rulings
    // run past the last line that crosses them.
    const hMin = Math.min(...g.h.map((r) => r.a)), hMax = Math.max(...g.h.map((r) => r.b));
    const vMin = Math.min(...g.v.map((r) => r.a)), vMax = Math.max(...g.v.map((r) => r.b));
    if (hMin < xs[0] - 4) xs.unshift(hMin);
    if (hMax > xs[xs.length - 1] + 4) xs.push(hMax);
    if (vMin < ys[0] - 4) ys.unshift(vMin);
    if (vMax > ys[ys.length - 1] + 4) ys.push(vMax);
    if (xs.length < 3 || ys.length < 3) continue;   // fewer than two columns or two rows
    out.push({ xs, ys, H: g.h, V: g.v });
  }
  return out;
}

function indexIn(bounds, value) {
  for (let i = 0; i + 1 < bounds.length; i++) {
    if (value >= bounds[i] && value < bounds[i + 1]) return i;
  }
  return value < bounds[0] ? 0 : bounds.length - 2;
}

function overlapLength(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

const NUMERIC_CELL = /^[\s$€£¥৳₹+\-(]*\d[\d\s.,]*\)?\s*%?$/;

/** How a cell's text sits between the edges of its cell. */
function cellAlign(lines, x0, x1) {
  if (!lines.length) return 'left';
  let left = Infinity, right = Infinity;
  for (const l of lines) {
    left = Math.min(left, l.x - x0);
    right = Math.min(right, x1 - l.right);
  }
  if (right < left - 4 && right < (x1 - x0) * 0.25) return 'right';
  if (Math.abs(left - right) <= 3 && left > 4) return 'center';
  return 'left';
}

function makeCell(lines, row, col, rowspan, colspan, box) {
  const text = lines.map((l) => l.text.replace(/\t/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean).join(' ');
  const chars = lines.reduce((n, l) => n + l.chars, 0);
  const bold = chars > 0 && lines.reduce((n, l) => n + (l.bold ? l.chars : 0), 0) / chars > 0.6;
  return {
    row, col, rowspan, colspan,
    x: box.x, y: box.y, w: box.w, h: box.h,
    lines, text, bold,
    align: cellAlign(lines, box.x, box.x + box.w)
  };
}

/** A header row is bold where the rows under it are not. */
function headerRows(cells) {
  if (cells.length < 2) return 0;
  const first = cells[0].filter((c) => c && c.text);
  if (!first.length || !first.every((c) => c.bold)) return 0;
  for (let r = 1; r < cells.length; r++) {
    if (cells[r].some((c) => c && c.text && !c.bold)) return 1;
  }
  return 0;
}

/*
 * How each column is aligned, read from the column as a whole: the edge its
 * cells share is the edge they were set against. One cell on its own cannot
 * say — its padding looks much the same either way.
 */
function columnAligns(cells, ncols) {
  const out = [];
  const spread = (v) => (v.length ? Math.max(...v) - Math.min(...v) : 0);
  for (let c = 0; c < ncols; c++) {
    const lefts = [], rights = [], centres = [];
    let numeric = 0, texts = 0;
    for (let r = 0; r < cells.length; r++) {
      const cell = cells[r][c];
      if (!cell || !cell.text || cell.colspan !== 1) continue;
      const x = Math.min(...cell.lines.map((l) => l.x));
      const right = Math.max(...cell.lines.map((l) => l.right));
      lefts.push(x); rights.push(right); centres.push((x + right) / 2);
      texts++;
      if (NUMERIC_CELL.test(cell.text)) numeric++;
    }
    let align = 'left';
    if (texts >= 2) {
      // The share of cells that sit on the edge most of them sit on; a
      // heading aligned differently from its column must not outvote it.
      const share = (v, tol) => {
        const mid = median(v);
        return v.filter((x) => Math.abs(x - mid) <= tol).length / v.length;
      };
      const l = share(lefts, 1.5), r = share(rights, 1.5), m = share(centres, 2);
      if (spread(lefts) <= 1.5 && spread(rights) <= 1.5) align = numeric > texts / 2 ? 'right' : 'left';
      else if (r >= 0.6 && r > l) align = 'right';
      else if (l >= 0.6) align = 'left';
      else if (m >= 0.6 && m > l && m > r) align = 'center';
      else if (numeric > texts / 2) align = 'right';
    }
    out.push(align);
    for (let r = 0; r < cells.length; r++) {
      const cell = cells[r][c];
      if (cell && cell.colspan === 1 && cell.rowspan === 1) cell.align = align;
    }
  }
  return out;
}

function finishTable(table) {
  const { cells } = table;
  table.nrows = cells.length;
  table.ncols = table.colX.length - 1;
  table.rows = cells.map((row) => row.map((c) => (c ? c.text : '')));
  table.columns = table.colX.slice(0, -1);
  table.header = headerRows(cells);
  table.aligns = columnAligns(cells, table.ncols);
  table.lines = [];
  for (const row of cells) for (const c of row) if (c) for (const l of c.lines) table.lines.push(l);
  table.sourceLines = new Set(table.lines);
  return table;
}

/** Read the text inside a drawn grid into its cells. */
function ruledTable(lattice, items) {
  const { xs, ys, H, V } = lattice;
  const R = ys.length - 1, C = xs.length - 1;
  const x0 = xs[0], x1 = xs[C], y0 = ys[0], y1 = ys[R];

  const inside = items.filter((it) => {
    if (it.used) return false;
    const cx = it.x + (itemRight(it) - it.x) / 2;
    const cy = it.baseline - it.size * 0.3;
    return cx >= x0 - 1 && cx <= x1 + 1 && cy >= y0 - 1 && cy <= y1 + 1;
  });
  if (!inside.length) return null;

  const hasV = (c, r) => V.some((o) => Math.abs(o.p - xs[c]) <= 2 &&
    overlapLength(o.a, o.b, ys[r], ys[r + 1]) >= (ys[r + 1] - ys[r]) * 0.7);
  const hasH = (r, c) => H.some((o) => Math.abs(o.p - ys[r]) <= 2 &&
    overlapLength(o.a, o.b, xs[c], xs[c + 1]) >= (xs[c + 1] - xs[c]) * 0.7);

  // Cells with no line between them are one merged cell.
  const parent = new Array(R * C);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (c + 1 < C && !hasV(c + 1, r)) parent[find(r * C + c)] = find(r * C + c + 1);
      if (r + 1 < R && !hasH(r + 1, c)) parent[find(r * C + c)] = find((r + 1) * C + c);
    }
  }
  const groups = new Map();
  for (let i = 0; i < parent.length; i++) {
    const root = find(i);
    let g = groups.get(root);
    if (!g) { g = { r0: R, c0: C, r1: -1, c1: -1, n: 0, items: [] }; groups.set(root, g); }
    const r = Math.floor(i / C), c = i % C;
    g.r0 = Math.min(g.r0, r); g.r1 = Math.max(g.r1, r);
    g.c0 = Math.min(g.c0, c); g.c1 = Math.max(g.c1, c);
    g.n++;
  }
  // A merged region that is not a rectangle cannot be one cell; unmerge it.
  const cellOf = (r, c) => {
    const g = groups.get(find(r * C + c));
    if (g.n === (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1)) return g;
    const key = 'solo' + (r * C + c);
    let solo = groups.get(key);
    if (!solo) { solo = { r0: r, c0: c, r1: r, c1: c, n: 1, items: [], solo: true }; groups.set(key, solo); }
    return solo;
  };

  const place = (it, depth) => {
    const cy = it.baseline - it.size * 0.3;
    const r = indexIn(ys, cy);
    const right = itemRight(it);
    const c = indexIn(xs, it.x + (right - it.x) / 2);
    if (depth < 6) {
      // Text that runs across a drawn column line is two cells' worth.
      for (let b = 1; b < C; b++) {
        const edge = xs[b];
        if (edge > it.x + it.size * 0.4 && edge < right - it.size * 0.4 && hasV(b, r)) {
          const parts = splitItem(it, edge);
          if (parts) { place(parts[0], depth + 1); place(parts[1], depth + 1); return; }
        }
      }
    }
    cellOf(r, c).items.push(it);
  };
  for (const it of inside) place(it, 0);

  const cells = [];
  for (let r = 0; r < R; r++) cells.push(new Array(C).fill(null));
  let filled = 0, total = 0, deepest = 0;
  const seen = new Set();
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const g = cellOf(r, c);
      if (seen.has(g)) continue;
      seen.add(g);
      total++;
      const lines = buildLines(g.items);
      if (lines.length) filled++;
      deepest = Math.max(deepest, lines.length);
      cells[g.r0][g.c0] = makeCell(lines, g.r0, g.c0, g.r1 - g.r0 + 1, g.c1 - g.c0 + 1, {
        x: xs[g.c0], y: ys[g.r0], w: xs[g.c1 + 1] - xs[g.c0], h: ys[g.r1 + 1] - ys[g.r0]
      });
    }
  }

  // A frame around a page of prose is a grid too, but it is not a table: its
  // "cells" hold whole columns of text.
  if (filled < 2 || deepest > 14) return null;
  if (total >= 4 && filled / total < 0.2) return null;
  const rowsWithText = cells.filter((row) => row.some((c) => c && c.text)).length;
  if (rowsWithText < 2) return null;

  for (const it of inside) (it.source || it).used = it.used = true;
  return finishTable({
    ruled: true,
    x: x0, y: y0, w: x1 - x0, h: y1 - y0,
    colX: xs.slice(), rowY: ys.slice(),
    cells
  });
}

/* ------------------------------------------------------------------ *
 * Columns and borderless tables
 *
 * With the ruled tables out of the way, what is left is cut up by its white
 * space. Rows of text that leave the same vertical strip of the page empty,
 * line after line, are either columns of prose or the columns of a table with
 * no lines drawn; which of the two is decided by what is in them.
 * ------------------------------------------------------------------ */

/** Add [x0, x1] to a sorted list of covered spans, closing gaps under `join`. */
function coverAdd(cover, x0, x1, join) {
  const out = [];
  let a = x0, b = x1, placed = false;
  for (const span of cover) {
    if (span[1] + join < a) {
      out.push(span);
    } else if (b + join < span[0]) {
      if (!placed) { out.push([a, b]); placed = true; }
      out.push(span);
    } else {
      a = Math.min(a, span[0]);
      b = Math.max(b, span[1]);
    }
  }
  if (!placed) out.push([a, b]);
  return out;
}

function coverRow(cover, row) {
  const join = Math.max(3, row.size * 0.6);
  let out = cover;
  for (const box of row.boxes) out = coverAdd(out, box.x0, box.x1, join);
  return out;
}

/** The rows a layout region is made of: text on a baseline, or one solid block. */
function bandRow(items) {
  const line = makeLine(items);
  return {
    y: line.y, bottom: line.bottom, baseline: line.baseline, size: line.size, chars: line.chars,
    boxes: line.items.map((it) => ({ x0: it.x, x1: itemRight(it), it }))
  };
}

function blockRow(block) {
  return {
    y: block.y, bottom: block.y + block.h, baseline: block.y, size: 10, chars: 0,
    block,
    boxes: [{ x0: block.x, x1: block.x + block.w, block }]
  };
}

/** How many text rows a row is worth when counting what stands beside a gutter. */
function rowWeight(row, em) {
  if (!row.block) return 1;
  return Math.max(1, Math.round((row.bottom - row.y) / Math.max(6, em * 1.2)));
}

/**
 * The gaps in `cover` wide enough, and flanked by enough rows on both sides,
 * to be taken for a gutter rather than a coincidence between two loose lines.
 */
function validGutters(rows, s, e, cover) {
  const out = [];
  if (cover.length < 2) return out;
  const sizes = [];
  for (let i = s; i <= e; i++) if (!rows[i].block) sizes.push(rows[i].size);
  const em = median(sizes) || 10;
  for (let g = 0; g + 1 < cover.length; g++) {
    const a = cover[g][1], b = cover[g + 1][0];
    const width = b - a;
    const mid = (a + b) / 2;
    let left = 0, right = 0;
    for (let i = s; i <= e; i++) {
      const row = rows[i];
      let l = false, r = false;
      for (const box of row.boxes) {
        if (box.x1 <= mid) l = true;
        else if (box.x0 >= mid) r = true;
      }
      const weight = rowWeight(row, em);
      if (l) left += weight;
      if (r) right += weight;
    }
    const few = Math.min(left, right);
    if ((width >= em * 1.5 && few >= 2) || (width >= em && few >= 3) ||
        (width >= Math.max(3, em * 0.6) && few >= 5)) {
      out.push({ x0: a, x1: b, mid });
    }
  }
  return out;
}

function countGaps(cover) {
  return Math.max(0, cover.length - 1);
}

/**
 * Runs of rows that each hold three or more separate pieces of text and keep
 * the same gaps between them. That is a table, and it is found before columns
 * are looked for: a table sitting above two columns of prose can share its
 * middle gap with the gutter between them, and would otherwise be cut in half
 * along it.
 */
function findTableRuns(rows) {
  const runs = [];
  const n = rows.length;
  let i = 0;
  let floor = 0;
  while (i < n) {
    const row = rows[i];
    if (row.block || coverRow([], row).length < 3) { i++; continue; }
    let cover = coverRow([], row);
    let s = i, e = i;
    while (e + 1 < n && !rows[e + 1].block) {
      const below = rows[e + 1];
      // A table does not carry on across a paragraph's worth of space.
      if (below.baseline - rows[e].baseline > Math.max(below.size, rows[e].size) * 2.6) break;
      const next = coverRow(cover, below);
      if (countGaps(next) < 2 || countGaps(next) < countGaps(cover)) break;
      cover = next;
      e++;
    }
    // A last row with a single piece of text in it is the line after the
    // table — a note, a heading — that happened to fit inside one column.
    while (e > i && coverRow([], rows[e]).length < 2) e--;
    cover = [];
    for (let k = i; k <= e; k++) cover = coverRow(cover, rows[k]);
    // A header row above with fewer cells still belongs, as long as it keeps
    // every gap and is not a lone caption.
    while (s - 1 >= floor && !rows[s - 1].block) {
      const above = rows[s - 1];
      if (coverRow([], above).length < 2) break;
      if (rows[s].baseline - above.baseline > Math.max(above.size, rows[s].size) * 2.6) break;
      const next = coverRow(cover, above);
      if (countGaps(next) < countGaps(cover)) break;
      cover = next;
      s--;
    }
    const gutters = e > s ? validGutters(rows, s, e, cover) : [];
    if (gutters.length >= 2) {
      runs.push({ s, e, gutters });
      floor = e + 1;
      i = e + 1;
    } else {
      i++;
    }
  }
  return runs;
}

/**
 * Does one of a table run's gaps carry on, open, well past the run?
 *
 * Then it is the gutter between two columns of the page, and what looked like
 * a three-column table is a line of prose beside a two-column one. That is
 * only believed when the run's other gaps all lie on one side of it: with
 * gaps on both sides the run is one wide table whose middle happens to line
 * up with the gutter.
 */
function runSitsInColumn(rows, run) {
  const length = run.e - run.s + 1;
  for (const g of run.gutters) {
    const open = (row) => !row.boxes.some((b) => b.x0 < g.x1 - 1 && b.x1 > g.x0 + 1);
    let extra = 0, left = 0, right = 0;
    const count = (row) => {
      extra++;
      if (row.boxes.some((b) => b.x1 <= g.mid)) left++;
      if (row.boxes.some((b) => b.x0 >= g.mid)) right++;
    };
    for (let i = run.s - 1; i >= 0 && open(rows[i]); i--) count(rows[i]);
    for (let i = run.e + 1; i < rows.length && open(rows[i]); i++) count(rows[i]);
    if (extra < Math.max(4, length) || left < 2 || right < 2) continue;
    const others = run.gutters.filter((o) => o !== g);
    if (others.every((o) => o.mid < g.mid) || others.every((o) => o.mid > g.mid)) return true;
  }
  return false;
}

/** The longest stretch of rows from `s` down that keeps a gutter open. */
function findBand(rows, s, lo, hi) {
  const raw = [];
  let cover = [];
  let lastGaps = -1;
  for (let e = s; e < rows.length; e++) {
    cover = coverRow(cover, rows[e]);
    raw.push(cover);
    if (cover.length > 1) lastGaps = e - s;
    const em = rows[e].size || 10;
    if (cover.length === 1 && cover[0][0] <= lo + em && cover[0][1] >= hi - em) break;
  }
  let tries = 0;
  for (let k = lastGaps; k >= 1 && tries < 10; k--) {
    if (raw[k].length < 2) continue;
    tries++;
    const gutters = validGutters(rows, s, s + k, raw[k]);
    if (gutters.length) return { end: s + k, gutters };
  }
  return null;
}

/** Deal a band's rows out into the strips its gutters divide it into. */
function splitStrips(rows, gutters) {
  const cuts = gutters.map((g) => g.mid);
  const strips = [];
  for (let k = 0; k <= cuts.length; k++) strips.push({ rows: [], x0: Infinity, x1: -Infinity });
  const grid = [];
  for (const row of rows) {
    const parts = strips.map(() => []);
    for (const box of row.boxes) {
      const centre = (box.x0 + box.x1) / 2;
      let k = 0;
      while (k < cuts.length && centre > cuts[k]) k++;
      parts[k].push(box);
      strips[k].x0 = Math.min(strips[k].x0, box.x0);
      strips[k].x1 = Math.max(strips[k].x1, box.x1);
    }
    const subs = parts.map((boxes) => {
      if (!boxes.length) return null;
      if (boxes[0].block) return blockRow(boxes[0].block);
      return bandRow(boxes.map((b) => b.it));
    });
    subs.forEach((sub, k) => { if (sub) strips[k].rows.push(sub); });
    grid.push(subs);
  }
  return { strips, grid };
}

/** Is a strip a column of running text, or a column of table cells? */
function stripIsProse(strip) {
  const rows = strip.rows.filter((r) => !r.block);
  if (rows.length < 2) return null;
  const width = strip.x1 - strip.x0;
  const chars = median(rows.map((r) => r.chars));
  let wide = 0;
  for (const r of rows) {
    const extent = r.boxes[r.boxes.length - 1].x1 - r.boxes[0].x0;
    if (extent >= width * 0.7) wide++;
  }
  return chars >= 18 && wide / rows.length >= 0.5;
}

/*
 * A strip of nothing but small whole numbers counting upwards is the line
 * numbering in the margin of a contract or a listing, not content.
 */
function stripIsLineNumbers(strip, beside) {
  const rows = strip.rows.filter((r) => !r.block);
  if (rows.length < 3) return false;
  let prev = null;
  for (const r of rows) {
    const text = r.boxes.map((b) => b.it.str).join('').trim();
    if (!/^\d{1,4}$/.test(text)) return false;
    const n = parseInt(text, 10);
    if (prev != null && n !== prev + 1) return false;
    prev = n;
  }
  // A numbered column beside ordinary cells is a table's own numbering and
  // stays. Beside running text or a listing it is the margin count.
  const others = beside.rows.filter((r) => !r.block);
  const mono = others.length > 0 && others.every((r) => r.boxes.every((b) => b.it.mono));
  return mono || stripIsProse(beside) === true;
}

function classifyBand(strips, grid) {
  let judged = 0, prose = 0, shortest = Infinity;
  for (const strip of strips) {
    if (strip.rows.some((r) => r.block)) return 'columns';
    const verdict = stripIsProse(strip);
    if (verdict == null) continue;
    judged++;
    if (verdict) prose++;
    else shortest = Math.min(shortest, strip.rows.length);
  }
  if (judged && prose === judged) return 'columns';
  // Table rows are aligned: most rows put something in two or more columns.
  let shared = 0;
  for (const subs of grid) if (subs.filter(Boolean).length >= 2) shared++;
  const want = isFinite(shortest) ? shortest : grid.length;
  return shared >= 2 && shared >= want * 0.5 ? 'table' : 'columns';
}

/** A borderless table from a band: one row per baseline, one column per strip. */
function streamTable(rows, strips, grid) {
  const ncols = strips.length;
  const colX = [];
  for (let k = 0; k < ncols; k++) {
    const left = isFinite(strips[k].x0) ? strips[k].x0 : (k ? colX[k - 1] : 0);
    colX.push(k === 0 ? left : (isFinite(strips[k - 1].x1) ? (strips[k - 1].x1 + left) / 2 : left));
  }
  let rightEdge = -Infinity;
  for (const s of strips) if (isFinite(s.x1)) rightEdge = Math.max(rightEdge, s.x1);
  colX.push(rightEdge);

  const logical = [];   // { y, bottom, lines: [ [line...] per column ] }
  for (let r = 0; r < grid.length; r++) {
    const subs = grid[r];
    const lines = subs.map((sub) => (sub ? [makeLine(sub.boxes.map((b) => b.it))] : []));
    const filled = lines.filter((l) => l.length).length;
    const last = logical[logical.length - 1];
    /*
     * A row with nothing in the first column, and less in it than the row
     * above, is the second line of a wrapped cell — unless it carries a
     * number, because a row of figures under a blank label is a row of its
     * own: the label was simply not repeated.
     */
    let wraps = false;
    if (last && !lines[0].length && filled < last.filled) {
      const step = rows[r].baseline - last.baseline;
      const numeric = lines.some((l) => l.length && NUMERIC_CELL.test(l[0].text));
      const inside = lines.every((l, k) => !l.length || last.lines[k].length);
      wraps = !numeric && inside && step <= Math.max(rows[r].size, last.size) * 1.7;
    }
    if (wraps) {
      lines.forEach((l, k) => { if (l.length) last.lines[k].push(l[0]); });
      last.bottom = Math.max(last.bottom, rows[r].bottom);
      last.baseline = rows[r].baseline;
    } else {
      logical.push({
        y: rows[r].y, bottom: rows[r].bottom, baseline: rows[r].baseline,
        size: rows[r].size, filled, lines
      });
    }
  }

  const rowY = logical.map((l) => l.y);
  rowY.push(logical.length ? logical[logical.length - 1].bottom : 0);
  const cells = logical.map((l, r) => l.lines.map((cellLines, c) => makeCell(cellLines, r, c, 1, 1, {
    x: colX[c], y: l.y, w: colX[c + 1] - colX[c], h: l.bottom - l.y
  })));

  return finishTable({
    ruled: false,
    x: colX[0], y: rowY[0], w: colX[ncols] - colX[0], h: rowY[rowY.length - 1] - rowY[0],
    colX, rowY, cells
  });
}

/** Two borderless tables, one straight under the other with the same columns, are one. */
function mergeTables(blocks) {
  const out = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    if (block.type === 'table' && last && last.type === 'table' &&
        !block.table.ruled && !last.table.ruled && block.table.ncols === last.table.ncols) {
      const a = last.table, b = block.table;
      const em = 10;
      let same = b.y - (a.y + a.h) < em * 3;
      for (let c = 1; same && c < a.ncols; c++) {
        if (Math.abs(a.colX[c] - b.colX[c]) > em * 1.5) same = false;
      }
      if (same) {
        const offset = a.cells.length;
        for (const row of b.cells) {
          for (const cell of row) if (cell) cell.row += offset;
          a.cells.push(row);
        }
        a.rowY = a.rowY.slice(0, -1).concat(b.rowY);
        a.h = b.y + b.h - a.y;
        a.w = Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x);
        a.x = Math.min(a.x, b.x);
        finishTable(a);
        continue;
      }
    }
    out.push(block);
  }
  return out;
}

const MAX_LAYOUT_DEPTH = 4;

/**
 * Cut a region into the blocks a reader would take in turn:
 *
 *   { type: 'flow', rows }      lines of running text, one column wide
 *   { type: 'table', table }
 *   { type: 'columns', strips } side-by-side regions, each cut up the same way
 *   { type: 'block', block }    a ruled table or a picture, placed whole
 */
function regionBlocks(rows, depth) {
  const out = [];
  let flow = [];
  const flush = () => {
    if (flow.length) { out.push({ type: 'flow', rows: flow }); flow = []; }
  };
  let lo = Infinity, hi = -Infinity;
  for (const row of rows) {
    for (const box of row.boxes) { lo = Math.min(lo, box.x0); hi = Math.max(hi, box.x1); }
  }

  const band = (slice, gutters) => {
    const { strips, grid } = splitStrips(slice, gutters);
    // Margin line numbers are dropped, and the band re-read without them.
    const numbered = strips.length === 2
      ? strips.findIndex((s, k) => stripIsLineNumbers(s, strips[1 - k]))
      : -1;
    if (numbered >= 0) {
      const keep = strips[1 - numbered];
      for (const b of regionBlocks(keep.rows, depth + 1)) out.push(b);
      return;
    }
    if (classifyBand(strips, grid) === 'table') {
      out.push({ type: 'table', table: streamTable(slice, strips, grid) });
    } else {
      out.push({
        type: 'columns',
        strips: strips.filter((s) => s.rows.length).map((s) => ({
          x0: s.x0, x1: s.x1, blocks: regionBlocks(s.rows, depth + 1)
        }))
      });
    }
  };

  const plain = (from, to) => {
    let s = from;
    while (s <= to) {
      const row = rows[s];
      const found = depth < MAX_LAYOUT_DEPTH ? findBand(rows.slice(0, to + 1), s, lo, hi) : null;
      if (found && flow.length) {
        /*
         * A paragraph set right across the page often ends on a short line,
         * and a short line fits inside one column of whatever comes next. It
         * still belongs to the paragraph above it.
         */
        const above = flow[flow.length - 1];
        const crosses = !above.block && found.gutters.some((g) =>
          above.boxes[0].x0 < g.x0 && above.boxes[above.boxes.length - 1].x1 > g.x1);
        const oneSided = !row.block && found.gutters.every((g) =>
          row.boxes[row.boxes.length - 1].x1 <= g.mid || row.boxes[0].x0 >= g.mid);
        if (crosses && oneSided && Math.abs(row.size - above.size) < 0.6 &&
            row.baseline - above.baseline <= row.size * 1.6) {
          flow.push(row);
          s++;
          continue;
        }
      }
      if (!found) {
        if (row.block) { flush(); out.push({ type: 'block', block: row.block }); }
        else flow.push(row);
        s++;
        continue;
      }
      flush();
      band(rows.slice(s, found.end + 1), found.gutters);
      s = found.end + 1;
    }
  };

  const runs = depth < MAX_LAYOUT_DEPTH
    ? findTableRuns(rows).filter((run) => !runSitsInColumn(rows, run))
    : [];
  let at = 0;
  for (const run of runs) {
    plain(at, run.s - 1);
    flush();
    band(rows.slice(run.s, run.e + 1), run.gutters);
    at = run.e + 1;
  }
  plain(at, rows.length - 1);
  flush();
  return mergeTables(out);
}

/* ------------------------------------------------------------------ *
 * Paragraphs
 * ------------------------------------------------------------------ */

function bodySize(lines) {
  const tally = new Map();
  for (const l of lines) {
    if (!l.text.trim()) continue;
    const key = Math.round(l.size * 2) / 2;
    tally.set(key, (tally.get(key) || 0) + l.text.length);
  }
  let best = 11, bestN = -1;
  for (const [size, n] of tally) if (n > bestN) { best = size; bestN = n; }
  return best;
}

function headingLevel(line, body) {
  const ratio = line.size / body;
  const short = line.text.length < 160;
  if (!short) return 0;
  if (ratio >= 1.7) return 1;
  if (ratio >= 1.35) return 2;
  if (ratio >= 1.14) return 3;
  if (line.bold && ratio >= 1.02 && line.text.length < 70 && !/[.;,]$/.test(line.text)) return 4;
  return 0;
}

/**
 * The step from one baseline to the next that the text was set with, as a
 * multiple of its size. Double-spaced text has a step of two; treating a fixed
 * fraction of the size as "extra space" would make every line of it a
 * paragraph of its own.
 */
function linePitch(lines, fallback) {
  const ratios = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i];
    if (Math.abs(a.size - b.size) > 0.6) continue;
    const ratio = (b.baseline - a.baseline) / Math.max(a.size, b.size);
    if (ratio > 0.85 && ratio < 3.2) ratios.push(ratio);
  }
  // A handful of lines says too little; the page as a whole knows better.
  if (ratios.length < 4 && fallback) return fallback;
  if (!ratios.length) return 1.25;
  ratios.sort((a, b) => a - b);
  // Most steps are inside a paragraph; the ones between paragraphs are the
  // larger minority, so a low percentile is the ordinary step.
  return ratios[Math.floor(ratios.length * 0.3)];
}

/** How wide the first word of a line is, near enough. */
function firstWordWidth(line) {
  const it = line.items[0];
  if (!it) return 0;
  const str = it.str.replace(/^\s+/, '');
  const space = str.search(/\s/);
  const width = itemRight(it) - it.x;
  if (space < 0) {
    // The word may carry on into the next run with no space between.
    let w = width;
    for (let k = 1; k < line.items.length && line.seps[k] === ''; k++) {
      const next = line.items[k];
      const cut = next.str.search(/\s/);
      const nw = itemRight(next) - next.x;
      if (cut < 0) { w += nw; continue; }
      w += nw * (cut / Math.max(1, next.str.length));
      break;
    }
    return w;
  }
  return width * (space / Math.max(1, str.length));
}

function centredIn(line, frame) {
  const left = line.x - frame.x0, right = frame.x1 - line.right;
  return left > line.size && Math.abs(left - right) <= Math.max(3, (frame.x1 - frame.x0) * 0.03);
}

/*
 * How a paragraph's lines sit in the column. The first line is left out of the
 * left-edge test because it may be indented, and the last out of the
 * right-edge test because it is allowed to stop short.
 */
function paragraphAlign(p, frame) {
  const n = p.lines.length;
  const em = p.size;
  if (n === 1) {
    const l = p.lines[0];
    const left = l.x - frame.x0, right = frame.x1 - l.right;
    if (centredIn(l, frame)) return 'center';
    if (left > em * 3 && right <= em * 0.6 && left > (frame.x1 - frame.x0) * 0.25) return 'right';
    return 'left';
  }
  const spread = (values) => Math.max(...values) - Math.min(...values);
  const lefts = p.lines.slice(1).map((l) => l.x);
  const rights = p.lines.slice(0, -1).map((l) => l.right);
  const allRights = p.lines.map((l) => l.right);
  const centres = p.lines.map((l) => (l.x + l.right) / 2);
  // A first line that starts further left — a list marker, a bibliography
  // entry — is a hanging indent, not a ragged left edge.
  const hanging = !!p.bullet || p.lines[0].x < Math.min(...lefts) - em * 0.4;
  const leftOk = spread(lefts.concat(n > 2 || hanging ? [] : [p.lines[0].x])) <= em * 0.4;
  if (leftOk) {
    if (n >= 3 && spread(rights) <= em * 0.4) return 'justify';
    return 'left';
  }
  const widest = Math.max(...p.lines.map((l) => l.right - l.x));
  if (spread(allRights) <= em * 0.4 && widest < (frame.x1 - frame.x0) * 0.9) return 'right';
  if (spread(centres) <= em * 0.7) return 'center';
  return 'left';
}

function styleKey(it) {
  return (it.bold ? 'b' : '') + (it.italic ? 'i' : '') + (it.mono ? 'm' : '') + '|' +
    (it.face || '') + '|' + Math.round(it.size * 2) + '|' + (it.color || '') + '|' +
    (it.script || '') + '|' + (it.link || '') + '|' + (it.underline ? 'u' : '');
}

const HYPHEN_END = /[A-Za-zÀ-ɏ][-­‐]$/;

/*
 * TeX sets an accented letter as two glyphs — the accent, then the letter —
 * and that is how it comes back: "na¨ıve". Put them together again.
 */
const LOOSE_ACCENTS = {
  '¨': '̈', '´': '́', '`': '̀', 'ˆ': '̂', '˜': '̃',
  'ˇ': '̌', '¯': '̄', '˙': '̇', '˚': '̊', '¸': '̧'
};
const LOOSE_ACCENT_RE = /([¨´`ˆ˜ˇ¯˙˚¸])([A-Za-zıȷ])/g;

function composeAccents(text) {
  if (!LOOSE_ACCENT_RE.test(text)) return text;
  LOOSE_ACCENT_RE.lastIndex = 0;
  return text.replace(LOOSE_ACCENT_RE, (whole, accent, letter) => {
    const base = letter === 'ı' ? 'i' : letter === 'ȷ' ? 'j' : letter;
    const made = (base + LOOSE_ACCENTS[accent]).normalize('NFC');
    return made.length === 1 ? made : whole;
  });
}

/**
 * The text of a block as runs of one style each, with the line breaks taken
 * out. A word split by a hyphen at the end of a line is put back together.
 */
function buildRuns(lines) {
  const runs = [];
  let last = null;
  const push = (text, it) => {
    if (!text) return;
    const key = styleKey(it);
    if (last && last.key === key) {
      last.text += text;
      return;
    }
    last = {
      key, text,
      bold: !!it.bold, italic: !!it.italic, mono: !!it.mono, serif: !!it.serif,
      font: it.font, face: it.face, size: it.size, color: it.color || '#000000',
      script: it.script || null, link: it.link || null, underline: !!it.underline
    };
    runs.push(last);
  };

  lines.forEach((line, li) => {
    line.items.forEach((it, k) => {
      let lead = line.seps[k] === '\t' ? ' ' : (line.seps[k] || '');
      if (k === 0 && li > 0 && last) {
        const before = last.text;
        if (HYPHEN_END.test(before) && /^[a-zß-ÿ]/.test(it.str)) {
          last.text = before.slice(0, -1);
          lead = '';
        } else if (HYPHEN_END.test(before) && /^[A-Z0-9]/.test(it.str)) {
          // "Trace-" / "Monkey": the hyphen is part of the word, the break is not.
          lead = '';
        } else {
          lead = /\s$/.test(before) || /^\s/.test(it.str) ? '' : ' ';
        }
      }
      push(lead + it.str, it);
    });
  });

  // One space is one space, including where two runs meet.
  let prevEndsSpace = true;
  for (const run of runs) {
    run.text = composeAccents(run.text.replace(/\s+/g, ' '));
    if (prevEndsSpace) run.text = run.text.replace(/^ /, '');
    prevEndsSpace = / $/.test(run.text) || (!run.text && prevEndsSpace);
  }
  for (let i = runs.length - 1; i >= 0; i--) {
    runs[i].text = runs[i].text.replace(/ $/, '');
    if (runs[i].text) break;
  }
  return runs.filter((r) => r.text);
}

/** The runs of a single line, for output that keeps the original line breaks. */
function lineRuns(line) {
  return buildRuns([line]);
}

/** Take `count` characters off the front of a list of runs. */
function trimRuns(runs, count) {
  let left = count;
  const out = [];
  for (const run of runs) {
    if (left <= 0) { out.push(run); continue; }
    if (run.text.length <= left) { left -= run.text.length; continue; }
    out.push(Object.assign({}, run, { text: run.text.slice(left) }));
    left = 0;
  }
  if (out.length) out[0].text = out[0].text.replace(/^\s+/, '');
  return out.filter((r) => r.text);
}

/**
 * Group the lines of one column into paragraphs.
 *
 * `frame` is the column the lines sit in — { x0, x1 } — which is what
 * centring is measured against. A page width may be passed instead.
 */
function groupParagraphs(lines, frameOrWidth, opts) {
  const o = opts || {};
  const body = o.bodySize || bodySize(lines);
  let lo = Infinity, hi = -Infinity;
  for (const l of lines) { lo = Math.min(lo, l.x); hi = Math.max(hi, l.right); }
  if (!isFinite(lo)) { lo = 0; hi = typeof frameOrWidth === 'number' ? frameOrWidth : 0; }
  const frame = frameOrWidth && typeof frameOrWidth === 'object'
    ? frameOrWidth
    : { x0: lo, x1: hi };
  const pitch = linePitch(lines, o.pitch);
  const bodyLeft = lines.length
    ? lines.map((l) => l.x).sort((a, b) => a - b)[Math.floor(lines.length * 0.25)]
    : 0;

  /*
   * How far right text in this part of the column runs. Measured from the
   * neighbouring lines with the same left edge rather than from the whole
   * column, so an indented quotation is judged against its own margin.
   */
  const sure = [];
  const reach = lines.map((line, i) => {
    let best = line.right;
    const ends = [];
    for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 4); j++) {
      const other = lines[j];
      if (Math.abs(other.x - line.x) <= line.size * 3 && Math.abs(other.size - line.size) <= line.size * 0.12) {
        best = Math.max(best, other.right);
        ends.push(other.right);
      }
    }
    // The margin is known when two lines stop at it, or it is the column's.
    sure.push(best >= frame.x1 - line.size ||
      ends.filter((r) => r >= best - line.size * 0.6).length >= 2);
    return best;
  });
  // A line is full when the first word of the next one would not have fitted
  // on the end of it: that is the only reason a typesetter breaks a line.
  const isFull = (i) => {
    const prev = lines[i - 1], line = lines[i];
    const need = prev.size * 0.25 + firstWordWidth(line);
    if (prev.right + need <= Math.max(reach[i - 1], reach[i]) - 0.5) return false;
    // A listing keeps its line breaks unless its lines plainly run to a margin.
    if (!sure[i - 1] && prev.mono && line.mono) return false;
    // With the margin only guessed at, a sentence that ends where the line
    // does, followed by a fresh start, is taken at its word.
    if (!sure[i - 1] && /[.!?:]["”’)]?$/.test(prev.text) && /^[A-Z0-9À-Þ(\[“"]/.test(line.text)) {
      return false;
    }
    return true;
  };

  const paras = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.text.trim()) { cur = null; continue; }
    const mark = line.vbullet ? { kind: 'bullet', marker: '•', length: 0 } : parseMarker(line.text);
    let brk = !cur;
    let space = 0;

    if (cur) {
      const prev = lines[i - 1];
      const em = Math.max(line.size, prev.size);
      const step = line.baseline - prev.baseline;
      const full = isFull(i);
      const centred = centredIn(prev, frame) && centredIn(line, frame);
      space = Math.max(0, step - em * pitch);

      if (step <= em * 0.3) brk = true;                               // beside, not below
      else if (step > em * pitch * 1.28 + 0.6) brk = true;            // extra space above
      else if (Math.abs(line.size - prev.size) > Math.max(0.8, body * 0.12)) brk = true;
      // Visible text and the invisible layer under a scan are never one block.
      else if (line.invisible !== prev.invisible) brk = true;
      // A change of weight or colour starts a block when the line before it
      // stopped short, or was a single line on its own — a heading over its
      // text — but not in the middle of a paragraph that happens to hold a
      // bold phrase or a link a whole line long.
      else if ((line.bold !== prev.bold || line.color !== prev.color) &&
               (!full || cur.lines.length === 1)) brk = true;
      else if (mark && (!full || cur.marker ||
               (cur.lines.length > 1 && line.x < cur.contX - em * 0.5))) brk = true;
      else if (!centred && !full) brk = true;                         // the last line ended early
      else if (!centred && cur.lines.length > 1 && Math.abs(line.x - cur.contX) > em * 0.6) brk = true;
      else if (!centred && cur.lines.length === 1 && line.x - cur.firstX > em * 0.5 &&
               !cur.marker && !full) brk = true;
    }

    if (brk) {
      cur = { lines: [line], firstX: line.x, contX: line.x, marker: mark, spaceBefore: space, vbullet: !!line.vbullet };
      paras.push(cur);
    } else {
      if (cur.lines.length === 1) cur.contX = line.x;
      cur.lines.push(line);
    }
  }

  for (const p of paras) finishParagraph(p, frame, body);

  // Two-line paragraphs cannot show that they are justified on their own; if
  // the column around them is, and their first line runs to the same edge,
  // they are too.
  const justified = paras.filter((p) => p.align === 'justify');
  if (justified.length) {
    const edge = median(justified.map((p) => p.right));
    for (const p of paras) {
      if (p.align === 'left' && p.lines.length === 2 && !p.marker &&
          Math.abs(p.lines[0].right - edge) <= p.size * 0.4) p.align = 'justify';
    }
  }

  // How deep in a list each item sits, from where its marker starts — judged
  // one list at a time, so a list set further in than another is not taken
  // for a sub-list of it.
  const markerX = (p) => (p.lines[0].vbulletX != null ? p.lines[0].vbulletX : p.lines[0].x);
  for (let i = 0; i < paras.length; i++) {
    if (!paras[i].bullet) continue;
    let j = i;
    while (j + 1 < paras.length && paras[j + 1].bullet) j++;
    const items = paras.slice(i, j + 1);
    const starts = clusterValues(items.map(markerX), Math.max(4, body * 0.8));
    for (const p of items) {
      let level = 0, bestD = Infinity;
      starts.forEach((x, k) => {
        const d = Math.abs(x - markerX(p));
        if (d < bestD) { bestD = d; level = k; }
      });
      p.listLevel = Math.min(level, 5);
    }
    i = j;
  }
  return { paragraphs: paras, bodySize: body, bodyLeft };
}

function finishParagraph(p, frame, body) {
  const lines = p.lines;
  let chars = 0, bold = 0, italic = 0, mono = 0, serif = 0;
  const sizes = new Map();
  p.x = Infinity; p.right = -Infinity;
  for (const l of lines) {
    p.x = Math.min(p.x, l.x);
    p.right = Math.max(p.right, l.right);
    chars += l.chars;
    if (l.bold) bold += l.chars;
    if (l.italic) italic += l.chars;
    if (l.mono) mono += l.chars;
    if (l.serif) serif += l.chars;
    const key = Math.round(l.size * 2) / 2;
    sizes.set(key, (sizes.get(key) || 0) + l.chars);
  }
  let size = lines[0].size, most = -1;
  for (const [key, n] of sizes) if (n > most) { most = n; size = key; }
  // Keep the exact size of a line set at the common size, not the bucket.
  const exact = lines.find((l) => Math.abs(l.size - size) <= 0.5);
  p.size = exact ? exact.size : size;
  p.y = lines[0].y;
  p.bottom = Math.max(...lines.map((l) => l.bottom));
  p.w = Math.max(0, p.right - p.x);
  p.h = Math.max(1, p.bottom - p.y);
  p.bold = chars > 0 && bold / chars > 0.6;
  p.italic = chars > 0 && italic / chars > 0.6;
  p.mono = chars > 0 && mono / chars > 0.6;
  p.serif = chars > 0 && serif / chars > 0.6;
  const all = [];
  for (const l of lines) for (const it of l.items) all.push(it);
  p.font = dominantFont(all);
  const lead = all.find((it) => it.font === p.font);
  p.fontId = lead ? lead.fontId : null;
  p.face = lead ? lead.face : familyFor(p.font, p).family;
  p.color = dominantColor(lines) || '#000000';
  p.invisible = lines.every((l) => l.invisible);

  /*
   * The line spacing the block was set with, as a multiple of its size.
   * Redrawing at a fixed 1.25 makes a single-line heading a quarter taller
   * than the space it came out of, which is what makes a replaced block look
   * bigger than the text it replaced.
   */
  if (lines.length > 1) {
    const step = (lines[lines.length - 1].baseline - lines[0].baseline) / (lines.length - 1);
    p.leading = p.size > 0 ? Math.min(3, Math.max(0.9, step / p.size)) : 1.15;
  } else {
    p.leading = p.size > 0 ? Math.min(1.6, Math.max(0.95, p.h / p.size)) : 1.15;
  }

  p.runs = buildRuns(lines);
  p.heading = lines.length <= 4 ? headingLevel(
    { size: p.size, bold: p.bold, text: p.runs.map((r) => r.text).join('') }, body) : 0;

  // A numbered heading keeps its number; only a real list item gives it up.
  p.bullet = false;
  p.ordered = false;
  p.listLevel = 0;
  const mark = p.marker;
  p.marker = null;
  if (mark && !p.heading) {
    p.bullet = true;
    p.ordered = mark.kind === 'ordered';
    p.marker = mark.marker;
    if (mark.length) p.runs = trimRuns(p.runs, mark.length);
  }
  p.text = p.runs.map((r) => r.text).join('');
  p.align = paragraphAlign(p, frame);
  p.indent = lines.length > 1 ? lines[0].x - Math.min(...lines.slice(1).map((l) => l.x)) : 0;
  p.left = Math.max(0, p.x - frame.x0);
  p.frame = frame;
}

/* ------------------------------------------------------------------ *
 * Page layout
 * ------------------------------------------------------------------ */

/** Pictures worth carrying into a reflowed document, as blocks. */
function pictureBlocks(images, items, width, height) {
  const out = [];
  const seen = new Set();
  for (const im of images || []) {
    if (im.w < 24 || im.h < 24) continue;
    if (im.w * im.h > width * height * 0.7) continue;       // a scan or a backdrop
    const key = [im.x, im.y, im.w, im.h].map((v) => Math.round(v)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    // Text lying on a picture means the picture is a background to it.
    let over = 0;
    for (const it of items) {
      const cx = it.x + (itemRight(it) - it.x) / 2, cy = it.baseline - it.size * 0.3;
      if (cx > im.x && cx < im.x + im.w && cy > im.y && cy < im.y + im.h && ++over >= 2) break;
    }
    if (over >= 2) continue;
    out.push({ kind: 'image', x: im.x, y: im.y, w: im.w, h: im.h, image: im });
  }
  return out;
}

/**
 * Drawings: groups of painted paths that make up a diagram, a chart or a logo.
 *
 * Paths that lie close together are gathered into one group, and a group is a
 * drawing when it is large enough and holds something slanted or curved. That
 * last test is what keeps a form's boxes and a table's rulings — all level
 * and upright — from being mistaken for a picture.
 */
function findFigures(drawings, tables, width, height) {
  const list = drawings.filter((d) => {
    const w = d.x1 - d.x0, h = d.y1 - d.y0;
    // A hairline running most of the way across the page ties together
    // everything it passes; it is a separator, not part of a drawing.
    if (Math.min(w, h) <= 2.6 && (w > width * 0.45 || h > height * 0.45)) return false;
    return !tables.some((t) => d.x0 >= t.x - 2 && d.x1 <= t.x + t.w + 2 &&
      d.y0 >= t.y - 2 && d.y1 <= t.y + t.h + 2);
  });
  if (list.length < 5) return [];
  const parent = list.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const cell = 14, pad = 5;
  const grid = new Map();
  list.forEach((d, i) => {
    const gx0 = Math.floor((d.x0 - pad) / cell), gx1 = Math.floor((d.x1 + pad) / cell);
    const gy0 = Math.floor((d.y0 - pad) / cell), gy1 = Math.floor((d.y1 + pad) / cell);
    // A big panel touches hundreds of cells; its outline is enough.
    const hollow = (gx1 - gx0) * (gy1 - gy0) > 400;
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        if (hollow && gx !== gx0 && gx !== gx1 && gy !== gy0 && gy !== gy1) continue;
        const key = gx * 100003 + gy;
        const first = grid.get(key);
        if (first == null) grid.set(key, i);
        else parent[find(i)] = find(first);
      }
    }
  });
  const groups = new Map();
  list.forEach((d, i) => {
    const root = find(i);
    let g = groups.get(root);
    if (!g) {
      g = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0, curvy: 0 };
      groups.set(root, g);
    }
    g.x0 = Math.min(g.x0, d.x0); g.y0 = Math.min(g.y0, d.y0);
    g.x1 = Math.max(g.x1, d.x1); g.y1 = Math.max(g.y1, d.y1);
    g.n++;
    if (d.curved) g.curvy++;
  });
  // The parts of one drawing do not always touch — the boxes of a flow chart,
  // the bars of a chart — so groups whose boxes overlap are one drawing.
  let merged = Array.from(groups.values());
  if (merged.length <= 800) {
    for (let again = true; again;) {
      again = false;
      const next = [];
      for (const g of merged) {
        const host = next.find((o) => g.x0 <= o.x1 + pad && g.x1 >= o.x0 - pad &&
                                      g.y0 <= o.y1 + pad && g.y1 >= o.y0 - pad);
        if (!host) { next.push(g); continue; }
        host.x0 = Math.min(host.x0, g.x0); host.y0 = Math.min(host.y0, g.y0);
        host.x1 = Math.max(host.x1, g.x1); host.y1 = Math.max(host.y1, g.y1);
        host.n += g.n;
        host.curvy += g.curvy;
        again = true;
      }
      merged = next;
    }
  }
  const out = [];
  for (const g of merged) {
    const w = g.x1 - g.x0, h = g.y1 - g.y0;
    if (g.n < 5 || g.curvy < 2 || w < 40 || h < 30) continue;
    if (w * h > width * height * 0.85) continue;
    out.push({ kind: 'figure', x: g.x0, y: g.y0, w, h, paths: g.n });
  }
  return out;
}

/** Mark lines that a small drawn shape sits just in front of: vector bullets. */
function markVectorBullets(lines, marks) {
  if (!marks || !marks.length) return;
  for (const line of lines) {
    if (line.vbullet) continue;
    for (const m of marks) {
      const cy = m.y + m.h / 2;
      if (cy < line.y || cy > line.bottom) continue;
      const gap = line.x - (m.x + m.w);
      if (gap >= 0 && gap <= line.size * 2.6 && m.h <= line.size * 0.9) {
        line.vbullet = true;
        line.vbulletX = m.x;
        break;
      }
    }
  }
}

/** Mark the text a thin line runs just underneath. */
function markUnderlines(lines, rules) {
  if (!rules || !rules.length) return;
  for (const line of lines) {
    for (const r of rules) {
      const drop = r.y - line.baseline;
      if (drop < line.size * 0.02 || drop > line.size * 0.28) continue;
      if (r.x0 < line.x - line.size * 0.5 || r.x1 > line.right + line.size * 0.5) continue;
      for (const it of line.items) {
        const overlap = overlapLength(it.x, itemRight(it), r.x0, r.x1);
        if (overlap >= (itemRight(it) - it.x) * 0.6) it.underline = true;
      }
    }
  }
}

/**
 * Lay out a page from its items.
 *
 * @param {object[]} items   as produced by pageItems, or by OCR in that shape
 * @param {object} env       { width, height, graphics }
 */
function layoutItems(items, env) {
  const e = Object.assign({ width: 595, height: 842, graphics: null }, env);
  const base = groupLines(items);
  const rows = base.lines;
  // Once the page has been turned upright the drawn geometry no longer lines
  // up with the text, so it is not consulted.
  const g = base.bounds ? null : e.graphics;
  const pool = [];
  for (const row of rows) for (const it of row.items) { it.used = false; pool.push(it); }

  const tables = [];
  const blockers = [];
  const usedRules = [];
  if (g) {
    for (const lattice of findLattices(g.hRules, g.vRules)) {
      const table = ruledTable(lattice, pool);
      if (!table) continue;
      tables.push(table);
      usedRules.push(table);
      blockers.push({ kind: 'table', x: table.x, y: table.y, w: table.w, h: table.h, table });
    }
  }
  // The labels inside a drawing belong to the drawing: read as text they
  // come out as a scatter of one-word paragraphs. A frame with running prose
  // in it is a decorated text box, though, and is left alone.
  const figures = [];
  if (g) {
    for (const fig of findFigures(g.drawings, tables, e.width, e.height)) {
      const within = pool.filter((it) => {
        if (it.used) return false;
        const cx = it.x + (itemRight(it) - it.x) / 2, cy = it.baseline - it.size * 0.3;
        return cx >= fig.x - 2 && cx <= fig.x + fig.w + 2 && cy >= fig.y - 2 && cy <= fig.y + fig.h + 2;
      });
      const prose = clusterRows(within).map(makeLine).filter((l) => l.chars >= 40).length;
      if (prose >= 5) continue;
      for (const it of within) it.used = true;
      fig.labels = within;
      figures.push(fig);
    }
  }
  const free = pool.filter((it) => !it.used);
  // A bitmap inside a drawing is part of it, not a second picture.
  const bitmaps = (g ? pictureBlocks(g.images, free, e.width, e.height) : []).filter((im) => {
    const cx = im.x + im.w / 2, cy = im.y + im.h / 2;
    return !figures.some((f) => cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h);
  });
  const pictures = bitmaps.concat(figures);
  for (const p of pictures) blockers.push(p);

  const layoutRows = clusterRows(free).map(bandRow).filter((r) => r.boxes.length);
  for (const b of blockers) layoutRows.push(blockRow(b));
  layoutRows.sort((a, b) => (a.y - b.y) || (a.boxes[0].x0 - b.boxes[0].x0));

  let lo = Infinity, hi = -Infinity;
  for (const row of layoutRows) {
    for (const box of row.boxes) { lo = Math.min(lo, box.x0); hi = Math.max(hi, box.x1); }
  }
  const pageFrame = { x0: isFinite(lo) ? lo : 0, x1: isFinite(hi) ? hi : e.width };

  // Underlines are the rules that are not part of a table's grid.
  const looseRules = g ? g.hRules.filter((r) => !usedRules.some((t) =>
    r.y >= t.y - 2 && r.y <= t.y + t.h + 2 && r.x0 >= t.x - 2 && r.x1 <= t.x + t.w + 2)) : [];

  const tree = regionBlocks(layoutRows, 0);
  const blocks = [];
  const paragraphs = [];
  const lines = [];
  const body = bodySize(rows);
  const pagePitch = linePitch(rows);
  let flowId = 0;

  const emit = (list, frame) => {
    for (const node of list) {
      if (node.type === 'flow') {
        const flowLines = node.rows.map((r) => makeLine(r.boxes.map((b) => b.it)));
        if (g) {
          markVectorBullets(flowLines, g.marks);
          markUnderlines(flowLines, looseRules);
        }
        const id = ++flowId;
        for (const p of groupParagraphs(flowLines, frame, { bodySize: body, pitch: pagePitch }).paragraphs) {
          p.flow = id;
          paragraphs.push(p);
          blocks.push({ type: 'paragraph', para: p });
          for (const l of p.lines) lines.push(l);
        }
      } else if (node.type === 'table') {
        tables.push(node.table);
        blocks.push({ type: 'table', table: node.table });
        for (const l of node.table.lines) lines.push(l);
      } else if (node.type === 'block') {
        if (node.block.kind === 'table') {
          blocks.push({ type: 'table', table: node.block.table });
          for (const l of node.block.table.lines) lines.push(l);
        } else {
          blocks.push({ type: 'image', image: node.block });
        }
      } else if (node.type === 'columns') {
        for (const strip of node.strips) emit(strip.blocks, { x0: strip.x0, x1: strip.x1 });
      }
    }
  };
  emit(tree, pageFrame);

  let biggest = null;
  for (const t of tables) {
    if (!biggest || t.nrows * t.ncols > biggest.nrows * biggest.ncols) biggest = t;
  }
  return {
    rows,
    rotated: base.rotated,
    bounds: base.bounds,
    lines,
    paragraphs,
    tables,
    table: biggest,
    images: pictures,
    blocks,
    bodySize: body,
    bodyLeft: pageFrame.x0,
    frame: pageFrame
  };
}

/**
 * Every block of text on a page that can stand on its own: the paragraphs, and
 * each cell of each table. This is what the editor outlines for editing and
 * what the positioned exports draw one box for.
 */
function textBlocks(pageData) {
  const out = [];
  for (const block of pageData.blocks || []) {
    if (block.type === 'paragraph') {
      out.push(block.para);
    } else if (block.type === 'table') {
      for (const row of block.table.cells) {
        for (const cell of row) {
          if (!cell || !cell.lines.length) continue;
          if (!cell.para) {
            const frame = { x0: cell.x, x1: cell.x + cell.w };
            const p = { lines: cell.lines, marker: null, spaceBefore: 0 };
            finishParagraph(p, frame, pageData.bodySize || 11);
            p.heading = 0;
            p.align = cell.align;
            p.cell = cell;
            cell.para = p;
          }
          out.push(cell.para);
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Tables as plain grids
 * ------------------------------------------------------------------ */

/**
 * A grid for every page, table or not — used by the spreadsheet and CSV
 * exports, which always need rows and columns of some shape.
 */
function pageToGrid(pageData) {
  if (pageData.tables && pageData.tables.length) {
    const out = [];
    pageData.tables.forEach((t, i) => {
      if (i > 0) out.push([]);
      for (const row of t.rows) out.push(row);
    });
    return out;
  }
  return (pageData.rows || pageData.lines)
    .filter((l) => l.text.trim())
    .map((l) => (l.segments.length > 1 ? l.segments.map((s) => s.text) : [l.text.trim()]));
}

/* ------------------------------------------------------------------ *
 * Page + document extraction
 * ------------------------------------------------------------------ */

async function extractPage(page, index, opts) {
  const o = opts || {};
  const { viewport, items } = await pageItems(page, {
    colors: o.colors !== false,
    links: o.links !== false
  });
  let graphics = null;
  if (o.colors !== false && o.graphics !== false) {
    try { graphics = await pageGraphics(page); } catch (err) { graphics = null; }
  }
  const layout = layoutItems(items, { width: viewport.width, height: viewport.height, graphics });
  if (o.detectTables === false) {
    // Callers that want every line as a line get the tables back as rows.
    layout.tables = [];
    layout.table = null;
  }

  // A page that is a picture with next to no text of its own is a scan, even
  // when a stamp or a page number has been typed on top of it.
  let visible = 0;
  for (const it of items) if (!it.invisible) visible += it.str.trim().length;
  const hasText = items.some((it) => it.str.trim());
  const area = viewport.width * viewport.height;
  const bigPicture = !!graphics && graphics.images.some((im) => im.w * im.h >= area * 0.5);

  return {
    index,
    number: index + 1,
    width: viewport.width,
    height: viewport.height,
    flowWidth: (layout.bounds && layout.bounds.width) || viewport.width,
    recoveredRotation: layout.bounds ? layout.bounds.angle : 0,
    rotation: viewport.rotation || 0,
    items,
    rotatedItems: layout.rotated,
    rows: layout.rows,
    lines: layout.lines,
    paragraphs: layout.paragraphs,
    tables: layout.tables,
    table: layout.table,
    images: layout.images,
    blocks: layout.blocks,
    bodySize: layout.bodySize,
    bodyLeft: layout.bodyLeft,
    frame: layout.frame,
    isEmpty: layout.rows.length === 0,
    scanLike: bigPicture && hasText && visible < 60 && !items.some((it) => it.invisible)
  };
}

/**
 * Lay out items that did not come from pdf.js — recognised words — into the
 * same page shape extractPage returns.
 */
function pageFromItems(items, base) {
  const b = base || {};
  const width = b.width || 595, height = b.height || 842;
  const layout = layoutItems(items, { width, height, graphics: null });
  return Object.assign({}, b, {
    items,
    rotatedItems: layout.rotated,
    rows: layout.rows,
    lines: layout.lines,
    paragraphs: layout.paragraphs,
    tables: layout.tables,
    table: layout.table,
    images: [],
    blocks: layout.blocks,
    bodySize: layout.bodySize,
    bodyLeft: layout.bodyLeft,
    frame: layout.frame,
    isEmpty: layout.rows.length === 0,
    scanLike: false
  });
}

const PAGE_NUMBER = /^(?:page\s*)?[-–—\s]*(?:#+|[ivxlc]+)[-–—\s]*(?:(?:of|\/)\s*#+)?$/i;

/**
 * What can only be told from the document as a whole:
 *
 *  - the body size, and from it which sizes are headings and in what order;
 *  - the lines every page repeats at its top or bottom, which are furniture;
 *  - the paragraphs a column or a page break cut in two.
 */
function finalizeDocument(pages) {
  const tally = new Map();
  for (const page of pages) {
    for (const p of page.paragraphs) {
      const key = Math.round(p.size * 2) / 2;
      tally.set(key, (tally.get(key) || 0) + p.text.length);
    }
  }
  let body = 11, most = -1;
  for (const [size, n] of tally) if (n > most) { most = n; body = size; }

  // Running headers and footers.
  if (pages.length >= 2) {
    const seen = new Map();
    const keyed = [];
    for (const page of pages) {
      const mine = new Set();
      for (const p of page.paragraphs) {
        const top = p.bottom <= page.height * 0.11;
        const foot = p.y >= page.height * 0.89;
        if (!(top || foot) || p.text.length > 150 || p.cell) continue;
        const text = p.text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!text) continue;
        const key = (top ? 'h|' : 'f|') + text;
        keyed.push({ p, key, zone: top ? 'header' : 'footer', number: PAGE_NUMBER.test(text) });
        mine.add(key);
      }
      for (const key of mine) seen.set(key, (seen.get(key) || 0) + 1);
    }
    const need = pages.length >= 3 ? Math.max(2, Math.ceil(pages.length * 0.4)) : 2;
    for (const k of keyed) {
      if (seen.get(k.key) >= need || k.number) k.p.artifact = k.zone;
    }
  }

  // Headings, largest first.
  const headSizes = new Map();
  for (const page of pages) {
    for (const p of page.paragraphs) {
      p.heading = 0;
      if (p.artifact || p.cell || p.bullet) continue;
      if (p.size >= body * 1.12 && p.text.length <= 200 && p.lines.length <= 4) {
        const key = Math.round(p.size * 2) / 2;
        headSizes.set(key, (headSizes.get(key) || 0) + 1);
      }
    }
  }
  const ranks = [];
  for (const size of Array.from(headSizes.keys()).sort((a, b) => b - a)) {
    const last = ranks[ranks.length - 1];
    if (last && last[0] / size < 1.06) last.push(size);
    else ranks.push([size]);
  }
  const levelOf = new Map();
  ranks.forEach((sizes, k) => { for (const s of sizes) levelOf.set(s, Math.min(k + 1, 6)); });
  const minor = Math.min(ranks.length + 1, 6);
  for (const page of pages) {
    page.bodySize = body;
    for (const p of page.paragraphs) {
      if (p.artifact || p.cell || p.bullet) continue;
      const key = Math.round(p.size * 2) / 2;
      if (p.size >= body * 1.12 && p.text.length <= 200 && p.lines.length <= 4 && levelOf.has(key)) {
        p.heading = levelOf.get(key);
      } else if (p.bold && p.size >= body * 0.98 && p.lines.length === 1 && p.text.length < 90 &&
                 !/[.,;:]$/.test(p.text) && p.runs.every((r) => r.bold) &&
                 !/^(?:fig(?:ure)?\.?|table|listing|chart)\s*\d/i.test(p.text)) {
        p.heading = minor;
      }
    }
  }

  // Paragraphs carried over a column or a page.
  let prev = null;
  let prevKey = '';
  for (const page of pages) {
    for (const block of page.blocks) {
      // A picture or a table set between two halves of a sentence does not
      // end the sentence.
      if (block.type !== 'paragraph') continue;
      const p = block.para;
      if (p.artifact) continue;
      const key = page.index + ':' + p.flow;
      p.continues = false;
      if (prev && key !== prevKey && !p.heading && !prev.heading && !p.bullet && !p.mono &&
          Math.abs(p.size - prev.size) <= 0.3 && p.bold === prev.bold && p.face === prev.face) {
        const tail = prev.text.trim();
        const open = HYPHEN_END.test(tail) || !/[.!?:;"”’)\]]$/.test(tail);
        if (open && /^[a-zß-ÿ(]/.test(p.text)) p.continues = true;
      }
      prev = p;
      prevKey = key;
    }
  }
  return { bodySize: body };
}

/**
 * @param {object} pdf       a pdf.js document proxy
 * @param {object} [opts]    { pages: number[] (0-based), onProgress(i, n),
 *                             onEmptyPage(page, data) }
 */
async function extractDocument(pdf, opts) {
  const options = opts || {};
  const indexes = options.pages && options.pages.length
    ? options.pages.slice()
    : Array.from({ length: pdf.numPages }, (_, i) => i);
  const out = [];
  const failed = [];
  for (let n = 0; n < indexes.length; n++) {
    const i = indexes[n];
    let page = null;
    // A malformed font, an image filter pdf.js cannot decode or a truncated
    // content stream throws for one page. Losing that page is bad; losing the
    // whole conversion because of it is worse, so each page stands alone.
    try {
      page = await pdf.getPage(i + 1);
      let data = await extractPage(page, i, options);
      // A page with nothing on it gets one more chance from whoever asked for
      // the extraction — that is where OCR is plugged in, without this module
      // having to know anything about it.
      if ((data.isEmpty || data.scanLike) && options.onEmptyPage) {
        const second = await options.onEmptyPage(page, data);
        if (second) data = second;
      }
      out.push(data);
    } catch (err) {
      if (err && err.name === 'JobCancelled') throw err;
      failed.push({ page: i + 1, message: (err && err.message) || String(err) });
      out.push(placeholderPage(i, page));
    } finally {
      if (page) { try { page.cleanup(); } catch (err) { /* already gone */ } }
    }
    if (options.onProgress) options.onProgress(n + 1, indexes.length);
    await tick();
  }
  const summary = finalizeDocument(out);
  return { pages: out, numPages: pdf.numPages, failed, bodySize: summary.bodySize };
}

/** A structurally valid, empty page, so one unreadable page cannot break a loop. */
function placeholderPage(index, page) {
  let width = 595, height = 842;
  try {
    if (page) {
      const v = page.getViewport({ scale: 1 });
      width = v.width;
      height = v.height;
    }
  } catch (err) { /* fall back to A4 */ }
  return {
    index,
    number: index + 1,
    width,
    height,
    flowWidth: width,
    recoveredRotation: 0,
    rotation: 0,
    items: [],
    rotatedItems: [],
    rows: [],
    lines: [],
    paragraphs: [],
    tables: [],
    table: null,
    images: [],
    blocks: [],
    bodySize: 10,
    bodyLeft: 0,
    frame: { x0: 0, x1: width },
    isEmpty: true,
    scanLike: false,
    unreadable: true
  };
}

/* ------------------------------------------------------------------ *
 * Rasterising
 * ------------------------------------------------------------------ */

// Past these a browser hands back a canvas that silently draws nothing.
const MAX_CANVAS_PIXELS = 120e6;
const MAX_CANVAS_SIDE = 16000;

/*
 * Leaving text out of a rendering.
 *
 * pdf.js paints glyphs through fillText and strokeText, one at a time, so a
 * canvas can be told to ignore them. Two things use it: exports that put real,
 * editable text over a picture of the page need that picture without the text
 * already in it, and the editor hides the words of a paragraph it has lifted
 * off the page.
 *
 * The rule is carried by the canvas, not by a global switch, because several
 * pages may be rendering at once.
 */
let textFilterInstalled = false;

function installTextFilter() {
  if (textFilterInstalled || typeof CanvasRenderingContext2D === 'undefined') return;
  textFilterInstalled = true;
  const proto = CanvasRenderingContext2D.prototype;
  for (const name of ['fillText', 'strokeText']) {
    const original = proto[name];
    proto[name] = function (text, x, y, maxWidth) {
      const rule = this.canvas && this.canvas.psText;
      if (rule) {
        if (rule === 'none') return undefined;
        if (typeof rule === 'function' && rule(this, x, y)) return undefined;
      }
      return maxWidth === undefined
        ? original.call(this, text, x, y)
        : original.call(this, text, x, y, maxWidth);
    };
  }
}

/** Set, or clear, the rule deciding which glyphs a canvas will paint. */
function setTextRule(canvas, rule) {
  if (rule) installTextFilter();
  canvas.psText = rule || null;
}

/**
 * A canvas factory for pdf.js. While `textFree` is set, the scratch canvases
 * pdf.js makes for itself — transparency groups, patterns — drop their text
 * too, so none of it reaches the page through the back door.
 */
function createCanvasFactory() {
  const factory = {
    textFree: false,
    create(width, height) {
      if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      if (factory.textFree) setTextRule(canvas, 'none');
      return { canvas, context: canvas.getContext('2d') };
    },
    reset(entry, width, height) {
      if (!entry.canvas) throw new Error('Canvas is not specified');
      if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
      entry.canvas.width = width;
      entry.canvas.height = height;
    },
    destroy(entry) {
      if (!entry.canvas) throw new Error('Canvas is not specified');
      entry.canvas.width = 0;
      entry.canvas.height = 0;
      entry.canvas = null;
      entry.context = null;
    }
  };
  return factory;
}

/**
 * Open a document for a batch job. It gets its own canvas factory so pages can
 * be rendered without their text (see renderPageToCanvas).
 */
async function openDocument(data, params) {
  const factory = typeof document !== 'undefined' ? createCanvasFactory() : null;
  const options = Object.assign({ data, isEvalSupported: false }, params);
  if (factory) options.canvasFactory = factory;
  const pdf = await pdfjsLib.getDocument(options).promise;
  pdf.psCanvasFactory = factory;
  return pdf;
}

/** Give a canvas's memory back now rather than whenever it is collected. */
function releaseCanvas(canvas) {
  if (!canvas) return;
  try { canvas.width = 0; canvas.height = 0; } catch (err) { /* detached */ }
}

/**
 * Render a page to a new canvas.
 *
 * Rendered with the "print" intent: pdf.js paces an on-screen rendering with
 * requestAnimationFrame, which stops firing in a background tab, so a
 * conversion would freeze the moment its tab lost focus.
 *
 * @param {object} [opts] { noText, factory } — `factory` is the document's
 *                        canvas factory, from openDocument
 */
async function renderPageToCanvas(page, dpi, background, opts) {
  const o = opts || {};
  let scale = (dpi || 150) / 72;
  const base = page.getViewport({ scale: 1 });
  const shrink = Math.min(
    1,
    Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, base.width * base.height * scale * scale)),
    MAX_CANVAS_SIDE / Math.max(1, Math.max(base.width, base.height) * scale)
  );
  scale *= shrink;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(vp.width));
  canvas.height = Math.max(1, Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  if (background !== 'transparent') {
    ctx.fillStyle = background || '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  if (o.noText) setTextRule(canvas, 'none');
  if (o.factory) o.factory.textFree = !!o.noText;
  try {
    await page.render({
      canvasContext: ctx,
      viewport: vp,
      intent: 'print',
      background: background === 'transparent' ? 'rgba(0,0,0,0)' : undefined
    }).promise;
  } finally {
    if (o.factory) o.factory.textFree = false;
  }
  canvas.psScale = scale;
  return canvas;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('The page could not be encoded as an image.'))),
      type,
      quality
    );
  });
}

async function renderPageToBlob(page, dpi, format, quality) {
  const type = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  const canvas = await renderPageToCanvas(page, dpi, '#ffffff');
  try {
    const blob = await canvasToBlob(canvas, type, quality);
    return { blob, width: canvas.width, height: canvas.height, type };
  } finally {
    releaseCanvas(canvas);
  }
}

/* ------------------------------------------------------------------ *
 * Embedded images
 * ------------------------------------------------------------------ */

function imageObjectToCanvas(img) {
  if (!img) return null;
  // Newer pdf.js builds hand back a decoded bitmap directly.
  if (typeof ImageBitmap !== 'undefined' && img.bitmap instanceof ImageBitmap) {
    const c = document.createElement('canvas');
    c.width = img.bitmap.width;
    c.height = img.bitmap.height;
    c.getContext('2d').drawImage(img.bitmap, 0, 0);
    return c;
  }
  const { width, height, kind, data } = img;
  if (!width || !height || !data) return null;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(width, height);
  const d = out.data;
  const n = width * height;
  if (kind === 1) {            // 1 bit per pixel, packed rows
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const j = (y * width + x) * 4;
        d[j] = d[j + 1] = d[j + 2] = v;
        d[j + 3] = 255;
      }
    }
  } else if (kind === 2) {     // RGB, 24 bits per pixel
    for (let i = 0; i < n; i++) {
      d[i * 4] = data[i * 3];
      d[i * 4 + 1] = data[i * 3 + 1];
      d[i * 4 + 2] = data[i * 3 + 2];
      d[i * 4 + 3] = 255;
    }
  } else if (kind === 3) {     // RGBA
    d.set(data.subarray(0, n * 4));
  } else {
    return null;
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

function waitForObj(objs, name, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v || null); } };
    try {
      if (objs.has && objs.has(name)) { finish(objs.get(name)); return; }
    } catch (e) { /* fall through to the callback form */ }
    try { objs.get(name, finish); } catch (e) { finish(null); }
    setTimeout(() => finish(null), timeoutMs || 4000);
  });
}

/**
 * Pull the bitmaps a page paints. The page is rendered first at low resolution
 * because pdf.js only materialises image objects while executing the page's
 * operator list.
 */
async function extractPageImages(page, minPixels) {
  const floor = minPixels || 2500;
  try {
    releaseCanvas(await renderPageToCanvas(page, 36, '#ffffff'));
  } catch (e) { /* a failed pre-render just means fewer images resolve */ }

  let ops;
  try {
    ops = await page.getOperatorList();
  } catch (e) {
    return [];
  }
  const OPS = pdfjsLib.OPS;
  const wanted = new Set([OPS.paintImageXObject, OPS.paintJpegXObject, OPS.paintInlineImageXObject]);
  const seen = new Set();
  const out = [];

  for (let i = 0; i < ops.fnArray.length; i++) {
    if (!wanted.has(ops.fnArray[i])) continue;
    const arg = ops.argsArray[i][0];
    let obj = null;
    let key = null;
    if (typeof arg === 'string') {
      key = arg;
      if (seen.has(key)) continue;
      seen.add(key);
      obj = await waitForObj(page.objs, arg, 4000);
      if (!obj) obj = await waitForObj(page.commonObjs, arg, 500);
    } else if (arg && typeof arg === 'object') {
      obj = arg;
      key = 'inline-' + i;
    }
    const canvas = imageObjectToCanvas(obj);
    if (!canvas) continue;
    if (canvas.width * canvas.height < floor) { releaseCanvas(canvas); continue; }
    out.push({ name: key, canvas, width: canvas.width, height: canvas.height });
  }
  return out;
}

/**
 * The pictures on a page as things a person could pick up and move: each one's
 * bitmap together with the rectangle it occupies.
 *
 * Unlike extractPageImages this does not collapse repeats — the same XObject
 * drawn in three places is three pictures on the page, and each is editable on
 * its own.
 */
async function pageEditableImages(page, opts) {
  const o = Object.assign({ minPoints: 16, minPixels: 256 }, opts);
  const places = await pageImagePlacements(page);
  if (!places.length) return [];

  // pdf.js only materialises image objects while executing the operator list.
  try {
    releaseCanvas(await renderPageToCanvas(page, 36, '#ffffff'));
  } catch (e) { /* fewer images resolve; the placements are still good */ }

  const resolved = new Map();
  const out = [];
  for (const place of places) {
    if (place.w < o.minPoints || place.h < o.minPoints) continue;
    let obj = null;
    if (place.name) {
      if (resolved.has(place.name)) {
        obj = resolved.get(place.name);
      } else {
        obj = await waitForObj(page.objs, place.name, 4000);
        if (!obj) obj = await waitForObj(page.commonObjs, place.name, 500);
        resolved.set(place.name, obj);
      }
    }
    if (!obj) continue;
    const canvas = imageObjectToCanvas(obj);
    if (!canvas) continue;
    if (canvas.width * canvas.height < o.minPixels) { releaseCanvas(canvas); continue; }
    out.push({
      name: place.name,
      op: place.op,
      mask: place.mask,
      canvas,
      pixelWidth: canvas.width,
      pixelHeight: canvas.height,
      x: place.x,
      y: place.y,
      w: place.w,
      h: place.h
    });
  }
  // Smallest last, so a picture sitting on top of a bigger one is picked first.
  out.sort((a, b) => (b.w * b.h) - (a.w * a.h));
  return out;
}

/* ------------------------------------------------------------------ *
 * Plain-text convenience
 * ------------------------------------------------------------------ */

/**
 * The page as monospaced text with each piece of text in the column it sat
 * in on the page, so side-by-side blocks stay side by side.
 */
function layoutText(pageData) {
  const rows = pageData.rows || [];
  if (!rows.length) return '';
  // One character cell is the average width of a character on this page.
  let width = 0, count = 0;
  for (const row of rows) {
    for (const it of row.items) { width += itemRight(it) - it.x; count += it.str.length; }
  }
  const cell = count ? Math.max(2, width / count) : 6;
  const origin = Math.min(...rows.map((r) => r.x));
  const out = [];
  let lastBase = null;
  for (const row of rows) {
    if (lastBase != null && row.baseline - lastBase > row.size * 1.9) out.push('');
    lastBase = row.baseline;
    let text = '';
    for (const seg of row.segments) {
      const col = Math.round((seg.x - origin) / cell);
      // Never let two pieces run together, and never back up over text.
      const pad = text ? Math.max(col - text.length, 2) : Math.max(col, 0);
      text += ' '.repeat(pad) + seg.text;
    }
    out.push(text.replace(/\s+$/, ''));
  }
  return out.join('\n');
}

function tableText(table) {
  return table.rows.map((row) => row.join('\t').replace(/\s+$/, '')).join('\n');
}

function pageToText(pageData, opts) {
  const o = opts || {};
  if (o.layout) return layoutText(pageData);
  const parts = [];
  let open = null;
  for (const block of pageData.blocks || []) {
    if (block.type === 'paragraph') {
      const p = block.para;
      if (!p.text.trim() || (o.dropRunning !== false && p.artifact)) continue;
      const marker = p.bullet ? (p.ordered ? p.marker + ' ' : '- ') : '';
      if (p.continues && open != null) {
        parts[open] = joinContinued(parts[open], p.text);
        continue;
      }
      open = parts.length;
      parts.push('  '.repeat(p.listLevel || 0) + marker + p.text);
    } else if (block.type === 'table') {
      parts.push(tableText(block.table));
      open = null;
    }
  }
  return parts.filter((t) => t.trim()).join('\n\n');
}

/** Put back together a paragraph that a column or a page had cut in two. */
function joinContinued(head, tail) {
  if (HYPHEN_END.test(head) && /^[a-zß-ÿ]/.test(tail)) return head.slice(0, -1) + tail;
  return head.replace(/\s+$/, '') + ' ' + tail;
}

function documentToText(doc, opts) {
  const o = opts || {};
  const separator = o.pageSeparator !== undefined
    ? o.pageSeparator
    : '\n\n────────  Page {n}  ────────\n\n';
  let out = '';
  doc.pages.forEach((p, i) => {
    const text = pageToText(p, o);
    const first = (p.blocks || []).find((b) => b.type === 'paragraph' && !b.para.artifact && b.para.text.trim());
    // A paragraph carried over from the page before goes straight on.
    if (i > 0 && !o.layout && first && first.para.continues && out) {
      const cut = text.indexOf('\n\n');
      const head = cut < 0 ? text : text.slice(0, cut);
      out = joinContinued(out, head) + (cut < 0 ? '' : text.slice(cut));
      return;
    }
    out += (i === 0 || !separator ? (i === 0 ? '' : '\n\n') : separator.replace('{n}', String(p.number))) + text;
  });
  return out.replace(/\n{4,}/g, '\n\n\n');
}

root.PSExtract = {
  tick,
  extractPage,
  extractDocument,
  finalizeDocument,
  pageFromItems,
  layoutItems,
  textBlocks,
  pageItems,
  pageGraphics,
  pageTextRuns,
  alignColors,
  dominantColor,
  hexColor,
  familyFor,
  cleanFontName,
  groupLines,
  makeLine,
  groupParagraphs,
  buildRuns,
  lineRuns,
  parseMarker,
  joinContinued,
  pageToGrid,
  pageToText,
  documentToText,
  renderPageToCanvas,
  renderPageToBlob,
  canvasToBlob,
  releaseCanvas,
  setTextRule,
  openDocument,
  extractPageImages,
  pageImagePlacements,
  pageEditableImages,
  headingLevel,
  bodySize,
  matMul,
  applyMat
};

})(typeof window !== 'undefined' ? window : globalThis);
