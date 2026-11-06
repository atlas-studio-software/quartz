require('./lowcpu-optional.js');   // first: one capped browser at a time (2026-09-17)
// tools/run-suite.js -- every Quartz harness, one after another, and ONE summary line.
//
//   node tools/run-suite.js [--unit] [--only=a,b] [--skip=a,b] [--out=<dir>] [--timeout=<s>]
//
//   --unit       pure-node harnesses only (no Electron): seconds, safe on any machine.
//   --only/skip  test names (the left column below), comma separated.
//   --out        writes <dir>/suite.txt, <dir>/suite.json and <dir>/logs/<name>.txt.
//
// The Electron ones (e2e) launch a REAL off-screen test instance each (--test-profile --offscreen,
// watched by testwatch.js), one at a time. Each refuses to launch under 2.5 GB free RAM (exit 3),
// which shows here as SKIP with that reason, never as a pass. On a typical development laptop that is the usual
// case, so run them in CI: .github/workflows/ci.yml runs --unit on every push and PR, and the full suite
// nightly and on demand (Actions > ci > Run workflow) on windows-latest.
//
// A test passes when it exits 0 AND its own summary line ("<name>: N passed, M failed" or
// "smoke: N ok, M failed") says 0 failed. No summary line = FAIL, whatever the exit code.
// The last line is the verdict:
//   quartz-suite: 17 files: 15 pass, 0 FAIL, 2 skipped | checks 812 passed, 0 failed
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (k) => { const a = args.find((x) => x === '--' + k || x.startsWith('--' + k + '=')); return a === undefined ? null : (a.includes('=') ? a.slice(a.indexOf('=') + 1) : true); };
const list = (k) => { const v = flag(k); return typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []; };
const UNIT_ONLY = !!flag('unit');
const ONLY = list('only');
const SKIP = list('skip');
const OUT = typeof flag('out') === 'string' ? path.resolve(flag('out')) : null;
const TIMEOUT_S = Number(flag('timeout')) || 0;

const exists = (p) => { try { return fs.existsSync(p); } catch (e) { return false; } };
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
/** null on a castlabs ECS build (Widevine), else why the castlabs-only e2e cannot run here. */
function castlabsBuild() {
  let v = '';
  try { v = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version || ''); } catch (e) { v = ''; }
  return /\+wvcus$/.test(v) ? null : 'needs the castlabs ECS build of Electron (installed: ' + (v || 'none') + ')';
}

/*
 * The manifest. `needs` returns why a test cannot run HERE (it is then SKIP, with the reason),
 * or null. Unit tests first: they are seconds, and a broken module shows before any launch.
 */
