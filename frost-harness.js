// frost-harness.js - pure-node test for frost.js (run: node frost-harness.js).
// The islands' glass: which blur a panel gets, where the picture sits, the brightness check and
// the Dim Quartz paints. One summary line: "frost: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');
const F = require('./frost');

let pass = 0, fail = 0;
function check(ok, what, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + what + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}

/* ---- the knobs are the approved ones ---- */
check(F.BLURS.light === 6 && F.BLURS.soft === 15 && F.BITMAP_W === 512, 'blurs: light 6, soft 15 on a 512 px bitmap', F.BLURS);
check(F.BIG_MIN === 48 && F.BIG_AREA === 20000, 'big panel: short side 48, area 20000');
check(F.TARGET === 0.163 && F.FILM_STEP === 0.04 && F.FILM_MAX === 0.56 && F.FILM_RGB.join() === '10,12,14', 'brightness check: target .163, steps .04 to .56, rgb(10,12,14)');
check(F.GRID.cols === 8 && F.GRID.rows === 5 && F.LEGIBILITY_FLOOR === true, 'brightness check: on, 8 x 5 grid');
check(F.DIM_DEFAULT === 0.2, 'dim default 20%');

/* ---- which blur ---- */
check(F.kindFor(300, 100) === 'soft', 'a card 300x100 is big (soft)');
check(F.kindFor(400, 32) === 'light', 'a toolbar 400x32 is small (light): short side under 48');
check(F.kindFor(120, 120) === 'light', '120x120 is small: area 14400 under 20000');
check(F.kindFor(48, 417) === 'soft' && F.kindFor(47, 1000) === 'light', 'the short-side edge is 48');
check(F.kindFor(0, 0) === 'light' && F.kindFor('x', null) === 'light', 'nonsense sizes are small');

/* ---- cover geometry ---- */
{
  const g = F.coverGeometry({ left: 0, top: 0, width: 1000, height: 500 }, 2000, 2000);
  check(g && g.cw === 1000 && g.ch === 1000 && g.ox === 0 && g.oy === -250, 'cover: a square picture in a wide box is cropped top and bottom', g);
  const h = F.coverGeometry({ left: -100, top: 20, width: 1920, height: 1080 }, 1920, 1080);
  check(h && h.ox === -100 && h.oy === 20 && h.cw === 1920, 'cover: the box offset carries through (a lined-up monitor layer)', h);
  check(F.coverGeometry(null, 1, 1) === null && F.coverGeometry({ left: 0, top: 0, width: 10, height: 10 }, 0, 10) === null, 'cover: no box or no picture size -> null');
}

/* ---- luminance ---- */
check(Math.abs(F.lumOf([255, 255, 255], 0) - 1) < 1e-9 && F.lumOf([0, 0, 0], 0) === 0, 'luminance: white 1, black 0');
check(F.lumOf([255, 255, 255], 0.5) < F.lumOf([255, 255, 255], 0), 'a film darkens');

