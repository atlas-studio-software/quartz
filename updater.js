'use strict';
/*
 * updater.js -- in-app updates for a Quartz that was installed from source (a git clone).
 *
 * Pure Node: no Electron in here, so tests/updater-test.js drives every path with throwaway git
 * repos and a fake fetch. updater-main.js wires it to the app (IPC, the timer, the restart) and
 * updater-chrome.js draws it (the card in the corner, and the Updates rows in Settings > About).
 *
 * WHERE A RELEASE COMES FROM. GitHub Releases of the public repo: an unauthenticated
 *   GET {apiBase}/repos/{owner}/{repo}/releases/latest
 * with the last ETag in If-None-Match, so an unchanged answer is a 304 and costs almost nothing.
 * A rate-limited answer (403/429 with no requests left, or Retry-After) is said as such and the
 * next check waits for GitHub's reset time. Owner, repo, the API base and fetch are injectable.
 *
 * WHEN AN UPDATE COUNTS AS AVAILABLE. Only when the release's tag commit is NOT already in HEAD:
 * the tag is fetched, then `git merge-base --is-ancestor <tag> HEAD`. A folder at or ahead of the
 * release is never prompted.
 *
 * WHEN THE UPDATE BUTTON IS OFFERED. Every one of these must hold; otherwise the user is told
 * exactly which did not, and shown the commands to update by hand:
 *   - the app folder is a normal git clone (a linked worktree, where .git is a file, never checks);
 *   - its origin is the public repo;  - it is on the default branch;
 *   - tracked files have no uncommitted changes;  - it is not a shallow clone;
 *   - a fast-forward to the tag is possible;
 *   - when the release changes the dependencies (package.json or package-lock.json beyond their
 *     version fields): npm and node are on PATH;
 *   - the release tag is signed by a key in release-signers AS INSTALLED HERE, and names exactly the
 *     commit the update merges (see "signed release tags" below). A copy with no key yet says so.
 *
 * WHAT UPDATE DOES.
 *   0. Re-check the release: read releases/latest again (the card can be hours old). A release
 *      that is no longer the latest (pulled back to draft or pre-release, or replaced) is refused
 *      and its offer cleared; a feed that cannot be read refuses too and is tried again later.
 *      After a staged npm ci (minutes) the same re-check runs once more, before the restart.
 *   1. Downloading: fetch the tag again and re-check every condition above.
 *   2. Installing: only when the dependencies changed (see depsChanged), `npm ci` runs in a
 *      STAGING copy of the release (<app>\.quartz-update\tree, exported from git without touching
 *      the index). It cannot run in place: Windows will not delete node_modules\electron\dist while
 *      Quartz is running from it, and npm ci starts by deleting node_modules. This is the step that
 *      can take minutes (it downloads the castlabs Electron the release pins), and the progress
 *      text says so. Without new dependencies: `git merge --ff-only <tag>` here and now.
 *   3. Restarting: through Quartz's normal quit path, so the session and tabs restore. When new
 *      dependencies were staged, a small helper (runSwap below, run by node from PATH) waits for
 *      Quartz to exit, THEN runs `git merge --ff-only <tag>` and swaps the staged node_modules in,
 *      and starts Quartz again. Until Quartz has quit, the app folder is untouched.
 *
 * IF ANYTHING FAILS. `git reset --keep <old sha>`; a staged node_modules is thrown away (the live
 * one was never touched, so there is nothing to reinstall); the swap helper renames the old
 * node_modules back. Quartz stays on the old version and says why, with the log's path. Never a
 * half-updated install.
 *
 * AN INSTALLED COPY (opts.installed: Quartz-Setup.exe put it in its own folder, see install-mode.js).
 *   There is no git folder, so nothing above applies except the check itself: the same releases
 *   API, the release counts as available when its version is newer than package.json's, and the
 *   state carries `download`, the installer's stable link, in place of an Update button. update()
 *   refuses with the reason. Running the new installer over this copy is the update.
 *
 * NEVER SILENT. Every state carries a sentence: why there is no check (off), why a check failed,
 * why there is no button, why an update failed and where its log is.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const OWNER = 'atlas-studio-software';
const REPO = 'quartz';
// Where the repo lived before it moved to the organisation. GitHub redirects that URL (API and
// git), and every clone made before the move still has it as origin, so it stays the public repo
// too: a check that took only the new URL would quietly drop the Update button from those clones.
const MOVED_FROM_OWNERS = ['Owen-Silva'];
const API_BASE = 'https://api.github.com';
// An installed copy's way to update: the installer on the latest release, under a name that never
// changes. Kept here, not required from install-mode.js (which says the same): this file also runs
// on its own as the swap helper, copied into the profile folder, where no sibling module exists.
const INSTALLER_URL = 'https://github.com/' + OWNER + '/' + REPO + '/releases/latest/download/Quartz-Setup.exe';
const OPT_OUT_FILE = 'no-updates.local';     // in the app folder: present = the updater is off
const STAGING_DIR = '.quartz-update';        // in the app folder (same volume, so the swap is a rename)
const STATE_FILE = 'updates.json';           // in the profile folder
const LOG_FILE = 'updater.log';              // in the profile folder
const PLAN_FILE = 'update-swap-plan.json';   // in the profile folder, for the swap helper
const RESULT_FILE = 'update-swap-result.json';
const HELPER_FILE = 'update-swap.js';
const FIRST_CHECK_MS = 30 * 1000;
const EVERY_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;             // after a failed check
const SNOOZE_MS = 24 * 60 * 60 * 1000;       // "Later"
const FETCH_TIMEOUT_MS = 15000;
const LOG_MAX_BYTES = 1024 * 1024;
// This file as it was when Quartz started: the swap helper must be the version that wrote the
// plan, not the one the merge just put on disk.
let SELF_SOURCE = null;
try { SELF_SOURCE = fs.readFileSync(__filename); } catch { /* copied from disk instead */ }
const NPM_TEXT = 'Installing dependencies with npm ci. This can take several minutes: it downloads ' +
  'the castlabs Electron this release pins. You can keep browsing meanwhile.';

/* ---- small pure helpers (exported for the tests) -------------------------------------------- */

