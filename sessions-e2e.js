// sessions-e2e.js -- tabs open, close and come back across a restart (session.json), end to end.
//
//   node sessions-e2e.js
//
// Five boots of a REAL Quartz test instance on ONE temp profile (tests/e2e-kit.js: --test-profile,
// off-screen, watched on every boot), against local pages:
//   boot 1  open four tabs, pin one, navigate one, close one; Ctrl+Shift+T brings the closed one
//           back and it is closed again; the durable copy (session.json) says exactly that; the
//           window is closed the way a user closes it.
//   boot 2  the strip comes back: same tabs, same order, the pin, the navigated url (not the old
//           one), the closed tab NOT back, the tab that was in front in front and loaded, the
//           background tab loads when raised. Then a fifth tab is opened and Quartz is KILLED
//           (taskkill /F) once session.json has it: no clean shutdown, no beforeunload.
//   boot 3  the killed run's strip comes back, the fifth tab included. Then, with every sleep
//           setting OFF, a 185-tab session across two workspaces is built and saved whole.
//   boot 4  all of it comes back, yet only a few pages boot awake (RESTORE_AWAKE_MAX) and the
//           note on screen says so; an unopened tab has not loaded, loads on its first click,
//           and then stays awake.
//   boot 5  a session.json with more tabs than SESSION_MAX_TABS: the first that many come back and
//           the note says how many did not; one more tab past the bound is said at save time.
// One summary line: "sessions-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');
const { run, serve, html, sleep } = require('./tests/e2e-kit');

// E2E_CDP lets a parallel lane run this on a port of its own.
const CDP = Number(process.env.E2E_CDP) || 9431;

