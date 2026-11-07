'use strict';

// main.js — Electron entry point.
//
// Owns the single BrowserWindow, bridges the renderer to pty.js over IPC, and
// tears every PTY down on quit. It also owns everything a <webview> guest
// cannot do for itself: downloads, permission prompts, context menus, and the
// keystrokes a focused page would otherwise swallow.

// First, before anything arms a timer: no activateUvLoop() from inside Node's own loop (the idle
// wakeup storms; see uvquiet.js).
require('./uvquiet').install();
// And the main thread (AboveNormal) must not preempt Electron's libuv poll thread, or the two lock
// into waking each other thousands of times a second (focused Home; see uvboost.js): the poll
// thread's priority goes up 15 s in.
require('./uvboost').install();

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http'); // the local Spotify bridge's /now, /control, /config
const { pathToFileURL } = require('url');
const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  dialog,
  shell,
  clipboard,
  Menu,
  nativeTheme,
  webContents,
  globalShortcut,
} = require('electron');
const { createSession, killAll, listPrograms, hasProgram, paneIdFromArgs } = require('./pty');
const claudeToolsModule = require('./mcp-main');
const autopauseModule = require('./autopause');
const statsModule = require('./stats');
const bgFiles = require('./bgfiles');
const fileNav = require('./filenav');
const appsModule = require('./apps');
const stocksModule = require('./stocks');
const braveSearchModule = require('./bravesearch');
const claudeAnswerModule = require('./claudeanswer');
const budgetModule = require('./budget');
const lookSyncMain = require('./looksync-main');
// Look Sync (looksync-main.js): installed once the app is ready (it needs
// screen and powerMonitor), then attached to the chrome window in createWindow.
let lookSync = null;
// Top-row hints for Mantle's top bar (toprow-main.js): the pipe client runs in
// the chrome's preload; main only tells it its HWND and the window events.
const toprowMain = require('./toprow-main');
let toprow = null;
const notesPaneModule = require('./notes-pane-main');
const phoneModule = require('./phone');
const profileMove = require('./profilemove');
// Installed by Quartz-Setup.exe, or run from a folder (install-mode.js says why app.isPackaged
// cannot tell them apart). Every installed-only path below keys off this one value.
const INSTALLED = require('./install-mode').detect(app);
const { urlFromArgv } = require('./argvurl');
// --close-tabs=<prefix> [--keep=<prefix>...]: close tabs by address from a command line.
const closeTabs = require('./closetabs');
const spellModule = require('./spell');
const drmModule = require('./drm-main');
// quartz.log (log.js): start/quit, crashes, hangs, failed loads, adblock, tab
// sleep, memory. Installed in whenReady, once userData is final.
const quartzLog = require('./log');
// Tab sleep's main half: memory figures, the safe-to-sleep probe, audibility.
const tabSleepMain = require('./tabsleep-main');
/** @type {ReturnType<typeof quartzLog.install> | null} */
let qlog = null;
// The window that stops drawing until it is moved (freezewatch.js): nudges after a
// wake, a watch while the page reports hidden, freeze.log. Installed in whenReady.
const freezeWatchMod = require('./freezewatch');
/** @type {ReturnType<typeof freezeWatchMod.install> | null} */
let freezeWatch = null;

/** @type {BrowserWindow | null} */
let win = null;

/*
 * Keep the browser out of the Windows media session (SMTC).
 *
 * The idle music lives in the CHROME, in one <audio> element, and Chromium
 * registers that element with Windows as "now playing" for this app. The Spotify
 * bridge's /now reports whatever Windows calls the current session -- so the
 * music announced ITSELF as the machine playing something, music.js read its own
 * sound as the veto, paused, the session went Paused, the veto cleared, it
 * resumed, and round again every ~4 s. Measured on the live browser: the
 * auto-generated session titled "Browser" flipped Playing 13.7-15.7s,
 * Paused 16.2-17.3s, Playing 17.8-19.8s while Spotify sat Paused throughout.
 *
 * Turning HardwareMediaKeyHandling off removes this process from SMTC entirely,
 * which is the whole fix: nothing the browser plays can be mistaken for another
 * app. The price, deliberately paid: the media keys no longer control browser
 * tabs (they go to Spotify), and the Windows / new-tab now-playing tile shows
 * Spotify and other apps but never a browser tab.
 */
/*
 * --measure-visible (test instances only): a test window sits behind the user's
 * windows (toback.ps1), and Windows occlusion tracking then drops its tiles and
 * throttles it, so memory and frame numbers read far lower than the real thing.
 * This flag keeps a test copy rendering as if it were in front. It has to ride
 * on this same switch: a second disable-features on the command line would be
 * overwritten by the appendSwitch below.
 */
/*
 * MediaFoundationCameraUsageMonitoring: the camera service must be able to go
 * away again.
 *
 * Chromium starts a "video_capture" utility the first time any page asks
 * about cameras -- one navigator.mediaDevices.enumerateDevices() is enough, and
 * Gmail and Gemini both make that call on load without ever opening a camera.
 * The service is built to exit five seconds after its last client leaves. This
 * feature keeps it from ever doing so: it parks a Media Foundation watcher in
 * the service (to learn when OTHER apps grab the camera), and a process that
 * has already loaded Media Foundation and the GPU driver (igc64.dll alone is
 * an 84 MB image) is expensive to keep for nothing. Measured 2026-09-26
 * on a test copy (RAM round): one enumerateDevices() in a Wikipedia tab and
 * the utility sat at 67.7 MB private for as long as we watched (minutes; the
 * live browser had carried its 68 MB since boot). With this off, the same call
 * still lists audioinput/videoinput/audiooutput, the utility comes up, answers
 * and is gone within 5 s; repeat enumerations stay at 0-1 ms because the
 * browser caches the device list (MediaDevicesSystemMonitorCaching, left on).
 *
 * Nothing in this app reads "the camera is busy in another app" -- that watcher
 * is its only job -- so turning it off loses no feature. The price is on the
 * camera path only: a page that opens the camera after the service has exited
 * pays the service launch again (the first open of a run always paid it).
 * Measured with Chromium's fake camera on the CPU-capped test copy: getUserMedia
 * to first frame 122-131 ms with the service warm, 329 ms and 1344 ms cold. A
 * real webcam spends ~0.5-1 s powering up on top of either.
 */
const DISABLED_FEATURES = ['HardwareMediaKeyHandling', 'MediaFoundationCameraUsageMonitoring'];
if (process.argv.includes('--test-profile') && process.argv.includes('--measure-visible')) {
  DISABLED_FEATURES.push('CalculateNativeWinOcclusion');
}
app.commandLine.appendSwitch('disable-features', DISABLED_FEATURES.join(','));

/*
 * The User-Agent every guest sends, with this app and the framework taken out
 * of it.
 *
 * Electron's stock fallback names both:
 *
 *   Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like
 *   Gecko) browser/0.1.0 Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36
 *
 * Almost nothing cares. The exception is a site that gates SIGN-IN on what the
 * browser calls itself, and X (x.com / twitter.com) is one: submitting the
 * login form answers "Could not log you in now", or the form simply stops
 * responding, or a verification step arrives that never completes -- on
 * username+password AND on the social buttons, while every other site in the
 * browser logs in fine. An unknown product token in front of Chrome/ is enough
 * to land in that bucket, and `browser/0.1.0` and `Electron/44.3.0` are two.
 *
 * Both tokens are cut from the REAL value rather than a hand-written UA, so the
 * Chrome version, the platform and the AppleWebKit tail always stay whatever
 * this Electron actually ships -- there is no Chrome number to forget to bump.
 * The app name comes from app.getName(), so renaming the app cannot leave a
 * stale literal behind. Sec-CH-UA has to tell the same story; that half of the
 * fix is installClientHintFix() down by the session handlers.
 */
function chromeOnlyUserAgent() {
  const stock = String(app.userAgentFallback || '');
  const name = String(app.getName() || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = stock
    .replace(name ? new RegExp('\\s' + name + '/\\S+') : /$^/, '')
    .replace(/\sElectron\/\S+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Nothing here may fail quietly: a UA that lost its Chrome/ token, or kept
  // Electron, is a worse browser than the one we started with, so say which
  // and why before falling back to a string we build outright.
  if (stripped.includes(' Chrome/') && !stripped.includes('Electron')) return stripped;
  console.error(
    '[ua] stripped User-Agent is unusable (' +
      (stripped.includes(' Chrome/') ? 'still names Electron' : 'no Chrome/ token left') +
      '); using a built string instead. stock=' + stock
  );
  return (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/' + (process.versions.chrome || '0.0.0.0') + ' Safari/537.36'
  );
}

app.userAgentFallback = chromeOnlyUserAgent();

/** The one Chrome major the UA string and the client hints both have to claim. */
const CHROME_MAJOR = String(
  (app.userAgentFallback.match(/\sChrome\/(\d+)/) || [])[1] ||
    String(process.versions.chrome || '0').split('.')[0]
);

/**
 * Windows 11 22H2 (build 22621) is the first release where DWM exposes the
 * acrylic system backdrop to apps. os.release() looks like '10.0.26200'.
 */
function isWin11_22H2OrLater() {
  if (process.platform !== 'win32') return false;
  const build = Number(String(os.release()).split('.')[2]);
  return Number.isFinite(build) && build >= 22621;
}

/** Reflects the backdrop that actually got applied to the live window. */
let acrylicActive = false;

// Test runs (smoketest.js, verify scripts) pass --test-profile so their cookies,
// storage and theme choice never land in the real profile.
if (process.argv.includes('--test-profile')) {
  // --profile-name=<x> gives a test run its own storage, so several test
  // instances (one per verify agent) never share a LevelDB or a window state.
  const named = process.argv.find((a) => a.startsWith('--profile-name='));
  const suffix = named ? '-' + named.slice('--profile-name='.length).replace(/[^a-z0-9-]/gi, '') : '';
  app.setPath('userData', path.join(app.getPath('temp'), 'browser-test-profile' + suffix));
  // QUARTZ_TEST_CDM=missing: a castlabs test copy with NO Widevine for real. The CDM is a
  // component downloaded into userData on first run; a fresh test profile with the
  // component updater off never gets it, so pages are refused exactly as on stock.
  // QUARTZ_TEST_CDM=ready reports it installed without downloading it (no component update either).
  if (process.env.QUARTZ_TEST_CDM === 'missing' || process.env.QUARTZ_TEST_CDM === 'ready') app.commandLine.appendSwitch('disable-component-update');
}

/*
 * The one-time profile move: %APPDATA%\browser -> %APPDATA%\Quartz.
 *
 * Electron names the profile folder after the app (package.json productName,
 * else name), so the start after the rename to Quartz would open a brand-new,
 * EMPTY %APPDATA%\Quartz and quietly log the user out of everything. This runs
 * first, before the single-instance lock (a lockfile in userData), the adblock
 * engine, the window state or any session touches the folder, and either
 * renames the old folder into place, starts normally, or refuses to start at
 * all -- profilemove.js has the four branches and why each is what it is.
 *
 * It is inert while the app is still called `browser`: old and new are then the
 * same folder and the decision is 'same'. That is what let this land before
 * package.json changed, with a live copy that could be restarted at any moment.
 *
 * Test runs never move anything: --test-profile has already pointed userData at
 * a temp folder above, and a test copy must not go near the real profile.
 *
 * newDir is appData\<name>, built by hand and NOT read from
 * app.getPath('userData'): measured 2026-09-26 on a scratch Electron 44 app,
 * that getter CREATES the folder (absent at the top of main, present right
 * after the call). Asking where the new profile lives would therefore make an
 * empty %APPDATA%\Quartz appear beside the real one, and every start would end
 * in the "both folders exist" refusal. userData is appData\<name> exactly (same
 * measurement), and nothing in this app overrides it outside a test run.
 *
 * A refusal says so in an error box and quits. dialog.showErrorBox is the one
 * dialog Electron allows before 'ready', and on Windows it is a real modal
 * box, not a stderr line (measured the same day: a #32770 window appeared with
 * app.isReady() still false, and the call blocked until it was dismissed).
 */
/** What the profile move did at this start; Settings > About shows it. */
let profileMoveResult = { ok: true, action: 'test', why: 'a test profile is never moved' };
// An installed copy has been called Quartz from its first start, so there is no old `browser`
// profile of its own to move, and %APPDATA%\browser on such a machine may well belong to some
// other app. It opens %APPDATA%\Quartz like a folder copy does, and leaves `browser` alone.
if (INSTALLED && !process.argv.includes('--test-profile')) {
  profileMoveResult = { ok: true, action: 'installed', why: 'an installed copy has always been called Quartz, so there is no old profile folder to move' };
  console.log('[profile] ' + profileMoveResult.why);
} else if (!process.argv.includes('--test-profile')) {
  const appData = app.getPath('appData');
  const oldProfileDir = path.join(appData, 'browser');
  const newProfileDir = path.join(appData, app.getName());
  profileMoveResult = profileMove.runProfileMove(oldProfileDir, newProfileDir);
  if (!profileMoveResult.ok) {
    const box = profileMove.refusalText(profileMoveResult, oldProfileDir, newProfileDir);
    console.error('[profile] refusing to start: ' + profileMoveResult.why + ' (' + profileMoveResult.code + ')');
    dialog.showErrorBox(box.title, box.body);
    // Same exit as a second copy below: quit() only ASKS, and everything after
    // this line would go on to open the (empty) profile.
    app.quit();
    process.exit(1);
  }
  if (profileMoveResult.action === 'moved') {
    // The note is how the move stays visible after this run: About reads it on
    // every start. Failing to write it does not undo a finished move, so it is
    // carried along and About says the note is missing and why.
    profileMoveResult.noteError = profileMove.writeMoveNote(newProfileDir, profileMoveResult);
    console.log(
      '[profile] moved ' + oldProfileDir + ' -> ' + newProfileDir + ' (attempt ' + profileMoveResult.attempts + ')' +
        (profileMoveResult.noteError ? '; the note could not be written: ' + profileMoveResult.noteError : '')
    );
  } else if (profileMoveResult.action !== 'same') {
    console.log('[profile] ' + profileMoveResult.why);
  }
}

/*
 * The Windows identity, set by hand rather than left to Electron.
 *
 * Unset, Electron derives it from the app name ('electron.app.browser' until
 * the rename), so any future change to productName would silently move the
 * app to a new taskbar group and orphan its notifications again. A fixed id
 * does not follow the display name. 'com.owensilva.quartz' matches Mantle's
 * 'com.owensilva.mantle'. relink-shortcut.ps1 stamps the SAME string on the
 * Start Menu shortcut: Windows only shows a toast (the "Claude is waiting"
 * notification) for an unpackaged app whose id is carried by a Start Menu
 * shortcut, and a pin groups with its windows only when the ids match. Change
 * one, change both.
 */
const APP_USER_MODEL_ID = 'com.owensilva.quartz';
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

/*
 * One process owns the profile.
 *
 * Windows starts a WHOLE NEW copy of the browser for every link click once it
 * is the default browser (see register-default-browser.ps1). That copy must not
 * open a second window on the same profile -- it hands its URL to the copy that
 * already has the lock (the 'second-instance' handler below) and goes.
 *
 * The lock is keyed to userData, which the redirect above has already moved for
 * a test run, so a --test-profile instance locks against other instances of the
 * SAME test profile and never against the browser the user is using.
 */
if (!app.requestSingleInstanceLock()) {
  // requestSingleInstanceLock() has already delivered this copy's command line
  // to the first one, so there is nothing left to do. quit() only ASKS, and
  // everything below this line would still register handlers and open a window.
  //
  // A close command (closetabs.js) is the one case with something to say here:
  // whoever ran it hears at once whether it was refused and why, on this copy's
  // own console, before the running window shows the result.
  const closing = closeTabs.requestFromArgv(process.argv);
  if (closing) console.log(closeTabs.handedText(closing));
  app.quit();
  process.exit(0);
}

/*
 * The always-on DevTools (CDP) port, 127.0.0.1:9219 (cdp-main.js has the why,
 * the fallback and the security trade-off). Here, after the lock: a second
 * copy handing its URL to the running window has already exited above, so it
 * never probes or binds anything. Before 'ready': Electron reads the switch
 * when it starts its DevTools server. A command-line port and test runs are
 * left exactly as they were.
 */
let cdp = null;
let cdpPlanError = '';
try {
  cdp = require('./cdp-main').plan({ app });
} catch (err) {
  cdpPlanError = 'the DevTools port was not set up: ' + ((err && err.message) || err);
  console.error('[cdp] ' + cdpPlanError);
}

/*
 * A close command with no browser to close tabs in. Starting Quartz for it would
 * open the very window that command exists to tidy, take the foreground, and
 * leave a whole browser running that nobody asked for; so it says why and goes.
 * The same line with a link on it does start Quartz: the link is the request,
 * and the close then runs over the restored tabs before the link opens.
 */
{
  const closing = closeTabs.requestFromArgv(process.argv);
  if (closing && !closeTabs.commandPlan(closing, urlFromArgv(process.argv)).url) {
    console.log(closing.ok
      ? '[close-tabs] Quartz is not running, so there are no tabs to close; it was not started for a close command.'
      : closeTabs.handedText(closing) + ' (Quartz is not running, and was not started.)');
    app.quit();
    process.exit(0);
  }
}

/** id -> session handle returned by pty.createSession */
const handles = new Map();

/** True only when it is actually safe to push an IPC message at the renderer. */
function canSend() {
  return !!win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed();
}

function send(channel, payload) {
  if (!canSend()) return;
  win.webContents.send(channel, payload);
}

/**
 * Spotify auto-pause, built in: Spotify pauses while a tab plays a video and
 * resumes after. Quartz hosts it alone, or joins another app that already
 * hosts it (Mantle, or the earlier standalone helper) so they never fight; see
 * docs/autopause-protocol.md. The module owns all of it -- main only feeds it
 * guests and pushes its state. A test profile never hosts or joins on the
 * real ports, and never sends Spotify a command itself.
 */
const autoPause = autopauseModule.create({
  app,
  test: process.argv.includes('--test-profile'),
  // withAdDuck() rides along: the bridge's ad-ducking state belongs to the same
  // settings section but is not a field autopause.js's parser keeps.
  onChange: (status) => send('autopause:changed', withAdDuck(status)),
});

/**
 * The new tab page's system stats. Ref-counted per webContents inside the
 * module: it runs nothing at all until the chrome subscribes, and kills its
 * typeperf child five seconds after the last unsubscribe. Main only wires the
 * IPC to it -- everything else, including the child's lifetime, is its own.
 */
const stats = statsModule.create({});

/** webContents ids we have already put a 'destroyed' listener on. */
const statsWatched = new Set();

/**
 * The installed-app index behind the new tab's dock and the palette's
 * "Open <app>" rows. It builds nothing until something asks, caches for a day
 * in userData, and keeps the two things a page must never do for itself --
 * starting a process and taking the foreground -- inside one module with one
 * IPC gate in front of it.
 */
const apps = appsModule.create({ app, shell });

/**
 * Live prices for the new tab page's bottom-right tile. Everything about it is
 * its own -- the store, the Finnhub socket, the REST budget, and the listener
 * it puts on each <webview> guest, because the page is preload-less and asks
 * for its data on a console line the way the process list does. Main hands it
 * three things it cannot have on its own: `app` (for userData), the chrome
 * gate in front of the Settings channels, and which URLs are our own pages.
 *
 * The Finnhub key never comes back out of this module. `stocks.describe()` is
 * a mask and a boolean, and that is what IPC returns. At rest it is encrypted
 * with safeStorage (secret-store.js), as are the Brave and TMDB keys below.
 */
/** quartz.log lines from the key stores (secret-store.js): migrations, unreadable keys. Never a key. */
const keyStoreLog = (line) => { if (qlog) qlog.log.line('[keys] ' + line); else console.log('[keys] ' + line); };
const stocks = stocksModule.create({
  app,
  ipcMain,
  safeStorage: require('electron').safeStorage,
  keyLog: keyStoreLog,
  isChromeSender: (event) => isChromeSender(event),
  isBundledPage: (url) => isBundledPageUrl(url),
});

/**
 * Quartz's own search results page (bravesearch.js + search.html). The Brave
 * Search API key lives in <userData>/brave-search.json and, like the Finnhub
 * key, never comes back out: IPC answers a mask and a boolean. Only a TEST
 * profile may point it somewhere else (a mock server, via QUARTZ_BRAVE_API),
 * so a live Quartz always talks to Brave itself.
 */
const braveSearch = braveSearchModule.create({
  app,
  ipcMain,
  safeStorage: require('electron').safeStorage,
  keyLog: keyStoreLog,
  isChromeSender: (event) => isChromeSender(event),
  isBundledPage: (url) => isBundledPageUrl(url),
  apiBase: process.argv.includes('--test-profile') && process.env.QUARTZ_BRAVE_API
    ? process.env.QUARTZ_BRAVE_API
    : undefined,
});

/**
 * The AI answer at the top of Quartz results (claudeanswer.js), from Claude
 * through the user's own Anthropic API key. It listens to the same search.html
 * guests as braveSearch, on its own console lines. The key lives in
 * <userData>/claude-answer.json ENCRYPTED with safeStorage (DPAPI) and never
 * comes back out over IPC. Only a TEST profile may point it somewhere else (a
 * mock server, via QUARTZ_CLAUDE_API), so a live Quartz always talks to
 * api.anthropic.com itself.
 */
const claudeAnswer = claudeAnswerModule.create({
  app,
  ipcMain,
  safeStorage: require('electron').safeStorage,
  isChromeSender: (event) => isChromeSender(event),
  isBundledPage: (url) => isBundledPageUrl(url),
  apiBase: process.argv.includes('--test-profile') && process.env.QUARTZ_CLAUDE_API
    ? process.env.QUARTZ_CLAUDE_API
    : undefined,
});

/**
 * Autocorrect and spelling (spell.js + spell-preload.js). The engine runs as a
 * session preload in every frame; this hands it the chrome gate for the
 * Settings channels, the push function for live updates, and the same host
 * normaliser the ad-block allowlist uses, so "off on this site" keys match.
 * Function declarations below are hoisted, so passing them here is safe.
 */
const spell = spellModule.create({
  app,
  ipcMain,
  session,
  webContents,
  isChromeSender: (event) => isChromeSender(event),
  send: (channel, payload) => send(channel, payload),
  normaliseHost: (value) => normaliseHost(value),
});

/**
 * The notes pane's reader/helper (notes-pane-main.js), off until
 * <userData>\notes-pane.json names a notes folder. It makes its own Claude Code
 * budget reader (budget.js: no IPC, no UI; the helper asks it before every
 * `claude -p` call and parks itself near the limits) only when that file names
 * a statusline folder. It registers its own IPC; main only hands it the gate,
 * the push function and the budget module.
 */
/**
 * Protected video (drm-main.js + drm-preload.js + drm.js). Stock Electron has
 * no Widevine, so Prime Video, Netflix and the rest cannot play here; this
 * spots those pages and offers the same page in Microsoft Edge. A TEST profile
 * may swap the Edge launch for a file (QUARTZ_EDGE_STUB) and add one local host
 * to the list of streaming sites (QUARTZ_DRM_TEST_SITE), so the e2e never
 * starts Edge and never needs the internet. A live Quartz ignores both.
 */
const DRM_TEST = process.argv.includes('--test-profile');
const drm = drmModule.create({
  app,
  ipcMain,
  session,
  shell: require('electron').shell,
  electron: require('electron'),
  isChromeSender: (event) => isChromeSender(event),
  send: (channel, payload) => send(channel, payload),
  edgeStub: DRM_TEST && process.env.QUARTZ_EDGE_STUB ? process.env.QUARTZ_EDGE_STUB : '',
  extraSites: DRM_TEST && process.env.QUARTZ_DRM_TEST_SITE
    ? [{ id: 'test', name: 'Test Stream', exact: [String(process.env.QUARTZ_DRM_TEST_SITE).toLowerCase()] }]
    : [],
  // TEST ONLY: report the CDM missing or installed (QUARTZ_TEST_CDM=missing|ready) or the streaming
  // signature in a given state (QUARTZ_TEST_VMP=signed|development|unsigned|stale),
  // so the routing e2e can take both roads on one build. A live Quartz ignores both.
  ...drmModule.testOverrides(process.argv, process.env),   // '' and '' without --test-profile
  // Watch labels "Opens in Edge" by this state: re-label when it changes.
  onChange: () => { try { if (watch && typeof watch.drmChanged === 'function') watch.drmChanged(); } catch { /* Watch not built yet */ } },
});

/**
 * The Watch player layer (watch-player-main.js + watch-player.js): a title from
 * Watch plays INSIDE Watch, in a <webview> laid over the Watch tab, instead of a
 * new tab. Created before Watch, which hands it every title it would have opened
 * in a tab. A TEST profile may add sign-in hosts that stay in the layer
 * (QUARTZ_PLAYER_AUTH_HOSTS, comma separated) and move the multiview RAM floor
 * (QUARTZ_PLAYER_FLOOR_GB). A live Quartz ignores both.
 */
// Lumen's leak log (watch-leaks.js): each time Lumen has to send the user to a tab, Edge or an app,
// one quartz.log line and a count Settings > Lumen shows. Shared by the player layer and Watch.
const watchLeaks = (() => {
  try { return require('./watch-leaks').create({ app, log: (line) => { if (qlog) qlog.log.line(line); else console.log('[lumen] ' + line); } }); } catch (err) {
    console.error('[lumen] the leak log could not start: ' + String((err && err.message) || err).slice(0, 200));
    return null;
  }
})();
const watchPlayer = (() => {
  const t = process.argv.includes('--test-profile');
  const env = process.env;
  const test = {};
  if (t && env.QUARTZ_PLAYER_AUTH_HOSTS) test.authHosts = String(env.QUARTZ_PLAYER_AUTH_HOSTS).split(',').map((s) => s.trim()).filter(Boolean);
  if (t && env.QUARTZ_PLAYER_FLOOR_GB !== undefined && Number.isFinite(Number(env.QUARTZ_PLAYER_FLOOR_GB))) test.floorGb = Number(env.QUARTZ_PLAYER_FLOOR_GB);
  // Multiview's RAM guard, simulated: while this file exists its number is the free RAM (TEST profile only).
  if (t && env.QUARTZ_PLAYER_FREE_FILE) test.freeFile = String(env.QUARTZ_PLAYER_FREE_FILE);
  if (t) test.capture = true;   // the e2e's whole-window shot (sheets are native views)
  try {
    const p = require('./watch-player-main').create({
      app,
      ipcMain,
      webContents,
      WebContentsView: require('electron').WebContentsView,
      send: (channel, payload) => send(channel, payload),
      getWindow: () => win,
      isChromeSender: (event) => isChromeSender(event),
      windowOpenDecision: (details) => windowOpenDecision(details),
      log: (line) => { if (qlog) qlog.log.line(line); else console.log('[watch-player] ' + line); },
      leaks: watchLeaks,
      test,
    });
    p.registerIpc();
    return p;
  } catch (err) {
    console.error('[watch-player] the player layer could not start: ' + String((err && err.message) || err).slice(0, 200));
    return null;
  }
})();
// Lumen's playback view (watch-playview-main.js + watch-playview.js): its setting, and a TEST-only window seam.
const watchPlayview = (() => {
  try {
    const p = require('./watch-playview-main').create({
      app, ipcMain, getWindow: () => win, isChromeSender: (event) => isChromeSender(event),
      log: (line) => { if (qlog) qlog.log.line('[lumen view] ' + line); else console.log('[lumen view] ' + line); },
      test: process.argv.includes('--test-profile'),
    });
    p.registerIpc();
    return p;
  } catch (err) {
    console.error('[lumen view] could not start: ' + String((err && err.message) || err).slice(0, 200));
    return null;
  }
})();
void watchPlayview;
// Lumen's ambient field (watch-ambient-main.js + watch-ambient.js): may it refresh (battery saver)?
try { require('./watch-ambient-main').create({ ipcMain, isChromeSender: (event) => isChromeSender(event) }).registerIpc(); } catch (err) {
  console.error('[lumen ambient] could not start: ' + String((err && err.message) || err).slice(0, 200));
}
// Lumen's Shorts view (watch-shorts-main.js + watch-shorts.js): its quartz.log lines.
const watchShorts = (() => {
  try {
    const m = require('./watch-shorts-main').create({
      ipcMain, isChromeSender: (event) => isChromeSender(event),
      log: (line) => { if (qlog) qlog.log.line('[lumen shorts] ' + line); else console.log('[lumen shorts] ' + line); },
    });
    m.registerIpc();
    return m;
  } catch (err) {
    console.error('[lumen shorts] could not start: ' + String((err && err.message) || err).slice(0, 200));
    return null;
  }
})();
void watchShorts;

/**
 * Watch, the streaming hub (watch-main.js + watch.html). It reads the user's own
 * rows from the services they are signed in to here, in one hidden reader at a
 * time on the default session, and opens a title on the service's own page:
 * a Quartz tab, or Edge through drm.openInEdge for the services whose players
 * need Widevine. A TEST profile may point every service at a local mock
 * (QUARTZ_WATCH_REBASE, JSON [[from, to], ...]), record opens to a file
 * (QUARTZ_WATCH_OPEN_STUB), lower the free-memory floor
 * (QUARTZ_WATCH_MIN_FREE_GB) and fake a running game (QUARTZ_WATCH_GAME_FILE:
 * present = a game is running) and change the first read's boot grace
 * (QUARTZ_WATCH_BOOT_GRACE_MS). A live Quartz ignores all five.
 * A TEST profile's hover preview is OFF: no test ever loads a real YouTube
 * embed or asks TMDB for a trailer. QUARTZ_WATCH_PREVIEW_MOCK=1 turns it on
 * against the e2e's mock instead (watch/preview.js MOCK_ORIGIN, a .invalid
 * host only CDP interception answers; trailers only through a rebased TMDB).
 */
const watch = (() => {
  const t = process.argv.includes('--test-profile');
  const env = process.env;
  const test = {};
  if (t) {
    test.preview = env.QUARTZ_WATCH_PREVIEW_MOCK === '1' ? 'mock' : 'off';
    try { if (env.QUARTZ_WATCH_REBASE) test.rebase = JSON.parse(env.QUARTZ_WATCH_REBASE); } catch { /* no rebase */ }
    if (env.QUARTZ_WATCH_OPEN_STUB) test.openStub = env.QUARTZ_WATCH_OPEN_STUB;
    if (env.QUARTZ_WATCH_MIN_FREE_GB !== undefined && Number.isFinite(Number(env.QUARTZ_WATCH_MIN_FREE_GB))) test.minFreeGb = Number(env.QUARTZ_WATCH_MIN_FREE_GB);
    if (env.QUARTZ_WATCH_GAME_FILE) {
      const flag = env.QUARTZ_WATCH_GAME_FILE;
      test.gameRunning = () => (fs.existsSync(flag) ? 'valorant' : '');
    }
    // The background refresh's gates and cadence, for watch-e2e (a TEST profile only).
    if (env.QUARTZ_WATCH_SAVER_FILE) { const sf = env.QUARTZ_WATCH_SAVER_FILE; test.saverOn = () => fs.existsSync(sf); }
    for (const [k, name] of [['bgMinFreeGb', 'QUARTZ_WATCH_BG_MIN_FREE_GB'], ['bgEveryMs', 'QUARTZ_WATCH_BG_EVERY_MS'], ['bgGapMs', 'QUARTZ_WATCH_BG_GAP_MS'], ['bgBootDelayMs', 'QUARTZ_WATCH_BG_BOOT_MS'], ['bgPauseMs', 'QUARTZ_WATCH_BG_PAUSE_MS'], ['bgTimerMinMs', 'QUARTZ_WATCH_BG_TIMER_MIN_MS'], ['watchedAwayMs', 'QUARTZ_WATCH_WATCHED_AWAY_MS'], ['readLimitMs', 'QUARTZ_WATCH_READ_LIMIT_MS'], ['tpvMinFreeGb', 'QUARTZ_WATCH_TPV_MIN_FREE_GB']]) {
      if (env[name] !== undefined && Number.isFinite(Number(env[name]))) test[k] = Number(env[name]);
    }
  }
  // The first reader waits this long after start, so a restored Watch tab never adds a hidden
  // page load to Quartz's own boot. A TEST profile may change it (QUARTZ_WATCH_BOOT_GRACE_MS).
  let bootGraceMs = 10000;
  if (t && env.QUARTZ_WATCH_BOOT_GRACE_MS !== undefined && Number.isFinite(Number(env.QUARTZ_WATCH_BOOT_GRACE_MS))) {
    bootGraceMs = Math.max(0, Number(env.QUARTZ_WATCH_BOOT_GRACE_MS));
  }
  // Watch must never stop Quartz from starting: if its code fails to load (watch-main.js,
  // watch/shape.js, watch/merge.js ...) Quartz runs without it. The Watch page then says
  // Quartz did not answer (its boot timeout), and Settings > Watch shows this reason.
  try {
    return require('./watch-main').create({
      app,
      ipcMain,
      safeStorage: require('electron').safeStorage,   // the TMDB key at rest (secret-store.js)
      session,
      BrowserWindow,
      isChromeSender: (event) => isChromeSender(event),
      isBundledPage: (url) => isBundledPageUrl(url),
      send: (channel, payload) => send(channel, payload),
      openInEdge: (url) => drm.openInEdge(url),
      // A protected title opens HERE when Widevine is in and Quartz is signed for
      // streaming, and in Edge (with the reason) when not, or when the person chose Edge.
      drmRoute: (url) => drm.route(url),
      // The player layer: titles play inside Watch when "Play inside Watch" is on.
      player: watchPlayer,
      leaks: watchLeaks,
      getWindow: () => win,
      log: (line) => { if (qlog) qlog.log.line(line); else console.log('[watch] ' + line); },
      bootGraceMs,
      test,
    });
  } catch (err) {
    const why = String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 200);
    console.error('[watch] Lumen could not start: ' + why);
    setImmediate(() => { try { if (qlog) qlog.log.line('Lumen could not start: ' + why); } catch { /* log not ready */ } });
    for (const ch of ['watch:describe', 'watch:set-enabled', 'watch:set-leagues', 'watch:set-tmdb-key', 'watch:forget', 'watch:test-tmdb', 'watch:refresh', 'watch:set-background', 'watch:set-tile-preview']) {
      try { ipcMain.handle(ch, () => { throw new Error('Lumen could not start: ' + why); }); } catch { /* already registered */ }
    }
    return { failed: why, stop() {}, windowShown() {}, windowFocused() {}, isReaderContents() { return false; } };
  }
})();

/*
 * Lumen's pinned scores (score-pins-main.js): small always-on-top cards on the desktop, one
 * per pinned game, fed by public score JSON (ESPN; the NHL's own feed for hockey). Nothing
 * runs with nothing pinned. A TEST profile's cards are always off-screen and silent, and it
 * may point the feeds at a local mock (QUARTZ_SCORES_REBASE, JSON [[from, to], ...]), record
 * card opens to a file (QUARTZ_SCORES_OPEN_STUB) and scale the poll cadence
 * (QUARTZ_SCORES_POLL_SCALE). A live Quartz ignores all three.
 */
const scorePins = (() => {
  const test = {};
  if (process.argv.includes('--test-profile')) {
    const env = process.env;
    test.offscreen = true;
    test.silent = true;
    try { if (env.QUARTZ_SCORES_REBASE) test.rebase = JSON.parse(env.QUARTZ_SCORES_REBASE); } catch { /* no rebase */ }
    if (env.QUARTZ_SCORES_OPEN_STUB) test.openStub = env.QUARTZ_SCORES_OPEN_STUB;
    if (Number(env.QUARTZ_SCORES_POLL_SCALE) > 0) test.pollScale = Number(env.QUARTZ_SCORES_POLL_SCALE);
  }
  // Like Watch, it must never stop Quartz from starting.
  try {
    const electron = require('electron');
    return require('./score-pins-main').create({
      app, ipcMain, BrowserWindow, test,
      screen: { getPrimaryDisplay: () => electron.screen.getPrimaryDisplay(), getAllDisplays: () => electron.screen.getAllDisplays() },
      powerMonitor: { on: (e, fn) => electron.powerMonitor.on(e, fn), removeListener: (e, fn) => electron.powerMonitor.removeListener(e, fn) },
      isChromeSender: (event) => isChromeSender(event),
      send: (channel, payload) => send(channel, payload),
      getWindow: () => win,
      // The palette's rows: Lumen's cached ESPN games (no fetch).
      getGames: () => { const sn = watch && typeof watch.snapshot === 'function' ? watch.snapshot() : null; const sp = sn && sn.sports; return sp ? [].concat(sp.live || [], sp.soon || [], sp.done || []) : []; },
      // A card's click: that game's page inside Lumen (sports-main.js), not the gamecast in a tab.
      openInLumen: (url) => (lumenSports ? lumenSports.openGame(url) : null),
      log: (line) => { if (qlog) qlog.log.line(line); else console.log('[scores] ' + line); },
    });
  } catch (err) {
    console.error('[scores] Score pins could not start: ' + String((err && err.message) || err).slice(0, 200));
    return null;
  }
})();
/*
 * Lumen's sports pages (sports-main.js + watch/sportspage.js): the game page, favourite teams
 * (My teams), team pages and standings, from ESPN's public JSON, read only while a page asks.
 * A TEST profile may point ESPN and the NHL feed at a local mock (QUARTZ_SPORTS_REBASE, JSON
 * [[from, to], ...]); a live Quartz ignores it.
 */
const lumenSports = (() => {
  const test = {};
  if (process.argv.includes('--test-profile')) {
    try { if (process.env.QUARTZ_SPORTS_REBASE) test.rebase = JSON.parse(process.env.QUARTZ_SPORTS_REBASE); } catch { /* no rebase */ }
  }
  try {
    return require('./sports-main').create({
      app, test,
      // Lumen is opt-in: these pages read ESPN only while ESPN is on in Settings > Lumen.
      espnOn: () => !!(watch && typeof watch.isEnabled === 'function' && watch.isEnabled('espn')),
      getGames: () => { const sn = watch && typeof watch.snapshot === 'function' ? watch.snapshot() : null; const sp = sn && sn.sports; return sp ? [].concat(sp.live || [], sp.soon || [], sp.done || []) : []; },
      // a score pin's click: the chrome brings the Lumen tab forward (scorepins-chrome.js), Quartz comes to the front
      showLumen: () => {
        send('scores:changed', { pinned: null, lumenShow: true });
        const w = win;
        if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
      },
      log: (line) => { if (qlog) qlog.log.line(line); else console.log('[sports] ' + line); },
    });
  } catch (err) {
    console.error('[sports] Lumen sports could not start: ' + String((err && err.message) || err).slice(0, 200));
    return null;
  }
})();
/*
 * Lumen Alerts (watch-alerts-main.js): "New from your subscriptions" and favourite-team game
 * start / final, from reads Lumen already makes (no timer, no read of its own). The chrome shows
 * them (watch-alerts-chrome.js). A TEST profile is silent: no real notification, only counts.
 */
const lumenAlerts = (() => {
  const test = {};
  if (process.argv.includes('--test-profile')) { test.offscreen = true; test.silent = true; }
  try {
    if (!watch || watch.failed || typeof watch.setAlerts !== 'function') throw new Error('Lumen did not start');
    const a = require('./watch-alerts-main').create({
      app, ipcMain, test,
      isChromeSender: (event) => isChromeSender(event),
      send: (channel, payload) => { if (!canSend()) return false; win.webContents.send(channel, payload); return true; },
      getWindow: () => win,
      getFavs: () => (lumenSports ? lumenSports.favourites() : []),
      lumenView: () => watch.alertsView(),
      gaming: () => watch.gaming(),
      openTitle: (url, o) => watch.openTitle(url, o),
      openGame: (url) => (lumenSports ? lumenSports.openGame(url) : { ok: false, reason: 'Lumen sports is not running' }),
      pin: (ev) => (scorePins ? scorePins.pin(ev) : { ok: false, reason: 'score pins are not running' }),
      log: (line) => { if (qlog) qlog.log.line(line); else console.log('[alerts] ' + line); },
    });
    watch.setAlerts(a);
    return a;
  } catch (err) {
    const why = String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 200);
    console.error('[alerts] Lumen Alerts could not start: ' + why);
    for (const ch of ['lumen-alerts:describe', 'lumen-alerts:set', 'lumen-alerts:act']) {
      try { ipcMain.handle(ch, () => { throw new Error('Lumen Alerts could not start: ' + why); }); } catch { /* already registered */ }
    }
    return null;
  }
})();
// Fresh after watching: the layer closing re-reads what was playing; the setting relabels the tiles.
if (watchPlayer && watch && typeof watch.afterWatching === 'function') {
  watchPlayer.setAfterWatching((id) => watch.afterWatching(id));
  watchPlayer.setOnInside(() => { try { watch.drmChanged(); } catch { /* Watch gone */ } });
  // Up next (watch-player-extras.js): what follows a title that ended, from Lumen's own rows.
  if (typeof watchPlayer.setUpNext === 'function' && typeof watch.upNext === 'function') watchPlayer.setUpNext((o) => watch.upNext(o));
  // A where-to-watch (TMDB) link to a service: routed like any title Lumen opens.
  if (typeof watchPlayer.setHandoff === 'function' && typeof watch.openTitle === 'function') watchPlayer.setHandoff((url, o) => watch.openTitle(url, o));
}

