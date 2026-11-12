'use strict';
/* global PS, PSConvert, PSDocOps, PSCrypt, PSExtract */
/*
 * The Workbench (conversion, page operations, security, metadata) and the
 * side panels (thumbnails, bookmarks, form fields, notes).
 *
 * Every long-running job goes through `runJob`, which owns the progress bar,
 * error reporting and the result strip, so no individual handler has to.
 */
(function () {

const { $, $$, state, showBanner, formatBytes, parseRange, suffixName } = PS;

const hubModal = $('#hub-modal');
const hubProgress = $('#hub-progress');
const hubBar = $('#hub-bar');
const hubText = $('#hub-text');
const resultRow = $('#result-row');
const resultText = $('#result-text');
const btnResultLoad = $('#btn-result-load');
const btnResultDownload = $('#btn-result-download');

const hubNotes = $('#hub-notes');
const hubCancel = $('#hub-cancel');

let lastResult = null;   // { blob, filename, bytes? }

/* ------------------------------------------------------------------ *
 * Job plumbing
 * ------------------------------------------------------------------ */

function setProgress(done, total, label) {
  hubProgress.classList.remove('hidden');
  const pct = total ? Math.round((done / total) * 100) : 0;
  hubBar.style.width = Math.max(2, Math.min(100, pct)) + '%';
  hubBar.parentNode.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, pct))));
  hubText.textContent = label || (done + ' / ' + total);
}

/*
 * Stopping a job.
 *
 * Every long job reports its progress page by page, so the report is where it
 * is stopped: once Cancel has been pressed, the next report throws, and the
 * error travels back up through whatever converter was running. Nothing has
 * to be taught how to stop; it only has to say how far it has got.
 */
let cancelRequested = false;
let jobRunning = false;

function jobCancelled() {
  const err = new Error('Cancelled');
  err.name = 'JobCancelled';
  return err;
}

hubCancel.addEventListener('click', () => {
  if (!jobRunning) return;
  cancelRequested = true;
  hubCancel.disabled = true;
  hubText.textContent = 'Stopping…';
});

function showResult(payload) {
  lastResult = payload;
  const isPdf = /\.pdf$/i.test(payload.filename);
  btnResultLoad.classList.toggle('hidden', !isPdf || !payload.bytes);
  let text = 'Ready — ' + payload.filename + ' · ' + formatBytes(payload.blob.size);
  if (payload.compareTo) {
    const delta = 1 - payload.blob.size / payload.compareTo;
    if (delta > 0.01) text += ' · ' + Math.round(delta * 100) + '% smaller';
    else if (delta < -0.01) text += ' · ' + Math.round(-delta * 100) + '% larger';
  }
  if (payload.note) text += ' · ' + payload.note;
  resultText.textContent = text;
  resultRow.classList.remove('hidden');
}

/**
 * Run one Workbench action. `fn` receives a progress reporter and returns
 * either { blob, filename } or a Uint8Array of PDF bytes.
 */
async function runJob(button, label, fn, opts) {
  const options = opts || {};
  if (options.needDoc !== false && !state.doc) {
    showBanner('Open a PDF first.', 'info');
    return;
  }
  if (jobRunning) {
    showBanner('Something is still running — wait for it to finish, or cancel it.', 'info');
    return;
  }
  const original = button ? PS.buttonLabel(button) : '';
  if (button) { button.disabled = true; PS.buttonLabel(button, 'Working…'); }
  resultRow.classList.add('hidden');
  hubNotes.classList.add('hidden');
  jobRunning = true;
  cancelRequested = false;
  hubCancel.disabled = false;
  setProgress(0, 1, label);
  try {
    const result = await fn((done, total, text) => {
      if (cancelRequested) throw jobCancelled();
      setProgress(done, total, text || label);
    });
    if (cancelRequested) throw jobCancelled();
    if (!result) {
      hubProgress.classList.add('hidden');
      return;
    }
    if (result instanceof Uint8Array) {
      showResult({
        blob: new Blob([result], { type: 'application/pdf' }),
        bytes: result,
        filename: options.filename || suffixName(state.name, '-out'),
        compareTo: options.compare === false ? 0 : (state.bytes ? state.bytes.length : 0)
      });
    } else {
      showResult(Object.assign({ compareTo: options.compareTo || 0 }, result));
      // A conversion can succeed and still have lost something. Say so rather
      // than handing over a file that is quietly empty — and say it next to
      // the result, where it stays, not in a banner that is gone in seconds.
      if (result.warnings && result.warnings.length) {
        hubNotes.textContent = result.warnings.join(' ');
        hubNotes.classList.remove('hidden');
      }
    }
  } catch (err) {
    hubProgress.classList.add('hidden');
    if (err && (err.name === 'JobCancelled' || err.name === 'ExportCancelled')) {
      if (err.name === 'JobCancelled') showBanner(label + ' cancelled.', 'info');
    } else {
      showBanner(label + ' failed: ' + ((err && err.message) || String(err)));
    }
  } finally {
    jobRunning = false;
    if (button) { button.disabled = false; PS.buttonLabel(button, original); }
    // The bar has said what it had to; the result, or the error, takes over.
    hubProgress.classList.add('hidden');
  }
}

btnResultDownload.addEventListener('click', () => {
  if (lastResult) PS.downloadBlob(lastResult.blob, lastResult.filename);
});
btnResultLoad.addEventListener('click', async () => {
  if (!lastResult || !lastResult.bytes) return;
  if (state.dirty && !(await PS.confirmDialog({
    title: 'Load the result into the editor?',
    text: 'It replaces the document that is open. Changes you have not saved in that one will be lost.',
    ok: 'Load it',
    danger: true
  }))) return;
  PS.closeModal(hubModal);
  // It exists only in this tab until it is saved.
  await PS.loadBytes(lastResult.bytes, lastResult.filename, { dirty: true });
});

