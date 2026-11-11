/* ============================================================
   backdrop.js — the one blurred picture behind the whole chrome.

   Quartz dresses like Helm: the tab strip, the toolbar and the side
   panes are translucent tints over ONE fixed background layer, and
   that layer is a picture blurred ONCE, ahead of time. This file
   owns that layer (index.html's .backdrop > .bg-base / .bg-photo /
   .bg-wash; backdrop.css paints them).

   What the picture is comes from Settings (key newtabBackground,
   read through Settings.backgroundConfig() and its change events):

     desktop    "Same as desktop", the default (Look Sync, 2026-10-10):
                Mantle's desktop still (LookSync.desktop().stillUrl),
                drawn LINED UP with the screen, so the chrome looks
                see-through to the wallpaper: the still is blurred once
                into a canvas the size of the MONITOR the window is mostly
                on (cover-fit on that monitor, the way the desktop draws
                it), and .bg-photo is that monitor-sized layer, moved by a
                transform to (monitor origin - content origin). Moving the
                window moves the layer, once per animation frame; nothing
                re-blurs until the still, the blur or the monitor size
                changes. When Mantle has not shared a still, the copy of
                the Windows wallpaper (main's <userData>/backgrounds/
                wallpaper.<ext>, bgfiles.js) is drawn the same way, with
                state 'fallback' and LookSync's reason. A stored
                'wallpaper' (the old default) reads as 'desktop'.
     builtin    one of Helm's photos, shipped in assets/backgrounds/ and
                listed by main (Settings.builtinBackground(id)). An id
                this build does not have shows the WALLPAPER instead,
                with state 'fallback' and the reason, so the window is
                never left plain over a stale setting.
     image      the user's own picture, the JPEG Settings keeps in
                IndexedDB (db 'browser', store 'assets', 'newtab-bg').
     video      the user's clip or GIF, main's copy in backgrounds/.
                It PLAYS on the new tab; behind the chrome it is one
                still frame, captured once and cached (below).
     none       no picture: the plain --bg ground.

   How it stays cheap, which is the whole point of the design:

   - The blur happens once per source, into a small canvas (about a
     third of the screen), with ctx.filter set to the Helm 5px scaled
     down by the same factor, and a few sigmas of overscan so the
     edges blur into real pixels instead of fading to grey. The
     result is a JPEG blob set as .bg-photo's background-image, with
     background-size: cover. Resizing the window only rescales a
     bitmap; nothing re-blurs, nothing runs per frame, and there is
     no CSS filter on a full-window layer for this GPU to tile.
   - It redoes the work only when the SOURCE changes: the kind, the
     clip (fileUrl + fileName + clipRev), the picture (imageRev), or
     a "Copy again from Windows". The dim slider, the theme and the
     accent never cause a re-blur (the wash is plain CSS).
   - A video or GIF is decoded exactly once per clip: an offscreen
     <video> (never put in the document) seeks to ~1 s in (10% in
     for a clip under ten seconds), one frame is drawn, the element
     is torn down, and the frame is cached in IndexedDB under
     'bg-still' as { id: fileUrl|fileName|clipRev, blob }. Later
     boots read the cached still and never touch the clip.

   No silent failures: when the picture cannot be had (no wallpaper
   file, a deleted clip, a picture that will not decode) the layer
   falls back to the plain --bg, <body data-bg-state="fallback">,
   and the reason is in Backdrop.state() for Settings to show under
   the picker.

   Glass (Look Sync): LookSync.glassFor(theme) -> { blurPx, dim, panel }
   for the resolved theme. blurPx is the blur (Helm's 5 = the old fixed
   value; light adds saturate(150%), CONTRACT "Light look"); dim is the
   FLOOR of the window's wash (--chrome-glass-a: dark rgb(9 10 11), light
   white), which Mantle's shared top-band value (desktop.guard.<theme>)
   may raise while following the desktop, and in dark Quartz's own guard
   otherwise (below); panel shifts the alpha of --surface-0..3 and
   --overlay (0 = tokens.css as is).

   Public surface:
     <body data-bg-kind="desktop|builtin|image|video|none"
           data-bg-state="loading|ok|fallback">
     window.Backdrop.state()  -> { kind, state, reason, source,
       glass: { theme, floor, alpha, raised, source, sourceReason, ownAlpha,
                blurPx, panel, lined, offset:{x,y} },
       home: { on, reason } }
     window.Backdrop.refresh() -> re-reads the source now
     <body data-bg-home> while the picture shows UNBLURRED (Helm's Home
       look, below). That is the window's look whenever it shows a still
       picture, whatever tab is in front: the top band never changes with
       the front tab (the user, 2026-11-11). The blurred layer is then
       covered and stops drawing; it stays the look while the sharp copy
       is being prepared and for a clip's still.
     window.Backdrop.recopyWallpaper() -> { ok, reason, copiedAt }
     'backdropchange' on document, detail = state()
   ============================================================ */
