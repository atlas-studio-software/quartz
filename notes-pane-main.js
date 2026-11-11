'use strict';

/*
 * notes-pane-main.js — the notes pane's brain (main process): which notes file
 * (subject) is up, what question a reader app is showing, and which section of
 * the user's own notes it maps to, answered by a headless Claude Code session.
 *
 * OFF UNTIL CONFIGURED. Everything here is driven by one file the user owns,
 * <userData>\notes-pane.json (CONFIG below). With no `dir` in it, or a `dir`
 * that is not a folder, the module answers describe() with configured:false
 * and a plain reason, and does NOTHING else: no scan, no watcher, no timers,
 * no registry query, no process poll, no budget reader, no child process.
 * The renderer hides the pane and every way into it on configured:false, and
 * Settings > Notes pane says how to turn it on (pick a folder).
 *
 * CONTRACT
 *   create({ app, ipcMain, isChromeSender, send, budgetModule })
 *     -> { stop(), describe(), command(name, arg) }
 *   budgetModule: budget.js (or a stand-in with the same create()). It is only
 *   created when the config names a statusline folder (`budgetDir`); without
 *   one the helper says plainly that no budget source is configured.
 *   (A harness may pass getBudget() instead, which wins.)
 *
 *   IPC (chrome only, gated by isChromeSender):
 *     'notes:describe'             -> state (below)
 *     'notes:command', name, arg   -> { ok: true, ... } | { ok: false, reason }
 *        names: 'set-dir'     {dir|null}  the notes folder; null turns the pane off
 *               'set-subject' {id|null}   pick a subject by hand; null = automatic
 *               'set-helper'  {on}        helper on/off  (also accepts {model})
 *               'probe'                   run the reader now
 *               'install-policy'          write the WebView2 remote-debugging policy for the reader app
 *               'ask' {text}              match this text as if it were the current question
 *               'pin' {on}                freeze the current match (no more auto-jumps)
 *   Push (chrome): send('notes:update', state) on every change (debounced).
 *
 *   state = {
 *     configured: boolean,                        // false = no usable `dir`: every entry point hidden
 *     dir: string, configFile: string,            // the notes folder ('' when unset), notes-pane.json's path
 *     ready: boolean, reason: string,             // false + reason while unbuilt / broken / off
 *     subjects: [{ id, name, file, sections: [{ id, title }] }],
 *     subject: { id: string|null, source: 'reader'|'manual'|'none', reason: string },
 *     reader:  { configured: boolean, app: string,
 *                mode: 'cdp'|'uia'|'ocr'|'off', state: 'ok'|'waiting'|'error',
 *                reason: string, port: number, lastReadAt: number,
 *                question: { text, hash, topic } | null },
 *     helper:  { enabled: boolean, state: 'idle'|'thinking'|'paused'|'error'|'off',
 *                reason: string, model: string, sessionId: string|null, lastMs: number },
 *     match:   { hash, sectionId: string|null, confidence: number, title: string,
 *                at: number, reason: string } | null,
 *     pinned:  boolean,
 *     policy:  { installed: boolean, needsRestart: boolean, port: number, reason: string }
 *   }
 *
 * CONFIG — <userData>\notes-pane.json. Every key is optional except `dir`:
 *   dir              the folder of notes files (.html). Unset = the whole pane is off.
 *   manualSubjectId  the subject picked by hand (written by the pane)
 *   helperEnabled    the Claude helper on/off (written by the pane; default false: it spends the
 *                    user's own Claude usage, so it is opt-in)
 *   helperModel      the helper's model (written by the pane; default HELPER_MODEL_DEFAULT)
 *   pinned           the pin (written by the pane)
 *   claudeBin        the claude executable; unset = %USERPROFILE%\.local\bin\claude.exe when it
 *                    exists (where Claude Code's installer puts it), else the first claude on PATH
 *   budgetDir        the folder Claude Code's statusLine hook writes one JSON per session into
 *                    (see budget.js). Unset = no budget guard, and the helper says so.
 *   subjectAliases   { "<subject id>": ["phrase", ...] }: extra words that mean that subject
 *                    when they appear in the reader's topic text (the window title or the
 *                    page heading). Unset = each subject's own name and file stem.
 *   reader           the question reader; unset (or no `exe`) = no reader, and the pane is
 *                    driven by hand (pick a subject, paste a question with "ask"):
 *     name           what the pane calls it ("... is not running"); unset = exe minus .exe
 *     exe            the reader app's process image, e.g. "SomeApp.exe" (WebView2 or any
 *                    Chromium app; also what the WebView2 policy value is named after)
 *     cdpPort        the remote-debugging port the policy hands it (default 9333)
 *     urlPatterns    substrings; the CDP reader picks the first page target whose URL
 *                    contains one of them (unset = the first page target)
 *     topicSelectors CSS selectors tried in order for the page's topic line over CDP
 *                    (unset = 'header h1', 'h1'); the page title is the fallback
 *     script         the UIA/OCR reader script (unset = notes-reader.ps1 beside this file)
 *   The module rewrites the file only to store what the pane changes, and keeps every other
 *   key exactly as it found it.
 *
 * HOW IT WORKS (and what can go wrong, because none of it may fail silently)
 *
 * SUBJECTS. Every .html in the notes folder is a subject: the file stem is the
 * id, the first <title> minus " Notebook" is the name, and every <section id="..">
 * is a section titled by the first heading inside it. The same scan also builds
 * a per-subject INDEX — one "id | heading | first ~200 chars" line per section —
 * which is the only thing the helper ever learns about the notes. The folder is
 * watched, and re-scanned on a 30 s stat as a belt-and-braces fallback in case
 * the watcher misses an editor's write-rename dance.
 *
 * READER. Three ways to read the question that is on screen, in order, each one
 * announcing itself in reader.mode + reader.reason:
 *   cdp — a WebView2 reader app can be handed --remote-debugging-port=<cdpPort>
 *         by a per-app policy value. If that works we read the real DOM.
 *         Whether an MSIX-packaged app honours the policy is UNPROVEN; if the
 *         port never opens the reader says so and drops to uia.
 *   uia — notes-reader.ps1 walks the window's UI Automation tree. Chromium's
 *         a11y tree is cold until something asks for it, hence the retry.
 *         The script only walks again when the page can have changed (its
 *         TextPattern text differs, or, without one, a UIA change event fired;
 *         and at least every 24 s); otherwise it answers from the last walk, so
 *         a 3 s read of an unchanged question costs one call, not a walk. If
 *         the events ever miss a change, the script says so in "gate" and walks
 *         every read; that reason is shown here. "probe" always walks.
 *   ocr — same script, PrintWindow + Windows.Media.Ocr, used only when the a11y
 *         tree came back nearly empty. Never steals focus, never raises a window.
 * A question counts as NEW when its hash changes and then repeats once (settle),
 * so a half-painted screen is never sent to the helper.
 *
 * HELPER. One headless `claude -p` session per subject. The first call carries
 * the subject's INDEX and the rules; later calls resume that session with just
 * the question text, so an hour's worth of matching costs well under a dime
 * (measured: $0.0088 for the first question of a subject, $0.0015 after). It
 * answers ONLY {"section": id|null, "confidence": 0..1} — never the answer to
 * the question, which is the whole point of the feature. Before every call the
 * budget is checked: at 90 % of the five-hour window or 95 % of the week the
 * helper parks itself and says so rather than eating the user's limit.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const childProcess = require('child_process');
const procfind = require('./procfind');
// Ends a child AND what it started (they inherit the DevTools socket; see childreap.js).
const childreap = require('./childreap');

/* ---------------------------------------------------------------- constants */

const CONFIG_FILE = 'notes-pane.json';
const HELPER_MODEL_DEFAULT = 'claude-sonnet-5';

const CDP_PORT_DEFAULT = 9333;
const POLICY_KEY = 'HKCU\\Software\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';
const READER_SCRIPT = 'notes-reader.ps1';
const TOPIC_SELECTORS_DEFAULT = ['header h1', 'h1'];

const PRESENCE_MS = 5000;        // how often we ask whether the reader app is running
const READ_MS = 3000;            // how often we read the question
const CDP_GIVE_UP_MS = 25000;    // reader app up this long with no port => policy ignored
const SCAN_STAT_MS = 30000;      // fallback notes re-scan
const PUSH_DEBOUNCE_MS = 100;

const TEXT_CAP = 4096;           // how much on-screen text we keep / send
const INDEX_CAP = 24 * 1024;     // per-subject index handed to the helper
const SNIPPET_CHARS = 200;
const UIA_MIN_CHARS = 40;        // below this the a11y tree counts as empty -> OCR
const HELPER_TIMEOUT_MS = 60000;

// Budget thresholds: at or above either one the helper parks itself.
const BUDGET_PAUSE_FIVE_HOUR_PCT = 90;
const BUDGET_PAUSE_WEEK_PCT = 95;

/* ------------------------------------------------------------ small helpers */

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowMs() {
  return Date.now();
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '\u2013',
  mdash: '\u2014', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018',
  ldquo: '\u201c', rdquo: '\u201d', times: '\u00d7', deg: '\u00b0', rarr: '\u2192'
};

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const hit = ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

