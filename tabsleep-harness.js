'use strict';
// tabsleep-harness.js - the boot and background sleep DECISIONS in app.js, pure node, no Quartz.
//   node tabsleep-harness.js
// app.js is a plain renderer script (no exports), so the pure pieces are cut out of its source
// by name and run in a vm: restoreAsleepRows() (lazy restore: which stored rows are born asleep
// and which one is predicted in front), newTabSleepVerdict() (what to do with a new tab page
// that has sat in the background), and HOME_BUSY_PROBE (the page-side check that keeps a Home
// holding typed text awake), run against a tiny fake document.
// Plus the early rules (memoryPressure / earlySleepPlan: memory low, very heavy pages), the probe-gated
// sweep (sleepTabChecked with main faked: busy, no answer, retry timing, reasons shown and logged),
// the speaker following Chromium (setTabHeard), the sound rule (Chromium's audibility decides, a
// stuck media flag never holds a tab awake, the flag only where Chromium cannot be read, a
// playing stream never sleeps), and tabsleep-main.js: tabMemory, the
// isolated-world PROBE and its input TRACKER, against small fakes.
// The live paths (a real restore, a real sleep and wake) are sessions-e2e.js / sleep-e2e.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail))); }
}

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

/** The source of `function <name>(...) { ... }`, by brace matching from its first `{`. */
function cutFunction(name) {
  const at = src.indexOf('\nfunction ' + name + '(');
  if (at === -1) throw new Error('app.js has no function ' + name);
  let i = src.indexOf('{', src.indexOf(')', at));
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at + 1, i + 1); }
  }
  throw new Error('unbalanced ' + name);
}
function cutConst(name, endMarker) {
  const at = src.indexOf('\nconst ' + name + ' = ');
  if (at === -1) throw new Error('app.js has no const ' + name);
  const end = src.indexOf(endMarker, at);
  return src.slice(at + 1, end + endMarker.length);
}

const ctx = vm.createContext({});
vm.runInContext(
  cutFunction('restoreAsleepRows') + '\n' + cutFunction('newTabSleepVerdict') + '\n'
  + cutConst('HOME_BUSY_PROBE', "'})()';") + '\n'
  + 'this.restoreAsleepRows = restoreAsleepRows; this.newTabSleepVerdict = newTabSleepVerdict;'
  + ' this.HOME_BUSY_PROBE = HOME_BUSY_PROBE;', ctx);
const { restoreAsleepRows, newTabSleepVerdict, HOME_BUSY_PROBE } = ctx;

const rows = (entries) => entries.map((entry, index) => ({ entry, index }));
const sorted = (set) => Array.from(set).sort((a, b) => a - b);

// --- lazy restore ---------------------------------------------------------
{
  // Five pages in Home, the third in front: only it is awake.
  const r = rows([{ url: 'a', ws: 'home' }, { url: 'b', ws: 'home' }, { url: 'c', ws: 'home' }, { url: 'd', ws: 'home' }, { url: 'e', ws: 'home' }]);
  const p = restoreAsleepRows(r, 2, 'home', true, true);
  ok('5 tabs: front is the stored active row', p.front === 2, p.front);
  ok('5 tabs: the other 4 are born asleep', JSON.stringify(sorted(p.asleep)) === '[0,1,3,4]', sorted(p.asleep));
  ok('5 tabs: exactly 1 awake', r.length - p.asleep.size === 1);
  // Lazy off (a sleep setting is off): the current workspace comes back awake, as before.
  const off = restoreAsleepRows(r, 2, 'home', true, false);
  ok('lazy off: nothing in the current workspace is born asleep', off.asleep.size === 0, sorted(off.asleep));
  // Both off (workspaceSleep "off"): nothing at all.
  ok('workspaceSleep off: nothing born asleep', restoreAsleepRows(r, 2, 'home', false, false).asleep.size === 0);
}
{
  // Other workspaces: born asleep exactly as before, pinned or not.
  const r = rows([{ url: 'p', ws: 'home', pinned: true }, { url: 'a', ws: 'home' }, { url: 'x', ws: 'ws2', pinned: true }, { url: 'y', ws: 'ws2' }, { url: 'b', ws: 'home' }]);
  const p = restoreAsleepRows(r, 4, 'home', true, true);
  ok('pinned in the current workspace stays awake', !p.asleep.has(0));
  ok('non-front page in the current workspace sleeps', p.asleep.has(1));
  ok('other workspace: pinned and plain both asleep', p.asleep.has(2) && p.asleep.has(3));
  ok('front awake', p.front === 4 && !p.asleep.has(4));
  const old = restoreAsleepRows(r, 4, 'home', true, false);
  ok('lazy off: only the other workspace sleeps (old rule)', JSON.stringify(sorted(old.asleep)) === '[2,3]', sorted(old.asleep));
}
{
  // Claude panes and native app tabs are never born asleep, in either workspace.
  const r = rows([{ claude: true, ws: 'home' }, { native: 'app1', ws: 'home' }, { url: 'a', ws: 'home' }, { claude: true, ws: 'ws2' }, { native: 'app2', ws: 'ws2' }, { url: 'b', ws: 'home' }]);
  const p = restoreAsleepRows(r, 5, 'home', true, true);
  ok('claude + native never born asleep', ![0, 1, 3, 4].some((i) => p.asleep.has(i)), sorted(p.asleep));
  ok('page beside them sleeps', p.asleep.has(2) && !p.asleep.has(5));
}
{
  // Active row in another workspace (or missing): the front is the LAST row of the current one,
  // which is what restoreSession() raises afterwards.
  const r = rows([{ url: 'a', ws: 'home' }, { url: 'b', ws: 'home' }, { url: 'x', ws: 'ws2' }]);
  const p = restoreAsleepRows(r, 2, 'home', true, true);
  ok('active elsewhere: front = last row of current', p.front === 1, p.front);
  ok('active elsewhere: that row awake, the other asleep', !p.asleep.has(1) && p.asleep.has(0));
  const q = restoreAsleepRows(r, -1, 'home', true, true);
  ok('no active (-1): front = last row of current', q.front === 1, q.front);
  // Nothing in the current workspace: the pool is every row, the active one wins.
  const s = restoreAsleepRows(r, 2, 'gone', true, true);
  ok('empty current workspace: active row is the front', s.front === 2, s.front);
  // ...and it is born asleep by the OTHER-workspace rule; activateTab() wakes it (one renderer).
  ok('empty current workspace: every page asleep, activation wakes one', s.asleep.size === 3);
}
{
  // The front row may be pinned or a new tab page; build order is pinned first.
  const r = [{ entry: { url: 'p', ws: 'home', pinned: true }, index: 3 }, { entry: { url: 'a', ws: 'home' }, index: 0 }, { entry: { url: 'newtab', ws: 'home' }, index: 1 }, { entry: { url: 'c', ws: 'home' }, index: 2 }];
  const p = restoreAsleepRows(r, 1, 'home', true, true);
  ok('pinned-first order: front follows the stored index', p.front === 1);
  ok('pinned-first order: asleep = the two plain pages', JSON.stringify(sorted(p.asleep)) === '[0,2]', sorted(p.asleep));
  ok('empty list: no front, nothing asleep', restoreAsleepRows([], 0, 'home', true, true).front === -1);
}
{
  // restoreSession() actually uses the plan (source check, the e2e proves it live).
  const body = cutFunction('restoreSession');
  ok('restoreSession builds from restoreAsleepRows', /restoreAsleepRows\(building, session\.active, wantCurrent, sleepOthers, lazyRestore, RESTORE_AWAKE_MAX\)/.test(body));
  ok('restoreSession: bornAsleep comes from the plan', /const bornAsleep = plan\.asleep\.has\(row\.index\)/.test(body));
  ok('restoreSession: lazy gate is backgroundSleepAllowed()', /lazyRestore = backgroundSleepAllowed\(\)/.test(body));
  const gate = cutFunction('backgroundSleepAllowed');
  ok('gate: off when workspaceSleep is off or tab sleep is Never', /workspaceSleepMode\(\) !== 'off' && tabSleepMinutes\(\) > 0/.test(gate));
}

