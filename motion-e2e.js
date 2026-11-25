// motion-e2e.js -- the motion Quartz shares with Mantle and Helm (next-week/motion-unison.md), on a
// REAL Quartz test instance (tests/e2e-kit.js: --test-profile, off-screen, watched).
//
//   node motion-e2e.js
//
// 1. The tokens: --m-spring is Mantle's bar spring point for point (41 points), the durations are
//    the spec's (240/320/440/560 ms, OUT 45 %, reduced 120 ms).
// 2. Every surface that arrives and leaves (site info, shield, downloads, workspaces, the palette,
//    Settings, the tab menu, find): it opens and closes on opacity/translate/scale ONLY; [hidden]
//    and "takes no clicks" flip the moment it closes, the box stays drawn through the fade and is
//    gone (display:none) after it; no layout runs in the middle of an open; and an animation cut
//    short (closed mid-open, opened mid-close, twelve toggles a frame apart) always ends in the
//    state last asked for, fully drawn or fully gone. Frames over 20 ms are reported per surface.
// 3. Reduced motion: opacity only, 120 ms.
// 4. The tab strip: a new tab arrives (.is-born, then cleared); closing one makes the chips after
//    it glide (translate only) and they end exactly where the layout puts them.
//
// Summary line:  motion-e2e: N passed, M failed
'use strict';
const path = require('path');
const { run, serve, html, sleep } = require('./tests/e2e-kit');

const SPRING = [0, 0.0208, 0.0739, 0.1478, 0.2337, 0.3245, 0.4153, 0.5025, 0.5838, 0.6577, 0.7235,
  0.7808, 0.8301, 0.8716, 0.906, 0.9341, 0.9566, 0.9742, 0.9876, 0.9977, 1.0049, 1.0098, 1.0128, 1.0145,
  1.0151, 1.015, 1.0143, 1.0132, 1.012, 1.0106, 1.0092, 1.0079, 1.0066, 1.0055, 1.0044, 1.0035, 1.0028,
  1.0021, 1.0015, 1.0011, 1];
const DUR = { xs: 240, s: 320, m: 440, l: 560 };
const SURFACES = [
  { id: 'siteinfo-panel', open: 'SiteInfo.open()', close: 'SiteInfo.close()', d: 's' },
  { id: 'shield-panel', open: 'Shield.open()', close: 'Shield.close()', d: 's' },
  { id: 'downloads-panel', open: 'Downloads.open()', close: 'Downloads.close()', d: 's' },
  { id: 'workspaces-panel', open: 'Workspaces.open()', close: 'Workspaces.close()', d: 's' },
  { id: 'tabsearch', open: 'TabSearch.open()', close: 'TabSearch.close()', d: 's' },
  { id: 'settings-panel', open: 'Settings.open()', close: 'Settings.close()', d: 'm' },
  { id: 'tabmenu', open: 'openTabMenu(220, 44, tabMenuItemsForTab(getActiveTab()))', close: 'closeTabMenu()', d: 'xs' },
  { id: 'findbar', open: 'FindBar.open()', close: 'FindBar.close()', d: 'xs' },
];
const MOTION_PROPS = new Set(['opacity', 'translate', 'scale', 'display']);

