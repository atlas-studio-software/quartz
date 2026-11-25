'use strict';

/*
 * downloads.js — the downloads instrument: a nav-row glass button that shows
 * a progress ring while anything is in flight, and a glass popover listing
 * what has come down this session.
 *
 * The renderer runs with contextIsolation ON and nodeIntegration OFF, so this
 * is plain browser script: no require(), no import, no bundler. Loaded after
 * app.js, which owns .navrow and #theme; this file only ever ADDS to the row.
 *
 * Contract with the main process (all of it optional at runtime — every call
 * site checks before it reaches):
 *
 *   api.downloads = {
 *     list(): Promise<Item[]>,                  // most recent first
 *     cancel(id), pause(id), resume(id), show(id), clear(),
 *     open(id): Promise<string>,                // '' ok, else an error string
 *     downloadUrl(url),
 *     openFolder(),                             // the Downloads folder itself
 *     setPrefs({ askWhere }),                   // main cannot read our store
 *     onUpdate(cb: (item: Item) => void): () => void
 *   }
 *   Item = { id, filename, url, savePath, state, received, total, paused,
 *            startedAt, finishedAt }
 *
 * Owned ids/classes (nothing else in the app may touch them):
 *   #downloads (the nav button), #downloads-panel (the popover, a direct child
 *   of <body> so it stacks over #views), and every .dl-* class inside it.
 *
 * MOTION. The chrome sits on a backdrop-filter, so every animated frame
 * re-blurs the pane behind it. Nothing here animates continuously: the
 * indeterminate ring and bar are stepped to 10fps, and the "done" pulse is a
 * two-frame step that runs exactly once.
 */

