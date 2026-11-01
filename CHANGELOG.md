# Changelog

This is the record of what changed in the browser, written so you can catch up without reading
diffs. Everything below landed overnight, commit by commit, on `master` (the table at the end
lists them; `git log --oneline` is always current). The repo is public at
[github.com/Owen-Silva/quartz](https://github.com/Owen-Silva/quartz). Run it with `npm start` or the
taskbar pin; a copy that is already open keeps running the old code, so close it and launch again —
or use Restart browser in Settings → About — to pick any of this up.

## What's new, by area

### Claude tabs

- A Claude tab now carries a working folder. Shift+click the Claude button, press Ctrl+Shift+`, or
  use the bare-strip menu to pick one through the native dialog; the tab title is the folder name.
  A folder that has been deleted or mistyped falls back to the default rather than failing the tab.
- Settings has a Claude section: a default folder with a picker and validation, a resume switch,
  and a skip-permissions switch.
- Claude tabs can skip permission prompts. Settings → Claude has a "Skip permission prompts"
  switch; with it on, a chamber starts `claude --dangerously-skip-permissions`, and with it off
  it starts plain `claude`, which asks before it runs a tool. The switch is off on a new profile.
  A profile from before that default changed, with the switch never touched, was set to on once
  at its first start of the new version, so it keeps skipping as it did; a profile that set the
  switch either way is left alone. pty.js allowlists the flag alongside `--continue` and
  `--resume`, and the Enter-to-restart path keeps it through a pushed pref (off until the
  renderer says otherwise).
- Resume a conversation opens Claude Code's own picker, from the strip menu, the Claude chip menu,
  Ctrl+click on the Claude button, or the command palette. Restarting after the picker does not
  re-pass the flag.
- Claude tabs survive a restart. They are saved with their folder and come back as fresh sessions
  launched with `--continue` when resume is on.
- Needs-you indicator: a hidden or unfocused Claude tab that goes quiet after a burst of output
  gets an amber pulse and glyph, the Claude button pulses with it, and there is an optional Windows
  notification. It clears when you activate the tab or focus the window.
- Ask Claude about this: Ctrl+Shift+K or the page context menu hands the page URL, and whatever is
  selected, to a Claude tab stood up beside the page. The text is pasted into the input box unsent,
  and queues until the session is quiet if it is still booting.
- Show Claude this page: Ctrl+Alt+K, the page context menu, the tab menu or the command palette
  takes a screenshot of the page into Downloads and pastes its path, unsent, into a Claude tab
  beside the page, so Claude can look at what you see.
- Ask Claude about this article: Ctrl+Alt+Shift+K, the page context menu, the tab menu or the
  command palette reads the page through Reader view and pastes the article's own text — up to
  12,000 characters of it, quoted and unsent — into a Claude tab beside the page, so the session
  can summarise or answer without going to fetch the page. A page with no article in it says so
  and falls back to sending the link.
- A Claude tab can sit beside a page in split view — Ctrl+Shift+\, Alt+click the Claude button, or
  the chip menu. The terminal refits when you drag the divider.
- Recent Claude folders: the last eight folders a session actually started in are remembered, so
  the bare-strip menu lists the top five as "Claude in <folder>" (full path on hover) and the
  command palette offers every one of them — one click instead of the folder picker. The default
  folder from Settings is always in the list, and it all survives a restart.
- A terminal chamber can run something other than Claude (528558c). pty.js holds a static PROGRAMS
  table — claude, powershell, pwsh, cmd, python, node and Git Bash — each with fixed arguments and
  its own allowlist: only claude accepts `--continue`, `--resume` and skip-permissions, and the
  shells take no arguments from the renderer at all. Binaries resolve once per process through
  `where.exe` or an absolute path check, and the Store's app-execution-alias stubs are rejected, so a
  missing python reports "not installed" instead of opening the Microsoft Store. `createSession()`
  defaults to claude and throws on an unknown id; main's `pty:programs` answers the chrome only, and
  `pty:start` returns null for an unknown id before it spawns anything. Live on a test profile
  PowerShell, cmd, Git Bash, node and claude all start, pwsh reports not installed, and path-like
  ids, unknown ids and extra arguments are all refused. There is no UI for picking a program yet —
  this is the layer under one.
- Asking Claude about a page is safer. Ask Claude and Show Claude now hand the page to a Claude
  pane of their own, which always asks before it runs a tool (whatever "Skip permission prompts"
  says) and works in a scratch folder instead of your home folder; the pane says so. Text from the
  page is cleaned of hidden characters and marked as untrusted web content, and a paste that could
  press Enter for you is refused, with the reason shown. A Claude pane you already had beside the
  page stays in the tab strip, and a note tells you where it went.
- Claude panes can now read your open tabs. Claude can list your open web tabs, read the page
  you're on (as you see it, signed in), search your history and your notes folder, and point at a
  passage by highlighting it in the page. It can't click, type or change anything. Every read asks
  you first in a bar over the Claude pane (Allow once, Allow this tab for this pane, or Deny; no
  answer in 60 seconds counts as Deny), even when permission prompts are skipped, and each read
  shows a line over the pane. "Ask Claude about this page" now has Claude read the page itself,
  without asking again for that tab. Settings → Claude → "Let Claude panes read your open tabs"
  turns it off.
- A pane opened by "Ask Claude about this page" keeps saying that it asks before acting and works
  in a scratch folder while Claude reads your tabs; before, the first "Claude read: ..." line
  replaced that note, and answering Claude's last question left the bar over the pane empty. The
  note now stays first under each read line and comes back once the last question is answered.

### Tabs

- Drag tabs to reorder, including into the outermost slot.
- Right-click a tab for Duplicate, Move to workspace, Close, Close other tabs, Close tabs to the
  right, Reopen closed tab, and Sleep/Wake. The bare strip has its own menu.
- Pinned tabs: icon-only, held in a left group, drag-clamped, and remembered across restarts.
- Collapse a tab from its own chip: a small minus button before the close button drops the chip to
  its icon, 40px wide, in the seat it already had. Every chip has one — web pages, catalogue apps,
  terminals, Claude chambers and hosted native app windows alike. Collapsing is not pinning: the
  tab does not move, and pinning is still its own thing on the right-click menu and in the
  palette. The flag is sticky, but it yields to the tab you are looking at: a collapsed chip is
  drawn full size, title and buttons and all, while it is the active tab, and goes back to its
  icon the moment you click off to another tab. On a collapsed chip that same button reads as
  expand and clears the flag for good; a collapsed chip that is *not* the active tab shows a small
  expand badge at its top-right corner on hover, which does the same. Collapsed survives a
  reorder, a drag and a restart.
- Audio: a playing or muted tab shows a chip glyph you can click to mute.
- Sleeping: idle background tabs detach their webview and keep a placeholder, waking when you
  activate them. Pinned, audible and new-tab pages never sleep. The delay is in Settings → Tabs.
- Split view pairs the active tab with the next one (Ctrl+\) without re-parenting the webviews, so
  nothing reloads. The divider drags and focus follows whichever side you click.
- Workspaces: named and coloured, shown in the strip and in a titlebar pill with a switcher
  popover for switch, rename, recolour, delete, create and move. Tabs remember their workspace and
  the session persists the lot.
- Tab search (Ctrl+Shift+A) filters open tabs and recently closed ones as you type.
- Command palette (Ctrl+K, or a `>` prefix in tab search) lists 30+ of the browser's own verbs with
  keycaps that read your current bindings.
- Crash and unreachable-site cards replace the blank page when a guest dies or a load fails.
- Popups open as tabs again, which is what fixed "Add another account" in Gmail doing nothing. Two
  failures were stacked: the `new-window` DOM event app.js listened for was removed from
  `<webview>` in Electron 22, so that listener had been dead code, and `will-attach-webview`
  stripped `allowpopups`, so Chromium killed every `window.open` and `target=_blank` before any
  handler could run. Only `target=_top` navigations worked, which is why the rest of Google was
  fine. Guests keep `allowpopups` now, and main's `setWindowOpenHandler` denies the popup window
  and sends `open-url` to the chrome, which opens a tab — a background tab for background-tab
  dispositions. `javascript:`, `data:`, `file:` and custom schemes stay blocked, and the rest of
  the guest hardening is untouched. All nine popup cases on a test page open a tab. That left one
  limit, fixed in the next entry: a tab has no `window.opener`, so an OAuth popup that posts a
  result back to its opener could not complete.
- Sign-in popups are real windows again, so Google Sign-In works (38bd224). Converting every popup
  to a tab lost the credential — a tab has no `window.opener`, so the page that opened the popup
  never got the result, and the attempt ended as a white popup page beside a blank placeholder tab.
  The guest's window-open handler now decides by disposition instead of denying everything:
  `target=_blank` links and middle-clicks still open as tabs through `open-url`, and only
  `window.open` with features — the `new-window` disposition, the shape every sign-in flow uses —
  becomes a real child BrowserWindow. It takes its size from the features (clamped), centres over
  the main window, is parented but not modal, is sandboxed with no preload and no devtools, shares
  the session, follows the page's title, has its own links open as tabs in the main window, and
  closes with it. Non-http(s) schemes are still refused. Verified live: Pixabay → Log in →
  Continue with Google opened exactly one popup on accounts.google.com with `window.opener` set,
  no stray tab, and the page behind it stayed intact.
- After a restart only the tab in front loads; the others load when you click them. A new tab
  page left in the background goes to sleep after 15 seconds, unless you typed something into it.
- A tab's idle time now counts from when you left it, so a page you read for 20 minutes no longer
  falls asleep the moment you switch away.
- A tab that is making sound, or made some in the last 2 minutes, is never put to sleep, even when
  one video on it pauses while another keeps playing. When "Sleep tab" cannot sleep a tab, the
  menu item says why.
- Background tabs now go to sleep sooner when your computer is low on memory, or when a tab is
  using a lot of memory (over 400 MB) in the background. Your "Sleep tabs after" time still
  applies when memory is fine, and "Never" still means never. Hover a sleeping tab to see why it
  slept.
- A tab with something you typed but have not sent (a message, a comment, a form), a call, your
  camera or microphone, or a picture-in-picture video is no longer put to sleep. Hover it to see
  why it stayed awake. If Quartz cannot check a tab, it keeps it awake and says so.
- The speaker icon on a tab now shows whenever the tab is really making sound: it no longer
  disappears when one video on a page pauses while another keeps playing, and it now appears for
  games and players that use Web Audio.
- A tab that had once played a sound through Web Audio (a game, a web radio, a notification blip)
  was never put to sleep afterwards, by the idle timer, "Sleep tab" or a workspace going to sleep.
  Tab sleep now follows the sound Chromium really hears, as the tab's speaker icon does: a playing
  stream, muted or not, still never sleeps, and a tab that has gone quiet can sleep 2 minutes after
  its sound stopped, once it is past your "Sleep tabs after" time.

### Address bar and pages

- History suggestions in the omnibox, with keyboard navigation.
- A full history page on Ctrl+H: search, day groups, remove single entries, and clear the last
  hour, today or everything.
- Find on page (Ctrl+F) with a live match count.
- Reader view (Ctrl+Shift+R) parses the article in the chrome and pushes it into a glass reading
  page with adjustable text size and column width that follows the theme.
- Reader view keeps an article's pictures again on most sites. Images linked with a relative
  address pointed at the wrong place, because the window's own security policy refused the way
  the reader told the article which page it came from; the reader now hands that address over
  directly and the policy stays strict.
- Site info popover behind the lock button: connection state, per-permission Ask/Allow/Block, zoom
  controls and a two-step clear-site-data button.
- Per-host zoom is remembered and shown as a badge; Ctrl+= / Ctrl+- / Ctrl+0.
- Print the active page through Chromium's own preview (Ctrl+P).
- Screenshot the page into Downloads (Ctrl+Shift+S).
- Picture in picture (Alt+P) for any page with a video.
- The address bar searches your apps (d33e47b, 1a78430). Type a name that matches an installed
  app, a web app from the catalogue or a terminal program and up to three rows appear under the
  usual search/address row, each with an "App", "Web app" or "Terminal" pill after the name. Enter
  on an installed app hosts it in a tab — adopting the window it already has open, or starting the
  app inside the tab — and Shift+Enter launches or focuses it on the desktop instead; the hint
  under a hostable app that is not already in a tab reads "Open in a tab · Shift+Enter opens it on
  the desktop". Web-app and terminal rows are unchanged: Enter opens one, or switches to the tab it
  is already in. The default row stays first, so typing a URL or a search and pressing Enter is
  unchanged. Matching is on the name only (exact, then starts-with, then word-prefix, then
  substring), and two shortcuts with the same name collapse into one row, the running or
  already-hosted one winning. tabsearch.js exposes `appMatches(query, limit)` and
  `whenAppsReady(cb)` so the list redraws once the index lands; history.js draws the rows and
  swallows the Enter, so app.js never navigates for one.

### Blocking and privacy

- Ad and tracker blocking through Ghostery's engine, with a shield button in the address bar
  carrying a blocked count and a popover for per-site and global toggles. The allowlist is written
  as engine exception filters; cosmetic filtering is kept out of the chrome.
- Site data can be cleared per site from the site info popover, behind a two-step confirm.
- Permissions are persisted per origin in `permissions.json` and are deny-by-default; the site info
  popover is where you change or reset them.
- The ad blocker's filter lists now refresh once a day in the background; before, a profile kept
  the lists from its first run for ever. If a refresh fails, the blocker keeps the lists it has,
  and the shield says why and how old they are.
- Hover the line under the shield's switches to see how much work the ad blocker has done this
  session: the requests it checked, by type, and the time it spent.

### Look

- Light and dark themes, plus a site theme setting that follows through to pages.
- Palette presets — ember, forest, ocean, midnight and mono — stamped before first paint, applied
  to the chrome, the new tab page and the circuit board's colours alike.
- An accent hue slider that still wins over a preset if you set one.
- New tab backgrounds: aurora only, or your own picture (downscaled and kept in IndexedDB), with a
  board-over-image switch and a dim slider.
- Bookmarks bar under the address bar, toggled with Ctrl+Shift+B.
- Browser style: your own stylesheet for the browser UI itself, persisted and appended last.
- Per-site styles: per-host CSS, per-host scripts and a force-dark mode with already-dark
  detection, global or per host.
- Settings (Ctrl+,) is now sectioned: Look, New tab, Tabs, Claude, Site styles, Shortcuts,
  Downloads, Privacy and About, with a Find a setting box at the top that narrows the panel to
  whatever you type.
- Settings section names read as headings (0df6795). They were 12px in the dimmed text colour, so
  the pane read as one long list; they are full text colour, 13.5px and bold now, with a little
  more room under each title and between sections. The fading rule under each title stays.
- Settings → Shortcuts starts collapsed (01cd471), at the user's request — "make the shortcuts thing
  default collapse and then i can un collapse it if i want to". The heading is a button with a
  chevron and `aria-expanded`; click or Enter/Space opens it, and the choice is remembered in
  `settings.shortcuts.open`. Typing in Find a setting opens the fold so hits are visible, and
  collapsing it stops a recording row. Nothing inside the section changed.
- Every Settings section starts collapsed, not just Shortcuts (as requested: "make it so that all the
  different sections in settings are auto collapsed"). The pane opens as a list of headings, each a
  button with a chevron and `aria-expanded`; click or Enter/Space opens one, several can be open at
  once, and nothing is remembered — every open starts folded, so `settings.shortcuts.open` is gone.
  About is the one exception and does not fold at all — plain heading, always open. Typing in Find
  a setting still opens whichever sections hold a hit, and `Settings.open('Spotify')` opens the
  pane at one named section and scrolls to it.
- Contrast and copy pass: the muted foreground now clears 4.5:1 on panel grounds in both themes,
  captions are sentence case throughout, and the split divider is visible in light.
- Instrument glass: a design pass over the chrome, the panes and the bundled pages. A container
  (the omnibox slot, the active chip, a popover, a pane) is bevelled, `corner-shape: round bevel
  round bevel` cutting two corners on the diagonal, inside an `@supports` so a build without it
  keeps plain rounded corners. Controls keep ordinary round corners at `--radius-ctl`, so the
  bevel stays a container signature.
- Those containers wear a 1px lit rim, specular at the top left falling to the accent at the
  bottom right. It is painted as a masked ring on a pseudo-element, because the same gradient run
  as a border-box layer under translucent glass washes the whole interior: it took the omnibox's
  placeholder with it. An `<input>` has no pseudo-element of its own, so the omnibox's ring is
  anchor-positioned from `.navrow::after`, and the two-layer trick over an opaque interior is left
  as the fallback where anchor positioning is missing.
- Status reads as light. A live or playing dot is a pip that glows rather than one that is
  painted, and amber keeps its two strengths: a live Claude session, and a brighter flash for one
  waiting on you.
- Section rules fade out instead of ruling all the way across, readouts are set in Bahnschrift at
  `font-stretch: 87.5%` with tabular numerals, focus rings are lighter, and every state change is
  stepped.
- New tokens, each built out of the theme tokens with `var()`, so one definition covers dark,
  light and all six palettes: `--bevel`, `--bevel-lg`, `--radius-ctl`, `--rim`, `--rim-focus`,
  `--rim-soft`, `--pip-glow`, `--pip-amber`, `--pip-amber-strong`, `--seam-v` and
  `--readout-stretch`.
- Light theme fix: a switch row's label inherited the row's animating colour, so for the first
  step after a theme flip it sat on the old theme's `--fg` and went near-white on the white pane.
  The label names its own colour now, and repeats the row's hover, on and disabled states.
- A reloaded new tab page keeps the theme it is looking at. The chrome pushes theme, settings,
  background and recents again on every `dom-ready`, so F5, a crash reload or a script reload no
  longer brings back the theme and settings the tab was created with.
- Instrument glass, pass two. What survives of it is the new tab page — the live modules below and
  the board changes under them. The chrome was recut as deep glass ruled by three horizontal lines
  (a specular hairline at the top, an edge hairline between the titlebar and the nav row, and the
  lit seam), with flush segment tabs, plain back/forward/reload glyphs and shield, theme and
  settings gathered into one segmented cluster. The tab strip went back to the pass-one chips in
  ca3256b, and the rest of the chrome was reverted in 97267eb at the user's request: the chrome is the
  pass-one look again.
- The eleven pane and popover stylesheets were recut the same way — a 44px header with a 14px/600
  title and the close glyph at the right, a 2px seam lamp along the top edge, 13px body, 12px
  captions, 36px rows, 32px buttons, 16px gutters and 6px scrollbar thumbs — and were reverted in
  97267eb with the chrome. Each pane keeps its own header again, and rims are masked rings on a
  pseudo-element either way, the rule from pass one.
- The new tab seats two live glass modules on the circuit board: a clock, updated once a minute
  rather than on a per-second timer, and a session readout of tabs open, Claude sessions and
  Spotify auto-pause (Off, On or Holding). The chrome feeds it through
  `window.__applyReadout({tabs, claude, autopause})`. "Holding" means something is holding Spotify
  through the bridge, which can be another source — another desktop app, say — and not only
  this browser.
- The board pauses only when the real window loses focus. It used to freeze whenever a page inside
  a tab took focus, because the chrome document's own blur was being read as the window's; main
  sends `win:focus` from the BrowserWindow's focus and blur now. The board also resumes on
  `visibilitychange`, `pageshow` and `focus`, and a 2-second watchdog restarts the frame loop if it
  has stalled.
- The dark theme is a neutral charcoal now. The request was for less neon and less glow — "less ai
  slop", and for the browser to feel premium. The dark ground moves from blue-black ink (`#05060a`)
  to charcoal (`#1a1c20` / `#212429`) in every palette; the lit gradient rims end on the plain edge
  colour, so a container is drawn with hairlines at 11% and 14% instead of a lit edge; the sheen
  wash is a flat 3.5% tint; the accent desaturates (`#7dd3ff` to `#72adca`, and the palettes with
  it) and its glow tokens halve; pips lose their halo; the omnibox and the new-tab field trade a
  28px focus bloom for a 3px ring, which leaves focus as the only thing that glows; the seam and
  chamber lamps drop to 14–16% and the text-shadows go. `--fg-2` and `--fg-3` lift to keep 4.5:1 on
  the raised grounds (lowest measured 4.55:1, on a highlighted row). The circuit board paints on
  the same charcoal, with traces at half contrast, vias and pads at half, and packets as plain dots
  with no bloom or tail. The light theme block is untouched.
- The accent hue slider follows the same calming. Its track is a muted spectrum — 42% saturation at
  52% lightness, down from 85% at 58% — with the thumb still showing the chosen accent, and a
  custom hue now derives at the dark theme's own strength (45% saturation, 62% lightness, and the
  alphas chrome.css authors) instead of `hsl(H 100% 75%)`, so dragging the slider no longer brings
  the neon back. Light keeps its own values, and newtab-theme.js matches.