/* ------------------------------------------------------------------ *
 * Workbench shell
 * ------------------------------------------------------------------ */

/*
 * The Tools drawer.
 *
 * It sits beside the document rather than over it, and has two views: the
 * list of everything it can do, and one task at a time with a way back. A
 * job's progress and its result stay pinned to the foot in both.
 */
const hubTitle = $('#hub-title');

/** Show the list of tools. */
function showHubHome() {
  hubModal.dataset.view = 'home';
  hubTitle.textContent = 'Tools';
  for (const link of $$('.hub-link')) link.classList.remove('active');
  for (const pane of $$('.hub-pane')) pane.classList.add('hidden');
}

/** Show one task. */
function showHubPane(id) {
  let title = 'Tools';
  for (const link of $$('.hub-link')) {
    const on = link.dataset.hub === id;
    link.classList.toggle('active', on);
    if (on) title = link.dataset.title || title;
  }
  for (const pane of $$('.hub-pane')) pane.classList.toggle('hidden', pane.id !== id);
  hubModal.dataset.view = 'task';
  hubTitle.textContent = title;
  $('.hub', hubModal).scrollTop = 0;
}

/** Open the drawer, on a task if one is named and on the list if not. */
function openHub(pane) {
  PS.openModal(hubModal);
  if (pane && $('#' + pane)) showHubPane(pane);
  else if (hubModal.dataset.view !== 'task') showHubHome();
  loadMetadataIntoForm();
}

$('#btn-workbench').addEventListener('click', () => {
  if (!hubModal.classList.contains('hidden')) { PS.closeModal(hubModal); return; }
  if (!PS.needDoc()) return;
  openHub();
});
$('#hub-close').addEventListener('click', () => PS.closeModal(hubModal));
$('#hub-back').addEventListener('click', showHubHome);
for (const link of $$('.hub-link')) {
  link.addEventListener('click', () => showHubPane(link.dataset.hub));
}

// "Make a PDF" needs no open document, so it can be reached straight away.
$('#btn-create-from').addEventListener('click', () => openHub('hub-create'));

/*
 * The other quick starts on the empty page need a document first: they ask
 * for one, and the task opens as soon as it has loaded.
 */
let pendingPane = null;
function startWith(pane) {
  if (state.doc) { openHub(pane); return; }
  pendingPane = pane;
  $('#pdf-input').click();
}
$('#quick-convert').addEventListener('click', () => startWith('hub-convert'));
$('#quick-merge').addEventListener('click', () => startWith('hub-organise'));

/* live value readouts for the sliders */
const READOUTS = [
  ['pptx-dpi', 'pptx-dpi-v'], ['img-dpi', 'img-dpi-v'], ['img-quality', 'img-quality-v'],
  ['cmp-dpi', 'cmp-dpi-v'], ['cmp-quality', 'cmp-quality-v'],
  ['wm-size', 'wm-size-v'], ['wm-opacity', 'wm-opacity-v'], ['wm-rotation', 'wm-rotation-v']
];
for (const [input, out] of READOUTS) {
  const el = $('#' + input);
  const label = $('#' + out);
  if (el && label) el.addEventListener('input', () => { label.textContent = el.value; });
}

/* ------------------------------------------------------------------ *
 * Convert from PDF
 * ------------------------------------------------------------------ */

let convertFormat = 'docx';
const FORMAT_OPTIONS = {
  docx: 'opt-docx', xlsx: 'opt-xlsx', pptx: 'opt-pptx',
  images: 'opt-images', html: 'opt-html', json: 'opt-json'
};

function selectFormat(format) {
  convertFormat = format;
  for (const b of $$('.fmt')) b.classList.toggle('active', b.dataset.format === format);
  const wanted = FORMAT_OPTIONS[format];
  for (const id of Object.values(FORMAT_OPTIONS)) {
    const el = $('#' + id);
    if (el) el.classList.toggle('hidden', id !== wanted);
  }
}
for (const b of $$('.fmt')) {
  b.addEventListener('click', () => selectFormat(b.dataset.format));
}
selectFormat('docx');

function convertOptions() {
  const pages = parseRange($('#convert-range').value, state.doc.numPages);
  const base = {
    filename: state.name,
    dropRunning: $('#convert-running').checked,
    pages: pages || [],
    // OCR only ever fires on a page that has no text at all, so leaving it on
    // costs an ordinary document nothing.
    ocr: $('#ocr-enable').checked,
    ocrLangs: $('#ocr-langs').value,
    ocrDpi: parseInt($('#ocr-dpi').value, 10) || 200
  };
  if (convertFormat === 'docx') {
    return Object.assign(base, {
      mode: $('#docx-mode').value,
      tables: $('#docx-tables').checked,
      background: $('#docx-background').checked
    });
  }
  if (convertFormat === 'xlsx') {
    return Object.assign(base, {
      mode: $('#xlsx-mode').value,
      numbers: $('#xlsx-numbers').checked
    });
  }
  if (convertFormat === 'pptx') {
    return Object.assign(base, {
      mode: $('#pptx-mode').value,
      dpi: parseInt($('#pptx-dpi').value, 10) || 130
    });
  }
  if (convertFormat === 'images') {
    return Object.assign(base, {
      format: $('#img-format').value,
      dpi: parseInt($('#img-dpi').value, 10) || 150,
      quality: (parseInt($('#img-quality').value, 10) || 90) / 100
    });
  }
  if (convertFormat === 'html') {
    return Object.assign(base, {
      mode: $('#html-mode').value,
      background: $('#html-background').checked
    });
  }
  if (convertFormat === 'json') {
    return Object.assign(base, { items: $('#json-items').checked });
  }
  return base;
}

