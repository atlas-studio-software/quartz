'use strict';
// settings-glass-harness.js - Settings > Look's glass rows and glass.<theme>.dimAuto, pure node, no Electron.
//   node settings-glass-harness.js
//
// settings.js is loaded as it ships into tests/fake-dom.js. The panel is pre-built as just the glass field
// (#settings-panel > .set-body > [data-field="glass"]), so boot() adopts it instead of building every section.
// Checked: the seeds; normalizeGlass keeps a boolean dimAuto and drops anything else; no Blur, See-through
// or Auto control (CONTRACT v2); the pure glassPatch both UI paths use (Dim: only {dim}, 0.20..0.90, never
// lower; the check: only {dimAuto}); a Dim drag/let-go writes no dimAuto; the brightness check switch writes
// only dimAuto, a stored false reads as off and turns back on, absent reads as on; the off / not-running note;
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
  ok('seed dark: blur 0, dim 0.20 (CONTRACT, 2026-11-24), panel 0', d.dark.blurPx === 0 && d.dark.dim === 0.2 && d.dark.panel === 0, d.dark);
  ok('seed light: blur 0, dim 0.20 (CONTRACT, 2026-11-24), panel 0', d.light.blurPx === 0 && d.light.dim === 0.2 && d.light.panel === 0, d.light);
  ok('seeds name no dimAuto (absent = automatic)', !('dimAuto' in d.dark) && !('dimAuto' in d.light), d);
  const n = b.S._normalizeGlass({ dark: { blurPx: 4, dim: 0.4, panel: 0, dimAuto: false }, light: { dim: 0.5, dimAuto: true } });
  ok('normalizeGlass keeps dimAuto false', n.dark.dimAuto === false, n.dark);
  ok('normalizeGlass keeps dimAuto true', n.light.dimAuto === true, n.light);
  const bad = b.S._normalizeGlass({ dark: { dimAuto: 'false' }, light: { dimAuto: 0 } });
  ok('normalizeGlass drops a non-boolean dimAuto', !('dimAuto' in bad.dark) && !('dimAuto' in bad.light), bad);
  const none = b.S._normalizeGlass({ dark: { dim: 0.5 } });
  ok('normalizeGlass leaves an absent dimAuto absent', !('dimAuto' in none.dark) && !('dimAuto' in none.light), none);
  const low = b.S._normalizeGlass({ dark: { dim: 0.05 }, light: { dim: 0 } });
  ok('normalizeGlass: a Dim under 20% (an old 0-60% prototype value) is clamped to 0.20', low.dark.dim === 0.2 && low.light.dim === 0.2, low);
}

