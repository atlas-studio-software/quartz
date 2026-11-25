'use strict';
// csp-e2e.js - the live half of csp-harness.js: every bundled page's Content-Security-Policy in a
// REAL Quartz test instance, with zero violations while the page does its work.
//
//   node csp-e2e.js [--cdp 9454] [--profile-name=csp-e2e] [--trace]
//   (--trace prints every step and every DevTools call with its time: where a hang sits)
//
// A meta policy that refuses something the page needs does not crash anything: the feature just
// stops, and the only trace is a console line. So this opens each page and counts BOTH traces of a
// refusal: `securitypolicyviolation` events (a listener added before the page's first script, then
// a reload) and the console's "Content Security Policy" lines (the DevTools Log domain replays every
// line since the page loaded). Any one of them is a FAIL with the text.
//
// What runs:
//   - the chrome (index.html): boots, Settings > About opens (its age sentence is read back), a
//     terminal tab starts (xterm draws its rows with <style>), and the policy is proven ACTIVE: an
//     inline <script> injected into the chrome must not run, and eval must throw (tried from a page
//     timer: DevTools' own Runtime.evaluate is exempt from 'unsafe-eval' by default);
//   - newtab, historypage, files, search, watch, welcome, phone and score-pin as tabs;
//   - reader.html for a served article that carries style= attributes, an inline handler, a
//     <script> and images: the article must show, with its images and without those three;
//   - a positive control: one forced violation on a guest must be SEEN, so "zero" means zero.
// Off-screen and never focused (testwatch.js OFFSCREEN_ARGS), its own --test-profile, its own
// CDP port. Kills only the process it started (by PID, no tree kill) and deletes its temp profile.
// Refuses to launch below testwatch's free-RAM floor (exit 3). Summary: "csp-e2e: N passed, M failed".
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Cdp, serve, sleep } = require('./tests/e2e-kit');
const { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb, startWatcher } = require('./testwatch');

const APP = __dirname;
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const argv = process.argv.slice(2);
const argVal = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(argVal('cdp', '9454'));
const PROFILE = argVal('profile-name', 'csp-e2e');
const PROFILE_DIR = path.join(os.tmpdir(), 'browser-test-profile-' + PROFILE);

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail !== undefined ? '  ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''));
}
const say = (l) => console.log('[e2e] ' + l);

/** Runs in each guest before its first script: every violation, kept on window. */
const LISTENER = `(function(){window.__cspV=[];document.addEventListener('securitypolicyviolation',function(e){` +
  `window.__cspV.push((e.effectiveDirective||e.violatedDirective)+' <- '+(e.blockedURI||'inline')+' @'+(e.sourceFile||'').split('/').pop()+':'+e.lineNumber);},true);})();`;

/*
 * A step that never answers (a CDP call into a stuck page, a websocket that never opens) used to
 * hold the run until the suite's limit killed it, with no summary and no hint where. `phase` names
 * the step in progress; the watchdog in main() closes every DevTools session after WATCHDOG_S and
 * ends the run itself (main() races it), the run reports "no step hung: <phase>" as a FAIL and the
 * finally block still quits the instance and deletes its profile (openSession says why that needed
 * more than closing the sessions).
 */
const WATCHDOG_S = 240;
let phase = 'launch';
let hungIn = '';
const sessions = [];

const TRACE = argv.includes('--trace');   // --trace: every step and every DevTools call, timed
const T0 = Date.now();
function setPhase(p) { phase = p; if (TRACE) say('step +' + ((Date.now() - T0) / 1000).toFixed(1) + ' s: ' + p); }

/**
 * Opens a DevTools session the watchdog can always end. Three holes made the first watchdog useless:
 *   - the session joined `sessions` only AFTER its websocket opened, so a socket that never opened
 *     was out of the watchdog's reach: it is registered first now, and an open has 15 s;
 *   - the ws library DROPS a send() on a closed socket without calling back or throwing, so after
 *     the watchdog closed the sessions every later call (the finally block's own window.close
 *     included) waited forever: a call on a socket that is not open answers with an error at once;
 *   - a step awaiting something that is not a DevTools call (a sleep loop, a fetch) was never
 *     ended at all: main() races the whole run against the watchdog as well.
 */
