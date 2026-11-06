// freezewatch-harness.js -- the pure half of freezewatch.js, no Electron.
//
//   node freezewatch-harness.js
//
// 1. canOcclude mirrors Chromium 152's gfx::IsWindowVisibleAndFullyOpaque, rule by rule.
// 2. uncoveredPx / subtract / adjustToFit: the region left of a window under others.
// 3. createWatch: stale for 1.5 s -> nudge; still hidden -> force; -> gave up; what each
//    way back to visible is called; covered, minimised or idle is never a freeze.
// 4. noticeWords: what is said on screen, and when nothing is.
// 5. On Windows with koffi: a read-only cover measure of the current foreground window
//    returns numbers (no window is touched).
// One summary line: "freezewatch-harness: N passed, M failed".
'use strict';
const fw = require('./freezewatch');

let passed = 0;
let failed = 0;
function check(cond, name, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : '')); }
}

// ---- 1. canOcclude ---------------------------------------------------------
const R = { left: 0, top: 0, right: 800, bottom: 600 };
const base = { visible: true, iconic: false, style: 0x14cf0000, exStyle: 0, className: 'Chrome_WidgetWin_1', layered: null, complexRegion: false, cloaked: false, rect: R };
const w = (over) => Object.assign({}, base, over);
check(fw.canOcclude(w({})) === true, 'a plain shown window covers');
check(!fw.canOcclude(w({ visible: false })), 'hidden: no');
check(!fw.canOcclude(w({ iconic: true })), 'minimised: no');
check(!fw.canOcclude(w({ exStyle: 0x20 })), 'WS_EX_TRANSPARENT (click-through): no');
check(!fw.canOcclude(w({ exStyle: 0x80 })), 'tool window: no');
check(fw.canOcclude(w({ exStyle: 0x80, className: 'Shell_TrayWnd' })), 'the taskbar tool window: yes');
check(!fw.canOcclude(w({ exStyle: 0x80000, layered: { ok: false } })), 'layered, attributes unreadable (UpdateLayeredWindow): no');
check(!fw.canOcclude(w({ exStyle: 0x80000, layered: { ok: true, alpha: 200, flags: 2 } })), 'layered, alpha 200: no');
check(fw.canOcclude(w({ exStyle: 0x80000, layered: { ok: true, alpha: 255, flags: 2 } })), 'layered, alpha 255: yes');
check(!fw.canOcclude(w({ exStyle: 0x80000, layered: { ok: true, alpha: 255, flags: 1 } })), 'layered, colour key: no');
check(!fw.canOcclude(w({ complexRegion: true })), 'complex window region: no');
check(!fw.canOcclude(w({ cloaked: true })), 'cloaked (other desktop): no');
check(!fw.canOcclude(w({ rect: { left: 5, top: 5, right: 5, bottom: 90 } })), 'empty rect: no');
check(!fw.canOcclude(w({ style: 0x80000000 | 0x10000000, className: 'SomePopup' })), 'a popup of another kind: no');
check(fw.canOcclude(w({ style: 0x80000000 | 0x10000000, className: 'Chrome_WidgetWin_1' })), 'a Chromium/Electron popup: yes');
check(fw.canOcclude(w({ exStyle: 0x8 })), 'topmost alone changes nothing: yes');

// ---- 2. region -------------------------------------------------------------
const screen = { left: 0, top: 0, right: 1920, bottom: 1080 };
const self = { left: -9, top: -9, right: 1929, bottom: 1089 };   // a maximised window's overhang
check(fw.uncoveredPx(self, [], screen) === 1920 * 1080, 'clipped to the screen', fw.uncoveredPx(self, [], screen));
check(fw.uncoveredPx(self, [screen], screen) === 0, 'a full-screen cover leaves nothing');
check(fw.uncoveredPx(self, [{ left: 0, top: 0, right: 1920, bottom: 40 }], screen) === 1920 * 1040, 'a 40px bar leaves the rest');
check(fw.uncoveredPx(self, [{ left: 0, top: 0, right: 1000, bottom: 1080 }, { left: 1000, top: 0, right: 1920, bottom: 1080 }], screen) === 0, 'two halves cover it');
check(fw.uncoveredPx(self, [{ left: 0, top: 0, right: 1000, bottom: 1080 }, { left: 1001, top: 0, right: 1920, bottom: 1080 }], screen) === 1080, 'a 1px gap is still visible (1080 px)');
check(fw.uncoveredPx({ left: 3000, top: 0, right: 3500, bottom: 500 }, [], screen) === 0, 'entirely off screen: nothing');
const sub = fw.subtract({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 2, top: 2, right: 8, bottom: 8 });
check(sub.length === 4 && sub.reduce((s, r) => s + (r.right - r.left) * (r.bottom - r.top), 0) === 64, 'a hole cuts into four rects of 64 px');
const fit = fw.adjustToFit(self, { left: 0, top: 40, right: 1920, bottom: 1032 });
check(fit.left === 0 && fit.top === 40 && fit.right === 1920 && fit.bottom === 1032, 'adjustToFit: a maximised rect becomes the work area', fit);

