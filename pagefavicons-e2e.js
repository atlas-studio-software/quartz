require('./tools/lowcpu-optional.js');   // first: the CPU cap, when one is configured (tools/lowcpu-optional.js; none on a cloud runner)
// pagefavicons-e2e.js — site logos OUTSIDE the tab strip (bookmarks bar, new tab page, history
// page), end to end, against a REAL test instance of Quartz, off-screen.
//
//   node pagefavicons-e2e.js [--port 9438] [--keep] [--shots <dir>] [--baseline]
//
// Local test sites on ONE http server, told apart by host name (*.localhost is loopback):
//   alpha    <link rel=icon> to a PNG          visited in a tab  -> its logo, from the store
//   bravo    no icon at all                    visited in a tab  -> the "B" monogram
//   echo     /favicon.ico only                 visited in a tab  -> its logo, from the store
//   charlie  /favicon.ico only                 NEVER visited     -> its logo, via the site probe
//   kilo     offline (socket destroyed)        never visited     -> the "K" monogram
// The five are pinned as the chips (chipsSource 'list'), so they are the bookmarks bar AND the new
// tab page's shortcuts; the three visited ones are the history page.
//
// Every network request is recorded two ways: CDP Network on every target (browser-level session,
// auto-attached, so guests are included) and each page's own Resource Timing list. The run FAILS on
// any request to a Google favicon host (google.*/s2/favicons, gstatic faviconV2). --baseline only
// counts those requests and skips the tile checks (for running against the old code).
// Captures (dark + light) go to --shots (default: a temp dir, printed). Kills ONLY its own process
// tree, deletes its profile. One summary line: "pagefavicons-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const zlib = require('zlib');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WS = require(path.join(__dirname, 'node_modules', 'ws'));
const { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb, startWatcher } = require('./testwatch');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(opt('port', '9438'));
const KEEP = argv.includes('--keep');
const BASELINE = argv.includes('--baseline');
const APP = __dirname;
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROFILE = 'pagefave2e' + process.pid;
const PROFILE_DIR = path.join(os.tmpdir(), 'browser-test-profile-' + PROFILE);
const SHOTS = opt('shots', path.join(os.tmpdir(), 'pagefavicons-e2e-shots-' + process.pid));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOGLE_FAV = /google\.[a-z.]+\/s2\/favicons|gstatic\.com\/faviconV2|\/faviconV2\?/i;

let pass = 0, fail = 0;
function check(cond, name, detail) {
  if (BASELINE) { console.log('INFO ' + name + (detail ? '  ' + detail : '')); return; }
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

/* ---- test images ---------------------------------------------------------- */
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A size x size PNG: a square in `rgb` with a white bar across the middle. */
function png(size, rgb) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const bar = y >= size * 0.4 && y < size * 0.6 && x >= size * 0.2 && x < size * 0.8;
      raw[o] = bar ? 255 : rgb[0]; raw[o + 1] = bar ? 255 : rgb[1]; raw[o + 2] = bar ? 255 : rgb[2]; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** A one-image .ico wrapping a PNG (what most sites serve as /favicon.ico). */
function icoOf(pngBuf, size) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head[6] = size >= 256 ? 0 : size; head[7] = size >= 256 ? 0 : size; head[8] = 0; head[9] = 0;
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(pngBuf.length, 14); head.writeUInt32LE(22, 18);
  return Buffer.concat([head, pngBuf]);
}
const IMG = { a: png(32, [220, 60, 50]), e: png(32, [40, 140, 220]), c: png(32, [40, 170, 90]) };

/* ---- the sites ------------------------------------------------------------ */
function page(title, head) { return '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>' + (head || '') + '</head><body style="font:14px sans-serif">' + title + '</body></html>'; }
const SITES = {
  alpha: { '/': () => ['text/html', page('Alpha', '<link rel="icon" href="/a.png">')], '/a.png': () => ['image/png', IMG.a] },
  bravo: { '/': () => ['text/html', page('Bravo')] },
  echo: { '/': () => ['text/html', page('Echo')], '/favicon.ico': () => ['image/x-icon', icoOf(IMG.e, 32)] },
  charlie: { '/': () => ['text/html', page('Charlie')], '/favicon.ico': () => ['image/x-icon', icoOf(IMG.c, 32)] }
};
const OFFLINE = new Set(['kilo']);
const server = http.createServer((req, res) => {
  const host = String(req.headers.host || '').split('.')[0];
  const p = req.url.split('?')[0];
  if (OFFLINE.has(host)) { req.socket.destroy(); return; }
  const route = SITES[host] && SITES[host][p];
  if (!route) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>404</h1>'); return; }
  const [type, body] = route();
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body);
});
let base = 0;
const url = (site) => 'http://' + site + '.localhost:' + base + '/';

