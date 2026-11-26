'use strict';
/*
 * golive-lockfile-test.js -- tools/golive-lockfile.js: which package-lock.json changes a CODE-ONLY
 * go-live (tools/quartz-ff-golive.ps1) may take. Only a version bump (the lockfile's root "version"
 * and packages[""].version, both equal to the target package.json's "version"); everything else is a
 * dependency release and refused. The pure decision on hand-made lockfiles, then the command line on
 * a throwaway git repo (exit 0 / 1 / 2, as the script reads them).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const HELPER = path.join(__dirname, '..', 'tools', 'golive-lockfile.js');
const { lockVersionOnly } = require(HELPER);

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log('PASS ' + label); }
  else { fail++; console.log('FAIL ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail))); }
}

function lock(version, opts = {}) {
  const root = {
    name: 'browser', version, hasInstallScript: true, license: 'GPL-3.0-only',
    dependencies: { 'left-pad': '^1.3.0' },
    devDependencies: { electron: 'github:castlabs/electron-releases#v1.0.0+wvcus' },
  };
  if (opts.rootVersion !== undefined) root.version = opts.rootVersion;
  const l = {
    name: 'browser', version, lockfileVersion: 3, requires: true,
    packages: {
      '': root,
      'node_modules/left-pad': { version: opts.dep || '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: 'sha512-AAAA' },
    },
  };
  return l;
}
const txt = (o, indent = 2) => JSON.stringify(o, null, indent) + '\n';
const pkg = (version) => txt({ name: 'browser', productName: 'Quartz', version, main: 'main.js' });

const OLD = txt(lock('0.1.1'));
const PKG2 = pkg('0.1.2');
let r;

r = lockVersionOnly(OLD, txt(lock('0.1.2')), PKG2);
check(r.ok === true && /0\.1\.1" -> "0\.1\.2"/.test(r.reason), 'version-only change (root + packages[""], = package.json) -> allowed', r);

r = lockVersionOnly(OLD, OLD, PKG2);
check(r.ok === true && /identical/.test(r.reason), 'identical lockfiles -> allowed', r);

r = lockVersionOnly(OLD, txt(lock('0.1.2', { dep: '1.3.1' })), PKG2);
check(r.ok === false && /node_modules\/left-pad/.test(r.reason), 'version + one dependency change -> refused (names the path)', r);

r = lockVersionOnly(OLD, txt(lock('0.1.2')), pkg('0.1.3'));
check(r.ok === false && /root "version"/.test(r.reason), 'version not matching package.json -> refused', r);

r = lockVersionOnly(OLD, txt(lock('0.1.2', { rootVersion: '0.1.1' })), PKG2);
check(r.ok === false && /packages\[""\]\.version/.test(r.reason), 'root version matches but packages[""].version does not -> refused', r);

{ const l = lock('0.1.2'); l.packages[''].hasInstallScript = false;
  r = lockVersionOnly(OLD, txt(l), PKG2);
  check(r.ok === false && /hasInstallScript/.test(r.reason), 'another field in packages[""] changed (hasInstallScript) -> refused', r); }

{ const l = lock('0.1.2'); l.packages[''].devDependencies.electron = 'github:castlabs/electron-releases#v2.0.0+wvcus';
  r = lockVersionOnly(OLD, txt(l), PKG2);
  check(r.ok === false && /devDependencies/.test(r.reason), 'packages[""].devDependencies changed (a new Electron) -> refused', r); }

{ const l = lock('0.1.2'); l.packages[''].name = 'other';
  r = lockVersionOnly(OLD, txt(l), PKG2);
  check(r.ok === false, 'packages[""].name changed -> refused', r); }

{ const l = lock('0.1.2'); l.packages['node_modules/extra'] = { version: '1.0.0' };
  r = lockVersionOnly(OLD, txt(l), PKG2);
  check(r.ok === false && /added/.test(r.reason), 'a package added -> refused', r); }

{ const l = lock('0.1.2'); l.lockfileVersion = 2;
  r = lockVersionOnly(OLD, txt(l), PKG2);
  check(r.ok === false && /lockfileVersion/.test(r.reason), 'another root field changed (lockfileVersion) -> refused', r); }

{ const l = lock('0.1.2'); delete l.version;
  r = lockVersionOnly(OLD, txt(l), PKG2);
  check(r.ok === false, 'root "version" removed -> refused', r); }

{ const o = lock('0.1.2'); const l = { packages: o.packages, name: o.name, version: o.version, lockfileVersion: 3, requires: true };
  r = lockVersionOnly(OLD, txt(l), PKG2);
  check(r.ok === false && /order/.test(r.reason), 'root keys reordered -> refused (the safe side)', r); }

r = lockVersionOnly(OLD, txt(lock('0.1.2'), 4), PKG2);
check(r.ok === true, 'version bump with the lockfile re-indented -> allowed (parsed, whitespace does not count)', r);

r = lockVersionOnly(OLD, '﻿' + txt(lock('0.1.2')), PKG2);
check(r.ok === true, 'a BOM is dropped, as npm does', r);

r = lockVersionOnly(OLD, '{ "name": "browser", ', PKG2);
check(r.ok === false && /not valid JSON/.test(r.reason), 'an unparseable target lockfile -> refused', r);

r = lockVersionOnly(OLD, txt(lock('0.1.2')), '{}');
check(r.ok === false && /no "version"/.test(r.reason), 'a package.json without "version" -> refused', r);

r = lockVersionOnly(OLD, txt(lock('0.1.2')), '[1]');
check(r.ok === false, 'a package.json that is not an object -> refused', r);

{ const l = lock('0.1.2'); delete l.packages[''];
  r = lockVersionOnly(OLD, txt(l), PKG2);
  check(r.ok === false && /packages\[""\]/.test(r.reason), 'no packages[""] in the target -> refused', r); }

// ---- the command line, on a throwaway repo ----------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-lockfile-'));
const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (lockText, pkgText, msg) => {
  fs.writeFileSync(path.join(dir, 'package-lock.json'), lockText);
  fs.writeFileSync(path.join(dir, 'package.json'), pkgText);
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
};
const cli = (a, b) => spawnSync(process.execPath, [HELPER, dir, a, b], { encoding: 'utf8' });
try {
  git('init', '-q');
  const c1 = commit(OLD, pkg('0.1.1'), 'one');
  const c2 = commit(txt(lock('0.1.2')), PKG2, 'bump');
  const c3 = commit(txt(lock('0.1.2', { dep: '1.3.1' })), PKG2, 'dep');
  let s = cli(c1, c2);
  check(s.status === 0 && /0\.1\.1" -> "0\.1\.2"/.test(s.stdout), 'cli: the version bump exits 0 with one line', { status: s.status, out: s.stdout });
  s = cli(c1, c3);
  check(s.status === 1 && /left-pad/.test(s.stdout), 'cli: a dependency change exits 1 and names it', { status: s.status, out: s.stdout });
  s = cli(c1, 'no-such-rev');
  check(s.status === 2 && /git show failed/.test(s.stdout), 'cli: an unreadable rev exits 2 (the script refuses on it too)', { status: s.status, out: s.stdout });
  s = spawnSync(process.execPath, [HELPER], { encoding: 'utf8' });
  check(s.status === 2, 'cli: no arguments exits 2', { status: s.status });
} catch (err) {
  check(false, 'cli: the throwaway repo', String(err.message).split('\n')[0]);
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ---- the script uses it, before Quartz is closed ------------------------------------------------
const ff = (() => { try { return fs.readFileSync(path.join(__dirname, '..', 'tools', 'quartz-ff-golive.ps1'), 'utf8'); } catch { return ''; } })();
const lines = ff.split(/\r?\n/);
const at = (re) => lines.findIndex((l) => re.test(l));
const callAt = at(/Run 'node' @\(\$lockJs, \$Repo, \$script:oldHead, \$target\)/);
const refuseAt = at(/if \(\$lv\.code -ne 0\) \{ Stop-Golive \(Dependency-Release/);
const closeAt = at(/^# ---- 2\. close Quartz/);
check(/Join-Path \$PSScriptRoot 'golive-lockfile\.js'/.test(ff), 'quartz-ff-golive.ps1: the helper is the one next to the script');
check(callAt > 0 && refuseAt > callAt && closeAt > refuseAt, 'quartz-ff-golive.ps1: any non-zero helper exit refuses through Dependency-Release, before the close step', { callAt, refuseAt, closeAt });

console.log('golive-lockfile-test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
