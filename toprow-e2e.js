require('./tools/lowcpu-optional.js');   // first: one capped browser at a time (2026-09-17)
// toprow-e2e.js — top-row hints end to end, against a REAL test instance of Quartz.
//
//   node toprow-e2e.js [--port 9417] [--keep]
//
// 1. A fake Mantle: a named-pipe server on a private pipe (TOPROW_PIPE), recording every line
//    with its arrival time. Never the real \\.\pipe\look-sync-toprow.
// 2. A temp look-sync dir (snow-peak as Mantle's desktop still, dark, glass 5/.50/0) via
//    LOOK_SYNC_DIR; never the real %APPDATA%\look-sync.
// 3. Quartz: --test-profile --profile-name=toprowe2e<pid> --offscreen --show-inactive --measure-visible:
//    created off every monitor with no taskbar button (main.js), so it is never on the user's screen;
//    testwatch.js's 25 ms watcher (started before launch) fails the run if it ever is. Driven over CDP.
//    Not launched under 2.5 GB free RAM.
// 4. A scripted session: Home -> a web page -> Home -> light -> dark -> page fullscreen ->
//    an own (built-in) picture -> no picture -> back to the desktop. For each step:
//      ORDER/TIMING: the first hint after the action was SENT before the renderer's next
//      requestAnimationFrame callback (the frame that draws the change is produced after it),
//      and the fake Mantle received that same hint; arrival vs that rAF is reported.
//      FADES: the Home fade in/out is followed with per-frame hints.
//      PIXELS: the window's real top row (Page.captureScreenshot of the chrome, decoded in
//      the page) against what the hint predicts: wash = the still, cover-fitted on the
//      monitor, blurred at the shared blurPx, lined up at the window's place, under
//      rgb at alpha; cols / flat as sent. Max and mean error in levels, per channel.
// Kills ONLY the process it started, deletes the temp profile and look dir.
// Prints PASS/FAIL/SKIP lines and one summary line: "toprow-e2e: N passed, M failed[, K skipped]".
// The wash PIXELS checks need the window on a monitor, so they are SKIPPED (with the reason) while
// the window is off-screen; the hints, order, timing and the cols/flat pixel checks still run.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const WS = require(path.join(__dirname, 'node_modules', 'ws'));
const { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb, startWatcher } = require('./testwatch');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(opt('port', '9417'));
const KEEP = argv.includes('--keep');
const APP = __dirname;
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const PIPE = '\\\\.\\pipe\\toprow-e2e-' + process.pid;
const PROFILE = 'toprowe2e' + process.pid;
const PROFILE_DIR = path.join(os.tmpdir(), 'browser-test-profile-' + PROFILE);
const LOOK_DIR = path.join(os.tmpdir(), 'toprow-e2e-look-' + process.pid);
const STILL_SRC = path.join(APP, 'assets', 'backgrounds', 'snow-peak.jpg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.timeOrigin + performance.now();

let pass = 0, fail = 0, skip = 0;
function check(cond, name, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

/* ---- the fake Mantle --------------------------------------------------- */
const got = [];
const socks = new Set();
const server = net.createServer((s) => {
  socks.add(s);
  s.on('close', () => socks.delete(s));
  let rest = '';
  s.on('data', (d) => {
    const at = now();
    rest += d.toString('utf8');
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, i); rest = rest.slice(i + 1);
      try { got.push({ at, m: JSON.parse(line), bytes: Buffer.byteLength(line) + 1 }); } catch (e) { got.push({ at, bad: line }); }
    }
  });
  s.on('error', () => {});
});

