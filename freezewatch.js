'use strict';

/**
 * freezewatch.js -- the window that stops drawing, and draws again when it is moved.
 *
 * The user: "Sometimes the browser will just freeze and I will have to drag the whole
 * thing and then press fullscreen again and then it isn't frozen anymore."
 *
 * WHAT THAT IS. Chromium on Windows stops drawing a window it believes is covered
 * (its native occlusion tracker, ui/aura/native_window_occlusion_tracker_win.cc): the
 * page is told it is hidden, no frames are made, and the screen keeps the last one --
 * a frozen window. Pages keep running underneath (sound plays on). The tracker only
 * recomputes on certain window events, and a drag (EVENT_SYSTEM_MOVESIZESTART/END) is
 * one of them, which is why moving the window brings it back.
 *
 * Read in Chromium 152.0.7977.167 (the framework in use), two ways it can be left
 * wrong while nothing covers the window:
 *   1. WAKE. Display off marks every window covered; display on queues a recompute on
 *      a 16 ms timer; resume-from-sleep STOPS that timer ("timers are unreliable when
 *      the device is going to sleep or resuming") and schedules nothing. When "display
 *      on" is handled before "resume" -- both arrive together when the PC wakes -- the
 *      window stays marked covered until some later window event.
 *      freezewatch-e2e.js reproduces exactly this in a real Quartz.
 *   2. A COVER THAT HIDES. EVENT_OBJECT_SHOW / HIDE never trigger a recompute (only the
 *      Windows task-switcher classes do), so a full-size window from another app that
 *      is hidden without a focus change leaves the window marked covered.
 *
 * WHAT THIS DOES, all of it invisible (the window never moves or resizes):
 *   - After every wake, unlock and display-on: three nudges (0.6 s, 2.5 s, 6 s later).
 *     A nudge is NotifyWinEvent(EVENT_SYSTEM_CAPTUREEND) on our window -- an event the
 *     tracker listens to and Chromium itself relies on (crbug.com/1137982) -- which
 *     makes it recompute, plus InvalidateRect, the same full redraw Chromium does on
 *     unlock (HWNDMessageHandler::ForceRedrawWindow). Not MOVESIZEEND: other tools
 *     (window snappers, the user's shell) act on that one.
 *   - A watch, only while the chrome page reports itself hidden: the window is shown,
 *     not minimised, the user is active (input within 2 min, not locked), and by the
 *     tracker's own rules (canOcclude below) nothing covers it -> "stale". Stale for
 *     1.5 s -> a nudge. Still hidden 1.2 s later -> Chromium is told the display is on
 *     and the session unlocked (its own hidden window, in this process only; both are
 *     no-ops when already true) and nudged again. Still hidden -> the watch gives up and
 *     says so the next time the window draws.
 *   - Every episode goes to freeze.log (userData) with what was above the window, the
 *     order of the power messages, and what fixed it; the one-line version goes to
 *     quartz.log. A redraw this module caused is said on screen in plain words (a
 *     toast); so is a give-up, once the window draws again.
 *   - The user's own fix is recorded too: un-maximise then maximise within 30 s writes
 *     the page's visibility history at that moment, so a freeze of another kind (the
 *     page said visible all along) is told apart next time.
 *
 * koffi is optional (as in embed.js): without it, nothing here runs but the log of
 * the visibility history and the re-maximise record.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants (winuser.h, dbt.h, wtsapi32.h)
// ---------------------------------------------------------------------------
const WS_POPUP = 0x80000000;
const WS_EX_TRANSPARENT = 0x20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_LAYERED = 0x80000;
const LWA_COLORKEY = 0x1;
const LWA_ALPHA = 0x2;
const COMPLEXREGION = 3;
const GW_HWNDPREV = 3;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const DWMWA_CLOAKED = 14;
const MONITOR_DEFAULTTONEAREST = 2;
const EVENT_SYSTEM_CAPTUREEND = 0x0009;
const OBJID_WINDOW = 0;
const CHILDID_SELF = 0;
const WM_POWERBROADCAST = 0x0218;
const WM_WTSSESSION_CHANGE = 0x02B1;
const PBT_APMSUSPEND = 0x4;
const PBT_APMRESUMEAUTOMATIC = 0x12;
const PBT_POWERSETTINGCHANGE = 0x8013;
const WTS_SESSION_LOCK = 0x7;
const WTS_SESSION_UNLOCK = 0x8;
/** GUID_SESSION_DISPLAY_STATUS {2B84C20E-AD23-4DDF-93DB-05FFBD7EFCA5}, as laid out in memory. */
const GUID_SESSION_DISPLAY_STATUS = Buffer.from('0ec2842b23addf4d93db05ffbd7efca5', 'hex');

const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

