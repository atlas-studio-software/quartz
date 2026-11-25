/* VENDORED from ~/look-sync commit dca42dc (accent.js).
   Do not edit this copy: change ~/look-sync, run its tests, then `node looksync/vendor.js <commit>`. */
'use strict';
/*
 * accent.js - the shared hue -> accent token mapping (Look Sync contract, section 3).
 * Zero dependencies, CommonJS. Vendored by Helm, Quartz and Mantle.
 *
 * The formula is Quartz's (settings.js:315-324): a custom hue keeps the
 * saturation and lightness of the app's own accent. The S/L used here are the
 * EXACT values of the authored hexes, not Quartz's rounded 31%/71% and 26%/41%:
 * rounded values give #9eb4cc at hue 212, one step off the steel blue.
 *
 * Two profiles (CONTRACT "Accent profiles", 2026-11-25):
 *   steel    the v1 look: Helm's steel blue (dark #9fb4cc, light #4d6784), base hue 212. The default.
 *   islands  the v2 islands look: ice blue (dark #a9e7ed, ink on it #052a2f), base hue 185. Its light
 *            tokens stay steel's until an app builds its light look (LIGHT.md), so today's light is unchanged.
 * At a profile's base hue (per theme) the tokens ARE the authored hexes, so turning "Custom" on at
 * baseHue(profile) keeps the dark colour exactly (ice blue stays #a9e7ed); other hues keep the authored S/L.
 * islands light: at 185 it is steel's light S/L at hue 185 (#4d7f84), not #4d6784 (one shared hue, two themes).
 *
 *   tokens(hue, theme, profile?) -> { acc, strong, on, soft, line, select, glow, rgb }
 *   tokens(null, theme)          -> null   (hue null = keep the app's own tokens)
 *   baseHue(profile)             -> 212 | 185
 */

// The authored hexes of each profile and theme.
// acc    --accent        strong  --accent-strong   on  --accent-text (text on an accent fill; null = white)
const AUTHORED = {
  steel: {
    dark: { acc: '#9fb4cc', strong: '#b7c8db', on: '#11161c' },
    light: { acc: '#4d6784', strong: '#3c536d', on: null }
  },
  islands: {
    dark: { acc: '#a9e7ed', strong: '#c4f0f4', on: '#052a2f' },     // LOOK.md accent; Helm tokens.css ce15f69
    light: { acc: '#4d6784', strong: '#3c536d', on: null }          // today's light, until the light look
  }
};
// The hue of each profile's authored accent, per theme: at that hue the tokens are the authored hexes.
// islands light reuses steel's light hexes, so its light base is steel's 212.
const BASE_HUE = { steel: { dark: 212, light: 212 }, islands: { dark: 185, light: 212 } };
const PROFILES = Object.keys(AUTHORED);

const rgbOf = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
// Exact S/L of a hex (H dropped: the hue is the user's).
function slOf(hex) {
  const [r, g, b] = rgbOf(hex).map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [s, l];
}
const SL = {};
for (const p of PROFILES) {
  SL[p] = {};
  for (const t of ['dark', 'light']) {
    const a = AUTHORED[p][t];
    SL[p][t] = { acc: slOf(a.acc), strong: slOf(a.strong), on: a.on ? slOf(a.on) : null };
  }
}
// Alphas of the derived tokens, per theme (Helm tokens.css + Quartz ION_TOKENS).
const ALPHA = {
  dark: { soft: 0.14, line: 0.42, select: 0.32, glow: 0.22 },
  light: { soft: 0.11, line: 0.40, select: 0.20, glow: 0.22 }
};
const DEFAULT_HUE = 212; // the steel blue (profile steel's base hue)
const ISLANDS_HUE = 185; // ice blue (profile islands' base hue)

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r, g, b].map(v => Math.round((v + m) * 255));
}
const hex = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
const rgba = (rgb, a) => 'rgba(' + rgb.join(', ') + ', ' + a + ')';

function validHue(hue) {
  return Number.isInteger(hue) && hue >= 0 && hue <= 360;
}

/** The profile name in effect: 'islands' or 'steel' (anything else, absent included). */
function profileOf(profile) {
  return profile === 'islands' ? 'islands' : 'steel';
}

/** A profile's base hue (dark by default): where Custom starts, and where its tokens are exactly the authored hexes. */
function baseHue(profile, theme) {
  return BASE_HUE[profileOf(profile)][theme === 'light' ? 'light' : 'dark'];
}

function tokens(hue, theme, profile) {
  if (hue === null || hue === undefined) return null;
  if (!validHue(hue)) throw new RangeError('accent hue must be an integer 0..360, got ' + hue);
  const t = theme === 'light' ? 'light' : 'dark';
  const p = profileOf(profile);
  const sl = SL[p][t], al = ALPHA[t], au = AUTHORED[p][t];
  const exact = hue === BASE_HUE[p][t];   // the base hue IS the authored colour, to the last digit
  const make = (key) => exact ? rgbOf(au[key]) : hslToRgb(hue, sl[key][0], sl[key][1]);
  const acc = make('acc');
  const strong = make('strong');
  const on = au.on ? make('on') : [255, 255, 255];
  return {
    acc: hex(acc),
    strong: hex(strong),
    on: hex(on),
    soft: rgba(acc, al.soft),
    line: rgba(acc, al.line),
    select: rgba(acc, al.select),
    glow: rgba(acc, al.glow),
    rgb: acc
  };
}

module.exports = { tokens, validHue, hslToRgb, baseHue, profileOf, DEFAULT_HUE, ISLANDS_HUE, PROFILES, AUTHORED, ALPHA };
