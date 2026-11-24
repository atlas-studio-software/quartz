/* ============================================================
   frost.js — the floating islands' glass: the picture, blurred, under
   every panel, at the picture's own colours.

   The look (the user, 2026-11-24): everything floats over the wallpaper as
   islands with gaps and soft shadows; a panel shows ONLY the blurred
   picture behind it. No tint film, no sheen, no hairline edge.

   How it stays cheap (no live backdrop-filter, which the integrated GPU
   pays for on every frame):
   - The picture backdrop.js shows (.bg-clear-img when it is up, else the
     small .bg-photo) is blurred TWICE, once, into 512 px wide canvases:
       light  BLURS.light px  (about 16 px on screen): small chrome
       soft   BLURS.soft px   (about 40 px on screen): big panels
     A panel is BIG when its short side is >= BIG_MIN and its area >=
     BIG_AREA (isBig). The copies become two blob URLs on :root
     (--frost, --frost-soft).
   - Every .frost element paints its copy at the picture's on-screen size
     (--fw / --fh on :root) and offset (--fx / --fy on the element), so it
     shows exactly the blurred picture behind it. Placing is a few rect
     reads, coalesced into one animation frame, and runs only when
     something moved: a resize, the picture or its layer moving (the
     window moving, lined up with the monitor), a panel appearing or
     changing size. Nothing runs at rest.
   - The user's Dim (the window's one wash, --chrome-glass-a) is painted
     into every panel too, the same colour as the wash under it, so a
     panel is the blurred version of what is around it.

   Brightness check (LEGIBILITY_FLOOR, on): a panel samples the blurred,
   dimmed picture behind it on an 8 x 5 grid. Where the brightest tenth
   would leave white text under 4.5:1, it adds just enough neutral
   rgb(10,12,14) (--film) to bring that tenth to luminance TARGET or less,
   in FILM_STEP steps up to FILM_MAX. Over a dark area that is 0.

   Dim default (DIM_DEFAULT, 20%): see effectiveDim. Look Sync is
   untouched: this file never writes look.json or the shared glass; it only
   decides what Quartz paints.

   Pure parts (frost-harness.js): isBig, kindFor, coverGeometry, lumOf,
   filmFromPixels, effectiveDim. The DOM part runs only in the chrome
   window.

   Public surface: window.Frost = { refresh(), state(), ...pure }.
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Frost = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---- the tuning knobs (the prototype's, 2026-11-24) ---- */
  var BITMAP_W = 512;
  var BLURS = { light: 6, soft: 15 };     // px on the 512 px bitmap
  var BIG_MIN = 48;
  var BIG_AREA = 20000;
  var TARGET = 0.163;                     // white text 4.5:1 over it
  var FILM_RGB = [10, 12, 14];
  var FILM_MAX = 0.56;
  var FILM_STEP = 0.04;
  var GRID = { cols: 8, rows: 5 };
  var LEGIBILITY_FLOOR = true;
  var DIM_DEFAULT = 0.20;
  var SEED_DIM = 0.30;                    // looksync.js's seed (DEFAULT_GLASS dim)

  /* ---- pure ---- */

  function isBig(w, h) {
    w = Number(w) || 0; h = Number(h) || 0;
    return Math.min(w, h) >= BIG_MIN && w * h >= BIG_AREA;
  }

  function kindFor(w, h) { return isBig(w, h) ? 'soft' : 'light'; }

  /** The picture's rect when painted `cover` into box {left, top, width, height}. */
  function coverGeometry(box, iw, ih) {
    if (!box || !(iw > 0) || !(ih > 0) || !(box.width > 0) || !(box.height > 0)) return null;
    var s = Math.max(box.width / iw, box.height / ih);
    var cw = iw * s, ch = ih * s;
    return { ox: box.left + (box.width - cw) / 2, oy: box.top + (box.height - ch) / 2, cw: cw, ch: ch };
  }

  function lin(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }

  /** Relative luminance of rgb (0..255) under a FILM_RGB film of alpha a. */
  function lumOf(rgb, a) {
    a = a || 0;
    var r = rgb[0] * (1 - a) + FILM_RGB[0] * a;
    var g = rgb[1] * (1 - a) + FILM_RGB[1] * a;
    var b = rgb[2] * (1 - a) + FILM_RGB[2] * a;
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  /**
   * The film one panel needs. lum = { w, h, px } (RGBA bytes of the blurred
   * copy it shows); geo = coverGeometry of the picture on screen; rect =
   * the panel {x, y, w, h} in the same px; dim = the wash alpha over the
   * picture (dark: towards black). -> 0 .. FILM_MAX, in FILM_STEP steps.
   */
  function filmFromPixels(lum, geo, rect, dim) {
    if (!LEGIBILITY_FLOOR || !lum || !lum.px || !geo || !rect || !(rect.w > 0) || !(rect.h > 0)) return 0;
    var keep = 1 - Math.max(0, Math.min(1, Number(dim) || 0));
    var samples = [];
    for (var i = 0; i < GRID.cols; i++) {
      for (var j = 0; j < GRID.rows; j++) {
        var sx = rect.x + ((i + 0.5) / GRID.cols) * rect.w;
        var sy = rect.y + ((j + 0.5) / GRID.rows) * rect.h;
        var bx = Math.min(lum.w - 1, Math.max(0, Math.floor(((sx - geo.ox) / geo.cw) * lum.w)));
        var by = Math.min(lum.h - 1, Math.max(0, Math.floor(((sy - geo.oy) / geo.ch) * lum.h)));
        var k = (by * lum.w + bx) * 4;
        var rgb = [lum.px[k] * keep, lum.px[k + 1] * keep, lum.px[k + 2] * keep];
        samples.push({ rgb: rgb, l: lumOf(rgb, 0) });
      }
    }
    samples.sort(function (p, q) { return q.l - p.l; });
    var bright = samples[Math.floor(samples.length * 0.1)].rgb;
    var a = 0;
    while (a < FILM_MAX - 1e-9 && lumOf(bright, a) > TARGET) a = Math.round((a + FILM_STEP) * 100) / 100;
    return Math.min(FILM_MAX, a);
  }

  /**
   * The Dim Quartz paints (Look Sync untouched). g = the glass in effect
   * ({ dim, dimSet? }); `userSet` = the user moved Quartz's own Dim slider
   * (a saved value). The shared seed (0.30) is Look Sync's starting point,
   * not a choice, so it reads as Quartz's default 20%; any other shared
   * value was somebody's choice and wins, as does a saved slider value.
   * -> { dim, source: 'saved' | 'shared' | 'default', reason }
   */
  function effectiveDim(g, userSet) {
    var d = g && typeof g.dim === 'number' && isFinite(g.dim) ? g.dim : null;
    if (d == null) return { dim: DIM_DEFAULT, source: 'default', reason: 'no Dim is set, so Quartz uses its default 20%' };
    if (userSet) return { dim: d, source: 'saved', reason: 'your Dim' };
    if (Math.abs(d - SEED_DIM) < 1e-6) {
      return { dim: DIM_DEFAULT, source: 'default', reason: "Look Sync still has its starting Dim (30%), so Quartz uses its default 20%" };
    }
    return { dim: d, source: 'shared', reason: 'the Dim shared through Look Sync' };
  }

  var pure = {
    BITMAP_W: BITMAP_W, BLURS: BLURS, BIG_MIN: BIG_MIN, BIG_AREA: BIG_AREA, TARGET: TARGET, FILM_RGB: FILM_RGB,
    FILM_MAX: FILM_MAX, FILM_STEP: FILM_STEP, GRID: GRID, LEGIBILITY_FLOOR: LEGIBILITY_FLOOR,
    DIM_DEFAULT: DIM_DEFAULT, SEED_DIM: SEED_DIM,
    isBig: isBig, kindFor: kindFor, coverGeometry: coverGeometry, lumOf: lumOf,
    filmFromPixels: filmFromPixels, effectiveDim: effectiveDim,
  };
  if (typeof document === 'undefined' || typeof window === 'undefined') return pure;

  /* ---- DOM ----
     Two documents use this file:
       the chrome  (index.html): it blurs the picture backdrop.js shows and
                   lines the copies up under its own panels, and offers the
                   copies to the Home guest (payload(), 'frostchange');
       the Home    (newtab.html, a preload-less file:// guest): it never
                   blurs anything itself (a file: picture would taint its
                   canvas); the chrome pushes the two copies in as data:
                   URLs with the wash (window.__applyFrost), and newtab.js
                   says where the picture sits (setPictureBox). */

  var docEl = document.documentElement;
  var photoEl = document.querySelector('.backdrop > .bg-photo');
  var clearImgEl = document.querySelector('.bg-clear > .bg-clear-img');
  var chromeMode = !!photoEl;
  var copies = { light: null, soft: null };      // { url, lum, dataUrl? }
  var srcUrl = '';
  var img = { w: 0, h: 0 };
  var buildSeq = 0;
  var rev = 0;
  var pending = false;
  var pictureBox = null;                         // guest: the picture's box, or null = cover on the page
  var guestDim = null;
  var selector = '.frost';                       // + what a page adds with watch()
  var st = { state: 'waiting', reason: 'no picture yet', panels: 0, films: 0, source: '', mode: chromeMode ? 'chrome' : 'guest' };

  function urlOfBg(el) {
    if (!el) return '';
    var m = /url\(["']?(.*?)["']?\)/.exec(el.style.backgroundImage || '');
    return m ? m[1] : '';
  }

  /** The chrome: the element whose picture is on screen now, and its URL. */
  function pictureNow() {
    var home = document.body && document.body.hasAttribute('data-bg-home');
    var el = home && urlOfBg(clearImgEl) ? clearImgEl : photoEl;
    return { el: el, url: urlOfBg(el) };
  }

  function lumOfImage(source, w, h) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(source, 0, 0, w, h);
    return { canvas: c, lum: { w: w, h: h, px: g.getImageData(0, 0, w, h).data } };
  }

  function blurCopy(source, w, h, blurPx) {
    var p = Math.ceil(blurPx * 3);
    var a = document.createElement('canvas'); a.width = w + 2 * p; a.height = h + 2 * p;
    var ga = a.getContext('2d');
    ga.fillStyle = '#1b2023'; ga.fillRect(0, 0, a.width, a.height);
    ga.drawImage(source, p, p, w, h);
    // stretched edges, so the blur does not fade to the ground at the borders
    ga.drawImage(source, 0, 0, img.w, 1, p, 0, w, p);
    ga.drawImage(source, 0, img.h - 1, img.w, 1, p, p + h, w, p);
    ga.drawImage(source, 0, 0, 1, img.h, 0, p, p, h);
    ga.drawImage(source, img.w - 1, 0, 1, img.h, p + w, p, p, h);
    var b = document.createElement('canvas'); b.width = a.width; b.height = a.height;
    var gb = b.getContext('2d');
    gb.filter = 'blur(' + blurPx + 'px)';
    gb.drawImage(a, 0, 0);
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var gc = c.getContext('2d', { willReadFrequently: true });
    gc.drawImage(b, p, p, w, h, 0, 0, w, h);
    return { canvas: c, lum: { w: w, h: h, px: gc.getImageData(0, 0, w, h).data } };
  }

  function setCopy(name, entry) {
    var old = copies[name];
    copies[name] = entry;
    docEl.style.setProperty(name === 'light' ? '--frost' : '--frost-soft', entry ? 'url("' + entry.url + '")' : 'none');
    if (old && old.url && old.url.indexOf('blob:') === 0) { try { URL.revokeObjectURL(old.url); } catch (e) { /* gone */ } }
  }

  function says(state, reason) {
    st.state = state; st.reason = reason || '';
    if (state === 'ok') docEl.setAttribute('data-frost', ''); else docEl.removeAttribute('data-frost');
    if (state === 'fallback' && reason) console.warn('[frost] ' + reason);
  }

  /** The chrome: re-blur when the picture's URL changes; nothing else ever re-blurs. */
  function rebuild() {
    if (!chromeMode) return;
    var now = pictureNow();
    if (!now.url) {
      if (srcUrl) { srcUrl = ''; setCopy('light', null); setCopy('soft', null); rev++; announce(); }
      says('waiting', 'no picture is shown, so the panels show the plain ground');
      return;
    }
    if (now.url === srcUrl) return;
    srcUrl = now.url;
    var my = ++buildSeq;
    var im = new Image();
    im.src = now.url;
    (typeof im.decode === 'function' ? im.decode() : Promise.resolve()).then(function () {
      if (my !== buildSeq) return;
      img.w = im.naturalWidth; img.h = im.naturalHeight;
      var w = BITMAP_W, h = Math.max(1, Math.round(w * img.h / img.w));
      var left = 2;
      Object.keys(BLURS).forEach(function (name) {
        var made;
        try { made = blurCopy(im, w, h, BLURS[name]); } catch (err) {
          says('fallback', 'the picture could not be blurred for the panels (' + ((err && err.message) || err) + '), so they show the plain ground');
          return;
        }
        var dataUrl = '';
        try { dataUrl = made.canvas.toDataURL('image/jpeg', 0.86); } catch (err) { dataUrl = ''; }
        made.canvas.toBlob(function (blob) {
          if (my !== buildSeq) return;
          if (blob) setCopy(name, { url: URL.createObjectURL(blob), lum: made.lum, dataUrl: dataUrl });
          if (--left === 0) {
            st.source = now.el === clearImgEl ? 'full picture' : 'small picture';
            says('ok');
            rev++;
            queue();
            announce();
          }
        }, 'image/jpeg', 0.92);
      });
    }, function (err) {
      if (my !== buildSeq) return;
      says('fallback', 'the picture could not be decoded for the panels\' blur (' + ((err && err.message) || err) + '), so they show the plain ground');
    });
  }

  function announce() {
    try { document.dispatchEvent(new CustomEvent('frostchange', { detail: { rev: rev } })); } catch (e) { /* old engine */ }
  }

  /** The chrome: what the Home guest needs, or null while there is nothing. */
  function payload() {
    if (!chromeMode || !copies.light || !copies.soft || !copies.light.dataUrl || !copies.soft.dataUrl) return null;
    var now = pictureNow();
    var r = now.el ? now.el.getBoundingClientRect() : null;
    return { rev: rev, iw: img.w, ih: img.h, light: copies.light.dataUrl, soft: copies.soft.dataUrl,
             dim: dimNow(), washRgb: getComputedStyle(docEl).getPropertyValue('--wash-rgb').trim(),
             picture: r && r.width ? { left: r.left, top: r.top, width: r.width, height: r.height } : null };
  }

  var DATA_JPEG = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
  var MAX_DATA = 4 * 1024 * 1024;

  /** The Home guest: the chrome's copies arrive. Checked before anything is drawn. */
  function applyGuest(p) {
    if (chromeMode) return { ok: false, reason: 'only the Home page takes pushed copies' };
    if (!p || typeof p !== 'object') return { ok: false, reason: 'no copies were sent' };
    if (typeof p.dim === 'number' && isFinite(p.dim)) {
      guestDim = Math.max(0, Math.min(1, p.dim));
      docEl.style.setProperty('--chrome-glass-a', String(guestDim));
    }
    if (typeof p.washRgb === 'string' && /^\d{1,3} \d{1,3} \d{1,3}$/.test(p.washRgb)) docEl.style.setProperty('--wash-rgb', p.washRgb);
    // where the chrome's picture sits, in this page's px (null = cover on the page)
    if (p.box !== undefined) setPictureBox(p.box);
    if (p.light === undefined && p.soft === undefined) { queue(); return { ok: true, reason: 'the wash only' }; }
    var bad = ['light', 'soft'].filter(function (k) { return typeof p[k] !== 'string' || p[k].length > MAX_DATA || !DATA_JPEG.test(p[k]); });
    if (bad.length || !(p.iw > 0) || !(p.ih > 0)) {
      says('fallback', 'the chrome sent copies this page cannot use, so the pieces show the plain ground');
      return { ok: false, reason: st.reason };
    }
    if (p.rev === rev && copies.light) return { ok: true, reason: 'already shown' };
    var my = ++buildSeq;
    img.w = p.iw; img.h = p.ih;
    var left = 2;
    ['light', 'soft'].forEach(function (name) {
      var im = new Image();
      im.src = p[name];
      (typeof im.decode === 'function' ? im.decode() : Promise.resolve()).then(function () {
        if (my !== buildSeq) return;
        var made = lumOfImage(im, im.naturalWidth || BITMAP_W, im.naturalHeight || 1);
        setCopy(name, { url: p[name], lum: made.lum });
        if (--left === 0) { rev = p.rev; st.source = 'the chrome'; says('ok'); queue(); }
      }, function () {
        if (my !== buildSeq) return;
        says('fallback', 'the copies the chrome sent did not decode, so the pieces show the plain ground');
      });
    });
    return { ok: true, reason: '' };
  }

  /** The Home guest: where the picture sits ({left, top, width, height}), or null = cover on the page. */
  function setPictureBox(box) {
    var ok = box && isFinite(box.left) && isFinite(box.top) && box.width > 0 && box.height > 0;
    pictureBox = ok ? { left: box.left, top: box.top, width: box.width, height: box.height } : null;
    queue();
  }

  function dimNow() {
    var v = parseFloat(getComputedStyle(docEl).getPropertyValue('--chrome-glass-a'));
    return isFinite(v) ? v : (guestDim == null ? DIM_DEFAULT : guestDim);
  }

  function geometryNow() {
    if (chromeMode) {
      var now = pictureNow();
      return now.el ? coverGeometry(now.el.getBoundingClientRect(), img.w, img.h) : null;
    }
    var box = pictureBox || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    return coverGeometry(box, img.w, img.h);
  }

  function place() {
    pending = false;
    var geo = img.w ? geometryNow() : null;
    if (geo) {
      docEl.style.setProperty('--fw', geo.cw.toFixed(1) + 'px');
      docEl.style.setProperty('--fh', geo.ch.toFixed(1) + 'px');
    }
    var dim = dimNow();
    var panels = document.querySelectorAll(selector);
    var films = 0, count = 0;
    for (var i = 0; i < panels.length; i++) {
      var f = panels[i];
      if (!f.offsetWidth && !f.offsetHeight) continue;
      count++;
      var r = f.getBoundingClientRect();
      var kind = kindFor(f.offsetWidth, f.offsetHeight);
      f.classList.toggle('soft', kind === 'soft');
      if (geo) {
        var fx = (geo.ox - r.left).toFixed(1) + 'px', fy = (geo.oy - r.top).toFixed(1) + 'px';
        if (f.style.getPropertyValue('--fx') !== fx) f.style.setProperty('--fx', fx);
        if (f.style.getPropertyValue('--fy') !== fy) f.style.setProperty('--fy', fy);
      }
      var copy = copies[kind];
      var a = copy && geo ? filmFromPixels(copy.lum, geo, { x: r.left, y: r.top, w: f.offsetWidth, h: f.offsetHeight }, dim) : 0;
      if (a > 0) films++;
      var s = a.toFixed(2);
      if (f.style.getPropertyValue('--film') !== s) f.style.setProperty('--film', s);
    }
    st.panels = count; st.films = films;
  }

  function queue() {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(place);
  }

  function refresh() { rebuild(); queue(); }

  // What moves a panel's picture: the picture changing or its layer moving
  // (backdrop.js writes its style), the window resizing, a panel appearing,
  // going or changing size, the page scrolling. A panel MOVED by script
  // (islands.js plates, a Home piece placed or dragged) calls Frost.refresh().
  // All of it is coalesced into one frame. Style changes are not watched: a
  // progress bar ticking would re-place every panel for nothing.
  var mo = typeof MutationObserver === 'function' && chromeMode ? new MutationObserver(function () { refresh(); }) : null;
  if (mo) {
    mo.observe(photoEl, { attributes: true, attributeFilter: ['style', 'data-ready'] });
    if (clearImgEl) mo.observe(clearImgEl, { attributes: true, attributeFilter: ['style'] });
    if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['data-bg-home'] });
  }
  var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(function () { queue(); }) : null;
  var watched = typeof WeakSet === 'function' ? new WeakSet() : null;
  function watchPanels() {
    if (!ro || !watched) return;
    var panels = document.querySelectorAll(selector);
    for (var i = 0; i < panels.length; i++) if (!watched.has(panels[i])) { watched.add(panels[i]); ro.observe(panels[i]); }
  }
  function startTree() {
    var tree = typeof MutationObserver === 'function' ? new MutationObserver(function () { watchPanels(); queue(); }) : null;
    if (tree && document.body) tree.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
    watchPanels();
  }
  if (document.body) startTree(); else document.addEventListener('DOMContentLoaded', startTree, { once: true });
  window.addEventListener('resize', queue);
  window.addEventListener('scroll', queue, { passive: true, capture: true });
  if (chromeMode) document.addEventListener('backdropchange', refresh);
  else window.__applyFrost = applyGuest;
  refresh();

  pure.refresh = refresh;
  pure.payload = payload;
  pure.setPictureBox = setPictureBox;
  /** Also line up elements a page makes on the fly (the Home's chips and tiles), by selector. */
  pure.watch = function (sel) {
    if (typeof sel !== 'string' || !sel || selector.split(', ').indexOf(sel) >= 0) return;
    selector += ', ' + sel;
    watchPanels();
    queue();
  };
  pure.state = function () { return { state: st.state, reason: st.reason, panels: st.panels, films: st.films, source: st.source, mode: st.mode }; };
  return pure;
});
