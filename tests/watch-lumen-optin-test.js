'use strict';
// tests/watch-lumen-optin-test.js -- Lumen is opt-in (watch.json "v": 2; watch-main.js cleanPrefs/loadPrefs).
//
//   - a watch.json from BEFORE opt-in (no "v") keeps reading exactly as it did: every absent service,
//     background and hover-preview flag is ON; the file is rewritten ONCE with those values explicit plus
//     v: 2, and every other key (leagues, the TMDB key, keys this build does not know) is copied through
//     byte-identical. The fixture below has the shape of a real pre-opt-in profile: four services true,
//     NO hulu key, no background / tilePreview keys, one league and a TMDB key (a made-up one);
//   - NO watch.json is a fresh install: every service off, background off, nothing written, and no read,
//     fetch, search or sports request reaches a service, whatever the clocks do;
//   - a v: 2 file means what it says (only an explicit true is on);
//   - an unreadable watch.json reads as before opt-in, is NOT rewritten, and Settings says so;
//   - watch.json's optional "embedReferer" replaces the YouTube embed Referer (watch/preview.js);
//   - sports-main.js reads ESPN only while ESPN is on.
// Builds its own fixtures in a temp dir; never reads a real profile. Run by watch-harness.js (it picks up
// tests/watch-lumen-*-test.js), or alone: node tests/watch-lumen-optin-test.js
var fs = require('fs');
var os = require('os');
var path = require('path');
var Shape = require('../watch/shape');
var Preview = require('../watch/preview');
var WM = require('../watch-main');
var SportsMain = require('../sports-main');

var PUBLIC_REFERER = 'https://github.com/atlas-studio-software/quartz';

/* A watch-main with fakes: a clock, timers we fire by hand, and a count of everything that would touch a service. */
function world(dir) {
  var t = Date.parse('2026-10-19T20:00:00Z');
  var timers = [];
  var touched = [];   // every runStep / fetch: a fresh install must leave this empty
  var logs = [];
  var adapters = {};
  Shape.SERVICE_IDS.forEach(function (id) {
    adapters[id] = {
      id: id,
      steps: function () { return [{ name: 'home', type: id === 'espn' ? 'fetch' : 'view', url: Shape.serviceById(id).home }]; },
      parse: function () { return { state: 'ok', items: [], profile: '', events: [] }; },
    };
  });
  adapters.youtube.searchUrl = function (q) { return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q); };
  adapters.youtube.parseSearch = function () { return []; };
  var deps = {
    dir: dir,
    adapters: adapters,
    bootGraceMs: 0,
    now: function () { return t; },
    setTimeout: function (fn, ms) { var h = { fn: fn, at: t + ms, unref: function () {} }; timers.push(h); return h; },
    clearTimeout: function (h) { var i = timers.indexOf(h); if (i !== -1) timers.splice(i, 1); },
    freeGb: function () { return 16; },
    send: function () {},
    log: function (l) { logs.push(l); },
    isBundledPage: function (u) { return typeof u === 'string' && u.indexOf('file:///app/') === 0; },
    fetch: function (u) { touched.push('fetch:' + u); return Promise.resolve({ ok: true, status: 200, headers: { get: function () { return null; } }, text: function () { return Promise.resolve('{}'); }, json: function () { return Promise.resolve({}); } }); },
    runStep: function (step) { touched.push('step:' + step.url); return Promise.resolve({ ok: true, url: step.url, finalUrl: step.url, status: 200, extracted: { ok: true }, captures: [], error: null }); },
    test: { gameRunning: function () { return ''; }, windowShowing: function () { return true; }, saverOn: function () { return false; } },
  };
  var w = { dir: dir, touched: touched, logs: logs, timers: timers };
  w.wm = WM.create(deps);
  w.advance = async function (ms) {
    var end = t + ms;
    for (var guard = 0; guard < 500; guard++) {
      var due = timers.filter(function (h) { return h.at <= end; }).sort(function (a, b) { return a.at - b.at; })[0];
      if (!due) break;
      t = Math.max(t, due.at);
      timers.splice(timers.indexOf(due), 1);
      try { due.fn(); } catch (e) { /* the module logs its own */ }
      for (var i = 0; i < 20; i++) await new Promise(function (r) { setImmediate(r); });
    }
    t = end;
  };
  w.guest = function () {
    var pushed = [];
    var g = {
      pushed: pushed,
      getURL: function () { return 'file:///app/watch.html?theme=dark'; },
      isDestroyed: function () { return false; },
      executeJavaScript: function (code) {
        var m = /^window\.(__\w+) && window\.\1\(([\s\S]*)\)$/.exec(code);
        if (m) pushed.push({ fn: m[1], payload: JSON.parse(m[2]) });
        return Promise.resolve();
      },
      on: function () {},
      say: function (line) { return w.wm.handleGuestLine(g, line); },
    };
    w.wm.watchGuest(g);
    return g;
  };
  w.done = function () { try { w.wm.stop(); } catch (e) { /* fine */ } };
  return w;
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-optin-')); }
function settle() { var p = Promise.resolve(); for (var i = 0; i < 30; i++) p = p.then(function () { return new Promise(function (r) { setImmediate(r); }); }); return p; }
function allOn(d) { return d.services.every(function (s) { return s.enabled === true; }); }
function allOff(d) { return d.services.every(function (s) { return s.enabled === false; }); }

