/* ============================================================
   newtab-theme.js — the first thing this page runs.

   Loaded in <head> BEFORE the page's stylesheet so the right palette
   is in place for the very first paint: a light window never flashes
   dark, and a custom accent hue never flashes the default steel blue.
   The single source of truth for the whole page is the data-theme
   attribute on <html>. The new tab, the history page, the files page
   and the reader all load this file; tokens.css (imported first by
   each of their stylesheets) holds the colours it switches between.

   Resolution order for the theme:
     1. ?theme=light / ?theme=dark, appended by the browser chrome
     2. dark

   The palette preset comes from ?palette=<name> and lands as
   data-palette on <html>, the same way and for the same reason:
   tokens.css carries a block per preset per theme (a palette is an
   accent only now), so the right accent is in place for the first
   paint. No palette (or "aurora") = no attribute = the default.

   The accent comes from ?hue=<0-360>, painted over the authored
   --ion* tokens as inline custom properties on <html> (inline
   beats both :root blocks, so one pass covers either theme).
   No hue = no inline properties = tokens.css's own accent.

   No localStorage: this page is loaded from file://, where storage
   is unreliable, and the chrome owns the preference anyway. When
   the chrome changes theme later it simply sets data-theme again;
   CSS does the rest, and newtab.js re-runs applyAccent through
   window.__applyAccent so the hue tracks the new base colour.
   ============================================================ */

(function () {
  'use strict';

  var root = document.documentElement;

  /* --- theme ------------------------------------------------- */

  var params = null;

  try {
    params = new URLSearchParams(window.location.search);
  } catch (err) {
    params = null;
  }

  var theme = params ? params.get('theme') : null;

  // The chrome always passes ?theme=; if it ever does not, match its own
  // default (dark) rather than the Windows app-mode setting.
  if (theme !== 'light' && theme !== 'dark') theme = 'dark';

  root.setAttribute('data-theme', theme);

  /* --- palette preset ---------------------------------------- */

  /* The five presets tokens.css carries. Anything
     else — no param, 'aurora', junk — means the authored default,
     which is the absence of the attribute rather than a value. */
  var PALETTES = ['ember', 'forest', 'ocean', 'midnight', 'mono'];

  function applyPalette(name) {
    var value = (name === null || name === undefined) ? '' : String(name);
    if (PALETTES.indexOf(value) < 0) {
      root.removeAttribute('data-palette');
      return;
    }
    root.setAttribute('data-palette', value);
  }

  window.__applyPalette = applyPalette;

  applyPalette(params ? params.get('palette') : null);

  /* --- accent ------------------------------------------------ */

  /* The accent family tokens.css defines (the --ion* names; --accent*
     follow them), with the alpha each is authored at per theme. The chrome
     derives its own accent with the same formula, so one hue lands
     identically on the chrome and on these pages. Values: tokens.css. */
  var ION_TOKENS = [
    //  name             dark   light
    ['--ion',            null,  null],
    ['--ion-soft',       0.14,  0.11],
    ['--ion-glow',       0.22,  0.22],
    ['--ion-line',       0.42,  0.40],
    ['--ion-select',     0.32,  0.20],
    ['--seam-color',     0.14,  0.14],
    ['--chamber-seam',   0.16,  0.16]
  ];

  // Helm's accent strength: the default steel blue is hsl(212 31% 71%) on
  // dark and hsl(212 26% 41%) on light, and a custom hue keeps exactly that
  // saturation and lightness, so only the hue moves (the palettes do too).
  function baseFor(themeName) {
    return themeName === 'light' ? { s: 26, l: 41 } : { s: 31, l: 71 };
  }

  /* LookAccent.tokens(hue, theme) -> { acc, soft, glow, line, select, rgb }
     onto the --ion* names this page has always set. --seam-color and
     --chamber-seam have no shared token: they are the accent rgb at this
     page's own alphas, exactly as before. null when the module refuses. */
  function sharedTokens(hue, themeName) {
    var t;
    var light = themeName === 'light';
    // the look-sync profile per theme (v2.2): 'islands' in light, whose look is built; dark as it was
    try { t = light ? window.LookAccent.tokens(hue, 'light', 'islands') : window.LookAccent.tokens(hue, themeName); } catch (err) { t = null; }
    if (!t || !t.rgb) return null;
    var rgb = t.rgb.join(', ');
    var out = {
      '--ion': t.acc,
      '--ion-soft': t.soft,
      '--ion-glow': t.glow,
      '--ion-line': t.line,
      '--ion-select': t.select
    };
    for (var i = 0; i < ION_TOKENS.length; i++) {
      var name = ION_TOKENS[i][0];
      if (!out[name]) out[name] = 'rgba(' + rgb + ', ' + ION_TOKENS[i][light ? 2 : 1] + ')';
    }
    // light: the profile's strong (hover / pressed) and ink on it, as the chrome paints them
    if (light && t.strong) out['--accent-strong'] = t.strong;
    if (light && t.on) out['--accent-text'] = t.on;
    return out;
  }
  // painted inline in light only, with a hue (settings.js ACCENT_EXTRA)
  var ACCENT_EXTRA = ['--accent-strong', '--accent-text'];

  // Kept so a data-theme flip can re-derive the same hue on the new base.
  var lastHue = null;

  function normalizeHue(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    if (!isFinite(n)) return null;
    return ((n % 360) + 360) % 360;
  }

  /**
   * Paint an accent hue over the authored tokens. null (or anything that
   * is not a number) clears the inline properties and the stylesheet's
   * own accent comes back.
   */
  function applyAccent(hue) {
    var h = normalizeHue(hue);
    var style = root.style;
    var i;

    lastHue = h;
    for (i = 0; i < ACCENT_EXTRA.length; i++) style.removeProperty(ACCENT_EXTRA[i]);

    if (h === null) {
      for (i = 0; i < ION_TOKENS.length; i++) style.removeProperty(ION_TOKENS[i][0]);
      return;
    }

    var light = root.getAttribute('data-theme') === 'light';

    /* The shared Look Sync formula (looksync/accent.browser.js, loaded just
       before this file): the same tokens Helm, Mantle and the chrome derive,
       mapped onto the same --ion* names as before. Missing (an old page
       shell) -> the local formula below, as before. */
    var shared = window.LookAccent && typeof window.LookAccent.tokens === 'function'
      ? sharedTokens(Math.round(h) % 360, light ? 'light' : 'dark') : null;
    if (shared) {
      for (i = 0; i < ION_TOKENS.length; i++) style.setProperty(ION_TOKENS[i][0], shared[ION_TOKENS[i][0]]);
      for (i = 0; i < ACCENT_EXTRA.length; i++) if (shared[ACCENT_EXTRA[i]]) style.setProperty(ACCENT_EXTRA[i], shared[ACCENT_EXTRA[i]]);
      return;
    }

    var base = baseFor(light ? 'light' : 'dark');
    var head = h + ' ' + base.s + '% ' + base.l + '%';

    for (i = 0; i < ION_TOKENS.length; i++) {
      var alpha = ION_TOKENS[i][light ? 2 : 1];
      style.setProperty(
        ION_TOKENS[i][0],
        'hsl(' + head + (alpha === null ? '' : ' / ' + alpha) + ')'
      );
    }
  }

  // newtab.js owns the later glue (a data-theme observer, __applySettings),
  // and needs both the setter and the last hue back to re-derive.
  window.__applyAccent = applyAccent;
  window.__accentHue = function () { return lastHue; };

  applyAccent(params ? params.get('hue') : null);
})();
