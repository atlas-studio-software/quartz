require('./tools/lowcpu-optional');
// cdp-e2e.js -- the always-on DevTools (CDP) port (cdp-main.js) in a REAL Quartz test copy.
//
// Every boot is a --test-profile copy, off-screen, one at a time. QUARTZ_TEST_CDP_DEFAULT_PORT makes a
// test copy plan exactly like a normal start, on PORT instead of 9219, so the real default port (and the
// browser the user is running on it) is never touched. Boots, in order:
//   A  no port on the command line: the default port opens on 127.0.0.1 ONLY (netstat, and a connect
//      to this machine's LAN address is refused), cdp.json and DevToolsActivePort agree,
//      tools/cdp-endpoint.js finds it, Settings > Claude says so.
//      A2 (while A runs) a second copy on the same profile with a link: it hands the link over and
//      exits, the link opens as a tab in A, and cdp.json still belongs to A.
//   B  PORT held by another process: a free port instead, and cdp.json says which pid held PORT.
//   C  turned off (cdp-prefs.json, what the Settings switch writes): no port, cdp.json says why.
//   D  an explicit --remote-debugging-port wins: that port, nothing on PORT.
// Refuses to start under 2.5 GB free RAM (exit 3). Kills only the processes it started (matched by its
// own --profile-name), deletes its temp profile, and ends with "cdp-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { Cdp, sleep, serve, html } = require('./tests/e2e-kit');
const { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb } = require('./testwatch');
const cdpMain = require('./cdp-main');
const endpoint = require('./tools/cdp-endpoint');

const APP = __dirname;
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = Number(process.env.CDP_E2E_PORT) || 9671;     // the stand-in for 9219
const CLI_PORT = PORT + 1;
const NAME = 'cdpe2e' + process.pid;
const DIR = path.join(os.tmpdir(), 'browser-test-profile-' + NAME);
const say = (l) => console.log('[cdp-e2e] ' + l);

let pass = 0, fail = 0;
function check(cond, name, detail) {
  if (cond) { pass++; say('ok   ' + name); } else { fail++; say('FAIL ' + name + (detail ? ': ' + detail : '')); }
}

/** pids of every process carrying this run's --profile-name (never anything else). */
function ourPids() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    // electron.exe only: this PowerShell's own command line carries the same text.
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*--profile-name=" + NAME + "*' } | ForEach-Object { $_.ProcessId }"], { encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '').split(/\s+/).filter(Boolean).map(Number).filter((p) => p !== process.pid);
}
function killOurs() {
  for (const pid of ourPids()) { try { process.kill(pid); } catch { /* already gone */ } }
}

/** Local addresses LISTENING on `port`, from netstat. */
function listenAddrs(port) {
  const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  const addrs = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+(\S+)\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (m && Number(m[2]) === port && /:0$/.test(m[3])) addrs.push(m[1] + ' pid ' + m[4]);
  }
  return addrs;
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}
function tryConnect(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 1500 });
    s.on('connect', () => { s.destroy(); resolve('connected'); });
    s.on('timeout', () => { s.destroy(); resolve('timeout'); });
    s.on('error', (e) => resolve(e.code || e.message));
  });
}

function readState() { try { return JSON.parse(fs.readFileSync(path.join(DIR, cdpMain.STATE_FILE), 'utf8')); } catch { return null; } }

async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { last = await fn(); if (last) return last; await sleep(150); }
  throw new Error('timed out waiting for ' + what);
}

/** Boot a test copy; resolves once cdp.json has its final answer (ok, or a settled failure). */
async function boot(label, extraArgs, envExtra) {
  // cdp.json from the boot before must not read as this one's.
  try { fs.unlinkSync(path.join(DIR, cdpMain.STATE_FILE)); } catch { /* none yet */ }
  const env = Object.assign({}, process.env, { QUARTZ_TEST_CDP_DEFAULT_PORT: String(PORT) }, envExtra || {});
  const child = spawn(ELECTRON, ['.', '--test-profile', '--profile-name=' + NAME, ...OFFSCREEN_ARGS, ...(extraArgs || [])], { cwd: APP, stdio: 'ignore', env });
  let gone = false;
  child.on('exit', () => { gone = true; });
  say(label + ': quartz pid ' + child.pid);
  const state = await waitFor(() => {
    if (gone) throw new Error(label + ': Quartz exited during startup');
    const s = readState();
    return s && s.pid === child.pid && !/waiting/.test(String(s.error || '')) ? s : null;
  }, 40000, label + ' cdp.json');
  return { child, state, exited: () => gone };
}

