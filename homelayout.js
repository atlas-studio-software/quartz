/* ============================================================
   homelayout.js — the new tab Home's layout rules, in one place.

   The Home is ten pieces. Each can be hidden and put back, and dragged
   to ANY spot on the page: lower, higher, a corner, anywhere in between,
   as long as it does not sit on another piece or hang off the page. The
   result is ONE stored setting:

     homeLayout: {
       v: 2,
       hidden: [ids],
       place:  [{ id, h, x, v, y }]     oldest first, last moved last
     }

   or null, which means "the default" (today's arrangement, exactly).

   A piece with no `place` entry has never been moved: it sits where the
   default arrangement puts it, at whatever size the window is, exactly as
   it always has. A piece WITH an entry was put somewhere by hand, and the
   entry says where, anchored to the part of the page it is nearest to so
   it stays there when the window changes size:

     h  'l' | 'c' | 'r'   x = px from the left edge to the piece's left
                          edge | px from the page's centre line to the
                          piece's centre (signed) | px from the piece's
                          right edge to the page's right edge
     v  't' | 'm' | 'b'   y = the same, vertically

   So a now-playing card dropped in the bottom-left corner is { h:'l',
   v:'b' } and stays in that corner at any size; a search box dropped a
   little under the middle is { h:'c', v:'m' } and stays centred.

   Hidden pieces KEEP their place entry, which is what lets a piece
   switched off in Settings come back where it was.

   v1 (the column model: { v:1, columns:{left,centre,right}, hidden })
   loads as its hidden list over the default arrangement: a column order
   has no geometry to convert, and every piece in it was somewhere the
   default arrangement also has room for.

   THE GEOMETRY IS HERE TOO, as pure functions over plain rects (no DOM):
   where an anchor puts a piece, which anchor a rect is nearest to, and
   arrange(), which lays a whole page out without one overlap or a piece
   off the page, nudging a piece to the nearest free spot when its own is
   taken, and saying so when there is no room at all (the page then folds
   into the default arrangement instead). The page uses them for every
   draw and every drag; Node uses them for the harness.

   WHY THIS FILE IS SHARED. Two documents need the same rules: the chrome
   (settings.js stores the layout, app.js answers the page and gates each
   piece's feed) and the new tab page (it draws the layout, and applies its
   own edits at once while the chrome confirms them). The page is a
   preload-less file:// guest and the chrome is another document, so the
   only way to keep one set of rules is one plain script that both load.
   It defines window.HomeLayout and nothing else, needs no DOM, and is also
   require()-able from Node.

   NEVER TRUST THE INPUT. sanitize() turns anything at all (a stored value
   from an older or newer build, a hand-edited file, a page's request) into
   a complete layout: unknown ids and malformed places are dropped, and
   duplicates keep their LAST entry (the latest move). parseOp() is the
   same for one page request.
   ============================================================ */

