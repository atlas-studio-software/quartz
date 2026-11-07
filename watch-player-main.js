'use strict';
/*
 * watch-player-main.js -- main's half of the Watch player layer (watch-player.js).
 *
 * A title clicked in Watch plays INSIDE Watch: the chrome lays a dark layer over
 * the Watch tab and hosts the service's own page in a <webview> there, in
 * Quartz's normal session (so his sign-ins are the same). This file:
 *
 *   - owns the one setting, "Play inside Watch" (default on), in
 *     <userData>/watch-player.json, the way watch-main.js owns Watch's prefs;
 *   - hands a title to the chrome (play()), called by watch-main.js's openTitle
 *     and signIn and by anything else that wants a page in the layer;
 *   - keeps the layer leak-proof once the chrome "adopts" a guest as a player:
 *       a page of the same service (or its sign-in hosts) stays in the layer,
 *         target=_blank and window.open() links included (loaded in place);
 *       a sign-in popup (window.open with features) opens as a SHEET inside the
 *         layer (a WebContentsView over it, window.opener kept), never a window;
 *       a page of another site opens as a PAGE SHEET inside the layer (the same
 *         session, so his sign-ins hold): a link, a target=_blank link, a popup or a
 *         redirect -- never a normal tab by itself; the sheet's "Open in a tab" is his;
 *       on TMDB's where-to-watch page (the 'tmdb' guide), a link to one of the
 *         services HANDS OVER to watch-main's openTitle (setHandoff): the layer,
 *         or Edge with the reason, routed like any title;
 *       an app link (disneyplus://, intent:, ...) is stopped, and says so;
 *     every way out writes ONE quartz.log line with the reason, and counts in
 *     Lumen's leak log (watch-leaks.js: Settings > Lumen, "Times Lumen had to leave");
 *     an "open another app" permission from a player or sheet (an app link in a
 *     frame) is refused here (refuseExternal), never asked;
 *   - multiview keys (1-4, F) from inside a tile, the mouse back button and the
 *     media keys (app-command), for the chrome to act on;
 *   - "fresh after watching": when the layer closes, watch-main re-reads the
 *     services that were playing;
 *   - free RAM (the multiview floor), process memory, and whether a player's
 *     webContents still exists (the e2e's "the view was destroyed").
 *
 * Nothing here plays, decodes or touches DRM: the services' own players do, in
 * the licensed castlabs CDM, exactly as in a tab.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Hosts = require('./watch-player-hosts');

const PREFS_FILE = 'watch-player.json';
const FLOOR_GB = 1.5;          // multiview: under this much free RAM a 3rd or 4th tile is refused
const MAX_TILES = 4;
// In a tile's page (its focused frame): is the focus somewhere he types (a sign-in, a PIN, a search box)?
const TYPING_JS = '(() => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;' +
  ' if (!a) return false; if (a.isContentEditable) return true; const t = a.tagName;' +
  ' if (t === "TEXTAREA" || t === "SELECT") return true;' +
  ' if (t === "INPUT") return !/^(button|checkbox|radio|range|submit|reset|image|file|color|hidden)$/i.test(a.type || "");' +
  ' return false; })()';

function create(deps) {
  const d = deps || {};
  const ipcMain = d.ipcMain;
  const electronApp = d.app || null;
  const webContentsApi = d.webContents || null;
  const WebContentsView = d.WebContentsView || null;
  const send = typeof d.send === 'function' ? d.send : () => {};
  const getWindow = typeof d.getWindow === 'function' ? d.getWindow : () => null;
  const isChromeSender = typeof d.isChromeSender === 'function' ? d.isChromeSender : () => false;
  const openDecision = typeof d.windowOpenDecision === 'function' ? d.windowOpenDecision : () => ({ action: 'deny' });
  const log = typeof d.log === 'function' ? d.log : (line) => console.log('[watch-player] ' + line);
  const test = d.test && typeof d.test === 'object' ? d.test : {};
  const testAuth = Array.isArray(test.authHosts) ? test.authHosts.map(String) : [];
  const realFreeGb = typeof d.freeGb === 'function' ? d.freeGb : () => os.freemem() / (1024 ** 3);
  // TESTS ONLY (test.freeFile, QUARTZ_PLAYER_FREE_FILE): a file holding a number of GB stands in for
  // the free RAM while it exists, so the multiview RAM guard can be tried without starving the box.
  const freeGb = test.freeFile ? () => {
    try { const n = Number(String(fs.readFileSync(test.freeFile, 'utf8')).trim()); if (Number.isFinite(n) && n >= 0) return n; } catch { /* no file: the real number */ }
    return realFreeGb();
  } : realFreeGb;
  const floorGb = Number.isFinite(test.floorGb) ? test.floorGb : FLOOR_GB;
  let afterWatching = typeof d.afterWatching === 'function' ? d.afterWatching : null;
  // handoff(url, { title }) -> Promise<{ how, why, reason }>: watch-main's openTitle, so a
  // where-to-watch link to a service is routed like any title (the layer, or Edge + why).
  let handoff = typeof d.handoff === 'function' ? d.handoff : null;
  let onInside = typeof d.onInsideChanged === 'function' ? d.onInsideChanged : null;
  let upNext = typeof d.upNext === 'function' ? d.upNext : null;   // watch-main's upNext: "Up next" when a title ends
  // watch-leaks.js: every way out of Lumen is counted (one log line each, written there).
  const leaks = d.leaks && typeof d.leaks.record === 'function' ? d.leaks : null;

  const players = new Map();   // wcId -> { wcId, contents, service, origins, fullscreen, sheets:Set }
  const sheets = new Map();    // sheet id -> { id, view, contents, opener, rect, kind: 'signin' | 'page' }
  let sheetSeq = 0;
  let mode = 'single';         // 'single' | 'grid': 1-4 and F are the layer's only in a grid
  let prefs = null;
  let commandWin = null;       // the window whose app-command we listen to

  /* --- the setting ------------------------------------------------------------- */

  function prefsFile() {
    let dir = d.dir || '';
    if (!dir && electronApp && typeof electronApp.getPath === 'function') { try { dir = electronApp.getPath('userData'); } catch { dir = ''; } }
    return dir ? path.join(dir, PREFS_FILE) : '';
  }
  function loadPrefs() {
    if (prefs) return prefs;
    prefs = { inside: true };
    const f = prefsFile();
    if (!f) return prefs;
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (raw && typeof raw.inside === 'boolean') prefs.inside = raw.inside;
    } catch { /* first run, or unreadable: the default */ }
    return prefs;
  }
  function savePrefs() {
    const f = prefsFile();
    if (!f) return;
    try {
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(prefs));
      fs.renameSync(tmp, f);
    } catch (err) { log(Hosts.HUB_NAME + ' player: could not save "Play inside ' + Hosts.HUB_NAME + '": ' + String((err && err.message) || err).slice(0, 120)); }
  }
  function inside() { return loadPrefs().inside; }
  function setInside(on) {
    loadPrefs().inside = !!on;
    savePrefs();
    if (onInside) { try { onInside(prefs.inside); } catch { /* listener gone */ } }
    return prefs.inside;
  }

  /* --- one title into the layer ---------------------------------------------------- */

  function cleanItem(it) {
    if (!it || typeof it !== 'object' || !Hosts.SERVICES[it.service]) return null;
    return { id: cleanTitle(it.id), service: it.service, title: cleanTitle(it.title), subtitle: cleanTitle(it.subtitle) };
  }
  function cleanTitle(t) { return typeof t === 'string' ? t.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : ''; }

  /**
   * Ask the chrome to show `url` in the layer. o: { service, title, multi, blocked, mode }.
   * blocked: the DRM reason a multiview tile cannot play (it shows that, never Edge by itself).
   * Returns false when there is no window to show it in.
   */
  function play(o) {
    const x = o || {};
    const url = String(x.url || '');
    if (!/^https?:\/\//i.test(url)) return false;
    const w = getWindow();
    if (!w || w.isDestroyed()) return false;
    send('watch-player:play', {
      url,
      service: Hosts.SERVICES[x.service] ? x.service : (Hosts.serviceFor(url) || ''),
      title: cleanTitle(x.title),
      multi: !!x.multi,
      blocked: typeof x.blocked === 'string' ? x.blocked.slice(0, 200) : '',
      // watch-player-extras.js: the title page when url is the player itself; what was opened (Up next);
      // 'profile' for the service's own picker, with where its menu is when it has no page of its own.
      fallback: /^https?:\/\//i.test(String(x.fallback || '')) ? String(x.fallback) : '',
      item: cleanItem(x.item),
      purpose: x.purpose === 'profile' ? 'profile' : '',
      note: typeof x.note === 'string' ? cleanTitle(x.note) : '',
    });
    return true;
  }

  /* --- leaving the layer: one log line each ------------------------------------------- */

  function hostOf(url) { try { return new URL(url).host; } catch { return String(url || '').slice(0, 40); } }
  function schemeOf(url) { const m = /^([a-z][a-z0-9+.-]*):/i.exec(String(url || '')); return m ? m[1].toLowerCase() : ''; }
  /** One way out of Lumen: its log line, and the leak count (watch-leaks.js) when there is one. */
  function leak(kind, reason, url, line) {
    if (leaks) { try { leaks.record({ kind, reason, url, line }); return; } catch { /* fall through to the plain line */ } }
    log(line);
  }
  function exitLine(why, url, kind) {
    const host = hostOf(url);
    leak(kind === 'edge' ? 'edge' : 'tab', why + (host ? ': ' + host : ''), url, Hosts.HUB_NAME + ' player: left the layer (' + why + '): ' + host);
  }

  function toTab(p, url, why) {
    exitLine(why, url);
    send('open-url', { url, background: false });
    send('watch-player:left', { wcId: p.wcId, url, host: hostOf(url), why });
  }
  function blockApp(p, url) {
    const scheme = schemeOf(url);
    const from = (Hosts.SERVICES[p.service] && Hosts.SERVICES[p.service].name) || p.service || 'a player';
    leak('app', 'an app link (' + scheme + ':) on ' + from + ', stopped', '', Hosts.HUB_NAME + ' player: stopped an app link (' + scheme + ':) from ' + (p.service || 'a player'));
    send('watch-player:blocked', { wcId: p.wcId, scheme, why: 'app link' });
  }

  function extraFor(p) { return { origins: p.origins, auth: testAuth }; }
  function isWeb(url) { return /^https?:/i.test(String(url || '')); }
  function isLocal(url) { return /^(?:about:|blob:|data:|javascript:)/i.test(String(url || '')); }

  /* --- adopting a guest as a player ---------------------------------------------------- */

  function guestOf(wcId) {
    if (!webContentsApi || !Number.isInteger(wcId)) return null;
    let c = null;
    try { c = webContentsApi.fromId(wcId); } catch { c = null; }
    if (!c || c.isDestroyed()) return null;
    const w = getWindow();
    let host = null;
    try { host = c.hostWebContents; } catch { host = null; }
    if (c.getType() !== 'webview' || !w || w.isDestroyed() || host !== w.webContents) return null;
    return c;
  }

  /*
   * A where-to-watch guide (TMDB) linked to one of the services: that title opens as the
   * service's own page, through watch-main's openTitle -- in the layer (the guide's player
   * is replaced), or in Edge with the reason when this Quartz cannot play it. One log line.
   */
  function handOff(p, url, to) {
    const name = (Hosts.SERVICES[to] && Hosts.SERVICES[to].name) || to;
    if (!handoff) { toTab(p, url, 'where-to-watch link, no route to ' + name); return; }
    Promise.resolve()
      .then(() => handoff(url, { title: '', via: 'handoff' }))
      .then((r) => {
        const how = (r && r.how) || '';
        if (how === 'layer') log(Hosts.HUB_NAME + ' player: a where-to-watch link opened ' + name + ' in the layer: ' + hostOf(url));
        else if (how === 'edge') {
          const why = String((r && (r.why || r.reason)) || '').slice(0, 160);
          exitLine('where-to-watch link to ' + name + ', opened in Edge' + (why ? ': ' + why : ''), url, 'edge');
          send('watch-player:left', { wcId: p.wcId, url, host: hostOf(url), why: 'edge', to: 'edge', service: to, reason: why });
        } else if (how === 'tab') exitLine('where-to-watch link to ' + name + ', opened in a tab', url);
        else log(Hosts.HUB_NAME + ' player: a where-to-watch link to ' + name + ' did not open: ' + String((r && r.reason) || 'no answer').slice(0, 120));
      })
      .catch((err) => log(Hosts.HUB_NAME + ' player: a where-to-watch link to ' + name + ' failed: ' + String((err && err.message) || err).slice(0, 120)));
  }

  function onNavigate(p, event, url, kind) {
    if (isLocal(url)) return;
    if (!isWeb(url)) { event.preventDefault(); blockApp(p, url); return; }
    const to = Hosts.handoffFor(p.service, url);
    if (to) { event.preventDefault(); handOff(p, url, to); return; }
    if (Hosts.staysIn(p.service, url, extraFor(p))) return;
    event.preventDefault();
    pageSheet(p, url, kind);
  }

  function openHandler(p) {
    return (details) => {
      const url = String((details && details.url) || '');
      const disp = details && details.disposition;
      const blank = url === '' || /^about:blank/i.test(url);
      if (!blank && !isWeb(url)) { blockApp(p, url); return { action: 'deny' }; }
      const to = blank ? '' : Hosts.handoffFor(p.service, url);
      if (to) { handOff(p, url, to); return { action: 'deny' }; }
      const stays = blank || Hosts.staysIn(p.service, url, extraFor(p));
      if (disp === 'new-window' || disp === 'other') {
        // A popup with features: sign-in (Google, MyDisney, Amazon) posts back through
        // window.opener, so it gets a real child -- in a sheet inside the layer.
        if (WebContentsView) return sheetFor(p, url, details, stays ? 'signin' : 'page');
        if (!stays) { toTab(p, url, 'popup to another site, no sheet in this build'); return { action: 'deny' }; }
        return openDecision(details);
      }
      if (stays && !blank) {
        // target=_blank / window.open(url) on the same service: this layer, in place.
        setImmediate(() => { try { if (!p.contents.isDestroyed()) p.contents.loadURL(url).catch(() => { /* a stop or a redirect */ }); } catch { /* gone */ } });
        return { action: 'deny' };
      }
      if (blank) return { action: 'deny' };
      // target=_blank / window.open(url) to another site: a page sheet in the layer.
      pageSheet(p, url, 'new-tab link to another site');
      return { action: 'deny' };
    };
  }

  function wireCommands() {
    const w = getWindow();
    if (!w || w.isDestroyed() || commandWin === w) return;
    commandWin = w;
    // The mouse's back button and the keyboard's media keys reach the window as
    // WM_APPCOMMAND whichever part of it has focus. Only while a player exists.
    w.on('app-command', (_e, cmd) => {
      if (!players.size) return;
      if (cmd === 'browser-backward') send('watch-player:command', { cmd: 'back' });
      else if (/^media-(play-pause|pause|play|stop|nexttrack|previoustrack)$/.test(String(cmd))) send('watch-player:command', { cmd: String(cmd) });
    });
  }

  function adopt(wcId, o) {
    const contents = guestOf(wcId);
    if (!contents) return { ok: false, reason: 'not a player guest of this window' };
    const x = o || {};
    if (players.has(wcId)) {
      const had = players.get(wcId);
      had.service = Hosts.SERVICES[x.service] ? x.service : had.service;
      if (typeof x.origin === 'string' && isWeb(x.origin) && had.origins.indexOf(x.origin) === -1) had.origins.push(x.origin);
      return { ok: true, again: true };
    }
    const p = {
      wcId,
      contents,
      service: Hosts.SERVICES[x.service] ? x.service : '',
      origins: typeof x.origin === 'string' && isWeb(x.origin) ? [x.origin] : [],
      fullscreen: false,
      sheets: new Set(),
    };
    players.set(wcId, p);
    contents.on('will-navigate', (e, url) => onNavigate(p, e, url, 'link to another site'));
    contents.on('will-redirect', (e, url, _inPlace, isMainFrame) => { if (isMainFrame) onNavigate(p, e, url, 'redirect to another site'); });
    contents.setWindowOpenHandler(openHandler(p));
    // An app link in a frame of the page (an iframe's disneyplus://): stopped like the page's own.
    contents.on('will-frame-navigate', (e) => { const to = String((e && e.url) || ''); if (e && !e.isMainFrame && to && !isLocal(to) && !isWeb(to)) { e.preventDefault(); blockApp(p, to); } });
    contents.on('enter-html-full-screen', () => { p.fullscreen = true; });
    contents.on('leave-html-full-screen', () => { p.fullscreen = false; });
    // A tile's text field keeps its keys: 1-4/F/X/M are taken only while the page's focus is not somewhere he
    // types (they were swallowed in a sign-in, a PIN or the search box). before-input-event can't wait on the
    // page, so the answer is kept (p.typing) and asked again whenever the focus can have moved: a key or the
    // mouse let go, the page's focus, a load, the switch to multiview.
    p.typing = false;
    p.askTyping = () => {
      if (mode !== 'grid') return;
      let f = null;
      try { if (contents.isDestroyed()) return; f = contents.focusedFrame || contents.mainFrame || null; } catch (e) { f = null; }
      if (!f || typeof f.executeJavaScript !== 'function') return;
      try {
        const r = f.executeJavaScript(TYPING_JS);
        if (r && typeof r.then === 'function') r.then((v) => { p.typing = v === true; }, () => { /* a frame going away: the next ask says */ });
      } catch (e) { /* frame gone */ }
    };
    contents.on('did-finish-load', () => { setTimeout(() => p.askTyping(), 300); });   // a field the page focuses itself
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyUp') { p.askTyping(); return; }
      if (input.type !== 'keyDown' || input.control || input.alt || input.meta) return;
      const key = String(input.key);
      if (/^Media(PlayPause|Play|Pause|Stop|TrackNext|TrackPrevious)$/.test(key)) {
        event.preventDefault();
        send('watch-player:command', { cmd: 'key-' + key, wcId });
        return;
      }
      if (mode !== 'grid' || input.shift || p.typing) return;
      // Multiview (watch-player-multi.js): 1-4 pick the tile with the sound, F expands it, X removes
      // it, M mutes them all. A tile's page never sees these while there is more than one tile.
      if (/^[1-4]$/.test(key) || /^[fxm]$/i.test(key)) {
        event.preventDefault();
        send('watch-player:key', { key: key.toLowerCase(), wcId });
      }
    });
    // A click into a tile's page (it takes focus) moves the sound there, in multiview only.
    contents.on('focus', () => { if (mode === 'grid') { send('watch-player:key', { key: 'focus', wcId }); p.askTyping(); } });
    // ...and its mouse-down too: focus never arrives while the window itself is unfocused.
    contents.on('input-event', (_e, input) => {
      if (mode === 'grid' && input && input.type === 'mouseDown') send('watch-player:key', { key: 'focus', wcId });
      if (input && input.type === 'mouseUp') p.askTyping();   // a click into (or out of) a text field
    });
    contents.once('destroyed', () => {
      players.delete(wcId);
      for (const id of Array.from(p.sheets)) closeSheet(id, 'its player closed');
      send('watch-player:gone', { wcId });
    });
    wireCommands();
    return { ok: true };
  }

  /* --- sign-in sheets ------------------------------------------------------------------ */

  /*
   * A sheet is a WebContentsView over the layer (the chrome places it in its hole). Two kinds:
   *   'signin' -- a popup of the service or its sign-in hosts (Google, MyDisney, Amazon): a real
   *               child of the page (window.opener kept), so the sign-in posts back;
   *   'page'   -- a page of another site (a link, a new-tab link, a popup or a redirect): shown in
   *               the layer instead of a normal tab; its bar has "Open in a tab" for when he wants one.
   * Both are in the player's own session, so his sign-ins are the same as in a tab.
   */
  function sheetFor(p, url, details, kind) {
    const id = ++sheetSeq;
    return {
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, devTools: false },
      },
      createWindow: (options) => {
        const view = new WebContentsView({ webPreferences: options.webPreferences, webContents: options.webContents });
        const target = url || (details && details.url) || '';
        wireSheet(p, id, view, target, kind === 'page' ? 'page' : 'signin');
        if (kind === 'page') log(Hosts.HUB_NAME + ' player: a popup to another site opened as a page in the layer: ' + hostOf(target));
        else log(Hosts.HUB_NAME + ' player: a sign-in popup opened as a sheet in the layer: ' + hostOf(target));
        return view.webContents;
      },
    };
  }

  /** A page of another site, opened by Lumen itself (no opener): in the player's page sheet, reused. */
  function pageSheet(p, url, why) {
    if (!WebContentsView) { toTab(p, url, why + ', no sheet in this build'); return; }
    for (const sid of p.sheets) {
      const had = sheets.get(sid);
      if (had && had.kind === 'page' && !had.contents.isDestroyed()) {
        had.url = url;
        try { had.contents.loadURL(url).catch(() => { /* a stop or a redirect */ }); } catch { /* gone */ }
        log(Hosts.HUB_NAME + ' player: a page from another site opened in the layer (' + why + '): ' + hostOf(url));
        send('watch-player:sheet', { id: sid, opener: p.wcId, url, host: hostOf(url), kind: 'page', fresh: true });
        return;
      }
    }
    let view;
    try {
      let sess = null;
      try { sess = p.contents.session; } catch { sess = null; }
      const wp = { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, devTools: false };
      if (sess) wp.session = sess;
      view = new WebContentsView({ webPreferences: wp });
    } catch (err) {
      toTab(p, url, why + ', the layer could not show it (' + String((err && err.message) || err).slice(0, 60) + ')');
      return;
    }
    const id = ++sheetSeq;
    wireSheet(p, id, view, url, 'page');
    log(Hosts.HUB_NAME + ' player: a page from another site opened in the layer (' + why + '): ' + hostOf(url));
    try { view.webContents.loadURL(url).catch(() => { /* did-fail-load on the page says the rest */ }); } catch { /* gone */ }
  }

  function wireSheet(p, id, view, url, kind) {
    const w = getWindow();
    const wc = view.webContents;
    // url: what the sheet shows (the address asked for until the page commits one).
    const s = { id, view, contents: wc, opener: p.wcId, rect: null, kind, url: String(url || '') };
    sheets.set(id, s);
    p.sheets.add(id);
    try { view.setBackgroundColor('#ffffff'); } catch { /* older build */ }
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    view.setVisible(false);
    if (w && !w.isDestroyed()) w.contentView.addChildView(view);
    // The sheet's own pages: the same rules, and its own popups load in place.
    wc.on('will-navigate', (e, to) => { if (!isLocal(to) && !isWeb(to)) { e.preventDefault(); blockApp(p, to); } });
    wc.on('will-frame-navigate', (e) => { const to = String((e && e.url) || ''); if (e && !e.isMainFrame && to && !isLocal(to) && !isWeb(to)) { e.preventDefault(); blockApp(p, to); } });
    wc.setWindowOpenHandler((dd) => {
      const to = String((dd && dd.url) || '');
      if (isWeb(to)) setImmediate(() => { try { if (!wc.isDestroyed()) wc.loadURL(to).catch(() => { /* a stop or a redirect */ }); } catch { /* gone */ } });
      else if (to && !/^about:blank/i.test(to)) blockApp(p, to);
      return { action: 'deny' };
    });
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); closeSheet(id, 'Esc'); }
    });
    wc.on('page-title-updated', (_e, title) => send('watch-player:sheet', { id, opener: p.wcId, title: cleanTitle(title), host: hostOf(safeUrl(wc)), kind }));
    wc.on('did-navigate', (_e, to) => { if (isWeb(to)) s.url = to; send('watch-player:sheet', { id, opener: p.wcId, host: hostOf(to), kind }); });
    wc.on('did-fail-load', (_e, code, desc, failed, isMain) => {
      if (isMain && code !== -3) send('watch-player:sheet', { id, opener: p.wcId, host: hostOf(failed), kind, error: cleanTitle(desc || ('error ' + code)) });
    });
    wc.once('destroyed', () => {
      sheets.delete(id);
      p.sheets.delete(id);
      const ww = getWindow();
      try { if (ww && !ww.isDestroyed()) ww.contentView.removeChildView(view); } catch { /* window gone */ }
      send('watch-player:sheet-gone', { id, opener: p.wcId });
    });
    send('watch-player:sheet', { id, opener: p.wcId, url: String(url || ''), host: hostOf(url), kind, fresh: true });
    return s;
  }

  /** The sheet's "Open in a tab": his choice, so it leaves (and counts) with that reason. */
  function sheetToTab(id) {
    const s = sheets.get(id);
    if (!s) return { ok: false, reason: 'that page is gone' };
    const now = safeUrl(s.contents);
    const url = isWeb(now) ? now : s.url;
    if (!isWeb(url)) return { ok: false, reason: 'the page has no address yet' };
    exitLine('Open in a tab, from a ' + (s.kind === 'page' ? 'page' : 'sign-in') + ' in the layer', url);
    send('open-url', { url, background: false });
    closeSheet(id, '');
    return { ok: true, url };
  }

  /*
   * main.js's permission handler asks here first: "open another app" (an app link in a frame,
   * or one Chromium hands to Windows) from a player or a sheet is refused, said and counted,
   * never a dialog over the layer. True when the contents is ours.
   */
  function refuseExternal(contents, details) {
    let id = null;
    try { id = contents && !contents.isDestroyed() ? contents.id : null; } catch { id = null; }
    if (id === null) return false;
    let p = players.get(id) || null;
    if (!p) for (const s of sheets.values()) if (s.contents === contents) p = players.get(s.opener) || { wcId: s.opener, service: '' };
    if (!p) return false;
    blockApp(p, String((details && details.externalURL) || 'app:'));
    return true;
  }
  function safeUrl(wc) { try { return wc.getURL(); } catch { return ''; } }

  function placeSheet(id, rect) {
    const s = sheets.get(id);
    if (!s) return false;
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) { s.view.setVisible(false); s.rect = null; return true; }
    const r = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    s.view.setBounds(r);
    s.view.setVisible(true);
    s.rect = r;
    return true;
  }
  function closeSheet(id, why) {
    const s = sheets.get(id);
    if (!s) return false;
    // close() without waitForBeforeUnload: a page cannot refuse it.
    try { if (!s.contents.isDestroyed()) s.contents.close(); } catch { /* gone */ }
    if (why) log(Hosts.HUB_NAME + ' player: closed a ' + (s.kind === 'page' ? 'page' : 'sign-in') + ' sheet (' + why + ')');
    return true;
  }

  /* --- memory -------------------------------------------------------------------------- */

  function memory() {
    let total = 0;
    let cpuSec = 0;
    const byPid = {};
    const byType = {};
    try {
      for (const m of electronApp.getAppMetrics()) {
        const kb = (m.memory && m.memory.workingSetSize) || 0;
        // cumulativeCPUUsage: CPU seconds since the process started (multiview's CPU is measured as a
        // difference of two reads, so another caller of getAppMetrics never skews it).
        const sec = (m.cpu && Number.isFinite(m.cpu.cumulativeCPUUsage)) ? m.cpu.cumulativeCPUUsage : 0;
        total += kb;
        cpuSec += sec;
        byPid[m.pid] = { type: m.type, mb: Math.round(kb / 1024), cpuSec: Math.round(sec * 1000) / 1000 };
        byType[m.type] = (byType[m.type] || 0) + sec;
      }
    } catch { /* no metrics */ }
    const playersOut = [];
    for (const p of players.values()) {
      let pid = 0;
      try { pid = p.contents.getOSProcessId(); } catch { pid = 0; }
      playersOut.push({ wcId: p.wcId, pid, mb: byPid[pid] ? byPid[pid].mb : 0, cpuSec: byPid[pid] ? byPid[pid].cpuSec : 0 });
    }
    for (const k of Object.keys(byType)) byType[k] = Math.round(byType[k] * 1000) / 1000;
    return { totalMb: Math.round(total / 1024), processes: Object.keys(byPid).length, players: playersOut, freeGb: Math.round(freeGb() * 100) / 100,
      cpuSec: Math.round(cpuSec * 1000) / 1000, cpuByType: byType, at: Date.now() };
  }

  /* --- IPC ----------------------------------------------------------------------------- */

  function registerIpc() {
    if (!ipcMain) return;
    const on = (ch, fn) => ipcMain.handle(ch, (event, payload) => {
      if (!isChromeSender(event)) throw new Error('not the chrome');
      return fn(payload && typeof payload === 'object' ? payload : {});
    });
    on('watch-player:get', () => ({ inside: inside(), name: Hosts.HUB_NAME, floorGb, maxTiles: MAX_TILES, leaks: leaks ? leaks.state() : null }));
    on('watch-player:set-inside', (p) => ({ inside: setInside(p.on === true) }));
    on('watch-player:adopt', (p) => adopt(Number(p.wcId), p));
    on('watch-player:mode', (p) => {
      mode = p.mode === 'grid' ? 'grid' : 'single';
      if (mode === 'grid') for (const pl of players.values()) { if (pl.askTyping) pl.askTyping(); }   // a field already focused
      return { mode };
    });
    on('watch-player:free', () => ({ freeGb: Math.round(freeGb() * 100) / 100, floorGb }));
    on('watch-player:alive', (p) => ({ alive: !!(webContentsApi && Number.isInteger(p.wcId) && (() => { try { const c = webContentsApi.fromId(p.wcId); return !!c && !c.isDestroyed(); } catch { return false; } })()) }));
    on('watch-player:memory', () => memory());
    on('watch-player:escape', (p) => {
      // The chrome's own ways out (its "Open in a tab" and "Open in Edge" buttons): logged here.
      const why = String(p.why || 'button').slice(0, 120);
      exitLine(why, String(p.url || ''), /^Open in Edge/.test(why) ? 'edge' : 'tab');
      return { ok: true };
    });
    on('watch-player:report', (p) => {
      // The chrome already shows it over the tile; this is the log's copy. Host only, never the title's address.
      if (p.kind !== 'bounce') return { ok: false };
      const text = String(p.text || '').replace(/[\r\n]+/g, ' ').slice(0, 300);
      log(Hosts.HUB_NAME + ' player: ' + text.replace(/\.$/, '') + ' (' + hostOf(String(p.url || '')) + ')');
      return { ok: true };
    });
    on('watch-player:closed', (p) => {
      // Fresh after watching: re-read the services that were in the layer.
      const ids = Array.isArray(p.services) ? p.services.filter((id) => typeof id === 'string').slice(0, MAX_TILES) : [];
      const asked = [];
      for (const id of new Set(ids)) {
        if (!afterWatching) break;
        try { if (afterWatching(id) !== false) asked.push(id); } catch (err) { log(Hosts.HUB_NAME + ' player: re-read of ' + id + ' failed to start: ' + String((err && err.message) || err).slice(0, 120)); }
      }
      return { asked };
    });
    on('watch-player:up-next', async (p) => {
      // A title ended in the layer: what follows it on the same service, from Lumen's rows (watch-main).
      if (!upNext) return { ok: false, next: null, reason: 'Lumen isn’t running its reader' };
      const item = cleanItem(p.item);
      if (!item) return { ok: false, next: null, reason: 'Lumen doesn’t know what was playing' };
      log(Hosts.HUB_NAME + ' player: ' + item.service + ' title ended; looking for what is next');
      try { return await upNext({ item }); } catch (err) { return { ok: false, next: null, reason: String((err && err.message) || err).slice(0, 120) }; }
    });
    on('watch-player:sheet-rect', (p) => ({ ok: placeSheet(Number(p.id), p.rect) }));
    on('watch-player:sheet-close', (p) => ({ ok: closeSheet(Number(p.id), String(p.why || 'Close').slice(0, 40)) }));
    on('watch-player:sheet-to-tab', (p) => sheetToTab(Number(p.id)));
    // TEST ONLY (--test-profile): the whole window, sheets included (a sheet is a native view, so
    // the chrome's own screenshot cannot see it). A live Quartz has no such channel.
    if (test.capture) {
      on('watch-player:test-capture', async (p) => {
        const w = getWindow();
        if (!w || w.isDestroyed()) return { ok: false, png: '' };
        const cw = Math.round(Number(p.width) || 0);
        const ch = Math.round(Number(p.height) || 0);
        if (cw >= 400 && ch >= 300) {
          w.setContentSize(cw, ch);
          await new Promise((res) => setTimeout(res, Math.min(3000, Math.max(200, Number(p.wait) || 900))));
        }
        const img = await w.capturePage();
        // The window's capture is its own webContents only: each shown sheet comes separately, with
        // its place (DIP), for the e2e to lay over it.
        const shownSheets = [];
        for (const sh of sheets.values()) {
          if (!sh.rect || sh.contents.isDestroyed()) continue;
          try { shownSheets.push({ rect: sh.rect, png: (await sh.contents.capturePage()).toPNG().toString('base64') }); } catch { /* not painted */ }
        }
        return { ok: true, png: img.toPNG().toString('base64'), sheets: shownSheets };
      });
    }
  }

  return {
    registerIpc,
    play,
    inside,
    setInside,
    setAfterWatching: (fn) => { afterWatching = typeof fn === 'function' ? fn : null; },
    setUpNext: (fn) => { upNext = typeof fn === 'function' ? fn : null; },
    setHandoff: (fn) => { handoff = typeof fn === 'function' ? fn : null; },
    setOnInside: (fn) => { onInside = typeof fn === 'function' ? fn : null; },
    isPlayer: (wcId) => players.has(wcId),
    refuseExternal,
    leaks: () => (leaks ? leaks.state() : null),
    state: () => ({ players: players.size, sheets: sheets.size, pageSheets: Array.from(sheets.values()).filter((x) => x.kind === 'page').length, mode, inside: inside() }),
  };
}

module.exports = { create, PREFS_FILE, FLOOR_GB, MAX_TILES };