/** A clone URL or a path, reduced to one comparable form: "github.com/atlas-studio-software/quartz". */
function normaliseRepoUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  let m = /^[\w.-]+@([^:/\\]+):(?!\/\/)(.+)$/.exec(s);                       // git@github.com:o/r.git
  if (m) s = m[1] + '/' + m[2];
  else if ((m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(s))) s = m[1] + '/' + m[2];
  else s = path.resolve(s.replace(/^file:\/\/\/(?=[A-Za-z]:)/i, '').replace(/^file:\/\//i, ''));
  return s.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

/** Every clone URL that counts as the public repo: where it lives now first, then where it lived. */
const PUBLIC_REPO_URLS = [OWNER].concat(MOVED_FROM_OWNERS).map((owner) => 'https://github.com/' + owner + '/' + REPO + '.git');

/** True when `url` (an origin, in any of git's forms) is one of `urls` (default: PUBLIC_REPO_URLS). */
function isPublicRepo(url, urls) {
  const key = normaliseRepoUrl(url);
  return !!key && (urls || PUBLIC_REPO_URLS).some((u) => normaliseRepoUrl(u) === key);
}

/** "v1.2.10" vs "1.2.9": 1, -1 or 0. Anything that is not a version compares as 0. */
function compareVersions(a, b) {
  const p = (v) => String(v || '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10));
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) return 0;
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

/** Why a request never got an answer, in plain words. */
function netWhy(err) {
  const c = (err && err.cause) || {};
  const code = String(c.code || (err && err.code) || '');
  if (err && err.name === 'AbortError') return 'GitHub did not answer within ' + Math.round(FETCH_TIMEOUT_MS / 1000) + ' s';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'no internet (api.github.com could not be found)';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/.test(code)) {
    return 'no internet (GitHub could not be reached: ' + code + ')';
  }
  const msg = String((err && err.message) || err || '').trim();
  return msg ? 'the request failed: ' + msg.slice(0, 160) : 'the request failed';
}

/**
 * Does moving between these two package.json / package-lock.json pairs need npm ci? Every release
 * bumps "version" in both files, and that alone must not cost the user a multi-minute reinstall,
 * so the version fields are set aside before comparing. Anything unreadable counts as a change.
 */
function depsChanged(oldPkg, newPkg, oldLock, newLock) {
  const strip = (text, isLock) => {
    if (text == null) return null;
    const j = JSON.parse(text);
    delete j.version;
    if (isLock && j.packages && j.packages['']) delete j.packages[''].version;
    return JSON.stringify(j);
  };
  try {
    return strip(oldPkg, false) !== strip(newPkg, false) || strip(oldLock, true) !== strip(newLock, true);
  } catch {
    return true;
  }
}

function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
function tail(s, n) { const t = String(s || '').trim(); return t.length > (n || 300) ? '…' + t.slice(-(n || 300)) : t; }
function short(sha) { return String(sha || '').slice(0, 7); }
function clock(ms) { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

/* ---- signed release tags ---------------------------------------------------------------------- */
/*
 * A release is installed only when its tag is signed by a key listed in release-signers AS IT IS IN
 * THE COPY ALREADY INSTALLED. That file is read from the app folder before anything is fetched, and
 * the fetched release's own copy is never consulted, so a release can never vouch for itself: a new
 * key only counts once a release signed by an old key has put it there (tools/RELEASING.md).
 *
 * Git does the cryptography: `git verify-tag` with gpg.format=ssh hands the signature to
 * `ssh-keygen -Y verify` with the allowed-signers file, so no GPG install is needed. That takes git
 * 2.34 or newer and OpenSSH 8.2 or newer; Git for Windows and Windows 11's own OpenSSH both qualify.
 * Every setting the check depends on is passed on the command line (format, signers file, program,
 * minimum trust), so the user's own git config can neither weaken it nor send it elsewhere.
 *
 * A good signature is not enough on its own: the signed tag object is read back and must name
 * exactly the commit the update merges, as a commit, under the release's own tag name. An old signed
 * tag re-published under a new name, or a signed tag that peels to some other commit, is refused.
 *
 * Bootstrap. Copies from before signing existed have no release-signers file, so they cannot check
 * anything (and the code that would check is not in them either). The release that first brings the
 * file is the one trust-on-first-use step; a copy of THIS code with no key in the file says so in
 * the card instead of skipping in silence. Any line in the file that is not a comment counts as a
 * key, so a damaged file fails closed (ssh-keygen rejects it) rather than switching the check off.
 *
 * Once a key is in place, an unsigned, wrongly signed or uncheckable tag is refused: no merge,
 * nothing in the app folder changed, and the reason is in the card, in Settings > About, in
 * updater.log and in quartz.log. A git or ssh-keygen too old or missing to check is said as exactly
 * that, never treated as a pass.
 */
const SIGNERS_FILE = 'release-signers';
const MIN_GIT_SSH = [2, 34];
const KEY_TYPE = /^(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/;

/**
 * An allowed-signers text: { lines, keys }. lines = every non-comment line (what ssh-keygen gets);
 * keys = the ones that parse as "principal [options] keytype base64key".
 */
function parseSigners(text) {
  const lines = [];
  const keys = [];
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    lines.push(line);
    const t = line.split(/\s+/);
    for (let i = 1; i < t.length - 1; i++) {
      if (KEY_TYPE.test(t[i]) && /^[A-Za-z0-9+/]+={0,2}$/.test(t[i + 1])) { keys.push({ principal: t[0], type: t[i], key: t[i + 1] }); break; }
    }
  }
  return { lines, keys };
}

/**
 * This copy's release keys, from the app folder on disk: { pinned, lines, keys, error }. A missing
 * file is "no key yet" (pinned false); an unreadable one is an error, which refuses every update.
 */
function readInstalledSigners(appDir) {
  let text;
  try { text = fs.readFileSync(path.join(appDir, SIGNERS_FILE), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { pinned: false, lines: [], keys: [], error: '' };
    return { pinned: true, lines: [], keys: [], error: (e && e.code) || String((e && e.message) || e) };
  }
  const p = parseSigners(text);
  return { pinned: p.lines.length > 0, lines: p.lines, keys: p.keys, error: '' };
}

/** "git version 2.53.0.windows.2" -> { major, minor, text } or null. */
function parseGitVersion(s) {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(String(s || ''));
  return m ? { major: +m[1], minor: +m[2], text: m[1] + '.' + m[2] + (m[3] ? '.' + m[3] : '') } : null;
}

/** git verify-tag's words, as the reason a release is refused. */
function signatureWhy(tag, out) {
  const s = String(out || '');
  const fp = (/key (SHA256:[A-Za-z0-9+/=]+)/.exec(s) || [])[1];
  if (/no signature found/i.test(s)) return 'the release tag ' + tag + ' is not signed';
  if (/cannot verify a non-tag object/i.test(s)) return 'the release tag ' + tag + ' is not signed (it is a plain tag with no signature)';
  if (/No principal matched/i.test(s)) return 'the release tag ' + tag + ' is signed by a key this copy of Quartz does not trust' + (fp ? ' (' + fp + ')' : '');
  if (/cannot (?:spawn|run)|not found|No such file or directory/i.test(s) && !/allowed keys file/i.test(s)) {
    return 'git could not run ssh-keygen (OpenSSH), which it needs to check the signature on ' + tag + ': ' + tail(s.split(/\r?\n/)[0], 120);
  }
  if (/unknown option -- Y|illegal option -- Y|invalid option/i.test(s)) return 'this computer\'s ssh-keygen is too old to check SSH signatures (OpenSSH 8.2 or newer is needed)';
  if (/Signature verification failed|incorrect signature|Could not verify signature|Bad "git" signature/i.test(s)) return 'the signature on the release tag ' + tag + ' does not match its contents';
  if (/Unable to open allowed keys|allowed_signers|invalid key/i.test(s)) return 'this copy\'s ' + SIGNERS_FILE + ' file could not be used to check ' + tag + ': ' + tail(s.split(/\r?\n/).filter((l) => /allowed|invalid/i.test(l))[0] || s, 120);
  return 'git could not check the signature on ' + tag + (s.trim() ? ': ' + tail(s.trim().split(/\r?\n/)[0], 160) : '');
}

/**
 * Is the release tag signed by a key this copy trusts, and does it name exactly `sha`?
 *   o.run(args)      -> Promise<{ code, stdout, stderr }>, git in the app folder
 *   o.tag            the release's tag name;  o.tagObject  the tag object (sha) as fetched
 *   o.sha            the commit the update will merge
 *   o.signers        readInstalledSigners(appDir), read BEFORE the fetch
 *   o.bringsKey      (no key yet) whether the release carries one; only changes the sentence
 *   o.sshProgram     ssh-keygen by default (the tests point it at a missing program)
 * Resolves { ok, state: 'verified'|'unpinned'|'refused', tag, text, why?, principal?, fingerprint? }.
 * Never throws: an error is a refusal with its reason.
 */
async function verifyReleaseTag(o) {
  const tag = o.tag;
  const refuse = (why) => ({ ok: false, state: 'refused', tag, why, text: 'Quartz will not install ' + tag + ': ' + why + '.' });
  try {
    const s = o.signers || { pinned: false };
    if (s.error) return refuse('this copy\'s ' + SIGNERS_FILE + ' file could not be read (' + s.error + ')');
    if (!s.pinned) {
      return {
        ok: true, state: 'unpinned', tag,
        text: o.bringsKey
          ? 'This copy of Quartz has no release-signing key yet, so the signature on ' + tag + ' was not checked. This update brings the key; every update after it must be signed.'
          : 'Neither this copy of Quartz nor ' + tag + ' has a release-signing key (' + SIGNERS_FILE + '), so the signature on ' + tag + ' was not checked.',
      };
    }
    const v = await o.run(['--version']);
    const ver = parseGitVersion(v.stdout);
    if (!ver) return refuse('git could not say which version it is, so the signature on ' + tag + ' could not be checked');
    if (ver.major < MIN_GIT_SSH[0] || (ver.major === MIN_GIT_SSH[0] && ver.minor < MIN_GIT_SSH[1])) {
      return refuse('this computer\'s git (' + ver.text + ') cannot check SSH signatures; it needs git ' + MIN_GIT_SSH.join('.') + ' or newer');
    }
    const obj = String(o.tagObject || '').trim();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(obj)) return refuse('the release tag ' + tag + ' could not be read after the fetch');
    const type = await o.run(['cat-file', '-t', obj]);
    if (type.code !== 0) return refuse('the release tag ' + tag + ' could not be read: ' + tail(type.stderr, 120));
    if (type.stdout.trim() !== 'tag') return refuse('the release tag ' + tag + ' is not signed (it is a plain tag with no signature)');

    // The signature, against a private copy of the installed keys (comments dropped, LF endings).
    const dir = fs.mkdtempSync(path.join(o.tmpDir || os.tmpdir(), 'quartz-signers-'));
    let r;
    try {
      const file = path.join(dir, 'allowed_signers');
      fs.writeFileSync(file, s.lines.join('\n') + '\n');
      r = await o.run(['-c', 'gpg.format=ssh', '-c', 'gpg.ssh.allowedSignersFile=' + file.split(path.sep).join('/'),
        '-c', 'gpg.ssh.program=' + (o.sshProgram || 'ssh-keygen'), '-c', 'gpg.minTrustLevel=fully',
        'verify-tag', '--raw', obj]);
    } finally {
      try { removeTree(dir); } catch { /* a temp folder; the OS clears it */ }
    }
    const said = String(r.stderr || '') + '\n' + String(r.stdout || '');
    const good = /Good "git" signature for (\S+) with (\S+) key (SHA256:[A-Za-z0-9+/=]+)/.exec(said);
    if (r.code !== 0 || !good) return refuse(signatureWhy(tag, said));

    // A good signature on THIS release: the signed object must be this commit, under this name.
    const body = await o.run(['cat-file', 'tag', obj]);
    const head = String(body.stdout || '').split(/\r?\n\r?\n/)[0];
    const field = (k) => (new RegExp('^' + k + ' (.+)$', 'm').exec(head) || [])[1] || '';
    if (body.code !== 0) return refuse('the signed tag ' + tag + ' could not be read back: ' + tail(body.stderr, 120));
    if (field('type') !== 'commit') return refuse('the signed tag ' + tag + ' does not name a commit');
    if (field('object') !== o.sha) return refuse('the signed tag ' + tag + ' names commit ' + short(field('object')) + ', not ' + short(o.sha) + ', the commit this update would install');
    if (field('tag') !== tag) return refuse('the signature belongs to the tag "' + field('tag') + '", not ' + tag);
    return {
      ok: true, state: 'verified', tag, principal: good[1], fingerprint: good[3],
      text: 'The release tag ' + tag + ' is signed by a key this copy of Quartz trusts (' + good[1] + ', ' + good[3] + ').',
    };
  } catch (e) {
    return refuse('the signature on ' + tag + ' could not be checked: ' + String((e && e.message) || e));
  }
}

/* ---- the default runners (tests inject their own) --------------------------------------------- */

/** Run a command; resolves { code, stdout, stderr }. A missing program is code -1 with a sentence. */
function runCmd(cmd, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: o.env || process.env, windowsHide: true, shell: !!o.shell });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: cmd + ' could not start: ' + e.message });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      finish({ code: -1, stdout: out, stderr: err + '\n' + cmd + ' did not finish within ' + Math.round((o.timeoutMs || 120000) / 1000) + ' s' });
    }, o.timeoutMs || 120000);
    const onData = (which) => (d) => {
      const s = d.toString();
      if (which === 'out') out += s; else err += s;
      if (o.onLine) { for (const l of s.split(/\r?\n/)) if (l.trim()) o.onLine(l); }
    };
    child.stdout.on('data', onData('out'));
    child.stderr.on('data', onData('err'));
    child.on('error', (e) => finish({ code: -1, stdout: out, stderr: e.code === 'ENOENT' ? cmd + ' was not found on PATH' : String(e.message) }));
    child.on('close', (code) => finish({ code: code == null ? -1 : code, stdout: out, stderr: err }));
  });
}