async function openSession(wsUrl) {
  const c = new Cdp(wsUrl);
  const opening = c.open();                 // sets c.ws before its first await
  sessions.push(c);
  const tag = String(wsUrl).split('/').pop().slice(0, 6);
  const send = c.send.bind(c);
  c.send = async (method, params) => {
    if (!c.ws || c.ws.readyState !== 1) return { error: { message: 'the DevTools session is closed (' + method + ')' } };
    if (!TRACE) return send(method, params);
    const t = Date.now();
    say('  ' + tag + ' -> ' + method + (method === 'Runtime.evaluate' ? ' ' + String(params.expression).slice(0, 60).replace(/\s+/g, ' ') : ''));
    const m = await send(method, params);
    say('  ' + tag + ' <- ' + method + ' ' + (Date.now() - t) + ' ms' + (m.error ? ' ERROR ' + JSON.stringify(m.error).slice(0, 120) : ''));
    return m;
  };
  if (TRACE) say('  ' + tag + ' opening ' + wsUrl);
  let timer;
  try {
    await Promise.race([opening, new Promise((_, j) => { timer = setTimeout(() => j(new Error('the DevTools websocket did not open in 15 s: ' + wsUrl)), 15000); })]);
  } catch (e) {
    try { c.ws.terminate(); } catch (e2) { /* never opened */ }
    throw e;
  } finally { clearTimeout(timer); }
  if (TRACE) {
    say('  ' + tag + ' open');
    // Why a session ends: Chromium says so (Inspector.detached) before it closes the socket.
    c.ws.on('close', (code) => say('  ' + tag + ' closed (' + code + ') during "' + phase + '"'));
    c.ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
      if (/^Inspector\./.test(m.method || '')) say('  ' + tag + ' ' + m.method + ' ' + JSON.stringify(m.params || {}));
    });
  }
  return c;
}

/** A CDP session that also keeps every console line about CSP. */
async function attach(wsUrl) {
  const c = await openSession(wsUrl);
  c.csp = [];
  c.ws.on('message', (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (m.method === 'Log.entryAdded') {
      const t = String(m.params.entry.text || '');
      if (/Content Security Policy/i.test(t)) c.csp.push(t.slice(0, 220));
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const t = (m.params.args || []).map((a) => a.value).join(' ');
      if (/Content Security Policy/i.test(t)) c.csp.push(t.slice(0, 220));
    }
  });
  await c.send('Log.enable');      // replays every entry since the document loaded
  await c.send('Runtime.enable');
  return c;
}

const ARTICLE = `<!doctype html><html><head><meta charset="utf-8"><title>A test article about tides</title></head><body>
<header><nav><a href="/">Home</a> <a href="/x">Other</a></nav></header>
<article><h1>A test article about tides</h1>
<p style="color: red; font-size: 40px" id="styled">The tide rises and falls twice a day along most coasts, pulled by the moon and, to a lesser degree, the sun. ${'Tides shape the shoreline, the creatures that live between the marks, and the timetable of every harbour. '.repeat(6)}</p>
<p onclick="window.__clicked=1" id="handler">Sailors learned to read the tide tables long before anyone could explain them. ${'A spring tide comes at the new and full moon, a neap tide at the quarters. '.repeat(6)}</p>
<img src="/pic.svg" alt="a wave" id="pic" width="40" height="40">
<script>window.__articleScript = 1</script>
<p>${'The range of a tide depends on the shape of the coast and the sea floor beneath it. '.repeat(8)}</p>
</article></body></html>`;
const PIC = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#468"/></svg>';

