'use strict';
// watch-leaks-harness.js -- Lumen's leak-proof layer, unit level (no Electron, no network):
//   - watch-leaks.js: the count, the kinds, the last reason, one log line each, the file (host only,
//     never a path or a query), a corrupt file, reset, the Settings summary;
//   - watch-player-yt.js: the full watch page by default, the embed only for a multiview tile, the
//     embed's Referer, "Full page" back to the watch page at the same time;
//   - watch-player-main.js with fake guests: a link, a new-tab link, a popup and a redirect to another
//     site open a PAGE SHEET in the layer (no tab, not counted); app links stopped and counted; the
//     sheet's "Open in a tab" and the bar's ways out counted by kind; "open another app" refused for
//     the layer's own contents only; the Settings read carries the count;
//   - watch-main.js: the title / sign-in / profile fallbacks to a tab and Edge are counted with the
//     reason, and a where-to-watch handoff is not counted twice.
// One summary line: "watch-leaks: N passed, M failed".
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const Leaks = require('./watch-leaks');
const YT = require('./watch-player-yt');
const Preview = require('./watch/preview');
const PM = require('./watch-player-main');
const WM = require('./watch-main');

let pass = 0;
let fail = 0;
function check(ok, what, detail) {
  if (ok) { pass++; return; }
  fail++;
  console.log('FAIL ' + what + (detail !== undefined ? ' -- ' + JSON.stringify(detail).slice(0, 400) : ''));
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'watch-leaks-'));

