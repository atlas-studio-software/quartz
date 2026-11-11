require('./tools/lowcpu-optional.js');   // first: one capped browser at a time (requested 2026-09-17)
// looksync-e2e.js — Look Sync (and the light look) end to end, against a REAL test instance of Quartz.
//
//   node looksync-e2e.js [--port 9418] [--only <regex>] [--keep]
//
// Launches its own Quartz: --test-profile --profile-name=lse2e<pid> --offscreen --show-inactive
// --measure-visible, with LOOK_SYNC_DIR pointing at an EMPTY temp dir (never the real
// %APPDATA%\look-sync), drives the shared file with looksync/fake-writer.js (vendored from ~/look-sync) and the window over CDP.
//
// INVISIBLE: the user works at this machine while tests run. --offscreen creates the window at
// -20000,-20000 with no taskbar button (main.js), so it is never on a monitor, not for one frame.
// A watcher (started BEFORE electron) polls every visible window of the test process every 25 ms
// and the run FAILS ('invisible: ...') if any rectangle ever touches the virtual desktop. The
// "lined up" test moves the window between two OFF-SCREEN places only.
// Refuses to start under 2.5 GB free RAM. Kills ONLY the process tree it started, then deletes
// its temp profile and look dir (--keep leaves them). Every test starts from the same baseline
// (resetBaseline), so one failure cannot leave a changed value behind for the next.
// Prints PASS/FAIL lines and one summary line: "looksync-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require(path.join(__dirname, 'node_modules', 'ws'));
const { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb, startWatcher } = require('./testwatch');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(opt('port', '9418'));
const ONLY = opt('only', '');
const KEEP = argv.includes('--keep');
const APP = __dirname;
// QUARTZ_E2E_ELECTRON: the same app code on another Electron build (stock vs castlabs A/B); default = this checkout's.
const ELECTRON = process.env.QUARTZ_E2E_ELECTRON || path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROFILE = 'lse2e' + process.pid;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'looksync-e2e-'));
if (/AppData[\\/]Roaming[\\/]look-sync/i.test(DIR)) { console.error('never the real store'); process.exit(2); }
// The fake writer vendored at the same look-sync commit as the module Quartz runs (looksync/vendor.js).
const FW = path.join(APP, 'looksync', 'fake-writer.js');
const LS = require('./looksync/look-sync');
if (!fs.existsSync(FW)) { console.log('looksync-e2e: cannot run: the fake writer is missing at ' + FW); process.exit(2); }
const BG = path.join(APP, 'assets', 'backgrounds');
let MAINPID = 0;
let electronProc = null;
let watcher = null;

/* ---- launch / cleanup ----------------------------------------------------- */
async function launch() {
  const free = freeRamGb();
  if (!(free >= MIN_FREE_GB)) { console.log('looksync-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }
  console.log('     free RAM ' + free.toFixed(2) + ' GB; look dir ' + DIR);
  watcher = startWatcher();
  await watcher.ready;
  const env = Object.assign({}, process.env, { LOOK_SYNC_DIR: DIR });
  electronProc = spawn(ELECTRON, ['.', '--remote-debugging-port=' + PORT, '--test-profile', '--profile-name=' + PROFILE,
    ...OFFSCREEN_ARGS], { cwd: APP, stdio: 'ignore', env });
  MAINPID = electronProc.pid;
  watcher.watch(MAINPID);
  console.log('     electron pid ' + MAINPID + ' port ' + PORT + ' profile ' + PROFILE);
  // Readiness, not a sleep: the chrome's CDP target answering.
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try {
      const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
      if (targets.some((x) => x.type === 'page' && String(x.url).includes('index.html'))) return;
    } catch (e) { /* not listening yet */ }
    if (electronProc.exitCode !== null) throw new Error('electron exited early (' + electronProc.exitCode + ')');
    await sleep(100);
  }
  throw new Error('no chrome CDP target within 30 s');
}
function cleanup() {
  if (MAINPID) { try { execFileSync('taskkill', ['/PID', String(MAINPID), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* already gone */ } }
  if (watcher) watcher.stop();
  if (!KEEP) {
    const prof = path.join(os.tmpdir(), 'browser-test-profile-' + PROFILE);
    for (const d of [DIR, prof]) { for (let i = 0; i < 5; i++) { try { fs.rmSync(d, { recursive: true, force: true }); break; } catch (e) { execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 400']); } } }
  } else console.log('     kept: ' + DIR);
}
/** Move the test window, OFF-SCREEN only (the watcher fails the run on any on-screen rect). */
function place(x, y, w, h) {
  if (x + w > -5000 || y + h > -5000) throw new Error('place(' + x + ',' + y + ') would reach the visible desktop');
  const ps = 'Add-Type @"\nusing System; using System.Runtime.InteropServices;\npublic static class P {\n public delegate bool EnumProc(IntPtr h, IntPtr p);\n [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();\n [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);\n [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);\n [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);\n [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);\n [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);\n [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }\n}\n"@\n' +
    '[P]::SetProcessDPIAware() | Out-Null; $best = $null; $ba = 0\n' +
    '$cb = [P+EnumProc]{ param($h, $p) $wp = 0; [P]::GetWindowThreadProcessId($h, [ref]$wp) | Out-Null; if ($wp -eq ' + MAINPID + ' -and [P]::IsWindowVisible($h)) { $r = New-Object P+RECT; [P]::GetWindowRect($h, [ref]$r) | Out-Null; $a = ($r.R - $r.L) * ($r.B - $r.T); if ($a -gt $script:ba) { $script:ba = $a; $script:best = $h } }; return $true }\n' +
    '[P]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null; if (-not $best) { "no window"; exit 1 }\n' +
    // SWP_NOACTIVATE 0x10 | SWP_NOZORDER 0x4: never activated, never reordered
    '[P]::SetWindowPos($best, [IntPtr]::Zero, ' + x + ', ' + y + ', ' + w + ', ' + h + ', 0x14) | Out-Null; $r = New-Object P+RECT; [P]::GetWindowRect($best, [ref]$r) | Out-Null; "placed $best at $($r.L),$($r.T) $($r.R - $r.L)x$($r.B - $r.T)"';
  return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws = null; let msgId = 0; const pending = new Map();
async function connect(guest) {
  const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
  const t = guest ? targets.find((x) => String(x.url).includes('newtab.html'))
    : targets.find((x) => x.type === 'page' && String(x.url).includes('index.html'));
  if (!t) throw new Error('no ' + (guest ? 'guest' : 'chrome') + ' target');
  const s = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { s.on('open', r); s.on('error', j); });
  s.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; console.log('PAGE EXCEPTION ' + ((d.exception && d.exception.description) || d.text).split(String.fromCharCode(10)).slice(0, 3).join(' | ')); } const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } });
  if (!guest) s.send(JSON.stringify({ id: 999999, method: 'Runtime.enable' }));
  return s;
}
async function evalIn(sock, expr) {
  const id = ++msgId;
  const m = await new Promise((resolve) => { pending.set(id, resolve); sock.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
  if (m.error) throw new Error(JSON.stringify(m.error));
  if (m.result.exceptionDetails) throw new Error('page threw: ' + ((m.result.exceptionDetails.exception || {}).description || m.result.exceptionDetails.text));
  return m.result.result.value;
}
const ev = (expr) => evalIn(ws, expr);
async function evGuest(expr) { const g = await connect(true); try { return await evalIn(g, expr); } finally { g.close(); } }
async function waitFor(expr, ms, step) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 <= ms) { try { last = await ev(expr); if (last) return { ok: true, ms: Date.now() - t0, v: last }; } catch (e) { last = e.message; } await sleep(step || 40); }
  return { ok: false, ms: Date.now() - t0, v: last };
}
function fw(...args) { return execFileSync(process.execPath, [FW, '--dir', DIR, ...args], { encoding: 'utf8' }).trim(); }
function look() { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'look.json'), 'utf8')); } catch (e) { return null; } }
async function waitFile(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 <= ms) { const d = look(); try { if (d && fn(d)) return { ok: true, ms: Date.now() - t0 }; } catch (e) { /* not yet */ } await sleep(40); } return { ok: false, ms: Date.now() - t0, v: JSON.stringify(look() && look().look).slice(0, 300) }; }
function still(n, stem) { const d = path.join(DIR, 'stills'); fs.mkdirSync(d, { recursive: true }); const p = path.join(d, 'wall-' + n + '.jpg'); fs.copyFileSync(path.join(BG, stem + '.jpg'), p); return p; }