(function () {
  'use strict';

  /* The Helm blur (Helm settings.json background.blur = 5; Helm's
     default is 28) at full size, and how far down the bitmap is rendered.
     The blur radius shrinks with the bitmap so the result matches Helm's
     5px once cover scales it back up; at 5px that is 1.5 bitmap px, still
     a properly sampled gaussian, so a third of the screen is enough. */
  /* Look Sync: the blur is the shared glass.<theme>.blurPx (0..64) instead
     of a fixed HELM_BLUR_PX; dark's seed 5 is exactly the old value, so the
     bitmap blur stays round(5 * SCALE, .1) = 1.5 px. Seeds = LS.SEED glass,
     used when neither LookSync nor Settings answers. */
  var SEED_GLASS = {
    dark: { blurPx: 5, dim: 0.5, panel: 0 },
    light: { blurPx: 12, dim: 0.45, panel: 0 }
  };
  /* Light (CONTRACT "Light look", 2026-10-14, un-held): glass.light is
     applied in light exactly as glass.dark is in dark. The ground is the
     picture at blur(glass.light.blurPx) saturate(150%), Mantle's island
     light; dark keeps its plain blur. LIGHT_WASH_DIM = backdrop.css's
     fallback for the white wash when nothing has set --chrome-glass-a. */
  var LIGHT_WASH_DIM = 0.45;
  var LIGHT_SATURATE = 150;      // % (Mantle ui/shared/glass-light.css ground)
  var SCALE = 0.3;
  /* Overscan, in blur radii: Helm's .bg-photo sits at
     inset: calc(var(--bg-blur) * -2.5), so its picture is cover-fitted to
     the window plus 2.5 blur radii on every side and the edges blur into
     real pixels. The same 2.5 here frames the picture exactly as Helm
     does (and is past 99% of a gaussian's weight). */
  var OVERSCAN_SIGMAS = 2.5;
  var OUT_TYPE = 'image/jpeg';
  var OUT_QUALITY = 0.9;

  /* IndexedDB keys in Settings' asset store (db 'browser', 'assets'). */
  var IMAGE_KEY = 'newtab-bg';   // the user's picture (settings.js owns it)
  var STILL_KEY = 'bg-still';    // the cached video/GIF still (this file)
  var STILL_MAX_EDGE = 1280;     // the still is only ever blurred: small is fine
  /* A clip's still (see captureVideoStill): a read that shows no progress
     for STALL fails, none may run past CEILING, and a seek past a black
     first frame gets SEEK_GRACE before the first frame is used anyway.
     A failed still is retried on RETRY_STEPS_MS, then every RETRY_EVERY_MS. */
  var STILL_STALL_MS = 15000;
  var STILL_CEILING_MS = 60000;
  var SEEK_GRACE_MS = 4000;
  var RETRY_STEPS_MS = [5000, 15000, 30000, 60000];
  var RETRY_EVERY_MS = 120000;
  /* Lined up: a move "ends" MOVE_END_MS after the last lookplace (then the
     guard re-reads the band and the layer drops its compositor hint). A
     glass change (a slider preview) re-blurs LOOK_RENDER_MS after it stops.
     The desktop record is waited for at most DESK_WAIT_MS (the glue
     promises 4 s). CACHE_MAX blurred results are kept: a theme flip
     between dark's and light's blur swaps without re-blurring. */
  var MOVE_END_MS = 250;
  var LOOK_RENDER_MS = 150;
  var DESK_WAIT_MS = 5000;
  var CACHE_MAX = 2;

  /* Plain node (backdrop-harness.js) loads this file for its pure rules
     alone: no document, so nothing else runs. */
  if (typeof document === 'undefined') {
    if (typeof module === 'object' && module && module.exports) module.exports = { homeReason: homeReason };
    return;
  }

  var layer = document.querySelector('.backdrop');
  var photoEl = layer ? layer.querySelector('.bg-photo') : null;

  var current = { kind: 'desktop', state: 'loading', reason: null, source: null };
  var shown = null;              // the cache entry on .bg-photo right now (null = no picture)
  var cache = [];                // blurred results, oldest first (see cachePut)
  var seq = 0;                   // newest render wins; older ones drop out
  var lastSig = null;
  var recopyNote = null;         // a failed "Copy again", told once
  var lastRender = null;         // test seam: what the shown blur did
  var placeNow = null;           // LookSync.place(), the last valid one
  var guard = { alpha: 0.5, brightest: null, ratio: null, raised: false };   // dark strip, last measured
  var guardLight = { alpha: LIGHT_WASH_DIM, raised: false, source: 'own', reason: null, ratio: null };   // light wash
  var glassKey = null;           // the glass last announced in a backdropchange
  var deskReady = false;         // LookSync.ready() settled (or timed out)
  var deskWait = false;
  var booted = false;            // the first publish went out (glass events may follow)

  /* --- reading the setting ---------------------------------------- */

  function settings() { return window.Settings || null; }

  function config() {
    var s = settings();
    if (s && typeof s.backgroundConfig === 'function') {
      try { return s.backgroundConfig(); } catch (err) { /* fall through */ }
    }
    return { kind: 'desktop', dim: 0.25 };
  }

  /** The kinds this layer draws. The old 'wallpaper' (and anything this
      build does not know) is 'desktop', the default; settings.js
      normalizes the stored value too. */
  var OWN_KINDS = { builtin: 1, image: 1, video: 1, none: 1 };
  function normKind(kind) {
    return kind && OWN_KINDS[kind] === 1 ? kind : 'desktop';
  }

  function themeNow() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function numIn(v, lo, hi, dflt) {
    if (typeof v !== 'number' && typeof v !== 'string') return dflt;
    var n = Number(v);
    if (v === '' || !isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  /** { blurPx, dim, panel } in range (Settings' ranges), seeds for gaps. */
  function normGlass(g, theme) {
    var seed = SEED_GLASS[theme === 'light' ? 'light' : 'dark'];
    g = g && typeof g === 'object' ? g : {};
    return {
      blurPx: Math.round(numIn(g.blurPx, 0, 64, seed.blurPx)),
      dim: Math.round(numIn(g.dim, 0.2, 0.9, seed.dim) * 100) / 100,
      panel: Math.round(numIn(g.panel, -0.3, 0.15, seed.panel) * 100) / 100
    };
  }

  /** The glass in effect for theme: LookSync's (a live preview included);
      without LookSync, Settings' stored glass; else the seed. */
  function glassFor(theme) {
    var t = theme === 'light' ? 'light' : 'dark';
    var g = null;
    var ls = window.LookSync;
    if (ls && typeof ls.glassFor === 'function') {
      try { g = ls.glassFor(t); } catch (err) { g = null; }
    }
    if (!g || typeof g !== 'object') {
      var s = settings();
      try {
        var all = s && typeof s.get === 'function' ? s.get('glass') : null;
        g = all && typeof all === 'object' ? all[t] : null;
      } catch (err) { g = null; }
    }
    return normGlass(g, t);
  }

  /* --- LookSync: the desktop record and this window's place ------------ */

  var NO_LINK_REASON = "Following Windows' wallpaper: this window has no Look Sync link (restart the browser)";

  /**
   * What 'desktop' should draw: { state: 'ok', stillUrl, title, rev } or
   * { state: 'fallback', reason } (Windows' wallpaper, said) or
   * { state: 'loading' } until LookSync.ready() settles. Never throws: a
   * missing or broken LookSync is a fallback with the reason in words.
   */
  function deskInfo() {
    var ls = window.LookSync;
    if (!ls || typeof ls.desktop !== 'function') return { state: 'fallback', reason: NO_LINK_REASON, stillUrl: null };
    var d;
    try { d = ls.desktop(); } catch (err) {
      return { state: 'fallback', stillUrl: null,
               reason: "Following Windows' wallpaper: Look Sync could not be asked (" + reasonOf(err) + ')' };
    }
    if (!d || typeof d !== 'object') {
      return { state: 'fallback', stillUrl: null, reason: "Following Windows' wallpaper: Look Sync gave no answer" };
    }
    if (d.state === 'ok') {
      if (typeof d.stillUrl === 'string' && d.stillUrl) {
        // guard / guardReason: Mantle's shared top-band value as main
        // validated it (looksync-main.js guardOf); refreshGuard() checks it
        // is fresh against the glass in effect.
        return { state: 'ok', stillUrl: d.stillUrl, title: d.title || null, rev: d.rev == null ? null : d.rev, reason: null,
                 guard: d.guard && typeof d.guard === 'object' ? d.guard : null,
                 guardReason: typeof d.guardReason === 'string' && d.guardReason ? d.guardReason : null,
                 // The light entry (desktop.guard.light), checked the same way.
                 guardLight: d.guardLight && typeof d.guardLight === 'object' ? d.guardLight : null,
                 guardLightReason: typeof d.guardLightReason === 'string' && d.guardLightReason ? d.guardLightReason
                   : (d.guardLight ? null : 'light top band not published by Mantle yet') };
      }
      return { state: 'fallback', stillUrl: null,
               reason: "Following Windows' wallpaper: Mantle's record names no picture" };
    }
    if (d.state === 'loading') {
      if (!deskReady) return { state: 'loading', stillUrl: null, reason: null };
      return { state: 'fallback', stillUrl: null,
               reason: d.reason || "Following Windows' wallpaper: Mantle's wallpaper has not arrived yet" };
    }
    return { state: 'fallback', stillUrl: null,
             reason: d.reason || "Following Windows' wallpaper: Mantle hasn't shared one" };
  }

  /** Wait (once) for LookSync.ready(), capped, then render what it says. */
  function waitForDesktop() {
    if (deskWait || deskReady) return;
    deskWait = true;
    var ls = window.LookSync;
    var ready = Promise.resolve().then(function () {
      return ls && typeof ls.ready === 'function' ? ls.ready() : null;
    }).catch(function () { /* the status line says why */ });
    var cap = new Promise(function (resolve) { window.setTimeout(resolve, DESK_WAIT_MS); });
    Promise.race([ready, cap]).then(function () {
      deskWait = false;
      deskReady = true;
      render(false);
    });
  }

  function readPlace() {
    var ls = window.LookSync;
    if (!ls || typeof ls.place !== 'function') return null;
    try { return ls.place(); } catch (err) { return null; }
  }

  function finiteAll(o, keys) {
    for (var i = 0; i < keys.length; i++) if (typeof o[keys[i]] !== 'number' || !isFinite(o[keys[i]])) return false;
    return true;
  }

  /** A place with numbers where they belong and a monitor of some size. */
  function validPlace(pl) {
    if (!pl || typeof pl !== 'object' || !pl.content || !pl.display) return null;
    var k = ['x', 'y', 'width', 'height'];
    if (!finiteAll(pl.content, k) || !finiteAll(pl.display, k)) return null;
    if (pl.display.width <= 0 || pl.display.height <= 0 || pl.content.width <= 0 || pl.content.height <= 0) return null;
    return pl;
  }

  function currentPlace() {
    if (!placeNow) placeNow = validPlace(readPlace());
    return placeNow;
  }

  function bgApi() {
    var api = window.api;
    return api && api.background ? api.background : null;
  }

  function assets() {
    var s = settings();
    return s && s.assets && typeof s.assets.get === 'function' ? s.assets : null;
  }

  /** The cache key for a clip's still: changes exactly when the clip does. */
  function stillKey(cfg) {
    return [cfg.fileUrl || '', cfg.fileName || '', cfg.clipRev || 0].join('|');
  }

  /** Everything that decides the picture, and nothing that does not. */
  function signature(cfg) {
    if (cfg.kind === 'video') return 'video|' + stillKey(cfg);
    if (cfg.kind === 'image') return 'image|' + (cfg.imageRev || 0);
    if (cfg.kind === 'builtin') return 'builtin|' + (cfg.id || '');
    return String(cfg.kind);
  }

  /* --- state -------------------------------------------------------- */

  function snapshot() {
    return {
      kind: current.kind,
      state: current.state,
      reason: current.reason,
      source: current.source ? JSON.parse(JSON.stringify(current.source)) : null,
      glass: glassSnapshot(),
      home: homeSnapshot()
    };
  }

  /** The glass in effect, for Settings' guard note and the tests. alpha is
      the window's wash (--chrome-glass-a, >= floor): in dark the guard's
      answer, in light Mantle's guard.light or the dim. offset = the
      monitor's top-left relative to this window's content area (lined up only). */
  function glassSnapshot() {
    var theme = themeNow();
    var g = glassFor(theme);
    var lined = !!(shown && shown.lined && placeNow);
    var off = lined ? monitorOffset(placeNow) : { x: 0, y: 0 };
    var dark = theme === 'dark';
    var gd = dark ? guard : guardLight;
    return {
      theme: theme,
      floor: g.dim,
      alpha: gd.alpha,
      raised: !!gd.raised,
      // Where alpha came from. 'shared' = Mantle's desktop.guard.<theme>;
      // 'own' = Quartz's own value (dark: its guard over its own strip;
      // light: the dim unraised), with sourceReason saying why the shared
      // value is not in use. ownAlpha = Quartz's own answer (dark only).
      source: gd.source || 'own',
      sourceReason: gd.reason || null,
      ownAlpha: dark && typeof guard.own === 'number' ? guard.own : null,
      saturate: dark ? 100 : LIGHT_SATURATE,
      blurPx: g.blurPx,
      panel: g.panel,
      lined: lined,
      offset: { x: off.x, y: off.y }
    };
  }

  function glassKeyOf(g) {
    return [g.theme, g.floor, g.alpha, g.raised, g.source, g.sourceReason, g.blurPx, g.panel, g.lined].join('|');
  }

  function dispatchChange() {
    var detail = snapshot();
    glassKey = glassKeyOf(detail.glass);
    try {
      document.dispatchEvent(new CustomEvent('backdropchange', { detail: detail }));
    } catch (err) { /* a listener's problem, not the layer's */ }
  }

  function publish(next) {
    current = next;
    var body = document.body;
    if (body) {
      body.setAttribute('data-bg-kind', next.kind);
      body.setAttribute('data-bg-state', next.state);
    }
    // The kind decides whether Mantle's shared value can apply (and whether
    // the unblurred picture can show), so both are re-read before anyone hears.
    if (booted) { refreshGuard(true); syncHome(); }
    dispatchChange();
  }

  /** A backdropchange when the glass the state reports moved (the guard
      raised or lowered the wash, the theme or a glass value changed);
      never for the offset alone, which changes every frame of a drag. */
  function announceGlass() {
    if (glassKeyOf(glassSnapshot()) !== glassKey) dispatchChange();
  }

  /** An Error carrying the plain-words reason the state line shows. */
  function fail(reason, source) {
    var err = new Error(reason);
    err.reason = reason;
    if (source) err.source = source;
    return err;
  }

  function reasonOf(err) {
    if (err && err.reason) return err.reason;
    return (err && err.message) || 'it could not be read';
  }

  /* --- the photo layer ---------------------------------------------- */

  function revokeLater(url) {
    if (!url) return;
    // After the next paint has swapped the layer over; revoking the URL the
    // layer is still painting from would blank it for a frame.
    window.setTimeout(function () {
      try { URL.revokeObjectURL(url); } catch (err) { /* already gone */ }
    }, 1000);
  }

  /** Take the picture down (Plain, or a source that failed). */
  function clearPhoto() {
    var old = shown;
    shown = null;
    if (old && cache.indexOf(old) < 0) revokeEntry(old);
    if (photoEl) {
      photoEl.removeAttribute('data-ready');
      photoEl.style.backgroundImage = '';
      applyGeometry(null);
    }
    syncHome();
    refreshGuard();              // no picture: the wash at its floor (today's CSS .5)
  }

  /* The cache: CACHE_MAX blurred results, each an object URL plus the
     pixels the guard reads, keyed by everything that shaped the bitmap
     (source, blurPx, monitor size or 'window'). An entry leaves the cache
     oldest first, never while it is on the layer; its URL is revoked once
     it is neither cached nor shown. */
  function cacheGet(key) {
    for (var i = 0; i < cache.length; i++) if (cache[i].key === key) return cache[i];
    return null;
  }

  function dropEntry(e) {
    if (!e || e === shown) return;
    revokeEntry(e);
    e.pixels = null;
  }

  /** An entry's object URLs: the blur, and its own unblurred copy if any. */
  function revokeEntry(e) {
    if (!e) return;
    revokeLater(e.url);
    if (e.clearOwned) revokeLater(e.clearUrl);
  }

  function cachePut(entry) {
    for (var i = cache.length - 1; i >= 0; i--) {
      if (cache[i].key === entry.key) dropEntry(cache.splice(i, 1)[0]);
    }
    cache.push(entry);
    while (cache.length > CACHE_MAX) {
      var j = 0;
      while (j < cache.length - 1 && cache[j] === shown) j++;
      if (j >= cache.length - 1) break;          // only the new one and the shown one left
      dropEntry(cache.splice(j, 1)[0]);
    }
  }

  /** Put a blurred entry on the layer once it has decoded (no half frame).
      Its geometry (lined up or cover on the window) lands in the same frame. */
  function showEntry(entry, mySeq) {
    var img = new Image();
    img.src = entry.url;
    var decoded = typeof img.decode === 'function' ? img.decode() : Promise.resolve();
    return decoded.catch(function () { /* paint it anyway */ }).then(function () {
      if (mySeq !== seq || !photoEl) return false;
      var old = shown;
      shown = entry;
      applyGeometry(entry);
      photoEl.style.backgroundImage = 'url("' + entry.url + '")';
      photoEl.setAttribute('data-ready', '');
      if (old && old !== entry && cache.indexOf(old) < 0) revokeEntry(old);
      lastRender = JSON.parse(JSON.stringify(entry.info));
      lastRender.key = entry.key;
      lastRender.cached = !!entry.pub;           // shown again from the cache, not re-blurred
      refreshGuard();
      syncHome();
      return true;
    });
  }

  /* --- lined up: the layer's geometry -------------------------------- */

  var lastPos = null;            // { x, y, moving }: the translate on the layer now

  function round2(v) { return Math.round(v * 100) / 100; }

  /** Lined: the layer is the monitor (+ overscan) in CSS px, moved by a
      transform. Not lined: chrome.css's inset 0 and backdrop.css's cover. */
  function applyGeometry(entry) {
    if (!photoEl) return;
    var st = photoEl.style;
    lastPos = null;
    if (entry && entry.lined) {
      photoEl.setAttribute('data-lined', '');
      st.width = round2(entry.layout.cssW) + 'px';
      st.height = round2(entry.layout.cssH) + 'px';
      positionLayer(entry, false);
    } else {
      photoEl.removeAttribute('data-lined');
      photoEl.removeAttribute('data-moving');
      st.width = '';
      st.height = '';
      st.transform = '';
    }
  }

  /**
   * Move the lined layer to the window's place. While the window moves the
   * layer carries data-moving (backdrop.css: will-change: transform), so
   * each frame is a compositor-only translate3d, no repaint; at rest it
   * drops the hint and sits on a plain 2D translate, painted into the root
   * layer, so the window does not keep an extra full-size layer (and the
   * chrome above it is not forced into overlap layers: chrome.css .backdrop).
   */
  function positionLayer(entry, moving) {
    if (!photoEl || !entry || !entry.lined || !placeNow) return;
    var t = layerTranslate(placeNow, entry.layout);
    var same = lastPos && lastPos.x === t.x && lastPos.y === t.y;
    if (same && (moving || !lastPos.moving)) return;   // nothing moved (a resize from the right edge)
    if (!lastPos) moving = false;                      // first placement: no hint needed
    if (moving) photoEl.setAttribute('data-moving', '');
    else photoEl.removeAttribute('data-moving');
    photoEl.style.transform = moving
      ? 'translate3d(' + t.x + 'px, ' + t.y + 'px, 0)'
      : 'translate(' + t.x + 'px, ' + t.y + 'px)';
    lastPos = { x: t.x, y: t.y, moving: moving };
    if (home.on) placeClear(moving);
  }

  /* --- Helm's Home: the picture unblurred ------------------------------ */

  /*
   * Helm's Home look (helm ui/shell/home.css, chrome.js Background): an
   * UNBLURRED copy of the picture (.bg-clear) over the blurred layer, which
   * is hidden once it is covered; a 96px scrim (rgb(9 10 11 / .5) -> 0)
   * under the tab bar, and the ONE wash still over the whole window.
   *
   * Quartz shows it WHENEVER the window has a still picture, whatever tab
   * is in front: a new tab, a web page, Lumen, a Claude tab, History,
   * Files, a split. The top band (strip + toolbar) used to switch to the
   * blurred layer when a web page came to the front; the user wants it to
   * look the same the whole time (2026-11-11), so nothing here follows the
   * front tab any more and a tab switch does no backdrop work at all. The
   * new tab guest is see-through over it (app.js .own-layer, newtab.css
   * data-bg-layer), so strip, toolbar and new tab are one picture; a web
   * page paints its own opaque ground below the toolbar. The side panes
   * sit over the same picture they always had with a new tab in front
   * (wash + their own --surface-*, ~.83 net in dark, ~.87 in light).
   * Lined up, the copy is the MONITOR, cover-fitted the way the desktop
   * draws it and moved like the blurred layer.
   *
   * Both themes. A clip ('video') has no sharp copy: the chrome keeps the
   * clip's blurred still (with any tab in front) and the clip plays on the
   * new tab itself. While the sharp copy is being prepared, or when it
   * cannot be decoded, the blurred layer stays up and home.reason says why.
   * Only opacity / transform animate, once when the picture first lands or
   * goes; nothing runs at rest.
   */
  var clearEl = layer ? layer.querySelector('.bg-clear') : null;
  var clearImgEl = clearEl ? clearEl.querySelector('.bg-clear-img') : null;
  var HOME_OUT_MS = 320;         // Helm: home-bg-out 300ms, then the layer goes
  var home = { on: false, url: null, reason: 'the picture is still being prepared' };
  var homeSeq = 0;
  var homeOutTimer = 0;

  /**
   * Pure: why the unblurred picture cannot show, or null when it should.
   * kind/state/reason = the published state; hasShown = a blurred picture
   * is on the layer; hasClear = that picture has an unblurred copy. Which
   * tab is in front is deliberately NOT an input.
   */
  function homeReason(kind, state, reason, hasShown, hasClear) {
    if (kind === 'video') return 'a clip: the chrome keeps its blurred still and the clip plays on the new tab itself';
    if (kind !== 'desktop' && kind !== 'builtin' && kind !== 'image') return 'no picture is chosen';
    if (!hasShown && state === 'fallback') {
      return 'no picture could be shown' + (reason ? ' (' + reason + ')' : '');
    }
    if (!hasShown || !hasClear) return 'the picture is still being prepared';
    return null;
  }

  function homeWhyNot() {
    return homeReason(current.kind, current.state, current.reason, !!shown, !!(shown && shown.clearUrl));
  }

  /** The unblurred copy's box: the monitor at its offset, or the window. */
  function placeClear(moving) {
    if (!clearImgEl) return;
    var st = clearImgEl.style;
    if (shown && shown.lined && placeNow) {
      var o = monitorOffset(placeNow);
      clearImgEl.setAttribute('data-lined', '');
      if (moving) clearImgEl.setAttribute('data-moving', '');
      else clearImgEl.removeAttribute('data-moving');
      st.width = shown.layout.monW + 'px';
      st.height = shown.layout.monH + 'px';
      st.transform = moving
        ? 'translate3d(' + round2(o.x) + 'px, ' + round2(o.y) + 'px, 0)'
        : 'translate(' + round2(o.x) + 'px, ' + round2(o.y) + 'px)';
    } else {
      clearImgEl.removeAttribute('data-lined');
      clearImgEl.removeAttribute('data-moving');
      st.width = '';
      st.height = '';
      st.transform = '';
    }
  }

  function homeIn() {
    window.clearTimeout(homeOutTimer);
    homeOutTimer = 0;
    placeClear(false);
    if (home.on) return;
    home.on = true;
    clearEl.setAttribute('data-on', 'in');
    if (document.body) document.body.setAttribute('data-bg-home', '');
  }

  function homeOut() {
    if (!home.on) return;
    home.on = false;
    if (document.body) document.body.removeAttribute('data-bg-home');
    clearEl.setAttribute('data-on', 'out');
    window.clearTimeout(homeOutTimer);
    homeOutTimer = window.setTimeout(function () {
      homeOutTimer = 0;
      if (!home.on) clearEl.removeAttribute('data-on');
    }, HOME_OUT_MS);
  }

  /**
   * Show or hide the unblurred picture to match the kind and the picture
   * on the layer (never the front tab). A new picture is decoded off screen
   * first, so it never paints half-drawn; the blurred layer stays up
   * meanwhile. Called when the picture, the state or the look changes.
   */
  function syncHome() {
    var why = homeWhyNot();
    home.reason = why;
    if (!clearEl || !clearImgEl) { home.on = !why; return; }
    if (why) { homeSeq++; homeOut(); return; }
    var url = shown.clearUrl;
    if (home.url === url) { homeIn(); return; }
    var my = ++homeSeq;
    var img = new Image();
    img.src = url;
    var decoded = typeof img.decode === 'function' ? img.decode() : Promise.resolve();
    decoded.then(function () {
      if (my !== homeSeq) return;
      clearImgEl.style.backgroundImage = 'url("' + String(url).replace(/["\\\n\r]/g, encodeURIComponent) + '")';
      home.url = url;
      homeIn();
    }, function (err) {
      if (my !== homeSeq) return;
      // The blurred layer stays; say why the sharp one is missing.
      home.reason = 'the picture could not be decoded unblurred, so the chrome shows it blurred (' + reasonOf(err) + ')';
      homeOut();
    });
  }

  function homeSnapshot() {
    return { on: home.on, reason: home.on ? null : home.reason };
  }

  /* --- decoding --------------------------------------------------- */

  function canvasOf(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function toBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      try {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(fail('the picture could not be encoded'));
        }, type, quality);
      } catch (err) {
        // SecurityError: a tainted canvas. Say what that means here.
        reject(fail(err && err.name === 'SecurityError'
          ? 'the browser would not let the window read the file’s pixels'
          : reasonOf(err)));
      }
    });
  }

  /**
   * A file:// URL to an ImageBitmap, through a blob so nothing is tainted.
   * Electron lets a file:// page fetch() file:// URLs (its default
   * grantFileProtocolExtraPrivileges fuse). If a build ever turns that off,
   * fetch rejects outright, and the picture is loaded through an <img>
   * instead, which a file:// page may always do; only then could the canvas
   * end up tainted, and toBlob() says so in words.
   */
  function decodeUrl(url) {
    return fetch(url).then(function (res) {
      if (!res.ok && res.status !== 0) throw fail('the file could not be read (status ' + res.status + ')');
      return res.blob().then(function (blob) {
        if (!blob || !blob.size) throw fail('the file is empty');
        return decodeBlob(blob);
      });
    }, function () {
      return decodeViaImg(url);
    });
  }

  /** The <img> route for decodeUrl (fetch refused file://). */
  function decodeViaImg(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.decoding = 'async';
      img.onload = function () {
        img.onload = img.onerror = null;
        if (typeof window.createImageBitmap !== 'function') { resolve(img); return; }
        window.createImageBitmap(img).then(resolve, function () {
          reject(fail('the file is not a picture the browser can decode'));
        });
      };
      img.onerror = function () {
        img.onload = img.onerror = null;
        reject(fail('the file is missing or cannot be read'));
      };
      img.src = url;
    });
  }

  function decodeBlob(blob) {
    if (typeof window.createImageBitmap !== 'function') {
      return Promise.reject(fail('this window cannot decode pictures'));
    }
    return window.createImageBitmap(blob).catch(function () {
      throw fail('the file is not a picture the browser can decode');
    });
  }

  function closeBitmap(bm) {
    if (bm && typeof bm.close === 'function') { try { bm.close(); } catch (err) { /* fine */ } }
  }

  /* --- how see-through the dark glass can be ------------------------ */

  /*
   * In dark the strip and toolbar read the wash alone, rgb(9 10 11) at
   * Helm's 50% (backdrop.css); side panes add --surface-1 on top (~83% net,
   * like a Helm panel). Over most pictures that is it. Over a bright one
   * (misty-woods, foggy-cliffs, stone, cloud-peaks: a pale sky right where
   * the tab strip sits) 50% of a dark grey leaves the strip mid-grey, so the
   * wash (--chrome-glass-a) darkens JUST enough, by Mantle's bar rule
   * (mantle ui/shared/glass-adapt.js guardTokens + glassTint, dark
   * --lg-guard-bar 4.2): Helm's secondary ink (#a9aaa7) must keep 4.2:1 over
   * the 48 brightest pixels of the blurred band under the strip and toolbar,
   * stepping .02 up from .50. Helm's own strip gives that ink 4.3:1 over
   * snow-peak, so Helm's .50 holds there, as in Mantle's top bar; on
   * 2026-10-10: the old rule (a luminance cap that also read the side-pane
   * column) set .52 on snow-peak, a visible step under Mantle's bar. The
   * side pane no longer decides: it sits at ~83% net anyway. Never below
   * 50%, never above Mantle's guard ceiling .88 (the alpha of dark
   * --lg-fill-pop, rgba(19,20,21,.88), mantle ui/shared/glass-light.css;
   * guardTokens uses it for bars and windows alike). Since 2026-10-10, over
   * very bright photos the strip darkens as far as Mantle's bars do (the old
   * .66 cap left cloud-peaks / sand-ripples at ~3:1 where Mantle hit .76).
   * Light does not read the variable.
   */
  var GLASS_FLOOR = 0.5;
  var GLASS_CEIL = 0.88;         // Mantle's dark --lg-fill-pop alpha (guard ceiling)
  var GLASS_STEP = 0.02;         // Mantle's GUARD.step
  var GLASS_NEED = 4.2;          // Mantle's dark --lg-guard-bar
  var GLASS_INK = [169, 170, 167]; // Helm --text-2 #a9aaa7 = Mantle's dark --lg-ink-2
  var GLASS_CAND = 48;           // Mantle's glassTint: only the brightest few pixels can be the worst
  var GLASS_FILL = 9;            // the wash (--wash-rgb 9 10 11): the strip's only layer

  function linear(v) {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function lumOver(rgb, a) {
    var c = rgb.map(function (p) { return linear(p * (1 - a) + GLASS_FILL * a); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function contrastOf(l1, l2) {
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  /* The band the guard reads: the strip + toolbar, ~84 of 836 px, i.e. 11%
     of the frame's height (Look Sync keeps that height in window px). */
  var BAND_FRAC = 0.11;

  /** The GLASS_CAND brightest pixels of rect (x0,y0 inclusive, x1,y1
      exclusive) in an RGBA buffer w px wide, as [luminance, rgb], brightest
      first. Row-major and a stable sort: the same order as before. */
  function bandCandidates(data, w, rect) {
    var cand = [];
    if (!data || !rect) return cand;
    for (var y = rect.y0; y < rect.y1; y++) {
      for (var x = rect.x0; x < rect.x1; x++) {
        var k = (y * w + x) * 4;
        var px = [data[k], data[k + 1], data[k + 2]];
        cand.push([lumOver(px, 0), px]);
      }
    }
    cand.sort(function (p, q) { return q[0] - p[0]; });
    return cand.slice(0, GLASS_CAND);
  }

  /**
   * Mantle's bar rule from floor (the shared dark dim, Helm's .50 by
   * default): step .02 up until the ink keeps GLASS_NEED over every
   * candidate, never past GLASS_CEIL. A floor above the ceiling wins as is
   * (that much dim was requested). No pixels: the floor.
   */
  function guardAlpha(cand, floor) {
    if (typeof floor !== 'number' || !isFinite(floor)) floor = GLASS_FLOOR;
    var inkL = lumOver(GLASS_INK, 0);
    function worstRatio(a) {
      var w = Infinity;
      for (var j = 0; j < cand.length; j++) w = Math.min(w, contrastOf(inkL, lumOver(cand[j][1], a)));
      return w;
    }
    if (!cand || !cand.length) return { alpha: floor, brightest: null, ratio: null, raised: false };
    var a = floor;
    if (floor <= GLASS_CEIL) {
      while (a < GLASS_CEIL && worstRatio(a) < GLASS_NEED) a = Math.round((a + GLASS_STEP) * 100) / 100;
      if (a > GLASS_CEIL) a = GLASS_CEIL;
    }
    return {
      alpha: a,
      brightest: Math.round(cand[0][0] * 1000) / 1000,
      ratio: Math.round(worstRatio(a) * 100) / 100,
      raised: a > floor + 1e-9
    };
  }

  function applyGlass(alpha) {
    var root = document.documentElement;
    if (alpha == null) root.style.removeProperty('--chrome-glass-a');
    else root.style.setProperty('--chrome-glass-a', String(alpha));
  }

  /**
   * Re-read the dark strip's wash from the CACHED pixels of what is shown
   * (never a canvas read): on show, when a move ends, when the floor moves.
   * Lined up, the band is the monitor rows behind the window's top strip;
   * otherwise the frame's top band, as always. --chrome-glass-a is the wash
   * of the theme in effect: dark's guard in dark, light's in light (a theme
   * flip re-runs this, onLook).
   */
  function refreshGuard(quiet) {
    refreshLightGuard();
    if (themeNow() === 'light') {
      applyGlass(guardLight.alpha);
      if (booted && !quiet) announceGlass();
      return;
    }
    refreshDarkGuard();
    if (booted && !quiet) announceGlass();
  }

  /**
   * CONTRACT "Light look": the light wash is white at glass.light.dim, raised
   * to Mantle's desktop.guard.light while following the desktop and that
   * value is fresh (worked out for this light dim and blur). Quartz has no
   * light guard of its own: anything else is the dim unraised, with the
   * reason (Settings shows it).
   */
  function refreshLightGuard() {
    var g = glassFor('light');
    var shared = sharedGuard(g, 'light');
    if (shared.alpha !== null) {
      guardLight = { alpha: shared.alpha, raised: shared.alpha > g.dim + 1e-9, source: 'shared', reason: null, ratio: shared.contrast };
    } else {
      guardLight = { alpha: g.dim, raised: false, source: 'own', reason: shared.reason, ratio: null };
    }
  }

  function refreshDarkGuard() {
    var g = glassFor('dark');
    var floor = g.dim;
    var own;
    if (!shown) {
      own = { alpha: floor, brightest: null, ratio: null, raised: false };
    } else {
      var px = shown.pixels;
      var rect = shown.lined && placeNow ? guardBand(placeNow, shown.layout) : shown.band;
      own = guardAlpha(px ? bandCandidates(px.data, px.w, rect) : [], floor);
    }
    var shared = sharedGuard(g, 'dark');
    if (shared.alpha !== null) {
      guard = { alpha: shared.alpha, brightest: own.brightest, ratio: shared.contrast, raised: shared.alpha > floor + 1e-9,
                source: 'shared', reason: null, own: own.alpha };
    } else {
      guard = { alpha: own.alpha, brightest: own.brightest, ratio: own.ratio, raised: own.raised,
                source: 'own', reason: shared.reason, own: own.alpha };
    }
    // No picture and nothing shared: today's CSS fallback (.5) unless the floor moved.
    if (!shown && guard.source === 'own') applyGlass(Math.abs(floor - GLASS_FLOOR) < 0.001 ? null : floor);
    else applyGlass(guard.alpha);
  }

  /**
   * CONTRACT "Shared top-band darkening": Mantle works out ONE dark alpha
   * over the top 144 DIP of the monitor (Mantle's top bar, every app's strip,
   * this toolbar) and publishes it as desktop.guard. While Quartz follows
   * the desktop (Mantle's still on screen, sync on) and the value is fresh
   * (worked out for the dark glass in effect: same dim, same blur), it IS
   * the wash, over the whole window, as in Helm. Anything else keeps
   * Quartz's own value (guardAlpha over its own strip) and says why, in
   * words, for Settings: { alpha, contrast, reason }.
   */
  function sharedGuard(g, theme) {
    var light = theme === 'light';
    function no(why) { return { alpha: null, contrast: null, reason: why }; }
    var kind = current.kind;
    if (kind !== 'desktop') {
      return no(kind === 'none' ? 'no picture is shown'
        : "the background is Quartz's own picture, not the desktop");
    }
    var ls = window.LookSync;
    if (ls && typeof ls.enabled === 'function') {
      var on = true;
      try { on = ls.enabled() !== false; } catch (err) { on = true; }
      if (!on) return no('Look Sync is off');
    }
    var d = deskInfo();
    if (d.state !== 'ok') return no("Quartz is showing Windows' wallpaper, not Mantle's");
    if (!shown || shown.srcKey !== 'desktop|' + d.stillUrl) return no("Mantle's wallpaper is still being prepared");
    var sg = light ? d.guardLight : d.guard;
    if (!sg) {
      return no(light ? (d.guardLightReason || 'light top band not published by Mantle yet')
        : (d.guardReason || "Mantle's record has no shared value"));
    }
    var dim = Number(sg.dim);
    var blur = Number(sg.blurPx);
    if (!isFinite(dim) || Math.abs(dim - g.dim) > 0.001 || !isFinite(blur) || Math.round(blur) !== g.blurPx) {
      if (light) {
        return no('light top band is stale: Mantle worked it out for Dim ' + alphaWords(dim) + ' and blur ' +
          (isFinite(blur) ? blur : '?') + ' px, not this Dim ' + alphaWords(g.dim) + ' and blur ' + g.blurPx +
          ' px (waiting for Mantle to work it out again)');
      }
      return no("Mantle's shared value was worked out for Dim " + alphaWords(dim) + ' and blur ' +
        (isFinite(blur) ? blur : '?') + ' px, not this Dim ' + alphaWords(g.dim) + ' and blur ' + g.blurPx +
        ' px (waiting for Mantle to work it out again)');
    }
    var a = Number(sg.alpha);
    var ceil = Math.max(GLASS_CEIL, g.dim);
    if (!isFinite(a) || a < g.dim - 1e-9 || a > ceil + 1e-9) {
      return no((light ? "Mantle's light top band " : "Mantle's shared value ") + alphaWords(a) + ' is outside ' + alphaWords(g.dim) + '-' + alphaWords(ceil));
    }
    return { alpha: Math.round(a * 100) / 100, contrast: typeof sg.contrast === 'number' && isFinite(sg.contrast) ? sg.contrast : null, reason: null };
  }

  /** .5 -> ".50", the way the guard writes an alpha. */
  function alphaWords(a) {
    var n = Math.round(Number(a) * 100) / 100;
    return isFinite(n) ? n.toFixed(2).replace(/^0(?=\.)/, '') : '?';
  }

  /* --- panel and light dim ------------------------------------------ */

  /* tokens.css's glass surfaces (dark :51-56, light :126-131) as
     [r, g, b, alpha]. A panel value shifts every alpha by the same amount,
     clamped .05..99, inline on :root for the current theme; panel 0 removes
     the inline values so tokens.css stands untouched. */
  var PANEL_PROPS = ['--surface-0', '--surface-1', '--surface-2', '--surface-3', '--overlay'];
  var PANEL_BASE = {
    dark: {
      '--surface-0': [14, 15, 16, 0.50],
      '--surface-1': [22, 23, 24, 0.66],
      '--surface-2': [40, 41, 43, 0.62],
      '--surface-3': [62, 63, 66, 0.62],
      '--overlay': [29, 30, 31, 0.93]
    },
    // CONTRACT "Light look": Helm's light alphas re-tinted pure white
    // (panels .76, cards .70, overlays .95); --surface-3 is the pressed
    // state on a white card, so it stays a cool grey from the ink's family.
    light: {
      '--surface-0': [255, 255, 255, 0.56],
      '--surface-1': [255, 255, 255, 0.76],
      '--surface-2': [255, 255, 255, 0.70],
      '--surface-3': [233, 235, 240, 0.86],
      '--overlay': [255, 255, 255, 0.95]
    }
  };

  /** { prop: 'rgba(...)' } for theme shifted by panel, or null for panel 0. */
  function panelValues(theme, panel) {
    if (typeof panel !== 'number' || !isFinite(panel) || Math.abs(panel) < 0.005) return null;
    var base = PANEL_BASE[theme === 'light' ? 'light' : 'dark'];
    var out = {};
    for (var i = 0; i < PANEL_PROPS.length; i++) {
      var b = base[PANEL_PROPS[i]];
      // Dark as it always was (.05..99); light per the contract (.30..97).
      var a = theme === 'light'
        ? Math.min(0.97, Math.max(0.30, Math.round((b[3] + panel) * 100) / 100))
        : Math.min(0.99, Math.max(0.05, Math.round((b[3] + panel) * 100) / 100));
      out[PANEL_PROPS[i]] = 'rgba(' + b[0] + ', ' + b[1] + ', ' + b[2] + ', ' + a + ')';
    }
    return out;
  }

  /** The panel shift for the resolved theme, inline on :root. */
  function applyLookVars() {
    var theme = themeNow();
    var g = glassFor(theme);
    var st = document.documentElement.style;
    var v = panelValues(theme, g.panel);
    for (var i = 0; i < PANEL_PROPS.length; i++) {
      if (v) st.setProperty(PANEL_PROPS[i], v[PANEL_PROPS[i]]);
      else st.removeProperty(PANEL_PROPS[i]);
    }
    // Both themes' wash is --chrome-glass-a now (refreshGuard); the old
    // light --bg-dim override is cleared in case an older build left it.
    st.removeProperty('--bg-dim');
  }

  /* --- the pure geometry (Backdrop._math) ---------------------------- */

  /** The bitmap blur for a full-size blur of blurPx: 5 -> 1.5, as always. */
  function blurBitmapPx(blurPx) {
    return Math.round(blurPx * SCALE * 10) / 10;
  }

  /** CSS cover: sw x sh into w x h, centred, the long side cropped. */
  function coverRect(sw, sh, w, h) {
    var scale = Math.max(w / sw, h / sh);
    var dw = sw * scale;
    var dh = sh * scale;
    return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
  }

  /**
   * The lined layer for a monW x monH monitor (CSS px) at blurPx: the
   * monitor is W x H bitmap px; the bitmap carries m px of overscan on
   * every side (outW x outH), which is marginX/marginY in CSS px; the layer
   * element is cssW x cssH.
   */
  function linedLayout(monW, monH, blurPx) {
    var W = Math.max(64, Math.round(monW * SCALE));
    var H = Math.max(36, Math.round(monH * SCALE));
    var b = blurBitmapPx(blurPx);
    var m = Math.ceil(b * OVERSCAN_SIGMAS);
    var sx = W / monW;
    var sy = H / monH;
    return {
      monW: monW, monH: monH, W: W, H: H, b: b, m: m,
      outW: W + 2 * m, outH: H + 2 * m, sx: sx, sy: sy,
      marginX: m / sx, marginY: m / sy,
      cssW: monW + 2 * m / sx, cssH: monH + 2 * m / sy
    };
  }

  /** The monitor's top-left relative to this window's content area. */
  function monitorOffset(place) {
    return { x: place.display.x - place.content.x, y: place.display.y - place.content.y };
  }

  /** The layer's translate: the monitor offset, less the overscan margin. */
  function layerTranslate(place, layout) {
    var o = monitorOffset(place);
    return { x: round2(o.x - layout.marginX), y: round2(o.y - layout.marginY) };
  }

  /** Not lined: the frame's top band, full width (as before Look Sync). */
  function topBand(W, H) {
    return { x0: 0, y0: 0, x1: W, y1: Math.max(2, Math.round(H * BAND_FRAC)) };
  }

  /**
   * Lined: the rows of the bitmap behind the window's strip + toolbar, i.e.
   * the window's columns, from its top, BAND_FRAC of the taller of window
   * and monitor (= the old band's height in window px), clamped to the
   * bitmap. A window entirely off its monitor reads the monitor's top band.
   */
  function guardBand(place, layout) {
    var c = place.content;
    var d = place.display;
    var rows = Math.max(2, Math.round(BAND_FRAC * Math.max(c.height, d.height) * layout.sy));
    var x0 = Math.round((c.x - d.x) * layout.sx) + layout.m;
    var y0 = Math.round((c.y - d.y) * layout.sy) + layout.m;
    var x1 = x0 + Math.max(1, Math.round(c.width * layout.sx));
    var y1 = y0 + rows;
    function clampTo(v, hi) { return Math.min(hi, Math.max(0, v)); }
    var r = { x0: clampTo(x0, layout.outW), y0: clampTo(y0, layout.outH), x1: clampTo(x1, layout.outW), y1: clampTo(y1, layout.outH) };
    if (r.x1 - r.x0 < 1 || r.y1 - r.y0 < 1) {
      r = { x0: layout.m, y0: layout.m, x1: layout.m + layout.W, y1: Math.min(layout.outH, layout.m + rows) };
    }
    return r;
  }

  /** Draw src to fill w x h, cropping the long side (CSS cover). */
  function drawCover(ctx, src, w, h) {
    var sw = src.width || src.videoWidth;
    var sh = src.height || src.videoHeight;
    var r = coverRect(sw, sh, w, h);
    ctx.drawImage(src, r.x, r.y, r.w, r.h);
  }

  /**
   * The one blur. Source -> a (W+2m) x (H+2m) canvas, unfiltered, so there
   * are m real pixels past every edge; then that canvas -> W x H through
   * ctx.filter blur, offset by -m, so the edge pixels blur into picture,
   * not into transparent black. Encoded as a JPEG blob. The blur is the
   * plan's blurPx at SCALE (blurBitmapPx); W x H is the window/screen as
   * before, or, lined up, the monitor (below). Returns the blob, the guard's
   * pixels (read once, here) and what was done (Backdrop._lastRender()).
   */
  function blurFrame(src, p) {
    var sw = src.width;
    var sh = src.height;
    if (!sw || !sh) { closeBitmap(src); return Promise.reject(fail('the picture has no pixels')); }

    var b = blurBitmapPx(p.blurPx);
    var m = Math.ceil(b * OVERSCAN_SIGMAS);
    var W, H, outW, outH, big, bctx, layout = null;

    if (p.lined) {
      /* Lined up: the bitmap is the MONITOR at SCALE plus m px of overscan
         on every side (so the layer has real pixels past the monitor's
         edges too), blurred from a canvas with 2m: first today's cover of
         the whole canvas as a base (it fills the overscan), then the exact
         monitor-cover placement on top, unclipped, so along the long side
         the picture itself runs on into the margin. */
      layout = linedLayout(p.mon.w, p.mon.h, p.blurPx);
      W = layout.W;
      H = layout.H;
      outW = layout.outW;
      outH = layout.outH;
      big = canvasOf(W + 4 * m, H + 4 * m);
      bctx = big.getContext('2d');
      bctx.imageSmoothingQuality = 'high';
      drawCover(bctx, src, big.width, big.height);
      var r = coverRect(sw, sh, W, H);
      bctx.drawImage(src, 2 * m + r.x, 2 * m + r.y, r.w, r.h);
    } else {
      var scr = window.screen || {};
      var vw = Math.max(window.innerWidth || 0, scr.width || 0, 640);
      var vh = Math.max(window.innerHeight || 0, scr.height || 0, 360);
      W = Math.max(64, Math.round(vw * SCALE));
      H = Math.max(36, Math.round(vh * SCALE));
      outW = W;
      outH = H;
      big = canvasOf(W + 2 * m, H + 2 * m);
      bctx = big.getContext('2d');
      bctx.imageSmoothingQuality = 'high';
      drawCover(bctx, src, big.width, big.height);
    }
    closeBitmap(src);

    var out = canvasOf(outW, outH);
    var ctx = out.getContext('2d');
    var filtered = false;
    var filterUsed = null;
    if ('filter' in ctx) {
      // Light's ground is Mantle's island light: blur, then saturate(150%).
      ctx.filter = 'blur(' + b + 'px)' + (p.saturate && p.saturate !== 100 ? ' saturate(' + p.saturate + '%)' : '');
      filtered = ctx.filter !== 'none';
      filterUsed = filtered ? ctx.filter : null;
    }
    if (filtered) {
      ctx.drawImage(big, -m, -m);
      ctx.filter = 'none';
    } else {
      // No canvas filters: soften by squeezing to an eighth and back up.
      // Coarser than a gaussian, still no hard detail behind the glass.
      var tiny = canvasOf(Math.max(8, W / 8), Math.max(8, H / 8));
      var tctx = tiny.getContext('2d');
      tctx.imageSmoothingQuality = 'high';
      tctx.drawImage(big, 0, 0, tiny.width, tiny.height);
      ctx.imageSmoothingQuality = 'high';
      if (p.lined) ctx.drawImage(tiny, -m, -m, big.width, big.height);   // keep the lined placement
      else ctx.drawImage(tiny, 0, 0, W, H);
    }

    var corner = null;
    try { corner = ctx.getImageData(0, 0, 1, 1).data[3]; } catch (err) { corner = null; }
    /* The pixels the guard reads, read ONCE here: the whole bitmap. Lined,
       the band moves with the window; not lined, the guard reads the top
       band only, but toprow.js (top bar hints for Mantle) samples the row
       at the window's top edge, which cover-fit can put below that band
       (a wide, short window), so the whole bitmap is kept either way
       (~0.75 MB at 1920x1080, the size lined has always kept). */
    var band = p.lined ? null : topBand(W, H);
    var pixels = null;
    try {
      var readH = outH;
      pixels = { data: ctx.getImageData(0, 0, outW, readH).data, w: outW, h: readH };
    } catch (err) { pixels = null; }   // unreadable: the guard keeps the floor

    var info = {
      width: W, height: H, blur: b, overscan: m, filtered: filtered, cornerAlpha: corner,
      blurPx: p.blurPx, saturate: p.saturate || 100, filter: filterUsed, lined: !!p.lined, outWidth: outW, outHeight: outH,
      monitor: p.lined ? { width: p.mon.w, height: p.mon.h } : null,
      layer: p.lined ? { width: round2(layout.cssW), height: round2(layout.cssH),
                         marginX: round2(layout.marginX), marginY: round2(layout.marginY) } : null
    };
    big.width = 0;                 // drop the big bitmap now, not at GC
    return toBlob(out, OUT_TYPE, OUT_QUALITY).then(function (blob) {
      out.width = 0;
      return { blob: blob, pixels: pixels, band: band, layout: layout, info: info };
    });
  }

  /* --- the sources -------------------------------------------------- */

  function wallpaperSource() {
    var api = bgApi();
    if (!api || typeof api.wallpaper !== 'function') {
      return Promise.reject(fail('this window was started before the wallpaper copy existed; restart the browser',
        { type: 'wallpaper', phase: 'copy' }));
    }
    return Promise.resolve().then(function () { return api.wallpaper(); }).then(function (res) {
      if (!res || typeof res.fileUrl !== 'string' || !res.fileUrl) {
        throw fail((res && res.reason) || 'the copy did not come back', { type: 'wallpaper', phase: 'copy' });
      }
      // phase: 'copy' failures are main's (no file, not a picture); 'read'
      // ones are the copy itself refusing to load or decode here.
      var source = {
        type: 'wallpaper',
        phase: 'read',
        url: res.fileUrl,
        fileName: res.fileName || null,
        copiedAt: res.copiedAt || null
      };
      return decodeUrl(res.fileUrl).then(function (bitmap) {
        return { bitmap: bitmap, source: source };
      }, function (err) {
        throw fail(reasonOf(err), source);
      });
    });
  }

  /**
   * A built-in photo: a file:// URL in the app folder, read like the
   * wallpaper copy. When Settings cannot resolve the id (a newer build's
   * photo, a deleted file, no list) the WALLPAPER is read in its place and
   * the result carries fallbackReason, which render() publishes as state
   * 'fallback' with that picture still shown (source.shown = true).
   */
  function builtinSource(cfg) {
    var s = settings();
    var ask = s && typeof s.builtinBackground === 'function'
      ? Promise.resolve().then(function () { return s.builtinBackground(cfg.id); })
      : Promise.resolve({ ok: false, reason: 'this window was started before the built-in photos existed; restart the browser' });
    return ask.then(function (res) {
      if (res && res.ok && res.item) {
        var item = res.item;
        var source = { type: 'builtin', id: item.id, title: item.title, url: item.fileUrl, fileName: item.file };
        return decodeUrl(item.fileUrl).then(function (bitmap) {
          return { bitmap: bitmap, source: source };
        }, function (err) {
          throw fail(reasonOf(err), source);
        });
      }
      var why = (res && res.reason) || 'the built-in photo could not be found';
      return wallpaperSource().then(function (got) {
        got.source.fallbackFor = { type: 'builtin', id: cfg.id || null };
        got.source.shown = true;
        got.fallbackReason = why;
        return got;
      }, function (err) {
        throw fail(why + '; the Windows wallpaper could not be shown either (' + reasonOf(err) + ')',
          { type: 'builtin', id: cfg.id || null });
      });
    });
  }

  /**
   * "Same as desktop": Mantle's still when LookSync has one, else the copy
   * of the Windows wallpaper with the fallback reason (render() publishes
   * state 'fallback' with that picture shown). A still that will not read
   * falls back the same way, and says so.
   */
  function desktopSource(p) {
    var d = p.desk;
    function windowsWallpaper(why) {
      return wallpaperSource().then(function (got) {
        got.source.fallbackFor = { type: 'desktop' };
        got.source.shown = true;
        got.fallbackReason = why;
        return got;
      }, function (err) {
        throw fail(why + '; the Windows wallpaper could not be shown either (' + reasonOf(err) + ')',
          { type: 'desktop' });
      });
    }
    if (d.state !== 'ok') return windowsWallpaper(d.reason || NO_LINK_REASON);
    var source = { type: 'desktop', url: d.stillUrl, title: d.title, rev: d.rev };
    return decodeUrl(d.stillUrl).then(function (bitmap) {
      return { bitmap: bitmap, source: source };
    }, function (err) {
      return windowsWallpaper("Following Windows' wallpaper: Mantle's still could not be read (" + reasonOf(err) + ')');
    });
  }

  function imageSource() {
    var store = assets();
    var source = { type: 'image', key: IMAGE_KEY };
    if (!store) return Promise.reject(fail('the picture store is not available in this window', source));
    return store.get(IMAGE_KEY).then(function (blob) {
      if (!blob) throw fail('no image is stored yet; choose one', source);
      source.bytes = blob.size || 0;
      return decodeBlob(blob).then(function (bitmap) {
        // blob: the Home picture (unblurred) is this file, as an object URL.
        return { bitmap: bitmap, source: source, blob: blob };
      }, function () {
        throw fail('the stored image could not be decoded', source);
      });
    }, function (err) {
      if (err && err.reason) throw err;
      throw fail('the picture store could not be read', source);
    });
  }

  function extOfUrl(u) {
    var p = String(u || '').split(/[?#]/)[0];
    var dot = p.lastIndexOf('.');
    return dot >= 0 ? p.slice(dot + 1).toLowerCase() : '';
  }

  function isGif(cfg) {
    return extOfUrl(cfg.fileUrl) === 'gif' || extOfUrl(cfg.fileName) === 'gif';
  }

  function mediaErrorText(error) {
    var code = error && error.code;
    if (code === 4) return 'the file is missing or in a format the browser cannot play';
    if (code === 3) return 'the clip could not be decoded';
    if (code === 2) return 'the clip could not be read from disk';
    if (code === 1) return 'loading the clip was stopped';
    return (error && error.message) || 'the clip could not be opened';
  }

  /** A drawable (bitmap or <video>) down to STILL_MAX_EDGE, as a JPEG blob. */
  function stillBlobOf(src, w, h) {
    var scale = Math.min(1, STILL_MAX_EDGE / Math.max(w, h));
    var c = canvasOf(w * scale, h * scale);
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return toBlob(c, OUT_TYPE, OUT_QUALITY).then(function (blob) { c.width = 0; return blob; });
  }

  /** The first frame of a GIF: createImageBitmap on its bytes gives exactly that. */
  function captureGifStill(cfg) {
    return decodeUrl(cfg.fileUrl).then(function (bitmap) {
      return stillBlobOf(bitmap, bitmap.width, bitmap.height).then(function (blob) {
        closeBitmap(bitmap);
        return blob;
      }, function (err) { closeBitmap(bitmap); throw err; });
    });
  }

  /**
   * One frame of a clip, from an offscreen <video> that is never added to
   * the document and is torn down (src removed, load() to free the decoder)
   * the moment the frame is drawn or the attempt ends.
   *
   * WHY IT WAITS ON EVENTS, NOT A CLOCK (fixed 2026-10-08). The first build
   * gave the clip a flat 15 s. On a cold boot with an 80 MB 4K clip that
   * was not enough: the Home opens the same file at the same moment, and the
   * read came back "did not give up a frame within 15 s", leaving the window
   * plain until the clip was picked again (which then took 512 ms). Now:
   *   - nothing is counted while the window is hidden (Chromium defers media
   *     loads in a hidden frame, so a clock running then measured nothing);
   *   - the deadline is a STALL timer: it restarts on every sign of progress
   *     (loadstart, progress, loadedmetadata, loadeddata, canplay, seeked),
   *     so a slow but moving read is never cut off, and only a read that has
   *     done nothing for STILL_STALL_MS fails (STILL_CEILING_MS caps it all);
   *   - the frame taken is the cheapest one: the FIRST frame, which is a
   *     keyframe and needs no seek at all. Only when that frame is black (a
   *     fade-in) does it seek on to ~1 s, and if that seek has not landed
   *     within SEEK_GRACE_MS the first frame is used anyway.
   * ctl.cancel() ends it early (a playing Home gave up a frame first).
   */
  function captureVideoStill(cfg, ctl) {
    return new Promise(function (resolve, reject) {
      var v = document.createElement('video');
      var done = false;
      var stall = 0;
      var ceiling = 0;
      var seekGrace = 0;
      var seeking = false;
      var EVENTS = ['loadstart', 'progress', 'loadedmetadata', 'loadeddata', 'canplay', 'seeked', 'error'];

      function teardown() {
        for (var i = 0; i < EVENTS.length; i++) v.removeEventListener(EVENTS[i], onEvent);
        document.removeEventListener('visibilitychange', armStall);
        try { v.pause(); } catch (err) { /* fine */ }
        v.removeAttribute('src');
        try { v.load(); } catch (err) { /* fine */ }
      }
      function finish(err, blob) {
        if (done) return;
        done = true;
        window.clearTimeout(stall);
        window.clearTimeout(ceiling);
        window.clearTimeout(seekGrace);
        teardown();
        if (err) reject(err); else resolve(blob);
      }
      if (ctl) ctl.cancel = function () { finish(fail('cancelled: a frame came from elsewhere')); };

      /* The stall clock only runs while the window can be seen. */
      function armStall() {
        window.clearTimeout(stall);
        if (done || document.hidden) return;
        stall = window.setTimeout(function () {
          finish(fail('the clip gave no sign of progress for ' + (STILL_STALL_MS / 1000) + ' s' +
            (v.readyState >= 1 ? ' after opening' : ' while opening')));
        }, STILL_STALL_MS);
      }

      function grab(why) {
        if (done) return;
        var w = v.videoWidth;
        var h = v.videoHeight;
        if (!w || !h) { finish(fail('the clip has no picture in it')); return; }
        stillBlobOf(v, w, h).then(function (blob) {
          if (ctl) ctl.frame = why;
          finish(null, blob);
        }, function (err) { finish(err); });
      }

      /* Mean and peak brightness of a 16x16 sample: only a truly black frame
         (a fade-in) is passed over. A dark scene is a fine still. */
      function isBlack() {
        try {
          var c = canvasOf(16, 16);
          var ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(v, 0, 0, 16, 16);
          var d = ctx.getImageData(0, 0, 16, 16).data;
          c.width = 0;
          var sum = 0, peak = 0;
          for (var i = 0; i < d.length; i += 4) {
            var y = (d[i] * 2 + d[i + 1] * 5 + d[i + 2]) / 8;
            sum += y;
            if (y > peak) peak = y;
          }
          return sum / (d.length / 4) < 6 && peak < 24;
        } catch (err) {
          return false;   // cannot tell: the first frame will do
        }
      }

      function onEvent(e) {
        if (done) return;
        if (e.type === 'error') {
          var bad = fail(mediaErrorText(v.error));
          bad.mediaError = true;   // the file itself, not the timing
          finish(bad);
          return;
        }
        armStall();
        if (e.type === 'seeked' && seeking) { grab('seeked'); return; }
        if (seeking || v.readyState < 2) return;
        // The first decoded frame is on the element: take it unless it is black.
        if (!isBlack()) { grab('first'); return; }
        var d = v.duration;
        var t = isFinite(d) && d > 0 ? Math.min(1, d * 0.1) : 0;
        if (!(t > 0)) { grab('first'); return; }
        seeking = true;
        seekGrace = window.setTimeout(function () { grab('first (seek too slow)'); }, SEEK_GRACE_MS);
        try { v.currentTime = t; } catch (err) { grab('first'); }
      }

      for (var i = 0; i < EVENTS.length; i++) v.addEventListener(EVENTS[i], onEvent);
      document.addEventListener('visibilitychange', armStall);
      v.muted = true;
      v.preload = 'auto';
      v.playsInline = true;
      armStall();
      ceiling = window.setTimeout(function () {
        finish(fail('the clip did not give up a frame within ' + (STILL_CEILING_MS / 1000) + ' s'));
      }, STILL_CEILING_MS);
      v.src = cfg.fileUrl;
    });
  }

  /**
   * One frame from a Home that is PLAYING the clip (app.js homeClipFrame:
   * the guest draws its own <video>). Instant when a Home is up, and the
   * only frame that cannot stall: the clip is already decoding there.
   */
  function homeStill(cfg) {
    var ask = window.homeClipFrame;
    if (typeof ask !== 'function') return Promise.reject(fail('this window cannot ask a new tab for a frame'));
    return Promise.resolve().then(function () { return ask(cfg.fileUrl); }).then(function (res) {
      if (!res || !res.ok || !res.dataUrl) throw fail((res && res.reason) || 'no new tab gave a frame');
      return fetch(res.dataUrl).then(function (r) { return r.blob(); });
    });
  }

  /**
   * The still of a clip, from whichever answers first: a playing Home
   * (asked now, and again each time a Home starts the clip:
   * 'homeclipplaying' from app.js) or the offscreen read. A GIF is read as
   * one image and needs neither.
   */
  function captureClipStill(cfg) {
    if (isGif(cfg)) {
      return captureGifStill(cfg).then(function (blob) { return { blob: blob, via: 'gif' }; });
    }
    return new Promise(function (resolve, reject) {
      var settled = false;
      var ctl = {};
      function cleanup() { document.removeEventListener('homeclipplaying', fromHome); }
      function fromHome() {
        if (settled) return;
        homeStill(cfg).then(function (blob) {
          if (settled) return;
          settled = true;
          cleanup();
          if (ctl.cancel) ctl.cancel();
          resolve({ blob: blob, via: 'home' });
        }, function () { /* not yet: the offscreen read, or the next play, answers */ });
      }
      document.addEventListener('homeclipplaying', fromHome);
      fromHome();
      captureVideoStill(cfg, ctl).then(function (blob) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ blob: blob, via: 'offscreen ' + (ctl.frame || 'frame') });
      }, function (err) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });
    });
  }

  function videoSource(cfg) {
    var key = stillKey(cfg);
    var source = { type: 'video', url: cfg.fileUrl || null, fileName: cfg.fileName || null, stillKey: key, still: null };
    if (!cfg.fileUrl) return Promise.reject(fail('no moving picture is chosen yet; choose one', source));
    var store = assets();

    function capture() {
      var t0 = Date.now();
      source.attempt = clipRetry.attempt + 1;
      return captureClipStill(cfg).then(function (got) {
        source.still = 'captured';
        source.via = got.via;
        source.captureMs = Date.now() - t0;
        var saved = store
          ? store.put(STILL_KEY, { id: key, blob: got.blob, fileName: cfg.fileName || null, at: Date.now() })
            .then(function () { source.cached = true; }, function () { source.cached = false; })
          : Promise.resolve();
        return saved.then(function () { return decodeBlob(got.blob); });
      }).then(function (bitmap) {
        return { bitmap: bitmap, source: source };
      }, function (err) {
        source.captureMs = Date.now() - t0;
        /* A still that could not be TAKEN is not a clip that cannot be
           PLAYED: unless the media pipeline itself said the file is bad,
           the Home keeps playing it (app.js backgroundPayload) and the
           still is retried (scheduleClipRetry). */
        source.stillPending = !(err && err.mediaError);
        throw fail(reasonOf(err), source);
      });
    }

    var cached = store ? store.get(STILL_KEY).catch(function () { return null; }) : Promise.resolve(null);
    return cached.then(function (rec) {
      if (rec && rec.id === key && rec.blob) {
        return decodeBlob(rec.blob).then(function (bitmap) {
          source.still = 'cached';
          return { bitmap: bitmap, source: source };
        }, capture);   // a cached still that will not decode is simply retaken
      }
      return capture();
    });
  }

  /* --- retrying a clip's still ------------------------------------------
     A video background never stays in fallback for good while the clip can
     still be read: after a failed still the layer tries again on a widening
     clock (RETRY_STEPS_MS, then every RETRY_EVERY_MS), at once when a Home
     starts playing the clip, and at once when the window comes back into
     view. Each try is a normal render(true); the reason and the next try
     ride in the published state, so Settings says what is going on. Any
     other background, or a different clip, cancels it. */
  var clipRetry = { timer: 0, attempt: 0, sig: null, at: 0, reason: null };

  function clearClipRetry(resetCount) {
    window.clearTimeout(clipRetry.timer);
    clipRetry.timer = 0;
    clipRetry.at = 0;
    if (resetCount) { clipRetry.attempt = 0; clipRetry.sig = null; clipRetry.reason = null; }
  }

  function scheduleClipRetry(sig) {
    if (clipRetry.sig !== sig) { clipRetry.sig = sig; clipRetry.attempt = 0; }
    clipRetry.attempt += 1;
    var i = clipRetry.attempt - 1;
    var wait = i < RETRY_STEPS_MS.length ? RETRY_STEPS_MS[i] : RETRY_EVERY_MS;
    window.clearTimeout(clipRetry.timer);
    clipRetry.at = Date.now() + wait;
    clipRetry.timer = window.setTimeout(retryClipNow, wait);
    return { attempt: clipRetry.attempt, inMs: wait, at: clipRetry.at };
  }

  function retryClipNow() {
    if (!clipRetry.at) return;                 // nothing owed
    var cfg = config();
    if (cfg.kind !== 'video' || signature(cfg) !== clipRetry.sig) { clearClipRetry(true); return; }
    clearClipRetry(false);
    render(true);
  }

  /* A Home started the clip, or the window came back into view: a still
     that is owed is tried at once rather than on the clock. */
  document.addEventListener('homeclipplaying', function () { if (clipRetry.at) retryClipNow(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && clipRetry.at) retryClipNow(); });

  /* --- the render ----------------------------------------------------- */

  /**
   * What the layer should show now, and its key: everything that shapes the
   * blurred bitmap and nothing else (the dim, the panel and the accent are
   * CSS; the window's position is a transform).
   */
  function plan(cfg) {
    var kind = normKind(cfg && cfg.kind);
    var g = glassFor(themeNow());
    var light = themeNow() === 'light';
    var p = { kind: kind, blurPx: g.blurPx, saturate: light ? LIGHT_SATURATE : 100, srcKey: null, key: null, desk: null, lined: false, mon: null };
    if (kind === 'none') { p.key = 'none'; return p; }
    if (kind === 'desktop') {
      p.desk = deskInfo();
      if (p.desk.state === 'loading') { p.key = 'desktop|loading'; return p; }
      p.srcKey = p.desk.state === 'ok' ? 'desktop|' + p.desk.stillUrl : 'desktop|windows-wallpaper';
      var pl = currentPlace();
      if (pl) { p.lined = true; p.mon = { w: pl.display.width, h: pl.display.height }; }
    } else {
      p.srcKey = signature(cfg);
    }
    p.key = p.srcKey + '|blur ' + p.blurPx + (p.saturate !== 100 ? '|sat ' + p.saturate : '') + '|' +
      (p.lined ? 'monitor ' + p.mon.w + 'x' + p.mon.h : 'window');
    return p;
  }

  /** A desktop fallback whose reason changed (LookSync says why anew). */
  function refreshDeskReason(p) {
    if (current.kind !== 'desktop' || current.state !== 'fallback' || !p.desk) return;
    if (p.desk.state !== 'fallback' || !p.desk.reason || current.reason === p.desk.reason) return;
    var src = current.source;
    if (!src || !src.fallbackFor || src.fallbackFor.type !== 'desktop') return;
    publish({ kind: current.kind, state: current.state, reason: p.desk.reason, source: src });
  }

  function render(force) {
    var cfg = config();
    var p = plan(cfg);
    if (!force && p.key === lastSig) {
      refreshDeskReason(p);
      return Promise.resolve(snapshot());
    }
    lastSig = p.key;
    var mySeq = ++seq;
    var kind = p.kind;
    var sig = signature(cfg);      // the clip's retry key (video)

    if (kind === 'none') {
      clearClipRetry(true);
      clearPhoto();
      publish({ kind: 'none', state: 'ok', reason: null, source: { type: 'none' } });
      return Promise.resolve(snapshot());
    }

    // A still owed for ANOTHER clip, or any other kind now: stop retrying it.
    if (kind !== 'video' || (clipRetry.sig !== null && clipRetry.sig !== sig)) clearClipRetry(true);
    else clearClipRetry(false);

    // The desktop record is not in yet: the old picture (if any) stays up.
    if (kind === 'desktop' && p.desk.state === 'loading') {
      publish({ kind: kind, state: 'loading', reason: null, source: null });
      waitForDesktop();
      return Promise.resolve(snapshot());
    }

    // Blurred before for exactly this (a theme flip back, the monitor it
    // was on): shown again from the cache, nothing re-read or re-blurred.
    var hit = force ? null : cacheGet(p.key);
    if (hit && hit.pub) {
      return showEntry(hit, mySeq).then(function (ok) {
        if (ok && mySeq === seq) {
          publish(JSON.parse(JSON.stringify(hit.pub)));
          refreshDeskReason(p);
        }
        return snapshot();
      });
    }

    // The old picture stays up while the new one is prepared. A re-blur of
    // the SAME source (another blur value, another monitor size) does not
    // say 'loading'. A retried still keeps saying why it is being retried.
    if (!(shown && shown.srcKey === p.srcKey && current.kind === kind)) {
      var again = kind === 'video' && clipRetry.attempt > 0 && clipRetry.reason
        ? 'trying again (try ' + (clipRetry.attempt + 1) + ') after: ' + clipRetry.reason : null;
      publish({ kind: kind, state: 'loading', reason: again, source: null });
    }

    var pick = kind === 'image' ? imageSource()
      : kind === 'video' ? videoSource(cfg)
      : kind === 'builtin' ? builtinSource(cfg)
      : desktopSource(p);

    return pick.then(function (got) {
      if (mySeq !== seq) { closeBitmap(got.bitmap); return null; }
      var entry = null;
      return blurFrame(got.bitmap, p).then(function (frame) {
        if (mySeq !== seq) return false;
        entry = {
          key: p.key, srcKey: p.srcKey, url: URL.createObjectURL(frame.blob),
          lined: !!p.lined, layout: frame.layout, pixels: frame.pixels, band: frame.band,
          info: frame.info, pub: null
        };
        // The same picture UNBLURRED, for Helm's Home (syncHome): the file
        // itself for the desktop still, a built-in photo and the wallpaper
        // copy; the stored picture as an object URL (owned, revoked with the
        // entry). A clip has none: it plays on the new tab itself.
        if (kind !== 'video') {
          if (got.source && typeof got.source.url === 'string' && got.source.url) entry.clearUrl = got.source.url;
          else if (got.blob) { entry.clearUrl = URL.createObjectURL(got.blob); entry.clearOwned = true; }
        }
        cachePut(entry);
        return showEntry(entry, mySeq);
      }).then(function (ok) {
        if (!ok || mySeq !== seq) return;
        var note = null;
        if (got.source && got.source.type === 'wallpaper' && recopyNote) { note = recopyNote; recopyNote = null; }
        var pub;
        // A built-in id, or the desktop, stood in for by the wallpaper: shown, but said.
        if (got.fallbackReason) {
          pub = { kind: kind, state: 'fallback', reason: got.fallbackReason + (note ? '. ' + note : ''), source: got.source };
        } else {
          if (kind === 'video') clearClipRetry(true);
          pub = { kind: kind, state: 'ok', reason: note, source: got.source };
        }
        entry.pub = JSON.parse(JSON.stringify(pub));
        publish(pub);
      }, function (err) {
        throw fail(reasonOf(err), got.source);
      });
    }).catch(function (err) {
      if (mySeq !== seq) return;
      clearPhoto();
      var source = (err && err.source) || null;
      /* A clip that is still chosen and still named is never given up on:
         the next try is scheduled and published with the reason. */
      if (kind === 'video' && cfg.fileUrl) {
        clipRetry.reason = reasonOf(err);
        source = source || { type: 'video', url: cfg.fileUrl, fileName: cfg.fileName || null };
        source.retry = scheduleClipRetry(sig);
      }
      publish({ kind: kind, state: 'fallback', reason: reasonOf(err), source: source });
    }).then(snapshot);
  }

  /**
   * "Copy again from Windows": main re-reads TranscodedWallpaper over the old
   * copy, then the layer re-renders (the copy's URL carries a fresh ?v=, so
   * nothing is served from cache). A failed copy keeps the old picture up;
   * its reason is returned AND shown in the state line once.
   */
  function recopyWallpaper() {
    var api = bgApi();
    if (!api || typeof api.recopyWallpaper !== 'function') {
      return Promise.resolve({ ok: false, reason: 'this window was started before the wallpaper copy existed; restart the browser' });
    }
    return Promise.resolve().then(function () { return api.recopyWallpaper(); }).then(function (res) {
      var out = res && typeof res === 'object' ? res : { ok: false, reason: 'no answer from the browser' };
      if (!out.ok && out.fileUrl) recopyNote = 'Could not copy it again: ' + (out.reason || 'unknown reason');
      // Re-read only when the copy is what the layer shows (the desktop's
      // fallback, or a built-in stood in for by it).
      if (current.source && current.source.type === 'wallpaper') return render(true).then(function () { return out; });
      return out;
    }, function (err) {
      return { ok: false, reason: reasonOf(err) };
    });
  }

  /* --- Look Sync events: glass, theme, place ---------------------------- */

  var lookTimer = 0;
  var lookTheme = null;

  /**
   * The glass or the theme changed (lookglass, data-theme, Settings'
   * glass): panel and dim are CSS at once, the guard re-reads cached
   * pixels, and a re-blur happens only if the key moved: at once on a
   * theme flip (from the cache when it can), after LOOK_RENDER_MS of quiet
   * for a slider preview, so a drag of the Blur slider is not a blur per
   * input event.
   */
  function onLook() {
    applyLookVars();
    refreshGuard();
    syncHome();                  // both themes show it; re-checked in case the picture moved
    var theme = themeNow();
    window.clearTimeout(lookTimer);
    lookTimer = 0;
    if (theme !== lookTheme) { lookTheme = theme; render(false); return; }
    lookTimer = window.setTimeout(function () { lookTimer = 0; render(false); }, LOOK_RENDER_MS);
  }

  var placeRaf = 0;
  var pendingPlace = null;
  var moveEndTimer = 0;
  var nextFrame = typeof window.requestAnimationFrame === 'function'
    ? function (fn) { return window.requestAnimationFrame(fn); }
    : function (fn) { return window.setTimeout(fn, 16); };

  /** lookplace is RAW (60+/s in a drag): keep the newest, act once a frame. */
  function onLookPlace(e) {
    var pl = validPlace(e && e.detail) || validPlace(readPlace());
    if (!pl) return;
    pendingPlace = pl;
    if (!placeRaf) placeRaf = nextFrame(placeFrame);
  }

  function placeFrame() {
    placeRaf = 0;
    var pl = pendingPlace;
    pendingPlace = null;
    if (!pl) return;
    placeNow = pl;
    if (current.kind !== 'desktop') return;     // own kinds cover the window: nothing to move
    if (!shown || !shown.lined || shown.layout.monW !== pl.display.width || shown.layout.monH !== pl.display.height) {
      // The first place, or a monitor of another size: its blur (cached or
      // new). Same key as the render in flight returns at once.
      render(false);
    }
    if (shown && shown.lined) positionLayer(shown, true);
    window.clearTimeout(moveEndTimer);
    moveEndTimer = window.setTimeout(moveEnded, MOVE_END_MS);
  }

  /** The move ended: the layer leaves the compositor, the guard re-reads. */
  function moveEnded() {
    moveEndTimer = 0;
    if (shown && shown.lined) positionLayer(shown, false);
    refreshGuard();
  }

  /* --- boot ------------------------------------------------------------ */

  /* The public surface goes up BEFORE the first render, so anything that
     hears the first backdropchange can already ask Backdrop.state(). */
  window.Backdrop = {
    state: snapshot,
    refresh: function () { return render(true); },
    recopyWallpaper: recopyWallpaper,
    stillKey: stillKey,
    /* toprow.js (top bar hints for Mantle): which picture is on the layer
       and how it maps onto the window. shown = a blurred bitmap is on
       .bg-photo; srcKey 'desktop|<stillUrl>' when it is Mantle's still,
       deskStillUrl = the still Mantle's record names right now (null when
       the record is not usable), so "the layer shows the current shared
       still" is srcKey === 'desktop|' + deskStillUrl. pixels = the blurred
       bitmap (outW x outH RGBA, pre-JPEG), layout = the lined geometry
       (null when cover-fitted to the window), place = LookSync's last
       valid place. Read-only: nothing here is copied. */
    toprowSource: function () {
      var d = deskInfo();
      return {
        kind: current.kind, state: current.state,
        shown: !!shown, srcKey: shown ? shown.srcKey : null, lined: !!(shown && shown.lined),
        layout: shown ? shown.layout : null, pixels: shown ? shown.pixels : null,
        outW: shown && shown.info ? shown.info.outWidth : null,
        outH: shown && shown.info ? shown.info.outHeight : null,
        place: placeNow, deskStillUrl: d && d.state === 'ok' ? d.stillUrl : null
      };
    },
    // test seams
    _lastRender: function () {
      if (!lastRender) return null;
      var out = JSON.parse(JSON.stringify(lastRender));
      if (shown) {
        out.glassAlpha = guard.alpha;
        out.glassBrightest = guard.brightest;
        out.glassRatio = guard.ratio;
        out.glassRaised = guard.raised;
      }
      out.offset = shown && shown.lined && placeNow ? monitorOffset(placeNow) : null;
      out.translate = lastPos ? { x: lastPos.x, y: lastPos.y, moving: lastPos.moving } : null;
      return out;
    },
    _cache: function () {
      return cache.map(function (e) { return { key: e.key, lined: e.lined, shown: e === shown }; });
    },
    _math: {
      SCALE: SCALE, BAND_FRAC: BAND_FRAC, OVERSCAN_SIGMAS: OVERSCAN_SIGMAS,
      GLASS_FLOOR: GLASS_FLOOR, GLASS_CEIL: GLASS_CEIL, PANEL_BASE: PANEL_BASE,
      blurBitmapPx: blurBitmapPx, coverRect: coverRect, linedLayout: linedLayout,
      monitorOffset: monitorOffset, layerTranslate: layerTranslate,
      topBand: topBand, guardBand: guardBand, bandCandidates: bandCandidates,
      guardAlpha: guardAlpha, panelValues: panelValues, normGlass: normGlass, normKind: normKind
    },
    _keys: { image: IMAGE_KEY, still: STILL_KEY }
  };

  lookTheme = themeNow();
  applyLookVars();
  refreshGuard();
  var firstKind = normKind(config().kind);
  publish({ kind: firstKind, state: firstKind === 'none' ? 'ok' : 'loading', reason: null, source: null });
  booted = true;

  var s = settings();
  if (s && typeof s.on === 'function') {
    s.on(function (all, keys) {
      var any = !Array.isArray(keys);
      // Without LookSync no lookglass comes: Settings' glass is the source.
      if (any || keys.indexOf('glass') >= 0) onLook();
      if (!any && keys.indexOf('newtabBackground') < 0) return;
      dropStaleStill();
      render(false);
    });
  }
  document.addEventListener('lookglass', onLook);
  // A new record may carry a new shared value (or lose it), and sync on/off
  // decides whether it applies: re-read the wash even when the picture is
  // the same one (render() then returns early).
  document.addEventListener('lookdesktop', function () { refreshGuard(); render(false); });
  document.addEventListener('lookstatus', function () { refreshGuard(); render(false); });
  document.addEventListener('lookplace', onLookPlace);
  if (typeof MutationObserver === 'function') {
    try {
      new MutationObserver(onLook).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (err) { /* lookglass also fires on a flip */ }
  }
  render(true);

  /* A removed clip leaves no descriptor to key a still on (settings.js drops
     fileUrl), so its cached frame goes too rather than sit in IndexedDB. */
  function dropStaleStill() {
    var cfg = config();
    var store = assets();
    if (cfg.fileUrl || !store || typeof store['delete'] !== 'function') return;
    store['delete'](STILL_KEY).catch(function () { /* not there */ });
  }
})();
