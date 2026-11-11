'use strict';
// settings-glass-harness.js - Settings > Look's glass rows and glass.<theme>.dimAuto, pure node, no Electron.
//   node settings-glass-harness.js
//
// settings.js is loaded as it ships into tests/fake-dom.js. The panel is pre-built as just the glass field
// (#settings-panel > .set-body > [data-field="glass"]), so boot() adopts it instead of building every section.
// Checked: the new seeds (sharp picture, lighter tint); normalizeGlass keeps a boolean dimAuto and drops
// anything else; moving Dim stores dimAuto false + the value; Auto stores dimAuto true and keeps the value;
// Blur and See-through keep dimAuto as it was (absent stays absent); the Dim drag previews dimAuto false;
// the mode line shows backdrop.js's text, falls back to its own wording for an older backdrop.js, and says
// so (never blank) when the background layer has not reported.
const path = require('path');
const { makeWindow, El } = require('./tests/fake-dom');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 400))); }
}

function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => Array.from(map.keys())[i] || null,
    get length() { return map.size; }
  };
}

/** Boot settings.js with `stored` glass; returns the window, Settings, the field and the preview log. */
function boot(stored, opts) {
  opts = opts || {};
  const previews = [];
  const backdrop = { state: opts.state === undefined ? null : opts.state };
  const w = makeWindow({
    localStorage: fakeStorage(stored === undefined ? {} : { settings: JSON.stringify({ glass: stored }) }),
    LookSync: { previewGlass: (t, g) => previews.push({ t, g: g ? JSON.parse(JSON.stringify(g)) : null }) },
    Backdrop: { state: () => backdrop.state }
  });
  if (opts.light) w.doc.documentElement.setAttribute('data-theme', 'light');
  const panel = new El(w.doc, 'div'); panel.id = 'settings-panel';
  const body = new El(w.doc, 'div'); body.className = 'set-body';
  const field = new El(w.doc, 'div'); field.className = 'set-field set-glass'; field.setAttribute('data-field', 'glass');
  body.appendChild(field); panel.appendChild(body); w.doc.body.appendChild(panel);
  let err = null;
  try { w.load(path.join(__dirname, 'settings.js')); } catch (e) { err = e; }
  const S = w.win.Settings;
  if (S && !err) { try { S._renderGlass(); } catch (e) { err = e; } }
  return { w, S, field, previews, backdrop, err };
}

const q = (field, sel) => field.querySelector(sel);
function drag(slider, value) {
  slider.value = String(value);
  slider.dispatchEvent({ type: 'input' });
}
function letGo(slider) { slider.dispatchEvent({ type: 'change' }); }
const storedGlass = (b) => b.S.get('glass');

