// toprow-harness.js — pure-node test for the top-row hints (run: node toprow-harness.js).
//   1. toprow.js's maths: colours, the stack -> TOP for every state Quartz's top row can be in,
//      with the real token values (tokens.css / chrome.css / backdrop.css), and the column sampler.
//   2. toprow-main.js: the pipe client (createClient, run in the preload) against a REAL named-pipe server
//      pipe name): absent server, backoff, connect, every send point, reconnect, size cap.
// No Electron. Prints one summary line: "toprow-test: N passed, M failed".
'use strict';
const net = require('net');
const path = require('path');
const T = require(path.join(__dirname, 'toprow.js'));
const TM = require(path.join(__dirname, 'toprow-main.js'));

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, got) {
  if (cond) pass++;
  else { fail++; fails.push(name + (got !== undefined ? '  got: ' + JSON.stringify(got) : '')); }
}
const near = (a, b, e) => Math.abs(a - b) <= (e === undefined ? 1e-9 : e);
const nearRgb = (a, b, e) => Array.isArray(a) && a.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= (e || 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 1. maths ------------------------------------------------------- */

// colours as getComputedStyle serialises them
ok(nearRgb(Object.values(T.parseColor('rgba(9, 10, 11, 0.5)')).slice(0, 3), [9, 10, 11]) && T.parseColor('rgba(9, 10, 11, 0.5)').a === 0.5, 'parse rgba()');
ok(T.parseColor('rgb(20, 21, 22)').a === 1, 'parse rgb() is opaque');
ok(T.parseColor('rgb(9 10 11 / 0.62)').a === 0.62, 'parse space syntax');
ok(T.parseColor('transparent').a === 0, 'parse transparent');
const cm = T.parseColor('color(srgb 0.5 0.25 1 / 0.07)');
ok(cm && near(cm.r, 127.5) && near(cm.g, 63.75) && near(cm.b, 255) && cm.a === 0.07, 'parse color(srgb) (color-mix tints)', cm);
ok(T.parseColor('hsl(1 2 3)') === null && T.parseColor('') === null, 'unknown colour -> null');
ok(T.gradientTop('none').a === 0, 'no image -> nothing');
ok(T.gradientTop('linear-gradient(rgba(9, 10, 11, 0.5), rgba(9, 10, 11, 0))').a === 0.5, 'gradient top = first stop');
ok(T.gradientTop('linear-gradient(to right, rgb(1, 2, 3), rgb(4, 5, 6))') === null, 'sideways gradient -> unknown');
ok(T.gradientTop('url("x.png")') === null, 'an image -> unknown');
const il = T.imageLayers('linear-gradient(rgba(184, 175, 213, 0.07), rgba(184, 175, 213, 0.07)), none');
ok(il && il.length === 1 && il[0].a === 0.07 && il[0].r === 184, 'image list: the workspace tint over none', il);
const il2 = T.imageLayers('linear-gradient(rgb(1, 1, 1), rgb(1, 1, 1)), linear-gradient(rgba(2, 2, 2, 0.5), rgba(2, 2, 2, 0))');
ok(il2 && il2.length === 2 && il2[0].r === 2 && il2[1].r === 1, 'image list: bottom layer first', il2);
ok(T.imageLayers('none').length === 0 && T.imageLayers('linear-gradient(rgb(1,1,1),rgb(1,1,1)), url(a.png)') === null, 'image list: none -> [], a picture -> unknown');

// the real tokens
const BG_DARK = [0x14, 0x15, 0x16];           // tokens.css --bg (dark)
const WASH_DARK = [9, 10, 11];                // --wash-rgb (dark)
const BG_LIGHT = [0xe9, 0xe9, 0xe7];
const WASH_LIGHT = [236, 236, 234];
const SURF0_LIGHT = { r: 244, g: 244, b: 242, a: 0.56 };
const base = (c) => ({ rgb: c, a: 1 });
const pic = (o) => ({ pic: true, opacity: o === undefined ? 1 : o });
// .bg-clear, the sharp layer: no scrim any more (its ::after paints nothing)
const sharp = (o) => T.clearLayer('none', o).layer;

function top(layers, kind, opts) { return T.topFor(T.compose(layers), kind, opts); }

// The sharp layer: no scrim is normal (never none); a gradient, if present, still counts; junk -> none + why
let cl = T.clearLayer('none', 1);
ok(cl.layer && !cl.none && cl.layer.group.length === 1 && cl.layer.group[0].pic, 'sharp layer, no scrim: just the picture, not none', cl);
ok(T.clearLayer(null, 1).layer && T.clearLayer('', 0.5).layer && T.clearLayer(undefined).layer.opacity === 1, 'sharp layer: ::after missing / empty is normal', T.clearLayer(null, 1));
cl = T.clearLayer('linear-gradient(rgba(9, 10, 11, 0.5), rgba(9, 10, 11, 0))', 1);
ok(cl.layer && cl.layer.group.length === 2 && cl.layer.group[1].a === 0.5, 'sharp layer: a ::after gradient, if present, is counted', cl);
cl = T.clearLayer('url("x.png")', 1);
ok(cl.none && /can't be read/.test(cl.none) && /x\.png/.test(cl.none), "sharp layer: an unreadable ::after -> none, says why", cl);

// Dark, a web page / Files / History / Reader / Settings open / a Claude tab: desktop still under the wash
let t = top([base(BG_DARK), pic(1), { rgb: WASH_DARK, a: 0.5 }], 'still');
ok(t.kind === 'wash' && near(t.alpha, 0.5) && nearRgb(t.rgb, WASH_DARK), 'dark page: wash .50', t);
t = top([base(BG_DARK), pic(1), { rgb: WASH_DARK, a: 0.62 }], 'still');
ok(t.kind === 'wash' && near(t.alpha, 0.62), 'dark page, guard raised: wash .62', t);
// The sharp layer over the bitmap (any tab in front): no scrim, so the row is the wash alone, the
// same as a web page's (one look in every state)
const pageTop = top([base(BG_DARK), pic(1), { rgb: WASH_DARK, a: 0.5 }], 'still');
t = top([base(BG_DARK), pic(1), sharp(1), { rgb: WASH_DARK, a: 0.5 }], 'still');
ok(t.kind === 'wash' && near(t.alpha, 0.5) && nearRgb(t.rgb, WASH_DARK) && JSON.stringify(t) === JSON.stringify(pageTop), 'dark, sharp layer on: wash .50, same as without it', t);
t = top([base(BG_DARK), sharp(1), { rgb: WASH_DARK, a: 0.62 }], 'still');
ok(t.kind === 'wash' && near(t.alpha, 0.62), 'dark, sharp layer, guard .62: wash .62', t);
// Halfway through the sharp layer's fade (bitmap still drawn under it): the picture's weight stays 1
t = top([base(BG_DARK), pic(1), sharp(0.5), { rgb: WASH_DARK, a: 0.5 }], 'still');
ok(t.kind === 'wash' && near(t.alpha, 0.5), 'dark, sharp layer fading at .5: still wash .50', t);
// Workspace tint on the strip (dark: no fill + the 7% tint)
const tint = { r: 120, g: 200, b: 255, a: 0.07 };
const merged = T.mergeColours([{ r: 0, g: 0, b: 0, a: 0 }, tint], 1);
t = top([base(BG_DARK), pic(1), { rgb: WASH_DARK, a: 0.5 }, merged], 'still');
const expA = 1 - 0.5 * 0.93;
const expRgb = [0, 1, 2].map((i) => Math.round((0.5 * WASH_DARK[i] * 0.93 + 0.07 * [120, 200, 255][i]) / expA));
ok(t.kind === 'wash' && near(t.alpha, Math.round(expA * 1000) / 1000) && nearRgb(t.rgb, expRgb), 'dark + workspace tint: one wash', t);
// No picture (none chosen) / still loading: flat
t = top([base(BG_DARK), { rgb: WASH_DARK, a: 0.5 }], null);
ok(t.kind === 'flat' && nearRgb(t.rgb, [15, 16, 17], 1), 'dark no picture: flat', t);
t = top([base(BG_DARK), pic(0), { rgb: WASH_DARK, a: 0.5 }], 'still');
ok(t.kind === 'flat', 'dark picture at opacity 0 (loading): flat', t);
// A picture landing (200ms fade), 30% in: still a wash, the ground folded into its colour
t = top([base(BG_DARK), pic(0.3), { rgb: WASH_DARK, a: 0.5 }], 'still');
ok(t.kind === 'wash' && near(t.alpha, 0.85) && nearRgb(t.rgb, [0, 1, 2].map((i) => Math.round((0.35 * BG_DARK[i] + 0.5 * WASH_DARK[i]) / 0.85))), 'picture fading in: wash .85', t);
// A picture shows that nothing names (fading out): none
t = top([base(BG_DARK), pic(0.4), { rgb: WASH_DARK, a: 0.5 }], null);
ok(t.kind === 'none', 'unnamed picture: none', t);
// Light, desktop still: --bg-dim .45 wash, then the strip's --surface-0 .56
const lightStrip = T.mergeColours([SURF0_LIGHT, { r: 0, g: 0, b: 0, a: 0 }], 1);
t = top([base(BG_LIGHT), pic(1), { rgb: WASH_LIGHT, a: 0.45 }, lightStrip], 'still');
const la = 1 - 0.55 * 0.44;
ok(t.kind === 'wash' && near(t.alpha, Math.round(la * 1000) / 1000) &&
  nearRgb(t.rgb, [0, 1, 2].map((i) => Math.round((0.44 * 0.45 * WASH_LIGHT[i] + 0.56 * [244, 244, 242][i]) / la))), 'light page: one wash .758', t);
t = top([base(BG_LIGHT), lightStrip], null);
ok(t.kind === 'flat' && nearRgb(t.rgb, [0, 1, 2].map((i) => Math.round(0.44 * BG_LIGHT[i] + 0.56 * [244, 244, 242][i]))), 'light no picture: flat', t);
// Boot entrance: the strip at half opacity
t = top([base(BG_LIGHT), pic(1), { rgb: WASH_LIGHT, a: 0.45 }, T.mergeColours([SURF0_LIGHT], 0.5)], 'still');
ok(t.kind === 'wash' && near(t.alpha, Math.round((1 - 0.55 * 0.72) * 1000) / 1000), 'light, strip fading in: wash', t);

// Own picture / clip still / Windows' wallpaper: columns from the blurred bitmap
function bitmap(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fn(x, y); const i = (y * w + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return { data, w, h };
}
// not lined: a 100x50 bitmap, red = x, green = y, cover-fit to a 400x100 window (scale 4, rows 12.5.. cropped)
const bm = bitmap(100, 50, (x, y) => [x * 2, y * 4, 50]);
let samp = T.bitmapSampler({ pixels: bm, lined: false, outW: 100, outH: 50 }, { w: 400, h: 100 });
let c0 = samp(0, 50);                          // window x 0..8 -> bitmap 0..2
ok(c0 && near(c0[0], 1, 1e-6) && near(c0[1], (((0.5 + 50) / 4) - 0.5) * 4, 1e-6), 'cover sampler: column 0, row under the crop', c0);
t = T.topFor(T.compose([base(BG_DARK), pic(1), { rgb: WASH_DARK, a: 0.5 }]), 'bitmap', { sample: samp, cols: 50 });
ok(t.kind === 'cols' && t.cols.length === 50 && nearRgb(t.cols[0], [Math.round(0.5 * c0[0] + 4.5), Math.round(0.5 * c0[1] + 5), Math.round(0.5 * 50 + 5.5)], 1), 'own picture: cols = k*bitmap + S', t.cols && t.cols[0]);
ok(t.cols[49][0] > t.cols[0][0], 'cols run left to right', [t.cols[0], t.cols[49]]);
// lined: the monitor at sx = .3, overscan m = 2; the window's content 300 px right and 100 down on the monitor
const L = { m: 2, sx: 0.3, sy: 0.3 };
const bm2 = bitmap(200, 120, (x, y) => [x, y, 0]);
samp = T.bitmapSampler({ pixels: bm2, lined: true, layout: L, place: { content: { x: 1300, y: 100 }, display: { x: 1000, y: 0 } } }, { w: 200, h: 100 });
c0 = samp(0, 25);                              // window x 0..8 -> bitmap 2 + (300..308)*.3 = 92..94.4
ok(c0 && near(c0[0], 93, 1e-6) && near(c0[1], 2 + 100.5 * 0.3 - 0.5, 1e-6), 'lined sampler: right spot on the monitor', c0);
ok(T.topFor({ k: 0.5, S: [1, 2, 3] }, 'bitmap', { sample: () => null, cols: 4 }).kind === 'none', 'unreadable bitmap: none');
ok(T.colCount(1280) === 160 && T.colCount(3840) === 240 && T.colCount(10) === 8, 'column count: ~8 CSS px, 8..240');

// Which picture, from toprowSource(): wash only for the lined desktop still at blur 0
const STILL_URL = 'file:///stills/wall-1.jpg';
const src = (extra) => Object.assign({ kind: 'desktop', state: 'ok', shown: true, lined: true, deskStillUrl: STILL_URL,
  srcKey: 'desktop|' + STILL_URL, bitmapBlurPx: 0 }, extra);
let pf = T.pictureFor(true, src({ blurPx: 0 }));
ok(pf.pic === 'still' && /desktop picture under the wash/.test(pf.why), 'desktop still at blur 0: still (a wash)', pf);
pf = T.pictureFor(true, src({ blurPx: 5 }));
ok(pf.pic === 'bitmap' && /desktop picture, sent per column: Mantle would blur its copy at 5 px and Quartz paints it sharp/.test(pf.why), 'desktop still at blur 5: bitmap, says Mantle would blur and Quartz is sharp', pf);
pf = T.pictureFor(true, src({ blurPx: 0.5 }));
ok(pf.pic === 'bitmap' && /0\.5 px/.test(pf.why), 'desktop still at blur 0.5: bitmap', pf);
pf = T.pictureFor(true, src({}));
ok(pf.pic === 'bitmap' && /not known/.test(pf.why), 'blurPx missing (older backdrop): bitmap, says the blur is not known', pf);
pf = T.pictureFor(true, src({ blurPx: '0' }));
ok(pf.pic === 'bitmap' && /not known/.test(pf.why), 'blurPx not a number: treated as unknown', pf);
pf = T.pictureFor(true, src({ blurPx: 0, srcKey: 'desktop|file:///stills/older.jpg' }));
ok(pf.pic === 'bitmap' && /older desktop still/.test(pf.why), 'an older still on screen: bitmap even at blur 0', pf);
pf = T.pictureFor(true, src({ blurPx: 0, kind: 'builtin', lined: false, srcKey: 'builtin|x' }));
ok(pf.pic === 'bitmap' && /built-in photo/.test(pf.why), 'built-in photo: bitmap', pf);
pf = T.pictureFor(true, src({ blurPx: 0, kind: 'video', lined: false, srcKey: 'video|x' }));
ok(pf.pic === 'bitmap' && /clip/.test(pf.why), "a clip's still: bitmap", pf);
pf = T.pictureFor(true, src({ shown: false }));
ok(pf.pic === null && /fading out/.test(pf.why), 'a picture on screen the layer no longer names: null, says why', pf);
pf = T.pictureFor(false, src({ kind: 'none', shown: false }));
ok(pf.pic === null && /no picture/.test(pf.why), 'no picture chosen: null', pf);
pf = T.pictureFor(true, null);
ok(pf.pic === null, 'no toprowSource at all: null (a picture nobody names -> none)', pf);

// The hint, end to end through hintFor (what compute() sends)
const darkComp = T.compose([base(BG_DARK), pic(1), sharp(1), { rgb: WASH_DARK, a: 0.5 }, merged]);
const W1280 = { w: 1280, h: 800 };
const sharpBm = bitmap(400, 260, (x, y) => [x % 256, y % 256, 90]);
const linedSrc = (extra) => src(Object.assign({ pixels: sharpBm, layout: { m: 0, sx: 0.3, sy: 0.3 }, place: { content: { x: 0, y: 0 }, display: { x: 0, y: 0 } } }, extra));
function stFor(s) {
  const p = T.pictureFor(true, s);
  return { comp: darkComp, pic: p.pic, why: p.why, sample: p.pic === 'bitmap' ? T.bitmapSampler(s, W1280) : null, cols: T.colCount(W1280.w) };
}
let h = T.hintFor(stFor(linedSrc({ blurPx: 0 })));
const wa = 1 - darkComp.k;
ok(h.top.kind === 'wash' && near(h.top.alpha, Math.round(wa * 1000) / 1000) &&
  nearRgb(h.top.rgb, darkComp.S.map((v) => Math.round(v / wa))), 'still + blur 0: wash, alpha = 1 - k, rgb = S / (1 - k)', h);
h = T.hintFor(stFor(linedSrc({ blurPx: 5 })));
ok(h.top.kind === 'cols' && h.top.cols.length === 160 && /Mantle would blur its copy at 5 px and Quartz paints it sharp/.test(h.why), 'still + blur 5: cols (not wash), with the why', [h.top.kind, h.why]);
const c5 = T.bitmapSampler(linedSrc({}), W1280)(0, 160);
ok(h.top.cols && nearRgb(h.top.cols[0], [0, 1, 2].map((i) => Math.round(darkComp.k * c5[i] + darkComp.S[i])), 0), 'still + blur 5: cols = k * sharp bitmap + S', h.top.cols && h.top.cols[0]);
h = T.hintFor(stFor(linedSrc({ blurPx: undefined })));
ok(h.top.kind === 'cols' && /not known/.test(h.why), 'blurPx missing: cols, says so', [h.top.kind, h.why]);
h = T.hintFor({ comp: darkComp, pic: 'bitmap', why: T.pictureFor(true, src({ blurPx: 5 })).why, sample: () => null, cols: 8 });
ok(h.top.kind === 'none' && /pixels can't be read/.test(h.why) && /Mantle would blur/.test(h.why), 'cols sampler failing: none, with the reason', h);
h = T.hintFor(stFor(src({ blurPx: 5, pixels: null })));
ok(h.top.kind === 'none' && /no bitmap to sample/.test(h.why), 'no bitmap at all: none, with the reason', h);
h = T.hintFor({ none: 'fullscreen: the chrome steps aside' });
ok(h.top.kind === 'none' && h.why === 'fullscreen: the chrome steps aside', 'a stack that says none: none, its reason kept', h);
h = T.hintFor({ comp: darkComp, pic: null, why: T.pictureFor(true, src({ shown: false })).why, sample: null, cols: 8 });
ok(h.top.kind === 'none' && /fading out/.test(h.why), 'an unnamed picture: none, says why', h);

/* ---- 2. the pipe client ---------------------------------------------- */

function fakeMantle(pipe) {
  const got = [];
  const socks = new Set();
  const server = net.createServer((s) => {
    socks.add(s);
    let rest = '';
    s.on('data', (d) => {
      rest += d.toString('utf8');
      let i;
      while ((i = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, i); rest = rest.slice(i + 1);
        got.push({ bytes: Buffer.byteLength(line) + 1, m: JSON.parse(line), at: Date.now() });
      }
    });
    s.on('close', () => socks.delete(s));
    s.on('error', () => {});
  });
  return {
    got,
    listen: () => new Promise((r) => server.listen(pipe, r)),
    close: () => new Promise((r) => { socks.forEach((s) => s.destroy()); server.close(() => r()); }),
  };
}
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return !!fn(); }

(async () => {
  const PIPE = '\\\\.\\pipe\\toprow-harness-' + process.pid;
  const logs = [];
  const statuses = [];
  let tries = 0;
  const countingNet = { connect: (p) => { tries++; return net.connect(p); } };
  const client = TM.createClient({ net: countingNet, pipe: PIPE, log: (m) => logs.push(m), onStatus: (s) => statuses.push(s) });
  const HW = String(0x1a2b3c);
  client.hint({ kind: 'flat', rgb: [1, 2, 3] }, 99);     // the page speaks before it knows its HWND: kept
  client.window(HW, { chrome: true });

  // Mantle not running: no throw, a reason in words, at most one try per 2 s, one log line
  await sleep(4500);
  const st = client.status();
  ok(st.state === 'waiting' && /Mantle is not running/.test(st.reason) && st.reason.indexOf(PIPE) >= 0, 'absent: waiting, says Mantle is not running', st);
  ok(tries >= 2 && tries <= 3, 'absent: one attempt per 2 s at most (4.5 s -> 2-3)', tries);
  ok(logs.length === 1, 'absent: one log line, not one per try', logs);
  client.hint({ kind: 'wash', rgb: [9, 10, 11], alpha: 0.5 }, 111);   // while down: kept, not thrown

  // Mantle starts: connects on the next try, sends every window's CURRENT hint
  const m = fakeMantle(PIPE);
  await m.listen();
  ok(await until(() => client.status().state === 'connected', 2600), 'connects within one retry', client.status());
  ok(await until(() => m.got.length >= 1, 1000), 'on connect: the current hint goes out');
  let g = m.got[0] && m.got[0].m;
  ok(g && g.v === 1 && g.app === 'quartz' && g.hwnd === HW && g.top.kind === 'wash' && g.top.alpha === 0.5, 'on connect: v1 line with hwnd and the wash', g);
  ok(statuses.some((s) => s && s.state === 'connected'), 'status pushed to the page on connect');

  // page hints: seq goes up, t is the page's, junk becomes none
  const before = m.got.length;
  client.hint({ kind: 'wash', rgb: [9, 10, 11], alpha: 0.75 }, 1234567);
  client.hint({ kind: 'flat', rgb: [300, 1, 2] }, 1234568);
  client.hint({ kind: 'cols', cols: [[1, 2, 3], [4, 5, 6]] }, 1234569);
  await until(() => m.got.length >= before + 3, 1000);
  const three = m.got.slice(before, before + 3).map((x) => x.m);
  ok(three.length === 3 && three[0].seq < three[1].seq && three[1].seq < three[2].seq, 'seq increases per hint', three.map((x) => x && x.seq));
  ok(three[0] && three[0].t === 1234567 && three[0].top.alpha === 0.75, "hint carries the page's t", three[0]);
  ok(three[1] && three[1].top.kind === 'none', 'an invalid TOP goes out as none', three[1] && three[1].top);
  ok(three[2] && three[2].top.kind === 'cols' && three[2].top.cols.length === 2, 'cols pass through', three[2] && three[2].top);

  // maximize / restore: the current hint again, fresh seq; fullscreen: none, then back
  let n0 = m.got.length;
  client.event(HW, 'maximize');
  client.event(HW, 'enter-full-screen');
  client.hint({ kind: 'wash', rgb: [9, 10, 11], alpha: 0.5 }, 1);   // the page speaks while fullscreen
  client.event(HW, 'leave-full-screen');
  client.event(HW, 'unmaximize');
  await until(() => m.got.length >= n0 + 5, 1000);
  const ev = m.got.slice(n0).map((x) => x.m.top);
  ok(ev[0] && ev[0].kind === 'cols', 'maximize: the current hint again', ev[0]);
  ok(ev[1] && ev[1].kind === 'none' && ev[2] && ev[2].kind === 'none', 'fullscreen: none, even when the page speaks', ev.slice(1, 3));
  ok(ev[3] && ev[3].kind === 'wash' && ev[4] && ev[4].kind === 'wash', "leaving fullscreen: the page's last hint", ev.slice(3));

  // a long cols hint stays under 8 KB
  const many = Array.from({ length: 1500 }, (_, i) => [i % 256, 255, 255]);
  n0 = m.got.length;
  client.hint({ kind: 'cols', cols: many }, 2);
  await until(() => m.got.length > n0, 1000);
  const big = m.got[n0];
  ok(big && big.bytes <= 8192 && big.m.top.kind === 'cols' && big.m.top.cols.length < 1500 && big.m.top.cols.length >= 375, 'over 8 KB: columns halved until the line fits', big && [big.bytes, big.m.top.cols && big.m.top.cols.length]);

  // a pop-up: none on create, none on close
  n0 = m.got.length;
  client.window('777', { chrome: false });
  client.event('777', 'closed');
  await until(() => m.got.length >= n0 + 2, 1000);
  ok(m.got.slice(n0).every((x) => x.m.hwnd === '777' && x.m.top.kind === 'none') && m.got.length - n0 === 2, 'pop-up: none on create and on close');

  // Mantle goes away: waiting with the reason; comes back: reconnects and resends
  await m.close();
  ok(await until(() => client.status().state === 'waiting', 1500) && /closed the pipe|not running/.test(client.status().reason), 'Mantle quits: waiting, says why', client.status());
  const m2 = fakeMantle(PIPE);
  await m2.listen();
  ok(await until(() => m2.got.length >= 1, 3000), 'Mantle back: reconnects within one retry and resends');
  ok(m2.got[0] && m2.got[0].m.seq > big.m.seq, 'seq keeps rising across reconnects', m2.got[0] && m2.got[0].m.seq);
  n0 = m2.got.length;
  client.close();
  ok(await until(() => m2.got.length > n0, 1000) && m2.got[m2.got.length - 1].m.top.kind === 'none', 'close: none on the way out');
  await m2.close();

  // the hint before the HWND was known went out after "none" on create
  const early = TM.createClient({ net: { connect: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }, pipe: PIPE, log: () => {} });
  early.hint({ kind: 'flat', rgb: [1, 2, 3] }, 5);
  early.window('42', { chrome: true });
  ok(early._windows.get('42').pageTop.kind === 'flat', 'a hint from before window() is kept for the chrome window');
  ok(early.status().state === 'waiting' && /not running/.test(early.status().reason), 'connect throwing: waiting with the reason, no throw', early.status());
  early.close();

  // test profile without TOPROW_PIPE: never connects, says why
  let tries2 = 0;
  const off = TM.createClient({ net: { connect: () => { tries2++; throw new Error('should not connect'); } }, disabled: TM.TEST_OFF, log: () => {} });
  await sleep(100);
  ok(off.status().state === 'off' && /test/.test(off.status().reason) && tries2 === 0, 'test profile: off, never the real pipe', off.status());
  off.close();

  // main's glue: config names the chrome window, events reach its page
  const handlers = {};
  const sent = [];
  const mk = (hw) => {
    const on = {}; const buf = Buffer.alloc(8); buf.writeBigUInt64LE(BigInt(hw));
    return { on: (e, f) => { (on[e] = on[e] || []).push(f); }, emit: (e) => (on[e] || []).forEach((f) => f()),
      getNativeWindowHandle: () => buf, isFullScreen: () => false, isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (ch, msg) => sent.push([ch, msg]) } };
  };
  const chromeW = mk(1001), popW = mk(2002);
  const saved = process.env.TOPROW_PIPE; delete process.env.TOPROW_PIPE;
  const glue = TM.install({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, BrowserWindow: { fromWebContents: (wc) => (wc === 'chrome' ? chromeW : popW) }, test: true });
  if (saved !== undefined) process.env.TOPROW_PIPE = saved;
  ok(glue.attachWindow(chromeW, { chrome: true }) === '1001', 'glue: the chrome window by HWND');
  const cfg = handlers['toprow:config']({ sender: 'chrome' });
  ok(cfg && cfg.hwnd === '1001' && cfg.pipe === TM.PIPE && cfg.disabled === TM.TEST_OFF, 'glue: config = hwnd, pipe, off in a test window', cfg);
  ok(handlers['toprow:config']({ sender: 'other' }) === null, 'glue: config only for the chrome window');
  chromeW.emit('maximize'); chromeW.emit('enter-full-screen');
  glue.attachWindow(popW, { chrome: false }); popW.emit('closed');
  ok(JSON.stringify(sent.map((x) => x[1].event)) === JSON.stringify(['maximize', 'enter-full-screen', 'create', 'closed']) && sent.every((x) => x[0] === 'toprow:window'),
    'glue: window events and pop-ups go to the page', sent.map((x) => x[1]));

  if (fails.length) console.log(fails.map((f) => 'FAIL ' + f).join('\n'));
  console.log(`toprow-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('HARNESS ERROR ' + (e && e.stack || e)); console.log(`toprow-test: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