// The first-run welcome's flag and its default-browser step (firstrun-main.js).
// Created here, before any window: it reads what the profile held before this run.
require('./firstrun-main').create({ app, ipcMain, shell: require('electron').shell, isChromeSender: (event) => isChromeSender(event), appDir: __dirname, installed: INSTALLED });
const notesPane = notesPaneModule.create({
  app,
  ipcMain,
  isChromeSender: (event) => isChromeSender(event),
  send: (channel, payload) => send(channel, payload),
  budgetModule,
});

/**
 * The Phone workspace: adb + the scrcpy server on the user's Android, relayed to
 * the bundled phone.html guest over a localhost WebSocket. Owns its tools,
 * its device state and its stream; registers its own IPC; the contract is
 * the header of phone.js.
 */
const phone = phoneModule.create({
  app,
  ipcMain,
  isChromeSender: (event) => isChromeSender(event),
  isBundledPage: (url) => isBundledPageUrl(url),
  send: (channel, payload) => send(channel, payload),
});

/**
 * Native app tabs: a real program's own top-level window, re-parented INTO this
 * window and positioned over a tab's content area, so the app runs as itself
 * inside a tab. The module owns all of the Win32 (koffi -> user32) and, more
 * importantly, owns putting every window back: a child HWND is destroyed with
 * its parent, so a quit that skipped detachAll() would take the user's app down
 * with the browser. It registers its own before-quit/exit hooks AND is called
 * from the ones below, because that is not a thing to get wrong once.
 *
 * `win` is passed as a getter: the window does not exist yet at this point.
 *
 * REQUIRED AND BUILT INSIDE A try/catch, with a stub for the failure: this is
 * the only part of the browser that depends on a native binary (koffi), and
 * The developer starts the browser from this folder while it is being worked on. A
 * missing, half-installed or wrong-ABI koffi must cost them `api.embed`, not a
 * window. (embed.js loads koffi lazily on first use for the same reason, so
 * this catch is the second line of defence, not the first.)
 */
const embed = (() => {
  const dead = {
    available: false,
    findWindows: () => [],
    warmProcessTree: () => Promise.resolve(null),
    hasNewProcess: () => false,
    attach: () => ({ ok: false, reason: 'unavailable' }),
    layout: () => ({ ok: false, reason: 'unavailable' }),
    relayout: () => ({ ok: false, reason: 'unavailable', moved: 0, considered: 0 }),
    raiseHosted: () => ({ ok: false, reason: 'unavailable', raised: 0 }),
    detach: () => ({ ok: false, reason: 'unavailable' }),
    close: () => ({ ok: false, reason: 'unavailable' }),
    detachAll: () => ({ ok: true, detached: 0 }),
    handleWindowClose: () => ({ ok: true, detached: 0 }),
    recoverOrphans: () => ({ ok: false, reason: 'unavailable', fixed: 0, checked: 0 }),
    alive: () => false,
    focusInfo: () => ({
      available: false, foregroundRoot: '0', ours: false, viaOwner: false,
      focusHwnd: '0', focusClass: '', ownProcess: false, hostedTabId: null,
      hostedVisible: false,
    }),
    focusChrome: () => false,
    list: () => [],
    stats: () => ({ ffi: null, available: false, attached: 0 }),
    on: () => {},
    off: () => {},
    once: () => {},
  };
  try {
    return require('./embed').create({
      win: () => liveWin(),
      log: (...parts) => {
        if (process.argv.includes('--embed-log')) console.warn('[embed]', ...parts);
      },
    });
  } catch (err) {
    console.warn('[embed] unavailable:', (err && err.message) || err);
    return dead;
  }
})();

// The tab's app closed itself (its X, its own menu, a crash). The chrome owns
// what a tab does about that, so it just hears the tabId.
embed.on('gone', (tabId) => {
  send('embed:gone', { tabId: String(tabId) });
  // One app fewer: the focus poll stops when that was the last one, and the
  // shortcuts go back to the OS immediately if they were ours.
  syncNativeFocusPoll();
});

/*
 * The hung-app watchdog (see embed.js). In owner mode -- the default -- a hosted
 * app that stops pumping messages costs the browser NOTHING: the two input
 * queues were never joined, so this really is only a label on the tab (measured
 * during a 12 s wedge: embed:list answered in 1 ms, Ctrl+T opened a tab in
 * 27 ms). In child mode the same hang freezes THIS window's input too. Either
 * way the engine does NOT move the window: in child mode the detach cannot land
 * until the app answers again anyway (measured), and doing it then would pop a
 * healthy app out of its tab. So this is a report, the window stays hosted, and
 * nothing about the focus poll changes.
 */
embed.on('hung', (payload) => {
  send('embed:hung', {
    tabId: String((payload && payload.tabId) == null ? '' : payload.tabId),
    hwnd: String((payload && payload.hwnd) == null ? '' : payload.hwnd),
    pid: Number((payload && payload.pid) || 0),
  });
});

/** It answers again, in the tab it never left. */
embed.on('recovered', (payload) => {
  send('embed:recovered', {
    tabId: String((payload && payload.tabId) == null ? '' : payload.tabId),
    hwnd: String((payload && payload.hwnd) == null ? '' : payload.hwnd),
  });
});

/** The hosted app renamed its own window ("(3) Discord", a file it opened). */
embed.on('title', (payload) => {
  send('embed:title', {
    tabId: String((payload && payload.tabId) == null ? '' : payload.tabId),
    title: String((payload && payload.title) == null ? '' : payload.title),
  });
});

/**
 * The browser moved, so an owner-mode app window has to move with it (see the
 * window-event block in createWindow and embed.js's applyLayout).
 *
 * Coalesced to one relayout per frame: 'move' and 'resize' fire on every mouse
 * message of a drag, and while the relayout itself is cheap, doing it once per
 * frame is what keeps the app glued to the window rather than trailing it.
 * setImmediate, not a timer: it runs at the end of the current turn, so a burst
 * of ten move events costs one re-apply.
 */
let embedRelayoutQueued = false;
let embedRelayoutWhy = '';

function queueEmbedRelayout(reason) {
  if (reason) embedRelayoutWhy = String(reason);
  if (embedRelayoutQueued) return false;
  embedRelayoutQueued = true;
  setImmediate(() => {
    embedRelayoutQueued = false;
    const why = embedRelayoutWhy;
    embedRelayoutWhy = '';
    try { embed.relayout(why); } catch { /* the 1 s poll is the backstop */ }
  });
  return true;
}

// ---------------------------------------------------------------------------
// Window state
//
// Remember where the window was between launches -- position, size, and whether
// it was maximized. Everything here is best-effort: a missing, corrupt or
// off-screen state file just means the window opens at the defaults, and a
// failed write is never allowed to escape an event handler.
// ---------------------------------------------------------------------------

/**
 * Resolved lazily, not once at module load: --test-profile rewrites userData,
 * so a test run keeps its remembered geometry out of the real profile.
 */
function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

/** Must match baseOptions.minWidth / minHeight in createWindow(). */
const MIN_WIDTH = 720;
const MIN_HEIGHT = 480;

/** How much of the saved rect has to land on a display for it to be usable. */
const MIN_VISIBLE = 100;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * True when the saved rectangle still overlaps some connected display's work
 * area by at least MIN_VISIBLE px on each axis. Monitors get unplugged and
 * layouts get rearranged; a window remembered at x:3000 must not reopen
 * somewhere the user cannot reach it.
 */
function intersectsAnyDisplay(rect) {
  let displays;
  try {
    // Required here rather than at the top: the screen module is only usable
    // once the app is ready.
    displays = require('electron').screen.getAllDisplays();
  } catch {
    return false;
  }
  if (!Array.isArray(displays)) return false;

  return displays.some((display) => {
    const area = display && display.workArea;
    if (!area) return false;
    const overlapX =
      Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
    const overlapY =
      Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE;
  });
}

/**
 * Read window-state.json, keeping only the parts that are still trustworthy.
 * Returns null when there is nothing usable at all; otherwise an object that
 * always carries `maximized` and carries x/y/width/height only when they pass.
 */
function readWindowState() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
  } catch {
    return null; // no file yet, unreadable, or not JSON -- defaults are fine
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const maximized = parsed.maximized === true;
  const { x, y, width, height } = parsed;

  // A size that is not two finite numbers, or that is below the window's own
  // minimums, is discarded outright -- and with it the position it went with.
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return { maximized };
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return { maximized };

  // Size is good but the position isn't: let Electron centre the window.
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return { width, height, maximized };

  const rect = { x, y, width, height };
  if (!intersectsAnyDisplay(rect)) return { maximized };

  return { ...rect, maximized };
}

/** Single shared debounce timer for the 'resize' / 'move' storms. */
let saveTimer = null;

/**
 * Write the current geometry out. While maximized we record maximized:true but
 * store getNormalBounds(), so un-maximizing after the next launch restores the
 * size the window actually had before it was maximized.
 */
function saveWindowState(w) {
  try {
    if (!w || w.isDestroyed()) return;
    // Minimized bounds describe the taskbar, not the window -- skip them.
    if (w.isMinimized()) return;

    const maximized = w.isMaximized();
    const bounds = maximized ? w.getNormalBounds() : w.getBounds();
    if (!bounds) return;

    const state = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized,
    };
    fs.writeFileSync(windowStatePath(), JSON.stringify(state, null, 2));
  } catch {
    // A disk error must never take down a window event handler.
  }
}

/*
 * MEASURED, NOT FIXED: the pale band down the edges of the MAXIMIZED window.
 *
 * titleBarStyle:'hidden' keeps the native frame (DWM needs it to paint the
 * acrylic) and reclaims only the caption, so the resize border on the other
 * three sides stays non-client. Windows overhangs a maximized window by the
 * border thickness to push that border off screen, but the overhang is not
 * scaled the way the border is: at 1920x1080 @125% the window rect is
 * (-9,-9)-(1929,1089), the DWM frame is exactly the display, and the CONTENT
 * area covers only x 2..1917, y 0..1076 -- so 2px left, 2px right and 3px
 * bottom of bare acrylic backdrop stay visible as a pale edge. (A WinUI3
 * window maximized on the same display puts its content at 0,0 1920x1080, so
 * this is ours, not Windows being unable to do it.)
 *
 * The band is outside the renderer's document, so no stylesheet reaches it --
 * body.maximized already zeroes the margin and the radius. Growing the window
 * rect by the shortfall on 'maximize' was tried here and reverted:
 * BrowserWindow.setBounds() RESTORES a maximized window before applying the
 * rect, so the nudge silently un-maximized the window instead. The two
 * remaining options both cost more than 2px does -- frame:false (which makes
 * backgroundMaterial render solid black, per the note in createWindow) or a
 * hand-rolled maximize that gives up Windows' own snap and restore semantics.
 */

/** Coalesce the burst of events a drag or resize produces into one write. */
function queueWindowStateSave(w) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveWindowState(w);
  }, 300);
}

/** Test-only off-screen window (see createWindow). Never set without --test-profile. */
const OFFSCREEN_TEST = process.argv.includes('--test-profile') && process.argv.includes('--offscreen');
const OFFSCREEN_XY = -20000;

function createWindow() {
  const baseOptions = {
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    // Same icon the Start Menu / taskbar shortcut uses, so the running window
    // and the pinned entry read as one app.
    icon: path.join(__dirname, 'assets', 'browser.ico'),
    // Nothing is painted until 'ready-to-show': no white flash, and the
    // backdrop material is attached before the first frame.
    show: false,
    // 'hidden' hides the caption but KEEPS the native non-client frame, which
    // DWM needs to draw a system backdrop. frame:false would make
    // backgroundMaterial render solid black. The renderer draws its own
    // window controls, so no titleBarOverlay either.
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // <webview> is how we host the browsing pane
      sandbox: false,
    },
  };

  // Window state: overlay whatever the last session left behind. Anything that
  // did not survive validation simply stays at the defaults above.
  const savedState = readWindowState();
  if (savedState) {
    if (isFiniteNumber(savedState.width) && isFiniteNumber(savedState.height)) {
      baseOptions.width = savedState.width;
      baseOptions.height = savedState.height;
    }
    if (isFiniteNumber(savedState.x) && isFiniteNumber(savedState.y)) {
      baseOptions.x = savedState.x;
      baseOptions.y = savedState.y;
    }
  }

  // TEST RUNS ONLY (--test-profile --offscreen): the window is CREATED far off
  // every monitor and never gets a taskbar button, so a test instance is never
  // on the user's screen, not even for the first frame. Moving it there after it
  // appears (the old toback/placeloop way) left it visible at the default
  // place for about a second per launch. A remembered place or maximize is
  // ignored: either would bring it back on screen. Pair with --measure-visible
  // so Windows' occlusion tracking does not throttle a window nobody can see.
  if (OFFSCREEN_TEST) {
    baseOptions.x = OFFSCREEN_XY;
    baseOptions.y = OFFSCREEN_XY;
    baseOptions.skipTaskbar = true;
    // TEST ONLY (QUARTZ_TEST_WINDOW_SIZE=1536x800, watch-multiview-e2e.js): the window's real size, so
    // the pages inside <webview>s are that size too (an emulated size never reaches a guest).
    const sz = /^(\d{3,4})x(\d{3,4})$/.exec(String(process.env.QUARTZ_TEST_WINDOW_SIZE || ''));
    if (sz) { baseOptions.width = Number(sz[1]); baseOptions.height = Number(sz[2]); }
    // TEST ONLY (QUARTZ_TEST_NO_WINDOW_FULLSCREEN=1, watch-player-e2e.js): a <webview>'s html
    // fullscreen is synced to its EMBEDDER (this window's webContents), whose own preference
    // decides whether the OS window goes fullscreen -- onto a real monitor. Off here, both ways.
    if (process.env.QUARTZ_TEST_NO_WINDOW_FULLSCREEN === '1') {
      baseOptions.fullscreenable = false;
      baseOptions.webPreferences = { ...baseOptions.webPreferences, disableHtmlFullscreenWindowResize: true };
    }
  }

  // --no-acrylic gives a flat window; used to measure what the material costs.
  let acrylic = isWin11_22H2OrLater() && !process.argv.includes('--no-acrylic');

  // A transparent backgroundColor is what lets the acrylic show through; the
  // opaque fallback is for everything older than Win11 22H2.
  const build = () =>
    new BrowserWindow(
      acrylic
        ? { ...baseOptions, backgroundMaterial: 'acrylic', backgroundColor: '#00000000' }
        : { ...baseOptions, backgroundColor: '#05060a' }
    );

  try {
    win = build();
  } catch (err) {
    if (!acrylic) throw err;
    // The material was refused for some reason -- fall back to the flat window
    // rather than failing to open one at all.
    acrylic = false;
    win = build();
  }

  acrylicActive = acrylic;
  if (lookSync) lookSync.attachWindow(win);
  if (toprow) toprow.attachWindow(win, { chrome: true });

  // Electron 44 still lets a guest <webview> request its own preload / node
  // integration. Strip both so a page we navigate to can never elevate itself.
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL; // legacy key, still honoured by some builds
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    // Every other switch a <webview> attribute can flip. buildWebview() sets
    // none of them, so pinning them here costs nothing and closes the whole
    // attribute channel rather than the two entries it used to cover:
    //   disablewebsecurity  -> webSecurity        (same-origin policy off)
    //   plugins             -> plugins
    //   enableblinkfeatures -> experimentalFeatures
    //   webpreferences="…"  -> any of the above, spelled as a string
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.experimentalFeatures = false;
    webPreferences.plugins = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    // A guest must not host a <webview> of its own: this hook belongs to the
    // chrome's webContents, so a NESTED attach would never reach it.
    webPreferences.webviewTag = false;
    // TEST ONLY (QUARTZ_TEST_NO_WINDOW_FULLSCREEN=1, watch-player-e2e.js): a video's own
    // fullscreen stays inside the off-screen test window instead of moving it onto a monitor.
    if (process.argv.includes('--test-profile') && process.env.QUARTZ_TEST_NO_WINDOW_FULLSCREEN === '1') {
      webPreferences.disableHtmlFullscreenWindowResize = true;
    }
    if (params) {
      params.nodeintegration = 'false';
      // allowpopups is FORCED ON, not stripped. It is the only switch that
      // makes Chromium ask permission before opening a window instead of
      // silently dropping the request -- and "ask" means our own
      // setWindowOpenHandler below, which denies the window and opens a TAB.
      // With it off, window.open() returns null and target="_blank" does
      // nothing at all: no handler anywhere ever hears about it. (The old
      // <webview> 'new-window' DOM event that app.js used to listen for was
      // removed from Electron in v22; it never fires here.)
      params.allowpopups = true;
      delete params.disablewebsecurity;
      delete params.plugins;
      delete params.enableblinkfeatures;
      delete params.webpreferences;
    }
  });

  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return;
    // Maximize BEFORE showing, or the window flashes at the restored size for
    // a frame and then snaps out to full screen.
    if (savedState && savedState.maximized && !OFFSCREEN_TEST) win.maximize();
    // TEST RUNS ONLY (--test-profile --show-inactive): appear without taking
    // the foreground from whoever is at the machine.
    if (process.argv.includes('--test-profile') && process.argv.includes('--show-inactive')) win.showInactive();
    else win.show();
  });

  // The renderer owns the maximize/restore glyph, so it has to hear about
  // state changes it did not initiate (double-click, Win+Up, snap).
  win.on('maximize', () => send('win:maximized', { maximized: true }));
  win.on('unmaximize', () => send('win:maximized', { maximized: false }));

  /*
   * OWNER MODE'S LAYOUT, the only part of native app tabs that is not the
   * chrome's job (see embed.js attach()). An owner-mode app window is still a
   * TOP-LEVEL window positioned in SCREEN pixels, so every one of these moves
   * the browser without moving anything inside the page: the chrome has nothing
   * new to measure and would send no layout at all, yet the app has to follow.
   *
   * embed.relayout() re-applies the rect the chrome last asked for against the
   * new client origin. It is coalesced to one call per frame here because 'move'
   * and 'resize' fire continuously through a drag, and it does no Win32 work at
   * all when the origin has not really moved.
   *
   * 'minimize'/'restore' are in the list because an owned window is hidden with
   * its owner by Windows but shown again only by us; 'focus' also re-raises the
   * app over our client area (see raiseHosted) for the case where another app's
   * window was left on top of it.
   */
  for (const ev of ['move', 'moved', 'resize', 'resized', 'maximize', 'unmaximize',
    'minimize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
    win.on(ev, () => queueEmbedRelayout(ev));
  }
  win.on('focus', () => {
    try { embed.raiseHosted(); } catch { /* best effort */ }
    queueEmbedRelayout('focus');
  });

  // The WINDOW's focus, not the chrome document's. app.js pauses the new-tab
  // board while the window is behind something else, and a click into a
  // <webview> blurs the chrome document without the window losing focus at
  // all -- so that decision has to come from here.
  win.on('focus', () => send('win:focus', { focused: true }));
  win.on('blur', () => send('win:focus', { focused: false }));
  // The state the renderer missed while it was loading.
  win.webContents.on('did-finish-load', () => {
    const w = liveWin();
    if (!w) return;
    send('win:focus', { focused: w.isFocused() });
    // …and a link that arrived before the chrome was listening (see openUrlTab),
    // after any close command that came first (it must not close the link's tab).
    flushPendingCloseTabs();
    flushPendingOpenUrl();
  });

  // F11 can also come from the OS or the page, so the chrome is told about the
  // resulting state rather than assuming its own toggle was the only source.
  win.on('enter-full-screen', () => send('win:fullscreen', { fullscreen: true }));
  win.on('leave-full-screen', () => send('win:fullscreen', { fullscreen: false }));

  // A chrome renderer that died takes every embedded app window with it in
  // slow motion: nothing is left to call layout() or detach(), and the HWNDs are
  // still children of a window that is about to be reloaded or destroyed. Hand
  // them back the moment it happens -- the apps keep running as normal windows.
  win.webContents.on('render-process-gone', (_event, details) => {
    try { embed.detachAll(); } catch { /* nothing left to protect */ }
    syncNativeFocusPoll();   // nothing hosted, and no renderer to send to
    console.warn('[embed] chrome renderer gone:', (details && details.reason) || '?');
  });
  // quartz.log: this window's renderer crashing or hanging (log.js).
  if (qlog) qlog.watchWindow(win);
  if (freezeWatch) freezeWatch.attachWindow(win);

  // The chrome itself only ever needs an editing menu (address bar, find box).
  // This IS the focused window, so the built-in roles are the right wiring.
  win.webContents.on('context-menu', (_event, params) => {
    if (!params || !params.isEditable) return;
    const template = joinMenuGroups([
      spellingMenuItems(win.webContents, params),
      [{ role: 'undo' }, { role: 'redo' }],
      [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }],
      [{ role: 'selectAll' }],
    ]);
    if (dumpMenu('chrome', template)) return;
    const menu = Menu.buildFromTemplate(template);
    const w = liveWin();
    menu.popup(w ? { window: w } : {});
  });

  // Window state: drags and resizes fire continuously, so those are debounced;
  // maximize / unmaximize / close are one-shot and written straight away --
  // 'close' being the last moment anything can be written at all.
  win.on('resize', () => queueWindowStateSave(win));
  win.on('move', () => queueWindowStateSave(win));
  win.on('maximize', () => saveWindowState(win));
  win.on('unmaximize', () => saveWindowState(win));
  win.on('close', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveWindowState(win);
    // THE moment for native app tabs: any app window still parented into this
    // one is a child HWND, and a child HWND is destroyed with its parent --
    // which for most programs means the program exits. Hand them all back to
    // the desktop while the window still exists.
    try { embed.handleWindowClose(); } catch { /* nothing left to protect */ }
    // …and with the apps go the global keys that were only ever borrowed.
    syncNativeFocusPoll();
  });

  win.loadFile('index.html');

  win.on('closed', () => {
    win = null;
    // A hidden Watch reader is a window too: it must not keep the app alive
    // past its last real window (window-all-closed waits for every window).
    try { watch.stop(); } catch { /* best effort */ }
  });
  // Watch reads only while Quartz is on screen; whatever fell due while it was
  // hidden or minimised reads when it comes back.
  for (const ev of ['show', 'restore']) win.on(ev, () => { try { watch.windowShown(); } catch { /* best effort */ } });
  // Back from Edge (a title Watch opened there): what went stale, and that service, reads now.
  win.on('focus', () => { try { if (typeof watch.windowFocused === 'function') watch.windowFocused(); } catch { /* best effort */ } });
}