(function (root) {
  'use strict';

  var VERSION = 2;

  /* The three default columns, left to right: where a piece's element lives
     in the markup. Nothing is ever moved between them any more; the page
     uses them to put a piece back in its own place in the document. */
  var COLUMNS = ['left', 'centre', 'right'];

  /*
   * Every piece, in default order. `column` is where the markup has it;
   * `kind` is 'card' (a tile with a fixed width) or 'wide' (as wide as the
   * centre column). `label` is what the Edit tray and Settings call it;
   * `hint` is the one line Settings adds under the switch.
   */
  var PIECES = [
    { id: 'clock',   column: 'left',   kind: 'card', label: 'Clock',
      hint: 'The time and the date' },
    { id: 'media',   column: 'left',   kind: 'card', label: 'Now playing',
      hint: 'What this computer is playing, with its controls' },
    { id: 'logo',    column: 'centre', kind: 'wide', label: 'Quartz logo',
      hint: 'The Q over the search box' },
    { id: 'search',  column: 'centre', kind: 'wide', label: 'Search box',
      hint: 'The address bar still takes the caret on a new tab' },
    { id: 'saved',   column: 'centre', kind: 'wide', label: 'Saved',
      hint: 'Your saved sites' },
    { id: 'links',   column: 'centre', kind: 'wide', label: 'Shortcuts',
      hint: 'The shortcut chips' },
    { id: 'stats',   column: 'centre', kind: 'wide', label: 'System stats',
      hint: 'CPU, memory, disk, network, GPU and processes' },
    { id: 'apps',    column: 'centre', kind: 'wide', label: 'Apps',
      hint: 'The app dock' },
    { id: 'session', column: 'right',  kind: 'card', label: 'Session',
      hint: 'Tabs open, Spotify auto-pause and idle music' },
    { id: 'markets', column: 'right',  kind: 'card', label: 'Markets',
      hint: 'Live prices' }
  ];

  /* The page's geometry rules, in CSS px.
     MARGIN  how close to the page's edge a piece may sit: its edit box
             hangs 6px outside it and the box's x another 11px, and both
             must stay on the page too.
     GAP     the least room between two pieces; the default arrangement's
             own tightest gap is 16, so it always passes.
     REACH   how far a piece may be nudged to find room. A DROP further
             than that is refused rather than landing somewhere the
             pointer never was; a re-draw (a resize, a card growing) that
             would have to carry a piece further than that from where it
             belongs folds instead: a Home that no longer looks like the
             one you arranged is worse than the plain one. */
  var MARGIN = 18;
  var GAP = 8;
  var REACH = 240;
  /* Anchor offsets are stored as whole px, within this. */
  var MAX_OFFSET = 20000;

  var H_ANCHORS = ['l', 'c', 'r'];
  var V_ANCHORS = ['t', 'm', 'b'];

  var BY_ID = Object.create(null);
  PIECES.forEach(function (p, i) { BY_ID[p.id] = { piece: p, rank: i }; });

  function isPiece(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY_ID, id);
  }

  function isColumn(name) {
    return typeof name === 'string' && COLUMNS.indexOf(name) >= 0;
  }

  /* The default Home (the look, 2026-11-24): Clock on the left, the Quartz
     logo and the Search box in the centre, Markets on the right. Every other
     piece starts switched off and is one switch away in Customize; a Home
     someone has customised keeps exactly what they chose. */
  var DEFAULT_VISIBLE = ['clock', 'logo', 'search', 'markets'];

  /** No piece hidden: sanitize()'s starting point for a stored layout. */
  function empty() {
    return { v: VERSION, hidden: [], place: [] };
  }

  /** The default layout, as a fresh object every time (callers may mutate). */
  function defaults() {
    var out = empty();
    PIECES.forEach(function (p) { if (DEFAULT_VISIBLE.indexOf(p.id) < 0) out.hidden.push(p.id); });
    return out;
  }

  /** One anchor, cleaned: { h, x, v, y } or null. */
  function cleanAt(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (H_ANCHORS.indexOf(raw.h) < 0 || V_ANCHORS.indexOf(raw.v) < 0) return null;
    var x = Number(raw.x);
    var y = Number(raw.y);
    if (!isFinite(x) || !isFinite(y)) return null;
    x = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(x)));
    y = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(y)));
    // -0 would make two equal layouts unequal as strings.
    return { h: raw.h, x: x || 0, v: raw.v, y: y || 0 };
  }

  /**
   * Anything -> a complete layout. Pure; never throws; never returns the
   * object it was given (or anything inside it).
   */
  function sanitize(value) {
    var src = (value && typeof value === 'object' && !Array.isArray(value)) ? value : null;
    // Nothing stored (or nothing usable): the default Home. Something stored:
    // exactly its own hidden list, over a Home with nothing hidden.
    if (!src) return defaults();
    var out = empty();

    var hidden = Array.isArray(src.hidden) ? src.hidden : [];
    var off = Object.create(null);
    for (var j = 0; j < hidden.length && j < 64; j++) {
      if (isPiece(hidden[j])) off[hidden[j]] = true;
    }
    // Stored in PIECES order, so two equal layouts are equal as strings.
    PIECES.forEach(function (p) { if (off[p.id]) out.hidden.push(p.id); });

    // v1 had columns and no places: its hidden list is all that carries
    // over (see the head of this file).
    var list = Array.isArray(src.place) ? src.place.slice(0, 64) : [];
    var at = Object.create(null);
    var order = [];
    list.forEach(function (entry) {
      if (!entry || typeof entry !== 'object' || !isPiece(entry.id)) return;
      var a = cleanAt(entry);
      if (!a) return;
      // A later entry for the same piece is its later move: it wins, and
      // takes the later slot in the order.
      if (at[entry.id]) order.splice(order.indexOf(entry.id), 1);
      at[entry.id] = a;
      order.push(entry.id);
    });
    order.forEach(function (id) {
      var a = at[id];
      out.place.push({ id: id, h: a.h, x: a.x, v: a.v, y: a.y });
    });
    return out;
  }

  /** Byte-for-byte equality of two layouts after sanitising both. */
  function same(a, b) {
    return JSON.stringify(sanitize(a)) === JSON.stringify(sanitize(b));
  }

  function isDefault(layout) {
    return same(layout, defaults());
  }

  function isHidden(layout, id) {
    return sanitize(layout).hidden.indexOf(id) >= 0;
  }

  /** Where a piece was put by hand ({ h, x, v, y }), or null if never moved. */
  function placeOf(layout, id) {
    var l = sanitize(layout);
    for (var i = 0; i < l.place.length; i++) {
      if (l.place[i].id === id) {
        var p = l.place[i];
        return { h: p.h, x: p.x, v: p.v, y: p.y };
      }
    }
    return null;
  }

  /**
   * The order pieces claim their spots in: the most recently moved first
   * (what you just put somewhere stays there), then older moves, then the
   * pieces never moved, in their default order. A piece that comes later
   * is the one nudged when two want the same room.
   */
  function priority(layout) {
    var l = sanitize(layout);
    var out = [];
    for (var i = l.place.length - 1; i >= 0; i--) out.push(l.place[i].id);
    PIECES.forEach(function (p) { if (out.indexOf(p.id) < 0) out.push(p.id); });
    return out;
  }

  /**
   * One request, validated. Returns a clean op or null. The shapes:
   *   { op: 'hide', id }
   *   { op: 'show', id, at? }          at: where it lands, if the page knows
   *   { op: 'place', id, at, show? }   moved by hand to `at`
   *   { op: 'reset' }
   */
  function parseOp(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var op = raw.op;
    if (op === 'reset') return { op: 'reset' };
    if (op !== 'hide' && op !== 'show' && op !== 'place') return null;
    if (!isPiece(raw.id)) return null;
    if (op === 'hide') return { op: 'hide', id: raw.id };
    var at = raw.at == null ? null : cleanAt(raw.at);
    if (raw.at != null && !at) return null;
    if (op === 'show') return at ? { op: 'show', id: raw.id, at: at } : { op: 'show', id: raw.id };
    if (!at) return null;
    var out = { op: 'place', id: raw.id, at: at };
    if (raw.show === true) out.show = true;
    return out;
  }

  /**
   * Apply one op to a layout. Returns { ok, layout, reason }: layout is
   * always complete (the input, sanitised, when the op was refused), and
   * every refusal says why in words a person can read.
   */
  function apply(layout, rawOp) {
    var base = sanitize(layout);
    var op = parseOp(rawOp);
    if (!op) return { ok: false, layout: base, reason: 'That change was not understood' };
    if (op.op === 'reset') return { ok: true, layout: defaults(), reason: '' };

    var next = sanitize(base);   // a copy to edit
    var hiddenAt = next.hidden.indexOf(op.id);
    var placeAt = -1;
    for (var i = 0; i < next.place.length; i++) {
      if (next.place[i].id === op.id) { placeAt = i; break; }
    }

    if (op.op === 'hide') {
      if (hiddenAt < 0) next.hidden.push(op.id);
      return { ok: true, layout: sanitize(next), reason: '' };   // back in PIECES order
    }

    if (op.op === 'show' && !op.at) {
      if (hiddenAt >= 0) next.hidden.splice(hiddenAt, 1);
      // Back where it was, but as the OLDEST move: whatever was put in its
      // room while it was away has the better claim, so it is this piece
      // that is nudged, not the other one.
      if (placeAt > 0) next.place.unshift(next.place.splice(placeAt, 1)[0]);
      return { ok: true, layout: next, reason: '' };
    }

    // show with a spot, or place: the piece is at `at`, as the latest move.
    if (placeAt >= 0) next.place.splice(placeAt, 1);
    next.place.push({ id: op.id, h: op.at.h, x: op.at.x, v: op.at.v, y: op.at.y });
    if ((op.op === 'show' || op.show) && hiddenAt >= 0) next.hidden.splice(hiddenAt, 1);
    return { ok: true, layout: next, reason: '' };
  }

  /** The value to STORE: null for the default, so a reset follows future defaults. */
  function toStored(layout) {
    var l = sanitize(layout);
    return isDefault(l) ? null : l;
  }

  function label(id) {
    return isPiece(id) ? BY_ID[id].piece.label : '';
  }

  /* --- geometry ---------------------------------------------------
     Rects are { left, top, width, height } in page px; `page` is
     { width, height }. Nothing here touches the DOM. */

  function rect(left, top, width, height) {
    return { left: left, top: top, width: width, height: height };
  }

  /**
   * The anchor a rect is nearest to, and its offset from it. `h` and `v`
   * pick the anchor instead ('l'|'c'|'r', 't'|'m'|'b'): the page uses that to
   * give a piece dropped against another the same anchor, so a stack moves
   * as one when the window changes size.
   */
  function anchorOf(r, page, hPick, vPick) {
    var dl = r.left;
    var dr = page.width - (r.left + r.width);
    var dc = (r.left + r.width / 2) - page.width / 2;
    var dt = r.top;
    var db = page.height - (r.top + r.height);
    var dm = (r.top + r.height / 2) - page.height / 2;
    var h = Math.abs(dc) <= Math.min(dl, dr) ? 'c' : (dl <= dr ? 'l' : 'r');
    var v = Math.abs(dm) <= Math.min(dt, db) ? 'm' : (dt <= db ? 't' : 'b');
    if (H_ANCHORS.indexOf(hPick) >= 0) h = hPick;
    if (V_ANCHORS.indexOf(vPick) >= 0) v = vPick;
    return cleanAt({
      h: h, x: h === 'l' ? dl : (h === 'r' ? dr : dc),
      v: v, y: v === 't' ? dt : (v === 'b' ? db : dm)
    });
  }

  /** Where an anchor puts a piece of `size` ({ width, height }) on `page`. */
  function rectAt(at, size, page) {
    var w = size.width;
    var h = size.height;
    var left = at.h === 'l' ? at.x
      : (at.h === 'r' ? page.width - at.x - w : page.width / 2 + at.x - w / 2);
    var top = at.v === 't' ? at.y
      : (at.v === 'b' ? page.height - at.y - h : page.height / 2 + at.y - h / 2);
    return rect(left, top, w, h);
  }

  /** Does a piece of this size fit on the page at all? */
  function fitsPage(size, page, margin) {
    var m = margin == null ? MARGIN : margin;
    return size.width <= page.width - 2 * m + 0.5 && size.height <= page.height - 2 * m + 0.5;
  }

  /** The rect moved the least it takes to sit inside the page's margin. */
  function clampRect(r, page, margin) {
    var m = margin == null ? MARGIN : margin;
    var left = Math.min(Math.max(r.left, m), page.width - m - r.width);
    var top = Math.min(Math.max(r.top, m), page.height - m - r.height);
    return rect(Math.max(left, m), Math.max(top, m), r.width, r.height);
  }

  /** Do two rects come closer than `gap`? */
  function hits(a, b, gap) {
    var g = gap == null ? GAP : gap;
    return a.left < b.left + b.width + g && b.left < a.left + a.width + g &&
           a.top < b.top + b.height + g && b.top < a.top + a.height + g;
  }

  function hitsAny(r, others, gap) {
    for (var i = 0; i < others.length; i++) {
      if (others[i] && hits(r, others[i], gap)) return others[i];
    }
    return null;
  }

  /**
   * The free spot nearest to `r` (same size): inside the page's margin and
   * at least GAP from every rect in `others`. Null when there is none within
   * `reach` px. Exact, not a search grid: the nearest free spot always has
   * each coordinate either where it wanted to be or flush against some edge
   * (the page's margin, or another piece plus the gap), so those are the
   * only candidates that need trying.
   */
  function nearestFree(r, others, page, opts) {
    var o = opts || {};
    var m = o.margin == null ? MARGIN : o.margin;
    var g = o.gap == null ? GAP : o.gap;
    var reach = o.reach == null ? Infinity : o.reach;
    var w = r.width;
    var h = r.height;
    if (!fitsPage(r, page, m)) return null;
    var maxX = page.width - m - w;
    var maxY = page.height - m - h;
    var xs = [r.left, m, maxX];
    var ys = [r.top, m, maxY];
    others.forEach(function (b) {
      if (!b) return;
      xs.push(b.left - g - w, b.left + b.width + g);
      ys.push(b.top - g - h, b.top + b.height + g);
    });
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < xs.length; i++) {
      var x = Math.min(Math.max(xs[i], m), maxX);
      var dx = x - r.left;
      if (dx * dx >= bestD) continue;
      for (var j = 0; j < ys.length; j++) {
        var y = Math.min(Math.max(ys[j], m), maxY);
        var dy = y - r.top;
        var d = dx * dx + dy * dy;
        if (d >= bestD) continue;
        var c = rect(x, y, w, h);
        if (hitsAny(c, others, g)) continue;
        best = c;
        bestD = d;
      }
    }
    if (!best || Math.sqrt(bestD) > reach) return null;
    return best;
  }

  /**
   * Lay a whole page out. `items` are in priority order (see priority()):
   * [{ id, width, height, want: { left, top }, fixed? }]. A fixed item (the
   * page's own controls) is taken exactly where it is. Each piece is pulled
   * inside the page's margin, then, if that spot touches a piece already
   * laid out, moved to the nearest free spot (no further than opts.reach,
   * when given). Returns
   *   { ok: true,  rects: { id: rect }, nudged: [ids] }
   *   { ok: false, rects, nudged, stuck: id }   no room for `stuck`
   * and the caller folds rather than draw an overlap.
   */
  function arrange(items, page, opts) {
    var o = opts || {};
    var laid = [];
    var rects = Object.create(null);
    var nudged = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.fixed) {
        rects[it.id] = rect(it.want.left, it.want.top, it.width, it.height);
        laid.push(rects[it.id]);
        continue;
      }
      var size = { width: it.width, height: it.height };
      if (!fitsPage(size, page, o.margin)) {
        return { ok: false, rects: rects, nudged: nudged, stuck: it.id };
      }
      var r = clampRect(rect(it.want.left, it.want.top, it.width, it.height), page, o.margin);
      if (hitsAny(r, laid, o.gap)) {
        var free = nearestFree(r, laid, page, { margin: o.margin, gap: o.gap, reach: o.reach });
        if (!free) return { ok: false, rects: rects, nudged: nudged, stuck: it.id };
        r = free;
      }
      if (Math.abs(r.left - it.want.left) > 0.5 || Math.abs(r.top - it.want.top) > 0.5) nudged.push(it.id);
      rects[it.id] = r;
      laid.push(r);
    }
    return { ok: true, rects: rects, nudged: nudged };
  }

  var api = {
    VERSION: VERSION,
    COLUMNS: COLUMNS.slice(),
    MARGIN: MARGIN,
    GAP: GAP,
    REACH: REACH,
    PIECES: PIECES.map(function (p) {
      return { id: p.id, column: p.column, kind: p.kind, label: p.label, hint: p.hint };
    }),
    isPiece: isPiece,
    isColumn: isColumn,
    defaults: defaults,
    sanitize: sanitize,
    same: same,
    isDefault: isDefault,
    isHidden: isHidden,
    placeOf: placeOf,
    priority: priority,
    parseOp: parseOp,
    apply: apply,
    toStored: toStored,
    label: label,
    anchorOf: anchorOf,
    rectAt: rectAt,
    fitsPage: fitsPage,
    clampRect: clampRect,
    hits: hits,
    hitsAny: hitsAny,
    nearestFree: nearestFree,
    arrange: arrange
  };

  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.HomeLayout = api;
}(typeof window !== 'undefined' ? window : null));