/* ------------------------------------------------------------------ watch-leaks.js */
{
  const dir = tmp();
  const logs = [];
  let t = 1000;
  const lk = Leaks.create({ dir, log: (l) => logs.push(l), now: () => t });
  let st = lk.state();
  check(st.count === 0 && st.last === null && Leaks.KINDS.every((k) => st.kinds[k] === 0), 'leaks: a fresh profile has none');
  check(Leaks.summary(st) === 'Times Lumen had to leave: 0', 'leaks: the Settings line with none', Leaks.summary(st));
  st = lk.record({ kind: 'tab', reason: 'link to another site: example.com', url: 'https://example.com/a/secret-path?q=private', line: 'Lumen player: left the layer (link to another site): example.com' });
  check(st.count === 1 && st.kinds.tab === 1 && st.last.kind === 'tab' && st.last.host === 'example.com' && st.last.at === 1000, 'leaks: one tab leak counts, with its host and time', st);
  check(logs.length === 1 && logs[0] === 'Lumen player: left the layer (link to another site): example.com', 'leaks: exactly the caller\'s one log line', logs);
  t = 2000;
  lk.record({ kind: 'app', reason: 'an app link (disneyplus:) on Disney+, stopped', url: '' });
  st = lk.record({ kind: 'edge', reason: 'Disney+ in Edge: no Widevine', url: 'https://www.disneyplus.com/play/x' });
  check(st.count === 3 && st.kinds.app === 1 && st.kinds.edge === 1 && st.last.reason === 'Disney+ in Edge: no Widevine', 'leaks: kinds and the last reason', st);
  check(logs.length === 3 && /^Lumen left \(edge\): Disney\+ in Edge: no Widevine: www\.disneyplus\.com$/.test(logs[2]), 'leaks: no line given -> a plain one, still one', logs[2]);
  const onDisk = fs.readFileSync(path.join(dir, Leaks.FILE), 'utf8');
  check(onDisk.indexOf('secret-path') === -1 && onDisk.indexOf('private') === -1 && JSON.parse(onDisk).count === 3, 'leaks: the file has the host only, never a path or a query', onDisk);
  const again = Leaks.create({ dir, log: () => {} });
  check(again.state().count === 3 && again.state().last.kind === 'edge', 'leaks: the count survives a restart');
  check(Leaks.summary(again.state()) === 'Times Lumen had to leave: 3, last: Disney+ in Edge: no Widevine', 'leaks: the Settings line', Leaks.summary(again.state()));
  st = again.record({ kind: 'bogus', reason: 'x\u0000y'.repeat(200) });
  check(st.kinds.tab === 2 && st.last.reason.length <= 160 && st.last.reason.indexOf('\u0000') === -1, 'leaks: an unknown kind is a tab, the reason cleaned and capped', st.last);
  check(again.reset().count === 0 && Leaks.create({ dir }).state().count === 0, 'leaks: reset clears the file too');
  fs.writeFileSync(path.join(dir, Leaks.FILE), '{not json');
  check(Leaks.create({ dir }).state().count === 0, 'leaks: a corrupt file is the empty state, not a crash');
  fs.writeFileSync(path.join(dir, Leaks.FILE), JSON.stringify({ count: -4, kinds: { tab: 'x', edge: 2 }, last: { kind: 'evil', reason: 'r' } }));
  const odd = Leaks.create({ dir }).state();
  check(odd.count === 0 && odd.kinds.edge === 2 && odd.kinds.tab === 0 && odd.last === null, 'leaks: odd fields are cleaned field by field', odd);
  const noDir = Leaks.create({ log: () => {} });
  check(noDir.record({ kind: 'tab', reason: 'r' }).count === 1, 'leaks: without a folder it still counts in memory');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ watch-player-yt.js */
{
  const W = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90';
  check(YT.modeFor({}) === 'page' && YT.modeFor({ multi: true }) === 'embed', 'yt: the full page by default, the embed for a multiview tile');
  check(YT.slotUrlFor(W, { service: 'youtube' }) === W, 'yt: a single play keeps the full watch page');
  check(YT.slotUrlFor(W, { service: 'youtube', multi: true }) === 'https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&playsinline=1&rel=0&start=90', 'yt: a multiview tile gets the embed at the same time');
  check(YT.slotUrlFor('https://www.youtube.com/embed/dQw4w9WgXcQ?start=5', { service: 'youtube' }) === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5s', 'yt: an embed given for a single play becomes the full page');
  check(YT.slotUrlFor('https://youtu.be/dQw4w9WgXcQ?t=1m2s', { service: 'youtube', multi: true }) === 'https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&playsinline=1&rel=0&start=62', 'yt: youtu.be with 1m2s');
  for (const u of ['https://www.youtube.com/@channel', 'https://www.youtube.com/feed/subscriptions', 'https://www.youtube.com/shorts/abcdefghijk', 'https://www.youtube.com/watch?v=bad!id']) {
    check(YT.slotUrlFor(u, { service: 'youtube', multi: true }) === u, 'yt: not one video -> untouched: ' + u);
  }
  check(YT.slotUrlFor('https://www.disneyplus.com/watch?v=abcdefghijk', { service: 'disney', multi: true }) === 'https://www.disneyplus.com/watch?v=abcdefghijk', 'yt: another service is never touched');
  check(YT.slotUrlFor('http://127.0.0.1:5/yt/watch?v=abcdefghijk', { service: 'youtube', multi: true }) === 'http://127.0.0.1:5/yt/watch?v=abcdefghijk', 'yt: a path-prefixed test origin is not a /watch page');
  check(YT.slotUrlFor('http://127.0.0.1:5/watch?v=abcdefghijk', { service: 'youtube', multi: true }) === 'http://127.0.0.1:5/embed/abcdefghijk?autoplay=1&playsinline=1&rel=0', 'yt: a rebased origin keeps its origin');
  const v = YT.videoOf('https://www.youtube.com/embed/dQw4w9WgXcQ?start=7', 'youtube');
  check(v && v.embed && YT.pageUrl(v) === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=7s', '"Full page": the embed goes back to the watch page at the same time', v);
  const s = { service: 'youtube', multi: false };
  check(YT.referrer({}, s, 'https://www.youtube.com/embed/dQw4w9WgXcQ') === YT.REFERER && YT.referrer({}, s, W) === undefined, 'yt: only the embed gets the app Referer');
  // The app identity YouTube's embed gets (error 153 without one): the project's public repo, the
  // same in the chrome's player and in main's header for Watch's preview.
  check(YT.REFERER === 'https://github.com/atlas-studio-software/quartz', 'yt: the embed Referer is the public repo', YT.REFERER);
  check(Preview.EMBED_REFERER === YT.REFERER && Preview.currentEmbedReferer() === YT.REFERER, 'yt: watch/preview.js sends the same Referer', Preview.EMBED_REFERER);
  check(Preview.cleanReferer(YT.REFERER) === YT.REFERER, 'yt: the default passes its own https check');
  check(YT.slotUrl({}, s, W) === undefined && YT.slotUrl({}, { service: 'youtube', multi: true }, W).indexOf('/embed/') !== -1, 'yt: the slotUrl hook changes only what must change');
}

/* ------------------------------------------------------------------ watch-player-main.js */
function fakeContents(id, extra) {
  const c = new EventEmitter();
  Object.assign(c, {
    id, destroyed: false, url: '', loads: [], openHandler: null,
    isDestroyed() { return this.destroyed; },
    getType() { return 'webview'; },
    getURL() { return this.url; },
    loadURL(u) { this.loads.push(u); this.url = u; return Promise.resolve(); },
    setWindowOpenHandler(fn) { this.openHandler = fn; },
    close() { this.destroyed = true; this.emit('destroyed'); },
    session: { tag: 'the-player-session' },
  }, extra || {});
  return c;
}
async function playerTests() {
  const sent = [];
  const logs = [];
  const handlers = {};
  const views = [];
  const win = { on() {}, isDestroyed: () => false, webContents: { tag: 'chrome' }, contentView: { kids: [], addChildView(v) { this.kids.push(v); }, removeChildView(v) { this.kids = this.kids.filter((k) => k !== v); } } };
  const guests = {};
  let wcSeq = 100;
  class FakeView {
    constructor(o) {
      this.opts = o;
      this.webContents = (o && o.webContents) || fakeContents(++wcSeq);
      views.push(this);
    }
    setBackgroundColor() {}
    setBounds(r) { this.bounds = r; }
    setVisible(v) { this.visible = v; }
  }
  const dir = tmp();
  const leaks = Leaks.create({ dir, log: (l) => logs.push(l) });
  const pm = PM.create({
    dir,
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    webContents: { fromId: (id) => guests[id] || null },
    WebContentsView: FakeView,
    send: (ch, p) => sent.push([ch, p]),
    getWindow: () => win,
    isChromeSender: () => true,
    log: (l) => logs.push(l),
    leaks,
    test: { authHosts: ['auth.test'] },
  });
  pm.registerIpc();
  const ipc = (ch, p) => handlers[ch]({}, p || {});
  const g = fakeContents(7, { hostWebContents: win.webContents });
  guests[7] = g;
  check(ipc('watch-player:adopt', { wcId: 7, service: 'youtube', origin: 'https://www.youtube.com' }).ok === true, 'player: a YouTube guest is adopted');
  const tabs = () => sent.filter((x) => x[0] === 'open-url').length;
  const sheetMsgs = () => sent.filter((x) => x[0] === 'watch-player:sheet');

  // A plain link to another site: a page sheet, not a tab, not a leak.
  let prevented = false;
  g.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://example.com/article');
  check(prevented && tabs() === 0 && views.length === 1 && views[0].webContents.loads[0] === 'https://example.com/article', 'player: a link to another site opens a page sheet in the layer, no tab', { tabs: tabs(), views: views.length });
  check(views[0].opts.webPreferences.session === g.session && views[0].opts.webPreferences.sandbox === true && views[0].opts.webPreferences.nodeIntegration === false, 'player: the page sheet is in the player\'s own session, sandboxed');
  check(sheetMsgs().some((x) => x[1].kind === 'page' && x[1].host === 'example.com' && x[1].fresh), 'player: the chrome is told: a page sheet, its host');
  check(leaks.state().count === 0 && logs.some((l) => /a page from another site opened in the layer \(link to another site\): example\.com/.test(l)), 'player: staying in Lumen is logged but not a leak', logs.slice(-2));
  // A second off-site link reuses that sheet.
  g.emit('will-navigate', { preventDefault() {} }, 'https://other.example/two');
  check(views.length === 1 && views[0].webContents.loads[1] === 'https://other.example/two', 'player: the next off-site link reuses the page sheet');
  // A redirect of the main frame to another site: the same.
  g.emit('will-redirect', { preventDefault() {} }, 'https://third.example/', false, true);
  check(views.length === 1 && views[0].webContents.loads[2] === 'https://third.example/' && tabs() === 0, 'player: a redirect to another site goes to the page sheet');
  // target=_blank on the same service: in place; to another site: the page sheet.
  let r = g.openHandler({ url: 'https://www.youtube.com/@chan', disposition: 'foreground-tab' });
  await new Promise((res) => setImmediate(res));
  check(r.action === 'deny' && g.loads[g.loads.length - 1] === 'https://www.youtube.com/@chan', 'player: a same-service new-tab link loads in place');
  r = g.openHandler({ url: 'https://shop.example/merch', disposition: 'foreground-tab' });
  check(r.action === 'deny' && views[0].webContents.loads[3] === 'https://shop.example/merch' && tabs() === 0, 'player: a new-tab link to another site goes to the page sheet');
  // window.open with features: sign-in (auth host) and another site -> real child sheets.
  r = g.openHandler({ url: 'https://auth.test/signin', disposition: 'new-window' });
  check(r.action === 'allow' && typeof r.createWindow === 'function', 'player: a sign-in popup is allowed as a sheet');
  const child = fakeContents(201);
  check(r.createWindow({ webPreferences: { sandbox: true }, webContents: child }) === child && sheetMsgs().some((x) => x[1].kind === 'signin'), 'player: the sign-in popup\'s child is the sheet (opener kept)');
  r = g.openHandler({ url: 'https://popup.example/x', disposition: 'new-window' });
  const child2 = fakeContents(202);
  check(r.action === 'allow' && r.createWindow({ webPreferences: {}, webContents: child2 }) === child2 && tabs() === 0, 'player: a popup to another site is a page sheet too, never a window or tab');
  check(leaks.state().count === 0, 'player: none of that left Lumen', leaks.state());

  // App links: the page's, a frame's, a sheet's -- stopped and counted.
  g.emit('will-navigate', { preventDefault() {} }, 'disneyplus://open/x');
  g.emit('will-frame-navigate', { url: 'intent://x#Intent;end', isMainFrame: false, preventDefault() {} });
  views[0].webContents.emit('will-navigate', { preventDefault() {} }, 'hulu://watch/1');
  let st = leaks.state();
  check(st.count === 3 && st.kinds.app === 3 && /an app link \(hulu:\) on YouTube, stopped/.test(st.last.reason), 'player: app links (page, frame, sheet) are stopped and counted', st);
  check(sent.filter((x) => x[0] === 'watch-player:blocked').length === 3, 'player: each one is said in the layer');
  // "open another app" permission: ours -> refused and counted; anyone else's -> not ours.
  check(pm.refuseExternal(g, { externalURL: 'disneyplus://x' }) === true && leaks.state().kinds.app === 4, 'player: an "open another app" ask from a player is refused and counted');
  check(pm.refuseExternal(views[0].webContents, { externalURL: 'mailto:a@b.c' }) === true, 'player: ...and from a sheet');
  check(pm.refuseExternal(fakeContents(999), { externalURL: 'mailto:a@b.c' }) === false, 'player: a normal tab\'s ask is not the layer\'s to answer');

  // The page sheet's "Open in a tab": his choice; one tab, one leak.
  const pageId = sheetMsgs().find((x) => x[1].kind === 'page')[1].id;
  const before = leaks.state().count;
  const tr = ipc('watch-player:sheet-to-tab', { id: pageId });
  check(tr.ok && tabs() === 1 && sent.filter((x) => x[0] === 'open-url')[0][1].url === 'https://shop.example/merch', 'sheet: "Open in a tab" opens that page in a tab', tr);
  st = leaks.state();
  check(st.count === before + 1 && st.last.kind === 'tab' && /Open in a tab, from a page in the layer: shop\.example/.test(st.last.reason), 'sheet: ...counted with its reason', st.last);
  check(views[0].webContents.destroyed && sent.some((x) => x[0] === 'watch-player:sheet-gone' && x[1].id === pageId), 'sheet: and the sheet closes');
  check(ipc('watch-player:sheet-to-tab', { id: 9999 }).ok === false, 'sheet: a gone sheet says so');

  // The bar's own ways out (watch-player.js api.escape): counted by kind.
  ipc('watch-player:escape', { why: 'Open in Edge: licence refused', url: 'https://www.disneyplus.com/play/1' });
  ipc('watch-player:escape', { why: 'Open in a tab', url: 'https://www.youtube.com/watch?v=x' });
  st = leaks.state();
  check(st.kinds.edge === 1 && st.last.kind === 'tab' && logs.some((l) => /left the layer \(Open in Edge: licence refused\): www\.disneyplus\.com/.test(l)), 'bar: Open in Edge / Open in a tab are counted by kind, the old line kept', st.kinds);
  const got = ipc('watch-player:get');
  check(got.leaks && got.leaks.count === st.count && got.leaks.last.reason === st.last.reason, 'settings: the player\'s get carries the leak count', got.leaks);
  check(!handlers['watch-player:test-capture'], 'the whole-window capture exists only in a test instance');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ watch-main.js */
async function mainTests() {
  const dir = tmp();
  const sent = [];
  const rec = [];
  const plays = [];
  const player = { on: true, inside() { return this.on; }, play(x) { plays.push(x); return true; } };
  let edgeOk = true;
  const wm = WM.create({
    dir, send: (c, p) => sent.push([c, p]), log: () => {}, player,
    leaks: { record(o) { rec.push(o); } },
    drmRoute: (u) => (/disneyplus/.test(u) ? { edge: true, reason: 'Widevine is not ready' } : { edge: false }),
    openInEdge: async () => ({ ok: edgeOk, reason: edgeOk ? '' : 'Edge is missing' }),
    test: {},
  });
  let r = await wm.openTitle('https://www.youtube.com/watch?v=abcdefghijk', {});
  check(r.how === 'layer' && rec.length === 0, 'main: a title in the layer is no leak');
  r = await wm.openTitle('https://www.disneyplus.com/play/x', {});
  check(r.how === 'edge' && rec.length === 1 && rec[0].kind === 'edge' && rec[0].reason === 'Disney+ in Edge: Widevine is not ready', 'main: a protected title sent to Edge counts, with why', rec[0]);
  edgeOk = false;
  await wm.openTitle('https://www.disneyplus.com/play/y', {});
  check(rec.length === 2 && /Edge did not open/.test(rec[1].reason), 'main: an Edge that did not open says so in the count');
  await wm.openTitle('https://www.disneyplus.com/play/z', { via: 'handoff' });
  check(rec.length === 2, 'main: the player\'s handoff counts its own way out (not twice)');
  player.on = false;
  r = await wm.openTitle('https://www.youtube.com/watch?v=abcdefghijk', {});
  check(r.how === 'tab' && rec.length === 3 && rec[2].kind === 'tab' && /Play inside Lumen is off/.test(rec[2].reason), 'main: Play inside off -> a tab, counted with that reason', rec[2]);
  r = wm.signIn('hulu');
  check(r.how === 'tab' && rec.length === 4 && /^Sign in to Hulu, in a tab \(Play inside Lumen is off\)$/.test(rec[3].reason), 'main: Sign in to a tab counts', rec[3]);
  player.on = true;
  r = wm.signIn('hulu');
  check(r.how === 'layer' && rec.length === 4 && plays[plays.length - 1].title === 'Sign in to Hulu', 'main: Sign in with the layer on: in the layer, no leak');
  r = await wm.openTitle('https://www.themoviedb.org/movie/1/watch', {});
  check(r.how === 'layer' && plays[plays.length - 1].service === 'tmdb' && rec.length === 4, 'main: a where-to-watch page in the layer is no leak');
  player.on = false;
  await wm.openTitle('https://www.themoviedb.org/movie/1/watch', {});
  check(rec.length === 5 && /TMDB where-to-watch page, in a tab/.test(rec[4].reason) && /opened in a tab \(Play inside Lumen is off\): themoviedb\.org/.test(rec[4].line), 'main: ...in a tab, one counted line (the old wording)', rec[4]);
  wm.stop && wm.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  try { await playerTests(); } catch (err) { check(false, 'player tests threw', String(err && err.stack || err)); }
  try { await mainTests(); } catch (err) { check(false, 'main tests threw', String(err && err.stack || err)); }
  console.log(`watch-leaks: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
