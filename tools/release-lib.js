'use strict';
/*
 * release-lib.js -- what tools/release-gate.js and tools/release-rollback.js share: the public
 * repository's name, the releases feed, version arithmetic, the one AUTONOMY line, and a process
 * runner. Pure node; everything that leaves the machine goes through an injectable function, so the
 * tests (tests/release-gate-test.js) drive every path with fakes and never call gh or GitHub.
 */
const { spawn } = require('child_process');

// The canonical public repository. (The updater still names the old owner, which GitHub redirects;
// the tools ask the canonical name, so a broken redirect shows up here first.)
const SLUG = 'atlas-studio-software/quartz';
const API = 'https://api.github.com';
const INSTALLER_ASSET = 'Quartz-Setup.exe';
const CAP_MS = 48 * 60 * 60 * 1000;   // at most one autonomous release per 48 h

/** Run a process, never through a shell. Resolves { code, stdout, stderr }; never rejects. */
function run(cmd, args, o) {
  const opts = o || {};
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, opts.env || {}) });
    } catch (e) { resolve({ code: -1, stdout: '', stderr: e.message }); return; }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, stdout: out, stderr: e.code === 'ENOENT' ? cmd + ' was not found on PATH' : e.message }));
    child.on('close', (code) => resolve({ code: code == null ? -1 : code, stdout: out, stderr: err }));
  });
}

/** GET a GitHub API path without signing in. Resolves { status, body } or { status: 0, error }. */
async function fetchJson(apiPath) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(API + apiPath, { signal: ac.signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Quartz-release-tools', 'X-GitHub-Api-Version': '2022-11-28' } });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, error: String((e && e.cause && e.cause.code) || (e && e.message) || e) };
  } finally { clearTimeout(t); }
}

/**
 * The public releases feed as the updater and the public see it: { latest, list } where latest is
 * GitHub's "latest release" (or null when there is none) and list holds every published release
 * (pre-releases included; drafts are never visible without signing in). Throws with a sentence when
 * the feed cannot be read.
 */
async function readFeed(fetchFn) {
  const f = fetchFn || fetchJson;
  const l = await f('/repos/' + SLUG + '/releases/latest');
  if (l.status === 0) throw new Error('the releases feed could not be read (' + l.error + ')');
  if (l.status !== 200 && l.status !== 404) throw new Error('the releases feed answered ' + l.status);
  const all = await f('/repos/' + SLUG + '/releases?per_page=100');
  if (all.status !== 200 || !Array.isArray(all.body)) throw new Error('the release list could not be read (' + (all.error || all.status) + ')');
  return { latest: l.status === 200 && l.body && l.body.tag_name ? l.body : null, list: all.body.filter((r) => r && !r.draft) };
}

/** "v1.2.3" or "1.2.3" -> { major, minor, patch, text } ; anything else (a pre-release too) -> null. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], text: m[1] + '.' + m[2] + '.' + m[3] } : null;
}

/** Is `next` a patch release after `latest`? { ok, why }. */
function patchOnly(next, latest) {
  const a = parseVersion(next), b = parseVersion(latest);
  if (!a) return { ok: false, why: 'the version "' + next + '" is not a plain X.Y.Z' };
  if (!b) return { ok: false, why: 'the latest release "' + latest + '" has no plain X.Y.Z version' };
  if (a.major !== b.major || a.minor !== b.minor) return { ok: false, why: a.text + ' is not a patch release after ' + b.text + ' (major or minor changed; that needs the owner)' };
  if (a.patch <= b.patch) return { ok: false, why: a.text + ' is not newer than the latest release ' + b.text };
  return { ok: true, why: a.text + ' is a patch release after ' + b.text };
}

/** The one line callers read: AUTONOMY: {"class":...,"target":...,"result":...[,"why":...]}. */
function autonomyLine(cls, target, result, why) {
  const o = { class: cls, target: String(target || ''), result };
  if (why) o.why = String(why).slice(0, 400);
  return 'AUTONOMY: ' + JSON.stringify(o);
}

/* ---- the studio's autonomy mode (one formula for every reader) ------------------------------------ */

// Outside the repository; on any other machine it is absent, which is OFF. Tests point
// QUARTZ_GATE_AUTONOMY_DIR at a temp folder (honoured by autonomyDir() only).
const AUTONOMY_DIR = require('path').join(require('os').homedir(), 'helm-team', 'atlas-studio', 'autonomy');
function autonomyDir(opt) { return opt || process.env.QUARTZ_GATE_AUTONOMY_DIR || AUTONOMY_DIR; }

/** mode.json as an object, or null (missing, unreadable, not JSON, not an object, an array). */
function readMode(dir) {
  try {
    const m = JSON.parse(require('fs').readFileSync(require('path').join(dir, 'mode.json'), 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch { return null; }
}

/**
 * 'ON' | 'PAUSED' | 'OFF' at time `now` (ms, a Date or a date string), exactly as the autonomy
 * contract's section 1 formula:
 *   ACTIVE = mode.json parses to an object (not an array) && mode.on === true && live(mode.length)
 *            && policy.json exists && mode.policySha === sha256hex(policy.json bytes) (exact)
 *            && STOP does not exist
 *   live(l) = l is an object && (l.kind === "open"
 *             || (l.kind === "fixed" && Number.isFinite(Date.parse(l.endsAt)) && now < Date.parse(l.endsAt)))
 *   ON = ACTIVE && !mode.paused;  PAUSED = ACTIVE && !!mode.paused;  OFF = everything else
 * Any error reading any of the files is OFF.
 */
function modeState(dir, now) {
  const fs = require('fs');
  const path = require('path');
  const t = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : typeof now === 'number' ? now : Date.now();
  try {
    const mode = readMode(dir);
    if (!mode || mode.on !== true) return 'OFF';
    const l = mode.length;
    const live = !!l && typeof l === 'object' && (l.kind === 'open' || (l.kind === 'fixed' && Number.isFinite(Date.parse(l.endsAt)) && t < Date.parse(l.endsAt)));
    if (!live) return 'OFF';
    const policy = fs.readFileSync(path.join(dir, 'policy.json'));
    if (mode.policySha !== require('crypto').createHash('sha256').update(policy).digest('hex')) return 'OFF';
    try { fs.statSync(path.join(dir, 'STOP')); return 'OFF'; } catch (e) { if (!e || e.code !== 'ENOENT') return 'OFF'; }
    return mode.paused ? 'PAUSED' : 'ON';
  } catch { return 'OFF'; }
}

/** Is `cls` held in mode.json's holds? A missing or non-array holds is none. */
function modeHolds(dir, cls) {
  const mode = readMode(dir);
  return !!mode && Array.isArray(mode.holds) && mode.holds.includes(cls);
}

module.exports = { SLUG, API, INSTALLER_ASSET, CAP_MS, run, fetchJson, readFeed, parseVersion, patchOnly, autonomyLine, AUTONOMY_DIR, autonomyDir, readMode, modeState, modeHolds };