async function main() {
  const free = freeRamGb();
  if (!(free >= MIN_FREE_GB)) { console.log('csp-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }

  const srv = await serve((req, res, p) => {
    if (p === '/article.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(ARTICLE); return true; }
    if (p === '/pic.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(PIC); return true; }
    return false;
  });

  const watcher = startWatcher((l) => say(l));
  await watcher.ready;
  const child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + PORT, '--test-profile', '--profile-name=' + PROFILE, ...OFFSCREEN_ARGS],
    { cwd: APP, stdio: 'ignore', env: Object.assign({}, process.env) });
  let gone = false;
  const exitP = new Promise((r) => child.on('exit', () => { gone = true; r(); }));
  watcher.watch(child.pid);
  say('quartz pid ' + child.pid + ' on :' + PORT + ', profile ' + PROFILE);
  // Bounded: a /json request the browser never answers must not outlive waitTarget's own limit.
  const targets = async () => (await fetch('http://127.0.0.1:' + PORT + '/json', { signal: AbortSignal.timeout(5000) })).json();
  async function waitTarget(pred, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { const t = (await targets()).find(pred); if (t) return t; } catch (e) { /* not up yet */ }
      await sleep(150);
    }
    return null;
  }

  let barked;
  const dog = new Promise((_, j) => { barked = j; });
  const watchdog = setTimeout(() => {
    hungIn = phase;
    say('watchdog: still in "' + phase + '" after ' + WATCHDOG_S + ' s; closing the DevTools sessions so the run ends with its summary');
    for (const s of sessions) { try { s.ws.terminate(); } catch (e) { /* already closed */ } }
    barked(new Error('the watchdog ended the run in "' + phase + '"'));
  }, WATCHDOG_S * 1000);

  let chrome = null;
  try {
    // The run races the watchdog, so a step stuck on anything (not only a DevTools call) still ends.
    await Promise.race([dog, (async () => {
      setPhase('chrome: boot');
      const ct = await waitTarget((x) => x.type === 'page' && /index\.html/.test(String(x.url)), 30000);
      if (!ct) throw new Error('the chrome page never came up on :' + PORT + (gone ? ' (the process exited)' : ''));
      chrome = await attach(ct.webSocketDebuggerUrl);
      await chrome.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await chrome.ev(LISTENER + '1');
      // The chrome document this run started on. If anything reloaded the window, the final count
      // below would read an empty, fresh listener and pass for nothing: it checks this mark first.
      const chromeMark = 'boot-' + Date.now();
      await chrome.ev('window.__cspMark = ' + JSON.stringify(chromeMark) + ', 1');
      await chrome.waitFor('typeof createTab === "function" && typeof activateTab === "function" && Array.isArray(tabs) && tabs.length > 0 && !restoring', 30000);
      check(true, 'chrome: booted with its policy (every script file ran: app.js globals are up)');
      check(await chrome.ev('typeof Terminal === "function" && !!window.Settings && !!window.Reader'), 'chrome: xterm, settings.js and reader.js loaded under script-src file:');

      await sleep(1500);
      const boot = chrome.csp.slice();       // the console since the chrome loaded (Log replay)
      check(boot.length === 0, 'chrome: zero CSP violations during boot', boot);

      setPhase('chrome: inline script and eval probes');
      // The policy is really in force: an inline script must not run, eval must throw.
      const inl = await chrome.ev(`(function(){var s=document.createElement('script');s.textContent='window.__inlineRan=1';document.head.appendChild(s);s.remove();return window.__inlineRan===1;})()`);
      check(inl === false, 'chrome: an injected inline <script> does NOT run');
      // eval is tried from a task of the PAGE's own (a timer), never inside the DevTools evaluation:
      // Runtime.evaluate lifts 'unsafe-eval' for the code it runs (its allowUnsafeEvalBlockedByCSP
      // parameter defaults to true), so an eval typed straight into it runs on ANY policy and proves
      // nothing. A timer callback is outside that scope and gets exactly what the chrome's own scripts get.
      const ev = await chrome.ev(`new Promise(function (done) { setTimeout(function () {
        var r = {};
        try { (0, eval)('1'); r.eval = 'ran'; } catch (e) { r.eval = e.name; }
        try { Function('return 1')(); r.fn = 'ran'; } catch (e) { r.fn = e.name; }
        done(r);
      }, 0); })`);
      check(ev && ev.eval === 'EvalError' && ev.fn === 'EvalError', 'chrome: eval and new Function are refused (tried from a page task, outside DevTools)', ev);
      await sleep(300);
      const expected = chrome.csp.length;  // boot + those two refusals, counted out below
      check(expected > boot.length, 'chrome: the console reports those refusals (the detector works)', chrome.csp.slice(boot.length));

      setPhase('chrome: Settings > About');
      // Settings > About and its age sentence.
      await chrome.ev(`window.Settings.open('About'), 1`);
      const about = await chrome.waitFor(`(function(){var a=document.querySelector('#settings-panel .set-about');if(!a)return '';var n=a.nextElementSibling;return a.textContent+' | '+(n?n.textContent:'');})()`, 10000).catch((e) => 'ERR ' + e.message);
      check(/Chromium \d+/.test(about) && /(was built on|cannot be shown)/.test(about), 'chrome: About shows Chromium and its age (or why not)', about);
      say('About reads: ' + about);
      await chrome.ev(`(function(){var b=document.getElementById('settings');if(b)b.click();return 1})()`).catch(() => 0);

      setPhase('chrome: a terminal tab opens');
      // A terminal tab: xterm's DOM renderer adds <style> elements (inline style is allowed here).
      const termBefore = await chrome.ev('tabs.length');
      await chrome.ev(`Promise.resolve(openTerminalTab('term:cmd')).then(function(){return 1})`).catch((e) => say('terminal: ' + e.message));
      const xt = await chrome.waitFor(`!!document.querySelector('.xterm .xterm-rows, .xterm-screen')`, 15000).catch(() => false);
      check(!!xt, 'chrome: a terminal tab draws its xterm screen');
      const termTab = await chrome.ev(`(tabs.length > ${termBefore}) ? tabs[tabs.length - 1].id : null`);
      setPhase('chrome: the terminal tab closes');
      if (termTab != null) await chrome.ev(`closeTab(${JSON.stringify(termTab)}), 1`).catch(() => 0);

      // ---- the guest pages ----
      const base = await chrome.ev('location.href.replace(/index\\.html.*$/, "")');
      const pages = [
        { file: 'newtab.html', open: `createTab()` },
        { file: 'historypage.html', open: `createTab(${JSON.stringify(base + 'historypage.html')})` },
        { file: 'files.html', open: `openFilesTab()` },
        { file: 'search.html', open: `createTab(${JSON.stringify(base + 'search.html?q=tides')})` },
        { file: 'watch.html', open: `openWatchTab()` },
        { file: 'welcome.html', open: `(window.FirstRun && window.FirstRun.open ? window.FirstRun.open() : createTab(${JSON.stringify(base + 'welcome.html')}))` },
        { file: 'phone.html', open: `createTab(${JSON.stringify(base + 'phone.html')})` },
        { file: 'score-pin.html', open: `createTab(${JSON.stringify(base + 'score-pin.html')})` },
      ];
      let control = null;
      for (const pg of pages) {
        setPhase(pg.file + ': open');
        const re = new RegExp('/' + pg.file.replace('.', '\\.') + '(?:[?#]|$)');
        const before = new Set((await targets()).map((t) => t.id));
        await chrome.ev(pg.open + ', 1').catch((e) => say(pg.file + ' open: ' + e.message));
        const t = await waitTarget((x) => x.type === 'webview' && re.test(String(x.url)) && !before.has(x.id), 12000)
          || await waitTarget((x) => x.type === 'webview' && re.test(String(x.url)), 2000);
        if (!t) { check(false, pg.file + ': opened as a tab', 'no webview target for it'); continue; }
        setPhase(pg.file + ': attach and reload');
        const g = await attach(t.webSocketDebuggerUrl);
        await sleep(1500);
        const early = g.csp.slice();             // the console since the page first loaded
        await g.send('Page.enable');
        await g.send('Page.addScriptToEvaluateOnNewDocument', { source: LISTENER });
        g.csp.length = 0;
        // The page reloads ITSELF, from a task of its own. Never CDP's Page.reload here: on a <webview>
        // guest it reloads the EMBEDDER (Chromium sends a guest's Page.reload to its outermost main
        // frame, so a PDF viewer's reload works), i.e. the whole chrome window. Every guest went with
        // it, each session closed, and the next call on the closed socket never answered: the 240 s
        // hang in "newtab.html: attach and reload" on 10-27, locally and on the hosted runner.
        await g.send('Runtime.evaluate', { expression: 'setTimeout(function () { location.reload(); }, 0), 1' });
        // The new document is the one with the listener; then it has a moment to paint.
        const reloaded = await g.waitFor('Array.isArray(window.__cspV) && document.readyState === "complete"', 15000).then(() => true, (e) => e.message);
        if (reloaded !== true) say(pg.file + ': the reload did not finish: ' + reloaded);
        await sleep(1500);
        const v = await g.ev('window.__cspV || ["(listener missing)"]').catch((e) => ['(could not read: ' + e.message + ')']);
        const all = early.concat(g.csp, v);
        check(all.length === 0, pg.file + ': zero CSP violations while it loads and paints', all);
        if (pg.file === 'historypage.html') control = g; else g.close();
      }

      setPhase('control: forced violation on historypage');
      // Positive control: a refused inline style on a guest IS seen by both detectors.
      if (control) {
        control.csp.length = 0;
        await control.ev(`document.body.setAttribute('style','outline:1px solid red'), 1`);
        await sleep(500);
        const seen = await control.ev('window.__cspV.length');
        check(seen >= 1 && control.csp.length >= 1, 'control: a forced inline-style violation on historypage IS detected (event + console)', { events: seen, console: control.csp.length });
        control.close();
      }

      setPhase('reader: article and reader.html');
      // ---- reader.html on a served article ----
      const art = 'http://127.0.0.1:' + srv.port + '/article.html';
      await chrome.ev(`createTab(${JSON.stringify(art)}), 1`);
      const at = await waitTarget((x) => x.type === 'webview' && String(x.url) === art, 12000);
      check(!!at, 'reader: the article tab loaded');
      if (at) {
        const ag = await openSession(at.webSocketDebuggerUrl);
        await ag.waitFor('document.readyState === "complete"', 10000).catch(() => 0);
        ag.close();
        await sleep(500);
        await chrome.ev('window.Reader.open(), 1');
        const rt = await waitTarget((x) => x.type === 'webview' && /\/reader\.html/.test(String(x.url)), 15000);
        check(!!rt, 'reader: reader.html opened for it');
        if (rt) {
          const rg = await attach(rt.webSocketDebuggerUrl);
          const filled = await rg.waitFor(`document.querySelector('.is-filled') ? 1 : 0`, 15000).catch(() => 0);
          check(!!filled, 'reader: the article is shown');
          // The picture is a network fetch the page makes after it fills: give it time to finish
          // (or fail) before judging it, or a slow runner reads "not loaded yet" as "refused".
          await rg.waitFor(`(function(){var i=document.querySelector('.is-filled img');return !i||i.complete?1:0;})()`, 8000).catch(() => 0);
          const st = await rg.ev(`(function(){var c=document.querySelector('.is-filled');if(!c)return null;var img=c.querySelector('img');
            return {styled:c.querySelectorAll('[style]').length,handlers:c.querySelectorAll('[onclick]').length,scripts:c.querySelectorAll('script').length,
            ran:window.__articleScript===1,img:!!img,imgLoaded:!!(img&&img.complete&&img.naturalWidth>0)};})()`);
          check(st && st.styled === 0 && st.handlers === 0 && st.scripts === 0 && !st.ran, 'reader: no style=, no on*= handler, no <script> reached the page', st);
          check(st && st.img && st.imgLoaded, 'reader: the article image loaded under img-src http:', st);
          await sleep(500);
          check(rg.csp.length === 0, 'reader: zero CSP console lines while the article was applied', rg.csp);
          rg.close();
        }
      }

      setPhase('chrome: final count');
      // ---- and the chrome, after all of that ----
      await sleep(500);
      const sameChrome = await chrome.ev('window.__cspMark').catch(() => null);
      check(sameChrome === chromeMark, 'chrome: still the document it booted as (no guest reload took the window with it)', sameChrome);
      const chromeLines = chrome.csp.slice(expected);
      const chromeEvents = await chrome.ev('(window.__cspV || []).filter(function (s) { return !/^script-src(-elem)? <- (inline|eval)/.test(s); })');
      check(chromeLines.length === 0 && chromeEvents.length === 0, 'chrome: zero other CSP violations through boot, About, a terminal and nine guest pages', { console: chromeLines, events: chromeEvents });
    })()]);
  } catch (e) {
    if (!hungIn) check(false, 'run', e && e.message || String(e)); // a hang is the FAIL just below
  } finally {
    clearTimeout(watchdog);
    if (hungIn) check(false, 'no step hung: "' + hungIn + '" had not answered after ' + WATCHDOG_S + ' s (the DevTools sessions were closed to end the run)');
    if (chrome) {
      await chrome.ev('setTimeout(() => window.close(), 50), 1').catch(() => 0);
      chrome.close();
    }
    await Promise.race([exitP, sleep(20000)]);
    if (!gone) {
      say('quartz did not exit in 20 s; killing pid ' + child.pid + ' (that process only)');
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/F'], { stdio: 'ignore' }); } catch (e) { /* already gone */ }
      await Promise.race([exitP, sleep(5000)]);
    }
    const v = watcher.verdict(); check(v.ok, v.line); watcher.stop();
    srv.close();
    await sleep(1500);
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (e) { say('could not delete ' + PROFILE_DIR + ': ' + e.message); }
  }
  console.log(`csp-e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
