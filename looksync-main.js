'use strict';
/*
 * looksync-main.js - Quartz's main-process side of Look Sync.
 *
 * Helm, Quartz and Mantle share one look (theme, accent, glass) through
 * %APPDATA%\look-sync\look.json, and Mantle publishes the desktop wallpaper
 * there (its still). Spec: ~/look-sync/CONTRACT.md; the module itself is
 * vendored in looksync/ (never edit it here).
 *
 * The chrome renderer OWNS the settings (localStorage), so this file only
 * runs the shared-file side:
 *   - one LookSync instance (app 'quartz'), created on the renderer's first
 *     looksync:hello, because the switch and the local values live there;
 *   - relays 'status', 'apply' and 'desktop' to the chrome over IPC;
 *   - publishes what the renderer sends back (looksync:publish);
 *   - re-reads on window focus and on resume from sleep (fs.watch can drop
 *     events; there is no polling);
 *   - sends the window's place on the screen (content bounds + the monitor
 *     it is mostly on) so the desktop still can be drawn lined up;
 *   - reads Windows' apps mode for the theme 'system'.
 *
 * Test runs (--test-profile) never touch the real %APPDATA%\look-sync: they
 * use LOOK_SYNC_DIR when it is set, else <test userData>/look-sync.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const LS = require('./looksync/look-sync');
const winMode = require('./looksync/windows-mode');

const STILL_EXT = /\.(jpe?g|png|webp|bmp)$/i;
// Mantle's live instance opens its Wallpapers window when a second instance is
// started with --open=wallpapers (Mantle look-sync lane, 2026-10-10). That second
// instance exits 0 = opened, 3 = Mantle is not running, 4 = value refused.
const MANTLE_DIR = path.join(require('os').homedir(), 'mantle-live');
const MANTLE_CMD = {
  exe: path.join(MANTLE_DIR, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: ['.', '--open=wallpapers'],
  cwd: MANTLE_DIR,
};
const MANTLE_EXIT = {
  3: 'Mantle is not running, so its Wallpapers could not be opened',
  4: 'Mantle refused the request',
};
const MANTLE_OPEN = fs.existsSync(MANTLE_CMD.exe)
  ? { canOpen: true, reason: null }
  : { canOpen: false, reason: 'Mantle was not found at ' + MANTLE_DIR };

function openMantleWallpapers() {
  return new Promise((resolve) => {
    let done = false;
    let err = '';
    let child = null;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    // `reason` is plain words for the screen; `detail` is the raw text (an error message, Mantle's
    // stderr) for quartz.log only. Mantle's stderr never becomes the reason.
    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'Mantle did not answer within 10 seconds; it may be busy or stuck', detail: err.trim().slice(0, 400) });
      try { child && child.kill(); } catch (_) {}
    }, 10000);
    const couldNotStart = (e) => ({ ok: false, reason: 'Quartz could not start Mantle to ask it (its program in ~/mantle-live would not run)', detail: String((e && e.message) || e || '').slice(0, 400) });
    try {
      child = require('child_process').spawn(MANTLE_CMD.exe, MANTLE_CMD.args, { cwd: MANTLE_CMD.cwd, windowsHide: true });
    } catch (e) {
      finish(couldNotStart(e));
      return;
    }
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    child.on('error', (e) => finish(couldNotStart(e)));
    child.on('exit', (code) => finish(code === 0 ? { ok: true }
      : { ok: false, reason: MANTLE_EXIT[code] || ('Mantle stopped with an error before opening its Wallpapers (exit code ' + code + ')'), detail: err.trim().slice(0, 400) }));
  });
}

/*
 * The folder as its long, real path. Electron's fs.watch on Windows names each change by cutting
 * the file's LONG path at the length of the folder AS GIVEN; given an 8.3 short path (a GitHub
 * runner's TEMP is C:\Users\RUNNER~1\..., so a test profile there is one) the name comes out as
 * 'nc\look.json' (the tail of 'look-sync' plus the file). look-sync reads a name with a
 * backslash as 'the folder was removed': a 'Problem' toast after every write, and changes from
 * Mantle or Helm never followed. Measured on a runner: plain node 24 names it right, Electron 44
 * does not (zf probe, cloud run 38691949758). Hand look-sync the long path.
 */
function longPath(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync.native(dir);
  } catch (e) {
    return dir; // look-sync makes it, or reports why it cannot
  }
}

/** A file's long, real path; a missing file keeps its name under its folder's long path. */
function longFile(file) {
  const p = path.resolve(String(file));
  try { return fs.realpathSync.native(p); } catch (e) { /* missing: try its folder */ }
  try { return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p)); } catch (e) { return p; }
}

