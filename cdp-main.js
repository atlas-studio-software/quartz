'use strict';
/*
 * cdp-main.js -- an always-on Chrome DevTools Protocol (CDP) endpoint, so a
 * local tool (an AI coding agent, a script) can drive the browser the user is
 * already running, without a restart with --remote-debugging-port.
 *
 * What a normal start does (main.js calls plan() at the top level, after the
 * single-instance lock, and confirm() once the app is ready):
 *   - port DEFAULT_PORT (9219) on 127.0.0.1. Electron's DevTools server binds
 *     127.0.0.1 and nothing else (shell/browser/ui/devtools_manager_delegate.cc
 *     hard-codes the address), so the port is never reachable from the LAN.
 *     9219 sits below the 9222+ range every test harness and lane uses.
 *   - port busy (another app, or the dead-but-still-LISTENING socket a killed
 *     Chromium can leave behind): an ephemeral port (0) instead, and the
 *     reason, with the pid that holds 9219, goes into cdp.json and the log.
 *   - turned off in Settings > Claude (cdp-prefs.json { enabled: false }): no
 *     port at all, and cdp.json says so.
 *
 * What is never touched:
 *   - a port or pipe the command line asks for: it wins, as before.
 *   - test runs (--test-profile, --test): they get a port only when their
 *     command line asks for one, exactly as before. QUARTZ_TEST_CDP_DEFAULT_PORT
 *     (test profiles only) makes a test copy plan like a normal start with a
 *     different default port, which is how cdp-e2e.js proves this file without
 *     going near 9219.
 *   - a second copy (a link click handing its URL to the running window): it
 *     exits at the lock in main.js, before plan() runs.
 *
 * The discovery file: <userData>\cdp.json, rewritten at every start:
 *   { ok, enabled, mode, port, requestedPort, http, ws, pid, startedAt,
 *     reason, error }
 * ok=false always comes with `error` in plain words. Chromium's own
 * <userData>\DevToolsActivePort ("<port>\n<browser ws path>") is the proof the
 * server is listening: confirm() waits for it, and a stale one from the last
 * run is deleted first so it can never be mistaken for this run's.
 * tools/cdp-endpoint.js reads both and checks the pid and /json/version.
 *
 * Security trade-off, on purpose: any process running as this Windows user can
 * connect to the port and control the logged-in browser (read pages, cookies,
 * type, click). Web pages cannot: Chromium refuses DevTools WebSocket
 * connections that carry an Origin unless --remote-allow-origins lists it,
 * and that switch is deliberately NOT set (CDP clients like `ws` send no
 * Origin). /json requests must name localhost or an IP as Host, which stops
 * DNS rebinding. The Settings switch turns the whole thing off.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_PORT = 9219;
const PREFS_FILE = 'cdp-prefs.json';
const STATE_FILE = 'cdp.json';
const ACTIVE_PORT_FILE = 'DevToolsActivePort';
const CONFIRM_TIMEOUT_MS = 5000;
// A restart (Settings > About) starts the new copy while the old one may still
// be closing its DevTools socket; a short wait keeps the fixed port across it.
const BUSY_RETRIES = 4;
const BUSY_WAIT_MS = 250;

/**
 * The pids LISTENING on `port` in `netstat -ano -p TCP` output (pure). A
 * listening socket is the one whose foreign address ends in ":0" (0.0.0.0:0,
 * [::]:0); matching that instead of the word LISTENING keeps this working on a
 * Windows in any language.
 */
