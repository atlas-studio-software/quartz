// tabfit-harness.js - pure-node test for tabfit.js's plan and its out-of-view arithmetic
// (run: node tabfit-harness.js). The DOM half is taboverflow-e2e.js.
'use strict';
const T = require('./tabfit');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (detail !== undefined ? '\n  ' + JSON.stringify(detail) : '')); }
}

const K = { tabMin: 104, floor: 48, titleMin: 72, audioExtra: 24, gap: 4 };
const P = (o) => T.plan(Object.assign({ fixed: [], active: true, flex: 0, audible: 0 }, K, o));

/* ---- plan --------------------------------------------------------------------------------- */
ok('one tab: natural', P({ avail: 300, flex: 0 }).fit === false);
ok('everything at 104 fits: natural', P({ avail: 5 * 104 + 4 * 4, flex: 4 }).fit === false);
{
  const p = P({ avail: 5 * 104 + 4 * 4 - 1, flex: 4 });
  ok('1px short of natural: fitted, titles', p.fit && !p.icons && !p.overflow && p.w === 103, p);
}
{
  const p = P({ avail: 1000, flex: 14 });             // 15 tabs
  const used = 104 + 14 * p.w + 14 * 4;
  ok('15 tabs in 1000px: fitted, nothing scrolls', p.fit && !p.overflow, p);
  ok('15 tabs in 1000px: the plan fills but never exceeds the room', used <= 1000 && used > 1000 - 14, { used, w: p.w });
}
{
  const t = P({ avail: 258, flex: 2 }), i = P({ avail: 230, flex: 2 }), o = P({ avail: 258, flex: 4 });
  ok('3 tabs in a 500px window: fitted with titles', t.fit && !t.icons && !t.overflow && t.w === 73, t);
  ok('3 tabs in a narrower strip: icons', i.fit && i.icons && !i.overflow, i);
  ok('5 tabs in a 500px window: at the floor and scrolling', o.fit && o.overflow && o.w === 48, o);
}
{
  const p = P({ avail: 258, flex: 39 });
  ok('40 tabs in a 500px window: at the floor and scrolling', p.fit && p.overflow && p.w === 48, p);
}
{
  const p = P({ avail: 1650, flex: 79 });
  ok('80 tabs at 1920: at the floor and scrolling', p.fit && p.overflow && p.w === 48, p);
}
{
  const a = P({ avail: 900, flex: 12 }), b = P({ avail: 900, flex: 12, audible: 2 });
  ok('a speaker costs its own width, not everyone\'s', b.w < a.w && a.w - b.w <= Math.ceil(2 * 24 / 12), { a, b });
}
{
  const p = P({ avail: 800, flex: 9, fixed: [40, 40, 40] });
  ok('pinned chips are taken off the top', p.fit && p.w === Math.floor((800 - 120 - 104 - 12 * 4) / 9), p);
}
ok('only pinned tabs: nothing to fit', P({ avail: 100, flex: 0, fixed: Array(30).fill(40) }).fit === false);
{
  const p = P({ avail: 300, flex: 5, active: false });
  ok('no active chip (a drag raised it): all share', p.fit && p.w === Math.floor((300 - 4 * 4) / 5), p);
}
ok('a hidden titlebar (0 px): floor, scrolling, never NaN', (() => { const p = P({ avail: 0, flex: 5 }); return p.fit && p.overflow && p.w === 48; })());
ok('NaN room: floor', (() => { const p = P({ avail: NaN, flex: 5 }); return p.fit && p.w === 48; })());
ok('never wider than --tab-min', (() => { const p = P({ avail: 5 * 104 + 15, flex: 4, audible: 0 }); return p.w <= 104; })());

