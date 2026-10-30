require('./tools/lowcpu-optional.js');   // first: the CPU cap, when one is configured (tools/lowcpu-optional.js; none on a cloud runner)
// favicons-e2e.js — tab logos end to end, against a REAL test instance of Quartz, off-screen.
//
//   node favicons-e2e.js [--port 9437] [--keep] [--shots <dir>]
//
// Local test sites on ONE http server, told apart by host name (*.localhost resolves to loopback
// in Chromium), so each is its own origin with its own monogram letter:
//   alpha    <link rel=icon> to a 32px PNG
//   bravo    no icon at all (no link, /favicon.ico 404s)       -> the "B" monogram, with a reason
//   charlie  an SVG icon
//   delta    an icon that takes 2.5 s to arrive                -> "D" first, then the logo, no jump
//   echo     no link, but /favicon.ico exists (PNG-in-ICO)     -> the site's own icon
//   foxtrot  a PNG icon and a looping tone                     -> speaker NEXT TO the logo
//   golf     a data: URI icon
// Run 1 (100%): every site in a tab; then sleep + wake, a sub-frame load (the old wipe), mute,
// pin, the light look. Quit gracefully (window.close), so the session and the favicon cache flush.
// Run 2 (150%, same profile): every page now answers SLOWLY (4 s) and alpha is OFFLINE, so any logo
// on a chip in the first second came from the disk cache, before any page loaded.
// Off-screen: --test-profile --offscreen --show-inactive --measure-visible; testwatch.js's watcher
// fails the run if a window ever touches the desktop. Not launched under 2.5 GB free RAM.
// Tab-strip captures go to --shots (default: a temp dir, printed). Kills ONLY its own process tree,
// deletes its profile. One summary line: "favicons-e2e: N passed, M failed".
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
const PORT = Number(opt('port', '9437'));
const KEEP = argv.includes('--keep');
const APP = __dirname;
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROFILE = 'faviconse2e' + process.pid;
const PROFILE_DIR = path.join(os.tmpdir(), 'browser-test-profile-' + PROFILE);
const SHOTS = opt('shots', path.join(os.tmpdir(), 'favicons-e2e-shots-' + process.pid));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(cond, name, detail) {
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
/** A size x size RGBA PNG: a rounded-ish square in `rgb` with a white bar, so scaling shows. */
function png(size, rgb) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const edge = (x < 1 || y < 1 || x >= size - 1 || y >= size - 1);
      const bar = y >= size * 0.4 && y < size * 0.6 && x >= size * 0.2 && x < size * 0.8;
      const c = bar ? [255, 255, 255] : rgb;
      row.set([c[0], c[1], c[2], edge ? 0 : 255], 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
function icoOf(pngBuf, size) {
  const head = Buffer.from([0, 0, 1, 0, 1, 0]);
  const dir = Buffer.alloc(16);
  dir[0] = size; dir[1] = size; dir.writeUInt16LE(1, 4); dir.writeUInt16LE(32, 6);
  dir.writeUInt32LE(pngBuf.length, 8); dir.writeUInt32LE(22, 12);
  return Buffer.concat([head, dir, pngBuf]);
}
function wavTone() {
  const rate = 8000, n = rate; const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 3000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const IMG = {
  a: png(32, [37, 99, 235]), d: png(32, [22, 163, 74]), e: png(32, [217, 119, 6]), f: png(32, [147, 51, 234]),
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#e11d48"/><path d="M4 8h8" stroke="#fff" stroke-width="2"/></svg>'),
  wav: wavTone()
};
const GOLF_DATA = 'data:image/png;base64,' + png(16, [8, 145, 178]).toString('base64');

/* ---- the sites ------------------------------------------------------------ */
const state = { slowPages: 0, offline: new Set() };
const hits = {};
function page(title, head, body) { return '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>' + (head || '') + '</head><body style="font:14px sans-serif">' + title + (body || '') + '</body></html>'; }
const SITES = {
  alpha: { '/': () => ['text/html', page('Alpha', '<link rel="icon" href="/a.png">')], '/a.png': () => ['image/png', IMG.a] },
  bravo: { '/': () => ['text/html', page('Bravo')] },
  charlie: { '/': () => ['text/html', page('Charlie', '<link rel="icon" type="image/svg+xml" href="/c.svg">')], '/c.svg': () => ['image/svg+xml', IMG.svg] },
  delta: { '/': () => ['text/html', page('Delta', '<link rel="icon" href="/slow.png">')], '/slow.png': () => ['image/png', IMG.d, 2500] },
  echo: { '/': () => ['text/html', page('Echo')], '/favicon.ico': () => ['image/x-icon', icoOf(IMG.e, 32)] },
  foxtrot: { '/': () => ['text/html', page('Foxtrot', '<link rel="icon" href="/f.png">', '<audio id="t" src="/tone.wav" autoplay loop></audio>')], '/f.png': () => ['image/png', IMG.f], '/tone.wav': () => ['audio/wav', IMG.wav] },
  golf: { '/': () => ['text/html', page('Golf', '<link rel="icon" href="' + GOLF_DATA + '">')] }
};
const server = http.createServer((req, res) => {
  const host = String(req.headers.host || '').split('.')[0];
  const p = req.url.split('?')[0];
  hits[host + p] = (hits[host + p] || 0) + 1;
  if (state.offline.has(host)) { req.socket.destroy(); return; }
  const route = SITES[host] && SITES[host][p];
  if (!route) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>404</h1>'); return; }
  const [type, body, delay] = route();
  const wait = (type === 'text/html' ? state.slowPages : 0) + (delay || 0);
  setTimeout(() => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); }, wait);
});
let base = 0;
const url = (site) => 'http://' + site + '.localhost:' + base + '/';

/* ---- CDP ------------------------------------------------------------------ */
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
  while (Date.now() - t0 < ms) { try { last = await ev(expr); if (last) return last; } catch (e) { last = e.message; } await sleep(80); }
  throw new Error('timed out: ' + expr.slice(0, 140) + ' (last ' + JSON.stringify(last) + ')');
}