// HTML -> plain text, good enough for a 200-character snippet.
function plainText(html) {
  return decodeEntities(String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// The hash ignores clocks, timers and percentages: a lesson or quiz app repaints those every
// second and they would stop any question from ever settling.
function hashText(text) {
  const stable = String(text)
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')
    .replace(/\b\d{1,3}(\.\d+)?\s?%/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return crypto.createHash('sha1').update(stable).digest('hex').slice(0, 12);
}

function trimTo(text, cap) {
  const s = String(text == null ? '' : text);
  return s.length > cap ? s.slice(0, cap) : s;
}

function seconds(ms) {
  return (ms / 1000).toFixed(1) + ' s';
}

function money(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  return '$' + (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3));
}

/* ------------------------------------------------------------------ config */

// A string list from the config: strings only, trimmed, empties dropped.
function stringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const s = typeof item === 'string' ? item.trim() : '';
    if (s) out.push(s);
  }
  return out;
}

/*
 * notes-pane.json -> the reader's settings, or null when no reader is set up.
 * `exe` is the one key a reader cannot work without (it is both the process the
 * presence poll looks for and the name the WebView2 policy value is filed
 * under), so a `reader` object without it is "no reader", and describe() says so.
 */
function readerConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : null;
  const exe = r && typeof r.exe === 'string' ? r.exe.trim() : '';
  if (!exe) return null;
  const port = Number(r.cdpPort);
  return {
    exe,
    proc: exe.replace(/\.exe$/i, ''),       // the process name minus .exe, for the PS reader
    name: (typeof r.name === 'string' && r.name.trim()) || exe.replace(/\.exe$/i, ''),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : CDP_PORT_DEFAULT,
    urlPatterns: stringList(r.urlPatterns),
    topicSelectors: stringList(r.topicSelectors).length ? stringList(r.topicSelectors) : TOPIC_SELECTORS_DEFAULT.slice(),
    script: typeof r.script === 'string' ? r.script.trim() : ''
  };
}

// { id: [phrase, ...] } from the config, phrases lower-cased; null when there are none.
function aliasConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = [];
  for (const id of Object.keys(raw)) {
    const phrases = stringList(raw[id]).map((p) => p.toLowerCase());
    if (phrases.length) out.push({ id, phrases });
  }
  return out.length ? out : null;
}

/*
 * Where `claude` is when the config does not say. Claude Code's own installer
 * puts it in %USERPROFILE%\.local\bin, so that comes first; otherwise the first
 * one on PATH. Only real executables are taken (claude.exe on Windows): a .cmd
 * shim would need a shell, and the helper never spawns one. The answer may not
 * exist; the spawn then fails with a reason the pane shows.
 */
function findClaudeBin(env) {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const local = path.join(os.homedir(), '.local', 'bin', exe);
  try { if (fs.statSync(local).isFile()) return local; } catch { /* not installed there */ }
  const dirs = String((env || process.env).PATH || (env || process.env).Path || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir.replace(/^"|"$/g, ''), exe);
    try { if (fs.statSync(full).isFile()) return full; } catch { /* not here */ }
  }
  return local;
}

/* ================================================================== module */

