// tests/lift-vectors-test.js - the shared v2.1 brightness-check vectors through Quartz (run: node tests/lift-vectors-test.js).
// tests/fixtures/lift-v2.json (dark) and lift-light.json (light) are look-sync's shared vectors, copied
// unchanged (CONTRACT "2026-11-24: the islands look (v2)", v2.1: every port passes every vector of the
// themes it draws).
//   Dark: every vector goes through Quartz's dark path as the page loads it: looksync/wash.browser.js ->
//   brightcheck.js -> frost.js, the 40 samples painted into a bitmap at the panel's liftPoints and read
//   back by frost.js filmFromPixels. Also straight through brightcheck.js in node, and with the check
//   off (always 0).
//   Light: the vendored liftAlpha(samples, dim, 'light') passes every light vector, but Quartz does
//   not draw the light lift yet (today's light look), so nothing in Quartz calls it in light.
// One summary line: "lift-vectors: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(ok, what, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + what + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const dark = JSON.parse(read('tests/fixtures/lift-v2.json'));
const light = JSON.parse(read('tests/fixtures/lift-light.json'));

check(dark.rev === '2.1' && dark.theme === 'dark' && dark.vectors.length === 27, 'lift-v2.json: rev 2.1, dark, 27 vectors', [dark.rev, dark.theme, dark.vectors.length]);
check(light.rev === '2.1' && light.theme === 'light' && light.vectors.length === 29, 'lift-light.json: rev 2.1, light, 29 vectors', [light.rev, light.theme, light.vectors.length]);

/* ---- the page's way in: wash.browser.js, brightcheck.js, frost.js in one window-like context ---- */
const ctx = { console, Math, JSON, Number, Array, Object, isFinite, Uint8ClampedArray };
ctx.window = ctx; ctx.self = ctx;
vm.createContext(ctx);
for (const f of ['looksync/wash.browser.js', 'brightcheck.js', 'frost.js']) vm.runInContext(read(f), ctx, { filename: f });
const PB = ctx.BrightCheck, PF = ctx.Frost;
check(PB && PB.ok === true && PF && PF.check === 'on', 'page: brightcheck.js found look-sync\'s check on window.LookWash; frost.js says on', PF && PF.check);
const LIFT = ctx.LookWash.LIFT;
check(LIFT.target === 0.066 && LIFT.max === 0.72 && LIFT.step === 0.04 && LIFT.rgb.join() === '10,12,14' &&
      LIFT.light.target === 0.386 && LIFT.light.rgb.join() === '244,247,248', 'the vendored LIFT is v2.1', LIFT);
check(JSON.stringify(dark.lift) === JSON.stringify(LIFT), 'the vectors were made for the vendored LIFT', dark.lift);

/** The 40 samples painted into a bitmap, cell (i, j) = sample i * rows + j (liftPoints' order). */
function paint(samples, k) {
  const cols = LIFT.cols, rows = LIFT.rows, w = cols * k, h = rows * k, px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = samples[Math.floor(x / k) * rows + Math.floor(y / k)], q = (y * w + x) * 4;
    px[q] = s[0]; px[q + 1] = s[1]; px[q + 2] = s[2]; px[q + 3] = 255;
  }
  return { w, h, px };
}
const whole = (s) => s.every((c) => c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255));