$('#btn-convert-run').addEventListener('click', (e) => {
  runJob(e.currentTarget, 'Conversion', async (report) => {
    // Convert what is on screen, edits included, rather than the file on disk.
    let bytes = state.bytes;
    if (state.objects.length) {
      report(0, 1, 'Baking in your edits');
      bytes = await PS.exportAnnotated();
    }
    /*
     * The conversion reads from a copy of the document opened for it alone.
     * It can then draw pages without their text — for the exports that put
     * real text over a picture of the page — and it never competes with, or
     * clears the caches of, the pages being shown. A document that is still
     * encrypted cannot be opened a second time without its password, so that
     * one is read through the copy already open.
     */
    let source = state.doc;
    let own = null;
    if (!state.locked) {
      own = await PSExtract.openDocument(bytes.slice());
      source = own;
    }
    try {
      const options = Object.assign(convertOptions(), { onProgress: report });
      return await PSConvert.convertFromPdf(source, convertFormat, options);
    } finally {
      if (own) { try { own.destroy(); } catch (err) { /* ignore */ } }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Create a PDF from other files
 * ------------------------------------------------------------------ */

function createOptions() {
  return {
    pageSize: $('#create-size').value,
    orientation: $('#create-orientation').value,
    margin: parseFloat($('#create-margin').value) || 0
  };
}

$('#btn-from-images').addEventListener('click', () => $('#images-pdf-input').click());
$('#images-pdf-input').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  runJob($('#btn-from-images'), 'Images to PDF', async (report) => {
    const opts = Object.assign(createOptions(), {
      filename: files.length === 1 ? files[0].name : 'images',
      onProgress: report
    });
    const res = await PSConvert.imagesToPdf(files, opts);
    return res;
  }, { needDoc: false });
});

$('#btn-from-office').addEventListener('click', () => $('#office-input').click());
$('#office-input').addEventListener('change', (e) => {
  const file = (e.target.files || [])[0];
  e.target.value = '';
  if (!file) return;
  runJob($('#btn-from-office'), 'Office to PDF', async (report) => {
    report(0, 1, 'Reading ' + file.name);
    if (/\.docx$/i.test(file.name)) {
      return PSConvert.docxToPdf(file, createOptions());
    }
    if (/\.(xlsx|xls|csv)$/i.test(file.name)) {
      return PSConvert.spreadsheetToPdf(file, Object.assign(createOptions(), {
        orientation: $('#create-orientation').value === 'portrait' ? 'portrait' : 'landscape',
        pageSize: $('#create-size').value === 'fit' ? 'A4' : $('#create-size').value
      }));
    }
    throw new Error('Choose a .docx, .xlsx, .xls or .csv file.');
  }, { needDoc: false });
});

$('#btn-from-text').addEventListener('click', () => $('#text-input').click());
$('#text-input').addEventListener('change', (e) => {
  const file = (e.target.files || [])[0];
  e.target.value = '';
  if (!file) return;
  runJob($('#btn-from-text'), 'Text to PDF', async (report) => {
    report(0, 1, 'Reading ' + file.name);
    const text = await file.text();
    return PSConvert.textToPdf(text, Object.assign(createOptions(), {
      filename: file.name,
      pageSize: $('#create-size').value === 'fit' ? 'A4' : $('#create-size').value
    }));
  }, { needDoc: false });
});

/* ------------------------------------------------------------------ *
 * Merge & split
 * ------------------------------------------------------------------ */

const mergeFiles = [];

function renderMergeList() {
  const list = $('#merge-list');
  list.textContent = '';
  const first = document.createElement('li');
  first.innerHTML = '<b>1.</b> ' + escapeText(state.name || 'the open document') +
    ' <span class="fsize">(open document)</span>';
  list.appendChild(first);
  mergeFiles.forEach((file, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<b>' + (i + 2) + '.</b> ' + escapeText(file.name) +
      ' <span class="fsize">' + formatBytes(file.size) + '</span>';
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const up = document.createElement('button');
    up.className = 'icon-btn sm';
    up.setAttribute('aria-label', 'Move ' + file.name + ' up');
    up.appendChild(PS.icon('arrow-up', 'sm'));
    up.disabled = i === 0;
    up.addEventListener('click', () => {
      const t = mergeFiles[i - 1];
      mergeFiles[i - 1] = mergeFiles[i];
      mergeFiles[i] = t;
      renderMergeList();
    });
    const remove = document.createElement('button');
    remove.className = 'icon-btn sm danger';
    remove.setAttribute('aria-label', 'Remove ' + file.name);
    remove.appendChild(PS.icon('x', 'sm'));
    remove.addEventListener('click', () => { mergeFiles.splice(i, 1); renderMergeList(); });
    li.appendChild(spacer);
    li.appendChild(up);
    li.appendChild(remove);
    list.appendChild(li);
  });
  $('#btn-merge-run').disabled = mergeFiles.length === 0;
}

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

$('#btn-merge-add').addEventListener('click', () => $('#merge-input').click());
$('#merge-input').addEventListener('change', (e) => {
  for (const f of Array.from(e.target.files || [])) mergeFiles.push(f);
  e.target.value = '';
  renderMergeList();
});

$('#btn-merge-run').addEventListener('click', (e) => {
  runJob(e.currentTarget, 'Merge', async (report) => {
    report(0, mergeFiles.length + 1, 'Preparing');
    const sources = [{ bytes: await PS.exportAnnotated() }];
    for (let i = 0; i < mergeFiles.length; i++) {
      sources.push({ bytes: new Uint8Array(await mergeFiles[i].arrayBuffer()) });
      report(i + 1, mergeFiles.length + 1, 'Reading ' + mergeFiles[i].name);
    }
    report(mergeFiles.length + 1, mergeFiles.length + 1, 'Merging');
    return PSDocOps.mergeDocuments(sources, { title: 'Merged document' });
  }, { filename: suffixName(state.name, '-merged'), compare: false });
});

$('#split-mode').addEventListener('change', () => {
  const mode = $('#split-mode').value;
  $('#split-size-wrap').classList.toggle('hidden', mode !== 'every');
  $('#split-at-wrap').classList.toggle('hidden', mode !== 'at');
});

$('#btn-split-run').addEventListener('click', (e) => {
  runJob(e.currentTarget, 'Split', async (report) => {
    const bytes = await PS.exportAnnotated();
    const boundaries = ($('#split-at').value || '')
      .split(/[,;\s]+/)
      .map((s) => parseInt(s, 10) - 1)
      .filter((n) => !isNaN(n) && n > 0);
    return PSDocOps.splitDocument(bytes, {
      mode: $('#split-mode').value,
      size: parseInt($('#split-size').value, 10) || 2,
      boundaries,
      baseName: state.name.replace(/\.pdf$/i, ''),
      onProgress: (i, n) => report(i, n, 'Part ' + i + ' of ' + n)
    });
  });
});

/* ------------------------------------------------------------------ *
 * Page layout
 * ------------------------------------------------------------------ */

$('#page-preset').addEventListener('change', () => {
  $('#page-scale-wrap').classList.toggle('hidden', $('#page-preset').value !== 'pct');
});

$('#btn-page-run').addEventListener('click', (e) => {
  runJob(e.currentTarget, 'Resize', async (report) => {
    report(0, 2, 'Baking in your edits');
    const base = await PS.exportAnnotated();
    report(1, 2, 'Resizing');
    const pct = PS.clamp(parseFloat($('#page-scale').value) || 100, 10, 400);
    return PSDocOps.resizePages(base, $('#page-preset').value, pct);
  }, { filename: suffixName(state.name, '-resized') });
});

$('#btn-nup-run').addEventListener('click', (e) => {
  runJob(e.currentTarget, 'Imposition', async (report) => {
    report(0, 1, 'Arranging pages');
    const base = await PS.exportAnnotated();
    return PSDocOps.nUp(base, {
      perSheet: parseInt($('#nup-count').value, 10) || 2,
      pageSize: $('#nup-size').value,
      border: $('#nup-border').checked
    });
  }, { filename: suffixName(state.name, '-nup') });
});

$('#btn-crop-run').addEventListener('click', (e) => {
  runJob(e.currentTarget, 'Crop', async (report) => {
    const top = (parseFloat($('#crop-top').value) || 0) / 100;
    const bottom = (parseFloat($('#crop-bottom').value) || 0) / 100;
    const left = (parseFloat($('#crop-left').value) || 0) / 100;
    const right = (parseFloat($('#crop-right').value) || 0) / 100;
    if (top + bottom >= 0.95 || left + right >= 0.95) {
      throw new Error('Those margins would leave nothing on the page.');
    }
    report(0, 1, 'Cropping');
    const base = await PS.exportAnnotated();
    return PSDocOps.cropPages(base, {
      top, left,
      width: 1 - left - right,
      height: 1 - top - bottom,
      hard: $('#crop-hard').checked
    });
  }, { filename: suffixName(state.name, '-cropped') });
});

$('#btn-reverse').addEventListener('click', (e) => {
  runJob(e.currentTarget, 'Reverse', async () => {
    const base = await PS.exportAnnotated();
    return PSDocOps.reversePages(base);
  }, { filename: suffixName(state.name, '-reversed') });
});

$('#btn-rotate-all').addEventListener('click', (e) => {
  runJob(e.currentTarget, 'Rotate', async () => {
    const base = await PS.exportAnnotated();
    return PSDocOps.rotatePages(base, null, 90);
  }, { filename: suffixName(state.name, '-rotated') });
});

/* ------------------------------------------------------------------ *
 * Watermark, headers and footers
 * ------------------------------------------------------------------ */

let watermarkImage = null;

$('#wm-type').addEventListener('change', () => {
  const isImage = $('#wm-type').value === 'image';
  $('#wm-text-wrap').classList.toggle('hidden', isImage);
  $('#wm-image-btn').classList.toggle('hidden', !isImage);
});
$('#wm-image-btn').addEventListener('click', () => $('#wm-image-input').click());
$('#wm-image-input').addEventListener('change', (e) => {
  const file = (e.target.files || [])[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    watermarkImage = reader.result;
    $('#wm-image-btn').textContent = file.name.slice(0, 22);
  };
  reader.readAsDataURL(file);
});

$('#btn-wm-run').addEventListener('click', (e) => {
  runJob(e.currentTarget, 'Watermark', async (report) => {
    report(0, 1, 'Stamping pages');
    const base = await PS.exportAnnotated();
    return PSDocOps.addWatermark(base, {
      type: $('#wm-type').value,
      text: $('#wm-text').value,
      imageData: watermarkImage,
      color: $('#wm-color').value,
      fontSize: parseInt($('#wm-size').value, 10) || 54,
      opacity: (parseInt($('#wm-opacity').value, 10) || 18) / 100,
      rotation: parseInt($('#wm-rotation').value, 10) || 0,
      position: $('#wm-position').value,
      tile: $('#wm-tile').checked,
      behind: $('#wm-behind').checked,
      scale: 0.45,
      pages: parseRange($('#wm-range').value, state.doc.numPages) || []
    });
  }, { filename: suffixName(state.name, '-watermarked') });
});

$('#btn-hf-run').addEventListener('click', (e) => {
  runJob(e.currentTarget, 'Headers and footers', async (report) => {
    report(0, 1, 'Numbering pages');
    const base = await PS.exportAnnotated();
    return PSDocOps.addHeaderFooter(base, {
      header: {
        left: $('#hf-h-left').value,
        center: $('#hf-h-center').value,
        right: $('#hf-h-right').value
      },
      footer: {
        left: $('#hf-f-left').value,
        center: $('#hf-f-center').value,
        right: $('#hf-f-right').value
      },
      fontSize: parseFloat($('#hf-size').value) || 9,
      color: $('#hf-color').value,
      margin: parseFloat($('#hf-margin').value) || 28,
      startNumber: parseInt($('#hf-start').value, 10) || 1,
      skipFirst: $('#hf-skip-first').checked,
      filename: state.name,
      bates: {
        prefix: $('#hf-bates-prefix').value,
        start: parseInt($('#hf-bates-start').value, 10) || 1,
        digits: parseInt($('#hf-bates-digits').value, 10) || 6
      }
    });
  }, { filename: suffixName(state.name, '-numbered') });
});

/* ------------------------------------------------------------------ *
 * Resize & compress
 * ------------------------------------------------------------------ */

$('#cmp-lossless').addEventListener('change', () => {
  $('#cmp-lossy').classList.toggle('hidden', $('#cmp-lossless').checked);
});
$('#cmp-preset').addEventListener('change', () => {
  const custom = $('#cmp-preset').value === 'custom';
  $('#cmp-custom-dpi').classList.toggle('hidden', !custom);
  $('#cmp-custom-q').classList.toggle('hidden', !custom);
  if (!custom) {
    const [dpi, quality] = $('#cmp-preset').value.split(',');
    $('#cmp-dpi').value = dpi;
    $('#cmp-quality').value = Math.round(parseFloat(quality) * 100);
    $('#cmp-dpi-v').textContent = dpi;
    $('#cmp-quality-v').textContent = $('#cmp-quality').value;
  }
});

$('#btn-cmp-run').addEventListener('click', (e) => {
  runJob(e.currentTarget, 'Compression', async (report) => {
    report(0, 1, 'Baking in your edits');
    const base = await PS.exportAnnotated();
    if ($('#cmp-lossless').checked) {
      report(1, 2, 'Re-saving');
      return PSDocOps.resaveLossless(base);
    }
    let dpi, quality;
    if ($('#cmp-preset').value === 'custom') {
      dpi = parseInt($('#cmp-dpi').value, 10) || 120;
      quality = (parseInt($('#cmp-quality').value, 10) || 75) / 100;
    } else {
      const parts = $('#cmp-preset').value.split(',');
      dpi = parseFloat(parts[0]);
      quality = parseFloat(parts[1]);
    }
    return PSDocOps.rasterizePages(base, {
      dpi,
      quality,
      onProgress: (i, n) => report(i, n, 'Page ' + i + ' of ' + n)
    });
  }, { filename: suffixName(state.name, '-compressed') });
});

/* ------------------------------------------------------------------ *
 * Metadata and attachments
 * ------------------------------------------------------------------ */

async function loadMetadataIntoForm() {
  if (!state.bytes) return;
  try {
    const meta = await PSDocOps.getMetadata(state.bytes);
    $('#meta-title').value = meta.title;
    $('#meta-author').value = meta.author;
    $('#meta-subject').value = meta.subject;
    $('#meta-keywords').value = meta.keywords;
    $('#meta-creator').value = meta.creator;
    $('#meta-producer').value = meta.producer;
  } catch (err) { /* a document without metadata just leaves the form empty */ }
}
$('#btn-meta-load').addEventListener('click', loadMetadataIntoForm);

$('#btn-meta-save').addEventListener('click', (e) => {
  runJob(e.currentTarget, 'Metadata', async () => {
    const base = await PS.exportAnnotated();
    return PSDocOps.setMetadata(base, {
      title: $('#meta-title').value,
      author: $('#meta-author').value,
      subject: $('#meta-subject').value,
      keywords: $('#meta-keywords').value,
      creator: $('#meta-creator').value,
      producer: $('#meta-producer').value
    });
  }, { filename: state.name });
});

$('#btn-attach-add').addEventListener('click', () => $('#attach-input').click());
$('#attach-input').addEventListener('change', (e) => {
  const file = (e.target.files || [])[0];
  e.target.value = '';
  if (!file) return;
  runJob($('#btn-attach-add'), 'Attachment', async () => {
    const base = await PS.exportAnnotated();
    return PSDocOps.addAttachment(base, file);
  }, { filename: suffixName(state.name, '-with-attachment') });
});

$('#btn-attach-list').addEventListener('click', async () => {
  const list = $('#attach-list');
  list.textContent = '';
  try {
    const items = await PSDocOps.listAttachments(state.bytes);
    if (!items.length) {
      const li = document.createElement('li');
      li.textContent = 'No attachments in this document.';
      list.appendChild(li);
      return;
    }
    for (const item of items) {
      const li = document.createElement('li');
      li.innerHTML = escapeText(item.name) + ' <span class="fsize">' + formatBytes(item.size) + '</span>';
      const spacer = document.createElement('span');
      spacer.className = 'spacer';
      const save = document.createElement('button');
      save.className = 'mini';
      save.textContent = 'Save';
      save.addEventListener('click', () => {
        PS.downloadBlob(new Blob([item.data]), item.name || 'attachment');
      });
      li.appendChild(spacer);
      li.appendChild(save);
      list.appendChild(li);
    }
  } catch (err) {
    showBanner('Could not read the attachments: ' + ((err && err.message) || err));
  }
});

/* ------------------------------------------------------------------ *
 * Security
 * ------------------------------------------------------------------ */

function collectPermissions() {
  const out = {};
  for (const key of Object.keys(PSCrypt.PERM_BITS)) {
    const box = $('#perm-' + key);
    out[key] = box ? box.checked : true;
  }
  return out;
}

$('#btn-encrypt-run').addEventListener('click', (e) => {
  const userPw = $('#sec-user-pw').value;
  const ownerPw = $('#sec-owner-pw').value;
  if (!userPw && !ownerPw) {
    showBanner('Enter an open password, an owner password, or both.', 'info');
    return;
  }
  runJob(e.currentTarget, 'Encryption', async (report) => {
    report(0, 1, 'Encrypting');
    const base = await PS.exportAnnotated();
    const bytes = await PSCrypt.addPassword(base, {
      userPassword: userPw,
      ownerPassword: ownerPw,
      scheme: $('#sec-scheme').value,
      permissions: collectPermissions()
    });
    $('#sec-user-pw').value = '';
    $('#sec-owner-pw').value = '';
    return {
      blob: new Blob([bytes], { type: 'application/pdf' }),
      filename: suffixName(state.name, '-protected'),
      note: 'keep the password somewhere safe — it cannot be recovered'
    };
  });
});

$('#btn-decrypt-run').addEventListener('click', (e) => {
  const password = $('#sec-remove-pw').value;
  runJob(e.currentTarget, 'Password removal', async (report) => {
    report(0, 1, 'Checking the password');
    let bytes;
    try {
      bytes = await PSCrypt.removePassword(state.bytes, password);
    } catch (err) {
      const message = (err && err.message) || '';
      if (message === 'WRONG_PASSWORD') {
        throw new Error('that password does not open this document.');
      }
      if (message !== 'UNSUPPORTED_STRUCTURE') throw err;
      // The file's object layout cannot be rewritten in place. The document is
      // already open and decrypted in pdf.js, so rebuild it from those pages
      // rather than trying to parse the encrypted bytes again.
      if (!(await PS.confirmDialog({
        title: 'Rebuild this file to unlock it?',
        text: 'It cannot be unlocked as it is. PDF Studio can re-create it from the pages as ' +
          'they are displayed: the result opens without a password, but its text becomes part ' +
          'of the page picture and stops being selectable.',
        ok: 'Rebuild it'
      }))) return null;
      report(0, 1, 'Rebuilding pages');
      bytes = await PSDocOps.rebuildFromDocument(state.doc, {
        dpi: 200,
        quality: 0.94,
        onProgress: (i, n) => report(i, n, 'Page ' + i + ' of ' + n)
      });
    }
    $('#sec-remove-pw').value = '';
    return bytes;
  }, { filename: suffixName(state.name, '-unlocked') });
});

$('#btn-sanitize-run').addEventListener('click', (e) => {
  runJob(e.currentTarget, 'Clean-up', async (report) => {
    report(0, 1, 'Removing active content');
    const base = await PS.exportAnnotated();
    const result = await PSDocOps.sanitize(base);
    return {
      blob: new Blob([result.bytes], { type: 'application/pdf' }),
      bytes: result.bytes,
      filename: suffixName(state.name, '-clean'),
      note: result.removed.length ? 'removed: ' + result.removed.join(', ') : 'nothing active was found'
    };
  });
});

$('#btn-flatten-run').addEventListener('click', (e) => {
  runJob(e.currentTarget, 'Flatten', async () => {
    const base = await PS.exportAnnotated();
    return PSDocOps.flattenForm(base);
  }, { filename: suffixName(state.name, '-flattened') });
});

/* ------------------------------------------------------------------ *
 * Sidebar — page thumbnails and the organiser
 * ------------------------------------------------------------------ */

const thumbsEl = $('#thumbs');
let thumbObserver = null;

function ensurePlan() {
  if (!state.pagePlan) {
    state.pagePlan = state.pages.map((p) => ({ source: p.index, rotate: 0 }));
  }
  return state.pagePlan;
}

function planDirty() {
  const plan = state.pagePlan;
  if (!plan) return false;
  if (plan.length !== state.pages.length) return true;
  return plan.some((step, i) => step.blank || step.source !== i || step.rotate);
}

function refreshApplyButton() {
  $('#pg-apply').disabled = !planDirty();
}

async function buildThumbnails() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbsEl.textContent = '';
  state.selectedPages = new Set();
  state.pagePlan = null;
  refreshApplyButton();
  if (!state.doc) return;

  const plan = ensurePlan();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) renderThumb(entry.target);
    }
  }, { root: thumbsEl, rootMargin: '300px 0px' });

  plan.forEach((step, position) => {
    thumbsEl.appendChild(makeThumb(step, position));
  });
  for (const el of $$('.thumb', thumbsEl)) thumbObserver.observe(el);
}

