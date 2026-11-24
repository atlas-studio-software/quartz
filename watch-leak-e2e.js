require('./tools/lowcpu-optional.js');   // first: the CPU cap, when one is configured (tools/lowcpu-optional.js; none on a cloud runner)
// watch-leak-e2e.js -- Lumen's leak-proof layer, end to end, in a REAL hidden Quartz test instance
// (tests/e2e-kit.js: --test-profile, off-screen). LOCAL FIXTURES ONLY: Lumen's rows come from the
// service mock (tests/watch-mock.js); every service origin (and www.espn.com) is rebased to a local
// "front" here, which serves the fixture pages and hands the readers' paths to the mock. Never a real
// account, cookie, profile or network call. Edge is a stub file.
//
//   node watch-leak-e2e.js [--cdp 9473] [--shots <dir>]
//
// One check per way out of Lumen (the audit in the lane report):
//   Lumen's own buttons: Sign in, "Search on YouTube", Retry, a gamecast -> the layer, no tab;
//   a hosted page: a same-site new-tab link (in place), a link / new-tab link / window.open / popup /
//   redirect to another site (a PAGE SHEET in the layer, no tab, not counted), a sign-in popup (the
//   sign-in sheet), an app link in the page and in a frame (stopped, said, counted, never a dialog), the
//   page sheet's "Open in a tab" (a tab, counted);
//   YouTube: a tile click plays the FULL watch page; a multiview tile plays the embed (with the app
//   Referer) and "Full page" brings the watch page back at the same time; a full page that fails offers
//   "Play just the video";
//   the leak counter: Settings > Lumen says "Times Lumen had to leave: N, last: <reason>", N exact.
// Whole-window shots (the sheet is a native view) at 1536x800 and 1920x1000.
// One summary line: "watch-leak-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { run, Cdp, sleep } = require('./tests/e2e-kit');
const Mock = require('./tests/watch-mock');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9473'));
const SHOTS = opt('shots', path.join(os.tmpdir(), 'quartz-leak-shots'));
const TAG = 'quartz-leak-e2e-' + process.pid;
const EDGE_STUB = path.join(os.tmpdir(), TAG + '-edge.txt');
const VID = 'abcdefghijk';
const FAIL_VID = 'failfailfai';

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.keepAliveTimeout = 2000;
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, origin: 'http://127.0.0.1:' + s.address().port }));
  });
}
function sendHtml(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const STYLE = '<style>body{margin:0;padding:22px 26px;background:#16171a;color:#e6e7e9;font:15px/1.5 "Segoe UI",sans-serif} a,button{color:#9cc8e0;font:inherit;margin:0 14px 10px 0;display:inline-block} h1{font-size:19px;margin:0 0 14px}</style>';
/** A hosted service page with every way out a real one has. */
function hostedPage(name, other, auth) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>${STYLE}</head><body><h1 id="name">${name}</h1>
<div><a id="blank" href="/__p/blank" target="_blank">Same site, new tab</a>
<a id="away" href="${other}/away">A link to another site</a>
<a id="blankAway" href="${other}/blank-away" target="_blank">Another site, new tab</a>
<button id="openAway" onclick="window.open('${other}/open-away')">window.open another site</button>
<button id="popAway" onclick="window.open('${other}/pop-away','pop','width=500,height=600')">A popup to another site</button>
<button id="pop" onclick="window.open('${auth}/signin','signin','width=480,height=600')">Sign in (popup)</button>
<button id="app" onclick="location.href='disneyplus://open/x'">Open in the app</button>
<button id="frameApp" onclick="var f=document.createElement('iframe');f.src='hulu://frame/1';document.body.appendChild(f)">An app link in a frame</button></div>
<p>Comments, Like, Subscribe and Save live on this page.</p></body></html>`;
}

async function startServers(mock) {
  const other = await listen((req, res) => sendHtml(res, `<!doctype html><title>Another site ${req.url}</title>${STYLE}<h1>Another site</h1><p>${String(req.url).replace(/[<>&]/g, '')}: a page that is not one of Lumen's services, shown inside Lumen.</p>`));
  const auth = await listen((req, res) => sendHtml(res, `<!doctype html><title>Sign in</title>${STYLE}<h1>Sign in</h1><button id="done" onclick="opener && opener.postMessage('signed-in', '*'); window.close()">Continue</button>`));
  const referers = [];
  const fronts = {};
  const SVC = Mock.SERVICES;
  for (const svc of SVC) {
    fronts[svc] = await listen((req, res) => {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
      const p = u.pathname;
      if (p === '/watch' && u.searchParams.get('v') === FAIL_VID) { req.socket.destroy(); return; }
      if (p.indexOf('/embed/') === 0) {
        referers.push({ path: p, referer: String(req.headers.referer || '') });
        return sendHtml(res, `<!doctype html><title>Embed ${p.slice(7)}</title>${STYLE}<h1 id="embed">The embedded player</h1><p>Just the video.</p>`);
      }
      if (p === '/watch' || p.indexOf('/__p/') === 0 || p === '/results' || p.indexOf('/nhl/game') === 0 || /\/login|\/signin|\/account/.test(p)) {
        return sendHtml(res, hostedPage(svc + ' ' + p + (u.search || ''), other.origin, auth.origin));
      }
      const up = http.request({ host: '127.0.0.1', port: mock.ports[svc], path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + mock.ports[svc] }) }, (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('mock gone'); } });
      req.pipe(up);
    });
  }
  const rebase = [['https://www.espn.com', fronts.espn.origin]];
  for (const svc of SVC) for (const from of Mock.ORIGINS[svc]) rebase.push([from, fronts[svc].origin]);
  return { other, auth, fronts, referers, rebase, close: () => { other.server.close(); auth.server.close(); for (const f of Object.values(fronts)) f.server.close(); } };
}

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
const ST = 'WatchPlayer._state()';

