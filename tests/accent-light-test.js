// tests/accent-light-test.js - the accent per theme (run: node tests/accent-light-test.js).
// look-sync v2.2 (CONTRACT "Accent profiles"): an app passes the 'islands' profile only in a theme whose
// islands look it has built. Quartz's light is that look (LIGHT.md section 4), so light asks for 'islands'
// and its base hue 189 gives exactly #083f49 / strong #05313a / ink #f4f7f8; dark keeps the steel tokens
// it has. Checked through settings.js (the chrome) and newtab-theme.js (the file:// pages), each loaded as
// it ships with the vendored looksync/accent.js, and in tokens.css (the light default, no hue set). The
// slider starts at the theme's base hue (light 189, dark 212) and nothing is written until it moves.
// One summary line: "accent-light: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeWindow } = require('./fake-dom');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(ok, what, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + what + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const LA = require(path.join(ROOT, 'looksync', 'accent.js'));

/** A style object that remembers what is set on it. */
function styleMap() {
  const m = new Map();
  return { m, setProperty: (k, v) => m.set(k, String(v)), removeProperty: (k) => m.delete(k), getPropertyValue: (k) => m.get(k) || '' };
}
const all = (st) => Object.fromEntries(st.m);

/* ---- the shared tokens: v2.2 vendored ---- */
{
  const t = LA.tokens(189, 'light', 'islands');
  check(t.acc === '#083f49' && t.strong === '#05313a' && t.on === '#f4f7f8' && t.soft === 'rgba(8, 63, 73, 0.11)',
    'vendored accent.js: islands light at 189 = #083f49 / #05313a / #f4f7f8, soft .11', t);
  check(LA.baseHue('islands', 'light') === 189 && LA.baseHue('islands', 'dark') === 185, 'vendored accent.js: islands base hues 189 light, 185 dark');
  const tag = 'VENDORED from ~/look-sync commit 6e7e729';
  check(read('looksync/accent.js').indexOf(tag) >= 0 && read('looksync/accent.browser.js').indexOf(tag) >= 0, 'accent.js and accent.browser.js are vendored from 6e7e729');
}

/* ---- the chrome: settings.js ---- */
function bootSettings(light) {
  const w = makeWindow({ localStorage: { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 }, LookAccent: LA });
  const st = styleMap();
  w.doc.documentElement.style = st;
  if (light) w.doc.documentElement.setAttribute('data-theme', 'light');
  w.load(path.join(ROOT, 'settings.js'));
  st.m.clear();   // what the boot painted (nothing stored: nothing), so each check starts clean
  return { S: w.win.Settings, st };
}
{
  const L = bootSettings(true);
  check(!!L.S && typeof L.S._applyAccent === 'function' && typeof L.S._authoredHue === 'function', 'settings.js loads with its accent seams');
  L.S._applyAccent(189);
  check(L.st.m.get('--ion') === '#083f49' && L.st.m.get('--accent-strong') === '#05313a' && L.st.m.get('--accent-text') === '#f4f7f8' &&
        L.st.m.get('--ion-soft') === 'rgba(8, 63, 73, 0.11)',
    'chrome, light, hue 189: --ion #083f49, --accent-strong #05313a, --accent-text #f4f7f8, soft .11', all(L.st));
  check(L.S._accentFallback() === null, 'chrome, light: the shared formula painted it (no fallback)', L.S._accentFallback());
  L.S._applyAccent(null);
  check(!L.st.m.has('--ion') && !L.st.m.has('--accent-strong') && !L.st.m.has('--accent-text'), "chrome, light, no hue: no inline accent, tokens.css's own", all(L.st));
  check(L.S._authoredHue() === 189, 'chrome, light: the slider starts at baseHue(islands, light) = 189', L.S._authoredHue());
  const h = L.S.get('accentHue');
  check(h === null || h === undefined, 'chrome: no hue is stored until the slider moves', h);

  const D = bootSettings(false);
  D.S._applyAccent(212);
  check(D.st.m.get('--ion') === '#9fb4cc' && LA.tokens(212, 'dark').acc === '#9fb4cc' && !D.st.m.has('--accent-strong') && !D.st.m.has('--accent-text'),
    'chrome, dark, hue 212: the steel tokens as before, no inline strong / ink', all(D.st));
  check(D.S._authoredHue() === 212, 'chrome, dark: the slider starts at 212 as before', D.S._authoredHue());
  // a theme flip to dark with a hue set: the light-only strong / ink come off
  D.st.m.set('--accent-strong', '#05313a'); D.st.m.set('--accent-text', '#f4f7f8');
  D.S._applyAccent(189);
  check(!D.st.m.has('--accent-strong') && !D.st.m.has('--accent-text') && D.st.m.get('--ion') === LA.tokens(189, 'dark').acc,
    'chrome, dark after light: the light strong / ink come off, steel at 189', all(D.st));
}

/* ---- the file:// pages: newtab-theme.js ---- */
function bootPage(query) {
  const st = styleMap();
  const attrs = {};
  const root = { style: st, setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => (k in attrs ? attrs[k] : null), removeAttribute: (k) => { delete attrs[k]; } };
  const win = { document: { documentElement: root }, location: { search: query }, URLSearchParams, LookAccent: LA, console };
  win.window = win;
  vm.runInNewContext(read('newtab-theme.js'), win, { filename: 'newtab-theme.js' });
  return { win, st, attrs };
}
{
  const p = bootPage('?theme=light&hue=189');
  check(p.st.m.get('--ion') === '#083f49' && p.st.m.get('--accent-strong') === '#05313a' && p.st.m.get('--accent-text') === '#f4f7f8',
    'page, light, hue 189: the same three as the chrome', all(p.st));
  p.attrs['data-theme'] = 'dark';
  p.win.__applyAccent(189);
  check(p.st.m.get('--ion') === LA.tokens(189, 'dark').acc && !p.st.m.has('--accent-strong') && !p.st.m.has('--accent-text'),
    'page, flipped to dark: steel at 189, the light strong / ink off', all(p.st));
  const q = bootPage('?theme=light');
  check(q.st.m.size === 0, 'page, light, no hue: no inline accent', all(q.st));
  const d = bootPage('?theme=dark&hue=212');
  check(d.st.m.get('--ion') === '#9fb4cc' && !d.st.m.has('--accent-strong'), 'page, dark, hue 212: the steel blue as before', all(d.st));
}

/* ---- tokens.css: the light default is the islands accent, dark unchanged ---- */
{
  const tok = read('tokens.css');
  const cut = tok.indexOf('html[data-theme="light"] {');
  const light = tok.slice(cut);
  check(light.indexOf('--ion: #083f49;') >= 0 && light.indexOf('--ion-soft: rgba(8, 63, 73, 0.11);') >= 0, "tokens.css light: --ion #083f49, soft .11 (the token's own value)");
  check(/html\[data-theme="light"\]:not\(\[data-palette\]\) \{\s*--accent-strong: #05313a;\s*--accent-text: #f4f7f8;/.test(tok), 'tokens.css light, default palette: strong #05313a, ink #f4f7f8');
  check(tok.slice(0, cut).indexOf('--ion: #9fb4cc;') >= 0, 'tokens.css dark: --ion #9fb4cc as before');
}

console.log('accent-light: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
