'use strict';

const MENU_LINK = 'pdfstudio-edit-link';
const MENU_PAGE = 'pdfstudio-edit-page';

const PDF_PATTERNS = [
  '*://*/*.pdf',
  '*://*/*.pdf?*',
  '*://*/*.pdf#*',
  '*://*/*.PDF',
  '*://*/*.PDF?*',
  'file:///*.pdf',
  'file:///*.PDF'
];

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    try {
      chrome.contextMenus.create({
        id: MENU_LINK,
        title: 'Edit linked PDF in PDF Studio',
        contexts: ['link'],
        targetUrlPatterns: PDF_PATTERNS
      });
      chrome.contextMenus.create({
        id: MENU_PAGE,
        title: 'Edit this PDF in PDF Studio',
        contexts: ['page'],
        documentUrlPatterns: PDF_PATTERNS
      });
    } catch (e) {
      // Menu creation is best-effort; the popup covers the same entry points.
    }
  });
}

chrome.runtime.onInstalled.addListener(createMenus);

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.menuItemId === MENU_LINK ? info.linkUrl : info.pageUrl;
  if (url) openEditor(url);
});

function openEditor(srcUrl) {
  const url =
    chrome.runtime.getURL('editor.html') +
    (srcUrl ? '?src=' + encodeURIComponent(srcUrl) : '');
  chrome.tabs.create({ url });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'open-editor') openEditor(msg.src || '');
});