// ---------------------------------------------------------------------------
// Links from Windows
// ---------------------------------------------------------------------------

/*
 * Being the default browser is one command line: Windows appends the URL to the
 * command registered under HKCU\Software\Clients\StartMenuInternet (written by
 * register-default-browser.ps1) and starts us. A link therefore arrives either
 * as our own argv -- the first click of the day, which starts the browser -- or,
 * far more often, as a second instance's argv handed over by the lock above.
 * Both ends here, and both become an ordinary foreground tab through the same
 * 'open-url' message the context menu's "Open link in new tab" uses.
 */

/** A URL that beat the chrome to it. Flushed on the first 'did-finish-load'. */
let pendingOpenUrl = null;

// urlFromArgv(argv) -- the URL on a command line, or null: an http(s) URL, a
// file: URL, or an .htm(l) PATH (the file association's "%1"). It lives in
// argvurl.js so argvurl-harness.js can test it under plain node.

/** Give the chrome a foreground tab for `url`, or park it until it can take one. */
function openUrlTab(url) {
  if (!url) return;
  // Nothing listens for 'open-url' until index.html has finished loading, so a
  // URL that arrives during startup waits rather than being dropped.
  if (!canSend() || win.webContents.isLoadingMainFrame()) {
    pendingOpenUrl = url;
    return;
  }
  send('open-url', { url, background: false });
}

/** The parked URL, now that the chrome is listening. */
function flushPendingOpenUrl() {
  if (!pendingOpenUrl) return;
  const url = pendingOpenUrl;
  pendingOpenUrl = null;
  send('open-url', { url, background: false });
}

/*
 * Closing tabs by address (closetabs.js): `--close-tabs=<prefix>` and any number
 * of `--keep=<prefix>` on a command line. Main only reads the line and says
 * whether it was refused; the chrome owns the tabs, so it decides which close
 * (CloseTabs.planClose), closes them, shows the toast and sends back what it
 * did for the log line. Requests that beat the chrome to it wait, in order.
 */
let pendingCloseTabs = [];
const DROPPED_LINK_WORDS = 'The link on the same command line was not opened either.';

/** Hand a close request (ok or refused) to the chrome, or park it until it can take one. */
function deliverCloseTabs(request) {
  if (!request) return;
  // A refusal is logged here, where the line was read: the chrome only shows it.
  if (request.ok !== true) {
    const line = closeTabs.logText(request) + (request.droppedUrl ? ' ' + DROPPED_LINK_WORDS : '');
    console.log('[close-tabs] ' + line);
    if (qlog) qlog.log.line(line);
  }
  if (!canSend() || win.webContents.isLoadingMainFrame()) {
    pendingCloseTabs.push(request);
    return;
  }
  send('close-tabs', request);
}

/** The parked requests, now that the chrome is listening. */
function flushPendingCloseTabs() {
  if (!pendingCloseTabs.length) return;
  const list = pendingCloseTabs;
  pendingCloseTabs = [];
  for (const request of list) send('close-tabs', request);
}

// What the chrome did with a request: counts and the prefixes, from which the
// line's words are made here (the chrome's text is never written as-is).
ipcMain.on('close-tabs:result', (event, payload) => {
  if (!isChromeSender(event)) return;
  const p = payload && typeof payload === 'object' ? payload : {};
  const count = (v) => (Number.isInteger(v) && v >= 0 && v < 100000 ? v : 0);
  const prefixes = (Array.isArray(p.prefixes) ? p.prefixes : []).slice(0, 20)
    .map((x) => closeTabs.checkPrefix(x)).filter((c) => c.ok).map((c) => c.prefix);
  const line = p.ok === true
    ? closeTabs.logText({
      ok: true, close: new Array(count(p.closed)).fill(0), matched: count(p.matched), kept: count(p.kept),
      pinned: count(p.pinned), notWeb: count(p.notWeb), spared: count(p.spared), prefixes,
    })
    : 'Closing tabs from the command line did not finish: '
      + String(p.reason || 'the chrome gave no reason').replace(/\s+/g, ' ').slice(0, 300).replace(/\.?$/, '.');
  console.log('[close-tabs] ' + line);
  if (qlog) qlog.log.line(line);
});

/*
 * The copy that kept the lock hears every copy that did not. A person just
 * clicked a link, so this is the one place where taking the foreground is the
 * right thing to do -- including for a bare second launch, which raises the
 * window that already exists instead of opening another one.
 *
 * A close command is the exception (CloseTabs.commandPlan): on its own it opens
 * nothing and leaves the window exactly where it is in the z-order, focus and
 * all. With a link on the same line, the close goes first (so it cannot close
 * the link's new tab) and the link then opens and raises as any link does. A
 * refused close runs nothing on its line, the link included.
 */
app.on('second-instance', (_event, argv) => {
  const plan = closeTabs.commandPlan(closeTabs.requestFromArgv(argv), urlFromArgv(argv));
  if (plan.close) {
    // A refused line says so, and says when a link on it was dropped as well.
    const dropped = plan.close.ok !== true && !!urlFromArgv(argv);
    deliverCloseTabs(dropped ? Object.assign({}, plan.close, { droppedUrl: true }) : plan.close);
  }
  openUrlTab(plan.url);
  if (!plan.raise) return;
  const w = liveWin();
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
});

app.whenReady().then(async () => {
  // First of all: the log's start line says how the LAST run ended, and every
  // later hook (the window, each guest, the adblock engine) writes through it.
  // A log that cannot start leaves qlog null; Quartz runs exactly as before.
  try {
    const testRun = process.argv.includes('--test-profile');
    const named = process.argv.find((a) => a.startsWith('--profile-name='));
    const everyMs = Number(process.env.QUARTZ_LOG_MEMORY_MS);
    qlog = quartzLog.install({
      app, ipcMain, isChromeSender, webContents: require('electron').webContents,
      powerMonitor: require('electron').powerMonitor, appDir: __dirname,
      profile: testRun ? (named ? named.slice('--profile-name='.length) : 'default') : '',
      // A test run may check the memory line without waiting 30 min.
      memoryEveryMs: testRun && everyMs >= 1000 ? everyMs : undefined,
    });
  } catch (err) {
    console.error('[log] quartz.log is not being written:', (err && err.message) || err);
  }
  try {
    freezeWatch = freezeWatchMod.install({
      app, ipcMain, isChromeSender, BrowserWindow, powerMonitor: require('electron').powerMonitor,
      userData: app.getPath('userData'), isTest: process.argv.includes('--test-profile'),
      logLine: (line) => { if (qlog) qlog.log.line(line); },
    });
  } catch (err) {
    freezeWatch = null;
    if (qlog) qlog.log.line('The freeze watch did not start: ' + ((err && err.message) || err) + '.');
  }
  // uvboost's line (fix on, NOT on and why, or undone by its CPU guard), whenever it comes.
  require('./uvboost').onLine((t) => { if (qlog) qlog.log.line(t); });
  // The DevTools port's one line (on at which port and why, fell back, off, or failed), and
  // the final cdp.json, once Chromium has written DevToolsActivePort. Not awaited: startup
  // never waits on it. Settings > Claude shows the same state.
  if (cdp) {
    cdp.confirm((t) => { console.log('[cdp] ' + t); if (qlog) qlog.log.line(t); })
      .catch((err) => { cdpPlanError = 'checking the DevTools port failed: ' + ((err && err.message) || err); console.error('[cdp] ' + cdpPlanError); });
  } else if (qlog) {
    qlog.log.line('DevTools (CDP) is NOT available: ' + cdpPlanError + '.');
  }
  // Before the handlers: a request that arrives first must already see what
  // the user decided on a previous run.
  loadPermissionDecisions();
  attachSessionHandlers();
  // Before the first window: a session preload only reaches frames created
  // after it is registered, and the chrome's own document is one of them.
  spell.start();
  drm.start(); // the DRM page watcher: a session preload too, so also before the window
  lookSync = lookSyncMain.install({
    app, ipcMain, send, liveWin, isChromeSender, nativeTheme,
    screen: require('electron').screen, powerMonitor: require('electron').powerMonitor,
  });
  toprow = toprowMain.install({ ipcMain, BrowserWindow, test: process.argv.includes('--test-profile') });
  // Tab sleep (tabsleep-main.js): 'tabs:memory', 'tabs:prepare-sleep' (the safe-to-sleep probe),
  // and every guest's audio-state-changed pushed to the chrome as 'tabs:audio-state'.
  tabSleepMain.install({ app, ipcMain, webContents, isChromeSender, chromeContents: () => (canSend() ? win.webContents : null) });
  // In-app updates (updater-main.js): a release on GitHub, a card, one button. Never on a test
  // profile, a linked worktree, or a folder with no-updates.local in it.
  try {
    require('./updater-main').install({
      app, ipcMain, isChromeSender, installed: INSTALLED,
      send: (channel, payload) => { if (!canSend()) return false; win.webContents.send(channel, payload); return true; },
      logLine: (line) => { if (qlog) qlog.log.line(line); },
    }).start();
  } catch (err) {
    const why = String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 200);
    console.error('[updates] the updater could not start: ' + why);
    for (const ch of ['updates:state', 'updates:check', 'updates:set', 'updates:later', 'updates:update', 'updates:open-log']) {
      try { ipcMain.handle(ch, () => { throw new Error('the updater could not start: ' + why); }); } catch { /* already registered */ }
    }
  }
  // castlabs ECS: the Widevine CDM must be ready before the first window
  // (components.whenReady). Capped at 4 s so a first run offline still opens;
  // on stock Electron this returns at once.
  const cdm = await drm.whenCdmReady(4000);
  if (!cdm.available) {
    console.log('[drm] ' + cdm.reason);
    // quartz.log lines are sentences (log-e2e checks every one).
    if (qlog) qlog.log.line('Protected video is not available at start: ' + cdm.reason);
  }
  createWindow();

  // A link that STARTED the browser: its tab goes in on top of the session the
  // strip restores, never instead of it. No URL on the command line changes
  // nothing at all. A close command on the same line goes first (a close on
  // its own never got this far: see the single-instance lock above).
  {
    const plan = closeTabs.commandPlan(closeTabs.requestFromArgv(process.argv), urlFromArgv(process.argv));
    if (plan.close) deliverCloseTabs(plan.close);
    openUrlTab(plan.url);
  }

  /*
   * A KILLED session's leftovers, repaired once, here (see embed.recoverOrphans).
   *
   * Every orderly exit hands hosted app windows back. A kill -- End task, a
   * crash, the power going -- does not, and owner mode leaves the app ALIVE with
   * no caption, no border and no taskbar button: a rectangle the user cannot move or
   * close. embed.js writes what it would take to undo that on every attach, so
   * this reads a file that is normally absent and, when it is not, puts the
   * frames back. Guarded four ways inside (age, IsWindow, the same exe, and the
   * window still wearing OUR style), so it can only ever touch a window this
   * browser really did leave broken.
   */
  try {
    const fixedUp = embed.recoverOrphans();
    if (fixedUp && fixedUp.fixed) {
      console.warn('[embed] put the frame back on ' + fixedUp.fixed
        + ' window(s) a killed session left frameless');
    }
  } catch { /* a repair that cannot run costs nothing that was working */ }

  // Deliberately not awaited: a cold start fetches filter lists over the
  // network and the window must not wait on that.
  initAdblock();

  // macOS: re-open a window when the dock icon is clicked with none open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ---------------------------------------------------------------------------
// PTY IPC
// ---------------------------------------------------------------------------

/*
 * ConPTY hands us tiny pieces, very fast.
 *
 * MEASURED (node-pty, the same spawn path, 2 MB of output): 19,748 chunks,
 * mean 104 bytes, 829 a second -- and 19,414 of the 19,747 gaps between them
 * were under 16 ms. One webContents.send per chunk is therefore ~19,700
 * structured-clone round trips and ~19,700 wake-ups of a renderer that can
 * only paint 60 of them, which is the classic flood sink.
 *
 * So: the FIRST chunk after a quiet spell goes out untouched -- keystroke echo
 * must never wait -- and that opens a 16 ms window. Anything arriving inside
 * the window is appended to one buffer and sent when it closes, in order, or
 * sooner if the buffer passes the byte cap. A window that closes empty goes
 * back to idle, so a sitting Claude tab holds no timer at all.
 */
const PTY_FLUSH_MS = 16;
const PTY_FLUSH_BYTES = 64 * 1024;

/** pty id -> { parts: string[], bytes: number, timer: Timeout|null } */
const ptyOut = new Map();

function ptySendNow(buf, id) {
  const data = buf.parts.length === 1 ? buf.parts[0] : buf.parts.join('');
  buf.parts.length = 0;
  buf.bytes = 0;
  send('pty:data', { id, data });
}

/** The coalescing window closed. Flush what is waiting, or go idle. */
function ptyWindowEnd(id) {
  const buf = ptyOut.get(id);
  if (!buf) return;
  buf.timer = null;
  if (!buf.parts.length) return; // quiet: the next chunk goes out instantly
  ptySendNow(buf, id);
  buf.timer = setTimeout(() => ptyWindowEnd(id), PTY_FLUSH_MS);
}

function ptyPush(id, data) {
  let buf = ptyOut.get(id);
  if (!buf) {
    buf = { parts: [], bytes: 0, timer: null };
    ptyOut.set(id, buf);
  }
  buf.parts.push(data);
  buf.bytes += data.length;
  if (buf.timer === null) {
    // Idle: deliver at once, then open the window.
    ptySendNow(buf, id);
  } else if (buf.bytes >= PTY_FLUSH_BYTES) {
    // The cap beats the clock: never sit on more than 64 KB.
    clearTimeout(buf.timer);
    ptySendNow(buf, id);
  } else {
    return; // already inside a window; it will carry this out
  }
  buf.timer = setTimeout(() => ptyWindowEnd(id), PTY_FLUSH_MS);
}

/** Everything still buffered goes out before the caller says the session ended. */
function ptyFlushFinal(id) {
  const buf = ptyOut.get(id);
  if (!buf) return;
  if (buf.timer !== null) clearTimeout(buf.timer);
  if (buf.parts.length) ptySendNow(buf, id);
  ptyOut.delete(id);
}

// The terminal programs a tab may run: [{ id, title, available }]. The chrome
// uses it for tab titles and for what the dock/palette offer.
ipcMain.handle('pty:programs', (event) => {
  if (!isChromeSender(event)) return [];
  try {
    return listPrograms();
  } catch (err) {
    console.error('[pty] listPrograms failed:', err && err.message);
    return [];
  }
});

// Quartz's read-only tab tools for Claude panes (mcp-main.js): list tabs, read
// a page's text, search history and notes, highlight a quote. Each Claude
// spawn gets its own key and a --mcp-config file; the pipe server starts with
// the first pane that has them. `readTabs` is the Settings switch, put on the
// spawn by preload (off until the chrome has said it is on); off means the
// pane starts without the tools, and the pane says so (mcp:pane).
const claudeTools = claudeToolsModule.install({
  app, ipcMain, webContents, session, send, isChromeSender,
  getWin: () => win,
  log: (text) => { if (qlog) qlog.log.line(text); else console.log('[mcp]', text); },
});

/** pty id -> release() of that spawn's tab tools (key revoked, config file deleted). */
const ptyToolRelease = new Map();

function releasePtyTools(id) {
  const release = ptyToolRelease.get(id);
  if (!release) return;
  ptyToolRelease.delete(id);
  try { release(); } catch (err) { console.warn('[mcp] release failed:', err && err.message); }
}

// `program` and `args` are both passed straight through: pty.js owns the
// program table AND the per-program arg allowlist, so there is exactly one
// place that decides what may reach a command line. An id that is not in the
// table (a renderer-supplied path included) is refused here with a null, which
// terminal.js already renders as a failed start.
ipcMain.handle('pty:start', (event, { program, cwd, cols, rows, args, readTabs } = {}) => {
  if (!isChromeSender(event)) return null;
  if (!hasProgram(program)) {
    console.warn('[pty] refused unknown program:', String(program).slice(0, 60));
    return null;
  }
  // Claude only (pty.js defaults a missing program to claude).
  const isClaude = program === undefined || program === null || program === 'claude';
  const tools = isClaude
    ? claudeTools.prepareLaunch({ paneId: paneIdFromArgs(args), enabled: readTabs === true })
    : null;
  let session;
  try {
    session = createSession({
      program,
      cwd,
      cols,
      rows,
      args,
      extra: tools && tools.attached ? { args: tools.args, env: tools.env } : null,
      onData: (data) => ptyPush(session.id, data),
      onExit: (exitCode) => {
        handles.delete(session.id);
        releasePtyTools(session.id);
        ptyFlushFinal(session.id); // the last output, then the exit
        send('pty:exit', { id: session.id, exitCode });
      },
    });
  } catch (err) {
    if (tools) tools.release(); // the spawn failed: its key and file go with it
    throw err;
  }

  handles.set(session.id, session);
  if (tools && tools.attached) {
    ptyToolRelease.set(session.id, tools.release);
    // What the CLI actually got (after pty.js's allowlist and page-text rule):
    // a pane that skips Claude Code's prompts is asked by Quartz before list_tabs too.
    tools.setSkipsPrompts(Array.isArray(session.args) && session.args.indexOf('--dangerously-skip-permissions') !== -1);
  }
  return session.id;
});

ipcMain.on('pty:write', (_event, { id, data } = {}) => {
  const session = handles.get(id);
  if (session) session.write(data);
});

ipcMain.on('pty:resize', (_event, { id, cols, rows } = {}) => {
  const session = handles.get(id);
  if (session) session.resize(cols, rows);
});

ipcMain.on('pty:kill', (_event, { id } = {}) => {
  const session = handles.get(id);
  if (!session) return;
  handles.delete(id);
  releasePtyTools(id);
  ptyFlushFinal(id); // never strand a buffered tail on a closed tab's timer
  session.kill();
});

// ---------------------------------------------------------------------------
// Window controls
//
// The window is frameless, so the renderer draws its own minimize / maximize /
// close buttons and asks us to act on them.
// ---------------------------------------------------------------------------

/** The window, but only while it is still usable. */
function liveWin() {
  return win && !win.isDestroyed() ? win : null;
}

ipcMain.handle('win:info', () => {
  const w = liveWin();
  return { acrylic: acrylicActive, maximized: !!w && w.isMaximized() };
});

ipcMain.on('win:minimize', () => {
  const w = liveWin();
  if (w) w.minimize();
});

ipcMain.on('win:maximize', () => {
  const w = liveWin();
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});

ipcMain.on('win:close', () => {
  const w = liveWin();
  if (w) w.close();
});

/**
 * "Restart browser" (Settings > About, and the command palette): close and
 * reopen with the tabs restored, which is what every update to this app needs.
 *
 * app.quit() rather than app.exit(): quit is the path that runs 'before-quit'
 * (killAll() for the PTYs, and autoPause.handleQuit(), which hands our Spotify
 * hold back and may defer the quit by up to ~1.5 s to do it -- it calls
 * app.quit() again when it is done). app.exit() would skip all of that and
 * leave Spotify paused until the bridge's hold expired. The renderer has
 * already flushed its session snapshot over 'session:write' by the time this
 * arrives, and the window rect is written here the way 'close' writes it.
 *
 * app.relaunch() with no arguments reuses this process's own argv and working
 * directory, so a test instance (--test-profile, --remote-debugging-port)
 * comes back as the same test instance.
 */
ipcMain.on('app:restart', () => {
  try {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const w = liveWin();
    if (w) saveWindowState(w);
  } catch {
    // Never let a disk error strand the user in a browser that will not restart.
  }
  app.relaunch();
  app.quit();
});

ipcMain.on('win:fullscreen-toggle', () => {
  const w = liveWin();
  if (w) w.setFullScreen(!w.isFullScreen());
});

/** Paths the renderer wants to show but must not guess at. */
ipcMain.handle('app:paths', () => ({
  home: app.getPath('home'),
  downloads: app.getPath('downloads'),
}));

/**
 * Where the profile lives and whether it was moved to get there (Settings >
 * About). The move to Quartz must never be silent: `thisStart` is what the
 * startup check did in this run, `note` is the record the move left behind,
 * so About can still say "moved from ... on ..." long after the start that did
 * it. By now userData exists, so asking for it creates nothing.
 */
/*
 * Settings > Claude: the DevTools (CDP) port's state for this run, and the
 * switch that turns it off from the next start (cdp-main.js describe/setEnabled).
 * A plan that threw answers { ok: false, error } so the row still says why.
 */
ipcMain.handle('cdp:describe', (event) => {
  if (!isChromeSender(event)) return null;
  if (!cdp) return { ok: false, enabled: true, enabledNext: true, governed: false, mode: 'error', error: cdpPlanError || 'not set up' };
  return cdp.describe();
});
ipcMain.handle('cdp:set-enabled', (event, { enabled } = {}) => {
  if (!isChromeSender(event)) return null;
  if (!cdp) return { ok: false, enabled: true, enabledNext: true, governed: false, mode: 'error', error: cdpPlanError || 'not set up', saveError: 'the setting cannot be saved: ' + (cdpPlanError || 'not set up') };
  return cdp.setEnabled(enabled === true);
});

ipcMain.handle('app:profile', () => {
  let userData = '';
  try { userData = app.getPath('userData'); } catch { userData = ''; }
  const r = profileMoveResult || {};
  return {
    userData,
    test: process.argv.includes('--test-profile'),
    thisStart: {
      action: r.action || '',
      why: r.why || '',
      attempts: r.attempts || 0,
      raced: !!r.raced,
      noteError: r.noteError || '',
      from: r.from || '',
      at: r.at || '',
    },
    note: userData ? profileMove.readMoveNote(userData) : null,
  };
});

/**
 * Native folder picker for "which folder should this Claude session run in".
 * Returns the chosen absolute path, or null for cancel / any failure -- the
 * caller treats both the same way, so there is nothing to throw about.
 */
ipcMain.handle('app:pick-folder', async (_event, { defaultPath } = {}) => {
  const options = {
    properties: ['openDirectory'],
    defaultPath:
      typeof defaultPath === 'string' && defaultPath.trim()
        ? defaultPath.trim()
        : app.getPath('home'),
    title: 'Choose a folder for Claude',
  };
  try {
    const w = liveWin();
    // Parented when we have a window, so the sheet is modal to it.
    const result = w
      ? await dialog.showOpenDialog(w, options)
      : await dialog.showOpenDialog(options);
    if (!result || result.canceled) return null;
    const picked = Array.isArray(result.filePaths) ? result.filePaths[0] : null;
    return typeof picked === 'string' && picked ? picked : null;
  } catch {
    return null;
  }
});

/** Does this path name an existing directory? (settings validates typed paths) */
ipcMain.handle('app:dir-exists', (_event, { path: target } = {}) => {
  if (typeof target !== 'string' || !target.trim()) return false;
  try {
    return fs.statSync(path.resolve(target.trim())).isDirectory();
  } catch {
    return false;
  }
});

// ---------------------------------------------------------------------------
// The new tab's moving background
//
// Settings keeps the descriptor; the clip is copied into
// <userData>/backgrounds/ so the page keeps playing after the original moves.
// bgfiles.js holds the whole copy/validate path with no Electron in it --
// everything here is the dialog and the userData path it cannot know.
// ---------------------------------------------------------------------------

/** Where the one copied clip lives. Lazy: --test-profile rewrites userData. */
function backgroundsDir() {
  return bgFiles.backgroundsDir(app.getPath('userData'));
}

/**
 * Pick a clip and copy it in.
 * Resolves { ok: true, fileUrl, fileName, bytes } or { ok: false, reason },
 * where reason is 'cancelled', 'too-large' (past 512 MB) or a message.
 * Never rejects -- the settings panel shows the reason as a toast.
 */
ipcMain.handle('background:choose-video', async () => {
  const options = {
    properties: ['openFile'],
    title: 'Choose a moving picture for the new tab',
    filters: [{ name: 'Moving pictures', extensions: bgFiles.VIDEO_EXTS.slice() }],
  };
  let picked = null;
  try {
    const w = liveWin();
    const result = w
      ? await dialog.showOpenDialog(w, options)
      : await dialog.showOpenDialog(options);
    if (!result || result.canceled) return { ok: false, reason: 'cancelled' };
    picked = Array.isArray(result.filePaths) ? result.filePaths[0] : null;
  } catch (err) {
    return { ok: false, reason: (err && err.message) || 'The picker could not open' };
  }
  if (typeof picked !== 'string' || !picked) return { ok: false, reason: 'cancelled' };

  const out = bgFiles.installBackgroundVideo(picked, backgroundsDir());
  if (!out.ok) return { ok: false, reason: out.reason };
  return { ok: true, fileUrl: out.fileUrl, fileName: out.fileName, bytes: out.bytes };
});

/** Drop the copied clip. Always { ok: true }: gone is the state we wanted. */
ipcMain.handle('background:clear-video', () => {
  try {
    bgFiles.clearBackgroundFiles(backgroundsDir());
  } catch { /* nothing there */ }
  return { ok: true };
});

// The Windows wallpaper copy: Quartz's DEFAULT background. bgfiles.js reads
// %APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper, sniffs its bytes and
// writes <userData>/backgrounds/wallpaper.<ext> -- once when it is missing
// ('background:wallpaper', which every boot asks), and again only when the
// user presses "Copy again from Windows" ('background:recopy-wallpaper').
// Both resolve { ok, fileUrl, fileName, copiedAt, reason } and never reject;
// a failed re-copy still hands back the old copy's fileUrl beside the reason.
function wallpaperCopy(force) {
  let appDataDir = process.env.APPDATA || '';
  try { appDataDir = app.getPath('appData') || appDataDir; } catch { /* keep the env value */ }
  try {
    const out = bgFiles.copyWallpaper({ appDataDir, dir: backgroundsDir(), force: !!force });
    return {
      ok: !!out.ok,
      fileUrl: out.fileUrl || null,
      fileName: out.fileName || null,
      copiedAt: out.copiedAt || null,
      reason: out.reason || null,
    };
  } catch (err) {
    return { ok: false, fileUrl: null, fileName: null, copiedAt: null,
      reason: (err && err.message) || 'the wallpaper could not be copied' };
  }
}

ipcMain.handle('background:wallpaper', (event) => {
  if (!isChromeSender(event)) return { ok: false, fileUrl: null, fileName: null, copiedAt: null, reason: 'refused' };
  return wallpaperCopy(false);
});

ipcMain.handle('background:recopy-wallpaper', (event) => {
  if (!isChromeSender(event)) return { ok: false, fileUrl: null, fileName: null, copiedAt: null, reason: 'refused' };
  return wallpaperCopy(true);
});

// The built-in photos (Helm's gallery, in <app>/assets/backgrounds/). Read
// once per run: they ship with the build and cannot change under it. Resolves
// bgfiles.readBuiltins()'s { ok, reason, items } and never rejects.
let builtinsCache = null;
ipcMain.handle('background:builtins', (event) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused', items: [] };
  if (!builtinsCache || !builtinsCache.ok) {
    builtinsCache = bgFiles.readBuiltins(path.join(__dirname, 'assets', 'backgrounds'));
  }
  return builtinsCache;
});

// ---------------------------------------------------------------------------
// Idle music: the user's own tracks
//
// Unlike the moving background, NOTHING is copied. The user's library can be tens
// of gigabytes and lives where they keep it; settings stores the descriptors and
// the chrome plays each file where it lies.
//
// How the chrome reaches the bytes: index.html is loaded with loadFile(), so
// the chrome document is itself a file:// page, it carries no
// Content-Security-Policy meta (nothing in this process injects one either) and
// the window's webPreferences leave webSecurity at its default. A file:// page
// may load file:// MEDIA subresources, which is the same route the new tab's
// moving background already takes for a clip under <userData>. So the chrome
// builds its own URL with `new URL('file:///...')` / pathToFileURL semantics and
// no custom protocol is needed:
//
//   audio.src = 'file:///C:/Users/you/Music/track.mp3'   (percent-encoded)
//
// If a future Electron or a CSP ever closes that door, the fix is a `music://`
// scheme registered with protocol.handle and restricted to the paths below --
// it is deliberately NOT here today, because an unused protocol is one more way
// to hand a page arbitrary file reads. (Main cannot read the settings list on
// its own: the store is renderer localStorage -- see the note on the session
// snapshot -- so such a protocol would need the chrome to register its
// remembered paths at boot.)
// ---------------------------------------------------------------------------

/** What the picker will accept. Anything Chromium can decode from a file. */
const MUSIC_EXTS = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'webm'];

/** A sane ceiling on one pick, so a "select all" in a huge folder cannot flood IPC. */
const MUSIC_MAX_FILES = 500;

/**
 * Picked paths -> the descriptors settings stores. Pure, so a harness can check
 * the shape without a dialog: junk entries are dropped and the list is capped.
 */
function shapeMusicFiles(paths) {
  if (!Array.isArray(paths)) return [];
  const out = [];
  for (const entry of paths) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    out.push({ path: entry, name: path.basename(entry) || entry });
    if (out.length >= MUSIC_MAX_FILES) break;
  }
  return out;
}

/**
 * Choose tracks for the idle music player.
 * Resolves { ok: true, files: [{ path, name }] } or { ok: false, reason, files: [] },
 * where reason is 'cancelled', 'refused' or a message. Never rejects, and never
 * copies or reads a byte of what was picked.
 */
