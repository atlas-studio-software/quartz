'use strict';
/*
 * release-gate-test.js -- tools/release-gate.js and tools/release-rollback.js against throwaway git
 * repos in %TEMP% (a bare "origin", a work clone, a separate release clone), a fake public feed and
 * a fake process runner. gh and release-tag.js are NEVER run: every gh / node call goes to the fake,
 * which records it and throws on anything it was not told about. Real git only, on the temp repos.
 *
 *   node tests/release-gate-test.js        -> "release-gate-test: N passed, M failed"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('../tools/release-lib');
const G = require('../tools/release-gate');
const R = require('../tools/release-rollback');

let pass = 0, fail = 0;
function check(cond, label, detail) {
  if (cond) { pass++; console.log('PASS ' + label); }
  else { fail++; console.log('FAIL ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 500))); }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'quartz-release-gate-test-'));
Object.assign(process.env, {
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'init.defaultBranch', GIT_CONFIG_VALUE_1: 'master',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
});
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function write(dir, rel, text) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
const PKG = (v) => JSON.stringify({ name: 'browser', productName: 'Quartz', version: v, dependencies: { x: '1.0.0' } }, null, 2) + '\n';
const LOCK = (v) => JSON.stringify({ name: 'browser', version: v, lockfileVersion: 3, packages: { '': { name: 'browser', version: v }, 'node_modules/x': { version: v } } }, null, 2) + '\n';
const DAY = 24 * 3600000;
// The real autonomy switch must never steer a test: point the gate at an empty folder (= OFF).
const NO_AUTONOMY = path.join(ROOT, 'autonomy-none');
fs.mkdirSync(NO_AUTONOMY, { recursive: true });
process.env.QUARTZ_GATE_AUTONOMY_DIR = NO_AUTONOMY;
const NOW = Date.parse('2026-11-20T12:00:00Z');

let n = 0;
/** origin.git (bare) with master at v0.1.1 (v0.1.0 before it), and a work clone. */
function world() {
  const dir = path.join(ROOT, 'w' + (++n));
  const seed = path.join(dir, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q');
  write(seed, 'package.json', PKG('0.1.0')); write(seed, 'package-lock.json', LOCK('0.1.0')); write(seed, 'main.js', '// 0.1.0\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'Quartz 0.1.0'); git(seed, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
  write(seed, 'package.json', PKG('0.1.1')); write(seed, 'package-lock.json', LOCK('0.1.1')); write(seed, 'main.js', '// 0.1.1\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'Quartz 0.1.1'); git(seed, 'tag', '-a', 'v0.1.1', '-m', 'v0.1.1');
  const origin = path.join(dir, 'origin.git');
  git(dir, 'clone', '-q', '--bare', seed, origin);
  const work = path.join(dir, 'work');
  git(dir, 'clone', '-q', origin, work);
  git(work, 'switch', '-q', '-c', 'wk/release');
  return {
    dir, origin, work,
    /** Commit on the work branch; push it to origin master when asked. Returns the sha. */
    commit(files, msg, push) {
      for (const [k, v] of Object.entries(files)) { if (v === null) fs.rmSync(path.join(work, k)); else write(work, k, v); }
      git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', msg || 'change');
      if (push) git(work, 'push', '-q', 'origin', 'HEAD:master');
      return git(work, 'rev-parse', 'HEAD');
    },
    /** A separate clone on master (what --send needs). */
    releaseClone() { const c = path.join(dir, 'rel-' + (++n)); git(dir, 'clone', '-q', origin, c); return c; },
  };
}

/** The public feed: f.latest (tag or ''), f.list [{tag, at, prerelease}], f.down. */
function fakeFeed() {
  const f = { latest: 'v0.1.1', list: [{ tag: 'v0.1.0', at: NOW - 30 * DAY }, { tag: 'v0.1.1', at: NOW - 5 * DAY }], down: false, calls: 0 };
  f.fetch = async (p) => {
    f.calls++;
    if (f.down) return { status: 0, error: 'ENOTFOUND' };
    if (p === '/repos/' + L.SLUG + '/releases/latest') return f.latest ? { status: 200, body: { tag_name: f.latest } } : { status: 404, body: {} };
    if (p === '/repos/' + L.SLUG + '/releases?per_page=100') return { status: 200, body: f.list.map((r) => ({ tag_name: r.tag, draft: false, prerelease: !!r.prerelease, published_at: new Date(r.at).toISOString() })) };
    return { status: 404, body: {} };
  };
  return f;
}

/**
 * The process runner: git is real; gh and node go to handlers (o.gh(args), o.node(args)); any other
 * command, or gh/node without a handler, is a test failure and is never spawned.
 */
function fakeSh(o) {
  const calls = [];
  const sh = async (cmd, args, opts) => {
    calls.push([cmd].concat(args));
    if (cmd === 'git') return L.run('git', args, opts);
    const h = o && o[cmd];
    if (!h) { fail++; console.log('FAIL unexpected ' + cmd + ' ' + args.join(' ')); return { code: 1, stdout: '', stderr: 'not allowed in tests' }; }
    return h(args, opts);
  };
  sh.calls = calls;
  sh.outward = () => calls.filter((c) => c[0] !== 'git');
  return sh;
}

const FULL = 'node tools/run-suite.js --out=suite-out';

/**
 * A cloudtest snapshot commit on top of `sha`, made with plumbing (no checkout): the job folder,
 * cloudtest's own workflow, and o.snapFiles (null removes a path). Returns its sha.
 */
function snapshotCommit(repo, sha, o) {
  const idx = path.join(ROOT, 'idx-' + (++n));
  const env = Object.assign({}, process.env, { GIT_INDEX_FILE: idx });
  const g = (args, input) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', input: input === undefined ? '' : input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  g(['read-tree', sha]);
  const files = Object.assign({
    '.cloudtest-job/command.sh': o.command === undefined ? FULL + '\n' : o.command,
    '.cloudtest-job/test.sh': '#!/usr/bin/env bash\nset +e\necho "@@cloudtest-begin@@"\nbash .cloudtest-job/command.sh\ncode=$?\necho "@@cloudtest-exit=${code}@@"\nexit $code\n',
    '.cloudtest-job/.gitattributes': '* text eol=lf\n',
    '.github/workflows/cloudtest.yml': 'name: cloudtest\n',
  }, o.snapFiles || {});
  for (const [k, v] of Object.entries(files)) {
    if (v === null) { g(['update-index', '--force-remove', k]); continue; }
    const h = g(['hash-object', '-w', '--stdin'], v);
    g(['update-index', '--add', '--cacheinfo', '100644,' + h + ',' + k]);
  }
  const tree = g(['write-tree']);
  try { fs.unlinkSync(idx); } catch { /* fine */ }
  return g(['commit-tree', tree, '-p', sha, '-m', 'cloudtest snapshot'], '');
}

/** A cloudtest run folder, as cloudtest downloads it: run.json, log.txt (the job log), artifacts. */
function runDir(w, sha, o) {
  const x = Object.assign({ recipe: 'quartz-core-public', mode: 'committed', files: 101, pass: 97, failN: 0, skips: ['askclaude-e2e', 'mcp-e2e', 'smoke', 'updater-e2e'], checksFailed: 0, summary: true, skipWhy: {}, log: 'ok', exit: 0, conclusion: 'failure', exitCode: 1 }, o || {});
  const d = path.join(w.dir, 'run-' + (++n));
  const id = '20261119-000000-' + String(n).padStart(6, '0');
  const why = { 'askclaude-e2e': 'askclaude-e2e: cannot run: needs node-pty built for Electron (conpty.node is missing)', 'mcp-e2e': 'mcp-e2e: cannot run: needs node-pty built for Electron (conpty.node is missing)', smoke: 'opens a Claude Code pane: needs node-pty built for Electron (conpty.node)', 'updater-e2e': 'updater-e2e: cannot run: this checkout is a shallow clone, so ...' };
  const skipped = x.skips.length;
  const line = 'quartz-suite: ' + x.files + ' files: ' + x.pass + ' pass, ' + x.failN + ' FAIL, ' + skipped + ' skipped | checks 7752 passed, ' + x.checksFailed + ' failed';
  const snapshot = x.snapshot !== undefined ? x.snapshot : snapshotCommit(w.work, sha, x);
  const command = x.runCommand !== undefined ? x.runCommand : (typeof x.command === 'string' ? x.command.replace(/\r?\n$/, '') : FULL);
  write(d, 'run.json', JSON.stringify({ id, recipe: x.recipe, mode: x.mode, base: x.base || sha, snapshot, branch: 'cloudtest/' + id, command, conclusion: x.conclusion, exitCode: x.exitCode }));
  const results = [];
  for (let i = 0; i < x.pass; i++) results.push({ name: 't' + i, status: 'PASS', why: '' });
  for (let i = 0; i < x.failN; i++) results.push({ name: 'f' + i, status: 'FAIL', why: 'broke' });
  for (const s of x.skips) results.push({ name: s, status: 'SKIP', why: x.skipWhy[s] || why[s] || 'cannot run' });
  write(d, 'artifacts/suite.json', JSON.stringify({ verdict: line, results }));
  write(d, 'artifacts/suite.txt', x.suiteTxt !== undefined ? x.suiteTxt : 'PASS a 1 s a: 1 passed, 0 failed\n' + (x.summary ? line + '\n' : ''));
  const T = (l) => '2026-11-19T08:10:22.9338477Z ' + l;
  const body = ['PASS a 1 s a: 1 passed, 0 failed'].concat(x.summary ? [line] : []);
  let lines;
  if (x.log === 'nomarkers') lines = body;
  else if (x.log === 'twobegins') lines = ['@@cloudtest-begin@@'].concat(['@@cloudtest-begin@@'], body, ['@@cloudtest-exit=' + x.exit + '@@']);
  else if (x.log === 'twosummaries') lines = ['@@cloudtest-begin@@'].concat(body, [line], ['@@cloudtest-exit=' + x.exit + '@@']);
  else if (x.log === 'outside') lines = ['@@cloudtest-begin@@', 'PASS a 1 s a: 1 passed, 0 failed', '@@cloudtest-exit=0@@', line];
  else lines = ['##[group]Run bash .cloudtest-job/test.sh', '@@cloudtest-begin@@'].concat(body, ['@@cloudtest-exit=' + x.exit + '@@', '##[group]Run actions/upload-artifact@v7']);
  if (x.log !== 'missing') write(d, 'log.txt', lines.map(T).join('\r\n') + '\r\n');
  return d;
}

const NOTES = '# Quartz 0.1.2\n\n- A fix the user will notice.\n';
const quiet = () => { const lines = []; const say = (l) => lines.push(l); say.lines = lines; return say; };
const autonomy = (lines) => { const l = lines.filter((x) => /^AUTONOMY: /.test(x)); return l.length === 1 ? JSON.parse(l[0].slice(10)) : { count: l.length }; };

async function main() {
  // ---- pure helpers -----------------------------------------------------------------------------
  check(L.patchOnly('0.1.2', 'v0.1.1').ok && L.patchOnly('0.1.5', 'v0.1.1').ok && !L.patchOnly('0.2.0', 'v0.1.1').ok && !L.patchOnly('1.1.2', 'v0.1.1').ok
    && !L.patchOnly('0.1.1', 'v0.1.1').ok && !L.patchOnly('0.1.0', 'v0.1.1').ok && !L.patchOnly('0.1.2-beta', 'v0.1.1').ok, 'patchOnly: only a higher patch of the same major.minor');
  check(L.autonomyLine('quartz-release', 'v0.1.2@abc1234', 'would') === 'AUTONOMY: {"class":"quartz-release","target":"v0.1.2@abc1234","result":"would"}', 'the AUTONOMY line has the agreed shape');
  const s1 = G.parseSummary('x\n2026-11-17T01:21:47.0469176Z quartz-suite: 101 files: 97 pass, 0 FAIL, 4 skipped | checks 7752 passed, 0 failed\n');
  check(s1 && s1.files === 101 && s1.fail === 0 && s1.skipped === 4 && s1.checksFailed === 0, 'parseSummary reads a CI-timestamped summary line', s1);
  check(G.parseSummary('quartz-suite: 3 files: 3 pass\n') === null && G.parseSummary('') === null, 'parseSummary: no summary line -> null (a FAIL)');
  check(R.bumpJsonText(PKG('0.1.1'), '0.1.3', false) === PKG('0.1.3'), 'bumpJsonText: package.json version, format kept');
  const lk = JSON.parse(R.bumpJsonText(LOCK('0.1.1'), '0.1.3', true));
  check(lk.version === '0.1.3' && lk.packages[''].version === '0.1.3' && lk.packages['node_modules/x'].version === '0.1.1', 'bumpJsonText: the lock\'s two version fields, never a dependency\'s');
  check(R.bumpJsonText(PKG('0.1.1').replace(/\n/g, '\r\n'), '0.1.3', false) === PKG('0.1.3').replace(/\n/g, '\r\n'), 'bumpJsonText: CRLF kept');
  let threw = ''; try { R.bumpJsonText('{"version":"0.1.1"}', '0.1.3'); } catch (e) { threw = e.message; }
  check(/npm version 0\.1\.3/.test(threw), 'bumpJsonText: an unusual format is refused, with the npm command', threw);

  // ---- the gate: GO without --send is "would", and nothing outward ---------------------------------
  {
    const w = world(); const f = fakeFeed();
    const sha = w.commit({ 'package.json': PKG('0.1.2'), 'package-lock.json': LOCK('0.1.2'), 'docs/releases/v0.1.2.md': NOTES, 'main.js': '// fix\n' }, 'Quartz 0.1.2', true);
    const sh = fakeSh(); const say = quiet();
    const r = await G.gate({ cwd: w.work, commit: sha, result: runDir(w, sha), fetch: f.fetch, sh, say, now: () => NOW });
    const a = autonomy(say.lines);
    check(r.go && r.result === 'would' && a.result === 'would' && a.class === 'quartz-release' && a.target === 'v0.1.2@' + sha.slice(0, 7), 'GO: result would, one AUTONOMY line', { a, failed: r.checks.filter((c) => !c.ok) });
    check(sh.outward().length === 0, 'GO without --send: no gh, no node, nothing outward', sh.outward());
    check(say.lines.includes('  - A fix the user will notice.') && say.lines.some((l) => /----- docs\/releases\/v0\.1\.2\.md -----/.test(l)), 'the release notes are printed for review');
    check(say.lines.includes('  cloudtest --recipe quartz-core-public') && say.lines.some((l) => l.includes('git worktree add --detach') && l.includes(sha)), 'the cloudtest command for exactly this commit is printed');
    check(say.lines.filter((l) => /^release-gate: SKIP .*known runner limit/.test(l)).length === 4, 'each allowed SKIP is printed with its reason');
    check(say.lines.some((l) => /^release-gate: GO v0\.1\.2/.test(l)), 'a GO line');
    check(r.checks.find((c) => c.name === 'cloudtest').text.indexOf('0 FAIL') > 0, 'the summary line is quoted in the cloudtest check');

    // Without a result: refused, with the command.
    const say2 = quiet();
    const r2 = await G.gate({ cwd: w.work, commit: sha, fetch: f.fetch, sh: fakeSh(), say: say2, now: () => NOW });
    check(!r2.go && autonomy(say2.lines).result === 'refused' && /no result yet/.test(r2.checks.find((c) => c.name === 'cloudtest').text), 'no cloudtest result yet: refused, says what to run', r2.why);

    // The cloudtest result, every way it can be wrong.
    const bads = [
      ['another commit', runDir(w, sha, { base: 'f'.repeat(40) }), /tested ffffffffffff, not/],
      ['a working-tree snapshot', runDir(w, sha, { mode: 'snapshot', recipe: 'quartz-core' }), /recipe "quartz-core"/],
      ['1 FAIL', runDir(w, sha, { pass: 96, failN: 1 }), /1 file\(s\) FAIL/],
      ['a failed check', runDir(w, sha, { checksFailed: 2 }), /2 check\(s\) failed/],
      ['no summary line', runDir(w, sha, { summary: false }), /0 quartz-suite summary lines between the job markers/],
      // 1. The summary line inside the job markers.
      ['a log without job markers', runDir(w, sha, { log: 'nomarkers' }), /0 @@cloudtest-begin@@ markers/],
      ['two begin markers', runDir(w, sha, { log: 'twobegins' }), /2 @@cloudtest-begin@@ markers/],
      ['two summary lines inside the markers', runDir(w, sha, { log: 'twosummaries' }), /2 quartz-suite summary lines between the job markers/],
      ['the summary only after the exit marker', runDir(w, sha, { log: 'outside' }), /0 quartz-suite summary lines between the job markers/],
      ['exit marker 0 and run.json success, but 1 FAIL inside', runDir(w, sha, { pass: 96, failN: 1, exit: 0, conclusion: 'success', exitCode: 0 }), /1 file\(s\) FAIL/],
      ['suite.txt disagreeing with the job log', runDir(w, sha, { suiteTxt: 'quartz-suite: 101 files: 97 pass, 0 FAIL, 4 skipped | checks 9999 passed, 0 failed\n' }), /suite\.txt's summary differs/],
      ['no job log', runDir(w, sha, { log: 'missing' }), /log\.txt \(the job log\) is missing/],
      // 2. The snapshot tree.
      ['a snapshot that is not in this repository', runDir(w, sha, { snapshot: 'e'.repeat(40) }), /snapshot commit eeeeeeeeeeee is not in this repository \(fetch it: git fetch origin cloudtest\//],
      ['a snapshot with an uncommitted change in it', runDir(w, sha, { snapFiles: { 'main.js': '// edited, not committed\n' } }), /differs from the commit outside .*: main\.js .*working tree/],
      ['a snapshot with a new file outside the job folders', runDir(w, sha, { snapFiles: { 'docs/scratch.md': 'x\n' } }), /outside .*: docs\/scratch\.md/],
      ['run.json naming no snapshot', runDir(w, sha, { snapshot: '' }), /names no snapshot commit/],
      // 3. command.sh.
      ['command.sh with "; echo X=$?" appended', runDir(w, sha, { command: 'node tools/run-suite.js --out=suite-out; echo X=$?\n' }), /command\.sh is .*echo X=\$\?.*not exactly the recipe's/],
      ['command.sh with CRLF', runDir(w, sha, { command: 'node tools/run-suite.js --out=suite-out\r\n' }), /command\.sh is .*\\r\\n.*not exactly/],
      ['command.sh with a second line', runDir(w, sha, { command: 'node tools/run-suite.js --out=suite-out\nexit 0\n' }), /not exactly the recipe's/],
      ['command.sh running part of the suite', runDir(w, sha, { command: 'node tools/run-suite.js --only=argvurl --out=suite-out\n', runCommand: 'node tools/run-suite.js --only=argvurl --out=suite-out' }), /not the full suite/],
      ['a snapshot without command.sh', runDir(w, sha, { command: null }), /has no \.cloudtest-job\/command\.sh/],
      ['a RAM skip', runDir(w, sha, { pass: 96, skips: ['askclaude-e2e', 'mcp-e2e', 'smoke', 'updater-e2e', 'watch-e2e'], skipWhy: { 'watch-e2e': 'watch-e2e: not launched: 1.9 GB free RAM' } }), /SKIP watch-e2e is not a known runner limit/],
      ['a known name with another reason', runDir(w, sha, { skipWhy: { smoke: 'not launched: 1.2 GB free RAM' } }), /SKIP smoke is not a known runner limit/],
      ['a plain file, not a run folder', path.join(runDir(w, sha), 'artifacts', 'suite.txt'), /must be a cloudtest run folder/],
    ];
    for (const [label, dir, re] of bads) {
      const say3 = quiet();
      const r3 = await G.gate({ cwd: w.work, commit: sha, result: dir, fetch: f.fetch, sh: fakeSh(), say: say3, now: () => NOW });
      const t = r3.checks.find((c) => c.name === 'cloudtest').text;
      check(!r3.go && autonomy(say3.lines).result === 'refused' && re.test(t), 'cloudtest result from ' + label + ': NO-GO, says why', t);
    }
    for (const [label, o] of [
      ['command.sh without a final newline', { command: 'node tools/run-suite.js --out=suite-out' }],
      ['an exit marker of 1 (never read) with a clean summary', { exit: 1 }],
      ['a snapshot that also changes .github/workflows/ and .cloudtest/', { snapFiles: { '.github/workflows/cloudtest.yml': 'on: push\n', '.cloudtest/note.txt': 'x\n' } }],
    ]) {
      const r4 = await G.gate({ cwd: w.work, commit: sha, result: runDir(w, sha, o), fetch: f.fetch, sh: fakeSh(), say: quiet(), now: () => NOW });
      check(r4.go && r4.result === 'would', 'cloudtest result with ' + label + ': still GO', r4.checks.filter((c) => !c.ok));
    }
    const okDir = runDir(w, sha);
    check(JSON.parse(fs.readFileSync(path.join(okDir, 'run.json'), 'utf8')).exitCode === 1 && r.go, 'the run\'s exit code and conclusion are never read (a "failure" conclusion with a clean summary is GO)');
  }

  // ---- the gate: the commit and the version --------------------------------------------------------
  {
    const w = world(); const f = fakeFeed();
    const cases = [
      ['a minor bump', { 'package.json': PKG('0.2.0'), 'package-lock.json': LOCK('0.2.0'), 'docs/releases/v0.2.0.md': NOTES }, true, 'patch only', /not a patch release after 0\.1\.1/],
      ['the same version', { 'main.js': '// x\n', 'docs/releases/v0.1.1.md': NOTES }, true, 'patch only', /not newer/],
      ['a lock that disagrees', { 'package.json': PKG('0.1.2'), 'docs/releases/v0.1.2.md': NOTES }, true, 'version', /package-lock\.json says 0\.1\.1/],
      ['a commit not on master', { 'package.json': PKG('0.1.2'), 'package-lock.json': LOCK('0.1.2'), 'docs/releases/v0.1.2.md': NOTES }, false, 'on master', /not on origin\/master/],
      ['no release notes', { 'package.json': PKG('0.1.2'), 'package-lock.json': LOCK('0.1.2') }, true, 'release notes', /missing or empty/],
      ['notes with a local path', { 'package.json': PKG('0.1.2'), 'package-lock.json': LOCK('0.1.2'), 'docs/releases/v0.1.2.md': 'Fixed C:\\Users\\someone\\x\n' }, true, 'release notes', /names a local path/],
      ['notes longer than the card', { 'package.json': PKG('0.1.2'), 'package-lock.json': LOCK('0.1.2'), 'docs/releases/v0.1.2.md': 'x'.repeat(2100) }, true, 'release notes', /2100 characters/],
    ];
    for (const [label, files, push, name, re] of cases) {
      const w1 = world();
      const sha = w1.commit(files, label, push);
      const say = quiet();
      const r = await G.gate({ cwd: w1.work, commit: sha, result: runDir(w1, sha), fetch: f.fetch, sh: fakeSh(), say, now: () => NOW });
      const c = r.checks.find((x) => x.name === name);
      check(!r.go && autonomy(say.lines).result === 'refused' && c && !c.ok && re.test(c.text), label + ': NO-GO on "' + name + '"', c);
    }
    const say = quiet();
    const r = await G.gate({ cwd: w.work, commit: 'nonesuch', fetch: f.fetch, sh: fakeSh(), say, now: () => NOW });
    check(r.result === 'refused' && autonomy(say.lines).result === 'refused', 'an unknown commit: refused');
  }
  {
    // A tag that is taken; a release inside 48 h; the feed down; no latest release.
    const w = world();
    const sha = w.commit({ 'package.json': PKG('0.1.2'), 'package-lock.json': LOCK('0.1.2'), 'docs/releases/v0.1.2.md': NOTES }, 'Quartz 0.1.2', true);
    const dir = runDir(w, sha);
    const run = async (f, extra) => { const say = quiet(); const r = await G.gate(Object.assign({ cwd: w.work, commit: sha, result: dir, fetch: f.fetch, sh: fakeSh(), say, now: () => NOW }, extra || {})); return { r, a: autonomy(say.lines) }; };
    let f = fakeFeed(); f.list.push({ tag: 'v0.1.1-hotfix', at: NOW - 10 * 3600000, prerelease: true });
    let x = await run(f);
    check(!x.r.go && /published 10\.0 h ago/.test(x.r.checks.find((c) => c.name === '48 h cap').text), '48 h cap: a (pre-)release 10 h ago -> NO-GO, says when the next may go', x.r.checks.find((c) => c.name === '48 h cap'));
    f = fakeFeed(); f.down = true;
    x = await run(f);
    check(!x.r.go && x.a.result === 'refused' && x.r.checks.some((c) => c.name === 'releases feed' && !c.ok && /could not be read/.test(c.text)), 'the feed cannot be read: NO-GO');
    f = fakeFeed(); f.latest = ''; f.list = [];
    x = await run(f);
    check(!x.r.go && /first release is never autonomous/.test(x.r.checks.find((c) => c.name === 'patch only').text), 'no latest release: NO-GO (a first release is never autonomous)');
    git(w.origin, 'tag', 'v0.1.2', sha);
    x = await run(fakeFeed());
    check(!x.r.go && /v0\.1\.2 already exists/.test(x.r.checks.find((c) => c.name === 'new tag').text), 'the tag already exists on origin: NO-GO, never reused');
  }

  // ---- the gate: --send -------------------------------------------------------------------------
  {
    const w = world();
    const sha = w.commit({ 'package.json': PKG('0.1.2'), 'package-lock.json': LOCK('0.1.2'), 'docs/releases/v0.1.2.md': NOTES }, 'Quartz 0.1.2', true);
    const dir = runDir(w, sha);
    const clone = w.releaseClone();
    const draft = (o) => Object.assign({ tag_name: 'v0.1.2', draft: true, target_commitish: sha, assets: [{ name: 'Quartz-Setup.exe', size: 1000, state: 'uploaded' }] }, o || {});
    const send = async (opts) => {
      const f = fakeFeed();
      const said = { list: opts.list === undefined ? [draft()] : opts.list };
      const sh = fakeSh({
        gh: async (args) => {
          if (args[0] === 'api') return { code: 0, stdout: JSON.stringify(said.list), stderr: '' };
          if (args[0] === 'release' && args[1] === 'edit') { if (opts.editFails) return { code: 1, stdout: '', stderr: 'HTTP 422' }; if (!opts.feedStale) { f.latest = 'v0.1.2'; f.list.push({ tag: 'v0.1.2', at: NOW }); } return { code: 0, stdout: '', stderr: '' }; }
          return { code: 1, stdout: '', stderr: 'unexpected gh ' + args.join(' ') };
        },
        node: async (args) => ({ code: opts.tagFails ? 1 : 0, stdout: opts.tagFails ? 'release-tag: refused: no signing key\n' : 'Signing...\nrelease-tag: v0.1.2 signed and verified (quartz-release-signing, SHA256:abc), pushed\n', stderr: '' }),
      });
      const say = quiet();
      const r = await G.gate({ cwd: w.work, commit: sha, result: dir, fetch: f.fetch, sh, say, now: () => NOW, send: true, clone: opts.clone === undefined ? clone : opts.clone, sleep: async () => {} });
      return { r, a: autonomy(say.lines), sh, say };
    };
    let x = await send({ clone: '' });
    check(x.a.result === 'refused' && /needs --clone/.test(x.a.why) && x.sh.outward().length === 0, '--send without --clone: refused, nothing outward', x.a);
    const wt = path.join(w.dir, 'wt'); git(w.work, 'worktree', 'add', '-q', '--detach', wt, sha);
    x = await send({ clone: wt });
    check(x.a.result === 'refused' && /linked worktree/.test(x.a.why) && x.sh.outward().length === 0, '--send from a linked worktree: refused (release-tag.js needs master checked out)', x.a);
    x = await send({ list: [] });
    check(x.a.result === 'refused' && /no draft release v0\.1\.2/.test(x.a.why) && !x.sh.calls.some((c) => c[0] === 'node'), 'no draft yet: refused before any tag is signed', x.a);
    x = await send({ list: [draft({ target_commitish: 'a'.repeat(40) })] });
    check(x.a.result === 'refused' && /built from aaaaaaaaaaaa/.test(x.a.why), 'a draft built from another commit: refused', x.a);
    x = await send({ list: [draft({ assets: [] })] });
    check(x.a.result === 'refused' && /no uploaded Quartz-Setup\.exe/.test(x.a.why) && !x.sh.calls.some((c) => c[0] === 'node'), 'a draft without Quartz-Setup.exe: refused, nothing outward', x.a);
    x = await send({ list: [draft({ draft: false })] });
    check(x.a.result === 'refused' && /already published/.test(x.a.why), 'already published: refused', x.a);
    x = await send({ tagFails: true });
    check(x.a.result === 'failed' && /nothing was published/.test(x.a.why) && !x.sh.calls.some((c) => c[0] === 'gh' && c[1] === 'release'), 'release-tag.js refuses: failed, no publish attempted', x.a);
    x = await send({ editFails: true });
    check(x.a.result === 'failed' && /tag v0\.1\.2 is pushed, but publishing the draft failed/.test(x.a.why), 'publishing fails: failed, says the tag already went out', x.a);
    x = await send({ feedStale: true });
    check(x.a.result === 'failed' && /public feed names v0\.1\.1/.test(x.a.why), 'published but the feed never shows it: failed, check by hand', x.a);
    x = await send({});
    const order = x.sh.outward().map((c) => c.slice(0, 3).join(' '));
    check(x.a.result === 'done' && x.a.target === 'v0.1.2@' + sha.slice(0, 7), '--send on GO: done', x.a);
    check(order[0] === 'gh api repos/' + L.SLUG + '/releases?per_page=100' && order[1] === 'node tools/release-tag.js --push' && order[2] === 'gh release edit' && order.length === 3,
      '--send order: check the draft, sign and push the tag, publish (nothing else)', order);
    const edit = x.sh.outward()[2];
    check(edit.includes('--draft=false') && edit.includes('--latest') && edit.includes(L.SLUG) && edit.includes('v0.1.2'), 'the publish names the repo, the tag, --draft=false --latest', edit);
    check(x.sh.calls.find((c) => c[0] === 'node') && true, 'release-tag.js ran (faked) in the release clone');
  }

  // ---- autonomy mode: --send refused while it is ON (a human signs Quartz tags in v1) ----------------
  {
    const crypto = require('crypto');
    const POLICY = '{"quartz":{"release":"prepare"}}\n';
    const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
    /** An autonomy folder: mode fields over an ON default, policy text, STOP or not. */
    const modeDir = (mode, o) => {
      const d = path.join(ROOT, 'autonomy-' + (++n));
      fs.mkdirSync(d, { recursive: true });
      const opt = o || {};
      if (mode !== null) fs.writeFileSync(path.join(d, 'mode.json'), typeof mode === 'string' ? mode : JSON.stringify(Object.assign({ on: true, paused: false, length: { kind: 'open' }, policySha: sha256(POLICY) }, mode)));
      if (opt.policy !== null) fs.writeFileSync(path.join(d, 'policy.json'), opt.policy === undefined ? POLICY : opt.policy);
      if (opt.stop) fs.writeFileSync(path.join(d, 'STOP'), '');
      return d;
    };
    const on = (d) => G.autonomyOn(d, () => NOW).on;
    check(!on(path.join(ROOT, 'nonesuch')), 'autonomy: no folder -> OFF');
    check(!on(modeDir(null)), 'autonomy: no mode.json -> OFF');
    check(!on(modeDir('{not json')), 'autonomy: unreadable mode.json -> OFF');
    check(on(modeDir({})), 'autonomy: on, not paused, open, policy matches, no STOP -> ON');
    check(!on(modeDir({ on: false })), 'autonomy: on false -> OFF');
    check(!on(modeDir({ paused: true })), 'autonomy: paused -> OFF');
    check(on(modeDir({ length: { kind: 'fixed' }, endsAt: new Date(NOW + 3600000).toISOString() })), 'autonomy: a fixed length before endsAt -> ON');
    check(!on(modeDir({ length: { kind: 'fixed' }, endsAt: new Date(NOW - 1000).toISOString() })), 'autonomy: past endsAt -> OFF');
    check(!on(modeDir({ length: { kind: 'fixed' } })), 'autonomy: a fixed length with no endsAt -> OFF');
    check(!on(modeDir({}, { policy: POLICY + ' ' })), 'autonomy: policy.json changed (sha256 differs) -> OFF');
    check(!on(modeDir({}, { policy: null })), 'autonomy: no policy.json -> OFF');
    check(!on(modeDir({}, { stop: true })), 'autonomy: STOP exists -> OFF');

    const w = world();
    const sha = w.commit({ 'package.json': PKG('0.1.2'), 'package-lock.json': LOCK('0.1.2'), 'docs/releases/v0.1.2.md': NOTES }, 'Quartz 0.1.2', true);
    const dir = runDir(w, sha);
    const clone = w.releaseClone();
    for (const [label, how] of [['the option', 'opt'], ['QUARTZ_GATE_AUTONOMY_DIR', 'env']]) {
      const d = modeDir({});
      const sh = fakeSh(); const say = quiet();
      if (how === 'env') process.env.QUARTZ_GATE_AUTONOMY_DIR = d;
      try {
        const r = await G.gate(Object.assign({ cwd: w.work, commit: sha, result: dir, fetch: fakeFeed().fetch, sh, say, now: () => NOW, send: true, clone, sleep: async () => {} }, how === 'opt' ? { autonomyDir: d } : {}));
        const a = autonomy(say.lines);
        check(a.result === 'refused' && /a human signs Quartz tags/.test(a.why) && sh.outward().length === 0,
          'autonomy ON (' + label + '): --send refused, says a human signs Quartz tags, nothing outward', { a, outward: sh.outward() });
      } finally { process.env.QUARTZ_GATE_AUTONOMY_DIR = NO_AUTONOMY; }
    }
    {
      const say = quiet();
      const r = await G.gate({ cwd: w.work, commit: sha, result: dir, fetch: fakeFeed().fetch, sh: fakeSh(), say, now: () => NOW, autonomyDir: modeDir({}) });
      check(r.go && autonomy(say.lines).result === 'would', 'autonomy ON without --send: the gate still prepares and judges (would)');
    }
    {
      const say = quiet(); const sh = fakeSh();
      await G.gate({ cwd: w.work, commit: sha, result: dir, fetch: fakeFeed().fetch, sh, say, now: () => NOW, send: true, clone: '', autonomyDir: modeDir({ paused: true }) });
      check(/needs --clone/.test(autonomy(say.lines).why), 'autonomy paused: --send is not blocked by the mode (it goes on to its own checks)');
    }
  }

  // ---- rollback -----------------------------------------------------------------------------------
  /** origin with v0.1.2 (bad, two commits incl. a merge) published on top of v0.1.1. */
  function badWorld() {
    const w = world();
    w.commit({ 'main.js': '// bad one\n', 'new.js': 'added\n' }, 'feat: something');
    git(w.work, 'switch', '-q', '-c', 'side', 'HEAD~1');
    w.commit({ 'side.txt': 'side\n' }, 'side');
    git(w.work, 'switch', '-q', 'wk/release');
    git(w.work, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    const bad = w.commit({ 'package.json': PKG('0.1.2'), 'package-lock.json': LOCK('0.1.2'), 'docs/releases/v0.1.2.md': NOTES }, 'Quartz 0.1.2', true);
    git(w.work, 'tag', '-a', 'v0.1.2', '-m', 'v0.1.2', bad); git(w.work, 'push', '-q', 'origin', 'v0.1.2');
    const f = fakeFeed(); f.latest = 'v0.1.2'; f.list.push({ tag: 'v0.1.2', at: NOW - 3600000 });
    return { w, f, bad };
  }
  const ghEdit = (f, o) => async (args) => {
    if (args[0] === 'release' && args[1] === 'edit' && args[2] === 'v0.1.2' && args.includes('--draft=true')) {
      if (o && o.fails) return { code: 1, stdout: '', stderr: 'HTTP 404' };
      if (!(o && o.stale)) { f.list = f.list.filter((r) => r.tag !== 'v0.1.2'); f.latest = 'v0.1.1'; }
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected gh ' + args.join(' ') };
  };
  {
    const { w, f, bad } = badWorld();
    const sh = fakeSh(); const say = quiet();
    const r = await R.rollback({ cwd: w.work, bad: 'v0.1.2', fetch: f.fetch, sh, say, sleep: async () => {} });
    const a = autonomy(say.lines);
    check(a.result === 'would' && a.class === 'quartz-rollback' && a.target === 'v0.1.2' && r.plan.good === 'v0.1.1' && r.plan.next === '0.1.3', 'dry run: would; good release v0.1.1; the fix is 0.1.3', { a, plan: r.plan });
    check(sh.outward().length === 0 && git(w.work, 'rev-parse', 'HEAD') === bad && git(w.work, 'status', '--porcelain') === '', 'dry run: nothing outward, nothing changed here');
    check(say.lines.some((l) => l === 'release-rollback: (a) gh release edit v0.1.2 --repo ' + L.SLUG + ' --draft=true'), 'dry run prints the exact (a) command');
  }
  {
    const { w, f, bad } = badWorld();
    const sh = fakeSh({ gh: ghEdit(f) }); const say = quiet();
    const r = await R.rollback({ cwd: w.work, bad: 'v0.1.2', fetch: f.fetch, sh, say, send: true, sleep: async () => {} });
    const a = autonomy(say.lines);
    check(a.result === 'done' && sh.outward().length === 1 && f.latest === 'v0.1.1', '--send: (a) done, one gh call, the feed falls back to v0.1.1', a);
    const head = git(w.work, 'rev-parse', 'HEAD');
    const diff = git(w.work, 'diff', '--name-only', 'v0.1.1', head).split(/\r?\n/).filter(Boolean).sort();
    check(r.prepared && r.prepared.sha === head && git(w.work, 'rev-parse', 'HEAD~1') === bad, '(b) one new commit on top of v0.1.2', r.prepared);
    check(JSON.stringify(diff) === JSON.stringify(['docs/releases/v0.1.3.md', 'package-lock.json', 'package.json']), '(b) the tree is v0.1.1\'s apart from the version and the notes (the merge undone too)', diff);
    check(JSON.parse(git(w.work, 'show', 'HEAD:package.json')).version === '0.1.3' && JSON.parse(git(w.work, 'show', 'HEAD:package-lock.json')).packages[''].version === '0.1.3', '(b) version 0.1.3 in package.json and the lock');
    check(/rolls back v0\.1\.2/.test(git(w.work, 'show', 'HEAD:docs/releases/v0.1.3.md')) && /^Quartz 0\.1\.3: roll back v0\.1\.2 to v0\.1\.1$/.test(git(w.work, 'log', '-1', '--format=%s')), '(b) notes and commit subject say what was rolled back');
    check(!fs.existsSync(path.join(w.work, 'new.js')) && !fs.existsSync(path.join(w.work, 'side.txt')), '(b) files the bad release added are gone');
    check(git(w.origin, 'rev-parse', 'master') === bad, '(b) nothing pushed: origin master is still v0.1.2');

    // The gate accepts that commit as a rollback (once merged), and waives the 48 h cap.
    git(w.work, 'push', '-q', 'origin', 'HEAD:master');
    const say2 = quiet();
    const g = await G.gate({ cwd: w.work, commit: head, result: runDir(w, head), rollbackOf: 'v0.1.2', fetch: f.fetch, sh: fakeSh(), say: say2, now: () => NOW });
    const rc = g.checks.find((c) => c.name === 'rollback of v0.1.2');
    check(g.go && autonomy(say2.lines).result === 'would' && rc && rc.ok && /48 h cap is waived/.test(rc.text) && !g.checks.some((c) => c.name === '48 h cap'),
      'gate --rollback-of: GO for the prepared commit, the 48 h cap waived', g.checks.filter((c) => !c.ok));
    f.list.push({ tag: 'v0.1.2', at: NOW - 3600000 });
    const g2 = await G.gate({ cwd: w.work, commit: head, result: runDir(w, head), rollbackOf: 'v0.1.2', fetch: f.fetch, sh: fakeSh(), say: quiet(), now: () => NOW });
    check(!g2.go && /v0\.1\.2 is still published/.test(g2.checks.find((c) => c.name === 'rollback of v0.1.2').text), 'gate --rollback-of while the bad release is still published: NO-GO');
    f.list = f.list.filter((r) => r.tag !== 'v0.1.2');
    const more = w.commit({ 'main.js': '// sneaked in\n' }, 'extra', true);
    write(w.work, 'docs/releases/v0.1.3.md', 'x\n');
    const g3 = await G.gate({ cwd: w.work, commit: more, result: runDir(w, more), rollbackOf: 'v0.1.2', fetch: f.fetch, sh: fakeSh(), say: quiet(), now: () => NOW });
    check(!g3.go && /differs from v0\.1\.1 beyond the version and its notes: main\.js/.test(g3.checks.find((c) => c.name === 'rollback of v0.1.2').text), 'gate --rollback-of with a real change in it: NO-GO (no cap waiver for new code)');
  }
  {
    const { w, f, bad } = badWorld();
    let x = await R.rollback({ cwd: w.work, bad: 'v0.1.2', fetch: f.fetch, sh: fakeSh({ gh: ghEdit(f, { fails: true }) }), say: quiet(), send: true, sleep: async () => {} });
    check(x.result === 'failed' && /still offered/.test(x.why) && git(w.work, 'rev-parse', 'HEAD') === bad, '(a) gh fails: failed, says the release is still offered, nothing prepared', x.why);
    x = await R.rollback({ cwd: w.work, bad: 'v0.1.2', fetch: f.fetch, sh: fakeSh({ gh: ghEdit(f, { stale: true }) }), say: quiet(), send: true, sleep: async () => {} });
    check(x.result === 'failed' && /public feed still shows it/.test(x.why), '(a) set to draft but the feed still shows it: failed, check by hand', x.why);
  }
  {
    // HEAD past the bad release, no merges in the range: git revert keeps the later commit.
    const w = world();
    w.commit({ 'main.js': '// bad\n' }, 'feat: bad');
    const bad = w.commit({ 'package.json': PKG('0.1.2'), 'package-lock.json': LOCK('0.1.2'), 'docs/releases/v0.1.2.md': NOTES }, 'Quartz 0.1.2', true);
    git(w.work, 'tag', '-a', 'v0.1.2', '-m', 'v0.1.2', bad); git(w.work, 'push', '-q', 'origin', 'v0.1.2');
    w.commit({ 'later.txt': 'later\n' }, 'docs: later', true);
    const f = fakeFeed(); f.latest = 'v0.1.2'; f.list.push({ tag: 'v0.1.2', at: NOW - 3600000 });
    const sh = fakeSh(); const say = quiet();
    const r = await R.rollback({ cwd: w.work, bad: 'v0.1.2', fetch: f.fetch, sh, say, prepare: true, sleep: async () => {} });
    check(r.result === 'would' && sh.outward().length === 0 && r.prepared, '--prepare: (b) only, nothing outward, AUTONOMY says would', r.why);
    check(fs.readFileSync(path.join(w.work, 'main.js'), 'utf8') === '// 0.1.1\n' && fs.existsSync(path.join(w.work, 'later.txt')) && JSON.parse(fs.readFileSync(path.join(w.work, 'package.json'), 'utf8')).version === '0.1.3',
      '(b) revert mode: the bad commits undone, the later commit kept, version 0.1.3');
  }
  {
    const { w, f, bad } = badWorld();
    write(w.work, 'main.js', '// local edit\n');
    const sh = fakeSh({ gh: ghEdit(f) }); const say = quiet();
    const r = await R.rollback({ cwd: w.work, bad: 'v0.1.2', fetch: f.fetch, sh, say, send: true, sleep: async () => {} });
    check(r.result === 'done' && /NOT prepared: this checkout has uncommitted changes/.test(r.why) && f.latest === 'v0.1.1' && git(w.work, 'rev-parse', 'HEAD') === bad,
      '--send in a dirty checkout: (a) still goes (never waits), (b) not prepared, says why', r.why);
    git(w.work, 'checkout', '-q', '--', '.');
    git(w.work, 'switch', '-q', 'master'); git(w.work, 'reset', '-q', '--hard', bad);
    const r2 = await R.rollback({ cwd: w.work, bad: 'v0.1.2', fetch: f.fetch, sh: fakeSh(), say: quiet(), prepare: true, sleep: async () => {} });
    check(r2.result === 'refused' && /on master/.test(r2.why), '--prepare on master: refused (work branch only)', r2.why);
    const r3 = await R.rollback({ cwd: w.work, bad: 'v0.1.2', fetch: f.fetch, sh: fakeSh(), say: quiet() });
    check(r3.result === 'refused' && /not published/.test(r3.why), 'a release that is not published: dry run refused (nothing to withdraw)', r3.why);
    const r4 = await R.rollback({ cwd: w.work, bad: 'v9.9.9', fetch: f.fetch, sh: fakeSh(), say: quiet() });
    check(r4.result === 'refused' && /no tag v9\.9\.9/.test(r4.why), 'an unknown tag: refused');
    const r5 = await R.rollback({ cwd: w.work, bad: 'latest', fetch: f.fetch, sh: fakeSh(), say: quiet() });
    check(r5.result === 'refused' && /not a release tag/.test(r5.why), 'not a version tag: refused');
  }
}

main().catch((e) => { fail++; console.log('FAIL threw: ' + ((e && e.stack) || e)); }).then(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { console.log('(could not remove ' + ROOT + ': ' + e.message + ')'); }
  console.log('release-gate-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