/** One chip's logo as the page sees it. */
const CHIP = `(host) => {
  const t = tabs.find((x) => x.kind === 'page' && String(x.url).indexOf('//' + host + '.localhost') !== -1);
  if (!t || !t.favEl) return null;
  const r = t.favEl.getBoundingClientRect();
  const img = t.iconEl;
  const badge = t.favEl.querySelector('.tab-badge');
  const mono = t.monoEl;
  return { id: t.id, state: t.favEl.dataset.state, w: r.width, h: r.height,
    src: (img.getAttribute('src') || '').slice(0, 30), natural: img.naturalWidth, imgVis: getComputedStyle(img).visibility,
    mono: mono.textContent, monoShown: getComputedStyle(mono).display !== 'none', title: t.favEl.title || '',
    badge: getComputedStyle(badge).display, asleep: !!t.asleep, audible: !!t.audible, muted: !!t.muted,
    audioShown: !!(t.audioEl && !t.audioEl.hidden && t.audioEl.isConnected), chipW: t.chipEl.getBoundingClientRect().width,
    from: t.favFrom || '', reason: t.favReason || '' };
}`;
// A chip is read as painted: the CSS transitions running on its logo slot end first. Under
// prefers-reduced-motion (Windows with its animations off, as on the hosted CI runner) tokens.css cuts
// every transition to 0.01 ms, and since transition-property defaults to `all`, a data-state flip to
// "icon" also starts a 0.01 ms visibility transition on the <img>: until the next frame getComputedStyle
// still reads `hidden`. Bounded at 3 s; on a timeout the read is what is there.
const chip = (host) => ev(`(async () => {
  const t = tabs.find((x) => x.kind === 'page' && String(x.url).indexOf('//' + ${JSON.stringify(host)} + '.localhost') !== -1);
  if (t && t.favEl) {
    await Promise.race([
      Promise.all(t.favEl.getAnimations({ subtree: true }).filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => null))),
      new Promise((r) => setTimeout(r, 3000))]);
  }
  return (${CHIP})(${JSON.stringify(host)});
})()`);

async function shot(name) {
  try {
    const rect = await ev(`(() => { const r = document.getElementById('tabstrip').getBoundingClientRect(); return { x: r.left, y: r.top, w: Math.min(r.width, 1400), h: r.height, dpr: devicePixelRatio }; })()`);
    const m = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } });
    if (!m.result || !m.result.data) { console.log('[e2e] shot ' + name + ': no data ' + JSON.stringify(m.error || {})); return; }
    fs.mkdirSync(SHOTS, { recursive: true });
    const file = path.join(SHOTS, name + '.png');
    fs.writeFileSync(file, Buffer.from(m.result.data, 'base64'));
    console.log('[e2e] shot ' + file + ' (dpr ' + rect.dpr + ')');
  } catch (e) { console.log('[e2e] shot ' + name + ' failed: ' + e.message); }
}

