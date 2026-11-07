'use strict';
// sessioncap-harness.js - how many tabs a session keeps, what it costs, and how a big one comes
// back. Pure node, no Quartz.
//   node sessioncap-harness.js
// app.js is a plain renderer script (no exports), so the pieces are cut out of its source by name
// and run in a vm: capSessionEntries() (the tab-count and size bounds a snapshot is cut to),
// sessionCapMessage() and noteSessionCap() (what the user is told when a bound bites, and how
// often), sanitiseSession() (the read side's bound and its overflow count, with its small helpers
// stubbed) and restoreAsleepRows() with RESTORE_AWAKE_MAX (a big session restores lazily whatever
// the sleep settings say). It also measures the stored size of a realistic tab and how long the
// pure half of a save takes at several hundred tabs. The live restart is sessions-e2e.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail))); }
}

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

/** The source of `function <name>(...) { ... }`, by brace matching from its first `{`. */
function cutFunction(name) {
  const at = src.indexOf('\nfunction ' + name + '(');
  if (at === -1) throw new Error('app.js has no function ' + name);
  let i = src.indexOf('{', src.indexOf(')', at));
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at + 1, i + 1); }
  }
  throw new Error('unbalanced ' + name);
}
/** The number a top-level `const NAME = <expr>;` evaluates to (a plain arithmetic expression). */
function constNumber(text, name) {
  const m = new RegExp('\\nconst ' + name + ' = ([0-9 *+]+);').exec(text);
  if (!m) throw new Error('no numeric const ' + name);
  return Function('return (' + m[1] + ')')();
}

const MAX_TABS = constNumber(src, 'SESSION_MAX_TABS');
const MAX_CHARS = constNumber(src, 'SESSION_MAX_CHARS');
const AWAKE_MAX = constNumber(src, 'RESTORE_AWAKE_MAX');
const MAIN_MAX_BYTES = constNumber(mainSrc, 'SESSION_MAX_BYTES');

const notes = [];
const ctx = vm.createContext({
  SESSION_MAX_TABS: MAX_TABS, SESSION_MAX_CHARS: MAX_CHARS, RESTORE_AWAKE_MAX: AWAKE_MAX,
  SESSION_MAX_WORKSPACES: constNumber(src, 'SESSION_MAX_WORKSPACES'),
  SESSION_TITLE_MAX: constNumber(src, 'SESSION_TITLE_MAX'),
  SESSION_NEWTAB: 'newtab', SESSION_PHONE: 'phone', DEFAULT_WORKSPACE_ID: 'main', APP_ID_MAX: 64,
  parseUrlOrNull: (u) => { try { return new URL(u); } catch (e) { return null; } },
  cleanWorkspaceColour: () => null, cleanWorkspaceFolder: () => null, cleanWorkspacePane: () => null,
  cleanWorkspacePreset: () => null, cleanWorkspaceName: (n, d) => (typeof n === 'string' && n) || d || 'Workspace',
  cleanSeededPresets: (v) => (Array.isArray(v) ? v : []),
  sessionNote: (m) => notes.push(m)
});
vm.runInContext(
  ['capSessionEntries', 'sessionCapMessage', 'noteSessionCap', 'sanitiseSession', 'restoreAsleepRows']
    .map(cutFunction).join('\n')
  + '\nlet lastSessionCap = { total: 0, kept: 0, dropped: 0, reason: "" }; let sessionCapTold = false;'
  + '\nthis.capSessionEntries = capSessionEntries; this.sessionCapMessage = sessionCapMessage;'
  + ' this.noteSessionCap = noteSessionCap; this.sanitiseSession = sanitiseSession;'
  + ' this.restoreAsleepRows = restoreAsleepRows;'
  + ' this.setCap = (c) => { lastSessionCap = c; };', ctx);
const { capSessionEntries, sessionCapMessage, noteSessionCap, sanitiseSession, restoreAsleepRows, setCap } = ctx;

