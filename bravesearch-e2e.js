require('./tools/lowcpu-optional.js');   // first: one capped browser at a time (2026-09-17)
// bravesearch-e2e.js — Quartz's own results page end to end, against a REAL test instance and a
// MOCK Brave Search API. Never the real API, never the user's profile.
//
//   node bravesearch-e2e.js [--cdp 9418] [--inspect 9419] [--shots <dir>] [--keep]
//
// 1. A mock Brave: a local http server answering /res/v1/{web,news,videos}/search with the recorded
//    shapes in tests/brave-fixtures.js. The key decides the answer: good-* -> results, bad-* -> 422
//    SUBSCRIPTION_TOKEN_INVALID, rate-* -> 429 RATE_LIMITED, quota-* -> 429 with the month used up.
//    Stopping it is the "offline" case (connection refused). A second server serves a plain page for
//    the right-click test. Every API request is recorded (path, q, offset, the key header).
// 2. Quartz: --test-profile --profile-name=bravee2e<pid> --offscreen --show-inactive --measure-visible
//    --menu-dump, QUARTZ_BRAVE_API pointing at the mock (honoured for test profiles only), and
//    --inspect on main so the "Search for" menu item can be clicked the way the menu would.
//    testwatch.js's watcher fails the run if the window ever touches the screen. Not launched under
//    2.5 GB free RAM. Driven over CDP (the chrome and each guest page).
// 3. Checks: engine entry; no key; the Settings key field (mask, never echoed, never in localStorage,
//    in <userData>/brave-search.json); results render (web/news/videos, highlighting, hostile rows
//    inert, attribution); the transient cache; the pager; omnibox, "b" keyword, Home search box and
//    right-click routing; bad key / 429 / quota / offline messages with the plain-search way out;
//    light and dark (computed colours + screenshots written to --shots for a human look).
// Kills ONLY the process it started and deletes its temp profile. One summary line:
// "bravesearch-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WS = require(path.join(__dirname, 'node_modules', 'ws'));
const { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb, startWatcher } = require('./testwatch');
const F = require('./tests/brave-fixtures');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9418'));
const INSPECT_PORT = Number(opt('inspect', '9419'));
const SHOTS = path.resolve(opt('shots', process.env.QUARTZ_SHOTS || path.join(os.tmpdir(), 'quartz-search-shots')));   // QUARTZ_SHOTS: a cloud run brings them back
const KEEP = argv.includes('--keep');
const APP = __dirname;
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROFILE = opt('profile', 'bravee2e' + process.pid);
const PROFILE_DIR = path.join(os.tmpdir(), 'browser-test-profile-' + PROFILE);
const GOOD = 'good-key-e2e-7a1c';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(cond, name, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + String(detail).slice(0, 260) : ''));
}

/* ---- the mock Brave ---------------------------------------------------------------------- */
const apiLog = [];
let apiPort = 0;
let imgBase = '';   // https on the mock's port: fails fast and locally, never the real image CDN
function localImages(obj) {
  return JSON.parse(JSON.stringify(obj).replace(/https:\/\/imgs\.search\.brave\.com\//g, imgBase));
}
function apiHandler(req, res) {
  const u = new URL(req.url, 'http://x');
  const key = String(req.headers['x-subscription-token'] || '');
  apiLog.push({ path: u.pathname, q: u.searchParams.get('q'), offset: u.searchParams.get('offset'), count: u.searchParams.get('count'), key });
  const send = (status, body, headers) => {
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers || {}));
    res.end(JSON.stringify(body));
  };
  if (key.startsWith('bad-')) return send(422, F.ERRORS.badKey());
  if (key.startsWith('rate-')) return send(429, F.ERRORS.rate(), F.rateHeaders(1980));
  if (key.startsWith('quota-')) return send(429, F.ERRORS.quota(), F.rateHeaders(0));
  if (!key.startsWith('good-')) return send(401, F.error(401, 'UNAUTHORIZED', 'Missing token'));
  const q = u.searchParams.get('q') || '';
  if (u.pathname === '/res/v1/news/search') return send(200, localImages(F.news(q)), F.rateHeaders(1990));
  if (u.pathname === '/res/v1/videos/search') return send(200, localImages(F.videos(q)), F.rateHeaders(1990));
  if (u.pathname === '/res/v1/web/search') return send(200, localImages(F.web(q, 20)), F.rateHeaders(1987));
  return send(404, F.error(404, 'NOT_FOUND', 'No such endpoint'));
}
let apiServer = http.createServer(apiHandler);
const pageServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>Plain page</title><body style="font:20px sans-serif;padding:40px">' +
    '<p>Tonight there is a <span id="pick">lunar eclipse</span> over the lake.</p></body>');
});
const listen = (srv, port) => new Promise((r, j) => { srv.once('error', j); srv.listen(port, '127.0.0.1', () => r(srv.address().port)); });

