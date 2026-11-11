// backdrop-harness.js — pure-node test for the window's background layer rule (run: node backdrop-harness.js).
//   1. backdrop.js homeReason(): the picture shows UNBLURRED (Helm's Home look) whenever the window has a
//      still picture, for every still kind and state, and says why when it cannot. Which tab is in front
//      is not an input, so the top band cannot change with the front tab.
//   2. The wiring, read from the source: nothing in the renderer tells the backdrop which tab is in front
//      any more (no setHome), app.js's syncHomeLayer only keeps new tab guests see-through, and the
//      blurred layer still stops drawing once the sharp copy covers it.
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
  ok(/body\[data-bg-home\] #titlebar \{ border-bottom-color: transparent; \}/.test(ccss), 'chrome.css: hairlines follow data-bg-home only');
  ok(!/A web page in front brings them back|A web\s+page in front, or a split, puts the blurred layer back/.test(appJs + ccss),
    'the old "a web page in front puts the blurred layer back" comments are gone');
} catch (e) {
  fail++;
  fails.push('HARNESS ERROR ' + (e && e.stack || e));
}

if (fails.length) console.log(fails.map((f) => 'FAIL ' + f).join('\n'));
console.log(`backdrop: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
