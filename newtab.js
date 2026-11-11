/* ============================================================
   newtab.js — the new tab page's own behaviour.

   Quartz's Home, in Helm's Home manner: the Quartz background clear
   and full-bleed, the Q, a search field, the Saved row, the shortcut
   chips and the instrument strip down the middle; the clock and now
   playing in the left rail, the session tile and markets in the right.
   The caret still lands in the address bar on a new tab (the chrome
   does that); the field here is for a click.

   This page runs inside a <webview> guest as a plain file:// page:
   no Electron, no preload, no window.api, no require. Everything
   it does, it does by navigating itself.

   The browser's settings reach it two ways:

     1. query params, for the first paint —
        ?theme=dark&palette=ocean&hue=300&engine=bing&chips=<JSON>&bg=image
        (every param optional; theme, palette and hue are handled
        earlier, in newtab-theme.js, so colour never flashes)

     2. window.__applySettings({ accentHue, palette, searchEngine, chips })
        pushed later with executeJavaScript. A null or missing
        field means "back to this page's own default".

     3. window.__applyBackground({ kind, dim, url, fileName, state, reason })
        pushed the same way, because the picture is a data: URL (or a
        file:// URL of main's copy) and never belongs on the URL; see
        "Background". window.__boardPaused(flag) is the chrome's pause
        hook: it stops the clip while an overlay is over this page.

     4. window.__applyStats(sample) every second while this guest is
        the one on screen — see "the instrument strip" below. The
        sample carries the process list the lower half of the capsule
        shows, and every group of more than one process carries its
        own `children` (one per pid, with the role and, for this
        browser's renderers, the tab it holds) for the row to unfold.

     5. window.__applyEndTask({ key, results }) — the answer to the one
        thing this page asks the browser FOR: a console line,
        `newtab:end-task {"pids":[...],"key":"..."}`, which the chrome
        reads off this guest and runs. There is no preload here, so a
        logged line is the whole channel; see "the process list".

     6. window.__applyApps({ pins, installed }) — the native programs
        pinned into the capsule, and the index the picker filters.
        window.__applyAppsRunning(map) keeps their running lights current
        once a second, and window.__applyAppResult(r) answers the lines
        the dock logs: `newtab:app {"action":"launch"|"focus"|"pin"|
        "unpin"|"refresh",...}`, read off this guest the same way.

     7. window.__applyProcIcons({ key: dataUrl|null }) — the real
        executable's icon for a process group, resolved by the main
        process and pushed whenever an answer comes back. It only
        fills slots the rows already wear; no row is rebuilt for it.

     8. window.__applyMusic({ enabled, playing, source, title, where })
        — the state of the chrome's idle player, pushed on every change
        and when this guest loads. Its three controls answer the same
        way the dock does: `newtab:music {"action":"toggle"|"next"|
        "enable"}`; see "idle music".

     9. window.__applyMedia({ ok, source, title, artist, album, status,
        positionMs, durationMs, art, canNext, canPrev }) — what the
        MACHINE is playing, off the media session the chrome polls. Its
        transport answers the same way: `newtab:media {"cmd":"toggle"|
        "next"|"prev"}`; see "now playing".

    10. window.__applyStocks({ enabled, hasKey, keyState, market, socket,
        offline, lastTickAt, selected, rows, series }) — live prices for
        the bottom-right tile. The ONE push that does not come from the
        chrome: stocks.js in MAIN owns the Finnhub key, the websocket and
        the REST budget, and listens to this guest itself. The tile answers
        on `newtab:stocks {"action":"subscribe"|"unsubscribe"|"select"|
        "add"|"remove"|"refresh","symbol":…}`; see "markets" at the foot of
        this file. The key is never in the payload and never in this page.

    11. window.__applySaved([{ url, label }, …]) — the browser's saved
        list (the bookmarks, Settings.chips()), whole and in stored order,
        drawn as the Saved row under the shortcuts. The row asks for
        changes with `newtab:saved {"op":"add","url":…}` and
        `newtab:saved {"op":"remove","url":…}`, and the chrome answers by
        pushing the list again; see "saved sites". __applyRecent() is
        still defined, as a no-op: it fed the Recent row this replaced.

    12. window.__applyHomeLayout(layout, meta) — which pieces are on the
        Home and where each one was put, whole, from the chrome (rules in
        homelayout.js). Edit mode asks for changes with `newtab:home
        {"op":"hide"|"show"|"place"|"reset",…,"seq":n}` and the chrome
        answers with the layout and meta { ack, ok, reason }; see "Home
        layout and edit mode". ?home=<JSON> is the first-paint copy.
   ============================================================ */

'use strict';

/* The shortcut row, used whenever the browser sends no chips of its own. */
const LINKS = [
  { label: 'GitHub',    url: 'https://github.com' },
  { label: 'YouTube',   url: 'https://www.youtube.com' },
  { label: 'Gmail',     url: 'https://mail.google.com' },
  { label: 'Claude',    url: 'https://claude.ai' },
];

/* Site logos: faviconImg() below, from the tab strip's store. No favicon service. */


/* ------------------------------------------------------------------ */
/* URL handling — only ever validation, never navigation               */
/* ------------------------------------------------------------------ */

function parseUrlOrNull(text) {
  try {
    return new URL(text);
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/* The chip list the chrome sent (null = LINKS). */
let chipList = null;

/** One host, compared the way a person would: case- and www-blind. */
function hostKey(hostname) {
  return String(hostname == null ? '' : hostname).toLowerCase().replace(/^www\./, '');
}

/**
 * Validate one chip list from the chrome. Keeps only entries with an
 * http(s) url; a missing label becomes the bare hostname. Anything that
 * is not an array yields null, meaning "use LINKS".
 */
function normalizeChips(list) {
  if (!Array.isArray(list)) return null;

  const out = [];

  for (const item of list) {
    if (!item || typeof item.url !== 'string') continue;

    const parsed = parseUrlOrNull(item.url.trim());
    if (!parsed) continue;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;

    const host = parsed.hostname.replace(/^www\./i, '');
    const label = (typeof item.label === 'string' && item.label.trim())
      ? item.label.trim()
      : host;

    out.push({ label: label, url: parsed.href, host: parsed.hostname });
  }

  return out;
}

/* LINKS goes through the same validator, so every rendered chip has a host. */
const DEFAULT_CHIPS = normalizeChips(LINKS) || [];

/** Whatever should be on screen right now. */
function currentChips() {
  return chipList || DEFAULT_CHIPS;
}

/** ?chips=<encodeURIComponent(JSON)>. Malformed JSON is ignored, not fatal. */
function parseChipsParam(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : null;
  } catch (err) {
    return null;
  }
}

/* The Saved row below is NOT filtered against these chips, the way the old
   Recent row was. The chips are usually the most-visited sites, so a site
   you visit a lot and then save would vanish from the row the moment you
   saved it — exactly a save that looks like it failed — and the row's x,
   the only way to unsave from this page, would go with it. Showing a site
   twice is the honest cost. */
function setChips(list) {
  chipList = normalizeChips(list);
  renderLinks();
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

const linkRow = document.getElementById('links');

/* What the nav currently shows, so a settings push that changes nothing
   does not rebuild the row (and re-request every favicon). */
let renderedKey = null;

/**
 * One site logo, `size` CSS px (16 unless a surface says otherwise): the tab
 * strip's own tile (pagefavicons.js + tabicons.js). The icon comes from the
 * per-origin store the tabs use, through the chrome; a site with no icon
 * shows the chip's monogram. Never blank, never a broken image, and never a
 * request to a favicon service.
 */
function faviconImg(host, className, size) {
  if (window.PageFavicons) return window.PageFavicons.node(host, size || 16, className);
  // No logo module (a stripped harness): an empty box keeps the layout.
  const box = document.createElement('span');
  box.className = className;
  box.setAttribute('aria-hidden', 'true');
  return box;
}

/** Identity of a chip list, cheap enough to compare on every push. */
function chipsKey(list) {
  return list.map(function (item) { return item.url + ' ' + item.label; }).join('\n');
}

/** Build the shortcut chips from the current list. */
function renderLinks() {
  if (!linkRow) return;

  const list = currentChips();
  const key = chipsKey(list);
  if (key === renderedKey) return;      // nothing moved: leave the DOM alone
  renderedKey = key;

  const frag = document.createDocumentFragment();

  for (const item of list) {
    const chip = document.createElement('a');
    chip.className = 'chip';
    chip.href = item.url;

    if (item.host) chip.appendChild(faviconImg(item.url || item.host, 'chip-icon'));

    chip.appendChild(document.createTextNode(item.label));
    frag.appendChild(chip);
  }

  linkRow.replaceChildren(frag);
}

/* ------------------------------------------------------------------ */
/* Saved sites                                                         */
/*                                                                     */
/* The row under the shortcuts is the browser's one saved list — the    */
/* rows the bookmarks bar draws, the ones Ctrl+D and the address bar's   */
/* star add to (Settings.chips() in the chrome). There is no second      */
/* list here: this page shows that one and asks for changes to it.       */
/*                                                                     */
/*   in    window.__applySaved([{ url, label }, …]) — the WHOLE list,    */
/*         in stored order, on the guest's dom-ready and again on every  */
/*         change. Safe to call any number of times.                    */
/*   out   console.log('newtab:saved {"op":"add","url":…}')              */
/*         console.log('newtab:saved {"op":"remove","url":…}')           */
/*                                                                     */
/* The chrome answers a request ONLY by pushing the list again. So every */
/* request is drawn at once (the new tile dimmed, the removed tile gone) */
/* and then waits SAVED_ANSWER_MS for a push that shows it done. No push */
/* that does means the request did not happen: the tile goes back to    */
/* where it was and the caption says so, in words — a chrome that has    */
/* not been restarted since this row arrived reads the line and does    */
/* nothing with it, and "restart Quartz" is the whole fix.              */
/*                                                                     */
/* Nothing in the row is ever rebuilt wholesale. The caption, the "+",   */
/* its field and the hint are in the markup from the first paint (so    */
/* the row already wears its one-line height before the first push)     */
/* and a push only adds, moves or drops the tiles that changed, so a    */
/* repeated push does not re-request a single favicon.                  */
/*                                                                     */
/* SLICE-START: saved row  (the block below is what the lane harness runs) */
/* ------------------------------------------------------------------ */

/* A push is the user's own list, so it is drawn whole — this is only a
   guard against a runaway payload. Past it the hint counts what was left
   off rather than dropping it quietly. */
const SAVED_ACCEPT = 500;

/* Tiles drawn before the row folds: about two lines in the 720px column.
   Folded, it keeps the NEWEST ones — the end of the stored list — so the
   site you just saved is always on screen, and a button counts the older
   ones it is holding back. */
const SAVED_SHOWN = 12;

/* How long a request waits for the chrome's answering push. */
const SAVED_ANSWER_MS = 2000;

/* How long a fresh page waits for its first push before it says the
   browser never sent the list. The chrome pushes on dom-ready, so this is
   generous; a little longer than the answer wait so a slow first frame
   never trips it. */
const SAVED_FIRST_PUSH_MS = 2500;

/* A neutral note ("already saved") clears itself after this. A failure
   never does: it stays until the next thing you do in the row. */
const SAVED_NOTE_MS = 4000;

/* The validated list from the last push, stored order; null until the
   chrome has pushed one. Each entry: { label, url, raw, host, key }, where
   url is the parsed href the tile links to, raw is the string exactly as
   the chrome stores it (what a remove sends back, so its own comparison
   finds it) and key is savedKey(raw). */
let savedList = null;

/* Pushes seen so far, so a request that timed out can tell "no answer at
   all" from "answered, but without the change". */
let savedPushes = 0;

/* Entries the last push skipped: not an http(s) address, or past
   SAVED_ACCEPT. Counted so the hint can say so. */
let savedSkipped = 0;
let savedOverflow = 0;

/* Requests still waiting for their answer, by key:
   { item, push, timer } — push is savedPushes when it was sent. */
const savedPendingAdd = new Map();
const savedPendingRemove = new Map();

let savedExpanded = false;       // the fold, opened by its button
let savedAddOpen = false;        // the "+" is showing its field
let savedStatusKind = '';        // what the caption's note is about
let savedStatusTimer = 0;
let savedFirstTimer = 0;

/* The row's fixed parts, looked up by wireSaved(). Null until then, and
   every renderer checks, so a push that lands first is simply kept. */
let savedRow = null;
let savedCaption = null;
let savedStatusEl = null;
let savedMoreBtn = null;
let savedAddBtn = null;
let savedForm = null;
let savedInput = null;
let savedHintEl = null;

/* The tiles on screen, by key, so a push reuses the ones it still has. */
const savedTiles = new Map();

/**
 * The chrome's own comparison (Settings.sameUrl): trimmed, case-blind,
 * trailing slashes ignored. Mirrored exactly, so "already saved" and "it
 * landed" mean here what they mean in the store.
 */
function savedKey(url) {
  return String(url == null ? '' : url).trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * Validate one pushed list: [{ url, label }, …] in stored order. http(s)
 * only (the tiles are links this page can open), one tile per key, at most
 * SAVED_ACCEPT. A missing label becomes the bare host, as the store's own
 * fallback does. Sets savedSkipped / savedOverflow for the hint.
 */
function normalizeSaved(list) {
  savedSkipped = 0;
  savedOverflow = 0;
  if (!Array.isArray(list)) return [];

  const out = [];
  const seen = new Set();

  for (const item of list) {
    if (!item || typeof item.url !== 'string' || !item.url.trim()) continue;

    const raw = item.url.trim();
    const parsed = parseUrlOrNull(raw);
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
      savedSkipped++;
      continue;
    }

    const key = savedKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);

    if (out.length >= SAVED_ACCEPT) { savedOverflow++; continue; }

    const label = (typeof item.label === 'string' && item.label.trim())
      ? item.label.trim()
      : hostKey(parsed.hostname);

    out.push({ label: label, url: parsed.href, raw: raw, host: parsed.hostname, key: key });
  }

  return out;
}

/** localhost, 127.x and ::1 are his dashboards: they get http://. */
function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || /\.localhost$/.test(h) || /^127(\.\d{1,3}){3}$/.test(h) ||
    h === '[::1]' || h === '::1';
}

/**
 * What was typed into the "+" field, as one of:
 *   { empty: true }                    nothing there: just close
 *   { error: 'plain sentence' }        not something this row can save
 *   { url, host }                      the href to send
 * A bare "github.com" is an address with the scheme left off, the way the
 * store's own normalizeUrl reads it; "localhost:3000" is a host and a port,
 * not a scheme called localhost.
 */
function parseTypedAddress(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { empty: true };
  if (/\s/.test(raw)) {
    return { error: 'That is not a web address: it has a space in it.' };
  }

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  const hostAndPort = /^[^\/?#:@]+:\d+(?:[\/?#]|$)/.test(raw);
  let candidate = raw;

  if (scheme && !hostAndPort) {
    const name = scheme[1].toLowerCase();
    if (name !== 'http' && name !== 'https') {
      return { error: 'Only web addresses (http or https) can be saved here.' };
    }
  } else {
    const typedHost = raw.split(/[\/?#]/)[0].replace(/^[^@]*@/, '').replace(/:\d+$/, '');
    candidate = (isLoopbackHost(typedHost) ? 'http://' : 'https://') + raw;
  }

  const parsed = parseUrlOrNull(candidate);
  const junk = { error: '“' + raw + '” is not a web address. Try one like github.com.' };
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return junk;

  // The URL parser is forgiving ("1" is the IPv4 0.0.0.1), so the host is
  // checked as it was TYPED: localhost, an address, or name.tld.
  const afterScheme = candidate.replace(/^[a-z][a-z0-9+.-]*:\/*/i, '');
  const typed = afterScheme.split(/[\/?#]/)[0].replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase();
  const plausible =
    isLoopbackHost(typed) ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(typed) ||
    /^\[[0-9a-f:.]+\]$/.test(typed) ||
    (/^[^.]+(\.[^.]+)+\.?$/.test(typed) &&
      /[a-z -￿]/.test(typed.replace(/\.$/, '').split('.').pop()) &&
      typed.replace(/\.$/, '').split('.').pop().length >= 2);
  if (!plausible || !parsed.hostname) return junk;

  return { url: parsed.href, host: parsed.hostname };
}

/** The one way out of this row. */
function sendSaved(msg) {
  console.log('newtab:saved ' + JSON.stringify(msg));
}

/**
 * The list as it should read right now: the last push, minus removals
 * still in flight, plus adds still in flight (dimmed, at the end, where
 * the store appends them).
 */
function savedDisplay() {
  const base = savedList || [];
  const out = [];
  const have = new Set();

  for (const item of base) {
    have.add(item.key);
    if (savedPendingRemove.has(item.key)) continue;
    out.push({ item: item, pending: false });
  }
  savedPendingAdd.forEach(function (p, key) {
    if (!have.has(key)) out.push({ item: p.item, pending: true });
  });

  return out;
}

/** Folded: the newest SAVED_SHOWN. Open, or short enough: all of it. */
function savedShown(display) {
  if (savedExpanded || display.length <= SAVED_SHOWN) return { shown: display, held: 0 };
  const held = display.length - SAVED_SHOWN;
  return { shown: display.slice(held), held: held };
}

/* --- the caption's note --------------------------------------------- */

/**
 * One line in the caption, right of "Saved". tone 'warn' is a failure and
 * stays until replaced; 'note' clears itself. kind names what it is about,
 * so a push can clear "never sent" without touching anything else.
 */
function setSavedStatus(text, tone, kind) {
  if (savedStatusTimer) { clearTimeout(savedStatusTimer); savedStatusTimer = 0; }
  savedStatusKind = text ? (kind || tone || 'note') : '';
  if (savedStatusEl) {
    savedStatusEl.textContent = text || '';
    if (text && tone === 'warn') savedStatusEl.setAttribute('data-tone', 'warn');
    else savedStatusEl.removeAttribute('data-tone');
  }
  if (text && tone !== 'warn') {
    savedStatusTimer = setTimeout(function () {
      savedStatusTimer = 0;
      setSavedStatus('');
    }, SAVED_NOTE_MS);
  }
}

/** Clear the note unless it is about `keep` (still true). */
function clearSavedStatus(keep) {
  if (savedStatusKind && savedStatusKind === keep) return;
  if (savedStatusKind) setSavedStatus('');
}

/* --- requests ----------------------------------------------------- */

/** "+" → Enter. `parsed` is a parseTypedAddress() success. */
function requestSavedAdd(parsed) {
  const key = savedKey(parsed.url);
  const label = hostKey(parsed.host);

  const display = savedDisplay();
  const at = display.findIndex(function (d) { return d.item.key === key; });
  if (at >= 0) {
    // Already in the list (or already on its way): say so and make sure
    // it is on screen, rather than sending a line that changes nothing.
    if (!savedExpanded && at < display.length - SAVED_SHOWN) savedExpanded = true;
    setSavedStatus(label + ' is already saved.', 'note', 'dupe');
    renderSaved();
    return;
  }

  // Re-adding something whose removal is still in flight: the add wins,
  // and the removal stops waiting for an answer that no longer matters.
  const racing = savedPendingRemove.get(key);
  if (racing) { clearTimeout(racing.timer); savedPendingRemove.delete(key); }

  const item = { label: label, url: parsed.url, raw: parsed.url, host: parsed.host, key: key };
  savedPendingAdd.set(key, {
    item: item,
    push: savedPushes,
    timer: setTimeout(function () { savedAddTimedOut(key); }, SAVED_ANSWER_MS)
  });

  clearSavedStatus('nopush');
  sendSaved({ op: 'add', url: parsed.url });
  renderSaved();
}

/** A tile's x (or Delete on the tile). */
function requestSavedRemove(item, refocus) {
  if (savedPendingRemove.has(item.key)) return;

  // Where focus goes once the tile is gone: the tile that slides into its
  // place, or the "+" when it was the last. Only for the keyboard — a
  // mouse that pressed x is already where it wants to be.
  let nextKey = null;
  if (refocus) {
    const shown = savedShown(savedDisplay()).shown;
    const at = shown.findIndex(function (d) { return d.item.key === item.key; });
    const next = shown[at + 1] || shown[at - 1];
    nextKey = next ? next.item.key : null;
  }

  savedPendingRemove.set(item.key, {
    item: item,
    push: savedPushes,
    timer: setTimeout(function () { savedRemoveTimedOut(item.key); }, SAVED_ANSWER_MS)
  });

  clearSavedStatus('nopush');
  sendSaved({ op: 'remove', url: item.raw });
  renderSaved();

  if (refocus) {
    const wrap = nextKey ? savedTiles.get(nextKey) : null;
    const target = wrap ? wrap.querySelector('.rtile') : savedAddBtn;
    if (target && typeof target.focus === 'function') target.focus();
  }
}

function savedAddTimedOut(key) {
  const p = savedPendingAdd.get(key);
  if (!p) return;
  savedPendingAdd.delete(key);
  const name = p.item.label;
  if (savedPushes > p.push) {
    setSavedStatus('Quartz answered but did not save ' + name + '. It may not take that address.', 'warn', 'failed');
  } else {
    setSavedStatus('Quartz did not answer, so ' + name + ' was not saved. Restart Quartz, then try again.', 'warn', 'failed');
  }
  renderSaved();                 // the dimmed tile goes: that is the rollback
}

function savedRemoveTimedOut(key) {
  const p = savedPendingRemove.get(key);
  if (!p) return;
  savedPendingRemove.delete(key);
  const name = p.item.label;
  if (savedPushes > p.push) {
    setSavedStatus('Quartz answered but kept ' + name + '. Try removing it again.', 'warn', 'failed');
  } else {
    setSavedStatus('Quartz did not answer, so ' + name + ' is still saved. Restart Quartz, then try again.', 'warn', 'failed');
  }
  renderSaved();                 // the tile comes back where it was
}

/* --- the "+" field ------------------------------------------------- */

function openSavedAdd() {
  if (!savedForm || !savedInput || savedAddOpen) return;
  savedAddOpen = true;
  clearSavedStatus('nopush');
  savedInput.value = '';
  savedInput.removeAttribute('aria-invalid');
  savedAddBtn.hidden = true;
  savedForm.hidden = false;
  savedInput.focus();
}

/** Escape, blur, or a successful Enter. refocus puts focus back on "+". */
function closeSavedAdd(refocus) {
  if (!savedAddOpen) return;
  savedAddOpen = false;            // first: the focus move below blurs the field
  if (savedStatusKind === 'input') setSavedStatus('');
  savedInput.removeAttribute('aria-invalid');
  savedForm.hidden = true;
  savedAddBtn.hidden = false;
  if (refocus) savedAddBtn.focus();
}

function commitSavedAdd() {
  const parsed = parseTypedAddress(savedInput.value);
  if (parsed.empty) { closeSavedAdd(true); return; }
  if (parsed.error) {
    // The field stays open with what was typed, so it can be fixed.
    savedInput.setAttribute('aria-invalid', 'true');
    setSavedStatus(parsed.error, 'warn', 'input');
    return;
  }
  closeSavedAdd(true);
  requestSavedAdd(parsed);
}

/* --- drawing ------------------------------------------------------ */

/** One tile: the link, and beside it (not inside: no button in an <a>) its x. */
function buildSavedTile(entry) {
  const item = entry.item;

  const wrap = document.createElement('span');
  wrap.className = entry.pending ? 'stile is-pending' : 'stile';

  const link = document.createElement('a');
  link.className = 'rtile';
  link.href = item.url;
  link.title = entry.pending
    ? 'Saving ' + item.label + '…'
    : item.label + ' — ' + item.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  link.appendChild(faviconImg(item.url || item.host, 'rtile-icon'));

  const label = document.createElement('span');
  label.className = 'rtile-label';
  label.appendChild(document.createTextNode(item.label));
  link.appendChild(label);
  wrap.appendChild(link);

  if (entry.pending) {
    link.setAttribute('aria-busy', 'true');
    return wrap;
  }

  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'stile-remove';
  x.title = 'Remove from saved';
  x.setAttribute('aria-label', 'Remove ' + item.label + ' from saved');
  x.appendChild(document.createTextNode('×'));
  x.addEventListener('click', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    // detail 0 is a keyboard press (Enter / Space on the focused x).
    requestSavedRemove(item, ev.detail === 0);
  });
  wrap.appendChild(x);

  link.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Delete') return;
    ev.preventDefault();
    ev.stopPropagation();
    requestSavedRemove(item, true);
  });

  return wrap;
}

/** What a tile's DOM depends on: a change rebuilds that one tile. */
function savedTileSig(entry) {
  return entry.item.url + '\n' + entry.item.label + '\n' + (entry.pending ? 1 : 0);
}

/**
 * Bring the row in line with savedDisplay(). The fixed parts are only
 * re-labelled; tiles are reused by key, moved only when out of place (a
 * moved node loses focus, a node left alone keeps it), and dropped when
 * gone. Safe before wireSaved(): it does nothing until the row exists.
 */
function renderSaved() {
  if (!savedRow || !savedMoreBtn) return;

  const display = savedDisplay();
  const view = savedShown(display);

  // Gone first, so the pass below never steps over a tile on its way out
  // (stepping over one would move every tile after it, focus and all).
  const keep = new Set(view.shown.map(function (entry) { return entry.item.key; }));
  savedTiles.forEach(function (wrap, key) {
    if (keep.has(key)) return;
    if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    savedTiles.delete(key);
  });

  // The tiles sit between the caption and the fold's button, in order.
  let cursor = savedCaption.nextSibling;

  for (const entry of view.shown) {
    const key = entry.item.key;
    const sig = savedTileSig(entry);
    let wrap = savedTiles.get(key);
    if (wrap && wrap.__sig !== sig) {
      const fresh = buildSavedTile(entry);
      fresh.__sig = sig;
      wrap.replaceWith(fresh);
      if (cursor === wrap) cursor = fresh;
      wrap = fresh;
    } else if (!wrap) {
      wrap = buildSavedTile(entry);
      wrap.__sig = sig;
    }
    savedTiles.set(key, wrap);

    if (cursor === wrap) cursor = cursor.nextSibling;
    else savedRow.insertBefore(wrap, cursor);
  }

  // The fold's button: a count of what it holds back, never silent.
  const total = display.length;
  if (view.held > 0) {
    savedMoreBtn.hidden = false;
    savedMoreBtn.textContent = '+' + view.held + ' older';
    savedMoreBtn.setAttribute('aria-expanded', 'false');
    savedMoreBtn.setAttribute('aria-label', 'Show ' + view.held + ' older saved site' + (view.held === 1 ? '' : 's'));
  } else if (savedExpanded && total > SAVED_SHOWN) {
    savedMoreBtn.hidden = false;
    savedMoreBtn.textContent = 'Fewer';
    savedMoreBtn.setAttribute('aria-expanded', 'true');
    savedMoreBtn.setAttribute('aria-label', 'Show only the ' + SAVED_SHOWN + ' newest saved sites');
  } else {
    savedMoreBtn.hidden = true;
  }

  // The hint after the "+": what an empty row is for, and anything the
  // push carried that is not drawn. Not before the first push — an empty
  // list nobody has sent is not "nothing saved".
  const notes = [];
  if (savedList && !total) notes.push('Nothing saved yet. Use + or the star in the address bar.');
  if (savedSkipped) {
    notes.push(savedSkipped + ' saved item' + (savedSkipped === 1 ? ' is' : 's are') +
      ' not a web address and ' + (savedSkipped === 1 ? 'is' : 'are') + ' not shown here.');
  }
  if (savedOverflow) notes.push(savedOverflow + ' more saved sites are past what this row draws.');
  if (savedHintEl) {
    savedHintEl.textContent = notes.join(' ');
    savedHintEl.hidden = !notes.length;
  }

}


/* --- wiring ------------------------------------------------------- */

function wireSaved() {
  savedRow = document.getElementById('saved');
  savedCaption = savedRow ? savedRow.querySelector('.saved-caption') : null;
  savedStatusEl = document.getElementById('saved-status');
  savedMoreBtn = document.getElementById('saved-more');
  savedAddBtn = document.getElementById('saved-add');
  savedForm = document.getElementById('saved-form');
  savedInput = document.getElementById('saved-input');
  savedHintEl = document.getElementById('saved-hint');
  if (!savedRow || !savedCaption || !savedStatusEl || !savedMoreBtn || !savedAddBtn ||
      !savedForm || !savedInput || !savedHintEl) {
    savedRow = null;
    return;
  }

  savedAddBtn.addEventListener('click', openSavedAdd);

  // Enter submits the one-field form; the page must never actually submit
  // (a form with no action reloads this page).
  savedForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    commitSavedAdd();
  });
  savedInput.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape' && ev.key !== 'Esc') return;
    ev.preventDefault();
    ev.stopPropagation();
    closeSavedAdd(true);
  });
  // Blur cancels — when focus went somewhere else on this page. When the
  // whole guest lost focus (a click in the address bar, Alt+Tab to copy the
  // address being saved) the field stays, and focus comes back to it.
  savedInput.addEventListener('blur', function () {
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return;
    closeSavedAdd(false);
  });
  savedInput.addEventListener('input', function () {
    if (savedInput.getAttribute('aria-invalid')) savedInput.removeAttribute('aria-invalid');
    if (savedStatusKind === 'input') setSavedStatus('');
  });

  savedMoreBtn.addEventListener('click', function () {
    savedExpanded = !savedExpanded;
    renderSaved();
  });

  renderSaved();

  // Silence from the chrome is a state too. A push clears this.
  if (!savedList) {
    savedFirstTimer = setTimeout(function () {
      savedFirstTimer = 0;
      if (savedList) return;
      setSavedStatus('Quartz has not sent your saved sites. Restart Quartz to load them.', 'warn', 'nopush');
    }, SAVED_FIRST_PUSH_MS);
  }
}

