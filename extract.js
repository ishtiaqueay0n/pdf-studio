'use strict';
/* global pdfjsLib */
/*
 * Text and structure extraction.
 *
 * pdf.js hands back a flat bag of positioned glyph runs. Everything that makes
 * a converted document readable — lines, paragraphs, headings, tables, reading
 * order — has to be reconstructed from those positions. That reconstruction
 * lives here so every converter shares one interpretation of the page.
 *
 * All coordinates are in PDF points with a top-left origin, matching a
 * pdf.js viewport at scale 1 (page rotation already applied).
 */
(function (root) {

/* ------------------------------------------------------------------ *
 * Font heuristics
 * ------------------------------------------------------------------ */

const BOLD_RE = /bold|black|heavy|ultra|extrab|semib|demib|[-_,]bd[-_,.]?|[-_,](?:600|700|800|900)\b/i;
const ITALIC_RE = /italic|oblique|kursiv|[-_,]it[-_,.]?/i;
const MONO_RE = /mono|courier|consol|typewriter/i;
const SERIF_RE = /serif|times|georgia|garamond|roman|minion|cambria|book\b|caslon|baskerville/i;

/**
 * What can be told about the font behind a run of text.
 *
 * Three sources, in order of how much they can be trusted:
 *
 *  - `styles[fontName].fontFamily` is set by pdf.js to exactly "serif",
 *    "monospace" or "sans-serif", decided from the font descriptor's own
 *    flags. For serif and monospace that is authoritative and costs nothing.
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
  const probe = name + ' ' + family;

  return {
    name: name || family || fontName,
    family,
    ascent,
    descent,
    bold: flaggedBold || BOLD_RE.test(probe),
    italic: flaggedItalic || ITALIC_RE.test(probe),
    mono: family === 'monospace' || MONO_RE.test(probe),
    serif: family === 'serif' || (SERIF_RE.test(probe) && !/sans/i.test(probe))
  };
}

/* ------------------------------------------------------------------ *
 * Raw items
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Text colour
 *
 * getTextContent() reports what the text says and where it sits, but not what
 * colour it is painted in. That lives in the operator list, so the two have to
 * be read separately and joined back together.
 * ------------------------------------------------------------------ */

function hexColor(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

/**
 * Every run of text the page paints, in stream order, with its fill colour.
 *
 * pdf.js converts gray, CMYK, ICC, indexed, Lab and separation fills into
 * setFillRGBColor with 0-255 components before the operator list gets here, so
 * this only has to follow that one operator and the q/Q stack. A pattern or
 * shading fill arrives as setFillColorN and has no single colour; those runs
 * are left null and the caller falls back to black.
 *
 * pdf.js also rewrites TJ, ' and " into plain showText, so showText is the only
 * text operator that can appear.
 *
 * Rendering mode 3 and 7 are invisible text — the searchable layer underneath a
 * scanned page. Its colour is arbitrary, so those runs are flagged instead.
 */
async function pageTextRuns(page) {
  let ops;
  try {
    ops = await page.getOperatorList();
  } catch (e) {
    return [];
  }
  const OPS = pdfjsLib.OPS;
  const runs = [];
  const stack = [];
  let fill = null;   // null means the PDF default, which is black
  let mode = 0;

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];

    if (fn === OPS.save) {
      stack.push({ fill, mode });
    } else if (fn === OPS.restore) {
      const s = stack.pop();
      if (s) { fill = s.fill; mode = s.mode; }
    } else if (fn === OPS.setFillRGBColor) {
      fill = hexColor(args[0], args[1], args[2]);
    } else if (fn === OPS.setFillColorN) {
      fill = null;
    } else if (fn === OPS.setTextRenderingMode) {
      mode = args[0] | 0;
    } else if (fn === OPS.showText) {
      // Modes 1, 2, 5 and 6 stroke the glyphs as well as filling them. That is
      // how a document fakes a bold face when it has no bold font to use, and
      // the name of the font it does use gives no hint of it.
      const stroked = mode === 1 || mode === 2 || mode === 5 || mode === 6;
      pushRun(runs, glyphText(args[0]), fill, mode === 3 || mode === 7, stroked);
    }
  }
  return runs;
}

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

/** The font most of a line's characters are set in. */
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

  const tc = await page.getTextContent({ disableCombineTextItems: false });
  const items = [];
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
    const f = fontInfo(page, tc, it.fontName);
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
    const runLen = Math.hypot(tx[0], tx[1]);
    const upLen = Math.hypot(tx[2], tx[3]);
    const shear = runLen > 0 && upLen > 0
      ? Math.abs((tx[0] * tx[2] + tx[1] * tx[3]) / (runLen * upLen))
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
  return { viewport, items };
}