/** The in-page run for one surface: returns what it saw at every step. */
function probeSource(sf) {
  const dIn = DUR[sf.d], dOut = Math.round(DUR[sf.d] * 0.45);
  return `(async () => {
    const OPEN = () => { ${sf.open}; }, CLOSE = () => { ${sf.close}; };
    const el = () => document.getElementById(${JSON.stringify(sf.id)});
    const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const props = (e) => e.getAnimations().map((a) => a.transitionProperty || a.animationName || a.id || '?');
    const state = (e) => { const s = getComputedStyle(e); return { hidden: e.hidden, op: s.opacity, tr: s.translate, sc: s.scale, pe: s.pointerEvents, disp: s.display }; };
    const out = {};
    OPEN(); await wait(${dIn + 150}); CLOSE(); await wait(${dOut + 200});   // warm: the first open builds it
    OPEN(); const e = el(); getComputedStyle(e).opacity; await raf();
    out.openProps = props(e);
    const deltas = []; let last = performance.now(); const t0 = last;
    await new Promise((r) => { const f = (t) => { deltas.push(t - last); last = t; if (t - t0 < ${dIn + 120}) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f); });
    out.frames = deltas.slice(1).length; out.over20 = deltas.slice(1).filter((x) => x > 20).length; out.worst = Math.round(Math.max(0, ...deltas.slice(1)));
    out.settled = state(e);
    CLOSE(); out.atClose = state(e); out.closeProps = props(e);
    await wait(${dOut + 150}); out.afterClose = state(e);
    OPEN(); await wait(60); CLOSE(); await wait(40); OPEN(); await wait(${dIn + 250}); out.cutOpen = state(el());
    CLOSE(); await wait(50); OPEN(); await wait(30); CLOSE(); await wait(${dIn + 250}); out.cutClose = state(el());
    for (let i = 0; i < 12; i++) { if (i % 2) CLOSE(); else OPEN(); await raf(); }
    await wait(${dIn + 250}); out.toggled = state(el());
    CLOSE(); await wait(${dOut + 200});
    return out;
  })()`;
}