/** Nudges after a wake / unlock / display-on, in ms. */
const WAKE_NUDGES_MS = [600, 2500, 6000];
/** How long after a nudge a hidden->visible flip is credited to it. */
const CREDIT_MS = 500;
/** Sampling interval while the page reports hidden. */
const SAMPLE_MS = 1000;
/** Fewer uncovered pixels than this is treated as covered (rounding at the edges). */
const MIN_UNCOVERED_PX = 4096;
/** "Active" = input within this many seconds and the session not locked. */
const ACTIVE_WITHIN_S = 120;
/** Un-maximise then maximise within this is the manual redraw. */
const REMAX_WINDOW_MS = 30000;
const HISTORY_MAX = 24;

// ---------------------------------------------------------------------------
// Pure parts (freezewatch-harness.js)
// ---------------------------------------------------------------------------

/**
 * Chromium's gfx::IsWindowVisibleAndFullyOpaque (ui/gfx/win/hwnd_util.cc, 152), on a
 * plain description of one window:
 *   { visible, iconic, style, exStyle, className, layered: null | { ok, alpha, flags },
 *     complexRegion, cloaked, rect: { left, top, right, bottom } }
 * true = the tracker counts it as covering what is under it.
 */
function canOcclude(w) {
  if (!w || !w.visible || w.iconic) return false;
  const ex = (w.exStyle >>> 0);
  if (ex & WS_EX_TRANSPARENT) return false;
  if ((ex & WS_EX_TOOLWINDOW) && w.className !== 'Shell_TrayWnd') return false;
  if (ex & WS_EX_LAYERED) {
    const l = w.layered;
    if (!l || !l.ok) return false;            // UpdateLayeredWindow windows: not readable = see-through
    if ((l.flags & LWA_ALPHA) && l.alpha < 255) return false;
    if (l.flags & LWA_COLORKEY) return false;
  }
  if (w.complexRegion) return false;
  if (w.cloaked) return false;
  const r = w.rect;
  if (!r || r.right <= r.left || r.bottom <= r.top) return false;
  if ((w.style >>> 0) & WS_POPUP) {
    const c = String(w.className || '');
    if (!c.startsWith('Chrome_WidgetWin_') && c !== 'Shell_TrayWnd') return false;
  }
  return true;
}

function intersect(a, b) {
  const r = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return r.right > r.left && r.bottom > r.top ? r : null;
}

/** rect minus cut -> up to four rects. */
function subtract(rect, cut) {
  const i = intersect(rect, cut);
  if (!i) return [rect];
  const out = [];
  if (i.top > rect.top) out.push({ left: rect.left, top: rect.top, right: rect.right, bottom: i.top });
  if (i.bottom < rect.bottom) out.push({ left: rect.left, top: i.bottom, right: rect.right, bottom: rect.bottom });
  if (i.left > rect.left) out.push({ left: rect.left, top: i.top, right: i.left, bottom: i.bottom });
  if (i.right < rect.right) out.push({ left: i.right, top: i.top, right: rect.right, bottom: i.bottom });
  return out;
}

const area = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

/**
 * Pixels of `self` (clipped to `screen`) left after every rect in `cuts` -- the part
 * of the window the tracker should call visible. `cuts` are the occluders ABOVE it.
 */
function uncoveredPx(self, cuts, screen) {
  const start = screen ? intersect(self, screen) : self;
  if (!start) return 0;
  let parts = [start];
  for (const c of cuts || []) {
    const next = [];
    for (const p of parts) for (const q of subtract(p, c)) next.push(q);
    parts = next;
    if (!parts.length) return 0;
  }
  return parts.reduce((s, p) => s + area(p), 0);
}

/** gfx::Rect::AdjustToFit: shrink to fit `bounds`, then slide inside it. */
function adjustToFit(r, b) {
  const w = Math.min(r.right - r.left, b.right - b.left);
  const h = Math.min(r.bottom - r.top, b.bottom - b.top);
  const left = Math.min(Math.max(r.left, b.left), b.right - w);
  const top = Math.min(Math.max(r.top, b.top), b.bottom - h);
  return { left, top, right: left + w, bottom: top + h };
}

/**
 * The watch's decisions, on injected time and samples. Feed it:
 *   visibility('visible'|'hidden', t)
 *   sample({ windowVisible, minimized, userActive, uncoveredPx }, t)   (while hidden)
 *   userMoved(t)
 * Each returns a list of { act: 'nudge'|'force'|'gave-up' } and
 * { ev: 'healed'|'user-fixed'|'cleared', step, hiddenMs, staleMs }.
 */
