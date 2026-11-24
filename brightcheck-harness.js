// brightcheck-harness.js - pure-node test for brightcheck.js (run: node brightcheck-harness.js).
// The islands' brightness check as one pure function: alphaFor(8 x 5 luminance grid, dim) -> alpha.
// One summary line: "brightcheck: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');
const B = require('./brightcheck');

let pass = 0, fail = 0;
function check(ok, what, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + what + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}
const grid = (fn) => { const lum = []; for (let j = 0; j < 5; j++) for (let i = 0; i < 8; i++) lum.push(fn(i, j)); return { cols: 8, rows: 5, lum }; };
const flat = (l) => grid(() => l);
const steps = (a) => Math.abs(a / B.FILM_STEP - Math.round(a / B.FILM_STEP)) < 1e-9;

/* ---- the decided numbers (2026-11-24) ---- */
check(B.COLS === 8 && B.ROWS === 5, '8 x 5 grid');
check(B.TARGET === 0.163 && B.FILM_STEP === 0.04 && B.FILM_MAX === 0.56 && B.FILM_RGB.join() === '10,12,14', 'target .163, steps .04, cap .56, rgb(10,12,14)');

/* ---- the rule ---- */
check(B.alphaFor(flat(0), 0) === 0 && B.alphaFor(flat(0.02), 0.2) === 0, 'over dark: 0');
check(B.alphaFor(flat(0.163), 0) === 0, 'exactly at the target: 0');
check(B.alphaFor(flat(1), 0) === B.FILM_MAX, 'over white, no Dim: the cap .56');
{
  const a = B.alphaFor(flat(0.5), 0);
  check(a > 0 && a < B.FILM_MAX && steps(a), 'a bright sky: some film, whole steps', a);
  check(B.lumUnder(0.5, 0, a) <= B.TARGET + 1e-9 && B.lumUnder(0.5, 0, a - B.FILM_STEP) > B.TARGET, 'just enough: one step less misses the target', a);
  const d = B.alphaFor(flat(0.5), 0.2);
  check(d < a, 'the Dim counts: dimmed by 20% needs less film', { a, d });
  check(B.alphaFor(flat(0.5), 0.9) === 0, 'Dim 90%: the picture is dark enough, 0');
}
{
  // the brightest TENTH decides: 4 bright samples of 40 are ignored, the 5th is not
  const four = grid((i, j) => (j === 0 && i < 4 ? 1 : 0.01));
  const five = grid((i, j) => (j === 0 && i < 5 ? 1 : 0.01));
  check(B.alphaFor(four, 0) === 0, 'four bright samples in forty: ignored');
  check(B.alphaFor(five, 0) === B.FILM_MAX, 'five bright samples in forty: the brightest tenth is bright');
  const order = grid((i, j) => (i === 7 && j === 4 ? 1 : 0.4));
  const shuffled = { cols: 8, rows: 5, lum: order.lum.slice().reverse() };
  check(B.alphaFor(order, 0) === B.alphaFor(shuffled, 0), 'sample order does not matter');
}
check(B.alphaFor(flat(2), 0) === B.FILM_MAX && B.alphaFor(flat(-1), 0) === 0, 'luminance outside 0..1 is clamped');

/* ---- bad input: 0, never throws ---- */
{
  let threw = false, r = [];
  try {
    r = [B.alphaFor(null, 0), B.alphaFor({}, 0), B.alphaFor({ cols: 8, rows: 5, lum: [1, 1] }, 0),
         B.alphaFor({ cols: 4, rows: 10, lum: flat(1).lum }, 0), B.alphaFor(grid(() => NaN), 0), B.alphaFor(flat(1), 'x')];
  } catch (e) { threw = true; }
  check(!threw && r.slice(0, 5).every((a) => a === 0), 'no grid, a short grid, another shape or NaN: 0', r);
  check(!threw && r[5] === B.FILM_MAX, 'a nonsense Dim reads as none', r[5]);
}

/* ---- it stands alone, so look-sync v2's vendored check can replace it ---- */
{
  const src = fs.readFileSync(path.join(__dirname, 'brightcheck.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  check(!/\brequire\(|\bdocument\b|\bwindow\b|localStorage|LookSync/.test(src), 'brightcheck.js: no require, DOM, storage or Look Sync');
  const frost = fs.readFileSync(path.join(__dirname, 'frost.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  check(/BC\.alphaFor\(grid, dim\)/.test(frost) && !/lumOf\(bright/.test(frost), 'frost.js uses alphaFor and has no brightness loop of its own');
  for (const page of ['index.html', 'newtab.html']) {
    const h = fs.readFileSync(path.join(__dirname, page), 'utf8');
    const b = h.indexOf('<script src="brightcheck.js"></script>'), f = h.indexOf('<script src="frost.js"></script>');
    check(b > 0 && f > b, page + ': brightcheck.js loads before frost.js', { b, f });
  }
}

/* ---- frost.js on a grey bitmap gives the same answer as alphaFor on its grid ---- */
{
  const F = require('./frost');
  check(F.check === 'on', 'frost.js found the check', F.check);
  const w = 64, h = 32, px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = (y * w + x) * 4, v = x < 32 ? 200 : 40; px[k] = px[k + 1] = px[k + 2] = v; px[k + 3] = 255; }
  const geo = { ox: 0, oy: 0, cw: 1000, ch: 500 }, rect = { x: 0, y: 0, w: 1000, h: 500 };
  const g = F.gridFromPixels({ w, h, px }, geo, rect);
  check(g && g.cols === 8 && g.rows === 5 && g.lum.length === 40, 'frost.js samples an 8 x 5 grid', g && g.lum.length);
  check(g && g.lum[0] > g.lum[7], 'the grid is row by row, left to right (left half bright)', g && [g.lum[0], g.lum[7]]);
  check(F.filmFromPixels({ w, h, px }, geo, rect, 0.2) === B.alphaFor(g, 0.2), 'frost film = alphaFor(grid, dim)');
}

console.log('brightcheck: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