/* ---- CDP ----------------------------------------------------------------------------------- */
class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WS(this.wsUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { this.ws.on('open', r); this.ws.on('error', j); });
    this.ws.on('message', (raw) => { const m = JSON.parse(String(raw)); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m); } });
    return this;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }
  async ev(expr) {
    const m = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (m.error) throw new Error(JSON.stringify(m.error));
    if (m.result.exceptionDetails) throw new Error('threw: ' + ((m.result.exceptionDetails.exception || {}).description || m.result.exceptionDetails.text));
    return m.result.result.value;
  }
  async waitFor(expr, ms) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < (ms || 10000)) { try { last = await this.ev(expr); if (last) return last; } catch (e) { last = e.message; } await sleep(80); }
    throw new Error('timed out: ' + expr.slice(0, 140) + ' (last ' + JSON.stringify(last).slice(0, 200) + ')');
  }
  close() { try { this.ws.close(); } catch (e) { /* gone */ } }
}
async function targets(port) { return (await fetch('http://127.0.0.1:' + port + '/json')).json(); }
async function waitTarget(pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 10000)) {
    try { const t = (await targets(CDP_PORT)).find(pred); if (t) return t; } catch (e) { /* not up yet */ }
    await sleep(120);
  }
  throw new Error('no such target');
}
async function guest(urlRe, notId) {
  const t = await waitTarget((x) => x.type === 'webview' && urlRe.test(String(x.url)) && x.id !== notId, 12000);
  const c = await new Cdp(t.webSocketDebuggerUrl).open();
  c.targetId = t.id;
  return c;
}

