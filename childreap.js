// childreap.js -- end a child process the browser started AND the processes it started, and
// nothing else.
//
// Why this exists: child_process.spawn creates its children with handle inheritance on, and
// Chromium's DevTools listen socket (--remote-debugging-port) is inheritable. So every process
// spawned through child_process, and every process THAT one spawns, holds the port's listening
// socket for as long as it lives. child.kill() ends only the direct child. A grandchild that
// outlives it (the headless helper's `git status`, say) keeps the port LISTENING after the
// browser quits, and the next start cannot have it.
//
// How it stays inside its own tree. Process IDs are reused, so a parent-ID match alone proves
// nothing. Every step here is checked against a process handle that is held open, because a PID
// cannot be handed to a new process while any handle to the old one is open:
//   - track(child) runs right after spawn (libuv still holds the child, so the PID is ours),
//     opens the child and KEEPS that handle until the tree is reaped, and refuses to track a
//     process that is not a direct child of this process, started after it, running one of
//     the expected programs.
//   - killTree() takes a process snapshot and walks down from the root. A process joins the
//     tree only if its parent is a tree member, its name in the snapshot AND the file its handle
//     runs are both in the expected set, its parent ID read from its own handle matches the
//     snapshot (so the ID was not reused between the two), and it started LATER than that
//     parent (a process older than its "parent" got that parent ID from someone else). A
//     process that fails a check is left alone and so is everything under it.
//   - The root is ended through its held handle, then each member through the very handle that
//     was verified: never a fresh lookup by PID, never a name match, never taskkill.
//   - When the child exits on its own, whatever it left running is reaped the same way (the
//     root handle is still held, so its PID was not reused), then every handle is released.
//
// Never throws. Off Windows, or without koffi, or for a "child" with no real process behind it
// (a harness's fake), killTree() is child.kill(), exactly as before, and the summary says so.
'use strict';

const path = require('path');

// PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE
const ACCESS = 0x1000 | 0x0001 | 0x00100000;
const TH32CS_SNAPPROCESS = 0x2;
const INVALID = BigInt.asUintN(64, -1n);
const WAIT_OBJECT_0 = 0;
/** A tree bigger than this is not a helper's; stop walking and say so. */
const MAX_TREE = 256;
/** Snapshot passes per killTree: a member could start a process between the snapshot and its end. */
const ROUNDS = 3;
/** How long killTree waits, in total, for what it ended to be gone. */
const SETTLE_MS = 300;

let api;            // undefined: not tried yet; null: unavailable; object: bound
let whyNot = '';
let logFn = (line) => { console.log('[childreap] ' + line); };
let saidUnavailable = false;

/** Trackers whose tree is still to be reaped (reapAll walks these). */
const live = new Set();
/** child -> its tracker, so killTree(child) finds the one track(child) made. */
const byChild = new WeakMap();

function errText(err, fallback) {
  return (err && err.message) || fallback;
}

function log(line) {
  try { logFn(line); } catch { /* a logger that throws must not break a kill */ }
}

/* ======================================================================= binding */

