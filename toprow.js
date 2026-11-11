/* ============================================================
   toprow.js — tells Mantle what this window's TOP PIXEL ROW looks like,
   before it changes (look-sync PROTOCOL v1, "top-row hints").

   Mantle's top bar (a Win11 shell) takes the colour of the window
   right under it. It reads the screen for that, which is always a frame
   or more late. The user (2026-10-11) wants "literally no delay", so Quartz
   says what its top row is IN THE SAME TASK that changes it, before the
   frame that shows the change is produced, and Mantle can paint its bar
   on the same frame (on a window switch it already knows the new
   window's top from the last hint).

   What the top row of this window is (chrome.css, backdrop.css): the
   content area starts at the window's top edge, maximized or not (body
   has no margin either way), and its first row is the tab strip's top
   row, which nothing but the background stack draws on (the tabs are 30px
   tall, centred in the 40px strip; menus and Settings open below the
   toolbar). Bottom to top:

     .bg-base     --bg, opaque
     .bg-photo    the blurred picture (backdrop.js), when it has landed;
                  lined up with the screen for "Same as desktop"
     .bg-clear    Helm's Home look: the picture UNBLURRED, whenever the
                  window has a still picture (any tab in front, both
                  themes); its ::after is a 96px scrim, the wash colour
                  at .5 at row 0
     .bg-wash     the wash: dark --chrome-glass-a (the guard), light
                  --bg-dim over a picture
     #titlebar    dark: no fill (a workspace's 7% tint, if any); light:
                  --surface-0 (+ the tint); inside .chrome-layer, which
                  fades in once at boot
     window buttons  full strip height: a hovered one paints row 0

   Everything there is either the picture or a flat colour, so the row is
   always   row(x) = k * picture(x) + S   (k = how much of the picture
   still shows, S = the colour layers, premultiplied). compose() works
   k and S out from the COMPUTED styles (so the guard, the theme, the
   workspace tint, a fade in flight are all whatever the page really
   paints this frame), and topFor() turns them into the hint:

     wash   the picture is Mantle's current desktop still, lined up:
            { rgb: S / (1 - k), alpha: 1 - k }. Mantle draws its own
            blurred still at that spot under that colour. Home shows the
            picture UNBLURRED; the hint still says wash (one picture, the
            wash continues into the bar), at Home's effective alpha.
     flat   no picture shows (none chosen, still loading): { rgb: S }
     cols   some other picture (Own picture, a clip's still, the Windows
            wallpaper fallback, an old still while a new one is blurred):
            the row worked out from backdrop.js's blurred bitmap, ~8 CSS px
            per column, k * bitmap + S
     none   can't say: fullscreen (the chrome steps aside), a hovered
            window button, a background this file cannot read

   WHEN. A MutationObserver on everything that decides the stack (html's
   data-theme and inline style, where --chrome-glass-a lives; body's
   classes and data-bg-*; every attribute under .backdrop; the strip's
   data-ws-colour) and backdropchange queue ONE compute as a microtask:
   microtasks run at the end of the task that made the change, before the
   browser renders, so the hint leaves in the same task. A fade in flight
   (the Home's 280/300 ms, a picture landing, the boot entrance, a window
   button's hover) is then followed once per animation frame, inside
   requestAnimationFrame, where the computed values are the frame about to
   be drawn; it stops when the fades end (and after LOOP_MAX_MS whatever
   happens). Nothing runs at rest.

   The hint goes to main with ipcRenderer.send (fire and forget, never
   awaited); main (toprow-main.js) owns the pipe to Mantle, the HWND and
   the sequence numbers, and says how the connection is going.

   Public surface:
     window.Toprow.status() -> { top, why, sent, main: { state, reason, pipe, ... } }
     window.Toprow.kick(why) -> compute now (also what the observers do)
     'toprowstatus' on document when main's connection state changes
     module.exports (node): the pure maths, for toprow-harness.js
   ============================================================ */
