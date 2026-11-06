require('./tools/lowcpu-optional.js');   // first: one capped browser at a time
// freezewatch-e2e.js -- the frozen window, reproduced and healed in a REAL Quartz.
//
//   node freezewatch-e2e.js [--cdp 9431] [--keep]
//
// ON SCREEN BY DESIGN: Windows' occlusion is the subject, and an off-screen window is always
// "covered". So this runs only where a window on screen bothers nobody: a CI runner
// (GITHUB_ACTIONS=true) or QUARTZ_ALLOW_ON_SCREEN=1. Anywhere else it prints SKIP.
//
// Power messages are simulated INSIDE Quartz (freezewatch.js test op 'sim'): the same
// WM_POWERBROADCAST / WM_WTSSESSION_CHANGE Windows sends, to Chromium's own hidden window,
// back to back the way queued messages land when a sleeping PC thaws.
//   1. start: the page is visible and nothing covers the window.
//   2. display off -> hidden; display on -> visible again (the simulation reaches the tracker).
//   3. THE BUG, healing off: display off, then display on + resume together -> the window
//      stays "covered" (hidden) with nothing over it. The watch sees it (WOULD-NUDGE).
//   4. the user's fix at the event level: the two events a drag raises -> visible.
//   5. again stuck; one CAPTUREEND nudge -> visible (the heal, alone).
//   6. healing on: stuck -> the watch heals it by itself; freeze.log HEALED, a quartz.log
//      line, and the words on screen (the toast).
//   7. healing on, the wake path: the wake nudges heal it before the watch needs to.
//   8. a cover from another process that hides without a focus change (PowerShell form):
//      recorded whether Chromium is left stale (information), then healed with healing on.
// Kills ONLY the process it started. One summary line: "freezewatch-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WS = require(path.join(__dirname, 'node_modules', 'ws'));

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CDP_PORT = Number(opt('cdp', '9431'));
const KEEP = argv.includes('--keep');
const APP = __dirname;
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROFILE = 'freezee2e' + process.pid;
const PROFILE_DIR = path.join(os.tmpdir(), 'browser-test-profile-' + PROFILE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(cond, name, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail).slice(0, 600) : '')); }
}
const info = (s) => console.log('  info ' + s);

if (!(process.env.GITHUB_ACTIONS === 'true' || process.env.QUARTZ_ALLOW_ON_SCREEN === '1')) {
  console.log('SKIP freezewatch-e2e: it puts a window on screen (occlusion needs it), so it runs on a CI runner only (or QUARTZ_ALLOW_ON_SCREEN=1)');
  console.log('freezewatch-e2e: 0 passed, 0 failed');
  process.exit(0);
}
if (process.platform !== 'win32') {
  console.log('SKIP freezewatch-e2e: Windows only');
  console.log('freezewatch-e2e: 0 passed, 0 failed');
  process.exit(0);
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WS(this.wsUrl, { perMessageDeflate: false });
    await new Promise((r, j) => { this.ws.on('open', r); this.ws.on('error', j); });
    this.ws.on('message', (raw) => { const m = JSON.parse(String(raw)); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m); } });
    return this;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }
  async ev(expr) {
    const m = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (m.error) throw new Error(JSON.stringify(m.error));
    if (m.result.exceptionDetails) throw new Error('threw: ' + ((m.result.exceptionDetails.exception || {}).description || m.result.exceptionDetails.text));
    return m.result.result.value;
  }
  close() { try { this.ws.close(); } catch (e) { /* gone */ } }
}

let cdp;
const vis = () => cdp.ev('document.visibilityState');
const test = (req) => cdp.ev(`window.api.freeze.test(${JSON.stringify(req)})`);
/** Wait until the page's visibility is `want`; returns ms taken, or -1 on timeout. */
async function waitVis(want, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ((await vis()) === want) return Date.now() - t0; await sleep(50); }
  return -1;
}
/** Hidden for the whole of `ms`? */
async function staysHidden(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ((await vis()) !== 'hidden') return false; await sleep(100); }
  return true;
}
const readFile = (name) => { try { return fs.readFileSync(path.join(PROFILE_DIR, name), 'utf8'); } catch (_) { return ''; } };
async function stick() {
  await test({ op: 'sim', seq: ['display-off'] });
  if ((await waitVis('hidden', 2000)) < 0) return false;
  await test({ op: 'sim', seq: ['display-on', 'resume'] });
  return true;
}

