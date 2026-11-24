/* ============================================================
   brightcheck.js - the islands' brightness check, as one pure function.

   How much neutral film a floating panel needs so white text on it stays
   readable over the picture behind it:

     alphaFor(grid, dim) -> alpha, 0 .. 0.56 in steps of 0.04

   grid = { cols: 8, rows: 5, lum: [40 numbers] }: the relative luminance
          (0..1, WCAG) of the picture behind the panel, sampled at the
          centres of an 8 x 5 grid over it, row by row, BEFORE the Dim.
   dim  = the wash alpha over the picture (0..1, towards black).

   The rule (the shared v2 brightness check as decided 2026-11-24): take the
   brightest tenth of the samples (the 5th brightest of 40) as dimmed, then
   add rgb(10,12,14) in steps of .04, at most .56, until its luminance is
   .163 or less; over a dark area that is 0. The check is always on
   ("automatic").

   Mixing happens where the screen composites: in sRGB, so a sample is
   taken as the grey of its luminance, dimmed and filmed per channel, then
   measured again.

   This file stands alone on purpose: when look-sync v2 ships its own
   check, the vendored one replaces this file and its callers (frost.js)
   stay as they are. No DOM, no state, never throws.
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BrightCheck = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COLS = 8;
  var ROWS = 5;
  var TARGET = 0.163;                    // white text 4.5:1 over it
  var FILM_RGB = [10, 12, 14];
  var FILM_STEP = 0.04;
  var FILM_MAX = 0.56;
  var TENTH = 0.1;

  function lin(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function enc(l) { return l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055; }
  function clamp01(n) { n = Number(n); return isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }

  /** Luminance of sRGB channels (0..1 each). */
  function lumOfRgb(r, g, b) { return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }

  /** Luminance of a picture sample of luminance l, dimmed by dim, under a film of alpha a. */
  function lumUnder(l, dim, a) {
    var v = enc(clamp01(l)) * (1 - clamp01(dim));
    a = clamp01(a);
    return lumOfRgb(v * (1 - a) + (FILM_RGB[0] / 255) * a,
                    v * (1 - a) + (FILM_RGB[1] / 255) * a,
                    v * (1 - a) + (FILM_RGB[2] / 255) * a);
  }

  /** The film one panel needs. A grid that isn't 8 x 5 numbers -> 0 (nothing to go on). */
  function alphaFor(grid, dim) {
    var lum = grid && grid.lum;
    if (!grid || grid.cols !== COLS || grid.rows !== ROWS || !lum || lum.length !== COLS * ROWS) return 0;
    var s = [];
    for (var i = 0; i < lum.length; i++) {
      var n = Number(lum[i]);
      if (!isFinite(n)) return 0;
      s.push(clamp01(n));
    }
    s.sort(function (p, q) { return q - p; });
    var bright = s[Math.floor(s.length * TENTH)];
    var a = 0;
    while (a < FILM_MAX - 1e-9 && lumUnder(bright, dim, a) > TARGET) a = Math.round((a + FILM_STEP) * 100) / 100;
    return Math.min(FILM_MAX, a);
  }

  return {
    COLS: COLS, ROWS: ROWS, TARGET: TARGET, FILM_RGB: FILM_RGB, FILM_STEP: FILM_STEP, FILM_MAX: FILM_MAX,
    alphaFor: alphaFor, lumUnder: lumUnder, lumOfRgb: lumOfRgb,
  };
});
