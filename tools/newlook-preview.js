#!/usr/bin/env node
// tools/newlook-preview.js - open THIS checkout as a separate test copy of Quartz, over the
// user's real wallpaper, next to the Quartz they are using, without touching it.
//
//   node tools/newlook-preview.js              seed the test profile's picture, then launch
//   node tools/newlook-preview.js --dry-run    say what it would do; copy and launch nothing
//   node tools/newlook-preview.js --pids       list the preview's processes (and nothing else)
//   node tools/newlook-preview.js --watch [--seconds=60]   its CPU every 2 s, as Task Manager counts it
//   node tools/newlook-preview.js --stop       end the preview's processes, only those
//   node tools/newlook-preview.js --remove     --stop, then delete the preview's test profile folder
//   --profile-name=<x>                         another name (default newlook-preview)
//
// What keeps it apart from the Quartz the user is running (each is the app's own code):
//   - Storage and the single-instance lock: --test-profile points userData at
//     %TEMP%\browser-test-profile-<name> (main.js, the --test-profile block before the lock), and
//     the lock is keyed to userData, so this copy never locks against the real one.
//   - Look Sync: a test profile uses <test userData>\look-sync, never %APPDATA%\look-sync
//     (looksync-main.js syncDir). This script READS the real folder and writes only the test one.
//   - DevTools ports: a test profile opens a port only when its command line asks for one
//     (cdp-main.js decide(), 'test-off'), and this script never passes one, so 9219, 9222 and
//     9341-9349 stay untouched. QUARTZ_TEST_CDP_DEFAULT_PORT is cleared so nothing can ask.
//   - Spotify auto-pause: a test profile never binds 8787-8790, never joins another host and
//     never sends Spotify a command (autopause.js create(), deps.test); QUARTZ_AUTOPAUSE_PORT is
//     cleared, so it binds nothing at all.
//   - The default browser: a test profile never runs register-default-browser.ps1
//     (firstrun-main.js runScript); QUARTZ_TEST_DEFAULT_SCRIPT is cleared.
//   - Updates: a test profile never checks (updater-main.js); Mantle is never started
//     (looksync-main.js open-mantle) and the top-row pipe to Mantle is off (toprow-main.js).
// Every QUARTZ_* variable, LOOK_SYNC_DIR, TOPROW_PIPE, ELECTRON_RUN_AS_NODE and NODE_OPTIONS
// is removed from the copy's environment, so no test seam can be switched on by accident.
//
// It refuses (exit 2, one plain line) to run from the live clone (%USERPROFILE%\browser),
// whose Electron must never be launched, or without this checkout's own node_modules.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const DEFAULT_NAME = 'newlook-preview';
const STILL_EXT = /\.(jpe?g|png|webp|bmp)$/i;            // looksync-main.js STILL_EXT
const DROP_ENV = /^(QUARTZ_|LOOK_SYNC_DIR$|TOPROW_PIPE$|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$|SMOKE_PORT$|CDP_PORT$)/i;

/** The profile name as main.js keeps it (letters, digits, '-'). */
function cleanName(raw) {
  return String(raw == null ? DEFAULT_NAME : raw).replace(/[^a-z0-9-]/gi, '');
}

function same(a, b) {
  return path.resolve(a).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase();
}

/** The environment the copy gets: this one minus every test seam. */
function cleanEnv(env) {
  const out = {};
  for (const k of Object.keys(env || {})) if (!DROP_ENV.test(k)) out[k] = env[k];
  return out;
}

/**
 * What a launch would do (pure; `exists` answers for files).
 * o: { repoDir, env, tmpdir, home, appdata, platform, name, exists }
 * -> { ok, refusal?, exe, args, env, name, profileDir, syncDir, realSyncDir }
 */
function plan(o) {
  const name = cleanName(o.name);
  const repoDir = path.resolve(o.repoDir);
  const exists = o.exists || (() => false);
  const out = {
    ok: false, name, repoDir,
    exe: path.join(repoDir, 'node_modules', 'electron', 'dist', 'Quartz.exe'),
    args: [repoDir, '--test-profile', '--profile-name=' + name],
    env: cleanEnv(o.env),
    profileDir: path.join(o.tmpdir, 'browser-test-profile-' + name),
    realSyncDir: path.join(o.appdata, 'look-sync'),
  };
  out.syncDir = path.join(out.profileDir, 'look-sync');
  if (o.platform !== 'win32') { out.refusal = 'Quartz runs on Windows only'; return out; }
  if (!name) { out.refusal = 'the profile name is empty after cleaning'; return out; }
  if (o.home && same(repoDir, path.join(o.home, 'browser'))) {
    out.refusal = 'this is the live clone the user runs Quartz from; its Electron is never launched. Run this from a separate worktree';
    return out;
  }
  if (!exists(path.join(repoDir, 'package.json'))) { out.refusal = repoDir + ' is not a Quartz checkout (no package.json)'; return out; }
  if (!exists(out.exe)) {
    out.refusal = 'this checkout has no node_modules\\electron\\dist\\Quartz.exe: run `npm ci` in ' + repoDir + ' first';
    return out;
  }
  if (same(out.syncDir, out.realSyncDir) || same(out.profileDir, path.join(o.appdata, 'Quartz'))) {
    out.refusal = 'the test folders resolve to the real ones (' + out.syncDir + '); nothing was done';
    return out;
  }
  out.ok = true;
  return out;
}