function defaultGit(args, opts) {
  const env = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, (opts && opts.env) || {});
  return runCmd('git', args, Object.assign({}, opts, { env }));
}

function defaultNpm(args, opts) {
  // npm is npm.cmd on Windows, and a .cmd only starts through a shell (Node refuses it otherwise).
  return runCmd(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, Object.assign({ shell: process.platform === 'win32' }, opts));
}

async function defaultTools() {
  const n = await runCmd('node', ['--version'], { timeoutMs: 15000 });
  const m = await defaultNpm(['--version'], { timeoutMs: 30000 });
  if (n.code !== 0) return 'node was not found on PATH';
  if (m.code !== 0) return 'npm was not found on PATH';
  return '';
}

async function defaultFetch(url, init) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try { return await fetch(url, Object.assign({}, init, { signal: ac.signal })); } finally { clearTimeout(t); }
}

/** Remove a folder; a junction or symlink is unlinked, never followed into. */
function removeTree(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return; }
  if (st.isSymbolicLink()) { try { fs.rmdirSync(p); } catch { fs.unlinkSync(p); } return; }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) removeTree(path.join(p, name));
    fs.rmdirSync(p);
  } else {
    try { fs.unlinkSync(p); } catch (e) { if (e.code === 'EPERM') { fs.chmodSync(p, 0o666); fs.unlinkSync(p); } else throw e; }
  }
}

