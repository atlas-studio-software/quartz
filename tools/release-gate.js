#!/usr/bin/env node
'use strict';
/*
 * release-gate.js -- may this commit go out as a Quartz patch release? And, with --send only,
 * publish it.
 *
 *   node tools/release-gate.js <commit>                        the checks, the release notes for
 *                                                              review, and the cloudtest command
 *   node tools/release-gate.js <commit> --result=<run folder>  ... plus go / no-go from that
 *                                                              cloudtest run's summary line
 *   --rollback-of=<tag>    the commit undoes <tag> (tools/release-rollback.js made it): the 48 h
 *                          cap is waived, but only for a tree that equals the latest release's
 *                          apart from the version and its release notes, and only once <tag> is
 *                          no longer published
 *   --send --clone=<dir>   on GO, publish: sign and push the tag from <dir>, then publish the
 *                          draft the installer workflow made. Nothing else ever leaves this machine.
 *
 * THE CHECKS (every one is run and reported; one failure is NO-GO):
 *   - the commit is on origin/master (merged; the merge rules themselves are the reviewer's);
 *   - package.json and package-lock.json at that commit carry one plain X.Y.Z version;
 *   - it is a PATCH release after GitHub's latest release (same major and minor, higher patch);
 *   - no tag v<version> exists yet on origin (a tag is never moved or reused);
 *   - the 48 h cap: no release was published in the last 48 h (pre-releases count);
 *   - release notes exist at that commit in docs/releases/v<version>.md: non-empty, at most 2000
 *     characters (what the update card shows), no local paths. They are printed for review: the
 *     same text becomes the GitHub release and the public posts;
 *   - with --result: the cloudtest run tested exactly this commit and ran exactly the full suite:
 *       run.json: recipe quartz-core-public, mode committed, base = the commit;
 *       the job log (log.txt): exactly one summary line between @@cloudtest-begin@@ and
 *         @@cloudtest-exit=...@@, with 0 FAIL and 0 failed checks (cloudtest snapshots the working
 *         tree, and a command ending "; echo X=$?" makes run.json say success: so neither the
 *         run's "conclusion", its exit code, nor the exit marker's code is ever read);
 *       the snapshot commit (run.json "snapshot") is in this repository and differs from the
 *         commit only under .cloudtest-job/, .cloudtest/ or .github/workflows/;
 *       its .cloudtest-job/command.sh is exactly the recipe's command (one final LF allowed,
 *         nothing else: an appended "; echo ..." or a CRLF is refused).
 *     A SKIP is allowed only when it is one of KNOWN_SKIPS, by name AND reason; a RAM skip never is.
 *
 * AUTONOMOUS MODE. While autonomy mode is ON, a human signs Quartz tags: --send is refused before
 * anything is checked or sent (the gate still prepares and judges the release). ON means
 * <autonomy dir>/mode.json is readable, on, not paused, open-ended or before endsAt, its policySha
 * is the sha256 of <autonomy dir>/policy.json, and <autonomy dir>/STOP does not exist; anything
 * else (a missing file included) is OFF. QUARTZ_GATE_AUTONOMY_DIR points tests at a temp folder.
 *
 * WHAT --send DOES, in order, stopping at the first failure:
 *   1. <dir> must be a separate clone (release-tag.js needs the default branch checked out, which a
 *      worktree beside the live checkout cannot have) on master, at exactly the commit, clean.
 *   2. The draft release v<version> must exist (gh, signed in), name the commit, and carry
 *      Quartz-Setup.exe. Publishing without it would break every installed copy's download link.
 *   3. node tools/release-tag.js --push in <dir>: signs, verifies and pushes the tag.
 *   4. gh release edit v<version> --draft=false --latest.
 *   5. The public feed is read back and must name v<version> as the latest release.
 *
 * OUTPUT. "release-gate: PASS|FAIL <check>" lines, the notes, the cloudtest command, one
 * "release-gate: GO|NO-GO ..." line, and last the line callers read:
 *   AUTONOMY: {"class":"quartz-release","target":"v<version>@<sha7>","result":"done|failed|refused|would","why":...}
 * would = GO without --send; refused = NO-GO (nothing was sent); failed = a --send step failed
 * (the why says what had already gone out); done = published and read back.
 */
const fs = require('fs');
const path = require('path');
const L = require('./release-lib');