const TESTS = [
  // tokens.css's two accessibility switches (reduced-motion catch-all, forced colours) and that every
  // bundled page reaches tokens.css, so one block really covers the whole app.
  { name: 'a11y-switch', file: 'a11y-switch-harness.js' },
  { name: 'argvurl', file: 'argvurl-harness.js' },
  { name: 'closetabs', file: 'closetabs-harness.js' },
  // The always-on DevTools port (cdp-main.js): every decide() branch, the netstat parse, plan()/confirm() on a fake app.
  { name: 'cdp', file: 'cdp-harness.js' },
  // Spotify auto-pause: config migration, the hold machine -> link -> engine, the SMTC helper's wrapper
  // (a fake child), and test mode never sending. Then the shared host protocol (byte-identical with Mantle's).
  { name: 'autopause', file: 'autopause-harness.js' },
  { name: 'autopause-link', file: 'autopause-harness.js', args: ['--link'] },
  { name: 'bravesearch', file: 'bravesearch-harness.js' },
  { name: 'claudeanswer', file: 'claudeanswer-harness.js' },
  { name: 'secret-store', file: 'secret-store-harness.js' },
  // Claude "Skip permission prompts": off on a new profile, the one-time migration that keeps an older
  // profile on, app.js's start arguments and preload's default (settings.js / app.js / preload.js in vm).
  { name: 'claudeskip', file: 'claudeskip-harness.js' },
  // Ask/Show Claude: web text is cleaned and fenced, a web paste with a control code is refused, and a
  // page-text chamber never skips permissions and runs in a scratch folder (real ConPTY + stand-in).
  { name: 'askclaude', file: 'askclaude-harness.js' },
  // The same in a real Quartz: Ask with a break-out selection lands inert in a page-text chamber.
  { name: 'askclaude-e2e', file: 'askclaude-e2e.js', e2e: true },
  // Quartz tools for Claude panes: web text cleaned like terminal.js and fenced, read_page's cap and
  // paging, the key-checked pipe server over a real pipe, the tools with fake guests, the stdio shim
  // (in process and as a child), pty.js's --mcp-config/env hand-off, a config file with no key in it.
  { name: 'mcp', file: 'mcp-harness.js' },
  // The same in a real Quartz: a stand-in claude.exe starts the server from its --mcp-config file and
  // calls every tool on a real page; the pane line, quartz.log, Ask's read_page prompt, the switch off.
  { name: 'mcp-e2e', file: 'mcp-e2e.js', e2e: true },
  // tools/check-electron.js's pure half: pin parsing, tag order, the bump-policy verdict.
  { name: 'check-electron', file: 'check-electron-harness.js' },
  // tools/audit-verdict.js: the ci audit job's verdict line, and that the castlabs git Electron stays
  // visible to npm audit (an unversioned lockfile entry would be skipped and pass).
  { name: 'audit-verdict', file: 'tests/audit-verdict-test.js' },
  // Every bundled page's Content-Security-Policy: present, above the first script, parses, strict,
  // and nothing in the page or its scripts that the policy would refuse (csp-e2e.js is the live half).
  { name: 'csp', file: 'csp-harness.js' },
  { name: 'drm', file: 'drm-harness.js' },
  // testwatch.js waitChromeBooted: an e2e acts only once init() has run and the boot strip is built,
  // never in the gap after app.js loads (createTab() is null there).
  { name: 'testwatch', file: 'testwatch-harness.js' },
  { name: 'favicons', file: 'favicons-harness.js' },
  // Which page may open a file:// URL (filenav.js): file -> file yes, the web never.
  { name: 'filenav', file: 'filenav-harness.js' },
  // Drives an instance it does not start itself (CDP_PORT): the suite launches one for it.
  { name: 'files', file: 'files-harness.js', launch: 9241, e2e: true },
  { name: 'keywords', file: 'keywords-harness.js' },
  { name: 'log', file: 'log-harness.js' },
  // The frozen window (freezewatch.js): Chromium's occluder rules, the uncovered region, the watch's
  // nudge / force / give-up steps and what is said on screen.
  { name: 'freezewatch', file: 'freezewatch-harness.js' },
  // Ad-block list refresh: when it is due, validation, the atomic write, keep-old on failure, a real
  // Ghostery build on a fake fetch, the session hooks and the shield line.
  { name: 'adblock-refresh', file: 'adblock-refresh-harness.js' },
  // The narrowed ad-block hooks answer exactly as the library's own did, on a real engine, every type.
  { name: 'adblock-hooks', file: 'adblock-hooks-harness.js' },
  // The same in a real Quartz against a local list server: a failed refresh says why, then one swaps in.
  { name: 'adblock-refresh-e2e', file: 'adblock-refresh-e2e.js', e2e: true },
  { name: 'procfind', file: 'procfind-harness.js' },
  // What notes-pane-main.js asks notes-reader.ps1 for (probe forces a walk) and the gate-off reason.
  { name: 'notes-pane', file: 'notes-pane-harness.js' },
  // The main-process guard on activateUvLoop (the idle wakeup storms).
  { name: 'uvquiet', file: 'uvquiet-harness.js' },
  // The main thread's priority boost off (the focused-Home wakeup storm): env switch, script, states.
  { name: 'uvboost', file: 'uvboost-harness.js' },
  { name: 'profilemove', file: 'profilemove-harness.js' },
  // session.json's writer: a refused rename (a scanner holding the file) keeps the snapshot.
  { name: 'sessionfile', file: 'sessionfile-harness.js' },
  // Tab sleep rules: the idle clock starts when a tab leaves the screen, a tab making sound (or heard in
  // the last 2 minutes) never sleeps, lazy restore and the backgrounded new tab page; sleeping early
  // (memory low, heavy pages), the safe-to-sleep probe, the speaker following Chromium, tabsleep-main.js.
  { name: 'tabsleep', file: 'tabsleep-harness.js' },
  // look-sync's reads and writes when Windows refuses look.json for a moment (scanner, another app):
  // a refused read is retried and re-checked, so a change that landed is followed, never lost.
  { name: 'looksync', file: 'looksync-harness.js' },
  { name: 'toprow', file: 'toprow-harness.js' },
  // tools/css-lint.js: raw radii and type sizes off tokens.css's scale, the old --fg names, unused
  // --space-N steps, the allow comment; then the repository, nothing over tools/css-lint-baseline.json.
  { name: 'css-lint', file: 'css-lint-harness.js' },
  // Watch: shape/merge, watch-main.js driven by fakes (cache-first, one read at a time, every
  // pause shown), and every service adapter against its hand-written fixtures.
  { name: 'watch', file: 'watch-harness.js' },
  // Lumen's one search box: merge and ranking, the Disney+/Hulu/Prime search readers, the main half
  // (one reader at a time, signed-in first, the 5-min cache, cancel, Retry) and its watch-main hooks.
  { name: 'watch-find', file: 'watch-find-harness.js' },
  // Lumen's leak-proof layer: the leak log, YouTube page vs embed, off-site pages as sheets, app links,
  // the Settings count, and watch-main's counted fallbacks (fakes only).
  { name: 'watch-leaks', file: 'watch-leaks-harness.js' },
  // Lumen sports (watch/sports.js, sports-main.js): ESPN-shaped fixtures, a fake fetch, no network.
  { name: 'sports', file: 'tests/sports-test.js' },
  // Lumen multiview (watch-player-multi.js, watch-player-main.js): the tile embed, the simulated RAM, the keys.
  { name: 'watch-multi', file: 'tests/watch-multi-test.js' },
  // Lumen's own play bar (watch-playerbar.js, watch-playerbar-page.js, watch/playerbar/*): the time format, the seek
  // maths, the key map, each adapter's menus, the page style (the ad UI kept), auto-hide and the fallback rules.
  { name: 'watch-playerbar', file: 'tests/watch-playerbar-test.js' },
  { name: 'watch-playview', file: 'tests/watch-playview-test.js' },
  // Lumen's own YouTube comments (watch-comments.js): both answer shapes, links, the states, the in-page script.
  { name: 'watch-comments', file: 'tests/watch-comments-test.js' },
  { name: 'watch-shorts', file: 'tests/watch-shorts-test.js' },
  // Lumen's ambient field (watch-ambient.js, watch-ambient-main.js): ids, keys, the sample's change, the gates, the CSS.
  { name: 'watch-ambient', file: 'tests/watch-ambient-test.js' },
  // Lumen's show pages: every service's show reader on its hand-made fixture, TMDB's seasons (a fake fetch),
  // the big button, and watch-shows-main's states (fallback, signed out, paused, elsewhere, cache, cancel).
  { name: 'watch-shows', file: 'tests/watch-shows-test.js' },
  // Lumen's pinned scores: feed parsing and the event diff (watch/scores.js), and score-pins-main.js
  // driven by fake windows (stacking, saved pins, polling cadence, Final, silence under tests).
  { name: 'scores', file: 'tests/scores-test.js' },
  { name: 'scorepins', file: 'tests/score-pins-main-test.js' },
  // Lumen Alerts: the subscriptions diff and batch, the gaming/RAM gates, the toggles, favourite-team
  // start/final on ESPN-shaped fixtures, watch-alerts-main.js on fakes, and ytlib-main's two hooks.
  { name: 'watch-alerts', file: 'tests/watch-alerts-test.js' },
  // Lumen's hover previews inside tiles (watch-tilepreview.js): the hover delay, a sweep starts nothing,
  // one player at a time, the gates, trailer-or-nothing, the &t= hand-off, and watch-main's tilepv gate.
  { name: 'watch-tilepreview', file: 'tests/watch-tilepreview-test.js' },
  // The go-live scripts count processes as arrays: @(Main-Procs) / @(Test-Procs) (a single Quartz
  // came back unrolled, its .Count empty, and the close step skipped closing it).
  { name: 'golive-procs', file: 'tests/golive-procs-test.js' },
  // In-app updates (updater.js): throwaway git repos and a fake releases API; up to date, ahead,
  // available, every reason for no button, offline, rate-limited, and each rollback.
  // It spawns a few hundred git processes, which on a busy Windows laptop took ~2 min: past the 90 s unit
  // default, so the suite timed out a harness that passes. 300 s keeps a real hang a FAIL.
  { name: 'updater', file: 'tests/updater-test.js', timeout: 300 },
  // An installed copy (Quartz-Setup.exe): install-mode.js tells it from a folder copy, and the
  // updater judges a release by version and offers the installer link instead of an Update button.
  { name: 'install-mode', file: 'tests/install-mode-test.js' },
  // Signed release tags (updater.js verifyReleaseTag, the swap helper's second check,
  // tools/release-tag.js): throwaway repos and ed25519 keys; signed, unsigned, other key, signers
  // swapped by the release, tag/commit mismatch, rotation, bootstrap, old git, no ssh-keygen.
  // Spawns git and ssh-keygen a few hundred times, like the updater harness: same 300 s.
  { name: 'release-signing', file: 'tests/release-signing-test.js', timeout: 300 },
  // The same in a real Quartz: the card, the Update button, a real update and the relaunch.
  { name: 'updater-e2e', file: 'tests/updater-e2e.js', e2e: true },
  // uvquiet's default mode (every activateUvLoop skipped) in a real Electron: work still runs on time.
  { name: 'uvquiet-e2e', file: 'uvquiet-e2e.js', e2e: true },
  // uvboost in a real Electron: one thread raised, Electron's libuv embed thread; its guard undoes it.
  { name: 'uvboost-e2e', file: 'uvboost-e2e.js', e2e: true },
  // Every bundled page under its CSP in a real instance: zero violations, the policy proven active.
  // Its own watchdog ends a hung step at 240 s with a named FAIL and cleans up (~30 s); this limit
  // is only the backstop above that.
  { name: 'csp-e2e', file: 'csp-e2e.js', e2e: true, timeout: 300 },
  { name: 'log-e2e', file: 'log-e2e.js', e2e: true },
  { name: 'log-e2e-nogate', file: 'log-e2e.js', args: ['--no-gate', '--cdp', '9428'], e2e: true },
  // The same in a real Quartz ON SCREEN (occlusion needs it, so a CI runner only): the wake bug reproduced
  // with simulated power messages, the drag events and one nudge each redraw it, the watch and the wake
  // nudges heal it by themselves (freeze.log, quartz.log, the toast).
  { name: 'freezewatch-e2e', file: 'freezewatch-e2e.js', e2e: true, needs: () => (process.env.GITHUB_ACTIONS === 'true' || process.env.QUARTZ_ALLOW_ON_SCREEN === '1' ? null : 'freezewatch-e2e: puts a window on screen (occlusion needs it), so it runs on a CI runner only') },
  // The DevTools port in a real copy: 127.0.0.1 only, the busy fallback, off, a command-line port, the handoff.
  { name: 'cdp-e2e', file: 'cdp-e2e.js', e2e: true },
  { name: 'drm-e2e', file: 'drm-e2e.js', e2e: true },
  // castlabs ECS only (package.json's electron = a +wvcus tag): the CDM loads, a public Widevine test
  // stream plays in a real tab (needs the internet: Shaka + Google's test licence proxy), the bar says
  // "not signed for streaming" on a known site, and a refused licence gets its own bar.
  { name: 'drm-castlabs-e2e', file: 'drm-castlabs-e2e.js', e2e: true, timeout: 300, needs: () => castlabsBuild() },
  // Watch's routing for protected titles, both ways: Widevine ready -> a Quartz tab; missing -> Edge
  // (stubbed, never launched) with the reason in the toast. Three launches.
  { name: 'drm-route-e2e', file: 'drm-route-e2e.js', e2e: true, timeout: 300, needs: () => castlabsBuild() },
  // notes-reader.ps1's change gate against a Chromium stand-in for the reader app (never a real
  // reader app).
  { name: 'notes-reader-e2e', file: 'notes-reader-e2e.js', e2e: true },
  { name: 'favicons-e2e', file: 'favicons-e2e.js', e2e: true },
  // Site logos outside the tab strip (bookmarks bar, new tab page, history page), and no request
  // to a Google favicon host anywhere.
  { name: 'pagefavicons-e2e', file: 'pagefavicons-e2e.js', e2e: true },
  { name: 'bravesearch-e2e', file: 'bravesearch-e2e.js', e2e: true },
  { name: 'claudeanswer-e2e', file: 'claudeanswer-e2e.js', e2e: true },
  { name: 'toprow-e2e', file: 'toprow-e2e.js', e2e: true },
  // The daily paths (tests/e2e-kit.js): session restore across restarts, tab sleep and wake,
  // find in page, downloads, the address bar.
  { name: 'sessions-e2e', file: 'sessions-e2e.js', e2e: true },
  { name: 'closetabs-e2e', file: 'closetabs-e2e.js', e2e: true },
  { name: 'sleep-e2e', file: 'sleep-e2e.js', e2e: true },
  { name: 'find-e2e', file: 'find-e2e.js', e2e: true },
  // Links on a local page: file -> file navigates, target=_blank opens a tab, the web is refused
  // with a note on the tab.
  { name: 'filelinks-e2e', file: 'filelinks-e2e.js', e2e: true },
  { name: 'downloads-e2e', file: 'downloads-e2e.js', e2e: true },
  { name: 'omnibox-e2e', file: 'omnibox-e2e.js', e2e: true },
  // Drives the shared look file with looksync/fake-writer.js (vendored, so it runs anywhere).
  { name: 'looksync-e2e', file: 'looksync-e2e.js', e2e: true },
  // The first-run welcome: fresh profile shows it, choices persist, skip sets the flag, an existing
  // profile never sees it, Settings re-opens it. Screenshots of every step, light and dark.
  { name: 'welcome-e2e', file: 'welcome-e2e.js', e2e: true },
  // The motion Quartz shares with Mantle and Helm: the tokens, every
  // surface opening and closing on opacity/translate/scale only, cut short and toggled, reduced
  // motion, the tab strip's arrival and glide.
  { name: 'motion-e2e', file: 'motion-e2e.js', e2e: true },
  // Watch end to end: a hidden reader against a local mock of every service (tests/watch-mock.js),
  // every failure mode on its own tile, the game pause, opens, search, keyboard, reduced motion, a
  // cache-first second boot and Forget. ~6 min (four Retry rounds 30 s apart, one 20 s timeout).
  { name: 'watch-e2e', file: 'watch-e2e.js', e2e: true, timeout: 900 },
  // The toolbar's Lumen button: one Lumen tab, reused; lit while Lumen is in front; keyboard; every palette.
  { name: 'lumen-btn-e2e', file: 'lumen-btn-e2e.js', e2e: true },
  // Watch keeps itself up to date: the background refresh and its gates (battery saver, a game),
  // fresh on open (oldest first, rows in place), fresh after watching, the header and its time limit.
  { name: 'watch-auto-e2e', file: 'watch-auto-e2e.js', e2e: true, timeout: 600 },
  // YouTube art steps down maxres -> sd -> hq against a local mock image server (tiles, hero, repaint).
  { name: 'watch-thumbs-e2e', file: 'watch-thumbs-e2e.js', e2e: true },
  // The stage's hover preview against a mock player (quartz-preview.invalid via CDP Fetch) and a mock TMDB.
  { name: 'watch-preview-e2e', file: 'watch-preview-e2e.js', e2e: true },
  // The Lumen player layer (watch-player.js + watch-player-main.js): titles play INSIDE Lumen, never a
  // new tab. Local fixtures only (an HTML5 page per service, framing and licence refusals, a TMDB
  // where-to-watch page and its handover), every way out logged, Esc/Back order, RAM before/during/
  // after, the public Widevine test stream in the layer (castlabs only, needs the internet). Two launches.
  { name: 'watch-player-e2e', file: 'watch-player-e2e.js', e2e: true, timeout: 420, needs: () => castlabsBuild() },
  // Lumen's show and movie pages (watch/showpage.js + watch-shows-main.js) against local fronts serving
  // tests/watch-show-fixtures/ and a local TMDB: Resume SxEy, progress, watched checks, season tabs, a
  // season from TMDB, a failing reader's TMDB fallback with its reason, a title on none of his services,
  // plays in the layer (Widevine test-signed: castlabs only). The page's requests are held to local.
  { name: 'watch-shows-e2e', file: 'watch-shows-e2e.js', e2e: true, timeout: 480, needs: () => castlabsBuild() },
  // Lumen leak-proof (watch-leak-e2e.js): every way out of a hosted page stays in the layer or is
  // counted; YouTube's full page vs the embed and "Full page"; the Settings count. Local fixtures only.
  { name: 'watch-leak-e2e', file: 'watch-leak-e2e.js', e2e: true, timeout: 420 },
  // Pinned score cards in a hidden instance against a local feed mock: goal, penalty, power play,
  // outage, restart; off-screen, never focused, muted (sounds counted, never played). ~4 min.
  { name: 'score-pins-e2e', file: 'score-pins-e2e.js', e2e: true, timeout: 600 },
  // tools/overlap-audit.js (hover/focus paint over neighbours, every surface, light and dark, wide
  // and narrow) runs on its own, ~15-19 min. It comes back into this list once a full run is at 0
  // findings: on 10-16 it was at 4 (a judge flaw since fixed, a 1-row antialias edge on the shield,
  // and the Home saved tile's outer ring touching a neighbour in one of three runs).
  {
    name: 'smoke', file: 'smoketest.js', args: [path.join(os.tmpdir(), 'quartz-suite-smoke')], e2e: true,
    // Not on a cloud runner: the terminal needs node-pty built for Electron, and there is no
    // Electron prebuild of @homebridge/node-pty-prebuilt-multiarch and its npm package lacks the
    // winpty sources to build one (tried on a runner: gyp 'deps/winpty/src/winpty.gyp not found').
    needs: () => {
      const why = [];
      if (!exists(path.join(ROOT, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch', 'build', 'Release', 'conpty.node'))) why.push('node-pty built for Electron (node_modules/@homebridge/node-pty-prebuilt-multiarch/build/Release/conpty.node; no Electron prebuild exists and the package cannot be built from npm)');
      if (!exists(path.join(os.homedir(), '.local', 'bin', 'claude.exe'))) why.push('claude.exe at ~/.local/bin');
      return why.length ? 'opens a Claude Code pane: needs ' + why.join(' and ') + ', not on this machine' : null;
    },
  },
];

const SUMMARY = /^(?:\S.*?): (\d+) (?:passed|ok), (\d+) failed/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * For a harness that drives an instance it does not start (t.launch = its CDP port): the same
 * off-screen test instance the e2e files start, watched by testwatch.js, killed by ITS pid only,
 * its temp profile deleted. Returns { env, stop() } or { skip: reason }.
 */
async function launchFor(t) {
  const { OFFSCREEN_ARGS, MIN_FREE_GB, freeRamGb, startWatcher } = require(path.join(ROOT, 'testwatch'));
  const free = freeRamGb();
  if (!(free >= MIN_FREE_GB)) return { skip: `${t.name}: not launched: ${free.toFixed(2)} GB free RAM, needs ${MIN_FREE_GB} GB` };
  const profile = 'suite' + t.name + process.pid;
  const watcher = startWatcher(() => {});
  await watcher.ready;
  const child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + t.launch, '--test-profile', '--profile-name=' + profile, ...OFFSCREEN_ARGS], { cwd: ROOT, stdio: 'ignore' });
  watcher.watch(child.pid);
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await (await fetch('http://127.0.0.1:' + t.launch + '/json')).json()).some((x) => x.type === 'page' && /index\.html/.test(String(x.url))); } catch (e) { /* not yet */ }
    if (!up) await sleep(250);
  }
  if (up) await sleep(2500); // the chrome's own boot (tabs, settings) after the page target exists
  return {
    up,
    env: Object.assign({}, process.env, { CDP_PORT: String(t.launch) }),
    async stop() {
      const v = watcher.verdict();
      watcher.stop();
      try { require('child_process').execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* gone */ }
      await sleep(1200);
      for (let i = 0; i < 10; i++) { try { fs.rmSync(path.join(os.tmpdir(), 'browser-test-profile-' + profile), { recursive: true, force: true }); break; } catch (e) { await sleep(400); } }
      return v;
    },
  };
}

