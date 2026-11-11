// cdp-harness.js - pure-node test for cdp-main.js, the always-on DevTools port (run: node cdp-harness.js).
// Covers every branch of decide(), the locale-free netstat parse, the prefs file, and plan() against
// a fake app on a temp folder (the switch it appends, the stale DevToolsActivePort it deletes, the
// cdp.json it writes before and after confirm(), and the Settings describe/setEnabled pair).
// cdp-e2e.js proves the same against a real Electron.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cdp = require('./cdp-main');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log('FAIL ' + name + (detail ? '\n  ' + detail : '')); } }

/* ---- parseNetstat --------------------------------------------------------------------------- */
const NETSTAT = [
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1100',
  '  TCP    127.0.0.1:9219         0.0.0.0:0              LISTENING       4242',
  '  TCP    127.0.0.1:9219         127.0.0.1:50000        ESTABLISHED     4242',
  '  TCP    127.0.0.1:50000        127.0.0.1:9219         ESTABLISHED     777',
  '  TCP    [::1]:9219             [::]:0                 ABHÖREN         4243',
  '  TCP    127.0.0.1:92190        0.0.0.0:0              LISTENING       9',
].join('\r\n');
eq('netstat: listeners on 9219 only, any language', cdp.parseNetstat(NETSTAT, 9219), [4242, 4243]);
eq('netstat: a client socket TO the port is not a listener', cdp.parseNetstat(NETSTAT, 50000), []);
eq('netstat: nothing', cdp.parseNetstat('', 9219), []);
eq('listenersOn: netstat missing says so', cdp.listenersOn(9219, () => ({ error: new Error('ENOENT') })).ok, false);
eq('listenersOn: non-zero exit says so', cdp.listenersOn(9219, () => ({ status: 1, stdout: '' })).error, 'netstat exited with code 1');
eq('listenersOn: parses', cdp.listenersOn(9219, () => ({ status: 0, stdout: NETSTAT })).pids, [4242, 4243]);

/* ---- decide --------------------------------------------------------------------------------- */
const free = () => ({ ok: true, pids: [] });
const busy = () => ({ ok: true, pids: [31] });
const D = (o) => cdp.decide(Object.assign({ argv: ['Quartz.exe', '.'], cliPort: null, env: {}, prefs: { enabled: true }, probe: free }, o));
let d = D({});
eq('normal start: default port appended', [d.mode, d.append, d.requestedPort], ['default', 9219, 9219]);
d = D({ probe: busy });
eq('busy: ephemeral fallback', [d.mode, d.append, d.requestedPort], ['fallback', 0, 9219]);
ok('busy: reason names the port and pid', /9219.*pid 31/.test(d.reason), d.reason);
d = D({ probe: () => ({ ok: false, error: 'netstat did not run' }) });
eq('probe failed: tries the default anyway, says why', [d.mode, d.append, /could not check/.test(d.reason)], ['default', 9219, true]);
d = D({ prefs: { enabled: false } });
eq('off in Settings: nothing appended', [d.mode, d.append], ['off', null]);
let probed = false;
D({ prefs: { enabled: false }, probe: () => { probed = true; return free(); } });
eq('off in Settings: port not even probed', probed, false);
d = D({ cliPort: '9431' });
eq('command-line port wins', [d.mode, d.append, d.requestedPort], ['command-line', null, 9431]);
d = D({ cliPort: '9431', prefs: { enabled: false } });
eq('command-line port wins over Settings off', [d.mode, d.append], ['command-line', null]);
d = D({ argv: ['Quartz.exe', '.', '--remote-debugging-pipe'] });
eq('pipe on the command line: no port', [d.mode, d.append], ['command-line-pipe', null]);
d = D({ argv: ['e', '.', '--test-profile', '--profile-name=x'] });
eq('test profile without a port: none added', [d.mode, d.append], ['test-off', null]);
d = D({ argv: ['e', '.', '--test'] });
eq('--test without a port: none added', [d.mode, d.append], ['test-off', null]);
d = D({ argv: ['e', '.', '--test-profile'], cliPort: '9500' });
eq('test profile with its own port: kept', [d.mode, d.append, d.requestedPort], ['command-line', null, 9500]);

