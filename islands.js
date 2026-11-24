/* ============================================================
   islands.js — the chrome as floating islands (the user, 2026-11-24).

   The toolbar's buttons must stay direct children of .navrow (shield.js,
   downloads.js and reader.js insert theirs next to #theme / #lumen with
   navrow.insertBefore), and the tab strip is read by tabfit.js. So the
   islands are not wrappers: each group gets a PLATE, an empty .frost
   element placed behind it (frost.js paints the blurred picture into it):

     tabs   #tabstrip .. #newtab          (the workspace pill is its own island)
     nav    #back .. #reload
     tools  the first shown control after #omnibox .. the last one

   The address bar (#omnibox) is an island itself, centred, 760 px at most.

   The active tab: ONE highlight (.tab-ind) slides between chips, with the
   accent underline under the title's WORDS (not the chip's middle). It
   snaps on the first placement, under reduced motion, and when the strip
   scrolls; it slides on a tab switch. Nothing runs at rest: placing is
   coalesced into one animation frame and only runs when something moved.

   No pointer-follow motion of any kind (the user, 2026-11-24).

   Pure parts (islands-harness.js): span(), underlineX().
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Islands = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PAD = 4;              // the plate's air around its first and last control
  var UL_W = 16;            // the underline's width

  /** The plate box covering rects a..b (container-relative), padded. */
  function span(container, first, last, pad) {
    if (!container || !first || !last) return null;
    var p = pad == null ? PAD : pad;
    var left = Math.min(first.left, last.left) - container.left - p;
    var right = Math.max(first.right, last.right) - container.left + p;
    var top = Math.min(first.top, last.top) - container.top - p;
    var bottom = Math.max(first.bottom, last.bottom) - container.top + p;
    if (!(right > left) || !(bottom > top)) return null;
    return { left: left, top: top, width: right - left, height: bottom - top };
  }

  /** The underline's x inside the chip: centred under the title's words. */
  function underlineX(chip, title, textW) {
    if (!chip || !title) return null;
    var w = Math.min(Number(textW) || 0, title.width);
    return Math.round(title.left - chip.left + w / 2 - UL_W / 2);
  }

  var pure = { PAD: PAD, UL_W: UL_W, span: span, underlineX: underlineX };
  if (typeof document === 'undefined' || typeof window === 'undefined') return pure;

  var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var titlebar = document.getElementById('titlebar');
  var navrow = document.querySelector('.navrow');
  var tabstrip = document.getElementById('tabstrip');
  var omnibox = document.getElementById('omnibox');
  var pending = false;

  function plate(container, name) {
    if (!container) return null;
    var p = container.querySelector(':scope > .isl-plate[data-isl="' + name + '"]');
    if (p) return p;
    p = document.createElement('div');
    p.className = 'isl-plate frost island';
    p.setAttribute('data-isl', name);
    p.setAttribute('aria-hidden', 'true');
    container.insertBefore(p, container.firstChild);
    return p;
  }

  var plates = {
    tabs: plate(titlebar, 'tabs'),
    nav: plate(navrow, 'nav'),
    tools: plate(navrow, 'tools'),
  };
  var ind = null;
  if (titlebar) {
    ind = document.createElement('span');
    ind.className = 'tab-ind';
    ind.setAttribute('aria-hidden', 'true');
    titlebar.insertBefore(ind, titlebar.firstChild.nextSibling);
  }
  var indPlaced = false, indChip = null;

  function shown(el) { return !!el && !el.hidden && el.offsetWidth > 0 && el.offsetHeight > 0; }

  function toolsRange() {
    if (!navrow || !omnibox) return null;
    var first = null, last = null, after = false;
    for (var c = navrow.firstElementChild; c; c = c.nextElementSibling) {
      if (c === omnibox) { after = true; continue; }
      if (!after || c.classList.contains('isl-plate') || !shown(c)) continue;
      if (!first) first = c;
      last = c;
    }
    return first ? [first, last] : null;
  }

  function putPlate(p, container, first, last) {
    if (!p) return;
    var box = first && last && shown(first) && shown(last)
      ? span(container.getBoundingClientRect(), first.getBoundingClientRect(), last.getBoundingClientRect())
      : null;
    if (!box) { p.hidden = true; return; }
    p.hidden = false;
    p.style.left = box.left.toFixed(1) + 'px';
    p.style.top = box.top.toFixed(1) + 'px';
    p.style.width = box.width.toFixed(1) + 'px';
    p.style.height = box.height.toFixed(1) + 'px';
  }

  function placeInd(snap) {
    if (!ind || !titlebar || !tabstrip) return;
    var chip = tabstrip.querySelector('.tab.active:not([hidden])');
    if (!chip || !shown(chip)) { ind.hidden = true; indPlaced = false; return; }
    var tb = titlebar.getBoundingClientRect(), cr = chip.getBoundingClientRect(), sr = tabstrip.getBoundingClientRect();
    // a chip scrolled out of the strip's view has no highlight to show
    if (cr.right <= sr.left || cr.left >= sr.right) { ind.hidden = true; return; }
    ind.hidden = false;
    // the same chip again (a resize, a title change) snaps; another chip slides
    var instant = snap || !indPlaced || reduce.matches || chip === indChip;
    ind.classList.toggle('instant', instant);
    ind.style.transform = 'translate(' + (cr.left - tb.left).toFixed(1) + 'px, ' + (cr.top - tb.top).toFixed(1) + 'px)';
    ind.style.width = cr.width.toFixed(1) + 'px';
    ind.style.height = cr.height.toFixed(1) + 'px';
    var title = chip.querySelector('.tab-title');
    var ux = null;
    if (title && title.firstChild) {
      var rg = document.createRange();
      rg.selectNodeContents(title);
      ux = underlineX(cr, title.getBoundingClientRect(), rg.getBoundingClientRect().width);
    }
    ind.classList.toggle('no-title', ux == null);
    if (ux != null) ind.style.setProperty('--ul-x', ux + 'px');
    if (instant) { void ind.offsetWidth; ind.classList.remove('instant'); }
    indPlaced = true;
    indChip = chip;
  }

  function place(snap) {
    pending = false;
    var ws = document.getElementById('workspace-pill');
    if (ws && !ws.classList.contains('frost')) ws.classList.add('frost', 'island');
    if (omnibox && !omnibox.classList.contains('frost')) omnibox.classList.add('frost', 'island');
    putPlate(plates.tabs, titlebar, tabstrip, document.getElementById('newtab'));
    putPlate(plates.nav, navrow, document.getElementById('back'), document.getElementById('reload'));
    var t = toolsRange();
    putPlate(plates.tools, navrow, t && t[0], t && t[1]);
    placeInd(snap === true);
    // the plates moved: line their glass up again (frost.js)
    if (window.Frost && typeof window.Frost.refresh === 'function') window.Frost.refresh();
  }

  function queue() {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(function () { place(false); });
  }

  if (typeof MutationObserver === 'function') {
    var mo = new MutationObserver(queue);
    if (tabstrip) mo.observe(tabstrip, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
    if (navrow) mo.observe(navrow, { childList: true, attributes: true, subtree: true, attributeFilter: ['hidden'] });
    if (titlebar) mo.observe(titlebar, { childList: true });
  }
  if (typeof ResizeObserver === 'function') {
    var ro = new ResizeObserver(queue);
    [titlebar, navrow, tabstrip, omnibox].forEach(function (el) { if (el) ro.observe(el); });
  }
  if (tabstrip) tabstrip.addEventListener('scroll', function () { window.requestAnimationFrame(function () { placeInd(true); }); }, { passive: true });
  window.addEventListener('resize', queue);
  queue();

  pure.refresh = queue;
  return pure;
});
