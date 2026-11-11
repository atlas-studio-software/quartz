require('./tools/lowcpu-optional');
// debugport-e2e.js -- a --remote-debugging-port that is already taken (cdp-main.js decideCommandLine),
// in a REAL Quartz test copy (--test-profile --profile-name=debugport, off-screen, one at a time).
//
//   A  port N held by a dummy server: Quartz lands on N+1, which proves app.commandLine.appendSwitch
//      replaces a value the command line already carried; cdp.json records { requested: N, port: N+1,
//      reason, notice }; the window shows the notice; nothing of Quartz's listens on N.
//   B  N..N+8 all held: no port at all, and cdp.json says so with the reason (the window has no port
//      to be driven over, so its notice is checked through the log line instead).
// Refuses to start under 2.5 GB free RAM (exit 3) or when any of N..N+9 is already in use. Kills only
// the processes it started (matched by its own --profile-name), deletes its temp profile, and ends
// with "debugport-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { Cdp, sleep } = require('./tests/e2e-kit');
const { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb } = require('./testwatch');
const cdpMain = require('./cdp-main');

const APP = __dirname;
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const N = Number(process.env.DEBUGPORT_E2E_PORT) || 9481;   // never 9222, never the user's port
const SPAN = cdpMain.CLI_FALLBACK_SPAN;
const NAME = 'debugport';
const DIR = path.join(os.tmpdir(), 'browser-test-profile-' + NAME);
const say = (l) => console.log('[debugport-e2e] ' + l);

let pass = 0, fail = 0;
function check(cond, name, detail) {
  if (cond) { pass++; say('ok   ' + name); } else { fail++; say('FAIL ' + name + (detail ? ': ' + detail : '')); }
}

/** pids of every electron.exe carrying this run's --profile-name (never anything else). */
function ourPids() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*--profile-name=" + NAME + " *' -or $_.CommandLine -like '*--profile-name=" + NAME + "' } | ForEach-Object { $_.ProcessId }"],
  { encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '').split(/\s+/).filter(Boolean).map(Number).filter((p) => p !== process.pid);
}
function killOurs() {
  for (const pid of ourPids()) { try { process.kill(pid); } catch { /* already gone */ } }
}

/** { port: [pids] } of everything LISTENING on the ports asked about, from one netstat run. */
function listeners(ports) {
  const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  const map = {};
  for (const p of ports) map[p] = cdpMain.parseNetstat(out, p);
  return map;
}

function hold(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((s) => s.destroy());
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function readState() { try { return JSON.parse(fs.readFileSync(path.join(DIR, cdpMain.STATE_FILE), 'utf8')); } catch { return null; } }

async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { last = await fn(); if (last) return last; await sleep(150); }
  throw new Error('timed out waiting for ' + what);
}