// A realistic stored tab: the shape sessionSnapshot() writes (url, title when it beats the url,
// the odd flag). Urls and titles of everyday length, a few long ones mixed in.
function realisticEntry(i) {
  const hosts = ['www.youtube.com/watch?v=dQw4w9WgXcQ&t=' + i, 'github.com/some-org/some-repo/pull/' + i + '/files',
    'docs.google.com/document/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefg/edit#heading=h.' + i,
    'www.amazon.com/s?k=usb+c+cable&crid=2M3ABCDEF&sprefix=usb+c%2Caps%2C140&ref=nb_sb_noss_' + i,
    'en.wikipedia.org/wiki/Special_relativity#section_' + i, 'news.example.com/2026/11/06/a-story-about-something-' + i];
  const e = { url: 'https://' + hosts[i % hosts.length] };
  e.title = ['Some video title that runs a bit long - YouTube', 'Fix the tab strip by someone · Pull Request #' + i,
    'Planning doc - Google Docs', 'Amazon.com : usb c cable', 'Special relativity - Wikipedia',
    'A story about something that happened today, with a long headline | Example News'][i % 6];
  if (i % 17 === 0) e.pinned = true;
  if (i % 3 === 0) e.ws = 'ws2';
  return e;
}

// --- the bounds themselves ------------------------------------------------
{
  ok('SESSION_MAX_TABS is far past real use (>= 300; it was 40): ' + MAX_TABS, MAX_TABS >= 300);
  ok('SESSION_MAX_TABS is still a bound (<= 2000)', MAX_TABS <= 2000);
  ok('RESTORE_AWAKE_MAX is small (1..16): ' + AWAKE_MAX, AWAKE_MAX >= 1 && AWAKE_MAX <= 16);
  ok('main\'s file guard holds any snapshot the renderer means to write (>= 3 bytes per char + room)',
    MAIN_MAX_BYTES >= MAX_CHARS * 3 + 256 * 1024, { MAIN_MAX_BYTES, MAX_CHARS });
  ok('the char budget fits localStorage (about 5 million characters per origin) with room to spare',
    MAX_CHARS <= 2500000);
}

