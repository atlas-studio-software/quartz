// tools/look-shots.js -- before/after pictures of the whole window (chrome + Home), for checking the
// look against the approved design. NOT part of the suite (tools/run-suite.js does not list it): it
// judges nothing about the look itself, it only takes the pictures and checks that they are real.
//
//   node tools/look-shots.js [--out=<dir>] [--cdp=9593] [--bg=cloud-peaks]
//
// Writes <out>/look-shots/quartz-<theme>-<w>x<h>.png (default <out>: suite-out in the repo) for the
// dark and light themes at 1536x864 and 1920x1080, plus quartz-<theme>-<w>x<h>-home.png, the Home
// guest captured on its own.
//
// How:
//   - A real Quartz test instance through tests/e2e-kit.js: --test-profile with this tool's own
//     profile name, off-screen (testwatch OFFSCREEN_ARGS, watched), its own CDP port (9593).
//     LOOK_SYNC_DIR points at an empty temp folder, so no desktop record from another app and never
//     the user's look.json.
//   - The picture: Settings.setBackground({ kind: 'builtin', id }) with one of the repo's own
//     pictures (assets/backgrounds/<id>.jpg; default cloud-peaks, "Peaks in cloud", a mountain), so
//     the run needs no private wallpaper. The Dim stays at its default.
//   - The size: QUARTZ_TEST_WINDOW_SIZE with QUARTZ_TEST_WINDOW_EXACT=1 (main.js createWindow and
//     fitTestWindowSize, test-only) makes the window's content that size, which is the only way the
//     <webview> guest lays out at it (an emulated size on the chrome page never reaches a guest).
//     Windows clamps a NEW window to the screen's work area (a 1024x768 screen gives 1024x720), but
//     not one resized once it is up, so main sets the size again after the first show. The
//     chrome's innerWidth x innerHeight is then measured; if it is still off, the window is
//     relaunched once, grown by the difference. The size check fails, with the real size, when it
//     is still off. The pictures need a device pixel ratio of 1 (the size check says so).
//   - The capture: Page.captureScreenshot of the chrome page, the whole viewport with NO clip. A
//     clip makes Chromium emulate a viewport on the chrome page for the shot, and that reaches the
//     guest: the Home was sometimes caught laid out 100 px taller than it is (the centre column 45
//     px lower, the right rail 100 px lower). The guest is captured on its own too (no clip), and
//     its opaque pixels are compared with the same rectangle of the window capture; the window is
//     captured again until they match (at most 4 tries). Nothing is pasted: the Home is mostly
//     transparent over the picture, so pasting it over a window capture that held another frame
//     of it drew every piece twice. A window capture that never matches is saved as it is, and
//     the check fails.
//   - The wallpaper check: Backdrop.state() says builtin/<id>/ok, the Home guest's frost says ok,
//     and the window picture is not a flat colour (the spread of its pixels' luminance).
//
// Ends with the kit's one summary line: "look-shots: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { run, Cdp, sleep, APP } = require('../tests/e2e-kit');

const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const OUT = path.resolve(opt('out', path.join(APP, 'suite-out')));
const SHOTS = path.join(OUT, 'look-shots');
const PORT = Number(opt('cdp', '9593'));
const BG = opt('bg', 'cloud-peaks');
const SIZES = [[1536, 864], [1920, 1080]];
const THEMES = ['dark', 'light'];

if (!/^[a-z0-9-]+$/.test(BG) || !fs.existsSync(path.join(APP, 'assets', 'backgrounds', BG + '.jpg'))) {
  console.log('look-shots: 0 passed, 1 failed  (no picture assets/backgrounds/' + BG + '.jpg)');
  process.exit(1);
}