/** A plain window from ANOTHER process over the whole screen, shown without activation, then hidden. */
function coverProcess() {
  const ps = `
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System; using System.Windows.Forms; using System.Drawing;
public class FwCover : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08 | 0x08000000; return p; } }
}
'@
Add-Type -AssemblyName System.Windows.Forms
$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$f = New-Object FwCover
$f.FormBorderStyle = 'FixedSingle'; $f.ControlBox = $false; $f.Text = ''; $f.ShowInTaskbar = $false
$f.StartPosition = 'Manual'; $f.BackColor = [System.Drawing.Color]::DimGray
$f.Bounds = New-Object System.Drawing.Rectangle(($s.X - 40), ($s.Y - 60), ($s.Width + 80), ($s.Height + 120))
$f.Show(); [System.Windows.Forms.Application]::DoEvents()
[Console]::Out.WriteLine('SHOWN'); [Console]::Out.Flush()
$t0 = Get-Date; while (((Get-Date) - $t0).TotalMilliseconds -lt 3000) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 30 }
$f.Hide(); [System.Windows.Forms.Application]::DoEvents()
[Console]::Out.WriteLine('HIDDEN'); [Console]::Out.Flush()
$t0 = Get-Date; while (((Get-Date) - $t0).TotalMilliseconds -lt 8000) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 30 }
$f.Close()
`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'] });
  const seen = {};
  const waiters = [];
  child.stdout.on('data', (b) => {
    for (const line of String(b).split(/\r?\n/)) {
      const k = line.trim();
      if (!k) continue;
      seen[k] = Date.now();
      for (const w of waiters.splice(0)) w();
    }
  });
  let err = '';
  child.stderr.on('data', (b) => { err += String(b); });
  const waitLine = async (k, ms) => {
    const t0 = Date.now();
    while (!seen[k] && Date.now() - t0 < ms) await new Promise((r) => { waiters.push(r); setTimeout(r, 200); });
    return !!seen[k];
  };
  return { child, waitLine, err: () => err.slice(0, 300) };
}

