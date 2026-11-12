'use strict';
/* global PS, PSTheme */
/*
 * The command palette: Ctrl+K, type a few letters, Enter.
 *
 * Every tool, every task in the Tools drawer and every view setting is listed
 * here under the words a person would use for it. Nothing is implemented in
 * this file — each entry calls a function that already exists or presses a
 * button that is already on the page — so the palette cannot drift from what
 * the buttons do.
 */
(function () {

const { $, $$, state } = PS;

const wrap = $('#palette');
const input = $('#palette-input');
const list = $('#palette-list');

const press = (id) => () => { const el = $('#' + id); if (el) el.click(); };
const tool = (name) => () => PS.setTool(name);
const task = (pane, then) => () => { PS.openHub(pane); if (then) then(); };
const format = (name) => task('hub-convert', () => {
  const b = $('.fmt[data-format="' + name + '"]');
  if (b) b.click();
});
const panel = (id) => () => PS.showSidePanel(id);

/*
 * group, label, icon, extra words to match, key shown, action, needs a document
 */
const COMMANDS = [
  ['Tools', 'Select and move', 'cursor', 'pointer arrow pick', 'V', tool('select'), true],
  ['Tools', 'Add text', 'text', 'type write box', 'T', tool('text'), true],
  ['Tools', 'Draw', 'pen', 'pen freehand ink pencil', 'D', tool('draw'), true],
  ['Tools', 'Highlight', 'highlight', 'marker', 'H', tool('highlight'), true],
  ['Tools', 'Shape', 'shape', 'rectangle ellipse circle line arrow box', 'R', tool('shape'), true],
  ['Tools', 'Sticky note', 'note', 'comment annotation', 'N', tool('note'), true],
  ['Tools', 'Whiteout', 'eraser', 'cover erase hide white', 'W', tool('whiteout'), true],
  ['Tools', 'Redact', 'redact', 'black out remove censor', 'X', tool('redact'), true],
  ['Tools', 'Sign', 'sign', 'signature', 'S', press('btn-signature'), true],
  ['Tools', 'Stamp', 'stamp', 'approved draft confidential', 'M', press('btn-stamp'), true],
  ['Tools', 'Insert a picture', 'image', 'image photo logo', 'I', press('btn-image'), true],
  ['Tools', 'Edit text in the document', 'text-edit', 'change words paragraph typo', 'E', tool('edittext'), true],
  ['Tools', 'Edit a picture in the document', 'image-edit', 'move replace image', 'P', tool('pictures'), true],

  ['Convert', 'Convert to Word', 'swap', 'docx doc export', '', format('docx'), true],
  ['Convert', 'Convert to Excel', 'swap', 'xlsx spreadsheet table export', '', format('xlsx'), true],
  ['Convert', 'Convert to PowerPoint', 'swap', 'pptx slides export', '', format('pptx'), true],
  ['Convert', 'Convert to images', 'image', 'png jpg jpeg webp picture export', '', format('images'), true],
  ['Convert', 'Convert to a web page', 'swap', 'html export', '', format('html'), true],
  ['Convert', 'Convert to Markdown', 'swap', 'md export', '', format('md'), true],
  ['Convert', 'Convert to plain text', 'text', 'txt export copy', '', format('txt'), true],
  ['Convert', 'Convert to CSV', 'swap', 'table data export', '', format('csv'), true],
  ['Convert', 'Convert to JSON', 'swap', 'structured data export', '', format('json'), true],
  ['Convert', 'Extract the pictures', 'image', 'images zip', '', format('embeddedImages'), true],

  ['Document', 'Merge PDFs', 'layers', 'join combine append', '', task('hub-organise'), true],
  ['Document', 'Split into several files', 'layers', 'separate break cut', '', task('hub-organise'), true],
  ['Document', 'Compress', 'compress', 'smaller reduce size shrink', '', task('hub-size'), true],
  ['Document', 'Resize, crop or impose pages', 'layout', 'page size scale n-up a4 letter', '', task('hub-layout'), true],
  ['Document', 'Reverse the page order', 'layout', 'flip order', '', task('hub-layout', press('btn-reverse')), true],
  ['Document', 'Rotate every page', 'rotate-right', 'turn 90', '', task('hub-layout', press('btn-rotate-all')), true],
  ['Document', 'Watermark', 'droplet', 'stamp text image background', '', task('hub-mark'), true],
  ['Document', 'Headers, footers and page numbers', 'droplet', 'numbering bates', '', task('hub-mark'), true],
  ['Document', 'Protect with a password', 'lock', 'encrypt security permissions', '', task('hub-security'), true],
  ['Document', 'Remove a password', 'lock', 'decrypt unlock', '', task('hub-security'), true],
  ['Document', 'Strip scripts and embedded files', 'lock', 'sanitize clean javascript', '', task('hub-security', press('btn-sanitize-run')), true],
  ['Document', 'Flatten form fields', 'form', 'forms', '', task('hub-security', press('btn-flatten-run')), true],
  ['Document', 'Title, author and attachments', 'info', 'metadata details properties', '', task('hub-info'), true],
  ['Document', 'Make a PDF from other files', 'file-plus', 'create images word excel text', '', task('hub-create'), false],

  ['File', 'Open a PDF', 'open', 'load choose', 'Ctrl O', press('pdf-input'), false],
  ['File', 'Save the PDF', 'download', 'download export', 'Ctrl S', press('btn-download'), true],
  ['File', 'Rename the file', 'file', 'name title', '', press('doc-name'), true],
  ['File', 'Undo', 'undo', 'back', 'Ctrl Z', () => PS.undo(), true],
  ['File', 'Redo', 'redo', 'forward again', 'Ctrl Shift Z', () => PS.redo(), true],

  ['View', 'Zoom in', 'plus', 'bigger larger', 'Ctrl +', press('zoom-in'), true],
  ['View', 'Zoom out', 'minus', 'smaller', 'Ctrl −', press('zoom-out'), true],
  ['View', 'Fit width', 'fit', 'zoom reset', 'Ctrl 0', () => PS.fitWidth(), true],
  ['View', 'Fit whole page', 'fit', 'zoom height', '', () => PS.fitPage(), true],
  ['View', 'Pages panel', 'pages', 'thumbnails organise reorder delete rotate', 'F4', panel('panel-pages'), false],
  ['View', 'Bookmarks panel', 'bookmark', 'outline contents', '', panel('panel-outline'), false],
  ['View', 'Find in document', 'search', 'search text', 'Ctrl F', () => { PS.showSidePanel('panel-search'); $('#search-input').focus(); }, false],
  ['View', 'Form fields panel', 'form', 'fill forms', '', panel('panel-fields'), false],
  ['View', 'Notes panel', 'comment', 'comments sticky', '', panel('panel-notes'), false],
  ['View', 'Hide the side panel', 'panel', 'collapse close sidebar', '', () => PS.setSidebar(false), false],
  ['View', 'Night reading', 'contrast', 'invert dark page', '', press('btn-night'), false],
  ['View', 'Presentation', 'present', 'full screen slideshow', 'F5', () => PS.setPresent(!state.present), true],
  ['View', 'Light theme', 'sun', 'appearance mode', '', () => PSTheme.set('light'), false],
  ['View', 'Dark theme', 'moon', 'appearance mode', '', () => PSTheme.set('dark'), false],
  ['View', 'Match the system theme', 'monitor', 'appearance mode auto', '', () => PSTheme.set('system'), false],
  ['View', 'Keyboard shortcuts', 'keyboard', 'keys help', '?', press('btn-keys'), false]
].map(([group, label, icon, words, key, run, doc]) => ({
  group, label, icon, key, run, doc,
  hay: (label + ' ' + words).toLowerCase(),
  low: label.toLowerCase()
}));

let shown = [];
let active = 0;

/** How well a command answers what was typed; 0 means not at all. */
function score(cmd, q) {
  if (cmd.low.startsWith(q)) return 100;
  const words = cmd.hay.split(/\s+/);
  if (words.some((w) => w.startsWith(q))) return cmd.low.includes(q) ? 80 : 60;
  if (cmd.low.includes(q)) return 50;
  if (cmd.hay.includes(q)) return 40;
  // Every word typed starts some word of the command: "con wo" finds Word.
  const parts = q.split(/\s+/).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => words.some((w) => w.startsWith(p)))) return 70;
  // The initials: "ftp" for "Fit whole page".
  const initials = cmd.low.split(/\s+/).map((w) => w[0]).join('');
  if (q.length > 1 && initials.startsWith(q)) return 30;
  return 0;
}

