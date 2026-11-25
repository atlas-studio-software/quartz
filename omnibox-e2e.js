// omnibox-e2e.js -- the address bar, end to end, in a REAL Quartz test instance.
//
//   node omnibox-e2e.js
//
// tests/e2e-kit.js launches it (--test-profile, off-screen, watched). Driven with REAL input over
// CDP: text goes in with Input.insertText, Enter / arrows / Escape with Input.dispatchKeyEvent.
//   typed addresses   "127.0.0.1:<port>/x" and "localhost:<port>/x" get http://, a full URL goes
//                     as typed, "quartz-e2e.test" (a bare domain) gets https://; each lands in the
//                     tab in front (no new tab), and the bar shows the page afterwards;
//   searches          plain words and a single non-domain word go to the search engine, with the
//                     query encoded; the lens's first row says it is a search before Enter;
//   autocomplete      pages visited earlier come up as "History" rows by their TITLE; arrowing
//                     onto one previews its URL in the bar, Enter goes there; Escape puts back what
//                     was typed and closes the lens; an open tab comes up as "Open tab" and Enter
//                     SWITCHES to it rather than loading it a second time.
// The searches and the .test domain are not loaded and waited on (a real search engine on the
// network, a name that never resolves): the check is the first URL the tab starts navigating to,
// and the load is stopped right there.
// One summary line: "omnibox-e2e: N passed, M failed".
'use strict';
const { run, serve, html, KEYS, sleep } = require('./tests/e2e-kit');

const CDP = Number(process.env.QUARTZ_E2E_CDP) || 9435; // a lane's own port when it has to share the machine
const TITLES = { start: 'Start Page', typed: 'Typed Page', local: 'Localhost Page', full: 'Full Url Page', alpha: 'Alpha Field Guide', beta: 'Beta Notebook', gamma: 'Gamma Workbench' };