(async () => {
  let child = null;
  try {
    console.log(`freezewatch-e2e: Quartz ON SCREEN, profile ${PROFILE}, cdp ${CDP_PORT}`);
    const env = Object.assign({}, process.env, { QUARTZ_TEST_FREEZE_ACTIVE: '1' });
    child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + CDP_PORT, '--test-profile', '--profile-name=' + PROFILE], { cwd: APP, stdio: 'ignore', env });
    let target = null;
    for (let i = 0; i < 160 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((x) => x.type === 'page' && /index\.html/.test(String(x.url))); } catch (_) { /* not up */ }
      if (!target) await sleep(250);
    }
    check(!!target, 'the chrome page is up');
    if (!target) throw new Error('no chrome target');
    cdp = await new Cdp(target.webSocketDebuggerUrl).open();
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) { try { if (await cdp.ev('!!(window.api && window.api.freeze && window.Settings)')) break; } catch (_) { /* booting */ } await sleep(200); }
    await sleep(2000);

    // 1. start
    const st0 = await test({ op: 'state' });
    check(st0 && st0.ok && st0.koffi === true, 'test hook answers; koffi loaded in main', st0 && { ok: st0.ok, koffi: st0.koffi });
    await test({ op: 'heal', on: false });
    const v0 = await waitVis('visible', 8000);
    const cover0 = await test({ op: 'cover' });
    check(v0 >= 0, 'start: the page is visible', { vis: await vis(), cover: cover0 && cover0.cover });
    check(cover0 && cover0.cover && cover0.cover.uncoveredPx > 4096, 'start: the cover check agrees nothing covers it', cover0 && cover0.cover && { px: cover0.cover.uncoveredPx, above: cover0.cover.above });

    // 2. the simulation reaches the tracker
    const s1 = await test({ op: 'sim', seq: ['display-off'] });
    info(`synthetic messages went to ${JSON.stringify(s1.sent)} hidden Chromium window(s)`);
    const offMs = await waitVis('hidden', 2000);
    check(offMs >= 0, `display off -> hidden (${offMs} ms)`);
    await test({ op: 'sim', seq: ['display-on'] });
    const onMs = await waitVis('visible', 2000);
    check(onMs >= 0, `display on alone -> visible again (${onMs} ms)`);

    // 3. THE BUG
    check(await stick(), 'display off -> hidden (before the bug sequence)');
    const stuck = await staysHidden(3500);
    check(stuck, 'REPRODUCED: display on + resume together leave the window hidden for 3.5 s with nothing over it');
    const cover3 = await test({ op: 'cover' });
    check(cover3 && cover3.cover && cover3.cover.uncoveredPx > 4096, 'while stuck, nothing covers it (cover check)', cover3 && cover3.cover && cover3.cover.uncoveredPx);
    check(/WOULD-NUDGE/.test(readFile('freeze.log')) && /STALE|WOULD-NUDGE/.test(readFile('freeze.log')), 'the watch saw it (freeze.log WOULD-NUDGE, healing off)', readFile('freeze.log').slice(-400));

    // 4. the user's fix, at the event level
    await test({ op: 'drag' });
    const dragMs = await waitVis('visible', 2000);
    check(dragMs >= 0, `the two events a drag raises -> visible (${dragMs} ms): the manual fix, explained`);

    // 5. one nudge
    check(await stick(), 'stuck again');
    check(await staysHidden(1200), 'still hidden 1.2 s later');
    await test({ op: 'nudge' });
    const nudgeMs = await waitVis('visible', 2000);
    check(nudgeMs >= 0, `one CAPTUREEND nudge -> visible (${nudgeMs} ms), the window never moved`);

    // 6. healing on: the watch
    await test({ op: 'heal', on: true });
    const before6 = (await test({ op: 'state' })).counts;
    check(await stick(), 'healing on: stuck');
    const healMs = await waitVis('visible', 7000);
    const after6 = (await test({ op: 'state' })).counts;
    check(healMs >= 0, `the watch healed it by itself in ${healMs} ms`);
    check(after6.healed === before6.healed + 1, 'counted as healed once', { before6, after6 });
    await sleep(400);
    check(/HEALED step=/.test(readFile('freeze.log')), 'freeze.log: HEALED', readFile('freeze.log').slice(-300));
    check(/Freeze: the window had stopped drawing/.test(readFile('quartz.log')), 'quartz.log: the one-line version');
    const toast = await cdp.ev(`(async () => { for (let i = 0; i < 40; i++) { const t = document.getElementById('settings-toast'); if (t && !t.hidden && /redrew/.test(t.textContent)) return t.textContent; await new Promise(r => setTimeout(r, 50)); } const t = document.getElementById('settings-toast'); return t ? 'hidden=' + t.hidden + ' ' + t.textContent : 'none'; })()`);
    check(/redrew the window/.test(toast), 'the words on screen (toast)', toast);

    // 7. the wake path
    const before7 = (await test({ op: 'state' })).counts;
    await test({ op: 'sim', seq: ['display-off'] });
    check((await waitVis('hidden', 2000)) >= 0, 'wake path: display off -> hidden');
    await test({ op: 'sim', seq: ['display-on', 'resume'], alsoWake: true });
    const wakeMs = await waitVis('visible', 4000);
    const after7 = (await test({ op: 'state' })).counts;
    check(wakeMs >= 0 && wakeMs < 1400, `the first wake nudge (0.6 s) healed it in ${wakeMs} ms`);
    check(after7.wokeHealed === before7.wokeHealed + 1 && after7.healed === before7.healed, 'counted as woke-healed, not twice', { before7, after7 });

    // 8. a cover that hides
    for (const healOn of [false, true]) {
      await test({ op: 'heal', on: healOn });
      await sleep(300);
      const c = coverProcess();
      const shown = await c.waitLine('SHOWN', 20000);
      check(shown, `cover (healing ${healOn ? 'on' : 'off'}): the other process showed its window`, c.err());
      if (!shown) { try { c.child.kill(); } catch (_) { /* gone */ } continue; }
      const covMs = await waitVis('hidden', 2500);
      if (covMs < 0) {
        info(`a full-screen non-activating window from another process did NOT hide the page (cover check: ${JSON.stringify((await test({ op: 'cover' })).cover).slice(0, 300)}); step 8 not applicable here`);
        await c.waitLine('HIDDEN', 8000);
        try { c.child.kill(); } catch (_) { /* gone */ }
        break;
      }
      await c.waitLine('HIDDEN', 8000);
      if (!healOn) {
        const left = await staysHidden(3000);
        info(left ? 'COVER-HIDE REPRODUCED: the cover was hidden without a focus change and the window stayed hidden 3 s'
          : 'cover-hide: Chromium recomputed by itself after the cover hid');
        if (left) { await test({ op: 'drag' }); await waitVis('visible', 2000); }
      } else {
        const ms = await waitVis('visible', 7000);
        check(ms >= 0, `cover hidden, healing on: visible again in ${ms} ms`);
      }
      try { c.child.kill(); } catch (_) { /* gone */ }
      await sleep(500);
    }
    const st9 = await test({ op: 'state' });
    info('counts ' + JSON.stringify(st9.counts) + '; power ' + JSON.stringify(st9.power.map((p) => p.what)));
    info('freeze.log tail:\n' + readFile('freeze.log').split('\n').slice(-12).map((l) => '    ' + l.slice(0, 260)).join('\n'));
  } catch (err) {
    check(false, 'no exception', String((err && err.stack) || err).slice(0, 500));
  } finally {
    if (cdp) cdp.close();
    if (child) { try { child.kill(); } catch (_) { /* gone */ } }
    await sleep(1500);
    if (!KEEP) { try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (_) { /* busy */ } }
    console.log(`freezewatch-e2e: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
