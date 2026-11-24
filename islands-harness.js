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


/* ---- the sliding highlight moves by transform only (LOOK.md section 10) ---- */
{
  const m = I.indMove({ x: 100, y: 6, w: 120, h: 30 }, { x: 260, y: 6, w: 200, h: 30 });
  check(m && m.width === '200px' && m.height === '30px', 'FLIP: the highlight takes the new width at once (not animated)', m);
  check(m && m.start === 'translate(100px, 6px) scaleX(0.6)', 'FLIP: it starts drawn at the old place and width', m && m.start);
  check(m && m.end === 'translate(260px, 6px) scaleX(1)', 'FLIP: it ends at the new place at scale 1 (true corners at rest)', m && m.end);
  const snap = I.indMove(null, { x: 10, y: 6, w: 90, h: 30 });
  check(snap && snap.start === snap.end, 'no previous place: a snap', snap);
  check(I.indMove({ x: 0, y: 0, w: 10, h: 10 }, null) === null && I.indMove(null, { x: 0, y: 0, w: 0, h: 30 }) === null, 'no chip: no move');
  const rule = (sel) => { const i = css.indexOf(sel + ' {'); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); };
  const ti = rule('.tab-ind'), tu = rule('.tab-ul');
  const has = (t, s) => t.indexOf(s) >= 0;
  check(has(ti, 'transition: transform 320ms var(--isl-ease-lift);') && (ti.match(/transition:/g) || []).length === 1, '.tab-ind transitions transform only, 320 ms ease-lift', ti);
  check(has(ti, 'transform-origin: 0 0;'), '.tab-ind scales from its left edge');
  check(has(tu, 'width: 16px;') && has(tu, 'height: 2px;') && has(tu, 'transition: transform 320ms var(--isl-ease-lift);'), 'the underline is its own 16 x 2 element, moved by transform', tu);
  const transitions = css.match(/transition:[^;]*;/g) || [];
  check(transitions.every((t) => !/\b(width|left|height|top)\b/.test(t)), 'islands.css: no transition on width, left, top or height anywhere', transitions);
  check(!has(js, "'--ul-x'") && has(js, 'ul.style.transform = ulEnd;') && !has(js, 'ind.style.left'), 'islands.js: the underline moves by transform, not left');
}


/* ---- LOOK.md (2026-11-24): the address bar centred in the window, 12 px air, caption red ---- */
{
  const b = I.barBox(1920, 140, 1700);
  check(b && b.width === 760 && b.left === 580, 'a wide window: 760 px, centred in the WINDOW (580 = (1920 - 760) / 2)', b);
  const lop = I.barBox(1400, 140, 1000);
  check(lop && lop.left + lop.width <= 1000 - I.ISL_AIR && lop.left >= 140 + I.ISL_AIR, 'tools island wide: it slides off centre but keeps 6 px from both islands', lop);
  const narrow = I.barBox(900, 140, 700);
  check(narrow && narrow.width === 548 && narrow.left === 146, 'narrow: it fills the room between the islands, 6 px from each', narrow);
  check(I.barBox(900, 600, 590) === null && I.barBox(0, 10, 500) === null, 'no room or no window: null (CSS layout stays)');
  check(js.indexOf('placeBar();') > 0 && js.indexOf("omnibox.style.marginRight = 'auto';") > 0 && js.indexOf('if (key === barSent) return;') > 0, 'islands.js places the bar once per real change');
  check(/--isl-gap:\s*12px/.test(css), 'air to the window edge and between big panels: 12 px');
  check(css.indexOf('#win-close:hover { background: var(--caption-close); }') >= 0, 'caption close hover through a token');
  const tok = fs.readFileSync(path.join(__dirname, 'tokens.css'), 'utf8');
  check(tok.indexOf('--caption-close: #C42B1C;') >= 0 && tok.indexOf('drop-shadow(0 1px 1px rgba(0, 12, 16, 0.4))') >= 0, 'tokens: the Windows red #C42B1C and the caption glyph shadow rgba(0,12,16,.4)');
  const ncss = fs.readFileSync(path.join(__dirname, 'newtab.css'), 'utf8');
  check(ncss.indexOf('::view-transition-group(stk-chart) { animation-duration: 480ms; animation-timing-function: cubic-bezier(0.22, 1, 0.36, 1); }') >= 0
    && ncss.indexOf('::view-transition-old(stk-chart) { animation-duration: 200ms; }') >= 0
    && ncss.indexOf('::view-transition-new(stk-chart) { animation-duration: 300ms; animation-delay: 90ms;') >= 0, 'the Markets morph: 480 group, old out 200, new in 300 after 90');
  check(ncss.indexOf('.chip:hover, .rtile:hover { --frost-hover: var(--island-fill-1); }') >= 0, 'chips and tiles: a .07 sheen on hover only');
}

console.log('islands: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
