#!/usr/bin/env node
'use strict';
/*
 * release-rollback.js -- undo a bad Quartz release: (a) put it back to draft at once, so no copy
 * is offered it any more (the updater re-checks the feed before it installs anything), and (b)
 * prepare, here and locally, the patch release that undoes it: a commit that brings back the last
 * good release's tree, with the next patch version and its release notes.
 *
 *   node tools/release-rollback.js <bad tag>              print what it would do; change nothing
 *   node tools/release-rollback.js <bad tag> --prepare    (b) only: the local commit, nothing sent
 *   node tools/release-rollback.js <bad tag> --send       (a) on GitHub, then (b) locally
 *   --good=<tag>     the release to go back to (default: the newest published release before <bad>)
 *
 * (a) is `gh release edit <bad> --draft=true`, then the public feed is read back: <bad> must be
 * gone from it and no longer the latest. It never deletes or moves the tag: a published tag stays
 * where it is, and the fix is a newer release.
 *
 * (b) runs in the current checkout (a worktree on its own branch, clean, containing <bad>):
 *   - HEAD is <bad>'s commit: the index and files are reset to <good>'s tree (git read-tree), so
 *     the result is exactly <good>, whatever merges lie between;
 *   - HEAD is past <bad>: `git revert` of <good>..<bad> (refused when that range holds a merge);
 *   - package.json and package-lock.json get the next patch version after every tag of that
 *     major.minor; docs/releases/v<new>.md gets notes saying what was rolled back;
 *   - one commit "Quartz <new>: roll back <bad> to <good>". Nothing is pushed.
 * Then it prints the remaining steps: merge to master, the installer workflow, cloudtest, and
 * tools/release-gate.js <commit> --rollback-of=<bad> (which waives the 48 h cap for this tree only).
 *
 * Autonomy mode (the contract's one formula, release-lib.js modeState): --send is refused while
 * PAUSED, and while ON when mode.json's holds name quartz-release or quartz-rollback. While ON
 * without such a hold it goes ahead: withdrawing a bad release signs nothing.
 *
 * The line callers read, for (a):
 *   AUTONOMY: {"class":"quartz-rollback","target":"<bad>","result":"done|failed|refused|would","why":...}
 */
const fs = require('fs');
const path = require('path');
const L = require('./release-lib');

/** package.json / package-lock.json text with the version changed; the formatting must survive. */
function bumpJsonText(text, version, isLock) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const j = JSON.parse(text);
  if (JSON.stringify(j, null, 2) + '\n' !== text.replace(/\r\n/g, '\n')) throw new Error('is not formatted the way npm writes it; bump it with npm version ' + version + ' --no-git-tag-version');
  j.version = version;
  if (isLock && j.packages && j.packages['']) j.packages[''].version = version;
  return (JSON.stringify(j, null, 2) + '\n').replace(/\n/g, eol);
}

function notesText(version, bad, good) {
  return '# Quartz ' + version + '\n\n' +
    'This release rolls back ' + bad + '. Quartz ' + version + ' is the same as ' + good + ' apart from its version number.\n\n' +
    bad + ' was withdrawn after it was published. If you installed it, update to ' + version + ' to get back to a known good version.\n';
}

/**
 * o: { cwd, bad, good?, send?, prepare?, fetch?, sh?, sleep?, say? }
 * Resolves { result, why, plan, prepared?, autonomy }.
 */