// --- new tab page backgrounded ---------------------------------------------
{
  const base = { gone: false, allowed: true, asleep: false, onScreen: false, newTab: true, inCurrentWorkspace: true, broken: false, ready: true };
  const v = (over) => newTabSleepVerdict(Object.assign({}, base, over));
  ok('eligible background Home: probe', v({}) === 'probe');
  ok('closed: skip', v({ gone: true }) === 'skip');
  ok('setting off: skip', v({ allowed: false }) === 'skip');
  ok('back in front: skip', v({ onScreen: true }) === 'skip');
  ok('already asleep: skip', v({ asleep: true }) === 'skip');
  ok('navigated to a site: skip (idle rule owns it)', v({ newTab: false }) === 'skip');
  ok('other workspace: skip (workspace policy owns it)', v({ inCurrentWorkspace: false }) === 'skip');
  ok('crash card: skip', v({ broken: true }) === 'skip');
  ok('still loading: retry', v({ ready: false }) === 'retry');
  ok('null facts: skip', newTabSleepVerdict(null) === 'skip');
}
{
  // The probe, against a fake document.
  const run = (doc) => vm.runInNewContext(HOME_BUSY_PROBE, { document: doc });
  const fakeDoc = (inputs, editables, dialog) => ({
    querySelectorAll: (sel) => (sel === 'input, textarea' ? inputs : (sel === '[contenteditable]' ? editables : [])),
    querySelector: (sel) => (sel === 'dialog[open]' && dialog ? {} : null)
  });
  ok('probe: empty Home is free to sleep', run(fakeDoc([{ type: 'text', value: '', defaultValue: '' }], [], false)) === '');
  ok('probe: typed text keeps it awake', run(fakeDoc([{ type: 'text', value: 'half a url', defaultValue: '' }], [], false)) === 'unsaved text');
  ok('probe: a prefilled default is not "typed"', run(fakeDoc([{ type: 'text', value: 'x', defaultValue: 'x' }], [], false)) === '');
  ok('probe: checkbox / hidden ignored', run(fakeDoc([{ type: 'checkbox', value: 'on', defaultValue: '' }, { type: 'hidden', value: 'v', defaultValue: '' }], [], false)) === '');
  ok('probe: textarea draft keeps it awake', run(fakeDoc([{ type: 'textarea', value: 'note', defaultValue: '' }], [], false)) === 'unsaved text');
  ok('probe: contenteditable with text keeps it awake', run(fakeDoc([], [{ isContentEditable: true, textContent: ' draft ' }], false)) === 'unsaved text');
  ok('probe: open dialog keeps it awake', run(fakeDoc([], [], true)) === 'an open dialog');
}
{
  // The wiring: activateTab hands the outgoing tab to the rule, sleepTab stops the clock.
  const act = cutFunction('activateTab');
  ok('activateTab: outgoing tab goes to noteTabBackgrounded', /noteTabBackgrounded\(outgoing\)/.test(act));
  ok('activateTab: incoming tab stops its clock', /cancelNewTabSleep\(target\)/.test(act));
  ok('sleepTab: cancels the clock', /cancelNewTabSleep\(tab\)/.test(cutFunction('sleepTab')));
  const sl = cutFunction('sleepBackgroundNewTab');
  ok('sleepBackgroundNewTab: re-checks after the probe answers', (sl.match(/newTabSleepVerdict\(newTabSleepFacts\(tab\)\)/g) || []).length >= 2);
  ok('sleepBackgroundNewTab: a refusal is logged, not swallowed', /tab-sleep-skipped/.test(sl));
}