/**
 * The chrome pushes the whole saved list here, in stored order:
 * __applySaved([{ url, label }]). Every push is also the answer to any
 * request still waiting: an add is done when its key is in the list, a
 * removal when its key is not.
 */
window.__applySaved = function (list) {
  savedList = normalizeSaved(list);
  savedPushes++;

  if (savedFirstTimer) { clearTimeout(savedFirstTimer); savedFirstTimer = 0; }
  if (savedStatusKind === 'nopush') setSavedStatus('');

  const have = new Set(savedList.map(function (item) { return item.key; }));
  savedPendingAdd.forEach(function (p, key) {
    if (!have.has(key)) return;
    clearTimeout(p.timer);
    savedPendingAdd.delete(key);
  });
  savedPendingRemove.forEach(function (p, key) {
    if (have.has(key)) return;
    clearTimeout(p.timer);
    savedPendingRemove.delete(key);
  });

  renderSaved();
};

/** The saved tiles actually on screen, for tests: DOM order, as drawn. */
window.__saved = function () {
  if (!savedRow) return [];
  return Array.prototype.map.call(savedRow.querySelectorAll('.stile'), function (wrap) {
    const link = wrap.querySelector('.rtile');
    const label = wrap.querySelector('.rtile-label');
    return {
      label: label ? label.textContent : '',
      url: link ? link.href : '',
      pending: wrap.classList.contains('is-pending'),
      removable: !!wrap.querySelector('.stile-remove')
    };
  });
};

/** The rest of the row's state, for tests. */
window.__savedState = function () {
  return {
    pushed: savedList !== null,
    pushes: savedPushes,
    count: savedList ? savedList.length : 0,
    skipped: savedSkipped,
    expanded: savedExpanded,
    more: savedMoreBtn && !savedMoreBtn.hidden ? savedMoreBtn.textContent : null,
    adding: savedAddOpen,
    pendingAdd: Array.from(savedPendingAdd.keys()),
    pendingRemove: Array.from(savedPendingRemove.keys()),
    status: savedStatusEl ? savedStatusEl.textContent : '',
    tone: savedStatusEl ? (savedStatusEl.getAttribute('data-tone') || '') : '',
    hint: savedHintEl && !savedHintEl.hidden ? savedHintEl.textContent : ''
  };
};

/* SLICE-END: saved row */

/* ------------------------------------------------------------------ */
/* The clock module                                                    */
/*                                                                     */
/* One timeout, aligned to the next minute, rescheduled from inside     */
/* itself. No setInterval and no per-second tick: nothing on this face  */
/* changes between minutes, and a timer that fires sixty times for one  */
/* repaint is sixty wake-ups of a guest that is often not even on       */
/* screen. A hidden page's timers are throttled, so coming back from    */
/* hidden — or from a restored webview — repaints and re-aligns rather  */
/* than trusting the timer that was asleep.                            */
/* ------------------------------------------------------------------ */

const clockTime = document.getElementById('clock-time');
const clockPeriod = document.getElementById('clock-period');
const clockDate = document.getElementById('clock-date');

let clockTimer = 0;

/** Write only when it actually changed: this runs on every window focus. */
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/**
 * The time as the window's own locale states it, with the meridiem split
 * out: "9:05" + "AM" in a 12-hour locale, "09:05" + "" in a 24-hour one,
 * so the big readout is only ever digits and the AM/PM can sit small
 * beside it.
 */
function clockParts(now) {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
      .formatToParts(now);
    let time = '';
    let period = '';

    for (const part of parts) {
      if (part.type === 'dayPeriod') period = part.value;
      else if (part.type === 'literal' && !part.value.trim()) continue;  // the space before AM
      else time += part.value;
    }

    if (time) return { time: time, period: period };
  } catch (err) {
    /* no Intl, or a locale it cannot build: fall through to 24-hour */
  }

  const m = now.getMinutes();
  return { time: now.getHours() + ':' + (m < 10 ? '0' + m : String(m)), period: '' };
}

/** "Thursday, 11 September" — whichever order the locale puts it in. */
function clockDateText(now) {
  try {
    return now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  } catch (err) {
    return '';
  }
}

function paintClock() {
  const now = new Date();
  const parts = clockParts(now);
  setText(clockTime, parts.time);
  setText(clockPeriod, parts.period);
  setText(clockDate, clockDateText(now));
}

function scheduleClock() {
  if (clockTimer) clearTimeout(clockTimer);
  clockTimer = 0;
  // A clock switched off on the Home keeps no timer at all.
  if (!homePieceVisible('clock')) return;
  const now = new Date();
  // Just after the turn, never on it: a timer that fires a few ms early
  // paints the minute it is already showing and then has to do it twice.
  const wait = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 250;
  clockTimer = setTimeout(function () {
    clockTimer = 0;
    paintClock();
    scheduleClock();
  }, Math.max(250, wait));
}

/** Back on screen: the throttled timer may be up to a minute behind. */
function refreshClock() {
  if (document.hidden) return;
  paintClock();
  scheduleClock();
}

/* ------------------------------------------------------------------ */
/* The session readout                                                 */
/*                                                                     */
/* The chrome pushes it in on every tab change and every status change: */
/*                                                                     */
/*   window.__applyReadout({ tabs, autopause })                         */
/*     tabs       number of open tabs                                   */
/*     autopause  'off' | 'on' | 'holding' | 'unknown'                  */
/*                                                                     */
/* A chrome that still sends `claude` (the Claude session count this   */
/* tile used to show) is ignored: that row is gone from Home.           */
/*                                                                     */
/* The tile is [hidden] until the first call, because a readout of      */
/* dashes is worse than no readout.                                     */
/* ------------------------------------------------------------------ */

const sessionModule = document.getElementById('mod-session');
/* The two counts, so they can stay hidden while the tile is on screen:
   the idle-music module below shares this tile and can be the thing that
   reveals it, and dashes are still worse than no readout. */
const sessionRows = document.getElementById('session-rows');
const readTabs = document.getElementById('read-tabs');
const readTabsLabel = document.getElementById('read-tabs-label');
const readAutopause = document.getElementById('read-autopause');

/* Sentence case, and the only four states the bridge can be in. */
const AUTOPAUSE_TEXT = { off: 'Off', on: 'On', holding: 'Holding', unknown: '--' };

let readoutState = { tabs: null, autopause: 'unknown' };

/** A count, or null for "the chrome did not say". Never negative. */
function readoutCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

function paintReadout() {
  const tabs = readoutState.tabs;

  setText(readTabs, tabs === null ? '--' : String(tabs));
  setText(readTabsLabel, tabs === 1 ? 'tab open' : 'tabs open');
  setText(readAutopause, AUTOPAUSE_TEXT[readoutState.autopause]);
}

window.__applyReadout = function (data) {
  const next = (data && typeof data === 'object') ? data : {};
  const mode = String(next.autopause == null ? 'unknown' : next.autopause).toLowerCase();

  readoutState = {
    tabs: readoutCount(next.tabs),
    autopause: Object.prototype.hasOwnProperty.call(AUTOPAUSE_TEXT, mode) ? mode : 'unknown'
  };
  paintReadout();

  revealSession();
  if (sessionRows) sessionRows.hidden = false;

  return window.__readout();
};

/**
 * Show the tile these two modules share. Both pushes go through here:
 * whichever lands first is what puts the tile on screen.
 */
function revealSession() {
  if (sessionModule && sessionModule.hidden) sessionModule.hidden = false;
}

/** What the readout actually shows, for tests. */
window.__readout = function () {
  return {
    tabs: readoutState.tabs,
    autopause: readoutState.autopause,
    /* The counts, not the tile: idle music can have the tile on screen
       before a readout has ever landed. */
    shown: !!(sessionModule && !sessionModule.hidden &&
              sessionRows && !sessionRows.hidden)
  };
};

/* ------------------------------------------------------------------ */
/* Idle music                                                          */
/*                                                                     */
/* Quiet music while nothing else on the machine is playing. The player */
/* itself lives in the CHROME so it survives tab switches; this module  */
/* is only its face, and it shares the session tile in the right rail.  */
/*                                                                     */
/* In, on every state change and when this guest loads:                 */
/*                                                                     */
/*   window.__applyMusic({ enabled, playing, source, title, where })    */
/*     enabled  the feature is on at all                               */
/*     playing  the chrome is making sound right now                   */
/*     source   'ambient' (the built-in engine) | 'files' (his own)     */
/*     title    the mood name, or the track's name for files           */
/*     where    'newtab' | 'anywhere' — carried through for the chrome  */
/*              and for tests; the module reads the same either way    */
/*                                                                     */
/* Out, one console line the chrome reads off this guest, exactly the   */
/* way end-task and the dock do:                                       */
/*                                                                     */
/*   newtab:music {"action":"toggle"|"next"|"enable"}                   */
/*                                                                     */
/* Never hidden while the tile is up, and shown with an "Off" state and */
/* a control that turns it on — a feature nobody can find is a feature  */
/* nobody has. Cost: no timer, no animation, nothing sampled. A module  */
/* saying "Off" costs one repaint of four fixed boxes, once.            */
/* ------------------------------------------------------------------ */

const musicModule = document.getElementById('mod-music');
const musicState = document.getElementById('music-state');
const musicToggle = document.getElementById('music-toggle');
const musicNext = document.getElementById('music-next');

/* A track name off the disk can be any length; the state line ellipsises
   it in CSS, and this keeps a pathological one out of the DOM at all. */
const MUSIC_TITLE_MAX = 60;

const MUSIC_SOURCES = { ambient: true, files: true };
const MUSIC_WHERE = { newtab: true, anywhere: true };

let musicData = {
  enabled: false,
  playing: false,
  source: 'ambient',
  title: '',
  where: 'newtab'
};

/** One line of text, trimmed and collapsed. '' for "the chrome did not say". */
function musicTitleText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > MUSIC_TITLE_MAX ? text.slice(0, MUSIC_TITLE_MAX - 1) + '…' : text;
}

/** One of the four words the state line can be in. */
function musicStateName() {
  if (!musicData.enabled) return 'off';
  return musicData.playing ? 'playing' : 'paused';
}

/**
 * What the state line says. Playing shows the mood or the track — that is
 * the whole point of the line — and falls back to "Playing" for a chrome
 * that has not named it yet. Off and Paused are the states themselves.
 */
function musicLine() {
  if (!musicData.enabled) return 'Off';
  if (!musicData.playing) return 'Paused';
  return musicData.title || 'Playing';
}

/** The word on the control, and the action it sends. */
function musicAction() {
  if (!musicData.enabled) return { label: 'Turn on', action: 'enable' };
  return musicData.playing
    ? { label: 'Pause', action: 'toggle' }
    : { label: 'Play', action: 'toggle' };
}

/** Next is his own tracks only: there is no next chord in a generative pad. */
function musicHasNext() {
  return !!musicData.enabled && musicData.source === 'files';
}

function paintMusic() {
  const line = musicLine();
  const act = musicAction();

  setText(musicState, line);
  if (musicModule) musicModule.setAttribute('data-music', musicStateName());

  if (musicToggle) {
    setText(musicToggle, act.label);
    musicToggle.setAttribute('data-action', act.action);
    /* The word is the label, so the only thing left to say out loud is
       what it is the word of. */
    musicToggle.setAttribute('aria-label', act.label + ' idle music');
  }

  if (musicNext) {
    const has = musicHasNext();
    // [disabled] is what hides it (visibility, in CSS) and what keeps it
    // out of the tab order: the box stays either way, so the row does not
    // change size when his own tracks come and go.
    musicNext.disabled = !has;
    musicNext.setAttribute('aria-hidden', has ? 'false' : 'true');
  }
}

/** The channel out. One line, the same shape end-task and the dock use. */
function musicSend(action) {
  console.log('newtab:music ' + JSON.stringify({ action: action }));
}

function wireMusic() {
  if (musicToggle) {
    musicToggle.addEventListener('click', function () {
      musicSend(musicAction().action);
    });
  }

  if (musicNext) {
    musicNext.addEventListener('click', function () {
      if (!musicHasNext()) return;
      musicSend('next');
    });
  }

  /* The Off state the markup already wears, painted once so the attribute
     and the control's label come from exactly one place. */
  paintMusic();
}

window.__applyMusic = function (data) {
  const next = (data && typeof data === 'object') ? data : {};

  const source = String(next.source == null ? '' : next.source).toLowerCase();
  const where = String(next.where == null ? '' : next.where).toLowerCase();

  musicData = {
    enabled: !!next.enabled,
    playing: !!next.enabled && !!next.playing,
    source: MUSIC_SOURCES[source] ? source : 'ambient',
    title: musicTitleText(next.title),
    where: MUSIC_WHERE[where] ? where : 'newtab'
  };
  paintMusic();

  /* An idle-music push can be the first thing that lands, so it reveals
     the tile the same way a readout does — with the counts still hidden
     until the chrome has actually counted something. */
  revealSession();

  return window.__music();
};

/** What the module actually shows, for tests. */
window.__music = function () {
  return {
    enabled: musicData.enabled,
    playing: musicData.playing,
    source: musicData.source,
    title: musicData.title,
    where: musicData.where,
    state: musicStateName(),
    line: musicState ? musicState.textContent : '',
    control: musicToggle ? musicToggle.textContent : '',
    action: musicAction().action,
    next: musicHasNext(),
    shown: !!(sessionModule && !sessionModule.hidden)
  };
};

/* ------------------------------------------------------------------ */
/* Now playing                                                         */
/*                                                                     */
/* What the MACHINE is playing, and its transport. Nothing plays in     */
/* this page: the chrome polls the Spotify auto-pause bridge, which     */
/* already holds a Windows media session, and pushes the state in       */
/* while a new tab is in front.                                        */
/*                                                                     */
/*   window.__applyMedia({ ok, source, title, artist, album, status,    */
/*                         positionMs, durationMs, art,                 */
/*                         canNext, canPrev })                          */
/*     ok          the bridge answered at all                           */
/*     status      'playing' | 'paused' | 'stopped' | 'none'            */
/*     art         base64 JPEG (or a data: URL), or null                */
/*     canNext     the session offers that control                      */
/*                                                                     */
/* Out, one console line the chrome reads off this guest, exactly the   */
/* way idle music and the dock do:                                     */
/*                                                                     */
/*   newtab:media {"cmd":"toggle"|"next"|"prev"}                        */
/*                                                                     */
/* Cost: the only thing running in here is the hairline, stepped four   */
/* times a second while something is PLAYING and stopped dead the       */
/* moment it is not — a transform on one element, so no layout and no   */
/* paint of anything else. The position is interpolated from the last   */
/* push rather than polled for, which is what lets the chrome poll the  */
/* bridge as slowly as it does; paused, the fill keeps the width it     */
/* had and nothing ticks at all. The art is decoded once per distinct   */
/* image, not once per push.                                           */
/* ------------------------------------------------------------------ */

const mediaModule = document.getElementById('mod-media');
const mediaArt = document.getElementById('media-art');
const mediaTitle = document.getElementById('media-title');
const mediaArtist = document.getElementById('media-artist');
const mediaFill = document.getElementById('media-fill');
const mediaPrev = document.getElementById('media-prev');
const mediaToggle = document.getElementById('media-toggle');
const mediaNext = document.getElementById('media-next');

/* A title off a media session can be any length; both lines ellipsise in
   CSS, and this keeps a pathological one out of the DOM at all. */
const MEDIA_TEXT_MAX = 80;

/* How often the hairline is stepped while playing. 250ms is a third of a
   pixel on a three-minute track — smooth at this width, and four style
   writes a second on a composited transform. */
const MEDIA_TICK_MS = 250;

/* The two states the tile has a face for; everything else is "nothing". */
const MEDIA_LIVE = { playing: true, paused: true };

let mediaData = {
  ok: false,
  source: '',
  title: '',
  artist: '',
  album: '',
  status: 'none',
  positionMs: 0,
  durationMs: 0,
  art: null,
  canNext: false,
  canPrev: false
};

/* When positionMs was true, so the fill can be interpolated from it. */
let mediaAt = 0;
/* The art string the <img> is currently showing: the stand-in for the
   bridge's artHash on this side, and what keeps one decode per image. */
let mediaArtKey = null;
let mediaTimer = 0;

/** One line of text, trimmed and collapsed. '' for "the session did not say". */
function mediaText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > MEDIA_TEXT_MAX ? text.slice(0, MEDIA_TEXT_MAX - 1) + '…' : text;
}

/** Milliseconds, never negative and never a guess. */
function mediaMs(value) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/**
 * 'playing' | 'paused' | 'none'. A session with no title is nothing
 * playing however healthy it says it is: a tile with an empty first line
 * is worse than one that says so.
 */
function mediaState() {
  if (!mediaData.ok) return 'none';
  if (!MEDIA_LIVE[mediaData.status]) return 'none';
  if (!mediaData.title) return 'none';
  return mediaData.status;
}

/** How far through, 0..1. Interpolated only while it is playing. */
function mediaFraction(now) {
  const dur = mediaData.durationMs;
  if (!(dur > 0)) return 0;
  let pos = mediaData.positionMs;
  if (mediaState() === 'playing') pos += Math.max(0, now - mediaAt);
  if (pos < 0) pos = 0;
  if (pos > dur) pos = dur;
  return pos / dur;
}

/* scaleX on a positioned fill: the one way to move it that costs no
   layout. Written only when it actually changed. */
function paintMediaFill() {
  if (!mediaFill) return;
  const next = 'scaleX(' + mediaFraction(performance.now()).toFixed(4) + ')';
  if (mediaFill.style.transform !== next) mediaFill.style.transform = next;
}

/** One decode per distinct image, and none at all with no art. */
function paintMediaArt() {
  if (!mediaArt) return;
  const art = mediaState() === 'none' ? null : mediaData.art;

  if (!art) {
    if (mediaArtKey !== null) {
      // removeAttribute, never src='': an empty src is a request for this
      // page's own URL.
      mediaArt.removeAttribute('src');
      mediaArtKey = null;
    }
    mediaArt.hidden = true;
    return;
  }

  if (art !== mediaArtKey) {
    mediaArtKey = art;
    mediaArt.src = art.slice(0, 5) === 'data:' ? art : 'data:image/jpeg;base64,' + art;
  }
  mediaArt.hidden = false;
}

function paintMedia() {
  const state = mediaState();
  const live = state !== 'none';

  if (mediaModule) mediaModule.setAttribute('data-media', state);
  setText(mediaTitle, live ? mediaData.title : 'Nothing playing');
  setText(mediaArtist, live ? mediaData.artist : '');
  paintMediaArt();

  if (mediaToggle) {
    // [disabled] is what hides a control (visibility, in CSS) and what keeps
    // it out of the tab order: the box stays either way, so the transport is
    // the same size with nothing playing as with a full session.
    mediaToggle.disabled = !live;
    mediaToggle.setAttribute('aria-label', state === 'playing' ? 'Pause' : 'Play');
  }
  if (mediaPrev) mediaPrev.disabled = !(live && mediaData.canPrev);
  if (mediaNext) mediaNext.disabled = !(live && mediaData.canNext);

  paintMediaFill();
}

/** The hairline runs while something plays, and nowhere else. */
function scheduleMediaTick() {
  const want = mediaState() === 'playing' && mediaData.durationMs > 0 &&
               !document.hidden && homePieceVisible('media');
  if (want && !mediaTimer) mediaTimer = setInterval(paintMediaFill, MEDIA_TICK_MS);
  else if (!want && mediaTimer) { clearInterval(mediaTimer); mediaTimer = 0; }
}

/** Back on screen, or gone: the tick follows the page. */
function refreshMedia() {
  if (!document.hidden) paintMediaFill();
  scheduleMediaTick();
}

/** The channel out. One line, the same shape idle music and the dock use. */
function mediaSend(cmd) {
  console.log('newtab:media ' + JSON.stringify({ cmd: cmd }));
}

function wireMedia() {
  const hit = function (el, cmd) {
    if (!el) return;
    el.addEventListener('click', function () {
      // A hidden control is not a control: [disabled] already stops the
      // click, and this is the same guard idle music's Next keeps.
      if (el.disabled) return;
      mediaSend(cmd);
    });
  };

  hit(mediaPrev, 'prev');
  hit(mediaToggle, 'toggle');
  hit(mediaNext, 'next');

  /* The "nothing playing" state the markup already wears, painted once so
     the attribute, the two lines and the three controls come from exactly
     one place. */
  paintMedia();
}

window.__applyMedia = function (data) {
  const next = (data && typeof data === 'object') ? data : {};
  const status = String(next.status == null ? '' : next.status).toLowerCase();
  const art = (typeof next.art === 'string' && next.art) ? next.art : null;

  mediaData = {
    /* A push with no `ok` at all is a push from something that answered:
       only an explicit false is the bridge saying it could not. */
    ok: (next.ok === undefined || next.ok === null) ? true : !!next.ok,
    source: mediaText(next.source),
    title: mediaText(next.title),
    artist: mediaText(next.artist),
    album: mediaText(next.album),
    status: MEDIA_LIVE[status] ? status : 'none',
    positionMs: mediaMs(next.positionMs),
    durationMs: mediaMs(next.durationMs),
    art: art,
    canNext: !!next.canNext,
    canPrev: !!next.canPrev
  };
  mediaAt = performance.now();

  paintMedia();
  scheduleMediaTick();

  /* The tile is [hidden] until the chrome pushes for the first time: a
     machine with no bridge never gets a tile at all. */
  if (mediaModule && mediaModule.hidden) mediaModule.hidden = false;

  return window.__media();
};

/** What the module actually shows, for tests. */
window.__media = function () {
  return {
    state: mediaState(),
    title: mediaTitle ? mediaTitle.textContent : '',
    artist: mediaArtist ? mediaArtist.textContent : '',
    source: mediaData.source,
    album: mediaData.album,
    art: !!(mediaArt && !mediaArt.hidden && mediaArt.getAttribute('src')),
    artBytes: mediaArtKey ? mediaArtKey.length : 0,
    fill: mediaFill ? mediaFill.style.transform : '',
    fraction: Number(mediaFraction(performance.now()).toFixed(4)),
    ticking: !!mediaTimer,
    controls: {
      prev: !!(mediaPrev && !mediaPrev.disabled),
      toggle: !!(mediaToggle && !mediaToggle.disabled),
      next: !!(mediaNext && !mediaNext.disabled)
    },
    glyph: mediaState() === 'playing' ? 'pause' : 'play',
    shown: !!(mediaModule && !mediaModule.hidden)
  };
};

/* ------------------------------------------------------------------ */
/* The instrument strip                                                 */
/*                                                                      */
/* Five readouts where the search field used to be. The chrome samples   */
/* the machine in the main process and pushes one object in every two    */
/* seconds with window.__applyStats(sample):                             */
/*                                                                      */
/*   { t, cpu:{percent,cores}, mem:{usedBytes,totalBytes,percent},       */
/*     disk:{percent,readBps,writeBps}, net:{downBps,upBps},             */
/*     gpu:{percent}, uptimeSec }                                       */
/*                                                                      */
/* A null field means "this machine cannot say", and shows a dash for    */
/* good — the strip never guesses and never interpolates.                */
/*                                                                      */
/* Cost: there is no timer and no requestAnimationFrame anywhere in      */
/* here. A sample landing is the only thing that repaints the five       */
/* canvases, so a page nobody is pushing to costs exactly nothing. The   */
/* other two repaints are a theme flip and a resize, both one-shot.      */
/* ------------------------------------------------------------------ */

/* The chrome asks this before it subscribes: a page that did not want
   stats would set it false and the sampler would never start. */
window.__statsWanted = true;

const STAT_SAMPLES = 60;         // one minute of history at one per second
const DASH = '—';

/* The floor the network graph is scaled against, so an idle link draws a
   flat line near the bottom instead of amplifying its own noise to full
   height. 131072 bytes/s is 1 Mb/s. */
const NET_FLOOR_BPS = 131072;

const statText = {
  cpu:     document.getElementById('st-cpu'),
  mem:     document.getElementById('st-mem'),
  disk:    document.getElementById('st-disk'),
  netDown: document.getElementById('st-net-down'),
  netUp:   document.getElementById('st-net-up'),
  gpu:     document.getElementById('st-gpu')
};

const statCanvas = {
  cpu:  document.getElementById('sg-cpu'),
  mem:  document.getElementById('sg-mem'),
  disk: document.getElementById('sg-disk'),
  net:  document.getElementById('sg-net'),
  gpu:  document.getElementById('sg-gpu')
};

/* One array of numbers-or-null per graph, oldest first, capped at
   STAT_SAMPLES. The net series is down + up: the two rates are stated
   separately in the text, and the graph is the link's total traffic. */
const statSeries = { cpu: [], mem: [], disk: [], net: [], gpu: [] };