/* ------------------------------------------------------------------ *
 * Lines
 * ------------------------------------------------------------------ */

function buildLines(upright) {
  upright.sort((a, b) => (a.baseline - b.baseline) || (a.x - b.x));

  const lines = [];
  let cur = null;
  for (const it of upright) {
    const tol = Math.max(1.6, it.size * 0.45);
    if (cur && Math.abs(it.baseline - cur.baseline) <= tol) {
      cur.items.push(it);
      cur.baseline = (cur.baseline * (cur.items.length - 1) + it.baseline) / cur.items.length;
    } else {
      cur = { baseline: it.baseline, items: [it] };
      lines.push(cur);
    }
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    finishLine(line);
  }
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

function finishLine(line) {
  const its = line.items;
  let size = 0, chars = 0, boldChars = 0, italicChars = 0, monoChars = 0, serifChars = 0;
  let x = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  let text = '';
  const segments = [];
  let seg = null;
  let prev = null;

  for (const it of its) {
    // pdf.js bridges the space between two pieces of text with a synthetic
    // blank run whose width covers the whole gap. Measuring against it would
    // report a gap of zero and merge every table column into one cell, so
    // gaps are always measured from the last run that carried real glyphs.
    if (!it.str.trim()) continue;

    const n = Math.max(1, it.str.length);
    size += it.size * n;
    chars += n;
    if (it.bold) boldChars += n;
    if (it.italic) italicChars += n;
    if (it.mono) monoChars += n;
    if (it.serif) serifChars += n;
    x = Math.min(x, it.x);
    right = Math.max(right, it.x + it.w);
    top = Math.min(top, it.y);
    bottom = Math.max(bottom, it.y + it.h);

    const gap = prev ? it.x - (prev.x + prev.w) : 0;
    const bigGap = !!prev && gap > it.size * 1.1;
    if (prev) {
      if (bigGap) text += '\t';
      else if (gap > it.size * 0.16 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
    }
    text += it.str;

    if (!seg || bigGap) {
      seg = { x: it.x, right: it.x + it.w, text: it.str };
      segments.push(seg);
    } else {
      if (gap > it.size * 0.16 && !/\s$/.test(seg.text) && !/^\s/.test(it.str)) seg.text += ' ';
      seg.text += it.str;
      seg.right = it.x + it.w;
    }
    prev = it;
  }

  line.text = text.replace(/\s+$/, '');
  line.x = x === Infinity ? 0 : x;
  line.right = right === -Infinity ? 0 : right;
  line.y = top === Infinity ? line.baseline : top;
  line.bottom = bottom === -Infinity ? line.baseline : bottom;
  line.w = Math.max(0, line.right - line.x);
  line.h = Math.max(1, line.bottom - line.y);
  line.size = chars ? Math.round((size / chars) * 100) / 100 : 10;
  line.bold = chars > 0 && boldChars / chars > 0.6;
  line.italic = chars > 0 && italicChars / chars > 0.6;
  line.mono = chars > 0 && monoChars / chars > 0.6;
  line.serif = chars > 0 && serifChars / chars > 0.6;
  line.font = dominantFont(its);
  line.color = dominantColor(its) || '#000000';
  // Invisible only when nothing on the line is meant to be seen — a searchable
  // layer under a scan, rather than one hidden word inside a visible sentence.
  const shown = its.filter((i) => i.str && i.str.trim());
  line.invisible = shown.length > 0 && shown.every((i) => i.invisible);
  line.segments = segments.map((s) => ({ x: s.x, right: s.right, text: s.text.trim() }));
  return line;
}

/* ------------------------------------------------------------------ *
 * Paragraphs
 * ------------------------------------------------------------------ */

const BULLET_RE = /^\s*([•●▪◦‣⁃·*–—-]|\(?\d{1,3}[.)]|[a-z][.)]|[ivxIVX]{1,5}[.)])\s+/;

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
  const short = line.text.length < 120;
  if (!short) return 0;
  if (ratio >= 1.7) return 1;
  if (ratio >= 1.35) return 2;
  if (ratio >= 1.14) return 3;
  if (line.bold && ratio >= 1.02 && line.text.length < 70 && !/[.;,]$/.test(line.text)) return 4;
  return 0;
}

