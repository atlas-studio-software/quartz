// childreap-harness.js -- childreap.js: the tree selection on made-up snapshots, the child.kill()
// fallback, the refusal to track a process that is not our own child, and (Windows only) three
// live trees of node processes this harness starts itself: killTree(), the reap after the child
// exits on its own, and reapAll(). Pure node, no Electron. Ends with `childreap: N passed, M failed`.
//
// Safety: the live checks only ever end processes this harness spawned. They go through the same
// verification as the browser (root = our direct child; descendants proven by handle), and the
// grandchildren exit on their own after 20 s, so a failed run leaves nothing behind for long.
'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const childreap = require('./childreap');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) passed++; else failed++;
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail !== undefined ? '  ' + String(detail).slice(0, 400) : ''));
}
const pids = (list) => list.map((r) => r.pid);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------------------------------------------------------------- planTree, pure */

const IMAGES = ['claude.exe', 'git.exe', 'conhost.exe'];
const row = (pid, ppid, image, created, extra) => Object.assign({ pid, ppid, image, path: 'C:\\x\\' + image, created }, extra || {});
const ROOT = { pid: 100, created: 1000 };

{
  // Multi-level git launcher: claude -> git (cmd launcher) -> git (the real one), plus conhost.
  const rows = [
    row(4, 0, 'System', 1),
    row(100, 50, 'claude.exe', 1000),
    row(101, 100, 'git.exe', 1100, { path: 'C:\\Git\\cmd\\git.exe' }),
    row(102, 101, 'git.exe', 1101, { path: 'C:\\Git\\mingw64\\bin\\git.exe' }),
    row(103, 100, 'conhost.exe', 1001),
    row(104, 102, 'GIT.EXE', 1200, { path: 'C:\\Git\\mingw64\\bin\\Git.exe' }),
  ];
  const p = childreap.planTree(rows, ROOT, IMAGES);
  ok('launcher: git launcher, its git child and conhost are all in the tree', same(pids(p.kill).sort(), [101, 102, 103, 104]), JSON.stringify(pids(p.kill)));
  ok('launcher: parents come before their children', pids(p.kill).indexOf(101) < pids(p.kill).indexOf(102) && pids(p.kill).indexOf(102) < pids(p.kill).indexOf(104));
  ok('launcher: the root itself is not in the kill list (the caller ends it through its handle)', !pids(p.kill).includes(100));
  ok('launcher: nothing skipped', p.skipped.length === 0, JSON.stringify(p.skipped));
}

{
  // PID reuse: a process whose ppid matches the root but which started BEFORE the root.
  const rows = [row(200, 100, 'git.exe', 900), row(201, 200, 'git.exe', 1500), row(202, 100, 'git.exe', 1000)];
  const p = childreap.planTree(rows, ROOT, IMAGES);
  ok('pid reuse: an older process with a matching ppid is not taken', !pids(p.kill).includes(200));
  ok('pid reuse: ... nor anything under it', !pids(p.kill).includes(201));
  ok('pid reuse: same start time as the parent is not "later" either', !pids(p.kill).includes(202));
  const why = (p.skipped.find((s) => s.pid === 200) || {}).why || '';
  ok('pid reuse: skipped with a reason in words', /earlier process/.test(why), why);
}

{
  // Unexpected image: skipped, and its subtree is never walked even if it holds expected names.
  const rows = [row(300, 100, 'bash.exe', 1100), row(301, 300, 'git.exe', 1200), row(302, 100, 'git.exe', 1100)];
  const p = childreap.planTree(rows, ROOT, IMAGES);
  ok('unexpected: bash.exe is skipped', p.skipped.some((s) => s.pid === 300 && /unexpected program/.test(s.why)), JSON.stringify(p.skipped));
  ok('unexpected: the git.exe under it is neither killed nor even looked at', !pids(p.kill).includes(301) && !p.skipped.some((s) => s.pid === 301));
  ok('unexpected: a sibling git.exe is still taken', same(pids(p.kill), [302]));
}

{
  // Unrelated processes, including ones with expected names, are untouched.
  const rows = [
    row(10, 4, 'explorer.exe', 10), row(11, 10, 'git.exe', 5000), row(12, 10, 'claude.exe', 5000),
    row(13, 12, 'git.exe', 6000), row(100, 50, 'claude.exe', 1000), row(14, 100, 'git.exe', 1100),
  ];
  const p = childreap.planTree(rows, ROOT, IMAGES);
  ok('unrelated: only the root\'s own child is taken', same(pids(p.kill), [14]), JSON.stringify(pids(p.kill)));
  ok('unrelated: nothing outside the tree even appears as skipped', p.skipped.length === 0, JSON.stringify(p.skipped));
}

