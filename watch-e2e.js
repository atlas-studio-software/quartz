require('./tools/lowcpu-optional.js');   // first: one capped browser at a time (requested 2026-09-17)
// watch-e2e.js -- Watch, Quartz's streaming hub, end to end: a REAL hidden Quartz test instance reading
// a LOCAL mock of every service (tests/watch-mock.js, built from tests/watch-fixtures/). Never a real
// service account, never the user's profile, cookies or live Quartz.
//
//   node watch-e2e.js [--cdp 9456] [--shots <dir>] [--measure]
//
//   --shots    where the screenshots go (default %TEMP%\quartz-watch-shots); captions in quartz-watch.txt.
//   --measure  also the idle-CPU A/B: the Watch tab idle 30 s vs a plain new tab idle 30 s, same instance.
//
// 1. The mock: one 127.0.0.1 server per service, switchable at runtime (ok / signed-out / changed-layout /
//    robot / slow / down). QUARTZ_WATCH_REBASE points the real origins at it; main honours that, and
//    the open/Edge stubs, the memory floor and the fake game file, for --test-profile instances only.
// 2. Quartz: e2e-kit's launch (--test-profile, off-screen, --show-inactive, --measure-visible), watched
//    by testwatch.js from before launch: the run FAILS if any window of it touches the screen.
// 3. Checks: Ctrl+Alt+W (real keys) opens ONE Watch tab and reuses it; the palette's Watch row; the tab
//    title and a blank omnibox; every service's fixture rows with the right titles; the hidden reader
//    (at most one mock page alive at any 200 ms sample, none after; never a visible window); each
//    failure mode on its own service with its reason and a Retry while the others keep their rows;
//    Retry re-reads; the game pause; card opens (a Quartz tab for YouTube, the Edge stub for Disney+
//    and Prime); search (local + YouTube from the mock + per-service links + the TMDB slot);
//    Settings > Watch; light and dark; the keyboard; reduced motion; frames over 20 ms; no console
//    errors; a quartz.log line per forced failure; a second boot draws from the cache before any read;
//    Forget empties the page and deletes the cache file. One small LIVE ESPN fetch (passes offline).
// Kills ONLY the processes it started and deletes its temp profile. One summary line:
// "watch-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
// i.ytimg.com never resolves in this instance: a still this file doesn't answer (one asked before
// its CDP client attached) fails here instead of reaching YouTube's real CDN
const NO_YT_NET = ['--host-resolver-rules=MAP *.ytimg.com ~NOTFOUND'];
const Mock = require('./tests/watch-mock');
const Stills = require('./tests/watch-yt-stills');
const Shape = require('./watch/shape');
const Merge = require('./watch/merge');

const ADAPTERS = {
  youtube: require('./watch/adapters/youtube'),
  disney: require('./watch/adapters/disney'),
  hulu: require('./watch/adapters/hulu'),
  prime: require('./watch/adapters/prime'),
  espn: require('./watch/adapters/espn'),
};
const IDS = ['youtube', 'disney', 'hulu', 'prime', 'espn'];
const NAMES = { youtube: 'YouTube', disney: 'Disney+', hulu: 'Hulu', prime: 'Prime Video', espn: 'ESPN' };

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9456'));
const SHOTS = opt('shots', path.join(os.tmpdir(), 'quartz-watch-shots'));
const MEASURE = argv.includes('--measure');
const TAG = 'quartz-watch-e2e-' + process.pid;
const OPEN_STUB = path.join(os.tmpdir(), TAG + '-open.txt');
const EDGE_STUB = path.join(os.tmpdir(), TAG + '-edge.txt');
const GAME_FILE = path.join(os.tmpdir(), TAG + '-game.flag');
const CAPTIONS = path.join(SHOTS, 'quartz-watch.txt');
const FIX = path.join(__dirname, 'tests', 'watch-fixtures');
const FORCE_GAP_MS = 31000;   // watch-main.js FORCE_GAP_MS is 30 s: a second Retry inside it reads once

/* ---- what the fixtures should become (the adapters run here, on the same fixture files) --------- */
const fxJson = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n + '.json'), 'utf8'));
function expectedItems() {
  const now = Date.now();
  const ctx = { now, tz: 'America/New_York', leagues: Shape.DEFAULT_LEAGUES.slice() };
  const out = {};
  // YouTube: the page's own state, as EXTRACT returns it.
  {
    const steps = { home: 'youtube-home', history: 'youtube-history', watchlater: 'youtube-watchlater' };
    const read = { now, steps: {} };
    for (const s of ADAPTERS.youtube.steps(ctx)) {
      const f = fxJson(steps[s.name]);
      read.steps[s.name] = { ok: true, status: 200, url: s.url, finalUrl: s.url, title: 'YouTube', captures: [], error: null,
        extracted: { data: f.ytInitialData, loggedIn: f.loggedIn, url: s.url, title: 'YouTube' } };
    }
    out.youtube = Shape.cleanResult(ADAPTERS.youtube.parse(read, ctx));
  }
  {
    const f = fxJson('disney-home');
    const read = { now, steps: { home: { ok: true, status: 200, url: 'https://www.disneyplus.com/home', finalUrl: 'https://www.disneyplus.com/home', title: f.title,
      extracted: { url: 'https://www.disneyplus.com/home', title: f.title, login: false }, error: null,
      captures: f.captures.map((c) => ({ url: 'https://disney.api.edge.bamgrid.com' + c.path, status: 200, json: c.json })) } } };
    const hub = fxJson('disney-hulu-hub');
    const hubUrl = 'https://www.disneyplus.com' + hub.finalPath;
    read.steps.hulu = { ok: true, status: 200, url: 'https://www.disneyplus.com/browse/hulu', finalUrl: hubUrl, title: hub.title,
      extracted: { url: hubUrl, title: hub.title, login: false, linkPrompt: false }, error: null,
      captures: hub.captures.map((c) => ({ url: 'https://disney.api.edge.bamgrid.com' + c.path, status: 200, json: c.json })) };
    out.disney = Shape.cleanResult(ADAPTERS.disney.parse(read, ctx));
  }
  {
    // Hulu: the home hub, then My Stuff, from the same fixtures the mock serves.
    const read = { now, steps: {} };
    for (const [name, fixture] of [['home', 'hulu-home'], ['mystuff', 'hulu-mystuff']]) {
      const f = fxJson(fixture);
      const u = 'https://www.hulu.com' + f.finalPath;
      read.steps[name] = { ok: true, status: 200, url: u, finalUrl: u, title: f.title, extracted: { url: u, title: f.title, login: false }, error: null,
        captures: f.captures.map((c) => ({ url: 'https://discover.hulu.com' + c.path, status: 200, json: c.json })) };
    }
    out.hulu = Shape.cleanResult(ADAPTERS.hulu.parse(read, ctx));
  }
  {
    const f = fxJson('prime-home');
    const store = f.store ? JSON.stringify(f.store) : null;
    const ex = { hydration: f.hydration ? JSON.stringify(f.hydration) : null, store, url: 'https://www.primevideo.com/', title: f.title,
      robot: false, signedIn: !!(f.store && f.store.RequestContext && f.store.RequestContext.customerID), signInPage: false, complete: true };
    const read = { now, steps: { home: { ok: true, status: 200, url: ex.url, finalUrl: ex.url, title: f.title, extracted: ex, captures: [], error: null } } };
    out.prime = Shape.cleanResult(ADAPTERS.prime.parse(read, ctx));
  }
  return out;
}

/* ---- PowerShell helpers (written to %TEMP%, run hidden) ------------------------------------------ */
const WIN_TYPES = String.raw`
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class WW {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@
[WW]::SetProcessDPIAware() | Out-Null
`;
// Prints "VISIBLE <n>" every time the number of visible top-level windows of the pid changes.
const VISIBLE_PS = String.raw`param([int]$Target)` + WIN_TYPES + String.raw`
$last = -1
while ($true) {
  $script:n = 0
  $cb = [WW+EnumProc]{ param($h, $p)
    $wp = 0; [WW]::GetWindowThreadProcessId($h, [ref]$wp) | Out-Null
    if ($wp -eq $Target -and [WW]::IsWindowVisible($h)) { $script:n++ }
    return $true }
  [WW]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  if ($script:n -ne $last) { "VISIBLE $($script:n)"; $last = $script:n }
  Start-Sleep -Milliseconds 50
}`;
// CPU of the whole process tree of $Root over $Seconds, as % of one core. First it puts the test's
// windows at the TOP of the z-order where they already are (off-screen; no move, no activation), so
// nothing occludes them; --measure-visible already keeps Chromium from throttling an occluded window.
const CPU_PS = String.raw`param([int]$Root, [int]$Seconds)` + WIN_TYPES + String.raw`
$cb = [WW+EnumProc]{ param($h, $p)
  $wp = 0; [WW]::GetWindowThreadProcessId($h, [ref]$wp) | Out-Null
  if ($wp -eq $Root -and [WW]::IsWindowVisible($h)) { [WW]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x0013) | Out-Null }
  return $true }
[WW]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
function Tree {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine)
  $ids = New-Object System.Collections.Generic.HashSet[int]; [void]$ids.Add($Root)
  $more = $true
  while ($more) { $more = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { [void]$ids.Add([int]$p.ProcessId); $more = $true } } }
  $kind = @{}; foreach ($p in $all) { if ($ids.Contains([int]$p.ProcessId)) { $t = 'main'; if ($p.CommandLine -match '--type=([a-z-]+)') { $t = $Matches[1] }; $kind[[int]$p.ProcessId] = $t } }
  return $kind
}
function Cpu($kind) { $o = @{}; foreach ($id in $kind.Keys) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { $o[$id] = $p.TotalProcessorTime.TotalMilliseconds } }; return $o }
$k0 = Tree; $c0 = Cpu $k0
$sw = [Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Seconds $Seconds
$k1 = Tree; $c1 = Cpu $k1
$ms = $sw.Elapsed.TotalMilliseconds
$total = 0; $byKind = @{}
foreach ($id in $c1.Keys) { $d = $c1[$id]; if ($c0.ContainsKey($id)) { $d = $d - $c0[$id] }; $total += $d; $t = $k1[$id]; if (-not $byKind.ContainsKey($t)) { $byKind[$t] = 0 }; $byKind[$t] += $d }
$gone = 0; foreach ($id in $c0.Keys) { if (-not $c1.ContainsKey($id)) { $gone++ } }
$parts = ($byKind.Keys | Sort-Object | ForEach-Object { '"' + $_ + '":' + [math]::Round($byKind[$_] / $ms * 100, 2) }) -join ','
'{"pct":' + [math]::Round($total / $ms * 100, 2) + ',"procs":' + $c1.Count + ',"gone":' + $gone + ',"ms":' + [math]::Round($ms) + ',"byKind":{' + $parts + '}}'
`;
function psFile(name, body) {
  const f = path.join(os.tmpdir(), TAG + '-' + name + '.ps1');
  fs.writeFileSync(f, body);
  return f;
}
function visibleWatcher(pid) {
  const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile('visible', VISIBLE_PS), '-Target', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const w = { counts: [], max: -1, first: -1 };
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const m = /^VISIBLE (\d+)/.exec(buf.slice(0, i).trim()); buf = buf.slice(i + 1);
      if (m) { const n = Number(m[1]); if (w.first < 0) w.first = n; w.counts.push(n); w.max = Math.max(w.max, n); }
    }
  });
  w.ready = async () => { for (let i = 0; i < 100 && w.first < 0; i++) await sleep(100); return w.first; };
  w.stop = () => { try { proc.kill(); } catch (e) { /* gone */ } };
  return w;
}
function cpuSample(pid, seconds) {
  return new Promise((resolve) => {
    const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile('cpu', CPU_PS), '-Root', String(pid), '-Seconds', String(seconds)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => { out += String(d); });
    proc.on('exit', () => { const line = out.split(/\r?\n/).find((l) => l.trim().startsWith('{')); try { resolve(JSON.parse(line)); } catch (e) { resolve({ pct: NaN, error: out.slice(0, 300) }); } });
  });
}