function groupParagraphs(lines, pageWidth) {
  const body = bodySize(lines);
  const paras = [];
  let cur = null;
  const bodyLeft = lines.length
    ? lines.map((l) => l.x).sort((a, b) => a - b)[Math.floor(lines.length * 0.25)]
    : 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.text.trim()) { cur = null; continue; }
    const prev = lines[i - 1];
    const level = headingLevel(line, body);
    const bullet = BULLET_RE.test(line.text);

    let breakBefore = !cur;
    if (cur && prev) {
      const gap = line.y - prev.bottom;
      const lead = Math.max(line.size, prev.size);
      if (gap > lead * 0.75) breakBefore = true;
      if (Math.abs(line.size - prev.size) > Math.max(0.8, body * 0.12)) breakBefore = true;
      if (line.bold !== prev.bold) breakBefore = true;
      // A change of colour marks a new block as clearly as a change of weight
      // does, and a paragraph that spanned two colours would have to be shown,
      // and edited, in only one of them.
      if (line.color !== prev.color) breakBefore = true;
      // Visible text and the invisible layer under a scan are never one block.
      if (line.invisible !== prev.invisible) breakBefore = true;
      if (bullet) breakBefore = true;
      if (level !== cur.heading) breakBefore = true;
      if (line.x - cur.x > line.size * 1.2) breakBefore = true;
      if (prev.right < cur.right - line.size * 2.5) breakBefore = true; // short line ends a block
    }

    if (breakBefore) {
      cur = {
        lines: [line], x: line.x, right: line.right, y: line.y, bottom: line.bottom,
        size: line.size, bold: line.bold, italic: line.italic, mono: line.mono,
        serif: line.serif, font: line.font, heading: level, bullet
      };
      paras.push(cur);
    } else {
      cur.lines.push(line);
      cur.x = Math.min(cur.x, line.x);
      cur.right = Math.max(cur.right, line.right);
      cur.bottom = Math.max(cur.bottom, line.bottom);
    }
  }

  for (const p of paras) {
    p.w = Math.max(0, p.right - p.x);
    p.h = Math.max(1, p.bottom - p.y);
    /*
     * The line spacing the block was set with, as a multiple of its size.
     * Redrawing at a fixed 1.25 makes a single-line heading a quarter taller
     * than the space it came out of, which is what makes a replaced block look
     * bigger than the text it replaced.
     */
    if (p.lines.length > 1) {
      const step = (p.lines[p.lines.length - 1].baseline - p.lines[0].baseline) /
        (p.lines.length - 1);
      p.leading = p.size > 0 ? Math.min(3, Math.max(0.9, step / p.size)) : 1.15;
    } else {
      p.leading = p.size > 0 ? Math.min(1.6, Math.max(0.95, p.h / p.size)) : 1.15;
    }
    p.text = p.lines
      .map((l, i) => {
        const t = l.text.replace(/\t/g, ' ').replace(/\s+/g, ' ').trim();
        if (i === 0) return t;
        // Re-join words split across a line break by a hyphen.
        return t;
      })
      .join(' ')
      .replace(/(\w)-\s(?=[a-z])/g, '$1')
      .trim();
    p.align = paragraphAlign(p, pageWidth, bodyLeft);
    p.color = dominantColor(p.lines) || '#000000';
    p.invisible = p.lines.every((l) => l.invisible);
    if (p.bullet) p.text = p.text.replace(BULLET_RE, '').trim();
  }
  return { paragraphs: paras, bodySize: body, bodyLeft };
}

function paragraphAlign(p, pageWidth, bodyLeft) {
  const first = p.lines[0];
  const centre = (first.x + first.right) / 2;
  const pageCentre = pageWidth / 2;
  if (Math.abs(centre - pageCentre) < pageWidth * 0.045 &&
      first.x > bodyLeft + 18 && p.lines.length <= 3) return 'center';
  if (p.lines.length === 1 && first.x > pageWidth * 0.55) return 'right';
  return 'left';
}

