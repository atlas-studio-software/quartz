'use strict';
/*
 * tabfit.js — what the tab strip does when there are more tabs than room.
 *
 * Three steps, in order, and nothing changes until the first is needed:
 *
 *   1. NATURAL. The chips as they have always been: as wide as their title
 *      wants (up to 220px) and never under --tab-min (104px). Flexbox does all
 *      of it; this file sets nothing.
 *   2. FIT. Once every chip at --tab-min would no longer fit, the inactive
 *      chips share what is left at ONE width (--tab-fit-w, set here), down to
 *      --tab-fit-floor. Under --tab-fit-title that width is an icon and a close
 *      button that shows on hover, nothing else. The active chip keeps its
 *      natural recipe, so it never drops under --tab-min: you can always read
 *      where you are. Pinned and collapsed chips keep their 40px.
 *   3. SCROLL, and say so. When even the floor does not fit, the strip scrolls.
 *      The side that has tabs out of view fades and carries a button with the
 *      count ("‹ 3", "5 ›"); a click pages that way, the vertical wheel scrolls
 *      the strip sideways, and the tab-search button (Ctrl+Shift+A) carries the
 *      total hidden so the full list is one click away.
 *
 * Whatever the step, the ACTIVE chip is brought into view whenever it changes,
 * when a chip arrives (a new tab, a restored session, a workspace switch) and
 * when the window resizes. A tab opened in the background is brought into view
 * only if the active one stays in view too.
 *
 * Nothing here is measured off the chips' own fitted widths: the plan reads
 * the row's free width and the chip COUNTS, so applying it can never feed back
 * into the next plan. The row's free width is the titlebar minus everything
 * else in it (and the drag area the spacer always keeps), not the strip's own
 * box, for the same reason.
 *
 * Owned here: #tabstrip's data-fit / data-fade / data-hidden-* attributes and
 * its --tab-fit-w, #tabstrip-prev and #tabstrip-next. app.js owns the chips and
 * drag-to-reorder (it reads TabFit.revealActive after a drop, and steps the
 * strip itself while a dragged chip sits at an edge). tabsearch.js draws the
 * badge from the 'quartz:tabstrip-hidden' event this file sends.
 *
 * Plain browser script (contextIsolation on, no require). The pure half is
 * exported for tabfit-harness.js when loaded under node.
 */