/* ---- the brightness check on a fake bitmap ---- */
function bitmap(w, h, fn) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fn(x, y), k = (y * w + x) * 4;
    px[k] = c[0]; px[k + 1] = c[1]; px[k + 2] = c[2]; px[k + 3] = 255;
  }
  return { w, h, px };
}
const geo = { ox: 0, oy: 0, cw: 1000, ch: 500 };
{
  const dark = bitmap(64, 32, () => [20, 30, 34]);
  check(F.filmFromPixels(dark, geo, { x: 10, y: 10, w: 400, h: 40 }, 0) === 0, 'over a dark area: no film at all');
  const white = bitmap(64, 32, () => [255, 255, 255]);
  const a = F.filmFromPixels(white, geo, { x: 10, y: 10, w: 400, h: 40 }, 0);
  check(a === F.FILM_MAX, 'over pure white: the most it may add (.56)', a);
  const sky = bitmap(64, 32, () => [170, 190, 200]);
  const b = F.filmFromPixels(sky, geo, { x: 10, y: 10, w: 400, h: 40 }, 0);
  check(b > 0 && b < F.FILM_MAX && F.lumOf([170, 190, 200], b) <= F.TARGET + 1e-9 && F.lumOf([170, 190, 200], b - F.FILM_STEP) > F.TARGET,
    'over a bright sky: just enough, in .04 steps, to reach .163', b);
  check(Math.abs(b / F.FILM_STEP - Math.round(b / F.FILM_STEP)) < 1e-9, 'the film is a whole number of steps', b);
  const dimmed = F.filmFromPixels(sky, geo, { x: 10, y: 10, w: 400, h: 40 }, 0.5);
  check(dimmed < b, 'the Dim counts: a dimmed picture needs less film', { b, dimmed });
  // left half bright, right half dark: a panel over the right half gets nothing
  const split = bitmap(64, 32, (x) => (x < 32 ? [250, 250, 250] : [15, 18, 20]));
  check(F.filmFromPixels(split, geo, { x: 600, y: 100, w: 300, h: 200 }, 0) === 0 && F.filmFromPixels(split, geo, { x: 50, y: 100, w: 300, h: 200 }, 0) > 0,
    'only what is behind THIS panel counts');
  // the brightest TENTH decides: one bright sample in forty is ignored
  const speck = bitmap(64, 32, (x, y) => (x === 4 && y === 3 ? [255, 255, 255] : [20, 24, 26]));
  check(F.filmFromPixels(speck, geo, { x: 0, y: 0, w: 1000, h: 500 }, 0) === 0, 'a single bright speck does not darken the panel');
  check(F.filmFromPixels(null, geo, { x: 0, y: 0, w: 10, h: 10 }, 0) === 0 && F.filmFromPixels(white, null, { x: 0, y: 0, w: 10, h: 10 }, 0) === 0,
    'no bitmap or no geometry yet: no film');
}

/* ---- the Dim Quartz paints ---- */
{
  const seed = F.effectiveDim({ dim: 0.3 }, false);
  check(seed.dim === 0.2 && seed.source === 'default', "Look Sync's untouched seed (.30) paints as 20%", seed);
  const mine = F.effectiveDim({ dim: 0.3 }, true);
  check(mine.dim === 0.3 && mine.source === 'saved', 'a Dim the user set by hand wins, even at .30', mine);
  const shared = F.effectiveDim({ dim: 0.45 }, false);
  check(shared.dim === 0.45 && shared.source === 'shared', 'any other shared Dim was a choice and wins', shared);
  check(F.effectiveDim(null, false).dim === 0.2 && F.effectiveDim({}, false).source === 'default', 'no Dim at all: 20%');
  check(typeof seed.reason === 'string' && /20%/.test(seed.reason), 'the reason says so in words', seed.reason);
}