/** A finite number in [0,100], or null. */
function pctOrNull(value) {
  if (value == null || typeof value !== 'number' || !isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

/** A finite number >= 0, or null. */
function rateOrNull(value) {
  if (value == null || typeof value !== 'number' || !isFinite(value)) return null;
  return Math.max(0, value);
}

function pctText(value) {
  return value == null ? DASH : Math.round(value) + '%';
}

/** "8.9 / 15.8 GB", both halves in GiB so they agree with Task Manager. */
function memText(mem) {
  const used = mem ? rateOrNull(mem.usedBytes) : null;
  const total = mem ? rateOrNull(mem.totalBytes) : null;
  if (used == null || total == null || !total) return DASH;
  const gb = 1073741824;
  return (used / gb).toFixed(1) + ' / ' + (total / gb).toFixed(1) + ' GB';
}

/**
 * A byte rate as BITS per second — Kb/s, Mb/s, Gb/s — which is the unit a
 * link is quoted in and the one Task Manager's network graph uses. The
 * label under the readout says "(bits/s)" so the b is never ambiguous.
 */
function bitsText(bytesPerSec, word) {
  const bytes = rateOrNull(bytesPerSec);
  if (bytes == null) return DASH;

  const bits = bytes * 8;
  let n = bits / 1000;
  let unit = 'Kb/s';

  if (bits >= 1e9) { n = bits / 1e9; unit = 'Gb/s'; }
  else if (bits >= 1e6) { n = bits / 1e6; unit = 'Mb/s'; }

  const figure = (n >= 100) ? String(Math.round(n)) : n.toFixed(1);
  return figure + ' ' + unit + ' ' + word;
}

/** Append one reading, oldest off the front. */
function pushSample(series, value) {
  series.push(value);
  while (series.length > STAT_SAMPLES) series.shift();
}

/** The largest reading in a series, ignoring the nulls. 0 for none. */
function seriesPeak(series) {
  let peak = 0;
  for (const value of series) {
    if (value != null && value > peak) peak = value;
  }
  return peak;
}

/**
 * One history graph. Newest sample at the right edge, so the line grows
 * in from the right and then scrolls, the way every meter on this machine
 * draws one. Two strokes and no more: a hairline baseline in --edge, and
 * the series in --ion over a 10% fill of the same colour.
 *
 * The canvas backing store is sized in device pixels, and the baseline is
 * snapped to the device grid, so the hairline is one real pixel rather
 * than a two-pixel smear on a 1.5x display.
 */
function paintGraph(canvas, series, scaleMax, edge, ion) {
  if (!canvas || typeof canvas.getContext !== 'function') return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth || canvas.width || 120));
  const h = Math.max(1, Math.round(canvas.clientHeight || canvas.height || 28));
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));

  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;

  const c = canvas.getContext('2d');
  if (!c) return;

  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);

  // The baseline sits on the last device row, centred in it.
  const base = (ph - 0.5) / dpr;
  const top = 1;                            // the peak never touches the lid
  const span = Math.max(1, base - top);

  c.lineWidth = 1 / dpr;
  c.strokeStyle = edge;
  c.beginPath();
  c.moveTo(0, base);
  c.lineTo(w, base);
  c.stroke();

  const max = scaleMax > 0 ? scaleMax : 1;
  const step = (w - 2) / (STAT_SAMPLES - 1);
  const first = w - 1 - (series.length - 1) * step;

  // Every run of consecutive readings is its own shape: a machine that
  // stopped reporting for a while leaves a gap, not a straight line
  // across the missing minutes.
  const runs = [];
  let run = null;

  for (let i = 0; i < series.length; i++) {
    const value = series[i];
    if (value == null) { run = null; continue; }
    if (!run) { run = []; runs.push(run); }
    run.push({
      x: first + i * step,
      y: base - Math.max(0, Math.min(1, value / max)) * span
    });
  }

  if (!runs.length) return;

  c.fillStyle = ion;
  c.globalAlpha = 0.10;

  for (const points of runs) {
    if (points.length < 2) continue;        // a single dot has no area
    c.beginPath();
    c.moveTo(points[0].x, base);
    for (const p of points) c.lineTo(p.x, p.y);
    c.lineTo(points[points.length - 1].x, base);
    c.closePath();
    c.fill();
  }

  c.globalAlpha = 1;
  c.strokeStyle = ion;
  c.lineWidth = 1;                          // 1 CSS px: the one accent here
  c.lineJoin = 'round';
  c.lineCap = 'round';

  for (const points of runs) {
    c.beginPath();
    c.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) c.lineTo(points[i].x, points[i].y);
    c.stroke();
  }
}

/** All five, once. The only caller that runs often is a landing sample. */
function paintStats() {
  const style = getComputedStyle(document.documentElement);
  const edge = style.getPropertyValue('--edge').trim() || 'rgba(255,255,255,.11)';
  const ion = style.getPropertyValue('--ion').trim() || '#72adca';

  paintGraph(statCanvas.cpu, statSeries.cpu, 100, edge, ion);
  paintGraph(statCanvas.mem, statSeries.mem, 100, edge, ion);
  paintGraph(statCanvas.disk, statSeries.disk, 100, edge, ion);
  paintGraph(statCanvas.net, statSeries.net,
    Math.max(NET_FLOOR_BPS, seriesPeak(statSeries.net)), edge, ion);
  paintGraph(statCanvas.gpu, statSeries.gpu, 100, edge, ion);
}

/**
 * The chrome pushes one sample here. Everything it does is append, write
 * six strings and repaint five small canvases — no layout changes, because
 * every box in the strip is sized by CSS.
 */
window.__applyStats = function (sample) {
  // Switched off on the Home: the chrome stops sending these, and one that
  // was already on its way is not drawn into a card nobody can see.
  if (!homePieceVisible('stats')) return window.__stats();
  const s = sample || {};

  const cpu = s.cpu ? pctOrNull(s.cpu.percent) : null;
  const memPct = s.mem ? pctOrNull(s.mem.percent) : null;
  const disk = s.disk ? pctOrNull(s.disk.percent) : null;
  const gpu = s.gpu ? pctOrNull(s.gpu.percent) : null;
  const down = s.net ? rateOrNull(s.net.downBps) : null;
  const up = s.net ? rateOrNull(s.net.upBps) : null;

  pushSample(statSeries.cpu, cpu);
  pushSample(statSeries.mem, memPct);
  pushSample(statSeries.disk, disk);
  pushSample(statSeries.gpu, gpu);
  pushSample(statSeries.net, (down == null && up == null) ? null : (down || 0) + (up || 0));

  setText(statText.cpu, pctText(cpu));
  setText(statText.mem, memText(s.mem));
  setText(statText.disk, pctText(disk));
  setText(statText.netDown, bitsText(down, 'down'));
  setText(statText.netUp, bitsText(up, 'up'));
  setText(statText.gpu, pctText(gpu));

  paintStats();
  applyProcs(s.procs);
  return window.__stats();
};

/** What the strip actually shows, for tests. */
window.__stats = function () {
  return {
    cpu: statText.cpu ? statText.cpu.textContent : null,
    mem: statText.mem ? statText.mem.textContent : null,
    disk: statText.disk ? statText.disk.textContent : null,
    netDown: statText.netDown ? statText.netDown.textContent : null,
    netUp: statText.netUp ? statText.netUp.textContent : null,
    gpu: statText.gpu ? statText.gpu.textContent : null,
    samples: statSeries.cpu.length
  };
};

/* ------------------------------------------------------------------ */
/* The process list                                                     */
/*                                                                      */
/* The same sample carries `procs: { top: [group...], total: n }`, one   */
/* group per program — `{ key, name, count, pids, cpu, memBytes,        */
/* ioBps, self, children, childrenMore, childrenNote }` — already summed */
/* and already sorted by the sampler. `children` is one entry per pid,   */
/* memory-heaviest first, `{ pid, cpu, memBytes, ioBps, role, label,     */
/* url }`: the answer to "Electron (12), which one is the 1.5 GB tab".   */
/*                                                                      */
/* Three rules hold this together:                                      */
/*                                                                      */
/*  - A row is a DOM node with a life of its own, found by `key`. A      */
/*    sample writes into its text nodes and, if the order changed,       */
/*    moves the node. Nothing is rebuilt, so a row you are hovering, a   */
/*    confirm you have armed and a note that is still showing all        */
/*    survive the second they land in.                                   */
/*  - A group of more than one process UNFOLDS: its chevron, or the row  */
/*    itself (never its End task), lays one indented row per process     */
/*    under it, memory-heaviest first, each named by what it is — and    */
/*    this browser's own renderers by the tab they hold. Which groups    */
/*    are open is remembered by key. A child row is kept and reused by   */
/*    pid exactly the way a group row is kept by key.                    */
/*  - The list is folded into the capsule under the strip. Closed, the   */
/*    capsule is the height it always was; open, it grows by the fold    */
/*    and pushes the dock below it down. The state                       */
/*    is remembered — he opens this all the time — and restored          */
/*    without animation.                                                 */
/*  - A sample that lands while it is closed is KEPT and not drawn. The  */
/*    page costs the same as it did before this existed until someone    */
/*    opens it.                                                          */
/*  - The page cannot end a task itself. It logs a line and waits: the   */
/*    chrome is the only thing here holding a kill.                      */
/* ------------------------------------------------------------------ */

const PROC_ROWS = 10;            // the body's height, in rows
const PROC_MAX = 30;             // what "Show more" opens it to
const PROC_PIDS_MAX = 64;        // the chrome refuses a longer list
const PROC_SORT_STORE = 'newtab.procs.sort';
const PROC_CONFIRM_MS = 3000;    // an armed End task disarms itself
const PROC_NOTE_MS = 3000;       // and the answer it got fades

const PROC_OPEN_STORE = 'newtab.procs.open';

const PROC_CHILD_STORE = 'procsExpandedKeys';  // which groups are unfolded
const PROC_CHILD_MAX = 24;       // what the sampler sends, mirrored here
const PROC_CHILD_KEYS_MAX = 40;  // remembered keys, so storage cannot creep

const procsPanel = document.getElementById('procs');
const procsWrap = document.getElementById('procs-wrap');
const procsBody = document.getElementById('procs-body');
const procsMore = document.getElementById('procs-more');
const procsOpenBtn = document.getElementById('procs-open');
const statsPanel = document.getElementById('stats');
const procSortBtn = {
  cpu: document.getElementById('proc-sort-cpu'),
  mem: document.getElementById('proc-sort-mem')
};

/* key -> { row, label, count, cpu, mem, io, end, note, pids, ... } */
const procRows = new Map();

/* key -> Map pid -> the child row that process owns, kept the same way. */
const procChildRows = new Map();

/* The group keys whose children are showing, restored in wireProcs(). */
let procChildOpen = new Set();

let procGroups = [];             // the last sample's groups, normalised
let procReady = false;           // a sample has landed at least once
let procExpanded = false;        // "Show more" is open
let procOpen = false;            // the panel is up (never remembered)
let procSort = 'cpu';            // 'cpu' | 'mem', restored below

/** The sort the user last chose. A page with no storage keeps CPU. */
function readProcSort() {
  try {
    return localStorage.getItem(PROC_SORT_STORE) === 'mem' ? 'mem' : 'cpu';
  } catch (err) {
    return 'cpu';
  }
}

function writeProcSort(value) {
  try {
    localStorage.setItem(PROC_SORT_STORE, value);
  } catch (err) {
    /* a page denied storage still sorts, it just forgets */
  }
}

/* --- which groups are unfolded ------------------------------------- */
/* Remembered by key, not by index: the list re-sorts every second, and
   the thing the user unfolded has to still be unfolded when it moves. */

/** The keys the last session left open. A page with no storage opens none. */
function readProcChildOpen() {
  try {
    const raw = localStorage.getItem(PROC_CHILD_STORE);
    if (!raw) return new Set();
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return new Set();
    return new Set(list
      .filter(function (key) { return typeof key === 'string' && key; })
      .slice(0, PROC_CHILD_KEYS_MAX));
  } catch (err) {
    return new Set();
  }
}

function writeProcChildOpen() {
  try {
    localStorage.setItem(
      PROC_CHILD_STORE,
      JSON.stringify(Array.from(procChildOpen).slice(0, PROC_CHILD_KEYS_MAX))
    );
  } catch (err) {
    /* a page denied storage still unfolds, it just forgets */
  }
}

/** What a child row calls its role. Anything unlisted keeps its own word. */
const PROC_ROLE_WORDS = {
  main: 'main',
  renderer: 'renderer',
  gpu: 'GPU',
  audio: 'audio',
  network: 'network',
  utility: 'utility',
  pending: 'reading…',
  unknown: 'unknown'
};

/** ...and what it says when you rest on it, for the two that are states. */
const PROC_ROLE_TITLES = {
  pending: 'Reading this process’s command line…',
  unknown: 'The command line could not be read — another user’s process, '
    + 'or it exited while the browser was asking.'
};

/** A finite number >= 0, or null — the same rule the strip uses. */
function procNum(value) {
  if (value == null || typeof value !== 'number' || !isFinite(value)) return null;
  return Math.max(0, value);
}

/** "7.3%" under ten, "12%" above it: one decimal only where it reads. */
function procCpuText(value) {
  const n = procNum(value);
  if (n == null) return DASH;
  return n < 10 ? n.toFixed(1) + '%' : Math.round(n) + '%';
}

/** "482.4 MB", "1.4 GB" — Task Manager's units, one decimal. */
function procMemText(bytes) {
  const n = procNum(bytes);
  if (n == null) return DASH;
  const mb = n / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb.toFixed(1) + ' MB';
}

/** The group's disk + network bytes a second, as KB/s or MB/s. */
function procIoText(bps) {
  const n = procNum(bps);
  if (n == null) return DASH;
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB/s' : (n / 1024).toFixed(1) + ' KB/s';
}

/** One group from the sample, with everything this page will trust. */
function normalizeGroup(group) {
  if (!group || typeof group !== 'object') return null;

  const key = String(group.key || group.name || '');
  if (!key) return null;

  const pids = Array.isArray(group.pids)
    ? group.pids.filter(function (pid) {
        return typeof pid === 'number' && isFinite(pid) && pid > 0;
      }).slice(0, PROC_PIDS_MAX)
    : [];

  const count = (typeof group.count === 'number' && group.count > 1)
    ? Math.round(group.count)
    : (pids.length > 1 ? pids.length : 1);

  return {
    key: key,
    name: String(group.name || key),
    count: count,
    pids: pids,
    cpu: procNum(group.cpu),
    memBytes: procNum(group.memBytes),
    ioBps: procNum(group.ioBps),
    self: group.self === true,
    children: normalizeChildren(group.children),
    childrenMore: (typeof group.childrenMore === 'number' && group.childrenMore > 0)
      ? Math.round(group.childrenMore)
      : 0,
    childrenNote: typeof group.childrenNote === 'string' ? group.childrenNote : ''
  };
}

/**
 * The processes inside one group. The sampler already sorted them by
 * memory and already capped them; this only refuses what it cannot draw.
 */
function normalizeChildren(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (let i = 0; i < list.length && out.length < PROC_CHILD_MAX; i++) {
    const child = list[i];
    if (!child || typeof child !== 'object') continue;
    const pid = child.pid;
    if (typeof pid !== 'number' || !isFinite(pid) || pid <= 0) continue;
    out.push({
      pid: Math.round(pid),
      cpu: procNum(child.cpu),
      memBytes: procNum(child.memBytes),
      ioBps: procNum(child.ioBps),
      role: typeof child.role === 'string' ? child.role : '',
      label: typeof child.label === 'string' ? child.label : '',
      url: typeof child.url === 'string' ? child.url : ''
    });
  }
  return out;
}

/** Biggest first, on the chosen column, with the other as the tiebreak. */
function procCompare(a, b) {
  const first = procSort === 'mem' ? 'memBytes' : 'cpu';
  const second = procSort === 'mem' ? 'cpu' : 'memBytes';
  const fa = a[first] == null ? -1 : a[first];
  const fb = b[first] == null ? -1 : b[first];
  if (fb !== fa) return fb - fa;
  const sa = a[second] == null ? -1 : a[second];
  const sb = b[second] == null ? -1 : b[second];
  if (sb !== sa) return sb - sa;
  return a.name.localeCompare(b.name);
}

/* --- the program's own icon ---------------------------------------- */
/* The chrome resolves the icon of the real executable behind a group and
   pushes `{ key: dataUrl|null }` here. Every row wears a 16px slot left
   of its name from the moment it is built — the dashed placeholder rows
   too — so an icon that lands three seconds late moves nothing. A known
   dataUrl becomes one <img> whose src is written ONCE per key; anything
   else keeps the neutral window outline. No row is ever rebuilt for an
   icon, and a repeated answer for a key already shown touches nothing. */

const SVG_NS = 'http://www.w3.org/2000/svg';
const PROC_ICON_MAX = 300;       // the same cap the main process keeps
const procIcons = new Map();     // key -> dataUrl | null

/** The neutral glyph: one window outline, hairline, no fill. */
function buildProcGlyph() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'proc-icon-glyph');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const box = document.createElementNS(SVG_NS, 'rect');
  box.setAttribute('x', '2.5');
  box.setAttribute('y', '3.5');
  box.setAttribute('width', '11');
  box.setAttribute('height', '9');
  box.setAttribute('rx', '1');
  box.setAttribute('fill', 'none');
  box.setAttribute('stroke', 'currentColor');
  box.setAttribute('stroke-width', '1');

  const bar = document.createElementNS(SVG_NS, 'path');
  bar.setAttribute('d', 'M2.5 6.5h11');
  bar.setAttribute('fill', 'none');
  bar.setAttribute('stroke', 'currentColor');
  bar.setAttribute('stroke-width', '1');

  svg.appendChild(box);
  svg.appendChild(bar);
  return svg;
}

/** The slot: 16px wide whatever is in it, built with the row, never removed. */
function buildProcIconSlot() {
  const slot = document.createElement('span');
  slot.className = 'proc-icon';
  slot.setAttribute('aria-hidden', 'true');
  return slot;
}

/**
 * Put whatever is known for this row's key in its slot. Called once when
 * the row is built and again only for the keys an answer actually names,
 * so a sample costs nothing here. `rec.iconSrc` is the guard: a key whose
 * src is already written is left completely alone — no attribute is
 * touched a second time, and an icon that is up is never taken away.
 */
function syncRowIcon(rec) {
  if (!rec || !rec.icon) return;

  const known = procIcons.get(rec.key);
  const url = (typeof known === 'string' && known) ? known : '';

  if (url) {
    if (rec.iconSrc === url) return;            // written once per key
    if (!rec.iconImg) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.draggable = false;
      rec.iconImg = img;
    }
    rec.iconSrc = url;
    rec.iconImg.src = url;
    if (rec.iconGlyph && rec.iconGlyph.parentNode === rec.icon) {
      rec.icon.removeChild(rec.iconGlyph);
      rec.iconGlyph = null;
    }
    if (rec.iconImg.parentNode !== rec.icon) rec.icon.appendChild(rec.iconImg);
    return;
  }

  if (rec.iconSrc) return;                      // an icon stays where it is
  if (rec.iconGlyph) return;                    // the glyph is already there
  rec.iconGlyph = buildProcGlyph();
  rec.icon.appendChild(rec.iconGlyph);
}

/** Whatever the chrome has resolved so far, merged and worn in place. */
window.__applyProcIcons = function (map) {
  if (map && typeof map === 'object') {
    Object.keys(map).forEach(function (raw) {
      const key = String(raw);
      const value = map[raw];
      procIcons.set(key, (typeof value === 'string' && value) ? value : null);
      const rec = procRows.get(key);
      if (rec) syncRowIcon(rec);
    });

    // Insertion order is oldest first: drop from the front, never a row's own.
    while (procIcons.size > PROC_ICON_MAX) {
      const oldest = procIcons.keys().next();
      if (oldest.done) break;
      procIcons.delete(oldest.value);
    }
  }
  return procIcons.size;
};

function procCell(className) {
  const cell = document.createElement('span');
  cell.className = 'proc-col ' + className;
  cell.setAttribute('role', 'cell');
  return cell;
}

/**
 * One row, built once. Everything a sample writes later is a text node
 * already in place, so an update is six string writes and nothing else.
 */
function buildRow(group) {
  const row = document.createElement('div');
  row.className = 'proc-row';
  row.setAttribute('role', 'row');
  row.dataset.key = group.key;

  const name = procCell('proc-name');
  const chev = buildProcChevron();
  const icon = buildProcIconSlot();
  const label = document.createTextNode('');
  const count = document.createElement('span');
  count.className = 'proc-count';
  name.appendChild(chev);
  name.appendChild(icon);
  name.appendChild(label);
  name.appendChild(count);

  const cpu = procCell('proc-cpu');
  const mem = procCell('proc-mem');
  const io = procCell('proc-io');
  const act = procCell('proc-act');

  const end = document.createElement('button');
  end.type = 'button';
  end.className = 'proc-end';
  end.textContent = 'End task';
  act.appendChild(end);

  const note = document.createElement('span');
  note.className = 'proc-note';

  row.appendChild(name);
  row.appendChild(cpu);
  row.appendChild(mem);
  row.appendChild(io);
  row.appendChild(act);
  row.appendChild(note);        // laid over the row's right end, not a column

  const rec = {
    key: group.key,
    row: row,
    label: label,
    count: count,
    chev: chev,
    icon: icon,
    iconImg: null,
    iconGlyph: null,
    iconSrc: '',
    cpu: cpu,
    mem: mem,
    io: io,
    end: end,
    note: note,
    name: '',
    pids: [],
    self: false,
    expandable: false,
    chevOpen: false,
    chevName: '',
    confirmTimer: 0,
    noteTimer: 0
  };

  end.addEventListener('click', function () { armEnd(rec); });

  // The way in is the whole row, because a 12px chevron is a poor target —
  // but End task is a control sitting ON the row, and a press of it must
  // never also unfold what is under it.
  chev.addEventListener('click', function (event) {
    event.stopPropagation();
    toggleChildren(rec);
  });
  row.addEventListener('click', function (event) {
    // End task, and the answer it leaves lying over the row, are controls.
    if (event.target && event.target.closest && event.target.closest('.proc-end, .proc-note')) return;
    toggleChildren(rec);
  });

  syncRowIcon(rec);              // whatever is already known, worn at once
  return rec;
}

/**
 * The unfold control: a 12px caret drawn in borders, the same way the sort
 * header draws its own. A button, so the keyboard reaches it; hidden (but
 * still holding its width) on a group of one process, which has nothing
 * under it to show.
 */
function buildProcChevron() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'proc-chev';
  btn.setAttribute('aria-expanded', 'false');
  btn.tabIndex = -1;             // set to 0 by updateRow once it does something
  return btn;
}

function procRowFor(group) {
  let rec = procRows.get(group.key);
  if (!rec) {
    rec = buildRow(group);
    procRows.set(group.key, rec);
  }
  return rec;
}

/** The six writes. setText only touches a node whose text actually moved. */
function updateRow(rec, group) {
  rec.pids = group.pids;
  rec.self = group.self;

  if (rec.name !== group.name) {
    rec.name = group.name;
    rec.label.nodeValue = group.name;
    rec.end.setAttribute('aria-label', 'End task, ' + group.name);
  }

  setText(rec.count, group.count > 1 ? '(' + group.count + ')' : '');
  setText(rec.cpu, procCpuText(group.cpu));
  setText(rec.mem, procMemText(group.memBytes));
  setText(rec.io, procIoText(group.ioBps));

  rec.row.classList.toggle('is-self', group.self);
  rec.row.classList.remove('is-blank');

  // One process is already its own row: nothing to unfold, and a chevron
  // that opens an empty list is worse than no chevron. It keeps its width
  // all the same, so every name in the column starts in the same place.
  rec.expandable = group.count > 1;
  rec.row.classList.toggle('can-open', rec.expandable);
  const open = rec.expandable && procChildOpen.has(rec.key);
  if (rec.chev.disabled !== !rec.expandable) {
    rec.chev.disabled = !rec.expandable;
    rec.chev.tabIndex = rec.expandable ? 0 : -1;
  }
  rec.chev.classList.toggle('is-open', open);
  if (rec.chevOpen !== open || rec.name !== rec.chevName) {
    rec.chevOpen = open;
    rec.chevName = rec.name;
    rec.chev.setAttribute('aria-expanded', open ? 'true' : 'false');
    rec.chev.setAttribute('aria-label',
      (open ? 'Hide the processes in ' : 'Show the processes in ') + group.name);
  }
  rec.row.classList.toggle('is-open', open);

  // This browser is stated like anything else and offered no control:
  // there is nothing sensible on the other side of that button.
  const offered = !group.self && rec.pids.length > 0;
  if (rec.end.hidden === offered) rec.end.hidden = !offered;
  if (!offered) disarmEnd(rec);
}

/* --- the processes inside a group ---------------------------------- */
/* Kept by pid the way the group rows are kept by key: the same element
   is rewritten every second and MOVED when the order changes, so the
   list under a group is as still as the list above it. */

/** Open or close one group. Cheap: the fold's own height never moves. */
function toggleChildren(rec) {
  if (!rec.expandable) return;

  if (procChildOpen.has(rec.key)) {
    procChildOpen.delete(rec.key);
  } else {
    procChildOpen.add(rec.key);
    // Nothing is ever open by accident forever: the oldest key falls out.
    while (procChildOpen.size > PROC_CHILD_KEYS_MAX) {
      const oldest = procChildOpen.values().next();
      if (oldest.done) break;
      procChildOpen.delete(oldest.value);
    }
  }

  writeProcChildOpen();
  // The body is a fixed height that scrolls, so unfolding changes nothing
  // outside it.
  renderProcs();
}

/** The record store for one group's children, made on first use. */
function childStore(key) {
  let store = procChildRows.get(key);
  if (!store) { store = new Map(); procChildRows.set(key, store); }
  return store;
}

/**
 * One process's row: the same five columns as its group, indented, with
 * the role where the icon sits and the name of what it holds beside it.
 */
function buildChildRow(child) {
  const row = document.createElement('div');
  row.className = 'proc-row proc-child';
  row.setAttribute('role', 'row');
  row.dataset.pid = String(child.pid);

  const name = procCell('proc-name');
  const role = document.createElement('span');
  role.className = 'proc-role';
  const label = document.createElement('span');
  label.className = 'proc-child-label';
  const pid = document.createElement('span');
  pid.className = 'proc-pid';
  name.appendChild(role);
  name.appendChild(label);
  name.appendChild(pid);

  const cpu = procCell('proc-cpu');
  const mem = procCell('proc-mem');
  const io = procCell('proc-io');
  const act = procCell('proc-act');   // End task is the group's, not a child's

  row.appendChild(name);
  row.appendChild(cpu);
  row.appendChild(mem);
  row.appendChild(io);
  row.appendChild(act);

  return {
    pid: child.pid,
    row: row,
    role: role,
    label: label,
    pidCell: pid,
    cpu: cpu,
    mem: mem,
    io: io,
    title: ''
  };
}

function childRowFor(store, child) {
  let rec = store.get(child.pid);
  if (!rec) {
    rec = buildChildRow(child);
    store.set(child.pid, rec);
  }
  return rec;
}

/** The writes, the same shape as updateRow's: only what actually moved. */
function updateChildRow(rec, child) {
  // hasOwnProperty, not a bare lookup: the role is a word off a command
  // line, and `constructor` must read as the word it is, not as Object's.
  const known = Object.prototype.hasOwnProperty.call(PROC_ROLE_WORDS, child.role);
  setText(rec.role, known ? PROC_ROLE_WORDS[child.role] : (child.role || ''));
  setText(rec.label, child.label);
  setText(rec.pidCell, String(child.pid));
  setText(rec.cpu, procCpuText(child.cpu));
  setText(rec.mem, procMemText(child.memBytes));
  setText(rec.io, procIoText(child.ioBps));

  rec.row.classList.toggle('has-label', !!child.label);
  rec.row.classList.toggle('is-unknown', child.role === 'unknown' || child.role === 'pending');

  // The whole url, the state of a role that is not one, and the pid — the
  // things the row has no room for but a person sometimes wants.
  const parts = [];
  if (child.label) parts.push(child.label);
  if (child.url) parts.push(child.url);
  if (Object.prototype.hasOwnProperty.call(PROC_ROLE_TITLES, child.role)) {
    parts.push(PROC_ROLE_TITLES[child.role]);
  }
  parts.push('pid ' + child.pid);
  const title = parts.join('\n');
  if (rec.title !== title) {
    rec.title = title;
    rec.row.title = title;
  }
}

/* key -> the one note row that group's unfold may end with. */
const procChildNotes = new Map();

/**
 * The last row under a group, when there is something to say: what the
 * list left out, or why it could not read the rest. One element per
 * group, rewritten rather than remade, like every other row here.
 */
function noteRowFor(key, text) {
  let rec = procChildNotes.get(key);
  if (!rec) {
    const row = document.createElement('div');
    row.className = 'proc-row proc-child proc-child-note';
    row.setAttribute('role', 'row');
    const cell = procCell('proc-name');
    row.appendChild(cell);
    rec = { row: row, cell: cell, text: '' };
    procChildNotes.set(key, rec);
  }
  if (rec.text !== text) {
    rec.text = text;
    setText(rec.cell, text);
  }
  return rec.row;
}

/** Forget everything one group's unfold was holding. */
function dropChildRows(key) {
  const store = procChildRows.get(key);
  if (store) {
    store.forEach(function (rec) {
      if (rec.row.parentNode) rec.row.parentNode.removeChild(rec.row);
    });
    procChildRows.delete(key);
  }
  const note = procChildNotes.get(key);
  if (note) {
    if (note.row.parentNode) note.row.parentNode.removeChild(note.row);
    procChildNotes.delete(key);
  }
}

/**
 * The elements one group contributes, in order: its own row, then its
 * children while it is open. Returns them rather than placing them, so
 * renderProcs keeps one diff over one flat list.
 */