(function () {
  /* --- pure: the plan ---------------------------------------------------- */

  /**
   * How wide the inactive chips are.
   * @param {{avail:number, gap:number, fixed:number[], active:boolean, flex:number,
   *          audible:number, tabMin:number, floor:number, titleMin:number, audioExtra:number}} p
   *   avail: px the strip may use. fixed: the widths of pinned/collapsed chips.
   *   active: an active chip is drawn at its natural size (>= tabMin). flex: how
   *   many chips share the rest. audible: how many of those also carry a speaker
   *   (each is audioExtra wider, so the speaker never pushes the favicon out).
   * @returns {{fit:false}|{fit:true, w:number, icons:boolean, overflow:boolean}}
   */
  function plan(p) {
    const flex = Math.max(0, p.flex | 0);
    if (!flex) return { fit: false };
    const fixed = (p.fixed || []).reduce((a, b) => a + (Number(b) || 0), 0);
    const n = (p.fixed || []).length + (p.active ? 1 : 0) + flex;
    const gaps = Math.max(0, n - 1) * (p.gap || 0);
    const activeW = p.active ? p.tabMin : 0;
    // Natural fits as long as every chip can sit at its own floor (--tab-min).
    if (fixed + activeW + flex * p.tabMin + gaps <= p.avail) return { fit: false };
    const room = p.avail - fixed - activeW - gaps - (p.audible | 0) * p.audioExtra;
    let w = Math.floor(room / flex);
    let overflow = false;
    if (!(w >= p.floor)) { w = p.floor; overflow = true; }   // NaN lands here too
    if (w > p.tabMin) w = p.tabMin;
    return { fit: true, w, icons: w < p.titleMin, overflow };
  }

  /* --- pure: what is out of view ----------------------------------------- */

  /** The overlay insets for a scroll position: an edge only shows where something is hidden. */
  function insetsAt(s, max, edge) {
    if (max <= 1) return { l: 0, r: 0 };
    return { l: s > 1 ? edge : 0, r: s < max - 1 ? edge : 0 };
  }

  /**
   * Which chips are out of view. A chip is HIDDEN on a side when any part of it
   * is under that side's fade/button or past the edge: the counts are the chips
   * you cannot fully see, so a chip is always either fully in the clear or
   * counted (that is the contract taboverflow-e2e.js checks).
   * @param {{scrollLeft:number, clientWidth:number, scrollWidth:number, edge:number,
   *          chips:{l:number, r:number}[]}} g  chips in content coordinates, strip order
   */
  function hidden(g) {
    const max = Math.max(0, g.scrollWidth - g.clientWidth);
    const ins = insetsAt(g.scrollLeft, max, g.edge);
    const viewL = g.scrollLeft + ins.l;
    // Under a pixel of overflow is rounding, not a hidden tab: no edge shows for it, so none is counted.
    const viewR = g.scrollLeft + g.clientWidth - ins.r + (max <= 1 ? max : 0);
    let left = 0, right = 0, firstShown = -1, lastShown = -1;
    g.chips.forEach((c, i) => {
      if (c.l < viewL - 0.5) left++;
      else if (c.r > viewR + 0.5) right++;
      else { if (firstShown < 0) firstShown = i; lastShown = i; }
    });
    return { left, right, overflow: max > 1, max, insetL: ins.l, insetR: ins.r, firstShown, lastShown };
  }

  /** Is chip c fully in the clear at scroll position s? */
  function shownAt(c, s, clientWidth, max, edge) {
    const ins = insetsAt(s, max, edge);
    return c.l >= s + ins.l - 0.5 && c.r <= s + clientWidth - ins.r + 0.5;
  }

  /**
   * The scroll position that shows chip c, as close to s as possible.
   * Returns s itself when c is already in the clear. `keep`, when given, must stay
   * in the clear too, or the strip is left where it is (returns s).
   */
  function revealScroll(g, c, keep) {
    const max = Math.max(0, g.scrollWidth - g.clientWidth);
    const s = Math.min(Math.max(0, g.scrollLeft), max);
    const cw = g.clientWidth;
    if (!c || shownAt(c, s, cw, max, g.edge)) return s;
    const clamp = (v) => Math.min(Math.max(0, v), max);
    const options = [clamp(c.l - g.edge), clamp(c.r - cw + g.edge)]
      .filter((v) => shownAt(c, v, cw, max, g.edge))
      .filter((v) => !keep || shownAt(keep, v, cw, max, g.edge))
      .sort((a, b) => Math.abs(a - s) - Math.abs(b - s));
    // A chip wider than the clear view (a window narrower than any real one):
    // its start in view is the best there is.
    if (!options.length) return keep ? s : clamp(c.l - (c.l - g.edge > 0 ? g.edge : 0));
    return options[0];
  }

  /**
   * One page toward `dir` (-1 left, +1 right), with one chip of overlap: the last
   * chip in the clear becomes the first, or the reverse. Always moves at least a
   * little while there is somewhere to go.
   */
  function pageScroll(g, dir) {
    const max = Math.max(0, g.scrollWidth - g.clientWidth);
    const s = Math.min(Math.max(0, g.scrollLeft), max);
    const h = hidden(g);
    const page = Math.max(g.edge, g.clientWidth - 2 * g.edge);
    let t;
    if (dir > 0) {
      const c = h.lastShown >= 0 ? g.chips[h.lastShown] : null;
      t = c ? c.l - g.edge : s + page;
      if (t <= s + 1) t = s + page;
    } else {
      const c = h.firstShown >= 0 ? g.chips[h.firstShown] : null;
      t = c ? c.r - g.clientWidth + g.edge : s - page;
      if (t >= s - 1) t = s - page;
    }
    return Math.min(Math.max(0, t), max);
  }

  /** A wheel event's vertical travel in px (deltaMode 1 = lines, 2 = pages). */
  function wheelPx(deltaY, deltaMode, pagePx) {
    const d = Number(deltaY) || 0;
    if (deltaMode === 1) return d * 40;
    if (deltaMode === 2) return d * (pagePx || 400);
    return d;
  }

  /** What an edge button says: the count, capped so the button never outgrows its fade. */
  function countText(n) { return n > 99 ? '99+' : String(n); }

  const API = { plan, hidden, revealScroll, pageScroll, wheelPx, countText, insetsAt };
  if (typeof module === 'object' && module && module.exports) { module.exports = API; return; }
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* --- the strip ----------------------------------------------------------- */

  const GLYPH_PREV = '';   // Segoe Fluent ChevronLeft
  const GLYPH_NEXT = '';   // ChevronRight
  const PAGE_MS = 120;           // a page glides this long; <= 150 ms, none at all under reduced motion

  let strip = null, titlebar = null, prevBtn = null, nextBtn = null;
  let knobs = null;
  let last = { sig: '', avail: -1, activeEl: null, activeRole: '', ids: new Set(), fit: '' };
  let edgesRaf = 0;
  let glide = 0;
  let lastSent = '';

  const reduceMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const px = (v, d) => { const n = parseFloat(v); return isFinite(n) ? n : d; };

  /** The tuning lives in chrome.css (#tabstrip's custom properties); read it once. */
  function readKnobs() {
    if (knobs) return knobs;
    const cs = getComputedStyle(strip);
    knobs = {
      tabMin: px(cs.getPropertyValue('--tab-min'), 104),
      floor: px(cs.getPropertyValue('--tab-fit-floor'), 48),
      titleMin: px(cs.getPropertyValue('--tab-fit-title'), 72),
      audioExtra: px(cs.getPropertyValue('--tab-fit-audio'), 28),
      edge: px(cs.getPropertyValue('--tab-fit-edge'), 30)
    };
    return knobs;
  }

  function visibleChips() {
    const out = [];
    for (const c of strip.children) if (c.classList.contains('tab') && !c.hidden) out.push(c);
    return out;
  }

  function audible(chip) {
    const a = chip.querySelector(':scope > .tab-audio');
    return !!(a && !a.hidden);
  }

  /**
   * One chip's role in the plan. Mirrors chrome.css exactly:
   *   fixed  - pinned, or collapsed and not (active and not dragging): the 40px box
   *   active - the active chip, unless a drag raised it (it keeps the width it was lifted at),
   *            and the chip a drag took over from (.drag-lowered keeps ITS width until the drop)
   *   flex   - everything else: shares the fitted width
   */
  function roleOf(chip) {
    const cl = chip.classList;
    const act = cl.contains('active');
    if (cl.contains('pinned') || (cl.contains('collapsed') && !(act && !cl.contains('dragging')))) return 'fixed';
    if ((act && !cl.contains('drag-raised')) || cl.contains('drag-lowered')) return 'active';
    return 'flex';
  }

  /** The px the strip may have: the titlebar minus everything else in its row and the spacer's floor. */
  function availWidth() {
    const cs = getComputedStyle(titlebar);
    let w = titlebar.clientWidth - px(cs.paddingLeft, 0) - px(cs.paddingRight, 0);
    const gap = px(cs.columnGap, 0);
    let items = 0;
    for (const el of titlebar.children) {
      const ecs = getComputedStyle(el);
      if (ecs.display === 'none' || ecs.position === 'absolute' || ecs.position === 'fixed') continue;
      items++;
      if (el === strip) continue;
      if (el.classList.contains('spacer')) { w -= px(ecs.minWidth, 0); continue; }
      w -= el.getBoundingClientRect().width + px(ecs.marginLeft, 0) + px(ecs.marginRight, 0);
    }
    return w - Math.max(0, items - 1) * gap;
  }

  /** Chips in the strip's content coordinates (#tabstrip is their offsetParent; transforms ignored). */
  function geometry(chips) {
    const k = readKnobs();
    return {
      scrollLeft: strip.scrollLeft,
      clientWidth: strip.clientWidth,
      scrollWidth: strip.scrollWidth,
      edge: k.edge,
      chips: chips.map((c) => ({ l: c.offsetLeft, r: c.offsetLeft + c.offsetWidth }))
    };
  }

  function setScroll(v) {
    cancelGlide();
    if (Math.abs(strip.scrollLeft - v) > 0.5) strip.scrollLeft = v;
  }

  function cancelGlide() { if (glide) { cancelAnimationFrame(glide); glide = 0; } }

  /** A page step: a short ease-out (<= PAGE_MS), or a jump under reduced motion. */
  function glideTo(v) {
    cancelGlide();
    const from = strip.scrollLeft;
    if (reduceMotion() || Math.abs(v - from) < 2) { strip.scrollLeft = v; return; }
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / PAGE_MS);
      const e = 1 - Math.pow(1 - t, 3);
      strip.scrollLeft = from + (v - from) * e;
      glide = t < 1 ? requestAnimationFrame(step) : 0;
    };
    glide = requestAnimationFrame(step);
  }

  const dragging = () => !!(document.body && document.body.classList.contains('tab-dragging'));

  /**
   * The whole pass: classify, plan, apply, then bring what must be seen into view.
   * Cheap when nothing that matters moved: the signature is built from classes
   * and the hidden flag only (no layout read) and the pass stops there.
   */
  function relayout(opts) {
    if (!strip || !strip.isConnected || !titlebar) return;
    const force = !!(opts && opts.force);
    const added = (opts && opts.added) || [];
    const chips = visibleChips();
    let sig = '';
    let activeEl = null;
    const ids = new Set();
    let activeRole = '';
    for (const c of chips) {
      const role = roleOf(c);
      const id = c.dataset.tabId || '';
      ids.add(id);
      if (!activeEl && c.classList.contains('active')) { activeEl = c; activeRole = role; }
      sig += id + ':' + role + (role === 'flex' && audible(c) ? 'a' : '') + ',';
    }
    let newlyShown = false;
    for (const id of ids) if (!last.ids.has(id)) { newlyShown = true; break; }

    // A drop hands the raised chip its full width back: same chip, new role, maybe now under an edge.
    const activeMoved = activeEl !== last.activeEl || activeRole !== last.activeRole;
    // A chip's loading / is-born / drag-shift class came and went: nothing the
    // plan reads moved, so nothing is measured (the edges re-read next frame).
    if (!force && !(opts && opts.resized) && sig === last.sig && !activeMoved && !added.length) { queueEdges(); return; }

    // Hidden (fullscreen hides the chrome, a minimised window has no width):
    // keep the last plan, measure nothing.
    if (!titlebar.clientWidth || strip.offsetParent === null) return;

    const avail = availWidth();
    const availMoved = Math.abs(avail - last.avail) > 0.5;
    if (!force && sig === last.sig && !availMoved && !activeMoved && !added.length) { queueEdges(); return; }

    const k = readKnobs();
    const fixed = [];
    let flex = 0, aud = 0, active = false;
    for (const c of chips) {
      const role = roleOf(c);
      if (role === 'fixed') fixed.push(c.offsetWidth);
      else if (role === 'active') active = true;
      else { flex++; if (audible(c)) aud++; }
    }
    const p = plan({
      avail, gap: px(getComputedStyle(strip).columnGap, 0), fixed, active, flex, audible: aud,
      tabMin: k.tabMin, floor: k.floor, titleMin: k.titleMin, audioExtra: k.audioExtra
    });
    const fit = p.fit ? (p.icons ? 'icons' : 'titles') : '';
    if (fit) {
      if (strip.dataset.fit !== fit) strip.dataset.fit = fit;
      const w = p.w + 'px';
      if (strip.style.getPropertyValue('--tab-fit-w') !== w) strip.style.setProperty('--tab-fit-w', w);
    } else {
      if (strip.hasAttribute('data-fit')) strip.removeAttribute('data-fit');
      if (strip.style.getPropertyValue('--tab-fit-w')) strip.style.removeProperty('--tab-fit-w');
    }

    const fitMoved = fit !== last.fit;
    last = { sig, avail, activeEl, activeRole, ids, fit };

    // What to bring into view. Never mid-drag: the drag owns the strip until it
    // ends, and a scroll under it would move the chips out from under its
    // measurements (app.js steps the strip itself at the edges).
    if (!dragging() && (activeMoved || newlyShown || availMoved || fitMoved || force)) {
      const g = geometry(chips);
      const idx = (el) => chips.indexOf(el);
      const a = activeEl ? g.chips[idx(activeEl)] : null;
      let s = a ? revealScroll(g, a) : g.scrollLeft;
      // A tab opened behind the current one: shown too, if the current one stays shown.
      for (const el of added) {
        if (el === activeEl || idx(el) < 0) continue;
        s = revealScroll(Object.assign({}, g, { scrollLeft: s }), g.chips[idx(el)], a);
      }
      setScroll(s);
    }
    syncEdges();
  }

  function queueEdges() {
    if (edgesRaf) return;
    edgesRaf = requestAnimationFrame(() => { edgesRaf = 0; syncEdges(); });
  }

  /** The fades, the two edge buttons and the hidden count, from where the strip really is. */
  function syncEdges() {
    if (!strip || !prevBtn || !nextBtn) return;
    if (!titlebar.clientWidth || strip.offsetParent === null) return;
    const chips = visibleChips();
    const g = geometry(chips);
    const h = hidden(g);
    const fade = (h.insetL ? 'l' : '') + (h.insetR ? 'r' : '');
    if ((strip.dataset.fade || '') !== fade) {
      if (fade) strip.dataset.fade = fade; else strip.removeAttribute('data-fade');
    }
    paintEdge(prevBtn, h.insetL ? h.left : 0, 'left', chips.slice(0, h.left));
    paintEdge(nextBtn, h.insetR ? h.right : 0, 'right', h.right ? chips.slice(chips.length - h.right) : []);
    strip.dataset.hiddenLeft = String(h.left);
    strip.dataset.hiddenRight = String(h.right);
    const key = h.left + '/' + h.right;
    if (key !== lastSent) {
      lastSent = key;
      try {
        document.dispatchEvent(new CustomEvent('quartz:tabstrip-hidden', { detail: { left: h.left, right: h.right } }));
      } catch (err) { /* the badge only; the edges already say it */ }
    }
  }

  function paintEdge(btn, n, side, chips) {
    const show = n > 0;
    if (btn.hidden === show) btn.hidden = !show;
    if (!show) return;
    const num = btn.querySelector('.strip-edge-n');
    const text = countText(n);
    if (num.textContent !== text) num.textContent = text;
    const label = n + (n === 1 ? ' tab' : ' tabs') + ' to the ' + side;
    if (btn.title !== label) { btn.title = label; btn.setAttribute('aria-label', 'Show ' + label); }
    // A Claude tab that wants you, out of view, colours its side's count.
    const attn = chips.some((c) => c.classList.contains('needs-you'));
    btn.classList.toggle('has-attn', attn);
  }

  function buildEdge(id, glyph, dir) {
    const b = document.createElement('button');
    b.id = id;
    b.type = 'button';
    b.className = 'strip-edge no-drag';
    b.hidden = true;
    b.tabIndex = -1;   // the strip scrolls a focused chip into view by itself; the wheel and Ctrl+Shift+A cover the keyboard
    const g = document.createElement('span');
    g.className = 'glyph strip-edge-chev';
    g.textContent = glyph;
    const n = document.createElement('span');
    n.className = 'strip-edge-n';
    if (dir < 0) { b.appendChild(g); b.appendChild(n); } else { b.appendChild(n); b.appendChild(g); }
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      glideTo(pageScroll(geometry(visibleChips()), dir));
    });
    b.addEventListener('wheel', onWheel, { passive: false });
    return b;
  }

  /** The vertical wheel scrolls the strip sideways; a horizontal one already does. */
  function onWheel(e) {
    if (!strip || e.ctrlKey) return;
    if (strip.scrollWidth - strip.clientWidth <= 1) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;   // a sideways swipe: the browser's own
    e.preventDefault();
    cancelGlide();
    strip.scrollLeft += wheelPx(e.deltaY, e.deltaMode, strip.clientWidth);
  }

  function init() {
    strip = document.getElementById('tabstrip');
    titlebar = document.getElementById('titlebar');
    if (!strip || !titlebar) return;
    // After #tabstrip in tree order (the anchor has to come first) and out of
    // the flex row (position: absolute), so they never take width from it.
    prevBtn = buildEdge('tabstrip-prev', GLYPH_PREV, -1);
    nextBtn = buildEdge('tabstrip-next', GLYPH_NEXT, 1);
    titlebar.appendChild(prevBtn);
    titlebar.appendChild(nextBtn);

    strip.addEventListener('scroll', queueEdges, { passive: true });
    strip.addEventListener('wheel', onWheel, { passive: false });

    new MutationObserver((records) => {
      const added = [];
      for (const r of records) {
        if (r.type === 'childList' && r.target === strip) {
          for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains('tab') && !added.includes(n)) added.push(n);
        }
      }
      // A chip moved by syncChipOrder() (a reorder) is removed and re-added: not new.
      const fresh = added.filter((n) => !last.ids.has(n.dataset.tabId || ''));
      relayout({ added: fresh });
    }).observe(strip, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => relayout({ resized: true }));
      ro.observe(titlebar);
      // Everything else in the row changes what the strip may have; none of it
      // changes size because of the strip, so this cannot loop.
      const watch = () => {
        // (not the edge buttons: they sit outside the row, and their counts change inside these callbacks)
        for (const el of titlebar.children) {
          if (el !== strip && !el.classList.contains('spacer') && !el.classList.contains('strip-edge')) ro.observe(el);
        }
      };
      watch();
      new MutationObserver(() => { watch(); relayout({ resized: true }); }).observe(titlebar, { childList: true });
    } else {
      window.addEventListener('resize', () => relayout({ resized: true }));
    }
    relayout({ force: true });
  }

  window.TabFit = Object.assign({}, API, {
    /** Bring the active chip into view now (app.js calls it after a drop). */
    revealActive: () => relayout({ force: true }),
    /** For tests and the console: the plan and what is out of view, as the strip has it. */
    state: () => {
      if (!strip) return null;
      const chips = visibleChips();
      const g = geometry(chips);
      const h = hidden(g);
      return {
        fit: strip.dataset.fit || '',
        w: px(strip.style.getPropertyValue('--tab-fit-w'), 0),
        avail: last.avail,
        knobs: readKnobs(),
        scrollLeft: g.scrollLeft, clientWidth: g.clientWidth, scrollWidth: g.scrollWidth,
        left: h.left, right: h.right, overflow: h.overflow,
        prev: prevBtn && !prevBtn.hidden ? prevBtn.textContent : null,
        next: nextBtn && !nextBtn.hidden ? nextBtn.textContent : null
      };
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