run('motion-e2e', async ({ check, launch, say }) => {
  const srv = await serve((req, res, p) => (/^\/p\/\d+\.html$/.test(p) ? html(res, '<!doctype html><title>Motion page</title><p>A page to find in, with a path.</p>') : false));
  const B = 'http://127.0.0.1:' + srv.port;
  const q = await launch({ cdp: 9452 });
  const c = q.chrome;
  await c.send('Page.enable');
  await c.send('Performance.enable');
  // Full motion is pinned, not inherited: with Windows' "Show animations" off (as on the hosted CI
  // runner) the system reports reduce, and every full-motion check below would read the reduced path.
  // Section 3 switches to reduce on purpose and back to THIS, never to the system's value.
  const FULL_MOTION = { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] };
  await c.send('Emulation.setEmulatedMedia', FULL_MOTION);
  const ev = (s) => c.ev(s);
  const layouts = async () => { const m = await c.send('Performance.getMetrics'); const x = ((m.result && m.result.metrics) || []).find((k) => k.name === 'LayoutCount'); return x ? x.value : NaN; };
  await ev(`(() => { const t = createTab(${JSON.stringify(B + '/p/1.html')}); activateTab(t.id); return 1; })()`);
  await c.waitFor('tabs.every((t) => t.kind !== "page" || t.ready !== false)', 15000).catch(() => 0);
  await sleep(800);

  /* ---- 1. the tokens ---- */
  const tok = await ev(`(() => { const s = getComputedStyle(document.documentElement); const g = (k) => s.getPropertyValue(k).trim(); return { spring: g('--m-spring'), accel: g('--m-accel'), fin: g('--m-fade-in'), fout: g('--m-fade-out'), xs: g('--m-dur-xs'), s: g('--m-dur-s'), m: g('--m-dur-m'), l: g('--m-dur-l'), rm: g('--m-dur-rm'), old: g('--ease-spring') + g('--dur-spring') }; })()`);
  const pts = ((/linear\(([\s\S]*)\)/.exec(tok.spring) || [])[1] || '').split(',').map((x) => Number(x.trim()));
  check(pts.length === 41 && pts.every((v, i) => v === SPRING[i]), '--m-spring is Mantle’s bar spring, all 41 points', pts.length + ' points: ' + tok.spring.slice(0, 80));
  check(tok.accel.replace(/\s/g, '') === 'cubic-bezier(.3,0,.8,.15)' && tok.fin.replace(/\s/g, '') === 'cubic-bezier(.2,0,0,1)' && tok.fout.replace(/\s/g, '') === 'cubic-bezier(.4,0,1,1)', '--m-accel / --m-fade-in / --m-fade-out are the spec’s curves', tok);
  check(tok.xs === '240ms' && tok.s === '320ms' && tok.m === '440ms' && tok.l === '560ms' && tok.rm === '120ms', 'durations xs 240, s 320, m 440, l 560, reduced 120', tok);
  check(tok.old === '', 'the lane-local --ease-spring / --dur-spring are gone', tok.old);

  /* ---- 2. every surface ---- */
  const frameReport = [];
  for (const sf of SURFACES) {
    await ev('(() => { closeTabMenu(); for (const f of [() => Settings.close(), () => SiteInfo.close(), () => Shield.close(), () => Downloads.close(), () => FindBar.close(), () => TabSearch.close(), () => Workspaces.close()]) { try { f(); } catch (e) {} } return 1; })()');
    await sleep(300);
    let r;
    try { r = await c.ev(probeSource(sf)); } catch (e) { check(false, sf.id + ': the probe ran', e.message); continue; }
    if (!r || !r.settled) { check(false, sf.id + ': the probe ran', r); continue; }
    const onlyMotion = (list) => list.length > 0 && list.every((p) => MOTION_PROPS.has(p));
    const open = (s) => s && !s.hidden && s.op === '1' && s.tr === 'none' && s.sc === 'none' && s.pe !== 'none' && s.disp !== 'none';
    const gone = (s) => s && s.hidden && s.disp === 'none';
    check(onlyMotion(r.openProps), sf.id + ': opens on opacity/translate/scale only', r.openProps);
    check(open(r.settled), sf.id + ': settles fully open (opacity 1, no offset, no scale)', r.settled);
    check(r.atClose.hidden && r.atClose.pe === 'none' && r.atClose.disp !== 'none' && onlyMotion(r.closeProps), sf.id + ': closing flips [hidden] and clicks at once, the box fades out on opacity/translate/scale', { at: r.atClose, props: r.closeProps });
    check(gone(r.afterClose), sf.id + ': gone (display:none) once the fade ends', r.afterClose);
    check(open(r.cutOpen), sf.id + ': closed mid-open and opened again: ends fully open', r.cutOpen);
    check(gone(r.cutClose), sf.id + ': opened mid-close and closed again: ends fully gone', r.cutClose);
    check(gone(r.toggled), sf.id + ': twelve toggles a frame apart end in the last state asked for', r.toggled);
    frameReport.push(sf.id + ' ' + r.over20 + '/' + r.frames + ' over 20 ms (worst ' + r.worst + ')');
    // The motion adds no layout: the same open with this surface's transitions switched off is
    // the control (a surface may lay out its own content as it fills, e.g. site info's
    // permissions); the animated open may not lay out more than that, give or take the
    // chrome's own once-a-second tick.
    const win = Math.round(DUR[sf.d] * 0.6);
    const count = async (still) => {
      if (still) await ev(`(() => { const st = document.createElement('style'); st.id = '__m_still'; st.textContent = '#${sf.id} { transition: none !important; }'; document.head.appendChild(st); return 1; })()`);
      await ev('(' + sf.open + ', 1)');
      await ev('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))');
      const l0 = await layouts();
      await sleep(win);
      const l1 = await layouts();
      await ev('(' + sf.close + ', 1)');
      await sleep(400);
      await ev("(() => { const st = document.getElementById('__m_still'); if (st) st.remove(); return 1; })()");
      await sleep(100);
      return l1 - l0;
    };
    const control = await count(true), animated = await count(false);
    check(animated - control <= 1, sf.id + ': the motion adds no layout while it arrives (' + animated + ' animated, ' + control + ' without transitions, in ' + win + ' ms)', { animated, control });
  }
  say('frames: ' + frameReport.join('; '));

  /* ---- 3. reduced motion: opacity only, 120 ms ---- */
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(200);
  for (const sf of [SURFACES[0], SURFACES[4], SURFACES[6]]) {
    const r = await ev(`(async () => { ${sf.open}; const e = document.getElementById(${JSON.stringify(sf.id)}); getComputedStyle(e).opacity; await new Promise((r) => requestAnimationFrame(() => r())); const a = e.getAnimations().map((x) => ({ p: x.transitionProperty || x.animationName, d: x.effect && x.effect.getTiming().duration })); const s = getComputedStyle(e); const st = { tr: s.translate, sc: s.scale }; ${sf.close}; await new Promise((r) => setTimeout(r, 300)); return { a, st }; })()`);
    const moving = r.a.filter((x) => x.p !== 'display');
    check(moving.length > 0 && moving.every((x) => x.p === 'opacity' && x.d === 120) && r.st.tr === 'none' && r.st.sc === 'none', sf.id + ': reduced motion fades (120 ms) and travels not at all', r);
  }
  await c.send('Emulation.setEmulatedMedia', FULL_MOTION);
  await sleep(200);

  /* ---- 4. the tab strip ---- */
  const born = await ev(`(async () => { const t = createTab(${JSON.stringify(B + '/p/2.html')}, { background: true }); const ch = t.chipEl; const had = ch.classList.contains('is-born'); await new Promise((r) => requestAnimationFrame(() => r())); const names = ch.getAnimations().map((a) => a.animationName); await new Promise((r) => setTimeout(r, 900)); return { had, names, after: ch.classList.contains('is-born'), id: t.id }; })()`);
  check(born.had && born.names.includes('q-tab-born-move') && born.names.includes('q-tab-born-fade') && !born.after, 'a new tab arrives (.is-born: rise + fade) and the class is gone after', born);
  const glide = await ev(`(async () => {
    const ids = []; for (let i = 3; i < 7; i++) ids.push(createTab(${JSON.stringify(B + '/p/')} + i + '.html', { background: true }).id);
    await new Promise((r) => setTimeout(r, 700));
    const later = ids.slice(1).map((id) => tabs.find((t) => t.id === id).chipEl);
    const st = document.getElementById('tabstrip');
    const was = { at: later.map((ch) => Math.round(ch.getBoundingClientRect().left)), scroll: Math.round(st.scrollLeft), max: st.scrollWidth - st.clientWidth, fit: st.dataset.fit || 'natural' };
    closeTab(ids[0]);
    await new Promise((r) => requestAnimationFrame(() => r()));
    const now = { at: later.map((ch) => Math.round(ch.getBoundingClientRect().left)), scroll: Math.round(st.scrollLeft), max: st.scrollWidth - st.clientWidth, fit: st.dataset.fit || 'natural' };
    const anims = later.map((ch) => ch.getAnimations().filter((a) => a.id === 'q-strip-glide'));
    const kinds = anims.flat().map((a) => Object.keys(a.effect.getKeyframes()[0]).filter((k) => !['offset', 'easing', 'composite', 'computedOffset'].includes(k)).join('+'));
    await new Promise((r) => setTimeout(r, 500));
    const still = later.every((ch) => !ch.getAnimations().some((a) => a.id === 'q-strip-glide'));
    const drawn = later.map((ch) => Math.round(ch.getBoundingClientRect().left));
    for (const ch of later) ch.style.translate = '0px 0px';
    const laid = later.map((ch) => Math.round(ch.getBoundingClientRect().left));
    for (const ch of later) ch.style.translate = '';
    for (const id of ids.slice(1)) closeTab(id);
    closeTab(${JSON.stringify(born.id)});
    return { gliding: anims.filter((a) => a.length).length, which: anims.map((a) => a.length > 0), kinds, still, drawn, laid, was, now };
  })()`);
  check(glide.gliding === 3 && glide.kinds.every((k) => k === 'translate'), 'closing a tab: the three chips after it glide, on translate only', glide);
  check(glide.still && JSON.stringify(glide.drawn) === JSON.stringify(glide.laid), 'the glide ends exactly where the layout puts each chip', glide);

  srv.close();
  await q.quit();
});