// ---- 2. glassPatch / glassEdit / glassCheckOn (pure; both UI paths use them) -------------------
{
  const b = boot(undefined);
  const P = b.S._glassPatch, E = b.S._glassEdit, C = b.S._glassCheckOn;
  const keys = (o) => Object.keys(o || {}).sort().join(',');
  ok('glassPatch dim: only {dim}, no dimAuto key', keys(P('dim', 0.45)) === 'dim' && P('dim', 0.45).dim === 0.45, P('dim', 0.45));
  ok('glassPatch dim: below 0.20 clamps to 0.20 (never written lower)', P('dim', 0.05).dim === 0.2 && P('dim', 0).dim === 0.2 && P('dim', -1).dim === 0.2, [P('dim', 0.05), P('dim', 0)]);
  ok('glassPatch dim: above 0.90 clamps to 0.90', P('dim', 0.95).dim === 0.9 && P('dim', 5).dim === 0.9, P('dim', 0.95));
  ok('glassPatch dim: not a number writes the floor, never NaN', P('dim', 'x').dim === 0.2 && P('dim', NaN).dim === 0.2, P('dim', 'x'));
  ok('glassPatch check: only {dimAuto}', keys(P('check', true)) === 'dimAuto' && P('check', true).dimAuto === true && P('check', false).dimAuto === false, [P('check', true), P('check', false)]);
  ok('glassPatch: no blur or see-through kind', P('blur', 6) === null && P('see', 10) === null && P('auto') === null);
  ok('glassCheckOn: absent = on, true = on, false = off', C({}) === true && C({ dimAuto: true }) === true && C({ dimAuto: false }) === false && C(null) === true);
  const st = { dark: { blurPx: 7, dim: 0.3, panel: -0.1, dimAuto: false }, light: { blurPx: 3, dim: 0.5, panel: 0.05 }, render: 'picture' };
  const e1 = E(st, 'dark', P('dim', 0.4));
  ok('glassEdit dim: keeps blurPx, panel and a stored dimAuto false', e1.dark.dim === 0.4 && e1.dark.blurPx === 7 && e1.dark.panel === -0.1 && e1.dark.dimAuto === false, e1.dark);
  const e2 = E(st, 'light', P('dim', 0.1));
  ok('glassEdit dim: absent dimAuto stays absent; clamped 0.20', !('dimAuto' in e2.light) && e2.light.dim === 0.2 && e2.light.blurPx === 3 && e2.light.panel === 0.05, e2.light);
  ok('glassEdit: the other theme untouched', JSON.stringify(e2.dark) === JSON.stringify(b.S._normalizeGlass(st).dark), e2.dark);
  const e3 = E(st, 'dark', P('check', true));
  ok('glassEdit check: dimAuto true, Dim/blur/panel kept', e3.dark.dimAuto === true && e3.dark.dim === 0.3 && e3.dark.blurPx === 7 && e3.dark.panel === -0.1, e3.dark);
  const T = b.S._glassCheckText;
  ok('check note: on (dark) says what it does', /^On: /.test(T(true, 'dark', 'on')), T(true, 'dark', 'on'));
  ok('check note: off says the panels show the Dim only', /^Off: .*under the Dim only/.test(T(false, 'dark', 'on')), T(false, 'dark', 'on'));
  ok('check note: on but brightcheck missing says not running and why', /^On, but not running: brightcheck\.js did not load/.test(T(true, 'dark', 'off: brightcheck.js did not load, so x')), T(true, 'dark', 'off: brightcheck.js did not load, so x'));
  ok('check note: light says it does not run there yet', /not running in the light theme/.test(T(true, 'light', 'on')) && /light theme yet/.test(T(false, 'light', 'on')), [T(true, 'light'), T(false, 'light')]);
}

// ---- 3. the rendered rows: Dim slider, the brightness check, no Blur / See-through ------------
{
  const b = boot({ dark: { blurPx: 5, dim: 0.3, panel: -0.1 }, light: { blurPx: 0, dim: 0.3, panel: 0 }, render: 'picture' });
  ok('no Blur row', !q(b.field, '#set-glass-blur') && !b.field.querySelectorAll('label').some((l) => /^Blur$/.test(l.textContent)), b.field.querySelectorAll('label').map((l) => l.textContent));
  ok('no See-through row', !q(b.field, '#set-glass-see') && !b.field.querySelectorAll('label').some((l) => /See-through/.test(l.textContent)));
  ok('no Auto button', !q(b.field, '[data-glass-auto]'));
  const allText = () => b.field.querySelectorAll('*').map((n) => n.textContent).join(' ');
  ok('no Blur or See-through wording in the section', !/\bBlur\b|See-through/.test(allText()), allText().slice(0, 300));

  let dim = q(b.field, '#set-glass-dim');
  ok('the Dim slider runs 20% to 90% (floor 20%, decision 2026-11-24)', dim && String(dim.min) === '20' && String(dim.max) === '90', dim && [dim.min, dim.max]);
  const sw = () => q(b.field, '[data-glass-check]');
  ok('brightness check: a switch labelled "Brightness check"', sw() && sw().getAttribute('role') === 'switch' && /Brightness check/.test(sw().textContent), sw() && sw().attrs);
  ok('absent dimAuto reads as on', sw().getAttribute('aria-checked') === 'true', sw().attrs);
  ok('absent: the note says on', /^On: /.test(q(b.field, '[data-glass-check-note]').textContent), q(b.field, '[data-glass-check-note]').textContent);

  b.previews.length = 0;
  drag(dim, 24);
  const p = b.previews.filter((x) => x.g).pop();
  ok('Dim drag: preview has the value and no dimAuto key', p && p.t === 'dark' && p.g.dim === 0.24 && !('dimAuto' in p.g), b.previews);
  letGo(dim);
  let g = storedGlass(b).dark;
  ok('Dim change: stores the value, writes no dimAuto (absent stays absent)', g.dim === 0.24 && !('dimAuto' in g), g);
  ok('Dim change: blurPx and panel kept as stored', g.blurPx === 5 && g.panel === -0.1, g);
  ok('Dim change: the other theme untouched', !('dimAuto' in storedGlass(b).light) && storedGlass(b).light.dim === 0.3, storedGlass(b).light);
  ok('Dim change: preview cleared on let go', b.previews[b.previews.length - 1].g === null, b.previews.slice(-1));
  ok('after a Dim change the check is still on', sw().getAttribute('aria-checked') === 'true', sw().attrs);

  sw().click();
  g = storedGlass(b).dark;
  ok('check off: writes dimAuto false only (Dim, blur, panel kept)', g.dimAuto === false && g.dim === 0.24 && g.blurPx === 5 && g.panel === -0.1, g);
  ok('check off: the switch reads off', sw().getAttribute('aria-checked') === 'false', sw().attrs);
  const note = q(b.field, '[data-glass-check-note]');
  ok('check off: the note says the panels show the Dim only, in the warn colour', /^Off: .*Dim only/.test(note.textContent) && /set-look-warn/.test(note.className), [note.textContent, note.className]);
  dim = q(b.field, '#set-glass-dim');
  dim.value = '10'; letGo(dim);
  g = storedGlass(b).dark;
  ok('Dim change while off: dimAuto stays false (the slider never touches it)', g.dimAuto === false && g.dim === 0.2, g);
  ok('Dim set to 10% (out of range) is written as 0.20', g.dim === 0.2, g);
}

