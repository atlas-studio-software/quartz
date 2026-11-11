'use strict';

/*
 * settings.js — the settings instrument: a nav-row gear beside the theme
 * toggle, and a glass popover holding everything the browser lets you change.
 *
 * The renderer runs with contextIsolation ON and nodeIntegration OFF, so this
 * is plain browser script: no require(), no import, no bundler. Loaded after
 * app.js (whose top-level function declarations — setTheme, getActiveTab,
 * readCurrentUrl — are therefore global by the time anything here runs).
 *
 * WHAT IS PERSISTED. One JSON object in localStorage['settings']:
 *
 *   { searchEngine: 'google'|'duckduckgo'|'bing'|'brave'|'startpage',
 *     siteTheme:    'system'|'light'|'dark',
 *     palette:      'aurora'|'ember'|'forest'|'ocean'|'midnight'|'mono',
 *     accentHue:    null | 0..360,
 *     chips:        null | [{ label, url }, ...],
 *     chipsSource:  'visited' | 'list',      // where the new tab's five come from
 *     keywords:     null | [{ key, name, url, upper?, disabled? }, ...],
 *                                           // address-bar keywords ("gh helm");
 *                                           // null = keywords.js's built-ins
 *     homepage:     'newtab',
 *     claudeDir:    null | absolute path,   // Claude pane's folder; null = home
 *     claudeResume: true | false,           // --continue on a restored beside pane
 *     claudeSkipPermissions: true | false,  // --dangerously-skip-permissions;
 *                                           // off on a new profile
 *     claudeNotify: true | false,           // toast when a pane goes quiet
 *     claudeReadTabs: true | false,         // Claude panes get Quartz's read-only
 *                                           // tab tools (mcp-main.js); default on
 *     tabSleepMinutes: 0|15|30|60|180,      // 0 = never sleep a background tab
 *     workspaceSleep: 'newtab'|'all'|'off', // sleep tabs in the workspaces
 *                                           // you are not looking at
 *     workspaceSleepMinutes: 0|5|10|30|60,  // 'all' only: minutes away first
 *     newtabBackground: { kind: 'desktop'|'builtin'|'image'|'video'|'none',
 *                         dim: 0..0.6, id?, fileUrl?, fileName?,
 *                         clipRev?, imageRev?, rev },
 *                   // THE Quartz background: the whole window's (behind
 *                   // the tabs, toolbar and panes, see backdrop.js) AND
 *                   // the new tab's. The key keeps its old name so stored
 *                   // prefs survive; 'wallpaper'/'board'/'aurora' read as
 *                   // 'desktop' (Mantle's desktop wallpaper, Look Sync).
 *     ownBackground: null | { kind: 'builtin'|'image'|'video'|'none', ... },
 *                   // the last "Own picture" choice, restored by that mode
 *     bgMigration:  1 once the one-time move to 'desktop' ran
 *     claudeSkipMigration: 1 once the one-time skip-permissions check ran
 *     lookSync:     true | false,           // "Match Helm and Mantle"
 *     glass:        { dark: { blurPx, dim, panel, dimAuto? }, light: { ... },
 *                     render: 'picture' }    // shared through Look Sync
 *     music:        { enabled, source: 'ambient'|'files',
 *                     where: 'newtab'|'anywhere', volume: 0..1,
 *                     files: [{ path, name }], shuffle } }
 *
 * THE NEW TAB'S PICTURE IS NOT IN THERE. kind 'image' needs a photo, and a
 * 2560px JPEG as base64 is about a megabyte of string that localStorage would
 * rewrite on every unrelated write. The blob lives in IndexedDB instead —
 * db 'browser', store 'assets', key 'newtab-bg' — and Settings.background()
 * hands app.js the pair as { kind, dim, url?, fileName?, ... }. `rev` is
 * a stamp, so replacing the picture still counts as a change worth pushing.
 * imageRev / clipRev change only when the picture / the clip itself changes,
 * so backdrop.js re-blurs (and re-captures a clip's still) only then, never
 * for a dim change.
 *
 * THE PALETTE IS MIRRORED. `palette` also lives under its own localStorage
 * key ('palette', absent for the default aurora) because theme-boot.js has to
 * stamp <html data-palette> before the first paint, long before this file
 * parses. applyPalette() writes both, so the two never drift.
 *
 * THE STOCKS SECTION IS NOT IN THERE EITHER, and that one is a rule rather
 * than a tidiness: its Finnhub key lives in MAIN (stocks.js, in
 * <userData>/stocks.json, as `stocks.finnhubKey`) and never crosses back.
 * The pane asks window.api.stocks.describe() for { enabled, hasKey, keyMask,
 * symbols, … } and writes with setKey/setEnabled/setSymbols; a key in this
 * file's localStorage object would be a key any devtools console could read.
 *
 * Per-site CSS is NOT stored here: it belongs to window.SiteStyles, which
 * keeps its own localStorage key and pushes changes into open tabs itself.
 * This panel only draws it, and only when that module is present.
 *
 * Missing keys fall back to DEFAULTS, so an older stored object still reads.
 * `chips: null` means "never touched" — the new tab page shows its own list
 * until the first edit, which seeds from window.DEFAULT_CHIPS.
 *
 * Owned ids/classes (nothing else in the app may touch them):
 *   #settings (the nav button), #settings-panel (the popover, a direct child
 *   of <body> so it stacks over #views), #settings-toast, and every .set-*
 *   class inside them.
 *
 * MOTION. The chrome sits on a backdrop-filter, so every animated frame
 * re-blurs the pane behind it. Nothing here animates continuously: the toast
 * steps in and out in four frames and then holds still.
 */

(function () {
  /* --- Segoe Fluent Icons ------------------------------------- */
  var GLYPH_GEAR = '\uE713';
  var GLYPH_ADD = '\uE710';
  var GLYPH_DELETE = '\uE74D';
  var GLYPH_UP = '\uE70E';
  var GLYPH_DOWN = '\uE70D';
  var GLYPH_CLOSE = '\uE711';
  var GLYPH_CHECK = '\uE73E';
  var GLYPH_SEARCH = '\uE721';
  var GLYPH_BACK = '\uE72B';

  /* The sheet's nav: one Segoe Fluent glyph per section, keyed by the
     heading it names (the heading stays the one source of the name). A
     section with no entry here still gets a row, with the gear. */
  var NAV_GLYPHS = {
    'Look': '\uE790',                     // Color: the palette
    'Claude': '\uE756',                   // CommandPrompt, as on a Claude tab
    'Tabs': '\uE7C4',                     // TaskView: stacked windows
    'Downloads': '\uE896',
    'Search': '\uE721',
    'Typing': '\uE8D2',                   // Font
    'Websites': '\uE774',                 // Globe
    'Protected video': '\uE714',          // Video
    'Site styles and scripts': '\uE943',  // Code
    'Browser style': '\uE771',            // Personalize: the brush
    'New tab': '\uECA5',                  // Tiles
    'Home': '\uE80F',
    'Idle music': '\uE8D6',               // Audio
    'Privacy': '\uE72E',                  // Lock
    'Spotify': '\uE7F6',                  // Headphone
    'Stocks': '\uEAFC',                   // Market
    'Lumen': '\uE7F4',                    // TVMonitor
    'Phone': '\uE8EA',                    // CellPhone
    'Notes pane': '\uE70B',               // QuickNote
    'Shortcuts': '\uE765',                // KeyboardClassic
    'About': '\uE946'                     // Info
  };
  /* A section that is one of Quartz's own products shows its mark instead. */
  var NAV_MARKS = {
    'Lumen': 'assets/lumen-logo-small.svg'
  };

  var STORAGE_KEY = 'settings';
  /* theme-boot.js reads this one, before anything else runs. */
  var PALETTE_KEY = 'palette';

  var DEFAULTS = {
    searchEngine: 'google',
    siteTheme: 'system',
    palette: 'aurora',
    accentHue: null,
    chips: null,
    /* Where the new tab's five shortcuts come from. 'visited' — the default —
       lets the page count your own history and show the sites you actually
       open; 'list' pins the `chips` list above, in that order. A stored file
       without the key is a file from before the choice existed, and those
       shortcuts should start following the history too, so the default is
       the counted one rather than the list. */
    chipsSource: 'visited',
    /* The address bar's search keywords ("gh helm" searches GitHub). null
       means "never touched" and reads as keywords.js's built-in list, the
       same convention as `chips`; an array is the user's own list. A row
       that fails keywords.js's check() is stored with disabled:true, and the
       editor prints why beside it. */
    keywords: null,
    /* The bookmarks bar under the nav row: the chips below, on every page.
       bookmarks.js owns the bar; this is the only place its visibility lives. */
    bookmarksBar: false,
    homepage: 'newtab',
    claudeDir: null,
    claudeResume: true,
    /* true: every Claude pane starts with --dangerously-skip-permissions, so
       Claude runs tools without asking. OFF by default: a new profile gets
       Claude Code's own permission prompts until the user turns this on.
       Profiles from before this default changed were migrated to an explicit
       true (migrateClaudeSkip), so they keep working the way they did. */
    claudeSkipPermissions: false,
    /* A quiet Windows notification when a background Claude pane stops working
       and waits on an answer. The chip's amber mark is not optional; this is. */
    claudeNotify: true,
    /* Claude panes start with Quartz's read-only tab tools (list tabs, read a
       page, search history and notes, highlight a quote; mcp-main.js). Every
       call shows a line over the pane. Off: panes start without them and say so. */
    claudeReadTabs: true,
    tabSleepMinutes: 30,
    /* Workspace sleep. Every preset workspace opens on a new tab page, and a
       new tab page paints a moving background: six of them decode 60 fps each
       into the one GPU process whether or not their view is hidden. 'newtab'
       (the default) puts those pages down the moment you leave the workspace
       they are in — they come back identical, so nothing is lost. 'all' also
       sleeps real pages once a workspace has gone unlooked-at for
       workspaceSleepMinutes, which costs them their scroll and their forms.
       app.js reads both through Settings.get(); there is no IPC either way. */
    workspaceSleep: 'newtab',
    workspaceSleepMinutes: 10,
    /* Downloads: off means a file goes straight to the Downloads folder with
       no prompt, which is what every browser does. downloads.js pushes this
       to main, which is the only process that can act on it. */
    downloadsAskWhere: false,
    /* THE Quartz background: what sits behind the whole window (backdrop.js
       blurs it once and the tab strip, toolbar and panes are tints over it)
       AND what the new tab shows. The key keeps its old name so stored
       prefs survive.
         { kind: 'desktop', dim }          THE DEFAULT ("Same as desktop"):
                                           the still Mantle publishes through
                                           Look Sync, drawn lined up with the
                                           screen. When Mantle has not shared
                                           one, Windows' wallpaper copy (main
                                           copies it into
                                           <userData>/backgrounds/), reason said
         -- "Own picture" kinds (the last one is kept in ownBackground) --
         { kind: 'builtin', id, dim }      one of Helm's photos, shipped in
                                           assets/backgrounds/ (id = the file
                                           name without extension, 'forest').
                                           An id this build does not have
                                           shows the wallpaper, reason said
         { kind: 'image', dim, imageRev }  the user's own picture
         { kind: 'video', fileUrl, fileName, clipRev, dim }
                                           a muted moving loop or GIF; the
                                           new tab plays it, the chrome shows
                                           one blurred still of it
         { kind: 'none' }                  plain: no picture at all
       Older builds stored 'wallpaper' (a copy of the Windows wallpaper),
       'board' (the circuit board) or 'aurora'; all three read as 'desktop'
       now. The picture itself is NOT in here — see the asset store below.
       The clip is not either: main copies it into <userData>/backgrounds/
       and only its file:// URL is stored. */
    newtabBackground: { kind: 'desktop' },
    /* The last "Own picture" descriptor (builtin/image/video/none, no rev),
       or null. Choosing "Own picture" again restores it; null restores the
       built-in snow-peak. Written by every own choice (setBackground). */
    ownBackground: null,
    /* 1 once the one-time move to 'desktop' has run (migrateBackground):
       a later "Own picture" choice is never migrated again. */
    bgMigration: 0,
    /* 1 once the one-time skip-permissions check has run (migrateClaudeSkip):
       an existing profile that never set claudeSkipPermissions got an
       explicit true, a new profile got nothing. It never runs again. */
    claudeSkipMigration: 0,
    /* Look Sync (looksync.js): ON, Quartz reads and writes the theme, the
       accent and the glass shared with Helm and Mantle through
       %APPDATA%\look-sync\look.json; OFF, it keeps its own. The background
       mode is always per app either way. */
    lookSync: true,
    /* The glass over the background, per theme: blurPx 0..64 (integer),
       dim 0.20..0.90, panel -0.30..+0.15 (added to the surfaces' alpha),
       and an optional dimAuto (absent = true): automatic raises the wash
       over a bright picture, false uses exactly dim. The picture is painted
       sharp whatever blurPx says (Mantle's guard and surfaces still use it).
       backdrop.js reads the effective value through LookSync.glassFor(theme). */
    glass: {
      dark: { blurPx: 0, dim: 0.3, panel: 0 },
      light: { blurPx: 0, dim: 0.3, panel: 0 },
      render: 'picture'
    },
    /* The apps pinned to the new tab page's dock: apps.js ids, webapps.js
       'web:<slug>' ids and 'term:<program>' ids — names, icons and running
       state are NOT stored, they are looked up against the installed index
       every time. `{ pins: [] }` is the whole of it for now; the object
       leaves room for the rest of the group later. There is no UI for this
       in the pane: the page manages its own dock. */
    apps: { pins: [] },
    /* The new tab Home's layout: which of its pieces show, and in which of
       the three columns, in what order. null means THE default (today's
       arrangement), and a layout equal to the default is stored as null
       again — so a reset follows whatever a later build's default becomes
       rather than freezing this build's. homelayout.js owns the shape and
       the rules; homeLayout() below always answers a complete layout. */
    homeLayout: null,
    /* Quiet lobby music while nothing else is making a sound. The tracks are
       referenced, never copied: only a path and the name a row shows. See the
       Idle music block below for what each key means. */
    music: {
      enabled: false,
      source: 'ambient',
      where: 'newtab',
      volume: 0.35,
      files: [],
      shuffle: true
    }
  };

  /* A dock is a shortlist. Anything past this is dropped on the way in. */
  var APP_PINS_MAX = 32;
  /* An id is a hash from apps.js; anything longer is not one. */
  var APP_ID_MAX = 200;

  /* Every kind the descriptor can hold. The first is THE default: "Same as
     desktop", which follows Mantle's desktop wallpaper (Look Sync). */
  var BG_KINDS = ['desktop', 'builtin', 'image', 'video', 'none'];
  var BG_DEFAULT_KIND = BG_KINDS[0];
  /* The "Own picture" kinds, as the select offers them (the Windows-wallpaper
     option is gone: 'desktop' replaced it). The first is what the select
     shows for a value it does not know. */
  var NEWTAB_BACKGROUNDS = [
    { value: 'builtin', name: 'Built-in photo' },
    { value: 'image', name: 'Your image' },
    { value: 'video', name: 'Moving picture (video or GIF)' },
    { value: 'none', name: 'Plain (no picture)' }
  ];
  var OWN_KINDS = NEWTAB_BACKGROUNDS.map(function (b) { return b.value; });
  /* "Own picture" with nothing kept from before starts here. */
  var OWN_DEFAULT = { kind: 'builtin', id: 'snow-peak' };
  /* Kinds older builds stored, and what they read as now. The circuit board
     and the aurora are gone, and the Windows-wallpaper copy is what
     'desktop' falls back to, so all three follow the desktop now. */
  var LEGACY_BACKGROUNDS = { wallpaper: 'desktop', board: 'desktop', aurora: 'desktop' };

  /* Look Sync's glass ranges (quartz-lane-contract.md, "Settings keys"). */
  var GLASS_RANGE = {
    blurPx: [0, 64],
    dim: [0.2, 0.9],
    panel: [-0.3, 0.15]
  };

  /* The picture: never bigger than this on its long edge, always re-encoded
     as a JPEG, and always behind this much black so the capsule stays legible. */
  var BG_MAX_EDGE = 2560;
  var BG_JPEG_QUALITY = 0.86;
  var BG_DIM_DEFAULT = 0.25;
  var BG_DIM_MAX = 0.6;
  /* A built-in photo's id: its file name without the extension. */
  var BUILTIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
  var BG_REJECT = 'Pick a JPG, PNG or WebP';

  /* IndexedDB, in this renderer: db 'browser', store 'assets', one key. */
  var ASSET_DB = 'browser';
  var ASSET_STORE = 'assets';
  var BG_ASSET_KEY = 'newtab-bg';

  var ENGINES = [
    { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=' },
    { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
    { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=' },
    { id: 'brave', name: 'Brave', url: 'https://search.brave.com/search?q=' },
    { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/do/search?q=' },
    /* Quartz's OWN results page (search.html), fed by the Brave Search API
       through main (bravesearch.js). `own` routes searchUrl() there; `url`
       is the plain Brave site, which the page offers when the API cannot
       answer (no key, a bad key, the limit, offline). */
    { id: 'brave-api', name: 'Quartz results (Brave)', url: 'https://search.brave.com/search?q=', own: true }
  ];

  /* search.html sits next to index.html, which is the document this runs in. */
  var SEARCH_PAGE_URL = (function () {
    try { return new URL('search.html', window.location.href).href; } catch (err) { return ''; }
  })();

  /* The palettes chrome.css authors. 'aurora' is the file's own :root, so it
     is the one id that must never reach the attribute — the swatch for it
     carries no data-palette either, and so previews the root's tokens. */
  var PALETTES = [
    { id: 'aurora', name: 'Aurora' },
    { id: 'ember', name: 'Ember' },
    { id: 'forest', name: 'Forest' },
    { id: 'ocean', name: 'Ocean' },
    { id: 'midnight', name: 'Midnight' },
    { id: 'mono', name: 'Mono' }
  ];

  /* The two ways the new tab can fill its five shortcuts. Ids, not labels:
     app.js reads the id, the segmented control draws the name. */
  var CHIP_SOURCES = [
    { id: 'visited', name: 'Most visited' },
    { id: 'list', name: 'My list' }
  ];

  var CHIP_SOURCE_HINTS = {
    visited: 'The five sites you open most, from your history.',
    list: 'The sites below, in this order.'
  };

  var SITE_THEMES = [
    { id: 'system', name: 'Follow Windows' },
    { id: 'light', name: 'Always light' },
    { id: 'dark', name: 'Always dark' }
  ];

  /* How long a background tab may sit untouched before app.js puts it to
     sleep. Values are minutes; 0 is the off switch, not a zero timer. */
  var SLEEP_TIMES = [
    { value: 0, name: 'Never' },
    { value: 15, name: '15 minutes' },
    { value: 30, name: '30 minutes' },
    { value: 60, name: '1 hour' },
    { value: 180, name: '3 hours' }
  ];

  /* Workspace sleep: what may go to sleep in a workspace you have left. */
  var WORKSPACE_SLEEP = [
    { id: 'newtab', name: 'New tab pages' },
    { id: 'all', name: 'Every page' },
    { id: 'off', name: 'Off' }
  ];

  /* ...and, for 'Every page', how long a workspace goes unlooked-at first. */
  var WORKSPACE_AWAY_TIMES = [
    { value: 0, name: 'Straight away' },
    { value: 5, name: '5 minutes' },
    { value: 10, name: '10 minutes' },
    { value: 30, name: '30 minutes' },
    { value: 60, name: '1 hour' }
  ];

  /* The keyboard map, as the user would describe it to themselves. */
  var SHORTCUTS = [
    ['Ctrl+T', 'New tab'],
    ['Ctrl+W', 'Close tab'],
    ['Ctrl+Shift+T', 'Reopen the last tab'],
    ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next tab, previous tab'],
    ['Ctrl+1-9', 'Jump to a tab'],
    ['Ctrl+Alt+1-9', 'Jump to a workspace'],
    ['Ctrl+L', 'Address bar'],
    ['Ctrl+F', 'Find on page'],
    ['Ctrl+Shift+R', 'Reader view'],
    ['Ctrl+Shift+A', 'Search tabs'],
    ['Ctrl+\\', 'Split view with the next tab'],
    ['Ctrl+P', 'Print page'],
    ['Ctrl+J', 'Downloads'],
    ['Ctrl+H', 'History'],
    ['Ctrl+D', 'Add this page to your new tab'],
    ['Ctrl+Shift+B', 'Bookmarks bar'],
    ['Ctrl+,', 'Settings'],
    ['Ctrl+= / Ctrl+- / Ctrl+0', 'Zoom in, out, reset'],
    ['F5', 'Reload'],
    ['F11', 'Fullscreen'],
    ['F12', 'Developer tools'],
    ['Alt+Left / Alt+Right', 'Back, forward']
  ];

  /* The accent formula: Helm's accent strength with the user's hue,
       dark  -> hsl(H 31% 71%)    light -> hsl(H 26% 41%)
     the saturation and lightness of Helm's own steel blue (tokens.css:
     #9fb4cc / #4d6784), so a custom hue sits at the same quiet strength
     as the default and every palette preset. The derived tokens are that
     hue at the alphas tokens.css authors for each theme. The new tab
     page's newtab-theme.js has to run this same formula. */
  var ACCENT_SL = { dark: [31, 71], light: [26, 41] };
  var ACCENT_TOKENS = [
    ['--ion', null],
    ['--ion-soft', 0.14, 0.11],
    ['--ion-glow', 0.22, 0.22],
    ['--ion-line', 0.42, 0.40],
    ['--ion-select', 0.32, 0.2],
    ['--seam-color', 0.14, 0.14],
    ['--chamber-seam', 0.16, 0.16]
  ];                            /* [token, dark alpha, light alpha] */

  /* --- state ---------------------------------------------------- */
  var state = null;            // the stored object, defaults NOT merged
  var listeners = [];
  var panelEl = null;
  var buttonEl = null;
  var bodyEl = null;
  var open_ = false;
  /* The sheet: a nav of sections on the left, one section on the right. */
  var scrimEl = null;          // the soft scrim over the page while open
  var navEl = null;            // the list of sections
  var titleEl = null;          // the right pane's heading
  var currentEl = null;        // the section on show
  var lastSection = '';        // reopened where it was left, this run only
  var toastEl = null;
  var toastTimer = 0;
  var toastHideTimer = 0;

  /* Shortcut editing: one row records at a time. recPending is the combo
     already held by another action, waiting for the second press that takes
     it; recUnbound is the action that press displaced, noted for one render. */
  var recId = null;
  var recPending = '';
  var recNote = '';
  var recUnbound = null;

  /* Sections are still built as folds (About is a plain heading), but the
     sheet holds every fold open: its nav picks the one section on show, which
     is what the folds were for in the old single-column popover (the user asked: "make
     it so that all the different sections in settings are auto collapsed").
     The filter still forces folds by its hits and hands them back after. */
  var foldSeq = 0;                 // ids that pair a header with its body
  var foldsForced = false;         // held open by a filter, not by the reader
  var shortcutsSectionEl = null;   // the one fold with a side effect
  var resetAllArmed = false;
  var resetAllTimer = 0;
  var focusHint = null;        // [selector] to refocus after a chips re-render
  var siteOpen = null;         // the host whose CSS editor is expanded
  var siteFocus = null;        // [selector] to focus after a site-styles render
  var siteBound = false;       // subscribed to SiteStyles.on exactly once

  /* ============================================================
     Store
     ============================================================ */

  function load() {
    if (state) return state;
    state = {};
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') state = parsed;
      }
    } catch (err) { /* blocked or corrupt: this run runs on defaults */ }
    return state;
  }

  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) { /* storage blocked — the values still hold for this run */ }
  }

  /**
   * The keys whose values are always read (and stored) in range. Look Sync
   * writes three of them from the other apps' values, so a wrong type or an
   * out-of-range number from anywhere lands as the nearest valid value.
   */
  function normalizeKey(key, value) {
    switch (key) {
      case 'glass': return normalizeGlass(value);
      case 'lookSync': return value !== false;
      case 'ownBackground': return normalizeOwnBackground(value);
      case 'accentHue': return normalizeHue(value);
      case 'bgMigration': return value === 1 ? 1 : 0;
      case 'claudeSkipMigration': return value === 1 ? 1 : 0;
      /* Only an explicit true skips the prompts; anything else asks. */
      case 'claudeSkipPermissions': return value === true;
      /* Only an explicit false turns the tab tools off. */
      case 'claudeReadTabs': return value !== false;
      default: return value;
    }
  }

  function all() {
    var s = load();
    var out = {};
    for (var k in DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) continue;
      out[k] = normalizeKey(k, Object.prototype.hasOwnProperty.call(s, k) && s[k] !== undefined
        ? s[k] : DEFAULTS[k]);
    }
    return out;
  }

  function get(key) {
    return all()[key];
  }

  function emit(keys) {
    var snapshot = all();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](snapshot, keys); } catch (err) { /* one bad listener */ }
    }
  }

  function set(patch) {
    if (!patch || typeof patch !== 'object') return all();
    var s = load();
    var changed = [];
    for (var k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      var next = Object.prototype.hasOwnProperty.call(DEFAULTS, k) ? normalizeKey(k, patch[k]) : patch[k];
      if (JSON.stringify(s[k]) === JSON.stringify(next)) continue;
      s[k] = next;
      changed.push(k);
    }
    if (!changed.length) return all();
    save();
    react(changed);
    emit(changed);
    return all();
  }

  function reset() {
    /* The skip-permissions marker survives a reset: without it the next
       boot would see a used profile with the key unset and turn skipping
       back ON, which is the opposite of "defaults". */
    state = { claudeSkipMigration: 1 };
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (err) { /* fine */ }
    var keys = Object.keys(DEFAULTS);
    react(keys);
    emit(keys);
  }

  function on(cb) {
    if (typeof cb !== 'function') return function () {};
    listeners.push(cb);
    return function off() {
      var i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /** Side effects a changed key owes the rest of the app. */
  function react(keys) {
    if (keys.indexOf('palette') >= 0) applyPalette(get('palette'));
    if (keys.indexOf('accentHue') >= 0) applyAccent(get('accentHue'));
    if (keys.indexOf('siteTheme') >= 0) pushSiteTheme(get('siteTheme'));
    /* The player is not in this file: it hears about the group either from
       the listener list or from this event, whichever it subscribed to. */
    if (keys.indexOf('music') >= 0) announceMusic();
  }

  /* ============================================================
     The background (the whole window's, and the new tab's)

     The choice lives in the settings JSON; the picture does not. A 2560px
     JPEG as base64 is around a megabyte of string, and localStorage would
     have to rewrite all of it on every unrelated settings write — so the
     blob goes in IndexedDB and only the tiny descriptor is stored here.

     Two readers: backdrop.js (the blurred layer behind the chrome) reads
     backgroundConfig() and the asset store directly; app.js reads
     Settings.background(), which resolves { kind, dim, url?, fileName?, ... }
     for the new tab guest.
     ============================================================ */

  /** Anything stored (or pushed) read as a complete, in-range descriptor. */
  function normalizeBackground(value) {
    var v = value && typeof value === 'object' ? value : {};
    var asked = backgroundKindOf(v.kind);
    var kind = asked || BG_DEFAULT_KIND;
    var dim = (v.dim === null || v.dim === undefined || v.dim === '')
      ? BG_DIM_DEFAULT : Number(v.dim);
    if (!isFinite(dim)) dim = BG_DIM_DEFAULT;
    dim = Math.min(BG_DIM_MAX, Math.max(0, dim));
    var out = { kind: kind, dim: dim };
    /* The clip's file:// URL and its original name ride along whatever the
       kind is, so switching to the wallpaper and back does not lose the pick. */
    if (typeof v.fileUrl === 'string' && v.fileUrl) out.fileUrl = v.fileUrl;
    if (typeof v.fileName === 'string' && v.fileName) out.fileName = v.fileName;
    /* The built-in photo's id rides along the same way. Only its shape is
       checked here (sync, no catalog): whether the build HAS that photo is
       backdrop.js's question, and an unknown one is said, never dropped. */
    if (typeof v.id === 'string' && BUILTIN_ID.test(v.id)) out.id = v.id;
    /* Source stamps (see the header): backdrop.js keys its re-blur and the
       clip's cached still on these, not on `rev`, which a dim change bumps. */
    if (isFinite(v.clipRev) && v.clipRev > 0) out.clipRev = Number(v.clipRev);
    if (isFinite(v.imageRev) && v.imageRev > 0) out.imageRev = Number(v.imageRev);
    return out;
  }

  /** A stored kind as it reads today ('wallpaper' -> 'desktop'), or null. */
  function backgroundKindOf(kind) {
    var asked = Object.prototype.hasOwnProperty.call(LEGACY_BACKGROUNDS, kind)
      ? LEGACY_BACKGROUNDS[kind] : kind;
    return BG_KINDS.indexOf(asked) >= 0 ? asked : null;
  }

  /** True for the "Own picture" kinds (builtin, image, video, none). */
  function isOwnKind(kind) {
    return OWN_KINDS.indexOf(kind) >= 0;
  }

  /**
   * ownBackground as it may be stored: an own descriptor (normalised, no
   * rev) or null. A 'desktop' (or legacy wallpaper) value is not an own
   * choice, so it reads as null: "Own picture" then starts on snow-peak.
   */
  function normalizeOwnBackground(value) {
    if (!value || typeof value !== 'object') return null;
    if (!isOwnKind(backgroundKindOf(value.kind))) return null;
    return normalizeBackground(value);
  }

  /** null, or an integer hue 0..360 (the shared store rejects non-integers). */
  function normalizeHue(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    if (!isFinite(n)) return null;
    return Math.min(360, Math.max(0, Math.round(n)));
  }

  /** One glass number, clamped to its range; integer for blur, 2 decimals else. */
  function glassNumber(raw, range, fallback, integer) {
    var n = (raw === null || raw === undefined || raw === '') ? NaN : Number(raw);
    if (!isFinite(n)) n = fallback;
    n = Math.min(range[1], Math.max(range[0], n));
    n = integer ? Math.round(n) : Math.round(n * 100) / 100;
    return n || 0;                       // never -0
  }

  /**
   * The glass group, complete and in range, whatever was stored or pushed.
   * A missing theme or field takes the default's value (LS.SEED).
   */
  function normalizeGlass(value) {
    var v = value && typeof value === 'object' ? value : {};
    var out = {};
    ['dark', 'light'].forEach(function (theme) {
      var t = v[theme] && typeof v[theme] === 'object' ? v[theme] : {};
      var d = DEFAULTS.glass[theme];
      out[theme] = {
        blurPx: glassNumber(t.blurPx, GLASS_RANGE.blurPx, d.blurPx, true),
        dim: glassNumber(t.dim, GLASS_RANGE.dim, d.dim, false),
        panel: glassNumber(t.panel, GLASS_RANGE.panel, d.panel, false)
      };
      /* Automatic or manual Dim, shared with Helm and Mantle: kept when it
         is a real boolean, so a write from here never erases another app's
         Manual choice; anything else is dropped (absent = automatic). */
      if (typeof t.dimAuto === 'boolean') out[theme].dimAuto = t.dimAuto;
    });
    /* 'picture' is the only render the user chose; a short id from a newer app
       is kept rather than dropped, so syncing never erases it. */
    out.render = (typeof v.render === 'string' && /^[a-z][a-z-]{0,23}$/.test(v.render))
      ? v.render : DEFAULTS.glass.render;
    return out;
  }

  /** The glass group as it stands (normalised). */
  function glass() {
    return normalizeGlass(get('glass'));
  }

  /** The descriptor as it stands, normalised (sync; backdrop.js reads this). */
  function backgroundConfig() {
    return normalizeBackground(get('newtabBackground'));
  }

  /**
   * THE one-time migration to "Same as desktop", as a pure function of the
   * stored object (test seam: Settings._migrateBackground). Returns the
   * patch to store, or null when it already ran (bgMigration === 1).
   *   - an own kind (builtin/image/video/none) is kept as ownBackground, so
   *     "Own picture" brings it back;
   *   - 'wallpaper' / 'board' / 'aurora' / nothing keep no own pick (an
   *     ownBackground already stored is left alone);
   *   - newtabBackground becomes { kind: 'desktop', dim: <old dim>, rev };
   *   - bgMigration = 1, so a later "Own picture" choice is never migrated.
   */
  function migrateBackgroundState(stored, now) {
    var s = stored && typeof stored === 'object' ? stored : {};
    if (s.bgMigration === 1) return null;
    var raw = s.newtabBackground;
    var patch = { bgMigration: 1 };
    var own = normalizeOwnBackground(raw);
    if (own) patch.ownBackground = own;
    var old = normalizeBackground(raw);
    var stamp = isFinite(now) ? Number(now) : 0;
    if (raw && typeof raw === 'object' && isFinite(raw.rev) && raw.rev >= stamp) stamp = Number(raw.rev) + 1;
    patch.newtabBackground = { kind: 'desktop', dim: old.dim, rev: stamp };
    return patch;
  }

  /**
   * THE one-time skip-permissions check, as a pure function (test seam:
   * Settings._migrateClaudeSkip). claudeSkipPermissions used to default to
   * ON and now defaults to OFF; this keeps every profile that already
   * existed on the behaviour it had. Returns the patch to store, or null
   * when it already ran (claudeSkipMigration === 1).
   *   - stored: the settings object as it was read from localStorage, BEFORE
   *     anything in this load wrote to it;
   *   - hadSession: whether localStorage already held a saved tab session.
   * The profile counts as existing when the stored object has any key, or a
   * session was saved. Every build since the background migration writes
   * bgMigration on its first load, so any profile that has run Quartz since
   * then has a non-empty object; the session key covers an older profile
   * that never touched a setting but did open a tab. A brand-new profile has
   * neither on its first load, because this runs before anything writes.
   *   - existing, and claudeSkipPermissions is not a boolean (never set):
   *     write true, the old default;
   *   - existing with an explicit true or false: untouched;
   *   - new: only the marker, so the new default (off) holds.
   */
  function migrateClaudeSkipState(stored, hadSession) {
    var s = stored && typeof stored === 'object' ? stored : {};
    if (s.claudeSkipMigration === 1) return null;
    var patch = { claudeSkipMigration: 1 };
    var existing = Object.keys(s).length > 0 || hadSession === true;
    if (existing && typeof s.claudeSkipPermissions !== 'boolean') patch.claudeSkipPermissions = true;
    return patch;
  }

  /** Runs at load, before migrateBackground (which writes even on a new profile). */
  function migrateClaudeSkip() {
    var hadSession = false;
    try { hadSession = window.localStorage.getItem('session') !== null; } catch (err) { /* blocked: no evidence */ }
    var patch = migrateClaudeSkipState(load(), hadSession);
    if (patch) set(patch);
  }

  /* Set when the migration ran in THIS load: { ownKept: kind | null }.
     boot() says it once in a toast, so the switch is never silent. */
  var migrationRan = null;

  /** Runs at load, before app.js builds the first new tab from the key. */
  function migrateBackground() {
    var patch = migrateBackgroundState(load(), Date.now());
    if (!patch) return;
    var had = load().newtabBackground;
    migrationRan = {
      ownKept: patch.ownBackground ? patch.ownBackground.kind : null,
      /* A fresh profile had nothing to move, so there is nothing to say. */
      tell: !!(had && typeof had === 'object' && had.kind !== 'desktop')
    };
    set(patch);
  }

  /**
   * "Same as desktop" ('desktop') or "Own picture" ('own'). Own restores the
   * last own choice (ownBackground), or the built-in snow-peak when there
   * is none; the Dim stays what it is, it is one Quartz-local value.
   */
  function setBackgroundMode(mode) {
    if (mode === 'desktop') return setBackground({ kind: 'desktop' });
    var own = normalizeOwnBackground(get('ownBackground')) || OWN_DEFAULT;
    var patch = { kind: own.kind };
    if (own.id) patch.id = own.id;
    if (own.kind === 'video') {
      patch.fileUrl = own.fileUrl || null;
      patch.fileName = own.fileName || null;
    }
    if (own.clipRev) patch.clipRev = own.clipRev;
    if (own.imageRev) patch.imageRev = own.imageRev;
    return setBackground(patch);
  }

  /** 'desktop' or 'own', for the mode choice. */
  function backgroundMode() {
    return backgroundConfig().kind === 'desktop' ? 'desktop' : 'own';
  }

  /**
   * Write part of the descriptor back.
   *
   * Every write carries a fresh `rev`. The picture is not in this object, so
   * replacing or removing it would otherwise leave the JSON byte-identical
   * and set() — which skips unchanged keys — would never tell app.js to push
   * the new one. The stamp makes every change a change.
   */
  function setBackground(patch) {
    var next = normalizeBackground(get('newtabBackground'));
    if (patch && typeof patch === 'object') {
      if (patch.kind !== undefined) next.kind = normalizeBackground({ kind: patch.kind }).kind;
      if (patch.dim !== undefined) next.dim = normalizeBackground({ dim: patch.dim }).dim;
      if (patch.clipRev !== undefined) next.clipRev = Number(patch.clipRev) || 0;
      if (patch.imageRev !== undefined) next.imageRev = Number(patch.imageRev) || 0;
      if (patch.id !== undefined) {
        if (typeof patch.id === 'string' && BUILTIN_ID.test(patch.id)) next.id = patch.id;
        else delete next.id;
      }
      /* null (or '') clears the clip; a string replaces it. */
      if (patch.fileUrl !== undefined) {
        if (typeof patch.fileUrl === 'string' && patch.fileUrl) next.fileUrl = patch.fileUrl;
        else delete next.fileUrl;
      }
      if (patch.fileName !== undefined) {
        if (typeof patch.fileName === 'string' && patch.fileName) next.fileName = patch.fileName;
        else delete next.fileName;
      }
    }
    var prev = get('newtabBackground');
    var stamp = Date.now();
    if (prev && typeof prev === 'object' && prev.rev >= stamp) stamp = prev.rev + 1;
    next.rev = stamp;
    /* Any own choice (builtin/image/video/none, its Dim included) is also
       THE own choice "Own picture" restores later. One set(), one emit. */
    var out = { newtabBackground: next };
    if (isOwnKind(next.kind)) out.ownBackground = normalizeOwnBackground(next);
    set(out);
    return next;
  }

  /* --- the asset store ------------------------------------------
     Opened without a version first, so a store some later feature added to
     the same db is never clobbered: only a missing 'assets' upgrades, and
     only to version + 1. Every call closes the connection it opened, so a
     later upgrade is never blocked by this one. */

  function assetOpen() {
    return new Promise(function (resolve, reject) {
      var idb = window.indexedDB;
      if (!idb) { reject(new Error('No IndexedDB')); return; }
      var probe;
      try { probe = idb.open(ASSET_DB); } catch (err) { reject(err); return; }
      probe.onerror = function () { reject(probe.error || new Error('open failed')); };
      probe.onsuccess = function () {
        var db = probe.result;
        if (db.objectStoreNames && db.objectStoreNames.contains(ASSET_STORE)) {
          resolve(db);
          return;
        }
        var version = (db.version || 1) + 1;
        db.close();
        var up = idb.open(ASSET_DB, version);
        up.onupgradeneeded = function () {
          var fresh = up.result;
          if (!fresh.objectStoreNames.contains(ASSET_STORE)) fresh.createObjectStore(ASSET_STORE);
        };
        up.onsuccess = function () { resolve(up.result); };
        up.onerror = function () { reject(up.error || new Error('upgrade failed')); };
      };
    });
  }

  function assetRun(mode, run) {
    return assetOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(ASSET_STORE, mode);
        var req = run(tx.objectStore(ASSET_STORE));
        tx.oncomplete = function () { db.close(); resolve(req ? req.result : undefined); };
        tx.onerror = function () { db.close(); reject(tx.error || new Error('transaction failed')); };
        tx.onabort = tx.onerror;
      });
    });
  }

  var assetStore = {
    get: function (key) { return assetRun('readonly', function (s) { return s.get(key); }); },
    put: function (key, blob) { return assetRun('readwrite', function (s) { return s.put(blob, key); }); },
    'delete': function (key) { return assetRun('readwrite', function (s) { return s['delete'](key); }); }
  };

  /* --- the picture ---------------------------------------------- */

  var bgDataUrl = null;        // the data: URL app.js hands the guest
  var bgPreviewBlob = null;    // the blob the panel's thumbnail is made of
  var bgPreviewUrl = null;
  var bgPreviewLoaded = false;

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var FR = window.FileReader;
      if (!FR) { reject(new Error('No FileReader')); return; }
      var reader = new FR();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(reader.error || new Error('read failed')); };
      reader.readAsDataURL(blob);
    });
  }

  /**
   * A picked file, down to 2560px on its long edge and re-encoded as a JPEG.
   * GIF and SVG are refused rather than flattened: one would lose its motion
   * and the other is markup, not pixels.
   */
  function downscaleImage(file) {
    var type = String((file && file.type) || '').toLowerCase();
    if (type === 'image/gif' || type === 'image/svg+xml') return Promise.reject(new Error(BG_REJECT));
    if (type.indexOf('image/') !== 0) return Promise.reject(new Error(BG_REJECT));
    if (typeof window.createImageBitmap !== 'function') return Promise.reject(new Error(BG_REJECT));

    return window.createImageBitmap(file).then(function (bitmap) {
      var longest = Math.max(bitmap.width, bitmap.height) || 1;
      var scale = longest > BG_MAX_EDGE ? BG_MAX_EDGE / longest : 1;
      var w = Math.max(1, Math.round(bitmap.width * scale));
      var h = Math.max(1, Math.round(bitmap.height * scale));

      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, w, h);
      if (typeof bitmap.close === 'function') bitmap.close();

      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error(BG_REJECT));
        }, 'image/jpeg', BG_JPEG_QUALITY);
      });
    });
  }

  function revokePreview() {
    if (bgPreviewUrl && window.URL && window.URL.revokeObjectURL) {
      try { window.URL.revokeObjectURL(bgPreviewUrl); } catch (err) { /* fine */ }
    }
    bgPreviewUrl = null;
  }

  function previewUrl() {
    if (!bgPreviewBlob) return null;
    if (bgPreviewUrl) return bgPreviewUrl;
    if (!window.URL || !window.URL.createObjectURL) return null;
    try { bgPreviewUrl = window.URL.createObjectURL(bgPreviewBlob); }
    catch (err) { bgPreviewUrl = null; }
    return bgPreviewUrl;
  }

  /** One read of the stored blob per run, then the thumbnail redraws itself. */
  function loadPreview() {
    if (bgPreviewLoaded) return;
    bgPreviewLoaded = true;
    assetStore.get(BG_ASSET_KEY).then(function (blob) {
      if (!blob) return;
      bgPreviewBlob = blob;
      renderNewtabBg();
    }).catch(function () { /* no db: the panel just offers the picker */ });
  }

  /**
   * What the toast says when a picked picture can't become the background: what happened and
   * why, in plain words. Never the raw error text (that goes to quartz.log). BG_REJECT (the
   * wrong kind of file) is already plain and stays as it is.
   */
  function bgFailureWords(err) {
    if (err && err.message === BG_REJECT) return BG_REJECT;
    var name = String((err && err.name) || '');
    var step = err && err.bgStep;
    if (name === 'QuotaExceededError') {
      return 'Couldn’t save that picture: the disk is too full for Quartz to keep it. The background was not changed.';
    }
    if (step === 'read') {
      return 'Couldn’t open that picture: the file looks damaged, or it is in a format Quartz can’t read. ' +
        'The background was not changed. ' + BG_REJECT + '.';
    }
    if (step === 'save') {
      return 'Couldn’t save that picture: Quartz’s picture storage refused it. The background was not changed; ' +
        'the details are in quartz.log.';
    }
    return 'Couldn’t use that picture as the background, so it was not changed. The details are in quartz.log.';
  }

  /** Downscale, store, and switch the new tab over to it. */
  function chooseBackgroundImage(file) {
    // A failure says which step failed (err.bgStep 'read' | 'save') so the toast can say why in
    // plain words; the error itself goes to quartz.log (bgFailureWords).
    var step = function (name) {
      return function (err) {
        var e = err instanceof Error || (err && typeof err === 'object') ? err : new Error(String(err));
        try { if (!e.bgStep) e.bgStep = name; } catch (x) { /* frozen: no step, generic words */ }
        throw e;
      };
    };
    return downscaleImage(file).then(null, step('read')).then(function (blob) {
      return assetStore.put(BG_ASSET_KEY, blob).then(null, step('save')).then(function () {
        bgDataUrl = null;                 // the memo is a different picture now
        revokePreview();
        bgPreviewBlob = blob;
        bgPreviewLoaded = true;
        // imageRev tells backdrop.js this is a different picture to blur.
        setBackground({ kind: 'image', imageRev: Date.now() });
        return blob;
      });
    });
  }

  /**
   * Drop the picture. The kind goes to "Own picture"'s own default (the
   * built-in snow-peak) with it: leaving it on 'image' would leave the
   * window showing a background that isn't there, and the own picker is
   * where he is, so it stays.
   */
  function removeBackgroundImage() {
    return assetStore['delete'](BG_ASSET_KEY).catch(function () { /* already gone */ })
      .then(function () {
        bgDataUrl = null;
        revokePreview();
        bgPreviewBlob = null;
        bgPreviewLoaded = true;
        setBackground({ kind: OWN_DEFAULT.kind, id: OWN_DEFAULT.id, imageRev: Date.now() });
      });
  }

  /* --- the moving picture ---------------------------------------
     A clip cannot live in the settings JSON and should not be re-read into a
     data URL either, so main copies the chosen file into
     <userData>/backgrounds/ and hands back a file:// URL. Everything here is
     guarded: an older preload without api.background must not throw. */

  function bgVideoApi() {
    var api = (typeof window !== 'undefined') ? window.api : null;
    return (api && api.background && typeof api.background.chooseVideo === 'function')
      ? api.background : null;
  }

  /** True when the running preload can pick a clip at all. */
  function canChooseVideo() { return !!bgVideoApi(); }

  /**
   * Open the native picker, copy the clip in, and switch the new tab over.
   * Resolves { ok: true, fileName } or { ok: false, reason }; never rejects,
   * and 'cancelled' is not an error the panel should shout about.
   */
  function chooseBackgroundVideo() {
    var api = bgVideoApi();
    if (!api) return Promise.resolve({ ok: false, reason: 'This window cannot pick a file yet' });
    return Promise.resolve()
      .then(function () { return api.chooseVideo(); })
      .then(function (res) {
        if (!res || res.ok !== true || typeof res.fileUrl !== 'string' || !res.fileUrl) {
          return { ok: false, reason: (res && res.reason) || 'cancelled' };
        }
        // The copy always has the same name (newtab-bg.<ext>), so clipRev is
        // what tells backdrop.js this is a new clip whose still to capture.
        setBackground({ kind: 'video', fileUrl: res.fileUrl, fileName: res.fileName || '', clipRev: Date.now() });
        renderNewtabBg();
        return { ok: true, fileName: res.fileName || '' };
      })
      .catch(function (err) {
        return { ok: false, reason: (err && err.message) || 'That file could not be used' };
      });
  }

  /**
   * Drop the clip. The kind goes to the built-in snow-peak with it,
   * exactly as removing the picture does. Main's clear removes the
   * clip only; the wallpaper copy beside it is never touched (bgfiles.js).
   */
  function removeBackgroundVideo() {
    var api = bgVideoApi();
    var done = (api && typeof api.clearVideo === 'function')
      ? Promise.resolve().then(function () { return api.clearVideo(); }).catch(function () { })
      : Promise.resolve();
    return done.then(function () {
      setBackground({ kind: OWN_DEFAULT.kind, id: OWN_DEFAULT.id, fileUrl: null, fileName: null, clipRev: Date.now() });
      renderNewtabBg();
    });
  }

  /* --- the Windows wallpaper copy --------------------------------
     Main copies %APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper into
     <userData>/backgrounds/wallpaper.<ext> once, the first time anything asks,
     and again only on "Copy again from Windows". Both resolve
     { ok, fileUrl, fileName, copiedAt, reason } and never reject. */

  function wallpaperApi() {
    var api = (typeof window !== 'undefined') ? window.api : null;
    return (api && api.background && typeof api.background.wallpaper === 'function')
      ? api.background : null;
  }

  function wallpaperCopy() {
    var api = wallpaperApi();
    if (!api) return Promise.resolve({ ok: false, reason: 'this window was started before the wallpaper copy existed; restart the browser' });
    return Promise.resolve().then(function () { return api.wallpaper(); })
      .then(function (res) { return res || { ok: false, reason: 'no answer from the browser' }; })
      .catch(function (err) { return { ok: false, reason: (err && err.message) || 'the copy failed' }; });
  }

  /** "Copy again from Windows": through the layer when it is there, so it re-blurs. */
  function recopyWallpaper() {
    var layer = window.Backdrop;
    if (layer && typeof layer.recopyWallpaper === 'function') return layer.recopyWallpaper();
    var api = wallpaperApi();
    if (!api || typeof api.recopyWallpaper !== 'function') {
      return Promise.resolve({ ok: false, reason: 'this window was started before the wallpaper copy existed; restart the browser' });
    }
    return Promise.resolve().then(function () { return api.recopyWallpaper(); })
      .catch(function (err) { return { ok: false, reason: (err && err.message) || 'the copy failed' }; });
  }

  /**
   * What app.js pushes into the new tab guest, before it adds the layer's
   * state and reason:
   *   { kind: 'desktop', dim }
   *       app.js adds the desktop still (LookSync.desktop()) itself
   *   { kind: 'builtin', dim, id?, url?, fileName?, reason?, fallbackUrl? }
   *   { kind: 'image', dim, url?, dataUrl? }
   *       url (= dataUrl) is only there with a picture actually stored; it
   *       is read out of IndexedDB once and then kept in memory
   *   { kind: 'video', dim, url?, fileUrl?, fileName? }
   *       url (= fileUrl) is the file:// URL of main's copy of the clip
   *   { kind: 'none', dim }
   * The legacy dataUrl / fileUrl names ride along for older guests.
   */
  /* --- the built-in photos (Helm's gallery) ---------------------
     main reads assets/backgrounds/catalog.json and stats every photo
     (bgfiles.readBuiltins); the answer is asked once per window and kept,
     since the photos ship with the build. A failed ask is NOT kept, so the
     next one tries again. Always resolves { ok, reason, items }. */
  var builtinsAsk = null;
  var builtinsList = null;            // the last good answer, sync, for the gallery

  function builtinBackgrounds() {
    if (builtinsAsk) return builtinsAsk;
    var api = window.api && window.api.background;
    if (!api || typeof api.builtins !== 'function') {
      return Promise.resolve({ ok: false, items: [],
        reason: 'this window was started before the built-in photos existed; restart the browser' });
    }
    builtinsAsk = Promise.resolve().then(function () { return api.builtins(); }).then(function (res) {
      var out = res && typeof res === 'object' && Array.isArray(res.items)
        ? res : { ok: false, items: [], reason: (res && res.reason) || 'no answer from the browser' };
      if (out.ok) builtinsList = out; else builtinsAsk = null;
      return out;
    }, function (err) {
      builtinsAsk = null;
      return { ok: false, items: [], reason: (err && err.message) || 'the photo list could not be read' };
    });
    return builtinsAsk;
  }

  /**
   * One built-in photo by id: { ok: true, item } or { ok: false, reason }.
   * The reason is the sentence Settings and the new tab show, so it says
   * what is wrong in words (an id from a newer build, a deleted file).
   */
  function builtinBackground(id) {
    return builtinBackgrounds().then(function (res) {
      if (!res.ok) return { ok: false, reason: res.reason || 'the built-in photos could not be listed' };
      if (!id) return { ok: false, reason: 'no built-in photo is picked yet' };
      for (var i = 0; i < res.items.length; i++) {
        var item = res.items[i];
        if (item.id !== id) continue;
        if (item.missing) return { ok: false, reason: item.missing, item: item };
        return { ok: true, item: item };
      }
      return { ok: false, reason: 'this build has no built-in photo called "' + id + '"' };
    });
  }

  function background() {
    var cfg = normalizeBackground(get('newtabBackground'));
    var out = { kind: cfg.kind, dim: cfg.dim };
    if (cfg.kind === 'builtin') {
      /* A known photo: its file:// URL, exactly like the wallpaper copy. An
         unknown one: no url, the reason, and fallbackUrl = the wallpaper
         copy, which is what backdrop.js shows behind the chrome too. */
      if (cfg.id) out.id = cfg.id;
      return builtinBackground(cfg.id).then(function (res) {
        if (res.ok) {
          out.url = res.item.fileUrl;
          out.fileName = res.item.file;
          return out;
        }
        out.reason = res.reason;
        return wallpaperCopy().then(function (w) {
          if (w && typeof w.fileUrl === 'string' && w.fileUrl) out.fallbackUrl = w.fileUrl;
          return out;
        });
      });
    }
    if (cfg.kind === 'video') {
      if (cfg.fileUrl) { out.url = cfg.fileUrl; out.fileUrl = cfg.fileUrl; }
      if (cfg.fileName) out.fileName = cfg.fileName;
      return Promise.resolve(out);
    }
    /* "Same as desktop": { kind: 'desktop', dim }. app.js adds the still
       itself from LookSync.desktop() (or Windows' wallpaper copy on its
       fallback) and the lined-up align, so nothing is resolved here. */
    if (cfg.kind === 'desktop') return Promise.resolve(out);
    if (cfg.kind !== 'image') return Promise.resolve(out);
    if (bgDataUrl) {
      out.url = bgDataUrl;
      out.dataUrl = bgDataUrl;
      return Promise.resolve(out);
    }
    return assetStore.get(BG_ASSET_KEY).then(function (blob) {
      if (!blob) return out;              // chosen, but nothing stored yet
      return blobToDataUrl(blob).then(function (url) {
        bgDataUrl = url;
        out.url = url;
        out.dataUrl = url;
        return out;
      });
    }).catch(function () { return out; });  // no db: the plain ground, never a throw
  }

  /* ============================================================
     Search engines
     ============================================================ */

  function engines() {
    return ENGINES.map(function (e) { return { id: e.id, name: e.name, url: e.url }; });
  }

  function engineFor(id) {
    for (var i = 0; i < ENGINES.length; i++) if (ENGINES[i].id === id) return ENGINES[i];
    return ENGINES[0];
  }

  function searchUrl(query) {
    var own = ownResultsUrl(query);
    if (own) return own;
    return engineFor(get('searchEngine')).url + encodeURIComponent(String(query == null ? '' : query));
  }

  /**
   * Quartz's own results page for `query` when that is the chosen engine,
   * else null. The look rides in the URL (theme, palette, hue) so the page is
   * right on its first frame, the way the Files page is. keywords.js asks this
   * too, so "b <words>" lands here when Brave is the engine.
   */
  function ownResultsUrl(query) {
    if (!SEARCH_PAGE_URL || !engineFor(get('searchEngine')).own) return null;
    var q = String(query == null ? '' : query).replace(/\s+/g, ' ').trim();
    if (!q) return null;
    var p = new URLSearchParams();
    p.set('q', q);
    var theme = document.documentElement.getAttribute('data-theme');
    p.set('theme', theme === 'light' ? 'light' : 'dark');
    var palette = get('palette');
    if (palette && palette !== 'aurora') p.set('palette', String(palette));
    var hue = get('accentHue');
    if (typeof hue === 'number' && isFinite(hue)) p.set('hue', String(hue));
    return SEARCH_PAGE_URL + '?' + p.toString();
  }

  /** True for Quartz's own results page (any query, any tab of it). */
  function isOwnResultsUrl(url) {
    return !!SEARCH_PAGE_URL && typeof url === 'string' && url.indexOf(SEARCH_PAGE_URL) === 0;
  }

  /** The search behind an own-results URL, or ''. */
  function ownResultsQuery(url) {
    if (!isOwnResultsUrl(url)) return '';
    try { return new URL(url).searchParams.get('q') || ''; } catch (err) { return ''; }
  }

  /** True when `url` is any known engine's results page (same host + path). */
  function isSearchUrl(url) {
    if (!url) return false;
    var u;
    try { u = new URL(String(url)); } catch (err) { return false; }
    for (var i = 0; i < ENGINES.length; i++) {
      var e;
      try { e = new URL(ENGINES[i].url); } catch (err2) { continue; }
      if (u.host === e.host && u.pathname === e.pathname) return true;
    }
    return false;
  }

  /* ============================================================
     Chips (the new tab shortcuts)
     ============================================================ */

  function defaultChips() {
    var seed = window.DEFAULT_CHIPS;
    if (!Array.isArray(seed)) return [];
    return seed
      .filter(function (c) { return c && c.url; })
      .map(function (c) { return { label: String(c.label || hostnameOf(c.url)), url: String(c.url) }; });
  }

  /** Always an array: null (never touched) reads as the seeded defaults. */
  function chips() {
    var c = get('chips');
    if (!Array.isArray(c)) return defaultChips();
    return c.map(function (x) { return { label: String(x.label || ''), url: String(x.url || '') }; });
  }

  /**
   * Where the new tab's five shortcuts come from: 'visited' (counted out of
   * the history, the default) or 'list' (the chips above, in order).
   *
   * Only 'list' is ever answered as itself. A missing key, an older file, a
   * typo and anything that is not a string all read as 'visited', so the page
   * never has to guess what a third value would have meant.
   */
  function chipsSource() {
    return get('chipsSource') === 'list' ? 'list' : 'visited';
  }

  /** @returns the value actually stored — 'list', or 'visited' for the rest. */
  function setChipsSource(value) {
    var next = value === 'list' ? 'list' : 'visited';
    set({ chipsSource: next });     // announces under 'chipsSource' for app.js
    return next;
  }

  function hostnameOf(url) {
    try {
      var h = new URL(String(url)).hostname;
      return h.replace(/^www\./, '') || String(url);
    } catch (err) {
      return String(url || '');
    }
  }

  /** A typed "github.com" is a URL; only the scheme is missing. */
  function normalizeUrl(url) {
    var raw = String(url == null ? '' : url).trim();
    if (!raw) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
    return 'https://' + raw;
  }

  function sameUrl(a, b) {
    function key(u) {
      return String(u || '').trim().toLowerCase().replace(/\/+$/, '');
    }
    return key(a) === key(b);
  }

  /** @returns true when it was added, false when that URL is already there. */
  function addChip(chip) {
    var url = normalizeUrl(chip && chip.url);
    if (!url) return false;
    var list = chips();
    for (var i = 0; i < list.length; i++) if (sameUrl(list[i].url, url)) return false;
    var label = chip && chip.label ? String(chip.label).trim() : '';
    list.push({ label: label || hostnameOf(url), url: url });
    set({ chips: list });
    return true;
  }

  function removeChip(url) {
    var list = chips();
    var next = list.filter(function (c) { return !sameUrl(c.url, url); });
    if (next.length === list.length) return false;
    set({ chips: next });
    return true;
  }

  function updateChip(url, patch) {
    var list = chips();
    for (var i = 0; i < list.length; i++) {
      if (!sameUrl(list[i].url, url)) continue;
      var label = patch && patch.label !== undefined ? String(patch.label).trim() : list[i].label;
      var next = patch && patch.url !== undefined ? normalizeUrl(patch.url) : list[i].url;
      if (!next) return false;
      list[i] = { label: label || hostnameOf(next), url: next };
      set({ chips: list });
      return true;
    }
    return false;
  }

  function moveChip(url, delta) {
    var list = chips();
    var from = -1;
    for (var i = 0; i < list.length; i++) if (sameUrl(list[i].url, url)) { from = i; break; }
    if (from < 0) return false;
    var to = from + delta;
    if (to < 0 || to >= list.length) return false;
    var item = list.splice(from, 1)[0];
    list.splice(to, 0, item);
    set({ chips: list });
    return true;
  }

  /* ============================================================
     Keywords (address-bar search shortcuts: "gh helm")
     keywords.js owns the built-in list, the rules and match(); this is
     only where the user's list is kept. keywords.js loads after this file,
     so every use of window.Keywords here is at call time, never at load.
     ============================================================ */

  function keywordRules() {
    var k = window.Keywords;
    return k && typeof k.check === 'function' && typeof k.defaults === 'function' ? k : null;
  }

  /**
   * The list with a verdict on every row: [{ key, name, url, upper?, ok,
   * reason }]. null (never touched) reads as the built-ins. [] without
   * keywords.js, and the editor says that it did not load.
   */
  function keywordList() {
    var rules = keywordRules();
    if (!rules) return [];
    var stored = get('keywords');
    return rules.check(Array.isArray(stored) ? stored : rules.defaults());
  }

  /**
   * Store a whole list. Every row is kept, valid or not, so a half-typed row
   * is never thrown away; one that fails the check is saved with
   * disabled:true (match() skips it either way) and the editor prints why.
   * @returns the list as stored, each row with its verdict.
   */
  function setKeywords(list) {
    var rules = keywordRules();
    if (!rules) return [];
    var checked = rules.check(Array.isArray(list) ? list : []);
    set({
      keywords: checked.map(function (r) {
        var out = { key: r.key, name: r.name, url: r.url };
        if (r.upper) out.upper = true;
        if (!r.ok) out.disabled = true;
        return out;
      })
    });
    return checked;
  }

  /** Back to the built-in list: null, so a later default list reaches it too. */
  function resetKeywords() {
    set({ keywords: null });
  }

  /* ============================================================
     Pinned apps

     Ids. The new tab page's dock is drawn from these joined against the
     installed-app index app.js pushes it, so a pin for an app that has been
     uninstalled costs nothing and comes back if it is reinstalled. app.js
     reads them through appPins() and writes them through setAppPins() when
     the page asks over its console channel.

     Three kinds of id live here now:

       '<hash>'          an installed app, as apps.js hashes it
       'web:<slug>'      a site the browser presents as an app (webapps.js)
       'term:<program>'  a terminal tab

     and a pin may also be an OBJECT carrying options:

       { id, web: true }      the primary click opens the app's web form
       { id, native: true }   ...or opens the app's own window IN a tab

     Those are the only two options a pin carries, which is why the plain
     string stays the stored shape whenever both are off: an old string-only
     file reads back unchanged, and a session that never touches either option
     never grows an object. pinOptions()/setPinOption() are the way in and out
     of it, and setPinOption() takes either key on its own. The two are
     exclusive — a press cannot both open the web form and host the window —
     so turning one ON clears the other, while turning one OFF leaves the
     other exactly where it was.
     ============================================================ */

  /** Anything stored (or handed in) read as a clean list of pins. */
  function normalizeAppPins(value) {
    var out = [];
    var seen = [];
    if (!Array.isArray(value)) return out;
    for (var i = 0; i < value.length; i++) {
      var pin = normalizeAppPin(value[i]);
      if (pin === null) continue;
      var id = pinIdOf(pin);
      if (seen.indexOf(id) >= 0) continue;   // a dock shows an app once
      seen.push(id);
      out.push(pin);
      if (out.length >= APP_PINS_MAX) break;
    }
    return out;
  }

  /* The two helpers the normaliser leans on. Declarations hoist, so they sit
     below it on purpose: the whole pin contract then reads as one block from
     the normaliser down, which is also how the harness slices it. */

  /** The id a stored pin names, '' when it does not name one. */
  function pinIdOf(pin) {
    var raw = null;
    if (typeof pin === 'string' || typeof pin === 'number') raw = pin;
    else if (pin && typeof pin === 'object' && !Array.isArray(pin)) raw = pin.id;
    if (typeof raw !== 'string' && typeof raw !== 'number') return '';
    return String(raw).trim();
  }

  /**
   * One pin, in the shape it is stored in: a bare id string, or
   * `{ id, web: true }` / `{ id, native: true }` when an option is on — both
   * keys when both are. null when it is junk. Only the options that are ON are
   * written, so the stored object never carries a `false` nobody set.
   */
  function normalizeAppPin(pin) {
    var id = pinIdOf(pin);
    if (!id || id.length > APP_ID_MAX) return null;
    var obj = (pin && typeof pin === 'object' && !Array.isArray(pin)) ? pin : null;
    var web = !!(obj && obj.web);
    var native = !!(obj && obj.native);
    if (!web && !native) return id;   // the plain string an old file reads as
    var out = { id: id };
    if (web) out.web = true;
    if (native) out.native = true;
    return out;
  }

  function appPins() {
    var group = get('apps');
    return normalizeAppPins(group && typeof group === 'object' ? group.pins : null);
  }

  /** Just the ids, in dock order — for a caller that only needs the join. */
  function appPinIds() {
    var list = appPins();
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(pinIdOf(list[i]));
    return out;
  }

  /**
   * Replace the whole list. Normalised on the way in, so a caller may hand
   * over the page's raw array; set() emits only when the stored value really
   * moved, which is what keeps app.js from re-pushing an unchanged dock.
   * @returns {string[]} the list as it is now stored.
   */
  function setAppPins(ids) {
    var next = normalizeAppPins(ids);
    var group = get('apps');
    var patch = {};
    if (group && typeof group === 'object' && !Array.isArray(group)) {
      for (var k in group) {
        if (Object.prototype.hasOwnProperty.call(group, k)) patch[k] = group[k];
      }
    }
    patch.pins = next;
    set({ apps: patch });
    return appPins();
  }

  /* ============================================================
     Home layout — the new tab Home's pieces, shown or hidden, and where each was put
     ============================================================ */

  /* homelayout.js is loaded by index.html before this file; feature-detected
     anyway, because a page without it must still open its panel. */
  function homeRules() {
    var h = window.HomeLayout;
    return h && typeof h.sanitize === 'function' && typeof h.apply === 'function' ? h : null;
  }

  /**
   * The layout as it is now: always complete and sanitised (a stored value
   * from another build, or a hand-edited file, is cleaned on the way out).
   * null only when the rules did not load — callers read that as "everything
   * shown, in its default place", which is exactly what the page does then.
   */
  function homeLayout() {
    var rules = homeRules();
    if (!rules) return null;
    return rules.sanitize(get('homeLayout'));
  }

  /** Store a layout. A layout equal to the default is stored as null. */
  function setHomeLayout(layout) {
    var rules = homeRules();
    if (!rules) return null;
    set({ homeLayout: rules.toStored(layout) });
    return homeLayout();
  }

  /**
   * One edit, from the Home's own Edit mode (through app.js) or from the
   * switches below. Always answers { ok, reason, layout }: a refusal carries
   * its reason in words, and layout is what is stored now either way, so the
   * caller can put the page back in step.
   */
  function applyHomeOp(op) {
    var rules = homeRules();
    if (!rules) return { ok: false, reason: 'Home layout rules did not load', layout: null };
    var r = rules.apply(homeLayout(), op);
    if (r.ok) setHomeLayout(r.layout);
    return { ok: !!r.ok, reason: r.reason || '', layout: homeLayout() };
  }

  function resetHomeLayout() {
    set({ homeLayout: null });
    return homeLayout();
  }

  /**
   * The options a pin carries. Answers `{ web: false, native: false }` for a
   * pin that is a plain string, for one whose options are off, and for an id
   * that is not pinned at all — the caller asking about a tile it is about to
   * draw. Both keys are always present, so no caller has to test for one.
   */
  function pinOptions(id) {
    var key = pinIdOf(id);
    var out = { web: false, native: false };
    if (!key) return out;
    var list = appPins();
    for (var i = 0; i < list.length; i++) {
      if (pinIdOf(list[i]) !== key) continue;
      var pin = list[i];
      var obj = (pin && typeof pin === 'object') ? pin : null;
      out.web = !!(obj && obj.web);
      out.native = !!(obj && obj.native);
      return out;
    }
    return out;
  }

  /**
   * Turn one pin's options on or off, leaving its place in the dock alone.
   * `opts` is a PATCH: a key that is not in it is left exactly as it was, so
   * `{ native: true }` cannot quietly clear the web option a previous press set.
   * The two options are exclusive, so a patch that turns ONE ON clears the
   * other; a patch that turns one off leaves the other alone.
   * Idempotent: set() only announces when the stored value really moved, and
   * both options off writes the plain string back, so a session that toggles
   * one off leaves a file indistinguishable from one that never touched it.
   * Does NOT pin anything — an id that is not in the dock is left alone.
   * @returns {{web:boolean, native:boolean}} the options as they now stand.
   */
  function setPinOption(id, opts) {
    var key = pinIdOf(id);
    var none = { web: false, native: false };
    if (!key) return none;
    var patch = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
    var list = appPins();
    var next = [];
    var found = false;
    for (var i = 0; i < list.length; i++) {
      if (pinIdOf(list[i]) === key) {
        found = true;
        var was = list[i];
        var obj = (was && typeof was === 'object') ? was : null;
        var setsWeb = Object.prototype.hasOwnProperty.call(patch, 'web');
        var setsNative = Object.prototype.hasOwnProperty.call(patch, 'native');
        var web = setsWeb ? !!patch.web : !!(obj && obj.web);
        var native = setsNative ? !!patch.native : !!(obj && obj.native);
        // The two are EXCLUSIVE: one primary click cannot both open the web
        // form and host the app's window, and the dock draws them as one
        // three-way choice (program / web / tab). So turning one ON turns the
        // other off — without this, "as a web app" on a pin already set to
        // "in a tab" stored both, the badge went on saying `tab` and the press
        // went on opening the tab, and the option could not be changed back at
        // all. Turning one OFF still leaves the other exactly as it was, which
        // is what makes the dock's "the program itself" row work.
        if (setsWeb && web) native = false;
        else if (setsNative && native) web = false;
        // normalizeAppPin() is the one place the stored shape is decided, so
        // this hands it the flags and lets it write the string or the object.
        next.push(normalizeAppPin({ id: key, web: web, native: native }));
      } else {
        next.push(list[i]);
      }
    }
    if (!found) return none;
    setAppPins(next);
    return pinOptions(key);
  }

  /* ============================================================
     Idle music

     Quiet music while nothing else in the browser is making a sound. The
     player lives in the chrome, not in a guest, so it survives tab
     switches; this is only where the choice is kept:

       { enabled, source: 'ambient'|'files', where: 'newtab'|'anywhere',
         volume: 0..1, files: [{ path, name }], shuffle }

     The tracks are referenced, never copied — only the path and the name a
     row shows are stored, so moving a file just makes that one skip.

     Every change is announced twice: once through the ordinary listener
     list with 'music' among the keys (which is how the background and the
     app dock are announced), and once as a 'music-changed' event on
     `document`, so a module that never subscribed to the store still hears
     it. Nothing here restarts anything: it all applies live.
     ============================================================ */

  var MUSIC_SOURCES = [
    { value: 'ambient', name: 'Built-in ambient' },
    { value: 'files', name: 'My tracks' }
  ];

  var MUSIC_WHERE = [
    { value: 'newtab', name: 'New tab page only' },
    { value: 'anywhere', name: 'Anywhere in the browser' }
  ];

  var MUSIC_VOLUME_DEFAULT = 0.35;
  var MUSIC_FILES_MAX = 500;        // a lobby playlist, not a music library
  var MUSIC_PATH_MAX = 1024;        // past Windows' long path, and then some
  var MUSIC_NAME_MAX = 200;

  /** A stored value kept only while the option list still offers it. */
  function pickValue(options, value, fallback) {
    for (var i = 0; i < options.length; i++) {
      if (options[i].value === value) return value;
    }
    return fallback;
  }

  /** The last segment of a path, either slash, as the name a row shows. */
  function musicBaseName(path) {
    var parts = String(path).split(/[\\/]+/);
    var last = parts[parts.length - 1] || '';
    return last || String(path);
  }

  /** The chosen tracks, read as a clean list: a path and a name each. */
  function normalizeMusicFiles(value) {
    var out = [];
    var seen = [];
    if (!Array.isArray(value)) return out;
    for (var i = 0; i < value.length; i++) {
      var raw = value[i];
      var path = '';
      var name = '';
      if (typeof raw === 'string') path = raw;
      else if (raw && typeof raw === 'object') {
        path = typeof raw.path === 'string' ? raw.path : '';
        name = typeof raw.name === 'string' ? raw.name : '';
      }
      path = path.trim();
      if (!path || path.length > MUSIC_PATH_MAX) continue;
      var key = path.toLowerCase();
      if (seen.indexOf(key) >= 0) continue;       // a playlist plays a file once
      seen.push(key);
      name = name.trim() || musicBaseName(path);
      if (name.length > MUSIC_NAME_MAX) name = name.slice(0, MUSIC_NAME_MAX);
      out.push({ path: path, name: name });
      if (out.length >= MUSIC_FILES_MAX) break;
    }
    return out;
  }

  /** Anything stored (or handed in) read as a complete, in-range group. */
  function normalizeMusic(value) {
    var v = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
    /* null, undefined and '' are "never set", not zero — a stored group from
       an older build must not come back silent. */
    var volume = (v.volume === null || v.volume === undefined || v.volume === '')
      ? MUSIC_VOLUME_DEFAULT : Number(v.volume);
    if (!isFinite(volume)) volume = MUSIC_VOLUME_DEFAULT;
    return {
      enabled: v.enabled === true,
      source: pickValue(MUSIC_SOURCES, v.source, 'ambient'),
      where: pickValue(MUSIC_WHERE, v.where, 'newtab'),
      volume: Math.min(1, Math.max(0, volume)),
      files: normalizeMusicFiles(v.files),
      shuffle: v.shuffle !== false
    };
  }

  function music() {
    return normalizeMusic(get('music'));
  }

  /**
   * Merge part of the group back. Only the keys handed over move, so a
   * caller may write { enabled: true } without knowing the rest, and a
   * value that makes no sense leaves that key where it was rather than
   * dropping it to the default. set() emits with 'music' among its keys
   * when something really changed, and react() fires 'music-changed'.
   * @returns {Object} the group as it is now stored.
   */
  function setMusic(patch) {
    var next = music();
    if (patch && typeof patch === 'object') {
      if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
      if (patch.source !== undefined) next.source = pickValue(MUSIC_SOURCES, patch.source, next.source);
      if (patch.where !== undefined) next.where = pickValue(MUSIC_WHERE, patch.where, next.where);
      if (patch.volume !== undefined) {
        var vol = (patch.volume === null || patch.volume === '') ? NaN : Number(patch.volume);
        if (isFinite(vol)) next.volume = Math.min(1, Math.max(0, vol));
      }
      if (patch.files !== undefined) next.files = normalizeMusicFiles(patch.files);
      if (patch.shuffle !== undefined) next.shuffle = patch.shuffle === true;
    }
    set({ music: next });
    return music();
  }

  /**
   * The group as a document event, for a module that never subscribed to
   * the store. Guarded end to end: a document without dispatchEvent (or a
   * listener that throws) must not take the write down with it.
   */
  function announceMusic() {
    if (!document || typeof document.dispatchEvent !== 'function') return;
    var detail = music();
    try {
      if (typeof window.CustomEvent === 'function') {
        document.dispatchEvent(new window.CustomEvent('music-changed', { detail: detail }));
        return;
      }
    } catch (err) { /* fall through to the older constructor */ }
    try {
      var ev = document.createEvent('CustomEvent');
      ev.initCustomEvent('music-changed', false, false, detail);
      document.dispatchEvent(ev);
    } catch (err) { /* no event path here: the listener list still fired */ }
  }

  /** The preload's file picker, or null on a window started before it. */
  function musicApi() {
    try {
      var api = window.api && window.api.music;
      if (!api || typeof api.chooseFiles !== 'function') return null;
      return api;
    } catch (err) { return null; }
  }

  /**
   * Ask main for tracks. Nothing is copied: the dialog hands back
   * [{ path, name }] and those are stored as they are, added to whatever is
   * already listed. A cancel answers with nothing and changes nothing.
   * @returns {Promise<{ok:boolean, added?:number, total?:number, reason?:string}>}
   */
  function chooseMusicFiles() {
    var api = musicApi();
    if (!api) return Promise.resolve({ ok: false, reason: 'unavailable' });
    var answer;
    /* autopauseReason() is this file's "a failure as a sentence" helper —
       hoisted, so reaching it from up here is fine. */
    try { answer = api.chooseFiles(); }
    catch (err) { return Promise.resolve({ ok: false, reason: autopauseReason(err) }); }
    return Promise.resolve(answer).then(function (value) {
      var picked = Array.isArray(value)
        ? value
        : ((value && Array.isArray(value.files)) ? value.files : []);
      var list = normalizeMusicFiles(picked);
      if (!list.length) return { ok: false, reason: 'cancelled' };
      var before = music().files;
      var stored = setMusic({ files: before.concat(list) }).files;
      return { ok: true, added: Math.max(0, stored.length - before.length), total: stored.length };
    }, function (err) {
      return { ok: false, reason: autopauseReason(err) };
    });
  }

  /* ============================================================
     Accent
     ============================================================ */

  function isLight() {
    return document.documentElement.getAttribute('data-theme') === 'light';
  }

  /**
   * Paint the accent tokens inline on <html>, or strip them so the authored
   * ones in chrome.css come back. The new tab page runs this same formula.
   */
  /* null while the shared formula (window.LookAccent, looksync/accent.js)
     paints the accent; otherwise why this window fell back to its own copy.
     The Look status row says it. */
  var accentFallback = null;

  /**
   * The accent tokens from the SHARED formula (Look Sync contract section 3,
   * the one Helm and Mantle run): acc -> --ion, soft/glow/line/select ->
   * their --ion-* tokens, and the two seams are the same colour at the
   * alphas tokens.css authors for them (ACCENT_TOKENS). null = not available.
   */
  function sharedAccentProps(h, light) {
    var LA = window.LookAccent;
    if (!LA || typeof LA.tokens !== 'function') {
      accentFallback = 'the shared accent formula (looksync/accent.browser.js) did not load, so this window uses its own copy of it';
      return null;
    }
    var t;
    try { t = LA.tokens(h, light ? 'light' : 'dark'); } catch (err) {
      accentFallback = 'the shared accent formula refused hue ' + h + ' (' + ((err && err.message) || 'error') + '), so this window uses its own copy of it';
      return null;
    }
    if (!t || !Array.isArray(t.rgb)) {
      accentFallback = 'the shared accent formula gave no colours for hue ' + h + ', so this window uses its own copy of it';
      return null;
    }
    accentFallback = null;
    var rgb = t.rgb.join(', ');
    var seamA = function (name) {
      for (var j = 0; j < ACCENT_TOKENS.length; j++) {
        if (ACCENT_TOKENS[j][0] === name) return ACCENT_TOKENS[j][light ? 2 : 1];
      }
      return 0.14;
    };
    return {
      '--ion': t.acc,
      '--ion-soft': t.soft,
      '--ion-glow': t.glow,
      '--ion-line': t.line,
      '--ion-select': t.select,
      '--seam-color': 'rgba(' + rgb + ', ' + seamA('--seam-color') + ')',
      '--chamber-seam': 'rgba(' + rgb + ', ' + seamA('--chamber-seam') + ')'
    };
  }

  function applyAccent(hue) {
    var root = document.documentElement;
    var i;
    var h = normalizeHue(hue);
    if (h === null) {
      /* The palette's own accent, exactly as authored: no inline props. */
      for (i = 0; i < ACCENT_TOKENS.length; i++) root.style.removeProperty(ACCENT_TOKENS[i][0]);
      return;
    }
    var light = isLight();
    var shared = sharedAccentProps(h, light);
    if (shared) {
      for (var name0 in shared) {
        if (Object.prototype.hasOwnProperty.call(shared, name0)) root.style.setProperty(name0, shared[name0]);
      }
      return;
    }
    /* Fallback only (accentFallback says why): this file's own formula. */
    h = h % 360;
    var sl = light ? ACCENT_SL.light : ACCENT_SL.dark;
    var s = sl[0];
    var l = sl[1];
    for (i = 0; i < ACCENT_TOKENS.length; i++) {
      var name = ACCENT_TOKENS[i][0];
      var alpha = ACCENT_TOKENS[i][1] === null ? null : ACCENT_TOKENS[i][light ? 2 : 1];
      var value = alpha === null
        ? 'hsl(' + h + ' ' + s + '% ' + l + '%)'
        : 'hsl(' + h + ' ' + s + '% ' + l + '% / ' + alpha + ')';
      root.style.setProperty(name, value);
    }
  }

  /**
   * The hue the slider should sit on when nothing is chosen: the authored
   * one. Helm's steel blue is hue 212 in both themes (tokens.css: dark
   * hsl(212 31% 71%), light hsl(212 26% 41%)), so there is one answer.
   */
  function authoredHue() {
    return 212;
  }

  /* ============================================================
     Palette
     A named set of chrome tokens, authored in chrome.css and chosen
     by one attribute on <html>. The accent slider still wins over it.
     ============================================================ */

  /** A stored value from another build, or a corrupt one, reads as aurora. */
  function paletteName(name) {
    for (var i = 0; i < PALETTES.length; i++) {
      if (PALETTES[i].id === name) return PALETTES[i].id;
    }
    return 'aurora';
  }

  function palettes() {
    return PALETTES.map(function (p) { return { id: p.id, name: p.name }; });
  }

  /**
   * Wear a palette: the attribute chrome.css keys off, the key theme-boot.js
   * reads on the next cold start, and then the accent — a hue the user picked
   * is theirs and outranks the palette's, so it is painted back on top;
   * otherwise the inline props come off and the palette's own accent shows.
   */
  function applyPalette(name) {
    var id = paletteName(name);
    var root = document.documentElement;
    if (id === 'aurora') {
      root.removeAttribute('data-palette');
      try { window.localStorage.removeItem(PALETTE_KEY); } catch (err) { /* fine */ }
    } else {
      root.setAttribute('data-palette', id);
      try { window.localStorage.setItem(PALETTE_KEY, id); } catch (err) { /* fine */ }
    }
    var hue = get('accentHue');
    applyAccent(hue === null || hue === undefined ? null : hue);
    return id;
  }

  /* ============================================================
     Site theme (the pages, not the chrome)
     ============================================================ */

  function pushSiteTheme(mode) {
    var m = mode === 'light' || mode === 'dark' ? mode : 'system';
    var app = window.api && window.api.app;
    if (app && typeof app.setSiteTheme === 'function') {
      try { app.setSiteTheme(m); } catch (err) { /* older preload */ }
    }
  }

  /* ============================================================
     Toast
     ============================================================ */

  /**
   * A failure's raw text (an Error, a string) goes to quartz.log through the chrome's log channel
   * (log.js uiError; `where` must be one it knows), never into a toast. The toast says in plain
   * words what happened and why; this keeps the exact error for later.
   */
  function logUiError(where, err) {
    var raw = '';
    if (err && typeof err === 'object' && err.message) raw = (err.name && err.name !== 'Error' ? err.name + ': ' : '') + err.message;
    else if (err != null) raw = String(err);
    try {
      var lg = window.api && window.api.log;
      if (lg && typeof lg.event === 'function') lg.event('ui-error', { where: where, detail: raw.slice(0, 400) });
    } catch (e) { /* no log channel: the toast still said what happened */ }
  }

  function showToast(text, ms) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'settings-toast';
      toastEl.className = 'glass';
      toastEl.setAttribute('role', 'status');
      toastEl.hidden = true;
      document.body.appendChild(toastEl);
    }
    window.clearTimeout(toastTimer);
    window.clearTimeout(toastHideTimer);
    toastEl.textContent = String(text == null ? '' : text);
    toastEl.hidden = false;
    // One frame hidden-to-shown, so the stepped transition actually runs.
    window.requestAnimationFrame(function () {
      if (toastEl) toastEl.classList.add('is-up');
    });
    toastTimer = window.setTimeout(function () {
      if (!toastEl) return;
      toastEl.classList.remove('is-up');
      toastHideTimer = window.setTimeout(function () {
        if (toastEl) toastEl.hidden = true;
      }, 200);
    }, Math.max(400, Number(ms) || 1800));
  }

  /* ============================================================
     DOM helpers
     ============================================================ */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function iconButton(glyph, label, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.title = label;
    b.setAttribute('aria-label', label);
    var g = el('span', 'glyph', glyph);
    b.appendChild(g);
    b.addEventListener('click', onClick);
    return b;
  }

  function textButton(label, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  /* ============================================================
     Folds — a section is a heading and a body that starts closed
     ============================================================ */

  /**
   * A section: a heading that is its own toggle, and a body that ships
   * folded. Everything a caller appends lands in the body — that is what the
   * redirected `appendChild` is for, so none of the builders below had to
   * learn about the fold, and a control added long after the build (a render
   * pass, an IPC answer) still lands inside it rather than beside it.
   */
  function section(title) {
    var s = el('section', 'set-section set-foldable');
    /* set-rows: in the sheet the body is the section's one quiet card of rows. */
    var body = el('div', 'set-collapse set-rows');
    body.id = 'set-fold-' + (++foldSeq);
    s.appendChild(foldHead(title, body.id, s));
    s.appendChild(body);
    s.setAttribute('data-fold-was', '0');
    applyFold(s, false);
    /* An own property: it shadows Node.prototype for this element alone. */
    s.appendChild = function (node) { return body.appendChild(node); };
    return s;
  }

  /**
   * A section with no fold at all: a plain <h2> and the content under it,
   * always there. About is the only one (the user's call) — it is three lines and a
   * button, so a fold would hide less than the control costs. Nothing here
   * carries .set-foldable, so unfoldAll() and the filter's
   * unfold-the-hits pass both walk straight past it.
   */
  function plainSection(title) {
    var s = el('section', 'set-section');
    s.appendChild(el('h2', 'set-h', title));
    /* The sheet draws a section's rows on one card, so About gets a body
       too; appendChild lands in it, as a fold's does. No fold, no toggle. */
    var body = el('div', 'set-rows');
    s.appendChild(body);
    s.appendChild = function (node) { return body.appendChild(node); };
    return s;
  }

  /**
   * The heading as a real <button>, so Tab reaches it and Enter works, and
   * with aria-expanded so a screen reader hears the state rather than the
   * chevron. It has to read exactly like the <h2> it replaced: .set-h paints
   * it, and settings.css only undoes what a button brings of its own.
   */
  function foldHead(title, bodyId, s) {
    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'set-h set-h-toggle';
    head.setAttribute('aria-expanded', 'false');
    head.setAttribute('aria-controls', bodyId);
    head.appendChild(el('span', 'set-h-text', title));
    /* Rotated by CSS when the section opens, so the glyph is the state. */
    var chev = el('span', 'set-h-chev', '›');
    chev.setAttribute('aria-hidden', 'true');
    head.appendChild(chev);
    /* In the sheet a heading shows only over search results, where it is
       the way into its section: the nav's row, said where the hit is. */
    head.addEventListener('click', function () { showSection(s, true); });
    /* A <button> already turns Enter and Space into a click; taking the key
       ourselves keeps the panel's other key handling out of it, and the
       preventDefault is what stops the second, native toggle. */
    head.addEventListener('keydown', function (ev) {
      var key = ev && ev.key;
      if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      showSection(s, true);
    });
    return head;
  }

  /** The header is the record of the state, so nothing can drift from it. */
  function isFoldOpen(s) {
    var head = s && s.querySelector ? s.querySelector('.set-h-toggle') : null;
    return !!head && head.getAttribute('aria-expanded') === 'true';
  }

  /**
   * Paint one fold. The body carries `hidden`, so it is out of the tab order
   * and out of the accessibility tree while folded; `is-open` is only for the
   * chevron. Never re-renders: a folded section still holds a fully rendered
   * list. Folding away the row that is recording cancels the recording,
   * rather than leaving a hidden row eating keystrokes.
   */
  function applyFold(s, open) {
    if (!s) return;
    var head = s.querySelector('.set-h-toggle');
    var body = s.querySelector('.set-collapse');
    if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (body) body.hidden = !open;
    if (s.classList) {
      if (open) s.classList.add('is-open');
      else s.classList.remove('is-open');
    }
    if (!open && s === shortcutsSectionEl && recId !== null) stopRecording();
  }

  /**
   * A search must not hide its own hits: while the filter has words every
   * section still showing is held open, and clearing the box puts the
   * reader's own folds back. Runs after applyFilter() has set `hidden`,
   * which is how it knows which sections hold a match.
   */
  function syncFolds(filtering) {
    if (!bodyEl) return;
    var sections = bodyEl.querySelectorAll('.set-foldable');
    var i;
    if (filtering) {
      if (!foldsForced) {
        foldsForced = true;
        for (i = 0; i < sections.length; i++) {
          sections[i].setAttribute('data-fold-was', isFoldOpen(sections[i]) ? '1' : '0');
        }
      }
      for (i = 0; i < sections.length; i++) applyFold(sections[i], !sections[i].hidden);
      return;
    }
    if (!foldsForced) return;
    foldsForced = false;
    for (i = 0; i < sections.length; i++) {
      applyFold(sections[i], sections[i].getAttribute('data-fold-was') === '1');
    }
  }

  /* ============================================================
     The sheet: one section at a time

     The nav on the left names every section; the right pane shows the
     one picked. Every fold is held open while the sheet is (the nav is
     what picks now), so a section on show is always whole, and the
     filter's own pass still hides and lights exactly what it did.
     ============================================================ */

  /** The heading text: .set-h-text in a fold's button, the <h2> otherwise. */
  function sectionName(s) {
    if (!s || !s.querySelector) return '';
    var head = s.querySelector('.set-h-text') || s.querySelector('.set-h');
    return head ? String(head.textContent || '').trim() : '';
  }

  function allSections() {
    return bodyEl ? bodyEl.querySelectorAll('.set-section') : [];
  }

  /** By heading, any case; null for a name no section carries. */
  function findSection(title) {
    var want = String(title == null ? '' : title).trim().toLowerCase();
    if (!want) return null;
    var sections = allSections();
    for (var i = 0; i < sections.length; i++) {
      if (sectionName(sections[i]).toLowerCase() === want) return sections[i];
    }
    return null;
  }

  /** Every fold open, and remembered open, so a cleared filter puts them back open. */
  function unfoldAll() {
    if (!bodyEl) return;
    foldsForced = false;
    var sections = bodyEl.querySelectorAll('.set-foldable');
    for (var i = 0; i < sections.length; i++) {
      sections[i].setAttribute('data-fold-was', '1');
      applyFold(sections[i], true);
    }
  }

  /** Below about 760 px the sheet is one pane: the nav, or a section with a back arrow. */
  function setPane(pane) {
    if (panelEl) panelEl.setAttribute('data-pane', pane === 'nav' ? 'nav' : 'main');
  }

  function isFiltering() {
    return !!(panelEl && panelEl.classList.contains('is-filtering'));
  }

  /** The right pane's heading: the section's name, or what the search is for. */
  function renderTitle() {
    if (!titleEl) return;
    var q = filterEl ? String(filterEl.value || '').trim() : '';
    titleEl.textContent = isFiltering() && q
      ? 'Results for \u201C' + q + '\u201D'
      : sectionName(currentEl);
  }

  /** The nav follows: the current row, and (while searching) which rows hold a hit. */
  function syncNav() {
    if (!navEl) return;
    var filtering = isFiltering();
    var items = navEl.querySelectorAll('.set-nav-item');
    for (var i = 0; i < items.length; i++) {
      var s = items[i]._section;
      if (!filtering && s === currentEl) items[i].setAttribute('aria-current', 'page');
      else items[i].removeAttribute('aria-current');
      items[i].classList.toggle('is-miss', filtering && !!s && !!s.hidden);
    }
  }

  /** Put one section on show. Nothing else about it changes. */
  function setCurrent(s) {
    if (!s) return;
    if (currentEl && currentEl !== s && currentEl === shortcutsSectionEl && recId !== null) {
      stopRecording();     // leaving the row that records cancels it, as folding it away did
    }
    var sections = allSections();
    for (var i = 0; i < sections.length; i++) {
      sections[i].classList.toggle('is-current', sections[i] === s);
    }
    currentEl = s;
    lastSection = sectionName(s);
    syncNav();
    renderTitle();
  }

  /**
   * The nav's row (or a result's heading) was picked: a search in the box
   * gives way to the section, which opens at its top. `focusIn` hands the
   * keyboard to the pane, so the next Tab is the section's first control.
   */
  function showSection(s, focusIn) {
    if (!s || !bodyEl) return;
    if (filterEl && filterEl.value) clearFilter();
    setCurrent(s);
    setPane('main');
    bodyEl.scrollTop = 0;
    if (focusIn) {
      try { bodyEl.focus({ preventScroll: true }); } catch (err) { /* not focusable yet */ }
    }
  }

  /** The nav: one row per section, in the order the sections are built. */
  function buildNav() {
    if (!navEl) return;
    navEl.textContent = '';
    var sections = allSections();
    for (var i = 0; i < sections.length; i++) {
      (function (s) {
        var name = sectionName(s);
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'set-nav-item';
        var g = el('span', 'set-nav-glyph glyph', NAV_GLYPHS[name] || GLYPH_GEAR);
        // Lumen is a product, not a setting: its row wears its own mark (the
        // 16-grid colour drawing) where the others wear a glyph.
        if (NAV_MARKS[name]) {
          g.textContent = '';
          g.className = 'set-nav-glyph set-nav-mark';
          var mk = document.createElement('img');
          mk.src = NAV_MARKS[name];
          mk.alt = '';
          mk.width = 16;
          mk.height = 16;
          mk.draggable = false;
          g.appendChild(mk);
        }
        g.setAttribute('aria-hidden', 'true');
        b.appendChild(g);
        b.appendChild(el('span', 'set-nav-text', name));
        b._section = s;
        b.addEventListener('click', function () { showSection(s, false); });
        navEl.appendChild(b);
      })(sections[i]);
    }
  }

  /** Up and Down walk the nav; Home and End jump to its ends. */
  function navKeys(event) {
    var k = event.key;
    if (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'Home' && k !== 'End') return;
    var items = Array.prototype.slice.call(navEl.querySelectorAll('.set-nav-item'));
    var at = items.indexOf(document.activeElement);
    if (at < 0 || !items.length) return;
    event.preventDefault();
    var next = k === 'Home' ? 0 : k === 'End' ? items.length - 1
      : (at + (k === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }

  /**
   * Open the panel at one section — what a deep link from elsewhere in the
   * browser needs. Matches on the heading text and puts that section on
   * show, at its top, in the single-pane layout too; an unknown name leaves
   * the panel exactly as it is.
   */
  function revealSection(title) {
    if (!bodyEl) return false;
    var s = findSection(title);
    if (!s) return false;
    showSection(s, false);
    return true;
  }

  /** A row of mutually exclusive options, drawn as one segmented instrument. */
  function segmented(options, current, onPick) {
    var wrap = el('div', 'set-seg');
    wrap.setAttribute('role', 'radiogroup');
    options.forEach(function (opt) {
      var b = textButton(opt.name, 'set-seg-opt' + (opt.id === current ? ' is-on' : ''), function () {
        onPick(opt.id);
      });
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', opt.id === current ? 'true' : 'false');
      wrap.appendChild(b);
    });
    return wrap;
  }

  /**
   * The palettes as six painted chips. One radiogroup with a roving tabindex:
   * the arrows carry the selection along the row the way a radio group does,
   * Space and Enter confirm whatever is focused. Each button wears the palette
   * it offers, so the row is its own legend.
   */
  function paletteSwatches(current, onPick) {
    var wrap = el('div', 'set-swatches');
    wrap.setAttribute('role', 'radiogroup');
    wrap.setAttribute('aria-label', 'Palette');
    var buttons = [];

    function moveTo(i) {
      var n = buttons.length;
      var next = buttons[((i % n) + n) % n];
      if (!next) return;
      if (typeof next.focus === 'function') next.focus();
      onPick(next.getAttribute('data-value'));
    }

    PALETTES.forEach(function (p, index) {
      var on = p.id === current;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'set-swatch' + (on ? ' is-on' : '');
      b.setAttribute('data-value', p.id);
      /* aurora is chrome.css's own :root and has no block of its own, so
         leaving the attribute off is exactly what previews the default. */
      if (p.id !== 'aurora') b.setAttribute('data-palette', p.id);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.setAttribute('aria-label', p.name);
      b.title = p.name;
      b.tabIndex = on ? 0 : -1;
      b.appendChild(el('span', 'set-swatch-check', GLYPH_CHECK));
      b.addEventListener('click', function () { onPick(p.id); });
      b.addEventListener('keydown', function (event) {
        var k = event.key;
        if (k === 'ArrowRight' || k === 'ArrowDown') { event.preventDefault(); moveTo(index + 1); }
        else if (k === 'ArrowLeft' || k === 'ArrowUp') { event.preventDefault(); moveTo(index - 1); }
        else if (k === 'Home') { event.preventDefault(); moveTo(0); }
        else if (k === 'End') { event.preventDefault(); moveTo(buttons.length - 1); }
        else if (k === ' ' || k === 'Spacebar' || k === 'Enter') { event.preventDefault(); onPick(p.id); }
      });
      buttons.push(b);
      wrap.appendChild(b);

      var name = el('span', 'set-swatch-name', p.name);
      name.setAttribute('aria-hidden', 'true');
      wrap.appendChild(name);
    });
    return wrap;
  }

  /** A vertical list of options, each with its own lit dot. */
  function optionList(options, current, onPick) {
    var wrap = el('div', 'set-opts');
    wrap.setAttribute('role', 'radiogroup');
    options.forEach(function (opt) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'set-opt' + (opt.id === current ? ' is-on' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', opt.id === current ? 'true' : 'false');
      b.appendChild(el('span', 'set-dot'));
      b.appendChild(el('span', 'set-opt-name', opt.name));
      b.addEventListener('click', function () { onPick(opt.id); });
      wrap.appendChild(b);
    });
    return wrap;
  }

  /**
   * A <select> dressed as one of the panel's fields. The chevron is drawn by
   * the wrapper's ::after — a native dropdown arrow would be the only piece
   * of Windows grey in the whole pane.
   */
  function glassSelect(id, options, current, onPick) {
    var wrap = el('span', 'set-select');
    var sel = document.createElement('select');
    sel.className = 'set-sel';
    if (id) sel.id = id;

    var match = -1;
    options.forEach(function (opt, i) {
      var o = document.createElement('option');
      o.value = String(opt.value);
      o.textContent = opt.name;
      if (String(opt.value) === String(current)) match = i;
      sel.appendChild(o);
    });
    /* A stored value from a future build (or a corrupt one) still has to
       show something honest, so fall back to the option list's own first. */
    sel.selectedIndex = match >= 0 ? match : 0;

    sel.addEventListener('change', function () {
      var picked = options[sel.selectedIndex];
      onPick(picked ? picked.value : options[0].value);
    });
    wrap.appendChild(sel);
    return wrap;
  }

  /** A label and one control on the same line, wrapping when it must. */
  function controlRow(labelText, id, control) {
    var row = el('div', 'set-ctl-row');
    var label = el('label', 'set-ctl-label', labelText);
    if (id) label.setAttribute('for', id);
    row.appendChild(label);
    row.appendChild(control);
    return row;
  }

  /**
   * A whole-row switch: the row itself is the control, like .set-opt, so the
   * label is as clickable as the track beside it.
   */
  function switchRow(label, checked, onToggle) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'set-row' + (checked ? ' is-on' : '');
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', checked ? 'true' : 'false');
    b.appendChild(el('span', 'set-row-label', label));
    var track = el('span', 'set-switch');
    track.appendChild(el('span', 'set-switch-knob'));
    b.appendChild(track);
    b.addEventListener('click', function () { onToggle(!checked); });
    return b;
  }

  /* ============================================================
     Sections
     ============================================================ */

  function buildLook() {
    var s = section('Look');
    /* Look Sync first: the switch, then the sentence on how it is going. */
    var sync = el('div', 'set-field set-looksync');
    sync.setAttribute('data-field', 'looksync');
    s.appendChild(sync);

    var seg = el('div', 'set-field');
    seg.setAttribute('data-field', 'theme');
    s.appendChild(seg);

    var palette = el('div', 'set-field');
    palette.setAttribute('data-field', 'palette');
    s.appendChild(palette);

    var accent = el('div', 'set-field set-accent');
    accent.setAttribute('data-field', 'accent');
    s.appendChild(accent);

    var glassField = el('div', 'set-field set-glass');
    glassField.setAttribute('data-field', 'glass');
    s.appendChild(glassField);

    var bookmarks = el('div', 'set-field');
    bookmarks.setAttribute('data-field', 'bookmarksbar');
    s.appendChild(bookmarks);
    return s;
  }

  /* Set for the length of one pick, so the re-render it causes knows to take
     the keyboard back to the swatch that was just chosen. */
  var paletteFocus = false;

  /** A swatch was chosen: wear it now, then store it so everyone else hears. */
  function pickPalette(name) {
    if (paletteName(name) !== name) return;   // not one of ours: ignore it
    paletteFocus = true;
    applyPalette(name);
    set({ palette: name });
    paletteFocus = false;
  }

  function renderLook() {
    if (!bodyEl) return;
    var themeField = bodyEl.querySelector('[data-field="theme"]');
    var accentField = bodyEl.querySelector('[data-field="accent"]');
    if (!themeField || !accentField) return;

    renderLookSync();
    renderTheme(themeField);

    var paletteField = bodyEl.querySelector('[data-field="palette"]');
    if (paletteField) {
      paletteField.textContent = '';
      paletteField.appendChild(paletteSwatches(paletteName(get('palette')), pickPalette));
      paletteField.appendChild(el('p', 'set-hint',
        'A palette sets the accent colour only; the greys stay neutral. Pick your own accent below to override the palette’s.'));
      /* A pick rebuilt this row out from under the keyboard; put it back. */
      if (paletteFocus) {
        var picked = paletteField.querySelector('.set-swatch.is-on');
        if (picked && typeof picked.focus === 'function') picked.focus();
      }
    }

    var hue = get('accentHue');
    accentField.textContent = '';
    var row = el('div', 'set-accent-row');

    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '360';
    slider.step = '1';
    slider.className = 'set-hue';
    slider.value = String(hue === null || hue === undefined ? authoredHue() : hue);
    slider.title = 'Accent colour';
    slider.setAttribute('aria-label', 'Accent colour');
    // input previews without writing; change is the one that persists.
    slider.addEventListener('input', function () { applyAccent(Number(slider.value)); });
    slider.addEventListener('change', function () { set({ accentHue: Number(slider.value) }); });
    row.appendChild(slider);

    /* "Default" now means the palette's accent, not aurora's: drop the custom
       hue, then let the current palette repaint what it authored. */
    var def = textButton('Default', 'set-text', function () {
      set({ accentHue: null });
      applyPalette(get('palette'));
    });
    def.disabled = hue === null || hue === undefined;
    row.appendChild(def);

    accentField.appendChild(row);
    accentField.appendChild(el('p', 'set-hint', 'One colour marks what is active, everywhere.'));

    renderGlass();
    renderBookmarksBar();
  }

  /* ============================================================
     Look Sync rows (Settings > Look, top)
     window.LookSync is looksync.js's glue (quartz-lane-contract.md); it
     loads before this file, but every use is feature-detected so a window
     without it says so instead of quietly doing nothing.
     ============================================================ */

  function lookSyncApi() {
    var ls = window.LookSync;
    return ls && typeof ls === 'object' ? ls : null;
  }

  /** LookSync.<name>() or null, never a throw. */
  function lookCall(name) {
    var ls = lookSyncApi();
    if (!ls || typeof ls[name] !== 'function') return null;
    try { return ls[name].apply(ls, Array.prototype.slice.call(arguments, 1)); } catch (err) { return null; }
  }

  var LOOK_MISSING = 'Look sync did not load in this window (looksync.js is missing), so Quartz keeps its own look and cannot follow the desktop';

  /* Each distinct message is toasted once per window (lookapplied messages,
     the desktop fallback, status fallbacks). */
  /* The chrome has one toast that a newer one replaces, so these queue:
     two at boot (the migration note and a desktop fallback) both get read. */
  var LOOK_TOAST_MS = 5200;
  var lookToasted = {};
  var lookToastQueue = [];
  var lookToastBusyUntil = 0;
  function lookToastOnce(text) {
    if (!text || lookToasted[text] || !document.body) return;
    lookToasted[text] = true;
    lookToastQueue.push(String(text));
    if (lookToastQueue.length === 1) lookToastNext();
  }
  function lookToastNext() {
    if (!lookToastQueue.length) return;
    var wait = lookToastBusyUntil - Date.now();
    if (wait > 0) { window.setTimeout(lookToastNext, wait); return; }
    var text = lookToastQueue.shift();
    showToast(text, LOOK_TOAST_MS);
    lookToastBusyUntil = Date.now() + LOOK_TOAST_MS + 250;
    if (lookToastQueue.length) window.setTimeout(lookToastNext, LOOK_TOAST_MS + 250);
  }

  /** The status sentence, with its rev when the line does not already say it. */
  function lookStatusText(st) {
    if (!st) return LOOK_MISSING + '.';
    var line = st.line ? String(st.line) : ('Sync with the others: ' + (st.state || 'unknown')
      + (st.reason ? ' (' + st.reason + ')' : ''));
    if (st.rev !== undefined && st.rev !== null && !/\brev\b/i.test(line)) line += ' · rev ' + st.rev;
    return line;
  }

  /** The switch and the status line under it. */
  function renderLookSync() {
    var field = bodyEl && bodyEl.querySelector('[data-field="looksync"]');
    if (!field) return;
    field.textContent = '';
    var on = get('lookSync') !== false;
    field.appendChild(switchRow('Match Helm and Mantle', on, function (next) {
      set({ lookSync: !!next });
    }));
    var line = el('p', 'set-look-status');
    line.setAttribute('data-look-status', '');
    line.setAttribute('role', 'status');
    field.appendChild(line);
    var skipped = el('ul', 'set-look-skipped');
    skipped.setAttribute('data-look-skipped', '');
    field.appendChild(skipped);
    var hints = el('p', 'set-look-status');
    hints.setAttribute('data-toprow-status', '');
    hints.setAttribute('role', 'status');
    field.appendChild(hints);
    field.appendChild(el('p', 'set-hint',
      'Theme, accent colour and glass stay the same in Quartz, Helm and Mantle. The background choice is always this app’s own.'));
    renderLookStatus();
    renderToprowStatus();
  }

  /* ---- Top bar hints (toprow.js -> toprow-main.js -> Mantle's pipe) ----
     One line under the sync status: is Mantle listening, what Quartz is
     telling it about its top row, and why when it is not (Mantle not
     running, a test window, "can't say" with the reason). */
  function alphaWords2(a) {
    var v = Math.round(Number(a) * 100) / 100;
    return isFinite(v) ? (v >= 1 ? '1' : '.' + String(Math.round(v * 100)).padStart(2, '0')) : '?';
  }

  function toprowTopWords(st) {
    var top = st && st.top;
    if (!top) return '';
    if (top.kind === 'wash') return 'the wallpaper under a ' + alphaWords2(top.alpha) + ' wash';
    if (top.kind === 'flat') return 'a flat colour, rgb(' + top.rgb.join(', ') + ')';
    if (top.kind === 'cols') return 'the picture, ' + top.cols.length + ' columns across';
    return '“can’t say”' + (st.why ? ' (' + st.why + ')' : '') + ', so it reads the screen';
  }

  function toprowText(st) {
    if (!st) return 'Top bar hints: not loaded in this window (toprow.js is missing), so Mantle reads the screen to colour its top bar.';
    var m = st.main || {};
    var what = toprowTopWords(st);
    var secs = Math.round((m.retryMs || 2000) / 1000);
    if (m.state === 'connected') {
      return 'Top bar hints: Mantle connected' + (what ? ', telling it ' + what : '') +
        (isLight() ? ' (Mantle uses them in dark only)' : '') + '.';
    }
    if (m.state === 'waiting') {
      return 'Top bar hints: ' + (m.reason || 'Mantle can’t be reached') + '. Trying again every ' + secs +
        ' s; meanwhile Mantle reads the screen.';
    }
    if (m.state === 'connecting' || m.state === 'starting') return 'Top bar hints: connecting to Mantle…';
    return 'Top bar hints: ' + (m.reason || m.state || 'off') + '.';
  }

  function renderToprowStatus() {
    var line = bodyEl && bodyEl.querySelector('[data-toprow-status]');
    if (!line) return;
    var T = window.Toprow;
    var st = null;
    try { st = T && typeof T.status === 'function' ? T.status() : null; } catch (err) { st = null; }
    var state = st ? String((st.main && st.main.state) || 'starting') : 'nomodule';
    var cls = state === 'connected' ? 'ok' : state === 'waiting' ? 'missing' : state === 'connecting' ? 'starting' : state;
    line.className = 'set-look-status is-' + cls.replace(/[^a-z-]/gi, '');
    line.setAttribute('data-state', state);
    line.textContent = toprowText(st);
  }

  /** Just the status line (lookstatus fires on every change of it). */
  function renderLookStatus() {
    var line = bodyEl && bodyEl.querySelector('[data-look-status]');
    if (!line) return;
    var st = lookCall('status');
    var state = st ? String(st.state || 'starting') : 'nomodule';
    line.className = 'set-look-status is-' + state.replace(/[^a-z-]/gi, '');
    line.setAttribute('data-state', state);
    line.textContent = lookStatusText(st);
    var list = bodyEl.querySelector('[data-look-skipped]');
    if (list) {
      list.textContent = '';
      var sk = st && Array.isArray(st.skipped) ? st.skipped : [];
      sk.forEach(function (x) {
        if (!x) return;
        var text = (x.reason ? String(x.reason) : 'Ignored a bad value') + (x.field ? ' (' + x.field + ')' : '');
        if (line.textContent.indexOf(text) >= 0) return;
        list.appendChild(el('li', 'set-note set-look-warn', text));
      });
      var accentWhy = accentFallback || ((!window.LookAccent || typeof window.LookAccent.tokens !== 'function')
        ? 'the shared accent formula (looksync/accent.browser.js) did not load, so a custom accent uses this window’s own copy of it'
        : null);
      if (accentWhy) list.appendChild(el('li', 'set-note set-look-warn', 'Accent: ' + accentWhy + '.'));
      list.hidden = !list.firstChild;
    }
  }

  /* ---- Theme: System / Light / Dark --------------------------------- */

  /* The last reason app.js gave with quartzthemechange (System could not
     read Windows' apps mode, so it resolved to Dark). */
  var themeReason = '';

  function renderTheme(themeField) {
    var field = themeField || (bodyEl && bodyEl.querySelector('[data-field="theme"]'));
    if (!field) return;
    field.textContent = '';
    var QT = window.QuartzTheme;
    if (QT && typeof QT.setMode === 'function') {
      var mode = 'dark';
      try { mode = typeof QT.mode === 'function' ? QT.mode() : mode; } catch (err) { /* keep dark */ }
      field.appendChild(segmented(
        [{ id: 'system', name: 'System' }, { id: 'light', name: 'Light' }, { id: 'dark', name: 'Dark' }],
        mode,
        function (next) {
          // Plain words on screen; the raw error goes to quartz.log. setMode answers a Promise of
          // { ok, reason }: a refusal or a rejection is a failure too, not only a throw.
          var words = 'Couldn’t switch the theme to ' + ({ system: 'System', light: 'Light', dark: 'Dark' }[next] || next) +
            ': Quartz hit an error, so the window keeps its current look. The details are in quartz.log.';
          var failed = function (raw) { logUiError('theme', raw); showToast(words, 4000); };
          var answer;
          try { answer = QT.setMode(next); } catch (err) { failed(err); return; }
          if (answer && typeof answer.then === 'function') {
            answer.then(function (res) {
              if (res && res.ok === false) failed(res.reason || 'setMode said no without a reason');
            }, failed);
          }
        }
      ));
      if (mode === 'system') {
        var resolved = isLight() ? 'Light' : 'Dark';
        if (themeReason) {
          field.appendChild(el('p', 'set-note set-look-warn',
            'System could not read Windows’ setting, so Quartz is ' + resolved + ': ' + themeReason + '.'));
        } else {
          field.appendChild(el('p', 'set-hint', 'Following Windows’ app mode: ' + resolved + ' right now.'));
        }
      }
      return;
    }
    /* No QuartzTheme (app.js from before Look Sync): the old two choices,
       and the reason System is missing. */
    field.appendChild(segmented(
      [{ id: 'dark', name: 'Dark' }, { id: 'light', name: 'Light' }],
      isLight() ? 'light' : 'dark',
      function (m) {
        if (typeof window.setTheme === 'function') window.setTheme(m);
        else document.documentElement.setAttribute('data-theme', m);
      }
    ));
    field.appendChild(el('p', 'set-note set-look-warn',
      'System is not offered: this window’s theme module (QuartzTheme) did not load, and the theme is not shared with Helm and Mantle.'));
  }

  /* ---- Glass: Blur / Dim / See-through for the current theme --------- */

  /** One labelled range with a readout; input previews, change stores. */
  function glassSlider(label, id, min, max, value, format, onInput, onChange) {
    var wrap = el('span', 'set-bg-dim set-glass-ctl');
    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = '1';
    slider.className = 'set-range';
    slider.id = id;
    slider.value = String(value);
    slider.setAttribute('aria-label', label);
    var readout = el('span', 'set-bg-dim-value', format(value));
    slider.addEventListener('input', function () {
      readout.textContent = format(Number(slider.value));
      onInput();
    });
    slider.addEventListener('change', onChange);
    wrap.appendChild(slider);
    wrap.appendChild(readout);
    return { row: controlRow(label, id, wrap), slider: slider, wrap: wrap };
  }

  /** ".58" (the guard's way of writing an alpha). */
  function alphaText(a) {
    var n = Math.round(Number(a) * 100) / 100;
    if (!isFinite(n)) return '?';
    return n.toFixed(2).replace(/^0(?=\.)/, '');
  }

  /** "0.30" (the Dim row's way of writing its own value). */
  function dimText(a) {
    var n = Math.round(Number(a) * 100) / 100;
    return isFinite(n) ? n.toFixed(2) : '?';
  }

  /**
   * The whole glass group after one edit to `theme` (pure; the caller sets it).
   * `values` is { blurPx, dim, panel } from the sliders, or null to keep the
   * stored ones. kind 'dim': the user moved Dim, so it turns Manual
   * (dimAuto false). 'auto': back to Automatic (dimAuto true), values as they
   * are. Anything else (Blur, See-through) keeps dimAuto exactly as stored,
   * absent included.
   */
  function glassEdit(all, theme, values, kind) {
    var out = normalizeGlass(all);
    var prev = out[theme];
    var next = values ? { blurPx: values.blurPx, dim: values.dim, panel: values.panel }
      : { blurPx: prev.blurPx, dim: prev.dim, panel: prev.panel };
    if (kind === 'dim') next.dimAuto = false;
    else if (kind === 'auto') next.dimAuto = true;
    else if (typeof prev.dimAuto === 'boolean') next.dimAuto = prev.dimAuto;
    out[theme] = next;
    return normalizeGlass(out);
  }

  function renderGlass() {
    var field = bodyEl && bodyEl.querySelector('[data-field="glass"]');
    if (!field) return;
    field.textContent = '';
    /* CONTRACT "Light look": the sliders edit glass.light while Quartz is
       light and glass.dark while it is dark; the title says which. */
    var theme = isLight() ? 'light' : 'dark';
    field.setAttribute('data-glass-theme', theme);
    var g = glass()[theme];
    var auto = g.dimAuto !== false;
    var ls = lookSyncApi();
    var canPreview = !!(ls && typeof ls.previewGlass === 'function');

    var blur, dim, see;
    function current() {
      return {
        blurPx: Number(blur.slider.value),
        dim: Number(dim.slider.value) / 100,
        /* See-through is the panel alpha turned around: more = clearer. */
        panel: -Number(see.slider.value) / 100
      };
    }
    function inputFor(kind) {
      return function () {
        if (!canPreview) return;
        try { ls.previewGlass(theme, glassEdit(glass(), theme, current(), kind)[theme]); } catch (err) { /* glue's problem; change still saves */ }
      };
    }
    function changeFor(kind) {
      return function () {
        set({ glass: glassEdit(glass(), theme, current(), kind) });
        if (canPreview) { try { ls.previewGlass(theme, null); } catch (err) { /* fine */ } }
      };
    }

    field.appendChild(el('p', 'set-hint set-glass-title',
      'Glass for the ' + (theme === 'light' ? 'Light' : 'Dark') + ' theme (switch theme to set the other):'));
    blur = glassSlider('Blur', 'set-glass-blur', GLASS_RANGE.blurPx[0], GLASS_RANGE.blurPx[1], g.blurPx,
      function (v) { return v + ' px'; }, inputFor('blur'), changeFor('blur'));
    field.appendChild(blur.row);
    dim = glassSlider('Dim', 'set-glass-dim', Math.round(GLASS_RANGE.dim[0] * 100), Math.round(GLASS_RANGE.dim[1] * 100),
      Math.round(g.dim * 100), function (v) { return v + '%'; }, inputFor('dim'), changeFor('dim'));
    /* Auto: back to the automatic wash (the Dim, raised over a bright
       picture). Pressed while it already is; still focusable, so the
       keyboard can find it and a screen reader hears its state. */
    var autoBtn = el('button', 'set-btn set-glass-auto', 'Auto');
    autoBtn.type = 'button';
    autoBtn.setAttribute('data-glass-auto', '');
    autoBtn.setAttribute('aria-pressed', auto ? 'true' : 'false');
    autoBtn.setAttribute('aria-disabled', auto ? 'true' : 'false');
    autoBtn.setAttribute('aria-label', auto
      ? 'Auto: Dim is automatic, raised over bright pictures so text stays readable'
      : 'Auto: make Dim automatic, raised over bright pictures so text stays readable');
    autoBtn.title = auto ? 'Dim is automatic' : 'Make Dim automatic';
    autoBtn.addEventListener('click', function () {
      if (glass()[theme].dimAuto !== false) return;   // already automatic
      set({ glass: glassEdit(glass(), theme, null, 'auto') });
      if (canPreview) { try { ls.previewGlass(theme, null); } catch (err) { /* fine */ } }
    });
    dim.wrap.appendChild(autoBtn);
    field.appendChild(dim.row);
    var guard = el('p', 'set-note set-glass-guard');
    guard.setAttribute('data-glass-guard', '');
    guard.setAttribute('role', 'status');
    field.appendChild(guard);
    see = glassSlider('See-through', 'set-glass-see', Math.round(-GLASS_RANGE.panel[1] * 100), Math.round(-GLASS_RANGE.panel[0] * 100),
      Math.round(-g.panel * 100), function (v) { return (v > 0 ? '+' : '') + v; }, inputFor('see'), changeFor('see'));
    field.appendChild(see.row);
    field.appendChild(el('p', 'set-hint', 'Quartz paints the picture sharp; Blur is shared with Mantle (its bars and the top-band check). '
      + (theme === 'light' ? 'Dim lays a white tint over the picture' : 'Dim lays a tint over the picture')
      + ' so text stays readable; Auto raises it over bright pictures. See-through makes the panels clearer (+) or more solid (−).'));
    if (!ls) {
      field.appendChild(el('p', 'set-note set-look-warn', LOOK_MISSING
        + '. These values are saved, but nothing in this window applies them until it loads.'));
    } else if (!canPreview) {
      field.appendChild(el('p', 'set-note set-look-warn',
        'No live preview: this look sync module has no previewGlass, so a change shows when you let go.'));
    }
    renderGlassGuard();
  }

  /**
   * The Dim row's mode line (pure): backdrop.js's glass state `gs` for the
   * theme on show, and the stored glass for that theme `g`. backdrop.js
   * writes the whole line (gs.text: "Automatic: ..." / "Manual: ...").
   * An older backdrop.js without it keeps its old wording, worked out here;
   * no state at all is said, never blank.
   */
  function glassGuardText(gs, theme, g) {
    g = g || {};
    var mine = gs && (!gs.theme || gs.theme === theme);
    if (mine && typeof gs.text === 'string' && gs.text.trim()) return gs.text.trim();
    if (!mine) {
      return (g.dimAuto === false ? 'Manual: ' : 'Automatic: ') + dimText(g.dim)
        + ', the background layer has not reported yet.';
    }
    var why = gs.sourceReason ? ': ' + gs.sourceReason : '';
    if (theme === 'light') {
      // CONTRACT "Light look": Mantle's desktop.guard.light while following
      // the desktop, else the Dim unraised and why (no silent fallback).
      if (gs.source === 'shared') {
        return 'Light wash ' + alphaText(gs.alpha) + ', shared with Mantle and Helm (worked out over the top of the screen)' +
          (gs.raised ? '; raised from ' + alphaText(gs.floor) + ' so text stays readable over this dark photo.' : '.');
      }
      return 'Light wash ' + alphaText(gs.alpha) + ' (the Dim, not raised)' + why + '.';
    }
    if (gs.source === 'shared') {
      // CONTRACT "Shared top-band darkening": Mantle's one value for the top
      // of the screen, the same one Mantle's top bar and Helm use.
      return 'Dark wash ' + alphaText(gs.alpha) + ', shared with Mantle and Helm (worked out over the top of the screen)' +
        (gs.raised ? '; raised from ' + alphaText(gs.floor) + ' so text stays readable over this bright photo.' : '.');
    }
    if (gs.source !== 'own' && !gs.raised) return 'Dark wash ' + alphaText(gs.alpha) + ' (the Dim, not raised)' + why + '.';
    // Quartz's own value over its own strip, and why the shared one is not used.
    return (gs.raised
      ? 'Dim raised to ' + alphaText(gs.alpha) + ' over this bright photo so text stays readable'
      : 'Dark wash ' + alphaText(gs.alpha)) +
      ', worked out by Quartz' + why + '.';
  }

  /** The mode line under Dim, from backdrop.js's state (backdropchange). */
  function renderGlassGuard() {
    var note = bodyEl && bodyEl.querySelector('[data-glass-guard]');
    if (!note) return;
    var layer = window.Backdrop;
    var st = null;
    try { st = (layer && typeof layer.state === 'function') ? layer.state() : null; } catch (err) { st = null; }
    var theme = isLight() ? 'light' : 'dark';
    note.textContent = glassGuardText(st && st.glass, theme, glass()[theme]);
    note.hidden = false;
  }

  /**
   * The bookmarks bar switch. The setting is the whole feature's state:
   * bookmarks.js shows or hides the bar from it, and Ctrl+Shift+B writes the
   * same key, so the switch is never out of step with what is on screen.
   */
  function renderBookmarksBar() {
    if (!bodyEl) return;
    var field = bodyEl.querySelector('[data-field="bookmarksbar"]');
    if (!field) return;

    var on = !!get('bookmarksBar');
    field.textContent = '';
    field.appendChild(switchRow('Show the bookmarks bar', on, function (next) {
      set({ bookmarksBar: !!next });
    }));
    field.appendChild(el('p', 'set-hint',
      'Your new-tab shortcuts, under the address bar. Ctrl+Shift+B toggles it.'));
  }

  /** Ctrl+Shift+B, and anything else that wants the bar without the panel. */
  function toggleBookmarksBar() {
    var next = !get('bookmarksBar');
    set({ bookmarksBar: next });
    return next;
  }

  /* ============================================================
     Claude
     The folder the Claude pane beside a page opens in, and whether a restored one
     picks the conversation back up. app.js reads both from the store.
     ============================================================ */

  /* Set to a selector just before a write that re-renders this section, so
     the keyboard lands back on the control that was being used. */
  var claudeFocus = null;

  function buildClaude() {
    var s = section('Claude');
    var dir = el('div', 'set-field');
    dir.setAttribute('data-field', 'claudedir');
    s.appendChild(dir);

    var resume = el('div', 'set-field');
    resume.setAttribute('data-field', 'clauderesume');
    s.appendChild(resume);

    var skip = el('div', 'set-field');
    skip.setAttribute('data-field', 'claudeskip');
    s.appendChild(skip);

    var readTabs = el('div', 'set-field');
    readTabs.setAttribute('data-field', 'claudereadtabs');
    s.appendChild(readTabs);

    var notify = el('div', 'set-field');
    notify.setAttribute('data-field', 'claudenotify');
    s.appendChild(notify);

    var cdp = el('div', 'set-field');
    cdp.setAttribute('data-field', 'claudecdp');
    s.appendChild(cdp);
    return s;
  }

  function renderClaude() {
    renderClaudeDir();
    renderClaudeResume();
    renderClaudeSkip();
    renderClaudeReadTabs();
    renderClaudeNotify();
    renderClaudeCdp();
  }

  /* The always-on DevTools (CDP) port (cdp-main.js). The switch lives in main
     (cdp-prefs.json), not in this page's store: main needs it before the
     window exists. It applies from the next start, and the lines under it say
     what THIS run actually has: on at which port and why, fell back to
     another port and why, off, or failed and why. */
  function cdpStateLine(c) {
    if (!c) return 'DevTools port: the main process did not answer.';
    if (c.ok && c.port) {
      return 'This run: on at 127.0.0.1:' + c.port + ' (' + (c.reason || 'no reason given') + ').';
    }
    return 'This run: no DevTools port. ' + (c.error || c.reason || 'No reason was given.');
  }

  function renderClaudeCdp(answer) {
    var field = bodyEl && bodyEl.querySelector('[data-field="claudecdp"]');
    if (!field) return;
    var app = (window.api && window.api.app) || null;
    if (!app || typeof app.cdp !== 'function') {
      field.textContent = '';
      field.appendChild(el('p', 'set-hint', 'DevTools port: this window has no bridge to the main process, so its state is unknown.'));
      return;
    }
    if (!answer) {
      if (!field.firstChild) field.appendChild(el('p', 'set-hint', 'DevTools port: asking…'));
      Promise.resolve().then(function () { return app.cdp(); }).then(function (c) {
        renderClaudeCdp(c || { ok: false, error: 'the main process did not answer.' });
      }).catch(function (err) {
        renderClaudeCdp({ ok: false, error: 'the main process did not answer (' + ((err && err.message) || err) + ').' });
      });
      return;
    }
    var c = answer;
    field.textContent = '';
    var on = c.enabledNext !== false;
    field.appendChild(switchRow('Let local tools drive this browser (DevTools port)', on, function (next) {
      Promise.resolve().then(function () { return app.setCdpEnabled(next); }).then(function (r) {
        renderClaudeCdp(r || { ok: false, error: 'the main process did not answer.', saveError: 'the setting may not have been saved' });
      }).catch(function (err) {
        renderClaudeCdp(Object.assign({}, c, { saveError: 'the setting was not saved (' + ((err && err.message) || err) + ')' }));
      });
    }));
    field.appendChild(el('p', 'set-hint',
      'Opens the Chrome DevTools Protocol on 127.0.0.1 (port 9219, or a free one if that is taken), so Claude Code '
      + 'or a script on this computer can click, type and read pages in this browser while you stay signed in. '
      + 'It is never reachable from the network, and web pages cannot use it, but any program running as you can.'));
    field.appendChild(el('p', 'set-hint', cdpStateLine(c)));
    if (c.saveError) field.appendChild(el('p', 'set-hint', 'Not saved: ' + c.saveError + '.'));
    if (c.prefsError) field.appendChild(el('p', 'set-hint', 'Setting file: ' + c.prefsError + '.'));
    if (c.governed === false && c.mode !== 'error') {
      field.appendChild(el('p', 'set-hint', 'This run was started with its own DevTools choice (' + (c.reason || c.mode) + '), so the switch does not apply to it.'));
    } else if (c.restartNeeded) {
      field.appendChild(el('p', 'set-hint', (on ? 'Turns on' : 'Turns off') + ' at the next start. Settings > About > Restart browser applies it now.'));
    }
  }

  function renderClaudeDir() {
    var field = bodyEl && bodyEl.querySelector('[data-field="claudedir"]');
    if (!field) return;
    field.textContent = '';

    var current = get('claudeDir');
    var app = (window.api && window.api.app) || null;
    var home = (window.api && window.api.homeDir) || '';

    var label = el('label', 'set-label', 'Start the Claude pane in');
    label.setAttribute('for', 'set-claude-dir');
    field.appendChild(label);

    var row = el('div', 'set-path-row');

    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'set-claude-dir';
    input.className = 'set-path';
    input.value = current || '';
    input.placeholder = 'Your home folder';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.title = 'Type a folder, or choose one';
    row.appendChild(input);

    var note = el('p', 'set-note', 'That folder doesn’t exist');
    note.hidden = true;

    // An older preload has no native dialog: then the field is the only way in.
    if (app && typeof app.pickFolder === 'function') {
      row.appendChild(textButton('Choose…', 'set-btn set-path-pick', function () {
        var answer;
        try { answer = app.pickFolder(current || home || undefined); } catch (err) { return; }
        Promise.resolve(answer).then(function (path) {
          if (typeof path !== 'string' || !path) return;   // null: cancelled
          claudeFocus = '.set-path-pick';
          set({ claudeDir: path });
        }, function () { /* the dialog is gone; leave the value alone */ });
      }));
    }

    if (current) {
      row.appendChild(textButton('Use home', 'set-text set-path-home', function () {
        claudeFocus = '.set-path';
        set({ claudeDir: null });
      }));
    }

    field.appendChild(row);
    field.appendChild(note);

    /* A typed path is only written once main confirms the folder is real;
       until then the previous value stands and the note says why. */
    var before = input.value;
    input.addEventListener('change', function () {      // fires on blur, and on Enter
      var next = input.value.trim();
      note.hidden = true;
      if (next === before) return;
      if (!next) { set({ claudeDir: null }); return; }   // emptied: back to home
      if (!app || typeof app.dirExists !== 'function') { set({ claudeDir: next }); return; }
      var answer;
      try { answer = app.dirExists(next); } catch (err) { set({ claudeDir: next }); return; }
      Promise.resolve(answer).then(function (ok) {
        if (ok) { set({ claudeDir: next }); return; }
        note.hidden = false;
        input.value = before;
      }, function () { set({ claudeDir: next }); });     // unverifiable: take the user's word
    });

    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); return; }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();            // Escape leaves the field, not the panel
        input.value = before;
        note.hidden = true;
        input.blur();
      }
    });

    if (claudeFocus) {
      var target = field.querySelector(claudeFocus);
      claudeFocus = null;
      if (target && typeof target.focus === 'function') target.focus();
    }
  }

  function renderClaudeResume() {
    var field = bodyEl && bodyEl.querySelector('[data-field="clauderesume"]');
    if (!field) return;
    field.textContent = '';

    /* Still live: standalone Claude tabs are gone, but a pane open beside a
       page when Quartz closed is saved with the session and comes back on
       restore as its own tab (app.js restore -> createClaudeTab with
       resume). This switch decides whether that tab runs --continue. The
       words say "pane beside a page" because that is the only Claude
       surface left. */
    field.appendChild(switchRow(
      'Continue the last conversation in a restored Claude pane',
      get('claudeResume') !== false,
      function (next) { set({ claudeResume: next }); }
    ));

    var hint = el('p', 'set-hint');
    hint.appendChild(document.createTextNode('A Claude pane that was open beside a page when Quartz closed comes back as its own tab running '));
    hint.appendChild(el('code', 'set-code', 'claude --continue'));
    hint.appendChild(document.createTextNode(' in its folder. Turn off to start it fresh.'));
    field.appendChild(hint);
  }

  function renderClaudeSkip() {
    var field = bodyEl && bodyEl.querySelector('[data-field="claudeskip"]');
    if (!field) return;
    field.textContent = '';

    field.appendChild(switchRow(
      'Skip permission prompts',
      get('claudeSkipPermissions') === true,
      function (next) { set({ claudeSkipPermissions: next === true }); }
    ));

    field.appendChild(el('p', 'set-hint',
      'Claude runs tools without asking first. Turn on only if you trust what you run.'));

    var hint = el('p', 'set-hint');
    hint.appendChild(document.createTextNode('On, every Claude pane you open starts with '));
    hint.appendChild(el('code', 'set-code', 'claude --dangerously-skip-permissions'));
    hint.appendChild(document.createTextNode('. Off, Claude asks before it runs a tool, as it does in a terminal. '
      + 'Panes opened by Ask or Show Claude hold a web page’s text, so they always ask before acting and run in '
      + 'a scratch folder, whatever this says.'));
    field.appendChild(hint);
  }

  function renderClaudeReadTabs() {
    var field = bodyEl && bodyEl.querySelector('[data-field="claudereadtabs"]');
    if (!field) return;
    field.textContent = '';

    /* Main decides per spawn (mcp-main.js prepareLaunch); this switch only
       says whether a NEW pane gets the tools. A pane already running keeps
       what it started with, which the hint says. */
    field.appendChild(switchRow(
      'Let Claude panes read your open tabs',
      get('claudeReadTabs') !== false,
      function (next) { set({ claudeReadTabs: next === true }); }
    ));

    field.appendChild(el('p', 'set-hint',
      'Claude can list your open web tabs, read a page’s text, search your history and notes, and point at a '
      + 'passage in a page. It cannot click, type or change anything, and Quartz’s own pages are never shared.'));
    field.appendChild(el('p', 'set-hint',
      'Reads always ask you first, over the pane that wants them: Allow once, allow that tab for that pane, '
      + 'or Deny (no answer in a minute is a Deny). This holds even when permission prompts are skipped. '
      + 'Ask Claude about this page counts as allowing that one page.'));
    field.appendChild(el('p', 'set-hint',
      'Off, new Claude panes start without these tools and say so. Panes already open keep what they started with.'));
  }

  function renderClaudeNotify() {
    var field = bodyEl && bodyEl.querySelector('[data-field="claudenotify"]');
    if (!field) return;
    field.textContent = '';

    field.appendChild(switchRow(
      'Notify me when a Claude pane is waiting',
      get('claudeNotify') !== false,
      function (next) { set({ claudeNotify: next }); }
    ));

    field.appendChild(el(
      'p',
      'set-hint',
      'A quiet Windows notification when a session finishes while you’re elsewhere.'
    ));
  }

  function buildTabs() {
    var s = section('Tabs');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'tabsleep');
    s.appendChild(field);
    // The workspace half of the same idea, in the same section: both answers
    // are "what may stop running while you are not looking at it".
    var ws = el('div', 'set-field');
    ws.setAttribute('data-field', 'wssleep');
    s.appendChild(ws);
    return s;
  }

  /** The stored workspace sleep policy; anything unrecognised is the default. */
  function workspaceSleepMode() {
    var value = get('workspaceSleep');
    for (var i = 0; i < WORKSPACE_SLEEP.length; i++) {
      if (WORKSPACE_SLEEP[i].id === value) return value;
    }
    return DEFAULTS.workspaceSleep;
  }

  function renderWorkspaceSleep() {
    var field = bodyEl && bodyEl.querySelector('[data-field="wssleep"]');
    if (!field) return;
    field.textContent = '';

    var mode = workspaceSleepMode();
    field.appendChild(controlRow(
      'In workspaces you are not in, sleep',
      null,
      segmented(WORKSPACE_SLEEP, mode, function (next) {
        set({ workspaceSleep: next });
      })
    ));

    if (mode === 'all') {
      var minutes = Number(get('workspaceSleepMinutes'));
      if (!isFinite(minutes) || minutes < 0) minutes = DEFAULTS.workspaceSleepMinutes;
      field.appendChild(controlRow(
        'once the workspace has been left for',
        'set-ws-sleep',
        glassSelect('set-ws-sleep', WORKSPACE_AWAY_TIMES, minutes, function (value) {
          set({ workspaceSleepMinutes: Number(value) });
        })
      ));
    }

    // One plain sentence per choice — what it does and what it costs.
    var hint = 'Off: every workspace keeps all of its pages running, '
      + 'whether or not you are looking at it.';
    if (mode === 'newtab') {
      hint = 'Sleep new tab pages in workspaces you are not looking at '
        + '(they come back fresh). Nothing else in them sleeps.';
    } else if (mode === 'all') {
      hint = 'Sleep every page in a workspace you have been away from that long '
        + '(pages reload when you return; new tab pages come back fresh). '
        + 'Claude panes and app tabs never sleep.';
    }
    field.appendChild(el('p', 'set-hint', hint));
  }

  function renderTabs() {
    var field = bodyEl && bodyEl.querySelector('[data-field="tabsleep"]');
    if (!field) return;
    field.textContent = '';

    var minutes = Number(get('tabSleepMinutes'));
    if (!isFinite(minutes) || minutes < 0) minutes = DEFAULTS.tabSleepMinutes;

    field.appendChild(controlRow(
      'Put background tabs to sleep after',
      'set-tab-sleep',
      glassSelect('set-tab-sleep', SLEEP_TIMES, minutes, function (value) {
        set({ tabSleepMinutes: Number(value) });
      })
    ));

    field.appendChild(el('p', 'set-hint',
      'Sleeping tabs free their memory and reload when you come back. The time counts from when ' +
      'you leave a tab; a tab sleeps sooner when memory runs low or it holds over 400 MB in the ' +
      'background (hover a sleeping tab to see why). Never means never. Pinned tabs, tabs making sound ' +
      '(or heard in the last 2 minutes) and tabs with unsent typing, a call or picture-in-picture stay ' +
      'awake. After a restart only the tab in front loads; the rest wake when clicked.'));
  }

  function buildDownloads() {
    var s = section('Downloads');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'downloads');
    s.appendChild(field);
    return s;
  }

  function renderDownloads() {
    var field = bodyEl && bodyEl.querySelector('[data-field="downloads"]');
    if (!field) return;
    field.textContent = '';

    var on = get('downloadsAskWhere') === true;
    field.appendChild(switchRow('Ask where to save each file', on, function (next) {
      set({ downloadsAskWhere: !!next });
    }));
    field.appendChild(el('p', 'set-hint',
      'Off: files go straight to your Downloads folder.'));
  }

  function buildSearch() {
    var s = section('Search');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'engine');
    s.appendChild(field);
    s.appendChild(el('p', 'set-hint', 'Used by the address bar and the new tab page.'));

    /* The Brave Search API key for Quartz's own results page. */
    var bk = el('div', 'set-field set-field-gap');
    bk.setAttribute('data-field', 'bravekey');
    s.appendChild(bk);

    /* The Claude API key and settings for the AI answer above Quartz results. */
    var ck = el('div', 'set-field set-field-gap');
    ck.setAttribute('data-field', 'claudekey');
    s.appendChild(ck);

    /* Keywords sit under the engine they bypass: same section, own field. */
    var kw = el('div', 'set-field');
    kw.setAttribute('data-field', 'keywords');
    s.appendChild(kw);
    return s;
  }

  function renderSearch() {
    var field = bodyEl && bodyEl.querySelector('[data-field="engine"]');
    if (!field) return;
    field.textContent = '';
    field.appendChild(optionList(engines(), get('searchEngine'), function (id) {
      set({ searchEngine: id });
    }));
    renderBraveKey();
    renderClaudeKey();
  }

  /* ============================================================
     The Brave Search API key (Quartz's own results page)

     Same one-way arrangement as the Finnhub key: main keeps it in
     <userData>/brave-search.json and answers describe() with
     `hasKey` and a mask, never the key. The field is never pre-filled;
     the mask is its placeholder. "Check key" spends one real search
     and says what Brave answered. The status line under it is what
     the last real search said, so a key that stopped working is
     visible here as well as on the page.
     ============================================================ */

  var bkState = null;      // the last describe() from main, or null
  var bkShowKey = false;   // the eye: reveals what is being TYPED only
  var bkBusy = false;      // a Check in flight
  var bkFocus = '';

  function braveApi() {
    var api = window.api && window.api.braveSearch;
    return api && typeof api.describe === 'function' ? api : null;
  }

  function braveTake(answer) {
    if (!answer || typeof answer !== 'object') return;
    bkState = answer;
    renderBraveKey();
    if (bkFocus) {
      var back = panelEl && panelEl.querySelector(bkFocus);
      bkFocus = '';
      if (back) { try { back.focus(); } catch (err) { /* re-rendered away */ } }
    }
  }

  function braveCall(method, arg, failed) {
    var api = braveApi();
    if (!api || typeof api[method] !== 'function') { showToast(failed); return; }
    var answer;
    try { answer = api[method](arg); } catch (err) { showToast(failed); return; }
    Promise.resolve(answer).then(function (value) {
      bkBusy = false;
      if (value) braveTake(value);
      else { renderBraveKey(); showToast(failed); }
    }, function () { bkBusy = false; renderBraveKey(); showToast(failed); });
  }

  /** One describe() when the pane opens. */
  function braveRefresh() {
    var api = braveApi();
    if (!api) { bkState = null; renderBraveKey(); return; }
    try {
      Promise.resolve(api.describe()).then(function (value) {
        if (value) braveTake(value);
      }, function () { /* the last state stays up */ });
    } catch (err) { /* nothing to take */ }
  }

  function braveStatusLine(st) {
    if (!st) return '';
    if (st.check) {
      return (st.check.ok ? 'Checked: ' : 'Check failed: ') + st.check.title +
        (st.check.ok ? '.' : '. ' + (st.check.detail || ''));
    }
    if (!st.hasKey) return '';
    var parts = [];
    if (st.last) parts.push('Last search: ' + (st.last.ok ? 'worked' : st.last.title) + '.');
    if (st.usage && typeof st.usage.remaining === 'number' && typeof st.usage.limit === 'number') {
      parts.push(st.usage.remaining.toLocaleString() + ' of ' + st.usage.limit.toLocaleString() +
        ' searches left this month, by Brave’s last answer.');
    }
    return parts.join(' ');
  }

  function renderBraveKey() {
    var field = bodyEl && bodyEl.querySelector('[data-field="bravekey"]');
    if (!field) return;
    var typed = '';
    var live = field.querySelector('.set-path');
    if (live) typed = live.value;
    field.textContent = '';

    var label = el('label', 'set-label', 'Brave Search API key');
    label.setAttribute('for', 'set-brave-key');
    field.appendChild(label);

    if (!braveApi()) {
      field.appendChild(el('p', 'set-typing-notice',
        'This build has no bridge to the search page, so Quartz results cannot work here. Restart Quartz to pick up the newer build.'));
      return;
    }

    var has = !!(bkState && bkState.hasKey);
    var mask = (bkState && bkState.keyMask) || '';
    var row = el('div', 'set-path-row');

    var input = document.createElement('input');
    input.type = bkShowKey ? 'text' : 'password';
    input.id = 'set-brave-key';
    input.className = 'set-path';
    input.value = typed;
    input.placeholder = has ? mask : 'Paste your key';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.title = has ? 'A key is saved. Type to replace it.' : 'Paste the key from your Brave Search API dashboard';
    row.appendChild(input);

    row.appendChild(textButton(bkShowKey ? 'Hide' : 'Show', 'set-text set-brave-eye', function () {
      bkShowKey = !bkShowKey;
      renderBraveKey();
      var again = field.querySelector('.set-path');
      if (again) { try { again.focus(); } catch (err) { /* gone */ } }
    }));

    row.appendChild(textButton('Save', 'set-btn set-brave-save', function () {
      var now = field.querySelector('.set-path');
      var next = now ? now.value.trim() : '';
      if (!next) return;
      bkShowKey = false;
      bkFocus = '.set-brave-save';
      if (now) now.value = '';
      braveCall('setKey', next, 'That key could not be saved');
    }));

    if (has) {
      var check = textButton(bkBusy ? 'Checking…' : 'Check key', 'set-text set-brave-check', function () {
        if (bkBusy) return;
        bkBusy = true;
        renderBraveKey();
        braveCall('test', undefined, 'The key could not be checked');
      });
      check.title = 'Runs one real search (it counts toward the month)';
      row.appendChild(check);
      row.appendChild(textButton('Remove', 'set-text set-brave-clear', function () {
        bkShowKey = false;
        bkFocus = '#set-brave-key';
        braveCall('setKey', '', 'That key could not be removed');
      }));
    }
    field.appendChild(row);

    input.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var save = field.querySelector('.set-brave-save');
      if (save) save.click();
    });

    if (bkState && bkState.error) field.appendChild(el('p', 'set-note set-brave-error', bkState.error));
    keyAtRestNotes(field, bkState, 'set-brave');
    var status = braveStatusLine(bkState);
    if (status) field.appendChild(el('p', 'set-note set-brave-status', status));

    var own = engineFor(get('searchEngine')).own;
    var where = 'Get one at brave.com/search/api (the Search plan; set a monthly limit in its dashboard). ' +
      'Stored by the browser itself and never given to a page.';
    var lead = !own ? 'For “Quartz results (Brave)” above: Quartz’s own results page. '
      : has ? 'Quartz results uses this key. '
        : 'Quartz results needs this key: until it is saved, searches show a page saying so, with the plain Brave search one click away. ';
    field.appendChild(el('p', 'set-hint', lead + where));
  }

  /**
   * Beside a key field: how main keeps that key at rest (secret-store.js status(): never the key).
   * A saved key that could not be decrypted says so and asks for the key again; a key kept in plain
   * text because encryption is unavailable says "stored unencrypted: <reason>". Encrypted and fine
   * says nothing. Shared by the Brave, TMDB and Finnhub key fields.
   */
  function keyAtRestNotes(field, st, prefix) {
    if (!st) return;
    if (st.keyError) field.appendChild(el('p', 'set-note ' + prefix + '-key-error', st.keyError));
    if (st.keyStorageNote) field.appendChild(el('p', 'set-note ' + prefix + '-key-storage', 'Key ' + st.keyStorageNote + '.'));
  }

  /* ============================================================
     The Claude API key (the AI answer above Quartz results)

     main (claudeanswer.js) keeps the key in <userData>/claude-answer.json,
     ENCRYPTED with safeStorage (DPAPI), and answers describe() with
     `hasKey` and a mask, never the key. "Check key" is GET /v1/models,
     which costs nothing. Under it: when answers run (the mode), a
     read-only line naming the one model (Claude Haiku 5.5, high effort)
     that writes every answer, the monthly cap, and this month's spend as
     Quartz estimates it. Every refusal from main comes back with
     `error` and is printed here, never swallowed.
     ============================================================ */

  var ckState = null;      // the last describe() from main, or null
  var ckShowKey = false;   // the eye: reveals what is being TYPED only
  var ckBusy = false;      // a Check in flight
  var ckFocus = '';

  function claudeApi() {
    var api = window.api && window.api.claudeAnswer;
    return api && typeof api.describe === 'function' ? api : null;
  }

  function claudeTake(answer) {
    if (!answer || typeof answer !== 'object') return;
    ckState = answer;
    renderClaudeKey();
    if (ckFocus) {
      var back = panelEl && panelEl.querySelector(ckFocus);
      ckFocus = '';
      if (back) { try { back.focus(); } catch (err) { /* re-rendered away */ } }
    }
  }

  function claudeCall(method, arg, failed) {
    var api = claudeApi();
    if (!api || typeof api[method] !== 'function') { showToast(failed); return; }
    var answer;
    try { answer = api[method](arg); } catch (err) { showToast(failed); return; }
    Promise.resolve(answer).then(function (value) {
      ckBusy = false;
      if (value) claudeTake(value);
      else { renderClaudeKey(); showToast(failed); }
    }, function () { ckBusy = false; renderClaudeKey(); showToast(failed); });
  }

  /** One describe() when the pane opens. */
  function claudeRefresh() {
    var api = claudeApi();
    if (!api) { ckState = null; renderClaudeKey(); return; }
    try {
      Promise.resolve(api.describe()).then(function (value) {
        if (value) claudeTake(value);
      }, function () { /* the last state stays up */ });
    } catch (err) { /* nothing to take */ }
  }

  function claudeStatusLine(st) {
    if (!st) return '';
    if (st.check) {
      return (st.check.ok ? 'Checked: ' : 'Check failed: ') + st.check.title + '. ' + (st.check.detail || '');
    }
    if (!st.hasKey || !st.last) return '';
    return 'Last answer: ' + (st.last.ok ? 'worked.' : st.last.title + '. ' + (st.last.detail || ''));
  }

  function usd(n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    return '$' + v.toFixed(2);
  }

  /** What leaves the machine, in plain words, for the mode that is set. */
  function claudeDisclosure(st) {
    var has = !!(st && st.hasKey);
    var mode = (st && st.mode) || 'every';
    var which = mode === 'manual' ? 'a search, when you press “Ask Claude” on Quartz results,'
      : mode === 'questions' ? 'each web search on Quartz results that reads as a question'
        : 'each web search on Quartz results';
    var flow = which + ' is sent to Anthropic (api.anthropic.com), along with any follow-up you type into the answer box, ' +
      'so Claude can write the answer and search the web for its sources. Brave still supplies the results list.';
    return has
      ? 'With this key, ' + flow
      : 'Without a key nothing is sent to Anthropic. With one, ' + flow;
  }

  function renderClaudeKey() {
    var field = bodyEl && bodyEl.querySelector('[data-field="claudekey"]');
    if (!field) return;
    var typed = '';
    var live = field.querySelector('#set-claude-key');
    if (live) typed = live.value;
    var capTyped = null;
    var capLive = field.querySelector('#set-claude-cap');
    if (capLive && capLive === document.activeElement) capTyped = capLive.value;
    field.textContent = '';

    var label = el('label', 'set-label', 'Claude API key (AI answers)');
    label.setAttribute('for', 'set-claude-key');
    field.appendChild(label);

    if (!claudeApi()) {
      field.appendChild(el('p', 'set-typing-notice',
        'This build has no bridge for AI answers, so they cannot work here. Restart Quartz to pick up the newer build.'));
      return;
    }

    var st = ckState || {};
    var has = !!st.hasKey;
    var row = el('div', 'set-path-row');

    var input = document.createElement('input');
    input.type = ckShowKey ? 'text' : 'password';
    input.id = 'set-claude-key';
    input.className = 'set-path';
    input.value = typed;
    input.placeholder = has ? (st.keyMask || '') : 'Paste your key (sk-ant-…)';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.title = has ? 'A key is saved. Type to replace it.' : 'Paste an API key from platform.claude.com/settings/keys';
    row.appendChild(input);

    row.appendChild(textButton(ckShowKey ? 'Hide' : 'Show', 'set-text set-claude-eye', function () {
      ckShowKey = !ckShowKey;
      renderClaudeKey();
      var again = field.querySelector('#set-claude-key');
      if (again) { try { again.focus(); } catch (err) { /* gone */ } }
    }));

    row.appendChild(textButton('Save', 'set-btn set-claude-save', function () {
      var now = field.querySelector('#set-claude-key');
      var next = now ? now.value.trim() : '';
      if (!next) return;
      ckShowKey = false;
      ckFocus = '.set-claude-save';
      if (now) now.value = '';
      claudeCall('setKey', next, 'That key could not be saved');
    }));

    if (has) {
      var check = textButton(ckBusy ? 'Checking…' : 'Check key', 'set-text set-claude-check', function () {
        if (ckBusy) return;
        ckBusy = true;
        renderClaudeKey();
        claudeCall('test', undefined, 'The key could not be checked');
      });
      check.title = 'Asks Anthropic for its model list: free, no answer is written';
      row.appendChild(check);
      row.appendChild(textButton('Remove', 'set-text set-claude-clear', function () {
        ckShowKey = false;
        ckFocus = '#set-claude-key';
        claudeCall('setKey', '', 'That key could not be removed');
      }));
    }
    field.appendChild(row);

    input.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var save = field.querySelector('.set-claude-save');
      if (save) save.click();
    });

    if (st.error) field.appendChild(el('p', 'set-note set-claude-error', st.error));
    if (st.keyError) field.appendChild(el('p', 'set-note set-claude-error', st.keyError));
    if (ckState && ckState.canEncrypt === false && !has) {
      field.appendChild(el('p', 'set-note set-claude-error',
        'Windows cannot encrypt a key in this profile right now (safeStorage is unavailable), so Quartz will not store one.'));
    }
    var status = claudeStatusLine(st);
    if (status) field.appendChild(el('p', 'set-note set-claude-status', status));

    field.appendChild(el('p', 'set-hint set-claude-privacy', claudeDisclosure(st) + ' ' +
      'Make a key at platform.claude.com/settings/keys. Quartz encrypts it with Windows (DPAPI) in this profile and never gives it to a page.'));

    /* When answers run, and the model that writes them. */
    var modes = Array.isArray(st.modes) && st.modes.length ? st.modes
      : [{ id: 'every', name: 'Answer every search' }, { id: 'questions', name: 'Only questions' }, { id: 'manual', name: 'Only when I ask' }];
    field.appendChild(controlRow('AI answers', 'set-claude-mode', glassSelect('set-claude-mode',
      modes.map(function (m) { return { value: m.id, name: m.name }; }), st.mode || 'every', function (v) {
        ckFocus = '#set-claude-mode';
        claudeCall('setConfig', { mode: v }, 'That could not be saved');
      })));
    /* One model only (requested 10-17: "only haiku"): a quiet read-only line, no picker. */
    var modelName = (st.answerModelLabel && String(st.answerModelLabel)) || 'Claude Haiku 5.5';
    field.appendChild(el('p', 'set-hint set-claude-model',
      'Answers by ' + modelName + ' (high effort), about a tenth of a cent an answer plus $0.01 a search. ' +
      '“Deeper answer” searches more and writes more.'));

    /* The monthly cap: answers stop with "cap reached" once the estimate gets there. */
    var capRow = el('div', 'set-path-row');
    var cap = document.createElement('input');
    cap.type = 'text';
    cap.id = 'set-claude-cap';
    cap.className = 'set-path set-claude-cap';
    cap.setAttribute('inputmode', 'decimal');
    cap.spellcheck = false;
    cap.autocomplete = 'off';
    cap.value = capTyped !== null ? capTyped : (typeof st.capUsd === 'number' ? st.capUsd.toFixed(2) : '150.00');
    cap.title = 'Answers stop for the rest of the month once Quartz’s estimate reaches this many dollars';
    capRow.appendChild(cap);
    capRow.appendChild(textButton('Save cap', 'set-text set-claude-capsave', function () {
      var v = field.querySelector('#set-claude-cap');
      ckFocus = '.set-claude-capsave';
      claudeCall('setConfig', { capUsd: v ? v.value : '' }, 'The cap could not be saved');
    }));
    cap.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var b = field.querySelector('.set-claude-capsave');
      if (b) b.click();
    });
    var capLabel = el('label', 'set-ctl-label', 'Monthly cap (US$)');
    capLabel.setAttribute('for', 'set-claude-cap');
    field.appendChild(capLabel);
    field.appendChild(capRow);

    var m = st.month || {};
    var spend = 'This month: ' + usd(m.spentUsd) + ' estimated · ' + (m.answers || 0) + (m.answers === 1 ? ' answer' : ' answers') +
      ' (cap ' + usd(typeof m.capUsd === 'number' ? m.capUsd : st.capUsd) + ')' + (m.capReached ? ' — cap reached, answers are paused until next month or a higher cap.' : '.');
    field.appendChild(el('p', 'set-note set-claude-usage', spend));
    field.appendChild(el('p', 'set-hint set-claude-estimate',
      'That figure is Quartz’s own estimate: the token and web-search counts Anthropic reports for each answer, times the prices Anthropic published' +
      (st.pricesChecked ? ' (as of ' + st.pricesChecked + ')' : '') + ', plus $0.01 a web search. ' +
      'Quartz can’t see your real credit balance; that is at platform.claude.com/settings/billing.'));
  }

  /**
   * The keyword list, built from the shortcut rows (.set-chip / chipInput) so
   * it reads like the New tab list: a row is the keyword and the name on one
   * line, the address template under them, and a remove button. A row the
   * check refuses is still saved (as disabled), and the reason is printed
   * right under it with the amber pip, so a bad row is never silently dead.
   *
   * A cell commits on blur. The write is put off one tick so the redraw it
   * causes can see where focus went (Tab into the next cell) and put it back
   * there, instead of dropping focus on every cell you leave.
   */
  function renderKeywords() {
    var field = bodyEl && bodyEl.querySelector('[data-field="keywords"]');
    if (!field) return;

    // Where focus was inside this field before the redraw, to restore after.
    var active = document.activeElement;
    var refocus = null;
    if (active && field.contains(active) && active.getAttribute('data-kw-cell')) {
      refocus = {
        cell: active.getAttribute('data-kw-cell'),
        start: active.selectionStart,
        end: active.selectionEnd
      };
    }

    field.textContent = '';
    field.appendChild(el('p', 'set-label', 'Keywords'));

    if (!keywordRules()) {
      field.appendChild(el('p', 'set-typing-notice',
        'Keyword search is off: keywords.js did not load, so the address bar only uses the engine above.'));
      return;
    }

    field.appendChild(el('p', 'set-hint',
      'Type a keyword, a space, then your search: “gh helm” searches GitHub for helm. ' +
      'In the address, %s is where the search goes.'));

    var list = keywordList();
    var rows = el('div', 'set-chips set-kws');

    if (!list.length) {
      rows.appendChild(el('p', 'set-empty', 'No keywords. Add one below, or reset to the defaults.'));
    }

    function editRow(index, patch) {
      setTimeout(function () {
        var next = keywordList();
        if (!next[index]) return;
        for (var k in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) next[index][k] = patch[k];
        }
        setKeywords(next);
      }, 0);
      return true;     // always kept: an invalid value is saved disabled, and says so
    }

    list.forEach(function (kw, index) {
      var wrap = el('div', 'set-kw' + (kw.ok ? '' : ' is-off'));
      var row = el('div', 'set-chip');

      var texts = el('div', 'set-chip-texts');
      var line = el('div', 'set-kw-line');
      var keyIn = chipInput(kw.key, 'is-key', 'Keyword', function (next) {
        return editRow(index, { key: next });
      });
      keyIn.setAttribute('data-kw-cell', index + ':key');
      keyIn.setAttribute('aria-label', 'Keyword');
      var nameIn = chipInput(kw.name, 'is-label', 'Name', function (next) {
        return editRow(index, { name: next });
      });
      nameIn.setAttribute('data-kw-cell', index + ':name');
      nameIn.setAttribute('aria-label', 'Name');
      line.appendChild(keyIn);
      line.appendChild(nameIn);
      texts.appendChild(line);
      var urlIn = chipInput(kw.url, 'is-url', 'https://example.com/search?q=%s', function (next) {
        return editRow(index, { url: next });
      });
      urlIn.setAttribute('data-kw-cell', index + ':url');
      urlIn.setAttribute('aria-label', 'Address with %s');
      texts.appendChild(urlIn);
      row.appendChild(texts);

      var acts = el('div', 'set-chip-acts');
      acts.appendChild(iconButton(GLYPH_DELETE, 'Remove keyword ' + (kw.key || ''), 'set-act', function () {
        var next = keywordList();
        next.splice(index, 1);
        setKeywords(next);
      }));
      row.appendChild(acts);
      wrap.appendChild(row);

      if (!kw.ok) {
        wrap.appendChild(el('p', 'set-kw-msg', 'Off: ' + kw.reason));
      }
      rows.appendChild(wrap);
    });
    field.appendChild(rows);

    /* The add row: keyword, name and template; Enter in the address adds it.
       It is added even when it fails the check, and then says why above. */
    var add = el('div', 'set-chip set-chip-add');
    var addTexts = el('div', 'set-chip-texts');
    var addLine = el('div', 'set-kw-line');
    function addInput(cls, placeholder, label) {
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'set-chip-text ' + cls;
      input.placeholder = placeholder;
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.setAttribute('aria-label', label);
      return input;
    }
    var keyAdd = addInput('is-key', 'Keyword', 'New keyword');
    keyAdd.setAttribute('data-kw-cell', 'add:key');
    var nameAdd = addInput('is-label', 'Name', 'New keyword name');
    var urlAdd = addInput('is-url', 'https://example.com/search?q=%s', 'New keyword address with %s');
    addLine.appendChild(keyAdd);
    addLine.appendChild(nameAdd);
    addTexts.appendChild(addLine);
    addTexts.appendChild(urlAdd);
    add.appendChild(addTexts);

    function commitAdd() {
      var key = keyAdd.value.trim();
      var url = urlAdd.value.trim();
      if (!key && !url) { keyAdd.focus(); return; }
      var next = keywordList();
      next.push({ key: key, name: nameAdd.value.trim(), url: url });
      var stored = setKeywords(next);
      var last = stored[stored.length - 1];
      if (last && last.ok) {
        showToast('Keyword “' + last.key + '” added');
      } else {
        showToast('Added, but off: ' + (last ? last.reason : 'it could not be checked.'));
      }
      var again = field.querySelector('[data-kw-cell="add:key"]');
      if (again) again.focus();
    }
    [keyAdd, nameAdd].forEach(function (input, i) {
      input.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        (i === 0 ? nameAdd : urlAdd).focus();
      });
    });
    urlAdd.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); commitAdd(); }
    });
    add.appendChild(iconButton(GLYPH_ADD, 'Add keyword', 'set-act', commitAdd));
    field.appendChild(add);

    var reset = textButton('Reset to defaults', 'set-btn', function () {
      resetKeywords();
      showToast('Keywords reset to the defaults');
    });
    reset.disabled = !Array.isArray(get('keywords'));
    field.appendChild(reset);

    if (refocus) {
      var target = field.querySelector('[data-kw-cell="' + refocus.cell + '"]');
      if (target) {
        target.focus();
        try {
          if (refocus.start != null) target.setSelectionRange(refocus.start, refocus.end);
        } catch (err) { /* not a text cell */ }
      }
    }
  }

  function buildSites() {
    var s = section('Websites');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'sitetheme');
    s.appendChild(field);
    s.appendChild(el('p', 'set-hint',
      'Sites that offer a dark mode follow this. Pages with no theme of their own always stay light.'));
    return s;
  }

  function renderSites() {
    var field = bodyEl && bodyEl.querySelector('[data-field="sitetheme"]');
    if (!field) return;
    field.textContent = '';
    field.appendChild(optionList(SITE_THEMES, get('siteTheme'), function (id) {
      set({ siteTheme: id });
    }));
  }

  /* ============================================================
     Site styles

     These do NOT live in the settings object: window.SiteStyles owns its own
     storage and pushes every change into the open tabs itself. The panel is
     one more view of it, and a build without that module simply says so.
     ============================================================ */

  /** The module, or null when this build shipped without it. */
  function siteStyles() {
    var m = window.SiteStyles;
    if (!m) return null;
    if (typeof m.hosts !== 'function' || typeof m.get !== 'function') return null;
    if (typeof m.set !== 'function' || typeof m.remove !== 'function') return null;
    return m;
  }

  /** Re-render whenever the module changes, whoever changed it. Once. */
  function bindSiteStyles(api) {
    if (siteBound || typeof api.on !== 'function') return;
    siteBound = true;
    try {
      api.on(function () { if (bodyEl) renderSiteStyles(); });
    } catch (err) { siteBound = false; }
  }

  /**
   * What someone types vs. what a host actually is: 'https://WWW.Example.com/x'
   * and 'Example.com' are the same site, and the list should say so once.
   */
  function normalizeHost(raw) {
    var s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z][a-z0-9+.\-]*:\/\//, '');   // scheme
    s = s.split(/[/?#]/)[0];                          // path, query, fragment
    s = s.replace(/^[^@]*@/, '');                     // user:pass@
    s = s.replace(/^www\./, '');
    s = s.replace(/\.+$/, '');                        // the root dot
    if (!s || /\s/.test(s)) return '';
    return s;
  }

  /** A host is safe inside a selector once its two dangerous glyphs are. */
  function attrEscape(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * The open tab, when it is the one this entry would act on. app.js owns
   * both globals; a build without them simply has no "Run now" to offer.
   * Matching goes through the module so a parent-domain entry counts for
   * its subdomains, exactly as it does when the page loads.
   */
  function activeTabFor(api, host) {
    if (typeof window.getActiveTab !== 'function') return null;
    if (typeof window.readCurrentUrl !== 'function') return null;
    var tab = null;
    try { tab = window.getActiveTab(); } catch (err) { return null; }
    if (!tab) return null;
    var url = '';
    try { url = String(window.readCurrentUrl(tab) || ''); } catch (err) { return null; }
    if (!url) return null;
    var matched = null;
    try {
      matched = typeof api.matchFor === 'function' ? api.matchFor(url) : null;
    } catch (err) { matched = null; }
    if (matched) return matched.host === host ? tab : null;
    var open = '';
    try {
      open = typeof api.hostFromUrl === 'function'
        ? String(api.hostFromUrl(url) || '')
        : normalizeHost(url);
    } catch (err) { open = normalizeHost(url); }
    return open === host ? tab : null;
  }

  /* ============================================================
     Protected video -- drm.js / drm-main.js

     Stock Electron cannot play DRM video (Prime Video, Netflix, ...). This
     says so plainly, says whether Edge was found for the bar's button, and
     lists the sites set to "Always use Edge" with a way to take each back.
     The state lives in MAIN (<userData>/drm.json); window.Drm keeps the last
     copy and fires 'drmchange' on document when it moves.
     ============================================================ */

  var drmErr = '';   // the last failed write, shown until the next one

  function drmApi() {
    var api = window.api && window.api.drm;
    return api && typeof api.setAlways === 'function' ? api : null;
  }

  function buildDrm() {
    var s = section('Protected video');
    s.setAttribute('data-section', 'drm');
    var main = el('div', 'set-field');
    main.setAttribute('data-field', 'drm');
    s.appendChild(main);
    var list = el('div', 'set-field');
    list.setAttribute('data-field', 'drmsites');
    s.appendChild(list);
    return s;
  }

  function renderDrm() {
    var field = bodyEl && bodyEl.querySelector('[data-field="drm"]');
    var listField = bodyEl && bodyEl.querySelector('[data-field="drmsites"]');
    if (!field || !listField) return;
    field.textContent = '';
    listField.textContent = '';
    var mod = window.Drm;
    var st = mod && typeof mod.state === 'function' ? mod.state() : null;
    if (!mod || !drmApi()) {
      var none = el('p', 'set-typing-notice', 'Protected video settings cannot be shown: this window has no channel to the browser. Restarting Quartz usually brings it back.');
      none.setAttribute('role', 'status');
      field.appendChild(none);
      return;
    }
    if (!st) {
      field.appendChild(el('p', 'set-hint', 'Reading protected video settings…'));
      mod.refresh().then(function () { renderDrm(); refreshFilter(); }, function (err) {
        field.textContent = '';
        field.appendChild(el('p', 'set-note', 'Protected video settings could not be read: ' + ((err && err.message) || 'no reason given') + '.'));
      });
      return;
    }
    var wv = st.widevine || {};
    // services: the CDM is in AND Quartz.exe is signed for streaming (drm-main.js widevine()).
    var canServices = wv.services === true || (wv.services === undefined && wv.available);
    var drmLine = canServices
      ? 'This build of Quartz can play DRM-protected video. ' + (wv.reason || '')
      : (wv.available
        ? 'Widevine is installed, but streaming services will refuse to play here yet. ' + (wv.reason || '') +
          ' Until then Lumen opens Prime Video, Disney+ and the rest in Microsoft Edge, and their pages offer Edge.'
        : 'Quartz can’t play DRM-protected video yet (Prime Video, Netflix, Disney+, Spotify and similar): ' +
          String(wv.reason || 'no reason was given').replace(/[.\s]+$/, '') + '. ' +
          'On those pages a bar offers to open the same page in Microsoft Edge.');
    var drmHint = el('p', 'set-hint', drmLine);
    drmHint.setAttribute('data-drm-widevine', canServices ? 'services' : (wv.available ? 'cdm-only' : 'none'));
    field.appendChild(drmHint);
    var edge = st.edge || {};
    field.appendChild(el('p', 'set-hint', edge.found
      ? 'Microsoft Edge: found' + (edge.path ? ' (' + edge.path + ')' : '') + '.'
      : (edge.how === 'protocol'
        ? 'Microsoft Edge: msedge.exe was not found in its usual folders; Quartz will ask Windows to open Edge instead.'
        : 'Microsoft Edge was not found on this PC, so the bar’s button will say it could not open it.')));
    if (st.detection) field.appendChild(el('p', 'set-hint', st.detection));
    if (st.lastLaunch && !st.lastLaunch.ok) {
      field.appendChild(el('p', 'set-note', 'The last attempt to open Edge failed: ' + (st.lastLaunch.reason || 'no reason given') + '.'));
    }
    if (drmErr) field.appendChild(el('p', 'set-note', drmErr));

    listField.appendChild(el('p', 'set-label', 'Always open in Microsoft Edge'));
    var rows = el('div', 'set-chips');
    rows.setAttribute('data-drm-rows', 'always');
    var list = Array.isArray(st.alwaysEdge) ? st.alwaysEdge : [];
    if (!list.length) {
      rows.appendChild(el('p', 'set-empty', 'None. Choose “Always use Edge” on a protected video page to add one.'));
    }
    list.forEach(function (item, i) {
      var row = typingRow('drm', item.name || item.key, i, 'Open ' + (item.name || item.key) + ' in Quartz again', function () {
        drmApi().setAlways(item.key, false).then(function (r) {
          drmErr = r && r.ok ? '' : (item.name || item.key) + ' could not be taken off the list: ' + ((r && r.reason) || 'no reason given') + '.';
          return mod.refresh();
        }, function (err) {
          drmErr = (item.name || item.key) + ' could not be taken off the list: ' + ((err && err.message) || 'no reason given') + '.';
          renderDrm();
        }).then(function () { renderDrm(); });
      });
      row.setAttribute('data-drm-key', item.key);
      rows.appendChild(row);
    });
    listField.appendChild(rows);
  }

  document.addEventListener('drmchange', function () { if (bodyEl) { renderDrm(); refreshFilter(); } });

  function buildSiteStyles() {
    var s = section('Site styles and scripts');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'sitestyles');
    s.appendChild(field);
    return s;
  }

  /** One site: its name, its dark switch, and the code drawer under them. */
  function siteRow(api, host) {
    var rec = null;
    try { rec = api.get(host); } catch (err) { rec = null; }
    rec = rec || { css: '', dark: false, js: '' };

    var row = el('div', 'set-site');
    row.setAttribute('data-host', host);

    var head = el('div', 'set-site-head');
    head.appendChild(el('span', 'set-site-host', host));

    var sw = switchRow('Dark', !!rec.dark, function (next) {
      try { api.set(host, { dark: next }); } catch (err) { /* module's problem */ }
      renderSiteStyles();
    });
    sw.classList.add('is-inline');
    sw.title = 'Force dark mode on ' + host;
    head.appendChild(sw);

    var expanded = siteOpen === host;
    var edit = textButton('Edit', 'set-text set-site-edit', function () {
      siteOpen = expanded ? null : host;
      siteFocus = expanded ? null : '.set-site[data-host="' + attrEscape(host) + '"] .set-css';
      renderSiteStyles();
    });
    edit.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    head.appendChild(edit);
    row.appendChild(head);

    if (!expanded) return row;

    // Escape leaves the field first; a second press then closes the panel.
    function escapesOut(node) {
      node.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        node.blur();
      });
    }

    var editor = el('div', 'set-site-editor');
    editor.appendChild(el('p', 'set-hint', 'CSS'));
    var ta = document.createElement('textarea');
    ta.className = 'set-css';
    ta.spellcheck = false;
    ta.setAttribute('aria-label', 'Custom CSS for ' + host);
    ta.value = typeof rec.css === 'string' ? rec.css : '';
    escapesOut(ta);
    editor.appendChild(ta);

    editor.appendChild(el('p', 'set-hint', 'JavaScript'));
    var js = document.createElement('textarea');
    js.className = 'set-js';
    js.spellcheck = false;
    js.placeholder = '// runs after the page loads';
    js.setAttribute('aria-label', 'Custom JavaScript for ' + host);
    js.value = typeof rec.js === 'string' ? rec.js : '';
    escapesOut(js);
    editor.appendChild(js);

    var acts = el('div', 'set-site-acts');
    acts.appendChild(textButton('Save', 'set-btn', function () {
      try { api.set(host, { css: ta.value, js: js.value }); } catch (err) { /* module's problem */ }
      var toast = window.Toast;
      if (toast && typeof toast.show === 'function') toast.show('Saved ' + host);
    }));

    /* Only when this site is the one on screen: re-applying to a tab that
       is somewhere else would be a button that visibly does nothing. */
    if (activeTabFor(api, host) && typeof api.applyTo === 'function') {
      acts.appendChild(textButton('Run now', 'set-text set-site-run', function () {
        var tab = activeTabFor(api, host);
        if (!tab) return;
        try { api.applyTo(tab); } catch (err) { /* module's problem */ }
        var toast = window.Toast;
        if (toast && typeof toast.show === 'function') toast.show('Ran on ' + host);
      }));
    }
    acts.appendChild(textButton('Remove site', 'set-text set-site-remove', function () {
      try { api.remove(host); } catch (err) { /* module's problem */ }
      if (siteOpen === host) siteOpen = null;
      renderSiteStyles();
    }));
    editor.appendChild(acts);
    row.appendChild(editor);
    return row;
  }

  function renderSiteStyles() {
    var field = bodyEl && bodyEl.querySelector('[data-field="sitestyles"]');
    if (!field) return;
    field.textContent = '';

    var api = siteStyles();
    if (!api) {
      field.appendChild(el('p', 'set-na', 'Not available'));
      return;
    }
    bindSiteStyles(api);

    if (typeof api.globalDark === 'function' && typeof api.setGlobalDark === 'function') {
      var on_ = false;
      try { on_ = !!api.globalDark(); } catch (err) { on_ = false; }
      field.appendChild(switchRow('Force dark mode on every site', on_, function (next) {
        try { api.setGlobalDark(next); } catch (err) { /* module's problem */ }
        renderSiteStyles();
      }));
      field.appendChild(el('p', 'set-hint', 'Sites that are already dark are left alone.'));
    }

    var hosts = [];
    try { hosts = api.hosts() || []; } catch (err) { hosts = []; }

    var list = el('div', 'set-sites');
    if (!hosts.length) {
      list.appendChild(el('p', 'set-empty',
        'No site styles or scripts yet. Add a site to give it your own CSS, a script, or force dark mode.'));
    }
    hosts.forEach(function (host) { list.appendChild(siteRow(api, host)); });
    field.appendChild(list);

    /* The add row: a host, however the user happens to have copied it. */
    var add = el('div', 'set-path-row set-site-add');
    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'set-site-host';
    input.className = 'set-path';
    input.placeholder = 'example.com';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Add a site');

    function commitAdd() {
      /* The module's own normaliser wins when it has one: both sides have to
         agree on what counts as the same site, or the list doubles up. */
      var host = '';
      try {
        host = typeof api.normalizeHost === 'function'
          ? String(api.normalizeHost(String(input.value)) || '')
          : normalizeHost(input.value);
      } catch (err) { host = normalizeHost(input.value); }
      if (!host) { input.focus(); return; }
      var known = false;
      try { known = (api.hosts() || []).indexOf(host) >= 0; } catch (err) { known = false; }
      if (!known) {
        try { api.set(host, { css: '', dark: false }); } catch (err) { /* module's problem */ }
      }
      input.value = '';
      siteOpen = host;
      siteFocus = '.set-site[data-host="' + attrEscape(host) + '"] .set-css';
      renderSiteStyles();
    }
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); commitAdd(); }
    });
    add.appendChild(input);
    add.appendChild(textButton('Add', 'set-btn', commitAdd));
    field.appendChild(add);
    field.appendChild(el('p', 'set-hint',
      "Scripts run in the page with the page's own powers. Only paste code you trust."));

    if (siteFocus) {
      var target = field.querySelector(siteFocus);
      siteFocus = null;
      if (target && typeof target.focus === 'function') target.focus();
    }
  }

  /* ============================================================
     Browser style

     Site styles paint web pages; this paints the browser around them.
     window.UserStyle owns the string and the <style> element it goes
     into, exactly as SiteStyles owns its store — the panel is one more
     view of it, and a build without that module simply says so.

     One field, two buttons, and a list of the tokens worth knowing:
     every colour in chrome.css resolves through one, so naming twelve
     of them turns "restyle the browser" from reading a stylesheet into
     writing three lines.
     ============================================================ */

  /** The module, or null when this build shipped without it. */
  function userStyle() {
    var m = window.UserStyle;
    if (!m) return null;
    if (typeof m.get !== 'function' || typeof m.set !== 'function') return null;
    if (typeof m.clear !== 'function') return null;
    return m;
  }

  /* The tokens a person actually reaches for, in the order chrome.css
     declares them: the two inks, the three text weights, the three
     glass steps, the hairline, the two lights, and the panel backing. */
  var CHROME_TOKENS = [
    ['--ink-0', 'The deepest background, behind everything else'],
    ['--ink-1', 'One step up from that: the second ink layer'],
    ['--fg', 'Text, at full strength'],
    ['--fg-2', 'Quieter text: labels and second lines'],
    ['--fg-3', 'The faintest text that is still readable: hints'],
    ['--glass', 'A frosted surface at rest'],
    ['--glass-2', 'The same surface, hovered'],
    ['--glass-3', 'The same surface, held down or selected'],
    ['--edge', 'The hairline around every glass pane'],
    ['--ion', 'The cool blue light that marks what is active'],
    ['--amber', 'The one warm light: a live Claude session'],
    ['--panel-bg', 'The solid backing of a panel floating over a page']
  ];

  function buildUserStyle() {
    var s = section('Browser style');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'userstyle');
    s.appendChild(field);
    return s;
  }

  /** The token crib sheet, closed until someone wants it. */
  function tokenSheet() {
    var d = el('details', 'set-tokens');
    d.appendChild(el('summary', 'set-tokens-sum', 'Common tokens'));
    var list = el('dl', 'set-tokens-list');
    CHROME_TOKENS.forEach(function (t) {
      list.appendChild(el('dt', 'set-token-name', t[0]));
      list.appendChild(el('dd', 'set-token-what', t[1]));
    });
    d.appendChild(list);
    return d;
  }

  function renderUserStyle() {
    var field = bodyEl && bodyEl.querySelector('[data-field="userstyle"]');
    if (!field) return;
    field.textContent = '';

    var api = userStyle();
    if (!api) {
      field.appendChild(el('p', 'set-na', 'Not available'));
      return;
    }

    var current = '';
    try { current = String(api.get() || ''); } catch (err) { current = ''; }

    var ta = document.createElement('textarea');
    ta.className = 'set-css set-userstyle';
    ta.spellcheck = false;
    ta.placeholder = '/* your CSS for the browser itself */\n#omnibox { border-radius: 6px; }';
    ta.setAttribute('aria-label', 'CSS for the browser itself');
    ta.value = current;
    // Escape leaves the field first; a second press then closes the panel.
    ta.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      ta.blur();
    });
    field.appendChild(ta);

    var acts = el('div', 'set-site-acts');
    acts.appendChild(textButton('Apply', 'set-btn', function () {
      /* A module that answers false rejected the sheet and has already
         said why; anything else (including a bare undefined) took it. */
      var stored = true;
      try { stored = api.set(ta.value); } catch (err) { stored = false; }
      if (stored !== false) showToast('Applied');
    }));

    /* Reset is two presses, and neither of them re-renders: the field
       holds whatever the user has typed, and only a real clear empties
       it. The arming press just relabels the button it is on. */
    var armed = false;
    var armTimer = 0;
    var reset = textButton('Reset', 'set-text set-userstyle-reset', function () {
      if (!armed) {
        armed = true;
        reset.textContent = 'Press again to reset';
        reset.classList.add('is-armed');
        window.clearTimeout(armTimer);
        armTimer = window.setTimeout(function () {
          if (!armed) return;
          armed = false;
          reset.textContent = 'Reset';
          reset.classList.remove('is-armed');
        }, 4000);
        return;
      }
      armed = false;
      window.clearTimeout(armTimer);
      try { api.clear(); } catch (err) { /* module's problem */ }
      renderUserStyle();
      showToast('Browser style reset');
    });
    acts.appendChild(reset);
    field.appendChild(acts);

    field.appendChild(el('p', 'set-hint',
      "Styles the browser's own chrome, not web pages. Every colour is a token: " +
      'try --ion, --glass, --panel-bg. Ctrl+Alt+Shift+R resets if you break something.'));
    field.appendChild(tokenSheet());
  }

  function buildNewTab() {
    var s = section('New tab');

    var bg = el('div', 'set-field');
    bg.setAttribute('data-field', 'newtabbg');
    s.appendChild(bg);

    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'chips');
    s.appendChild(field);
    return s;
  }

  /* The Home: one switch per piece of the new tab page. The arranging itself
     (drag between columns) lives on the page, where you can see it; this is
     the plain list for switching a piece off or back on, and the reset. */
  function buildHome() {
    var s = section('Home');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'home');
    s.appendChild(field);
    return s;
  }

  function renderHome() {
    var field = bodyEl && bodyEl.querySelector('[data-field="home"]');
    if (!field) return;
    field.textContent = '';

    var rules = homeRules();
    var layout = homeLayout();
    if (!rules || !layout) {
      // No silent failure: say why the switches are missing.
      field.appendChild(el('p', 'set-note',
        'Home layout rules did not load, so every piece shows in its usual place.'));
      return;
    }

    field.appendChild(el('p', 'set-hint',
      'You can also edit the Home on the page itself: the pencil at the bottom left. ' +
      'Drag a piece to move it, × to hide it, Add to put it back. ' +
      'A hidden piece stops its own updates.'));

    rules.PIECES.forEach(function (p) {
      var shown = layout.hidden.indexOf(p.id) < 0;
      field.appendChild(switchRow(p.label, shown, function (next) {
        var r = applyHomeOp({ op: next ? 'show' : 'hide', id: p.id });
        // An ok answer re-renders through the store listener; a refusal
        // changed nothing, so say why and redraw here to put the switch back.
        if (r.ok) return;
        showToast(r.reason || 'That change was not saved');
        renderHome();
        refreshFilter();
      }));
      // Apps is the one switch whose cost is not obvious: the dock's running
      // lights come from the same system sampler as System stats, so the
      // sampler keeps going while either piece is shown.
      if (p.id === 'apps') {
        field.appendChild(el('p', 'set-hint',
          'Its running lights keep the system sampler on while Apps is shown.'));
      }
    });

    field.appendChild(el('p', 'set-hint',
      'A piece switched back on returns to its place.'));

    /* Two presses, like the user style's Reset: a custom arrangement is
       work to redo. The arming press only relabels its own button; a store
       change re-renders the field and so disarms it, which is right. */
    var isDefault = rules.isDefault(layout);
    var armed = false;
    var armTimer = 0;
    var reset = textButton('Reset Home layout', 'set-text set-keys-resetall', function () {
      if (!armed) {
        armed = true;
        reset.textContent = 'Press again to reset the Home';
        reset.classList.add('is-armed');
        window.clearTimeout(armTimer);
        armTimer = window.setTimeout(function () {
          if (!armed) return;
          armed = false;
          reset.textContent = 'Reset Home layout';
          reset.classList.remove('is-armed');
        }, 4000);
        return;
      }
      armed = false;
      window.clearTimeout(armTimer);
      resetHomeLayout();
      showToast('Home layout reset');
    });
    // Already the default: nothing to reset, and the button says so by
    // being disabled rather than by doing nothing when pressed.
    reset.disabled = isDefault;
    if (isDefault) reset.title = 'The Home is already in its default layout';
    field.appendChild(reset);
  }

  /** The black behind the picture or the clip — the same control for both. */
  function bgDimRow(cfg) {
    var dim = el('span', 'set-bg-dim');
    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '60';
    slider.step = '1';
    slider.className = 'set-range';
    slider.id = 'set-bg-dim';
    slider.value = String(Math.round(cfg.dim * 100));
    slider.setAttribute('aria-label', 'Dim');
    var readout = el('span', 'set-bg-dim-value', Math.round(cfg.dim * 100) + '%');
    // input previews the number without writing; change is the one that stores.
    slider.addEventListener('input', function () { readout.textContent = slider.value + '%'; });
    slider.addEventListener('change', function () { setBackground({ dim: Number(slider.value) / 100 }); });
    dim.appendChild(slider);
    dim.appendChild(readout);
    return controlRow('Dim', 'set-bg-dim', dim);
  }

  /** "8 Oct" for a copy's timestamp ('' when there is none). */
  function bgShortDate(ms) {
    if (!ms || !isFinite(ms)) return '';
    try {
      return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    } catch (err) { return ''; }
  }

  /**
   * The sentence under the picker: what the window is actually showing, and
   * when it is not what was picked, why. Read from backdrop.js's state, so a
   * missing wallpaper, a deleted clip or a picture that will not decode is
   * said here in words instead of just quietly turning plain.
   */
  function bgStateText(st, cfg) {
    if (!st) {
      return 'The background layer did not start in this window, so the plain background is showing.';
    }
    if (st.kind !== cfg.kind) return 'Preparing the background…';
    /* A retried clip still says why it is being retried while it runs. */
    if (st.state === 'loading') return 'Preparing the background…' + (st.reason ? ' (' + st.reason + ')' : '');
    var src = st.source || {};
    var why = st.reason ? String(st.reason) : 'unknown reason';
    if (st.kind === 'none') return 'Plain background: no picture behind the tabs or on the new tab.';
    if (st.kind === 'desktop') {
      /* The line above already says what is followed (LookSync.desktop());
         this one only speaks when the window could not show it at all. */
      if (st.state === 'fallback') {
        return 'Could not show the desktop wallpaper behind the tabs: ' + why + '. Showing the plain background.';
      }
      return '';
    }
    if (st.kind === 'builtin') {
      if (st.state === 'fallback') {
        /* backdrop.js falls back to the wallpaper for a photo this build
           does not have; only when that fails too is the ground plain. */
        return 'Could not show the built-in photo: ' + why + '. Showing '
          + (src.type === 'wallpaper' && src.shown ? 'your Windows wallpaper' : 'the plain background') + ' instead.';
      }
      var bi = builtinItemOf(src.id || cfg.id);
      return 'Showing the built-in photo ' + (bi ? '"' + bi.title + '"' : (src.id || cfg.id || '')) + '.';
    }
    if (st.kind === 'image') {
      if (st.state === 'fallback') return 'Could not show your image: ' + why + '. Showing the plain background.';
      return 'Showing your image.';
    }
    var name = src.fileName || cfg.fileName || 'the clip';
    if (st.state === 'fallback') {
      /* backdrop.js never gives up on a clip that is still chosen: it says
         when it tries next, and a Home starting the clip tries at once. */
      var retry = src.retry && src.retry.at ? src.retry : null;
      var next = '';
      if (retry) {
        var secs = Math.max(1, Math.round((retry.at - Date.now()) / 1000));
        next = ' Trying again in about ' + secs + ' s (try ' + (retry.attempt + 1) + '), or as soon as the clip plays on a new tab.';
      }
      return 'Could not read a frame from ' + name + ' yet: ' + why + '. Showing the plain background behind the tabs'
        + (src.stillPending ? '; the clip still plays on the new tab.' : '.') + next;
    }
    return 'Behind the tabs: one blurred still of ' + name
      + (src.still === 'cached' ? ', taken once and kept'
        : ', just taken' + (src.via === 'home' ? ' from the new tab' : '')
          + (isFinite(src.captureMs) ? ' in ' + (src.captureMs < 1000 ? src.captureMs + ' ms' : (src.captureMs / 1000).toFixed(1) + ' s') : ''))
      + '. It plays on the new tab.';
  }

  /** Redraw just the state line (backdrop.js fires backdropchange). */
  function renderBgState() {
    var line = bodyEl && bodyEl.querySelector('[data-bg-state-line]');
    if (!line) return;
    var layer = window.Backdrop;
    var st = (layer && typeof layer.state === 'function') ? layer.state() : null;
    var bad = !st || st.state === 'fallback';
    line.className = (bad ? 'set-note' : 'set-hint') + ' set-bg-state' + (bad ? ' is-fallback' : '');
    line.textContent = bgStateText(st, backgroundConfig());
    line.hidden = !line.textContent;
  }

  /** Dim, plus the one sentence on what it does now. */
  function appendBgDim(field, cfg) {
    field.appendChild(bgDimRow(cfg));
    /* newtab.css lays the dim in the theme's wash colour: darker in dark
       theme, paler in light (with a light floor so dark text stays legible).
       A picture (not a clip), in either theme since the light look was
       un-held: the new tab is Helm's Home, see-through over the window's ONE
       picture and ONE wash (backdrop.js syncHome), so this Dim does not
       reach it; the Look's glass Dim does. Said, so a slider that changes
       nothing there is never a mystery. */
    var home = cfg && cfg.kind !== 'video' && cfg.kind !== 'none';
    field.appendChild(el('p', 'set-hint', home
      ? 'Dim softens a clip on the new tab. A picture on the new tab sits under the window\'s one wash, like Helm\'s Home: set it with the Look\'s glass Dim.'
      : 'Dim softens the picture on the new tab: darker in dark theme, paler in light.'));
  }

  /* --- the built-in photo gallery ----------------------------------
     Helm's Settings gallery, in this panel's plain-DOM voice: category
     chips (All first), Shuffle, a grid of thumbnails, and a credit line
     under it. Picking a tile makes it THE background (kind 'builtin'); the
     tile of the current one wears the accent border and a check, as Helm's
     does. The gallery shows whatever kind is picked, so the photos are one
     click away from the wallpaper, a picture or a clip. */
  var galFilter = 'all';              // the chip, kept across redraws
  var galAskFailed = null;            // the last failed list ask's reason

  var GAL_CHECK_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  /** An Unsplash credit opens as a tab (the panel has no links of its own). */
  function openCreditUrl(url) {
    if (!/^https:\/\//.test(url || '')) return;
    if (typeof window.createTab === 'function') window.createTab(url);
    else showToast('Could not open the photo page: no tab strip in this window');
  }

  /** Pick a built-in photo: the gallery's tiles, Shuffle, and the select. */
  function pickBuiltin(id) {
    setBackground({ kind: 'builtin', id: id });
  }

  function builtinItemOf(id) {
    var items = builtinsList ? builtinsList.items : [];
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }

  function galTile(item, on) {
    var b = el('button', 'set-gal-opt' + (on ? ' is-on' : '') + (item.missing ? ' is-missing' : ''));
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.setAttribute('data-builtin-id', item.id);
    b.title = item.missing
      ? item.title + ': cannot be used, ' + item.missing
      : item.title + (item.credit ? ' · Photo by ' + item.credit : '');
    if (item.missing) b.disabled = true;
    var tile = el('span', 'set-gal-tile');
    var img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    /* A lost thumb falls back to the photo itself; a lost photo hides the
       broken-image glyph and leaves the title saying which one it was. */
    img.addEventListener('error', function () {
      if (!img.dataset.fb && item.thumbUrl) { img.dataset.fb = '1'; img.src = item.fileUrl; }
      else img.style.visibility = 'hidden';
    });
    img.src = item.thumbUrl || item.fileUrl;
    tile.appendChild(img);
    if (on) {
      var check = el('span', 'set-gal-check');
      check.innerHTML = GAL_CHECK_SVG;
      tile.appendChild(check);
    }
    b.appendChild(tile);
    b.appendChild(el('span', 'set-gal-name', item.missing ? item.title + ' (missing)' : item.title));
    b.addEventListener('click', function () { if (!on) pickBuiltin(item.id); });
    return b;
  }

  /** The line under the grid: the picked photo's title and photographer. */
  function galCredit(cfg) {
    var p = el('p', 'set-gal-credit');
    var item = cfg.kind === 'builtin' ? builtinItemOf(cfg.id) : null;
    if (!item) {
      p.appendChild(document.createTextNode('Photos from Unsplash, free under the Unsplash License. ' +
        'Pick one to use it; its photographer is credited here.'));
      return p;
    }
    p.appendChild(el('span', 'set-gal-credit-title', item.title));
    if (item.credit) {
      p.appendChild(document.createTextNode(' · '));
      if (item.url) {
        var a = el('a', 'set-gal-link', 'Photo by ' + item.credit);
        a.href = item.url;
        a.title = item.url;
        a.addEventListener('click', function (e) { e.preventDefault(); openCreditUrl(item.url); });
        p.appendChild(a);
      } else {
        p.appendChild(document.createTextNode('Photo by ' + item.credit));
      }
      p.appendChild(document.createTextNode(' on Unsplash'));
    }
    return p;
  }

  function builtinGallery(cfg) {
    var wrap = el('div', 'set-gal');
    wrap.setAttribute('data-bg-gallery', '');

    if (!builtinsList) {
      /* Not asked yet in this window, or the last ask failed: say which, and
         redraw once when the answer lands (a failure is not retried in a loop). */
      wrap.appendChild(el('p', galAskFailed ? 'set-note' : 'set-hint',
        galAskFailed ? 'Built-in photos unavailable: ' + galAskFailed + '.' : 'Loading the built-in photos…'));
      if (!galAskFailed) {
        builtinBackgrounds().then(function (res) {
          if (!res.ok) galAskFailed = res.reason || 'unknown reason';
          renderNewtabBg();
        });
      }
      return wrap;
    }

    var items = builtinsList.items;
    var cats = [];
    items.forEach(function (x) { if (x.category && cats.indexOf(x.category) < 0) cats.push(x.category); });
    if (galFilter !== 'all' && cats.indexOf(galFilter) < 0) galFilter = 'all';
    var shown = galFilter === 'all' ? items : items.filter(function (x) { return x.category === galFilter; });
    var picked = cfg.kind === 'builtin' ? cfg.id : null;

    var bar = el('div', 'set-gal-bar');
    var chips = el('div', 'set-gal-chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Filter built-in photos');
    ['all'].concat(cats).forEach(function (c) {
      var chip = textButton(c === 'all' ? 'All' : c, 'set-gal-chip', function () {
        galFilter = c;
        renderNewtabBg();
      });
      chip.setAttribute('aria-pressed', galFilter === c ? 'true' : 'false');
      chips.appendChild(chip);
    });
    bar.appendChild(chips);
    var shuffle = textButton('Shuffle', 'set-btn set-gal-shuffle', function () {
      var pool = shown.filter(function (x) { return !x.missing && x.id !== picked; });
      if (!pool.length) pool = items.filter(function (x) { return !x.missing && x.id !== picked; });
      if (pool.length) pickBuiltin(pool[Math.floor(Math.random() * pool.length)].id);
    });
    shuffle.title = 'Use a random built-in photo';
    bar.appendChild(shuffle);
    wrap.appendChild(bar);

    var grid = el('div', 'set-gal-grid');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', 'Built-in photo');
    shown.forEach(function (item) { grid.appendChild(galTile(item, item.id === picked)); });
    wrap.appendChild(grid);

    var foot = el('div', 'set-gal-foot');
    foot.appendChild(galCredit(cfg));
    wrap.appendChild(foot);
    return wrap;
  }

  /**
   * "Same as desktop": the one line on what is followed (LookSync.desktop():
   * the title and rev, or the fallback reason), and the way to change it:
   * a button into Mantle's Wallpapers when Mantle can be opened, else the
   * plain sentence. Re-rendered on lookdesktop.
   */
  function renderDesktopLine() {
    var box = bodyEl && bodyEl.querySelector('[data-bg-desktop]');
    if (!box) return;
    box.textContent = '';
    var ls = lookSyncApi();
    var d = lookCall('desktop');
    var line = el('p', 'set-hint set-bg-desktop-line');
    line.setAttribute('role', 'status');
    var fallback = false;
    if (!ls || !d) {
      fallback = true;
      line.textContent = 'Following your desktop wallpaper is not possible: '
        + (ls ? 'the look sync module did not answer' : 'look sync did not load in this window (looksync.js is missing)')
        + '. Showing Windows’ wallpaper where it can be read.';
    } else if (d.state === 'ok') {
      var what = d.title ? '“' + d.title + '”' : 'Mantle’s wallpaper';
      line.textContent = 'Following your desktop wallpaper: ' + what
        + (d.rev !== undefined && d.rev !== null ? ' (rev ' + d.rev + ')' : '') + '.';
    } else if (d.state === 'fallback') {
      fallback = true;
      var why = d.reason ? String(d.reason) : 'Following Windows’ wallpaper: Mantle hasn’t shared one';
      line.textContent = 'Following your desktop wallpaper. ' + why + (/[.!?]$/.test(why) ? '' : '.');
    } else {
      line.textContent = 'Following your desktop wallpaper (waiting for Mantle’s answer…)'
        + (d.reason ? ' ' + d.reason : '') + '.';
    }
    if (fallback) line.className = 'set-note set-bg-desktop-line is-fallback';
    box.appendChild(line);

    var m = lookCall('mantle');
    var row = el('div', 'set-bg-row');
    if (m && m.canOpen && typeof ls.openMantleWallpapers === 'function') {
      var open = textButton('Open Mantle’s Wallpapers', 'set-btn set-bg-mantle', function () {
        open.disabled = true;
        Promise.resolve().then(function () { return ls.openMantleWallpapers(); }).then(function (res) {
          open.disabled = false;
          if (!res || res.ok !== true) {
            // reason = plain words (looksync-main.js); detail = the raw text, quartz.log only.
            if (res && res.detail) logUiError('mantle-wallpapers', res.detail);
            showToast('Couldn’t open Mantle’s Wallpapers: ' + ((res && res.reason) || 'Mantle gave no answer') + '.', 4000);
          }
        }, function (err) {
          open.disabled = false;
          logUiError('mantle-wallpapers', err);
          showToast('Couldn’t open Mantle’s Wallpapers: Quartz could not send the request. The details are in quartz.log.', 4000);
        });
      });
      row.appendChild(open);
      box.appendChild(row);
    } else {
      box.appendChild(el('p', 'set-hint', 'Change it in Mantle’s Wallpapers.'));
      if (m && m.reason) box.appendChild(el('p', 'set-note', 'No button to open it: ' + m.reason + '.'));
    }

    /* On the fallback the window shows main's copy of Windows' wallpaper,
       which is taken once, so the re-copy stays within reach. */
    if (fallback) {
      var wrow = el('div', 'set-bg-row');
      var recopy = textButton('Copy again from Windows', 'set-btn set-bg-recopy', function () {
        recopy.disabled = true;
        recopyWallpaper().then(function (res) {
          recopy.disabled = false;
          if (res && res.ok) showToast('Copied your Windows wallpaper again');
          else showToast('Could not copy the wallpaper: ' + ((res && res.reason) || 'unknown reason'));
          renderBgState();
        });
      });
      wrow.appendChild(recopy);
      box.appendChild(wrow);
    }
  }

  /** The background picker: one select, the state line, and the picture's controls under it. */
  function renderNewtabBg() {
    var field = bodyEl && bodyEl.querySelector('[data-field="newtabbg"]');
    if (!field) return;
    field.textContent = '';

    var cfg = normalizeBackground(get('newtabBackground'));
    var mode = cfg.kind === 'desktop' ? 'desktop' : 'own';

    field.appendChild(controlRow('Background', null, segmented(
      [{ id: 'desktop', name: 'Same as desktop' }, { id: 'own', name: 'Own picture' }],
      mode,
      function (next) { if (next !== mode) setBackgroundMode(next); }
    )));

    if (mode === 'desktop') {
      /* No picker: the desktop wallpaper is the one place a picture is
         chosen (requested 2026-10-10). One line, and the way to change it. */
      var desk = el('div', 'set-bg-desktop');
      desk.setAttribute('data-bg-desktop', '');
      field.appendChild(desk);
      renderDesktopLine();
      var stateLineD = el('p', 'set-hint set-bg-state');
      stateLineD.setAttribute('data-bg-state-line', '');
      stateLineD.setAttribute('role', 'status');
      field.appendChild(stateLineD);
      renderBgState();
      appendBgDim(field, cfg);
      return;
    }

    field.appendChild(controlRow('Picture', 'set-newtab-bg',
      glassSelect('set-newtab-bg', NEWTAB_BACKGROUNDS, cfg.kind, function (value) {
        /* "Built-in photo" with none picked before starts on the first one,
           so the select alone never lands on an empty choice. */
        if (value === 'builtin' && !cfg.id && builtinsList && builtinsList.items.length) {
          setBackground({ kind: value, id: builtinsList.items[0].id });
          return;
        }
        setBackground({ kind: value });
      })));
    field.appendChild(el('p', 'set-hint',
      "The whole window's background: behind the tabs, the address bar and the side panes, and on the new tab."));
    var stateLine = el('p', 'set-hint set-bg-state');
    stateLine.setAttribute('data-bg-state-line', '');
    stateLine.setAttribute('role', 'status');
    field.appendChild(stateLine);
    renderBgState();
    field.appendChild(builtinGallery(cfg));

    if (cfg.kind === 'none') return;

    if (cfg.kind === 'builtin') {
      appendBgDim(field, cfg);
      return;
    }

    if (cfg.kind === 'video') {
      /* No hidden <input type="file"> here: the renderer could read the clip,
         but it must keep playing after the original moves, so main copies it
         in and hands back the file:// URL. */
      var vrow = el('div', 'set-bg-row');
      vrow.appendChild(el('span', 'set-hint set-bg-name',
        cfg.fileUrl ? (cfg.fileName || 'Chosen clip') : 'No file chosen'));
      vrow.appendChild(textButton('Choose file…', 'set-btn set-bg-pick', function () {
        chooseBackgroundVideo().then(function (res) {
          if (res && res.ok) { showToast('Background set'); return; }
          var why = res && res.reason;
          if (!why || why === 'cancelled') return;     // he changed his mind
          showToast(why === 'too-large' ? 'That clip is over 512 MB' : why);
        });
      }));
      if (cfg.fileUrl) {
        vrow.appendChild(textButton('Remove', 'set-text set-bg-drop', function () {
          removeBackgroundVideo();
        }));
      }
      field.appendChild(vrow);

      appendBgDim(field, cfg);
      field.appendChild(el('p', 'set-hint',
        'A muted loop on the new tab; it pauses whenever the page is not in front. ' +
        'Behind the tabs sits one blurred still of it, taken once.'));
      if (!canChooseVideo()) {
        field.appendChild(el('p', 'set-hint',
          'Restart the browser to pick a clip — this window was started before moving pictures existed.'));
      }
      return;
    }

    loadPreview();

    /* The file input is the only way in — no main-process dialog, because a
       renderer can read a picked file on its own. Hidden, and driven by the
       button next to it, so the panel keeps its own controls. */
    var picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/*';
    picker.className = 'set-bg-file';
    picker.hidden = true;
    picker.addEventListener('change', function () {
      var file = picker.files && picker.files[0];
      picker.value = '';                  // picking the same file again still fires
      if (!file) return;
      chooseBackgroundImage(file).then(function () {
        showToast('Background set');
      }).catch(function (err) {
        var words = bgFailureWords(err);
        if (words !== BG_REJECT) logUiError('background-image', err);
        showToast(words, words === BG_REJECT ? 1800 : 4500);
      });
    });

    var row = el('div', 'set-bg-row');
    row.appendChild(picker);

    var url = previewUrl();
    if (url) {
      var img = document.createElement('img');
      img.className = 'set-bg-preview';
      img.src = url;
      img.width = 96;
      img.height = 54;
      img.alt = 'Your new tab background';
      row.appendChild(img);
    } else {
      row.appendChild(el('span', 'set-bg-preview is-empty'));
    }

    row.appendChild(textButton('Choose image…', 'set-btn set-bg-pick', function () {
      picker.click();
    }));
    if (bgPreviewBlob) {
      row.appendChild(textButton('Remove image', 'set-text set-bg-drop', function () {
        removeBackgroundImage();
      }));
    }
    field.appendChild(row);

    appendBgDim(field, cfg);

    if (!bgPreviewBlob) {
      field.appendChild(el('p', 'set-hint', 'No picture chosen yet — the window stays plain until you pick one.'));
    }
  }

  /** A text cell that only looks like text until you click into it. */
  function chipInput(value, cls, placeholder, commit) {
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'set-chip-text ' + cls;
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = 'off';
    var before = value;
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); return; }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();          // Escape edits the cell, not the panel
        input.value = before;
        input.blur();
      }
    });
    input.addEventListener('blur', function () {
      var next = input.value.trim();
      if (next === before) return;
      if (!commit(next)) input.value = before;
    });
    return input;
  }

  function renderChips() {
    var field = bodyEl && bodyEl.querySelector('[data-field="chips"]');
    if (!field) return;
    field.textContent = '';

    /* Where the five come from, above the list they may or may not use. On
       'visited' the editor stays live — you can still keep a list ready — but
       it goes quiet, because it is not what the page is reading. */
    var source = chipsSource();
    var seg = segmented(CHIP_SOURCES, source, setChipsSource);
    seg.setAttribute('aria-label', 'Shortcuts');
    field.appendChild(seg);
    field.appendChild(el('p', 'set-hint', CHIP_SOURCE_HINTS[source]));

    var editor = el('div', 'set-chips-editor' + (source === 'list' ? '' : ' set-chips--idle'));

    var list = chips();
    var rows = el('div', 'set-chips');

    if (!list.length) {
      rows.appendChild(el('p', 'set-empty', 'No shortcuts yet. Add one below.'));
    }

    list.forEach(function (chip, index) {
      var row = el('div', 'set-chip');
      var url = chip.url;

      var texts = el('div', 'set-chip-texts');
      texts.appendChild(chipInput(chip.label, 'is-label', 'Name', function (next) {
        return updateChip(url, { label: next });
      }));
      texts.appendChild(chipInput(chip.url, 'is-url', 'Address', function (next) {
        return updateChip(url, { url: next });
      }));
      row.appendChild(texts);

      var acts = el('div', 'set-chip-acts');
      var up = iconButton(GLYPH_UP, 'Move up', 'set-act', function () {
        focusHint = '.set-chip:nth-child(' + index + ') .set-act';
        moveChip(url, -1);
      });
      up.disabled = index === 0;
      var down = iconButton(GLYPH_DOWN, 'Move down', 'set-act', function () {
        focusHint = '.set-chip:nth-child(' + (index + 2) + ') .set-act';
        moveChip(url, 1);
      });
      down.disabled = index === list.length - 1;
      acts.appendChild(up);
      acts.appendChild(down);
      acts.appendChild(iconButton(GLYPH_DELETE, 'Remove', 'set-act', function () {
        removeChip(url);
      }));
      row.appendChild(acts);
      rows.appendChild(row);
    });

    editor.appendChild(rows);

    /* The add row: name, address, and the button that does Ctrl+D for you. */
    var add = el('div', 'set-chip set-chip-add');
    var addTexts = el('div', 'set-chip-texts');
    var labelIn = document.createElement('input');
    labelIn.type = 'text';
    labelIn.className = 'set-chip-text is-label';
    labelIn.placeholder = 'Name';
    labelIn.spellcheck = false;
    var urlIn = document.createElement('input');
    urlIn.type = 'text';
    urlIn.className = 'set-chip-text is-url';
    urlIn.placeholder = 'Address';
    urlIn.spellcheck = false;
    addTexts.appendChild(labelIn);
    addTexts.appendChild(urlIn);
    add.appendChild(addTexts);

    function commitAdd() {
      var url = urlIn.value.trim();
      if (!url) { urlIn.focus(); return; }
      if (addChip({ label: labelIn.value, url: url })) {
        focusHint = '.set-chip-add .is-url';
        showToast('Added to your new tab');
      } else {
        showToast('Already on your new tab');
      }
    }
    urlIn.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); commitAdd(); }
    });
    labelIn.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); urlIn.focus(); }
    });
    add.appendChild(iconButton(GLYPH_ADD, 'Add shortcut', 'set-act', commitAdd));
    editor.appendChild(add);

    editor.appendChild(textButton('Add current page', 'set-btn', function () {
      bookmarkActivePage();
    }));
    field.appendChild(editor);

    if (focusHint) {
      var target = field.querySelector(focusHint) || bodyEl.querySelector(focusHint);
      focusHint = null;
      if (target && typeof target.focus === 'function') target.focus();
    }
  }

  function buildMusic() {
    var s = section('Idle music');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'music');
    s.appendChild(field);
    return s;
  }

  /** The tracks line: the count, and the one name worth printing. */
  function musicFilesLine(files) {
    var n = files.length;
    if (!n) return 'No tracks chosen';
    if (n === 1) return '1 track: ' + files[0].name;
    return n + ' tracks';
  }

  /** How loud, as a percentage — the dim slider's shape, for a level. */
  function musicVolumeRow(cfg) {
    var wrap = el('span', 'set-bg-dim');
    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.className = 'set-range';
    slider.id = 'set-music-volume';
    slider.value = String(Math.round(cfg.volume * 100));
    slider.setAttribute('aria-label', 'Volume');
    var readout = el('span', 'set-bg-dim-value', Math.round(cfg.volume * 100) + '%');
    // input previews the number without writing; change is the one that stores.
    slider.addEventListener('input', function () { readout.textContent = slider.value + '%'; });
    slider.addEventListener('change', function () { setMusic({ volume: Number(slider.value) / 100 }); });
    wrap.appendChild(slider);
    wrap.appendChild(readout);
    return controlRow('Volume', 'set-music-volume', wrap);
  }

  /**
   * The whole section: the switch, where the sound comes from, where it is
   * allowed to play, and how loud. Every control writes and applies at once
   * — nothing here asks for a restart except the file picker on a window
   * started before the picker existed.
   */
  function renderMusic() {
    var field = bodyEl && bodyEl.querySelector('[data-field="music"]');
    if (!field) return;
    field.textContent = '';

    var cfg = music();
    var redraw = function () { renderMusic(); refreshFilter(); };

    field.appendChild(switchRow('Enabled', cfg.enabled, function (next) {
      setMusic({ enabled: next });
      redraw();
    }));

    field.appendChild(controlRow('Source', 'set-music-source',
      glassSelect('set-music-source', MUSIC_SOURCES, cfg.source, function (value) {
        setMusic({ source: value });
        redraw();
      })));

    if (cfg.source === 'files') {
      /* No hidden <input type="file">: the player keeps these paths for
         later, and a renderer's File objects do not survive a restart. */
      var row = el('div', 'set-bg-row');
      row.appendChild(el('span', 'set-hint set-bg-name', musicFilesLine(cfg.files)));
      var pick = textButton('Choose files…', 'set-btn set-bg-pick', function () {
        chooseMusicFiles().then(function (res) {
          if (res && res.ok) {
            redraw();
            showToast(res.added === 1 ? '1 track added' : res.added + ' tracks added');
            return;
          }
          var why = res && res.reason;
          if (!why || why === 'cancelled' || why === 'unavailable') return;
          showToast(why);
        });
      });
      if (!musicApi()) pick.disabled = true;
      row.appendChild(pick);
      if (cfg.files.length) {
        row.appendChild(textButton('Clear', 'set-text set-bg-drop', function () {
          setMusic({ files: [] });
          redraw();
        }));
      }
      field.appendChild(row);
      if (!musicApi()) {
        field.appendChild(el('p', 'set-hint', 'Restart the browser to pick files'));
      }
    }

    field.appendChild(controlRow('Where', 'set-music-where',
      glassSelect('set-music-where', MUSIC_WHERE, cfg.where, function (value) {
        setMusic({ where: value });
      })));

    field.appendChild(musicVolumeRow(cfg));

    field.appendChild(el('p', 'set-hint',
      'Quiet music while nothing else is playing. ' +
      'It pauses when a tab or Spotify plays sound.'));
  }

  /* ============================================================
     Typing — autocorrect, the red underline, and what they leave alone

     LIKE STOCKS, NOTHING HERE IS IN localStorage. Main owns the spelling
     state (it is the process that holds the dictionary and answers every
     tab), so this section draws whatever window.api.spell last said and
     sends every change back over it. Every call answers the whole
     SpellState, so one taker draws all three fields.

     LIVE WHILE THE PANE IS OPEN. "Add to dictionary" and "Autocorrect off on
     this site" happen in a PAGE's right-click menu, i.e. somewhere else; the
     list here has to grow while you watch, not on the next open. So
     openPanel() takes one onChanged subscription plus one state() read and
     closePanel() gives the subscription back, the same as the Phone rows.

     A PUSH MUST NOT MOVE YOU. Every render empties and refills the three
     fields, which would take focus (and a half-typed word) with it. So each
     focusable thing carries a data-spell-key; the render remembers which one
     had focus and hands it back, and the add field's text lives in spDraft
     rather than in the DOM. The fold is never touched: only the field bodies
     are rebuilt, the section and its heading stay put.

     NEVER SILENT. No bridge, a state() that rejects, a write that fails, or
     main saying the dictionary is unavailable: each one puts a sentence IN
     the section saying what is wrong and why, not only a toast or a log.
     ============================================================ */

  var spState = null;         // the last SpellState main sent, or null before the first
  var spReadErr = '';         // why state() could not be read, in plain words
  var spWriteErr = '';        // why the last change did not stick, until one does
  var spDraft = '';           // the add-a-word field, kept across re-renders
  var spOff = null;           // the onChanged unsubscribe, while the pane is open
  var spWatching = false;
  var spFocus = null;         // a key to hand focus to after the next render
  var spAddErr = '';          // why the add field refused what was typed

  /** The preload bridge, or null on a build without one. */
  function spellApi() {
    try {
      var api = window.api && window.api.spell;
      return api && typeof api.state === 'function' ? api : null;
    } catch (err) { return null; }
  }

  /** An Error, a string or nothing, as one short readable clause. */
  function spellWhy(err) {
    var msg = err && (err.message || (typeof err === 'string' ? err : ''));
    msg = String(msg || '').replace(/^Error invoking remote method '[^']*': /, '').trim();
    return msg || 'no reason was given';
  }

  /**
   * Main's answer, checked field by field: a list that is not a list is
   * drawn as empty rather than throwing half-way through a render.
   */
  function spellNormalise(st) {
    function strings(a) {
      return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string' && !!x; }) : [];
    }
    return {
      autocorrect: st.autocorrect !== false,
      underline: st.underline !== false,
      sitesOff: strings(st.sitesOff),
      words: strings(st.words),
      available: st.available !== false,
      reason: typeof st.reason === 'string' ? st.reason : '',
      languages: strings(st.languages)
    };
  }

  function spellTake(answer) {
    if (!answer || typeof answer !== 'object') return;
    spState = spellNormalise(answer);
    spReadErr = '';
    renderTyping();
    refreshFilter();
  }

  /** One state() when the pane opens. A failure is drawn, not swallowed. */
  function spellRefresh() {
    var api = spellApi();
    if (!api) { renderTyping(); return; }
    var answer;
    try { answer = api.state(); }
    catch (err) { spReadErr = spellWhy(err); renderTyping(); return; }
    Promise.resolve(answer).then(function (value) {
      if (value && typeof value === 'object') spellTake(value);
      else { spReadErr = 'main answered with nothing'; renderTyping(); }
    }, function (err) {
      spReadErr = spellWhy(err);
      renderTyping();
    });
  }

  function spellWatch() {
    if (spWatching) return;                    // opened twice is still one of each
    spWatching = true;
    var api = spellApi();
    if (api && typeof api.onChanged === 'function') {
      try {
        var off = api.onChanged(function (st) { spellTake(st); });
        if (typeof off === 'function') spOff = off;
      } catch (err) { spOff = null; }
    }
    spellRefresh();
  }

  /** Closed: nothing of this section is left listening. */
  function spellRelease() {
    spWatching = false;
    if (spOff) {
      try { spOff(); } catch (err) { /* the channel is already gone */ }
    }
    spOff = null;
  }

  /**
   * The write path, shaped like stocksWrite(): guess so the control moves
   * under the finger, send, and let main's answer replace the guess. On a
   * failure the reason goes into the section and a fresh state() puts the
   * truth back, so a switch never sits in a position main did not take.
   */
  function spellWrite(method, args, guess, failed) {
    var api = spellApi();
    if (!api || typeof api[method] !== 'function') {
      spWriteErr = failed + ': this window has no way to ask for it.';
      renderTyping();
      return;
    }
    if (spState && typeof guess === 'function') {
      guess(spState);
      renderTyping();
    }
    var fail = function (err) {
      spWriteErr = failed + ': ' + spellWhy(err) + '.';
      showToast(failed);
      spellRefresh();
    };
    var answer;
    try { answer = api[method].apply(api, args); }
    catch (err) { fail(err); return; }
    Promise.resolve(answer).then(function (value) {
      if (value && typeof value === 'object') {
        spWriteErr = '';
        spellTake(value);
      } else {
        fail('main answered with nothing');
      }
    }, fail);
  }

  function buildTyping() {
    var s = section('Typing');
    s.setAttribute('data-section', 'typing');

    var main = el('div', 'set-field');
    main.setAttribute('data-field', 'typing');
    s.appendChild(main);

    var sites = el('div', 'set-field');
    sites.setAttribute('data-field', 'typingsites');
    s.appendChild(sites);

    var words = el('div', 'set-field');
    words.setAttribute('data-field', 'typingwords');
    s.appendChild(words);
    return s;
  }

  /**
   * What has focus inside this section, by key, so a render can give it back.
   * The fold heading has no key and is never rebuilt, so it is left alone.
   */
  function typingFocusNow() {
    var a = document.activeElement;
    var sec = bodyEl && bodyEl.querySelector('[data-section="typing"]');
    if (!a || !sec || !sec.contains(a) || !a.getAttribute) return null;
    var key = a.getAttribute('data-spell-key');
    if (!key) return null;
    var at = { key: key, list: a.getAttribute('data-spell-list') || '',
      index: Number(a.getAttribute('data-spell-index')) || 0, start: -1, end: -1 };
    if (a.tagName === 'INPUT') {
      try { at.start = a.selectionStart; at.end = a.selectionEnd; } catch (err) { /* no caret */ }
    }
    return at;
  }

  /**
   * Put focus back. A row that is gone (you just removed it) hands focus to
   * whatever now sits at its index, then the list's last row, then the
   * section's own heading: never to <body>, where Escape stops closing the pane.
   */
  function typingFocusBack(at) {
    var sec = bodyEl && bodyEl.querySelector('[data-section="typing"]');
    if (!at || !sec) return;
    var all = sec.querySelectorAll('[data-spell-key]');
    var target = null;
    var i;
    for (i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-spell-key') === at.key) { target = all[i]; break; }
    }
    if (!target && at.list) {
      var rows = sec.querySelectorAll('[data-spell-list="' + at.list + '"]');
      if (rows.length) target = rows[Math.min(at.index, rows.length - 1)];
    }
    if (!target) target = sec.querySelector('.set-h-toggle');
    /* The sheet shows the heading only over search results; otherwise the
       pane itself holds the keyboard, which keeps Escape closing it. */
    if (target && (!target.getClientRects || !target.getClientRects().length)) target = bodyEl;
    if (!target || target.disabled) return;
    try { target.focus({ preventScroll: true }); } catch (err) { /* re-rendered away */ }
    if (target.tagName === 'INPUT' && at.start >= 0 && at.key === target.getAttribute('data-spell-key')) {
      try { target.setSelectionRange(at.start, at.end); } catch (err) { /* no caret */ }
    }
  }

  function renderTyping() {
    var at = spFocus || typingFocusNow();
    spFocus = null;
    renderTypingMain();
    renderTypingSites();
    renderTypingWords();
    if (at) typingFocusBack(at);
  }

  /**
   * The state line, then the two switches. Anything that stops this section
   * working is said here, first, in a boxed line rather than the grey hint
   * type, because it explains why everything under it is greyed out.
   */
  function renderTypingMain() {
    var field = bodyEl && bodyEl.querySelector('[data-field="typing"]');
    if (!field) return;
    field.textContent = '';

    var api = spellApi();
    var st = spState;
    var trouble = '';
    if (!api) {
      trouble = 'Autocorrect and the spelling underline cannot be set here: this ' +
        'window has no spelling channel. Restarting the browser usually brings it back.';
    } else if (!st && spReadErr) {
      trouble = 'Your typing settings could not be read: ' + spReadErr + '.';
    } else if (st && !st.available) {
      trouble = 'Autocorrect and the spelling underline are unavailable right now: ' +
        String(st.reason || 'the browser did not say why').replace(/[.\s]+$/, '') + '.';
    }
    if (trouble) {
      var notice = el('p', 'set-typing-notice', trouble);
      notice.setAttribute('role', 'status');
      field.appendChild(notice);
    }
    if (spWriteErr) field.appendChild(el('p', 'set-note', spWriteErr));

    if (!api || (!st && spReadErr)) return;
    if (!st) {
      field.appendChild(el('p', 'set-hint', 'Reading your typing settings…'));
      return;
    }

    var live = st.available;
    var ac = switchRow('Autocorrect', st.autocorrect, function (next) {
      spellWrite('set', [{ autocorrect: next }], function (cur) { cur.autocorrect = next; },
        next ? 'Autocorrect could not be turned on' : 'Autocorrect could not be turned off');
    });
    ac.setAttribute('data-spell-key', 'autocorrect');
    if (!live) ac.disabled = true;
    field.appendChild(ac);
    field.appendChild(el('p', 'set-hint',
      'Fixes a misspelled word when you finish it. Press Backspace straight ' +
      'after to put back what you typed. Addresses, passwords and code boxes ' +
      'are never touched.'));

    var ul = switchRow('Underline misspellings', st.underline, function (next) {
      spellWrite('set', [{ underline: next }], function (cur) { cur.underline = next; },
        next ? 'The underline could not be turned on' : 'The underline could not be turned off');
    });
    ul.setAttribute('data-spell-key', 'underline');
    if (!live) ul.disabled = true;
    field.appendChild(ul);
    field.appendChild(el('p', 'set-hint',
      'A red line under words the dictionary does not know. Right-click one ' +
      'for suggestions.' +
      (st.languages.length ? ' Dictionary: ' + st.languages.join(', ') + '.' : '')));

    if (api && typeof api.onChanged !== 'function') {
      field.appendChild(el('p', 'set-note',
        'Changes made from a page’s right-click menu show up here the next time Settings opens.'));
    }
  }

  /**
   * One removable row in either list. The text is a plain span in the chip
   * cell's type, not an input: a host or a word is removed and re-added,
   * never edited in place.
   */
  function typingRow(list, text, index, removeLabel, onRemove) {
    var row = el('div', 'set-chip');
    var texts = el('div', 'set-chip-texts');
    var cell = el('span', 'set-chip-text set-typing-item', text);
    cell.title = text;
    texts.appendChild(cell);
    row.appendChild(texts);
    var acts = el('div', 'set-chip-acts');
    var rm = iconButton(GLYPH_DELETE, removeLabel, 'set-act', onRemove);
    rm.setAttribute('data-spell-key', list + ':' + text);
    rm.setAttribute('data-spell-list', list);
    rm.setAttribute('data-spell-index', String(index));
    acts.appendChild(rm);
    row.appendChild(acts);
    return row;
  }

  function renderTypingSites() {
    var field = bodyEl && bodyEl.querySelector('[data-field="typingsites"]');
    if (!field) return;
    field.textContent = '';
    if (!spellApi() || !spState) return;

    field.appendChild(el('p', 'set-label', 'Autocorrect is off on these sites'));
    var rows = el('div', 'set-chips');
    rows.setAttribute('data-spell-rows', 'sites');
    if (!spState.sitesOff.length) {
      rows.appendChild(el('p', 'set-empty',
        'None. To turn it off for one site, right-click in a text box on that ' +
        'site and choose to turn autocorrect off there.'));
    }
    spState.sitesOff.forEach(function (host, i) {
      rows.appendChild(typingRow('site', host, i, 'Turn autocorrect back on for ' + host, function () {
        spellWrite('siteOff', [host, false], function (cur) {
          cur.sitesOff = cur.sitesOff.filter(function (h) { return h !== host; });
        }, 'Autocorrect could not be turned back on for ' + host);
      }));
    });
    field.appendChild(rows);
  }

  function renderTypingWords() {
    var field = bodyEl && bodyEl.querySelector('[data-field="typingwords"]');
    if (!field) return;
    field.textContent = '';
    if (!spellApi() || !spState) return;

    var label = el('label', 'set-label', 'Personal dictionary');
    label.setAttribute('for', 'set-spell-add');
    field.appendChild(label);

    var rows = el('div', 'set-chips');
    rows.setAttribute('data-spell-rows', 'words');
    if (!spState.words.length) {
      rows.appendChild(el('p', 'set-empty', 'Words you add from the right-click menu land here.'));
    }
    spState.words.forEach(function (word, i) {
      rows.appendChild(typingRow('word', word, i, 'Remove ' + word + ' from the dictionary', function () {
        spellWrite('removeWord', [word], function (cur) {
          cur.words = cur.words.filter(function (w) { return w !== word; });
        }, word + ' could not be removed');
      }));
    });
    field.appendChild(rows);

    /* The add row. spellcheck stays off on purpose: this is where a word the
       dictionary does not know is typed, so underlining or "fixing" it would
       be the browser arguing with the very thing it is being taught. */
    var add = el('div', 'set-chip set-chip-add');
    var addTexts = el('div', 'set-chip-texts');
    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'set-spell-add';
    input.className = 'set-chip-text';
    input.placeholder = 'Add a word';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('data-spell-key', 'add');
    input.value = spDraft;
    input.addEventListener('input', function () { spDraft = input.value; });
    addTexts.appendChild(input);
    add.appendChild(addTexts);

    function commitAdd() {
      var word = input.value.trim();
      if (!word) { input.focus(); return; }
      if (/\s/.test(word)) {
        spAddErr = 'The dictionary takes one word at a time, with no spaces.';
        spFocus = { key: 'add', list: '', index: 0, start: -1, end: -1 };
        renderTyping();
        return;
      }
      spDraft = '';
      spAddErr = '';
      spFocus = { key: 'add', list: '', index: 0, start: -1, end: -1 };
      spellWrite('addWord', [word], function (cur) {
        if (cur.words.indexOf(word) < 0) cur.words = cur.words.concat([word]).sort();
      }, word + ' could not be added');
    }
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commitAdd(); }
    });
    var plus = iconButton(GLYPH_ADD, 'Add to the dictionary', 'set-act', commitAdd);
    plus.setAttribute('data-spell-key', 'addbtn');
    add.appendChild(plus);
    field.appendChild(add);
    if (spAddErr) field.appendChild(el('p', 'set-note', spAddErr));
  }

  function buildPrivacy() {
    var s = section('Privacy');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'privacy');
    s.appendChild(field);
    return s;
  }

  function historyCount() {
    var store = window.History;
    if (!store || typeof store.all !== 'function') return -1;
    try {
      var items = store.all();
      return Array.isArray(items) ? items.length : -1;
    } catch (err) { return -1; }
  }

  function renderPrivacy() {
    var field = bodyEl && bodyEl.querySelector('[data-field="privacy"]');
    if (!field) return;
    field.textContent = '';

    var n = historyCount();
    var label = n > 0 ? 'Clear ' + n + (n === 1 ? ' page' : ' pages') : 'Clear browsing history';
    var clearHistory = textButton(label, 'set-btn', function () {
      var store = window.History;
      if (!store || typeof store.clear !== 'function') return;
      try { store.clear(); } catch (err) { /* storage is best-effort */ }
      renderPrivacy();
      showToast('History cleared');
    });
    clearHistory.disabled = n <= 0;
    field.appendChild(clearHistory);

    field.appendChild(textButton('Clear downloads list', 'set-btn', function () {
      var dl = window.api && window.api.downloads;
      if (dl && typeof dl.clear === 'function') {
        try { dl.clear(); } catch (err) { /* main is gone */ }
      }
      var mod = window.Downloads;
      if (mod) {
        var repaint = mod.refresh || mod.render || mod._refresh;
        if (typeof repaint === 'function') { try { repaint.call(mod); } catch (err) { /* fine */ } }
      }
      showToast('Downloads list cleared');
    }));
  }

  /* ------------------------------------------------------------
     Spotify — the auto-pause helper

     A bridge outside the browser pauses the Spotify desktop app
     while something is playing, and this browser's own tabs hold
     it the way the extension in the other browser does. Main owns
     all of it; the section is a readout over window.api.autopause
     and nothing here is stored in localStorage: every value on
     screen came from status(), and every change goes back through
     setEnabled() or setConfig().

     A build whose preload has no autopause — an older main, a
     failed load — renders the "Not installed" state and throws
     nothing: every call goes through autopauseCall(), where a
     missing method, a throw and a rejected promise all land in
     the same handler.
     ------------------------------------------------------------ */

  /* The hosts a fresh install watches: a copy of DEFAULT_SITES in autopause.js
     (sites a person adds live in their own autopause.json, not here). They are
     here only so the editor has something honest to show before the first
     status() answers; the list in force is always the one status() reports. */
  var AUTOPAUSE_SITES = [
    'youtube.com', 'youtube-nocookie.com', 'twitch.tv', 'kick.com', 'vimeo.com',
    'dailymotion.com', 'tiktok.com', 'netflix.com', 'hulu.com', 'disneyplus.com',
    'primevideo.com', 'max.com', 'peacocktv.com', 'crunchyroll.com'
  ];

  /* 4s: live enough that the readout follows a video starting, slow enough
     that an open pane is not a poll loop. It only runs while the pane is
     open — closePanel() takes the timer and the subscription down again. */
  var AUTOPAUSE_POLL_MS = 4000;

  var apStatus = null;        // the last Status, shaped; null = nothing asked yet
  var apError = null;         // the last failure, in plain English
  var apDrawn = '';           // the signature the section was last drawn from
  var apWatching = false;     // poll + subscription are live (open pane only)
  var apTimer = 0;
  var apOff = null;           // the onStatus unsubscribe, while subscribed
  var apSitesEl = null;       // the host editor, while it is on screen
  var apChecking = false;     // doctor() is in flight
  var apReport = '';          // the last health text
  var apReportOk = false;
  var apReportOpen = false;   // the readout survives a re-render open

  /** The preload bridge, or null when this build has none. */
  function autopauseApi() {
    try {
      var api = window.api && window.api.autopause;
      if (!api || typeof api.status !== 'function') return null;
      return api;
    } catch (err) { return null; }
  }

  /** A failure as a sentence — never an object, never a stack. */
  function autopauseReason(err) {
    var text = '';
    try { text = String((err && err.message) || err || ''); } catch (e) { text = ''; }
    text = text.replace(/^Error:\s*/i, '').trim();
    return text || 'That did not work';
  }

  /**
   * One call to main. A missing api, a missing method, a throw and a
   * rejected promise all end in onDone(value, reason), so nothing in this
   * section can throw out of a click handler. A build with no bridge at all
   * answers (null, null): that is the "Not installed" state, not an error.
   */
  function autopauseCall(name, arg, onDone) {
    var api = autopauseApi();
    if (!api || typeof api[name] !== 'function') { onDone(null, null); return; }
    var answer;
    try { answer = arg === undefined ? api[name]() : api[name](arg); }
    catch (err) { onDone(null, autopauseReason(err)); return; }
    try {
      Promise.resolve(answer).then(
        function (value) { onDone(value, null); },
        function (err) { onDone(null, autopauseReason(err)); }
      );
    } catch (err) { onDone(null, autopauseReason(err)); }
  }

  /** A typed list of hosts, cleaned: no scheme, no path, no repeats. */
  function autopauseHosts(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var host = String(list[i] == null ? '' : list[i]).trim().toLowerCase();
      host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
                 .replace(/[\/?#].*$/, '')
                 .replace(/^\.+/, '');
      if (host && out.indexOf(host) < 0) out.push(host);
    }
    return out;
  }

  /** Whatever main sent, as the Status this section can draw without checks. */
  function autopauseShape(raw) {
    var s = (raw && typeof raw === 'object') ? raw : {};
    var c = (s.config && typeof s.config === 'object') ? s.config : {};
    var sites = autopauseHosts(c.sites);
    var tabs = Number(s.audibleTabs);
    var port = Number(s.port);
    /* Ad quieting: a helper that cannot do it leaves the field out entirely,
       and null is what disables the switch rather than guessing it is off.
       A bare boolean is accepted too, in case the bridge sends it flat. */
    var duck = null;
    if (s.adDuck && typeof s.adDuck === 'object') duck = { enabled: s.adDuck.enabled === true };
    else if (typeof s.adDuck === 'boolean') duck = { enabled: s.adDuck };
    return {
      installed: s.installed === true,
      enabled: s.enabled === true,
      bridge: (s.bridge === 'running' || s.bridge === 'stopped') ? s.bridge : 'unknown',
      port: isFinite(port) && port > 0 ? Math.round(port) : null,
      spotify: s.spotify === true,
      adDuck: duck,
      wePaused: s.wePaused === true,
      browserHold: s.browserHold === true,
      audibleTabs: isFinite(tabs) && tabs > 0 ? Math.round(tabs) : 0,
      config: {
        browserHold: c.browserHold !== false,
        anySite: c.anySite === true,
        sites: sites.length ? sites : AUTOPAUSE_SITES.slice()
      },
      error: (typeof s.error === 'string' && s.error.trim()) ? s.error.trim() : null
    };
  }

  /**
   * What is true right now, in words. Sentence case and no jargon: this line
   * is the section's instrument readout, and it is the only place the state
   * is explained.
   */
  function autopauseSentence() {
    if (!autopauseApi()) return 'Not installed on this computer';
    var s = apStatus;
    /* Asked and never answered — a main that threw, a channel that is gone —
       reads the same as a build with no helper at all. The reason is printed
       underneath; the readout never claims something is running. */
    if (!s) return apError ? 'Not installed on this computer' : 'Checking';
    if (!s.installed) return 'Not installed on this computer';
    if (s.bridge === 'running') {
      if (s.wePaused) return 'Running, holding Spotify paused for a video';
      var where = s.port ? 'Running on port ' + s.port : 'Running';
      return where + (s.spotify ? ', Spotify open' : ', Spotify not open');
    }
    if (s.bridge === 'stopped') return 'Stopped';
    return s.enabled ? 'Turned on, not answering' : 'Stopped';
  }

  /** The pip: ion while it runs, amber while it holds, dim otherwise. */
  function autopauseLight() {
    var s = apStatus;
    if (!autopauseApi() || !s || !s.installed) return '';
    if (s.wePaused) return ' is-hold';
    return s.bridge === 'running' ? ' is-live' : '';
  }

  /** The lit sentence: a pip, then what it means. */
  function autopauseReadout() {
    var p = el('p', 'set-readout');
    var pip = el('span', 'set-pip' + autopauseLight());
    pip.setAttribute('aria-hidden', 'true');    // the sentence carries the meaning
    p.appendChild(pip);
    p.appendChild(el('span', 'set-readout-text', autopauseSentence()));
    return p;
  }

  /** Everything the section draws, in one string: no change, no re-render. */
  function autopauseSignature() {
    var s = apStatus;
    if (!s) return 'none|' + (apError || '') + '|' + (autopauseApi() ? 'api' : 'none');
    return [
      s.installed, s.enabled, s.bridge, s.port, s.spotify, s.wePaused,
      s.adDuck ? (s.adDuck.enabled ? 'duck-on' : 'duck-off') : 'duck-none',
      s.audibleTabs, s.config.browserHold, s.config.anySite,
      s.config.sites.join(' '), s.error || '', apError || ''
    ].join('|');
  }

  /**
   * A Status arrived — from the poll, from a change main pushed, or from a
   * switch that was just thrown. Redraw only when something actually moved,
   * and never out from under a caret sitting in the host editor.
   */
  function autopauseTake(raw, reason) {
    if (raw) apStatus = autopauseShape(raw);
    apError = reason || null;
    var sig = autopauseSignature();
    if (sig === apDrawn) return;
    var active = null;
    try { active = document.activeElement; } catch (err) { active = null; }
    if (apSitesEl && active === apSitesEl) return;   // mid-edit: the blur lands first
    apDrawn = sig;
    renderSpotify();
    refreshFilter();
  }

  function autopausePoll() {
    autopauseCall('status', undefined, autopauseTake);
  }

  /** Open: one subscription and one 4s poll, however often this is called. */
  function autopauseWatch() {
    if (apWatching) return;                    // opened twice is still one of each
    apWatching = true;
    var api = autopauseApi();
    if (api && typeof api.onStatus === 'function') {
      try {
        var off = api.onStatus(function (s) { autopauseTake(s, null); });
        if (typeof off === 'function') apOff = off;
      } catch (err) { apOff = null; }
    }
    autopausePoll();
    if (typeof window.setInterval === 'function') {
      try { apTimer = window.setInterval(autopausePoll, AUTOPAUSE_POLL_MS); }
      catch (err) { apTimer = 0; }
    }
  }

  /** Closed: nothing of this section is left running. */
  function autopauseRelease() {
    apWatching = false;
    if (apTimer && typeof window.clearInterval === 'function') {
      try { window.clearInterval(apTimer); } catch (err) { /* already gone */ }
    }
    apTimer = 0;
    if (apOff) {
      try { apOff(); } catch (err) { /* the channel is already gone */ }
    }
    apOff = null;
  }

  /**
   * Throw a switch. The row moves at once so the pane never feels dead, and
   * whatever main answers with replaces that guess. A build with no bridge
   * does nothing at all: the controls are disabled there anyway.
   */
  function autopauseWrite(method, arg, guess, failed) {
    if (!autopauseApi()) return;
    if (apStatus && typeof guess === 'function') {
      guess(apStatus);
      apDrawn = '';
      renderSpotify();
      refreshFilter();
    }
    autopauseCall(method, arg, function (value, reason) {
      autopauseTake(value, reason);
      if (reason) showToast(failed);
    });
  }

  /**
   * The preload's Spotify controls — the player's own volume, not the
   * auto-pause bridge's switches. A window started before they existed, or
   * a build without them, answers null and the switch is disabled.
   */
  function spotifyApi() {
    try {
      var api = window.api && window.api.spotify;
      if (!api || typeof api.setAdDuck !== 'function') return null;
      return api;
    } catch (err) { return null; }
  }

  /**
   * Throw the ad switch. The row moves at once, the way the auto-pause ones
   * do, and whatever main answers with replaces that guess: a whole Status
   * is taken, anything else leaves the guess standing until the next poll.
   */
  function spotifyWrite(method, arg, guess, failed) {
    var api = spotifyApi();
    if (!api) return;
    if (apStatus && typeof guess === 'function') {
      guess(apStatus);
      apDrawn = '';
      renderSpotify();
      refreshFilter();
    }
    var answer;
    try { answer = api[method](arg); }
    catch (err) { showToast(failed); return; }
    try {
      Promise.resolve(answer).then(function (value) {
        autopauseTake((value && typeof value === 'object') ? value : null, null);
      }, function () { showToast(failed); });
    } catch (err) { showToast(failed); }
  }

  function autopauseSaveSites(text) {
    var list = autopauseHosts(String(text || '').split(/[\s,]+/));
    autopauseWrite('setConfig', { sites: list }, function (s) {
      s.config.sites = list.length ? list : AUTOPAUSE_SITES.slice();
    }, 'Those sites could not be saved');
  }

  function autopauseDoctor() {
    if (apChecking) return;
    apChecking = true;
    renderAutopauseHealth();
    autopauseCall('doctor', undefined, function (value, reason) {
      apChecking = false;
      if (reason) {
        apReportOk = false;
        apReport = reason;
      } else {
        var o = (value && typeof value === 'object') ? value : {};
        var text = typeof o.text === 'string' ? o.text.replace(/\s+$/, '') : '';
        if (!text && o.json) {
          try { text = JSON.stringify(o.json, null, 2); } catch (err) { text = ''; }
        }
        apReportOk = o.ok === true;
        apReport = text || (apReportOk
          ? 'The health check found nothing wrong.'
          : 'The health check answered with nothing.');
      }
      apReportOpen = true;
      renderAutopauseHealth();
      refreshFilter();
    });
  }

  function buildSpotify() {
    var s = section('Spotify');

    var main = el('div', 'set-field');
    main.setAttribute('data-field', 'autopause');
    s.appendChild(main);

    var browser = el('div', 'set-field');
    browser.setAttribute('data-field', 'autopausebrowser');
    s.appendChild(browser);

    var duck = el('div', 'set-field');
    duck.setAttribute('data-field', 'adduck');
    s.appendChild(duck);

    var sites = el('div', 'set-field');
    sites.setAttribute('data-field', 'autopausesites');
    s.appendChild(sites);

    var health = el('div', 'set-field');
    health.setAttribute('data-field', 'autopausehealth');
    s.appendChild(health);
    return s;
  }

  function renderSpotify() {
    renderAutopauseMain();
    renderAutopauseBrowser();
    renderAdDuck();
    renderAutopauseSites();
    renderAutopauseHealth();
  }

  /* ============================================================
     Watch — the streaming hub (watch.html, Ctrl+Alt+W)

     Like Stocks, nothing here is in localStorage: watch-main.js owns the
     prefs, the cache and the TMDB key, and every call over window.api.watch
     answers the same describe() shape (services, leagues, allLeagues, tmdb,
     cacheBytes, reading). The key goes one way only: describe() answers
     `hasKey` and a mask, so the field is never pre-filled.

     Nothing fails quietly (a standing rule): each service's line says what its
     last read did, in words, and every button's answer is printed under it.
     While a read is in flight the section asks again every few seconds, and
     stops the moment nothing is reading or the sheet closes.
     ============================================================ */

  var wtState = null;        // the last describe(), or null before the first
  var wtShowKey = false;     // the eye: reveals what is being TYPED only
  var wtBusy = '';           // which action is out: 'check' | 'forget' | 'leagues' | 'svc:<id>' | ''
  var wtFocus = '';
  var wtResult = {};         // slot -> { ok, text }: the last answer to each action
  var wtForgetArmed = false;
  var wtForgetTimer = 0;
  var wtPollTimer = 0;
  var wtAskFailed = '';      // why the last describe() did not land

  function watchApi() {
    var api = window.api && window.api.watch;
    return api && typeof api.describe === 'function' ? api : null;
  }

  function buildWatch() {
    var s = section('Lumen');
    s.appendChild(el('p', 'set-hint',
      'Lumen (Ctrl+Alt+W, or “Lumen” or “Watch” in the command palette) shows Continue watching, ' +
      'picks and live sports from the services you are signed in to in Quartz. Reading happens ' +
      'in a hidden page: when it comes on screen (anything over 10 min old), every 15 min while it ' +
      'stays there, and hourly in the background if the switch below is on; nothing leaves this PC.'));
    // Lumen is opt-in (watch-main.js cleanPrefs): a fresh install reads nothing until a service is on.
    s.appendChild(el('p', 'set-hint set-watch-terms',
      'Lumen is unofficial: it is not affiliated with or endorsed by YouTube, Disney+, Hulu, Prime Video or ESPN. ' +
      'It reads pages from services you are signed in to, in a hidden window, with your own session. ' +
      'Automated reading may be against a service’s terms of use, so turn on only the services you accept that for. ' +
      'On a new install every service starts off.'));
    var svc = el('div', 'set-field');
    svc.setAttribute('data-field', 'watchservices');
    s.appendChild(svc);
    var lg = el('div', 'set-field set-field-gap');
    lg.setAttribute('data-field', 'watchleagues');
    s.appendChild(lg);
    var key = el('div', 'set-field set-field-gap');
    key.setAttribute('data-field', 'watchtmdb');
    s.appendChild(key);
    var bg = el('div', 'set-field set-field-gap');
    bg.setAttribute('data-field', 'watchbg');
    s.appendChild(bg);
    var tp = el('div', 'set-field set-field-gap');
    tp.setAttribute('data-field', 'watchtilepv');
    s.appendChild(tp);
    // Lumen Alerts (watch-alerts-chrome.js draws it).
    var al = el('div', 'set-field set-field-gap');
    al.setAttribute('data-field', 'watchalerts');
    s.appendChild(al);
    var pl = el('div', 'set-field set-field-gap');
    pl.setAttribute('data-field', 'watchplayer');
    s.appendChild(pl);
    // Lumen play bar (watch-playerbar.js draws it).
    var pbar = el('div', 'set-field set-field-gap');
    pbar.setAttribute('data-field', 'watchplaybar');
    s.appendChild(pbar);
    var fg = el('div', 'set-field set-field-gap');
    fg.setAttribute('data-field', 'watchforget');
    s.appendChild(fg);
    return s;
  }

  function renderWatch() {
    renderWatchServices();
    renderWatchLeagues();
    renderWatchKey();
    renderWatchBackground();
    renderWatchTilePreview();
    renderWatchAlerts();
    renderWatchPlayer();
    renderWatchPlaybar();
    renderWatchForget();
  }

  /* "Play inside Watch" (watch-player-main.js owns it): on, a title plays in Watch's own
     player layer; off, it opens in a new tab (or Edge) as before. */
  var wpInside = null;
  function renderWatchPlayer() {
    var field = panelEl && panelEl.querySelector('[data-field="watchplayer"]');
    if (!field) return;
    var wp = window.api && window.api.watchPlayer;
    var hub = (window.WatchPlayerHosts && window.WatchPlayerHosts.HUB_NAME) || 'Lumen';
    field.textContent = '';
    if (!wp) { field.appendChild(el('p', 'set-hint', 'This build has no player channel, so titles open in a new tab.')); return; }
    var draw = function (on, why) {
      field.textContent = '';
      field.appendChild(switchRow('Play inside ' + hub, on, function (next) {
        wp.setInside(next).then(function (r) { wpInside = !!(r && r.inside); draw(wpInside); },
          function (err) { draw(on, 'Couldn’t save it: ' + ((err && err.message) || err)); });
      }));
      field.appendChild(el('p', 'set-hint', why || (on
        ? 'A title plays in ' + hub + ' itself; Back returns to the rows. “Open in a tab” stays in the player’s bar.'
        : 'A title opens in a new tab, or in Microsoft Edge when Quartz can’t play it.')));
      // Lumen's playback view (watch-playview.js): the player and Lumen's info, or the service's whole page.
      var PV = window.LumenPlayview;
      if (on && PV && typeof PV.setView === 'function') {
        var seg = segmented([{ id: 'lumen', name: hub + ' view' }, { id: 'page', name: 'The service’s full page' }], PV.view(), function (next) {
          PV.setView(next).then(function () { draw(on); }, function (err) { draw(on, 'Couldn’t save “When a video plays”: ' + ((err && err.message) || err)); });
        });
        seg.setAttribute('data-pv-view', PV.view());
        field.appendChild(controlRow('When a video plays', null, seg));
        field.appendChild(el('p', 'set-hint', PV.view() === 'lumen'
          ? 'Just the service’s own player, with ' + hub + '’s title, channel, Like and Subscribe under it. “Full page” in the player’s bar shows the whole page.'
          : 'The service’s whole page, as it looks in a tab.'));
      }
      // Lumen's leak log (watch-leaks.js): each time it had to send him to a tab, Edge or an app.
      if (leaks) {
        var lk = el('p', 'set-hint set-lumen-leaks', 'Times ' + hub + ' had to leave: ' + (leaks.count || 0) +
          (leaks.last && leaks.last.reason ? ', last: ' + leaks.last.reason + (leaks.last.at ? ' (' + watchAgo(leaks.last.at) + ')' : '') : ''));
        lk.setAttribute('data-leaks', String(leaks.count || 0));
        field.appendChild(lk);
      }
    };
    var leaks = null;
    if (wpInside !== null) draw(wpInside);
    wp.get().then(function (r) { wpInside = !(r && r.inside === false); leaks = r && r.leaks && typeof r.leaks === 'object' ? r.leaks : null; draw(wpInside); },
      function (err) { draw(true, 'Couldn’t read the setting: ' + ((err && err.message) || err)); });
  }

  function watchField(name) {
    var f = bodyEl && bodyEl.querySelector('[data-field="' + name + '"]');
    if (f) f.textContent = '';
    return f;
  }

  /** '5 min ago', '2 h ago', 'yesterday'... from a ms timestamp; '' for none. */
  function watchAgo(ms) {
    var t = Number(ms);
    if (!isFinite(t) || t <= 0) return '';
    var mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + ' h ago';
    var days = Math.round(hours / 24);
    return days === 1 ? 'yesterday' : days + ' days ago';
  }

  function watchBytes(n) {
    var b = Number(n);
    if (!isFinite(b) || b <= 0) return '0 KB';
    if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /** One service's state as a light and a sentence. Never blank. */
  function watchStatus(v) {
    var ago = watchAgo(v.state === 'ok' ? (v.lastOkAt || v.readAt) : v.readAt);
    if (!v.enabled || v.state === 'off') return { light: '', text: 'Off' };
    if (!v.hasReader) return { light: ' is-hold', text: 'This build has no reader for ' + v.name + '.' };
    if (v.reading) return { light: ' is-live', text: 'Reading now…' };
    if (v.paused) return { light: ' is-hold', text: 'Paused: ' + v.paused };
    if (v.queued) return { light: '', text: 'Waiting to read (another service is reading first)' };
    if (v.state === 'ok') {
      var t = 'Connected';
      if (ago) t += ' · read ' + ago;
      if (v.profile) t += ' · ' + v.profile;
      return { light: ' is-live', text: t };
    }
    if (v.state === 'signed-out') {
      return { light: ' is-hold', text: 'Signed out' + (v.reason ? ': ' + v.reason : '') + (ago ? ' (checked ' + ago + ')' : '') };
    }
    if (v.state === 'error') {
      return { light: ' is-hold', text: 'Couldn’t read: ' + (v.reason || 'no reason given') + (ago ? ' (' + ago + ')' : '') };
    }
    return { light: '', text: 'Not read yet' };
  }

  function watchReadout(light, text) {
    var p = el('p', 'set-readout');
    p.appendChild(el('span', 'set-pip' + (light || '')));
    p.appendChild(el('span', 'set-readout-text', text));
    return p;
  }

  function watchResultRow(slot) {
    var r = wtResult[slot];
    if (!r) return null;
    return watchReadout(r.ok ? ' is-live' : ' is-hold', r.text);
  }

  function watchTake(answer) {
    if (!answer || typeof answer !== 'object') return;
    wtState = answer;
    wtAskFailed = '';
    renderWatch();
    refreshFilter();
    if (wtFocus) {
      var back = panelEl && panelEl.querySelector(wtFocus);
      wtFocus = '';
      if (back) { try { back.focus(); } catch (err) { /* re-rendered away */ } }
    }
    watchPollIfBusy();
  }

  /**
   * Every write: call, take the describe() it answers, and hand the answer to
   * `after` (which writes the action's result line). A null answer, a throw or
   * a rejection is printed as `failed` in that same slot, never dropped.
   */
  function watchCall(method, args, slot, failed, after) {
    var api = watchApi();
    if (!api || typeof api[method] !== 'function') {
      wtResult[slot] = { ok: false, text: failed + ': this build has no Lumen support.' };
      renderWatch();
      return;
    }
    wtBusy = slot;
    renderWatch();
    var answer;
    try { answer = api[method].apply(api, args || []); } catch (err) {
      wtBusy = '';
      wtResult[slot] = { ok: false, text: failed + ': ' + ((err && err.message) || 'no reason given') + '.' };
      renderWatch();
      return;
    }
    Promise.resolve(answer).then(function (value) {
      wtBusy = '';
      if (!value || typeof value !== 'object') {
        wtResult[slot] = { ok: false, text: failed + ': Quartz did not answer.' };
        renderWatch();
        return;
      }
      if (typeof after === 'function') after(value);
      else if (value.error) wtResult[slot] = { ok: false, text: value.error };
      else wtResult[slot] = { ok: true, text: 'Saved.' };
      watchTake(value);
    }, function (err) {
      wtBusy = '';
      wtResult[slot] = { ok: false, text: failed + ': ' + ((err && err.message) || 'no reason given') + '.' };
      renderWatch();
    });
  }

  /** One describe() when the pane opens; again while a read is in flight. */
  function watchRefresh() {
    var api = watchApi();
    if (!api) { wtState = null; renderWatch(); return; }
    var answer;
    try { answer = api.describe(); } catch (err) {
      wtAskFailed = (err && err.message) || 'no reason given';
      renderWatch();
      return;
    }
    Promise.resolve(answer).then(function (value) {
      if (value) watchTake(value);
      else { wtAskFailed = 'Quartz did not answer'; renderWatch(); }
    }, function (err) {
      wtAskFailed = (err && err.message) || 'no reason given';
      renderWatch();
    });
  }

  function watchPollIfBusy() {
    window.clearTimeout(wtPollTimer);
    wtPollTimer = 0;
    if (!open_ || !wtState || !Array.isArray(wtState.services)) return;
    var busy = !!wtState.reading || wtState.services.some(function (v) { return v && (v.reading || v.queued); });
    if (busy) wtPollTimer = window.setTimeout(function () { if (open_) watchRefresh(); }, 3000);
  }

  function watchRelease() {
    window.clearTimeout(wtPollTimer);
    wtPollTimer = 0;
    window.clearTimeout(wtForgetTimer);
    wtForgetArmed = false;
  }

  function watchOpenUrl(url, what) {
    if (!/^https:\/\//.test(url || '')) return;
    if (typeof window.createTab === 'function') window.createTab(url);
    else showToast('Could not open ' + what + ': no tab strip in this window');
  }

  function renderWatchServices() {
    var field = watchField('watchservices');
    if (!field) return;
    if (!watchApi()) {
      field.appendChild(el('p', 'set-typing-notice',
        'This build has no Lumen support. Restart Quartz to pick up the newer build.'));
      return;
    }
    if (!wtState || !Array.isArray(wtState.services)) {
      field.appendChild(el('p', wtAskFailed ? 'set-note' : 'set-hint',
        wtAskFailed ? 'Lumen settings could not be read: ' + wtAskFailed + '.' : 'Reading Lumen settings…'));
      return;
    }
    // watch.json could not be read: say what Lumen did instead (watch-main.js loadPrefs).
    if (wtState.prefsNote) field.appendChild(el('p', 'set-note', String(wtState.prefsNote)));
    wtState.services.forEach(function (v, i) {
      if (!v || !v.id) return;
      var box = el('div', i ? 'set-field-gap' : '');
      box.appendChild(switchRow(v.name, !!v.enabled, function (next) {
        wtFocus = '[data-field="watchservices"] [data-watch-svc="' + v.id + '"]';
        watchCall('setEnabled', [v.id, next], 'svc:' + v.id, 'That switch could not be saved', function (ans) {
          wtResult['svc:' + v.id] = ans.error ? { ok: false, text: ans.error }
            : { ok: true, text: v.name + ' is ' + (next ? 'on.' : 'off. Its rows leave Lumen.') };
        });
      }));
      var sw = box.lastChild;
      if (sw && sw.setAttribute) sw.setAttribute('data-watch-svc', v.id);
      if (v.covers) box.appendChild(el('p', 'set-hint', v.covers));
      var st = watchStatus(v);
      box.appendChild(watchReadout(st.light, st.text));

      var row = el('div', 'set-path-row');
      var busy = wtBusy === 'read:' + v.id;
      var read = textButton(busy ? 'Asking…' : 'Read now', 'set-text set-watch-read', function () {
        if (wtBusy) return;
        wtFocus = '[data-watch-read="' + v.id + '"]';
        watchCall('refresh', [v.id], 'read:' + v.id, 'The read could not be started', function (ans) {
          var now = null;
          (ans.services || []).forEach(function (x) { if (x && x.id === v.id) now = x; });
          if (!now) wtResult['read:' + v.id] = { ok: false, text: 'Quartz answered without ' + v.name + '.' };
          else if (!now.enabled) wtResult['read:' + v.id] = { ok: false, text: 'Turn ' + v.name + ' on first.' };
          else if (now.paused) wtResult['read:' + v.id] = { ok: false, text: 'Not read: ' + now.paused };
          else if (now.reading || now.queued) wtResult['read:' + v.id] = { ok: true, text: 'Reading ' + v.name + '; the line above updates when it finishes.' };
          else wtResult['read:' + v.id] = { ok: false, text: 'Not started: it was read under 30 s ago. Try again in a moment.' };
        });
      });
      read.setAttribute('data-watch-read', v.id);
      read.disabled = !v.enabled || !!v.reading;
      row.appendChild(read);
      if (v.needsSignIn && v.enabled && v.state === 'signed-out' && v.signIn) {
        row.appendChild(textButton('Sign in', 'set-text set-watch-signin', function () {
          watchOpenUrl(v.signIn, v.name + '’s sign-in page');
        }));
      }
      box.appendChild(row);
      var res = watchResultRow('read:' + v.id) || watchResultRow('svc:' + v.id);
      if (res) box.appendChild(res);
      field.appendChild(box);
    });
  }

  function renderWatchLeagues() {
    var field = watchField('watchleagues');
    if (!field) return;
    if (!watchApi() || !wtState || !Array.isArray(wtState.allLeagues)) return;
    field.appendChild(el('span', 'set-label', 'Sports leagues'));
    var on = Array.isArray(wtState.leagues) ? wtState.leagues.slice() : [];
    var chipsEl = el('div', 'set-gal-chips');
    chipsEl.setAttribute('role', 'group');
    chipsEl.setAttribute('aria-label', 'Leagues in the sports strip');
    wtState.allLeagues.forEach(function (l) {
      if (!l || !l.id) return;
      var pressed = on.indexOf(l.id) !== -1;
      var chip = textButton(l.name || l.id, 'set-gal-chip', function () {
        // Kept in allLeagues order (NHL first), whatever order they were clicked in.
        var next = wtState.allLeagues.map(function (x) { return x.id; }).filter(function (id) {
          return id === l.id ? !pressed : on.indexOf(id) !== -1;
        });
        wtFocus = '[data-watch-league="' + l.id + '"]';
        watchCall('setLeagues', [next], 'leagues', 'The leagues could not be saved', function (ans) {
          wtResult.leagues = ans.error ? { ok: false, text: ans.error }
            : { ok: true, text: (ans.leagues && ans.leagues.length) ? 'Saved: ' + ans.leagues.length + ' league' + (ans.leagues.length === 1 ? '' : 's') + '.' : 'Saved: no leagues, so the sports strip is empty.' };
        });
      });
      chip.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      chip.setAttribute('data-watch-league', l.id);
      chipsEl.appendChild(chip);
    });
    field.appendChild(chipsEl);
    field.appendChild(el('p', 'set-hint', 'Games from these leagues fill the sports strip, from ESPN’s public scoreboard.'));
    var res = watchResultRow('leagues');
    if (res) field.appendChild(res);
  }

  function renderWatchKey() {
    var field = bodyEl && bodyEl.querySelector('[data-field="watchtmdb"]');
    if (!field) return;
    var typed = '';
    var live = field.querySelector('.set-path');
    if (live) typed = live.value;
    field.textContent = '';
    if (!watchApi() || !wtState) return;

    var label = el('label', 'set-label', 'TMDB key (search every service)');
    label.setAttribute('for', 'set-watch-key');
    field.appendChild(label);

    var tm = wtState.tmdb || {};
    var has = !!tm.hasKey;
    var row = el('div', 'set-path-row');
    var input = document.createElement('input');
    input.type = wtShowKey ? 'text' : 'password';
    input.id = 'set-watch-key';
    input.className = 'set-path';
    input.value = typed;
    input.placeholder = has ? (tm.keyMask || 'A key is saved') : 'Paste your key';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.title = has ? 'A key is saved. Type to replace it.' : 'Paste the API key or the API Read Access Token from your TMDB settings';
    row.appendChild(input);

    row.appendChild(textButton(wtShowKey ? 'Hide' : 'Show', 'set-text set-watch-eye', function () {
      wtShowKey = !wtShowKey;
      renderWatchKey();
      var again = field.querySelector('.set-path');
      if (again) { try { again.focus(); } catch (err) { /* gone */ } }
    }));

    row.appendChild(textButton('Save', 'set-btn set-watch-save', function () {
      var now = field.querySelector('.set-path');
      var next = now ? now.value.trim() : '';
      if (!next) return;
      wtShowKey = false;
      wtFocus = '.set-watch-save';
      if (now) now.value = '';
      watchCall('setTmdbKey', [next], 'key', 'That key could not be saved', function (ans) {
        wtResult.key = ans.error ? { ok: false, text: ans.error } : { ok: true, text: 'Key saved. Check key makes one small request to TMDB.' };
      });
    }));

    if (has) {
      var check = textButton(wtBusy === 'key' ? 'Checking…' : 'Check key', 'set-text set-watch-check', function () {
        if (wtBusy) return;
        wtFocus = '.set-watch-check';
        watchCall('testTmdb', [], 'key', 'The key could not be checked', function (ans) {
          var c = ans.check || {};
          wtResult.key = c.ok ? { ok: true, text: 'Checked: ' + (c.title || 'TMDB accepted the key') + '.' }
            : { ok: false, text: 'Check failed: ' + (c.title || 'no answer') + '.' + (c.detail ? ' ' + c.detail : '') };
        });
      });
      check.title = 'Makes one small request to TMDB with the saved key';
      row.appendChild(check);
      row.appendChild(textButton('Remove', 'set-text set-watch-clear', function () {
        wtShowKey = false;
        wtFocus = '#set-watch-key';
        watchCall('setTmdbKey', [''], 'key', 'That key could not be removed', function (ans) {
          wtResult.key = ans.error ? { ok: false, text: ans.error } : { ok: true, text: 'Key removed. Lumen searches YouTube and the rows it has read.' };
        });
      }));
    }
    field.appendChild(row);

    input.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var save = field.querySelector('.set-watch-save');
      if (save) save.click();
    });

    var res = watchResultRow('key');
    if (res) field.appendChild(res);
    keyAtRestNotes(field, tm, 'set-watch');

    var hint = el('p', 'set-hint');
    hint.appendChild(document.createTextNode(has
      ? 'Lumen’s search also finds where any film or show streams, across every service. '
      : 'Without a key, Lumen searches YouTube and the rows it has read. A free TMDB key adds searching every service: where any film or show streams, rents or is free. '));
    var signup = (tm.signupUrl && /^https:\/\//.test(tm.signupUrl)) ? tm.signupUrl : 'https://www.themoviedb.org/settings/api';
    var a = el('a', 'set-gal-link', 'Get a free key');
    a.href = signup;
    a.title = signup;
    a.addEventListener('click', function (e) { e.preventDefault(); watchOpenUrl(signup, 'the TMDB sign-up page'); });
    hint.appendChild(a);
    hint.appendChild(document.createTextNode(' (a TMDB account, then Settings › API). Stored by the browser itself and never given to a page.'));
    field.appendChild(hint);
    field.appendChild(el('p', 'set-hint', 'This product uses the TMDB API but is not endorsed or certified by TMDB.'));
    field.appendChild(el('p', 'set-hint', 'Where-to-watch data is provided by JustWatch.'));
  }

  /* Keep Watch up to date in the background (watch-main.js: the background refresh). */
  function renderWatchBackground() {
    var field = watchField('watchbg');
    if (!field) return;
    if (!watchApi() || !wtState) return;
    var b = wtState.background || { on: true, waiting: '', lastAt: 0 };
    var row = switchRow('Keep Lumen up to date in the background', !!b.on, function (on) {
      if (wtBusy) return;
      wtFocus = '.set-watch-bg';
      watchCall('setBackground', [on], 'background', 'The background setting could not be saved');
    });
    row.classList.add('set-watch-bg');
    if (wtBusy === 'background') row.disabled = true;
    field.appendChild(row);
    field.appendChild(el('p', 'set-hint',
      'Costs one hidden page per service at most once an hour, one at a time, closed when done (a few seconds and roughly 150–300 MB while it runs); ' +
      'skipped while a game runs, Quartz is minimised, battery saver is on or under 2.5 GB of memory is free.'));
    var st = '';
    if (b.on && b.waiting) st = 'Background updates are ' + b.waiting + '.';
    else if (b.on && b.lastAt) st = 'Last background update ' + watchAgo(b.lastAt) + '.';
    else if (b.on) st = 'No background update yet this session.';
    else st = 'Off: it updates only while it is on screen.';
    field.appendChild(el('p', 'set-hint set-watch-bg-state', st));
    var res = watchResultRow('background');
    if (res) field.appendChild(res);
  }

  /* Lumen play bar: "Lumen (default) / The service's own"; watch-playerbar.js draws it and applies it. */
  function renderWatchPlaybar() {
    var field = watchField('watchplaybar');
    if (!field || !window.LumenPlayerBar || typeof window.LumenPlayerBar.renderSetting !== 'function') return;
    try {
      window.LumenPlayerBar.renderSetting(field, { el: el, segmented: segmented });
    } catch (err) {
      field.textContent = '';
      field.appendChild(el('p', 'set-hint', 'The play bar setting could not draw: ' + ((err && err.message) || 'no reason given') + '.'));
    }
  }

  /* "Preview videos when I hover" (watch-tilepreview.js): on unless turned off. */
  function renderWatchTilePreview() {
    var field = watchField('watchtilepv');
    if (!field) return;
    if (!watchApi() || !wtState) return;
    var on = !(wtState.tilePreview && wtState.tilePreview.on === false);
    var row = switchRow('Preview videos when I hover', on, function (next) {
      if (wtBusy) return;
      wtFocus = '.set-watch-tilepv';
      watchCall('setTilePreview', [next], 'tilepv', 'The hover preview setting could not be saved');
    });
    row.classList.add('set-watch-tilepv');
    if (wtBusy === 'tilepv') row.disabled = true;
    field.appendChild(row);
    field.appendChild(el('p', 'set-hint',
      'Rest the pointer on a tile for a moment and it plays inside the tile, muted, with a progress line; leave it and it stops. ' +
      'YouTube tiles play the video; Disney+, Hulu and Prime Video tiles play the title’s trailer when TMDB lists one (with the TMDB key above). ' +
      'A click opens the player where the preview was. Never while a game runs, on battery saver, under 1.5 GB of free memory, ' +
      'or when Windows is set to reduce motion.'));
    var res = watchResultRow('tilepv');
    if (res) field.appendChild(res);
  }

  /* Lumen Alerts: its own file asks main and draws; this only hands it the field and the helpers. */
  function renderWatchAlerts() {
    var field = watchField('watchalerts');
    if (!field || !window.LumenAlertsSettings) return;
    try {
      window.LumenAlertsSettings.render(field, { el: el, switchRow: switchRow, textButton: textButton, ago: watchAgo });
    } catch (err) {
      field.textContent = '';
      field.appendChild(el('p', 'set-hint', 'Lumen Alerts could not draw its settings: ' + ((err && err.message) || 'no reason given') + '.'));
    }
  }

  function renderWatchForget() {
    var field = watchField('watchforget');
    if (!field) return;
    if (!watchApi() || !wtState) return;
    var size = watchBytes(wtState.cacheBytes);
    var row = el('div', 'set-path-row');
    var label = wtForgetArmed ? 'Press again to forget Lumen data' : 'Forget Lumen data (' + size + ')';
    var b = textButton(wtBusy === 'forget' ? 'Forgetting…' : label, 'set-text set-watch-forget', function () {
      if (wtBusy) return;
      if (!wtForgetArmed) {
        wtForgetArmed = true;
        wtFocus = '.set-watch-forget';
        renderWatchForget();
        var again = field.querySelector('.set-watch-forget');
        if (again) { try { again.focus(); } catch (err) { /* gone */ } }
        window.clearTimeout(wtForgetTimer);
        wtForgetTimer = window.setTimeout(function () {
          if (!wtForgetArmed) return;
          wtForgetArmed = false;
          renderWatchForget();
        }, 4000);
        return;
      }
      wtForgetArmed = false;
      window.clearTimeout(wtForgetTimer);
      var freed = size;
      wtFocus = '.set-watch-forget';
      watchCall('forget', [], 'forget', 'Lumen data could not be forgotten', function (ans) {
        var f = ans.forgot || {};
        wtResult.forget = f.ok === false ? { ok: false, text: 'Could not forget: ' + (f.reason || 'no reason given') + '.' }
          : { ok: true, text: 'Forgot ' + freed + ' of Lumen data. Settings and the key stay.' };
      });
    });
    row.appendChild(b);
    field.appendChild(row);
    field.appendChild(el('p', 'set-hint',
      'Deletes the rows Lumen has read and cached on this PC. The services keep your history; the next read fills it again.'));
    var res = watchResultRow('forget');
    if (res) field.appendChild(res);
  }

  /* ============================================================
     Stocks — the new tab page's live price tile

     THE ONE SECTION WITH NOTHING IN localStorage. Everything here lives in
     MAIN: stocks.js keeps <userData>/stocks.json and is the only process that
     ever holds the Finnhub key. So there is no DEFAULTS entry, no set({…})
     and no `get()` below — the state is whatever describe() last said, and
     every write goes out over window.api.stocks and comes back as the same
     shape. That is the same arrangement the Spotify rows have with the
     bridge, and for a stronger reason: a key in this file's localStorage
     object would be a key any devtools console could read.

     THE KEY ONLY EVER GOES ONE WAY. describe() answers `hasKey` and a
     `keyMask` ('••••4f21'), never the key. So the field is NEVER pre-filled:
     the mask is placeholder text, typing replaces the key, and the eye
     reveals only what has just been typed — a saved key cannot be shown
     because this side does not have it.
     ============================================================ */

  var stkState = null;        // the last describe(), or null before the first
  var stkFocus = '';          // which control to hand focus back to
  var stkShowKey = false;     // the eye: reveal what is being TYPED, only

  /** The preload bridge, or null on a build without one. */
  function stocksApi() {
    var api = window.api && window.api.stocks;
    return api && typeof api.describe === 'function' ? api : null;
  }

  function buildStocks() {
    var s = section('Stocks');

    var sw = el('div', 'set-field');
    sw.setAttribute('data-field', 'stockson');
    s.appendChild(sw);

    var key = el('div', 'set-field');
    key.setAttribute('data-field', 'finnhubkey');
    s.appendChild(key);

    var syms = el('div', 'set-field');
    syms.setAttribute('data-field', 'stocksymbols');
    s.appendChild(syms);

    return s;
  }

  function renderStocks() {
    renderStocksSwitch();
    renderFinnhubKey();
    renderStockSymbols();
  }

  /**
   * Every call into main answers the same describe() shape, so one taker
   * handles all four. A null answer means main refused the call (this is not
   * the chrome) and the section is left exactly as it was.
   */
  function stocksTake(answer) {
    if (!answer || typeof answer !== 'object') return;
    stkState = answer;
    renderStocks();
    refreshFilter();
    if (stkFocus) {
      var back = panelEl && panelEl.querySelector(stkFocus);
      stkFocus = '';
      if (back) { try { back.focus(); } catch (err) { /* re-rendered away */ } }
    }
  }

  /**
   * The write path, shaped like spotifyWrite(): guess the new state so the
   * control moves under the finger, send, and let the real answer correct it.
   * Nothing is stored locally on failure — main is the only side that knows
   * what is saved.
   */
  function stocksWrite(method, arg, guess, failed) {
    var api = stocksApi();
    if (!api || typeof api[method] !== 'function') return;
    if (stkState && typeof guess === 'function') {
      guess(stkState);
      renderStocks();
      refreshFilter();
    }
    var answer;
    try { answer = api[method](arg); }
    catch (err) { showToast(failed); return; }
    try {
      Promise.resolve(answer).then(function (value) {
        if (value) stocksTake(value);
        else showToast(failed);
      }, function () { showToast(failed); });
    } catch (err) { showToast(failed); }
  }

  /** One describe() when the pane opens. Quiet on failure: the rows hold. */
  function stocksRefresh() {
    var api = stocksApi();
    if (!api) { stkState = null; renderStocks(); return; }
    var answer;
    try { answer = api.describe(); } catch (err) { return; }
    try {
      Promise.resolve(answer).then(function (value) {
        if (value) stocksTake(value);
      }, function () { /* leave the last state up */ });
    } catch (err) { /* nothing to take */ }
  }

  function renderStocksSwitch() {
    var field = panelEl && panelEl.querySelector('[data-field="stockson"]');
    if (!field) return;
    field.textContent = '';

    /* No channel at all (an older preload): say so once rather than draw a
       switch that writes nowhere. */
    if (!stocksApi()) {
      field.appendChild(el('p', 'set-hint',
        'This build has no price channel, so the tile stays off.'));
      return;
    }

    var on = !!(stkState && stkState.enabled);
    field.appendChild(switchRow('Live prices on the new tab', on, function (next) {
      stkFocus = '[data-field="stockson"] .set-row';
      stocksWrite('setEnabled', next, function (st) { st.enabled = next; },
        'That switch could not be saved');
    }));
    field.appendChild(el('p', 'set-hint',
      'A tile in the bottom-right corner of the new tab: your symbols, the ' +
      'day’s change and an intraday chart. It holds no connection at all ' +
      'while that tab is not the one on screen.'));
  }

  function renderFinnhubKey() {
    var field = panelEl && panelEl.querySelector('[data-field="finnhubkey"]');
    if (!field) return;
    field.textContent = '';
    if (!stocksApi()) return;

    var has = !!(stkState && stkState.hasKey);
    var mask = (stkState && stkState.keyMask) || '';

    var label = el('label', 'set-label', 'Finnhub API key');
    label.setAttribute('for', 'set-finnhub-key');
    field.appendChild(label);

    var row = el('div', 'set-path-row');

    /* NEVER pre-filled — main does not hand the key back. The mask is the
       placeholder, so an empty field means "leave the saved one alone"
       rather than "clear it", and Remove is the only way to clear it. */
    var input = document.createElement('input');
    input.type = stkShowKey ? 'text' : 'password';
    input.id = 'set-finnhub-key';
    input.className = 'set-path';
    input.value = '';
    input.placeholder = has ? mask : 'Paste your key';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.title = has ? 'A key is saved. Type to replace it.' : 'Paste the key from finnhub.io';
    row.appendChild(input);

    /* The eye reveals what is BEING TYPED and nothing else: a key that is
       already saved is not on this side of the process boundary to show. */
    row.appendChild(textButton(stkShowKey ? 'Hide' : 'Show', 'set-text set-key-eye', function () {
      stkShowKey = !stkShowKey;
      var live = field.querySelector('.set-path');
      var typed = live ? live.value : '';
      renderFinnhubKey();
      var again = field.querySelector('.set-path');
      if (again) {
        again.value = typed;                    // a re-render must not eat it
        try { again.focus(); } catch (err) { /* gone */ }
      }
    }));

    row.appendChild(textButton('Save', 'set-btn set-key-save', function () {
      var live = field.querySelector('.set-path');
      var next = live ? live.value.trim() : '';
      if (!next) return;
      stkShowKey = false;
      stkFocus = '.set-key-save';
      stocksWrite('setKey', next, function (st) {
        st.hasKey = true;
        st.keyState = '';
      }, 'That key could not be saved');
    }));

    if (has) {
      row.appendChild(textButton('Remove', 'set-text set-key-clear', function () {
        stkShowKey = false;
        stkFocus = '.set-path';
        stocksWrite('setKey', '', function (st) {
          st.hasKey = false;
          st.keyMask = '';
          st.keyState = '';
          st.keyError = '';
          st.keyStorageNote = '';
        }, 'That key could not be removed');
      }));
    }

    field.appendChild(row);

    /* Enter saves, the same way the Claude folder field commits on Enter. */
    input.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var save = field.querySelector('.set-key-save');
      if (save) save.click();
    });

    if (stkState && stkState.keyState === 'rejected') {
      field.appendChild(el('p', 'set-note', 'Finnhub refused that key'));
    }
    if (stkState && stkState.error) field.appendChild(el('p', 'set-note set-stocks-error', stkState.error));
    keyAtRestNotes(field, stkState, 'set-stocks');

    field.appendChild(el('p', 'set-hint', stocksHint(stkState)));
  }

  /**
   * The line under the field. The history sentence is worth saying out loud:
   * a free key's candle endpoint answers 403, so the chart quietly comes from
   * Yahoo instead, and a user who does not know that reads it as broken.
   */
  function stocksHint(st) {
    var where = 'Get a free key at finnhub.io — it streams real-time US ' +
      'stock prices. Stored by the browser itself and never given to a page.';
    if (!st || !st.hasKey) return where;
    if (st.historyPath === 'finnhub') return where + ' The chart’s history comes from Finnhub.';
    if (st.historyPath === 'yahoo') {
      return where + ' Free keys cannot read Finnhub’s candles, so the ' +
        'chart’s history comes from Yahoo instead; the prices are still Finnhub’s.';
    }
    return where;
  }

  /**
   * The watchlist as one comma-separated line, mirroring the tile's own + and
   * x. Committed on blur and on Enter, like the Claude folder row; main
   * normalises, de-duplicates and caps it, and the answer is what gets drawn
   * back, so a typo simply does not survive the round trip.
   */
  function renderStockSymbols() {
    var field = panelEl && panelEl.querySelector('[data-field="stocksymbols"]');
    if (!field) return;
    field.textContent = '';
    if (!stocksApi()) return;

    var list = (stkState && Array.isArray(stkState.symbols)) ? stkState.symbols : [];
    var text = list.join(', ');

    var label = el('label', 'set-label', 'Symbols');
    label.setAttribute('for', 'set-stock-symbols');
    field.appendChild(label);

    var row = el('div', 'set-path-row');
    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'set-stock-symbols';
    input.className = 'set-path';
    input.value = text;
    input.placeholder = 'SPY, QQQ, NVDA';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'characters');
    row.appendChild(input);
    field.appendChild(row);
    field.appendChild(el('p', 'set-hint',
      'The same list the tile’s + and × edit. Eight at most.'));

    var before = text;
    var commit = function () {
      var next = input.value.split(/[\s,]+/).filter(function (s) { return !!s; });
      if (next.join(',').toUpperCase() === before.split(/[\s,]+/).join(',').toUpperCase()) return;
      if (!next.length) { input.value = before; return; }   // an empty list is not a list
      stkFocus = '#set-stock-symbols';
      stocksWrite('setSymbols', next, function (st) { st.symbols = next; },
        'Those symbols could not be saved');
    };
    input.addEventListener('change', commit);               // blur, and Enter
    input.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      input.blur();
    });
  }

  /**
   * Quiet the ads instead of pausing them. Spotify will not let anything
   * skip an ad, and muting it outright is what makes the player think it was
   * never heard — so the level goes to the bottom and comes back after.
   * Only a bridge that reports the field can answer, so an older helper (or
   * an older preload) leaves the row disabled with the reason under it.
   */
  function renderAdDuck() {
    var field = bodyEl && bodyEl.querySelector('[data-field="adduck"]');
    if (!field) return;
    field.textContent = '';

    var s = apStatus;
    var api = spotifyApi();
    var live = !!(api && s && s.installed && s.adDuck);

    var row = switchRow('Quiet Spotify ads', !!(live && s.adDuck.enabled), function (next) {
      spotifyWrite('setAdDuck', !!next, function (cur) {
        if (cur.adDuck) cur.adDuck.enabled = !!next;
      }, next ? 'Ad quieting could not be turned on' : 'Ad quieting could not be turned off');
    });
    if (!live) row.disabled = true;
    field.appendChild(row);

    if (!live) {
      field.appendChild(el('p', 'set-note', api
        ? 'The helper on this computer cannot do this yet'
        : 'Restart the browser to use this'));
    }

    field.appendChild(el('p', 'set-hint',
      'Ads still play, at the lowest in-app volume; it goes back to max when the ad ends.'));
  }

  /** The whole-computer switch, and the line that says what is true. */
  function renderAutopauseMain() {
    var field = bodyEl && bodyEl.querySelector('[data-field="autopause"]');
    if (!field) return;
    field.textContent = '';

    var s = apStatus;
    var live = !!(autopauseApi() && s && s.installed);

    var row = switchRow('Pause Spotify while videos play', !!(live && s.enabled), function (next) {
      autopauseWrite('setEnabled', !!next, function (cur) {
        cur.enabled = !!next;
        if (!next) { cur.bridge = 'stopped'; cur.port = null; cur.wePaused = false; }
      }, next ? 'Spotify auto-pause could not be started' : 'Spotify auto-pause could not be stopped');
    });
    if (!live) row.disabled = true;
    field.appendChild(row);

    field.appendChild(autopauseReadout());

    var trouble = apError || (s && s.error) || null;
    if (trouble) field.appendChild(el('p', 'set-note', trouble));

    field.appendChild(el('p', 'set-hint',
      'On lets Quartz pause Spotify while a video plays, and start it again after. ' +
      'On its own, Quartz covers its own tabs; with Mantle running, the two cooperate: ' +
      'one of them pauses Spotify, and a video in either one counts.'));
  }

  /** This browser's own tabs, and how many of them are playing. */
  function renderAutopauseBrowser() {
    var field = bodyEl && bodyEl.querySelector('[data-field="autopausebrowser"]');
    if (!field) return;
    field.textContent = '';

    var s = apStatus;
    var usable = !!(autopauseApi() && s && s.installed);

    var row = switchRow('Also pause for videos in this browser',
      !!(s && s.config.browserHold), function (next) {
        autopauseWrite('setConfig', { browserHold: !!next }, function (cur) {
          cur.config.browserHold = !!next;
        }, 'That switch could not be saved');
      });
    if (!usable) row.disabled = true;
    field.appendChild(row);

    var n = s ? s.audibleTabs : 0;
    if (n > 0) {
      field.appendChild(el('p', 'set-count',
        n === 1 ? '1 tab is playing right now' : n + ' tabs are playing right now'));
    }

    field.appendChild(el('p', 'set-hint',
      'A tab in this browser that is playing a video holds Spotify paused (which tabs count is set below). ' +
      'A muted tab does not count, so muting the video hands the music back.'));
  }

  /** Any sound at all, or only the sites named underneath. */
  function renderAutopauseSites() {
    var field = bodyEl && bodyEl.querySelector('[data-field="autopausesites"]');
    if (!field) return;
    field.textContent = '';
    apSitesEl = null;

    var s = apStatus;
    var usable = !!(autopauseApi() && s && s.installed);
    var any = !!(s && s.config.anySite);

    var row = switchRow('Any tab that makes sound', any, function (next) {
      autopauseWrite('setConfig', { anySite: !!next }, function (cur) {
        cur.config.anySite = !!next;
      }, 'That switch could not be saved');
    });
    if (!usable) row.disabled = true;
    field.appendChild(row);

    if (any) {
      field.appendChild(el('p', 'set-hint',
        'Every tab that makes a sound counts. Turn this off to name the sites yourself.'));
      return;
    }

    var label = el('label', 'set-label', 'Sites that count as a video');
    label.setAttribute('for', 'set-autopause-sites');
    field.appendChild(label);

    var ta = document.createElement('textarea');
    ta.id = 'set-autopause-sites';
    ta.className = 'set-hosts';
    ta.spellcheck = false;
    ta.setAttribute('aria-label', 'Sites that count as a video');
    ta.placeholder = 'youtube.com';
    ta.value = (s ? s.config.sites : AUTOPAUSE_SITES).join('\n');
    if (!usable) ta.disabled = true;
    // Escape leaves the field first; a second press then closes the panel.
    ta.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      ta.blur();
    });
    ta.addEventListener('change', function () { autopauseSaveSites(ta.value); });
    apSitesEl = ta;
    field.appendChild(ta);

    field.appendChild(el('p', 'set-hint',
      'One host per line. Subdomains count too, so youtube.com covers m.youtube.com.'));
  }

  /** doctor(), and its answer kept in a readout you can shut again. */
  function renderAutopauseHealth() {
    var field = bodyEl && bodyEl.querySelector('[data-field="autopausehealth"]');
    if (!field) return;
    field.textContent = '';

    var api = autopauseApi();
    var button = textButton(apChecking ? 'Checking…' : 'Check health', 'set-btn', function () {
      autopauseDoctor();
    });
    if (!api || typeof api.doctor !== 'function' || apChecking) button.disabled = true;
    field.appendChild(button);

    if (apReport) {
      var box = el('details', 'set-tokens set-health');
      if (apReportOpen) box.setAttribute('open', '');
      var sum = el('summary', 'set-tokens-sum' + (apReportOk ? '' : ' is-wrong'),
        apReportOk ? 'Health report' : 'Health report, something is wrong');
      box.appendChild(sum);
      box.appendChild(el('pre', 'set-health-text', apReport));
      box.addEventListener('toggle', function () {
        apReportOpen = box.hasAttribute('open');
      });
      field.appendChild(box);
    }

    field.appendChild(el('p', 'set-hint',
      'Reads the helper without changing anything: the task, the bridge, and Spotify itself.'));
  }

  /* ============================================================
     Phone - the user's phone on the screen

     LIKE STOCKS, NOTHING HERE IS IN localStorage. Every value is
     main's: phone.js owns the tools (adb + the scrcpy server), the
     pairing, the connection and the stream, and this section is a
     window onto its describe() plus the commands in its contract.
     So there is no DEFAULTS entry and no get()/set() below - the
     rows are whatever main last said, and every write goes out as
     api.phone.command(name, arg) and comes back as { ok, reason }.

     AND EVERY REASON IS SHOWN. A command that fails answers
     { ok: false, reason } and that reason is printed against the
     button that sent it, verbatim: while phone.js is still a
     scaffold, pressing Connect says so in those words rather than
     doing nothing. The same goes for a missing bridge, a describe()
     that answers null (main refused: not the chrome) and a call
     that throws. Nothing in this section may fail quietly.
     ============================================================ */

  var phnState = null;        // the last describe(), or null before the first
  var phnStateReason = '';    // why there is no state, when there is none
  var phnOff = null;          // the onUpdate unsubscribe, while the panel is open
  var phnWatching = false;
  var phnBusy = '';           // which command is in flight, so its button says so
  var phnResults = {};        // slot -> { ok, reason }: the last answer, shown inline
  var phnDraft = {};          // what is typed in the fields, kept across re-renders
  var phnForgetArmed = false;
  var phnForgetTimer = 0;

  /* Both readouts and every button key off these. 'error' is amber rather
     than unlit on purpose: something IS happening, and it is wrong. */
  var PHONE_LIVE = { ready: 1, paired: 1, connected: 1, running: 1 };
  var PHONE_HOLD = {
    downloading: 1, pairing: 1, connecting: 1, starting: 1,
    stalled: 1, unreachable: 1, error: 1
  };

  /** The preload bridge, or null on a build without one. */
  function phoneApi() {
    var api = window.api && window.api.phone;
    return api && typeof api.describe === 'function' ? api : null;
  }

  function phoneErrText(err) {
    if (!err) return 'no reason given';
    if (err.message) return String(err.message);
    return String(err);
  }

  /* --- the small pieces every field is built out of ------------- */

  function phoneLight(state) {
    if (PHONE_LIVE[state]) return ' is-live';
    if (PHONE_HOLD[state]) return ' is-hold';
    return '';
  }

  /** A pip, the state as a word, and the reason behind it, never dropped. */
  function phoneReadout(label, state, reason) {
    var p = el('p', 'set-readout');
    p.appendChild(el('span', 'set-pip' + phoneLight(state)));
    var text = label + ': ' + (state || 'unknown');
    if (reason) text += ' - ' + reason;
    p.appendChild(el('span', 'set-readout-text', text));
    return p;
  }

  /** A name on the left, a value on the right. Readouts only; nothing typed. */
  function phoneRow(label, value) {
    var row = el('div', 'set-ctl-row');
    row.appendChild(el('span', 'set-ctl-label', label));
    row.appendChild(el('span', 'set-readout-text', value));
    return row;
  }

  /**
   * A typed field. `phnDraft` is what is in it, so an onUpdate push landing
   * mid-word cannot swallow half a pairing code: the draft is seeded from
   * main's settings once and is the user's from then on.
   */
  function phoneInput(key, id, labelText, placeholder) {
    var row = el('div', 'set-ctl-row');
    var label = el('label', 'set-ctl-label', labelText);
    label.setAttribute('for', id);
    row.appendChild(label);

    var input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.className = 'set-path';
    input.value = phnDraft[key] === undefined ? '' : String(phnDraft[key]);
    input.placeholder = placeholder || '';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.addEventListener('input', function () { phnDraft[key] = input.value; });
    row.appendChild(input);
    return row;
  }

  /** The last answer to one command, against the button that sent it. */
  function phoneResultRow(slot) {
    var r = phnResults[slot];
    if (!r) return null;
    var p = el('p', 'set-readout');
    p.appendChild(el('span', 'set-pip' + (r.ok ? ' is-live' : ' is-hold')));
    p.appendChild(el('span', 'set-readout-text',
      (r.ok ? 'Done. ' : 'That did not work. ') + r.reason));
    return p;
  }

  /** A command button: busy while its call is out, and its answer under it. */
  function phoneButton(field, label, slot, run) {
    var row = el('div', 'set-path-row');
    var busy = phnBusy === slot;
    var b = textButton(busy ? 'Working...' : label, 'set-btn', run);
    if (busy) b.disabled = true;
    row.appendChild(b);
    field.appendChild(row);
    var answer = phoneResultRow(slot);
    if (answer) field.appendChild(answer);
    return b;
  }

  /* --- formatting ---------------------------------------------- */

  function phoneMb(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return '0';
    return (v / 1048576).toFixed(1);
  }

  function phoneKbps(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return '0 Mbps';
    return (v / 1000000).toFixed(1) + ' Mbps';
  }

  function phoneShaShort(sha) {
    if (typeof sha !== 'string' || !sha) return 'none yet';
    return sha.length > 12 ? sha.slice(0, 12) + '...' : sha;
  }

  /** settings.audioOutput, or its old `audio` mirror from a main that predates it. */
  function phoneSoundMode(s) {
    if (!s) return 'computer';
    if (s.audioOutput === 'computer' || s.audioOutput === 'phone' || s.audioOutput === 'both') {
      return s.audioOutput;
    }
    return s.audio === false ? 'phone' : 'computer';
  }

  function phoneSoundPlace(mode) {
    if (mode === 'phone') return 'on the phone';
    if (mode === 'both') return 'on the phone and this computer';
    return 'on this computer';
  }

  /**
   * Where the sound is going right now, in words. stream.audioOutput is the
   * mode the RUNNING stream started with (null while off); stream.audio going
   * false under a computer/both mode means the phone refused to send it, and
   * the Stream reason above says why.
   */
  function phoneSoundReadout(st, settings) {
    var saved = phoneSoundMode(settings);
    var running = st.audioOutput === 'computer' || st.audioOutput === 'phone' || st.audioOutput === 'both';
    if (!running) return 'will play ' + phoneSoundPlace(saved) + ' when mirroring starts';
    var line;
    if (st.audioOutput === 'phone') line = 'plays on the phone (nothing is sent here)';
    else if (!st.audio) line = 'meant to play ' + phoneSoundPlace(st.audioOutput) + ', but the phone is not sending it (see Stream)';
    else {
      line = 'plays ' + phoneSoundPlace(st.audioOutput) + ', ' +
        (st.audioCodec ? String(st.audioCodec) : 'no codec yet');
    }
    if (saved !== st.audioOutput) line += '; saved choice is ' + saved + ', used from the next start';
    return line;
  }

  function phoneAgo(at) {
    var t = Number(at);
    if (!isFinite(t) || t <= 0) return 'never';
    var secs = Math.round((Date.now() - t) / 1000);
    if (secs < 0) secs = 0;
    if (secs < 60) return secs + 's ago';
    if (secs < 3600) return Math.round(secs / 60) + 'm ago';
    return Math.round(secs / 3600) + 'h ago';
  }

  /* --- talking to main ----------------------------------------- */

  /** One describe(). A null answer is a reason too: main refused the call. */
  function phoneRefresh() {
    var api = phoneApi();
    if (!api) {
      phnState = null;
      phnStateReason = 'this build has no phone bridge (window.api.phone is missing)';
      renderPhone();
      return;
    }
    var answer;
    try { answer = api.describe(); }
    catch (err) {
      phnStateReason = 'describe() threw: ' + phoneErrText(err);
      renderPhone();
      return;
    }
    try {
      Promise.resolve(answer).then(function (value) {
        if (value && typeof value === 'object') phoneTake(value);
        else {
          phnState = null;
          phnStateReason = 'the browser answered nothing (main refused: not the chrome)';
          renderPhone();
        }
      }, function (err) {
        phnStateReason = 'describe() was refused: ' + phoneErrText(err);
        renderPhone();
      });
    } catch (err) {
      phnStateReason = 'describe() could not be called: ' + phoneErrText(err);
      renderPhone();
    }
  }

  /** Every state that lands - describe() or a push - comes through here. */
  function phoneTake(state) {
    if (!state || typeof state !== 'object') return;
    phnState = state;
    phnStateReason = '';
    phoneSeedDraft(state);
    renderPhone();
    refreshFilter();
  }

  /** The typed fields start at main's saved values, and only once. */
  function phoneSeedDraft(state) {
    var s = state && state.settings ? state.settings : null;
    if (!s) return;
    if (phnDraft.host === undefined) phnDraft.host = s.host ? String(s.host) : '';
    if (phnDraft.pairPort === undefined) {
      phnDraft.pairPort = (Number(s.pairPort) > 0) ? String(s.pairPort) : '';
    }
    if (phnDraft.port === undefined) phnDraft.port = (Number(s.port) > 0) ? String(s.port) : '';
    if (phnDraft.code === undefined) phnDraft.code = '';
  }

  /**
   * Send one command. The answer - ok or not - is recorded against `slot` and
   * drawn under that button. Nothing is guessed optimistically here: pairing
   * and connecting are slow and fallible, and a row that lies about them
   * would be worse than one that waits.
   */
  function phoneRun(name, arg, slot) {
    var key = slot || name;
    var api = phoneApi();
    if (!api || typeof api.command !== 'function') {
      phnResults[key] = { ok: false, reason: 'this build has no phone bridge (window.api.phone)' };
      renderPhone();
      return;
    }
    phnBusy = key;
    phnResults[key] = null;
    renderPhone();

    var settle = function (ok, reason) {
      phnBusy = '';
      phnResults[key] = { ok: ok, reason: reason };
      renderPhone();
    };

    var answer;
    try { answer = api.command(name, arg); }
    catch (err) { settle(false, 'the call threw: ' + phoneErrText(err)); return; }
    try {
      Promise.resolve(answer).then(function (value) {
        if (!value || typeof value !== 'object') {
          settle(false, 'the browser answered nothing at all');
          return;
        }
        settle(value.ok === true,
          value.reason ? String(value.reason) : (value.ok === true ? 'done' : 'no reason given'));
        phoneRefresh();          // whatever it did, the state may have moved
      }, function (err) {
        settle(false, 'the browser refused it: ' + phoneErrText(err));
      });
    } catch (err) {
      settle(false, 'the answer could not be read: ' + phoneErrText(err));
    }
  }

  /** One partial into settings.* over 'set-settings'. */
  function phoneSetSetting(partial, slot) {
    phoneRun('set-settings', partial, slot || 'set-settings');
  }

  /** Open: one describe() and a live subscription. Closed: neither. */
  function phoneWatch() {
    if (phnWatching) return;                   // opened twice is still one of each
    phnWatching = true;
    var api = phoneApi();
    if (api && typeof api.onUpdate === 'function') {
      try {
        var off = api.onUpdate(function (state) { phoneTake(state); });
        if (typeof off === 'function') phnOff = off;
      } catch (err) { phnOff = null; }
    }
    phoneRefresh();
  }

  function phoneRelease() {
    phnWatching = false;
    if (phnOff) {
      try { phnOff(); } catch (err) { /* the channel is already gone */ }
    }
    phnOff = null;
    phnForgetArmed = false;
    if (phnForgetTimer && typeof window.clearTimeout === 'function') {
      try { window.clearTimeout(phnForgetTimer); } catch (err) { /* already gone */ }
    }
    phnForgetTimer = 0;
  }

  /* --- the section --------------------------------------------- */

  function buildPhone() {
    var s = section('Phone');
    ['phonetools', 'phonepair', 'phoneconnect', 'phonedevice',
     'phonestream', 'phonequality', 'phoneforget'].forEach(function (name) {
      var f = el('div', 'set-field');
      f.setAttribute('data-field', name);
      s.appendChild(f);
    });
    return s;
  }

  /**
   * A re-render throws the fields away and builds them again, which would
   * take the caret with it while the user is typing a pairing code. So the
   * focused control's id and selection are put back afterwards.
   */
  function renderPhone() {
    var active = document.activeElement;
    var keepId = (active && active.id && panelEl && panelEl.contains(active)) ? active.id : '';
    var start = null;
    var end = null;
    if (keepId) {
      try { start = active.selectionStart; end = active.selectionEnd; }
      catch (err) { start = null; end = null; }
    }

    renderPhoneTools();
    renderPhonePair();
    renderPhoneConnect();
    renderPhoneDevice();
    renderPhoneStream();
    renderPhoneQuality();
    renderPhoneForget();

    if (!keepId) return;
    var back = document.getElementById(keepId);
    if (!back) return;
    try {
      back.focus();
      if (start !== null && typeof back.setSelectionRange === 'function') {
        back.setSelectionRange(start, end);
      }
    } catch (err) { /* the control is not a text field, or went away */ }
  }

  /** The field element, cleared, or null when the panel is not built yet. */
  function phoneField(name) {
    var field = panelEl && panelEl.querySelector('[data-field="' + name + '"]');
    if (!field) return null;
    field.textContent = '';
    return field;
  }

  /**
   * Said once, at the top: with no state there is nothing honest to draw in
   * any of the fields, so each one says why rather than showing zeroes.
   * @returns {boolean} true when the caller should stop.
   */
  function phoneNoState(field, what) {
    if (phnState) return false;
    field.appendChild(el('p', 'set-hint',
      'No ' + what + ' yet: ' + (phnStateReason || 'the browser has not answered describe() yet.')));
    return true;
  }

  function renderPhoneTools() {
    var field = phoneField('phonetools');
    if (!field) return;

    /* The one sentence that explains the whole section, and the one fact no
       readout can discover: if the phone's Tailscale is off, nothing below
       this line can work and every failure will be a timeout. */
    field.appendChild(el('p', 'set-hint',
      'Your phone on the screen, over Tailscale: adb and the scrcpy server are ' +
      'downloaded here, the phone is paired once, and the Phone workspace mirrors it. ' +
      'The phone\'s Tailscale has to be ON and connected - there is no cable path, ' +
      'and none of this goes over the open internet.'));

    /* The master switch, first, above everything it governs. Off means: the
       stream stops, adb disconnects and its server is killed, and nothing
       below reconnects, downloads or spawns adb again until this is on. The
       pairing is kept, so on is one press away. It is drawn even before the
       first state arrives (defaulting to on) so the way OUT never depends on
       the thing being switched off answering. Contract: settings.enabled in
       phone.js, written through 'set-settings' { enabled }. */
    var linkOn = !(phnState && phnState.settings && phnState.settings.enabled === false);
    field.appendChild(switchRow('Phone link', linkOn, function (next) {
      phoneSetSetting({ enabled: next }, 'set-enabled');
    }));
    field.appendChild(el('p', 'set-hint', linkOn
      ? 'On. Off disconnects the phone, stops adb, and never reconnects until you turn it back on. Pairing is kept.'
      : 'Off. The phone is disconnected and nothing here will reconnect, download or start adb until this is on.'));
    var linkAnswer = phoneResultRow('set-enabled');
    if (linkAnswer) field.appendChild(linkAnswer);

    if (phoneNoState(field, 'tool state')) {
      phoneButton(field, 'Download tools', 'install-tools', function () {
        phoneRun('install-tools', null, 'install-tools');
      });
      return;
    }

    var t = phnState.tools || {};
    field.appendChild(phoneReadout('Tools', t.state, t.reason));

    var prog = t.progress || {};
    if (Number(prog.total) > 0 || Number(prog.received) > 0) {
      field.appendChild(phoneRow('Downloading',
        phoneMb(prog.received) + ' of ' + phoneMb(prog.total) + ' MB, ' +
        (prog.item || 'unnamed')));
    }
    field.appendChild(phoneRow('adb', t.adbVersion ? String(t.adbVersion) : 'not installed'));
    field.appendChild(phoneRow('scrcpy server',
      (t.serverVersion ? 'v' + t.serverVersion : 'unknown') +
      ', sha ' + phoneShaShort(t.sha && t.sha.server)));
    field.appendChild(phoneRow('adb sha', phoneShaShort(t.sha && t.sha.adb)));
    if (t.sha && t.sha.server && t.sha.serverExpected && t.sha.server !== t.sha.serverExpected) {
      field.appendChild(el('p', 'set-hint',
        'That is NOT the published checksum (' + phoneShaShort(t.sha.serverExpected) +
        '). The server will not be used.'));
    }
    field.appendChild(phoneRow('Folder', t.dir ? String(t.dir) : 'not chosen yet'));

    phoneButton(field, t.state === 'ready' ? 'Check tools again' : 'Download tools',
      'install-tools', function () { phoneRun('install-tools', null, 'install-tools'); });
  }

  function renderPhonePair() {
    var field = phoneField('phonepair');
    if (!field) return;

    field.appendChild(el('p', 'set-label', 'Pairing'));
    field.appendChild(el('p', 'set-hint',
      'On the phone: Developer options, then Wireless debugging, then "Pair device ' +
      'with pairing code". It shows an IP address, a PAIRING port and six digits - ' +
      'and that pairing port is not the same number as the connect port below.'));

    field.appendChild(phoneInput('host', 'set-phone-host', 'Phone address', 'e.g. the phone\'s Tailscale IP'));
    field.appendChild(phoneInput('pairPort', 'set-phone-pairport', 'Pairing port', '37419'));
    field.appendChild(phoneInput('code', 'set-phone-code', 'Pairing code', '123456'));

    phoneButton(field, 'Pair', 'pair', function () {
      phoneRun('pair', {
        host: String(phnDraft.host || '').trim(),
        port: Number(String(phnDraft.pairPort || '').trim()),
        code: String(phnDraft.code || '').trim()
      }, 'pair');
    });

    if (phnState && phnState.device) {
      field.appendChild(phoneRow('Paired', phnState.device.paired ? 'yes' : 'not yet'));
    }
  }

  function renderPhoneConnect() {
    var field = phoneField('phoneconnect');
    if (!field) return;

    field.appendChild(el('p', 'set-label', 'Connection'));
    field.appendChild(phoneInput('port', 'set-phone-port', 'Connect port', '5555'));

    phoneButton(field, 'Connect', 'connect', function () {
      phoneRun('connect', {
        host: String(phnDraft.host || '').trim(),
        port: Number(String(phnDraft.port || '').trim())
      }, 'connect');
    });
    phoneButton(field, 'Disconnect', 'disconnect', function () {
      phoneRun('disconnect', null, 'disconnect');
    });

    var pinned = phnState && phnState.device ? phnState.device.tcpipPinned : null;
    field.appendChild(phoneRow('Port 5555',
      pinned === true ? 'pinned' : (pinned === false ? 'not pinned' : 'unknown')));
    phoneButton(field, 'Pin port 5555', 'pin-tcpip', function () {
      phoneRun('pin-tcpip', null, 'pin-tcpip');
    });
    field.appendChild(el('p', 'set-hint',
      'Wireless debugging picks a new connect port every time it is switched off ' +
      'and on again. Pinning 5555 holds one number until the phone reboots, and it ' +
      'keeps working when the phone is on cellular instead of Wi-Fi.'));
  }

  function renderPhoneDevice() {
    var field = phoneField('phonedevice');
    if (!field) return;

    field.appendChild(el('p', 'set-label', 'Phone'));
    if (phoneNoState(field, 'device state')) return;

    var d = phnState.device || {};
    field.appendChild(phoneReadout('Device', d.state, d.reason));
    field.appendChild(phoneRow('Name', d.name ? String(d.name) : 'not known yet'));
    field.appendChild(phoneRow('Model', d.model ? String(d.model) : 'not known yet'));
    field.appendChild(phoneRow('Android', d.android ? String(d.android) : 'not known yet'));
    field.appendChild(phoneRow('Address',
      d.host ? d.host + ':' + (Number(d.port) > 0 ? d.port : '?') : 'not set: type it under Pairing'));
    field.appendChild(phoneRow('Round trip',
      (Number(d.latencyMs) > 0) ? Math.round(d.latencyMs) + ' ms' : 'not measured'));
    field.appendChild(phoneRow('Battery', d.battery
      ? (Math.round(Number(d.battery.level) || 0) + '%' + (d.battery.charging ? ', charging' : ''))
      : 'not read'));
    field.appendChild(phoneRow('Last seen', phoneAgo(d.lastSeenAt)));
  }

  function renderPhoneStream() {
    var field = phoneField('phonestream');
    if (!field) return;

    field.appendChild(el('p', 'set-label', 'Mirroring'));
    if (!phoneNoState(field, 'stream state')) {
      var st = phnState.stream || {};
      field.appendChild(phoneReadout('Stream', st.state, st.reason));
      field.appendChild(phoneRow('Video',
        (st.codec ? String(st.codec) : 'no codec yet') + ', ' +
        (Number(st.width) > 0 ? st.width + 'x' + st.height : 'no size yet')));
      field.appendChild(phoneRow('Rate',
        (Number(st.fps) > 0 ? Math.round(st.fps) + ' fps' : '0 fps') + ', ' + phoneKbps(st.kbps * 1000)));
      field.appendChild(phoneRow('Profile in use', st.profile ? String(st.profile) : 'unknown'));
      field.appendChild(phoneRow('Sound', phoneSoundReadout(st, phnState.settings)));
      var ws = phnState.ws || {};
      field.appendChild(phoneRow('Page link',
        (Number(ws.port) > 0 ? 'ws port ' + ws.port : 'no socket yet') +
        ', ' + (Number(ws.clients) || 0) + ' connected'));
    }

    phoneButton(field, 'Start mirroring', 'start', function () {
      phoneRun('start', null, 'start');
    });
    phoneButton(field, 'Stop', 'stop', function () {
      phoneRun('stop', null, 'stop');
    });
  }

  function renderPhoneQuality() {
    var field = phoneField('phonequality');
    if (!field) return;

    field.appendChild(el('p', 'set-label', 'Quality'));
    if (phoneNoState(field, 'settings')) return;

    var s = phnState.settings || {};

    field.appendChild(controlRow('Profile', null, segmented([
      { id: 'lan',  name: 'At home' },
      { id: 'away', name: 'Away' },
      { id: 'auto', name: 'Auto' }
    ], s.profile, function (next) {
      phoneSetSetting({ profile: next }, 'set-profile');
    })));
    field.appendChild(el('p', 'set-hint',
      'At home is the full-rate stream over the local network; Away is the lean one ' +
      'for cellular. Auto picks between them on how the link is behaving.'));
    var profileAnswer = phoneResultRow('set-profile');
    if (profileAnswer) field.appendChild(profileAnswer);

    field.appendChild(controlRow('At-home bitrate', 'set-phone-lanrate', glassSelect(
      'set-phone-lanrate',
      [4, 8, 12, 16, 25].map(function (mb) {
        return { value: mb * 1000000, name: mb + ' Mbps' };
      }), s.lanBitrate, function (next) {
        phoneSetSetting({ lanBitrate: Number(next) }, 'set-lanrate');
      })));
    field.appendChild(controlRow('Away bitrate', 'set-phone-awayrate', glassSelect(
      'set-phone-awayrate',
      [500000, 1000000, 1500000, 2000000, 4000000].map(function (bps) {
        return { value: bps, name: (bps / 1000000).toFixed(1) + ' Mbps' };
      }), s.awayBitrate, function (next) {
        phoneSetSetting({ awayBitrate: Number(next) }, 'set-awayrate');
      })));
    field.appendChild(controlRow('Longest side', 'set-phone-maxsize', glassSelect(
      'set-phone-maxsize',
      [720, 1024, 1280, 1600, 1920].map(function (px) {
        return { value: px, name: px + ' px' };
      }), s.maxSize, function (next) {
        phoneSetSetting({ maxSize: Number(next) }, 'set-maxsize');
      })));
    field.appendChild(controlRow('Frame rate', 'set-phone-maxfps', glassSelect(
      'set-phone-maxfps',
      [24, 30, 48, 60].map(function (fps) {
        return { value: fps, name: fps + ' fps' };
      }), s.maxFps, function (next) {
        phoneSetSetting({ maxFps: Number(next) }, 'set-maxfps');
      })));

    var rateAnswer = phoneResultRow('set-lanrate') || phoneResultRow('set-awayrate')
      || phoneResultRow('set-maxsize') || phoneResultRow('set-maxfps');
    if (rateAnswer) field.appendChild(rateAnswer);

    /* Where the phone's sound plays (phone.js SOUND). Three places, one
       choice, so a segmented row, not a switch. A change restarts a live
       stream, which takes seconds: the row is disabled while the call is out
       and phone.js's answer (where sound now plays, or why the phone refused)
       lands under it. */
    var soundMode = phoneSoundMode(s);
    var soundBusy = phnBusy === 'set-audio';
    var soundSeg = segmented([
      { id: 'computer', name: 'Computer' },
      { id: 'phone',    name: 'Phone' },
      { id: 'both',     name: 'Both' }
    ], soundMode, function (next) {
      if (phnBusy === 'set-audio' || next === phoneSoundMode(phnState && phnState.settings)) return;
      phoneSetSetting({ audioOutput: next }, 'set-audio');
    });
    if (soundBusy) {
      Array.prototype.forEach.call(soundSeg.children, function (b) { b.disabled = true; });
      soundSeg.setAttribute('aria-busy', 'true');
    }
    field.appendChild(controlRow('Phone sound plays on', null, soundSeg));
    field.appendChild(el('p', 'set-hint', soundBusy
      ? 'Moving the sound — a running stream restarts for it...'
      : 'Computer: the phone goes quiet and its sound plays here. Phone: nothing is sent here and ' +
        'the phone plays as usual. Both: it plays on the phone and here (Android 13 and up); apps ' +
        'that block capture play on the phone only.'));
    var audioAnswer = phoneResultRow('set-audio');
    if (audioAnswer) field.appendChild(audioAnswer);

    field.appendChild(switchRow('Turn the phone screen off while mirroring',
      !!s.screenOffWhileMirroring, function (next) {
        phoneSetSetting({ screenOffWhileMirroring: next }, 'set-screenoff');
      }));
    /* The trap, named (hit for real 2026-09-13): with the panel off, a phone on
       battery still falls asleep at its own screen timeout, and a sleeping
       phone mirrors black until Wake. Only a charging phone stays awake. */
    field.appendChild(el('p', 'set-hint',
      'On Android 16 phones the mirror goes black the moment the panel is off — Android draws nothing for a powered-off display — so this only saves the panel, it does not keep a live picture; and on battery the phone then falls asleep at its screen timeout. Wake on the tab brings both back.'));
    var screenAnswer = phoneResultRow('set-screenoff');
    if (screenAnswer) field.appendChild(screenAnswer);

    field.appendChild(switchRow('Connect on its own when the browser starts',
      !!s.autoConnect, function (next) {
        phoneSetSetting({ autoConnect: next }, 'set-autoconnect');
      }));
    var autoAnswer = phoneResultRow('set-autoconnect');
    if (autoAnswer) field.appendChild(autoAnswer);
  }

  function renderPhoneForget() {
    var field = phoneField('phoneforget');
    if (!field) return;

    var row = el('div', 'set-path-row');
    var label = phnForgetArmed ? 'Press again to forget this phone' : 'Forget phone';
    row.appendChild(textButton(label, 'set-text', function () {
      if (!phnForgetArmed) {
        phnForgetArmed = true;
        renderPhone();
        if (typeof window.clearTimeout === 'function') window.clearTimeout(phnForgetTimer);
        if (typeof window.setTimeout === 'function') {
          phnForgetTimer = window.setTimeout(function () {
            if (!phnForgetArmed) return;
            phnForgetArmed = false;
            renderPhone();
          }, 4000);
        }
        return;
      }
      phnForgetArmed = false;
      if (typeof window.clearTimeout === 'function') window.clearTimeout(phnForgetTimer);
      phoneRun('forget', null, 'forget');
    }));
    field.appendChild(row);

    var answer = phoneResultRow('forget');
    if (answer) field.appendChild(answer);

    field.appendChild(el('p', 'set-hint',
      'Drops the stored address, port and pairing state. The adb keys stay, so the ' +
      'phone does not have to be paired from scratch unless it forgets this computer too.'));
  }

  /* ------------------------------------------------------------
     Notes pane

     The split pane beside the tabs that shows a note from a folder of
     .html notes and jumps to the section matching the question on
     screen (notes-pane.js draws it, notes-pane-main.js is its brain in
     main). It is OFF until a folder is picked here: main keeps the
     folder in <userData>\notes-pane.json, written through the
     'set-dir' command, and this section is the one place that turns
     the pane on or off. The optional keys in that file (a reader app
     to follow, the helper, a budget source) have no rows of their own;
     the section names the file so they can be set by hand, and each is
     off while unset.

     Contract: window.api.notes = { describe(), command(name, arg),
     onUpdate(cb) -> unsubscribe }. state.configured / dir / configFile /
     subjects / ready / reason. Like Phone, the section is live while
     the panel is: one describe() and one subscription, both given back
     in closePanel(). Nothing here fails quietly: a missing bridge, a
     refused command and a folder main rejects all say so, in words.
     ------------------------------------------------------------ */

  var ntsState = null;        // the last describe() or push, or null before the first
  var ntsStateReason = '';    // why there is no state, when there is none
  var ntsOff = null;          // the onUpdate unsubscribe, while the panel is open
  var ntsWatching = false;
  var ntsBusy = '';           // 'pick' or 'set-dir' while that call is out
  var ntsResult = null;       // { ok, reason }: the last folder change, shown under the buttons

  /** window.api.notes, or null on a build whose preload has no notes bridge. */
  function notesApi() {
    var api = window.api;
    return (api && api.notes && typeof api.notes.describe === 'function') ? api.notes : null;
  }

  function notesErrText(err) {
    return (err && err.message) ? String(err.message) : String(err || 'unknown error');
  }

  /** Every state that lands - describe() or a push - comes through here. */
  function notesTake(state) {
    if (!state || typeof state !== 'object') return;
    ntsState = state;
    ntsStateReason = '';
    renderNotesPane();
    refreshFilter();
  }

  function notesRefresh() {
    var api = notesApi();
    if (!api) { ntsState = null; renderNotesPane(); return; }
    var pending;
    try { pending = api.describe(); } catch (err) {
      ntsStateReason = 'the call threw: ' + notesErrText(err);
      renderNotesPane();
      return;
    }
    Promise.resolve(pending).then(function (state) {
      if (state && typeof state === 'object') { notesTake(state); return; }
      ntsStateReason = 'the browser answered nothing at all';
      renderNotesPane();
    }, function (err) {
      ntsStateReason = 'the browser refused it: ' + notesErrText(err);
      renderNotesPane();
    });
  }

  /** Open: one describe() and a live subscription. Closed: neither. */
  function notesWatch() {
    if (ntsWatching) return;                   // opened twice is still one of each
    ntsWatching = true;
    var api = notesApi();
    if (api && typeof api.onUpdate === 'function') {
      try {
        var off = api.onUpdate(function (state) { notesTake(state); });
        if (typeof off === 'function') ntsOff = off;
      } catch (err) { ntsOff = null; }
    }
    notesRefresh();
  }

  function notesRelease() {
    ntsWatching = false;
    if (ntsOff) {
      try { ntsOff(); } catch (err) { /* the channel is already gone */ }
    }
    ntsOff = null;
  }

  /**
   * 'set-dir' { dir }: main checks the folder, writes notes-pane.json (its
   * other keys kept), rescans and pushes. null turns the pane off. Its answer
   * - ok or not - is drawn under the buttons; nothing is assumed early.
   */
  function notesSetDir(dir) {
    var api = notesApi();
    if (!api || typeof api.command !== 'function') {
      ntsResult = { ok: false, reason: 'this build has no notes bridge (window.api.notes)' };
      renderNotesPane();
      return;
    }
    ntsBusy = 'set-dir';
    ntsResult = null;
    renderNotesPane();
    var settle = function (ok, reason) {
      ntsBusy = '';
      ntsResult = { ok: ok, reason: reason };
      renderNotesPane();
    };
    var answer;
    try { answer = api.command('set-dir', { dir: dir }); }
    catch (err) { settle(false, 'the call threw: ' + notesErrText(err)); return; }
    Promise.resolve(answer).then(function (value) {
      if (!value || typeof value !== 'object') {
        settle(false, 'the browser answered nothing at all');
        return;
      }
      var done = dir ? 'the notes folder is set.' : 'the notes pane is off.';
      settle(value.ok === true,
        value.reason ? String(value.reason) : (value.ok === true ? done : 'no reason given'));
      notesRefresh();          // whatever it did, the state may have moved
    }, function (err) {
      settle(false, 'the browser refused it: ' + notesErrText(err));
    });
  }

  /** The folder picker, starting at the current folder; a cancel changes nothing. */
  function notesChoose() {
    var app = window.api && window.api.app;
    if (!app || typeof app.pickFolder !== 'function') {
      ntsResult = { ok: false, reason: 'this build has no folder picker (window.api.app.pickFolder is missing)' };
      renderNotesPane();
      return;
    }
    var start = (ntsState && typeof ntsState.dir === 'string') ? ntsState.dir : '';
    var failed = function (err) {
      ntsBusy = '';
      ntsResult = { ok: false, reason: 'the folder picker failed: ' + notesErrText(err) };
      renderNotesPane();
    };
    ntsBusy = 'pick';
    ntsResult = null;
    renderNotesPane();
    var pending;
    try { pending = app.pickFolder(start); } catch (err) { failed(err); return; }
    Promise.resolve(pending).then(function (picked) {
      ntsBusy = '';
      if (typeof picked !== 'string' || !picked) { renderNotesPane(); return; } // cancelled
      notesSetDir(picked);
    }, failed);
  }

  function buildNotesPane() {
    var s = section('Notes pane');
    var f = el('div', 'set-field');
    f.setAttribute('data-field', 'notespane');
    s.appendChild(f);
    return s;
  }

  /** A name on the left, a value on the right. Readouts only; nothing typed. */
  function notesRow(label, value) {
    var row = el('div', 'set-ctl-row');
    row.appendChild(el('span', 'set-ctl-label', label));
    row.appendChild(el('span', 'set-readout-text', value));
    return row;
  }

  /** A pip and a line: live for a good answer, hold for one that says why not. */
  function notesReadout(ok, text) {
    var p = el('p', 'set-readout');
    p.appendChild(el('span', 'set-pip' + (ok ? ' is-live' : ' is-hold')));
    p.appendChild(el('span', 'set-readout-text', text));
    return p;
  }

  function renderNotesPane() {
    var field = panelEl && panelEl.querySelector('[data-field="notespane"]');
    if (!field) return;
    field.textContent = '';

    if (!notesApi()) {
      field.appendChild(el('p', 'set-hint',
        'This build has no notes pane bridge (window.api.notes is missing), so the ' +
        'notes pane cannot be set up or shown.'));
      return;
    }
    if (!ntsState) {
      field.appendChild(el('p', 'set-hint', ntsStateReason
        ? 'Could not read the notes pane state: ' + ntsStateReason
        : 'Reading the notes pane state…'));
      return;
    }

    var st = ntsState;
    var on = st.configured === true;
    var busy = ntsBusy !== '';
    var row = el('div', 'set-path-row');

    if (!on) {
      field.appendChild(el('p', 'set-hint',
        'Shows a note from a folder of .html notes beside your tabs and jumps to the ' +
        'section that matches the question on screen. Off until you pick a folder.'));
      // A folder that was set and has gone missing is "off" too; main says which.
      if (st.reason) field.appendChild(notesReadout(false, 'Off: ' + String(st.reason)));
      var pick = textButton(busy ? 'Working…' : 'Choose folder…', 'set-btn', notesChoose);
      if (busy) pick.disabled = true;
      row.appendChild(pick);
      field.appendChild(row);
    } else {
      var subjects = Array.isArray(st.subjects) ? st.subjects.filter(Boolean) : [];
      var sections = 0;
      for (var i = 0; i < subjects.length; i++) {
        if (Array.isArray(subjects[i].sections)) sections += subjects[i].sections.length;
      }
      field.appendChild(notesRow('Folder', String(st.dir || '')));
      field.appendChild(notesRow('Notes found', subjects.length
        ? subjects.length + (subjects.length === 1 ? ' note, ' : ' notes, ') +
          sections + (sections === 1 ? ' section' : ' sections')
        : 'none'));
      if (st.ready === false || !subjects.length) {
        field.appendChild(notesReadout(false, st.reason
          ? String(st.reason)
          : 'No .html notes were found in this folder.'));
      }
      var change = textButton(busy ? 'Working…' : 'Change folder…', 'set-btn', notesChoose);
      var off = textButton('Turn off', 'set-text', function () { notesSetDir(null); });
      if (busy) { change.disabled = true; off.disabled = true; }
      row.appendChild(change);
      row.appendChild(off);
      field.appendChild(row);
    }

    if (ntsResult) {
      field.appendChild(notesReadout(ntsResult.ok,
        (ntsResult.ok ? 'Done. ' : 'That did not work. ') + ntsResult.reason));
    }

    if (on) {
      field.appendChild(el('p', 'set-hint',
        'To show it, open the workspace menu from the pill in the title bar, press a ' +
        'workspace’s “Folder and pane” button and pick Notes under Pane. It opens ' +
        'beside the tabs whenever that workspace is on screen.'));
      if (st.configFile) {
        field.appendChild(el('p', 'set-hint',
          'Optional extras (a reader app to follow, the helper, a budget source) are keys ' +
          'in ' + String(st.configFile) + '. Each one is off while it is unset.'));
      }
    }
  }

  /* ------------------------------------------------------------
     Shortcuts

     When shortcuts.js is loaded the section is an editor over
     window.Shortcuts. Without it, the printed table below — the
     map as it was before anything was rebindable — still stands.
     ------------------------------------------------------------ */

  /** The module, or null when it is absent or too old to drive the editor. */
  function shortcutsApi() {
    var mod = window.Shortcuts;
    if (!mod) return null;
    var needed = ['all', 'label', 'combo', 'set', 'reset', 'resetAll', 'conflict'];
    for (var i = 0; i < needed.length; i++) {
      if (typeof mod[needed[i]] !== 'function') return null;
    }
    return mod;
  }

  /**
   * Shortcuts folds like every other section now; the one thing particular
   * to it is that folding it away cancels a recording, which applyFold()
   * does through `shortcutsSectionEl`.
   */
  function buildShortcuts() {
    var s = section('Shortcuts');
    var field = el('div', 'set-field');
    field.setAttribute('data-field', 'shortcuts');
    s.appendChild(field);
    shortcutsSectionEl = s;
    return s;
  }

  /** The old read-only map: two columns, keycaps and a description. */
  function staticShortcuts() {
    var table = el('div', 'set-keys');
    SHORTCUTS.forEach(function (pair) {
      var keys = el('div', 'set-keycell');
      String(pair[0]).split(' / ').forEach(function (combo, i) {
        if (i) keys.appendChild(el('span', 'set-keysep', '/'));
        combo.split('+').forEach(function (cap, j) {
          if (j) keys.appendChild(el('span', 'set-keyplus', '+'));
          keys.appendChild(el('span', 'set-key', cap));
        });
      });
      table.appendChild(keys);
      table.appendChild(el('div', 'set-keydesc', pair[1]));
    });
    return table;
  }

  /* A group caption reads as a sentence, not a title: only the first
     letter is ours to touch — 'Claude' stays 'Claude'. */
  function sentenceCase(text) {
    var s = String(text == null ? '' : text);
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function shortcutLabelFor(api, id) {
    var list = [];
    try { list = api.all() || []; } catch (err) { list = []; }
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return String(list[i].label || id);
    }
    return String(id);
  }

  /**
   * Keycaps for a combo, or the quiet 'Not set' when it is unbound. A structural
   * action with no single canonical combo carries a hint instead ('Ctrl+1 ...
   * Ctrl+9'): it is bound, so printing 'Not set' over it would be a lie.
   */
  function paintCombo(cell, api, combo, hint) {
    if (!combo) {
      cell.appendChild(el('span', 'set-keynone', hint ? String(hint) : 'Not set'));
      return;
    }
    var parts = null;
    try { parts = api.label(combo); } catch (err) { parts = null; }
    if (!parts || !parts.length) parts = String(combo).split('+');
    parts.forEach(function (cap, i) {
      if (i) cell.appendChild(el('span', 'set-keyplus', '+'));
      cell.appendChild(el('span', 'set-key', cap));
    });
  }

  /** The row that is recording, so a click inside it is not 'elsewhere'. */
  function recordingRow() {
    if (recId === null || !bodyEl) return null;
    var rows = bodyEl.querySelectorAll('.set-shortcut');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-id') === recId) return rows[i];
    }
    return null;
  }

  function startRecording(id) {
    recId = id;
    recPending = '';
    recNote = '';
    recUnbound = null;
    renderShortcuts();
  }

  function stopRecording() {
    if (recId === null) return;
    recId = null;
    recPending = '';
    recNote = '';
    renderShortcuts();
  }

  /**
   * Commit a combo (or null, to unbind) to the row being recorded.
   * The module's own listeners repaint first; the displaced row's
   * 'Now unbound' note is ours to add on the render after that.
   */
  function commitCombo(api, id, combo) {
    recId = null;
    recPending = '';
    recNote = '';
    var res = null;
    try { res = api.set(id, combo); } catch (err) { res = null; }
    if (res && res.ok === false) {
      recUnbound = null;
      renderShortcuts();
      showToast(res.reason ? String(res.reason) : 'That shortcut is fixed');
      return;
    }
    recUnbound = (res && res.displaced) ? res.displaced : null;
    renderShortcuts();
  }

  function shortcutRow(api, item, displaced) {
    var row = el('div', 'set-shortcut');
    row.setAttribute('data-id', String(item.id));
    row.appendChild(el('div', 'set-shortcut-label', String(item.label || item.id)));

    var cell = el('div', 'set-keycell');
    if (recId === item.id) {
      var pill = el('span', 'set-rec', recNote || 'Press keys…');
      pill.setAttribute('role', 'status');
      cell.appendChild(pill);
    } else {
      paintCombo(cell, api, item.combo, item.hint);
      if (displaced === item.id) cell.appendChild(el('span', 'set-keynote', 'Now unbound'));
    }
    row.appendChild(cell);

    var acts = el('div', 'set-shortcut-acts');
    if (!item.fixed) {
      var recording = recId === item.id;
      acts.appendChild(textButton(recording ? 'Cancel' : 'Change',
        'set-text set-key-change', function () {
          if (recording) stopRecording();
          else startRecording(item.id);
        }));
      if (item.changed) {
        acts.appendChild(textButton('Reset', 'set-text set-key-reset', function () {
          try { api.reset(item.id); } catch (err) { /* module's problem */ }
          recUnbound = null;
          renderShortcuts();
        }));
      }
    }
    row.appendChild(acts);
    return row;
  }

  function renderShortcuts() {
    var field = bodyEl && bodyEl.querySelector('[data-field="shortcuts"]');
    if (!field) return;
    field.textContent = '';

    var api = shortcutsApi();
    if (!api) {
      recId = null;
      field.appendChild(staticShortcuts());
      return;
    }

    /* the note lives for exactly one render */
    var displaced = recUnbound;
    recUnbound = null;

    var list = [];
    try { list = api.all() || []; } catch (err) { list = []; }
    if (!list.length) {
      field.appendChild(el('p', 'set-empty', 'No shortcuts to show.'));
      return;
    }

    var order = [];
    var byGroup = {};
    list.forEach(function (item) {
      if (!item || !item.id) return;
      var g = item.group ? String(item.group) : 'Other';
      if (!byGroup[g]) { byGroup[g] = []; order.push(g); }
      byGroup[g].push(item);
    });

    order.forEach(function (name) {
      field.appendChild(el('p', 'set-group', sentenceCase(name)));
      var table = el('div', 'set-shortcuts');
      byGroup[name].forEach(function (item) {
        table.appendChild(shortcutRow(api, item, displaced));
      });
      field.appendChild(table);
    });

    var label = resetAllArmed ? 'Press again to reset every shortcut' : 'Reset all shortcuts';
    var cls = 'set-text set-keys-resetall' + (resetAllArmed ? ' is-armed' : '');
    field.appendChild(textButton(label, cls, function () {
      if (!resetAllArmed) {
        resetAllArmed = true;
        renderShortcuts();
        window.clearTimeout(resetAllTimer);
        resetAllTimer = window.setTimeout(function () {
          if (!resetAllArmed) return;
          resetAllArmed = false;
          renderShortcuts();
        }, 4000);
        return;
      }
      resetAllArmed = false;
      window.clearTimeout(resetAllTimer);
      try { api.resetAll(); } catch (err) { /* module's problem */ }
      recUnbound = null;
      renderShortcuts();
      showToast('Shortcuts reset');
    }));
  }

  /**
   * The capture-phase pass while a row is recording: the keystroke is the
   * panel's, not the browser's, so Ctrl+T records instead of opening a tab.
   */
  function recordKey(event) {
    if (recId === null) return;
    var api = shortcutsApi();
    if (!api) { stopRecording(); return; }

    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    event.settingsRecorded = true;          // the panel's Escape stays out of it

    var key = event.key;
    if (key === 'Escape') { stopRecording(); return; }
    if (key === 'Backspace' || key === 'Delete') { commitCombo(api, recId, null); return; }

    var combo = null;
    try { combo = api.combo(event); } catch (err) { combo = null; }
    if (!combo) return;                     // a bare modifier: keep listening

    var holder = null;
    try { holder = api.conflict(combo); } catch (err) { holder = null; }
    if (holder && holder !== recId && recPending !== combo) {
      recPending = combo;
      recNote = 'Used by ' + shortcutLabelFor(api, holder) + '. Press again to take it';
      renderShortcuts();
      return;
    }
    commitCombo(api, recId, combo);
  }

  /** One line for About from main's app:profile answer. */
  function profileLine(p) {
    var where = 'Profile: ' + (p.userData || 'unknown folder');
    if (p.test) return where + ' (test profile, never moved)';
    var start = p.thisStart || {};
    var note = p.note;
    if (note && note.from) {
      var when = new Date(note.at);
      when = isNaN(when.getTime()) ? String(note.at) : when.toLocaleString();
      return where + ' · moved here from ' + note.from + ' on ' + when;
    }
    if (start.action === 'moved') {
      return where + ' · moved here from ' + start.from + ' at this start (its note could not be saved: ' +
        (start.noteError || 'unknown') + ')';
    }
    return where;
  }

  /**
   * How old the Chromium inside this build is, in one plain sentence for About.
   *
   * Chromium security fixes reach Quartz only when its Electron is updated (it is pinned to a
   * castlabs build for Widevine; the policy is in docs/engineering-notes.md), so the age of the
   * build is the honest measure of how current the engine is. The date comes from
   * window.api.app.versions().built: the build time Electron's own release files carry, read
   * from disk by preload. Nothing is fetched for this; no network call is made from About.
   * When the date is not there (an older preload), the sentence says so instead of guessing.
   *
   * v: the versions object (or null); now: a Date. Pure, so it can be exercised without a window.
   */
  function chromiumAgeLine(v, now) {
    var engine = (v && v.chrome) ? 'Chromium ' + v.chrome : 'This Chromium';
    var built = v && v.built ? new Date(v.built) : null;
    if (!built || isNaN(built.getTime())) {
      return 'How old ' + (v && v.chrome ? 'Chromium ' + v.chrome : 'this Chromium') +
        ' is cannot be shown: this window did not report when its Electron was built.';
    }
    var days = Math.max(0, Math.floor((now.getTime() - built.getTime()) / 86400000));
    var when = built.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    var age = days === 0 ? 'today' : days === 1 ? 'yesterday' :
      days < 14 ? days + ' days ago' : days < 70 ? Math.floor(days / 7) + ' weeks ago' : Math.floor(days / 30) + ' months ago';
    var sentence = engine + ' was built on ' + when + ' (' + age + ').';
    if (days > 21) {
      sentence += ' Chromium ships security fixes every week or two, so a build this old is probably missing some.';
    }
    return sentence;
  }

  function buildAbout() {
    /* The one section with no fold: plain heading, always open (the user's call). */
    var s = plainSection('About');
    var line = 'Quartz';
    var app = window.api && window.api.app;
    var v = null;
    if (app && typeof app.versions === 'function') {
      try {
        v = app.versions() || {};
        if (v.electron) line += ' · Electron ' + v.electron;
        if (v.chrome) line += ' · Chromium ' + v.chrome;
      } catch (err) { v = null; /* older preload: the bare name is still true */ }
    }
    s.appendChild(el('p', 'set-about', line));
    s.appendChild(el('p', 'set-hint', chromiumAgeLine(v, new Date())));

    /* Where the profile lives, and the one-time move from %APPDATA%\browser
       to %APPDATA%\Quartz when it happened. That move renames the folder with
       every login in it, so it is said here in plain words rather than left
       to a console line nobody reads. */
    if (app && typeof app.profile === 'function') {
      var prof = el('p', 'set-hint', 'Profile: asking…');
      s.appendChild(prof);
      Promise.resolve().then(function () { return app.profile(); }).then(function (p) {
        prof.textContent = profileLine(p || {});
      }).catch(function (err) {
        prof.textContent = 'Profile: the main process did not answer (' + ((err && err.message) || err) + ')';
      });
    }

    /* Updating this browser means closing and reopening it, so here is the
       one click that does it. app.js owns the action (window.restartBrowser)
       because it flushes the session snapshot first; the bare preload call is
       the fallback for a chrome that has not exposed it. */
    var restart = el('div', 'set-field');
    restart.setAttribute('data-field', 'restart');
    restart.appendChild(textButton('Restart browser', 'set-btn', function () {
      if (typeof window.restartBrowser === 'function') {
        window.restartBrowser();
        return;
      }
      var api = window.api && window.api.app;
      if (api && typeof api.restart === 'function') api.restart();
    }));
    restart.appendChild(el(
      'p',
      'set-hint',
      'Closes and reopens the browser with your tabs restored. Use it after an update.'
    ));
    s.appendChild(restart);

    /* Updates (updater-chrome.js draws them): the "Check for updates" switch, the state in one
       sentence with its reason, Check now, and the Update button or why there is none. */
    var updates = el('div', 'set-field set-updates');
    updates.setAttribute('data-field', 'updates');
    if (window.QuartzUpdates && typeof window.QuartzUpdates.renderAbout === 'function') {
      try {
        window.QuartzUpdates.renderAbout(updates, { el: el, textButton: textButton, switchRow: switchRow, toast: showToast });
      } catch (err) {
        updates.appendChild(el('p', 'set-hint', 'Updates could not be drawn: ' + ((err && err.message) || err)));
      }
    } else {
      updates.appendChild(el('p', 'set-hint', 'Updates: this window did not load updater-chrome.js; restart Quartz.'));
    }
    s.appendChild(updates);

    /* The first-run welcome, on demand (firstrun.js opens it as a tab). */
    var welcome = el('div', 'set-field');
    welcome.setAttribute('data-field', 'welcome');
    var fr = window.FirstRun;
    var again = textButton('Show welcome again', 'set-btn', function () {
      var f = window.FirstRun;
      if (!f || typeof f.open !== 'function') { showToast('The welcome is not available in this window; restart Quartz'); return; }
      closePanel();
      f.open();
    });
    again.setAttribute('data-action', 'show-welcome');
    welcome.appendChild(again);
    welcome.appendChild(el('p', 'set-hint', fr && typeof fr.open === 'function'
      ? 'Opens the first-run tab: look, search engine, default browser and a short tour.'
      : 'The welcome is not available in this window; restart Quartz.'));
    s.appendChild(welcome);
    return s;
  }

  /* ============================================================
     Panel
     ============================================================ */

  /** The nav-row instrument: same recipe as #theme, one slot to its right. */
  function injectButton() {
    if (document.getElementById('settings')) {
      buttonEl = document.getElementById('settings');
      return;
    }
    var navrow = document.querySelector('.navrow');
    if (!navrow) return;

    buttonEl = document.createElement('button');
    buttonEl.id = 'settings';
    buttonEl.className = 'glass iconbtn no-drag';
    buttonEl.type = 'button';
    buttonEl.title = 'Settings';
    buttonEl.setAttribute('aria-label', 'Settings');
    buttonEl.setAttribute('aria-haspopup', 'dialog');
    buttonEl.setAttribute('aria-expanded', 'false');
    buttonEl.appendChild(el('span', 'glyph', GLYPH_GEAR));
    buttonEl.addEventListener('click', function () { toggle(); });

    var theme = document.getElementById('theme');
    if (theme && theme.parentNode === navrow) {
      navrow.insertBefore(buttonEl, theme.nextSibling);
    } else {
      navrow.appendChild(buttonEl);
    }
  }

  /* ============================================================
     Find a setting — the filter under the panel's title

     The panel is one long scroll of twelve sections, so the fastest way
     to a control is to name it. Typing narrows the scroll to the fields
     that carry every word; the rest of the panel folds away, headings
     and all, and the matched words are lit where they are read.
     ============================================================ */

  var filterEl = null;          // the input in the head
  var noneEl = null;            // the "No settings match" line
  var filterTimer = 0;

  /* Only where a setting is NAMED. A hint or a keycap still matches the
     query — it is part of the index — but lighting words inside a
     paragraph turns the panel into a page of highlighter. */
  var MARK_IN = ['.set-label', '.set-row-label', '.set-shortcut-label', '.set-opt'];

  var FOCUSABLE = ['button', 'input', 'select', 'textarea', 'a'];

  function searchText(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /** Every word, in any order, somewhere in the haystack. */
  function hasWords(hay, words) {
    for (var i = 0; i < words.length; i++) if (hay.indexOf(words[i]) < 0) return false;
    return true;
  }

  /**
   * textContent, but with a space wherever one element ends and the next
   * begins. Two buttons reading "Dark" and "Light" are one string to
   * textContent — "darklight" — and no query would ever spell that.
   */
  function deepText(node) {
    var kids = node.childNodes || [];
    var out = '';
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeType === 1) out += ' ' + deepText(n) + ' ';
    }
    return out;
  }

  /**
   * The index, one lowercased string per .set-field, read off the rendered
   * text: labels, hints, option names, keycaps — plus the section's own
   * heading and any hint that sits outside the fields, so "address bar"
   * finds the search engine list. Rebuilt by renderAll(), because a
   * re-render replaces the very nodes this reads.
   */
  function indexFields() {
    if (!bodyEl) return;
    var sections = bodyEl.querySelectorAll('.set-section');
    for (var i = 0; i < sections.length; i++) {
      var s = sections[i];
      var fields = s.querySelectorAll('.set-field');
      var chrome = '';                     // the section's text outside its fields
      /* The heading is outside the fold, the rest of the chrome inside it:
         reading the body's children rather than the section's is what keeps
         one field's text out of its neighbours' index. */
      var head = s.querySelector('.set-h');
      if (head) chrome += ' ' + deepText(head) + ' ';
      /* .set-rows: a fold's body, or About's (it has no fold, but the sheet
         gives it a body of its own) -- its fields still index apart. */
      var host = s.querySelector('.set-rows') || s;
      var kids = host.children;
      for (var k = 0; k < kids.length; k++) {
        var kid = kids[k];
        if (kid.classList && kid.classList.contains('set-field')) continue;
        if (kid.classList && kid.classList.contains('set-h')) continue;
        chrome += ' ' + deepText(kid) + ' ';
      }
      /* About has no fields at all: the section is then its own unit. */
      s.setAttribute('data-search', searchText(deepText(s)));
      for (var j = 0; j < fields.length; j++) {
        fields[j].setAttribute('data-search', searchText(chrome + ' ' + deepText(fields[j])));
      }
    }
  }

  /** Text nodes under `root`, skipping the marks a previous pass left. */
  function textNodes(root, out) {
    out = out || [];
    var kids = root.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) out.push(n);
      else if (n.nodeType === 1 && n.tagName !== 'MARK') textNodes(n, out);
    }
    return out;
  }

  /**
   * Light every hit in one text node. A host name, a chip label and a
   * shortcut name are all user data, so nothing here goes near innerHTML:
   * the only nodes made are text nodes and <mark>.
   */
  function markTextNode(node, words) {
    var text = node.nodeValue || '';
    var low = text.toLowerCase();
    var spans = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      var at = low.indexOf(w);
      while (at >= 0) { spans.push([at, at + w.length]); at = low.indexOf(w, at + w.length); }
    }
    if (!spans.length) return;
    spans.sort(function (a, b) { return a[0] - b[0]; });

    var merged = [];                       // two words can overlap: light one run
    for (var k = 0; k < spans.length; k++) {
      var last = merged[merged.length - 1];
      if (last && spans[k][0] <= last[1]) last[1] = Math.max(last[1], spans[k][1]);
      else merged.push([spans[k][0], spans[k][1]]);
    }

    var parent = node.parentNode;
    if (!parent) return;
    var cut = 0;
    for (var m = 0; m < merged.length; m++) {
      if (merged[m][0] > cut) {
        parent.insertBefore(document.createTextNode(text.slice(cut, merged[m][0])), node);
      }
      var mk = document.createElement('mark');
      mk.textContent = text.slice(merged[m][0], merged[m][1]);
      parent.insertBefore(mk, node);
      cut = merged[m][1];
    }
    if (cut < text.length) parent.insertBefore(document.createTextNode(text.slice(cut)), node);
    parent.removeChild(node);
  }

  function markField(field, words) {
    for (var i = 0; i < MARK_IN.length; i++) {
      var hits = field.querySelectorAll(MARK_IN[i]);
      for (var j = 0; j < hits.length; j++) {
        var texts = textNodes(hits[j]);
        for (var t = 0; t < texts.length; t++) markTextNode(texts[t], words);
      }
    }
  }

  /** normalize(), kept local, so the next split never straddles two nodes. */
  function mergeTextNodes(parent) {
    var kids = [];
    for (var i = 0; i < parent.childNodes.length; i++) kids.push(parent.childNodes[i]);
    var prev = null;
    for (var j = 0; j < kids.length; j++) {
      var n = kids[j];
      if (n.nodeType !== 3) { prev = null; continue; }
      if (prev) { prev.nodeValue = (prev.nodeValue || '') + (n.nodeValue || ''); parent.removeChild(n); }
      else prev = n;
    }
  }

  function unmarkAll() {
    if (!bodyEl) return;
    var marks = bodyEl.querySelectorAll('mark');
    var parents = [];
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      var p = m.parentNode;
      if (!p) continue;
      p.insertBefore(document.createTextNode(m.textContent), m);
      p.removeChild(m);
      if (parents.indexOf(p) < 0) parents.push(p);
    }
    for (var j = 0; j < parents.length; j++) mergeTextNodes(parents[j]);
  }

  /**
   * Hide every field the query misses, then every section left with nothing
   * showing. A field with no index yet — a render that landed between two
   * passes — counts as a match: the filter narrows the panel, it never
   * swallows a control it has not read.
   */
  function applyFilter() {
    filterTimer = 0;
    if (!bodyEl) return;
    var words = searchText(filterEl ? filterEl.value : '');
    words = words ? words.split(' ') : [];
    unmarkAll();

    var sections = bodyEl.querySelectorAll('.set-section');
    var anyShown = false;
    for (var i = 0; i < sections.length; i++) {
      var s = sections[i];
      var fields = s.querySelectorAll('.set-field');
      var shown = 0;
      for (var j = 0; j < fields.length; j++) {
        var idx = fields[j].getAttribute('data-search');
        var hit = !words.length || idx === null || hasWords(idx, words);
        fields[j].hidden = !hit;
        if (!hit) continue;
        shown++;
        if (words.length) markField(fields[j], words);
      }
      var on = fields.length
        ? shown > 0
        : (!words.length || hasWords(s.getAttribute('data-search') || '', words));
      s.hidden = !on;
      if (on) anyShown = true;
    }

    if (noneEl) noneEl.hidden = !words.length || anyShown;
    if (panelEl) panelEl.classList.toggle('is-filtering', words.length > 0);
    syncFolds(words.length > 0);
    syncNav();
    renderTitle();
  }

  /** Index and filter in one breath — what a re-render owes the filter. */
  function refreshFilter() {
    indexFields();
    applyFilter();
  }

  /* 40ms: long enough that a fast typist filters once per word rather than
     once per keystroke, short enough that the panel still feels live. */
  function scheduleFilter() {
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(applyFilter, 40);
  }

  function clearFilter() {
    window.clearTimeout(filterTimer);
    filterTimer = 0;
    if (filterEl) filterEl.value = '';
    applyFilter();
  }

  /** The first control still on screen, in reading order. */
  function firstControl(node) {
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.hidden) continue;
      /* not on show: a section the sheet is not showing, a pane folded away */
      if (n.getClientRects && !n.getClientRects().length) continue;
      var tag = String(n.tagName || '').toLowerCase();
      if (FOCUSABLE.indexOf(tag) >= 0 && !n.disabled) return n;
      var deeper = firstControl(n);
      if (deeper) return deeper;
    }
    return null;
  }

  function focusFirstResult() {
    var hit = bodyEl ? firstControl(bodyEl) : null;
    if (hit && typeof hit.focus === 'function') hit.focus();
    return hit;
  }

  function filterKeys(event) {
    if (event.key === 'Escape') {
      /* The first Escape empties the field; only a second one, on a field
         already empty, is allowed through to close the panel. */
      if (filterEl && filterEl.value) {
        event.preventDefault();
        event.stopPropagation();
        clearFilter();
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      focusFirstResult();
    }
  }

  function buildFilter() {
    var row = el('div', 'set-filter-row');
    row.appendChild(el('span', 'set-filter-glyph glyph', GLYPH_SEARCH));
    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'set-filter';
    input.className = 'set-filter';
    input.placeholder = 'Find a setting';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Find a setting');
    input.addEventListener('input', scheduleFilter);
    input.addEventListener('keydown', filterKeys);
    row.appendChild(input);
    filterEl = input;
    return row;
  }

  /**
   * The sheet lives on <body>, not inside .chrome-layer: the chrome layer
   * carries a blur filter before boot, and a fixed element there would be
   * clipped to it rather than floating over the tab well.
   *
   * Two panes, as Mantle's Settings and Helm's are laid out: on the left the
   * title, Find a setting and a nav with one row per section; on the right
   * the section on show, its name over it and the close button beside it.
   * A soft scrim sits over the page behind the sheet (a click on it closes).
   */
  function buildPanel() {
    if (document.getElementById('settings-panel')) {
      panelEl = document.getElementById('settings-panel');
      bodyEl = panelEl.querySelector('.set-body');
      return;
    }
    scrimEl = el('div', 'set-scrim');
    scrimEl.id = 'settings-scrim';
    scrimEl.setAttribute('aria-hidden', 'true');
    scrimEl.hidden = true;
    /* The document's mousedown already closes the sheet; this keeps the
       click from moving focus off the gear it hands the keyboard back to. */
    scrimEl.addEventListener('mousedown', function (ev) { ev.preventDefault(); });

    panelEl = document.createElement('div');
    panelEl.id = 'settings-panel';
    panelEl.className = 'set-sheet';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-modal', 'true');
    panelEl.setAttribute('aria-label', 'Settings');
    panelEl.setAttribute('data-pane', 'nav');
    panelEl.tabIndex = -1;
    panelEl.hidden = true;
    panelEl.addEventListener('keydown', trapTab);

    var side = el('div', 'set-side');
    var sideHead = el('div', 'set-side-head');
    sideHead.appendChild(el('span', 'set-title', 'Settings'));
    side.appendChild(sideHead);
    side.appendChild(buildFilter());
    navEl = el('nav', 'set-nav');
    navEl.setAttribute('aria-label', 'Settings sections');
    navEl.addEventListener('keydown', navKeys);
    side.appendChild(navEl);
    panelEl.appendChild(side);

    var main = el('div', 'set-main');
    var mainHead = el('div', 'set-main-head');
    mainHead.appendChild(iconButton(GLYPH_BACK, 'All settings', 'set-act set-back', function () {
      setPane('nav');
      var cur = navEl && navEl.querySelector('.set-nav-item[aria-current="page"]');
      if (cur) cur.focus();
    }));
    titleEl = el('h2', 'set-page-title');
    titleEl.id = 'set-page-title';
    mainHead.appendChild(titleEl);
    main.appendChild(mainHead);

    bodyEl = el('div', 'set-body');
    /* Focusable, not tabbable: a picked section hands the keyboard here. */
    bodyEl.tabIndex = -1;
    bodyEl.setAttribute('role', 'region');
    bodyEl.setAttribute('aria-labelledby', 'set-page-title');
    bodyEl.appendChild(buildLook());
    bodyEl.appendChild(buildClaude());
    bodyEl.appendChild(buildTabs());
    bodyEl.appendChild(buildDownloads());
    bodyEl.appendChild(buildSearch());
    bodyEl.appendChild(buildTyping());
    bodyEl.appendChild(buildSites());
    bodyEl.appendChild(buildDrm());
    bodyEl.appendChild(buildWatch());
    bodyEl.appendChild(buildSiteStyles());
    bodyEl.appendChild(buildUserStyle());
    bodyEl.appendChild(buildNewTab());
    bodyEl.appendChild(buildHome());
    bodyEl.appendChild(buildMusic());
    bodyEl.appendChild(buildPrivacy());
    bodyEl.appendChild(buildSpotify());
    bodyEl.appendChild(buildStocks());
    bodyEl.appendChild(buildPhone());
    bodyEl.appendChild(buildNotesPane());
    bodyEl.appendChild(buildShortcuts());
    bodyEl.appendChild(buildAbout());

    noneEl = el('p', 'set-none', 'No settings match');
    noneEl.hidden = true;
    bodyEl.appendChild(noneEl);

    main.appendChild(bodyEl);
    panelEl.appendChild(main);
    /* Last in the sheet, over both panes: the top-right corner in either layout. */
    panelEl.appendChild(iconButton(GLYPH_CLOSE, 'Close', 'set-act set-x', function () { closePanel(); }));

    document.body.appendChild(scrimEl);
    document.body.appendChild(panelEl);
    buildNav();
    setCurrent(allSections()[0] || null);
    renderAll();
  }

  function renderAll() {
    renderLook();
    renderClaude();
    renderTabs();
    renderWorkspaceSleep();
    renderDownloads();
    renderSearch();
    renderKeywords();
    renderTyping();
    renderSites();
    renderDrm();
    renderWatch();
    renderSiteStyles();
    renderUserStyle();
    renderNewtabBg();
    renderChips();
    renderHome();
    renderMusic();
    renderPrivacy();
    renderSpotify();
    renderStocks();
    renderPhone();
    renderShortcuts();
    refreshFilter();          // the text just changed under the index
  }

  /**
   * The scrim and the sheet start under the nav row, so the tabs, the address
   * bar and the gear that toggles the sheet stay in reach and undimmed. CSS
   * has the same default (titlebar + nav row) for a row it cannot measure.
   */
  function position() {
    if (!panelEl) return;
    var row = (buttonEl && buttonEl.closest && buttonEl.closest('.navrow')) || document.querySelector('.navrow');
    var r = row ? row.getBoundingClientRect() : null;
    var top = r && r.height ? Math.round(r.bottom) + 'px' : '';
    panelEl.style.setProperty('--set-top', top);
    if (scrimEl) scrimEl.style.setProperty('--set-top', top);
  }

  /** What Tab can reach in the sheet right now, in order. */
  function tabbables() {
    if (!panelEl) return [];
    var all = panelEl.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.disabled || n.tabIndex < 0) continue;
      if (!n.getClientRects || !n.getClientRects().length) continue;   // display:none, or folded away
      out.push(n);
    }
    return out;
  }

  /** Focus stays in the sheet while it is open: Tab off either end wraps round. */
  function trapTab(event) {
    if (!open_ || event.key !== 'Tab' || event.defaultPrevented) return;
    var list = tabbables();
    if (!list.length) return;
    var first = list[0];
    var last = list[list.length - 1];
    var a = document.activeElement;
    var outside = !a || a === panelEl || !panelEl.contains(a);
    if (event.shiftKey ? (a === first || outside) : (a === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  /**
   * `at` is a section heading — Settings.open('Spotify') is a deep link from
   * anywhere else in the browser, and it opens the sheet on that section.
   * Called with nothing, the sheet opens on the section it was left on (Look
   * the first time), with the nav first in the narrow single-pane layout.
   */
  function openPanel(at) {
    if (!panelEl) return;
    var target = at ? findSection(at) : null;
    /* A deep link lands on the section whole, so a query left in the box
       gives way to it. A plain open keeps the query: renderAll() ends in the
       filter, which re-shows its own hits on the way in. */
    if (target && filterEl && filterEl.value) filterEl.value = '';
    unfoldAll();
    renderAll();
    setCurrent(target || findSection(lastSection) || allSections()[0] || null);
    setPane(target ? 'main' : 'nav');
    position();
    if (scrimEl) scrimEl.hidden = false;
    panelEl.hidden = false;
    open_ = true;
    /* The Spotify readout is live only while the pane is: one subscription
       and one 4s poll, started here and taken down again in closePanel(). */
    autopauseWatch();
    /* And one describe() for the Stocks section: its state lives in main, so
       the rows are drawn from whatever main last said until the answer lands.
       One call per open, never a poll -- nothing in that section moves on its
       own. */
    stocksRefresh();
    /* And one for the Brave key under Search, for the same reason. */
    braveRefresh();
    /* And one for the Claude key and this month's answer spend beside it. */
    claudeRefresh();
    /* And one for Watch: main owns its state. While a read is in flight it
       asks again every few seconds (watchPollIfBusy); closePanel() stops that. */
    watchRefresh();
    /* And the Phone section, which unlike Stocks DOES move on its own: a
       download's progress, a device coming and going, a stream's bitrate.
       So it takes a subscription as well as one describe(), and gives both
       back in closePanel() - nothing of this section is left running. */
    phoneWatch();
    /* And the Typing section: main owns it and a page's right-click menu
       changes it, so it is live while the pane is, like Phone. */
    spellWatch();
    /* And the Notes pane section: main owns its folder and pushes on every
       change, so it is live while the pane is, like Phone. */
    notesWatch();
    if (buttonEl) {
      buttonEl.classList.add('is-open');
      buttonEl.setAttribute('aria-expanded', 'true');
    }
    /* Opened from the gear or the shortcut, focus lands on the PANEL, not
       in the filter. A focused text field blinks its caret twice a second,
       and under the acrylic window every one of those repaints re-composes
       the column above it: the user saw the address bar flicker whenever the
       pane was open. Tab or Ctrl+F reaches the filter; Escape still closes.
       Opened with somewhere in the panel already focused — a re-render, a
       control handing focus back — that focus is left alone. */
    var active = document.activeElement;
    if (!active || !panelEl.contains(active)) {
      if (!panelEl.hasAttribute('tabindex')) panelEl.setAttribute('tabindex', '-1');
      try { panelEl.focus({ preventScroll: true }); } catch (err) { /* not focusable yet */ }
    }
    /* Back to the top of the list. It has to happen with the panel on screen:
       a display:none element drops a scrollTop assignment and hands back its
       old offset when it is shown again, and opening the folded list already
       scrolled to wherever the last visit ended reads as a bug. */
    if (bodyEl) bodyEl.scrollTop = 0;
  }

  /**
   * Escape, the close button, the scrim, the gear and Settings.close() all end
   * here. When the keyboard was in the sheet it goes back to the gear, so the
   * next Tab starts where the sheet was opened from; a click that took focus
   * somewhere else (a tab, the address bar) keeps it there.
   */
  function closePanel() {
    var a = document.activeElement;
    var hadFocus = !!(open_ && panelEl && a && (a === panelEl || panelEl.contains(a)));
    if (panelEl) panelEl.hidden = true;
    if (scrimEl) scrimEl.hidden = true;
    open_ = false;
    if (hadFocus && buttonEl && typeof buttonEl.focus === 'function') {
      try { buttonEl.focus({ preventScroll: true }); } catch (err) { /* the row is gone */ }
    }
    autopauseRelease();
    phoneRelease();
    spellRelease();
    notesRelease();
    watchRelease();
    if (buttonEl) {
      buttonEl.classList.remove('is-open');
      buttonEl.setAttribute('aria-expanded', 'false');
    }
  }

  function toggle() {
    if (open_) closePanel();
    else openPanel();
  }

  function isOpen() {
    return open_;
  }

  /* ============================================================
     Ctrl+D — add the page you are on
     ============================================================ */

  function bookmarkActivePage() {
    var tab = typeof window.getActiveTab === 'function' ? window.getActiveTab() : null;
    if (!tab || tab.kind !== 'page') {
      showToast('There is no page to add');
      return;
    }
    var url = typeof window.readCurrentUrl === 'function' ? window.readCurrentUrl(tab) : tab.url;
    url = String(url || '').trim();
    if (!url || /^(about:blank)?$/i.test(url) || /newtab\.html/i.test(url)) {
      showToast('There is no page to add');
      return;
    }
    var title = String(tab.title || '').trim();
    if (addChip({ label: title, url: url })) showToast('Added to your new tab');
    else showToast('Already on your new tab');
  }

  /**
   * Forwarded from main.js (keys pressed inside a <webview> never reach this
   * document). Returns true when the action was consumed.
   */
  function handleShortcut(action) {
    if (action === 'settings') { toggle(); return true; }
    if (action === 'bookmark') { bookmarkActivePage(); return true; }
    if (action === 'escape') {
      if (!open_) return false;
      closePanel();
      return true;
    }
    return false;
  }

  /* ============================================================
     Wiring
     ============================================================ */

  function wire() {
    // Escape only reaches this document when focus is inside the chrome; the
    // forwarded 'escape' action covers the case where a page has focus.
    // A recording row eats the keystroke first, in the capture phase, so
    // Ctrl+T lands in the editor rather than opening a tab.
    document.addEventListener('keydown', recordKey, true);

    document.addEventListener('keydown', function (event) {
      if (!open_) return;
      if (event.settingsRecorded) return;   // that Escape cancelled a recording
      if (event.key === 'Escape') closePanel();
    });

    // Click-outside. mousedown, so it settles before the button's own click.
    document.addEventListener('mousedown', function (event) {
      var t = event.target;
      if (recId !== null) {
        var row = recordingRow();
        if (!row || !row.contains(t)) stopRecording();
      }
      if (!open_) return;
      if (panelEl && panelEl.contains(t)) return;
      if (buttonEl && buttonEl.contains(t)) return;
      closePanel();
    }, true);

    window.addEventListener('resize', function () {
      if (open_) position();
    });

    // The panel mirrors the store, whoever wrote to it.
    on(function (_snapshot, keys) {
      if (!bodyEl) return;
      if (keys.indexOf('accentHue') >= 0 || keys.indexOf('palette') >= 0) renderLook();
      /* Look Sync's remote values arrive as plain set() calls, so these
         rows follow Helm and Mantle through this same listener. */
      else if (keys.indexOf('glass') >= 0) renderGlass();
      if (keys.indexOf('lookSync') >= 0) renderLookSync();
      if (keys.indexOf('claudeDir') >= 0) renderClaudeDir();
      if (keys.indexOf('claudeResume') >= 0) renderClaudeResume();
      if (keys.indexOf('claudeSkipPermissions') >= 0) renderClaudeSkip();
      if (keys.indexOf('claudeReadTabs') >= 0) renderClaudeReadTabs();
      if (keys.indexOf('claudeNotify') >= 0) renderClaudeNotify();
      if (keys.indexOf('tabSleepMinutes') >= 0) renderTabs();
      // The mode decides whether the minutes row is there at all, so both keys
      // redraw the whole field.
      if (keys.indexOf('workspaceSleep') >= 0
        || keys.indexOf('workspaceSleepMinutes') >= 0) renderWorkspaceSleep();
      if (keys.indexOf('downloadsAskWhere') >= 0) renderDownloads();
      if (keys.indexOf('searchEngine') >= 0) renderSearch();
      if (keys.indexOf('keywords') >= 0) renderKeywords();
      if (keys.indexOf('siteTheme') >= 0) renderSites();
      if (keys.indexOf('chips') >= 0 || keys.indexOf('chipsSource') >= 0) renderChips();
      if (keys.indexOf('bookmarksBar') >= 0) renderBookmarksBar();
      if (keys.indexOf('newtabBackground') >= 0) renderNewtabBg();
      // The Home's own Edit mode writes here too, so a drag on the page
      // flips the switches live.
      if (keys.indexOf('homeLayout') >= 0) renderHome();
      refreshFilter();            // those renders replaced indexed text
    });

    // The shortcut map has its own store; the section mirrors it the same way.
    var keysApi = shortcutsApi();
    if (keysApi && typeof keysApi.on === 'function') {
      try { keysApi.on(function () { renderShortcuts(); refreshFilter(); }); } catch (err) { /* module's problem */ }
    }
  }

  /* The chrome's own theme decides which accent formula applies, and app.js
     changes it by attribute — so watch the attribute rather than the button. */
  function watchTheme() {
    var observer = new MutationObserver(function () {
      applyAccent(get('accentHue'));
      if (bodyEl) renderLook();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  function boot() {
    injectButton();
    buildPanel();
    wire();
    // backdrop.js says when the window's background is ready, or why it is
    // not; the line under the picker repeats it in words.
    document.addEventListener('backdropchange', renderBgState);
    document.addEventListener('backdropchange', renderGlassGuard);
    wireLookSync();
  }

  /**
   * Look Sync's events (looksync.js and app.js fire them on document): the
   * status line, the theme rows, the desktop line, and the one-time toasts
   * for remote applies and fallbacks. Every message is toasted once.
   */
  function wireLookSync() {
    document.addEventListener('toprowstatus', renderToprowStatus);
    document.addEventListener('lookstatus', function (event) {
      renderLookStatus();
      var st = (event && event.detail) || lookCall('status');
      /* Fallbacks show a toast once (CONTRACT section 2); a healthy, off,
         starting or first-seed state does not. */
      if (st && (st.state === 'corrupt' || st.state === 'newer' || st.state === 'error')) {
        lookToastOnce(st.line || st.reason);
      }
    });
    document.addEventListener('lookdesktop', function (event) {
      renderDesktopLine();
      var d = (event && event.detail) || lookCall('desktop');
      if (d && d.state === 'fallback' && backgroundMode() === 'desktop') lookToastOnce(d.reason);
    });
    document.addEventListener('lookapplied', function (event) {
      var d = event && event.detail;
      if (d && d.message) lookToastOnce(d.message);
    });
    document.addEventListener('quartzthemechange', function (event) {
      var d = (event && event.detail) || {};
      themeReason = d.reason ? String(d.reason) : '';
      if (bodyEl) renderTheme();
    });

    if (migrationRan && migrationRan.tell) {
      lookToastOnce(migrationRan.ownKept
        ? 'The background now follows your desktop wallpaper. Your own picture is kept: Settings › New tab › Own picture.'
        : 'The background now follows your desktop wallpaper.');
    }
    /* A missing module is said once too, not only inside the folded pane. */
    var ls = lookSyncApi();
    if (!ls) { lookToastOnce(LOOK_MISSING + '.'); return; }
    if (typeof ls.ready === 'function') {
      Promise.resolve().then(function () { return ls.ready(); }).catch(function () { }).then(function () {
        renderLookStatus();
        renderDesktopLine();
        var d = lookCall('desktop');
        if (d && d.state === 'fallback' && backgroundMode() === 'desktop') lookToastOnce(d.reason);
      });
    }
  }

  /* The one-time move to "Same as desktop" (the old own pick is kept in
     ownBackground) happens before anything reads the key: app.js builds
     the first new tab URL from it. The skip-permissions check goes first:
     it judges "new profile" by an empty stored object, and the background
     migration writes one on every profile. */
  migrateClaudeSkip();
  migrateBackground();

  /* Accent and site theme are applied at script load, not at DOMContentLoaded:
     the boot should paint in the chosen colour, not swap into it. */
  applyPalette(get('palette'));   // theme-boot.js usually stamped this already
  applyAccent(get('accentHue'));
  pushSiteTheme(get('siteTheme'));
  watchTheme();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.Toast = { show: showToast };

  window.Settings = {
    get: get,
    all: all,
    set: set,
    on: on,
    reset: reset,

    chips: chips,
    /* 'visited' (the default: app.js composes the five out of history) or
       'list' (the chips above, in order). Setting it announces 'chipsSource'
       to every listener, which is how the new tab hears about the switch. */
    chipsSource: chipsSource,
    setChipsSource: setChipsSource,
    toggleBookmarksBar: toggleBookmarksBar,
    addChip: addChip,
    removeChip: removeChip,
    updateChip: updateChip,
    moveChip: moveChip,
    /* The list's own rules, for app.js's save star and the new tab's Saved
       row: sameUrl is the duplicate check addChip uses (case and trailing
       slashes do not count), normalizeUrl is what a typed "github.com"
       becomes. Exported so the star can never disagree with the store. */
    sameUrl: sameUrl,
    normalizeUrl: normalizeUrl,
    /* The chrome's one toast, for app.js to say in words why a save star
       click did nothing (the star itself also turns amber). */
    toast: showToast,

    /* THE background (the whole window's and the new tab's). background()
       resolves { kind, dim, url?, fileName?, ... } — see its comment — for
       app.js to push into the guest with __applyBackground().
       backgroundConfig() is the normalised descriptor, sync, for
       backdrop.js; assets is the IndexedDB store (db 'browser', store
       'assets') the picture lives in and backdrop.js caches a clip's still
       in; recopyWallpaper() re-copies the Windows wallpaper. */
    background: background,
    backgroundConfig: backgroundConfig,
    setBackground: setBackground,
    /* "Same as desktop" ('desktop') or "Own picture" ('own'); setting 'own'
       restores ownBackground (null -> the built-in snow-peak). */
    backgroundMode: backgroundMode,
    setBackgroundMode: setBackgroundMode,
    /* Look Sync's glass group, complete and in range:
       { dark:{blurPx,dim,panel}, light:{...}, render }. */
    glass: glass,
    assets: assetStore,
    recopyWallpaper: recopyWallpaper,
    /* Helm's built-in photos: builtinBackgrounds() -> { ok, reason, items },
       builtinBackground(id) -> { ok, item } | { ok: false, reason }. */
    builtinBackgrounds: builtinBackgrounds,
    builtinBackground: builtinBackground,

    /* The new tab Home layout (homelayout.js has the shape and the rules).
       homeLayout() is always complete, or null if the rules did not load;
       applyHomeOp(op) -> { ok, reason, layout } for one page or switch edit;
       setHomeLayout stores null for the default; every change announces
       'homeLayout' to listeners, which is how app.js re-pushes the page. */
    homeLayout: homeLayout,
    setHomeLayout: setHomeLayout,
    applyHomeOp: applyHomeOp,
    resetHomeLayout: resetHomeLayout,

    /* The new tab's app dock, in the order the page shows it: an installed
       app's id, a 'web:<slug>' or a 'term:<program>', each either as a bare
       string or as { id, web: true } for an app opened in its web form.
       appPinIds() is the same list flattened to ids for the join. */
    appPins: appPins,
    appPinIds: appPinIds,
    setAppPins: setAppPins,
    pinOptions: pinOptions,
    setPinOption: setPinOption,

    /* Idle music. music() always answers a complete group; setMusic() merges
       and announces — 'music' among the listener's keys, and a
       'music-changed' event on document. */
    music: music,
    setMusic: setMusic,

    engines: engines,
    searchUrl: searchUrl,
    isSearchUrl: isSearchUrl,
    /* Quartz's own results page: the URL for a query when that is the
       engine (else null), the test for one, and the query behind one. */
    ownResultsUrl: ownResultsUrl,
    isOwnResultsUrl: isOwnResultsUrl,
    ownResultsQuery: ownResultsQuery,

    /* Address-bar keywords. keywordList() -> [{ key, name, url, upper?, ok,
       reason }] (the built-ins while never touched); setKeywords(list) stores
       every row, the ones keywords.js refuses as disabled:true, and announces
       'keywords'; resetKeywords() goes back to the built-ins. Matching itself
       is window.Keywords.match(), not here. */
    keywordList: keywordList,
    setKeywords: setKeywords,
    resetKeywords: resetKeywords,

    applyAccent: applyAccent,
    applyPalette: applyPalette,
    palettes: palettes,
    /* open('Spotify') deep links: the panel opens folded, then that one
       section unfolds and scrolls into view. */
    open: openPanel,
    close: closePanel,
    toggle: toggle,
    isOpen: isOpen,
    revealSection: revealSection,
    handleShortcut: handleShortcut,

    // test seams
    _defaults: DEFAULTS,
    _normalizeUrl: normalizeUrl,
    _hostnameOf: hostnameOf,
    _normalizeHost: normalizeHost,
    _bgFailureWords: bgFailureWords,   // log-e2e: the background toast's words, per failure kind
    _sleepTimes: SLEEP_TIMES,
    _chipSources: CHIP_SOURCES,
    _assetStore: assetStore,
    _normalizeBackground: normalizeBackground,
    /* Look Sync: the pure one-time migration (stored object, now) -> patch
       or null; whether it ran in THIS load (and what own kind it kept);
       the normalizers every stored/pushed value goes through. */
    _migrateBackground: migrateBackgroundState,
    /* The pure one-time skip-permissions check: (stored, hadSession) ->
       patch or null. */
    _migrateClaudeSkip: migrateClaudeSkipState,
    _migrationRan: migrationRan,
    _normalizeGlass: normalizeGlass,
    _normalizeOwnBackground: normalizeOwnBackground,
    _normalizeHue: normalizeHue,
    _bgKinds: BG_KINDS,
    _renderLookSync: renderLookSync,
    _renderGlass: renderGlass,
    _glassEdit: glassEdit,
    _glassGuardText: glassGuardText,
    _renderGlassGuard: renderGlassGuard,
    _renderDesktopLine: renderDesktopLine,
    _accentFallback: function () { return accentFallback; },
    _normalizeAppPins: normalizeAppPins,
    _normalizeAppPin: normalizeAppPin,
    _pinIdOf: pinIdOf,
    _normalizeMusic: normalizeMusic,
    _normalizeMusicFiles: normalizeMusicFiles,
    _musicSources: MUSIC_SOURCES,
    _musicWhere: MUSIC_WHERE,
    _musicFilesMax: MUSIC_FILES_MAX,
    _chooseMusicFiles: chooseMusicFiles,
    _appPinsMax: APP_PINS_MAX,
    _backgrounds: NEWTAB_BACKGROUNDS,
    _chooseBackgroundVideo: chooseBackgroundVideo,
    _removeBackgroundVideo: removeBackgroundVideo,
    _renderShortcuts: renderShortcuts,
    _applyFilter: applyFilter,
    _clearFilter: clearFilter,
    _focusFirstResult: focusFirstResult
  };
})();
