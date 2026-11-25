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
//   - The size: QUARTZ_TEST_WINDOW_SIZE (main.js createWindow, test-only) makes the BrowserWindow that
//     size, which is the only way the <webview> guest lays out at it (an emulated size on the chrome
//     page never reaches a guest). The chrome's innerWidth x innerHeight is then measured; if the
//     frame took some of it, the window is relaunched once, grown by the difference. The size check
//     fails, with the real size, when it is still off.
//   - The capture: Page.captureScreenshot of the chrome page (fromSurface, scaled to CSS pixels).
//     The guest is captured on its own too, and its pixels are compared with the same rectangle of
//     the window capture: when they match, the window capture holds the guest's pixels (said in a
//     PASS line); when they do not, the guest capture is pasted into the window picture at the
//     guest's rectangle, and that is said too.
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

/* ---- PNG: just enough to read Chromium's captures and write one back --------------------------- */
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }

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
function pngEncode(img) {
  const stride = img.w * 4, raw = Buffer.alloc((stride + 1) * img.h);
  for (let y = 0; y < img.h; y++) { raw[y * (stride + 1)] = 0; Buffer.from(img.px.buffer, img.px.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1); }
  const chunk = (kind, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const kd = Buffer.concat([Buffer.from(kind, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(kd)); return Buffer.concat([len, kd, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const lum = (img, x, y) => { const o = (y * img.w + x) * 4; return 0.2126 * img.px[o] + 0.7152 * img.px[o + 1] + 0.0722 * img.px[o + 2]; };
/** Mean absolute RGB difference between the guest picture and the window picture's rect (a 40 x 25 grid). */
function regionDiff(win, guest, rect) {
  let sum = 0, n = 0;
  for (let i = 0; i < 40; i++) for (let j = 0; j < 25; j++) {
    const gx = Math.min(guest.w - 1, Math.floor(((i + 0.5) / 40) * guest.w)), gy = Math.min(guest.h - 1, Math.floor(((j + 0.5) / 25) * guest.h));
    const wx = Math.min(win.w - 1, Math.round(rect.x) + gx), wy = Math.min(win.h - 1, Math.round(rect.y) + gy);
    const a = (gy * guest.w + gx) * 4, b = (wy * win.w + wx) * 4;
    for (let c = 0; c < 3; c++) { sum += Math.abs(guest.px[a + c] - win.px[b + c]); n++; }
  }
  return sum / n;
}
function paste(win, guest, rect) {
  const x0 = Math.round(rect.x), y0 = Math.round(rect.y);
  for (let y = 0; y < guest.h; y++) {
    const wy = y0 + y; if (wy < 0 || wy >= win.h) continue;
    for (let x = 0; x < guest.w; x++) {
      const wx = x0 + x; if (wx < 0 || wx >= win.w) continue;
      const a = (y * guest.w + x) * 4, b = (wy * win.w + wx) * 4, al = guest.px[a + 3] / 255;
      for (let c = 0; c < 3; c++) win.px[b + c] = Math.round(guest.px[a + c] * al + win.px[b + c] * (1 - al));
    }
  }
}
/** The spread (standard deviation) of luminance over a 48 x 27 grid of the window picture. */
function spread(img) {
  const v = []; for (let i = 0; i < 48; i++) for (let j = 0; j < 27; j++) v.push(lum(img, Math.floor(((i + 0.5) / 48) * img.w), Math.floor(((j + 0.5) / 27) * img.h)));
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return { mean: m, sd: Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length) };
}

async function capture(cdp, w, h, scale) {
  const m = await Promise.race([
    cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: w, height: h, scale } }),
    sleep(15000).then(() => ({ error: { message: 'captureScreenshot timed out after 15 s' } })),
  ]);
  if (m.error || !m.result || !m.result.data) throw new Error((m.error && m.error.message) || 'no data');
  return Buffer.from(m.result.data, 'base64');
}

run('look-shots', async ({ check, launch, say }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const lookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartz-look-shots-sync-'));
  say('pictures to ' + SHOTS + '; picture assets/backgrounds/' + BG + '.jpg; LOOK_SYNC_DIR ' + lookDir);
  const ACTIVE_NT = "(() => { const t = getActiveTab(); return !!t && t.kind === 'page' && isNewTabUrl(t.url); })()";
  try {
    for (const [W, H] of SIZES) {
      let q = null, inner = null, ask = [W, H];
      for (let attempt = 0; attempt < 2; attempt++) {
        q = await launch({ cdp: PORT, env: { LOOK_SYNC_DIR: lookDir, QUARTZ_TEST_WINDOW_SIZE: ask[0] + 'x' + ask[1] } });
        inner = await q.chrome.ev('[innerWidth, innerHeight, devicePixelRatio]');
        if (inner[0] === W && inner[1] === H) break;
        if (attempt === 0) {
          say('asked ' + ask.join('x') + ', the content is ' + inner[0] + 'x' + inner[1] + ': relaunching grown by the difference');
          ask = [ask[0] + (W - inner[0]), ask[1] + (H - inner[1])];
          await q.quit();
        }
      }
      const chrome = q.chrome;
      const dpr = inner[2] || 1;
      check(inner[0] === W && inner[1] === H, W + 'x' + H + ': the window content is exactly ' + W + 'x' + H + ' CSS px', 'got ' + inner[0] + 'x' + inner[1] + ' at dpr ' + dpr + ' (window asked ' + ask.join('x') + ')');

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

        const rect = await chrome.ev('(() => { const r = getActiveTab().viewEl.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');
        const name = 'quartz-' + theme + '-' + W + 'x' + H;
        const file = path.join(SHOTS, name + '.png');
        try {
          const winBuf = await capture(chrome, inner[0], inner[1], 1 / dpr);
          const gBuf = await capture(guest, Math.round(rect.w), Math.round(rect.h), 1 / dpr);
          fs.writeFileSync(path.join(SHOTS, name + '-home.png'), gBuf);
          const win = pngDecode(winBuf), g = pngDecode(gBuf);
          const diff = regionDiff(win, g, rect);
          if (diff <= 12) {
            fs.writeFileSync(file, winBuf);
            check(true, name + ': the window capture holds the Home guest\'s pixels', 'mean diff ' + diff.toFixed(1));
          } else {
            paste(win, g, rect);
            fs.writeFileSync(file, pngEncode(win));
            say(name + ': the window capture did NOT hold the guest\'s pixels (mean diff ' + diff.toFixed(1) + '); the guest capture was pasted in at ' + JSON.stringify(rect));
          }
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