async function runLaunched(t) {
  const inst = await launchFor(t);
  if (inst.skip) return { name: t.name, file: t.file, status: 'SKIP', why: inst.skip, ms: 0, passed: 0, failed: 0, failLines: [], text: inst.skip };
  if (!inst.up) { await inst.stop(); return { name: t.name, file: t.file, status: 'FAIL', why: 'the test instance never came up on :' + t.launch, ms: 0, passed: 0, failed: 1, failLines: [], text: '' }; }
  const r = await runOne(t, inst.env);
  const v = await inst.stop();
  if (!v.ok) { r.status = 'FAIL'; r.failed++; r.why += ' | ' + v.line; }
  else r.passed++; // the off-screen watch is a check too
  return r;
}

function runOne(t, env) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = [];
    const child = spawn(process.execPath, [path.join(ROOT, t.file), ...(t.args || [])], { cwd: ROOT, env: env || process.env, windowsHide: true });
    const limit = (TIMEOUT_S || t.timeout || (t.e2e ? 300 : 90)) * 1000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (e) { child.kill(); } }, limit);
    const take = (d) => { const s = String(d); out.push(s); if (process.env.SUITE_ECHO === '1') process.stdout.write(s); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.join('');
      const lines = text.split(/\r?\n/);
      let summary = null;
      for (let i = lines.length - 1; i >= 0; i--) { const m = SUMMARY.exec(lines[i].trim()); if (m) { summary = { line: lines[i].trim(), passed: Number(m[1]), failed: Number(m[2]) }; break; } }
      let status, why = '';
      if (timedOut) { status = 'FAIL'; why = 'timed out after ' + limit / 1000 + ' s'; }
      else if (code === 3 && /not launched: .* GB free RAM/.test(text)) { status = 'SKIP'; why = (lines.find((l) => /not launched/.test(l)) || '').trim(); }
      else if (code === 2 && /cannot run/.test(text)) { status = 'SKIP'; why = (lines.find((l) => /cannot run/.test(l)) || '').trim(); }
      else if (!summary) { status = 'FAIL'; why = 'no summary line (exit ' + code + ')'; }
      else if (summary.failed > 0 || code !== 0) { status = 'FAIL'; why = summary.line + (code !== 0 && summary.failed === 0 ? ' but exit ' + code : ''); }
      else { status = 'PASS'; why = summary.line; }
      const failLines = lines.filter((l) => /^(FAIL|HARNESS ERROR)\b/.test(l.trim())).slice(0, 8);
      resolve({ name: t.name, file: t.file, status, why, ms: Date.now() - t0, passed: summary ? summary.passed : 0, failed: summary ? summary.failed : (status === 'FAIL' ? 1 : 0), failLines, text });
    });
  });
}