/* ---- the look-sync dir --------------------------------------------------- */
function makeLookDir() {
  if (/AppData[\\/]Roaming[\\/]look-sync/i.test(LOOK_DIR)) throw new Error('never the real store');
  fs.rmSync(LOOK_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(LOOK_DIR, 'stills'), { recursive: true });
  const still = path.join(LOOK_DIR, 'stills', 'wall-1.jpg');
  fs.copyFileSync(STILL_SRC, still);
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(LOOK_DIR, 'look.json'), JSON.stringify({
    schema: 1, rev: 3, writer: { app: 'mantle', instance: 'toprow-e2e-' + process.pid, pid: process.pid, at },
    look: {
      theme: { v: 'dark', rev: 1, by: 'mantle' },
      accent: { v: { hue: null }, rev: 1, by: 'mantle' },
      glass: { v: { dark: { blurPx: 5, dim: 0.5, panel: 0 }, light: { blurPx: 12, dim: 0.45, panel: 0 }, render: 'picture' }, rev: 1, by: 'mantle' },
    },
    desktop: { ok: true, reason: null, id: 'builtin:snow-peak', type: 'builtin', title: 'builtin:snow-peak', file: STILL_SRC, still, stillSize: null, rev: 3, by: 'mantle' },
  }, null, 2));
}

/* ---- CDP ------------------------------------------------------------------ */
let ws = null, msgId = 0;
const pending = new Map();
async function connect() {
  const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
  const t = targets.find((x) => x.type === 'page' && /index\.html/.test(String(x.url)));
  if (!t) throw new Error('no chrome target');
  ws = new WS(t.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.on('message', (raw) => { const m = JSON.parse(String(raw)); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } });
}
function cdp(method, params) {
  const id = ++msgId;
  return new Promise((resolve) => { pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params: params || {} })); });
}
async function ev(expr) {
  const m = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (m.error) throw new Error(JSON.stringify(m.error));
  if (m.result.exceptionDetails) throw new Error('page threw: ' + ((m.result.exceptionDetails.exception || {}).description || m.result.exceptionDetails.text));
  return m.result.result.value;
}
async function waitFor(expr, ms) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await ev(expr); if (last) return last; } catch (e) { last = e.message; } await sleep(60); }
  throw new Error('timed out: ' + expr.slice(0, 120) + ' (last ' + JSON.stringify(last) + ')');
}

/* ---- page-side helpers (installed once) ------------------------------------- */
const HELPERS = `(() => {
  window.__tr = {
    // n columns of a row of RGBA pixels w wide
    colsOf: (data, w, n) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        const a = Math.floor(i * w / n), b = Math.max(a + 1, Math.floor((i + 1) * w / n));
        const s = [0, 0, 0]; for (let x = a; x < b; x++) for (let c = 0; c < 3; c++) s[c] += data[x * 4 + c];
        out.push(s.map((v) => v / (b - a)));
      }
      return out;
    },
    // the window's real top row, from a PNG of the chrome (base64), as n columns
    actual: async (b64, n) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      return { w: c.width, cols: __tr.colsOf(x.getImageData(0, 0, c.width, 1).data, c.width, n) };
    },
    // what a wash hint predicts: the still cover-fitted on the monitor, blurred at blurPx, lined up
    predictWash: async (top, n, blurPx) => {
      const pl = LookSync.place(), d = LookSync.desktop();
      const img = new Image(); img.src = d.stillUrl; await img.decode();
      const W = Math.round(pl.display.width), H = Math.round(pl.display.height);
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
      const s = Math.max(W / img.naturalWidth, H / img.naturalHeight), dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      // Blur with 3 sigmas of real picture past the monitor's edges (Mantle's still runs on past them too).
      const m = Math.ceil(blurPx * 3);
      const big = document.createElement('canvas'); big.width = W + 2 * m; big.height = H + 2 * m;
      const bx = big.getContext('2d'); bx.imageSmoothingQuality = 'high';
      const s2 = Math.max(big.width / img.naturalWidth, big.height / img.naturalHeight);
      bx.drawImage(img, (big.width - img.naturalWidth * s2) / 2, (big.height - img.naturalHeight * s2) / 2, img.naturalWidth * s2, img.naturalHeight * s2);
      bx.drawImage(img, m + (W - dw) / 2, m + (H - dh) / 2, dw, dh);
      x.filter = 'blur(' + blurPx + 'px)'; x.drawImage(big, -m, -m); x.filter = 'none';
      const ox = Math.round(pl.content.x - pl.display.x), oy = Math.round(pl.content.y - pl.display.y);
      const w = innerWidth;
      const row = x.getImageData(ox, oy, w, 1).data;
      return { place: { ox, oy, W, H }, cols: __tr.colsOf(row, w, n).map((p) => p.map((v, i) => (1 - top.alpha) * v + top.alpha * top.rgb[i])) };
    }
  };
  return true;
})()`;