// ---- 4. a stored dimAuto false (an older Dim drag) reads as off and turns back on -------------
{
  const b = boot({ dark: { blurPx: 0, dim: 0.45, panel: 0, dimAuto: false }, light: { blurPx: 0, dim: 0.3, panel: 0 }, render: 'picture' });
  const sw = () => q(b.field, '[data-glass-check]');
  ok('stored false reads as off', sw().getAttribute('aria-checked') === 'false', sw().attrs);
  ok('stored false: the note says off', /^Off: /.test(q(b.field, '[data-glass-check-note]').textContent));
  sw().click();
  const g = storedGlass(b).dark;
  ok('toggling a stored false writes dimAuto true, Dim kept', g.dimAuto === true && g.dim === 0.45, g);
  ok('then it reads as on', sw().getAttribute('aria-checked') === 'true', sw().attrs);
  ok('a stored Dim wins (0.45 shown as 45)', String(q(b.field, '#set-glass-dim').value) === '45', q(b.field, '#set-glass-dim').value);
  const b2 = boot({ dark: { dim: 0.05 } });
  ok('a stored Dim under 20% shows as 20', String(q(b2.field, '#set-glass-dim').value) === '20', q(b2.field, '#set-glass-dim').value);
}

// ---- 5. light theme edits glass.light only -------------------------------------------------
{
  const b = boot({ dark: { blurPx: 0, dim: 0.3, panel: 0, dimAuto: false }, light: { blurPx: 0, dim: 0.3, panel: 0 }, render: 'picture' }, { light: true });
  const dim = q(b.field, '#set-glass-dim');
  dim.value = '40'; letGo(dim);
  ok('light: Dim change writes glass.light dim 0.40, no dimAuto', !('dimAuto' in storedGlass(b).light) && storedGlass(b).light.dim === 0.4, storedGlass(b).light);
  ok('light: glass.dark keeps its own choice', storedGlass(b).dark.dimAuto === false && storedGlass(b).dark.dim === 0.3, storedGlass(b).dark);
  q(b.field, '[data-glass-check]').click();
  ok('light: the check writes glass.light.dimAuto only', storedGlass(b).light.dimAuto === false && storedGlass(b).dark.dimAuto === false && storedGlass(b).light.dim === 0.4, storedGlass(b));
  const hint = b.field.querySelectorAll('.set-hint').map((n) => n.textContent).join(' ');
  ok('light hint: white tint, 20% to 90%, check not running in light yet', /white tint/.test(hint) && /20% to 90%/.test(hint) && /light theme yet/.test(hint), hint);
}

// ---- 6. the mode line -----------------------------------------------------------------------
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
  ok('no backdrop state: says so, not blank', /^Automatic: 0\.20, the background layer has not reported yet\.$/.test(note().textContent) && !note().hidden, note().textContent);
  b.backdrop.state = { glass: { theme: 'dark', text: '   ' } };
  b.w.doc.dispatchEvent({ type: 'backdropchange' });
  ok('empty text: not shown blank', note().textContent.trim().length > 0, note().textContent);
  // pure: a state for the other theme is not this theme's line
  const other = b.S._glassGuardText({ theme: 'light', text: 'Automatic: 0.30' }, 'dark', { dim: 0.25, dimAuto: false });
  ok('state for the other theme: not shown as this one; says manual + not reported', other === 'Manual: 0.25, the background layer has not reported yet.', other);
}

