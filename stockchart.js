/* ============================================================
   stockchart.js — Markets' charts on the new tab (the user, 2026-11-24).

   One drawing for both charts:
     the box chart   the selected symbol's day, 92 px tall, a box inside
                     the Markets card; pressing it opens...
     the big chart   the same day, large and interactive: a crosshair
                     follows the pointer and a readout says the time and
                     the price under it.
   Price labels live in their own gutter on the right, never over the
   line. The dashed line is the previous close.

   The data is exactly what Markets has today (stocks.js, main): the day's
   minute closes. Ranges: availableRanges() says which of 1D / 1W / 1M /
   3M / 1Y the data can show, and why the others cannot (stocks.js gets no
   longer history: Finnhub's candle history is not on the free plan, and
   the keyless fallback is fetched for one day only). Only the available
   ones are offered.

   Pure (stockchart-harness.js): scaleOf, niceTicks, nearestIndex,
   availableRanges, labelOf. draw() needs a 2D context.
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StockChart = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RANGES = ['1D', '1W', '1M', '3M', '1Y'];
  var BOX_H = 92;
  var GUTTER = 44;           // the price labels' own column
  var PAD = { top: 8, bottom: 8, left: 6 };

  function finite(v) { return typeof v === 'number' && isFinite(v); }

  /** lo / hi over the points and the previous close (so its line stays on the chart). */
  function scaleOf(points, prevClose) {
    if (!Array.isArray(points) || points.length < 2) return null;
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < points.length; i++) {
      var v = points[i] && points[i][1];
      if (!finite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!finite(lo) || !finite(hi)) return null;
    if (finite(prevClose)) { if (prevClose < lo) lo = prevClose; if (prevClose > hi) hi = prevClose; }
    var span = hi - lo;
    if (!(span > 0)) { span = Math.abs(hi) * 0.001 || 1; lo -= span / 2; hi += span / 2; }
    return { lo: lo, hi: hi, span: hi - lo };
  }

  /** About n round price labels between lo and hi (1, 2, 2.5 or 5 x 10^k steps). */
  function niceTicks(lo, hi, n) {
    if (!finite(lo) || !finite(hi) || !(hi > lo)) return [];
    n = n || 3;
    var raw = (hi - lo) / n;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var steps = [1, 2, 2.5, 5, 10];
    var step = mag;
    for (var i = 0; i < steps.length; i++) { step = steps[i] * mag; if (step >= raw) break; }
    var out = [];
    for (var t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(Math.round(t / step) * step);
    return out;
  }

  /** The point under x (0..innerW), by its place in the series. */
  function nearestIndex(count, x, innerW) {
    if (!(count > 0) || !(innerW > 0)) return -1;
    if (count === 1) return 0;
    var i = Math.round((x / innerW) * (count - 1));
    return Math.max(0, Math.min(count - 1, i));
  }

  /**
   * Which ranges the data can show. series = stocks.js's { points: [[t, v]...] }.
   * -> { ranges: ['1D'], missing: [{ range, reason }] }
   */
  function availableRanges(series) {
    var pts = series && Array.isArray(series.points) ? series.points : [];
    var spanMs = pts.length > 1 ? pts[pts.length - 1][0] - pts[0][0] : 0;
    var ranges = [], missing = [];
    var why = 'Markets only has the day\'s minute prices: longer history is not on the current Finnhub plan';
    var need = { '1W': 5 * 864e5, '1M': 28 * 864e5, '3M': 85 * 864e5, '1Y': 360 * 864e5 };
    for (var i = 0; i < RANGES.length; i++) {
      var r = RANGES[i];
      if (r === '1D') { if (pts.length > 1) ranges.push(r); else missing.push({ range: r, reason: 'no prices for today yet' }); continue; }
      if (spanMs >= need[r]) ranges.push(r);
      else missing.push({ range: r, reason: why });
    }
    return { ranges: ranges, missing: missing };
  }

  function two(n) { return (n < 10 ? '0' : '') + n; }

  /** The readout: "14:32 · 512.40". */
  function labelOf(point, digits) {
    if (!point || !finite(point[1])) return '';
    var d = new Date(point[0]);
    var when = isFinite(d.getTime()) ? two(d.getHours()) + ':' + two(d.getMinutes()) : '';
    var price = point[1].toFixed(digits == null ? 2 : digits);
    return when ? when + ' · ' + price : price;
  }

  /**
   * Draw the day into ctx (already scaled to CSS px) at w x h. colours =
   * { up, down, flat, grid, label }. opts = { gutter, cross: index | -1, font }.
   * -> { ok, geo: { left, right, top, bottom, innerW, innerH, lo, hi } }
   */
  function draw(ctx, series, colours, w, h, opts) {
    opts = opts || {};
    var points = (series && series.points) || [];
    var sc = scaleOf(points, series && series.prevClose);
    if (!ctx || !sc) return { ok: false };
    var gutter = opts.gutter == null ? GUTTER : opts.gutter;
    var left = PAD.left, right = w - gutter, top = PAD.top, bottom = h - PAD.bottom;
    var innerW = right - left, innerH = bottom - top;
    var xAt = function (i) { return left + (i / (points.length - 1)) * innerW; };
    var yAt = function (v) { return top + (1 - (v - sc.lo) / sc.span) * innerH; };
    var pc = series.prevClose;
    var lastV = points[points.length - 1][1];
    var base = finite(pc) ? pc : points[0][1];
    var colour = lastV > base ? colours.up : lastV < base ? colours.down : colours.flat;

    // the price labels, in their own gutter, with a faint guide across the plot
    var ticks = niceTicks(sc.lo, sc.hi, opts.ticks || 3);
    ctx.font = opts.font || '10px "Segoe UI Variable Text", "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (var t = 0; t < ticks.length; t++) {
      var ty = yAt(ticks[t]);
      if (ty < top - 1 || ty > bottom + 1) continue;
      ctx.globalAlpha = 0.12;
      ctx.strokeStyle = colours.grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, Math.round(ty) + 0.5); ctx.lineTo(right, Math.round(ty) + 0.5); ctx.stroke();
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = colours.label || colours.grid;
      ctx.fillText(ticks[t].toFixed(ticks[t] >= 1000 ? 0 : 2), right + 6, ty);
    }
    ctx.globalAlpha = 1;

    // the area under the line, then the previous close, then the line
    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(points[0][1]));
    for (var a = 1; a < points.length; a++) ctx.lineTo(xAt(a), yAt(points[a][1]));
    ctx.lineTo(xAt(points.length - 1), bottom); ctx.lineTo(xAt(0), bottom); ctx.closePath();
    ctx.fillStyle = colour; ctx.globalAlpha = 0.10; ctx.fill(); ctx.globalAlpha = 1;
    if (finite(pc)) {
      var py = yAt(pc);
      ctx.beginPath(); ctx.setLineDash([3, 3]); ctx.moveTo(left, py); ctx.lineTo(right, py);
      ctx.strokeStyle = colours.grid; ctx.globalAlpha = 0.45; ctx.lineWidth = 1; ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(points[0][1]));
    for (var b = 1; b < points.length; b++) ctx.lineTo(xAt(b), yAt(points[b][1]));
    ctx.strokeStyle = colour; ctx.lineWidth = opts.lineWidth || 1.25; ctx.lineJoin = 'round'; ctx.stroke();

    // the crosshair (big chart only)
    var ci = opts.cross == null ? -1 : opts.cross;
    if (ci >= 0 && ci < points.length) {
      var cx = xAt(ci), cy = yAt(points[ci][1]);
      ctx.strokeStyle = colours.grid; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(cx) + 0.5, top); ctx.lineTo(Math.round(cx) + 0.5, bottom); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(left, Math.round(cy) + 0.5); ctx.lineTo(right, Math.round(cy) + 0.5); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = colour;
      ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
    }
    return { ok: true, geo: { left: left, right: right, top: top, bottom: bottom, innerW: innerW, innerH: innerH, lo: sc.lo, hi: sc.hi } };
  }

  return { RANGES: RANGES, BOX_H: BOX_H, GUTTER: GUTTER, PAD: PAD, scaleOf: scaleOf, niceTicks: niceTicks,
           nearestIndex: nearestIndex, availableRanges: availableRanges, labelOf: labelOf, draw: draw };
});
