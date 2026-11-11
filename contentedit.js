'use strict';
/* global pdfjsLib, PDFLib */
/*
 * Taking text out of a page for real.
 *
 * Covering words with a box does not remove them: they are still in the file,
 * selectable by anything that looks. The only alternative used to be turning
 * the whole page into a picture. This module does what an editor should — it
 * rewrites the page's content stream so the glyphs are no longer drawn — and
 * leaves everything else on the page exactly where it was, still text, still
 * vector.
 *
 * How:
 *
 *  1. pdf.js has already worked out where every glyph on the page sits. Its
 *     operator list is replayed here to get the origin of each one, and the
 *     glyphs whose origin falls in the area being erased are marked.
 *  2. The content stream is split into operators. The n-th text-showing
 *     operator in the stream is the n-th one in pdf.js's list, which ties
 *     each marked glyph to the bytes that draw it.
 *  3. Each affected operator is rewritten as a TJ array in which the marked
 *     glyphs are replaced by a number that moves the text position on by
 *     exactly their width. Nothing after them shifts.
 *  4. The result is checked: the rewritten page is opened again and every
 *     glyph that was meant to stay must be where it was, and none that was
 *     meant to go may remain. If the check fails for any reason the page is
 *     put back as it was and the caller falls back to the old way.
 *
 * Only text in the page's own content stream is handled. Text inside a form
 * XObject, vertical writing, and anything the two parsers disagree about are
 * refused rather than guessed at.
 */
(function (root) {

/* ------------------------------------------------------------------ *
 * Where the glyphs are
 * ------------------------------------------------------------------ */

function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ];
}

function waitFor(objs, name) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v || null); } };
    try {
      if (objs.has(name)) { finish(objs.get(name)); return; }
    } catch (e) { /* use the callback form */ }
    try { objs.get(name, finish); } catch (e) { finish(null); }
    setTimeout(() => finish(null), 3000);
  });
}

/**
 * Replay a page's operator list far enough to know where each glyph is drawn.
 *
 * Returns the text-showing operators of the page's own content stream, in
 * order. Each holds the entries pdf.js built for it — glyphs and the spacing
 * numbers between them — and for every glyph its origin in viewport space
 * (points from the top-left) and how far it moves the text position on.
 *
 * This follows pdf.js's own canvas code step for step; the positions have to
 * be the ones the page is actually drawn with.
 */