function matches(text) {
  const q = text.trim().toLowerCase();
  if (!q) return COMMANDS.slice();
  const out = [];
  // A number is a page to go to.
  if (/^\d+$/.test(q) && state.doc) {
    const n = Math.min(Math.max(parseInt(q, 10), 1), state.pages.length);
    out.push({
      group: 'Go to', label: 'Go to page ' + n, icon: 'pages', key: 'of ' + state.pages.length,
      run: () => PS.goToPage(n), doc: true, rank: 1000
    });
  }
  for (const cmd of COMMANDS) {
    const s = score(cmd, q);
    if (s) out.push(Object.assign({ rank: s }, cmd));
  }
  return out.sort((a, b) => b.rank - a.rank);
}

function render() {
  const text = input.value;
  shown = matches(text);
  active = Math.min(active, Math.max(0, shown.length - 1));
  list.textContent = '';
  if (!shown.length) {
    const none = document.createElement('div');
    none.className = 'palette-empty';
    none.textContent = 'Nothing matches “' + text.trim() + '”.';
    list.appendChild(none);
    input.removeAttribute('aria-activedescendant');
    return;
  }
  // Unfiltered, the list is grouped; filtered, it is best match first.
  const grouped = !text.trim();
  let group = null;
  shown.forEach((cmd, i) => {
    if (grouped && cmd.group !== group) {
      group = cmd.group;
      const head = document.createElement('div');
      head.className = 'palette-group';
      head.textContent = group;
      list.appendChild(head);
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'palette-item';
    row.id = 'palette-item-' + i;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === active));
    row.tabIndex = -1;
    row.appendChild(PS.icon(cmd.icon));
    const label = document.createElement('span');
    label.textContent = cmd.label;
    row.appendChild(label);
    if (cmd.key) {
      const key = document.createElement('kbd');
      key.textContent = cmd.key;
      row.appendChild(key);
    }
    row.addEventListener('click', () => run(i));
    row.addEventListener('pointermove', () => { if (active !== i) { active = i; paint(); } });
    list.appendChild(row);
  });
  input.setAttribute('aria-activedescendant', 'palette-item-' + active);
}