run('watch-leak-e2e', async ({ check, launch, say, profileDir }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const mock = await Mock.start({ log: () => {} });
  const srv = await startServers(mock);
  const env = {
    QUARTZ_WATCH_BOOT_GRACE_MS: '0',
    QUARTZ_WATCH_REBASE: JSON.stringify(srv.rebase),
    QUARTZ_EDGE_STUB: EDGE_STUB,
    QUARTZ_WATCH_MIN_FREE_GB: '0',
    QUARTZ_PLAYER_AUTH_HOSTS: '127.0.0.1:' + srv.auth.port,
    QUARTZ_TEST_NO_WINDOW_FULLSCREEN: '1',
    QUARTZ_TEST_VMP: 'signed',
  };
  const LOG = path.join(profileDir, 'quartz.log');
  const logText = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch (e) { return ''; } };
  const logHas = (re) => re.test(logText());
  const FY = srv.fronts.youtube.origin;
  const O = srv.other.origin;

  try {
    const q = await launch({ cdp: CDP_PORT, env });
    const chrome = q.chrome;
    await chrome.ev('window.__fsCalls = 0; window.toggleFullscreen = function () { window.__fsCalls++; }; 1');
    const leaks = () => chrome.ev('window.api.watchPlayer.get().then((r) => r.leaks)');
    const tabsN = () => chrome.ev('tabs.length');
    const sheetShown = (kind) => chrome.waitFor(`(() => { const s = ${ST}; return s.sheet && s.sheet.kind === '${kind}' && s.sheet.shown ? s.sheet : null; })()`, 8000).catch(() => null);
    const closeSheet = async () => { await chrome.ev('(() => { const b = document.querySelector(".wp-sheet-close"); if (b && !document.querySelector(".wp-sheet").hidden) b.click(); return 1; })()'); await chrome.waitFor(`!${ST}.sheet`, 8000).catch(() => 0); };
    const shot = async (name, w, h) => {
      const r = await chrome.ev(`window.api.watchPlayer.testCapture({ width: ${w}, height: ${h}, wait: 1200 })`).catch((e) => ({ ok: false, err: String(e && e.message) }));
      if (r && r.ok && r.png) {
        const f = path.join(SHOTS, 'lumen-n-leakproof-' + name + '-' + w + 'x' + h + '.png');
        let png = r.png;
        if (r.sheets && r.sheets.length) {
          // Lay each sheet (a native view) over the window's capture, in the chrome's own canvas.
          png = await chrome.ev(`(async () => {
            const load = (b) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = 'data:image/png;base64,' + b; });
            const base = await load(${JSON.stringify(r.png)});
            const k = base.width / window.innerWidth;
            const c = document.createElement('canvas'); c.width = base.width; c.height = base.height;
            const x = c.getContext('2d'); x.drawImage(base, 0, 0);
            for (const s of ${JSON.stringify(r.sheets)}) { const i = await load(s.png); x.drawImage(i, Math.round(s.rect.x * k), Math.round(s.rect.y * k), Math.round(s.rect.width * k), Math.round(s.rect.height * k)); }
            return c.toDataURL('image/png').split(',')[1];
          })()`).catch(() => r.png);
        }
        fs.writeFileSync(f, Buffer.from(png, 'base64'));
        say('shot ' + f);
      } else say('shot ' + name + ' failed: ' + JSON.stringify(r).slice(0, 120));
    };
    check((await leaks()) && (await leaks()).count === 0, 'a fresh profile: Lumen has not had to leave', await leaks());

    await chrome.ev('openWatchTab(), 1');
    const gt = await targetWhere(q, (x) => /\/watch\.html(\?|#|$)/.test(String(x.url)), 15000);
    const g = await cdpTo(gt);
    const card = (svc) => `([...document.querySelectorAll('#stack .lrow[data-d="0"] *')].find((n) => n._item && n._item.service === '${svc}' && n.offsetParent)
      || [...document.querySelectorAll('*')].find((n) => n._item && n._item.service === '${svc}' && n.offsetParent))`;
    await g.waitFor(`!!(${card('youtube')})`, 60000).catch(() => 0);
    const line = (verb, obj) => g.ev(`console.log("quartz-watch:${verb} " + ${JSON.stringify(JSON.stringify(obj))}), 1`);
    const layerAt = (prefix) => chrome.waitFor(`(() => { const s = ${ST}; return s.open && s.n === 1 && s.slots[0].url.indexOf(${JSON.stringify(prefix)}) === 0 ? s.slots[0] : null; })()`, 12000).catch(() => null);
    const tabs0 = await tabsN();

    /* ---- 1. Lumen's own buttons ---- */
    // YouTube's tile: the FULL watch page, not the embed.
    // A real click, the way he does it: when the tile's row is below the lens (Live now or My teams can lead
    // the rows now), the first click brings that row up (watch.js onStackClick) and the second opens the title.
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
    await g.ev(SPY);
    const log0 = logText().length;
    const ytAt = await g.ev(`(() => { const c = ${card('youtube')}; if (!c) return null; const r = c.closest('.lrow'); const f = document.querySelector('#stack > .lrow[data-d="0"]'); const at = { row: r ? r.dataset.key : null, d: r ? r.dataset.d : null, focused: f ? f.dataset.key : null }; c.scrollIntoView({ block: 'nearest' }); c.click(); return at; })()`);
    if (ytAt && ytAt.row && ytAt.d !== '0') {
      await g.waitFor(`(() => { const r = [...document.querySelectorAll('#stack > .lrow')].find((x) => x.dataset.key === ${JSON.stringify(ytAt.row)}); return !!r && r.dataset.d === '0'; })()`, 4000).catch(() => 0);
      await sleep(500);
      await g.ev(`(() => { const c = ${card('youtube')}; c.scrollIntoView({ block: 'nearest' }); c.click(); return 1; })()`);
    }
    let sl = await chrome.waitFor(`(() => { const s = ${ST}; return s.open && s.n === 1 && s.slots[0].wcId !== null ? s.slots[0] : null; })()`, 15000).catch(() => null);
    checkLong(!!sl && sl.url.indexOf(FY + '/watch?v=') === 0 && (await tabsN()) === tabs0, 'a YouTube tile plays YouTube\'s FULL watch page in the layer, no tab', sl ? { url: sl.url, tile: ytAt } : { tile: ytAt, card: await g.ev(`window.__e2eSpy.card(${card('youtube')})`).catch((e) => String(e.message).slice(0, 120)), spy: await g.ev('(() => { const s = Object.assign({}, window.__e2eSpy); delete s.card; return s; })()').catch(() => null), log: logText().slice(log0).split('\n').filter((l) => /Lumen|watch/i.test(l)).slice(-6) });
    // The watch page opens in Lumen's view (watch-playview.js, the default "When a video plays"). While it
    // looks for YouTube's player, the bar's one button is that view's own toggle to the full page, never the
    // embed's "Full page" (this is already the watch page). This fixture page has no player, so the view
    // gives the whole page back and says why, and then there is no "Full page" button: it is the full page.
    const PVS = `(() => { const y = WatchPlayerYT._state(); const p = window.LumenPlayview ? LumenPlayview._state() : null; const s = p && p.slots[0]; return { y, pref: p && p.pref, s: s ? { mode: s.mode, kind: s.kind, boxed: s.boxed, noRoot: s.noRoot, why: s.why } : null }; })()`;
    const fb = await chrome.waitFor(`(() => { const x = ${PVS}; return x.y.pv && x.s && x.s.boxed ? x : null; })()`, 8000).catch(() => null);
    check(!!fb && fb.pref === 'lumen' && fb.s.mode === 'lumen' && fb.s.kind === 'watch' && fb.y.fullShown && fb.y.pv === true && fb.y.label === 'Full page',
      'the watch page opens in Lumen’s view: its only button is the view’s own “Full page” toggle, not the embed’s', fb || await chrome.ev(PVS));
    const nr = await chrome.waitFor(`(() => { const x = ${PVS}; return x.s && x.s.noRoot && !x.s.boxed && !x.y.fullShown ? x : null; })()`, 14000).catch(() => null);
    check(!!nr && /couldn’t find YouTube’s player on this page, so the whole page shows/.test(nr.s.why) && !nr.y.pv,
      'no player on that page: the view gives the full page back, says why, and the full page has no “Full page” button', nr || await chrome.ev(PVS));
    // Sign in (the chip's and the popover's button send this line).
    await line('signin', { service: 'hulu' });
    sl = await layerAt(srv.fronts.hulu.origin);
    check(!!sl && (await tabsN()) === tabs0, 'Sign in to Hulu opens Hulu\'s sign-in page in the layer, no tab', sl && sl.url);
    // "Search on YouTube" (search results and the find page send an open of YouTube's results page).
    await line('open', { url: 'https://www.youtube.com/results?search_query=bluey' });
    sl = await layerAt(FY + '/results?search_query=bluey');
    check(!!sl && (await tabsN()) === tabs0, '"Search on YouTube" opens YouTube\'s results in the layer, no tab', sl && sl.url);
    // A gamecast (the NHL row / sports page).
    await line('open', { url: 'https://www.espn.com/nhl/game/_/gameId/401' });
    sl = await layerAt(srv.fronts.espn.origin + '/nhl/game/_/gameId/401');
    check(!!sl && sl.service === 'espn' && (await tabsN()) === tabs0, 'a gamecast opens in the layer as ESPN, no tab', sl && { url: sl.url, service: sl.service });
    // Retry reads again; it never opens a page.
    const before = await chrome.ev(`${ST}.slots[0].url`);
    await line('refresh', { service: 'youtube' });
    await sleep(1500);
    check((await tabsN()) === tabs0 && (await chrome.ev(`${ST}.slots[0].url`)) === before, 'Retry reads again and opens no page or tab');
    check((await leaks()).count === 0, 'none of Lumen\'s own buttons left Lumen', await leaks());

    /* ---- 2. a hosted page's ways out ---- */
    await chrome.ev(`openInLumen(${JSON.stringify(FY + '/__p/hosted')}, { service: 'youtube', title: 'Hosted page' }), 1`);
    let pt = await targetWhere(q, (x) => String(x.url) === FY + '/__p/hosted', 10000);
    let p = await cdpTo(pt);
    await p.waitFor('!!document.getElementById("frameApp")', 8000).catch(() => 0);
    const click = async (id) => { await gesture(p, `document.getElementById(${JSON.stringify(id)}).click(), 1`); };
    // Same site, new tab: in place.
    await click('blank');
    sl = await layerAt(FY + '/__p/blank');
    check(!!sl && (await tabsN()) === tabs0, 'a same-site target=_blank link loads in place in the layer', sl && sl.url);
    pt = await targetWhere(q, (x) => String(x.url) === FY + '/__p/blank', 10000);
    p = await cdpTo(pt);
    await p.waitFor('!!document.getElementById("frameApp")', 8000).catch(() => 0);
    // A plain link to another site: a page sheet.
    await click('away');
    let sh = await sheetShown('page');
    check(!!sh && (await tabsN()) === tabs0 && (await chrome.ev(`${ST}.slots[0].url`)) === FY + '/__p/blank', 'a link to another site opens as a page in the layer; the player stays', sh);
    const pageT = await targetWhere(q, (x) => String(x.url) === O + '/away', 8000);
    check(!!pageT, 'the page sheet loaded that page (a page target of its own, not a tab)');
    check(logHas(/a page from another site opened in the layer \(link to another site\): 127\.0\.0\.1:\d+/), 'quartz.log: the page sheet has its line');
    await sleep(800);
    await shot('page-sheet', 1536, 800);
    await shot('page-sheet', 1920, 1000);
    // Another site in a new tab, window.open, a popup with features: the page sheet again (no tab, no window).
    for (const [id, pth, kind] of [['blankAway', '/blank-away', 'page'], ['openAway', '/open-away', 'page'], ['popAway', '/pop-away', 'page']]) {
      await closeSheet();
      await click(id);
      sh = await sheetShown(kind);
      const t = await targetWhere(q, (x) => String(x.url) === O + pth, 8000);
      check(!!sh && !!t && (await tabsN()) === tabs0, id + ': another site opens as a page in the layer, never a tab or window', { sheet: sh, target: !!t });
    }
    await closeSheet();
    // The sign-in popup: the sign-in sheet.
    await click('pop');
    sh = await sheetShown('signin');
    check(!!sh && (await tabsN()) === tabs0, 'a sign-in popup opens as the layer\'s sign-in sheet', sh);
    await closeSheet();
    check((await leaks()).count === 0, 'pages and popups shown in the layer are not leaks', await leaks());
    // App links: the page's own, and one in a frame (the "open another app" ask is answered by the layer).
    await click('app');
    await chrome.waitFor(`/tried to open an app \\(disneyplus:\\)/.test(${ST}.note)`, 5000).catch(() => 0);
    let lk = await leaks();
    check(lk.count === 1 && lk.kinds.app === 1 && /disneyplus:/.test(lk.last.reason) && /Stayed in Lumen/.test(await chrome.ev(`${ST}.note`)), 'an app link is stopped, said in the bar and counted', { lk, note: await chrome.ev(`${ST}.note`) });
    await click('frameApp');
    await sleep(2500);
    lk = await leaks();
    check(lk.count === 2 && /hulu:/.test(lk.last.reason) && logHas(/stopped an app link \(hulu:\)/), 'an app link in a frame is stopped and counted too', lk);
    // (A native 'open another app' dialog would come from main's askPermission; the layer answers first, so the line above is the proof.)
    // The page sheet's "Open in a tab": his choice -> a tab, counted.
    await click('away');
    sh = await sheetShown('page');
    check(!!sh, 'the link opens the page sheet again', sh);
    // At once, before the page commits: the sheet still knows the address it was asked for.
    await chrome.ev('document.querySelector(".wp-sheet-tab").click(), 1');
    await chrome.waitFor(`tabs.length === ${tabs0 + 1}`, 8000).catch(() => 0);
    check((await chrome.ev(`tabs.some((t) => String(t.url).indexOf(${JSON.stringify(O + '/away')}) === 0)`)) && (await tabsN()) === tabs0 + 1, 'the page sheet\'s "Open in a tab" opens it in a normal tab');
    lk = await leaks();
    check(lk.count === 3 && lk.kinds.tab === 1 && /Open in a tab, from a page in the layer: 127\.0\.0\.1/.test(lk.last.reason), 'that tab is counted, with its reason', lk);
    await chrome.ev(`(() => { const t = tabs.find((x) => String(x.url).indexOf(${JSON.stringify(O + '/away')}) === 0); if (t) closeTab(t.id); return 1; })()`).catch(() => 0);
    await chrome.ev('activateTab(findWatchTab().id), 1');
    await sleep(500);

    /* ---- 3. YouTube: the embed for a tile, "Full page", the fallback ---- */
    // Section 2 leaves YouTube's page playing, and a multiview open with a player up ADDS a tile
    // (watch-player-multi.js): close it first, so this tile is the layer's one slot.
    await chrome.ev('WatchPlayer.close("e2e"), 1');
    await chrome.waitFor(`!${ST}.open`, 8000).catch(() => 0);
    check(!(await chrome.ev(`${ST}.open`)), 'section 3 starts with the layer closed');
    await chrome.ev(`openInLumen(${JSON.stringify(FY + '/watch?v=' + VID + '&t=30')}, { service: 'youtube', title: 'A tile', multi: true }), 1`);
    sl = await layerAt(FY + '/embed/' + VID);
    check(!!sl && /[?&]start=30(&|$)/.test(sl.url), 'a multiview tile plays the embed, at the same time', sl && sl.url);
    // With nothing else playing, that tile waits in the corner for the next pick (the mini-player).
    // Its restore button brings it back full size, where the "Full page" button is checked.
    const MS = '(WatchPlayer._state().multi || {})';
    await chrome.ev('(() => { const b = document.querySelector(".mv-mini-restore"); if (b) b.click(); return 1; })()');
    const full = await chrome.waitFor(`(() => { const m = ${MS}; const s = ${ST}; return s.open && s.n === 1 && !m.mini && !m.pick ? { n: s.n } : null; })()`, 5000).catch(() => null);
    check(!!full, 'the corner player restores to the full layer, still one tile', { multi: await chrome.ev(MS), n: await chrome.ev(`${ST}.n`) });
    await chrome.waitFor('WatchPlayerYT._state().fullShown', 5000).catch(() => 0);
    check(await chrome.ev('WatchPlayerYT._state().fullShown'), 'the embed has a "Full page" button');
    await sleep(600);
    // The fixture is http, so Chromium drops an https Referer on that downgrade: what is checked here is
    // that the layer asks for it (the webview's httpreferrer); YouTube itself is https.
    const ref = srv.referers.filter((r) => r.path === '/embed/' + VID).pop();
    const refAttr = () => chrome.ev('(() => { const v = document.querySelector(".wp-layer webview"); return v ? v.getAttribute("httpreferrer") : null; })()');
    const attr = await refAttr();
    check(!!ref && attr === 'https://github.com/atlas-studio-software/quartz', 'the embed loads with the app\'s Referer asked for (YouTube refuses an embed without one)', { attr, served: ref });
    await shot('embed-fullpage-button', 1536, 800);
    await chrome.ev('document.querySelector(".wp-yt-full").click(), 1');
    sl = await layerAt(FY + '/watch?v=' + VID);
    check(!!sl && /[?&]t=30s(&|$)/.test(sl.url) && (await tabsN()) === tabs0, '"Full page" loads the full watch page in the same slot, at the same time', sl && sl.url);
    await chrome.waitFor('!WatchPlayerYT._state().fullShown', 5000).catch(() => 0);
    check(!(await chrome.ev('WatchPlayerYT._state().fullShown')), 'and the button goes away on the full page');
    // The full page fails: "Play just the video" is the fallback.
    await chrome.ev('WatchPlayer.close("e2e"), 1');
    await chrome.waitFor(`!${ST}.open`, 8000).catch(() => 0);
    await chrome.ev(`openInLumen(${JSON.stringify(FY + '/watch?v=' + FAIL_VID)}, { service: 'youtube', title: 'Fails' }), 1`);
    const failed = await chrome.waitFor(`(() => { const s = ${ST}; return s.slots[0] && s.slots[0].state === 'failed' ? s.slots[0] : null; })()`, 12000).catch(() => null);
    const hasFallback = await chrome.ev('[...document.querySelectorAll(".wp-state:not([hidden]) button")].some((b) => b.textContent === "Play just the video")');
    check(!!failed && hasFallback, 'a full page that fails says why and offers "Play just the video"', failed && failed.stateText);
    await chrome.ev('[...document.querySelectorAll(".wp-state:not([hidden]) button")].find((b) => b.textContent === "Play just the video").click(), 1').catch(() => 0);
    sl = await layerAt(FY + '/embed/' + FAIL_VID);
    await sleep(600);
    const ref2 = srv.referers.filter((r) => r.path === '/embed/' + FAIL_VID).pop();
    const attr2 = await refAttr();
    check(!!sl && !sl.state && !!ref2 && attr2 === 'https://github.com/atlas-studio-software/quartz' && (await chrome.ev('WatchPlayerYT._state().fullShown')), 'the fallback plays the embed (the Referer asked for) and offers "Full page"', { url: sl && sl.url, attr2, served: !!ref2 });
    await chrome.ev('WatchPlayer.close("e2e"), 1');
    await chrome.waitFor(`!${ST}.open`, 8000).catch(() => 0);

    /* ---- 4. the leak counter in Settings ---- */
    await g.ev('console.log("quartz-watch:settings {}"), 1');
    const txt = await chrome.waitFor('(() => { const n = document.querySelector("[data-field=\\"watchplayer\\"] .set-lumen-leaks"); return n ? n.textContent : null; })()', 8000).catch(() => null);
    check(txt === 'Times Lumen had to leave: 3, last: Open in a tab, from a page in the layer: 127.0.0.1:' + srv.other.port + ' (just now)' || /^Times Lumen had to leave: 3, last: Open in a tab, from a page in the layer: 127\.0\.0\.1:\d+/.test(String(txt)), 'Settings > Lumen: "Times Lumen had to leave: 3, last: <reason>"', txt);
    const box = await chrome.ev('(() => { const n = document.querySelector("[data-field=\\"watchplayer\\"] .set-lumen-leaks"); if (!n) return null; return { sw: n.scrollWidth, cw: n.clientWidth, sh: n.scrollHeight, ch: n.clientHeight }; })()');
    check(!!box && box.sw <= box.cw + 1 && box.sh <= box.ch + 1, 'the counter line is not clipped', box);
    await chrome.ev('(() => { const n = document.querySelector("[data-field=\\"watchplayer\\"]"); if (n) n.scrollIntoView({ block: "center" }); return 1; })()');
    await shot('settings-counter', 1536, 800);
    await shot('settings-counter', 1920, 1000);
    check(logText().split('\n').filter((l) => /left the layer \(Open in a tab, from a page in the layer\)/.test(l)).length === 1, 'quartz.log: exactly one line for that one leak');
  } finally {
    srv.close();
    await mock.close();
    try { fs.unlinkSync(EDGE_STUB); } catch (e) { /* none */ }
  }
});
