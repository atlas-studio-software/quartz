'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// This user's home folder (the chrome's preload runs unsandboxed, so it may require 'os').
const HOME_DIR = require('os').homedir();

// When this Electron (and so its Chromium) was built: the release zip stamps dist/version with its
// build time and the install keeps it. Settings > About turns it into "built N days ago". '' when it
// cannot be read: About then says so and shows the versions only (no guess, no network call).
function electronBuilt() {
  try {
    const path = require('path');
    return require('fs').statSync(path.join(path.dirname(process.execPath), 'version')).mtime.toISOString();
  } catch (e) {
    return '';
  }
}

// Claude chambers start with --dangerously-skip-permissions only once the
// renderer has said the Settings switch is on (api.pty.setPrefs). Until then
// nothing is skipped, so a new profile (switch off by default) never has a
// moment where a spawn runs without Claude's prompts. It is kept HERE rather than
// only at the call site in app.js because pty.start() is the one funnel every
// spawn goes through: terminal.js drops the first-spawn flags when the user
// presses Enter to restart a finished session, and that restart should skip
// prompts exactly like the tab it replaces. pty.js de-duplicates, so a call
// that already carries the flag is unaffected.
const SKIP_PERMISSIONS_ARG = '--dangerously-skip-permissions';
let ptySkipPermissions = false; // off until the renderer says the switch is on
// Settings > Claude "Let Claude panes read your open tabs" (mcp-main.js). The
// same funnel and the same rule: off until the renderer says it is on, so a
// pane spawned before the settings load never gets the tools by accident.
// It rides on the spawn as `readTabs`; main reads nothing else to decide.
let ptyReadTabs = false;

function withSkipPermissions(opts) {
  const out = (opts && typeof opts === 'object') ? { ...opts } : {};
  if (out.program === undefined || out.program === null || out.program === 'claude') out.readTabs = ptyReadTabs;
  else delete out.readTabs;
  if (!ptySkipPermissions) return out;
  // Claude-only: it is a claude.exe flag, and every other program in the table
  // takes no renderer args at all (pty.js would drop it, loudly, anyway).
  if (out.program !== undefined && out.program !== null && out.program !== 'claude') return out;
  const args = Array.isArray(out.args) ? out.args.slice() : [];
  if (args.indexOf(SKIP_PERMISSIONS_ARG) === -1) args.unshift(SKIP_PERMISSIONS_ARG);
  out.args = args;
  return out;
}

// One listener per call; returns its unsubscribe. The event object never
// crosses the bridge, only the payload.
function subscribe(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

/*
 * Top-row hints (toprow-main.js createClient): the pipe client lives here, in
 * the chrome's own process (sandbox is off for this window, so Node's net is
 * available to the preload and never to the page). Main answers toprow:config
 * with this window's HWND, the pipe and whether this is a test window, and
 * sends toprow:window for what only main sees (maximize, fullscreen, pop-ups).
 * Until the config is in, the last hint is kept and goes out with it.
 */
const toprowListeners = new Set();
let toprowClient = null;
let toprowEarly = null;              // { top, t } before the client exists
const toprowEvents = [];
let toprowNote = { state: 'starting', reason: 'asking main for this window' };
function toprowStatus() { return toprowClient ? toprowClient.status() : Object.assign({}, toprowNote); }
function toprowTell(s) { for (const cb of toprowListeners) { try { cb(s); } catch (err) { /* the page's problem */ } } }
function toprowHint(top, t) {
  if (toprowClient) toprowClient.hint(top, t);
  else toprowEarly = { top, t };
}
function toprowEvent(m) {
  if (!m || !toprowClient) { if (m) toprowEvents.push(m); return; }
  if (m.event === 'create') toprowClient.window(m.hwnd, { chrome: false });
  else toprowClient.event(m.hwnd, m.event);
}
ipcRenderer.on('toprow:window', (_event, m) => toprowEvent(m));
ipcRenderer.invoke('toprow:config').then((cfg) => {
  if (!cfg || !cfg.hwnd) {
    toprowNote = { state: 'off', reason: 'main did not name this window (not the chrome window?)' };
    toprowTell(toprowStatus());
    return;
  }
  try {
    const { createClient } = require('./toprow-main.js');
    toprowClient = createClient({
      net: require('net'), pipe: cfg.pipe, disabled: cfg.disabled,
      log: (line) => console.log('[toprow] ' + line),
      onStatus: toprowTell,
    });
    toprowClient.window(cfg.hwnd, { chrome: true, fullscreen: !!cfg.fullscreen });
    if (toprowEarly) { toprowClient.hint(toprowEarly.top, toprowEarly.t); toprowEarly = null; }
    while (toprowEvents.length) toprowEvent(toprowEvents.shift());
  } catch (err) {
    toprowClient = null;
    toprowNote = { state: 'off', reason: 'the pipe client could not start (' + ((err && err.message) || err) + ')' };
  }
  toprowTell(toprowStatus());
}, (err) => {
  toprowNote = { state: 'off', reason: 'main did not answer (' + ((err && err.message) || err) + ')' };
  toprowTell(toprowStatus());
});

contextBridge.exposeInMainWorld('api', {
  homeDir: HOME_DIR,
  // Shortcuts the main process caught on our behalf because focus was inside a
  // <webview> and the keystroke never reached this renderer.
  onShortcut: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('shortcut', handler);
    return () => ipcRenderer.removeListener('shortcut', handler);
  },
  // A context-menu item in a page asked for a URL to be opened as a tab:
  // { url, background }. background:true means do not steal focus.
  // Fired by main whenever a guest webContents gains focus: { wcId }.
  onGuestFocus: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('guest-focus', handler);
    return () => ipcRenderer.removeListener('guest-focus', handler);
  },
  onOpenUrl: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('open-url', handler);
    return () => ipcRenderer.removeListener('open-url', handler);
  },
  // A command line asked to close tabs by address (closetabs.js; main.js reads the line).
  //   onRequest(fn(request)) -> unsubscribe: { ok: true, close: [prefix], keep: [prefix] }
  //                             or { ok: false, reason, droppedUrl? } (refused: show why)
  //   done({ ok, closed, matched, kept, pinned, notWeb, spared, prefixes } | { ok: false, reason })
  //                             counts only; main writes the quartz.log line from them.
  closeTabs: {
    onRequest: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('close-tabs', handler);
      return () => ipcRenderer.removeListener('close-tabs', handler);
    },
    done: (result) => ipcRenderer.send('close-tabs:result', result),
  },
  // A page tried to open a file:// URL and main refused (filenav.js):
  // { wcId, url, text }. The chrome puts `text` on that tab's note bar.
  onFileNavBlocked: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('file-nav-blocked', handler);
    return () => ipcRenderer.removeListener('file-nav-blocked', handler);
  },
  // A page's context menu asked for what is on screen to be handed to a Claude
  // chamber: { url, title, selection, mode? }. `selection` is '' for the
  // whole-page items, and is Chromium's already-truncated selectionText for the
  // selection one. `mode` is 'beside' (just open the chamber beside the page),
  // 'screenshot' (paste a PNG path) or absent (quote the page). The renderer
  // composes any prompt and pastes it into the session's INPUT -- nothing here
  // ever runs anything.
  onAskClaude: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('ask-claude', handler);
    return () => ipcRenderer.removeListener('ask-claude', handler);
  },
  // Paths only the main process knows for sure -- never guess at them here.
  app: {
    paths: () => ipcRenderer.invoke('app:paths'),
    // The theme GUEST PAGES see (prefers-color-scheme), not the chrome's own:
    // 'system' | 'light' | 'dark'. Main has no access to localStorage, so the
    // renderer replays the stored choice at load and on every change.
    setSiteTheme: (mode) => ipcRenderer.send('app:site-theme', { mode }),
    // Native "choose a folder for Claude" dialog. Resolves to the chosen
    // absolute path, or null if the user cancelled.
    pickFolder: (defaultPath) => ipcRenderer.invoke('app:pick-folder', { defaultPath }),
    // True only for an existing directory -- used to validate a typed path.
    dirExists: (path) => ipcRenderer.invoke('app:dir-exists', { path }),
    // Close and reopen the browser, tabs and all: the same graceful shutdown a
    // window close does, then a relaunch with this run's own argv (so a test
    // instance comes back a test instance). Nothing to await -- the process is
    // gone before a reply could arrive.
    restart: () => ipcRenderer.send('app:restart'),
    // Where the profile folder is and whether the one-time move to Quartz put
    // it there: { userData, test, thisStart, note }. Settings > About says it.
    profile: () => ipcRenderer.invoke('app:profile'),
    // The always-on DevTools (CDP) port, Settings > Claude (cdp-main.js):
    // { ok, enabled, enabledNext, governed, restartNeeded, mode, port, reason, error, ... }.
    cdp: () => ipcRenderer.invoke('cdp:describe'),
    // Saves the switch; it applies from the next start. Resolves to cdp()'s shape.
    setCdpEnabled: (enabled) => ipcRenderer.invoke('cdp:set-enabled', { enabled: enabled === true }),
    // Sync: these are already in this process, so nothing has to be awaited.
    versions: () => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      built: electronBuilt()
    })
  },
  // In-app updates (updater-main.js <-> updater-chrome.js). Every call answers the whole state
  // (status, release, why there is no button, progress, the last failure and the log's path);
  // update() answers { ok, reason?, relaunch?, state }. onRestart: the update is in and the chrome
  // writes its session, then restarts (restartNow for a swap, window.restartBrowser otherwise).
  updates: {
    state: () => ipcRenderer.invoke('updates:state'),
    check: () => ipcRenderer.invoke('updates:check'),
    setEnabled: (on) => ipcRenderer.invoke('updates:set', !!on),
    later: () => ipcRenderer.invoke('updates:later'),
    update: () => ipcRenderer.invoke('updates:update'),
    openLog: () => ipcRenderer.invoke('updates:open-log'),
    restartNow: () => ipcRenderer.send('updates:restart-now'),
    onState: (fn) => { ipcRenderer.on('updates:state', (_e, s) => { try { fn(s); } catch (err) { /* the next push redraws */ } }); },
    onRestart: (fn) => { ipcRenderer.on('updates:restart', (_e, m) => { try { fn(m); } catch (err) { /* main restarts by itself */ } }); }
  },
  // The window is frameless: the chrome draws its own caption buttons and
  // drives the real window through these.
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    info: () => ipcRenderer.invoke('win:info'),
    toggleFullscreen: () => ipcRenderer.send('win:fullscreen-toggle'),
    onMaximized: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('win:maximized', handler);
      return () => ipcRenderer.removeListener('win:maximized', handler);
    },
    onFullscreen: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('win:fullscreen', handler);
      return () => ipcRenderer.removeListener('win:fullscreen', handler);
    },
    // The REAL window's focus, as { focused }. Not the same thing as this
    // document's blur/focus: clicking into a <webview> blurs the chrome
    // document while the window itself never lost focus. Main sends the
    // current state once the page has loaded, then on every change.
    onFocus: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('win:focus', handler);
      return () => ipcRenderer.removeListener('win:focus', handler);
    }
  },
  // Downloads land in the Downloads folder with no prompt; main streams every
  // state change here as { id, filename, url, savePath, state, received,
  // total, paused, startedAt, finishedAt }.
  downloads: {
    list: () => ipcRenderer.invoke('dl:list'),
    cancel: (id) => ipcRenderer.send('dl:cancel', { id }),
    pause: (id) => ipcRenderer.send('dl:pause', { id }),
    resume: (id) => ipcRenderer.send('dl:resume', { id }),
    open: (id) => ipcRenderer.invoke('dl:open', { id }),
    show: (id) => ipcRenderer.send('dl:show', { id }),
    clear: () => ipcRenderer.send('dl:clear'),
    // "Ask where to save each file" lives in the renderer's settings store,
    // which main cannot read -- so the renderer pushes it at boot and on every
    // change. { askWhere:true } makes main show the native Save dialog.
    setPrefs: (prefs) => ipcRenderer.send('dl:prefs', { askWhere: !!(prefs && prefs.askWhere) }),
    // The Downloads folder itself, in Explorer -- not one file in it.
    openFolder: () => ipcRenderer.send('dl:open-folder'),
    downloadUrl: (url) => ipcRenderer.send('dl:download-url', { url }),
    onUpdate: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('dl:update', handler);
      return () => ipcRenderer.removeListener('dl:update', handler);
    }
  },
  // Page screenshots. capturePage() belongs to the guest's webContents, so main
  // does the work and writes the PNG into the Downloads folder itself -- it is
  // NOT a download item, so nothing about it comes back over dl:update.
  // `wcId` is a <webview>'s webContents id (webview.getWebContentsId()).
  capture: {
    // Resolves to { path, width, height } or { error }; never rejects.
    // `full` is reserved for a future full-page capture and does nothing yet.
    tab: (wcId, full) => ipcRenderer.invoke('capture:tab', { wcId, full: !!full }),
    // Reveal a finished screenshot in Explorer.
    show: (path) => ipcRenderer.send('capture:show', { path })
  },
  // The new tab's moving background. A renderer can read a picked picture on
  // its own, but a clip has to keep playing after the file moves -- so main
  // runs the dialog and copies the chosen file into <userData>/backgrounds/,
  // and settings.js stores only the file:// URL it hands back.
  background: {
    // Resolves { ok: true, fileUrl, fileName, bytes } or { ok: false, reason }
    // ('cancelled', 'too-large' past 512 MB, or a message). Never rejects.
    chooseVideo: () => ipcRenderer.invoke('background:choose-video'),
    // Deletes the copied clip; resolves { ok: true } either way.
    clearVideo: () => ipcRenderer.invoke('background:clear-video'),
    // The Windows wallpaper copy (the default background). wallpaper() copies
    // it once if there is no copy yet; recopyWallpaper() re-reads it from
    // Windows. Both resolve { ok, fileUrl, fileName, copiedAt, reason }.
    wallpaper: () => ipcRenderer.invoke('background:wallpaper'),
    recopyWallpaper: () => ipcRenderer.invoke('background:recopy-wallpaper'),
    // The built-in photos (Helm's gallery): { ok, reason, items: [{ id, file,
    // title, category, credit, url, fileUrl, thumbUrl, missing }] }.
    builtins: () => ipcRenderer.invoke('background:builtins')
  },
  // Look Sync (looksync-main.js / looksync.js): the look shared with Helm and
  // Mantle through %APPDATA%\look-sync\look.json, and Mantle's desktop still.
  // The chrome owns the settings; main owns the file.
  lookSync: {
    // { enabled, local: { theme, accent, glass } } -> { ok, status, desktop,
    // place, shared, mantle, systemTheme, dir, instance }
    hello: (init) => ipcRenderer.invoke('looksync:hello', init),
    local: (values) => ipcRenderer.send('looksync:local', values),
    publish: (field, value) => ipcRenderer.invoke('looksync:publish', field, value),
    setEnabled: (on) => ipcRenderer.invoke('looksync:set-enabled', !!on),
    refresh: () => ipcRenderer.send('looksync:refresh'),
    systemTheme: () => ipcRenderer.invoke('looksync:system-theme'),
    openMantle: () => ipcRenderer.invoke('looksync:open-mantle'),
    debug: () => ipcRenderer.invoke('looksync:debug'),
    onStatus: (cb) => subscribe('looksync:status', cb),
    onApply: (cb) => subscribe('looksync:apply', cb),
    onDesktop: (cb) => subscribe('looksync:desktop', cb),
    onPlace: (cb) => subscribe('looksync:place', cb),
    onSystemTheme: (cb) => subscribe('looksync:system-theme', cb)
  },
  // Top-row hints for Mantle's top bar (toprow.js -> the pipe client below
  // -> Mantle). hint() writes to the pipe from THIS process, in the page's
  // task: no hop through main, whose busy event loop held hints back.
  toprow: {
    hint: (top, t) => toprowHint(top, t),
    // -> { state: 'connected'|'connecting'|'waiting'|'off'|'starting', reason, pipe, sent, ... }
    status: () => toprowStatus(),
    onStatus: (cb) => {
      if (typeof cb !== 'function') return () => {};
      toprowListeners.add(cb);
      return () => toprowListeners.delete(cb);
    }
  },
  // The idle music player's own tracks. Nothing is copied: main runs the picker
  // and hands back descriptors, and the chrome plays each file where it lies
  // over a plain file:// URL (the chrome is itself a file:// document and
  // carries no CSP, so file:// media loads the way the new tab's background
  // clip already does).
  music: {
    // Multi-select picker for mp3/m4a/aac/flac/wav/ogg/opus/webm. Resolves
    // [{ path, name }] -- an EMPTY array means cancelled or refused, which is
    // the same thing to a caller: keep whatever list you had. Never rejects.
    chooseFiles: () => ipcRenderer.invoke('music:choose-files').then(
      (r) => (r && Array.isArray(r.files) ? r.files : []),
      () => []
    )
  },
  // Ad / tracker blocking. The engine lives in main and covers every guest at
  // once, so everything here is either a preference or a per-tab counter.
  // `wcId` is a <webview>'s webContents id (webview.getWebContentsId()).
  adblock: {
    // { enabled, ready, allow: string[] } -- `ready` is "engine built AND
    // hooked into the session", so it is false both when the lists failed to
    // load and when blocking is switched off.
    state: () => ipcRenderer.invoke('adblock:state'),
    // { blocked, host, allowed } for one tab, right now.
    count: (wcId) => ipcRenderer.invoke('adblock:count', { wcId }),
    setEnabled: (on) => ipcRenderer.send('adblock:set-enabled', { on }),
    // host is normalised in main: lowercased, `www.` stripped.
    allowHost: (host, on) => ipcRenderer.send('adblock:allow-host', { host, on }),
    // { wcId, blocked, host, allowed }, throttled to <= 4/sec per tab.
    onUpdate: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('adblock:update', handler);
      return () => ipcRenderer.removeListener('adblock:update', handler);
    },
    // Same shape as state(), pushed whenever the engine or prefs change.
    onStateChanged: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('adblock:state-changed', handler);
      return () => ipcRenderer.removeListener('adblock:state-changed', handler);
    }
  },
  // Autocorrect and spelling. The typing engine itself is spell-preload.js,
  // which main registers as a SESSION preload so it runs in every frame (the
  // chrome included) in the isolated world; this is only the Settings side.
  // Every call resolves to the same SpellState:
  //   { autocorrect, underline, sitesOff: string[], words: string[],
  //     available, reason, languages: string[] }
  // `available` false means the spellchecker cannot answer in this build or on
  // this machine, and `reason` says why in plain English for Settings to show.
  spell: {
    state: () => ipcRenderer.invoke('spell:state'),
    // { autocorrect?: bool, underline?: bool }
    set: (patch) => ipcRenderer.invoke('spell:set', {
      autocorrect: patch && typeof patch.autocorrect === 'boolean' ? patch.autocorrect : undefined,
      underline: patch && typeof patch.underline === 'boolean' ? patch.underline : undefined,
    }),
    // host is normalised in main: lowercased, `www.` stripped.
    siteOff: (host, off) => ipcRenderer.invoke('spell:site-off', { host: String(host || ''), off: !!off }),
    addWord: (word) => ipcRenderer.invoke('spell:add-word', { word: String(word || '') }),
    removeWord: (word) => ipcRenderer.invoke('spell:remove-word', { word: String(word || '') }),
    // Pushed whenever any of it changes, from Settings or a page's menu.
    onChanged: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('spell:changed', handler);
      return () => ipcRenderer.removeListener('spell:changed', handler);
    }
  },
  // quartz.log (log.js): the chrome reports what only it decides -- a crash
  // card it showed, a tab it put to sleep or woke. Plain data; main writes the
  // words. kind: 'tab-crashed' { url, reason, exitCode } | 'tab-slept' { url, why }
  // | 'tab-woke' { url, sleptMs }.
  log: {
    event: (kind, details) => ipcRenderer.send('log:event', Object.assign({}, details || {}, { kind: String(kind || '') })),
  },
  // Tab sleep's main half (tabsleep-main.js). wcId is a <webview>'s getWebContentsId().
  //   memory(wcIds) -> { ok, totalBytes, freeBytes, tabs: { [wcId]: { bytes, sharedWith } } } | { ok: false, reason }
  //   prepareSleep(wcId) -> { ok, probe: { ok, busy, tracked } | { ok: false, reason } } | { ok: false, reason }
  //   onAudioState(fn({ wcId, audible })) -> unsubscribe: Chromium's audibility of a guest, on every change.
  tabs: {
    memory: (wcIds) => ipcRenderer.invoke('tabs:memory', { wcIds: Array.isArray(wcIds) ? wcIds.filter(Number.isInteger) : [] }),
    prepareSleep: (wcId) => ipcRenderer.invoke('tabs:prepare-sleep', { wcId: Number(wcId) }),
    onAudioState: (cb) => {
      const handler = (_e, p) => { try { cb(p); } catch (err) { /* the chrome's problem, not the bridge's */ } };
      ipcRenderer.on('tabs:audio-state', handler);
      return () => ipcRenderer.removeListener('tabs:audio-state', handler);
    }
  },
  // Protected video (drm-main.js). DrmState:
  //   { widevine: { available, services, reason, short, vmp }, edge: { found, how, path },
  //     alwaysEdge: [{ key, name }], detection, extraSites, lastLaunch }
  drm: {
    state: () => ipcRenderer.invoke('drm:state'),
    // Resolves { ok, how, reason }; `reason` is plain words for the bar.
    openInEdge: (url) => ipcRenderer.invoke('drm:open-in-edge', { url: String(url || '') }),
    // key: 'prime' | 'host:example.com' (DrmSites.ruleKeyFor). Resolves { ok, reason, state }.
    setAlways: (key, on) => ipcRenderer.invoke('drm:set-always', { key: String(key || ''), on: !!on }),
    // A guest reported what it did with EME: { wcId, url, kind, keySystem?, granted? }
    onSignal: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('drm:signal', handler);
      return () => ipcRenderer.removeListener('drm:signal', handler);
    },
    onChanged: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('drm:changed', handler);
      return () => ipcRenderer.removeListener('drm:changed', handler);
    }
  },
  // Everything behind the padlock for one page: how the connection is secured,
  // the explicit permission decisions for its origin, and the two destructive
  // actions. Every call resolves -- a failure comes back as { error: string }
  // rather than rejecting.
  site: {
    // { origin, host, scheme, secure, reason, permissions, promptable }.
    // reason is 'https' | 'http' | 'certificate' | 'local' | 'other';
    // permissions holds ONLY origins' explicit decisions ('allow' | 'block'),
    // and promptable lists the names that would raise a dialog.
    info: (url) => ipcRenderer.invoke('site:info', { url }),
    // decision: 'allow' | 'block' | 'ask' -- 'ask' forgets it, so the next
    // request prompts again. Resolves to the origin's updated map.
    setPermission: (origin, permission, decision) =>
      ipcRenderer.invoke('site:set-permission', { origin, permission, decision }),
    // Forget every decision for this origin. Resolves to the (empty) map.
    resetPermissions: (origin) => ipcRenderer.invoke('site:reset-permissions', { origin }),
    // Storage + cookies for one origin, host and parent domain: { cookiesRemoved }.
    clearData: (origin) => ipcRenderer.invoke('site:clear-data', { origin }),
    // { origin }, pushed after any permission change -- including ones made in
    // another window's popover or by answering a prompt.
    onPermissionsChanged: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('site:permissions-changed', handler);
      return () => ipcRenderer.removeListener('site:permissions-changed', handler);
    }
  },
  // Durable mirror of the session localStorage holds. write() is fire-and-
  // forget (main writes it atomically); read() returns the parsed object or
  // null. The renderer decides which copy is newer by comparing savedAt.
  session: {
    write: (snapshot) => ipcRenderer.send('session:write', { snapshot }),
    read: () => ipcRenderer.invoke('session:read')
  },
  // Key bindings live in the renderer (shortcuts.js). A key pressed inside a
  // guest page is matched by main, so main needs the same map: it is mirrored
  // over at boot and again after every change. Fire-and-forget -- main keeps
  // its own defaults until something arrives.
  shortcuts: {
    set: (bindings) => ipcRenderer.send('shortcuts:set', { bindings })
  },
  // Spotify auto-pause. Two switches behind one group: `setEnabled` is the
  // WHOLE COMPUTER (the SpotifyAutoPause scheduled task and its local bridge),
  // `setConfig.browserHold` is only this browser's own tabs. Every call
  // resolves -- a bridge that is not running comes back as
  // { bridge: 'stopped', error: '...' }, never as a rejection.
  autopause: {
    // Status = { installed, enabled, bridge, port, spotify, wePaused, holds,
    //            browserHold, audibleTabs, config, error }. Answers in ~1.5 s
    //            even with nothing running, so it is safe to poll.
    status: () => ipcRenderer.invoke('autopause:status'),
    setEnabled: (on) => ipcRenderer.invoke('autopause:set-enabled', { on: !!on }),
    // Only the three known keys travel, and only in the right shape: main
    // re-validates anyway, but a typo here should not reach it as a mystery.
    // Hosts are sent as trimmed strings; main normalises and de-duplicates.
    setConfig: (patch) => {
      const p = patch && typeof patch === 'object' ? patch : {};
      const out = {};
      if (typeof p.browserHold === 'boolean') out.browserHold = p.browserHold;
      if (typeof p.anySite === 'boolean') out.anySite = p.anySite;
      if (Array.isArray(p.sites)) {
        out.sites = p.sites
          .map((s) => String(s == null ? '' : s).trim().slice(0, 253))
          .filter((s) => s.length > 0)
          .slice(0, 100);
      }
      return ipcRenderer.invoke('autopause:set-config', out);
    },
    // Runs doctor.ps1 -Json, which is read-only: { ok, text, json }.
    doctor: () => ipcRenderer.invoke('autopause:doctor'),
    // Pushed on every state change main sees (a hold taken or handed back, the
    // switch moving, a tab starting or stopping). Returns an unsubscribe.
    onStatus: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('autopause:changed', handler);
      return () => ipcRenderer.removeListener('autopause:changed', handler);
    }
  },
  // Spotify beyond auto-pause: the bridge's ad ducking, which turns the volume
  // down for an ad instead of pausing. Its current state arrives with every
  // autopause status as `status.adDuck`
  // ({ enabled, level, active, ducked, lastAdAt, episodes, error } or null when
  // the bridge is not running), so this is only the write side.
  spotify: {
    // level is the fraction of Spotify's volume to leave during an ad, clamped
    // to 0..0.2 (0 = silent). Resolves { ok: true, adDuck } or
    // { ok: false, reason }. Never rejects.
    setAdDuck: (enabled, level) => ipcRenderer.invoke('spotify:set-ad-duck', {
      enabled: !!enabled,
      level: Number(level)
    })
  },
  // Now playing on the WHOLE MACHINE (Spotify, or whatever else owns the media
  // keys), read and driven through the same local bridge. Every call resolves;
  // a bridge that is not there is { ok: false, reason } in plain English, so
  // this is safe to poll from the new tab page.
  media: {
    // { ok, source, title, artist, album, status: 'playing' | 'paused' |
    //   'stopped' | 'none', positionMs, durationMs, canNext, canPrev,
    //   canPlayPause, art, artHash }.
    // The argument is the art protocol: omit it for the cheap poll (no art
    // bytes at all), pass '' to ask for the art, or pass the artHash you
    // already hold to get art back only when the track's art has changed.
    now: (artHash) => ipcRenderer.invoke(
      'media:now',
      artHash == null ? null : String(artHash)
    ),
    // 'play' | 'pause' | 'toggle' | 'next' | 'prev' -> { ok, cmd, result } or
    // { ok: false, reason }. reason 'held' means the auto-pause watcher is
    // deliberately holding Spotify quiet for a video and will not be overruled.
    control: (cmd) => ipcRenderer.invoke('media:control', String(cmd == null ? '' : cmd))
  },
  // System stats for the new tab page (CPU, memory, disk, network, GPU).
  // Ref-counted in main: every subscribe() needs its own unsubscribe(), and
  // main samples nothing at all while the count is zero -- so the chrome
  // subscribes only while a new-tab page is actually in front of the user.
  // Samples land every 2000 ms; the first one arrives within 2 s.
  stats: {
    subscribe: () => ipcRenderer.send('stats:subscribe'),
    unsubscribe: () => ipcRenderer.send('stats:unsubscribe'),
    // fn({ t, cpu, mem, disk, net, gpu, uptimeSec }); a null field means the
    // counter is not available on this machine and the page draws a dash.
    // Returns an unsubscribe function for the LISTENER -- it does not touch
    // the sampler's ref count, which is subscribe()/unsubscribe()'s job.
    onSample: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('stats:sample', handler);
      return () => ipcRenderer.removeListener('stats:sample', handler);
    },
    // End the processes behind one row of the new tab page's process table.
    // pids is a plain array of numbers (at most 64; main drops the rest).
    // Resolves to [{ pid, ok, reason }] -- one entry per pid main accepted,
    // with the refusals ('self', 'protected', 'unavailable') spelled out so
    // the page can say why instead of just failing.
    endTask: (pids) => ipcRenderer.invoke('stats:end-task', Array.isArray(pids) ? pids : []),
    // The icon of the executable behind each process group, by the sample's own
    // group keys ('spotify', 'svchost'). At most 64 keys, each at most 64 chars
    // -- main drops the rest. Resolves to { [key]: dataUrl | null } with an
    // entry for every key main accepted; a null means "no icon for this one"
    // (unknown path, no icon in the exe), and it is worth asking again later.
    // Known keys come back from main's cache without touching the disk.
    procIcons: (keys) => ipcRenderer.invoke('stats:proc-icons', Array.isArray(keys) ? keys : [])
  },
  // Tab favicons (tabicons.js drives these; main's faviconstore.js answers).
  //   get(origins)  -> { [origin]: { src, data, at } | null }  the disk cache
  //   put(origin, { src, data })                               remember one (fire and forget)
  //   fetch(url)    -> { ok, mime, dataUrl } | { ok: false, reason }  raw icon bytes, http(s) only
  //   describe()    -> the cache's size, caps and last errors
  favicons: {
    get: (origins) => ipcRenderer.invoke('favicons:get', Array.isArray(origins) ? origins : []),
    put: (origin, entry) => ipcRenderer.send('favicons:put', String(origin || ''), entry && typeof entry === 'object'
      ? { src: String(entry.src || ''), data: String(entry.data || '') } : null),
    fetch: (url) => ipcRenderer.invoke('favicons:fetch', String(url || '')),
    describe: () => ipcRenderer.invoke('favicons:describe')
  },
  // Installed native apps: the new tab page's dock and the palette's
  // "Open <app>" rows. Main builds the index from Start Menu shortcuts plus
  // Get-StartApps, caches it for a day, and is the only one that ever starts a
  // process -- nothing here carries a command line.
  apps: {
    // { builtAt, buildMs, fromCache, iconsOmitted, counts, apps: [...] } where
    // each entry is { id, name, kind: 'exe'|'store', path, args, exe,
    // iconDataUrl }. `exe` is the lowercased basename ('spotify.exe') or null,
    // and it is what the caller matches against a stats sample's process
    // groups to know whether the app is running. `iconDataUrl` is a 32px PNG,
    // or null when the whole set was too big for one message -- then
    // iconsOmitted is true and icon(id) fetches them one at a time.
    // The first call of a session may take a second or two (the build); every
    // later one is served from memory.
    list: () => ipcRenderer.invoke('apps:list'),
    // One 32px PNG data URL by entry id, or null.
    icon: (id) => ipcRenderer.invoke('apps:icon', String(id == null ? '' : id)),
    // Start an app by entry id -> { ok, reason }. Detached: it resolves as soon
    // as Windows has taken the request, not when the app has drawn.
    launch: (id) => ipcRenderer.invoke('apps:launch', String(id == null ? '' : id)),
    // Bring a RUNNING app's main window forward -> { ok, reason, via? }.
    // Takes one pid or an ARRAY of them: a dock tile knows its app by exe
    // name, so it passes every pid of that name and main picks the one that
    // owns a window (an Electron app's lowest pid usually owns none). `via`
    // says which rule matched ('own' | 'console' | 'child').
    // This one does steal focus, because it only ever runs off a click on a
    // tile that was already showing a running dot.
    focus: (pid) => ipcRenderer.invoke(
      'apps:focus',
      Array.isArray(pid) ? pid.map((p) => Number(p)) : Number(pid)
    ),
    // Rebuild the index from source (a newly installed app, a changed icon)
    // and resolve to the same shape as list().
    refresh: () => ipcRenderer.invoke('apps:refresh')
  },
  // Native app tabs: a real program's own window, hosted inside a tab. Main
  // re-parents the app's top-level HWND into the browser window and moves it
  // over the tab's content area -- the app runs as itself, nothing is remoted.
  //
  // The new tab page's live price tile. Everything here is the SETTINGS side
  // of it: the tile itself is a preload-less guest and talks to stocks.js on a
  // console line, so nothing on this channel carries a price.
  //
  // THE KEY ONLY EVER GOES ONE WAY. There is deliberately no read: describe()
  // answers { enabled, hasKey, keyMask, keyState, symbols, selected,
  // historyPath, market, socket } and keyMask is bullets plus the last four
  // characters. A renderer -- and therefore a devtools console -- can tell
  // whether a key is set and can replace it, and can never read it back.
  //
  // keyState is '' or 'rejected' (Finnhub refused it; the module has backed
  // off rather than retrying). historyPath is 'unknown' until the first chart
  // loads, then 'finnhub' (a paid key) or 'yahoo' (the free tier, whose candle
  // endpoint answers 403). Every call resolves null if main refuses it.
  stocks: {
    describe: () => ipcRenderer.invoke('stocks:describe'),
    // '' clears the key. Resolves the same describe() shape, already updated.
    setKey: (key) => ipcRenderer.invoke('stocks:set-key', String(key == null ? '' : key)),
    setEnabled: (on) => ipcRenderer.invoke('stocks:set-enabled', on !== false),
    // Upper-case tickers; main normalises, de-duplicates and caps the list.
    setSymbols: (list) => ipcRenderer.invoke('stocks:set-symbols', Array.isArray(list) ? list : [])
  },
  // Quartz's own search page (bravesearch.js). Same one-way key as stocks:
  // describe() -> { hasKey, keyMask, last: { state, ok, title, at } | null,
  // usage: { limit, remaining, resetSec, at } | null, signupUrl, cacheMinutes }.
  // setKey('') removes it; an unusable paste comes back with `error`. test()
  // spends ONE real search and adds `check: { ok, state, title, detail }`.
  // Every call resolves null if main refuses it.
  braveSearch: {
    describe: () => ipcRenderer.invoke('brave-search:describe'),
    setKey: (key) => ipcRenderer.invoke('brave-search:set-key', String(key == null ? '' : key)),
    test: () => ipcRenderer.invoke('brave-search:test')
  },
  // The AI answer above Quartz results (claudeanswer.js). Same one-way key:
  // describe() -> { hasKey, keyMask, keyError, canEncrypt, mode, modes, capUsd,
  // autoModel, deepModel, models, month: { id, label, spentUsd, answers, capUsd,
  // capReached }, last, keysUrl, billingUrl, pricesChecked }. setKey('') removes
  // it; a refused paste comes back with `error`. setConfig({ mode, capUsd,
  // autoModel, deepModel }) saves any of those. test() is GET /v1/models (free)
  // and adds `check: { ok, state, title, detail }`. Null if main refuses.
  claudeAnswer: {
    describe: () => ipcRenderer.invoke('claude-answer:describe'),
    setKey: (key) => ipcRenderer.invoke('claude-answer:set-key', String(key == null ? '' : key)),
    setConfig: (patch) => ipcRenderer.invoke('claude-answer:set-config', patch && typeof patch === 'object' ? {
      mode: patch.mode, capUsd: patch.capUsd, autoModel: patch.autoModel, deepModel: patch.deepModel
    } : {}),
    test: () => ipcRenderer.invoke('claude-answer:test')
  },
  // The first-run welcome (firstrun-main.js): whether to show it, the flag
  // that says it is done, and its default-browser step. Every call resolves;
  // a failure comes back with a plain `reason`, never a silent null.
  firstrun: {
    state: () => ipcRenderer.invoke('firstrun:state'),
    done: (how) => ipcRenderer.invoke('firstrun:done', String(how == null ? '' : how)),
    makeDefault: () => ipcRenderer.invoke('firstrun:make-default'),
    defaultStatus: () => ipcRenderer.invoke('firstrun:default-status')
  },
  // The notes pane: the notes folder's subjects, the current subject, the
  // question reader, the headless-Claude helper and its match. State shape and
  // command names are documented in notes-pane-main.js; `configured: false`
  // means it is off (no notes folder in notes-pane.json). Every call resolves;
  // a refused or failing command answers { ok: false, reason } in plain words.
  notes: {
    describe: () => ipcRenderer.invoke('notes:describe'),
    command: (name, arg) => ipcRenderer.invoke('notes:command', String(name == null ? '' : name), arg == null ? null : arg),
    onUpdate: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('notes:update', handler);
      return () => ipcRenderer.removeListener('notes:update', handler);
    }
  },

  // The Phone workspace (Settings → Phone drives pairing/connecting; the
  // Phone page itself is a preload-less guest that talks to main over its own
  // localhost WebSocket). State shape and command names are documented in
  // phone.js. Every call resolves; a refused or failing command comes back as
  // { ok: false, reason } and the reason is shown, never swallowed.
  phone: {
    describe: () => ipcRenderer.invoke('phone:describe'),
    command: (name, arg) => ipcRenderer.invoke('phone:command', String(name == null ? '' : name), arg == null ? null : arg),
    onUpdate: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('phone:update', handler);
      return () => ipcRenderer.removeListener('phone:update', handler);
    },
    // The page asked for Settings → Phone (it cannot open it itself).
    onOpenSettings: (cb) => {
      const handler = () => cb();
      ipcRenderer.on('phone:open-settings', handler);
      return () => ipcRenderer.removeListener('phone:open-settings', handler);
    }
  },
  // An hwnd is always a DECIMAL STRING here ('4523874'), in both directions.
  // Every call answers a value: { ok: true, ... } or { ok: false, reason }
  // where reason is one of 'unavailable' (this build cannot do it at all),
  // 'refused', 'bad-request', 'unknown-app', 'no-window', 'gone',
  // 'store-app' (a UWP/Store window, which cannot be hosted), 'own-window',
  // 'not-top-level' (already somebody's child -- including our own render
  // widgets), 'owned-window' (a dialog or splash belonging to another window),
  // 'tool-window' (a palette or tray helper), 'already-attached',
  // 'not-attached', 'open-pending' (that tab already has an open() running),
  // 'cancelled' (the tab was detached while its app was still starting), or a
  // '*-failed'.
  embed: {
    // Hostable windows: visible, titled, top-level, never one of ours.
    // { pid } for one process, { exe: 'notepad' | 'notepad.exe' } for every
    // copy of a program, neither for all of them. Front-to-back z-order, which
    // is the practical "newest first" -- a window that just opened is at the
    // front. Each entry is { hwnd, pid, title, className, exe }.
    find: (filter) => ipcRenderer.invoke('embed:find', {
      pid: filter && filter.pid != null ? Number(filter.pid) : undefined,
      exe: filter && filter.exe != null ? String(filter.exe) : undefined
    }),
    // Host an existing window in a tab. It stays HIDDEN until the first
    // layout() call -> { ok, hwnd, mode, title, className, pid, exe }.
    //
    // `mode` ('owner' | 'child') is the hosting mechanism and is OPTIONAL: the
    // engine's DEFAULT_MODE is the answer for every normal caller, and the
    // chrome never passes one. It is accepted so that a live check can host the
    // same window both ways and compare.
    attach: (tabId, hwnd, mode) => ipcRenderer.invoke('embed:attach', {
      tabId: String(tabId == null ? '' : tabId),
      hwnd: String(hwnd == null ? '' : hwnd),
      mode: mode == null ? undefined : String(mode)
    }),
    // Launch an installed app by its apps.list() id and host the window of
    // the process it started (a copy already running is adopted only when
    // no new window appears and nothing of that exe is still starting).
    // Waits up to 20 s for the app to draw, then { ok: false, reason:
    // 'no-window' }. Same attach shape on success.
    open: (tabId, appId) => ipcRenderer.invoke('embed:open', {
      tabId: String(tabId == null ? '' : tabId),
      appId: String(appId == null ? '' : appId)
    }),
    // Put the app window over the tab's content area. The rect is in THIS
    // page's CSS pixels, relative to the window's client area (main converts
    // to physical pixels with the display's scale factor). Idempotent and
    // cheap -- safe to call on every resize frame. `visible` false hides the
    // window without giving it up (that is what switching tabs does).
    // -> { ok, changed, rect, visible, scale }.
    layout: (tabId, rect, visible) => {
      /* A MISSING OR NON-NUMERIC RECT IS A CALLER BUG, NOT "HIDE THE APP".
       * (R8, 2026-09-12: measured. `layout(tab, null, true)` used to build
       * {0,0,0,0} here, which main.js's own guard could not see -- the object was
       * there -- and a zero-area rect is how this module says "hidden". So one
       * malformed call made the app in the tab disappear, and answered ok.) */
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
      const box = rect && typeof rect === 'object'
        ? { x: num(rect.x), y: num(rect.y), w: num(rect.w), h: num(rect.h) } : null;
      if (!box || box.x === null || box.y === null || box.w === null || box.h === null) {
        return Promise.resolve({ ok: false, reason: 'bad-rect' });
      }
      return ipcRenderer.invoke('embed:layout', {
        tabId: String(tabId == null ? '' : tabId),
        rect: box,
        visible: visible !== false
      });
    },
    // Give the window back to the desktop: top-level again, its own frame, its
    // own old position, and never activated. The app keeps running.
    detach: (tabId, opts) => ipcRenderer.invoke('embed:detach', {
      tabId: String(tabId == null ? '' : tabId),
      restore: !(opts && opts.restore === false)
    }),
    // Ask the app to close itself (the same WM_CLOSE its X button sends, so
    // unsaved work still prompts). If it is still there 3 s later it is showing
    // a dialog, so the window is handed back to the desktop and onGone fires.
    close: (tabId) => ipcRenderer.invoke('embed:close', {
      tabId: String(tabId == null ? '' : tabId)
    }),
    // { available, windows: [{ tabId, hwnd, pid, title, className, exe,
    // visible, rect }], stats } -- `available` is false on a build where the
    // Win32 binding did not load, and then nothing else here will work.
    list: () => ipcRenderer.invoke('embed:list'),
    // The app behind a tab went away (it closed itself, crashed, or ignored
    // WM_CLOSE and was handed back). Returns an unsubscribe function.
    onGone: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('embed:gone', handler);
      return () => ipcRenderer.removeListener('embed:gone', handler);
    },
    // The app stopped answering (two seconds of IsHungAppWindow). Its window is
    // STILL HOSTED -- the engine reports, it never moves the window, because a
    // detach cannot land until the app answers again anyway. { tabId, hwnd, pid }.
    // Returns an unsubscribe function.
    onHung: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('embed:hung', handler);
      return () => ipcRenderer.removeListener('embed:hung', handler);
    },
    // A tab reported hung is answering again: { tabId, hwnd }. Nothing to undo --
    // the window never left the tab -- so this is the cue to drop the warning.
    onRecovered: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('embed:recovered', handler);
      return () => ipcRenderer.removeListener('embed:recovered', handler);
    },
    // The hosted app renamed its own window: { tabId, title }. Pushed only on a
    // change, straight from the app's caption ("(3) Discord" arrives as it is).
    onTitle: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('embed:title', handler);
      return () => ipcRenderer.removeListener('embed:title', handler);
    },
    // WHO HAS THE KEYBOARD while an app window is hosted: { ours, hostedTabId }.
    // `ours` true means the foreground window is THIS browser -- even when
    // Electron calls the window blurred, which it does the moment focus moves
    // into the hosted child. Anything hung off window focus should believe this
    // instead. Pushed only on a change, and only while something is hosted.
    // Returns an unsubscribe function.
    onFocus: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('embed:focus', handler);
      return () => ipcRenderer.removeListener('embed:focus', handler);
    },
    // A browser shortcut pressed while the hosted app had the keyboard: main
    // registered it with the OS for exactly that state and replays it here as
    // { id }, the same action id the keydown path resolves. Main has already
    // given keyboard focus back to the chrome by the time this arrives.
    onShortcutFire: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('shortcut:fire', handler);
      return () => ipcRenderer.removeListener('shortcut:fire', handler);
    },
    // { info: focusInfo(), polling, streak, armed, registered, set } -- what
    // Win32 says right now and which accelerators are really in the OS table.
    // Read-only; the live verification's window onto both.
    focusInfo: () => ipcRenderer.invoke('embed:focus-info')
  },
  // Watch (watch-main.js), for Settings > Watch only: the page itself talks to
  // main over console lines and never sees these. Every call answers the same
  // describe() value -- { services: [{ id, name, enabled, state, reason,
  // readAt, profile, paused, ... }], leagues, allLeagues, tmdb: { hasKey,
  // keyMask, signupUrl }, cacheBytes, reading } -- and the TMDB key itself
  // never comes back out (a mask only).
  // The Watch player layer (watch-player.js <-> watch-player-main.js).
  watchPlayer: {
    get: () => ipcRenderer.invoke('watch-player:get'),
    setInside: (on) => ipcRenderer.invoke('watch-player:set-inside', { on: !!on }),
    adopt: (wcId, service, origin) => ipcRenderer.invoke('watch-player:adopt', { wcId: Number(wcId), service: String(service || ''), origin: String(origin || '') }),
    mode: (mode) => ipcRenderer.invoke('watch-player:mode', { mode: String(mode || '') }),
    free: () => ipcRenderer.invoke('watch-player:free'),
    alive: (wcId) => ipcRenderer.invoke('watch-player:alive', { wcId: Number(wcId) }),
    memory: () => ipcRenderer.invoke('watch-player:memory'),
    escape: (why, url) => ipcRenderer.invoke('watch-player:escape', { why: String(why || ''), url: String(url || '') }),
    closed: (services) => ipcRenderer.invoke('watch-player:closed', { services: Array.isArray(services) ? services.map(String) : [] }),
    sheetRect: (id, rect) => ipcRenderer.invoke('watch-player:sheet-rect', { id: Number(id), rect: rect && typeof rect === 'object' ? { x: +rect.x || 0, y: +rect.y || 0, width: +rect.width || 0, height: +rect.height || 0 } : null }),
    sheetClose: (id, why) => ipcRenderer.invoke('watch-player:sheet-close', { id: Number(id), why: String(why || '') }),
    sheetToTab: (id) => ipcRenderer.invoke('watch-player:sheet-to-tab', { id: Number(id) }),
    // TEST ONLY: main answers this only in a --test-profile instance (the e2e's whole-window shot).
    testCapture: (o) => ipcRenderer.invoke('watch-player:test-capture', { width: Number(o && o.width) || 0, height: Number(o && o.height) || 0, wait: Number(o && o.wait) || 0 }),
    // Up next: a title ended in the layer; main answers what follows it on that service (or why nothing).
    upNext: (item) => ipcRenderer.invoke('watch-player:up-next', { item: item && typeof item === 'object' ? { id: String(item.id || ''), service: String(item.service || ''), title: String(item.title || ''), subtitle: String(item.subtitle || '') } : null }),
    // main -> chrome: play / command / key / left / blocked / gone / sheet / sheet-gone
    on: (name, cb) => {
      const ch = 'watch-player:' + String(name || '');
      if (!/^watch-player:(play|command|key|left|blocked|gone|sheet|sheet-gone)$/.test(ch)) return () => {};
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on(ch, handler);
      return () => ipcRenderer.removeListener(ch, handler);
    }
  },
  // Lumen's playback view (watch-playview.js <-> watch-playview-main.js): "When a video plays".
  // testWin() answers only in a --test-profile instance.
  lumenPlayview: {
    get: () => ipcRenderer.invoke('watch-playview:get'),
    setView: (view) => ipcRenderer.invoke('watch-playview:set-view', { view: String(view || '') }),
    testWin: () => ipcRenderer.invoke('watch-playview:test-win')
  },
  // Lumen's ambient field (watch-ambient.js -> watch-ambient-main.js): { saver } before a colour refresh.
  lumenAmbient: {
    gate: () => ipcRenderer.invoke('lumen-ambient:gate')
  },
  // Lumen's Shorts view (watch-shorts.js -> watch-shorts-main.js): one quartz.log line.
  lumenShorts: {
    log: (line) => ipcRenderer.invoke('watch-shorts:log', { line: String(line || '').slice(0, 200) })
  },
  watch: {
    describe: () => ipcRenderer.invoke('watch:describe'),
    setEnabled: (id, on) => ipcRenderer.invoke('watch:set-enabled', String(id == null ? '' : id), !!on),
    setLeagues: (list) => ipcRenderer.invoke('watch:set-leagues', Array.isArray(list) ? list.map(String) : []),
    setTmdbKey: (key) => ipcRenderer.invoke('watch:set-tmdb-key', String(key == null ? '' : key)),
    // One small TMDB request with the saved key: describe() + { check: { ok, title, detail } }.
    testTmdb: () => ipcRenderer.invoke('watch:test-tmdb'),
    forget: () => ipcRenderer.invoke('watch:forget'),
    setBackground: (on) => ipcRenderer.invoke('watch:set-background', !!on),
    // Settings > Lumen "Preview videos when I hover" (watch-tilepreview.js)
    setTilePreview: (on) => ipcRenderer.invoke('watch:set-tile-preview', !!on),
    refresh: (id) => ipcRenderer.invoke('watch:refresh', id == null ? null : String(id))
  },
  // Lumen Alerts (watch-alerts-main.js <-> watch-alerts-chrome.js): the alerts main sends, where
  // each one went, a click's action, and Settings > Lumen > Alerts. test() answers only in a test profile.
  lumenAlerts: {
    describe: () => ipcRenderer.invoke('lumen-alerts:describe'),
    set: (kind, on) => ipcRenderer.invoke('lumen-alerts:set', String(kind || ''), !!on),
    act: (id, action, index) => ipcRenderer.invoke('lumen-alerts:act', { id: String(id || ''), action: String(action || ''), index: Number(index) || 0 }),
    shown: (id, surface, ok, reason) => ipcRenderer.send('lumen-alerts:shown', { id: String(id || ''), surface: String(surface || ''), ok: !!ok, reason: String(reason || '') }),
    onShow: (fn) => { ipcRenderer.on('lumen-alerts:show', (_e, a) => { try { fn(a); } catch (err) { /* the chrome answers shown() itself */ } }); },
    test: (op) => ipcRenderer.invoke('lumen-alerts:test', op && typeof op === 'object' ? op : {})
  },
  // Lumen's pinned scores (score-pins-main.js), for the palette rows and the cards' look
  // (scorepins-chrome.js). games() answers from Lumen's cached ESPN rows, never a fetch:
  // { games: [{ key, id, league, leagueName, state, startsAt, detail, away, home }], pinned: [key], sound }.
  scores: {
    games: () => ipcRenderer.invoke('scores:games'),
    pin: (game) => ipcRenderer.invoke('scores:pin', game && typeof game === 'object' ? game : null),
    unpin: (key) => ipcRenderer.invoke('scores:unpin', String(key == null ? '' : key)),
    setSound: (on) => ipcRenderer.invoke('scores:set-sound', !!on),
    look: (look) => ipcRenderer.send('scores:look', look && typeof look === 'object' ? look : {}),
    onChanged: (fn) => { ipcRenderer.on('scores:changed', (_e, m) => { try { fn(m); } catch (err) { /* the palette refreshes next time */ } }); },
    // TEST PROFILES ONLY (main registers it for --test-profile runs): the cards' state for the e2e.
    test: (op) => ipcRenderer.invoke('scores:test', op && typeof op === 'object' ? op : {})
  },
  // The Files tab. files.html is a guest with no preload, so app.js reaches
  // these on its behalf once it has decided the console line it parsed was a
  // real request; main answers nothing but values, never a throw.
  files: {
    // One folder -> { path, parent, entries, error, truncated }, where entries
    // are { name, path, kind: 'dir'|'file', size, mtime, ext } with folders
    // first, and at most 2,000 of them (then truncated is true). `error` is
    // null | 'not-found' | 'access-denied' | 'not-a-folder' | a message.
    // null asks for the root, which is the places and drives below.
    list: (target) => ipcRenderer.invoke('files:list', typeof target === 'string' ? target : null),
    // { places: [{ name, path }], drives: [{ name, path, label, freeBytes,
    // totalBytes }] } — Desktop … Music plus the user folder, and every drive
    // letter that answered. `label` is always '' (Windows does not hand
    // Electron a volume label); the page shows the letter alone for that.
    places: () => ipcRenderer.invoke('files:places'),
    // Open a file with whatever Windows opens it with -> { ok, reason }. A
    // shortcut is opened like anything else: that is what a shortcut is for.
    open: (target) => ipcRenderer.invoke('files:open', String(target == null ? '' : target)),
    // Show it in Explorer -> { ok, reason }. This one raises a window, so it
    // only ever runs off the page's own right-click menu.
    reveal: (target) => ipcRenderer.invoke('files:reveal', String(target == null ? '' : target)),
    // 16px shell icons by path -> { [path]: dataUrl | null }, at most 64 paths
    // per call (main drops the rest). Keyed by the exact strings passed in.
    icons: (paths) => ipcRenderer.invoke('files:icons', Array.isArray(paths) ? paths : []),
    // The path itself, onto the clipboard -> { ok, reason }.
    copyPath: (target) => ipcRenderer.invoke('files:copy-path', String(target == null ? '' : target))
  },
  // The address bar's folder source (history.js only): the folders directly
  // under the home folder and Downloads, depth 1, as
  // { ok, folders: [{ name, path, root: 'home'|'downloads' }], reason }.
  // Always resolves; an unreadable root comes back as ok:false with a reason
  // in plain words. See the "lens's folder source" block in main.js.
  listProjectFolders: () => ipcRenderer.invoke('omni:folders'),
  pty: {
    // The terminal programs a tab may run: [{ id, title, available }]. The ids
    // are the only thing start() accepts as `program`.
    programs: () => ipcRenderer.invoke('pty:programs')
      .then((list) => (Array.isArray(list) ? list : []))
      .catch(() => []),
    // opts: { program, cwd, cols, rows, args } -- `program` is an id from
    // programs() and defaults to 'claude' (so an old caller is unchanged);
    // `args` is an allowlist (`--continue`), claude-only.
    // Called by terminal.js for the first spawn AND for the Enter-to-restart
    // one, so this is where the skip-permissions flag is guaranteed.
    start: (opts) => ipcRenderer.invoke('pty:start', withSkipPermissions(opts)),
    // { skipPermissions, readTabs } -- the Settings switches, pushed by app.js
    // at boot and on every change. Nothing crosses IPC: they only steer start().
    setPrefs: (prefs) => {
      ptySkipPermissions = !!(prefs && prefs.skipPermissions === true);
      ptyReadTabs = !!(prefs && prefs.readTabs === true);
    },
    write: (id, data) => ipcRenderer.send('pty:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.send('pty:kill', { id }),
    onData: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('pty:data', handler);
      return () => ipcRenderer.removeListener('pty:data', handler);
    },
    onExit: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('pty:exit', handler);
      return () => ipcRenderer.removeListener('pty:exit', handler);
    }
  },
  // Claude panes' read-only tab tools (mcp-main.js). Main asks the chrome for
  // what only it knows (the tab list, the history store) and the chrome
  // answers with reply(); every tool call comes back as an activity line to
  // show over the pane that made it (paneId null: no pane, show a toast).
  mcp: {
    // cb({ reqId, op: 'tabs'|'history', args })
    onQuery: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('mcp:query', handler);
      return () => ipcRenderer.removeListener('mcp:query', handler);
    },
    reply: (reqId, result) => ipcRenderer.send('mcp:reply', { reqId, result }),
    // cb({ paneId, line })
    onActivity: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('mcp:activity', handler);
      return () => ipcRenderer.removeListener('mcp:activity', handler);
    },
    // cb({ paneId, attached, reason }) once per Claude spawn
    onPane: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('mcp:pane', handler);
      return () => ipcRenderer.removeListener('mcp:pane', handler);
    },
    // Ask first: cb({ askId, paneId, text, grantLabel, timeoutMs }) for a read
    // that waits on the user; answer() with 'once' | 'grant' | 'deny'.
    onAsk: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('mcp:ask', handler);
      return () => ipcRenderer.removeListener('mcp:ask', handler);
    },
    // cb({ askId, choice: 'timeout' }): nobody answered in time; the read was refused.
    onAskDone: (cb) => {
      const handler = (_event, payload) => cb(payload);
      ipcRenderer.on('mcp:ask-done', handler);
      return () => ipcRenderer.removeListener('mcp:ask-done', handler);
    },
    answer: (askId, choice) => ipcRenderer.send('mcp:answer', { askId, choice }),
    // Ask about this page: the pane may read that one tab without asking.
    preapprove: (paneId, tabId) => ipcRenderer.send('mcp:preapprove', { paneId, tabId })
  }
});