/* ------------------------------------------------------------------ *
 * Tables
 * ------------------------------------------------------------------ */

function clusterPositions(values, tolerance) {
  const sorted = values.slice().sort((a, b) => a - b);
  const clusters = [];
  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && v - last.at <= tolerance) {
      last.count++;
      last.at = (last.at * (last.count - 1) + v) / last.count;
    } else {
      clusters.push({ at: v, count: 1 });
    }
  }
  return clusters;
}

/**
 * Look for a grid in a page's lines. Returns null when the page does not read
 * like a table, otherwise { columns: number[], rows: string[][] }.
 */
function detectTable(lines, opts) {
  const minRows = (opts && opts.minRows) || 3;
  const candidates = lines.filter((l) => l.segments.length >= 2 && l.text.trim());
  if (candidates.length < minRows) return null;

  const starts = [];
  for (const l of candidates) for (const s of l.segments) starts.push(s.x);
  const tolerance = Math.max(4, (opts && opts.tolerance) || 8);
  const clusters = clusterPositions(starts, tolerance)
    .filter((c) => c.count >= Math.max(2, candidates.length * 0.5))
    .sort((a, b) => a.at - b.at);
  if (clusters.length < 2) return null;

  const columns = clusters.map((c) => c.at);
  const rows = [];
  // The lines that actually became rows. Exports need this to tell table
  // content apart from the ordinary prose around it, instead of assuming a
  // page holding a table holds nothing else.
  const sourceLines = new Set();
  for (const l of candidates) {
    const cells = new Array(columns.length).fill('');
    for (const s of l.segments) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < columns.length; c++) {
        const d = Math.abs(s.x - columns[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      cells[best] = cells[best] ? cells[best] + ' ' + s.text : s.text;
    }
    if (cells.some((c) => c !== '')) { rows.push(cells); sourceLines.add(l); }
  }
  if (rows.length < minRows) return null;

  const filled = rows.reduce((n, r) => n + r.filter((c) => c !== '').length, 0);
  if (filled / (rows.length * columns.length) < 0.45) return null;
  return { columns, rows, sourceLines };
}

/**
 * A grid for every page, table or not — used by the spreadsheet and CSV
 * exports, which always need rows and columns of some shape.
 */
function pageToGrid(pageData) {
  const table = pageData.table;
  if (table) return table.rows;
  return pageData.lines
    .filter((l) => l.text.trim())
    .map((l) => (l.segments.length > 1 ? l.segments.map((s) => s.text) : [l.text.trim()]));
}

/* ------------------------------------------------------------------ *
 * Page + document extraction
 * ------------------------------------------------------------------ */

async function extractPage(page, index, opts) {
  const { viewport, items } = await pageItems(page, { colors: !opts || opts.colors !== false });
  const { lines, rotated, bounds } = groupLines(items);
  const flowWidth = (bounds && bounds.width) || viewport.width;
  const { paragraphs, bodySize: body, bodyLeft } = groupParagraphs(lines, flowWidth);
  const table = (opts && opts.detectTables === false) ? null : detectTable(lines, opts);
  return {
    index,
    number: index + 1,
    width: viewport.width,
    height: viewport.height,
    flowWidth,
    recoveredRotation: bounds ? bounds.angle : 0,
    rotation: viewport.rotation || 0,
    items,
    rotatedItems: rotated,
    lines,
    paragraphs,
    table,
    bodySize: body,
    bodyLeft,
    isEmpty: lines.length === 0
  };
}

/**
 * @param {object} pdf       a pdf.js document proxy
 * @param {object} [opts]    { pages: number[] (0-based), onProgress(i, n) }
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
      if (data.isEmpty && options.onEmptyPage) {
        const second = await options.onEmptyPage(page, data);
        if (second) data = second;
      }
      out.push(data);
    } catch (err) {
      failed.push({ page: i + 1, message: (err && err.message) || String(err) });
      out.push(placeholderPage(i, page));
    } finally {
      if (page) { try { page.cleanup(); } catch (err) { /* already gone */ } }
    }
    if (options.onProgress) options.onProgress(n + 1, indexes.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  return { pages: out, numPages: pdf.numPages, failed };
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
    lines: [],
    paragraphs: [],
    table: null,
    bodySize: 10,
    bodyLeft: 0,
    isEmpty: true,
    unreadable: true
  };
}