/* ---- PNG: just enough to read Chromium's captures ---------------------------------------------- */
/** { w, h, px: RGBA Uint8Array } from an 8-bit, non-interlaced RGB or RGBA PNG. */
function pngDecode(buf) {
  let p = 8, w = 0, h = 0, type = 0, depth = 0, inter = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; inter = data[12]; }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || inter !== 0) throw new Error('unsupported PNG (depth ' + depth + ', type ' + type + ', interlace ' + inter + ')');
  const bpp = type === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(w * h * 4), prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; px[o] = cur[x * bpp]; px[o + 1] = cur[x * bpp + 1]; px[o + 2] = cur[x * bpp + 2]; px[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255; }
    prev.set(cur);
  }
  return { w, h, px };
}
const lum = (img, x, y) => { const o = (y * img.w + x) * 4; return 0.2126 * img.px[o] + 0.7152 * img.px[o + 1] + 0.0722 * img.px[o + 2]; };
/**
 * Mean absolute RGB difference between the guest picture's OPAQUE pixels (alpha 250 and up: the
 * islands and what is on them) and the same pixels of the window picture, over a 160 x 100 grid.
 * The guest's transparent pixels are the picture behind it, which only the window capture holds,
 * so they say nothing. { diff, n }: n is how many opaque pixels were compared.
 */
function regionDiff(win, guest, rect) {
  let sum = 0, n = 0;
  for (let i = 0; i < 160; i++) for (let j = 0; j < 100; j++) {
    const gx = Math.min(guest.w - 1, Math.floor(((i + 0.5) / 160) * guest.w)), gy = Math.min(guest.h - 1, Math.floor(((j + 0.5) / 100) * guest.h));
    const wx = Math.round(rect.x) + gx, wy = Math.round(rect.y) + gy;
    if (wx < 0 || wy < 0 || wx >= win.w || wy >= win.h) continue;
    const a = (gy * guest.w + gx) * 4, b = (wy * win.w + wx) * 4;
    if (guest.px[a + 3] < 250) continue;
    for (let c = 0; c < 3; c++) sum += Math.abs(guest.px[a + c] - win.px[b + c]);
    n++;
  }
  return { diff: n ? sum / (3 * n) : Infinity, n };
}
/** The spread (standard deviation) of luminance over a 48 x 27 grid of the window picture. */
function spread(img) {
  const v = []; for (let i = 0; i < 48; i++) for (let j = 0; j < 27; j++) v.push(lum(img, Math.floor(((i + 0.5) / 48) * img.w), Math.floor(((j + 0.5) / 27) * img.h)));
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return { mean: m, sd: Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length) };
}

/** The page's whole viewport as a PNG. No clip: a clip makes Chromium emulate a viewport for the shot (see the top). */
async function capture(cdp) {
  const m = await Promise.race([
    cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
    sleep(15000).then(() => ({ error: { message: 'captureScreenshot timed out after 15 s' } })),
  ]);
  if (m.error || !m.result || !m.result.data) throw new Error((m.error && m.error.message) || 'no data');
  return Buffer.from(m.result.data, 'base64');
}