// ---- 1. seeds and normalizeGlass ----------------------------------------------------------
{
  const b = boot(undefined);
  ok('settings.js loads and renders the glass field in the fake DOM', !!b.S && !b.err, b.err && String(b.err.stack || b.err).slice(0, 400));
  if (!b.S || b.err) { console.log('settings-glass: ' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }
  const d = b.S._defaults.glass;
  ok('seed dark: blur 0, dim 0.30, panel 0', d.dark.blurPx === 0 && d.dark.dim === 0.3 && d.dark.panel === 0, d.dark);
  ok('seed light: blur 0, dim 0.30, panel 0', d.light.blurPx === 0 && d.light.dim === 0.3 && d.light.panel === 0, d.light);
  ok('seeds name no dimAuto (absent = automatic)', !('dimAuto' in d.dark) && !('dimAuto' in d.light), d);
  const n = b.S._normalizeGlass({ dark: { blurPx: 4, dim: 0.4, panel: 0, dimAuto: false }, light: { dim: 0.5, dimAuto: true } });
  ok('normalizeGlass keeps dimAuto false', n.dark.dimAuto === false, n.dark);
  ok('normalizeGlass keeps dimAuto true', n.light.dimAuto === true, n.light);
  const bad = b.S._normalizeGlass({ dark: { dimAuto: 'false' }, light: { dimAuto: 0 } });
  ok('normalizeGlass drops a non-boolean dimAuto', !('dimAuto' in bad.dark) && !('dimAuto' in bad.light), bad);
  const none = b.S._normalizeGlass({ dark: { dim: 0.5 } });
  ok('normalizeGlass leaves an absent dimAuto absent', !('dimAuto' in none.dark) && !('dimAuto' in none.light), none);
}

// ---- 2. Dim / Auto / Blur / See-through through the rendered rows -------------------------
{
  const b = boot({ dark: { blurPx: 0, dim: 0.3, panel: 0 }, light: { blurPx: 0, dim: 0.3, panel: 0 }, render: 'picture' });
  const auto = q(b.field, '[data-glass-auto]');
  ok('Auto is drawn beside Dim', !!auto && auto.tagName === 'BUTTON' && auto.parentNode === q(b.field, '#set-glass-dim').parentNode, auto && auto.tagName);
  ok('Auto: pressed while automatic (aria-pressed true), has an aria-label', auto.getAttribute('aria-pressed') === 'true' && /automatic/i.test(auto.getAttribute('aria-label') || ''), auto.attrs);
  ok('Auto is a real button (keyboard reachable, not disabled)', auto.getAttribute('type') !== null || auto.type === 'button', auto.type);

  // Blur while automatic (dimAuto absent): stays absent
  const blur = q(b.field, '#set-glass-blur');
  drag(blur, 6); letGo(blur);
  ok('Blur change: value stored', storedGlass(b).dark.blurPx === 6, storedGlass(b).dark);
  ok('Blur change while automatic (absent): dimAuto stays absent', !('dimAuto' in storedGlass(b).dark), storedGlass(b).dark);

  // Dim drag: preview says manual; let go: stored manual + value
  let dim = q(b.field, '#set-glass-dim');
  b.previews.length = 0;
  drag(dim, 24);
  const p = b.previews.filter((x) => x.g).pop();
  ok('Dim drag: preview carries dimAuto false and the dragged value', p && p.t === 'dark' && p.g.dimAuto === false && p.g.dim === 0.24, b.previews);
  letGo(dim);
  ok('Dim change: stores dimAuto false + the value', storedGlass(b).dark.dimAuto === false && storedGlass(b).dark.dim === 0.24, storedGlass(b).dark);
  ok('Dim change: the other theme untouched', !('dimAuto' in storedGlass(b).light) && storedGlass(b).light.dim === 0.3, storedGlass(b).light);
  ok('Dim change: preview cleared on let go', b.previews[b.previews.length - 1].g === null, b.previews.slice(-1));

  // re-rendered from the store: Auto now not pressed
  const auto2 = q(b.field, '[data-glass-auto]');
  ok('After a Dim change: Auto shows not pressed (manual)', auto2 && auto2.getAttribute('aria-pressed') === 'false', auto2 && auto2.attrs);

  // Blur and See-through while manual: stay manual
  q(b.field, '#set-glass-blur').value = '2'; letGo(q(b.field, '#set-glass-blur'));
  ok('Blur change while manual: dimAuto stays false', storedGlass(b).dark.dimAuto === false && storedGlass(b).dark.blurPx === 2, storedGlass(b).dark);
  const see = q(b.field, '#set-glass-see');
  drag(see, 10);
  const ps = b.previews.filter((x) => x.g).pop();
  ok('See-through drag while manual: preview keeps dimAuto false', ps && ps.g.dimAuto === false && ps.g.panel === -0.1, ps);
  letGo(see);
  ok('See-through change while manual: dimAuto stays false, value stored', storedGlass(b).dark.dimAuto === false && storedGlass(b).dark.panel === -0.1, storedGlass(b).dark);

  // Auto: dimAuto true, value unchanged
  q(b.field, '[data-glass-auto]').click();
  const g = storedGlass(b).dark;
  ok('Auto: stores dimAuto true and keeps the value (dim 0.24, blur 2, panel -0.1)', g.dimAuto === true && g.dim === 0.24 && g.blurPx === 2 && g.panel === -0.1, g);
  const auto3 = q(b.field, '[data-glass-auto]');
  ok('After Auto: pressed again', auto3.getAttribute('aria-pressed') === 'true', auto3.attrs);
  // Auto while already automatic: no write
  let wrote = 0; b.S.on(() => { wrote++; });
  auto3.click();
  ok('Auto while already automatic: nothing written', wrote === 0, wrote);
  // Blur while dimAuto true: stays true
  q(b.field, '#set-glass-blur').value = '3'; letGo(q(b.field, '#set-glass-blur'));
  ok('Blur change while dimAuto true: stays true', storedGlass(b).dark.dimAuto === true, storedGlass(b).dark);
}

// ---- 3. light theme edits glass.light only -------------------------------------------------
{
  const b = boot({ dark: { blurPx: 0, dim: 0.3, panel: 0, dimAuto: false }, light: { blurPx: 0, dim: 0.3, panel: 0 }, render: 'picture' }, { light: true });
  const dim = q(b.field, '#set-glass-dim');
  dim.value = '40'; letGo(dim);
  ok('light: Dim change writes glass.light (manual, 0.40)', storedGlass(b).light.dimAuto === false && storedGlass(b).light.dim === 0.4, storedGlass(b).light);
  ok('light: glass.dark keeps its own Manual choice', storedGlass(b).dark.dimAuto === false && storedGlass(b).dark.dim === 0.3, storedGlass(b).dark);
  const hint = b.field.querySelectorAll('.set-hint').map((n) => n.textContent).join(' ');
  ok('light hint: sharp picture, white tint, Auto', /paints the picture sharp/.test(hint) && /white tint/.test(hint) && /Auto raises it/.test(hint), hint);
}

// ---- 4. the mode line -----------------------------------------------------------------------
{
  const text = 'Automatic: 0.30, raised to 0.46 so text stays readable over this picture';
  const b = boot(undefined, { state: { glass: { theme: 'dark', mode: 'auto', text, reason: 'raised', floor: 0.3, alpha: 0.46, raised: true, source: 'shared' } } });
  const note = () => q(b.field, '[data-glass-guard]');
  ok('mode line shows backdrop.js text', note().textContent === text && !note().hidden, note().textContent);
  ok('mode line is a status (role=status)', note().getAttribute('role') === 'status', note().attrs);
  b.backdrop.state = { glass: { theme: 'dark', mode: 'manual', text: 'Manual: 0.20', floor: 0.2, alpha: 0.2, raised: false, source: 'own' } };
  b.w.doc.dispatchEvent({ type: 'backdropchange' });
  ok('mode line follows backdropchange', note().textContent === 'Manual: 0.20', note().textContent);
  b.backdrop.state = { glass: { theme: 'dark', floor: 0.3, alpha: 0.3, raised: false, source: 'own', sourceReason: "Mantle's shared value is stale" } };
  b.w.doc.dispatchEvent({ type: 'backdropchange' });
  ok('older backdrop.js (no text): keeps the old wording, with the reason', note().textContent === "Dark wash .30, worked out by Quartz: Mantle's shared value is stale." && !note().hidden, note().textContent);
  b.backdrop.state = { glass: { theme: 'dark', floor: 0.3, alpha: 0.5, raised: true, source: 'shared' } };
  b.w.doc.dispatchEvent({ type: 'backdropchange' });
  ok('older backdrop.js, shared + raised: old wording', note().textContent === 'Dark wash .50, shared with Mantle and Helm (worked out over the top of the screen); raised from .30 so text stays readable over this bright photo.', note().textContent);
  b.backdrop.state = { glass: { theme: 'dark', floor: 0.3, alpha: 0.3, raised: false, source: 'none', sourceReason: 'no picture' } };
  b.w.doc.dispatchEvent({ type: 'backdropchange' });
  ok('older backdrop.js, no source: shown (was hidden) with the reason', note().textContent === 'Dark wash .30 (the Dim, not raised): no picture.' && !note().hidden, note().textContent);
  ok('older backdrop.js, light: old wording', b.S._glassGuardText({ theme: 'light', alpha: 0.45, source: 'own', sourceReason: 'light top band is stale' }, 'light', {}) === 'Light wash .45 (the Dim, not raised): light top band is stale.');
  b.backdrop.state = null;
  b.w.doc.dispatchEvent({ type: 'backdropchange' });
  ok('no backdrop state: says so, not blank', /^Automatic: 0\.30, the background layer has not reported yet\.$/.test(note().textContent) && !note().hidden, note().textContent);
  b.backdrop.state = { glass: { theme: 'dark', text: '   ' } };
  b.w.doc.dispatchEvent({ type: 'backdropchange' });
  ok('empty text: not shown blank', note().textContent.trim().length > 0, note().textContent);
  // pure: a state for the other theme is not this theme's line
  const other = b.S._glassGuardText({ theme: 'light', text: 'Automatic: 0.30' }, 'dark', { dim: 0.25, dimAuto: false });
  ok('state for the other theme: not shown as this one; says manual + not reported', other === 'Manual: 0.25, the background layer has not reported yet.', other);
}

console.log('settings-glass: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
