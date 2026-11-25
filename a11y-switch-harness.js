// a11y-switch-harness.js - pure-node checks for the two accessibility switches
// at the end of tokens.css (run: node a11y-switch-harness.js).
//
// What it proves, without a browser:
//   1. The reduced-motion catch-all is there and is the shape the comment in
//      tokens.css promises: --rm-keep registered with inherits: false and an
//      initial 0.01ms (never 0: transitionend must still fire), the four
//      shared IN durations collapsed, and EVERY transition / animation cut to
//      var(--rm-keep) with !important, infinite ones run once.
//   2. The forced-colours block is there: the picture hidden, blur and text
//      shadow off, edges and selected state as outlines (never borders, so
//      nothing moves), and focus as a Highlight outline (the box-shadow ring
//      is dropped by a contrast theme).
//   3. "One block covers the whole app" is true: every bundled page in the
//      repo root reaches tokens.css through the stylesheet it links (directly,
//      or via chrome.css's @import), so no document is left out.
//   4. Every 120ms opacity fade survives: any rule, in any root stylesheet, that
//      times a transition or animation with var(--m-dur-rm) WITHOUT !important
//      opts in with --rm-keep, or the catch-all would make it instant.
//
// What it cannot prove: how a contrast theme actually looks. That needs a
// real Windows contrast theme on screen; see the lane notes.

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('FAIL ' + name + (detail ? '\n  ' + detail : '')); }
}

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
// Comments out, line breaks kept (so a rule's text can be searched as one string).
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/** The body of the first `@media <query> {...}` (or `@property <name> {...}`), braces balanced. */
function blockAfter(css, head) {
  const at = css.indexOf(head);
  if (at < 0) return null;
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) return css.slice(open + 1, i); }
  }
  return null;
}

const tokens = stripComments(read('tokens.css'));

/* ---- 1. reduced motion ---- */
const prop = blockAfter(tokens, '@property --rm-keep');
ok('--rm-keep is registered', !!prop);
ok('--rm-keep is a <time>', !!prop && /syntax:\s*"<time>"/.test(prop), prop);
ok('--rm-keep does not inherit (a kept fade must not leak to children)', !!prop && /inherits:\s*false/.test(prop), prop);
ok('--rm-keep starts at 0.01ms, not 0 (transitionend still fires)', !!prop && /initial-value:\s*0\.01ms/.test(prop), prop);

const rm = blockAfter(tokens, '@media (prefers-reduced-motion: reduce)');
ok('a reduced-motion block exists in tokens.css', !!rm);
for (const k of ['xs', 's', 'm', 'l']) {
  ok('--m-dur-' + k + ' collapses under reduced motion', !!rm && new RegExp('--m-dur-' + k + ':\\s*0\\.01ms').test(rm));
}
ok('--m-dur-rm itself is NOT collapsed (it is the fade that stays)', !!rm && !/--m-dur-rm\s*:/.test(rm));
const star = rm ? (rm.match(/\*,\s*\*::before,\s*\*::after\s*\{([^}]*)\}/) || [])[1] : null;
ok('the catch-all targets every element and both pseudo-elements', !!star);
ok('catch-all: transition-duration var(--rm-keep) !important', !!star && /transition-duration:\s*var\(--rm-keep\)\s*!important/.test(star), star);
ok('catch-all: animation-duration var(--rm-keep) !important', !!star && /animation-duration:\s*var\(--rm-keep\)\s*!important/.test(star), star);
ok('catch-all: infinite animations run once', !!star && /animation-iteration-count:\s*1\s*!important/.test(star), star);
ok('catch-all leaves delays alone (a delay moves nothing)', !!star && !/delay/.test(star), star);
// Without this the catch-all's 0.01ms turns an element with no transition of its own (property
// `all`) into a one-frame transition of every property on every style change: a decoded logo
// stays visibility: hidden for that frame with its letter already gone, and getAnimations()
// counts it under reduced motion.
const ownOnly = rm ? (rm.match(/:where\(\*\),\s*:where\(\*\)::before,\s*:where\(\*\)::after\s*\{([^}]*)\}/) || [])[1] : null;
ok('an element with no transition of its own gets none (a zero-specificity transition-property: none)',
  !!ownOnly && /^\s*transition-property:\s*none;?\s*$/.test(ownOnly), ownOnly);