/* ------------------------------------------------------------------ *
 * Rasterising
 * ------------------------------------------------------------------ */

async function renderPageToCanvas(page, dpi, background) {
  const scale = (dpi || 150) / 72;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(vp.width));
  canvas.height = Math.max(1, Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  if (background !== 'transparent') {
    ctx.fillStyle = background || '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
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
  const canvas = await renderPageToCanvas(page, dpi, type === 'image/png' ? 'transparent' : '#ffffff');
  const blob = await canvasToBlob(canvas, type, quality);
  return { blob, width: canvas.width, height: canvas.height, type };
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

/* ------------------------------------------------------------------ *
 * Where the images sit
 * ------------------------------------------------------------------ */

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

/**
 * The rectangle each painted image occupies, in page points from the top-left.
 *
 * A PDF image is always drawn into the unit square and placed by the current
 * transformation matrix, so following q/Q and cm through the operator list and
 * mapping the unit square gives the rectangle on the page. Form XObjects push
 * their own matrix, and pdf.js reports those as an explicit begin/end pair.
 *
 * Tiling and repeating variants are skipped: they are a pattern rather than one
 * picture a reader would think of as editable.
 */
async function pageImagePlacements(page) {
  let ops;
  try {
    ops = await page.getOperatorList();
  } catch (e) {
    return [];
  }
  const OPS = pdfjsLib.OPS;
  const viewport = page.getViewport({ scale: 1 });
  const single = new Set([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject
  ]);

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const out = [];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];

    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      if (stack.length) ctm = stack.pop();
    } else if (fn === OPS.transform) {
      ctm = matMul(ctm, args);
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args && args[0]) ctm = matMul(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) {
      if (stack.length) ctm = stack.pop();
    } else if (single.has(fn)) {
      const place = matMul(viewport.transform, ctm);
      const corners = [applyMat(place, 0, 0), applyMat(place, 1, 0),
                       applyMat(place, 1, 1), applyMat(place, 0, 1)];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of corners) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      const w = maxX - minX;
      const h = maxY - minY;
      if (!isFinite(w) || !isFinite(h) || w < 1 || h < 1) continue;
      const arg = args[0];
      out.push({
        op: i,
        name: typeof arg === 'string' ? arg : null,
        inline: typeof arg !== 'string',
        mask: fn === OPS.paintImageMaskXObject,
        x: minX,
        y: minY,
        w,
        h
      });
    }
  }
  return out;
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
    await renderPageToCanvas(page, 36, '#ffffff');
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
    if (canvas.width * canvas.height < floor) continue;
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
    await renderPageToCanvas(page, 36, '#ffffff');
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
    if (canvas.width * canvas.height < o.minPixels) continue;
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

function pageToText(pageData, opts) {
  const layout = opts && opts.layout;
  if (layout) {
    return pageData.lines.map((l) => l.text.replace(/\t/g, '    ')).join('\n');
  }
  return pageData.paragraphs
    .map((p) => (p.bullet ? '- ' : '') + p.text)
    .filter((t) => t.trim())
    .join('\n\n');
}

function documentToText(doc, opts) {
  const separator = (opts && opts.pageSeparator) !== undefined
    ? opts.pageSeparator
    : '\n\n────────  Page {n}  ────────\n\n';
  return doc.pages
    .map((p, i) => (i === 0 || !separator ? '' : separator.replace('{n}', String(p.number))) + pageToText(p, opts))
    .join('')
    .replace(/\n{4,}/g, '\n\n\n');
}

root.PSExtract = {
  extractPage,
  extractDocument,
  pageItems,
  pageTextRuns,
  alignColors,
  dominantColor,
  hexColor,
  groupLines,
  groupParagraphs,
  detectTable,
  pageToGrid,
  pageToText,
  documentToText,
  renderPageToCanvas,
  renderPageToBlob,
  canvasToBlob,
  extractPageImages,
  pageImagePlacements,
  pageEditableImages,
  headingLevel,
  bodySize
};

})(typeof window !== 'undefined' ? window : globalThis);