const NOTES_DIR = 'docs/releases';
// The studio's autonomy switch (outside the repository; absent on any other machine = OFF).
const AUTONOMY_DIR = path.join(require('os').homedir(), 'helm-team', 'atlas-studio', 'autonomy');
const NOTES_MAX = 2000;
const SUMMARY_RE = /^quartz-suite: (\d+) files: (\d+) pass, (\d+) FAIL, (\d+) skipped \| checks (\d+) passed, (\d+) failed\s*$/;
// Skips that mean "this runner cannot run it", seen on every cloudtest run, never "it failed".
const KNOWN_SKIPS = [
  { name: 'askclaude-e2e', why: /node-pty|conpty\.node/ },
  { name: 'mcp-e2e', why: /node-pty|conpty\.node/ },
  { name: 'smoke', why: /node-pty|conpty\.node/ },
  // The updater's own e2e refuses a shallow checkout by design; tests/updater-test.js covers the
  // update path in pure node on every run. Fix the recipe (full history) to drop this entry.
  { name: 'updater-e2e', why: /shallow clone/ },
];
const PERSONAL = /[A-Za-z]:\\+Users\\+|\/Users\/|\/home\/|%USERPROFILE%/i;

/** The last summary line of a suite log, parsed; null when there is none (= FAIL). */
function parseSummary(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/^\S+Z /, '').trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = SUMMARY_RE.exec(lines[i]);
    if (m) return { line: lines[i], files: +m[1], pass: +m[2], fail: +m[3], skipped: +m[4], checksPassed: +m[5], checksFailed: +m[6] };
  }
  return null;
}

// The full suite as the recipe runs it, and where a cloudtest snapshot may differ from the commit.
const RECIPE = 'quartz-core-public';
const RECIPE_COMMAND = 'node tools/run-suite.js --out=suite-out';
const SNAPSHOT_ONLY = ['.cloudtest-job/', '.cloudtest/', '.github/workflows/'];
const BEGIN = '@@cloudtest-begin@@';
const EXIT_RE = /^@@cloudtest-exit=(-?\d+)@@$/;

/**
 * The summary line inside the job markers of a cloudtest job log. { s, why } where s is the parsed
 * summary (or null) and why says what is wrong. Exactly one begin marker, exactly one exit marker
 * after it, exactly one summary line between them. The exit marker's code is never read.
 */
function markedSummary(logText) {
  const lines = String(logText || '').split(/\r?\n/).map((l) => l.replace(/^\S+Z /, '').trim());
  const begins = [], exits = [];
  lines.forEach((l, i) => { if (l === BEGIN) begins.push(i); else if (EXIT_RE.test(l)) exits.push(i); });
  if (begins.length !== 1) return { s: null, why: 'the job log has ' + begins.length + ' ' + BEGIN + ' markers, not one' };
  if (exits.length !== 1) return { s: null, why: 'the job log has ' + exits.length + ' @@cloudtest-exit=@@ markers, not one' };
  if (exits[0] < begins[0]) return { s: null, why: 'the exit marker comes before the begin marker' };
  const inside = lines.slice(begins[0] + 1, exits[0]).filter((l) => SUMMARY_RE.test(l));
  if (inside.length !== 1) return { s: null, why: inside.length + ' quartz-suite summary lines between the job markers, not one' + (inside.length ? '' : ': that is a FAIL') };
  return { s: parseSummary(inside[0]), why: '' };
}

/**
 * Go / no-go from a cloudtest run folder ({ run.json, log.txt, artifacts/suite.json,
 * artifacts/suite.txt }) for commit `sha`. o.git(args) -> { code, stdout, stderr } runs git in the
 * repository that holds the commit (and, locally, the run's snapshot commit). o.readFile is for tests.
 * Resolves { go, why: [..], summary, skips: [..] }.
 */
