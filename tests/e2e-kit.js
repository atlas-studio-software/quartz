// tests/e2e-kit.js -- the shared half of the daily-path e2e harnesses (sessions-e2e.js,
// sleep-e2e.js, find-e2e.js, downloads-e2e.js, omnibox-e2e.js).
//
// The same launch every e2e file in the repo uses, factored out once so five harnesses do not carry
// five copies of it: a REAL Quartz test instance, --test-profile with its own --profile-name (a temp
// profile under %TEMP%), off-screen and never focused (testwatch.js OFFSCREEN_ARGS), watched from
// before launch by testwatch.js. Every launch gets its own watcher, and each watcher's verdict is a
// check: a harness that restarts Quartz proves the window stayed off-screen on EVERY boot.
// Refuses to launch under 2.5 GB free RAM (exit 3, "<name>: not launched: ..."), which run-suite.js
// reports as SKIP. Kills ONLY the processes it started, deletes its temp profile, and prints one
// summary line: "<name>: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const APP = path.join(__dirname, '..');
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const WS = require(path.join(APP, 'node_modules', 'ws'));
const { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb, startWatcher } = require(path.join(APP, 'testwatch'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- CDP (the same small client log-e2e.js carries) ---------------------------------------- */
class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WS(this.wsUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { this.ws.on('open', r); this.ws.on('error', j); });
    this.ws.on('message', (raw) => { const m = JSON.parse(String(raw)); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m); } });
    this.ws.on('close', () => { for (const p of this.pending.values()) p({ error: { message: 'connection closed' } }); this.pending.clear(); });
    return this;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve) => {
      // ws DROPS a send() on a closed socket (no callback, no throw): answer now, or the caller waits for ever.
      if (!this.ws || this.ws.readyState !== WS.OPEN) { resolve({ error: { message: 'connection closed' } }); return; }
      // callMs (opt-in, set by a harness): a call with no answer by then fails with its method instead
      // of waiting for ever, so a stuck page reads as a FAIL with a reason, not as the suite's timeout.
      let timer = null;
      const done = (m) => { if (timer) clearTimeout(timer); resolve(m); };
      this.pending.set(id, done);
      if (this.callMs > 0) timer = setTimeout(() => { if (this.pending.delete(id)) resolve({ error: { message: 'no answer in ' + this.callMs + ' ms to ' + method } }); }, this.callMs);
      try { this.ws.send(JSON.stringify({ id, method, params: params || {} })); } catch (e) { this.pending.delete(id); done({ error: { message: String(e.message || e) } }); }
    });
  }
  async ev(expr) {
    const m = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (m.error) throw new Error(JSON.stringify(m.error) + (/^no answer in/.test(m.error.message || '') ? ' evaluating: ' + String(expr).slice(0, 160) : ''));
    if (m.result.exceptionDetails) throw new Error('threw: ' + ((m.result.exceptionDetails.exception || {}).description || m.result.exceptionDetails.text));
    return m.result.result.value;
  }
  async waitFor(expr, ms) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < (ms || 10000)) { try { last = await this.ev(expr); if (last) return last; } catch (e) { last = e.message; } await sleep(100); }
    throw new Error('timed out: ' + expr.slice(0, 160) + ' (last ' + JSON.stringify(last).slice(0, 200) + ')');
  }
  /** Real keyboard input into whatever element of this page has focus. */
  async key(key, opts) {
    const o = Object.assign({ code: key, vk: 0, mods: 0 }, opts || {});
    const base = { key, code: o.code, windowsVirtualKeyCode: o.vk, nativeVirtualKeyCode: o.vk, modifiers: o.mods };
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
    await this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  }
  async type(text) { await this.send('Input.insertText', { text }); }
  /** A PNG of this page to `file`, with a hard 15 s stop (a capture once hung a cloud run 25 min). */
  async shot(file) {
    const m = await Promise.race([
      this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
      sleep(15000).then(() => ({ error: { message: 'captureScreenshot timed out after 15 s' } })),
    ]);
    if (m.error || !m.result || !m.result.data) throw new Error((m.error && m.error.message) || 'no data');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(m.result.data, 'base64'));
    console.log('[e2e] shot ' + file);
    return file;
  }
  close() { try { this.ws.close(); } catch (e) { /* gone */ } }
}
const KEYS = {
  Enter: { code: 'Enter', vk: 13 },
  Escape: { code: 'Escape', vk: 27 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
};
const SHIFT = 8;

/* ---- a local page server ---------------------------------------------------------------------- */
/** handler(req, res, pathname) returns true when it answered. Counts every request by pathname. */
function serve(handler) {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const p = String(req.url || '').split('?')[0];
    hits.set(p, (hits.get(p) || 0) + 1);
    try { if (handler(req, res, p)) return; } catch (e) { /* fall through to 404 */ }
    if (!res.headersSent) { res.writeHead(404); res.end('no'); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, hits: (p) => hits.get(p) || 0, close: () => server.close() }));
  });
}
function html(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
  return true;
}