module.exports = async function (check) {
  try {
    /* ---- cleanPrefs: the three kinds of file ---- */
    var fresh = WM.cleanPrefs(null);
    check(Shape.SERVICE_IDS.every(function (id) { return fresh.enabled[id] === false; }) && fresh.background === false && fresh.v === WM.PREFS_VERSION,
      'cleanPrefs: no watch.json = every service off, background off, v: 2', fresh);
    var legacy = WM.cleanPrefs({ enabled: { youtube: true, prime: false } });
    check(legacy.enabled.youtube && legacy.enabled.hulu && legacy.enabled.disney && legacy.enabled.espn && legacy.enabled.prime === false && legacy.background === true && legacy.tilePreview === true,
      'cleanPrefs: a file without "v" reads absent as ON, an explicit false stays off', legacy);
    var v2 = WM.cleanPrefs({ v: 2, enabled: { youtube: true, prime: 'yes' } });
    check(v2.enabled.youtube === true && v2.enabled.prime === false && v2.enabled.hulu === false && v2.background === false && v2.tilePreview === true,
      'cleanPrefs: v: 2 = only an explicit true is on (background too)', v2);
    check(WM.isLegacyPrefs({}) && WM.isLegacyPrefs({ v: 1 }) && !WM.isLegacyPrefs({ v: 2 }) && !WM.isLegacyPrefs(null), 'isLegacyPrefs: no "v" (or below 2) only');
    check(WM.cleanPrefs({ v: 2, embedReferer: 'https://example.org/app' }).embedReferer === 'https://example.org/app' &&
      !('embedReferer' in WM.cleanPrefs({ v: 2, embedReferer: 'http://example.org/' })) && !('embedReferer' in WM.cleanPrefs({ v: 2, embedReferer: 'https://u:p@example.org/' })) &&
      !('embedReferer' in WM.cleanPrefs({ v: 2 })), 'cleanPrefs: embedReferer kept only as a plain https URL');

    /* ---- a watch.json from before opt-in: zero change, then made explicit + v: 2 ---- */
    var dir = tmp();
    var file = path.join(dir, WM.PREFS_FILE);
    var before = { enabled: { youtube: true, disney: true, prime: true, espn: true }, leagues: ['nhl'], tmdbKey: 'fixture-0123456789abcdef0123456789abcdef', somethingNewer: { keep: [1, 'two'] } };
    fs.writeFileSync(file, JSON.stringify(before, null, 2));
    var w = world(dir);
    var d = w.wm.describe();
    check(allOn(d) && d.services.length === Shape.SERVICE_IDS.length, 'legacy: every service reads ON, hulu (absent) too', d.services.map(function (s) { return s.id + ':' + s.enabled; }));
    check(d.background.on === true && d.tilePreview.on === true, 'legacy: background on and hover previews on (both absent)', { bg: d.background.on, tp: d.tilePreview.on });
    check(d.tmdb.hasKey === true && d.leagues.join() === 'nhl', 'legacy: the TMDB key and the league are read');
    var after = JSON.parse(fs.readFileSync(file, 'utf8'));
    check(after.v === 2, 'legacy: the file is rewritten with v: 2', after.v);
    check(Shape.SERVICE_IDS.every(function (id) { return after.enabled[id] === true; }) && after.background === true && after.tilePreview === true,
      'legacy: the rewrite makes every value explicit and the same (hulu: true, background: true, tilePreview: true)', { enabled: after.enabled, bg: after.background, tp: after.tilePreview });
    check(JSON.stringify(after.leagues) === JSON.stringify(before.leagues) && after.tmdbKey === before.tmdbKey && JSON.stringify(after.somethingNewer) === JSON.stringify(before.somethingNewer),
      'legacy: leagues, the TMDB key and unknown keys are copied through byte-identical');
    check(!fs.existsSync(file + '.tmp'), 'legacy: no temp file left behind');
    check(Preview.currentEmbedReferer() === PUBLIC_REFERER && d.embedReferer === PUBLIC_REFERER, 'legacy without embedReferer: the public default Referer', d.embedReferer);
    w.done();
    // A second start on the rewritten file: the same values, and the file is not touched again.
    var bytes = fs.readFileSync(file, 'utf8');
    var w2 = world(dir);
    var d2 = w2.wm.describe();
    check(allOn(d2) && d2.background.on && d2.tilePreview.on && fs.readFileSync(file, 'utf8') === bytes, 'legacy: the next start reads the v: 2 file the same and leaves it alone');
    // A setting change keeps v: 2 and the other choices.
    w2.wm.setEnabled('prime', false);
    var saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    check(saved.v === 2 && saved.enabled.prime === false && saved.enabled.hulu === true && saved.background === true && saved.tmdbKey === before.tmdbKey, 'legacy: a later save keeps v: 2 and every other choice');
    w2.done();
    fs.rmSync(dir, { recursive: true, force: true });

    /* ---- embedReferer from watch.json ---- */
    dir = tmp();
    fs.writeFileSync(path.join(dir, WM.PREFS_FILE), JSON.stringify({ enabled: { youtube: true }, embedReferer: 'https://example.org/my-quartz' }));
    w = world(dir);
    d = w.wm.describe();
    var embed = { url: Preview.EMBED_ORIGIN + '/embed/dQw4w9WgXcQ', resourceType: 'subFrame', requestHeaders: {}, webContents: { getURL: function () { return 'file:///C:/q/watch.html'; } } };
    check(d.embedReferer === 'https://example.org/my-quartz' && Preview.embedReferer(embed) === 'https://example.org/my-quartz', 'embedReferer: watch.json\'s value is the embed Referer (main\'s hook and describe())', d.embedReferer);
    check(JSON.parse(fs.readFileSync(path.join(dir, WM.PREFS_FILE), 'utf8')).embedReferer === 'https://example.org/my-quartz', 'embedReferer: kept through the v: 2 rewrite');
    w.done();
    Preview.setEmbedReferer('');
    check(Preview.embedReferer(embed) === PUBLIC_REFERER && Preview.EMBED_REFERER === PUBLIC_REFERER, 'embedReferer: unset = the public default');
    fs.rmSync(dir, { recursive: true, force: true });

    /* ---- a fresh install: nothing on, nothing written, nothing read ---- */
    dir = tmp();
    w = world(dir);
    d = w.wm.describe();
    check(allOff(d) && d.background.on === false, 'fresh: every service off, background off', d.services.map(function (s) { return s.id + ':' + s.enabled; }));
    check(!fs.existsSync(path.join(dir, WM.PREFS_FILE)), 'fresh: no watch.json is written just by starting');
    await w.advance(6 * 60 * 60 * 1000);   // six hours of boot grace, background ticks and timers
    check(w.touched.length === 0, 'fresh: six hours after start, no read and no fetch was scheduled', w.touched);
    var g = w.guest();
    g.say(WM.LINE_PREFIX + 'hello {"visible":true}');
    await settle();
    await w.advance(60 * 60 * 1000);
    var snap = null;
    for (var i = g.pushed.length - 1; i >= 0 && !snap; i--) if (g.pushed[i].fn === '__applyWatch') snap = g.pushed[i].payload;
    check(!!snap && snap.services.every(function (s) { return s.enabled === false; }), 'fresh: an open Lumen page is told every service is off (it says so, with Open Settings)');
    g.say(WM.LINE_PREFIX + 'refresh {"service":null}');
    g.say(WM.LINE_PREFIX + 'search {"q":"bluey","seq":1}');
    g.say(WM.LINE_PREFIX + 'find {"q":"bluey","seq":2}');
    await settle();
    await w.advance(60 * 60 * 1000);
    check(w.touched.length === 0, 'fresh: an open page, Read now, a search and Find touch no service', w.touched);
    // Turning one service on: saved as v: 2 with only that one on; the background stays off.
    w.wm.setEnabled('youtube', true);
    var chosen = JSON.parse(fs.readFileSync(path.join(dir, WM.PREFS_FILE), 'utf8'));
    check(chosen.v === 2 && chosen.enabled.youtube === true && chosen.enabled.hulu === false && chosen.enabled.espn === false && chosen.background === false,
      'fresh: turning YouTube on saves v: 2 with only YouTube on and the background still off', chosen.enabled);
    await settle();
    check(w.touched.some(function (x) { return x.indexOf('youtube.com') !== -1; }) && !w.touched.some(function (x) { return x.indexOf('youtube.com') === -1; }),
      'fresh: once on, YouTube (and only YouTube) is read', w.touched);
    w.done();
    fs.rmSync(dir, { recursive: true, force: true });

    /* ---- a v: 2 file: only what it turns on ---- */
    dir = tmp();
    fs.writeFileSync(path.join(dir, WM.PREFS_FILE), JSON.stringify({ v: 2, enabled: { espn: true } }));
    w = world(dir);
    d = w.wm.describe();
    check(d.services.filter(function (s) { return s.enabled; }).map(function (s) { return s.id; }).join() === 'espn' && d.background.on === false, 'v2: only ESPN on, background off');
    w.done();
    fs.rmSync(dir, { recursive: true, force: true });

    /* ---- an unreadable watch.json: as before opt-in, not rewritten, and said ---- */
    dir = tmp();
    fs.writeFileSync(path.join(dir, WM.PREFS_FILE), '{"enabled": {"youtube": tru');
    w = world(dir);
    d = w.wm.describe();
    check(allOn(d) && d.background.on === true, 'unreadable: read as before opt-in (every service on)');
    check(fs.readFileSync(path.join(dir, WM.PREFS_FILE), 'utf8') === '{"enabled": {"youtube": tru', 'unreadable: the file is not rewritten');
    check(/could not be read/.test(d.prefsNote || ''), 'unreadable: Settings > Lumen says so', d.prefsNote);
    w.done();
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    Preview.setEmbedReferer('');   // the module is shared with the tests that run after this one
  }

  /* ---- sports-main.js: ESPN only while ESPN is on ---- */
  var sdir = tmp();
  var espn = false;
  var fetched = [];
  var sp = SportsMain.create({
    log: function () {},
    espnOn: function () { return espn; },
    test: { userData: sdir, fetch: function (u) { fetched.push(u); return Promise.resolve({ ok: true, status: 200, headers: { get: function () { return null; } }, text: function () { return Promise.resolve('{}'); } }); } },
  });
  var spushed = [];
  var sg = {
    getURL: function () { return require('url').pathToFileURL(path.join(__dirname, '..', 'watch.html')).href; },   // sports-main hears only OUR watch.html
    isDestroyed: function () { return false; },
    once: function () {}, on: function () {},
    executeJavaScript: function (code) { spushed.push(code); return Promise.resolve(); },
  };
  check(typeof sp.handleLine === 'function', 'sports: handleLine exists');
  if (typeof sp.handleLine === 'function') {
    var lines = ['standings {"league":"nhl"}', 'teams {"league":"nhl"}', 'game {"league":"nhl","id":"401"}'];
    for (var k = 0; k < lines.length; k++) { try { await sp.handleLine(sg, SportsMain.LINE_PREFIX + lines[k]); } catch (e) { /* counted below */ } }
    await settle();
    check(fetched.length === 0, 'sports: ESPN off = no fetch for standings, teams or a game', fetched);
    check(spushed.some(function (c) { return c.indexOf('Settings > Lumen') !== -1; }), 'sports: ESPN off = the page is told why (Settings > Lumen)');
    espn = true;
    try { await sp.handleLine(sg, SportsMain.LINE_PREFIX + 'standings {"league":"nhl"}'); } catch (e) { /* counted below */ }
    await settle();
    check(fetched.length > 0, 'sports: ESPN on = it reads', fetched.length);
  }
  try { if (typeof sp.stop === 'function') sp.stop(); } catch (e) { /* fine */ }
  fs.rmSync(sdir, { recursive: true, force: true });
};

if (require.main === module) {
  var pass = 0;
  var fail = 0;
  module.exports(function (cond, label, detail) {
    if (cond) { pass++; return; }
    fail++;
    console.log('FAIL ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 300)));
  }).then(function () {
    console.log('watch-lumen-optin-test: ' + pass + ' passed, ' + fail + ' failed');
    process.exitCode = fail ? 1 : 0;
  }, function (err) {
    console.log('watch-lumen-optin-test threw: ' + String((err && err.stack) || err).slice(0, 400));
    process.exitCode = 1;
  });
}