async function launch(extra, watcher) {
  const child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + PORT, '--test-profile', '--profile-name=' + PROFILE, ...OFFSCREEN_ARGS, ...extra],
    { cwd: APP, stdio: 'ignore', env: Object.assign({}, process.env) });
  watcher.watch(child.pid);
  console.log('[e2e] quartz pid ' + child.pid + ' ' + extra.join(' '));
  await connect();
  await waitFor("typeof tabs !== 'undefined' && !!window.TabIcons && document.body.classList.contains('booted')", 30000);
  return child;
}
function killTree(child) { if (child) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ } } }
function exited(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}

(async () => {
  let child = null;
  let watcher = null;
  try {
    const free = freeRamGb();
    if (!(free >= MIN_FREE_GB)) { console.log('favicons-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = server.address().port;
    watcher = startWatcher((l) => console.log('[e2e] ' + l));
    await watcher.ready;

    /* ===== run 1: 100% ===== */
    child = await launch(['--force-device-scale-factor=1'], watcher);
    const order = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'];
    // Watch delta's box from the first frame: its width must never change and it must never be blank once loaded.
    for (const s of order) {
      await ev(`createTab(${JSON.stringify(url(s))}, { background: false }) && true`);
      if (s === 'delta') {
        await ev(`(() => { const t = tabs[tabs.length - 1]; window.__deltaLog = []; const log = () => window.__deltaLog.push({ s: t.favEl.dataset.state, w: t.favEl.getBoundingClientRect().width, tw: t.titleEl.getBoundingClientRect().left - t.chipEl.getBoundingClientRect().left });
          log(); new MutationObserver(log).observe(t.favEl, { attributes: true, subtree: true }); return true; })()`);
      }
    }
    await waitFor(`(${CHIP})('alpha') && (${CHIP})('alpha').state === 'icon'`, 15000);
    let c = await chip('alpha');
    check(c.state === 'icon' && c.natural > 0 && c.imgVis === 'visible' && !c.monoShown, 'alpha: declared PNG shows', JSON.stringify(c));
    check(c.w === 14 && c.h === 14, 'alpha: the logo box is 14x14 CSS px', c.w + 'x' + c.h);
    check(/^data:image\//.test(c.src), 'alpha: the chip wears a data: URL (no remote URL to lose)', c.src);

    await waitFor(`(${CHIP})('bravo').state === 'mono' && (${CHIP})('bravo').title !== ''`, 20000);
    c = await chip('bravo');
    check(c.state === 'mono' && c.mono === 'B' && c.monoShown && c.w === 14, 'bravo: no icon anywhere -> the "B" monogram', JSON.stringify(c));
    check(/No site icon/.test(c.title), 'bravo: the monogram says why on hover', c.title.slice(0, 140));

    await waitFor(`(${CHIP})('charlie').state === 'icon'`, 15000);
    c = await chip('charlie');
    check(c.state === 'icon' && /^data:image\/svg\+xml/.test(c.src), 'charlie: SVG icon kept as SVG (vector-crisp at any scale)', c.src);

    await waitFor(`(${CHIP})('echo').state === 'icon'`, 15000);
    check(true, 'echo: no <link>, the site\'s own /favicon.ico (PNG-in-ICO) shows');

    await waitFor(`(${CHIP})('golf').state === 'icon'`, 15000);
    check(true, 'golf: data: URI icon shows');

    await waitFor(`(${CHIP})('delta').state === 'icon'`, 15000);
    const dlog = await ev('window.__deltaLog');
    const widths = new Set(dlog.map((x) => x.w)); const titleXs = new Set(dlog.map((x) => x.tw));
    check(widths.size === 1 && [...widths][0] === 14 && titleXs.size === 1, 'delta (slow icon): box and title never moved while the icon arrived',
      'states ' + dlog.map((x) => x.s).join('>') + ' widths ' + [...widths] + ' titleX ' + [...titleXs]);
    check(dlog.some((x) => x.s === 'mono') && dlog[dlog.length - 1].s === 'icon', 'delta: the "D" monogram held the place until the slow icon came');

    await waitFor(`(${CHIP})('foxtrot').audible && (${CHIP})('foxtrot').state === 'icon'`, 15000).catch(() => null);
    c = await chip('foxtrot');
    check(c.audible && c.audioShown && c.state === 'icon' && c.imgVis === 'visible', 'foxtrot: playing audio -> speaker NEXT TO the logo, logo still shown', JSON.stringify(c));
    await shot('1-loaded-100');

    // The old wipe: a sub-frame load fires did-start-loading; the logo must survive it.
    await ev(`(() => { const t = tabs.find((x) => String(x.url).indexOf('alpha.') !== -1); return t.viewEl.executeJavaScript("var f=document.createElement('iframe');f.src='/sub?'+Date.now();document.body.appendChild(f);1"); })()`);
    await sleep(1500);
    c = await chip('alpha');
    check(c.state === 'icon' && c.imgVis === 'visible', 'alpha: a sub-frame load no longer wipes the logo', c.state);
    // A reload of the same page keeps it too.
    await ev(`(() => { const t = tabs.find((x) => String(x.url).indexOf('alpha.') !== -1); t.viewEl.reload(); return true; })()`);
    await sleep(300);
    c = await chip('alpha');
    check(c.state === 'icon', 'alpha: reloading keeps the logo on the chip mid-load', c.state);
    await sleep(1500);
    const alphaFetches = hits['alpha/a.png'] || 0;

    // Mute: the logo stays, the speaker shows muted.
    await ev(`setTabMuted(tabs.find((x) => String(x.url).indexOf('foxtrot.') !== -1), true) || true`);
    c = await chip('foxtrot');
    check(c.muted && c.audioShown && c.state === 'icon', 'foxtrot: muted -> muted speaker beside the logo, logo still shown', JSON.stringify({ muted: c.muted, audio: c.audioShown, state: c.state }));

    // Sleep + wake: the logo never leaves; the crescent sits ON it as a badge.
    await ev(`activateTab(tabs.find((x) => String(x.url).indexOf('golf.') !== -1).id) || true`);
    const slept = await ev(`sleepTab(tabs.find((x) => String(x.url).indexOf('alpha.') !== -1))`);
    c = await chip('alpha');
    check(slept && c.asleep && c.state === 'icon' && c.imgVis === 'visible' && c.badge === 'flex', 'alpha asleep: logo shown, crescent badge on it', JSON.stringify(c));
    await ev(`sleepTab(tabs.find((x) => String(x.url).indexOf('bravo.') !== -1))`);
    c = await chip('bravo');
    check(c.asleep && c.state === 'mono' && c.badge === 'flex', 'bravo asleep: monogram shown, crescent badge on it', JSON.stringify({ s: c.state, b: c.badge }));
    await shot('2-asleep-muted-100');
    await ev(`(() => { const t = tabs.find((x) => String(x.url).indexOf('alpha.') !== -1); window.__wakeLog = []; new MutationObserver(() => window.__wakeLog.push(t.favEl.dataset.state + ':' + getComputedStyle(t.iconEl).visibility)).observe(t.favEl, { attributes: true, subtree: true }); return wakeTab(t); })()`);
    await sleep(2500);
    c = await chip('alpha');
    const wl = await ev('window.__wakeLog');
    check(!c.asleep && c.state === 'icon' && wl.every((x) => x === 'icon:visible'), 'alpha woken: the logo never blinked', JSON.stringify(wl).slice(0, 160));
    check((hits['alpha/a.png'] || 0) === alphaFetches, 'alpha: waking/reloading did not refetch the icon (served from the cache)', 'a.png hits ' + (hits['alpha/a.png'] || 0));

    // Pinned: a 40px chip that is nothing but the logo.
    await ev(`setTabPinned(tabs.find((x) => String(x.url).indexOf('charlie.') !== -1), true) || true`);
    c = await chip('charlie');
    check(c.state === 'icon' && c.chipW === 40 && c.w === 14, 'charlie pinned: 40px chip, 14px logo', JSON.stringify({ chipW: c.chipW, w: c.w, s: c.state }));
    await shot('3-pinned-100');
    await ev(`document.documentElement.setAttribute('data-theme', 'light') || true`);
    await sleep(300);
    await shot('4-light-100');
    await ev(`document.documentElement.setAttribute('data-theme', 'dark') || true`);

    const desc = await ev('window.api.favicons.describe()');
    check(desc && desc.entries >= 5 && !desc.lastSaveError, 'main cache holds the learned logos', JSON.stringify(desc).slice(0, 200));

    // Quit gracefully so the session and the cache are written by the real quit path.
    await sleep(2000);
    await ev('setTimeout(() => window.close(), 50) && true').catch(() => null);
    const clean = await exited(child, 15000);
    check(clean, 'run 1 quit gracefully (window.close)');
    if (!clean) killTree(child);
    try { ws.close(); } catch (e) { /* closed */ }
    check(fs.existsSync(path.join(PROFILE_DIR, 'favicon-cache.json')), 'favicon-cache.json is on disk after the quit');

    /* ===== run 2: 150%, restart with session restore, every page slow, alpha offline ===== */
    state.slowPages = 4000;
    state.offline.add('alpha');
    // The watcher follows ONE pid: run 1's verdict now, a fresh watcher for run 2.
    { const v = watcher.verdict(); check(v.ok, 'run 1 ' + v.line); watcher.stop(); }
    watcher = startWatcher((l) => console.log('[e2e] ' + l));
    await watcher.ready;
    const t0 = Date.now();
    child = await launch(['--force-device-scale-factor=1.5'], watcher);
    await waitFor(`tabs.filter((t) => t.kind === 'page' && String(t.url).indexOf('.localhost') !== -1).length >= 7`, 20000);
    // Within a second of the chips existing, before any slow page could have loaded.
    await sleep(600);
    const early = {};
    for (const s of order) early[s] = await chip(s);
    const loadedAny = await ev(`tabs.some((t) => t.kind === 'page' && String(t.url).indexOf('.localhost') !== -1 && t.ready && document.title)`);
    const cachedOk = ['alpha', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'].filter((s) => early[s] && early[s].state === 'icon');
    check(cachedOk.length === 6, 'restart: restored chips show their logos from the disk cache before the pages load',
      cachedOk.join(',') + ' (' + (Date.now() - t0) + ' ms after launch) states ' + order.map((s) => s + '=' + (early[s] && early[s].state)).join(' '));
    check(early.bravo && early.bravo.state === 'mono' && early.bravo.mono === 'B', 'restart: bravo shows its monogram, not a blank', early.bravo && early.bravo.state);
    check(Object.values(early).every((x) => x && x.w === 14 && x.h === 14), 'restart at 150%: every logo box is still 14x14 CSS px');
    const dpr = await ev('devicePixelRatio');
    check(dpr === 1.5, 'run 2 renders at 150%', String(dpr));
    await shot('5-restored-150');
    // Alpha is offline: the page fails, the logo stays, the broken badge sits on it.
    await ev(`activateTab(tabs.find((x) => String(x.url).indexOf('alpha.') !== -1).id) || true`);
    await waitFor(`tabs.find((x) => String(x.url).indexOf('alpha.') !== -1).broken`, 20000).catch(() => null);
    c = await chip('alpha');
    const broken = await ev(`!!tabs.find((x) => String(x.url).indexOf('alpha.') !== -1).broken`);
    check(c.state === 'icon' && (!broken || c.badge === 'flex'), 'offline: the cached logo stays (broken=' + broken + ', badge ' + c.badge + ')', JSON.stringify({ s: c.state, b: c.badge }));
    await sleep(4500);
    await shot('6-offline-loaded-150');
    c = await chip('alpha');
    check(c.state === 'icon' && c.badge === 'flex' && c.imgVis === 'visible', 'offline after load: logo still shown with a badge on it (broken or asleep)', JSON.stringify({ s: c.state, b: c.badge, asleep: c.asleep }));
    await ev("document.documentElement.setAttribute('data-theme', 'dark') || true");
    await sleep(300);
    await shot('7-dark-150');
    await ev("document.documentElement.setAttribute('data-theme', 'light') || true");
    await sleep(300);
    await shot('8-light-150');
    c = await chip('charlie');
    check(c.state === 'icon', 'restart: pinned charlie still shows its logo after load');
  } catch (e) {
    check(false, 'HARNESS ERROR ' + (e && e.stack || e));
  } finally {
    if (watcher) { const v = watcher.verdict(); check(v.ok, 'run 2 ' + v.line); watcher.stop(); }
    if (child && !KEEP) {
      killTree(child);
      await sleep(1200);
      for (let i = 0; i < 10; i++) { try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); break; } catch (e) { await sleep(400); } }
    }
    try { if (ws) ws.close(); } catch (e) { /* closed */ }
    server.close();
    console.log('[e2e] shots in ' + SHOTS);
    console.log(`favicons-e2e: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