/* ---- run ------------------------------------------------------------------------------------ */
(async () => {
  let child = null, watcher = null, chrome = null, page = null, mainDbg = null;
  try {
    const free = freeRamGb();
    if (!(free >= MIN_FREE_GB)) { console.log('bravesearch-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }
    apiPort = await listen(apiServer, 0);
    imgBase = 'https://127.0.0.1:' + apiPort + '/img/';
    const pagePort = await listen(pageServer, 0);
    fs.mkdirSync(SHOTS, { recursive: true });
    watcher = startWatcher((l) => console.log('[e2e] ' + l));
    await watcher.ready;
    const env = Object.assign({}, process.env, { QUARTZ_BRAVE_API: 'http://127.0.0.1:' + apiPort + '/res/v1' });
    child = spawn(ELECTRON, ['--inspect=' + INSPECT_PORT, '.', '--remote-debugging-port=' + CDP_PORT, '--test-profile', '--profile-name=' + PROFILE, '--menu-dump', ...OFFSCREEN_ARGS], { cwd: APP, stdio: 'ignore', env });
    watcher.watch(child.pid);
    console.log('[e2e] quartz pid ' + child.pid + ', mock api :' + apiPort + ', page :' + pagePort);

    const ct = await waitTarget((x) => x.type === 'page' && /index\.html/.test(String(x.url)), 30000);
    chrome = await new Cdp(ct.webSocketDebuggerUrl).open();
    await chrome.waitFor('!!(window.Settings && window.Keywords && window.api && window.api.braveSearch && typeof getActiveTab === "function")', 20000);
    const shot = async (name) => {
      // An offscreen window never gets a real blur, so the omnibox panel the
      // test opened stays up; and the test profile's Look Sync toast is not
      // this page. Neither belongs in a picture of the results page.
      await chrome.ev(`(() => { try { window.History && window.History.close(); } catch (e) {}
        for (const n of document.querySelectorAll('body *')) {
          if (getComputedStyle(n).position === 'fixed' && /^Following Windows/.test(n.textContent || '')) n.style.visibility = 'hidden';
        } return 1; })()`);
      await sleep(250);
      const m = await chrome.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SHOTS, name + '.png');
      if (m.result && m.result.data) fs.writeFileSync(file, Buffer.from(m.result.data, 'base64'));
      return file;
    };
    const omnibox = (text) => chrome.ev(`(() => { const o = document.getElementById('omnibox'); o.focus(); o.value = ${JSON.stringify(text)};
      o.dispatchEvent(new Event('input', { bubbles: true }));
      o.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    const activeUrl = () => chrome.ev('(getActiveTab() || {}).url || ""');
    const SEARCH_RE = /\/search\.html\?/;
    const state = () => page.ev('window.__searchState && window.__searchState()');
    const settle = (pred) => page.waitFor(`(() => { const s = window.__searchState && window.__searchState(); return s && s.phase !== 'loading' && (${pred}) ? s : null; })()`, 12000);

    // ---- the engine entry ------------------------------------------------------------------
    const engines = await chrome.ev('Settings.engines().map((e) => e.id + "=" + e.name)');
    check(engines.includes('brave-api=Quartz results (Brave)') && engines.includes('brave=Brave'), 'Settings > Search lists "Quartz results (Brave)" beside the plain Brave site', engines.join(', '));
    await chrome.ev("Settings.set({ searchEngine: 'brave-api' }), 1");

    // ---- no key ------------------------------------------------------------------------------
    await omnibox('quartz crystal');
    await chrome.waitFor(`/search\\.html\\?q=quartz/.test((getActiveTab() || {}).url || '')`, 8000);
    check(SEARCH_RE.test(await activeUrl()), 'omnibox search -> Quartz results page', await activeUrl());
    page = await guest(SEARCH_RE);
    let s = await settle("s.phase === 'problem'");
    check(s.problem === 'no-key' && s.problemTitle === 'No Brave Search key yet', 'no key: says so', s.problemTitle + ' | ' + s.problemDetail);
    let acts = await page.ev("[...document.querySelectorAll('#sr-actions > *')].map((a) => a.textContent + '|' + (a.href || ''))");
    check(acts.some((a) => a.startsWith('Search on search.brave.com instead|https://search.brave.com/search?q=quartz%20crystal')) && acts.some((a) => a.startsWith('Open Settings')),
      'no key: offers the plain web search and Settings', acts.join(' ; '));
    check(apiLog.length === 0, 'no key: nothing was sent to Brave', apiLog.length + ' requests');
    check((await chrome.ev("document.getElementById('omnibox').value")) === 'quartz crystal', 'omnibox shows the search, not a file:// address');
    await page.ev("document.querySelector('.sr-act-settings').click(), 1");
    await chrome.waitFor('Settings.isOpen() && !!document.querySelector("#set-brave-key")', 6000);
    check(true, '"Open Settings > Search" opens Settings with the key field');
    await shot('nokey-dark');

    // ---- the key field ----------------------------------------------------------------------
    await chrome.ev(`(() => { const i = document.querySelector('#set-brave-key'); i.value = ${JSON.stringify(GOOD)}; document.querySelector('.set-brave-save').click(); return 1; })()`);
    const ph = await chrome.waitFor(`(() => { const i = document.querySelector('#set-brave-key'); return i && i.placeholder.indexOf('••••') === 0 ? i.placeholder + '|' + i.value + '|' + i.type : null; })()`, 6000);
    check(ph === '••••7a1c||password', 'Save: the field shows the mask, never the key', ph);
    const leaks = await chrome.ev(`(() => { let all = ''; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); all += k + localStorage.getItem(k); } return [all.includes(${JSON.stringify(GOOD)}), document.documentElement.outerHTML.includes(${JSON.stringify(GOOD)})]; })()`);
    check(!leaks[0] && !leaks[1], 'the key is in neither the chrome\'s localStorage nor its DOM', JSON.stringify(leaks));
    const desc = await chrome.ev('window.api.braveSearch.describe()');
    check(desc.hasKey && desc.keyMask === '••••7a1c' && !JSON.stringify(desc).includes(GOOD), 'describe(): hasKey + mask only', JSON.stringify(desc));
    const stored = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'brave-search.json'), 'utf8'));
    // At rest the key is encrypted with safeStorage (secret-store.js): keyEnc only, never the key's text.
    // Where encryption is unavailable it is kept in plain text and Settings must say so beside the field.
    if (desc.keyStorage === 'unencrypted') {
      const note = await chrome.ev("(() => { const n = document.querySelector('.set-brave-key-storage'); return n ? n.textContent : ''; })()");
      check(stored.key === GOOD && /stored unencrypted: /.test(note), 'no encryption here: kept in plain text, and Settings says why', note);
    } else {
      check(desc.keyStorage === 'encrypted' && typeof stored.keyEnc === 'string' && !('key' in stored) &&
        !fs.readFileSync(path.join(PROFILE_DIR, 'brave-search.json'), 'utf8').includes(GOOD), 'key stored ENCRYPTED in <userData>/brave-search.json (keyEnc, no plain key)', PROFILE_DIR);
    }
    await chrome.ev('Settings.close(), 1');

    // ---- results -----------------------------------------------------------------------------
    await page.ev("document.querySelector('.sr-act-retry').click(), 1");   // the no-key panel's own Try again
    await sleep(300);
    s = await settle("s.phase === 'ok'");
    check(s.results === 21, 'web results render (20 + the hostile row; the javascript: row dropped)', s.results + ' results, meta "' + s.meta + '"');
    const r0 = await page.ev(`(() => { const r = document.querySelector('.sr-result'); return { title: r.querySelector('.sr-title').textContent, href: r.querySelector('.sr-title').href,
      strong: r.querySelectorAll('strong').length, host: r.querySelector('.sr-host').textContent, desc: r.querySelector('.sr-desc').textContent }; })()`);
    check(r0.title === 'Quartz crystal result number 0' && r0.href === 'https://example0.com/articles/quartz-0' && r0.strong >= 2 && r0.host === 'example0.com',
      'first result: title, link, host, Brave\'s highlighting as <strong>', JSON.stringify(r0));
    check(r0.desc.startsWith('1 days ago — A quartz crystal is a piece of silicon dioxide & it keeps time'), 'snippet: age + entities decoded', r0.desc);
    const hostile = await page.ev(`(() => { const r = [...document.querySelectorAll('.sr-result')].find((x) => x.querySelector('.sr-host').textContent === 'hostile.example');
      return { pwned: window.__pwned || null, scripts: document.querySelectorAll('script').length, imgs: [...document.querySelectorAll('img')].filter((i) => i.getAttribute('src') === 'x').length,
        text: r && r.querySelector('.sr-desc').textContent, js: [...document.querySelectorAll('a')].some((a) => /^javascript:/i.test(a.getAttribute('href') || '')) }; })()`);
    check(!hostile.pwned && hostile.scripts === 3 && hostile.imgs === 0 && !hostile.js && !/__pwned/.test(hostile.text || '') && /stays text with bold/.test(hostile.text || ''),
      'hostile row (page scripts: newtab-theme, search-answer, search): no script ran, no <img> made, script text dropped, no javascript: link', JSON.stringify(hostile));
    const attrib = await page.ev(`[...document.querySelectorAll('.sr-attrib')].map((a) => getComputedStyle(a).textTransform + ':' + a.textContent + ':' + a.href + ':' + (a.getBoundingClientRect().height > 0))`);
    check(attrib.length === 2 && attrib.every((a) => a.startsWith('uppercase:Powered by Brave:https://brave.com/search/api/:true')), 'attribution "POWERED BY BRAVE" in the header and footer', attrib.join(' ; '));
    check(apiLog.length === 1 && apiLog[0].path === '/res/v1/web/search' && apiLog[0].q === 'quartz crystal' && apiLog[0].key === GOOD && apiLog[0].count === '20',
      'one request: /web/search, the query, the key in X-Subscription-Token', JSON.stringify(apiLog[0]));
    const title = await chrome.ev('(getActiveTab() || {}).title || ""');
    check(/quartz crystal – Search/.test(title), 'tab title is the search', title);

    // cache: reload is free
    await page.ev('location.reload(), 1');
    await sleep(300);
    s = await settle("s.phase === 'ok'");
    check(s.cached && apiLog.length === 1 && /from memory, no search spent/.test(s.meta), 'reload: answered from memory, no second request', s.meta + ' / ' + apiLog.length + ' requests');

    // light and dark, with screenshots
    // The colours are read as painted after the flip. Under prefers-reduced-motion (Windows with its
    // animations off, as on the hosted CI runner) tokens.css cuts every transition to 0.01 ms, and since
    // transition-property defaults to `all`, every element then transitions its colours for that 0.01 ms:
    // until the next frame getComputedStyle still reads the colour from BEFORE the flip. So wait for the
    // page's running transitions to end (bounded: on a timeout the check reads what is there and says so).
    const flipPainted = () => page.ev(`Promise.race([
      Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => null))),
      new Promise((r) => setTimeout(r, 3000))]).then(() => 1)`);
    await chrome.ev("setThemeMode('dark'), 1");
    await page.waitFor("document.documentElement.getAttribute('data-theme') === 'dark'", 5000);
    await flipPainted();
    const darkBg = await page.ev('getComputedStyle(document.body).backgroundColor');
    const darkText = await page.ev("getComputedStyle(document.querySelector('.sr-desc')).color");
    check(darkBg === 'rgb(20, 21, 22)', 'dark: page wears --bg #141516', darkBg + ' / text ' + darkText);
    // Brave's terms 4(d): "POWERED BY BRAVE" plus their logo. Each attribution shows exactly one
    // logo, the theme's own file, loaded from assets/brave/ (the CSP allows it), 13 px tall, right
    // after the words. naturalWidth 0 = blocked or missing.
    const logoExpr = `(() => [...document.querySelectorAll('.sr-attrib')].map((a) => {
      const shown = [...a.querySelectorAll('img.sr-brave')].filter((i) => getComputedStyle(i).display !== 'none');
      const i = shown[0]; const t = a.querySelector('.sr-attrib-text');
      if (!i || !t) return shown.length + ':none';
      const ir = i.getBoundingClientRect(); const tr = t.getBoundingClientRect();
      return shown.length + ':' + i.getAttribute('src') + ':' + (i.complete && i.naturalWidth > 0) + ':' + Math.round(ir.height) + ':' + (ir.left - tr.right >= 0 && ir.left - tr.right <= 12 && Math.abs((ir.top + ir.bottom) / 2 - (tr.top + tr.bottom) / 2) <= 3);
    }))()`;
    const logoOk = (want) => `${logoExpr}.every((x) => x === '1:assets/brave/${want}:true:13:true') ? ${logoExpr} : null`;
    const logosDark = await page.waitFor(logoOk('brave-logo-on-dark.svg'), 5000).catch(() => null) || await page.ev(logoExpr);
    check(Array.isArray(logosDark) && logosDark.length === 2 && logosDark.every((x) => x === '1:assets/brave/brave-logo-on-dark.svg:true:13:true'),
      'dark: Brave\'s logo (light wordmark) loads beside "POWERED BY BRAVE", header and footer', JSON.stringify(logosDark));
    const shotDark = await shot('results-dark');
    await chrome.ev("setThemeMode('light'), 1");
    await page.waitFor("document.documentElement.getAttribute('data-theme') === 'light'", 5000);
    await flipPainted();
    const lightBg = await page.ev('getComputedStyle(document.body).backgroundColor');
    const lightText = await page.ev("getComputedStyle(document.querySelector('.sr-desc')).color");
    check(lightBg === 'rgb(233, 233, 231)' && lightText !== darkText, 'light: the chrome\'s flip reaches the page (--bg #e9e9e7)', lightBg + ' / text ' + lightText);
    const logosLight = await page.waitFor(logoOk('brave-logo-on-light.svg'), 5000).catch(() => null) || await page.ev(logoExpr);
    check(Array.isArray(logosLight) && logosLight.length === 2 && logosLight.every((x) => x === '1:assets/brave/brave-logo-on-light.svg:true:13:true'),
      'light: the logo swaps to Brave\'s dark-wordmark file, header and footer', JSON.stringify(logosLight));
    const shotLight = await shot('results-light');
    console.log('[e2e] screenshots: ' + shotDark + ' , ' + shotLight);

    // news and videos tabs (light), then the pager (dark)
    await page.ev("document.querySelector('.sr-tab[data-kind=news]').click(), 1");
    s = await settle("s.kind === 'news' && s.phase === 'ok'");
    const thumbs = await page.ev("document.querySelectorAll('.sr-news .sr-thumb').length");
    check(s.results === 6 && thumbs === 6 && apiLog[apiLog.length - 1].path === '/res/v1/news/search' && s.theme === 'light', 'News tab: 6 news results with thumbnails, still light', JSON.stringify(s));
    await shot('news-light');
    await page.ev("document.querySelector('.sr-tab[data-kind=videos]').click(), 1");
    s = await settle("s.kind === 'videos' && s.phase === 'ok'");
    const dur = await page.ev("[...document.querySelectorAll('.sr-duration')].map((d) => d.textContent).join(',')");
    check(s.results === 5 && dur === '3:00,4:01,5:02,6:03,7:04', 'Videos tab: 5 videos with durations', dur);
    await shot('videos-light');
    // The web tab renders light; the flip to dark comes AFTER its links are built, and the Next
    // link must follow it (search.js relinkLook). Wait on the page wearing dark, not on a timer.
    await page.ev("document.querySelector('.sr-tab[data-kind=web]').click(), 1");
    s = await settle("s.kind === 'web' && s.phase === 'ok'");
    await chrome.ev("setThemeMode('dark'), 1");
    await page.waitFor("document.documentElement.getAttribute('data-theme') === 'dark'", 5000);
    const nextHref = await page.ev("document.querySelector('#sr-pager').hidden ? '' : document.querySelector('#sr-next').getAttribute('href')");
    check(/page=1/.test(nextHref) && /theme=dark/.test(nextHref), 'pager: Next keeps the look, even after a flip', nextHref);
    await page.ev("document.querySelector('#sr-next').click(), 1");
    s = await settle("s.page === 1 && s.phase === 'ok'");
    check(apiLog[apiLog.length - 1].offset === '1', 'Next page asks Brave for offset 1', JSON.stringify(apiLog[apiLog.length - 1]));

    // ---- routing: the "b" keyword, the Home search box, right-click "Search for" ---------------
    await omnibox('b lunar eclipse');
    const kwUrl = await chrome.waitFor(`(() => { const u = (getActiveTab() || {}).url || ''; return /search\\.html\\?q=lunar(\\+|%20)eclipse/.test(u) ? u : null; })()`, 8000);
    check(!!kwUrl, '"b lunar eclipse" -> Quartz results page', kwUrl);
    s = await settle("s.query === 'lunar eclipse' && s.phase === 'ok'");
    check(s.results === 21, '"b" search renders', s.results);
    const lens = await chrome.ev("(() => { const k = Keywords.match('b x'); return k && k.url.indexOf('search.html') > 0; })()");
    check(lens, 'Keywords.match("b x") points at the results page while Brave is the engine');
    await chrome.ev("Settings.set({ searchEngine: 'google' }), 1");
    const other = await chrome.ev("[Keywords.match('b x').url, Settings.searchUrl('x')]");
    check(other[0] === 'https://search.brave.com/search?q=x' && other[1] === 'https://www.google.com/search?q=x', 'another engine: "b" is the Brave site again, plain search is that engine', other.join(' , '));
    await chrome.ev("Settings.set({ searchEngine: 'brave-api' }), 1");

    // the Home search box (a new tab, after the settings push)
    await chrome.ev('createTab(), 1');
    const home = await guest(/newtab\.html/);
    const homeT = await home.waitFor("(() => { const s = window.__search && window.__search('moon phases'); return s && s.engine === 'brave-api' ? s : null; })()", 8000);
    check(/search\.html\?q=moon\+phases&theme=dark/.test(homeT.target) && homeT.placeholder === 'Search Brave or type a URL', 'Home search box -> Quartz results page', homeT.target.split('/').pop() + ' | ' + homeT.placeholder);
    home.close();

    // right-click "Search for" on a plain web page
    await chrome.ev(`createTab('http://127.0.0.1:${pagePort}/page.html'), 1`);
    const web = await guest(/127\.0\.0\.1:\d+\/page\.html/);
    await web.waitFor("document.readyState === 'complete' && !!document.getElementById('pick')", 8000);
    const rect = await web.ev("(() => { const el = document.getElementById('pick'); const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()");
    await web.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'right', clickCount: 1 });
    await web.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'right', clickCount: 1 });
    const dumpFile = path.join(PROFILE_DIR, 'menu-dump.json');
    let dump = null;
    for (let i = 0; i < 40 && !dump; i++) { try { const d = JSON.parse(fs.readFileSync(dumpFile, 'utf8')); if (d.items.some((x) => /^Search for/.test(x))) dump = d; } catch (e) { /* not yet */ } await sleep(150); }
    check(!!dump && dump.items.includes('Search for "lunar eclipse"'), 'right-click on a selection: the menu has Search for "lunar eclipse"', dump && dump.items.join(' | '));
    const mt = (await targets(INSPECT_PORT))[0];
    mainDbg = await new Cdp(mt.webSocketDebuggerUrl).open();
    const clicked = await mainDbg.ev("(() => { const m = global.__quartzLastMenu; if (!m) return 'no menu'; const it = m.find((i) => i.label && i.label.indexOf('Search for') === 0); if (!it) return 'no item'; it.click(); return it.label; })()");
    const ctxUrl = await chrome.waitFor(`(() => { const u = (getActiveTab() || {}).url || ''; return /search\\.html\\?q=lunar(\\+|%20)eclipse/.test(u) ? u : null; })()`, 8000).catch((e) => e.message);
    check(/search\.html/.test(ctxUrl), 'clicking "Search for" opens the Quartz results page', clicked + ' -> ' + String(ctxUrl).split('/').pop());
    web.close();
    const kwTab = page.targetId;
    page.close();
    page = await guest(/search\.html\?q=lunar/, kwTab);
    s = await settle("s.phase === 'ok'");
    check(s.results === 21 && s.cached, 'the right-click search renders in its own tab (from memory: same question as the "b" one)', JSON.stringify(s).slice(0, 120));

    // ---- Settings > Search "Check key": one real search, its verdict in the status line ----------
    const before = apiLog.length;
    await chrome.ev('Settings.open("Search"), 1');
    await chrome.waitFor("!!document.querySelector('.set-brave-check')", 5000);
    await chrome.ev("document.querySelector('.set-brave-check').click(), 1");
    const checked = await chrome.waitFor("(() => { const p = document.querySelector('.set-brave-status'); return p && /^Checked/.test(p.textContent) ? p.textContent : null; })()", 6000);
    check(checked === 'Checked: The key works.' && apiLog.length === before + 1 && apiLog[apiLog.length - 1].count === '1', 'Check key: one 1-result search, "The key works."', checked + ' / ' + JSON.stringify(apiLog[apiLog.length - 1]));
    await chrome.ev('Settings.close(), 1');

    // ---- failures -------------------------------------------------------------------------------
    const reaskWith = async (key, q) => {
      if (key !== null) await chrome.ev(`window.api.braveSearch.setKey(${JSON.stringify(key)}).then(() => 1)`);
      await omnibox(q);
      await sleep(400);
      page.close();
      page = await guest(new RegExp('search\\.html\\?q=' + encodeURIComponent(q).replace(/%20/g, '(\\+|%20)')));
      return settle("s.phase === 'problem'");
    };
    s = await reaskWith('bad-key-e2e-0001', 'bad key check');
    check(s.problem === 'bad-key' && s.problemTitle === 'Brave rejected the saved key' && /422 SUBSCRIPTION_TOKEN_INVALID: The provided subscription token is invalid\./.test(s.problemDetail) && s.problemDetail.includes('••••0001'),
      'bad key: says Brave rejected it, in Brave\'s words', s.problemDetail);
    acts = await page.ev("[...document.querySelectorAll('#sr-actions > *')].map((a) => a.textContent)");
    check(acts.join('|') === 'Open Settings › Search|Try again|Search on search.brave.com instead', 'bad key: Settings, Try again, plain web search', acts.join('|'));
    await shot('badkey-dark');
    await chrome.ev('Settings.open("Search"), 1');
    const status = await chrome.waitFor("(() => { const p = document.querySelector('.set-brave-status'); return p ? p.textContent : null; })()", 5000);
    check(/Last search: Brave rejected the saved key\./.test(status), 'Settings > Search status line says the key was rejected', status);
    await chrome.ev('Settings.close(), 1');

    s = await reaskWith('rate-key-e2e-0002', 'rate limit check');
    check(s.problem === 'rate-limited' && /429 RATE_LIMITED/.test(s.problemDetail) && /1 search per second/.test(s.problemDetail), 'HTTP 429: too many at once, with the plan limit', s.problemTitle + ' | ' + s.problemDetail);
    acts = await page.ev("[...document.querySelectorAll('#sr-actions > *')].map((a) => a.textContent)");
    check(acts.join('|') === 'Try again|Search on search.brave.com instead', '429: Try again + plain web search', acts.join('|'));

    s = await reaskWith('quota-key-e2e-0003', 'quota check');
    check(s.problem === 'quota' && /2,000 of 2,000 searches used this month\. The allowance resets in 16 days\./.test(s.problemDetail), 'month used up: says so, with the reset', s.problemDetail);

    await chrome.ev(`window.api.braveSearch.setKey(${JSON.stringify(GOOD)}).then(() => 1)`);
    const closed = new Promise((r) => apiServer.close(r));
    apiServer.closeAllConnections();   // keep-alive sockets too: a reused one would still answer
    await closed;
    s = await reaskWith(null, 'offline check');
    check(s.problem === 'offline' && s.problemTitle === 'Can\'t reach Brave Search' && /connection was refused \(ECONNREFUSED\)/.test(s.problemDetail), 'offline: can\'t reach Brave, and why', s.problemDetail);
    acts = await page.ev("[...document.querySelectorAll('#sr-actions > *')].map((a) => a.textContent + '|' + (a.href || ''))");
    check(acts[0] === 'Try again|' && acts[1] === 'Search on search.brave.com instead|https://search.brave.com/search?q=offline%20check', 'offline: Try again + plain web search', acts.join(' ; '));
    await chrome.ev("setThemeMode('light'), 1");
    await page.waitFor("document.documentElement.getAttribute('data-theme') === 'light'", 5000);
    await shot('offline-light');

    // back online: Try again works without reloading
    apiServer = http.createServer(apiHandler);
    await listen(apiServer, apiPort);
    await page.ev("document.querySelector('.sr-act-retry').click(), 1");
    s = await settle("s.phase === 'ok'");
    check(s.results === 21, 'back online: Try again shows the results', s.results);
    await chrome.ev("setThemeMode('dark'), 1");
  } catch (e) {
    check(false, 'HARNESS ERROR ' + (e && e.stack || e));
  } finally {
    if (watcher) { const v = watcher.verdict(); check(v.ok, v.line); watcher.stop(); }
    for (const c of [page, chrome, mainDbg]) if (c) c.close();
    if (child && !KEEP) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ }
      await sleep(1200);
      for (let i = 0; i < 10; i++) { try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); break; } catch (e) { await sleep(400); } }
    }
    try { apiServer.close(); } catch (e) { /* closed */ }
    pageServer.close();
    console.log(`bravesearch-e2e: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