function load() {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== 'win32') { whyNot = 'not Windows'; return api; }
  try {
    const koffi = require('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    const ntdll = koffi.load('ntdll.dll');
    // Prefixed names: koffi's type registry is per-process (see embed.js, procfind.js).
    const ENTRY = koffi.struct('ChildreapEntry32W', {
      dwSize: 'uint32_t',
      cntUsage: 'uint32_t',
      th32ProcessID: 'uint32_t',
      th32DefaultHeapID: 'uintptr_t',
      th32ModuleID: 'uint32_t',
      cntThreads: 'uint32_t',
      th32ParentProcessID: 'uint32_t',
      pcPriClassBase: 'int32_t',
      dwFlags: 'uint32_t',
      szExeFile: koffi.array('char16_t', 260, 'String'),
    });
    // PROCESS_BASIC_INFORMATION: the parent ID as the process itself records it.
    const BASIC = koffi.struct('ChildreapBasicInfo', {
      ExitStatus: 'int32_t',
      PebBaseAddress: 'void *',
      AffinityMask: 'uintptr_t',
      BasePriority: 'int32_t',
      UniqueProcessId: 'uintptr_t',
      InheritedFromUniqueProcessId: 'uintptr_t',
    });
    api = {
      size: koffi.sizeof(ENTRY),
      pidAt: koffi.offsetof(ENTRY, 'th32ProcessID'),
      ppidAt: koffi.offsetof(ENTRY, 'th32ParentProcessID'),
      nameAt: koffi.offsetof(ENTRY, 'szExeFile'),
      basicSize: koffi.sizeof(BASIC),
      parentAt: koffi.offsetof(BASIC, 'InheritedFromUniqueProcessId'),
      ptrSize: koffi.sizeof('void *'),
      snapshot: kernel32.func('void * __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)'),
      first: kernel32.func('bool __stdcall Process32FirstW(void *h, _Inout_ uint8_t *pe)'),
      next: kernel32.func('bool __stdcall Process32NextW(void *h, _Inout_ uint8_t *pe)'),
      open: kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
      close: kernel32.func('bool __stdcall CloseHandle(void *h)'),
      // FILETIMEs as raw bytes: a uint64 that big would lose its low bits as a Number.
      times: kernel32.func('bool __stdcall GetProcessTimes(void *h, _Out_ uint8_t *created, _Out_ uint8_t *exited, _Out_ uint8_t *kernel, _Out_ uint8_t *user)'),
      imagePath: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32_t flags, _Out_ uint8_t *buf, _Inout_ uint32_t *size)'),
      terminate: kernel32.func('bool __stdcall TerminateProcess(void *h, uint32_t code)'),
      wait: kernel32.func('uint32_t __stdcall WaitForSingleObject(void *h, uint32_t ms)'),
      current: kernel32.func('void * __stdcall GetCurrentProcess()'),
      lastError: kernel32.func('uint32_t __stdcall GetLastError()'),
      basicInfo: ntdll.func('int32_t __stdcall NtQueryInformationProcess(void *h, int32_t cls, _Out_ uint8_t *buf, uint32_t len, _Out_ uint32_t *ret)'),
      address: (p) => koffi.address(p),
    };
  } catch (err) {
    api = null;
    whyNot = 'koffi could not bind the Windows process calls (' + errText(err, 'load failed') + ')';
  }
  return api;
}

function winErr(w) {
  try { return ' (Windows error ' + w.lastError() + ')'; } catch { return ''; }
}

function closeHandle(w, h) {
  if (!h) return;
  try { w.close(h); } catch { /* already closed */ }
}

/** Creation time as a BigInt FILETIME, or null. */
function createdOf(w, h) {
  const c = Buffer.alloc(8), e = Buffer.alloc(8), k = Buffer.alloc(8), u = Buffer.alloc(8);
  if (!w.times(h, c, e, k, u)) return null;
  const v = c.readBigUInt64LE(0);
  return v > 0n ? v : null;
}

/** The full path of the file the process runs, or ''. */
function pathOf(w, h) {
  const buf = Buffer.alloc(2048);
  const size = [1024];
  if (!w.imagePath(h, 0, buf, size)) return '';
  return buf.toString('utf16le', 0, Number(size[0]) * 2);
}

/** The parent ID the process itself records (not a snapshot's), or null. */
function parentOf(w, h) {
  const buf = Buffer.alloc(w.basicSize);
  const status = w.basicInfo(h, 0 /* ProcessBasicInformation */, buf, w.basicSize, null);
  if (status !== 0) return null;
  return w.ptrSize === 8 ? Number(buf.readBigUInt64LE(w.parentAt)) : buf.readUInt32LE(w.parentAt);
}

function hasExited(w, h) {
  return w.wait(h, 0) === WAIT_OBJECT_0;
}

