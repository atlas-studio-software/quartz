// islands-harness.js - pure-node test for islands.js and islands.css (run: node islands-harness.js).
// The plates' boxes, the underline under the title's words, and the look's rules read from the
// sources (no live blur, no pointer-follow motion, buttons stay children of .navrow).
// One summary line: "islands: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');
const I = require('./islands');

let pass = 0, fail = 0;
function check(ok, what, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + what + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}
const R = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });

/* ---- plates ---- */
{
  const box = I.span(R(100, 50, 800, 40), R(110, 54, 32, 32), R(190, 54, 32, 32));
  check(box && box.left === 6 && box.top === 0 && box.width === 120 && box.height === 40, 'a plate covers first..last with 4 px of air', box);
  const swapped = I.span(R(0, 0, 800, 40), R(190, 4, 32, 32), R(110, 4, 32, 32));
  check(swapped && swapped.left === 106 && swapped.width === 120, 'first and last in either order give the same plate', swapped);
  check(I.span(null, R(0, 0, 1, 1), R(0, 0, 1, 1)) === null && I.span(R(0, 0, 1, 1), null, R(0, 0, 1, 1)) === null, 'nothing to cover: no plate');
  check(I.span(R(0, 0, 10, 10), R(5, 5, 0, 0), R(5, 5, 0, 0), 0) === null, 'a zero-size group: no plate');
}

/* ---- the underline under the words ---- */
{
  // chip at 200, title starts at 230 and is 150 wide, but its words are only 60 px
  check(I.underlineX(R(200, 6, 200, 30), R(230, 10, 150, 16), 60) === 52, 'short title: centred under the words, not the chip', I.underlineX(R(200, 6, 200, 30), R(230, 10, 150, 16), 60));
  // words longer than the box (faded): centred under the visible box
  check(I.underlineX(R(200, 6, 200, 30), R(230, 10, 150, 16), 400) === 97, 'long title: centred under what shows');
  check(I.underlineX(null, R(0, 0, 1, 1), 1) === null, 'no chip: no underline place');
}

/* ---- the sources keep the rules ---- */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = strip(fs.readFileSync(path.join(__dirname, 'islands.css'), 'utf8'));
const js = strip(fs.readFileSync(path.join(__dirname, 'islands.js'), 'utf8'));
check(!/backdrop-filter/.test(css), 'islands.css: no live backdrop-filter');
check(!/pointermove|mousemove|deviceorientation/.test(js), 'islands.js: no pointer-follow motion');
check(/#omnibox\.frost[^{]*\{[^}]*max-width:\s*760px/.test(css), 'the address bar: 760 px at most');
check(/\.frost\.soft\s*\{\s*--frost:\s*var\(--frost-soft\)/.test(css), 'a big panel shows the soft copy');
check(!/rgba\(255,\s*255,\s*255,[^)]*\)\s*,\s*rgba\(255,\s*255,\s*255/.test(css.slice(css.indexOf('.frost {'), css.indexOf('.frost.soft'))), 'the island fill has no white sheen layer');
check(/prefers-reduced-motion/.test(css), 'reduced motion: the slide and the lift are off');
check(!/navrow\.appendChild|wrap/.test(js.replace(/insertBefore\(p, container\.firstChild\)/, '')), 'islands.js never wraps the toolbar buttons (they stay children of .navrow)');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const last = html.lastIndexOf('<link rel="stylesheet"');
check(html.indexOf('href="islands.css"') === html.indexOf('"', last + 0) - 0 || html.slice(last).indexOf('islands.css') > 0, 'index.html: islands.css is the last stylesheet');
check(html.indexOf('<script src="islands.js"></script>') > html.indexOf('<script src="backdrop.js"></script>'), 'index.html: islands.js after backdrop.js');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
check(app.indexOf("const HOME_ICON = new URL('assets/quartz-logo-light.svg'") >= 0 && /if \(home\) \{[\s\S]{0,200}showTabIconData\(tab, HOME_ICON, token\)/.test(app),
  'the Home tab wears the light Quartz mark');
check(fs.existsSync(path.join(__dirname, 'assets', 'quartz-logo-light.svg')) && /src="assets\/quartz-logo-light\.svg"/.test(fs.readFileSync(path.join(__dirname, 'newtab.html'), 'utf8')),
  'the same light mark is the Home logo');
const tok = fs.readFileSync(path.join(__dirname, 'tokens.css'), 'utf8');
check(/--island-float:/.test(tok) && /--island-film-rgb: 10 12 14;/.test(tok), 'the islands\' colours are tokens (tokens.css)');
check(!/rgba?\((?!var)/.test(css), 'islands.css: no raw colour, every one through a token');

console.log('islands: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