(function () {
  /* --- Segoe Fluent Icons ------------------------------------- */
  var GLYPH_DOWNLOAD = '\uE896';
  var GLYPH_FOLDER = '\uE838';
  var GLYPH_PAUSE = '\uE769';
  var GLYPH_PLAY = '\uE768';
  var GLYPH_CANCEL = '\uE711';
  var GLYPH_OPEN = '\uE8E5';

  /* --- state ---------------------------------------------------- */
  /** id -> Item, the newest snapshot the main process sent. */
  var items = new Map();
  /** Every id seen this session. An update for an id NOT in here is a start. */
  var seen = new Set();
  /** id -> { at, received, bps }: the rolling 1s window behind "3.1 MB/s". */
  var speeds = new Map();
  /** id -> row record, so an update repaints one row instead of the list. */
  var rows = new Map();
  /** id -> the last "couldn't open" message, kept across re-renders. */
  var notes = new Map();

  var buttonEl = null;
  var panelEl = null;
  var listEl = null;
  var open_ = false;
  var revealed = false;
  var wasActive = false;
  var pulseTimer = 0;

  /* ============================================================
     Pure helpers (exported on window.Downloads._helpers for tests)
     ============================================================ */

  /**
   * Sizes are always KB/MB/GB with one decimal — a raw byte count never
   * reaches the UI, not even for a 300 byte file ("0.3 KB").
   */
  function formatBytes(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n <= 0) return '0.0 KB';
    var KB = 1024, MB = KB * 1024, GB = MB * 1024;
    if (n >= GB) return (n / GB).toFixed(1) + ' GB';
    if (n >= MB) return (n / MB).toFixed(1) + ' MB';
    return (n / KB).toFixed(1) + ' KB';
  }

  /** The site a file came from, for a finished row. '' if the url is junk. */
  function hostnameOf(url) {
    try {
      return new URL(String(url)).hostname || '';
    } catch (err) {
      return '';
    }
  }

  /**
   * Bytes per second over a 1s window. `state` is mutated: it holds the last
   * sample, and the rate is only recomputed once a full second of progress
   * has accumulated, so the meta line does not flicker on every chunk.
   */
  function trackSpeed(state, received, now) {
    if (!state.at) {
      state.at = now;
      state.received = received;
      return state.bps || 0;
    }
    var dt = now - state.at;
    if (dt >= 1000) {
      var delta = received - state.received;
      state.bps = delta > 0 ? (delta * 1000) / dt : 0;
      state.at = now;
      state.received = received;
    }
    return state.bps || 0;
  }

  /** The second line of a row. bps is ignored unless the item is running. */
  function metaFor(item, bps) {
    if (!item) return '';
    var got = formatBytes(item.received);
    if (item.state === 'progressing') {
      var head = item.total > 0 ? got + ' of ' + formatBytes(item.total) : got + ' so far';
      if (item.paused) return head + ' · Paused';
      return bps > 0 ? head + ' · ' + formatBytes(bps) + '/s' : head;
    }
    if (item.state === 'completed') {
      var size = formatBytes(item.total > 0 ? item.total : item.received);
      var host = hostnameOf(item.url);
      return host ? size + ' · ' + host : size;
    }
    if (item.state === 'cancelled') return 'Cancelled';
    if (item.state === 'interrupted') return 'Failed';
    return '';
  }

  /* ============================================================
     The bridge. Every hop is optional and never throws upward.
     ============================================================ */

  function dl() {
    return (window.api && window.api.downloads) ? window.api.downloads : null;
  }

  /** Fire-and-forget call. A missing backend is a no-op, not an error. */
  function send(name, arg) {
    var api = dl();
    if (!api || typeof api[name] !== 'function') return;
    try {
      api[name](arg);
    } catch (err) { /* the main process is the source of truth; ignore */ }
  }

  /* --- the "ask where to save" preference ----------------------- */

  /** The settings store, if settings.js is in the build at all. */
  function settingsApi() {
    var mod = window.Settings;
    return (mod && typeof mod.get === 'function') ? mod : null;
  }

  /** What the user asked for. Anything missing means "never ask". */
  function askWhere() {
    var mod = settingsApi();
    if (!mod) return false;
    try {
      return mod.get('downloadsAskWhere') === true;
    } catch (err) {
      return false;
    }
  }

  /**
   * main owns will-download and cannot read localStorage, so the current
   * value has to be pushed to it — at boot, and again whenever it changes.
   */
  function pushPrefs() {
    send('setPrefs', { askWhere: askWhere() });
  }

  function watchPrefs() {
    pushPrefs();
    var mod = settingsApi();
    if (!mod || typeof mod.on !== 'function') return;
    try {
      mod.on(function (_snapshot, keys) {
        if (keys && typeof keys.indexOf === 'function' && keys.indexOf('downloadsAskWhere') < 0) return;
        pushPrefs();
      });
    } catch (err) { /* no subscription; the boot push still stands */ }
  }

  /** Explorer, on the Downloads folder. Nothing here needs a download first. */
  function openFolder() {
    send('openFolder');
  }

  function bpsFor(id) {
    var s = speeds.get(id);
    return s ? (s.bps || 0) : 0;
  }

  /* ============================================================
     DOM
     ============================================================ */

  function iconButton(glyph, label, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'dl-act';
    b.title = label;
    b.setAttribute('aria-label', label);
    var g = document.createElement('span');
    g.className = 'glyph';
    g.textContent = glyph;
    b.appendChild(g);
    b.addEventListener('click', onClick);
    return b;
  }

  function textButton(label, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  /** A text button with a glyph ahead of its label, for the panel header. */
  function glyphTextButton(glyph, label, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.title = label;
    var g = document.createElement('span');
    g.className = 'glyph';
    g.textContent = glyph;
    b.appendChild(g);
    var t = document.createElement('span');
    t.className = 'dl-text-label';
    t.textContent = label;
    b.appendChild(t);
    b.addEventListener('click', onClick);
    return b;
  }

  /** The nav-row instrument: same recipe as #theme, one slot to its left. */
  function injectButton() {
    if (document.getElementById('downloads')) {
      buttonEl = document.getElementById('downloads');
      return;
    }
    var navrow = document.querySelector('.navrow');
    if (!navrow) return;

    buttonEl = document.createElement('button');
    buttonEl.id = 'downloads';
    buttonEl.className = 'glass iconbtn no-drag';
    buttonEl.type = 'button';
    buttonEl.title = 'Downloads';
    buttonEl.setAttribute('aria-label', 'Downloads');
    buttonEl.setAttribute('aria-haspopup', 'dialog');
    buttonEl.setAttribute('aria-expanded', 'false');
    buttonEl.hidden = true;

    var g = document.createElement('span');
    g.className = 'glyph';
    g.textContent = GLYPH_DOWNLOAD;
    buttonEl.appendChild(g);
    buttonEl.addEventListener('click', function () { toggle(); });

    var theme = document.getElementById('theme');
    if (theme && theme.parentNode === navrow) navrow.insertBefore(buttonEl, theme);
    else navrow.appendChild(buttonEl);
  }

  /**
   * The popover lives on <body>, not inside .chrome-layer: the chrome layer
   * carries a blur filter before boot, and a fixed element there would be
   * clipped to it rather than floating over the tab well.
   */
  function buildPanel() {
    if (document.getElementById('downloads-panel')) {
      panelEl = document.getElementById('downloads-panel');
      listEl = panelEl.querySelector('.dl-list');
      return;
    }
    panelEl = document.createElement('div');
    panelEl.id = 'downloads-panel';
    panelEl.className = 'glass';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-label', 'Downloads');
    panelEl.tabIndex = -1;
    panelEl.hidden = true;

    var head = document.createElement('div');
    head.className = 'dl-head';
    var title = document.createElement('span');
    title.className = 'dl-title';
    title.textContent = 'Downloads';
    head.appendChild(title);
    head.appendChild(glyphTextButton(GLYPH_FOLDER, 'Open folder', 'dl-text dl-folder', openFolder));
    head.appendChild(textButton('Clear', 'dl-text dl-clear', clearAll));

    listEl = document.createElement('div');
    listEl.className = 'dl-list';

    panelEl.appendChild(head);
    panelEl.appendChild(listEl);
    document.body.appendChild(panelEl);
  }

  /* --- rows ---------------------------------------------------- */

  function buildRow(item) {
    var el = document.createElement('div');
    el.className = 'dl-row';
    el.dataset.id = String(item.id);

    var main = document.createElement('div');
    main.className = 'dl-main';

    var done = item.state === 'completed';
    var name = document.createElement(done ? 'button' : 'div');
    name.className = 'dl-name' + (done ? ' is-open' : '');
    name.textContent = item.filename || '';
    name.title = item.savePath || item.filename || '';
    if (done) {
      name.type = 'button';
      name.addEventListener('click', function () { openItem(item.id); });
    }
    main.appendChild(name);

    var meta = document.createElement('div');
    meta.className = 'dl-meta' + (item.state === 'cancelled' || item.state === 'interrupted' ? ' is-dim' : '');
    meta.textContent = metaFor(item, bpsFor(item.id));
    main.appendChild(meta);

    var bar = null, fill = null;
    if (item.state === 'progressing') {
      bar = document.createElement('div');
      bar.className = 'dl-bar';
      fill = document.createElement('span');
      fill.className = 'dl-fill';
      bar.appendChild(fill);
      main.appendChild(bar);
    }

    var note = document.createElement('div');
    note.className = 'dl-note';
    var stored = notes.get(item.id);
    note.textContent = stored || '';
    note.hidden = !stored;
    main.appendChild(note);

    var actions = document.createElement('div');
    actions.className = 'dl-actions';
    var pause = null;
    if (item.state === 'progressing') {
      pause = iconButton(
        item.paused ? GLYPH_PLAY : GLYPH_PAUSE,
        item.paused ? 'Resume' : 'Pause',
        function () {
          var current = items.get(item.id);
          send(current && current.paused ? 'resume' : 'pause', item.id);
        }
      );
      actions.appendChild(pause);
      actions.appendChild(iconButton(GLYPH_CANCEL, 'Cancel', function () { send('cancel', item.id); }));
    } else if (item.state === 'completed') {
      actions.appendChild(iconButton(GLYPH_OPEN, 'Open', function () { openItem(item.id); }));
      actions.appendChild(iconButton(GLYPH_FOLDER, 'Show in folder', function () { send('show', item.id); }));
    } else {
      actions.appendChild(textButton('Retry', 'dl-text dl-retry', function () {
        var current = items.get(item.id) || item;
        send('downloadUrl', current.url);
      }));
    }

    el.appendChild(main);
    el.appendChild(actions);
    return { el: el, state: item.state, name: name, meta: meta, bar: bar, fill: fill, note: note, pause: pause };
  }

  /** Indeterminate when the server never said how big the file is. */
  function paintBar(rec, item) {
    if (!rec.bar || !rec.fill) return;
    if (item.total > 0) {
      rec.bar.classList.remove('is-indeterminate');
      var pct = Math.max(0, Math.min(1, item.received / item.total)) * 100;
      rec.fill.style.transform = 'translateX(' + (pct - 100).toFixed(1) + '%)';   // downloads.css: it glides
    } else {
      rec.bar.classList.add('is-indeterminate');
      rec.fill.style.transform = '';
    }
  }

  /**
   * One row, in place. A state change rebuilds the row (its actions differ);
   * anything else patches text and width only, so hover and keyboard focus
   * survive the twenty updates a second a fast download produces.
   */
  function syncRow(item) {
    var rec = rows.get(item.id);
    if (!rec) return false;
    if (rec.state !== item.state) {
      var next = buildRow(item);
      if (rec.el.parentNode) rec.el.parentNode.replaceChild(next.el, rec.el);
      rows.set(item.id, next);
      paintBar(next, item);
      return true;
    }
    var label = item.filename || '';
    if (rec.name.textContent !== label) {
      rec.name.textContent = label;
      rec.name.title = item.savePath || label;
    }
    var meta = metaFor(item, bpsFor(item.id));
    if (rec.meta.textContent !== meta) rec.meta.textContent = meta;
    if (rec.pause) {
      var glyph = item.paused ? GLYPH_PLAY : GLYPH_PAUSE;
      var span = rec.pause.firstChild;
      if (span && span.textContent !== glyph) {
        span.textContent = glyph;
        rec.pause.title = item.paused ? 'Resume' : 'Pause';
        rec.pause.setAttribute('aria-label', item.paused ? 'Resume' : 'Pause');
      }
    }
    paintBar(rec, item);
    return true;
  }

  /** Newest first; startedAt ties break on id, which also climbs. */
  function sorted() {
    var arr = [];
    items.forEach(function (it) { arr.push(it); });
    arr.sort(function (a, b) {
      var d = (b.startedAt || 0) - (a.startedAt || 0);
      return d !== 0 ? d : (b.id - a.id);
    });
    return arr;
  }

  function render() {
    if (!listEl) return;
    rows.clear();
    listEl.textContent = '';
    var arr = sorted();
    if (!arr.length) {
      var empty = document.createElement('div');
      empty.className = 'dl-empty';
      empty.textContent = 'Nothing downloaded yet';
      listEl.appendChild(empty);
      return;
    }
    arr.forEach(function (it) {
      var rec = buildRow(it);
      rows.set(it.id, rec);
      listEl.appendChild(rec.el);
      paintBar(rec, it);
    });
  }

  function showNote(id, text) {
    notes.set(id, text);
    if (!text) notes.delete(id);
    var rec = rows.get(id);
    if (!rec) return;
    rec.note.textContent = text || '';
    rec.note.hidden = !text;
  }

  function openItem(id) {
    var api = dl();
    if (!api || typeof api.open !== 'function') return;
    var p;
    try {
      p = api.open(id);
    } catch (err) {
      return;
    }
    Promise.resolve(p).then(function (msg) {
      var text = (typeof msg === 'string') ? msg.trim() : '';
      showNote(id, text ? 'Couldn’t open: ' + text : '');
    }).catch(function () { /* the shell said nothing; leave the row alone */ });
  }

  /**
   * Clear is optimistic: the finished rows go now, and the main process is
   * told. Nothing in flight is touched.
   */
  function clearAll() {
    send('clear');
    items.forEach(function (it, id) {
      if (it.state !== 'progressing') {
        items.delete(id);
        speeds.delete(id);
        notes.delete(id);
      }
    });
    render();
  }

  /* --- the button: reveal, ring, pulse -------------------------- */

  function reveal() {
    if (revealed || !buttonEl) return;
    revealed = true;
    buttonEl.hidden = false;
  }

  /** One stepped flash of ion light, once, when the last transfer lands. */
  function pulse() {
    if (!buttonEl) return;
    buttonEl.classList.remove('pulse');
    void buttonEl.offsetWidth;            // restart the animation, not queue it
    buttonEl.classList.add('pulse');
    if (pulseTimer) clearTimeout(pulseTimer);
    pulseTimer = setTimeout(function () {
      if (buttonEl) buttonEl.classList.remove('pulse');
      pulseTimer = 0;
    }, 700);
  }

  /**
   * The ring is the sum of everything in flight, not one file: two downloads
   * read as one arc filling. An unknown total anywhere makes it indeterminate.
   */
  function syncRing() {
    if (!buttonEl) return;
    var active = 0, unknown = 0, got = 0, total = 0;
    items.forEach(function (it) {
      if (it.state !== 'progressing') return;
      active++;
      if (it.total > 0) { got += it.received; total += it.total; }
      else unknown++;
    });

    if (!active) {
      buttonEl.classList.remove('active', 'indeterminate');
      buttonEl.style.setProperty('--progress', '0');
      if (wasActive && revealed) pulse();
      wasActive = false;
      return;
    }
    wasActive = true;
    buttonEl.classList.add('active');
    if (unknown > 0 || total <= 0) {
      buttonEl.classList.add('indeterminate');
      buttonEl.style.setProperty('--progress', '0');
    } else {
      buttonEl.classList.remove('indeterminate');
      var p = Math.max(0, Math.min(1, got / total));
      buttonEl.style.setProperty('--progress', p.toFixed(3));
    }
  }

  /* --- the panel ------------------------------------------------ */

  /** The top of a pop-over hung under the chrome: the tool row's bottom
   *  plus the CSS --pop-gap (islands.css, the look's 12 air; 8 without it). */
  function popTop(r) {
    var row = buttonEl && buttonEl.closest ? buttonEl.closest('.navrow') : null;
    var rr = row && row.getBoundingClientRect ? row.getBoundingClientRect() : null;
    var bottom = rr && rr.height ? rr.bottom : r.bottom;
    var gap = NaN;
    try { gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pop-gap')); } catch (e) { gap = NaN; }
    return Math.round(bottom + (gap >= 0 ? gap : 8)) + 'px';
  }

  /** Anchored under the button's right edge; CSS holds the fallback. */
  function position() {
    if (!panelEl) return;
    if (!buttonEl || buttonEl.hidden || typeof buttonEl.getBoundingClientRect !== 'function') return;
    var r = buttonEl.getBoundingClientRect();
    if (!r || !r.width) return;
    var right = Math.max(8, Math.round(window.innerWidth - r.right));
    panelEl.style.top = popTop(r);
    panelEl.style.right = right + 'px';
  }

  function openPanel() {
    if (!panelEl) return;
    render();
    panelEl.hidden = false;
    open_ = true;
    position();
    if (buttonEl) {
      buttonEl.classList.add('is-open');
      buttonEl.setAttribute('aria-expanded', 'true');
    }
  }

  function closePanel() {
    if (!panelEl || !open_) {
      if (panelEl) panelEl.hidden = true;
      open_ = false;
      return;
    }
    panelEl.hidden = true;
    open_ = false;
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
    if (action === 'downloads') { toggle(); return true; }
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

  function ingest(item) {
    if (!item || typeof item.id !== 'number') return;
    var fresh = !seen.has(item.id);
    seen.add(item.id);
    items.set(item.id, item);

    if (item.state === 'progressing') {
      var s = speeds.get(item.id);
      if (!s) { s = { at: 0, received: 0, bps: 0 }; speeds.set(item.id, s); }
      trackSpeed(s, Number(item.received) || 0, Date.now());
    } else {
      speeds.delete(item.id);
    }

    reveal();
    syncRing();

    if (fresh) {
      // Chrome's bubble behaviour: a download that just started shows itself.
      if (item.state === 'progressing') openPanel();
      else if (open_) render();
      return;
    }
    if (open_ && !syncRow(item)) render();
  }

  function refresh() {
    var api = dl();
    if (!api || typeof api.list !== 'function') return;
    var p;
    try {
      p = api.list();
    } catch (err) {
      return;
    }
    Promise.resolve(p).then(function (list) {
      if (!Array.isArray(list) || !list.length) return;
      list.forEach(function (it) {
        if (!it || typeof it.id !== 'number') return;
        seen.add(it.id);
        items.set(it.id, it);
      });
      reveal();
      syncRing();
      if (open_) render();
    }).catch(function () { /* no history is not an error */ });
  }

  function wire() {
    var api = dl();
    if (api && typeof api.onUpdate === 'function') {
      try {
        api.onUpdate(function (item) { ingest(item); });
      } catch (err) { /* no live feed; list() at boot still populates */ }
    }

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
      if (panelEl && panelEl.contains(t)) return;
      if (buttonEl && buttonEl.contains(t)) return;
      closePanel();
    }, true);

    window.addEventListener('resize', function () {
      if (open_) position();
    });
  }

  function boot() {
    injectButton();
    buildPanel();
    wire();
    watchPrefs();
    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.Downloads = {
    open: openPanel,
    close: closePanel,
    toggle: toggle,
    isOpen: isOpen,
    handleShortcut: handleShortcut,
    openFolder: openFolder,
    // Pure helpers, reachable so they can be exercised without a window.
    _helpers: {
      formatBytes: formatBytes,
      hostnameOf: hostnameOf,
      trackSpeed: trackSpeed,
      metaFor: metaFor,
      askWhere: askWhere,
      pushPrefs: pushPrefs
    }
  };
})();
