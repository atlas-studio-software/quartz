/* ============================================================
   watch-player.js -- the Watch player layer (chrome side).

   A title clicked in Watch plays INSIDE Watch: a full-bleed dark
   layer laid over the Watch tab, a slim top bar (Back, the service
   mark, the title, Open in a tab, Open in Edge when it applies) and
   the service's own page under it, in a <webview> on Quartz's normal
   session -- the same element tabs use, because Disney+, Prime and
   Hulu refuse to be framed by another page.

   The layer is built for 1-4 views ("slots"); one slot is the single
   player. Every slot owns exactly one <webview>; closing a slot
   removes it, which destroys its webContents and frees its memory.

   main (watch-player-main.js) keeps each player leak-proof: pages of
   the same service stay here (target=_blank included), sign-in popups
   open as a sheet inside the layer, other sites open a normal tab and
   app links are stopped; every way out is one quartz.log line.

   Keys: Esc leaves the video's fullscreen first, then a sign-in
   sheet, then closes the layer. Back (the bar, Alt+Left, the mouse's
   back button) walks the player's own history, then closes. The media
   keys play and pause the player. app.js hands keys over through
   runShortcut -> WatchPlayer.takeShortcut.

   window.openInLumen(url, { service, title }) is the one way in, for
   any code. HUB_NAME (watch-player-hosts.js) is the only place the
   hub's name lives.
   ============================================================ */