(function (root) {
  'use strict';

  var COL_CSS_PX = 8;            // one column per ~8 CSS px (Mantle reads ~8 physical px)
  var COLS_MIN = 8;
  var COLS_MAX = 240;            // 240 x ~14 chars: ~3.4 KB, well under the 8 KB line
  var K_EPS = 0.002;             // the picture's weight below this: nothing of it shows
  var LOOP_MAX_MS = 1500;        // never follow fades longer than this after a change

  /* --- pure maths ------------------------------------------------- */

  /** A computed CSS colour -> { r, g, b, a } (0..255, 0..1), or null. */
  function parseColor(str) {
    if (typeof str !== 'string') return null;
    var s = str.trim();
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    // color-mix(in srgb, ...) (the workspace tints) computes to color(srgb r g b / a), 0..1
    var cm = /^color\(srgb\s+([^)]*)\)$/i.exec(s);
    if (cm) {
      var q = cm[1].split(/[\s\/]+/).filter(function (p) { return p !== ''; }).map(function (p) {
        return /%$/.test(p) ? parseFloat(p) / 100 : parseFloat(p);
      });
      if (q.length < 3 || !q.slice(0, 3).every(isFinite)) return null;
      var qa = q.length > 3 ? q[3] : 1;
      if (!isFinite(qa)) return null;
      return { r: q[0] * 255, g: q[1] * 255, b: q[2] * 255, a: Math.max(0, Math.min(1, qa)) };
    }
    var m = /^rgba?\(([^)]*)\)$/i.exec(s);
    if (!m) return null;
    var parts = m[1].split(/[\s,\/]+/).filter(function (p) { return p !== ''; });
    if (parts.length < 3) return null;
    function chan(p) {
      if (/%$/.test(p)) return parseFloat(p) * 2.55;
      return parseFloat(p);
    }
    var r = chan(parts[0]), g = chan(parts[1]), b = chan(parts[2]);
    var a = parts.length > 3 ? (/%$/.test(parts[3]) ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    if (![r, g, b, a].every(isFinite)) return null;
    return { r: r, g: g, b: b, a: Math.max(0, Math.min(1, a)) };
  }

  /** The colour at the TOP of a computed background-image, or null when it
      is not a plain top-to-bottom gradient (then the row is unknown).
      'none' -> { a: 0 }. */
  function gradientTop(img) {
    if (typeof img !== 'string' || img === '' || img === 'none') return { r: 0, g: 0, b: 0, a: 0 };
    var m = /^linear-gradient\((.*)\)$/i.exec(img.trim());
    if (!m) return null;
    var inner = m[1].trim();
    // A direction other than the default (to bottom / 180deg) would put a
    // different stop at row 0: say "unknown" rather than guess.
    if (/^(to |-?[\d.]+(deg|rad|turn|grad))/i.test(inner) && !/^(to bottom|180deg)\s*,/i.test(inner)) return null;
    var c = /rgba?\([^)]*\)|color\(srgb[^)]*\)/i.exec(inner);
    return c ? parseColor(c[0]) : null;
  }

  /** A computed background-image LIST ("linear-gradient(...), none") -> the
      colour each layer puts at row 0, BOTTOM to top (CSS paints the first
      layer on top), 'none' layers dropped; null when any layer is unknown. */
  function imageLayers(img) {
    if (typeof img !== 'string' || img.trim() === '' || img.trim() === 'none') return [];
    var parts = [], depth = 0, startAt = 0;
    for (var i = 0; i < img.length; i++) {
      var ch = img.charAt(i);
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) { parts.push(img.slice(startAt, i)); startAt = i + 1; }
    }
    parts.push(img.slice(startAt));
    var out = [];
    for (var j = parts.length - 1; j >= 0; j--) {
      var p = parts[j].trim();
      if (p === 'none') continue;
      var c = gradientTop(p);
      if (!c) return null;
      out.push(c);
    }
    return out;
  }

  /**
   * Composite a stack, bottom to top, into row = k * picture + S.
   * Layers:
   *   { pic: true, opacity }                the picture (opaque), at an opacity
   *   { rgb: [r,g,b], a }                   a flat colour at alpha a
   *   { group: [layers], opacity }          a group whose first layer is opaque
   *                                         (a picture or a colour at a = 1),
   *                                         composited, then laid on at opacity
   * The first layer must be opaque (the base). Returns { k, S: [r,g,b] }.
   */
  function compose(layers) {
    var k = 0;
    var S = [0, 0, 0];
    (layers || []).forEach(function (L) {
      if (!L) return;
      var o, inner;
      if (L.group) {
        inner = compose(L.group);
        o = clamp01(L.opacity === undefined ? 1 : L.opacity);
        k = (1 - o) * k + o * inner.k;
        S = [0, 1, 2].map(function (i) { return (1 - o) * S[i] + o * inner.S[i]; });
      } else if (L.pic) {
        o = clamp01(L.opacity === undefined ? 1 : L.opacity);
        k = (1 - o) * k + o;
        S = S.map(function (v) { return (1 - o) * v; });
      } else if (L.rgb) {
        var a = clamp01(L.a);
        k = (1 - a) * k;
        S = [0, 1, 2].map(function (i) { return (1 - a) * S[i] + a * L.rgb[i]; });
      }
    });
    return { k: k, S: S };
  }

  function clamp01(v) { v = Number(v); return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }
  function byte(v) { return Math.max(0, Math.min(255, Math.round(v))); }
  function round3(v) { return Math.round(v * 1000) / 1000; }

  /** Colour layers in a translucent group -> ONE colour at an alpha (exact
      for straight alpha blending), then the group's opacity on top. */
  function mergeColours(list, opacity) {
    var keep = 1;
    var S = [0, 0, 0];
    list.forEach(function (c) {
      if (!c || !(c.a > 0)) return;
      keep *= (1 - c.a);
      S = [0, 1, 2].map(function (i) { return (1 - c.a) * S[i] + c.a * [c.r, c.g, c.b][i]; });
    });
    var a = 1 - keep;
    if (a <= 1e-6) return null;
    var o = clamp01(opacity === undefined ? 1 : opacity);
    return { rgb: S.map(function (v) { return v / a; }), a: a * o };
  }

  /**
   * The hint for a composite.
   *   comp      { k, S } from compose()
   *   pic       'still'  the picture is Mantle's current desktop still, lined up
   *             'bitmap' another picture, with sample(i, n) -> [r,g,b] for
   *                      column i of n across the window (opts.sample)
   *             null     no picture is on the layer at all
   *   opts      { sample, cols }
   */
  function topFor(comp, pic, opts) {
    opts = opts || {};
    var k = clamp01(comp.k);
    var S = comp.S;
    if (k < K_EPS || !pic) {
      if (k >= K_EPS && !pic) return { kind: 'none' };   // a picture shows that nobody can name
      var sum = 1 - k;                                     // ~1: S is the whole row
      return { kind: 'flat', rgb: S.map(function (v) { return byte(v / (sum || 1)); }) };
    }
    if (pic === 'still') {
      var a = 1 - k;
      if (a < K_EPS) return { kind: 'wash', rgb: [0, 0, 0], alpha: 0 };
      return { kind: 'wash', rgb: S.map(function (v) { return byte(v / a); }), alpha: round3(a) };
    }
    if (pic === 'bitmap' && typeof opts.sample === 'function') {
      var n = Math.max(1, opts.cols | 0);
      var cols = [];
      for (var i = 0; i < n; i++) {
        var p = opts.sample(i, n);
        if (!p) return { kind: 'none' };
        cols.push([byte(k * p[0] + S[0]), byte(k * p[1] + S[1]), byte(k * p[2] + S[2])]);
      }
      return { kind: 'cols', cols: cols };
    }
    return { kind: 'none' };
  }

  /** How many columns for a window w CSS px wide. */
  function colCount(w) {
    return Math.max(COLS_MIN, Math.min(COLS_MAX, Math.round((Number(w) || 0) / COL_CSS_PX)));
  }

  /** One bitmap pixel row's average over [x0, x1) bitmap px, at row y
      (fractional: linear between the two rows around it), clamped to the
      bitmap the way a background's edge pixels repeat. */
  function rowAverage(px, x0, x1, y) {
    var w = px.w, h = px.h, d = px.data;
    var yc = Math.max(0, Math.min(h - 1, y));
    var ya = Math.floor(yc), yb = Math.min(h - 1, ya + 1), fy = yc - ya;
    var a = Math.max(0, Math.min(w - 1, Math.floor(x0)));
    var b = Math.max(a + 1, Math.min(w, Math.ceil(x1)));
    var acc = [0, 0, 0], n = 0;
    for (var x = a; x < b; x++) {
      var i1 = (ya * w + x) * 4, i2 = (yb * w + x) * 4;
      acc[0] += d[i1] * (1 - fy) + d[i2] * fy;
      acc[1] += d[i1 + 1] * (1 - fy) + d[i2 + 1] * fy;
      acc[2] += d[i1 + 2] * (1 - fy) + d[i2 + 2] * fy;
      n++;
    }
    return n ? [acc[0] / n, acc[1] / n, acc[2] / n] : null;
  }

  /**
   * A sampler for the window's top row over backdrop.js's blurred bitmap.
   *   src  Backdrop.toprowSource(): { pixels, lined, layout, place, outW, outH }
   *   win  { w, h } the window's content in CSS px
   * Lined: the bitmap is the monitor at layout.sx/sy plus m px of overscan,
   * so window x -> m + (content.x - display.x + x) * sx (backdrop.js
   * guardBand). Not lined: the bitmap is cover-fitted to the window,
   * centred (backdrop.css background-size: cover). Row 0's pixel CENTRE
   * (y = .5 CSS px) is what is sampled. null when it cannot be mapped.
   */
  function bitmapSampler(src, win) {
    var px = src && src.pixels;
    if (!px || !px.data || !px.w || !px.h || !win || !(win.w > 0) || !(win.h > 0)) return null;
    var map;
    if (src.lined) {
      var L = src.layout, pl = src.place;
      if (!L || !pl || !pl.content || !pl.display) return null;
      var ox = pl.content.x - pl.display.x, oy = pl.content.y - pl.display.y;
      map = { x: function (x) { return L.m + (ox + x) * L.sx; }, y: L.m + (oy + 0.5) * L.sy - 0.5 };
    } else {
      var bw = src.outW || px.w, bh = src.outH || px.h;
      var s = Math.max(win.w / bw, win.h / bh);
      var dx = (win.w - bw * s) / 2, dy = (win.h - bh * s) / 2;
      map = { x: function (x) { return (x - dx) / s; }, y: (0.5 - dy) / s - 0.5 };
    }
    return function (i, n) {
      var x0 = (i / n) * win.w, x1 = ((i + 1) / n) * win.w;
      return rowAverage(px, map.x(x0), map.x(x1), map.y);
    };
  }

  var maths = {
    parseColor: parseColor, gradientTop: gradientTop, imageLayers: imageLayers, compose: compose, mergeColours: mergeColours,
    topFor: topFor, colCount: colCount, rowAverage: rowAverage, bitmapSampler: bitmapSampler
  };

  if (typeof module === 'object' && module && module.exports && typeof document === 'undefined') {
    module.exports = maths;
    return;
  }

  /* --- the page ----------------------------------------------------- */

  var doc = root.document;
  var api = root.api && root.api.toprow ? root.api.toprow : null;
  var backdropEl = doc.querySelector('.backdrop');
  var baseEl = backdropEl && backdropEl.querySelector('.bg-base');
  var photoEl = backdropEl && backdropEl.querySelector('.bg-photo');
  var clearEl = backdropEl && backdropEl.querySelector('.bg-clear');
  var washEl = backdropEl && backdropEl.querySelector('.bg-wash');
  var titlebarEl = doc.getElementById('titlebar');
  var chromeLayerEl = doc.querySelector('.chrome-layer');
  var winButtons = ['win-min', 'win-max', 'win-close'].map(function (id) { return doc.getElementById(id); })
    .filter(Boolean);

  var last = { json: null, top: null, why: 'not worked out yet', at: 0 };
  var sent = 0;
  var mainStatus = api ? { state: 'starting', reason: 'waiting for main' }
    : { state: 'off', reason: 'this window has no top-row bridge (preload.js is older than toprow.js)' };
  var queued = false;
  var loopRaf = 0;
  var lastKickAt = 0;
  var testLog = null;            // test seam: [{ at, top, why, raf }] when on

  function cs(el, pseudo) { return el ? root.getComputedStyle(el, pseudo || null) : null; }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }

  /** The stack at row 0, read from the computed styles, and what picture
      is on the layer. -> { comp, pic, sample, cols, why } or { none: why } */
  function readStack() {
    var body = doc.body;
    if (!body || !backdropEl || !baseEl || !washEl) return { none: 'the background layer is missing' };
    if (body.classList.contains('fullscreen') || body.classList.contains('page-fullscreen')) {
      return { none: 'fullscreen: the chrome steps aside' };
    }
    for (var i = 0; i < winButtons.length; i++) {
      var bc = parseColor(cs(winButtons[i]).backgroundColor);
      if (!bc || bc.a > 0.004) return { none: 'a window button is lit (hover)' };
    }
    var src = null;
    try { src = root.Backdrop && typeof root.Backdrop.toprowSource === 'function' ? root.Backdrop.toprowSource() : null; } catch (err) { src = null; }

    var layers = [];
    var base = parseColor(cs(baseEl).backgroundColor);
    if (!base) return { none: "the base colour can't be read" };
    layers.push({ rgb: [base.r, base.g, base.b], a: 1 });   // opaque: what is under it never shows

    // The blurred layer counts while it paints anything at all, a fade-out
    // included (data-ready goes at once, the opacity takes 200ms).
    var photo = cs(photoEl);
    var photoOn = !!(photo && photo.visibility !== 'hidden' && photo.display !== 'none'
      && num(photo.opacity, 1) > 0 && photo.backgroundImage && photo.backgroundImage !== 'none');
    if (photoOn) layers.push({ pic: true, opacity: num(photo.opacity, 1) });

    var clear = cs(clearEl);
    var clearOn = !!(clear && clear.display !== 'none' && clearEl.hasAttribute('data-on'));
    if (clearOn) {
      var scrim = gradientTop(cs(clearEl, '::after').backgroundImage);
      if (!scrim) return { none: "the Home scrim can't be read" };
      var grp = [{ pic: true, opacity: 1 }];
      if (scrim.a > 0) grp.push({ rgb: [scrim.r, scrim.g, scrim.b], a: scrim.a });
      layers.push({ group: grp, opacity: num(clear.opacity, 1) });
    }

    var wash = cs(washEl);
    var wc = parseColor(wash.backgroundColor);
    if (!wc) return { none: "the wash can't be read" };
    var wo = num(wash.opacity, 1);
    if (wc.a > 0 && wo > 0 && wash.display !== 'none' && wash.visibility !== 'hidden') {
      layers.push({ rgb: [wc.r, wc.g, wc.b], a: wc.a * wo });
    }

    if (titlebarEl) {
      var tb = cs(titlebarEl);
      var tbc = parseColor(tb.backgroundColor);
      var tint = imageLayers(tb.backgroundImage);        // the workspace tint: "linear-gradient(..), none"
      if (!tbc || !tint) {
        return { none: "the tab strip's fill can't be read (" + String(!tbc ? tb.backgroundColor : tb.backgroundImage).slice(0, 80) + ')' };
      }
      var chromeO = num(cs(chromeLayerEl) ? cs(chromeLayerEl).opacity : 1, 1) * num(tb.opacity, 1);
      var merged = mergeColours([tbc].concat(tint), chromeO);   // the colour under, then the image layers over it
      if (merged) layers.push(merged);
    }

    var comp = compose(layers);
    var pic = null;
    var why;
    var kind = src ? src.kind : 'unknown';
    if ((photoOn || clearOn) && !(src && src.shown)) {
      why = 'a picture is fading out that the layer no longer names';   // pic stays null: none
    } else if (photoOn || clearOn) {
      var still = !!(src && src.lined && src.deskStillUrl && src.srcKey === 'desktop|' + src.deskStillUrl);
      if (still) {
        pic = 'still';
        why = clearOn ? 'Home: the desktop picture under the wash and the scrim' : 'the desktop picture under the wash';
      } else {
        pic = 'bitmap';
        why = (clearOn ? 'Home: ' : '') + (kind === 'desktop'
          ? (src && src.state === 'fallback' ? "Windows' wallpaper (Mantle's still is not in use)" : 'an older desktop still while the new one is prepared')
          : kind === 'video' ? "the clip's still" : kind === 'builtin' ? 'a built-in photo' : kind === 'image' ? 'your own picture' : 'a picture') + ', worked out per column';
      }
    } else {
      why = kind === 'none' ? 'no picture: the plain ground under the wash'
        : 'the picture is not on screen yet: the plain ground under the wash';
    }
    var w = root.innerWidth, h = root.innerHeight;
    return {
      comp: comp, pic: pic, why: why,
      sample: pic === 'bitmap' ? bitmapSampler(src, { w: w, h: h }) : null,
      cols: colCount(w)
    };
  }

  function compute() {
    var st;
    try { st = readStack(); } catch (err) { st = { none: 'could not be worked out (' + ((err && err.message) || err) + ')' }; }
    var top, why;
    if (st.none) { top = { kind: 'none' }; why = st.none; }
    else {
      top = topFor(st.comp, st.pic, { sample: st.sample, cols: st.cols });
      why = st.why;
      if (top.kind === 'none' && st.pic === 'bitmap') why = "the picture's pixels can't be read (" + st.why + ')';
    }
    return { top: top, why: why };
  }

  /** Work the row out now and send it if it changed. */
  function run(reason, raf) {
    var r = compute();
    var json = JSON.stringify(r.top);
    last.why = r.why;
    if (json === last.json) return false;
    last.json = json;
    last.top = r.top;
    last.at = Date.now();
    var sentAt = root.performance.timeOrigin + root.performance.now();
    if (api) {
      try { api.hint(r.top, last.at); sent++; } catch (err) { /* main's problem; status says so */ }
    }
    // Settings > Look shows what Mantle is being told (its line re-reads status()).
    try { doc.dispatchEvent(new CustomEvent('toprowstatus', { detail: null })); } catch (err) { /* a listener's problem */ }
    if (testLog) {
      testLog.push({ at: sentAt, top: r.top, why: r.why, reason: reason || null, raf: !!raf });
      if (testLog.length > 400) testLog.shift();
    }
    return true;
  }

  function animating() {
    var els = [photoEl, clearEl, washEl, titlebarEl, chromeLayerEl].concat(winButtons);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el || typeof el.getAnimations !== 'function') continue;
      var list = el.getAnimations();
      for (var j = 0; j < list.length; j++) {
        if (list[j].playState === 'running' || list[j].pending) return true;
      }
    }
    return false;
  }

  /** Follow a fade once per frame, inside rAF (the values of the frame
      about to be drawn), until nothing on the stack is animating. */
  function follow() {
    if (loopRaf) return;
    if (!animating()) return;
    loopRaf = root.requestAnimationFrame(function step() {
      loopRaf = 0;
      run('frame', true);
      if (Date.now() - lastKickAt < LOOP_MAX_MS && animating()) loopRaf = root.requestAnimationFrame(step);
      else run('settled', true);
    });
  }

  /** Queue one compute at the end of this task (a microtask: before the
      browser renders the change). */
  function kick(reason) {
    lastKickAt = Date.now();
    if (queued) return;
    queued = true;
    var go = function () {
      queued = false;
      run(reason);
      follow();
    };
    if (typeof root.queueMicrotask === 'function') root.queueMicrotask(go);
    else Promise.resolve().then(go);
  }

  function status() {
    return {
      top: last.top, why: last.why, sent: sent, at: last.at || null,
      main: JSON.parse(JSON.stringify(mainStatus))
    };
  }

  function setMainStatus(s) {
    if (!s || typeof s !== 'object') return;
    mainStatus = s;
    try { doc.dispatchEvent(new CustomEvent('toprowstatus', { detail: status() })); } catch (err) { /* a listener's problem */ }
  }

  /* --- wiring ------------------------------------------------------- */

  if (typeof MutationObserver === 'function') {
    var mo = new MutationObserver(function () { kick('mutation'); });
    mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class', 'data-palette'] });
    if (doc.body) mo.observe(doc.body, { attributes: true, attributeFilter: ['class', 'data-bg-home', 'data-bg-state', 'data-bg-kind'] });
    if (backdropEl) mo.observe(backdropEl, { attributes: true, subtree: true });
    if (titlebarEl) mo.observe(titlebarEl, { attributes: true, attributeFilter: ['data-ws-colour', 'class', 'style'] });
    if (chromeLayerEl) mo.observe(chromeLayerEl, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  doc.addEventListener('backdropchange', function () { kick('backdrop'); });
  winButtons.forEach(function (b) {
    b.addEventListener('mouseenter', function () { kick('hover'); });
    b.addEventListener('mouseleave', function () { kick('hover'); });
  });
  root.addEventListener('resize', function () { kick('resize'); });

  if (api) {
    try { if (typeof api.onStatus === 'function') api.onStatus(setMainStatus); } catch (err) { /* status stays 'starting' */ }
    try {
      Promise.resolve(api.status()).then(setMainStatus, function (err) {
        setMainStatus({ state: 'off', reason: 'main did not answer (' + ((err && err.message) || err) + ')' });
      });
    } catch (err) { setMainStatus({ state: 'off', reason: 'main could not be asked (' + ((err && err.message) || err) + ')' }); }
  }

  root.Toprow = {
    status: status,
    kick: function (why) { kick(why || 'kick'); },
    // test seams
    _now: function () { return compute(); },
    _log: function (on) {
      if (on === true) testLog = [];
      else if (on === false) testLog = null;
      return testLog ? testLog.slice() : null;
    },
    _maths: maths
  };

  // The first hint, before the window is shown (main shows it on ready-to-show).
  kick('boot');
})(typeof window !== 'undefined' ? window : globalThis);