- The aurora holds still. It used to step 120 times a minute under every `backdrop-filter` surface;
  the pool and rim gradients are static in both the chrome and the new tab now. It costs less (see
  Performance) and it is the calmer look that was asked for.
- Live system stats on the new tab. The search field is gone at the user's request — they search from
  the address bar — and in its place, inside the same capsule, is an instrument strip: CPU, memory,
  disk, network in bits per second (down and up) and GPU, each a tabular value with a sentence-case
  label and a 60-sample history graph. The numbers are real, not a demo: CPU from `os.cpus()`
  deltas per core, memory from `process.getSystemMemoryInfo()`, and disk, network and GPU from one
  long-lived `typeperf` child streaming the same Windows counters Task Manager reads. Sampling runs
  only while a new-tab page is the active tab and the window is focused, and the counter process is
  killed 5 seconds after the last subscriber. It costs 0.55% of a core in main plus 0.42% for
  typeperf while someone is looking, and 0% otherwise.
- The stats sample once a second now, Task Manager's own cadence, at the user's request — the typeperf
  child follows at `-si 1` — so the graphs hold one minute of history rather than two.
- Under the strip, a "Processes" expander. It opens with a chevron (the strip itself is the toggle)
  and unfolds the list inline over 160ms, pushing the chips and Recent rows down; whether it is open
  or closed is remembered across reloads. The rows are grouped the way Task Manager groups them —
  one row per program with its instance count, friendly names for the usual suspects (Claude Code,
  Electron, Windows Explorer, Desktop Window Manager, Service Host) — and each shows CPU as a share
  of the whole machine, private memory, and disk and network bytes. The top 10 by the current sort
  are drawn, Show more takes it to 30, and the sort (CPU or memory, click a header) is persisted.
  Rows keep their identity between samples and update their text in place. End task is a two-step:
  the button arms for 3 seconds and the second press kills every process in the group, and the row
  answers Ended, Protected or That's this browser. The browser's own tree is greyed out and refused
  as self, and a protected list of Windows processes — System, Registry, smss, csrss, wininit,
  winlogon, services, lsass, svchost, dwm, fontdrvhost, Memory Compression, Secure System, MsMpEng,
  SecurityHealthService, audiodg, sihost, ctfmon — is refused too. While the list is collapsed no
  table work happens at all: the samples are kept and not drawn. It was first built as a floating
  pop-out over the strip (bed0643) and replaced with the expander at the user's request, because they
  wanted it to open downwards rather than sit on top of the page.
- Fixed: the dashes for disk, network and GPU on the development machine while the graphs still had data.
  `typeperf` prints a warning line whenever a counter instance disappears — a process with a GPU
  engine exiting is enough — and the sampler treated any non-CSV line as a failure and nulled those
  fields for a minute. Warning lines and repeated headers are skipped now, blanks count as 0 inside
  sums, a field goes null only after 5 seconds without a valid row, and a dead child respawns in 2
  seconds. Because `(*)` fixes the instance list at spawn time, the child is also replaced every 30
  seconds with an overlap — switch to the replacement on its first row, then kill the old one — so
  processes started after the spawn are counted: 130 consecutive samples across four refresh
  boundaries with no nulls, and a Notepad started afterwards appeared within 20 seconds.
- Fixed: the flicker when Settings opens. It was never in the page — the address bar showed a
  lighter block exactly above the pane's column, and DevTools captures never saw it, because the
  artefact is in Windows' composition of the acrylic window: every repaint of a region re-composes
  that whole column, and the auto-focused Find a setting box repainted its caret twice a second for
  as long as the pane was open. Focus now lands on the panel itself; Tab still reaches the filter
  and Escape still closes.
- A moving picture can be the new tab's background. Settings → New tab → Moving picture takes an
  mp4, webm, mov, m4v or gif, copies it into `userData/backgrounds` (512 MB cap) and plays it muted
  on a loop, full-bleed under the dim overlay, with the board-over switch putting the circuit board
  over it as a texture if you want it. The clip pauses whenever the page is not in front — a pane
  open, the window behind, the page hidden, the tab switched away — and plays again on the opposite
  events. A file Chromium cannot decode falls back to the board silently. Cost: a 1080p clip
  playing is 26% of a core against the board's 18%, and 1.4% paused. It has no audio, so the tab
  chip shows no speaker and Spotify auto-pause never holds for it.
- The new tab's five shortcut chips are the sites you actually use (eb8aac3). They come out of the
  history store instead of a fixed list: one entry per host (www stripped, the port kept), scored
  as visits with a two-week half-life, so a site you stop opening fades out of the row over a few
  weeks. Search-result pages are skipped, each chip links to that host's most-visited page, and
  while the store is still thin the row is padded with the old defaults. A label comes from the
  web-app catalogue, then the defaults, then a short map of common hosts, else the site's name
  capitalised — a local server reads "Local :7373". Settings → New tab → the shortcuts field gains
  a Most visited / My list control: Most visited is the default, My list hands the row back to the
  hand-edited list, and that editor dims while the history is in charge. The composed row travels
  on the channel the page already listens on — the `?chips` param and the settings push — at most
  once every 5 seconds and only when it actually reads differently.
- With Windows "Animation effects" turned off, every animation and transition in Quartz now stops
  (a short fade stays where it helps), including ones added later.
- Windows contrast themes now get visible edges on controls, a visible focus ring and no
  background picture.

### Apps, process icons and YouTube

- Installed apps are indexed once. A new apps.js reads the Start Menu shortcuts (each `.lnk`
  resolved through `shell.readShortcutLink`, a 32px icon from `app.getFileIcon`) and the packaged
  apps from one `Get-StartApps` run, then caches the merged list as `apps-index.json` in the
  profile for 24 hours. On this machine that is 150 apps, 69 executables and 81 store apps, with a
  cold build of 1.2 seconds and a manual refresh of 3.2. Main exposes list, launch, focus and
  refresh: launching goes through the shortcut or `explorer shell:AppsFolder`, and focusing
  restores and raises the process's own main window rather than starting a second copy.
- A dock of pinned apps on the new tab. In the capsule above the web chips, each pinned app is a
  56px tile: a 32px icon, the name under it, and a dot at the icon's corner while the app is
  running. One row is always reserved so the capsule's height never jumps, and it grows for more
  pins (two rows at 393px wide, three at 320px). A click launches the app, or focuses it if it is
  already running. Edit mode puts a remove glyph on every tile and adds a "+ Add app" tile that
  opens an inline picker over the installed list, eight results at a time, arrows and Enter. A
  failure shows as a short note on the dock rather than nothing happening. Pins are ids only,
  normalised and capped at 32 in the `apps` group of `localStorage['settings']`, so a pin for an
  app that has been uninstalled costs nothing and comes back if it is reinstalled. Dock clicks no
  longer fall through to the Processes fold under them.
