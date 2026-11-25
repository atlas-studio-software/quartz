'use strict';

/*
 * siteinfo.js — the site instrument: a lock riding inside the left end of the
 * omnibox capsule, and a glass popover that says what this origin is, what it
 * is allowed to do, and what it has stored.
 *
 * The renderer runs with contextIsolation ON and nodeIntegration OFF, so this
 * is plain browser script: no require(), no import, no bundler. Loaded after
 * app.js, which owns .navrow and #omnibox; this file only ever ADDS to the
 * row — one absolutely-positioned button over the capsule's left padding, and
 * one padding class on #omnibox so the text never runs under it.
 *
 * Contract with the main process (all of it optional at runtime — every call
 * site feature-detects, nothing here throws upward, and no promise is waited
 * on before the first paint):
 *
 *   api.site = {
 *     info(url): Promise<{ origin, host, scheme, secure, reason, permissions, promptable } | { error }>,
 *     setPermission(origin, permission, 'allow'|'block'|'ask'): Promise<permissions>,
 *     resetPermissions(origin): Promise<void>,
 *     clearData(origin): Promise<{ cookiesRemoved } | { error }>,
 *     onPermissionsChanged(cb: ({ origin }) => void): () => void
 *   }
 *
 * Owned ids/classes (nothing else in the app may touch them):
 *   #siteinfo (the capsule button), #siteinfo-panel (the popover, a direct
 *   child of <body> so it stacks over #views), every .si-* class inside it,
 *   and the #omnibox.has-siteinfo padding class this file toggles.
 *
 * READER TABS show the article's site, not reader.html's: every url this file
 * looks at goes through readerSourceOf() first.
 *
 * MOTION. The chrome sits on a backdrop-filter, so every animated frame
 * re-blurs the pane behind it. Nothing here animates continuously: every
 * transition is stepped and none runs longer than 150ms.
 */