{
  // A ppid cycle in the data (the root's row claiming a descendant as parent; two rows naming
  // each other) must not loop, and the root must never be listed.
  const rows = [
    row(100, 102, 'claude.exe', 4000),
    row(101, 100, 'git.exe', 1100), row(102, 101, 'git.exe', 1200),
    row(500, 501, 'git.exe', 1300), row(501, 500, 'git.exe', 1400),
  ];
  const t0 = Date.now();
  const p = childreap.planTree(rows, ROOT, IMAGES);
  ok('cycle: the walk ends', Date.now() - t0 < 1000);
  ok('cycle: the root is never in its own kill list', !pids(p.kill).includes(100));
  ok('cycle: the real descendants are still found', same(pids(p.kill), [101, 102]), JSON.stringify(pids(p.kill)));
  ok('cycle: the unrelated loop is untouched', !pids(p.kill).includes(500) && !pids(p.kill).includes(501));
}

{
  // The handle checks: file name vs snapshot name, unreadable fields, parent read from the process.
  const rows = [
    row(600, 100, 'git.exe', 1100, { path: 'C:\\x\\evil.exe' }),
    row(601, 100, 'git.exe', 1100, { path: 'C:\\x\\claude.exe' }),
    row(602, 100, 'git.exe', 1100, { path: '' }),
    row(603, 100, 'git.exe', null),
    row(604, 100, 'git.exe', 1100, { why: 'it could not be opened (Windows error 5)' }),
    row(605, 100, 'git.exe', 1100, { parentFromHandle: 77 }),
    row(606, 100, 'git.exe', 1100, { parentFromHandle: 100 }),
    row(607, 100, 'git.exe', 1100n),
  ];
  const p = childreap.planTree(rows, { pid: 100, created: 1000n }, IMAGES);
  const why = (pid) => (p.skipped.find((s) => s.pid === pid) || {}).why || '';
  ok('handle: a file that is not an expected program is skipped', /evil\.exe/.test(why(600)), why(600));
  ok('handle: snapshot name and file name must agree', /calls it git\.exe but it runs claude\.exe/.test(why(601)), why(601));
  ok('handle: an unreadable path is skipped', /could not be read/.test(why(602)), why(602));
  ok('handle: an unreadable start time is skipped', /start time/.test(why(603)), why(603));
  ok('handle: a probe failure keeps its own reason', /Windows error 5/.test(why(604)), why(604));
  ok('handle: a parent read from the process that disagrees is skipped', /reused/.test(why(605)), why(605));
  ok('handle: matching parent and BigInt / Number times mix', same(pids(p.kill), [606, 607]), JSON.stringify(pids(p.kill)));
  const strict = childreap.planTree([row(608, 100, 'git.exe', 1100)], ROOT, IMAGES, { requireHandleParent: true });
  ok('handle: requireHandleParent refuses a row without one', strict.kill.length === 0 && /parent ID could not be read/.test((strict.skipped[0] || {}).why), JSON.stringify(strict));
}

{
  // known (a later pass): members proven earlier are walked even when gone from the snapshot.
  const rows = [row(700, 650, 'git.exe', 1300), row(701, 100, 'git.exe', 1100)];
  const p = childreap.planTree(rows, ROOT, IMAGES, { known: [{ pid: 650, created: 1200 }] });
  ok('known: a child of an earlier-pass member is found', pids(p.kill).includes(700));
  ok('known: the earlier member itself is not listed again', !pids(p.kill).includes(650));
  // probe: only rows that passed the name check are probed.
  const probed = [];
  const q = childreap.planTree([{ pid: 800, ppid: 100, image: 'git.exe' }, { pid: 801, ppid: 100, image: 'cmd.exe' }], ROOT, IMAGES,
    { probe: (r) => { probed.push(r.pid); return { path: 'C:\\x\\git.exe', created: 1100, parentFromHandle: 100 }; } });
  ok('probe: only an expected-name child is opened', same(probed, [800]), JSON.stringify(probed));
  ok('probe: its answers are used', same(pids(q.kill), [800]));
  const thrower = childreap.planTree([{ pid: 802, ppid: 100, image: 'git.exe' }], ROOT, IMAGES, { probe: () => { throw new Error('boom'); } });
  ok('probe: a probe that throws skips the row, never throws out', thrower.kill.length === 0 && /boom/.test(thrower.skipped[0].why));
  // max: a runaway tree stops.
  const big = [];
  for (let i = 0; i < 20; i++) big.push(row(900 + i, i ? 900 + i - 1 : 100, 'git.exe', 2000 + i));
  const m = childreap.planTree(big, ROOT, IMAGES, { max: 5 });
  ok('max: the walk stops at the cap and says so', m.kill.length === 4 && /larger than 5/.test(m.skipped[0].why), JSON.stringify(m.skipped));
  ok('bad root: no kill list', childreap.planTree(big, { pid: 0, created: 1 }, IMAGES).kill.length === 0);
  // The tracker hands its images over as a Set; an array and a Set must mean the same thing.
  const asSet = childreap.planTree([row(950, 100, 'git.exe', 1100)], ROOT, new Set(['git.exe']));
  ok('images: a Set works like an array', same(pids(asSet.kill), [950]), JSON.stringify(asSet));
}