- The command palette opens apps as well. The `>` list grows an "Open <name>" row for every
  installed app, built the first time it is asked for rather than at boot. Apps that are running
  sort to the top and read "Running, switch to it", and those rows focus the window instead of
  launching it again. Running state comes out of the stats samples the Processes list already
  needs, diffed against the sampler's top-process keys and pushed to the new tab only when it
  actually changes.
- Process icons in the Processes list. Every row gains a 16px icon slot to the left of the name,
  8px in front of it: the real icon of the executable behind that group once the chrome has one,
  and until then, or when there is none, a neutral window outline glyph at `--fg-3`. A new
  procicons.js in main resolves them cheapest first: the browser's own groups from
  `process.execPath`, then the app index, then zero-spawn guesses under System32, SysWOW64 and
  Windows checked with `fs.access` (34 of 99 real process names answered that way in 19ms), then
  one debounced `Get-Process` batch keyed by pid (500ms debounce, one in flight, never more than
  one spawn every 10 seconds), and last `app.getFileIcon` at 32px as a data URL. Answers are kept
  in memory and in `proc-icons.json` in the profile, written to a temp name and renamed, capped at
  300 entries, nulls retried after an hour and paths re-checked after a day. The chrome collects
  the keys it is missing once per sample, asks at most one request at a time and one every 3
  seconds, holds its own 300-entry cache, and pushes the whole cache to a new tab page on
  `dom-ready`. Drawing is deliberately dull: samples do no icon work, the src for a key is written
  once, a null answer never removes an icon already on screen, and the placeholder rows keep the
  same slot width so nothing shifts. Both themes, no shadow and no glow. The apps dock above it is
  untouched.
- Fixed: YouTube's player spinning forever with blocking on (f4d8ca1). Clicking a video on YouTube
  is a same-document navigation, so the player is built from a fetch rather than from a fresh
  document — which is why a reload always seemed to fix it, the reload taking the document path
  where the player response arrives inline. The first attempt (cf86935) added two exception
  filters, `@@||youtube.com/youtubei/` and `@@||youtube.com/api/stats/`, because the ads and
  tracking lists were cancelling two of YouTube's own calls. Those filters are harmless and stay,
  but they were not the cause. The cause is the scriptlets: the ads list carries scriptlet rules
  for youtube.com (json-prune, replace-fetch-response, prevent-xhr) that the adapter injects with
  `executeJavaScript` to strip ad fields out of the player response, so after an in-page click the
  SPA fetches the next video through the patched fetch, gets a rewritten body back, and the player
  never builds — `ytd-player` in the DOM, no `#movie_player`, no video — until a reload. The
  cosmetics lookup now answers an empty script list for youtube.com and its subdomains; the
  cosmetic CSS and every network rule still apply, so ad delivery is unchanged and `/pagead/`,
  doubleclick and googlesyndication still block. Measured live from a search results page, 20
  seconds a round: stock 0 of 5 videos played, exception filters for every blocked URL 0 of 3, a
  whole-page exception 0 of 3, blocking off 3 of 3, scriptlets off for youtube.com 5 of 5. An
  in-stream ad can still play, exactly as it already did on the reload path — this fixes the player,
  it does not skip ads. The "Script failed to execute" rejections in the main log were those same
  injections losing the race; they stop with the scriptlets. The Electron user agent is left exactly
  as it was; nothing here pretends to be Chrome.
- The command palette lists apps on a plain search too (7e637cd). "Open <name>" rows used to appear
  only in command mode; a plain query now shows up to five matching apps under an "Apps" caption,
  after the tab and recently-closed rows, and the empty note reads "No matching tabs, apps or
  history". The dock's running dot also failed contrast in the light theme at 4.18:1 on the tile; a
  new `--ion-dot` token — the accent darkened 21% in light, unchanged in dark — lifts it to 6.1:1
  and follows palettes and custom accent hues.
- Focus lands on the right window (439cdd5). `apps:focus` had been scanning same-name processes for
  a main window, which fails for every console app — their window belongs to the console host — and
  could raise a different instance entirely. It now enumerates visible titled top-level windows by
  pid, then the console window attached to that pid, then a conhost / Windows Terminal /
  OpenConsole child of it, and never falls back to another pid. In the same pass: the shortcut noise
  filter (release notes, manuals, uninstallers, website links, document targets) now applies to the
  `Get-StartApps` half as well, so 150 entries become 131 on this machine; Store entries pick up
  their exe name from the package manifest in the same PowerShell run, 48 of them gaining one
  (notepad.exe, calculatorapp.exe, mspaint.exe and the rest), so they can show a running dot at
  all; x86 twins are flagged and sort after their x64 sibling; and the index cache is version 2, so
  the old one is rebuilt. Build 1.4s warm, 3.4s cold.
- Review fixes on the dock and its chrome side (a95db9d, 91a3b66). The "+ Add app" tile was hidden
  the moment the first pin landed while its picker was still open, leaving no way to close the
  picker with the mouse; it stays while the picker is open now. Typing in the picker changes its
  height, so the capsule height is settled on each filter instead of re-seating the board. Escape
  returns focus to the Edit control rather than the tile it just hid. On the chrome side, an
  `apps:list` answer already in flight could overwrite an index a refresh had just rebuilt, so a
  newly installed app vanished until the next refresh — the pending promise checks it is still the
  awaited one. `apps:refresh` resolves to the index rather than an ok flag, so every successful
  refresh had been reported as a failure. And a 33rd pin was answered ok with no tile drawn; the
  stored list is used and the dock says "Full".

Verified with harnesses only. The machine was in use while this round was written, so none of it has had a
live pass in the running browser: the evidence is pure-node harnesses (112/112 on the app index,
78/78 on the pins, push and palette rows, 61/61 on the icon slot through a DOM shim, 33/33 plus 7/7
against the real filesystem on the resolver, 108/108 on the chrome wiring), the engine on disk for
the YouTube filters, and a headless renderer with synthetic pushes for the dock.

Most of that debt has since been paid on a test profile: the palette's app rows and the light-theme
dock were captured live (7e637cd), a dock-launched PowerShell with no main window handle was
minimised and its own console window raised while a windowless pid raised nothing (439cdd5, harness
190/190), and the YouTube fix was measured on YouTube itself, five rounds of five (f4d8ca1). What is
still owed is the process-icon side: the icon IPC round trip and real `getFileIcon` timing on this
machine.

- Launching an app keeps the shortcut's own semantics (14a076b). A Start Menu shortcut that carries
  an AppUserModelID — 19 of the 68 indexed here, Discord, Cursor and Edge among them — goes through
  the shell again so the app keeps its taskbar identity, and answers with no pid; so does a shortcut
  flagged run as administrator, whose flag is read out of the `.lnk` header now. Direct spawn, which
  is what gives the engine a pid, stays for plain shortcuts and exes, now with `%VAR%` expanded in
  the target, the arguments and the Start-in folder, a fallback to the exe's own folder when the
  Start-in folder is gone, and a shell fallback when the spawn is refused. The index cache moves to
  version 3, so it refreshes once and the cwd, aumid and run-as fields are filled in. Apps harness
  238/238; live on a test profile the index rebuilt in 3.9s, Character Map launched with its real
  pid and Paint (Store) through the shell with none.
- Fixed: a dock tile saying "<name> has no window" (d33e47b). A tile set to open the desktop app
  sent only the first pid of the app's process group — the lowest, usually a helper — and the
  focus script searched that pid alone, which is why Discord, Cursor and the other multi-process
  apps answered "no window" while sitting right there. `apps.focus` now takes the whole pid list
  and tries each pid's own window, then console hosts, then child-process windows, skipping the
  DWM-cloaked ghosts and reporting which rule matched; main.js and preload.js take a number or an
  array. When the answer is still no window, or the app is no longer running, the chrome launches
  it instead of giving up, and the result comes back labelled as a launch, so a press that started
  the app never reads "No window". The palette's "Open <name>" row falls back the same way.
- Fixed: pinning an app reset every other pin's option (d33e47b). Pinning or unpinning rewrote the
  dock from bare ids, so each other tile's app / web / tab choice was dropped back to the program.
  The pin/unpin handler edits the full-shape list now, and the options survive.

### Files tab

- A file browser as a tab, on Ctrl+Alt+E (91682dc, cf13b3a). It opens as a "Files" tab with a blank
  omnibox, themed and palette-matched like the other bundled pages, and theme pushes reach it.
  Ctrl+Shift+E is still Workspaces and was not touched. There is a "Files" row in the command
  palette as well.
- The page is a left rail of your own folders and the drives with a free-space bar, a breadcrumb
  path bar that turns into a text field on Ctrl+L, a filter over the current listing, and a listing
  with a 16px icon slot, size and modified columns, header sort remembered in `localStorage`,
  keyboard navigation (arrows, Enter, Backspace, Home, End), double-click to open, and a right-click
  menu with Open, Show in Explorer and Copy path. Empty, error and truncated states are all drawn
  rather than left blank.
- Main answers `files:list` / `places` / `open` / `reveal` / `icons` / `copy-path` for the chrome
  sender only: drive-letter or UNC paths, `readdir` with file types, folders first, a 2,000-row cap
  that reports itself as truncated, `stat` in waves of 64, errors mapped to not-found /
  access-denied / not-a-folder, drives probed with `statfs` over C to Z, and icons from
  `app.getFileIcon` cached per extension. The page talks to the chrome over a `files:` console
  channel with the same guards as the new tab's channels, so a new-tab guest printing `files:` lines
  does nothing.
- Verified live on a test profile: the palette row opened the tab, root showed the places and C:
  with its free space, Downloads listed 340 rows in 142ms with 80 icon slots filled, and filter, all
  three sorts, up, System32 truncated at 2,000 rows, a missing folder and a file path all showed
  what they should. `files:reveal` was not exercised, because it raises Explorer over everything.
  Volume labels are always empty — Electron exposes none without a spawn.

### Idle music

- Settings has an Idle music section, between New tab and Privacy (33a77e0): Enabled, Source
  (Built-in ambient, or My tracks with a count, Choose files… and Clear), Where it plays, Volume,
  and the hint "Plays while nothing else is playing". Preferences live in the `music` group of
  `localStorage['settings']` — `{ enabled, source, where, volume, files, shuffle }` — normalised on
  the way in (volume clamped, unknown values falling back to defaults, file paths validated,
  deduped and capped) and announced with a `music` emit key and a `music-changed` event. Both new
  controls degrade to a short hint rather than a dead row if the preload or the helper lacks the API.
- The ambient engine behind the Built-in source (5b85fe2). ambient.js is a generative lobby-style
  pad on Web Audio: three or four detuned voices through a slow low-pass filter form a chord that
  crossfades to the next every 16 to 24 seconds along a small modal progression, a sparse sine
  arpeggio quantised to the chord runs through a feedback delay, and the room is four damped delay
  lines rather than a convolver (a 2.5s convolver cost 4% of a core on its own), into a compressor
  and a master gain. One timer for the whole thing; `stop()` clears it, kills the live nodes and
  suspends the context. Twelve two-word mood titles. Live in a muted test instance the renderer sat
  at 1.9% of one core playing and under 0.1% paused with the context suspended; an offline render
  peaks at -6 dBFS steady, -21 dBFS at the default volume, so it is not silent.
- An Idle music block on the new tab, inside the session tile (4914b45): a state line reading Off,
  Paused, the mood title or the track name, Play / Pause / Turn on, a Next control for your own
  tracks, and the same hint. `window.__applyMusic({ enabled, playing, source, title, where })`
  updates it in place and clicks come back as `newtab:music` console lines. The session counts moved
  into their own rows so the tile can show music without three dashes, and the modules now sit above
  the stage layer — they had shared a z-index, so clicks on the controls were landing on the stage.
