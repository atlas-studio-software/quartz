// taboverflow-e2e.js -- the tab strip with more tabs than room, end to end (tabfit.js).
//
//   node taboverflow-e2e.js            (E2E_CDP=<port> for a port of its own; TABOVERFLOW_SHOTS=<dir>
//                                       to also save a PNG of the titlebar per width and theme)
//
// One REAL Quartz test instance (tests/e2e-kit.js: --test-profile, off-screen, watched). The chrome's
// viewport is set to 500, 800, 1280 and 1920 px wide (Emulation.setDeviceMetricsOverride: the same
// layout a window that wide gets) with 1, 5, 15, 40 and 80 tabs (born asleep, so 80 tabs are not 80
// guests). At every size, measured off the DOM by this file, not read back from tabfit.js:
//   - no tab is unreachable: every chip is fully in the clear part of the strip or counted by the
//     edge button on its side, and each button shows exactly the number of chips hidden on its
//     side (and is hidden when there are none); the tab-search badge shows their total;
//   - the active chip is in the clear and never under --tab-min; no inactive chip under the floor;
//   - the + sits right after the strip, the spacer keeps its grab area, nothing leaves the row;
//   - activating the first, the last and a middle tab brings each into view;
//   - a tab made with the + button is in view on the FIRST frame after it exists;
//   - the vertical wheel scrolls the strip sideways; the edge buttons page it.
// Then: drag-reorder on a strip that fits; a drag held at the edge of a scrolling strip steps it and
// drops the chip far past the first screen; pinned chips keep 40px at the left; and a restart with
// 40 tabs and the last one active boots with that tab in view.
// One summary line: "taboverflow-e2e: N passed, M failed".
'use strict';
const fs = require('fs');
const path = require('path');
const { run, serve, html, sleep } = require('./tests/e2e-kit');

const CDP = Number(process.env.E2E_CDP) || 9477;
const SHOTS = process.env.TABOVERFLOW_SHOTS || '';
const WIDTHS = [500, 800, 1280, 1920];
const COUNTS = [1, 5, 15, 40, 80];

/* Installed in the chrome page once per boot: the measuring half, independent of tabfit.js. */
const PROBE = `(() => {
  const R = (el) => el.getBoundingClientRect();
  const strip = document.getElementById('tabstrip');
  window.__ov = {
    chips: () => [...strip.children].filter((c) => c.classList.contains('tab') && !c.hidden),
    edge: () => parseFloat(getComputedStyle(strip).getPropertyValue('--tab-fit-edge')) || 30,
    measure() {
      const chips = this.chips();
      const s = R(strip);
      const prev = document.getElementById('tabstrip-prev');
      const next = document.getElementById('tabstrip-next');
      const prevOn = !!prev && !prev.hidden, nextOn = !!next && !next.hidden;
      const edge = this.edge();
      const clearL = s.left + (prevOn ? edge : 0), clearR = s.right - (nextOn ? edge : 0);
      let left = 0, right = 0, shown = 0;
      const rows = chips.map((c) => {
        const r = R(c);
        const st = r.left < clearL - 0.5 ? 'L' : r.right > clearR + 0.5 ? 'R' : 'in';
        if (st === 'L') left++; else if (st === 'R') right++; else shown++;
        return { id: c.dataset.tabId, w: r.width, st, active: c.classList.contains('active'), pinned: c.classList.contains('pinned') };
      });
      const num = (b) => (b && !b.hidden) ? Number((b.querySelector('.strip-edge-n') || {}).textContent) : 0;
      const badge = document.querySelector('#tabsearch-btn .ts-hidden-n');
      const nt = R(document.getElementById('newtab'));
      const sp = document.querySelector('#titlebar > .spacer');
      const wc = document.querySelector('#titlebar .wincontrols');
      const btnIn = (b, side) => { if (!b || b.hidden) return true; const r = R(b);
        return side === 'l' ? (r.left >= s.left - 0.5 && r.right <= s.left + edge + 0.5) : (r.right <= s.right + 0.5 && r.left >= s.right - edge - 0.5); };
      return {
        n: chips.length, left, right, shown, rows,
        prevN: num(prev), nextN: num(next), prevOn, nextOn,
        prevInFade: btnIn(prev, 'l'), nextInFade: btnIn(next, 'r'),
        badge: badge && !badge.hidden ? Number(badge.textContent) : 0,
        badgeTitle: document.getElementById('tabsearch-btn').title,
        fade: strip.dataset.fade || '',
        fit: strip.dataset.fit || '',
        stripR: s.right, ntL: nt.left, ntR: nt.right,
        spacerW: sp ? R(sp).width : -1, wcL: wc ? R(wc).left : -1, wcR: wc ? R(wc).right : -1,
        vw: innerWidth, scrollLeft: strip.scrollLeft, maxScroll: strip.scrollWidth - strip.clientWidth,
        tabMin: parseFloat(getComputedStyle(strip).getPropertyValue('--tab-min')) || 104,
        floor: parseFloat(getComputedStyle(strip).getPropertyValue('--tab-fit-floor')) || 48
      };
    },
    // The first frame after a chip is added: measured from a rAF the strip's own observer queues.
    armFirstFrame() {
      window.__ovFirst = null;
      const mo = new MutationObserver((recs) => {
        const added = recs.flatMap((r) => [...r.addedNodes]).find((n) => n.nodeType === 1 && n.classList.contains('tab'));
        if (!added) return;
        mo.disconnect();
        requestAnimationFrame(() => { window.__ovFirst = { id: added.dataset.tabId, m: window.__ov.measure() }; });
      });
      mo.observe(strip, { childList: true });
    },
    settle: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 320)))),
    async make(n, base) {
      for (const t of visibleTabs().slice()) if (t.pinned) setTabPinned(t, false);
      let i = 0;
      while (visibleTabs().length < n) createTab(base + 'p' + (i++) + '-' + visibleTabs().length + '/', { asleep: true });
      while (visibleTabs().length > n) {
        const v = visibleTabs();
        const victim = v.slice().reverse().find((t) => t.id !== activeTabId);
        if (!victim) break;
        closeTab(victim.id);
      }
      await this.settle();
      return visibleTabs().length;
    }
  };
  return true;
})()`;