async function judgeResult(dir, sha, o) {
  const opt = o || {};
  const rd = opt.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const git = opt.git;
  const why = [];
  const out = { go: false, why, summary: null, skips: [] };
  let st = null;
  try { st = fs.statSync(dir); } catch { /* checked below */ }
  if (!st || !st.isDirectory()) { why.push('the result must be a cloudtest run folder (with run.json), so it can be tied to the commit: ' + dir); return out; }
  let runJson = null;
  try { runJson = JSON.parse(rd(path.join(dir, 'run.json'))); } catch (e) { why.push('run.json could not be read: ' + e.message); }
  if (runJson) {
    if (runJson.recipe !== RECIPE) why.push('the run used the recipe "' + runJson.recipe + '", not ' + RECIPE);
    if (runJson.mode !== 'committed') why.push('the run tested "' + runJson.mode + '" files, not a pushed commit');
    if (runJson.base !== sha) why.push('the run tested ' + String(runJson.base || 'an unknown commit').slice(0, 12) + ', not ' + sha.slice(0, 12));
    if (runJson.command !== RECIPE_COMMAND) why.push('run.json\'s command is "' + String(runJson.command).slice(0, 120) + '", not the full suite "' + RECIPE_COMMAND + '"');
  }

  // 1. The summary line inside the job markers.
  let log = null;
  try { log = rd(path.join(dir, 'log.txt')); } catch { /* checked below */ }
  const m = log === null ? { s: null, why: 'log.txt (the job log) is missing' } : markedSummary(log);
  const s = m.s;
  out.summary = s;
  if (!s) why.push(m.why);
  else {
    if (s.fail !== 0) why.push(s.fail + ' file(s) FAIL');
    if (s.checksFailed !== 0) why.push(s.checksFailed + ' check(s) failed');
    if (s.pass === 0) why.push('nothing passed');
    if (s.pass + s.fail + s.skipped !== s.files) why.push('the summary does not add up (' + s.line + ')');
    let txt = null;
    try { txt = rd(path.join(dir, 'artifacts', 'suite.txt')); } catch { /* optional */ }
    if (txt !== null) { const t = parseSummary(txt); if (!t || t.line !== s.line) why.push('artifacts/suite.txt\'s summary differs from the job log\'s'); }
  }

  // The skips, from suite.json.
  let suite = null;
  try { suite = JSON.parse(rd(path.join(dir, 'artifacts', 'suite.json'))); } catch { /* checked below */ }
  if (!suite || !Array.isArray(suite.results)) why.push('artifacts/suite.json is missing, so the skips cannot be judged');
  else {
    if (s && String(suite.verdict || '').trim() !== s.line) why.push('suite.json\'s verdict differs from the job log\'s summary line');
    for (const r of suite.results.filter((x) => x.status === 'SKIP')) {
      const known = KNOWN_SKIPS.find((k) => k.name === r.name && k.why.test(String(r.why || '')));
      out.skips.push({ name: r.name, why: String(r.why || ''), known: !!known });
      if (!known) why.push('SKIP ' + r.name + ' is not a known runner limit (' + String(r.why || 'no reason').slice(0, 160) + ')');
    }
    const fails = suite.results.filter((x) => x.status !== 'PASS' && x.status !== 'SKIP').map((x) => x.name);
    if (fails.length) why.push('not passing: ' + fails.join(', '));
    if (s && s.skipped !== out.skips.length) why.push('the summary counts ' + s.skipped + ' skipped, suite.json ' + out.skips.length);
  }

  // 2. The snapshot tree, and 3. command.sh.
  const snap = runJson ? String(runJson.snapshot || '') : '';
  if (!git) why.push('no git to check the run\'s snapshot commit with');
  else if (!/^[0-9a-f]{40}$/.test(snap)) why.push('run.json names no snapshot commit');
  else {
    const t = await git(['cat-file', '-t', snap]);
    if (t.code !== 0 || t.stdout.trim() !== 'commit') {
      why.push('the run\'s snapshot commit ' + snap.slice(0, 12) + ' is not in this repository' + (runJson.branch ? ' (fetch it: git fetch origin ' + runJson.branch + ')' : ''));
    } else {
      const d = await git(['diff', '--name-only', '--no-renames', sha, snap]);
      if (d.code !== 0) why.push('the snapshot could not be compared with the commit: ' + String(d.stderr).trim().split(/\r?\n/).pop());
      else {
        const extra = d.stdout.split(/\r?\n/).filter(Boolean).filter((f) => !SNAPSHOT_ONLY.some((p) => f.startsWith(p)));
        if (extra.length) why.push('the snapshot differs from the commit outside ' + SNAPSHOT_ONLY.join(', ') + ': ' + extra.slice(0, 6).join(', ') + (extra.length > 6 ? ' and ' + (extra.length - 6) + ' more' : '') + ' (cloudtest tested the working tree, not the commit)');
      }
      const c = await git(['show', snap + ':.cloudtest-job/command.sh']);
      if (c.code !== 0) why.push('the snapshot has no .cloudtest-job/command.sh');
      else if (c.stdout !== RECIPE_COMMAND && c.stdout !== RECIPE_COMMAND + '\n') {
        why.push('the snapshot\'s command.sh is ' + JSON.stringify(c.stdout.slice(0, 160)) + ', not exactly the recipe\'s ' + JSON.stringify(RECIPE_COMMAND));
      }
    }
  }
  out.go = why.length === 0;
  return out;
}