/* --------------------------------------------------------- describe, fallback, refusal */

{
  const line = childreap.describe({ label: 'notes helper', why: 'timeout', killed: [{ pid: 1, image: 'claude.exe' }, { pid: 2, image: 'git.exe' }], skipped: [{ pid: 3, image: 'bash.exe', why: 'an unexpected program' }], error: '' });
  ok('describe: one plain line', line === 'notes helper, timeout: ended claude.exe 1, git.exe 2; left alone bash.exe 3 (an unexpected program)', line);
  ok('describe: nothing to say', childreap.describe({ label: 'x', why: 'exited', killed: [], skipped: [] }) === 'x, exited: nothing left running');
}

function fakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid;
  c.kills = 0;
  c.kill = () => { c.kills++; return true; };
  return c;
}

const lines = [];
childreap.setLog((l) => lines.push(l));
{
  const before = childreap.trackedCount();
  const fake = fakeChild(undefined);
  const t = childreap.track(fake, { images: ['claude.exe'], label: 'fake' });
  ok('fallback: a child with no pid is not tracked', t.tracked === false && /no process ID/.test(t.reason), t.reason);
  const s = t.killTree('timeout');
  ok('fallback: killTree is child.kill(), once', fake.kills === 1);
  ok('fallback: and the summary says so', /child\.kill\(\)/.test(s.fallback), s.fallback);
  childreap.killTree(fake, 'superseded');
  ok('fallback: module killTree(child) finds the same tracker', fake.kills === 2);
  const never = fakeChild(undefined);
  childreap.killTree(never, 'x');
  ok('fallback: an untracked child still gets child.kill()', never.kills === 1);
  ok('fallback: nothing registered for reapAll', childreap.trackedCount() === before);
  ok('fallback: track(null) does not throw', childreap.track(null).tracked === false);

  childreap.__test.use(null, 'koffi is missing (test)');
  const nok = fakeChild(4242);
  const tn = childreap.track(nok, { images: ['claude.exe'] });
  ok('no koffi: falls back with the reason', tn.tracked === false && tn.reason === 'koffi is missing (test)', tn.reason);
  ok('no koffi: said once in the log', lines.some((l) => /child\.kill\(\) only.*koffi is missing/.test(l)), JSON.stringify(lines));
  tn.killTree('quit');
  ok('no koffi: killTree is child.kill()', nok.kills === 1);
  childreap.__test.use(undefined);
}