async function pageShows(page) {
  const ops = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const base = page.getViewport({ scale: 1 }).transform;
  const IDENTITY = [1, 0, 0, 1, 0, 0];

  let ctm = IDENTITY;
  let ts = {
    font: null, fontSize: 0, dir: 1, fm0: 0.001, vertical: false,
    charSpacing: 0, wordSpacing: 0, hScale: 1, rise: 0, leading: 0,
    tm: IDENTITY, x: 0, y: 0, lineX: 0, lineY: 0
  };
  const stack = [];
  let depth = 0;       // inside a form XObject or an annotation's appearance
  const shows = [];
  let foreign = 0;     // text drawn from somewhere other than the page's stream

  const push = () => stack.push({ ctm, ts: Object.assign({}, ts) });
  const pop = () => {
    const s = stack.pop();
    if (s) { ctm = s.ctm; ts = s.ts; }
  };
  const moveText = (x, y) => {
    ts.x = ts.lineX += x;
    ts.y = ts.lineY += y;
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const a = ops.argsArray[i];
    switch (fn) {
      case OPS.save: push(); break;
      case OPS.restore: pop(); break;
      case OPS.transform: ctm = mul(ctm, a); break;
      case OPS.paintFormXObjectBegin:
        push();
        depth++;
        if (a && a[0]) ctm = mul(ctm, a[0]);
        break;
      case OPS.paintFormXObjectEnd: pop(); depth--; break;
      case OPS.beginAnnotation: push(); depth++; break;
      case OPS.endAnnotation: pop(); depth--; break;
      case OPS.beginText:
        ts.tm = IDENTITY;
        ts.x = ts.y = ts.lineX = ts.lineY = 0;
        break;
      case OPS.setCharSpacing: ts.charSpacing = a[0]; break;
      case OPS.setWordSpacing: ts.wordSpacing = a[0]; break;
      case OPS.setHScale: ts.hScale = a[0] / 100; break;
      case OPS.setLeading: ts.leading = -a[0]; break;
      case OPS.setTextRise: ts.rise = a[0]; break;
      case OPS.setFont: {
        const font = await waitFor(page.commonObjs, a[0]);
        ts.font = font;
        ts.fontSize = Math.abs(a[1]);
        ts.dir = a[1] < 0 ? -1 : 1;
        ts.fm0 = font && font.fontMatrix ? font.fontMatrix[0] : 0.001;
        ts.vertical = !!(font && font.vertical);
        break;
      }
      case OPS.moveText: moveText(a[0], a[1]); break;
      case OPS.setLeadingMoveText:
        ts.leading = a[1];
        moveText(a[0], a[1]);
        break;
      case OPS.setTextMatrix:
        ts.tm = [a[0], a[1], a[2], a[3], a[4], a[5]];
        ts.x = ts.y = ts.lineX = ts.lineY = 0;
        break;
      case OPS.nextLine: moveText(0, ts.leading); break;
      case OPS.showText: {
        const glyphs = Array.isArray(a[0]) ? a[0] : [];
        const place = mul(mul(base, ctm), ts.tm);
        const size = ts.fontSize;
        const hs = ts.hScale * ts.dir;
        const entries = [];
        let x = 0;
        for (const g of glyphs) {
          if (g == null) continue;
          if (typeof g === 'number') {
            x += (ts.vertical ? 1 : -1) * g * size / 1000;
            entries.push({ num: g });
            continue;
          }
          const spacing = (g.isSpace ? ts.wordSpacing : 0) + ts.charSpacing;
          const adv = (g.width || 0) * size * ts.fm0 + spacing * ts.dir;
          const tx = ts.x + x * hs, ty = ts.y + ts.rise;
          entries.push({
            g,
            x: place[0] * tx + place[2] * ty + place[4],
            y: place[1] * tx + place[3] * ty + place[5],
            adv,
            remove: false
          });
          x += adv;
        }
        if (ts.vertical) ts.y -= x; else ts.x += x * hs;
        if (depth > 0) { foreign++; break; }
        shows.push({
          entries, size, vertical: ts.vertical,
          composite: !!(ts.font && ts.font.composite),
          usable: !!ts.font && size > 0 && !ts.vertical
        });
        break;
      }
      default: break;
    }
  }
  return { shows, foreign };
}

/** Every glyph of a page's own content, in drawing order, for comparing. */
function flatGlyphs(shows) {
  const out = [];
  for (const show of shows) {
    for (const e of show.entries) {
      if (e.g) out.push(e);
    }
  }
  return out;
}

