'use strict';
/*
 * golive-lockfile.js -- may a package-lock.json change ride a CODE-ONLY go-live (tools/quartz-ff-golive.ps1)?
 *
 * Only one kind may: a version bump. npm writes the lockfile's root "version" and packages[""].version
 * from package.json's "version"; they pin nothing it installs. So a lockfile whose only changes are
 * those two fields, both equal to the target package.json's "version", leaves node_modules valid.
 * Anything else (a dependency, any other field of packages[""], a version that does not match
 * package.json, a lockfile that does not parse) is a dependency release and is refused.
 *
 * Parsed with JSON.parse (what npm itself uses; a BOM is dropped, as npm does). Windows PowerShell
 * 5.1's ConvertFrom-Json cannot read a lockfile at all: it rejects the "" key under "packages".
 * After the two fields are removed, the rest must be equal as parsed values with the same key order
 * (JSON.stringify), so whitespace does not count and a reordered key does (a refusal, the safe side).
 *
 *   node tools/golive-lockfile.js <repo> <old-rev> <new-rev>
 *
 * reads <rev>:package-lock.json for both revs and <new-rev>:package.json from git in <repo>, prints
 * one line and exits 0 (code-only), 1 (refused) or 2 (could not read them; the caller refuses too).
 */
const { execFileSync } = require('child_process');

function parseObject(text, label) {
  if (typeof text !== 'string') return { error: label + ' is missing' };
  let v;
  try { v = JSON.parse(text.replace(/^﻿/, '')); } catch (err) { return { error: label + ' is not valid JSON (' + String(err.message).split('\n')[0] + ')' }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: label + ' is not a JSON object' };
  return { value: v };
}
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const show = (v) => (v === undefined ? 'absent' : JSON.stringify(v));

// The first path where a and b differ, for the refusal line ('' when they are equal).
function firstDiff(a, b, at) {
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return at + '[' + JSON.stringify(k) + '] removed';
      const d = firstDiff(a[k], b[k], at + '[' + JSON.stringify(k) + ']');
      if (d) return d;
    }
    for (const k of kb) if (!Object.prototype.hasOwnProperty.call(a, k)) return at + '[' + JSON.stringify(k) + '] added';
    if (ka.join('\u0000') !== kb.join('\u0000')) return at + ' key order changed';
    return '';
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) return at + ' changed';
  return '';
}

/**
 * lockVersionOnly(oldLockText, newLockText, newPackageJsonText) -> { ok, reason }
 * ok is true only for identical lockfiles or a change to nothing but the root "version" and
 * packages[""].version, both equal to the new package.json's "version".
 */
function lockVersionOnly(oldText, newText, pkgText) {
  if (typeof oldText === 'string' && oldText === newText) return { ok: true, reason: 'package-lock.json is identical' };
  const o = parseObject(oldText, 'the HEAD package-lock.json');
  if (o.error) return { ok: false, reason: o.error };
  const n = parseObject(newText, 'the target package-lock.json');
  if (n.error) return { ok: false, reason: n.error };
  const p = parseObject(pkgText, 'the target package.json');
  if (p.error) return { ok: false, reason: p.error };
  const want = p.value.version;
  if (typeof want !== 'string' || !want) return { ok: false, reason: 'the target package.json has no "version" string (' + show(want) + ')' };
  const oldLock = o.value, newLock = n.value;
  if (!isObj(oldLock.packages) || !isObj(oldLock.packages[''])) return { ok: false, reason: 'the HEAD package-lock.json has no packages[""] object' };
  if (!isObj(newLock.packages) || !isObj(newLock.packages[''])) return { ok: false, reason: 'the target package-lock.json has no packages[""] object' };
  if (newLock.version !== want) return { ok: false, reason: 'its root "version" is ' + show(newLock.version) + ', not the package.json "version" ' + JSON.stringify(want) };
  if (newLock.packages[''].version !== want) return { ok: false, reason: 'its packages[""].version is ' + show(newLock.packages[''].version) + ', not the package.json "version" ' + JSON.stringify(want) };
  const strip = (lock) => {
    const c = JSON.parse(JSON.stringify(lock));
    delete c.version;
    delete c.packages[''].version;
    return c;
  };
  const a = strip(oldLock), b = strip(newLock);
  if (JSON.stringify(a) !== JSON.stringify(b)) return { ok: false, reason: 'it changes more than its version: ' + (firstDiff(a, b, '') || 'the parsed values differ') };
  return { ok: true, reason: 'only its root "version" and packages[""].version changed, ' + show(oldLock.version) + ' -> ' + JSON.stringify(want) + ' (= the target package.json "version")' };
}

module.exports = { lockVersionOnly };

if (require.main === module) {
  const [repo, oldRev, newRev] = process.argv.slice(2);
  if (!repo || !oldRev || !newRev) { console.log('usage: node golive-lockfile.js <repo> <old-rev> <new-rev>'); process.exit(2); }
  const git = (spec) => execFileSync('git', ['show', spec], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  let oldLock, newLock, pkg;
  try {
    oldLock = git(oldRev + ':package-lock.json');
    newLock = git(newRev + ':package-lock.json');
    pkg = git(newRev + ':package.json');
  } catch (err) {
    console.log('git show failed: ' + String((err.stderr && String(err.stderr).trim()) || err.message).split('\n')[0]);
    process.exit(2);
  }
  const r = lockVersionOnly(oldLock, newLock, pkg);
  console.log(r.reason);
  process.exit(r.ok ? 0 : 1);
}
