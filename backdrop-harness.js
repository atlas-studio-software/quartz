// backdrop-harness.js — pure-node test for the window's background layer rule (run: node backdrop-harness.js).
//   1. backdrop.js homeReason(): the picture shows UNBLURRED (Helm's Home look) whenever the window has a
//      still picture, for every still kind and state, and says why when it cannot. Which tab is in front
//      is not an input, so the top band cannot change with the front tab.
//   2. The wiring, read from the source: nothing in the renderer tells the backdrop which tab is in front
//      any more (no setHome), app.js's syncHomeLayer only keeps new tab guests see-through, and the
//      blurred layer still stops drawing once the sharp copy covers it.
//   3. The tint (CONTRACT "2026-11-11: sharp painted glass + tint override"): washFrom() over the vendored
//      look-sync washAlpha (looksync/wash.browser.js): Manual = exactly the Dim; Automatic = max(Dim,
//      Mantle's guard) when valid, at the STORED blur too (blur 5 while Quartz paints sharp), else the
//      Dim with the reason; Quartz's own picture keeps its own dark check; every answer has its row text.
//   4. Sharp and the same in every state: no blur and no saturate on the bitmap whatever the synced blur,
//      no Home-only scrim, hairlines gone whenever a picture is up.
// No Electron, no DOM. Prints one summary line: "backdrop: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, got) {
  if (cond) pass++;
  else { fail++; fails.push(name + (got !== undefined ? '  got: ' + JSON.stringify(got) : '')); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

try {
  /* ---- 1. the rule --------------------------------------------------- */
  const B = require(path.join(__dirname, 'backdrop.js'));
  ok(B && typeof B.homeReason === 'function', 'backdrop.js loads in plain node and exports homeReason');
  const R = B.homeReason;
  ok(R.length === 5, 'homeReason takes kind, state, reason, hasShown, hasClear (no front-tab input)', R.length);

  for (const kind of ['desktop', 'builtin', 'image']) {
    for (const state of ['ok', 'fallback', 'loading']) {
      // a picture on the layer with its sharp copy: shown, whatever the state says
      ok(R(kind, state, state === 'fallback' ? 'the wallpaper stands in' : null, true, true) === null,
        kind + ' / ' + state + ' with a picture: unblurred', R(kind, state, null, true, true));
    }
    const prep = R(kind, 'loading', null, false, false);
    ok(/being prepared/.test(prep || ''), kind + ' still loading: blurred/plain meanwhile, and says so', prep);
    const noClear = R(kind, 'ok', null, true, false);
    ok(/being prepared/.test(noClear || ''), kind + ' blurred picture up, sharp copy not ready: says so', noClear);
    const fb = R(kind, 'fallback', 'no wallpaper file', false, false);
    ok(/no picture could be shown \(no wallpaper file\)/.test(fb || ''), kind + ' fallback with nothing shown: reason carried', fb);
    const fb2 = R(kind, 'fallback', null, false, false);
    ok(fb2 === 'no picture could be shown', kind + ' fallback with no reason: still says it', fb2);
  }
  const vid = R('video', 'ok', null, true, true);
  ok(typeof vid === 'string' && /clip/.test(vid), 'a clip keeps its blurred still (same with any tab in front), and says why', vid);
  const none = R('none', 'ok', null, false, false);
  ok(none === 'no picture is chosen', 'Plain: no picture, says so', none);
  ok(typeof R('wallpaper', 'ok', null, true, true) === 'string', 'an unknown kind never shows the sharp layer');
  // Deterministic: the same inputs always give the same answer (nothing hidden, e.g. the front tab).
  ok(R('desktop', 'ok', null, true, true) === R('desktop', 'ok', null, true, true), 'same inputs, same answer');

  /* ---- 2. the wiring ------------------------------------------------- */
  const appJs = read('app.js');
  const bjs = read('backdrop.js');
  const bcss = read('backdrop.css');
  const ccss = read('chrome.css');

  const start = appJs.indexOf('function syncHomeLayer()');
  ok(start > 0, 'app.js has syncHomeLayer');
  const body = appJs.slice(start, appJs.indexOf('\n}\n', start));
  ok(/classList\.toggle\('own-layer'/.test(body), 'syncHomeLayer keeps .own-layer on new tab guests', body.slice(0, 200));
  ok(!/Backdrop|setHome|getActiveTab|splitPartner/.test(body), 'syncHomeLayer no longer tells the backdrop which tab is in front', body.slice(0, 400));

  const callers = fs.readdirSync(__dirname).filter((f) => /\.js$/.test(f) && f !== 'backdrop-harness.js')
    .filter((f) => /\.setHome\(|setHome:\s/.test(read(f)));
  ok(callers.length === 0, 'no renderer file calls or exposes Backdrop.setHome', callers);

  const why = bjs.slice(bjs.indexOf('function homeWhyNot()'), bjs.indexOf('\n  }\n', bjs.indexOf('function homeWhyNot()')));
  ok(/return homeReason\(current\.kind, current\.state, current\.reason, !!shown, !!\(shown && shown\.clearUrl\)\)/.test(why),
    'homeWhyNot is homeReason over the layer state only', why);
  ok(!/home\.want|want:/.test(bjs.slice(bjs.indexOf("Helm's Home look"), bjs.indexOf('/* --- decoding'))),
    'backdrop.js Home section keeps no "want" (front tab) flag');
  ok(/home: \{ on, reason \}/.test(bjs), 'backdrop.js header documents state().home as { on, reason }');

  ok(/body\[data-bg-home\] \.backdrop > \.bg-photo \{\s*visibility: hidden;/.test(bcss),
    'backdrop.css: the covered blurred layer stops drawing');
  ok(!/blur\(/.test(bcss.replace(/\/\*[\s\S]*?\*\//g, '')), 'backdrop.css: no CSS blur filter on a full-window layer');
  ok(/\.backdrop > \.bg-clear\[data-on="in"\] \{ animation: bg-home-in 280ms var\(--ease\) backwards; \}/.test(bcss),
    'backdrop.css: the fade-in leaves no animation attached at rest (backwards)');
  ok(/body\[data-bg-home\] #titlebar,\s*body\[data-bg-state="ok"\]:not\(\[data-bg-kind="none"\]\) #titlebar \{ border-bottom-color: transparent; \}/.test(ccss),
    'chrome.css: the strip hairline goes whenever a picture is up (full-size copy or the small one), not per state');
  ok(/body\[data-bg-state="ok"\]:not\(\[data-bg-kind="none"\]\) \.navrow \{ border-bottom-color: transparent; \}/.test(ccss) &&
    /body\[data-bg-state="ok"\]:not\(\[data-bg-kind="none"\]\) #well \{ border-top-color: transparent; \}/.test(ccss),
    'chrome.css: the toolbar and well hairlines follow the same rule');
  ok(!/A web page in front brings them back|A web\s+page in front, or a split, puts the blurred layer back/.test(appJs + ccss),
    'the old "a web page in front puts the blurred layer back" comments are gone');

  /* ---- 3. the tint ---------------------------------------------------- */
  global.window = {};
  require(path.join(__dirname, 'looksync', 'wash.browser.js'));
  const W = global.window.LookWash;
  ok(W && typeof W.washAlpha === 'function', 'looksync/wash.browser.js leaves window.LookWash.washAlpha');
  ok(/<script src="looksync\/wash\.browser\.js"><\/script>/.test(read('index.html')) &&
    read('index.html').indexOf('looksync/wash.browser.js') < read('index.html').indexOf('src="backdrop.js"'),
    'index.html loads wash.browser.js before backdrop.js');
  const { washFrom, deskForWashFrom, normGlass, SEED_GLASS, BITMAP_BLUR_PX } = B;
  ok(typeof washFrom === 'function' && typeof deskForWashFrom === 'function', 'backdrop.js exports washFrom and deskForWashFrom in node');
  ok(SEED_GLASS.dark.dim === 0.3 && SEED_GLASS.light.dim === 0.3 && SEED_GLASS.dark.blurPx === 0 && SEED_GLASS.light.blurPx === 0,
    'seeds: Dim .30 and blur 0 in both themes', SEED_GLASS);
  ok(normGlass({ dim: 0.4, dimAuto: false }, 'dark').dimAuto === false && !('dimAuto' in normGlass({ dim: 0.4, dimAuto: 'no' }, 'dark')),
    'normGlass keeps a boolean dimAuto and drops anything else');

  const still = 'file:///still.png?rev=4';
  const deskOk = (guard, light) => Object.assign({ state: 'ok', stillUrl: still }, light ? { guardLight: guard } : { guard: guard });
  const band = (alpha, dim, blurPx) => ({ alpha: alpha, dim: dim, blurPx: blurPx, contrast: 4.4 });
  const glass = (o) => Object.assign({ blurPx: 5, dim: 0.3, panel: 0 }, o || {});
  const pre = (d, theme) => deskForWashFrom('desktop', true, d, 'desktop|' + still, theme || 'dark');

  // Automatic, Mantle's guard at the STORED blur 5 (Quartz paints sharp regardless): valid, raises.
  let w = washFrom(W, glass(), 'dark', pre(deskOk(band(0.46, 0.3, 5))), null);
  ok(w.alpha === 0.46 && w.mode === 'auto' && w.raised && w.source === 'shared',
    'auto: a guard worked out at the stored blur 5 is valid and raises the tint', w);
  ok(w.text === 'Automatic: 0.30, raised to 0.46 so text stays readable over this picture', 'auto raised: the row says so', w.text);
  w = washFrom(W, glass(), 'dark', pre(deskOk(band(0.3, 0.3, 5))), null);
  ok(w.alpha === 0.3 && !w.raised && w.source === 'shared' && /text already reads/.test(w.text), 'auto: a valid guard at the Dim leaves it', w.text);
  w = washFrom(W, glass({ blurPx: 0 }), 'dark', pre(deskOk(band(0.46, 0.3, 5))), null);
  ok(w.alpha === 0.3 && w.source === 'dim' && /blur 5 px, not this Dim 0\.30 and blur 0 px/.test(w.reason),
    'auto: a guard for another blur is stale: the Dim, and the row says why', w.text);
  w = washFrom(W, glass({ dim: 0.5 }), 'light', pre(deskOk(band(0.55, 0.5, 5), true), 'light'), null);
  ok(w.alpha === 0.55 && w.raised && w.source === 'shared', 'auto light: guard.light raises the white tint', w);

  // Manual: exactly the Dim, the guard ignored.
  w = washFrom(W, glass({ dim: 0.2, dimAuto: false }), 'dark', pre(deskOk(band(0.8, 0.2, 5))), null);
  ok(w.alpha === 0.2 && w.mode === 'manual' && w.source === 'manual' && w.text === 'Manual: 0.20', 'manual: exactly the Dim, row "Manual: 0.20"', w);
  w = washFrom(W, glass({ dim: 0.25, dimAuto: false }), 'dark', deskForWashFrom('builtin', true, null, 'builtin|x', 'dark'), { alpha: 0.7, ratio: 4.2 });
  ok(w.alpha === 0.25 && w.mode === 'manual', 'manual over an own picture: Quartz\'s own check is ignored too', w);

  // Automatic fallbacks: the Dim, with Quartz's own reasons first.
  const fb = [
    [deskForWashFrom('none', true, null, null, 'dark'), /no picture is shown/],
    [deskForWashFrom('desktop', false, deskOk(band(0.6, 0.3, 5)), 'desktop|' + still, 'dark'), /Look Sync is off/],
    [deskForWashFrom('desktop', true, { state: 'fallback', reason: 'x' }, 'desktop|windows-wallpaper', 'dark'), /Windows' wallpaper, not Mantle's/],
    [deskForWashFrom('desktop', true, deskOk(band(0.6, 0.3, 5)), 'desktop|file:///old.png?rev=3', 'dark'), /still being prepared/],
    [deskForWashFrom('desktop', true, Object.assign(deskOk(null), { guardReason: "Mantle couldn't work out the shared value (decode)" }), 'desktop|' + still, 'dark'), /couldn't work out the shared value \(decode\)/],
    [deskForWashFrom('desktop', true, Object.assign(deskOk(null, true), { guardLightReason: 'light top band not published by Mantle yet' }), 'desktop|' + still, 'light'), /light top band not published/]
  ];
  fb.forEach(([p, re], i) => {
    const r = washFrom(W, glass(), i === fb.length - 1 ? 'light' : 'dark', p, null);
    ok(r.alpha === 0.3 && r.mode === 'auto' && !r.raised && r.source === 'dim' && re.test(r.reason) && /^Automatic: 0\.30, not raised: /.test(r.text),
      'auto fallback ' + i + ': the Dim, with the reason ' + re, r.text);
  });

  // Quartz's own picture: dark keeps its own check (max with the Dim), light says it has none.
  w = washFrom(W, glass(), 'dark', deskForWashFrom('image', true, null, 'image|1', 'dark'), { alpha: 0.52, ratio: 4.21 });
  ok(w.alpha === 0.52 && w.raised && w.source === 'own' && /worked out by Quartz: the background is Quartz's own picture/.test(w.text),
    'own picture, dark, auto: Quartz\'s own check raises it and says so', w.text);
  w = washFrom(W, glass(), 'light', deskForWashFrom('image', true, null, 'image|1', 'light'), { alpha: 0.52, ratio: 4.21 });
  ok(w.alpha === 0.3 && w.source === 'dim' && /own picture/.test(w.reason), 'own picture, light: the Dim, with the reason', w.text);
  // The shared rule missing (script did not load): the Dim, said.
  w = washFrom(null, glass(), 'dark', pre(deskOk(band(0.6, 0.3, 5))), null);
  ok(w.alpha === 0.3 && /wash\.browser\.js\) did not load/.test(w.text), 'no LookWash: the Dim unraised, and the row says why', w.text);

  /* ---- 4. sharp, the same in every state ------------------------------ */
  ok(BITMAP_BLUR_PX === 0, 'the bitmap blur is 0 (sharp)');
  const planSrc = bjs.slice(bjs.indexOf('  function plan(cfg) {'), bjs.indexOf('  /** A desktop fallback whose reason changed'));
  ok(/blurPx: BITMAP_BLUR_PX, saturate: 100/.test(planSrc) && !/glassFor\(/.test(planSrc),
    'plan(): the bitmap is never blurred or saturated, whatever the synced blur (it reads no glass)', planSrc.slice(0, 300));
  ok(!/LIGHT_SATURATE/.test(bjs), 'no saturate constant left in backdrop.js');
  ok(/saturate: 100,/.test(bjs.slice(bjs.indexOf('function glassSnapshot()'), bjs.indexOf('function glassKeyOf('))),
    'state().glass.saturate is 100 in both themes');
  const cssCode = bcss.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/::after/.test(cssCode) && !/96px/.test(cssCode), 'backdrop.css: no Home-only scrim (::after) left');
  ok(!/saturate\(/.test(cssCode), 'backdrop.css: no saturate()');
  ok(/var\(--chrome-glass-a, 0\.3\)\)/.test(cssCode) && !/var\(--chrome-glass-a, 0\.(5|45)\)/.test(cssCode),
    'backdrop.css: the wash fallback is the seed Dim .30 in both themes');
} catch (e) {
  fail++;
  fails.push('HARNESS ERROR ' + (e && e.stack || e));
}

if (fails.length) console.log(fails.map((f) => 'FAIL ' + f).join('\n'));
console.log(`backdrop: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