function makeThumb(step, position) {
  const el = document.createElement('div');
  el.className = 'thumb';
  el.dataset.index = step.blank ? '' : step.source;
  el.dataset.position = position;
  el.draggable = true;

  const canvas = document.createElement('canvas');
  canvas.width = 10;
  canvas.height = 14;
  el.appendChild(canvas);

  const label = document.createElement('div');
  label.className = 'tnum';
  const num = document.createElement('span');
  num.textContent = step.blank ? 'blank' : 'Page ' + (position + 1);
  label.appendChild(num);
  if (step.rotate) {
    const flag = document.createElement('span');
    flag.className = 'tflag';
    flag.textContent = ((step.rotate % 360) + 360) % 360 + '°';
    label.appendChild(flag);
  }
  el.appendChild(label);

  el.addEventListener('click', (e) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      toggleThumbSelection(position);
    } else {
      state.selectedPages = new Set([position]);
      syncThumbSelection();
      if (!step.blank) PS.goToPage(step.source + 1);
    }
  });

  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(position));
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    for (const t of $$('.thumb')) t.classList.remove('drop-before', 'drop-after');
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    el.classList.toggle('drop-after', after);
    el.classList.toggle('drop-before', !after);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
    const rect = el.getBoundingClientRect();
    let to = position + (e.clientY > rect.top + rect.height / 2 ? 1 : 0);
    el.classList.remove('drop-before', 'drop-after');
    if (isNaN(from) || from === to) return;
    const plan = ensurePlan();
    const [moved] = plan.splice(from, 1);
    if (from < to) to--;
    plan.splice(to, 0, moved);
    redrawThumbs();
  });

  return el;
}