function parseNetstat(text, port) {
  const pids = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+(\S+)\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (!m || Number(m[2]) !== port || !/:0$/.test(m[3])) continue;
    const pid = Number(m[4]);
    if (!pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/**
 * Who holds `port` right now: { ok: true, pids } or { ok: false, error }.
 * Synchronous on purpose (~45 ms): the switch has to be on the command line
 * before Electron starts its DevTools server, and no async work completes
 * before 'ready'.
 */
function listenersOn(port, run) {
  const spawn = run || spawnSync;
  try {
    const r = spawn('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    if (r.error) return { ok: false, error: 'netstat did not run: ' + r.error.message };
    if (r.status !== 0) return { ok: false, error: 'netstat exited with code ' + r.status };
    return { ok: true, pids: parseNetstat(r.stdout, port) };
  } catch (err) {
    return { ok: false, error: 'netstat did not run: ' + ((err && err.message) || err) };
  }
}

/** { enabled, error? } from cdp-prefs.json. Missing = on (the default); unreadable = on, and says why. */
function readPrefs(userData) {
  const file = path.join(userData, PREFS_FILE);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err && err.code === 'ENOENT') return { enabled: true };
    return { enabled: true, error: 'could not read ' + PREFS_FILE + ' (' + err.code + '), so the default (on) applies' };
  }
  try {
    const v = JSON.parse(raw);
    return { enabled: !(v && v.enabled === false) };
  } catch {
    return { enabled: true, error: PREFS_FILE + ' is not valid JSON, so the default (on) applies' };
  }
}

/**
 * The decision, pure (cdp-harness.js covers every branch).
 * input: { argv, cliPort (string|null: app.commandLine's remote-debugging-port), env,
 *          prefs: { enabled, error? }, probe: (port) => listenersOn result }
 * returns { mode, append (number|null: the port to put on the command line), requestedPort, reason }
 */
function decide(input) {
  const argv = input.argv || [];
  const env = input.env || {};
  const testProfile = argv.includes('--test-profile');
  const test = testProfile || argv.includes('--test');
  if (argv.some((a) => a === '--remote-debugging-pipe' || a.startsWith('--remote-debugging-pipe='))) {
    return { mode: 'command-line-pipe', append: null, requestedPort: null, reason: 'the command line asked for DevTools over a pipe, so no port is added' };
  }
  if (input.cliPort != null && input.cliPort !== '') {
    const p = Number(input.cliPort);
    return { mode: 'command-line', append: null, requestedPort: Number.isInteger(p) ? p : null, reason: 'the command line asked for port ' + input.cliPort };
  }
  let defaultPort = DEFAULT_PORT;
  if (test) {
    const testPort = Number(env.QUARTZ_TEST_CDP_DEFAULT_PORT);
    if (!(testProfile && Number.isInteger(testPort) && testPort > 0 && testPort < 65536)) {
      return { mode: 'test-off', append: null, requestedPort: null, reason: 'a test run gets a DevTools port only when its command line asks for one' };
    }
    defaultPort = testPort;
  }
  const prefs = input.prefs || { enabled: true };
  if (!prefs.enabled) {
    return { mode: 'off', append: null, requestedPort: defaultPort, reason: 'turned off in Settings > Claude' };
  }
  const probe = input.probe ? input.probe(defaultPort) : { ok: true, pids: [] };
  if (!probe.ok) {
    // Cannot tell: try the port anyway. confirm() reports it if Chromium could not bind.
    return { mode: 'default', append: defaultPort, requestedPort: defaultPort, reason: 'the default port (could not check it first: ' + probe.error + ')' };
  }
  if (probe.pids.length) {
    return {
      mode: 'fallback', append: 0, requestedPort: defaultPort, busyPids: probe.pids,
      reason: 'port ' + defaultPort + ' was already in use (pid ' + probe.pids.join(', ') + '), so Windows picked a free port instead',
    };
  }
  return { mode: 'default', append: defaultPort, requestedPort: defaultPort, reason: 'the default port' };
}

/** The probe main.js uses: netstat, re-checked a few times while busy (see BUSY_RETRIES). */
function probeWithRetry(port) {
  let r = listenersOn(port);
  for (let i = 0; i < BUSY_RETRIES && r.ok && r.pids.length; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BUSY_WAIT_MS);
    r = listenersOn(port);
  }
  return r;
}

/** Write a JSON file whole (temp + rename), so a reader never sees half of one. */
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** { port, wsPath } from Chromium's DevToolsActivePort, or null. */
function readActivePort(userData) {
  try {
    const [port, wsPath] = fs.readFileSync(path.join(userData, ACTIVE_PORT_FILE), 'utf8').split(/\r?\n/);
    const n = Number(port);
    return Number.isInteger(n) && n > 0 ? { port: n, wsPath: wsPath || '' } : null;
  } catch { return null; }
}

/**
 * Plan this start and put the switch on the command line. Call at the top level
 * of main.js, after the single-instance lock and before 'ready'.
 * deps: { app, argv, env, now }
 */
