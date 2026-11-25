/* ============================================================
   islands.js — the chrome as floating islands (the user, 2026-11-24).

   The toolbar's buttons must stay direct children of .navrow (shield.js,
   downloads.js and reader.js insert theirs next to #theme / #lumen with
   navrow.insertBefore), and the tab strip is read by tabfit.js. So the
   islands are not wrappers: each group gets a PLATE, an empty .frost
   element placed behind it (frost.js paints the blurred picture into it):

     tabs   #tabstrip itself              (the workspace pill and the + are islands of their own)
     nav    #back .. #reload
     tools  the first shown control after #omnibox .. the last one

   The address bar (#omnibox) is an island itself, 760 px at most, centred
   in the WINDOW (LOOK.md section 2), not between the nav and tools
   islands; when the window is too narrow for that it keeps ISL_AIR from
   each of them (barBox).

   The active tab: ONE highlight (.tab-ind) slides between chips, with the
   accent underline under the title's WORDS (not the chip's middle). It
   snaps on the first placement, under reduced motion, and when the strip
   scrolls; it slides on a tab switch. Nothing runs at rest: placing is
   coalesced into one animation frame and only runs when something moved.
   The slide animates transform only (LOOK.md section 10: never width).
   It is a FLIP: the highlight takes its new width at once, starts drawn
   at the old place and width (translate + scaleX), and transitions to
   scaleX(1) at the new place. At rest its scale is 1, so its corners are
   true. The underline (.tab-ul) is a separate element of its own fixed
   16 px, moved by translate only, so the scale never stretches it.

   No pointer-follow motion of any kind (the user, 2026-11-24).

   Pure parts (islands-harness.js): span(), underlineX(), indMove(), barBox().
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Islands = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PAD = 4;              // the plate's air around its first and last control
  var UL_W = 16;            // the underline's width
  var BAR_MAX = 760;        // the address bar's widest
  var ISL_AIR = 6;          // air between toolbar islands (LOOK.md section 2)

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

  function px(n) { return (Math.round(n * 10) / 10) + 'px'; }

  /**
   * The highlight's move (titlebar-relative boxes { x, y, w, h }). from =
   * where it is drawn now (null: nowhere yet), to = the new chip. ->
   * { width, height, start, end }: set width/height and start with no
   * transition, then end with one. start === end means a snap.
   */
  function indMove(from, to) {
    if (!to || !(to.w > 0)) return null;
    var end = 'translate(' + px(to.x) + ', ' + px(to.y) + ') scaleX(1)';
    var start = end;
    if (from && from.w > 0) {
      var s = Math.round((from.w / to.w) * 10000) / 10000;
      start = 'translate(' + px(from.x) + ', ' + px(from.y) + ') scaleX(' + s + ')';
    }
    return { width: px(to.w), height: px(to.h), start: start, end: end };
  }

  /**
   * The address bar's box in window px. winW = the window's width; lo = the
   * nav island's right edge, hi = the tools island's left edge. Centred in
   * the window and BAR_MAX at most; never closer than ISL_AIR to either
   * island. -> { left, width } or null when there is no room at all.
   */
  function barBox(winW, lo, hi) {
    var a = lo + ISL_AIR, b = hi - ISL_AIR;
    if (!(winW > 0) || !(b > a)) return null;
    var w = Math.min(BAR_MAX, b - a);
    var left = Math.max(a, Math.min(b - w, (winW - w) / 2));
    return { left: Math.round(left * 10) / 10, width: Math.round(w * 10) / 10 };
  }

  var pure = { PAD: PAD, UL_W: UL_W, BAR_MAX: BAR_MAX, ISL_AIR: ISL_AIR, span: span, underlineX: underlineX, indMove: indMove, barBox: barBox };
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
  var ind = null, ul = null;
  if (titlebar) {
    ind = document.createElement('span');
    ind.className = 'tab-ind';
    ind.setAttribute('aria-hidden', 'true');
    titlebar.insertBefore(ind, titlebar.firstChild.nextSibling);
    ul = document.createElement('span');
    ul.className = 'tab-ul';
    ul.setAttribute('aria-hidden', 'true');
    titlebar.insertBefore(ul, ind.nextSibling);
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

  /** The address bar centred in the window (barBox); one style write per real change. */
  var barSent = '';
  function placeBar() {
    if (!navrow || !omnibox || !shown(omnibox)) return;
    var before = null;
    for (var c = omnibox.previousElementSibling; c; c = c.previousElementSibling) {
      if (!c.classList.contains('isl-plate') && shown(c)) { before = c; break; }
    }
    var t = toolsRange();
    var nr = navrow.getBoundingClientRect();
    var cs = window.getComputedStyle(navrow);
    var flexGap = parseFloat(cs.columnGap) || 0;
    var startX = before ? before.getBoundingClientRect().right + flexGap : nr.left + (parseFloat(cs.paddingLeft) || 0);
    var lo = before ? before.getBoundingClientRect().right + PAD : nr.left;
    var hi = t ? t[0].getBoundingClientRect().left - PAD : nr.right;
    var box = barBox(window.innerWidth, lo, hi);
    var key = box ? box.left + '/' + box.width + '/' + lo : '';
    if (key === barSent) return;
    barSent = key;
    if (!box) { omnibox.style.removeProperty('flex'); omnibox.style.removeProperty('margin-left'); omnibox.style.removeProperty('margin-right'); return; }
    // the margin from where the bar would start with none: after the element before it and the row's gap
    var ml = Math.max(0, box.left - startX);
    omnibox.style.flex = '0 0 ' + box.width + 'px';
    omnibox.style.marginLeft = ml.toFixed(1) + 'px';
    omnibox.style.marginRight = 'auto';
  }

  function putPlate(p, container, first, last, pad) {
    if (!p) return;
    var box = first && last && shown(first) && shown(last)
      ? span(container.getBoundingClientRect(), first.getBoundingClientRect(), last.getBoundingClientRect(), pad)
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
    if (!chip || !shown(chip)) { ind.hidden = true; ul.hidden = true; indPlaced = false; return; }
    var tb = titlebar.getBoundingClientRect(), cr = chip.getBoundingClientRect(), sr = tabstrip.getBoundingClientRect();
    // a chip scrolled out of the strip's view has no highlight to show
    if (cr.right <= sr.left || cr.left >= sr.right) { ind.hidden = true; ul.hidden = true; return; }
    // the same chip again (a resize, a title change) snaps; another chip slides
    var instant = snap || !indPlaced || reduce.matches || chip === indChip || ind.hidden;
    // where it is DRAWN now (mid-slide included), so an interrupted slide carries on from there
    var now = null;
    if (!instant) {
      var ir = ind.getBoundingClientRect();
      if (ir.width > 0) now = { x: ir.left - tb.left, y: ir.top - tb.top, w: ir.width, h: ir.height };
    }
    var to = { x: cr.left - tb.left, y: cr.top - tb.top, w: cr.width, h: cr.height };
    var mv = indMove(instant ? null : now, to);
    ind.hidden = false;
    ul.hidden = false;
    ind.classList.add('instant');
    ul.classList.add('instant');
    ind.style.width = mv.width;
    ind.style.height = mv.height;
    ind.style.transform = mv.start;
    var title = chip.querySelector('.tab-title');
    var ux = null;
    if (title && title.firstChild) {
      var rg = document.createRange();
      rg.selectNodeContents(title);
      ux = underlineX(cr, title.getBoundingClientRect(), rg.getBoundingClientRect().width);
    }
    if (ux == null) ux = Math.round(cr.width / 2 - UL_W / 2);
    var ulEnd = 'translate(' + px(to.x + ux) + ', ' + px(to.y + cr.height - 4) + ')';   // the design: 2 above the chip's foot
    if (instant) ul.style.transform = ulEnd;
    void ind.offsetWidth;                 // commit the start with no transition
    ind.classList.remove('instant');
    ul.classList.remove('instant');
    ind.style.transform = mv.end;
    ul.style.transform = ulEnd;
    indPlaced = true;
    indChip = chip;
  }

  function place(snap) {
    pending = false;
    var ws = document.getElementById('workspace-pill');
    if (ws && !ws.classList.contains('frost')) ws.classList.add('frost', 'island');
    if (omnibox && !omnibox.classList.contains('frost')) omnibox.classList.add('frost', 'island');
    // the new-tab button is an island of its own (the design's .new-tab)
    var nt = document.getElementById('newtab');
    if (nt && !nt.classList.contains('frost')) nt.classList.add('frost', 'island');
    placeBar();
    // the tabs island is the strip's own box: its 3px padding is the island's air (islands.css)
    putPlate(plates.tabs, titlebar, tabstrip, tabstrip, 0);
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