/* ---- CDP: the chrome page ------------------------------------------------- */
let ws = null, msgId = 0;
const pending = new Map();
async function connect() {
  let targets = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try { targets = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json(); } catch (e) { targets = []; }
    if (targets.some((x) => x.type === 'page' && /index\.html/.test(String(x.url)))) break;
    await sleep(200);
  }
  const t = targets.find((x) => x.type === 'page' && /index\.html/.test(String(x.url)));
  if (!t) throw new Error('no chrome target');
  ws = new WS(t.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.on('message', (raw) => { const m = JSON.parse(String(raw)); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } });
}
function cdp(method, params) {
  const id = ++msgId;
  return new Promise((resolve) => {
    const t = setTimeout(() => { pending.delete(id); resolve({ error: { message: method + ' timed out' } }); }, 20000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function ev(expr) {
  const m = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (m.error) throw new Error(JSON.stringify(m.error));
  if (m.result.exceptionDetails) throw new Error('page threw: ' + ((m.result.exceptionDetails.exception || {}).description || m.result.exceptionDetails.text));
  return m.result.result.value;
}
async function waitFor(expr, ms) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await ev(expr); if (last) return last; } catch (e) { last = e.message; } await sleep(100); }
  throw new Error('timed out: ' + expr.slice(0, 160) + ' (last ' + JSON.stringify(last) + ')');
}

/* ---- CDP: the browser, for every target's network ------------------------- */
const netLog = [];          // { url, type }
let bws = null, bId = 0;
const bPending = new Map();
const attached = new Set();
function bcdp(method, params, sessionId) {
  const id = ++bId;
  const msg = { id, method, params: params || {} };
  if (sessionId) msg.sessionId = sessionId;
  // Never wait forever on one reply (a guest that is not producing frames can sit on a command).
  return new Promise((resolve) => {
    const t = setTimeout(() => { bPending.delete(id); resolve({ error: { message: method + ' timed out' } }); }, 10000);
    bPending.set(id, (m) => { clearTimeout(t); resolve(m); });
    bws.send(JSON.stringify(msg));
  });
}
async function connectBrowser() {
  const v = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json();
  bws = new WS(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((r, j) => { bws.on('open', r); bws.on('error', j); });
  bws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id && bPending.has(m.id)) { const p = bPending.get(m.id); bPending.delete(m.id); p(m); return; }
    if (m.method === 'Network.requestWillBeSent') netLog.push({ url: String(m.params.request.url), type: m.params.type || '' });
    else if (m.method === 'Target.attachedToTarget') {
      const sid = m.params.sessionId;
      bcdp('Network.enable', {}, sid).then(() => {
        if (m.params.waitingForDebugger) bcdp('Runtime.runIfWaitingForDebugger', {}, sid);
      });
    } else if (m.method === 'Target.targetCreated') attachTo(m.params.targetInfo);
  });
  await bcdp('Target.setDiscoverTargets', { discover: true });
  await bcdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const all = await bcdp('Target.getTargets');
  for (const t of (all.result && all.result.targetInfos) || []) attachTo(t);
}
function attachTo(info) {
  if (!info || attached.has(info.targetId)) return;
  if (!/^(page|webview|iframe|other)$/.test(info.type)) return;
  attached.add(info.targetId);
  bcdp('Target.attachToTarget', { targetId: info.targetId, flatten: true });
}
/** The whole window with the tab whose URL matches `test` in front (the guest composites into it). */
async function guestShot(test, name) {
  await ev(`(() => { const t = ${TAB(test)}; if (t) activateTab(t.id); return true; })()`).catch(() => null);
  await sleep(900);
  await windowShot(name, false);
}
/** The chrome window (tab strip, bookmarks bar, and the active page under them). */
async function windowShot(name, clipBar) {
  try {
    const params = { format: 'png', fromSurface: true, captureBeyondViewport: false };
    if (clipBar) {
      const r = await ev(`(() => { const b = document.getElementById('bookmarks-bar'); const r = b.getBoundingClientRect(); return { x: 0, y: 0, w: Math.min(innerWidth, 1400), h: r.bottom + 4 }; })()`);
      params.clip = { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 };
    }
    const m = await cdp('Page.captureScreenshot', params);
    if (!m.result || !m.result.data) { console.log('[e2e] shot ' + name + ': no data'); return; }
    fs.mkdirSync(SHOTS, { recursive: true });
    const file = path.join(SHOTS, name + '.png');
    fs.writeFileSync(file, Buffer.from(m.result.data, 'base64'));
    console.log('[e2e] shot ' + file);
  } catch (e) { console.log('[e2e] shot ' + name + ' failed: ' + e.message); }
}