function redrawThumbs() {
  const plan = ensurePlan();
  const scrollTop = thumbsEl.scrollTop;
  if (thumbObserver) thumbObserver.disconnect();
  thumbsEl.textContent = '';
  plan.forEach((step, position) => thumbsEl.appendChild(makeThumb(step, position)));
  if (thumbObserver) for (const el of $$('.thumb', thumbsEl)) thumbObserver.observe(el);
  thumbsEl.scrollTop = scrollTop;
  syncThumbSelection();
  refreshApplyButton();
}

function toggleThumbSelection(position) {
  if (state.selectedPages.has(position)) state.selectedPages.delete(position);
  else state.selectedPages.add(position);
  syncThumbSelection();
}

function syncThumbSelection() {
  for (const el of $$('.thumb', thumbsEl)) {
    el.classList.toggle('selected', state.selectedPages.has(Number(el.dataset.position)));
  }
}

async function renderThumb(el) {
  if (el.dataset.rendered === '1') return;
  el.dataset.rendered = '1';
  const position = Number(el.dataset.position);
  const step = ensurePlan()[position];
  if (!step || step.blank) return;
  const p = state.pages[step.source];
  if (!p) return;
  const canvas = el.querySelector('canvas');
  const targetW = Math.max(80, thumbsEl.clientWidth - 40);
  // Drawn for the screen's density, so a thumbnail is not a blur on a
  // high-resolution display.
  const scale = (targetW / p.viewport1.width) * Math.min(window.devicePixelRatio || 1, 2);
  const vp = p.page.getViewport({ scale, rotation: (p.viewport1.rotation + (step.rotate || 0)) % 360 });
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  try {
    await p.page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  } catch (err) {
    el.dataset.rendered = '';
  }
}