ipcMain.handle('music:choose-files', async (event) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused', files: [] };
  const options = {
    properties: ['openFile', 'multiSelections'],
    title: 'Choose music for the idle player',
    filters: [
      { name: 'Music', extensions: MUSIC_EXTS.slice() },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  let picked = null;
  try {
    const w = liveWin();
    const result = w
      ? await dialog.showOpenDialog(w, options)
      : await dialog.showOpenDialog(options);
    if (!result || result.canceled) return { ok: false, reason: 'cancelled', files: [] };
    picked = result.filePaths;
  } catch (err) {
    return { ok: false, reason: (err && err.message) || 'The picker could not open', files: [] };
  }
  const files = shapeMusicFiles(picked);
  if (!files.length) return { ok: false, reason: 'cancelled', files: [] };
  return { ok: true, files };
});

// ---------------------------------------------------------------------------
// Session snapshot
//
// The renderer keeps its tab list in localStorage, which Chromium flushes
// lazily -- a crash or a forced kill loses the last write. This is the durable
// mirror: main writes it synchronously and atomically on every snapshot, so
// the newer of (localStorage, session.json) is always a real session.
// ---------------------------------------------------------------------------

/** Lazy, like windowStatePath(): --test-profile must not touch the real one. */
function sessionStatePath() {
  return path.join(app.getPath('userData'), 'session.json');
}

/**
 * Anything this big is a bug or a runaway, not a session. The renderer bounds its own snapshot
 * (app.js SESSION_MAX_TABS, SESSION_MAX_CHARS: 1.5 million characters of tabs, at most 3 UTF-8
 * bytes each), so a snapshot it means to write always fits under this one. At 256 KB, 500 tabs
 * with long urls could pass the renderer's bounds and still be refused here without a word.
 */
const SESSION_MAX_BYTES = 6 * 1024 * 1024;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/*
 * The write itself is ASYNC, and only one is ever in flight.
 *
 * MEASURED: 300 snapshots pushed back to back cost 1367 ms of main-process CPU
 * when this was writeFileSync + renameSync -- 777 ms of it inside rename() --
 * and stalled the event loop for 1168 ms at the 99th percentile. Every one of
 * those milliseconds was the whole UI: main draws no frames, so a disk hiccup
 * during a burst of tab closes is felt as a freeze. Async takes the same work
 * off the loop thread; the pending slot collapses a burst into one write per
 * completed write, because only the NEWEST snapshot has ever been worth
 * keeping. Durability is unchanged where it matters: flushSessionSync() below
 * runs on quit and restart, when there is no loop left to protect.
 */
// sessionfile.js: the pump above, plus a failed write keeps its snapshot and tries again (a
// virus scanner holding session.json makes the rename fail for a moment on Windows).
const sessionFile = require('./sessionfile').create({ target: sessionStatePath });

/** The last moment anything can be written: the process is about to go. */
function flushSessionSync() {
  try { sessionFile.flushSync(); } catch { /* Nothing useful to do while quitting. */ }
}

ipcMain.on('session:write', (_event, { snapshot } = {}) => {
  try {
    if (!isPlainObject(snapshot) || !Array.isArray(snapshot.tabs)) return;

    const json = JSON.stringify(snapshot);
    if (typeof json !== 'string') return;
    if (Buffer.byteLength(json, 'utf8') > SESSION_MAX_BYTES) return;

    sessionFile.write(json);
  } catch {
    // A disk error must never take down an IPC handler.
  }
});

// Tests only: answer late, the way a main busy at boot does (sessions-e2e boot 3).
const SESSION_READ_DELAY_MS = process.argv.includes('--test-profile') ? Math.min(Number(process.env.QUARTZ_TEST_SESSION_READ_DELAY_MS) || 0, 2500) : 0;

ipcMain.handle('session:read', async () => {
  if (SESSION_READ_DELAY_MS > 0) await new Promise((r) => setTimeout(r, SESSION_READ_DELAY_MS));
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionStatePath(), 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null; // no file yet, unreadable, or not JSON
  }
});

/**
 * The theme guest PAGES see -- what a site reads from prefers-color-scheme.
 * It is a process-wide switch, so only main can set it; the renderer owns the
 * stored preference (localStorage) and replays it here at load and on change.
 * Anything but the three known modes is ignored rather than guessed at.
 */
ipcMain.on('app:site-theme', (_event, payload) => {
  const mode = payload && payload.mode;
  if (mode !== 'system' && mode !== 'light' && mode !== 'dark') return;
  nativeTheme.themeSource = mode;
});

// ---------------------------------------------------------------------------
// Downloads
//
// Electron's default is to pop a native save dialog for every file. A real
// browser does not ask: it drops the file in the Downloads folder, never
// overwrites anything already there, and shows progress in its own UI. The
// DownloadItem objects die with their session, so everything the renderer
// needs is mirrored into a plain record the moment it changes.
// ---------------------------------------------------------------------------

/** id -> record (plus the live DownloadItem while one exists). */
const downloads = new Map();
let nextDownloadId = 1;

/**
 * "Ask where to save each file", pushed over dl:prefs. The preference itself
 * lives in the renderer's settings store, which this process cannot read, so
 * the renderer replays it at boot and on every change. Default false: a real
 * browser does not ask.
 */
let downloadAskWhere = false;

/** Progress ticks far faster than anyone can read. ~8/sec is plenty. */
const DOWNLOAD_UPDATE_MS = 125;

/** Give up de-duplicating a name long before we can hang on a full folder. */
const MAX_DUPLICATE_TRIES = 500;

/**
 * The first path in `dir` that does not exist yet: 'a.zip', then 'a (1).zip'.
 * Silently clobbering a file the user already has is the one download
 * behaviour nobody forgives.
 */
function uniqueDownloadPath(dir, rawFilename) {
  // basename() first: Chromium already strips separators out of a
  // Content-Disposition name, but joining an unflattened one onto `dir` is the
  // only place a '..\..\' could ever walk the write out of Downloads.
  const filename = path.basename(String(rawFilename || '')) || 'download';
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  for (let i = 1; i <= MAX_DUPLICATE_TRIES && fs.existsSync(candidate); i++) {
    candidate = path.join(dir, base + ' (' + i + ')' + ext);
  }
  // Five hundred duplicates is absurd but not impossible; never overwrite.
  if (fs.existsSync(candidate)) candidate = path.join(dir, base + ' (' + Date.now() + ')' + ext);
  return candidate;
}

/** The renderer-facing shape. The DownloadItem itself never crosses IPC. */
function downloadPayload(entry) {
  return {
    id: entry.id,
    filename: entry.filename,
    url: entry.url,
    savePath: entry.savePath,
    state: entry.state,
    received: entry.received,
    total: entry.total,
    paused: entry.paused,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
  };
}

/** Push an update. `force` is for the first and last one, which never drop. */
function sendDownloadUpdate(entry, force) {
  const now = Date.now();
  if (!force && now - entry.lastSent < DOWNLOAD_UPDATE_MS) return;
  entry.lastSent = now;
  send('dl:update', downloadPayload(entry));
}

/** Read the item's counters into the record, tolerating a dead item. */
function syncDownloadItem(entry) {
  const item = entry.item;
  if (!item) return;
  try {
    entry.received = item.getReceivedBytes();
    entry.total = item.getTotalBytes(); // 0 when the server sent no length
    entry.paused = item.isPaused();
    // With "ask where to save", nothing chose a path up front: the item only
    // learns one once the user answers the native dialog. Adopt it the moment
    // it exists so the row's name, its Open and its Show all point at the
    // real file.
    if (!entry.savePath) {
      const chosen = item.getSavePath();
      if (chosen) {
        entry.savePath = chosen;
        entry.filename = path.basename(chosen);
      }
    }
  } catch {
    // The item was destroyed mid-read; the record keeps its last good values.
  }
}

function handleWillDownload(_event, item) {
  const dir = app.getPath('downloads');
  let savePath = '';
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (downloadAskWhere) {
      // Handing Electron dialog options INSTEAD of a path is what puts the
      // native Save dialog on screen. Cancelling it cancels the item ('done'
      // fires with 'cancelled'), and the path the user picked only becomes
      // readable through item.getSavePath() afterwards -- see
      // syncDownloadItem, which adopts it.
      item.setSaveDialogOptions({
        title: 'Save as',
        defaultPath: path.join(dir, item.getFilename())
      });
    } else {
      savePath = uniqueDownloadPath(dir, item.getFilename());
      // Setting the path up front is exactly what suppresses the save dialog.
      item.setSavePath(savePath);
    }
  } catch {
    // Could not choose a path -- let Electron fall back to its own prompt
    // rather than losing the download entirely.
  }

  const entry = {
    id: nextDownloadId++,
    item,
    filename: path.basename(savePath || item.getFilename()),
    url: item.getURL(),
    savePath,
    state: 'progressing',
    received: 0,
    total: 0,
    paused: false,
    startedAt: Date.now(),
    finishedAt: null,
    lastSent: 0,
  };
  syncDownloadItem(entry);
  downloads.set(entry.id, entry);
  sendDownloadUpdate(entry, true);

  item.on('updated', (_e, state) => {
    // 'interrupted' here means stalled-but-resumable, not finished.
    const next = state === 'interrupted' ? 'interrupted' : 'progressing';
    const wasPaused = entry.paused;
    const changed = next !== entry.state;
    entry.state = next;
    syncDownloadItem(entry);
    // A change of state (or of paused) is never throttled away: an interrupted
    // download gets no further 'updated' and no 'done', so a dropped update
    // left its row showing "1.0 MB of 2.0 MB" with Pause/Cancel for good.
    sendDownloadUpdate(entry, changed || entry.paused !== wasPaused);
  });

  item.once('done', (_e, state) => {
    syncDownloadItem(entry);
    entry.state = state; // 'completed' | 'cancelled' | 'interrupted'
    entry.paused = false;
    entry.finishedAt = Date.now();
    // The DownloadItem is spent: drop it so pause/resume/cancel become no-ops
    // and nothing holds a dead native handle.
    entry.item = null;
    sendDownloadUpdate(entry, true);
  });
}

/** Run `fn` against a download that is still live; otherwise do nothing. */
function withLiveDownload(id, fn) {
  const entry = downloads.get(id);
  if (!entry || !entry.item) return;
  try {
    fn(entry.item, entry);
  } catch {
    // Racing the 'done' event is normal: the item can die between the
    // renderer's click and this call.
  }
}

ipcMain.handle('dl:list', () =>
  [...downloads.values()]
    .sort((a, b) => b.startedAt - a.startedAt || b.id - a.id)
    .map(downloadPayload)
);

ipcMain.on('dl:cancel', (_event, { id } = {}) => {
  withLiveDownload(id, (item) => item.cancel());
});

ipcMain.on('dl:pause', (_event, { id } = {}) => {
  withLiveDownload(id, (item, entry) => {
    item.pause();
    entry.paused = true;
    sendDownloadUpdate(entry, true);
  });
});

ipcMain.on('dl:resume', (_event, { id } = {}) => {
  withLiveDownload(id, (item, entry) => {
    if (!item.canResume()) return;
    item.resume();
    entry.paused = false;
    sendDownloadUpdate(entry, true);
  });
});

ipcMain.handle('dl:open', (_event, { id } = {}) => {
  const entry = downloads.get(id);
  if (!entry || entry.state !== 'completed' || !entry.savePath) {
    return 'That download is not finished.';
  }
  return shell.openPath(entry.savePath); // '' means it opened
});

ipcMain.on('dl:show', (_event, { id } = {}) => {
  const entry = downloads.get(id);
  if (entry && entry.savePath) shell.showItemInFolder(entry.savePath);
});

/**
 * The renderer's copy of "ask where to save each file". Nothing is persisted
 * here: the settings store is the source of truth and replays this at boot.
 */
ipcMain.on('dl:prefs', (_event, { askWhere } = {}) => {
  downloadAskWhere = !!askWhere;
});

/** The panel's "Open folder": the Downloads folder itself, in Explorer. */
ipcMain.on('dl:open-folder', () => {
  const dir = app.getPath('downloads');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Already there, or not ours to make -- openPath says so either way.
  }
  shell.openPath(dir);
});

ipcMain.on('dl:clear', () => {
  for (const [id, entry] of downloads) {
    if (entry.state !== 'progressing') downloads.delete(id);
  }
});

// Used by the context menu's Save link as / Save image, which have a URL but
// no DownloadItem yet. Going through the window's webContents means the
// request carries our normal session, cookies included.
// Schemes a "Save link as" can ever legitimately name. `file:` is deliberately
// absent: a page must not be able to talk the chrome into copying something off
// the local disk into Downloads, and neither javascript: nor a custom protocol
// handler has any business here.
const DOWNLOADABLE_SCHEMES = new Set(['http:', 'https:', 'blob:', 'data:']);

ipcMain.on('dl:download-url', (_event, { url } = {}) => {
  const w = liveWin();
  if (!w || typeof url !== 'string' || !url) return;
  let scheme = '';
  try {
    scheme = new URL(url).protocol;
  } catch {
    return; // not a URL at all
  }
  if (!DOWNLOADABLE_SCHEMES.has(scheme)) return;
  w.webContents.downloadURL(url);
});

// ---------------------------------------------------------------------------
// Page screenshots
//
// capturePage() lives on the GUEST's webContents, which only this process can
// reach. The PNG lands in the Downloads folder beside real downloads and
// borrows their no-overwrite naming -- but it is not a DownloadItem, so it
// never appears in the downloads panel and nothing streams over dl:update.
// ---------------------------------------------------------------------------

/** Windows rejects <>:"/\|?* and control chars in a name, plus trailing dots. */
function safeFilePart(text, fallback) {
  const cleaned = String(text || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned || fallback;
}

/** Local time as 'YYYY-MM-DD HH-mm-ss' -- a colon cannot go in a filename. */
function captureStamp(date) {
  // Duck-typed rather than `instanceof Date`, which is false for a Date made
  // in another realm (a test harness, a different context).
  const d = date && typeof date.getFullYear === 'function' ? date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) +
    '-' + pad(d.getMinutes()) +
    '-' + pad(d.getSeconds())
  );
}

/**
 * Screenshot one guest into <Downloads>/Screenshot <host> <stamp>.png.
 *
 * `full` is RESERVED for a future full-page capture and deliberately changes
 * nothing today: stitching one would mean scrolling the guest under the user
 * and putting it back, so the visible area is what gets written either way.
 *
 * @returns {Promise<{ path: string, width: number, height: number } | { error: string }>}
 */
ipcMain.handle('capture:tab', async (_event, { wcId, full } = {}) => {
  void full; // reserved -- see above
  if (!Number.isInteger(wcId)) return { error: 'No page to capture.' };

  let contents = null;
  try {
    contents = webContents.fromId(wcId);
  } catch {
    contents = null;
  }
  // Only ever a <webview> guest: never the chrome's own renderer, and never a
  // stale id left behind by a closed tab.
  if (!contents || contents.isDestroyed() || contents.getType() !== 'webview') {
    return { error: 'That tab has no page to capture.' };
  }

  try {
    const image = await contents.capturePage();
    if (!image || image.isEmpty()) return { error: 'The page came back blank.' };

    const dir = app.getPath('downloads');
    fs.mkdirSync(dir, { recursive: true });
    const host = safeFilePart(hostOfUrl(contents.getURL()), 'page');
    const name = 'Screenshot ' + host + ' ' + captureStamp() + '.png';
    // The downloads helper, so a second capture inside the same second lands as
    // '... (1).png' instead of overwriting the first.
    const target = uniqueDownloadPath(dir, name);
    fs.writeFileSync(target, image.toPNG());

    const size = image.getSize();
    return { path: target, width: size.width, height: size.height };
  } catch (err) {
    return { error: (err && err.message) || 'The capture failed.' };
  }
});

/**
 * True only for a path that resolves INSIDE the Downloads folder. `..` and a
 * symlinked name both collapse in path.resolve() before the comparison, and
 * path.relative() on win32 compares case-insensitively, which is what NTFS
 * does.
 */
function isInsideDownloads(target) {
  try {
    const dir = path.resolve(app.getPath('downloads'));
    const rel = path.relative(dir, path.resolve(String(target)));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * Reveal a finished screenshot in Explorer. The path comes from the renderer,
 * so it is confined to the folder capture:tab writes into -- there is no other
 * place a screenshot can be, and an arbitrary path would otherwise let a
 * compromised chrome point Explorer at anything on the disk.
 */
ipcMain.on('capture:show', (_event, { path: target } = {}) => {
  if (typeof target !== 'string' || !target) return;
  if (!isInsideDownloads(target)) return;
  shell.showItemInFolder(target);
});

// ---------------------------------------------------------------------------
// Permissions
//
// Electron grants every permission request by default, which would make this
// the most generous browser on the machine. Harmless, user-initiated things
// are allowed silently; the ones that reach hardware, location or the
// clipboard are asked about once per origin; everything else is denied.
// ---------------------------------------------------------------------------

/**
 * Allowed with no prompt: all of these need a user gesture anyway.
 *
 * The two storage-access entries are the Storage Access API, and they are here
 * because anything NOT in this set and not in PERMISSION_PHRASES below is
 * denied outright with no prompt and no trace on screen. X needs it twice
 * over: the twitter.com -> x.com identity bridge, and the embedded Google and
 * Apple sign-in frames, both call document.requestStorageAccess() and both get
 * a silent no today -- which reads as a sign-in that simply does not work.
 * Chrome's own answer to the same call is a grant after a user gesture, which
 * is all a click on a sign-in button is.
 */
const PERMISSIONS_ALWAYS_ALLOW = new Set([
  'fullscreen',
  'pointerLock',
  'clipboard-sanitized-write',
  'window-placement',
  'window-management',
  'keyboardLock',
  'storage-access',
  'top-level-storage-access',
]);

/** Worth interrupting for. Anything not here and not above is denied. */
const PERMISSION_PHRASES = {
  geolocation: 'know your location',
  notifications: 'send you notifications',
  midi: 'use your MIDI devices',
  midiSysex: 'use your MIDI devices, including system messages',
  'display-capture': 'share your screen',
  'idle-detection': 'know when you are inactive',
  'clipboard-read': 'read your clipboard',
  openExternal: 'open another app',
};

/** 'origin|permission' -> boolean, remembered for the rest of the run. */
const permissionDecisions = new Map();

/** 'origin|permission' -> in-flight promise, so one dialog serves every ask. */
const permissionPending = new Map();

function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return '';
  }
}

/**
 * Decisions outlive the run: <userData>/permissions.json holds
 * { origin: { permission: 'allow' | 'block' } }. Same best-effort, lazily
 * resolved path as window-state.json -- a missing or corrupt file just means
 * nothing has been decided yet, and a failed write never escapes a handler.
 */
function permissionsPath() {
  return path.join(app.getPath('userData'), 'permissions.json');
}

/** Everything that can actually raise a dialog, in the order they are listed. */
const PERMISSION_PROMPT_LIST = ['media', ...Object.keys(PERMISSION_PHRASES)];

/** Prompting + silently-allowed names: the only keys the store will accept. */
const KNOWN_PERMISSIONS = new Set([...PERMISSION_PROMPT_LIST, ...PERMISSIONS_ALWAYS_ALLOW]);

/** An origin we are willing to key a decision on: parses, and is http(s). */
function validOrigin(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  return url.origin;
}

/** Fold the file back into the Map, dropping anything no longer meaningful. */
function loadPermissionDecisions() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(permissionsPath(), 'utf8'));
  } catch {
    return; // no file yet, unreadable, or not JSON -- nothing is remembered
  }
  if (!parsed || typeof parsed !== 'object') return;
  for (const [rawOrigin, perms] of Object.entries(parsed)) {
    const origin = validOrigin(rawOrigin);
    if (!origin || !perms || typeof perms !== 'object') continue;
    for (const [permission, decision] of Object.entries(perms)) {
      if (!KNOWN_PERMISSIONS.has(permission)) continue;
      if (decision !== 'allow' && decision !== 'block') continue;
      permissionDecisions.set(origin + '|' + permission, decision === 'allow');
    }
  }
}

/** The Map, written back out as { origin: { permission: decision } }. */
function savePermissionDecisions() {
  try {
    const out = {};
    for (const [key, allowed] of permissionDecisions) {
      const cut = key.lastIndexOf('|');
      if (cut <= 0) continue;
      const origin = key.slice(0, cut);
      // A guest on an opaque origin ('' or 'null') can still be asked about,
      // but there is nothing stable to remember it under.
      if (!validOrigin(origin)) continue;
      (out[origin] = out[origin] || {})[key.slice(cut + 1)] = allowed ? 'allow' : 'block';
    }
    fs.writeFileSync(permissionsPath(), JSON.stringify(out, null, 2));
  } catch {
    // A disk error must never take down a dialog callback or an IPC handler.
  }
}

/** Every explicit decision for one origin: { permission: 'allow'|'block' }. */
function permissionsForOrigin(origin) {
  const out = {};
  const prefix = origin + '|';
  for (const [key, allowed] of permissionDecisions) {
    if (!key.startsWith(prefix)) continue;
    out[key.slice(prefix.length)] = allowed ? 'allow' : 'block';
  }
  return out;
}

/** The one place a decision is written, so file and Map cannot drift apart. */
function rememberPermission(origin, permission, allowed) {
  permissionDecisions.set(origin + '|' + permission, allowed);
  savePermissionDecisions();
}

/** What the user recognises: the host, not the whole origin. */
function originLabel(origin) {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin || 'This page';
  }
}

/** The '<host> wants to …' clause for one request. */
function permissionPhrase(permission, details) {
  if (permission === 'media') {
    const types = (details && details.mediaTypes) || [];
    const wants = [];
    if (types.includes('video')) wants.push('camera');
    if (types.includes('audio')) wants.push('microphone');
    // Chrome asks for both when the page did not say which.
    if (!wants.length) wants.push('camera', 'microphone');
    return 'use your ' + wants.join(' and ');
  }
  if (permission === 'openExternal') {
    const external = details && details.externalURL;
    const scheme = external ? String(external).split(':')[0] : '';
    return scheme ? 'open a ' + scheme + ': link in another app' : 'open another app';
  }
  return PERMISSION_PHRASES[permission] || 'use ' + permission;
}

/** The small print under the question: the exact target, where we have one. */
function permissionDetail(permission, origin, details) {
  if (permission === 'openExternal' && details && details.externalURL) {
    return String(details.externalURL).slice(0, 200);
  }
  return (origin || 'This page') + ' — blocked unless you allow it.';
}

/**
 * Resolve to the user's answer, asking at most once per origin+permission and
 * coalescing simultaneous asks (a page calling getUserMedia twice must not
 * stack two dialogs).
 */
function askPermission(origin, permission, details) {
  const key = origin + '|' + permission;
  // "Open other apps" is asked every time: one remembered Allow would turn a
  // site into a permanent launcher for any protocol handler on the machine.
  if (permission !== 'openExternal' && permissionDecisions.has(key)) {
    return Promise.resolve(permissionDecisions.get(key));
  }
  const pending = permissionPending.get(key);
  if (pending) return pending;

  const w = liveWin();
  if (!w) return Promise.resolve(false); // nothing to parent a dialog to

  const promise = dialog
    .showMessageBox(w, {
      type: 'question',
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Permission request',
      message: originLabel(origin) + ' wants to ' + permissionPhrase(permission, details),
      detail: permissionDetail(permission, origin, details),
    })
    .then((result) => {
      const allowed = result.response === 0;
      if (permission !== 'openExternal') rememberPermission(origin, permission, allowed);
      return allowed;
    })
    .catch(() => false) // a dialog that failed to show is not consent
    .finally(() => permissionPending.delete(key));

  permissionPending.set(key, promise);
  return promise;
}

/** getURL() throws on a destroyed webContents; never let that reach Electron. */
function safeUrl(contents) {
  try {
    return contents && !contents.isDestroyed() ? contents.getURL() : '';
  } catch {
    return '';
  }
}

/** Set once installClientHintFix() has taken the one onBeforeSendHeaders slot. */
let clientHintsFixed = false;

/* Watch's hover preview (watch/preview.js): the Referer YouTube's embed needs from a file://
   page. Only the embed frame Watch's own page asks for gets one; see embedReferer(). */
let WatchPreview = null;
try { WatchPreview = require('./watch/preview'); } catch (err) { WatchPreview = null; }

/*
 * The other half of the Chrome-only User-Agent (see chromeOnlyUserAgent()).
 *
 * A modern Chromium sends its identity TWICE: the UA string, and the
 * Sec-CH-UA client-hint header. Electron's brand list is
 * `"Chromium";v="152", "Electron";v="44", "Not_A Brand";v="24"` and
 * Sec-CH-UA-Full-Version-List carries the full Electron version beside it.
 * Rewriting only the UA string therefore makes things WORSE for a site that
 * cross-checks the two -- the string now claims plain Chrome while the hints
 * still say Electron, which is the signature of a spoofed client. X's login
 * endpoints do exactly that check, so both have to agree.
 *
 * Electron allows ONE listener per webRequest event per session, and the
 * Ghostery adapter already owns onBeforeRequest and onHeadersReceived (see the
 * ad-blocking section). onBeforeSendHeaders is free and nothing else in the app
 * touches it -- the flag above keeps it that way even if this is reached twice.
 *
 * Every request in the browser goes through this callback, so it is written to
 * be incapable of stalling one: the whole body is inside a try/catch, the
 * catch passes the ORIGINAL headers straight through, and callback() is reached
 * on every path. Headers other than the three named here are untouched, except
 * one: a Referer is ADDED to the YouTube embed frame Watch's own page asks for
 * (its hover preview), which a file:// page cannot send (watch/preview.js).
 */
function installClientHintFix(sess) {
  if (clientHintsFixed) return;
  const brands =
    '"Chromium";v="' + CHROME_MAJOR + '", ' +
    '"Google Chrome";v="' + CHROME_MAJOR + '", ' +
    '"Not_A Brand";v="24"';

  try {
    sess.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
      const requestHeaders = (details && details.requestHeaders) || {};
      try {
        for (const key of Object.keys(requestHeaders)) {
          const lower = key.toLowerCase();
          if (lower === 'sec-ch-ua') {
            // Only ever REWRITTEN, never added: Chromium sends this on secure
            // contexts only, and inventing it elsewhere is its own tell.
            requestHeaders[key] = brands;
            continue;
          }
          if (lower === 'sec-ch-ua-full-version-list') {
            // Chrome sends it; there is no honest value for it here, and an
            // absent hint is normal (the site can ask for it again).
            delete requestHeaders[key];
            continue;
          }
          const value = Array.isArray(requestHeaders[key])
            ? requestHeaders[key].join(' ')
            : String(requestHeaders[key] == null ? '' : requestHeaders[key]);
          if (!value.includes('Electron')) continue;
          // A UA that still names Electron gets CORRECTED rather than dropped:
          // a request with no User-Agent at all is more suspicious, not less.
          if (lower === 'user-agent') requestHeaders[key] = app.userAgentFallback;
          else delete requestHeaders[key];
        }
        const embedRef = WatchPreview ? WatchPreview.embedReferer(details) : '';
        if (embedRef) requestHeaders.Referer = embedRef;
      } catch (err) {
        console.error('[ua] client-hint rewrite skipped for', (details && details.url) || '?', '-', (err && err.message) || err);
        return callback({ requestHeaders: (details && details.requestHeaders) || {} });
      }
      callback({ requestHeaders });
    });
    clientHintsFixed = true;
  } catch (err) {
    // Loud on purpose: silently keeping the Electron brands means X's sign-in
    // stays broken with nothing on screen to say why.
    console.error('[ua] could not install the client-hint fix; Sec-CH-UA still says Electron:', (err && err.message) || err);
  }
}

/**
 * Webviews carry no `partition` attribute, so every guest page shares
 * session.defaultSession -- the same session downloads and permissions hang
 * off here.
 */
/** A hidden Watch reader (watch-main.js); never throws, and false for anything else. */
function isWatchReader(contents) {
  try { return !!(contents && typeof watch.isReaderContents === 'function' && watch.isReaderContents(contents)); } catch { return false; }
}

function attachSessionHandlers() {
  const sess = session.defaultSession;
  if (!sess) return;

  installClientHintFix(sess);

  sess.on('will-download', handleWillDownload);

  sess.setPermissionRequestHandler((contents, permission, callback, details) => {
    // Watch's hidden readers never prompt and never get anything: a dialog for a page the user
    // cannot see would make their answer stick for their real tabs of that site.
    if (isWatchReader(contents)) return callback(false);
    // An app link from Lumen's player layer (a page or a sheet): stopped, said and counted there.
    if (permission === 'openExternal' && watchPlayer && typeof watchPlayer.refuseExternal === 'function' && watchPlayer.refuseExternal(contents, details)) return callback(false);
    if (PERMISSIONS_ALWAYS_ALLOW.has(permission)) return callback(true);
    const prompts = permission === 'media' || permission in PERMISSION_PHRASES;
    if (!prompts) return callback(false);

    const origin = originOf(safeUrl(contents) || (details && details.requestingUrl));
    askPermission(origin, permission, details).then(
      (allowed) => callback(allowed),
      () => callback(false)
    );
  });

  // A check must give the same answer a request would, or a site sees itself
  // as granted and then silently fails.
  sess.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (isWatchReader(contents)) return false;
    if (PERMISSIONS_ALWAYS_ALLOW.has(permission)) return true;
    const origin = originOf(
      requestingOrigin || (details && details.requestingUrl) || safeUrl(contents)
    );
    const decision = permissionDecisions.get(origin + '|' + permission);
    return decision === true;
  });
}

// ---------------------------------------------------------------------------
// Certificate errors
//
// The default answer stays "reject": nothing here grants an exception, and
// there is no UI to click through one. All we do is REMEMBER which origins
// failed, so site info can say why the padlock is off instead of reporting a
// plain https URL as fine.
// ---------------------------------------------------------------------------

/** Origins whose certificate Chromium refused at least once this run. */
const certErrors = new Set();

app.on('certificate-error', (_event, _contents, url, _error, _certificate, callback) => {
  const origin = originOf(url);
  if (origin) certErrors.add(origin);
  // No preventDefault(), so Electron applies its own verdict (reject) and
  // ignores this callback -- answering false keeps that explicit either way.
  callback(false);
});

// ---------------------------------------------------------------------------
// Ad blocking
//
// The ad-block engine owns session.defaultSession's onBeforeRequest and
// onHeadersReceived hooks (registered by adblock-hooks.js, once), so every
// <webview> guest is filtered by the one engine -- there is nothing per-tab to
// wire up. Ours besides: the persisted preferences (on/off + a per-site
// allowlist), the per-tab "blocked" counters the chrome shows, and keeping the
// filter lists fresh (adblock-refresh.js; the cache never refreshed itself).
//
// Cosmetic filtering (hiding the container an ad would have filled) needs a
// preload inside every guest frame. We do NOT reach for will-attach-webview for
// that -- that hook deliberately strips any preload a PAGE asks for, and must
// keep doing so. adblock-hooks.js registers the library's own preload at the
// SESSION level instead, which is a separate mechanism and reaches every
// frame including guests.
// ---------------------------------------------------------------------------

const { ElectronBlocker, NetworkFilter } = require('@ghostery/adblocker-electron');
const adblockRefresh = require('./adblock-refresh');
const { createAdblockHooks } = require('./adblock-hooks');

/**
 * Serialized engine. First run fetches the lists; later runs load this, and
 * the refresher (adblock-refresh.js) rewrites it once a day.
 */
function adblockCachePath() {
  return path.join(app.getPath('userData'), 'adblock-engine.bin');
}