function createWatch(opts) {
  const o = Object.assign({ staleMs: 1500, verifyMs: 1200, minPx: MIN_UNCOVERED_PX }, opts || {});
  let vis = 'visible';
  let hiddenAt = 0;
  let ep = null;   // { start, stage, at, moved, gaveUp }

  const isStale = (s) => !!s && s.windowVisible && !s.minimized && s.userActive && s.uncoveredPx >= o.minPx;

  return {
    get state() { return { vis, hiddenAt, episode: ep ? Object.assign({}, ep) : null }; },
    visibility(state, t) {
      const out = [];
      if (state === vis) return out;
      vis = state === 'hidden' ? 'hidden' : 'visible';
      if (vis === 'hidden') { hiddenAt = t; ep = null; return out; }
      if (ep) {
        const base = { hiddenMs: t - hiddenAt, staleMs: t - ep.start, step: ep.stage, gaveUp: ep.gaveUp };
        if (ep.moved) out.push(Object.assign({ ev: 'user-fixed' }, base));
        else if (ep.stage >= 1) out.push(Object.assign({ ev: 'healed' }, base));
        else if (t - ep.start >= o.staleMs / 2) out.push(Object.assign({ ev: 'cleared' }, base));
      }
      ep = null;
      return out;
    },
    sample(s, t) {
      const out = [];
      if (vis !== 'hidden') return out;
      if (!isStale(s)) {
        // Really covered, minimised or nobody there: not a freeze. An episode that had
        // already acted ends quietly (the log line came with the action).
        ep = null;
        return out;
      }
      if (!ep) { ep = { start: t, stage: 0, at: t, moved: false, gaveUp: false }; return out; }
      if (ep.moved) return out;
      if (ep.stage === 0 && t - ep.start >= o.staleMs) { ep.stage = 1; ep.at = t; out.push({ act: 'nudge' }); }
      else if (ep.stage === 1 && t - ep.at >= o.verifyMs) { ep.stage = 2; ep.at = t; out.push({ act: 'force' }); }
      else if (ep.stage === 2 && t - ep.at >= o.verifyMs) { ep.stage = 3; ep.at = t; ep.gaveUp = true; out.push({ act: 'gave-up' }); }
      return out;
    },
    userMoved(t) {
      if (vis === 'hidden' && ep) ep.moved = true;
      return [];
    },
  };
}

function secs(ms) { return (Math.max(0, ms) / 1000).toFixed(1) + ' s'; }

