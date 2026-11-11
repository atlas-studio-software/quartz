/* VENDORED from ~/look-sync commit 3fa3800 (look-sync.js pure block: washAlpha, wrapped for <script> pages), Owen-Silva/look-sync.
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
const SEED = Object.freeze({
  theme: 'system',
  accent: Object.freeze({ hue: null }),
  glass: Object.freeze({
    dark: Object.freeze({ blurPx: 0, dim: 0.30, panel: 0 }),
    light: Object.freeze({ blurPx: 0, dim: 0.30, panel: 0 }),
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
window.LookWash = { washAlpha: washAlpha, SEED: SEED, RANGES: RANGES, WASH_CEIL: WASH_CEIL };
})();