/** Boot a test copy with --remote-debugging-port=N; resolves once cdp.json has its final answer. */
async function boot(label) {
  try { fs.unlinkSync(path.join(DIR, cdpMain.STATE_FILE)); } catch { /* none yet */ }
  const child = spawn(ELECTRON, ['.', '--test-profile', '--profile-name=' + NAME, '--remote-debugging-port=' + N, ...OFFSCREEN_ARGS],
    { cwd: APP, stdio: 'ignore', env: Object.assign({}, process.env) });
  let gone = false;
  child.on('exit', () => { gone = true; });
  say(label + ': quartz pid ' + child.pid);
  const state = await waitFor(() => {
    if (gone) throw new Error(label + ': Quartz exited during startup');
    const s = readState();
    return s && s.pid === child.pid && !/waiting/.test(String(s.error || '')) ? s : null;
  }, 45000, label + ' cdp.json');
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

function logText() { try { return fs.readFileSync(path.join(DIR, 'quartz.log'), 'utf8'); } catch { return ''; } }
/** true once quartz.log has a line matching re (the log may land a moment after cdp.json). */
function logHas(re) { return waitFor(() => re.test(logText()), 8000, 'quartz.log').then(() => true, () => false); }

async function main() {
  const free = freeRamGb();
  if (free < MIN_FREE_GB) { console.log('debugport-e2e: not launched: ' + free.toFixed(2) + ' GB free RAM, needs ' + MIN_FREE_GB); process.exit(3); }
  const range = []; for (let p = N; p <= N + SPAN + 1; p++) range.push(p);
  const busyNow = range.filter((p) => listeners([p])[p].length);
  if (busyNow.length) { console.log('debugport-e2e: not launched: port(s) ' + busyNow.join(', ') + ' already in use (set DEBUGPORT_E2E_PORT)'); process.exit(3); }
  if (ourPids().length) { console.log('debugport-e2e: not launched: a copy with --profile-name=' + NAME + ' is already running'); process.exit(3); }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* fresh below */ }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'watch.json'), '{}');

  /* ---- A: N held, Quartz on N+1 ---- */
  const holder = await hold(N);
  say('A: holding ' + N + ' in this process (pid ' + process.pid + ')');
  const a = await boot('A');
  const s = a.state;
  check(s.ok === true && s.port === N + 1, 'A: on at N+1 (' + (N + 1) + '): appendSwitch replaced the command-line value', JSON.stringify(s));
  check(s.requested === N && s.requestedPort === N && s.plannedPort === N + 1 && s.mode === 'command-line-fallback',
    'A: cdp.json records requested ' + N + ' and the planned port', JSON.stringify({ requested: s.requested, plannedPort: s.plannedPort, mode: s.mode }));
  check(/already in use \(pid \d+/.test(String(s.reason)) && new RegExp('next free port, ' + (N + 1)).test(String(s.reason)), 'A: reason names the holder pid and the port taken', s.reason);
  const sentence = 'Remote debugging port ' + N + ' was in use by another process, so Quartz is on ' + (N + 1) + '.';
  check(s.notice === sentence, 'A: cdp.json carries the notice sentence', s.notice);
  const active = cdpMain.readActivePort(DIR);
  check(active && active.port === N + 1, 'A: DevToolsActivePort says ' + (N + 1), JSON.stringify(active));
  const l = listeners([N, N + 1]);
  check(l[N].length === 1 && l[N][0] === process.pid, 'A: only the dummy holds ' + N, JSON.stringify(l[N]));
  check(l[N + 1].length > 0 && l[N + 1].every((p) => p !== process.pid), 'A: Quartz listens on ' + (N + 1), JSON.stringify(l[N + 1]));
  check(await logHas(new RegExp('DevTools \\(CDP\\) is on at 127\\.0\\.0\\.1:' + (N + 1))), 'A: quartz.log says where it is');
  const chrome = await chromeOf(N + 1).catch((e) => { check(false, 'A: the chrome page came up on N+1', e.message); return null; });
  if (chrome) {
    const shown = await chrome.waitFor('(() => { const t = document.getElementById("settings-toast"); return window.__quartzCdpNotice && t && t.textContent === window.__quartzCdpNotice ? t.textContent : ""; })()', 15000).catch((e) => 'ERR ' + e.message);
    check(shown === sentence, 'A: the window shows the notice', String(shown).slice(0, 300));
    const t = await chrome.waitFor('(() => { try { Settings.open("Claude"); } catch (e) {} const f = document.querySelector(\'[data-field="claudecdp"]\'); return f && /This run/.test(f.textContent) ? f.textContent : ""; })()', 10000).catch((e) => 'ERR ' + e.message);
    check(new RegExp('on at 127\\.0\\.0\\.1:' + (N + 1)).test(t) && /already in use/.test(t), 'A: Settings > Claude says where and why', t.slice(0, 300));
  }
  await stop(a, chrome);
  check(listeners([N + 1])[N + 1].length === 0, 'A: ' + (N + 1) + ' is free again after Quartz quit', JSON.stringify(listeners([N + 1])[N + 1]));

  /* ---- B: N..N+8 all held, no port ---- */
  const more = [];
  for (let p = N + 1; p <= N + SPAN; p++) more.push(await hold(p));
  const b = await boot('B');
  const sb = b.state;
  check(sb.ok === false && sb.mode === 'command-line-busy' && sb.port === null, 'B: no port this run', JSON.stringify(sb));
  check(new RegExp('port ' + N + ' was in use by another process, and so were ports ' + (N + 1) + '-' + (N + SPAN) + ', so remote debugging is off').test(String(sb.notice)),
    'B: the notice says off and why', sb.notice);
  check(/off for this run/.test(String(sb.error)), 'B: cdp.json error says why', sb.error);
  const lb = listeners(range.slice(0, SPAN + 1));
  check(Object.values(lb).every((pids) => pids.length === 1 && pids[0] === process.pid), 'B: Quartz holds none of ' + N + '..' + (N + SPAN), JSON.stringify(lb));
  check(await logHas(/DevTools \(CDP\) is NOT available: .*off for this run/), 'B: quartz.log says it is off and why');
  say('B: the window notice is not driven here (no port to drive it over); A covers the same code path');
  await stop(b, null);
  for (const srv of more) srv.close();
  holder.close();
}

main().catch((e) => { fail++; say('FAIL crashed: ' + ((e && e.stack) || e)); }).finally(() => {
  killOurs();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { say('could not delete the temp profile ' + DIR + ': ' + e.message); }
  console.log(`debugport-e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