async function topRowActual(n) {
  const w = await ev('innerWidth');
  const shot = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { x: 0, y: 0, width: w, height: 1, scale: 1 } });
  if (!shot.result || !shot.result.data) throw new Error('no screenshot: ' + JSON.stringify(shot.error || shot).slice(0, 200));
  return ev('__tr.actual(' + JSON.stringify(shot.result.data) + ', ' + n + ')');
}

function errOf(pred, act) {
  let max = 0, sum = 0, k = 0;
  for (let i = 0; i < pred.length; i++) for (let c = 0; c < 3; c++) { const e = Math.abs(pred[i][c] - act[i][c]); max = Math.max(max, e); sum += e; k++; }
  return { max: Math.round(max * 10) / 10, mean: Math.round(sum / k * 10) / 10 };
}

/** The hint the window states now, checked against its real top row. */
async function pixels(name, limit) {
  await sleep(450);                                   // fades done
  const st = await ev('Toprow.status()');
  const top = st.top;
  const N = 40;
  const act = await topRowActual(N);
  let pred;
  if (top.kind === 'wash') {
    // A wash is the still LINED UP with the monitor at the window's place. The --offscreen test
    // window is off every monitor (the user's screen stays clear), so there is no screen place to
    // compare against: the prediction would sample outside the still. Said, never passed quietly.
    const off = await ev("(() => { const p = LookSync.place(); if (!p) return 'no place'; const c = p.content, d = p.display; return c.x + c.width <= d.x || c.x >= d.x + d.width || c.y + c.height <= d.y || c.y >= d.y + d.height ? 'window at ' + c.x + ',' + c.y + ', monitor ' + d.x + ',' + d.y + ' ' + d.width + 'x' + d.height : ''; })()");
    if (off) { skip++; console.log('SKIP pixels ' + name + ': wash ' + top.alpha + ' is lined up with the monitor, and the off-screen test window is on none (' + off + ')'); return null; }
    const blur = await ev("(() => { const g = Backdrop.state().glass; return g.blurPx; })()");
    pred = (await ev('__tr.predictWash(' + JSON.stringify(top) + ', ' + N + ', ' + blur + ')')).cols;
  } else if (top.kind === 'flat') {
    pred = act.cols.map(() => top.rgb);
  } else if (top.kind === 'cols') {
    const m = top.cols.length;
    pred = Array.from({ length: N }, (_, i) => {            // the hint's columns averaged into N
      const a = Math.floor(i * m / N), b = Math.max(a + 1, Math.floor((i + 1) * m / N));
      const s = [0, 0, 0]; for (let j = a; j < b; j++) for (let c = 0; c < 3; c++) s[c] += top.cols[j][c];
      return s.map((v) => v / (b - a));
    });
  } else {
    check(false, 'pixels ' + name + ': hint is ' + top.kind + ' (' + st.why + ')');
    return null;
  }
  const e = errOf(pred, act.cols);
  const sample = (p) => p.map((v) => Math.round(v)).join(',');
  check(e.max <= limit, 'pixels ' + name + ': ' + top.kind + (top.alpha !== undefined ? ' ' + top.alpha : '') +
    ' vs the real top row: max ' + e.max + ', mean ' + e.mean + ' levels (limit ' + limit + ')',
    'col0 pred ' + sample(pred[0]) + ' real ' + sample(act.cols[0]) + '; mid pred ' + sample(pred[N >> 1]) + ' real ' + sample(act.cols[N >> 1]));
  return e;
}

