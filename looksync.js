/* ============================================================
   looksync.js - the chrome renderer's side of Look Sync.

   Helm, Quartz and Mantle share one look (theme, accent hue, glass)
   through %APPDATA%\look-sync\look.json, and Mantle publishes the
   desktop wallpaper's still there. Main owns the file
   (looksync-main.js); this window owns the settings. This file is
   the bridge between the two, and the ONLY place that publishes:

     local change  -> Settings.on / quartzthemechange -> api.lookSync.publish
     remote change -> api.lookSync.onApply -> QuartzTheme.setMode /
                      Settings.set, under the `applying` flag, so a
                      value that came from the file never goes back.

   window.LookSync (contract: the lane contract's "window.LookSync"):
     ready() status() desktop() place() glassFor(theme)
     previewGlass(theme, g|null) mantle() openMantleWallpapers()
     setEnabled(on) _debug()
   Events on document: lookstatus, lookdesktop, lookplace (raw, many
   per second while dragging), lookglass, lookapplied.

   Loaded right before settings.js: window.Settings does not exist
   yet when this runs, so everything that needs it waits for
   DOMContentLoaded (every script has run by then).
   ============================================================ */
(function () {
  'use strict';

  var api = window.api && window.api.lookSync ? window.api.lookSync : null;
  var READY_TIMEOUT_MS = 4000;
  var APP_NAMES = { helm: 'Helm', quartz: 'Quartz', mantle: 'Mantle' };
  var SEED_GLASS = {
    dark: { blurPx: 0, dim: 0.3, panel: 0 },
    light: { blurPx: 0, dim: 0.3, panel: 0 },
    render: 'picture'
  };
  var OLD_WINDOW = 'this window predates Look Sync; restart Quartz';

  var st = {
    started: false,
    answered: false,
    enabled: true,
    status: { state: 'starting', reason: 'connecting to the browser', rev: null, by: null, at: null, skipped: [] },
    desktop: { state: 'loading', stillUrl: null, title: null, rev: null, reason: 'connecting to the browser', record: null },
    place: null,
    mantle: { canOpen: false, reason: "Change it in Mantle's Wallpapers." },
    preview: { dark: null, light: null },
    dir: null
  };
  var applying = 0;
  var log = { publishes: [], applies: [] };
  var readyResolve;
  var readyPromise = new Promise(function (r) { readyResolve = r; });

  function fire(name, detail) {
    try { document.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (err) { /* no listeners */ }
  }
  function remember(list, entry) {
    list.push(entry);
    if (list.length > 30) list.shift();
  }
  function settings() { return window.Settings || null; }
  function theme() { return window.QuartzTheme || null; }
  function resolved() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }
  function appName(a) { return APP_NAMES[a] || (a ? String(a) : 'another app'); }

  /* ---- local values (what this window would seed the file with) ---- */

  function themeMode() {
    var t = theme();
    if (t && typeof t.mode === 'function') return t.mode();
    try {
      var m = window.localStorage.getItem('themeMode') || window.localStorage.getItem('theme');
      if (m === 'system' || m === 'light' || m === 'dark') return m;
    } catch (err) { /* storage blocked */ }
    return 'dark';
  }

  function num(v, lo, hi, dflt) {
    var n = Number(v);
    if (v === null || v === undefined || v === '' || !isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  /* dimAuto (optional, absent = automatic): kept only as a real boolean, so
     another app's Manual choice survives a write from here and backdrop.js
     can read glassFor(theme).dimAuto. Not inherited from dflt: a preview
     says its own mode, and absent stays absent. */
  function cleanThemeGlass(g, dflt) {
    g = g && typeof g === 'object' ? g : {};
    var out = {
      blurPx: Math.round(num(g.blurPx, 0, 64, dflt.blurPx)),
      dim: Math.round(num(g.dim, 0.2, 0.9, dflt.dim) * 100) / 100,
      panel: Math.round(num(g.panel, -0.3, 0.15, dflt.panel) * 100) / 100
    };
    if (typeof g.dimAuto === 'boolean') out.dimAuto = g.dimAuto;
    return out;
  }

  /* One order-stable form of a glass group for comparing: both sides cleaned
     the same way, keys in a fixed order, so key order or an absent-vs-true
     dimAuto (both automatic) never reads as a change. */
  function glassKey(g) {
    g = g && typeof g === 'object' ? g : {};
    function one(t, d) {
      var c = cleanThemeGlass(t, d);
      return [c.blurPx, c.dim, c.panel, c.dimAuto === false ? 'manual' : 'auto'].join(',');
    }
    return [one(g.dark, SEED_GLASS.dark), one(g.light, SEED_GLASS.light),
      g.render === 'seeThrough' ? 'seeThrough' : 'picture'].join('|');
  }

  function storedGlass() {
    var s = settings();
    var g = s ? s.get('glass') : null;
    g = g && typeof g === 'object' ? g : {};
    return {
      dark: cleanThemeGlass(g.dark, SEED_GLASS.dark),
      light: cleanThemeGlass(g.light, SEED_GLASS.light),
      render: g.render === 'seeThrough' ? 'seeThrough' : 'picture'
    };
  }

  function accentValue() {
    var s = settings();
    var h = s ? s.get('accentHue') : null;
    if (h === null || h === undefined || h === '' || !isFinite(Number(h))) return { hue: null };
    var n = Math.round(Number(h));
    return { hue: Math.min(360, Math.max(0, n)) };
  }

  function localValues() {
    return { theme: themeMode(), accent: accentValue(), glass: storedGlass() };
  }

  function sendLocal() {
    if (api && st.started) {
      try { api.local(localValues()); } catch (err) { /* main gone */ }
    }
  }

  /* ---- the status line for Settings > Look -------------------------- */

  function ago(at) {
    var t = at ? Date.parse(at) : NaN;
    if (!isFinite(t)) return null;
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 45) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }

  function lineOf(s) {
    var rev = s.rev != null ? ' · rev ' + s.rev : '';
    var why = s.reason ? ': ' + s.reason : '';
    var out;
    switch (s.state) {
      case 'ok': {
        var when = ago(s.at);
        out = 'On · in sync (last change from ' + appName(s.by) + (when ? ', ' + when : '') + ')' + rev;
        if (s.reason) out += ' · ' + s.reason;
        break;
      }
      case 'off': out = 'Off · Quartz keeps its own look' + (s.reason && !/^Sync is off/.test(s.reason) ? ' (' + s.reason + ')' : '') + rev; break;
      // look-sync.js's reason here is usually "no shared look file yet": said once, not twice.
      case 'missing': out = 'On · not shared yet' + (s.reason && !/no shared look file yet/i.test(s.reason) ? why : '') + rev; break;
      case 'corrupt': out = 'On · shared look file was damaged' + why + rev; break;
      case 'newer': out = 'Read-only · ' + (s.reason || 'shared look is from a newer version; update this app') + rev; break;
      case 'error': out = 'Problem · ' + (s.reason || 'unknown error') + rev; break;
      case 'starting': out = 'Starting · ' + (s.reason || 'connecting'); break;
      default: out = s.state + why + rev;
    }
    if (s.skipped && s.skipped.length) {
      out += ' · Ignored: ' + s.skipped.map(function (k) { return k.reason || k.field; }).join('; ');
    }
    return out;
  }

  function status() {
    var s = Object.assign({}, st.status);
    s.enabled = st.enabled;
    s.line = lineOf(s);
    return s;
  }

  function setStatus(s) {
    st.status = s || st.status;
    fire('lookstatus', status());
  }

  function setDesktop(d) {
    if (!d) return;
    st.desktop = d;
    fire('lookdesktop', desktop());
  }

  function desktop() { return Object.assign({}, st.desktop); }

  /* ---- glass --------------------------------------------------------- */

  function glassFor(t) {
    t = t === 'light' ? 'light' : 'dark';
    if (st.preview[t]) return Object.assign({}, st.preview[t]);
    return storedGlass()[t];
  }

  function fireGlass() {
    var t = resolved();
    fire('lookglass', { theme: t, glass: glassFor(t), preview: !!st.preview[t] });
  }

  function previewGlass(t, g) {
    t = t === 'light' ? 'light' : 'dark';
    var stored = storedGlass()[t];
    var p = g ? cleanThemeGlass(g, stored) : null;
    /* A preview that names no mode (an older caller) keeps the stored one;
       Settings' Dim drag says dimAuto false itself. */
    if (p && !('dimAuto' in p) && typeof stored.dimAuto === 'boolean') p.dimAuto = stored.dimAuto;
    st.preview[t] = p;
    fireGlass();
  }

  /* ---- publishing (the only place that writes) ----------------------- */

  function publish(field, value) {
    if (!api || !st.started || !st.enabled) return Promise.resolve({ ok: false, reason: !api ? OLD_WINDOW : 'sync is off or not started' });
    return Promise.resolve().then(function () { return api.publish(field, value); }).then(function (res) {
      remember(log.publishes, { field: field, value: value, ok: !!(res && res.ok), rev: res && res.rev, reason: res && res.reason, at: Date.now() });
      return res;
    }, function (err) {
      var res = { ok: false, reason: (err && err.message) || 'publish failed' };
      remember(log.publishes, { field: field, value: value, ok: false, reason: res.reason, at: Date.now() });
      setStatus(Object.assign({}, st.status, { state: 'error', reason: "Couldn't share the change: " + res.reason }));
      return res;
    });
  }

  function setEnabled(on) {
    on = on !== false;
    st.enabled = on;
    if (!api || !st.started) return Promise.resolve({ ok: false, reason: !api ? OLD_WINDOW : 'not started yet' });
    sendLocal();
    return Promise.resolve().then(function () { return api.setEnabled(on); }).then(function (res) {
      if (res && !res.ok) setStatus(Object.assign({}, st.status, { state: 'error', reason: res.reason }));
      return res;
    }, function (err) {
      return { ok: false, reason: (err && err.message) || 'switch failed' };
    });
  }

  /* ---- applying a value that came from the file ---------------------- */

  var THEME_WORD = { system: 'Match Windows', light: 'Light', dark: 'Dark' };

  function describe(field, v) {
    if (field === 'theme') return 'theme changed to ' + (THEME_WORD[v] || v);
    if (field === 'accent') return v && v.hue != null ? 'accent hue changed to ' + v.hue : "accent back to the palette's";
    if (field === 'glass') return 'glass changed';
    return field + ' changed';
  }

  function applyRemote(e) {
    if (!e || !e.changes) return;
    var ch = e.changes;
    var s = settings();
    var t = theme();
    var said = [];
    applying++;
    try {
      if (ch.theme !== undefined) {
        if (t && typeof t.setMode === 'function') {
          if (t.mode() !== ch.theme) said.push(describe('theme', ch.theme));
          t.setMode(ch.theme, { fromSync: true });
        }
      }
      if (ch.accent !== undefined && s) {
        var hue = ch.accent && ch.accent.hue != null ? ch.accent.hue : null;
        if (s.get('accentHue') !== hue) said.push(describe('accent', ch.accent));
        s.set({ accentHue: hue });
      }
      if (ch.glass !== undefined && s) {
        if (glassKey(storedGlass()) !== glassKey(ch.glass)) said.push(describe('glass', ch.glass));
        s.set({ glass: ch.glass });
      }
    } finally {
      applying--;
    }
    sendLocal();
    fireGlass();
    var message = null;
    if (e.cause === 'adopt' && said.length) message = 'Now matching the others (' + said.join(', ') + ')';
    remember(log.applies, { changes: ch, by: e.by, rev: e.rev, cause: e.cause, message: message, at: Date.now() });
    fire('lookapplied', { field: Object.keys(ch).join(','), value: ch, by: e.by || null, cause: e.cause || 'remote', message: message });
  }

  /* ---- local changes -> the file ------------------------------------- */

  function onSettings(all, keys) {
    if (!Array.isArray(keys)) return;
    var glass = keys.indexOf('glass') >= 0;
    if (keys.indexOf('lookSync') >= 0) {
      var on = all.lookSync !== false;
      if (on !== st.enabled) setEnabled(on);
    }
    if (glass) {
      st.preview = { dark: null, light: null };
      fireGlass();
    }
    if (applying) return;
    if (keys.indexOf('accentHue') >= 0 || glass) sendLocal();
    if (keys.indexOf('accentHue') >= 0) publish('accent', accentValue());
    if (glass) publish('glass', storedGlass());
  }

  /* Windows flipping its apps mode under 'system' re-resolves the theme
     (cause 'system') but the MODE is unchanged, so nothing is published. */
  var lastMode = null;
  function onTheme(e) {
    var d = (e && e.detail) || {};
    fireGlass();
    var mode = d.mode || themeMode();
    if (applying || d.fromSync) { lastMode = mode; return; }
    if (d.cause === 'system' || mode === lastMode) return;
    lastMode = mode;
    sendLocal();
    publish('theme', mode);
  }

  /* ---- boot ---------------------------------------------------------- */

  function start() {
    if (st.started) return;
    var s = settings();
    st.enabled = !s || s.get('lookSync') !== false;
    lastMode = themeMode();
    if (s && typeof s.on === 'function') s.on(onSettings);
    document.addEventListener('quartzthemechange', onTheme);
    try {
      new MutationObserver(function () { fireGlass(); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (err) { /* old engine: quartzthemechange still covers it */ }

    if (!api) {
      st.status = { state: 'error', reason: OLD_WINDOW, rev: null, by: null, at: null, skipped: [] };
      st.desktop = { state: 'fallback', stillUrl: null, title: null, rev: null, reason: "Following Windows' wallpaper: " + OLD_WINDOW, record: null };
      st.started = true;
      fire('lookstatus', status());
      fire('lookdesktop', desktop());
      readyResolve();
      return;
    }

    api.onStatus(setStatus);
    api.onDesktop(setDesktop);
    api.onApply(applyRemote);
    api.onPlace(function (p) { st.place = p; fire('lookplace', p); });
    st.started = true;

    var timer = setTimeout(function () {
      if (st.answered) return;
      setStatus({ state: 'error', reason: 'the browser did not answer within ' + (READY_TIMEOUT_MS / 1000) + ' s', rev: null, by: null, at: null, skipped: [] });
      setDesktop({ state: 'fallback', stillUrl: null, title: null, rev: null, reason: "Following Windows' wallpaper: the browser did not answer", record: null });
      readyResolve();
    }, READY_TIMEOUT_MS);

    Promise.resolve().then(function () {
      return api.hello({ enabled: st.enabled, local: localValues() });
    }).then(function (res) {
      clearTimeout(timer);
      st.answered = true;
      if (!res || !res.ok) {
        setStatus({ state: 'error', reason: (res && res.reason) || 'no answer', rev: null, by: null, at: null, skipped: [] });
        readyResolve();
        return;
      }
      st.dir = res.dir || null;
      if (res.mantle) st.mantle = res.mantle;
      if (res.place) { st.place = res.place; fire('lookplace', res.place); }
      setDesktop(res.desktop);
      setStatus(res.status);
      readyResolve();
    }, function (err) {
      clearTimeout(timer);
      st.answered = true;
      setStatus({ state: 'error', reason: "Couldn't start Look Sync: " + ((err && err.message) || err), rev: null, by: null, at: null, skipped: [] });
      setDesktop({ state: 'fallback', stillUrl: null, title: null, rev: null, reason: "Following Windows' wallpaper: Look Sync did not start", record: null });
      readyResolve();
    });
  }

  window.LookSync = {
    ready: function () { return readyPromise; },
    status: status,
    desktop: desktop,
    place: function () { return st.place ? JSON.parse(JSON.stringify(st.place)) : null; },
    glassFor: glassFor,
    previewGlass: previewGlass,
    mantle: function () { return Object.assign({}, st.mantle); },
    openMantleWallpapers: function () {
      if (!api) return Promise.resolve({ ok: false, reason: OLD_WINDOW });
      return Promise.resolve().then(function () { return api.openMantle(); }).catch(function (err) {
        // Plain words for the screen; the raw IPC error is the detail (quartz.log).
        return { ok: false, reason: 'Quartz’s main process did not answer the request', detail: String((err && err.message) || err || '') };
      });
    },
    setEnabled: setEnabled,
    enabled: function () { return st.enabled; },
    _debug: function () {
      return {
        enabled: st.enabled, started: st.started, answered: st.answered, dir: st.dir, applying: applying,
        status: status(), desktop: desktop(), place: st.place, preview: st.preview,
        local: localValues(), publishes: log.publishes.slice(), applies: log.applies.slice()
      };
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else setTimeout(start, 0);
})();