function install(deps) {
  const { app, ipcMain, send, liveWin, isChromeSender, screen, powerMonitor, nativeTheme } = deps;
  const isTest = process.argv.includes('--test-profile');
  // Resolved lazily: --test-profile rewrites userData before ready.
  const syncDir = () => longPath(process.env.LOOK_SYNC_DIR
    || (isTest ? path.join(app.getPath('userData'), 'look-sync') : LS.defaultDir()));

  let sync = null;
  let local = {};               // the renderer's current values: the seed source
  let lastStatus = { state: 'starting', reason: 'waiting for the window', rev: null, by: null, at: null, skipped: [] };
  let lastDesktop = { state: 'loading', stillUrl: null, title: null, rev: null, reason: 'waiting for the window', record: null };
  let lastPlace = null;
  let placeQueued = false;
  let systemTheme = { light: null, reason: 'not read yet' };
  let modeReading = null;

  /* ---- desktop record -> what the renderer draws ------------------- */

  /* One plain sentence: the state, then the reason, said once. (It used to
     wrap every reason in "Mantle hasn't shared one (...)", which read
     "Mantle hasn't shared one (Mantle hasn't shared a desktop wallpaper
     yet)" in the commonest case, and was wrong for a record that WAS shared
     but could not be used.) */
  function fallback(why, record) {
    return {
      state: 'fallback', stillUrl: null, title: record && record.title || null, rev: record ? record.rev : null,
      reason: "Following Windows' wallpaper: " + why, record: record || null
    };
  }

  function desktopPayload(d) {
    const record = d && d.record;
    if (!record) {
      // look-sync.js's own words for "no record" are "Mantle hasn't shared a desktop wallpaper yet".
      const why = d && d.reason ? String(d.reason) : '';
      return fallback(!why || /hasn.t shared/i.test(why) ? "Mantle hasn't shared one yet" : why, null);
    }
    if (!record.ok) {
      return fallback(record.reason ? 'Mantle says ' + String(record.reason).replace(/^Mantle (says|reported) /i, '') : 'Mantle says its wallpaper is unavailable', record);
    }
    if (!record.still) return fallback("Mantle's record has no still picture", record);
    const stillsDir = path.resolve(sync ? sync.dir : syncDir(), 'stills');
    // Long form, like the folder (longPath): Mantle may name it through a short path.
    const still = longFile(record.still);
    if (still.toLowerCase().indexOf(stillsDir.toLowerCase() + path.sep) !== 0) {
      return fallback("Mantle's still is outside " + stillsDir, record);
    }
    if (!STILL_EXT.test(still)) return fallback("Mantle's still is not a picture file: " + path.basename(still), record);
    let st = null;
    try { st = fs.statSync(still); } catch (err) { return fallback("Mantle's still " + path.basename(still) + ' is missing: ' + (err.code || err.message), record); }
    if (!st.isFile() || st.size === 0) return fallback("Mantle's still is empty: " + path.basename(still), record);
    const g = guardOf(record);
    const gl = guardLightOf(record);
    return {
      state: 'ok', stillUrl: pathToFileURL(still).href + '?rev=' + record.rev,
      title: record.title || record.id || null, rev: record.rev, reason: null, record,
      stillSize: record.stillSize || null, type: record.type || null,
      guard: g.guard, guardReason: g.reason,
      guardLight: gl.guard, guardLightReason: gl.reason
    };
  }

  /* CONTRACT "Shared top-band darkening": Mantle's one dark alpha for the
     top 100 DIP of the monitor. { guard: { alpha, dim, blurPx, contrast },
     reason: null } when it is usable, else { guard: null, reason } in words.
     Freshness (dim/blurPx against the synced glass) is the renderer's check:
     it knows the glass in effect, a live preview included. */
  function guardOf(record) {
    const isNum = (v) => typeof v === 'number' && isFinite(v);
    const g = record.guard;
    if (g === undefined || g === null) {
      return { guard: null, reason: record.guardReason
        ? "Mantle couldn't work out the shared value (" + String(record.guardReason) + ')'
        : "Mantle's record has no shared value (an older Mantle?)" };
    }
    const d = g && typeof g === 'object' ? g.dark : null;
    if (!d || typeof d !== 'object') return { guard: null, reason: "Mantle's shared value has no dark entry" };
    // An alpha at all here; its range (the dim it was worked out from up to
    // the .88 ceiling) is the renderer's check, next to the freshness one,
    // since the floor IS the dim (CONTRACT: start at glass.dark.dim).
    if (!isNum(d.alpha) || d.alpha < 0 || d.alpha > 1) {
      return { guard: null, reason: "Mantle's shared value " + JSON.stringify(d.alpha) + ' is not an alpha (0-1)' };
    }
    if (!isNum(d.dim)) return { guard: null, reason: "Mantle's shared value names no dim" };
    if (!isNum(d.blurPx)) return { guard: null, reason: "Mantle's shared value names no blur" };
    return {
      guard: { alpha: Math.round(d.alpha * 100) / 100, dim: d.dim, blurPx: d.blurPx,
               contrast: isNum(d.contrast) ? d.contrast : null },
      reason: null
    };
  }

  /* CONTRACT "Light look": desktop.guard.light, Mantle's one WHITE alpha for
     the same top band in light (ink-2 #333A4E keeps 4.7:1 over its darkest
     pixels). Same shape and checks as dark; a missing entry is said as
     "not published by Mantle yet" (an older Mantle publishes dark only). */
  function guardLightOf(record) {
    const isNum = (v) => typeof v === 'number' && isFinite(v);
    const g = record.guard;
    const d = g && typeof g === 'object' ? g.light : null;
    if (d === undefined || d === null) {
      return { guard: null, reason: record.guardReason && !(g && typeof g === 'object')
        ? "Mantle couldn't work out the light top band (" + String(record.guardReason) + ')'
        : 'light top band not published by Mantle yet' };
    }
    if (typeof d !== 'object') return { guard: null, reason: "Mantle's light top band is not a record" };
    if (!isNum(d.alpha) || d.alpha < 0 || d.alpha > 1) {
      return { guard: null, reason: "Mantle's light top band " + JSON.stringify(d.alpha) + ' is not an alpha (0-1)' };
    }
    if (!isNum(d.dim)) return { guard: null, reason: "Mantle's light top band names no dim" };
    if (!isNum(d.blurPx)) return { guard: null, reason: "Mantle's light top band names no blur" };
    return {
      guard: { alpha: Math.round(d.alpha * 100) / 100, dim: d.dim, blurPx: d.blurPx,
               contrast: isNum(d.contrast) ? d.contrast : null },
      reason: null
    };
  }

  /* ---- where the window is on the screen ----------------------------- */

  function placeOf(win) {
    if (!win || win.isDestroyed()) return null;
    try {
      const c = win.getContentBounds();
      const d = screen.getDisplayMatching(c);
      return {
        content: { x: c.x, y: c.y, width: c.width, height: c.height },
        display: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, scaleFactor: d.scaleFactor, id: d.id },
        maximized: win.isMaximized(), fullscreen: win.isFullScreen(), minimized: win.isMinimized()
      };
    } catch (err) { return null; }
  }

  // Windows fires 'move' per mouse step while dragging: one send per turn of
  // the event loop is plenty (the renderer coalesces again to its frames).
  function queuePlace() {
    if (placeQueued) return;
    placeQueued = true;
    setImmediate(() => {
      placeQueued = false;
      const p = placeOf(liveWin());
      if (!p || p.minimized) return;
      const key = JSON.stringify(p);
      if (lastPlace && JSON.stringify(lastPlace) === key) return;
      lastPlace = p;
      send('looksync:place', p);
    });
  }

  /* ---- Windows apps mode (theme 'system') ------------------------------ */

  function readMode() {
    if (modeReading) return modeReading;
    // Tests only: a slow reg.exe, the way a runner busy at boot is (sessions-e2e, boot 1).
    const slow = isTest ? Math.min(Number(process.env.QUARTZ_TEST_APPS_MODE_DELAY_MS) || 0, 8000) : 0;
    const read = slow > 0 ? new Promise((r) => setTimeout(r, slow)).then(() => winMode.appsMode()) : winMode.appsMode();
    modeReading = read.then((m) => {
      modeReading = null;
      const changed = m.light !== systemTheme.light || m.reason !== systemTheme.reason;
      systemTheme = { light: m.light, reason: m.reason || null };
      if (changed) send('looksync:system-theme', systemTheme);
      return systemTheme;
    }, (err) => {
      modeReading = null;
      systemTheme = { light: null, reason: "Couldn't read Windows apps mode: " + (err && err.message) };
      return systemTheme;
    });
    return modeReading;
  }

  /* ---- the instance --------------------------------------------------- */

  function ensure(enabled) {
    if (sync) return sync;
    sync = LS.create({ app: 'quartz', dir: syncDir(), enabled: enabled !== false, local: () => local });
    sync.on('status', (s) => { lastStatus = s; send('looksync:status', s); });
    sync.on('apply', (e) => send('looksync:apply', e));
    sync.on('desktop', (d) => { lastDesktop = desktopPayload(d); send('looksync:desktop', lastDesktop); });
    sync.start();
    // start() reads synchronously; a file that has no desktop record emits no
    // 'desktop' event, so the renderer is told the fallback here.
    lastDesktop = desktopPayload(sync.desktop());
    return sync;
  }

  function cleanLocal(v) {
    const out = {};
    if (!v || typeof v !== 'object') return out;
    for (const f of LS.FIELDS) if (v[f] !== undefined && !LS.checkValue(f, v[f])) out[f] = v[f];
    return out;
  }

  ipcMain.handle('looksync:hello', async (event, init) => {
    if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
    const enabled = !(init && init.enabled === false);
    local = Object.assign({}, local, cleanLocal(init && init.local));
    const first = !sync;
    ensure(enabled);
    if (!first && sync.enabled !== enabled) await sync.setEnabled(enabled);
    else if (!first) sync.refresh();
    // start() queues its first read on look-sync's promise queue, and that read sends the desktop
    // and status events. Let the queue run (microtasks all drain before setImmediate) so this reply
    // carries what those events said: a reply built before them would land after them and put the
    // window back on "Mantle hasn't shared one yet" (toprow-e2e on a runner, 1 run in 3).
    await new Promise((r) => setImmediate(r));
    lastDesktop = desktopPayload(sync.desktop());
    lastPlace = placeOf(liveWin());
    // Never wait on reg.exe here: on a busy machine at boot it took seconds, the window's 4 s wait
    // for this answer ran out, and the wallpaper fell back with 'the browser did not answer'.
    // The mode goes out on looksync:system-theme when the read lands (readMode sends on change).
    readMode();
    const mode = systemTheme;
    return {
      ok: true, dir: sync.dir, instance: sync.instance, status: sync.status(), desktop: lastDesktop,
      place: lastPlace, shared: sync.shared(), mantle: MANTLE_OPEN, systemTheme: mode
    };
  });

  ipcMain.on('looksync:local', (event, v) => {
    if (!isChromeSender(event)) return;
    local = Object.assign({}, local, cleanLocal(v));
  });

  ipcMain.handle('looksync:publish', async (event, field, value) => {
    if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
    if (!sync) return { ok: false, reason: 'Look Sync has not started in this window yet' };
    if (LS.FIELDS.indexOf(field) < 0) return { ok: false, reason: 'unknown field ' + field };
    local = Object.assign({}, local, cleanLocal({ [field]: value }));
    return sync.publish(field, value);
  });

  ipcMain.handle('looksync:set-enabled', async (event, on) => {
    if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
    if (!sync) return { ok: false, reason: 'Look Sync has not started in this window yet' };
    return sync.setEnabled(on !== false);
  });

  ipcMain.on('looksync:refresh', (event) => {
    if (!isChromeSender(event) || !sync) return;
    sync.refresh();
  });

  ipcMain.handle('looksync:system-theme', (event) => {
    if (!isChromeSender(event)) return { light: null, reason: 'refused' };
    return readMode();
  });

  ipcMain.handle('looksync:open-mantle', (event) => {
    if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
    if (!MANTLE_OPEN.canOpen) return { ok: false, reason: MANTLE_OPEN.reason };
    if (isTest) return { ok: true, test: true };   // test runs never start Mantle
    return openMantleWallpapers();
  });

  ipcMain.handle('looksync:debug', (event) => {
    if (!isChromeSender(event)) return null;
    return { dir: sync ? sync.dir : syncDir(), started: !!sync, status: lastStatus, desktop: lastDesktop, place: lastPlace, systemTheme, test: isTest };
  });

  // Windows' apps mode can change without nativeTheme noticing while the site
  // theme forces themeSource, so it is also re-read on focus (one reg query).
  nativeTheme.on('updated', () => { readMode(); });

  const onResume = () => {
    if (sync) sync.refresh();
    readMode();
    lastPlace = null;
    queuePlace();
  };
  powerMonitor.on('resume', onResume);
  powerMonitor.on('unlock-screen', onResume);

  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) {
    screen.on(ev, () => { lastPlace = null; queuePlace(); });
  }

  /** Called by main.js for the chrome window. */
  function attachWindow(win) {
    for (const ev of ['move', 'moved', 'resize', 'resized', 'maximize', 'unmaximize', 'restore',
      'enter-full-screen', 'leave-full-screen']) {
      win.on(ev, queuePlace);
    }
    win.on('focus', () => {
      if (sync) sync.refresh();
      readMode();
      queuePlace();
    });
    win.webContents.on('did-finish-load', () => { lastPlace = null; queuePlace(); });
  }

  function close() { if (sync) sync.close(); }

  return { attachWindow, close, _sync: () => sync };
}

module.exports = { install };