function plan(deps) {
  const { app } = deps;
  const argv = deps.argv || process.argv;
  const env = deps.env || process.env;
  const userData = app.getPath('userData');
  const cliPort = app.commandLine.hasSwitch('remote-debugging-port') ? app.commandLine.getSwitchValue('remote-debugging-port') : null;
  const prefs = readPrefs(userData);
  const decision = decide({ argv, cliPort, env, prefs, probe: probeWithRetry });
  const startedAt = new Date((deps.now || Date.now)()).toISOString();
  const expectsPort = decision.append != null || decision.mode === 'command-line';
  // Last run's file would read as this run's port before Chromium writes its own.
  let staleError = '';
  try { fs.unlinkSync(path.join(userData, ACTIVE_PORT_FILE)); } catch (err) {
    if (err && err.code !== 'ENOENT') staleError = 'could not delete the old ' + ACTIVE_PORT_FILE + ' (' + err.code + ')';
  }
  if (decision.append != null) app.commandLine.appendSwitch('remote-debugging-port', String(decision.append));

  let state = {
    ok: false, enabled: prefs.enabled, mode: decision.mode, port: null, requestedPort: decision.requestedPort,
    http: null, ws: null, pid: process.pid, startedAt, reason: decision.reason,
    error: expectsPort ? 'waiting for the DevTools server to start' : 'DevTools is off for this run: ' + decision.reason,
  };
  if (prefs.error) state.prefsError = prefs.error;
  if (staleError) state.staleError = staleError;
  const stateFile = path.join(userData, STATE_FILE);
  const save = () => { try { writeJson(stateFile, state); return ''; } catch (err) { return 'could not write ' + STATE_FILE + ': ' + ((err && err.message) || err); } };
  const firstSaveError = save();

  return {
    decision,
    stateFile,
    /**
     * After 'ready': wait for Chromium's DevToolsActivePort, then write the
     * final cdp.json and hand one plain line to `log`. Resolves to the state.
     */
    async confirm(log) {
      const say = (t) => { try { (log || console.log)(t); } catch { /* the log is best effort */ } };
      if (firstSaveError) say('DevTools (CDP): ' + firstSaveError);
      if (!expectsPort) { say('DevTools (CDP) is off: ' + decision.reason + '.'); return state; }
      const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
      let active = readActivePort(userData);
      while (!active && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        active = readActivePort(userData);
      }
      if (!active) {
        state = Object.assign({}, state, {
          ok: false,
          error: 'the DevTools server did not start within ' + (CONFIRM_TIMEOUT_MS / 1000) + ' s'
            + (decision.append ? ' (port ' + decision.append + ' was probably taken between the check and the bind)' : '')
            + '; restart Quartz to try again',
        });
        say('DevTools (CDP) is NOT available: ' + state.error + '.');
      } else {
        state = Object.assign({}, state, {
          ok: true, error: null, port: active.port,
          http: 'http://127.0.0.1:' + active.port,
          ws: 'ws://127.0.0.1:' + active.port + active.wsPath,
        });
        say('DevTools (CDP) is on at 127.0.0.1:' + active.port + ': ' + decision.reason + '.');
      }
      const e = save();
      if (e) say('DevTools (CDP): ' + e);
      return state;
    },
    /** For Settings: this run's state plus the saved switch (which applies from the next start). */
    describe() {
      const now = readPrefs(userData);
      // The switch only governs a normal start; a command-line port or a test run ignores it.
      const governed = decision.mode === 'default' || decision.mode === 'fallback' || decision.mode === 'off';
      return Object.assign({}, state, { enabledNext: now.enabled, governed, restartNeeded: governed && now.enabled !== prefs.enabled });
    },
    /** Save the Settings switch. Takes effect at the next start. */
    setEnabled(enabled) {
      try {
        writeJson(path.join(userData, PREFS_FILE), { enabled: enabled === true });
      } catch (err) {
        return Object.assign(this.describe(), { saveError: 'could not save the setting: ' + ((err && err.message) || err) });
      }
      return this.describe();
    },
  };
}

module.exports = { DEFAULT_PORT, STATE_FILE, PREFS_FILE, ACTIVE_PORT_FILE, parseNetstat, listenersOn, readPrefs, decide, readActivePort, plan };