run('sessions-e2e', async ({ check, launch, say, profileDir }) => {
  const srv = await serve((req, res, p) => {
    const m = /^\/([a-z0-9]+)\.html$/.exec(p);
    if (!m) return false;
    return html(res, `<!doctype html><title>Page ${m[1].toUpperCase()}</title><p>${m[1]}</p>`);
  });
  const B = 'http://127.0.0.1:' + srv.port;
  const SESSION = path.join(profileDir, 'session.json');
  const ours = (u) => typeof u === 'string' && u.indexOf(B + '/') === 0;
  const short = (u) => String(u).slice(B.length);
  const readFile = () => { try { return JSON.parse(fs.readFileSync(SESSION, 'utf8')); } catch (e) { return null; } };
  /** session.json's own-origin entries, as short paths with flags, plus the url of its active entry. */
  const fileView = () => {
    const s = readFile();
    if (!s || !Array.isArray(s.tabs)) return null;
    const entries = s.tabs.filter((t) => ours(t.url)).map((t) => short(t.url) + (t.pinned ? ' [pinned]' : ''));
    const act = s.tabs[s.active];
    return { entries: entries.join(', '), active: act && ours(act.url) ? short(act.url) : String(act && act.url) };
  };
  async function waitFile(pred, ms) {
    const t0 = Date.now(); let v = null;
    while (Date.now() - t0 < ms) { v = fileView(); if (v && pred(v)) return v; await sleep(200); }
    return v;
  }
  /** The session note on the bar over the tab in front ('' when there is none). */
  const BAR = `((() => { const t = getActiveTab(); const n = t && t.noteEl; return n && n.dataset.sessionNote === '1' ? n.textContent : ''; })())`;
  /** The strip as the chrome holds it: own-origin page tabs in strip order. */
  const STRIP = `tabs.filter((t) => t.kind === 'page' && String(readCurrentUrl(t) || t.url).indexOf(${JSON.stringify(B + '/')}) === 0)
    .map((t) => ({ id: t.id, url: String(readCurrentUrl(t) || t.url).slice(${B.length}), pinned: !!t.pinned, asleep: !!t.asleep, title: t.title || '', active: t.id === activeTabId }))`;

  // ---- boot 1 -------------------------------------------------------------------------------
  // reg.exe (the Windows apps-mode read) answers 5 s late, as on a runner busy at boot: Look Sync's
  // hello must not wait for it (the window gives up after 4 s and says 'the browser did not answer').
  let q = await launch({ cdp: CDP, env: { QUARTZ_TEST_APPS_MODE_DELAY_MS: '5000' } });
  let c = q.chrome;
  check(fileView() === null || fileView().entries === '', 'a fresh profile has no stored tabs of ours', fileView());
  // A fresh profile has no Mantle record, so the background falls back to Windows' wallpaper and
  // says why, in one sentence. It used to repeat itself: "...Mantle hasn't shared one (Mantle
  // hasn't shared a desktop wallpaper yet)".
  const WANT_WHY = "Following Windows' wallpaper: Mantle hasn't shared one yet";
  const why = await c.waitFor("(() => { const d = window.LookSync && window.LookSync.desktop(); return d && d.state === 'fallback' ? String(d.reason) : ''; })()", 10000).catch((e) => e.message);
  check(why === WANT_WHY, 'fresh profile: the wallpaper fallback reason is one plain sentence', why);
  const toast = await c.waitFor("(() => { for (const n of document.querySelectorAll('body *')) { if (getComputedStyle(n).position === 'fixed' && /^Following Windows/.test(n.textContent || '')) return n.textContent.trim(); } return ''; })()", 6000).catch(() => '');
  if (toast) check(toast.replace(/[.\s]+$/, '') === WANT_WHY && !/\(.*\)/.test(toast), 'fresh profile: the toast says it once, no reason repeated in brackets', toast);
  else say('no wallpaper toast seen within 6 s (only the reason was checked)');
  // A fresh profile's look-sync folder is new, not removed: never a "Problem". On a runner (TEMP is
  // an 8.3 short path) the watcher read Quartz's own first write as "folder was removed".
  const lsFirst = await c.waitFor("(() => { const s = window.LookSync && window.LookSync.status(); return s && s.state !== 'starting' ? s.state + ': ' + s.reason : ''; })()", 10000).catch((e) => e.message);
  let lsProblem = /^error/.test(lsFirst) ? lsFirst : '';
  for (const t0 = Date.now(); !lsProblem && Date.now() - t0 < 3000;) {
    lsProblem = await c.ev("(() => { const s = window.LookSync.status(); return s.state === 'error' ? s.reason : ''; })()");
    if (!lsProblem) await sleep(100);
  }
  check(!lsProblem, 'fresh profile: Look Sync is never a Problem (3 s after it settles)', lsProblem || lsFirst);
  const open = async (name, file) => {
    const id = await c.ev(`(() => { window.__t = window.__t || {}; const t = createTab(${JSON.stringify(B + '/' + file)}); window.__t[${JSON.stringify(name)}] = t; activateTab(t.id); return t.id; })()`);
    await c.waitFor(`window.__t[${JSON.stringify(name)}].ready === true`, 15000);
    return id;
  };
  const T = (name) => `window.__t[${JSON.stringify(name)}]`;
  await open('a', 'a.html');
  await open('b', 'b.html');
  await open('c', 'c.html');
  await open('d', 'd.html');
  await c.ev(`setTabPinned(${T('a')}, true), 1`);
  await c.ev(`(activateTab(${T('b')}.id), ${T('b')}.viewEl.loadURL(${JSON.stringify(B + '/b2.html')}).catch(() => 0), 1)`);
  await c.waitFor(`/\\/b2\\.html$/.test(readCurrentUrl(${T('b')}) || '') && ${T('b')}.title === 'Page B2'`, 10000);
  await c.ev(`closeTab(${T('c')}.id), 1`);
  let strip = await c.ev(STRIP);
  check(strip.map((t) => t.url).join(' ') === '/a.html /b2.html /d.html', 'boot 1: the strip after pin, navigate and close', strip.map((t) => t.url));
  check(strip[0] && strip[0].pinned === true, 'boot 1: the pinned tab sits first', strip[0]);

  // Ctrl+Shift+T: the closed tab comes back, in front, on its url.
  await c.ev('reopenClosedTab(), 1');
  const reopened = await c.waitFor(`(() => { const t = getActiveTab(); return t && /\\/c\\.html$/.test(readCurrentUrl(t) || t.url) && t.ready ? t.id : 0; })()`, 10000).catch((e) => e.message);
  check(typeof reopened === 'number' && reopened > 0, 'reopen closed tab: c.html is back, in front, loaded', reopened);
  if (typeof reopened === 'number') await c.ev(`closeTab(${reopened}), 1`);
  await c.ev(`activateTab(${T('b')}.id), 1`);

  let fv = await waitFile((v) => v.entries === '/a.html [pinned], /b2.html, /d.html' && v.active === '/b2.html', 6000);
  check(fv && fv.entries === '/a.html [pinned], /b2.html, /d.html', 'session.json (written while running): a pinned, b at its NEW url, d; c is gone', fv);
  check(fv && fv.active === '/b2.html', 'session.json: the tab in front is the active entry', fv);
  check(!fs.existsSync(SESSION + '.tmp'), 'no half-written session.json.tmp left behind');

  check(await q.quit(), 'boot 1: closing the window quit Quartz');
  fv = fileView();
  check(fv && fv.entries === '/a.html [pinned], /b2.html, /d.html' && fv.active === '/b2.html', 'session.json after a clean quit: unchanged', fv);

  // ---- boot 2 -------------------------------------------------------------------------------
  const b2Hits = srv.hits('/b2.html');
  q = await launch({ cdp: CDP });
  c = q.chrome;
  strip = await c.waitFor(`(() => { const s = ${STRIP}; return s.length >= 3 ? s : null; })()`, 15000).catch(() => null);
  strip = strip || await c.ev(STRIP);
  check(strip.map((t) => t.url).join(' ') === '/a.html /b2.html /d.html', 'boot 2: the same tabs, in the same order (b at its new url, c not back)', strip.map((t) => t.url));
  check(strip[0] && strip[0].pinned, 'boot 2: the pin came back', strip[0]);
  const front = strip.find((t) => t.active);
  check(front && front.url === '/b2.html', 'boot 2: the tab in front is the one that was in front', front || strip);
  const loaded = await c.waitFor(`(() => { const t = getActiveTab(); return t && t.ready && t.title === 'Page B2'; })()`, 15000).catch((e) => e.message);
  check(loaded === true, 'boot 2: the front tab loaded its page (title "Page B2")', loaded);
  check(srv.hits('/b2.html') > b2Hits, 'boot 2: the front tab really fetched its page again', srv.hits('/b2.html') - b2Hits);
  const titleA = strip[0] ? strip[0].title : '';
  check(titleA === 'Page A', 'boot 2: a background tab carries its title (stored or loaded)', titleA);
  const d = strip.find((t) => t.url === '/d.html');
  await c.ev(`activateTab(${d ? d.id : -1}), 1`);
  const dOk = await c.waitFor(`(() => { const t = getActiveTab(); return t && t.id === ${d ? d.id : -1} && t.ready && !t.asleep && /\\/d\\.html$/.test(readCurrentUrl(t) || '') && t.title === 'Page D'; })()`, 15000).catch((e) => e.message);
  check(dOk === true, 'boot 2: a background tab loads its page when raised', dOk);

  // A kill, not a quit: only what is already on disk survives.
  await c.ev(`(() => { const t = createTab(${JSON.stringify(B + '/e.html')}); activateTab(t.id); return 1; })()`);
  await c.waitFor(`(() => { const t = getActiveTab(); return t && t.ready && t.title === 'Page E'; })()`, 15000);
  fv = await waitFile((v) => /\/e\.html/.test(v.entries), 6000);
  check(fv && fv.entries === '/a.html [pinned], /b2.html, /d.html, /e.html', 'boot 2: the new tab reached session.json within seconds', fv);
  check(await q.kill(), 'boot 2: killed (taskkill /F, no clean shutdown)');

  // ---- boot 3 -------------------------------------------------------------------------------
  // main answers the session read 1 s late, as a main busy at boot does (seen on a runner after a
  // kill): boot must still wait for session.json, the copy that survived the kill.
  q = await launch({ cdp: CDP, env: { QUARTZ_TEST_SESSION_READ_DELAY_MS: '1000' } });
  c = q.chrome;
  strip = await c.waitFor(`(() => { const s = ${STRIP}; return s.length >= 4 ? s : null; })()`, 15000).catch(() => null);
  strip = strip || await c.ev(STRIP);
  check(strip.map((t) => t.url).join(' ') === '/a.html /b2.html /d.html /e.html', 'boot 3 (after a kill): every tab came back, the last one opened included', strip.map((t) => t.url));
  const front3 = strip.find((t) => t.active);
  check(front3 && front3.url === '/e.html', 'boot 3: the tab in front at the kill is in front', front3 || strip);
  check(strip[0] && strip[0].pinned, 'boot 3: the pin survived the kill too', strip[0]);
  const e3 = await c.waitFor(`(() => { const t = getActiveTab(); return t && t.ready && t.title === 'Page E'; })()`, 15000).catch((e) => e.message);
  check(e3 === true, 'boot 3: the front tab loaded', e3);

  // A big session with every sleep setting OFF: 120 tabs in home and 60 in a second workspace,
  // far past the 40 a session used to keep. Born asleep here so building it costs no renderers.
  await c.ev("Settings.set({ tabSleepMinutes: 0, workspaceSleep: 'off' }), 1");
  const big = await c.ev(`(() => {
    const home = currentWorkspaceId;
    const ws = createWorkspace('Big');
    for (let i = 0; i < 60; i++) createTab(${JSON.stringify(B)} + '/w' + i + '.html', { background: true, asleep: true, workspace: ws });
    switchWorkspace(home);
    for (let i = 0; i < 120; i++) createTab(${JSON.stringify(B)} + '/h' + i + '.html', { background: true, asleep: true });
    const last = createTab(${JSON.stringify(B)} + '/z.html');
    activateTab(last.id);
    return { ws, home, total: tabs.length, inWs: tabs.filter((t) => tabWorkspace(t) === ws).length, stored: sessionSnapshot().tabs.length };
  })()`);
  check(big.stored === big.total && big.total >= 185, 'boot 3: a ' + big.total + '-tab session is stored whole (' + big.stored + ')', big);
  // What one save of that session costs in the chrome: snapshot, localStorage, the IPC to main.
  const saveMs = await c.ev('(() => { const t0 = performance.now(); writeSession(); return performance.now() - t0; })()');
  say('one save of ' + big.total + ' tabs took ' + Number(saveMs).toFixed(1) + ' ms in the chrome');
  check(saveMs < 150, 'boot 3: saving ' + big.total + ' tabs takes under 150 ms (' + Number(saveMs).toFixed(1) + ')', saveMs);
  const bigFile = await (async () => { const t0 = Date.now(); let s = null; while (Date.now() - t0 < 6000) { s = readFile(); if (s && s.tabs && s.tabs.length === big.total) break; await sleep(200); } return s; })();
  check(bigFile && bigFile.tabs.length === big.total, 'boot 3: session.json holds every one of the ' + big.total + ' tabs', bigFile && bigFile.tabs.length);
  check(await q.quit(), 'boot 3: closing the window quit Quartz');

  // ---- boot 4 -------------------------------------------------------------------------------
  // Every tab back, both workspaces, and still a cheap boot: with sleep off the settings would wake
  // all 180, but past RESTORE_AWAKE_MAX the restore goes lazy anyway, and says so.
  q = await launch({ cdp: CDP });
  c = q.chrome;
  await c.waitFor('tabs.length >= ' + big.total, 30000).catch(() => 0);
  const b4 = await c.ev(`({ total: tabs.length, big: tabs.filter((t) => tabWorkspace(t) === ${JSON.stringify(big.ws)}).length,
    awake: tabs.filter((t) => t.kind === 'page' && !t.asleep).length, max: RESTORE_AWAKE_MAX,
    front: String((getActiveTab() || {}).url || '').slice(${B.length}), note: lastRestoreNote })`);
  check(b4.total === big.total, 'boot 4: all ' + big.total + ' tabs came back (' + b4.total + ')', b4);
  check(b4.big === big.inWs && b4.big >= 60, 'boot 4: the second workspace has its ' + big.inWs, b4.big);
  check(b4.front === '/z.html', 'boot 4: the tab in front is the one that was in front', b4.front);
  check(b4.awake >= 1 && b4.awake <= b4.max, 'boot 4: sleep off, yet only ' + b4.awake + ' page(s) booted awake (bound ' + b4.max + ')', b4);
  check(/To keep startup light/.test(b4.note), 'boot 4: the lazy boot says so on screen', b4.note);
  // The toast is shared (another boot message can replace it a moment later), so the note also
  // sits on the bar over the tab in front until the user dismisses it.
  const bar4 = await c.ev(BAR);
  check(/To keep startup light/.test(bar4), 'boot 4: the note stays on the bar over the front tab', bar4);
  check(srv.hits('/h5.html') === 0, 'boot 4: a tab nobody opened has not loaded', srv.hits('/h5.html'));
  await c.ev(`(() => { const t = tabs.find((x) => String(x.url).endsWith('/h5.html')); activateTab(t.id); return 1; })()`);
  const h5 = await c.waitFor(`(() => { const t = getActiveTab(); return t && t.ready && t.title === 'Page H5'; })()`, 15000).catch((e) => e.message);
  check(h5 === true, 'boot 4: a restored tab loads on its first click', h5);
  await c.ev(`(() => { const t = tabs.find((x) => String(x.url).endsWith('/z.html')); activateTab(t.id); return 1; })()`);
  await sleep(4000);
  const h5later = await c.ev(`(() => { const t = tabs.find((x) => String(x.url).endsWith('/h5.html')); return { asleep: !!t.asleep }; })()`);
  check(!h5later.asleep, 'boot 4: once clicked it stays awake in the background (sleep is off)', h5later);
  check(await q.quit(), 'boot 4: closing the window quit Quartz');

  // ---- boot 5 -------------------------------------------------------------------------------
  // A runaway file: more tabs than the bound. The first SESSION_MAX_TABS come back and the note says
  // how many did not; one more tab past the bound is said again at save time. Never silent.
  const MAX = Number(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').match(/\nconst SESSION_MAX_TABS = (\d+);/)[1]);
  const runaway = { tabs: [], active: 0, workspaces: [{ id: 'main', name: 'Home' }], currentWorkspace: 'main', panesV: 2, savedAt: Date.now() + 600000,
    // The profile's own preset record, so this boot does not seed presets (and their tabs) of its own.
    seededPresets: (bigFile && bigFile.seededPresets) || [], presetsSeeded: !!(bigFile && bigFile.presetsSeeded) };
  for (let i = 0; i < MAX + 7; i++) runaway.tabs.push({ url: B + '/r' + i + '.html' });
  fs.writeFileSync(SESSION, JSON.stringify(runaway));
  q = await launch({ cdp: CDP });
  c = q.chrome;
  await c.waitFor('tabs.length >= ' + MAX, 60000).catch(() => 0);
  const b5 = await c.ev(`({ ours: tabs.filter((t) => String(t.url).indexOf(${JSON.stringify(B + '/r')}) === 0).length, note: lastRestoreNote,
    bar: ${BAR} })`);
  check(b5.ours === MAX, 'boot 5: the first ' + MAX + ' of ' + (MAX + 7) + ' came back (' + b5.ours + ')', b5.ours);
  check(new RegExp('restored your first ' + MAX + ' tabs; 7 more').test(b5.note) && b5.bar.indexOf('7 more') !== -1,
    'boot 5: the note on screen says 7 were not opened', b5);
  await c.ev(`(() => { createTab(${JSON.stringify(B)} + '/over.html', { background: true, asleep: true }); return 1; })()`);
  const over = await c.waitFor(`(() => { const t = ${BAR}; return /were not saved|was not saved/.test(t) ? t : null; })()`, 8000).catch(() => null);
  check(!!over && new RegExp('first ' + MAX + ' tabs.*1 more was not saved').test(over), 'boot 5: a tab past the bound is said at save time ("' + over + '")', over);
  check(await q.quit(), 'boot 5: closing the window quit Quartz');
  say('session.json at the end: ' + JSON.stringify(fileView()));
  srv.close();
});