function childElements(rec, group) {
  const out = [];
  if (!rec.expandable || !procChildOpen.has(group.key)) {
    dropChildRows(group.key);                 // closed: the records go too
    return out;
  }

  const store = childStore(group.key);
  const live = new Set();

  for (let i = 0; i < group.children.length; i++) {
    const child = group.children[i];
    const childRec = childRowFor(store, child);
    updateChildRow(childRec, child);
    live.add(child.pid);
    out.push(childRec.row);
  }

  store.forEach(function (childRec, pid) {
    if (live.has(pid)) return;
    if (childRec.row.parentNode) childRec.row.parentNode.removeChild(childRec.row);
    store.delete(pid);
  });

  // Whatever the list left out or could not read is STATED. A silent gap
  // between "(12)" and eight rows is exactly the thing this page refuses.
  let note = '';
  if (!group.children.length) {
    note = group.childrenNote || 'No detail for these processes in this sample';
  } else if (group.childrenMore > 0) {
    note = '+' + group.childrenMore + ' smaller '
      + (group.childrenMore === 1 ? 'process' : 'processes') + ' not listed';
    if (group.childrenNote) note += ' · ' + group.childrenNote;
  } else if (group.childrenNote) {
    note = group.childrenNote;
  }
  if (note) {
    out.push(noteRowFor(group.key, note));
  } else {
    const stale = procChildNotes.get(group.key);   // nothing to say any more
    if (stale) {
      if (stale.row.parentNode) stale.row.parentNode.removeChild(stale.row);
      procChildNotes.delete(group.key);
    }
  }

  return out;
}

/** A dashed row: what the list is before the first sample lands. */
function buildBlankRow() {
  const row = document.createElement('div');
  row.className = 'proc-row is-blank';
  row.setAttribute('role', 'row');

  const name = procCell('proc-name');
  const chev = buildProcChevron();         // nothing to unfold, but the width
  chev.disabled = true;
  name.appendChild(chev);
  name.appendChild(buildProcIconSlot());   // empty, but the same 24px wide
  name.appendChild(document.createTextNode(DASH));
  const cpu = procCell('proc-cpu');
  cpu.textContent = DASH;
  const mem = procCell('proc-mem');
  mem.textContent = DASH;
  const io = procCell('proc-io');
  io.textContent = DASH;
  const act = procCell('proc-act');

  row.appendChild(name);
  row.appendChild(cpu);
  row.appendChild(mem);
  row.appendChild(io);
  row.appendChild(act);
  return row;
}

function renderBlank() {
  if (!procsBody) return;
  if (procsBody.childElementCount === PROC_ROWS &&
      procsBody.firstElementChild &&
      procsBody.firstElementChild.classList.contains('is-blank')) return;

  procsBody.textContent = '';
  for (let i = 0; i < PROC_ROWS; i++) procsBody.appendChild(buildBlankRow());
}

/** The header: which column is sorted, and the caret that says so. */
function syncProcHead() {
  ['cpu', 'mem'].forEach(function (which) {
    const btn = procSortBtn[which];
    if (!btn) return;
    const active = procSort === which;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-sort', active ? 'descending' : 'none');
  });
}

/** "Show more" keeps its box when there is nothing more: see the note. */
function syncProcMore() {
  if (!procsMore) return;
  const more = procGroups.length > PROC_ROWS;
  procsMore.classList.toggle('is-idle', !more);
  procsMore.disabled = !more;
  setText(procsMore, procExpanded ? 'Show less' : 'Show more');
  procsMore.setAttribute('aria-expanded', procExpanded ? 'true' : 'false');
}

/**
 * Place the visible rows in order. Nodes are MOVED, never remade: a row
 * that was third and is now first is the same element, so its text does
 * not flash and a confirm armed on it stays armed.
 */
function renderProcs() {
  if (!procsBody || !procOpen) return;   // closed: the sample is kept, not drawn

  syncProcHead();

  if (!procReady) {
    renderBlank();
    syncProcMore();
    return;
  }

  const sorted = procGroups.slice().sort(procCompare);
  const visible = sorted.slice(0, procExpanded ? PROC_MAX : PROC_ROWS);

  // One flat list of the elements this sample should leave in the body: a
  // group row, then the rows it is unfolded into, then the next group. The
  // diff below is the same one as before — it just runs over this list
  // instead of over `visible`, so a child row is placed, moved and dropped
  // by exactly the rules its parent is.
  const expected = [];
  for (let i = 0; i < visible.length; i++) {
    const rec = procRowFor(visible[i]);
    updateRow(rec, visible[i]);
    expected.push(rec.row);
    const kids = childElements(rec, visible[i]);
    for (let k = 0; k < kids.length; k++) expected.push(kids[k]);
  }

  for (let i = 0; i < expected.length; i++) {
    const at = procsBody.children[i];
    if (at !== expected[i]) procsBody.insertBefore(expected[i], at || null);
  }

  // Whatever is left past the visible list: the blank rows on the first
  // sample, and any row this sample pushed out of sight.
  while (procsBody.childElementCount > expected.length) {
    procsBody.removeChild(procsBody.lastElementChild);
  }

  // Forget a program the sample no longer lists at all. A row that is
  // merely below the fold keeps its record, so it comes back as itself.
  const live = new Set(procGroups.map(function (group) { return group.key; }));
  procRows.forEach(function (rec, key) {
    if (live.has(key)) return;
    if (rec.confirmTimer) clearTimeout(rec.confirmTimer);
    if (rec.noteTimer) clearTimeout(rec.noteTimer);
    if (rec.row.parentNode) rec.row.parentNode.removeChild(rec.row);
    procRows.delete(key);
    dropChildRows(key);        // and everything it was unfolded into
  });

  syncProcMore();
}

function applyProcs(procs) {
  if (!procs || !Array.isArray(procs.top)) return;

  // Cheap either way: one map over at most thirty small objects. The DOM
  // work below it only happens while somebody is looking.
  procGroups = procs.top
    .map(normalizeGroup)
    .filter(function (group) { return group !== null; })
    .slice(0, PROC_MAX);

  procReady = true;
  renderProcs();
}

/* --- the fold ------------------------------------------------------ */

/** What the last tab left. A page with no storage starts closed. */
function readProcOpen() {
  try {
    return localStorage.getItem(PROC_OPEN_STORE) === '1';
  } catch (err) {
    return false;
  }
}

function writeProcOpen(open) {
  try {
    localStorage.setItem(PROC_OPEN_STORE, open ? '1' : '0');
  } catch (err) {
    /* a page denied storage still folds, it just forgets */
  }
}

/**
 * Open or close the fold. `animate === false` is the restore on load: the
 * page wears last session's state from the first frame instead of
 * unfolding in front of whoever opened the tab.
 */
function setProcsOpen(open, animate) {
  if (!statsPanel || !procsPanel) return;

  const next = !!open;
  const changed = next !== procOpen;
  procOpen = next;

  if (animate === false && procsWrap) {
    procsWrap.classList.add('no-anim');
    // Read the box back so the class lands in its own style pass: without
    // this the browser coalesces both and the fold animates anyway.
    void procsWrap.offsetHeight;
  }

  statsPanel.classList.toggle('is-procs-open', next);
  if (procsOpenBtn) procsOpenBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
  // Nothing inside a closed fold is reachable, by pointer or by tab.
  if (procsWrap) procsWrap.inert = !next;

  if (animate === false && procsWrap) {
    void procsWrap.offsetHeight;
    procsWrap.classList.remove('no-anim');
  }

  if (next) {
    renderProcs();               // the rows this page has been keeping
  } else {
    // Whatever was armed or showing on a row does not survive the close.
    procRows.forEach(function (rec) {
      disarmEnd(rec);
      if (rec.noteTimer) {
        clearTimeout(rec.noteTimer);
        rec.noteTimer = 0;
        rec.row.classList.remove('has-note');
      }
    });
  }

  if (changed) writeProcOpen(next);
}

function toggleProcs() {
  setProcsOpen(!procOpen, true);
}

/* --- End task ----------------------------------------------------- */

function disarmEnd(rec) {
  if (rec.confirmTimer) {
    clearTimeout(rec.confirmTimer);
    rec.confirmTimer = 0;
  }
  rec.end.classList.remove('is-confirm');
  setText(rec.end, 'End task');
}

/**
 * Two presses, three seconds apart at most. The first arms the row and
 * says what the second does; the second logs the line and lets go. The
 * page never learns whether it worked — __applyEndTask does.
 */
function armEnd(rec) {
  if (rec.self || !rec.pids.length) return;

  if (rec.confirmTimer) {
    disarmEnd(rec);
    console.log('newtab:end-task ' + JSON.stringify({
      pids: rec.pids.slice(0, PROC_PIDS_MAX),
      key: rec.key
    }));
    return;
  }

  setText(rec.end, 'Confirm');
  rec.end.classList.add('is-confirm');
  rec.confirmTimer = setTimeout(function () {
    rec.confirmTimer = 0;
    rec.end.classList.remove('is-confirm');
    setText(rec.end, 'End task');
  }, PROC_CONFIRM_MS);
}

/** What a row says after the chrome answered. */
function endTaskNote(results) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return 'No change';

  const failed = list.filter(function (r) { return !r || r.ok !== true; });
  if (!failed.length) return 'Ended';

  const reason = String((failed[0] && failed[0].reason) || '');
  if (reason === 'self') return "That's this browser";
  if (reason === 'protected') return 'Protected';
  if (!reason) return 'Not ended';
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

function showNote(rec, text) {
  rec.note.textContent = text;
  rec.row.classList.add('has-note');
  if (rec.noteTimer) clearTimeout(rec.noteTimer);
  rec.noteTimer = setTimeout(function () {
    rec.noteTimer = 0;
    rec.row.classList.remove('has-note');
    rec.note.textContent = '';
  }, PROC_NOTE_MS);
}

/**
 * The chrome's answer to one logged line: an array of { pid, ok, reason }.
 * Returns the note it wrote, so a test can read it without racing the
 * three-second timer.
 */
window.__applyEndTask = function (data) {
  const d = data || {};
  const text = endTaskNote(d.results);
  const rec = procRows.get(String(d.key));
  if (rec) showNote(rec, text);
  return text;
};

/** What the list actually shows, for tests. */
window.__procs = function () {
  const column = document.querySelector('.column');
  const panel = procsPanel ? procsPanel.getBoundingClientRect() : null;
  return {
    open: procOpen,
    sort: procSort,
    expanded: procExpanded,
    ready: procReady,
    total: procGroups.length,
    foldHeight: panel ? panel.height : 0,
    panel: panel ? { top: panel.top, left: panel.left, width: panel.width, height: panel.height } : null,
    bodyHeight: procsBody ? procsBody.getBoundingClientRect().height : 0,
    capsuleHeight: statsPanel ? statsPanel.getBoundingClientRect().height : 0,
    columnHeight: column ? column.getBoundingClientRect().height : 0,
    open_keys: Array.from(procChildOpen),
    rows: Array.prototype.map.call(procsBody ? procsBody.children : [], function (row) {
      const end = row.querySelector('.proc-end');
      const note = row.querySelector('.proc-note');
      const slot = row.querySelector('.proc-icon');
      const chev = row.querySelector('.proc-chev');
      const role = row.querySelector('.proc-role');
      return {
        key: row.dataset.key || null,
        pid: row.dataset.pid ? Number(row.dataset.pid) : null,
        child: row.classList.contains('proc-child'),
        childNote: row.classList.contains('proc-child-note'),
        role: role ? role.textContent : null,
        label: row.querySelector('.proc-child-label')
          ? row.querySelector('.proc-child-label').textContent
          : null,
        title: row.title || null,
        chev: chev ? (chev.disabled ? 'off' : (chev.classList.contains('is-open') ? 'open' : 'shut')) : null,
        icon: slot
          ? (slot.querySelector('img') ? 'img'
            : (slot.querySelector('svg') ? 'glyph' : 'empty'))
          : null,
        name: row.querySelector('.proc-name') ? row.querySelector('.proc-name').textContent : '',
        // A note row is one cell wide, so these three can be absent.
        cpu: row.querySelector('.proc-cpu') ? row.querySelector('.proc-cpu').textContent : null,
        mem: row.querySelector('.proc-mem') ? row.querySelector('.proc-mem').textContent : null,
        io: row.querySelector('.proc-io') ? row.querySelector('.proc-io').textContent : null,
        self: row.classList.contains('is-self'),
        blank: row.classList.contains('is-blank'),
        end: end ? (end.hidden ? null : end.textContent) : null,
        note: (note && row.classList.contains('has-note')) ? note.textContent : null,
        height: row.getBoundingClientRect().height
      };
    })
  };
};

/** What the page knows about icons, for tests. */
window.__procIcons = function () {
  let known = 0;
  procIcons.forEach(function (value) { if (value) known++; });
  return { entries: procIcons.size, known: known, rows: procRows.size };
};

function wireProcs() {
  procSort = readProcSort();
  procChildOpen = readProcChildOpen();
  syncProcHead();

  ['cpu', 'mem'].forEach(function (which) {
    const btn = procSortBtn[which];
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (procSort === which) return;
      procSort = which;
      writeProcSort(which);
      renderProcs();
    });
  });

  if (procsMore) {
    procsMore.addEventListener('click', function (event) {
      event.stopPropagation();   // the strip behind it toggles the fold
      procExpanded = !procExpanded;
      if (!procExpanded) procsBody.scrollTop = 0;
      if (procsPanel) procsPanel.classList.toggle('is-expanded', procExpanded);
      renderProcs();
    });
  }

  // The way in: the word, and the whole strip behind it. A button is what
  // the keyboard reaches (Enter and Space are its own), the strip is what
  // the mouse hits — but a click inside the open fold is a click on the
  // list, never on the thing holding it.
  if (procsOpenBtn) {
    procsOpenBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      toggleProcs();
    });
  }

  if (statsPanel) {
    statsPanel.addEventListener('click', function (event) {
      if (procsPanel && procsPanel.contains(event.target)) return;
      // The app dock lives in the capsule too, and a press on a tile is
      // meant for the tile: the panel behind it does not also fold.
      if (dockSection && dockSection.contains(event.target)) return;
      toggleProcs();
    });
  }

  // Escape belongs to the fold only while you are inside it: this page has
  // no overlay, and a key that collapses a list you are not in is a key
  // that ate something else's Escape.
  document.addEventListener('keydown', function (event) {
    if (!procOpen || !procsPanel) return;
    if (event.key !== 'Escape' && event.key !== 'Esc') return;
    if (!procsPanel.contains(document.activeElement)) return;
    event.preventDefault();
    setProcsOpen(false, true);
    if (procsOpenBtn) procsOpenBtn.focus();
  });

  // Last session's state, worn from the first frame rather than unfolded.
  setProcsOpen(readProcOpen(), false);
}

/* ------------------------------------------------------------------ */
/* The app dock                                                        */
/*                                                                     */
/* What this machine opens, pinned into the capsule above the web       */
/* chips. Three kinds of pin share the one row:                        */
/*                                                                     */
/*   an installed program   an opaque index id: its own 32px icon       */
/*   a web app             'web:<slug>': the site's favicon, fetched    */
/*                          through the same service the chips use      */
/*   a terminal program     'term:<program>': a monospace >_ plate      */
/*                                                                     */
/* An installed pin can also be asked to open somewhere other than its   */
/* own window: as its web form ({ id, web: true }) or as its real        */
/* window re-parented into a tab ({ id, native: true }). Either way it   */
/* keeps its app icon and wears one small mark — "web" or "tab" — and    */
/* edit mode's chooser is where those are set. The page never decides    */
/* where a press lands: it names the pin and the chrome routes it.       */
/*                                                                     */
/* Three pushes feed it and one console line leaves it:                */
/*                                                                     */
/*   window.__applyApps({ pins, installed, webapps, programs })  the    */
/*       pinned row, plus the three catalogues the picker groups and    */
/*       the pins resolve their names out of. Each list is only         */
/*       replaced when the push carried it. Rebuilds the row only when  */
/*       the pins themselves changed — a repeated push leaves every     */
/*       tile, and every 32px icon, exactly where it was.               */
/*                                                                     */
/*   window.__applyAppsRunning({ id: { running, pids, tab } })  arrives */
/*       once a second while this guest is on screen. It touches the    */
/*       dots and nothing else: no rebuild, no measurement.            */
/*       An open tab (`tab: true`, which is how a web app, a terminal   */
/*       or a program re-parented into a tab is ever "running") lights  */
/*       the identical dot.                                             */
/*                                                                     */
/*   window.__applyAppResult({ action, id, ok, reason })  the answer to */
/*       a line we logged. Only failures show: a 3s note on the tile.   */
/*                                                                     */
/* Out: `newtab:app {json}`, read off this guest by the chrome exactly  */
/* like the process list's end-task line. A press on a program is       */
/* launch, or focus when it is already running; a web pin is open-web   */
/* and a terminal pin open-term; edit mode sends unpin, and its chooser */
/* sends pin-web or pin-native; the picker sends pin. Pin and unpin also */
/* land locally at once — the chrome's next push is authoritative, but  */
/* the row must answer the press whether or not the browser it is inside */
/* knows about apps yet. The chooser is the one exception: nothing flips */
/* here until the chrome says it did.                                   */
/* ------------------------------------------------------------------ */

const DOCK_RESULTS = 8;          // the picker never shows more per group
const DOCK_NOTE_MS = 3000;       // and a failure note lives this long

const DOCK_WEB_PREFIX = 'web:';    // 'web:discord'   — a site pinned as an app
const DOCK_TERM_PREFIX = 'term:';  // 'term:powershell' — a pty in a tab

const dockSection = document.getElementById('dock');
const dockRow = document.getElementById('dock-row');
const dockEditBtn = document.getElementById('dock-edit');
const dockPicker = document.getElementById('dock-picker');
const dockSearch = document.getElementById('dock-search');
const dockResults = document.getElementById('dock-results');

let dockPins = [];               // the pinned apps, in the chrome's order
let dockInstalled = [];          // the index, sorted by name, names at least
let dockWebapps = [];            // the web-app catalogue, sorted by name
let dockPrograms = [];           // the terminal programs that are available
const dockCells = new Map();     // id -> { cell, tile, dot, note, running, pids }

/* The three catalogues, by id, so resolving a pin is a lookup and not a
   scan of thirty rows on every push. dockWebByDesktop is the other join:
   installed id -> the web app that is the same thing, which is what puts
   the third option on a tile's chooser in edit mode. */
const dockInstalledById = new Map();
const dockWebById = new Map();
const dockWebByDesktop = new Map();
const dockProgById = new Map();

let dockKey = null;              // identity of the row that is built
let dockEditing = false;
let dockPickerOpen = false;
let dockMatches = [];            // what the picker is showing
let dockActive = 0;              // and where the arrow keys are in it

let dockAddCell = null;          // the "+ Add app" tile, built once
let dockAddTile = null;

function dockText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * An icon is a data: URL or it is nothing. The index is built in the main
 * process; a pin must never make this page fetch anything.
 */
function dockIcon(value) {
  const url = dockText(value);
  return /^data:image\//i.test(url) ? url : null;
}

/** The pids the chrome found, bounded by the same cap end-task uses. */
function dockPids(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    out.push(Math.trunc(pid));
    if (out.length >= PROC_PIDS_MAX) break;
  }
  return out;
}

/** 'web:discord' / 'term:powershell', or '' for an installed-app id. */
function dockPrefix(id) {
  if (id.indexOf(DOCK_WEB_PREFIX) === 0) return DOCK_WEB_PREFIX;
  if (id.indexOf(DOCK_TERM_PREFIX) === 0) return DOCK_TERM_PREFIX;
  return '';
}

/**
 * One pin. The chrome may name it three ways and all three arrive here:
 *
 *   'a1b2c3'                    a bare id — everything else is looked up
 *   { id: 'a1b2c3', web: true } an installed app, opened as its web form
 *   { id, name, iconDataUrl, running, pids, tab }  the whole row
 *
 * `kind` is what the tile is made of: 'app', 'web', 'term', or 'missing'
 * when the id belongs to none of the three catalogues and the push did not
 * carry a name either — that one renders exactly as an app whose index
 * entry has gone, which is what it is.
 */
function normalizePin(entry) {
  const e = (typeof entry === 'string') ? { id: entry } : (entry || {});
  const id = dockText(e.id);
  if (!id) return null;

  const given = dockText(e.name) || dockText(e.exe);
  const pin = {
    id: id,
    kind: 'app',
    name: given || id,
    icon: dockIcon(e.iconDataUrl),
    host: dockText(e.host),
    web: e.web === true,
    // The chrome's rule is that a pin is one or the other; if a push ever
    // says both, the tab is what a press does, so that is what shows.
    native: e.native === true,
    webAvailable: false,
    running: e.running === true,
    tab: e.tab === true,
    pids: dockPids(e.pids)
  };

  const prefix = dockPrefix(id);

  if (prefix === DOCK_WEB_PREFIX) {
    const site = dockWebById.get(id);
    // A web pin is the web form by definition; its icon is a favicon, so
    // an iconDataUrl that came with it is not what this tile wears.
    pin.kind = (site || given) ? 'web' : 'missing';
    pin.web = true;
    pin.native = false;             // a site is a tab already
    pin.icon = null;
    if (site) { pin.name = site.name; pin.host = site.host; }
    return pin;
  }

  if (prefix === DOCK_TERM_PREFIX) {
    const program = dockProgById.get(id);
    pin.kind = (program || given) ? 'term' : 'missing';
    pin.native = false;             // so is a shell
    pin.icon = null;
    pin.host = '';
    if (program) pin.name = program.name;
    return pin;
  }

  const app = dockInstalledById.get(id);
  if (app) {
    if (!given) pin.name = app.name;
    if (!pin.icon) pin.icon = app.icon;
  } else if (!given) {
    pin.kind = 'missing';
  }
  pin.webAvailable = dockWebByDesktop.has(id);
  return pin;
}

function normalizePins(list) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const pin = normalizePin(entry);
    if (!pin || seen.has(pin.id)) continue;
    seen.add(pin.id);
    out.push(pin);
  }
  return out;
}

/**
 * The installed index: id and name are all the picker needs, and an icon
 * if one happened to come with it. Sorted here, once, so the picker's own
 * order is the same every time it opens.
 */
function normalizeInstalled(list) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const e = entry || {};
    const id = dockText(e.id);
    const name = dockText(e.name);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id: id, name: name, icon: dockIcon(e.iconDataUrl) });
  }
  out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return out;
}

/**
 * The web-app catalogue. `desktopId` is the join the chrome worked out —
 * the installed app this site is the web form of, or null — and it is what
 * decides whether a tile gets the "web" switch. Sorted by name, like the
 * installed index, so the picker's second group reads the same way as its
 * first.
 */
function normalizeWebapps(list) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const e = entry || {};
    const id = dockText(e.id);
    const name = dockText(e.name);
    if (!id || !name || seen.has(id)) continue;
    if (dockPrefix(id) !== DOCK_WEB_PREFIX) continue;
    seen.add(id);
    out.push({
      id: id,
      name: name,
      host: dockText(e.host),
      drm: e.drm === true,
      desktopId: dockText(e.desktopId) || null
    });
  }
  out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return out;
}

/**
 * The terminal programs. An unavailable one is dropped here rather than
 * filtered at every use: a program this machine does not have is not a
 * thing the picker can offer.
 */
function normalizePrograms(list) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const e = entry || {};
    const id = dockText(e.id);
    if (!id || seen.has(id) || e.available === false) continue;
    if (dockPrefix(id) !== DOCK_TERM_PREFIX) continue;
    seen.add(id);
    out.push({ id: id, name: dockText(e.name) || id.slice(DOCK_TERM_PREFIX.length) });
  }
  return out;                     // the chrome's order: its table is curated
}

/* The three catalogues land through these, so the id maps a pin resolves
   against can never drift from the lists the picker shows. */

function setDockInstalled(list) {
  dockInstalled = normalizeInstalled(list);
  dockInstalledById.clear();
  for (const app of dockInstalled) dockInstalledById.set(app.id, app);
}

function setDockWebapps(list) {
  dockWebapps = normalizeWebapps(list);
  dockWebById.clear();
  dockWebByDesktop.clear();
  for (const site of dockWebapps) {
    dockWebById.set(site.id, site);
    if (site.desktopId) dockWebByDesktop.set(site.desktopId, site);
  }
}

function setDockPrograms(list) {
  dockPrograms = normalizePrograms(list);
  dockProgById.clear();
  for (const program of dockPrograms) dockProgById.set(program.id, program);
}

/* webapps.js is loaded by this page too, so a web pin has a name and a
   host to draw from the very first paint — before the chrome's first push,
   and whether or not that push carries the catalogue. The pushed list is
   still the authority: it is the only one that knows desktopId. */
if (Array.isArray(window.WEBAPPS)) setDockWebapps(window.WEBAPPS);

/** Identity of the built row: what would make a tile different. */
function dockPinsKey(list) {
  return list.map(function (pin) {
    return [
      pin.id, pin.kind, pin.name, pin.host,
      pin.icon ? '1' : '0', pin.web ? '1' : '0',
      pin.native ? '1' : '0', pin.webAvailable ? '1' : '0'
    ].join('\t');
  }).join('\n');
}

/** The channel out. One line, the same shape end-task uses. */
function dockSend(message) {
  console.log('newtab:app ' + JSON.stringify(message));
}

/** No icon in the index: a neutral plate with the app's first letter. A
    site's fallback is the same letter on a disc, so a web pin still reads
    as a site when its favicon does not arrive. */
function dockGlyphNode(name, round) {
  const glyph = document.createElement('span');
  glyph.className = round ? 'dock-glyph is-web' : 'dock-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = (dockText(name) || '?').charAt(0);
  return glyph;
}

/** A terminal pin: the prompt itself, in the only monospace on this page. */
function dockTermNode() {
  const glyph = document.createElement('span');
  glyph.className = 'dock-glyph dock-term';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = '>_';
  return glyph;
}

/**
 * A web pin's icon: the same logo tile the chips row above uses, at the
 * dock's 32px — the store's logo, or the monogram, never a hole.
 */
function dockFaviconNode(pin) {
  if (!pin.host) return dockGlyphNode(pin.name, true);

  // The tile at the dock's 32px: the store's logo, or the tab strip's monogram.
  return faviconImg(pin.host, 'dock-icon dock-icon-web', 32);
}

/**
 * The 32px icon. A data URL that fails to decode is replaced by the glyph
 * rather than left as a broken image: this row is on screen full-time.
 */
function dockIconNode(pin) {
  if (pin.kind === 'web') return dockFaviconNode(pin);
  if (pin.kind === 'term') return dockTermNode();
  if (!pin.icon) return dockGlyphNode(pin.name);

  const img = document.createElement('img');
  img.className = 'dock-icon';
  img.src = pin.icon;
  img.width = 32;
  img.height = 32;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.onerror = function () {
    if (img.parentNode) img.parentNode.replaceChild(dockGlyphNode(pin.name), img);
  };
  return img;
}

/**
 * A tile's title. The state words are the whole difference between the
 * three kinds: a program runs, a tab is open, and the dot is the same
 * light for both.
 */
function dockTileTitle(name, running, tab) {
  if (!running) return name;
  return name + (tab ? ' — open' : ' — running');
}

/* Where an installed pin opens, in the order a press is least to most
   surprising: the program itself, the same thing as a site, the program's
   own window pulled into a tab. The labels are the words the marks use, so
   the option that is on and the badge the tile wears read the same; the
   sentence each one means is in its title and its aria-label. */
const DOCK_WHERE = [
  { mode: 'app', label: 'app', verb: 'as a program' },
  { mode: 'web', label: 'web', verb: 'as a web app in a tab' },
  { mode: 'tab', label: 'tab', verb: 'in a tab' }
];

/** Which option a pin is on. The tab wins over the web form, the same way
    the badge does, so the lit option is always what a press would do. */
function dockWhereMode(pin) {
  if (pin.native) return 'tab';
  if (pin.web) return 'web';
  return 'app';
}

/**
 * The chooser: two options for an app this machine is the only home for,
 * three when the web catalogue knows the same app as a site. It is under
 * the tile rather than over it — the corners are taken, and nothing here
 * may sit on the name.
 */
function buildDockWhere(pin) {
  const group = document.createElement('div');
  group.className = 'dock-where';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Where ' + pin.name + ' opens');

  const now = dockWhereMode(pin);

  for (const opt of DOCK_WHERE) {
    if (opt.mode === 'web' && !pin.webAvailable) continue;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dock-where-opt' + (opt.mode === now ? ' is-on' : '');
    button.dataset.mode = opt.mode;
    button.textContent = opt.label;
    button.setAttribute('aria-pressed', opt.mode === now ? 'true' : 'false');
    button.title = 'Open ' + pin.name + ' ' + opt.verb;
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', function () {
      chooseDockWhere(pin.id, opt.mode);
    });
    group.appendChild(button);
  }

  return group;
}