- Main and preload carry the bridge calls (bc25347), each answering `{ ok, reason }` within 1500ms
  and only for the chrome sender: `music:choose-files` (multi-select audio, nothing copied, capped
  at 500), `media:now` (the Spotify helper's `/now`, with art omitted, full, or by hash) and
  `media:control` (play, pause, toggle, next, prev). No custom protocol for your own tracks: the
  chrome is a `file://` document with no CSP, and `file://` audio reaches `loadedmetadata`, proven
  live with a wav and an mp3. Live against an isolated copy of the helper, now-playing answered in
  92ms with art by hash. The file dialog itself is not exercised, because it is modal and would take
  the foreground.
- The player itself (1ef5668). music.js decides whether to play at all: the setting on, no manual
  pause, the window focused, no audible tab, the machine not already playing (Spotify, or any
  Windows media session), the "Where it plays" setting satisfied, and a source ready. A 300ms settle
  sits in front of the decision, and the fades are 800ms in, 400ms out. Two sinks behind one
  contract — the built-in engine, whose master gain ramps and whose `stop()` suspends the context,
  and one `<audio>` element on `file://` for your own tracks, with shuffle, next, missing files
  skipped, and a whole-list failure falling back to the engine. app.js drives it: the stats
  subscription for presence, audible and muted tab edges, `Settings.music` and the `music-changed`
  event, memoised pushes to the new tab on dom-ready, activation and every state change, and a 2s
  now-playing poll while a new tab is in front (or anywhere while the window is focused). Harness
  108/108, and 42/43 live on a test profile at volume 0 — the one miss a stale-profile artifact.
- The player stopped vetoing its own sound (e135f54). The report: "it keeps pausing and playing and then
  pausing and playing even though there is nothing else like spotify or anything playing". The
  cause, confirmed over 59 live samples: Chromium registers the chrome's own `<audio>` element with
  the Windows media session, so the now-playing route reported the idle music itself as playing, the
  player paused for it, the session went Paused, and the player resumed — a four-second cycle with
  Spotify paused the whole time. main.js now starts with
  `disable-features=HardwareMediaKeyHandling`, which takes the browser process out of the Windows
  media session altogether. The trade-off is deliberate and worth knowing: media keys no longer
  control browser tabs — they go to Spotify — and the now-playing tile shows Spotify and other apps,
  never a tab in here.
- Resume hysteresis, in the same commit. Pausing for something else is still immediate; resuming
  needs the clear state to hold 2.5s after the settle, and more than three pause-and-resume flips in
  a minute sits the player out for 30s and logs why once. Your own presses and settings writes
  bypass the hold. Harness 148/148; live, a 60s file soak held one playing state with zero media
  sessions registered, a forced "playing" status paused it inside a second, and it came back 2.9s
  after the status cleared. Takes effect on the next restart.
- Fixed: idle music could be silenced for the life of the window (eafa0fc). A guest that died —
  destroyed, render-process-gone, or slept — never had its `audible` flag cleared, so the player
  went on believing a tab was making noise. There is a `forgetTabAudio` path for that now, and the
  250ms follow-up read after a media command is one tracked timer, cleared with the poll.
- Idle music now steps aside for any tab that is really making sound, including games and players
  that use Web Audio, and no longer comes back when an ad or a preview pauses while the main video
  keeps playing.
- Idle music no longer stays off for good after a page that once played a Web Audio sound (a game,
  a notification blip). It now follows the sound Chromium really hears from each tab, as the tab's
  speaker icon does.

### Now playing

- A now-playing tile is the new tab's third module (53524f4). It seats on a "flank" placement at the
  bottom-left margin, outside the row-and-corner arithmetic the other two use, so the clock and the
  readout never move for it. Inside: a 48px art well with a note glyph when it is empty, the title,
  the artist, a hairline progress bar filled with the accent as a composited `scaleX`, and three
  quiet glyph buttons — previous, play/pause, next.
- It is fed by the Spotify bridge rather than by the browser. `__applyMedia(payload)` goes in and
  `newtab:media {cmd}` comes back out over the same console channel the rest of the page uses, and
  the buttons reach `media:control`, so they drive whatever the helper is playing. It ticks four
  times a second only while something is playing, freezes on pause, and writes `img.src` once per
  distinct art string. Verified 59/59 on the DOM-shim harness, three seats at three window heights
  with nothing showing under any tile, and live in both themes with a real track and its art, real
  clicks on all three buttons, and no horizontal overflow at 393 or 320px. The chips row is
  unchanged.

### Markets

- Live stock prices are the new tab's fourth module, in the bottom-right corner. It is the one tile
  the board does not seat: it takes the corner and keeps it. Inside: the session (Pre-market, Open,
  After hours, Closed), an intraday line chart for the selected symbol with the previous close as a
  dashed hairline and the day's sign tinting the area under the line, then one row per symbol —
  name, sparkline, last, day change — with a `+` that takes a ticker and an `×` per row on hover.
  SPY, QQQ, NVDA, TSLA and AAPL on a first run; eight symbols at most.
- The prices come from Finnhub, with your own key. Settings → Stocks holds it: the field is masked,
  has a Show toggle for what you are typing, and there is a switch for the tile and one
  comma-separated row for the watchlist. **The key never leaves the main process.** It lives in
  `<userData>/stocks.json` as `stocks.finnhubKey`, and the only thing that comes back out is
  `hasKey` plus a mask (`••••4f21`) — so neither the settings pane, nor the new tab page, nor a
  devtools console can read it. With no key the tile is one line: "Add a Finnhub API key in
  Settings to see live prices", and it makes no network call at all.
- stocks.js (new) owns all of it: the store, the `wss://ws.finnhub.io` trade stream with a
  resubscribing backoff reconnect, REST `/quote` snapshots behind a 60-calls-a-minute token bucket,
  and the history. The chart's history tries Finnhub's `/stock/candle` once and falls through to
  Yahoo's keyless chart JSON on the 403 that free keys get there — so a free key still draws the
  day. A key Finnhub refuses shows "Finnhub rejected the key" once and then backs off for a minute
  rather than retrying in a loop.
- It costs nothing while you are not looking at it. The page subscribes on `visibilitychange` and
  unsubscribes when it hides, main ref-counts that per webContents exactly as the system stats do,
  and with the count at zero there is no socket, no timer and no traffic. On screen it repaints at
  most twice a second and only when a number moved: no `requestAnimationFrame`, no CSS animation,
  nothing on the tile that moves on its own.
- Verified: 36/36 on a node harness over the parsers, the market-session clock, the 60/min budget
  and the candle-403-to-Yahoo fallback; and live over CDP — the tile renders 24px off both corners,
  makes zero requests without a key, shows the refusal after exactly one request and none for the
  next twelve seconds, and draws a real 838-point SPY day off Yahoo. Settings: the Stocks section
  opens collapsed like the rest, a pasted key reaches the store and takes the tile out of the
  no-key state, the key appears nowhere in the panel DOM or in any push, and Remove puts it back.

### Web apps, app tabs and terminal tabs

- A catalogue of 30 web apps (01cd471). webapps.js names Discord, WhatsApp, Telegram, Slack, Notion,
  Gmail, Calendar, Drive, Docs, YouTube, YouTube Music, Twitch, Reddit, X, GitHub, ChatGPT, Claude,
  VS Code, Figma, Canva, Microsoft 365, Outlook, Teams, Steam, Roblox, Spotify, Netflix, Disney+,
  Apple Music and Prime Video, each with a `web:<slug>` id, its URL and host, the desktop exe it
  pairs with, and a `drm` mark on the five that cannot play without Widevine. It looks up by id, by
  host (exact, then the longest subdomain match) and by exe ("spotify", "spotify.exe" or a full
  path), and loads either as a module or as a plain script tag.
- Web apps open as app tabs (b0a5af8). Opening one activates the tab if it is already there, or
  loads the catalogue URL as a page tab seated to the left of the first ordinary tab. The tab
  carries `{id, name, url, host}`, saved in the session and restored on the next launch; navigating
  within the same host keeps the app flag, and going to another host clears it, so the tab turns
  back into a plain page instead of pretending it is still the app.
- A DRM entry opens with a one-line note bar, and with a "Launch desktop app" link when the desktop
  app is installed — those five cannot play in a tab, so the tab says so rather than failing quietly.
- Terminal programs open as tabs as well. Any program pty.js has available — PowerShell, cmd,
  Python, Node, Git Bash, pwsh — opens as a pty tab titled after the program, and one that is not
  installed toasts instead. This is the picker the program table in 528558c was the layer under.
- The command palette carries all of it: "Open <name> (web)" rows for the catalogue, "New <program>
  tab" rows for available programs, and "Switch to <name>" for an app tab that is already open.
  Harness 82/82; live on a test profile Discord opened at the left, survived a restart and cleared
  its flag on a cross-host navigation, a PowerShell tab ran `echo hi`, Spotify web showed the DRM
  note with a working desktop link, and plain Claude tabs were untouched.
- The dock pins web apps and terminals, not only installed apps (95f2d24). A web-app pin draws its
  favicon through the chips' favicon path, with a letter disc as the fallback; a terminal pin is a
  monospace `>_` tile. An installed app that also has a web form shows a small "web" badge, and Edit
  mode gives it a toggle that sends `pin-web` and waits for the chrome's next push instead of
  flipping locally. The Add app picker is grouped now — Installed, Web apps (with the host, and a
  "desktop" hint when the desktop app is installed) and Terminals (unavailable ones left out) — up to
  eight per group, with one search across all three. Running dots cover open app and terminal tabs as
  well as running processes. webapps.js is only a first-paint seed on the page; the chrome's push
  stays the source of truth. Two live bugs fixed on the way: the edit-mode web switch covered the
  tile name, and the picker opened scrolled into the middle of the list. Harness 91/91, the
  now-playing and board harnesses unchanged, and live in both themes with a mixed dock at 1280, 393
  and 320px with no horizontal overflow.
- Fixes from the review pass (eafa0fc): a DRM app tab in a split view threw, because
  `syncSplitOverlays` read a `const` before its declaration; a dock press on a terminal pin raises
  the chamber that is already open, and only the palette spawns a fresh one; the note bar no longer
  leaves an orphan behind when the tab closes mid-index; the palette's terminal rows redraw once the
  program table arrives, so the first open is not blank; and an open app tab no longer offers both a
  "Switch to" row and its own tab row for the same query. Verified live: a cold restart restored an
  app tab with its seat and note, a stale slug restored as a plain page, closing an app tab pushed
  running:false, and the log had no unhandled rejections.
- Closing a terminal tab no longer crashes a helper (56fe5dc). node-pty's `kill()` forks its
  `conpty_console_list_agent`, whose `AttachConsole` fails inside Electron, so every closed tab
  logged a helper crash and then waited out a 5s timeout before falling back to the shell pid.
  pty.js replaces the agent's private console-list call right after spawn with node-pty's own
  fallback answer, the inner pid — feature-detected and guarded, so a future node-pty simply keeps
  its behaviour. Spawn, resize, write, kill, cwd and the program table are untouched. Live on a test
  profile, helper crashes per closed terminal tab went from one each to zero, four to zero over the
  run, with no console processes left behind; harness 31/31.

### Native app tabs

- The engine for running a real desktop app inside the browser (769b1d9). The request: "is there a way
  where I can start the apps in a tab but it's running the app so that literally everything is just
  in a tab?" embed.js reaches Win32 through koffi — Node-API, so it loads in Electron 44 with no
  rebuild — required lazily inside a try/catch. It finds windows by pid or exe, and `attach`
  re-parents the app's own top-level window into the browser window: hide, `SetParent`, the
  `WS_CHILD` style, then a `SetWindowPos` that moves and sizes nothing, because a zero-size one
  destroyed app windows on attach. `layout` positions the window over a CSS-pixel rect with the
  display scale applied, `detach` restores the saved style and rect as a normal window again, `close`
  posts `WM_CLOSE` with a restore fallback after 3s, and a once-a-second liveness poll reports a
  window that has gone. Store apps and the browser's own windows are refused, and `detachAll` runs
  on before-quit, window close and process exit, so quitting the browser never takes the app down
  with it.
- main.js answers find, attach, open, layout, detach, close and list for the chrome sender only, and
  pushes the gone event. Opening launches the app the way the dock already does, or attaches a window
  that already exists, then waits up to 20s for a new titled window from that exe. Startup never
  depends on the module: a missing koffi answers "unavailable" and nothing else changes. Verified
  30/30 live with Paint — attach, the rect inside the browser, the parent handle, hide and show,
  detach restoring the saved rect, re-attach, close ending the app, the gone event, Calculator
  refused as a store app, and a browser quit with an app attached leaving it running as a normal
  window. About 2.3 MB in the main process.
- The engine now takes only windows it can actually host, out of the review pass (71f60f8). `find` and
  `attach` require a top-level root window that is unowned, not a tool window and never one of our own
  HWNDs — a credential dialog owned by the browser itself used to enumerate as hostable. A minimised
  app is shown with `SW_SHOWNOACTIVATE` rather than `SW_RESTORE`, so opening one into a tab never
  steals focus. Attach recovery and detach put every Win32 call under its own try, so a failure can no
  longer leave a `WS_CHILD` window without a parent, and a failed un-parent keeps the record so the
  quit path retries it. The restore after `SetParent(null)` compared `GetParent` truthily — that is
  the desktop HWND, so the style and rect were never put back; it compares the saved parent now. In
  main.js a pending-open guard answers "open-pending" when a second `embed:open` arrives for the same
  tab instead of launching a second copy, and a tab closed during the 20s wait cancels it;
  `render-process-gone` detaches every app; and a malformed layout request no longer collapses to a
  0x0 hide. Verified live with Paint: style, exstyle and rect identical after a round trip with parent
  0, a double attach refused, a `Stop-Process` forgotten in 1.2s, the wrong exe answering no-window
  after the wait while `embed:list` answers in 2ms, a window move followed exactly, 200 finds growing
  private bytes by 1.75 MB, and both a browser close and a renderer crash handing Paint back clean.
- The tab side landed (f523390). A tab can be a "native" kind now: its view is a placeholder on the
  theme ground, and the engine positions the app's real window over it. The layout is synced on
  activation, on resize (a ResizeObserver plus the window resize, coalesced to one call per frame) and
  on split changes — and because a re-parented Win32 window sits above the document, the app is hidden
  while any chrome overlay that covers the content is open (the palette, the panes, tab search, find,
  downloads) and shown again after. The placeholder says where it is: starting, running, gone with
  Relaunch and Close, failed with the reason and a "Launch normally" button, and idle with Start for a
  restored session, because native tabs never auto-start and never sleep. Closing the tab closes the
  app, and "Pop out" in the tab context menu hands it back as a normal window. The dock's running dots
  cover native tabs, with their pids.
- The ways in. The command palette has "Open <app> in a tab" rows, and "Switch to <app>" for one that
  is already open. In the dock, Edit mode gives each installed pin a quiet three-way chooser — app,
  web or tab, or app and tab when the app has no web form — with `aria-pressed` on the current choice
  (90870c4); it sends `pin-web` or `pin-native` and waits for the chrome's next push instead of
  flipping locally, a native pin wears a small "tab" badge (native wins over web), and pressing that
  pin opens the app in a tab. Pin options in Settings carry `native` alongside `web`. Web and terminal
  pins are unchanged.
- Two bugs caught live on the way in: `clearSplitSeat` stripped the placeholder's size so it measured
  0 wide (it is width and height 100% like a webview now), and a tab opened before the apps index
  landed wore the app's hash as its title (`relabelNativeTab`). Verified: N2 harness 213/213, T2a
  100/100, T2b 110/110, music 180/180, apps 190/190, and the dock 140/140 with the T3 harness still
  91/91 and the media tile 59/59; live with Character Map on a test profile the app rect equals the
  placeholder rect, it hides and shows across tab switches and the palette, follows a resize, pops out
  alive, and closing the tab exits the app, with the pid in the running payload. The chooser was
  checked in both themes at 1282, 393 and 320px: every button its own hit target, no overlap with tile
  names or the unpin glyph, no horizontal overflow, and the dock's height unchanged at rest.
- True focus, and shortcuts that survive it (52c9aa7). Work inside a hosted app counts as focus in
  the browser now: embed.js reads the foreground window and the focused control and walks the parent
  chain, answering whether the focus is ours and which native tab holds it, and a 250ms poll while
  any app is attached pushes that to the chrome on every change. So idle music set to play anywhere
  keeps playing while you are typing in a hosted app, where Electron's own blur used to stop it; the
  new-tab board still pauses on a raw blur, because it is invisible under an app anyway and that
  saves the CPU. And while a native tab is active, its app holds the keyboard and the window is
  foreground, a small set of shortcuts is registered globally: new tab, the address bar, the
  palette, tab search, Ctrl+Tab both ways and the Files tab. Never Ctrl+W, F, R, S, P or N — a
  hosted editor or chat app owns those. A fired shortcut runs the same handler as the keydown path
  and hands the keyboard back to Chromium without raising the window, and the registration drops the
  instant any of those conditions stops holding. Verified: N6 harness 69/69, N2 271/271, music
  190/190, T2b 110/110; live with Character Map holding real focus, the focus read as ours with the
  caret in one of the app's own controls, the music gate stayed focused while Electron reported
  blur, a global Ctrl+T opened a tab and returned focus to Chromium, the shortcuts unregistered
  108ms after a tab switch, and the poll stopped when the tab closed.
- Review fixes on the ownership engine (f6ac242). A layout only asks for `HWND_TOP` when the window
  is appearing or the foreground is already ours, and `raiseHosted` skips while we are not
  foreground, so a poll relayout can never put a hosted app over whatever is in front; owner loss
  needs two consecutive bad samples, because one bad read used to evict a healthy app;
  `restoreStyles` refuses to write a top-level style onto a window the app has re-parented itself,
  guarding on the root and `WS_CHILD`; the keyboard handback verifies the focus it claims and always
  unjoins the input queues, logging a refused unjoin; an owner write refused by UIPI — an elevated
  app — undoes the attach and answers owner-refused instead of leaving a frameless unowned window;
  and a missing rect answers bad-rect in preload.js rather than hiding the app. Verified live:
  z-order stays browser-relative through activation changes and layouts, rects exact in normal,
  maximised, fullscreen and negative-coordinate positions with minimise hiding without moving, three
  real Ctrl+T handbacks in 7-9ms with balanced join/unjoin, pop out restoring style, exstyle, owner,
  rect and the Alt+Tab entry, the child mode round trip identical, and the main process at 0.10% of
  a core idle with one app hosted. Harnesses N2 334, N6 89, N8 333, N4 82, all green.
- Recovery after a force-killed browser (f6ac242). Hosted windows are recorded in userData, and the
  next start restores their frame, taskbar button and rect once and logs what it fixed. A killed test
  browser left Character Map frameless and a fresh start fixed 1/1.

### Shortcuts

Every default can be rebound in Settings → Shortcuts except Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1–9,
Escape and F12. New or changed defaults from tonight:

- Ctrl+Shift+A tab search, Ctrl+K command palette, Ctrl+H history page, Ctrl+J downloads.
- Ctrl+\ split view, Ctrl+Shift+\ Claude beside the page, Ctrl+Shift+K ask Claude about this page.
- Ctrl+` toggle a Claude tab, Ctrl+Shift+` new Claude tab in a folder you pick.
- Ctrl+Shift+E workspaces, Ctrl+Alt+Left / Ctrl+Alt+Right to cycle them.
- Ctrl+Alt+E the Files tab. Ctrl+Shift+E stayed on Workspaces.
- Ctrl+Shift+R reader view, Ctrl+Shift+S screenshot, Ctrl+Shift+B bookmarks bar, Ctrl+P print,
  Alt+P picture in picture, Ctrl+D add the page to the new-tab chips, Ctrl+, settings.
- Ctrl+R is an alias carried on Reload, so it follows Reload wherever you move it.

Only the rows you changed are stored. A combo somebody already holds asks for a second press before
it displaces the other action, and the displaced one is left unbound and named.

### Downloads

- A shelf with a progress ring, saving without a prompt by default.
- Ask where to save, through the native Save dialog, as a setting.
- Open folder button, and a Downloads section in Settings.
- Ask Claude about this file: a finished row hands its path, unsent, to a Claude tab beside the
  page you are on — Claude Code reads files and images off disk, so nothing is uploaded.

### Spotify auto-pause

- Settings has a Spotify section, driving the auto-pause helper already installed at
  `~/spotify-autopause`. The browser is only a client of it: nothing in that folder is written
  from here.
- The switch is for the whole computer. On enables the `SpotifyAutoPause` scheduled task and runs
  it; off ends it and disables it, because the task carries a repeating keepalive trigger and one
  that is merely ended restarts itself within minutes. Where the task is missing, the switch
  launches the bridge directly and remembers the choice.
- This browser's own tabs hold Spotify paused too, behind a second switch, "Also pause for videos
  in this browser", with a line under it counting the tabs playing right now. A tab making sound
  on a watched site (YouTube, Twitch, Kick, Vimeo, Dailymotion, TikTok, Netflix, Hulu, Disney+,
  Prime Video, Max, Peacock and Crunchyroll out of the box; Twitch was the
  first miss the user hit, so the list grew past the extension's), or any tab at all with "Any tab
  that makes sound" on, registers a hold at the bridge on
  127.0.0.1 (the first free of ports 8787 to 8790) under its own `src=owen-browser`, so the two
  browsers can never release each other's hold. The hold refreshes every 60 seconds and is handed
  back 1.5 seconds after the sound stops, or on quit. Spotify's own web player never counts as a
  video.
- A readout under the switch says what is actually true, down to the port and whether Spotify is
  open, and "Check health" runs the helper's own `doctor.ps1` and prints the report without
  changing anything.
- Verified live: a tab making sound registered `owen-browser` at the bridge within five seconds
  and released the hold when it closed.
- "Quiet Spotify ads", a third switch in the same section (33a77e0, bc25347). With it on, the helper
  drops Spotify's own in-app volume to 10% while an ad is playing and puts it back to full when the
  ad ends, so the free tier's ad breaks stop being the loudest thing in the room. The switch reads
  the helper's `adDuck` state — carried on the auto-pause status and on every status push through a
  3-second cache — and writes it back over `api.spotify.setAdDuck`, which POSTs the helper's
  `/config`. Verified live against an isolated copy of the helper: the round trip works and the
  switch survives a chrome reload.
- Now-playing routes for the chrome (bc25347): `media:now` reads the helper's `/now` (art omitted,
  full, or by hash) and `media:control` sends play, pause, toggle, next and prev. The helper's port
  comes from the existing client cache, and a failed call forgets it. Invalid commands are refused.
  These are the plumbing for a now-playing tile; nothing draws one yet.

### Performance

Measured on this machine overnight: cold start is about 550ms from launch to a booted chrome. A
page tab costs 100–150MB resident, which is Chromium's per-site renderer; a sleeping tab hands that
back, and two sleeping tabs returned about 240MB between them. Idle cost is almost entirely GPU
compositing, which is why the circuit board now freezes both under any open chrome pane and
whenever the window loses focus — with it frozen and no page animating, the only remaining cost was
the aurora's stepped keyframes, and those are gone too.

A measured pass over the whole thing, each change profiled before and after on its own test
instance:

- Claude tab resizes. Every window or pane resize pushed a ConPTY resize even when the column and
  row count had not changed, and each one made `claude.exe` repaint its whole TUI. `safeFit` and
  `startPty` cache the pushed grid and skip no-op resizes: a 20-resize storm went from 20 redraws
  to 0, and a real column change still repaints.
- Session snapshots in main. The snapshot the chrome sends on every tab change was a synchronous
  write plus rename on the main loop: 300 snapshots kept main busy for 1367ms with a p99 loop lag
  of 1169ms. Async, single-flight and newest-wins makes it 206ms busy and 129ms p99, with a
  synchronous flush on `before-quit` so quit and Restart browser still persist the last state.
- PTY output. A 2MB flood was 19,774 IPC sends, one per ConPTY chunk. A 16ms window with a 64KB cap
  coalesces them to 305 — byte-identical, first chunk still immediate, flushed on exit.
- Guest navigation reads in the chrome. `webview.getURL`, `canGoBack`, `canGoForward` and
  `getZoomLevel` are synchronous IPC to main, and a tab switch made six of them. A per-guest cache,
  invalidated on every navigation event, drops script time per switch from 11ms to 3.5ms and long
  tasks from 5 to 2 over 40 switches. Pushes to guests are memoised to one IPC per real change, and
  session writes flush on `beforeunload`: an open-and-close cycle goes from 20ms to 14ms of script.
- The site info seat. `getBoundingClientRect` self time over 40 tab switches was 94–97ms and is now
  7–8ms, with layouts down from 70 to 38. The seat is measured once and re-measured only when the
  row's geometry can have changed — a ResizeObserver on the omnibox and the nav row, one re-measure
  per frame after a child mutation, and on load, `fonts.ready` and a theme swap.
- Compositing. The pips that pulse inside frosted rows get their own layer, and the board's
  vignette is painted into the canvas alpha instead of masking a full-window layer that re-masked
  as packets moved. New tab with the board running: 30.8% of a core and 5.08ms per frame before,
  27.3% and 4.69ms after. One idle Claude tab: 20.3% and 3.38ms per frame before, 13–15% and 2.21ms
  after.
- The aurora. Its pool and rim gradients stepped twice a second under every `backdrop-filter`
  surface — the Settings pane, the new-tab field, chips and modules — re-blurring each of them on
  every step, about five points of a core whenever a Claude tab was open. They are static now and
  the keyframes are gone.
- The counter pipe. `typeperf` writes about 1,400 tiny chunks a second, and reading them in flowing
  mode cost main 4.7% of a core once the per-process counters rode along. The pipe is paused and
  drained once per tick instead: 0.35% of a core with the process rows, 0.27% without.

Measured and left alone:

- `@xterm/addon-webgl` drained a 2MB flood 1.33x faster with 1.9x better frame gaps, but moved the
  cost into the GPU process. That is below the 2x gate for taking on a dependency, so it was
  uninstalled; the DOM renderer still drains 2MB in about 15s with 34–50ms p95 frame gaps.
- Chromium command-line switches. Nothing tried measured as a win, so none were added.

Found, and not ours to fix:

- Every `<webview>` removal throws Electron's `Invalid guestInstanceId`. The guest is destroyed
  first, guest-view-manager drops the registry entry on its `destroyed` event, and then the
  element's queued `disconnectedCallback` sends a detach that `getGuestForFrame()` rejects. A bare
  one-webview Electron 44 app throws the same error and five teardown orders all still throw.
  Nothing leaks without a debugger attached; with DevTools attached the stored exception pins each
  closed tab until the console entries are discarded. It is written down at `closeTab` and
  `sleepTab`; the fix belongs upstream.
- The flicker on Settings open and on the new tab could not be reproduced headlessly — the guest
  neither repainted nor relaid out, and the only frame differences were the caret blink and blur
  rounding. The aurora was the one thing moving at rest in both places, so stilling it was a likely
  fix rather than a proven one. The caret turned out to be the other half of it: see the Settings
  flicker under Look.

### Security notes

- The webview attach hook overrides every preference a guest could ask for and strips the
  attributes those switches ride in on.
- Page-initiated `file:` navigation is cancelled; typing a `file://` path in the omnibox still
  works.
- Screenshot reveal is confined to the Downloads folder.
- Download URLs are scheme-allowlisted to http, https, blob and data.
- Permissions are deny-by-default, and "open another app" is asked every time and never remembered.
- The reader sanitises twice — once in the chrome, once over the live tree — to close the mXSS gap.
- PTY arguments are allowlisted to bare `--continue` and `--resume`; a bad argument costs a resume,
  never the tab.
- The PTY environment is scrubbed of `CLAUDE*` variables so a launched session does not think it is
  a child of this one.
- The shortcut map sent to main is size-checked and validated.
- The Finnhub, Brave Search and TMDB keys are now encrypted at rest with the system's encryption
  (DPAPI on Windows), like the Claude key. Keys saved by an older version are encrypted the first
  time Quartz reads them, and the plain-text copy is removed. If encryption is not available, the
  key keeps working and Settings says it is stored unencrypted and why; a saved key that can no
  longer be decrypted is reported beside its field with a request to paste it again.
- Updates are signed. Quartz now installs a release only when its tag is signed by a key the copy
  you already have trusts (`release-signers`), and only when the signed tag names exactly the
  commit being installed. An unsigned or wrongly signed release is not offered: the update card
  and Settings → About say why, and nothing on disk changes. The release that brings the key is
  the one exception, and the card says its signature was not checked.
- The browser window and its built-in pages (new tab, history, files, reader, welcome, phone) now
  carry a Content-Security-Policy, so a script injected into one of them cannot run inline code
  or load code from elsewhere.
- Settings → About says when the Electron (and so the Chromium) build was made and how long ago,
  with a plain warning once it is more than three weeks old.
- Quartz now runs on castlabs Electron 44.9.3 (Chromium 152.0.7977.167), up from 44.5.1 (Chromium
  152.0.7977.130). It carries the fix for an Electron security advisory (GHSA-jr5w-w6x2-84p9, fixed
  upstream from 44.9.1), and Electron's install-time downloader now uses undici 7.30.1, past five
  high-severity advisories in 7.29.1. `npm audit --omit=dev` is clean.
- Protected video after this update: streaming services need the build signed again, and
  Settings → Protected video says so until it is. See "Electron and Chromium updates" in the
  engineering notes.

### Developer tooling

- Quartz always opens a Chrome DevTools Protocol port now, so a local tool (Claude Code, a script)
  can drive the browser that is already running, signed in, without a restart: 127.0.0.1:9219,
  never the network (cdp-main.js). If 9219 is taken it uses a free port and says which pid held
  9219; `<profile>\cdp.json` records the port, the endpoint, the pid and the reason on every start,
  and `node tools/cdp-endpoint.js` prints the live endpoint (checked against `/json/version`).
  A port on the command line and every test run are left exactly as before. The trade-off: any
  program running as the user can control the browser through it (web pages cannot), so Settings →
  Claude has a switch to turn it off from the next start, and says what the current run has.
- The project is a git repo now, with the whole night's work committed locally.
- `node smoketest.js` launches its own instance on `--test-profile`, waits for `body.booted`,
  asserts, and tears down. `--keep` leaves it running. `cdp-eval.js` and `cdp-profile.js` drive it.
- The smoke test's debugging port comes from `SMOKE_PORT`, 9222 by default (3788d43), so it can run
  against a test-profile instance on its own port instead of the live browser.
- The smoke test ends with a summary line (56fe5dc). It prints `smoke: N ok, M failed` and exits 1
  when anything failed, so a run can be read at a glance or gated in a script. No step changed; the
  run behind that commit was smoke: 6 ok, 0 failed.
- The README is current through the last commit: shortcuts, features, security notes, performance
  numbers and a file-by-file map.
- `CLAUDE.md` holds the working rules for contributors and coding agents. The `ci` workflow runs
  the unit suite on every push and pull request and the full suite nightly on Windows.
- A CI `audit` job fails on high or critical advisories in the runtime dependencies, castlabs
  Electron included, with a one-line verdict in the run summary.
- `node tools/check-electron.js` reports how far the castlabs Electron pin is behind.
- Releases are cut with `node tools/release-tag.js`, which signs the tag and verifies it the way
  the updater will before it is pushed.
- `node tools/css-lint.js` holds stylesheets to the tokens.css scale; a baseline tolerates today's
  drift so only new drift fails.
- A fresh `npm ci` works again: the castlabs Electron package has no install script, so `npm ci`
  never downloaded Electron and then stopped with "electron.exe not found". The `postinstall` now
  runs Electron's installer first; the in-app updater's dependency updates (its staged `npm ci`)
  depended on this too.
- `tools/quartz-ff-golive.ps1` refuses a release that changes the dependencies, before it closes
  Quartz, and its STOP line prints the exact `tools/lumen-golive.ps1` command that ships it.

### Workspaces, the notes pane and the titlebar readouts (2026-09-12, evening)

- Four workspaces are seeded once behind Home: a notes workspace and three project workspaces,
  each with a colour and (except one, which is left for you to point somewhere) a folder. The folder is where a new
  Claude tab opens while that workspace is current; the popover has a Folder row (click to pick,
  a clear control) and a Pane toggle. A folder that no longer exists is named in the popover and
  over the chamber, instead of the terminal quietly starting in your home folder. Delete a preset
  and it stays deleted. The current workspace's colour washes the tab strip at 7%.
- Ctrl+Alt+1 to 9 jumps to the nth workspace in list order, also while a page has the keyboard.
- A workspace can own a side pane: a resizable column beside the tab well (380px by default,
  280 to 60% of the window, drag the 6px handle, width remembered). The notes workspace owns the notes pane.
- The notes pane shows a chip per notebook in your notes folder (plus Auto), a status strip
  that prints the reader's mode and reason, the helper's state and reason, and the section that
  matched, and the notebook itself, which scrolls to the matched section with a short highlight.
  Nothing in it is quiet: a refused command shows its reason beside the control.
- The reader looks at a configured desktop app. "Install reader policy" writes a per-app WebView2
  policy that opens a local remote-debugging port on that app's next start; from then on the pane reads the question
  straight off the page. If the app ignores the policy the pane says so and falls back to UI
  Automation, then to Windows OCR of the window, each fallback announced.
- The matcher is a headless Claude Code session per notebook (Sonnet, no tools, --safe-mode, resumed
  between questions): it answers a section id only, never the answer, in 3 to 6 seconds for about
  a cent a question after the first. It reads the budget pill and pauses itself at 90% of the
  5-hour limit or 95% of the week, saying so in the pane. "Paste a question" runs it by hand.
- A budget pill in the titlebar: 5-hour and week percentages from the statusline hook's JSON,
  amber from 80%, red from 95%, and a card with the countdowns, today's spend and the reading's
  age. An idle session simply stops writing, so an older reading keeps its numbers and shows its
  age; only a reading over an hour old is called stale, and a missing or unreadable one says so
  in the pill. The new tab's readout gains the same budget row. (A now-playing pill shipped
  beside it for twenty minutes and was removed at the user's request; the new tab's now-playing tile
  is unchanged.)