async function rollback(o) {
  const sh = o.sh || L.run;
  const say = o.say || ((l) => console.log(l));
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cwd = o.cwd || process.cwd();
  const git = (args) => sh('git', args, { cwd });
  const bad = String(o.bad || '');
  const finish = (result, why, extra) => {
    const r = Object.assign({ result, why }, extra || {});
    r.autonomy = L.autonomyLine('quartz-rollback', bad || '?', result, why);
    say(r.autonomy);
    return r;
  };
  const refuse = (why) => { say('release-rollback: refused: ' + why); return finish('refused', why); };
  if (!L.parseVersion(bad)) return refuse('"' + bad + '" is not a release tag (vX.Y.Z)');

  // The studio's autonomy mode (release-lib.js modeState): --send is refused while PAUSED, and
  // while ON when the owner holds quartz-release or quartz-rollback. --prepare and the dry run are local.
  if (o.send) {
    const dir = L.autonomyDir(o.autonomyDir);
    const state = L.modeState(dir, o.now ? o.now() : Date.now());
    if (state === 'PAUSED') return refuse('paused: autonomy mode is PAUSED, which refuses every outward action; nothing was sent');
    const held = state === 'ON' ? ['quartz-release', 'quartz-rollback'].filter((c) => L.modeHolds(dir, c)) : [];
    if (held.length) return refuse('held: autonomy mode is ON and the owner holds ' + held.join(' and ') + '; nothing was sent');
  }

  await git(['fetch', '--quiet', 'origin', '+refs/heads/master:refs/remotes/origin/master', 'refs/tags/v*:refs/tags/v*']);
  const badSha = (await git(['rev-parse', '--verify', '--quiet', 'refs/tags/' + bad + '^{commit}'])).stdout.trim();
  if (!badSha) return refuse('there is no tag ' + bad + ' here or on origin');

  let feed;
  try { feed = await L.readFeed(o.fetch); } catch (e) { return refuse(e.message + '; nothing was changed'); }
  const published = feed.list.some((r) => r.tag_name === bad);
  const isLatest = feed.latest && feed.latest.tag_name === bad;

  // The good release: --good, else the newest published release tag that <bad> contains.
  let good = String(o.good || '');
  if (!good) {
    const merged = (await git(['tag', '--list', 'v*', '--sort=-v:refname', '--merged', badSha])).stdout.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && x !== bad);
    good = merged.find((t) => feed.list.some((r) => r.tag_name === t)) || '';
  }
  if (!good) return refuse('no published release before ' + bad + ' to go back to (pass --good=<tag>)');
  const goodSha = (await git(['rev-parse', '--verify', '--quiet', 'refs/tags/' + good + '^{commit}'])).stdout.trim();
  if (!goodSha) return refuse('there is no tag ' + good);
  if ((await git(['merge-base', '--is-ancestor', goodSha, badSha])).code !== 0) return refuse(good + ' is not an ancestor of ' + bad);

  // The next patch version: past every tag of this major.minor (a withdrawn one included).
  const b = L.parseVersion(bad);
  const same = (await git(['tag', '--list', 'v' + b.major + '.' + b.minor + '.*'])).stdout.split(/\r?\n/).map((x) => L.parseVersion(x)).filter(Boolean);
  const next = b.major + '.' + b.minor + '.' + (Math.max.apply(null, same.map((v) => v.patch).concat([b.patch])) + 1);

  const plan = {
    bad, badSha, good, goodSha, next,
    a: published ? ['gh', 'release', 'edit', bad, '--repo', L.SLUG, '--draft=true'] : null,
  };
  say('release-rollback: ' + bad + ' (' + badSha.slice(0, 7) + ') is ' + (published ? 'published' + (isLatest ? ' and the latest release' : '') : 'not published (already a draft, or never published)') + '; good release ' + good + ' (' + goodSha.slice(0, 7) + '); the fix will be ' + 'v' + next);
  say('release-rollback: (a) ' + (plan.a ? plan.a.join(' ') : 'nothing to do: ' + bad + ' is not in the public feed'));
  say('release-rollback: (b) here (' + cwd + '): a commit with ' + good + '\'s tree, version ' + next + ', ' + 'docs/releases/v' + next + '.md');

  // (b) can be checked before anything is sent.
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
  const why = [];
  if (!branch) why.push('this checkout is not on a branch');
  else if (branch === 'master') why.push('this checkout is on master; prepare the fix on a work branch and merge it');
  if (dirty) why.push('this checkout has uncommitted changes');
  if ((await git(['merge-base', '--is-ancestor', badSha, 'HEAD'])).code !== 0) why.push('this checkout does not contain ' + bad + ' (start from origin/master)');
  let mode = head === badSha ? 'tree' : 'revert';
  if (!why.length && mode === 'revert') {
    const merges = (await git(['rev-list', '--merges', goodSha + '..' + badSha])).stdout.trim();
    if (merges) why.push('HEAD is past ' + bad + ' and ' + good + '..' + bad + ' holds merge commits, which git revert cannot undo in one go; start a branch at ' + bad + '\'s commit instead');
  }
  if (why.length) {
    say('release-rollback: (b) cannot be prepared here: ' + why.join('; '));
    // (a) must never wait for a tidy checkout: --send still withdraws the release.
    if (o.prepare && !o.send) return refuse('(b) cannot be prepared here: ' + why.join('; '));
  }

  if (!o.send && !o.prepare) {
    say('release-rollback: nothing done. --send does (a) and (b); --prepare does (b) only.');
    return finish(plan.a ? 'would' : 'refused', plan.a ? 'would put ' + bad + ' back to draft and prepare v' + next + ' from ' + good : bad + ' is not published', { plan });
  }

  // (a): outward.
  let aResult = 'skipped';
  if (o.send) {
    if (!plan.a) aResult = 'already';
    else {
      const r = await sh(plan.a[0], plan.a.slice(1), { cwd });
      if (r.code !== 0) return finish('failed', 'gh release edit ' + bad + ' --draft=true failed: ' + String(r.stderr).trim().split(/\r?\n/).pop() + '; ' + bad + ' is still offered', { plan });
      let gone = false, seen = '';
      for (let i = 0; i < 4 && !gone; i++) {
        try { const f = await L.readFeed(o.fetch); seen = f.latest ? f.latest.tag_name : '(none)'; gone = !f.list.some((x) => x.tag_name === bad) && seen !== bad; } catch (e) { seen = '(' + e.message + ')'; }
        if (!gone) await sleep(5000);
      }
      if (!gone) return finish('failed', bad + ' was set to draft, but the public feed still shows it (latest: ' + seen + '); check by hand', { plan });
      aResult = 'done';
      say('release-rollback: (a) ' + bad + ' is a draft again; the public feed now names ' + seen + ' as the latest release');
    }
  }

  // (b): local only.
  if (why.length) {
    return finish(aResult === 'done' ? 'done' : 'refused', (aResult === 'done' ? bad + ' is a draft again' : bad + ' was not published, nothing sent') + '; v' + next + ' NOT prepared: ' + why.join('; '), { plan });
  }
  const fail =(what) => (o.send ? finish(aResult === 'done' ? 'done' : 'refused', (aResult === 'done' ? bad + ' is a draft again; ' : '') + 'preparing v' + next + ' failed: ' + what, { plan }) : refuse('preparing v' + next + ' failed: ' + what));
  if (mode === 'tree') {
    const r = await git(['read-tree', '-u', '--reset', goodSha]);
    if (r.code !== 0) { await git(['reset', '--hard', '-q', head]); return fail('git read-tree: ' + r.stderr.trim()); }
  } else {
    const r = await git(['revert', '--no-edit', '--no-commit', goodSha + '..' + badSha]);
    if (r.code !== 0) { await git(['revert', '--abort']); return fail('git revert: ' + r.stderr.trim().split(/\r?\n/)[0]); }
  }
  try {
    for (const [file, lock] of [['package.json', false], ['package-lock.json', true]]) {
      const p = path.join(cwd, file);
      fs.writeFileSync(p, bumpJsonText(fs.readFileSync(p, 'utf8'), next, lock));
    }
    const np = path.join(cwd, 'docs', 'releases', 'v' + next + '.md');
    fs.mkdirSync(path.dirname(np), { recursive: true });
    fs.writeFileSync(np, notesText(next, bad, good));
  } catch (e) { await git(['reset', '--hard', '-q', head]); return fail(e.message); }
  const add = await git(['add', '-A', '--', 'package.json', 'package-lock.json', 'docs/releases']);
  const cm = add.code === 0 ? await git(['commit', '-q', '-m', 'Quartz ' + next + ': roll back ' + bad + ' to ' + good, '-m', 'Brings back the tree of ' + good + ' (' + goodSha.slice(0, 7) + ') with the next patch version, so every copy that installed ' + bad + ' is offered a known good release.']) : add;
  if (cm.code !== 0) { await git(['reset', '--hard', '-q', head]); return fail('git commit: ' + String(cm.stderr || cm.stdout).trim().split(/\r?\n/).pop()); }
  const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const diff = (await git(['diff', '--name-only', goodSha, sha])).stdout.split(/\r?\n/).filter(Boolean);
  say('release-rollback: (b) prepared v' + next + ' at ' + sha.slice(0, 7) + ' on ' + branch + ' (differs from ' + good + ' in: ' + (diff.join(', ') || 'nothing') + '). Nothing pushed.');
  say('release-rollback: next (each outward step needs its OK):');
  say('  1. merge ' + branch + ' into master and push master');
  say('  2. Actions > installer > Run workflow (draft on) on ' + sha.slice(0, 7));
  say('  3. cloudtest --recipe quartz-core-public from a checkout at ' + sha.slice(0, 7));
  say('  4. node tools/release-gate.js ' + sha + ' --result=<run folder> --rollback-of=' + bad + ' [--send --clone=<dir>]');
  const prepared = { sha, version: next, branch, diff };
  if (o.send) return finish(aResult === 'done' ? 'done' : 'refused', aResult === 'done' ? bad + ' is a draft again; v' + next + ' prepared at ' + sha.slice(0, 7) : bad + ' was not published, nothing sent; v' + next + ' prepared at ' + sha.slice(0, 7), { plan, prepared });
  return finish('would', '(a) not sent (--prepare); v' + next + ' prepared at ' + sha.slice(0, 7), { plan, prepared });
}

module.exports = { rollback, bumpJsonText, notesText };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (name) => { const a = argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : ''; };
  const bad = argv.find((x) => !x.startsWith('--'));
  if (!bad) {
    console.log('usage: node tools/release-rollback.js <bad tag> [--good=<tag>] [--prepare | --send]');
    console.log(L.autonomyLine('quartz-rollback', '?', 'refused', 'no tag given'));
    process.exit(2);
  }
  rollback({ bad, good: arg('good') || '', send: argv.includes('--send'), prepare: argv.includes('--prepare') })
    .then((r) => process.exit(r.result === 'done' || r.result === 'would' ? 0 : 1))
    .catch((e) => { console.log('release-rollback: threw: ' + ((e && e.stack) || e)); console.log(L.autonomyLine('quartz-rollback', bad, 'failed', 'the tool threw: ' + ((e && e.message) || e))); process.exit(1); });
}