/** { filters, updatedAt } of the cache, so the shrink check need not re-count it. */
function adblockMetaPath() {
  return path.join(app.getPath('userData'), 'adblock-engine.json');
}

/*
 * Test profiles only (never read without --test-profile), so an e2e run can
 * drive a refresh against a local list server:
 *   QUARTZ_ADBLOCK_LIST_BASE      the list host, in place of Ghostery's
 *   QUARTZ_ADBLOCK_REFRESH_FORCE  1 = refresh even though the cache is fresh
 *   QUARTZ_ADBLOCK_REFRESH_DELAY  ms before the first check (default 30 s)
 *   QUARTZ_ADBLOCK_RETRY_MS       ms before a retry after a failure (default 1 h)
 */
const ADBLOCK_TEST = process.argv.includes('--test-profile');
function adblockTestEnv(name) {
  return ADBLOCK_TEST ? (process.env[name] || '') : '';
}

/**
 * What the shield popover says about the lists. `loadError` is set when the
 * engine could not be built at startup at all (the refresher keeps trying).
 */
let adblockLists = { updatedAt: 0, checkedAt: 0, refreshing: false, error: '', filters: 0, loadError: '' };

/** The one refresher, started by initAdblock() once the startup engine is settled. */
let adblockRefresher = null;

/** { enabled, allow } -- same lazy-path, best-effort style as window-state. */
function adblockPrefsPath() {
  return path.join(app.getPath('userData'), 'adblock.json');
}

/** @type {import('@ghostery/adblocker-electron').ElectronBlocker | null} */
let blocker = null;

/** True only while the engine is actually hooked into the session. */
let blockingOn = false;

let adblockPrefs = { enabled: true, allow: [] };

/**
 * host -> the ids of the exception filters we pushed into the engine for it.
 * Belongs to the engine in `blocker`: a refreshed engine gets a new map built
 * by finishEngine(), assigned in the same step as the engine itself.
 */
let allowFilterIds = new Map();

/** webContents id -> { blocked, host } for the page currently loaded there. */
const adblockCounts = new Map();

/**
 * A hostname the allowlist can be keyed on: lowercase, no scheme, no port or
 * path, and no leading `www.` so example.com and www.example.com are one site.
 */
function normaliseHost(value) {
  if (typeof value !== 'string') return '';
  let host = value.trim().toLowerCase();
  if (!host) return '';
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      return '';
    }
  }
  host = host.split('/')[0].split('@').pop().split(':')[0];
  return host.replace(/^www\./, '');
}

function isAllowedHost(host) {
  return !!host && adblockPrefs.allow.includes(host);
}

function readAdblockPrefs() {
  const fallback = { enabled: true, allow: [] };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(adblockPrefsPath(), 'utf8'));
  } catch {
    return fallback; // no file yet, unreadable, or not JSON -- blocking is on
  }
  if (!parsed || typeof parsed !== 'object') return fallback;
  const allow = Array.isArray(parsed.allow)
    ? [...new Set(parsed.allow.map(normaliseHost).filter(Boolean))]
    : [];
  return { enabled: parsed.enabled !== false, allow };
}

function saveAdblockPrefs() {
  try {
    fs.writeFileSync(adblockPrefsPath(), JSON.stringify(adblockPrefs, null, 2));
  } catch {
    // A disk error must never take down an IPC handler.
  }
}

/**
 * Two exception rules per allowlisted host, because one does not cover both
 * halves of the blocker:
 *   @@*$domain=host   -- lets every SUBRESOURCE the page requests through.
 *                        (@@||host^$document does NOT: this engine matches one
 *                        request at a time and keeps no page state, so a
 *                        $document exception only ever matches the main
 *                        document, which is never blocked in the first place.)
 *   @@||host^$elemhide -- stops the cosmetic rules from hiding anything.
 */
function allowRulesFor(host) {
  return [`@@*$domain=${host}`, `@@||${host}^$elemhide`];
}

/** Push `host`'s exception filters into `engine`, recording their ids in `ids`. */
function applyAllowRuleTo(engine, ids, host) {
  if (!engine || ids.has(host)) return;
  const filters = allowRulesFor(host)
    .map((raw) => NetworkFilter.parse(raw))
    .filter(Boolean);
  if (!filters.length) return;
  engine.update({ newNetworkFilters: filters });
  ids.set(host, filters.map((filter) => filter.getId()));
}

function applyAllowRule(host) {
  applyAllowRuleTo(blocker, allowFilterIds, host);
}

function removeAllowRule(host) {
  const ids = allowFilterIds.get(host);
  if (!blocker || !ids) return;
  allowFilterIds.delete(host);
  blocker.update({ removedNetworkFilters: ids });
}

/**
 * Exceptions that are on whatever the user's allowlist says, because blocking
 * these does not remove an ad -- it stalls the page that asked for them.
 *
 * YouTube's SPA waits on its own first-party calls before a click turns into a
 * playing video: /youtubei/v1/* is the player API (log_event included) and
 * /api/stats/* is the playback telemetry the ad check rides on. The prebuilt
 * ads+tracking lists cancel two of them outright
 * (||youtube.com^/youtubei/v1/log_event and ||youtube.com^/api/stats/ads?), and
 * a cancelled fetch there is what leaves the player spinning until the document
 * is reloaded. Ad DELIVERY is untouched: youtube.com/pagead/, doubleclick.net
 * and the rest still block exactly as before.
 *
 * X (x.com / twitter.com) is the same shape and the reason sign-in failed.
 * Its onboarding flow is a chain of POSTs to /i/api/1.1/onboarding/task.json
 * with GraphQL calls under /i/api/graphql/ and the OAuth2 guest token from
 * /i/api/2/oauth2/ alongside -- and in the privacy lists those paths sit right
 * next to X's analytics paths, so a rule broad enough to catch the analytics
 * catches the login with it. Cancel any one of them and the form answers
 * "Could not log you in now", or just stops responding, or shows a
 * verification step that can never finish because the call behind it never
 * lands. abs.twimg.com is where the onboarding JS and its assets come from;
 * api.x.com carries the same endpoints for the social sign-in popups.
 *
 * Only the sign-in path is excepted. X's pure telemetry -- /i/jot,
 * /i/api/1.1/jot, /i/csp_report, /9/measurement/ -- is deliberately NOT listed
 * and still blocks, and so does every ad host.
 */
const UNBREAK_FILTERS = [
  '@@||youtube.com/youtubei/',
  '@@||youtube.com/api/stats/',
  '@@||x.com/i/api/1.1/onboarding/',
  '@@||x.com/i/api/graphql/',
  '@@||x.com/i/api/1.1/graphql/',
  '@@||x.com/i/api/2/oauth2/',
  '@@||twitter.com/i/api/1.1/onboarding/',
  '@@||api.x.com/1.1/onboarding/',
  '@@||api.twitter.com/1.1/onboarding/',
  '@@||abs.twimg.com/',
  '@@||api.x.com/oauth2/',
];

/**
 * Applied once when the engine is built; nothing in the UI turns these off.
 *
 * NetworkFilter.parse() answers null for anything it cannot read, and a bare
 * .filter(Boolean) would drop that rule without a word -- leaving a site broken
 * for a reason nothing on screen or in the log could explain. Every failure is
 * named instead.
 */
function applyUnbreakRules(engine) {
  if (!engine) return;
  const filters = [];
  for (const raw of UNBREAK_FILTERS) {
    const parsed = NetworkFilter.parse(raw);
    if (parsed) filters.push(parsed);
    else console.error('[adblock] unbreak filter did not parse, so it is NOT applied:', raw);
  }
  if (filters.length) engine.update({ newNetworkFilters: filters });
}

/*
 * YouTube's player is built from the JSON its own SPA fetches, and the ads
 * lists rewrite that JSON inside the page.
 *
 * The prebuilt ads+tracking list carries SCRIPTLET rules for youtube.com --
 * json-prune, replace-fetch-response, prevent-xhr -- which the library injects
 * into the page with webContents.executeJavaScript to strip the ad fields out
 * of the player response. On a full document load that lands before the player
 * exists and YouTube copes. After an IN-PAGE click there is no new document:
 * the SPA asks for the next video over the fetch the scriptlet has patched,
 * gets a rewritten body back, and the player never initialises -- ytd-player is
 * in the DOM, #movie_player is not, and no <video> is ever created. Reloading
 * the same URL plays it, which is exactly the "it only loads once I reload"
 * this was reported as. Some of those injections also lose the race against the
 * navigation and reject ("Script failed to execute"), so how much of the
 * response got rewritten differs from load to load.
 *
 * Measured live (port 9441, in-page clicks from a search results page, 20 s a
 * round): stock = 0 of 5 rounds played; exceptions for every URL the engine
 * blocked on the way = 0 of 3; @@||youtube.com^$document = 0 of 3; blocking off
 * altogether = 3 of 3; scriptlets off for youtube.com = 5 of 5. So the cosmetic
 * scriptlets are the cause, not the cancelled requests.
 *
 * Only the scriptlets go. The cosmetic CSS still hides the ad shelves and every
 * network rule still blocks, so ad DELIVERY is no less blocked than before --
 * an in-stream ad can still play, which the reload path already did too.
 *
 * x.com and twitter.com are here for the same failure, on the same mechanism.
 * X's login is a same-document SPA: typing a username POSTs to
 * /i/api/1.1/onboarding/task.json over window.fetch, reads the next step out
 * of the JSON that comes back, and repeats for the password and for any
 * verification step. json-prune / replace-fetch-response / prevent-xhr patch
 * exactly that fetch and XMLHttpRequest, so an onboarding reply comes back
 * with fields rewritten or missing and the flow dead-ends -- "Could not log
 * you in now", a form that no longer responds, or a verification step that
 * never completes. There is no document load to reload past, which is why X
 * never recovered the way YouTube did.
 *
 * disneyplus.com is here for the same mechanism, in its player. The list carries
 * two json-prune rules for it (stream.insertion.adSession, stream.insertion.points,
 * stream.insertion, stream.sources.*.insertion, pods.0.ads; and ads.metadata,
 * ads.document, ads.dxc, ads.live, ads.vod), which patch JSON.parse in the page
 * so the playback answer Disney+'s player is built from comes back with those
 * fields gone. Play is an in-page move to /play/<id> on a same-document SPA,
 * and Disney+'s own code sends a player that fails to start back to /home with
 * nothing on screen. The user's report (11-06): Play, from Lumen or from Disney+'s
 * own home page, "just kept going back to the Disney home page". Same trade as
 * YouTube: the network rules still block, only the in-page rewriting goes.
 */
const SCRIPTLET_FREE_HOSTS = ['youtube.com', 'x.com', 'twitter.com', 'disneyplus.com'];

function scriptletsAllowedOn(url) {
  const host = hostOfUrl(url);
  if (!host) return true;
  return !SCRIPTLET_FREE_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

/**
 * Dropped at the lookup, not at the injection: the engine still answers with
 * its cosmetic CSS for the page and the adapter simply gets an empty script
 * list, so it never calls executeJavaScript on the guest. Wrapping the lookup
 * keeps this independent of when the adapter chooses to inject.
 */
function dropScriptletsOnBrokenHosts(engine) {
  if (!engine) return;
  const inner = engine.getCosmeticsFilters.bind(engine);
  engine.getCosmeticsFilters = (args) => {
    const result = inner(args);
    if (result && Array.isArray(result.scripts) && result.scripts.length
        && !scriptletsAllowedOn((args && args.url) || '')) {
      return { ...result, scripts: [] };
    }
    return result;
  };
}

function adblockState() {
  const state = {
    enabled: adblockPrefs.enabled,
    ready: !!blocker && blockingOn,
    allow: [...adblockPrefs.allow],
    // When the lists in use were downloaded, whether a refresh is running,
    // and the plain reason the last one (or the startup load) failed.
    lists: {
      updatedAt: adblockLists.updatedAt,
      refreshing: adblockLists.refreshing,
      error: adblockLists.error,
      loadError: blocker ? '' : adblockLists.loadError,
    },
  };
  // The hook counters (calls per type, time in each hook): the shield puts them
  // on its status line, and an e2e run measures them. A small object, built
  // only when the state is sent, never per request.
  state.hooks = adblockHooks.stats();
  return state;
}

/**
 * The session hooks (webRequest, the cosmetic preload, its two IPC channels)
 * are registered once and always call the engine in `blocker` -- see
 * adblock-hooks.js for why that, and not Ghostery's enableBlockingInSession.
 * It also keeps the guard that stops the cosmetic stylesheet being injected
 * into our own file:// chrome.
 */
const adblockHooks = createAdblockHooks({
  ipcMain,
  preloadPath: path.resolve(require.resolve('@ghostery/adblocker-electron-preload')),
  getBlocker: () => blocker,
  log: (line) => { if (qlog) qlog.log.line(line); else console.log('[adblock] ' + line); },
});

function setBlockingEnabled(on) {
  const sess = session.defaultSession;
  if (!blocker || !sess) {
    blockingOn = false;
    return;
  }
  if (on && !blockingOn) {
    adblockHooks.enable(sess);
    blockingOn = true;
  } else if (!on && blockingOn) {
    try {
      adblockHooks.disable();
    } catch {
      // Already gone; the flag below is what the rest of the app reads.
    }
    blockingOn = false;
  }
}

/**
 * Everything Quartz adds to a raw engine, in one place so the startup engine
 * and every refreshed one get exactly the same: the blocked-count listener,
 * no scriptlets on the hosts they break, the always-on unbreak exceptions,
 * and the user's per-site allowlist. Returns the allowlist's filter ids, which
 * belong to this engine.
 */
function finishEngine(engine) {
  engine.on('request-blocked', (request) => {
    // request.tabId is the webContents id of the frame that made the request.
    countBlocked(request && request.tabId);
  });
  dropScriptletsOnBrokenHosts(engine);
  applyUnbreakRules(engine);
  const ids = new Map();
  for (const host of adblockPrefs.allow) applyAllowRuleTo(engine, ids, host);
  return ids;
}

/**
 * Put a refreshed engine in use. finishEngine() runs first, on the new engine
 * only, so a throw there leaves the old one untouched. The swap itself is two
 * assignments in one synchronous step: the hooks read `blocker` on every call,
 * so no request ever sees a missing or doubled listener, and an allowlist edit
 * cannot land between the two (IPC runs on this same thread).
 */
function installRefreshedEngine(next) {
  const ids = finishEngine(next);
  blocker = next;
  allowFilterIds = ids;
  // Startup failed (offline on a first run): blocking starts now.
  if (!blockingOn) setBlockingEnabled(adblockPrefs.enabled);
}

/**
 * Builds a fresh engine in adblock-build-worker.js and hands back its bytes
 * and filter count. The worker gets 3 minutes and a heap cap; past either it
 * is stopped and the refresh fails with that reason.
 */
function buildEngineInWorker({ countPrev }) {
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const worker = new Worker(path.join(__dirname, 'adblock-build-worker.js'), {
      workerData: {
        kind: 'quartz-adblock-build',
        listBase: adblockTestEnv('QUARTZ_ADBLOCK_LIST_BASE'),
        cachePath: adblockCachePath(),
        countPrev,
        timeoutMs: 60 * 1000,
      },
      resourceLimits: { maxOldGenerationSizeMb: 768 },
    });
    const timer = setTimeout(() => {
      done(reject, adblockRefresh.wordsError('the update took longer than 3 minutes'));
      worker.terminate().catch(() => {});
    }, 3 * 60 * 1000);
    worker.once('message', (msg) => {
      if (msg && msg.ok) done(resolve, { bytes: msg.bytes, filters: msg.filters, prevFilters: msg.prevFilters });
      else done(reject, adblockRefresh.wordsError((msg && msg.words) || 'the update stopped without saying why'));
      worker.terminate().catch(() => {});
    });
    worker.once('error', (err) => {
      const oom = err && /ERR_WORKER_OUT_OF_MEMORY|heap/i.test(String(err.code || err.message));
      done(reject, oom ? adblockRefresh.wordsError('the new lists needed too much memory') : err);
    });
    worker.once('exit', (code) => done(reject, adblockRefresh.wordsError('the update stopped (exit ' + code + ')')));
  });
}

function startAdblockRefresher() {
  if (adblockRefresher) return;
  const delay = Number(adblockTestEnv('QUARTZ_ADBLOCK_REFRESH_DELAY'));
  const retry = Number(adblockTestEnv('QUARTZ_ADBLOCK_RETRY_MS'));
  adblockRefresher = adblockRefresh.createRefresher({
    force: adblockTestEnv('QUARTZ_ADBLOCK_REFRESH_FORCE') === '1',
    firstDelayMs: delay >= 0 && adblockTestEnv('QUARTZ_ADBLOCK_REFRESH_DELAY') ? delay : undefined,
    retryMs: retry > 0 ? retry : undefined,
    cacheMtime: async () => {
      try { return (await fs.promises.stat(adblockCachePath())).mtimeMs; } catch { return 0; }
    },
    readMeta: async () => JSON.parse(await fs.promises.readFile(adblockMetaPath(), 'utf8')),
    writeMeta: (meta) => fs.promises.writeFile(adblockMetaPath(), JSON.stringify(meta)),
    build: buildEngineInWorker,
    deserialize: (bytes) => ElectronBlocker.deserialize(new Uint8Array(bytes)),
    save: (bytes) => adblockRefresh.writeAtomic(fs.promises, adblockCachePath(), bytes),
    install: installRefreshedEngine,
    onState: (s) => {
      adblockLists = Object.assign({}, adblockLists, s);
      if (blocker) adblockLists.loadError = '';
      send('adblock:state-changed', adblockState());
    },
    log: (line) => { if (qlog) qlog.log.line(line); else console.log('[adblock] ' + line); },
  });
  adblockRefresher.start().catch(() => {});
  // The hook counters, once per run, so the cost of the hooks is on record.
  app.once('will-quit', () => {
    try {
      const words = adblockHooks.summaryWords();
      if (words && qlog) qlog.log.line(words);
    } catch { /* the log may already be closed */ }
  });
}

/**
 * Built once at startup and never awaited by window creation: a first run has
 * to fetch ~3 MB of filter lists, and the browser must be usable meanwhile.
 * Offline with no cache leaves the engine null -- the shield says so with the
 * reason, and the refresher keeps trying (hourly) to build one.
 *
 * The startup engine always comes off the cache when there is one, however
 * old: freshness is the refresher's job, in the background, after startup.
 */
async function initAdblock() {
  adblockPrefs = readAdblockPrefs();
  // For quartz.log: how long the engine took, and whether it came off disk.
  const t0 = Date.now();
  let fromCache = false;
  try { fromCache = fs.existsSync(adblockCachePath()); } catch { /* unknown: says downloaded */ }
  let engine = null;
  try {
    engine = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: adblockCachePath(),
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
  } catch (err) {
    const reason = (err && err.message) || String(err);
    console.error('[adblock] engine unavailable:', reason);
    blocker = null;
    adblockLists.loadError = adblockRefresh.failureWords(err);
    // Not qlog.adblock({ ok: false }): its line says "until Quartz starts
    // again", and the refresher below now retries without a restart.
    if (qlog) {
      qlog.log.line('The ad blocker could not load (' + adblockRefresh.oneLine(reason, 160)
        + '); pages load with no blocking until it can. It tries again shortly, then every hour.');
    }
    send('adblock:state-changed', adblockState());
    startAdblockRefresher();
    return;
  }
  if (qlog) qlog.adblock({ ok: true, ms: Date.now() - t0, fromCache, enabled: adblockPrefs.enabled });

  allowFilterIds = finishEngine(engine);
  blocker = engine;
  setBlockingEnabled(adblockPrefs.enabled);
  send('adblock:state-changed', adblockState());
  startAdblockRefresher();
}

function hostOfUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function countBlocked(wcId) {
  if (!Number.isInteger(wcId)) return;
  const entry = adblockCounts.get(wcId) || { blocked: 0, host: '' };
  entry.blocked += 1;
  adblockCounts.set(wcId, entry);
  queueAdblockUpdate(wcId);
}

/** A page load blocks in bursts; the chrome only needs a few repaints a second. */
const ADBLOCK_MIN_INTERVAL = 250;

/** webContents id -> { last, timer } */
const adblockSendState = new Map();

function sendAdblockUpdate(wcId) {
  const entry = adblockCounts.get(wcId);
  if (!entry) return;
  send('adblock:update', {
    wcId,
    blocked: entry.blocked,
    host: entry.host,
    allowed: isAllowedHost(entry.host),
  });
}

/**
 * At most one immediate send plus one trailing send per 250 ms window, so <= 4
 * messages/sec per tab. The trailing send reads the counter at fire time, so
 * the last value always arrives even though the ones in between are dropped.
 */
function queueAdblockUpdate(wcId) {
  let st = adblockSendState.get(wcId);
  if (!st) {
    st = { last: 0, timer: null };
    adblockSendState.set(wcId, st);
  }
  if (st.timer) return;
  const wait = ADBLOCK_MIN_INTERVAL - (Date.now() - st.last);
  if (wait <= 0) {
    st.last = Date.now();
    sendAdblockUpdate(wcId);
    return;
  }
  st.timer = setTimeout(() => {
    st.timer = null;
    st.last = Date.now();
    sendAdblockUpdate(wcId);
  }, wait);
}

function forgetAdblockTab(wcId) {
  adblockCounts.delete(wcId);
  const st = adblockSendState.get(wcId);
  if (st && st.timer) clearTimeout(st.timer);
  adblockSendState.delete(wcId);
}

// The shield asks for the state when its panel opens: that is also when the
// hook counters go to quartz.log (on demand, at most once every 15 minutes,
// on top of the one line at quit), so the log has the numbers the user saw.
let adblockHooksLoggedAt = 0;
ipcMain.handle('adblock:state', () => {
  const t = Date.now();
  if (qlog && t - adblockHooksLoggedAt >= 15 * 60 * 1000) {
    try {
      const words = adblockHooks.summaryWords();
      if (words) { qlog.log.line(words); adblockHooksLoggedAt = t; }
    } catch { /* the log is optional */ }
  }
  return adblockState();
});

ipcMain.handle('adblock:count', (_event, payload) => {
  const wcId = payload && payload.wcId;
  const entry = adblockCounts.get(wcId) || { blocked: 0, host: '' };
  return { blocked: entry.blocked, host: entry.host, allowed: isAllowedHost(entry.host) };
});

ipcMain.on('adblock:set-enabled', (_event, payload) => {
  const on = !!(payload && payload.on);
  adblockPrefs.enabled = on;
  saveAdblockPrefs();
  setBlockingEnabled(on);
  send('adblock:state-changed', adblockState());
});

ipcMain.on('adblock:allow-host', (_event, payload) => {
  const host = normaliseHost(payload && payload.host);
  if (!host) return;
  const on = !!(payload && payload.on);
  const index = adblockPrefs.allow.indexOf(host);
  if (on && index === -1) {
    adblockPrefs.allow.push(host);
    applyAllowRule(host);
  } else if (!on && index !== -1) {
    adblockPrefs.allow.splice(index, 1);
    removeAllowRule(host);
  }
  saveAdblockPrefs();
  send('adblock:state-changed', adblockState());
});

// ---------------------------------------------------------------------------
// Site info
//
// What sits behind the padlock for the page in the active tab: how the
// connection is secured, which permissions this origin has been explicitly
// granted or denied, and the two destructive actions (forget the permissions,
// clear the site's data). A guest page can inspect none of this itself.
//
// Every handler answers with { error: string } instead of throwing: a popover
// in the chrome must never be able to reject into the renderer.
// ---------------------------------------------------------------------------

/** Everything clearStorageData() can drop for one origin. */
const CLEARABLE_STORAGES = [
  'cookies',
  'localstorage',
  'indexdb',
  'serviceworkers',
  'cachestorage',
  'websql',
];

/** Loopback http IS a secure context in Chromium; do not call it 'http'. */
function isLoopbackHost(host) {
  const h = String(host || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

/** { secure, reason } for one already-parsed URL. */
function securityOf(url) {
  const scheme = url.protocol.replace(':', '');
  if (scheme === 'https') {
    return certErrors.has(url.origin)
      ? { secure: false, reason: 'certificate' }
      : { secure: true, reason: 'https' };
  }
  if (scheme === 'http') {
    return isLoopbackHost(url.hostname)
      ? { secure: true, reason: 'local' }
      : { secure: false, reason: 'http' };
  }
  // Pages that never crossed a network: our own chrome, a local file, a blob.
  if (['file', 'about', 'data', 'blob', 'chrome'].includes(scheme)) {
    return { secure: true, reason: 'local' };
  }
  return { secure: false, reason: 'other' };
}

/** The message for an { error } reply, without leaking a stack at the UI. */
function errorText(err) {
  return String((err && err.message) || err || 'failed');
}

ipcMain.handle('site:info', (_event, payload) => {
  try {
    let url;
    try {
      url = new URL(String((payload && payload.url) || ''));
    } catch {
      return { error: 'invalid url' };
    }
    const origin = validOrigin(url.href);
    const { secure, reason } = securityOf(url);
    return {
      origin: origin || url.origin,
      host: url.hostname,
      scheme: url.protocol.replace(':', ''),
      secure,
      reason,
      // Only what was actually decided -- an absent name means "still asks".
      permissions: origin ? permissionsForOrigin(origin) : {},
      promptable: [...PERMISSION_PROMPT_LIST],
    };
  } catch (err) {
    return { error: errorText(err) };
  }
});

ipcMain.handle('site:set-permission', (_event, payload) => {
  try {
    const origin = validOrigin(payload && payload.origin);
    if (!origin) return { error: 'invalid origin' };
    const permission = String((payload && payload.permission) || '');
    if (!KNOWN_PERMISSIONS.has(permission)) return { error: 'unknown permission' };
    const decision = String((payload && payload.decision) || '');
    if (decision !== 'allow' && decision !== 'block' && decision !== 'ask') {
      return { error: 'invalid decision' };
    }

    if (decision === 'ask') {
      // Forgetting is not the same as blocking: the next request prompts again.
      permissionDecisions.delete(origin + '|' + permission);
      savePermissionDecisions();
    } else {
      rememberPermission(origin, permission, decision === 'allow');
    }
    send('site:permissions-changed', { origin });
    return permissionsForOrigin(origin);
  } catch (err) {
    return { error: errorText(err) };
  }
});

ipcMain.handle('site:reset-permissions', (_event, payload) => {
  try {
    const origin = validOrigin(payload && payload.origin);
    if (!origin) return { error: 'invalid origin' };
    const prefix = origin + '|';
    for (const key of [...permissionDecisions.keys()]) {
      if (key.startsWith(prefix)) permissionDecisions.delete(key);
    }
    savePermissionDecisions();
    send('site:permissions-changed', { origin });
    return permissionsForOrigin(origin); // {}
  } catch (err) {
    return { error: errorText(err) };
  }
});

/**
 * The domains a cookie for this host could have been stored under: the host
 * itself, and its parent domain when there is one (a cookie set for
 * `.example.com` by www.example.com belongs to no single origin).
 */
function cookieDomainsFor(host) {
  const labels = String(host || '')
    .split('.')
    .filter(Boolean);
  if (!labels.length) return [];
  const domains = [labels.join('.')];
  if (labels.length > 2) domains.push(labels.slice(1).join('.'));
  return domains;
}

ipcMain.handle('site:clear-data', async (_event, payload) => {
  try {
    const origin = validOrigin(payload && payload.origin);
    if (!origin) return { error: 'invalid origin' };
    const sess = session.defaultSession;
    if (!sess) return { error: 'no session' };

    // The cookie jar is walked FIRST, and by hand: clearStorageData({ origin })
    // matches scheme+host+port exactly, so a domain cookie set for
    // `.example.com` would survive it -- and anything it did drop could no
    // longer be counted. Host and parent domain both.
    const host = new URL(origin).hostname;
    const seen = new Set();
    let cookiesRemoved = 0;
    for (const domain of cookieDomainsFor(host)) {
      let cookies = [];
      try {
        cookies = await sess.cookies.get({ domain });
      } catch {
        cookies = []; // a jar we cannot read is not a reason to fail the clear
      }
      for (const cookie of cookies) {
        const bare = String(cookie.domain || host).replace(/^\./, '');
        const cookiePath = cookie.path || '/';
        const key = bare + cookiePath + '|' + cookie.name;
        if (seen.has(key)) continue; // the parent query re-lists the host's own
        seen.add(key);
        const url = (cookie.secure ? 'https://' : 'http://') + bare + cookiePath;
        try {
          await sess.cookies.remove(url, cookie.name);
          cookiesRemoved += 1;
        } catch {
          // Already gone, or not ours to remove -- do not count it.
        }
      }
    }

    // Then everything else the origin owns -- plus any cookie the walk above
    // could not name.
    await sess.clearStorageData({ origin, storages: CLEARABLE_STORAGES });
    return { cookiesRemoved };
  } catch (err) {
    return { error: errorText(err) };
  }
});

// ---------------------------------------------------------------------------
// Shortcuts that must survive page focus
//
// A key pressed while focus sits inside a <webview> never reaches our renderer:
// the guest page consumes it first. So intercept in the main process and
// forward the intent to the chrome renderer. Without this, Ctrl+` fails exactly
// when you'd want it -- while you are actually reading a page.
// ---------------------------------------------------------------------------

/**
 * What each key means, keyed by combo. This is only the built-in default: the
 * renderer owns the real map (shortcuts.js) and mirrors it over 'shortcuts:set'
 * at boot and after every change, so these entries are what a renderer that
 * never sends would get.
 *
 * A combo reads Ctrl, Alt, then Shift, letters uppercase, and the UNSHIFTED
 * character of a punctuation key -- see comboFromInput() below.
 */
const DEFAULT_BINDINGS = {
  'Ctrl+`': 'toggle-terminal',
  'Ctrl+T': 'new-tab',
  'Ctrl+Shift+T': 'reopen-tab',
  'Ctrl+W': 'close-tab',
  'Ctrl+L': 'focus-omnibox',
  'Ctrl+=': 'zoom-in',
  'Ctrl+Shift+=': 'zoom-in', // the '+' key, which needs Shift on a US layout
  'Ctrl+-': 'zoom-out',
  'Ctrl+0': 'zoom-reset',
  'Ctrl+F': 'find',
  'Ctrl+J': 'downloads',
  'Ctrl+K': 'command-palette',
  'Ctrl+Shift+K': 'ask-claude',
  'Ctrl+H': 'history',
  'Ctrl+D': 'bookmark',
  'Ctrl+,': 'settings',
  'Ctrl+R': 'reload',
  'Ctrl+Shift+R': 'reader',
  'Ctrl+Shift+A': 'tabsearch',
  'Ctrl+Shift+S': 'capture',
  'Ctrl+Shift+B': 'bookmarks-bar',
  'Ctrl+\\': 'split',
  'Ctrl+Shift+\\': 'claude-split',
  // Alt+Arrow is history navigation in every browser, and the page eats it.
  'Alt+Left': 'back',
  'Alt+Right': 'forward',
};

let keyBindings = DEFAULT_BINDINGS;

/**
 * The renderer's map, whenever it changes. Anything that is not a plain object
 * of string -> string is ignored, and so is one that leaves nothing usable:
 * main keeps what it already had rather than losing every page-focus shortcut
 * to a single bad payload.
 */
ipcMain.on('shortcuts:set', (_event, payload) => {
  const next = payload && payload.bindings;
  if (!next || typeof next !== 'object' || Array.isArray(next)) return;
  const clean = Object.create(null);
  let count = 0;
  for (const combo of Object.keys(next)) {
    const action = next[combo];
    if (typeof combo !== 'string' || typeof action !== 'string') continue;
    if (!combo || !action) continue;
    clean[combo] = action;
    count += 1;
  }
  if (!count || count > 200) return; // a real map has a few dozen entries
  keyBindings = clean;
});

/** A modifier pressed on its own is never a combo. */
const MODIFIER_KEYS = {
  Control: 1, Ctrl: 1, Alt: 1, AltGraph: 1, Shift: 1, Meta: 1,
  OS: 1, CapsLock: 1, NumLock: 1, ScrollLock: 1, Dead: 1, Unidentified: 1,
};

/** input.key spellings -> the canonical name a combo is written with. */
const NAMED_KEYS = {
  ArrowLeft: 'Left', Left: 'Left',
  ArrowRight: 'Right', Right: 'Right',
  ArrowUp: 'Up', Up: 'Up',
  ArrowDown: 'Down', Down: 'Down',
  PageUp: 'PageUp', PageDown: 'PageDown',
  Home: 'Home', End: 'End',
  Tab: 'Tab', Enter: 'Enter', Return: 'Enter',
  ' ': 'Space', Space: 'Space', Spacebar: 'Space',
  Backspace: 'Backspace',
  Delete: 'Delete', Del: 'Delete',
  Insert: 'Insert',
  Escape: 'Escape', Esc: 'Escape',
};

/**
 * Shifted characters, back to the key actually pressed. Bindings are written in
 * unshifted terms ('Ctrl+Shift+\', never 'Ctrl+|'), so the Shift has to come
 * out of the character and go into the modifier list.
 */
const UNSHIFTED_CHARS = {
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6',
  '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[',
  '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
};

/**
 * An Electron `before-input-event` input object -> the combo string the binding
 * map is keyed by. Must agree with shortcuts.js's own fromMainInput(): the two
 * sides meet only through these strings, so the tables above are a copy of the
 * ones in shortcuts.js and have to move together.
 */
function comboFromInput(input) {
  const key = String((input && input.key) || '');
  if (!key) return '';
  if (Object.prototype.hasOwnProperty.call(MODIFIER_KEYS, key)) return '';
  let name = key;
  let shift = !!input.shift;

  if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, key)) {
    name = NAMED_KEYS[key]; // ArrowLeft -> Left, ' ' -> Space
  } else if (Object.prototype.hasOwnProperty.call(UNSHIFTED_CHARS, key)) {
    name = UNSHIFTED_CHARS[key]; // the character itself is proof Shift was down
    shift = true;
  } else if (key.length === 1) {
    name = key.toUpperCase();
  }

  const parts = [];
  if (input.control) parts.push('Ctrl');
  if (input.alt) parts.push('Alt');
  if (shift) parts.push('Shift');
  parts.push(name);
  return parts.join('+');
}

