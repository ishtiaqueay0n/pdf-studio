'use strict';
/*
 * Interface theme: light, dark, or whatever the system is set to.
 *
 * It follows the system until a choice is made. The choice is remembered in
 * localStorage, which every extension page shares within the profile and
 * which needs no extra permission — deliberately not chrome.storage, so the
 * manifest keeps its two permissions.
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
const SYSTEM = 'system';
const MODES = [LIGHT, DARK, SYSTEM];
const LABELS = { light: 'Light', dark: 'Dark', system: 'Match system' };

const buttons = [];
const listeners = [];
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

function stored() {
  try {
    const v = localStorage.getItem(KEY);
    return MODES.includes(v) ? v : null;
  } catch (err) {
    return null; // storage blocked — the default is fine
  }
}

let chosen = stored() || SYSTEM;

/** The mode that was asked for: light, dark or system. */
function mode() {
  return chosen;
}

/** The theme actually showing: light or dark. */
function current() {
  if (chosen === SYSTEM) return media && media.matches ? DARK : LIGHT;
  return chosen;
}

function paint() {
  const el = document.documentElement;
  if (current() === DARK) el.setAttribute('data-theme', DARK);
  else el.removeAttribute('data-theme');
  for (const b of buttons) label(b);
  for (const fn of listeners) fn(chosen, current());
}

/** Show a mode without remembering it. */
function apply(next) {
  chosen = MODES.includes(next) ? next : SYSTEM;
  paint();
  return current();
}

/** Show a mode and remember it. */
function set(next) {
  apply(next);
  try { localStorage.setItem(KEY, chosen); } catch (err) { /* not worth failing over */ }
  return current();
}

/** Step to the next mode: light, dark, system, and round again. */
function toggle() {
  return set(MODES[(MODES.indexOf(chosen) + 1) % MODES.length]);
}

// A cycling button shows the icon of the mode it is in and says what a click
// will change it to.
function label(button) {
  const next = MODES[(MODES.indexOf(chosen) + 1) % MODES.length];
  const text = 'Theme: ' + LABELS[chosen] + ' — switch to ' + LABELS[next].toLowerCase();
  button.title = text;
  button.setAttribute('aria-label', text);
  for (const icon of button.querySelectorAll('[data-theme-icon]')) {
    icon.classList.toggle('hidden', icon.getAttribute('data-theme-icon') !== chosen);
  }
}

/** Wire a button to step through the modes and keep its icon in step. */
function register(button) {
  if (!button) return;
  buttons.push(button);
  label(button);
  button.addEventListener('click', () => toggle());
}

/** Be told when the mode changes: fn(mode, theme). */
function onChange(fn) {
  listeners.push(fn);
}

// While following the system, follow it live.
if (media) {
  const follow = () => { if (chosen === SYSTEM) paint(); };
  if (media.addEventListener) media.addEventListener('change', follow);
  else if (media.addListener) media.addListener(follow);
}

// Applied at load, from <head>, so the first paint is already the right theme.
paint();

root.PSTheme = { apply, set, toggle, current, mode, register, onChange, KEY, MODES, LABELS };

})(typeof window !== 'undefined' ? window : globalThis);
