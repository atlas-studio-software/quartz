// tests/newlook-preview-test.js - pure-node test for tools/newlook-preview.js (no Electron, no
// processes, no real folders: plan() and seed() take everything as input).
// One summary line: "newlook-preview: N passed, M failed".
'use strict';
const path = require('path');
const P = require('../tools/newlook-preview');
const LS = require('../looksync/look-sync');

let pass = 0, fail = 0;
function check(ok, what, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + what + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}

const HOME = 'C:\\Users\\someone';
const TMP = HOME + '\\AppData\\Local\\Temp';
const APPDATA = HOME + '\\AppData\\Roaming';
const WT = 'D:\\work\\newlook-preview';
const all = () => true;
const base = (o) => Object.assign({ repoDir: WT, env: {}, tmpdir: TMP, home: HOME, appdata: APPDATA, platform: 'win32', exists: all }, o || {});

/* ---- the command ---- */
{
  const p = P.plan(base());
  check(p.ok, 'a worktree with its own Quartz.exe: ok', p.refusal);
  check(p.exe === WT + '\\node_modules\\electron\\dist\\Quartz.exe', "the exe is the checkout's own Quartz.exe", p.exe);
  check(JSON.stringify(p.args) === JSON.stringify([WT, '--test-profile', '--profile-name=newlook-preview']), 'args: the checkout, --test-profile, --profile-name=newlook-preview', p.args);
  check(!p.args.some((a) => /remote-debugging|--offscreen|--measure/.test(a)), 'no DevTools port, no off-screen, no measuring switch');
  check(p.profileDir === TMP + '\\browser-test-profile-newlook-preview', "the profile is main.js's test folder in %TEMP%", p.profileDir);
  check(p.syncDir === p.profileDir + '\\look-sync' && p.realSyncDir === APPDATA + '\\look-sync', 'Look Sync: the test folder (looksync-main.js syncDir) vs the real one read only', [p.syncDir, p.realSyncDir]);
  check(P.plan(base({ name: 'a b/c' })).name === 'abc' && P.plan(base({ name: 'a b/c' })).profileDir.endsWith('browser-test-profile-abc'), 'the name is cleaned the way main.js cleans it');
}

/* ---- refusals ---- */
{
  const live = P.plan(base({ repoDir: HOME + '\\browser' }));
  check(!live.ok && /live clone/.test(live.refusal), 'refuses the live clone (its Electron is never launched)', live.refusal);
  const live2 = P.plan(base({ repoDir: HOME.toUpperCase() + '\\Browser\\' }));
  check(!live2.ok, 'refuses the live clone in any case and with a trailing slash');
  const nomod = P.plan(base({ exists: (f) => !/Quartz\.exe$/.test(f) }));
  check(!nomod.ok && /npm ci/.test(nomod.refusal), 'no Quartz.exe: refuses and says to run npm ci', nomod.refusal);
  const notrepo = P.plan(base({ exists: (f) => !/package\.json$/.test(f) }));
  check(!notrepo.ok && /not a Quartz checkout/.test(notrepo.refusal), 'not a checkout: refuses');
  check(!P.plan(base({ platform: 'linux' })).ok, 'not Windows: refuses');
  const clash = P.plan(base({ tmpdir: APPDATA, name: 'x' }));
  check(clash.ok, 'a TEMP that is elsewhere still gets its own folder');
  const evil = P.plan(base({ tmpdir: path.dirname(APPDATA + '\\look-sync'), name: '' }));
  check(!evil.ok && /empty/.test(evil.refusal), 'an empty name after cleaning: refuses', evil.refusal);
}