### Phone workspace (2026-09-13)

- A fifth workspace, Phone (midnight), that opens into the phone itself instead of a new tab page:
  your Android phone, mirrored in a tab over Tailscale at the address set in Settings. There is
  no cable path and nothing goes over the open internet, so the phone's Tailscale has to be on —
  without it every failure below is a timeout, which is the one thing no readout can work out for
  itself, so the Settings section says it in the first line. Ctrl+T in that workspace still opens a
  new tab page, because that is what Ctrl+T means.
- Presets are seeded per key now, not once for the set. The first four went in under a single flag,
  so a fifth added later would never have reached a profile that already carried it; what is
  recorded is the list of keys a profile has been offered. A preset you delete still stays deleted.
- Only two things are downloaded, and only on first use: adb and the scrcpy v4.1 server, into the
  profile's tools folder, with the server jar checked against the sha256 published with its release
  and refused on a mismatch. The download shows its bytes on the page rather than in a log, and
  opening Settings describes what is there without fetching anything.
- Pairing is once: Wireless debugging → "Pair device with pairing code" on the phone, and the host,
  port and six digits into Settings → Phone. The pairing port is not the port you connect on — the
  phone shows both and they differ. After the first connect the browser pins adb to port 5555 so
  later connects need no reading at all.
- That pin is lost whenever the phone changes Wi-Fi or reboots: adbd restarts on a fresh random
  port. The reconnect now disconnects the stale entry, finds the new port over mDNS when it can,
  re-pins 5555 and comes back on the Tailscale address — and when it cannot, it names the port to
  read off the phone instead of retrying into nothing.