/* ---- the harness ------------------------------------------------------------------------------ */
/**
 * run(name, async (k) => { ... }): the whole life of one harness file. k has
 *   check(cond, name, detail)   a PASS/FAIL line;
 *   launch(opts)                a Quartz test instance on this harness's profile (see below);
 *   profileDir                  its temp profile folder (the same one across restarts);
 *   say(line)                   a [e2e] line.
 */
function run(name, body) {
  let pass = 0, fail = 0;
  const check = (cond, label, detail) => {
    if (cond) pass++; else fail++;
    console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail !== undefined ? '  ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''));
  };
  const say = (l) => console.log('[e2e] ' + l);
  const profile = name.replace(/[^a-z0-9]/gi, '') + process.pid;
  const profileDir = path.join(os.tmpdir(), 'browser-test-profile-' + profile);
  const live = [];

  /**
   * One boot of Quartz on this harness's profile. opts: { cdp, env, args }.
   * Returns { chrome, child, exited(), quit(), kill() } once the chrome page is up and app.js's
   * globals exist. quit() closes the window the way a user does and waits for the process to end;
   * kill() is taskkill /T /F on the pid it started (a crash, as far as Quartz can tell).
   */
  async function launch(opts) {
    const o = opts || {};
    const port = o.cdp;
    const watcher = startWatcher((l) => say(l));
    await watcher.ready;
    const env = Object.assign({}, process.env, o.env || {});
    // Lumen is opt-in: a profile with NO watch.json reads every service as off (watch-main.js cleanPrefs).
    // These runs exercise Lumen the way an existing install has it, so a profile without one starts from
    // a pre-opt-in "{}" (every service on, migrated to v2 on first boot) unless the harness asks for a
    // fresh install with opts.freshLumen. A seed that cannot be written is said, never skipped quietly.
    if (!o.freshLumen) {
      const wj = path.join(profileDir, 'watch.json');
      try {
        if (!fs.existsSync(wj)) { fs.mkdirSync(profileDir, { recursive: true }); fs.writeFileSync(wj, '{}'); }
      } catch (e) { say('could not seed watch.json (Lumen will start all-off): ' + e.message); }
    }
    const child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + port, '--test-profile', '--profile-name=' + profile, ...OFFSCREEN_ARGS, ...(o.args || [])], { cwd: APP, stdio: 'ignore', env });
    let gone = false;
    const exitP = new Promise((r) => child.on('exit', () => { gone = true; r(); }));
    watcher.watch(child.pid);
    const inst = { child, watcher, chrome: null, judged: false };
    live.push(inst);
    say('quartz pid ' + child.pid + ' on :' + port);
    const targets = async () => (await fetch('http://127.0.0.1:' + port + '/json')).json();
    let ct = null;
    for (let i = 0; i < 200 && !ct && !gone; i++) {
      try { ct = (await targets()).find((x) => x.type === 'page' && /index\.html/.test(String(x.url))); } catch (e) { /* not up yet */ }
      if (!ct) await sleep(150);
    }
    if (!ct) throw new Error('the chrome page never came up on :' + port + (gone ? ' (the process exited)' : ''));
    inst.chrome = await new Cdp(ct.webSocketDebuggerUrl).open();
    // The window is never focused (--show-inactive, off-screen); without this the chrome's
    // document reports no focus and real key events have nowhere to land.
    await inst.chrome.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await inst.chrome.waitFor('typeof createTab === "function" && typeof activateTab === "function" && Array.isArray(tabs) && tabs.length > 0 && !restoring', 30000);
    inst.targets = targets;
    inst.exited = () => gone;
    inst.judge = () => {
      if (inst.judged) return;
      inst.judged = true;
      const v = watcher.verdict(); check(v.ok, v.line); watcher.stop();
    };
    inst.quit = async () => {
      await inst.chrome.ev('setTimeout(() => window.close(), 50), 1').catch(() => 0);
      inst.chrome.close();
      await Promise.race([exitP, sleep(20000)]);
      inst.judge();
      return gone;
    };
    inst.kill = async () => {
      inst.chrome.close();
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ }
      await Promise.race([exitP, sleep(10000)]);
      await sleep(800); // the helpers go with the tree; let their handles on the profile close
      inst.judge();
      return gone;
    };
    return inst;
  }

  (async () => {
    try {
      const free = freeRamGb();
      if (!(free >= MIN_FREE_GB)) { console.log(name + ': not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB + ' GB'); process.exit(3); }
      await body({ check, launch, say, profileDir, sleep });
    } catch (e) {
      check(false, 'HARNESS ERROR ' + (e && e.stack || e));
    } finally {
      for (const inst of live) {
        if (inst.chrome) inst.chrome.close();
        if (!inst.exited || !inst.exited()) { try { execFileSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ } }
        if (!inst.judged) { inst.judged = true; const v = inst.watcher.verdict(); check(v.ok, v.line); inst.watcher.stop(); }
      }
      if (live.length) await sleep(1200);
      for (let i = 0; i < 10; i++) { try { fs.rmSync(profileDir, { recursive: true, force: true }); break; } catch (e) { await sleep(400); } }
      console.log(`${name}: ${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    }
  })();
}

module.exports = { run, serve, html, Cdp, KEYS, SHIFT, sleep, APP };