ok('the zero-specificity reset comes before the catch-all and outranks no sheet (no !important)',
  !!ownOnly && rm.indexOf(':where(*)') < rm.indexOf('*, *::before') && !/!important/.test(ownOnly));

/* ---- 2. forced colours ---- */
const fc = blockAfter(tokens, '@media (forced-colors: active)');
ok('a forced-colors block exists in tokens.css', !!fc);
ok('forced colours: the picture is hidden', !!fc && /\.backdrop\s*\{\s*display:\s*none\s*!important/.test(fc), fc && fc.slice(0, 200));
ok('forced colours: no backdrop-filter', !!fc && /backdrop-filter:\s*none\s*!important/.test(fc));
ok('forced colours: no text-shadow', !!fc && /text-shadow:\s*none\s*!important/.test(fc));
ok('forced colours: focus is a Highlight outline', !!fc && /:focus-visible\s*\{[^}]*outline:\s*2px solid Highlight\s*!important/.test(fc));
ok('forced colours: controls get a ButtonBorder outline', !!fc && /outline:\s*1px solid ButtonBorder/.test(fc));
ok('forced colours: the active tab is marked in Highlight', !!fc && /\.tab\.active[\s\S]*?outline:\s*2px solid Highlight/.test(fc));
ok('forced colours: edges never use border (nothing may move)', !!fc && !/\bborder(-[a-z]+)?\s*:/.test(fc), fc);

/* ---- 3. every bundled page reaches tokens.css ---- */
// A stylesheet "reaches" tokens.css if it IS tokens.css or @imports one that does.
const reachCache = {};
function reaches(css, seen) {
  if (css === 'tokens.css') return true;
  if (reachCache[css] !== undefined) return reachCache[css];
  if (seen.has(css) || !fs.existsSync(path.join(ROOT, css))) return false;
  seen.add(css);
  const imports = [...read(css).matchAll(/@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]);
  return (reachCache[css] = imports.some((i) => reaches(i, seen)));
}
const pages = fs.readdirSync(ROOT).filter((f) => /\.html$/.test(f));
ok('there are bundled pages to check', pages.length >= 5, pages.join(', '));
for (const page of pages) {
  const html = read(page);
  const links = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/g)]
    .map((m) => (m[0].match(/href=["']([^"'?#]+)/) || [])[1]).filter(Boolean);
  ok(page + ' links a stylesheet that reaches tokens.css', links.some((l) => reaches(l, new Set())), 'links: ' + links.join(', '));
}

/* ---- 4. the kept 120ms fades ---- */
/** Every rule (selector + body) in a sheet whose body uses var(--m-dur-rm) in a transition or animation. */
function rmRules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const body = m[2];
    if (!/(transition|animation)[^;]*var\(--m-dur-rm\)/.test(body)) continue;
    out.push({ sel: m[1].trim().replace(/\s+/g, ' '), body });
  }
  return out;
}
const sheets = fs.readdirSync(ROOT).filter((f) => /\.css$/.test(f) && f !== 'tokens.css');
for (const sheet of sheets) {
  for (const r of rmRules(stripComments(read(sheet)))) {
    const timed = r.body.split(";").filter((d) => /(transition|animation)[^;]*var(--m-dur-rm)/.test(d));
    const important = timed.every((d) => /!important/.test(d));
    const optsIn = /--rm-keeps*:s*var(--m-dur-rm)/.test(r.body);
    // Every sheet, not only the Home: a fade timed at --m-dur-rm that neither
    // outranks the catch-all (!important on an id or class) nor opts in with
    // --rm-keep would silently become instant under reduced motion.
    ok(sheet + " keeps its fade: " + r.sel.slice(0, 80), important || optsIn, r.body.trim());
  }
}

console.log(`a11y-switch: ${pass} passed, ${fail} failed`);