/* ---- readiness + the baseline every test starts from -------------------- */
// Settled = the page has painted twice and gone idle (bounded, so a stalled renderer fails
// loudly in the caller's waitFor instead of hanging the run).
const SETTLE = "new Promise((r) => { const t = setTimeout(() => r('timeout'), 3000); requestAnimationFrame(() => requestAnimationFrame(() => requestIdleCallback(() => { clearTimeout(t); r('idle'); }, { timeout: 2000 }))); })";
const BASE = { theme: 'dark', accent: null, glass: { dark: { blurPx: 5, dim: 0.5, panel: 0 }, light: { blurPx: 12, dim: 0.45, panel: 0 } } };
/**
 * Put the shared file and Quartz back to the baseline (dark, palette accent, seed glass,
 * sync on, Settings closed, sites following Windows) and wait until Quartz SHOWS it and has
 * settled. Only values that differ are rewritten, so a passing run costs almost nothing.
 * Throws with what did not come back: the next test must not inherit a changed value.
 */
async function resetBaseline() {
  await ev("(window.Settings && Settings.close && Settings.close(), Settings.get('lookSync') !== true && Settings.set({ lookSync: true }), Settings.get('siteTheme') !== 'system' && Settings.set({ siteTheme: 'system' }), 1)");
  must(await waitFor("LookSync.status().state === 'ok'", 3000), 'baseline: sync ok');
  const d = look();
  if (!d || !d.look) throw new Error('baseline: no readable look.json');
  if (d.look.theme.v !== BASE.theme) fw('--app', 'helm', 'set', 'theme', BASE.theme);
  if (!d.look.accent.v || d.look.accent.v.hue !== null) fw('--app', 'helm', 'set', 'accent', 'null');
  for (const t of ['dark', 'light']) for (const k of ['blurPx', 'dim', 'panel']) {
    if (d.look.glass.v[t][k] !== BASE.glass[t][k]) fw('--app', 'helm', 'set', 'glass.' + t + '.' + k, String(BASE.glass[t][k]));
  }
  const still = d.desktop && d.desktop.still && fs.existsSync(d.desktop.still);
  must(await waitFor("document.documentElement.getAttribute('data-theme') === 'dark' && QuartzTheme.mode() === 'dark' && Settings.get('accentHue') === null" +
    " && !document.documentElement.style.getPropertyValue('--ion') && !document.documentElement.style.getPropertyValue('--surface-1')" +
    " && Backdrop.state().glass.floor === 0.5 && Backdrop.state().glass.blurPx === 5 && document.body.getAttribute('data-bg-state') !== 'loading'" +
    (still ? " && Backdrop.state().state === 'ok' && LookSync.desktop().state === 'ok'" : ''), 5000), 'baseline shown (dark, seed glass' + (still ? ', desktop ok' : '') + ')');
  const s = await ev(SETTLE);
  if (s !== 'idle') throw new Error('baseline: the chrome did not settle (' + s + ')');
}

const results = [];
async function test(name, fn) {
  if (ONLY && !new RegExp(ONLY).test(name)) return;
  if (!/^seed:/.test(name)) {
    try { await resetBaseline(); } catch (e) { results.push([name, false]); console.log('FAIL ' + name + ': could not reset first: ' + e.message); return; }
  }
  const t0 = Date.now();
  try { const detail = await fn(); results.push([name, true]); console.log('PASS ' + name + ' (' + (Date.now() - t0) + ' ms)' + (detail ? ' ' + detail : '')); }
  catch (e) {
    results.push([name, false]);
    // What the window held when it failed: "last false" alone says nothing about a cloud run.
    const st = await ev("JSON.stringify({ desktop: (({ state, reason, stillUrl }) => ({ state, reason, stillUrl: String(stillUrl || '').slice(-40) }))(LookSync.desktop()), status: LookSync.status().state + ': ' + LookSync.status().reason, backdrop: (({ kind, state, reason }) => ({ kind, state, reason }))(Backdrop.state()) })").catch((x) => 'state unreadable: ' + x.message);
    console.log('FAIL ' + name + ': ' + e.message + '\n     at failure: ' + String(st).slice(0, 700));
  }
}
function must(r, what) { if (!r.ok) throw new Error(what + ' (waited ' + r.ms + ' ms, last ' + JSON.stringify(r.v) + ')'); return r.ms; }
const alpha = (rgba) => { const m = /rgba?\(([^)]+)\)/.exec(rgba || ''); return m ? Number((m[1].split(/[ ,/]+/).filter(Boolean)[3]) || 1) : null; };