/* ---- the environment: every test seam removed ---- */
{
  const env = P.cleanEnv({ PATH: 'p', TEMP: 't', QUARTZ_AUTOPAUSE_PORT: '8787', QUARTZ_TEST_CDP_DEFAULT_PORT: '9219', quartz_test_default_script: 'x.ps1',
    LOOK_SYNC_DIR: 'real', TOPROW_PIPE: 'pipe', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require x', SMOKE_PORT: '9222', CDP_PORT: '9341' });
  check(JSON.stringify(Object.keys(env).sort()) === JSON.stringify(['PATH', 'TEMP']), 'only PATH and TEMP survive of that set', Object.keys(env));
}

/* ---- the picture ---- */
const REAL = APPDATA + '\\look-sync', SYNC = TMP + '\\browser-test-profile-newlook-preview\\look-sync';
const rec = { rev: 7, ok: true, id: 'w1', type: 'image', title: 'Hills', file: 'C:\\pics\\hills.jpg', still: REAL + '\\stills\\wall-7.jpg', stillSize: [1920, 1080], guard: { dark: { alpha: 0.4, dim: 0.3, blurPx: 0 } } };
const stills = [{ name: 'wall-6.jpg', mtimeMs: 100 }, { name: 'wall-7.jpg', mtimeMs: 200 }, { name: 'notes.txt', mtimeMs: 900 }];
{
  const s = P.seed({ schema: 1, rev: 9, look: { theme: { v: 'dark', rev: 1 } }, desktop: rec }, stills, null, REAL, SYNC);
  check(s.ok && s.copyFrom === REAL + '\\stills\\wall-7.jpg' && s.copyTo === SYNC + '\\stills\\wall-7.jpg', "copies the still the record names into the test stills folder", s);
  check(s.doc.desktop.still === s.copyTo && s.doc.desktop.rev === 7 && s.doc.desktop.guard.dark.alpha === 0.4 && s.doc.desktop.title === 'Hills', 'the record is copied with still repointed', s.doc.desktop);
  check(rec.still === REAL + '\\stills\\wall-7.jpg', 'the real record object is not changed');
  check(JSON.stringify(s.doc.look) === '{}', "the user's look fields are not copied, only the desktop record", s.doc.look);
  const parsed = LS.parse(JSON.stringify(s.doc));
  check(parsed.state === 'ok' && parsed.skipped.length === 0 && parsed.doc.desktop.still === s.copyTo, 'the seeded look.json passes look-sync parse() with nothing skipped', parsed);
  check(s.copyTo.toLowerCase().startsWith(SYNC.toLowerCase() + path.sep + 'stills' + path.sep), "the still lands inside the test stills folder (looksync-main.js desktopPayload's rule)");
}
{
  const gone = P.seed({ schema: 1, rev: 1, look: {}, desktop: Object.assign({}, rec, { still: REAL + '\\stills\\wall-8.jpg' }) }, stills, null, REAL, SYNC);
  check(gone.ok && gone.copyFrom.endsWith('wall-7.jpg') && /missing/.test(gone.reason) && gone.doc.desktop.stillSize === null, "the record's still is missing: the newest still, and says so", gone);
  const outside = P.seed({ schema: 1, rev: 1, look: {}, desktop: Object.assign({}, rec, { still: 'C:\\elsewhere\\wall-7.jpg' }) }, stills, null, REAL, SYNC);
  check(outside.ok && /outside/.test(outside.reason), 'a still outside the stills folder is never copied from there', outside.reason);
  const none = P.seed(null, stills, null, REAL, SYNC);
  check(none.ok && none.doc.desktop.ok === true && none.copyFrom.endsWith('wall-7.jpg') && LS.parse(JSON.stringify(none.doc)).skipped.length === 0, 'no record: the newest still with a plain valid record', none);
  const empty = P.seed({ schema: 1, rev: 1, look: {}, desktop: rec }, [], null, REAL, SYNC);
  check(!empty.ok && /Windows' wallpaper/.test(empty.reason), 'no still at all: nothing seeded, and the reason says what the preview shows instead', empty.reason);
  const off = P.seed({ schema: 1, rev: 1, look: {}, desktop: { rev: 3, ok: false, reason: 'video' } }, [], null, REAL, SYNC);
  check(!off.ok, 'record not ok and no stills: nothing seeded');
}
{
  // a re-launch keeps what was changed in the preview, and the rev only goes up
  const prev = { schema: 1, rev: 12, look: { glass: { v: { dark: { blurPx: 0, dim: 0.4, panel: 0 }, light: { blurPx: 0, dim: 0.3, panel: 0 }, render: 'picture' }, rev: 4, by: 'quartz' } } };
  const s = P.seed({ schema: 1, rev: 9, look: {}, desktop: rec }, stills, prev, REAL, SYNC);
  check(s.doc.look.glass && s.doc.look.glass.v.dark.dim === 0.4 && s.doc.rev === 13, "a re-launch keeps the preview's own look and raises the rev", { rev: s.doc.rev, look: s.doc.look });
}

/* ---- the process match never reaches the real Quartz ---- */
{
  const ps = P.psTree('newlook-preview');
  check(/--profile-name=newlook-preview\(\\s\|"\|\$\)/.test(ps), 'processes are matched by --profile-name=newlook-preview exactly (not a prefix)', ps.split('\n')[1]);
  check(/-notlike '\*--type=\*'/.test(ps) && /ParentProcessId/.test(ps), 'the main process, then its descendants by parent id');
  check(!/Stop-Process -Name|taskkill \/im/i.test(ps), 'never by image name');
}

console.log('newlook-preview: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