// ---- 7. the Dim on the slider = the Dim painted (CONTRACT: a stored Dim keeps its value) ----------
// The slider is settings.js's; the paint is backdrop.js paintGlass + frost.js effectiveDim over the same
// stored glass (glassFor's path when Look Sync does not answer).
{
  const B = require(path.join(__dirname, 'backdrop.js'));
  const F = require(path.join(__dirname, 'frost.js'));
  const src = require('fs').readFileSync(path.join(__dirname, 'settings.js'), 'utf8');
  ok("settings.js seeds the Dim from Look Sync's SEED (window.LookWash), 0.20 without it",
    /W\.SEED\.glass/.test(src) && /dim: seedDim\('dark'\)/.test(src) && /dim: seedDim\('light'\)/.test(src));
  {
    const w = makeWindow({ localStorage: fakeStorage({}), LookWash: { SEED: { glass: { dark: { dim: 0.35 }, light: { dim: 0.25 } } } } });
    w.load(path.join(__dirname, 'settings.js'));
    const d = w.win.Settings._defaults.glass;
    ok('the seed follows window.LookWash.SEED when it is loaded', d.dark.dim === 0.35 && d.light.dim === 0.25, d);
  }
  const cases = [
    ['nothing stored', undefined, 20, 0.2],
    ['stored 0.30', 0.3, 30, 0.3],
    ['stored 0.55', 0.55, 55, 0.55],
    ['stored 0.10', 0.1, 20, 0.2]
  ];
  for (const [name, v, slider, paint] of cases) {
    for (const theme of ['dark', 'light']) {
      const stored = v === undefined ? undefined
        : { dark: { blurPx: 0, dim: v, panel: 0 }, light: { blurPx: 0, dim: v, panel: 0 }, render: 'picture' };
      const b = boot(stored, theme === 'light' ? { light: true } : undefined);
      const el = q(b.field, '#set-glass-dim');
      const painted = B.paintGlass(b.S.get('glass')[theme], theme, F, false);
      ok(name + ' (' + theme + '): the slider shows ' + slider, el && Number(el.value) === slider, el && el.value);
      ok(name + ' (' + theme + '): the window paints ' + paint, painted.dim === paint, painted);
    }
  }
  // stored 0.10: a let-go of the slider never writes lower than 0.20
  {
    const b = boot({ dark: { blurPx: 0, dim: 0.1, panel: 0 }, light: { blurPx: 0, dim: 0.1, panel: 0 }, render: 'picture' });
    const el = q(b.field, '#set-glass-dim');
    drag(el, 10); letGo(el);
    ok('stored 0.10: a slider write is 0.20, never lower', storedGlass(b).dark.dim === 0.2, storedGlass(b).dark);
  }
  // the raw stored value counts: a stored 0.30 stays 0.30; a glass with no Dim paints the default
  {
    const p30 = B.paintGlass({ dim: 0.3 }, 'dark', F, true);
    ok('stored 0.30 through Look Sync: paints 0.30, labelled shared', p30.dim === 0.3 && p30.dimSource === 'shared', p30);
    const pNone = B.paintGlass({ blurPx: 0, panel: 0 }, 'dark', F, true);
    ok('no Dim in the stored glass: paints 0.20, labelled default', pNone.dim === 0.2 && pNone.dimSource === 'default' && /20%/.test(pNone.dimReason), pNone);
  }
  // the mode line under Dim: the default says why; a stored value is not called a default
  {
    const b = boot(undefined, { state: { glass: { theme: 'dark', text: 'Automatic: 0.20', dimSource: 'default', dimReason: 'no Dim is set, so Quartz uses its default 20%' } } });
    const note = q(b.field, '[data-glass-guard]');
    ok('mode line, nothing stored: names the default 20%', note.textContent === 'Automatic: 0.20 no Dim is set, so Quartz uses its default 20%.', note.textContent);
    const p = B.paintGlass({ dim: 0.3 }, 'dark', F, false);
    b.backdrop.state = { glass: { theme: 'dark', text: 'Automatic: 0.30', dimSource: p.dimSource, dimReason: p.dimReason } };
    b.w.doc.dispatchEvent({ type: 'backdropchange' });
    ok('mode line, stored 0.30: shows 0.30, no default or starting-Dim claim', note.textContent === 'Automatic: 0.30', note.textContent);
  }
}

console.log('settings-glass: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
