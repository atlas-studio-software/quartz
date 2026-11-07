require('./tools/lowcpu-optional.js');   // first: the CPU cap, when one is configured (tools/lowcpu-optional.js; none on a cloud runner)
// watch-player-e2e.js -- the Watch player layer (watch-player.js + watch-player-main.js), end to end, in a
// REAL hidden Quartz test instance (tests/e2e-kit.js: --test-profile, off-screen, watched by testwatch.js).
// Watch's rows come from the LOCAL service mock (tests/watch-mock.js); every service origin is rebased
// to a local "front" server here that serves the player fixtures (an HTML5 video page, a page that
// refuses framing, a licence-refusing page, the public Widevine test stream page) and hands every
// other path to the mock. Never a real account, cookie or profile; Edge is a stub file, never launched.
//
//   node watch-player-e2e.js [--cdp 9471] [--shots <dir>] [--no-widevine] [--only-shots]
//
// Checks: a card click opens the layer over the Watch tab (no new tab), the bar (title, mark, Edge
// button), the view adopted by main; in-layer navigation (a link, a target=_blank link, both in place);
// Back walks the layer's own history, then closes; the Watch page's scroll position survives; the view's
// webContents is gone after close; the re-read ("fresh after watching") fires; a link to another site
// opens a normal tab with a log line; an app link is stopped and said; a sign-in popup opens as a sheet
// in the layer (opener kept, no window) and closes itself; fullscreen in/out and the Esc order; Alt+Left;
// the mouse back button; the media key; one player at a time; a page that refuses framing plays here; a
// licence refusal shows the refused state with Open in Edge; Settings > Watch "Play inside Watch" off
// gives the old new-tab behaviour; DRM not ready sends Disney+ to the Edge stub (second boot); RAM before,
// during and after a play; the public Widevine test stream inside the layer; screenshots.
// One summary line: "watch-player-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9471'));
const SHOTS = opt('shots', path.join(os.tmpdir(), 'quartz-player-shots'));
const WIDEVINE = !argv.includes('--no-widevine');
const SHOT_BACK = opt('back-shot', '');   // a shot of the rows after Back, at 1536x800
const TAG = 'quartz-player-e2e-' + process.pid;
const EDGE_STUB = path.join(os.tmpdir(), TAG + '-edge.txt');
// The playing video: a synthetic clip (testsrc2 + a sine tone), never a real recording.
const { CLIP, sendClip } = require('./tests/fixture-clip');
const PLAY_HTML = fs.readFileSync(path.join(__dirname, 'tests', 'drm-fixtures', 'widevine-play.html'), 'utf8');
// drm-castlabs-e2e.js's licence page: Widevine granted, then a junk licence -- a service refusing this build.
const LICENCE_PAGE = `<!doctype html><title>Licence test</title><video id="v"></video><script>
(async () => {
  try {
    const access = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['webm', 'cenc'], videoCapabilities: [{ contentType: 'video/webm; codecs="vp8"' }] }]);
    const keys = await access.createMediaKeys();
    await document.getElementById('v').setMediaKeys(keys);
    const s = keys.createSession();
    s.addEventListener('message', () => { s.update(new Uint8Array([8, 1, 18, 3, 1, 2, 3])).catch(() => {}); });
    await s.generateRequest('webm', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
  } catch (err) { console.log('lic: ' + err.name); }
})();
</script>`;

/* ---- the local servers ----------------------------------------------------------------------- */
function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.keepAliveTimeout = 2000;
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, origin: 'http://127.0.0.1:' + s.address().port }));
  });
}
function sendHtml(res, body, headers) {
  res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}
