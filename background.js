'use strict';

const MENU_LINK = 'pdfstudio-edit-link';
const MENU_PAGE = 'pdfstudio-edit-page';
const MENU_CONVERT_LINK = 'pdfstudio-convert-link';
const MENU_CONVERT_PAGE = 'pdfstudio-convert-page';

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
        id: MENU_CONVERT_LINK,
        title: 'Convert linked PDF to Word, Excel, PowerPoint…',
        contexts: ['link'],
        targetUrlPatterns: PDF_PATTERNS
      });
      chrome.contextMenus.create({
        id: MENU_PAGE,
        title: 'Edit this PDF in PDF Studio',
        contexts: ['page'],
        documentUrlPatterns: PDF_PATTERNS
      });
      chrome.contextMenus.create({
        id: MENU_CONVERT_PAGE,
        title: 'Convert this PDF to Word, Excel, PowerPoint…',
        contexts: ['page'],
        documentUrlPatterns: PDF_PATTERNS
      });
    } catch (e) {
      // Menu creation is best-effort; the popup covers the same entry points.
    }
  });
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

chrome.contextMenus.onClicked.addListener((info) => {
  const linkMenus = [MENU_LINK, MENU_CONVERT_LINK];
  const url = linkMenus.includes(info.menuItemId) ? info.linkUrl : info.pageUrl;
  const action = info.menuItemId === MENU_CONVERT_LINK || info.menuItemId === MENU_CONVERT_PAGE
    ? 'convert'
    : '';
  if (url) openEditor(url, action);
});

function openEditor(srcUrl, action) {
  const params = new URLSearchParams();
  if (srcUrl) params.set('src', srcUrl);
  if (action) params.set('do', action);
  const query = params.toString();
  chrome.tabs.create({
    url: chrome.runtime.getURL('editor.html') + (query ? '?' + query : '')
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'open-editor') openEditor(msg.src || '', msg.action || '');
});
