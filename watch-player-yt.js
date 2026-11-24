/* ============================================================
   watch-player-yt.js -- YouTube in Lumen's player layer.

   A YouTube video plays as YouTube's FULL watch page in the layer
   (comments, Like, Subscribe, Save, the description), in Quartz's
   normal session, so it is his signed-in YouTube. The embed is used
   only where the full page does not fit:
     - a multiview tile (s.multi): just the video;
     - the fallback, when the full page didn't load: "Play just the
       video" on the failed state.
   Any slot showing the embed gets a one-click "Full page" in the
   layer's bar, which loads that video's watch page in the same slot
   at the same start time.

   Loaded by index.html before watch-player.js, which calls in at
   its hooks (slotUrl, referrer, bar, sync, stateActs); with this
   file missing, the layer plays whatever URL it was given. Also a
   CommonJS module for the unit harness (pure parts only).
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./watch-player-hosts'));
  else root.WatchPlayerYT = factory(root.WatchPlayerHosts);
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';

  // The same app identity watch/preview.js sends: YouTube's embed refuses to play (error 153)
  // without a Referer naming the app that embeds it. Only the embed gets it. REFERER is the
  // project's public default; watch.json's optional "embedReferer" replaces it, and main hands
  // that over in Settings' describe() (asked once below, when this file loads in the chrome).
  var REFERER = 'https://github.com/atlas-studio-software/quartz';
  var referer = REFERER;
  function currentReferer() { return referer; }
  /** main's answer (already checked there, watch/preview.js cleanReferer): an https URL, or keep the default. */
  function setReferer(url) { referer = typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url) && url.length <= 300 ? url : REFERER; return referer; }
  if (typeof window !== 'undefined' && window.api && window.api.watch && typeof window.api.watch.describe === 'function') {
    try {
      var asked = window.api.watch.describe();
      if (asked && typeof asked.then === 'function') {
        asked.then(function (d) { if (d && d.embedReferer) setReferer(d.embedReferer); },
          function (err) { console.warn('[lumen] embed Referer: Lumen did not answer (' + ((err && err.message) || err) + '); using ' + REFERER); });
      }
    } catch (err) { console.warn('[lumen] embed Referer: could not ask Lumen; using ' + REFERER); }
  }
  var ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

  function parse(url) { try { return new URL(String(url || '')); } catch (e) { return null; } }

  /**
   * The ONE video a YouTube slot's URL is: { id, start, origin, embed } or null. service: the
   * slot's service; a test origin (rebased 127.0.0.1) counts when the slot says 'youtube'.
   */
  function videoOf(url, service) {
    var u = parse(url);
    if (!u || !/^https?:$/.test(u.protocol)) return null;
    var short = /(^|\.)youtu\.be$/i.test(u.hostname);
    if (service !== 'youtube' && !short && !(H && H.serviceFor(u.href) === 'youtube')) return null;
    var id = '';
    var embed = false;
    if (short) id = u.pathname.slice(1).split('/')[0];
    else if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else {
      var m = /^\/(embed|live)\/([^/?#]+)/.exec(u.pathname);
      if (m) { id = m[2]; embed = m[1] === 'embed'; }
    }
    if (!ID_RE.test(id)) return null;
    var t = u.searchParams.get('t') || u.searchParams.get('start') || '';
    var start = H && typeof H.seconds === 'function' ? H.seconds(t) : (/^\d+$/.test(t) ? Number(t) : 0);
    return { id: id, start: start, origin: short ? 'https://www.youtube.com' : u.origin, embed: embed };
  }

  /** The embed with sound and YouTube's own controls (a tile, or the fallback). */
  function embedUrl(v) {
    return v.origin + '/embed/' + v.id + '?autoplay=1&playsinline=1&rel=0' + (v.start ? '&start=' + v.start : '');
  }
  /** The full watch page, at the same time. */
  function pageUrl(v) {
    return v.origin + '/watch?v=' + v.id + (v.start ? '&t=' + v.start + 's' : '');
  }
  /** 'embed' for a multiview tile, else 'page': the full watch page is the default. */
  function modeFor(o) { return o && o.multi ? 'embed' : 'page'; }

  /** What a slot should load for `url`: the same URL, or the page/embed form of that video. */
  function slotUrlFor(url, o) {
    var x = o || {};
    var v = videoOf(url, x.service);
    if (!v) return url;
    var want = modeFor(x);
    if (want === 'embed' && !v.embed) return embedUrl(v);
    if (want === 'page' && v.embed) return pageUrl(v);
    return url;
  }

  /* ---------------------------------------------------------------- the layer's hooks */

  var UI = { fullBtn: null, lastFull: '', pv: false };

  function slotUrl(ctx, s, url) {
    var next = slotUrlFor(url, { service: s.service, multi: !!s.multi });
    return next !== url ? next : undefined;
  }
  function referrer(ctx, s, url) {
    var v = videoOf(url, s.service);
    return v && v.embed ? currentReferer() : undefined;
  }
  function fullPage(ctx, s) {
    var slot = s || ctx.focused();
    var v = slot && slot.view ? videoOf(slot.url, slot.service) : null;
    if (!v || !v.embed) return false;
    var u = pageUrl(v);
    UI.lastFull = u;
    slot.url = u;
    slot._ytMove = (slot._ytMove || 0) + 1;   // a new load: any in-place move still pending is over (move() below)
    try { var pr = slot.view.loadURL(u); if (pr && pr.catch) pr.catch(function () { /* did-fail-load says the rest */ }); } catch (e) { slot.view.setAttribute('src', u); }
    if (UI.fullBtn) UI.fullBtn.hidden = true;
    return true;
  }
  /* ---- one video to the next, in place -------------------------------------------------------
     Up next's Play now, and any YouTube title opened while a YouTube video plays in the slot, used to
     loadURL the next watch page: a whole new document, so YouTube's app (its HTML, its scripts, the
     player) booted again from nothing before the next video could start. YouTube never does that
     itself: its related list and its autoplay move from one video to the next inside the same page
     (its 'yt-navigate'). move() asks the page for that same move, and Lumen's views already follow
     such a move (did-navigate-in-page: the play view re-reads the page, the play bar looks for the
     video again, Up next is re-armed by the reuse).
     The page must take it at once (YouTube starts the move, 'yt-navigate-start', within MOVE_MS).
     When it doesn't (not a watch page, no YouTube app, the event ignored, the page busy), the slot
     loads the page the old way and the reason is kept (lastMove, the e2e's _state), logged and shown
     in the bar (ctx.note: "Loading the next video the slow way: <why>"): the move is slower then,
     never stuck and never silent.
     Taking it is not landing it. yt-navigate-start says only that SOME move started (YouTube's own
     autoplay can start one at the same moment), and a move YouTube starts can still die on the way (the
     network drops, its data fetch fails) with the page left on the last video. By then the slot's url
     is already the next video and the play view was reset to 'loading' (the reuse), waiting for a
     did-navigate-in-page that never comes: the info would sit on "Reading YouTube's page..." with no
     reason. So a move that was taken must land: the page's address names the next video within
     LAND_MS, or the slot loads it the old way, said like any other refusal.
     Any newer load of the slot (another title, a channel, the same video again: watch-player.js's reuse
     and loadInto bump s._ytMove) supersedes a move still pending: its timers and late answers then do
     nothing, so an older move can never load its video over a newer page.
     MOVE_JS is told the video Lumen moves FROM and acts only on a page still on it. Electron holds a
     <webview>'s executeJavaScript until the page stops loading, so a move asked of a page still
     loading takes the bounded fallback below, and the held script may run later in whatever document
     is current by then (the fallback's own load, or a newer title): there it must not fire YouTube's
     move. */
  var MOVE_MS = 400;
  var LAND_MS = 4000;   // YouTube took the move: its address must name the next video by then
  var MOVE_JS = '(function (from, id, start, ms) { return new Promise(function (res) {' +
    ' var app = document.querySelector("ytd-app");' +
    ' if (location.pathname !== "/watch") return res("this page is not a watch page");' +
    ' var on = ""; try { on = new URLSearchParams(location.search).get("v") || ""; } catch (e) { on = ""; }' +
    ' if (on !== from) return res("not the video Lumen moved from");' +
    ' if (!app) return res("no YouTube app on the page");' +
    ' var done = false, url = "/watch?v=" + id + (start ? "&t=" + start + "s" : "");' +
    ' function ok() { if (done) return; done = true; window.removeEventListener("yt-navigate-start", ok, true); res("ok"); }' +
    ' window.addEventListener("yt-navigate-start", ok, true);' +
    ' var we = { videoId: id }; if (start) we.startTimeSeconds = start;' +
    ' var ep = { commandMetadata: { webCommandMetadata: { url: url, webPageType: "WEB_PAGE_TYPE_WATCH", rootVe: 3832 } }, watchEndpoint: we };' +
    ' try { app.dispatchEvent(new CustomEvent("yt-navigate", { bubbles: true, composed: true, detail: { endpoint: ep } })); }' +
    ' catch (e) { done = true; return res("YouTube refused the move (" + String((e && e.message) || e).slice(0, 80) + ")"); }' +
    ' setTimeout(function () { if (done) return; done = true; window.removeEventListener("yt-navigate-start", ok, true); res("YouTube did not start the move in " + ms + " ms"); }, ms);' +
    ' }); })';
  var lastMove = null;   // { how: 'in-page' | 'reload', why, id, ms, at, landed (in-page: the address named it) }

  /** The YouTube video id a slot's view is on now ('' when none, or the view can't say). */
  function viewVideo(v, service) {
    var u = '';
    try { u = String((v && typeof v.getURL === 'function' && v.getURL()) || ''); } catch (e) { u = ''; }
    var w = u ? videoOf(u, service) : null;
    return w ? w.id : '';
  }

  /** watch-player.js openInLumen's reuse: true when the page is asked to move (it then loads by itself if refused). */
  function move(ctx, s, from, to, ref) {
    if (ref || !s || !s.view || s.multi || !ctx || typeof ctx.load !== 'function') return undefined;
    var a = videoOf(from, s.service);
    var b = videoOf(to, s.service);
    // The same video again (a repeat, a new start time) loads as it always did.
    if (!a || !b || a.embed || b.embed || a.origin !== b.origin || a.id === b.id) return undefined;
    var v = s.view;
    var seq = s._ytMove = (s._ytMove || 0) + 1;
    var t0 = Date.now();
    // 'asking' (no answer yet) -> 'moving' (YouTube took it; not landed yet) -> 'done' (landed, or loaded the old way).
    var phase = 'asking';
    // Still this slot's newest load: the same view, and nothing opened or loaded since (s._ytMove: see the note above).
    function mine() { return s.view === v && s._ytMove === seq; }
    function took() {
      if (phase !== 'asking' || !mine()) return;
      phase = 'moving';
      lastMove = { how: 'in-page', why: '', id: b.id, ms: Date.now() - t0, at: Date.now(), landed: false };
      land(lastMove);
    }
    function fall(why) {
      if (phase === 'done' || !mine()) return;
      phase = 'done';
      lastMove = { how: 'reload', why: why, id: b.id, ms: Date.now() - t0, at: Date.now() };
      try { console.warn('[lumen] YouTube did not move to the next video in place (' + why + '): loading its page'); } catch (e) { /* no console */ }
      // In the bar, not only the console: the fallback costs time, so it is said, small and passing (the
      // layer's note: plain text that clears itself, no motion, nothing to dismiss).
      if (typeof ctx.note === 'function') { try { ctx.note('Loading the next video the slow way: ' + why); } catch (e) { /* the load still runs */ } }
      ctx.load(s, to, '');
    }
    // A taken move must land: the view's address names b by LAND_MS (YouTube's own in-page move pushes the new
    // address when it lands; Lumen's did-navigate-in-page hears it, and so does this). A newer load of the slot
    // ends the wait (mine() fails), and so does the landing; else the slot loads b the old way, said.
    function land(rec) {
      var timer = 0;
      var evs = ['did-navigate-in-page', 'did-navigate'];
      function stop() {
        clearTimeout(timer);
        for (var i = 0; i < evs.length; i++) { try { v.removeEventListener(evs[i], heard); } catch (e) { /* a bare view */ } }
      }
      function landed() { phase = 'done'; rec.landed = true; rec.ms = Date.now() - t0; stop(); }
      function heard(e) {
        if (phase !== 'moving' || !mine()) { stop(); return; }
        if (e && e.isMainFrame === false) return;   // a frame inside the page moving is not the page
        var w = e && e.url ? videoOf(String(e.url), s.service) : null;
        if (w && w.id === b.id) landed();
      }
      for (var i = 0; i < evs.length; i++) { try { v.addEventListener(evs[i], heard); } catch (e) { /* the timer still checks */ } }
      timer = setTimeout(function () {
        stop();
        if (phase !== 'moving' || !mine()) return;
        if (viewVideo(v, s.service) === b.id) { landed(); return; }
        fall('YouTube started the move but stayed on the last video');
      }, LAND_MS);
    }
    var pr = null;
    try {
      pr = v.executeJavaScript(MOVE_JS + '(' + JSON.stringify(a.id) + ',' + JSON.stringify(b.id) + ',' + (Number(b.start) || 0) + ',' + MOVE_MS + ')', true);
    } catch (e) { pr = null; }
    if (!pr || typeof pr.then !== 'function') return undefined;
    pr.then(function (r) { if (r === 'ok') took(); else fall(String(r || 'no answer from the page')); },
      function (e) { fall('the page did not answer (' + String((e && e.message) || e).slice(0, 80) + ')'); });
    // A page too busy to answer at all: load it the old way rather than wait on it (only while no answer came:
    // a move YouTube took is the landing check's).
    setTimeout(function () { if (phase === 'asking') fall('the page did not answer in ' + (MOVE_MS + 800) + ' ms'); }, MOVE_MS + 800);
    return true;
  }

  function bar(ctx, barEl) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'wp-btn wp-yt-full';
    b.textContent = 'Full page';
    b.title = 'YouTube’s full page: comments, Like, Subscribe, Save';
    b.setAttribute('aria-label', 'Open YouTube’s full page for this video: comments, Like, Subscribe and Save');
    b.hidden = true;
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      // Lumen's view (watch-playview.js): the same button switches between the view and the full page.
      var PV = window.LumenPlayview;
      if (UI.pv && PV && typeof PV.toggle === 'function' && PV.toggle(ctx.focused())) { sync(ctx, ctx.focused()); return; }
      fullPage(ctx);
    });
    UI.fullBtn = b;
    barEl.appendChild(b);
  }
  function sync(ctx, s) {
    if (!UI.fullBtn) return;
    var PV = typeof window !== 'undefined' ? window.LumenPlayview : null;
    var pv = PV && typeof PV.toggleFor === 'function' && s ? PV.toggleFor(s) : null;
    UI.pv = !!pv;
    if (pv) {
      UI.fullBtn.hidden = false;
      UI.fullBtn.textContent = pv.label;
      UI.fullBtn.title = pv.title;
      UI.fullBtn.setAttribute('aria-label', pv.title);
      return;
    }
    UI.fullBtn.textContent = 'Full page';
    UI.fullBtn.title = 'YouTube’s full page: comments, Like, Subscribe, Save';
    UI.fullBtn.setAttribute('aria-label', 'Open YouTube’s full page for this video: comments, Like, Subscribe and Save');
    var v = s && s.view ? videoOf(s.url, s.service) : null;
    UI.fullBtn.hidden = !(v && v.embed);
  }
  function stateActs(ctx, s, kind, acts) {
    if (kind !== 'failed' || !s.view) return;
    var v = videoOf(s.url, s.service);
    if (!v || v.embed) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'wp-btn';
    b.textContent = 'Play just the video';
    b.title = 'YouTube’s embedded player, without comments; “Full page” brings the page back';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var u = embedUrl(v);
      s.state.hidden = true;
      s.tile.classList.remove('has-state');
      s.url = u;
      s._ytMove = (s._ytMove || 0) + 1;   // a new load: any in-place move still pending is over (move() above)
      var ref = currentReferer();
      try { s.view.setAttribute('httpreferrer', ref); } catch (err) { /* the load below carries it too */ }
      try { var pr = s.view.loadURL(u, { httpReferrer: ref }); if (pr && pr.catch) pr.catch(function () { /* did-fail-load */ }); } catch (err) { s.view.setAttribute('src', u); }
      sync(ctx, s);
    });
    acts.appendChild(b);
  }

  return {
    REFERER: REFERER,
    referer: currentReferer,
    setReferer: setReferer,
    videoOf: videoOf,
    embedUrl: embedUrl,
    pageUrl: pageUrl,
    modeFor: modeFor,
    slotUrlFor: slotUrlFor,
    // the layer's hooks (watch-player.js X())
    slotUrl: slotUrl,
    referrer: referrer,
    bar: bar,
    sync: sync,
    stateActs: stateActs,
    pageMove: move,   // watch-player.js X('pageMove'): not 'move' (watch-shorts.js exports its own move)
    // e2e: press "Full page" the way a click does, and what the button shows; the last in-place move
    _fullPage: function () { return UI.fullBtn && !UI.fullBtn.hidden ? (UI.fullBtn.click(), true) : false; },
    _state: function () { return { fullShown: !!(UI.fullBtn && !UI.fullBtn.hidden), lastFull: UI.lastFull, label: UI.fullBtn ? UI.fullBtn.textContent : '', pv: UI.pv, lastMove: lastMove }; }
  };
});
