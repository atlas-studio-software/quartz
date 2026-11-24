'use strict';
/*
 * updater-test.js -- updater.js against throwaway git repos in %TEMP%: a local bare "origin" with
 * tags, a clone of it as the app folder, and a fake GitHub releases API through the injectable
 * fetch. No network, no real npm (a fake that writes node_modules), no Electron.
 *
 *   node tests/updater-test.js        -> "updater-test: N passed, M failed"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const U = require('../updater');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log('PASS ' + label); }
  else { fail++; console.log('FAIL ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 400))); }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'quartz-updater-test-'));
// Every git here, the updater's included, sees the files byte for byte (no CRLF conversion).
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });
const GITC = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=master'];
function git(cwd, ...args) { return execFileSync('git', GITC.concat(args), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function write(dir, rel, text) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
const PKG = (v, dep) => JSON.stringify({ name: 'browser', version: v, dependencies: dep ? { x: dep } : {} }, null, 2) + '\n';

let n = 0;
/** A fresh world: origin.git (bare), pub (a clone the "maintainer" releases from), app (the user's clone). */
function world() {
  const dir = path.join(ROOT, 'w' + (++n));
  const seed = path.join(dir, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'master');
  write(seed, 'package.json', PKG('0.1.0'));
  write(seed, 'package-lock.json', '{"lockfileVersion":3}\n');
  write(seed, 'main.js', '// one\n');
  write(seed, 'a.txt', 'a\n'); write(seed, 'b.txt', 'b\n'); write(seed, 'c.txt', 'c\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'one'); git(seed, 'tag', 'v0.1.0');
  const origin = path.join(dir, 'origin.git');
  git(dir, 'clone', '-q', '--bare', seed, origin);
  const pub = path.join(dir, 'pub');
  git(dir, 'clone', '-q', origin, pub);
  const app = path.join(dir, 'app');
  git(dir, 'clone', '-q', origin, app);
  const data = path.join(dir, 'profile');
  return {
    dir, origin, pub, app, data,
    /** Commit files in pub, tag, push. Returns the tag's sha. */
    release(tag, files) {
      for (const [k, v] of Object.entries(files || { 'main.js': '// ' + tag + '\n' })) write(pub, k, v);
      git(pub, 'add', '-A'); git(pub, 'commit', '-q', '-m', 'release ' + tag); git(pub, 'tag', tag);
      git(pub, 'push', '-q', 'origin', 'master', tag);
      return git(pub, 'rev-parse', 'HEAD');
    },
  };
}

/** A fake GitHub: api.status / api.body / api.headers drive the next answer; calls are recorded. */
function fakeApi() {
  const api = { status: 200, body: null, headers: {}, calls: [], throws: null };
  api.fetch = async (url, init) => {
    api.calls.push({ url, headers: (init && init.headers) || {} });
    if (api.throws) throw api.throws;
    const hs = Object.assign({}, api.headers);
    if (api.status === 200 && api.body && init && init.headers && init.headers['If-None-Match'] === hs.etag) {
      return { status: 304, ok: false, headers: { get: (k) => hs[k.toLowerCase()] || null }, json: async () => ({}) };
    }
    return { status: api.status, ok: api.status >= 200 && api.status < 300, statusText: '', headers: { get: (k) => hs[k.toLowerCase()] || null }, json: async () => api.body };
  };
  api.releaseOf = (tag) => { api.status = 200; api.body = { tag_name: tag, name: 'Quartz ' + tag, html_url: 'https://example.invalid/' + tag, body: 'notes' }; api.headers = { etag: '"e-' + tag + '"' }; };
  return api;
}

const timers = () => { const t = { scheduled: [], setTimeout: (fn, ms) => { t.scheduled.push(ms); return { unref() {} }; }, clearTimeout() {} }; return t; };

function make(w, api, extra) {
  const states = [];
  const t = timers();
  const u = U.createUpdater(Object.assign({
    appDir: w.app, dataDir: w.data, repoUrl: w.origin, fetch: api.fetch, timers: t, firstCheckMs: 1000,
    tools: async () => '', onState: (s) => states.push(s),
  }, extra || {}));
  u.states = states; u.timers = t;
  return u;
}

async function main() {
  // ---- pure helpers -----------------------------------------------------------------------------
  const nr = U.normaliseRepoUrl;
  check(['https://github.com/atlas-studio-software/quartz.git', 'https://github.com/Atlas-Studio-Software/quartz', 'git@github.com:atlas-studio-software/quartz.git',
    'ssh://git@github.com/atlas-studio-software/quartz.git', 'https://github.com/atlas-studio-software/quartz/'].every((u) => nr(u) === 'github.com/atlas-studio-software/quartz'),
  'normaliseRepoUrl: https, ssh and scp forms of the public repo are one repo');
  check(nr('https://github.com/someone/quartz.git') !== nr('https://github.com/atlas-studio-software/quartz.git'), 'normaliseRepoUrl: a fork is not the public repo');

  // The repo moved to the organisation. Clones made before the move keep their old origin, which
  // GitHub redirects, so BOTH count as the public repo; nobody else's does.
  const pub = U.isPublicRepo;
  check(U.PUBLIC_REPO_URLS[0] === 'https://github.com/atlas-studio-software/quartz.git', 'public repo: the organisation\'s URL comes first (the fetch and the hand commands use it)', U.PUBLIC_REPO_URLS);
  check(U.PUBLIC_REPO_URLS.length === 2, 'public repo: exactly the organisation and the pre-move URL', U.PUBLIC_REPO_URLS);
  check(['https://github.com/atlas-studio-software/quartz.git', 'git@github.com:atlas-studio-software/quartz.git', 'https://github.com/atlas-studio-software/quartz'].every((u) => pub(u)),
    'public repo: an organisation-origin clone counts');
  check(['https://github.com/Owen-Silva/quartz.git', 'https://github.com/owen-silva/quartz', 'git@github.com:Owen-Silva/quartz.git', 'ssh://git@github.com/Owen-Silva/quartz.git'].every((u) => pub(u)),
    'public repo: a clone made before the move (old origin) still counts');
  check(!pub('https://github.com/someone/quartz.git') && !pub('https://github.com/atlas-studio-software/quartz-fork.git') && !pub('https://github.com/owen-silva/quartz-evil')
    && !pub('https://gitlab.com/atlas-studio-software/quartz.git') && !pub('') && !pub(null), 'public repo: a third owner, a lookalike name, another host or no origin does not');
  check(U.compareVersions('v0.2.0', '0.1.9') === 1 && U.compareVersions('v0.1.0', '0.1.0') === 0 && U.compareVersions('0.1.10', '0.1.9') === 1, 'compareVersions');
  check(/no internet/.test(U.netWhy(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }))), 'netWhy: ENOTFOUND reads as no internet');

  // ---- no release ---------------------------------------------------------------------------------
  {
    const w = world(); const api = fakeApi(); api.status = 404;
    const u = make(w, api);
    const s = await u.check();
    check(s.status === 'none' && !s.canUpdate, 'no release published: status none, no button', s.status);
    check(api.calls[0] && /\/repos\/atlas-studio-software\/quartz\/releases\/latest$/.test(api.calls[0].url), 'asks /repos/{owner}/{repo}/releases/latest, the organisation by default', api.calls[0] && api.calls[0].url);
    check(u.timers.scheduled.pop() === U.EVERY_MS, 'next check in 6 h');
  }

  // ---- up to date, ahead, available, ETag -------------------------------------------------------
  {
    const w = world(); const api = fakeApi(); api.releaseOf('v0.1.0');
    let s = await make(w, api).check();
    check(s.status === 'current' && !s.ahead, 'up to date: the release tag is HEAD -> current, no prompt', s);

    write(w.app, 'mine.txt', 'x\n'); git(w.app, 'add', '-A'); git(w.app, 'commit', '-q', '-m', 'local');
    s = await make(w, api).check();
    check(s.status === 'current' && s.ahead === true, 'ahead of the release: current (never prompted)', s.status);
  }
  {
    const w = world(); const api = fakeApi();
    const sha = w.release('v0.2.0'); api.releaseOf('v0.2.0');
    const u = make(w, api);
    let s = await u.check();
    check(s.status === 'available' && s.canUpdate && !s.needsNpm && s.release.tag === 'v0.2.0', 'update available: button offered, no npm ci needed', s);
    check(git(w.app, 'rev-parse', 'v0.2.0^{commit}') === sha && git(w.app, 'rev-parse', 'HEAD') !== sha, 'the check fetched the tag and left HEAD alone');
    s = await u.check();
    check(api.calls[1].headers['If-None-Match'] === '"e-v0.2.0"' && s.status === 'available', 'second check sends If-None-Match and a 304 keeps the release', api.calls[1].headers);
  }

  // ---- why there is no button ---------------------------------------------------------------------
  {
    const w = world(); const api = fakeApi(); w.release('v0.2.0'); api.releaseOf('v0.2.0');
    write(w.app, 'a.txt', 'changed\n');
    let s = await make(w, api).check();
    check(s.status === 'available' && !s.canUpdate && /^1 file has local changes/.test(s.blocked), 'dirty (1 file): no button, says "1 file has local changes"', s.blocked);
    write(w.app, 'b.txt', 'changed\n'); write(w.app, 'c.txt', 'changed\n');
    s = await make(w, api).check();
    check(/^3 files have local changes/.test(s.blocked), 'dirty (3 files): "3 files have local changes"', s.blocked);
    check(s.manual.some((l) => /git pull --ff-only origin v0\.2\.0/.test(l)), 'the manual command is shown', s.manual);
    write(w.app, 'untracked.txt', 'x\n');
    git(w.app, 'checkout', '-q', '--', '.');
    s = await make(w, api).check();
    check(s.canUpdate, 'an untracked file alone does not block the button', s.blocked);
  }
  {
    const w = world(); const api = fakeApi(); w.release('v0.2.0'); api.releaseOf('v0.2.0');
    git(w.app, 'switch', '-q', '-c', 'topic');
    const s = await make(w, api).check();
    check(s.status === 'available' && !s.canUpdate && /on the branch "topic", not "master"/.test(s.blocked) && s.manual.includes('git switch master'),
      'off the default branch: no button, says which branch, manual starts with git switch', s);
  }
  {
    const w = world(); const api = fakeApi(); w.release('v0.2.0'); api.releaseOf('v0.2.0');
    write(w.app, 'mine.txt', 'x\n'); git(w.app, 'add', '-A'); git(w.app, 'commit', '-q', '-m', 'local');
    const s = await make(w, api).check();
    check(s.status === 'available' && !s.canUpdate && /diverged/.test(s.blocked) && s.manual.some((l) => /^git pull origin v0\.2\.0$/.test(l)),
      'diverged: no button, says it has diverged, manual is a plain pull', s);
  }
  {
    const w = world(); const api = fakeApi(); w.release('v0.2.0'); api.releaseOf('v0.2.0');
    git(w.app, 'remote', 'set-url', 'origin', 'https://example.invalid/someone/quartz.git');
    const s = await make(w, api).check();
    check(s.status === 'available' && !s.canUpdate && /origin is https:\/\/example\.invalid\/someone\/quartz\.git, not the public repo/.test(s.blocked),
      'origin is not the public repo: still sees the release (fetched from the public URL), no button', s.blocked);
  }
  {
    // Two URLs for one public repo (the move): a clone whose origin is the OTHER one is offered the
    // button and fetches from its own origin; a third repo is still refused.
    const w = world(); const api = fakeApi(); w.release('v0.2.0'); api.releaseOf('v0.2.0');
    const moved = path.join(w.dir, 'moved.git');
    git(w.dir, 'clone', '-q', '--bare', w.origin, moved);
    git(w.app, 'remote', 'set-url', 'origin', moved);
    const s = await make(w, api, { repoUrls: [w.origin, moved] }).check();
    check(s.status === 'available' && s.canUpdate && !/not the public repo/.test(s.blocked), 'two public URLs: a clone on the second one gets the button', s.blocked || s.status);
    const w2 = world(); const api2 = fakeApi(); w2.release('v0.2.0'); api2.releaseOf('v0.2.0');
    const other = path.join(w2.dir, 'other.git');
    git(w2.dir, 'clone', '-q', '--bare', w2.origin, other);
    git(w2.app, 'remote', 'set-url', 'origin', other);
    const s2 = await make(w2, api2, { repoUrls: [w2.origin, path.join(w2.dir, 'moved.git')] }).check();
    check(s2.status === 'available' && !s2.canUpdate && /not the public repo/.test(s2.blocked), 'two public URLs: a third repo still gets no button', s2.blocked);
  }
  {
    const w = world(); const api = fakeApi(); w.release('v0.2.0'); api.releaseOf('v0.2.0');
    const wt = path.join(w.dir, 'wt');
    git(w.app, 'worktree', 'add', '-q', wt);
    const u = make(w, api, { appDir: wt });
    const s = await u.check();
    check(s.status === 'off' && /linked git worktree/.test(s.off) && api.calls.length === 0 && u.timers.scheduled.length === 0,
      'linked worktree: off, never fetches, never schedules', { s: s.status, off: s.off, calls: api.calls.length });
    u.start();
    check(api.calls.length === 0 && u.timers.scheduled.length === 0, 'linked worktree: start() schedules nothing');
  }
  {
    const w = world(); const api = fakeApi(); w.release('v0.2.0'); api.releaseOf('v0.2.0');
    write(w.app, U.OPT_OUT_FILE, '{ "updates": "off" }\n');
    const u = make(w, api);
    u.start();
    const s = await u.check({ manual: true });
    check(s.status === 'off' && s.off.indexOf(U.OPT_OUT_FILE) >= 0 && api.calls.length === 0 && u.timers.scheduled.length === 0,
      'opt-out file: off (even a manual check), says which file, never fetches or schedules', s.off);
    let ignored = false;
    try { ignored = execFileSync('git', ['check-ignore', '--no-index', U.OPT_OUT_FILE, U.STAGING_DIR + '/x'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim().split(/\r?\n/).length === 2; } catch { /* not ignored */ }
    check(ignored, 'this repo\'s .gitignore ignores ' + U.OPT_OUT_FILE + ' and ' + U.STAGING_DIR + '/');
  }
  {
    const w = world(); const api = fakeApi(); w.release('v0.2.0'); api.releaseOf('v0.2.0');
    const u = make(w, api, { off: 'a test profile never checks for updates' });
    const s = await u.check();
    check(s.status === 'off' && api.calls.length === 0, 'test profile (off passed in): never fetches', s.off);
  }
  {
    const w = world(); const api = fakeApi(); api.releaseOf('v0.2.0');
    const zip = path.join(w.dir, 'zip');
    fs.mkdirSync(zip); fs.copyFileSync(path.join(w.app, 'package.json'), path.join(zip, 'package.json'));
    const s = await make(w, api, { appDir: zip }).check();
    check(s.status === 'available' && !s.canUpdate && /not a git clone/.test(s.blocked) && /^git clone /.test(s.manual[0]),
      'not a git clone (a zip): newer version seen, no button, says why and how', s.blocked);
  }

  // ---- check failures -------------------------------------------------------------------------------
  {
    const w = world(); const api = fakeApi();
    api.throws = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const u = make(w, api);
    const s = await u.check();
    check(s.status === 'error' && /^no internet/.test(s.error), 'network error: status error, "no internet"', s.error);
    check(u.timers.scheduled.pop() === 30 * 60 * 1000, 'network error: retries in 30 min');
  }
  {
    const w = world(); const api = fakeApi();
    const reset = Math.floor(Date.now() / 1000) + 1800;
    api.status = 403; api.body = { message: 'API rate limit exceeded' }; api.headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) };
    const u = make(w, api);
    const s = await u.check();
    const next = u.timers.scheduled.pop();
    check(s.status === 'error' && s.rateLimited && /limit/.test(s.error) && /tries again at \d\d:\d\d/.test(s.error), 'rate-limited: says so, and when it tries again', s.error);
    check(next > 25 * 60 * 1000 && next < 33 * 60 * 1000, 'rate-limited: next check waits for GitHub\'s reset', next);
    api.status = 429; api.headers = { 'retry-after': '120' };
    const s2 = await make(w, api).check();
    check(s2.status === 'error' && s2.rateLimited, '429 with Retry-After: rate-limited', s2.error);
    api.status = 500; api.headers = {};
    const s3 = await make(w, api).check();
    check(s3.status === 'error' && /GitHub answered 500/.test(s3.error), 'a 500: says what GitHub answered', s3.error);
  }

  // ---- update: the plain path ---------------------------------------------------------------------
  {
    const w = world(); const api = fakeApi(); const sha = w.release('v0.2.0'); api.releaseOf('v0.2.0');
    const u = make(w, api);
    await u.check();
    const r = await u.update();
    const stages = u.states.filter((s) => s.progress).map((s) => s.progress.stage);
    check(r.ok && r.relaunch === 'plain', 'update: ok, a plain restart (no package change)', r);
    check(git(w.app, 'rev-parse', 'HEAD') === sha && git(w.app, 'status', '--porcelain') === '', 'update: HEAD is the release, tree clean');
    check(stages[0] === 'downloading' && stages.includes('installing') && stages[stages.length - 1] === 'restarting', 'update: progress downloading -> installing -> restarting', stages);
    const after = make(w, api); after.start();
    await new Promise((res) => setTimeout(res, 300));
    check(after.state().status === 'updated' && after.state().updated.tag === 'v0.2.0', 'next start: "updated to v0.2.0"', after.state());
    const s = await after.check();
    check(s.status === 'current', 'next start: the check finds it current');
  }

  // ---- update: the release is re-checked before anything is installed ------------------------------
  {
    // Still latest (an unchanged feed answers 304): installs, and the feed was asked once more.
    const w = world(); const api = fakeApi(); const sha = w.release('v0.2.0'); api.releaseOf('v0.2.0');
    const u = make(w, api);
    await u.check();
    const before = api.calls.length;
    const r = await u.update();
    check(r.ok && git(w.app, 'rev-parse', 'HEAD') === sha && api.calls.length === before + 1
      && /releases\/latest$/.test(api.calls[before].url) && api.calls[before].headers['If-None-Match'] === '"e-v0.2.0"',
    're-check: still the latest (304) -> installs; the feed is read again first, with the ETag', { r, calls: api.calls.length - before });
    check(u.states.some((s) => s.progress && /still the latest release/.test(s.progress.text)), 're-check: the progress says it is checking the release is still the latest');
  }
  for (const how of ['pulled', 'replaced', 'none']) {
    // The card says v0.2.0; before Update is pressed the release is pulled (latest falls back to
    // v0.1.0), replaced by v0.2.1, or there is no release at all.
    const w = world(); const api = fakeApi(); w.release('v0.2.0'); api.releaseOf('v0.2.0');
    const old = git(w.app, 'rev-parse', 'HEAD');
    const u = make(w, api);
    let s = await u.check();
    check(s.status === 'available' && s.canUpdate, '[' + how + '] the card offers v0.2.0 first');
    if (how === 'pulled') api.releaseOf('v0.1.0');
    else if (how === 'replaced') { w.release('v0.2.1'); api.releaseOf('v0.2.1'); }
    else { api.status = 404; api.body = null; api.headers = {}; }
    u.timers.scheduled.length = 0;
    const r = await u.update();
    s = u.state();
    const want = how === 'none' ? /v0\.2\.0 is no longer published/ : new RegExp('v0\\.2\\.0 is no longer the latest release \\(GitHub now offers ' + (how === 'pulled' ? 'v0\\.1\\.0' : 'v0\\.2\\.1') + '\\)');
    check(!r.ok && want.test(r.reason) && /Quartz stayed on the version it had/.test(r.reason), '[' + how + '] refused, says why in plain words', r.reason);
    check(git(w.app, 'rev-parse', 'HEAD') === old && git(w.app, 'status', '--porcelain') === '', '[' + how + '] nothing installed: HEAD and tree unchanged');
    check(s.status === 'failed' && s.release === null && !s.canUpdate && s.failure && s.failure.withdrawn === true,
      '[' + how + '] the cached offer is cleared: no release, no button, no Try again', { status: s.status, release: s.release, canUpdate: s.canUpdate });
    check(u.timers.scheduled[u.timers.scheduled.length - 1] === 1000, '[' + how + '] the next check comes soon (first-check delay)', u.timers.scheduled);
    check(fs.readFileSync(path.join(w.data, 'updater.log'), 'utf8').includes('Release re-check: v0.2.0'), '[' + how + '] the log says so');
    const again = await u.update();
    check(!again.ok && /no update to install/.test(again.reason), '[' + how + '] pressing Update again installs nothing', again.reason);
    s = await u.check();
    if (how === 'replaced') {
      check(s.status === 'available' && s.release.tag === 'v0.2.1' && s.canUpdate, '[replaced] the next check offers v0.2.1', s.status);
      const r2 = await u.update();
      check(r2.ok && git(w.app, 'rev-parse', 'HEAD') === git(w.app, 'rev-parse', 'v0.2.1^{commit}'), '[replaced] and v0.2.1 installs', r2);
    } else {
      check(s.status === (how === 'none' ? 'none' : 'current') && !s.canUpdate, '[' + how + '] the next check shows no update', s.status);
    }
  }
  for (const how of ['offline', 'ratelimited', '500']) {
    // The feed cannot be read when Update is pressed: refused, the offer kept (Try again), retried later.
    const w = world(); const api = fakeApi(); const sha = w.release('v0.2.0'); api.releaseOf('v0.2.0');
    const old = git(w.app, 'rev-parse', 'HEAD');
    let t = 1e12;
    const u = make(w, api, { now: () => t });
    await u.check();
    if (how === 'offline') api.throws = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    else if (how === 'ratelimited') { api.status = 403; api.body = null; api.headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((t + 20 * 60000) / 1000) }; }
    else { api.status = 500; api.body = null; api.headers = {}; }
    u.timers.scheduled.length = 0;
    const r = await u.update();
    const s = u.state();
    check(!r.ok && /could not confirm that v0\.2\.0 is still the latest release/.test(r.reason), '[' + how + '] feed unreadable: refused, says it could not confirm', r.reason);
    check(git(w.app, 'rev-parse', 'HEAD') === old, '[' + how + '] nothing installed');
    check(s.status === 'failed' && s.release && s.release.tag === 'v0.2.0' && s.canUpdate && !s.failure.withdrawn, '[' + how + '] the offer stays (Try again), it was not proven void', { st: s.status, canUpdate: s.canUpdate });
    const wantNext = how === 'ratelimited' ? 21 * 60000 : U.RETRY_MS;
    check(u.timers.scheduled[u.timers.scheduled.length - 1] === wantNext, '[' + how + '] retried later (' + wantNext / 60000 + ' min)', u.timers.scheduled);
    api.throws = null; api.releaseOf('v0.2.0');
    const r2 = await u.update();
    check(r2.ok && git(w.app, 'rev-parse', 'HEAD') === sha, '[' + how + '] once the feed answers again, Try again installs', r2);
  }
  {
    // New dependencies: npm ci runs for minutes, and the release is pulled meanwhile.
    const w = world(); const api = fakeApi(); w.release('v0.2.0', { 'package.json': PKG('0.2.0', '1.0.0') }); api.releaseOf('v0.2.0');
    const old = git(w.app, 'rev-parse', 'HEAD');
    const u = make(w, api, { npm: async (args, o) => { write(o.cwd, 'node_modules/new.txt', 'new\n'); api.releaseOf('v0.1.0'); return { code: 0, stdout: '', stderr: '' }; } });
    await u.check();
    const r = await u.update();
    const s = u.state();
    check(!r.ok && /no longer the latest release/.test(r.reason), '[swap] pulled during npm ci: refused after staging', r.reason);
    check(git(w.app, 'rev-parse', 'HEAD') === old && !fs.existsSync(path.join(w.app, U.STAGING_DIR)) && u.relaunchMode() === '',
      '[swap] staging thrown away, no swap restart, HEAD unchanged');
    const saved = JSON.parse(fs.readFileSync(path.join(w.data, 'updates.json'), 'utf8'));
    check(!saved.pending && s.release === null, '[swap] no pending update is left for the next start', saved.pending);
  }

  // ---- update failures: rollback --------------------------------------------------------------------
  {
    const w = world(); const api = fakeApi(); w.release('v0.2.0'); api.releaseOf('v0.2.0');
    const old = git(w.app, 'rev-parse', 'HEAD');
    // The merge goes through, then reports failure: the rollback must put HEAD back.
    const realGit = (args, o) => new Promise((res) => {
      const { spawn } = require('child_process');
      const c = spawn('git', args, { cwd: o.cwd, env: Object.assign({}, process.env, o.env || {}), windowsHide: true });
      let out = '', err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
      c.on('close', (code) => res({ code, stdout: out, stderr: err }));
    });
    const u = make(w, api, { git: async (args, o) => { const r = await realGit(args, o); return args[0] === 'merge' ? { code: 1, stdout: '', stderr: 'fatal: simulated failure after the merge' } : r; } });
    await u.check();
    const r = await u.update();
    const s = u.state();
    check(!r.ok && s.status === 'failed' && /simulated failure/.test(s.failure.reason) && /stayed on the version it had/.test(s.failure.reason), 'merge failure: failed, says why', s.failure);
    check(git(w.app, 'rev-parse', 'HEAD') === old && git(w.app, 'status', '--porcelain') === '', 'merge failure: git reset --keep put HEAD back, tree clean');
    check(s.failure.log === path.join(w.data, 'updater.log') && fs.readFileSync(s.failure.log, 'utf8').includes('Rolled back to'), 'merge failure: the log path is given and the log says it rolled back');
  }
  {
    const w = world(); const api = fakeApi(); w.release('v0.2.0', { 'main.js': '// two\n', 'new.txt': 'release\n' }); api.releaseOf('v0.2.0');
    const old = git(w.app, 'rev-parse', 'HEAD');
    write(w.app, 'new.txt', 'mine, untracked\n');   // a real merge refusal: it would be overwritten
    const u = make(w, api);
    await u.check();
    const r = await u.update();
    check(!r.ok && /git merge --ff-only failed/.test(r.reason) && git(w.app, 'rev-parse', 'HEAD') === old && fs.readFileSync(path.join(w.app, 'new.txt'), 'utf8') === 'mine, untracked\n',
      'a merge git refuses: failed, HEAD unchanged, the untracked file untouched', r.reason);
  }
  {
    const w = world(); const api = fakeApi(); w.release('v0.2.0', { 'package.json': PKG('0.2.0', '1.0.0') }); api.releaseOf('v0.2.0');
    const old = git(w.app, 'rev-parse', 'HEAD');
    const npmCalls = [];
    const u = make(w, api, { npm: async (args, o) => { npmCalls.push({ args, cwd: o.cwd }); return { code: 1, stdout: '', stderr: 'npm ERR! code ECONNRESET\nnpm ERR! network aborted' }; } });
    let s = await u.check();
    check(s.canUpdate && s.needsNpm, 'a package.json change: needsNpm, button still offered', s);
    const r = await u.update();
    s = u.state();
    check(!r.ok && s.status === 'failed' && /npm ci failed \(npm ERR! network aborted\)/.test(s.failure.reason), 'npm ci failure: failed, says npm ci failed and its last line', s.failure);
    check(npmCalls.length === 1 && npmCalls[0].args[0] === 'ci' && npmCalls[0].cwd === path.join(w.app, U.STAGING_DIR, 'tree'), 'npm ci ran in the staging copy, never in the app folder', npmCalls);
    check(git(w.app, 'rev-parse', 'HEAD') === old && !fs.existsSync(path.join(w.app, U.STAGING_DIR)), 'npm ci failure: HEAD unchanged, staging removed');
    check(s.progress === null && u.states.some((x) => x.progress && x.progress.text === U.NPM_TEXT), 'the npm step said it can take several minutes');
  }
  {
    // A release that only bumps "version" (package.json and the lock's two fields): no npm ci.
    const w = world(); const api = fakeApi();
    const sha = w.release('v0.2.0', { 'package.json': PKG('0.2.0'), 'package-lock.json': '{"name":"browser","version":"0.2.0","lockfileVersion":3,"packages":{"":{"version":"0.2.0"}}}\n' });
    api.releaseOf('v0.2.0');
    git(w.app, 'pull', '-q', '--ff-only', 'origin', 'master');   // start from a lock that has the same shape
    w.release('v0.2.1', { 'package.json': PKG('0.2.1'), 'package-lock.json': '{"name":"browser","version":"0.2.1","lockfileVersion":3,"packages":{"":{"version":"0.2.1"}}}\n' });
    api.releaseOf('v0.2.1');
    const npmCalls = [];
    const u = make(w, api, { npm: async () => { npmCalls.push(1); return { code: 0, stdout: '', stderr: '' }; } });
    const s = await u.check();
    check(s.status === 'available' && s.canUpdate && s.needsNpm === false, 'a version-only bump of package.json and the lock: no npm ci', s);
    const r = await u.update();
    check(r.ok && r.relaunch === 'plain' && npmCalls.length === 0 && git(w.app, 'rev-parse', 'HEAD') !== sha, 'a version-only bump updates with a plain restart', r);
    check(U.depsChanged(PKG('0.1.0'), PKG('0.2.0', '1.0.0'), '{}', '{}') && !U.depsChanged(PKG('0.1.0'), PKG('0.9.0'), '{"version":"0.1.0"}', '{"version":"0.9.0"}') && U.depsChanged('{', '{}', null, null),
      'depsChanged: a dependency is a change, a version is not, unreadable counts as a change');
  }
  {
    const w = world(); const api = fakeApi(); w.release('v0.2.0', { 'package.json': PKG('0.2.0', '1.0.0') }); api.releaseOf('v0.2.0');
    const u = make(w, api, { allowNpm: false });
    const s = await u.check();
    check(s.status === 'available' && !s.canUpdate && /test runs never run npm ci/.test(s.blocked), 'allowNpm false (tests): a package change gets no button', s.blocked);
    const u2 = make(w, api, { tools: async () => 'npm was not found on PATH' });
    const s2 = await u2.check();
    check(!s2.canUpdate && /npm was not found on PATH, and this release changes the dependencies/.test(s2.blocked), 'no npm on PATH: no button, says so', s2.blocked);
  }

  // ---- update: the swap path (new dependencies) ----------------------------------------------------
  for (const breakIt of [false, true]) {
    const w = world(); const api = fakeApi(); const sha = w.release('v0.2.0', { 'package.json': PKG('0.2.0', '1.0.0') }); api.releaseOf('v0.2.0');
    const old = git(w.app, 'rev-parse', 'HEAD');
    write(w.app, 'node_modules/old.txt', 'old deps\n');
    const u = make(w, api, { npm: async (args, o) => { write(o.cwd, 'node_modules/new.txt', 'new deps\n'); return { code: 0, stdout: 'added 1 package', stderr: '' }; } });
    await u.check();
    const r = await u.update();
    check(r.ok && r.relaunch === 'swap' && git(w.app, 'rev-parse', 'HEAD') === old && fs.existsSync(path.join(w.app, U.STAGING_DIR, 'tree', 'node_modules', 'new.txt')),
      (breakIt ? '[swap fails] ' : '') + 'new dependencies: staged, a swap restart, the app folder untouched until Quartz quits', r);
    const { planPath, script } = u.swapPlan({ pid: 0, exe: 'Quartz.exe', args: ['.'], cwd: w.app });
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    check(fs.existsSync(script) && plan.from === old && plan.to === sha, 'the swap plan and its helper are written to the profile folder');
    if (breakIt) U.removeTree(path.join(w.app, U.STAGING_DIR, 'tree', 'node_modules'));
    const spawned = [];
    const ok = await U.runSwap(plan, { spawn: (exe, args) => { spawned.push([exe].concat(args)); return { unref() {} }; } });
    if (!breakIt) {
      check(ok && fs.existsSync(path.join(w.app, 'node_modules', 'new.txt')) && !fs.existsSync(path.join(w.app, 'node_modules', 'old.txt')), 'swap: the staged node_modules is in place');
      check(git(w.app, 'rev-parse', 'HEAD') === sha && git(w.app, 'status', '--porcelain', '--untracked-files=no') === '', 'swap: the helper merged the folder to the release');
      check(spawned.length === 1 && spawned[0][0] === 'Quartz.exe' && !fs.existsSync(path.join(w.app, U.STAGING_DIR)), 'swap: Quartz started again, staging tidied');
    } else {
      check(!ok && fs.existsSync(path.join(w.app, 'node_modules', 'old.txt')), 'swap failure: the old node_modules is still there');
      check(git(w.app, 'rev-parse', 'HEAD') === old, 'swap failure: git reset --keep back to the old commit');
      check(spawned.length === 1, 'swap failure: the old Quartz is started again');
    }
    const after = make(w, api); after.start();
    // start() reads the swap's result with git in the background. A fixed 300 ms wait raced it on a slow
    // machine (the state was still "idle"), so poll until it leaves idle, up to 10 s.
    for (let t0 = Date.now(); after.state().status === 'idle' && Date.now() - t0 < 10000;) await new Promise((res) => setTimeout(res, 50));
    const s = after.state();
    if (!breakIt) check(s.status === 'updated' && s.updated.tag === 'v0.2.0', 'next start after a swap: updated', s.status);
    else check(s.status === 'failed' && /could not be swapped in/.test(s.failure.reason) && /on the version it had/.test(s.failure.reason), 'next start after a failed swap: failed, says why', s.failure);
  }

  // ---- the toggle and Later -----------------------------------------------------------------------
  {
    const w = world(); const api = fakeApi(); w.release('v0.2.0'); api.releaseOf('v0.2.0');
    const u = make(w, api);
    u.setEnabled(false);
    check(make(w, api).state().enabled === false, '"Check for updates" off is saved');
    const s = await u.check({ auto: true });
    check(api.calls.length === 0 && s.status !== 'checking', 'off: the timer\'s check does nothing');
    const s2 = await u.check({ manual: true });
    check(s2.status === 'available', 'off: "Check now" still checks when the user asks');
    u.later();
    check(make(w, api).state().enabled === false && (await make(w, api).check()).snoozed === true, 'Later: the release stays snoozed across a restart');
  }

  // ---- removeTree never follows a junction ----------------------------------------------------------
  if (process.platform === 'win32') {
    const target = path.join(ROOT, 'shared-node_modules');
    write(target, 'keep.txt', 'shared\n');
    const holder = path.join(ROOT, 'holder');
    fs.mkdirSync(holder);
    execFileSync('cmd', ['/c', 'mklink', '/J', path.join(holder, 'node_modules'), target], { stdio: 'ignore' });
    U.removeTree(holder);
    check(!fs.existsSync(holder) && fs.existsSync(path.join(target, 'keep.txt')), 'removeTree: a junction is unlinked, its target untouched');
  }
}

main().catch((e) => { fail++; console.log('FAIL threw: ' + (e && e.stack || e)); }).then(() => {
  try { U.removeTree(ROOT); } catch (e) { console.log('(could not remove ' + ROOT + ': ' + e.message + ')'); }
  console.log('updater-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