/* ---- page probes ---------------------------------------------------------- */
/** Run `code` inside a tab's guest (found by a URL test in the chrome) and return its value. */
const TAB = (test) => `tabs.find((x) => x.kind === 'page' && x.viewEl && (${test})(String(x.url)))`;
const inGuest = (test, code) => ev(`(() => { const t = ${TAB(test)}; if (!t || !t.ready) return null; return t.viewEl.executeJavaScript(${JSON.stringify(code)}); })()`);
const IS_NEWTAB = '(u) => /newtab\\.html/.test(u)';
const IS_HISTORY = '(u) => /historypage\\.html/.test(u)';

/** Every logo tile under `sel` in this document: host letter, state, box, what the img holds. */
const TILES = (sel) => `(() => Array.from(document.querySelectorAll(${JSON.stringify(sel)})).map((el) => {
  const r = el.getBoundingClientRect(); const img = el.querySelector('img'); const mono = el.querySelector('.qfav-mono');
  return { origin: el.getAttribute('data-origin') || '', state: el.getAttribute('data-state') || '', cls: el.className,
    w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
    src: img ? (img.getAttribute('src') || '').slice(0, 22) : '(no img)', natural: img ? img.naturalWidth : 0,
    imgVis: img ? getComputedStyle(img).visibility : '', mono: mono ? mono.textContent : '',
    monoShown: mono ? getComputedStyle(mono).display !== 'none' : false };
}))()`;
/** Every <img> in the document whose src is a remote URL (a logo must never be one). */
const REMOTE_IMGS = `(() => Array.from(document.images).map((i) => i.currentSrc || i.src || '').filter((s) => /^https?:/i.test(s)))()`;
const RESOURCES = `(() => performance.getEntriesByType('resource').map((e) => e.name))()`;

function hostOfOrigin(o) { return String(o).replace(/^https?:\/\//, '').split('.')[0]; }
function judgeTiles(where, tiles, size) {
  const byHost = {};
  for (const t of tiles) byHost[hostOfOrigin(t.origin)] = t;
  const settled = tiles.every((t) => t.state === 'icon' || t.state === 'mono');
  check(tiles.length > 0 && settled, where + ': every logo settled (icon or monogram, none blank)',
    tiles.map((t) => hostOfOrigin(t.origin) + '=' + t.state).join(' '));
  const broken = tiles.filter((t) => (t.state === 'icon' && !(t.natural > 0 && t.imgVis === 'visible' && /^data:image\//.test(t.src)))
    || (t.state === 'mono' && !(t.monoShown && t.mono)));
  check(broken.length === 0, where + ': no broken image (an icon has decoded a data: image; a monogram shows its letter)', JSON.stringify(broken).slice(0, 400));
  const remote = tiles.filter((t) => t.src && !/^data:|^\(no img\)$|^$/.test(t.src));
  check(remote.length === 0, where + ': no tile <img> holds a remote URL', JSON.stringify(remote).slice(0, 300));
  if (size) {
    const off = tiles.filter((t) => t.w !== size || t.h !== size);
    check(off.length === 0, where + ': every tile is ' + size + 'x' + size + ' CSS px (the surface\'s old size)', JSON.stringify(off.map((t) => [hostOfOrigin(t.origin), t.w, t.h])));
  }
  return byHost;
}
function expectKnown(where, byHost, hosts) {
  for (const [h, want] of Object.entries(hosts)) {
    const t = byHost[h];
    check(!!t && t.state === want, where + ': ' + h + ' -> ' + want, t ? t.state + (t.mono ? ' "' + t.mono + '"' : '') : 'missing');
  }
}

async function launch(extra, watcher) {
  const child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + PORT, '--test-profile', '--profile-name=' + PROFILE, ...OFFSCREEN_ARGS, ...extra],
    { cwd: APP, stdio: 'ignore', env: Object.assign({}, process.env) });
  watcher.watch(child.pid);
  console.log('[e2e] quartz pid ' + child.pid + ' ' + extra.join(' '));
  await connect();
  await connectBrowser();
  await waitFor("typeof tabs !== 'undefined' && !!window.TabIcons && document.body.classList.contains('booted')", 30000);
  return child;
}
function killTree(child) { if (child) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ } } }

// A hard ceiling: a hung step fails the run instead of eating runner minutes.
const WATCHDOG = setTimeout(() => { console.log('FAIL watchdog: the run passed 6 minutes'); try { if (global.__child) execFileSync('taskkill', ['/PID', String(global.__child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ } console.log('pagefavicons-e2e: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); }, 6 * 60 * 1000);
WATCHDOG.unref();

(async () => {
  let child = null;
  let watcher = null;
  try {
    const free = freeRamGb();
    if (!(free >= MIN_FREE_GB)) { console.log('pagefavicons-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = server.address().port;
    watcher = startWatcher((l) => console.log('[e2e] ' + l));
    await watcher.ready;
    child = await launch(['--force-device-scale-factor=1'], watcher);
    global.__child = child;
    // Every Look Sync status this run, so a 'Problem' (a cloud run's light screenshot once caught
    // 'Watching ...look-sync stopped (folder was removed)') fails the run instead of hiding in a shot.
    await ev("(window.__lsProblems = [], document.addEventListener('lookstatus', (e) => { const s = e.detail || {}; if (s.state === 'error') __lsProblems.push(String(s.reason)); }), (window.LookSync && LookSync.status().state === 'error' && __lsProblems.push(String(LookSync.status().reason))), 1)");
    await ev("setThemeMode('dark') || true");

    // 1. Visit three sites, so the store and the history hold them.
    for (const s of ['alpha', 'bravo', 'echo']) await ev(`createTab(${JSON.stringify(url(s))}, { background: false }) && true`);
    const CHIP = (h) => `(() => { const t = tabs.find((x) => x.kind === 'page' && String(x.url).indexOf('//${h}.localhost') !== -1); return t && t.favEl ? t.favEl.dataset.state : null; })()`;
    await waitFor(CHIP('alpha') + " === 'icon'", 20000);
    await waitFor(CHIP('echo') + " === 'icon'", 20000);
    await waitFor(CHIP('bravo') + " === 'mono'", 20000);
    check(true, 'setup: alpha + echo logos in the tab strip, bravo its monogram');

    // 2. The five sites are the chips: the bookmarks bar and the new tab's shortcuts.
    const chips = ['alpha', 'bravo', 'charlie', 'echo', 'kilo'].map((s) => ({ label: s[0].toUpperCase() + s.slice(1), url: url(s) }));
    await ev(`Settings.set(${JSON.stringify({ chips, chipsSource: 'list', bookmarksBar: true })}) && true`);
    if (BASELINE) await sleep(5000);
    else await waitFor(`(() => { const t = ${TILES('#bookmarks-bar .qfav')}; return t.length >= 5 && t.every((x) => x.state !== 'pending'); })()`, 20000);
    // charlie is never visited: its logo comes from the site probe, which may land after a letter.
    if (!BASELINE) await waitFor(`(${TILES('#bookmarks-bar .qfav')}).some((x) => /charlie/.test(x.origin) && x.state === 'icon')`, 15000).catch(() => null);
    let bar = await ev(TILES('#bookmarks-bar .qfav'));
    let byHost = judgeTiles('bookmarks bar', bar, 16);
    expectKnown('bookmarks bar', byHost, { alpha: 'icon', bravo: 'mono', charlie: 'icon', echo: 'icon', kilo: 'mono' });
    check((await ev(REMOTE_IMGS)).filter((s) => GOOGLE_FAV.test(s)).length === 0, 'chrome: no <img> points at a Google favicon host');

    // 3. The new tab page.
    await ev("createTab(null, { background: false }) && true");
    await waitFor(`(() => { const t = ${TAB(IS_NEWTAB)}; return !!(t && t.ready); })()`, 20000);
    const NT_SEL = '.chip .qfav, .chip-icon, .rtile-icon, .dock-icon-web, .dock-result-icon';
    if (BASELINE) await sleep(6000);
    else {
      const t0 = Date.now();
      let ok = false;
      while (Date.now() - t0 < 20000) {
        const t = await inGuest(IS_NEWTAB, TILES('.qfav'));
        if (Array.isArray(t) && t.length >= 5 && t.every((x) => x.state !== 'pending')) { ok = true; break; }
        await sleep(150);
      }
      check(ok, 'new tab: logo tiles drawn and settled within 20 s');
      await sleep(1200); // let a probe-learned logo (charlie) land
    }
    const nt = (await inGuest(IS_NEWTAB, TILES('.qfav'))) || [];
    byHost = judgeTiles('new tab', nt, 0);
    expectKnown('new tab', byHost, { alpha: 'icon', bravo: 'mono', charlie: 'icon', echo: 'icon', kilo: 'mono' });
    const ntChips = (await inGuest(IS_NEWTAB, TILES('.chip .qfav'))) || [];
    // the design's chip plate is 18x18 (design style.css:367), and the logo fills it
    check(ntChips.length >= 5 && ntChips.every((t) => t.w === 18 && t.h === 18), 'new tab: shortcut chip logos are 18x18 (the design chip plate)', JSON.stringify(ntChips.map((t) => [hostOfOrigin(t.origin), t.w])));
    const ntOld = (await inGuest(IS_NEWTAB, `document.querySelectorAll(${JSON.stringify(NT_SEL)}).length`)) || 0;
    console.log('[e2e] new tab icon nodes (any kind): ' + ntOld + ', PageFavicons ' + JSON.stringify(await inGuest(IS_NEWTAB, 'window.PageFavicons && window.PageFavicons.describe()')));
    await guestShot(IS_NEWTAB, 'newtab-dark');

    // 4. The history page.
    await ev("createTab(History.pageUrl(), { background: false }) && true");
    await waitFor(`(() => { const t = ${TAB(IS_HISTORY)}; return !!(t && t.ready); })()`, 20000);
    if (BASELINE) await sleep(5000);
    else {
      const t0 = Date.now();
      let ok = false;
      while (Date.now() - t0 < 20000) {
        const t = await inGuest(IS_HISTORY, TILES('.favbox .qfav'));
        if (Array.isArray(t) && t.length >= 3 && t.every((x) => x.state !== 'pending')) { ok = true; break; }
        await sleep(150);
      }
      check(ok, 'history: logo tiles drawn and settled within 20 s');
    }
    const hi = (await inGuest(IS_HISTORY, TILES('.favbox .qfav'))) || [];
    byHost = judgeTiles('history', hi, 16);
    expectKnown('history', byHost, { alpha: 'icon', bravo: 'mono', echo: 'icon' });
    const boxes = await inGuest(IS_HISTORY, `[document.querySelectorAll('.favbox').length, document.querySelectorAll('.favbox .qfav').length]`);
    check(boxes && boxes[0] > 0 && boxes[0] === boxes[1], 'history: every row\'s logo box holds a tile', JSON.stringify(boxes));
    await guestShot(IS_HISTORY, 'history-dark');
    await windowShot('bookmarks-dark', true);
    // The theme each page is WEARING: its data-theme and the luminance (0..1) of the ground it paints.
    const LOOK = `(() => { const l = (c) => { const m = String(c).match(/[\\d.]+/g) || []; return m.length >= 3 && (m.length < 4 || +m[3] > 0) ? (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 : null; };
      const lum = [document.body, document.documentElement].map((e) => l(getComputedStyle(e).backgroundColor)).find((v) => v !== null);
      return { theme: document.documentElement.getAttribute('data-theme'), lum: lum === undefined ? null : Math.round(lum * 100) / 100 }; })()`;
    const looks = async () => ({ history: await inGuest(IS_HISTORY, LOOK), newtab: await inGuest(IS_NEWTAB, LOOK) });
    // The history page paints a plain --bg ground, so its luminance is judged too. The new tab page
    // paints a picture behind a transparent body (lum null): the control there is its data-theme.
    const isDark = (x) => !!(x && x.theme === 'dark' && (x.lum === null || x.lum < 0.35));
    const isLight = (x) => !!(x && x.theme === 'light' && (x.lum === null || x.lum > 0.65));
    const painted = (x) => !!(x && x.lum !== null);
    // Waits on the real signal, not a clock: both pages wearing `want` (their data-theme, which the
    // chrome's push sets), and then, with the history page brought on screen, its painted ground.
    // The ground has to be judged ON SCREEN: the body's 200 ms background fade only runs while the
    // tab paints, so a history tab in the background keeps the old ground in getComputedStyle until
    // it is shown, then fades (a back-to-dark run once read {"theme":"dark","lum":0.91} that way).
    const settle = async (want, judge, ms) => {
      const t0 = Date.now(); let l = await looks();
      while (!judge(l) && Date.now() - t0 < (ms || 6000)) { await sleep(100); l = await looks(); }
      return l;
    };
    const wearing = (want) => (l) => !!(l.history && l.newtab && l.history.theme === want && l.newtab.theme === want);
    let lk = await looks();
    check(isDark(lk.history) && painted(lk.history) && isDark(lk.newtab), 'theme: dark, the history page paints dark (and the new tab page is dark)', JSON.stringify(lk));

    // 5. The light look: the same tiles, re-captured.
    await ev("setThemeMode('light') || true");
    lk = await settle('light', wearing('light'));
    check(wearing('light')(lk), 'theme: the switch to light reaches both pages, the background history tab included', JSON.stringify(lk));
    await windowShot('bookmarks-light', true);
    await guestShot(IS_HISTORY, 'history-light');
    await guestShot(IS_NEWTAB, 'newtab-light');
    const ntLight = (await inGuest(IS_NEWTAB, TILES('.qfav'))) || [];
    judgeTiles('new tab (light)', ntLight, 0);
    await guestShot(IS_HISTORY, 'history-light-front');
    lk = await settle('light', (l) => isLight(l.history) && painted(l.history) && isLight(l.newtab));
    check(isLight(lk.newtab), 'theme: switched to light, the new tab page is light', JSON.stringify(lk.newtab));
    const lsProblems = await ev("window.__lsProblems.concat(LookSync.status().state === 'error' ? [String(LookSync.status().reason)] : [])");
    check(lsProblems.length === 0, 'Look Sync: no Problem through two theme flips (dark, then light)', lsProblems.slice(0, 3).join(' | ') || 'none');
    check(isLight(lk.history) && painted(lk.history), 'theme: switched to light, the open history page follows (it used to stay dark)', JSON.stringify(lk.history));
    // ...and back: a history page opened in light follows the switch to dark as well.
    await ev("setThemeMode('dark') || true");
    lk = await settle('dark', wearing('dark'));
    check(wearing('dark')(lk), 'theme: the switch back to dark reaches both pages, the background history tab included', JSON.stringify(lk));
    await guestShot(IS_HISTORY, 'history-dark-again');
    lk = await settle('dark', (l) => isDark(l.history) && painted(l.history) && isDark(l.newtab));
    check(isDark(lk.history) && painted(lk.history) && isDark(lk.newtab), 'theme: and back to dark, both follow again (the history page paints dark on screen)', JSON.stringify(lk));

    // 6. The network: zero requests to a Google favicon host, by every count.
    const perf = [].concat(
      (await ev(RESOURCES)) || [],
      (await inGuest(IS_NEWTAB, RESOURCES)) || [],
      (await inGuest(IS_HISTORY, RESOURCES)) || []);
    const imgs = [].concat(
      (await ev(REMOTE_IMGS)) || [],
      (await inGuest(IS_NEWTAB, REMOTE_IMGS)) || [],
      (await inGuest(IS_HISTORY, REMOTE_IMGS)) || []);
    const gNet = netLog.filter((r) => GOOGLE_FAV.test(r.url));
    const gPerf = perf.filter((u) => GOOGLE_FAV.test(u));
    const gImg = imgs.filter((u) => GOOGLE_FAV.test(u));
    console.log('[e2e] recorded ' + netLog.length + ' CDP requests on ' + attached.size + ' targets, ' + perf.length + ' resource entries');
    console.log('google favicon requests: cdp=' + gNet.length + ' resource-timing=' + gPerf.length + ' img-src=' + gImg.length);
    for (const u of Array.from(new Set(gNet.map((r) => r.url).concat(gPerf, gImg))).slice(0, 12)) console.log('[e2e]   ' + u);
    check(netLog.length > 0, 'network recorder saw requests (it is live)', String(netLog.length));
    check(gNet.length === 0 && gPerf.length === 0 && gImg.length === 0, '0 requests to Google favicon hosts');
  } catch (e) {
    check(false, 'HARNESS ERROR ' + (e && e.stack || e));
    if (BASELINE) console.log('HARNESS ERROR ' + (e && e.stack || e));
  } finally {
    if (watcher) { const v = watcher.verdict(); check(v.ok, v.line); watcher.stop(); }
    if (child && !KEEP) {
      killTree(child);
      await sleep(1200);
      for (let i = 0; i < 10; i++) { try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); break; } catch (e) { await sleep(400); } }
    }
    try { if (ws) ws.close(); } catch (e) { /* closed */ }
    try { if (bws) bws.close(); } catch (e) { /* closed */ }
    server.close();
    console.log('[e2e] shots in ' + SHOTS);
    console.log(`pagefavicons-e2e${BASELINE ? ' (baseline)' : ''}: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