(async () => {
  let picked = TESTS.filter((t) => !(UNIT_ONLY && t.e2e));
  if (ONLY.length) picked = picked.filter((t) => ONLY.includes(t.name));
  const unknown = [...ONLY, ...SKIP].filter((n) => !TESTS.some((t) => t.name === n));
  if (unknown.length) { console.log('quartz-suite: unknown test name(s): ' + unknown.join(', ') + ' (known: ' + TESTS.map((t) => t.name).join(', ') + ')'); process.exit(2); }
  if (picked.some((t) => t.e2e) && !exists(ELECTRON)) {
    console.log('quartz-suite: Electron is not installed at ' + ELECTRON + ' (run: node node_modules/electron/install.js); the e2e tests will fail');
  }
  const results = [];
  for (const t of picked) {
    let r;
    if (SKIP.includes(t.name)) r = { name: t.name, file: t.file, status: 'SKIP', why: 'skipped by --skip', ms: 0, passed: 0, failed: 0, failLines: [], text: '' };
    else {
      const blocked = t.needs ? t.needs() : null;
      r = blocked ? { name: t.name, file: t.file, status: 'SKIP', why: blocked, ms: 0, passed: 0, failed: 0, failLines: [], text: '' }
        : t.launch ? await runLaunched(t) : await runOne(t);
    }
    results.push(r);
    console.log(`${r.status.padEnd(4)} ${r.name.padEnd(16)} ${(r.ms / 1000).toFixed(1).padStart(6)} s  ${r.why}`);
    for (const l of r.failLines) console.log('       ' + l.trim().slice(0, 240));
    // A check a file could not run HERE prints "SKIP <check>: <reason>" (never counted as a pass):
    // shown under its file, pass or fail, so a green file with skipped checks says so in this log too.
    if (r.status !== 'SKIP') for (const l of (r.text || '').split(/\r?\n/).filter((x) => /^SKIP\b/.test(x.trim())).slice(0, 8)) console.log('       ' + l.trim().slice(0, 240));
  }
  const n = (s) => results.filter((r) => r.status === s).length;
  const checksPassed = results.reduce((a, r) => a + r.passed, 0);
  const checksFailed = results.reduce((a, r) => a + r.failed, 0);
  const verdict = `quartz-suite: ${results.length} files: ${n('PASS')} pass, ${n('FAIL')} FAIL, ${n('SKIP')} skipped | checks ${checksPassed} passed, ${checksFailed} failed`;
  if (OUT) {
    fs.mkdirSync(path.join(OUT, 'logs'), { recursive: true });
    for (const r of results) if (r.text) fs.writeFileSync(path.join(OUT, 'logs', r.name + '.txt'), r.text);
    fs.writeFileSync(path.join(OUT, 'suite.json'), JSON.stringify({ verdict, at: new Date().toISOString(), results: results.map(({ text, ...r }) => r) }, null, 2));
    fs.writeFileSync(path.join(OUT, 'suite.txt'), results.map((r) => `${r.status} ${r.name} ${(r.ms / 1000).toFixed(1)} s ${r.why}`).join('\n') + '\n' + verdict + '\n');
  }
  console.log(verdict);
  process.exit(n('FAIL') ? 1 : 0);
})();