run('omnibox-e2e', async ({ check, launch, say }) => {
  const srv = await serve((req, res, p) => {
    const m = /^\/([a-z]+)\.html$/.exec(p);
    if (!m || !TITLES[m[1]]) return false;
    return html(res, `<!doctype html><title>${TITLES[m[1]]}</title><p>${m[1]}</p>`);
  });
  const P = srv.port;
  const B = 'http://127.0.0.1:' + P;
  const q = await launch({ cdp: CDP });
  const c = q.chrome;
  // A chrome call with no answer in 45 s fails the run with the expression it was stuck on, instead of
  // the suite's 300 s kill with no output to go on.
  c.callMs = 45000;

  await c.ev(`(() => { const t = createTab(${JSON.stringify(B + '/start.html')}); window.__main = t; activateTab(t.id); return 1; })()`);
  await c.waitFor('window.__main.ready === true', 15000);
  const tabCount = () => c.ev('tabs.length');
  const front = () => c.ev('(() => { const t = getActiveTab(); return { id: t.id, url: t.url, cur: readCurrentUrl(t) || "", title: t.title || "", ready: !!t.ready }; })()');
  const lens = () => c.ev(`(() => { const p = document.getElementById('omni-suggest'); const rows = p ? [...p.querySelectorAll('.omni-row')] : [];
    return { open: !!(p && !p.hidden && window.History.isOpen()), value: document.getElementById('omnibox').value,
      rows: rows.map((r) => ({ primary: ((r.querySelector('.omni-primary') || {}).textContent || '').trim(), secondary: ((r.querySelector('.omni-secondary') || {}).textContent || '').trim(),
        src: ((r.querySelector('.omni-src') || {}).textContent || '').trim(), hi: r.classList.contains('is-hi') })) }; })()`);
  /** Focus the bar the way a click does (all selected), then type over it. */
  const typeIn = async (text) => {
    await c.ev("(() => { const o = document.getElementById('omnibox'); o.focus(); o.select(); return 1; })()");
    await c.type(text);
  };
  // After Enter the bar blurs and the lens closes BLUR_DELAY (120 ms) later; a focus inside that
  // window cancels the close, so each step lets it finish before the next one types.
  const settle = async () => { await sleep(250); await c.waitFor('!window.History.isOpen()', 2000).catch(() => 0); };
  const go = async (text) => { await typeIn(text); await c.key('Enter', KEYS.Enter); await settle(); };
  /** The lens open on THIS text (its first row is the typed text), with at least `n` rows. */
  const lensFor = (text, n) => c.waitFor(`window.History.isOpen() && document.querySelectorAll('#omni-suggest .omni-row').length >= ${n} && ((document.querySelector('#omni-suggest .omni-row .omni-primary') || {}).textContent || '').trim() === ${JSON.stringify(text)}`, 4000).then(() => lens()).catch(() => lens());
  const waitFront = async (pred, ms) => {
    const t0 = Date.now(); let f;
    while (Date.now() - t0 < (ms || 10000)) { f = await front(); if (pred(f)) return f; await sleep(100); }
    return f;
  };

  say('step: typed addresses');
  // ---- typed addresses -------------------------------------------------------------------------
  const id0 = (await front()).id;
  const n0 = await tabCount();
  await go('127.0.0.1:' + P + '/typed.html');
  let f = await waitFront((x) => x.ready && x.title === TITLES.typed);
  check(f.url === B + '/typed.html' && f.title === TITLES.typed, '"127.0.0.1:port/typed.html" -> http://, loaded', f);
  check(f.id === id0 && await tabCount() === n0, 'it loaded in the tab in front, no new tab', { id: f.id, id0, tabs: await tabCount(), n0 });
  const bar = await c.waitFor(`document.getElementById('omnibox').value.indexOf('127.0.0.1:${P}/typed.html') !== -1 && document.activeElement !== document.getElementById('omnibox') ? document.getElementById('omnibox').value : ''`, 5000).catch((e) => e.message);
  check(/127\.0\.0\.1:\d+\/typed\.html/.test(bar), 'after Enter the bar lets go of the keyboard and shows the page address', bar);

  await go('localhost:' + P + '/local.html');
  f = await waitFront((x) => x.ready && x.title === TITLES.local);
  check(f.url === 'http://localhost:' + P + '/local.html' && f.title === TITLES.local, '"localhost:port/local.html" -> http://, loaded', f);

  await go('  ' + B + '/full.html?x=1#y  ');
  f = await waitFront((x) => x.ready && x.title === TITLES.full);
  check(f.url === B + '/full.html?x=1#y' && f.title === TITLES.full, 'a full URL (with spaces around it) goes as typed', f);

  say('step: searches');
  // ---- addresses and searches that leave the machine --------------------------------------------
  // Judged by the FIRST url the tab starts navigating to (the guest's did-start-navigation), and
  // then stopped: a search engine redirects (Google adds &sei=...) and a .test name never resolves,
  // so the tab's url a moment later is not what the bar sent.
  const sent = async (text) => {
    await c.ev("(() => { const v = getActiveTab().viewEl; window.__navs = []; if (!v.__navRec) { v.__navRec = true; v.addEventListener('did-start-navigation', (e) => { if (e.isMainFrame && window.__navs) window.__navs.push(e.url); }); } return 1; })()");
    await typeIn(text);
    await c.key('Enter', KEYS.Enter);
    const url = await c.waitFor('window.__navs && window.__navs[0]', 5000).catch(() => null);
    await c.ev('(() => { window.__navs = null; try { getActiveTab().viewEl.stop(); } catch (e) {} return 1; })()');
    await settle();
    return url;
  };
  const wantSearch = (t) => c.ev(`searchUrlFor(${JSON.stringify(t)})`);

  let sentUrl = await sent('quartz-e2e.test');
  check(sentUrl === 'https://quartz-e2e.test/', 'a bare domain "quartz-e2e.test" -> https://', sentUrl);
  check((await front()).id === id0, 'still the same tab in front');

  await typeIn('plain words search 42');
  const L1 = await lensFor('plain words search 42', 1);
  check(L1.open && L1.rows[0] && L1.rows[0].primary === 'plain words search 42' && /search/i.test(L1.rows[0].secondary), "the lens's first row says Enter will SEARCH for the words", L1.rows[0]);
  await c.ev("(() => { document.getElementById('omnibox').blur(); return 1; })()");
  await settle();
  const s1 = await wantSearch('plain words search 42');
  sentUrl = await sent('plain words search 42');
  check(sentUrl === s1 && /q=plain(%20|\+)words(%20|\+)search(%20|\+)42/.test(sentUrl), 'plain words -> the search engine, query encoded', sentUrl);
  check(!(await lens()).open, 'Enter closed the lens');
  const s2 = await wantSearch('notaurl');
  sentUrl = await sent('notaurl');
  check(sentUrl === s2, 'one word that is not a domain -> a search, not https://notaurl', sentUrl);
  const s3 = await wantSearch('C++ & "quotes"?');
  sentUrl = await sent('C++ & "quotes"?');
  check(sentUrl === s3 && /C%2B%2B%20%26%20%22quotes%22%3F/.test(sentUrl), 'symbols in a search are encoded, not lost', sentUrl);

  say('step: autocomplete, history');
  // ---- autocomplete: history ------------------------------------------------------------------------
  // Visit two pages in a tab, then close it: they are history now, not open tabs.
  await c.ev(`(() => { const t = createTab(${JSON.stringify(B + '/alpha.html')}); window.__h = t; activateTab(t.id); return 1; })()`);
  await c.waitFor(`window.__h.ready === true && window.__h.title === ${JSON.stringify(TITLES.alpha)}`, 15000);
  await c.ev(`window.__h.viewEl.loadURL(${JSON.stringify(B + '/beta.html')}).catch(() => 0), 1`);
  await c.waitFor(`window.__h.title === ${JSON.stringify(TITLES.beta)}`, 15000);
  await c.ev('closeTab(window.__h.id), activateTab(window.__main.id), 1');
  await sleep(300);
  // The main tab has wandered off to a search: bring it back to a local page first.
  await go(B + '/start.html');
  await waitFront((x) => x.ready && x.title === TITLES.start);

  await typeIn('field gu');
  let L = await lensFor('field gu', 2);
  const hIdx = L.rows.findIndex((r) => r.primary === TITLES.alpha);
  check(hIdx > 0 && L.rows[hIdx].src === 'History', 'typing part of a visited page\'s TITLE offers it, labelled "History"', L.rows);
  check(L.rows[0] && L.rows[0].primary === 'field gu', 'the typed text stays the first row', L.rows[0]);
  for (let i = 0; i <= hIdx; i++) await c.key('ArrowDown', KEYS.ArrowDown);
  L = await lens();
  check(L.rows[hIdx] && L.rows[hIdx].hi && L.value === B + '/alpha.html', 'arrowing onto it highlights it and previews its URL in the bar', { value: L.value, hi: L.rows.findIndex((r) => r.hi) });
  const alphaHits = srv.hits('/alpha.html');
  const mainId = await c.ev('window.__main.id');
  await c.key('Enter', KEYS.Enter);
  await settle();
  f = await waitFront((x) => x.ready && x.title === TITLES.alpha);
  check(f.id === mainId && f.url === B + '/alpha.html' && srv.hits('/alpha.html') === alphaHits + 1, 'Enter on the history row loads that page in the tab in front', f);

  await typeIn('beta note');
  L = await lensFor('beta note', 2);
  const bIdx = L.rows.findIndex((r) => r.primary === TITLES.beta);
  check(bIdx > 0, 'a second visited page is offered by its title too', L.rows.map((r) => r.primary));
  for (let i = 0; i <= Math.max(bIdx, 0); i++) await c.key('ArrowDown', KEYS.ArrowDown);
  check((await lens()).value === B + '/beta.html', 'arrowing previews it', (await lens()).value);
  await c.key('Escape', KEYS.Escape);
  L = await lens();
  check(!L.open && L.value === 'beta note', 'Escape closes the lens and puts back exactly what was typed', L);
  f = await front();
  check(f.url === B + '/alpha.html', 'and nothing navigated', f.url);

  say('step: autocomplete, an open tab');
  // ---- autocomplete: an open tab ------------------------------------------------------------------
  await c.ev(`(() => { const t = createTab(${JSON.stringify(B + '/gamma.html')}, { background: true }); window.__g = t; return 1; })()`);
  await c.waitFor(`window.__g.ready === true && window.__g.title === ${JSON.stringify(TITLES.gamma)}`, 15000);
  const n1 = await tabCount();
  const gammaHits = srv.hits('/gamma.html');
  await typeIn('gamma work');
  L = await lensFor('gamma work', 2);
  const gIdx = L.rows.findIndex((r) => r.primary === TITLES.gamma);
  check(gIdx > 0 && L.rows[gIdx].src === 'Open tab', 'an open tab is offered as "Open tab"', L.rows);
  for (let i = 0; i <= Math.max(gIdx, 0); i++) await c.key('ArrowDown', KEYS.ArrowDown);
  await c.key('Enter', KEYS.Enter);
  f = await waitFront((x) => x.title === TITLES.gamma, 5000);
  const gId = await c.ev('window.__g.id');
  check(f.id === gId, 'Enter on it SWITCHES to that tab', { front: f.id, gamma: gId });
  check(await tabCount() === n1 && srv.hits('/gamma.html') === gammaHits, 'no new tab and no second load', { tabs: await tabCount(), n1, loads: srv.hits('/gamma.html') - gammaHits });
  check(await c.ev('window.__main.url') === B + '/alpha.html', 'the tab that was in front was left where it was', await c.ev('window.__main.url'));

  say('step: quit');
  check(await q.quit(), 'closing the window quit Quartz');
  srv.close();
});
