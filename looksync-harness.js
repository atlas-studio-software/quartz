'use strict';
// looksync-harness.js - the vendored look-sync module (looksync/look-sync.js) under Windows file
// refusals, pure node, no Quartz, no Electron.   node looksync-harness.js
//
// Why: look.json is replaced by a rename, and Windows refuses an open or a replace-rename for a moment
// while anything else holds the file (a scanner, another app's read). A refused READ used to end the
// check as 'error' with no retry and no second look, so a change from Mantle or Helm that had already
// landed was simply not followed (looksync-e2e's 1 s follow checks, castlabs build). Every case runs
// in its own temp dir, never %APPDATA%\look-sync. The last cases make REAL Windows locks with
// PowerShell (FileShare.None: reads refused; FileShare.Read: replace-rename refused).
// Case 7 loads the renderer glue (looksync.js) in tests/fake-dom.js with a fake store and bridge:
// the glass seeds and glass.<theme>.dimAuto (automatic vs manual Dim) end to end through the glue.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const LS = require('./looksync/look-sync');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 400))); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); } return !!fn(); }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'looksync-harness-'));
process.env.LOOK_SYNC_DIR = path.join(ROOT, 'never-used'); // a case that forgot its dir still never touches the real store
let n = 0;
const tmpDir = () => { const d = path.join(ROOT, 'd' + (++n)); fs.mkdirSync(d, { recursive: true }); return d; };
const FAST = { debounceMs: 20, corruptRetryMs: 40, rewatchDelays: [100, 200, 400], retryDelays: [10, 20, 40], recheckMs: 150 };

/** Real fs, except reads of look.json throw `code` while `refusing` is on (or `left` more times). */
function refusingFs() {
  const f = { refusing: false, left: 0, code: 'EPERM', refused: 0 };
  f.fs = Object.assign({}, fs, {
    readFileSync(p, ...rest) {
      if (path.basename(String(p)) === LS.FILE && (f.refusing || f.left > 0)) {
        if (f.left > 0) f.left--;
        f.refused++;
        const e = new Error(f.code + ': operation not permitted, open ' + p); e.code = f.code; throw e;
      }
      return fs.readFileSync(p, ...rest);
    },
  });
  return f;
}

/** Another app's write (Mantle by default), the way every app writes: look-sync's writeAtomic. */
async function remoteSet(dir, field, value, app) {
  const cur = LS.read(dir);
  const doc = cur.state === 'ok' ? cur.doc : { schema: LS.SCHEMA, rev: 0, look: {} };
  const rev = doc.rev + 1;
  doc.rev = rev;
  doc.writer = { app: app || 'mantle', instance: 'harness-' + (app || 'mantle'), pid: 1, at: new Date().toISOString() };
  doc.look[field] = { v: value, rev, by: app || 'mantle' };
  const w = await LS.writeAtomic(dir, JSON.stringify(doc, null, 2) + '\n', { app: app || 'mantle' });
  if (!w.ok) throw new Error('remote write: ' + w.reason);
  return rev;
}

function mk(dir, extra) {
  const s = LS.create(Object.assign({ app: 'quartz', dir, local: () => ({}) }, FAST, extra || {}));
  s.applies = []; s.states = [];
  s.on('apply', (e) => s.applies.push(e));
  s.on('status', (x) => s.states.push(x));
  return s;
}
const themeApplied = (s, v) => s.applies.some((e) => e.changes && e.changes.theme === v);

