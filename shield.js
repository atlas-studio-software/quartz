'use strict';

/*
 * shield.js — the ad/tracker instrument: a nav-row glass button carrying a
 * count of what was blocked on the page you are looking at, and a glass
 * popover with the two switches that decide whether anything is blocked.
 *
 * The renderer runs with contextIsolation ON and nodeIntegration OFF, so this
 * is plain browser script: no require(), no import, no bundler. Loaded after
 * app.js, which owns .navrow, #downloads and #theme; this file only ever ADDS
 * to the row, immediately before #downloads when that instrument is present.
 *
 * Contract with the main process (all of it optional at runtime — every call
 * site checks before it reaches, and nothing here blocks on a promise):
 *
 *   api.adblock = {
 *     state(): Promise<{ enabled, ready, allow: string[],
 *                        lists: { updatedAt, refreshing, error, loadError } }>,
 *                                 // lists: how fresh the filter lists are, and
 *                                 // the plain reason an update or load failed
 *     count(wcId): Promise<{ blocked, host, allowed }>,
 *     setEnabled(on),                // fire-and-forget; state-changed follows
 *     allowHost(host, on),           // fire-and-forget; state-changed follows
 *     onUpdate(cb: ({ wcId, blocked, host, allowed }) => void): () => void,
 *     onStateChanged(cb: (state) => void): () => void
 *   }
 *
 * Owned ids/classes (nothing else in the app may touch them):
 *   #shield (the nav button) and its .shield-count badge, #shield-panel (the
 *   popover, a direct child of <body> so it stacks over #views), and every
 *   .sh-* class inside it.
 *
 * MOTION. The chrome sits on a backdrop-filter, so every animated frame
 * re-blurs the pane behind it. Nothing here animates continuously: the switch
 * knob and every hover are stepped transitions, 150ms at the outside.
 */