async function chromeOf(port) {
  const ct = await waitFor(async () => {
    try { return (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find((x) => x.type === 'page' && /index\.html/.test(String(x.url))); } catch { return null; }
  }, 30000, 'the chrome page on :' + port);
  const c = await new Cdp(ct.webSocketDebuggerUrl).open();
  await c.waitFor('typeof createTab === "function" && Array.isArray(tabs) && tabs.length > 0 && !restoring', 30000);
  return c;
}

async function stop(inst, chrome) {
  if (chrome) { await chrome.ev('setTimeout(() => window.close(), 50), 1').catch(() => 0); chrome.close(); }
  const t0 = Date.now();
  while (!inst.exited() && Date.now() - t0 < 15000) await sleep(200);
  if (!inst.exited() || ourPids().length) { say('closing did not end every process; killing this run\'s own pids'); killOurs(); await sleep(1000); }
}

async function main() {
  const free = freeRamGb();
  if (free < MIN_FREE_GB) { console.log('cdp-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB); process.exit(3); }
  if (listenAddrs(PORT).length || listenAddrs(CLI_PORT).length) { console.log('cdp-e2e: not launched: port ' + PORT + ' or ' + CLI_PORT + ' is already in use (set CDP_E2E_PORT)'); process.exit(3); }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'watch.json'), '{}');

  /* ---- A: the default port ---- */
  let a = await boot('A');
  check(a.state.ok && a.state.port === PORT && a.state.mode === 'default', 'A: on at the default port', JSON.stringify(a.state));
  const addrs = listenAddrs(PORT);
  check(addrs.length > 0 && addrs.every((x) => /^127\.0\.0\.1 /.test(x)), 'A: bound to 127.0.0.1 only', addrs.join('; '));
  const lan = lanAddress();
  if (lan) {
    const r = await tryConnect(lan, PORT);
    check(r !== 'connected', 'A: not reachable on the LAN address ' + lan, r);
  } else say('skip A LAN connect: this machine has no LAN IPv4 address');
  const active = cdpMain.readActivePort(DIR);
  check(active && active.port === PORT && a.state.ws === 'ws://127.0.0.1:' + PORT + active.wsPath, 'A: cdp.json matches DevToolsActivePort', JSON.stringify(active));
  const found = await endpoint.find(DIR);
  check(found.ok && found.port === PORT && found.ws === a.state.ws && found.pid === a.child.pid, 'A: tools/cdp-endpoint.js finds it', JSON.stringify(found));
  const helper = spawnSync(process.execPath, [path.join(APP, 'tools', 'cdp-endpoint.js'), '--dir=' + DIR], { encoding: 'utf8' });
  check(helper.status === 0 && helper.stdout.startsWith('ok   http://127.0.0.1:' + PORT), 'A: the helper CLI prints it', helper.stdout.trim());
  const chrome = await chromeOf(PORT);
  const settingsText = await chrome.waitFor('(() => { try { Settings.open("Claude"); } catch (e) {} const f = document.querySelector(\'[data-field="claudecdp"]\'); return f && /on at 127/.test(f.textContent) ? f.textContent : ""; })()', 10000).catch((e) => 'ERR ' + e.message);
  check(new RegExp('This run: on at 127\\.0\\.0\\.1:' + PORT).test(settingsText) && /Let local tools drive/.test(settingsText), 'A: Settings > Claude shows the port', settingsText.slice(0, 300));

  /* ---- A2: second-instance handoff ---- */
  const srv = await serve((req, res) => html(res, '<title>handoff</title><p>handoff page</p>'));
  const url = 'http://127.0.0.1:' + srv.port + '/handoff';
  const second = spawn(ELECTRON, ['.', '--test-profile', '--profile-name=' + NAME, ...OFFSCREEN_ARGS, url], { cwd: APP, stdio: 'ignore', env: Object.assign({}, process.env, { QUARTZ_TEST_CDP_DEFAULT_PORT: String(PORT) }) });
  const code = await new Promise((r) => { const t = setTimeout(() => r('still running after 20 s'), 20000); second.on('exit', (c) => { clearTimeout(t); r(c); }); });
  check(code === 0, 'A2: the second copy hands over and exits', String(code));
  const opened = await chrome.waitFor('tabs.some((t) => String(t.url || "").includes("/handoff"))', 15000).catch((e) => e.message);
  check(opened === true, 'A2: the link opened as a tab in the running copy', String(opened));
  const after = readState();
  check(after && after.pid === a.child.pid && after.ok && after.port === PORT, 'A2: cdp.json still belongs to the first copy', JSON.stringify(after));
  srv.close();
  await stop(a, chrome);
  check(listenAddrs(PORT).length === 0, 'A: port closed after quit', listenAddrs(PORT).join('; '));

  /* ---- B: the default port is busy ---- */
  const holder = net.createServer();
  await new Promise((r, j) => { holder.once('error', j); holder.listen(PORT, '127.0.0.1', r); });
  let b = await boot('B');
  const bs = b.state;
  check(bs.ok && bs.mode === 'fallback' && bs.port && bs.port !== PORT && bs.requestedPort === PORT, 'B: fell back to a free port', JSON.stringify(bs));
  check(new RegExp('port ' + PORT + ' was already in use \\(pid ' + process.pid + '\\)').test(bs.reason || ''), 'B: the reason names the port and the pid holding it', bs.reason);
  const bAddrs = bs.port ? listenAddrs(bs.port) : [];
  check(bAddrs.length > 0 && bAddrs.every((x) => /^127\.0\.0\.1 /.test(x)), 'B: the fallback port is 127.0.0.1 only', bAddrs.join('; '));
  const bFound = await endpoint.find(DIR);
  check(bFound.ok && bFound.port === bs.port, 'B: tools/cdp-endpoint.js finds the fallback port', JSON.stringify(bFound));
  const bChrome = bs.port ? await chromeOf(bs.port).catch(() => null) : null;
  check(!!bChrome, 'B: the fallback port drives the chrome');
  await stop(b, bChrome);
  holder.close();

  /* ---- C: turned off ---- */
  fs.writeFileSync(path.join(DIR, cdpMain.PREFS_FILE), JSON.stringify({ enabled: false }));
  let c = await boot('C');
  check(!c.state.ok && c.state.mode === 'off' && /Settings > Claude/.test(c.state.error || ''), 'C: off, and cdp.json says why', JSON.stringify(c.state));
  await sleep(1500);
  check(listenAddrs(PORT).length === 0, 'C: nothing listening on the default port', listenAddrs(PORT).join('; '));
  const cFound = await endpoint.find(DIR);
  check(!cFound.ok && /not available/.test(cFound.error), 'C: tools/cdp-endpoint.js says it is off', cFound.error);
  await stop(c, null);
  fs.unlinkSync(path.join(DIR, cdpMain.PREFS_FILE));

  /* ---- D: an explicit port wins ---- */
  let d = await boot('D', ['--remote-debugging-port=' + CLI_PORT]);
  check(d.state.ok && d.state.mode === 'command-line' && d.state.port === CLI_PORT, 'D: the command-line port wins', JSON.stringify(d.state));
  check(listenAddrs(PORT).length === 0, 'D: nothing on the default port', listenAddrs(PORT).join('; '));
  const dChrome = await chromeOf(CLI_PORT).catch(() => null);
  if (dChrome) {
    const t = await dChrome.waitFor('(() => { try { Settings.open("Claude"); } catch (e) {} const f = document.querySelector(\'[data-field="claudecdp"]\'); return f && /This run/.test(f.textContent) ? f.textContent : ""; })()', 10000).catch((e) => 'ERR ' + e.message);
    check(/does not apply/.test(t), 'D: Settings says the switch does not apply to this run', t.slice(0, 300));
  } else check(false, 'D: the chrome page came up on the command-line port');
  await stop(d, dChrome);
}

main().catch((e) => { fail++; say('FAIL crashed: ' + ((e && e.stack) || e)); }).finally(() => {
  killOurs();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { say('could not delete the temp profile ' + DIR + ': ' + e.message); }
  console.log(`cdp-e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