run('look-shots', async ({ check, launch, say, profileDir }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const lookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartz-look-shots-sync-'));
  say('pictures to ' + SHOTS + '; picture assets/backgrounds/' + BG + '.jpg; LOOK_SYNC_DIR ' + lookDir);
  const ACTIVE_NT = "(() => { const t = getActiveTab(); return !!t && t.kind === 'page' && isNewTabUrl(t.url); })()";
  try {
    for (const [W, H] of SIZES) {
      let q = null, inner = null, ask = [W, H];
      for (let attempt = 0; attempt < 2; attempt++) {
        q = await launch({ cdp: PORT, env: { LOOK_SYNC_DIR: lookDir, QUARTZ_TEST_WINDOW_SIZE: ask[0] + 'x' + ask[1], QUARTZ_TEST_WINDOW_EXACT: '1' } });
        // main sizes the window just after it is first shown: give that a moment to land
        await q.chrome.waitFor('innerWidth === ' + W + ' && innerHeight === ' + H, 5000).catch(() => null);
        inner = await q.chrome.ev('[innerWidth, innerHeight, devicePixelRatio]');
        try { for (const l of fs.readFileSync(path.join(profileDir, 'quartz.log'), 'utf8').split('\n')) if (/\[test window\]/.test(l)) say('quartz.log: ' + l.trim()); } catch (e) { say('quartz.log not read: ' + e.message); }
        if (inner[0] === W && inner[1] === H) break;
        if (attempt === 0) {
          say('asked ' + ask.join('x') + ', the content is ' + inner[0] + 'x' + inner[1] + ': relaunching grown by the difference');
          ask = [ask[0] + (W - inner[0]), ask[1] + (H - inner[1])];
          await q.quit();
        }
      }
      const chrome = q.chrome;
      const dpr = inner[2] || 1;
      check(inner[0] === W && inner[1] === H && dpr === 1, W + 'x' + H + ': the window content is exactly ' + W + 'x' + H + ' CSS px at a device pixel ratio of 1', 'got ' + inner[0] + 'x' + inner[1] + ' at dpr ' + dpr + ' (window asked ' + ask.join('x') + ')');

      // The picture: one of the repo's own, never the desktop's.
      await chrome.ev("Settings.setBackground({ kind: 'builtin', id: " + JSON.stringify(BG) + " }), 1");
      const bg = await chrome.waitFor("(() => { const s = Backdrop.state(); return s.kind === 'builtin' && s.state === 'ok' && s.source && s.source.id === " + JSON.stringify(BG) + " ? s : null; })()", 20000).catch((e) => ({ error: e.message }));
      check(!bg.error, W + 'x' + H + ': the picture is the built-in ' + BG, bg.error || (bg.source && bg.source.fileName));

      // Home in front, and nothing else in the strip.
      if (!(await chrome.ev(ACTIVE_NT))) { await chrome.ev('createTab(newTabUrl()), 1'); await chrome.waitFor(ACTIVE_NT, 8000); }
      await chrome.ev('(() => { const keep = getActiveTab(); for (const t of tabs.slice()) if (t !== keep) closeTab(t.id); return tabs.length; })()').catch(() => 0);
      await chrome.ev('document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1').catch(() => 0);

      for (const theme of THEMES) {
        await chrome.ev('setThemeMode(' + JSON.stringify(theme) + '), 1');
        await chrome.waitFor("document.documentElement.getAttribute('data-theme') === " + JSON.stringify(theme), 5000);
        // The Home guest on screen (a new-tab guest that is visible), with its theme and its frost.
        let guest = null;
        for (let i = 0; i < 60 && !guest; i++) {
          const ts = (await q.targets()).filter((t) => t.type === 'webview' && /newtab\.html/.test(String(t.url)));
          for (const t of ts) {
            const c = await new Cdp(t.webSocketDebuggerUrl).open();
            const ok = await c.ev("document.visibilityState === 'visible' && document.documentElement.getAttribute('data-theme') === " + JSON.stringify(theme)).catch(() => false);
            if (ok) { guest = c; break; }
            c.close();
          }
          if (!guest) await sleep(200);
        }
        check(!!guest, W + 'x' + H + ' ' + theme + ': the Home guest is on screen in the ' + theme + ' theme');
        if (!guest) continue;
        const frost = await guest.waitFor("(() => { const s = window.Frost && window.Frost.state(); return s && s.state === 'ok' ? s : null; })()", 15000).catch((e) => ({ error: e.message }));
        check(!frost.error, W + 'x' + H + ' ' + theme + ': the Home islands show the blurred picture (frost ok)', frost.error || frost);
        await sleep(1500);   // the picture's fade-in, the guest's lift-in, the theme's own transitions
        // How dark the picture is painted: the wash over it (dark: the Dim, the islands look; light: washAlpha).
        const glass = await chrome.ev('(() => { const g = Backdrop.state().glass || {}; return { alpha: g.alpha, floor: g.floor, raised: g.raised, source: g.source, mode: g.mode, reason: g.reason || g.sourceReason || null }; })()').catch((e) => ({ error: e.message }));
        say(W + 'x' + H + ' ' + theme + ': the wash over the picture ' + JSON.stringify(glass));
        // The Saved row and the shortcut chips: what each one holds, and where the chrome got it.
        const rows = await guest.ev("(() => { const row = (sel, kid) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect();" +
          " return { id: n.id, cls: n.className, hidden: n.hidden, y: Math.round(r.top), h: Math.round(r.height), items: Array.from(n.querySelectorAll(kid)).map((c) => c.className + ':' + (c.textContent || '').trim() + (c.href ? ' ' + c.href : '')) }; };" +
          " return { saved: row('#saved', '.rtile:not(.saved-add):not(.saved-more)'), links: row('#links', 'a') }; })()").catch((e) => ({ error: e.message }));
        const fed = await chrome.ev("(() => ({ chipsSource: Settings.chipsSource && Settings.chipsSource(), storedChips: Array.isArray((Settings.all() || {}).chips) ? (Settings.all().chips || []).length : String((Settings.all() || {}).chips), topSites: (window.History && History.topSites ? (History.topSites(12) || []).length : null), newtabChips: (window.__newtabChips ? (window.__newtabChips() || []).map((c) => c.label) : null), saved: (Settings.chips ? (Settings.chips() || []).map((c) => c.label) : null) }))()").catch((e) => ({ error: e.message }));
        say(W + 'x' + H + ' ' + theme + ': rows ' + JSON.stringify(rows) + ' fed ' + JSON.stringify(fed));
        // The chrome's own islands in the top two rows: the brightness check's film on each.
        const top = await chrome.ev("(() => { const F = window.Frost && window.Frost.state && window.Frost.state(); const out = []; for (const n of document.querySelectorAll('.frost')) { const r = n.getBoundingClientRect(); if (!r.width || r.top > 100) continue;" +
          " out.push((n.id || n.className.replace(/\\s+/g, '.')) + '@' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' film ' + (n.style.getPropertyValue('--film') || '-')); } return { frost: F, islands: out }; })()").catch((e) => ({ error: e.message }));
        say(W + 'x' + H + ' ' + theme + ': top-row islands ' + JSON.stringify(top));

        const rect = await chrome.ev('(() => { const r = getActiveTab().viewEl.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');
        const name = 'quartz-' + theme + '-' + W + 'x' + H;
        const file = path.join(SHOTS, name + '.png');
        try {
          const gBuf = await capture(guest);
          fs.writeFileSync(path.join(SHOTS, name + '-home.png'), gBuf);
          const g = pngDecode(gBuf);
          check(g.w === Math.round(rect.w) && g.h === Math.round(rect.h), name + ': the Home guest is ' + Math.round(rect.w) + 'x' + Math.round(rect.h) + ', its <webview>\'s size', g.w + 'x' + g.h);
          let winBuf = null, m = null;
          for (let tries = 0; tries < 4; tries++) {
            if (tries) await sleep(500);
            winBuf = await capture(chrome);
            m = regionDiff(pngDecode(winBuf), g, rect);
            if (m.diff <= 6) break;
          }
          fs.writeFileSync(file, winBuf);
          check(m.n >= 200 && m.diff <= 6, name + ': the window capture holds the Home guest\'s pixels, nothing pasted', 'mean diff ' + m.diff.toFixed(1) + ' over ' + m.n + ' opaque guest pixels');
          const sp = spread(pngDecode(fs.readFileSync(file)));
          check(sp.sd >= 6, name + ': the wallpaper shows (the picture is not a flat colour)', 'luminance mean ' + sp.mean.toFixed(1) + ', spread ' + sp.sd.toFixed(1));
          const saved = fs.existsSync(file) ? pngDecode(fs.readFileSync(file)) : null;
          check(!!saved && saved.w === W && saved.h === H, name + ': saved ' + file, saved ? saved.w + 'x' + saved.h : 'missing');
        } catch (e) {
          check(false, name + ': saved ' + file, e.message);
        }
        guest.close();
      }
      await q.quit();
    }
  } finally {
    try { fs.rmSync(lookDir, { recursive: true, force: true }); } catch (e) { /* the OS cleans temp */ }
  }
});