/** One pinned app: the tile, the remove glyph over it, and its note. */
function buildDockCell(pin) {
  const cell = document.createElement('div');
  cell.className = 'dock-cell';
  cell.dataset.id = pin.id;
  cell.dataset.mark = pin.kind;

  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'dock-tile dock-tile-' + pin.kind;
  tile.title = dockTileTitle(pin.name, pin.running, pin.tab);

  const ico = document.createElement('span');
  ico.className = 'dock-ico';
  ico.appendChild(dockIconNode(pin));

  const dot = document.createElement('span');
  dot.className = 'dock-dot';
  dot.setAttribute('aria-hidden', 'true');
  ico.appendChild(dot);

  const name = document.createElement('span');
  name.className = 'dock-name';
  name.textContent = pin.name;

  tile.appendChild(ico);
  tile.appendChild(name);

  // An installed app that opens somewhere other than its own window says
  // so in the one corner nothing else uses: the dot has the top-right, the
  // remove glyph takes that corner in edit mode, and the note owns the
  // foot. Never two marks — a pin sent as both is the tab, because that is
  // what a press would do.
  if (pin.kind === 'app' && (pin.native || pin.web)) {
    const badge = document.createElement('span');
    badge.className = 'dock-badge';
    badge.textContent = pin.native ? 'tab' : 'web';
    badge.title = pin.native
      ? pin.name + ' opens in a tab'
      : pin.name + ' opens as a web app in a tab';
    tile.appendChild(badge);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'dock-remove';
  remove.title = 'Unpin ' + pin.name;
  remove.setAttribute('aria-label', 'Unpin ' + pin.name);
  remove.textContent = '×';

  const note = document.createElement('span');
  note.className = 'dock-note';

  cell.appendChild(tile);
  cell.appendChild(remove);
  cell.appendChild(note);

  // The chooser, for an installed app: only ever visible in edit mode, and
  // it does not flip itself. The chrome owns which way this pin opens, so
  // the tile changes when the next __applyApps says it did.
  let where = null;
  if (pin.kind === 'app') {
    where = buildDockWhere(pin);
    cell.appendChild(where);
  }

  const rec = {
    cell: cell, tile: tile, dot: dot, note: note, where: where,
    kind: pin.kind, web: pin.web, native: pin.native, name: pin.name,
    running: pin.running, tab: pin.tab, pids: pin.pids.slice(), noteTimer: 0
  };

  tile.addEventListener('click', function () { pressDockTile(pin.id); });
  remove.addEventListener('click', function () { unpinApp(pin.id); });

  dockCells.set(pin.id, rec);
  return cell;
}

/** The way in to pinning: the tile recipe with the glass taken away. */
function buildDockAddCell() {
  const cell = document.createElement('div');
  cell.className = 'dock-cell dock-cell-add';

  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'dock-tile dock-add';
  tile.title = 'Add an app';
  tile.setAttribute('aria-expanded', 'false');
  tile.setAttribute('aria-controls', 'dock-picker');

  const plus = document.createElement('span');
  plus.className = 'dock-plus';
  plus.setAttribute('aria-hidden', 'true');

  const name = document.createElement('span');
  name.className = 'dock-name';
  name.textContent = 'Add app';

  tile.appendChild(plus);
  tile.appendChild(name);
  cell.appendChild(tile);

  tile.addEventListener('click', function () {
    setPickerOpen(!dockPickerOpen);
  });

  dockAddCell = cell;
  dockAddTile = tile;
  return cell;
}

function rebuildDockRow() {
  if (!dockRow) return;

  dockCells.forEach(function (rec) {
    if (rec.noteTimer) clearTimeout(rec.noteTimer);
  });
  dockCells.clear();

  const frag = document.createDocumentFragment();
  for (const pin of dockPins) frag.appendChild(buildDockCell(pin));
  frag.appendChild(dockAddCell || buildDockAddCell());
  dockRow.replaceChildren(frag);
}

/** The add tile is there while the row is being edited, and while it is empty.
    It also stays while its own picker is open: pinning the first app fills the
    row, and taking the tile away under an open picker would leave the picker
    with nothing to close it (the only other way out is Escape in the field). */
function syncDockAdd() {
  if (!dockAddCell) return;
  dockAddCell.hidden = !(dockEditing || dockPickerOpen || !dockPins.length);
  if (dockAddTile) dockAddTile.setAttribute('aria-expanded', dockPickerOpen ? 'true' : 'false');
}

/** Every dot from the pin list it belongs to. No geometry is touched. */
function syncDockRunning() {
  for (const pin of dockPins) {
    const rec = dockCells.get(pin.id);
    if (!rec) continue;
    rec.running = pin.running;
    rec.tab = pin.tab;
    rec.pids = pin.pids.slice();
    rec.tile.classList.toggle('is-running', pin.running);
    rec.tile.title = dockTileTitle(pin.name, pin.running, pin.tab);
  }
}

function renderDock() {
  if (!dockRow) return;

  const key = dockPinsKey(dockPins);
  if (key !== dockKey) {
    dockKey = key;
    rebuildDockRow();
  }

  syncDockAdd();
  syncDockRunning();
  if (dockPickerOpen) renderDockResults();
}

function setDockPins(list) {
  dockPins = list;
  renderDock();
}

/* --- pressing things ---------------------------------------------- */

/**
 * A press is "open it", or "show me the one that is already open". The page
 * never learns whether that worked: __applyAppResult does, and only when
 * it did not.
 */
function pressDockTile(id) {
  const rec = dockCells.get(id);
  if (!rec) return;
  if (dockEditing) return;         // the row is being arranged, not used

  // A site and a terminal are one line each: the chrome decides whether
  // that means a new tab or the one already open.
  if (rec.kind === 'web') { dockSend({ action: 'open-web', id: id }); return; }
  if (rec.kind === 'term') { dockSend({ action: 'open-term', id: id }); return; }

  // A program already inside a tab is the one case a pid cannot answer:
  // its window has been re-parented, so there is nothing on the desktop to
  // raise and the thing to show is the tab. Every other press is the press
  // it always was — including a pin set to open as its web form or in a
  // tab, which the chrome routes itself.
  if (rec.native && rec.running && rec.tab) dockSend({ action: 'open-native', id: id });
  // Every pid the sampler saw, not just the first: a program that runs as a
  // family (an Electron app, a launcher, a tray helper) keeps its window on
  // one of the others, and the first pid alone answers "no window". `pid`
  // stays for a chrome that predates the list. Both come off dockPids(), so
  // they are already positive integers and already capped.
  else if (rec.running && rec.pids.length) {
    dockSend({ action: 'focus', id: id, pid: rec.pids[0], pids: rec.pids.slice() });
  }
  else dockSend({ action: 'launch', id: id });
}

/**
 * Edit mode's chooser. It asks, and nothing more: the tile is only ever
 * redrawn by the push that comes back, so the row can never disagree with
 * where a press would actually land.
 *
 * Two lines cover three options, because "the program itself" is just both
 * of the others turned off: choosing the web form or the tab names itself,
 * and choosing the program turns off whichever one this pin is on. The one
 * already on says nothing at all.
 */
function chooseDockWhere(id, mode) {
  const rec = dockCells.get(id);
  if (!rec || rec.kind !== 'app') return;
  if (mode === dockWhereMode(rec)) return;

  if (mode === 'web') dockSend({ action: 'pin-web', id: id, web: true });
  else if (mode === 'tab') dockSend({ action: 'pin-native', id: id, native: true });
  else if (rec.native) dockSend({ action: 'pin-native', id: id, native: false });
  else dockSend({ action: 'pin-web', id: id, web: false });
}

function unpinApp(id) {
  if (!dockCells.has(id)) return;
  dockSend({ action: 'unpin', id: id });
  setDockPins(dockPins.filter(function (pin) { return pin.id !== id; }));
}

function pinApp(app) {
  if (!app || dockCells.has(app.id)) return;
  dockSend({ action: 'pin', id: app.id });
  // The id alone: normalizePin resolves the tile out of the same catalogue
  // the row was picked from, whichever of the three that was.
  setDockPins(dockPins.concat([normalizePin(app.id)]));
  // The picker stays up with the field cleared: pinning three apps is three
  // presses, not three trips through edit mode.
  if (dockSearch) dockSearch.value = '';
  renderDockResults();
}

function setDockEditing(on) {
  const next = !!on;
  if (next === dockEditing) return;
  dockEditing = next;
  if (dockSection) dockSection.classList.toggle('is-editing', next);
  if (dockEditBtn) {
    setText(dockEditBtn, next ? 'Done' : 'Edit');
    dockEditBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
  }
  if (!next && dockPickerOpen) setPickerOpen(false);
  syncDockAdd();
}

/* --- the picker --------------------------------------------------- */

/* Three groups, always in this order: what is on the machine, then what is
   on the web, then the shells. One field filters all three. */
const DOCK_GROUPS = [
  { kind: 'app', label: 'Installed' },
  { kind: 'web', label: 'Web apps' },
  { kind: 'term', label: 'Terminals' }
];

/** Where the typed text sits in a row: 0 for a start, -1 for no match. A
    site is findable by its host too — "gmail" and "mail.google" both. */
function dockMatchAt(entry, q) {
  const name = entry.name.toLowerCase().indexOf(q);
  if (name === 0) return 0;
  const host = entry.host ? entry.host.toLowerCase().indexOf(q) : -1;
  if (host === 0) return 0;
  if (name > 0) return name;
  if (host > 0) return host;
  return -1;
}

function dockGroupMatches(list, kind, q) {
  const starts = [];
  const inside = [];

  for (const item of list) {
    if (dockCells.has(item.id)) continue;       // already on the row
    const entry = {
      kind: kind,
      id: item.id,
      name: item.name,
      icon: item.icon || null,
      host: item.host || '',
      drm: item.drm === true,
      desktopId: item.desktopId || null
    };
    if (!q) { starts.push(entry); continue; }
    const at = dockMatchAt(entry, q);
    if (at === 0) starts.push(entry);
    else if (at > 0) inside.push(entry);
  }

  // A name that starts with what was typed is what was meant.
  return starts.concat(inside).slice(0, DOCK_RESULTS);
}

/** Every group's matches, flattened in group order. The headings are drawn
    from the `kind` changing, so this list is exactly the options: nothing
    the arrow keys can land on is a label. */
function dockMatchApps(query) {
  const q = dockText(query).toLowerCase();
  return dockGroupMatches(dockInstalled, 'app', q)
    .concat(dockGroupMatches(dockWebapps, 'web', q))
    .concat(dockGroupMatches(dockPrograms, 'term', q));
}

/** A picker row's leading 16px: the app's icon, a favicon, or the prompt. */
function dockResultIcon(app) {
  if (app.kind === 'term') {
    const glyph = document.createElement('span');
    glyph.className = 'dock-result-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '>_';
    return glyph;
  }

  if (app.kind === 'web') {
    return app.host ? faviconImg(app.host, 'dock-result-icon') : null;
  }

  if (!app.icon) return null;

  const icon = document.createElement('img');
  icon.className = 'dock-result-icon';
  icon.src = app.icon;
  icon.width = 16;
  icon.height = 16;
  icon.alt = '';
  icon.setAttribute('aria-hidden', 'true');
  icon.onerror = function () {
    if (icon.parentNode) icon.parentNode.removeChild(icon);
  };
  return icon;
}

/** The heading over a group. Quiet: the caption voice, not a new one. */
function dockGroupRow(label) {
  const row = document.createElement('li');
  row.className = 'dock-group';
  row.setAttribute('role', 'presentation');
  row.textContent = label;
  return row;
}

/**
 * Keep the arrow keys' row in view without scrolling the page under it.
 * Measured against the list's own box rather than offsetTop: neither the
 * list nor its rows establish a containing block, so offsetTop is counted
 * from some panel further up and would scroll the list to the wrong place.
 */
function scrollDockActiveIntoView() {
  if (!dockResults || typeof dockResults.getBoundingClientRect !== 'function') return;
  const row = dockResults.querySelector('.dock-result.is-active');
  if (!row) return;

  const list = dockResults.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  if (box.top < list.top) dockResults.scrollTop -= (list.top - box.top);
  else if (box.bottom > list.bottom) dockResults.scrollTop += (box.bottom - list.bottom);
}

function renderDockResults() {
  if (!dockResults) return;

  dockMatches = dockMatchApps(dockSearch ? dockSearch.value : '');
  if (dockActive >= dockMatches.length) dockActive = Math.max(0, dockMatches.length - 1);

  const frag = document.createDocumentFragment();

  if (!dockMatches.length) {
    const empty = document.createElement('li');
    empty.className = 'dock-result is-empty';
    const anything = dockInstalled.length || dockWebapps.length || dockPrograms.length;
    empty.textContent = anything ? 'No matches' : 'No apps indexed yet';
    frag.appendChild(empty);
    dockResults.replaceChildren(frag);
    if (dockSearch) dockSearch.removeAttribute('aria-activedescendant');
    return;
  }

  let group = null;

  dockMatches.forEach(function (app, i) {
    // One heading each time the kind changes: the list is already in group
    // order, so a group with nothing in it never announces itself.
    if (app.kind !== group) {
      group = app.kind;
      const label = DOCK_GROUPS.find(function (g) { return g.kind === group; });
      frag.appendChild(dockGroupRow(label ? label.label : group));
    }

    const row = document.createElement('li');
    row.className = 'dock-result dock-result-' + app.kind + (i === dockActive ? ' is-active' : '');
    row.id = 'dock-result-' + i;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', i === dockActive ? 'true' : 'false');
    row.dataset.id = app.id;
    row.dataset.mark = app.kind;
    row.title = app.host ? app.name + ' — ' + app.host : app.name;

    const icon = dockResultIcon(app);
    if (icon) row.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'dock-result-name';
    name.textContent = app.name;
    row.appendChild(name);

    // The host is what tells two Google rows apart, so it travels with the
    // name rather than only living in the title.
    if (app.kind === 'web' && app.host) {
      const host = document.createElement('span');
      host.className = 'dock-result-host';
      host.textContent = app.host;
      row.appendChild(host);
    }

    // This build has no Widevine, so a protected site plays through the
    // program instead — worth saying here, where the pin is chosen.
    if (app.kind === 'web' && app.desktopId) {
      const hint = document.createElement('span');
      hint.className = 'dock-result-hint';
      hint.textContent = 'desktop';
      row.appendChild(hint);
    }

    // mousedown, not click: the field must not lose focus before the pin.
    row.addEventListener('mousedown', function (event) {
      event.preventDefault();
      pinApp(app);
    });

    frag.appendChild(row);
  });

  dockResults.replaceChildren(frag);
  if (dockSearch) dockSearch.setAttribute('aria-activedescendant', 'dock-result-' + dockActive);
  scrollDockActiveIntoView();
}

function moveDockActive(delta) {
  if (!dockMatches.length) return;
  const last = dockMatches.length - 1;
  dockActive = Math.min(last, Math.max(0, dockActive + delta));
  renderDockResults();
}

function setPickerOpen(open) {
  if (!dockPicker) return;

  const next = !!open;
  dockPickerOpen = next;
  dockPicker.hidden = !next;
  if (dockAddTile) dockAddTile.setAttribute('aria-expanded', next ? 'true' : 'false');

  if (next) {
    if (dockSearch) dockSearch.value = '';
    dockActive = 0;
    renderDockResults();
    if (dockSearch) dockSearch.focus();
    // Nothing to pick from: ask the chrome to build the index. One line,
    // once per opening, and the picker is usable the moment it answers.
    if (!dockInstalled.length) dockSend({ action: 'refresh' });
  } else {
    dockMatches = [];
    dockActive = 0;
    if (dockResults) dockResults.replaceChildren();
  }

  // The add tile's visibility depends on this flag, so it is re-read here
  // before the box is measured — closing the picker over a filled row is
  // what takes the tile away again.
  syncDockAdd();
}

/* --- what came back ----------------------------------------------- */

/**
 * A failure, in the row's voice. The tile's title carries the whole of it.
 *
 * A press that found no window to raise is turned into a launch by the
 * chrome, and comes back as that launch (`action: 'launch'`, `fallback:
 * 'launch'`). So the only thing left to say here is whether the LAUNCH
 * failed — "No window" would be a note about a press that did in fact start
 * the app. The fallback is checked as well as the action for a chrome that
 * relabels neither.
 */
function dockResultNote(result) {
  const reason = dockText(result.reason);
  const fell = result.fallback === 'launch';
  if (!reason) return (result.action === 'focus' && !fell) ? 'No window' : 'Failed';
  if (reason === 'not-found' || reason === 'missing') return 'Not found';
  if (reason === 'no-window') return 'No window';
  if (reason === 'busy') return 'Busy';
  const text = reason.replace(/[-_]+/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function showDockNote(rec, text) {
  rec.note.textContent = text;
  rec.note.title = text;
  rec.cell.classList.add('has-note');
  if (rec.noteTimer) clearTimeout(rec.noteTimer);
  rec.noteTimer = setTimeout(function () {
    rec.noteTimer = 0;
    rec.cell.classList.remove('has-note');
    rec.note.textContent = '';
    rec.note.removeAttribute('title');
  }, DOCK_NOTE_MS);
}

/* --- the three pushes --------------------------------------------- */

/**
 * The pinned row and the three catalogues behind the picker. Each list is
 * only replaced when one was sent: a push that carries pins alone leaves
 * the picker with the catalogues it already had. The catalogues land first,
 * because a pin resolves its name, its host and its "web" switch out of
 * them.
 */
window.__applyApps = function (data) {
  const d = data || {};
  if (Array.isArray(d.installed)) setDockInstalled(d.installed);
  if (Array.isArray(d.webapps)) setDockWebapps(d.webapps);
  if (Array.isArray(d.programs)) setDockPrograms(d.programs);
  if (Array.isArray(d.pins)) setDockPins(normalizePins(d.pins));
  else renderDock();
  // A count, not the whole row: this is an executeJavaScript return value,
  // and __dock() is a forced layout nobody asked for. Tests call that.
  return {
    pins: dockPins.length,
    installed: dockInstalled.length,
    webapps: dockWebapps.length,
    programs: dockPrograms.length
  };
};

/**
 * Running state only, once a second. Dots in place: no tile is rebuilt and
 * no box is measured.
 *
 * An entry may also say `native: true` — a program whose own window is in a
 * tab. That lights the identical dot, and it is deliberately not read as a
 * mode: where a pin opens is __applyApps's to say, never this push's.
 */
window.__applyAppsRunning = function (map) {
  const m = (map && typeof map === 'object') ? map : {};
  let touched = 0;

  for (const id of Object.keys(m)) {
    const key = dockText(id);
    const entry = m[id] || {};
    const running = entry.running === true;
    const tab = entry.tab === true;
    const pids = dockPids(entry.pids);

    const pin = dockPins.find(function (p) { return p.id === key; });
    if (pin) { pin.running = running; pin.tab = tab; pin.pids = pids; }

    const rec = dockCells.get(key);
    if (!rec) continue;
    rec.running = running;
    rec.tab = tab;
    rec.pids = pids;
    rec.tile.classList.toggle('is-running', running);
    rec.tile.title = dockTileTitle(rec.name, running, tab);
    touched++;
  }

  // Deliberately not __dock(): this arrives once a second, and a forced
  // layout for a return value nobody reads is once a second too often.
  return { touched: touched };
};

/**
 * The answer to a line we logged. Only failures show: a launch that worked
 * is answered by the program itself. Returns the note it wrote, so a test
 * can read it without racing the three-second timer.
 */
window.__applyAppResult = function (result) {
  const r = result || {};
  if (r.ok === true) return null;

  const rec = dockCells.get(dockText(r.id));
  const text = dockResultNote(r);
  if (rec) showDockNote(rec, text);
  return text;
};

/** What the dock actually shows, for tests. */
window.__dock = function () {
  const cap = statsPanel ? statsPanel.getBoundingClientRect() : null;
  const row = dockRow ? dockRow.getBoundingClientRect() : null;
  const tops = new Set();

  const tiles = Array.prototype.map.call(dockRow ? dockRow.children : [], function (cell) {
    const tile = cell.querySelector('.dock-tile');
    const label = cell.querySelector('.dock-name');
    const dot = cell.querySelector('.dock-dot');
    const badge = cell.querySelector('.dock-badge');
    const where = cell.querySelector('.dock-where');
    const box = cell.getBoundingClientRect();
    if (!cell.hidden) tops.add(Math.round(box.top));
    return {
      id: cell.dataset.id || null,
      add: cell.classList.contains('dock-cell-add'),
      hidden: !!cell.hidden,
      mark: cell.dataset.mark || null,
      name: label ? label.textContent : '',
      title: tile ? tile.title : '',
      running: !!(tile && tile.classList.contains('is-running')),
      dot: !!(dot && getComputedStyle(dot).display !== 'none'),
      icon: !!cell.querySelector('.dock-icon'),
      favicon: !!cell.querySelector('.dock-icon-web'),
      glyph: !!cell.querySelector('.dock-glyph'),
      term: !!cell.querySelector('.dock-term'),
      badge: !!(badge && getComputedStyle(badge).display !== 'none'),
      badgeText: badge ? badge.textContent : null,
      where: where
        ? {
            shown: getComputedStyle(where).display !== 'none',
            opts: Array.prototype.map.call(where.children, function (button) {
              return {
                mode: button.dataset.mode || null,
                label: button.textContent,
                on: button.classList.contains('is-on'),
                pressed: button.getAttribute('aria-pressed') === 'true'
              };
            })
          }
        : null,
      note: cell.classList.contains('has-note')
        ? (cell.querySelector('.dock-note') || {}).textContent : null,
      w: box.width, h: box.height, top: box.top, left: box.left
    };
  });

  return {
    editing: dockEditing,
    pickerOpen: dockPickerOpen,
    installed: dockInstalled.length,
    webapps: dockWebapps.length,
    programs: dockPrograms.length,
    pins: dockPins.map(function (pin) {
      return {
        id: pin.id, kind: pin.kind, name: pin.name, host: pin.host,
        web: pin.web, native: pin.native, webAvailable: pin.webAvailable,
        running: pin.running, tab: pin.tab,
        pids: pin.pids.slice(), icon: !!pin.icon
      };
    }),
    rows: tops.size,
    capsuleHeight: cap ? cap.height : 0,
    sectionHeight: dockSection ? dockSection.getBoundingClientRect().height : 0,
    rowHeight: row ? row.height : 0,
    active: dockActive,
    results: dockMatches.map(function (app) { return app.name; }),
    resultKinds: dockMatches.map(function (app) { return app.kind; }),
    resultRows: Array.prototype.map.call(dockResults ? dockResults.children : [], function (li) {
      return {
        name: li.textContent,
        group: li.classList.contains('dock-group'),
        kind: li.dataset.mark || null,
        active: li.classList.contains('is-active')
      };
    }),
    tiles: tiles
  };
};

function wireDock() {
  if (!dockRow) return;

  /* The capsule behind this row folds the process list when it is clicked,
     and a press in here is never that. The containment check over in
     wireProcs() is not enough on its own: unpinning DETACHES the button
     that was pressed, so by the time the click reaches the panel its
     target is no longer inside the dock — and the capsule folded. Stopping
     the click at the section covers every control in here, including the
     ones that remove themselves. */
  if (dockSection) {
    dockSection.addEventListener('click', function (event) {
      event.stopPropagation();
    });
  }

  // The row starts with nothing pinned and the way in showing, so the
  // capsule wears its final height from the first paint whether or not the
  // chrome ever pushes a pin.
  renderDock();

  if (dockEditBtn) {
    dockEditBtn.addEventListener('click', function () {
      setDockEditing(!dockEditing);
    });
  }

  if (dockSearch) {
    dockSearch.addEventListener('input', function () {
      dockActive = 0;
      renderDockResults();
    });

    dockSearch.addEventListener('keydown', function (event) {
      const key = event.key;
      if (key === 'ArrowDown') { event.preventDefault(); moveDockActive(1); return; }
      if (key === 'ArrowUp')   { event.preventDefault(); moveDockActive(-1); return; }
      if (key === 'Enter') {
        event.preventDefault();
        pinApp(dockMatches[dockActive]);
        return;
      }
      if (key === 'Escape' || key === 'Esc') {
        event.preventDefault();
        event.stopPropagation();
        setPickerOpen(false);
        // Closing it can also take the add tile away (a filled row, not being
        // edited): focus has to land on something that is still on screen.
        if (dockAddTile && dockAddCell && !dockAddCell.hidden) dockAddTile.focus();
        else if (dockEditBtn) dockEditBtn.focus();
      }
    });
  }
}

/* The accent's base colour differs per theme, so re-derive the same hue
   whenever the chrome flips data-theme on <html>. */
function watchTheme() {
  if (typeof MutationObserver !== 'function') return;

  const observer = new MutationObserver(function () {
    if (typeof window.__applyAccent === 'function') {
      window.__applyAccent(window.__accentHue ? window.__accentHue() : null);
    }
    // The graphs hold a painted copy of --ion and --edge: a theme flip
    // between samples would otherwise leave them in the old colour for
    // up to a second.
    paintStats();
    // Dark hands the picture to the chrome's layer, light paints it here.
    if (bgLayerIsChrome() !== bgState.chromeLayer) applyBackground(bgLastPush);
  });

  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/*                                                                     */
/* The field under the Q. It never takes the caret by itself: a new tab */
/* puts the caret in the ADDRESS BAR (the chrome, ea1ffe9), so typing   */
/* straight after Ctrl+T searches up there. This field is for a click.  */
/* Enter opens what looks like an address and searches anything else,   */
/* with the engine Settings picked (?engine= for the first paint,       */
/* searchEngine on the settings push), by navigating this tab — the     */
/* same way a chip opens its site.                                     */
/* ------------------------------------------------------------------ */

/* Mirrors settings.js ENGINES (the chrome's list). Unknown means Google. */
const SEARCH_ENGINES = {
  google:     { name: 'Google',     url: 'https://www.google.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing:       { name: 'Bing',       url: 'https://www.bing.com/search?q=' },
  brave:      { name: 'Brave',      url: 'https://search.brave.com/search?q=' },
  startpage:  { name: 'Startpage',  url: 'https://www.startpage.com/do/search?q=' },
  // Quartz's own results page (search.html, next to this file), fed by the
  // Brave Search API through main. `own` makes searchTarget() build it.
  'brave-api': { name: 'Brave',     url: 'https://search.brave.com/search?q=', own: true }
};

/** Quartz's own results page for `q`, wearing this page's look. */
function ownResultsUrl(q) {
  const p = new URLSearchParams();
  p.set('q', q);
  const root = document.documentElement;
  const theme = root.getAttribute('data-theme');
  p.set('theme', theme === 'light' ? 'light' : 'dark');
  const palette = root.getAttribute('data-palette');
  if (palette) p.set('palette', palette);
  const hue = typeof window.__accentHue === 'function' ? window.__accentHue() : null;
  if (typeof hue === 'number' && isFinite(hue)) p.set('hue', String(hue));
  return new URL('search.html', window.location.href).href + '?' + p.toString();
}

let searchEngineKey = 'google';

function searchEngine() {
  return SEARCH_ENGINES[searchEngineKey] || SEARCH_ENGINES.google;
}

/** The engine's name belongs in the field's own prompt. */
function setSearchEngine(key) {
  const name = String(key == null ? '' : key).toLowerCase();
  searchEngineKey = Object.prototype.hasOwnProperty.call(SEARCH_ENGINES, name) ? name : 'google';
  const input = document.getElementById('search-input');
  if (!input) return;
  const prompt = 'Search ' + searchEngine().name + ' or type a URL';
  if (input.placeholder !== prompt) input.placeholder = prompt;
  input.setAttribute('aria-label', prompt);
}

/**
 * Where Enter goes. What the Saved field would take as a web address
 * (parseTypedAddress: a scheme, name.tld, localhost, an IP) opens as one;
 * any other text is a search. '' for nothing to do.
 */
function searchTarget(text) {
  const q = String(text || '').trim();
  if (!q) return '';
  const typed = parseTypedAddress(q);
  if (typed && typed.url) return typed.url;
  if (searchEngine().own) return ownResultsUrl(q);
  return searchEngine().url + encodeURIComponent(q);
}

function wireSearch(engineParam) {
  setSearchEngine(engineParam);
  const form = document.getElementById('search');
  const input = document.getElementById('search-input');
  if (!form || !input) return;
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    const target = searchTarget(input.value);
    if (target) window.location.assign(target);
  });
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' || event.key === 'Esc') {
      input.value = '';
      input.blur();
    }
  });
}