// --- the idle sweep, with a fake clock and a fake strip ------------------------------------
// The real tabIdleSince / noteScreenEdges / canSleepTab / sleepIdleTabs (and the sound rules),
// cut from app.js and run against plain objects. sleepTab is a stub that records.
const MIN = 60000;
const AUDIBLE_SPARE_OK = 2 * MIN; // the promise: never slept less than 2 min after the sound really stopped
function sweepWorld() {
  const w = vm.createContext({});
  w.clock = 0;
  vm.runInContext(`
    var clockNow = 0;
    var Date = { now: () => clockNow };
    var tabs = [];
    var activeTabId = null;
    var slept = [];
    var settings = { tabSleepMinutes: 15 };
    function settingGet(k) { return settings[k]; }
    function splitPartner(t) { return t.splitWith ? tabs.find((x) => x.id === t.splitWith) || null : null; }
    function isNewTabUrl(u) { return /newtab/.test(String(u || '')); }
    function readCurrentUrl(t) { return t ? t.url : ''; }
    function isViewUsable(t) { return !!(t && t.kind === 'page' && !t.asleep && t.ready && t.viewEl); }
    function sleepTab(t, why, opts) { if (typeof tabSoundReason === 'function' && tabSoundReason(t)) return false; t.asleep = true; slept.push({ id: t.id, at: clockNow, why, note: (opts && opts.note) || '' }); return true; }
    // Main's half, faked with SYNCHRONOUS thenables so a sweep's sleeps land before sweep() returns.
    function now(v) { return { then(f) { return now(f ? f(v) : v); } }; }
    function nope(e) { return { then(f, r) { return now(r ? r(e) : undefined); } }; }
    var logs = []; var calls = { probe: 0, memory: 0, music: 0 };
    var memory = { totalBytes: 12 * 1024 * 1024 * 1024, freeBytes: 6 * 1024 * 1024 * 1024 };
    var window = { api: { tabs: {
      prepareSleep(wcId) {
        calls.probe++;
        const t = tabs.find((x) => x.viewEl && x.viewEl.wcId === wcId);
        if (!t) return now({ ok: false, reason: 'the page is not running' });
        if (t.probe === 'reject') return nope(new Error('ipc gone'));
        if (t.probe === 'timeout') return now({ ok: true, probe: { ok: false, reason: 'the page did not answer within 1.5 s' } });
        return now({ ok: true, probe: { ok: true, busy: t.probe || '', tracked: true } });
      },
      memory(ids) {
        calls.memory++;
        if (!memory) return now({ ok: false, reason: 'test: no figures' });
        const out = {}; for (const t of tabs) if (t.viewEl && ids.indexOf(t.viewEl.wcId) !== -1) out[t.viewEl.wcId] = { bytes: t.bytes || 50 * 1024 * 1024, sharedWith: 0 };
        return now({ ok: true, totalBytes: memory.totalBytes, freeBytes: memory.freeBytes, tabs: out });
      }
    } } };
    function logEvent(kind, d) { logs.push(Object.assign({ kind }, d)); }
    function chipTooltip() { return ''; }
    function syncTabAudio() {}
    function syncMusicPlayback() { calls.music++; }
    let tabMemoryNotice = '';
    var nextWc = 100;
    function page(id, extra) { const t = Object.assign({ id, kind: 'page', url: 'https://x/' + id, ready: true, asleep: false, pinned: false, audible: false, broken: false, lastActive: 0, openedAt: 0, viewEl: { wcId: nextWc++, audibleNow: false, isCurrentlyAudible() { return this.audibleNow; }, getWebContentsId() { return this.wcId; } } }, extra || {}); tabs.push(t); return t; }
    function activate(id) { const t = tabs.find((x) => x.id === id); activeTabId = id; t.lastActive = clockNow; noteScreenEdges(); }
  ` + ['TAB_SLEEP_DEFAULT_MINUTES', 'TAB_SLEEP_SWEEP_MS'].map((n) => cutConst(n, ';')).join('\n')
    + cutConst('AUDIBLE_SPARE_MS', ';') + '\n'
    + ['MEMORY_LOW', 'MEMORY_CRITICAL', 'HEAVY_TAB_BYTES', 'HEAVY_GRACE_MS', 'SLEEP_PROBE_RETRY_MS'].map((n) => cutConst(n, ';')).join('\n') + '\n'
    + cutConst('EARLY_SLEEP', '};') + '\n'
    + ['isTabOnScreen', 'tabIdleSince', 'noteScreenEdges', 'viewAudibleNow', 'noteTabSound', 'observeTabSound', 'tabSoundReason', 'canSleepTab', 'tabSleepMinutes', 'sleepIdleTabs',
      'setTabHeard', 'memoryPressure', 'memoryWords', 'earlySleepPlan', 'keepAwakeFor', 'sleepProbeWaiting', 'sleepTabChecked', 'queryTabMemory', 'sleepEarly'].map(cutFunction).join('\n')
    + `\nthis.api = { get tabs() { return tabs; }, page, activate, sweep: sleepIdleTabs, slept: () => slept, set: (t) => { clockNow = t; },
      split: (a, b) => { a.splitWith = b.id; b.splitWith = a.id; }, unsplit: (a, b) => { a.splitWith = null; b.splitWith = null; noteScreenEdges(); },
      tabSoundReason, canSleepTab, logs, calls, setMemory: (m) => { memory = m; }, earlySleepPlan, memoryPressure, setTabHeard, noteScreenEdges };`, w);
  return w.api;
}
/** Sweep once a minute from `from` to `to` (minutes); the first minute a tab is slept, or null. */
function sweepUntil(api, from, to, id) {
  for (let m = from; m <= to; m++) {
    api.set(m * MIN);
    api.sweep();
    const s = api.slept().find((x) => x.id === id);
    if (s) return s.at / MIN;
  }
  return null;
}
{
  // BUG 1: read a tab for 20 min, switch away: no sleep until 15 min AFTER leaving.
  const a = sweepWorld();
  a.page('A'); a.page('B');
  a.set(0); a.activate('A');
  sweepUntil(a, 1, 20, 'A');               // 20 minutes on screen, swept every minute
  a.set(20 * MIN); a.activate('B');        // switch away at minute 20
  const at = sweepUntil(a, 21, 60, 'A');
  ok('bug1: read 20 min then left: not slept before 15 min after leaving', at !== null && at >= 35, at);
  ok('bug1: slept at the first sweep past 15 min after leaving (minute 35)', at === 35, at);
}
{
  // A tab shown in a split keeps counting as on screen; its clock starts when the split closes.
  const a = sweepWorld();
  const A = a.page('A'), B = a.page('B');
  a.set(0); a.activate('A'); a.split(A, B); a.activate('B');
  ok('bug1: split partner never sleeps while shown (30 min)', sweepUntil(a, 1, 30, 'A') === null);
  a.set(30 * MIN + 1); a.unsplit(A, B);
  const at = sweepUntil(a, 31, 60, 'A');
  ok('bug1: after the split closes at 30, not slept before 45', at !== null && at >= 45, at);
}
{
  // A restored background tab: idle from boot (openedAt), not "for days" (lastActive 0).
  const a = sweepWorld();
  a.set(1000 * MIN);
  const A = a.page('A', { openedAt: 1000 * MIN }); a.page('B');
  a.activate('B');
  const at = sweepUntil(a, 1001, 1030, 'A');
  ok('bug1: restored background tab sleeps 15 min after boot, not at once', at === 1015, at);
  ok('bug1: lastActive 0 does not mean idle since 1970', A.lastActive === 0 || A.lastActive >= 1000 * MIN);
}
{
  // BUG 2: the media hint says quiet (one of two elements paused) but Chromium hears sound.
  const a = sweepWorld();
  const A = a.page('A'); a.page('B');
  a.set(0); a.activate('A'); a.set(1 * MIN); a.activate('B');
  A.audible = false; A.viewEl.audibleNow = true;   // Twitch: an ad element paused, the stream plays on
  ok('bug2: audible by Chromium, media hint false: never slept in 60 min', sweepUntil(a, 2, 60, 'A') === null);
  ok('bug2: reason given is "making sound"', a.tabSoundReason(A) === 'making sound');
  // The sound stops at minute 60 (last seen audible by the minute-60 sweep).
  a.set(60 * MIN + 30000); A.viewEl.audibleNow = false;
  const at = sweepUntil(a, 61, 90, 'A');
  ok('bug2: after the sound stops, spared for at least 2 min', at !== null && at * MIN - (60 * MIN + 30000) >= AUDIBLE_SPARE_OK, at);
  ok('bug2: and slept within a sweep or two after that', at !== null && at <= 64, at);
}
{
  // Web Audio only (never any media event): spared the same way.
  const a = sweepWorld();
  const A = a.page('A'); const C = a.page('C', { audible: true }); a.page('B');
  a.set(0); a.activate('B');
  A.viewEl.audibleNow = true;
  ok('bug2: Web Audio tab (no media events) is not a candidate', a.canSleepTab(A) === false);
  // The media flag with nothing coming out (a muted element playing, a closed AudioContext whose
  // media-paused never came) is not sound: Chromium's audibility is the answer when it can be read.
  ok('bug2: a media flag Chromium cannot hear no longer spares', a.canSleepTab(C) === true && a.tabSoundReason(C) === '', a.tabSoundReason(C));
  ok('bug2: sleepTab itself refuses a tab making sound (moment of sleeping)', /const sound = tabSoundReason\(tab\);\s*if \(sound\)/.test(cutFunction('sleepTab')));
  ok('bug2: workspace "all" rule uses the real audibility', /tabSoundReason\(tab\)/.test(cutFunction('canSleepInWorkspace')));
  ok('bug2: the slept log line carries the sound state', /sound: heardAgo === null \? 'was not making sound'/.test(cutFunction('sleepTab')));
  ok('bug2: media-paused stamps lastAudibleAt only when Chromium cannot be read',
    /if \(tab\.audible && viewAudibleNow\(tab\) === null\) tab\.lastAudibleAt = Date\.now\(\);\s*setTabAudible\(tab, false\)/.test(src));
}
{
  // BUG 3 (live): Chromium reports an AudioContext as a player (media-started-playing) and sends no
  // media-paused when the context closes. The flag stood for ever, the tab read "making sound" for
  // the rest of its life and never slept. Now: spared 2 min after Chromium went quiet, then slept.
  const a = sweepWorld();
  const A = a.page('A'); a.page('B');
  a.set(0); a.activate('A'); a.set(1 * MIN); a.activate('B');
  A.audible = true; A.viewEl.audibleNow = true;          // the oscillator plays
  ok('bug3: Web Audio playing (flag and Chromium): never slept in 60 min', sweepUntil(a, 2, 60, 'A') === null);
  a.set(60 * MIN + 30000); A.viewEl.audibleNow = false; a.setTabHeard(A, false); // closed: main's push
  ok('bug3: the flag is still stuck on (no media-paused came)', A.audible === true);
  a.set(61 * MIN);
  ok('bug3: just stopped: "made sound in the last 2 minutes", not "making sound"', a.tabSoundReason(A) === 'made sound in the last 2 minutes', a.tabSoundReason(A));
  const at = sweepUntil(a, 61, 120, 'A');
  ok('bug3: slept once the 2-minute window is over, stale flag and all', at !== null && at <= 64, at);
  ok('bug3: never sooner than 2 min after the sound really stopped', at !== null && at * MIN - (60 * MIN + 30000) >= AUDIBLE_SPARE_OK, at);
}
{
  // A Twitch-style stream that really plays never sleeps, whatever the media flag says.
  const a = sweepWorld();
  const S = a.page('S'); const T = a.page('T'); const M = a.page('M', { muted: true }); a.page('B');
  a.set(0); a.activate('B');
  S.audible = true; S.viewEl.audibleNow = true;   // the stream, flag on
  T.audible = false; T.viewEl.audibleNow = true;  // the same stream after an ad element paused
  M.audible = true; M.viewEl.audibleNow = true;   // muted by the user: Chromium still hears it (sleep-e2e checks this premise)
  for (let m = 1; m <= 6 * 60; m++) { a.set(m * MIN); a.sweep(); }
  ok('stream: audible to Chromium, never slept in 6 h (flag on)', !S.asleep);
  ok('stream: audible to Chromium, never slept in 6 h (flag cleared by an ad)', !T.asleep);
  ok('stream: muted by the user but still playing, never slept in 6 h', !M.asleep);
  ok('stream: the reason is "making sound"', a.tabSoundReason(S) === 'making sound' && a.tabSoundReason(T) === 'making sound');
}
{
  // Where Chromium's audibility cannot be read, the media flag is the only signal: it decides.
  const a = sweepWorld();
  const N = a.page('N', { audible: true }); const Q = a.page('Q', { audible: false }); const P = a.page('P', { audible: false }); const X = a.page('X', { audible: true }); a.page('B');
  a.set(0); a.activate('B');
  delete N.viewEl.isCurrentlyAudible; N.viewEl.isCurrentlyAudible = undefined;  // an Electron without it
  Q.viewEl.isCurrentlyAudible = () => { throw new Error('guest gone'); };
  P.viewEl.isCurrentlyAudible = () => Promise.resolve(false);                 // a future async API
  X.viewEl.isCurrentlyAudible = () => Promise.resolve(false);
  ok('fallback: no isCurrentlyAudible, media flag on: "making sound"', a.tabSoundReason(N) === 'making sound', a.tabSoundReason(N));
  ok('fallback: isCurrentlyAudible threw, media flag off: free to sleep', a.tabSoundReason(Q) === '' && a.canSleepTab(Q) === true, a.tabSoundReason(Q));
  ok('fallback: a Promise is not "always playing" (flag off: free)', a.tabSoundReason(P) === '', a.tabSoundReason(P));
  ok('fallback: a Promise defers to the flag (flag on: spared)', a.tabSoundReason(X) === 'making sound', a.tabSoundReason(X));
  N.heard = true;
  a.tabSoundReason(N);
  ok('fallback: an unreadable guest leaves the speaker as main last pushed it', N.heard === true);
}

