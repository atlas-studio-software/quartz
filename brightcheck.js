/* ============================================================
   brightcheck.js - the islands' brightness check (both themes), as a thin
   adapter over look-sync's own v2.1 check: liftAlpha / panelLift from the
   vendored pure block (looksync/look-sync.js in node, window.LookWash from
   looksync/wash.browser.js in a page). Nothing here re-implements the rule,
   so Quartz and every other app give one panel the same film.

     filmFor(samples, dim, checkOn, theme) -> { alpha, film, check, text }
     alphaFor(samples, dim, theme)         -> alpha (the check on)

   samples = [[r, g, b], ...] 0..255: the panel's liftPoints read from the
             blurred copy it shows, BEFORE the Dim (full colour, not a grey).
   dim     = the wash alpha over the picture (0..1, towards black, both themes).
   theme   = 'light' for the light lift; anything else = the dark film.
   The rule (CONTRACT "2026-11-24: the islands look (v2)", v2.1): each
   sample is dimmed per channel, its relative luminance taken.
     Dark: the samples sorted brightest first and the one at floor(n x 0.1)
     picked; film rgb(10,12,14) is laid over it per channel in steps of .04,
     at most .72, until its luminance is .066 or less. 0 over a dark area.
     Light (LIGHT.md section 4b): sorted darkest first, the same index;
     #F4F7F8 is laid over it until its luminance is .386 or more, the same
     steps and cap. 0 over a pale area.
   Only one runs at a time: the theme in effect. Check off
   (glass.<theme>.dimAuto false) = 0. `film` is the neutral to lay
   (panelLift's): rgb(10,12,14) in dark, #F4F7F8 in light; never the dark
   film in light.

   When the shared check did not load (an old wash.browser.js, a page that
   forgot the script), ok is false, every answer is 0 and `missing` says
   why, so frost.js can say so instead of quietly showing no film.
   No DOM, no state, never throws.
   ============================================================ */
(function (root, factory) {
  var node = typeof module === 'object' && module.exports;
  var ls = null;
  if (node) { try { ls = require('./looksync/look-sync'); } catch (e) { ls = null; } }
  else ls = root.LookWash || null;
  var api = factory(ls);
  if (node) module.exports = api;
  else root.BrightCheck = api;
})(typeof self !== 'undefined' ? self : this, function (LS) {
  'use strict';

  var ok = !!(LS && typeof LS.liftAlpha === 'function' && typeof LS.liftPoints === 'function' &&
              LS.LIFT && typeof LS.LIFT.target === 'number');
  var MISSING = ok ? '' : "the shared brightness check (look-sync's liftAlpha, looksync/wash.browser.js) did not load, " +
    'so no panel is darkened over a bright picture';
  // Shown when the shared one is missing: the v2.1 numbers, for Settings' wording only.
  var L = ok ? LS.LIFT : { cols: 8, rows: 5, quantile: 0.1, rgb: [10, 12, 14], target: 0.066, step: 0.04, max: 0.72,
                         light: { rgb: [244, 247, 248], target: 0.386 } };

  /** The cols x rows sample points of a panel at x, y, size w x h (look-sync's order). */
  function points(x, y, w, h) {
    if (ok) return LS.liftPoints(x, y, w, h);
    var pts = [];
    for (var i = 0; i < L.cols; i++) for (var j = 0; j < L.rows; j++) pts.push({ x: x + ((i + 0.5) / L.cols) * w, y: y + ((j + 0.5) / L.rows) * h });
    return pts;
  }

  /** The film (dark) or lift (light) one panel needs, with the check on. */
  function alphaFor(samples, dim, theme) {
    if (!ok) return 0;
    try { return LS.liftAlpha(samples, dim, theme === 'light' ? 'light' : 'dark'); } catch (e) { return 0; }
  }

  /**
   * panelLift's answer for the theme in effect, at the Dim Quartz paints:
   * checkOn false (glass.<theme>.dimAuto false) = 0, the panel is pure blur.
   */
  function filmFor(samples, dim, checkOn, theme) {
    var light = theme === 'light';
    var film = (light ? L.light.rgb : L.rgb).slice();
    var d = typeof dim === 'number' && isFinite(dim) ? Math.round(dim * 100) / 100 : null;
    var dimWords = d == null ? '?' : d.toFixed(2);
    if (!ok) return { alpha: 0, film: film, check: 'off', text: 'Brightness check off: ' + MISSING };
    if (checkOn === false) return { alpha: 0, film: film, check: 'off', text: 'Brightness check off: Dim ' + dimWords + ' only' };
    var a = alphaFor(samples, dim, light ? 'light' : 'dark');
    var did = light ? ['lightened', 'dark', 'lighten'] : ['darkened', 'bright', 'darken'];
    return { alpha: a, film: film, check: 'on',
      text: a > 0 ? 'Brightness check on: Dim ' + dimWords + ', ' + did[0] + ' ' + a.toFixed(2) + ' where the picture is ' + did[1]
        : 'Brightness check on: Dim ' + dimWords + ', nothing to ' + did[2] + ' here' };
  }

  return {
    ok: ok, missing: MISSING,
    COLS: L.cols, ROWS: L.rows, QUANTILE: L.quantile, TARGET: L.target,
    FILM_RGB: L.rgb.slice(), FILM_STEP: L.step, FILM_MAX: L.max,
    LIFT_RGB: L.light.rgb.slice(), LIFT_TARGET: L.light.target,
    points: points, alphaFor: alphaFor, filmFor: filmFor,
  };
});