(async () => {
  await launch();
  ws = await connect(false);
  must(await waitFor("document.readyState === 'complete' && !!(window.LookSync && window.Settings && window.Backdrop && window.QuartzTheme)", 15000), 'modules present');
  await ev('LookSync.ready()');
  // Cold start: the first new tab's guest is loaded and the backdrop has finished its first
  // picture (ok or a stated fallback), then the chrome has painted and gone idle.
  must(await waitFor("(() => { const t = getActiveTab(); return !!t && t.kind === 'page' && isNewTabUrl(t.url) && !!t.viewEl && !t.viewEl.isLoading(); })()", 15000), 'first new tab loaded');
  must(await waitFor("document.body.getAttribute('data-bg-state') === 'ok' || document.body.getAttribute('data-bg-state') === 'fallback'", 15000), 'first backdrop drawn');
  if (await ev(SETTLE) !== 'idle') throw new Error('the chrome never settled after start');

  await test('seed: first start writes look.json from Quartz', async () => {
    const r = await waitFile((d) => d.schema === 1 && d.look && d.look.theme, 3000); must(r, 'look.json');
    const st = await ev('LookSync.status()');
    if (st.state !== 'ok') throw new Error('status ' + JSON.stringify(st));
    // CONTRACT 0b55b9c: the first seed is Match Windows ('system'), not Dark.
    if (look().look.theme.v !== 'system') throw new Error('seed theme ' + JSON.stringify(look().look.theme));
    const mode = await ev('QuartzTheme.mode()');
    if (mode !== 'system') throw new Error('Quartz mode after seed ' + mode);
    return 'writer=' + look().writer.app + ' rev=' + look().rev + ' line="' + st.line + '"';
  });

  await test('desktop: kind desktop follows a fake-writer desktop record', async () => {
    const kind = await ev("Settings.get('newtabBackground').kind"); if (kind !== 'desktop') throw new Error('default kind ' + kind);
    const p1 = still(101, 'snow-peak');
    fw('--app', 'mantle', 'desktop', 'builtin:snow-peak', path.join(BG, 'snow-peak.jpg'), p1);
    const ms1 = must(await waitFor("LookSync.desktop().state === 'ok' && /wall-101/.test(LookSync.desktop().stillUrl) && Backdrop.state().kind === 'desktop' && Backdrop.state().state === 'ok'", 3000), 'first record shown');
    const stems = fs.readdirSync(BG).filter((f) => f.endsWith('.jpg') && f !== 'snow-peak.jpg');
    const other = stems[0].replace(/\.jpg$/, '');
    const p2 = still(102, other);
    fw('--app', 'mantle', 'desktop', 'builtin:' + other, path.join(BG, other + '.jpg'), p2);
    const ms2 = must(await waitFor("/wall-102/.test(LookSync.desktop().stillUrl) && Backdrop.state().state === 'ok' && /wall-102/.test(JSON.stringify(Backdrop.state().source))", 1000), 'change followed within 1 s');
    const g = await evGuest('window.__background ? window.__background() : null');
    // back to snow-peak for the rest
    fw('--app', 'mantle', 'desktop', 'builtin:snow-peak', path.join(BG, 'snow-peak.jpg'), still(103, 'snow-peak'));
    must(await waitFor("/wall-103/.test(LookSync.desktop().stillUrl) && Backdrop.state().state === 'ok'", 3000), 'back to snow-peak');
    return 'first ' + ms1 + ' ms, change ' + ms2 + ' ms; new tab kind=' + (g && g.kind) + ' url=' + String(g && g.url).slice(-30);
  });

  await test('desktop: missing still -> visible fallback to the Windows wallpaper', async () => {
    fw('--app', 'mantle', 'desktop', 'builtin:snow-peak', path.join(BG, 'snow-peak.jpg'), path.join(DIR, 'stills', 'wall-999.jpg'));
    const why = must(await waitFor("LookSync.desktop().state === 'fallback' && /still wall-999.jpg is missing/.test(LookSync.desktop().reason) ? LookSync.desktop().reason : null", 1500), 'fallback state') && await ev('LookSync.desktop().reason');
    const s = await waitFor("Backdrop.state().state === 'fallback' || (Backdrop.state().reason && /Windows/.test(Backdrop.state().reason)) ? Backdrop.state() : null", 3000);
    fw('--app', 'mantle', 'desktop', 'builtin:snow-peak', path.join(BG, 'snow-peak.jpg'), still(104, 'snow-peak'));
    must(await waitFor("LookSync.desktop().state === 'ok' && Backdrop.state().state === 'ok'", 2000), 'recovered');
    return 'reason="' + why + '" backdrop=' + JSON.stringify(s.v && { state: s.v.state, reason: s.v.reason }).slice(0, 200);
  });

  await test('theme follows within 1 s', async () => {
    fw('--app', 'helm', 'set', 'theme', 'light');
    const a = must(await waitFor("document.documentElement.getAttribute('data-theme') === 'light' && QuartzTheme.mode() === 'light'", 1000), 'light');
    fw('--app', 'helm', 'set', 'theme', 'dark');
    const b = must(await waitFor("document.documentElement.getAttribute('data-theme') === 'dark' && QuartzTheme.mode() === 'dark'", 1000), 'dark');
    return 'light ' + a + ' ms, dark ' + b + ' ms';
  });

  await test('accent follows within 1 s', async () => {
    fw('--app', 'mantle', 'set', 'accent', '30');
    const a = must(await waitFor("Settings.get('accentHue') === 30 && document.documentElement.style.getPropertyValue('--ion').trim() === LookAccent.tokens(30, 'dark').acc", 1000), 'hue 30 on --ion');
    fw('--app', 'mantle', 'set', 'accent', 'null');
    const b = must(await waitFor("Settings.get('accentHue') === null && !document.documentElement.style.getPropertyValue('--ion')", 1000), 'hue null clears');
    return 'hue 30 ' + a + ' ms, null ' + b + ' ms';
  });

  await test('glass follows within 1 s (blur, dim, panel)', async () => {
    fw('--app', 'helm', 'set', 'glass.dark.blurPx', '10');
    const a = must(await waitFor('Backdrop._lastRender() && Backdrop._lastRender().blur === 3', 1000), 'blur 10 -> 3 bitmap px');
    fw('--app', 'helm', 'set', 'glass.dark.dim', '0.7');
    const b = must(await waitFor("Number(getComputedStyle(document.documentElement).getPropertyValue('--chrome-glass-a')) >= 0.7", 1000), 'dim .7');
    fw('--app', 'helm', 'set', 'glass.dark.panel', '-0.1');
    const c = must(await waitFor("/0\\.56\\)/.test(getComputedStyle(document.documentElement).getPropertyValue('--surface-1'))", 1000), 'panel -.1 -> surface-1 .56');
    fw('--app', 'helm', 'set', 'glass.dark.blurPx', '5'); fw('--app', 'helm', 'set', 'glass.dark.dim', '0.5'); fw('--app', 'helm', 'set', 'glass.dark.panel', '0');
    must(await waitFor("Backdrop._lastRender().blur === 1.5 && Backdrop.state().glass.floor === 0.5 && Number(getComputedStyle(document.documentElement).getPropertyValue('--chrome-glass-a')) === Backdrop.state().glass.alpha && !document.documentElement.style.getPropertyValue('--surface-1')", 1500), 'back to seed, no inline surfaces');
    return 'blur ' + a + ' ms, dim ' + b + ' ms, panel ' + c + ' ms';
  });

  await test('light applies glass.light (blur + saturate 150%, white wash at dim, panel)', async () => {
    fw('--app', 'helm', 'set', 'theme', 'light');
    must(await waitFor("document.documentElement.getAttribute('data-theme') === 'light' && Backdrop.state().glass.theme === 'light'", 1500), 'light');
    const LOOKV = "(() => { const r = Backdrop._lastRender(); const g = Backdrop.state().glass; const cs = getComputedStyle(document.documentElement); const w = getComputedStyle(document.querySelector('.backdrop > .bg-wash')).backgroundColor; return { blur: r && r.blur, filter: r && r.filter, key: r && r.key, blurPx: g.blurPx, alpha: g.alpha, source: g.source, why: g.sourceReason, sat: g.saturate, wash: w, s1: cs.getPropertyValue('--surface-1').trim(), titlebar: getComputedStyle(document.getElementById('titlebar')).backgroundColor }; })()";
    const seed = must(await waitFor("(() => { const v = " + LOOKV + "; return v.blur === 3.6 && /saturate\\(150%\\)/.test(v.filter || '') && v.alpha === 0.45 && /255, 255, 255, 0\\.45/.test(v.wash) ? v : null; })()", 3000), 'light seed: 12 px -> 3.6, saturate, white .45') && await ev(LOOKV);
    if (!/not published|stale|own picture|Windows|off/.test(seed.why || '')) throw new Error('light own value without a reason: ' + JSON.stringify(seed));
    fw('--app', 'helm', 'set', 'glass.light.blurPx', '30'); fw('--app', 'helm', 'set', 'glass.light.dim', '0.7'); fw('--app', 'helm', 'set', 'glass.light.panel', '-0.2');
    must(await waitFile((d) => d.look.glass.v.light.blurPx === 30 && d.look.glass.v.light.dim === 0.7, 1500), 'file carries light 30/.7');
    const moved = must(await waitFor("(() => { const v = " + LOOKV + "; return v.blur === 9 && v.alpha === 0.7 && /255, 255, 255, 0\\.7\\)/.test(v.wash) && /255, 255, 255, 0\\.56\\)/.test(v.s1) ? v : null; })()", 2000), 'light 30/.7/-.2 applied') && await ev(LOOKV);
    fw('--app', 'helm', 'set', 'glass.light.blurPx', '12'); fw('--app', 'helm', 'set', 'glass.light.dim', '0.45'); fw('--app', 'helm', 'set', 'glass.light.panel', '0');
    must(await waitFor("Backdrop._lastRender().blur === 3.6 && Backdrop.state().glass.alpha === 0.45 && !document.documentElement.style.getPropertyValue('--surface-1')", 2000), 'light seed again');
    fw('--app', 'helm', 'set', 'theme', 'dark');
    const dark = must(await waitFor("document.documentElement.getAttribute('data-theme') === 'dark' && Backdrop._lastRender().blur === 1.5 && !/sat/.test(Backdrop._lastRender().key) && Backdrop.state().glass.saturate === 100 ? Backdrop.state().glass : null", 1500), 'dark again, no saturate') && await ev('Backdrop.state().glass');
    return 'seed ' + JSON.stringify(seed) + '\n    moved ' + JSON.stringify({ blur: moved.blur, alpha: moved.alpha, wash: moved.wash, s1: moved.s1 }) + '\n    dark ' + JSON.stringify({ alpha: dark.alpha, source: dark.source });
  });

  await test('local changes publish (accent, theme, glass)', async () => {
    const rev0 = look().rev;
    await ev('Settings.set({ accentHue: 100 }), 1');
    const a = must(await waitFile((d) => d.look.accent.v.hue === 100 && d.look.accent.by === 'quartz', 1000), 'accent 100 in file');
    await ev("QuartzTheme.setMode('light'), 1");
    const b = must(await waitFile((d) => d.look.theme.v === 'light' && d.look.theme.by === 'quartz', 1000), 'theme light in file');
    await ev("QuartzTheme.setMode('dark'), 1");
    must(await waitFile((d) => d.look.theme.v === 'dark', 1000), 'theme dark in file');
    await ev("(() => { const g = JSON.parse(JSON.stringify(Settings.get('glass'))); g.dark.dim = 0.55; Settings.set({ glass: g }); return 1; })()");
    const c = must(await waitFile((d) => d.look.glass.v.dark.dim === 0.55 && d.look.glass.by === 'quartz', 1000), 'glass in file');
    await ev("(() => { const g = JSON.parse(JSON.stringify(Settings.get('glass'))); g.dark.dim = 0.5; Settings.set({ glass: g, accentHue: null }); return 1; })()");
    must(await waitFile((d) => d.look.glass.v.dark.dim === 0.5 && d.look.accent.v.hue === null, 1000), 'restored');
    return 'accent ' + a + ' ms, theme ' + b + ' ms, glass ' + c + ' ms; rev ' + rev0 + ' -> ' + look().rev;
  });

  await test('sync switch: off stops both ways, on adopts the shared values', async () => {
    await ev('Settings.set({ lookSync: false }), 1');
    must(await waitFor("LookSync.status().state === 'off'", 1000), 'status off');
    fw('--app', 'helm', 'set', 'theme', 'light');
    await sleep(1200);
    if (await ev("document.documentElement.getAttribute('data-theme')") !== 'dark') throw new Error('followed while OFF');
    await ev('Settings.set({ accentHue: 222 }), 1');
    await sleep(600);
    if (look().look.accent.v.hue === 222) throw new Error('published while OFF');
    const offLine = await ev('LookSync.status().line');
    await ev('Settings.set({ lookSync: true }), 1');
    const a = must(await waitFor("document.documentElement.getAttribute('data-theme') === 'light' && Settings.get('accentHue') === null", 1000), 'adopted shared theme light + hue null');
    const msg = await ev('(LookSync._debug().applies.slice(-1)[0] || {}).message');
    if (!/Now matching the others/.test(msg || '')) throw new Error('no "Now matching" message: ' + msg);
    fw('--app', 'helm', 'set', 'theme', 'dark');
    must(await waitFor("document.documentElement.getAttribute('data-theme') === 'dark'", 1000), 'dark again');
    return 'off line="' + offLine + '"; adopt ' + a + ' ms, message="' + msg + '"';
  });

  await test('status states show in Settings > Look (corrupt, newer, missing, error, ok)', async () => {
    await ev('Settings.open(), 1');
    const row = "(() => { const e = document.querySelector('[data-look-status]'); return e ? e.getAttribute('data-state') + ' | ' + e.textContent : null; })()";
    const seen = [];
    // look-sync 8b9e452: a recovered damaged file is said ONCE as 'corrupt' (lookstatus), then the
    // true state (ok, with the reason), so the event history is checked, not the state at one moment.
    await ev("(window.__lsSeen = [], document.addEventListener('lookstatus', () => window.__lsSeen.push(LookSync.status().state + ' | ' + (LookSync.status().line || ''))), 1)");
    fw('corrupt');
    must(await waitFor("window.__lsSeen.some((s) => /^corrupt/.test(s))", 2000), 'corrupt said'); seen.push(await ev("window.__lsSeen.find((s) => /^corrupt/.test(s))"));
    must(await waitFor("LookSync.status().state === 'ok' && /damaged/.test(LookSync.status().line || LookSync.status().reason || '')", 2000), 'then ok with the reason'); seen.push(await ev(row));
    fw('newer');
    must(await waitFor("LookSync.status().state === 'newer'", 1500), 'newer'); seen.push(await ev(row));
    fs.unlinkSync(path.join(DIR, 'look.json'));
    must(await waitFor("LookSync.status().state === 'missing'", 1500), 'missing'); seen.push(await ev(row));
    await ev('Settings.set({ accentHue: 40 }), 1');   // re-creates the file
    must(await waitFile((d) => d.look.accent.v.hue === 40, 1500), 're-created on the next change');
    must(await waitFor("LookSync.status().state === 'ok'", 1500), 'ok after re-create'); seen.push(await ev(row));
    execFileSync('attrib', ['+R', path.join(DIR, 'look.json')]);
    try {
      await ev('Settings.set({ accentHue: 41 }), 1');
      must(await waitFor("LookSync.status().state === 'error'", 2500), 'error on an unwritable file'); seen.push(await ev(row));
    } finally { execFileSync('attrib', ['-R', path.join(DIR, 'look.json')]); }
    await ev('Settings.set({ accentHue: null }), 1');
    must(await waitFor("LookSync.status().state === 'ok'", 2500), 'ok again'); seen.push(await ev(row));
    await ev('Settings.close && Settings.close(), 1');
    const bad = fs.readdirSync(DIR).filter((f) => /bad-/.test(f));
    return '\n    ' + seen.join('\n    ') + '\n    damaged copies kept: ' + bad.length;
  });

  await test('migration runs once (old kind -> desktop, own pick kept)', async () => {
    await ev('window.__e2eMark = 1');
    await ev("(() => { const s = JSON.parse(localStorage.getItem('settings') || '{}'); s.newtabBackground = { kind: 'builtin', id: 'snow-peak', dim: 0.3 }; delete s.bgMigration; delete s.ownBackground; localStorage.setItem('settings', JSON.stringify(s)); location.reload(); return 1; })()").catch(() => 1);
    must(await waitFor("window.__e2eMark !== 1 && document.readyState === 'complete' && !!(window.Settings && window.LookSync)", 15000), 'reloaded'); await ev('LookSync.ready()');
    const a = await ev("[Settings.get('newtabBackground'), Settings.get('ownBackground'), Settings.get('bgMigration')]");
    if (a[0].kind !== 'desktop' || !a[1] || a[1].kind !== 'builtin' || a[2] !== 1) throw new Error('after first load ' + JSON.stringify(a));
    await ev("Settings.setBackgroundMode('own'), 1");
    const own = await ev("Settings.get('newtabBackground').kind");
    await ev('(window.__e2eMark = 1, location.reload(), 1)').catch(() => 1);
    must(await waitFor("window.__e2eMark !== 1 && document.readyState === 'complete' && !!(window.Settings && window.LookSync)", 15000), 'reloaded twice'); await ev('LookSync.ready()');
    const b = await ev("[Settings.get('newtabBackground').kind, Settings.get('bgMigration')]");
    if (b[0] !== own || own === 'desktop') throw new Error('re-migrated: own=' + own + ' after=' + JSON.stringify(b));
    await ev("Settings.setBackgroundMode('desktop'), 1");
    must(await waitFor("Backdrop.state().kind === 'desktop' && Backdrop.state().state === 'ok'", 3000), 'desktop again');
    return 'first load -> ' + JSON.stringify(a).slice(0, 160) + '; own choice survives reload: ' + b[0];
  });

  await test('lined up: offset follows a move, no re-blur', async () => {
    const RK = "(() => { const r = Backdrop._lastRender(); return JSON.stringify([r.key, r.width, r.height, r.blur, r.outWidth, r.outHeight, r.monitor, r.layer, Backdrop._cache ? Backdrop._cache() : null]); })()"; const before = await ev(RK);
    const check = "(() => { const p = LookSync.place(); const g = Backdrop.state().glass || {}; if (!p || !g.offset) return null; const ex = { x: p.display.x - p.content.x, y: p.display.y - p.content.y }; return Math.abs(g.offset.x - ex.x) <= 1 && Math.abs(g.offset.y - ex.y) <= 1 && g.lined ? { off: g.offset, content: p.content, tf: getComputedStyle(document.querySelector('.backdrop > .bg-photo')).transform } : null; })()";
    // Physical px for SetWindowPos; LookSync.place() is in DIPs, so compare against where it was.
    const x0 = await ev('LookSync.place().content.x');
    console.log('     ' + place(-19750, -19820, 1400, 860));
    const a = must(await waitFor(check + " && LookSync.place().content.x > " + (x0 + 100) + " ? " + check + ' : null', 2000), 'offset after move 1');
    const ga = await evGuest('window.__bgAlignState ? window.__bgAlignState() : null');
    const a1 = await ev(check);
    console.log('     ' + place(-20000, -20000, 1920, 1045));
    const b = must(await waitFor(check + " && LookSync.place().content.x < " + (a1.content.x - 100) + " ? " + check + ' : null', 2000), 'offset after move 2');
    await sleep(400);
    const after = await ev(RK);
    if (before !== after) throw new Error('re-blurred on move: ' + before.slice(0, 120) + ' -> ' + after.slice(0, 120));
    const gb = await evGuest('window.__bgAlignState ? window.__bgAlignState() : null');
    return '\n    move1 ' + JSON.stringify(a.v) + ' newtab ' + JSON.stringify(ga) + '\n    move2 ' + JSON.stringify(b.v) + ' newtab ' + JSON.stringify(gb);
  });

  /* ---- Helm's Home layer + the shared top-band guard (lane:quartz-helm-layers) ---- */
  // Hand-written desktop.guard (fake-writer has no guard). Written as Mantle
  // (another instance), atomically, with both revs bumped; the doc stays valid
  // per look-sync.js checkDesktop (guard is an extra field it does not check).
  // Written the way Mantle writes it: look-sync's writeAtomic, which retries a rename that
  // Windows refuses for a moment (a scanner or a reader holding look.json). A bare renameSync
  // here failed the run with EPERM where Mantle itself would have retried and landed.
  async function writeGuard(guard) {
    const f = path.join(DIR, 'look.json');
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    d.rev += 1;
    d.writer = { app: 'mantle', instance: 'functest-guard', pid: 1, at: new Date().toISOString() };
    d.desktop = Object.assign({}, d.desktop, { rev: d.desktop.rev + 1, by: 'mantle' });
    if (guard === undefined) delete d.desktop.guard; else d.desktop.guard = guard;
    const w = await LS.writeAtomic(DIR, JSON.stringify(d, null, 2) + '\n', { app: 'mantle' });
    if (!w.ok) throw new Error('guard write: ' + w.reason);
    return d.rev;
  }
  const ACTIVE_NT = "(() => { const t = getActiveTab(); return !!t && t.kind === 'page' && isNewTabUrl(t.url); })()";
  const HOME_ON = "(() => { const h = Backdrop.state().home; const t = getActiveTab(); return h.on && document.body.hasAttribute('data-bg-home') && !!t.viewEl && t.viewEl.classList.contains('own-layer') ? h : null; })()";
  const GUEST_BG = "(() => { const b = window.__background ? window.__background() : null; const img = document.getElementById('bg-image'); return { layer: b && b.layer, kind: b && b.kind, attr: document.documentElement.getAttribute('data-bg-layer'), bodyBg: getComputedStyle(document.body).backgroundColor, htmlBg: getComputedStyle(document.documentElement).backgroundColor, imgOn: !!(img && img.classList.contains('on')), imgBg: img ? getComputedStyle(img).backgroundImage.slice(0, 60) : null }; })()";
  async function guestWait(pred, ms) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 <= ms) { try { last = await evGuest(GUEST_BG); if (pred(last)) return { ok: true, ms: Date.now() - t0, v: last }; } catch (e) { last = e.message; } await sleep(80); }
    return { ok: false, ms: Date.now() - t0, v: last };
  }
  const transparent = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';

  await test('home: dark desktop new tab -> Home on, guest see-through on the chrome layer', async () => {
    fw('--app', 'helm', 'set', 'theme', 'dark');
    must(await waitFor("document.documentElement.getAttribute('data-theme') === 'dark' && Backdrop.state().kind === 'desktop' && Backdrop.state().state === 'ok'", 3000), 'dark desktop ok');
    if (!(await ev(ACTIVE_NT))) { await ev('createTab(newTabUrl()), 1'); }
    must(await waitFor(ACTIVE_NT, 3000), 'a new tab in front');
    const a = must(await waitFor(HOME_ON, 4000), 'Backdrop home on + body data-bg-home + webview.own-layer');
    const clear = await ev("(() => { const i = document.querySelector('.bg-clear-img'); const c = document.querySelector('.bg-clear'); return { on: c && c.getAttribute('data-on'), bg: i && i.style.backgroundImage.slice(0, 120), lined: i && i.hasAttribute('data-lined'), w: i && i.style.width, h: i && i.style.height }; })()");
    if (clear.on !== 'in' || !/wall-1\d\d/.test(clear.bg || '')) throw new Error('.bg-clear not showing the still: ' + JSON.stringify(clear));
    const g = must(await guestWait((v) => v && v.layer === 'chrome' && v.attr === 'chrome' && transparent(v.bodyBg) && !v.imgOn, 3000), 'guest layer chrome, body transparent, no still');
    return 'home ' + a + ' ms; clear ' + JSON.stringify(clear) + '; guest ' + JSON.stringify((await evGuest(GUEST_BG)));
  });

  await test('home: a web page in front keeps the same top band (Home stays on, same wash); only the guest loses .own-layer', async () => {
    must(await waitFor(ACTIVE_NT, 1000), 'a new tab in front');
    const BAND = "(() => { const s = Backdrop.state(); const q = (x) => getComputedStyle(document.querySelector(x)); const i = document.querySelector('.bg-clear-img');" +
      " return { on: s.home.on, attr: document.body.hasAttribute('data-bg-home'), clearOn: document.querySelector('.bg-clear').getAttribute('data-on'), img: i && i.style.backgroundImage.slice(0, 120)," +
      " clearOp: q('.bg-clear').opacity, photoVis: q('.bg-photo').visibility, wash: q('.bg-wash').backgroundColor, washOp: q('.bg-wash').opacity, alpha: s.glass.alpha, raised: s.glass.raised }; })()";
    await sleep(400);                                  // the first fade-in is done
    const nt = await ev(BAND);
    if (!nt.on || !nt.attr || nt.clearOn !== 'in' || nt.photoVis !== 'hidden') throw new Error('new tab: Home not on: ' + JSON.stringify(nt));
    await ev("(() => { window.__homeFlips = 0; window.__homeMo = new MutationObserver(() => { if (!document.body.hasAttribute('data-bg-home') || document.querySelector('.bg-clear').getAttribute('data-on') !== 'in') __homeFlips++; });" +
      " __homeMo.observe(document.body, { attributes: true, attributeFilter: ['data-bg-home'] }); __homeMo.observe(document.querySelector('.bg-clear'), { attributes: true, attributeFilter: ['data-on'] }); return 1; })()");
    await ev("navigateActiveTab('data:text/html,<title>x</title><p>plain page</p>'), 1");
    const a = must(await waitFor("(() => { const t = getActiveTab(); return t.viewEl && !t.viewEl.classList.contains('own-layer') && /^data:/.test(t.url); })()", 4000), 'web page in front, guest opaque');
    await sleep(700);                                  // a fade-out (300 ms) would have run by now
    const pg = await ev(BAND);
    const flips = await ev('(__homeMo.disconnect(), __homeFlips)');
    if (JSON.stringify(pg) !== JSON.stringify(nt)) throw new Error('top band changed with a web page in front: new tab ' + JSON.stringify(nt) + ' vs page ' + JSON.stringify(pg));
    if (flips) throw new Error('the Home layer flipped ' + flips + ' times on the switch');
    await ev('createTab(newTabUrl()), 1');
    must(await waitFor(HOME_ON, 4000), 'a fresh new tab: Home on, guest see-through');
    const nt2 = await ev(BAND);
    if (JSON.stringify(nt2) !== JSON.stringify(nt)) throw new Error('top band differs on the next new tab: ' + JSON.stringify(nt2));
    return 'page in front after ' + a + ' ms; same band ' + JSON.stringify(pg);
  });

  await test('guard: Mantle\'s desktop.guard applies, a stale one falls back with a reason (Settings says so)', async () => {
    must(await waitFor("Backdrop.state().kind === 'desktop' && Backdrop.state().state === 'ok' && Backdrop.state().glass.floor === 0.5 && Backdrop.state().glass.blurPx === 5", 3000), 'desktop ok at dim .5 / blur 5');
    const RK = '(Backdrop._lastRender() || {}).key';
    const key0 = await ev(RK);
    await writeGuard({ dark: { alpha: 0.6, dim: 0.5, blurPx: 5, contrast: 4.3 } });
    const a = must(await waitFor("(() => { const g = Backdrop.state().glass; const css = Number(getComputedStyle(document.documentElement).getPropertyValue('--chrome-glass-a')); return g.source === 'shared' && g.alpha === 0.6 && css === 0.6 ? g : null; })()", 3000), 'shared .6 on --chrome-glass-a');
    // CONTRACT: a guard change comes with a desktop rev bump, and the still URL
    // carries ?rev=, so a re-read of the still is expected here (the node
    // harness covers 'same still, new guard: no re-blur').
    const reread = (await ev(RK)) !== key0;
    await ev('Settings.open(), 1');
    const NOTE = "(() => { const e = document.querySelector('[data-glass-guard]'); return e ? { hidden: e.hidden, text: e.textContent } : null; })()";
    const n1 = must(await waitFor(NOTE + " && /shared with Mantle and Helm/.test(" + NOTE + '.text) && !' + NOTE + '.hidden ? ' + NOTE + ' : null', 3000), 'Settings note says shared') && await ev(NOTE);
    await writeGuard({ dark: { alpha: 0.6, dim: 0.6, blurPx: 5, contrast: 4.3 } });
    const b = must(await waitFor("(() => { const g = Backdrop.state().glass; const css = Number(getComputedStyle(document.documentElement).getPropertyValue('--chrome-glass-a')); return g.source === 'own' && /Dim \\.60/.test(g.sourceReason || '') && css === g.alpha ? g : null; })()", 3000), 'stale dim .6 -> own with a reason');
    const n2 = must(await waitFor(NOTE + " && /worked out by Quartz: .*Dim \\.60/.test(" + NOTE + '.text) ? ' + NOTE + ' : null', 3000), 'Settings note says Quartz + reason') && await ev(NOTE);
    await ev('Settings.close && Settings.close(), 1');
    await writeGuard(undefined);
    must(await waitFor("Backdrop.state().glass.source === 'own' && /no shared value/.test(Backdrop.state().glass.sourceReason || '')", 3000), 'guard removed -> own, "no shared value"');
    return 'shared ' + a + ' ms (still re-read for the rev bump: ' + reread + '), stale ' + b + ' ms\n    note shared: "' + n1.text + '"\n    note own:    "' + n2.text + '"';
  });

  await test('light guard: Mantle\'s desktop.guard.light is the white wash; missing/stale fall back to the dim with a reason (Settings says so)', async () => {
    fw('--app', 'helm', 'set', 'theme', 'light');
    must(await waitFor("document.documentElement.getAttribute('data-theme') === 'light' && Backdrop.state().kind === 'desktop' && Backdrop.state().state === 'ok' && Backdrop.state().glass.blurPx === 12", 3000), 'light desktop ok');
    const WASH = "Number((/rgba?\\(([^)]+)\\)/.exec(getComputedStyle(document.querySelector('.backdrop > .bg-wash')).backgroundColor) || [0, '0,0,0,1'])[1].split(/[ ,/]+/).filter(Boolean)[3] || 1)";
    await writeGuard({ dark: { alpha: 0.5, dim: 0.5, blurPx: 5, contrast: 4.21 } });
    const m = must(await waitFor("(() => { const g = Backdrop.state().glass; return g.source === 'own' && /light top band not published by Mantle yet/.test(g.sourceReason || '') && g.alpha === 0.45 && " + WASH + " === 0.45 ? g : null; })()", 3000), 'no light entry: dim .45 with the reason');
    await writeGuard({ dark: { alpha: 0.5, dim: 0.5, blurPx: 5, contrast: 4.21 }, light: { alpha: 0.55, contrast: 4.9, dim: 0.45, blurPx: 12, region: { topDip: 0, heightDip: 100 }, monitor: [1536, 864] } });
    const a = must(await waitFor("(() => { const g = Backdrop.state().glass; return g.source === 'shared' && g.alpha === 0.55 && g.raised && " + WASH + " === 0.55 && Number(getComputedStyle(document.documentElement).getPropertyValue('--chrome-glass-a')) === 0.55 ? g : null; })()", 3000), 'shared light .55 is the wash');
    await ev('Settings.open(), 1');
    const NOTE = "(() => { const e = document.querySelector('[data-glass-guard]'); return e ? { hidden: e.hidden, text: e.textContent } : null; })()";
    const n1 = must(await waitFor(NOTE + " && /^Light wash \\.55, shared with Mantle and Helm/.test(" + NOTE + '.text) && !' + NOTE + '.hidden ? ' + NOTE + ' : null', 3000), 'Settings note: light shared') && await ev(NOTE);
    await writeGuard({ dark: { alpha: 0.5, dim: 0.5, blurPx: 5, contrast: 4.21 }, light: { alpha: 0.55, contrast: 4.9, dim: 0.45, blurPx: 8 } });
    const b = must(await waitFor("(() => { const g = Backdrop.state().glass; return g.source === 'own' && /stale/.test(g.sourceReason || '') && g.alpha === 0.45 && " + WASH + " === 0.45 ? g : null; })()", 3000), 'stale blur -> dim .45, reason says stale');
    const n2 = must(await waitFor(NOTE + " && /^Light wash \\.45 \\(the Dim, not raised\\): light top band is stale/.test(" + NOTE + '.text) ? ' + NOTE + ' : null', 3000), 'Settings note: stale reason') && await ev(NOTE);
    await ev('Settings.close && Settings.close(), 1');
    await writeGuard({ dark: { alpha: 0.5, dim: 0.5, blurPx: 5, contrast: 4.21 } });
    fw('--app', 'helm', 'set', 'theme', 'dark');
    must(await waitFor("document.documentElement.getAttribute('data-theme') === 'dark' && Backdrop.state().glass.source === 'shared' && Backdrop.state().glass.alpha === 0.5", 3000), 'dark: shared .5 as before');
    return 'missing ' + m + ' ms, shared ' + a + ' ms, stale ' + b + ' ms\n    note shared: "' + n1.text + '"\n    note stale:  "' + n2.text + '"';
  });

  await test('light sliders: Settings > Look edits glass.light in light (labelled), glass.dark in dark', async () => {
    fw('--app', 'helm', 'set', 'theme', 'light');
    must(await waitFor("document.documentElement.getAttribute('data-theme') === 'light'", 1500), 'light');
    await ev('Settings.open(), 1');
    const UI = "(() => { const f = document.querySelector('[data-field=\"glass\"]'); if (!f) return null; const d = f.querySelector('#set-glass-dim'); const t = f.querySelector('.set-glass-title'); return { theme: f.getAttribute('data-glass-theme'), title: t && t.textContent, dim: d && d.value, held: !!f.querySelector('.set-glass-held') }; })()";
    const u = must(await waitFor("(() => { const u = " + UI + "; return u && u.theme === 'light' && /Light theme/.test(u.title) && u.dim === '45' && !u.held ? u : null; })()", 3000), 'light sliders shown, labelled, at .45') && await ev(UI);
    const darkBefore = look().look.glass.v.dark;
    await ev("(() => { const d = document.querySelector('#set-glass-dim'); d.value = '52'; d.dispatchEvent(new Event('input', { bubbles: true })); d.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()");
    must(await waitFile((d) => d.look.glass.v.light.dim === 0.52, 2000), 'file glass.light.dim .52');
    const darkAfter = look().look.glass.v.dark;
    if (JSON.stringify(darkBefore) !== JSON.stringify(darkAfter)) throw new Error('dark moved: ' + JSON.stringify([darkBefore, darkAfter]));
    must(await waitFor("Backdrop.state().glass.floor === 0.52 && Backdrop.state().glass.alpha >= 0.52", 2000), 'applied: light floor .52');
    await ev("(() => { const d = document.querySelector('#set-glass-dim'); d.value = '45'; d.dispatchEvent(new Event('input', { bubbles: true })); d.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()");
    must(await waitFile((d) => d.look.glass.v.light.dim === 0.45, 2000), 'back to .45');
    fw('--app', 'helm', 'set', 'theme', 'dark');
    const ud = must(await waitFor("(() => { const u = " + UI + "; return u && u.theme === 'dark' && /Dark theme/.test(u.title) && u.dim === '50' ? u : null; })()", 3000), 'dark sliders, labelled, at .50') && await ev(UI);
    await ev('Settings.close && Settings.close(), 1');
    return 'light ' + JSON.stringify(u) + '; dark ' + JSON.stringify(ud);
  });

  await test('home: light theme -> Home stays on, guest see-through on the chrome layer (one picture)', async () => {
    if (!(await ev(ACTIVE_NT))) { await ev('createTab(newTabUrl()), 1'); }
    must(await waitFor(HOME_ON, 3000), 'Home on in dark first');
    fw('--app', 'helm', 'set', 'theme', 'light');
    const a = must(await waitFor("document.documentElement.getAttribute('data-theme') === 'light' && " + HOME_ON, 3000), 'home on in light');
    const g = must(await guestWait((v) => v && v.layer === 'chrome' && v.attr === 'chrome' && transparent(v.bodyBg) && !v.imgOn, 3000), 'guest layer chrome in light');
    const gv = await evGuest(GUEST_BG);
    fw('--app', 'helm', 'set', 'theme', 'dark');
    must(await waitFor("document.documentElement.getAttribute('data-theme') === 'dark' && " + HOME_ON, 3000), 'dark again: Home on');
    return 'light Home ' + a + ' ms, guest ' + g + ' ms ' + JSON.stringify(gv);
  });

  // Why example.com stayed dark while Quartz was light: what PAGES see (prefers-color-scheme)
  // is Settings > Websites (siteTheme, default 'system' = Windows' apps mode), deliberately
  // separate from Quartz's own look. This pins that: light Quartz + Follow Windows -> pages get
  // Windows' mode; Always light / Always dark override it.
  await test('site theme: pages follow Settings > Websites (Windows apps mode), not Quartz\'s look', async () => {
    const reg = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'], { encoding: 'utf8' });
    const winDark = /0x0\b/.test(reg);
    fw('--app', 'helm', 'set', 'theme', 'light');
    must(await waitFor("document.documentElement.getAttribute('data-theme') === 'light'", 1500), 'Quartz light');
    await ev("createTab('data:text/html,<meta name=color-scheme content=\"light dark\"><title>lse2e-site</title><p>site</p>'), 1");
    const DARKQ = "matchMedia('(prefers-color-scheme: dark)').matches";
    async function site(want, ms) {
      const t0 = Date.now(); let last;
      while (Date.now() - t0 <= ms) {
        try {
          const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
          const t = targets.find((x) => /lse2e-site/.test(decodeURIComponent(String(x.url))) || x.title === 'lse2e-site');
          if (t) {
            const s = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
            await new Promise((r, j) => { s.on('open', r); s.on('error', j); });
            s.on('message', (raw) => { const m = JSON.parse(raw.toString()); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } });
            try { last = await evalIn(s, DARKQ); } finally { s.close(); }
            if (last === want) return { ok: true, ms: Date.now() - t0, v: last };
          } else last = 'no site target';
        } catch (e) { last = e.message; }
        await sleep(100);
      }
      return { ok: false, ms: Date.now() - t0, v: last };
    }
    const a = must(await site(winDark, 4000), 'Follow Windows: page dark=' + winDark + ' while Quartz is light');
    await ev("Settings.set({ siteTheme: 'light' }), 1");
    const b = must(await site(false, 2000), 'Always light: page light');
    await ev("Settings.set({ siteTheme: 'dark' }), 1");
    const c = must(await site(true, 2000), 'Always dark: page dark');
    await ev("Settings.set({ siteTheme: 'system' }), 1");
    must(await site(winDark, 2000), 'back to Follow Windows');
    await ev("(() => { const t = getActiveTab(); if (t && /lse2e-site/.test(decodeURIComponent(t.url))) closeTab(t.id); return 1; })()");
    return 'Windows apps mode ' + (winDark ? 'dark' : 'light') + ': follow ' + a + ' ms, light ' + b + ' ms, dark ' + c + ' ms';
  });

  // Last: the watcher has looked at every frame of the run by now.
  if (!ONLY || new RegExp(ONLY).test('invisible')) {
    const v = watcher.verdict(); results.push(['invisible', v.ok]); console.log((v.ok ? 'PASS ' : 'FAIL ') + v.line);
  }

  const pass = results.filter((r) => r[1]).length;
  ws.close();
  cleanup();
  console.log('looksync-e2e: ' + pass + ' passed, ' + (results.length - pass) + ' failed');
  process.exit(results.length - pass ? 1 : 0);
})().catch((e) => { try { cleanup(); } catch (e2) { /* best effort */ } console.log('looksync-e2e: harness error: ' + e.message); process.exit(2); });
