'use strict';
/*
 * Interface theme.
 *
 * Light by default. The choice is remembered in localStorage, which every
 * extension page shares within the profile and which needs no extra
 * permission — deliberately not chrome.storage, so the manifest keeps its two
 * permissions.
 *
 * This changes the interface only. The rendered page, the annotation colours,
 * whiteout, redaction and everything that ends up in the saved file are left
 * alone in both themes: a whiteout that drew dark, or a redaction that drew
 * light, would misrepresent what the file is about to contain. Night reading
 * mode remains a separate control, because inverting the document and dimming
 * the interface are different wishes.
 */
(function (root) {

const KEY = 'pdf-studio-theme';
const DARK = 'dark';
const LIGHT = 'light';

const buttons = [];

function stored() {
  try {
    const v = localStorage.getItem(KEY);
    return v === DARK || v === LIGHT ? v : null;
  } catch (err) {
    return null; // storage blocked — the default is fine
  }
}

function current() {
  return document.documentElement.getAttribute('data-theme') === DARK ? DARK : LIGHT;
}

function apply(theme) {
  const t = theme === DARK ? DARK : LIGHT;
  if (t === DARK) document.documentElement.setAttribute('data-theme', DARK);
  else document.documentElement.removeAttribute('data-theme');
  return t;
}

function label(button, theme) {
  const dark = theme === DARK;
  button.setAttribute('aria-pressed', dark ? 'true' : 'false');
  button.title = dark ? 'Switch to the light interface' : 'Switch to the dark interface';
  const sun = button.querySelector('[data-theme-icon="light"]');
  const moon = button.querySelector('[data-theme-icon="dark"]');
  if (sun) sun.style.display = dark ? '' : 'none';
  if (moon) moon.style.display = dark ? 'none' : '';
}

function set(theme) {
  const t = apply(theme);
  try { localStorage.setItem(KEY, t); } catch (err) { /* not worth failing over */ }
  for (const b of buttons) label(b, t);
  return t;
}

function toggle() {
  return set(current() === DARK ? LIGHT : DARK);
}

/** Wire a button to the toggle and keep its icon and label in step. */
function register(button) {
  if (!button) return;
  buttons.push(button);
  label(button, current());
  button.addEventListener('click', () => toggle());
}

// Applied at load, from <head>, so the first paint is already the right theme.
apply(stored() || LIGHT);

root.PSTheme = { apply, set, toggle, current, register, KEY };

})(typeof window !== 'undefined' ? window : globalThis);