/** PowerShell holds `file` with FileShare `share` for `ms`; resolves once the handle is open. */
async function holdFile(file, share, ms) {
  const ps = spawn('powershell', ['-NoProfile', '-Command',
    "$f = [System.IO.File]::Open('" + file.replace(/'/g, "''") + "', 'Open', 'Read', '" + share + "'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Milliseconds " + ms + "; $f.Close(); [Console]::Out.WriteLine('free'); [Console]::Out.Flush()"],
    { windowsHide: true });
  const h = { out: '' };
  ps.stdout.on('data', (d) => { h.out += d; });
  h.gone = new Promise((r) => ps.on('close', r));
  h.locked = await until(() => /locked/.test(h.out), 15000);
  h.free = () => /free/.test(h.out);
  return h;
}

/** looksync.js loaded as it ships in a fake window, with a fake Settings store and a fake main bridge. */
async function bootGlue(storedGlassValue) {
  const { makeWindow } = require('./tests/fake-dom');
  const store = { glass: storedGlassValue, lookSync: true };
  const listeners = [];
  const settingsStub = {
    get: (k) => (store[k] === undefined ? null : JSON.parse(JSON.stringify(store[k]))),
    set: (patch) => {
      Object.keys(patch).forEach((k) => { store[k] = JSON.parse(JSON.stringify(patch[k])); });
      listeners.forEach((f) => f(Object.assign({}, store), Object.keys(patch)));
    },
    on: (f) => listeners.push(f)
  };
  const bridge = { published: [], locals: [], apply: null };
  const api = {
    hello: () => Promise.resolve({ ok: true, status: { state: 'ok', rev: 1, by: 'mantle', at: null, skipped: [] }, desktop: { state: 'ok', reason: null } }),
    publish: (field, value) => { bridge.published.push({ field, value: JSON.parse(JSON.stringify(value)) }); return Promise.resolve({ ok: true, rev: 2 }); },
    local: (v) => { bridge.locals.push(v); },
    setEnabled: () => Promise.resolve({ ok: true }),
    onStatus() {}, onDesktop() {}, onPlace() {},
    onApply: (cb) => { bridge.apply = cb; }
  };
  const w = makeWindow({ api: { lookSync: api }, Settings: settingsStub, localStorage: { getItem: () => null } });
  w.win.Settings = settingsStub;
  const events = [];
  ['lookglass', 'lookapplied'].forEach((t) => w.doc.addEventListener(t, (e) => events.push({ type: t, detail: e.detail })));
  w.load(path.join(__dirname, 'looksync.js'));
  await sleep(20); // start() runs on a timer, hello() resolves after
  return { LS: w.win.LookSync, store, settings: settingsStub, bridge, events };
}

async function glueChecks() {
  // seeds: nothing stored = the new look (sharp picture, lighter tint), automatic
  {
    const g = await bootGlue(undefined);
    const dark = g.LS.glassFor('dark'), light = g.LS.glassFor('light');
    ok('glue: seed dark = blur 0, dim 0.30, panel 0, no dimAuto', JSON.stringify(dark) === JSON.stringify({ blurPx: 0, dim: 0.3, panel: 0 }), dark);
    ok('glue: seed light = blur 0, dim 0.30, panel 0, no dimAuto', JSON.stringify(light) === JSON.stringify({ blurPx: 0, dim: 0.3, panel: 0 }), light);
  }
  // dimAuto false kept through storedGlass -> glassFor; non-boolean dropped
  {
    const g = await bootGlue({ dark: { blurPx: 3, dim: 0.22, panel: 0, dimAuto: false }, light: { blurPx: 0, dim: 0.4, panel: 0, dimAuto: 'no' }, render: 'picture' });
    ok('glue: glassFor(dark) keeps dimAuto false', g.LS.glassFor('dark').dimAuto === false, g.LS.glassFor('dark'));
    ok('glue: glassFor(light) drops a non-boolean dimAuto', !('dimAuto' in g.LS.glassFor('light')), g.LS.glassFor('light'));
    // a preview while the user drags Dim (dimAuto false) shows during the drag, then clears
    const g2 = await bootGlue({ dark: { blurPx: 0, dim: 0.3, panel: 0, dimAuto: true }, light: { blurPx: 0, dim: 0.3, panel: 0 }, render: 'picture' });
    ok('glue: stored dimAuto true is kept', g2.LS.glassFor('dark').dimAuto === true, g2.LS.glassFor('dark'));
    g2.LS.previewGlass('dark', { blurPx: 0, dim: 0.25, panel: 0, dimAuto: false });
    const during = g2.LS.glassFor('dark');
    ok('glue: Dim-drag preview: glassFor says dimAuto false and the dragged dim', during.dimAuto === false && during.dim === 0.25, during);
    const ev = g2.events.filter((e) => e.type === 'lookglass').pop();
    ok('glue: Dim-drag preview: lookglass carries dimAuto false', ev && ev.detail.preview && ev.detail.glass.dimAuto === false, ev && ev.detail);
    g2.LS.previewGlass('dark', { blurPx: 9, dim: 0.3, panel: 0 });
    ok('glue: a preview naming no mode keeps the stored one', g2.LS.glassFor('dark').dimAuto === true, g2.LS.glassFor('dark'));
    g2.LS.previewGlass('dark', null);
    ok('glue: preview cleared: back to the stored value', g2.LS.glassFor('dark').dimAuto === true && g2.LS.glassFor('dark').dim === 0.3, g2.LS.glassFor('dark'));
    // a local change publishes dimAuto to look.json
    g2.settings.set({ glass: { dark: { blurPx: 0, dim: 0.2, panel: 0, dimAuto: false }, light: { blurPx: 0, dim: 0.3, panel: 0 }, render: 'picture' } });
    await sleep(10);
    const pub = g2.bridge.published.filter((p) => p.field === 'glass').pop();
    ok('glue: publish(glass) sends dimAuto false for dark', pub && pub.value.dark.dimAuto === false && pub.value.dark.dim === 0.2, pub);
    ok('glue: publish(glass) leaves an absent dimAuto absent (light)', pub && !('dimAuto' in pub.value.light), pub);
  }
  // remote apply: only an absent-vs-true dimAuto and key order differ -> no "glass changed", no publish back
  {
    const g = await bootGlue({ dark: { blurPx: 0, dim: 0.3, panel: 0 }, light: { blurPx: 0, dim: 0.3, panel: 0 }, render: 'picture' });
    const before = g.bridge.published.length;
    g.bridge.apply({ cause: 'adopt', by: 'mantle', rev: 3, changes: { glass: { render: 'picture', light: { panel: 0, dim: 0.3, blurPx: 0, dimAuto: true }, dark: { dimAuto: true, panel: 0, dim: 0.3, blurPx: 0 } } } });
    await sleep(10);
    const applied = g.events.filter((e) => e.type === 'lookapplied').pop();
    ok('glue: remote glass equal but for dimAuto true / key order: no "glass changed"', applied && applied.detail.message === null, applied && applied.detail);
    ok('glue: remote glass applied: nothing published back (no ping-pong)', g.bridge.published.length === before, g.bridge.published.slice(before));
    ok('glue: remote dimAuto true is stored and read back', g.LS.glassFor('dark').dimAuto === true, g.LS.glassFor('dark'));
    // a real change of mode (Mantle went Manual) does say so
    g.bridge.apply({ cause: 'adopt', by: 'mantle', rev: 4, changes: { glass: { dark: { blurPx: 0, dim: 0.3, panel: 0, dimAuto: false }, light: { blurPx: 0, dim: 0.3, panel: 0, dimAuto: true }, render: 'picture' } } });
    await sleep(10);
    const applied2 = g.events.filter((e) => e.type === 'lookapplied').pop();
    ok('glue: remote Manual choice is a change ("glass changed")', applied2 && /glass changed/.test(applied2.detail.message || ''), applied2 && applied2.detail);
    ok('glue: remote Manual choice: glassFor(dark).dimAuto false', g.LS.glassFor('dark').dimAuto === false, g.LS.glassFor('dark'));
    ok('glue: remote Manual choice: still nothing published back', g.bridge.published.length === before, g.bridge.published.slice(before));
  }
}

(async () => {
  try {
    // 1. a refusal shorter than the retries: the change is followed, no error shown
    {
      const d = tmpDir();
      await remoteSet(d, 'theme', 'dark');
      const rf = refusingFs();
      const s = mk(d, { fs: rf.fs });
      s.start();
      ok('start: the existing file is taken', await until(() => themeApplied(s, 'dark'), 2000), s.states.map((x) => x.state));
      rf.left = 2; // the next two opens of look.json are refused
      await remoteSet(d, 'theme', 'light');
      const followed = await until(() => themeApplied(s, 'light'), 2000);
      ok('read refused twice: the change is still followed', followed, { refused: rf.refused, states: s.states.map((x) => x.state) });
      ok('read refused twice: the refusals really happened', rf.refused >= 2, rf.refused);
      ok('read refused twice: no error status for a refusal that cleared', !s.states.some((x) => x.state === 'error'), s.states.map((x) => x.state + ':' + x.reason));
      s.close();
    }

    // 2. a refusal that outlasts the retries: error (with the code), then a second look follows it
    {
      const d = tmpDir();
      await remoteSet(d, 'theme', 'dark');
      const rf = refusingFs();
      const s = mk(d, { fs: rf.fs });
      s.start();
      await until(() => themeApplied(s, 'dark'), 2000);
      rf.refusing = true;
      await remoteSet(d, 'accent', { hue: 200 });
      const err = await until(() => s.states.some((x) => x.state === 'error'), 2000);
      const e = s.states.find((x) => x.state === 'error');
      ok('read refused past the retries: Problem status says why', err && /Can't read .*look\.json: EPERM/.test(e.reason), e);
      ok('read refused past the retries: 1 read + 3 retries before saying so', rf.refused >= 4, rf.refused);
      ok('read refused past the retries: not applied while refused', !s.applies.some((a) => a.changes.accent), s.applies);
      rf.refusing = false; // the scanner lets go; NO new write, NO watch event
      const followed = await until(() => s.applies.some((a) => a.changes.accent && a.changes.accent.hue === 200), 2000);
      ok('read refused past the retries: followed by the re-check once it clears (no new event)', followed, s.states.map((x) => x.state));
      ok('read refused past the retries: status back to ok', s.status().state === 'ok', s.status());
      s.close();
    }

    // 3. a refusal that never clears: the re-check is ONE timer at a time, and close() stops it
    {
      const d = tmpDir();
      await remoteSet(d, 'theme', 'dark');
      const rf = refusingFs();
      rf.refusing = true;
      const s = mk(d, { fs: rf.fs });
      s.start();
      await sleep(FAST.recheckMs * 4 + 300);
      const errors = s.states.filter((x) => x.state === 'error').length;
      // each look = 1 read + 3 retries (70 ms) then 150 ms: about 4 looks in 900 ms, never a storm
      ok('refused for good: re-checks are paced (one timer, not a storm)', errors >= 2 && errors <= 6 && rf.refused <= 6 * 4, { errors, refused: rf.refused });
      s.close();
      const at = rf.refused;
      await sleep(FAST.recheckMs * 2 + 100);
      ok('refused for good: close() stops the re-checks', rf.refused === at, { before: at, after: rf.refused });
    }

    // 4. a missing file is NOT an error to retry (ENOENT stays 'missing', no re-check loop)
    {
      const d = tmpDir();
      const s = mk(d, { enabled: false });
      s.start();
      await sleep(FAST.recheckMs + 100);
      ok('missing file: no error, no re-check', !s.states.some((x) => x.state === 'error') && !s.recheckTimer, s.states.map((x) => x.state));
      s.close();
    }

    // 7. the renderer glue (looksync.js) and glass.<theme>.dimAuto: seeds, kept through
    //    storedGlass / glassFor / previewGlass / publish, a non-boolean dropped, and a remote glass
    //    that differs only by an absent-vs-true dimAuto or key order is no change (no toast, no publish).
    await glueChecks();

    if (process.env.GITHUB_ACTIONS === 'true') {
      // Seen on the hosted Windows runner (2026-10-26, twice, even with the lock held 2.5 s): a file
      // PowerShell holds with FileShare.None is still readable there, so the real-lock checks cannot
      // mean anything on it. They run on every real Windows machine; on the runner they are skipped, out loud.
      console.log('SKIP real locks: the hosted CI runner does not enforce FileShare locks against these reads');
    } else if (process.platform === 'win32') {
      // 5. REAL lock, FileShare.None: node's read is refused with a code look-sync retries
      {
        const d = tmpDir();
        await remoteSet(d, 'theme', 'light');
        const file = path.join(d, LS.FILE);
        // Held for 2.5 s, not 0.7: on a loaded machine or a hosted CI runner the 'locked' line can reach
        // node so late that a short lock was already gone by the time the read ran (a flaky FAIL).
        const h = await holdFile(file, 'None', 2500);
        ok('real lock (share None): PowerShell holds look.json', h.locked, h.out);
        const r = LS.read(d);
        ok('real lock (share None): a read is refused with EBUSY/EPERM/EACCES', r.state === 'error' && /^(EBUSY|EPERM|EACCES)$/.test(r.code || ''), r);
        const s = mk(d, { recheckMs: 200 });
        s.start(); // reads while locked: retries, then a re-check after the lock goes
        const followed = await until(() => themeApplied(s, 'light'), 10000);
        const freed = await until(() => h.free(), 10000);
        ok('real lock (share None): the file is taken once the lock goes', followed && freed, { states: s.states.map((x) => x.state + ':' + String(x.reason).slice(0, 60)), out: h.out });
        await h.gone;
        s.close();
      }
      // 6. REAL lock, FileShare.Read (a scanner): a publish's replace-rename lands after it lets go.
      // PowerShell overshoots its sleep: a nominal 250 ms hold measured 350-420 ms here (probe, 10-17),
      // past the writer's 350 ms of retries; a nominal 100 ms stays inside them.
      {
        const d = tmpDir();
        await remoteSet(d, 'theme', 'dark');
        const s = mk(d, { retryDelays: undefined }); // the module's own writer retries
        s.start();
        await until(() => themeApplied(s, 'dark'), 2000);
        const h = await holdFile(path.join(d, LS.FILE), 'Read', 100);
        ok('real lock (share Read): PowerShell holds look.json', h.locked, h.out);
        const r = await s.publish('theme', 'light');
        const now = LS.read(d);
        ok('real lock (share Read): the publish lands after retries', r.ok && now.state === 'ok' && now.doc.look.theme.v === 'light', { r, file: now.state === 'ok' ? now.doc.look.theme : now });
        await h.gone;
        s.close();
      }
    } else console.log('SKIP real locks: Windows only');
  } catch (e) {
    ok('HARNESS ERROR ' + (e && e.stack || e), false);
  }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* a lock still closing */ }
  console.log(`looksync-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