(function () {
  /* --- Segoe Fluent Icons ------------------------------------- */
  // E83D is "Shield" in Segoe MDL2 Assets and is carried forward by Segoe
  // Fluent Icons, so it renders on both fonts named in --icon-font.
  var GLYPH_SHIELD = '\uE83D';

  /* --- state ---------------------------------------------------- */
  /** The last state() we were told about. Rendered before it is ever true. */
  var st = stateFrom(null);

  /**
   * wcId -> { blocked, host, allowed }: the newest count for every guest seen
   * this session, so switching tabs paints the right number on the same frame
   * rather than after a round trip.
   */
  var counts = new Map();

  var buttonEl = null;
  var badgeEl = null;
  var glyphEl = null;
  var panelEl = null;

  // panel parts, built once and repainted in place
  var bodyEl = null;
  var emptyEl = null;
  var bigEl = null;
  var subEl = null;
  var siteRow = null;
  var everyRow = null;
  var statusEl = null;

  var open_ = false;
  /** The active tab as this file last saw it: see readActive(). */
  var active = { ok: false, wcId: null, host: '' };

  /* ============================================================
     Pure helpers (exported on window.Shield._helpers for tests)
     ============================================================ */

  /** The site a url is on. '' when the url is junk, local, or absent. */
  function hostnameOf(url) {
    try {
      return new URL(String(url)).hostname || '';
    } catch (err) {
      return '';
    }
  }

  /** Hosts compare case-insensitively and without a leading www. */
  function normalizeHost(host) {
    var h = String(host || '').trim().toLowerCase();
    return h.indexOf('www.') === 0 ? h.slice(4) : h;
  }

  /** Is this host on the allowlist the backend last handed us? */
  function isAllowed(host, allow) {
    if (!host || !allow || typeof allow.length !== 'number') return false;
    var want = normalizeHost(host);
    if (!want) return false;
    for (var i = 0; i < allow.length; i++) {
      if (normalizeHost(allow[i]) === want) return true;
    }
    return false;
  }

  /** The badge never grows the button: four glyphs is the ceiling. */
  function formatCount(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return '';
    if (v > 999) return '999+';
    return String(Math.round(v));
  }

  var HOUR_MS = 60 * 60 * 1000;
  var DAY_MS = 24 * HOUR_MS;

  /** "just now", "5 hours ago", "yesterday", "3 days ago" (as adblock-refresh.js says it). */
  function ageWords(ms) {
    var v = Number(ms);
    if (!isFinite(v) || v < HOUR_MS) return 'just now';
    if (v < DAY_MS) {
      var h = Math.floor(v / HOUR_MS);
      return h === 1 ? '1 hour ago' : h + ' hours ago';
    }
    var d = Math.floor(v / DAY_MS);
    return d === 1 ? 'yesterday' : d + ' days ago';
  }

  /** "today", "yesterday", "3 days ago": the age of the lists in use. */
  function fromWords(ms) {
    var v = Number(ms);
    if (!isFinite(v) || v < DAY_MS) return 'today';
    return ageWords(v);
  }

  /** The backend's state, with every field defaulted (the shape is in main.js adblockState()). */
  function stateFrom(next) {
    var l = (next && next.lists && typeof next.lists === 'object') ? next.lists : {};
    return {
      enabled: !next || next.enabled !== false,
      ready: !!(next && next.ready),
      allow: (next && next.allow && typeof next.allow.length === 'number') ? next.allow : [],
      lists: {
        updatedAt: Number(l.updatedAt) || 0,
        refreshing: !!l.refreshing,
        error: typeof l.error === 'string' ? l.error : '',
        loadError: typeof l.loadError === 'string' ? l.loadError : ''
      },
      // The hook counters (adblock-hooks.js stats()), or null from an older backend.
      hooks: (next && next.hooks && typeof next.hooks === 'object') ? next.hooks : null
    };
  }

  /**
   * The status line's details (its tooltip): what the ad blocker's network
   * hooks cost this session, in calls and milliseconds, so the narrowed
   * response hook can be seen working. '' when there is nothing to say yet.
   */
  function hooksText(hooks) {
    if (!hooks) return '';
    var total = Number(hooks.requestTotal) || 0;
    if (total <= 0) return '';
    var types = [];
    var req = hooks.request && typeof hooks.request === 'object' ? hooks.request : {};
    for (var k in req) {
      if (Object.prototype.hasOwnProperty.call(req, k)) types.push([k, Number(req[k]) || 0]);
    }
    types.sort(function (a, b) { return b[1] - a[1]; });
    var top = types.slice(0, 3).map(function (p) { return p[0] + ' ' + p[1]; }).join(', ');
    var ms = Math.round((Number(hooks.requestMs) || 0) + (Number(hooks.headersMs) || 0));
    var heads = Number(hooks.headersTotal) || 0;
    return 'This session the ad blocker checked ' + total + (total === 1 ? ' request' : ' requests')
      + (top ? ' (' + top + ')' : '') + ' in ' + ms + ' ms. Its response-header hook ran '
      + heads + (heads === 1 ? ' time' : ' times')
      + (hooks.headersFiltered === false ? ' (on every response: this Electron could not limit it).' : ' (pages and frames only).');
  }

  /**
   * The line under the switches: whether blocking is on, and how fresh the
   * filter lists are. A failed update or a failed load says so with the
   * reason, never just goes quiet. Sentence case.
   */
  function statusText(state, now) {
    if (!state || !state.enabled) return 'Blocking is off';
    var l = state.lists || {};
    var t = typeof now === 'number' ? now : Date.now();
    if (!state.ready) {
      if (l.loadError) {
        return l.refreshing ? 'Blocking unavailable (' + l.loadError + '). Trying again…'
                            : 'Blocking unavailable: ' + l.loadError + '. Will try again soon';
      }
      return 'Filter lists loading…';
    }
    if (l.refreshing) return 'Updating filter lists…';
    var age = l.updatedAt > 0 ? t - l.updatedAt : -1;
    if (l.error) {
      return 'Couldn’t update filter lists: ' + l.error + '. Using lists from '
        + (age >= 0 ? fromWords(age) : 'an earlier update') + '.';
    }
    if (age < 0) return 'Filter lists ready';
    return 'Filter lists updated ' + ageWords(age);
  }

  /** "blocked on example.com", or just "blocked" when the host is unknown. */
  function subtitleFor(host) {
    var h = String(host || '');
    return h ? 'blocked on ' + h : 'blocked on this page';
  }

  /* ============================================================
     The bridge. Every hop is optional and never throws upward.
     ============================================================ */

  function ab() {
    return (window.api && window.api.adblock) ? window.api.adblock : null;
  }

  /** Fire-and-forget call. A missing backend is a no-op, not an error. */
  function send(name, a, b) {
    var api = ab();
    if (!api || typeof api[name] !== 'function') return;
    try {
      api[name](a, b);
    } catch (err) { /* the main process is the source of truth; ignore */ }
  }

  /** A promise-returning call, reduced to null when it is not there. */
  function ask(name, arg) {
    var api = ab();
    if (!api || typeof api[name] !== 'function') return null;
    try {
      var p = api[name](arg);
      return (p && typeof p.then === 'function') ? p : null;
    } catch (err) {
      return null;
    }
  }

  /* ============================================================
     The active tab
     ============================================================ */

  /**
   * What the shield is looking at right now. `ok` is false for a Claude tab,
   * the new-tab page and anything without a live guest — those pages have
   * nothing to block, and the panel says so.
   */
  function readActive() {
    var tab = null;
    try {
      if (typeof window.getActiveTab === 'function') tab = window.getActiveTab();
    } catch (err) { tab = null; }
    if (!tab || tab.kind !== 'page') return { ok: false, wcId: null, host: '' };

    var url = tab.url || '';
    try {
      if (tab.viewEl && typeof tab.viewEl.getURL === 'function') {
        url = tab.viewEl.getURL() || url;
      }
    } catch (err) { /* detached guest; the model's url still stands */ }

    var isNew = false;
    try {
      if (typeof window.isNewTabUrl === 'function') isNew = !!window.isNewTabUrl(url);
    } catch (err) { isNew = false; }
    if (isNew || !url || url === 'about:blank') return { ok: false, wcId: null, host: '' };

    var wcId = null;
    try {
      if (tab.viewEl && typeof tab.viewEl.getWebContentsId === 'function') {
        var id = tab.viewEl.getWebContentsId();
        if (typeof id === 'number') wcId = id;
      }
    } catch (err) { /* the guest is not attached yet */ }

    return { ok: true, wcId: wcId, host: hostnameOf(url) };
  }

  /** The cached record for the active guest, or a zeroed stand-in. */
  function activeRecord() {
    var rec = (active.wcId !== null) ? counts.get(active.wcId) : null;
    var host = (rec && rec.host) ? rec.host : active.host;
    var blocked = rec ? Number(rec.blocked) || 0 : 0;
    // The backend's `allowed` wins when we have one; otherwise the allowlist
    // from state() answers the same question a beat earlier.
    var allowed = rec ? !!rec.allowed : isAllowed(host, st.allow);
    return { blocked: blocked, host: host, allowed: allowed };
  }

  /* ============================================================
     DOM
     ============================================================ */

  /** The nav-row instrument: same recipe as #downloads, one slot to its left. */
  function injectButton() {
    if (document.getElementById('shield')) {
      buttonEl = document.getElementById('shield');
      badgeEl = buttonEl.querySelector('.shield-count');
      glyphEl = buttonEl.querySelector('.glyph');
      return;
    }
    var navrow = document.querySelector('.navrow');
    if (!navrow) return;

    buttonEl = document.createElement('button');
    buttonEl.id = 'shield';
    buttonEl.className = 'glass iconbtn no-drag';
    buttonEl.type = 'button';
    buttonEl.title = 'Ads and trackers blocked on this page';
    buttonEl.setAttribute('aria-label', 'Ads and trackers blocked on this page');
    buttonEl.setAttribute('aria-haspopup', 'dialog');
    buttonEl.setAttribute('aria-expanded', 'false');

    glyphEl = document.createElement('span');
    glyphEl.className = 'glyph';
    glyphEl.textContent = GLYPH_SHIELD;
    buttonEl.appendChild(glyphEl);

    badgeEl = document.createElement('span');
    badgeEl.className = 'shield-count';
    badgeEl.hidden = true;
    buttonEl.appendChild(badgeEl);

    buttonEl.addEventListener('click', function () { toggle(); });

    var downloads = document.getElementById('downloads');
    var theme = document.getElementById('theme');
    if (downloads && downloads.parentNode === navrow) navrow.insertBefore(buttonEl, downloads);
    else if (theme && theme.parentNode === navrow) navrow.insertBefore(buttonEl, theme);
    else navrow.appendChild(buttonEl);
  }

  /**
   * A switch row: the whole row is the control, so the hit target matches the
   * ion rail that lights along its left edge while it is on.
   */
  function switchRow(label, onToggle) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'sh-row';
    row.setAttribute('role', 'switch');
    row.setAttribute('aria-checked', 'false');

    var text = document.createElement('span');
    text.className = 'sh-row-label';
    text.textContent = label;

    var sw = document.createElement('span');
    sw.className = 'sh-switch';
    var knob = document.createElement('span');
    knob.className = 'sh-knob';
    sw.appendChild(knob);

    row.appendChild(text);
    row.appendChild(sw);
    row.addEventListener('click', function () {
      // The row's own class is the truth we read back: a click flips it.
      onToggle(!row.classList.contains('is-on'));
    });
    return row;
  }

  function setRow(row, on) {
    if (!row) return;
    if (on) row.classList.add('is-on');
    else row.classList.remove('is-on');
    row.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  /**
   * The popover lives on <body>, not inside .chrome-layer: the chrome layer
   * carries a blur filter before boot, and a fixed element there would be
   * clipped to it rather than floating over the tab well.
   */
  function buildPanel() {
    if (document.getElementById('shield-panel')) {
      panelEl = document.getElementById('shield-panel');
      bodyEl = panelEl.querySelector('.sh-body');
      emptyEl = panelEl.querySelector('.sh-empty');
      bigEl = panelEl.querySelector('.sh-big');
      subEl = panelEl.querySelector('.sh-sub');
      statusEl = panelEl.querySelector('.sh-status');
      return;
    }
    if (!document.body) return;

    panelEl = document.createElement('div');
    panelEl.id = 'shield-panel';
    panelEl.className = 'glass';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-label', 'Ads and trackers');
    panelEl.tabIndex = -1;
    panelEl.hidden = true;

    bodyEl = document.createElement('div');
    bodyEl.className = 'sh-body';

    bigEl = document.createElement('div');
    bigEl.className = 'sh-big';
    bigEl.textContent = '0';

    subEl = document.createElement('div');
    subEl.className = 'sh-sub';
    subEl.textContent = subtitleFor('');

    siteRow = switchRow('Block on this site', function (next) {
      var rec = activeRecord();
      if (!rec.host) return;
      // off = allowlisted, so the switch is the inverse of the allow flag.
      setRow(siteRow, next);
      counts.set(active.wcId, {
        blocked: rec.blocked, host: rec.host, allowed: !next
      });
      send('allowHost', rec.host, !next);
      paintButton();
      try {
        if (typeof window.reloadActiveTab === 'function') window.reloadActiveTab();
      } catch (err) { /* the switch still landed; the page just did not reload */ }
    });

    everyRow = switchRow('Block ads and trackers everywhere', function (next) {
      st.enabled = next;
      setRow(everyRow, next);
      send('setEnabled', next);
      render();
    });

    statusEl = document.createElement('div');
    statusEl.className = 'sh-status';
    // Polite: an update finishing while the popover is open is read out once.
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.textContent = statusText(st);

    bodyEl.appendChild(bigEl);
    bodyEl.appendChild(subEl);
    bodyEl.appendChild(siteRow);
    bodyEl.appendChild(everyRow);
    bodyEl.appendChild(statusEl);

    emptyEl = document.createElement('div');
    emptyEl.className = 'sh-empty';
    emptyEl.textContent = 'Nothing to block here';
    emptyEl.hidden = true;

    panelEl.appendChild(bodyEl);
    panelEl.appendChild(emptyEl);
    document.body.appendChild(panelEl);
  }

  /* ============================================================
     Painting — always from cache, never waiting on a promise
     ============================================================ */

  function paintButton() {
    if (!buttonEl) return;
    var rec = activeRecord();
    var dim = !st.enabled || rec.allowed || !active.ok;
    if (dim) buttonEl.classList.add('is-off');
    else buttonEl.classList.remove('is-off');

    if (badgeEl) {
      var text = active.ok ? formatCount(rec.blocked) : '';
      if (text) {
        badgeEl.textContent = text;
        badgeEl.hidden = false;
      } else {
        badgeEl.textContent = '';
        badgeEl.hidden = true;
      }
    }
    var n = active.ok ? (Number(rec.blocked) || 0) : 0;
    var title = active.ok
      ? (n === 1 ? '1 ad or tracker blocked on this page'
                 : n + ' ads and trackers blocked on this page')
      : 'Ads and trackers blocked on this page';
    buttonEl.title = title;
    buttonEl.setAttribute('aria-label', title);
  }

  function paintPanel() {
    if (!panelEl) return;
    var rec = activeRecord();

    if (bodyEl) bodyEl.hidden = !active.ok;
    if (emptyEl) emptyEl.hidden = !!active.ok;
    if (!active.ok) return;

    if (bigEl) bigEl.textContent = String(Number(rec.blocked) || 0);
    if (subEl) subEl.textContent = subtitleFor(rec.host);
    setRow(siteRow, !rec.allowed);
    setRow(everyRow, !!st.enabled);
    if (siteRow) siteRow.disabled = !rec.host;
    paintStatus();
  }

  /** The status line, tinted when an update or the load failed (the words carry the reason). */
  function paintStatus() {
    if (!statusEl) return;
    statusEl.textContent = statusText(st);
    statusEl.title = hooksText(st.hooks);
    var failed = !!st.enabled && !!(st.lists.error || (!st.ready && st.lists.loadError));
    if (failed) statusEl.classList.add('is-warn');
    else statusEl.classList.remove('is-warn');
  }

  function render() {
    paintButton();
    paintPanel();
  }

  /* ============================================================
     Pulling from the backend. Every result is optional.
     ============================================================ */

  function pullState() {
    var p = ask('state');
    if (!p) return;
    p.then(function (next) {
      if (!next || typeof next !== 'object') return;
      st = stateFrom(next);
      render();
    }).catch(function () { /* no backend; the cached state stands */ });
  }

  function pullCount() {
    if (!active.ok || active.wcId === null) return;
    var wcId = active.wcId;
    var p = ask('count', wcId);
    if (!p) return;
    p.then(function (next) {
      if (!next || typeof next !== 'object') return;
      counts.set(wcId, {
        blocked: Number(next.blocked) || 0,
        host: next.host || '',
        allowed: !!next.allowed
      });
      if (active.wcId === wcId) render();
    }).catch(function () { /* the guest may have gone; keep the cache */ });
  }

  /**
   * Re-read the active tab and repaint from cache on this frame, then ask the
   * backend for the fresher numbers.
   */
  function refresh() {
    active = readActive();
    render();
    pullState();
    pullCount();
  }

  /* ============================================================
     Open / close
     ============================================================ */

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

  function position() {
    if (!panelEl || !buttonEl || typeof buttonEl.getBoundingClientRect !== 'function') return;
    var r = buttonEl.getBoundingClientRect();
    if (!r || !r.width) return;
    var right = Math.max(8, Math.round(window.innerWidth - r.right));
    panelEl.style.top = popTop(r);
    panelEl.style.right = right + 'px';
  }

  function openPanel() {
    if (!panelEl) return;
    refresh();
    panelEl.hidden = false;
    open_ = true;
    position();
    if (buttonEl) {
      buttonEl.classList.add('is-open');
      buttonEl.setAttribute('aria-expanded', 'true');
    }
  }

  function closePanel() {
    if (panelEl) panelEl.hidden = true;
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
    if (action === 'shield') { toggle(); return true; }
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
    var api = ab();
    if (api && typeof api.onUpdate === 'function') {
      try {
        api.onUpdate(function (u) {
          if (!u || typeof u.wcId !== 'number') return;
          counts.set(u.wcId, {
            blocked: Number(u.blocked) || 0,
            host: u.host || '',
            allowed: !!u.allowed
          });
          // A guest that attached after the last tabchange has no wcId on
          // record yet; one update is enough to learn it.
          if (active.ok && active.wcId === null) active = readActive();
          if (u.wcId === active.wcId) render();
        });
      } catch (err) { /* no live feed; count() at open still populates */ }
    }
    if (api && typeof api.onStateChanged === 'function') {
      try {
        api.onStateChanged(function (next) {
          if (!next || typeof next !== 'object') return;
          st = stateFrom(next);
          render();
          pullCount();
        });
      } catch (err) { /* the cached state stands */ }
    }

    // The active tab moved: repaint from the Map on this frame, then confirm.
    document.addEventListener('tabchange', function () { refresh(); });


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
      if (open_) position();
    });
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

  window.Shield = {
    open: openPanel,
    close: closePanel,
    toggle: toggle,
    isOpen: isOpen,
    refresh: refresh,
    handleShortcut: handleShortcut,
    // Pure helpers, reachable so they can be exercised without a window.
    _helpers: {
      hostnameOf: hostnameOf,
      normalizeHost: normalizeHost,
      isAllowed: isAllowed,
      formatCount: formatCount,
      statusText: statusText,
      stateFrom: stateFrom,
      hooksText: hooksText,
      ageWords: ageWords,
      subtitleFor: subtitleFor
    }
  };
})();