/**
 * Keys that mean something with no modifier at all. Escape is the odd one out:
 * it is mirrored to the chrome (to close the find bar) but never swallowed,
 * because the page still needs it.
 */
const BARE_KEYS = {
  F5: 'reload',
  F11: 'fullscreen',
  Escape: 'escape',
};

/**
 * Punctuation keys where Shift only changes the character printed. Bindings are
 * written unshifted ('Ctrl+='), so a shifted press of the same physical key --
 * which arrives as '+' and canonicalises to 'Ctrl+Shift+=' -- falls back to the
 * unshifted binding. shortcuts.js's actionFor() does exactly this for the
 * chrome; without the same tolerance here the '+' key would zoom only while the
 * chrome had focus and do nothing inside a page.
 */
const PUNCTUATION_KEYS = {
  ',': 1, '.': 1, '/': 1, '\\': 1, '=': 1, '-': 1, '`': 1, '[': 1, ']': 1, ';': 1, "'": 1,
};

/** A combo -> the bound action id, or null. Exact match first. */
function bindingFor(combo) {
  if (!combo) return null;
  if (Object.prototype.hasOwnProperty.call(keyBindings, combo)) return keyBindings[combo];
  // An exact match always wins above, which is what keeps Ctrl+Shift+\ apart
  // from Ctrl+\; only an unclaimed shifted punctuation combo falls back.
  if (combo.indexOf('Shift+') < 0) return null;
  const key = combo.slice(combo.lastIndexOf('+') + 1);
  if (!Object.prototype.hasOwnProperty.call(PUNCTUATION_KEYS, key)) return null;
  const bare = combo.replace('Shift+', '');
  return Object.prototype.hasOwnProperty.call(keyBindings, bare) ? keyBindings[bare] : null;
}

/** A key pressed inside a page -> the chrome action it means, or null. */
function shortcutFor(input) {
  const key = String(input.key);
  // Fixed cases, in front of the binding map because they are not rebindable.
  if (input.control && !input.alt) {
    if (key === 'Tab') return { action: input.shift ? 'prev-tab' : 'next-tab' };
    if (/^[1-9]$/.test(key)) return { action: 'select-tab', index: Number(key) };
  }
  // Ctrl+Alt+1..9 is the workspace counterpart, fixed for the same reason:
  // app.js resolves it structurally, so it is absent from bindings() and would
  // otherwise be lost whenever a <webview> holds the keyboard.
  if (input.control && input.alt && !input.shift && /^[1-9]$/.test(key)) {
    return { action: 'select-workspace', index: Number(key) };
  }
  // Ctrl+Alt+W opens Watch. app.js hardcodes it (shortcuts.js does not name
  // it), so without this it would be lost whenever a page holds the keyboard.
  if (input.control && input.alt && !input.shift && key.toLowerCase() === 'w') {
    return { action: 'watch' };
  }
  // Everything else is whatever the renderer has bound the combo to.
  const action = bindingFor(comboFromInput(input));
  return typeof action === 'string' && action ? { action } : null;
}

// ---------------------------------------------------------------------------
// Guest context menu
//
// A <webview> has no menu of its own, and the built-in `role:` entries act on
// the focused *window*, not the guest -- so every item here calls the guest's
// own webContents method explicitly.
// ---------------------------------------------------------------------------

/** navigationHistory is the current API; the old methods are the fallback. */
function navHistory(contents) {
  return contents.navigationHistory || null;
}

function guestCanGoBack(contents) {
  const nav = navHistory(contents);
  if (nav && typeof nav.canGoBack === 'function') return nav.canGoBack();
  return typeof contents.canGoBack === 'function' ? contents.canGoBack() : false;
}

function guestCanGoForward(contents) {
  const nav = navHistory(contents);
  if (nav && typeof nav.canGoForward === 'function') return nav.canGoForward();
  return typeof contents.canGoForward === 'function' ? contents.canGoForward() : false;
}

function guestGoBack(contents) {
  const nav = navHistory(contents);
  if (nav && typeof nav.goBack === 'function') nav.goBack();
  else if (typeof contents.goBack === 'function') contents.goBack();
}

function guestGoForward(contents) {
  const nav = navHistory(contents);
  if (nav && typeof nav.goForward === 'function') nav.goForward();
  else if (typeof contents.goForward === 'function') contents.goForward();
}

/** Flatten non-empty groups into one template, separated. */
function joinMenuGroups(groups) {
  const template = [];
  for (const group of groups) {
    if (!group || !group.length) continue;
    if (template.length) template.push({ type: 'separator' });
    template.push(...group);
  }
  return template;
}

/** A destroyed guest throws on every getter; a menu must never take it down. */
function safeUrlOf(contents) {
  try { return contents.getURL() || ''; } catch (err) { return ''; }
}

function safeTitleOf(contents) {
  try { return contents.getTitle() || ''; } catch (err) { return ''; }
}

/** Menu labels are one line: collapse the selection and cap it at 30 chars. */
function selectionLabel(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 30 ? flat.slice(0, 30) + '…' : flat;
}

function guestMenuTemplate(contents, params) {
  const navigation = [
    { label: 'Back', enabled: guestCanGoBack(contents), click: () => guestGoBack(contents) },
    {
      label: 'Forward',
      enabled: guestCanGoForward(contents),
      click: () => guestGoForward(contents),
    },
    { label: 'Reload', click: () => contents.reload() },
  ];

  const link = [];
  if (params.linkURL) {
    link.push(
      {
        label: 'Open link in new tab',
        click: () => send('open-url', { url: params.linkURL, background: true }),
      },
      { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
      { label: 'Save link as', click: () => contents.downloadURL(params.linkURL) }
    );
  }

  const image = [];
  if (params.mediaType === 'image' && params.srcURL) {
    image.push(
      {
        label: 'Open image in new tab',
        click: () => send('open-url', { url: params.srcURL, background: true }),
      },
      { label: 'Copy image', click: () => contents.copyImageAt(params.x, params.y) },
      { label: 'Save image', click: () => contents.downloadURL(params.srcURL) }
    );
  }

  const selection = [];
  const selected = String(params.selectionText || '').trim();
  if (selected) {
    selection.push(
      { label: 'Copy', click: () => contents.copy() },
      {
        // The search engine is a renderer setting (settings.js), so main
        // cannot name it here. It sends the raw text as `search` and app.js
        // builds the URL with the chosen engine; `url` stays as the Google
        // fallback for a renderer that does not read `search`.
        label: 'Search for "' + selectionLabel(selected) + '"',
        click: () =>
          send('open-url', {
            url: 'https://www.google.com/search?q=' + encodeURIComponent(selected),
            search: selected,
            background: false,
          }),
      }
    );
  }

  // The gesture this browser exists for: hand what you are looking at to a
  // Claude Code session standing next to it. Main only carries the facts --
  // app.js opens the chamber and, for the "Ask"/"Show" items, composes the
  // prompt and pastes it into the chamber's INPUT, where it waits for the
  // user's own question. Nothing is ever executed from here.
  const askUrl = params.pageURL || safeUrlOf(contents);
  const askTitle = safeTitleOf(contents);
  const ask = [];
  // Just the chamber, split beside the page this menu was raised on; no prompt.
  ask.push({
    label: 'Open Claude beside this page',
    click: () => send('ask-claude', { url: askUrl, title: askTitle, selection: '', mode: 'beside' }),
  });
  if (selected) {
    ask.push({
      label: 'Ask Claude about "' + selectionLabel(selected) + '"',
      click: () => send('ask-claude', { url: askUrl, title: askTitle, selection: selected }),
    });
  }
  ask.push({
    label: 'Ask Claude about this page',
    click: () => send('ask-claude', { url: askUrl, title: askTitle, selection: '' }),
  });
  // The same hand-off with the page's picture attached: the renderer takes the
  // screenshot (capturePage belongs to the guest, and capture:tab already does
  // it) and pastes the file's path, which Claude Code can open.
  ask.push({
    label: 'Show Claude this page',
    click: () =>
      send('ask-claude', { url: askUrl, title: askTitle, selection: '', mode: 'screenshot' }),
  });

  const editing = [];
  if (params.isEditable) {
    const flags = params.editFlags || {};
    // Autocorrect per site, where the user is typing. Keyed on the PAGE's
    // host, so a reply box in an iframe follows the site it sits on.
    const siteHost = normaliseHost(hostOfUrl(params.pageURL || safeUrlOf(contents)) || '');
    if (siteHost) {
      const off = spell.isSiteOff(siteHost);
      editing.push({
        label: off ? 'Turn autocorrect back on for ' + siteHost : 'Turn off autocorrect on ' + siteHost,
        click: () => spell.setSiteOff(siteHost, !off),
      });
    }
    editing.push(
      { label: 'Undo', enabled: flags.canUndo !== false, click: () => contents.undo() },
      { label: 'Redo', enabled: flags.canRedo !== false, click: () => contents.redo() },
      { label: 'Cut', enabled: flags.canCut !== false, click: () => contents.cut() },
      { label: 'Copy', enabled: flags.canCopy !== false, click: () => contents.copy() },
      { label: 'Paste', enabled: flags.canPaste !== false, click: () => contents.paste() },
      { label: 'Select all', click: () => contents.selectAll() }
    );
  }

  const inspect = [
    {
      label: 'Inspect',
      click: () => {
        contents.inspectElement(params.x, params.y);
        // inspectElement does not raise devtools that are already open.
        if (contents.isDevToolsOpened() && contents.devToolsWebContents) {
          contents.devToolsWebContents.focus();
        }
      },
    },
  ];

  // Selection items sit above editing ones so Copy-the-selection is not buried
  // under the edit block in a textarea.
  return joinMenuGroups([spellingMenuItems(contents, params), navigation, link, image, selection, ask, editing, inspect]);
}

/**
 * The spelling block on top of a right-click on an underlined word: up to five
 * suggestions (replaceMisspelling swaps the word under the caret through the
 * page's own editing path, so editors see it as an edit), then Add to
 * dictionary (kept, in spell.json and Chromium's own list) and Ignore (this
 * run only). Empty when the word under the pointer is not flagged.
 */
function spellingMenuItems(contents, params) {
  const word = params && typeof params.misspelledWord === 'string' ? params.misspelledWord.trim() : '';
  if (!word) return [];
  const items = [];
  const suggestions = Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions.slice(0, 5) : [];
  for (const s of suggestions) {
    items.push({ label: s, click: () => contents.replaceMisspelling(s) });
  }
  if (!suggestions.length) items.push({ label: 'No suggestions', enabled: false });
  items.push({ type: 'separator' });
  items.push({ label: 'Add "' + selectionLabel(word) + '" to dictionary', click: () => spell.addWord(word) });
  items.push({ label: 'Ignore', click: () => spell.ignoreWord(word) });
  return items;
}

/**
 * TEST RUNS ONLY (--test-profile AND --menu-dump): write the menu that would
 * have opened to userData/menu-dump.json instead of popping it, so a check can
 * prove what is in it without ever putting a native menu on the user's screen.
 * Returns true when it dumped (the caller then does not pop anything).
 */
const MENU_DUMP = process.argv.includes('--test-profile') && process.argv.includes('--menu-dump');
function dumpMenu(where, template) {
  if (!MENU_DUMP) return false;
  const flat = template.map((item) => (item.type === 'separator' ? '---' : (item.label || item.role || '?') + (item.enabled === false ? ' (disabled)' : '')));
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'menu-dump.json'), JSON.stringify({ where, at: Date.now(), items: flat }, null, 2));
  } catch (err) {
    console.error('[menu-dump] could not write:', err.message);
  }
  // The dumped template stays reachable from main's inspector, so a harness
  // can click an item exactly as the menu would (bravesearch-e2e.js clicks
  // "Search for"). --test-profile --menu-dump only, like the dump itself.
  global.__quartzLastMenu = template;
  return true;
}

// ---------------------------------------------------------------------------
// Spotify auto-pause IPC
//
// Every call resolves. A bridge that is not running, a scheduled task that is
// missing, a schtasks call that fails -- all of it comes back as plain English
// in `status.error` rather than as a rejected invoke, because the settings pane
// polls these and a throw there would surface as a dead section.
// ---------------------------------------------------------------------------

ipcMain.handle('autopause:status', async () => {
  const status = await autoPause.status();
  await refreshAdDuck(status);
  return withAdDuck(status);
});

ipcMain.handle('autopause:set-enabled', (_event, { on } = {}) => autoPause.setEnabled(!!on));

// The patch is re-validated inside the module (hosts are normalised, junk and
// duplicates dropped, the list capped) -- preload's clamp is the first pass,
// not the only one.
ipcMain.handle('autopause:set-config', (_event, patch = {}) => autoPause.setConfig(patch));

ipcMain.handle('autopause:doctor', () => autoPause.doctor());

// ---------------------------------------------------------------------------
// Now playing, and the bridge's ad ducking
//
// Spotify cannot play inside a tab (no Widevine), so the new tab page instead
// shows what is playing on the MACHINE and drives it. The same local bridge
// autopause.js already talks to holds a WinRT SMTC session manager and answers
// three more routes for us:
//
//   GET  /now?art=0 | ?artHash=<h>   what is playing (art omitted / unchanged)
//   POST /control   {"cmd":...}      play | pause | toggle | next | prev
//   GET/POST /config {"adDuck":...}  the ad-ducking switch and its level
//
// Rules the whole section keeps:
//   - the CHROME only. A <webview> guest that guessed the channel name would
//     otherwise be able to drive the user's music and read their listening.
//   - every answer is a value. A bridge that is not installed, not running, or
//     simply slow comes back as { ok: false, reason } in plain English, exactly
//     like the auto-pause calls above, because the new tab polls these.
//   - 1500 ms, end to end. This is a loopback call on a single-threaded
//     PowerShell listener: worth waiting for, never worth a stall.
//   - port discovery is autopause.js's, cache and all (its client is the one
//     thing this file reaches past the public four for). A failed call forgets
//     the cached port so the NEXT call re-probes the range rather than spending
//     this one's budget on a second attempt.
// ---------------------------------------------------------------------------

/** One loopback round trip's whole budget. */
const MEDIA_TIMEOUT_MS = 1500;

/** Everything SMTC gives us a Try*Async for. 'previous' is accepted as 'prev'. */
const MEDIA_CMDS = ['play', 'pause', 'toggle', 'next', 'prev'];

/** A command from the page -> one of MEDIA_CMDS, or null. Pure. */
function normaliseMediaCmd(value) {
  const cmd = String(value == null ? '' : value).trim().toLowerCase();
  if (cmd === 'previous') return 'prev';
  return MEDIA_CMDS.indexOf(cmd) === -1 ? null : cmd;
}

/**
 * What to ask /now for. Pure, and the whole art protocol in one place:
 *   undefined / null -> '/now?art=0'          the cheap poll, no art bytes
 *   ''               -> '/now'                "send me the art, I have none"
 *   '<hash>'         -> '/now?artHash=<hash>' art only if it is not that one
 * A hash that is not a plain token is treated as no hash at all rather than
 * pasted into the query.
 */
function nowRoute(artHash) {
  if (artHash == null) return '/now?art=0';
  const hash = String(artHash).trim();
  if (!hash) return '/now';
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(hash)) return '/now?art=0';
  return '/now?artHash=' + encodeURIComponent(hash);
}

/**
 * An ad-duck patch from the page -> what the bridge will accept. Pure.
 * The bridge clamps level to 0..0.2 itself; doing it here too means the value
 * the settings pane sees back is the value it asked for.
 */
function normaliseAdDuck(patch) {
  const src = patch && typeof patch === 'object' ? patch : {};
  let level = Number(src.level);
  if (!Number.isFinite(level)) level = 0;
  level = Math.round(Math.min(0.2, Math.max(0, level)) * 1000) / 1000;
  return { enabled: src.enabled === true, level };
}

/**
 * One request at the bridge. Resolves { ok: true, json } or { ok: false, reason }
 * and never rejects; `deps.http` exists so a harness can drive the error mapping
 * with a fake.
 */
function bridgeJson(port, method, route, bodyText, timeoutMs, deps) {
  const lib = (deps && deps.http) || http;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const payload = bodyText == null ? null : Buffer.from(String(bodyText), 'utf8');
    const options = { host: '127.0.0.1', port, path: route, method, timeout: timeoutMs };
    if (payload) {
      options.headers = { 'content-type': 'application/json', 'content-length': payload.length };
    }
    let req;
    try {
      req = lib.request(options, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          done({ ok: false, reason: 'The bridge answered ' + res.statusCode });
          return;
        }
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
          // Cover art is a base64 jpeg, so this reply is bigger than a status
          // one -- but nothing the bridge sends is megabytes.
          if (text.length > 4 * 1024 * 1024) { req.destroy(); done({ ok: false, reason: 'The bridge sent too much' }); }
        });
        res.on('end', () => {
          try { done({ ok: true, json: JSON.parse(text) }); }
          catch { done({ ok: false, reason: 'The bridge sent something that is not JSON' }); }
        });
        res.on('error', () => done({ ok: false, reason: 'The bridge reply was cut off' }));
      });
    } catch {
      done({ ok: false, reason: 'The bridge could not be reached' });
      return;
    }
    req.on('timeout', () => { req.destroy(); done({ ok: false, reason: 'The bridge did not answer in time' }); });
    req.on('error', () => done({ ok: false, reason: 'The bridge is not running' }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** The port the auto-pause client last saw, probing the range only if it has none. */
async function bridgeMediaPort() {
  const client = autoPause && autoPause._bridge;
  if (!client) return null;
  if (typeof client.port === 'number') return client.port;
  const found = await client.discover().catch(() => null);
  return found && typeof found.port === 'number' ? found.port : null;
}

/**
 * A bridge route, from discovery to parsed document. The bridge's own
 * { ok: false, reason } answers (SMTC missing, 'held', 'bad cmd') come straight
 * back; everything that goes wrong on our side becomes one of the same shape.
 */
async function bridgeCall(method, route, bodyObject) {
  const port = await bridgeMediaPort();
  if (port == null) return { ok: false, reason: 'The Spotify bridge is not running' };
  const body = bodyObject == null ? null : JSON.stringify(bodyObject);
  const answer = await bridgeJson(port, method, route, body, MEDIA_TIMEOUT_MS);
  if (!answer.ok) {
    // It may simply have moved ports (a restart picks the first free one).
    try { autoPause._bridge.forget(); } catch { /* harness client, or none */ }
    return { ok: false, reason: answer.reason };
  }
  if (!answer.json || typeof answer.json !== 'object') {
    return { ok: false, reason: 'The bridge sent something unexpected' };
  }
  return answer.json;
}

ipcMain.handle('media:now', async (event, artHash) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
  return bridgeCall('GET', nowRoute(artHash), null);
});

ipcMain.handle('media:control', async (event, cmd) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
  const clean = normaliseMediaCmd(typeof cmd === 'string' ? cmd : (cmd && cmd.cmd));
  if (!clean) return { ok: false, reason: 'bad cmd' };
  return bridgeCall('POST', '/control', { cmd: clean });
});

/**
 * The bridge's ad ducking, which turns Spotify's volume down for an ad instead
 * of pausing it. The switch lives in the settings pane next to auto-pause, so
 * its state has to ride along with autopause:status -- and autopause.js's own
 * parser drops every field it does not use. Hence the cache: one extra GET
 * /config per status poll at most, reused for a few seconds, because the value
 * only changes when someone flips the switch (here, or by hand in the config).
 */
let lastAdDuck = null;
let lastAdDuckAt = 0;
const AD_DUCK_MAX_AGE_MS = 3000;

/** Decorate an auto-pause status with what we last knew about ducking. No I/O. */
function withAdDuck(status) {
  if (!status || typeof status !== 'object') return status;
  return Object.assign({}, status, { adDuck: lastAdDuck });
}

/** Refresh that cache, but only when the bridge is up and the value is stale. */
async function refreshAdDuck(status) {
  if (!status || status.bridge !== 'running' || typeof status.port !== 'number') {
    lastAdDuck = null;
    return;
  }
  if (lastAdDuck && Date.now() - lastAdDuckAt < AD_DUCK_MAX_AGE_MS) return;
  const answer = await bridgeJson(status.port, 'GET', '/config', null, MEDIA_TIMEOUT_MS);
  const duck = answer.ok && answer.json ? answer.json.adDuck : null;
  if (duck && typeof duck === 'object') {
    lastAdDuck = duck;
    lastAdDuckAt = Date.now();
  }
}

/**
 * Set it. { ok: true, adDuck } from the bridge (its own normalised view, which
 * also refreshes the cache above) or { ok: false, reason }.
 */
ipcMain.handle('spotify:set-ad-duck', async (event, patch) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
  const src = patch && typeof patch === 'object' && patch.adDuck ? patch.adDuck : patch;
  const answer = await bridgeCall('POST', '/config', { adDuck: normaliseAdDuck(src) });
  if (answer && answer.ok === true && answer.adDuck && typeof answer.adDuck === 'object') {
    lastAdDuck = answer.adDuck;
    lastAdDuckAt = Date.now();
  }
  return answer;
});

// ---------------------------------------------------------------------------
// New tab system stats
//
// Ref-counted, so a renderer that subscribes twice has to unsubscribe twice.
// A renderer that goes away without balancing its subscribes (a reload, a
// crash, the window closing) would otherwise pin the sampler on forever, so
// its whole count is dropped the moment its webContents is destroyed.
// ---------------------------------------------------------------------------

ipcMain.on('stats:subscribe', (event) => {
  const contents = event.sender;
  if (!contents || contents.isDestroyed()) return;
  if (!statsWatched.has(contents.id)) {
    statsWatched.add(contents.id);
    const id = contents.id;
    contents.once('destroyed', () => {
      statsWatched.delete(id);
      stats.drop(id);
    });
  }
  stats.subscribe(contents);
});

ipcMain.on('stats:unsubscribe', (event) => {
  const contents = event.sender;
  if (!contents) return;
  stats.unsubscribe(contents);
});

/** How many pids one end-task call may carry. A list, never a sweep. */
const END_TASK_MAX_PIDS = 64;

/**
 * End the processes behind one row of the new tab page's process table.
 *
 * Killing a process is the one thing in this file a page must never be able to
 * ask for on its own, so the gate is deliberately narrow:
 *   - only the chrome's own webContents may call it (a <webview> guest, a
 *     devtools page or anything else is answered with an empty array),
 *   - at most END_TASK_MAX_PIDS integers, junk entries dropped,
 *   - the refusals themselves (self, protected, pid 0/4) live in stats.js.
 * A build whose stats.js predates endTask() answers 'unavailable' rather than
 * throwing, so the page can show a reason instead of a dead button.
 */
ipcMain.handle('stats:end-task', (event, pids) => {
  const contents = event.sender;
  if (!contents || !canSend() || contents !== win.webContents) return [];

  const list = [];
  if (Array.isArray(pids)) {
    for (const raw of pids) {
      const pid = Number(raw);
      if (!Number.isInteger(pid) || pid < 0) continue;
      if (list.indexOf(pid) === -1) list.push(pid);
      if (list.length >= END_TASK_MAX_PIDS) break;
    }
  }
  if (!list.length) return [];

  const end = typeof stats.endTask === 'function'
    ? stats.endTask.bind(stats)
    : (typeof statsModule.endTask === 'function' ? statsModule.endTask : null);
  if (!end) return list.map((pid) => ({ pid, ok: false, reason: 'unavailable' }));

  try {
    return Promise.resolve(end(list)).then(
      (results) => (Array.isArray(results) ? results : []),
      () => list.map((pid) => ({ pid, ok: false, reason: 'failed' }))
    );
  } catch (err) {
    return list.map((pid) => ({ pid, ok: false, reason: 'failed' }));
  }
});

// ---------------------------------------------------------------------------
// Process icons for the new tab's process table
//
// The page shows the icon of the executable behind each process group. Only the
// chrome may ask (same gate as stats:end-task), the keys it may ask about are
// the sampler's own group keys, and the pids come from the sampler's last
// sample rather than from the renderer -- a page that made a key up gets an
// answer built from no pids, which is a lookup and never a kill.
//
// procicons.js is required LAZILY: a build without the file, or one whose
// create() throws, answers an empty map and the page keeps its neutral glyphs.
// ---------------------------------------------------------------------------

/** How many keys one icon call may carry, and how long each may be. */
const PROC_ICON_MAX_KEYS = 64;
const PROC_ICON_MAX_KEY_LEN = 64;

/** The one instance, built on first use. `null` + tried = "not available". */
let procIcons = null;
let procIconsTried = false;

function procIconsInstance() {
  if (procIconsTried) return procIcons;
  procIconsTried = true;
  try {
    const mod = require('./procicons');
    if (!mod || typeof mod.create !== 'function') return null;
    const lookupPath = (apps && typeof apps.pathForExe === 'function')
      ? (key) => apps.pathForExe(key)
      : null;
    const deps = { app, userDataDir: app.getPath('userData') };
    if (lookupPath) deps.lookupPath = lookupPath;
    procIcons = mod.create(deps);
  } catch {
    procIcons = null;   // missing file, syntax error, a throw in create()
  }
  return procIcons;
}

/** The keys of one icon request, cleaned: strings, deduped, capped. */
function cleanIconKeys(keys) {
  const list = [];
  if (!Array.isArray(keys)) return list;
  for (const raw of keys) {
    if (typeof raw !== 'string') continue;
    const key = raw.trim().toLowerCase();
    if (!key || key.length > PROC_ICON_MAX_KEY_LEN) continue;
    if (list.indexOf(key) !== -1) continue;
    list.push(key);
    if (list.length >= PROC_ICON_MAX_KEYS) break;
  }
  return list;
}

/** `[{ key, pids, self }]` for these keys, out of the sampler's last sample. */
function iconGroupsFor(keys) {
  let top = [];
  try {
    const sample = typeof stats.lastSample === 'function' ? stats.lastSample() : null;
    const procs = (sample && typeof sample === 'object') ? sample.procs : null;
    if (procs && Array.isArray(procs.top)) top = procs.top;
  } catch {
    top = [];
  }
  const byKey = new Map();
  for (const group of top) {
    if (group && typeof group === 'object' && typeof group.key === 'string') {
      byKey.set(group.key, group);
    }
  }
  return keys.map((key) => {
    const group = byKey.get(key);
    const pids = (group && Array.isArray(group.pids)) ? group.pids : [];
    return { key, pids, self: !!(group && group.self) };
  });
}

ipcMain.handle('stats:proc-icons', (event, keys) => {
  if (!isChromeSender(event)) return {};
  const list = cleanIconKeys(keys);
  if (!list.length) return {};

  const icons = procIconsInstance();
  if (!icons || typeof icons.getIcons !== 'function') return {};

  try {
    return Promise.resolve(icons.getIcons(iconGroupsFor(list))).then(
      (map) => (map && typeof map === 'object' ? map : {}),
      () => ({})
    );
  } catch {
    return {};
  }
});

// ---------------------------------------------------------------------------
// Tab favicons: the per-origin cache on disk, and icon fetches for the chrome
//
// faviconstore.js keeps one small icon per origin in userData so a chip shows
// its logo the moment it is built — a tab restored after a restart or born
// asleep has no page to ask. Built on first use, because a test profile
// redirects userData before the window exists. Fetches go through the default
// session (the one the <webview> guests use), so cookies apply; only http(s)
// is fetched, never a third-party favicon service. Chrome sender only.
// ---------------------------------------------------------------------------

let faviconStore = null;
function faviconStoreInstance() {
  if (faviconStore) return faviconStore;
  faviconStore = require('./faviconstore').create({
    dir: app.getPath('userData'),
    fetch: (url, init) => session.defaultSession.fetch(url, Object.assign({ bypassCustomProtocolHandlers: true }, init || {}))
  });
  return faviconStore;
}

ipcMain.handle('favicons:get', (event, origins) => {
  if (!isChromeSender(event)) return {};
  try { return faviconStoreInstance().get(Array.isArray(origins) ? origins.slice(0, 256) : []); } catch { return {}; }
});

ipcMain.on('favicons:put', (event, origin, entry) => {
  if (!isChromeSender(event)) return;
  try { faviconStoreInstance().put(origin, entry); } catch { /* a refused entry is simply not kept */ }
});