- The mouse is a finger: move, press and drag are touch, the wheel scrolls, right-click is Back,
  middle-click is Home. The keyboard is captured while the screen has focus, Ctrl+C and Ctrl+V
  carry the clipboard both ways, and Ctrl+Alt+P hands the keys back to the browser; the `keys`
  readout says which side has them. The rail has Back, Home, Recents, Power, Vol +, Vol −, Rotate,
  Notifs, Screen off, Wake, Copy ← phone, Paste → phone, Screenshot and Mute. Every byte written to
  the control socket comes from the scrcpy v4.1 sources and their serialisation tests, not memory.
- Fifteen readouts beside the picture: device, battery, phone rtt, browser rtt, fps, kbps, decoder,
  decode time, decode queue, dropped, key frames asked, frame age, profile · bitrate, audio, keys.
  On the real phone over Tailscale-on-LAN that reads about 59 fps painted with roughly 1 ms
  hardware decode and an empty queue.
- Quality in Settings → Phone: a profile (At home, Away, Auto), a bitrate for each of the first
  two, longest side, frame rate, phone audio, turning the phone's screen off while mirroring, and
  connecting on its own at startup. Auto measures a TCP round trip to the phone's adb port rather
  than timing adb itself — spawning adb costs about 170 ms on a 7 ms link, and that number chose
  Away for ever.
- At the top of that section, above everything it governs, a **Phone link** switch. Off stops the
  stream, disconnects the phone and kills the adb server, and nothing reconnects, downloads or
  spawns adb again until it is back on. Pairing is kept, so on is one press away, and the switch is
  drawn before the first state arrives so the way out never depends on the thing being switched off
  answering.
- Nothing in it fails silently. Every state names itself, its reason and the one action that moves
  it on — download the tools, open Settings → Phone, connect, start, retry — and a refused command
  prints its reason under the button that sent it.
- A still screen is not a stall. scrcpy encodes a frame only when the picture changes, so a phone
  resting on its home screen sends nothing for minutes and that is the stream working perfectly.
  Once a frame has painted the picture is never covered again, silence reads as "still N s" beside
  a counting frame age, and "stalled" needs the server alive, 15 s of silence *and* a dead control
  socket.
- The picture path was tuned against the real phone. Frames arrive in bursts, so parking one for
  the next animation frame binned a quarter of them: the page paints in the decoder's output
  callback, and painted fps now tracks the relay. Hardware decode is the default with an automatic
  software fallback, a decoder's first frame after `configure()` is no longer mistaken for falling
  behind, and a page that shed to 30 fps and then a shorter longest side asks for what it turned
  down back after 30 s of clean running. A dropped frame, a decoder reset, a tab coming back into
  view or a reconnect asks the phone for a key frame at once instead of waiting up to ten seconds.

### Processes (2026-09-13)

- Every Electron process on its own row. A group of more than one process carries its children now:
  pid, the role read once from the command line (main, renderer, GPU, audio, network, utility), CPU,
  memory and I/O. The new tab page draws a chevron on such a group, keeps the child rows by pid so
  nothing thrashes between samples, and remembers which groups you left open.
- A renderer row says what it holds — a bundled page by its file name, the chrome document as
  Browser UI, a renderer holding nothing as idle renderer — and for a tab, the tab and the workspace
  it lives in: "New tab · Home (this page)", "Example Domain · Notes", a Claude tab as
  "Claude · <workspace>", three names at most and then +N for a process several tabs share. main
  hands each renderer row the webContents ids living in it and the chrome, which alone knows
  workspaces, rewrites the labels on the way past.
- Failures are words, not blanks. A command line that could not be read says why on the row —
  another user's process, or one the browser is not allowed to open — and a throw in the rewrite
  relays the sample untouched with a note under the group rather than a half-rewritten list. Every
  label is worked out before any of them is written, which is what makes that possible.

### Workspaces sleep (2026-09-13)

- Only the workspace you are looking at keeps its pages running. Seven new-tab pages across the
  seeded workspaces each kept decoding the video background at 60 fps, because a hidden `<webview>`
  does not reliably tell its guest it is hidden; the GPU process sat at 1.9 GB and the whole browser
  lagged.
- Leaving a workspace puts its new-tab pages to sleep at once: the guest is torn down, the chip
  keeps its title with a crescent where the close button sits, and a woken new-tab page comes back
  fresh — a new tab page has nothing to lose.
- An optional mode sleeps every page in a workspace once you have been away from it for N minutes.
  Those reload on return, at the cost of their scroll and their forms. A Claude chamber and a native
  app tab never sleep under any mode; the Phone page does, and its stream goes down with it.
- A restart restores only the current workspace's pages awake — the rest come back born asleep under
  the titles they had. Settings → Tabs carries the policy (New tab pages, Every page, Off) and says
  in one sentence what each choice does and what it costs; the workspace popover shows "2 asleep"
  beside the count.
- Measured in a test instance: 6 workspaces visited leaves 2 guests instead of 6, one video decoding
  instead of five, and GPU memory flat.

### Signing in to X (2026-09-21)

- X (x.com and twitter.com) was the one site you could not log in to. Submitting the form answered
  "Could not log you in now", or the form stopped responding, or a verification step arrived that
  never completed — on username and password as well as on the social buttons, while every other
  site signed in fine. Five things were wrong at once, and all five are fixed.
- The browser no longer tells sites it is Electron. The User-Agent had `browser/0.1.0` and
  `Electron/44.3.0` in front of the Chrome token; both are now cut out of Electron's own string at
  startup, leaving a plain Chrome-on-Windows UA. It is derived from the real value and the real app
  name, so the Chrome version and the platform stay whatever this build actually ships and a rename
  cannot leave a stale literal behind. A strip that produced something malformed says so on the
  console and falls back to a built string rather than shipping a broken UA quietly.
- The client hints now say the same thing. A Chromium sends its identity twice, and the Sec-CH-UA
  header still listed `"Electron";v="44"` beside a UA string claiming plain Chrome — which to a site
  that cross-checks them reads worse than the original. A single request-header hook rewrites
  Sec-CH-UA to a Chrome brand list, drops Sec-CH-UA-Full-Version-List, corrects any other header
  still naming Electron, and passes everything else through untouched. It sits on the one webRequest
  event the ad blocker does not own, is installed once, and cannot stall a request: the body is
  wrapped, and on any error the original headers go through unchanged.
- Cosmetic scriptlets are off for x.com and twitter.com, the way they already are for YouTube. This
  is the measured cause, not a suspicion. Asked what it would inject into `https://x.com/i/flow/login`,
  the cached engine the app actually runs answers with ten scriptlets, and seven of them monkey-patch
  `XMLHttpRequest` for the whole page: five `json-prune-xhr-response` wrappers and two copies of
  `prevent-xhr("/i/api/1\.1/flow/viewer\.json")`. That last one cancels, inside the page, a request
  of X's own login flow that the network engine lets through — so nothing appears blocked while the
  flow dead-ends, and there is no document load to reload past. It is x.com-specific: twitter.com
  gets seven scriptlets and not that one. Network blocking and the cosmetic CSS are unchanged.