function selectedPositions() {
  return state.selectedPages.size
    ? Array.from(state.selectedPages).sort((a, b) => a - b)
    : ensurePlan().map((_, i) => i);
}

$('#pg-select-all').addEventListener('click', () => {
  state.selectedPages = new Set(ensurePlan().map((_, i) => i));
  syncThumbSelection();
});
$('#pg-select-none').addEventListener('click', () => {
  state.selectedPages = new Set();
  syncThumbSelection();
});

function rotateSelection(delta) {
  const plan = ensurePlan();
  for (const position of selectedPositions()) {
    plan[position].rotate = (((plan[position].rotate || 0) + delta) % 360 + 360) % 360;
  }
  redrawThumbs();
}
$('#pg-rot-left').addEventListener('click', () => rotateSelection(-90));
$('#pg-rot-right').addEventListener('click', () => rotateSelection(90));

$('#pg-duplicate').addEventListener('click', () => {
  const plan = ensurePlan();
  const positions = selectedPositions().sort((a, b) => b - a);
  for (const position of positions) {
    plan.splice(position + 1, 0, Object.assign({}, plan[position]));
  }
  state.selectedPages = new Set();
  redrawThumbs();
});

$('#pg-delete').addEventListener('click', () => {
  const plan = ensurePlan();
  const positions = new Set(selectedPositions());
  if (positions.size >= plan.length) {
    showBanner('At least one page has to remain.', 'info');
    return;
  }
  state.pagePlan = plan.filter((_, i) => !positions.has(i));
  state.selectedPages = new Set();
  redrawThumbs();
});

