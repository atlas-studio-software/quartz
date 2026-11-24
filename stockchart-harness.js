// stockchart-harness.js - pure-node test for stockchart.js (run: node stockchart-harness.js).
// Markets' box chart and big chart: the scale, the price labels in their own gutter, the crosshair's
// point, which ranges the data can show, and the wiring in newtab.html / newtab.js.
// One summary line: "stockchart: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');
const SC = require('./stockchart');

let pass = 0, fail = 0;
function check(ok, what, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + what + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}

const t0 = Date.UTC(2026, 10, 24, 14, 30);
const day = [];
for (let i = 0; i < 390; i++) day.push([t0 + i * 60000, 500 + Math.sin(i / 30) * 4 + i * 0.01]);

/* ---- scale ---- */
{
  const s = SC.scaleOf(day, 490);
  check(s && s.lo === 490 && s.hi > 500, 'the previous close stays on the chart even below the day', s);
  const flat = SC.scaleOf([[0, 10], [1, 10]], null);
  check(flat && flat.hi > flat.lo, 'a flat day still has a span');
  check(SC.scaleOf([[0, 1]], 1) === null && SC.scaleOf(null) === null, 'fewer than 2 points: nothing to scale');
}

/* ---- price labels ---- */
{
  const t = SC.niceTicks(496.3, 507.9, 3);
  check(t.length >= 2 && t.every((v) => v >= 496.3 && v <= 507.9), 'labels fall inside the range', t);
  check(t.every((v, i) => i === 0 || Math.abs((v - t[i - 1]) - (t[1] - t[0])) < 1e-9), 'labels are evenly spaced', t);
  check([1, 2, 2.5, 5].some((m) => { const st = t[1] - t[0]; const k = st / Math.pow(10, Math.floor(Math.log10(st))); return Math.abs(k - m) < 1e-9 || Math.abs(k - m * 10) < 1e-9; }), 'the step is a round number', t);
  check(SC.niceTicks(5, 5, 3).length === 0 && SC.niceTicks(NaN, 1).length === 0, 'no range: no labels');
}

/* ---- crosshair ---- */
check(SC.nearestIndex(390, 0, 600) === 0 && SC.nearestIndex(390, 600, 600) === 389, 'crosshair: the ends map to the first and last minute');
check(SC.nearestIndex(390, 300, 600) === 195, 'crosshair: the middle maps to the middle');
check(SC.nearestIndex(390, -50, 600) === 0 && SC.nearestIndex(390, 9999, 600) === 389, 'crosshair: off the plot is clamped');
check(SC.nearestIndex(0, 10, 600) === -1, 'crosshair: no points, no point');
check(/^\d\d:\d\d \u00b7 \d+\.\d\d$/.test(SC.labelOf(day[10])), 'readout: "hh:mm · price"', SC.labelOf(day[10]));

/* ---- ranges: only what the data can show ---- */
{
  const a = SC.availableRanges({ points: day });
  check(a.ranges.join() === '1D', "today's minute prices: only 1D is offered", a.ranges);
  check(a.missing.map((m) => m.range).join() === '1W,1M,3M,1Y', 'the other four are named as missing');
  check(a.missing.every((m) => /Finnhub plan/.test(m.reason)), 'and the reason says why in words', a.missing[0]);
  const none = SC.availableRanges({ points: [] });
  check(none.ranges.length === 0 && none.missing[0].range === '1D', 'no prices yet: nothing offered, 1D says why');
  const year = [];
  for (let i = 0; i < 400; i++) year.push([t0 + i * 864e5, 100 + i]);
  check(SC.availableRanges({ points: year }).ranges.join() === '1D,1W,1M,3M,1Y', 'a longer history would offer every range (none today)');
}

/* ---- draw: labels in the gutter, never over the line ---- */
function fakeCtx() {
  const calls = { text: [], lines: 0, arcs: 0 };
  return {
    calls,
    beginPath() {}, moveTo() {}, lineTo() { calls.lines++; }, closePath() {}, fill() {}, stroke() {},
    setLineDash() {}, arc() { calls.arcs++; },
    fillText(s, x, y) { calls.text.push({ s, x, y }); },
    set font(v) {}, set textBaseline(v) {}, set textAlign(v) {}, set globalAlpha(v) {}, set strokeStyle(v) {},
    set fillStyle(v) {}, set lineWidth(v) {}, set lineJoin(v) {},
  };
}
{
  const colours = { up: '#0f0', down: '#f00', flat: '#999', grid: '#888' };
  const c = fakeCtx();
  const r = SC.draw(c, { points: day, prevClose: 499 }, colours, 360, SC.BOX_H, {});
  check(r.ok && r.geo.right === 360 - SC.GUTTER, 'the plot stops where the gutter starts', r.geo);
  check(c.calls.text.length >= 2 && c.calls.text.every((t) => t.x >= r.geo.right), 'every price label sits in the gutter, right of the plot', c.calls.text);
  check(c.calls.arcs === 0, 'the box chart draws no crosshair');
  const c2 = fakeCtx();
  const r2 = SC.draw(c2, { points: day, prevClose: 499 }, colours, 800, 400, { cross: 100, gutter: 56 });
  check(r2.ok && c2.calls.arcs === 1, 'the big chart draws its crosshair dot');
  check(!SC.draw(fakeCtx(), { points: [] }, colours, 100, 92, {}).ok, 'no points: nothing drawn, says so');
  check(SC.BOX_H === 92, 'the box chart is 92 px');
}

/* ---- wiring ---- */
{
  const html = fs.readFileSync(path.join(__dirname, 'newtab.html'), 'utf8');
  check(html.indexOf('<script src="stockchart.js"></script>') > 0 && html.indexOf('<script src="stockchart.js"></script>') < html.indexOf('<script src="newtab.js"></script>'), 'newtab.html loads stockchart.js before newtab.js');
  check(/id="stk-box"[^>]*role="button"/.test(html) && /id="stk-big"[^>]*role="dialog"/.test(html), 'the box chart is a button; the big chart a dialog');
  const js = fs.readFileSync(path.join(__dirname, 'newtab.js'), 'utf8');
  check(/startViewTransition/.test(js) && /prefers-reduced-motion/.test(js), 'the morph is a view transition, off under reduced motion');
  check(/availableRanges\(series\)/.test(js), 'the big chart offers only the ranges the data has');
  const css = fs.readFileSync(path.join(__dirname, 'newtab.css'), 'utf8');
  check(/\.module-stocks \.stk-row \{[^}]*height: 32px/.test(css), 'rows are 32 px');
  check(/\.module-stocks \.stk-chart \{[^}]*height: 92px/.test(css), 'the box chart is 92 px tall');
  // the key never reaches the page: the page side has no key handling at all
  check(!/finnhubKey|token=/.test(js.slice(js.indexOf('the big chart'), js.indexOf('the + field'))), 'the big chart never touches the key');
}

console.log('stockchart: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