/** autonomy/mode.json says ON? { on, why }. Missing or unreadable is OFF. */
function autonomyOn(dir, now) {
  const crypto = require('crypto');
  const t = typeof now === 'function' ? now() : Date.now();
  let mode;
  try { mode = JSON.parse(fs.readFileSync(path.join(dir, 'mode.json'), 'utf8')); } catch { return { on: false, why: 'mode.json missing or unreadable' }; }
  if (!mode || mode.on !== true) return { on: false, why: 'mode is off' };
  if (mode.paused) return { on: false, why: 'mode is paused' };
  const open = mode.length && mode.length.kind === 'open';
  const ends = typeof mode.endsAt === 'number' ? mode.endsAt : Date.parse(String(mode.endsAt || ''));
  if (!open && !(t < ends)) return { on: false, why: 'mode has ended' };
  let policy;
  try { policy = fs.readFileSync(path.join(dir, 'policy.json')); } catch { return { on: false, why: 'policy.json missing' }; }
  if (crypto.createHash('sha256').update(policy).digest('hex') !== String(mode.policySha || '').toLowerCase()) return { on: false, why: 'policy.json does not match policySha' };
  if (fs.existsSync(path.join(dir, 'STOP'))) return { on: false, why: 'STOP is set' };
  return { on: true, why: 'autonomy mode is on' };
}

function cloudtestCommand(sha) {
  const short = sha.slice(0, 7);
  return [
    'git worktree add --detach ../quartz-wt/gate-' + short + ' ' + sha,
    'cd ../quartz-wt/gate-' + short,
    'cloudtest --recipe quartz-core-public',
    'node tools/release-gate.js ' + sha + ' --result=.cloudtest/<run id>',
  ];
}

/**
 * The gate. o: { cwd, commit, result?, rollbackOf?, send?, clone?, now?, fetch?, sh?, sleep?, say? }
 *   o.sh(cmd, args, { cwd }) -> { code, stdout, stderr }   every git / gh / node call goes through it
 *   o.fetch(apiPath) -> { status, body }                   the public feed (no sign-in)
 * Resolves { go, result, autonomy, tag, version, sha, checks, notes, verdict }.
 */