$('#pg-insert-blank').addEventListener('click', () => {
  const plan = ensurePlan();
  const at = state.selectedPages.size ? Math.max(...state.selectedPages) + 1 : plan.length;
  const reference = state.pages[0];
  plan.splice(at, 0, {
    blank: true,
    width: reference ? reference.viewport1.width : 595.28,
    height: reference ? reference.viewport1.height : 841.89
  });
  state.selectedPages = new Set();
  redrawThumbs();
});

$('#pg-extract').addEventListener('click', () => {
  if (!state.selectedPages.size) {
    showBanner('Select the pages to extract first — click a thumbnail, Ctrl+click for more.', 'info');
    return;
  }
  const plan = ensurePlan();
  const sources = selectedPositions()
    .map((position) => plan[position])
    .filter((step) => !step.blank)
    .map((step) => step.source);
  openHub();   // the result appears at the foot of the drawer
  runJob($('#pg-extract'), 'Extract', async () => {
    const base = await PS.exportAnnotated();
    return PSDocOps.extractPages(base, sources);
  }, { filename: suffixName(state.name, '-extract') });
});

$('#pg-apply').addEventListener('click', async () => {
  if (!planDirty()) return;
  if (state.objects.length && !(await PS.confirmDialog({
    title: 'Apply the page changes?',
    text: 'Your annotations are baked into the document first, so they can no longer be ' +
      'moved or edited one by one — and this step cannot be undone.',
    ok: 'Apply'
  }))) return;
  const button = $('#pg-apply');
  button.disabled = true;
  const original = PS.buttonLabel(button);
  PS.buttonLabel(button, 'Applying…');
  try {
    const base = await PS.exportAnnotated();
    const bytes = await PSDocOps.applyPagePlan(base, state.pagePlan);
    await PS.loadBytes(bytes, state.name, { dirty: true });
    showBanner('Page changes applied. Use "Save PDF" to keep them.', 'ok');
  } catch (err) {
    showBanner('Could not apply the page changes: ' + ((err && err.message) || err));
  }
  PS.buttonLabel(button, original);
  refreshApplyButton();
});

/* ------------------------------------------------------------------ *
 * Sidebar — bookmarks
 * ------------------------------------------------------------------ */