/** The field's state, for tests. */
window.__search = function (text) {
  const input = document.getElementById('search-input');
  return {
    engine: searchEngineKey,
    placeholder: input ? input.placeholder : '',
    focused: !!input && document.activeElement === input,
    target: typeof text === 'string' ? searchTarget(text) : null
  };
};

/* ------------------------------------------------------------------ */
/* Background                                                          */
/*                                                                     */
/* The Quartz background (Settings, key newtabBackground), shown CLEAR  */
/* and full-bleed: Helm's Home treatment. In dark a still is drawn by   */
/* the CHROME's layer under this see-through page (bgLayerIsChrome);    */
/* in light, and for a clip, it is drawn here. The chrome              */
/* pushes it in on dom-ready and on every change:                      */
/*                                                                     */
/*   window.__applyBackground({ kind, dim, url, fileName, state, reason }) */
/*     kind      'desktop' | 'builtin' | 'image' | 'video' | 'none'    */
/*               (unknown, 'board', 'aurora' read as 'desktop')        */
/*               'desktop' = Mantle's still (or Windows' wallpaper),   */
/*               with align { mw, mh, x, y }: lined up, see below      */
/*               'builtin' is one of Helm's photos (file:// URL in the  */
/*               app folder), a still exactly like the wallpaper; for  */
/*               an id the build lacks it arrives as 'fallback' WITH   */
/*               the wallpaper's url, and the note says so.            */
/*     dim       0..0.6, the wash over the picture                     */
/*     url       wallpaper: file:// URL of main's copy of the Windows   */
/*               wallpaper; image: the data: URL out of IndexedDB;     */
/*               video: file:// URL of main's copy of the clip         */
/*               (legacy dataUrl / fileUrl are read in its place)      */
/*     fileName  for video: decides <video> (a clip) or <img> (a GIF)  */
/*     state     'loading' | 'ok' | 'fallback'                         */
/*     reason    why, when state is 'fallback'                         */
/*                                                                     */
/* ?bg=<kind> on this page's URL is only a first-paint hint: it paints  */
/* the plain --bg (never a wrong picture) until the push arrives.       */
/*                                                                     */
/* No silent failures: a 'fallback' push, or a picture that will not   */
/* load or decode HERE, leaves the plain --bg and says why in #bg-note. */
/* ------------------------------------------------------------------ */

const BG_KINDS = ['desktop', 'wallpaper', 'builtin', 'image', 'video', 'none'];

/** The kinds that are one still picture (an <img>-able URL, no clip). */
function bgIsStill(kind) {
  return kind === 'desktop' || kind === 'wallpaper' || kind === 'builtin' || kind === 'image';
}
const BG_DIM_DEFAULT = 0.25;
const BG_DIM_MAX = 0.6;

/** Unknown, missing and the retired 'board' / 'aurora' all mean the desktop
    (Look Sync's default; settings.js migrates 'wallpaper' to it too). */
function bgKind(value) {
  const k = String(value == null ? '' : value);
  return BG_KINDS.indexOf(k) >= 0 ? k : 'desktop';
}

/** 0..0.6, with anything unreadable falling back to the default wash. */
function bgDim(value) {
  if (value === null || value === undefined || value === '') return BG_DIM_DEFAULT;
  const n = Number(value);
  if (!isFinite(n)) return BG_DIM_DEFAULT;
  return Math.min(BG_DIM_MAX, Math.max(0, n));
}

/** A push without a state is a chrome from before the contract: take it as ok. */
function bgPushState(value) {
  return value === 'ok' || value === 'fallback' || value === 'loading' ? value : 'ok';
}

/* Which element a clip belongs in. A real clip is decoded by the <video> —
   on this hardware, by the GPU — and a GIF cannot be: it goes in the <img>,
   where it animates itself. Anything else an <img> can decode ends up there
   too, which is the right answer for a still frame as well. */
const BG_CLIP_EXT = /\.(?:mp4|webm|mov|m4v)$/i;

/* file: is what the chrome sends (main's copies); data: is the user's own
   picture; the rest are here so a test can hand one over directly. */
const BG_URL_PROTO = /^(?:file|blob|data|https?):/i;

/** The path part of a URL, so an extension test never reads a query. */
function bgUrlPath(url) {
  return String(url).split('#')[0].split('?')[0];
}

/** '' for anything this page will not put in a layer. */
function bgUrl(value) {
  if (typeof value !== 'string' || value === '') return '';
  return BG_URL_PROTO.test(value) ? value : '';
}

