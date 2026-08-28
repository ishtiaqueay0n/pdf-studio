'use strict';

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

function openEditor(src) {
  chrome.runtime.sendMessage({ type: 'open-editor', src: src || '' });
  window.close();
}

const statusEl = document.getElementById('status');
const btnCurrent = document.getElementById('btn-edit-current');
const btnForce = document.getElementById('btn-force');
const btnOpen = document.getElementById('btn-open');

btnOpen.addEventListener('click', () => openEditor(''));

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  const url = tab && tab.url ? tab.url : '';

  if (url && isPdfUrl(url)) {
    statusEl.textContent = 'PDF detected in this tab';
    statusEl.classList.add('pdf');
    btnCurrent.classList.remove('hidden');
    btnCurrent.addEventListener('click', () => openEditor(url));
  } else if (url && isFetchable(url)) {
    statusEl.textContent = 'This tab does not look like a PDF.';
    btnForce.classList.remove('hidden');
    btnForce.addEventListener('click', () => openEditor(url));
  } else {
    statusEl.textContent = 'This page cannot be read. Open the editor and load a file instead.';
  }
});