async function buildOutline() {
  const el = $('#outline');
  el.textContent = '';
  if (!state.doc) return;
  let items = [];
  try {
    items = await PSDocOps.readOutline(state.doc);
  } catch (err) { /* documents without an outline are common */ }
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'tiny muted pad';
    p.textContent = 'No bookmarks in this document.';
    el.appendChild(p);
    return;
  }
  for (const item of items) {
    const b = document.createElement('button');
    b.className = 'outline-item';
    b.style.paddingLeft = (8 + item.depth * 12) + 'px';
    b.style.fontWeight = item.bold ? '650' : '400';
    b.style.fontStyle = item.italic ? 'italic' : 'normal';
    b.textContent = item.title;
    if (item.pageIndex != null) {
      b.title = 'Page ' + (item.pageIndex + 1);
      b.addEventListener('click', () => PS.goToPage(item.pageIndex + 1));
    } else {
      b.disabled = true;
    }
    el.appendChild(b);
  }
}

/* ------------------------------------------------------------------ *
 * Sidebar — form fields
 * ------------------------------------------------------------------ */

let formFields = [];

async function buildFields() {
  const el = $('#fields');
  el.textContent = '';
  formFields = [];
  if (!state.bytes) return;
  let result;
  try {
    result = await PSDocOps.readForm(state.bytes);
  } catch (err) {
    result = { fields: [] };
  }
  if (!result.fields.length) {
    const p = document.createElement('p');
    p.className = 'tiny muted pad';
    p.textContent = 'This document has no fillable form fields.';
    el.appendChild(p);
    return;
  }
  formFields = result.fields;
  for (const field of result.fields) {
    const row = document.createElement('div');
    row.className = 'field-row';
    const name = document.createElement('div');
    name.className = 'fname';
    name.textContent = field.name + (field.readOnly ? ' (read only)' : '');
    row.appendChild(name);

    let input;
    if (field.kind === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!field.value;
    } else if (field.options && field.options.length) {
      input = document.createElement('select');
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '—';
      input.appendChild(blank);
      for (const option of field.options) {
        const o = document.createElement('option');
        o.value = option;
        o.textContent = option;
        input.appendChild(o);
      }
      input.value = field.value || '';
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = field.value == null ? '' : String(field.value);
    }
    input.disabled = field.readOnly || field.kind === 'signature' || field.kind === 'button';
    input.dataset.field = field.name;
    input.dataset.kind = field.kind;
    row.appendChild(input);
    el.appendChild(row);
  }
}

function collectFieldValues() {
  const values = {};
  for (const input of $$('#fields [data-field]')) {
    values[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
  }
  return values;
}

$('#fields-reload').addEventListener('click', buildFields);

/**
 * Filling reloads the document, which clears the annotation layer, so the
 * annotations are baked in first — same bargain as applying page changes.
 */
async function applyFieldValues(flatten) {
  if (!formFields.length) return;
  if (state.objects.length && !(await PS.confirmDialog({
    title: flatten ? 'Flatten the form?' : 'Apply the form values?',
    text: 'Your annotations are baked into the document first, so they can no longer be ' +
      'moved or edited one by one — and this step cannot be undone.',
    ok: flatten ? 'Flatten' : 'Apply'
  }))) return;
  try {
    const base = await PS.exportAnnotated();
    const result = await PSDocOps.fillForm(base, collectFieldValues(), { flatten });
    await PS.loadBytes(result.bytes, state.name, { dirty: true });
    if (result.problems.length) {
      showBanner('Filled, with problems: ' + result.problems.join('; '));
    } else {
      showBanner(flatten
        ? 'Form flattened into the page content. Use "Save PDF" to keep it.'
        : 'Form values applied. Use "Save PDF" to keep them.', 'ok');
    }
    buildFields();
  } catch (err) {
    showBanner('Could not update the form: ' + ((err && err.message) || err));
  }
}

$('#fields-apply').addEventListener('click', () => applyFieldValues(false));
$('#fields-flatten').addEventListener('click', () => applyFieldValues(true));

/* ------------------------------------------------------------------ *
 * Sidebar — notes
 * ------------------------------------------------------------------ */

function buildNotes() {
  const el = $('#notes');
  el.textContent = '';
  const notes = state.objects.filter((o) => o.type === 'note');
  if (!notes.length) {
    const p = document.createElement('p');
    p.className = 'tiny muted pad';
    p.textContent = 'Sticky notes you add will be listed here.';
    el.appendChild(p);
    return;
  }
  for (const note of notes) {
    const b = document.createElement('button');
    b.className = 'note-item';
    b.innerHTML = '<span class="rpage">p.' + (note.pageIndex + 1) + '</span> ' + escapeText(note.text);
    b.addEventListener('click', () => {
      PS.goToPage(note.pageIndex + 1);
      PS.select(note);
    });
    el.appendChild(b);
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

// "Convert this PDF" from the popup or a context menu lands here.
let requestedAction = new URLSearchParams(location.search).get('do');

document.addEventListener('ps:document-loaded', () => {
  buildThumbnails();
  buildOutline();
  buildFields();
  buildNotes();
  loadMetadataIntoForm();
  renderMergeList();
  // A task that was asked for before there was a document — from the popup,
  // a context menu or a quick start — opens now, once.
  const want = pendingPane || (requestedAction ? 'hub-' + requestedAction : null);
  pendingPane = null;
  requestedAction = null;
  if (want && $('#' + want)) openHub(want);
});

document.addEventListener('ps:objects-changed', buildNotes);

document.addEventListener('ps:panel-shown', (e) => {
  if (e.detail.id === 'panel-pages' && state.doc && !thumbsEl.childElementCount) buildThumbnails();
});

renderMergeList();

// "Create a PDF" needs no open document, so it can be shown straight away.
if (requestedAction === 'create' && !new URLSearchParams(location.search).get('src')) {
  requestedAction = null;
  openHub('hub-create');
}

// For the command palette, which opens tasks by name.
PS.openHub = openHub;
PS.showHubHome = showHubHome;

})();
