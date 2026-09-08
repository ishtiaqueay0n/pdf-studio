'use strict';
/* global PSTheme */

function isPdfUrl(u) {
  try {
    const url = new URL(u);
    if (!['http:', 'https:', 'file:'].includes(url.protocol)) return false;
    return /\.pdf$/i.test(url.pathname);
  } catch (e) {
    return false;
  }
}

function isFetchable(u) {
  try {
    const url = new URL(u);
    return ['http:', 'https:', 'file:'].includes(url.protocol);
  } catch (e) {
    return false;
  }
}

function openEditor(src, action) {
  chrome.runtime.sendMessage({ type: 'open-editor', src: src || '', action: action || '' });
  window.close();
}

const statusEl = document.getElementById('status');
const btnCurrent = document.getElementById('btn-edit-current');
const btnConvertCurrent = document.getElementById('btn-convert-current');
const btnForce = document.getElementById('btn-force');

document.getElementById('btn-open').addEventListener('click', () => openEditor('', ''));
document.getElementById('btn-create').addEventListener('click', () => openEditor('', 'create'));
document.getElementById('btn-merge').addEventListener('click', () => openEditor('', 'organise'));

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  const url = tab && tab.url ? tab.url : '';

  if (url && isPdfUrl(url)) {
    statusEl.textContent = 'PDF detected in this tab';
    statusEl.classList.add('pdf');
    btnCurrent.classList.remove('hidden');
    btnConvertCurrent.classList.remove('hidden');
    btnCurrent.addEventListener('click', () => openEditor(url, ''));
    btnConvertCurrent.addEventListener('click', () => openEditor(url, 'convert'));
  } else if (url && isFetchable(url)) {
    statusEl.textContent = 'This tab does not look like a PDF.';
    btnForce.classList.remove('hidden');
    btnForce.addEventListener('click', () => openEditor(url, ''));
  } else {
    statusEl.textContent = 'This page cannot be read. Open the editor and load a file instead.';
  }
});

PSTheme.register(document.getElementById('btn-theme'));