// A command-line port that is already taken: the next free one of N+1..N+8, said in plain words.
const held = (ports) => (port) => ({ ok: true, pids: ports.includes(port) ? [77] : [] });
d = D({ cliPort: '9341', probe: held([9341]) });
eq('cli busy: next port appended', [d.mode, d.append, d.requestedPort], ['command-line-fallback', 9342, 9341]);
eq('cli busy: the window sentence', d.notice, 'Remote debugging port 9341 was in use by another process, so Quartz is on 9342.');
ok('cli busy: reason names the pid', /9341.*pid 77.*9342/.test(d.reason), d.reason);
d = D({ cliPort: '9341', probe: held([9341, 9342, 9343]) });
eq('cli busy: skips taken candidates', [d.mode, d.append], ['command-line-fallback', 9344]);
const asked = [];
d = D({ cliPort: '9341', probe: held([9341]), probeNext: (q) => { asked.push(q); return { ok: true, pids: q < 9345 ? [5] : [] }; } });
eq('cli busy: candidates go to probeNext, in order', [d.append, asked], [9345, [9342, 9343, 9344, 9345]]);
d = D({ cliPort: '9341', probe: held([9341, 9342, 9343, 9344, 9345, 9346, 9347, 9348, 9349]) });
eq('cli busy, no free port: nothing appended', [d.mode, d.append, d.requestedPort], ['command-line-busy', null, 9341]);
ok('cli busy, no free port: the sentence says off and why', /9341 was in use.*9342-9349.*off for this run/.test(d.notice), d.notice);
d = D({ cliPort: '9341', probe: held([9341, 9342, 9343, 9344, 9345, 9346, 9347, 9348, 9349, 9350]) });
eq('cli busy: never looks past N+8', d.mode, 'command-line-busy');
d = D({ cliPort: '9341', probe: held([9341]), probeNext: (q) => (q === 9342 ? { ok: false, error: 'x' } : { ok: true, pids: [] }) });
eq('cli busy: an uncheckable candidate is skipped, not taken', d.append, 9343);
d = D({ cliPort: '65535', probe: held([65535]) });
eq('cli busy at 65535: no range, off', [d.mode, d.append, /65535 was in use by another process, so remote/.test(d.notice)], ['command-line-busy', null, true]);
d = D({ cliPort: '9341', probe: () => ({ ok: false, error: 'netstat did not run' }) });
eq('cli unchecked: kept, says why', [d.mode, d.append, /could not check/.test(d.reason)], ['command-line', null, true]);
let cliProbed = false;
d = D({ cliPort: '0', probe: () => { cliProbed = true; return busy(); } });
eq('cli port 0: kept, never probed', [d.mode, d.append, cliProbed], ['command-line', null, false]);
d = D({ cliPort: 'abc', probe: busy });
eq('cli port not a number: left to Chromium', [d.mode, d.append], ['command-line', null]);
d = D({ argv: ['e', '.', '--test-profile'], cliPort: '9500', probe: held([9500]) });
eq('test profile, busy port: moves too', [d.mode, d.append], ['command-line-fallback', 9501]);
d = D({});
eq('no flag: the fallback never invents a port of its own kind', d.mode === 'command-line-fallback' || d.mode === 'command-line-busy', false);
const snap = cdp.snapshotProbe(() => ({ status: 0, stdout: '  TCP    127.0.0.1:9341   0.0.0.0:0   LISTENING   8216\n' }));
eq('snapshotProbe: reads one netstat for every port', [snap(9341).pids, snap(9342).pids], [[8216], []]);
const snapBad = cdp.snapshotProbe(() => ({ status: 1, stdout: '' }));
eq('snapshotProbe: a failed netstat is not "free"', snapBad(9342).ok, false);
d = D({ argv: ['e', '.', '--test-profile'], env: { QUARTZ_TEST_CDP_DEFAULT_PORT: '9612' } });
eq('test hook: plans like a normal start on its own port', [d.mode, d.append, d.requestedPort], ['default', 9612, 9612]);
d = D({ argv: ['e', '.', '--test'], env: { QUARTZ_TEST_CDP_DEFAULT_PORT: '9612' } });
eq('test hook needs --test-profile', d.mode, 'test-off');
d = D({ env: { QUARTZ_TEST_CDP_DEFAULT_PORT: '9612' } });
eq('test hook ignored on a normal start', [d.mode, d.append], ['default', 9219]);
d = D({ argv: ['e', '.', '--test-profile'], env: { QUARTZ_TEST_CDP_DEFAULT_PORT: 'junk' } });
eq('test hook: junk port is no port', d.mode, 'test-off');