/* ---- dark: Quartz's dark path ---- */
{
  const B = require(path.join(ROOT, 'brightcheck.js'));
  let ok = 0, bad = 0;
  for (const v of dark.vectors) {
    const k = 10, bmp = paint(v.samples, k);
    const geo = { ox: 0, oy: 0, cw: bmp.w, ch: bmp.h }, rect = { x: 0, y: 0, w: bmp.w, h: bmp.h };
    const back = PF.samplesFromPixels(bmp, geo, rect);
    const page = PF.filmFromPixels(bmp, geo, rect, v.dim, true);
    const node = B.alphaFor(v.samples, v.dim);
    const lift = B.filmFor(v.samples, v.dim, true);
    const off = PF.filmFromPixels(bmp, geo, rect, v.dim, false);
    const good = whole(v.samples) && JSON.stringify(back) === JSON.stringify(v.samples) &&
      page === v.alpha && node === v.alpha && lift.alpha === v.alpha && lift.check === 'on' && off === 0;
    if (good) ok++; else bad++;
    check(good, 'lift-v2 "' + v.name + '": ' + v.alpha, { page, node, lift: lift.alpha, off, samplesBack: JSON.stringify(back) === JSON.stringify(v.samples) });
  }
  console.log("lift-v2 (dark, Quartz's dark path): " + ok + ' passed, ' + bad + ' failed');
  const white = dark.vectors.find((v) => /white everywhere at the seed Dim/.test(v.name));
  check(white && white.dim === 0.2 && B.alphaFor(white.samples, 0.2) === 0.72, 'a white picture at Dim .20 gets .72 (was .48)');
}

/* ---- light: the vendored liftAlpha passes, Quartz does not draw it ---- */
{
  const LS = require(path.join(ROOT, 'looksync', 'look-sync.js'));
  let ok = 0, bad = 0;
  for (const v of light.vectors) {
    const a = LS.liftAlpha(v.samples, v.dim, 'light');
    const b = ctx.LookWash.liftAlpha(v.samples, v.dim, 'light');
    const p = LS.panelLift({ glass: { light: { dim: Math.max(0.2, v.dim) } } }, 'light', v.samples);
    const good = a === v.alpha && b === v.alpha && p.film.join() === '244,247,248';
    if (good) ok++; else bad++;
    check(good, 'lift-light "' + v.name + '": ' + v.alpha, { node: a, page: b });
  }
  console.log('lift-light (light, vendored liftAlpha, not wired into Quartz): ' + ok + ' passed, ' + bad + ' failed');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const bjs = strip(read('brightcheck.js')), fjs = strip(read('frost.js'));
  check(!/'light'/.test(bjs) && /liftAlpha\(samples, dim, 'dark'\)/.test(bjs), "brightcheck.js only ever asks for the dark film");
  check(!/panelLift|liftAlpha/.test(fjs) && /!light && checkOn \? filmFromPixels\(/.test(fjs), 'frost.js never calls the light lift, and lays no film in light');
}

/* ---- the film laid is the check's film, per channel ---- */
{
  const tokens = read('tokens.css');
  const m = /--island-film-rgb:\s*(\d+) (\d+) (\d+);/.exec(tokens);
  check(m && [m[1], m[2], m[3]].join() === LIFT.rgb.join(), "tokens.css --island-film-rgb is LIFT.rgb (the film the check works out)", m && m.slice(1));
  for (const f of ['islands.css', 'newtab.css']) {
    check(/rgb\(var\(--island-film-rgb\) \/ var\(--film, 0\)\)/.test(read(f)), f + ': the film is rgb(--island-film-rgb) at --film, mixed per channel');
  }
}

/* ---- the check missing is said, never silent ---- */
{
  const bare = { console, Math, JSON, Number, Array, Object, isFinite };
  bare.window = bare; bare.self = bare;
  vm.createContext(bare);
  for (const f of ['brightcheck.js', 'frost.js']) vm.runInContext(read(f), bare, { filename: f });
  check(bare.BrightCheck.ok === false && bare.BrightCheck.alphaFor([[255, 255, 255]], 0.2) === 0, 'no wash.browser.js: no film');
  check(/^off: .*did not load/.test(bare.Frost.check), 'no wash.browser.js: frost.js says the check is off and why', bare.Frost.check);
  const nh = read('newtab.html'), ih = read('index.html');
  for (const [name, h] of [['newtab.html', nh], ['index.html', ih]]) {
    const w = h.indexOf('<script src="looksync/wash.browser.js"></script>'), b = h.indexOf('<script src="brightcheck.js"></script>');
    check(w > 0 && b > w, name + ': wash.browser.js loads before brightcheck.js', { w, b });
  }
}

console.log('lift-vectors: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