- X's own sign-in endpoints are excepted from blocking, and only those. Measured against the cached
  engine, the network layer was a smaller part of this than it looked: of the login URLs tested, the
  only x.com blocks that fire are telemetry (`/i/jot`, `/i/api/1.1/jot`, `/i/csp_report`) plus three
  exact-path `graphql/*.json` rules — `user_flow`, `viewer_context`, `app_context` — that the modern
  client no longer calls, and `api.twitter.com/1.1/onboarding/referrer.json`, caught by a generic
  `/referrer` regex. Those onboarding, GraphQL and OAuth2 paths sit next to X's analytics paths in
  the privacy lists, so the exceptions are there to keep a list update from taking sign-in down
  again. The telemetry paths above are deliberately still blocked. An exception filter the engine
  cannot parse used to be dropped in silence; it is now named on the console instead.
- The Storage Access API is allowed without a prompt. The twitter.com → x.com identity bridge and
  the embedded Google and Apple sign-in frames call `document.requestStorageAccess()`, and anything
  not on an allow-list here is denied with no prompt and no trace — a sign-in that just did not
  work, for no visible reason.

### Quartz becomes the app id (2026-09-26)

- The app is now Quartz to Windows and to its own profile, not only on screen. `package.json`
  gains `productName: "Quartz"`, so the profile folder is `%APPDATA%\Quartz`. The npm `name` stays
  `browser` (npm wants it lowercase, and nothing reads it once `productName` is set).
- The first start under the new name moves your profile, logins and all: `%APPDATA%\browser` is
  renamed to `%APPDATA%\Quartz` before anything opens a file in it. It is one rename on the same
  drive, so nothing is copied and there is no half-moved state. Settings → About now says where
  the profile is and when it was moved.
- It never starts you on an empty profile. If an old copy is still running and holding files
  (it gets about 2.4 s to let go, which covers Restart browser), or both folders exist, or either
  one is not a folder, Quartz shows an error box naming the folders and the reason — "Close the
  other window and start Quartz again" — and quits without moving, merging or deleting anything.
  Test runs (`--test-profile`) are never moved. The code was inert until the name changed, so it
  landed before `package.json` did.
- The Windows identity is fixed at `com.owensilva.quartz` (it was the derived
  `electron.app.browser`), so a future display-name change cannot move it again.
- New `relink-shortcut.ps1` writes Start Menu → `Quartz.lnk` carrying that id, which Windows needs
  before it shows the "Claude is waiting" toast. `register-default-browser.ps1` now registers
  `Quartz` / `QuartzURL` / `QuartzHTML`, and `-RemoveOld` deletes the old `OwenBrowser` entries
  once no default still points at them. Neither runs by itself; the taskbar pin keeps its
  `Browser.lnk` file name so Mantle's bar order holds.
- Verified with a pure-node harness on temp folders (38/38), including a folder locked the way
  Chromium holds its `lockfile`, which is refused with the box's wording. Measured on a scratch
  Electron 44 app: `app.getPath('userData')` creates the folder, so the move computes the path
  instead of asking for it; and `dialog.showErrorBox` shows a real box before `ready`.

## Things to know

- A forced kill can lose the last few seconds of tab state. A normal close cannot — the strip is
  written both to `localStorage` and to `session.json` in the profile, and that file is written to a
  temp name and renamed, so a kill mid-write can only destroy the temp.
- Restored Claude tabs are not the same live session you left. They come back as fresh sessions
  launched with `--continue` in the same folder.
- Opening a Claude tab in a folder Claude Code has not run in before shows its trust prompt first.
  That prompt is Claude's, not the browser's.
- The ad-block engine is fetched on first run and cached in the profile as `adblock-engine.bin`, so
  the first launch after clearing the profile is slower and needs the network.
- Screenshots go straight to the Downloads folder; nothing outside it can be revealed from the app.
- Workspace switching is Ctrl+Alt+Left and Ctrl+Alt+Right. Ctrl+Shift+E opens the switcher popover;
  Ctrl+Shift+W was left alone because it closes the window everywhere else.
- If a browser style you wrote breaks the UI, Ctrl+Alt+Shift+R resets it from anywhere.
- Anything started with `--test-profile` uses `%TEMP%\browser-test-profile` and never touches the
  real profile at `%APPDATA%\browser`.
- Restart browser — Settings → About, or the command palette — flushes the session and window
  state, releases any Spotify auto-pause hold, and relaunches with the same arguments and the tabs
  restored. Use it after pulling an update: code changes only take effect after a restart.
- Maximised, a 2-3px band of bare acrylic shows at the left, right and bottom edges. It is the
  native resize border Windows keeps around a window using the acrylic material, outside the
  document, so no stylesheet reaches it; fixing it would cost either the acrylic (`frame: false`
  renders it black) or native snap and restore, so it is left alone. The measurement is written
  down in main.js.
- The Spotify section needs the separate helper installed at `~/spotify-autopause`. Without it the
  switches are drawn but disabled and the readout says "Not installed on this computer", rather
  than claiming something is running.
- The new tab's stats need Windows' `typeperf` and its English counter names. On a Windows
  installed in another language the disk, network and GPU figures show a dash; CPU and memory come
  from Node itself and read the same everywhere.
- Scriptlets are off for youtube.com, which is what makes the player build after an in-page click.
  Network and cosmetic blocking are untouched there, but an in-stream ad can still play — that was
  already true on the reload path, and this is a player fix, not an ad skipper.
- Idle music plays only while nothing else is audible: no playing tab, no Spotify, nothing in the
  Windows media session, and the window focused. It fades out for anything that starts, and waits
  2.5s of quiet before fading back in.
- Media keys no longer control browser tabs. Taking the browser out of the Windows media session is
  what stopped idle music pausing itself, so the keys go to Spotify, and the now-playing tile shows
  Spotify and other apps but never a tab in here.
- koffi is a new runtime dependency, for the native app-tab engine. Run `npm install` after pulling
  this, or the embedding calls answer "unavailable"; nothing else is affected.
- Not every app can run in a tab. Store apps are refused outright, and Windows 11's packaged Notepad
  destroys its own window the moment it is re-parented; neither can be hosted, so launch them
  normally. The tab side is verified against Character Map and Paint.
- A hosted app with the focus owns most of the keyboard, but not all of it. New tab, the address
  bar, the palette, tab search, Ctrl+Tab both ways and the Files tab still fire while you are
  working inside the app, and the keyboard comes back to the browser once one of them has. Ctrl+W
  and the keys a hosted editor or chat app owns — F, R, S, P, N — go to the app, not here. And if
  the app hangs, the browser's input can hang with it until the tab is popped out.
- DRM services cannot play inside a tab. Electron ships Chromium without Widevine, so Spotify and
  Netflix are handled as the desktop app plus the now-playing controls here, not as pages. Opening
  one of the five from the catalogue gives you a note bar saying so, with a link that launches the
  desktop app when it is installed.
- Ctrl+Alt+E opens the Files tab. Ctrl+Shift+E is still Workspaces.
- The notes pane's reader needs the reader policy installed once (the button in the pane) and
  then a restart of the reader app. Whether the app honours it has not been seen yet: the pane will say
  "policy ignored" and fall back to UI Automation if it does not.
- The helper is a real Claude session and spends real budget: about a cent per question on Sonnet
  once the notebook index is loaded. It pauses itself at 90% of the 5-hour limit or 95% of the week.
- The budget pill reads the JSON that a Claude Code statusline hook writes to a
  local folder; with no active Claude Code session the reading goes stale after ten minutes
  and the pill says so, rather than showing an old number as current.
- The Phone workspace needs Tailscale running on the phone. There is no cable path, so with it off
  every step times out; the tab and the Settings section both say so rather than guessing.
- The 5555 pin does not survive a Wi-Fi change or a phone reboot. Usually the reconnect finds the
  new port on its own; when it cannot, the tab names the port to read off the phone under Wireless
  debugging, and one connect re-pins it.
- "Turn the phone screen off while mirroring" and the Screen off key are honest now: on the test phone (recent Android) the mirror goes BLACK with the panel — Android draws nothing for a powered-off display — so they only save the panel; and on battery the panel goes off at every stream
  start, the phone then falls asleep at its own screen timeout, and a sleeping phone mirrors black
  until Wake. Only a charging phone stays awake with the panel off; the setting's row and the black
  note both say so now. A quality change the page asks for on its own (a shed while the decoder
  was cold) lasts the session and is never saved — Settings → Phone is the only thing that persists.