if (process.platform === 'win32' && childreap.reason() === '') {
  // A pid that is a real process but NOT our child (our own parent, our own process): refused,
  // and killTree only calls the fake's kill(). Nothing real is ended.
  const parentFake = fakeChild(process.ppid);
  const tp = childreap.track(parentFake, { images: ['bash.exe', 'node.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'claude.exe', 'sh.exe'] });
  ok('refuse: our own parent process is not tracked', tp.tracked === false && /not a child of this process/.test(tp.reason), tp.reason);
  ok('refuse: and the log says so in words', lines.some((l) => l.includes('(process ' + process.ppid + ') is not tracked, so only child.kill() will end it')), JSON.stringify(lines.slice(-2)));
  tp.killTree('test');
  let parentAlive = true;
  try { process.kill(process.ppid, 0); } catch { parentAlive = false; }
  ok('refuse: ... and it is still running', parentAlive);
  const selfFake = fakeChild(process.pid);
  const ts = childreap.track(selfFake, { images: ['node.exe'] });
  ok('refuse: this process itself is not tracked', ts.tracked === false && /not a child of this process/.test(ts.reason), ts.reason);
}

/* -------------------------------------------------------------------- live (Windows) */

function childScript(exitAfterMs, grandchildMs) {
  const grandchild = 'setTimeout(() => {}, ' + (grandchildMs || 20000) + ')';
  return "const { spawn } = require('child_process');"
    + 'const g = spawn(process.execPath, ["-e", ' + JSON.stringify(grandchild) + '], { detached: true, stdio: "ignore", windowsHide: true });'
    + 'g.unref(); process.stdout.write(String(g.pid) + "\\n");'
    + (exitAfterMs ? 'setTimeout(() => process.exit(0), ' + exitAfterMs + ');' : 'setTimeout(() => {}, 20000);');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Spawn a node child that spawns a detached node grandchild; resolves { child, tracker, gc }. */
function startTree(label, exitAfterMs, grandchildMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', childScript(exitAfterMs, grandchildMs)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tracker = childreap.track(child, { images: ['node.exe'], label });
    let buf = '';
    const t = setTimeout(() => resolve({ child, tracker, gc: 0 }), 10000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/(\d+)\n/);
      if (m) { clearTimeout(t); resolve({ child, tracker, gc: Number(m[1]) }); }
    });
  });
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function live() {
  if (process.platform !== 'win32') { console.log('SKIP live checks: not Windows'); return; }
  if (childreap.reason()) { console.log('SKIP live checks: ' + childreap.reason()); return; }
  const base = childreap.trackedCount();

  // 1. killTree(): the root and its detached grandchild, both ended, nothing else.
  {
    const { child, tracker, gc } = await startTree('live kill', 0);
    ok('live kill: the child is tracked', tracker.tracked === true, tracker.reason);
    ok('live kill: the grandchild started and is running', gc > 0 && alive(gc), String(gc));
    const s = tracker.killTree('test');
    ok('live kill: exactly the child and the grandchild were ended', same(pids(s.killed).sort((a, b) => a - b), [child.pid, gc].sort((a, b) => a - b)), childreap.describe(s));
    ok('live kill: no error', !s.error, s.error);
    await settle(200);
    ok('live kill: the grandchild is gone', !alive(gc));
    ok('live kill: the child is gone', !alive(child.pid));
    ok('live kill: a second killTree is a no-op', tracker.killTree('again').killed.length === 0);
  }

  // 2. The child exits on its own; the grandchild it left running is reaped (the bug's shape).
  {
    const { child, tracker, gc } = await startTree('live exit', 300);
    ok('live exit: tracked, grandchild running', tracker.tracked === true && gc > 0 && alive(gc), tracker.reason + ' ' + gc);
    await new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', () => setImmediate(r)); });
    await settle(200);
    ok('live exit: the grandchild was ended after the child exited', !alive(gc));
    ok('live exit: the log names it', lines.some((l) => l.includes('live exit, exited: ended node.exe ' + gc)), JSON.stringify(lines));
  }

  // 3. reapAll(): what the quit path calls.
  {
    const { child, tracker, gc } = await startTree('live quit', 0);
    ok('live quit: tracked, grandchild running', tracker.tracked === true && gc > 0 && alive(gc));
    const all = childreap.reapAll('quit');
    ok('live quit: both ended', pids(all.killed).includes(child.pid) && pids(all.killed).includes(gc), all.line);
    ok('live quit: nothing but those two', all.killed.length === 2, all.line);
    ok('live quit: one plain line', /^1 child process tree\(s\), quit: ended node\.exe/.test(all.line), all.line);
    await settle(200);
    ok('live quit: both gone', !alive(gc) && !alive(child.pid));
  }
  // 4. The snapshot fails: the root is still ended (at least what child.kill() did), and the
  //    grandchild, which could not be checked, is left alone (it exits by itself in 3 s).
  {
    const { child, tracker, gc } = await startTree('live nosnap', 0, 3000);
    const w = childreap.__test.api();
    const real = w.snapshot;
    w.snapshot = () => null;
    let s;
    try { s = tracker.killTree('test'); } finally { w.snapshot = real; }
    ok('live nosnap: the root was still ended', same(pids(s.killed), [child.pid]), childreap.describe(s));
    ok('live nosnap: the error says the rest was not checked', /not checked/.test(s.error), s.error);
    ok('live nosnap: the unchecked grandchild was not touched', gc > 0 && alive(gc));
  }
  ok('live: every tree was released', childreap.trackedCount() === base, String(childreap.trackedCount()));
}

live().catch((err) => ok('live checks ran without throwing', false, err && err.stack)).finally(() => {
  console.log('childreap: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
});
