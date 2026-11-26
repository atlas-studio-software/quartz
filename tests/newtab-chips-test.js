// tests/newtab-chips-test.js — pure-node test for the new tab's shortcut chips (app.js, the
// "SLICE-START: newtab chips" block), run in a vm with stand-in Settings / History / savedSites.
//   1. A fresh profile (no visits, the saved list still its seeded defaults, chipsSource 'visited'):
//      the chips are NOT the Saved row a second time; the padding skips every default already saved.
//   2. Visited sites always show, saved or not (the Saved row is not filtered against the chips).
//   3. A default that is not saved still pads the row; chipsSource 'list' hands back the stored list.
// No Electron, no DOM. Prints one summary line: "newtab-chips: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, name, got) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (got !== undefined ? '  got: ' + JSON.stringify(got) : '')); }
}

try {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('SLICE-START: newtab chips');
  const end = src.indexOf('/* SLICE-END: newtab chips */');
  ok(start > 0 && end > start, 'app.js has the newtab chips slice');
  const body = src.slice(src.indexOf('*/', start) + 2, end);
  const DEFAULTS = [
    { label: 'GitHub', url: 'https://github.com' },
    { label: 'YouTube', url: 'https://www.youtube.com' },
    { label: 'Mail', url: 'https://mail.example.com' },
    { label: 'Claude', url: 'https://claude.ai' },
  ];

  /** Run the slice with a saved list, top sites and a chips source; -> newtabChips()'s labels. */
  function chips(saved, top, source, storedChips) {
    const win = {
      DEFAULT_CHIPS: DEFAULTS,
      Settings: { chipsSource: () => source || 'visited', all: () => ({ chips: storedChips }) },
      History: { topSites: () => top || [] },
    };
    const ctx = { window: win, tabs: [], setTimeout, clearTimeout, console, savedSites: () => saved };
    vm.createContext(ctx);
    vm.runInContext(body + '\n;globalThis.__out = newtabChips();', ctx);
    const out = ctx.__out;
    return Array.isArray(out) ? out.map((c) => c.label) : out;
  }

  // 1. fresh profile: Saved = the seeded defaults, no visits
  const fresh = chips(DEFAULTS.map((d) => ({ url: d.url + '/', label: d.label })), []);
  ok(Array.isArray(fresh) && fresh.length === 0, 'fresh profile: no chip repeats the Saved row (the four defaults show once)', fresh);
  // 2. visits show, saved or not
  const visited = chips(DEFAULTS.map((d) => ({ url: d.url, label: d.label })),
    [{ url: 'https://github.com/', host: 'github.com' }, { url: 'https://news.example.org/', host: 'news.example.org' }]);
  ok(Array.isArray(visited) && visited.length === 2 && visited[0] === 'GitHub' && visited.indexOf('YouTube') < 0,
    'visited sites show even when saved (GitHub visited and saved stays); unvisited saved defaults do not pad', visited);
  // 3. a default that is not saved still pads
  const partly = chips([{ url: 'https://github.com/', label: 'GitHub' }], []);
  ok(JSON.stringify(partly) === JSON.stringify(['YouTube', 'Mail', 'Claude']), 'a default not on the Saved row still pads the chips', partly);
  const none = chips([], []);
  ok(JSON.stringify(none) === JSON.stringify(['GitHub', 'YouTube', 'Mail', 'Claude']), 'nothing saved: the defaults pad as before', none);
  // www. and a trailing slash do not hide a saved default
  const www = chips([{ url: 'https://youtube.com', label: 'YT' }], []);
  ok(www.indexOf('YouTube') < 0 && www.length === 3, 'a saved youtube.com matches the www.youtube.com default', www);
  // 'list' is the stored list, untouched by this rule
  const list = chips(DEFAULTS, [], 'list', [{ label: 'Docs', url: 'https://docs.example.com' }]);
  ok(Array.isArray(list) && list.length === 1 && list[0] === 'Docs', "chipsSource 'list': the stored list as is", list);
  // the CSS: an empty chips row takes no room outside Edit mode
  const css = fs.readFileSync(path.join(__dirname, '..', 'newtab.css'), 'utf8');
  ok(/\.home:not\(\.is-editing\) \.links:empty \{ display: none; \}/.test(css), 'newtab.css: an empty chips row is not drawn (and adds no gap)');
} catch (e) {
  fail++;
  console.log('FAIL HARNESS ERROR ' + (e && e.stack || e));
}

console.log('newtab-chips: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