/** Every process right now: [{ pid, ppid, image }], or an error in plain words. */
function snapshotRows(w) {
  let h = null;
  try {
    h = w.snapshot(TH32CS_SNAPPROCESS, 0);
    const at = h ? BigInt(w.address(h)) : 0n;
    if (!h || at === 0n || at === INVALID) { h = null; return { rows: null, error: 'the process snapshot could not be taken' + winErr(w) }; }
    const pe = Buffer.alloc(w.size);
    pe.writeUInt32LE(w.size, 0);
    const end = w.size - 1;
    const rows = [];
    let ok = w.first(h, pe);
    while (ok) {
      let stop = w.nameAt;
      while (stop < end && (pe[stop] !== 0 || pe[stop + 1] !== 0)) stop += 2;
      rows.push({ pid: pe.readUInt32LE(w.pidAt), ppid: pe.readUInt32LE(w.ppidAt), image: pe.toString('utf16le', w.nameAt, stop) });
      ok = w.next(h, pe);
    }
    if (!rows.length) return { rows: null, error: 'the process snapshot was empty' };
    return { rows, error: '' };
  } catch (err) {
    return { rows: null, error: 'the process snapshot failed (' + errText(err, 'threw') + ')' };
  } finally {
    closeHandle(w, h);
  }
}

/* ===================================================================== the pure part */

function toBig(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  return null;
}

function baseName(p) {
  return path.win32.basename(String(p || '')).toLowerCase();
}

function imageSet(images) {
  const set = new Set();
  const list = Array.isArray(images) || images instanceof Set ? images : [];
  for (const name of list) {
    const n = baseName(name);
    if (n) set.add(n);
  }
  return set;
}

/**
 * Which processes are provably the root's descendants. Pure unless opts.probe is given.
 *
 * rows:  [{ pid, ppid, image, path, created, parentFromHandle?, why? }] -- a process snapshot.
 *        `image` is the snapshot's name, `path` the file the process's handle runs, `created`
 *        its start time (any monotonic number; FILETIME BigInts live), `parentFromHandle` the
 *        parent ID read from the process itself, `why` a reason it could not be read.
 * root:  { pid, created }.
 * images: the program names a member may run (['git.exe', ...], case-insensitive).
 * opts.known: [{ pid, created }] members already proven (an earlier pass): walked, not listed.
 * opts.probe(row): fills path / created / parentFromHandle / why (and a handle) for a row that
 *        passed the name check; only such rows are ever probed.
 * opts.requireHandleParent: a row without parentFromHandle is not proven.
 * opts.max: the most members (root and known included) before the walk stops.
 *
 * Returns { kill, skipped }: kill = new members, parents before children (the caller ends the
 * root first, through its own handle); skipped = [{ pid, image, why }] for every child of a
 * member that was not proven. Nothing below a skipped process is visited.
 */
function planTree(rows, root, images, opts) {
  const o = opts || {};
  const want = imageSet(images);
  const max = Number(o.max) > 0 ? Number(o.max) : MAX_TREE;
  const kill = [];
  const skipped = [];
  const rootPid = root && Number.isInteger(root.pid) && root.pid > 0 ? root.pid : 0;
  const rootCreated = root ? toBig(root.created) : null;
  if (!rootPid || rootCreated === null) return { kill, skipped, error: 'the root has no process ID or start time' };

  const byParent = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !Number.isInteger(row.pid) || row.pid <= 0 || !Number.isInteger(row.ppid)) continue;
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }

  const members = new Map([[rootPid, rootCreated]]);
  const queue = [rootPid];
  for (const k of Array.isArray(o.known) ? o.known : []) {
    const c = k ? toBig(k.created) : null;
    if (!k || !Number.isInteger(k.pid) || c === null || members.has(k.pid)) continue;
    members.set(k.pid, c);
    queue.push(k.pid);
  }
  // Every pid looked at once, members or not: a ppid cycle in the data cannot loop the walk.
  const seen = new Set(members.keys());

  for (let qi = 0; qi < queue.length; qi++) {
    const parent = queue[qi];
    const parentCreated = members.get(parent);
    for (const raw of byParent.get(parent) || []) {
      if (seen.has(raw.pid)) continue;
      seen.add(raw.pid);
      const image = String(raw.image || '');
      const skip = (why) => { skipped.push({ pid: raw.pid, image, why }); };
      if (!want.has(image.toLowerCase())) { skip('an unexpected program; it and anything it started were left alone'); continue; }
      let row = raw;
      if (typeof o.probe === 'function') {
        try { row = Object.assign({}, raw, o.probe(raw) || {}); } catch (err) { row = Object.assign({}, raw, { why: 'it could not be checked (' + errText(err, 'probe threw') + ')' }); }
      }
      if (row.why) { skip(String(row.why)); continue; }
      const file = baseName(row.path);
      if (!file) { skip('the file it runs could not be read'); continue; }
      if (!want.has(file)) { skip('it runs ' + file + ', not one of the expected programs'); continue; }
      if (file !== image.toLowerCase()) { skip('the snapshot calls it ' + image + ' but it runs ' + file); continue; }
      const created = toBig(row.created);
      if (created === null) { skip('its start time could not be read'); continue; }
      if (!(created > parentCreated)) { skip('it started no later than process ' + parent + ', so that parent ID belonged to an earlier process'); continue; }
      const hp = row.parentFromHandle;
      if (hp !== undefined || o.requireHandleParent) {
        if (hp == null) { skip('its parent ID could not be read from the process itself'); continue; }
        if (hp !== parent) { skip('the process now at this ID names process ' + hp + ' as its parent, not ' + parent + ' (the ID was reused)'); continue; }
      }
      if (members.size >= max) { skip('the tree is larger than ' + max + ' processes; the walk stopped here'); continue; }
      members.set(row.pid, created);
      kill.push(row);
      queue.push(row.pid);
    }
  }
  return { kill, skipped, error: '' };
}