/* ---- hidden ------------------------------------------------------------------------------- */
// 20 chips of 48 + 4 gap, first at 0.
const chips = Array.from({ length: 20 }, (_, i) => ({ l: i * 52, r: i * 52 + 48 }));
const SW = 20 * 52 - 4;
const G = (s, cw) => ({ scrollLeft: s, clientWidth: cw || 300, scrollWidth: SW, edge: 30, chips });
{
  const h = T.hidden(G(0));
  ok('at the start: nothing left, the rest right', h.left === 0 && h.right > 0 && h.insetL === 0 && h.insetR === 30, h);
  // clear zone 0..270: chips 0..4 fully in (4 ends at 256), chip 5 (260..308) not
  ok('at the start: the right count is every chip not fully in the clear', h.right === 15 && h.lastShown === 4, h);
}
{
  const max = SW - 300;
  const h = T.hidden(G(max));
  ok('at the end: nothing right', h.right === 0 && h.left > 0 && h.insetR === 0, h);
}
{
  const h = T.hidden(G(2));
  ok('2px in: the first chip counts as hidden (it is under the fade)', h.left === 1 && h.insetL === 30, h);
}
{
  // every chip is counted or fully in the clear, at every scroll position
  let bad = null;
  for (let s = 0; s <= SW - 300; s += 7) {
    const h = T.hidden(G(s));
    const shown = chips.filter((c) => c.l >= s + h.insetL - 0.5 && c.r <= s + 300 - h.insetR + 0.5).length;
    if (h.left + h.right + shown !== chips.length) { bad = { s, h, shown }; break; }
  }
  ok('every chip is either in the clear or counted, at every scroll position', !bad, bad);
}
ok('no overflow: no counts', (() => { const h = T.hidden({ scrollLeft: 0, clientWidth: 2000, scrollWidth: 2000, edge: 30, chips }); return h.left === 0 && h.right === 0 && !h.overflow; })());
ok('a pixel of rounding is not a hidden tab', (() => { const h = T.hidden({ scrollLeft: 0, clientWidth: SW - 1, scrollWidth: SW, edge: 30, chips }); return h.right === 0; })());

/* ---- revealScroll ------------------------------------------------------------------------- */
const shown = (g, c, s) => { const h = T.hidden(Object.assign({}, g, { scrollLeft: s })); return c.l >= s + h.insetL - 0.5 && c.r <= s + g.clientWidth - h.insetR + 0.5; };
{
  let bad = null;
  for (let s0 = 0; s0 <= SW - 300 && !bad; s0 += 13) {
    for (let i = 0; i < chips.length; i++) {
      const g = G(s0);
      const s = T.revealScroll(g, chips[i]);
      if (!shown(g, chips[i], s)) { bad = { s0, i, s }; break; }
    }
  }
  ok('revealScroll shows any chip from any scroll position', !bad, bad);
}
ok('revealScroll leaves a chip that is already shown alone', T.revealScroll(G(100), chips[4]) === 100);
ok('revealScroll on the last chip goes to the very end', T.revealScroll(G(0), chips[19]) === SW - 300);
ok('revealScroll on the first chip goes to 0', T.revealScroll(G(400), chips[0]) === 0);
{
  const g = G(0);
  const s = T.revealScroll(g, chips[19], chips[0]);
  ok('a background tab is not shown at the cost of the active one', s === 0, s);
  const s2 = T.revealScroll(g, chips[6], chips[3]);
  ok('a background tab is shown when the active one stays shown', shown(g, chips[6], s2) && shown(g, chips[3], s2), s2);
}

/* ---- pageScroll --------------------------------------------------------------------------- */
{
  let s = 0, steps = 0;
  const seen = new Set();
  while (steps < 50) {
    const g = G(s);
    T.hidden(g);
    chips.forEach((c, i) => { if (shown(g, c, s)) seen.add(i); });
    const n = T.pageScroll(g, 1);
    if (n <= s) break;
    s = n; steps++;
  }
  ok('paging right reaches the end and every chip is shown on some page', s === SW - 300 && seen.size === 20, { s, steps, seen: seen.size });
  ok('paging right takes a few pages, not one per chip', steps >= 2 && steps <= 8, steps);
  let back = s, bsteps = 0;
  while (bsteps < 50) { const n = T.pageScroll(G(back), -1); if (n >= back) break; back = n; bsteps++; }
  ok('paging left gets back to 0', back === 0, { back, bsteps });
}
{
  const g = G(0);
  const n = T.pageScroll(g, 1);
  const h0 = T.hidden(g);
  ok('a page keeps one chip of overlap', shown(g, chips[h0.lastShown], n) || chips[h0.lastShown].l === n + 30, { n, last: h0.lastShown });
}

/* ---- small things ------------------------------------------------------------------------- */
ok('wheel lines are 40px', T.wheelPx(3, 1) === 120);
ok('wheel pages are the strip', T.wheelPx(1, 2, 333) === 333);
ok('wheel pixels pass through', T.wheelPx(-53, 0) === -53);
ok('count caps at 99+', T.countText(5) === '5' && T.countText(99) === '99' && T.countText(140) === '99+');

console.log('tabfit-harness: ' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
