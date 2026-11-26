# Look fidelity audit: Home and the top rows against the approved design

The approved design is a static prototype of Quartz's Home (dark: `style.css`; light: `style.css` plus
`light.css` and the light notes `LIGHT.md`). Its files live outside this repository; this page cites them as
`design style.css:NNN`, `design light.css:NNN` and `design LIGHT.md §N`. Quartz's side cites this
repository's files at the commit the audit was taken (before any fix); **after** is the state once the
look-fidelity fixes landed.

Match: **yes**, **no** or **partial**, each with one word on why. The after column was read from the CSS;
`tools/look-shots.js` has since taken the window's pictures (dark and light, 1536x864 and 1920x1080, the
built-in "Peaks in cloud" picture) and "Seen on screen" below says what they showed.

## Home: the picture under it

| element | design value (file:line) | Quartz value (file:line) | match? | after |
|---|---|---|---|---|
| top shade over the picture | `linear-gradient(180deg, rgba(8,10,12,.28) 0, rgba(8,10,12,0) 180px)` over the picture, under every island (design style.css:105-108) | none: "No scrim: the one wash is the only tint" (backdrop.css:131-136) | no (missing) | yes (`.backdrop::after`, theme-free; toprow.js counts it) |
| dim wash | `rgba(0,0,0,var(--dim))` over the picture and inside every island (design style.css:116, 651); LIGHT.md: 20% to 90%, default 20% (design LIGHT.md §3) | `rgb(var(--wash-rgb) / var(--chrome-glass-a, .2))` over the picture and inside every island (backdrop.css:105-108; newtab.css:3303); default 20% from look-sync | yes (dark) | yes (both themes: the stored Dim, a black wash; see the light table) |
| the page area on Home | no sheet behind Home: `.home { inset: var(--chrome-h) 0 0 0 }`, nothing painted (design style.css:235-237) | `#views` is always a sheet: radius 12 and `--island-float-sheet` (islands.css:186-190), so on Home its shadow outlines one big, near-invisible panel round every card | no (extra panel) | yes (Home alone in front: no sheet, the guest reaches the window's sides and foot) |

## Home: the clock

| element | design value (file:line) | Quartz value (file:line) | match? | after |
|---|---|---|---|---|
| clock box | bare over the picture, no island; `padding: 8px 16px 4px` (design style.css:267-268) | a frosted card: newtab.js marks every `.module[data-kind="card"]`, the clock included, `.frost` (newtab.js:4903-4906); `padding: 4px 0 0` (newtab.css:803-809), so the time touches the card's left edge | no (card) | yes |
| time | `--font-display`, weight 300, `--fs-hero` 84px, line-height .95, letter-spacing -.02em, tabular-nums, `text-shadow: var(--text-lift)` (design style.css:22, 269-272) | weight 600, 44px, line-height 1.1, letter-spacing -.015em, tabular-nums, `--home-shadow` (newtab.css:818-825) | no (size, weight) | yes |
| period (AM/PM) | `--fs-xl` 20px, weight 400, margin-left 8px, letter-spacing 0, `--text-2` (design style.css:273) | `--fs-l` 16px, weight 600, `--text` at opacity .86, flex gap 6px (newtab.css:811-833) | no (size, weight) | yes |
| date | margin-top 8px, `--fs-l` 15px, `--text-2`, `--text-lift` (design style.css:274) | margin-top 8px, `--fs-l` 16px, `--text` at opacity .86, `--home-shadow` (newtab.css:835-845) | partial (size, ink) | yes |
| text lift | `--text-lift: 0 1px 2px rgba(0,14,18,.35), 0 2px 18px rgba(0,14,18,.28)` (design style.css:55) | `--home-shadow: 0 1px 2px rgba(0,0,0,.5), 0 2px 18px rgba(0,0,0,.38)` (newtab.css:78) | no (values) | yes (`--text-lift`) |
| clock, 1024-1279 wide | `--fs-hero: 76px` (design style.css:541-542) | 44px at every width (newtab.css:820) | no (size) | yes |
| clock, under 1024 | `padding-top: 16px` (design style.css:549) | `padding-top: 24px`, centred, full row (newtab.css:2769-2776) | partial (padding) | yes (it now folds into the left rail, as the design) |
| clock, light theme | theme-free: light ink with the dark lift, as in dark (design light.css:6-9; design LIGHT.md §4 "bare text on the picture") | dark ink `#0b0e1a` (tokens.css:183) with a white halo (newtab.css:89) | no (ink) | yes (light ink with the dark lift, over the black Dim as in dark) |

## Home: islands, lift and float

| element | design value (file:line) | Quartz value (file:line) | match? | after |
|---|---|---|---|---|
| island fill | the blurred picture (two copies, 6 and 15 px on a 512 px bitmap; big panels take the soft one) + film `--film` + dim (design style.css:111-118, 734-735; design app.js BLURS) | the same layers: film + wash + `--frost` copy, `.soft` for big panels (newtab.css:3299-3309; frost.js:66) | yes | yes (+ the hover sheen layer) |
| float at rest, token | `--float: 0 1px 1px rgba(0,12,16,.14), 0 8px 18px -6px rgba(0,12,16,.32), 0 30px 56px -26px rgba(0,12,16,.52)` (design style.css:53) | the same value as `--island-float` (tokens.css:130); no `--float` name | partial (name) | yes (`--float`; `--island-float` aliases it) |
| float on hover, token | `--float-hi: 0 2px 2px rgba(0,12,16,.12), 0 14px 26px -8px rgba(0,12,16,.38), 0 44px 72px -28px rgba(0,12,16,.6)` (design style.css:54) | the same value as `--island-float-hi` (tokens.css:131); no `--float-hi` name | partial (name) | yes (`--float-hi`) |
| edge | `--edge: 0 0 0 0 transparent`, no hairline (design style.css:52) | `border-color: transparent` on islands (newtab.css:3306) | yes | yes (`border: 0`) |
| which pieces float | every card (`.card.frost`: now playing, System, Apps, Session, Markets), the search box, Saved tiles, chips, the Edit pencil (design index.html) | cards marked by `.module[data-kind="card"]` and `#search` only (newtab.js:4903): the System card (`.stats`) is an opaque `--home-card` tint with a 1px edge and `--shadow-1` (newtab.css:1209-1225); the lone Apps card likewise (newtab.css:409-416); the Edit pencil is a `--surface-2` pill (newtab.css:631-650) | no (System, Apps, pencil) | yes (System, Apps always its own card, the pencil) |
| hover float | `--float-hi` on a hovered Saved tile and chip (design style.css:350, 368) | `--island-float-hi` on hovered chips and Saved tiles (newtab.css:3350) | yes | yes (+ the 1 / 2 px rise) |
| search focus | `var(--edge), var(--float-hi), 0 0 0 2px var(--accent)` (design style.css:333) | `var(--isl-float), 0 0 0 2px var(--ion)` (newtab.css:3322) | partial (float) | yes (the ring is the user's accent) |
| text on an island | `text-shadow: 0 1px 2px rgba(0,0,0,.22)` on every `.frost` (design style.css:648) | the same value (`--island-text-lift`, tokens.css:145) on `.module.frost` only (newtab.css:3311) | partial (coverage) | yes (every island, the chrome's too) |
| card shape | `.card { border-radius: var(--r-l) 16px; padding: 16px }` (design style.css:121, 41) | `.module { border-radius: var(--radius-l) 14px; padding: 14px 16px; width: 224px }` (newtab.css:782-790; tokens.css:401) | no (radius, padding) | yes (`--look-r-l`, the rail's width) |
| card title | `--fs-s` 12px, weight 600, `--text-2`, letter-spacing .01em, sentence case; head row 28px, margin -4px 0 12px (design style.css:277-278) | Markets: `--fs-2xs` 11px, uppercase, letter-spacing .08em, `--fg-3` (newtab.css:2922-2930); Idle music: `--fs-xs` 12px 600 `--fg-3` (newtab.css:1092-1099) | no (case, ink) | partial (Markets, Idle music yes; System and Apps heads not restyled) |

## Home: layout, wide and narrow

| element | design value (file:line) | Quartz value (file:line) | match? | after |
|---|---|---|---|---|
| Home's box | `inset: 100px 0 0 0; padding: 24px 12px 12px` (design style.css:69, 236-237) | the guest at 12px from the window (`#well` margin, islands.css:181-184) + `.home` padding 0 24px + rails padding 24px 0 (newtab.css:262, 270): content starts 36px from each side | no (edges) | yes (Home alone in front) |
| grid, wide | `grid-template-columns: 296px minmax(0, 640px) 296px; justify-content: space-between; column-gap: 32px; max-width: 1600px; margin: 0 auto` (design style.css:247-253) | `minmax(352px, 1fr) minmax(480px, 720px) minmax(352px, 1fr); column-gap: 32px` (newtab.css:82, 252-263) | no (tracks) | yes |
| rails | flex column, gap 16px; the right rail `align-self: end` (design style.css:254-261) | flex column, gap 16px, padding 24px 0; the right rail's items to the right, Markets `margin-top: auto` (newtab.css:265-274, 404) | partial (padding) | yes (Session sits right above Markets at the foot) |
| centre column | flex column, gap 16px, centred vertically, `min-height: calc(100vh - 100px - 24px - 12px)`, `padding-bottom: 10vh` (design style.css:259-260) | `.stage` padding `clamp(28px, 11vh, 128px) 0 48px`; each row its own top margin (search 18, Saved 32, chips 20, System 28) (newtab.css:276-279, 292, 385) | no (spacing) | yes |
| narrow, 1024-1279 | `--fs-hero: 76px`; columns `280px minmax(0, 640px) 280px`, gap 24px (design style.css:537-544) | at 1295 and under: rails 272px, centre `minmax(0, 1fr)` (newtab.css:2744-2747) | no (breakpoint, tracks) | yes |
| fold, under 1024 | one centred column `minmax(0, 680px)`, order centre / left / right, row gap 16; rails a 2-column grid, gap 16 (design style.css:545-552) | folds at 1023: flex wrap, centre column 720px, rail cards in a wrapping row, gap 16 (newtab.css:2748-2810) | partial (widths) | yes |
| under 720 | System 3 columns; rails one column (design style.css:553-556) | System 3 columns under 620, 2 under 460 (newtab.css:2812-2845) | partial (breakpoints) | yes (Quartz keeps 2 columns under 460) |
| Markets at 1536x864 | inside a 296px rail; the right rail rests at the window's foot (design style.css:249, 261) | 352px wide (`--rail-w`, newtab.css:2908-2910); on the user's 1536x864 screen it ran past the window's right edge and its rows past the bottom | no (width) | yes (296px; not yet seen on screen) |

## Home: the pieces

| element | design value (file:line) | Quartz value (file:line) | match? | after |
|---|---|---|---|---|
| logo | 56px, margin-bottom 4px, `drop-shadow(0 6px 14px rgba(0,12,16,.35))` (design style.css:326-327) | 56px, `drop-shadow(0 1px 2px rgb(0 0 0 / .28))` (newtab.css:294-302) | partial (shadow) | yes (`--logo-lift`) |
| search box | 52px tall pill (radius 999), padding 0 12px 0 20px, gap 12px, icon 18px, `--text-2` (design style.css:328-334) | 44px tall, radius 14px, icon 16px at left 15px (newtab.css:304-345, 3314) | no (size, shape) | yes |
| search text | `--fs-l` 15px, placeholder `--text-3` (design style.css:335-337) | `--fs-l` 16px, placeholder `--text-2` (newtab.css:339, 352) | no (size, ink) | yes |
| search hover | `--sheen: .05` (design style.css:332) | `--home-glass-hover` fill and a stronger hairline (newtab.css:354-359; overridden to transparent by 3315-3321) | partial (none) | yes |
| Saved caption | `--fs-s` 12px, 600, `--text-2`, `--text-lift`, margin 8px 4px (design style.css:340) | `--fs-s` 13px, `--text`, `--home-shadow` (newtab.css:2470-2485) | no (size, ink) | partial (centred over the row; the design's is left over a grid) |
| Saved tiles | 56px square island, radius 14, the name under it; grid `repeat(auto-fill, minmax(72px, 1fr))`, gap 12px 8px (design style.css:341-358) | 30px pill islands with the label inside (newtab.css:2513-2530, 3328) | no (shape) | no (shape: not changed) |
| shortcut chips | 32px pill island, padding 0 14px 0 8px, gap 8px, `--fs-s` 12px, `--text-2`; hover `translateY(-1px)` + `--float-hi` (design style.css:361-369) | 32px pill island, padding 0 14px, `--fs-s` 13px, `--text`; hover `--island-float-hi`, no rise (newtab.css:2381-2395, 3350) | partial (size, ink) | yes (the shadow swaps rather than animating) |
| System card | `.card.frost`, strip 5 columns gap 8px, each stat a `--fill-1` well, radius 10 (design style.css:372-381) | opaque card, 5 columns gap 0 4px, padding 16px 20px (newtab.css:1209-1233) | no (material) | partial (an island now; the stat wells not restyled) |
| Session card | rows 32px; count `--font-display` `--fs-xl` 500; "On" `--ok` `--fs-l` 600; label `--text-2` (design style.css:434-439) | rows 24px; count `--fs-xl` 600; label `--fs-s` `--text-2` (newtab.css:848-875) | partial (rows) | partial ("On" not in the ok colour) |
| Now playing | art 48px radius 10 with a shadow; title `--fs-l` 600; controls 36px round + 44px light disc (design style.css:298-323) | art 48px radius 6; title `--fs-s` 500; 22px controls (newtab.css:900-1030) | no (controls) | partial (no time readout under the bar) |
| Markets card | `.card.frost` in the 296px rail (design index.html, style.css:121) | `.module.frost`, 352px, padding 14px 16px 12px (newtab.css:2908-2912) | no (width) | yes |
| Markets badge | 22px pill, `--fs-xs` 11px, 600, `rgba(143,227,180,.14)` on `--ok`, 6px dot (design style.css:445-447) | a 5px dot and the word, `--fs-2xs`, no fill (newtab.css:2934-2955) | no (pill) | yes (closed / pre / after: a neutral pill) |
| Markets chart box | 92px, radius 10, `rgba(0,0,0,.12)`, inset 1px `--hair`; hover white .06 + inset .16 (design style.css:448-455) | 92px, radius 10, `--chart-box` white .05 (newtab.css:3181-3191; tokens.css:147) | partial (fill) | yes |
| Markets rows | 32px, grid `52px 1fr 64px 60px`, gap 8, padding 0 6px, radius 6, `--text-2`; symbol 600 `--text`; change 600 `--fs-s`; spark 20px; list margin 8px -6px 0 (design style.css:464-480) | 32px flex rows; symbol 46px `--fs-xs` 500; spark 16px; last 56px; change 54px `--fs-xs` (newtab.css:3013-3090, 3194) | partial (grid, type) | yes (+ Quartz's own remove x over the spark) |
| Markets foot | a 28px round `+` control; as-of `--fs-xs` `--text-3`; margin-top 8px (design style.css:302, 481-482) | a 20px square `+`; as-of `--fs-2xs` (newtab.css:3119-3170) | partial (control) | yes |
| Edit pencil | an island pill 40px tall, at 12px from the left and bottom (design style.css:524-535) | a 28px `--surface-2` pill with a hairline, at 16px / 12px (newtab.css:610-650) | no (size, material) | yes |

## Tokens

| element | design value (file:line) | Quartz value (file:line) | match? | after |
|---|---|---|---|---|
| type scale | `--fs-xs` 11, `--fs-s` 12, `--fs-m` 13, `--fs-l` 15, `--fs-xl` 20, `--fs-2xl` 28, `--fs-hero` 84 (design style.css:16-22) | `--fs-2xs` 11, `--fs-xs` 12, `--fs-s` 13, `--fs-m` 14, `--fs-l` 16, `--fs-xl` 20 (tokens.css:427-432): the same names one step apart; 15, 28 and 84 missing | partial (names) | partial (the values as `--look-fs-*`: the names collide) |
| ink over the picture | `--text #eef6f7`, `--text-2/3/4` `rgba(230,242,244,.76/.54/.34)` (design style.css:25-28) | `#ececea`, `#a9aaa7`, `#75767a` (tokens.css:68-70) | no (values) | yes on Home (`--look-text*`); the chrome keeps its own |
| accent | `#a9e7ed` (design style.css:30) | `--ion` `#9fb4cc`, the user's accent (tokens.css:74) | no (user setting) | partial (dark: the steel default or the user's hue; light: the design's `#083f49` by default, see the light table) |
| radii | `--r-xs` 4, `--r-s` 6, `--r-m` 10, `--r-l` 16; islands 12 (design style.css:38-41, 120) | `--radius-xs` 4, `-s` 6, `-m` 10, `-l` 14; `--isl-r` 12 (tokens.css:399-401; islands.css:31) | partial (l) | yes (cards `--look-r-l` 16) |
| motion | `--ease`, `--ease-lift`, `--dur` 160 (design style.css:57-60) | `--m-ease-look`, `--m-ease-lift`, `--m-press` 160 (tokens.css:465-473) | yes | yes |
| reduced motion | every animation and transition 1ms (design style.css:558-561) | catch-all: `--rm-keep` 0.01ms, no transition on elements that declare none (tokens.css:547-560) | yes (equivalent) | yes (the new rises and presses are off under it) |

## The top row, the tabs and the address bar

| element | design value (file:line) | Quartz value (file:line) | match? | after |
|---|---|---|---|---|
| air | `--gap: 12px` (design style.css:68) | `--isl-gap: 12px` (islands.css:18) | yes | yes |
| tab row | 44px (design style.css:131) | `--tab-row-h` 44px (islands.css:23) | yes | yes |
| workspace pill | island pill, margin 6px 0 0 12px, 32px tall, padding 0 8px 0 12px, gap 8, `--fs-s` 12px 600, `--text`; 8px dot (design style.css:654-664) | island pill, 28px tall, padding 0 8px 0 9px, gap 7, `--fs-xs` 12px, `--text-2` (workspaces.css:73-90; islands.css:139) | partial (size, ink) | yes |
| tabs island | 32px tall, padding 3px, gap 2px, margin 6px 0 0 6px (design style.css:132-136) | a plate round the chips plus 4px (islands.js:42, 46-56): 38px tall; chips gap 4px (chrome.css:365) | no (height) | yes (the strip's own box) |
| tab | 26px tall, radius 8, 208px (min 72), padding 0 4px 0 10px, gap 8, `--fs-s` 12px, `--text-2` (design style.css:137-144) | 30px tall, radius 10, max 220px (min 104), padding 0 8px 0 12px, gap 6, `--fs-xs` 12px, `--text-2` (chrome.css:394-420) | partial (height, radius) | yes (26 tall, radius 8, 208px shrinking to 72; collapse-to-icon only on hover or focus, out of the row) |
| tab hover / press | `--fill-1` white .07 / `--fill-press` .05 (design style.css:145-146) | `--isl-fill-1` .07 / `--isl-fill-press` .05 (islands.css:121-122) | yes | yes |
| active-tab highlight | 26px, radius 8, white .16, `inset 0 1px 0 rgba(255,255,255,.16), 0 1px 3px rgba(0,12,16,.25)` (design style.css:149-153) | 30px, radius 8, white .18, the same edge (islands.css:85-99; tokens.css:139-140) | partial (height, alpha) | yes (.16; the written look notes say .18) |
| underline | 16x2px, accent, slides with ease-lift 320ms (design style.css:668-670) | `.tab-ul` 16x2px, accent, 320ms ease-lift (islands.css:100-112) | yes | yes (2px above the chip's foot) |
| new tab, tab search | each its own 32px round island, margin 6px 0 0 6px (design style.css:173-180) | `#newtab` 28px inside the tabs plate (chrome.css:379-384; islands.css:135-136) | no (own island) | yes (the + and the tab-search button each their own 32px island) |
| caption buttons | 46 x 44px, `drop-shadow(0 1px 1px rgba(0,12,16,.4))`, close hover `#c42b1c` (design style.css:184-196) | the same (islands.css:145-149; tokens.css:141-144) | yes | yes |
| tool row | 40px, margin 4px 12px 0, address bar at most 760px centred in the window (design style.css:200-201) | 40px, margin 4px 12px 0, at most 760px centred in the window (islands.css:72-78; islands.js:43) | yes | yes |
| nav and tools islands | padding 4, gap 2; buttons 32px radius 8 `--text-2`; hover `--fill-2`; press scale .94 (design style.css:204-213) | plates padded 4, gap 2; buttons 32px radius 8; hover `--isl-fill-2`; press `--m-press-small` .94 (islands.css:72-78, 150-161) | yes | yes |
| address bar | island 40px, radius 12, padding 0 6px 0 14px, a lead icon, `--fs-m` 13px; placeholder `--text-3` (design style.css:217-231) | `#omnibox.frost` 40px, radius 12, padding 0 14px, `--fs-s` 13px, placeholder `--text-3`, no lead icon (islands.css:163-170; chrome.css:1011-1032) | yes (same px) | partial (no lead icon in the field: the bar is the input itself) |
| address bar focus | `var(--edge), var(--float), 0 0 0 2px var(--accent)` (design style.css:222) | `var(--isl-float), 0 0 0 2px var(--accent)` (islands.css:171) | yes | yes |
| page sheet | inset 100px 12px 12px, radius 14, `0 2px 4px rgba(0,12,16,.18), 0 24px 48px -12px rgba(0,12,16,.45), 0 60px 100px -40px rgba(0,12,16,.6)` (design style.css:485-489) | `#views` radius 12, `--island-float-sheet` with the same shadow (islands.css:181-190; tokens.css:133) | partial (radius) | yes (radius 14) |

## Light theme

| element | design value (file:line) | Quartz value (file:line) | match? | after |
|---|---|---|---|---|
| island ink | on islands only: `--text #0f1e21`, `--text-2/3/4` ink .76/.56/.36, accent `#083f49`, ok `#124028`, down `#6f1813` (design light.css:12-32) | the whole page: `#0b0e1a`, `#333a4e`, `#5b6478`, `--ion #4d6784` (tokens.css:183-188) | partial (values) | yes (Home's islands and the chrome's two rows; the accent: next row) |
| island fills | black .05 / .08 / .12, pressed .04, hair black .08 (design light.css:22-26) | ink .05 / .09, pressed .04 (tokens.css:232-234) | partial (fill-2) | yes |
| accent | `#083f49`, ink on it `#f4f7f8`, hover / pressed `#05313a`, soft .12 (design light.css:17-19, 30; design LIGHT.md §4) | the steel `#4d6784`, white on it (tokens.css:235-244) | no (values) | yes (look-sync v2.2's islands profile in light: `#083f49` / `#05313a` / `#f4f7f8`; soft .11, the shared token's value; a custom hue starts at 189) |
| island fill over the picture | sheen + lift toward `#f4f7f8` by the §4b check (`--lift`) + black dim + the blurred copy (design light.css:37-42; design LIGHT.md §2) | white wash + the blurred copy, no lift: "light keeps today's look" (frost.js:41-44; newtab.css:3303) | no (lift) | yes (frost.js over the vendored `liftAlpha(samples, dim, 'light')`: the film layer is `#f4f7f8` in light, never the dark film; before the copies the flat `#2c5258` ground, lifted .60 at Dim .20) |
| text on an island | `text-shadow: 0 1px 1px rgba(255,255,255,.28)` (design light.css:43) | the dark value in both themes (tokens.css:145) | no (value) | yes |
| dim | a black wash in both themes (design LIGHT.md §3) | a white wash (`--wash-rgb: 255 255 255`, tokens.css:229) and a fixed .2 floor on Home (newtab.css:219-221) | no (colour) | yes (the stored Dim only, black, as dark: no washAlpha, no shared top band, no floor) |
| floats | unchanged from dark (design LIGHT.md §4, light.css:6) | unchanged from dark (tokens.css: no light override) | yes | yes |
| bare text on the picture | light ink with the dark lift (design light.css:6-9) | dark ink with a white halo (newtab.css:89) | no (ink) | yes (the clock, the date, the Saved caption; the caption buttons too, hover white .12) |
| hover sheen | white .16, .12 on the search box, .22 under an open pop-over (design light.css:48-55) | ink .05, big .035 (tokens.css:232-235) | no (direction) | yes |
| tab highlight | white .5, `inset 0 1px 0 rgba(255,255,255,.5), 0 1px 3px rgba(0,12,16,.16)` (design light.css:62-65) | white .55, the dark edge (tokens.css:236; islands.css:96) | partial (alpha) | yes |
| chart wells | white .12, hover white .24 + inset black .12 (design light.css:71-72) | ink .04 / .07 (tokens.css:236-238) | no (direction) | yes |
| play / pause disc | a dark disc `rgba(15,30,33,.92)`, light glyph (design light.css:78-80) | (dark's 22px glyph buttons, no disc) | no (missing) | yes |
| Open badge | the ok tint .08 on white .24 (design light.css:85) | (no pill) | no (missing) | yes |
| the Q on a tab | the one-ink Q in the dark ink `#0f1e21` on the tab island (design light.css:59; design LIGHT.md §4.2) | the light Q (app.js HOME_ICON) | no (ink) | yes (assets/quartz-logo-ink.svg) |

## Cannot match

- **The accent in dark.** The design draws `#a9e7ed`; Quartz's dark accent stays the steel blue `#9fb4cc` or the
  user's own (Settings: a palette or a hue), painted over `--ion`. Light's default is the design's `#083f49` (look-sync
  v2.2's islands profile); a palette or a hue the user picks still wins there. accent-soft is the shared token's .11,
  not the design's .12 (look-sync keeps one light alpha for every profile).
- **The Markets data.** The design's rows, prices and the "SPY 598.12 +0.42%" label in the box are fake; Quartz shows
  the user's real symbols (as many as they keep) from its own feed, and says when it has none.
- **The address bar's lead icon and star inside the field.** Quartz's address bar is the input element itself; its
  icons are separate toolbar controls.

## Seen on screen

look-shots, on a fresh test profile (no media, no Markets key, no app pins, the default Saved and shortcut
sites), against the design's own pictures at the same sizes. Fixed once seen: the Apps card was still drawn
inside the System card on a default Home (the markup had it there); the System card had no head row or stat
wells; the +, the tab search and the workspace pill sat 10px from the tabs instead of 6, and the pill 3px low.

What still differs, both themes unless named:

- **Dark: the wash (fixed).** Quartz's legibility guard used to raise the dark wash from the Dim (.20) to .76
  over this picture. Dark now follows the islands look (look-sync CONTRACT v2, which supersedes washAlpha as
  the tint): the picture is under the stored Dim only (`Backdrop.state().glass`: alpha .20, mode "islands"),
  and each island's brightness check lays its own film (.44 to .68 on the top-row islands over this sky).
  Settings reads "Dim 20%, brightness check per island". Light now paints the same way (below).
- **Dark: the top-row plates read pale (fixed).** The tabs plate, the workspace pill, the + and tab-search
  buttons, the nav plate and the tools plate showed the bare sky with faint glyphs, although frost.js set a
  film of .44 to .68 on them. chrome.css still set the old look's `--sheen` to a gradient on `:root`; the
  island fill reads `--sheen` as an alpha (`rgb(255 255 255 / var(--sheen, 0))`), so in the chrome the whole
  `background` was invalid and every plate painted nothing but its shadow. The address bar only looked right
  because chrome.css's `#omnibox` field (a `--code-bg` fill, a hairline) outranked `.frost`: it was not an
  island either. The gradient is gone and `#omnibox.frost` takes the island fill, so the top row is the
  design's dark, distinct islands (the tab plate's edge, the nav and tools plates read rgb 71 67 65,
  62 58 57 and 73 74 81 at 1536x864, the address bar 67 61 58, beside the bare picture's 135 to 170).
- **Saved row twice (fixed).** On a fresh profile the shortcut chips (most visited, no visits yet) were
  padded out of the same four defaults the Saved row is seeded with, so both rows showed the same sites; a
  profile with visits shows its own top sites there. The padding now skips a default that is already saved.
  The design shows both rows, with different sites in each.
- **The islands' tint.** The design's islands read teal over this picture; Quartz's are the neutral film
  (rgb 10 12 14) over the picture's own colours, so they read grey-mauve.
- **Light: the wash and the lift (fixed).** The light theme used to lay a white wash (washAlpha) over the
  picture, so the picture read washed out, the islands pale grey and the bare clock faint. Light now follows
  LIGHT.md §3 and §4b: the picture under the stored Dim only, black (Backdrop.state().glass: alpha .20, mode
  "islands"), and each island lifted toward `#f4f7f8` by its own check (on the top row over this sky: .00 to
  .52; every Home island lifted). The islands read as the design's pale glass over a darker picture, the
  island ink is `#0f1e21`, and the clock, the date, the Saved caption and the caption buttons keep the light
  ink over the picture. The Home tab's Q is drawn in the island ink.
- **The tab (fixed).** It sized to its title (about 130px for "New tab"); it now starts at the design's 208px
  and shrinks to 72 with the strip (design style.css:139), and its collapse-to-icon button shows only on hover
  or focus, out of the row.
- **The centre column** sits lower than the design's because its content is shorter (pill Saved tiles, an
  empty Apps card, no readings); the centring is the design's.
- **Small:** the Processes control and the Apps card's Edit are plain text where the design has pill
  buttons (the Apps head's hairline is gone); Idle music has no Next button; the workspace pill's "no colour"
  dot is the third ink (dark in light) where the design draws a pale dot; the rest (no media, no Markets
  rows, Session "Off", the market badge) is the test profile's data.

## Not done yet

- **Saved tiles** as the design's 56px squares with the name under them (Quartz draws pills with the label inside).
- **The System card's stat wells** and the System / Apps card heads; the Session card's "On" in the ok colour.
- **Now playing's time readout** ("1:16 / 3:48" under the bar): Quartz's tile shows the position as the bar only.
