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
  check(ncss.indexOf('.stk-big { view-transition-name: stk-scrim; }') >= 0
    && ncss.indexOf('::view-transition-old(stk-scrim), ::view-transition-new(stk-scrim) { animation-duration: 360ms;') >= 0, 'the Markets morph: the scrim fades in 360 (its own snapshot)');
  check(ncss.indexOf('.chip:hover, .rtile:hover { --frost-hover: var(--island-fill-1); }') >= 0, 'chips and tiles: a .07 sheen on hover only');
}

/* ---- the tab row's layers stay out of its flex row (taboverflow-e2e) ---- */
{
  // Every rule in islands.css that sets `position` on the titlebar's direct children: none of them
  // may reach the absolutely placed ones (the plate, the highlight, its underline, tabfit.js's edge
  // buttons); a relative one there puts them in the row, after the caption buttons.
  const absKids = ['isl-plate', 'tab-ind', 'tab-ul', 'strip-edge'];
  const rules = css.match(/#titlebar\s*>[^{]*\{[^}]*\bposition:\s*relative[^}]*\}/g) || [];
  check(rules.length >= 1, 'islands.css lifts the titlebar\'s flex items over the plate', rules.length);
  const leaks = rules.filter((r) => { const sel = r.slice(0, r.indexOf('{')); return absKids.some((k) => sel.indexOf('.' + k) < 0); });
  check(!leaks.length, 'that rule leaves the plate, the highlight, the underline and the edge buttons absolutely placed', leaks);
  const tabfitSrc = fs.readFileSync(path.join(__dirname, 'tabfit.js'), 'utf8');
  check(tabfitSrc.indexOf("b.className = 'strip-edge no-drag';") >= 0, 'the edge buttons tabfit.js builds still carry .strip-edge (the class that rule leaves out)');
  check(js.indexOf("ul.className = 'tab-ul';") >= 0 && js.indexOf("ind.className = 'tab-ind';") >= 0, 'the highlight and the underline islands.js builds carry the classes that rule leaves out');
}

// LOOK.md section 2, Chrome rows: tab row 44, tool row 40 four below it, content 12 below = 100.
{
  const ccss = strip(fs.readFileSync(path.join(__dirname, 'chrome.css'), 'utf8'));
  const num = (re, src) => { const m = re.exec(src); return m ? Number(m[1]) : NaN; };
  const titlebarH = num(/--titlebar-h:\s*(\d+)px/, ccss);
  const tabRow = /--tab-row-h:\s*calc\(var\(--titlebar-h\)\s*\+\s*4px\)/.test(css) && /#titlebar\s*\{[^}]*height:\s*var\(--tab-row-h\)/.test(css) ? titlebarH + 4 : NaN;
  const navH = num(/--nav-h:\s*(\d+)px/, css);
  const navTop = /\.navrow\s*\{[^}]*margin:\s*var\(--tool-row-top\) var\(--isl-gap\) 0/.test(css) ? num(/--tool-row-top:\s*(\d+)px/, css) : NaN;
  const gap = num(/--isl-gap:\s*(\d+)px/, css);
  const wellGap = /#well\s*\{[^}]*margin:\s*var\(--isl-gap\)/.test(css) ? gap : NaN;
  check(tabRow === 44 && navTop === 4 && navH === 40 && wellGap === 12 && tabRow + navTop + navH + wellGap === 100,
    'the chrome rows: tab row 44 + 4 + tool row 40 + 12 = content at 100 (LOOK.md section 2)', [tabRow, navTop, navH, wellGap].join(' + '));
  // pop-overs hang under the chrome's bottom (88) with the look's 12 air: one shared token
  check(/--chrome-bottom:\s*calc\(var\(--tab-row-h\)\s*\+\s*var\(--tool-row-top\)\s*\+\s*var\(--nav-h\)\)/.test(css)
    && tabRow + navTop + navH === 88, 'the chrome bottom: tab row 44 + 4 + tool row 40 = 88', [tabRow, navTop, navH].join(' + '));
  check(/--pop-gap:\s*var\(--isl-gap\)/.test(css) && 88 + gap === 100, 'a pop-over hangs 12 below the chrome (88 + 12 = 100)', gap);
  const CB = 'var(--chrome-bottom, calc(var(--titlebar-h) + var(--nav-h)))';
  const under = CB + ' + var(--pop-gap, 8px)';
  for (const [f, want] of [['find.css', 'top: calc(' + under + ');'], ['find.css', 'margin-top: var(--pop-gap, 8px);'],
    ['downloads.css', 'top: calc(' + under + ');'], ['shield.css', 'top: calc(' + under + ');'], ['siteinfo.css', 'top: calc(' + under + ');'],
    ['settings.css', '--set-top-at: var(--set-top, ' + CB + ');'], ['settings.css', 'top: var(--set-top, ' + CB + ');']]) {
    check(strip(fs.readFileSync(path.join(__dirname, f), 'utf8')).indexOf(want) >= 0, f + ': placed with the shared chrome-bottom token', want);
  }
  const left = ['find.css', 'downloads.css', 'shield.css', 'siteinfo.css', 'settings.css']
    .filter((f) => /var\(--titlebar-h\)\s*\+\s*var\(--nav-h\)\s*\+/.test(strip(fs.readFileSync(path.join(__dirname, f), 'utf8')).replace(/var\(--chrome-bottom, calc\(var\(--titlebar-h\) \+ var\(--nav-h\)\)\)/g, '')));
  check(left.length === 0, 'no panel is still placed at --titlebar-h + --nav-h by hand', left);
  for (const f of ['downloads.js', 'shield.js', 'siteinfo.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    check(src.indexOf('panelEl.style.top = popTop(r);') >= 0 && src.indexOf("getPropertyValue('--pop-gap')") >= 0 && src.indexOf("closest('.navrow')") >= 0,
      f + ': the panel hangs from the tool row bottom plus --pop-gap, not the button');
  }
}

/* ---- sink and lift (LOOK.md section 10) ---- */
{
  const tok = fs.readFileSync(path.join(__dirname, 'tokens.css'), 'utf8');
  const ms = (n) => { const m = tok.split('--' + n + ':')[1]; return m ? Number((/^\s*(\d+)ms/.exec(m) || [])[1]) : NaN; };
  check(ms('m-sink-fade') === 200 && ms('m-sink-move') === 300, 'the leaving view: opacity 0 in 200, transform in 300', [ms('m-sink-fade'), ms('m-sink-move')]);
  check(ms('m-lift-fade') === 240 && ms('m-lift-fade-delay') === 40 && ms('m-lift-move') === 460 && ms('m-lift-move-delay') === 20,
    'the arriving view: opacity 240 +40, transform 460 +20');
  check(tok.indexOf('--m-ease-look: cubic-bezier(0.2, 0.8, 0.2, 1);') >= 0 && tok.indexOf('--m-ease-lift: cubic-bezier(0.22, 1.12, 0.36, 1);') >= 0, 'the two easings, as tokens');
  check(css.indexOf('@keyframes isl-sink-move { to { transform: translateY(12px) scale(0.955); } }') >= 0, 'sink: translateY 12 + scale 0.955');
  check(css.indexOf('@keyframes isl-lift-move { from { transform: translateY(28px) scale(0.965); } }') >= 0, 'lift: from translateY 28 + scale 0.965');
  const kf = css.match(/@keyframes [\w-]+ \{[^@]*?\} \}/g) || [];
  check(kf.length >= 4 && kf.every((k) => !/\b(width|height|top|left|filter|blur)\b/.test(k.replace(/@keyframes [\w-]+/, ''))), 'every keyframe animates transform or opacity only', kf);
  const leave = css.slice(css.indexOf('#views > webview.isl-leaving'), css.indexOf('}', css.indexOf('#views > webview.isl-leaving')));
  check(/position: absolute;/.test(leave) && /inset: 0;/.test(leave) && /pointer-events: none;/.test(leave) && /z-index: -1;/.test(leave) && /#views \{ isolation: isolate; \}/.test(css),
    'the leaving body lies over the well, under the arriving one, and takes no input', leave);
  check(!/infinite/.test(css), 'islands.css: nothing loops (nothing runs at rest)');
  const a = app.slice(app.indexOf('const SINK_MS'), app.indexOf('function activateTab(id)'));
  check(/const SINK_MS = (\d+);/.exec(a) && Number(/const SINK_MS = (\d+);/.exec(a)[1]) === ms('m-sink-move'), 'app.js hides the leaving body when the 300 ms sink is over');
  check(!/appendChild|insertBefore|\.remove\(\)|replaceWith/.test(a), 'the sink never moves or removes a view in the DOM');
  check(/prefers-reduced-motion: reduce/.test(a) && /document\.hidden/.test(a) && /splitPartner\(outgoing\) \|\| splitPartner\(target\)/.test(a),
    'reduced motion, an unseen window and a split keep the instant swap');
  const act = app.slice(app.indexOf('function activateTab(id)'), app.indexOf('function activateTab(id)') + 6000);
  check(act.indexOf('finishSink();') >= 0 && act.indexOf("viewsEl.dataset.swap = home ? 'lift' : 'fade';") >= 0 && act.indexOf("tab.viewEl.classList.add('isl-leaving');") >= 0,
    'activateTab: Home on either side sinks and lifts, page to page cross-fades');
}