async function gate(o) {
  const sh = o.sh || L.run;
  const say = o.say || ((l) => console.log(l));
  const now = o.now || Date.now;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cwd = o.cwd || process.cwd();
  const git = (args, c) => sh('git', args, { cwd: c || cwd });
  const checks = [];
  const add = (name, ok, text) => { checks.push({ name, ok, text }); say('release-gate: ' + (ok ? 'PASS ' : 'FAIL ') + name + ': ' + text); };
  const finish = (result, why, extra) => {
    const r = Object.assign({ result, why, checks }, extra || {});
    r.autonomy = L.autonomyLine('quartz-release', (r.tag || '?') + '@' + String(r.sha || o.commit || '').slice(0, 7), result, why);
    say(r.autonomy);
    return r;
  };

  const c = await git(['rev-parse', '--verify', '--quiet', String(o.commit || '') + '^{commit}']);
  const sha = c.code === 0 ? c.stdout.trim() : '';
  if (!sha) { add('commit', false, 'no such commit: ' + o.commit); say('release-gate: NO-GO'); return finish('refused', 'no such commit: ' + o.commit); }
  add('commit', true, sha);

  const f = await git(['fetch', '--quiet', 'origin', '+refs/heads/master:refs/remotes/origin/master']);
  const onMaster = f.code === 0 && (await git(['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/master'])).code === 0;
  add('on master', onMaster, f.code !== 0 ? 'origin could not be fetched: ' + f.stderr.trim().split(/\r?\n/).pop() : onMaster ? 'the commit is on origin/master' : 'the commit is not on origin/master (merge it first)');

  // The version at that commit.
  const show = async (file) => { const r = await git(['show', sha + ':' + file]); return r.code === 0 ? r.stdout : null; };
  let version = '';
  try {
    const pkg = JSON.parse(await show('package.json'));
    const lock = JSON.parse(await show('package-lock.json'));
    const v = L.parseVersion(pkg.version);
    const same = lock.version === pkg.version && (!lock.packages || !lock.packages[''] || lock.packages[''].version === pkg.version);
    if (v && same) { version = v.text; add('version', true, version + ' in package.json and package-lock.json'); }
    else add('version', false, !v ? 'package.json has no plain X.Y.Z version ("' + pkg.version + '")' : 'package-lock.json says ' + lock.version + ', package.json ' + pkg.version);
  } catch (e) { add('version', false, 'package.json / package-lock.json could not be read at ' + sha.slice(0, 7) + ': ' + e.message); }
  const tag = version ? 'v' + version : '';

  // The public feed.
  let feed = null;
  try { feed = await L.readFeed(o.fetch); } catch (e) { add('releases feed', false, e.message); }
  const latestTag = feed && feed.latest ? feed.latest.tag_name : '';
  if (feed) {
    if (!feed.latest) add('patch only', false, 'GitHub has no latest release to compare with; a first release is never autonomous');
    else if (version) { const p = L.patchOnly(version, latestTag); add('patch only', p.ok, p.why + ' (latest: ' + latestTag + ')'); }
  }

  if (tag) {
    const remote = await git(['ls-remote', '--tags', 'origin', 'refs/tags/' + tag]);
    const local = await git(['rev-parse', '--verify', '--quiet', 'refs/tags/' + tag]);
    const taken = (remote.code === 0 && remote.stdout.trim() !== '') || local.code === 0 || (feed && feed.list.some((r) => r.tag_name === tag));
    add('new tag', remote.code === 0 && !taken, remote.code !== 0 ? 'origin\'s tags could not be listed' : taken ? tag + ' already exists: a tag is never moved or reused, release the next patch' : tag + ' is not taken');
  }

  // The 48 h cap, or the rollback exception.
  if (feed) {
    const times = feed.list.map((r) => Date.parse(r.published_at || '')).filter((t) => Number.isFinite(t));
    const last = times.length ? Math.max.apply(null, times) : 0;
    const within = last && now() - last < L.CAP_MS;
    if (!o.rollbackOf) {
      add('48 h cap', !within, within ? 'a release was published ' + hours(now() - last) + ' ago; the next may go after ' + new Date(last + L.CAP_MS).toISOString() : 'the last release was published ' + (last ? hours(now() - last) + ' ago' : 'never'));
    } else {
      const bad = o.rollbackOf;
      const still = feed.list.find((r) => r.tag_name === bad && !r.prerelease);
      const why = [];
      if (still) why.push(bad + ' is still published: put it back to draft first (tools/release-rollback.js ' + bad + ' --send)');
      if (latestTag === bad) why.push(bad + ' is still the latest release');
      if (latestTag && latestTag !== bad) {
        const d = await git(['diff', '--name-only', 'refs/tags/' + latestTag, sha]);
        const files = d.code === 0 ? d.stdout.split(/\r?\n/).filter(Boolean) : null;
        if (!files) why.push('the commit could not be compared with ' + latestTag + ' (fetch the tags)');
        else {
          const extra = files.filter((x) => x !== 'package.json' && x !== 'package-lock.json' && !x.startsWith(NOTES_DIR + '/'));
          if (extra.length) why.push('the commit differs from ' + latestTag + ' beyond the version and its notes: ' + extra.slice(0, 6).join(', ') + (extra.length > 6 ? ' and ' + (extra.length - 6) + ' more' : ''));
          const U = require('../updater');
          const sl = async (rev, file) => { const r = await git(['show', rev + ':' + file]); return r.code === 0 ? r.stdout : null; };
          if (U.depsChanged(await sl('refs/tags/' + latestTag, 'package.json'), await sl(sha, 'package.json'), await sl('refs/tags/' + latestTag, 'package-lock.json'), await sl(sha, 'package-lock.json'))) {
            why.push('package.json or package-lock.json differ from ' + latestTag + ' beyond their version');
          }
        }
      }
      add('rollback of ' + bad, why.length === 0, why.length ? why.join('; ') : 'the tree equals ' + latestTag + ' apart from the version and its notes, and ' + bad + ' is no longer published: the 48 h cap is waived');
    }
  }

  // The release notes, for review.
  let notes = null;
  if (version) {
    const rel = NOTES_DIR + '/v' + version + '.md';
    notes = await show(rel);
    const t = String(notes || '').trim();
    const bad = !t ? 'missing or empty at ' + sha.slice(0, 7) + ': ' + rel
      : t.length > NOTES_MAX ? rel + ' is ' + t.length + ' characters; the update card shows ' + NOTES_MAX
        : PERSONAL.test(t) ? rel + ' names a local path; the notes are public'
          : '';
    add('release notes', !bad, bad || rel + ' (' + t.length + ' characters, printed below for review)');
    if (t) { say('----- ' + rel + ' -----'); for (const l of t.split(/\r?\n/)) say('  ' + l); say('----- end of notes -----'); }
  }

  // cloudtest.
  say('release-gate: the full suite for this commit (needs Owen\'s OK: cloudtest pushes a branch):');
  for (const l of cloudtestCommand(sha)) say('  ' + l);
  let verdict = null;
  if (o.result) {
    verdict = await judgeResult(o.result, sha, { readFile: o.readFile, git: (args) => git(args) });
    for (const s of verdict.skips) say('release-gate: SKIP ' + s.name + (s.known ? ' (known runner limit)' : ' (NOT allowed)') + ': ' + s.why.slice(0, 160));
    add('cloudtest', verdict.go, (verdict.summary ? verdict.summary.line : 'no summary line') + (verdict.why.length ? ' -- ' + verdict.why.join('; ') : ''));
  } else {
    add('cloudtest', false, 'no result yet: run the command above, then pass --result=<run folder>');
  }

  const failed = checks.filter((x) => !x.ok);
  const base = { tag, version, sha, notes, verdict, latest: latestTag };
  if (failed.length) {
    say('release-gate: NO-GO ' + (tag || '?') + ' at ' + sha.slice(0, 7) + ': ' + failed.map((x) => x.name).join(', '));
    return finish('refused', failed.map((x) => x.name + ': ' + x.text).join(' | '), Object.assign(base, { go: false }));
  }
  say('release-gate: GO ' + tag + ' at ' + sha.slice(0, 7));
  if (!o.send) {
    say('release-gate: nothing sent. To publish: node tools/release-gate.js ' + sha + ' --result=' + o.result + (o.rollbackOf ? ' --rollback-of=' + o.rollbackOf : '') + ' --send --clone=<separate clone on master at ' + sha.slice(0, 7) + '>');
    return finish('would', 'GO; nothing sent without --send', Object.assign(base, { go: true }));
  }
  return send(o, Object.assign(base, { go: true }), { sh, say, sleep, finish });
}