/** The fixture "service watch page": a playing HTML5 video and every kind of link a service page has. */
function playerPage(name, other, auth, spa) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>
<style>body{margin:0;background:#0d0e10;color:#ddd;font:14px/1.4 "Segoe UI",sans-serif} video{display:block;width:100%;height:calc(100vh - 120px);background:#000;object-fit:contain}
nav{display:flex;gap:16px;padding:14px 20px} a,button{color:#9cc8e0;font:inherit} h1{font-size:16px;margin:12px 20px 0}</style></head>
<body><video id="v" src="/__media/clip.mp4" muted autoplay loop playsinline></video><h1 id="name">${name}</h1>
<nav><a id="next" href="/__p/next">More episodes</a><a id="blank" href="/__p/blank" target="_blank">Go to channel</a>
<a id="away" href="${other}/away">A link to another site</a><button id="pop" onclick="window.open('${auth}/signin','signin','width=480,height=600')">Sign in (popup)</button>
<button id="app" onclick="location.href='disneyplus://open/x'">Open in the app</button></nav>
<script>window.addEventListener('message', (e) => { window.__got = e.data; }); window.addEventListener('keydown', (e) => { window.__lastKey = e.key; });</script>${spa ? SPA_APP : ''}</body></html>`;
}
// ?spa=1 on a YouTube /watch fixture: a stand-in for YouTube's app (its <ytd-app>, its 'yt-navigate' move from one
// video to the next inside the page: yt-navigate-start at once, then the new address and the new video), so the e2e
// can see Lumen's in-place move (watch-player-yt.js move, r64) without real YouTube. A move to an id starting
// "stuck" starts (yt-navigate-start) and then dies on the way: the page stays on the last video, the way a real
// move does when the network drops (Lumen must notice and load the next video the old way, said).
const SPA_APP = `<ytd-app></ytd-app><script>window.__doc = 'doc' + Math.random(); window.__moves = 0;
document.querySelector('ytd-app').addEventListener('yt-navigate', (e) => {
  const ep = e.detail && e.detail.endpoint; const id = ep && ep.watchEndpoint && ep.watchEndpoint.videoId; if (!id) return;
  window.__moves++; window.dispatchEvent(new CustomEvent('yt-navigate-start'));
  if (/^stuck/.test(id)) return;
  setTimeout(() => { history.pushState({}, '', ep.commandMetadata.webCommandMetadata.url); document.getElementById('name').textContent = 'youtube video ' + id;
    const v = document.getElementById('v'); v.src = '/__media/clip.mp4?' + id; const p = v.play(); if (p && p.catch) p.catch(() => 0); }, 60);
});</script>`;
const PLAYER_PATH = /^\/(?:watch$|watch\/player|video\/|play\/|detail\/|movies\/|series\/|__p\/)/;

async function startServers(mock) {
  const other = await listen((req, res) => sendHtml(res, '<!doctype html><title>Another site</title><p>another site</p>'));
  const auth = await listen((req, res) => sendHtml(res, '<!doctype html><title>Sign in</title><body style="font:14px sans-serif;padding:20px"><h2>Sign in</h2>' +
    '<button id="done" onclick="opener && opener.postMessage(\'signed-in\', \'*\'); window.close()">Continue</button></body>'));
  const fronts = {};
  for (const svc of Mock.SERVICES) {
    fronts[svc] = await listen((req, res) => {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
      const p = u.pathname;
      if (p === '/__media/clip.mp4') return sendClip(req, res);
      if (p === '/__p/noframe') return sendHtml(res, '<!doctype html><title>No framing</title><p id="nf">This page refuses to be framed.</p>', { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
      if (p === '/__p/licence') return sendHtml(res, LICENCE_PAGE);
      if (p === '/__p/widevine') return sendHtml(res, PLAY_HTML);
      // A player that gives up without a word (Disney+ in the user's report): /play/<id> straight back to /home.
      if (p === '/play/bounce') return sendHtml(res, '<!doctype html><title>Player</title><p id="pl">Loading the player</p><script>setTimeout(() => history.pushState({}, "", "/home"), 1500)</script>');
      // A player that played, then went home (his own way out of the page): never a refusal.
      if (p === '/play/plays') return sendHtml(res, '<!doctype html><title>Player</title><video id="v" src="/__media/clip.mp4" muted autoplay playsinline></video><script>document.getElementById("v").addEventListener("playing", () => setTimeout(() => history.pushState({}, "", "/home"), 1200), { once: true })</script>');
      if (PLAYER_PATH.test(p)) return sendHtml(res, playerPage(svc + ' ' + (p === '/watch' ? 'video' : p.replace(/^\/(__p\/)?/, '')), other.origin, auth.origin, svc === 'youtube' && p === '/watch' && u.searchParams.get('spa') === '1'));
      // Everything else is the reader's: the mock answers.
      const up = http.request({ host: '127.0.0.1', port: mock.ports[svc], path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + mock.ports[svc] }) }, (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('mock gone'); } });
      req.pipe(up);
    });
  }
  // TMDB's where-to-watch page: provider links go through a click-through redirector (JustWatch's
  // click.justwatch.com in life; /jw on this origin here) to the service's REAL address, which the
  // layer hands over to watch-main before any request leaves (rebased to the fronts from there).
  const tmdb = await listen((req, res) => {
    const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
    if (u.pathname === '/jw') { res.writeHead(302, { Location: u.searchParams.get('r') || '/', 'Cache-Control': 'no-store' }); res.end(); return; }
    sendHtml(res, '<!doctype html><html><head><meta charset="utf-8"><title>Where to watch</title></head><body style="margin:0;padding:20px;background:#fff;color:#111;font:14px/1.5 \'Segoe UI\',sans-serif">' +
      '<h1 id="tm" style="font-size:18px">Where to watch: Test Movie</h1><ul>' +
      '<li><a id="dplus" target="_blank" rel="noopener" href="/jw?r=' + encodeURIComponent('https://www.disneyplus.com/play/tmdb-pick') + '">Disney Plus</a></li>' +
      '<li><a id="elsewhere" target="_blank" rel="noopener" href="/jw?r=' + encodeURIComponent(other.origin + '/netflix') + '">Another service</a></li>' +
      '<li><a id="overview" href="/movie/1">Overview</a></li></ul></body></html>');
  });
  const rebase = [['https://www.themoviedb.org', tmdb.origin]];
  for (const svc of Mock.SERVICES) for (const from of Mock.ORIGINS[svc]) rebase.push([from, fronts[svc].origin]);
  return { other, auth, fronts, tmdb, rebase, close: () => { other.server.close(); auth.server.close(); tmdb.server.close(); for (const f of Object.values(fronts)) f.server.close(); } };
}

/* ---- CDP helpers ------------------------------------------------------------------------------ */
async function targetWhere(q, pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) {
    let list = [];
    try { list = await q.targets(); } catch (e) { list = []; }
    const t = list.find((x) => x.webSocketDebuggerUrl && pred(x));
    if (t) return t;
    await sleep(100);
  }
  return null;
}
async function cdpTo(t) { const c = await new Cdp(t.webSocketDebuggerUrl).open(); await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => 0); return c; }
async function gesture(c, expr) {
  const m = await c.send('Runtime.evaluate', { expression: expr, userGesture: true, awaitPromise: true, returnByValue: true });
  return m && m.result && m.result.result ? m.result.result.value : undefined;
}
async function keyIn(c, key, code, vk, mods) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods || 0 };
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  await c.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}
const ST = 'WatchPlayer._state()';

run('watch-player-e2e', async ({ check, launch, say, profileDir }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  try { fs.unlinkSync(EDGE_STUB); } catch (e) { /* none */ }
  const mock = await Mock.start({ log: () => {} });
  const srv = await startServers(mock);
  const env = (extra) => Object.assign({
    QUARTZ_WATCH_BOOT_GRACE_MS: '0',
    QUARTZ_WATCH_REBASE: JSON.stringify(srv.rebase),
    QUARTZ_EDGE_STUB: EDGE_STUB,
    QUARTZ_WATCH_MIN_FREE_GB: '0',
    QUARTZ_PLAYER_AUTH_HOSTS: '127.0.0.1:' + srv.auth.port,
    QUARTZ_TEST_NO_WINDOW_FULLSCREEN: '1',
    QUARTZ_TEST_VMP: 'signed',
    // (No QUARTZ_TEST_CDM=ready here: the licence-refusal check needs the real castlabs CDM in the profile.)
  }, extra || {});
  const LOG = path.join(profileDir, 'quartz.log');
  const logHas = (re) => { try { return re.test(fs.readFileSync(LOG, 'utf8')); } catch (e) { return false; } };
  const FY = srv.fronts.youtube.origin, FD = srv.fronts.disney.origin;

  try {
    /* ============================ boot A: Widevine ready, signed (stubbed) ============================ */
    let q = await launch({ cdp: CDP_PORT, env: env() });
    const chrome = q.chrome;
    // A window going fullscreen would leave the off-screen spot: the chrome's half is a counter here.
    await chrome.ev('window.__fsCalls = 0; window.toggleFullscreen = function () { window.__fsCalls++; }; 1');
    check(await chrome.ev('typeof window.openInLumen === "function" && !!window.WatchPlayer'), 'window.openInLumen and WatchPlayer exist');
    const wv = await chrome.waitFor('(() => { const s = window.Drm && window.Drm.state(); return s && s.widevine && s.widevine.available ? s.widevine : null; })()', 120000).catch(() => null);
    check(!!wv && wv.services === true, 'Widevine available and (test) signed: protected titles may play here', wv && { available: wv.available, services: wv.services });

    // Watch, with rows from the mock.
    await chrome.ev('openWatchTab(), 1');
    const gt = await targetWhere(q, (x) => /\/watch\.html(\?|#|$)/.test(String(x.url)), 15000);
    const g = await cdpTo(gt);
    // A tile of that service, from the row in focus first (a click on a row that is not in focus
    // brings that row up instead of opening the title, as it would for him).
    const card = (svc) => `([...document.querySelectorAll('#stack .lrow[data-d="0"] *')].find((n) => n._item && n._item.service === '${svc}' && n.offsetParent)
      || [...document.querySelectorAll('*')].find((n) => n._item && n._item.service === '${svc}' && n.offsetParent))`;
    // A real click on a tile the way he does it: when its row is below the lens, the first click brings the
    // row up (watch.js onStackClick) and the second opens the title. Returns where the tile was.
    // kind: only tiles of that kind (resume = Continue watching, which plays on one click)
    const cardK = (svc, kind) => kind ? `([...document.querySelectorAll('#stack .lrow[data-d="0"] *')].find((n) => n._item && n._item.service === '${svc}' && n._item.kind === '${kind}' && n.offsetParent)
      || [...document.querySelectorAll('#stack *')].find((n) => n._item && n._item.service === '${svc}' && n._item.kind === '${kind}' && n.offsetParent))` : card(svc);
    const clickTile = async (page, svc, kind) => {
      const at = await page.ev(`(() => { const c = ${cardK(svc, kind)}; if (!c) return null; const r = c.closest('.lrow'); const f = document.querySelector('#stack > .lrow[data-d="0"]'); const at = { row: r ? r.dataset.key : null, d: r ? r.dataset.d : null, focused: f ? f.dataset.key : null }; c.scrollIntoView({ block: 'nearest' }); c.click(); return at; })()`);
      if (at && at.row && at.d !== '0') {
        await page.waitFor(`(() => { const r = [...document.querySelectorAll('#stack > .lrow')].find((x) => x.dataset.key === ${JSON.stringify(at.row)}); return !!r && r.dataset.d === '0'; })()`, 4000).catch(() => 0);
        await sleep(500);
        await page.ev(`(() => { const c = ${cardK(svc, kind)}; c.scrollIntoView({ block: 'nearest' }); c.click(); return 1; })()`);
      }
      return at;
    };
    await g.waitFor(`!!(${card('youtube')}) && !!(${card('disney')})`, 60000);
    check(await g.ev(`/Plays in Lumen/.test((${card('youtube')}).getAttribute('aria-label') || '')`), 'a YouTube tile says it plays in Lumen');
    const memBefore = await chrome.ev('window.api.watchPlayer.memory()');

    // Move down the rows (Watch's rows are a stack moved by the wheel, not a scrolling page), then
    // open a YouTube title with a real click. "Where he was" = the stack's offset, the row in focus,
    // and any scroll a container has.
    // What he sees: the row in focus, where it sits on screen, how far along it is, any page scroll. (Not
    // the stack's own offset: a row that arrives above his -- Continue watching after a title -- moves
    // the stack by one row while his row stays put; `rows` and `stack` ride along for the detail.)
    const where = `(() => { const st = document.getElementById('stack'); const cur = st && st.querySelector('.lrow[data-d="0"]'); const rt = cur && cur.querySelector('.rt');
      return JSON.stringify([cur ? cur.dataset.key : null, cur ? Math.round(cur.getBoundingClientRect().top) : null, rt ? rt.style.transform : null, document.scrollingElement ? document.scrollingElement.scrollTop : 0, st && st.parentNode ? st.parentNode.scrollTop || 0 : 0]); })()`;
    const stackNow = `(() => { const st = document.getElementById('stack'); return { stack: st ? st.style.transform : null, rows: [...document.querySelectorAll('#stack > .lrow')].map((r) => r.dataset.key) }; })()`;
    // Down to the first row below the top one that has a YouTube tile (the wheel moves one row per turn).
    const ytRow = await g.ev(`(() => { const rows = [...document.querySelectorAll('#stack .lrow')];
      for (let i = 1; i < rows.length; i++) if ([...rows[i].querySelectorAll('*')].some((n) => n._item && n._item.service === 'youtube')) return i; return 0; })()`);
    for (let i = 0; i < ytRow; i++) {
      await g.ev('window.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, cancelable: true })), 1');
      await sleep(600);
    }
    say('rows: moved down to row ' + ytRow + ' (the first below the top with a YouTube tile; 0 = none, the position check is then equality only)');
    const ytTitle = await g.ev(`(${card('youtube')})._item.title`);
    const tabsBefore = await chrome.ev('tabs.length');
    await g.ev(`(() => { const c = ${card('youtube')}; c.scrollIntoView({ block: 'nearest' }); return 1; })()`);
    const scrolled = await g.ev(where);
    const stackBefore = await g.ev(stackNow);
    await g.ev(`(() => { const c = ${card('youtube')}; c.click(); return 1; })()`);
    const s1 = await chrome.waitFor(`(() => { const s = ${ST}; return s.open && s.n === 1 && s.slots[0].wcId !== null ? s : null; })()`, 15000).catch(() => null);
    check(!!s1, 'a click on a YouTube tile opens the player layer', s1 && { title: s1.title, url: s1.slots[0].url });
    check(s1 && s1.title === ytTitle && s1.mark === 'YT' && !s1.edge, 'the bar: the title, the YouTube mark, no Edge button', s1 && { title: s1.title, mark: s1.mark, edge: s1.edge });
    check(s1 && s1.slots[0].url.indexOf(FY + '/watch?v=') === 0, 'YouTube plays its FULL watch page in the layer (not the embed)', s1 && s1.slots[0].url);
    check((await chrome.ev('tabs.length')) === tabsBefore, 'no new tab was opened');
    const box = await chrome.ev('(() => { const a = document.querySelector(".wp-layer").getBoundingClientRect(); const b = findWatchTab().viewEl.getBoundingClientRect(); return [Math.round(a.left - b.left), Math.round(a.top - b.top), Math.round(a.width - b.width), Math.round(a.height - b.height)]; })()');
    check(box.every((n) => Math.abs(n) <= 1), 'the layer covers the Watch tab exactly', box);
    const wc1 = s1 && s1.slots[0].wcId;
    check(wc1 && (await chrome.ev(`window.api.watchPlayer.alive(${wc1}).then((r) => r.alive)`)), 'main adopted a live player webContents');
    let pt = await targetWhere(q, (x) => String(x.url).indexOf(FY + '/watch?v=') === 0, 10000);
    let p = await cdpTo(pt);
    await p.waitFor('(() => { const v = document.getElementById("v"); return v && !v.paused && v.currentTime > 0.3; })()', 20000).catch(() => 0);
    const memPlaying = await chrome.ev('window.api.watchPlayer.memory()');
    check(await p.ev('(() => { const v = document.getElementById("v"); return !!v && !v.paused && v.readyState >= 2; })()'), 'the fixture video plays inside the layer');
    // The page inside gets the whole tile: its viewport is the webview's box (no letterbox of the guest).
    const gbox = await chrome.ev('(() => { const v = document.querySelector(".wp-layer webview"); if (!v) return null; const r = v.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()');
    const gview = await p.ev('[innerWidth, innerHeight]');
    check(!!gbox && Math.abs(gbox[0] - gview[0]) <= 1 && Math.abs(gbox[1] - gview[1]) <= 1, 'the page inside the layer is the size of its tile', { webview: gbox, page: gview });

    // Shots of the layer open (dark, then light), at 1920x1000 and 1280x800.
    const shoot = async (name, w, h) => {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await sleep(900);
      try { await chrome.shot(path.join(SHOTS, 'lumen-player-' + name + '.png')); } catch (e) { say('shot ' + name + ' failed: ' + e.message); }
      await chrome.send('Emulation.clearDeviceMetricsOverride');
      await sleep(300);
    };
    // The window's real size first: an emulated size resizes the chrome but not the page inside a
    // <webview> (its own widget), so only this shot shows the guest exactly as he would see it.
    await sleep(600);
    try { await chrome.shot(path.join(SHOTS, 'lumen-player-dark-actual.png')); } catch (e) { say('shot dark-actual failed: ' + e.message); }
    await shoot('dark-1920x1000', 1920, 1000);
    await shoot('dark-1280x800', 1280, 800);
    const themeWas = await chrome.ev('document.documentElement.getAttribute("data-theme") || "dark"');
    await chrome.ev('window.Settings && window.Settings.set({ siteTheme: "light" }), document.documentElement.setAttribute("data-theme", "light"), 1');
    await sleep(500);
    await shoot('light-1920x1000', 1920, 1000);
    await shoot('light-1280x800', 1280, 800);
    await chrome.ev(`window.Settings && window.Settings.set({ siteTheme: "system" }), document.documentElement.setAttribute("data-theme", ${JSON.stringify(themeWas)}), 1`);

    // In-layer navigation: a link, then a target=_blank link; both stay in this layer, in place.
    await gesture(p, 'document.getElementById("next").click(), 1');   // a real click: without a user gesture Chromium marks the page left behind skippable for Back
    await chrome.waitFor(`${ST}.slots[0].url === ${JSON.stringify(FY + '/__p/next')}`, 10000).catch(() => 0);
    check((await chrome.ev(ST)).slots[0].url === FY + '/__p/next', 'a link to another page of the service stays in the layer');
    pt = await targetWhere(q, (x) => String(x.url) === FY + '/__p/next', 8000); p = await cdpTo(pt);
    await gesture(p, 'document.getElementById("blank").click(), 1');
    await chrome.waitFor(`${ST}.slots[0].url === ${JSON.stringify(FY + '/__p/blank')}`, 10000).catch(() => 0);
    const s2 = await chrome.ev(ST);
    check(s2.slots[0].url === FY + '/__p/blank' && s2.n === 1 && (await chrome.ev('tabs.length')) === tabsBefore, 'a target=_blank link on the service loads in place in the layer (no tab)', s2.slots[0].url);
    pt = await targetWhere(q, (x) => String(x.url) === FY + '/__p/blank', 8000); p = await cdpTo(pt);

    // A sign-in popup: a sheet inside the layer, window.opener kept, closes itself.
    await gesture(p, 'document.getElementById("pop").click(), 1');
    const sh = await chrome.waitFor(`(() => { const s = ${ST}; return s.sheet && s.sheet.shown ? s.sheet : null; })()`, 10000).catch(() => null);
    check(!!sh && /127\.0\.0\.1/.test(sh.host), 'a sign-in popup opens as a sheet in the layer', sh);
    const at = await targetWhere(q, (x) => String(x.url).indexOf(srv.auth.origin + '/signin') === 0, 8000);
    if (at) {
      const a = await cdpTo(at);
      await gesture(a, 'document.getElementById("done").click(), 1').catch(() => 0);
      a.close();
    }
    await chrome.waitFor(`!${ST}.sheet`, 8000).catch(() => 0);
    check(!(await chrome.ev(ST)).sheet && (await p.ev('window.__got')) === 'signed-in', 'the sheet posted back to its opener and closed itself', { got: await p.ev('window.__got') });
    check(logHas(/player: a sign-in popup opened as a sheet/), 'quartz.log: the sheet has its line');

    // An app link: stopped, said in the bar, logged; the page stays.
    await gesture(p, 'document.getElementById("app").click(), 1');
    await chrome.waitFor(`/tried to open an app/.test(${ST}.note)`, 6000).catch(() => 0);
    check(/tried to open an app \(disneyplus:\)/.test((await chrome.ev(ST)).note) && (await chrome.ev(ST)).slots[0].url === FY + '/__p/blank', 'an app link (disneyplus://) is stopped and said in the bar', (await chrome.ev(ST)).note);
    check(logHas(/stopped an app link \(disneyplus:\)/), 'quartz.log: the app link has its line');

    // Fullscreen: in, the layer fills the window; Esc leaves fullscreen and keeps the layer; Esc closes.
    const fsIn = await gesture(p, 'document.getElementById("v").requestFullscreen().then(() => 1, (e) => String(e))');
    const f1 = await chrome.waitFor(`(() => { const s = ${ST}; return s.fs ? s : null; })()`, 6000).catch(() => null);
    const fill = await chrome.ev('(() => { const r = document.querySelector(".wp-layer").getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), innerWidth, innerHeight, document.body.classList.contains("page-fullscreen"), window.__fsCalls]; })()');
    check(!!f1 && fill[0] === fill[2] && fill[1] === fill[3] && fill[4] === true, 'the video\'s fullscreen fills the window (the chrome steps aside)', { fsIn, fill });
    await keyIn(p, 'Escape', 'Escape', 27);
    await chrome.waitFor(`!${ST}.fs`, 6000).catch(() => 0);
    await sleep(700);
    const f2 = await chrome.ev(ST);
    check(!f2.fs && f2.open, 'Esc #1 leaves fullscreen and keeps the layer', { fs: f2.fs, open: f2.open });
    check(!(await chrome.ev('document.body.classList.contains("page-fullscreen")')), 'back in the layer, the chrome is back');

    // Back walks the layer's history: blank -> next -> video, then Alt+Left / the mouse back button.
    await chrome.ev('document.querySelector(".wp-layer .wp-back").click(), 1');
    await chrome.waitFor(`${ST}.slots[0].url === ${JSON.stringify(FY + '/__p/next')}`, 8000).catch(() => 0);
    check((await chrome.ev(ST)).slots[0].url === FY + '/__p/next', 'Back (the bar) walks the layer\'s own history first');
    pt = await targetWhere(q, (x) => String(x.url) === FY + '/__p/next', 8000); p = await cdpTo(pt);
    await keyIn(p, 'ArrowLeft', 'ArrowLeft', 37, 1);
    await chrome.waitFor(`(() => { const s = ${ST}; return !!s.slots[0] && s.slots[0].url.indexOf(${JSON.stringify(FY + '/watch?v=')}) === 0; })()`, 8000).catch(() => 0);
    await sleep(500);   // a second Back from the same press would close the layer by now
    const ak = await chrome.ev(ST);
    check(ak.open && !!ak.slots[0] && ak.slots[0].url.indexOf(FY + '/watch?v=') === 0, 'Alt+Left inside the page is Back too (one Back, the layer stays)', { open: ak.open, url: ak.slots[0] && ak.slots[0].url, backs: ak.backs, closed: ak.lastClosed });
    if (!ak.open) {
      await chrome.ev(`openInLumen(${JSON.stringify(FY + '/watch?v=hiLockupB02')}, { service: 'youtube', title: 'Again' }), 1`);
      await chrome.waitFor(`(() => { const s = ${ST}; return s.open && s.slots[0] && s.slots[0].wcId !== null; })()`, 8000).catch(() => 0);
    }
    // The media key: play/pause on the playing video.
    // (When Alt+Left failed above, the player is still on a fixture page with the same video: carry on there.)
    pt = await targetWhere(q, (x) => String(x.url).indexOf(FY + '/watch?v=') === 0, 8000)
      || await targetWhere(q, (x) => String(x.url) === FY + '/__p/next', 2000);
    if (!pt) throw new Error('the player page is gone after Back (no target on ' + FY + ')');
    p = await cdpTo(pt);
    await p.waitFor('(() => { const v = document.getElementById("v"); return v && !v.paused; })()', 10000).catch(() => 0);
    // A media key sent over CDP reaches neither the page nor Electron's before-input-event (seen
    // 10-17: no command, no keydown), so the KEY itself is not verifiable here. When it does not
    // arrive, the command main would send drives the chrome's half, and the run says so.
    await keyIn(p, 'MediaPlayPause', 'MediaPlayPause', 0xB3);
    await sleep(600);
    const viaKey = !!(await chrome.ev(ST + '.lastCommand'));
    if (!viaKey) {
      say('media key: CDP could not deliver it (no command, page saw ' + JSON.stringify(await p.ev('window.__lastKey || ""')) + '); driving the command main sends instead -- the physical key is NOT verified');
      await chrome.ev('WatchPlayer.media("key-MediaPlayPause"), 1');
      await sleep(600);
    }
    check(await p.ev('document.getElementById("v").paused'), 'the play/pause media command pauses the player' + (viaKey ? ' (the key)' : ' (command only)'), { media: await chrome.ev(ST + '.lastMedia'), command: await chrome.ev(ST + '.lastCommand') });
    if (viaKey) await keyIn(p, 'MediaPlayPause', 'MediaPlayPause', 0xB3); else await chrome.ev('WatchPlayer.media("key-MediaPlayPause"), 1');
    await sleep(600);
    check(await p.ev('!document.getElementById("v").paused'), 'and plays it again');
    // The mouse back button over the bar: at the first page, Back closes.
    const bb = await chrome.ev('(() => { const r = document.querySelector(".wp-layer .wp-title").getBoundingClientRect(); return [r.left + 4, r.top + r.height / 2]; })()');
    await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bb[0], y: bb[1], button: 'back', buttons: 8, clickCount: 1 });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bb[0], y: bb[1], button: 'back', buttons: 0, clickCount: 1 });
    await chrome.waitFor(`!${ST}.open`, 6000).catch(() => 0);
    const c1 = await chrome.ev(ST);
    check(!c1.open, 'the mouse back button at the first page closes the layer', c1.lastClosed);

    // After close: the view is gone, the scroll position is where he left it, the re-read fired.
    await sleep(1500);
    check(!(await chrome.ev(`window.api.watchPlayer.alive(${wc1}).then((r) => r.alive)`)), 'the player\'s webContents is destroyed on close');
    check(!(await targetWhere(q, (x) => String(x.url).indexOf(FY + '/') === 0 && x.type !== 'page', 1500)), 'no player target is left');
    const scrollNow = await g.ev(where);
    const asked = await chrome.waitFor(`(() => { const c = ${ST}.lastClosed; return c && c.asked ? c.asked : null; })()`, 5000).catch(() => null);
    check(Array.isArray(asked) && asked.indexOf('youtube') !== -1 && logHas(/re-reading youtube after watching/), 'closing asks Watch to re-read YouTube (fresh after watching)', asked);
    await sleep(2500);
    // Once more after the re-read has landed (it may add a row above his): still where he was, with no slide.
    const scrollLate = await g.ev(where);
    const stackLate = await g.ev(stackNow);
    check((ytRow === 0 || (!!stackBefore.stack && /translateY\(calc\(-\d/.test(stackBefore.stack))) && scrollNow === scrolled && scrollLate === scrolled,
      'Back returns to the rows where he was (the same row, at the same place on screen, as far along)', { before: scrolled, after: scrollNow, late: scrollLate, stack: [stackBefore, stackLate] });
    if (SHOT_BACK) {
      // The Watch page itself at 1536x800 (an emulated size on the chrome never reaches a <webview> guest):
      // its view grown to that size for the shot, the page emulated to it, then both put back.
      await chrome.ev('(() => { const v = findWatchTab().viewEl; v.dataset.e2eStyle = v.getAttribute("style") || ""; const s = v.style; s.setProperty("position", "fixed", "important"); s.setProperty("left", "0px", "important"); s.setProperty("top", "0px", "important"); s.setProperty("width", "1536px", "important"); s.setProperty("height", "800px", "important"); s.setProperty("z-index", "2147483647", "important"); return 1; })()').catch(() => 0);
      await g.send('Emulation.setDeviceMetricsOverride', { width: 1536, height: 800, deviceScaleFactor: 1, mobile: false });
      await sleep(900);
      try { await g.shot(SHOT_BACK); say('shot ' + SHOT_BACK); } catch (e) { say('shot back-to-rows failed: ' + e.message); }
      await g.send('Emulation.clearDeviceMetricsOverride');
      await chrome.ev('(() => { const v = findWatchTab().viewEl; v.setAttribute("style", v.dataset.e2eStyle || ""); delete v.dataset.e2eStyle; return 1; })()').catch(() => 0);
      await sleep(400);
    }
    const memAfter = await chrome.ev('window.api.watchPlayer.memory()');
    say('RAM (all Quartz processes, working set): before ' + memBefore.totalMb + ' MB / ' + memBefore.processes + ' procs; playing ' + memPlaying.totalMb + ' MB / ' + memPlaying.processes + ' procs (player ' + JSON.stringify(memPlaying.players) + '); after close ' + memAfter.totalMb + ' MB / ' + memAfter.processes + ' procs');
    check(memAfter.processes < memPlaying.processes && memAfter.totalMb < memPlaying.totalMb, 'closing frees the player\'s memory', { before: memBefore.totalMb, playing: memPlaying.totalMb, after: memAfter.totalMb });

    // r64: a YouTube title opened while a YouTube watch page plays (Up next's Play now) moves the page IN PLACE
    // (YouTube's own in-page move: no new document, no reload of YouTube's app); a page that can't (no YouTube app
    // on it) loads the old way, and Lumen keeps the reason. Its own title; the layer closed after.
    {
      const MV = '(window.WatchPlayerYT && WatchPlayerYT._state().lastMove) || null';
      const plays = (pg) => pg.waitFor('(() => { const v = document.getElementById("v"); return v && !v.paused && v.currentTime > 0 ? 1 : 0; })()', 10000).then(() => true, () => false);
      const pageNow = (pg) => pg.ev('[window.__doc || "", window.__moves || 0, location.search]').catch(() => null);
      await chrome.ev(`openInLumen(${JSON.stringify(FY + '/watch?v=spaVideoA1&spa=1')}, { service: 'youtube', title: 'Move A' }), 1`);
      let mt = await targetWhere(q, (x) => String(x.url).indexOf(FY + '/watch?v=spaVideoA1') === 0, 10000);
      let mp = mt ? await cdpTo(mt) : null;
      const okA = !!mp && await plays(mp);
      check(okA, 'move: the stand-in YouTube app page plays in the layer');
      if (okA) {
        const doc0 = await mp.ev('window.__doc');
        const wc0 = (await chrome.ev(ST)).slots[0].wcId;
        // Every text the layer's note shows from here on (a later note, the play view's, may replace a fallback's).
        await chrome.ev('(() => { const el = document.querySelector(".wp-layer .wp-note"); window.__e2eNotes = []; if (window.__e2eNoteObs) window.__e2eNoteObs.disconnect(); window.__e2eNoteObs = new MutationObserver(() => { if (el.textContent) window.__e2eNotes.push(el.textContent); }); window.__e2eNoteObs.observe(el, { childList: true, characterData: true, subtree: true }); return 1; })()');
        await chrome.ev(`openInLumen(${JSON.stringify(FY + '/watch?v=spaVideoB2')}, { service: 'youtube', title: 'Move B' }), 1`);
        const st = await chrome.waitFor(`(() => { const s = ${ST}; return s.slots[0] && s.slots[0].url.indexOf('spaVideoB2') !== -1 ? s : null; })()`, 6000).catch(() => null);
        // Its own move's record: the page's answer comes after the open, and the landing after that.
        const mv = await chrome.waitFor(`(() => { const m = ${MV}; return m && m.id === 'spaVideoB2' && (m.how !== 'in-page' || m.landed) ? m : null; })()`, 6000).catch(() => null) || await chrome.ev(MV);
        check(!!mv && mv.how === 'in-page' && mv.id === 'spaVideoB2' && mv.landed === true, 'move: Up next to another YouTube video moves the page in place (no reload), and it lands', mv);
        const pg = await pageNow(mp);
        check(!!st && st.slots[0].wcId === wc0 && !!pg && pg[0] === doc0 && pg[1] === 1 && /spaVideoB2/.test(pg[2]), 'move: the same page and document, now on the next video', { slot: st && { url: st.slots[0].url, wcId: st.slots[0].wcId }, wc0, page: pg, doc0 });
        check(await plays(mp), 'move: the next video plays');
        const notes0 = await chrome.ev('window.__e2eNotes.slice()');
        check(!notes0.some((t) => /the slow way/.test(t)), 'move: an in-place move shows no fallback note', notes0);
        // A move YouTube starts but never lands (the stand-in's "stuck" id: yt-navigate-start, then nothing): after
        // the landing check (4 s) the slot loads the next video the old way, keeps the reason and says it in the bar.
        await chrome.ev(`openInLumen(${JSON.stringify(FY + '/watch?v=stuckVideoD4')}, { service: 'youtube', title: 'Move D' }), 1`);
        const mvT = await chrome.waitFor(`(() => { const m = ${MV}; return m && m.id === 'stuckVideoD4' && m.how === 'in-page' ? m : null; })()`, 3000).catch(() => null);
        const pgT = await pageNow(mp);
        check(!!mvT && !!pgT && pgT[0] === doc0 && pgT[1] === 2 && /spaVideoB2/.test(pgT[2]), 'move: a move the page starts but never finishes: taken, the page still on the last video', { mv: mvT, page: pgT });
        const mvD = await chrome.waitFor(`(() => { const m = ${MV}; return m && m.id === 'stuckVideoD4' && m.how === 'reload' ? m : null; })()`, 8000).catch(() => null) || await chrome.ev(MV);
        check(!!mvD && mvD.how === 'reload' && mvD.why === 'YouTube started the move but stayed on the last video' && mvD.ms >= 3900, 'move: it never lands: the slot loads the next video the old way after the landing check, and keeps why', mvD);
        const mtD = await targetWhere(q, (x) => String(x.url).indexOf(FY + '/watch?v=stuckVideoD4') === 0, 10000);
        const notesD = await chrome.ev('window.__e2eNotes.slice()');
        check(!!mtD && notesD.indexOf('Loading the next video the slow way: YouTube started the move but stayed on the last video') !== -1, 'move: that fallback is said in the layer\'s bar, with its reason', { loaded: !!mtD, notes: notesD });
        // The fallback: a page with no YouTube app (the plain fixture) loads the old way, and says why.
        await chrome.ev(`openInLumen(${JSON.stringify(FY + '/watch?v=hiLockupB02')}, { service: 'youtube', title: 'Plain' }), 1`);
        mt = await targetWhere(q, (x) => String(x.url).indexOf(FY + '/watch?v=hiLockupB02') === 0, 10000);
        mp = mt ? await cdpTo(mt) : null;
        if (mp) await plays(mp);
        await chrome.ev(`openInLumen(${JSON.stringify(FY + '/watch?v=plainVideoC3')}, { service: 'youtube', title: 'Plain C' }), 1`);
        const mt2 = await targetWhere(q, (x) => String(x.url).indexOf(FY + '/watch?v=plainVideoC3') === 0, 10000);
        const mv2 = await chrome.ev(MV);
        check(!!mt2 && !!mv2 && mv2.how === 'reload' && /no YouTube app/.test(mv2.why || '') && mv2.id === 'plainVideoC3', 'move: a page without YouTube\'s app loads the next video the old way, and the reason is kept', mv2);
        const notes2 = await chrome.ev('window.__e2eNotes.slice()');
        check(notes2.indexOf('Loading the next video the slow way: no YouTube app on the page') !== -1, 'move: that fallback is said in the bar too', notes2);
      }
      await chrome.ev('(() => { if (window.__e2eNoteObs) window.__e2eNoteObs.disconnect(); window.__e2eNoteObs = null; return 1; })()').catch(() => 0);
      await chrome.ev('WatchPlayer.close("e2e"), 1').catch(() => 0);
      await sleep(900);
    }
    // r62-playview regression: Try again left the tile blank. showState('failed') puts `has-state` on the tile
    // (that class hides the .wp-view, watch-player.css), and its Try again hid the state box but left the class:
    // the page reloaded fine behind a tile that stayed empty. The failure here is a did-fail-load event sent to
    // the tile's <webview> itself (the same DOM event the guest sends, with isMainFrame and an error code): the
    // bug is in the button, not in how the load failed, and a real refused load or a crash costs a renderer.
    // (Each block below opens its own title and leaves the layer closed, as the mouse's Back above did.)
    const tileOf = '(() => { const t = document.querySelector(".wp-layer .wp-tile"); const v = t && t.querySelector(".wp-view"); const r = t && t.getBoundingClientRect(); return t ? { state: t.classList.contains("has-state"), vis: v ? getComputedStyle(v).visibility : null, w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(t).display } : null; })()';
    await chrome.ev(`openInLumen(${JSON.stringify(FY + '/__p/fsclose')}, { service: 'youtube', title: 'Fullscreen close' }), 1`);
    await chrome.waitFor(`(() => { const s = ${ST}; return s.open && s.slots[0] && s.slots[0].wcId !== null; })()`, 10000).catch(() => 0);
    pt = await targetWhere(q, (x) => String(x.url) === FY + '/__p/fsclose', 10000); p = await cdpTo(pt);
    await p.waitFor('(() => { const v = document.getElementById("v"); return v && v.readyState >= 2; })()', 15000).catch(() => 0);
    await chrome.ev('(() => { const v = document.querySelector(".wp-layer .wp-view"); const e = new Event("did-fail-load"); Object.assign(e, { isMainFrame: true, errorCode: -105, errorDescription: "ERR_NAME_NOT_RESOLVED", validatedURL: v.src }); v.dispatchEvent(e); return 1; })()');
    const fl = await chrome.waitFor(`(() => { const s = ${ST}.slots[0]; return s && s.state === 'failed' ? s : null; })()`, 4000).catch(() => null);
    check(!!fl && /didn’t load/.test(fl.stateText) && /Try again/.test(fl.stateText) && (await chrome.ev(tileOf)).state, 'a page that did not load shows the failed state with Try again (and the tile has-state)', fl && fl.stateText);
    await chrome.ev('(() => { const b = [...document.querySelectorAll(".wp-layer .wp-state .wp-btn")].find((x) => x.textContent === "Try again"); if (b) b.click(); return !!b; })()');
    await sleep(1500);
    const ta = await chrome.ev(tileOf);
    check(!!ta && !ta.state && ta.vis === 'visible' && (await chrome.ev(ST)).slots[0].state === '', 'Try again: the state goes AND the page shows again (no has-state left hiding the view)', ta);

    // r62-playview regression: a close FROM the video's fullscreen left L.fsSlot and .wp-fs on the layer (its
    // leave-html-full-screen never comes once the view is gone), so the NEXT title opened as a black, bar-less,
    // window-filling layer and Esc did nothing. Close the way he hit it: the mouse's Back at the first page.
    pt = await targetWhere(q, (x) => String(x.url) === FY + '/__p/fsclose', 8000); p = await cdpTo(pt);
    await p.waitFor('!!document.getElementById("v")', 8000).catch(() => 0);
    const fsIn2 = await gesture(p, 'document.getElementById("v").requestFullscreen().then(() => 1, (e) => String(e))');
    const fz = await chrome.waitFor(`(() => { const s = ${ST}; return s.fs ? s : null; })()`, 6000).catch(() => null);
    const tBack = await chrome.ev('Date.now()');
    await chrome.ev('WatchPlayer.back("mouse"), 1');
    await chrome.waitFor(`!${ST}.open`, 6000).catch(() => 0);
    check(!!fz && !(await chrome.ev(ST)).open, 'in the video\'s fullscreen, the mouse\'s Back at the first page closes the layer', { fsIn: fsIn2, fs: !!fz, closed: (await chrome.ev(ST)).lastClosed });
    // ...and the slot's fullscreen went the one way out (leaveFs: the page's fullscreen, the tile, the layer, Esc's grace).
    const leftAt = (await chrome.ev(ST)).fsLeftAt;
    check(leftAt >= tBack, 'the close from fullscreen leaves it the one way (leaveFs ran with the slot\'s destroy)', { leftAt, tBack });
    await sleep(800);
    await chrome.ev(`openInLumen(${JSON.stringify(FY + '/__p/fsafter')}, { service: 'youtube', title: 'After fullscreen' }), 1`);
    await chrome.waitFor(`(() => { const s = ${ST}; return s.open && s.slots[0] && s.slots[0].wcId !== null; })()`, 10000).catch(() => 0);
    await sleep(800);
    const af = await chrome.ev(`(() => { const s = ${ST}; return { wpFs: document.querySelector(".wp-layer").classList.contains("wp-fs"), fs: s.fs, chromeFs: document.body.classList.contains("page-fullscreen"), tile: ${tileOf} }; })()`);
    check(!af.wpFs && !af.fs && !af.chromeFs, 'the next title after a close from fullscreen opens out of fullscreen (no .wp-fs, no fsSlot, the chrome back)', af);
    check(!!af.tile && af.tile.w > 0 && af.tile.h > 0 && af.tile.display !== 'none' && af.tile.vis === 'visible', 'and its tile is on screen (not a black window-filling layer)', af.tile);
    const escTook = await chrome.ev('WatchPlayer.handleShortcut("escape")');
    await chrome.waitFor(`!${ST}.open`, 4000).catch(() => 0);
    check(escTook === true && !(await chrome.ev(ST)).open, 'and Esc closes it (no stale fullscreen swallowing the press)', { escTook, closed: (await chrome.ev(ST)).lastClosed });

    // A link to another site: a PAGE in the layer (a sheet), not a tab. The sheet's "Open in a tab" is
    // his way to a normal tab (counted in the leak log), and the layer waits behind the Watch tab.
    await chrome.ev(`openInLumen(${JSON.stringify(FY + '/__p/away-test')}, { service: 'youtube', title: 'Away test' }), 1`);
    pt = await targetWhere(q, (x) => String(x.url) === FY + '/__p/away-test', 10000); p = await cdpTo(pt);
    const nTabs = await chrome.ev('tabs.length');
    await gesture(p, 'document.getElementById("away").click(), 1');
    const awaySheet = await chrome.waitFor(`(() => { const s = ${ST}; return s.sheet && s.sheet.kind === 'page' && s.sheet.shown ? s.sheet : null; })()`, 8000).catch(() => null);
    check(!!awaySheet && (await chrome.ev('tabs.length')) === nTabs, 'a link to another site opens as a page in the layer, not a tab', awaySheet);
    check(logHas(/a page from another site opened in the layer \(link to another site\): 127\.0\.0\.1:\d+/), 'quartz.log: the page sheet has its line');
    await chrome.ev('document.querySelector(".wp-sheet-tab").click(), 1');
    await chrome.waitFor(`tabs.length === ${nTabs + 1}`, 8000).catch(() => 0);
    check((await chrome.ev(`tabs.length === ${nTabs + 1} && tabs.some((t) => String(t.url).indexOf(${JSON.stringify(srv.other.origin + '/away')}) === 0)`)), 'the page\'s "Open in a tab" opens it in a normal Quartz tab');
    check(logHas(/left the layer \(Open in a tab, from a page in the layer\): 127\.0\.0\.1:\d+/), 'quartz.log: the way out has its line');
    check((await chrome.ev(ST)).open && (await chrome.ev(ST)).hidden, 'the layer stays open behind the Watch tab (hidden while another tab is in front)');
    await chrome.ev('activateTab(findWatchTab().id), 1');
    await sleep(400);
    check(!(await chrome.ev(ST)).hidden, 'back on the Watch tab, the layer is on screen again');

    // One player at a time: a Disney+ title replaces the YouTube one, and its view is destroyed.
    const wcA = (await chrome.ev(ST)).slots[0].wcId;
    await chrome.ev(`openInLumen(${JSON.stringify(FD + '/__p/noframe')}, { service: 'disney', title: 'No framing' }), 1`);
    await chrome.waitFor(`(() => { const s = ${ST}; return s.n === 1 && s.slots[0].service === 'disney' && s.slots[0].wcId !== null; })()`, 10000).catch(() => 0);
    await sleep(800);
    const s3 = await chrome.ev(ST);
    check(s3.n === 1 && !(await chrome.ev(`window.api.watchPlayer.alive(${wcA}).then((r) => r.alive)`)), 'one player at a time: the old view is destroyed when another title opens', { n: s3.n, old: wcA });
    pt = await targetWhere(q, (x) => String(x.url) === FD + '/__p/noframe', 8000);
    const nf = pt ? await cdpTo(pt) : null;
    check(!!nf && (await nf.ev('!!document.getElementById("nf")')), 'a page that refuses framing (X-Frame-Options DENY, frame-ancestors none) plays in the layer');
    check(s3.edge && s3.mark === 'D+', 'a Disney+ page: the D+ mark and an Open in Edge button', { edge: s3.edge, mark: s3.mark });

    // A licence refusal inside the layer: the refused state, with Open in Edge (the stub).
    await chrome.ev(`openInLumen(${JSON.stringify(FD + '/__p/licence')}, { service: 'disney', title: 'Licence test' }), 1`);
    const rf = await chrome.waitFor(`(() => { const s = ${ST}; return s.slots[0] && s.slots[0].state === 'refused' ? s.slots[0] : null; })()`, 25000).catch(() => null);
    check(!!rf && /refused to license/.test(rf.stateText) && /Open in Edge/.test(rf.stateText), 'a licence refusal shows the refused state with Open in Edge', rf && rf.stateText);
    if (rf) {
      await chrome.ev('[...document.querySelectorAll(".wp-state .wp-btn")].find((b) => b.textContent === "Open in Edge").click(), 1');
      await sleep(1200);
      let stub = ''; try { stub = fs.readFileSync(EDGE_STUB, 'utf8'); } catch (e) { stub = ''; }
      check(stub.indexOf(FD + '/__p/licence') !== -1, 'its Open in Edge goes to Edge (the stub), never launched for real');
      check(logHas(/left the layer \(Open in Edge: licence refused\)/), 'quartz.log: the Edge way out has its line');
    }
    if ((await chrome.ev(ST)).open) await chrome.ev('WatchPlayer.close("e2e"), 1');

    // Disney+'s player going straight back to its home page, nothing on screen (the user's report, 11-06): Lumen says so.
    await chrome.ev(`openInLumen(${JSON.stringify(FD + '/play/bounce')}, { service: 'disney', title: 'Bounce test' }), 1`);
    const bo = await chrome.waitFor(`(() => { const s = ${ST}; return s.slots[0] && s.slots[0].state === 'refused' ? s.slots[0] : null; })()`, 15000).catch(() => null);
    check(!!bo && /went back to its home page instead of playing/.test(bo.stateText) && /Open in Edge/.test(bo.stateText) && /Back to Disney\+/.test(bo.stateText) && bo.bounced === FD + '/play/bounce',
      'a player that goes back to the home page without playing shows why, with Open in Edge and Back to Disney+', bo && { text: bo.stateText, url: bo.url, bounced: bo.bounced });
    check(logHas(/Lumen player: Disney\+ went back to its home page instead of playing/), 'quartz.log: the player going back has its line');
    if (bo) {
      await chrome.ev('[...document.querySelectorAll(".wp-state .wp-btn")].find((b) => b.textContent === "Open in Edge").click(), 1');
      await sleep(1200);
      let stub = ''; try { stub = fs.readFileSync(EDGE_STUB, 'utf8'); } catch (e) { stub = ''; }
      check(stub.indexOf(FD + '/play/bounce') !== -1, 'its Open in Edge sends the player address, not the home page it landed on');
    }
    if ((await chrome.ev(ST)).open) await chrome.ev('WatchPlayer.close("e2e"), 1');
    await chrome.ev(`openInLumen(${JSON.stringify(FD + '/play/plays')}, { service: 'disney', title: 'Plays test' }), 1`);
    const pw = await chrome.waitFor(`(() => { const s = ${ST}; return s.slots[0] && String(s.slots[0].url).endsWith("/home") ? s.slots[0] : null; })()`, 15000).catch(() => null);
    await sleep(600);
    const pw2 = (await chrome.ev(ST)).slots[0];
    // (A regex literal with an escaped slash inside this template literal loses its backslash and turns the rest into a comment.)
    check(!!pw && pw2 && pw2.state === '' && !pw2.bounced, 'a player that played and then went home is not a refusal', pw2 && { url: pw2.url, state: pw2.state, text: pw2.stateText });
    if ((await chrome.ev(ST)).open) await chrome.ev('WatchPlayer.close("e2e"), 1');

    // TMDB's where-to-watch page: in the layer (the TMDB guide), not a tab; its Disney Plus link,
    // through the redirector, hands over to Disney+'s own page in the layer; another service, a tab.
    const TMDB_URL = 'https://www.themoviedb.org/movie/1/watch';
    const openTmdb = (gc) => gc.ev(`console.log("quartz-watch:open " + JSON.stringify({ url: ${JSON.stringify(TMDB_URL)} })), 1`);
    const tTabs = await chrome.ev('tabs.length');
    await openTmdb(g);
    const tm = await chrome.waitFor(`(() => { const s = ${ST}; return s.open && s.n === 1 && s.slots[0].service === 'tmdb' && s.slots[0].wcId !== null ? s : null; })()`, 10000).catch(() => null);
    check(!!tm && tm.slots[0].url === srv.tmdb.origin + '/movie/1/watch' && (await chrome.ev('tabs.length')) === tTabs, 'a TMDB where-to-watch page opens in the layer, not a tab', tm && { url: tm.slots[0].url, mark: tm.mark });
    check(logHas(/TMDB where-to-watch page opened in the player layer: themoviedb\.org/), 'quartz.log: the TMDB page has its line');
    pt = await targetWhere(q, (x) => String(x.url) === srv.tmdb.origin + '/movie/1/watch', 8000);
    const tp = pt ? await cdpTo(pt) : null;
    if (tp) {
      await tp.waitFor('!!document.getElementById("dplus")', 8000).catch(() => 0);
      await sleep(500);
      try { await chrome.shot(path.join(SHOTS, 'lumen-player-tmdb-actual.png')); } catch (e) { say('shot tmdb failed: ' + e.message); }
      await gesture(tp, 'document.getElementById("dplus").click(), 1');
      const hd = await chrome.waitFor(`(() => { const s = ${ST}; return s.n === 1 && s.slots[0].service === 'disney' && s.slots[0].wcId !== null ? s : null; })()`, 10000).catch(() => null);
      check(!!hd && hd.slots[0].url === FD + '/play/tmdb-pick' && hd.mark === 'D+' && (await chrome.ev('tabs.length')) === tTabs, 'its Disney Plus link hands over: Disney+\'s own page in the layer, no tab', hd && { url: hd.slots[0].url, mark: hd.mark });
      check(logHas(/a where-to-watch link opened Disney\+ in the layer: www\.disneyplus\.com/), 'quartz.log: the handover has its line');
      tp.close();
      await openTmdb(g);
      await chrome.waitFor(`(() => { const s = ${ST}; return s.n === 1 && s.slots[0].service === 'tmdb' && s.slots[0].wcId !== null; })()`, 10000).catch(() => 0);
      pt = await targetWhere(q, (x) => String(x.url) === srv.tmdb.origin + '/movie/1/watch', 8000);
      const tp2 = pt ? await cdpTo(pt) : null;
      if (tp2) {
        await tp2.waitFor('!!document.getElementById("elsewhere")', 8000).catch(() => 0);
        const nb = await chrome.ev('tabs.length');
        await gesture(tp2, 'document.getElementById("elsewhere").click(), 1');
        const es = await chrome.waitFor(`(() => { const s = ${ST}; return s.sheet && s.sheet.kind === 'page' && s.sheet.shown ? s.sheet : null; })()`, 8000).catch(() => null);
        check(!!es && (await chrome.ev('tabs.length')) === nb, 'a where-to-watch link to a service Lumen does not read opens as a page in the layer, not a tab', es);
        check(logHas(/a page from another site opened in the layer \(redirect to another site\): 127\.0\.0\.1:\d+/), 'quartz.log: that page has its line');
        await chrome.ev('document.querySelector(".wp-sheet-close").click(), 1');
        await chrome.waitFor(`!${ST}.sheet`, 8000).catch(() => 0);
        tp2.close();
      } else check(false, 'the TMDB page came back for the second link');
      await chrome.ev('activateTab(findWatchTab().id), 1');
    } else check(false, 'the TMDB page is a target');
    if ((await chrome.ev(ST)).open) await chrome.ev('WatchPlayer.close("e2e"), 1');

    // The public Widevine test stream, inside the layer (castlabs CDM, the services' way).
    if (WIDEVINE) {
      await chrome.ev(`openInLumen(${JSON.stringify(FD + '/__p/widevine?ms=30000')}, { service: 'disney', title: 'Widevine test stream' }), 1`);
      pt = await targetWhere(q, (x) => String(x.url).indexOf(FD + '/__p/widevine') === 0, 10000);
      const w = pt ? await cdpTo(pt) : null;
      let res = null;
      if (w) {
        const got = [];
        w.ws.on('message', (raw) => { let m; try { m = JSON.parse(String(raw)); } catch (e) { return; } if (m.method === 'Runtime.consoleAPICalled') { const a = m.params.args && m.params.args[0]; if (a && typeof a.value === 'string' && a.value.indexOf('proto:') === 0) got.push(a.value.slice(6)); } });
        await w.send('Runtime.enable');
        const t0 = Date.now();
        while (Date.now() - t0 < 60000 && !res) {
          for (const line of got) { try { const o = JSON.parse(line); if (o && o.done) res = o; } catch (e) { /* partial */ } }
          await sleep(500);
        }
      }
      check(!!res && res.ok === true, 'the public Widevine test stream plays inside the layer', res && { ok: res.ok, error: res.error, shaka: res.shakaError, last: res.last || res.final });
      await chrome.ev('WatchPlayer.close("e2e"), 1');
    }

    // Settings > Watch: "Play inside Watch" off = the old behaviour (a new tab).
    await g.ev('console.log("quartz-watch:settings {}"), 1');
    const sw = await chrome.waitFor('(() => { const b = document.querySelector("[data-field=\\"watchplayer\\"] [role=switch]"); return b ? b.getAttribute("aria-checked") : null; })()', 8000).catch(() => null);
    check(sw === 'true', 'Settings > Watch has "Play inside Lumen", on by default', sw);
    await chrome.ev('document.querySelector("[data-field=\\"watchplayer\\"] [role=switch]").click(), 1');
    await chrome.waitFor('window.api.watchPlayer.get().then((r) => r.inside === false)', 5000).catch(() => 0);
    check(await chrome.ev('window.api.watchPlayer.get().then((r) => r.inside === false)'), 'the switch turns it off (main has it)');
    await chrome.ev('window.Settings && window.Settings.close && window.Settings.close(), activateTab(findWatchTab().id), 1');
    await g.waitFor(`/Opens in a new tab/.test((${card('youtube')}).getAttribute('aria-label') || '')`, 8000).catch(() => 0);
    check(await g.ev(`/Opens in a new tab/.test((${card('youtube')}).getAttribute('aria-label') || '')`), 'off: the tiles say "Opens in a new tab" again');
    const nT = await chrome.ev('tabs.length');
    await clickTile(g, 'youtube');
    await chrome.waitFor(`tabs.length === ${nT + 1}`, 8000).catch(() => 0);
    check((await chrome.ev(`tabs.length === ${nT + 1}`)) && !(await chrome.ev(ST)).open, 'off: a YouTube tile opens a new tab, no layer');
    await chrome.ev('activateTab(findWatchTab().id), 1');
    await chrome.ev('window.api.watchPlayer.setInside(true)');
    check(await chrome.ev('window.__fsCalls') >= 1, 'the window fullscreen path was asked (stubbed: the test window never left its spot)', await chrome.ev('window.__fsCalls'));
    g.close();
    await q.quit();

    /* ============================ boot B: DRM not ready (unsigned) ============================ */
    try { fs.unlinkSync(EDGE_STUB); } catch (e) { /* none */ }
    q = await launch({ cdp: CDP_PORT, env: env({ QUARTZ_TEST_VMP: 'unsigned' }) });
    const c2 = q.chrome;
    await c2.ev('window.toggleFullscreen = function () {}; 1');
    await c2.ev('openWatchTab(), 1');
    const gt2 = await targetWhere(q, (x) => /\/watch\.html(\?|#|$)/.test(String(x.url)), 15000);
    const g2 = await cdpTo(gt2);
    await g2.waitFor(`!!(${cardK('disney', 'resume')})`, 60000);
    const checkLong = (c, label, d) => { check(c, label, d); if (!c) say("detail: " + JSON.stringify(d).slice(0, 2500)); };
    const SPY = `(() => { if (window.__e2eSpy) { window.__e2eSpy.sent = []; window.__e2eSpy.res = []; return 1; } const S = window.__e2eSpy = { sent: [], res: [] };
      const ol = console.log; console.log = function () { try { const s = String(arguments[0]); if (/^quartz-watch:/.test(s)) S.sent.push(s.slice(0, 240)); } catch (e) { /* not a string */ } return ol.apply(this, arguments); };
      const ar = window.__applyWatchResult; window.__applyWatchResult = function (r) { try { S.res.push(JSON.stringify(r).slice(0, 240)); } catch (e) { /* no copy */ } return ar.apply(this, arguments); };
      S.err = []; const oe = console.error; console.error = function () { try { S.err.push([...arguments].map(String).join(' ').slice(0, 240)); } catch (e) { /* none */ } return oe.apply(this, arguments); };
      window.addEventListener('error', (e) => e.message && S.err.push('onerror: ' + String(e.message).slice(0, 200) + ' @' + e.lineno), true);
      S.clicks = []; document.addEventListener('click', (e) => { const t = e.target; S.clicks.push('cap ' + (t.tagName || '') + '.' + String(t.className || '').slice(0, 40)); }, true);
      const st = document.getElementById('stack'); if (st) st.addEventListener('click', (e) => S.clicks.push('stack-after prevented=' + e.defaultPrevented));
      document.addEventListener('click', (e) => S.clicks.push('doc-bubble prevented=' + e.defaultPrevented));
      S.card = (c) => { if (!c) return null; const it = c._item || {}; return { tag: c.tagName, cls: String(c.className).slice(0, 60), disabled: !!c.disabled, inStack: !!c.closest('#stack'), isCard: !!c.closest('.card, .gc'), url: String(it.url || '').slice(0, 120), playUrl: String(it.playUrl || '').slice(0, 120), kind: it.kind, id: String(it.id || '').slice(0, 60), toasts: (document.querySelector('.toasts') || {}).textContent || '' }; };
      return 1; })()`;
    await g2.ev(SPY);
    const log0 = (() => { try { return fs.readFileSync(LOG, 'utf8').length; } catch (e) { return 0; } })();
    const dTile = await clickTile(g2, 'disney', 'resume');
    await sleep(2500);
    let stub2 = ''; try { stub2 = fs.readFileSync(EDGE_STUB, 'utf8'); } catch (e) { stub2 = ''; }
    // Edge gets the title's REAL address (the tile's link), not the test mirror.
    checkLong(/"?https:\/\/www\.disneyplus\.com\//.test(stub2) && !(await c2.ev(ST)).open, 'DRM not ready: a Disney+ Continue watching tile goes to Edge (the stub), no layer', { stub: stub2.trim().slice(0, 120), tile: dTile, card: await g2.ev(`window.__e2eSpy.card(${cardK('disney', 'resume')})`).catch((e) => String(e.message).slice(0, 120)), spy: await g2.ev('(() => { const s = Object.assign({}, window.__e2eSpy); delete s.card; return s; })()').catch(() => null), log: (() => { try { return fs.readFileSync(LOG, 'utf8').slice(log0).split('\n').filter((l) => /Lumen|watch/i.test(l)).slice(-6); } catch (e) { return []; } })(), drm: await c2.ev('(() => { const s = window.Drm && window.Drm.state(); return s && s.widevine ? { available: s.widevine.available, services: s.widevine.services } : null; })()').catch(() => null) });
    await clickTile(g2, 'youtube');
    const y2 = await c2.waitFor(`${ST}.open`, 8000).catch(() => false);
    check(!!y2, 'DRM not ready: YouTube still plays in the layer');
    // DRM not ready: a where-to-watch link to Disney+ goes to Edge (the stub) with the reason said.
    try { fs.unlinkSync(EDGE_STUB); } catch (e) { /* none */ }
    await g2.ev(`console.log("quartz-watch:open " + JSON.stringify({ url: "https://www.themoviedb.org/movie/1/watch" })), 1`);
    await c2.waitFor(`(() => { const s = ${ST}; return s.n === 1 && s.slots[0].service === 'tmdb' && s.slots[0].wcId !== null; })()`, 10000).catch(() => 0);
    const tt = await targetWhere(q, (x) => String(x.url) === srv.tmdb.origin + '/movie/1/watch', 8000);
    const t3 = tt ? await cdpTo(tt) : null;
    if (t3) {
      await t3.waitFor('!!document.getElementById("dplus")', 8000).catch(() => 0);
      await gesture(t3, 'document.getElementById("dplus").click(), 1');
      await sleep(2500);
      let stub3 = ''; try { stub3 = fs.readFileSync(EDGE_STUB, 'utf8'); } catch (e) { stub3 = ''; }
      const s5 = await c2.ev(ST);
      check(stub3.indexOf('/play/tmdb-pick') !== -1 && s5.slots[0] && s5.slots[0].service === 'tmdb', 'DRM not ready: a where-to-watch link to Disney+ goes to Edge (the stub); the TMDB page stays', { stub: stub3.trim().slice(0, 120), service: s5.slots[0] && s5.slots[0].service });
      check(logHas(/left the layer \(where-to-watch link to Disney\+, opened in Edge/), 'quartz.log: the Edge handover has its line, with the reason');
      t3.close();
    } else check(false, 'DRM not ready: the TMDB page is a target');
    g2.close();
    await q.quit();
  } finally {
    srv.close();
    try { await mock.close(); } catch (e) { /* gone */ }
  }
});
