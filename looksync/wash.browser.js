/* VENDORED from ~/look-sync commit 6e7e729 (look-sync.js pure block: washAlpha and the v2 brightness check, wrapped for <script> pages).
   Do not edit this copy: change ~/look-sync, run its tests, then `node looksync/vendor.js <commit>`. */
(function () {
'use strict';
// Everything from here to the matching "end" line is plain JS with no
// require() and no reference to anything outside it, so an app may lift it
// into a page script (Quartz's looksync/vendor.js builds wash.browser.js from
// it) and the native port translates it one to one. Keep it that way.

// The first seed: Match Windows (2026-10-14, when the user un-held the light look;
// the 2026-10-10 seed was Dark). Glass (2026-11-11, CONTRACT "sharp painted
// glass + tint override"): blur 0 in both themes (the picture is painted
// sharp) and a lighter dim .30 in both, raised automatically where a picture
// needs it (washAlpha). dimAuto is absent: absent means automatic.
// Dim .20 in both themes (the user, 2026-11-24, the islands look, CONTRACT
// "2026-11-24: the islands look (v2)"); the range stays 0.20-0.90.
const SEED = Object.freeze({
  theme: 'system',
  accent: Object.freeze({ hue: null }),
  glass: Object.freeze({
    dark: Object.freeze({ blurPx: 0, dim: 0.20, panel: 0 }),
    light: Object.freeze({ blurPx: 0, dim: 0.20, panel: 0 }),
    render: 'picture'
  })
});

const RANGES = { blurPx: [0, 64], dim: [0.20, 0.90], panel: [-0.30, 0.15] };

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v, [lo, hi]) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

// The guard's ceiling (Mantle's dark --lg-fill-pop alpha; CONTRACT desktop.guard).
const WASH_CEIL = 0.88;
const r2 = n => Math.round(n * 100) / 100;
const a2 = n => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : JSON.stringify(n));

/**
 * The tint (wash alpha) every app lays over the painted desktop, worked out
 * the same way everywhere (CONTRACT "2026-11-11: sharp painted glass + tint
 * override").
 *   look    the look values { glass } (or shared()'s { glass: { v } })
 *   desktop the desktop record the app is painting (doc.desktop), or null
 *   theme   'dark' | 'light': the theme in effect (never 'system')
 *   opts    { unusable: 'reason' } when the app can't use this record's
 *           top band right now (it isn't painting this still yet, sync is
 *           off, its own picture shows): automatic then stays at Dim.
 * Manual (glass.<theme>.dimAuto === false): exactly Dim, the guard ignored.
 * Automatic (dimAuto absent or true): max(Dim, desktop.guard.<theme>.alpha)
 * when that guard is valid (an alpha 0..1, worked out for this Dim and blur,
 * at most max(.88, Dim)), else Dim, with the reason.
 * -> { alpha, mode: 'auto'|'manual', raised, guarded, reason, dim, contrast, text }
 *    guarded = Mantle's top band was valid and taken into the max (auto only).
 *    text is the Settings row, e.g. "Automatic: 0.30, raised to 0.46 so text
 *    stays readable over this picture" or "Manual: 0.20". Never throws.
 */