// --- measured: the stored size of a tab, and the pure half of a save -------
{
  const one = [];
  for (let i = 0; i < 600; i++) one.push(JSON.stringify(realisticEntry(i)).length);
  const avg = one.reduce((a, b) => a + b, 0) / one.length;
  const max = Math.max(...one);
  console.log('INFO stored tab: ' + avg.toFixed(0) + ' chars on average, ' + max + ' at most (no favicons are stored)');
  ok('a realistic stored tab is well under 1 KB', avg < 1024, avg);
  ok('SESSION_MAX_TABS realistic tabs fit the char budget many times over',
    avg * MAX_TABS * 4 < MAX_CHARS, { avg, MAX_TABS, MAX_CHARS });

  for (const n of [40, 150, MAX_TABS]) {
    const entries = [];
    for (let i = 0; i < n; i++) entries.push(realisticEntry(i));
    const runs = 20;
    const t0 = process.hrtime.bigint();
    let json = '';
    for (let r = 0; r < runs; r++) {
      const cap = capSessionEntries(entries, MAX_TABS, MAX_CHARS);
      json = JSON.stringify({ tabs: cap.kept, active: 0, workspaces: [], savedAt: Date.now() });
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / runs;
    console.log('INFO ' + n + ' tabs: snapshot JSON ' + (json.length / 1024).toFixed(1) + ' KB, bound + stringify '
      + ms.toFixed(2) + ' ms per save');
    ok(n + ' tabs: the pure half of a save takes under 25 ms', ms < 25, ms);
  }
}

// --- capSessionEntries ----------------------------------------------------
{
  const list = [];
  for (let i = 0; i < 520; i++) list.push(realisticEntry(i));
  const under = capSessionEntries(list.slice(0, 300), MAX_TABS, MAX_CHARS);
  ok('300 tabs: every one kept, nothing dropped', under.kept.length === 300 && under.dropped === 0 && under.reason === '', under.dropped);
  const over = capSessionEntries(list, 500, MAX_CHARS);
  ok('520 tabs at a bound of 500: the first 500 kept, 20 dropped, reason count',
    over.kept.length === 500 && over.dropped === 20 && over.reason === 'count' && over.kept[499] === list[499],
    { kept: over.kept.length, dropped: over.dropped, reason: over.reason });
  const big = [];
  for (let i = 0; i < 10; i++) big.push({ url: 'https://example.com/?q=' + 'x'.repeat(1000) + i });
  const sized = capSessionEntries(big, 500, 3500);
  const len = sized.kept.reduce((a, e) => a + JSON.stringify(e).length + 1, 0);
  ok('the char budget: only as many as fit are kept, reason size', sized.reason === 'size' && sized.kept.length === 3
    && sized.dropped === 7 && len <= 3500, { kept: sized.kept.length, len, reason: sized.reason });
  ok('junk in: an empty result, never a throw', capSessionEntries(null, 500, 10).kept.length === 0);
  ok('zero tabs stays zero tabs', capSessionEntries([], 500, 10).dropped === 0);
}

// --- what the user is told -------------------------------------------------
{
  const save = sessionCapMessage(500, 23, 'count', 'save');
  ok('save note: kept and dropped counts and the reason in plain words',
    /first 500 tabs/.test(save) && /23 more were not saved/.test(save) && new RegExp('at most ' + MAX_TABS + ' tabs').test(save), save);
  ok('save note: one tab reads "was"', /1 more was not saved/.test(sessionCapMessage(500, 1, 'count', 'save')));
  ok('size note: says the addresses are too long', /too long/.test(sessionCapMessage(41, 2, 'size', 'save')));
  const rest = sessionCapMessage(500, 9, 'count', 'restore');
  ok('restore note: restored first N, M more not opened', /restored your first 500 tabs/.test(rest) && /9 more/.test(rest), rest);

  notes.length = 0;
  setCap({ total: 503, kept: 500, dropped: 3, reason: 'count' });
  noteSessionCap(); noteSessionCap(); noteSessionCap();
  ok('a run of capped saves is told ONCE, not on every debounced save', notes.length === 1, notes);
  setCap({ total: 400, kept: 400, dropped: 0, reason: '' });
  noteSessionCap();
  setCap({ total: 510, kept: 500, dropped: 10, reason: 'count' });
  noteSessionCap();
  ok('a save that fitted re-arms it: going over again is told again', notes.length === 2 && /10 more/.test(notes[1]), notes);
}

// --- the read side: sanitiseSession's bound ---------------------------------
{
  const mk = (n) => {
    const tabs = [];
    for (let i = 0; i < n; i++) tabs.push(realisticEntry(i));
    return { tabs, active: n - 1, workspaces: [{ id: 'main' }, { id: 'ws2', name: 'Two' }], currentWorkspace: 'main', panesV: 2, savedAt: 5 };
  };
  const s300 = sanitiseSession(mk(300));
  ok('300 stored tabs: all 300 read back, overflow 0, last one active',
    s300 && s300.entries.length === 300 && s300.overflow === 0 && s300.active === 299,
    s300 && { n: s300.entries.length, overflow: s300.overflow, active: s300.active });
  ok('workspaces ride along on a big session', s300 && s300.entries.filter((e) => e.ws === 'ws2').length === 100);
  const s = sanitiseSession(mk(MAX_TABS + 37));
  ok('a runaway file: SESSION_MAX_TABS read back and the rest COUNTED (overflow ' + (s && s.overflow) + ')',
    s && s.entries.length === MAX_TABS && s.overflow === 37, s && { n: s.entries.length, overflow: s.overflow });
  const bad = mk(10); bad.tabs.splice(3, 0, { url: 'file:///x' }, { url: 'javascript:1' });
  const sb = sanitiseSession(bad);
  ok('dropped junk is not overflow (the bound did not bite)', sb && sb.entries.length === 10 && sb.overflow === 0);
}

// --- restoreAsleepRows with RESTORE_AWAKE_MAX -------------------------------
{
  const rows = (entries) => entries.map((entry, index) => ({ entry, index }));
  const pages = (n, extra) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(Object.assign({ url: 'https://e.test/' + i, ws: i % 3 === 2 ? 'ws2' : 'home', pinned: false }, extra && extra(i)));
    return out;
  };
  // Tab sleep off (lazy false) and workspace sleep off (sleepOthers false): what the user asked for.
  const small = restoreAsleepRows(rows(pages(AWAKE_MAX)), 0, 'home', false, false, AWAKE_MAX);
  ok('sleep off, ' + AWAKE_MAX + ' tabs: every one boots awake, as the setting says', small.asleep.size === 0 && !small.forced);
  const r150 = rows(pages(150));
  const big = restoreAsleepRows(r150, 0, 'home', false, false, AWAKE_MAX);
  ok('sleep off, 150 tabs: forced lazy, ONE page awake (the front)', big.forced && big.awake === 1 && !big.asleep.has(big.front) && big.front === 0,
    { forced: big.forced, awake: big.awake, front: big.front });
  ok('sleep off, 150 tabs: the other workspace sleeps too', r150.filter((r) => r.entry.ws === 'ws2').every((r) => big.asleep.has(r.index)));
  const pinned = rows(pages(150, (i) => ({ pinned: i === 3 || i === 4 || i === 6 })));
  const p = restoreAsleepRows(pinned, 0, 'home', false, false, AWAKE_MAX);
  ok('forced lazy keeps the current workspace\'s pins awake: front + 3 pins', p.awake === 4 && !p.asleep.has(3) && !p.asleep.has(4) && !p.asleep.has(6), p.awake);
  const manyPins = rows(pages(150, (i) => ({ pinned: i < 40 })));
  const mp = restoreAsleepRows(manyPins, 51, 'home', true, true, AWAKE_MAX);
  ok('40 pins: never more than RESTORE_AWAKE_MAX awake (' + mp.awake + '), the front among them',
    mp.forced && mp.awake === AWAKE_MAX && mp.front === 51 && !mp.asleep.has(51), mp.awake);
  const on = restoreAsleepRows(r150, 0, 'home', true, true, AWAKE_MAX);
  ok('sleep on, 150 tabs: the ordinary lazy restore, not forced (one awake)', !on.forced && on.awake === 1);
  const mixed = rows([{ claude: true, ws: 'home' }, { native: 'x', ws: 'home' }].concat(pages(40)));
  const mx = restoreAsleepRows(mixed, 5, 'home', false, false, AWAKE_MAX);
  ok('chambers and native tabs are never born asleep, even when forced', mx.forced && !mx.asleep.has(0) && !mx.asleep.has(1));
  const legacy = restoreAsleepRows(r150, 0, 'home', false, false);
  ok('no awakeMax: the settings alone decide (the old behaviour)', legacy.asleep.size === 0 && !legacy.forced);
  ok('empty list: nothing forced', restoreAsleepRows([], 0, 'home', false, false, AWAKE_MAX).forced === false);
}