/** One scripted action: sent before the next frame, received by the fake Mantle. */
async function step(name, src, expectKind, settleMs) {
  const mark = got.length;
  // The action runs inside this expression. A recorder rAF chain is registered FIRST, so in
  // every frame its callback runs before toprow's (rAF callbacks run in registration order):
  // its time is that frame's start. A MutationObserver stamps when the row's inputs changed
  // (a tab switch changes them later than the action, when app.js gets to it).
  const r = await ev('(async () => { Toprow._log(true); window.__trF = []; window.__trM = [];' +
    ' const T = () => performance.timeOrigin + performance.now();' +
    ' if (window.__trMo) __trMo.disconnect(); window.__trMo = new MutationObserver(() => __trM.push(T()));' +
    " __trMo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });" +
    " __trMo.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-bg-home', 'data-bg-kind'] });" +
    " __trMo.observe(document.querySelector('.backdrop'), { attributes: true, subtree: true, attributeFilter: ['data-on', 'data-ready'] });" +
    ' let n = 0; const rec = () => { __trF.push(T()); if (++n < 120) requestAnimationFrame(rec); }; requestAnimationFrame(rec);' +
    ' const t0 = T(); ' + src + '; return { t0 }; })()');
  await sleep(settleMs || 600);
  const page = await ev('({ log: Toprow._log() || [], frames: __trF, muts: __trM })');
  const log = page.log, frames = page.frames, muts = page.muts;
  const first = log[0];
  const final = await ev('Toprow.status()');
  const ours = got.slice(mark).filter((g) => g.m && g.m.top);
  if (!first) {
    check(false, name + ': a hint was sent', 'none logged (the row did not change?)');
    return { final, log };
  }
  // Every hint went out before the frame that draws it: either in the same task as a change
  // (a microtask, within ~2 ms of the mutation stamp and before the next frame starts), or
  // inside a frame's rAF phase (after that frame's recorder stamp, before its paint).
  const tm = muts.length ? muts[0] : r.t0;
  const frameAfter = (t) => frames.find((f) => f > t);
  const frameOf = (t) => { let f = null; for (const x of frames) { if (x <= t) f = x; else break; } return f; };
  const bad = [];
  const into = [];                 // rAF hints: ms after their frame's start (other rAF work + the style read)
  for (const h of log) {
    if (h.raf) { const f = frameOf(h.at); if (f === null) bad.push('rAF hint before any frame'); else into.push(h.at - f); }
    else {
      const m = muts.filter((x) => x <= h.at + 0.05).pop();
      const nf = frameAfter(m === undefined ? r.t0 : m);
      if (m === undefined || (nf !== undefined && h.at >= nf)) bad.push('task hint ' + (m === undefined ? 'with no change' : (h.at - m).toFixed(1) + ' ms after it, next frame ' + (nf === undefined ? '?' : (nf - m).toFixed(1))));
    }
  }
  const nf0 = frameAfter(tm);
  check(!bad.length, name + ': every hint sent before the frame that draws it',
    log.length + ' hints; first ' + (first.raf ? 'in a rAF, ' + (first.at - frameOf(first.at)).toFixed(2) + ' ms into its frame' : 'in the change\'s task, ' + (first.at - tm).toFixed(2) + ' ms after it, ' + (nf0 === undefined ? '?' : (nf0 - first.at).toFixed(2)) + ' ms before the next frame') +
    '; change at +' + (tm - r.t0).toFixed(1) + ' ms' + (into.length ? '; rAF hints up to ' + Math.max(...into).toFixed(1) + ' ms into their frame' : '') + (bad.length ? '; BAD: ' + bad.slice(0, 3).join('; ') : ''));
  const recv = ours.find((g) => JSON.stringify(g.m.top) === JSON.stringify(first.top));
  const lat = log.map((h) => { const g = ours.find((x) => x.m.t === undefined || JSON.stringify(x.m.top) === JSON.stringify(h.top)); return g ? g.at - h.at : null; }).filter((v) => v !== null).sort((a, b) => a - b);
  check(!!recv, name + ': the fake Mantle got it',
    recv ? 'page -> pipe -> fake Mantle: median ' + lat[lat.length >> 1].toFixed(2) + ' ms, max ' + lat[lat.length - 1].toFixed(2) + ' ms over ' + lat.length + ' hints; seq ' + recv.m.seq : 'not among ' + ours.length + ' lines');
  check(final.top && final.top.kind === expectKind, name + ': ends as ' + expectKind, JSON.stringify(final.top).slice(0, 90) + ' (' + final.why + ')');
  return { first, log, ours, final, recv, r };
}