/* ---- wiring: index.html loads frost.js before backdrop.js; backdrop reads effectiveDim ---- */
{
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const fi = html.indexOf('<script src="frost.js"></script>'), bi = html.indexOf('<script src="backdrop.js"></script>');
  check(fi > 0 && bi > fi, 'index.html: frost.js loads before backdrop.js', { fi, bi });
  const bjs = fs.readFileSync(path.join(__dirname, 'backdrop.js'), 'utf8');
  check(/F\.effectiveDim\(n, n\.dimAuto === false\)/.test(bjs), 'backdrop.js: the painted Dim comes from effectiveDim, a hand-set Dim counts as saved');
  const fjs = fs.readFileSync(path.join(__dirname, 'frost.js'), 'utf8');
  check(!/backdrop-filter/.test(fjs.replace(/\/\*[\s\S]*?\*\//g, '')), 'frost.js: no live backdrop-filter');
  check(!/LookSync\.(set|write|publish)/.test(fjs) && !/look\.json/.test(fjs.replace(/\/\*[\s\S]*?\*\//g, '')), 'frost.js never writes Look Sync');
}

/* ---- the Home guest: the chrome hands over its copies, the guest never blurs ---- */
{
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const has = (text, s) => text.indexOf(s) >= 0;
  check(has(app, 'function pushFrostToTab(tab)') && has(app, "pushFrostToTab(tab);  // the islands' glass"), 'app.js: every Home guest gets the glass on dom-ready');
  check(has(app, "addEventListener('frostchange'"), 'app.js: new copies go to every Home guest');
  check(has(app, "pushUnchanged(tab, 'frost-rev'") && has(app, "pushUnchanged(tab, 'frost-geo'"), 'app.js: the copies go once per rev, a move sends only the small part');
  const nh = fs.readFileSync(path.join(__dirname, 'newtab.html'), 'utf8');
  check(nh.indexOf('<script src="frost.js"></script>') > 0 && nh.indexOf('<script src="frost.js"></script>') < nh.indexOf('<script src="newtab.js"></script>'), 'newtab.html loads frost.js before newtab.js');
  const fjs = fs.readFileSync(path.join(__dirname, 'frost.js'), 'utf8');
  check(has(fjs, 'var DATA_JPEG = /^data:image\\/jpeg;base64,') && has(fjs, 'MAX_DATA'), 'the guest takes only data:image/jpeg copies, size-capped');
  check(has(fjs, "if (chromeMode) return { ok: false"), 'the chrome never takes pushed copies');
  const ncss = fs.readFileSync(path.join(__dirname, 'newtab.css'), 'utf8');
  const tail = ncss.slice(ncss.indexOf('The floating islands on the Home'));
  check(has(tail, '.module.frost') && /\.search\.frost \.search-input \{[^}]*backdrop-filter: none/.test(tail), 'Home cards and the search box are islands; the search field has no live blur');
  const njs = fs.readFileSync(path.join(__dirname, 'newtab.js'), 'utf8');
  check(has(njs, 'function frostHome()') && has(njs, '.module[data-kind="card"], #search'), 'newtab.js marks every card and the search box');
}

/* ---- the Home's chips and Saved tiles: islands by selector, no live blur ---- */
{
  const njs = fs.readFileSync(path.join(__dirname, 'newtab.js'), 'utf8');
  check(njs.indexOf("window.Frost.watch('.chip');") >= 0 && njs.indexOf("window.Frost.watch('.rtile');") >= 0, 'newtab.js has frost.js line up the chips and Saved tiles');
  const ncss = fs.readFileSync(path.join(__dirname, 'newtab.css'), 'utf8');
  const tail = ncss.slice(ncss.indexOf('The shortcut chips and the Saved tiles: small islands'));
  check(/backdrop-filter: none/.test(tail) && /--frost-hover/.test(tail), 'chips and tiles: no live blur, a fill only on hover');
  const fjs = fs.readFileSync(path.join(__dirname, 'frost.js'), 'utf8');
  check(fjs.indexOf('document.querySelectorAll(selector)') >= 0 && fjs.indexOf("document.querySelectorAll('.frost')") < 0, 'frost.js places by one selector, .frost plus what a page watches');
}

/* ---- no silent default: Settings says when Quartz paints 20% over the shared seed ---- */
{
  const bjs = fs.readFileSync(path.join(__dirname, 'backdrop.js'), 'utf8');
  check(bjs.indexOf('dimSource: g.dimSource || null,') >= 0 && bjs.indexOf('dimReason: g.dimReason || null,') >= 0, 'Backdrop.state().glass carries the painted Dim\'s source and reason');
  const sjs = fs.readFileSync(path.join(__dirname, 'settings.js'), 'utf8');
  check(sjs.indexOf("gl.dimSource === 'default' && gl.dimReason") >= 0, 'Settings adds the reason under the Dim when Quartz paints its default');
}

console.log('frost: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