(function () {
  'use strict';
  var H = window.WatchPlayerHosts;
  var api = window.api && window.api.watchPlayer;
  var NAME = H ? H.HUB_NAME : 'Lumen';
  var ESC_AFTER_FS_MS = 500;   // an Esc this soon after the video left fullscreen was that same press

  var L = {
    el: null, bar: null, grid: null, titleEl: null, markEl: null, noteEl: null, edgeBtn: null,
    sheetEl: null, sheet: null,
    owner: null,              // the Watch tab the layer sits over
    slots: [],                // { id, url, service, title, view, wcId, tile, state, blocked, refused, fs }
    focus: 0,                 // index of the slot with the keyboard and the sound
    open: false,
    fsSlot: null, fsLeftAt: 0,
    seq: 0,
    ro: null, mo: null,
    noteTimer: 0,
    lastClosed: null          // the e2e's view of the last close: { wcIds, services, asked }
  };

  // watch-player-extras.js (straight-to-player fallback, the quality note, Up next, the layer's menu)
  // hooks in at a few points; with the file missing, nothing here changes.
  var CTX = { L: L, focused: focused, note: note, toast: toast, toEdge: toEdge, showState: showState, open: openInLumen, close: close, svcInfo: svcInfo, api: api,
    load: function (s, u, ref) { loadInto(s, u, ref); } };
  // watch-player-yt.js (YouTube: the full watch page, the embed for tiles and as the fallback,
  // "Full page") hooks in the same way, after the extras.
  function X(ev) {
    var args = [CTX].concat([].slice.call(arguments, 1));
    var out;
    // Lumen play view (watch-playview.js), Lumen play bar (watch-playerbar.js) and Lumen's Shorts view
    // (watch-shorts.js) hooks: attach / destroy / sync, like the two before. The play bar runs after the
    // play view, and Shorts hooks in last so it can fit the bar to the vertical player.
    [window.WatchPlayerExtras, window.WatchPlayerYT, window.LumenPlayview, window.LumenPlayerBar, window.LumenShorts].forEach(function (x) {
      if (!x || typeof x[ev] !== 'function') return;
      try { var r = x[ev].apply(null, args); if (out === undefined) out = r; } catch (e) {
        try { console.warn('[lumen extras] ' + ev + ': ' + ((e && e.message) || e)); } catch (e2) { /* no console */ }
      }
    });
    return out;
  }
  // watch-player-multi.js (multiview: up to four tiles, one with the sound; the mini-player) hooks in
  // the same way; with the file missing, the layer is the single player it always was.
  var MCTX = { L: L, focused: focused, note: note, toast: toast, place: place, layout: layout, syncBar: syncBar, show: show, close: close,
    makeSlot: makeSlot, destroySlot: destroySlot, svcInfo: svcInfo, svcName: svcName, el: el, btn: btn, api: api, NAME: NAME };
  function MV(ev) {
    var m = window.WatchPlayerMulti;
    if (!m || typeof m[ev] !== 'function') return undefined;
    try { return m[ev].apply(null, [MCTX].concat([].slice.call(arguments, 1))); } catch (e) {
      try { console.warn('[lumen multiview] ' + ev + ': ' + ((e && e.message) || e)); } catch (e2) { /* no console */ }
      return undefined;
    }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function btn(cls, label, onClick, aria) {
    var b = el('button', 'wp-btn ' + cls, label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', function (e) { e.stopPropagation(); onClick(b, e); });
    return b;
  }
  function toast(text, err) {
    try { if (window.Toast && typeof window.Toast.show === 'function') { window.Toast.show(text, err ? 6000 : 3500); return; } } catch (e) { /* no toast */ }
    note(text);
  }
  function reduced() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function svcInfo(id) { return (H && H.SERVICES[id]) || null; }
  function svcName(id) { var s = svcInfo(id); return s ? s.name : ''; }
  function hostOf(url) { try { return new URL(url).host; } catch (e) { return ''; } }
  function originOf(url) { try { return new URL(url).origin; } catch (e) { return ''; } }
  function liveTabs() { try { return tabs; } catch (e) { return []; } }
  function activeId() { try { return activeTabId; } catch (e) { return null; } }
  function isWatchTab(t) { try { return !!t && t.kind === 'page' && isWatchUrl(t.url); } catch (e) { return false; } }

  /* --------------------------------------------------------------- the layer */

  function build() {
    if (L.el) return;
    var layer = L.el = el('section', 'wp-layer');
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'false');
    layer.hidden = true;

    var bar = L.bar = el('header', 'wp-bar');
    bar.appendChild(btn('wp-back', 'Back', function () { back('bar'); }, 'Back (Alt+Left)'));
    L.markEl = el('span', 'wp-mark');
    bar.appendChild(L.markEl);
    L.titleEl = el('span', 'wp-title');
    L.titleEl.dir = 'auto';   // an Arabic or Hebrew title reads in its own direction, punctuation where it belongs
    bar.appendChild(L.titleEl);
    L.noteEl = el('span', 'wp-note');
    L.noteEl.setAttribute('role', 'status');
    bar.appendChild(L.noteEl);
    bar.appendChild(el('span', 'wp-grow'));
    bar.appendChild(btn('wp-tab', 'Open in a tab', function () { toTab(); }));
    L.edgeBtn = btn('wp-edge', 'Open in Edge', function (b) { toEdge(focused(), b); });
    L.edgeBtn.hidden = true;
    bar.appendChild(L.edgeBtn);
    X('bar', bar);
    MV('bar', bar);
    bar.appendChild(btn('wp-close', '✕', function () { close('Close'); }, 'Close the player (Esc)'));
    layer.appendChild(bar);

    L.grid = el('div', 'wp-grid');
    layer.appendChild(L.grid);
    MV('build', layer);

    var sh = L.sheetEl = el('div', 'wp-sheet');
    sh.hidden = true;
    var panel = el('div', 'wp-sheet-panel');
    var head = el('div', 'wp-sheet-head');
    head.appendChild(el('span', 'wp-sheet-host'));
    head.appendChild(el('span', 'wp-grow'));
    L.sheetTabBtn = btn('wp-sheet-tab', 'Open in a tab', function (b) {
      if (!L.sheet || !api || typeof api.sheetToTab !== 'function') return;
      b.disabled = true;
      api.sheetToTab(L.sheet.id).then(function (r) {
        b.disabled = false;
        if (!r || !r.ok) toast('Couldn’t open a tab: ' + ((r && r.reason) || 'no answer'), true);
      }, function (err) { b.disabled = false; toast('Couldn’t open a tab: ' + ((err && err.message) || err), true); });
    }, 'Open this page in a normal Quartz tab');
    head.appendChild(L.sheetTabBtn);
    L.sheetCloseBtn = btn('wp-sheet-close', 'Close', function () { if (L.sheet && api) api.sheetClose(L.sheet.id, 'Close'); }, 'Close sign-in');
    head.appendChild(L.sheetCloseBtn);
    panel.appendChild(head);
    panel.appendChild(el('div', 'wp-sheet-hole'));
    sh.appendChild(panel);
    layer.appendChild(sh);

    // The mouse's back button over the bar or a tile's own furniture (the guest's
    // presses come from main's app-command): the same Back.
    layer.addEventListener('mouseup', function (e) { if (e.button === 3) { e.preventDefault(); back('mouse'); } });
    // A video that leaves fullscreen hands the slot back its bar.
    layer.addEventListener('transitionend', function (e) { if (e.target === layer && !L.open) teardownDom(); });
  }

  function host() { return document.getElementById('views'); }

  /** Lay the layer over the owner tab's view: same box, and hidden when that tab is. */
  function place() {
    if (!L.el || !L.open) return;
    var owner = L.owner;
    var tabsNow = liveTabs();
    if (!owner || tabsNow.indexOf(owner) === -1 || !isWatchTab(owner)) { close('its Watch tab closed'); return; }
    var v = owner.viewEl;
    var views = host();
    var fs = !!L.fsSlot;
    if (!v || !views) return;
    var r = v.getBoundingClientRect();
    var hr = views.getBoundingClientRect();
    var shown = fs || (r.width > 2 && r.height > 2 && activeId() === owner.id) || (r.width > 2 && r.height > 2 && isSplitShown(owner));
    L.el.hidden = !shown;
    if (shown && !fs && MV('place', r, hr) === true) { /* the mini-player sits in a corner of the tab */ }
    else if (shown && !fs) {
      L.el.style.left = (r.left - hr.left) + 'px';
      L.el.style.top = (r.top - hr.top) + 'px';
      L.el.style.width = r.width + 'px';
      L.el.style.height = r.height + 'px';
    } else if (fs) {
      // The video's fullscreen: .wp-fs is position:fixed; inset:0, which the tab-sized
      // inline box would otherwise override (the layer stayed the Watch tab's size).
      L.el.style.left = L.el.style.top = L.el.style.width = L.el.style.height = '';
    }
    placeSheet();
  }
  function isSplitShown(owner) { try { return !!owner.viewEl && owner.viewEl.style.display !== 'none' && owner.viewEl.offsetParent !== null; } catch (e) { return false; } }

  function watchOwner(owner) {
    unwatchOwner();
    L.owner = owner;
    var v = owner && owner.viewEl;
    if (!v) return;
    if (window.ResizeObserver) { L.ro = new ResizeObserver(function () { place(); }); L.ro.observe(v); }
    L.mo = new MutationObserver(function () { place(); });
    L.mo.observe(v, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    if (v.parentNode) L.mo.observe(v.parentNode, { childList: true });
  }
  function unwatchOwner() {
    if (L.ro) { L.ro.disconnect(); L.ro = null; }
    if (L.mo) { L.mo.disconnect(); L.mo = null; }
  }

  /* --------------------------------------------------------------- slots */

  function focused() { return L.slots[L.focus] || L.slots[0] || null; }

  function makeSlot(url, o) {
    var s = {
      id: ++L.seq, url: url, service: o.service || (H ? H.serviceFor(url) : '') || '', title: o.title || '', titleFor: url,
      view: null, wcId: null, tile: el('div', 'wp-tile'), state: el('div', 'wp-state'),
      blocked: o.blocked || '', refused: '', fs: false,
      fallback: o.fallback || '', item: o.item || null, purpose: o.purpose || '', pnote: o.note || '', multi: !!o.multi
    };
    // watch-player-yt.js: a YouTube video in a multiview tile plays as the embed.
    url = X('slotUrl', s, url) || url;
    s.url = url;
    s.state.hidden = true;
    s.tile.appendChild(s.state);
    s.tile._slot = s;
    MV('slot', s, o);
    if (s.blocked) showState(s, 'blocked', s.blocked);
    else attachView(s, url);
    return s;
  }

  function attachView(s, url) {
    var v = document.createElement('webview');
    // Same as a tab (app.js buildWebview): allowpopups makes Chromium ASK, and main's
    // player handler answers -- in place, a sheet, a tab, or no.
    v.setAttribute('allowpopups', '');
    MV('view', s, v);
    // The YouTube embed refuses to play without a Referer naming the app (watch-player-yt.js).
    var ref = X('referrer', s, url);
    if (ref) v.setAttribute('httpreferrer', ref);
    v.setAttribute('src', url);
    v.className = 'wp-view';
    s.view = v;
    v.addEventListener('dom-ready', function () {
      if (s.view !== v) return;
      var first = s.wcId === null;
      try { s.wcId = v.getWebContentsId(); } catch (e) { s.wcId = null; }
      if (first && api && s.wcId !== null) {
        api.adopt(s.wcId, s.service, originOf(s.url)).then(function (r) {
          if (!r || !r.ok) note('The player could not be guarded: ' + ((r && r.reason) || 'no answer'));
        }, function (err) { note('The player could not be guarded: ' + ((err && err.message) || err)); });
      }
      if (first && L.open && s === focused()) { try { v.focus(); } catch (e) { /* not focusable yet */ } }
    });
    // s.pageTitle: the page's latest own title (a new document starts without one). The bar falls back to it
    // when the slot has no title of its own, so a move in the page that keeps its title (a &t= jump sends no
    // page-title-updated) no longer drops the bar to the bare "YouTube".
    v.addEventListener('did-navigate', function (e) { if (s.view === v) { s.url = e.url || s.url; s.pageTitle = ''; s.eme = null; dropMovedTitle(s); syncBar(); trackPlayer(s, s.url); } });
    v.addEventListener('did-navigate-in-page', function (e) { if (s.view === v && e.isMainFrame) { s.url = e.url || s.url; dropMovedTitle(s); syncBar(); trackPlayer(s, s.url); } });
    // A video that started is what tells "his own Back" from "the service's player gave up" (trackPlayer).
    v.addEventListener('media-started-playing', function () { if (s.view === v && s.pl) s.pl.played = true; });
    v.addEventListener('page-title-updated', function (e) { if (s.view === v) { s.pageTitle = String((e && e.title) || ''); if (!s.title) syncBar(); } });
    v.addEventListener('did-fail-load', function (e) {
      if (s.view !== v || !e.isMainFrame || e.errorCode === -3) return;   // -3: aborted (a redirect, a stop)
      showState(s, 'failed', svcName(s.service) + '’s page didn’t load: ' + (e.errorDescription || ('error ' + e.errorCode)));
    });
    v.addEventListener('enter-html-full-screen', function () { if (s.view === v) enterFs(s); });
    v.addEventListener('leave-html-full-screen', function () { if (s.view === v) leaveFs(s); });
    v.addEventListener('render-process-gone', function (e) {
      if (s.view !== v) return;
      var why = e && e.details && e.details.reason;
      if (why === 'clean-exit') return;
      showState(s, 'failed', 'The player’s page stopped' + (why ? ' (' + why + ')' : '') + '.');
    });
    s.tile.insertBefore(v, s.state);
    X('attach', s, v);
    MV('attach', s, v);
  }

  function destroySlot(s) {
    X('destroy', s);
    MV('destroy', s);
    // The layer's own fullscreen state goes with the slot. Its leave-html-full-screen never comes once the view
    // is gone (that listener checks s.view === v), so a close from fullscreen (the mouse's Back on the first
    // page, the Watch tab closing) used to leave L.fsSlot and .wp-fs behind: the NEXT title opened as a black,
    // bar-less window-filling layer (its tile isn't .is-fs) and Esc did nothing (r62-playview). leaveFs is the
    // one way out of it (the page's fullscreen, the tile, the layer, Esc's grace, the layout); the inline copy
    // here missed the window's fullscreen when s.fs was already false, and a multiview X kept the old layout.
    if (L.fsSlot === s) {
      try { leaveFs(s); } catch (e) { L.fsSlot = null; if (L.el) L.el.classList.remove('wp-fs'); }
    } else if (s.fs) { try { setPageFullscreen(false); } catch (e) { /* app.js gone */ } }
    s.fs = false;
    if (s.view) {
      var v = s.view;
      s.view = null;
      // Removing a <webview> destroys its guest webContents (and its process when alone).
      try { v.remove(); } catch (e) { /* Electron's guestInstanceId note: harmless */ }
    }
    if (s.tile && s.tile.parentNode) s.tile.parentNode.removeChild(s.tile);
  }

  /*
   * Disney+ and Hulu can refuse a title without a word: the page reaches the service's player address
   * (Disney+ /play/<id>) and goes straight back to the home page, again on every Play. Nothing reaches the
   * DRM bar then, because no licence was ever asked for. Lumen says it instead: the state over the tile,
   * with Open in Edge (to the player address, so Edge starts the title itself) and a way back to the
   * service's page, plus one quartz.log line. watch/playurl.js bounced() decides; a video that started,
   * or the layer's own Back, is never a refusal.
   */
  function trackPlayer(s, url) {
    var P = window.LumenPlay;
    if (!P || typeof P.inPlayer !== 'function' || typeof P.bounced !== 'function') return;
    if (P.inPlayer(s.service, url)) {
      var path = pathOf(url);
      if (!s.pl || s.pl.path !== path) s.pl = { url: url, path: path, at: Date.now(), played: false };
      s.bounced = null;
      return;
    }
    var pl = s.pl;
    if (!pl) return;
    s.pl = null;
    var why = P.bounced({ service: s.service, from: pl.url, to: url, ms: Date.now() - pl.at, played: pl.played,
      user: Date.now() - (s.backAt || 0) < 3000, eme: s.eme || null });
    if (!why) return;
    s.bounced = { from: pl.url, why: why };
    showState(s, 'refused', why);
    if (api && typeof api.report === 'function') api.report('bounce', why, pl.url).catch(function () { /* the line is extra; the state is on screen */ });
  }
  function pathOf(url) { try { return new URL(url).pathname; } catch (e) { return String(url || ''); } }

  function showState(s, kind, text) {
    var st = s.state;
    st.replaceChildren();
    st.setAttribute('data-kind', kind);
    var box = el('div', 'wp-state-box');
    box.appendChild(el('p', 'wp-state-text', text));
    var acts = el('div', 'wp-state-acts');
    var drmSvc = !!(svcInfo(s.service) && svcInfo(s.service).drm);
    if (kind === 'blocked' || kind === 'refused' || drmSvc) acts.appendChild(btn('wp-primary', 'Open in Edge', function (b) { toEdge(s, b); }));
    // Try again: the state AND its has-state class go (that class hides the view: leaving it on showed a blank tile
    // over a page that had reloaded fine). A view that can't reload any more says so instead of going quiet.
    if (kind === 'failed' && s.view) acts.appendChild(btn('', 'Try again', function () {
      if (!s.view) { showState(s, 'failed', 'The player’s page is gone: open the title again, or open it in a tab.'); return; }
      st.hidden = true;
      s.tile.classList.remove('has-state');
      try { s.view.reload(); } catch (e) { showState(s, 'failed', 'The page couldn’t reload: ' + ((e && e.message) || e) + '. Open the title again, or open it in a tab.'); }
    }));
    X('stateActs', s, kind, acts);
    // A player that went back: the service's own page is still there under the state, so he can browse on.
    if (kind === 'refused' && s.bounced && s.view) acts.appendChild(btn('', 'Back to ' + (svcName(s.service) || 'the page'), function () {
      st.hidden = true;
      s.tile.classList.remove('has-state');
    }));
    acts.appendChild(btn('', 'Open in a tab', function () { toTab(s); }));
    box.appendChild(acts);
    st.appendChild(box);
    st.hidden = false;
    s.tile.classList.add('has-state');
    if (kind === 'refused') s.refused = text;
  }

  /* --------------------------------------------------------------- the bar */

  /**
   * The title the slot was opened with names ONE YouTube video. When the page moves on to another
   * one by itself (autoplay, an end-screen card, a link in the description), that title goes, so the
   * bar shows the page's own title from then on instead of the last video's (r62-playview: it kept the
   * first title for every video after it). Other services and pages without a video id keep it as before.
   */
  function dropMovedTitle(s) {
    if (!s.title || s.service !== 'youtube') return;
    var YT = window.WatchPlayerYT;
    if (!YT || typeof YT.videoOf !== 'function') return;
    var was = YT.videoOf(s.titleFor || '', 'youtube');
    if (!was) return;
    var now = YT.videoOf(s.url, 'youtube');
    if (!now || now.id !== was.id) s.title = '';
  }
  function syncBar(pageTitle) {
    var s = focused();
    if (!L.el || !s) return;
    var info = svcInfo(s.service);
    L.markEl.textContent = info ? info.mark : '';
    L.markEl.setAttribute('data-svc', s.service || '');
    L.markEl.title = info ? info.name : '';
    // Without a title of its own, the page's title (not the service's bare name: a move in the page that keeps
    // its title, say a &t= jump, sends no page-title-updated, and the bar used to stay on "YouTube").
    var t = s.title || pageTitle || s.pageTitle || (info ? info.name : hostOf(s.url));
    L.titleEl.textContent = t;
    L.titleEl.title = t;   // a long title ends in an ellipsis: the whole of it on hover
    L.el.setAttribute('aria-label', t + (info ? ' on ' + info.name : '') + ', in ' + NAME);
    L.edgeBtn.hidden = !(info && info.drm);
    X('sync', s);
  }

  function note(text) {
    if (!L.noteEl) return;
    L.noteEl.textContent = text || '';
    clearTimeout(L.noteTimer);
    if (text) L.noteTimer = setTimeout(function () { if (L.noteEl) L.noteEl.textContent = ''; }, 8000);
  }

  /* --------------------------------------------------------------- open / close */

  function ownerTab() {
    var all = liveTabs();
    var act = null;
    for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === activeId()) act = all[i];
    if (isWatchTab(act)) return act;
    var w = null;
    try { w = findWatchTab(); } catch (e) { w = null; }
    if (w) { try { activateTab(w.id); } catch (e) { /* stays where it is */ } return w; }
    try { if (openWatchTab()) { for (var j = 0; j < liveTabs().length; j++) if (isWatchTab(liveTabs()[j])) return liveTabs()[j]; } } catch (e) { /* no Watch tab */ }
    return null;
  }

  /**
   * Show `url` in the layer. o: { service, title, multi, blocked }.
   * Single (the default): the one player, replaced, or moved in place when it is the same service.
   */
  function openInLumen(url, opts) {
    var o = opts || {};
    var u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return false;
    if (!api) {
      // No channel to main (an older preload): a tab, and the reason.
      try { createTab(u, { background: false }); } catch (e) { /* nothing more to do */ }
      toast('Opened in a tab: this window has no channel to the ' + NAME + ' player', true);
      return false;
    }
    var owner = ownerTab();
    if (!owner) { try { createTab(u, { background: false }); } catch (e) { /* nothing */ } toast('Opened in a tab: ' + NAME + ' could not be opened', true); return false; }
    build();
    if (!L.el.parentNode) host().appendChild(L.el);
    if (L.owner !== owner) watchOwner(owner);
    var service = o.service && svcInfo(o.service) ? o.service : (H ? H.serviceFor(u) : '');
    // Multiview: "Add to multiview" (or a pick after the bar's button) adds a tile; it says no itself.
    if (MV('open', u, service, o) === true) return true;
    var one = L.slots.length === 1 ? L.slots[0] : null;
    if (one && !one.blocked && one.view && one.service === service && !o.blocked) {
      // The same service: this page, in place (Back comes back to the last one).
      var from = one.url;   // where the page is now (did-navigate / -in-page keep it), for an in-place move
      one.title = o.title || '';
      one.url = u;
      one.fallback = o.fallback || ''; one.item = o.item || null; one.purpose = o.purpose || ''; one.pnote = o.note || '';
      one.multi = !!o.multi;
      one.refused = '';   // the last title's licence refusal isn't this one's (Open in Edge's log line says it)
      one.titleFor = u;
      one.pageTitle = '';
      u = X('slotUrl', one, u) || u;
      one.url = u;
      X('reuse', one);
      one.state.hidden = true;
      one.tile.classList.remove('has-state');
      // The embed (watch-player-yt.js) needs its Referer on this load too, not only on a new view's src.
      var ref = X('referrer', one, u);
      // YouTube from one watch page to the next (Up next's Play now, a title opened while one plays): YouTube's own
      // in-page move instead of a whole new page (watch-player-yt.js pageMove, r64). It loads the page itself, the
      // way below, when YouTube doesn't take the move, and says why.
      // This open supersedes any move still pending on the slot (its timers and late answers act only while
      // _ytMove is theirs): a move to B whose page hasn't answered must not load B over this title (a channel,
      // the same video again) when its fallback timer fires. pageMove bumps it again for its own move.
      one._ytMove = (one._ytMove || 0) + 1;
      if (X('pageMove', one, from, u, ref) !== true) loadInto(one, u, ref);
    } else {
      clearSlots();
      var s = makeSlot(u, { service: service, title: o.title || '', blocked: o.blocked || '', fallback: o.fallback || '', item: o.item || null, purpose: o.purpose || '', note: o.note || '', multi: !!o.multi });
      L.slots.push(s);
      L.focus = 0;
      L.grid.appendChild(s.tile);
    }
    layout();
    syncBar();
    show();
    X('opened', focused());
    return true;
  }

  /** Load u in a slot's own view (the reuse's load; watch-player-yt.js's move falls back to it). ref: the embed's Referer. */
  function loadInto(s, u, ref) {
    if (!s || !s.view) return;
    // Any load supersedes an in-place move still pending (watch-player-yt.js pageMove): its fallback or its
    // landing check must never load the older video over this page. The move's own fallback lands here too,
    // after it has settled, so the bump costs it nothing.
    s._ytMove = (s._ytMove || 0) + 1;
    if (ref) { try { s.view.setAttribute('httpreferrer', ref); } catch (e) { /* the load carries it */ } }
    try { var pr = ref ? s.view.loadURL(u, { httpReferrer: ref }) : s.view.loadURL(u); if (pr && pr.catch) pr.catch(function () { /* a redirect or a stop: did-fail-load says the rest */ }); } catch (e) { s.view.setAttribute('src', u); }
  }

  function clearSlots() {
    var gone = L.slots.slice();
    L.slots = [];
    for (var i = 0; i < gone.length; i++) destroySlot(gone[i]);
    return gone;
  }

  function layout() {
    L.grid.setAttribute('data-n', String(L.slots.length));
    if (api) api.mode(L.slots.length > 1 ? 'grid' : 'single');
    MV('layout');
  }

  function show() {
    var was = L.open;
    L.open = true;
    L.el.classList.remove('wp-out');
    place();
    if (was) return;
    document.body.classList.add('wp-playing');
    if (reduced()) { L.el.classList.add('wp-in'); return; }
    L.el.classList.remove('wp-in');
    void L.el.offsetWidth;   // start from the "before" state, then spring in
    L.el.classList.add('wp-in');
  }

  /** Close the layer: every view destroyed now, the layer springs out, the service is re-read. */
  function close(why) {
    if (!L.open) return false;
    L.open = false;
    note('');   // a note is about this title ("could not be guarded", an app link stopped): never the next one's
    MV('close', why);
    if (L.sheet && api) { api.sheetClose(L.sheet.id, 'the player closed'); }
    hideSheet();
    var gone = clearSlots();
    var services = [];
    var ids = [];
    for (var i = 0; i < gone.length; i++) {
      if (gone[i].service && services.indexOf(gone[i].service) === -1 && !gone[i].blocked) services.push(gone[i].service);
      if (gone[i].wcId !== null) ids.push(gone[i].wcId);
    }
    L.lastClosed = { wcIds: ids, services: services, why: why || '', asked: null, at: Date.now() };
    var rec = L.lastClosed;
    if (api) {
      api.mode('single');
      api.closed(services).then(function (r) { rec.asked = (r && r.asked) || []; }, function () { rec.asked = []; });
    }
    document.body.classList.remove('wp-playing');
    L.el.classList.remove('wp-in');
    if (reduced() || L.el.hidden) teardownDom();
    else { L.el.classList.add('wp-out'); setTimeout(teardownDom, 300); }   // transitionend's fallback: the close is --m-dur-m-out, 67.5 ms in Lumen's set
    // The keyboard goes back to the rows, where he left them.
    var v = L.owner && L.owner.viewEl;
    if (v) { try { v.focus(); } catch (e) { /* not focusable */ } }
    return true;
  }
  function teardownDom() {
    if (L.open || !L.el) return;
    L.el.classList.remove('wp-out');
    L.el.hidden = true;
    unwatchOwner();
    L.owner = null;
  }

  /** src 'mouse': the mouse's back button (the bar's mouseup, main's app-command). */
  function back(src) {
    if (!L.open) return false;
    // One press of the mouse's back button can arrive twice (the bar's own mouseup and
    // main's app-command): one Back. Only those two are folded together -- the bar's
    // button and Alt+Left pressed quickly are each their own Back.
    if (src === 'mouse') {
      if (Date.now() - (L.lastMouseBackAt || 0) < 300) return true;
      L.lastMouseBackAt = Date.now();
    }
    if (L.sheet && api) { api.sheetClose(L.sheet.id, 'Back'); return true; }
    // Multiview: Back walks the selected tile's own history and never closes the other tiles.
    if (MV('back', src) === true) return true;
    var s = focused();
    var v = s && s.view;
    var can = false;
    try { can = !!(v && v.canGoBack()); } catch (e) { can = false; }
    // test seam (_state().backs): the last few Backs, where each came from, whether the page could go back.
    L.backs = (L.backs || []).slice(-5).concat([{ src: src || 'key', can: can, t: Date.now() % 100000 }]);
    if (can && !(s.state && !s.state.hidden && s.state.getAttribute('data-kind') === 'blocked')) {
      s.backAt = Date.now();   // his own Back out of a player is never "the player went back" (trackPlayer)
      s.state.hidden = true;
      s.tile.classList.remove('has-state');
      try { var gb = v.goBack(); if (gb && gb.catch) gb.catch(function () { /* the page went */ }); return true; } catch (e) { /* close instead */ }
    }
    return close('Back');
  }

  function toTab(s) {
    var slot = s || focused();
    if (!slot) return;
    var url = slot.url;
    if (api) api.escape('Open in a tab', url);
    close('Open in a tab');
    try { createTab(url, { background: false }); } catch (e) { toast('Couldn’t open a tab: ' + ((e && e.message) || e), true); }
  }

  function toEdge(s, b, why) {
    var slot = s || focused();
    var drm = window.api && window.api.drm;
    if (!slot) return;
    if (!drm || typeof drm.openInEdge !== 'function') { toast('Couldn’t open Microsoft Edge: this window has no channel to the browser', true); return; }
    if (b) b.disabled = true;
    // After a player that went back, the page sits on the home page: Edge gets the player address instead.
    var target = slot.bounced && slot.state && !slot.state.hidden ? slot.bounced.from : slot.url;
    if (api) api.escape('Open in Edge' + (why ? ': ' + why : slot.blocked ? ': ' + slot.blocked : (slot.bounced ? ': the player went back' : slot.refused ? ': licence refused' : '')), target);
    drm.openInEdge(target).then(function (r) {
      if (b) b.disabled = false;
      if (r && r.ok) {
        toast('Opened in Microsoft Edge' + (slot.blocked ? ': ' + slot.blocked : ''));
        // Only if the layer still shows THIS title: Edge's answer can come after he closed it and opened another.
        if (L.open && L.slots.length === 1 && L.slots[0] === slot) close('Open in Edge');
      } else toast('Couldn’t open Microsoft Edge' + (r && r.reason ? ': ' + r.reason : ''), true);
    }, function (err) { if (b) b.disabled = false; toast('Couldn’t open Microsoft Edge: ' + ((err && err.message) || err), true); });
  }

  /* --------------------------------------------------------------- fullscreen */

  function enterFs(s) {
    s.fs = true;
    L.fsSlot = s;
    L.el.classList.add('wp-fs');
    s.tile.classList.add('is-fs');
    try { setPageFullscreen(true); } catch (e) { /* app.js gone */ }
    place();
  }
  function leaveFs(s) {
    s.fs = false;
    if (L.fsSlot === s) L.fsSlot = null;
    L.fsLeftAt = Date.now();
    s.tile.classList.remove('is-fs');
    if (!L.fsSlot) L.el.classList.remove('wp-fs');
    try { setPageFullscreen(false); } catch (e) { /* app.js gone */ }
    place();
  }
  function exitFs() {
    var s = L.fsSlot;
    if (!s) return false;
    if (!s.view) {
      // A fullscreen slot without a page (it can't send its leave event): drop the state here, so Esc
      // goes on to its next job instead of being swallowed by a fullscreen that isn't there.
      L.fsSlot = null;
      s.fs = false;
      if (s.tile) s.tile.classList.remove('is-fs');
      if (L.el) L.el.classList.remove('wp-fs');
      try { setPageFullscreen(false); } catch (e) { /* app.js gone */ }
      place();
      return false;
    }
    try { s.view.executeJavaScript('document.fullscreenElement ? document.exitFullscreen().then(function () { return 1; }, function () { return 0; }) : 0', true).catch(function () { /* the leave event will tell */ }); } catch (e) { /* the leave event will tell */ }
    return true;
  }

  /* --------------------------------------------------------------- sign-in sheet */

  function onSheet(m) {
    if (!m || !L.open) return;
    var mine = false;
    for (var i = 0; i < L.slots.length; i++) if (L.slots[i].wcId === m.opener) mine = true;
    if (!mine) return;
    if (!L.sheet || L.sheet.id !== m.id) L.sheet = { id: m.id, host: '', title: '', kind: 'signin', error: '' };
    if (m.kind === 'page' || m.kind === 'signin') L.sheet.kind = m.kind;
    if (m.fresh) { L.sheet.title = ''; L.sheet.error = ''; }
    if (m.host) L.sheet.host = m.host;
    if (m.title) L.sheet.title = m.title;
    if (typeof m.error === 'string') L.sheet.error = m.error;
    var page = L.sheet.kind === 'page';
    var label = L.sheetEl.querySelector('.wp-sheet-host');
    label.textContent = (L.sheet.title ? L.sheet.title + ' · ' : '') + (L.sheet.host || (page ? 'Another site' : 'Sign in')) +
      (L.sheet.error ? ' · didn’t load: ' + L.sheet.error : '');
    L.sheetEl.setAttribute('data-kind', L.sheet.kind);
    L.sheetCloseBtn.setAttribute('aria-label', page ? 'Close this page and go back to the player' : 'Close sign-in');
    L.sheetCloseBtn.title = L.sheetCloseBtn.getAttribute('aria-label') + ' (Esc)';
    L.sheetEl.hidden = false;
    placeSheet();
  }
  function hideSheet() {
    if (L.sheetEl) L.sheetEl.hidden = true;
    L.sheet = null;
  }
  function placeSheet() {
    if (!L.sheet || !api) return;
    var hole = L.sheetEl.querySelector('.wp-sheet-hole');
    var r = hole.getBoundingClientRect();
    var visible = L.open && !L.el.hidden && !L.sheetEl.hidden && r.width > 10 && r.height > 10;
    api.sheetRect(L.sheet.id, visible ? { x: r.left, y: r.top, width: r.width, height: r.height } : null);
  }

  /* --------------------------------------------------------------- keys and commands */

  var MEDIA_JS = '(function (cmd) {' +
    ' var vs = [].slice.call(document.querySelectorAll("video")).sort(function (a, b) { return (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight); });' +
    ' var v = vs[0]; if (!v) return "no video";' +
    ' if (cmd === "pause" || cmd === "stop" || (cmd === "toggle" && !v.paused)) { v.pause(); return "paused"; }' +
    ' var p = v.play(); if (p && p.catch) p.catch(function () {}); return "playing"; })';

  function media(cmd) {
    var s = focused();
    if (!L.open || !s || !s.view) return false;
    var c = /play-pause|PlayPause/.test(cmd) ? 'toggle' : (/pause|Pause/.test(cmd) ? 'pause' : (/stop|Stop/.test(cmd) ? 'stop' : (/play|Play$/.test(cmd) ? 'play' : '')));
    if (!c) return false;
    try { s.view.executeJavaScript(MEDIA_JS + '(' + JSON.stringify(c) + ')', true).then(function (r) { L.lastMedia = r; }, function () { /* the page went */ }); } catch (e) { return false; }
    return true;
  }

  /** app.js runShortcut: true when the layer took the action. */
  function takeShortcut(id) {
    if (!L.open || !L.el || L.el.hidden) return false;
    var mv = MV('shortcut', id);
    if (mv === true || mv === false) return mv;
    if (id === 'escape') {
      // Lumen play bar hook: Esc closes its menu, then the service's own menu, then Lumen's full window.
      if (window.LumenPlayerBar && typeof window.LumenPlayerBar.shortcut === 'function' && window.LumenPlayerBar.shortcut(id) === true) return true;
      if (L.fsSlot && exitFs()) return true;
      if (Date.now() - L.fsLeftAt < ESC_AFTER_FS_MS) return true;
      if (L.sheet && api) { api.sheetClose(L.sheet.id, 'Esc'); return true; }
      // The Lumen view's own open things (the Unsubscribe confirm, the Save list) close before the player does:
      // Esc on "Unsubscribe from X?" used to close the whole video.
      if (X('escape', focused()) === true) return true;
      close('Esc');
      return true;
    }
    if (id === 'back') { back(); return true; }
    return false;
  }

  function onCommand(m) {
    if (!m || !L.open) return;
    L.lastCommand = String(m.cmd || '').slice(0, 40);   // test seam: the last command main sent
    if (m.cmd === 'back') { if (!L.el.hidden && MV('shortcut', 'back') !== false) back('mouse'); return; }
    if (/^media-|^key-Media/.test(String(m.cmd))) media(String(m.cmd));
  }

  function onKeyFromGuest(m) { if (m && L.open) MV('key', m); }

  function wire() {
    if (!api) return;
    api.on('play', function (m) {
      if (!m || typeof m.url !== 'string') return;
      openInLumen(m.url, { service: m.service, title: m.title, multi: !!m.multi, blocked: m.blocked || '', fallback: m.fallback || '', item: m.item || null, purpose: m.purpose || '', note: m.note || '' });
    });
    api.on('command', onCommand);
    api.on('key', onKeyFromGuest);
    api.on('left', function (m) {
      if (m && L.open && m.to === 'edge') { toast('Opened ' + (svcName(m.service) || m.host || 'that title') + ' in Microsoft Edge' + (m.reason ? ': ' + m.reason : ''), true); return; }
      if (m && L.open) toast('Opened ' + (m.host || 'that page') + ' in a new tab: it isn’t part of ' + (svcName(slotOf(m.wcId) && slotOf(m.wcId).service) || 'this service'));
    });
    api.on('blocked', function (m) { if (m && L.open) note('Stayed in ' + NAME + ': the page tried to open an app (' + (m.scheme || 'app') + ':)'); });
    api.on('gone', function (m) {
      var s = m && slotOf(m.wcId);
      if (s && s.view && L.open) showState(s, 'failed', 'The player’s page closed.');
    });
    api.on('sheet', onSheet);
    api.on('sheet-gone', function (m) { if (m && L.sheet && L.sheet.id === m.id) hideSheet(); });
    var drm = window.api && window.api.drm;
    if (drm && typeof drm.onSignal === 'function') {
      drm.onSignal(function (sig) {
        var s = sig && slotOf(sig.wcId);
        if (!s) return;
        // What the page did with Widevine, for the words when its player goes back without playing (trackPlayer).
        var e = s.eme || (s.eme = { granted: false, refused: false, encrypted: false, licence: '' });
        if (sig.kind === 'request') { if (sig.granted === true) e.granted = true; else e.refused = true; }
        else if (sig.kind === 'encrypted') e.encrypted = true;
        if (sig.kind !== 'licence') return;
        var Sites = window.DrmSites;
        if (Sites && typeof Sites.isLicenceOutcome === 'function' && !Sites.isLicenceOutcome(sig.outcome)) return;
        if (!e.licence) e.licence = String(sig.outcome || '').slice(0, 40);
        showState(s, 'refused', (svcName(s.service) || 'The service') + ' refused to license this video inside Quartz' + (sig.outcome ? ' (' + String(sig.outcome).replace(/-/g, ' ') + ')' : '') + '. Edge can play it.');
      });
    }
    window.addEventListener('resize', function () { place(); });
  }
  function slotOf(wcId) {
    for (var i = 0; i < L.slots.length; i++) if (L.slots[i].wcId === wcId) return L.slots[i];
    return null;
  }

  wire();

  window.openInLumen = openInLumen;
  window.WatchPlayer = {
    open: openInLumen,
    close: close,
    back: back,
    handleShortcut: takeShortcut,
    media: media,
    isOpen: function () { return L.open; },
    // test seam: what the layer shows
    _state: function () {
      return {
        open: L.open,
        hidden: L.el ? L.el.hidden : true,
        n: L.slots.length,
        focus: L.focus,
        fs: !!L.fsSlot, fsLeftAt: L.fsLeftAt,
        sheet: L.sheet ? { id: L.sheet.id, host: L.sheet.host, kind: L.sheet.kind, error: L.sheet.error, shown: !L.sheetEl.hidden } : null,
        title: L.titleEl ? L.titleEl.textContent : '',
        mark: L.markEl ? L.markEl.textContent : '',
        note: L.noteEl ? L.noteEl.textContent : '',
        edge: L.edgeBtn ? !L.edgeBtn.hidden : false,
        lastClosed: L.lastClosed,
        extras: X('state') || null,
        multi: MV('state') || null,
        lastMedia: L.lastMedia || '',
        lastCommand: L.lastCommand || '',
        backs: L.backs || [],
        slots: L.slots.map(function (s) {
          return { wcId: s.wcId, url: s.url, service: s.service, title: s.title, blocked: s.blocked, refused: s.refused,
            bounced: s.bounced ? s.bounced.from : '', inPlayer: !!s.pl, eme: s.eme || null,
            state: s.state.hidden ? '' : s.state.getAttribute('data-kind'), stateText: s.state.hidden ? '' : s.state.textContent, view: !!s.view };
        })
      };
    }
  };
})();