/* ======================================================================= trackers */

function emptySummary(label, why) {
  return { label, why: why || '', killed: [], skipped: [], error: '', fallback: '' };
}

/** One plain line for a summary (or for reapAll's total). */
function describe(s) {
  if (!s) return '';
  const head = (s.label || 'child') + (s.why ? ', ' + s.why : '') + ': ';
  const parts = [];
  if (s.fallback) parts.push(s.fallback);
  if (s.killed && s.killed.length) parts.push('ended ' + s.killed.map((k) => k.image + ' ' + k.pid).join(', '));
  if (s.skipped && s.skipped.length) parts.push('left alone ' + s.skipped.map((k) => k.image + ' ' + k.pid + ' (' + k.why + ')').join(', '));
  if (s.error) parts.push('error: ' + s.error);
  if (s.errors && s.errors.length) parts.push('errors: ' + s.errors.join('; '));
  return head + (parts.length ? parts.join('; ') : 'nothing left running');
}

/** A tracker that can only do what the code did before: child.kill() on the direct child. */
function fallbackTracker(child, label, why) {
  const t = {
    label,
    pid: child && Number.isInteger(child.pid) ? child.pid : 0,
    tracked: false,
    reason: why,
    killTree(how) {
      const s = emptySummary(label, how);
      s.fallback = 'only the direct child was ended, with child.kill(): ' + why;
      try { if (child && typeof child.kill === 'function') child.kill(); } catch (err) { s.error = 'child.kill() failed (' + errText(err, 'threw') + ')'; }
      return s;
    },
    release() {},
  };
  if (child && typeof child === 'object') { try { byChild.set(child, t); } catch { /* not a weak-mappable value */ } }
  return t;
}