/** The words on screen for an event (null: nothing to say on screen). */
function noticeWords(e) {
  if (!e) return null;
  if (e.ev === 'healed' || e.ev === 'woke-healed') {
    const why = e.ev === 'woke-healed' ? 'after the PC woke up, Windows still had it marked as covered'
      : 'Windows had it marked as covered while it was in front';
    return `Quartz redrew the window: it had stopped drawing for ${secs(e.hiddenMs)} (${why}).`;
  }
  if (e.ev === 'user-fixed' && e.gaveUp) {
    return `The window had stopped drawing for ${secs(e.hiddenMs)}: Windows kept it marked as covered, and Quartz could not redraw it by itself. Moving it did. The details are in freeze.log.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Win32 (koffi), bound once; null when it will not load.
// ---------------------------------------------------------------------------
let w32Cache;
function bindWin32() {
  if (w32Cache !== undefined) return w32Cache;
  w32Cache = null;
  if (process.platform !== 'win32') return null;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const gdi32 = koffi.load('gdi32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    const kernel32 = koffi.load('kernel32.dll');
    koffi.struct('FwRect', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
    koffi.struct('FwMonitorInfo', { cbSize: 'uint32_t', rcMonitor: 'FwRect', rcWork: 'FwRect', dwFlags: 'uint32_t' });
    koffi.proto('bool __stdcall FwEnumProc(void *hwnd, intptr_t lparam)');
    w32Cache = {
      koffi,
      GetWindow: user32.func('void * __stdcall GetWindow(void *h, uint32_t cmd)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *h)'),
      IsIconic: user32.func('bool __stdcall IsIconic(void *h)'),
      IsZoomed: user32.func('bool __stdcall IsZoomed(void *h)'),
      GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(void *h, int idx)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(void *h, _Out_ uint8_t *buf, int max)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(void *h, _Out_ FwRect *r)'),
      GetLayeredWindowAttributes: user32.func('bool __stdcall GetLayeredWindowAttributes(void *h, _Out_ uint32_t *key, _Out_ uint8_t *alpha, _Out_ uint32_t *flags)'),
      GetWindowRgn: user32.func('int __stdcall GetWindowRgn(void *h, void *rgn)'),
      MonitorFromWindow: user32.func('void * __stdcall MonitorFromWindow(void *h, uint32_t flags)'),
      GetMonitorInfoW: user32.func('bool __stdcall GetMonitorInfoW(void *m, _Inout_ FwMonitorInfo *mi)'),
      GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int i)'),
      GetForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()'),
      GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *h, _Out_ uint32_t *pid)'),
      NotifyWinEvent: user32.func('void __stdcall NotifyWinEvent(uint32_t ev, void *h, int32_t obj, int32_t child)'),
      InvalidateRect: user32.func('bool __stdcall InvalidateRect(void *h, void *rect, bool erase)'),
      EnumThreadWindows: user32.func('bool __stdcall EnumThreadWindows(uint32_t tid, FwEnumProc *cb, intptr_t lparam)'),
      SendMessageW: user32.func('intptr_t __stdcall SendMessageW(void *h, uint32_t msg, uintptr_t wp, intptr_t lp)'),
      RegisterPowerSettingNotification: user32.func('void * __stdcall RegisterPowerSettingNotification(void *h, uint8_t *guid, uint32_t flags)'),
      UnregisterPowerSettingNotification: user32.func('bool __stdcall UnregisterPowerSettingNotification(void *n)'),
      CreateRectRgn: gdi32.func('void * __stdcall CreateRectRgn(int a, int b, int c, int d)'),
      DeleteObject: gdi32.func('bool __stdcall DeleteObject(void *o)'),
      DwmGetWindowAttribute: dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(void *h, uint32_t attr, _Out_ int32_t *v, uint32_t size)'),
      GetCurrentThreadId: kernel32.func('uint32_t __stdcall GetCurrentThreadId()'),
      GetCurrentProcessId: kernel32.func('uint32_t __stdcall GetCurrentProcessId()'),
      ProcessIdToSessionId: kernel32.func('bool __stdcall ProcessIdToSessionId(uint32_t pid, _Out_ uint32_t *sid)'),
    };
  } catch (_) {
    w32Cache = null;
  }
  return w32Cache;
}

/** Everything canOcclude needs about one window, read through user32. */
function describe(w, h, withClass) {
  const d = { visible: false };
  try {
    d.visible = !!w.IsWindowVisible(h);
    if (!d.visible) return d;
    d.iconic = !!w.IsIconic(h);
    d.exStyle = Number(BigInt(w.GetWindowLongPtrW(h, GWL_EXSTYLE)) & 0xffffffffn);
    d.style = Number(BigInt(w.GetWindowLongPtrW(h, GWL_STYLE)) & 0xffffffffn);
    if (d.iconic || (d.exStyle & WS_EX_TRANSPARENT)) return d;
    if ((d.exStyle & WS_EX_TOOLWINDOW) || (d.style & WS_POPUP) || withClass) {
      const buf = Buffer.alloc(512);
      const n = w.GetClassNameW(h, buf, 256);
      d.className = n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
    }
    if (d.exStyle & WS_EX_LAYERED) {
      const key = [0]; const alpha = [0]; const flags = [0];
      const ok = !!w.GetLayeredWindowAttributes(h, key, alpha, flags);
      d.layered = { ok, alpha: Number(alpha[0]), flags: Number(flags[0]) };
    }
    const rgn = w.CreateRectRgn(0, 0, 0, 0);
    try { d.complexRegion = w.GetWindowRgn(h, rgn) === COMPLEXREGION; } finally { w.DeleteObject(rgn); }
    const cl = [0];
    d.cloaked = w.DwmGetWindowAttribute(h, DWMWA_CLOAKED, cl, 4) === 0 && cl[0] !== 0;
    const r = {};
    d.rect = w.GetWindowRect(h, r) ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
    if (d.rect && w.IsZoomed(h)) {
      const mi = { cbSize: 40, rcMonitor: {}, rcWork: {}, dwFlags: 0 };
      const mon = w.MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
      if (mon && w.GetMonitorInfoW(mon, mi)) d.rect = adjustToFit(d.rect, mi.rcWork);
    }
  } catch (_) { d.visible = false; }
  return d;
}

/**
 * Walk the windows above `self` and say how much of it the tracker should see.
 * { uncoveredPx, above: [{ cls, pid, rect, flags }] } or null without koffi.
 * Stops as soon as nothing is left uncovered.
 */
function measureCover(w, self, keepAbove) {
  const me = describe(w, self, false);
  if (!me.visible || !me.rect) return { uncoveredPx: 0, above: [], selfVisible: me.visible };
  const vx = w.GetSystemMetrics(SM_XVIRTUALSCREEN); const vy = w.GetSystemMetrics(SM_YVIRTUALSCREEN);
  const screen = { left: vx, top: vy, right: vx + w.GetSystemMetrics(SM_CXVIRTUALSCREEN), bottom: vy + w.GetSystemMetrics(SM_CYVIRTUALSCREEN) };
  const cuts = [];
  const above = [];
  let h = w.GetWindow(self, GW_HWNDPREV);
  let left = uncoveredPx(me.rect, [], screen);
  for (let i = 0; h && i < 3000 && left > 0; i += 1) {
    const d = describe(w, h, keepAbove);
    if (canOcclude(d)) {
      cuts.push(d.rect);
      left = uncoveredPx(me.rect, cuts, screen);
      if (keepAbove && above.length < 16) {
        const pid = [0]; try { w.GetWindowThreadProcessId(h, pid); } catch (_) { /* 0 */ }
        above.push({ cls: d.className || '?', pid: Number(pid[0]) || 0, rect: d.rect, topmost: !!(d.exStyle & 0x8) });
      }
    }
    h = w.GetWindow(h, GW_HWNDPREV);
  }
  return { uncoveredPx: left, above, selfVisible: true, selfRect: me.rect };
}

/** Our UI thread's hidden Chromium windows (gfx::SingletonHwnd is one of them). */
function chromiumHiddenWindows(w, exclude) {
  const out = [];
  try {
    w.EnumThreadWindows(w.GetCurrentThreadId(), (h) => {
      try {
        if (exclude.has(BigInt(h))) return true;
        if (w.IsWindowVisible(h)) return true;
        const buf = Buffer.alloc(512);
        const n = w.GetClassNameW(h, buf, 256);
        if (n > 0 && buf.toString('utf16le', 0, n * 2).startsWith('Chrome_WidgetWin_')) out.push(h);
      } catch (_) { /* skip */ }
      return true;
    }, 0);
  } catch (_) { /* none */ }
  return out;
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

/**
 * deps: { app, ipcMain, isChromeSender, powerMonitor, BrowserWindow, logLine, userData, isTest }
 * Returns { attachWindow(win), state(), close() }. Never throws.
 */
function install(deps) {
  const d = deps || {};
  const isTest = !!d.isTest;
  const w = bindWin32();
  const logLine = typeof d.logLine === 'function' ? d.logLine : () => {};
  let flog = null;
  try {
    const { makeRotatingFile } = require('./log');
    flog = makeRotatingFile(fs, path.join(d.userData || d.app.getPath('userData'), 'freeze.log'), { maxBytes: 256 * 1024, keep: 1 });
  } catch (_) { flog = null; }
  const note = (text) => { try { if (flog) flog.write(text); } catch (_) { /* best effort */ } };

  let win = null;
  let healOn = true;
  let forceActive = isTest && process.env.QUARTZ_TEST_FREEZE_ACTIVE === '1';
  let timer = null;
  let pendingNotice = null;
  const watch = createWatch();
  const history = [];        // [{ t, what }]
  const power = [];          // the last power messages, in arrival order: [{ t, what }]
  let lastUnmax = 0;
  let displayOff = false;    // our own display-state notification said off (and not on since)
  let powerReg = null;
  const nudges = [];         // pending wake nudges (timers)
  const counts = { nudges: 0, healed: 0, wokeHealed: 0, gaveUp: 0, userFixed: 0, remax: 0, episodes: 0 };

  const now = () => Date.now();
  const stamp = (t) => new Date(t).toISOString().slice(11, 23);
  const remember = (list, what, max) => { list.push({ t: now(), what }); while (list.length > (max || HISTORY_MAX)) list.shift(); };
  const live = () => (win && !win.isDestroyed() ? win : null);
  const handle = () => {
    const x = live();
    if (!x) return 0n;
    try { const b = x.getNativeWindowHandle(); return b && b.length >= 8 ? b.readBigUInt64LE(0) : 0n; } catch (_) { return 0n; }
  };
  const ourHandles = () => {
    const s = new Set();
    try { for (const bw of d.BrowserWindow.getAllWindows()) { try { s.add(bw.getNativeWindowHandle().readBigUInt64LE(0)); } catch (_) { /* skip */ } } } catch (_) { /* none */ }
    return s;
  };
  const userActive = () => {
    if (displayOff) return false;   // a dark screen is not a freeze, and Chromium must never be told otherwise
    if (forceActive) return true;
    try { return d.powerMonitor.getSystemIdleState(ACTIVE_WITHIN_S) === 'active'; } catch (_) { return false; }
  };
  const recentPower = (t) => power.filter((p) => t - p.t < 120000).map((p) => `${p.what} ${((p.t - t) / 1000).toFixed(1)}s`).join(', ') || 'none in the last 2 min';
  const recentVis = (t) => history.slice(-6).map((h) => `${h.what} ${((h.t - t) / 1000).toFixed(1)}s`).join(', ');

  function send(channel, payload) {
    const x = live();
    if (!x) return;
    try { x.webContents.send(channel, payload); } catch (_) { /* window going */ }
  }
  function sayOnScreen(e) {
    const text = noticeWords(e);
    if (!text) return;
    if (watch.state.vis === 'visible') send('freeze:notice', { text, ms: 7000 });
    else pendingNotice = text;   // drawn the moment the window draws again
  }

  /** The tracker recomputes; the window redraws in full. Invisible either way. */
  function nudge(why) {
    const h = handle();
    if (!w || !h) return false;
    counts.nudges += 1;
    try { w.NotifyWinEvent(EVENT_SYSTEM_CAPTUREEND, h, OBJID_WINDOW, CHILDID_SELF); } catch (_) { return false; }
    try { w.InvalidateRect(h, null, false); } catch (_) { /* the nudge alone */ }
    remember(history, 'nudge:' + why);
    return true;
  }

  /** Tell Chromium (its own hidden windows, this process only) the display is on and the session unlocked. */
  function synth(kind) {
    if (!w) return 0;
    const targets = chromiumHiddenWindows(w, ourHandles());
    let sent = 0;
    for (const t of targets) {
      try {
        if (kind === 'display-on' || kind === 'display-off') {
          const b = Buffer.alloc(24);
          GUID_SESSION_DISPLAY_STATUS.copy(b, 0);
          b.writeUInt32LE(4, 16);
          b.writeUInt32LE(kind === 'display-on' ? 1 : 0, 20);
          w.SendMessageW(t, WM_POWERBROADCAST, PBT_POWERSETTINGCHANGE, w.koffi.address(b));
        } else if (kind === 'resume') {
          w.SendMessageW(t, WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC, 0);
        } else if (kind === 'suspend') {
          w.SendMessageW(t, WM_POWERBROADCAST, PBT_APMSUSPEND, 0);
        } else if (kind === 'unlock' || kind === 'lock') {
          const sid = [0];
          w.ProcessIdToSessionId(w.GetCurrentProcessId(), sid);
          w.SendMessageW(t, WM_WTSSESSION_CHANGE, kind === 'unlock' ? WTS_SESSION_UNLOCK : WTS_SESSION_LOCK, Number(sid[0]));
        }
        sent += 1;
      } catch (_) { /* next */ }
    }
    return sent;
  }

  function coverNow(keepAbove) {
    const h = handle();
    if (!w || !h) return null;
    try { return measureCover(w, h, keepAbove); } catch (_) { return null; }
  }
  function aboveWords(m) {
    if (!m || !m.above || !m.above.length) return 'nothing above it counts as covering';
    return m.above.map((a) => `${a.cls}#${a.pid}${a.topmost ? '(top)' : ''}[${a.rect.left},${a.rect.top} ${a.rect.right - a.rect.left}x${a.rect.bottom - a.rect.top}]`).join(' ');
  }

  function handleEvents(list, t) {
    for (const e of list) {
      if (e.ev === 'healed') {
        counts.healed += 1;
        const line = `Freeze: the window had stopped drawing for ${secs(e.hiddenMs)} while nothing covered it; Quartz's ${e.step >= 2 ? 'second' : 'first'} nudge redrew it.`;
        logLine(line);
        note(`HEALED step=${e.step} hidden=${secs(e.hiddenMs)} stale=${secs(e.staleMs)} power=[${recentPower(t)}]`);
        sayOnScreen(e);
      } else if (e.ev === 'user-fixed') {
        counts.userFixed += 1;
        logLine(`Freeze: the window had stopped drawing for ${secs(e.hiddenMs)} while nothing covered it; it drew again when it was moved${e.gaveUp ? ' (Quartz\'s own redraw had not worked)' : ''}.`);
        note(`USER-FIXED hidden=${secs(e.hiddenMs)} stale=${secs(e.staleMs)} nudged=${e.step} gaveUp=${!!e.gaveUp} power=[${recentPower(t)}]`);
        sayOnScreen(e);
      } else if (e.ev === 'cleared') {
        note(`CLEARED by itself hidden=${secs(e.hiddenMs)} stale=${secs(e.staleMs)}`);
      }
    }
  }

  function act(list, t) {
    for (const a of list) {
      if (!healOn) { note(`WOULD-${a.act.toUpperCase()} (healing off in this test run)`); continue; }
      if (a.act === 'nudge') {
        counts.episodes += 1;
        const m = coverNow(true);
        note(`STALE: the page says hidden, the window is shown and ${m ? m.uncoveredPx : '?'} px of it are uncovered; user active; fg=${fgWords()}; above: ${aboveWords(m)}; power=[${recentPower(t)}]; visibility=[${recentVis(t)}] -> nudge`);
        nudge('stale');
      } else if (a.act === 'force') {
        const n1 = synth('display-on');
        const n2 = synth('unlock');
        nudge('force');
        note(`STILL HIDDEN after the nudge -> told Chromium display on + session unlocked (${n1}/${n2} of its windows) and nudged again`);
      } else if (a.act === 'gave-up') {
        counts.gaveUp += 1;
        const m = coverNow(true);
        logLine('Freeze: the window stopped drawing while nothing covered it, and Quartz could not redraw it by itself (details in freeze.log).');
        note(`GAVE UP: still hidden; ${m ? m.uncoveredPx : '?'} px uncovered; above: ${aboveWords(m)}; gpu=${gpuWords()}`);
      }
    }
  }

  function fgWords() {
    if (!w) return '?';
    try { const f = BigInt(w.GetForegroundWindow() || 0n); return f === handle() ? 'this window' : (f ? 'another window' : 'none'); } catch (_) { return '?'; }
  }
  function gpuWords() {
    try {
      const g = (d.app.getAppMetrics() || []).find((m) => m.type === 'GPU');
      const st = d.app.getGPUFeatureStatus() || {};
      return `${g ? `process ${g.pid} since ${stamp(g.creationTime)}` : 'no GPU process'}; gpu_compositing=${st.gpu_compositing || '?'}`;
    } catch (_) { return '?'; }
  }

  function tick() {
    timer = null;
    if (watch.state.vis !== 'hidden' || !live()) return;
    const t = now();
    const x = live();
    let s;
    try {
      const minimized = x.isMinimized();
      const shown = x.isVisible();
      const active = userActive();
      // The walk is only paid for when it could matter.
      const m = shown && !minimized && active ? coverNow(false) : null;
      s = { windowVisible: shown, minimized, userActive: active, uncoveredPx: m ? m.uncoveredPx : 0 };
    } catch (_) { s = null; }
    act(watch.sample(s, t), t);
    schedule();
  }
  function schedule() {
    if (timer || !w) return;
    timer = setTimeout(tick, SAMPLE_MS);
    if (timer.unref) timer.unref();
  }

  function onVisibility(state) {
    const t = now();
    const prev = watch.state.vis;
    remember(history, state);
    let events = watch.visibility(state, t);
    if (state === 'hidden') schedule();
    else if (pendingNotice) { send('freeze:notice', { text: pendingNotice, ms: 9000 }); pendingNotice = null; }
    // A flip right after a wake nudge is credited to it (and said once, not twice).
    if (prev === 'hidden' && state === 'visible') {
      const n = nudges.find((x) => x.firedAt && t - x.firedAt <= CREDIT_MS && x.wasHidden);
      if (n) {
        counts.wokeHealed += 1;
        const e = { ev: 'woke-healed', hiddenMs: t - n.hiddenSince };
        logLine(`Freeze: after ${n.why}, the window was still marked as covered; Quartz's nudge ${n.n} redrew it.`);
        note(`WOKE-HEALED after=${n.why} nudge=${n.n} hidden=${secs(e.hiddenMs)} power=[${recentPower(t)}]`);
        sayOnScreen(e);
        events = events.filter((x) => x.ev !== 'healed');
      }
    }
    handleEvents(events, t);
  }

  /** Wake, unlock, display on: the three nudges. */
  function onWake(why) {
    for (const n of nudges) clearTimeout(n.timer);
    nudges.length = 0;
    if (!healOn || !w) return;
    WAKE_NUDGES_MS.forEach((ms, i) => {
      const n = { why, n: i + 1, firedAt: 0, wasHidden: false, hiddenSince: 0 };
      n.timer = setTimeout(() => {
        const x = live();
        if (!x || !healOn || displayOff) return;
        try { if (x.isMinimized() || !x.isVisible()) return; } catch (_) { return; }
        n.wasHidden = watch.state.vis === 'hidden';
        n.hiddenSince = watch.state.hiddenAt;
        n.firedAt = now();
        nudge('wake' + n.n);
      }, ms);
      if (n.timer.unref) n.timer.unref();
      nudges.push(n);
    });
  }

  function onPowerMessage(wp, lp) {
    try {
      const code = Number(wp.readBigUInt64LE ? wp.readBigUInt64LE(0) : 0n);
      if (code === PBT_POWERSETTINGCHANGE && w) {
        const addr = lp.readBigUInt64LE(0);
        if (!addr) return;
        const raw = Buffer.from(w.koffi.decode(addr, 'uint8_t', 21));
        if (!raw.subarray(0, 16).equals(GUID_SESSION_DISPLAY_STATUS)) return;
        const on = raw[20] !== 0;
        remember(power, on ? 'display-on' : 'display-off', 12);
        displayOff = !on;
        if (on) onWake('the display came back on');
      } else if (code === PBT_APMRESUMEAUTOMATIC) {
        remember(power, 'resume', 12);
      } else if (code === PBT_APMSUSPEND) {
        remember(power, 'suspend', 12);
      }
    } catch (_) { /* unreadable: nothing to record */ }
  }

  if (d.powerMonitor) {
    try {
      d.powerMonitor.on('resume', () => onWake('the PC woke up'));
      d.powerMonitor.on('unlock-screen', () => { remember(power, 'unlock', 12); onWake('the PC was unlocked'); });
      d.powerMonitor.on('lock-screen', () => remember(power, 'lock', 12));
    } catch (_) { /* no power events: the watch still runs */ }
  }

  if (d.ipcMain) {
    d.ipcMain.on('freeze:vis', (event, payload) => {
      if (d.isChromeSender && !d.isChromeSender(event)) return;
      const st = payload && payload.state === 'hidden' ? 'hidden' : 'visible';
      onVisibility(st);
    });
    // Test runs only: drive and read the watch (freezewatch-e2e.js).
    d.ipcMain.handle('freeze:test', (event, req) => {
      if (!isTest) return { ok: false, reason: 'not a test run' };
      if (d.isChromeSender && !d.isChromeSender(event)) return { ok: false, reason: 'not the chrome' };
      const r = req || {};
      if (r.op === 'heal') {
        healOn = !!r.on;
        if (!healOn) { for (const n of nudges) clearTimeout(n.timer); nudges.length = 0; }
        return { ok: true, healOn };
      }
      if (r.op === 'active') { forceActive = !!r.on; return { ok: true }; }
      if (r.op === 'nudge') return { ok: nudge('test') };
      if (r.op === 'drag') {
        // The two events a real drag raises, with no move: what the user's fix tells the tracker.
        const h = handle();
        if (!w || !h) return { ok: false };
        w.NotifyWinEvent(0x000A /* EVENT_SYSTEM_MOVESIZESTART */, h, OBJID_WINDOW, CHILDID_SELF);
        w.NotifyWinEvent(0x000B /* EVENT_SYSTEM_MOVESIZEEND */, h, OBJID_WINDOW, CHILDID_SELF);
        return { ok: true };
      }
      if (r.op === 'sim') {
        // Back to back, in one turn -- the way queued messages land when the PC thaws.
        const sent = (r.seq || []).map((k) => synth(k));
        if (r.alsoWake) onWake('the PC woke up (simulated)');
        return { ok: true, sent };
      }
      if (r.op === 'cover') { const m = coverNow(true); return { ok: !!m, cover: m }; }
      if (r.op === 'state') return { ok: true, koffi: !!w, healOn, watch: watch.state, counts: Object.assign({}, counts), history: history.slice(), power: power.slice() };
      return { ok: false, reason: 'unknown op' };
    });
  }

  function attachWindow(bw) {
    win = bw;
    try {
      bw.on('will-move', () => watch.userMoved(now()));
      bw.on('will-resize', () => watch.userMoved(now()));
      bw.on('unmaximize', () => { lastUnmax = now(); });
      bw.on('maximize', () => {
        const t = now();
        if (lastUnmax && t - lastUnmax <= REMAX_WINDOW_MS) {
          counts.remax += 1;
          note(`RE-MAXIMIZED by hand ${secs(t - lastUnmax)} after un-maximizing (the manual redraw). Page now: ${watch.state.vis}; visibility=[${recentVis(t)}]; power=[${recentPower(t)}]; gpu=${gpuWords()}`);
          logLine(`The window was un-maximized and maximized again within ${secs(t - lastUnmax)}; the page reported itself ${watch.state.vis} (freeze.log has the history).`);
        }
        lastUnmax = 0;
      });
      if (process.platform === 'win32' && typeof bw.hookWindowMessage === 'function') {
        bw.hookWindowMessage(WM_POWERBROADCAST, onPowerMessage);
        const h = handle();
        if (w && h) {
          try { powerReg = w.RegisterPowerSettingNotification(h, GUID_SESSION_DISPLAY_STATUS, 0) || null; } catch (_) { powerReg = null; }
        }
      }
      bw.on('closed', () => {
        if (powerReg && w) { try { w.UnregisterPowerSettingNotification(powerReg); } catch (_) { /* going */ } }
        powerReg = null;
        win = null;
      });
    } catch (_) { /* the watch is best effort */ }
    if (!w) note('koffi is not available: the freeze watch only records (no nudges, no cover check).');
  }

  return {
    attachWindow,
    state: () => ({ koffi: !!w, watch: watch.state, counts: Object.assign({}, counts) }),
    close() { if (timer) clearTimeout(timer); timer = null; for (const n of nudges) clearTimeout(n.timer); nudges.length = 0; },
  };
}

module.exports = {
  install, canOcclude, uncoveredPx, subtract, adjustToFit, createWatch, noticeWords,
  WAKE_NUDGES_MS, MIN_UNCOVERED_PX,
  _measureCover: measureCover, _bindWin32: bindWin32,
};