(function () {
  /* --- Segoe Fluent Icons ------------------------------------- */
  var GLYPH_LOCK = '\uE72E';   // Lock
  var GLYPH_WARN = '\uE7BA';   // Warning / unlocked
  var GLYPH_PAGE = '\uE7C3';   // Page (a local file)
  var GLYPH_RESET = '\uE777';  // Update / reset
  var GLYPH_DELETE = '\uE74D'; // Delete

  /* --- metrics -------------------------------------------------- */
  var BTN_SIZE = 24;   // the button box, matched in siteinfo.css
  var BTN_INSET = 4;   // its left edge inside the capsule
  var PANEL_GAP = 8;   // the gap under the button
  var PANEL_W = 340;   // the panel's width, matched in siteinfo.css
  var EDGE_GAP = 8;    // the smallest gap the panel keeps to a window edge

  /* --- the human labels ---------------------------------------- */
  // Electron names a permission the way Chromium does; these are the ones a
  // page can actually prompt for. Anything unlisted is shown raw rather than
  // guessed at, so a new Electron permission still reads as itself.
  var LABELS = {
    'media': 'Camera and microphone',
    'camera': 'Camera',
    'microphone': 'Microphone',
    'geolocation': 'Location',
    'notifications': 'Notifications',
    'midi': 'MIDI devices',
    'midiSysex': 'MIDI devices (full access)',
    'display-capture': 'Screen sharing',
    'clipboard-read': 'Read clipboard',
    'clipboard-sanitized-write': 'Write clipboard',
    'idle-detection': 'Idle detection',
    'openExternal': 'Open other apps',
    'pointerLock': 'Lock the pointer',
    'fullscreen': 'Full screen'
  };

  var CHOICES = [
    { value: 'ask', label: 'Ask' },
    { value: 'allow', label: 'Allow' },
    { value: 'block', label: 'Block' }
  ];

  /* ============================================================
     State
     ============================================================ */

  /**
   * origin -> the last info() we were told about, so switching back to a site
   * paints the right rows on the same frame rather than after a round trip.
   */
  var infos = new Map();

  /** What the instrument is looking at right now: see readActive(). */
  var active = { ok: false, url: '', origin: '', host: '', scheme: '' };

  /** The clear-site-data flow: 'idle' while the one button is showing. */
  var clearStep = 'idle';   // 'idle' | 'confirm'
  var clearMsg = '';

  /** The zoom percent as last read off the guest. Painted before it is true. */
  var zoomPct = 100;

  var open_ = false;

  // elements, built once and repainted in place
  var buttonEl = null;
  var glyphEl = null;
  var omniboxEl = null;
  var panelEl = null;
  var hostEl = null;
  var noteEl = null;
  var permsEl = null;
  var permsEmptyEl = null;
  var resetEl = null;
  var clearBtn = null;
  var confirmRow = null;
  var confirmTextEl = null;
  var msgEl = null;
  var zoomValEl = null;

  /** name -> the <select> for that permission, so rows are reused not rebuilt. */
  var permRows = new Map();

  /**
   * Where the button sits inside .navrow. place() runs on every repaint — so
   * on every tab switch — and the two rects it reads cost a synchronous
   * layout each time. The seat only moves when the row's geometry does, so
   * each answer is filed under the geometry it was measured at (the sizes the
   * ResizeObservers report, which are free) and re-used while that holds.
   * The capsule's own has-siteinfo padding is part of that geometry, so
   * hiding and showing the button costs one measurement, not one per switch.
   */
  var placeAt = Object.create(null);   // geometry key -> { left, top }
  var placeKey = '';                   // the row's geometry right now

  /** Forget every seat on file: the row itself moved, not just its size. */
  function invalidatePlace() { placeAt = Object.create(null); }

  /** Set while a re-measure is already booked for the next frame. */
  var placeBooked = false;

  /**
   * Re-measure once, on the next frame, however many things moved. The
   * instruments beside the capsule (reader, pip, the zoom badge, the shield's
   * count) appear and disappear as the active tab changes, and each of them
   * lands in its own turn; one booking covers the lot, and reading in a frame
   * callback keeps the read out of the middle of everyone else's writes.
   */
  function bookPlace() {
    if (placeBooked) return;
    placeBooked = true;
    raf(function () {
      // ...and the frame after that one has been laid out: reading the two
      // rects in the task that follows a frame is free, where the same read
      // in the middle of everyone's writes costs a full synchronous layout.
      setTimeout(function () {
        placeBooked = false;
        invalidatePlace();
        place();
        if (open_) position();
      }, 0);
    });
  }

  /* ============================================================
     Pure helpers (exported on window.SiteInfo._helpers for tests)
     ============================================================ */

  /** A parsed url, or null for anything junk. */
  function parseUrl(url) {
    try {
      return new URL(String(url));
    } catch (err) {
      return null;
    }
  }

  /** The site a url is on. '' when the url is junk, local, or absent. */
  function hostOf(url) {
    var u = parseUrl(url);
    return u ? (u.hostname || '') : '';
  }

  /**
   * The origin a url belongs to. file: urls have a null origin in Chromium,
   * so they collapse to the scheme — one bucket for every local page, which
   * is exactly how Electron stores their permissions.
   */
  function originOf(url) {
    var u = parseUrl(url);
    if (!u) return '';
    if (u.origin && u.origin !== 'null') return u.origin;
    return u.protocol ? u.protocol + '//' + (u.host || '') : '';
  }

  /** The article behind a reader url, or the url itself. */
  function targetUrl(url) {
    var s = typeof url === 'string' ? url : '';
    if (!s) return '';
    try {
      if (typeof window.readerSourceOf === 'function') {
        var src = window.readerSourceOf(s);
        if (src) return src;
      }
    } catch (err) { /* the wrapper's own url still stands */ }
    return s;
  }

  /** Is there a site worth describing here? The new-tab page has none. */
  function showsFor(url) {
    var s = typeof url === 'string' ? url : '';
    if (!s || s === 'about:blank') return false;
    try {
      if (typeof window.isNewTabUrl === 'function' && window.isNewTabUrl(s)) return false;
    } catch (err) { /* treat an unanswerable question as "it is a site" */ }
    return !!parseUrl(s);
  }

  /** The label a permission row carries. Unknown names are shown as they are. */
  function labelFor(name) {
    var key = String(name || '');
    if (!key) return '';
    return Object.prototype.hasOwnProperty.call(LABELS, key) ? LABELS[key] : key;
  }

  /** The one line under the host. Sentence case, no punctuation but the one. */
  function noteFor(info) {
    var reason = info && info.reason ? String(info.reason) : '';
    if (reason === 'certificate') return "Certificate isn't trusted";
    if (reason === 'local') return 'Local page';
    if (reason === 'http') return 'Connection is not secure';
    if (reason === 'https') return 'Connection is secure';
    return (info && info.secure) ? 'Connection is secure' : 'Connection is not secure';
  }

  /** Which glyph the capsule button wears, and how loudly. */
  function glyphFor(info) {
    if (info && info.reason === 'local') return { glyph: GLYPH_PAGE, secure: true };
    if (info && info.secure) return { glyph: GLYPH_LOCK, secure: true };
    return { glyph: GLYPH_WARN, secure: false };
  }

  /** What info() would say about a url before it has answered. */
  function guessInfo(url) {
    var u = parseUrl(url);
    var scheme = u ? u.protocol.replace(':', '') : '';
    var reason = 'other';
    if (scheme === 'https') reason = 'https';
    else if (scheme === 'http') reason = 'http';
    else if (scheme === 'file' || scheme === 'chrome' || scheme === 'devtools') reason = 'local';
    return {
      origin: originOf(url),
      host: u ? (u.hostname || '') : '',
      scheme: scheme,
      secure: reason === 'https' || reason === 'local',
      reason: reason,
      permissions: {},
      promptable: [],
      pending: true
    };
  }

  /** 'allow' | 'block' | 'ask' — absence is Ask, the Electron default. */
  function permissionOf(permissions, name) {
    if (!permissions || typeof permissions !== 'object') return 'ask';
    var v = permissions[name];
    return (v === 'allow' || v === 'block') ? v : 'ask';
  }

  /** Has this origin been given a decision on anything? Gates the reset link. */
  function hasDecision(permissions) {
    if (!permissions || typeof permissions !== 'object') return false;
    var keys = Object.keys(permissions);
    for (var i = 0; i < keys.length; i++) {
      var v = permissions[keys[i]];
      if (v === 'allow' || v === 'block') return true;
    }
    return false;
  }

  /** The webview zoom level as a percent. 1.2 per step is Chromium's ladder. */
  function zoomPercent(level) {
    var n = Number(level);
    if (!isFinite(n)) n = 0;
    return Math.round(100 * Math.pow(1.2, n));
  }

  /** The second half of the two-step clear. */
  function confirmText(host) {
    var h = String(host || '');
    return h ? 'Clear for ' + h + '?' : 'Clear this site?';
  }

  /** What the panel says once the cookies are gone. */
  function clearedText(count) {
    var n = Number(count);
    if (!isFinite(n) || n < 0) n = 0;
    n = Math.round(n);
    return 'Cleared ' + n + (n === 1 ? ' cookie' : ' cookies');
  }

  /* ============================================================
     The bridge. Every hop is optional and never throws upward.
     ============================================================ */

  function si() {
    return (window.api && window.api.site) ? window.api.site : null;
  }

  /** A promise-returning call, reduced to null when it is not there. */
  function ask(name, a, b, c) {
    var api = si();
    if (!api || typeof api[name] !== 'function') return null;
    try {
      var p = api[name](a, b, c);
      return (p && typeof p.then === 'function') ? p : null;
    } catch (err) {
      return null;
    }
  }

  /** app.js globals are read through here: this file loads with or without them. */
  function callApp(name, arg) {
    try {
      if (typeof window[name] === 'function') return window[name](arg);
    } catch (err) { /* the app is the source of truth; ignore */ }
    return undefined;
  }

  /* ============================================================
     The active tab
     ============================================================ */

  /**
   * The site the instrument is describing. `ok` is false for a Claude tab, the
   * new-tab page and about:blank — those have no origin to talk about, and the
   * button hides rather than lying.
   */
  function readActive() {
    var none = { ok: false, url: '', origin: '', host: '', scheme: '' };
    var tab = callApp('getActiveTab');
    if (!tab || tab.kind !== 'page') return none;

    var url = '';
    try {
      url = callApp('readCurrentUrl', tab) || tab.url || '';
    } catch (err) {
      url = tab.url || '';
    }

    var target = targetUrl(url);
    if (!showsFor(target)) return none;

    var u = parseUrl(target);
    return {
      ok: true,
      url: target,
      origin: originOf(target),
      host: u ? (u.hostname || '') : '',
      scheme: u ? u.protocol.replace(':', '') : ''
    };
  }

  /** The cached info for the active origin, or the guess we can make alone. */
  function activeInfo() {
    if (!active.ok) return null;
    var cached = infos.get(active.origin);
    return cached || guessInfo(active.url);
  }

  /* ============================================================
     Building the DOM
     ============================================================ */

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function clearNode(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function textNode(tag, cls, text) {
    var node = el(tag, cls);
    node.textContent = text;
    return node;
  }

  function injectButton() {
    omniboxEl = document.getElementById('omnibox');
    if (document.getElementById('siteinfo')) {
      buttonEl = document.getElementById('siteinfo');
      return;
    }
    var navrow = document.querySelector('.navrow');
    if (!navrow) return;

    buttonEl = el('button', 'no-drag');
    buttonEl.id = 'siteinfo';
    buttonEl.type = 'button';
    buttonEl.title = 'Site information';
    buttonEl.setAttribute('aria-label', 'Site information');
    buttonEl.setAttribute('aria-haspopup', 'dialog');
    buttonEl.setAttribute('aria-expanded', 'false');
    buttonEl.hidden = true;

    glyphEl = el('span', 'glyph');
    glyphEl.textContent = GLYPH_LOCK;
    buttonEl.appendChild(glyphEl);

    buttonEl.addEventListener('click', function () { toggle(); });
    navrow.appendChild(buttonEl);
  }

  /** A section: a quiet caption and the rows under it. */
  function section(title) {
    var sec = el('div', 'si-sec');
    sec.appendChild(textNode('div', 'si-cap', title));
    return sec;
  }

  /** One permission row, reused across renders; the <select> is the control. */
  function permRow(name) {
    var row = el('div', 'si-row');
    row.appendChild(textNode('span', 'si-label', labelFor(name)));

    var wrap = el('span', 'si-select');
    var sel = el('select', 'si-sel');
    sel.setAttribute('aria-label', labelFor(name));
    for (var i = 0; i < CHOICES.length; i++) {
      var opt = document.createElement('option');
      opt.value = CHOICES[i].value;
      opt.textContent = CHOICES[i].label;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', function () {
      setPermission(name, sel.value);
    });
    wrap.appendChild(sel);
    row.appendChild(wrap);

    permRows.set(name, { row: row, select: sel });
    return row;
  }

  function buildPanel() {
    if (panelEl) return;
    panelEl = el('div', 'glass');
    panelEl.id = 'siteinfo-panel';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-label', 'Site information');
    panelEl.hidden = true;

    var body = el('div', 'si-body');

    // header: the host, and what the connection to it is
    var head = el('div', 'si-head');
    hostEl = textNode('div', 'si-host', '');
    noteEl = textNode('div', 'si-note', '');
    head.appendChild(hostEl);
    head.appendChild(noteEl);
    body.appendChild(head);

    // permissions
    var perms = section('Permissions');
    permsEl = el('div', 'si-perms');
    permsEmptyEl = textNode('div', 'si-empty', 'No permissions to set');
    permsEmptyEl.hidden = true;
    resetEl = el('button', 'si-link');
    resetEl.type = 'button';
    resetEl.hidden = true;
    var resetGlyph = textNode('span', 'glyph si-link-ico', GLYPH_RESET);
    resetEl.appendChild(resetGlyph);
    resetEl.appendChild(textNode('span', null, 'Reset permissions'));
    resetEl.addEventListener('click', function () { resetPermissions(); });
    perms.appendChild(permsEl);
    perms.appendChild(permsEmptyEl);
    perms.appendChild(resetEl);
    body.appendChild(perms);

    // site data: one button that becomes its own confirmation
    var data = section('Site data');
    clearBtn = el('button', 'si-btn');
    clearBtn.type = 'button';
    clearBtn.appendChild(textNode('span', 'glyph si-btn-ico', GLYPH_DELETE));
    clearBtn.appendChild(textNode('span', null, 'Clear cookies and site data'));
    clearBtn.addEventListener('click', function () { askClear(); });

    confirmRow = el('div', 'si-confirm');
    confirmRow.hidden = true;
    confirmTextEl = textNode('span', 'si-confirm-text', '');
    var yes = textNode('button', 'si-btn si-btn--go', 'Confirm');
    yes.type = 'button';
    yes.addEventListener('click', function () { doClear(); });
    var no = textNode('button', 'si-btn', 'Cancel');
    no.type = 'button';
    no.addEventListener('click', function () { cancelClear(); });
    confirmRow.appendChild(confirmTextEl);
    confirmRow.appendChild(yes);
    confirmRow.appendChild(no);

    msgEl = textNode('div', 'si-msg', '');
    msgEl.hidden = true;

    data.appendChild(clearBtn);
    data.appendChild(confirmRow);
    data.appendChild(msgEl);
    body.appendChild(data);

    // zoom
    var zoom = section('Zoom');
    var zoomRow = el('div', 'si-row');
    zoomValEl = textNode('span', 'si-zoom-val', '100%');
    var zoomCtl = el('span', 'si-zoom-ctl');
    var minus = textNode('button', 'si-step', '−');
    minus.type = 'button';
    minus.title = 'Zoom out';
    minus.setAttribute('aria-label', 'Zoom out');
    minus.addEventListener('click', function () { stepZoom(-0.5); });
    var plus = textNode('button', 'si-step', '+');
    plus.type = 'button';
    plus.title = 'Zoom in';
    plus.setAttribute('aria-label', 'Zoom in');
    plus.addEventListener('click', function () { stepZoom(0.5); });
    var reset = textNode('button', 'si-btn si-btn--thin', 'Reset');
    reset.type = 'button';
    reset.addEventListener('click', function () { zeroZoom(); });
    zoomCtl.appendChild(minus);
    zoomCtl.appendChild(plus);
    zoomCtl.appendChild(reset);
    zoomRow.appendChild(zoomValEl);
    zoomRow.appendChild(zoomCtl);
    zoom.appendChild(zoomRow);
    body.appendChild(zoom);

    panelEl.appendChild(body);
    if (document.body) document.body.appendChild(panelEl);
  }

  /* ============================================================
     Painting
     ============================================================ */

  function paintButton() {
    if (!buttonEl) return;
    var info = activeInfo();
    var show = !!(active.ok && info);
    buttonEl.hidden = !show;
    if (omniboxEl && omniboxEl.classList) {
      // The class changes the capsule's padding; the ResizeObserver below sees
      // that as a new geometry, and each geometry keeps its own seat on file.
      if (show) omniboxEl.classList.add('has-siteinfo');
      else omniboxEl.classList.remove('has-siteinfo');
    }
    if (!show) return;

    var g = glyphFor(info);
    if (glyphEl) glyphEl.textContent = g.glyph;
    buttonEl.classList.remove(g.secure ? 'is-insecure' : 'is-secure');
    buttonEl.classList.add(g.secure ? 'is-secure' : 'is-insecure');
    place();
  }

  function paintPermissions(info) {
    var names = (info && info.promptable && typeof info.promptable.length === 'number')
      ? info.promptable : [];
    clearNode(permsEl);
    permRows.clear();
    for (var i = 0; i < names.length; i++) {
      var name = String(names[i] || '');
      if (!name) continue;
      var row = permRow(name);
      var rec = permRows.get(name);
      if (rec) rec.select.value = permissionOf(info.permissions, name);
      permsEl.appendChild(row);
    }
    if (permsEmptyEl) permsEmptyEl.hidden = names.length > 0;
    if (resetEl) resetEl.hidden = !hasDecision(info && info.permissions);
  }

  function paintPanel() {
    if (!panelEl) return;
    var info = activeInfo();
    if (!info) return;

    if (hostEl) hostEl.textContent = info.host || (info.origin || 'This page');
    if (noteEl) noteEl.textContent = noteFor(info);

    paintPermissions(info);

    if (clearBtn) clearBtn.hidden = clearStep === 'confirm';
    if (confirmRow) confirmRow.hidden = clearStep !== 'confirm';
    if (confirmTextEl) confirmTextEl.textContent = confirmText(info.host || active.host);
    if (msgEl) {
      msgEl.textContent = clearMsg;
      msgEl.hidden = !clearMsg;
    }

    if (zoomValEl) zoomValEl.textContent = String(zoomPct) + '%';
  }

  /** Paint everything from what is already known. Never waits on anything. */
  function render() {
    paintButton();
    if (open_) paintPanel();
  }

  /* ============================================================
     Pulling
     ============================================================ */

  /** Ask the backend about the active url and repaint when it answers. */
  function pullInfo() {
    if (!active.ok) return;
    var url = active.url;
    var origin = active.origin;
    var p = ask('info', url);
    if (!p) return;
    p.then(function (res) {
      if (!res || typeof res !== 'object' || res.error) return;
      var key = res.origin || origin;
      infos.set(key, {
        origin: key,
        host: res.host || hostOf(url),
        scheme: res.scheme || '',
        secure: !!res.secure,
        reason: res.reason || 'other',
        permissions: (res.permissions && typeof res.permissions === 'object') ? res.permissions : {},
        promptable: (res.promptable && typeof res.promptable.length === 'number') ? res.promptable : []
      });
      if (key === active.origin || origin === active.origin) render();
    }).catch(function () { /* the guess stands until the next answer */ });
  }

  /**
   * getZoomLevel() is synchronous on current Electron and a promise on older
   * builds, so every read goes through here — the same shape app.js uses.
   */
  function pullZoom() {
    var tab = callApp('getActiveTab');
    var view = tab && tab.viewEl;
    if (!view || typeof view.getZoomLevel !== 'function') {
      zoomPct = 100;
      return;
    }
    try {
      var current = view.getZoomLevel();
      if (current && typeof current.then === 'function') {
        current.then(function (level) {
          zoomPct = zoomPercent(typeof level === 'number' ? level : 0);
          render();
        }).catch(function () { /* the guest went away mid-call */ });
        return;
      }
      zoomPct = zoomPercent(typeof current === 'number' ? current : 0);
    } catch (err) {
      zoomPct = 100; // the guest went away mid-call
    }
  }

  /**
   * Re-read the active tab and repaint from cache on this frame, then ask the
   * backend for the fresher answer.
   */
  function refresh() {
    var before = active.origin;
    active = readActive();
    if (active.origin !== before) {
      clearStep = 'idle';
      clearMsg = '';
    }
    if (!active.ok && open_) closePanel();
    pullZoom();
    render();
    pullInfo();
  }

  /* ============================================================
     Actions
     ============================================================ */

  function setPermission(name, value) {
    var origin = active.origin;
    if (!origin || !name) return;
    // Paint the choice immediately; the backend's map replaces it when it lands.
    var info = infos.get(origin);
    if (info) {
      var next = {};
      var keys = Object.keys(info.permissions || {});
      for (var i = 0; i < keys.length; i++) next[keys[i]] = info.permissions[keys[i]];
      if (value === 'ask') delete next[name];
      else next[name] = value;
      info.permissions = next;
      infos.set(origin, info);
    }
    render();

    var p = ask('setPermission', origin, name, value);
    if (!p) return;
    p.then(function (map) {
      var rec = infos.get(origin);
      if (rec && map && typeof map === 'object' && !map.error) {
        rec.permissions = map;
        infos.set(origin, rec);
      }
      if (origin === active.origin) render();
    }).catch(function () { pullInfo(); });
  }

  function resetPermissions() {
    var origin = active.origin;
    if (!origin) return;
    var rec = infos.get(origin);
    if (rec) {
      rec.permissions = {};
      infos.set(origin, rec);
    }
    render();
    var p = ask('resetPermissions', origin);
    if (!p) return;
    p.then(function () { pullInfo(); }).catch(function () { pullInfo(); });
  }

  function askClear() {
    clearMsg = '';
    clearStep = 'confirm';
    render();
  }

  function cancelClear() {
    clearStep = 'idle';
    render();
  }

  function doClear() {
    var origin = active.origin;
    clearStep = 'idle';
    if (!origin) {
      clearMsg = 'Nothing to clear';
      render();
      return;
    }
    var p = ask('clearData', origin);
    if (!p) {
      clearMsg = 'Nothing to clear';
      render();
      return;
    }
    render();
    p.then(function (res) {
      if (!res || typeof res !== 'object' || res.error) {
        clearMsg = 'Could not clear this site';
        render();
        return;
      }
      clearMsg = clearedText(res.cookiesRemoved);
      render();
      callApp('reloadActiveTab');
    }).catch(function () {
      clearMsg = 'Could not clear this site';
      render();
    });
  }

  function stepZoom(delta) {
    callApp('zoomActiveTab', delta);
    afterZoom();
  }

  function zeroZoom() {
    callApp('resetZoom');
    afterZoom();
  }

  /**
   * The zoom badge appears and disappears in the nav row, which moves the
   * omnibox — so a zoom change re-reads the level AND re-places the button,
   * once on the next frame and once after the badge's own transition.
   */
  function afterZoom() {
    // The zoom badge appears and disappears beside the capsule, so the seat is
    // re-measured on each of the three passes rather than taken from file.
    pullZoom();
    invalidatePlace();
    render();
    raf(function () { pullZoom(); invalidatePlace(); render(); });
    setTimeout(function () { pullZoom(); invalidatePlace(); render(); }, 180);
  }

  function raf(fn) {
    try {
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(fn);
        return;
      }
    } catch (err) { /* fall through to the timer */ }
    setTimeout(fn, 16);
  }

  /* ============================================================
     Open / close
     ============================================================ */

  /** Write the offsets on file. Writing the same string back is skipped. */
  function applyPlace(at) {
    var left = at.left + 'px';
    var top = at.top + 'px';
    if (buttonEl.style.left !== left) buttonEl.style.left = left;
    if (buttonEl.style.top !== top) buttonEl.style.top = top;
  }

  /** The button rides inside the capsule's left padding; .navrow is relative. */
  function place() {
    if (!buttonEl || !omniboxEl) return;
    // The seat measured at this geometry still holds: nothing has moved.
    var hit = placeAt[placeKey];
    if (hit) { applyPlace(hit); return; }
    if (typeof omniboxEl.getBoundingClientRect !== 'function') return;
    var box = omniboxEl.getBoundingClientRect();
    if (!box || !box.width) return;
    var parent = buttonEl.parentNode;
    var base = { left: 0, top: 0 };
    if (parent && typeof parent.getBoundingClientRect === 'function') {
      var r = parent.getBoundingClientRect();
      if (r) base = r;
    }
    var at = {
      left: Math.round(box.left - base.left + BTN_INSET),
      top: Math.round(box.top - base.top + (box.height - BTN_SIZE) / 2)
    };
    // A window dragged between displays can walk through many geometries;
    // the file is small on purpose and starts over rather than growing.
    if (Object.keys(placeAt).length > 24) placeAt = Object.create(null);
    placeAt[placeKey] = at;
    applyPlace(at);
  }

  /** The top of a pop-over hung under the chrome: the tool row's bottom
   *  plus the CSS --pop-gap (islands.css, the look's 12 air; 8 without it). */
  function popTop(r) {
    var row = buttonEl && buttonEl.closest ? buttonEl.closest('.navrow') : null;
    var rr = row && row.getBoundingClientRect ? row.getBoundingClientRect() : null;
    var bottom = rr && rr.height ? rr.bottom : r.bottom;
    var gap = NaN;
    try { gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pop-gap')); } catch (e) { gap = NaN; }
    return Math.round(bottom + (gap >= 0 ? gap : PANEL_GAP)) + 'px';
  }

  /** The panel hangs under the button's left edge, inside the window. */
  function position() {
    if (!panelEl || !buttonEl || typeof buttonEl.getBoundingClientRect !== 'function') return;
    var r = buttonEl.getBoundingClientRect();
    if (!r) return;
    var width = panelEl.offsetWidth || PANEL_W;
    var maxLeft = Math.max(EDGE_GAP, (window.innerWidth || width) - width - EDGE_GAP);
    var left = Math.min(Math.max(EDGE_GAP, Math.round(r.left)), Math.round(maxLeft));
    panelEl.style.left = left + 'px';
    panelEl.style.top = popTop(r);
  }

  function openPanel() {
    if (!panelEl) return;
    refresh();
    if (!active.ok) return;
    panelEl.hidden = false;
    open_ = true;
    paintPanel();
    position();
    if (buttonEl) {
      buttonEl.classList.add('is-open');
      buttonEl.setAttribute('aria-expanded', 'true');
    }
  }

  function closePanel() {
    if (panelEl) panelEl.hidden = true;
    open_ = false;
    clearStep = 'idle';
    clearMsg = '';
    if (buttonEl) {
      buttonEl.classList.remove('is-open');
      buttonEl.setAttribute('aria-expanded', 'false');
    }
  }

  function toggle() {
    if (open_) closePanel();
    else openPanel();
  }

  function isOpen() {
    return open_;
  }

  /**
   * Forwarded from main.js (keys pressed inside a <webview> never reach this
   * document). Returns true when the action was consumed.
   */
  function handleShortcut(action) {
    if (action === 'siteinfo') { toggle(); return true; }
    if (action === 'escape') {
      if (!open_) return false;
      closePanel();
      return true;
    }
    return false;
  }

  /* ============================================================
     Wiring
     ============================================================ */

  function wire() {
    var api = si();
    if (api && typeof api.onPermissionsChanged === 'function') {
      try {
        api.onPermissionsChanged(function (ev) {
          var origin = ev && ev.origin ? String(ev.origin) : '';
          if (origin && origin !== active.origin) return;
          pullInfo();
        });
      } catch (err) { /* no live feed; info() at open still answers */ }
    }

    document.addEventListener('tabchange', function () { refresh(); });

    // Only the tab being looked at moves the instrument.
    document.addEventListener('tabloaded', function (event) {
      var tab = callApp('getActiveTab');
      var id = event && event.detail ? event.detail.id : undefined;
      if (tab && id !== undefined && tab.id !== id) return;
      refresh();
    });

    // Escape only reaches this document when focus is inside the chrome; the
    // forwarded 'escape' action covers the case where a page has focus.
    document.addEventListener('keydown', function (event) {
      if (!open_) return;
      if (event.key === 'Escape') closePanel();
    });

    // Click-outside. mousedown, so it settles before the button's own click.
    document.addEventListener('mousedown', function (event) {
      if (!open_) return;
      var t = event.target;
      if (panelEl && panelEl.contains && panelEl.contains(t)) return;
      if (buttonEl && buttonEl.contains && buttonEl.contains(t)) return;
      closePanel();
    }, true);

    window.addEventListener('resize', function () {
      invalidatePlace();
      place();
      if (open_) position();
    });

    // The omnibox narrows whenever another instrument joins the row (the zoom
    // badge above all), which moves the capsule's left edge under the button.
    // The row itself is watched too: that is the other way the seat can move.
    // The sizes these report are the geometry key place() files its answer
    // under, and they arrive without anyone reading the layout back.
    try {
      if (typeof window.ResizeObserver === 'function' && omniboxEl) {
        var dims = { box: '', row: '' };
        var onResize = function (which) {
          return function (entries) {
            var e = entries && entries.length ? entries[entries.length - 1] : null;
            var r = e && e.contentRect;
            dims[which] = r ? (Math.round(r.width) + 'x' + Math.round(r.height)) : '';
            placeKey = dims.box + '|' + dims.row;
            place();
            if (open_) position();
          };
        };
        new window.ResizeObserver(onResize('box')).observe(omniboxEl);
        var row = buttonEl && buttonEl.parentNode;
        if (row && row.nodeType === 1 && row !== omniboxEl) {
          new window.ResizeObserver(onResize('row')).observe(row);
        }
      }
    } catch (err) { /* the resize listener alone is close enough */ }

    // The capsule is capped at a width and centred by auto margins, so an
    // instrument appearing beside it (the zoom badge, reader, pip, downloads)
    // slides it sideways WITHOUT resizing it — which no ResizeObserver above
    // would see. Watching the row's own children for the attributes that can
    // move a flex line catches that, and costs nothing while nothing moves.
    try {
      var kids = buttonEl && buttonEl.parentNode;
      if (typeof window.MutationObserver === 'function' && kids && kids.nodeType === 1) {
        // Our own has-siteinfo class only changes the capsule's padding, not
        // its outer box, so a flip of just that class is not a move.
        var otherClasses = function () {
          return String((omniboxEl && omniboxEl.className) || '')
            .replace(/has-siteinfo/g, '').replace(/\s+/g, ' ').trim();
        };
        var lastClasses = otherClasses();
        new window.MutationObserver(function (list) {
          for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (m.type === 'attributes') {
              // our own paint: the button is absolute, it moves nothing
              if (m.target === buttonEl) continue;
              if (buttonEl && buttonEl.contains && buttonEl.contains(m.target)) continue;
              if (m.target === omniboxEl && m.attributeName === 'class') {
                var now = otherClasses();
                if (now === lastClasses) continue;
                lastClasses = now;
              }
            }
            bookPlace();
            return;
          }
        }).observe(kids, {
          childList: true,
          attributes: true,
          attributeFilter: ['hidden', 'class', 'style'],
          subtree: true
        });
      }
    } catch (err) { /* the observers above still cover a resize */ }

    // Two more ways the row can settle into a different shape without any of
    // the above firing: the icon font arriving after first paint, and a theme
    // swap changing the row's own metrics. Both are one-off and rare.
    try {
      window.addEventListener('load', bookPlace);
      if (document.fonts && typeof document.fonts.ready === 'object') {
        document.fonts.ready.then(bookPlace, function () { /* no font hook */ });
      }
      if (typeof window.MutationObserver === 'function') {
        new window.MutationObserver(bookPlace).observe(document.documentElement, {
          attributes: true, attributeFilter: ['data-theme']
        });
      }
    } catch (err) { /* the seat measured at boot is the right one anyway */ }
  }

  function boot() {
    injectButton();
    buildPanel();
    wire();
    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.SiteInfo = {
    open: openPanel,
    close: closePanel,
    toggle: toggle,
    isOpen: isOpen,
    refresh: refresh,
    handleShortcut: handleShortcut,
    // Pure helpers, reachable so they can be exercised without a window.
    _helpers: {
      hostOf: hostOf,
      originOf: originOf,
      targetUrl: targetUrl,
      showsFor: showsFor,
      labelFor: labelFor,
      noteFor: noteFor,
      glyphFor: glyphFor,
      guessInfo: guessInfo,
      permissionOf: permissionOf,
      hasDecision: hasDecision,
      zoomPercent: zoomPercent,
      confirmText: confirmText,
      clearedText: clearedText
    },
    // Internals the harness drives; nothing in the app may call these.
    _test: {
      readActive: readActive,
      activeInfo: activeInfo,
      refresh: refresh,
      state: function () {
        return { active: active, clearStep: clearStep, clearMsg: clearMsg, zoomPct: zoomPct };
      },
      button: function () { return buttonEl; },
      panel: function () { return panelEl; },
      permRows: function () { return permRows; }
    }
  };
})();