/* ---- small helpers --------------------------------------------------------------------------- */
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };
function luminance(rgb) {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(String(rgb));
  if (!m) return null;
  const c = [m[1], m[2], m[3]].map((v) => { v = Number(v) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  if (x === null || y === null) return 0;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** One live NHL scoreboard read by the real ESPN adapter. Passes when it parses OR there is no network. */
async function liveEspn(check, say) {
  const ctx = { now: Date.now(), tz: 'America/New_York', leagues: ['nhl'] };
  const steps = ADAPTERS.espn.steps(ctx);
  const nhl = steps.find((s) => s.name === 'nhl');
  let res;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    res = await fetch(nhl.url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    clearTimeout(t);
  } catch (e) {
    check(true, 'live ESPN: network unavailable, skipped (the run passes offline)', String((e && e.cause && e.cause.code) || (e && e.message) || e));
    return;
  }
  let json = null;
  try { json = JSON.parse(await res.text()); } catch (e) { json = null; }
  if (!res.ok || !json) { check(true, 'live ESPN: the network answered HTTP ' + res.status + ' without JSON; skipped (not a parser verdict)'); return; }
  const read = { now: ctx.now, steps: {} };
  for (const s of steps) read.steps[s.name] = s.name === 'nhl' ? { ok: true, status: res.status, url: s.url, finalUrl: s.url, json, error: null } : { ok: false, status: 0, json: null, error: { code: 'http', detail: 'not fetched by the e2e' } };
  const r = Shape.cleanResult(ADAPTERS.espn.parse(read, ctx));
  say('live ESPN NHL: state ' + r.state + ', ' + (r.events || []).length + ' events' + (r.reason ? ' (' + r.reason + ')' : ''));
  check(r.state === 'ok' || r.state === 'empty', 'live ESPN: the real NHL scoreboard parses with the espn adapter (' + (r.events || []).length + ' events)', r.state + ' ' + r.reason);
}

/* ---- the guest (watch.html) over CDP ----------------------------------------------------------- */
async function guestTarget(q, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) {
    let list = [];
    try { list = await q.targets(); } catch (e) { list = []; }
    const t = list.find((x) => /\/watch\.html(\?|#|$)/.test(String(x.url)) && x.webSocketDebuggerUrl);
    if (t) return t;
    await sleep(60);
  }
  return null;
}
/** A CDP client on the Watch page that also keeps console errors and any event handler we add. */
async function openGuest(q, errors, ms) {
  const t = await guestTarget(q, ms);
  if (!t) throw new Error('the Watch page never appeared as a CDP target');
  const g = await new Cdp(t.webSocketDebuggerUrl).open();
  g.handlers = [];
  g.ws.on('message', (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (!m.method) return;
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) {
      errors.push('console.' + m.params.type + ': ' + (m.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ').slice(0, 300));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      errors.push('exception: ' + ((d.exception && d.exception.description) || d.text || '').slice(0, 300));
    } else if (m.method === 'Log.entryAdded' && m.params.entry && m.params.entry.level === 'error') {
      const e = m.params.entry;
      // A real thumbnail CDN that is offline (or 404s a fixture's made-up id) is the network's, not the page's.
      if (e.source === 'network') errors.netCount = (errors.netCount || 0) + 1;
      else errors.push('log.' + e.source + ': ' + String(e.text || '').slice(0, 300) + (e.url ? ' @' + e.url : ''));
    }
    if (m.method === 'Fetch.requestPaused') {
      // YouTube's stills are drawn here (tests/watch-yt-stills.js, YouTube's own sizes and formats), never
      // asked of the real CDN: every video shows the same still, keyed to one made-up id
      const rid = m.params.requestId, u = m.params.request.url;
      const p = Stills.parse(u);
      const r = p ? Stills.answer(g, u.replace(/\/(vi|vi_webp)\/[A-Za-z0-9_-]{11}\//, '/$1/watchE2E000/'), 'Watch e2e still') : Promise.resolve(null);
      r.then((x) => g.send('Fetch.fulfillRequest', x ? { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: x.mime }], body: x.body.toString('base64') }
        : { requestId: rid, responseCode: 404, responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }], body: '' }), () => g.send('Fetch.failRequest', { requestId: rid, errorReason: 'Failed' }));
    }
    for (const h of g.handlers) { try { h(m); } catch (e) { /* a test's handler */ } }
  });
  await g.send('Runtime.enable');
  await g.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*.ytimg.com/*', resourceType: 'Image', requestStage: 'Request' }] });
  await Stills.prepare(g, [{ id: 'watchE2E000', title: 'Watch e2e still' }]).catch(() => 0);   // drawn once per machine, kept on disk
  await g.send('Log.enable');
  await g.send('Page.enable');
  await g.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  g.target = t;
  return g;
}
/** Keep the last snapshot main pushed (window.__e2eSnap), without changing what the page does with it. */
const WRAP = `(() => {
  if (window.__e2eWrapped === window.__applyWatch && window.__applyWatch) return 1;
  const o = window.__applyWatch; if (typeof o !== 'function') return 0;
  const w = function (s) { window.__e2eSnap = s; window.__e2eSnaps = (window.__e2eSnaps || 0) + 1; return o.apply(this, arguments); };
  window.__applyWatch = w; window.__e2eWrapped = w;
  const os = window.__applyWatchSearch;
  if (typeof os === 'function') window.__applyWatchSearch = function (a) { window.__e2eSearch = a; return os.apply(this, arguments); };
  const orr = window.__applyWatchResult;
  if (typeof orr === 'function') window.__applyWatchResult = function (r) { (window.__e2eResults = window.__e2eResults || []).push(r); return orr.apply(this, arguments); };
  return 1; })()`;
/** Ask main for a fresh snapshot the way the page does on load (only due services read; none are, mid-run). */
const HELLO = "console.log('quartz-watch:hello {}'), 1";
const svcExpr = (id) => `((window.__e2eSnap && window.__e2eSnap.services) || []).find((s) => s.id === ${JSON.stringify(id)})`;
/** Every service in `ids` read since `since` (main's readAt) and nothing reading or queued. */
async function waitReads(g, ids, since, ms) {
  return g.waitFor(`(() => { const sn = window.__e2eSnap; if (!sn || !Array.isArray(sn.services)) return false;
    const want = ${JSON.stringify(ids)};
    if (sn.reading) return false;
    for (const s of sn.services) { if (s.queued || s.reading) return false; if (want.indexOf(s.id) !== -1 && !(s.readAt >= ${since})) return false; }
    return true; })()`, ms || 90000);
}


/* ---- the page's DOM: everything this file knows about watch.js's markup lives here ----------------- */
const UI = {
  /** The cards drawn in the lens rows: what each is for (its _item) and whether its title is on it. */
  cards: `[...document.querySelectorAll('#stack .lrow .rt > .card')].map((c) => { const it = c._item || {}; const b = c.getBoundingClientRect();
    return { title: it.title || '', service: it.service || '', url: it.url || '', key: c.dataset.key || '', drawn: !!it.title && (c.textContent || '').indexOf(it.title) !== -1,
      stale: c.classList.contains('stale'), w: Math.round(b.width), h: Math.round(b.height) }; })`,
  games: `[...document.querySelectorAll('#stack .lrow .gc')].map((c) => (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160))`,
  pill: (id) => `(() => { const p = document.querySelector('#pills .sp[data-svc="${id}"]'); if (!p) return null;
    const m = p.querySelector('.sp-main'); const a = p.querySelector('.sp-act'); const sm = m && m.querySelector('small');
    return { cls: p.className, small: sm ? sm.textContent : '', title: m ? (m.title || '') : '', aria: m ? (m.getAttribute('aria-label') || '') : '', act: a ? a.textContent : '' }; })()`,
};
// Why no card of a service could be clicked: each row's place, and for the service's cards in view what is on top.
const CARD_WHY = (id) => `(() => { const all = [...document.querySelectorAll('#stack .lrow .rt > .card')];
  const rows = [...document.querySelectorAll('#stack .lrow')].map((r) => { const b = r.getBoundingClientRect(); return Math.round(b.top) + ':' + r.querySelectorAll('.rt > .card').length; });
  const mine = all.filter((c) => c._item && c._item.service === ${JSON.stringify(id)});
  const inView = mine.filter((c) => { const b = c.getBoundingClientRect(); return b.width >= 20 && b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight; });
  const hit = inView.slice(0, 3).map((c) => { const b = c.getBoundingClientRect(); const h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return [Math.round(b.left), Math.round(b.top), h ? (h.tagName + '.' + String(h.className).slice(0, 40) + (h.id ? '#' + h.id : '')) : null]; });
  return { view: [innerWidth, innerHeight], rows, mine: mine.length, inView: inView.length, hit, active: document.activeElement ? document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 30) : null,
    body: document.body.className.slice(0, 80), open: [!!(window.LumenShows && LumenShows.isOpen()), !!(window.LumenSports && LumenSports.isOpen && LumenSports.isOpen())] }; })()`;
// An element whose middle is off screen or covered (e.g. Settings > Watch > Forget, below the fold of
// the sheet) is scrolled into view first, as a user would; a click there would land on the scrim.
const centerOf = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
  const at = () => { const b = e.getBoundingClientRect(); if (!b.width || !b.height) return null; const x = b.left + b.width / 2, y = b.top + b.height / 2;
    const hit = document.elementFromPoint(x, y); return { x, y, hit: !!hit && (hit === e || e.contains(hit)) }; };
  let r = at(); if (r && !r.hit) { try { e.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (err) { /* gone */ } r = at(); }
  return r; })()`;

/** A real left click (mouse events through CDP) at the middle of `sel` in page `c`. */
async function click(c, sel) {
  const r = await c.ev(centerOf(sel));
  if (!r) return false;
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 });
  return true;
}
const KEY = {
  Tab: { key: 'Tab', code: 'Tab', vk: 9 }, Enter: { key: 'Enter', code: 'Enter', vk: 13 }, Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 }, ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
};
async function press(c, name, mods) {
  const k = KEY[name];
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: mods || 0 };
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  if (name === 'Enter') await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'char', text: '\r' }, base));
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}
/** Ctrl+Alt+W as real key events into the chrome. */
async function ctrlAltW(chrome) {
  // Into the chrome's own document: a focused <webview> would route the keys into its page.
  await chrome.ev('(() => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); return 1; })()').catch(() => 0);
  const base = { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, modifiers: 3 };
  await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  await chrome.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}
const WATCH_TABS = 'tabs.filter((t) => t && isWatchUrl(t.url))';
const ACTIVE_IS_WATCH = '(() => { const w = findWatchTab(); return !!w && activeTabId === w.id; })()';

/** Retry the way a user does: the pill's own Retry, else its popover's Retry / Read now. */
async function retry(g, id) {
  const p = await g.ev(UI.pill(id));
  if (p && p.act === 'Retry') return click(g, '#pills .sp[data-svc="' + id + '"] .sp-act');
  if (!(await click(g, '#pills .sp[data-svc="' + id + '"] .sp-main'))) return false;
  const why = async (what) => console.log('[e2e] retry ' + id + ': ' + what + ' ' + JSON.stringify(await g.ev(`(() => { const sn = window.__e2eSnap; const s = sn && Array.isArray(sn.services) ? sn.services.find((x) => x.id === ${JSON.stringify(id)}) : null;
    return { svc: s && { state: s.state, reading: s.reading, queued: s.queued, paused: s.paused }, pop: !document.getElementById('pop').hidden, acts: [...document.querySelectorAll('#pop .acts button')].map((b) => b.textContent.trim() + (b.disabled ? '(disabled)' : '')), trace: (window.__e2eTrace || []).slice(-12) }; })()`).catch(() => null)));
  try { await g.waitFor("!document.getElementById('pop').hidden && !!document.querySelector('#pop .acts button')", 3000); } catch (e) { await why('the popover did not open with its buttons'); return false; }
  const ok = await g.ev(`(() => { const b = [...document.querySelectorAll('#pop .acts button')].find((x) => /^(Retry|Read now)$/.test(x.textContent.trim()));
    if (!b) return false; b.setAttribute('data-e2e-retry', '1'); return true; })()`);
  if (!ok) { await why('no Retry / Read now in the popover'); return false; }
  // Say why, when the popover's button is not the thing on top where it is drawn (or is disabled).
  const at = await g.ev(centerOf('#pop [data-e2e-retry="1"]')).catch(() => null);
  const st = await g.ev(`(() => { const b = document.querySelector('#pop [data-e2e-retry="1"]'); const p = document.getElementById('pop');
    const h = at => { const e = document.elementFromPoint(at.x, at.y); return e ? (e.tagName + '.' + String(e.className)).slice(0, 60) : null; };
    return { popHidden: p.hidden, disabled: !!(b && b.disabled), text: b ? b.textContent : null, top: ${at ? 'h(' + JSON.stringify(at) + ')' : 'null'} }; })()`).catch(() => null);
  if (!at || !at.hit || (st && (st.popHidden || st.disabled))) {
    const sv = await g.ev(`(() => { const sn = window.__e2eSnap; const s = sn && Array.isArray(sn.services) ? sn.services.find((x) => x.id === ${JSON.stringify(id)}) : null;
      return s ? { state: s.state, reading: s.reading, queued: s.queued, readingFor: s.readingSince ? Date.now() - s.readingSince : 0, readLimitMs: s.readLimitMs, readAgo: s.readAt ? Date.now() - s.readAt : 0 } : null; })()`).catch(() => null);
    console.log('[e2e] retry diag ' + id + ': ' + JSON.stringify({ at, st, svc: sv }));
    if (st && st.disabled) console.log('[e2e] read trace (ms mod 1e6, R reading, Q queued, then Hulu state): ' + JSON.stringify(await g.ev('(window.__e2eTrace || []).slice(-30)').catch(() => null)) + ' now ' + (Date.now() % 1e6));
  }
  // Say so when the press fired no click on the button (it was rebuilt under the press: watch/presshold.js).
  await g.ev(`(() => { const b = document.querySelector('#pop [data-e2e-retry="1"]'); window.__e2eRetryHit = 0;
    if (b) b.addEventListener('click', () => { window.__e2eRetryHit++; }, { once: true }); return 1; })()`).catch(() => 0);
  const pressed = await click(g, '#pop [data-e2e-retry="1"]');
  if (pressed && !(await g.ev('window.__e2eRetryHit || 0').catch(() => 1))) console.log('[e2e] retry ' + id + ': the press fired no click on the popover\'s button (rebuilt under the press?)');
  return pressed;
}

async function shot(g, name, w, h, caption, say, chrome) {
  const file = path.join(SHOTS, 'quartz-watch-' + name + '.png');
  // A metrics override LARGER than the guest's real view tiles the page (the hidden test window
  // is ~1624x933). So when the shot is bigger than the <webview>, the chrome grows that element to
  // the shot's size for the shot (fixed, over everything), and puts its style back after.
  let grown = false;
  if (chrome) {
    const r = await chrome.ev('(() => { const t = findWatchTab(); const v = t && t.viewEl; if (!v) return null; const b = v.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })()').catch(() => null);
    if (r && (r.w < w || r.h < h)) {
      grown = !!(await chrome.ev('(() => { const v = findWatchTab().viewEl; v.dataset.e2eStyle = v.getAttribute("style") || ""; const s = v.style;'
        + ' s.setProperty("position", "fixed", "important"); s.setProperty("left", "0px", "important"); s.setProperty("top", "0px", "important");'
        + ' s.setProperty("width", "' + w + 'px", "important"); s.setProperty("height", "' + h + 'px", "important"); s.setProperty("z-index", "2147483647", "important"); return 1; })()').catch(() => 0));
      await sleep(600);
      const now = await g.ev('[innerWidth, innerHeight]').catch(() => null);
      say('shot ' + name + ': the webview was ' + r.w + 'x' + r.h + ', grown to ' + w + 'x' + h + ' for the shot; the page now sees ' + JSON.stringify(now));
    }
  }
  try {
    return await shotInner(g, file, name, w, h, caption, say);
  } finally {
    if (grown) {
      await chrome.ev('(() => { const t = findWatchTab(); const v = t && t.viewEl; if (!v) return 0; v.setAttribute("style", v.dataset.e2eStyle || ""); delete v.dataset.e2eStyle; return 1; })()').catch(() => 0);
      await sleep(400);
    }
  }
}
async function shotInner(g, file, name, w, h, caption, say) {
  await g.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  // Let the lens re-measure, and give the thumbnails a moment (they come from the services' own CDNs).
  await sleep(700);
  await g.ev("new Promise((r) => { const imgs = [...document.images].filter((i) => !i.complete); if (!imgs.length) return r(1); let n = imgs.length; const done = () => { if (--n <= 0) r(1); }; imgs.forEach((i) => { i.addEventListener('load', done, { once: true }); i.addEventListener('error', done, { once: true }); }); setTimeout(() => r(0), 3500); })").catch(() => 0);
  await sleep(500);
  let ok = true;
  try { await g.shot(file); } catch (e) { ok = false; say('shot ' + name + ' failed: ' + e.message); }
  await g.send('Emulation.clearDeviceMetricsOverride');
  if (ok) fs.appendFileSync(CAPTIONS, 'quartz-watch-' + name + '.png: ' + caption + '\n');
  return ok;
}

/* ---- modes: --boot2 N, --motion N [--trace file] [--theme dark|light] -------------------------- */
// Normal runs are unchanged. --boot2 N: seed a cache with one short boot, then N second boots that
// open Watch AND a control bundled page (Files) at the same early moment, alternating which goes
// first, and say which pages logged Electron's sandbox-bundle error. --motion N: only the lens
// stepping frame measurement, N fresh launches; --trace records run 1 and summarises it.
const BOOT2_N = Math.max(0, Math.floor(Number(opt('boot2', '0')) || 0));
const MOTION_N = Math.max(0, Math.floor(Number(opt('motion', '0')) || 0));
const TRACE = opt('trace', '');
const THEME = opt('theme', 'dark');
const BOOT1_GRACE_MS = 8000;   // the normal run's boot 1 only: long enough to put Watch in the background first
const SANDBOX = /sandboxed_renderer\.bundle\.js|binding\.startupData/;
const STEP_KEYS = ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowLeft'];
const TRACE_CATS = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
  'blink', 'cc', 'gpu', 'viz', 'disabled-by-default-devtools.timeline.invalidationTracking'];
const loadNote = () => (fs.existsSync(path.join(os.tmpdir(), 'claude-heavytest.mutex2')) ? 'UNDER LOAD (mutex2 held)' : 'clean (mutex2 absent)');

function mockEnv(mock, graceMs) {
  return {
    // main.js (--test-profile only): the first reader waits this long after app start (a real
    // Quartz waits 10 s; reads before then sit queued). 0 keeps the e2e's timings.
    QUARTZ_WATCH_BOOT_GRACE_MS: String(graceMs === undefined ? 0 : graceMs),
    QUARTZ_WATCH_REBASE: JSON.stringify(mock.rebase),
    QUARTZ_WATCH_OPEN_STUB: OPEN_STUB,
    QUARTZ_EDGE_STUB: EDGE_STUB,
    QUARTZ_WATCH_MIN_FREE_GB: '0',
    QUARTZ_WATCH_GAME_FILE: GAME_FILE,
    QUARTZ_TEST_MIN_FREE_GB: '0',
  };
}
/** The first title the YouTube search fixture yields (what an answered search draws). */
function ytSearchTitle() {
  try { const l = Shape.cleanItems(ADAPTERS.youtube.parseSearch(readText(path.join(FIX, 'youtube-search.html'))), 20); return (l[0] && l[0].title) || ''; } catch (e) { return ''; }
}
const isMockUrl = (mock, u) => IDS.some((id) => String(u).indexOf(mock.origin(id) + '/') === 0 || String(u) === mock.origin(id));

/**
 * The lens-stepping frame measurement (the normal run's and --motion's): a rAF recorder, the ten
 * steps 750 ms apart, each marked with console.timeStamp('e2e-step-<i>') for a trace. Returns the
 * frames and the classification: a long frame within 300 ms of the FIRST wash cross-fade is the
 * one-time first paint (watch-lead's bar); any other over 20 ms is steady stepping.
 */
async function measureMotion(g, o) {
  o = o || {};
  await g.send('Performance.enable');
  const layouts = async () => { const m = await g.send('Performance.getMetrics'); const x = ((m.result && m.result.metrics) || []).find((v) => v.name === 'LayoutCount'); return x ? x.value : NaN; };
  let tracing = false;
  if (o.trace) {
    try { await g.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: TRACE_CATS } }); tracing = true; await sleep(300); } catch (e) { if (o.say) o.say('trace: could not start: ' + e.message.slice(0, 120)); }
  }
  await g.ev(`(() => { window.__e2eFr = { d: [], ts: [], on: true, wash: 0, washT: [], long: [], stepT: [], step: -1, stepAt: 0, t0: performance.now() }; let last = performance.now();
    const f = (t) => { const x = window.__e2eFr; if (!x.on) return; const dt = t - last; x.d.push(dt); x.ts.push(t); last = t;
      if (dt > 20 && x.d.length > 3) x.long.push({ at: Math.round(t - x.t0), dt: Math.round(dt * 10) / 10, step: x.step, sinceStep: Math.round(t - x.stepAt), washesBefore: x.wash });
      requestAnimationFrame(f); }; requestAnimationFrame(f);
    const mo = new MutationObserver((ms) => { for (const m of ms) if (m.target.tagName === 'CANVAS' && m.target.classList.contains('on')) { const x = window.__e2eFr; x.wash++; x.washT.push(Math.round(performance.now() - x.t0)); } });
    document.querySelectorAll('#wash canvas').forEach((c) => mo.observe(c, { attributes: true, attributeFilter: ['class'] })); window.__e2eFr.mo = mo; return 1; })()`);
  await g.ev("(() => { const c = document.querySelector('#stack .lrow[data-d=\"0\"] .rt [tabindex=\"0\"]'); if (c) c.focus({ preventScroll: true }); return !!c; })()");
  // The keys must land on a card in the rows (as a user's would); Tab there if focus() did not.
  const inRow = "(() => { const a = document.activeElement; return !!(a && a.closest && a.closest('#stack .lrow') && a.matches('.card, .gc')); })()";
  for (let i = 0; i < 30 && !(await g.ev(inRow).catch(() => false)); i++) await press(g, 'Tab');
  if (o.say) o.say('motion: keys go to a card in the rows: ' + await g.ev(inRow).catch(() => false));
  // What the page is carrying when it starts stepping (a long session vs a fresh launch).
  if (o.say) o.say('motion: the page before stepping: ' + await g.ev("JSON.stringify({ els: document.getElementsByTagName('*').length, imgs: document.images.length, anims: document.getAnimations().length, view: innerWidth + 'x' + innerHeight + '@' + devicePixelRatio, theme: document.documentElement.getAttribute('data-theme'), body: document.body.className, stage: (document.getElementById('stage') || {}).className })").catch(() => '?'));
  const l0 = await layouts();
  const WHERE = "(() => { const a = document.activeElement; const r = document.querySelector('#stack .lrow[data-d=\"0\"]'); return (r ? String(r.dataset.key).slice(0, 8) : '-') + '/' + (a && a.dataset ? String(a.dataset.key || a.tagName).slice(-6) : '-'); })()";
  const seen = [await g.ev(WHERE).catch(() => '?')];
  for (let i = 0; i < STEP_KEYS.length; i++) {
    await g.ev('(() => { const x = window.__e2eFr; x.step = ' + i + '; x.stepAt = performance.now(); x.stepT.push(x.stepAt); console.timeStamp("e2e-step-' + i + '"); return 1; })()');
    await press(g, STEP_KEYS[i]);
    await sleep(750);
    seen.push(await g.ev(WHERE).catch(() => '?'));
  }
  if (o.say) o.say('motion: focus after each step (row/card): ' + seen.join(' '));
  await sleep(600);
  const fr = await g.ev("(() => { const x = window.__e2eFr; x.on = false; x.mo.disconnect(); const d = x.d.slice(3); return { n: d.length, over: d.filter((v) => v > 20).length, max: Math.max.apply(null, d), wash: x.wash, washT: x.washT, long: x.long, ts: x.ts, stepT: x.stepT, t0: x.t0 }; })()");
  const l1 = await layouts();
  let summary = null;
  if (tracing) {
    try { await traceToFile(g, o.trace); summary = summarizeTrace(o.trace, fr); fs.writeFileSync(o.trace + '.summary.json', JSON.stringify(summary, null, 1)); if (o.say) o.say('trace: ' + o.trace + ' (' + Math.round(fs.statSync(o.trace).size / 1048576) + ' MB), summary ' + o.trace + '.summary.json'); } catch (e) { if (o.say) o.say('trace: failed: ' + e.message.slice(0, 160)); }
  }
  delete fr.ts; delete fr.stepT; delete fr.t0;   // only the trace summary needs them; the log does not
  const firstWash = (fr.washT || [])[0];
  const atFirstWash = (l) => firstWash !== undefined && Math.abs(l.at - firstWash) <= 300;
  const steadyLong = (fr.long || []).filter((l) => !atFirstWash(l));
  const firstLong = (fr.long || []).filter(atFirstWash);
  return { fr, layouts: l1 - l0, steadyLong, firstLong, summary };
}

/** Tracing.end, then the stream (IO.read) into `file`, chunk by chunk. */
async function traceToFile(g, file) {
  let resolve; const done = new Promise((r) => { resolve = r; });
  const h = (m) => { if (m.method === 'Tracing.tracingComplete') resolve(m.params || {}); };
  g.handlers.push(h);
  await g.send('Tracing.end');
  const p = await Promise.race([done, sleep(60000).then(() => null)]);
  g.handlers.splice(g.handlers.indexOf(h), 1);
  if (!p || !p.stream) throw new Error('no trace stream (tracingComplete ' + (p ? 'without a stream' : 'never came') + ')');
  const fd = fs.openSync(file, 'w');
  try {
    for (;;) {
      const r = (await g.send('IO.read', { handle: p.stream, size: 4 << 20 })).result || {};
      if (r.data) fs.writeSync(fd, r.base64Encoded ? Buffer.from(r.data, 'base64') : Buffer.from(r.data, 'utf8'));
      if (r.eof || !r.data) break;
    }
  } finally { fs.closeSync(fd); await g.send('IO.close', { handle: p.stream }).catch(() => 0); }
}

/**
 * For each rAF interval over 18 ms (a 60 Hz frame is 16.7 ms; rAF jitter keeps most within about
 * 16.2-17.2), the top events by self time on every thread of the Watch guest's renderer (the
 * process that logged the e2e-step marks) and the GPU process, its Paint events (layer, node, rect)
 * and invalidation records; and per step, paint count and area.
 */
function summarizeTrace(file, fr) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ev = Array.isArray(raw) ? raw : (raw.traceEvents || []);
  const marks = ev.filter((e) => e.name === 'TimeStamp' && e.args && e.args.data && /^e2e-step-\d+$/.test(String(e.args.data.message || '')));
  const m0 = marks.find((e) => e.args.data.message === 'e2e-step-0');
  if (!m0 || !fr.stepT || !fr.stepT.length) return { error: 'no e2e-step-0 mark in the trace (' + ev.length + ' events)' };
  const pid = m0.pid;
  const thread = {}, proc = {};
  for (const e of ev) if (e.ph === 'M' && e.args) { if (e.name === 'thread_name') thread[e.pid + ':' + e.tid] = e.args.name; else if (e.name === 'process_name') proc[e.pid] = e.args.name; }
  const offsetUs = m0.ts - fr.stepT[0] * 1000;   // trace µs = perf ms * 1000 + offset
  const us = (ms) => ms * 1000 + offsetUs;
  const lists = new Map(), open = new Map();
  for (const e of ev) {
    const gpu = /gpu/i.test(proc[e.pid] || '');
    if (e.pid !== pid && !gpu) continue;
    const tk = e.pid + ':' + e.tid;
    let x = null;
    if (e.ph === 'X') x = { name: e.name, ts: e.ts, dur: e.dur || 0, args: e.args };
    else if (e.ph === 'B') { if (!open.has(tk)) open.set(tk, []); open.get(tk).push(e); continue; }
    else if (e.ph === 'E') { const b = (open.get(tk) || []).pop(); if (!b) continue; x = { name: b.name, ts: b.ts, dur: e.ts - b.ts, args: Object.assign({}, b.args, e.args) }; }
    else continue;
    x.thread = (gpu ? 'gpu:' : '') + (thread[tk] || 'tid ' + e.tid);
    if (!lists.has(tk)) lists.set(tk, []);
    lists.get(tk).push(x);
  }
  const all = [];
  for (const list of lists.values()) {
    list.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const st = [];
    for (const x of list) {
      x.self = x.dur;
      while (st.length && st[st.length - 1].ts + st[st.length - 1].dur <= x.ts) st.pop();
      if (st.length) st[st.length - 1].self -= x.dur;
      st.push(x); all.push(x);
    }
  }
  all.sort((a, b) => a.ts - b.ts);
  const inv = ev.filter((e) => e.pid === pid && /InvalidationTracking/.test(e.name)).sort((a, b) => a.ts - b.ts);
  const KEY = /^(Paint|PaintImage|RasterTask|Decode Image|ImageDecodeTask|Decode LazyPixelRef|UpdateLayerTree|Layout|Layerize|PrePaint|UpdateLayer|Commit|ScheduleStyleRecalculation|UpdateLayoutTree|RecalculateStyles)$/;
  const rect = (a) => { const c = a && a.data && a.data.clip; if (!Array.isArray(c) || c.length < 8) return null; const xs = [c[0], c[2], c[4], c[6]], ys = [c[1], c[3], c[5], c[7]]; return { w: Math.round(Math.max(...xs) - Math.min(...xs)), h: Math.round(Math.max(...ys) - Math.min(...ys)) }; };
  const win = (a, b) => {
    const xs = all.filter((x) => x.ts >= a && x.ts < b);
    const per = {};
    for (const x of xs) { const t = per[x.thread] || (per[x.thread] = {}); const r = t[x.name] || (t[x.name] = { name: x.name, selfMs: 0, n: 0 }); r.selfMs += Math.max(0, x.self) / 1000; r.n++; }
    const top = {};
    for (const th of Object.keys(per)) {
      const rows = Object.values(per[th]).sort((p, q) => q.selfMs - p.selfMs).filter((r, i) => i < 8 || KEY.test(r.name)).map((r) => ({ name: r.name, selfMs: +r.selfMs.toFixed(2), n: r.n }));
      if (rows.some((r) => r.selfMs >= 0.05)) top[th] = rows;
    }
    const paints = xs.filter((x) => x.name === 'Paint').map((x) => { const r = rect(x.args); const d = (x.args && x.args.data) || {}; return { layerId: d.layerId, nodeId: d.nodeId, w: r ? r.w : null, h: r ? r.h : null, ms: +(x.dur / 1000).toFixed(2) }; });
    const invs = inv.filter((e) => e.ts >= a && e.ts < b).slice(0, 12).map((e) => { const d = (e.args && e.args.data) || {}; return { what: e.name, nodeId: d.nodeId, node: d.nodeName, reason: d.reason, layerId: d.layerId }; });
    return { top, paints: paints.length, paintArea: paints.reduce((s, p) => s + (p.w || 0) * (p.h || 0), 0), paintList: paints.slice(0, 12), invalidations: invs };
  };
  const stepOf = (t) => { let s = -1; for (let i = 0; i < fr.stepT.length; i++) if (fr.stepT[i] <= t) s = i; return s; };
  const frames = [];
  for (let i = 4; i < fr.ts.length; i++) {
    const dt = fr.ts[i] - fr.ts[i - 1];
    if (dt <= 18) continue;
    const s = stepOf(fr.ts[i - 1]);
    frames.push(Object.assign({ atMs: Math.round(fr.ts[i] - fr.t0), dt: +dt.toFixed(1), over20: dt > 20, step: s, key: STEP_KEYS[s] || null, sinceStepMs: s >= 0 ? Math.round(fr.ts[i - 1] - fr.stepT[s]) : null }, win(us(fr.ts[i - 1]), us(fr.ts[i]))));
  }
  frames.sort((p, q) => q.dt - p.dt);
  const end = fr.ts[fr.ts.length - 1];
  const steps = fr.stepT.map((t, i) => { const w = win(us(t), us(i + 1 < fr.stepT.length ? fr.stepT[i + 1] : end)); return { step: i, key: STEP_KEYS[i], paints: w.paints, paintArea: w.paintArea, paintList: w.paintList.slice(0, 6), main: (w.top.CrRendererMain || []).slice(0, 6) }; });
  return { file, events: ev.length, rendererPid: pid, threads: [...new Set(all.map((x) => x.thread))], offsetUs: Math.round(offsetUs),
    washT: fr.washT, longFrames: fr.long, threshold: 'rAF intervals over 18 ms (16.7 ms is one 60 Hz frame); over20 marks the ones the e2e counts', frames: frames.slice(0, 40), steps };
}

/** --motion N: the stepping measurement alone, N fresh launches; --trace records run 1. */
async function runMotion(ctx, N) {
  const { launch, say, check, setLive } = ctx;
  const mock = await Mock.start({ log: () => {} });
  const env = mockEnv(mock);
  const per = [];
  try {
    for (let run = 1; run <= N; run++) {
      const q = await launch({ cdp: CDP_PORT, args: NO_YT_NET, env });
      setLive(q);
      try {
        await q.chrome.ev('setTheme(' + JSON.stringify(THEME) + '), 1').catch(() => 0);
        await ctrlAltW(q.chrome);
        const g = await openGuest(q, [], 15000);
        await g.ev(WRAP).catch(() => 0); await g.ev(HELLO).catch(() => 0);
        say('motion run ' + run + ': guest visibilityState ' + await g.ev('document.visibilityState').catch(() => '?'));
        // Real rows (cards that carry an item), not the skeleton's 8 placeholders.
        const REAL = '[...document.querySelectorAll("#stack .lrow .rt > .card")].filter((c) => c._item && c._item.title).length';
        let rows = 0;
        try { rows = await g.waitFor('(' + REAL + ') || null', 120000); } catch (e) { rows = 0; }
        await waitReads(g, [], 0, 90000).catch(() => 0);     // nothing reading or queued while it steps
        await sleep(1500);
        rows = await g.ev(REAL).catch(() => 0);
        const st = await g.ev('(() => { const s = window.__e2eSnap || {}; return (s.services || []).map((x) => x.id + ":" + x.state + (x.reading ? "/reading" : "") + (x.queued ? "/queued" : "")).join(" ") + " | rows " + document.querySelectorAll("#stack .lrow").length; })()').catch(() => '?');
        say('motion run ' + run + ': before stepping: ' + rows + ' real cards; ' + st);
        if (!rows) { check(false, 'motion run ' + run + ': real rows to step through (none drew: ' + st + ')'); continue; }
        // The webview must hold the window's focus, or keys sent to the guest move nothing.
        await q.chrome.ev('(() => { const w = findWatchTab(); if (w && w.viewEl) w.viewEl.focus(); return !!w; })()').catch(() => 0);
        await sleep(200);
        say('motion run ' + run + ': guest document.hasFocus() ' + await g.ev('document.hasFocus()').catch(() => '?'));
        const mm = await measureMotion(g, { trace: run === 1 ? TRACE : '', say });
        const fr = mm.fr;
        per.push({ run, steady: mm.steadyLong.length, max: fr.max, n: fr.n });
        say('motion run ' + run + ' [' + loadNote() + ', ' + THEME + ', ' + rows + ' cards]: ' + fr.n + ' frames, ' + fr.over + ' over 20 ms (max ' + fr.max.toFixed(1) + ' ms); steady stepping over 20 ms: '
          + mm.steadyLong.length + (mm.steadyLong.length ? ' (' + mm.steadyLong.map((l) => l.dt + ' ms at step ' + l.step + ' ' + STEP_KEYS[l.step] + ' +' + l.sinceStep + ' ms').join(', ') + ')' : '')
          + '; first wash paint: ' + mm.firstLong.map((l) => l.dt + ' ms').join(', ') + '; wash cross-fades ' + fr.wash + ' at ' + JSON.stringify(fr.washT) + '; layouts ' + mm.layouts);
        check(fr.n > 200 && rows > 0, 'motion run ' + run + ': the page rendered through the steps (' + fr.n + ' frames, ' + rows + ' cards)');
        g.close();
      } finally { await q.quit(); }
    }
  } finally { await mock.close(); }
  const maxAll = per.length ? Math.max(...per.map((p) => p.max)) : NaN;
  console.log('motion: ' + per.length + ' runs, steady over 20 ms: ' + per.map((p) => p.steady).join(',') + '; max ' + (Number.isFinite(maxAll) ? maxAll.toFixed(1) : '?') + ' ms');
  check(per.length === N, 'motion: all ' + N + ' runs measured', per.length);
}

/** --boot2 N: is the sandbox-bundle error on an early webview at boot 2 Watch's, or any bundled page's? */
async function runBoot2(ctx, N) {
  const { launch, say, check, profileDir, setLive } = ctx;
  const mock = await Mock.start({ log: () => {} });
  const env = mockEnv(mock);
  const CACHE = path.join(profileDir, 'watch-cache.json');
  const rows = [];
  try {
    // The seed: one boot reads every service from the mock, writes the cache, quits.
    let q = await launch({ cdp: CDP_PORT, args: NO_YT_NET, env });
    setLive(q);
    try {
      await ctrlAltW(q.chrome);
      const g0 = await openGuest(q, [], 15000);
      await g0.ev(WRAP).catch(() => 0); await g0.ev(HELLO).catch(() => 0);
      await waitReads(g0, IDS, 0, 120000).catch((e) => say('boot2 seed: reads did not settle: ' + e.message.slice(0, 120)));
      let cached = false;
      for (let i = 0; i < 40 && !cached; i++) { await sleep(250); cached = fs.existsSync(CACHE); }
      check(cached, 'boot2 seed: boot 1 wrote <profile>/watch-cache.json', CACHE);
      g0.close();
    } finally { await q.quit(); }
    for (const id of IDS) await mock.setMode(id, 'slow');   // as in the normal run's boot 2: no read can finish

    for (let run = 1; run <= N; run++) {
      const watchFirst = run % 2 === 1;
      const grace = run <= Math.ceil(N / 2) ? 0 : 10000;   // first half: no boot grace; second half: the real 10 s
      const t0 = Date.now();
      q = await launch({ cdp: CDP_PORT, args: NO_YT_NET, env: mockEnv(mock, grace) });
      setLive(q);
      const r = { run, grace, first: watchFirst ? 'watch' : 'control', up: Date.now() - t0, watchMs: null, controlMs: null, control: '', pages: {}, errAt: null, mockBefore: null, readersBefore: null };
      const samples = [];
      let polling = true;
      const poller = (async () => { while (polling) { try { const l = await q.targets(); samples.push({ t: Date.now(), n: l.filter((t) => t.type === 'page' && isMockUrl(mock, t.url)).length }); } catch (e) { /* between targets */ } await sleep(100); } })();
      try {
        const openWatch = async () => { await ctrlAltW(q.chrome); r.watchMs = Date.now() - t0; };
        const openControl = async () => { r.control = await q.chrome.ev('typeof openFilesTab === "function" ? (openFilesTab(), "files.html") : (createTab(), "newtab.html")').catch(() => '?'); r.controlMs = Date.now() - t0; };
        if (watchFirst) { await openWatch(); await openControl(); } else { await openControl(); await openWatch(); }
        await sleep(3000);
        // Every file:// page: Runtime.enable replays what it logged before this attached.
        for (const t of await q.targets().catch(() => [])) {
          if ((t.type !== 'page' && t.type !== 'webview') || !/^file:/.test(String(t.url)) || !t.webSocketDebuggerUrl) continue;
          const page = String(t.url).split('/').pop().split(/[?#]/)[0];
          const hits = [];
          try {
            const c = await new Cdp(t.webSocketDebuggerUrl).open();
            c.ws.on('message', (raw) => {
              let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
              let text = '', ts = 0;
              if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') { text = (m.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || '')).join(' '); ts = m.params.timestamp; }
              else if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails || {}; text = (d.exception && d.exception.description) || d.text || ''; ts = m.params.timestamp; }
              if (text && SANDBOX.test(text)) hits.push(ts);
            });
            await c.send('Runtime.enable');
            await sleep(400);
            c.close();
          } catch (e) { hits.push(NaN); say('boot2 run ' + run + ': could not attach to ' + page + ': ' + e.message.slice(0, 80)); }
          const p = r.pages[page] || (r.pages[page] = { n: 0, err: 0 });
          p.n++;
          if (hits.length) { p.err++; const t1 = hits.filter(Number.isFinite).sort((a, b) => a - b)[0]; if (t1 && (!r.errAt || t1 < r.errAt)) r.errAt = t1; }
        }
      } finally { polling = false; await poller; await q.quit(); }
      if (r.errAt) {
        r.mockBefore = mock.log.filter((l) => l.t >= t0 && l.t <= r.errAt).length;
        r.readersBefore = samples.filter((s) => s.t <= r.errAt).reduce((mx, s) => Math.max(mx, s.n), 0);
      }
      rows.push(r);
      const ctlPage = r.control || '?';
      say('boot2 run ' + run + ' [' + loadNote() + ', boot grace ' + grace + ' ms]: first ' + r.first + '; up ' + r.up + ' ms, watch opened +' + r.watchMs + ' ms, control (' + ctlPage + ') +' + r.controlMs + ' ms; pages '
        + Object.keys(r.pages).map((k) => k + (r.pages[k].err ? ' ERROR' : ' ok')).join(', ') + (r.errAt ? '; first error +' + (r.errAt - t0) + ' ms after launch, mock requests before it ' + r.mockBefore + ', hidden reader pages before it ' + r.readersBefore : '; no sandbox-bundle error'));
    }
  } finally {
    for (const id of IDS) await mock.setMode(id, 'ok').catch(() => 0);
    await mock.close();
  }
  console.log('boot2 table: run | grace ms | first   | watch +ms | control +ms | watch.html | control | mock req before err | reader pages before err');
  for (const r of rows) {
    const w = r.pages['watch.html'], c = r.pages[r.control];
    console.log('boot2 table: ' + String(r.run).padEnd(3) + ' | ' + String(r.grace).padStart(8) + ' | ' + r.first.padEnd(7) + ' | ' + String(r.watchMs).padStart(9) + ' | ' + String(r.controlMs).padStart(11) + ' | '
      + (w ? (w.err ? 'ERROR' : 'ok') : 'absent').padEnd(10) + ' | ' + (c ? (c.err ? 'ERROR' : 'ok') : 'absent').padEnd(7) + ' | ' + String(r.mockBefore === null ? '-' : r.mockBefore).padStart(19) + ' | ' + (r.readersBefore === null ? '-' : r.readersBefore));
  }
  const X = rows.filter((r) => r.pages['watch.html'] && r.pages['watch.html'].err).length;
  const Y = rows.filter((r) => r.pages[r.control] && r.pages[r.control].err).length;
  const Z = rows.filter((r) => r.errAt && (r.mockBefore > 0 || r.readersBefore > 0)).length;
  console.log('boot2: watch ' + X + '/' + N + ', control ' + Y + '/' + N + ', reads-before-error ' + Z);
  check(rows.length === N && rows.every((r) => r.pages['watch.html'] && r.pages[r.control]), 'boot2: all ' + N + ' runs opened Watch and the control page and attached to both', rows.map((r) => Object.keys(r.pages).join('+')));
}

/* ---- the run --------------------------------------------------------------------------------- */
if (require.main === module) {
  run('watch-e2e', async (k) => {
    const { launch, say, profileDir } = k;
    let P = 0, F = 0, liveQ = null;
    const check = (c, label, detail) => { if (c) P++; else F++; k.check(c, label, detail); };
    // A watchdog: a hang anywhere (a CDP call that never answers) must not hold the suite for its whole
    // timeout. At 13 min it kills ONLY the instance this run started, tidies, and prints the summary.
    const dog = setTimeout(() => {
      console.log("FAIL HARNESS TIMEOUT: watch-e2e did not finish in 13 min");
      try { if (liveQ) require("child_process").execFileSync("taskkill", ["/PID", String(liveQ.child.pid), "/T", "/F"], { stdio: "ignore" }); } catch (e) { /* gone */ }
      setTimeout(() => { try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* busy */ } console.log("watch-e2e: " + P + " passed, " + (F + 1) + " failed"); process.exit(1); }, 1500);
    }, (13 + 2 * BOOT2_N + 3 * MOTION_N) * 60 * 1000);
    dog.unref();
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(CAPTIONS, '');
    for (const f of [OPEN_STUB, EDGE_STUB, GAME_FILE]) { try { fs.rmSync(f, { force: true }); } catch (e) { /* none */ } }
    const cleanup = () => { for (const f of [OPEN_STUB, EDGE_STUB, GAME_FILE]) { try { fs.rmSync(f, { force: true }); } catch (e) { /* none */ } } for (const n of ['visible', 'cpu']) { try { fs.rmSync(path.join(os.tmpdir(), TAG + '-' + n + '.ps1'), { force: true }); } catch (e) { /* none */ } } };
    process.on('exit', cleanup);

    if (BOOT2_N || MOTION_N) {
      const ctx = { launch, say, check, profileDir, setLive: (x) => { liveQ = x; } };
      if (BOOT2_N) await runBoot2(ctx, BOOT2_N); else await runMotion(ctx, MOTION_N);
      return;
    }

    await liveEspn(check, say);

    const mock = await Mock.start({ log: say });
    const env = mockEnv(mock);
    const mockHost = (u) => IDS.some((id) => String(u).indexOf(mock.origin(id) + '/') === 0 || String(u) === mock.origin(id));
    const expect = expectedItems();
    const CACHE = path.join(profileDir, 'watch-cache.json');
    const LOG = path.join(profileDir, 'quartz.log');
    const errors = [];
    let measured = null;

    /* ================================ boot 1 ================================ */
    const boot1 = Date.now();
    const appStart = boot1;
    let q = await launch({ cdp: CDP_PORT, args: NO_YT_NET, env: Object.assign({}, env, { QUARTZ_WATCH_BOOT_GRACE_MS: String(BOOT1_GRACE_MS) }) });
    liveQ = q;
    const chrome = q.chrome;
    const pid = q.child.pid;

    // The hidden reader: watch every target and every visible window of the test from now on.
    const vis = visibleWatcher(pid);
    const visBase = await vis.ready();
    const poll = { max: 0, samples: 0, seen: 0, urls: new Set(), on: true };
    const poller = (async () => {
      while (poll.on) {
        try {
          const list = await q.targets();
          const n = list.filter((t) => t.type === 'page' && mockHost(t.url)).length;
          poll.samples++; poll.max = Math.max(poll.max, n); if (n) poll.seen++;
          for (const t of list) if (t.type === 'page' && mockHost(t.url)) poll.urls.add(String(t.url).replace(/^http:\/\/127\.0\.0\.1:\d+/, ''));
        } catch (e) { /* between targets */ }
        await sleep(200);
      }
    })();

    // Ctrl+Alt+W, twice: one tab, reused.
    await ctrlAltW(chrome);
    let one = false;
    try { one = await chrome.waitFor(WATCH_TABS + '.length === 1 && ' + ACTIVE_IS_WATCH, 8000); } catch (e) { one = false; }
    check(one, 'Ctrl+Alt+W (real keys into the chrome) opens one Watch tab and shows it');
    const tabInfo = await chrome.ev("(() => { const w = findWatchTab(); return w ? { title: w.title, strip: w.titleEl ? w.titleEl.textContent : null, omni: document.getElementById('omnibox').value, n: tabs.length } : null; })()");
    check(!!tabInfo && tabInfo.strip === 'Lumen' && tabInfo.title === 'Lumen', 'the tab is named "Lumen"', tabInfo);
    check(!!tabInfo && tabInfo.omni === '', 'the omnibox is blank on the Watch tab', tabInfo && JSON.stringify(tabInfo.omni));
    // One synchronous step in the chrome: what the Watch page had been told (app.js syncWatchFront:
    // undefined = its dom-ready had not come yet, so it never heard "front"), then the new tab.
    const frontBefore = await chrome.ev('(() => { const w = findWatchTab(); const was = w ? w.watchFrontSent : undefined; createTab(); return was === undefined ? null : was; })()').catch(() => null);
    await chrome.waitFor('!' + ACTIVE_IS_WATCH, 5000).catch(() => 0);

    // Visibility gating. A fresh profile, so every service is due; this boot has an 8 s boot grace.
    // A display:none <webview> still says document.visibilityState "visible" (logged as information),
    // so the chrome tells the page whether its tab is on screen (window.__watchFront) and the page tells
    // main (window.__watchVisible() is what main last heard). With Watch in a BACKGROUND tab, past the
    // grace: the page says it is out of sight and nothing is read for 5 s; brought to the front, the
    // reads start.
    const gb = await guestTarget(q, 5000).catch(() => null);
    const bgEval = async (expression) => {
      if (!gb) return { err: 'no Watch CDP target' };
      try {
        const c = await new Cdp(gb.webSocketDebuggerUrl).open();
        try { const r = await c.send('Runtime.evaluate', { expression, returnByValue: true }); return r && r.result && r.result.result ? r.result.result.value : null; } finally { c.close(); }
      } catch (e) { return { err: String(e.message).slice(0, 80) }; }
    };
    const SIGHT = "(typeof window.__watchVisible === 'function' ? window.__watchVisible() : null)";
    const saidOf = (s) => (s && Array.isArray(s.said) ? s.said.map((x) => x.verb + ':' + x.visible).join(' ') : JSON.stringify(s));
    const bgVis = await bgEval('document.visibilityState');
    say('visibility: the Watch guest in a background tab says document.visibilityState = ' + JSON.stringify(bgVis));
    if (bgVis !== 'hidden') say('FINDING (information): a background Watch webview reports visibilityState ' + JSON.stringify(bgVis) + ', not "hidden"; the page learns it is behind another tab from the chrome (window.__watchFront), not from its document');
    let sight = await bgEval(SIGHT);
    for (let i = 0; i < 15 && !(sight && sight.front === false); i++) { await sleep(200); sight = await bgEval(SIGHT); }
    if (Date.now() < appStart + BOOT1_GRACE_MS) await sleep(appStart + BOOT1_GRACE_MS - Date.now());
    const tBg = Date.now();
    const sightBg = await bgEval(SIGHT);
    check(!!sightBg && sightBg.visible === false && sightBg.front === false, 'visibility: Watch in a background tab tells Quartz it is out of sight (the chrome said "back", main last heard visible:false)',
      sightBg && { visible: sightBg.visible, front: sightBg.front, hidden: sightBg.hidden, said: saidOf(sightBg) });
    await sleep(5000);
    // Release 4: Lumen Alerts' subscription alerts (on by default) may follow a BACKGROUND-refresh
    // YouTube read with one hidden Subscriptions read; at launch there is none, so this check runs
    // with alerts ON and still means "no read storm in a background tab".
    const alertsSubs = await chrome.ev("(window.api && window.api.lumenAlerts) ? window.api.lumenAlerts.describe().then((d) => (d && d.subs ? d.subs.on : 'none'), () => 'error') : 'no bridge'").catch(() => 'error');
    const bgHits = IDS.reduce((n, id) => n + mock.hits(id, appStart), 0);
    const bgWhat = IDS.map((id) => id + ':' + mock.hits(id, appStart)).join(' ');
    // Watch was the front tab for a moment (Ctrl+Alt+W). If its page heard "front" in that moment it
    // told main visible:true, main queued every due read, and main runs its queue past the boot grace
    // whatever the page says next: those reads are not a failure of the front signal, only noted.
    if (bgHits > 0 && frontBefore === true) say('visibility: NOTE: the page heard "front" before createTab() moved Watch back (it said ' + saidOf(sightBg) + '); main kept the reads it queued then and ran them past the boot grace with the page out of sight (' + bgWhat + '), so "a background tab reads nothing" is not checked this run');
    else check(bgHits === 0, 'visibility: Watch in a background tab (another tab active, every service due, ' + Math.round((tBg - appStart) / 1000) + ' s after launch, past the ' + BOOT1_GRACE_MS / 1000 + ' s boot grace, subscription alerts ' + (alertsSubs === true ? 'on' : String(alertsSubs)) + ') reads nothing for 5 s', bgWhat + '; front before the switch: ' + frontBefore + '; the page said ' + saidOf(sightBg));

    check(alertsSubs === true, 'visibility: that check ran with the Lumen Alerts subscription alerts on (their default), the mode that may read Subscriptions in the background', alertsSubs);
    await ctrlAltW(chrome);
    let reused = false;
    try { reused = await chrome.waitFor(WATCH_TABS + '.length === 1 && ' + ACTIVE_IS_WATCH, 5000); } catch (e) { reused = false; }
    check(reused, 'a second Ctrl+Alt+W (from another tab) goes back to the same Watch tab, no second one', await chrome.ev(WATCH_TABS + '.length'));
    const tFront = Date.now();
    let started = false;
    for (let i = 0; i < 50 && !started; i++) { await sleep(200); started = IDS.some((id) => mock.hits(id, tFront) > 0); }
    const sightFront = await bgEval(SIGHT);
    check(!!sightFront && sightFront.visible === true && sightFront.front === true, 'visibility: brought to the front, the page tells Quartz it is in sight (main last heard visible:true)',
      sightFront && { visible: sightFront.visible, front: sightFront.front, hidden: sightFront.hidden, said: saidOf(sightFront) });
    if (bgHits > 0) say('visibility: the reads had already started in the background (' + bgWhat + '), so "front starts the reads" is not checked');
    else check(started, 'visibility: brought to the front, Watch starts reading (' + IDS.map((id) => id + ':' + mock.hits(id, tFront)).join(' ') + ' within ' + ((Date.now() - tFront) / 1000).toFixed(1) + ' s)');

    // The palette's Watch row.
    await chrome.ev('createTab(), 1');
    await chrome.waitFor('!' + ACTIVE_IS_WATCH, 5000).catch(() => 0);
    await chrome.ev('TabSearch.openCommands(), 1');
    await sleep(250);
    await chrome.type('watch');
    await sleep(400);
    const pal = await chrome.ev("(() => { const l = document.getElementById('ts-list'); if (!l) return null; return [...l.querySelectorAll('[id^=\"ts-row-\"]')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()).slice(0, 6); })()");
    // A row's text starts with its icon glyph (a private-use code point, e.g. U+E714), then the name.
    check(Array.isArray(pal) && pal.some((t) => /^Lumen(?![a-z])/.test(String(t).replace(/^[-\s]+/, ''))), 'the palette (commands, "watch") has a "Lumen" row (Watch is its alias)', pal);
    await press(chrome, 'Enter');
    let palOpen = false;
    try { palOpen = await chrome.waitFor('!TabSearch.isOpen() && ' + WATCH_TABS + '.length === 1 && ' + ACTIVE_IS_WATCH, 5000); } catch (e) { palOpen = false; }
    check(palOpen, 'Enter on the palette row shows the one Watch tab', await chrome.ev(WATCH_TABS + '.length'));

    // The page itself.
    let g = await openGuest(q, errors, 10000);
    await g.ev(WRAP);
    await g.ev(HELLO);
    try {
      await waitReads(g, IDS, boot1, 120000);
    } catch (e) { say('first reads did not settle: ' + e.message.slice(0, 200)); }
    const snap1 = await g.ev('window.__e2eSnap || null');
    for (const id of IDS) {
      const s = snap1 && snap1.services.find((x) => x.id === id);
      check(!!s && s.state === 'ok' && s.readAt >= boot1, 'first read: ' + NAMES[id] + ' read OK from the mock', s && { state: s.state, reason: s.reason, warnings: s.warnings });
    }
    // What each service's mock answered during the first reads (path, ms after boot): when a reader
    // says "0 responses read" this shows whether the page asked and the capture missed it.
    for (const id of IDS) {
      const got = mock.log.filter((l) => l.svc === id && l.t >= boot1);
      say('first read, mock ' + id + ': ' + got.length + ' requests: ' + got.slice(0, 10).map((l) => l.path + '@' + (l.t - boot1)).join(' '));
    }
    await sleep(1500);
    poll.on = false; await poller;
    const after = (await q.targets()).filter((t) => t.type === 'page' && mockHost(t.url));
    check(poll.seen > 0, 'hidden reader: the 200 ms target poll saw the reader pages (' + poll.seen + ' of ' + poll.samples + ' samples)', [...poll.urls].join(' '));
    check(poll.max <= 1, 'hidden reader: at most ONE mock page alive at any sample', 'max ' + poll.max);
    check(after.length === 0, 'hidden reader: ZERO mock pages once the reads are done', after.map((t) => t.url));
    vis.stop();
    check(vis.max <= visBase && visBase >= 1, 'hidden reader: no new visible window while it read (visible windows of the test: ' + visBase + ' before, max ' + vis.max + ')', vis.counts.join(','));

    // Every service's rows, with the titles the adapters make of the same fixtures.
    const items = (snap1 && snap1.items) || [];
    for (const id of ['youtube', 'disney', 'hulu', 'prime']) {
      const want = expect[id].items.map((it) => it.title).sort();
      const got = items.filter((it) => it.service === id).map((it) => it.title).sort();
      check(want.length > 0 && JSON.stringify(want) === JSON.stringify(got), NAMES[id] + ': the ' + want.length + ' fixture titles reached the page, exactly', { missing: want.filter((t) => got.indexOf(t) === -1).slice(0, 4), extra: got.filter((t) => want.indexOf(t) === -1).slice(0, 4) });
    }
    const cards1 = await g.ev(UI.cards);
    const rowsWant = Merge.buildRows({ youtube: { enabled: true, items: items.filter((i) => i.service === 'youtube'), state: 'ok' }, disney: { enabled: true, items: items.filter((i) => i.service === 'disney'), state: 'ok' }, prime: { enabled: true, items: items.filter((i) => i.service === 'prime'), state: 'ok' }, espn: { enabled: true, items: items.filter((i) => i.service === 'espn'), state: 'ok' } });
    for (const id of ['youtube', 'disney', 'hulu', 'prime']) {
      const drawn = cards1.filter((c) => c.service === id && c.drawn).map((c) => c.title);
      const firsts = expect[id].items.slice(0, 3).map((it) => it.title);
      check(firsts.every((t) => drawn.indexOf(t) !== -1), NAMES[id] + ': its first titles are drawn on cards (' + drawn.length + ' cards)', { want: firsts, drawnSample: drawn.slice(0, 4) });
    }
    check(cards1.length > 0 && cards1.every((c) => c.w > 40 && c.h > 20), 'every card has a real size', cards1.filter((c) => !(c.w > 40 && c.h > 20)).slice(0, 3));
    const games = await g.ev(UI.games);
    const ev1 = (snap1 && snap1.sports) || { live: [], soon: [], done: [] };
    check(ev1.live.length > 0 && games.some((t) => /Bruins|Kraken/.test(t)), 'ESPN: the live NHL game from the fixture is on the sports strip (' + ev1.live.length + ' live, ' + games.length + ' game cards)', games.slice(0, 3));
    check(rowsWant.length > 0, 'merge: the fixture items make ' + rowsWant.length + ' rows', rowsWant.map((r) => r.title).slice(0, 6));

    // Card opens: YouTube -> a Quartz tab on the mock; Disney+ / Prime Video -> the Edge stub.
    const tabsBefore = await chrome.ev('tabs.length');
    async function openCardOf(id, wantPage) {
      let why0 = null;   // why no card was clickable, seen on the first try (before any ArrowDown)
      for (let tries = 0; tries < 12; tries++) {
        const ok = await g.ev(`(() => { document.querySelectorAll('[data-e2e-card]').forEach((x) => x.removeAttribute('data-e2e-card'));
          const c = [...document.querySelectorAll('#stack .lrow .rt > .card')].find((c) => { if (!c._item || c._item.service !== ${JSON.stringify(id)}) return false;
            if (${!!wantPage} && !(c._item.kind !== 'resume' && window.LumenShowModel && window.LumenShowModel.requestFor(c._item))) return false;
            const b = c.getBoundingClientRect(); if (b.width < 20 || b.left < 0 || b.right > innerWidth || b.top < 0 || b.bottom > innerHeight) return false;
            const h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!h && c.contains(h); });
          if (!c) return null; c.setAttribute('data-e2e-card', '1');
          // a show or film with a Lumen show page (watch/showpage.js) opens that page; a Continue tile still plays
          const page = c._item.kind !== 'resume' && !!window.LumenShowModel && !!window.LumenShowModel.requestFor(c._item);
          return { url: c._item.url, kind: c._item.kind, page }; })()`);
        if (ok) { await click(g, '[data-e2e-card="1"]'); return ok; }
        if (tries === 0) why0 = await g.ev(CARD_WHY(id)).catch((e) => 'err ' + e.message);
        if (why0 && typeof why0 === 'object') (why0.lens = why0.lens || []).push(await g.ev(`(() => { const rs = [...document.querySelectorAll('#stack .lrow')]; const i = rs.findIndex((r) => r.getAttribute('data-d') === '0'); const r = rs[i];
          if (!r) return 'no d=0 row'; const cs = [...r.querySelectorAll('.rt > .card')]; return i + '@' + Math.round(r.getBoundingClientRect().top) + ':' + cs.length + ':' + [...new Set(cs.map((c) => (c._item && c._item.service) || '?'))].join('/') + ':' + ((r.querySelector('.lr-h') || {}).textContent || '').slice(0, 24); })()`).catch(() => 'err'));
        await g.ev("document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1");
        const lp0 = await g.ev('(document.getElementById("lpos") || {}).textContent || ""').catch(() => '');
        await press(g, 'ArrowDown');
        await sleep(150);
        const lp1 = await g.ev('(document.getElementById("lpos") || {}).textContent || ""').catch(() => '');
        // ArrowDown that does not move the lens is said once; the lens's own Next row button is the way on.
        if (lp0 && lp1 === lp0) { if (why0 && typeof why0 === 'object' && !why0.keyStuck) { why0.keyStuck = lp0; console.log('[e2e] openCardOf ' + id + ': ArrowDown did not move the lens (still ' + lp0 + '); pressing the lens Next row button'); } await click(g, '#ldn'); }
        if (why0 && typeof why0 === 'object' && tries < 3) why0.lens.push(lp0 + ' -> ' + lp1 + ' -> ' + await g.ev('(document.getElementById("lpos") || {}).textContent || ""').catch(() => ''));
        await sleep(650);
      }
      console.log('[e2e] openCardOf ' + id + (wantPage ? ' (page)' : '') + ': no clickable card; on the first try: ' + JSON.stringify(why0));
      return null;
    }
    const ytUrl = ((await openCardOf('youtube')) || {}).url;
    // "Play inside Lumen" is on by default (watch-player-e2e.js covers the layer itself): the title
    // plays in the player layer over this tab, never a new tab.
    let ytLayer = null;
    try { ytLayer = await chrome.waitFor(`(() => { const s = window.WatchPlayer && WatchPlayer._state(); return s && s.open && s.slots[0] && String(s.slots[0].url).indexOf(${JSON.stringify(mock.origin('youtube') + '/watch')}) === 0 ? s.slots[0].url : null; })()`, 6000); } catch (e) { ytLayer = null; }
    check(!!ytUrl && !!ytLayer && ytLayer === ytUrl.replace('https://www.youtube.com', mock.origin('youtube')) && (await chrome.ev('tabs.length')) === tabsBefore, 'a YouTube card (real click) plays the title in the player layer, no new tab (rebased to the mock)', { card: ytUrl, layer: ytLayer });
    check(readText(OPEN_STUB).indexOf(JSON.stringify({ url: ytUrl, edge: false })) !== -1, 'the YouTube open is recorded with edge:false');
    await chrome.ev(`(() => { if (window.WatchPlayer && WatchPlayer.isOpen()) WatchPlayer.close('e2e'); const w = findWatchTab(); if (w) activateTab(w.id); return 1; })()`);
    await chrome.waitFor(ACTIVE_IS_WATCH, 5000).catch(() => 0);
    for (const id of ['disney', 'hulu', 'prime']) {
      const o = await openCardOf(id);
      const u = o && o.url;
      if (o && o.page) {
        // a show or film tile (not Continue) opens Lumen's own show page; nothing leaves Lumen
        const sp = await g.waitFor('(() => { const s = window.LumenShows && LumenShows._state(); return s ? s.req : null; })()', 5000).catch(() => null);
        await sleep(1200);
        check(!!sp && sp.service === id && readText(EDGE_STUB).indexOf(u) === -1 && readText(OPEN_STUB).indexOf(u) === -1, 'a ' + NAMES[id] + ' ' + o.kind + ' card (real click) opens Lumen’s show page, not Edge', { card: u, page: sp });
        await g.ev('(() => { if (window.LumenShows) LumenShows.close(); return 1; })()');
        continue;
      }
      let inEdge = false;
      try { inEdge = await new Promise((r) => { const t0 = Date.now(); const tk = setInterval(() => { if (u && readText(EDGE_STUB).indexOf(u) !== -1) { clearInterval(tk); r(true); } else if (Date.now() - t0 > 6000) { clearInterval(tk); r(false); } }, 150); }); } catch (e) { inEdge = false; }
      check(!!u && inEdge && readText(OPEN_STUB).indexOf(JSON.stringify({ url: u, edge: true })) !== -1, 'a ' + NAMES[id] + ' ' + ((o && o.kind) || '') + ' card (real click) goes to Edge (the Edge stub has its URL; the open stub says edge:true)', u);
    }
    // and a show or film card that is not Continue (whichever service has one first) opens Lumen's show page
    let pageCard = null;
    for (const id of ['hulu', 'disney', 'prime']) {
      await chrome.ev('(() => { if (window.WatchPlayer && WatchPlayer.isOpen()) WatchPlayer.close("e2e"); const w = findWatchTab(); if (w) activateTab(w.id); return 1; })()');
      pageCard = await openCardOf(id, true);
      if (pageCard) { pageCard.service = id; break; }
    }
    const sp2 = pageCard ? await g.waitFor('(() => { const s = window.LumenShows && LumenShows._state(); return s ? s.req : null; })()', 5000).catch(() => null) : null;
    if (pageCard) await sleep(1200);
    check(!!pageCard && !!sp2 && sp2.service === pageCard.service && readText(EDGE_STUB).indexOf(pageCard.url) === -1, 'a show or film card that is not Continue (real click) opens Lumen’s show page, not Edge', { card: pageCard, page: sp2 });
    await g.ev('(() => { if (window.LumenShows) LumenShows.close(); return 1; })()').catch(() => 0);
    check((await chrome.ev('tabs.length')) === tabsBefore, 'the Edge opens added no Quartz tab', await chrome.ev('tabs.length'));

    // Search: a 1-character query is never sent (2 is the floor).
    const SET_Q = (v) => g.ev('(() => { const q = document.getElementById("q"); q.focus(); q.value = ' + JSON.stringify(v) + '; q.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()');
    const tq1 = Date.now();
    await click(g, '#q');
    await g.send('Input.insertText', { text: 'b' });
    await sleep(1000);
    check(mock.hits('youtube', tq1, /^\/results$/) === 0, 'search: a 1-character query is not sent (' + mock.hits('youtube', tq1, /^\/results$/) + ' search requests in 1 s)');
    await SET_Q('');
    await sleep(400);

    // Search: local matches + YouTube from the mock + a link per service + the TMDB slot.
    const ytSearch = Shape.cleanItems(ADAPTERS.youtube.parseSearch(readText(path.join(FIX, 'youtube-search.html'))), 20);
    const localWant = Merge.searchLocal ? Merge.searchLocal(items, 'bluey') : [];
    await click(g, '#q');
    await g.send('Input.insertText', { text: 'bluey' });
    let sres = null;
    try {
      sres = await g.waitFor(`(() => { const r = document.getElementById('results'); if (!r || r.hidden || !r.offsetHeight) return null; const t = r.textContent || '';
        if (t.indexOf(${JSON.stringify(ytSearch[0] ? ytSearch[0].title : '\u0000')}) === -1) return null;
        return { text: t.replace(/\\s+/g, ' ').slice(0, 4000), foot: [...r.querySelectorAll('tfoot button, tfoot a')].map((b) => b.textContent.trim()) }; })()`, 15000);
    } catch (e) { sres = null; }
    check(!!sres && /Bluey/.test(sres.text) && localWant.length > 0, 'search "bluey": the local match from the cached rows (Disney+ Bluey) is in the grid', sres ? sres.text.slice(0, 160) : 'no results');
    check(!!sres && ytSearch.slice(0, 3).every((it) => sres.text.indexOf(it.title) !== -1), 'search: YouTube results from the mock (/results) are in the grid', ytSearch.slice(0, 3).map((i) => i.title));
    check(!!sres && sres.foot.length >= 4, 'search: a "search there" link per service in the last line', sres && sres.foot);
    check(!!sres && sres.text.indexOf('Add a free TMDB key in Settings to search every service') !== -1, 'search: the TMDB slot says "Add a free TMDB key in Settings to search every service"');
    check(mock.hits('youtube', boot1, /^\/results$/) >= 1, 'search: YouTube was asked on the mock', mock.hits('youtube', boot1, /^\/results$/) + ' requests');
    if (sres) await shot(g, 'search-1280', 1280, 800, 'search "bluey" (dark): local Disney+ match, YouTube results from the mock, per-service links, TMDB slot', say);
    await g.ev("(() => { const q = document.getElementById('q'); q.focus(); return 1; })()");
    await press(g, 'Escape');
    await g.waitFor("!document.getElementById('q').value", 3000).catch(() => 0);

    // Search carries none of his cookies: the mock set one on the reader's YouTube pages.
    const sreqs = mock.log.filter((l) => l.svc === 'youtube' && l.path === '/results' && l.t >= boot1);
    const readerSent = mock.log.some((l) => l.svc === 'youtube' && l.path !== '/results' && l.t >= boot1 && /e2e_his_session/.test(l.cookie || ''));
    check(sreqs.length > 0 && sreqs.every((l) => !/e2e_his_session/.test(l.cookie || '')), 'search: the YouTube search request carries none of his cookies (the reader '
      + (readerSent ? 'did send the mock\'s cookie back, so there was one to leak)' : 'never sent the mock\'s cookie back; the leak check is weaker)'), sreqs.map((l) => l.cookie || '(no Cookie header)').slice(0, 3));

    // A query still in flight when the next is typed: only the second's answer is drawn.
    mock.setSearch({ tag: true, delay: { bandit: 3000 } });
    const tq2 = Date.now();
    await SET_Q('bandit');
    await sleep(800);                       // past the 300 ms debounce: 'bandit' is asked and held 3 s
    await SET_Q('bingo');
    let race = null;
    try { race = await g.waitFor('(() => { const r = document.getElementById("results"); const t = (r && !r.hidden && r.textContent) || ""; return t.indexOf("[bingo]") !== -1 ? 1 : null; })()', 6000); } catch (e) { race = null; }
    await sleep(3200);                      // 'bandit' answers now, late
    const raceText = await g.ev('(() => { const r = document.getElementById("results"); return (r && r.textContent) || ""; })()').catch(() => '');
    const asked = mock.log.filter((l) => l.svc === 'youtube' && l.path === '/results' && l.t >= tq2).map((l) => decodeURIComponent((l.url.split('search_query=')[1] || '').split('&')[0]));
    check(!!race && raceText.indexOf('[bingo]') !== -1 && raceText.indexOf('[bandit]') === -1 && asked.indexOf('bandit') !== -1 && asked.indexOf('bingo') !== -1,
      'search: with "bandit" still in flight, "bingo" is drawn and the late "bandit" answer is not', { asked, bingo: raceText.indexOf('[bingo]') !== -1, bandit: raceText.indexOf('[bandit]') !== -1 });
    mock.setSearch({ tag: false, delay: {} });
    await g.ev("(() => { const q = document.getElementById('q'); q.focus(); return 1; })()");
    await press(g, 'Escape');
    await g.waitFor("!document.getElementById('q').value", 3000).catch(() => 0);

    // quartz-watch:settings: the page's Settings button opens Settings at Watch.
    await click(g, '#settings');
    let atWatch = null;
    try { atWatch = await chrome.waitFor("(() => { if (!Settings.isOpen()) return null; const c = document.querySelector('[aria-current=\"page\"]'); return c ? c.textContent.trim() : null; })()", 6000); } catch (e) { atWatch = null; }
    check(!!atWatch && /Lumen/.test(atWatch), 'the page\'s Settings button (quartz-watch:settings) opens Settings at the Lumen section', atWatch);
    await chrome.ev('Settings.close(), 1');
    await chrome.waitFor('!Settings.isOpen()', 4000).catch(() => 0);

    // Light and dark: the page follows the chrome, colours differ, text stays readable.
    // watch.css paints the page background on <html> (body is transparent), so the backdrop is
    // body's colour if it has one, else html's.
    const colours = async () => g.ev(`(() => { const b = getComputedStyle(document.body); const h = document.querySelector('#stack .lrow h2'); const c = document.querySelector('#stack .card');
      const clear = (v) => !v || v === 'transparent' || /^rgba\\([^)]*,\\s*0\\)$/.test(v);
      const bg = clear(b.backgroundColor) ? getComputedStyle(document.documentElement).backgroundColor : b.backgroundColor;
      return { theme: document.documentElement.getAttribute('data-theme'), bg, fg: b.color, head: h ? getComputedStyle(h).color : '', card: c ? getComputedStyle(c).color : '' }; })()`);
    await chrome.ev("setTheme('dark'), 1");
    await g.waitFor("document.documentElement.getAttribute('data-theme') === 'dark'", 4000).catch(() => 0);
    await sleep(400);
    const dark = await colours();
    await shot(g, 'dark-1280', 1280, 800, 'Watch, dark, 1280x800, every service read from the mock fixtures', say);
    await shot(g, 'dark-1920', 1920, 1080, 'Watch, dark, 1920x1080, every service read from the mock fixtures', say, chrome);
    await chrome.ev("setTheme('light'), 1");
    await g.waitFor("document.documentElement.getAttribute('data-theme') === 'light'", 4000).catch(() => 0);
    await sleep(400);
    const light = await colours();
    await shot(g, 'light-1280', 1280, 800, 'Watch, light, 1280x800, every service read from the mock fixtures', say);
    await shot(g, 'light-1920', 1920, 1080, 'Watch, light, 1920x1080, every service read from the mock fixtures', say, chrome);
    check(dark.theme === 'dark' && light.theme === 'light' && dark.bg !== light.bg && dark.fg !== light.fg, 'light and dark: the page follows setTheme and its colours differ', { dark, light });
    const cd = contrast(dark.fg, dark.bg), cl = contrast(light.fg, light.bg);
    const hd = contrast(dark.head || dark.fg, dark.bg), hl = contrast(light.head || light.fg, light.bg);
    check(cd >= 4.5 && cl >= 4.5 && hd >= 4.5 && hl >= 4.5, 'text contrast: body ' + cd.toFixed(1) + ' / ' + cl.toFixed(1) + ', row heads ' + hd.toFixed(1) + ' / ' + hl.toFixed(1) + ' (dark / light, >= 4.5)');
    await chrome.ev("setTheme('dark'), 1");

    // The keyboard: Tab reaches the strip and the rows; arrows move within and between rows; Enter opens.
    await g.ev("document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1");
    let inStrip = false, inRows = false;
    for (let i = 0; i < 30 && !inRows; i++) {
      await press(g, 'Tab');
      const where = await g.ev("(() => { const a = document.activeElement; if (!a) return ''; if (a.closest('#strip')) return 'strip'; if (a.closest('#stack .lrow') && a.matches('.card, .gc')) return 'row'; return a.id || a.className || a.tagName; })()");
      if (where === 'strip') inStrip = true;
      if (where === 'row') inRows = true;
    }
    check(inStrip, 'keyboard: Tab reaches the services strip');
    check(inRows, 'keyboard: Tab reaches a card in the rows');
    const focusInfo = "(() => { const a = document.activeElement; const r = a && a.closest && a.closest('.lrow'); return { key: a && a.dataset ? a.dataset.key || '' : '', row: r ? r.dataset.key : '', card: !!a && a.matches && a.matches('.card, .gc') }; })()";
    const f0 = await g.ev(focusInfo);
    await press(g, 'ArrowRight'); await sleep(250);
    const f1 = await g.ev(focusInfo);
    check(f1.card && f1.row === f0.row && f1.key !== f0.key, 'keyboard: ArrowRight moves focus to the next card in the same row', { f0, f1 });
    await press(g, 'ArrowDown'); await sleep(700);
    const f2 = await g.ev(focusInfo);
    check(f2.card && f2.row !== f1.row, 'keyboard: ArrowDown moves focus into the next row', { f1, f2 });
    await press(g, 'ArrowUp'); await sleep(700);
    const openLines0 = readText(OPEN_STUB).split('\n').filter(Boolean).length;
    const tabs0 = await chrome.ev('tabs.length');
    await press(g, 'Enter');
    let opened = false;
    // A card opens one of three ways: an open line (a title), or a page inside Lumen: a game's or team's
    // (watch/sportspage.js) or a show's (watch/showpage.js). A page opened here is closed again, so the
    // checks below run on the rows.
    let how = '';
    for (let i = 0; i < 30 && !opened; i++) {
      await sleep(150);
      if (readText(OPEN_STUB).split('\n').filter(Boolean).length > openLines0) how = 'open line';
      else how = await g.ev('(() => (window.LumenSports && LumenSports.isOpen && LumenSports.isOpen()) ? "sports page" : (window.LumenShows && LumenShows.isOpen()) ? "show page" : "")()').catch(() => '');
      opened = !!how;
    }
    check(opened, 'keyboard: Enter on a focused card opens it (' + (how || 'nothing') + ')', how === 'open line' ? readText(OPEN_STUB).split('\n').filter(Boolean).slice(-1)[0] : how);
    await g.ev('(() => { if (window.LumenSports && LumenSports.isOpen && LumenSports.isOpen()) LumenSports.close(); if (window.LumenShows && LumenShows.isOpen()) LumenShows.close(); return 1; })()').catch(() => 0);
    if ((await chrome.ev('tabs.length')) > tabs0) await chrome.ev(`(() => { const t = tabs.find((t) => String(t.url).indexOf(${JSON.stringify(mock.origin('youtube'))}) === 0); if (t) closeTab(t.id); const w = findWatchTab(); if (w) activateTab(w.id); return 1; })()`);
    await chrome.waitFor(ACTIVE_IS_WATCH, 5000).catch(() => 0);

    // Full motion is pinned for the frame count and the "normal" row-step check, not inherited: with
    // Windows' "Show animations" off (as on the hosted CI runner) the page would read reduce, run the
    // fades-only path, and the normal check below could never see a transform. Reduce is set on
    // purpose further down, and this is put back after it, never the system's value.
    const FULL_MOTION = { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] };
    await g.send('Emulation.setEmulatedMedia', FULL_MOTION);
    // Motion: frames over 20 ms while the lens steps rows (the focus band) and the wash cross-fades.
    const mm = await measureMotion(g, { say, trace: TRACE });   // --trace F: trace the long session's stepping too
    const fr = mm.fr;
    const l0 = 0, l1 = mm.layouts;
    say('motion [' + (fs.existsSync(path.join(os.tmpdir(), 'claude-heavytest.mutex2')) ? 'UNDER LOAD (mutex2 held)' : 'clean (mutex2 absent)') + ']: ' + fr.n + ' frames, ' + fr.over + ' over 20 ms (max ' + fr.max.toFixed(1) + ' ms), ' + fr.wash + ' wash cross-fades, ' + (l1 - l0) + ' layouts over 10 steps');
    check(fr.n > 200, 'motion: the page rendered through the steps (' + fr.n + ' frames in ~8 s)', fr);
    // WHEN each long frame fell: its step, ms after that key, and how far from the FIRST wash
    // cross-fade (the one-time decode and pre-blur of the first image). The lead's bar (watch-lead,
    // 10-17): a long frame at the first wash paint, once, is not a blocker; one during steady
    // stepping is. "At the first wash paint" = within 300 ms of the first cross-fade.
    const firstWash = (fr.washT || [])[0];
    const atFirstWash = (l) => firstWash !== undefined && Math.abs(l.at - firstWash) <= 300;
    const steadyLong = (fr.long || []).filter((l) => !atFirstWash(l));
    const firstLong = (fr.long || []).filter(atFirstWash);
    say('motion timeline: long frames ' + JSON.stringify(fr.long || []) + '; wash cross-fades at ms ' + JSON.stringify(fr.washT || []) + ' (step key every ~770 ms from 0)');
    check(steadyLong.length === 0, 'motion: 0 frames over 20 ms during steady stepping (' + steadyLong.length + (steadyLong.length ? ': ' + steadyLong.map((l) => l.dt + ' ms at step ' + l.step + ' +' + l.sinceStep + ' ms').join(', ') : '') + '); at the first wash paint (one-time decode): ' + firstLong.length + (firstLong.length ? ' (' + firstLong.map((l) => l.dt + ' ms').join(', ') + ')' : '') + '; all: ' + fr.over + ' over, max ' + fr.max.toFixed(1) + ' ms', fr.long);
    check(fr.wash > 0, 'motion: the wash cross-faded during the run (' + fr.wash + ' times; it needs a thumbnail to load from a real CDN)', fr.wash);
    measured = { frames: fr, layouts: l1 - l0 };

    // Reduced motion: opacity only.
    const animProps = `(() => { const out = new Set(); for (const a of document.getAnimations()) { if (a.transitionProperty) out.add(a.transitionProperty);
      else if (a.effect && a.effect.getKeyframes) for (const kf of a.effect.getKeyframes()) for (const p of Object.keys(kf)) if (['offset', 'easing', 'composite', 'computedOffset'].indexOf(p) === -1) out.add(p); }
      return [...out]; })()`;
    await g.ev("(() => { const c = document.querySelector('#stack .lrow[data-d=\"0\"] .rt [tabindex=\"0\"]'); if (c) c.focus({ preventScroll: true }); return 1; })()");
    await press(g, 'ArrowDown'); await sleep(60);
    const normalProps = await g.ev(animProps);
    await sleep(800);
    await g.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(200);
    const rmSeen = new Set();
    for (const kname of ['ArrowDown', 'ArrowRight', 'ArrowUp']) {
      await press(g, kname); await sleep(40);
      for (const p of await g.ev(animProps)) rmSeen.add(p);
      await sleep(400);
    }
    const rmStatic = await g.ev(`(() => { const bad = []; for (const e of document.querySelectorAll('body *')) { const s = getComputedStyle(e);
      const props = s.transitionProperty.split(',').map((x) => x.trim()); const durs = s.transitionDuration.split(',').map((x) => parseFloat(x) || 0);
      props.forEach((p, i) => { const d = durs[i % durs.length]; if (d > 0.001 && /^(all|transform|translate|scale|rotate|top|left|right|bottom|inset|width|height|max-height|max-width|min-height|min-width|margin|padding|filter|backdrop-filter|-webkit-backdrop-filter|offset)/.test(p)) bad.push((e.id || e.className || e.tagName).toString().slice(0, 40) + ':' + p); });
      if (s.animationName !== 'none' && (parseFloat(s.animationDuration) || 0) > 0.001) bad.push((e.id || e.className || e.tagName).toString().slice(0, 40) + ':animation ' + s.animationName); }
      return bad.slice(0, 12); })()`);
    check(normalProps.some((p) => /^(all|transform|translate|scale|rotate|top|left|right|bottom|inset|width|height|max-height|max-width|min-height|min-width|margin|padding|filter|backdrop-filter|-webkit-backdrop-filter|offset)/.test(p)), 'motion (normal): a row step moves things (transform), so the reduced-motion check means something', normalProps);
    check(![...rmSeen].some((p) => /^(all|transform|translate|scale|rotate|top|left|right|bottom|inset|width|height|max-height|max-width|min-height|min-width|margin|padding|filter|backdrop-filter|-webkit-backdrop-filter|offset)/.test(p)), 'prefers-reduced-motion: nothing moves during row steps (no transform/position/size/filter animation; fades only)', [...rmSeen]);
    check(rmStatic.length === 0, 'prefers-reduced-motion: no element transitions transform/position/size/filter, and no keyframe animation runs', rmStatic);
    await g.send('Emulation.setEmulatedMedia', FULL_MOTION);

    // Idle CPU, A/B, same instance (only with --measure: 60 s+).
    if (MEASURE) {
      await waitReads(g, [], 0, 60000).catch(() => 0);
      const fps = await g.ev('new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); })');
      await sleep(2000);
      const h0 = mock.log.length;
      const a = await cpuSample(pid, 30);
      const readsA = mock.log.length - h0;
      await chrome.ev('createTab(), 1');
      await chrome.waitFor('!' + ACTIVE_IS_WATCH, 5000).catch(() => 0);
      await sleep(4000);
      const b = await cpuSample(pid, 30);
      const d = a.pct - b.pct;
      say('idle CPU [' + (fs.existsSync(path.join(os.tmpdir(), 'claude-heavytest.mutex2')) ? 'UNDER LOAD (mutex2 held)' : 'clean (mutex2 absent)') + '] (% of one core, whole test tree): Watch ' + a.pct + ' ' + JSON.stringify(a.byKind) + ' vs new tab ' + b.pct + ' ' + JSON.stringify(b.byKind) + '; Watch rendering at ' + fps + ' fps before; ' + readsA + ' mock requests during A');
      check(fps >= 30, 'idle CPU: the test window was rendering (not occluded) when measured: ' + fps + ' rAF/s');
      check(Number.isFinite(d) && d <= 1.0, 'idle CPU: Watch idle 30 s ' + a.pct + '% vs a plain new tab 30 s ' + b.pct + '% of one core (rise ' + d.toFixed(2) + ', limit 1.0)', { a, b, readsA });
      measured.cpu = { watch: a, newtab: b, fps, readsA };
      await chrome.ev('(() => { const w = findWatchTab(); if (w) activateTab(w.id); return 1; })()');
      await chrome.waitFor(ACTIVE_IS_WATCH, 5000).catch(() => 0);
    }

    // Failure modes, each on its own service, with its reason and a Retry; the others keep their rows.
    const pills = async () => { const o = {}; for (const id of IDS) o[id] = await g.ev(UI.pill(id)); return o; };
    async function round(label, modes, expectFn) {
      await waitReads(g, [], 0, 60000).catch(() => 0);
      for (const id of Object.keys(modes)) await mock.setMode(id, modes[id]);
      const t = Date.now();
      const pressedAt = {};
      for (const id of Object.keys(modes)) {
        const ok = await retry(g, id);
        pressedAt[id] = Date.now() - t;
        if (!ok) say(label + ': could not press Retry for ' + id);
        await sleep(150);
      }
      try { await waitReads(g, Object.keys(modes), t, 150000); } catch (e) {
        const sn = await g.ev('window.__e2eSnap').catch(() => null);
        const open = Object.keys(modes).map((id) => { const s = sn && Array.isArray(sn.services) ? sn.services.find((x) => x.id === id) : null;
          return s && s.readAt >= t ? null : id + ' (' + (s ? s.state + ', read ' + (s.readAt ? (s.readAt - t) + ' ms' : 'never') : 'not in the snapshot') + ')'; }).filter(Boolean);
        const busy = sn && Array.isArray(sn.services) ? sn.services.filter((s) => s.queued || s.reading).map((s) => s.id + (s.reading ? ' reading' : ' queued')) : [];
        say(label + ': reads did not settle in 150 s; not read since the round began: ' + (open.join(', ') || 'none') + '; busy: ' + (busy.join(', ') || 'none') + (sn && sn.reading ? ' (reading ' + sn.reading + ')' : ''));
      }
      // A 'down' service has no listener (connection refused), so the mock cannot count the try;
      // there the proof is a read that finished after the Retry, as an error, and nothing answered.
      const snR = await g.ev('window.__e2eSnap');
      for (const id of Object.keys(modes)) {
        if (modes[id] === 'down') {
          const s = snR && Array.isArray(snR.services) ? snR.services.find((x) => x.id === id) : null;
          check(!!s && s.readAt >= t && s.state === 'error' && mock.hits(id, t) === 0, label + ': Retry on ' + NAMES[id] + ' re-read it (down: a read ended ' + (s && s.readAt >= t ? (s.readAt - t) + ' ms after Retry' : 'never') + ', state ' + (s && s.state) + ', ' + mock.hits(id, t) + ' requests answered)', s && { state: s.state, reason: s.reason });
        } else {
          check(mock.hits(id, t) > 0, label + ': Retry on ' + NAMES[id] + ' re-read it (' + mock.hits(id, t) + ' requests to the mock)');
          if (mock.hits(id, t) === 0) {
            const s = snR && Array.isArray(snR.services) ? snR.services.find((x) => x.id === id) : null;
            say(label + ': no read of ' + id + ' (pressed ' + pressedAt[id] + ' ms in, round began ' + new Date(t).toISOString().slice(11, 23) + '): ' + JSON.stringify(s).slice(0, 700));
            let tail = '';
            try { tail = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter((l) => new RegExp(NAMES[id].replace('+', '\\+'), 'i').test(l)).slice(-6).join(' | '); } catch (e) { tail = 'no quartz.log: ' + e.code; }
            say(label + ': quartz.log on ' + NAMES[id] + ': ' + tail.slice(-900));
          }
        }
      }
      const p = await pills();
      const c = await g.ev(UI.cards);
      expectFn(p, c, await g.ev('window.__e2eSnap'));
      return t;
    }
    const cardsOfSvc = (c, id) => c.filter((x) => x.service === id);
    const baseCount = { disney: cardsOfSvc(cards1, 'disney').length, hulu: cardsOfSvc(cards1, 'hulu').length, prime: cardsOfSvc(cards1, 'prime').length, youtube: cardsOfSvc(cards1, 'youtube').length };
    const failLine = (p, id, re) => !!p[id] && re.test(p[id].title + ' ' + p[id].aria);
    // One tile per title across services (watch/merge.js): a title Disney+ shares with YouTube or Hulu
    // is that service's tile while it reads, and Disney+'s once it is signed out, and fewer services
    // leave more room under the row cap. So Disney+ keeping its rows = every Disney+ card of round 0
    // is still a Disney+ card (it may gain some), not an exact count.
    const disneyKept = (c) => { const now = new Set(cardsOfSvc(c, 'disney').map((x) => x.url));
      return cardsOfSvc(c, 'disney').length >= baseCount.disney && cardsOfSvc(cards1, 'disney').every((x) => now.has(x.url)); };
    const disneyWhat = (c) => cardsOfSvc(c, 'disney').length + ' Disney+ cards (round 0: ' + baseCount.disney + ')';

    // A trace of which service reads / waits, from the page's snapshot (said with a retry diag).
    await g.ev(`(() => { if (window.__e2eTraceT) return 1; window.__e2eTrace = []; let last = '';
      window.__e2eTraceT = setInterval(() => { const sn = window.__e2eSnap; if (!sn || !Array.isArray(sn.services)) return;
        const k = sn.services.filter((s) => s.reading).map((s) => 'R:' + s.id).concat(sn.services.filter((s) => s.queued).map((s) => 'Q:' + s.id)).join(',') + ' ' + (sn.services.find((s) => s.id === 'hulu') || {}).state;
        if (k !== last) { last = k; window.__e2eTrace.push(Date.now() % 1e6 + ' ' + k); if (window.__e2eTrace.length > 80) window.__e2eTrace.shift(); } }, 200); return 1; })()`).catch(() => 0);
    const t1 = await round('round 1', { youtube: 'signed-out', hulu: 'signed-out', prime: 'robot' }, (p, c) => {
      check(failLine(p, 'hulu', /Signed out: sign in to hulu\.com in Quartz/i) && p.hulu.act === 'Sign in', 'signed-out (Hulu): its tile says sign in to hulu.com, and offers Sign in', p.hulu);
      check(cardsOfSvc(c, 'hulu').length === 0, 'signed-out (Hulu): its rows are no longer shown as his', cardsOfSvc(c, 'hulu').length);
      check(failLine(p, 'youtube', /Signed out: sign in to YouTube/i) && p.youtube.act === 'Sign in', 'signed-out (YouTube): its tile says so with the reason and offers Sign in', p.youtube);
      check(cardsOfSvc(c, 'youtube').length === 0, 'signed-out (YouTube): its rows are no longer shown as his', cardsOfSvc(c, 'youtube').length);
      check(failLine(p, 'prime', /robot check/i) && p.prime.act === 'Retry' && /Couldn't read/.test(p.prime.small), 'robot check (Prime Video): its tile says "Couldn\'t read", the reason, and Retry', p.prime);
      check(cardsOfSvc(c, 'prime').length === baseCount.prime && cardsOfSvc(c, 'prime').every((x) => x.stale), 'robot check (Prime Video): its cached rows stay, marked stale', cardsOfSvc(c, 'prime').length);
      check(disneyKept(c) && cardsOfSvc(c, 'disney').every((x) => !x.stale) && p.disney && p.disney.cls.indexOf('st-ok') !== -1, 'while YouTube and Prime fail, Disney+ keeps its rows', disneyWhat(c));
    });
    await sleep(Math.max(0, t1 + FORCE_GAP_MS - Date.now()));
    const t2 = await round('round 2', { youtube: 'changed-layout', disney: 'down', hulu: 'changed-layout', prime: 'slow', espn: 'changed-layout' }, (p, c, sn) => {
      check(failLine(p, 'hulu', /Couldn.t read: the page loaded but no Keep Watching data matched \(Hulu changed its layout\?\)/i) && p.hulu.act === 'Retry', 'couldn\'t read (Hulu, changed layout): the reason and Retry', p.hulu);
      check(failLine(p, 'youtube', /layout/i) && p.youtube.act === 'Retry', 'changed layout (YouTube): "Couldn\'t read" with the layout reason and Retry', p.youtube);
      check(failLine(p, 'disney', /offline|didn.t answer|refused|connect/i) && p.disney.act === 'Retry', 'down (Disney+, connection refused): the reason and Retry', p.disney);
      check(failLine(p, 'prime', /timed out after 20 s/i) && p.prime.act === 'Retry', 'slow (Prime Video, never answers): "timed out after 20 s" and Retry', p.prime);
      check(failLine(p, 'espn', /shape|changed/i) && p.espn.act === 'Retry', 'changed layout (ESPN): the reason and Retry', p.espn);
      check(disneyKept(c) && cardsOfSvc(c, 'disney').every((x) => x.stale), 'down (Disney+): its cached rows stay, marked stale', disneyWhat(c));
      const sp = sn && sn.sports ? sn.sports.live.length : 0;
      check(sp > 0, 'changed layout (ESPN): the last good games stay on the strip', sp);
    });
    // The failure states, with Disney+'s popover open on its reason.
    await click(g, '#pills .sp[data-svc="disney"] .sp-main');
    await sleep(500);
    await shot(g, 'failures-1280', 1280, 800, 'failure states: YouTube changed layout, Disney+ down (popover open), Prime timed out, ESPN changed shape; cached rows dimmed', say);
    await press(g, 'Escape');
    await sleep(Math.max(0, t2 + FORCE_GAP_MS - Date.now()));
    await g.ev('(() => { clearInterval(window.__e2eTraceT); return 1; })()').catch(() => 0);
    const t3 = await round('round 3', { disney: 'signed-out', hulu: 'down', espn: 'down', youtube: 'down', prime: 'changed-layout' }, (p, c) => {
      check(failLine(p, 'hulu', /offline|didn.t answer|refused|connect/i) && p.hulu.act === 'Retry', 'down (Hulu): the reason and Retry', p.hulu);
      check(failLine(p, 'disney', /Signed out: sign in to Disney\+/i) && p.disney.act === 'Sign in', 'signed-out (Disney+): the reason and Sign in', p.disney);
      check(failLine(p, 'espn', /offline|didn.t answer|refused|connect/i) && p.espn.act === 'Retry', 'down (ESPN): the reason and Retry', p.espn);
      check(failLine(p, 'youtube', /offline|didn.t answer|refused|connect/i) && p.youtube.act === 'Retry', 'down (YouTube): the reason and Retry', p.youtube);
      check(failLine(p, 'prime', /layout/i) && p.prime.act === 'Retry', 'changed layout (Prime Video): the reason and Retry', p.prime);
    });
    await sleep(Math.max(0, t3 + FORCE_GAP_MS - Date.now()));
    const t4 = await round('round 4 (recovery)', { youtube: 'ok', disney: 'ok', hulu: 'ok', prime: 'ok', espn: 'ok' }, (p, c) => {
      for (const id of IDS) check(!!p[id] && p[id].cls.indexOf('st-ok') !== -1 && !p[id].act, 'recovery: ' + NAMES[id] + ' reads OK again after Retry', p[id]);
      for (const id of ['youtube', 'disney', 'hulu', 'prime']) check(cardsOfSvc(c, id).length === baseCount[id] && cardsOfSvc(c, id).every((x) => !x.stale), 'recovery: ' + NAMES[id] + ' rows are back and current', cardsOfSvc(c, id).length + ' of ' + baseCount[id]);
    });

    // A quartz.log line for every forced failure.
    await sleep(800);
    const log = readText(LOG);
    // WATCH_E2E_KEEP_LOG=<file>: keep this run's quartz.log for a post-mortem (the profile is removed after).
    if (process.env.WATCH_E2E_KEEP_LOG) { try { fs.writeFileSync(process.env.WATCH_E2E_KEEP_LOG, log); } catch (e) { say('could not keep quartz.log: ' + e.message); } }
    const want = [
      ['YouTube', /signed out/], ['YouTube', /layout/i], ['YouTube', /offline|didn.t answer/i],
      ['Disney\\+', /offline|didn.t answer/i], ['Disney\\+', /signed out/],
      ['Prime Video', /robot check/i], ['Prime Video', /timed out/i], ['Prime Video', /layout/i],
      ['ESPN', /shape|changed/i], ['ESPN', /offline|didn.t answer/i],
    ];
    const lines = log.split(/\r?\n/).filter((l) => /Lumen could not read /.test(l));
    for (const [name, re] of want) {
      const hit = lines.find((l) => new RegExp('Lumen could not read ' + name + ': ').test(l) && re.test(l));
      check(!!hit, 'quartz.log has the forced failure: ' + name.replace('\\', '') + ' ' + re, hit ? hit.slice(-160) : lines.slice(-3).join(' | ').slice(0, 300));
    }

    // The game pause: VALORANT "running" (the fake game file) -> nothing reads, and the page says why.
    await sleep(Math.max(0, t4 + FORCE_GAP_MS - Date.now()));
    fs.writeFileSync(GAME_FILE, 'VALORANT (watch-e2e)');
    const tp = Date.now();
    await click(g, '#read-all');
    let pausedText = null;
    try { pausedText = await g.waitFor("(() => { const t = (document.getElementById('fresh').textContent || '') + ' ' + [...document.querySelectorAll('#pills .sp-main')].map((m) => m.title).join(' '); return /paused while VALORANT is running/i.test(t) ? t.replace(/\\s+/g, ' ').slice(0, 200) : null; })()", 6000); } catch (e) { pausedText = null; }
    await sleep(5000);
    check(!!pausedText, 'game pause: the page shows "paused while VALORANT is running"', pausedText);
    check(IDS.every((id) => mock.hits(id, tp) === 0), 'game pause: Read all started nothing (0 requests to any service in 5 s)', IDS.map((id) => id + ':' + mock.hits(id, tp)).join(' '));
    try { fs.rmSync(GAME_FILE, { force: true }); } catch (e) { /* gone */ }

    // No console errors from watch.html, including a fresh load of it.
    // The reload a user does (the webview's own), never a raw CDP one; the tab must survive it.
    await chrome.ev('(() => { const w = findWatchTab(); if (w && w.viewEl && w.viewEl.reload) w.viewEl.reload(); return !!w; })()');
    await sleep(3000);
    const afterReload = await chrome.ev('(() => { const w = findWatchTab(); return { watch: !!w, active: !!w && activeTabId === w.id, tabs: tabs.map((t) => String(t.url).split("/").pop().slice(0, 40)) }; })()');
    check(afterReload.watch && afterReload.active, 'reloading the Watch tab keeps it (one Watch tab, still shown)', afterReload);
    try { await g.waitFor('typeof window.__applyWatch === "function" && document.querySelectorAll("#stack .card").length > 0', 8000); } catch (e) { say('after reload: ' + e.message.slice(0, 120)); }
    await g.ev(WRAP).catch(() => 0);
    check(errors.length === 0, 'no console errors or exceptions from watch.html (boot 1, and a reload)', errors.slice(0, 4).join(' || ') + (errors.netCount ? ' [network-level image errors: ' + errors.netCount + ']' : ''));
    if (errors.netCount) say('network-level errors (thumbnails from real CDNs, not the page): ' + errors.netCount);

    // The cache is on disk before the restart.
    let cached = false;
    for (let i = 0; i < 20 && !cached; i++) { await sleep(250); cached = fs.existsSync(CACHE); }
    check(cached, 'the cache is saved to <profile>/watch-cache.json', CACHE);
    g.close();
    await q.quit();

    /* ================================ boot 2: cache first ================================ */
    for (const id of IDS) await mock.setMode(id, 'slow');   // a read that starts can never finish
    const boot2 = Date.now();
    q = await launch({ cdp: CDP_PORT, args: NO_YT_NET, env });
    liveQ = q;
    const chrome2 = q.chrome;
    const tw = Date.now();
    const had = await chrome2.ev('(() => { const w = findWatchTab(); if (w) { activateTab(w.id); return true; } return false; })()');
    if (!had) await ctrlAltW(chrome2);
    const errors2 = [];
    g = await openGuest(q, errors2, 10000);
    let firstRows = null;
    try { firstRows = await g.waitFor('document.querySelectorAll("#stack .lrow .rt > .card").length || null', 8000); } catch (e) { firstRows = null; }
    const drawMs = Date.now() - tw;
    await g.ev(WRAP); await g.ev(HELLO);
    await g.waitFor('!!window.__e2eSnap', 4000).catch(() => 0);
    const sn2 = await g.ev('window.__e2eSnap');
    const answered = mock.log.filter((l) => l.t >= boot2).length;
    check(!!firstRows && drawMs < 4000, 'second boot: the rows draw from the cache at once (' + firstRows + ' cards, ' + drawMs + ' ms after the tab was shown' + (had ? ', restored tab' : ', Ctrl+Alt+W') + ')');
    check(!!sn2 && sn2.services.every((s) => !(s.readAt >= boot2)), 'second boot: no read had finished (every service is held by the mock; ' + answered + ' requests waiting)', sn2 && sn2.services.map((s) => s.id + ':' + s.readAt));

    // The search cache, before Forget: YouTube answers "bluey" (its mock back to ok for this),
    // and a repeat of it within the same boot is answered from memory.
    const ytFirst = ytSearchTitle();
    await mock.setMode('youtube', 'ok');
    const ts1 = Date.now();
    await SET_Q('bluey');
    await g.waitFor('(() => { const r = document.getElementById("results"); return r && !r.hidden && (r.textContent || "").indexOf(' + JSON.stringify(ytFirst) + ') !== -1 ? 1 : null; })()', 8000).catch(() => 0);
    const sHits1 = mock.hits('youtube', ts1, /^\/results$/);
    await SET_Q(''); await sleep(400);
    const ts2 = Date.now();
    await SET_Q('bluey'); await sleep(1500);
    const sHits2 = mock.hits('youtube', ts2, /^\/results$/);
    await SET_Q(''); await sleep(400);
    say('search cache before Forget: "bluey" asked YouTube ' + sHits1 + ' time(s); the repeat asked ' + sHits2 + ' (0 = from memory)');

    // Forget (Settings > Watch): the page empties and the cache file goes.
    const fState = () => chrome2.ev("(() => { const b = document.querySelector('.set-watch-forget'); return { open: !!(window.Settings && Settings.isOpen()), btn: b ? b.textContent.trim().slice(0, 60) : null, watchTabs: " + WATCH_TABS + ".length }; })()").catch((e) => 'ev failed: ' + e.message.slice(0, 80));
    const wTargets = (await q.targets().catch(() => [])).filter((x) => /\/watch\.html(\?|#|$)/.test(String(x.url))).length;
    say('boot 2 before Forget: ' + JSON.stringify(await fState()) + '; watch.html targets ' + wTargets);
    await click(g, '#settings');
    await chrome2.waitFor("Settings.isOpen() && !!document.querySelector('.set-watch-forget')", 8000).catch(() => 0);
    say('boot 2 after the page\'s Settings button: ' + JSON.stringify(await fState()));
    await click(chrome2, '.set-watch-forget');
    await chrome2.waitFor("/again/i.test((document.querySelector('.set-watch-forget') || {}).textContent || '')", 3000).catch(() => 0);
    say('boot 2 after Forget once: ' + JSON.stringify(await fState()));
    await click(chrome2, '.set-watch-forget');
    await sleep(500);
    say('boot 2 after Forget twice: ' + JSON.stringify(await fState()));
    let emptied = false;
    // His rows are cards that carry an item; a skeleton row (placeholders, no item) is not his data.
    const MINE = '[...document.querySelectorAll("#stack .lrow .rt > .card")].filter((c) => c._item && c._item.title).length';
    try { emptied = await g.waitFor(MINE + ' === 0', 8000); } catch (e) { emptied = false; }
    // What the page was last told and what it still draws: tells "main never pushed" from "the page kept rows".
    const afterForget = await g.ev(`(() => { const s = window.__e2eSnap || {}; const rows = Array.isArray(s.rows) ? s.rows : [];
      return { snaps: window.__e2eSnaps || 0, snapAge: s.now ? Date.now() - s.now : null, snapRows: rows.length, snapItems: rows.reduce((n, r) => n + ((r && r.items) || []).length, 0),
        heads: [...document.querySelectorAll('#stack .lrow h2')].map((h) => h.textContent.trim().slice(0, 30)).slice(0, 6),
        cards: [...document.querySelectorAll('#stack .lrow .rt > .card')].slice(0, 8).map((c) => ((c._item || {}).service || '?') + ':' + ((c._item || {}).title || '').slice(0, 20)) }; })()`).catch((e) => 'ev failed: ' + e.message.slice(0, 80));
    say('boot 2 after Forget, the page: ' + JSON.stringify(afterForget));
    await sleep(500);
    check(emptied, 'Forget: the Watch page empties (no card carries one of his rows)', await g.ev(MINE));
    // After Forget nothing reads until its floor (or a Retry): the page must not say it is reading.
    const claim = await g.ev('(() => { const s = window.__e2eSnap || {}; const busy = (s.services || []).some((x) => x.enabled !== false && (x.reading || x.queued)); const heads = [...document.querySelectorAll("#stack .lrow h2, h1")].map((h) => h.textContent.trim()).join(" | ").slice(0, 160); return { busy, heads, says: /Reading/.test(heads) }; })()').catch(() => null);
    check(!!claim && !(claim.says && !claim.busy), 'Forget: the page does not say "Reading" while nothing reads', claim);
    // Its own state: #stage says so, says when it reads again, offers Read now (not pressed: the mock is slow).
    const stage = await g.ev('(() => { const s = document.getElementById("stage"); if (!s) return null; const h = s.querySelector("h1");'
      + ' const b = [...s.querySelectorAll(".btn.primary")].find((x) => /Read now/.test(x.textContent || ""));'
      + ' const t = (s.textContent || "").replace(/\\s+/g, " ").trim();'
      + ' return { h1: h ? h.textContent.trim() : "", readNow: !!b, choose: /Choose services/.test(t), again: /reads your services again at/.test(t), empty: document.body.classList.contains("is-empty"), rows: document.querySelectorAll("#stack .lrow").length, text: t.slice(0, 200) }; })()').catch(() => null);
    check(!!stage && /Lumen data forgotten/.test(stage.h1) && stage.readNow, 'Forget: the stage says "Lumen data forgotten" and offers "Read now"', stage);
    // Forget takes the search cache too: the same query asks YouTube again.
    await chrome2.ev('Settings.close(), 1').catch(() => 0);
    await sleep(300);
    const ts3 = Date.now();
    await SET_Q('bluey'); await sleep(1500);
    const sHits3 = mock.hits('youtube', ts3, /^\/results$/);
    await SET_Q(''); await sleep(300);
    check(sHits1 >= 1 && sHits3 >= 1, 'Forget: the search cache goes too ("bluey" asks YouTube again: ' + sHits3 + '; before Forget, first ask ' + sHits1 + ', repeat ' + sHits2 + (sHits2 === 0 ? ' (from memory)' : ' (no memory cache seen)') + ')');
    check(!fs.existsSync(CACHE), 'Forget: <profile>/watch-cache.json is deleted');
    // Electron's own sandbox bundle can fail on a second boot ("preloadScripts of
    // binding.startupData is null"). It counts against Watch only if NO other bundled page of the
    // same boot shows it: each other file:// page is asked for its console (Runtime.enable replays
    // what was logged before it attached).
    const SANDBOX_RE = /sandboxed_renderer\.bundle\.js script failed to run|binding\.startupData/;
    const others = [];
    for (const t of (await q.targets().catch(() => []))) {
      if ((t.type !== 'page' && t.type !== 'webview') || !/^file:/.test(String(t.url)) || /\/watch\.html(\?|#|$)/.test(String(t.url)) || !t.webSocketDebuggerUrl) continue;
      const seen = [];
      try {
        const c = await new Cdp(t.webSocketDebuggerUrl).open();
        c.ws.on('message', (raw) => { let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
          if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') seen.push((m.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ').slice(0, 160)); });
        await c.send('Runtime.enable');
        await sleep(400);
        c.close();
      } catch (e) { seen.push('(could not attach: ' + e.message.slice(0, 60) + ')'); }
      others.push({ page: String(t.url).split('/').pop().split('?')[0], sandbox: seen.some((s) => SANDBOX_RE.test(s)), errors: seen.length });
    }
    const elsewhere = others.filter((o) => o.sandbox).map((o) => o.page);
    say('boot 2, other bundled pages: ' + JSON.stringify(others));
    const own2 = errors2.filter((e) => !(SANDBOX_RE.test(e) && elsewhere.length));
    if (own2.length !== errors2.length) say('boot 2: Electron\'s sandbox-bundle error also shows on ' + elsewhere.join(', ') + ', so it is Electron on a restored session, not Watch: ' + (errors2.length - own2.length) + ' line(s) set aside');
    check(own2.length === 0, 'no console errors from watch.html on the second boot' + (own2.length !== errors2.length ? ' (Electron\'s sandbox-bundle error, seen on other pages too, set aside)' : ''), own2.slice(0, 4).join(' || '));
    await chrome2.ev('Settings.close(), 1').catch(() => 0);
    for (const id of IDS) await mock.setMode(id, 'ok');
    g.close();
    await q.quit();
    await mock.close();
    if (measured) say('measured: ' + JSON.stringify(measured));
  });
}