/* ---- readPrefs ------------------------------------------------------------------------------ */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-harness-'));
eq('prefs: missing = on', cdp.readPrefs(tmp), { enabled: true });
fs.writeFileSync(path.join(tmp, cdp.PREFS_FILE), '{"enabled":false}');
eq('prefs: off', cdp.readPrefs(tmp), { enabled: false });
fs.writeFileSync(path.join(tmp, cdp.PREFS_FILE), '{nope');
const bad = cdp.readPrefs(tmp);
eq('prefs: bad JSON = on, with a reason', [bad.enabled, /not valid JSON/.test(bad.error)], [true, true]);
fs.unlinkSync(path.join(tmp, cdp.PREFS_FILE));

/* ---- plan() against a fake app -------------------------------------------------------------- */
function fakeApp(dir, switches) {
  const sw = Object.assign({}, switches || {});
  return {
    appended: [],
    getPath: () => dir,
    commandLine: {
      hasSwitch: (k) => Object.prototype.hasOwnProperty.call(sw, k),
      getSwitchValue: (k) => sw[k] || '',
      appendSwitch(k, v) { this._owner.appended.push([k, v]); },
    },
  };
}
function mkApp(dir, switches) { const a = fakeApp(dir, switches); a.commandLine._owner = a; return a; }

