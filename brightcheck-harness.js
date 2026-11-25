// brightcheck-harness.js - pure-node test for brightcheck.js (run: node brightcheck-harness.js).
// The islands' brightness check (dark): a thin adapter over look-sync's own v2.1 liftAlpha, full RGB.
// The shared vectors are tests/lift-vectors-test.js. One summary line: "brightcheck: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');
const B = require('./brightcheck');
const LS = require('./looksync/look-sync');

let pass = 0, fail = 0;
function check(ok, what, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + what + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}
const flat = (rgb) => Array.from({ length: 40 }, () => rgb.slice());
const steps = (a) => Math.abs(a / B.FILM_STEP - Math.round(a / B.FILM_STEP)) < 1e-9;

/* ---- the v2.1 numbers, from the vendored look-sync ---- */
check(B.ok === true && B.missing === '', 'the shared check loaded');
check(B.COLS === 8 && B.ROWS === 5 && B.QUANTILE === 0.1, '8 x 5 samples, the brightest tenth');
check(B.TARGET === 0.066 && B.FILM_STEP === 0.04 && B.FILM_MAX === 0.72 && B.FILM_RGB.join() === '10,12,14', 'v2.1: target .066, steps .04, cap .72, rgb(10,12,14)');
check(B.TARGET === LS.LIFT.target && B.FILM_MAX === LS.LIFT.max, 'the numbers are LIFT itself');

/* ---- the rule ---- */
check(B.alphaFor(flat([0, 0, 0]), 0.2) === 0 && B.alphaFor(flat([20, 30, 45]), 0.2) === 0, 'over dark: 0');
check(B.alphaFor(flat([255, 255, 255]), 0.2) === 0.72, 'over white at Dim .20: .72 (was .48)');
check(B.alphaFor(flat([255, 255, 255]), 0.9) === 0, 'Dim 90%: the picture is dark enough, 0');
{
  const a = B.alphaFor(flat([170, 190, 200]), 0.2);
  check(a > 0 && a <= B.FILM_MAX && steps(a), 'a bright sky: some film, whole steps', a);
  check(B.alphaFor(flat([170, 190, 200]), 0.5) < a, 'the Dim counts: more Dim, less film');
}
{
  // full colour, not the grey of its luminance: saturated blue has low luminance and needs nothing
  check(B.alphaFor(flat([40, 60, 255]), 0.2) === LS.liftAlpha(flat([40, 60, 255]), 0.2, 'dark'), 'a saturated colour: the same answer as liftAlpha');
  const four = flat([5, 5, 5]); for (let i = 0; i < 4; i++) four[i] = [255, 255, 255];
  const five = flat([5, 5, 5]); for (let i = 0; i < 5; i++) five[i] = [255, 255, 255];
  check(B.alphaFor(four, 0.2) === 0 && B.alphaFor(five, 0.2) === 0.72, 'four bright samples in forty: ignored; five: the brightest tenth is bright');
  check(B.alphaFor(five.slice().reverse(), 0.2) === B.alphaFor(five, 0.2), 'sample order does not matter');
}

/* ---- filmFor: panelLift's answer in dark ---- */
{
  const on = B.filmFor(flat([255, 255, 255]), 0.2, true);
  const ref = LS.panelLift({ glass: { dark: { dim: 0.2 } } }, 'dark', flat([255, 255, 255]));
  check(on.alpha === ref.alpha && on.check === ref.check && on.film.join() === ref.film.join() && on.text === ref.text, 'check on: the same as panelLift', { on, ref });
  const off = B.filmFor(flat([255, 255, 255]), 0.2, false);
  const refOff = LS.panelLift({ glass: { dark: { dim: 0.2, dimAuto: false } } }, 'dark', flat([255, 255, 255]));
  check(off.alpha === 0 && off.check === 'off' && off.text === refOff.text, 'check off (dimAuto false): 0, the same as panelLift', { off, refOff });
  const none = B.filmFor(flat([20, 30, 45]), 0.3, true);
  check(none.alpha === 0 && /nothing to darken/.test(none.text), 'over dark the line says nothing to darken', none.text);
}

/* ---- bad input: 0, never throws ---- */
{
  let threw = false, r = [];
  try { r = [B.alphaFor(null, 0.2), B.alphaFor([], 0.2), B.alphaFor([[1, 2]], 0.2), B.alphaFor([[NaN, 0, 0]], 0.2), B.filmFor(null, 'x', true).alpha]; }
  catch (e) { threw = true; }
  check(!threw && r.every((a) => a === 0), 'no samples, short ones or NaN: 0', r);
}

/* ---- it re-implements nothing: the rule is look-sync's ---- */
{
  const src = fs.readFileSync(path.join(__dirname, 'brightcheck.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  check(!/\bdocument\b|localStorage|Math\.pow|0\.2126/.test(src), 'brightcheck.js: no DOM, no storage, no luminance maths of its own');
  check(/require\('\.\/looksync\/look-sync'\)/.test(src) && /root\.LookWash/.test(src), 'brightcheck.js uses the vendored look-sync (node) or window.LookWash (page)');
  const frost = fs.readFileSync(path.join(__dirname, 'frost.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  check(/BC\.filmFor\(/.test(frost) && /BC\.points\(/.test(frost) && !/lumOf\(\[lum\.px/.test(frost), 'frost.js samples at liftPoints in full colour and asks brightcheck.js');
  for (const page of ['index.html', 'newtab.html']) {
    const h = fs.readFileSync(path.join(__dirname, page), 'utf8');
    const b = h.indexOf('<script src="brightcheck.js"></script>'), f = h.indexOf('<script src="frost.js"></script>');
    check(b > 0 && f > b, page + ': brightcheck.js loads before frost.js', { b, f });
  }
}

/* ---- frost.js on a bitmap gives the same answer as brightcheck.js on its samples ---- */
{
  const F = require('./frost');
  check(F.check === 'on', 'frost.js found the check', F.check);
  const w = 64, h = 32, px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (y * w + x) * 4, c = x < 32 ? [230, 200, 120] : [30, 40, 60];
    px[k] = c[0]; px[k + 1] = c[1]; px[k + 2] = c[2]; px[k + 3] = 255;
  }
  const geo = { ox: 0, oy: 0, cw: 1000, ch: 500 }, rect = { x: 0, y: 0, w: 1000, h: 500 };
  const s = F.samplesFromPixels({ w, h, px }, geo, rect);
  check(s && s.length === 40 && s[0].join() === '230,200,120' && s[39].join() === '30,40,60', 'frost.js reads 40 full-colour samples, in liftPoints order (column by column)', s && [s[0], s[39]]);
  check(F.filmFromPixels({ w, h, px }, geo, rect, 0.2, true) === B.alphaFor(s, 0.2), 'frost film = alphaFor(samples, dim)');
  check(F.filmFromPixels({ w, h, px }, geo, rect, 0.2, false) === 0, 'frost film with the check off: 0');
}

console.log('brightcheck: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
