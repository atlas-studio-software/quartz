#!/usr/bin/env node
'use strict';
// tools/cdp-endpoint.js -- where the running Quartz's DevTools (CDP) endpoint is, checked live.
//
//   node tools/cdp-endpoint.js                    the real profile (%APPDATA%\Quartz)
//   node tools/cdp-endpoint.js --test-profile=<x> a test copy's (%TEMP%\browser-test-profile-<x>)
//   node tools/cdp-endpoint.js --dir=<userData>   any profile folder
//   add --json for one JSON object instead of the lines below
//
// Reads <userData>\cdp.json (cdp-main.js writes it at every start) and Chromium's own
// DevToolsActivePort, then asks http://127.0.0.1:<port>/json/version, so what it prints is what is
// listening NOW, not what a file once said. Prints, on success (exit 0):
//   ok   http://127.0.0.1:9219  ws://127.0.0.1:9219/devtools/browser/<id>  (pid 1234, the default port)
// and on failure (exit 1) one line that says why: CDP turned off, Quartz not running, a stale file,
// the port answering for something else, ... A copy started before cdp.json existed (a build
// without cdp-main.js, launched with --remote-debugging-port) is still found through
// DevToolsActivePort alone.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function userDataFrom(argv) {
  const dir = argv.find((a) => a.startsWith('--dir='));
  if (dir) return dir.slice('--dir='.length);
  const test = argv.find((a) => a.startsWith('--test-profile'));
  if (test) {
    const name = test.includes('=') ? test.slice(test.indexOf('=') + 1).replace(/[^a-z0-9-]/gi, '') : '';
    return path.join(os.tmpdir(), 'browser-test-profile' + (name ? '-' + name : ''));
  }
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Quartz');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readActivePort(dir) {
  try {
    const [port, wsPath] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
    const n = Number(port);
    return Number.isInteger(n) && n > 0 ? { port: n, wsPath: wsPath || '' } : null;
  } catch { return null; }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function getVersion(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve({ ok: true, v: JSON.parse(body) }); } catch { resolve({ ok: false, error: 'port ' + port + ' answered, but not with DevTools JSON' }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('no answer in 2 s')));
    req.on('error', (e) => resolve({ ok: false, error: 'nothing answered on 127.0.0.1:' + port + ' (' + (e.code || e.message) + ')' }));
  });
}

async function find(dir) {
  const state = readJson(path.join(dir, 'cdp.json'));
  const active = readActivePort(dir);
  if (state && state.ok === false && !active) {
    return { ok: false, dir, state, error: 'Quartz says DevTools is not available: ' + (state.error || state.reason || 'no reason given') };
  }
  const port = (active && active.port) || (state && state.port);
  if (!port) {
    return { ok: false, dir, error: fs.existsSync(dir) ? 'no cdp.json or DevToolsActivePort in ' + dir + ': Quartz has not opened a DevTools port in this profile' : 'no profile folder at ' + dir };
  }
  if (state && state.pid && alive(state.pid) === false) {
    return { ok: false, dir, state, error: 'cdp.json is from a Quartz that is no longer running (pid ' + state.pid + ' is gone); start Quartz' };
  }
  const v = await getVersion(port);
  if (!v.ok) return { ok: false, dir, state, port, error: v.error + (state ? '' : ' (DevToolsActivePort may be stale)') };
  const ws = v.v.webSocketDebuggerUrl || ('ws://127.0.0.1:' + port + ((active && active.wsPath) || ''));
  if (active && active.wsPath && !ws.endsWith(active.wsPath)) {
    return { ok: false, dir, state, port, error: 'port ' + port + ' is a DevTools server, but not this profile\'s (its browser id differs from DevToolsActivePort)' };
  }
  return {
    ok: true, dir, port, http: 'http://127.0.0.1:' + port, ws,
    pid: state ? state.pid : null, mode: state ? state.mode : 'unknown',
    reason: state ? state.reason : 'found through DevToolsActivePort only (this Quartz predates cdp.json)',
    browser: v.v.Browser || '',
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  find(userDataFrom(argv)).then((r) => {
    if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else if (r.ok) console.log('ok   ' + r.http + '  ' + r.ws + '  (pid ' + (r.pid || '?') + ', ' + r.reason + ')');
    else console.log('FAIL ' + r.error);
    process.exitCode = r.ok ? 0 : 1;
  });
}

module.exports = { find, userDataFrom };
