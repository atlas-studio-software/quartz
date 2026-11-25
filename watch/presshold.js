'use strict';
/*
 * watch/presshold.js -- a press on Lumen's services strip or its popover holds their redraw
 * until that press's click has run (watch.html, watch.js).
 *
 * Every snapshot from Quartz (a read starting, a request answered, a read ending) rebuilds the
 * strip's pills and the open popover's buttons. A press that a rebuild lands inside -- the button
 * pressed is gone by the time the button is released -- fires no click: Read now / Retry did
 * nothing, and said nothing. While another service reads, snapshots come many times a second, so
 * that was a real chance on every press. Now the rebuild that arrives during a press waits; the
 * release lets the click run first (pointerup, mouseup and click are one task) and the latest
 * redraw runs in the next task. A press never released (the pointer lost) lets go after
 * MAX_HOLD_MS, so the strip is never left stale.
 *
 * Pure: no DOM, no clock of its own (the caller passes later / cancel). Loads like merge.js:
 * require() in the tests, <script src="watch/presshold.js"> in watch.html (window.LumenPressHold).
 */
(function () {
  var MAX_HOLD_MS = 10000;

  /** -> { press(), release(), draw(fn) -> drawn now?, held() }. opts: { later(fn, ms) -> handle, cancel(handle) } */
  function create(opts) {
    var later = opts && typeof opts.later === 'function' ? opts.later : function (fn) { fn(); return 0; };
    var cancel = opts && typeof opts.cancel === 'function' ? opts.cancel : function () { };
    var held = false, gen = 0, pending = null, safety = null;

    function flush(g) {
      if (g !== gen || !held) return;   // a newer press holds on
      held = false;
      if (safety !== null) { cancel(safety); safety = null; }
      var fn = pending;
      pending = null;
      if (fn) fn();
    }

    return {
      press: function () {
        gen++;
        held = true;
        if (safety !== null) cancel(safety);
        var g = gen;
        safety = later(function () { safety = null; flush(g); }, MAX_HOLD_MS);
      },
      // After the click this release fires: that runs in the same task, the redraw in the next.
      release: function () {
        if (!held) return;
        var g = gen;
        later(function () { flush(g); }, 0);
      },
      // Draw now, or (during a press) once it is over; the latest redraw wins, they draw the same state.
      draw: function (fn) {
        if (held) { pending = fn; return false; }
        fn();
        return true;
      },
      held: function () { return held; }
    };
  }

  var API = { create: create, MAX_HOLD_MS: MAX_HOLD_MS };
  if (typeof module === 'object' && module && module.exports) module.exports = API;
  if (typeof window !== 'undefined' && window) window.LumenPressHold = API;
})();