/** 'video' for a clip, 'img' for a GIF (or any other image), '' for neither. */
function bgClipLayer(url, fileName) {
  if (!url) return '';
  if (/^data:video\//i.test(url)) return 'video';
  if (/^data:image\//i.test(url)) return 'img';
  const name = typeof fileName === 'string' && fileName ? fileName : bgUrlPath(url);
  return BG_CLIP_EXT.test(name) ? 'video' : 'img';
}

/** A URL made safe to sit inside url("...") in an inline style. */
function bgCssUrl(url) {
  return 'url("' + String(url).replace(/["\\\n\r]/g, function (c) {
    return encodeURIComponent(c);
  }) + '")';
}

/** What a picture is called in a note: its file name when the push had one. */
function bgWhat(kind, fileName) {
  if (kind === 'desktop') return 'The desktop wallpaper';
  if (kind === 'wallpaper') return 'The copy of the Windows wallpaper';
  const name = typeof fileName === 'string' && fileName ? ' (' + fileName + ')' : '';
  if (kind === 'builtin') return 'The built-in photo' + name;
  if (kind === 'video') return 'The background clip' + name;
  return 'The background picture' + name;
}

let bgState = {
  kind: 'desktop', dim: 0, state: 'loading', reason: '',
  url: '', fileName: '', stillShown: false, clipLayer: '', localError: '', chromeLayer: false
};

/* Helm's Home (dark): a still picture is NOT drawn here. The chrome window
   draws ONE picture behind the whole window, unblurred whatever tab is
   in front (backdrop.js syncHome: .bg-clear, Helm's 96px scrim, and the
   one wash at the strip's alpha), and this page is see-through over it
   (html[data-bg-layer="chrome"], newtab.css), so the tab strip, the
   toolbar and this page are one picture with no edge at the toolbar.
   Light does the same (CONTRACT "Light look": one picture under the white
   wash, as Helm's light Home); a clip (video / GIF) always plays here. The last push is kept so a theme flip
   can hand the picture back and forth (watchTheme). */
let bgLastPush = null;

/** True when the chrome draws this kind's picture under the page. */
function bgLayerIsChrome(kind) {
  const k = kind === undefined ? bgState.kind : kind;
  return bgIsStill(k);
}

/* Kind 'desktop' (Look Sync): the desktop's still, LINED UP with the screen.
   The chrome sends align { mw, mh, x, y }: the monitor's size and this
   page's top-left on that monitor (CSS px). #bg-image is then sized to the
   MONITOR with background-size: cover, centred (exactly the desktop's fit),
   and moved by translate3d(-x, -y, 0), so the part of the wallpaper behind
   this page is the part it shows. Moves arrive through
   window.__applyBackgroundAlign(align), which touches the transform (and
   the size only when the monitor changed): no reload, no decode, no
   layout of anything else. align null = no place yet: cover on the window,
   like every other kind. Own kinds never get .lined. */
let bgAlign = null;

/** A usable align, or null. */
function bgAlignOf(value) {
  if (!value || typeof value !== 'object') return null;
  const mw = Number(value.mw);
  const mh = Number(value.mh);
  const x = Number(value.x);
  const y = Number(value.y);
  if (!(mw > 0) || !(mh > 0) || !isFinite(x) || !isFinite(y)) return null;
  return { mw: mw, mh: mh, x: x, y: y };
}

/** Put the still where the align says, or back to cover on the window. */
function paintBgAlign() {
  const layer = document.getElementById('bg-image');
  if (!layer) return;
  const a = bgState.kind === 'desktop' ? bgAlign : null;
  if (!a) {
    if (layer.classList.contains('lined')) {
      layer.classList.remove('lined');
      layer.style.removeProperty('width');
      layer.style.removeProperty('height');
      layer.style.removeProperty('transform');
    }
    return;
  }
  layer.classList.add('lined');
  const w = a.mw + 'px';
  const h = a.mh + 'px';
  if (layer.style.width !== w) layer.style.width = w;
  if (layer.style.height !== h) layer.style.height = h;
  layer.style.transform = 'translate3d(' + (-a.x) + 'px, ' + (-a.y) + 'px, 0)';
}

/* Bumped by every push, so a still that finishes loading after a newer push
   arrived never paints over it. */
let bgSeq = 0;

/* The chrome's __boardPaused(true): an overlay is open over this page, or
   the window went behind. The clip stops on it: a frame nobody is looking
   at is a decoder and a compositor pass for nothing. */
let bgChromePaused = false;

let bgClipWired = false;

/** The quiet line that says why there is no picture. Empty hides it. */
function paintBgNote() {
  const note = document.getElementById('bg-note');
  if (!note) return;
  let text = '';
  if (bgState.localError) text = bgState.localError;
  else if (bgState.state === 'fallback' && bgState.kind === 'builtin' && bgState.url) {
    // The wallpaper standing in for a built-in id this build does not have.
    text = 'Built-in photo unavailable' + (bgState.reason ? ': ' + bgState.reason : '') +
      '. Showing your Windows wallpaper instead.';
  } else if (bgState.state === 'fallback') {
    text = 'Background unavailable' + (bgState.reason ? ': ' + bgState.reason : '');
  }
  if (note.textContent !== text) note.textContent = text;
  note.hidden = !text;
}

function paintBgRoot() {
  const root = document.documentElement;
  root.setAttribute('data-bg', bgState.kind);
  /* What is actually on screen, which a failure here can make 'fallback'
     even when the push said 'ok'. */
  root.setAttribute('data-bg-state', bgState.localError ? 'fallback' : bgState.state);
  root.style.setProperty('--bg-dim', String(bgState.dim));
  if (bgState.chromeLayer) root.setAttribute('data-bg-layer', 'chrome');
  else root.removeAttribute('data-bg-layer');
}

/* A file that cannot be shown here (moved since the chrome copied it, a
   format this build has no decoder for) leaves the plain --bg and says so.
   The setting stays the user's choice; the next push tries it again. */
function bgLocalFailure(text) {
  bgState.localError = text;
  bgState.stillShown = false;
  setStill('');
  setClipLayers('', '');
  paintBgRoot();
  paintBgNote();
}

function onClipError() {
  if (bgState.kind !== 'video' || !bgState.url || bgState.clipLayer !== 'video') return;
  const video = document.getElementById('bg-video');
  const code = video && video.error ? video.error.code : 0;
  let why = 'could not be opened (moved, or a format this build cannot decode)';
  if (code === 2) why = 'could not be read';
  else if (code === 3) why = 'could not be decoded';
  bgLocalFailure(bgWhat('video', bgState.fileName) + ' ' + why + '.');
}

function onGifError() {
  if (bgState.kind !== 'video' || !bgState.url || bgState.clipLayer !== 'img') return;
  bgLocalFailure(bgWhat('video', bgState.fileName) + ' could not be opened.');
}

function wireClipLayers(video, img) {
  if (bgClipWired) return;
  bgClipWired = true;
  if (video) video.addEventListener('error', onClipError);
  if (img) img.addEventListener('error', onGifError);
}

/** Put a still in #bg-image, or take it away (''). */
function setStill(url) {
  const layer = document.getElementById('bg-image');
  if (!layer) return;
  if (url) {
    layer.style.setProperty('background-image', bgCssUrl(url));
    layer.classList.add('on');
  } else {
    layer.classList.remove('on');
    layer.style.removeProperty('background-image');
  }
}

/**
 * Load a still off screen first, so a file that is missing or not a picture
 * is caught (a CSS background-image fails silently) and the layer fades in
 * once, already decoded, rather than painting in strips.
 */
function loadStill(url, seq) {
  const probe = new Image();
  probe.decoding = 'async';
  probe.onload = function () {
    if (seq !== bgSeq) return;
    bgState.stillShown = true;
    setStill(url);
  };
  probe.onerror = function () {
    if (seq !== bgSeq) return;
    bgLocalFailure(bgWhat(bgState.kind, bgState.fileName) + ' could not be loaded.');
  };
  probe.src = url;
}

/**
 * Fill (or empty) the two moving-picture layers. Exactly one of them ever
 * carries .on, so a 'video' background with no file yet draws nothing at
 * all rather than a black rectangle.
 */
function setClipLayers(layer, url) {
  const video = document.getElementById('bg-video');
  const img = document.getElementById('bg-video-img');
  wireClipLayers(video, img);

  if (video) {
    if (layer === 'video') {
      if (video.getAttribute('src') !== url) {
        video.muted = true;            // the attribute alone is not always enough
        video.setAttribute('src', url);
      }
      video.classList.add('on');
    } else {
      video.classList.remove('on');
      /* Pause before clearing: a media element holding a source it is no
         longer showing still holds a decoder and a file handle. Removing
         the attribute and reloading is the only way to give both back. */
      video.pause();
      if (video.hasAttribute('src')) {
        video.removeAttribute('src');
        video.load();
      }
    }
  }

  if (img) {
    if (layer === 'img') {
      if (img.getAttribute('src') !== url) img.setAttribute('src', url);
      img.classList.add('on');
    } else {
      img.classList.remove('on');
      if (img.hasAttribute('src')) img.removeAttribute('src');
    }
  }
}

/** Only while this page is the one a person is looking at. */
function clipShouldRun() {
  return bgState.kind === 'video' && bgState.clipLayer === 'video' &&
    !bgState.localError && !bgChromePaused && !document.hidden;
}

/**
 * Start or stop the clip. Idempotent, and cheap enough to hang off every
 * signal that means "in front again". A paused <video> costs nothing; the
 * element is never torn down, so coming back is one call and no reload.
 */
function syncClip() {
  const video = document.getElementById('bg-video');
  if (!video) return;
  if (clipShouldRun()) {
    if (video.paused) {
      const started = video.play();
      /* The autoplay promise rejects when the source went away mid-call.
         Nothing to report here: the error handler above owns the failure. */
      if (started && typeof started.catch === 'function') started.catch(function () {});
    }
    return;
  }
  if (!video.paused) video.pause();
}

function applyBackground(bg) {
  const next = bg && typeof bg === 'object' ? bg : {};
  const kind = bgKind(next.kind);
  const raw = bgUrl(next.url) || bgUrl(next.dataUrl) || bgUrl(next.fileUrl);
  const fileName = typeof next.fileName === 'string' ? next.fileName : '';
  let url = kind === 'none' ? '' : raw;
  /* A still is only ever a picture: no data:video in the stylesheet. */
  if (bgIsStill(kind) && /^data:(?!image\/)/i.test(url)) url = '';
  const clipLayer = kind === 'video' ? bgClipLayer(url, fileName) : '';

  const chromeLayer = bgLayerIsChrome(kind);
  const sameStill = bgIsStill(kind) && !chromeLayer &&
    url === bgState.url && kind === bgState.kind && bgState.stillShown && !bgState.localError;

  bgLastPush = next;
  bgSeq += 1;
  bgState = {
    kind: kind,
    dim: kind === 'none' ? 0 : bgDim(next.dim),
    state: bgPushState(next.state),
    reason: typeof next.reason === 'string' ? next.reason : '',
    url: url,
    fileName: fileName,
    stillShown: sameStill,
    clipLayer: clipLayer,
    localError: '',
    chromeLayer: chromeLayer
  };
  bgAlign = kind === 'desktop' ? bgAlignOf(next.align) : null;
  paintBgAlign();

  /* The still: kept as it is when the push repeats it, so a settings push
     that changed only the dim does not blink the picture. In dark the
     chrome draws it (above), so nothing is loaded here at all. */
  if (chromeLayer) {
    setStill('');
  } else if (bgIsStill(kind) && url) {
    if (!sameStill) {
      setStill('');
      loadStill(url, bgSeq);
    }
  } else {
    setStill('');
  }

  /* Leaving 'video' therefore pauses and clears; arriving sets and plays. */
  setClipLayers(clipLayer, url);
  paintBgRoot();
  paintBgNote();
  syncClip();
  return window.__background();
}

/**
 * The chrome pushes the background in on dom-ready and on every change. The
 * payload is described at the top of this section.
 */
window.__applyBackground = function (bg) {
  return applyBackground(bg);
};

/** The cheap per-move update for kind 'desktop': the transform only. */
window.__applyBackgroundAlign = function (align) {
  bgAlign = bgAlignOf(align);
  paintBgAlign();
  return window.__bgAlignState();
};

/** Test seam: the align in effect, and whether the layer wears it. */
window.__bgAlignState = function () {
  const layer = document.getElementById('bg-image');
  const a = bgAlign;
  return {
    kind: bgState.kind,
    mw: a ? a.mw : null,
    mh: a ? a.mh : null,
    x: a ? a.x : null,
    y: a ? a.y : null,
    lined: !!(layer && layer.classList.contains('lined')),
    transform: layer ? layer.style.transform : ''
  };
};

/* The chrome's pause hook, kept under its old name so the chrome as it is
   reaches it: app.js pushBoardPaused() calls it while an overlay is open
   over this page or the window is behind. It stops the clip, and starts it
   again on false when nothing else vetoes. */
window.__boardPaused = function (flag) {
  bgChromePaused = !!flag;
  syncClip();
};

/** The background actually on screen, for tests. */
window.__background = function () {
  const video = document.getElementById('bg-video');
  const note = document.getElementById('bg-note');
  return {
    kind: bgState.kind,
    dim: bgState.dim,
    state: bgState.localError ? 'fallback' : bgState.state,
    reason: bgState.reason,
    hasImage: bgState.stillShown,
    clipLayer: bgState.clipLayer,
    hasClip: !!(bgState.kind === 'video' && bgState.url && !bgState.localError),
    clipPlaying: !!(video && bgState.clipLayer === 'video' && !video.paused),
    chromePaused: bgChromePaused,
    align: bgAlign,
    // 'chrome': dark + a still, drawn by the window's layer under this
    // see-through page (Helm's Home); 'page': drawn here.
    layer: bgState.chromeLayer ? 'chrome' : 'page',
    note: note && !note.hidden ? note.textContent : ''
  };
};

/** The chrome pushes settings here with executeJavaScript. */
window.__applySettings = function (settings) {
  const next = settings || {};
  setSearchEngine(next.searchEngine);
  setChips(next.chips);
  // Palette first: it authors the accent the hue is then painted over, so
  // a push that clears the hue lands on the new preset's own colour.
  if (typeof window.__applyPalette === 'function') window.__applyPalette(next.palette);
  if (typeof window.__applyAccent === 'function') window.__applyAccent(next.accentHue);
};

/**
 * Retired. This fed the Recent row, which the Saved row replaced (see
 * "saved sites"). A chrome that has not been restarted since still pushes
 * browsing history here on every new tab, so it stays defined — as a no-op,
 * because an undefined function would be an error in that chrome's push,
 * and drawing history here would put the old row back.
 */
window.__applyRecent = function () {};

/** The chips actually on screen, for tests. */
window.__chips = function () {
  return currentChips().map(function (item) {
    return { label: item.label, url: item.url };
  });
};

/* ------------------------------------------------------------------ */
/* Home layout and edit mode                                           */
/* ------------------------------------------------------------------ */

/*
 * Every piece of this page can be switched off, put back, and dragged to
 * ANY spot: lower, higher, any corner, anywhere in between, as long as it
 * does not sit on another piece or hang off the page. The rules (what a
 * layout is, how a change applies, and the geometry: anchors, the nearest
 * free spot, a whole-page arrange) are homelayout.js, shared with the
 * chrome; this section draws a layout and runs edit mode.
 *
 *   in   window.__applyHomeLayout(layout, meta) — the WHOLE layout, every
 *        time: on load, after any change made anywhere (Settings -> Home,
 *        another new tab), and as the answer to this page's own request,
 *        when meta is { ack: <seq>, ok, reason }.
 *   out  console.log('newtab:home {"op":…,"id":…,"at":{…},"seq":n}')
 *        one line per change: hide | show | place | reset.
 *   first paint: ?home=<layout JSON> when the stored layout is not the
 *        default (absent = the markup's own arrangement, which IS the
 *        default, so a Home nobody customised never moves a node).
 *
 * The Saved row's contract (3aa8bbf): the page applies its change at once,
 * the chrome stores it and answers by pushing the whole layout back, and a
 * request with no answer inside HOME_ANSWER_MS is rolled back to the last
 * layout the chrome confirmed, with a note that says so. The page never
 * stores anything itself.
 *
 * TWO WAYS TO DRAW. A Home nobody has moved anything on is the plain flow
 * it always was: the three columns, folding into one below 1296px, every
 * node where the markup put it. A Home with a piece moved (and every Home
 * in edit mode, so a drag has a canvas to land on) is FREE: each piece is
 * absolutely placed on the page, the window is the page, nothing scrolls.
 * A free draw starts from the flow anyway: the flow is laid out (unfolded,
 * three columns, whatever the width) and measured, every piece never moved
 * keeps the rect the flow gave it, every piece moved goes where its anchor
 * says at today's window size, and HomeLayout.arrange() settles the lot so
 * nothing overlaps and nothing is off the page. If it cannot (the window
 * is too small for the arrangement), the page draws the flow instead and
 * says so: a fold, never an overlap. All of it happens inside one task, so
 * the measuring pass is never painted.
 *
 * Moving a piece never moves the pieces you did not move: they keep their
 * default rects, measured with the moved piece still counted in its old
 * slot. Hiding one does let the never-moved ones close up, as it always
 * did in the flow.
 *
 * A switched-off piece goes to #home-shelf, which is never drawn, and its
 * work stops: the clock's timer, the now-playing hairline, the markets
 * socket (the tile unsubscribes) — and in the chrome, which reads the same
 * stored layout, the stats sampler, the media poll and the session pushes.
 * The app dock rides inside the stats card (today's look) until it is
 * moved on its own; after that it is its own card.
 */

var HL = (window.HomeLayout && typeof window.HomeLayout.sanitize === 'function')
  ? window.HomeLayout : null;

/* How long a change waits for the chrome before it is rolled back. */
var HOME_ANSWER_MS = 2000;
/* How long a note stays up. Long enough to read twice. */
var HOME_NOTE_MS = 10000;
/* Slack around a piece for its edit box, and the pointer travel that
   turns a press into a drag (a click on a box is not a move). */
var HOME_BOX_PAD = 6;
var HOME_DRAG_SLOP = 5;
/* Snapping: how close an edge has to come to a guide to stick to it, the
   page margin the guides mark (the default arrangement's own 24px), and
   the gap a piece snaps to beside another one (the rails' own 16px). */
var HOME_SNAP = 7;
var HOME_EDGE = 24;
var HOME_SNAP_GAP = 16;
/* Arrow keys in edit mode: a step, Shift for a big one, Alt for one px. */
var HOME_STEP = 8;
var HOME_STEP_BIG = 64;
/* A burst of arrow presses is ONE request, sent this long after the last. */
var HOME_KEY_SEND_MS = 350;
/* A piece put down this close to another one (above, below or beside
   it, and overlapping it the other way) takes that piece's anchor, so a
   stack built by hand keeps together when the window changes size. */
var HOME_KIN = 40;
/* The glide from where a piece was let go to where it lands. */
var HOME_GLIDE_MS = 120;
/* The Edit control in the bottom-left corner is kept clear: no piece may
   sit on it, so it is always there to press. Wide enough for "Done". */
var HOME_EDIT_RESERVE = { left: 16, bottom: 12, width: 72, height: 28 };

var homeConfirmed = null;   // the layout the chrome last pushed (or ?home=)
var homeDrawn = null;       // the layout on screen; null before the first draw
var homeSeq = 0;            // this page's request counter
var homeWaitSeq = 0;        // the request still waiting for its answer, or 0
var homeWaitTimer = 0;
var homeNoteTimer = 0;
var homeSticky = '';        // the note that stays while it is true (the fold)
var homeEditing = false;
var homeDrag = null;
var homeBoxes = Object.create(null);
var homeLayerEl = null;
var homeGuideX = null;
var homeGuideY = null;
var homeObserver = null;
var homeLayoutFrame = 0;
var homeFree = false;       // pieces absolutely placed right now
var homeFolded = false;     // free was wanted but did not fit: the flow is drawn
var homeRects = Object.create(null);   // id -> rect on the page, as drawn free
var homePage = null;        // { width, height } the free rects are on
var homeFlow = Object.create(null);    // id -> the rect the flow gives it (its default)
var homeWatching = false;
var homeYield = [];         // pieces just shown: they make room, not take it
var homeKeyTimer = 0;
var homeKeyOp = null;

/** The element of one piece, wherever it is (a column, the stats card, the shelf). */
function homePieceEl(id) {
  return document.querySelector('.home [data-piece="' + id + '"], #home-shelf [data-piece="' + id + '"]');
}

function homeColumnEl(name) {
  return document.querySelector('.home [data-column="' + name + '"]');
}

/**
 * Whether a piece is on the page. True for everything until a layout has
 * been drawn, and for everything when the rules did not load: a Home that
 * cannot be customised shows (and runs) all of itself, as it always did.
 */
function homePieceVisible(id) {
  if (!homeDrawn) return true;
  return homeDrawn.hidden.indexOf(id) < 0;
}

function homeIsPlaced(layout, id) {
  return !!layout && layout.place.some(function (p) { return p.id === id; });
}

/** The dock rides inside the stats card until it is moved on its own. */
function homeDockInside(layout) {
  return layout.hidden.indexOf('stats') < 0 && !homeIsPlaced(layout, 'apps');
}

/**
 * Put every element in its own place in the document: its default column,
 * in default order, the dock inside the stats card or right after it, and
 * a hidden piece on the shelf. Moves only what is out of place, so a push
 * that changes one piece leaves every other node (and whatever has the
 * keyboard inside it) alone. WHERE a piece shows on a free page is not the
 * document's business: that is layoutHome().
 */
function placeHomePieces(layout) {
  const shelf = document.getElementById('home-shelf');
  const statsEl = homePieceEl('stats');
  const inside = homeDockInside(layout);
  for (const name of HL.COLUMNS) {
    const col = homeColumnEl(name);
    if (!col) continue;
    let last = null;
    for (const p of HL.PIECES) {
      if (p.column !== name || layout.hidden.indexOf(p.id) >= 0) continue;
      const el = homePieceEl(p.id);
      if (!el) continue;
      if (p.id === 'apps' && inside && statsEl) {
        if (el.parentNode !== statsEl || statsEl.lastElementChild !== el) statsEl.appendChild(el);
        el.classList.remove('is-alone');
        continue;
      }
      const want = last ? last.nextElementSibling : col.firstElementChild;
      if (el.parentNode !== col || want !== el) col.insertBefore(el, want);
      if (p.id === 'apps') el.classList.add('is-alone');
      last = el;
    }
  }
  if (shelf) {
    for (const id of layout.hidden) {
      const el = homePieceEl(id);
      if (el && el.parentNode !== shelf) shelf.appendChild(el);
    }
  }
}

/**
 * Draw one layout. Pure on the layout (sanitised here, whatever came in),
 * and the one place a piece starts or stops its own work.
 */
function renderHome(layout) {
  if (!HL) return;
  const next = HL.sanitize(layout);
  const before = homeDrawn || HL.defaults();
  const same = homeDrawn && JSON.stringify(next) === JSON.stringify(homeDrawn);
  // The markup is the default arrangement: the first draw of a default
  // layout moves nothing at all.
  const firstDraw = !homeDrawn;
  const untouched = firstDraw && HL.isDefault(next);
  if (!same && !untouched) {
    const focused = document.activeElement;
    placeHomePieces(next);
    // A move takes the keyboard from whatever it moved; give it back, but
    // only when this page had it (never steal it from the address bar).
    if (focused && focused !== document.body && focused.isConnected &&
        document.activeElement !== focused && document.hasFocus() &&
        !focused.closest('#home-shelf')) {
      try { focused.focus({ preventScroll: true }); } catch (err) { /* gone */ }
    }
  }
  // A piece that has just come back makes room rather than taking it:
  // whatever was put there while it was away keeps its spot.
  if (!firstDraw) {
    homeYield = before.hidden.filter(function (id) { return next.hidden.indexOf(id) < 0; });
  }
  homeDrawn = next;
  if (!same) layoutHome();
  homeYield = [];

  for (const p of HL.PIECES) {
    const was = before.hidden.indexOf(p.id) < 0;
    const now = next.hidden.indexOf(p.id) < 0;
    // The first draw only has to stop what a hidden piece would start; init()
    // starts everything else right after this.
    if (firstDraw ? !now : (was !== now || !same)) homePieceMoved(p.id, now);
  }
  // The markets tile listens for this; it lives in its own closure.
  try { window.dispatchEvent(new Event('homelayout')); } catch (err) { /* old engine */ }
  refreshHomeEdit();
}

/** A piece was shown, hidden or moved: start, stop or resize its work. */
function homePieceMoved(id, visible) {
  if (id === 'clock') {
    if (visible) refreshClock();
    else if (clockTimer) { clearTimeout(clockTimer); clockTimer = 0; }
  } else if (id === 'media') {
    refreshMedia();          // scheduleMediaTick() reads homePieceVisible()
  } else if (id === 'stats') {
    if (visible) paintStats();   // its canvases are sized off the column
  }
}

/* --- free placement --------------------------------------------- */

/** The pieces a free draw lays out: every one that is on and has a size. */
function homeFreeIds(layout) {
  const inside = homeDockInside(layout);
  return HL.priority(layout).filter(function (id) {
    if (layout.hidden.indexOf(id) >= 0) return false;
    if (id === 'apps' && inside) return false;   // it is part of the stats card
    return true;
  });
}

/** A rect relative to the .home box (the page the free rects are on). */
function homeRel(r, h) {
  return { left: r.left - h.left, top: r.top - h.top, width: r.width, height: r.height };
}

/**
 * The height a piece takes up on a free page. The stats card's process
 * list unfolds over whatever is under it rather than shoving the page
 * around (and a long list may run past the window: the page scrolls then,
 * as it always did); so the card counts at its folded height.
 */
function homeRestHeight(id, el, r) {
  if (id !== 'stats' || !el.classList.contains('is-procs-open')) return r.height;
  const procs = el.querySelector('#procs');
  if (!procs || !procs.getClientRects().length) return r.height;
  return Math.max(0, r.height - procs.getBoundingClientRect().height);
}

/**
 * Lay the flow out unfolded and measure it: the size of every piece and
 * the rect a never-moved piece has. Leaves the page IN the flow (the
 * caller puts it back the same task, so this is never painted).
 */
function homeMeasure(ids) {
  const home = document.querySelector('.home');
  const root = document.documentElement;
  if (!home) return null;
  root.classList.add('home-measure');      // no scrollbar while measuring
  document.body.classList.add('home-unfold');
  home.classList.remove('is-free');
  for (const p of HL.PIECES) {
    const el = homePieceEl(p.id);
    // Its own width, not the last one pinned; and no left/top, which a
    // piece that is position: relative in the flow (.module) would wear.
    if (el) { el.style.width = ''; el.style.left = ''; el.style.top = ''; }
  }
  const h = home.getBoundingClientRect();
  const page = { width: root.clientWidth, height: root.clientHeight };
  const out = Object.create(null);
  for (const id of ids) {
    const el = homePieceEl(id);
    if (!el || !el.getClientRects().length) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;     // on, but nothing to draw yet
    const rel = homeRel(r, h);
    rel.height = homeRestHeight(id, el, r);
    out[id] = rel;
  }
  return { page: page, rects: out };
}

/** Back to the plain flow: no pinned piece, the fold free to fold. */
function homeUnfree() {
  const home = document.querySelector('.home');
  if (home) home.classList.remove('is-free');
  document.body.classList.remove('home-unfold');
  document.documentElement.classList.remove('home-measure');
  for (const p of HL.PIECES) {
    const el = homePieceEl(p.id);
    if (!el || !el.classList.contains('is-free-piece')) continue;
    el.classList.remove('is-free-piece');
    el.style.left = '';
    el.style.top = '';
    el.style.width = '';
  }
  homeFree = false;
  homeRects = Object.create(null);
  homePage = null;
}

/** The Edit control's corner, which no piece may cover. */
function homeEditReserve(page) {
  const r = HOME_EDIT_RESERVE;
  return { left: r.left, top: page.height - r.bottom - r.height, width: r.width, height: r.height };
}

/**
 * Where every piece goes on a free page, from a measure. Returns arrange()'s
 * answer ({ ok, rects, nudged, stuck }), the edit corner included as '_edit'.
 */
function homeArrange(layout, m, yieldIds) {
  const order = homeFreeIds(layout).filter(function (id) { return !!m.rects[id]; });
  const late = order.filter(function (id) { return yieldIds.indexOf(id) >= 0; });
  const items = [];
  const reserve = homeEditReserve(m.page);
  items.push({ id: '_edit', width: reserve.width, height: reserve.height, fixed: true,
               want: { left: reserve.left, top: reserve.top } });
  order.filter(function (id) { return late.indexOf(id) < 0; }).concat(late).forEach(function (id) {
    const r = m.rects[id];
    const at = HL.placeOf(layout, id);
    let size = { width: r.width, height: r.height };
    const want = at ? HL.rectAt(at, size, m.page) : r;
    items.push({ id: id, width: size.width, height: size.height,
                 want: { left: want.left, top: want.top } });
  });
  return HL.arrange(items, m.page, { reach: HL.REACH });
}

/**
 * Draw the layout on screen free, or as the flow: see the head of this
 * section. Synchronous, so a caller can read homeRects straight after.
 */
function layoutHome() {
  if (!HL || !homeDrawn) return;
  const home = document.querySelector('.home');
  if (!home) return;
  const wantFree = homeDrawn.place.length > 0 || homeEditing;
  if (!wantFree) {
    if (homeFree || homeFolded) homeUnfree();
    homeSetFolded(false);
    homeWatch();
    return;
  }
  // A guest in the background is 0 x 0: there is no page to place on yet.
  // The resize when it is shown brings it back here.
  if (!window.innerWidth || !window.innerHeight) return;

  const ids = homeFreeIds(homeDrawn);
  const m = homeMeasure(ids);
  if (!m) { homeUnfree(); return; }
  homeFlow = m.rects;
  const res = homeArrange(homeDrawn, m, homeYield);
  if (!res.ok) {
    homeUnfree();
    homeSetFolded(true);
    homeWatch();
    return;
  }
  for (const id of ids) {
    const el = homePieceEl(id);
    const r = res.rects[id];
    if (!el || !r) continue;
    el.classList.add('is-free-piece');
    // Exact, not rounded: a never-moved piece must land on the very
    // sub-pixel box the flow gave it, or its text could wrap differently.
    el.style.left = r.left + 'px';
    el.style.top = r.top + 'px';
    el.style.width = r.width + 'px';
  }
  home.classList.add('is-free');
  document.documentElement.classList.remove('home-measure');
  homeFree = true;
  homeRects = Object.create(null);
  for (const id of ids) if (res.rects[id]) homeRects[id] = res.rects[id];
  homePage = m.page;
  homeSetFolded(false);
  homeWatch();
}

/** The fold, said in words for as long as it lasts (never silently). */
function homeSetFolded(on) {
  homeFolded = !!on;
  const text = on
    ? (homeEditing
      ? 'This window is too small to move pieces: make it larger, or hide some'
      : 'Your Home layout needs a larger window, so it is in its usual order for now')
    : '';
  if (text === homeSticky) return;
  homeSticky = text;
  if (!homeNoteTimer) homeSay('', null);
}

function scheduleHomeLayout() {
  if (homeLayoutFrame) return;
  homeLayoutFrame = requestAnimationFrame(function () {
    homeLayoutFrame = 0;
    if (homeDrag && homeDrag.active) return;   // never re-lay the page under a drag
    layoutHome();
    if (homeEditing) placeHomeBoxes();
  });
}

/**
 * Sizes are watched only while something depends on them: a free page (a
 * card that grows may need its neighbours to make room) or edit mode (the
 * boxes follow their pieces). The default Home watches nothing.
 */
function homeWatch() {
  const want = homeFree || homeFolded || homeEditing;
  if (want === homeWatching) return;
  if (!homeObserver) {
    if (typeof ResizeObserver !== 'function') return;
    homeObserver = new ResizeObserver(scheduleHomeLayout);
  }
  homeWatching = want;
  if (!want) { homeObserver.disconnect(); return; }
  // Every piece, on or off, once: observe() reports each element straight
  // away, so re-observing on every draw would re-draw forever. A hidden
  // piece reports 0 x 0 and then its size when it comes back.
  for (const p of HL.PIECES) {
    const el = homePieceEl(p.id);
    if (el) homeObserver.observe(el);
  }
}

/* --- the channel ------------------------------------------------ */

/**
 * Ask for one change: drawn at once, sent to the chrome, and rolled back if
 * no answer comes. Returns true when a request went out. `base` is the
 * layout the change applies to (the one on screen unless said).
 */
function homeAsk(op, base) {
  if (!HL) return false;
  const from = base || homeDrawn || HL.defaults();
  const clean = HL.parseOp(op);
  const r = HL.apply(from, clean);
  if (!r.ok) { homeSay(r.reason, 'warn'); return false; }
  if (HL.same(r.layout, from)) return false;      // nothing would move
  homeSendNow();                                   // a waiting arrow burst goes first
  homeSeq += 1;
  homeWaitSeq = homeSeq;
  if (!HL.same(r.layout, homeDrawn)) renderHome(r.layout);
  console.log('newtab:home ' + JSON.stringify(Object.assign({}, clean, { seq: homeSeq })));
  if (homeWaitTimer) clearTimeout(homeWaitTimer);
  homeWaitTimer = setTimeout(homeNoAnswer, HOME_ANSWER_MS);
  return true;
}

/**
 * The arrow keys' change: drawn at once, sent once the presses stop, so a
 * held key is one request rather than thirty a second.
 */
function homeAskSoon(op) {
  const r = HL.apply(homeDrawn, op);
  if (!r.ok || HL.same(r.layout, homeDrawn)) return;
  if (homeKeyOp && homeKeyOp.op.id !== op.id) homeSendNow();   // one request per piece
  if (!homeKeyOp) homeKeyOp = { base: homeDrawn };
  homeKeyOp.op = op;
  renderHome(r.layout);
  if (homeKeyTimer) clearTimeout(homeKeyTimer);
  homeKeyTimer = setTimeout(homeSendNow, HOME_KEY_SEND_MS);
}

function homeSendNow() {
  if (homeKeyTimer) { clearTimeout(homeKeyTimer); homeKeyTimer = 0; }
  const pending = homeKeyOp;
  homeKeyOp = null;
  if (pending) homeAsk(pending.op, pending.base);
}

function homeNoAnswer() {
  homeWaitTimer = 0;
  homeWaitSeq = 0;
  renderHome(homeConfirmed || HL.defaults());
  homeSay('Not saved: the browser did not answer, so the Home is back as it was', 'warn');
}

/**
 * The chrome's push. While a request is out, only ITS answer is drawn (a
 * plain push in between is the store's echo of a step on the way, and the
 * answer that follows carries the whole truth); otherwise every push is.
 */
window.__applyHomeLayout = function (layout, meta) {
  if (!HL) return;
  const next = HL.sanitize(layout);
  homeConfirmed = next;
  const ack = (meta && typeof meta === 'object' && Number.isInteger(meta.ack)) ? meta.ack : 0;
  if (homeWaitSeq) {
    if (ack !== homeWaitSeq) return;
    clearTimeout(homeWaitTimer);
    homeWaitTimer = 0;
    homeWaitSeq = 0;
    if (meta.ok === false) {
      homeSay('Not saved: ' + (meta.reason || 'the browser refused the change'), 'warn');
    }
  }
  if (homeKeyOp) return;   // an arrow burst is still being drawn; its answer redraws
  renderHome(next);
};

/** The layout on screen, for tests. */
window.__home = function () {
  const rects = {};
  for (const id in homeRects) {
    const r = homeRects[id];
    rects[id] = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  }
  return {
    drawn: homeDrawn,
    confirmed: homeConfirmed,
    waiting: homeWaitSeq,
    editing: homeEditing,
    free: homeFree,
    folded: homeFolded,
    page: homePage,
    rects: rects,
    rules: !!HL
  };
};

/** One line of state, in words, over the pencil. Empty text clears it. */
function homeSay(text, tone) {
  const note = document.getElementById('home-note');
  if (!note) return;
  if (homeNoteTimer) { clearTimeout(homeNoteTimer); homeNoteTimer = 0; }
  const shown = text || homeSticky;
  note.textContent = shown || '';
  note.hidden = !shown;
  // The standing note is a state, not an error: it is said in the quiet tone.
  const t = text ? tone : null;
  if (t) note.setAttribute('data-tone', t);
  else note.removeAttribute('data-tone');
  if (text) {
    homeNoteTimer = setTimeout(function () {
      homeNoteTimer = 0;
      homeSay('', null);   // back to the standing note, if there is one
    }, HOME_NOTE_MS);
  }
}

/* --- edit mode -------------------------------------------------- */

function setHomeEditing(on) {
  if (!HL) {
    homeSay('Customizing is unavailable: the layout rules (homelayout.js) did not load', 'warn');
    return;
  }
  on = !!on;
  if (on === homeEditing) return;
  homeSendNow();
  homeEditing = on;
  const home = document.querySelector('.home');
  const btn = document.getElementById('home-edit-btn');
  const tray = document.getElementById('home-tray');
  if (home) home.classList.toggle('is-editing', on);
  if (btn) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Done' : 'Customize Home';
    btn.setAttribute('aria-label', on ? 'Done customizing' : 'Customize Home');
  }
  if (tray) tray.hidden = !on;
  if (!on) endHomeDrag(false);
  ensureHomeLayer();
  if (homeLayerEl) homeLayerEl.hidden = !on;
  // Edit mode is always a free page (when it fits), so a drag has a canvas
  // to land on; leaving it with nothing moved gives the flow back.
  layoutHome();
  refreshHomeEdit();
}

/** The layer of boxes, built once, the first time edit mode opens. */
function ensureHomeLayer() {
  if (homeLayerEl || !HL) return;
  const home = document.querySelector('.home');
  if (!home) return;
  homeLayerEl = document.createElement('div');
  homeLayerEl.className = 'home-layer';
  homeLayerEl.hidden = true;
  for (const p of HL.PIECES) {
    const box = document.createElement('div');
    box.className = 'home-box';
    box.setAttribute('data-for', p.id);
    box.hidden = true;

    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'home-box-tag';
    tag.title = 'Drag to move ' + p.label + ' anywhere (arrow keys too; hold Alt to skip snapping)';
    tag.setAttribute('aria-label',
      'Move ' + p.label + ': arrow keys move it, Shift for big steps, Alt for one pixel, Delete hides it');
    tag.innerHTML =
      '<svg class="home-box-grip" viewBox="0 0 8 10" aria-hidden="true" focusable="false">' +
      '<circle cx="2" cy="2" r="1" fill="currentColor"/><circle cx="6" cy="2" r="1" fill="currentColor"/>' +
      '<circle cx="2" cy="5" r="1" fill="currentColor"/><circle cx="6" cy="5" r="1" fill="currentColor"/>' +
      '<circle cx="2" cy="8" r="1" fill="currentColor"/><circle cx="6" cy="8" r="1" fill="currentColor"/></svg>';
    const name = document.createElement('span');
    name.className = 'home-box-name';
    name.textContent = p.label;
    tag.appendChild(name);
    tag.addEventListener('keydown', function (ev) { homeKey(p.id, ev); });

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'home-box-x';
    x.textContent = '×';
    x.title = 'Hide ' + p.label;
    x.setAttribute('aria-label', 'Hide ' + p.label);
    x.addEventListener('click', function (ev) {
      ev.stopPropagation();
      homeAsk({ op: 'hide', id: p.id });
    });

    box.appendChild(tag);
    box.appendChild(x);
    box.addEventListener('pointerdown', onHomeBoxDown);
    box.addEventListener('pointermove', onHomeBoxMove);
    box.addEventListener('pointerup', onHomeBoxUp);
    box.addEventListener('pointercancel', function () { endHomeDrag(false); });
    box.addEventListener('lostpointercapture', function () { endHomeDrag(false); });
    homeLayerEl.appendChild(box);
    homeBoxes[p.id] = box;
  }
  home.appendChild(homeLayerEl);

  // The snapping guides: one hairline across the page each way, shown only
  // while a drag is stuck to one. Fixed, like the landing outline.
  homeGuideX = document.createElement('div');
  homeGuideX.className = 'home-guide home-guide-x';
  homeGuideX.hidden = true;
  homeGuideY = document.createElement('div');
  homeGuideY.className = 'home-guide home-guide-y';
  homeGuideY.hidden = true;
  document.body.appendChild(homeGuideX);
  document.body.appendChild(homeGuideY);
}

/** The tray and the boxes, after any change. */
function refreshHomeEdit() {
  if (!HL || !homeDrawn) return;
  const list = document.getElementById('home-tray-list');
  const none = document.getElementById('home-tray-empty');
  const reset = document.getElementById('home-tray-reset');
  if (list) {
    list.textContent = '';
    for (const p of HL.PIECES) {
      if (homeDrawn.hidden.indexOf(p.id) < 0) continue;
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'home-tray-add';
      b.textContent = '+ ' + p.label;
      b.title = p.hint + ' (comes back where it was, or the nearest free spot)';
      b.addEventListener('click', function () { homeShowPiece(p.id); });
      li.appendChild(b);
      list.appendChild(li);
    }
  }
  if (none) none.hidden = homeDrawn.hidden.length > 0;
  if (reset) reset.disabled = HL.isDefault(homeDrawn);
  if (homeEditing) placeHomeBoxes();
  placeHomeEditControl();
}

/**
 * The tray opens above the Done button, in the bottom-left corner — which
 * is now a corner a piece may be put in. When the tray would cover a
 * piece there, it opens to the right of the button instead (whichever of
 * the two covers less), so a piece in that corner can still be grabbed.
 */
function placeHomeEditControl() {
  const ctl = document.getElementById('home-edit');
  const tray = document.getElementById('home-tray');
  const home = document.querySelector('.home');
  if (!ctl) return;
  ctl.classList.remove('is-side');
  if (!homeEditing || !homeFree || !tray || tray.hidden || !home) return;
  const h = home.getBoundingClientRect();
  const covered = function () {
    const t = tray.getBoundingClientRect();
    let area = 0;
    for (const id in homeRects) {
      const r = homeRects[id];
      const l = Math.max(t.left, h.left + r.left - HOME_BOX_PAD);
      const rr = Math.min(t.right, h.left + r.left + r.width + HOME_BOX_PAD);
      const tp = Math.max(t.top, h.top + r.top - HOME_BOX_PAD);
      const b = Math.min(t.bottom, h.top + r.top + r.height + HOME_BOX_PAD);
      if (rr > l && b > tp) area += (rr - l) * (b - tp);
    }
    return area;
  };
  const above = covered();
  if (!above) return;
  ctl.classList.add('is-side');
  if (covered() >= above) ctl.classList.remove('is-side');
}

/**
 * Put a piece back from the tray: where it last was, or its default spot,
 * or the free spot nearest to that. The page is the only side that can
 * see where there is room, so it works the spot out (by drawing the piece
 * with it yielding to everything already there) and asks for exactly that.
 */
function homeShowPiece(id) {
  if (!homeDrawn) return;
  const base = homeDrawn;
  const trial = HL.apply(base, { op: 'show', id: id });
  if (!trial.ok) { homeSay(trial.reason, 'warn'); return; }
  renderHome(trial.layout);            // lays it out yielding (renderHome sees it come back)
  const r = homeFree ? homeRects[id] : null;
  const had = HL.placeOf(base, id);
  const op = { op: 'show', id: id };
  if (r && homePage) {
    // A never-moved piece that got its own default spot stays never-moved
    // (it keeps following the default arrangement); anything else is
    // pinned where it actually landed.
    const m = homeFlow[id];
    const atDefault = !had && m && Math.abs(m.left - r.left) < 1 && Math.abs(m.top - r.top) < 1;
    if (!atDefault) op.at = homeAnchor(id, r);
  }
  homeAsk(op, base);
}

function scheduleHomeBoxes() {
  scheduleHomeLayout();
}

/** The rect a piece answers to: the stats card stops where the dock in it starts. */
function homePieceRect(id) {
  const el = homePieceEl(id);
  if (!el || !el.getClientRects().length) return null;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  if (id === 'stats') {
    const dock = homePieceEl('apps');
    if (dock && dock.parentNode === el && homePieceVisible('apps')) {
      const d = dock.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: d.top - 4,
               width: r.width, height: Math.max(0, d.top - 4 - r.top) };
    }
  }
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

function placeHomeBoxes() {
  if (!homeLayerEl || !homeDrawn) return;
  const home = document.querySelector('.home');
  if (!home) return;
  const h = home.getBoundingClientRect();
  for (const p of HL.PIECES) {
    const box = homeBoxes[p.id];
    if (!box) continue;
    if (homeDrag && homeDrag.id === p.id && homeDrag.active) continue;   // it follows the pointer
    const r = homePieceVisible(p.id) ? homePieceRect(p.id) : null;
    // A piece that is on but has nothing to draw yet (session before its
    // first readout) has no box; its switch in Settings still reaches it.
    if (!r) { box.hidden = true; continue; }
    box.hidden = false;
    box.style.transform = '';
    box.style.left = Math.round(r.left - h.left - HOME_BOX_PAD) + 'px';
    box.style.top = Math.round(r.top - h.top - HOME_BOX_PAD) + 'px';
    box.style.width = Math.round(r.width + HOME_BOX_PAD * 2) + 'px';
    box.style.height = Math.round(r.height + HOME_BOX_PAD * 2) + 'px';
  }
}

/* --- dragging --------------------------------------------------- */

/**
 * The rect a piece occupies on the free page right now, and the size it
 * will have once placed. The dock inside the stats card is the one piece
 * that changes size when it moves: on its own it is a card, as wide as
 * the stats card and with the card's padding.
 */
function homeDragStart(id) {
  const home = document.querySelector('.home');
  if (!home || !homeFree || !homePage) return null;
  const h = home.getBoundingClientRect();
  if (homeRects[id]) {
    const r = homeRects[id];
    return { from: { left: r.left, top: r.top, width: r.width, height: r.height }, size: { width: r.width, height: r.height } };
  }
  if (id === 'apps') {
    const el = homePieceEl('apps');
    const st = homeRects.stats;
    if (!el || !st || !el.getClientRects().length) return null;
    const d = homeRel(el.getBoundingClientRect(), h);
    // Lifted out, it is a card as wide as the stats card and lined up with
    // it, so it starts from there rather than from its inset in the card.
    const size = { width: st.width, height: d.height + 34 };
    return { from: { left: st.left, top: d.top, width: size.width, height: size.height }, size: size };
  }
  return null;
}

/**
 * The anchor to store for a piece put down at `r`: the one it is nearest
 * to, unless it was put down against another piece, in which case it
 * shares that piece's anchor on that axis (a search box dropped under the
 * Q follows the Q; a card dropped beside another follows it).
 */
function homeAnchor(id, r) {
  const page = homePage;
  let nearV = null;
  let nearH = null;
  for (const other in homeRects) {
    if (other === id) continue;
    const o = homeRects[other];
    const overX = Math.min(r.left + r.width, o.left + o.width) - Math.max(r.left, o.left);
    const overY = Math.min(r.top + r.height, o.top + o.height) - Math.max(r.top, o.top);
    const gapY = Math.max(o.top - (r.top + r.height), r.top - (o.top + o.height));
    const gapX = Math.max(o.left - (r.left + r.width), r.left - (o.left + o.width));
    if (overX > 0 && gapY >= 0 && gapY <= HOME_KIN && (!nearV || gapY < nearV.gap)) nearV = { gap: gapY, id: other };
    if (overY > 0 && gapX >= 0 && gapX <= HOME_KIN && (!nearH || gapX < nearH.gap)) nearH = { gap: gapX, id: other };
  }
  const anchorOfPiece = function (other) {
    return HL.placeOf(homeDrawn, other) || HL.anchorOf(homeRects[other], page);
  };
  return HL.anchorOf(r, page, nearH ? anchorOfPiece(nearH.id).h : null,
                     nearV ? anchorOfPiece(nearV.id).v : null);
}

/** Everything a dragged piece must keep clear of. */
function homeObstacles(id) {
  const out = [homeEditReserve(homePage)];
  for (const other in homeRects) {
    if (other !== id) out.push(homeRects[other]);
  }
  return out;
}

/**
 * Snap a rect to the guides: the page's centre lines and 24px margins,
 * and every other piece's edges and centres (and a 16px gap beside it).
 * Returns { left, top, gx, gy } where gx/gy is the guide stuck to, or null.
 */
function homeSnap(r, others, page) {
  const xs = [{ v: page.width / 2, k: 'any' }, { v: HOME_EDGE, k: 'lead' }, { v: page.width - HOME_EDGE, k: 'trail' }];
  const ys = [{ v: page.height / 2, k: 'any' }, { v: HOME_EDGE, k: 'lead' }, { v: page.height - HOME_EDGE, k: 'trail' }];
  for (const o of others) {
    xs.push({ v: o.left, k: 'any' }, { v: o.left + o.width / 2, k: 'any' }, { v: o.left + o.width, k: 'any' },
            { v: o.left + o.width + HOME_SNAP_GAP, k: 'lead' }, { v: o.left - HOME_SNAP_GAP, k: 'trail' });
    ys.push({ v: o.top, k: 'any' }, { v: o.top + o.height / 2, k: 'any' }, { v: o.top + o.height, k: 'any' },
            { v: o.top + o.height + HOME_SNAP_GAP, k: 'lead' }, { v: o.top - HOME_SNAP_GAP, k: 'trail' });
  }
  const pick = function (start, size, lines) {
    const pts = [{ off: 0, k: 'lead' }, { off: size / 2, k: 'mid' }, { off: size, k: 'trail' }];
    let best = null;
    for (const g of lines) {
      for (const p of pts) {
        if (g.k !== 'any' && g.k !== p.k) continue;
        const d = g.v - (start + p.off);
        if (Math.abs(d) <= HOME_SNAP && (!best || Math.abs(d) < Math.abs(best.d))) best = { d: d, v: g.v };
      }
    }
    return best;
  };
  const bx = pick(r.left, r.width, xs);
  const by = pick(r.top, r.height, ys);
  return {
    left: r.left + (bx ? bx.d : 0),
    top: r.top + (by ? by.d : 0),
    gx: bx ? bx.v : null,
    gy: by ? by.v : null
  };
}

/**
 * Where a drag would land: snapped (unless Alt), pulled inside the page,
 * and moved to the nearest free spot within reach when its own is taken.
 * { rect, ok, gx, gy }: ok false means there is no room there at all.
 */
function homeLanding(d, left, top, free) {
  const page = homePage;
  let r = { left: left, top: top, width: d.size.width, height: d.size.height };
  let gx = null;
  let gy = null;
  if (!free) {
    const s = homeSnap(r, d.others, page);
    r.left = s.left; r.top = s.top; gx = s.gx; gy = s.gy;
  }
  if (!HL.fitsPage(r, page)) return { rect: r, ok: false, gx: null, gy: null };
  const c = HL.clampRect(r, page);
  if (c.left !== r.left) gx = null;
  if (c.top !== r.top) gy = null;
  r = c;
  if (HL.hitsAny(r, d.others)) {
    const n = HL.nearestFree(r, d.others, page, { reach: HL.REACH });
    if (!n) return { rect: r, ok: false, gx: null, gy: null };
    if (n.left !== r.left) gx = null;
    if (n.top !== r.top) gy = null;
    r = n;
  }
  return { rect: r, ok: true, gx: gx, gy: gy };
}

function onHomeBoxDown(ev) {
  if (!homeEditing || ev.button !== 0) return;
  if (ev.target && ev.target.closest && ev.target.closest('.home-box-x')) return;
  const box = ev.currentTarget;
  const id = box.getAttribute('data-for');
  if (!HL.isPiece(id)) return;
  homeSendNow();
  homeDrag = { id: id, box: box, pointerId: ev.pointerId, x0: ev.clientX, y0: ev.clientY,
               active: false, start: null, landing: null };
  try { box.setPointerCapture(ev.pointerId); } catch (err) { /* no capture: still works inside the box */ }
  ev.preventDefault();
}

function onHomeBoxMove(ev) {
  const d = homeDrag;
  if (!d || ev.pointerId !== d.pointerId) return;
  if (!d.active) {
    if (Math.abs(ev.clientX - d.x0) + Math.abs(ev.clientY - d.y0) < HOME_DRAG_SLOP) return;
    const s = homeDragStart(d.id);
    if (!s) {
      // No free page (the window is too small for one): nothing to move on.
      homeSay(homeFolded ? homeSticky : 'This piece cannot be moved right now', 'warn');
      endHomeDrag(false);
      return;
    }
    d.active = true;
    d.start = s.from;
    d.size = s.size;
    d.others = homeObstacles(d.id);
    d.box.classList.add('is-dragging');
    const el = homePieceEl(d.id);
    if (el) el.classList.add('is-lifted');
    const home = document.querySelector('.home');
    if (home) home.classList.add('is-dragging');
  }
  const dx = ev.clientX - d.x0;
  const dy = ev.clientY - d.y0;
  // The piece itself follows the pointer; the outline shows where it lands.
  const el = homePieceEl(d.id);
  if (el) el.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
  d.box.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
  d.landing = homeLanding(d, d.start.left + dx, d.start.top + dy, ev.altKey);
  drawHomeLanding(d.landing);
}

function onHomeBoxUp(ev) {
  const d = homeDrag;
  if (!d || ev.pointerId !== d.pointerId) return;
  const landing = d.active ? d.landing : null;
  const id = d.id;
  const el = homePieceEl(id);
  // Where the piece is on screen right now (start + the pointer's travel).
  const seen = el && d.active ? el.getBoundingClientRect() : null;
  endHomeDrag(false, true);
  if (!d.active) return;
  if (!landing || !landing.ok) {
    if (el && seen) homeGlideFrom(el, seen);
    homeSay('No room there: a piece cannot sit on another one or off the page', 'warn');
    return;
  }
  const at = homeAnchor(id, landing.rect);
  if (el) el.style.transform = '';
  homeAsk({ op: 'place', id: id, at: at });
  if (el && seen) homeGlideFrom(el, seen);
}

/**
 * Glide a piece from where it was seen to where it is now: the two are
 * different boxes for one frame, then the piece slides the difference.
 * Under HOME_GLIDE_MS, and not at all with reduced motion.
 */
function homeGlideFrom(el, seen) {
  el.style.transition = 'none';
  el.style.transform = '';
  let reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (err) { reduce = false; }
  const now = el.getBoundingClientRect();
  const dx = seen.left - now.left;
  const dy = seen.top - now.top;
  if (reduce || (Math.abs(dx) < 1 && Math.abs(dy) < 1)) { el.style.transition = ''; return; }
  el.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
  void el.offsetWidth;   // the start of the glide is this frame's box
  el.style.transition = 'transform ' + HOME_GLIDE_MS + 'ms var(--ease)';
  el.style.transform = '';
  setTimeout(function () { el.style.transition = ''; scheduleHomeLayout(); }, HOME_GLIDE_MS + 40);
}

/** Put everything a drag changed back. `cancelled` only matters for the note. */
function endHomeDrag(cancelled, keepPiece) {
  const d = homeDrag;
  homeDrag = null;
  drawHomeLanding(null);
  const home = document.querySelector('.home');
  if (home) home.classList.remove('is-dragging');
  if (!d) return;
  d.box.classList.remove('is-dragging');
  d.box.style.transform = '';
  const el = homePieceEl(d.id);
  if (el) {
    el.classList.remove('is-lifted');
    if (!keepPiece) {
      if (d.active && cancelled) {
        const seen = el.getBoundingClientRect();
        homeGlideFrom(el, seen);
      } else {
        el.style.transform = '';
      }
    }
  }
  try { d.box.releasePointerCapture(d.pointerId); } catch (err) { /* already released */ }
  if (cancelled && d.active) homeSay('Move cancelled');
  placeHomeBoxes();
}

/** The landing outline and the guides: fixed, in window coordinates. */
function drawHomeLanding(t) {
  const drop = document.getElementById('home-drop');
  const home = document.querySelector('.home');
  const h = home ? home.getBoundingClientRect() : { left: 0, top: 0 };
  if (drop) {
    if (!t) {
      drop.hidden = true;
    } else {
      drop.style.left = Math.round(h.left + t.rect.left) + 'px';
      drop.style.top = Math.round(h.top + t.rect.top) + 'px';
      drop.style.width = Math.round(t.rect.width) + 'px';
      drop.style.height = Math.round(t.rect.height) + 'px';
      drop.setAttribute('data-state', t.ok ? 'ok' : 'no');
      drop.hidden = false;
    }
  }
  if (homeGuideX) {
    const on = !!(t && t.ok && t.gx != null);
    homeGuideX.hidden = !on;
    if (on) homeGuideX.style.left = Math.round(h.left + t.gx) + 'px';
  }
  if (homeGuideY) {
    const on = !!(t && t.ok && t.gy != null);
    homeGuideY.hidden = !on;
    if (on) homeGuideY.style.top = Math.round(h.top + t.gy) + 'px';
  }
}

/**
 * The keyboard's move: arrows nudge (Shift for a big step, Alt for one
 * pixel), straight over a piece in the way to the first room past it;
 * Delete hides.
 */
function homeKey(id, ev) {
  if (!homeEditing || !homeDrawn) return;
  const key = ev.key;
  if (key === 'Delete' || key === 'Backspace') {
    ev.preventDefault();
    homeAsk({ op: 'hide', id: id });
    return;
  }
  const dir = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[key];
  if (!dir) return;
  ev.preventDefault();
  const s = homeDragStart(id);
  if (!s) { homeSay(homeFolded ? homeSticky : 'This piece cannot be moved right now', 'warn'); return; }
  const step = ev.shiftKey ? HOME_STEP_BIG : (ev.altKey ? 1 : HOME_STEP);
  const page = homePage;
  const others = homeObstacles(id);
  const r = { left: s.from.left, top: s.from.top, width: s.size.width, height: s.size.height };
  const next = HL.clampRect({ left: r.left + dir[0] * step, top: r.top + dir[1] * step,
                              width: r.width, height: r.height }, page);
  let landed = HL.hitsAny(next, others) ? null : next;
  if (!landed) {
    // Past whatever is in the way: the first spot along this line that is free.
    const along = [];
    for (const o of others) {
      if (dir[0] > 0) along.push(o.left + o.width + HL.GAP);
      if (dir[0] < 0) along.push(o.left - HL.GAP - r.width);
      if (dir[1] > 0) along.push(o.top + o.height + HL.GAP);
      if (dir[1] < 0) along.push(o.top - HL.GAP - r.height);
    }
    const cur = dir[0] ? next.left : next.top;
    along.filter(function (v) { return dir[0] + dir[1] > 0 ? v > cur : v < cur; })
      .sort(function (a, b) { return dir[0] + dir[1] > 0 ? a - b : b - a; })
      .some(function (v) {
        const c = HL.clampRect({ left: dir[0] ? v : next.left, top: dir[1] ? v : next.top,
                                 width: r.width, height: r.height }, page);
        if ((dir[0] ? c.left : c.top) !== v || HL.hitsAny(c, others)) return false;
        landed = c;
        return true;
      });
  }
  if (!landed || (Math.abs(landed.left - r.left) < 0.5 && Math.abs(landed.top - r.top) < 0.5)) {
    homeSay('No room further that way', 'warn');
    return;
  }
  homeAskSoon({ op: 'place', id: id, at: homeAnchor(id, landed) });
  // The grip keeps the keyboard across the redraw.
  const box = homeBoxes[id];
  const tag = box && box.querySelector('.home-box-tag');
  if (tag && document.activeElement !== tag) {
    try { tag.focus({ preventScroll: true }); } catch (err) { /* gone */ }
  }
}

/** Wire the pencil, the tray and Esc, and draw the first layout. */
function initHome(params) {
  const btn = document.getElementById('home-edit-btn');
  if (btn) btn.addEventListener('click', function () { setHomeEditing(!homeEditing); });
  if (!HL) return;   // the pencil says why when pressed; the page stays as it is

  let first = null;
  const raw = params ? params.get('home') : null;
  if (raw) {
    try { first = JSON.parse(raw); } catch (err) { first = null; }
  }
  homeConfirmed = HL.sanitize(first);
  renderHome(homeConfirmed);

  const reset = document.getElementById('home-tray-reset');
  if (reset) reset.addEventListener('click', function () { homeAsk({ op: 'reset' }); });

  document.addEventListener('keydown', function (ev) {
    if (!homeEditing) return;
    if (ev.key !== 'Escape' && ev.key !== 'Esc') return;
    ev.preventDefault();
    if (homeDrag && homeDrag.active) { endHomeDrag(true); return; }
    setHomeEditing(false);
  });

  // The window is the page: a free Home re-lays itself on every resize
  // (the anchors hold, and it folds when there is no room). The flow needs
  // nothing, so a default Home does nothing here.
  window.addEventListener('resize', function () {
    if (homeFree || homeFolded || homeEditing) scheduleHomeLayout();
  });
}

function readParams() {
  try {
    return new URLSearchParams(window.location.search);
  } catch (err) {
    return null;
  }
}

function init() {
  const params = readParams();
  /* The layout first: every piece is in its place (and a hidden one has
     stopped its work) before anything below measures or starts a timer. */
  initHome(params);
  setChips(params ? parseChipsParam(params.get('chips')) : null);
  /* ?bg= is a first-paint hint only: the kind, painted as the plain --bg
     until the chrome's push brings the picture itself (never a URL here). */
  applyBackground({ kind: params ? params.get('bg') : null, state: 'loading' });
  watchTheme();
  wireSearch(params ? params.get('engine') : null);

  /* The empty instrument: the baseline hairlines, drawn once so a page
     nobody has pushed a sample to still reads as an instrument rather
     than as five blank rectangles. The strip is already at its full
     height either way — the boxes are sized in CSS — so this changes
     no geometry. */
  paintStats();

  /* The process list in the same state: ten dashed rows at the height the
     real ten will wear, the sort the user last chose, and the "Show more"
     control holding its space. Nothing below this line changes the box. */
  wireProcs();

  /* The app dock, in the same state and for the same reason: the row keeps
     one tile-row of height before a single pin has arrived, so the card
     already wears the height it will keep. */
  wireDock();

  /* The Saved row: its caption and "+" are in the markup, so this only
     wires them, draws whatever push already landed, and starts the wait
     for the chrome's first list. */
  wireSaved();

  /* The idle-music module: it is inside a [hidden] tile until a push, so
     this changes no geometry — it only makes the Off state the module's own
     rather than the markup's, and hangs the two controls. */
  wireMusic();

  /* Now playing, in the same state and for the same reason: the tile is
     [hidden] until the chrome pushes, so this changes no geometry — it only
     makes the "nothing playing" face the module's own rather than the
     markup's, and hangs the three controls. */
  wireMedia();

  /* The canvases are a percentage of the column, so their backing store
     is wrong after a resize. One repaint, no rAF: nothing here animates. */
  window.addEventListener('resize', paintStats);

  /* The clock, painted before the first frame so it never shows dashes.
     The three listeners are the "back on screen" signals: a hidden page's
     timer was throttled, so coming back repaints and re-aligns. */
  paintClock();
  scheduleClock();
  document.addEventListener('visibilitychange', refreshClock);
  window.addEventListener('pageshow', refreshClock);
  window.addEventListener('focus', refreshClock);

  /* The now-playing hairline stops and starts on the same signals, for the
     same reason the clip does: a fill nobody can see is four style writes a
     second for nothing. refreshMedia() checks the state itself, so none of
     these starts a tick a paused session does not want. */
  document.addEventListener('visibilitychange', refreshMedia);
  window.addEventListener('pageshow', refreshMedia);
  window.addEventListener('focus', refreshMedia);

  /* The moving picture stops and starts on the same three signals, for the
     stronger reason: a clip nobody can see is a decoder nobody is watching.
     syncClip() is idempotent and checks every reason on its own, so none of
     these starts anything the chrome or a hidden page still vetoes. */
  document.addEventListener('visibilitychange', syncClip);
  window.addEventListener('pageshow', syncClip);
  window.addEventListener('focus', syncClip);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

/* ============================================================
   Markets — the bottom-right tile

   The only module on this page whose data comes straight from MAIN. stocks.js
   puts a console-message listener on this guest and answers the lines below;
   the chrome is not in the path at all, which is why nothing here looks like
   __applyStats's push.

     out   console.log('newtab:stocks {"action":…,"symbol":…}')
           subscribe | unsubscribe | select | add | remove | refresh
     in    window.__applyStocks(payload)

   The payload is the whole tile every time — rows, the selected symbol's
   series, the market session, the socket's health — because it arrives at
   most twice a second and a diff of forty numbers is not worth the bug.

   THE KEY IS NEVER IN IT. The page is told `hasKey` and nothing else; it
   cannot read, print or leak a key it was never given.

   REPAINT. PAINT_MS is the floor between two paints and every path goes
   through schedulePaint(), so a burst of trades at the open costs two paints
   a second, not forty. There is no requestAnimationFrame here, no CSS
   animation on the tile, and no timer at all while the page is hidden: the
   page unsubscribes on visibilitychange, which is what frees the websocket
   in main.
   ============================================================ */

(function () {
  /* Two paints a second, no more. See the block comment. */
  var PAINT_MS = 500;
  /* A price older than this reads as stale rather than as current. */
  var STALE_MS = 120000;
  /* The chart's own padding, in CSS pixels. */
  var CHART_PAD_X = 2;
  var CHART_PAD_Y = 6;

  var MARKET_LABEL = {
    pre: 'Pre-market',
    open: 'Open',
    after: 'After hours',
    closed: 'Closed'
  };

  var root = null;
  var noteEl = null;
  var marketEl = null;
  var rowsEl = null;
  var canvasEl = null;
  var emptyEl = null;
  var addBtn = null;
  var addField = null;
  var asOfEl = null;

  /** The last payload main sent, and whether it still needs painting. */
  var data = null;
  var paintTimer = 0;
  var lastPaintAt = 0;

  /** symbol -> { li, sym, last, chg, spark, drop } — rows are reused. */
  var rows = new Map();
  /** What the rows currently spell, so a list that did not change is not rebuilt. */
  var rowKey = '';

  /** Whether we have told main we are watching. */
  var watching = false;

  /* --- the channel --------------------------------------------- */

  function say(action, symbol) {
    var msg = { action: action };
    if (symbol) msg.symbol = symbol;
    console.log('newtab:stocks ' + JSON.stringify(msg));
  }

  function watch() {
    if (watching) return;
    watching = true;
    say('subscribe');
  }

  function unwatch() {
    if (!watching) return;
    watching = false;
    say('unsubscribe');
  }

  /* A hidden tab is a tab whose socket main should not be holding open. This
     is the same rule the clock, the clip and the now-playing hairline keep,
     and the strongest case of it: the other three cost a timer, this one
     costs a websocket and a REST budget. */
  function syncWatch() {
    if (!root) return;
    // Hidden on the Home is hidden: the socket in main is let go the same
    // way a background tab lets it go.
    if (document.hidden || !homePieceVisible('markets')) { unwatch(); return; }
    watch();
  }

  /* --- colours ------------------------------------------------- */

  /* Read off the tile rather than hard-coded, so a palette or a theme flip
     moves the chart with everything else. Cached per paint, not per point. */
  function tokens() {
    var css = window.getComputedStyle(root);
    return {
      up: css.getPropertyValue('--stk-up').trim() || '#7fb98f',
      down: css.getPropertyValue('--stk-down').trim() || '#c98b86',
      grid: css.getPropertyValue('--fg-3').trim() || '#a6abb5',
      flat: css.getPropertyValue('--fg-2').trim() || '#a6abb5'
    };
  }

  /* --- paint scheduling ---------------------------------------- */

  function schedulePaint() {
    if (paintTimer || document.hidden) return;
    var since = Date.now() - lastPaintAt;
    if (since >= PAINT_MS) { paint(); return; }
    paintTimer = setTimeout(function () {
      paintTimer = 0;
      paint();
    }, PAINT_MS - since);
  }

  /* --- the rows ------------------------------------------------ */

  function makeRow(symbol) {
    var li = document.createElement('li');

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stk-row';
    btn.setAttribute('data-symbol', symbol);

    var sym = document.createElement('span');
    sym.className = 'stk-sym';
    sym.textContent = symbol;
    btn.appendChild(sym);

    var spark = document.createElement('canvas');
    spark.className = 'stk-spark';
    spark.width = 120;
    spark.height = 32;
    spark.setAttribute('aria-hidden', 'true');
    btn.appendChild(spark);

    var last = document.createElement('span');
    last.className = 'stk-last';
    last.textContent = '--';
    btn.appendChild(last);

    var chg = document.createElement('span');
    chg.className = 'stk-chg';
    chg.textContent = '--';
    btn.appendChild(chg);

    var drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'stk-drop';
    drop.textContent = '×';
    drop.setAttribute('aria-label', 'Remove ' + symbol);
    btn.appendChild(drop);

    btn.addEventListener('click', function (ev) {
      if (ev.target === drop) return;             // the x has its own handler
      say('select', symbol);
    });
    drop.addEventListener('click', function (ev) {
      ev.stopPropagation();
      say('remove', symbol);
    });

    li.appendChild(btn);
    return { li: li, btn: btn, sym: sym, last: last, chg: chg, spark: spark, drop: drop };
  }

  /* The list is rebuilt only when the SYMBOLS change; a new price rewrites two
     text nodes and repaints one 120x32 canvas, and touches nothing else. */
  function syncRows(list) {
    var key = list.map(function (r) { return r.symbol; }).join(',');
    if (key === rowKey) return;
    rowKey = key;

    var seen = Object.create(null);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < list.length; i += 1) {
      var symbol = list[i].symbol;
      seen[symbol] = true;
      var rec = rows.get(symbol);
      if (!rec) { rec = makeRow(symbol); rows.set(symbol, rec); }
      frag.appendChild(rec.li);
    }
    rows.forEach(function (rec, symbol) {
      if (!seen[symbol]) rows.delete(symbol);
    });
    rowsEl.textContent = '';
    rowsEl.appendChild(frag);
  }

  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return '--';
    var abs = Math.abs(n);
    var places = abs >= 1000 ? 2 : (abs >= 1 ? 2 : 4);
    return n.toFixed(places);
  }

  function percent(n) {
    if (n === null || n === undefined || !isFinite(n)) return '--';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function clockOf(ms) {
    if (!ms) return '';
    try {
      return new Date(ms).toLocaleTimeString(undefined, {
        hour: 'numeric', minute: '2-digit', second: '2-digit'
      });
    } catch (err) {
      return '';
    }
  }

  /* --- canvas -------------------------------------------------- */

  /* Sized in device pixels off the CSS box, and only when that box actually
     changed: a setAttribute on width clears the canvas, so doing it every
     paint would be a full redraw of everything, every time. */
  function fitCanvas(canvas, cssW, cssH) {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(cssW * dpr));
    var h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return ctx;
  }

  function drawSpark(canvas, values, colour) {
    var box = canvas.getBoundingClientRect();
    var w = box.width || 120;
    var h = box.height || 16;
    var ctx = fitCanvas(canvas, w, h);
    if (!ctx || !values || values.length < 2) return;

    var lo = values[0];
    var hi = values[0];
    for (var i = 1; i < values.length; i += 1) {
      if (values[i] < lo) lo = values[i];
      if (values[i] > hi) hi = values[i];
    }
    var span = hi - lo;
    if (!(span > 0)) span = Math.abs(hi) * 0.001 || 1;

    var pad = 2;
    var innerH = h - pad * 2;
    ctx.beginPath();
    for (var j = 0; j < values.length; j += 1) {
      var x = (j / (values.length - 1)) * w;
      var y = pad + (1 - (values[j] - lo) / span) * innerH;
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = colour;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /* The selected symbol's day: the previous close as a dashed hairline, the
     line itself, and the area under it tinted by the day's sign. A line, a
     dash and a fill — no gradient stack, no glow, no second pass. */
  function drawChart(series, colours) {
    var box = canvasEl.getBoundingClientRect();
    var w = box.width || 352;
    var h = box.height || 66;
    var ctx = fitCanvas(canvasEl, w, h);
    if (!ctx) return false;

    var points = (series && series.points) || [];
    if (points.length < 2) return false;

    var prevClose = series.prevClose;
    var lo = points[0][1];
    var hi = points[0][1];
    for (var i = 1; i < points.length; i += 1) {
      if (points[i][1] < lo) lo = points[i][1];
      if (points[i][1] > hi) hi = points[i][1];
    }
    /* The previous close is part of the picture even when the day never
       traded back to it — otherwise the dashed line falls off the canvas. */
    if (prevClose !== null && prevClose !== undefined && isFinite(prevClose)) {
      if (prevClose < lo) lo = prevClose;
      if (prevClose > hi) hi = prevClose;
    }
    var span = hi - lo;
    if (!(span > 0)) span = Math.abs(hi) * 0.001 || 1;

    var left = CHART_PAD_X;
    var right = w - CHART_PAD_X;
    var top = CHART_PAD_Y;
    var bottom = h - CHART_PAD_Y;
    var innerW = right - left;
    var innerH = bottom - top;

    var xAt = function (idx) { return left + (idx / (points.length - 1)) * innerW; };
    var yAt = function (v) { return top + (1 - (v - lo) / span) * innerH; };

    var lastValue = points[points.length - 1][1];
    var base = (prevClose !== null && prevClose !== undefined && isFinite(prevClose))
      ? prevClose : points[0][1];
    var dir = lastValue > base ? 'up' : (lastValue < base ? 'down' : 'flat');
    var colour = dir === 'up' ? colours.up : (dir === 'down' ? colours.down : colours.flat);

    /* the area, first, so the line sits on top of its own tint */
    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(points[0][1]));
    for (var a = 1; a < points.length; a += 1) ctx.lineTo(xAt(a), yAt(points[a][1]));
    ctx.lineTo(xAt(points.length - 1), bottom);
    ctx.lineTo(xAt(0), bottom);
    ctx.closePath();
    ctx.fillStyle = colour;
    ctx.globalAlpha = 0.10;
    ctx.fill();
    ctx.globalAlpha = 1;

    /* the previous close */
    if (prevClose !== null && prevClose !== undefined && isFinite(prevClose)) {
      var py = yAt(prevClose);
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.moveTo(left, py);
      ctx.lineTo(right, py);
      ctx.strokeStyle = colours.grid;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    /* the line */
    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(points[0][1]));
    for (var b = 1; b < points.length; b += 1) ctx.lineTo(xAt(b), yAt(points[b][1]));
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    ctx.stroke();

    return true;
  }

  /* --- the paint ----------------------------------------------- */

  function paint() {
    lastPaintAt = Date.now();
    if (!root || !data) return;

    if (data.enabled === false) { root.hidden = true; return; }
    root.hidden = false;

    var market = String(data.market || 'closed');
    marketEl.setAttribute('data-market', market);
    marketEl.textContent = MARKET_LABEL[market] || 'Closed';

    if (!data.hasKey) {
      root.setAttribute('data-state', 'nokey');
      noteEl.hidden = false;
      noteEl.textContent = 'Add a Finnhub API key in Settings to see live prices';
      return;
    }
    if (data.keyState === 'rejected') {
      root.setAttribute('data-state', 'rejected');
      noteEl.hidden = false;
      noteEl.textContent = 'Finnhub rejected the key';
      return;
    }
    root.setAttribute('data-state', 'live');
    noteEl.hidden = true;

    var list = Array.isArray(data.rows) ? data.rows : [];
    syncRows(list);

    var colours = tokens();
    var nowMs = Date.now();
    for (var i = 0; i < list.length; i += 1) {
      var row = list[i];
      var rec = rows.get(row.symbol);
      if (!rec) continue;

      var pct = row.changePct;
      var dir = 'flat';
      if (typeof pct === 'number' && isFinite(pct)) {
        if (pct > 0) dir = 'up';
        else if (pct < 0) dir = 'down';
      }
      rec.btn.setAttribute('data-dir', dir);
      rec.btn.classList.toggle('is-on', row.symbol === data.selected);

      var lastText = money(row.last);
      if (rec.last.textContent !== lastText) rec.last.textContent = lastText;
      var pctText = percent(pct);
      if (rec.chg.textContent !== pctText) rec.chg.textContent = pctText;

      var stale = !!data.offline || (!!row.t && (nowMs - row.t) > STALE_MS);
      rec.btn.classList.toggle('is-stale', stale);

      drawSpark(rec.spark, row.spark, dir === 'down' ? colours.down : (dir === 'up' ? colours.up : colours.flat));
    }

    var drew = drawChart(data.series, colours);
    emptyEl.hidden = drew;

    var when = data.lastTickAt ? clockOf(data.lastTickAt) : '';
    var asOf = '';
    if (data.offline) asOf = when ? 'Offline · ' + when : 'Offline';
    else if (when) asOf = 'As of ' + when;
    else if (data.socket === 'live') asOf = 'Waiting for a trade';
    if (asOfEl.textContent !== asOf) asOfEl.textContent = asOf;
  }

  /* --- the + field --------------------------------------------- */

  function openAdd() {
    addBtn.hidden = true;
    addField.hidden = false;
    addField.value = '';
    addField.focus();
  }

  function closeAdd() {
    addField.hidden = true;
    addBtn.hidden = false;
  }

  function commitAdd() {
    var raw = addField.value.trim().toUpperCase();
    closeAdd();
    if (raw) say('add', raw);
  }

  /* --- boot ---------------------------------------------------- */

  function start() {
    root = document.getElementById('mod-stocks');
    if (!root) return;
    noteEl = document.getElementById('stk-note');
    marketEl = document.getElementById('stk-market');
    rowsEl = document.getElementById('stk-rows');
    canvasEl = document.getElementById('stk-canvas');
    emptyEl = document.getElementById('stk-chart-empty');
    addBtn = document.getElementById('stk-add');
    addField = document.getElementById('stk-add-field');
    asOfEl = document.getElementById('stk-as-of');
    if (!noteEl || !marketEl || !rowsEl || !canvasEl || !emptyEl || !addBtn || !addField || !asOfEl) {
      root = null;
      return;
    }

    addBtn.addEventListener('click', openAdd);
    addField.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commitAdd(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); closeAdd(); }
    });
    addField.addEventListener('blur', closeAdd);

    /* The same three "back on screen" signals the rest of the page uses, and
       the only thing that starts or stops the socket in main. */
    document.addEventListener('visibilitychange', syncWatch);
    window.addEventListener('pageshow', syncWatch);
    window.addEventListener('focus', syncWatch);
    window.addEventListener('pagehide', unwatch);
    /* Switched on or off, or moved, on the Home: subscribe or let go, and
       repaint at the column's width. */
    window.addEventListener('homelayout', function () { syncWatch(); schedulePaint(); });

    /* A resize changes both canvases' device size. Debounced, and a repaint
       rather than a reflow: nothing is measured that the paint does not. */
    var resizeTimer = 0;
    window.addEventListener('resize', function () {
      if (resizeTimer) return;
      resizeTimer = setTimeout(function () {
        resizeTimer = 0;
        schedulePaint();
      }, 200);
    });

    syncWatch();
  }

  /**
   * The whole tile, from main. Never carries the key — see the block comment.
   * { enabled, hasKey, keyState, market, socket, offline, historyPath,
   *   lastTickAt, selected,
   *   rows: [{ symbol, last, change, changePct, prevClose, t, spark: [] }],
   *   series: { symbol, prevClose, points: [[t, c], …] } }
   */
  window.__applyStocks = function (payload) {
    if (!payload || typeof payload !== 'object') return;
    data = payload;
    schedulePaint();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}());