function inRects(rects, x, y) {
  for (const r of rects) {
    if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Reading a content stream
 * ------------------------------------------------------------------ */

const isSpace =(c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
// ( ) < > [ ] { } / %
const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 ||
  c === 123 || c === 125 || c === 47 || c === 37;

function hexVal(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

/** A literal string starting at `i` (the opening bracket): { bytes, end }. */
function readLiteral(b, i) {
  const out = [];
  let depth = 1;
  let p = i + 1;
  const n = b.length;
  while (p < n) {
    const c = b[p];
    if (c === 92) {                       // backslash
      const d = b[p + 1];
      p += 2;
      if (d === 110) out.push(10);
      else if (d === 114) out.push(13);
      else if (d === 116) out.push(9);
      else if (d === 98) out.push(8);
      else if (d === 102) out.push(12);
      else if (d === 13) { if (b[p] === 10) p++; }   // line continuation
      else if (d === 10) { /* line continuation */ }
      else if (d >= 48 && d <= 55) {
        let v = d - 48;
        for (let k = 0; k < 2 && b[p] >= 48 && b[p] <= 55; k++) v = v * 8 + (b[p++] - 48);
        out.push(v & 255);
      } else if (d !== undefined) out.push(d);
      continue;
    }
    if (c === 40) { depth++; out.push(c); p++; continue; }
    if (c === 41) {
      depth--;
      p++;
      if (depth === 0) return { bytes: out, end: p };
      out.push(c);
      continue;
    }
    // An end of line inside a string is a single line feed, however written.
    if (c === 13) { out.push(10); p++; if (b[p] === 10) p++; continue; }
    out.push(c);
    p++;
  }
  return null;
}

/** A hexadecimal string starting at `i` (the opening angle bracket). */
function readHex(b, i) {
  const out = [];
  let p = i + 1;
  let high = -1;
  while (p < b.length) {
    const c = b[p++];
    if (c === 62) {
      if (high >= 0) out.push(high << 4);
      return { bytes: out, end: p };
    }
    const v = hexVal(c);
    if (v < 0) continue;
    if (high < 0) high = v;
    else { out.push((high << 4) | v); high = -1; }
  }
  return null;
}

function readRegular(b, i) {
  let p = i;
  while (p < b.length && !isSpace(b[p]) && !isDelim(b[p])) p++;
  return p;
}

function ascii(b, s, e) {
  let out = '';
  for (let i = s; i < e; i++) out += String.fromCharCode(b[i]);
  return out;
}

/** Step over a dictionary, which may hold strings with brackets of their own. */
function skipDict(b, i) {
  let p = i + 2;
  let depth = 1;
  while (p < b.length) {
    const c = b[p];
    if (c === 40) { const s = readLiteral(b, p); if (!s) return -1; p = s.end; continue; }
    if (c === 60 && b[p + 1] === 60) { depth++; p += 2; continue; }
    if (c === 62 && b[p + 1] === 62) { depth--; p += 2; if (!depth) return p; continue; }
    if (c === 60) { const s = readHex(b, p); if (!s) return -1; p = s.end; continue; }
    if (c === 37) { while (p < b.length && b[p] !== 10 && b[p] !== 13) p++; continue; }
    p++;
  }
  return -1;
}

/** The elements of an array starting at `i`: strings and numbers; else opaque. */
function readArray(b, i) {
  const elems = [];
  let p = i + 1;
  while (p < b.length) {
    const c = b[p];
    if (isSpace(c)) { p++; continue; }
    if (c === 93) return { elems, end: p + 1 };
    if (c === 37) { while (p < b.length && b[p] !== 10 && b[p] !== 13) p++; continue; }
    if (c === 40) {
      const s = readLiteral(b, p);
      if (!s) return null;
      elems.push({ str: s.bytes });
      p = s.end;
    } else if (c === 60 && b[p + 1] === 60) {
      const e = skipDict(b, p);
      if (e < 0) return null;
      elems.push({ other: true });
      p = e;
    } else if (c === 60) {
      const s = readHex(b, p);
      if (!s) return null;
      elems.push({ str: s.bytes });
      p = s.end;
    } else if (c === 91) {
      const s = readArray(b, p);
      if (!s) return null;
      elems.push({ other: true });
      p = s.end;
    } else if (c === 47) {
      p = readRegular(b, p + 1);
      elems.push({ other: true });
    } else {
      const e = readRegular(b, p);
      if (e === p) return null;
      const raw = ascii(b, p, e);
      const v = Number(raw);
      elems.push(isFinite(v) && /^[-+.\d]/.test(raw) ? { num: v, raw } : { other: true });
      p = e;
    }
  }
  return null;
}

/** Find the end of an inline image's data: the EI that really ends it. */
function skipInlineImage(b, i) {
  // i is just past "BI". Find ID, then EI standing alone with content after it.
  let p = i;
  const n = b.length;
  while (p < n - 1) {
    if (b[p] === 73 && b[p + 1] === 68 && isSpace(b[p - 1]) && (p + 2 >= n || isSpace(b[p + 2]))) break;
    if (b[p] === 40) { const s = readLiteral(b, p); if (!s) return -1; p = s.end; continue; }
    p++;
  }
  if (p >= n - 1) return -1;
  p += 3;
  for (; p < n - 1; p++) {
    if (b[p] !== 69 || b[p + 1] !== 73) continue;
    if (!isSpace(b[p - 1])) continue;
    const after = p + 2;
    if (after < n && !isSpace(b[after])) continue;
    // What follows must read like a content stream, not like more image data.
    let ok = true;
    for (let k = after; k < Math.min(n, after + 12); k++) {
      const c = b[k];
      if (!(isSpace(c) || (c >= 32 && c < 127))) { ok = false; break; }
    }
    if (ok) return after;
  }
  return -1;
}

const SHOW_OPS = { Tj: 1, TJ: 1, '\'': 1, '"': 1 };

/**
 * The text-showing operators of a content stream, in order, each with the
 * bytes it spans (operands included) and its operands taken apart.
 * Returns null when the stream cannot be read with confidence.
 */
function findShows(b) {
  const shows = [];
  let args = [];
  let i = 0;
  const n = b.length;
  while (i < n) {
    const c = b[i];
    if (isSpace(c)) { i++; continue; }
    if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
    const start = i;
    if (c === 40) {
      const s = readLiteral(b, i);
      if (!s) return null;
      args.push({ s: start, e: s.end, str: s.bytes });
      i = s.end;
    } else if (c === 60 && b[i + 1] === 60) {
      const e = skipDict(b, i);
      if (e < 0) return null;
      args.push({ s: start, e });
      i = e;
    } else if (c === 60) {
      const s = readHex(b, i);
      if (!s) return null;
      args.push({ s: start, e: s.end, str: s.bytes });
      i = s.end;
    } else if (c === 91) {
      const s = readArray(b, i);
      if (!s) return null;
      args.push({ s: start, e: s.end, arr: s.elems });
      i = s.end;
    } else if (c === 47) {
      i = readRegular(b, i + 1);
      args.push({ s: start, e: i });
    } else if (c === 62 || c === 93 || c === 41 || c === 123 || c === 125) {
      return null;                          // a stray closing bracket
    } else {
      const e = readRegular(b, i);
      if (e === i) return null;
      const word = ascii(b, i, e);
      i = e;
      if (/^[-+.\d]/.test(word) && isFinite(Number(word))) {
        args.push({ s: start, e, num: Number(word), raw: word });
      } else if (word === 'true' || word === 'false' || word === 'null') {
        args.push({ s: start, e });
      } else if (word === 'BI') {
        const end = skipInlineImage(b, i);
        if (end < 0) return null;
        i = end;
        args = [];
      } else {
        if (SHOW_OPS[word]) {
          shows.push({ op: word, start: args.length ? args[0].s : start, end: e, args });
        }
        args = [];
      }
    }
  }
  return shows;
}

/* ------------------------------------------------------------------ *
 * Rewriting
 * ------------------------------------------------------------------ */

function hexOf(bytes) {
  let out = '';
  for (const v of bytes) out += (v < 16 ? '0' : '') + v.toString(16);
  return out;
}

function fmt(v) {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

/** How many bytes of a string one glyph was read from. */
function glyphBytes(bytes, at, glyph, composite) {
  if (!composite) return at < bytes.length ? 1 : 0;
  const code = glyph.originalCharCode;
  for (const len of [2, 1, 3, 4]) {
    if (at + len > bytes.length) continue;
    let v = 0;
    for (let k = 0; k < len; k++) v = v * 256 + bytes[at + k];
    if (v === code) return len;
  }
  return 0;
}

/**
 * One text-showing operator with its marked glyphs taken out. The glyphs that
 * stay are written back byte for byte; each run that goes becomes a number
 * that advances the text position by what those glyphs would have.
 * Returns null if the operator's bytes and pdf.js's glyphs do not line up.
 */
function rewriteShow(token, show) {
  const args = token.args;
  let elems;
  let lead = '';
  if (token.op === 'TJ') {
    const a = args[args.length - 1];
    if (!a || !a.arr) return null;
    elems = a.arr;
  } else {
    const a = args[args.length - 1];
    if (!a || !a.str) return null;
    elems = [{ str: a.str }];
    if (token.op === '\'') lead = 'T* ';
    if (token.op === '"') {
      const aw = args[args.length - 3], ac = args[args.length - 2];
      if (!aw || !ac || aw.raw === undefined || ac.raw === undefined) return null;
      lead = aw.raw + ' Tw ' + ac.raw + ' Tc T* ';
    }
  }

  const out = [];
  let keep = [];
  let gone = 0;
  const flushKeep = () => { if (keep.length) { out.push('<' + hexOf(keep) + '>'); keep = []; } };
  const flushGone = () => { if (gone) { out.push(fmt(gone)); gone = 0; } };
  const entries = show.entries;
  let gi = 0;

  for (const el of elems) {
    if (el.other) return null;
    if (el.num !== undefined) {
      const e = entries[gi];
      if (!e || e.num === undefined) return null;
      gi++;
      flushKeep();
      flushGone();
      out.push(el.raw);
      continue;
    }
    const bytes = el.str;
    let at = 0;
    while (at < bytes.length) {
      const e = entries[gi];
      if (!e || !e.g) return null;
      const len = glyphBytes(bytes, at, e.g, show.composite);
      if (!len) return null;
      if (e.remove) {
        flushKeep();
        gone += -e.adv * 1000 / show.size;
      } else {
        flushGone();
        for (let k = 0; k < len; k++) keep.push(bytes[at + k]);
      }
      at += len;
      gi++;
    }
  }
  if (gi !== entries.length) return null;
  flushKeep();
  flushGone();
  return lead + '[' + out.join(' ') + '] TJ';
}

/* ------------------------------------------------------------------ *
 * The page's stream in pdf-lib
 * ------------------------------------------------------------------ */

function pageStreams(doc, page) {
  const { PDFName, PDFArray, PDFRawStream, PDFRef, decodePDFRawStream } = PDFLib;
  const context = doc.context;
  const entry = page.node.get(PDFName.of('Contents'));
  const resolved = context.lookup(entry);
  if (!resolved) return null;
  const refs = resolved instanceof PDFArray ? resolved.asArray() : [entry];
  const parts = [];
  let total = 0;
  for (const ref of refs) {
    const stream = context.lookup(ref);
    if (!stream) return null;
    let data;
    if (stream instanceof PDFRawStream) data = decodePDFRawStream(stream).decode();
    else if (typeof stream.getUnencodedContents === 'function') data = stream.getUnencodedContents();
    else return null;
    parts.push(data);
    total += data.length + 1;
  }
  // The pieces of a split stream join at token boundaries; a line feed
  // between them keeps them apart.
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
    bytes[at++] = 10;
  }
  return { entry, refs: refs.filter((r) => r instanceof PDFRef), bytes };
}

/**
 * Take the glyphs inside `rects` out of a page.
 *
 * @param {object} doc       pdf-lib document
 * @param {object} page      pdf-lib page of that document
 * @param {object} pdfPage   the pdf.js proxy for the same page
 * @param {object[]} rects   { x0, y0, x1, y1 } in viewport space
 * @returns a plan — { removed, expected, commit(), revert() } — with the
 *          page already rewritten, or null when the page was left untouched
 *          because it cannot be done safely
 */
async function erase(doc, page, pdfPage, rects) {
  if (!rects || !rects.length) return null;
  const { shows } = await pageShows(pdfPage);
  let removed = 0;
  const touched = [];
  shows.forEach((show, k) => {
    let hit = false;
    for (const e of show.entries) {
      if (e.g && inRects(rects, e.x, e.y)) { e.remove = true; hit = true; removed++; }
    }
    if (hit) touched.push(k);
  });
  // Nothing of the page's own to take out: the words were inside a form, or
  // are not drawn as text at all.
  if (!removed) return null;
  for (const k of touched) if (!shows[k].usable) return null;

  const streams = pageStreams(doc, page);
  if (!streams) return null;
  const tokens = findShows(streams.bytes);
  // The two readings of the page must agree on how much text there is, or
  // the n-th operator of one is not the n-th of the other.
  if (!tokens || tokens.length !== shows.length) return null;

  const edits = [];
  for (const k of touched) {
    const text = rewriteShow(tokens[k], shows[k]);
    if (text == null) return null;
    edits.push({ start: tokens[k].start, end: tokens[k].end, text });
  }
  edits.sort((a, b) => a.start - b.start);

  const chunks = [];
  let at = 0;
  let size = 0;
  for (const edit of edits) {
    if (edit.start < at) return null;
    const before = streams.bytes.subarray(at, edit.start);
    const piece = new Uint8Array(edit.text.length);
    for (let i = 0; i < edit.text.length; i++) piece[i] = edit.text.charCodeAt(i);
    chunks.push(before, piece);
    size += before.length + piece.length;
    at = edit.end;
  }
  const rest = streams.bytes.subarray(at);
  chunks.push(rest);
  size += rest.length;
  const out = new Uint8Array(size);
  at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }

  const { PDFName } = PDFLib;
  const context = doc.context;
  const fresh = context.register(context.flateStream(out));
  page.node.set(PDFName.of('Contents'), fresh);

  const expected = flatGlyphs(shows).filter((e) => !e.remove)
    .map((e) => ({ x: e.x, y: e.y, code: e.g.originalCharCode }));

  return {
    removed,
    expected,
    /** Keep the rewrite, and drop the old stream so the words are not left in the file. */
    commit() {
      const inUse = new Set();
      for (const p of doc.getPages()) {
        const entry = p.node.get(PDFName.of('Contents'));
        const resolved = context.lookup(entry);
        if (entry instanceof PDFLib.PDFRef) inUse.add(entry.toString());
        if (resolved instanceof PDFLib.PDFArray) {
          for (const r of resolved.asArray()) inUse.add(r.toString());
        }
      }
      for (const ref of streams.refs) {
        if (!inUse.has(ref.toString())) context.delete(ref);
      }
      if (streams.entry instanceof PDFLib.PDFRef && !inUse.has(streams.entry.toString())) {
        context.delete(streams.entry);
      }
    },
    /** Put the page back exactly as it was. */
    revert() {
      page.node.set(PDFName.of('Contents'), streams.entry);
      context.delete(fresh);
    }
  };
}

/**
 * Check a rewritten page against its plan: every glyph that was to stay is
 * where it was, in the same order, and there is nothing else.
 */
async function verify(pdfPage, plan) {
  const { shows } = await pageShows(pdfPage);
  const now = flatGlyphs(shows);
  const want = plan.expected;
  if (now.length !== want.length) return false;
  for (let i = 0; i < now.length; i++) {
    const a = now[i], b = want[i];
    if (a.g.originalCharCode !== b.code) return false;
    if (Math.abs(a.x - b.x) > 0.06 || Math.abs(a.y - b.y) > 0.06) return false;
  }
  return true;
}

root.PSContentEdit = { erase, verify, pageShows, findShows, rewriteShow, flatGlyphs };

})(typeof window !== 'undefined' ? window : globalThis);
