/* ============================================================
   watch.js -- Watch, Quartz's streaming hub (watch.html).

   A bundled, preload-less file:// guest. It talks to main
   (watch-main.js) the way search.html does: console lines out,
   window.__apply* calls in.

     out  quartz-watch:hello    {"visible":bool}         on load (and a Retry)
          quartz-watch:visible  {"visible":bool}         whenever "in sight" changes
          quartz-watch:refresh  {"service":"youtube"|null} Retry / Read now
          quartz-watch:open     {"url":"https://..."}     a card, a cell, a button
          quartz-watch:signin   {"service":"disney"}      Sign in
          quartz-watch:search   {"q":"bluey","seq":3}     debounced 300 ms
          quartz-watch:settings {}                        Settings > Watch (app.js)
          quartz-watch:preview  {"title":"..","tv":false,"seq":4}  the hovered title's trailer (TMDB)
     in   window.__applyWatch(snapshot)
          window.__applyWatchSearch(answer)               stale seq = ignored
          window.__applyWatchResult({ action, ok, how, reason })
          window.__applyWatchPreview({ seq, state, reason, videoId })  a TMDB trailer for the hover preview
          window.__watchFront(bool)                       app.js: is this tab on screen
     e2e  window.__watchVisible()                         read-only: what main was told

   Layout ("Lens"): the stage at the top shows the title the lens is
   on; the rows move through one still band on the shared spring;
   the far layer is that title's still, drawn once into a tiny
   pre-blurred canvas and cross-faded. Search swaps all of that for
   a where-to-watch grid.

   Rules this file keeps:
   - Cache first: the first snapshot draws at once; before it, a
     still skeleton. A partial or odd snapshot never throws: every
     field is checked and cleaned (normalize*).
   - Every text goes in with textContent; images and links are
     https only; a click never navigates this page, it asks main.
   - Failures are per service and always in words (strip, row
     heads, the stage, the grid); one failing service never blanks
     the page; its cached rows stay, dimmed, "as of 3 h ago".
   - Nothing moves at rest: no infinite animation, one minute timer
     (stopped while out of sight: hidden, or a background tab) for the
     "3 min ago" words.
   ============================================================ */