function paint() {
  $$('.palette-item', list).forEach((row, i) => {
    const on = i === active;
    row.setAttribute('aria-selected', String(on));
    if (on) row.scrollIntoView({ block: 'nearest' });
  });
  input.setAttribute('aria-activedescendant', 'palette-item-' + active);
}

function isOpen() {
  return !wrap.classList.contains('hidden');
}

let returnTo = null;

function open() {
  if (isOpen()) return;
  PS.closeMenu();
  returnTo = document.activeElement;
  input.value = '';
  active = 0;
  wrap.classList.remove('hidden');
  render();
  input.focus();
}

function close() {
  if (!isOpen()) return;
  wrap.classList.add('hidden');
  if (returnTo && document.contains(returnTo) && returnTo.focus) returnTo.focus();
  returnTo = null;
}

function run(i) {
  const cmd = shown[i];
  if (!cmd) return;
  close();
  if (cmd.doc && !PS.needDoc()) return;
  cmd.run();
}

input.addEventListener('input', () => { active = 0; render(); });
wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
$('#btn-palette').addEventListener('click', open);

// Captured ahead of the editor's own shortcuts: while the palette is open the
// keys belong to it, and a letter typed into it must not pick a tool.
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    // Not over a question that is waiting for an answer.
    if ($$('#ask-modal, #pw-modal').some((m) => !m.classList.contains('hidden'))) return;
    e.preventDefault();
    e.stopPropagation();
    if (isOpen()) close(); else open();
    return;
  }
  if (!isOpen()) return;
  if (e.key === 'Tab') return;   // kept inside the palette by the editor's focus trap
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); close(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!shown.length) return;
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
    paint();
    return;
  }
  if (e.key === 'Enter') { e.preventDefault(); run(active); }
}, true);

PS.openPalette = open;

})();