function washAlpha(look, desktop, theme, opts) {
  const t = theme === 'light' ? 'light' : 'dark';
  let glass = isObj(look) ? look.glass : null;
  if (isObj(glass) && isObj(glass.v) && !isObj(glass[t])) glass = glass.v;   // shared() shape
  const g = isObj(glass) && isObj(glass[t]) ? glass[t] : null;
  const seed = SEED.glass[t];
  const dimOk = !!g && num(g.dim, RANGES.dim);
  const dim = dimOk ? g.dim : seed.dim;
  const blur = g && num(g.blurPx, RANGES.blurPx) ? g.blurPx : seed.blurPx;
  const badDim = dimOk ? null
    : 'glass.' + t + '.dim is missing or outside ' + a2(RANGES.dim[0]) + '-' + a2(RANGES.dim[1]) + ', so the default ' + a2(seed.dim);
  if (g && g.dimAuto === false) {
    return { alpha: dim, mode: 'manual', raised: false, guarded: false, dim, contrast: null,
      reason: badDim || 'Dim is set by hand, so the picture never changes it',
      text: 'Manual: ' + a2(dim) + (badDim ? ' (' + badDim + ')' : '') };
  }
  const plain = why => {
    why = badDim ? badDim + '; ' + why : why;
    return { alpha: dim, mode: 'auto', raised: false, guarded: false, dim, contrast: null, reason: why,
      text: 'Automatic: ' + a2(dim) + ', not raised: ' + why };
  };
  const o = isObj(opts) ? opts : {};
  if (typeof o.unusable === 'string' && o.unusable) return plain(o.unusable);
  if (!isObj(desktop)) return plain('no desktop picture from Mantle');
  if (desktop.ok === false) {
    return plain('Mantle has no desktop picture' + (typeof desktop.reason === 'string' && desktop.reason ? ' (' + desktop.reason + ')' : ''));
  }
  if (typeof desktop.still !== 'string' || !desktop.still) return plain("Mantle's desktop record names no picture");
  const gd = desktop.guard;
  if (!isObj(gd)) {
    return plain(typeof desktop.guardReason === 'string' && desktop.guardReason
      ? "Mantle couldn't work out the top band (" + desktop.guardReason + ')'
      : 'Mantle has not published a top band for this picture');
  }
  const e = gd[t];
  if (!isObj(e)) return plain('Mantle has not published the ' + t + ' top band yet');
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  if (!isNum(e.alpha) || e.alpha < 0 || e.alpha > 1) return plain("Mantle's " + t + ' top band ' + a2(e.alpha) + ' is not an alpha (0-1)');
  if (!isNum(e.dim)) return plain("Mantle's " + t + ' top band names no Dim');
  if (!isNum(e.blurPx)) return plain("Mantle's " + t + ' top band names no blur');
  if (r2(e.dim) !== r2(dim) || r2(e.blurPx) !== r2(blur)) {
    return plain('Mantle worked out the ' + t + ' top band for Dim ' + a2(e.dim) + ' and blur ' + e.blurPx +
      ' px, not this Dim ' + a2(dim) + ' and blur ' + blur + ' px (waiting for Mantle to work it out again)');
  }
  const ceil = Math.max(WASH_CEIL, dim);
  const a = r2(e.alpha);
  if (a > ceil + 1e-9) return plain("Mantle's " + t + ' top band ' + a2(a) + ' is above the ' + a2(ceil) + ' ceiling');
  const contrast = isNum(e.contrast) ? e.contrast : null;
  if (a > dim + 1e-9) {
    return { alpha: a, mode: 'auto', raised: true, guarded: true, dim, contrast,
      reason: 'raised to ' + a2(a) + ' so text stays readable over this picture',
      text: 'Automatic: ' + a2(dim) + ', raised to ' + a2(a) + ' so text stays readable over this picture' };
  }
  const why = badDim ? badDim + '; ' : '';
  return { alpha: dim, mode: 'auto', raised: false, guarded: true, dim, contrast,
    reason: why + 'text already reads over this picture at this Dim',
    text: 'Automatic: ' + a2(dim) + ', ' + why + 'text already reads over this picture at this Dim' };
}

// ---- v2: the islands look (the user, 2026-11-24; CONTRACT "2026-11-24: the islands look (v2)") ----
// Panels show the wallpaper still, dimmed by Dim and blurred by size, at its own
// colours. Two copies are blurred ONCE (not live): 'light' for small chrome and
// 'soft' for big panels. Where the picture behind a panel is too bright for white
// text, the panel gets just enough neutral film (liftAlpha) for its brightest tenth.

// The two pre-blurred copies: blurPx on a bitmapWidth-wide copy of the still
// (about 16 and 40 px on a 1440p screen). A panel is big when its short side is
// at least bigMin px AND its area at least bigArea px² (layout px / DIP).
const FROST = Object.freeze({
  bitmapWidth: 512,
  light: Object.freeze({ blurPx: 6 }),
  soft: Object.freeze({ blurPx: 15 }),
  bigMin: 48,
  bigArea: 20000
});

// The brightness check: a cols x rows grid of samples over the panel.
// Dark theme: the sample at index floor(n * quantile) after sorting brightest
// first (the 5th of 40) is darkened with film rgb in steps of step, up to max,
// until its relative luminance is at most target.
// Light theme (LIGHT.md section 4b): the same index after sorting DARKEST first is
// lightened with light.rgb (#F4F7F8) until its luminance is at least light.target.
// Targets (v2.1, the user 2026-11-24 option (b)): the worst of text-2, ok and down
// reaches 4.5:1 at the floor in both themes, over any hue. Dark 0.066 is set by
// down #FF9D95 (0.163 only covered the main ink); light 0.386 by text-2 (ink .76).
// max .72 is what white at the lowest Dim (.20) needs in dark; black needs .68 in light.
const LIFT = Object.freeze({
  cols: 8, rows: 5, quantile: 0.1,
  rgb: Object.freeze([10, 12, 14]),
  target: 0.066, step: 0.04, max: 0.72,
  light: Object.freeze({ rgb: Object.freeze([244, 247, 248]), target: 0.386 })
});

/** 'soft' for a big panel, else 'light'. w, h: the panel's layout size in px. */
function frostKind(w, h) {
  const ok = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!ok(w) || !ok(h)) return 'light';
  return Math.min(w, h) >= FROST.bigMin && w * h >= FROST.bigArea ? 'soft' : 'light';
}

/** The cols x rows sample points (cell centres) of a panel at x, y, size w x h. */
function liftPoints(x, y, w, h) {
  const pts = [];
  for (let i = 0; i < LIFT.cols; i++) {
    for (let j = 0; j < LIFT.rows; j++) {
      pts.push({ x: x + ((i + 0.5) / LIFT.cols) * w, y: y + ((j + 0.5) / LIFT.rows) * h });
    }
  }
  return pts;
}