(async () => {
  // A test profile with the test hook, so the real netstat probe runs against a port nobody uses.
  const argv = ['e', '.', '--test-profile'];
  const env = { QUARTZ_TEST_CDP_DEFAULT_PORT: '9617' };
  fs.writeFileSync(path.join(tmp, cdp.ACTIVE_PORT_FILE), '1234\n/devtools/browser/stale');
  let app = mkApp(tmp);
  let p = cdp.plan({ app, argv, env });
  eq('plan: appends the port', app.appended, [['remote-debugging-port', '9617']]);
  eq('plan: stale DevToolsActivePort deleted', fs.existsSync(path.join(tmp, cdp.ACTIVE_PORT_FILE)), false);
  let s = JSON.parse(fs.readFileSync(path.join(tmp, cdp.STATE_FILE), 'utf8'));
  eq('plan: cdp.json says waiting before ready', [s.ok, s.mode, s.requestedPort, s.pid, /waiting/.test(s.error)], [false, 'default', 9617, process.pid, true]);
  // Chromium writes its file a moment after ready.
  setTimeout(() => fs.writeFileSync(path.join(tmp, cdp.ACTIVE_PORT_FILE), '9617\n/devtools/browser/abc'), 250);
  const lines = [];
  s = await p.confirm((t) => lines.push(t));
  eq('confirm: ok with the live endpoint', [s.ok, s.port, s.http, s.ws, s.error], [true, 9617, 'http://127.0.0.1:9617', 'ws://127.0.0.1:9617/devtools/browser/abc', null]);
  eq('confirm: cdp.json matches', JSON.parse(fs.readFileSync(path.join(tmp, cdp.STATE_FILE), 'utf8')).ws, s.ws);
  ok('confirm: one log line naming the port', lines.length === 1 && /on at 127\.0\.0\.1:9617/.test(lines[0]), JSON.stringify(lines));
  let desc = p.describe();
  eq('describe: on, governed, no restart needed', [desc.enabledNext, desc.governed, desc.restartNeeded], [true, true, false]);
  desc = p.setEnabled(false);
  eq('setEnabled(false): saved, restart needed', [cdp.readPrefs(tmp).enabled, desc.enabledNext, desc.restartNeeded], [false, false, true]);
  desc = p.setEnabled(true);
  eq('setEnabled(true) again: no restart needed', desc.restartNeeded, false);

  // Off in Settings: nothing appended, cdp.json says why, confirm does not wait.
  p.setEnabled(false);
  app = mkApp(tmp);
  p = cdp.plan({ app, argv, env });
  eq('off: nothing appended', app.appended, []);
  const t0 = Date.now();
  s = await p.confirm(() => {});
  eq('off: state says Settings', [s.ok, s.mode, /Settings > Claude/.test(s.error)], [false, 'off', true]);
  ok('off: confirm returns at once', Date.now() - t0 < 500);
  fs.unlinkSync(path.join(tmp, cdp.PREFS_FILE));

  // A command-line port is never touched, but its endpoint is still recorded.
  app = mkApp(tmp, { 'remote-debugging-port': '9618' });
  p = cdp.plan({ app, argv: ['e', '.'], env: {} });
  eq('cli: nothing appended', app.appended, []);
  setTimeout(() => fs.writeFileSync(path.join(tmp, cdp.ACTIVE_PORT_FILE), '9618\n/devtools/browser/cli'), 100);
  s = await p.confirm(() => {});
  eq('cli: recorded', [s.ok, s.mode, s.port], [true, 'command-line', 9618]);
  eq('cli: Settings switch does not govern it', p.describe().governed, false);

  // A command-line port that is taken: plan() appends the next one and cdp.json records why.
  fs.unlinkSync(path.join(tmp, cdp.ACTIVE_PORT_FILE));
  app = mkApp(tmp, { 'remote-debugging-port': '9341' });
  p = cdp.plan({ app, argv: ['e', '.'], env: {}, probe: (q) => ({ ok: true, pids: q === 9341 ? [8216] : [] }), probeNext: () => ({ ok: true, pids: [] }) });
  eq('cli busy plan: next port appended', app.appended, [['remote-debugging-port', '9342']]);
  s = JSON.parse(fs.readFileSync(path.join(tmp, cdp.STATE_FILE), 'utf8'));
  eq('cli busy plan: cdp.json has requested, planned port, notice', [s.requested, s.plannedPort, s.mode, /so Quartz is on 9342/.test(s.notice)], [9341, 9342, 'command-line-fallback', true]);
  setTimeout(() => fs.writeFileSync(path.join(tmp, cdp.ACTIVE_PORT_FILE), '9342\n/devtools/browser/fb'), 100);
  s = await p.confirm(() => {});
  eq('cli busy confirm: port is the one Chromium bound', [s.ok, s.port, s.requested, !!s.notice], [true, 9342, 9341, true]);
  eq('cli busy describe: carries the notice', /9341 was in use/.test(p.describe().notice || ''), true);

  // The server never comes up: plain failure with the reason, after the timeout.
  fs.unlinkSync(path.join(tmp, cdp.ACTIVE_PORT_FILE));
  app = mkApp(tmp);
  p = cdp.plan({ app, argv, env });
  s = await p.confirm(() => {});
  eq('no server: failure says why', [s.ok, /did not start within 5 s/.test(s.error)], [false, true]);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`cdp-harness: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL harness crashed: ' + (e && e.stack || e)); console.log(`cdp-harness: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