// --- the wiring (source checks; sessions-e2e proves it live) ---------------
{
  const snap = cutFunction('sessionSnapshot');
  ok('sessionSnapshot cuts through capSessionEntries with both bounds', /capSessionEntries\(entries, SESSION_MAX_TABS, SESSION_MAX_CHARS\)/.test(snap));
  ok('no plain slice to the cap remains', !/entries\.slice\(0, SESSION_MAX_TABS\)/.test(src));
  const write = cutFunction('writeSession');
  ok('writeSession tells the user (noteSessionCap) on every write', /noteSessionCap\(\)/.test(write));
  ok('writeSession: a refused localStorage write is said, not swallowed', /sessionNote\(/.test(write));
  const rest = cutFunction('restoreSession');
  ok('restoreSession passes RESTORE_AWAKE_MAX', /RESTORE_AWAKE_MAX\)/.test(rest));
  ok('restoreSession says when a stored session overflowed the bound', /session\.overflow > 0/.test(rest) && /'restore'\)/.test(rest));
  ok('restoreSession says when the boot went lazy against the settings', /if \(restoreForced\)/.test(rest) && /sessionNote\(lastRestoreNote\)/.test(rest));
}

// The suite's summary-line format (tools/run-suite.js): "<name>: N passed, M failed".
console.log('\nsessioncap: ' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