ipcMain.handle('favicons:fetch', (event, url) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
  try { return faviconStoreInstance().fetchIcon(typeof url === 'string' ? url.slice(0, 2048) : ''); } catch (err) {
    return { ok: false, reason: String(err && err.message || err) };
  }
});

ipcMain.handle('favicons:describe', (event) => {
  if (!isChromeSender(event)) return null;
  try { return faviconStoreInstance().describe(); } catch { return null; }
});

// ---------------------------------------------------------------------------
// Installed apps (the new tab's dock, the palette's "Open <app>" rows)
//
// Same gate as stats:end-task, and for the same reason: starting a process and
// taking the foreground are the two things a PAGE must never be able to ask
// for. Only the chrome's own webContents is answered -- the new tab page is a
// <webview> guest with no preload, so it reaches these through app.js, which
// has already decided the click was real.
//
// Nothing here can throw at the renderer: every answer is a value, and a
// failure is a { ok: false, reason } the page can show.
// ---------------------------------------------------------------------------

/** True when this IPC call came from the chrome document itself. */
function isChromeSender(event) {
  const contents = event && event.sender;
  return !!contents && canSend() && contents === win.webContents;
}

/** An empty index, for a refused or failed call. */
function emptyAppList() {
  return { builtAt: 0, buildMs: 0, fromCache: false, iconsOmitted: false, counts: { total: 0 }, apps: [] };
}

ipcMain.handle('apps:list', (event) => {
  if (!isChromeSender(event)) return emptyAppList();
  try {
    return apps.list().catch(() => emptyAppList());
  } catch {
    return emptyAppList();
  }
});

ipcMain.handle('apps:refresh', (event) => {
  if (!isChromeSender(event)) return emptyAppList();
  try {
    return apps.refresh().catch(() => emptyAppList());
  } catch {
    return emptyAppList();
  }
});

// Icons travel with apps:list unless the whole set is over the budget; this is
// the per-entry fallback for that case (and for an icon that arrived late).
ipcMain.handle('apps:icon', (event, id) => {
  if (!isChromeSender(event)) return null;
  try {
    return apps.icon(typeof id === 'string' ? id : '').catch(() => null);
  } catch {
    return null;
  }
});

ipcMain.handle('apps:launch', (event, id) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
  try {
    return apps.launch(typeof id === 'string' ? id : '').catch(() => ({ ok: false, reason: 'failed' }));
  } catch {
    return { ok: false, reason: 'failed' };
  }
});

// The cap apps.js applies to the same list, borrowed so a malformed call is
// cut short before it crosses the boundary at all.
const APPS_FOCUS_PID_MAX = Number.isInteger(appsModule.FOCUS_PID_MAX) ? appsModule.FOCUS_PID_MAX : 64;

// The one place in this file that is ALLOWED to steal focus: the user clicked
// a dock tile whose running dot was lit, and "switch to it" is the whole point.
//
// One pid or a LIST of them: a dock tile knows its app by exe name, so it
// sends every pid of that name and apps.js picks the one with the window (an
// Electron app's lowest pid is usually a helper with none). Anything that is
// not a positive integer is dropped here; apps.focus answers 'bad pid' if
// nothing survives.
ipcMain.handle('apps:focus', (event, pid) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
  const raw = Array.isArray(pid) ? pid : [pid];
  const pids = [];
  for (const item of raw) {
    const n = Number(item);
    if (Number.isInteger(n) && n > 0 && pids.length < APPS_FOCUS_PID_MAX) pids.push(n);
  }
  if (!pids.length) return { ok: false, reason: 'bad pid' };
  try {
    return apps.focus(pids).catch(() => ({ ok: false, reason: 'failed' }));
  } catch {
    return { ok: false, reason: 'failed' };
  }
});

// ---------------------------------------------------------------------------
// Native app tabs
//
// The chrome asks for a window to be hosted; embed.js does the Win32. Same gate
// as apps and stats, and for a stronger reason than either: these calls move
// and re-parent OTHER PROGRAMS' windows. Only the chrome document is answered,
// every answer is a value, and nothing here can throw at the renderer.
//
// An hwnd is always a decimal STRING across this boundary (koffi hands out
// BigInt, which has no business in a renderer).
// ---------------------------------------------------------------------------

/** How long embed:open waits for a freshly launched app to draw a window. */
const EMBED_OPEN_TIMEOUT_MS = 20000;

/** How often it looks while waiting. */
const EMBED_OPEN_POLL_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The app index entry behind an id, or null. Never throws. */
async function embedAppEntry(appId) {
  try {
    const idx = await apps.list();
    const list = idx && Array.isArray(idx.apps) ? idx.apps : [];
    return list.find((a) => a && a.id === appId) || null;
  } catch {
    return null;
  }
}

/**
 * How long a window that was there before the launch waits for a freshly
 * launched copy to appear before it is adopted instead.
 *
 * A window the app already had is adopted BEFORE anything is launched, so this
 * is only the late case: the sweep found nothing hostable (a tray icon, a
 * window still hidden), the launch went ahead, and the process it started
 * handed off to a copy that was already running -- nothing new is ever drawn.
 * Waiting the full 20 s for that to not happen would make "open it in a tab"
 * feel broken, so the older window is adopted after this much silence.
 */
const EMBED_OPEN_EXISTING_MS = 4000;

/**
 * Host an app's window in a tab, launching it only if it is not already up.
 * The order matters:
 *   1. sweep the app's existing hostable windows. If it has one, ATTACH IT and
 *      stop -- no launch, no second copy, no window raised in the user's face,
 *   2. otherwise launch it exactly the way the dock does (apps.launch) -- which
 *      hands back the pid when it started the process itself,
 *   3. watch for a window that is either from that pid (or a descendant of it:
 *      launchers and App Execution Aliases draw from a child), or new since the
 *      snapshot and exe-matched,
 *   4. attach the first one that qualifies. If the launch merely handed off to
 *      a copy that was already running, adopt that window; give up at 20 s.
 *
 * Why the pid matters: with two copies of an app running -- or a launcher whose
 * real process is a different exe, or two different apps that share an exe name
 * -- "a window whose exe matches" can easily be the WRONG window. The pid we
 * started is the only unambiguous handle, so it leads.
 *
 * An app with no known exe (a packaged entry whose manifest we could not read)
 * gets the same treatment with the exe filter dropped: any new window from any
 * process. That is loose, but it only runs inside the 20 s window right after
 * the user asked for that app.
 */
/**
 * tabId -> { cancelled } for an embed:open still inside its 20 s wait.
 *
 * Two things need it. A second open for the SAME tab while one is pending would
 * launch a second copy of the app and then attach it -- and attach() detaches
 * whatever that tab already had, so the first app would be handed back to the
 * desktop mid-flight. And a tab CLOSED during the wait must not have a window
 * attached to it afterwards: the detach marks the pending open cancelled, and
 * the winner is thrown away instead of being parented into a tab that is gone.
 */
const embedPending = new Map();

async function embedOpen(tabId, appId) {
  if (!embed.available) return { ok: false, reason: 'unavailable' };
  if (embedPending.has(tabId)) return { ok: false, reason: 'open-pending' };
  const pending = { cancelled: false };
  embedPending.set(tabId, pending);
  try {
    return await embedOpenInner(tabId, appId, pending);
  } finally {
    embedPending.delete(tabId);
  }
}

async function embedOpenInner(tabId, appId, pending) {
  const entry = await embedAppEntry(appId);
  if (!entry) return { ok: false, reason: 'unknown-app' };
  const exe = typeof entry.exe === 'string' && entry.exe ? entry.exe : '';

  const before = embed.findWindows(exe ? { exe } : {});
  const seen = new Set(before.map((w) => w.hwnd));
  // The windows this app ALREADY has, front-most first -- and only when the exe
  // is known: with no exe filter `before` is every window on the desktop, and
  // adopting the front one would host whatever the user happened to be looking at.
  // findWindows already applies the hostable gate, and a window hosted in a tab
  // is a CHILD of ours by then, so it never comes back from the sweep.
  const mine = exe ? before : [];
  const had = mine.length ? mine[0].hwnd : '';
  /** Windows the attach refused, so the loop stops offering them. */
  const refused = new Set();

  // ADOPT FIRST, launch second. Launching always and adopting only after a 4 s
  // silence gets the common cases wrong: after a browser restart the app that
  // survived the quit is still running as a normal window, and Start on the
  // restored tab would launch a SECOND copy and leave the first orphaned on the
  // desktop -- same for "open it in a tab" on a Discord or Spotify that is
  // already up. A launch of a single-instance app also RAISES its window, which
  // must never happen while the user is at the machine. If the app already has a
  // hostable window, that window IS the answer and nothing is started at all.
  if (mine.length) {
    // Belt and braces over the gate above: a window another tab is hosting is
    // never taken from it.
    const hosted = new Set(embed.list().map((w) => String(w.hwnd)));
    for (const w of mine) {
      if (pending.cancelled) return { ok: false, reason: 'cancelled' };
      if (hosted.has(w.hwnd)) { refused.add(w.hwnd); continue; }
      const result = embed.attach({ tabId, hwnd: w.hwnd });
      if (result.ok) {
        embedLog('embed:open matched by adopt-existing', {
          tabId, appId, exe, launchedPid: null,
          hwnd: w.hwnd, pid: w.pid, winExe: w.exe, reason: result.reason || 'ok'
        });
        return result;
      }
      // 'already-attached', 'store-app', or it died between the sweep and the
      // attach: try the next window it has, then fall through to the launch.
      refused.add(w.hwnd);
    }
  }

  const launchedAt = Date.now();
  const started = await apps.launch(appId).catch(() => ({ ok: false, reason: 'failed' }));
  if (!started || started.ok === false) {
    return { ok: false, reason: (started && started.reason) || 'launch-failed' };
  }
  // A number when apps.launch started the process itself (a plain exe or a .lnk
  // resolved to one), null when the shell did it (a Store app, an elevated
  // shortcut). Null just means the pid rule cannot help this launch.
  const launchedPid = Number.isInteger(started.pid) && started.pid > 0 ? started.pid : 0;
  const preferPids = launchedPid ? [launchedPid] : [];

  const deadline = Date.now() + EMBED_OPEN_TIMEOUT_MS;
  const adoptAt = had ? launchedAt + EMBED_OPEN_EXISTING_MS : 0;
  while (Date.now() < deadline) {
    await sleep(EMBED_OPEN_POLL_MS);
    // The wait is awaited, never spun: every other IPC call (embed:list, a
    // layout, a detach) is answered normally while it runs. The process-tree
    // snapshot is warmed the same way, so findWindows never blocks on it.
    if (pending.cancelled) return { ok: false, reason: 'cancelled' };
    // Unconditional: the sweep below asks for a process-tree snapshot for the
    // `since` rule even when there is no pid to prefer, and a snapshot that is
    // not already warm would be read SYNCHRONOUSLY inside findWindows.
    await embed.warmProcessTree().catch(() => null);
    if (pending.cancelled) return { ok: false, reason: 'cancelled' };
    const now = embed.findWindows({ exe: exe || undefined, preferPids, since: launchedAt });
    // (a) it belongs to the process we launched, or a descendant of it, or
    // (b) it was not there before the launch and its exe matches.
    let pick = now.find((w) => w.preferred && !refused.has(w.hwnd));
    let rule = pick ? 'preferred-pid' : '';
    if (!pick) {
      pick = now.find((w) => !seen.has(w.hwnd) && !refused.has(w.hwnd));
      if (pick) rule = 'new-window';
    }
    if (pick) {
      const result = embed.attach({ tabId, hwnd: pick.hwnd });
      if (result.ok || result.reason === 'store-app') {
        embedLog('embed:open matched by ' + rule, {
          tabId, appId, exe: exe || '(any)', launchedPid: launchedPid || null,
          hwnd: pick.hwnd, pid: pick.pid, winExe: pick.exe, reason: result.reason || 'ok'
        });
        // A Store app's frame is refused on purpose; so is a window that died
        // between the sweep and the attach. Both are final answers.
        return result;
      }
      // 'already-attached', or it died between the sweep and the attach: never
      // offer this handle again, or a preferred window would be retried for the
      // whole 20 s.
      refused.add(pick.hwnd);
      seen.add(pick.hwnd);
    }
    // Late adopt. The window this app already had was there before the launch
    // but the attach above could not take it (another tab held it, or it was
    // mid-death), and the launch turned out to be a hand-off to that same copy:
    // no new window is ever coming. Take it now rather than time out -- but
    // only once nothing of this app is still STARTING. A packaged activation
    // takes seconds to draw its window, and adopting the old one while the new
    // copy is on its way is the very bug this rule exists to avoid.
    if (adoptAt && Date.now() >= adoptAt
      && !embed.hasNewProcess({ exe, since: launchedAt })
      && embed.findWindows({ exe: exe || undefined }).some((w) => w.hwnd === had)) {
      const result = embed.attach({ tabId, hwnd: had });
      if (result.ok || result.reason === 'store-app') {
        embedLog('embed:open matched by pre-existing-window', {
          tabId, appId, exe: exe || '(any)', launchedPid: launchedPid || null,
          hwnd: had, reason: result.reason || 'ok'
        });
        return result;
      }
      return result.reason === 'already-attached' ? result : { ok: false, reason: 'no-window' };
    }
  }
  embedLog('embed:open matched nothing', { tabId, appId, exe: exe || '(any)', launchedPid: launchedPid || null });
  return { ok: false, reason: 'no-window' };
}

/**
 * One line per embed:open decision — WHICH rule matched, and the pids behind
 * it. Not gated behind --embed-log: this is one line per deliberate user action,
 * and "it hosted the wrong window" is unanswerable without it.
 */
function embedLog(message, fields) {
  try {
    console.warn('[embed] ' + message + ' ' + JSON.stringify(fields));
  } catch { /* a log line is never worth an exception */ }
}

ipcMain.handle('embed:find', (event, payload) => {
  if (!isChromeSender(event)) return [];
  const req = payload && typeof payload === 'object' ? payload : {};
  try {
    return embed.findWindows({ pid: req.pid, exe: req.exe });
  } catch {
    return [];
  }
});

ipcMain.handle('embed:attach', (event, payload) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
  const req = payload && typeof payload === 'object' ? payload : {};
  try {
    // `mode` is optional and normalised by the engine: a chrome that never
    // mentions it gets embed.js's DEFAULT_MODE, which is the point of having the
    // decision in exactly one place.
    const out = embed.attach({ tabId: req.tabId, hwnd: req.hwnd, mode: req.mode });
    syncNativeFocusPoll();
    return out;
  } catch {
    return { ok: false, reason: 'failed' };
  }
});

ipcMain.handle('embed:open', (event, payload) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
  const req = payload && typeof payload === 'object' ? payload : {};
  const tabId = String(req.tabId == null ? '' : req.tabId);
  const appId = String(req.appId == null ? '' : req.appId);
  if (!tabId || !appId) return { ok: false, reason: 'bad-request' };
  try {
    return embedOpen(tabId, appId)
      .catch(() => ({ ok: false, reason: 'failed' }))
      // Whether it attached or not, the poll's "is anything hosted" answer may
      // have moved -- and this is the one attach that does not come through
      // 'embed:attach'.
      .then((out) => { syncNativeFocusPoll(); return out; });
  } catch {
    return { ok: false, reason: 'failed' };
  }
});

ipcMain.handle('embed:layout', (event, payload) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
  const req = payload && typeof payload === 'object' ? payload : {};
  try {
    // req.rect ONLY: falling back to the payload itself turned a malformed
    // call into a 0x0 rect, which reads as "hide this app's window".
    const box = req.rect && typeof req.rect === 'object' ? req.rect : null;
    if (!box) return { ok: false, reason: 'bad-request' };
    return embed.layout(req.tabId, box, req.visible !== false);
  } catch {
    return { ok: false, reason: 'failed' };
  }
});

ipcMain.handle('embed:detach', (event, payload) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
  const req = payload && typeof payload === 'object' ? payload : {};
  try {
    // A tab closing while its app is still starting: cancel the wait, or the
    // window would be attached to a tab that no longer exists.
    const pending = embedPending.get(String(req.tabId == null ? '' : req.tabId));
    if (pending) pending.cancelled = true;
    const out = embed.detach(req.tabId, { restore: req.restore !== false });
    // A tab switch is a layout() call, but a tab CLOSING is this: take the
    // global keys back before the window it was hosting is even gone.
    syncNativeFocusPoll();
    return out;
  } catch {
    return { ok: false, reason: 'failed' };
  }
});

ipcMain.handle('embed:close', (event, payload) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
  const req = payload && typeof payload === 'object' ? payload : {};
  try {
    const out = embed.close(req.tabId);
    syncNativeFocusPoll();
    return out;
  } catch {
    return { ok: false, reason: 'failed' };
  }
});

ipcMain.handle('embed:list', (event) => {
  if (!isChromeSender(event)) return { available: false, windows: [], stats: null };
  try {
    return { available: !!embed.available, windows: embed.list(), stats: embed.stats() };
  } catch {
    return { available: false, windows: [], stats: null };
  }
});

// ---------------------------------------------------------------------------
// Focus, and the browser's own keys, while an app window is hosted in a tab
//
// Two things break the moment a hosted app takes the keyboard, and both are
// Windows telling the truth:
//
//   1. Electron calls the BrowserWindow BLURRED -- Chromium's HWND really did
//      lose focus -- so everything in the chrome that follows window focus (the
//      idle music's gate above all) behaves as if the user had left the browser. They
//      have not: the window they are typing into is INSIDE it.
//   2. Keystrokes go to the app, not to Chromium, so the browser's own
//      shortcuts are dead until the tab strip is clicked.
//
// embed.focusInfo() answers (1) from Win32 (see embed.js), and a 250 ms poll --
// running ONLY while something is actually hosted -- pushes the answer to the
// chrome as `embed:focus`. (2) is answered by handing a SMALL set of accelerators
// to the OS with globalShortcut, and only for exactly as long as a hosted app
// really holds the keyboard.
// ---------------------------------------------------------------------------

/** How often the focus poll asks Win32. Only while a native tab is attached. */
const NATIVE_FOCUS_POLL_MS = 250;

/**
 * How many consecutive samples must agree before the shortcuts are handed to
 * the OS. Registering is debounced (a 250 ms flap while focus settles must not
 * thrash the global table); UNREGISTERING never is, so a tab switch takes the
 * keys back on the very next tick.
 */
const NATIVE_SHORTCUT_ARM_SAMPLES = 2;

/**
 * The keys the browser takes back while a hosted app holds the keyboard.
 *
 * The whole set is global for those few seconds -- every other app on the
 * machine loses them too -- so it is deliberately tiny, and every entry is a
 * key that BROWSERS own and hosted apps almost never do.
 *
 * NOT Ctrl+W: a hosted editor, chat client or terminal closes its own document
 * with it, and "closed my tab instead of my file" is unrecoverable in a way the
 * rest of this list is not. Same reasoning keeps out Ctrl+F (find, in every app
 * there is), Ctrl+R (refresh/run/record), Ctrl+S, Ctrl+P and Ctrl+N. The user
 * can always click the tab strip, which gives the chrome every shortcut back.
 *
 * `accelerator` is a fixed key app.js matches itself (never rebindable);
 * everything else is looked up in the live binding map the chrome mirrors over
 * 'shortcuts:set', so a rebound Ctrl+K follows the user's setting.
 */
const NATIVE_TAB_SHORTCUTS = [
  { id: 'new-tab', fallback: 'Ctrl+T' },
  { id: 'focus-omnibox', fallback: 'Ctrl+L' },
  { id: 'command-palette', fallback: 'Ctrl+K' },
  { id: 'tabsearch', fallback: 'Ctrl+Shift+A' },
  { id: 'next-tab', accelerator: 'Ctrl+Tab' },
  { id: 'prev-tab', accelerator: 'Ctrl+Shift+Tab' },
  { id: 'files', accelerator: 'Ctrl+Alt+E' },
];

/** @type {NodeJS.Timeout|null} the poll; null whenever nothing is hosted. */
let nativeFocusTimer = null;

/** The last { ours, hostedTabId } the chrome was told, so it hears only edges. */
let nativeFocusSent = null;

/** The reducer's state: see nativeShortcutStep(). */
let nativeShortcutState = { streak: 0, registered: false };

/** What is in the OS table right now: [{ id, accelerator }]. */
let nativeShortcutsOn = [];

/**
 * The register/unregister decision for ONE focus sample. Pure, and the whole of
 * the policy: the caller does the Win32 and the registering.
 *
 * @param {{streak:number, registered:boolean}} state
 * @param {{ours:boolean, ownProcess:boolean, hostedTabId:string|null, hostedVisible:boolean}} sample
 * @returns {{streak:number, registered:boolean, action:('register'|'unregister'|null)}}
 */
function nativeShortcutStep(state, sample) {
  const prev = (state && typeof state === 'object') ? state : { streak: 0, registered: false };
  const had = prev.registered === true;
  const s = sample && typeof sample === 'object' ? sample : {};
  // All of them, every tick: our window is the foreground one, the focus is NOT
  // in our own process (the chrome already has its keys then), a hosted app
  // holds the keyboard inside it, and that app is the tab on screen.
  //
  // `ownProcess` is asked of the pid, never of the window class: the apps worth
  // hosting (Discord, VS Code, Cursor, Spotify) are Electron/CEF, so a class
  // test called their windows "ours" and this set would never arm for them.
  const want = s.ours === true && s.ownProcess !== true
    && !!s.hostedTabId && s.hostedVisible === true;
  if (!want) return { streak: 0, registered: false, action: had ? 'unregister' : null };
  const streak = (Number(prev.streak) || 0) + 1;
  if (had) return { streak, registered: true, action: null };
  if (streak >= NATIVE_SHORTCUT_ARM_SAMPLES) return { streak, registered: true, action: 'register' };
  return { streak, registered: false, action: null };
}

/** The first combo the live binding map gives this action, or null. */
function comboForAction(id) {
  for (const combo of Object.keys(keyBindings)) {
    if (keyBindings[combo] === id) return combo;
  }
  return null;
}

/** NATIVE_TAB_SHORTCUTS resolved against the bindings -> [{ id, accelerator }]. */
function nativeShortcutSet() {
  const out = [];
  for (const entry of NATIVE_TAB_SHORTCUTS) {
    const accel = entry.accelerator || comboForAction(entry.id) || entry.fallback || '';
    if (accel) out.push({ id: entry.id, accelerator: accel });
  }
  return out;
}

/**
 * A registered key fired. The chrome runs the action, so the keyboard has to go
 * back to Chromium first -- otherwise Ctrl+L would focus an omnibox that cannot
 * be typed into. Neither call raises or activates the window: webContents.focus()
 * is in-process, and embed.focusChrome() is a SetFocus inside the window that is
 * already in the foreground.
 */
function fireNativeShortcut(id) {
  const w = liveWin();
  if (!w) return;
  /*
   * THE ORDER MATTERS IN OWNER MODE, AND IT IS THIS WAY ROUND BECAUSE THE APP'S
   * WINDOW IS A DIFFERENT TOP-LEVEL WINDOW.
   *
   * embed.focusChrome() FIRST: it is the only one of the two that can move the
   * keyboard between top-level windows (AttachThreadInput; see embed.js), and it
   * neither raises nor steals -- it hands OUR window the keyboard that the OS
   * just routed this hotkey to. Then webContents.focus() puts the focus on the
   * right widget INSIDE our window, so Ctrl+L lands in an omnibox that can
   * actually be typed into.
   *
   * Doing it the other way round measured as "it works anyway": Electron's own
   * focus() activated the window, so the Win32 handoff found nothing left to do.
   * That is luck, not design -- it depends on Chromium choosing to activate --
   * and it left the one call written for this case never running.
   */
  try { embed.focusChrome(); } catch { /* the Electron call below is the backstop */ }
  try { w.webContents.focus(); } catch { /* the renderer will still get it */ }
  send('shortcut:fire', { id: String(id) });
}

function registerNativeShortcuts() {
  const set = nativeShortcutSet();
  const done = [];
  const refused = [];
  for (const item of set) {
    let ok = false;
    try { ok = globalShortcut.register(item.accelerator, () => fireNativeShortcut(item.id)); }
    catch { ok = false; }
    if (ok) done.push(item);
    else refused.push(item.accelerator);
  }
  nativeShortcutsOn = done;
  console.warn('[embed] native-tab shortcuts on: '
    + (done.map((i) => i.accelerator + '=' + i.id).join(' ') || '(none)')
    + (refused.length ? ' | refused: ' + refused.join(' ') : ''));
}

function unregisterNativeShortcuts(reason) {
  if (!nativeShortcutsOn.length) return;
  for (const item of nativeShortcutsOn) {
    try { globalShortcut.unregister(item.accelerator); } catch { /* gone already */ }
  }
  console.warn('[embed] native-tab shortcuts off (' + (reason || 'condition lost') + '): '
    + nativeShortcutsOn.map((i) => i.accelerator).join(' '));
  nativeShortcutsOn = [];
  nativeShortcutState = { streak: 0, registered: false };
}

/** One tick: ask Win32, tell the chrome what moved, then re-decide the keys. */
function pollNativeFocus() {
  let info = null;
  try { info = embed.focusInfo(); } catch { info = null; }
  if (!info) return;

  if (!nativeFocusSent || nativeFocusSent.ours !== info.ours
      || nativeFocusSent.hostedTabId !== info.hostedTabId) {
    nativeFocusSent = { ours: !!info.ours, hostedTabId: info.hostedTabId || null };
    send('embed:focus', nativeFocusSent);
  }

  const next = nativeShortcutStep(nativeShortcutState, info);
  nativeShortcutState = { streak: next.streak, registered: next.registered };
  if (next.action === 'register') registerNativeShortcuts();
  else if (next.action === 'unregister') unregisterNativeShortcuts('focus left the app');
}

/**
 * Start the poll while something is hosted, stop it the moment nothing is.
 * Called from every edge that can change that -- attach, detach, close, the
 * app going away by itself, the window closing.
 */
function syncNativeFocusPoll() {
  let hosted = 0;
  try { hosted = embed.list().length; } catch { hosted = 0; }
  if (hosted > 0) {
    if (!nativeFocusTimer) nativeFocusTimer = setInterval(pollNativeFocus, NATIVE_FOCUS_POLL_MS);
    return;
  }
  if (nativeFocusTimer) {
    clearInterval(nativeFocusTimer);
    nativeFocusTimer = null;
  }
  unregisterNativeShortcuts('nothing hosted');
  // Nothing is hosted, so the window's own focus is the truth again and the
  // chrome must not be left holding a stale "he is inside an app".
  if (nativeFocusSent && (nativeFocusSent.ours || nativeFocusSent.hostedTabId)) {
    nativeFocusSent = { ours: false, hostedTabId: null };
    send('embed:focus', nativeFocusSent);
  }
}

/**
 * What focusInfo() says right now, plus which keys are really in the OS table.
 * Read-only, and the live verification's only way to see either.
 */
ipcMain.handle('embed:focus-info', (event) => {
  if (!isChromeSender(event)) return null;
  let info = null;
  try { info = embed.focusInfo(); } catch { info = null; }
  const registered = nativeShortcutsOn.map((item) => {
    let live = false;
    try { live = globalShortcut.isRegistered(item.accelerator); } catch { live = false; }
    return { id: item.id, accelerator: item.accelerator, isRegistered: live };
  });
  return {
    info,
    polling: nativeFocusTimer != null,
    streak: nativeShortcutState.streak,
    armed: nativeShortcutState.registered,
    registered,
    set: nativeShortcutSet(),
  };
});

// ---------------------------------------------------------------------------
// The Files tab (files.html — a folder browser, as a page)
//
// files.html is a <webview> guest with no node and no preload: it asks over
// console lines that app.js parses, so every call below arrives from the
// CHROME, never from the page. Same gate as apps, and for the same reason:
// opening a file with its default app, raising Explorer and writing the
// clipboard are three things a PAGE must never be able to ask for.
//
// Nothing here throws at the renderer. A listing that failed comes back as a
// listing with an `error` in it, and every action answers { ok, reason }.
// ---------------------------------------------------------------------------

/** At most this many entries travel in one listing; the page says so in a row. */
const FILES_MAX_ENTRIES = 2000;

/** stat() runs in waves this wide: a full folder is 32 waves, not 2,000 calls. */
const FILES_STAT_BATCH = 64;

/** The contract's per-line cap on an icon request. */
const FILES_ICON_MAX = 64;

/** A \\?\ path can reach 32,767 chars; nothing real is longer than that. */
const FILES_PATH_MAX = 32767;

/** Drive letters worth probing. A: and B: are floppies: a probe spins them. */
const FILES_DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ';

/** Folder-first, then name, the way the page sorts its own listings. */
const filesCollator = (() => {
  try { return new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }); } catch { return null; }
})();

/**
 * An ABSOLUTE Windows path, normalised, or null. A drive-letter path
 * ('C:\Users') or a UNC share ('\\box\share') only: a relative path, a bare
 * name, a URL and a file:// href are all refused rather than resolved against
 * whatever the working directory happens to be. This is the whole of the
 * validation — every handler below starts with it.
 */
function cleanFilePath(input) {
  if (typeof input !== 'string') return null;
  let text = input.trim();
  if (!text || text.length > FILES_PATH_MAX) return null;
  if (text.includes('\0')) return null;
  const drive = /^[A-Za-z]:[\\/]/.test(text);
  const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(text);
  if (!drive && !unc) return null;
  let full = '';
  try { full = path.win32.normalize(text); } catch { return null; }
  if (!full) return null;
  // 'C:\' keeps its slash (it IS the folder); anything longer loses a trailing one.
  if (full.length > 3) full = full.replace(/[\\/]+$/, '');
  return full;
}

/** The folder above this one, or null at a drive root or a share root. */
function parentFolderOf(target) {
  if (typeof target !== 'string' || !target) return null;
  const up = path.win32.dirname(target);
  if (!up || up === target) return null;
  // dirname('\\\\box\\share') is '\\\\box', which is not a folder.
  if (/^[\\/]{2}[^\\/]+[\\/]?$/.test(up)) return null;
  return up;
}

/** An fs error -> one of the three words the page knows, or its message. */
function fileErrorFor(err) {
  const code = (err && err.code) || '';
  if (code === 'ENOENT' || code === 'ENXIO') return 'not-found';
  if (code === 'EACCES' || code === 'EPERM') return 'access-denied';
  if (code === 'ENOTDIR') return 'not-a-folder';
  const message = (err && typeof err.message === 'string') ? err.message.trim() : '';
  return message || 'failed';
}

/** An empty answer with a reason in it: the page draws the error, not a crash. */
function fileListError(target, error) {
  return {
    path: target,
    parent: target ? parentFolderOf(target) : null,
    entries: [],
    error: error,
    truncated: false
  };
}

/**
 * One folder as `{ path, parent, entries, error, truncated }`. readdir is one
 * call; the per-entry stat (size, mtime, and what a symlink really points at)
 * runs FILES_STAT_BATCH at a time, and only for the entries that survived the
 * cap — a 20,000-file folder costs 2,000 stats, not 20,000.
 */