/* ---- what the app folder is ---------------------------------------------------------------- */

/**
 * '' when the updater may run here, else the sentence saying why it is fully off (no check, no
 * prompt): the opt-out file, or a linked worktree (.git is a file).
 */
function offReason(appDir) {
  if (fs.existsSync(path.join(appDir, OPT_OUT_FILE))) return 'turned off by ' + OPT_OUT_FILE + ' in the app folder';
  let st = null;
  try { st = fs.statSync(path.join(appDir, '.git')); } catch { /* no .git: not a clone, checked later */ }
  if (st && st.isFile()) return 'this folder is a linked git worktree, which never checks for updates';
  return '';
}

/* ---- the updater --------------------------------------------------------------------------- */

function createUpdater(opts) {
  const o = Object.assign({}, opts);
  const appDir = o.appDir;
  const dataDir = o.dataDir;
  const owner = o.owner || OWNER;
  const repo = o.repo || REPO;
  const apiBase = String(o.apiBase || API_BASE).replace(/\/+$/, '');
  const publicUrl = o.repoUrl || ('https://github.com/' + owner + '/' + repo + '.git');
  // The origins that count as the public repo. A caller naming its own repo (repoUrl, owner, repo:
  // the tests) gets just that one unless it lists more in repoUrls.
  const publicUrls = Array.isArray(o.repoUrls) && o.repoUrls.length ? o.repoUrls.slice()
    : (o.repoUrl || o.owner || o.repo ? [publicUrl] : PUBLIC_REPO_URLS);
  const git = o.git || defaultGit;
  const npm = o.npm || defaultNpm;
  const tools = o.tools || defaultTools;
  const doFetch = o.fetch || defaultFetch;
  const now = o.now || Date.now;
  const T = o.timers || { setTimeout, clearTimeout };
  const firstMs = o.firstCheckMs == null ? FIRST_CHECK_MS : o.firstCheckMs;
  const everyMs = o.everyMs || EVERY_MS;
  const allowNpm = o.allowNpm !== false;
  const installed = o.installed === true;
  const downloadUrl = String(o.downloadUrl || INSTALLER_URL);
  const logPath = path.join(dataDir, LOG_FILE);
  const statePath = path.join(dataDir, STATE_FILE);
  const stagingDir = path.join(appDir, STAGING_DIR);
  const off = String(o.off || '') || offReason(appDir);

  let saved = readJson(statePath) || {};
  if (typeof saved.check !== 'boolean') saved.check = true;
  let timer = null;
  let busy = false;        // a check or an update is running
  let checking = null;     // the running check's promise
  let relaunchMode = '';   // 'plain' | 'swap', once an update is ready to restart

  const st = {
    status: off ? 'off' : 'idle',
    off,
    enabled: saved.check,
    current: { version: pkgVersion(appDir), sha: '' },
    release: null,
    checkedAt: (saved.last && saved.last.at) || 0,
    nextAt: 0,
    error: '',
    rateLimited: false,
    canUpdate: false,
    blocked: '',
    manual: [],
    needsNpm: false,
    progress: null,
    failure: null,
    updated: null,
    snoozed: false,
    ahead: false,
    signature: null,   // { ok, state: 'verified'|'unpinned'|'refused', tag, text } for the release on offer
    installed,         // an installed copy (Quartz-Setup.exe): it updates by running the new installer
    download: '',      // installed copies only: the installer's link while a newer release is out
    logPath,
  };

  function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
  function persist() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = statePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(saved, null, 2));
      fs.renameSync(tmp, statePath);
    } catch (e) { log('Could not save ' + STATE_FILE + ': ' + e.message); }
  }
  function log(line) {
    const text = new Date(now()).toISOString() + ' ' + String(line).replace(/\r?\n/g, '\n    ') + '\n';
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      try { if (fs.statSync(logPath).size > LOG_MAX_BYTES) fs.renameSync(logPath, logPath + '.1'); } catch { /* none yet */ }
      fs.appendFileSync(logPath, text);
    } catch { /* the state still carries the reason */ }
    if (o.log) { try { o.log(String(line).split('\n')[0]); } catch { /* best effort */ } }
  }
  function snapshot() { return JSON.parse(JSON.stringify(st)); }
  function emit() { if (o.onState) { try { o.onState(snapshot()); } catch { /* a dead window */ } } }
  function set(patch) { Object.assign(st, patch); emit(); }

  async function g(args, extra) {
    const r = await git(args, Object.assign({ cwd: appDir }, extra));
    if (r.code !== 0) log('git ' + args.join(' ') + ' -> ' + r.code + ': ' + tail(r.stderr || r.stdout, 600));
    return r;
  }
  async function gitOut(args) { const r = await g(args); return r.code === 0 ? r.stdout.trim() : null; }

  /* -- the release ----------------------------------------------------------------------------- */

  /** { kind: 'release'|'none'|'error', release?, why?, retryAt? } */
  async function fetchRelease() {
    const url = apiBase + '/repos/' + owner + '/' + repo + '/releases/latest';
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Quartz-updater', 'X-GitHub-Api-Version': '2022-11-28' };
    if (saved.etag && saved.release) headers['If-None-Match'] = saved.etag;
    let res;
    try { res = await doFetch(url, { headers }); } catch (e) { return { kind: 'error', why: netWhy(e) }; }
    const h = (k) => { try { return res.headers.get(k); } catch { return null; } };
    if (res.status === 304 && saved.release) return { kind: 'release', release: saved.release };
    if (res.status === 404) { saved.etag = ''; saved.release = null; return { kind: 'none' }; }
    const left = h('x-ratelimit-remaining');
    if (res.status === 429 || (res.status === 403 && (left === '0' || h('retry-after')))) {
      const reset = Number(h('x-ratelimit-reset')) * 1000;
      const after = Number(h('retry-after')) * 1000;
      const retryAt = after > 0 ? now() + after : (reset > now() ? reset : now() + RETRY_MS);
      return { kind: 'error', rateLimited: true, retryAt, why: 'GitHub\'s limit for checks without signing in is used up for now; Quartz tries again at ' + clock(retryAt + 60000) };
    }
    if (!res.ok) return { kind: 'error', why: 'GitHub answered ' + res.status + (res.statusText ? ' ' + res.statusText : '') };
    let body;
    try { body = await res.json(); } catch (e) { return { kind: 'error', why: 'GitHub\'s answer was not readable: ' + e.message }; }
    const tag = body && typeof body.tag_name === 'string' ? body.tag_name.trim() : '';
    if (!/^[\w.+-]{1,64}$/.test(tag) || /^-|\.\.|\.lock$/.test(tag)) return { kind: 'error', why: 'the latest release has no usable tag name' };
    const release = {
      tag,
      name: String(body.name || tag).slice(0, 120),
      url: String(body.html_url || ('https://github.com/' + owner + '/' + repo + '/releases/tag/' + tag)),
      notes: String(body.body || '').slice(0, 2000),
      publishedAt: String(body.published_at || ''),
      branch: String(body.target_commitish || ''),
    };
    saved.etag = h('etag') || '';
    saved.release = release;
    return { kind: 'release', release };
  }

  /* -- where this folder stands against the release ---------------------------------------------- */

  async function originInfo() {
    const url = await gitOut(['remote', 'get-url', 'origin']);
    return { url: url || '', isPublic: !!url && isPublicRepo(url, publicUrls) };
  }

  async function defaultBranch(origin) {
    const sym = await gitOut(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (sym) return sym.replace(/^origin\//, '');
    if (origin.isPublic) {
      const r = await g(['ls-remote', '--symref', 'origin', 'HEAD'], { timeoutMs: 60000 });
      const m = /ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(r.stdout || '');
      if (m) return m[1];
    }
    return '';
  }

  /**
   * Fetch the tag and work out everything the card needs: available or not, and when it is,
   * whether the button is offered and if not exactly why. Never changes the work tree.
   */
  async function inspect(release) {
    const tag = release.tag;
    const r = { available: false, canUpdate: false, blocked: '', manual: [], needsNpm: false, sha: '', head: '', ahead: false, download: '' };
    if (installed) {
      // No history to compare: the version number decides, and the installer is the way to update.
      const cmp = compareVersions(tag, st.current.version);
      r.ahead = cmp < 0;
      if (cmp > 0) {
        r.available = true;
        r.blocked = 'this copy was installed with Quartz-Setup.exe, so it updates by running the new installer';
        r.download = downloadUrl;
      }
      return r;
    }
    const isClone = fs.existsSync(path.join(appDir, '.git'));
    if (!isClone) {
      // A folder from a zip: no history to compare, so the version number decides.
      if (compareVersions(tag, st.current.version) > 0) {
        r.available = true;
        r.blocked = 'this folder is not a git clone, so Quartz cannot update it in place';
        r.manual = ['git clone ' + publicUrl + ' quartz', 'cd quartz', 'npm ci', 'npm start'];
      }
      return r;
    }
    r.head = await gitOut(['rev-parse', 'HEAD']);
    if (!r.head) throw new Error('git could not read this folder\'s HEAD (see the log)');
    // The keys this copy trusts, read from the installed folder BEFORE anything is fetched.
    const signers = readInstalledSigners(appDir);
    const origin = await originInfo();
    const src = origin.isPublic ? 'origin' : publicUrl;
    const f = await g(['fetch', '--no-tags', '--quiet', src, 'refs/tags/' + tag + ':refs/tags/' + tag], { timeoutMs: 180000 });
    if (f.code !== 0) {
      const why = /would clobber|rejected/.test(f.stderr) ? 'a local tag named ' + tag + ' points somewhere else than the release'
        : /not found|couldn't find remote ref/i.test(f.stderr) ? 'the release tag ' + tag + ' is not in the repository'
        : /Could not resolve host|unable to access|Failed to connect/i.test(f.stderr) ? 'no internet (git could not reach GitHub)'
        : 'git could not fetch ' + tag + ': ' + tail(f.stderr, 160);
      throw new Error(why);
    }
    // The tag object as fetched, by sha: the signature check and the commit merged below both hang
    // off this one immutable name, never off a ref that could move in between.
    r.tagObject = await gitOut(['rev-parse', '--verify', '--quiet', 'refs/tags/' + tag]);
    if (!r.tagObject) throw new Error('the tag ' + tag + ' could not be read after the fetch');
    r.sha = await gitOut(['rev-parse', r.tagObject + '^{commit}']);
    if (!r.sha) throw new Error('the tag ' + tag + ' does not name a commit');
    const inHead = await g(['merge-base', '--is-ancestor', r.sha, 'HEAD']);
    if (inHead.code === 0) { r.ahead = r.sha !== r.head; return r; }   // at or ahead of the release: never prompted
    if (inHead.code !== 1) throw new Error('git could not compare HEAD with ' + tag);
    r.available = true;

    const why = [];
    const pre = [];
    r.signature = await checkSignature(tag, r.tagObject, r.sha, signers);
    if (!r.signature.ok) why.push(r.signature.why + ', so Quartz will not install it');
    if (!origin.isPublic) why.push(origin.url ? 'this folder\'s origin is ' + origin.url + ', not the public repo' : 'this folder has no origin remote');
    const shallow = await gitOut(['rev-parse', '--is-shallow-repository']);
    if (shallow === 'true') why.push('this is a shallow clone');
    const branch = await gitOut(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const def = await defaultBranch(origin);
    if (!branch) { why.push('it is not on a branch (detached HEAD)'); if (def) pre.push('git switch ' + def); }
    else if (!def) why.push('the default branch could not be worked out');
    else if (branch !== def) { why.push('it is on the branch "' + branch + '", not "' + def + '"'); pre.push('git switch ' + def); }
    const dirty = await g(['status', '--porcelain', '--untracked-files=no']);
    const n = dirty.code === 0 ? dirty.stdout.split(/\r?\n/).filter((l) => l.trim()).length : -1;
    if (n > 0) why.push(plural(n, 'file has', 'files have') + ' local changes (commit or stash them first)');
    else if (n < 0) why.push('git could not read the folder\'s status');
    const ff = await g(['merge-base', '--is-ancestor', 'HEAD', r.sha]);
    const diverged = ff.code !== 0 && !(branch && def && branch !== def);
    if (diverged) why.push('this folder has commits the release does not (it has diverged)');
    const changed = await gitOut(['diff', '--name-only', 'HEAD', r.sha, '--', 'package.json', 'package-lock.json']);
    if (changed) {
      const show = async (rev, file) => { const x = await g(['show', rev + ':' + file]); return x.code === 0 ? x.stdout : null; };
      r.needsNpm = depsChanged(await show('HEAD', 'package.json'), await show(r.sha, 'package.json'),
        await show('HEAD', 'package-lock.json'), await show(r.sha, 'package-lock.json'));
    }
    if (r.needsNpm && !why.length) {
      if (!allowNpm) why.push('test runs never run npm ci, and this release changes the dependencies');
      else {
        const missing = await tools();
        if (missing) why.push(missing + ', and this release changes the dependencies');
      }
    }
    r.canUpdate = why.length === 0;
    r.blocked = why.join('; ');
    // A refused signature gets no commands: copying them would install exactly what was refused.
    r.manual = !r.signature.ok ? [] : ['cd "' + appDir + '"'].concat(pre,
      ['git pull ' + (diverged ? '' : '--ff-only ') + (origin.isPublic ? 'origin' : publicUrl) + ' ' + tag],
      r.needsNpm ? ['npm ci'] : []);
    return r;
  }

  /**
   * verifyReleaseTag for this folder, logged: every outcome to updater.log, and to quartz.log
   * (o.record) whenever it differs from the last one said there, so a 6-hourly check of the same
   * refused release is one line, not one per check.
   */
  let lastRecorded = '';
  async function checkSignature(tag, tagObject, sha, signers) {
    let bringsKey = false;
    if (!signers.pinned && !signers.error) {
      const x = await git(['show', sha + ':' + SIGNERS_FILE], { cwd: appDir });
      bringsKey = x.code === 0 && parseSigners(x.stdout).lines.length > 0;
    }
    const v = await verifyReleaseTag({
      run: (args) => git(args, { cwd: appDir }), tag, tagObject, sha, signers, bringsKey,
      sshProgram: o.sshProgram, tmpDir: o.tmpDir,
    });
    log('Signature: ' + v.text);
    const said = 'Update signature: ' + v.text;
    if (said !== lastRecorded && o.record) { lastRecorded = said; try { o.record(said); } catch { /* best effort */ } }
    return v;
  }

  /* -- check ------------------------------------------------------------------------------------- */

  function schedule(ms) {
    if (timer) T.clearTimeout(timer);
    timer = null;
    if (st.off || !st.enabled) { set({ nextAt: 0 }); return; }
    const wait = Math.max(1000, Math.min(ms, everyMs));
    st.nextAt = now() + wait;
    timer = T.setTimeout(() => { timer = null; check({ auto: true }); }, wait);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function check(how) {
    if (checking) return checking;
    checking = (async () => {
      try { return await doCheck(how || {}); } finally { checking = null; }
    })();
    return checking;
  }

  async function doCheck(how) {
    if (st.off) return snapshot();
    if (busy || st.status === 'updating') return snapshot();
    if (how.auto && !st.enabled) return snapshot();
    busy = true;
    set({ status: 'checking' });
    let next = everyMs;
    try {
      const got = await fetchRelease();
      saved.last = { at: now() };
      if (got.kind === 'error') {
        log('Check failed: ' + got.why);
        next = got.rateLimited ? Math.max(60000, got.retryAt - now() + 60000) : RETRY_MS;
        set({ status: 'error', error: got.why, rateLimited: !!got.rateLimited, checkedAt: now() });
        return snapshot();
      }
      if (got.kind === 'none') {
        set({ status: 'none', release: null, error: '', rateLimited: false, canUpdate: false, blocked: '', manual: [], checkedAt: now() });
        return snapshot();
      }
      const rel = got.release;
      const r = await inspect(rel);
      const snoozed = !!(saved.snooze && saved.snooze.tag === rel.tag && saved.snooze.until > now());
      st.current.sha = short(r.head);
      set({
        status: r.available ? 'available' : 'current',
        release: rel, error: '', rateLimited: false, checkedAt: now(),
        canUpdate: r.canUpdate, blocked: r.blocked, manual: r.manual, needsNpm: r.needsNpm, snoozed,
        ahead: r.ahead,
        signature: r.signature || null,
        download: r.download || '',
        failure: r.available ? st.failure : null,
      });
      if (r.available) log('Release ' + rel.tag + ' is out. ' + (r.canUpdate ? 'Update offered.' : 'No button: ' + r.blocked));
      return snapshot();
    } catch (e) {
      const why = String((e && e.message) || e);
      log('Check failed: ' + why);
      next = RETRY_MS;
      set({ status: 'error', error: why, checkedAt: now() });
      return snapshot();
    } finally {
      busy = false;
      persist();
      schedule(next);
    }
  }

  /* -- update ------------------------------------------------------------------------------------ */

  function progress(stage, text) { log('Update: ' + text); set({ status: 'updating', progress: { stage, text } }); }

  /** Export the release's tree into staging (git's own index untouched) and npm ci there. */
  async function stageDependencies(sha) {
    removeTree(stagingDir);
    const tree = path.join(stagingDir, 'tree');
    fs.mkdirSync(tree, { recursive: true });
    const index = path.join(stagingDir, 'index');
    const env = { GIT_INDEX_FILE: index };
    let r = await g(['read-tree', sha], { env });
    if (r.code === 0) r = await g(['checkout-index', '-a', '-f', '--prefix=' + tree.replace(/\\/g, '/') + '/'], { env });
    if (r.code !== 0) throw new Error('the release could not be unpacked for npm ci: ' + tail(r.stderr, 160));
    log('npm ci in ' + tree);
    const n = await npm(['ci', '--no-audit', '--no-fund'], { cwd: tree, timeoutMs: 30 * 60 * 1000, onLine: (l) => log('  npm: ' + l) });
    if (n.code !== 0) {
      const last = tail(n.stderr || n.stdout, 200).split(/\r?\n/).filter(Boolean).pop() || 'no reason given';
      throw new Error('npm ci failed (' + last + ')');
    }
    if (!fs.existsSync(path.join(tree, 'node_modules'))) throw new Error('npm ci finished but made no node_modules');
  }

  /**
   * Is `rel` still GitHub's latest release? The card can be up to 6 h old, and a release that was
   * pulled since (put back to draft or pre-release, or replaced by a newer one) must never be
   * installed from it. Resolves { ok } or { ok: false, gone, why }:
   *   gone true   the feed answered and names another release, or none: the cached offer is void;
   *   gone false  the feed could not be read (offline, rate-limited, a 5xx): nothing proves the
   *               release is still wanted, so the update is refused too, and tried again later.
   * Refusing on an unreadable feed costs little: the update itself needs GitHub (git fetches the
   * tag), and the only alternative is installing a release we could not re-confirm.
   */
  async function stillLatest(rel) {
    const got = await fetchRelease();
    persist();
    if (got.kind === 'release' && got.release.tag === rel.tag) return { ok: true };
    if (got.kind === 'release') return { ok: false, gone: true, latest: got.release.tag, why: rel.tag + ' is no longer the latest release (GitHub now offers ' + got.release.tag + '), so Quartz did not install it' };
    if (got.kind === 'none') return { ok: false, gone: true, latest: '', why: rel.tag + ' is no longer published (GitHub lists no latest release now), so Quartz did not install it' };
    return { ok: false, gone: false, rateLimited: !!got.rateLimited, retryAt: got.retryAt, why: 'Quartz could not confirm that ' + rel.tag + ' is still the latest release (' + got.why + '), so it did not install it; it checks again later' };
  }

  /** stillLatest, or throw the refusal (marked so update()'s catch can clear a void offer). */
  async function confirmLatest(rel) {
    const v = await stillLatest(rel);
    if (v.ok) return;
    log('Release re-check: ' + v.why);
    if (o.record) { try { o.record('Update refused: ' + v.why); } catch { /* best effort */ } }
    const e = new Error(v.why);
    e.recheck = v;
    throw e;
  }

  /**
   * Update to the release. Resolves { ok, relaunch: 'plain'|'swap' } or { ok: false, reason }.
   * On ok the caller restarts Quartz (relaunch()/swapPlan()); nothing else is left to do.
   * Before anything is downloaded, and again after a staged npm ci (which can take minutes),
   * the releases feed is read again: a release that is no longer the latest is refused.
   */
  async function update() {
    if (st.off) return { ok: false, reason: 'updates are off: ' + st.off };
    if (installed) return { ok: false, reason: 'an installed copy updates by running the new installer (Download the installer)' };
    if (busy) return { ok: false, reason: 'a check or an update is already running' };
    if (st.status === 'updating') return { ok: false, reason: 'an update is already running' };
    if (!st.release || !(st.status === 'available' || st.status === 'failed')) return { ok: false, reason: 'there is no update to install' };
    busy = true;
    const rel = st.release;
    let old = '';
    let mergeTried = false;
    let staged = false;
    try {
      progress('downloading', 'Checking that ' + rel.tag + ' is still the latest release…');
      await confirmLatest(rel);
      progress('downloading', 'Downloading ' + rel.tag + '…');
      const r = await inspect(rel);
      st.current.sha = short(r.head);
      if (!r.available) throw new Error('this folder already has ' + rel.tag);
      st.signature = r.signature || null;
      if (!r.canUpdate) {
        set({ canUpdate: false, blocked: r.blocked, manual: r.manual });
        throw new Error(r.blocked);
      }
      old = r.head;
      if (r.needsNpm) {
        progress('installing', NPM_TEXT);
        staged = true;
        await stageDependencies(r.sha);
        // npm ci can take minutes: the release may have been pulled meanwhile.
        await confirmLatest(rel);
        // The folder itself moves only once Quartz has quit: the swap helper merges, then swaps
        // node_modules. Until then nothing in the app folder has changed.
        relaunchMode = 'swap';
        saved.pending = { from: old, to: r.sha, tag: rel.tag, tagObject: r.tagObject, mode: 'swap', at: now() };
        saved.snooze = null;
        persist();
        progress('restarting', 'Restarting: Quartz closes, moves to ' + rel.tag + ' with its new dependencies and opens again with your tabs.');
        log('Staged ' + rel.tag + ' (' + short(r.sha) + ') with new dependencies; the swap helper finishes it after the quit.');
        return { ok: true, relaunch: 'swap' };
      }
      progress('installing', 'Moving this folder to ' + rel.tag + '…');
      mergeTried = true;
      const m = await g(['merge', '--ff-only', r.sha]);
      if (m.code !== 0) throw new Error('git merge --ff-only failed: ' + (tail(m.stderr || m.stdout, 200).split(/\r?\n/).filter(Boolean)[0] || 'no reason given'));
      const now2 = await gitOut(['rev-parse', 'HEAD']);
      if (now2 !== r.sha) throw new Error('after the merge HEAD is ' + short(now2) + ', not ' + short(r.sha));
      relaunchMode = 'plain';
      saved.pending = { from: old, to: r.sha, tag: rel.tag, mode: 'plain', at: now() };
      saved.snooze = null;
      persist();
      progress('restarting', 'Restarting Quartz with your tabs…');
      log('Updated the folder from ' + short(old) + ' to ' + rel.tag + ' (' + short(r.sha) + ').');
      return { ok: true, relaunch: 'plain' };
    } catch (e) {
      const reason = String((e && e.message) || e);
      const notes = await rollback(old, mergeTried, staged);
      const full = reason + (notes ? '. ' + notes : '');
      log('Update failed: ' + full);
      if (o.record) { try { o.record('Update to ' + rel.tag + ' failed: ' + full); } catch { /* best effort */ } }
      const rc = e && e.recheck;
      if (rc && rc.gone) {
        // The offer is void: no release, no button, no "Try again". The next check (soon) shows
        // whatever GitHub offers now, a replacement included.
        relaunchMode = '';
        saved.pending = null;
        persist();
        set({ status: 'failed', progress: null, release: null, canUpdate: false, blocked: '', manual: [], needsNpm: false,
          signature: null, download: '', failure: { reason: full, log: logPath, at: now(), withdrawn: true, latest: rc.latest } });
        schedule(firstMs);
      } else {
        if (rc) { relaunchMode = ''; saved.pending = null; persist(); }
        set({ status: 'failed', progress: null, failure: { reason: full, log: logPath, at: now() } });
        if (rc) schedule(rc.rateLimited && rc.retryAt ? Math.max(60000, rc.retryAt - now() + 60000) : RETRY_MS);
      }
      return { ok: false, reason: full };
    } finally {
      busy = false;
    }
  }

  /** Back to the old commit; a staged node_modules is thrown away. Returns a sentence when it could not. */
  async function rollback(old, mergeTried, staged) {
    const said = [];
    if (old && mergeTried) {
      const head = await gitOut(['rev-parse', 'HEAD']);
      if (head !== old) {
        const r = await g(['reset', '--keep', old]);
        if (r.code !== 0) said.push('Going back to ' + short(old) + ' failed too: run "git reset --keep ' + old + '" in the app folder');
        else log('Rolled back to ' + short(old));
      }
    }
    if (staged) { try { removeTree(stagingDir); } catch (e) { said.push('The staging folder ' + STAGING_DIR + ' could not be removed: ' + e.message); } }
    if (!said.length) said.push('Quartz stayed on the version it had');
    return said.join('. ');
  }

  /**
   * The swap helper's plan, written once the folder is on the new commit and its node_modules is
   * staged. Returns { node, script, plan } for the caller to spawn just before it quits.
   */
  function swapPlan(relaunch) {
    const helper = path.join(dataDir, HELPER_FILE);
    fs.mkdirSync(dataDir, { recursive: true });
    if (SELF_SOURCE) fs.writeFileSync(helper, SELF_SOURCE); else fs.copyFileSync(__filename, helper);
    const plan = Object.assign({
      appDir, stagingDir, from: saved.pending && saved.pending.from, to: saved.pending && saved.pending.to,
      tag: saved.pending && saved.pending.tag, tagObject: saved.pending && saved.pending.tagObject,
      log: logPath, result: path.join(dataDir, RESULT_FILE),
    }, relaunch);   // { pid, exe, args, cwd }
    const planPath = path.join(dataDir, PLAN_FILE);
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    try { fs.unlinkSync(plan.result); } catch { /* none */ }
    return { script: helper, planPath };
  }

  /**
   * The swap helper could not be started (no node on PATH, say): nothing in the app folder has
   * changed yet, so drop the staged copy and stay on the old version, saying why.
   */
  function abandonSwap(reason) {
    saved.pending = null;
    persist();
    relaunchMode = '';
    let note = 'Quartz stayed on the version it had';
    try { removeTree(stagingDir); } catch (e) { note += '; the staging folder ' + STAGING_DIR + ' could not be removed: ' + e.message; }
    const full = reason + '. ' + note;
    log('Update failed: ' + full);
    set({ status: 'failed', progress: null, failure: { reason: full, log: logPath, at: now() } });
    return snapshot();
  }

  /* -- the rest of the surface ------------------------------------------------------------------- */

  /** At start: did the last run update this folder, and did it land? */
  async function settle() {
    const p = saved.pending;
    if (!p || st.off) return;
    saved.pending = null;
    const head = fs.existsSync(path.join(appDir, '.git')) ? await gitOut(['rev-parse', 'HEAD']) : '';
    const result = p.mode === 'swap' ? readJson(path.join(dataDir, RESULT_FILE)) : { ok: true };
    if (head === p.to && result && result.ok) {
      st.current.sha = short(head);
      set({ status: 'updated', updated: { from: short(p.from), to: short(p.to), tag: p.tag } });
      log('Quartz is now on ' + p.tag + ' (' + short(p.to) + ').');
    } else {
      const reason = (result && !result.ok && result.reason) ? result.reason
        : head === p.from ? 'the update to ' + p.tag + ' did not finish'
          : 'after the restart this folder is on ' + (short(head) || 'an unknown commit') + ', not ' + p.tag;
      set({ status: 'failed', failure: { reason: reason + '. Quartz is on the version it had', log: logPath, at: now() } });
      log('The update to ' + p.tag + ' did not land: ' + reason);
      if (o.record) { try { o.record('The update to ' + p.tag + ' did not land: ' + reason); } catch { /* best effort */ } }
    }
    persist();
  }

  function start() {
    if (st.off) { log('Updates are off: ' + st.off); emit(); return snapshot(); }
    (async () => {
      if (fs.existsSync(path.join(appDir, '.git'))) st.current.sha = short(await gitOut(['rev-parse', 'HEAD']));
      await settle();
    })().catch((e) => log('Could not read the last update: ' + e.message)).then(() => {
      if (st.enabled) schedule(firstMs); else set({ nextAt: 0 });
    });
    return snapshot();
  }

  function stop() { if (timer) T.clearTimeout(timer); timer = null; }

  function setEnabled(on) {
    saved.check = !!on;
    persist();
    st.enabled = saved.check;
    if (st.enabled) schedule(firstMs); else { stop(); set({ nextAt: 0 }); }
    return snapshot();
  }

  function later() {
    if (st.release) {
      saved.snooze = { tag: st.release.tag, until: now() + SNOOZE_MS };
      persist();
    }
    set({ snoozed: true, updated: null, failure: st.status === 'failed' ? st.failure : null });
    return snapshot();
  }

  return {
    start, stop, check, update, later, setEnabled, swapPlan, abandonSwap,
    state: snapshot,
    relaunchMode: () => relaunchMode,
    paths: { logPath, statePath, stagingDir },
  };
}

function pkgVersion(appDir) {
  try { return String(JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version || ''); } catch { return ''; }
}

/* ---- the swap helper (runs as `node update-swap.js <plan.json>` once Quartz has quit) ------- */

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/**
 * Wait for Quartz to exit, swap the staged node_modules in, start Quartz again. Any failure puts
 * the old node_modules back, resets the folder to the old commit, and starts the old Quartz;
 * the result file tells the next start what happened.
 */
async function runSwap(plan, deps) {
  const d = Object.assign({ git: defaultGit, spawn, alive, waitMs: 60000, renameMs: 30000 }, deps);
  const say = (l) => { try { fs.appendFileSync(plan.log, new Date().toISOString() + ' swap: ' + l + '\n'); } catch { /* none */ } };
  const write = (r) => { try { fs.writeFileSync(plan.result, JSON.stringify(Object.assign({ at: Date.now() }, r))); } catch (e) { say('could not write the result: ' + e.message); } };
  const nm = path.join(plan.appDir, 'node_modules');
  const staged = path.join(plan.stagingDir, 'tree', 'node_modules');
  const old = path.join(plan.stagingDir, 'old-node_modules');
  const relaunch = () => {
    if (!plan.exe) return;
    try {
      const c = d.spawn(plan.exe, plan.args || [], { cwd: plan.cwd || plan.appDir, detached: true, stdio: 'ignore' });
      if (c && c.unref) c.unref();
      say('started ' + path.basename(plan.exe));
    } catch (e) { say('could not start Quartz again: ' + e.message); }
  };
  async function rename(a, b) {
    const t0 = Date.now();
    for (;;) {
      try { fs.renameSync(a, b); return; } catch (e) {
        if (!/EPERM|EBUSY|EACCES/.test(e.code) || Date.now() - t0 > d.renameMs) throw e;
        await sleepMs(500);
      }
    }
  }
  const tidy = () => { try { removeTree(plan.stagingDir); } catch (e) { say('could not tidy ' + plan.stagingDir + ': ' + e.message); } };
  say('waiting for Quartz (pid ' + plan.pid + ') to exit');
  const t0 = Date.now();
  while (plan.pid && d.alive(plan.pid)) {
    if (Date.now() - t0 > d.waitMs) {
      // Quartz never closed: nothing has been touched yet, so it simply stays on the old version.
      say('Quartz did not exit within ' + Math.round(d.waitMs / 1000) + ' s; nothing changed');
      write({ ok: false, reason: 'Quartz did not close within ' + Math.round(d.waitMs / 1000) + ' s, so the update was not applied' });
      tidy();
      return false;
    }
    await sleepMs(250);
  }
  // Quartz is gone. Before the folder moves, the tag is checked once more against the keys of the
  // copy that is STILL installed (nothing is merged yet), and must still name plan.to: a plan file
  // edited to point at another commit is refused here. No key yet = said, and the merge goes on.
  const sig = await verifyReleaseTag({
    run: (args) => d.git(args, { cwd: plan.appDir }), tag: plan.tag, tagObject: plan.tagObject, sha: plan.to,
    signers: readInstalledSigners(plan.appDir), sshProgram: d.sshProgram,
  });
  say('signature: ' + sig.text);
  if (!sig.ok) {
    write({ ok: false, reason: sig.why + ', so Quartz did not install it' });
    tidy();
    relaunch();
    return false;
  }
  // Now the folder can move (merge), then node_modules (swap).
  const m = await d.git(['merge', '--ff-only', plan.to], { cwd: plan.appDir });
  if (m.code !== 0) {
    const reason = 'git merge --ff-only failed: ' + (tail(m.stderr || m.stdout, 200).split(/\r?\n/).filter(Boolean)[0] || 'no reason given');
    say(reason);
    const r = await d.git(['reset', '--keep', plan.from], { cwd: plan.appDir });
    say('reset to ' + short(plan.from) + ' -> ' + r.code);
    write({ ok: false, reason });
    tidy();
    relaunch();
    return false;
  }
  let moved = false;
  try {
    if (!fs.existsSync(staged)) throw new Error('the staged node_modules is missing');
    if (fs.existsSync(old)) removeTree(old);
    if (fs.existsSync(nm)) { await rename(nm, old); moved = true; }
    await rename(staged, nm);
    say('swapped node_modules for ' + plan.tag);
    write({ ok: true, from: plan.from, to: plan.to, tag: plan.tag });
    relaunch();
    tidy();   // the old node_modules goes with it, after Quartz is already starting
    return true;
  } catch (e) {
    const reason = 'the new dependencies could not be swapped in: ' + e.message;
    say(reason);
    if (moved && !fs.existsSync(nm)) { try { await rename(old, nm); say('put the old node_modules back'); } catch (e2) { say('could not put the old node_modules back: ' + e2.message); } }
    const r = await d.git(['reset', '--keep', plan.from], { cwd: plan.appDir });
    say('reset to ' + short(plan.from) + ' -> ' + r.code + ' ' + tail(r.stderr, 200));
    write({ ok: false, reason });
    if (fs.existsSync(nm)) tidy();
    relaunch();
    return false;
  }
}

module.exports = {
  createUpdater, runSwap, offReason, normaliseRepoUrl, isPublicRepo, PUBLIC_REPO_URLS, compareVersions, netWhy, removeTree, depsChanged,
  verifyReleaseTag, readInstalledSigners, parseSigners, parseGitVersion, signatureWhy,
  OPT_OUT_FILE, STAGING_DIR, NPM_TEXT, INSTALLER_URL, EVERY_MS, FIRST_CHECK_MS, RETRY_MS, SIGNERS_FILE, MIN_GIT_SSH,
};

if (require.main === module && process.argv[2]) {
  let plan;
  try { plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch (e) { console.error('update-swap: no plan: ' + e.message); process.exit(2); }
  runSwap(plan).then((ok) => process.exit(ok ? 0 : 1), (e) => { console.error(e); process.exit(1); });
}