function trackedTracker(child, label, images, w, handle, created, image) {
  let done = false;

  function finish() {
    done = true;
    live.delete(t);
    closeHandle(w, handle);
  }

  /** The walk, the kills, the settle wait. `how` is the reason in plain words. */
  function reap(how) {
    const s = emptySummary(label, how);
    if (done) return s;
    const opened = [];         // every handle a probe opened, closed at the end
    const ended = [];          // handles we asked to end, waited on at the end
    const skippedPids = new Set();
    const addError = (e) => { s.error = (s.error ? s.error + '; ' : '') + e; };
    let rootTried = false;
    // The root, through the handle held since spawn. Always attempted, whatever else fails:
    // ending at least the direct child is what child.kill() did before.
    const endRoot = () => {
      rootTried = true;
      if (hasExited(w, handle)) return;
      if (w.terminate(handle, 1)) { s.killed.push({ pid: t.pid, image }); ended.push(handle); }
      else if (!hasExited(w, handle)) addError('could not end ' + image + ' ' + t.pid + winErr(w));
    };
    try {
      const root = { pid: t.pid, created };
      const known = [];
      const probe = (row) => {
        const h = w.open(ACCESS, false, row.pid);
        if (!h) return { why: 'it could not be opened' + winErr(w) };
        opened.push(h);
        return { handle: h, path: pathOf(w, h), created: createdOf(w, h), parentFromHandle: parentOf(w, h) };
      };
      for (let round = 0; round < ROUNDS; round++) {
        // First the walk (who is in the tree right now), then the ends, parents first.
        const snap = snapshotRows(w);
        if (!snap.rows) addError(snap.error + (round === 0 ? ', so what it started was not checked' : ' on a later pass'));
        const plan = snap.rows ? planTree(snap.rows, root, images, { known, probe, requireHandleParent: true }) : { kill: [], skipped: [] };
        for (const sk of plan.skipped) {
          if (skippedPids.has(sk.pid)) continue;
          skippedPids.add(sk.pid);
          s.skipped.push(sk);
        }
        if (round === 0) endRoot();
        for (const m of plan.kill) {
          known.push({ pid: m.pid, created: m.created });
          if (hasExited(w, m.handle)) continue;
          if (w.terminate(m.handle, 1)) { s.killed.push({ pid: m.pid, image: m.image }); ended.push(m.handle); }
          else if (!hasExited(w, m.handle)) s.skipped.push({ pid: m.pid, image: m.image, why: 'Windows refused to end it' + winErr(w) });
        }
        if (!plan.kill.length) break;
      }
      // TerminateProcess returns before the process is gone; wait a little so "ended" is true.
      const until = Date.now() + SETTLE_MS;
      const still = [];
      for (let i = 0; i < ended.length; i++) {
        const left = Math.max(0, until - Date.now());
        if (w.wait(ended[i], left) !== WAIT_OBJECT_0) still.push(i);
      }
      if (still.length) addError(still.length + ' process(es) asked to end were still running after ' + SETTLE_MS + ' ms');
    } catch (err) {
      addError('the tree walk failed (' + errText(err, 'threw') + ')');
      if (!rootTried) { try { endRoot(); } catch (e2) { addError('ending the root failed too (' + errText(e2, 'threw') + ')'); } }
    } finally {
      for (const h of opened) closeHandle(w, h);
      finish();
    }
    return s;
  }

  const t = {
    label,
    pid: child.pid,
    tracked: true,
    reason: '',
    /** End the root and every proven descendant now. Never throws. */
    killTree(how, opts) {
      const s = reap(how || 'asked');
      if (!(opts && opts.quiet) && (s.killed.length > 1 || s.skipped.length || s.error)) log(describe(s));
      return s;
    },
    /** Let go of the root handle without ending anything. */
    release() { if (!done) finish(); },
  };

  // The child ended on its own: reap what it left behind (nothing to say if that was only
  // the console host Windows gave it, which goes with it anyway).
  const onExit = () => {
    if (done) return;
    const s = reap('exited');
    const notable = s.killed.some((k) => k.image.toLowerCase() !== 'conhost.exe') || s.skipped.length || s.error;
    if (notable) log(describe(s));
  };
  try { if (typeof child.once === 'function') child.once('exit', onExit); } catch { /* reapAll still covers it */ }

  live.add(t);
  byChild.set(child, t);
  return t;
}

/**
 * Track a child just returned by child_process.spawn. Call it synchronously after the spawn.
 * opts.images: the programs the root and its descendants may run (['claude.exe', 'git.exe',
 * 'conhost.exe']). opts.label: a name for log lines. Returns a tracker:
 *   { label, pid, tracked, reason, killTree(how, { quiet }) -> summary, release() }.
 * tracked=false (reason says why) means killTree() is child.kill(), as before. Never throws.
 */