// ---- 3. createWatch --------------------------------------------------------
const stale = { windowVisible: true, minimized: false, userActive: true, uncoveredPx: 500000 };
function run(steps) {
  const watch = fw.createWatch();
  const out = [];
  for (const [t, kind, arg] of steps) {
    const r = kind === 'vis' ? watch.visibility(arg, t) : kind === 'move' ? watch.userMoved(t) : watch.sample(arg, t);
    for (const x of r) out.push(Object.assign({ t }, x));
  }
  return out;
}
let o = run([[0, 'vis', 'hidden'], [1000, 's', stale], [2000, 's', stale], [2600, 's', stale], [3000, 'vis', 'visible']]);
check(o.length === 2 && o[0].act === 'nudge' && o[0].t === 2600 && o[1].ev === 'healed' && o[1].step === 1 && o[1].hiddenMs === 3000,
  'stale from 1.0 s: nudged at 2.6 s; visible after it = healed, step 1, hidden 3.0 s', o);
o = run([[0, 'vis', 'hidden'], [0, 's', stale], [1500, 's', stale], [2700, 's', stale], [3900, 's', stale], [5000, 's', stale]]);
check(o.map((x) => x.act).join() === 'nudge,force,gave-up', 'still hidden: nudge, then force, then gave up (once)', o);
o = run([[0, 'vis', 'hidden'], [0, 's', stale], [1500, 's', stale], [2700, 's', stale], [3900, 's', stale], [4200, 'move'], [4400, 'vis', 'visible']]);
check(o.length === 4 && o[3].ev === 'user-fixed' && o[3].gaveUp === true, 'after the give-up, the user moving it = user-fixed, gaveUp', o);
o = run([[0, 'vis', 'hidden'], [0, 's', stale], [800, 'move'], [1200, 's', stale], [2000, 's', stale], [2100, 'vis', 'visible']]);
check(o.length === 1 && o[0].ev === 'user-fixed' && !o[0].gaveUp, 'the user moving it first: no nudge of ours, user-fixed', o);
const covered = Object.assign({}, stale, { uncoveredPx: 0 });
o = run([[0, 'vis', 'hidden'], [0, 's', covered], [2000, 's', covered], [5000, 's', covered], [6000, 'vis', 'visible']]);
check(o.length === 0, 'really covered: nothing at all', o);
o = run([[0, 'vis', 'hidden'], [0, 's', Object.assign({}, stale, { uncoveredPx: 1000 })], [3000, 's', Object.assign({}, stale, { uncoveredPx: 1000 })]]);
check(o.length === 0, 'a 1000 px sliver is treated as covered', o);
o = run([[0, 'vis', 'hidden'], [0, 's', Object.assign({}, stale, { minimized: true })], [3000, 's', Object.assign({}, stale, { minimized: true })]]);
check(o.length === 0, 'minimised: nothing', o);
o = run([[0, 'vis', 'hidden'], [0, 's', Object.assign({}, stale, { userActive: false })], [3000, 's', Object.assign({}, stale, { userActive: false })]]);
check(o.length === 0, 'nobody at the PC (idle or locked): nothing', o);
o = run([[0, 'vis', 'hidden'], [0, 's', stale], [1000, 's', covered], [2000, 's', stale], [3000, 's', stale], [3600, 's', stale]]);
check(o.length === 1 && o[0].act === 'nudge' && o[0].t === 3600, 'a covered sample restarts the clock (nudge 1.5 s after it is stale again)', o);
o = run([[0, 'vis', 'hidden'], [0, 's', stale], [1000, 'vis', 'visible']]);
check(o.length === 1 && o[0].ev === 'cleared', 'cleared by itself after 1 s: logged as cleared, not healed', o);
o = run([[0, 'vis', 'hidden'], [0, 's', stale], [300, 'vis', 'visible']]);
check(o.length === 0, 'a flicker under 0.75 s: nothing', o);
o = run([[0, 's', stale], [5000, 's', stale]]);
check(o.length === 0, 'samples while visible do nothing', o);

// ---- 4. words --------------------------------------------------------------
const h = fw.noticeWords({ ev: 'healed', hiddenMs: 4200 });
check(/redrew the window/.test(h) && /4\.2 s/.test(h) && /covered/.test(h), 'healed: plain words with the time', h);
const wk = fw.noticeWords({ ev: 'woke-healed', hiddenMs: 900 });
check(/woke up/.test(wk), 'after a wake: says so', wk);
check(/could not redraw/.test(fw.noticeWords({ ev: 'user-fixed', gaveUp: true, hiddenMs: 9000 })), 'give-up then moved: says Quartz could not');
check(fw.noticeWords({ ev: 'user-fixed', gaveUp: false, hiddenMs: 900 }) === null, 'the user fixed it before Quartz tried: nothing on screen');
check(fw.noticeWords({ ev: 'cleared', hiddenMs: 900 }) === null, 'cleared by itself: nothing on screen');

// ---- 5. live, read-only ----------------------------------------------------
const w32 = process.platform === 'win32' ? fw._bindWin32() : null;
if (w32) {
  const fg = w32.GetForegroundWindow();
  if (fg) {
    const m = fw._measureCover(w32, fg, true);
    check(m && Number.isFinite(m.uncoveredPx) && Array.isArray(m.above), 'koffi: the foreground window measures (read-only)', m && { px: m.uncoveredPx, above: m.above.length });
  } else {
    console.log('  SKIP koffi live measure: no foreground window in this session');
  }
} else {
  console.log('  SKIP koffi live measure: ' + (process.platform === 'win32' ? 'koffi did not load' : 'not Windows'));
}

console.log(`freezewatch-harness: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