const srgbLin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
/** Relative luminance (WCAG) of [r, g, b] in 0..255. */
function relLum(rgb) {
  return 0.2126 * srgbLin(rgb[0]) + 0.7152 * srgbLin(rgb[1]) + 0.0722 * srgbLin(rgb[2]);
}
const filmOver = (rgb, a, film) => [0, 1, 2].map(k => rgb[k] * (1 - a) + (film || LIFT.rgb)[k] * a);

/**
 * The film alpha for one panel.
 *   samples  [[r, g, b], ...] in 0..255: the panel's liftPoints read from the
 *            blurred copy that panel shows (frostKind), BEFORE Dim
 *   dim      the Dim in effect (0..1); anything else = the seed Dim
 *   theme    'light' = the LIGHT.md 4b lift toward LIFT.light.rgb; anything else = dark
 * What is behind the panel is the copy times (1 - dim): Dim is a black wash in
 * both themes.
 * -> 0, or a multiple of step up to max (2 decimals). 0 when no sample is
 *    usable (the panel stays pure blur). Never throws.
 */
function liftAlpha(samples, dim, theme) {
  const light = theme === 'light';
  const d = typeof dim === 'number' && Number.isFinite(dim) && dim >= 0 && dim <= 1 ? dim : SEED.glass.dark.dim;
  const ch = v => (typeof v === 'number' && Number.isFinite(v) ? Math.min(255, Math.max(0, v)) : null);
  const keep = 1 - d;
  const seen = [];
  if (Array.isArray(samples)) {
    for (const s of samples) {
      if (!Array.isArray(s) || s.length < 3) continue;
      const rgb = [ch(s[0]), ch(s[1]), ch(s[2])];
      if (rgb.includes(null)) continue;
      const dimmed = rgb.map(v => v * keep);
      seen.push({ rgb: dimmed, l: relLum(dimmed) });
    }
  }
  if (!seen.length) return 0;
  seen.sort(light ? (p, q) => p.l - q.l : (p, q) => q.l - p.l);   // light: darkest first
  const pick = seen[Math.floor(seen.length * LIFT.quantile)].rgb;
  const at = k => Math.round(k * LIFT.step * 100) / 100;
  const short = light
    ? a => relLum(filmOver(pick, a, LIFT.light.rgb)) < LIFT.light.target
    : a => relLum(filmOver(pick, a)) > LIFT.target;
  let n = 0;
  while (at(n) < LIFT.max && short(at(n))) n++;
  return Math.min(LIFT.max, at(n));
}

/**
 * One panel's film in the theme in effect, with the Settings row.
 *   look     { glass } (or shared()'s { glass: { v } }); theme 'dark' | 'light'
 *   samples  as liftAlpha
 * Check on (glass.<theme>.dimAuto absent or true): alpha = liftAlpha(samples, dim, theme).
 * Check off (dimAuto false): alpha 0; the panel is pure blur over the dimmed picture.
 * film: the neutral to lay at alpha: rgb(10,12,14) in dark, #F4F7F8 in light (LIGHT.md section 4b).
 * An app that has not built its light look yet does not call this in light.
 * -> { alpha, check: 'on'|'off', dim, film, text }. Never throws.
 */
function panelLift(look, theme, samples) {
  const t = theme === 'light' ? 'light' : 'dark';
  let glass = isObj(look) ? look.glass : null;
  if (isObj(glass) && isObj(glass.v) && !isObj(glass[t])) glass = glass.v;   // shared() shape
  const g = isObj(glass) && isObj(glass[t]) ? glass[t] : null;
  const dim = g && num(g.dim, RANGES.dim) ? g.dim : SEED.glass[t].dim;
  const film = (t === 'light' ? LIFT.light.rgb : LIFT.rgb).slice();
  if (g && g.dimAuto === false) {
    return { alpha: 0, check: 'off', dim, film, text: 'Brightness check off: Dim ' + a2(dim) + ' only' };
  }
  const alpha = liftAlpha(samples, dim, t);
  const did = t === 'light' ? ['lightened', 'dark', 'lighten'] : ['darkened', 'bright', 'darken'];
  return { alpha, check: 'on', dim, film,
    text: alpha > 0
      ? 'Brightness check on: Dim ' + a2(dim) + ', ' + did[0] + ' ' + a2(alpha) + ' where the picture is ' + did[1]
      : 'Brightness check on: Dim ' + a2(dim) + ', nothing to ' + did[2] + ' here' };
}
window.LookWash = { washAlpha: washAlpha, SEED: SEED, RANGES: RANGES, WASH_CEIL: WASH_CEIL,
  FROST: FROST, LIFT: LIFT, frostKind: frostKind, liftPoints: liftPoints, relLum: relLum, liftAlpha: liftAlpha, panelLift: panelLift };
})();