/* ---- lift, hover and press numbers (LOOK.md sections 6, 8, 10) ---- */
{
  const tok = fs.readFileSync(path.join(__dirname, 'tokens.css'), 'utf8');
  const ncss = strip(fs.readFileSync(path.join(__dirname, 'newtab.css'), 'utf8'));
  // The approved design's own names carry the values; the --island-* names alias them.
  check(tok.indexOf('--float: 0 1px 1px rgba(0, 12, 16, 0.14), 0 8px 18px -6px rgba(0, 12, 16, 0.32), 0 30px 56px -26px rgba(0, 12, 16, 0.52);') >= 0
    && tok.indexOf('--island-float: var(--float);') >= 0, '--float: LOOK.md section 6');
  check(tok.indexOf('--float-hi: 0 2px 2px rgba(0, 12, 16, 0.12), 0 14px 26px -8px rgba(0, 12, 16, 0.38), 0 44px 72px -28px rgba(0, 12, 16, 0.6);') >= 0
    && tok.indexOf('--island-float-hi: var(--float-hi);') >= 0, '--float-hi: LOOK.md section 6');
  check(tok.indexOf('--island-float-sheet: 0 2px 4px rgba(0, 12, 16, 0.18), 0 24px 48px -12px rgba(0, 12, 16, 0.45), 0 60px 100px -40px rgba(0, 12, 16, 0.6);') >= 0
    && /#views\s*\{[^}]*box-shadow:\s*var\(--island-float-sheet\)/.test(css), 'a floating page wears the sheet shadow');
  // The design's Home is not a page: with Home alone in front there is no sheet, and the well keeps only
  // the 12 px under the tool row (the Home pads itself 24 12 12, newtab.css).
  const appJs = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  check(/#views\[data-home-front\] \{ border-radius: 0; box-shadow: none; \}/.test(css)
    && /#well:has\(> #views\[data-home-front\]\)[^{]*\{ margin: var\(--isl-gap\) 0 0; \}/.test(css)
    && /viewsEl\.toggleAttribute\('data-home-front', shown === 1 && homeShown\)/.test(appJs), 'Home alone in front: no sheet round it');
  check(tok.indexOf('--island-fill-1: rgba(255, 255, 255, 0.07);') >= 0 && tok.indexOf('--island-fill-2: rgba(255, 255, 255, 0.12);') >= 0
    && tok.indexOf('--island-ind: rgba(255, 255, 255, 0.18);') >= 0 && tok.indexOf('--island-fill-press: rgba(255, 255, 255, 0.05);') >= 0
    && tok.indexOf('--island-sheen-big: rgba(255, 255, 255, 0.05);') >= 0, 'fills .07 / .12 / .18, pressed .05, big-panel sheen .05');
  check(tok.indexOf('--m-press: 160ms;') >= 0 && tok.indexOf('--m-press-small: 0.94;') >= 0 && tok.indexOf('--m-press-pill: 0.97;') >= 0 && tok.indexOf('--m-press-tile: 0.985;') >= 0,
    'hover / press 160; press 0.94 / 0.97 / 0.985');
  check(/\.navrow > button:active:not\(:disabled\), #newtab:active \{ scale: var\(--m-press-small\); \}/.test(css) && /#workspace-pill:active \{ scale: var\(--m-press-pill\); \}/.test(css),
    'toolbar buttons press to 0.94, the workspace pill to 0.97');
  check(/\.chip:active, \.rtile:active \{ scale: var\(--m-press-pill\); translate: none; \}/.test(ncss) && /\.chip:hover:not\(:focus-visible\), \.rtile:hover:not\(:focus-visible\) \{ box-shadow: var\(--float-hi\); \}/.test(ncss)
    && /\.chip:hover \{ translate: 0 -1px; \}/.test(ncss) && /\.rtile:hover \{ translate: 0 -2px; \}/.test(ncss),
    'Home chips and tiles: --float-hi on hover, rising 1 / 2 px (the design), 0.97 pressed');
  const tr = (ncss.match(/\.chip, \.rtile \{\s*transition:[^}]*\}/) || [''])[0] + (css.match(/\.navrow > button, #newtab, #workspace-pill \{\s*transition:[^}]*\}/) || [''])[0];
  check(tr && !/box-shadow|filter/.test(tr) && (tr.match(/scale var\(--m-press\)/g) || []).length === 2, 'the press scales in 160; no shadow or filter is animated', tr);
}

/* ---- pop-over motion (LOOK.md section 10) ---- */
{
  const tok = fs.readFileSync(path.join(__dirname, 'tokens.css'), 'utf8');
  check(['--m-pop-in-fade: 160ms;', '--m-pop-in-move: 260ms;', '--m-pop-from-y: -6px;', '--m-pop-from-s: 0.97;', '--m-pop-out-fade: 120ms;', '--m-pop-out-move: 160ms;'].every((t) => tok.indexOf(t) >= 0),
    'pop-overs: in 160 / 260 from -6 and 0.97, out 120 / 160');
  const ruleAt = (head) => { const k = css.indexOf(head); return k < 0 ? '' : css.slice(k, css.indexOf('}', k) + 1); };
  const pop = ['#shield-panel, #downloads-panel, #workspaces-panel, #tabmenu, #bm-overflow, #siteinfo-panel {',
    '#tabmenu:not([hidden]), #bm-overflow:not([hidden]), #siteinfo-panel:not([hidden]) {', '#findbar {', '#findbar:not([hidden]) {'].map(ruleAt);
  check(pop.every((b) => /transition:/.test(b) && /m-pop-/.test(b)), 'four pop-over transition rules (panels out / in, find bar out / in)', pop);
  check(pop.every((b) => (b.replace(/^[^{]*\{/, '').match(/(?:^|,|:)\s*([a-z-]+) var\(--/g) || []).map((x) => x.replace(/^[,:\s]*/, '').split(' ')[0])
    .every((p) => ['opacity', 'translate', 'scale', 'display', 'background-color', 'color', 'border-color', 'transition'].indexOf(p) >= 0)),
    'pop-overs move on opacity / translate / scale only (the find bar keeps its theme colours)');
  check(pop.filter((b) => /:not\(\[hidden\]\)/.test(b)).every((b) => /opacity var\(--m-pop-in-fade\) var\(--m-ease-lift\)/.test(b) && /translate var\(--m-pop-in-move\) var\(--m-ease-lift\)/.test(b) && /scale var\(--m-pop-in-move\) var\(--m-ease-lift\)/.test(b)),
    'opening: ease-lift, 160 opacity, 260 transform');
  const ccss = strip(fs.readFileSync(path.join(__dirname, 'chrome.css'), 'utf8'));
  const rm = ccss.slice(ccss.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  check(/#findbar \{[^}]*transition: opacity var\(--m-dur-rm\) var\(--m-fade-in\), display var\(--m-dur-rm\) allow-discrete !important;/.test(rm.replace(/#siteinfo-panel,[^{]*#findbar/, '#findbar'))
    && /scale: none !important;/.test(rm), 'reduced motion: chrome.css still forces the 120 ms opacity fade over these (!important)');
}

/* ---- the first load (LOOK.md section 10) ---- */
{
  const tok = fs.readFileSync(path.join(__dirname, 'tokens.css'), 'utf8');
  check(tok.indexOf('--m-rise: 520ms;') >= 0 && tok.indexOf('--m-rise-step: 45ms;') >= 0, 'first load: 520, staggered 45');
  check(/body:not\(\.booted\) #titlebar,\s*body:not\(\.booted\) \.navrow \{ opacity: 0; translate: 0 10px; \}/.test(css), 'the rows start 10 low and clear');
  const r = css.slice(css.indexOf('body.booted #titlebar,'), css.indexOf('}', css.indexOf('body.booted #titlebar,')));
  check(/transition: opacity var\(--m-rise\) var\(--m-ease-look\) var\(--isl-rise-at\),\s*translate var\(--m-rise\)/.test(r) && !/animation/.test(r),
    'they rise on a transition off body.booted (set once), so showing a row again never replays it', r);
  check(/\.navrow \{ --isl-rise-at: calc\(var\(--m-rise-from\) \+ var\(--m-rise-step\)\); \}/.test(css), 'the tool row follows the tab row 45 later');
  check(/body:not\(\.booted\) \.chrome-layer \{ opacity: 1; transform: none; \}/.test(css), 'the old whole-layer drop is off in the new look');
  check((app.match(/classList\.add\('booted'\)/g) || []).length === 1 && !/classList\.remove\('booted'\)/.test(app), 'app.js adds booted once and never takes it off');
}

/* ---- the caption buttons (LOOK.md section 2) ---- */
{
  const ccss = strip(fs.readFileSync(path.join(__dirname, 'chrome.css'), 'utf8'));
  check(/#win-min, #win-max, #win-close \{\s*width: 46px;\s*height: 100%;/.test(ccss) && /\.wincontrols \{ align-self: flex-start; margin-top: -6px; height: var\(--tab-row-h\); \}/.test(css),
    'caption buttons: 46 wide and the full 44 px row (the group has a definite height for their 100%)');
  check(/#win-min \.glyph, #win-max \.glyph, #win-close \.glyph \{ font-size: 10px; \}/.test(ccss), 'caption glyphs 10 px');
}

/* ---- the caption buttons at rest paint nothing in the window's row 0 (toprow-e2e) ----
   The top-row hint (toprow.js) says what row 0 is: the picture under the wash, the caption corner
   included. LOOK.md: "Bare over the picture", so at rest neither the group nor a button has a fill,
   and the 10 px glyphs sit in the middle of the 44 px row, clear of row 0. Collapsed to their
   glyph's height (no definite height on the lifted group), the buttons put the maximise square's
   top edge and the close X's tips into row 0: cols 37-39 of 40 read up to 68 levels lighter. */
{
  const ccss = strip(fs.readFileSync(path.join(__dirname, 'chrome.css'), 'utf8'));
  const both = ccss + '\n' + css;
  const CAP = /#win-(min|max|close)\b|\.wincontrols\b/;
  const AT_REST_ONLY = /:(hover|active|focus-visible|focus)\b/;
  const fills = [];
  for (const m of both.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(',').map((s) => s.trim()).filter((s) => CAP.test(s) && !AT_REST_ONLY.test(s));
    if (!sels.length) continue;
    for (const d of m[2].split(';')) {
      const kv = d.split(':'); if (kv.length < 2) continue;
      const prop = kv[0].trim(), val = kv.slice(1).join(':').trim();
      if (/^(background|background-color|background-image|box-shadow|border|border-top|border-color|outline)$/.test(prop) && !/^(none|transparent|0)$/.test(val)) fills.push(sels.join(', ') + ' { ' + prop + ': ' + val + ' }');
    }
  }
  check(fills.length === 0, 'caption buttons at rest: no fill, shadow or edge on the group or a button (hover / press only)', fills);
  check(/(^|\n)button \{[^}]*\bbackground: none;/.test(ccss), 'the shared button reset paints no background');

  // Where the glyph sits: the group's top in the window, the row it fills, the glyph centred in it.
  const px = (re, src) => { const m = src.match(re); return m ? Number(m[1]) : NaN; };
  const titlebarH = px(/--titlebar-h:\s*(\d+)px/, ccss);
  const rowH = /--tab-row-h:\s*calc\(var\(--titlebar-h\) \+ 4px\)/.test(css) ? titlebarH + 4 : NaN;
  const tb = css.match(/#titlebar \{[^}]*\bpadding:\s*(\d+)px/);
  const wc = css.match(/\.wincontrols \{([^}]*)\}/);
  const groupTop = (tb ? Number(tb[1]) : NaN) + (wc && /margin-top:\s*(-?\d+)px/.test(wc[1]) ? Number(wc[1].match(/margin-top:\s*(-?\d+)px/)[1]) : 0);
  const glyphPx = px(/#win-min \.glyph, #win-max \.glyph, #win-close \.glyph \{ font-size: (\d+)px; \}/, ccss);
  const lineH1 = /(^|\n)\.glyph \{[^}]*line-height: 1;/.test(ccss);
  // a lifted (flex-start) group with no height of its own: the buttons' 100% falls to their glyph
  const groupH = wc && /height:\s*var\(--tab-row-h\)/.test(wc[1]) ? rowH : (lineH1 ? glyphPx : NaN);
  const centred = /(^|\n)button \{[^}]*align-items: center;/.test(ccss);
  const glyphTop = groupTop + (centred ? (groupH - glyphPx) / 2 : 0);
  // drop-shadow(0 1px 1px): it reaches 2 px from the glyph, downward; the glyph itself must leave row 0
  check(groupTop === 0 && groupH === 44 && glyphTop >= 2, 'caption buttons: the group starts at the window top and fills the 44 px row, so the 10 px glyph sits ' + glyphTop + ' px down, clear of row 0',
    { groupTop, groupH, glyphPx, glyphTop, lineH1, centred });
}

/* ---- reduced motion covers every motion of the look (LOOK.md section 10: only quick fades) ----
   Read from the sheets, not a list: every rule in islands.css that MOVES something (a non-none
   translate / scale / rotate / transform, a keyframes animation that is not opacity-only, a
   view-transition snapshot of newtab.css's) must be undone under prefers-reduced-motion by a rule
   that really wins the cascade there: the same element set or wider, and !important or at least
   as specific and later. Whatever still runs under reduced motion must be an opacity fade of at
   most --m-dur-rm (120 ms); a transition or animation marked !important outside the reduced-
   motion blocks would outrank tokens.css's catch-all, so there must be none. newtab.css's press
   scales and big-chart snapshots are held to the same rule. */
{
  /** Flat list of { sel, body, rm, starting, kf, pos } from a sheet (comments stripped). */
  function rulesOf(src, sheet) {
    const out = [];
    const stack = [];
    let i = 0, start = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '{') {
        const prelude = src.slice(start, i).trim();
        if (prelude.startsWith('@')) { stack.push(prelude); start = i + 1; i++; continue; }
        const end = src.indexOf('}', i);
        out.push({ sheet, sel: prelude.replace(/\s+/g, ' '), body: src.slice(i + 1, end), pos: out.length,
          rm: stack.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)),
          starting: stack.some((a) => /^@starting-style/.test(a)),
          kf: (stack.find((a) => /^@keyframes/.test(a)) || '').replace(/^@keyframes\s+/, '') || null });
        i = end + 1; start = i; continue;
      }
      if (c === '}') { stack.pop(); start = i + 1; }
      else if (c === ';' && !stack.length) start = i + 1;   // @import / @charset at the top
      i++;
    }
    return out;
  }
  const splitSel = (s) => { const out = []; let d = 0, cur = ''; for (const ch of s) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && !d) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
  /** Compounds of a selector, each a set of simple tokens, with the combinators between. */
  function compounds(sel) {
    const parts = sel.replace(/\s*([>+~])\s*/g, ' $1 ').trim().split(/\s+/);
    const cs = [];
    for (const p of parts) {
      if (/^[>+~]$/.test(p)) { cs.push(p); continue; }
      const toks = [];
      const re = /(:not\([^)]*\)|:[\w-]+\([^)]*\)|::?[\w-]+|#[\w-]+|\.[\w-]+|\[[^\]]*\]|\*|[a-zA-Z][\w-]*)/g;
      let m; while ((m = re.exec(p))) if (m[1] !== '*') toks.push(m[1]);
      cs.push(toks);
    }
    return cs;
  }
  function specificity(sel) {
    let a = 0, b = 0, c = 0;
    for (const comp of compounds(sel)) {
      if (typeof comp === 'string') continue;
      for (const t of comp) {
        if (/^:where\(/.test(t)) continue;
        if (/^:(not|is)\(/.test(t)) { const s = specificity(t.replace(/^:\w+\(|\)$/g, '')); a += s[0]; b += s[1]; c += s[2]; continue; }
        if (t[0] === '#') a++;
        else if (t[0] === '.' || t[0] === '[' || (t[0] === ':' && t[1] !== ':')) b++;
        else c++;
      }
    }
    return [a, b, c];
  }
  const geq = (x, y) => x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] >= y[2];
  /** Does `wide` match every element `narrow` matches? (same chain, each compound a subset) */
  function covers(wide, narrow) {
    const w = compounds(wide), n = compounds(narrow);
    if (w.length !== n.length) return false;
    return w.every((cw, k) => typeof cw === 'string' ? cw === n[k] : typeof n[k] !== 'string' && cw.every((t) => n[k].includes(t)));
  }
  const decl = (body, prop) => { const m = body.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]*)')); return m ? m[1].trim() : null; };
  const SHEETS = ['chrome.css', 'newtab.css', 'islands.css'];   // index.html's order for the chrome ones
  const all = [];
  for (const f of SHEETS) all.push(...rulesOf(strip(fs.readFileSync(path.join(__dirname, f), 'utf8')), f));
  const order = (r) => SHEETS.indexOf(r.sheet) * 1e6 + r.pos;
  const rmRules = all.filter((r) => r.rm && !r.kf);
  /** A reduced-motion rule that turns `prop` off for selector `sel` (of rule `r`) and wins. */
  function undone(r, sel, prop, isOff) {
    const sameDoc = (x) => (r.sheet === 'newtab.css') === (x.sheet === 'newtab.css');   // newtab.css is the Home's own document
    return rmRules.some((x) => sameDoc(x) && splitSel(x.sel).some((s) => {
      const v = decl(x.body, prop);
      if (v === null || !isOff(v.replace(/\s*!important$/, ''))) return false;
      if (!covers(s, sel)) return false;
      return /!important$/.test(v) || (geq(specificity(s), specificity(sel)) && order(x) > order(r));
    }));
  }
  const MOVE = ['translate', 'scale', 'rotate', 'transform'];
  const off = (v) => v === 'none' || v === 'initial' || v === 'unset';
  const kfMoves = {};
  for (const r of all) if (r.kf) kfMoves[r.kf] = kfMoves[r.kf] || MOVE.some((p) => decl(r.body, p) !== null);
  const missing = [];
  let movers = 0;
  // 1. islands.css: every non-none move, in any state (an :active press, the unbooted rise, a
  // [hidden] or @starting-style pop-over origin)
  for (const r of all.filter((x) => x.sheet === 'islands.css' && !x.rm && !x.kf)) {
    for (const p of MOVE) {
      const v = decl(r.body, p);
      if (v === null || off(v)) continue;
      for (const s of splitSel(r.sel)) { movers++; if (!undone(r, s, p, off)) missing.push(r.sheet + ' ' + s + ' { ' + p + ': ' + v + ' }'); }
    }
  }
  // 2. newtab.css: the look's press scales (the shared --m-press-* tokens)
  for (const r of all.filter((x) => x.sheet === 'newtab.css' && !x.rm && !x.kf)) {
    const v = decl(r.body, 'scale');
    if (!v || !/var\(--m-press/.test(v)) continue;
    for (const s of splitSel(r.sel)) { movers++; if (!undone(r, s, 'scale', off)) missing.push(r.sheet + ' ' + s + ' { scale: ' + v + ' }'); }
  }
  // 3. every keyframes animation in islands.css that moves, and every view-transition snapshot
  // newtab.css times, is switched off (animation: none)
  const animOff = (v) => /^none\b/.test(v);
  for (const r of all.filter((x) => !x.rm && !x.kf)) {
    const v = decl(r.body, 'animation');
    if (!v) continue;
    const vt = r.sheet === 'newtab.css' && /::view-transition-(group|old|new)\(stk-/.test(r.sel);
    const moving = r.sheet === 'islands.css' && Object.keys(kfMoves).some((k) => kfMoves[k] && new RegExp('(^|[\\s,])' + k + '\\b').test(v));
    if (!vt && !moving) continue;
    for (const s of splitSel(r.sel)) { movers++; if (!undone(r, s, 'animation', animOff)) missing.push(r.sheet + ' ' + s + ' { animation: ' + v.slice(0, 60) + ' }'); }
  }
  for (const r of all.filter((x) => x.sheet === 'newtab.css' && !x.rm && /::view-transition-(group|old|new)\(stk-/.test(x.sel) && decl(x.body, 'animation-duration'))) {
    for (const s of splitSel(r.sel)) { movers++; if (!undone(r, s, 'animation', animOff)) missing.push(r.sheet + ' ' + s + ' { animation-duration }'); }
  }
  check(movers >= 15 && missing.length === 0, 'reduced motion: every look motion (' + movers + ' moves: presses, the rise, pop-over origins, sink / lift, the chart snapshots) is undone by a rule that wins', missing);
  // 4. what still runs under reduced motion in islands.css is an opacity fade of at most --m-dur-rm
  const kept = all.filter((r) => r.sheet === 'islands.css' && r.rm && !r.kf && (/(transition|animation)[^;]*!important/.test(r.body) || /--rm-keep\s*:/.test(r.body)));
  const notFade = kept.filter((r) => {
    const t = decl(r.body, 'transition'), a = decl(r.body, 'animation');
    const tOk = !t || t.replace(/\s*!important$/, '').split(',').every((x) => /^\s*(opacity|display)\s+var\(--m-dur-rm\)/.test(x) || /^\s*none\s*$/.test(x));
    const aOk = !a || /^none\b/.test(a);
    const keep = decl(r.body, '--rm-keep');
    return !tOk || !aOk || (keep !== null && keep !== 'var(--m-dur-rm)');
  });
  check(kept.length > 0 && notFade.length === 0, 'reduced motion: whatever islands.css keeps running is an opacity fade of --m-dur-rm (120 ms), nothing longer, nothing moving', notFade.map((r) => r.sel + ' { ' + r.body.trim().slice(0, 120) + ' }'));
  // 5. no look motion outranks the catch-all from outside a reduced-motion block
  const loud = all.filter((r) => r.sheet === 'islands.css' && !r.rm && /(transition|animation)[^:;]*:[^;]*!important/.test(r.body));
  check(loud.length === 0, 'islands.css: no transition or animation says !important outside reduced motion (it would outrank tokens.css\'s catch-all)', loud.map((r) => r.sel));
}

console.log('islands: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