/**
 * The test profile's look.json and the still to copy (pure).
 * realDoc: the parsed real look.json (look-sync read().doc) or null; stills: [{ name, mtimeMs }]
 * in the real stills folder; testDoc: the test profile's current doc or null (its look fields
 * are kept, so a re-launch keeps what was changed in the preview).
 * -> { ok, doc?, copyFrom?, copyTo?, reason }
 */
function seed(realDoc, stills, testDoc, realSyncDir, syncDir) {
  const realStills = path.join(realSyncDir, 'stills');
  const list = (stills || []).filter((s) => s && /^wall-/i.test(s.name) && STILL_EXT.test(s.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const rec = realDoc && realDoc.desktop && typeof realDoc.desktop === 'object' ? realDoc.desktop : null;
  let name = null, reason = '', record = null;
  if (rec && rec.ok === true && typeof rec.still === 'string' && rec.still) {
    const base = path.basename(rec.still);
    const inside = same(path.dirname(rec.still), realStills);
    if (inside && list.some((s) => s.name.toLowerCase() === base.toLowerCase())) {
      name = base; record = Object.assign({}, rec);
      reason = "the still Mantle's record names (" + base + ')';
    } else if (list.length) {
      name = list[0].name;
      record = Object.assign({}, rec, { stillSize: null });
      reason = "the record's still " + (inside ? 'is missing' : 'is outside the stills folder') + ', so the newest one (' + name + ')';
    }
  } else if (list.length) {
    name = list[0].name;
    record = { rev: 1, ok: true, id: 'preview', type: 'image', title: null, still: '' };
    reason = (rec ? "Mantle's record has no usable picture" : 'there is no desktop record') + ', so the newest still (' + name + ') with a plain record';
  }
  if (!name) {
    return { ok: false, reason: 'no wallpaper still in ' + realStills + ': the preview follows Windows\' wallpaper instead (it says so in Settings)' };
  }
  const copyTo = path.join(syncDir, 'stills', name);
  record.still = copyTo;
  if (!Number.isInteger(record.rev) || record.rev < 0) record.rev = 1;
  const keepLook = testDoc && testDoc.look && typeof testDoc.look === 'object' ? testDoc.look : {};
  const rev = Math.max(record.rev, (testDoc && Number.isInteger(testDoc.rev) ? testDoc.rev + 1 : 1));
  const doc = { schema: 1, rev, writer: { app: 'preview-launcher' }, look: keepLook, desktop: record };
  return { ok: true, doc, copyFrom: path.join(realStills, name), copyTo, reason };
}

/* ---------- the processes (PowerShell; never by image name) ---------- */

function psTree(name) {
  // The main process: a Quartz/electron exe whose command line names this profile and is not
  // a child (--type=). Then every descendant by ParentProcessId: GPU, renderers, utilities.
  return [
    "$all = Get-CimInstance Win32_Process",
    "$main = @($all | Where-Object { ($_.Name -eq 'Quartz.exe' -or $_.Name -eq 'electron.exe') -and $_.CommandLine -match '--profile-name=" + name + "(\\s|\"|$)' -and $_.CommandLine -notlike '*--type=*' })",
    "$ids = New-Object System.Collections.Generic.List[int]",
    "foreach ($m in $main) { $ids.Add([int]$m.ProcessId) }",
    "$grew = $true; while ($grew) { $grew = $false; foreach ($p in $all) { if (-not $ids.Contains([int]$p.ProcessId) -and $ids.Contains([int]$p.ParentProcessId)) { $ids.Add([int]$p.ProcessId); $grew = $true } } }",
    "$procs = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) })",
    "function Kind($p) { if ($p.CommandLine -match '--type=([a-z-]+)') { $matches[1] } else { 'main' } }",
  ].join('\n');
}

function runPs(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
}

function listPids(name) {
  return runPs(psTree(name) + "\nif (-not $procs.Count) { 'none: no process has --profile-name=" + name + "' } else { $procs | ForEach-Object { '{0,7}  {1,-12} {2,8:N0} MB' -f $_.ProcessId, (Kind $_), ($_.WorkingSetSize / 1MB) } }");
}

function watch(name, seconds) {
  const n = Math.max(2, Math.min(600, Math.round(seconds / 2)));
  return runPs(psTree(name) + [
    "",
    "if (-not $procs.Count) { 'none: no process has --profile-name=" + name + "'; exit 0 }",
    "$cores = [Environment]::ProcessorCount",
    "for ($i = 0; $i -lt " + n + "; $i++) {",
    "  $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids.Contains([int]$_.IDProcess) }",
    "  $by = @{}; $total = 0",
    "  foreach ($q in $perf) { $p = $procs | Where-Object { $_.ProcessId -eq $q.IDProcess } | Select-Object -First 1; $k = if ($p) { Kind $p } else { '?' }; $v = $q.PercentProcessorTime / $cores; $by[$k] = $by[$k] + $v; $total += $v }",
    "  $parts = ($by.Keys | Sort-Object | ForEach-Object { '{0} {1:N1}' -f $_, $by[$_] }) -join ' | '",
    "  '{0:HH:mm:ss}  total {1,5:N1} %  ({2})' -f (Get-Date), $total, $parts",
    "  Start-Sleep -Seconds 2",
    "}",
  ].join('\n'));
}

function stop(name) {
  return runPs(psTree(name) + "\nif (-not $procs.Count) { 'none running' } else { $ids.Reverse(); foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }; 'stopped ' + $ids.Count + ' process(es): ' + ($ids -join ', ') }");
}

/* ---------- main ---------- */

function arg(argv, key) {
  const a = argv.find((x) => x.startsWith('--' + key + '='));
  return a ? a.slice(key.length + 3) : null;
}

async function main(argv) {
  const name = cleanName(arg(argv, 'profile-name'));
  if (argv.includes('--pids')) { process.stdout.write(listPids(name)); return 0; }
  if (argv.includes('--watch')) { process.stdout.write(watch(name, Number(arg(argv, 'seconds')) || 60)); return 0; }
  if (argv.includes('--stop') || argv.includes('--remove')) {
    console.log('newlook-preview: ' + stop(name).trim());
    if (argv.includes('--remove')) {
      const dir = path.join(os.tmpdir(), 'browser-test-profile-' + name);
      await new Promise((r) => setTimeout(r, 1500));      // let Chromium let go of its files
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); console.log('newlook-preview: removed ' + dir); }
      catch (e) { console.log('newlook-preview: FAILED to remove ' + dir + ': ' + (e.code || e.message)); return 1; }
    }
    return 0;
  }

  const p = plan({
    repoDir: path.join(__dirname, '..'), env: process.env, tmpdir: os.tmpdir(), home: os.homedir(),
    appdata: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    platform: process.platform, name, exists: (f) => fs.existsSync(f),
  });
  if (!p.ok) { console.log('newlook-preview: REFUSED - ' + p.refusal); return 2; }
  const dry = argv.includes('--dry-run');

  // The picture: read the real Look Sync folder, write only the test one.
  const LS = require('../looksync/look-sync');
  const real = LS.read(p.realSyncDir);
  let stills = [];
  try {
    stills = fs.readdirSync(path.join(p.realSyncDir, 'stills')).map((n) => {
      try { return { name: n, mtimeMs: fs.statSync(path.join(p.realSyncDir, 'stills', n)).mtimeMs }; } catch { return null; }
    }).filter(Boolean);
  } catch { /* no stills folder: seed() says so */ }
  const test = LS.read(p.syncDir);
  const s = seed(real.state === 'ok' ? real.doc : null, stills, test.state === 'ok' ? test.doc : null, p.realSyncDir, p.syncDir);
  if (real.state !== 'ok') console.log('newlook-preview: the real look.json: ' + real.state + (real.reason ? ' (' + real.reason + ')' : ''));
  console.log('newlook-preview: picture: ' + (s.ok ? s.reason : s.reason));

  console.log('newlook-preview: checkout  ' + p.repoDir);
  console.log('newlook-preview: profile   ' + p.profileDir);
  console.log('newlook-preview: command   "' + p.exe + '" ' + p.args.map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' '));
  if (dry) { console.log('newlook-preview: dry run: nothing copied, nothing launched'); return 0; }

  if (s.ok) {
    if (!p.syncDir.toLowerCase().startsWith(p.profileDir.toLowerCase() + path.sep)) { console.log('newlook-preview: REFUSED - the seed target is outside the test profile'); return 2; }
    fs.mkdirSync(path.dirname(s.copyTo), { recursive: true });
    fs.copyFileSync(s.copyFrom, s.copyTo);
    const w = await LS.writeAtomic(p.syncDir, JSON.stringify(s.doc, null, 2) + '\n', { app: 'preview' });
    if (!w.ok) { console.log('newlook-preview: FAILED to seed the test look.json: ' + w.reason); return 1; }
    console.log('newlook-preview: seeded    ' + s.copyTo + ' and ' + path.join(p.syncDir, 'look.json'));
  }
  const child = spawn(p.exe, p.args, { cwd: p.repoDir, env: p.env, detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', (e) => { console.log('newlook-preview: FAILED to start: ' + e.message); process.exitCode = 1; });
  child.unref();
  if (child.pid) console.log('newlook-preview: started, pid ' + child.pid + '. If a preview was already open, this one hands over to it and exits.');
  return 0;
}

module.exports = { DEFAULT_NAME, cleanName, cleanEnv, plan, seed, psTree };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { if (code) process.exitCode = code; }, (e) => {
    console.log('newlook-preview: FAILED - ' + (e && e.message || e)); process.exitCode = 1;
  });
}