- Screen off does exactly what it says and nothing more: the panel goes dark on the desk while
  Android keeps compositing, so the mirror carries on unchanged — the rail repeats the server's
  own "display turned off" line so you know it landed. The old Screen on key could never wake a
  dozing phone (that call sits under Android's power manager), so it is now **Wake**, which sends
  a real wake key first. A black picture is a sleeping phone or the hidden sign-in screen — the
  sign-in screen does NOT mirror on the test phone (recent Android hides it from capture, the phone itself is lit) but keys still land, so the note says to type the password blind or unlock on the phone — and after a second of black the canvas
  says so and points at Wake. Proven on the phone over adb; the buttons themselves still await a
  live press in the browser.
- Only adb and the scrcpy server are downloaded, on first use, into the profile's tools folder. A
  cleared profile fetches them again, and that first Phone tab needs the network.
- If the browser lags with many workspaces open, it was the new tab pages. A hidden `<webview>` does
  not reliably tell its guest it is hidden, so every workspace parked on a new tab page carried on
  decoding the moving background at 60 fps into the one GPU process — seven of them took it to
  1.9 GB. Workspace sleep is on by default and is the fix; turn it off in Settings → Tabs and this
  comes back.

## Commits

Times are local. 21:26 through 23:54 are 10 September; 00:29 through 23:51 are 11 September; 00:08
through 04:30 are the small hours after that same 11 September evening; 09:53 through 19:55 are
12 September; 14:19 through 20:34 are 13 September. The rows after 1402fb9 skip ahead: 00:05
through 03:43 at the end are 29 October, a round of fixes; `git log` has everything between.

| Hash | Time | Summary |
| --- | --- | --- |
| 01358c3 | 21:26 | Initial commit: glass Electron browser with Claude tabs, themes, circuit-board new tab |
| c793070 | 21:42 | Find in page, downloads shelf, history suggestions, context menus, permission prompts, fullscreen |
| 41be354 | 22:00 | Settings panel, accent colour, search engines, site theme, tab drag/menu, crash cards |
| 230121f | 22:21 | README and QA note on the drag-region right-click |
| cc01d53 | 22:40 | Ad/tracker blocking with shield, tab audio and pinning, zoom badge, new-tab recents |
| a7ba15e | 22:53 | Claude tabs with a chosen folder, conversation resume and restore; durable session; print |
| 1e5bfa5 | 23:15 | Tab sleeping, per-site styles with force dark, reader view |
| 37fc4f0 | 23:42 | QA fixes: drag reaches the outermost slot, Ctrl+Shift+R replayed from pages; README for rounds 4-6 |
| d35c505 | 23:54 | Palette presets (ember, forest, ocean, midnight, mono) and tab search |
| e60cebd | 00:29 | Site info popover with persisted permissions and site-data clearing, split view, site scripts |
| 10cf854 | 01:05 | New-tab backgrounds (aurora only, your image), QA fixes, README for rounds 8-9 |
| a23d9ac | 01:19 | Claude beside a page in split view, page screenshots, bookmarks bar, board pause under overlays |
| eba95ac | 01:45 | Claude needs-you indicator, command palette, README for rounds 10-11 |
| e157a7a | 01:59 | Ask Claude about this, history page, picture in picture |
| 81f81a5 | 02:19 | Customisable keyboard shortcuts, README for rounds 12-13 |
| e2e2bca | 02:42 | Shortcut fixes from QA: Ctrl+R alias kept in bindings, shifted-punctuation lookup in main, hint text for fixed rows |
| 5ecff29 | 03:01 | Workspaces, downloads save-as and open folder, more palette commands |
| 7c7598b | 03:38 | QA and design pass over rounds 14-15 |
| 518d263 | 04:04 | Resume a Claude conversation, security hardening, performance audit |
| 9cb9fba | 04:19 | Browser style (user CSS for the chrome), board freezes on window blur, README for round 17 |
| c384475 | 04:26 | Show Claude this page (screenshot handed to a Claude tab), CHANGELOG |
| ec8366f | 04:38 | Ask Claude about this article (readable text, capped), paste waits behind Claude's prompts |
| 382f1fd | 04:52 | Settings filter box |
| 69599f5 | 04:52 | CHANGELOG: settings filter |
| 18b55a7 | 06:07 | Recent Claude folders in the strip menu and palette; README for rounds 18-21 |
| 19c5c2b | 06:07 | CHANGELOG: intro no longer hardcodes the commit count |
| 33d4fac | 10:51 | Ask Claude about a downloaded file; chambers open synchronously on activation |
| 627b163 | 11:40 | Instrument glass: bevelled containers, light rims, pips, readout type |
| 23f7b31 | 11:44 | Spotify auto-pause in the browser; new tab keeps live settings across a reload |
| 34d7bbe | 12:19 | Spotify auto-pause: Twitch and other video sites watched by default; saved lists take new defaults |
| ba743da | 12:35 | Spotify auto-pause: a muted tab hands the music back |
| 149a033 | 13:08 | Instrument glass, pass two: ink chrome, segment tabs, live new-tab modules, one pane header |
| b3d6f41 | 13:08 | Claude tabs skip permission prompts; board follows the real window focus; Restart browser action; new-tab readout |
| db73723 | 13:14 | CHANGELOG + README: design pass two, Claude skip-permissions, Restart browser, new-tab readout, edge band note |
| ca3256b | 13:40 | Tab strip back to the pass-one chips; the rest of pass two stays |
| bb53ae4 | 13:41 | CHANGELOG + README: tabs are the pass-one chips again; rows for db73723 and ca3256b |
| 97267eb | 13:50 | Revert the pass-two chrome and pane styling; the new tab keeps its board, clock and readout |
| eeb1e7a | 13:59 | Test runs can name their profile (--profile-name) so parallel instances never share storage |
| 85d66c2 | 14:17 | Popups open as tabs again: setWindowOpenHandler on guests replaces the new-window event Electron removed |
| 8229844 | 14:41 | Dark theme: neutral charcoal ground, hairlines instead of lit rims, glow only on focus, restrained accent |
| bb996ac | 14:41 | Settings: the accent hue slider track is a muted spectrum, not a saturated rainbow |
| 039acec | 14:49 | Claude tabs: a resize that does not change the grid no longer resizes the pty |
| 1b09e9e | 14:54 | Main process: session snapshots write async and single-flight; pty output reaches the renderer once per frame |
| fe3b38b | 15:04 | Chrome: guest navigation reads are cached, pushes to guests are memoised, session writes flush on unload |
| b22bd58 | 15:06 | Settings: a custom accent hue derives at the calmed dark-theme strength |
| 18cd4ad | 15:28 | Site info: the button seats itself from cached row geometry instead of measuring on every tab change |
| 8fcba52 | 15:43 | app.js: note why every webview removal throws Invalid guestInstanceId (Electron, uncatchable, harmless) |
| ce6916a | 15:55 | Compositing: pips get their own layer; the board vignette is baked into the canvas instead of a full-window mask |
| a146cfa | 15:56 | The aurora holds still: no more twice-a-second nudge under the frosted surfaces |
| ea4fd57 | 16:50 | Chrome: subscribe to system stats only while a new-tab page is in front, and push each sample to that guest |
| 9776f1c | 16:59 | System stats sampler: CPU, memory, disk, network and GPU from the OS and Windows performance counters, only while asked |
| b9f5ca2 | 17:04 | New tab: live system stats replace the search field |
| dbc8744 | 17:07 | Settings: a Moving picture background, chosen from a file and copied into the profile |
| d8572e5 | 17:18 | New tab: a Moving picture plays behind the board, muted, and pauses whenever the page is not in front |
| 669c943 | 18:09 | System stats sample once a second, Task Manager's cadence |
| b3348e9 | 18:12 | Settings: opening the pane focuses the panel, not the filter box, so no caret blinks under the acrylic |
| cf15ff9 | 18:16 | End task plumbing: the new-tab page asks over its console line, main kills through stats.endTask, the answer is pushed back |
| bed0643 | 18:41 | New tab: a Processes pop-out opens from the stats strip, with End task |
| 16d1b09 | 18:57 | System stats: the counter stream survives vanished instances and refreshes them; per-process rows; endTask with refusals |
| ad2fa18 | 19:00 | New tab: the process list is an expander under the stats strip, remembered open or closed |
| 2f56e07 | 20:19 | Apps: installed-app index, launch and focus (main process) |
| 95b5034 | 20:19 | Apps: pins in settings, chrome push to the new tab, palette rows |
| fdc3c12 | 20:28 | Apps: the new-tab dock (pinned app tiles, running dots, Edit and Add app) |
| cf86935 | 20:28 | Ad blocker: never cancel YouTube's own player and stats calls |
| c984889 | 20:35 | New tab: process icons in the Processes list (page side) |
| c4d0d21 | 20:36 | Process icons: resolver module for the main process |
| ce31821 | 20:38 | Process icons: chrome wiring (IPC, cache, push to the new tab) |
| 7eb3d1a | 20:43 | CHANGELOG + README: the apps dock, process icons and the YouTube ad-block exception |
| a95db9d | 21:07 | New tab: dock review fixes (Add app tile, picker height, Escape focus) |
| 91a3b66 | 21:10 | Apps: chrome review fixes (refresh race, refresh answer, pin cap) |
| 91682dc | 21:13 | Files tab: the folder browser page (page side, not yet wired) |
| 7e637cd | 21:37 | Palette: app rows on a plain search; new tab: light-theme dot contrast |
| 38bd224 | 21:43 | Popups: real child windows for window.open, tabs for links |
| 5b85fe2 | 21:45 | Idle music: the built-in ambient engine (not yet wired) |
| 439cdd5 | 22:01 | Apps: focus by real window, quieter index, Store exe names, x86 twins |
| 4914b45 | 22:01 | New tab: the Idle music module (page side) |
| cf13b3a | 22:04 | Files tab: chrome wiring (IPC, console channel, palette row, Ctrl+Alt+E) |
| f4d8ca1 | 22:05 | Ad blocker: no scriptlets on youtube.com (in-page clicks play again) |
| 0df6795 | 22:10 | Settings: section names read as headings |
| 33a77e0 | 22:12 | Settings: the Idle music section and a Quiet Spotify ads switch |
| bc25347 | 22:16 | Main and preload: music file picker, now-playing and ad-duck bridge calls |
| 528558c | 22:25 | Terminal tabs: program table for pty sessions (claude, powershell, pwsh, cmd, python, node, bash) |
| 1ef5668 | 22:33 | Idle music: the player, plus the now-playing feed to the new tab |
| 7478701 | 22:34 | Docs: CHANGELOG and README through 528558c |
| 53524f4 | 22:37 | New tab: now-playing tile as a third module |
| 01cd471 | 22:38 | Web app catalogue, pin options, and a collapsed Shortcuts section in Settings |
| b0a5af8 | 22:52 | App tabs: web apps and terminal programs open as tabs |
| e135f54 | 22:58 | Idle music: stop the player vetoing its own sound, add resume hysteresis |
| 95f2d24 | 22:59 | New tab dock: web app and terminal pins, grouped picker, web toggle |
| eafa0fc | 23:14 | Review fixes: app tabs and idle music wiring |
| 769b1d9 | 23:21 | Native app tabs: the window embedding engine |
| fc88f3c | 23:28 | Docs: CHANGELOG and README through 769b1d9 |
| 90870c4 | 23:32 | New tab dock: an app / web / tab chooser on installed pins |
| 3788d43 | 23:43 | smoketest: the debugging port comes from SMOKE_PORT (default 9222) |
| 71f60f8 | 23:46 | Review fixes: the window embedding engine |
| f523390 | 23:51 | Native app tabs: the tab side |
| 6f4415c | 00:08 | Native app tabs: prefer the window of the process we launched |
| 60c81fc | 00:19 | Review fixes: native app tab chrome side |
| 30a4bd9 | 00:24 | Native app tabs: adopt a running app before launching another copy |
| 56fe5dc | 01:15 | Terminal tabs: node-pty's console-list helper stops crashing on close; the smoke test prints a summary |
| 52c9aa7 | 01:22 | Native app tabs: true focus and a few live shortcuts while a hosted app has the keyboard |
| 14a076b | 01:26 | Apps: launches keep the shortcut's taskbar identity and run-as flag, with %VAR% expansion and fallbacks |
| 84717e3 | 01:42 | Native app tabs: "app holds the keyboard" is decided by process id, so hosted Electron and CEF apps arm the shortcuts |
| 7185f13 | 02:49 | Native app tabs: live tab titles from the app itself, and an honest "(not responding)" state with Pop out and Close tab |
| ca73bcb | 03:53 | Native app tabs: host by ownership instead of re-parenting, so a hung app can no longer stall the browser |
| f6ac242 | 04:30 | Review fixes: owner-mode engine, plus recovery after a force-killed browser |
| d33e47b | 09:53 | Omnibox app rows with badges; dock focus across every pid, launching when there is no window; pin options survive pin/unpin |
| 1a78430 | 10:31 | Omnibox app rows: Enter hosts the app in a tab, Shift+Enter opens it on the desktop |
| eb8aac3 | 10:41 | New-tab shortcuts are the five most-visited sites from history |
| 8d6d923 | 10:54 | Tab chips: a minus button collapses the tab to its icon, an expand badge brings it back |
| 14d7dbe | 11:32 | Tab chips: the collapse button on every tab kind; a collapsed tab expands while it is active |
| faec2bb | 11:49 | Settings: every section starts collapsed, except About which never folds |
| 53dca7a | 11:50 | Tooling: toback.ps1 sends a test instance's windows to the back without activating them |
| 6a872d6 | 11:59 | New tab: a live Markets tile bottom-right, fed by Finnhub with a key from Settings |
| cb8cde0 | 12:00 | Tooling: toback.ps1 keeps its pid set whole and skips titleless and IME windows |
| 655bafd | 18:39 | Scaffold: budget, notes-pane and pill modules with their IPC and slots |
| 9a78e68 | 18:58 | Notes pane: notebook chips, live reader/helper status, and notes that jump to the matching section |
| 0a771ab | 18:59 | Notes pane: reads the on-screen question and finds the matching notes section |
| bbff8fa | 19:03 | Workspaces: four presets, per-workspace folder and side pane, strip tint, Ctrl+Alt+1-9 |
| 0d12828 | 19:07 | Titlebar readouts: Claude usage pill with limits and today's spend, plus now playing |
| 0eaf9eb | 19:11 | Now playing: the pill says "ad · quiet" while the bridge has Spotify turned down |
| ac9b4bd | 19:48 | Side pane: a hidden host no longer draws an empty column beside the well |
| 70d06e8 | 19:55 | Budget pill: card clears the nav row, today's spend is today's, 10 min is not stale; now-playing pill removed |
| b2e28c5 | 14:19 | Scaffold: the Phone workspace's files and contract — phone.js carries the IPC, the state shape, the console bootstrap and the WebSocket framing, pinned to scrcpy v4.1 |
| fb3cca0 | 14:41 | Phone workspace: a fifth preset that opens into the phone, per-key preset seeding, and a foldable Settings → Phone that prints every command's reason under the button that sent it |
| ecf5f68 | 14:46 | Phone workspace: phone.js in full — the sha-pinned tools, the device machine, the stream and the relay, with packet-exact splitting and backpressure that drops only delta frames |
| 61830d1 | 14:55 | Phone workspace: the page that is the phone — WebCodecs decode and paint, audio, mouse and keyboard as scrcpy control messages, the rail, the readouts, and ?selftest=1 |
| 32f4e7e | 15:58 | Phone relay: what the first live pass taught it — a TCP round trip decides the auto profile, a still screen is not a stall, a key frame is asked for on the first drop, and a Wi-Fi change re-pins 5555 |
| b87e772 | 16:07 | Phone page: what the first live pass taught it — silence reads as "still N s", key frames on the way back, a deeper decode queue with its own readouts, and two geometry bugs from the size probe |
| 770b6de | 16:57 | Phone page: paint every frame in the decoder's callback, forgive a cold decoder, and ask back for what a shed turned down after 30 s of clean running |
| 0406ef5 | 19:39 | Phone: Screen on becomes Wake, a black picture names its cause on the canvas, a refused control frame is no longer dropped silently, Settings → Phone gets the Phone link switch, the keyboard release chord moves to Ctrl+Alt+P, and the Phone workspace keeps its page across a restart |
| 92f7864 | 20:01 | Processes: every Electron process on its own row, named by the tab it hosts |
| 252359e | 20:14 | Processes: a renderer's row names its tab and its workspace |
| 1660003 | 20:34 | Workspaces sleep: only the workspace you are looking at keeps its pages running |
| 54d6a57 | 20:46 | Phone: Wake sends display-on before the wake key (the server otherwise forces the display off again), a server child flushing after a restart no longer crashes main, page sheds stay temporary and never reach phone.json, and the black note names the screen-off-while-mirroring setting |
| 1402fb9 | 20:52 | Phone: Screen off says what this phone does — on recent Android the mirror goes black with the panel, Wake brings both back; the rail, the black note and the setting row all say so |
| 6a89d30 | 00:05 | Tests: the DRM e2e tests act only once the chrome has booted (`waitChromeBooted`), not as soon as app.js has loaded |
| 39e50e2 | 00:06 | Tabs: "making sound" follows Chromium's audibility, not a media flag that a closed Web Audio context left stuck, so such tabs sleep again |
| 040cb90 | 00:07 | Tests: askclaude-e2e and mcp-e2e read a note's words without its icon and print `[diag]` lines naming why a wait timed out |
| 7e431ae | 00:18 | Claude: a page-text chamber keeps its own note under tool lines and asks |
| 0eeedf2 | 02:12 | Tests: log-e2e waits for the booted chrome before acting |
| c5b8da5 | 02:58 | Tests: csp-e2e's watchdog really ends a hung run; `--trace` times every step |
| 6ddda90 | 03:22 | Tests: csp-e2e reloads each guest from its own task, never with DevTools `Page.reload` (which reloads the whole window) |
| c0501a1 | 03:28 | Reader view: article images resolve against the page through `doc.baseURI`, not a `<base>` the window's policy refused |
| b0b496f | 03:28 | Tests: an e2e-kit call on a closed DevTools socket fails at once instead of waiting for ever |
| 9859904 | 03:33 | Idle music: follows Chromium's audibility; the media flag counts only for a tab Chromium never answered for |
| 798e9ff | 03:43 | Tests: the Claude stand-in runs under a console node.exe named by the test, not electron.exe, which gets no console in a PTY |
| 0901af6 | 03:43 | Tests: mcp-e2e and askclaude-e2e run the stand-in under node and check its banner reaches the pane before pasting |