function create(options) {
  const opts = options || {};
  const ipcMain = opts.ipcMain;
  const gate = typeof opts.isChromeSender === 'function' ? opts.isChromeSender : () => false;
  const sendFn = typeof opts.send === 'function' ? opts.send : () => {};

  // Everything a harness needs to drive this module without a reader app, Claude or
  // a registry: all of them are injectable, all of them default to the real one.
  // `notesDir` / `claudeBin` / `reader` / `subjectAliases` in the options override
  // the config file's values (the harnesses use them; main passes none).
  const spawnFn = typeof opts.spawn === 'function' ? opts.spawn : childProcess.spawn;
  const scriptDir = opts.scriptDir || __dirname;
  const autoStart = opts.autoStart !== false;
  // "Is the reader app running?": true / false, or null for "ask tasklist". A harness that
  // injects spawn keeps getting the tasklist call it expects.
  const isRunningFn = typeof opts.isRunning === 'function' ? opts.isRunning
    : (typeof opts.spawn === 'function' ? () => null : (name) => procfind.running(name));
  const helperTimeoutMs = Number(opts.helperTimeoutMs) > 0 ? Number(opts.helperTimeoutMs) : HELPER_TIMEOUT_MS;

  let userDataDir = opts.userDataDir || '';
  if (!userDataDir && opts.app && typeof opts.app.getPath === 'function') {
    try { userDataDir = opts.app.getPath('userData'); } catch { userDataDir = ''; }
  }
  const storeFile = userDataDir ? path.join(userDataDir, CONFIG_FILE) : '';

  /* The config, as last read. `config` is the WHOLE parsed file, unknown keys and
     all, so that saving what the pane changed never drops a key the user wrote. */
  let config = {};
  let notesDir = '';              // '' = not configured
  let reader = null;              // readerConfig() or null = no reader app
  let aliases = null;             // aliasConfig() or null = names and stems only
  let claudeBin = '';
  // The budget guard's source: a harness's getBudget(), or a budget.js reader made
  // from `budgetDir` while the pane is on (and only then: off means nothing polls).
  const injectedBudget = typeof opts.getBudget === 'function' ? opts.getBudget : null;
  const budgetModule = opts.budgetModule && typeof opts.budgetModule.create === 'function' ? opts.budgetModule : null;
  let budgetDir = '';
  let budgetReader = null;
  let budgetFailure = '';         // why a configured budget reader did not start ('' = it did)

  // `ws` is a devDependency: if a packaged build ever ships without it, the CDP
  // reader must say so out loud instead of quietly never working.
  let WebSocketImpl = opts.WebSocket || null;
  let wsMissingReason = '';
  if (!WebSocketImpl) {
    try { WebSocketImpl = require('ws'); } catch (err) {
      WebSocketImpl = null;
      wsMissingReason = 'the ws module is not installed (' + (err && err.message ? err.message : 'require failed') + ')';
    }
  }

  /* ------------------------------------------------------------ the state */

  const state = {
    configured: false,
    dir: '',
    configFile: storeFile,
    ready: false,
    reason: 'starting up',
    subjects: [],
    subject: { id: null, source: 'none', reason: 'no subject detected: pick one' },
    reader: {
      configured: false, app: '',
      mode: 'off', state: 'waiting', reason: 'starting up',
      port: CDP_PORT_DEFAULT, lastReadAt: 0, question: null
    },
    helper: {
      enabled: false, state: 'idle', reason: 'idle',   // opt-in: it runs the user's own Claude CLI (their usage)
      model: HELPER_MODEL_DEFAULT, sessionId: null, lastMs: 0
    },
    match: null,
    pinned: false,
    policy: { installed: false, needsRestart: false, port: CDP_PORT_DEFAULT, reason: 'not checked yet' }
  };

  // Private bookkeeping that never goes over IPC.
  const indexes = new Map();      // subjectId -> { text, truncated }
  const sessions = new Map();     // subjectId -> { sessionId, calls }
  let helperCostUsd = 0;
  let manualSubjectId = null;
  let stopped = false;

  let pushTimer = null;
  let lastPushed = '';

  let scanTimer = null;
  let watcher = null;
  let watchDebounce = null;
  let lastScanSignature = '';

  let presenceTimer = null;
  let readTimer = null;
  let appRunning = false;
  let appSince = 0;
  let presenceBusy = false;
  let presenceReason = '';        // set when tasklist itself failed, so "not running" is never a guess
  let readBusy = false;

  let cdpSocket = null;
  let cdpTargetId = '';
  let cdpMsgId = 0;
  const cdpPending = new Map();
  let cdpGaveUp = false;

  let psChild = null;
  let psBuffer = '';
  let psMsgId = 0;
  const psPending = new Map();
  let psRestarts = 0;

  let settleHash = '';
  let settleCount = 0;

  let inflight = null;            // { child, subjectId, hash, settle }
  let pinnedBaseReason = '';      // the frozen match's own reason, kept out of the "held back" suffix

  /* ------------------------------------------------------------- push/IPC */

  function describe() {
    return clone(state);
  }

  // The reader app's name for messages, and the policy value that hands it its debugger port.
  function appName() {
    return reader ? reader.name : 'the reader app';
  }
  function policyValue() {
    return '--remote-debugging-port=' + (reader ? reader.port : CDP_PORT_DEFAULT);
  }

  // No timer when there is nothing new to send. The 3 s reader calls this on every read, with
  // the same answer, all day while the reader app is closed. In Electron's main process every
  // setTimeout also calls process.activateUvLoop(), and doing that from a timer callback every
  // few seconds locks the main thread and Electron's libuv poll thread into waking each other
  // hundreds to thousands of times a second, for seconds to minutes at a time (2026-10-15,
  // tools/efficiency/wake-bisect.js + timer-repro.js: Quartz idle 200-700 main-process wakeups/s
  // with this timer, 7-8 without; plain Electron calling only activateUvLoop() every 3 s: 360/s).
  // The check runs in a microtask, so changes made later in the same turn still count; the
  // timer's own comparison below is unchanged, so exactly the same pushes go out as before.
  let pushCheck = false;
  function schedulePush() {
    if (stopped || pushTimer || pushCheck) return;
    pushCheck = true;
    queueMicrotask(() => {
      pushCheck = false;
      if (stopped || pushTimer) return;
      if (JSON.stringify(state) === lastPushed) return;
      pushTimer = setTimeout(() => {
        pushTimer = null;
        const json = JSON.stringify(state);
        if (json === lastPushed) return;
        lastPushed = json;
        try { sendFn('notes:update', clone(state)); } catch { /* the chrome may be gone */ }
      }, PUSH_DEBOUNCE_MS);
      if (pushTimer.unref) pushTimer.unref();
    });
  }

  function setReader(mode, readState, reason) {
    state.reader.mode = mode;
    state.reader.state = readState;
    state.reader.reason = reason;
    schedulePush();
  }

  function setHelper(helperState, reason) {
    state.helper.state = helperState;
    state.helper.reason = reason;
    schedulePush();
  }

  /* ---------------------------------------------------------- persistence */

  // Why the config could not be used, in plain words ('' = fine, or simply absent).
  let configProblem = '';

  /*
   * Read notes-pane.json. A missing file is the ordinary public default (the pane
   * was never turned on) and says nothing; an unreadable or broken one is a real
   * fault and says so through state.reason. The pane's own keys are taken from
   * it here; the rest is applyConfig()'s.
   */
  function loadStore() {
    config = {};
    configProblem = '';
    manualSubjectId = null;
    if (!storeFile) {
      configProblem = 'there is no app data folder, so there is no ' + CONFIG_FILE;
      return;
    }
    let raw = '';
    try { raw = fs.readFileSync(storeFile, 'utf8'); } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        configProblem = 'cannot read ' + storeFile + ' (' + ((err && (err.code || err.message)) || 'read failed') + ')';
      }
      return;
    }
    let saved = null;
    try { saved = JSON.parse(raw.replace(/^﻿/, '')); } catch (err) {
      configProblem = storeFile + ' is not valid JSON (' + ((err && err.message) || 'parse failed') + '): fix it or delete it';
      return;
    }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
      configProblem = storeFile + ' does not hold a JSON object: fix it or delete it';
      return;
    }
    config = saved;
    if (typeof saved.manualSubjectId === 'string') manualSubjectId = saved.manualSubjectId;
    if (typeof saved.helperEnabled === 'boolean') state.helper.enabled = saved.helperEnabled;
    if (typeof saved.helperModel === 'string' && saved.helperModel) state.helper.model = saved.helperModel;
    if (typeof saved.pinned === 'boolean') state.pinned = saved.pinned;
  }

  /*
   * The config -> the module's settings and the public half of the state. Called
   * after loadStore(), at boot and after 'set-dir'. Nothing here starts anything;
   * start() does, and only when this said `configured`.
   */
  function applyConfig() {
    const dirRaw = opts.notesDir || (typeof config.dir === 'string' ? config.dir.trim() : '');
    let why = '';
    notesDir = '';
    if (!dirRaw) {
      why = configProblem || 'no notes folder is set: pick one in Settings > Notes pane';
    } else if (!path.isAbsolute(dirRaw)) {
      why = 'the notes folder must be a full path, not "' + dirRaw + '": pick it again in Settings > Notes pane';
    } else {
      let st = null;
      try { st = fs.statSync(dirRaw); } catch { st = null; }
      if (!st || !st.isDirectory()) {
        why = 'the notes folder is not there: ' + dirRaw + ' (pick it again in Settings > Notes pane once it exists)';
      } else {
        notesDir = dirRaw;
      }
    }

    state.configured = !!notesDir;
    state.dir = notesDir;
    if (!state.configured) {
      state.ready = false;
      state.reason = why;
      state.subjects = [];
    }

    reader = readerConfig(opts.reader !== undefined ? opts.reader : config.reader);
    aliases = aliasConfig(opts.subjectAliases !== undefined ? opts.subjectAliases : config.subjectAliases);
    claudeBin = !notesDir ? ''
      : (opts.claudeBin || (typeof config.claudeBin === 'string' && config.claudeBin.trim()) || findClaudeBin());
    budgetDir = typeof config.budgetDir === 'string' ? config.budgetDir.trim() : '';

    state.reader.configured = !!reader;
    state.reader.app = reader ? reader.name : '';
    state.reader.port = reader ? reader.port : CDP_PORT_DEFAULT;
    state.policy.port = state.reader.port;
    if (!reader) {
      state.policy.installed = false;
      state.policy.needsRestart = false;
      state.policy.reason = 'no reader app is configured, so there is no policy to check';
    }
  }

  /*
   * Write notes-pane.json: the file as it is on disk NOW (so a key the user typed
   * in while the browser ran survives), with `patch` laid over it. A file that is
   * there but broken is never overwritten: that would throw away what the user
   * wrote. Returns '' or the reason it did not save.
   */
  function writeConfig(patch) {
    if (!storeFile) return 'there is no app data folder to save ' + CONFIG_FILE + ' in';
    let base = {};
    let raw = null;
    try { raw = fs.readFileSync(storeFile, 'utf8'); } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        return 'cannot read ' + storeFile + ' (' + ((err && (err.code || err.message)) || 'read failed') + ')';
      }
    }
    if (raw !== null) {
      let parsed = null;
      try { parsed = JSON.parse(raw.replace(/^﻿/, '')); } catch { parsed = null; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return storeFile + ' is not a valid JSON object, so it was left alone: fix it or delete it';
      }
      base = parsed;
    }
    const next = Object.assign({}, base);
    for (const key of Object.keys(patch)) {
      if (patch[key] === undefined) delete next[key];
      else next[key] = patch[key];
    }
    try {
      fs.mkdirSync(path.dirname(storeFile), { recursive: true });
      fs.writeFileSync(storeFile, JSON.stringify(next, null, 2), 'utf8');
    } catch (err) {
      return 'could not save ' + CONFIG_FILE + ': ' + (err && err.message ? err.message : 'write failed');
    }
    config = next;
    return '';
  }

  // The pane's own four keys (a subject picked by hand, the helper switch and model, the pin).
  function saveStore() {
    const why = writeConfig({
      manualSubjectId,
      helperEnabled: state.helper.enabled,
      helperModel: state.helper.model,
      pinned: state.pinned
    });
    if (why) {
      // Not fatal, but it must not be invisible: the next describe() says why.
      state.reason = why;
      schedulePush();
    }
  }

  /* ------------------------------------------------------- subjects + index */

  // Pull the sections out of one notes file. Sections are flat <section id="..">
  // blocks; the title is the first heading inside, with the decorative number
  // span dropped, and the id is the fallback so a section is never nameless.
  function parseSubject(file) {
    const full = path.join(notesDir, file);
    const html = fs.readFileSync(full, 'utf8');

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const rawTitle = titleMatch ? plainText(titleMatch[1]) : '';
    const id = path.basename(file, path.extname(file));
    const name = (rawTitle.replace(/\s*Notebook\s*$/i, '').trim()) || id;

    const sections = [];
    const indexLines = ['SUBJECT: ' + name + ' (' + id + ')', 'SECTIONS:'];
    let indexChars = indexLines.join('\n').length;
    let truncated = false;

    const open = /<section\b[^>]*\bid="([^"]+)"[^>]*>/gi;
    let m;
    const starts = [];
    while ((m = open.exec(html)) !== null) {
      starts.push({ id: m[1], at: m.index, after: m.index + m[0].length });
    }
    for (let i = 0; i < starts.length; i += 1) {
      const here = starts[i];
      const end = i + 1 < starts.length ? starts[i + 1].at : html.length;
      const body = html.slice(here.after, end);
      const head = body.match(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/i);
      const title = (head ? plainText(head[2].replace(/<span class="n">[\s\S]*?<\/span>/gi, ' ')) : '')
        || here.id;
      sections.push({ id: here.id, title });

      if (!truncated) {
        const snippet = plainText(head ? body.slice(head.index + head[0].length) : body).slice(0, SNIPPET_CHARS);
        const line = here.id + ' | ' + title + ' | ' + snippet;
        if (indexChars + line.length + 1 > INDEX_CAP) {
          truncated = true;
        } else {
          indexLines.push(line);
          indexChars += line.length + 1;
        }
      }
    }
    if (truncated) indexLines.push('(index truncated at ' + INDEX_CAP + ' characters; later sections have ids only)');

    return {
      row: { id, name, file, sections, indexTruncated: truncated, indexChars },
      index: indexLines.join('\n')
    };
  }

  function scanSubjects(why) {
    let files = [];
    try {
      files = fs.readdirSync(notesDir).filter((f) => /\.html?$/i.test(f)).sort();
    } catch (err) {
      state.ready = false;
      state.reason = 'cannot read the notes folder ' + notesDir + ': '
        + (err && err.message ? err.message : 'readdir failed');
      state.subjects = [];
      schedulePush();
      return;
    }
    if (!files.length) {
      state.ready = false;
      state.reason = 'no .html notes found in ' + notesDir;
      state.subjects = [];
      schedulePush();
      return;
    }

    const rows = [];
    const failures = [];
    indexes.clear();
    for (const file of files) {
      try {
        const parsed = parseSubject(file);
        rows.push(parsed.row);
        indexes.set(parsed.row.id, { text: parsed.index, truncated: parsed.row.indexTruncated });
      } catch (err) {
        failures.push(file + ' (' + (err && err.message ? err.message : 'parse failed') + ')');
      }
    }

    state.subjects = rows;
    state.ready = rows.length > 0;
    const truncatedIds = rows.filter((r) => r.indexTruncated).map((r) => r.id);
    let reason = rows.length + ' subjects, '
      + rows.reduce((n, r) => n + r.sections.length, 0) + ' sections, from ' + notesDir;
    if (why) reason += ' (' + why + ')';
    if (truncatedIds.length) reason += '; index truncated for ' + truncatedIds.join(', ');
    if (failures.length) reason += '; could not read ' + failures.join(', ');
    state.reason = reason;

    // A subject that vanished cannot stay selected by hand.
    if (manualSubjectId && !rows.some((r) => r.id === manualSubjectId)) {
      manualSubjectId = null;
      saveStore();
    }
    resolveSubject();
    schedulePush();
  }

  function subjectById(id) {
    return state.subjects.find((row) => row.id === id) || null;
  }

  function scanSignature() {
    try {
      return fs.readdirSync(notesDir)
        .filter((f) => /\.html?$/i.test(f))
        .sort()
        .map((f) => {
          const st = fs.statSync(path.join(notesDir, f));
          return f + ':' + st.size + ':' + Math.floor(st.mtimeMs);
        })
        .join('|');
    } catch {
      return 'unreadable';
    }
  }

  function startWatching() {
    lastScanSignature = scanSignature();
    try {
      watcher = fs.watch(notesDir, { persistent: false }, () => {
        if (watchDebounce) clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => {
          watchDebounce = null;
          const sig = scanSignature();
          if (sig === lastScanSignature) return;
          lastScanSignature = sig;
          scanSubjects('notes changed on disk');
        }, 600);
        if (watchDebounce.unref) watchDebounce.unref();
      });
    } catch (err) {
      // The 30 s stat below still covers us; say which one is doing the work.
      state.reason += '; folder watch failed (' + (err && err.message ? err.message : 'watch failed')
        + '), falling back to a 30 s re-scan';
      schedulePush();
    }
    scanTimer = setInterval(() => {
      const sig = scanSignature();
      if (sig === lastScanSignature) return;
      lastScanSignature = sig;
      scanSubjects('30 s re-scan');
    }, SCAN_STAT_MS);
    if (scanTimer.unref) scanTimer.unref();
  }

  /* ------------------------------------------------------------ the subject */

  function matchTopicToSubject(topicText) {
    const hay = ' ' + String(topicText || '').toLowerCase().replace(/[^a-z0-9. ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
    if (hay.trim().length === 0) return null;

    // A subject whose own name appears verbatim wins outright.
    for (const row of state.subjects) {
      const name = row.name.toLowerCase().replace(/[^a-z0-9. ]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (name && hay.indexOf(' ' + name + ' ') !== -1) return { id: row.id, phrase: row.name };
    }

    // Then the phrases: the config's subjectAliases when it has any (in the order
    // the file lists them), else each subject's file stem read as words
    // ("world-history" -> "world history"). Longer phrases are tried first so a
    // two-word phrase beats a stray one-word one, and every phrase only matches
    // as whole words. The subjects themselves always come from the notes folder:
    // an alias for a file that is not there is skipped.
    const candidates = [];
    const hints = aliases || state.subjects.map((row) => ({
      id: row.id,
      phrases: [row.id.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ').trim()].filter(Boolean)
    }));
    for (const hint of hints) {
      for (const phrase of hint.phrases) candidates.push({ id: hint.id, phrase });
    }
    candidates.sort((a, b) => b.phrase.length - a.phrase.length);
    for (const cand of candidates) {
      if (!subjectById(cand.id)) continue;
      const safe = cand.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(^|[^a-z0-9])' + safe + '($|[^a-z0-9])');
      if (re.test(hay)) return cand;
    }
    return null;
  }

  function resolveSubject() {
    const before = state.subject.id + '|' + state.subject.source;

    if (manualSubjectId && subjectById(manualSubjectId)) {
      state.subject.id = manualSubjectId;
      state.subject.source = 'manual';
      state.subject.reason = 'picked by hand: ' + subjectById(manualSubjectId).name;
    } else {
      const topic = state.reader.question ? state.reader.question.topic : '';
      const hit = topic ? matchTopicToSubject(topic) : null;
      if (hit) {
        state.subject.id = hit.id;
        state.subject.source = 'reader';
        state.subject.reason = 'matched "' + trimTo(topic, 80) + '" to ' + subjectById(hit.id).name
          + ' (on "' + hit.phrase + '")';
      } else {
        state.subject.id = null;
        state.subject.source = 'none';
        state.subject.reason = topic
          ? 'no subject detected: pick one ("' + trimTo(topic, 60) + '" matched nothing)'
          : 'no subject detected: pick one';
      }
    }

    if (before !== state.subject.id + '|' + state.subject.source) schedulePush();
    return state.subject.id;
  }

  /* ------------------------------------------------------------ child procs */

  // Every child is spawned with windowsHide so nothing ever flashes a console
  // window over the user's screen.
  function runOnce(file, args, timeoutMs) {
    return new Promise((resolve) => {
      let child = null;
      try {
        child = spawnFn(file, args, { windowsHide: true });
      } catch (err) {
        resolve({ ok: false, code: -1, out: '', err: '', reason: (err && err.message) || 'spawn failed' });
        return;
      }
      childreap.track(child, { images: [path.basename(file).toLowerCase() + (path.extname(file) ? '' : '.exe'), 'conhost.exe'], label: file });
      let out = '';
      let errOut = '';
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        childreap.killTree(child, 'timed out');
        resolve({ ok: false, code: -1, out, err: errOut, reason: 'timed out after ' + seconds(timeoutMs) });
      }, timeoutMs);
      if (timer.unref) timer.unref();
      if (child.stdout) child.stdout.on('data', (d) => { out += d.toString(); });
      if (child.stderr) child.stderr.on('data', (d) => { errOut += d.toString(); });
      child.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, code: -1, out, err: errOut, reason: (err && err.message) || 'spawn error' });
      });
      child.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: code === 0, code, out, err: errOut, reason: code === 0 ? '' : 'exit code ' + code });
      });
    });
  }

  /* -------------------------------------------------------------- the policy */

  async function readPolicy() {
    if (!reader) return false;
    const res = await runOnce('reg', ['query', POLICY_KEY, '/v', reader.exe], 5000);
    if (!res.ok) {
      state.policy.installed = false;
      state.policy.reason = 'the remote-debugging policy is not installed; the CDP reader cannot work '
        + '(use "install-policy", then restart ' + appName() + ')';
      schedulePush();
      return false;
    }
    const line = res.out.split(/\r?\n/).find((l) => l.indexOf('REG_SZ') !== -1) || '';
    const value = line.split('REG_SZ').slice(1).join('REG_SZ').trim();
    const installed = value.indexOf('--remote-debugging-port=' + reader.port) !== -1;
    state.policy.installed = installed;
    state.policy.reason = installed
      ? 'policy installed: ' + reader.exe + ' = ' + value
      : 'a policy exists for ' + reader.exe + ' but it is "' + value + '", not ' + policyValue();
    schedulePush();
    return installed;
  }

  async function installPolicy() {
    if (!reader) {
      return { ok: false, reason: 'no reader app is configured (reader.exe in ' + CONFIG_FILE + '), so there is no policy to install' };
    }
    const res = await runOnce('reg',
      ['add', POLICY_KEY, '/v', reader.exe, '/t', 'REG_SZ', '/d', policyValue(), '/f'], 8000);
    if (!res.ok) {
      state.policy.installed = false;
      state.policy.reason = 'could not write the policy: '
        + (res.reason || 'reg add failed') + (res.err ? ' — ' + trimTo(res.err.trim(), 200) : '');
      schedulePush();
      return { ok: false, reason: state.policy.reason };
    }
    await readPolicy();
    cdpGaveUp = false;                       // give CDP another chance after a restart
    state.policy.needsRestart = appRunning;
    state.policy.reason += state.policy.needsRestart
      ? ' — ' + appName() + ' is running: close and reopen it for the port to appear'
      : ' — it takes effect the next time ' + appName() + ' starts';
    schedulePush();
    return { ok: true, needsRestart: state.policy.needsRestart, reason: state.policy.reason };
  }

  /* -------------------------------------------- is the reader app running */

  async function checkPresence() {
    if (presenceBusy || stopped || !reader) return;
    presenceBusy = true;
    try {
      // In-process first (procfind.js, ~1/10 the CPU and no child process every 5 s); tasklist
      // only when that cannot answer (no koffi), exactly as before.
      let running = isRunningFn(reader.exe);
      if (running !== true && running !== false) {
        const res = await runOnce('tasklist', ['/FI', 'IMAGENAME eq ' + reader.exe, '/FO', 'CSV', '/NH'], 6000);
        if (!res.ok && !res.out) {
          // tasklist itself failed — that is a reader error, not "not running",
          // and readOnce() repeats the reason so it cannot be papered over.
          presenceReason = 'cannot tell whether ' + appName() + ' is running: ' + (res.reason || 'tasklist failed');
          setReader('off', 'error', presenceReason);
          return;
        }
        running = res.out.toLowerCase().indexOf(reader.exe.toLowerCase()) !== -1;
      }
      presenceReason = '';
      if (running && !appRunning) {
        appSince = nowMs();
        cdpGaveUp = false;
        state.policy.needsRestart = false;
      }
      if (!running && appRunning) {
        closeCdp(appName() + ' closed');
        stopPsReader(appName() + ' closed');
      }
      appRunning = running;
    } finally {
      presenceBusy = false;
      syncReader();
    }
  }

  /* The 3 s reader runs only while the reader app does. While it is closed there is nothing to read, and
     a timer that wakes the main process every 3 s all day for nothing is the kind of idle cost
     next-week/quartz-efficiency.md measured. The presence check above starts it on the "running"
     edge (with one read straight away) and stops it on the "closed" edge; while the app runs it
     is the same 3 s setInterval as always. While it is closed, ONE read says so ("<app> is not
     running", or the presence error) and the next one waits until that answer changes. */
  let idleShown = '';             // the closed-state answer the pane was last given
  function readTick() {
    if (readBusy || stopped) return false;
    readBusy = true;
    Promise.resolve(readOnce())
      .catch((err) => setReader(state.reader.mode, 'error', 'the reader threw: ' + ((err && err.message) || 'unknown')))
      .then(() => { readBusy = false; });
    return true;
  }
  function syncReader() {
    if (stopped || !autoStart) return;
    if (appRunning) {
      idleShown = '';
      if (readTimer) return;
      readTimer = setInterval(readTick, READ_MS);
      if (readTimer.unref) readTimer.unref();
      readTick();
      return;
    }
    if (readTimer) { clearInterval(readTimer); readTimer = null; }
    const idle = presenceReason ? 'error: ' + presenceReason : 'closed';
    // A read still in flight from the running state is retried at the next presence check.
    if (idle !== idleShown && readTick()) idleShown = idle;
  }

  /* ----------------------------------------------------------------- CDP */

  function httpJson(url, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      let req;
      try {
        req = http.get(url, { timeout: timeoutMs }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (d) => { body += d; });
          res.on('end', () => {
            try { finish({ ok: true, json: JSON.parse(body) }); } catch (err) {
              finish({ ok: false, reason: 'bad JSON from ' + url + ': ' + (err && err.message) });
            }
          });
        });
      } catch (err) {
        finish({ ok: false, reason: (err && err.message) || 'request failed' });
        return;
      }
      req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } finish({ ok: false, reason: 'timed out' }); });
      req.on('error', (err) => finish({ ok: false, reason: (err && err.code) || (err && err.message) || 'request failed' }));
    });
  }

  function closeCdp(why) {
    if (cdpSocket) {
      try { cdpSocket.close(); } catch { /* ignore */ }
      try { cdpSocket.terminate && cdpSocket.terminate(); } catch { /* ignore */ }
    }
    cdpSocket = null;
    cdpTargetId = '';
    for (const [, pending] of cdpPending) pending.reject(new Error(why || 'socket closed'));
    cdpPending.clear();
  }

  function openCdp(wsUrl, targetId) {
    return new Promise((resolve, reject) => {
      let socket;
      try { socket = new WebSocketImpl(wsUrl, { perMessageDeflate: false }); } catch (err) { reject(err); return; }
      const guard = setTimeout(() => { try { socket.terminate(); } catch { /* ignore */ } reject(new Error('the debugger socket did not open in 4 s')); }, 4000);
      if (guard.unref) guard.unref();
      socket.on('open', () => {
        clearTimeout(guard);
        cdpSocket = socket;
        cdpTargetId = targetId;
        resolve(socket);
      });
      socket.on('message', (raw) => {
        let msg = null;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!msg || msg.id == null) return;
        const pending = cdpPending.get(msg.id);
        if (!pending) return;
        cdpPending.delete(msg.id);
        pending.resolve(msg);
      });
      socket.on('error', (err) => { clearTimeout(guard); if (cdpSocket === socket) closeCdp('socket error'); reject(err); });
      socket.on('close', () => { if (cdpSocket === socket) closeCdp('socket closed'); });
    });
  }

  function cdpSend(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!cdpSocket) { reject(new Error('no debugger socket')); return; }
      cdpMsgId += 1;
      const id = cdpMsgId;
      const timer = setTimeout(() => {
        cdpPending.delete(id);
        reject(new Error(method + ' did not answer in ' + seconds(timeoutMs)));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      cdpPending.set(id, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });
      try { cdpSocket.send(JSON.stringify({ id, method, params: params || {} })); } catch (err) {
        cdpPending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // Runs INSIDE the reader app's WebView2. Prefers a main/content landmark but falls
  // back to the whole body: an over-clever selector that returns nothing would
  // be worse than a little navigation chrome in the text. The topic line (what
  // picks the subject) comes from the config's reader.topicSelectors, tried in
  // order, with the page title as the fallback.
  const READ_FUNCTION = function (topicSelectors) {
    const text = (el) => (el && typeof el.innerText === 'string' ? el.innerText.replace(/\s+\n/g, '\n').trim() : '');
    const body = text(document.body);
    let picked = '';
    const landmarks = ['main', '[role="main"]', '#content', '#main', '.question', '.lesson', '#lesson'];
    for (let i = 0; i < landmarks.length; i += 1) {
      const el = document.querySelector(landmarks[i]);
      const t = text(el);
      if (t.length >= 40) { picked = t; break; }
    }
    if (picked.length < 40) picked = body;
    let topic = '';
    for (let i = 0; i < topicSelectors.length; i += 1) {
      const el = document.querySelector(topicSelectors[i]);
      const t = text(el);
      if (t && t.length < 120) { topic = t; break; }
    }
    if (!topic) topic = document.title || '';
    return { url: location.href, title: document.title || '', topic, text: picked.slice(0, 4096) };
  }.toString();
  function readExpression() {
    const selectors = reader ? reader.topicSelectors : TOPIC_SELECTORS_DEFAULT;
    return '(' + READ_FUNCTION + ')(' + JSON.stringify(selectors) + ')';
  }

  async function readViaCdp() {
    if (!WebSocketImpl) return { ok: false, reason: wsMissingReason || 'no WebSocket implementation' };
    if (!cdpSocket) {
      const listed = await httpJson('http://127.0.0.1:' + reader.port + '/json', 1500);
      if (!listed.ok) return { ok: false, reason: 'port ' + reader.port + ' did not answer (' + listed.reason + ')' };
      const targets = Array.isArray(listed.json) ? listed.json : [];
      // The first page target, or with reader.urlPatterns the first page whose URL holds one
      // of them (an app or browser with several pages open on the same port).
      const patterns = reader.urlPatterns;
      const page = targets.find((t) => t && t.type === 'page' && t.webSocketDebuggerUrl
        && (!patterns.length || patterns.some((p) => String(t.url || '').indexOf(p) !== -1)));
      if (!page) {
        return { ok: false, reason: 'port ' + reader.port + ' is open but has no page target'
          + (patterns.length ? ' whose URL matches reader.urlPatterns' : '') + ' (' + targets.length + ' targets)' };
      }
      try { await openCdp(page.webSocketDebuggerUrl, page.id); } catch (err) {
        return { ok: false, reason: 'could not attach the debugger: ' + ((err && err.message) || 'socket failed') };
      }
    }
    let msg;
    try {
      msg = await cdpSend('Runtime.evaluate', { expression: readExpression(), returnByValue: true, awaitPromise: false }, 3000);
    } catch (err) {
      closeCdp('evaluate failed');
      return { ok: false, reason: 'Runtime.evaluate failed: ' + ((err && err.message) || 'no answer') };
    }
    const result = msg && msg.result && msg.result.result;
    if (!result || result.type === 'undefined' || !result.value) {
      const thrown = msg && msg.result && msg.result.exceptionDetails;
      return { ok: false, reason: 'the page returned nothing' + (thrown ? ': ' + trimTo(JSON.stringify(thrown.text || thrown), 160) : '') };
    }
    const value = result.value;
    return {
      ok: true,
      text: trimTo(value.text || '', TEXT_CAP),
      topic: trimTo(value.topic || value.title || '', 160),
      title: trimTo(value.title || '', 160)
    };
  }

  /* ------------------------------------------------ the PowerShell reader */

  function startPsReader(why) {
    if (psChild) return true;
    // reader.script swaps in another reader that speaks the same stdin/stdout JSON.
    const script = reader && reader.script ? reader.script : path.join(scriptDir, READER_SCRIPT);
    if (!fs.existsSync(script)) {
      setReader('uia', 'error', 'the reader script is missing at ' + script + ' — no UIA or OCR reader');
      return false;
    }
    try {
      psChild = spawnFn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      psChild = null;
      setReader('uia', 'error', 'could not start notes-reader.ps1: ' + ((err && err.message) || 'spawn failed'));
      return false;
    }
    childreap.track(psChild, { images: ['powershell.exe', 'conhost.exe'], label: 'notes reader' });
    psBuffer = '';
    psChild.stdout.setEncoding('utf8');
    psChild.stdout.on('data', (chunk) => {
      psBuffer += chunk;
      let cut;
      while ((cut = psBuffer.indexOf('\n')) !== -1) {
        const line = psBuffer.slice(0, cut).trim();
        psBuffer = psBuffer.slice(cut + 1);
        if (!line) continue;
        let msg = null;
        try { msg = JSON.parse(line); } catch { continue; }
        const pending = psPending.get(msg.id);
        if (!pending) continue;
        psPending.delete(msg.id);
        pending.resolve(msg);
      }
    });
    let psErr = '';
    psChild.stderr.setEncoding('utf8');
    psChild.stderr.on('data', (chunk) => { psErr = trimTo((psErr + chunk).slice(-400), 400); });
    psChild.on('error', (err) => {
      setReader(state.reader.mode, 'error', 'notes-reader.ps1 error: ' + ((err && err.message) || 'unknown'));
    });
    psChild.on('close', (code) => {
      psChild = null;
      for (const [, pending] of psPending) pending.resolve({ ok: false, reason: 'the reader script exited' });
      psPending.clear();
      if (stopped) return;
      psRestarts += 1;
      setReader(state.reader.mode, 'error',
        'notes-reader.ps1 exited (code ' + code + (psErr ? ', ' + psErr.trim() : '') + '); restart #' + psRestarts + ' on the next read');
    });
    if (why) schedulePush();
    return true;
  }

  function stopPsReader(why) {
    if (!psChild) return;
    try { psChild.stdin.write(JSON.stringify({ id: 0, cmd: 'quit' }) + '\n'); } catch { /* ignore */ }
    const child = psChild;
    psChild = null;
    setTimeout(() => { childreap.killTree(child, 'reader stopped'); }, 300).unref?.();
    if (why) { /* the caller sets the visible reason */ }
  }

  function psCommand(cmd, extra, timeoutMs) {
    return new Promise((resolve) => {
      if (!startPsReader('needed for ' + cmd)) { resolve({ ok: false, reason: state.reader.reason }); return; }
      psMsgId += 1;
      const id = psMsgId;
      const payload = Object.assign({ id, cmd, process: reader.proc }, extra || {});
      const timer = setTimeout(() => {
        psPending.delete(id);
        resolve({ ok: false, reason: cmd + ' did not answer in ' + seconds(timeoutMs) });
      }, timeoutMs);
      if (timer.unref) timer.unref();
      psPending.set(id, { resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
      try { psChild.stdin.write(JSON.stringify(payload) + '\n'); } catch (err) {
        psPending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, reason: 'could not talk to notes-reader.ps1: ' + ((err && err.message) || 'write failed') });
      }
    });
  }

  /* ----------------------------------------------------------- one read pass */

  async function readOnce(opts) {
    if (stopped) return { ok: false, reason: 'stopped' };
    if (!reader) {
      setReader('off', 'waiting', noReaderReason());
      return { ok: false, mode: 'off', reason: noReaderReason() };
    }
    const force = !!(opts && opts.force);

    if (!appRunning) {
      const why = presenceReason || appName() + ' is not running';
      setReader('off', presenceReason ? 'error' : 'waiting', why);
      settleHash = '';
      settleCount = 0;
      return { ok: false, mode: 'off', reason: why };
    }

    const upMs = appSince ? nowMs() - appSince : 0;

    // (a) CDP, if the policy is in place and it has not already proved useless.
    if (state.policy.installed && !cdpGaveUp) {
      const via = await readViaCdp();
      if (via.ok) {
        state.reader.port = reader.port;
        handleRead('cdp', via.text, via.topic, 'reading the page over the debugger on port ' + reader.port);
        return { ok: true, mode: 'cdp', chars: via.text.length, reason: state.reader.reason };
      }
      if (upMs > CDP_GIVE_UP_MS) {
        cdpGaveUp = true;
        setReader('uia', 'waiting', 'policy ignored by ' + appName() + ' (MSIX?), falling back to UIA — ' + via.reason);
      } else {
        setReader('cdp', 'waiting',
          'waiting for the debugger port ' + reader.port + ' (' + via.reason + '); '
          + Math.round(upMs / 1000) + ' s since ' + appName() + ' started, UIA takes over at '
          + Math.round(CDP_GIVE_UP_MS / 1000) + ' s');
        return { ok: false, mode: 'cdp', reason: state.reader.reason };
      }
    } else if (!state.policy.installed) {
      // Not an error: just say plainly why the best reader is not in play.
      cdpGaveUp = true;
    }

    // (b) UI Automation.
    const uia = await psCommand('read', force ? { force: true } : null, 12000);
    if (uia && uia.ok && String(uia.text || '').trim().length >= UIA_MIN_CHARS) {
      // The script's change gate is off (events missed a change, or could not subscribe):
      // every read walks the whole tree again. Say so rather than burn the CPU quietly.
      const gate = uia.gate ? ' (re-reading every time: ' + trimTo(String(uia.gate), 200) + ')' : '';
      const why = (state.policy.installed
        ? 'reading the accessibility tree (the debugger port never opened)'
        : 'reading the accessibility tree (no remote-debugging policy installed — run "install-policy" for the sharper CDP reader)') + gate;
      handleRead('uia', trimTo(uia.text, TEXT_CAP), trimTo(uia.title || '', 160), why);
      return { ok: true, mode: 'uia', chars: String(uia.text).length, reason: state.reader.reason };
    }

    const uiaChars = uia && uia.ok ? String(uia.text || '').trim().length : -1;
    const uiaWhy = uia && uia.ok
      ? 'the accessibility tree returned ' + uiaChars + ' characters (under ' + UIA_MIN_CHARS + ')'
      : 'UIA failed (' + ((uia && uia.reason) || 'no answer') + ')';

    // (c) OCR.
    const ocr = await psCommand('ocr', null, 20000);
    if (ocr && ocr.ok && String(ocr.text || '').trim().length > 0) {
      handleRead('ocr', trimTo(ocr.text, TEXT_CAP), trimTo(ocr.title || '', 160),
        'using OCR: ' + uiaWhy);
      return { ok: true, mode: 'ocr', chars: String(ocr.text).length, reason: state.reader.reason };
    }

    setReader('ocr', 'error', 'could not read the screen — ' + uiaWhy
      + ', and OCR failed (' + ((ocr && ocr.reason) || 'no answer') + ')');
    return { ok: false, mode: 'ocr', reason: state.reader.reason };
  }

  // One successful read: settle it, and when it is genuinely new, ask the helper.
  function handleRead(mode, text, topic, why) {
    state.reader.lastReadAt = nowMs();
    const hash = hashText(text);
    const current = state.reader.question;

    if (current && current.hash === hash) {
      setReader(mode, 'ok', why + ' — same question as the last read');
      if (topic && topic !== current.topic) { current.topic = topic; resolveSubject(); }
      return;
    }
    if (settleHash !== hash) {
      settleHash = hash;
      settleCount = 1;
      setReader(mode, 'ok', why + ' — a new question appeared, waiting for it to settle');
      return;
    }
    settleCount += 1;
    if (settleCount < 2) {
      setReader(mode, 'ok', why + ' — waiting for the question to settle');
      return;
    }

    state.reader.question = { text, hash, topic: topic || '' };
    setReader(mode, 'ok', why + ' — question read at ' + new Date().toLocaleTimeString());
    resolveSubject();
    askAboutCurrentQuestion('a new question appeared');
  }

  /* ------------------------------------------------------------- the helper */

  // The budget snapshot: a harness's getBudget(), else the budget.js reader, else null.
  function getBudget() {
    if (injectedBudget) return injectedBudget();
    return budgetReader ? budgetReader.snapshot() : null;
  }

  function budgetVerdict() {
    if (!injectedBudget && !budgetReader) {
      const why = budgetFailure
        || (!budgetDir ? 'no budget source is configured (budgetDir in ' + CONFIG_FILE + ')'
          : 'no budget reader is wired in');
      return { pause: false, note: 'budget unknown: ' + why + ', helper still running' };
    }
    let snap = null;
    try { snap = getBudget(); } catch (err) {
      return { pause: false, note: 'budget unknown (' + ((err && err.message) || 'snapshot threw') + '), helper still running' };
    }
    if (!snap || typeof snap !== 'object') {
      return { pause: false, note: 'budget unknown (no snapshot), helper still running' };
    }
    const usable = (snap.state === 'ok' || snap.state === 'stale')
      && (snap.fiveHour || snap.week);
    if (!usable) {
      return {
        pause: false,
        note: 'budget unknown (' + (snap.reason || snap.state || 'unusable snapshot') + '), helper still running'
      };
    }
    const five = snap.fiveHour && Number.isFinite(snap.fiveHour.pct) ? snap.fiveHour.pct : null;
    const week = snap.week && Number.isFinite(snap.week.pct) ? snap.week.pct : null;
    if (five !== null && five >= BUDGET_PAUSE_FIVE_HOUR_PCT) {
      return { pause: true, note: 'helper paused, five-hour window at ' + Math.round(five) + ' %' };
    }
    if (week !== null && week >= BUDGET_PAUSE_WEEK_PCT) {
      return { pause: true, note: 'helper paused, week at ' + Math.round(week) + ' %' };
    }
    const bits = [];
    if (five !== null) bits.push('5H ' + Math.round(five) + ' %');
    if (week !== null) bits.push('week ' + Math.round(week) + ' %');
    return { pause: false, note: bits.join(', ') + (snap.state === 'stale' ? ' (stale: ' + (snap.reason || '') + ')' : '') };
  }

  function idleReason(extra) {
    const bits = [];
    if (state.helper.lastMs) bits.push('last ' + seconds(state.helper.lastMs));
    bits.push(money(helperCostUsd) + ' this session');
    return (extra ? extra + ' · ' : 'idle · ') + bits.join(' · ');
  }

  function buildFirstPrompt(row, index, question) {
    return [
      'You are a lookup for one person\'s own study notes. You never tutor and you never answer questions.',
      '',
      index,
      '',
      'Every message you receive from now on is the raw on-screen text of one question on this subject,',
      'read off the screen. Your ONLY job is to name the section of the notes above that the',
      'question is testing, so the reader can re-read it.',
      '',
      'Reply with exactly one JSON object and nothing else — no prose, no markdown, no code fence:',
      '{"section":"<a section id from the list above, or null>","confidence":<0 to 1>}',
      '',
      'Rules:',
      '- NEVER give the answer to the question, a hint, a worked step, or any explanation.',
      '- "section" must be an id copied exactly from the list above, or null when nothing fits.',
      '- confidence is your own estimate that this is the right section.',
      '',
      'First question:',
      trimTo(question, TEXT_CAP)
    ].join('\n');
  }

  function buildResumePrompt(question) {
    return [
      'Next question. Same rules: reply with only {"section":"<id or null>","confidence":<0 to 1>}.',
      '',
      trimTo(question, TEXT_CAP)
    ].join('\n');
  }

  // Fish the {"section":...} object out of whatever the model wrote.
  function parseHelperAnswer(resultText) {
    const raw = String(resultText == null ? '' : resultText).trim();
    const fenced = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const candidates = [fenced];
    const brace = fenced.match(/\{[\s\S]*\}/);
    if (brace) candidates.push(brace[0]);
    for (const cand of candidates) {
      try {
        const parsed = JSON.parse(cand);
        if (parsed && typeof parsed === 'object' && 'section' in parsed) {
          const confidence = Number(parsed.confidence);
          return {
            ok: true,
            section: parsed.section == null ? null : String(parsed.section),
            confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0
          };
        }
      } catch { /* try the next shape */ }
    }
    return { ok: false, reason: 'the helper did not answer JSON ("' + trimTo(raw.replace(/\s+/g, ' '), 120) + '")' };
  }

  function runClaude(args, prompt, timeoutMs) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnFn(claudeBin, args, { windowsHide: true, cwd: notesDir, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ ok: false, spawnFailed: true, reason: 'could not start the helper (' + claudeBin + '): ' + ((err && err.message) || 'spawn failed') });
        return;
      }
      // Claude Code starts git.exe (and a console host); child.kill() alone would leave them running.
      childreap.track(child, { images: [path.basename(claudeBin), 'claude.exe', 'git.exe', 'conhost.exe'], label: 'notes helper' });
      const record = { child, killed: false };
      let out = '';
      let errOut = '';
      let done = false;
      const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => {
        record.killed = 'timeout';
        childreap.killTree(child, 'timed out');
        finish({ ok: false, timedOut: true, reason: 'the helper did not answer in ' + Math.round(timeoutMs / 1000) + ' s' });
      }, timeoutMs);
      if (timer.unref) timer.unref();

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { errOut += d; });
      child.on('error', (err) => finish({ ok: false, spawnFailed: true, reason: 'the helper failed to start: ' + ((err && err.message) || 'spawn error') }));
      child.on('close', (code) => {
        if (record.killed === 'superseded') { finish({ ok: false, superseded: true, reason: 'superseded by a newer question' }); return; }
        if (record.killed === 'timeout') return;                    // already resolved
        let json = null;
        const brace = out.indexOf('{');
        if (brace !== -1) { try { json = JSON.parse(out.slice(brace)); } catch { json = null; } }
        if (!json) {
          finish({
            ok: false, code,
            reason: 'the helper printed no JSON (exit ' + code + ')'
              + (errOut.trim() ? ': ' + trimTo(errOut.trim().replace(/\s+/g, ' '), 200) : '')
          });
          return;
        }
        finish({ ok: code === 0 && !json.is_error, code, json, reason: json.is_error ? 'the helper reported an error' : '' });
      });

      try { child.stdin.write(prompt); child.stdin.end(); } catch (err) {
        finish({ ok: false, reason: 'could not send the question to the helper: ' + ((err && err.message) || 'write failed') });
      }
      if (inflight) inflight.record = record;
    });
  }

  function helperArgs(model, resumeId) {
    // --tools "" is the documented way to hand the session no tools at all; the
    // helper must only read the index we gave it and answer.
    //
    // --safe-mode is here for money, and it is not a small difference. Measured
    // on 2026-09-12 against the real CLI: without it a first call costs $0.041
    // and a resumed one $0.208, because CLAUDE.md, the auto-memory, skills,
    // hooks and MCP servers are re-sent and re-cached on every invocation. With
    // it: $0.0088 and $0.0015, and about half the wall clock. It also keeps
    // the user's global instructions out of a session whose only job is to name a
    // section. The prompt goes in over stdin, never argv: a 24 KB index would
    // be near Windows' command-line limit.
    const args = ['-p', '--output-format', 'json', '--model', model,
      '--dangerously-skip-permissions', '--tools', '', '--safe-mode'];
    if (resumeId) args.push('--resume', resumeId);
    return args;
  }

  async function askHelper(subjectId, questionText, hash) {
    const row = subjectById(subjectId);
    if (!row) return { ok: false, reason: 'unknown subject "' + subjectId + '"' };
    const index = indexes.get(subjectId);
    if (!index) return { ok: false, reason: 'no notes index for ' + subjectId };

    const model = state.helper.model || HELPER_MODEL_DEFAULT;
    let session = sessions.get(subjectId) || null;
    const startedAt = nowMs();

    // One child at a time: a newer question kills the older one, visibly.
    if (inflight && inflight.record && inflight.record.child) {
      inflight.record.killed = 'superseded';
      childreap.killTree(inflight.record.child, 'superseded');
    }
    inflight = { subjectId, hash, record: null };

    state.helper.sessionId = session ? session.sessionId : null;
    setHelper('thinking', 'asking ' + model + ' which section of ' + row.name + ' this is');

    let attempt = session ? 'resume' : 'fresh';
    let res = await runClaude(
      helperArgs(model, session ? session.sessionId : null),
      session ? buildResumePrompt(questionText) : buildFirstPrompt(row, index.text, questionText),
      helperTimeoutMs
    );

    if (!res.ok && res.superseded) return { ok: false, superseded: true, reason: res.reason };

    let resumeNote = '';
    if (!res.ok && attempt === 'resume' && !res.timedOut && !res.spawnFailed) {
      // The session file can be gone, compacted away or written by another
      // Claude version: start one fresh rather than going dark. A timeout or a
      // missing binary is NOT that — retrying either one just doubles the wait
      // (and the cost), so those fall straight through to the error below.
      resumeNote = 'resume failed (' + (res.reason || 'unknown') + '), started a fresh session';
      sessions.delete(subjectId);
      session = null;
      attempt = 'fresh';
      res = await runClaude(helperArgs(model, null), buildFirstPrompt(row, index.text, questionText), helperTimeoutMs);
      if (!res.ok && res.superseded) return { ok: false, superseded: true, reason: res.reason };
    }

    const tookMs = nowMs() - startedAt;
    state.helper.lastMs = tookMs;
    if (inflight && inflight.hash === hash) inflight = null;

    if (!res.ok) {
      setHelper('error', (resumeNote ? resumeNote + '; ' : '') + (res.reason || 'the helper failed')
        + ' · ' + money(helperCostUsd) + ' this session');
      return { ok: false, reason: state.helper.reason };
    }

    const json = res.json || {};
    if (typeof json.session_id === 'string' && json.session_id) {
      sessions.set(subjectId, { sessionId: json.session_id, calls: (session ? session.calls : 0) + 1 });
      state.helper.sessionId = json.session_id;
    }
    if (Number.isFinite(json.total_cost_usd)) helperCostUsd += json.total_cost_usd;

    const answer = parseHelperAnswer(json.result);
    if (!answer.ok) {
      setHelper('error', (resumeNote ? resumeNote + '; ' : '') + answer.reason + ' · ' + money(helperCostUsd) + ' this session');
      return { ok: false, reason: state.helper.reason };
    }

    let sectionId = answer.section;
    let title = '';
    let reason = (resumeNote ? resumeNote + '; ' : '')
      + 'matched by ' + model + ' in ' + seconds(tookMs) + (attempt === 'fresh' ? ' (new session)' : '');
    if (sectionId) {
      const hit = row.sections.find((s) => s.id === sectionId);
      if (hit) {
        title = hit.title;
      } else {
        reason = (resumeNote ? resumeNote + '; ' : '') + 'helper answered an unknown section ("' + trimTo(sectionId, 60) + '")';
        sectionId = null;
        answer.confidence = 0;
      }
    } else {
      reason = (resumeNote ? resumeNote + '; ' : '') + 'the helper found no section that fits this question';
    }

    const match = {
      hash,
      sectionId,
      confidence: answer.confidence,
      title,
      at: nowMs(),
      reason
    };
    if (!state.pinned || !state.match) {
      state.match = match;
      pinnedBaseReason = '';
    } else {
      // Pinned: keep the match the user froze, but say out loud that a newer one is
      // waiting. The base reason is kept separately so this cannot grow every
      // time another question goes past.
      if (!pinnedBaseReason) pinnedBaseReason = state.match.reason || '';
      state.match.reason = pinnedBaseReason + ' · pinned: a newer match for "'
        + (title || 'no section') + '" is being held back';
    }
    setHelper('idle', idleReason(null));
    schedulePush();
    return { ok: true, match };
  }

  async function askAboutCurrentQuestion(why) {
    const question = state.reader.question;
    if (!question) return { ok: false, reason: 'there is no question to match yet' };
    if (!state.helper.enabled) {
      setHelper('off', 'helper is switched off' + (why ? ' — ' + why + ' was not matched' : ''));
      return { ok: false, reason: state.helper.reason };
    }
    const subjectId = resolveSubject();
    if (!subjectId) {
      setHelper('idle', 'nothing to match yet: ' + state.subject.reason);
      return { ok: false, reason: state.subject.reason };
    }
    const verdict = budgetVerdict();
    if (verdict.pause) {
      setHelper('paused', verdict.note);
      return { ok: false, reason: verdict.note };
    }
    const out = await askHelper(subjectId, question.text, question.hash);
    if (out.ok && verdict.note && state.helper.state === 'idle') {
      setHelper('idle', idleReason(null) + ' · ' + verdict.note);
    }
    return out;
  }

  /* -------------------------------------------------------------- commands */

  async function command(name, arg) {
    const payload = arg && typeof arg === 'object' ? arg : {};
    if (String(name) === 'set-dir') return setDir(payload);
    // Off: every other command has nothing to act on, and says why rather than pretending.
    if (!state.configured) return { ok: false, reason: 'the notes pane is off: ' + state.reason };
    switch (String(name)) {
      case 'set-subject': {
        const id = payload.id == null ? null : String(payload.id);
        if (id && !subjectById(id)) return { ok: false, reason: 'no subject called "' + id + '"' };
        manualSubjectId = id;
        saveStore();
        resolveSubject();
        schedulePush();
        if (id && state.reader.question) askAboutCurrentQuestion('the subject changed');
        return { ok: true, subject: clone(state.subject) };
      }
      case 'set-helper': {
        if (typeof payload.model === 'string' && payload.model.trim()) {
          state.helper.model = payload.model.trim();
          sessions.clear();                       // a different model needs its own session
          state.helper.sessionId = null;
        }
        if (payload.on !== undefined) state.helper.enabled = !!payload.on;
        saveStore();
        setHelper(state.helper.enabled ? 'idle' : 'off',
          state.helper.enabled ? idleReason('helper on, ' + state.helper.model) : 'helper is switched off');
        return { ok: true, helper: clone(state.helper) };
      }
      case 'probe': {
        await checkPresence();
        const out = await readOnce({ force: true });   // a probe is a real read, never the cached one
        return { ok: !!out.ok, mode: out.mode || state.reader.mode, chars: out.chars || 0, reason: out.reason || state.reader.reason };
      }
      case 'install-policy':
        return installPolicy();
      case 'ask': {
        const text = trimTo(String(payload.text == null ? '' : payload.text), TEXT_CAP);
        if (!text.trim()) return { ok: false, reason: 'nothing to match: the text was empty' };
        // A pasted question carries no topic, so keep whatever topic the last
        // real read found: otherwise "ask" would silently undo the subject pick.
        const prevTopic = state.reader.question ? state.reader.question.topic : '';
        state.reader.question = { text, hash: hashText(text), topic: trimTo(String(payload.topic || prevTopic || ''), 160) };
        state.reader.lastReadAt = nowMs();
        setReader(state.reader.mode, 'ok', 'showing a pasted question (ask), not a live read from ' + appName());
        resolveSubject();
        const out = await askAboutCurrentQuestion('a pasted question');
        return out.ok
          ? { ok: true, hash: state.reader.question.hash, match: clone(state.match) }
          : { ok: false, reason: out.reason, hash: state.reader.question.hash };
      }
      case 'pin': {
        state.pinned = payload.on === undefined ? !state.pinned : !!payload.on;
        if (!state.pinned && state.match && pinnedBaseReason) {
          state.match.reason = pinnedBaseReason;      // unpinning drops the "held back" note
        }
        pinnedBaseReason = '';
        saveStore();
        schedulePush();
        return { ok: true, pinned: state.pinned };
      }
      default:
        return { ok: false, reason: 'unknown command "' + String(name) + '"' };
    }
  }

  /* ------------------------------------------------------------------ boot */

  // What the strip says when there is no reader app to read from.
  function noReaderReason() {
    return 'no reader app is configured (reader.exe in ' + CONFIG_FILE + '): pick a subject by hand, '
      + 'or paste a question with "ask"';
  }

  /*
   * The budget guard's source, made only while the pane is on and the config names
   * a statusline folder: an off pane (or one without budgetDir) polls nothing.
   */
  function startBudget() {
    if (injectedBudget || budgetReader || !budgetModule || !budgetDir) return;
    try {
      budgetReader = budgetModule.create({ app: opts.app, dir: budgetDir });
    } catch (err) {
      budgetReader = null;
      budgetFailure = 'the budget reader would not start (' + ((err && err.message) || 'create failed') + ')';
    }
  }

  // Everything the pane runs, for a configured folder. Only ever called with state.configured.
  function start() {
    scanSubjects('startup');
    if (!state.helper.enabled) setHelper('off', 'helper is switched off');
    startBudget();
    if (!autoStart) {
      setReader('off', 'waiting', 'the reader is not polling (autoStart off)');
      return;
    }
    startWatching();
    if (!reader) {
      setReader('off', 'waiting', noReaderReason());
      return;
    }
    readPolicy();
    // The first presence check reads straight away (syncReader), so the pane never sits on
    // "starting up" for a whole poll interval before it learns the reader app is not running.
    checkPresence().catch(() => {});
    presenceTimer = setInterval(() => { checkPresence(); }, PRESENCE_MS);
    if (presenceTimer.unref) presenceTimer.unref();
  }

  // Everything start() began, stopped; the module itself stays usable (set-dir restarts it).
  function halt(why) {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    if (watchDebounce) { clearTimeout(watchDebounce); watchDebounce = null; }
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
    if (readTimer) { clearInterval(readTimer); readTimer = null; }
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
    closeCdp(why);
    stopPsReader(why);
    if (inflight && inflight.record && inflight.record.child) {
      inflight.record.killed = 'superseded';
      childreap.killTree(inflight.record.child, 'pane stopped');
    }
    inflight = null;
    if (budgetReader) { try { budgetReader.stop(); } catch { /* best effort */ } budgetReader = null; }
    appRunning = false;
    appSince = 0;
    presenceReason = '';
  }

  /*
   * 'set-dir' {dir|null}: Settings > Notes pane picked a folder, or turned the pane
   * off. The folder must exist; it is written to notes-pane.json (every other key
   * kept), and the pane restarts on it from a clean slate: a helper session or a
   * match from another folder's notes would point at sections that are not there.
   */
  function setDir(payload) {
    const raw = payload.dir;
    if (raw !== null && raw !== undefined && typeof raw !== 'string') {
      return { ok: false, reason: 'set-dir needs {dir: "<folder>"} or {dir: null}' };
    }
    const dir = typeof raw === 'string' ? raw.trim() : '';
    if (dir) {
      if (!path.isAbsolute(dir)) return { ok: false, reason: 'the notes folder must be a full path, not "' + dir + '"' };
      let st = null;
      try { st = fs.statSync(dir); } catch { st = null; }
      if (!st || !st.isDirectory()) return { ok: false, reason: 'that is not a folder: ' + dir };
    }
    const why = writeConfig({ dir: dir || undefined });
    if (why) return { ok: false, reason: why };

    halt(dir ? 'the notes folder changed' : 'the notes pane was turned off');
    indexes.clear();
    sessions.clear();
    settleHash = '';
    settleCount = 0;
    state.match = null;
    state.subjects = [];
    state.reader.question = null;
    state.helper.sessionId = null;
    state.subject = { id: null, source: 'none', reason: 'no subject detected: pick one' };
    loadStore();
    applyConfig();
    if (state.configured) start();
    else setReader('off', 'waiting', 'the notes pane is off');
    schedulePush();
    return { ok: true, configured: state.configured, dir: state.dir, reason: state.reason };
  }

  if (ipcMain && typeof ipcMain.handle === 'function') {
    ipcMain.handle('notes:describe', (event) => (gate(event) ? describe() : null));
    ipcMain.handle('notes:command', async (event, name, arg) => {
      if (!gate(event)) return null;
      try {
        return await command(name, arg);
      } catch (err) {
        return { ok: false, reason: 'the command threw: ' + ((err && err.message) || 'unknown error') };
      }
    });
  }

  loadStore();
  applyConfig();
  if (state.configured) {
    start();
  } else {
    // Off: nothing scans, watches, polls or spawns. describe() carries the reason.
    setReader('off', 'waiting', 'the notes pane is off');
    setHelper('off', 'the notes pane is off');
  }

  function stop() {
    stopped = true;
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    halt('shutting down');
  }

  return {
    stop,
    describe,
    command,
    // Test seams. Nothing in the app calls these; the harness drives the state
    // machine through them so a verification run needs neither a reader app nor money.
    __test: {
      state,
      readOnce,
      handleRead,
      resolveSubject,
      matchTopicToSubject,
      budgetVerdict,
      parseHelperAnswer,
      indexFor: (id) => indexes.get(id),
      sessions,
      setAppRunning(running) { appRunning = !!running; appSince = running ? nowMs() - 60000 : 0; },
      // One presence check, as the 5 s timer runs it (procfind-harness.js).
      checkPresence,
      presence: () => ({ running: appRunning, reason: presenceReason, reader: state.reader }),
      readerTimer: () => !!readTimer,
      costUsd: () => helperCostUsd,
      // What the config resolved to, and what is running: an off pane must show all false.
      config: () => clone({ notesDir, reader, aliases, claudeBin, budgetDir }),
      running: () => ({
        scan: !!scanTimer, watcher: !!watcher, presence: !!presenceTimer, read: !!readTimer,
        budget: !!budgetReader, ps: !!psChild, cdp: !!cdpSocket, helper: !!inflight
      })
    }
  };
}

module.exports = { create };