(function () {
  'use strict';

  var Shape = window.WatchShape || null;
  var Merge = window.WatchMerge || null;

  /* The stills come from i.ytimg.com. Its connection (DNS, TCP, TLS) is opened now, while this page
     parses, says hello and waits for its rows, instead of when the first tile asks (r64). A hint
     only: nothing is fetched, and a page with no YouTube rows just lets the idle socket close. */
  try {
    var pc = document.createElement('link');
    pc.rel = 'preconnect';
    pc.href = 'https://i.ytimg.com';
    (document.head || document.documentElement).appendChild(pc);
  } catch (err) { /* a hint: nothing to say if it cannot be given */ }

  var LINE = 'quartz-watch:';
  var SEARCH_DEBOUNCE_MS = 300;
  var SEARCH_MIN_CHARS = 2;     // a shorter query searches his own rows only, never YouTube
  var BOOT_TIMEOUT_MS = 5000;   // no first answer from Quartz by then: say so, with a Retry
  // no word from the chrome on front/back by then (an older Quartz): in front. Not 3 s: Quartz's word
  // comes at dom-ready, after this page's boot, and on a loaded machine that took longer than 3 s, so a
  // Watch tab moved to the background before dom-ready claimed "visible" and main ran due reads
  // (watch-e2e "reads nothing for 5 s": hello:false visible:true visible:false).
  var FRONT_WAIT_MS = 10000;
  var HOVER_MS = 140;
  var WHEEL_GAP_MS = 380;
  var STAGE_SWAP_MS = 60;      // the stage's leave (watch.css .stage.out: --m-dur-s-out, 54 ms in Lumen's set) plus a margin
  var WASH_DELAY_MS = 220;
  var TOAST_MS = 4200;
  var TOAST_MAX = 3;
  var TICK_MS = 60 * 1000;
  var READ_LIMIT_GRACE_MS = 15 * 1000;   // the header's own limit: main's read limit plus this (main ends a read at its limit)
  var READ_LIMIT_FALLBACK_MS = 90 * 1000; // an older main that sends no limit
  var STATES = ['ok', 'signed-out', 'error', 'off', 'never'];
  var KIND_WORD = { resume: 'Continue watching', rec: 'Recommended', watchlist: 'On your watchlist', live: 'Live now', upcoming: 'Upcoming', replay: 'Replay', search: 'Video' };

  var reduceMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reduced() { return !!(reduceMq && reduceMq.matches); }

  /* ---------------------------------------------------------------- state */

  var S = {
    ready: false,
    pending: null,          // a snapshot that arrived before the DOM
    snap: null,
    skew: 0,                // main's clock minus ours
    model: [],              // the lens rows
    rowEls: [],
    cur: 0,
    curKey: '',
    pick: {},               // row key -> the card key the lens remembers
    x: {},                  // row key -> track offset
    stageKey: '',
    stageSig: '',
    stageTimer: 0,
    stageIt: null,          // the item / ESPN event the stage shows (the hover preview reads it)
    stageEv: null,
    pvOn: false,            // main said the hover preview may play (snapshot.preview.on)
    pvMock: false,          // ... from the test mock's origin (a --test-profile instance only)
    hoverTimer: 0,
    wheelAt: 0,
    q: '',
    seq: 0,
    sentSeq: -1,
    answer: null,
    searchTimer: 0,
    resultsRaf: 0,
    gridPos: null,          // { r, c } of the grid's tab stop
    popFor: '',
    popFrom: null,
    // a press on the strip / popover holds their redraw until its click has run (watch/presshold.js)
    hold: window.LumenPressHold ? window.LumenPressHold.create({ later: function (fn, ms) { return setTimeout(fn, ms); }, cancel: function (h) { clearTimeout(h); } })
      : { press: function () { }, release: function () { }, draw: function (fn) { fn(); return true; }, held: function () { return false; } },
    tickTimer: 0,
    bootTimer: 0,
    failure: null,          // { title, why } on screen now
    failEl: null,
    answered: false,        // any answer from Quartz since the page loaded
    pendingFail: '',        // a failure that arrived before the DOM
    resizeQueued: false,
    front: null,            // the chrome's word: this tab is on screen (true) / behind another (false); null = not told yet
    frontTimer: 0,
    freshTimer: 0,          // the header's read-limit check (renderFresh)
    busySeen: null,         // { id, at }: the read in flight as this page first saw it
    told: null,             // "in sight" as main last heard it (hello / visible); null before the first hello
    said: []                // the last few of those lines, for the e2e (__watchVisible)
  };
  var $ = {};

  /* ---------------------------------------------------------- the protocol */

  function send(verb, msg) {
    var json = '{}';
    try { json = JSON.stringify(msg || {}); } catch (err) { json = '{}'; }
    try { console.log(LINE + verb + ' ' + json); } catch (err) { /* nothing to tell */ }
  }

  window.__applyWatch = function (raw) {
    S.answered = true;
    clearTimeout(S.bootTimer);
    S.bootTimer = 0;
    // Quartz's side could not build an update: say why, never keep a silent skeleton.
    if (raw && typeof raw === 'object' && typeof raw.fatal === 'string' && raw.fatal) {
      var why = cleanText(raw.fatal, 300);
      if (!S.ready) { S.pendingFail = why; return; }
      showFailure('Lumen couldn’t load its saved rows', why);
      return;
    }
    // the hover preview's word from main (snapshot.preview): OFF until a snapshot says on, so a
    // --test-profile instance (main says off, or mock) never loads a real embed; a snapshot without
    // the field (a test's own fixture) keeps the last word
    if (raw && typeof raw === 'object' && raw.preview && typeof raw.preview === 'object') {
      S.pvOn = raw.preview.on === true;
      S.pvMock = raw.preview.mock === true;
      if (!S.pvOn) previewStop();
      if (window.WatchTilePreview) window.WatchTilePreview.setMode(raw.preview);   // the tile previews' word too
    }
    var snap;
    try { snap = normalize(raw); } catch (err) {
      if (S.ready) showFailure('Lumen couldn’t read an update from Quartz', (err && err.message) || String(err));
      else S.pendingFail = (err && err.message) || String(err);
      return;
    }
    if (!S.ready) { S.pending = snap; return; }
    try { applySnapshot(snap); clearFailure(); } catch (err) {
      var msg = (err && err.message) || String(err);
      try { console.error('Lumen could not draw this update: ' + msg); } catch (e) { /* ignore */ }
      showFailure('Lumen couldn’t draw the latest update', msg);
    }
  };

  window.__applyWatchSearch = function (raw) {
    if (!raw || typeof raw !== 'object' || !S.ready) return;
    if (raw.seq !== S.sentSeq || !S.q) return;     // an answer to a question no longer asked
    try { S.answer = normalizeAnswer(raw); renderResults(); } catch (err) {
      toast('Couldn’t show these search results: ' + cleanText((err && err.message) || String(err), 160), { err: true });
    }
  };

  /* No silent failures: when Quartz does not answer, or an update cannot be read or drawn, the
     page says so with the reason and a Retry (which asks Quartz for everything again). Before
     the first update it replaces the boot skeleton; after it, a banner sits over what was drawn. */
  function sayHello() {
    clearTimeout(S.bootTimer);
    S.bootTimer = setTimeout(function () {
      S.bootTimer = 0;
      if (S.answered) return;
      showFailure('Quartz didn’t answer', 'Lumen asked Quartz for your rows ' + Math.round(BOOT_TIMEOUT_MS / 1000) +
        ' seconds ago and heard nothing back. Lumen may have failed to start; Quartz’s log says why.');
    }, BOOT_TIMEOUT_MS);
    // An older Quartz never says front or back: after FRONT_WAIT_MS the tab counts as in front.
    if (S.front === null && !S.frontTimer) {
      S.frontTimer = setTimeout(function () {
        S.frontTimer = 0;
        if (S.front !== null) return;
        S.front = true;
        sightChanged();
      }, FRONT_WAIT_MS);
    }
    tellSight('hello');
  }

  /* In sight = Quartz may read for this page. document.hidden alone is not enough: Quartz hides
     a background tab with display:none, and that <webview>'s guest still says "visible" (it
     only turns hidden while the whole window is minimised). So the chrome tells the page
     whether its tab is on screen (app.js syncWatchFront: the tab in front, or either half of
     the pair in front) and the page folds that into its own hidden flag.

     Until the chrome has spoken the page does NOT claim to be in sight: main queues every due
     read on a visible hello and runs the queue whatever the page says next, so a Watch tab
     restored in the background must say "not visible" in its hello. The cache still draws at
     once (main answers every hello with its snapshot); the chrome's word comes right after
     dom-ready, and an older chrome that never speaks counts as "in front" after FRONT_WAIT_MS. */
  function inSight() { return !document.hidden && S.front === true; }

  /** hello always goes; visible only when the answer changed since main last heard it. */
  function tellSight(verb) {
    var v = inSight();
    if (verb !== 'hello' && v === S.told) return;
    S.told = v;
    S.said.push({ verb: verb, visible: v, at: Date.now() });
    if (S.said.length > 20) S.said.shift();
    send(verb, { visible: v });
  }

  /** The window was minimised / shown, or the chrome moved this tab: tell main, and run the
      minute timer only while the page is in sight. Before the first hello: hello carries it. */
  function sightChanged() {
    if (document.hidden || S.front === false) previewStop();   // nothing plays out of sight
    if (window.WatchTilePreview) window.WatchTilePreview.check();
    if (S.told === null) return;
    var was = S.told;
    tellSight('visible');
    if (S.told === was) return;
    if (!S.told) { clearTimeout(S.tickTimer); S.tickTimer = 0; }
    else { refreshAgo(); scheduleTick(); }
  }

  window.__watchFront = function (on) {
    S.front = on !== false;
    clearTimeout(S.frontTimer);
    S.frontTimer = 0;
    try { sightChanged(); } catch (err) { /* the page keeps what it showed; main was told first */ }
  };

  /** Read-only, for the e2e: what main was last told, and why. */
  window.__watchVisible = function () {
    return {
      visible: S.told === true, front: S.front, hidden: !!document.hidden,
      said: S.said.map(function (x) { return { verb: x.verb, visible: x.visible, at: x.at }; })
    };
  };
  function retryHello() {
    clearFailure();
    S.answered = false;
    if (!S.snap) renderBoot();
    sayHello();
  }
  function showFailure(title, why) {
    S.failure = { title: title, why: cleanText(why, 300) };
    if (!S.ready) return;
    if (!S.snap) {
      $.stack.replaceChildren();
      S.rowEls = [];
      S.model = [];
      document.body.classList.add('is-empty');
      renderStrip();
      showStageSpecial('failed');
      return;
    }
    var b = S.failEl;
    if (!b) {
      b = S.failEl = el('div', 'failbar');
      b.setAttribute('role', 'alert');
    }
    b.replaceChildren();
    b.appendChild(el('span', 'dot err'));
    var g = el('span', 'grow');
    g.appendChild(el('b', '', S.failure.title));
    if (S.failure.why) { g.appendChild(document.createTextNode(' ')); g.appendChild(el('span', 'why', S.failure.why)); }
    b.appendChild(g);
    b.appendChild(button('btn sm', 'Retry', retryHello));
    if (!b.parentNode) document.body.appendChild(b);
  }
  function clearFailure() {
    if (!S.failure) return;
    S.failure = null;
    if (S.failEl && S.failEl.parentNode) S.failEl.parentNode.removeChild(S.failEl);
  }

  window.__applyWatchResult = function (raw) {
    if (!raw || typeof raw !== 'object' || !S.ready) return;
    var reason = cleanText(raw.reason, 300);
    var ok = raw.ok === true;
    switch (raw.action) {
      case 'open':
        // why: the reason it went to Edge at all (no Widevine, not signed, or the person's rule).
        var why = cleanText(raw.why, 200);
        if (ok) { if (raw.how === 'edge') toast('Opened in Microsoft Edge' + (why ? ': ' + why : '')); }
        else toast((raw.how === 'edge' ? "Couldn't open Microsoft Edge" : "Couldn't open that title") + (reason ? ': ' + reason : '') +
          (raw.how === 'edge' && why ? '. Quartz itself can’t play it: ' + why : ''), { err: true });
        break;
      case 'signin':
        if (!ok) toast("Couldn't open the sign-in page" + (reason ? ': ' + reason : ''), { err: true });
        break;
      case 'forget':
        if (ok) toast('Cleared everything Lumen had read');
        else toast("Couldn't clear what Lumen had read" + (reason ? ': ' + reason : ''), { err: true });
        break;
      default: break;
    }
  };

  /* --------------------------------------------------------------- helpers */

  function nowMs() { return Date.now() + S.skew; }
  function num(v) { return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function capFirst(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function cleanText(v, max) {
    if (Shape && typeof Shape.cleanText === 'function') return Shape.cleanText(v, max || 200);
    if (typeof v === 'number' && isFinite(v)) v = String(v);
    if (typeof v !== 'string') return '';
    return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
  }
  function https(v) {
    if (Shape && typeof Shape.cleanHttps === 'function') return Shape.cleanHttps(v);
    if (typeof v !== 'string') return '';
    try { var u = new URL(v); return u.protocol === 'https:' ? u.href : ''; } catch (err) { return ''; }
  }
  function fold(s) {
    if (Merge && typeof Merge.fold === 'function') return Merge.fold(s);
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function ago(ms) {
    if (!num(ms)) return 'never';
    if (Shape && typeof Shape.agoText === 'function') return Shape.agoText(ms, nowMs());
    var min = Math.round(Math.max(0, nowMs() - ms) / 60000);
    return min < 1 ? 'just now' : min < 60 ? min + ' min ago' : Math.round(min / 60) + ' h ago';
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null && text !== '') e.textContent = String(text);
    return e;
  }
  function button(cls, text, onClick) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  /* A "3 min ago" that the minute tick keeps true. */
  function agoSpan(cls, ms, pre, post) {
    var s = el('span', cls);
    s.dataset.at = String(num(ms));
    s.dataset.pre = pre || '';
    s.dataset.post = post || '';
    s.textContent = (pre || '') + ago(ms) + (post || '');
    return s;
  }

  var SVGNS = 'http://www.w3.org/2000/svg';
  var ICONS = {
    out: ['M9.5 3H13v3.5', 'M13 3 7.5 8.5', 'M11.5 9.5V13h-8.5V4.5h3.5'],
    play: ['M5 3.2v9.6L12.8 8z'],
    left: ['M10 4 6 8l4 4'],
    right: ['M6 4l4 4-4 4'],
    plus: ['M8 3.5v9', 'M3.5 8h9'],
    retry: ['M13.2 8a5.2 5.2 0 1 1-1.6-3.75', 'M13.4 2.6v3.1h-3.1'],
    x: ['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'],
    chev: ['M5 6.5l3 3 3-3']
  };
  function icon(name, extra) {
    var s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('class', 'i' + (extra ? ' ' + extra : '') + (name === 'play' ? ' fill' : ''));
    s.setAttribute('aria-hidden', 'true');
    (ICONS[name] || []).forEach(function (d) {
      var p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    });
    return s;
  }

  function clockOf(ms) {
    try { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms)); } catch (err) { return ''; }
  }
  /* "7:00 PM", "Tomorrow 7:00 PM", "Sat 1:00 PM", "Oct 24, 7:00 PM" */
  function dayClock(ms) {
    if (!num(ms)) return '';
    var d = new Date(ms), n = new Date(nowMs());
    var day = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((day(d) - day(n)) / 86400000);
    if (diff === 0) return clockOf(ms);
    if (diff === 1) return 'Tomorrow ' + clockOf(ms);
    if (diff === -1) return 'Yesterday ' + clockOf(ms);
    try {
      if (diff > 1 && diff < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d) + ' ' + clockOf(ms);
      return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d) + ', ' + clockOf(ms);
    } catch (err) { return clockOf(ms); }
  }
  function lenText(sec) {
    sec = Math.round(num(sec));
    if (!sec) return '';
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return h ? h + ':' + two(m) + ':' + two(s) : m + ':' + two(s);
  }
  function timeLeft(it) {
    if (!num(it.durationSec) || typeof it.progress !== 'number') return '';
    var min = Math.round(it.durationSec * (1 - clamp(it.progress, 0, 1)) / 60);
    if (min < 1) return 'Almost done';
    if (min < 60) return min + ' min left';
    var h = Math.floor(min / 60), r = min % 60;
    return h + ' h' + (r ? ' ' + r + ' min' : '') + ' left';
  }
  /* "S2 E4" / "S2:E4 The Bear" -> "S2 · E4" / "S2 · E4 · The Bear" */
  function epText(sub) {
    var m = /^S(\d+)\s*[:.\u00b7-]?\s*E(\d+)\b\s*[-:.\u00b7]?\s*(.*)$/i.exec(sub || '');
    if (!m) return sub || '';
    return 'S' + m[1] + ' \u00b7 E' + m[2] + (m[3] ? ' \u00b7 ' + m[3] : '');
  }
  function joinDot(parts) { return parts.filter(function (p) { return !!p; }).join(' \u00b7 '); }
  function listWords(names) {
    if (names.length < 2) return names.join('');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  /* ------------------------------------------------------------ normalize */

  /*
   * Protected video: main says whether this Quartz can play it (Widevine in,
   * signed for streaming) and which services the person sends to Edge anyway.
   * Without that word (an older main) a protected title is labelled Edge, as before.
   */
  var DRM = { known: false, playable: false, reason: '', edgeHosts: [] };
  // "Play inside Watch" (watch-player-main.js): main says whether a title plays in the layer.
  var PLAYER = { inside: false };
  var HUB = 'Lumen';
  function opensHere(dot) { return (PLAYER.inside ? 'Plays in ' + HUB : 'Opens in a new tab') + (dot ? '.' : ''); }
  function normDrm(d) {
    if (!d || typeof d !== 'object' || typeof d.playable !== 'boolean') return { known: false, playable: false, reason: '', edgeHosts: [] };
    return {
      known: true,
      playable: d.playable,
      reason: cleanText(d.reason, 200),
      edgeHosts: arr(d.edgeHosts).filter(function (h) { return typeof h === 'string' && h.length < 80; }).slice(0, 40)
    };
  }
  function hostOn(url, hosts) {
    var h = '';
    try { h = new URL(url).hostname.toLowerCase(); } catch (err) { return false; }
    for (var i = 0; i < hosts.length; i++) if (h === hosts[i] || h.slice(-(hosts[i].length + 1)) === '.' + hosts[i]) return true;
    return false;
  }
  /** Does a click on this URL go to Edge? `needs` = the page needs DRM (default: by address). */
  function edgeFor(url, needs) {
    var protectedPage = typeof needs === 'boolean' ? needs : !!(Shape && url && Shape.opensInEdge(url));
    if (!protectedPage) return false;
    if (!DRM.known || !DRM.playable) return true;
    return hostOn(url, DRM.edgeHosts);
  }

  function normalize(raw) {
    var o = (raw && typeof raw === 'object') ? raw : {};
    DRM = normDrm(o.drm);
    PLAYER = { inside: !!(o.player && typeof o.player === 'object' && o.player.inside === true) };
    var services = arr(o.services).map(normService).filter(Boolean);
    var seen = {};
    services = services.filter(function (s) { if (seen[s.id]) return false; seen[s.id] = true; return true; });
    var sp = (o.sports && typeof o.sports === 'object') ? o.sports : {};
    return {
      now: num(o.now) || Date.now(),
      services: services,
      rows: arr(o.rows).map(normRow).filter(function (r) { return r && r.items.length; }),
      sports: {
        live: arr(sp.live).map(normEvent).filter(Boolean),
        soon: arr(sp.soon).map(normEvent).filter(Boolean),
        done: arr(sp.done).map(normEvent).filter(Boolean)
      },
      items: arr(o.items).map(normItem).filter(Boolean),
      tmdb: { hasKey: !!(o.tmdb && o.tmdb.hasKey) },
      reading: typeof o.reading === 'string' ? o.reading : '',
      forgottenAt: num(o.forgottenAt)
    };
  }

  function normService(s) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id) return null;
    var d = (Shape && Shape.serviceById(s.id)) || {};
    var state = STATES.indexOf(s.state) !== -1 ? s.state : 'never';
    var enabled = s.enabled !== false && state !== 'off';
    var counts = (s.counts && typeof s.counts === 'object') ? s.counts : {};
    return {
      id: s.id,
      name: cleanText(s.name, 40) || d.name || s.id,
      short: cleanText(s.short, 24) || d.short || cleanText(s.name, 24) || s.id,
      covers: cleanText(s.covers, 200) || d.covers || '',
      edge: edgeFor(https(s.home) || https(d.home), typeof s.edge === 'boolean' ? s.edge : !!d.edge),
      needsSignIn: typeof s.needsSignIn === 'boolean' ? s.needsSignIn : d.needsSignIn !== false,
      enabled: enabled,
      state: enabled ? state : 'off',
      reason: cleanText(s.reason, 400),
      warnings: arr(s.warnings).map(function (w) { return cleanText(w, 200); }).filter(Boolean).slice(0, 5),
      readAt: num(s.readAt),
      lastOkAt: num(s.lastOkAt),
      profile: cleanText(s.profile, 60),
      // Profiles in Lumen (watch/profiles.js): the picture, the who's-watching state, the service's own picker.
      avatar: https(s.avatar),
      picker: s.picker === true && enabled && state === 'error',
      profilePage: s.profilePage && https(s.profilePage.url) ? { url: https(s.profilePage.url), label: cleanText(s.profilePage.label, 40), where: cleanText(s.profilePage.where, 160) } : null,
      reading: s.reading === true,
      queued: s.queued === true,
      readingSince: s.reading === true ? num(s.readingSince) : 0,
      readLimitMs: s.reading === true ? num(s.readLimitMs) : 0,
      paused: cleanText(s.paused, 200),
      next: num(s.next),
      live: num(counts.live),
      home: https(s.home) || https(d.home),
      signIn: https(s.signIn) || https(d.signIn)
    };
  }

  function normItem(it) {
    if (!it || typeof it !== 'object') return null;
    var title = cleanText(it.title, 200);
    var url = https(it.url);
    if (!title || !url) return null;
    var service = typeof it.service === 'string' && it.service ? it.service : (Shape ? Shape.serviceForUrl(url) : '');
    var p = (typeof it.progress === 'number' && isFinite(it.progress)) ? clamp(it.progress, 0, 1) : null;
    return {
      id: cleanText(it.id, 300) || (service + ':' + url),
      service: service,
      kind: typeof it.kind === 'string' ? it.kind : 'rec',
      also: normAlso(it.also, service),
      title: title,
      subtitle: cleanText(it.subtitle, 200),
      image: https(it.image),
      images: arr(it.images).map(https).filter(Boolean),
      progress: p,
      url: url,
      // straight to the service's player (watch/playurl.js); url stays the fallback
      playUrl: https(it.playUrl) && Shape && Shape.serviceForUrl(https(it.playUrl)) === Shape.serviceForUrl(url) ? https(it.playUrl) : '',
      startsAt: num(it.startsAt),
      durationSec: num(it.durationSec),
      badge: cleanText(it.badge, 24),
      group: cleanText(it.group, 120),
      edge: edgeFor(url, typeof it.edge === 'boolean' ? it.edge : undefined)
    };
  }

  function normRow(r) {
    if (!r || typeof r !== 'object') return null;
    var id = cleanText(r.id, 80);
    var title = cleanText(r.title, 120);
    if (!id || !title) return null;
    return { id: id, title: title, service: typeof r.service === 'string' ? r.service : '', items: arr(r.items).map(normItem).filter(Boolean) };
  }

  function normTeam(t) {
    if (!t || typeof t !== 'object') return null;
    var name = cleanText(t.name, 60) || cleanText(t.abbr, 8);
    if (!name) return null;
    var score = cleanText(t.score, 6);
    return { name: name, abbr: cleanText(t.abbr, 6) || name.slice(0, 3).toUpperCase(), logo: https(t.logo), score: score, record: cleanText(t.record, 16) };
  }

  function normEvent(ev) {
    if (!ev || typeof ev !== 'object') return null;
    var home = normTeam(ev.home), away = normTeam(ev.away);
    var watchUrl = https(ev.watchUrl), gamecastUrl = https(ev.gamecastUrl);
    var url = watchUrl || gamecastUrl;
    if (!home || !away || !url) return null;
    var lg = cleanText(ev.league, 12);
    var lgDef = (Shape && Shape.leagueById(lg)) || null;
    return {
      id: cleanText(ev.id, 80) || url,
      league: lg,
      leagueName: cleanText(ev.leagueName, 40) || (lgDef ? lgDef.name : lg.toUpperCase()),
      state: ['pre', 'in', 'post'].indexOf(ev.state) !== -1 ? ev.state : 'pre',
      startsAt: num(ev.startsAt),
      detail: cleanText(ev.detail, 40),
      home: home,
      away: away,
      broadcasts: arr(ev.broadcasts).map(function (b) { return cleanText(b, 24); }).filter(Boolean).slice(0, 3),
      url: url,
      edge: edgeFor(url)
    };
  }

  function normalizeAnswer(a) {
    var yt = (a.youtube && typeof a.youtube === 'object') ? a.youtube : null;
    var tm = (a.tmdb && typeof a.tmdb === 'object') ? a.tmdb : null;
    return {
      seq: a.seq,
      q: cleanText(a.q, 200),
      links: arr(a.links).map(function (l) {
        if (!l || typeof l !== 'object') return null;
        var url = https(l.url);
        return url ? { service: cleanText(l.service, 20), name: cleanText(l.name, 40), url: url } : null;
      }).filter(Boolean),
      youtube: yt ? {
        ok: yt.ok === true,
        state: cleanText(yt.state, 20),
        reason: cleanText(yt.reason, 300),
        items: arr(yt.items).map(normItem).filter(Boolean).slice(0, 12)
      } : null,
      tmdb: tm ? {
        state: cleanText(tm.state, 20),
        reason: cleanText(tm.reason, 300),
        attribution: cleanText(tm.attribution, 120),
        results: arr(tm.results).map(normTmdb).filter(Boolean).slice(0, 20)
      } : null
    };
  }

  function normTmdb(r) {
    if (!r || typeof r !== 'object') return null;
    var title = cleanText(r.title, 200);
    if (!title) return null;
    return {
      title: title,
      year: cleanText(r.year, 12),
      mediaType: r.mediaType === 'tv' ? 'Series' : r.mediaType === 'movie' ? 'Film' : '',
      image: https(r.image),
      overview: cleanText(r.overview, 240),
      providers: arr(r.providers).map(function (p) {
        if (!p || typeof p !== 'object') return null;
        var name = cleanText(p.name, 60);
        if (!name) return null;
        return { name: name, type: cleanText(p.type, 10), service: cleanText(p.service, 20), url: https(p.url), price: cleanText(p.price, 20) };
      }).filter(Boolean)
    };
  }

  /* -------------------------------------------------------------- services */

  function services() {
    if (S.snap && S.snap.services.length) return S.snap.services;
    if (!Shape) return [];
    return Shape.SERVICES.map(function (d) {
      return normService({ id: d.id, name: d.name, short: d.short, state: 'never', enabled: true });
    });
  }
  function svcOf(id) {
    var list = services();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function svcName(id) { var s = svcOf(id); return s ? s.name : ((Shape && Shape.serviceById(id)) || {}).name || id || ''; }
  function svcShort(id) { var s = svcOf(id); return s ? s.short : svcName(id); }
  function staleSvc(id) { var s = svcOf(id); return !!(s && s.state === 'error'); }
  function enabledSvcs() { return services().filter(function (s) { return s.enabled; }); }
  /* The one pause every enabled service shares (a game, memory), or ''. */
  function sharedPause() {
    var en = enabledSvcs();
    if (en.length < 2) return '';
    var p = en[0].paused;
    if (!p) return '';
    for (var i = 1; i < en.length; i++) if (en[i].paused !== p) return '';
    return p;
  }

  /* ------------------------------------------------------------ the strip */

  function pillLook(s, boot, shared) {
    if (boot) return S.failure ? { cls: 'st-error', dot: 'err', small: 'No answer' } : { cls: 'st-busy', dot: 'busy', small: 'Starting\u2026' };
    if (s.state === 'off') return { cls: 'st-off', dot: 'off', small: 'Off' };
    if (s.reading) return { cls: 'st-busy', dot: 'busy', small: 'Reading\u2026' };
    if (s.picker) return { cls: 'st-error st-picker', dot: 'warn', small: 'Who’s watching?', act: 'Pick profile' };   // watch/profiles.js
    if (s.state === 'error') return { cls: 'st-error', dot: 'err', small: "Couldn't read", act: 'Retry' };
    if (s.state === 'signed-out') return { cls: 'st-signed-out', dot: 'out', small: 'Signed out', act: 'Sign in' };
    if (s.paused) return { cls: 'st-paused', dot: 'warn', small: shared ? 'Paused' : capFirst(s.paused.replace(/\s*\([^)]*\)\s*$/, '')) };
    if (s.queued) return { cls: 'st-busy', dot: 'busy', small: 'Waiting to read' };
    if (s.state === 'never') return { cls: 'st-never', dot: 'idle', small: 'Not read yet' };
    if (s.id === 'espn' && liveCount() > 0) return { cls: 'st-ok', dot: '', small: liveCount() + ' live now' };
    if (s.warnings.length) return { cls: 'st-ok', dot: '', small: 'Partly read', warn: true };
    return { cls: 'st-ok', dot: '', small: '' };
  }
  function liveCount() { return S.snap ? S.snap.sports.live.length : 0; }

  function pillTitle(s) {
    var lines = [s.name + (s.profile ? ' \u00b7 ' + s.profile : '')];
    if (s.state === 'off') lines.push('Turned off in Settings > Lumen');
    else if (s.reading) lines.push('Reading now');
    else if (s.state === 'error') lines.push("Couldn't read: " + (s.reason || 'no reason given'));
    else if (s.state === 'signed-out') lines.push('Signed out' + (s.reason ? ': ' + s.reason : ''));
    else if (s.state === 'never') lines.push('Not read yet');
    else if (s.readAt) lines.push('Read ' + ago(s.readAt));
    if (s.paused) lines.push(capFirst(s.paused));
    s.warnings.forEach(function (w) { lines.push('Note: ' + w); });
    return lines.join('\n');
  }

  function renderStrip() {
    var boot = !S.snap;
    var keep = stripFocusKey();
    var shared = sharedPause();
    var frag = document.createDocumentFragment();
    services().forEach(function (s) {
      var look = pillLook(s, boot, shared);
      var pill = el('span', 'sp ' + look.cls);
      pill.dataset.svc = s.id;
      var main = button('sp-main');
      main.dataset.k = s.id + ':main';
      var dot = el('span', 'dot' + (look.dot ? ' ' + look.dot : ''));
      main.appendChild(dot);
      main.appendChild(el('span', 'sp-name', s.name));
      if (look.small) main.appendChild(el('small', look.warn ? 'warn-mark' : '', look.small));
      if (!boot && window.LumenProfiles) window.LumenProfiles.chip(main, s);
      if (boot) {
        main.disabled = true;
        main.setAttribute('aria-label', s.name + ': waiting for Lumen to start');
      } else {
        main.title = pillTitle(s);
        main.setAttribute('aria-label', main.title.replace(/\n/g, '. '));
        if (s.state === 'off') main.addEventListener('click', function () { send('settings', {}); });
        else {
          main.setAttribute('aria-haspopup', 'dialog');
          main.setAttribute('aria-expanded', S.popFor === s.id ? 'true' : 'false');
          main.addEventListener('click', function () { togglePop(s.id, main); });
        }
      }
      pill.appendChild(main);
      if (!boot && look.act) {
        var act = button('sp-act', look.act, function () {
          if (look.act === 'Retry') send('refresh', { service: s.id });
          else if (look.act === 'Pick profile') send('profile', { service: s.id });
          else send('signin', { service: s.id });
        });
        act.dataset.k = s.id + ':act';
        act.setAttribute('aria-label', look.act + ' ' + s.name);
        pill.appendChild(act);
      }
      frag.appendChild(pill);
    });
    var add = el('span', 'sp add');
    var addBtn = button('', '', function () { send('settings', {}); });
    addBtn.dataset.k = 'manage';
    addBtn.appendChild(icon('plus', 's'));
    addBtn.appendChild(document.createTextNode('Manage'));
    addBtn.title = 'Choose the services Lumen reads (Settings > Lumen)';
    addBtn.disabled = boot;
    add.appendChild(addBtn);
    frag.appendChild(add);
    $.pills.replaceChildren(frag);
    renderFresh(boot, shared);
    if (keep) {
      var back = $.pills.querySelector('[data-k="' + keep + '"]');
      if (back && !back.disabled) back.focus({ preventScroll: true });
    }
  }

  function stripFocusKey() {
    var a = document.activeElement;
    return (a && $.pills.contains(a) && a.dataset) ? (a.dataset.k || '') : '';
  }

  /* The header's status: what is happening and when, never a silent "Reading…".
       idle      "Updated 3 min ago" (the oldest of the services that read fine; the minute tick keeps it true)
       reading   "Updating Disney+…" -- and past the read's time limit (main's + READ_LIMIT_GRACE_MS)
                 "Updating Disney+ didn't finish after 50 s" with Retry, in case main never says it ended
       queued    "Waiting to update Disney+"
       failed    "Couldn't update Disney+: <reason>" with Retry (main stops a read at its limit and says so)
       paused    the shared pause, as before. */
  function freshText(f, text, title) {
    var t = el('span', '', text);
    t.style.overflow = 'hidden';
    t.style.textOverflow = 'ellipsis';
    t.style.minWidth = '0';
    if (title) t.title = title;
    f.appendChild(t);
    return t;
  }
  function freshRetry(f, label, onClick) {
    var b = button('btn sm ghost fresh-retry', 'Retry', onClick);
    b.setAttribute('aria-label', label);
    b.style.flex = 'none';
    f.appendChild(b);
  }
  function renderFresh(boot, shared) {
    var f = $.fresh;
    clearTimeout(S.freshTimer);
    S.freshTimer = 0;
    f.replaceChildren();
    f.className = 'fresh';
    f.removeAttribute('title');
    $.readAll.disabled = boot;
    if (boot) return;
    var en = enabledSvcs();
    if (!en.length) { f.textContent = 'Every service is off'; $.readAll.disabled = true; return; }
    if (shared) {
      f.classList.add('paused');
      f.appendChild(el('span', 'dot warn'));
      f.appendChild(document.createTextNode(capFirst(shared)));
      return;
    }
    var busy = en.filter(function (s) { return s.reading; })[0];
    if (busy) {
      var limit = (busy.readLimitMs || READ_LIMIT_FALLBACK_MS) + READ_LIMIT_GRACE_MS;
      // An older main sends no start: count from when this page first saw the read.
      if (!S.busySeen || S.busySeen.id !== busy.id) S.busySeen = { id: busy.id, at: nowMs() };
      var since = busy.readingSince || S.busySeen.at;
      var left = since + limit - nowMs();
      if (left > 0) {
        f.classList.add('busy');
        f.appendChild(el('span', 'dot busy'));
        freshText(f, 'Updating ' + busy.name + '…');
        // Past the limit with no word from Quartz: say so (the read is overdue), never wait forever.
        S.freshTimer = setTimeout(function () { S.freshTimer = 0; if (S.snap) renderFresh(!S.snap, sharedPause()); }, left + 50);
        return;
      }
      f.classList.add('failed');
      f.appendChild(el('span', 'dot err'));
      var secs = Math.round((nowMs() - since) / 1000);
      freshText(f, 'Updating ' + busy.name + ' didn’t finish after ' + secs + ' s', 'Quartz has not said this read ended. Retry asks Quartz for everything again.');
      freshRetry(f, 'Retry updating ' + busy.name, function () { retryHello(); });
      return;
    }
    S.busySeen = null;
    var failed = en.filter(function (s) { return s.state === 'error'; });
    if (failed.length) {
      f.classList.add('failed');
      f.appendChild(el('span', 'dot err'));
      var names = listWords(failed.map(function (s) { return s.name; }));
      var why = failed[0].reason || 'no reason given';
      var full = failed.map(function (s) { return s.name + ': ' + (s.reason || 'no reason given'); }).join('\n');
      freshText(f, 'Couldn’t update ' + names + (failed.length === 1 ? ': ' + why : ''), full);
      if (window.LumenProfiles) window.LumenProfiles.freshPick(f, failed, send);
      freshRetry(f, 'Retry ' + names, function () {
        failed.forEach(function (s) { send('refresh', { service: s.id }); });
      });
      return;
    }
    var waiting = en.filter(function (s) { return s.queued; })[0];
    if (waiting) {
      f.classList.add('busy');
      f.appendChild(el('span', 'dot busy'));
      freshText(f, 'Waiting to update ' + waiting.name);
      return;
    }
    var ok = en.filter(function (s) { return s.state === 'ok' && s.lastOkAt; });
    if (ok.length) {
      var oldest = Math.min.apply(null, ok.map(function (s) { return s.lastOkAt; }));
      f.appendChild(agoSpan('', oldest, 'Updated '));
      f.title = ok.map(function (s) { return s.name + ': updated ' + ago(s.lastOkAt); }).join('\n');
      return;
    }
    var latest = Math.max.apply(null, en.map(function (s) { return s.readAt || 0; }));
    if (latest) f.appendChild(agoSpan('', latest, 'Last read '));
    else freshText(f, 'Not updated yet');
  }

  /* ------------------------------------------------------------ popover */

  function togglePop(id, from) {
    if (S.popFor === id && !$.pop.hidden) { closePop(true); return; }
    S.popFor = id;
    S.popFrom = from || null;
    fillPop();
    $.pop.hidden = false;
    placePop();
    $.pop.classList.add('pre');
    void $.pop.offsetWidth;
    $.pop.classList.remove('pre');
    syncExpanded();
    var first = $.pop.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }

  function closePop(restore) {
    if ($.pop.hidden) { S.popFor = ''; return; }
    var from = S.popFrom;
    $.pop.hidden = true;
    S.popFor = '';
    S.popFrom = null;
    syncExpanded();
    if (restore) {
      var back = from && document.contains(from) ? from : null;
      if (!back && from && from.dataset) back = $.pills.querySelector('[data-k="' + from.dataset.k + '"]');
      if (back) back.focus({ preventScroll: true });
    }
  }

  function syncExpanded() {
    var btns = $.pills.querySelectorAll('.sp-main[aria-haspopup]');
    for (var i = 0; i < btns.length; i++) {
      var pill = btns[i].parentNode;
      btns[i].setAttribute('aria-expanded', (!$.pop.hidden && pill && pill.dataset.svc === S.popFor) ? 'true' : 'false');
    }
  }

  function placePop() {
    var anchor = $.pills.querySelector('.sp[data-svc="' + S.popFor + '"]');
    if (!anchor) return;
    var r = anchor.getBoundingClientRect();
    var w = $.pop.offsetWidth || 320;
    $.pop.style.left = clamp(r.left, 8, Math.max(8, window.innerWidth - w - 8)) + 'px';
    $.pop.style.top = (r.bottom + 8) + 'px';
  }

  function fillPop() {
    var s = svcOf(S.popFor);
    if (!s) { closePop(false); return; }
    var p = $.pop;
    // A refill (a snapshot while it is open) keeps the keyboard where it was: the same button again.
    var had = document.activeElement && document.activeElement !== p && p.contains(document.activeElement) ? document.activeElement.textContent : null;
    p.replaceChildren();
    var h = el('h3', '', s.name);
    h.id = 'pop-title';
    if (s.profile) h.appendChild(el('small', '', s.profile));
    if (window.LumenProfiles) window.LumenProfiles.popHead(h, s);
    p.setAttribute('aria-labelledby', 'pop-title');
    p.appendChild(h);

    var st = el('div', 'st');
    var stDot = 'dot', stText = '';
    if (s.reading) { stDot += ' busy'; stText = 'Reading now'; }
    else if (s.state === 'error') { stDot += ' err'; st.classList.add('err'); stText = "Couldn't read"; }
    else if (s.state === 'signed-out') { stDot += ' out'; stText = 'Signed out'; }
    else if (s.paused) { stDot += ' warn'; st.classList.add('warn'); stText = 'Paused'; }
    else if (s.queued) { stDot += ' busy'; stText = 'Waiting to read'; }
    else if (s.state === 'never') { stDot += ' idle'; stText = 'Not read yet'; }
    else stText = 'Connected';
    st.appendChild(el('span', stDot));
    st.appendChild(document.createTextNode(stText));
    if (s.readAt && !s.reading && s.state !== 'never') {
      st.appendChild(document.createTextNode(' \u00b7 '));
      st.appendChild(agoSpan('', s.readAt));
    }
    p.appendChild(st);

    if (s.state === 'error' && window.LumenProfiles && window.LumenProfiles.popWords(p, s)) {
      /* who's watching: watch/profiles.js said it, and adds Pick profile below */
    } else if (s.state === 'error') {
      p.appendChild(el('p', '', "Couldn't read " + s.name + ': ' + (s.reason || 'no reason was given') + '.'));
      if (s.lastOkAt) {
        var keepP = el('p', 'small');
        keepP.appendChild(document.createTextNode('Showing what was read '));
        keepP.appendChild(agoSpan('', s.lastOkAt, '', '.'));
        p.appendChild(keepP);
      } else p.appendChild(el('p', 'small', 'Nothing from ' + s.name + ' is cached yet.'));
    } else if (s.state === 'signed-out') {
      p.appendChild(el('p', '', (s.reason ? capFirst(s.reason) + '. ' : '') + (PLAYER.inside ? 'Sign in opens ' + s.name + '’s own sign-in page here in Lumen; Lumen reads it again after.' : 'Sign in to ' + s.name + ' in a Quartz tab as usual; Lumen reads it again after.')));
    }
    if (s.paused) p.appendChild(el('p', '', capFirst(s.paused) + '.'));
    if (s.warnings.length) {
      var ul = el('ul');
      s.warnings.forEach(function (w) { var li = el('li'); li.appendChild(el('span', '', w)); ul.appendChild(li); });
      p.appendChild(el('p', 'small', 'Read, with ' + (s.warnings.length === 1 ? 'one part' : s.warnings.length + ' parts') + ' missing:'));
      p.appendChild(ul);
    }
    if (s.covers) p.appendChild(el('p', 'small', s.covers + '.'));
    if (s.next && s.readAt && s.next > nowMs() && !s.reading && s.state !== 'error') {
      var nx = Math.max(1, Math.round((s.next - nowMs()) / 60000));
      p.appendChild(el('p', 'small', 'Next read in about ' + nx + ' min, while Lumen is open.'));
    }

    var acts = el('div', 'acts');
    var readBtn = button('btn sm' + (s.state === 'error' && !s.picker ? ' primary' : ''), s.state === 'error' ? 'Retry' : 'Read now', function () { send('refresh', { service: s.id }); closePop(true); });
    if (s.reading) readBtn.disabled = true;
    acts.appendChild(readBtn);
    if (s.needsSignIn && s.state !== 'ok') {
      acts.appendChild(button('btn sm' + (s.state === 'signed-out' ? ' primary' : ''), 'Sign in', function () { send('signin', { service: s.id }); closePop(true); }));
    }
    if (s.home) {
      var open = button('btn sm ghost', 'Open ' + s.short, function () { openUrl(s.home); closePop(true); });
      if (edgeFor(s.home)) open.title = 'Opens in Microsoft Edge' + (DRM.reason ? ': ' + DRM.reason : '');
      acts.appendChild(open);
    }
    if (window.LumenProfiles) window.LumenProfiles.popActs(acts, s, send, closePop, null);
    acts.appendChild(button('btn sm ghost', 'Settings', function () { send('settings', {}); closePop(true); }));
    p.appendChild(acts);
    if (had !== null) {
      var again = Array.prototype.find.call(p.querySelectorAll('button'), function (b) { return b.textContent === had && !b.disabled; });
      if (again) again.focus({ preventScroll: true });
    }
  }

  /* ------------------------------------------------------------ the model */

  function lensModel(snap) {
    var out = [];
    if (!snap) return out;
    // Rows by what he would want to watch, never by app: in progress, live, saved, picked for him,
    // the games ahead and just finished; the services' own shelves come after, below the merged ones.
    var by = {};
    var shelves = [];
    snap.rows.forEach(function (r) { if (/^(continue|foryou|watchlist)$/.test(r.id) && !by[r.id]) by[r.id] = r; else shelves.push(r); });
    var sp = snap.sports;
    var games = function (key, title, events) { if (events.length) out.push({ key: key, kind: 'sports', id: key, title: title, service: 'espn', events: events }); };
    // Lumen sports (watch/sportspage.js): Live now leads while a favourite's or a big game is live
    // (favourites first), and the favourites get a My teams row.
    var LS = window.LumenSports || null;
    var liveTop = !!(LS && LS.liveOnTop(sp.live));
    if (liveTop) games('sports', 'Live now', LS.sortLive(sp.live));
    if (by.continue) out.push(itemRow(by.continue));
    // YouTube Subscriptions (watch/ytlib-page.js): up top with videos; a state card (sign in, failed) lower down.
    var yt = window.WatchYt ? window.WatchYt.row(snap) : null;
    if (yt && yt.top) out.push(yt);
    var mine = LS ? LS.myTeamsRow() : null;
    if (mine) out.push(mine);
    if (!liveTop) games('sports', 'Live now', sp.live);
    if (by.watchlist) out.push(itemRow(by.watchlist));
    if (by.foryou) out.push(itemRow(by.foryou));
    games('sports-soon', 'Upcoming games', sp.soon);
    games('sports-done', 'Recent games', sp.done);
    if (yt && !yt.top) out.push(yt);
    shelves.forEach(function (r) { out.push(itemRow(r)); });
    out.forEach(function (m) { m.sig = rowSig(m) + (m.ytSig || ''); });
    return out;
  }
  function itemRow(r) {
    return { key: 'r:' + r.id, kind: 'items', id: r.id, title: r.title, service: r.service || '', items: r.items };
  }
  function itemKey(it) { return it.id || it.url; }
  /** The other services that carry the same title (watch/merge.js mergeSame): [{ service, url }], at most 3. */
  function normAlso(list, own) {
    return arr(list).filter(function (a) { return a && typeof a.service === 'string' && a.service && a.service !== own && https(a.url); })
      .slice(0, 3).map(function (a) { return { service: a.service, url: https(a.url) }; });
  }
  /* Where a tile's title goes (the player layer or a tab; Quartz or Edge) is in every tile's
     label, so a change of either ("Play inside Lumen", Widevine arriving, an Edge rule) rebuilds
     the rows instead of leaving the old words on them. */
  function routeSig() {
    return (PLAYER.inside ? 'in' : 'tab') + '/' + (DRM.known ? 1 : 0) + (DRM.playable ? 1 : 0) + '/' + DRM.edgeHosts.join(',');
  }
  function rowSig(m) {
    var parts = [m.key, m.title, m.service, m.service ? (svcOf(m.service) || {}).state : '', routeSig()];
    if (m.kind === 'sports') m.events.forEach(function (e) { parts.push(e.id, e.state, e.detail, e.home.score, e.away.score, e.home.logo, e.away.logo, e.url); });
    else if (m.kind === 'teams') parts.push(window.LumenSports.rowSig(m));
    else m.items.forEach(function (it) { parts.push(itemKey(it), it.title, it.subtitle, it.image, it.progress, it.badge, staleSvc(it.service) ? 's' : '', it.also.map(function (a) { return a.service; }).join('+')); });
    return parts.join('\u0001');
  }

  /* What the page is showing when it has no rows. */
  function pageMode(snap, model) {
    if (!snap) return 'boot';
    if (model.length) return 'rows';
    var en = snap.services.filter(function (s) { return s.enabled; });
    if (!en.length) return 'all-off';
    var busy = en.some(function (s) { return s.reading || s.queued; });
    var never = en.every(function (s) { return s.state === 'never' && !s.lastOkAt; });
    if (never) {
      // The skeleton (and its "Reading" label) shows only while a read runs or is queued, or is
      // due this moment (the boot hello, a beat before main queues it). Forget, or reads that
      // are simply not due yet, say when the next read is instead.
      if (busy) return 'welcome';
      if (sharedPause() || en.some(function (s) { return s.paused; })) return 'waiting';
      if (snap.forgottenAt && en.every(function (s) { return s.readAt < snap.forgottenAt; })) return 'forgotten';
      return en.some(function (s) { return s.next && s.next <= snap.now + 1000; }) ? 'welcome' : 'later';
    }
    if (busy) return 'reading';
    if (en.some(function (s) { return s.state === 'ok'; })) return 'empty';
    return 'failing';
  }

  /* --------------------------------------------------------------- render */

  function applySnapshot(snap) {
    S.snap = snap;
    S.skew = snap.now - Date.now();
    if (Math.abs(S.skew) < 5000) S.skew = 0;
    document.body.classList.remove('is-boot');
    S.hold.draw(drawStripPop);
    renderLens();
    if (S.q) renderResults();
    scheduleTick();
  }

  /* The strip and the open popover, redrawn from S.snap. Through S.hold (watch/presshold.js): a
     redraw that arrives while a press is down on either waits until that press's click has run,
     or the button pressed would be gone at the release and the click (Read now, Retry) lost. */
  function drawStripPop() {
    renderStrip();
    if (!$.pop.hidden) { fillPop(); placePop(); }
  }

  function renderBoot() {
    renderStrip();
    S.model = [];
    var sk = skeletonRow('Loading Lumen\u2026');
    $.stack.replaceChildren(sk);
    S.rowEls = [sk];
    document.body.classList.remove('is-empty');
    document.body.classList.add('one-row');
    activate(0, {});
    showStageSpecial('boot');
  }

  function renderLens() {
    var snap = S.snap;
    var model = lensModel(snap);
    var mode = pageMode(snap, model);
    S.model = model;
    var focusInfo = stackFocus();
    var els = [];

    if (mode === 'rows') {
      var old = {};
      S.rowEls.forEach(function (r) { if (r.dataset.key) old[r.dataset.key] = r; });
      model.forEach(function (m) {
        var prev = old[m.key];
        els.push(prev && prev._sig === m.sig ? prev : buildRow(m));
      });
    } else if (mode === 'welcome' || mode === 'reading' || mode === 'waiting') {
      els.push(skeletonRow(skeletonLabel()));
    }

    // Put the rows in place, moving as little as possible (a moved node loses focus).
    for (var i = 0; i < els.length; i++) {
      if ($.stack.children[i] !== els[i]) $.stack.insertBefore(els[i], $.stack.children[i] || null);
    }
    while ($.stack.children.length > els.length) $.stack.removeChild($.stack.lastChild);
    S.rowEls = els;
    els.forEach(function (r) { if (r._row) r._row.restore(); });

    document.body.classList.toggle('is-empty', !els.length);
    document.body.classList.toggle('one-row', els.length < 2);

    if (mode !== 'rows') {
      S.curKey = '';
      if (els.length) activate(0, {});
      showStageSpecial(mode);
      return;
    }
    var idx = 0;
    for (var j = 0; j < els.length; j++) if (els[j].dataset.key === S.curKey) { idx = j; break; }
    if (S.curKey && els[idx].dataset.key !== S.curKey) idx = clamp(S.cur, 0, els.length - 1);
    // A row that arrived (or left) above the one he is on -- Continue watching after a title, a game
    // going live -- moves his row in the stack: keep it where it is on screen, with no slide.
    var shifted = !!S.curKey && els[idx].dataset.key === S.curKey && idx !== S.cur;
    activate(idx, { instant: !S.curKey || shifted });
    if (focusInfo) restoreStackFocus(focusInfo);
  }

  function stackFocus() {
    var a = document.activeElement;
    if (!a || !$.stack.contains(a)) return null;
    var row = a.closest('.lrow');
    var card = a.closest('[data-key]:not(.lrow)');
    return { row: row ? row.dataset.key : '', card: card ? card.dataset.key : '' };
  }
  function restoreStackFocus(info) {
    if ($.stack.contains(document.activeElement)) return;
    var row = null;
    for (var i = 0; i < S.rowEls.length; i++) if (S.rowEls[i].dataset.key === info.row) row = S.rowEls[i];
    if (!row) row = S.rowEls[S.cur];
    if (!row) return;
    var card = row.querySelector('.card[data-key="' + cssEsc(info.card) + '"], .gc[data-key="' + cssEsc(info.card) + '"]') || rovingCard(row);
    if (card) card.focus({ preventScroll: true });
  }
  function cssEsc(s) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(String(s || ''));
    return String(s || '').replace(/["\\]/g, '\\$&');
  }

  function skeletonLabel() {
    var en = enabledSvcs();
    var busy = en.filter(function (s) { return s.reading; })[0];
    if (busy) return 'Reading ' + busy.name + '\u2026';
    var shared = sharedPause();
    if (shared) return capFirst(shared);
    var paused = en.filter(function (s) { return s.paused; })[0];
    if (paused) return paused.name + ': ' + paused.paused;
    var q = en.filter(function (s) { return s.queued; })[0];
    if (q) return 'Waiting to read ' + q.name + '\u2026';
    return 'Reading your services\u2026';
  }

  function skeletonRow(label) {
    var sec = el('section', 'lrow sk-row');
    sec.dataset.key = 'skeleton';
    sec.setAttribute('aria-label', label);
    var head = el('div', 'lr-h');
    head.appendChild(el('h2', '', label));
    sec.appendChild(head);
    var row = el('div', 'row');
    var rv = el('div', 'rv');
    var rt = el('div', 'rt');
    rt.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 8; i++) {
      var c = el('span', 'card sk-card');
      var fr = el('span', 'frame');
      fr.appendChild(el('span', 'art'));
      c.appendChild(fr);
      var m = el('span', 'm');
      var a = el('span', 'sk'); a.style.width = (60 + (i * 37) % 30) + '%';
      var b = el('span', 'sk'); b.style.width = (34 + (i * 23) % 20) + '%';
      m.appendChild(a); m.appendChild(b);
      c.appendChild(m);
      rt.appendChild(c);
    }
    rv.appendChild(rt);
    row.appendChild(rv);
    sec.appendChild(row);
    return sec;
  }

  /* --- a row ------------------------------------------------------------- */

  function rowSub(m, head) {
    if (m.yt && window.WatchYt) { window.WatchYt.head(m, head); return; }
    if (m.kind === 'sports') {
      var espn = svcOf('espn');
      if (espn && espn.state === 'error') { head.appendChild(staleSub(espn)); return; }
      var sp = S.snap.sports;
      var t = sp.live.length ? sp.live.length + ' live now' : sp.soon.length ? 'next ' + dayClock(sp.soon[0].startsAt) : 'finals';
      head.appendChild(el('span', 'sub', 'ESPN \u00b7 ' + t));
      if (window.LumenSports) window.LumenSports.headChips(m, head);
      return;
    }
    if (m.kind === 'teams') { window.LumenSports.rowSub(m, head); return; }
    if (m.service) {
      var s = svcOf(m.service);
      head.appendChild(el('span', 'chip', svcShort(m.service)));
      if (s && s.state === 'error') head.appendChild(staleSub(s));
      return;
    }
    var ids = [];
    m.items.forEach(function (it) { if (ids.indexOf(it.service) === -1) ids.push(it.service); });
    var stale = ids.filter(function (id) { return staleSvc(id); });
    var text = '';
    if (m.id === 'continue') text = m.items.length + (ids.length > 1 ? ' \u00b7 across ' + ids.length + ' services' : ' \u00b7 ' + svcName(ids[0]));
    else if (m.id === 'watchlist') text = m.items.length + ' saved';
    else text = 'From ' + listWords(ids.map(svcName));
    head.appendChild(el('span', 'sub', text));
    if (stale.length) {
      var s0 = svcOf(stale[0]);
      var w = el('span', 'sub warn');
      w.appendChild(el('span', 'dot warn'));
      w.appendChild(document.createTextNode(s0.name + ' from '));
      w.appendChild(agoSpan('', s0.lastOkAt || s0.readAt));
      head.appendChild(w);
    }
  }
  function staleSub(s) {
    var w = el('span', 'sub err');
    w.appendChild(el('span', 'dot err'));
    w.appendChild(document.createTextNode("Couldn't read " + s.name + ' \u00b7 showing '));
    w.appendChild(agoSpan('', s.lastOkAt || s.readAt));
    w.title = s.reason || '';
    var wrap = document.createDocumentFragment();
    wrap.appendChild(w);
    var retry = button('btn sm ghost', 'Retry', function (e) { e.stopPropagation(); send('refresh', { service: s.id }); });
    retry.setAttribute('aria-label', 'Retry reading ' + s.name);
    retry.tabIndex = -1;
    wrap.appendChild(retry);
    return wrap;
  }

  function buildRow(m) {
    var sec = el('section', 'lrow');
    sec.dataset.key = m.key;
    sec.setAttribute('aria-label', m.title);
    sec._sig = m.sig;
    sec._model = m;
    var head = el('div', 'lr-h');
    head.appendChild(el('h2', '', m.title));
    rowSub(m, head);
    sec.appendChild(head);

    var row = el('div', 'row');
    var rv = el('div', 'rv');
    var rt = el('div', 'rt');
    if (m.kind === 'sports') m.events.forEach(function (ev) { rt.appendChild(gameEl(ev)); });
    else if (m.kind === 'teams') m.teams.forEach(function (t) { rt.appendChild(window.LumenSports.teamCardEl(t)); });
    else m.items.forEach(function (it) { rt.appendChild(cardEl(it, m)); });
    rv.appendChild(rt);
    row.appendChild(rv);
    var prev = el('div', 'row-nav prev');
    var prevB = button('', '', function (e) { e.stopPropagation(); sec._row.page(-1); });
    prevB.tabIndex = -1; prevB.setAttribute('aria-label', 'Scroll ' + m.title + ' back'); prevB.appendChild(icon('left'));
    prev.appendChild(prevB);
    var next = el('div', 'row-nav next');
    var nextB = button('', '', function (e) { e.stopPropagation(); sec._row.page(1); });
    nextB.tabIndex = -1; nextB.setAttribute('aria-label', 'Scroll ' + m.title + ' on'); nextB.appendChild(icon('right'));
    next.appendChild(nextB);
    row.appendChild(prev);
    row.appendChild(next);
    sec.appendChild(row);
    wireRow(sec, rv, rt, prevB, nextB);
    var pick = S.pick[m.key];
    var c = (pick && rt.querySelector('[data-key="' + cssEsc(pick) + '"]')) || cardsOf(sec)[0];
    setRoving(sec, c);
    return sec;
  }

  function cardsOf(row) { return row ? Array.prototype.slice.call(row.querySelectorAll('.rt > .card, .rt > .gw > .gc')) : []; }
  function rovingCard(row) { return row ? (row.querySelector('.rt [tabindex="0"]') || cardsOf(row)[0] || null) : null; }
  function setRoving(row, card) {
    cardsOf(row).forEach(function (c) { c.tabIndex = (c === card) ? 0 : -1; });
  }

  /* The track moves on the spring; the viewport clips; focus never scrolls it natively. */
  function wireRow(sec, rv, rt, prevB, nextB) {
    var key = sec.dataset.key;
    var x = S.x[key] || 0;
    var gutter = function () { return parseFloat(getComputedStyle(rt).paddingLeft) || 0; };
    var max = function () { return Math.max(0, rt.scrollWidth - rv.clientWidth); };
    var items = function () { return Array.prototype.slice.call(rt.children); };
    function set(nx, instant) {
      x = clamp(nx, 0, max());
      S.x[key] = x;
      if (instant) rt.style.transition = 'none';
      rt.style.transform = x ? 'translateX(' + (-x) + 'px)' : '';
      if (instant) { void rt.offsetWidth; rt.style.transition = ''; }
      prevB.disabled = x <= 1;
      nextB.disabled = x >= max() - 1;
    }
    function page(dir) {
      var g = gutter(), w = rv.clientWidth - 2 * g, cs = items();
      if (dir > 0) {
        var n = cs.filter(function (c) { return c.offsetLeft + c.offsetWidth > x + g + w + 1; })[0];
        if (n) set(n.offsetLeft - g);
      } else {
        var target = x - w;
        var p = cs.filter(function (c) { return c.offsetLeft - g >= target - 1; })[0];
        set(p ? p.offsetLeft - g : 0);
      }
    }
    function ensure(card) {
      var item = card.closest('.rt > *');
      if (!item) return;
      var g = gutter(), l = item.offsetLeft, r = l + item.offsetWidth;
      if (l - g < x) set(l - g);
      else if (r + g > x + rv.clientWidth) set(r + g - rv.clientWidth);
    }
    sec._row = {
      set: set, page: page, ensure: ensure,
      by: function (d) { set(x + d); },
      restore: function () { set(S.x[key] || 0, true); }
    };
  }

  /* --- a card ------------------------------------------------------------ */

  function artFallback(art, it) {
    var na = el('span', 'noart');
    na.appendChild(el('small', '', svcName(it.service)));
    var b = el('b', '', it.title);
    var len = it.title.length;
    b.style.setProperty('--ka-fs', (len > 40 ? 15 : len > 22 ? 18 : 22) + 'px');
    na.appendChild(b);
    art.insertBefore(na, art.firstChild);
  }
  /*
   * Art candidates, sharpest first (it.images, or Shape.ytThumbs() of it.image: YouTube maxres webp,
   * maxres jpg, sd, hq, the page's own still). A miss (load error, or YouTube's 120x90 grey "no
   * maxres" body) steps to the next. Misses are kept for this page only, so a repaint never
   * re-requests a 404. Plain image loads: no-referrer, and i.ytimg.com is YouTube's cookieless host.
   */
  var ART_MISS = new Set();
  function artMissKey(u) { return String(u).replace('/vi_webp/', '/vi/').replace(/\.webp$/, '.jpg'); }
  function artSrcs(it, needPx) {
    var list = arr(it.images).length > 1 && it.images[0] === it.image ? it.images
      : Shape && typeof Shape.ytThumbs === 'function' ? Shape.ytThumbs(it.image) : [it.image];
    list = artOrder(list, needPx);
    var left = list.filter(function (u) { return u && !ART_MISS.has(artMissKey(u)); });
    return left.length ? left : list.slice(-1);
  }
  /*
   * Which of YouTube's stills to ask for first. The DECODE is what costs, not the bytes
   * (watch-design-e2e --trace, 10-17, 125% scaling, on this laptop): a tile's 1280x720 maxres webp
   * took 78 ms a decode on the raster workers, 137 ms at worst (Chromium decodes webp to RGB at full
   * size, then scales it), an sd JPEG 2-6 ms (decoded straight to YUV); a row of webp tiles starved
   * the frames (frames over 20 ms 13 -> 21, max 50 -> 150 ms). img.decode() of one 1280x720 picture,
   * median of 12: webp 50 ms, JPEG 12 ms. So:
   *   - JPEG before webp, always: the same picture for a quarter of the decode;
   *   - a tile starts at sd when sd covers it in DEVICE pixels (sd's 16:9 picture is 640 wide: 4:3
   *     with bars, which artCrop crops; at 125% the tiles are 360-450 px, and watch.css keeps every
   *     tile under ~370 CSS px, so that is every tile up to ~175% scaling), a wider one at maxres;
   *     hq (480 wide) is never first;
   *   - the hero (needPx Infinity) starts at maxres.
   * Only YouTube's named stills move, and only among their own places: a Short's vertical still
   * stays first, the page's own still stays last. The rest stay behind as fallbacks.
   */
  var YT_STILL = /\/vi(?:_webp)?\/[A-Za-z0-9_-]{11}\/(maxresdefault|sddefault|hqdefault)(?:_live)?\.(jpg|webp)(?:\?|$)/;
  var SD_PICTURE_W = 640;
  function artOrder(list, needPx) {
    var slots = [];
    var named = [];
    list.forEach(function (u, k) {
      var m = YT_STILL.exec(String(u));
      if (m) { slots.push(k); named.push({ u: u, name: m[1], webp: m[2] === 'webp' ? 1 : 0, k: k }); }
    });
    if (named.length < 2) return list;
    var pref = needPx > SD_PICTURE_W ? ['maxresdefault', 'sddefault', 'hqdefault'] : ['sddefault', 'maxresdefault', 'hqdefault'];
    named.sort(function (a, b) { return pref.indexOf(a.name) - pref.indexOf(b.name) || a.webp - b.webp || a.k - b.k; });
    var out = list.slice();
    slots.forEach(function (k, i) { out[k] = named[i].u; });
    return out;
  }
  /* The tiles' width in CSS px (watch.css --card-w), from a hidden probe a ResizeObserver reads after
     layout, so choosing a still never forces one. Before the first reading: the widest a tile gets
     (per >= 3 within a 1720 px column, watch.css) stands in, which errs sharp. */
  var TILE = { css: 0, probe: null };
  function tileNeedPx() {
    if (!TILE.probe && document.body && typeof ResizeObserver === 'function') {
      TILE.probe = el('div', 'tile-probe');
      TILE.probe.setAttribute('aria-hidden', 'true');
      document.body.appendChild(TILE.probe);
      new ResizeObserver(function (en) { var w = en[0] && en[0].contentRect ? en[0].contentRect.width : 0; if (w > 0) TILE.css = w; }).observe(TILE.probe);
    }
    var css = TILE.css || Math.min(380, Math.max(240, (window.innerWidth || 1280) / 3));
    return Math.ceil(css * (window.devicePixelRatio || 1));
  }
  function artLoad(img, it, fail, hero) {
    var srcs = artSrcs(it, hero ? Infinity : tileNeedPx());
    var i = 0;
    var step = function () {   // false when no candidate is left
      if (ART_MISS.size > 4000) ART_MISS.clear();
      ART_MISS.add(artMissKey(srcs[i]));
      for (i++; i < srcs.length; i++) if (!ART_MISS.has(artMissKey(srcs[i]))) { img.src = srcs[i]; return true; }
      return false;
    };
    img.addEventListener('load', function () {
      if (srcs.length > 1 && img.naturalWidth <= 120) { if (!step()) fail(); return; }
      artCrop(img, srcs[i]);
      if (hero) artSoften(img);
    });
    img.addEventListener('error', function () { if (!step()) fail(); });
    img.src = srcs[0];
  }
  /* YouTube's sd/hq stills are 4:3 with black bars above and below the 16:9 picture: show only the
     picture (the middle 75%), so cover never lets a bar in, whatever the box or object-position. */
  function artCrop(img, src) {
    var nh = img.naturalHeight;
    var bars = /\/(?:sd|hq)default(?:_live)?\.jpg(?:\?|$)/.test(src) && nh > 0 && Math.abs(img.naturalWidth / nh - 4 / 3) < 0.03;
    if (bars) { img.dataset.crop = '16:9'; img.style.setProperty('object-view-box', 'inset(12.5% 0% 12.5% 0%)'); }
    else if (img.dataset.crop) { delete img.dataset.crop; img.style.removeProperty('object-view-box'); }
  }
  /* Hero only: a still blown up past ~1.6x (only hq exists) is softened so its JPEG blocks don't show. */
  function artSoften(img) {
    var r = img.getBoundingClientRect();
    var shown = (img.naturalHeight || 1) * (img.dataset.crop ? 0.75 : 1);
    var scale = Math.max(r.width / (img.naturalWidth || 1), r.height / shown);
    if (!(scale > 1.6)) { img.removeAttribute('data-lowres'); img.style.filter = ''; img.style.transform = ''; return; }
    img.dataset.lowres = '1';
    img.style.filter = 'blur(' + Math.min(5, (scale - 1) * 1.6).toFixed(1) + 'px)';
    img.style.transform = 'scale(1.04)';
  }
  function washSrc(it) { var l = arr(it.images); return l.length > 1 ? l[l.length - 1] : it.image; }

  function artImage(art, it, lazy, hero) {
    if (!it.image) { artFallback(art, it); return; }
    var img = el('img');
    img.alt = '';
    if (lazy) img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    // The hero is the page's biggest picture (maxres) and the first thing looked at: it goes first on
    // the one connection to i.ytimg.com it shares with every tile (r64), instead of waiting for layout
    // to raise it from the default image priority.
    if (hero) img.fetchPriority = 'high';
    artLoad(img, it, function () {
      if (img.parentNode) img.parentNode.removeChild(img);
      artFallback(art, it);
    }, hero);
    art.insertBefore(img, art.firstChild);
  }

  function cardSub(it, m) {
    if (it.kind === 'resume') return (window.LumenPlay && window.LumenPlay.resumeLabel(it)) || joinDot([epText(it.subtitle), timeLeft(it)]);
    if (it.kind === 'upcoming' && it.startsAt) return joinDot([it.subtitle, dayClock(it.startsAt)]);
    if (it.kind === 'live') return joinDot([it.subtitle, 'Live now']);
    if (it.subtitle) return it.kind === 'watchlist' || it.service === 'youtube' ? it.subtitle : epText(it.subtitle);
    if (it.group && (!m || it.group !== m.title)) return it.group;
    return m && m.service ? '' : (KIND_WORD[it.kind] || '');
  }

  function cardEl(it, m) {
    var c = button('card');
    c.dataset.key = itemKey(it);
    c._item = it;
    var stale = staleSvc(it.service) ? svcOf(it.service) : null;
    if (stale) c.classList.add('stale');

    var frame = el('span', 'frame');
    frame.appendChild(el('span', 'shade'));
    var art = el('span', 'art');
    artImage(art, it, true);
    var hasProg = it.kind === 'resume' && typeof it.progress === 'number';
    if (hasProg) art.appendChild(el('span', 'grad'));
    // One small mark per service that carries it, always in the same corner; a badge (Hulu, Rent) after.
    var chips = el('span', 'chips');
    if (!m.service || stale || it.also.length) {
      [it.service].concat(it.also.map(function (a) { return a.service; })).forEach(function (id, n) {
        var mk = el('span', 'chip oa mk' + (stale && !n ? ' stale' : ''));
        mk.dataset.svc = id;
        if (stale && !n) mk.appendChild(el('span', 'dot'));
        mk.appendChild(document.createTextNode(svcShort(id)));
        chips.appendChild(mk);
      });
    }
    if (it.badge && fold(it.badge) !== fold(svcShort(it.service))) chips.appendChild(el('span', 'chip oa bd', it.badge));
    if (chips.childNodes.length) art.appendChild(chips);
    if (hasProg) {
      var prog = el('span', 'prog');
      var bar = el('i');
      bar.style.setProperty('--p', String(it.progress));
      prog.appendChild(bar);
      art.appendChild(prog);
    } else if (it.kind === 'live') {
      art.appendChild(el('span', 'live', 'Live'));
    } else if (it.durationSec && it.service === 'youtube') {
      art.appendChild(el('span', 'len', lenText(it.durationSec)));
    }
    if (it.edge) {
      var hint = el('span', 'hint', 'Opens in Edge');
      if (DRM.reason) hint.title = 'Quartz can’t play it: ' + DRM.reason;
      hint.appendChild(icon('out', 's'));
      art.appendChild(hint);
    }
    frame.appendChild(art);
    frame.appendChild(el('span', 'ring'));
    c.appendChild(frame);

    var meta = el('span', 'm');
    meta.appendChild(el('b', '', it.title));
    var sub = cardSub(it, m);
    if (stale) {
      var ss = agoSpan('stale', stale.lastOkAt || stale.readAt, sub ? sub + ' \u00b7 as of ' : 'As of ');
      meta.appendChild(ss);
    } else meta.appendChild(el('span', '', sub || '\u00a0'));
    c.appendChild(meta);

    c.setAttribute('aria-label', joinDot([it.title, svcName(it.service), sub, stale ? 'from an earlier read' : '']) + '. ' +
      (it.edge ? 'Opens in Microsoft Edge.' : opensHere(true)));
    if (it.also.length) c.setAttribute('aria-label', c.getAttribute('aria-label') + ' Also on ' + listWords(it.also.map(function (a) { return svcName(a.service); })) + '.');
    if ((it.yt || it.ytState) && window.WatchYt) window.WatchYt.card(c, it, m);
    return c;
  }

  /* --- a game ------------------------------------------------------------ */

  function clockText(ev) {
    if (ev.state === 'in') return ev.detail || 'Live';
    if (ev.state === 'post') return /^final/i.test(ev.detail) ? ev.detail : 'Final';
    return dayClock(ev.startsAt) || ev.detail;
  }
  function logoEl(team, cls) {
    var l = el('span', 'logo' + (cls ? ' ' + cls : ''));
    if (team.logo) {
      var img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.removeChild(img);
        l.classList.add('none');
        l.textContent = team.abbr;
      }, { once: true });
      img.src = team.logo;
      l.appendChild(img);
    } else {
      l.classList.add('none');
      l.textContent = team.abbr;
    }
    return l;
  }
  function scoreOf(t) { var n = parseFloat(t.score); return isFinite(n) ? n : null; }
  function gameTitle(ev) { return ev.away.name + ' at ' + ev.home.name; }

  function gameEl(ev) {
    var wrap = el('div', 'gw');
    var g = button('gc');
    g.dataset.key = ev.id;
    g._event = ev;
    var t1 = el('span', 't1');
    if (ev.state === 'in') t1.appendChild(el('span', 'live', 'Live'));
    t1.appendChild(el('span', 'net', joinDot([ev.leagueName, ev.broadcasts.slice(0, 2).join(', ')])));
    t1.appendChild(el('span', 'c' + (ev.state === 'post' ? ' fin' : ''), clockText(ev)));
    g.appendChild(t1);
    var as = scoreOf(ev.away), hs = scoreOf(ev.home);
    [ev.away, ev.home].forEach(function (t, i) {
      var mine = i ? hs : as, theirs = i ? as : hs;
      var lo = ev.state !== 'pre' && mine !== null && theirs !== null && mine < theirs;
      var tm = el('span', 'tm' + (lo ? ' lo' : ''));
      tm.appendChild(logoEl(t));
      var nm = el('span', 'nm', t.name);
      if (ev.state === 'pre' && t.record) nm.appendChild(el('small', '', t.record));
      tm.appendChild(nm);
      tm.appendChild(el('span', 's', ev.state === 'pre' ? '' : t.score));
      g.appendChild(tm);
    });
    var ft = el('span', 'ft', window.LumenSports ? window.LumenSports.cardFoot(ev) : ev.edge ? 'Opens in Edge' : 'Opens Gamecast');
    ft.appendChild(icon('out', 's'));
    g.appendChild(ft);
    var label = gameTitle(ev) + '. ' + joinDot([ev.leagueName, ev.state === 'in' ? 'live, ' + clockText(ev) : clockText(ev)]);
    if (ev.state !== 'pre' && ev.away.score !== '' && ev.home.score !== '') label += '. ' + ev.away.abbr + ' ' + ev.away.score + ', ' + ev.home.abbr + ' ' + ev.home.score;
    g.setAttribute('aria-label', label + '. ' + (window.LumenSports ? 'Opens the game page.' : ev.edge ? 'Opens in Microsoft Edge.' : opensHere(true)));
    wrap.appendChild(g);
    var m = el('span', 'm');
    m.appendChild(el('b', '', gameTitle(ev)));
    m.appendChild(el('span', '', joinDot([ev.state === 'in' ? clockText(ev) : ev.state === 'post' ? 'Final' : (dayClock(ev.startsAt) || ev.detail), ev.leagueName, ev.state === 'post' ? '' : ev.broadcasts[0]])));
    wrap.appendChild(m);
    // Pin this game's score to the desktop (watch/pinbutton.js, score-pins-main.js).
    if (window.ScorePinButton) wrap.appendChild(window.ScorePinButton.make(ev));
    return wrap;
  }

  /* --------------------------------------------------------------- the lens */

  function activate(i, opts) {
    opts = opts || {};
    var rows = S.rowEls;
    if (!rows.length) { $.lpos.textContent = ''; return; }
    i = clamp(i, 0, rows.length - 1);
    S.cur = i;
    S.curKey = rows[i].dataset.key || '';
    var maxD = deepestRow(rows);
    rows.forEach(function (r, j) {
      var d = j - i;
      r.dataset.d = d >= 0 && d <= maxD ? String(d) : d > maxD ? 'far' : d === -1 ? '-1' : '-far';
    });
    if (opts.instant) $.stack.classList.add('instant');
    setCompact(i > 0, opts.instant);
    if (window.WatchTilePreview) window.WatchTilePreview.check();   // a row step: the previewing tile left the lens
    // --lift (watch.css) is 0 at the top and moves the lens up under the slim bar once the hero is gone
    $.stack.style.transform = 'translateY(calc(' + (-rows[i].offsetTop) + 'px + var(--lift)))';
    if (opts.instant) { void $.stack.offsetWidth; $.stack.classList.remove('instant'); }
    $.lpos.textContent = rows.length > 1 ? (i + 1) + ' / ' + rows.length : '';
    $.lup.disabled = i === 0;
    $.ldn.disabled = i === rows.length - 1;
    var c = rovingCard(rows[i]);
    if (c && c.classList.contains('sk-card')) c = null;
    if (c) {
      mark(c);
      if (opts.focus) c.focus({ preventScroll: true });
    }
  }

  /*
   * The top, two states. At the first row: the hero (the stage) and the full bar, as Watch opens.
   * Past it: the hero fades up and away, the bar turns opaque, and the lens rises under it, so most
   * of the window is rows. Watch has no document scroll (the rows step through the lens), so the
   * lens position IS the trigger: no scroll handler, no layout read; one class, and transform and
   * opacity transitions on the shared spring (watch.css body.is-compact).
   */
  function setCompact(on, instant) {
    if (S.compact === on) return;
    S.compact = on;
    if (on) previewStop();        // the stage fades away: so does its preview
    var b = document.body;
    if (instant) b.classList.add('top-instant');
    b.classList.toggle('is-compact', on);
    if (instant) { void b.offsetWidth; b.classList.remove('top-instant'); }
  }

  /*
   * How deep below the lens a row can still be on screen (2 to 4, watch.css .lrow[data-d]): from the
   * lens's highest line (--lens-c, under the slim bar) and the row pitch. Rows past it are "far" and
   * stay still: a row that cannot be seen gets no scale and fade on every step (each one is three
   * animations, and they were most of a step's work on a 1000 px window, where depths 3 and 4 are
   * below the bottom edge). Cached per window height and pitch; the reads are already-clean layout.
   */
  function deepestRow(rows) {
    if (rows.length < 2) return 4;
    var pitch = rows[1].offsetTop - rows[0].offsetTop;
    var key = window.innerHeight + 'x' + pitch;
    if (S.deepKey === key) return S.deep;
    var lensC = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lens-c')) || 78;
    S.deepKey = key;
    S.deep = pitch > 0 ? clamp(Math.floor((window.innerHeight - lensC - 1) / pitch), 2, 4) : 4;
    return S.deep;
  }

  function rowIndexOf(rowEl) { return S.rowEls.indexOf(rowEl); }

  function mark(card) {
    if (!card) return;
    var row = card.closest('.lrow');
    if (!row) return;
    var prev = $.stack.querySelectorAll('.cur');
    for (var i = 0; i < prev.length; i++) if (prev[i] !== card) prev[i].classList.remove('cur');
    card.classList.add('cur');
    S.pick[row.dataset.key] = card.dataset.key;
    setRoving(row, card);
    if (row._row) row._row.ensure(card);
    showStage(row, card);
  }

  /* Up/Down: the card in the next row nearest the same column. */
  function stepRow(dir, fromCard) {
    var target = S.cur + dir;
    if (target < 0 || target >= S.rowEls.length) return;
    var row = S.rowEls[target];
    var card = null;
    if (fromCard) {
      var a = fromCard.getBoundingClientRect(), ax = a.left + a.width / 2, best = Infinity;
      cardsOf(row).forEach(function (c) {
        var b = c.getBoundingClientRect();
        var d = Math.abs(b.left + b.width / 2 - ax);
        if (d < best) { best = d; card = c; }
      });
    }
    if (card) setRoving(row, card);
    activate(target, { focus: !!fromCard || $.stack.contains(document.activeElement) });
  }

  /* -------------------------------------------------------------- the stage */

  function showStage(row, card) {
    var m = row._model;
    if (!m) return;
    var it = card._item || null, ev = card._event || null;
    var key = row.dataset.key + '|' + card.dataset.key;
    var sig = row._sig || '';
    if (key === S.stageKey && sig === S.stageSig) return;
    var first = !S.stageKey || key === S.stageKey;   // same title, fresher data: no swap animation
    S.stageKey = key;
    S.stageSig = sig;
    S.stageIt = it;
    S.stageEv = ev;
    var tm = !it && !ev && card._team && window.LumenSports ? card._team : null;   // a My teams card with no game to show
    var build = function () { return tm ? window.LumenSports.stageTeam(tm) : ev ? stageEvent(ev, m) : stageItem(it, m); };
    swapStage(build, first);
    if (ev) setWash({ key: 'ev:' + ev.id, logos: [ev.away.logo, ev.home.logo] });
    else setWash(it && it.image ? { key: 'it:' + it.image, image: washSrc(it) } : null);
  }

  function swapStage(build, instant) {
    clearTimeout(S.stageTimer);
    previewStop();                // a new title (or a redraw): the old preview's frame goes with the old stage
    var put = function () {
      var nodes = build();
      $.stage.replaceChildren.apply($.stage, nodes);
      $.stage.classList.remove('out');
      if (instant || reduced()) return;
      $.stage.classList.add('pre');
      void $.stage.offsetWidth;
      $.stage.classList.remove('pre');
    };
    if (instant || !$.stage.firstChild) { put(); return; }
    $.stage.classList.add('out');
    S.stageTimer = setTimeout(put, reduced() ? 120 : STAGE_SWAP_MS);
  }

  function h1For(text) {
    var h = el('h1', '', text);
    if (text.length > 44) h.className = 'long';
    else if (text.length > 24) h.className = 'mid';
    return h;
  }

  function opensNote(url, edge) {
    var span = el('span', 'opens', edge ? 'Opens in Microsoft Edge' : opensHere(false));
    if (edge && DRM.reason) span.title = 'Quartz can’t play it: ' + DRM.reason;
    span.appendChild(icon('out', 's'));
    return span;
  }

  function stageItem(it, m) {
    if (it.ytState && window.WatchYt) return window.WatchYt.stageState(it, m);
    var txt = el('div', 'txt');
    var eb = el('div', 'eyebrow');
    eb.appendChild(el('span', 'rn', m.title));
    [it.service].concat(it.also.map(function (a) { return a.service; })).forEach(function (id) {
      var mk = el('span', 'chip mk', svcShort(id));
      mk.dataset.svc = id;
      eb.appendChild(mk);
    });
    if (it.badge && fold(it.badge) !== fold(svcShort(it.service))) eb.appendChild(el('span', 'chip', it.badge));
    if (it.kind === 'resume' && it.subtitle) eb.appendChild(el('span', '', epText(it.subtitle)));
    txt.appendChild(eb);
    txt.appendChild(h1For(it.title));

    var meta = el('div', 'meta');
    var parts = [];
    if (it.kind === 'resume') parts.push(timeLeft(it));
    else if (it.service === 'youtube') parts.push(it.subtitle, lenText(it.durationSec));
    else parts.push(it.subtitle ? epText(it.subtitle) : '', it.group && it.group !== m.title ? it.group : (KIND_WORD[it.kind] || ''));
    if (it.kind === 'upcoming' && it.startsAt) parts.push('Starts ' + dayClock(it.startsAt));
    parts.filter(Boolean).forEach(function (p, i) {
      if (i) meta.appendChild(el('i'));
      meta.appendChild(el('span', '', p));
    });
    if (meta.childNodes.length) txt.appendChild(meta);
    if (it.kind === 'resume' && typeof it.progress === 'number') {
      var pb = el('div', 'pbar');
      var bar = el('i');
      bar.style.setProperty('--p', String(it.progress));
      pb.appendChild(bar);
      txt.appendChild(pb);
    }
    var s = svcOf(it.service);
    if (s && s.state === 'error') {
      var w = el('div', 'warnl err');
      w.appendChild(el('span', 'dot err'));
      var words = el('span', '', s.name + " couldn't be read just now. This is from ");
      words.appendChild(agoSpan('', s.lastOkAt || s.readAt, '', '.'));
      w.appendChild(words);
      txt.appendChild(w);
    }
    var acts = el('div', 'acts');
    var label = it.kind === 'resume' ? 'Resume' : it.kind === 'live' ? 'Watch live' : it.service === 'youtube' ? 'Play' : /^rent$/i.test(it.badge) ? 'Rent' : it.kind === 'upcoming' ? 'Open' : 'Watch';
    var primary = button('btn primary', '', function () { openUrl(it.url, it.title, false, it); });
    primary.appendChild(icon('play'));
    primary.appendChild(document.createTextNode(label));
    primary.setAttribute('aria-label', label + ' ' + it.title + ' on ' + svcName(it.service));
    acts.appendChild(primary);
    var epsBtn = window.LumenShows ? window.LumenShows.stageButton(it) : null;   // Episodes / Details: the show page
    if (epsBtn) acts.appendChild(epsBtn);
    acts.appendChild(opensNote(it.url, it.edge));
    if (it.yt && window.WatchYt) window.WatchYt.stageActs(acts, it);
    txt.appendChild(acts);

    var pic = el('div', 'pic');
    var w2 = el('div', 'w' + (s && s.state === 'error' ? ' stale' : ''));
    w2.setAttribute('aria-hidden', 'true');
    artImage(w2, it, false, true);
    pic.appendChild(w2);
    pic.appendChild(el('div', 'pvhit'));   // the hover preview's pointer target (watch.css)
    return [txt, pic];
  }

  function stageEvent(ev, m) {
    var txt = el('div', 'txt');
    var eb = el('div', 'eyebrow');
    eb.appendChild(el('span', 'rn', m.title));
    if (ev.state === 'in') eb.appendChild(el('span', 'live', 'Live'));
    eb.appendChild(el('span', 'chip', 'ESPN'));
    if (ev.broadcasts.length) eb.appendChild(el('span', '', ev.broadcasts.join(', ')));
    txt.appendChild(eb);
    txt.appendChild(h1For(gameTitle(ev)));
    var meta = el('div', 'meta');
    var parts = [ev.leagueName, clockText(ev)];
    if (ev.state !== 'pre' && ev.away.score !== '' && ev.home.score !== '') parts.push(ev.away.abbr + ' ' + ev.away.score + ' \u2013 ' + ev.home.score + ' ' + ev.home.abbr);
    parts.filter(Boolean).forEach(function (p, i) { if (i) meta.appendChild(el('i')); meta.appendChild(el('span', '', p)); });
    txt.appendChild(meta);
    var espn = svcOf('espn');
    if (espn && espn.state === 'error') {
      var w = el('div', 'warnl err');
      w.appendChild(el('span', 'dot err'));
      var words = el('span', '', "ESPN couldn't be read just now. These scores are from ");
      words.appendChild(agoSpan('', espn.lastOkAt || espn.readAt, '', '.'));
      w.appendChild(words);
      txt.appendChild(w);
    }
    var acts = el('div', 'acts');
    if (window.LumenSports) acts.appendChild(window.LumenSports.stageActs(ev));   // Game page, Watch this game
    else {
      var label = ev.state === 'in' ? 'Watch live' : 'Open in ESPN';
      var primary = button('btn primary', '', function () { openUrl(ev.url, eventTitle(ev)); });
      primary.appendChild(icon('play'));
      primary.appendChild(document.createTextNode(label));
      acts.appendChild(primary);
      acts.appendChild(opensNote(ev.url, ev.edge));
    }
    txt.appendChild(acts);

    var pic = el('div', 'pic');
    var board = el('div', 'board');
    board.setAttribute('aria-hidden', 'true');
    var bt = el('div', 'bt');
    if (ev.state === 'in') bt.appendChild(el('span', 'live', 'Live'));
    bt.appendChild(el('span', '', joinDot([ev.leagueName, clockText(ev)])));
    board.appendChild(bt);
    [ev.away, 'mid', ev.home].forEach(function (t) {
      if (t === 'mid') {
        var pre = ev.state === 'pre' || ev.away.score === '' || ev.home.score === '';
        board.appendChild(el('strong', pre ? 'at' : '', pre ? 'at' : ev.away.score + '\u2013' + ev.home.score));
        return;
      }
      var side = el('div', 'side');
      side.appendChild(logoEl(t));
      side.appendChild(el('span', '', t.name));
      board.appendChild(side);
    });
    pic.appendChild(board);
    pic.appendChild(el('div', 'pvhit'));   // hovering a game says why it has no preview
    return [txt, pic];
  }

  /* ------------------------------------------------------- the hover preview */
  /*
   * The user asked: "can we make this preview the video too if you hover over it". Resting on the stage
   * (pointer or keyboard focus), or on the tile the stage shows, for PREVIEW_DELAY_MS plays a
   * MUTED preview over the still (watch/preview.js says what: the YouTube video itself, or the
   * title's official trailer found on TMDB). Rules:
   *   - one preview at a time, and only while hovered: leaving, a new title on the stage, the
   *     slim top (stage hidden), search, a hidden window or a background tab all REMOVE the
   *     frame (nothing decodes while not hovered; nothing is fetched for titles not hovered)
   *   - prefers-reduced-motion: never autoplays
   *   - no video, or a player error: a small note in the corner says why, never a broken box
   * The frame fades in only once the player says it is playing (or, if its messages never
   * reach this file:// page, PREVIEW_REVEAL_MS after it loaded).
   */
  var PV = window.WatchPreview || null;
  var PREVIEW_REVEAL_MS = 2500;
  var PREVIEW_LOAD_MS = 9000;
  var P = { key: '', seq: 0, timer: 0, loadTimer: 0, revealTimer: 0, wrap: null, frame: null, origin: '', note: null, playing: false, title: '' };

  function stagePic() {
    var pic = $.stage ? $.stage.querySelector('.pic') : null;
    return pic && pic.offsetParent !== null ? pic : null;   // narrow windows hide the still: no video either
  }

  /** The pointer or focus came to rest on the stage (or its tile): start the clock. */
  function previewWant() {
    if (!S.pvOn || !S.stageKey || S.stageKey.indexOf('special:') === 0) return;   // off (a test profile): no work at all
    if (P.key === S.stageKey && (P.timer || P.wrap || P.note)) return;
    previewStop();
    if (S.compact || S.q || document.hidden || S.front === false) return;
    if (!stagePic()) return;
    P.key = S.stageKey;
    P.timer = setTimeout(previewStart, PV ? PV.PREVIEW_DELAY_MS : 600);
  }

  function previewStart() {
    P.timer = 0;
    if (!S.pvOn || P.key !== S.stageKey || S.compact || S.q || document.hidden || S.front === false) { previewStop(); return; }
    if (!PV) { previewNote('No preview: this build is missing watch/preview.js', 'err'); return; }
    if (reduced()) { previewNote('Previews don’t autoplay while Windows is set to reduce motion', ''); return; }
    var src = PV.sourceFor(S.stageIt, { event: !!S.stageEv, hasTmdbKey: !!(S.snap && S.snap.tmdb && S.snap.tmdb.hasKey) });
    P.title = S.stageIt ? S.stageIt.title : '';
    if (src.type === 'youtube') { previewMount(src.videoId, src.start); return; }
    if (src.type === 'trailer') {
      P.seq++;
      previewNote('Finding the trailer on TMDB…', 'wait');
      send('preview', { title: src.title, tv: !!src.tv, seq: P.seq });
      return;
    }
    previewNote(src.reason || 'No preview for this title', '');
  }

  window.__applyWatchPreview = function (raw) {
    if (window.WatchTilePreview && window.WatchTilePreview.onTrailer(raw)) return;   // a tile's trailer (watch-tilepreview.js)
    if (!raw || typeof raw !== 'object' || raw.seq !== P.seq || !P.key || P.key !== S.stageKey || P.wrap) return;
    if (raw.state === 'ok' && typeof raw.videoId === 'string' && raw.videoId) { previewMount(raw.videoId, 0); return; }
    previewNote(cleanText(raw.reason, 200) || 'No trailer preview for this title', raw.state === 'none' || raw.state === 'no-key' ? '' : 'err');
  };

  function previewMount(videoId, start) {
    var pic = stagePic();
    var w = pic ? pic.querySelector('.w') : null;
    var origin = PV.embedOrigin(S.pvMock);
    var url = PV.embedUrl(videoId, start, origin);
    if (!w || !url) { previewNote('No preview: ' + (url ? 'the artwork area is gone' : 'not a YouTube video id'), 'err'); return; }
    var wrap = el('div', 'pv');
    var f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    f.setAttribute('allow', 'autoplay; encrypted-media');
    f.setAttribute('tabindex', '-1');
    f.setAttribute('aria-hidden', 'true');
    f.title = 'Muted preview' + (P.title ? ': ' + P.title : '');
    f.addEventListener('load', function () {
      if (P.frame !== f) return;
      clearTimeout(P.loadTimer);
      P.loadTimer = 0;
      try { f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), P.origin); } catch (err) { /* the fallback reveal covers it */ }
      clearTimeout(P.revealTimer);
      P.revealTimer = setTimeout(previewReveal, PREVIEW_REVEAL_MS);
    });
    P.loadTimer = setTimeout(function () {
      if (P.frame !== f) return;
      previewNote('No preview: YouTube’s player didn’t load in ' + Math.round(PREVIEW_LOAD_MS / 1000) + ' s (offline?)', 'err');
    }, PREVIEW_LOAD_MS);
    wrap.appendChild(f);
    w.appendChild(wrap);
    P.wrap = wrap;
    P.frame = f;
    P.origin = origin;
    P.playing = false;
    previewNote('', '');
    f.src = url;
  }

  function previewReveal() {
    clearTimeout(P.revealTimer);
    P.revealTimer = 0;
    if (!P.wrap) return;
    P.wrap.classList.add('on');
    if (P.note) previewNote('', '');
  }

  /* The embedded player's own messages: playing -> fade in; an error -> the note, frame gone. */
  function onPreviewMessage(e) {
    if (!PV || !P.frame || e.origin !== P.origin) return;
    var cw = null;
    try { cw = P.frame.contentWindow; } catch (err) { cw = null; }
    if (!cw || e.source !== cw) return;
    var m = PV.readPlayerMessage(e.data);
    if (!m) return;
    if (m.error !== undefined) { previewNote(PV.errorWords(m.error), 'err'); return; }
    if (m.playing && !P.playing) { P.playing = true; previewReveal(); }
  }

  /** The corner note: '' clears it. A note replaces the frame (never a broken video box). */
  function previewNote(text, tone) {
    if (P.note) { P.note.remove(); P.note = null; }
    if (!text) return;
    if (tone === 'err') previewDrop();
    var pic = stagePic();
    if (!pic) return;
    var n = el('div', 'pvnote' + (tone ? ' ' + tone : ''), text);
    n.title = text;
    n.setAttribute('role', 'status');
    pic.appendChild(n);
    P.note = n;
  }

  /** Remove the frame: the document, its decoder and its network go with it. */
  function previewDrop() {
    clearTimeout(P.loadTimer); P.loadTimer = 0;
    clearTimeout(P.revealTimer); P.revealTimer = 0;
    if (P.frame) { try { P.frame.src = 'about:blank'; } catch (err) { /* going anyway */ } }
    if (P.wrap) P.wrap.remove();
    P.wrap = null;
    P.frame = null;
    P.playing = false;
  }

  function previewStop() {
    clearTimeout(P.timer); P.timer = 0;
    P.seq++;                      // a trailer answer still on its way is for nothing now
    previewDrop();
    if (P.note) { P.note.remove(); P.note = null; }
    P.key = '';
  }

  /* Is `to` (a pointer's or focus's next element) still on the stage or the tile it shows? */
  function previewKeeps(to) {
    if (!to || !to.closest) return false;
    if ($.stage.contains(to)) return true;
    var card = to.closest('.card, .gc');
    return !!(card && card.classList.contains('cur') && card.closest('.lrow[data-d="0"]'));
  }

  function previewOut(e) { if (!previewKeeps(e.relatedTarget)) previewStop(); }

  function showStageSpecial(mode) {
    S.stageKey = 'special:' + mode;
    S.stageSig = '';
    S.stageIt = null;
    S.stageEv = null;
    setWash(null);
    var en = enabledSvcs();
    var build = function () {
      var txt = el('div', 'txt special');
      var eb = el('div', 'eyebrow');
      var acts = el('div', 'acts');
      if (mode === 'boot') {
        var a = el('span', 'sk'); a.style.width = '120px'; a.style.height = '12px';
        eb.appendChild(a);
        txt.appendChild(eb);
        var h = el('span', 'sk'); h.style.width = 'min(440px, 70%)'; h.style.height = '44px'; h.style.margin = '14px 0 12px';
        txt.appendChild(h);
        var l = el('span', 'sk'); l.style.width = 'min(320px, 50%)'; l.style.height = '14px';
        txt.appendChild(l);
        var l2 = el('span', 'sk'); l2.style.width = '120px'; l2.style.height = '36px'; l2.style.marginTop = '18px'; l2.style.borderRadius = '14px';
        txt.appendChild(l2);
        return [txt];
      }
      var readers = en.filter(function (s) { return s.needsSignIn; }).map(function (s) { return s.name; });
      var espnOn = en.some(function (s) { return s.id === 'espn'; });
      var reads = (readers.length ? 'Continue watching, your watchlists and recommendations from ' + listWords(readers) : '') +
        (espnOn ? (readers.length ? ', and live scores from ESPN' : 'Live scores from ESPN') : '');
      var signedOut = en.filter(function (s) { return s.state === 'signed-out'; })[0];
      var h1Text, lede;
      if (mode === 'welcome' || mode === 'reading' || mode === 'waiting') {
        eb.appendChild(el('span', 'rn', mode === 'welcome' ? 'Welcome to Lumen' : 'Lumen'));
        h1Text = mode === 'reading' ? 'Reading your services' : 'Everything you\u2019re watching, in one place';
        lede = 'Lumen reads ' + (reads ? reads.charAt(0).toLowerCase() + reads.slice(1) : 'the services you turn on') +
          '. You sign in to each service in a Quartz tab, as usual; Lumen only reads what that sign-in already shows, and nothing leaves this PC.';
        if (mode === 'waiting') lede = capFirst(sharedPause() || (en.filter(function (s) { return s.paused; })[0] || {}).paused || '') + '. Lumen reads your services as soon as it can.';
        if (signedOut) acts.appendChild(button('btn primary', 'Sign in to ' + signedOut.name, function () { send('signin', { service: signedOut.id }); }));
        acts.appendChild(button('btn', 'Choose services', function () { send('settings', {}); }));
      } else if (mode === 'empty') {
        eb.appendChild(el('span', 'rn', 'Lumen'));
        h1Text = 'Nothing to watch here yet';
        lede = 'Your services were read, but none had anything in Continue watching, a watchlist or recommendations. Start something on a service and it shows up here.';
        acts.appendChild(button('btn', 'Read again', function () { send('refresh', { service: null }); }));
      } else if (mode === 'failing') {
        eb.appendChild(el('span', 'rn', 'Lumen'));
        h1Text = 'Lumen couldn\u2019t read your services';
        lede = 'Each service above says what went wrong, with a way to fix it. Nothing was cached from an earlier read.';
        if (window.LumenProfiles) window.LumenProfiles.emptyPick(acts, en, send);
        if (signedOut) acts.appendChild(button('btn primary', 'Sign in to ' + signedOut.name, function () { send('signin', { service: signedOut.id }); }));
        acts.appendChild(button('btn', 'Read again', function () { send('refresh', { service: null }); }));
      } else if (mode === 'failed') {
        var f = S.failure || { title: 'Lumen couldn’t start', why: '' };
        eb.appendChild(el('span', 'rn', 'Lumen'));
        h1Text = f.title;
        lede = f.why || 'Quartz did not send Lumen anything to show.';
        acts.appendChild(button('btn primary', 'Retry', retryHello));
        acts.appendChild(button('btn', 'Open Settings', function () { send('settings', {}); }));
      } else if (mode === 'forgotten' || mode === 'later') {
        // Nothing is reading: say so, say when the next read is, and offer it now.
        var nexts = en.map(function (s) { return s.next; }).filter(function (n) { return n > 0; });
        var at = nexts.length ? dayClock(Math.min.apply(null, nexts)) : '';
        eb.appendChild(el('span', 'rn', 'Lumen'));
        h1Text = mode === 'forgotten' ? 'Lumen data forgotten' : 'Nothing read yet';
        lede = (mode === 'forgotten' ? 'Everything Lumen had saved on this PC is gone. ' : '') +
          (at ? 'Lumen reads your services again at ' + at + '.' : 'Lumen reads your services again while this page is open.') +
          ' Read now to fill this page sooner.';
        acts.appendChild(button('btn primary', 'Read now', function () { send('refresh', { service: null }); }));
        acts.appendChild(button('btn', 'Choose services', function () { send('settings', {}); }));
      } else {
        eb.appendChild(el('span', 'rn', 'Lumen'));
        h1Text = 'Every service is off';
        // Lumen is opt-in (watch-main.js cleanPrefs): a new install lands here until a service is on.
        lede = 'Lumen reads nothing until you turn a service on. Settings > Lumen lists each one and what turning it on means: ' +
          'Lumen reads that service’s pages with your own sign-in, in a hidden window, and it is not made by any of them.';
        acts.appendChild(button('btn primary', 'Open Settings', function () { send('settings', {}); }));
      }
      txt.appendChild(eb);
      var hh = h1For(h1Text);
      if (!hh.className) hh.className = 'mid';
      txt.appendChild(hh);
      txt.appendChild(el('p', 'lede', lede));
      txt.appendChild(acts);
      return [txt];
    };
    swapStage(build, true);
  }

  /* ---------------------------------------------------------- the far layer */

  var W = { on: 0, key: null, timer: 0, token: 0 };
  function setWash(spec) {
    var key = spec ? spec.key : '';
    if (key === W.key) return;
    W.key = key;
    clearTimeout(W.timer);
    var token = ++W.token;
    W.timer = setTimeout(function () { paintWash(spec, token); }, WASH_DELAY_MS);
  }
  function loadImg(src) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.decoding = 'async';
      im.referrerPolicy = 'no-referrer';
      // Decoded off the main thread BEFORE the canvas draws it, so the wash's drawImage never
      // decodes inside a frame of the cross-fade.
      im.onload = function () {
        if (typeof im.decode === 'function') im.decode().then(function () { resolve(im); }, function () { resolve(im); });
        else resolve(im);
      };
      im.onerror = function () { reject(new Error('image')); };
      im.src = src;
    });
  }
  function paintWash(spec, token) {
    var cvs = $.wash.querySelectorAll('canvas');
    var off = function () { cvs[0].classList.remove('on'); cvs[1].classList.remove('on'); };
    if (!spec) { off(); return; }
    var srcs = (spec.image ? [spec.image] : arr(spec.logos)).filter(Boolean);
    if (!srcs.length) { off(); return; }
    Promise.all(srcs.map(function (s) { return loadImg(s).catch(function () { return null; }); })).then(function (imgs) {
      if (token !== W.token) return;
      imgs = imgs.filter(Boolean);
      if (!imgs.length) { off(); return; }
      var next = cvs[1 - W.on];
      var ctx = next.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, next.width, next.height);
      ctx.save();
      // Blurred once, here, at 96 x 54: scaled up it is a soft field, and it never re-blurs.
      ctx.filter = 'blur(3px) saturate(0.85)';
      if (spec.image) ctx.drawImage(imgs[0], -8, -6, 112, 66);
      else {
        ctx.drawImage(imgs[0], -6, -4, 62, 62);
        if (imgs[1]) ctx.drawImage(imgs[1], 40, -4, 62, 62);
      }
      ctx.restore();
      next.classList.add('on');
      cvs[W.on].classList.remove('on');
      W.on = 1 - W.on;
    });
  }

  /* ---------------------------------------------------------------- opening */

  /** title: the player layer's bar; multi: "Add to multiview" (watch-player.js). */
  function openUrl(url, title, multi, it) {
    var u = https(url);
    if (!u) return;
    if (Shape && !Shape.serviceForUrl(u)) { toast('Lumen only opens pages on the services it reads', { err: true }); return; }
    var msg = { url: u };
    // A tile: straight to the service's player where that is proven (watch/playurl.js), the title page
    // as its fallback; and what it is, for Up next.
    if (it && it.url === u && https(it.playUrl)) { msg.url = https(it.playUrl); msg.fallback = u; }
    if (it && it.url === u && it.id) msg.item = { id: it.id, title: it.title || '', subtitle: it.subtitle || '' };
    if (typeof title === 'string' && title) msg.title = title.slice(0, 200);
    if (multi === true) msg.multi = true;
    // a tile previewing this video: the player opens where the preview was (YouTube &t=)
    else if (window.WatchTilePreview) msg.url = window.WatchTilePreview.handoff(msg.url);
    send('open', msg);
  }
  function openCard(card, multi) {
    if (!multi && window.WatchYt && window.WatchYt.openCard(card)) return;
    var LS = window.LumenSports;
    if (LS && card._team && !multi) { LS.openTeam(card._team); return; }       // My teams -> the team page
    if (LS && card._event && !multi) { LS.openGame(card._event); return; }     // a game -> its page in Lumen
    // a show or film with a Lumen show page (watch/showpage.js): seasons, episodes, Resume SxEy. A Continue
    // tile still plays straight away (one click to resume); its stage has Episodes for the page.
    if (card._item && !multi && card._item.kind !== 'resume' && window.LumenShows) {
      var shown = false;
      try { shown = window.LumenShows.open(card._item); } catch (e) { shown = false; try { window.LumenShows.close(); } catch (e2) { /* gone */ } }
      if (shown) return;
    }
    if (card._item) openUrl(card._item.url, card._item.title, multi, card._item);
    else if (card._event) openUrl(card._event.url, eventTitle(card._event), multi);
  }
  function eventTitle(ev) {
    var a = ev && ev.away && ev.away.name, h = ev && ev.home && ev.home.name;
    return a && h ? a + ' at ' + h : cleanText(ev && (ev.name || ev.title), 120);
  }
  // "Add to multiview" from a tile's hover action or right-click (watch-tiles.js): the same open, marked.
  window.__watchOpenCard = function (card, multi) { if (card && (card._item || card._event)) openCard(card, multi === true); };
  // Lumen sports: favourites or My teams changed, so the rows rebuild from the snapshot already here.
  window.__lumenRerender = function () { if (S.ready && S.snap) renderLens(); };

  /* ----------------------------------------------------------------- toasts */

  function toast(text, opts) {
    opts = opts || {};
    var t = el('div', 'toast pre' + (opts.err ? ' err' : ''));
    t.setAttribute('role', opts.err ? 'alert' : 'status');
    t.appendChild(el('span', 't-txt', text));
    var dismiss = function () {
      if (t._gone) return;
      t._gone = true;
      if (reduced()) { t.remove(); return; }
      t.classList.add('out');
      setTimeout(function () { t.remove(); }, 60);   // .toast.out: --m-dur-xs-out, 45 ms in Lumen's set (watch.css :root)
    };
    if (opts.err) {
      var x = button('icon-btn sm', '', dismiss);
      x.setAttribute('aria-label', 'Dismiss');
      x.title = 'Dismiss';
      x.appendChild(icon('x'));
      t.appendChild(x);
    } else setTimeout(dismiss, TOAST_MS);
    $.toasts.appendChild(t);
    while ($.toasts.children.length > TOAST_MAX) $.toasts.removeChild($.toasts.firstChild);
    void t.offsetWidth;
    t.classList.remove('pre');
  }

  /* ----------------------------------------------------------------- search */

  function onInput() {
    var raw = $.q.value;
    $.find.classList.toggle('has-q', !!raw);
    var q = raw.trim().slice(0, 200);
    if (q === S.q) return;
    S.q = q;
    clearTimeout(S.searchTimer);
    if (!q) { exitSearch(); return; }
    if (S.answer && S.answer.q !== q) S.answer = null;
    S.sentSeq = -1;
    enterSearch();
    scheduleResults();
    // One letter matches his own rows here, but never goes out as a YouTube search.
    if (q.length < SEARCH_MIN_CHARS) return;
    S.searchTimer = setTimeout(function () {
      S.seq += 1;
      S.sentSeq = S.seq;
      send('search', { q: q, seq: S.seq });
    }, SEARCH_DEBOUNCE_MS);
  }

  function enterSearch() {
    if (document.body.classList.contains('searching')) return;
    closePop(false);
    document.body.classList.add('searching');
    previewStop();
    if (window.WatchTilePreview) window.WatchTilePreview.stop('search');
    setWash(null);
    $.results.hidden = false;
    S.gridPos = null;
    if (!reduced()) {
      $.results.classList.add('pre');
      void $.results.offsetWidth;
      $.results.classList.remove('pre');
    }
  }

  /* Typing renders the results at most once a frame (lumen-n-perf2): keys that land in one frame share one
     render, run in that frame (requestAnimationFrame, before its paint), so the letter and its results still
     paint together. A key that acts on the results (Enter, Down) flushes a pending render first. */
  function scheduleResults() {
    if (S.resultsRaf) return;
    S.resultsRaf = requestAnimationFrame(function () { S.resultsRaf = 0; renderResults(); });
  }
  function flushResults() {
    if (!S.resultsRaf) return;
    cancelAnimationFrame(S.resultsRaf);
    S.resultsRaf = 0;
    renderResults();
  }

  function exitSearch() {
    if (S.resultsRaf) { cancelAnimationFrame(S.resultsRaf); S.resultsRaf = 0; }
    if (window.WatchFindPage) window.WatchFindPage.close();
    S.q = '';
    S.answer = null;
    S.sentSeq = -1;
    clearTimeout(S.searchTimer);
    document.body.classList.remove('searching');
    $.results.hidden = true;
    $.results.replaceChildren();
    S.stageKey = '';
    var row = S.rowEls[S.cur], c = row ? rovingCard(row) : null;
    if (c && !c.classList.contains('sk-card')) mark(c);
  }

  function clearSearch(focusField) {
    $.q.value = '';
    $.find.classList.remove('has-q');
    exitSearch();
    if (focusField) $.q.focus();
  }

  /* One row of the grid per title: what you have (local), what TMDB knows, what YouTube found. */
  function gridRows() {
    var q = S.q, a = S.answer, snap = S.snap;
    var rows = [], byTitle = {};
    var add = function (key, row) { byTitle[key] = row; rows.push(row); return row; };
    var local = (snap && Merge) ? Merge.searchLocal(snap.items, q, 24) : [];
    local.forEach(function (raw) {
      var it = raw && raw.url ? raw : normItem(raw);
      if (!it) return;
      var k = fold(it.title);
      var row = byTitle[k] || add(k, { key: 'l:' + k, title: it.title, image: it.image, sub: '', items: {}, providers: null, elsewhere: [], yt: false, sporty: it.service === 'espn' });
      if (!row.items[it.service]) row.items[it.service] = it;
      if (!row.image && it.image) row.image = it.image;
      if (!row.sub) row.sub = joinDot([it.kind === 'resume' ? epText(it.subtitle) : it.subtitle, KIND_WORD[it.kind] || '']);
    });
    var tm = a && a.tmdb && a.tmdb.state === 'ok' ? a.tmdb.results : [];
    tm.forEach(function (r) {
      var k = fold(r.title);
      var row = byTitle[k];
      if (!row) row = add(k, { key: 't:' + k + ':' + r.year, title: r.title, image: r.image, sub: '', items: {}, providers: null, elsewhere: [], yt: false, sporty: false });
      row.sub = joinDot([r.mediaType, r.year]) || row.sub;
      if (r.image && !row.image) row.image = r.image;
      row.providers = row.providers || {};
      r.providers.forEach(function (p) {
        if (p.service && (!row.providers[p.service] || rank(p.type) < rank(row.providers[p.service].type))) row.providers[p.service] = p;
        else if (!p.service && row.elsewhere.indexOf(p.name) === -1) row.elsewhere.push(p.name);
      });
      row.tmdb = true;
    });
    var yt = a && a.youtube && a.youtube.ok ? a.youtube.items : [];
    yt.forEach(function (it) {
      var k = fold(it.title);
      var row = byTitle[k];
      if (row) { if (!row.items.youtube) row.items.youtube = it; return; }
      add(k, { key: 'y:' + itemKey(it), title: it.title, image: it.image, images: it.images, sub: joinDot([it.subtitle, lenText(it.durationSec)]), items: { youtube: it }, providers: null, elsewhere: [], yt: true, sporty: false });
    });
    return rows;
  }
  var TYPE_RANK = { stream: 0, free: 1, ads: 2, rent: 3, buy: 4 };
  function rank(t) { return TYPE_RANK[t] === undefined ? 9 : TYPE_RANK[t]; }

  function searchLinkFor(svcId, text) {
    var list = Merge ? Merge.searchLinks(text) : [];
    for (var i = 0; i < list.length; i++) if (list[i].service === svcId) return list[i].url;
    return '';
  }

  /* What one cell says and does. */
  function cellFor(row, s) {
    var it = row.items[s.id];
    if (it) {
      var label = it.kind === 'resume' ? 'Resume' : it.kind === 'live' ? 'Live now' : it.kind === 'watchlist' ? 'On your list'
        : /^rent$/i.test(it.badge) ? 'Rent' : it.service === 'youtube' ? 'Free' : 'Included';
      var sub = it.kind === 'resume' ? timeLeft(it) : '';
      return { cls: /^rent$/i.test(it.badge) ? 'pay' : 'inc', label: label, sub: sub, stale: s.state === 'error' ? s : null,
        go: function () { openUrl(it.url, it.title); }, aria: label + ': ' + row.title + ' on ' + s.name };
    }
    var p = row.providers && row.providers[s.id];
    if (p) {
      var words = { stream: 'Included', free: 'Free', ads: 'Free with ads', rent: 'Rent', buy: 'Buy' }[p.type] || 'Available';
      if (p.price && (p.type === 'rent' || p.type === 'buy')) words += ' ' + p.price;
      var url = (p.url && Shape && Shape.serviceForUrl(p.url)) ? p.url : searchLinkFor(s.id, row.title);
      return { cls: p.type === 'rent' || p.type === 'buy' ? 'pay' : 'inc', label: words, sub: p.name !== s.name ? p.name : '',
        go: function () { openUrl(url); }, aria: words + ': ' + row.title + ' on ' + p.name };
    }
    if (!s.enabled) return null;
    if (row.yt || (s.id !== 'youtube' && !row.providers && Object.keys(row.items).every(function (k) { return k === 'youtube'; }))) return null;
    if (s.id === 'espn' && !row.sporty) return null;
    if (row.tmdb) return null;              // TMDB knows, and it is not there
    if (s.needsSignIn && s.state === 'signed-out') {
      return { cls: 'sign', label: 'Sign in to check', go: function () { send('signin', { service: s.id }); }, aria: 'Sign in to ' + s.name + ' to check' };
    }
    var link = searchLinkFor(s.id, row.title);
    if (!link) return null;
    return { cls: 'look', label: 'Search', icon: true, go: function () { openUrl(link); }, aria: 'Search ' + s.name + ' for ' + row.title };
  }

  function renderResults() {
    // a render now (an answer came, the rows changed) is the one a pending typed-key render would repeat
    if (S.resultsRaf) { cancelAnimationFrame(S.resultsRaf); S.resultsRaf = 0; }
    if (!S.q) return;
    if (window.WatchFindPage && window.WatchFindPage.owns(S.q)) { window.WatchFindPage.render(); return; }
    var keepPos = gridFocusPos();
    var a = S.answer;
    var cols = services();
    var rows = gridRows();
    var tmdbRows = rows.some(function (r) { return r.tmdb; });
    var elsewhere = rows.some(function (r) { return r.elsewhere.length; });
    var frag = document.createDocumentFragment();

    var head = el('div', 'res-h');
    head.appendChild(el('h2', '', 'Where to watch'));
    var count = rows.length;
    head.appendChild(el('span', 'sub', (count ? count + (count === 1 ? ' title' : ' titles') : 'Nothing yet') + ' for \u201c' + S.q + '\u201d \u00b7 across your services'));
    head.appendChild(button('btn sm', 'Clear search', function () { clearSearch(true); }));
    frag.appendChild(head);

    var wrap = el('div', 'gridwrap');
    var table = el('table', 'wtw');
    table.setAttribute('role', 'grid');
    table.setAttribute('aria-label', 'Where to watch \u201c' + S.q + '\u201d');
    var thead = el('thead');
    var hr = el('tr');
    var th0 = el('th', 'tcol', 'Title');
    th0.scope = 'col';
    hr.appendChild(th0);
    cols.forEach(function (s) {
      var th = el('th', 'scol', s.name);
      th.scope = 'col';
      var note = colNote(s, a);
      if (note) th.appendChild(note);
      hr.appendChild(th);
    });
    if (elsewhere) { var the = el('th', 'ecol', 'Elsewhere'); the.scope = 'col'; hr.appendChild(the); }
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el('tbody');
    rows.forEach(function (row, r) {
      var tr = el('tr');
      var td0 = el('td');
      var tt = el('div', 'tt');
      var th = el('span', 'th');
      artImage(th, { title: row.title, image: row.image, images: row.images, service: '' }, true);
      tt.appendChild(th);
      var words = el('div');
      words.appendChild(el('b', '', row.title));
      if (row.sub) words.appendChild(el('span', '', row.sub));
      tt.appendChild(words);
      td0.appendChild(tt);
      tr.appendChild(td0);
      cols.forEach(function (s, c) {
        var td = el('td');
        var spec = cellFor(row, s);
        if (!spec) { td.appendChild(el('span', 'none', '\u2014')); td.lastChild.setAttribute('aria-label', 'Not on ' + s.name); }
        else {
          var b = button('cell ' + spec.cls, spec.label, spec.go);
          if (spec.icon) b.appendChild(icon('out', 's'));
          b.setAttribute('aria-label', spec.aria);
          b.dataset.r = String(r);
          b.dataset.c = String(c);
          b.tabIndex = -1;
          td.appendChild(b);
          if (spec.stale) td.appendChild(agoSpan('cell-sub stale', spec.stale.lastOkAt || spec.stale.readAt, 'as of '));
          else if (spec.sub) td.appendChild(el('span', 'cell-sub', spec.sub));
        }
        tr.appendChild(td);
      });
      if (elsewhere) tr.appendChild(el('td', 'elsewhere', row.elsewhere.join(', ') || '\u2014'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    // The last line: search each service itself for the words typed.
    var tfoot = el('tfoot');
    var fr = el('tr');
    var f0 = el('td');
    var ff = el('div', 'tt-foot');
    ff.appendChild(document.createTextNode('Search each service for '));
    ff.appendChild(el('b', '', '\u201c' + S.q + '\u201d'));
    f0.appendChild(ff);
    fr.appendChild(f0);
    var links = (a && a.links.length) ? a.links : (Merge ? Merge.searchLinks(S.q) : []);
    cols.forEach(function (s, c) {
      var td = el('td');
      var l = links.filter(function (x) { return x.service === s.id; })[0];
      if (l) {
        var b = button('cell look', 'Search ' + s.short, function () { openUrl(l.url); });
        b.appendChild(icon('out', 's'));
        b.setAttribute('aria-label', 'Search ' + s.name + ' for ' + S.q + (edgeFor(l.url) ? ', opens in Microsoft Edge' : ''));
        b.dataset.r = String(rows.length);
        b.dataset.c = String(c);
        b.tabIndex = -1;
        td.appendChild(b);
      } else td.appendChild(el('span', 'none', '\u2014'));
      fr.appendChild(td);
    });
    if (elsewhere) fr.appendChild(el('td'));
    tfoot.appendChild(fr);
    table.appendChild(tfoot);
    wrap.appendChild(table);
    frag.appendChild(wrap);

    // YouTube's own state, in words.
    var yt = a && a.youtube;
    if (!a) {
      frag.appendChild(resNote('calm', 'Looking on YouTube\u2026', ''));
    } else if (yt && !yt.ok) {
      var ytLink = searchLinkFor('youtube', S.q);
      var n = resNote(yt.state === 'off' ? 'calm' : 'err', yt.state === 'off' ? 'YouTube is off.' : "YouTube search didn't work.", yt.reason ? capFirst(yt.reason) + '.' : '');
      if (ytLink && yt.state !== 'off') n.appendChild(button('btn sm', 'Search on YouTube', function () { openUrl(ytLink); }));
      frag.appendChild(n);
    }
    if (!rows.length && a) frag.appendChild(resNote('calm', 'Nothing in your services matches \u201c' + S.q + '\u201d.', 'The links in the last line search each service itself.'));

    // The TMDB slot: plainly off until a key is added, and it says how.
    var tm = a ? a.tmdb : null;
    var hasKey = S.snap ? S.snap.tmdb.hasKey : false;
    if ((tm && tm.state === 'no-key') || (!a && !hasKey) || (!tm && a && !hasKey)) {
      frag.appendChild(tmdbSlot('Add a free TMDB key in Settings to search every service', true));
    } else if (tm && tm.state !== 'ok' && tm.state !== 'no-key') {
      frag.appendChild(tmdbSlot(tm.reason ? capFirst(tm.reason) : 'TMDB search is unavailable right now', false));
    }
    if (tmdbRows) frag.appendChild(el('p', 'attrib', (tm && tm.attribution) || 'Where-to-watch data from JustWatch, via TMDB'));

    $.results.replaceChildren(frag);
    wireGrid(table, rows.length + 1, cols.length, keepPos);
  }

  function colNote(s, a) {
    var n = null;
    if (!s.enabled) n = el('small', '', 'Off');
    else if (s.id === 'youtube' && S.q) {
      var yt = a && a.youtube;
      if (S.q.length < SEARCH_MIN_CHARS) n = el('small', '', 'Type ' + SEARCH_MIN_CHARS + '+ letters');
      else if (!a) n = el('small', '', 'Searching\u2026');
      else if (yt && !yt.ok) n = el('small', yt.state === 'off' ? '' : 'err', yt.state === 'off' ? 'Off' : "Search didn't work");
      else if (yt) n = el('small', '', yt.items.length + (yt.items.length === 1 ? ' video' : ' videos'));
    }
    if (s.enabled && s.state === 'error') {
      n = el('small', 'warn');
      n.appendChild(el('span', 'dot warn'));
      n.appendChild(agoSpan('', s.lastOkAt || s.readAt, 'From '));
    } else if (s.enabled && s.state === 'signed-out') {
      n = el('small', '');
      n.appendChild(el('span', 'dot out'));
      n.appendChild(document.createTextNode('Signed out'));
    }
    return n;
  }

  function resNote(kind, title, why) {
    var n = el('div', 'res-note' + (kind ? ' ' + kind : ''));
    n.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    var g = el('span', 'grow');
    g.appendChild(el('b', '', title));
    if (why) { g.appendChild(document.createTextNode(' ')); g.appendChild(el('span', 'why', why)); }
    n.appendChild(g);
    return n;
  }

  function tmdbSlot(text, off) {
    var slot = el('div', 'tmdb-slot');
    if (off) {
      slot.setAttribute('aria-disabled', 'true');
      slot.appendChild(el('span', 'tag', 'Not set up'));
    }
    slot.appendChild(el('span', 'tmdb-txt', text));
    slot.appendChild(button('btn sm', 'Open Settings', function () { send('settings', {}); }));
    return slot;
  }

  /* The grid is one tab stop; arrows move between its buttons. */
  function gridFocusPos() {
    var a = document.activeElement;
    if (!a || !$.results.contains(a) || !a.dataset || a.dataset.r === undefined) return null;
    return { r: +a.dataset.r, c: +a.dataset.c };
  }
  function wireGrid(table, nRows, nCols, keepPos) {
    var cells = table.querySelectorAll('.cell[data-r]');
    var at = function (r, c) { return table.querySelector('.cell[data-r="' + r + '"][data-c="' + c + '"]'); };
    if (!cells.length) return;
    var pos = keepPos || S.gridPos;
    var stop = (pos && (at(pos.r, pos.c) || nearestIn(pos.r, pos.c))) || cells[0];
    stop.tabIndex = 0;
    if (keepPos) stop.focus({ preventScroll: true });
    function nearestIn(r, c) {
      for (var d = 0; d < nCols; d++) { var x = at(r, c - d) || at(r, c + d); if (x) return x; }
      return null;
    }
    table.addEventListener('focusin', function (e) {
      var b = e.target.closest('.cell[data-r]');
      if (!b) return;
      var all = table.querySelectorAll('.cell[data-r]');
      for (var i = 0; i < all.length; i++) all[i].tabIndex = all[i] === b ? 0 : -1;
      S.gridPos = { r: +b.dataset.r, c: +b.dataset.c };
    });
    table.addEventListener('keydown', function (e) {
      var b = e.target.closest('.cell[data-r]');
      if (!b) return;
      var r = +b.dataset.r, c = +b.dataset.c, next = null, i;
      if (e.key === 'ArrowRight') { for (i = c + 1; i < nCols && !next; i++) next = at(r, i); }
      else if (e.key === 'ArrowLeft') { for (i = c - 1; i >= 0 && !next; i--) next = at(r, i); }
      else if (e.key === 'ArrowDown') { for (i = r + 1; i < nRows && !next; i++) next = at(i, c) || nearestIn(i, c); }
      else if (e.key === 'ArrowUp') { for (i = r - 1; i >= 0 && !next; i--) next = at(i, c) || nearestIn(i, c); }
      else if (e.key === 'Home') { for (i = 0; i < nCols && !next; i++) next = at(r, i); }
      else if (e.key === 'End') { for (i = nCols - 1; i >= 0 && !next; i--) next = at(r, i); }
      else return;
      e.preventDefault();
      if (next) { next.focus(); next.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    });
  }

  /* ------------------------------------------------------------------ time */

  function scheduleTick() {
    clearTimeout(S.tickTimer);
    S.tickTimer = 0;
    if (!inSight() || !S.snap) return;
    S.tickTimer = setTimeout(tick, TICK_MS);
  }
  function tick() {
    S.tickTimer = 0;
    if (!inSight()) return;
    refreshAgo();
    scheduleTick();
  }
  function refreshAgo() {
    if (!S.snap) return;
    var list = document.querySelectorAll('[data-at]');
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      e.textContent = (e.dataset.pre || '') + ago(+e.dataset.at) + (e.dataset.post || '');
    }
    S.hold.draw(drawStripPop);
  }

  /* ------------------------------------------------------------------ input */

  function isTyping(t) {
    if (!t || !t.tagName) return false;
    var tag = t.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }

  function onKey(e) {
    if (e.defaultPrevented || e.isComposing) return;
    if (window.WatchYt && window.WatchYt.onKey(e)) return;
    var t = e.target;
    var typing = isTyping(t);
    var mod = e.ctrlKey || e.metaKey || e.altKey;

    if (e.key === '/' && !typing && !mod) {
      e.preventDefault();
      closePop(false);
      $.q.focus();
      $.q.select();
      return;
    }
    if (e.key === 'Escape') {
      if (!$.pop.hidden) { e.preventDefault(); closePop(true); return; }
      if (t === $.q) {
        e.preventDefault();
        if ($.q.value) clearSearch(true);
        else { $.q.blur(); focusLens(); }
        return;
      }
      if (S.q) { e.preventDefault(); $.q.focus(); return; }
      return;
    }
    // Enter: every service's own search (watch/find-page.js); recent searches; Down into its tiles.
    if (t === $.q) flushResults();
    if (t === $.q && !mod && window.WatchFindPage && window.WatchFindPage.key(e, S.q)) { if (e.key === 'Enter') clearTimeout(S.searchTimer); return; }
    if (t === $.q && S.q && (e.key === 'ArrowDown' || e.key === 'Enter') && !mod) {
      var stop = $.results.querySelector('.cell[tabindex="0"]') || $.results.querySelector('.cell');
      if (stop) { e.preventDefault(); stop.focus(); }
      return;
    }
    if (S.q || typing || mod) return;
    if (t && t.closest && (t.closest('.top') || t.closest('.strip') || t.closest('.pop') || t.closest('.toasts'))) return;

    var card = t && t.closest ? t.closest('.card, .gc') : null;
    if (card && $.stack.contains(card)) {
      var row = card.closest('.lrow');
      var list = cardsOf(row);
      var i = list.indexOf(card), next = null;
      if (e.key === 'ArrowRight') next = list[i + 1];
      else if (e.key === 'ArrowLeft') next = list[i - 1];
      else if (e.key === 'Home') next = list[0];
      else if (e.key === 'End') next = list[list.length - 1];
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        if (rowIndexOf(row) !== S.cur) activate(rowIndexOf(row), {});
        stepRow(e.key === 'ArrowDown' || e.key === 'PageDown' ? 1 : -1, card);
        return;
      } else return;
      e.preventDefault();
      if (next) next.focus({ preventScroll: true });
      return;
    }
    // A row's own control keeps the focus after its click (the row's scroll arrows; Subscriptions' See
    // all, Library and Shorts get it back when the page they opened closes): Up/Down still step the lens
    // from that row, into the next row's tile (ignored here, they left the lens stuck on the row).
    var rowOf = t && t.closest && $.stack.contains(t) ? t.closest('.lrow') : null;
    if (rowOf && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      var ri = rowIndexOf(rowOf);
      if (ri === -1) return;
      e.preventDefault();
      if (ri !== S.cur) activate(ri, {});
      var was = S.cur;
      stepRow(e.key === 'ArrowDown' ? 1 : -1, null);
      if (S.cur !== was && document.activeElement === t) t.blur();   // a row with no tile to take it: the page has the keys
      return;
    }
    var free = !t || t === document.body || t === document.documentElement || (t.closest && (t.closest('.stage') || t.closest('.lens-ctl')));
    if (!free) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (t && t.closest && t.closest('.stage') && t.tagName === 'BUTTON') return;
      e.preventDefault();
      activate(S.cur + (e.key === 'ArrowDown' ? 1 : -1), {});
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && (t === document.body || t === document.documentElement)) {
      e.preventDefault();
      focusLens();
    }
  }

  function focusLens() {
    var c = rovingCard(S.rowEls[S.cur]);
    if (c && !c.classList.contains('sk-card')) c.focus({ preventScroll: true });
  }

  function onStackFocus(e) {
    var card = e.target.closest ? e.target.closest('.card, .gc') : null;
    if (!card || card.classList.contains('sk-card')) return;
    var row = card.closest('.lrow');
    var idx = rowIndexOf(row);
    if (idx === -1) return;
    if (idx !== S.cur) { setRoving(row, card); activate(idx, {}); }
    mark(card);
    previewWant();                // resting on it plays its preview on the stage (only while the stage shows)
  }

  function onStackClick(e) {
    var row = e.target.closest ? e.target.closest('.lrow') : null;
    if (!row) return;
    if (row.dataset.d !== '0') {
      e.preventDefault();
      var idx = rowIndexOf(row);
      if (idx !== -1) activate(idx, {});
      return;
    }
    var card = e.target.closest('.card, .gc');
    if (card && !card.classList.contains('sk-card')) openCard(card);
  }

  function onStackHover(e) {
    var card = e.target.closest ? e.target.closest('.card, .gc') : null;
    if (!card || card.classList.contains('sk-card')) return;
    var row = card.closest('.lrow');
    if (!row || row.dataset.d !== '0') return;
    clearTimeout(S.hoverTimer);
    S.hoverTimer = setTimeout(function () { if (card.isConnected) { mark(card); previewWant(); } }, HOVER_MS);
  }

  function onWheel(e) {
    if (S.q || e.ctrlKey) return;
    var t = e.target;
    if (t && t.closest && (t.closest('.results') || t.closest('.pop') || t.closest('.strip') || t.closest('.top') || t.closest('.toasts'))) return;
    if (!S.rowEls.length || document.body.classList.contains('is-empty')) return;
    var horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (horiz || e.shiftKey) {
      var rowEl = (t && t.closest && t.closest('.lrow[data-d="0"]')) || S.rowEls[S.cur];
      if (rowEl && rowEl._row) { e.preventDefault(); rowEl._row.by(horiz ? e.deltaX : e.deltaY); }
      return;
    }
    e.preventDefault();
    var now = Date.now();
    if (now - S.wheelAt < WHEEL_GAP_MS || Math.abs(e.deltaY) < 8) return;
    S.wheelAt = now;
    activate(S.cur + (e.deltaY > 0 ? 1 : -1), { focus: $.stack.contains(document.activeElement) });
  }

  function onResize() {
    if (S.resizeQueued) return;
    S.resizeQueued = true;
    requestAnimationFrame(function () {
      S.resizeQueued = false;
      S.rowEls.forEach(function (r) { if (r._row) r._row.restore(); });
      if (S.rowEls.length) activate(S.cur, { instant: true });
      if (!$.pop.hidden) placePop();
    });
  }

  /* ------------------------------------------------------------------- boot */

  function boot() {
    if (S.ready) return;
    $ = {
      wash: document.getElementById('wash'),
      q: document.getElementById('q'),
      find: document.querySelector('.find'),
      settings: document.getElementById('settings'),
      pills: document.getElementById('pills'),
      fresh: document.getElementById('fresh'),
      readAll: document.getElementById('read-all'),
      stage: document.getElementById('stage'),
      lpos: document.getElementById('lpos'),
      lup: document.getElementById('lup'),
      ldn: document.getElementById('ldn'),
      stack: document.getElementById('stack'),
      results: document.getElementById('results'),
      pop: document.getElementById('pop'),
      toasts: document.getElementById('toasts')
    };
    $.toasts.setAttribute('aria-live', 'polite');

    $.q.addEventListener('input', onInput);
    $.settings.addEventListener('click', function () { send('settings', {}); });
    $.readAll.addEventListener('click', function () { send('refresh', { service: null }); });
    $.lup.addEventListener('click', function () { activate(S.cur - 1, {}); });
    $.ldn.addEventListener('click', function () { activate(S.cur + 1, {}); });
    $.stack.addEventListener('focusin', onStackFocus);
    $.stack.addEventListener('click', onStackClick);
    $.stack.addEventListener('pointerover', onStackHover);
    // the hover preview: resting on the stage or its tile starts it, leaving both ends it
    $.stage.addEventListener('pointerover', previewWant);
    $.stage.addEventListener('focusin', previewWant);
    $.stage.addEventListener('pointerout', previewOut);
    $.stage.addEventListener('focusout', previewOut);
    $.stack.addEventListener('pointerout', previewOut);
    $.stack.addEventListener('focusout', previewOut);
    window.addEventListener('message', onPreviewMessage);
    document.addEventListener('keydown', onKey);
    if (window.WatchYt) {
      window.WatchYt.attach({ send: send, openUrl: openUrl, renderLens: function () { if (S.snap) renderLens(); }, agoSpan: agoSpan, lenText: lenText,
        artImage: artImage, icon: icon, focusLens: focusLens, previewStop: previewStop, snap: function () { return S.snap; } });
    }
    window.addEventListener('wheel', onWheel, { passive: false });
    // hover previews inside the tiles (watch-tilepreview.js): past the first row, where the hero is gone
    if (window.WatchTilePreview) {
      window.WatchTilePreview.attach({ stack: $.stack, send: send, snap: function () { return S.snap; },
        stageOwns: function () { return !S.compact && !!stagePic(); }, searching: function () { return !!S.q; },
        front: function () { return S.front !== false; }, reduced: reduced });
    }
    window.addEventListener('resize', onResize);
    // Capture phase: the hold is on before the press's own handlers run (watch/presshold.js).
    document.addEventListener('pointerdown', function (e) {
      if (e.button === 0 && e.target && ($.pills.contains(e.target) || $.pop.contains(e.target))) S.hold.press();
    }, true);
    document.addEventListener('pointerup', function () { S.hold.release(); }, true);
    document.addEventListener('pointercancel', function () { S.hold.release(); }, true);
    window.addEventListener('blur', function () { S.hold.release(); });
    document.addEventListener('pointerdown', function (e) {
      if ($.pop.hidden) return;
      if ($.pop.contains(e.target) || (e.target.closest && e.target.closest('.sp'))) return;
      closePop(false);
    });
    $.pop.addEventListener('focusout', function (e) {
      var to = e.relatedTarget;
      if (!to || $.pop.contains(to) || (to.closest && to.closest('.sp[data-svc="' + S.popFor + '"]'))) return;
      closePop(false);
    });
    document.addEventListener('visibilitychange', function () {
      // Quartz reads only while a Watch page is in sight (and pauses timed re-reads while not):
      // a minimised window here, a background tab through window.__watchFront.
      sightChanged();
    });

    if (window.WatchFindPage) {
      window.WatchFindPage.attach({
        send: send, openUrl: openUrl, toast: toast, artImage: artImage, results: $.results, input: $.q,
        snap: function () { return S.snap; }, services: services, isCurrent: function (q) { return S.q === q; },
        signin: function (id) { send('signin', { service: id }); }, settings: function () { send('settings', {}); },
        clear: function () { clearSearch(true); }
      });
    }
    if (window.LumenShows) {
      window.LumenShows.attach({ snap: function () { return S.snap; }, signin: function (id) { send('signin', { service: id }); }, settings: function () { send('settings', {}); } });
    }
    S.ready = true;
    renderBoot();
    if (S.pending) {
      var p = S.pending;
      S.pending = null;
      try { applySnapshot(p); } catch (err) { showFailure('Lumen couldn’t draw your rows', (err && err.message) || String(err)); }
    } else if (S.pendingFail) {
      showFailure('Lumen couldn’t load its saved rows', S.pendingFail);
    }
    S.pendingFail = '';
    sayHello();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