(async () => {
  let child = null;
  let watcher = null;
  try {
    const free = freeRamGb();
    if (!(free >= MIN_FREE_GB)) { console.log('toprow-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }
    watcher = startWatcher((l) => console.log('[e2e] ' + l));
    await watcher.ready;
    await new Promise((r, j) => { server.once('error', j); server.listen(PIPE, r); });
    makeLookDir();
    const env = Object.assign({}, process.env, { LOOK_SYNC_DIR: LOOK_DIR, TOPROW_PIPE: PIPE });
    child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + PORT, '--test-profile', '--profile-name=' + PROFILE, ...OFFSCREEN_ARGS], { cwd: APP, stdio: 'ignore', env });
    watcher.watch(child.pid);
    console.log('[e2e] quartz pid ' + child.pid + ', pipe ' + PIPE);

    // boot: "none" on create, then the renderer's first hint, both for the window's HWND
    const t0 = Date.now();
    while (!got.some((g) => g.m && g.m.top && g.m.top.kind !== 'none') && Date.now() - t0 < 30000) await sleep(100);
    const firstNone = got.find((g) => g.m);
    const firstReal = got.find((g) => g.m && g.m.top.kind !== 'none');
    check(!!firstNone && firstNone.m.v === 1 && firstNone.m.app === 'quartz' && /^\d+$/.test(firstNone.m.hwnd) && firstNone.m.top.kind === 'none',
      'window create: none first, v1 line with a decimal hwnd', firstNone && JSON.stringify(firstNone.m).slice(0, 120));
    check(!!firstReal && firstReal.m.hwnd === firstNone.m.hwnd, 'boot: the renderer\'s first hint arrives for the same hwnd',
      firstReal ? JSON.stringify(firstReal.m.top).slice(0, 80) + ' at ' + (Date.now() - t0) + ' ms' : 'none in 30 s');
    await connect();
    await waitFor('!!(window.Toprow && window.Backdrop && window.LookSync && window.Settings)', 20000);
    await ev(HELPERS);
    await waitFor("Backdrop.state().kind === 'desktop' && Backdrop.state().state === 'ok' && document.querySelector('.bg-photo').hasAttribute('data-ready')", 15000)
      .catch(async (e) => { const st = await ev("JSON.stringify({ desktop: LookSync.desktop(), status: LookSync.status(), backdrop: Backdrop.state() })").catch(() => 'unreadable'); throw new Error(e.message + ' | at failure: ' + String(st).slice(0, 900)); });
    const st0 = await ev('Toprow.status()');
    check(st0.main.state === 'connected', 'Settings status: connected', JSON.stringify(st0.main).slice(0, 160));
    const LINE = "(() => { const e = document.querySelector('[data-toprow-status]'); return e && e.textContent; })()";
    await ev('Settings.open(), 1');
    const line1 = await waitFor(LINE + " && /Mantle connected/.test(" + LINE + ") && " + LINE, 5000).catch((e) => e.message);
    check(/Mantle connected/.test(line1), 'Settings > Look shows the hints line: connected', line1);
    await ev('Settings.close && Settings.close(), 1');

    const NT = "(() => { const t = getActiveTab(); return !!t && t.kind === 'page' && isNewTabUrl(t.url); })()";
    if (!(await ev(NT))) { await ev('createTab(newTabUrl()), 1'); await waitFor(NT, 5000); }
    await waitFor("Backdrop.state().home.on", 6000);
    await sleep(500);
    const ntId = await ev('getActiveTab().id');
    const home1 = await ev('Toprow.status()');
    check(home1.top.kind === 'wash' && Math.abs(home1.top.alpha - 0.75) < 0.011, 'Home (new tab in front): wash .75', JSON.stringify(home1.top));
    await pixels('dark Home', 12);

    // Home -> a web page -> a split -> back: the top band is the SAME the whole time (the user wants
    // the new tab's look on every tab). No hint changes (nothing in the row's stack moved), the Home
    // layer never fades out, and the real top row reads the same pixels in every state.
    const page = 'data:text/html,<title>grey</title><body style="margin:0;background:%23808080"></body>';
    const BAND = "(() => { const s = Backdrop.state(); const q = (x) => getComputedStyle(document.querySelector(x));" +
      " return { on: s.home.on, attr: document.body.hasAttribute('data-bg-home'), clearOn: document.querySelector('.bg-clear').getAttribute('data-on')," +
      " clearOp: q('.bg-clear').opacity, photoVis: q('.bg-photo').visibility, wash: q('.bg-wash').backgroundColor, washOp: q('.bg-wash').opacity," +
      " alpha: s.glass.alpha, tb: q('#titlebar').borderBottomColor, nav: q('.navrow').borderBottomColor }; })()";
    const band0 = await ev(BAND);
    const row0 = await topRowActual(40);
    check(band0.on && band0.attr && band0.photoVis === 'hidden', 'new tab in front: the unblurred picture, blurred layer covered', JSON.stringify(band0));
    async function sameBand(name, src, ready) {
      await ev("(() => { Toprow._log(true); window.__bandOut = 0; if (window.__bandMo) __bandMo.disconnect();" +
        " window.__bandMo = new MutationObserver(() => { if (document.querySelector('.bg-clear').getAttribute('data-on') !== 'in' || !document.body.hasAttribute('data-bg-home')) __bandOut++; });" +
        " __bandMo.observe(document.body, { attributes: true, attributeFilter: ['data-bg-home'] });" +
        " __bandMo.observe(document.querySelector('.bg-clear'), { attributes: true, attributeFilter: ['data-on'] }); return 1; })()");
      await ev(src + ', 1');
      try { await waitFor(ready, 5000); } catch (e) { check(false, name + ': reached', e.message); return; }
      await sleep(700);                                 // any fade would be done by now
      const page2 = await ev('({ log: Toprow._log() || [], out: __bandOut, top: Toprow.status().top })');
      await ev('(__bandMo.disconnect(), Toprow._log(false), 1)');
      const band = await ev(BAND);
      check(JSON.stringify(band) === JSON.stringify(band0), name + ': background stack identical (Home on, same wash and alpha, hairlines)', JSON.stringify(band));
      check(page2.out === 0, name + ': the Home layer never faded out', page2.out + ' flips');
      check(page2.log.every((h) => JSON.stringify(h.top) === JSON.stringify(home1.top)) && JSON.stringify(page2.top) === JSON.stringify(home1.top),
        name + ': top-row hint unchanged', page2.log.length + ' hints; now ' + JSON.stringify(page2.top));
      const row = await topRowActual(40);
      const e = errOf(row0.cols, row.cols);
      check(e.max <= 1, name + ': the real top row reads the same pixels as with the new tab in front: max ' + e.max + ', mean ' + e.mean + ' levels (limit 1)');
    }
    await sameBand('new tab -> web page', 'createTab(' + JSON.stringify(page) + ')',
      "(() => { const t = getActiveTab(); return !!t && /^data:/.test(t.url) && !!t.viewEl && !t.viewEl.classList.contains('own-layer'); })()");
    await sameBand('web page split with the new tab', 'splitWithTab(' + JSON.stringify(ntId) + ')',
      "(() => { const t = getActiveTab(); return !!t && !!splitPartner(t); })()");
    await sameBand('split ends, web page alone', 'unsplit(getActiveTab())',
      "(() => { const t = getActiveTab(); return !!t && !splitPartner(t); })()");
    await sameBand('web page -> new tab', 'activateTab(' + JSON.stringify(ntId) + ')',
      "(() => { const t = getActiveTab(); return !!t && t.id === " + JSON.stringify(ntId) + "; })()");
    // theme: light, then dark
    await step('dark -> light', "QuartzTheme.setMode('light')", 'wash', 700);
    await pixels('light (new tab in front)', 6);
    await step('light -> dark', "QuartzTheme.setMode('dark')", 'wash', 700);

    // a page's own fullscreen: none, then back
    await step('page fullscreen', "document.body.classList.add('page-fullscreen')", 'none', 300);
    await step('page fullscreen ends', "document.body.classList.remove('page-fullscreen')", 'wash', 300);

    // a hovered window button: none (its fill is in row 0)
    // (hover cannot be faked from script; the computed fill is what toprow reads)

    // own picture (a built-in photo, cover-fitted to the window): cols
    await ev(`activateTab(${JSON.stringify(ntId)}), 1`);
    await ev(`(() => { const t = tabs.find((x) => x.kind === 'page' && !isNewTabUrl(x.url)); if (t) activateTab(t.id); return 1; })()`);
    await ev("Settings.set({ newtabBackground: { kind: 'builtin', id: 'city-valley' } }), 1");
    try { await waitFor("Backdrop.state().kind === 'builtin' && Backdrop.state().state !== 'loading' && Toprow.status().top.kind === 'cols'", 15000); }
    catch (e) { throw new Error(e.message + ' | state ' + JSON.stringify(await ev("({ why: Toprow.status().why, tb: getComputedStyle(document.getElementById('titlebar')).backgroundImage.slice(0, 200), ws: document.getElementById('titlebar').getAttribute('data-ws-colour') })")).slice(0, 700)); }
    await pixels('own picture (built-in photo), web page', 6);

    // no picture: flat
    await step('no picture', "Settings.set({ newtabBackground: { kind: 'none' } })", 'flat', 700);
    await pixels('no picture', 3);

    // back to the desktop
    await ev("Settings.set({ newtabBackground: { kind: 'desktop' } }), 1");
    await waitFor("Backdrop.state().kind === 'desktop' && Backdrop.state().state === 'ok' && Toprow.status().top.kind === 'wash'", 15000);
    check(true, 'back to the desktop: wash');
    const ws = await ev("document.getElementById('titlebar').getAttribute('data-ws-colour')");
    await pixels('dark web page' + (ws ? ', workspace tint ' + ws : ''), 6);

    // Mantle goes away: the Settings line says so, with the reason
    await ev('Settings.open(), 1');
    server.close(); for (const s of socks) s.destroy();
    const line2 = await waitFor(LINE + " && /not running|closed the pipe/.test(" + LINE + ") && " + LINE, 5000).catch((e) => e.message);
    check(/Top bar hints: .*(not running|closed the pipe).*Trying again every 2 s/.test(line2), 'Settings > Look: Mantle gone -> the line says why and that it retries', line2);
    // every line within the protocol: v1, <= 8 KB, seq rising per hwnd
    const lines = got.filter((g) => g.m);
    const bySeq = {};
    let rising = true;
    for (const g of lines) { const h = g.m.hwnd; if (bySeq[h] !== undefined && g.m.seq <= bySeq[h]) rising = false; bySeq[h] = g.m.seq; }
    check(lines.every((g) => g.m.v === 1 && g.bytes <= 8192) && !got.some((g) => g.bad) && rising,
      'every line: v1, <= 8 KB, seq rising per hwnd', lines.length + ' lines, largest ' + Math.max(...lines.map((g) => g.bytes)) + ' bytes');
  } catch (e) {
    check(false, 'HARNESS ERROR ' + (e && e.stack || e));
  } finally {
    if (watcher) { const v = watcher.verdict(); check(v.ok, v.line); watcher.stop(); }
    if (child && !KEEP) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ }
      await sleep(1200);
      for (let i = 0; i < 10; i++) { try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); break; } catch (e) { await sleep(400); } }
      fs.rmSync(LOOK_DIR, { recursive: true, force: true });
    }
    if (ws) ws.close();
    server.close();
    console.log(`toprow-e2e: ${pass} passed, ${fail} failed` + (skip ? `, ${skip} skipped` : ''));
    process.exit(fail ? 1 : 0);
  }
})();