run('taboverflow-e2e', async ({ check, launch, say }) => {
  const srv = await serve((req, res, p) => {
    const m = /^\/(p[0-9]+-[0-9]+)\/$/.exec(p);
    return m ? html(res, '<!doctype html><title>Page ' + m[1] + '</title><p>' + m[1] + '</p>') : false;
  });
  const BASE = 'http://127.0.0.1:' + srv.port + '/';

  let q = await launch({ cdp: CDP });
  let c = q.chrome;
  await c.ev(PROBE);
  const setWidth = (w) => c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 760, deviceScaleFactor: 1, mobile: false });
  const M = () => c.ev('__ov.measure()');
  const settle = () => c.ev('__ov.settle()');

  /** The invariants, at whatever state the strip is in now. */
  function invariants(tag, m) {
    check(m.left + m.right + m.shown === m.n, tag + ': every chip is in the clear or counted', { left: m.left, right: m.right, shown: m.shown, n: m.n });
    check(m.prevN === m.left && m.nextN === m.right, tag + ': the edge counts match the hidden chips', { prevN: m.prevN, left: m.left, nextN: m.nextN, right: m.right });
    check(m.prevOn === (m.left > 0) && m.nextOn === (m.right > 0), tag + ': an edge button shows exactly when its side hides tabs', { prevOn: m.prevOn, nextOn: m.nextOn });
    check(m.fade === (m.prevOn ? 'l' : '') + (m.nextOn ? 'r' : ''), tag + ': the fades match the buttons', m.fade);
    check(m.prevInFade && m.nextInFade, tag + ': the edge buttons sit inside their fades');
    check(m.badge === m.left + m.right, tag + ': the tab-search badge shows the total hidden', { badge: m.badge, hidden: m.left + m.right, title: m.badgeTitle });
    const act = m.rows.find((r) => r.active);
    check(!!act && act.st === 'in', tag + ': the active chip is in the clear', act);
    check(!!act && (act.pinned || act.w >= m.tabMin - 0.5), tag + ': the active chip is never under --tab-min', act && act.w);
    const thin = m.rows.filter((r) => !r.active && !r.pinned && r.w < m.floor - 0.5);
    check(!thin.length, tag + ': no inactive chip under the floor', thin.slice(0, 3));
    check(m.ntL >= m.stripR - 0.5 && m.ntL - m.stripR <= 4.5, tag + ': the + sits right after the strip', { stripR: m.stripR, ntL: m.ntL });
    check(m.spacerW >= 23.5 && m.ntR <= m.wcL && m.wcR <= m.vw + 0.5, tag + ': the row fits and keeps its grab area', { spacer: m.spacerW, wcR: m.wcR, vw: m.vw });
  }

  const ids = () => c.ev('visibleTabs().map((t) => t.id)');

  for (const n of COUNTS) {
    const got = await c.ev('__ov.make(' + n + ', ' + JSON.stringify(BASE) + ')');
    if (got !== n) { check(false, n + ' tabs: could not build the strip', got); continue; }
    const order = await ids();
    for (const w of WIDTHS) {
      await setWidth(w);
      await settle();
      const tag = n + ' tabs @' + w;
      invariants(tag, await M());
      for (const pick of [order[0], order[order.length - 1], order[Math.floor(order.length / 2)]]) {
        await c.ev('activateTab(' + pick + ')');
        await settle();
        const m = await M();
        const row = m.rows.find((r) => r.id === String(pick));
        check(!!row && row.active && row.st === 'in', tag + ': activating tab ' + (order.indexOf(pick) + 1) + ' of ' + n + ' brings it into view', row);
        check(m.prevN === m.left && m.nextN === m.right && m.badge === m.left + m.right, tag + ': counts still match after activating', { l: m.left, r: m.right, p: m.prevN, x: m.nextN, b: m.badge });
      }
      // The user's own complaint: + with a full strip. Activate the FIRST tab so the end is out of view.
      await c.ev('activateTab(' + order[0] + ')');
      await settle();
      await c.ev('__ov.armFirstFrame()');
      await c.ev('document.getElementById("newtab").click()');
      const first = await c.waitFor('window.__ovFirst', 5000).catch(() => null);
      const row = first && first.m.rows.find((r) => r.id === first.id);
      check(!!row && row.active && row.st === 'in', tag + ': a new tab from + is in view on its first frame', row || 'no frame');
      await settle();
      invariants(tag + ' +1', await M());
      await c.ev('closeTab(activeTabId)');
      await settle();

      if (n >= 40 && (w === 500 || w === 1280)) {
        // the vertical wheel, over the strip, scrolls it sideways
        await c.ev('activateTab(' + order[0] + ')');
        await settle();
        const r = await c.ev('(() => { const b = document.getElementById("tabstrip").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()');
        const before = (await M()).scrollLeft;
        await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY: 240 });
        await settle();
        const after = (await M()).scrollLeft;
        check(after > before + 50, tag + ': the wheel scrolls the strip sideways', { before, after });
        invariants(tag + ' wheeled', await M());
        await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY: -240 });
        await settle();
        check((await M()).scrollLeft < after - 50, tag + ': and back');
        // the right edge button pages right, the left one back
        const clickEdge = async (id) => {
          const b = await c.ev('(() => { const e = document.getElementById("' + id + '"); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
          if (!b) return false;
          for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1 });
          await settle();
          return true;
        };
        const s0 = (await M()).scrollLeft;
        check(await clickEdge('tabstrip-next'), tag + ': the right edge button is there to click');
        const m1 = await M();
        check(m1.scrollLeft > s0 + 100, tag + ': the right edge button pages right', { s0, s1: m1.scrollLeft });
        invariants(tag + ' paged', m1);
        check(await clickEdge('tabstrip-prev'), tag + ': the left edge button is there to click');
        check((await M()).scrollLeft < m1.scrollLeft - 100, tag + ': the left edge button pages back');
      }
    }
    if (SHOTS && (n === 15 || n === 80)) {
      for (const w of [500, 1280]) {
        await setWidth(w);
        await c.ev('activateTab(' + order[Math.floor(order.length / 2)] + ')');
        for (const theme of ['dark', 'light']) {
          await c.ev('document.documentElement.dataset.theme = ' + JSON.stringify(theme));
          await settle();
          try { await c.shot(path.join(SHOTS, 'strip-' + n + 'tabs-' + w + '-' + theme + '.png')); } catch (e) { say('shot failed: ' + e.message); }
        }
      }
      await c.ev('document.documentElement.dataset.theme = "dark"');
    }
  }

  /* ---- drag to reorder ------------------------------------------------------------------- */
  const drag = async (fromId, toX, holdMs) => {
    const p = await c.ev('(() => { const e = document.querySelector(\'#tabstrip > .tab[data-tab-id="' + fromId + '"]\'); const r = e.getBoundingClientRect(); return { x: r.left + Math.min(20, r.width / 3), y: r.top + r.height / 2 }; })()');
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + (toX - p.x) * i / steps, y: p.y, button: 'left', buttons: 1 });
      await sleep(16);
    }
    if (holdMs) await sleep(holdMs);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: p.y, button: 'left', clickCount: 1 });
    await settle();
  };

  await c.ev('__ov.make(5, ' + JSON.stringify(BASE) + ')');
  await setWidth(1280);
  await settle();
  {
    const before = await ids();
    const toX = await c.ev('(() => { const e = document.querySelector(\'#tabstrip > .tab[data-tab-id="' + before[3] + '"]\'); const r = e.getBoundingClientRect(); return r.left + r.width / 2 + 4; })()');
    await drag(before[0], toX, 0);
    const after = await ids();
    check(after.indexOf(before[0]) === 3, 'drag on a strip that fits: the first chip lands in slot 4', { before, after });
    invariants('after a drag (5 tabs)', await M());
  }

  await c.ev('__ov.make(40, ' + JSON.stringify(BASE) + ')');
  await setWidth(800);
  {
    const order = await ids();
    await c.ev('activateTab(' + order[1] + ')');
    await settle();
    const m0 = await M();
    const shownBefore = m0.shown;
    const edgeX = await c.ev('document.getElementById("tabstrip").getBoundingClientRect().right - 6');
    await drag(order[1], edgeX, 1500);
    const m1 = await M();
    const after = await ids();
    const slot = after.indexOf(order[1]);
    check(m1.scrollLeft > m0.scrollLeft + 100, 'a drag held at the right edge steps the strip', { s0: m0.scrollLeft, s1: m1.scrollLeft });
    check(slot > shownBefore, 'and the chip drops past the first screen', { slot, shownBefore });
    const row = m1.rows.find((r) => r.id === String(order[1]));
    check(!!row && row.active && row.st === 'in', 'the dropped chip is active and in view', row);
    invariants('after an edge drag (40 tabs @800)', m1);
  }

  /* ---- pinned ---------------------------------------------------------------------------- */
  {
    const order = await ids();
    await c.ev('[' + order.slice(-3).join(',') + '].forEach((id) => setTabPinned(tabs.find((t) => t.id === id), true))');
    await c.ev('activateTab(' + order[10] + ')');
    await setWidth(1280);
    await settle();
    const m = await M();
    const lead = m.rows.slice(0, 3);
    check(lead.every((r) => r.pinned && Math.abs(r.w - 40) < 0.6), 'pinned chips keep 40px at the left of a full strip', lead);
    invariants('3 pinned + 37 (40 tabs @1280)', m);
    await c.ev('visibleTabs().filter((t) => t.pinned).forEach((t) => setTabPinned(t, false))');
  }

  /* ---- workspaces: the strip is the workspace on screen ---------------------------------- */
  {
    await setWidth(800);
    const home = await c.ev('currentWorkspaceId');
    const homeIds = await ids();
    await c.ev('activateTab(' + homeIds[2] + ')');
    const ws = await c.ev('createWorkspace("Overflow test", "ocean")');
    check(!!ws && ws !== home, 'a second workspace opens', ws);
    await c.ev('__ov.make(30, ' + JSON.stringify(BASE) + ')');
    const wsIds = await ids();
    await c.ev('activateTab(' + wsIds[wsIds.length - 1] + ')');
    await settle();
    let m = await M();
    check(m.n === 30, 'the second workspace\'s strip holds only its own 30 chips', m.n);
    invariants('workspace 2 (30 tabs @800)', m);
    await c.ev('switchWorkspace(' + JSON.stringify(home) + ')');
    await settle();
    m = await M();
    const act = m.rows.find((r) => r.active);
    check(m.n === 40 && !!act && act.id === String(homeIds[2]) && act.st === 'in', 'switching back: home\'s 40 chips, its own front tab in view', { n: m.n, act });
    invariants('back home (40 tabs @800)', m);
    await c.ev('switchWorkspace(' + JSON.stringify(ws) + ')');
    await settle();
    m = await M();
    const act2 = m.rows.find((r) => r.active);
    check(!!act2 && act2.id === String(wsIds[wsIds.length - 1]) && act2.st === 'in', 'switching again: the last tab of workspace 2 is in view', act2);
    invariants('workspace 2 again', m);
    await c.ev('switchWorkspace(' + JSON.stringify(home) + ')');
    await settle();
  }

  /* ---- a restart with the last of 40 tabs in front --------------------------------------- */
  {
    const order = await ids();
    const lastId = order[order.length - 1];
    await c.ev('activateTab(' + lastId + ')');
    await sleep(2500);   // the session write is debounced
    const lastUrl = await c.ev('tabs.find((t) => t.id === ' + lastId + ').url');
    check(await q.quit(), 'boot 1: closing the window quit Quartz');
    q = await launch({ cdp: CDP });
    c = q.chrome;
    await c.ev(PROBE);
    await c.waitFor('visibleTabs().length >= 40', 20000).catch(() => 0);
    await settle();
    const m = await M();
    const act = m.rows.find((r) => r.active);
    const url = await c.ev('(getActiveTab() || {}).url');
    check(m.n === 40 && url === lastUrl, 'boot 2: the 40 tabs came back with the last one in front', { n: m.n, url, lastUrl });
    check(!!act && act.st === 'in', 'boot 2: the restored active tab is in view without touching anything', act);
    invariants('boot 2 (40 tabs, default width ' + m.vw + ')', m);
    await setWidth(500);
    await settle();
    invariants('boot 2 (40 tabs @500)', await M());
    check(await q.quit(), 'boot 2: closing the window quit Quartz');
  }
  srv.close();
});