function track(child, opts) {
  const o = opts || {};
  const label = String(o.label || 'child process');
  let w = null;
  let h = null;
  // A real process we could not take on: say so (once per child), and keep child.kill().
  const refuse = (why) => {
    if (h) { closeHandle(w, h); h = null; }
    log(label + ' (process ' + child.pid + ') is not tracked, so only child.kill() will end it: ' + why);
    return fallbackTracker(child, label, why);
  };
  try {
    if (!child || typeof child !== 'object') return fallbackTracker(null, label, 'there is no child process object');
    const existing = byChild.get(child);
    if (existing) return existing;
    const pid = child.pid;
    if (!Number.isInteger(pid) || pid <= 0) return fallbackTracker(child, label, 'it has no process ID (it did not start, or it is not a real process)');
    w = load();
    if (!w) {
      if (!saidUnavailable) { saidUnavailable = true; log('child processes are ended with child.kill() only, so what they started may outlive them: ' + whyNot); }
      return fallbackTracker(child, label, whyNot);
    }
    const images = imageSet(o.images);
    h = w.open(ACCESS, false, pid);
    if (!h) return refuse('process ' + pid + ' could not be opened' + winErr(w));
    // The root must be OUR child: a fake or stale pid must never become something we end.
    const parent = parentOf(w, h);
    if (parent !== process.pid) return refuse('process ' + pid + ' is not a child of this process (its parent is ' + (parent == null ? 'unreadable' : parent) + ')');
    const created = createdOf(w, h);
    const mine = createdOf(w, w.current());
    if (created === null || mine === null) return refuse('the start time of process ' + pid + ' could not be read');
    if (!(created > mine)) return refuse('process ' + pid + ' started before this process did, so it is not the child just spawned');
    const file = baseName(pathOf(w, h));
    if (!file) return refuse('the file process ' + pid + ' runs could not be read');
    if (!images.has(file)) return refuse('process ' + pid + ' runs ' + file + ', not one of the expected programs');
    const held = h;
    h = null;                       // the tracker owns it from here
    return trackedTracker(child, label, images, w, held, created, file);
  } catch (err) {
    if (!child || typeof child !== 'object') return fallbackTracker(null, label, 'tracking failed (' + errText(err, 'threw') + ')');
    return refuse('tracking failed (' + errText(err, 'threw') + ')');
  }
}

/** End the tree track(child) set up; a child never tracked gets child.kill(). Never throws. */
function killTree(child, how) {
  try {
    const t = child && typeof child === 'object' ? byChild.get(child) : null;
    if (t) return t.killTree(how);
    return fallbackTracker(child, 'child process', 'it was never tracked').killTree(how);
  } catch (err) {
    const s = emptySummary('child process', how);
    s.error = 'killTree failed (' + errText(err, 'threw') + ')';
    return s;
  }
}

/**
 * App quit: end every tracked tree still registered, synchronously. Returns
 * { trees, killed, skipped, errors, line } with `line` one plain sentence for the log.
 */
function reapAll(how) {
  const all = { label: 'quit', why: how || '', trees: 0, killed: [], skipped: [], errors: [], line: '' };
  for (const t of Array.from(live)) {
    all.trees += 1;
    let s;
    try { s = t.killTree(how || 'quit', { quiet: true }); } catch (err) { s = emptySummary(t.label, how); s.error = errText(err, 'threw'); }
    all.killed.push(...s.killed);
    all.skipped.push(...s.skipped);
    if (s.error) all.errors.push(t.label + ': ' + s.error);
  }
  all.line = describe(Object.assign({}, all, { label: all.trees + ' child process tree(s)', why: how || 'quit' }));
  return all;
}

function setLog(fn) { if (typeof fn === 'function') logFn = fn; }
function reason() { load(); return whyNot; }
function trackedCount() { return live.size; }

// Test seam (childreap-harness.js): use(null, 'why') makes the Windows binding unavailable so
// the child.kill() fallback can be exercised; use(undefined) goes back to the real one.
const __test = {
  use(fake, why) { api = fake; whyNot = why || ''; saidUnavailable = false; },
  /** The real binding (trackers share it), so a harness can make one call fail for a moment. */
  api() { return load(); },
};

module.exports = { track, killTree, reapAll, planTree, describe, setLog, reason, trackedCount, __test };