async function listFolder(target) {
  let dirents = null;
  try {
    dirents = await fs.promises.readdir(target, { withFileTypes: true });
  } catch (err) {
    return fileListError(target, fileErrorFor(err));
  }

  const rows = [];
  for (const dirent of dirents) {
    const name = dirent && typeof dirent.name === 'string' ? dirent.name : '';
    if (!name) continue;
    rows.push({
      name: name,
      path: path.win32.join(target, name),
      kind: dirent.isDirectory() ? 'dir' : 'file',
      link: typeof dirent.isSymbolicLink === 'function' && dirent.isSymbolicLink(),
      size: null,
      mtime: null,
      ext: dirent.isDirectory() ? '' : path.win32.extname(name).toLowerCase()
    });
  }

  rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    if (filesCollator) return filesCollator.compare(a.name, b.name);
    const la = a.name.toLowerCase();
    const lb = b.name.toLowerCase();
    return la < lb ? -1 : (la > lb ? 1 : 0);
  });

  const truncated = rows.length > FILES_MAX_ENTRIES;
  const kept = truncated ? rows.slice(0, FILES_MAX_ENTRIES) : rows;

  for (let at = 0; at < kept.length; at += FILES_STAT_BATCH) {
    const wave = kept.slice(at, at + FILES_STAT_BATCH);
    // stat(), not lstat(): a junction or a shortcut target decides what the row
    // IS. A stat that fails (a broken link, a file we may not read) leaves the
    // row as readdir described it, with no size and no date.
    await Promise.all(wave.map(async (row) => {
      let stats = null;
      try { stats = await fs.promises.stat(row.path); } catch { stats = null; }
      if (!stats) return;
      if (row.link) row.kind = stats.isDirectory() ? 'dir' : 'file';
      if (row.kind === 'dir') row.ext = '';
      else if (typeof stats.size === 'number' && isFinite(stats.size)) row.size = stats.size;
      if (typeof stats.mtimeMs === 'number' && isFinite(stats.mtimeMs)) row.mtime = Math.round(stats.mtimeMs);
    }));
  }

  return {
    path: target,
    parent: parentFolderOf(target),
    entries: kept.map((row) => ({
      name: row.name,
      path: row.path,
      kind: row.kind,
      size: row.kind === 'dir' ? null : row.size,
      mtime: row.mtime,
      ext: row.ext
    })),
    error: null,
    truncated: truncated
  };
}

/** Desktop, Downloads, Documents, Pictures, Videos, Music, then the user folder. */
const FILES_PLACE_IDS = [
  ['Desktop', 'desktop'],
  ['Downloads', 'downloads'],
  ['Documents', 'documents'],
  ['Pictures', 'pictures'],
  ['Videos', 'videos'],
  ['Music', 'music']
];

function filePlaces() {
  const out = [];
  const seen = new Set();
  const add = (name, target) => {
    if (typeof target !== 'string' || !target) return;
    const key = target.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: name, path: target });
  };
  for (const [name, id] of FILES_PLACE_IDS) {
    let target = '';
    try { target = app.getPath(id); } catch { target = ''; }  // a shell folder Windows does not have
    add(name, target);
  }
  let home = '';
  try { home = app.getPath('home'); } catch { home = ''; }
  add(path.win32.basename(home) || home, home);
  return out;
}

/**
 * Every fixed and removable drive that answers, with its free and total bytes.
 * statfs IS the probe: a letter nothing is mounted on rejects, and an empty
 * card reader rejects too, so a failed call means "not a drive right now".
 * No volume label: Windows does not expose one to Electron, and the page
 * treats an empty label as "just show the letter".
 */
async function fileDrives() {
  const letters = FILES_DRIVE_LETTERS.split('');
  const found = await Promise.all(letters.map(async (letter) => {
    const root = letter + ':\\';
    let st = null;
    try { st = await fs.promises.statfs(root); } catch { return null; }
    if (!st) return null;
    const block = Number(st.bsize) || 0;
    const total = block * (Number(st.blocks) || 0);
    const free = block * (Number(st.bavail) || 0);
    return {
      name: letter + ':',
      path: root,
      label: '',
      freeBytes: isFinite(free) && free >= 0 ? free : null,
      totalBytes: isFinite(total) && total > 0 ? total : null
    };
  }));
  return found.filter(Boolean);
}

/*
 * Icons are shell work, so they are cached for the life of the window. The key
 * is the EXTENSION for an ordinary file — every .txt in every folder wears the
 * same icon — and the full path for the kinds that carry their own (.exe, a
 * shortcut, a folder, anything extensionless).
 */
const fileIconCache = new Map();
const FILES_ICON_CACHE_MAX = 800;
const FILES_OWN_ICON = new Set(['', '.exe', '.lnk', '.url', '.ico', '.msc', '.cpl', '.dll', '.scr']);

function fileIconKey(target) {
  const ext = path.win32.extname(target).toLowerCase();
  return FILES_OWN_ICON.has(ext) ? 'p:' + target.toLowerCase() : 'e:' + ext;
}

async function fileIconFor(target) {
  const key = fileIconKey(target);
  if (fileIconCache.has(key)) return fileIconCache.get(key);
  let url = null;
  try {
    const img = await app.getFileIcon(target, { size: 'small' });
    if (img && !img.isEmpty()) {
      const data = img.toDataURL();
      if (typeof data === 'string' && data.startsWith('data:')) url = data;
    }
  } catch { url = null; }
  // A miss is cached too, but only per extension: a per-path miss is usually
  // "that file just went away", which is worth asking about again.
  if (url !== null || key.startsWith('e:')) {
    if (fileIconCache.size >= FILES_ICON_CACHE_MAX) fileIconCache.clear();
    fileIconCache.set(key, url);
  }
  return url;
}

ipcMain.handle('files:list', (event, rawPath) => {
  if (!isChromeSender(event)) return fileListError(null, 'access-denied');
  // null is the root: the page draws the places and the drives, not a folder.
  if (rawPath === null || rawPath === undefined || rawPath === '') {
    return { path: null, parent: null, entries: [], error: null, truncated: false };
  }
  const target = cleanFilePath(rawPath);
  if (!target) return fileListError(null, 'not-found');
  try {
    return listFolder(target).catch((err) => fileListError(target, fileErrorFor(err)));
  } catch (err) {
    return fileListError(target, fileErrorFor(err));
  }
});

ipcMain.handle('files:places', (event) => {
  if (!isChromeSender(event)) return { places: [], drives: [] };
  let places = [];
  try { places = filePlaces(); } catch { places = []; }
  try {
    return fileDrives().then(
      (drives) => ({ places: places, drives: Array.isArray(drives) ? drives : [] }),
      () => ({ places: places, drives: [] })
    );
  } catch {
    return { places: places, drives: [] };
  }
});

// The point of the whole page: hand a file to whatever Windows opens it with.
// A .lnk is allowed on purpose — a shortcut is a file the user double-clicks.
ipcMain.handle('files:open', (event, rawPath) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
  const target = cleanFilePath(rawPath);
  if (!target) return { ok: false, reason: 'not-found' };
  try {
    return fs.promises.stat(target).then(
      // openPath resolves '' when it worked and a message when it did not.
      () => shell.openPath(target).then(
        (message) => (message ? { ok: false, reason: String(message) } : { ok: true, reason: '' }),
        () => ({ ok: false, reason: 'failed' })
      ),
      (err) => ({ ok: false, reason: fileErrorFor(err) })
    );
  } catch {
    return { ok: false, reason: 'failed' };
  }
});

// This one raises an Explorer window, which is a focus steal — and it only ever
// runs off a menu item the user picked in the page, which is the same bargain
// apps:focus makes.
ipcMain.handle('files:reveal', (event, rawPath) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
  const target = cleanFilePath(rawPath);
  if (!target) return { ok: false, reason: 'not-found' };
  try {
    return fs.promises.stat(target).then(
      (_stats) => {
        try { shell.showItemInFolder(target); } catch { return { ok: false, reason: 'failed' }; }
        return { ok: true, reason: '' };
      },
      (err) => ({ ok: false, reason: fileErrorFor(err) })
    );
  } catch {
    return { ok: false, reason: 'failed' };
  }
});

ipcMain.handle('files:icons', (event, rawPaths) => {
  if (!isChromeSender(event)) return {};
  if (!Array.isArray(rawPaths) || !rawPaths.length) return {};
  // The map is keyed by the string the PAGE sent, so a normalisation here can
  // never make an answer unrecognisable to the row that asked for it.
  const wanted = [];
  for (const raw of rawPaths.slice(0, FILES_ICON_MAX)) {
    const target = cleanFilePath(raw);
    if (!target) continue;
    wanted.push({ key: String(raw), target: target });
  }
  if (!wanted.length) return {};
  try {
    return Promise.all(wanted.map((item) => fileIconFor(item.target).catch(() => null))).then(
      (icons) => {
        const out = {};
        for (let i = 0; i < wanted.length; i++) out[wanted[i].key] = icons[i] || null;
        return out;
      },
      () => ({})
    );
  } catch {
    return {};
  }
});

ipcMain.handle('files:copy-path', (event, rawPath) => {
  if (!isChromeSender(event)) return { ok: false, reason: 'refused' };
  const target = cleanFilePath(rawPath);
  if (!target) return { ok: false, reason: 'not-found' };
  try {
    clipboard.writeText(target);
  } catch {
    return { ok: false, reason: 'failed' };
  }
  return { ok: true, reason: '' };
});

/* ------------------------------------------------------------------ */
/* The lens's folder source: project folders, one level deep           */
/* ------------------------------------------------------------------ */
/*
 * SELF-CONTAINED BLOCK. Nothing above or below calls into it, and it calls
 * nothing of its own beyond fs/os/path and isChromeSender; delete the block
 * and preload.js's listProjectFolders() and the lens simply shows "Folders
 * unavailable". history.js is the only caller.
 *
 * The address bar's suggestion list (#omni-suggest) offers the user's project
 * folders by name: type "helm" and ~/helm is a row that opens in the Files
 * tab. The renderer cannot list a directory, so this is the one narrow way:
 *
 *   omni:folders  ->  { ok, folders: [{ name, path, root }], reason }
 *
 * where root is 'home' (C:\Users\you) or 'downloads' (…\Downloads), and
 * reason is '' or a plain sentence naming the root that could not be read.
 *
 * DELIBERATELY SMALL. Depth 1 only: one readdir per root, never a walk, never
 * a stat per entry (Dirent already says "directory"). A junction such as
 * "Application Data" reads as a symlink, not a directory, so the legacy
 * Windows aliases fall out by themselves; dot-, $- and ~-names, node_modules
 * and AppData are skipped by name, since Node cannot see the hidden bit.
 * The renderer caches the answer for minutes, so this runs rarely.
 */
const OMNI_FOLDER_SKIP = new Set(['node_modules', 'appdata', 'application data', 'local settings']);
const OMNI_FOLDER_MAX_PER_ROOT = 500;   // a sane ceiling; a home folder has ~100

ipcMain.handle('omni:folders', async (event) => {
  if (!isChromeSender(event)) return { ok: false, folders: [], reason: 'refused: not the browser window' };
  const home = os.homedir();
  const roots = [
    { key: 'home', dir: home },
    { key: 'downloads', dir: path.join(home, 'Downloads') },
  ];
  const folders = [];
  const problems = [];
  for (const root of roots) {
    let dirents;
    try {
      dirents = await fs.promises.readdir(root.dir, { withFileTypes: true });
    } catch (err) {
      problems.push('could not read ' + root.dir + ' (' + ((err && err.code) || 'error') + ')');
      continue;
    }
    let kept = 0;
    for (const d of dirents) {
      if (kept >= OMNI_FOLDER_MAX_PER_ROOT) break;
      if (!d || !d.isDirectory()) continue;
      const name = String(d.name || '');
      if (!name || /^[.$~]/.test(name)) continue;
      if (OMNI_FOLDER_SKIP.has(name.toLowerCase())) continue;
      folders.push({ name, path: path.join(root.dir, name), root: root.key });
      kept++;
    }
  }
  return { ok: problems.length === 0, folders, reason: problems.join('; ') };
});
/* --- end of the lens's folder source -------------------------------- */

/** file:// prefix of the app's own folder: newtab.html, reader.html, files… */
const BUNDLED_PAGE_PREFIX = pathToFileURL(path.join(__dirname, path.sep)).href;

/** True for one of OUR file:// pages (the new tab page, reader, history). */
function isBundledPageUrl(url) {
  return typeof url === 'string' && url.toLowerCase().startsWith(BUNDLED_PAGE_PREFIX.toLowerCase());
}

/**
 * The scheme gate for anything a PAGE asks us to open in a new window. Only
 * http(s) survives: `javascript:` would run in the new document, `data:` and
 * `blob:` are the classic phishing shells, and `file:` is the one the
 * will-navigate lock below exists to stop. Returns the normalised href, or
 * null to deny.
 */
function webUrlOrNull(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Popups
//
// Two different things arrive at setWindowOpenHandler and they need opposite
// answers:
//
//   a LINK (target="_blank", middle-click, shift-click) -> disposition
//   'foreground-tab' / 'background-tab'. The chrome owns the tab strip, so
//   these stay as they were: deny the window, send 'open-url', get a tab.
//
//   window.open(url, name, features) -> disposition 'new-window'. This is
//   every OAuth "sign in with Google" popup. A tab has no `window.opener`, so
//   the credential the popup posts back never lands and the first page sits
//   there white. These get a REAL child BrowserWindow, which is the only
//   shape that keeps window.opener alive.
// ---------------------------------------------------------------------------

/** Defaults when window.open named no size. Tall and narrow, like a chooser. */
const POPUP_DEFAULT_SIZE = { width: 520, height: 640 };
const POPUP_MIN = { width: 320, height: 400 };
const POPUP_MAX = { width: 1200, height: 900 };

/** Pull width/height out of window.open's `features` string, clamped. */
function popupSizeFromFeatures(features) {
  const read = (name) => {
    const hit = new RegExp('(?:^|[,\\s])' + name + '\\s*=\\s*(\\d+)', 'i').exec(
      typeof features === 'string' ? features : ''
    );
    return hit ? Number(hit[1]) : NaN;
  };
  const pick = (value, fallback, lo, hi) =>
    Number.isFinite(value) ? Math.min(Math.max(Math.round(value), lo), hi) : fallback;
  return {
    width: pick(read('width'), POPUP_DEFAULT_SIZE.width, POPUP_MIN.width, POPUP_MAX.width),
    height: pick(read('height'), POPUP_DEFAULT_SIZE.height, POPUP_MIN.height, POPUP_MAX.height),
  };
}

/**
 * BrowserWindow options for a page-opened popup. Deliberately NOT modal: the
 * sign-in window sits above the browser (parent) but the page behind it stays
 * interactive, which is what every OAuth flow expects. No preload, no node,
 * no devtools -- and no `partition`, so it lands on session.defaultSession
 * like every guest does: same cookies, same ad blocker, same permission
 * handlers (those hang off the session, not the webContents).
 */
function popupWindowOptions(features) {
  const size = popupSizeFromFeatures(features);
  const owner = win && !win.isDestroyed() ? win : null;
  const options = {
    width: size.width,
    height: size.height,
    show: true,
    parent: owner || undefined,
    modal: false,
    autoHideMenuBar: true,
    title: 'Sign in',
    backgroundColor: '#05060a',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      devTools: false,
    },
  };
  if (owner) {
    const bounds = owner.getBounds();
    options.x = Math.round(bounds.x + (bounds.width - size.width) / 2);
    options.y = Math.round(bounds.y + (bounds.height - size.height) / 2);
  }
  return options;
}

/** The one decision, shared by guests and by popups' own popups. */
function windowOpenDecision(details) {
  const raw = (details && details.url) || '';
  const disposition = (details && details.disposition) || '';
  // Google opens the popup on about:blank and sets location afterwards.
  const blank = raw === '' || /^about:blank/i.test(raw);
  const url = webUrlOrNull(raw);

  if (disposition === 'new-window' || disposition === 'other') {
    if (!url && !blank) return { action: 'deny' };
    return {
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: popupWindowOptions(details && details.features),
    };
  }

  // Links, and anything unrecognised: a tab, exactly as before.
  if (url) send('open-url', { url, background: disposition === 'background-tab' });
  return { action: 'deny' };
}

/**
 * A guest's own window-open decision: windowOpenDecision() above, plus the one
 * case it cannot judge without knowing the opener -- a file:// target. A local
 * page's target="_blank" link (or window.open) to another local file becomes a
 * Quartz tab on that file, as it would in Chrome. Asked by anything else it is
 * refused and the tab says so; before this, both halves vanished silently.
 * The rule and its reasoning live in filenav.js. The handler is given no
 * initiator frame here, so the referrer stands in for it: a file:// page sends
 * none, a web frame inside one sends its own origin.
 */
function guestWindowOpenDecision(contents, details) {
  const raw = (details && details.url) || '';
  traceFileNav('window-open', { url: raw, from: safeUrl(contents), disposition: details && details.disposition, referrer: details && details.referrer && details.referrer.url });
  if (!fileNav.isFileUrl(raw)) return windowOpenDecision(details);
  const referrer = (details && details.referrer && details.referrer.url) || '';
  if (fileNav.pageMayOpen(raw, safeUrl(contents), referrer, BUNDLED_PAGE_PREFIX)) {
    let href = raw;
    try { href = new URL(raw).href; } catch { /* the guest's own spelling, then */ }
    send('open-url', { url: href, background: (details && details.disposition) === 'background-tab' });
  } else {
    fileNavBlocked(contents, raw);
  }
  return { action: 'deny' };
}

/** Tell the chrome a page was stopped from opening a file, so the tab can say it. */
function fileNavBlocked(contents, url) {
  let wcId = null;
  try { wcId = contents && !contents.isDestroyed() ? contents.id : null; } catch { /* gone */ }
  traceFileNav('blocked', { url, wcId });
  send('file-nav-blocked', { wcId, url: String(url || ''), text: fileNav.blockedNotice(url) });
}

/**
 * Test runs only (--test-profile AND QUARTZ_TEST_FILENAV_TRACE=<file>): one
 * JSON line per file:// decision, so filelinks-e2e.js can tell "the hook
 * never fired" from "it fired and the chrome dropped it". Off otherwise.
 */
function traceFileNav(kind, info) {
  const file = process.env.QUARTZ_TEST_FILENAV_TRACE;
  if (!file || !process.argv.includes('--test-profile')) return;
  try { fs.appendFileSync(file, JSON.stringify(Object.assign({ kind, at: Date.now() }, info)) + '\n'); } catch { /* a trace only */ }
}

/**
 * A child window just opened. Give it the same rules its opener had: no menu
 * bar, its links become tabs in the chrome, its own popups nest, its title
 * follows the page, and it never outlives the browser window.
 */
function adoptPopupWindow(child) {
  if (!child || child.isDestroyed()) return;
  try {
    child.setMenuBarVisibility(false);
  } catch {}
  // Its top row is Windows' own caption, which Quartz cannot describe:
  // Mantle hears "none" for it (its own capture), never a stale hint.
  try { if (toprow) toprow.attachWindow(child, { chrome: false }); } catch { /* hints only */ }

  const wc = child.webContents;
  if (wc && !wc.isDestroyed()) {
    wc.setWindowOpenHandler(windowOpenDecision);
    wc.on('did-create-window', (grandchild) => adoptPopupWindow(grandchild));
    wc.on('page-title-updated', (event, title) => {
      event.preventDefault();
      if (!child.isDestroyed() && title) child.setTitle(title);
    });
  }

  // `parent` already ties them together on Windows, but a popup surviving the
  // browser with no way back to it would be the worst version of this feature.
  const owner = win && !win.isDestroyed() ? win : null;
  if (!owner) return;
  const closeChild = () => {
    if (!child.isDestroyed()) child.close();
  };
  owner.once('closed', closeChild);
  child.once('closed', () => {
    try {
      owner.removeListener('closed', closeChild);
    } catch {}
  });
}

/*
 * The "MaxListenersExceededWarning: 11 did-stop-loading listeners added to
 * [WebContents]" on every new tab.
 *
 * Electron's WebContents.executeJavaScript waits for a guest that is still
 * loading by adding its own once('did-stop-loading') listener PER CALL. The
 * chrome pushes a dozen things into a fresh new tab (readout, stats, markets,
 * background, settings...) before it has finished loading, so the 11th call
 * tripped Node's leak warning. It was never a leak (each listener fires once
 * and goes), but the warning fired on every new tab and buried real ones.
 *
 * A first version shared ONE wait per load among the calls; it changed WHEN
 * some pushes landed (bravesearch-e2e's "Next keeps the look" failed with it
 * and passed without), so Electron's own waits are left exactly as they are.
 * Instead the limit makes room for them: just before a call, if Electron's
 * once() could be the one over the line, the limit goes up by 10; once the
 * page stops loading and the waits have drained it goes back to what it was.
 * So a guest still warns for any OTHER listener that piles up, at the usual
 * limit, every moment it is not mid-load with pushes queued.
 *
 * The <webview> element's executeJavaScript reaches this object by a method
 * lookup on the guest, so an own property here is what it calls.
 */
function roomForExecuteJavaScriptWaits(contents) {
  const original = contents.executeJavaScript;
  if (typeof original !== 'function') return;
  const base = contents.getMaxListeners();
  // Each per-call wait also adds a 'destroyed' listener, and that event already carries one
  // listener per feature that watches the guest (adblock, Lumen, sports, score pins, the
  // Claude answer...), so it is the busier of the two: room is made for whichever is higher.
  const busiest = () => Math.max(contents.listenerCount('did-stop-loading'), contents.listenerCount('destroyed'));
  contents.executeJavaScript = function executeJavaScriptWithRoom(...args) {
    try {
      const limit = contents.getMaxListeners();
      if (limit > 0 && busiest() + 1 >= limit) contents.setMaxListeners(limit + 10);
    } catch { /* the call goes on as it always did */ }
    return original.apply(contents, args);
  };
  // After every listener of this did-stop-loading has run (setImmediate), and
  // only when the queue has drained back under the usual limit.
  contents.on('did-stop-loading', () => setImmediate(() => {
    try {
      if (!contents.isDestroyed() && contents.getMaxListeners() !== base
        && busiest() < base) contents.setMaxListeners(base);
    } catch { /* destroyed meanwhile */ }
  }));
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

  // A test run can turn this off to show the warning it prevents (log-e2e.js --no-gate).
  if (!(process.argv.includes('--test-profile') && process.env.QUARTZ_TEST_NO_JS_GATE === '1')) {
    roomForExecuteJavaScriptWaits(contents);
  }
  // quartz.log: this guest's hangs and failed main-frame loads (log.js).
  if (qlog) qlog.watchGuest(contents);

  /*
   * window.open(), target="_blank", and anything else that wants a second
   * window -- including a link inside a cross-origin iframe, which is how
   * Google's account popover spells "Add another account".
   *
   * windowOpenDecision() above splits them: a link becomes a tab in our own
   * chrome, a window.open() with features becomes a real child window so
   * `window.opener` survives (sign-in flows post the credential back through
   * it). Anything that is not http(s) or about:blank is denied outright.
   *
   * This replaces the <webview> 'new-window' DOM event app.js used to listen
   * for: that event was removed from Electron in v22 and never fires on 44, so
   * every popup in the app was silently dying. setWindowOpenHandler is the
   * modern path -- and it only runs at all because will-attach-webview turns
   * `allowpopups` on.
   */
  contents.setWindowOpenHandler((details) => guestWindowOpenDecision(contents, details));

  // The window the decision above allowed. Everything the popup needs that is
  // not a BrowserWindow option is wired here.
  contents.on('did-create-window', (child) => adoptPopupWindow(child));

  /*
   * Page-INITIATED navigation to file://. Chromium already refuses this for a
   * web page, so this is the second lock rather than the first -- but the cost
   * is one string test and the thing it stops (a page walking the guest onto
   * file:///C:/Users/... and reading it same-origin) is the worst outcome in
   * the app.
   *
   * will-navigate fires only for navigation the PAGE started: loadURL() and
   * setAttribute('src', …) -- which is every navigation the chrome itself
   * drives, omnibox included -- do not emit it. So typing a file:// path stays
   * exactly as it was.
   *
   * Two page-initiated file:// navigations go through. Our own: the new tab
   * page calls location.assign() for whatever was typed into its field, and
   * reader.html links back with location.href -- both bundled pages. And a
   * local page's own links (<a href="1-prism.html"> on a file:// page), which
   * Chrome follows and this lock used to eat without a word. filenav.js holds
   * the rule and why file -> file is safe; everything else is still refused,
   * and now the tab says so instead of the click doing nothing.
   */
  contents.on('will-navigate', (event, url) => {
    if (typeof url !== 'string' || !fileNav.isFileUrl(url)) return;
    // The frame that started it: an http iframe inside a local page does not
    // get to borrow the page's file:// standing.
    let by = '';
    try { by = event && event.initiator ? String(event.initiator.url || '') : ''; } catch { by = ''; }
    traceFileNav('will-navigate', { url, from: safeUrl(contents), by });
    if (fileNav.pageMayOpen(url, safeUrl(contents), by, BUNDLED_PAGE_PREFIX)) return;
    event.preventDefault();
    fileNavBlocked(contents, url);
  });

  /*
   * The FIRST lock is Chromium's: a web page's link, location.assign or
   * window.open to file:// is refused inside Chromium before will-navigate or
   * setWindowOpenHandler ever hear of it, and the only trace it leaves is a
   * console line in the page: "Not allowed to load local resource: file:///…".
   * That line is what makes the refusal visible on the tab. It also fires for
   * an <img>/<iframe> pointing at file://, which is the same refusal ("this
   * page tried to reach a file on your computer"), so it is said the same way.
   */
  contents.on('console-message', (event, legacyLevel, legacyMessage) => {
    const message = String((event && event.message) || legacyMessage || '');
    const url = fileNav.refusedLocalResource(message);
    if (!url) return;
    traceFileNav('chromium-refused', { url, from: safeUrl(contents) });
    fileNavBlocked(contents, url);
  });

  // A click inside a guest never reaches the chrome renderer; split view needs
  // to know which pane took focus so the omnibox and chips can follow it.
  contents.on('focus', () => send('guest-focus', { wcId: contents.id }));

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key);

    // Devtools belong to the GUEST, and only main has a handle on it -- so this
    // one is done here instead of round-tripping through the renderer.
    if (key === 'F12' || (input.control && input.shift && key.toLowerCase() === 'i')) {
      event.preventDefault();
      contents.toggleDevTools();
      return;
    }

    const bare = BARE_KEYS[key];
    if (bare) {
      // Escape is forwarded but not swallowed: the page still wants it.
      if (bare !== 'escape') event.preventDefault();
      send('shortcut', { action: bare });
      return;
    }

    // Ctrl and Alt combos are the rebindable ones; anything else is the
    // page's own business.
    if (input.meta || (!input.control && !input.alt)) return;
    const payload = shortcutFor(input);
    if (!payload) return;
    event.preventDefault();
    send('shortcut', payload);
  });

  contents.on('context-menu', (_e, params) => {
    const template = guestMenuTemplate(contents, params);
    if (dumpMenu('guest', template)) return;
    const menu = Menu.buildFromTemplate(template);
    const w = liveWin();
    menu.popup(w ? { window: w } : {});
  });

  // The blocked counter belongs to the PAGE, not the tab: a new main-frame
  // document starts from zero, and carries the host the chrome shows next to
  // it. 'did-navigate' is main-frame only, so an iframe cannot reset anything.
  contents.on('did-navigate', (_e, url) => {
    adblockCounts.set(contents.id, { blocked: 0, host: hostOfUrl(url) });
    queueAdblockUpdate(contents.id);
  });

  contents.on('destroyed', () => forgetAdblockTab(contents.id));

  // Spotify auto-pause watches this guest from here on: audible + a watched
  // host is what counts as "a video is playing". It attaches its own listeners
  // and drops the tab when it is destroyed.
  autoPause.watchGuest(contents);
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

app.on('window-all-closed', () => {
  killAll();
  handles.clear();
  for (const id of Array.from(ptyOut.keys())) ptyFlushFinal(id);
  app.quit();
});

app.on('before-quit', (event) => {
  try { if (lookSync) lookSync.close(); } catch { /* the folder watcher only */ }
  // Before anything else: give every embedded app window back to the desktop.
  // A child HWND dies with its parent, so this is the difference between "the
  // browser quit" and "Notepad quit too, taking the document with it".
  try { embed.detachAll(); } catch { /* best effort, always */ }
  // Electron drops every accelerator on quit anyway; doing it here means the
  // log says so, and a quit that is cancelled leaves nothing armed.
  try { unregisterNativeShortcuts('quit'); } catch { /* nothing registered */ }
  if (nativeFocusTimer) { clearInterval(nativeFocusTimer); nativeFocusTimer = null; }
  // The one place a synchronous write is still right: there is no event loop
  // left to protect, and a snapshot that never reached disk is a lost session.
  // (app:restart goes through app.quit(), so a restart lands here too.)
  flushSessionSync();
  // A word added from the menu a moment ago must not be lost to the quit.
  try { spell.flush(); } catch { /* best effort */ }
  killAll();
  handles.clear();
  for (const id of Array.from(ptyOut.keys())) ptyFlushFinal(id);
  // The tab tools: every pane's key revoked and config file deleted, the pipe closed.
  for (const id of Array.from(ptyToolRelease.keys())) releasePtyTools(id);
  try { claudeTools.stop(); } catch { /* best effort */ }
  // The stats sampler's typeperf child is not ours to leave behind: it is a
  // separate process that would outlive the quit.
  stats.stop();
  // Same idea for the app index: a Get-StartApps or a focus PowerShell caught
  // mid-flight is a child of ours, and it is not going to be missed.
  apps.stop();
  // The price tile's socket and its poll timer. It is already ref-counted down
  // to nothing when the last new tab goes away; this is the case where the
  // window is closed with one still open.
  stocks.stop();
  // The search page's in-memory answers (Brave's terms: transient only).
  try { braveSearch.stop(); } catch { /* best effort */ }
  // An answer still streaming from Claude: abort it (its in-memory cache goes too).
  try { claudeAnswer.stop(); } catch { /* best effort */ }
  // Watch: its timer, a hidden reader window mid-read, and the cache's last write.
  try { watch.stop(); } catch { /* best effort */ }
  // The favicon cache: a logo learned a moment ago must be there next start.
  try { if (faviconStore) faviconStore.flushSync(); } catch { /* best effort */ }
  // The notes pane's budget poller, its timers and its child processes (a
  // headless claude, a UIA/OCR reader) must not outlive the quit either.
  try { notesPane.stop(); } catch { /* best effort */ }
  // The phone relay's adb daemon and the scrcpy server on the phone: stop()
  // tears the stream down and kills the adb server so nothing outlives us.
  try { phone.stop(); } catch { /* best effort */ }
  // And for the icon cache, which may be holding a PowerShell batch and a
  // debounced write. Only if it was ever built -- this must not build one.
  if (procIcons && typeof procIcons.stop === 'function') {
    try { procIcons.stop(); } catch { /* nothing left to protect */ }
  }
  // Hands our Spotify hold back. That is an HTTP round trip, so it may defer
  // the quit by up to ~1.5 s -- once, and only when a hold is actually out.
  // Skipping it would leave Spotify paused until the bridge's 180 s hold TTL
  // expired it.
  autoPause.handleQuit(event);
});