// --- sleeping early: memory pressure and very heavy pages (earlySleepPlan) --------------------
const GB = 1024 * 1024 * 1024, MB = 1024 * 1024;
{
  const a = sweepWorld();
  const P = a.memoryPressure;
  ok('pressure: 12 GB total, 3 GB free is ok', P(3 * GB, 12 * GB) === 'ok');
  ok('pressure: 12 GB total, 2.0 GB free is low', P(2.0 * GB, 12 * GB) === 'low');
  ok('pressure: 12 GB total, 1.0 GB free is critical', P(1.0 * GB, 12 * GB) === 'critical');
  ok('pressure: 32 GB total, 2.4 GB free is low (2.5 GB cap)', P(2.4 * GB, 32 * GB) === 'low');
  ok('pressure: 32 GB total, 4 GB free is ok', P(4 * GB, 32 * GB) === 'ok');
  ok('pressure: missing figures are unknown, never "low"', P(undefined, 12 * GB) === '' && P(1 * GB, 0) === '');
  const plan = (o) => a.earlySleepPlan(Object.assign({ now: 100 * MIN, minutes: 30, totalBytes: 12 * GB, freeBytes: 6 * GB }, o));
  const ids = (p) => JSON.stringify(p.map((x) => x.id));
  // Six background tabs, idle 1, 3, 6, 9, 12 and 20 minutes.
  const c6 = [1, 3, 6, 9, 12, 20].map((m) => ({ id: 'c' + m, idleSince: 100 * MIN - m * MIN, bytes: 100 * MB }));
  ok('early: plenty of memory, nothing heavy: nothing early', plan({ candidates: c6 }).length === 0);
  ok('early: "Never" (0 minutes) plans nothing even at critical memory', plan({ minutes: 0, freeBytes: 0.5 * GB, candidates: c6 }).length === 0);
  const low = plan({ freeBytes: 1.6 * GB, candidates: c6 });
  ok('low: two per sweep, least recently used first', ids(low) === '["c20","c12"]', low);
  ok('low: why "memory", the figures in plain words', low[0] && low[0].why === 'memory' && low[0].note === 'memory was low (1.6 GB of 12.0 GB free)', low[0]);
  ok('low: the 3 most recently used background tabs stay warm', ids(plan({ freeBytes: 1.6 * GB, candidates: c6.slice(0, 4) })) === '["c9"]');
  const young = [1, 2, 3, 4].map((m) => ({ id: 'y' + m, idleSince: 100 * MIN - m * MIN }));
  ok('low: nothing idle under 5 min goes early', plan({ freeBytes: 1.6 * GB, candidates: young }).length === 0);
  const crit = plan({ freeBytes: 0.8 * GB, candidates: c6 });
  ok('critical: three per sweep, LRU first, "very low"', ids(crit) === '["c20","c12","c9"]' && /^memory was very low \(819 MB of 12\.0 GB free\)$/.test(crit[0].note), crit);
  ok('critical: only the most recent stays warm, 2 min grace', ids(plan({ freeBytes: 0.8 * GB, candidates: c6.slice(0, 2) })) === '["c3"]');
  const due = plan({ freeBytes: 0.8 * GB, minutes: 10, candidates: c6 });
  ok('early: a tab already due by the timer is left to the idle rule', due.every((x) => x.id !== 'c12' && x.id !== 'c20'), due);
  ok('early: a 1-minute timer leaves nothing for the early rules', plan({ freeBytes: 0.8 * GB, minutes: 1, candidates: c6 }).length === 0);
  // Heavy: most recent first = top (6 min, 900 MB), big (7 min, 620 MB), small (20 min, 120 MB).
  const hv = plan({ candidates: [{ id: 'top', idleSince: 94 * MIN, bytes: 900 * MB }, { id: 'big', idleSince: 93 * MIN, bytes: 620 * MB }, { id: 'small', idleSince: 80 * MIN, bytes: 120 * MB }] });
  ok('heavy: a 620 MB tab idle 7 min sleeps with plenty of memory', ids(hv) === '["big"]' && hv[0].why === 'heavy', hv);
  ok('heavy: the note gives its size', hv[0] && hv[0].note === 'it was using 620 MB of memory in the background', hv[0]);
  ok('heavy: the most recently used background tab is spared, however big', !hv.some((x) => x.id === 'top'));
  ok('heavy: idle under 5 min is not yet', plan({ candidates: [{ id: 'top', idleSince: 99 * MIN }, { id: 'h4', idleSince: 96 * MIN, bytes: 700 * MB }] }).length === 0);
  ok('heavy + low: a tab is planned once', (() => { const p = plan({ freeBytes: 1.6 * GB, candidates: c6.concat([{ id: 'fat', idleSince: 70 * MIN + 1, bytes: 800 * MB }]) }); return p.filter((x) => x.id === 'fat').length === 1; })());
}
{
  // The sweep end to end with main faked: low memory, five background tabs, pinned, one making sound.
  const a = sweepWorld();
  a.page('F');
  ['b1', 'b2', 'b3', 'b4', 'b5'].forEach((id, i) => { a.page(id); a.set(i * MIN); a.activate(id); });
  const pin = a.page('pin', { pinned: true }); const loud = a.page('loud'); loud.viewEl.audibleNow = true;
  a.set(5 * MIN); a.activate('F');
  a.setMemory({ totalBytes: 12 * GB, freeBytes: 1.6 * GB });
  a.set(11 * MIN); a.sweep();
  const s = a.slept();
  ok('sweep low: b1 and b2 (least recent) went early, as "memory"', JSON.stringify(s.map((x) => x.id)) === '["b1","b2"]' && s.every((x) => x.why === 'memory'), s);
  ok('sweep low: the slept tab carries the note', s[0] && /^memory was low \(1\.6 GB of 12\.0 GB free\)$/.test(s[0].note), s[0]);
  ok('sweep low: pinned and sounding tabs stay awake', !pin.asleep && !loud.asleep);
  ok('sweep low: one memory ask per sweep', a.calls.memory === 1, a.calls);
  a.set(12 * MIN); a.sweep();
  ok('sweep low: the 3 warm tabs stay up next sweep', a.slept().length === 2, a.slept());
  // Figures unavailable: early rules stop, logged once; the timer still runs.
  const b = sweepWorld(); b.page('F'); b.page('x'); b.set(0); b.activate('F'); b.setMemory(null);
  for (let m = 1; m <= 14; m++) { b.set(m * MIN); b.sweep(); }
  ok('no figures: nothing early', b.slept().length === 0);
  ok('no figures: said once in the log', b.logs.filter((l) => l.kind === 'ui-error').length === 1, b.logs);
  b.set(15 * MIN); b.sweep();
  ok('no figures: the timer still sleeps at 15 min', b.slept().length === 1 && b.slept()[0].why === 'idle', b.slept());
  const c = sweepWorld(); c.page('F'); c.page('x'); c.set(0); c.activate('F');
  c.set(1 * MIN); c.sweep();
  ok('no ask at all while no tab is idle 2 min', c.calls.memory === 0, c.calls);
}
{
  // The safe-to-sleep probe: busy, no answer, a failed ask; retry timing; the reason shown and logged.
  const a = sweepWorld();
  const D = a.page('draft', { probe: 'unsaved text in a form' }); const T = a.page('hung', { probe: 'timeout' }); const R = a.page('rej', { probe: 'reject' });
  a.page('F'); a.set(0); a.activate('F');
  a.set(16 * MIN); a.sweep();
  ok('probe: none of the three slept', a.slept().length === 0, a.slept());
  ok('probe: kept awake with the page\'s reason', D.keptAwake && D.keptAwake.reason === 'unsaved text in a form', D.keptAwake);
  ok('probe: no answer = kept awake, says so (safe rule)', T.keptAwake && T.keptAwake.reason === 'could not check it for unsaved work (the page did not answer within 1.5 s)', T.keptAwake);
  ok('probe: a failed ask = kept awake, says so', R.keptAwake && R.keptAwake.reason === 'could not check it for unsaved work (ipc gone)', R.keptAwake);
  const skipped = () => a.logs.filter((l) => l.kind === 'tab-sleep-skipped');
  ok('probe: each logged as kept awake', skipped().length === 3 && skipped()[0].reason === 'unsaved text in a form', skipped());
  const asked = a.calls.probe;
  for (let m = 17; m <= 20; m++) { a.set(m * MIN); a.sweep(); }
  ok('probe: not asked again inside 5 min', a.calls.probe === asked, a.calls);
  a.set(21 * MIN); a.sweep();
  ok('probe: asked again after 5 min', a.calls.probe === asked + 3, a.calls);
  ok('probe: the same reason is not logged twice', skipped().length === 3, skipped().length);
  D.probe = ''; a.set(26 * MIN); a.sweep();
  ok('probe: once the text is gone, the tab sleeps (as idle)', D.asleep && a.slept().some((x) => x.id === 'draft' && x.why === 'idle'), a.slept());
  for (let m = 27; m <= 70; m++) { a.set(m * MIN); a.sweep(); }
  ok('probe: a page that never answers is never slept', !T.asleep && !R.asleep);
  a.set(71 * MIN); a.activate('hung');
  ok('probe: on screen clears the stale "kept awake" reason', T.keptAwake === null, T.keptAwake);
}
{
  // The speaker follows Chromium's audibility, not the per-element media events.
  const a = sweepWorld();
  const S = a.page('S'); a.page('F'); a.set(0); a.activate('F');
  S.viewEl.audibleNow = true; a.set(1 * MIN); a.sweep();
  ok('speaker: Web Audio (no media events) lights it by the next sweep', S.heard === true);
  a.set(2 * MIN); a.setTabHeard(S, false);
  ok('speaker: going quiet clears it and stamps lastAudibleAt', S.heard === false && S.lastAudibleAt === 2 * MIN, S.lastAudibleAt);
  ok('speaker: the chip reads tab.heard, not the media flag', /const show = !!\(tab\.heard \|\| tab\.muted\);/.test(cutFunction('syncTabAudio')));
  ok('speaker: main\'s push drives it', /onAudioState\(\(p\) => \{[\s\S]*?setTabHeard\(tab, p\.audible === true\)/.test(src));
  ok('speaker: a gone guest drops it', /if \(tab\.heard\) \{ tab\.heard = false; syncTabAudio\(tab\); \}/.test(cutFunction('forgetTabAudio')));
  // The idle music follows real sound too: tab.heard is one of anyTabAudible()'s signals, and
  // every place that moves it hands the music the new fact.
  const m0 = a.calls.music; a.set(3 * MIN); a.setTabHeard(S, true);
  ok('idle music: going audible moves it', a.calls.music === m0 + 1, a.calls.music - m0);
  a.setTabHeard(S, true);
  ok('idle music: no edge, no call', a.calls.music === m0 + 1, a.calls.music - m0);
  a.setTabHeard(S, false);
  ok('idle music: going quiet moves it', a.calls.music === m0 + 2, a.calls.music - m0);
  {
    const w = { tabs: [] };
    vm.createContext(w);
    vm.runInContext(cutFunction('anyTabAudible') + '\nthis.f = anyTabAudible;', w);
    const hear = (t) => { w.tabs = t; return w.f(); };
    ok('idle music: Web Audio alone (heard, no media flag) counts', hear([{ heard: true, audible: false, muted: false }]) === true);
    ok('idle music: the media flag counts while Chromium has never answered for the guest', hear([{ heard: false, audible: true, muted: false }]) === true);
    ok('idle music: a stuck media flag (closed AudioContext) does not count once Chromium answers "quiet"',
      hear([{ heard: false, audible: true, heardRead: true, muted: false }]) === false);
    ok('idle music: Chromium hearing it counts whatever the flag says', hear([{ heard: true, audible: false, heardRead: true, muted: false }]) === true);
    ok('idle music: a muted tab never counts', hear([{ heard: true, audible: true, muted: true }]) === false);
    ok('idle music: silence is silence', hear([{ heard: false, audible: false, muted: false }]) === false);
  }
  {
    // Chromium answering for a guest (a push or a sweep's read) is what retires the media flag
    // for the idle music, and a gone guest brings it back for the next one.
    const T = { id: 77, kind: 'page', url: 'https://example.com/', audible: true };
    const m1 = a.calls.music; a.setTabHeard(T, false);
    ok('idle music: the first answer from Chromium marks the guest read', T.heardRead === true, T);
    ok('idle music: a first "quiet" answer over a set media flag moves the music', a.calls.music === m1 + 1, a.calls.music - m1);
    a.setTabHeard(T, false);
    ok('idle music: a repeat answer does not', a.calls.music === m1 + 1, a.calls.music - m1);
    ok('idle music: a sweep\'s read marks the guest read too',
      /if \(chromium !== null && !tab\.heardRead\) \{ tab\.heardRead = true; if \(tab\.audible\) syncMusicPlayback\(\); \}/.test(cutFunction('noteTabSound')));
    ok('idle music: a gone guest is unread again', /tab\.heardRead = false;/.test(cutFunction('forgetTabAudio')));
  }
  ok('idle music: a gone guest that was only heard still hands it back',
    /wasSounding = !!\(tab\.heard \|\| tab\.audible\)[\s\S]*if \(wasSounding\) syncMusicPlayback\(\);/.test(cutFunction('forgetTabAudio')));
  ok('idle music: muting a heard tab moves it', /if \(tab\.audible \|\| tab\.heard\) syncMusicPlayback\(\);/.test(cutFunction('setTabMuted')));
  ok('workspace "all": real pages are asked first', /sleepTabChecked\(tab, 'workspace'/.test(cutFunction('sleepInWorkspaceNow')));
  ok('menu: "Sleep tab" says what a probe found it would lose', /would be lost/.test(cutFunction('sleepMenuLabel')) && /label: sleepMenuLabel\(tab\)/.test(src));
}

// --- tabsleep-main.js: memory figures, the probe and its tracker ------------------------------
{
  const TM = require('./tabsleep-main');
  const m = TM.tabMemory({
    wcIds: [1, 2, 3, 4], system: { totalBytes: 12 * GB, freeBytes: 2 * GB },
    metrics: [{ pid: 10, memory: { workingSetSize: 500 * 1024 } }, { pid: 11, memory: { workingSetSize: 300 * 1024 } }],
    pidOf: (id) => ({ 1: 10, 2: 11, 3: 11, 4: 99 })[id]
  });
  ok('memory: a guest with its own renderer gets all of it', m.tabs[1] && m.tabs[1].bytes === 500 * MB, m.tabs);
  ok('memory: two guests sharing a renderer split it', m.tabs[2] && m.tabs[2].bytes === 150 * MB && m.tabs[2].sharedWith === 1, m.tabs);
  ok('memory: a guest whose process is unknown is left out', !(4 in m.tabs));
  ok('memory: system figures pass through', m.freeBytes === 2 * GB && m.totalBytes === 12 * GB);

  const el = (tag, o) => Object.assign({
    tagName: tag, type: 'text', value: '', defaultValue: '', isConnected: true, isContentEditable: false,
    getAttribute(n) { return (o && o.attrs && o.attrs[n]) || null; },
    closest(sel) { return (o && o.inSearch && /role="search"/.test(sel)) ? {} : null; }
  }, o || {});
  const text = (v, hidden) => ({ nodeValue: v, parentElement: { closest: () => (hidden ? {} : null) } });
  const probe = (o) => {
    const doc = {
      designMode: o.designMode || 'off', body: o.body || null, pictureInPictureElement: o.pip || null,
      querySelectorAll: (sel) => sel === 'input, textarea' ? (o.els || []) : sel === 'video, audio' ? (o.media || []) : [],
      createTreeWalker: (root) => { let i = -1; const n = root.textNodes || []; return { nextNode: () => n[++i] || null }; }
    };
    const win = { __quartzEdits: o.tracked ? o.tracked.map((e) => ({ deref: () => e })) : undefined };
    return vm.runInContext(TM.PROBE, vm.createContext({ window: win, document: doc, NodeFilter: { SHOW_TEXT: 4 }, navigator: { mediaSession: { playbackState: o.session || 'none' } } }));
  };
  ok('probe: typed text in a field = unsaved text in a form', probe({ tracked: [el('INPUT', { value: 'hello' })] }).busy === 'unsaved text in a form');
  ok('probe: the answer says the tracker was there', probe({ tracked: [] }).tracked === true && probe({}).tracked === false);
  ok('probe: a typed field emptied again is fine', probe({ tracked: [el('TEXTAREA', { value: '  ' })] }).busy === '');
  ok('probe: a search box is not work', probe({ tracked: [el('INPUT', { value: 'lofi', attrs: { role: 'combobox' } }), el('INPUT', { value: 'x', inSearch: true }), el('INPUT', { type: 'search', value: 'q' })] }).busy === '');
  ok('probe: a password is not work', probe({ tracked: [el('INPUT', { type: 'password', value: 'pw' })] }).busy === '');
  ok('probe: a field that left the page does not count', probe({ tracked: [el('INPUT', { value: 'x', isConnected: false })] }).busy === '');
  ok('probe: script-prefilled text with the tracker present does not count', probe({ tracked: [], els: [el('INPUT', { value: 'prefilled', defaultValue: '' })] }).busy === '');
  ok('probe: no tracker: changed from its loaded value counts (cautious fallback)', probe({ els: [el('INPUT', { value: 'typed', defaultValue: '' })] }).busy === 'unsaved text in a form');
  ok('probe: no tracker: a value as loaded does not', probe({ els: [el('INPUT', { value: 'q', defaultValue: 'q' })] }).busy === '');
  const ed = (nodes) => el('DIV', { isContentEditable: true, textNodes: nodes });
  ok('probe: an editor holding only its placeholder is fine', probe({ tracked: [ed([text('Message #general', true)])] }).busy === '');
  ok('probe: an editor holding typed text = unsaved text in an editor', probe({ tracked: [ed([text('half a reply')])] }).busy === 'unsaved text in an editor');
  const stream = (state) => ({ srcObject: { getTracks: () => [{ readyState: state }] } });
  ok('probe: a live MediaStream = a live call, camera or microphone', probe({ media: [stream('live')] }).busy === 'a live call, camera or microphone');
  ok('probe: an ended stream is fine', probe({ media: [stream('ended'), { srcObject: null }] }).busy === '');
  ok('probe: picture-in-picture keeps it', probe({ pip: {} }).busy === 'a picture-in-picture video');
  ok('probe: OS media controls say playing', probe({ session: 'playing' }).busy === 'media that is playing');
  ok('probe: a quiet page is clear', probe({}).busy === '');

  // The tracker: trusted input only, one mark per element, a submitted form drops its marks.
  const listeners = {};
  const doc = { addEventListener: (k, f) => { listeners[k] = f; }, querySelectorAll: () => [] };
  const win = {};
  vm.runInContext(TM.TRACKER, vm.createContext({ window: win, document: doc }));
  const field = { nodeType: 1, isContentEditable: false };
  listeners.input({ isTrusted: false, composedPath: () => [field] });
  ok('tracker: a script\'s synthetic input is not the user', win.__quartzEdits.length === 0);
  listeners.input({ isTrusted: true, composedPath: () => [field] });
  listeners.input({ isTrusted: true, composedPath: () => [field] });
  ok('tracker: the user typing marks the field once', win.__quartzEdits.length === 1 && win.__quartzEdits[0].deref() === field);
  listeners.submit({ target: { contains: (x) => x === field } });
  ok('tracker: submitting its form drops the mark', win.__quartzEdits.length === 0);
  ok('tracker: runs once per page', vm.runInContext(TM.TRACKER, vm.createContext({ window: { __quartzEdits: [] }, document: doc })) === 1);
}

// The suite's summary-line format (tools/run-suite.js): "<name>: N passed, M failed".
console.log('\ntabsleep: ' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