function hours(ms) { return (ms / 3600000).toFixed(1) + ' h'; }

/** --send: the only path that publishes. Stops at the first failure and says what went out. */
async function send(o, base, k) {
  const { sh, say, sleep, finish } = k;
  const { tag, sha } = base;
  const dir = o.clone ? path.resolve(o.clone) : '';
  const refuse = (why) => { say('release-gate: --send refused: ' + why); return finish('refused', why, base); };
  const mode = autonomyOn(o.autonomyDir || process.env.QUARTZ_GATE_AUTONOMY_DIR || AUTONOMY_DIR, o.now);
  if (mode.on) return refuse('autonomy mode is on, and in v1 a human signs Quartz tags: the gate prepares the release, a person runs release-tag.js and publishes');
  if (!dir) return refuse('--send needs --clone=<dir>: a separate clone of the public repository on master at ' + sha.slice(0, 7));
  const g = (args) => sh('git', args, { cwd: dir });
  if (fs.existsSync(path.join(dir, '.git')) && fs.statSync(path.join(dir, '.git')).isFile()) return refuse(dir + ' is a linked worktree; release-tag.js needs a separate clone with master checked out');
  const head = (await g(['rev-parse', 'HEAD'])).stdout.trim();
  if (head !== sha) return refuse(dir + ' is at ' + (head.slice(0, 7) || 'no commit') + ', not ' + sha.slice(0, 7));
  const br = (await g(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  if (br !== 'master') return refuse(dir + ' is on "' + (br || 'a detached HEAD') + '", not master');
  const dirty = await g(['status', '--porcelain', '--untracked-files=no']);
  if (dirty.code !== 0 || dirty.stdout.trim()) return refuse(dir + ' has uncommitted changes');

  // The draft the installer workflow made.
  const list = await sh('gh', ['api', 'repos/' + L.SLUG + '/releases?per_page=100'], { cwd: dir });
  let rel = null;
  try { rel = JSON.parse(list.stdout).find((r) => r.tag_name === tag); } catch { /* checked below */ }
  if (list.code !== 0) return refuse('gh could not list the releases (signed in?): ' + String(list.stderr).trim().split(/\r?\n/).pop());
  if (!rel) return refuse('there is no draft release ' + tag + ': run the installer workflow (Actions > installer > Run workflow, draft on) on ' + sha.slice(0, 7));
  if (!rel.draft) return refuse(tag + ' is already published');
  if (rel.target_commitish !== sha) return refuse('the draft ' + tag + ' was built from ' + String(rel.target_commitish).slice(0, 12) + ', not ' + sha.slice(0, 12) + ': run the installer workflow again on this commit');
  const asset = (rel.assets || []).find((a) => a.name === L.INSTALLER_ASSET);
  if (!asset || !(asset.size > 0) || (asset.state && asset.state !== 'uploaded')) return refuse('the draft ' + tag + ' has no uploaded ' + L.INSTALLER_ASSET + '; publishing it would break every installed copy\'s download link');

  // Outward from here.
  const t = await sh('node', ['tools/release-tag.js', '--push'], { cwd: dir });
  const tline = (t.stdout.split(/\r?\n/).filter((l) => /^release-tag: /.test(l)).pop() || '').trim();
  say(tline || 'release-tag: (no summary line)');
  if (!/^release-tag: \S+ signed and verified .*, pushed$/.test(tline)) return finish('failed', 'release-tag.js did not sign, verify and push ' + tag + ': ' + (tline || String(t.stderr).trim().split(/\r?\n/).pop() || 'no summary line') + '; nothing was published', base);
  const p = await sh('gh', ['release', 'edit', tag, '--repo', L.SLUG, '--draft=false', '--latest'], { cwd: dir });
  if (p.code !== 0) return finish('failed', 'the tag ' + tag + ' is pushed, but publishing the draft failed: ' + String(p.stderr).trim().split(/\r?\n/).pop() + '; the release is still a draft', base);
  let seen = '';
  for (let i = 0; i < 4; i++) {
    try { const fd = await L.readFeed(o.fetch); seen = fd.latest ? fd.latest.tag_name : ''; } catch (e) { seen = '(' + e.message + ')'; }
    if (seen === tag) break;
    await sleep(5000);
  }
  if (seen !== tag) return finish('failed', tag + ' was published, but the public feed names ' + (seen || 'no release') + ' as the latest; check it by hand', base);
  say('release-gate: published ' + tag + ' and the public feed names it the latest release');
  return finish('done', 'published ' + tag + ' at ' + sha.slice(0, 7), base);
}

module.exports = { gate, judgeResult, markedSummary, autonomyOn, parseSummary, cloudtestCommand, KNOWN_SKIPS, NOTES_DIR, RECIPE_COMMAND, SNAPSHOT_ONLY };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (name) => { const a = argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : ''; };
  const commit = argv.find((x) => !x.startsWith('--'));
  if (!commit) {
    console.log('usage: node tools/release-gate.js <commit> [--result=<cloudtest run folder>] [--rollback-of=<tag>] [--send --clone=<dir>]');
    console.log(L.autonomyLine('quartz-release', '?', 'refused', 'no commit given'));
    process.exit(2);
  }
  gate({ commit, result: arg('result') || '', rollbackOf: arg('rollback-of') || '', send: argv.includes('--send'), clone: arg('clone') || '' })
    .then((r) => process.exit(r.result === 'done' || r.result === 'would' ? 0 : 1))
    .catch((e) => { console.log('release-gate: threw: ' + ((e && e.stack) || e)); console.log(L.autonomyLine('quartz-release', commit, 'failed', 'the gate threw: ' + ((e && e.message) || e))); process.exit(1); });
}
