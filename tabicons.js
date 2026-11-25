/*
 * tabicons.js — where a tab's logo comes from (chrome renderer; also loads in
 * node for tabicons-harness.js).
 *
 * Requested 2026-10-14: "logos need to always be there and be more reliable half
 * the time they arent even there". The chip used to show whatever icon URL the
 * live page last reported, and wiped it at the start of every load. So a tab
 * that slept, was restored after a restart (born asleep, no page at all), or
 * whose page loaded a frame after its favicon was reported, showed no logo.
 *
 * The chain, best first — every link is tried only when the one above it has
 * nothing:
 *   1. the icon the page DECLARES (page-favicon-updated's candidates, in order;
 *      the browser's default /favicon.ico candidate is tried last);
 *   2. the CACHED icon for the page's origin (faviconstore.js in main, on disk,
 *      so it survives restarts and is there before any page exists);
 *   3. the site's OWN well-known icons: /favicon.ico, /apple-touch-icon.png,
 *      /apple-touch-icon-precomposed.png — once per origin per run;
 *   4. a MONOGRAM: the site's first letter on a neutral tile (drawn by the chip,
 *      app.js), never a blank.
 * No third-party favicon service is ever asked: icons come from the site only.
 *
 * Efficiency: an icon URL is fetched at most once per run (in-flight requests
 * are shared, failures remembered for 30 min), a cache lookup is batched into
 * one IPC per tick and memoised here (bounded), and a page repeating the icon
 * it already has costs nothing. Every result carries a `from` and, when the
 * chain fell through, a plain-words `reason` the chip shows on hover.
 */
(function (root) {
  'use strict';

  var FAIL_TTL_MS = 30 * 60 * 1000;
  var STALE_MS = 7 * 24 * 60 * 60 * 1000;
  var MEMO_MAX = 300;
  var MAX_CANDIDATES = 6;
  var WELL_KNOWN = ['/favicon.ico', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png'];

  /** "https://www.x.com/home" -> "https://www.x.com"; null for anything not http(s). */
  function originOf(url) {
    if (typeof url !== 'string' || !url) return null;
    var m = /^(https?):\/\/([^/?#\s]+)/i.exec(url);
    if (!m) return null;
    var host = m[2].replace(/^[^@]*@/, '').toLowerCase();
    var scheme = m[1].toLowerCase();
    // The default port is not part of an origin.
    if ((scheme === 'https' && /:443$/.test(host)) || (scheme === 'http' && /:80$/.test(host))) {
      host = host.replace(/:\d+$/, '');
    }
    return host ? scheme + '://' + host : null;
  }

  /**
   * The monogram letter for a page or an app: the first letter or digit of the
   * host with "www." / "m." dropped ("Home / X" on x.com -> "X"), uppercased.
   * A name that is not a URL (a native app) uses its own first letter.
   */
  function monogramFor(urlOrName) {
    var s = String(urlOrName == null ? '' : urlOrName);
    var origin = originOf(s);
    if (origin) {
      s = origin.replace(/^https?:\/\//, '').replace(/:\d+$/, '').replace(/^(www\d*|m|mobile)\./, '');
      if (/^\d+(\.\d+){3}$/.test(s) || s === 'localhost') s = s.charAt(0);
    }
    var m = /[\p{L}\p{N}]/u.exec(s);
    return m ? m[0].toUpperCase() : '';
  }

  function isFetchable(url) { return /^https?:\/\//i.test(url); }
  function isDataImage(url) { return /^data:image\//i.test(url); }

  /** The default candidate ("/favicon.ico" at the origin root) goes last. */
  function orderCandidates(origin, list) {
    var seen = {};
    var out = [];
    var tail = [];
    for (var i = 0; i < (list || []).length; i++) {
      var u = list[i];
      if (typeof u !== 'string' || !u || seen[u]) continue;
      if (!isFetchable(u) && !isDataImage(u)) continue;
      seen[u] = true;
      if (origin && u.toLowerCase() === origin + '/favicon.ico') tail.push(u);
      else out.push(u);
    }
    return out.concat(tail).slice(0, MAX_CANDIDATES);
  }

  function mimeOfDataUrl(u) {
    var m = /^data:([^;,]+)/i.exec(u);
    return m ? m[1].toLowerCase() : '';
  }

  /**
   * @param {Object} deps
   *   get(origins[]) -> Promise<{[origin]: {src,data,at}|null}>   the disk cache (main)
   *   put(origin, {src, data}) -> any                               remember one
   *   fetch(url) -> Promise<{ok, dataUrl, mime}|{ok:false, reason}> raw bytes (main)
   *   normalise(dataUrl, mime) -> Promise<string|null>              to the stored form
   *   now() -> ms (optional)
   */
  function createResolver(deps) {
    var now = typeof deps.now === 'function' ? deps.now : function () { return Date.now(); };
    var memo = new Map();       // origin -> entry | null   (what the cache said)
    var byUrl = new Map();      // icon url -> entry        (normalised this run)
    var failed = new Map();     // icon url -> { at, reason }
    var inflight = new Map();   // icon url -> Promise<{entry}|{reason}>
    var probes = new Map();     // origin -> Promise<result>
    var waiting = new Map();    // origin -> [resolve]
    var batchQueued = false;
    var counters = { ipcGets: 0, fetches: 0, normalised: 0 };

    function remember(map, key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > MEMO_MAX) map.delete(map.keys().next().value);
    }

    function flushBatch() {
      batchQueued = false;
      var origins = Array.from(waiting.keys());
      if (!origins.length) return;
      var pending = new Map(waiting);
      waiting.clear();
      counters.ipcGets++;
      Promise.resolve().then(function () { return deps.get(origins); }).then(function (map) {
        for (var i = 0; i < origins.length; i++) {
          var o = origins[i];
          var e = map && map[o] && typeof map[o].data === 'string' ? map[o] : null;
          remember(memo, o, e);
          var list = pending.get(o) || [];
          for (var j = 0; j < list.length; j++) list[j](e);
        }
      }, function () {
        // Main could not answer: nothing is cached as far as this run knows,
        // but do not memoise that, so the next chip asks again.
        pending.forEach(function (list) { for (var j = 0; j < list.length; j++) list[j](null); });
      });
    }

    /** Synchronous peek: an entry, null (known: nothing cached), or undefined (not asked yet). */
    function peek(origin) {
      return memo.has(origin) ? memo.get(origin) : undefined;
    }

    /** The cached entry for an origin. Lookups in the same tick share one IPC. */
    function cached(origin) {
      if (!origin) return Promise.resolve(null);
      if (memo.has(origin)) return Promise.resolve(memo.get(origin));
      return new Promise(function (resolve) {
        var list = waiting.get(origin);
        if (!list) { list = []; waiting.set(origin, list); }
        list.push(resolve);
        if (!batchQueued) {
          batchQueued = true;
          Promise.resolve().then(flushBatch);
        }
      });
    }

    function store(origin, url, data) {
      var entry = { src: url, data: data, at: now() };
      remember(byUrl, url, entry);
      remember(memo, origin, entry);
      try { deps.put(origin, { src: url, data: data }); } catch (err) { /* main gone: the run still has it */ }
      return entry;
    }

    /** One icon URL -> { entry } or { reason }. Shared while in flight; failures remembered. */
    function tryUrl(origin, url) {
      if (byUrl.has(url)) {
        var hit = byUrl.get(url);
        remember(memo, origin, hit);
        return Promise.resolve({ entry: hit });
      }
      var f = failed.get(url);
      if (f && now() - f.at < FAIL_TTL_MS) return Promise.resolve({ reason: f.reason });
      if (inflight.has(url)) return inflight.get(url);

      var p = Promise.resolve().then(function () {
        if (isDataImage(url)) return { ok: true, dataUrl: url, mime: mimeOfDataUrl(url) };
        counters.fetches++;
        return deps.fetch(url);
      }).then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.reason) || 'no answer');
        return Promise.resolve(deps.normalise(res.dataUrl, res.mime)).then(function (data) {
          if (!data) throw new Error('the image did not decode');
          counters.normalised++;
          return { entry: store(origin, url, data) };
        });
      }).catch(function (err) {
        var reason = String(err && err.message || err);
        remember(failed, url, { at: now(), reason: reason });
        return { reason: reason };
      }).then(function (r) {
        inflight.delete(url);
        return r;
      });
      inflight.set(url, p);
      return p;
    }

    function tryList(origin, urls) {
      var reasons = [];
      var i = 0;
      function next() {
        if (i >= urls.length) return Promise.resolve({ entry: null, reasons: reasons });
        var url = urls[i++];
        return tryUrl(origin, url).then(function (r) {
          if (r.entry) return { entry: r.entry, reasons: reasons };
          reasons.push(shortUrl(url) + ': ' + r.reason);
          return next();
        });
      }
      return next();
    }

    /** Link 3: the site's own well-known icons. Once per origin per run. */
    function probe(origin) {
      if (!origin) return Promise.resolve({ entry: null, from: 'none', reason: 'not a web page' });
      if (probes.has(origin)) return probes.get(origin);
      var urls = WELL_KNOWN.map(function (p) { return origin + p; });
      var p = tryList(origin, urls).then(function (r) {
        if (r.entry) return { entry: r.entry, from: 'site' };
        return { entry: null, from: 'none', reason: 'the site has no icon (' + r.reasons.join('; ') + ')' };
      });
      probes.set(origin, p);
      return p;
    }

    /**
     * Links 1-3 for a page that has just reported its icons.
     * @returns {Promise<{entry, from:'declared'|'cache'|'site'|'none', reason?}>}
     */
    function declared(pageUrl, candidates) {
      var origin = originOf(pageUrl);
      // A bundled page (file:, the new tab) may still report a data: icon.
      var urls = orderCandidates(origin, candidates);
      return cached(origin).then(function (hit) {
        // The page is still wearing the icon the cache already holds: nothing to do.
        if (hit && urls.indexOf(hit.src) !== -1 && now() - (hit.at || 0) < STALE_MS) {
          remember(byUrl, hit.src, hit);
          return { entry: hit, from: 'cache' };
        }
        return tryList(origin || 'local', urls).then(function (r) {
          if (r.entry) return { entry: r.entry, from: 'declared' };
          var why = r.reasons.length ? 'its declared icon failed (' + r.reasons.join('; ') + ')' : 'it declares no icon';
          if (hit) return { entry: hit, from: 'cache', reason: why };
          if (!origin) return { entry: null, from: 'none', reason: why };
          return probe(origin).then(function (pr) {
            return pr.entry ? pr : { entry: null, from: 'none', reason: why + '; ' + pr.reason };
          });
        });
      });
    }

    /** Links 2-3 for a page that loaded without reporting any icon. */
    function fallback(pageUrl) {
      var origin = originOf(pageUrl);
      return cached(origin).then(function (hit) {
        if (hit) return { entry: hit, from: 'cache' };
        return probe(origin);
      });
    }

    function describe() {
      return {
        memo: memo.size, byUrl: byUrl.size, failed: failed.size, inflight: inflight.size,
        probes: probes.size, counters: Object.assign({}, counters)
      };
    }

    return { peek: peek, cached: cached, declared: declared, fallback: fallback, probe: probe, describe: describe };
  }

  function shortUrl(u) {
    if (isDataImage(u)) return 'data: icon';
    return String(u).replace(/^https?:\/\//, '').slice(0, 80);
  }

  /* ---- browser glue ---------------------------------------------------- */

  /** The stored form: a site's own small SVG as-is (vector, crisp at any
   * scale); anything else redrawn once into a 32px PNG, which covers the 16px
   * box up to 200% scaling. Null when the image does not decode. */
  var STORE_MAX = 48 * 1024;
  var PNG_PX = 32;

  function loadImage(src, timeoutMs) {
    return new Promise(function (resolve) {
      var img = new Image();
      var done = false;
      var timer = setTimeout(function () { finish(null); }, timeoutMs || 4000);
      function finish(v) { if (done) return; done = true; clearTimeout(timer); resolve(v); }
      img.onload = function () { finish(img); };
      img.onerror = function () { finish(null); };
      img.src = src;
    });
  }

  function normaliseInBrowser(dataUrl, mime) {
    return loadImage(dataUrl).then(function (img) {
      if (!img) return null;
      var w = img.naturalWidth;
      var h = img.naturalHeight;
      var svg = mime === 'image/svg+xml';
      if (svg && dataUrl.length <= STORE_MAX) return dataUrl;
      if (svg && (!w || !h)) { w = PNG_PX; h = PNG_PX; }
      if (!w || !h) return null;
      // A PNG already at a size the box can use is kept byte for byte.
      if (mime === 'image/png' && w === h && (w === 16 || w === 32) && dataUrl.length <= STORE_MAX) return dataUrl;
      var size = Math.max(w, h) >= PNG_PX ? PNG_PX : Math.max(16, Math.max(w, h));
      // Large sources are halved step by step first: one big jump to 32px
      // aliases thin strokes; repeated halving keeps them.
      var src = img;
      var sw = w;
      var sh = h;
      while (Math.max(sw, sh) >= size * 4) {
        var half = document.createElement('canvas');
        half.width = Math.max(1, Math.round(sw / 2));
        half.height = Math.max(1, Math.round(sh / 2));
        var hc = half.getContext('2d');
        hc.imageSmoothingQuality = 'high';
        hc.drawImage(src, 0, 0, half.width, half.height);
        src = half; sw = half.width; sh = half.height;
      }
      var c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      var ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      var scale = Math.min(size / sw, size / sh);
      var dw = Math.round(sw * scale);
      var dh = Math.round(sh * scale);
      ctx.drawImage(src, Math.floor((size - dw) / 2), Math.floor((size - dh) / 2), dw, dh);
      var out = c.toDataURL('image/png');
      return out.length <= STORE_MAX ? out : null;
    });
  }

  var browserResolver = null;
  /** The one resolver the chrome uses, wired to main through window.api.favicons. */
  function resolver() {
    if (browserResolver) return browserResolver;
    var api = root && root.api && root.api.favicons;
    browserResolver = createResolver({
      get: function (origins) { return api ? api.get(origins) : Promise.resolve({}); },
      put: function (origin, entry) { if (api) api.put(origin, entry); },
      fetch: function (url) { return api ? api.fetch(url) : Promise.resolve({ ok: false, reason: 'the icon bridge is missing' }); },
      normalise: normaliseInBrowser
    });
    return browserResolver;
  }

  /* ---- the logo tile, for every surface outside the tab strip ------------ */
  /*
   * The bookmarks bar (chrome), the new tab page and the history page (both
   * preload-less guests) used to point an <img> at Google's favicon service:
   * every site the user saved or visited went to Google, nothing showed offline,
   * and a site Google had no icon for drew a grey globe. They now draw the
   * tab chip's own layers, from the same per-origin store:
   *
   *   span.qfav[data-state=pending|icon|mono]   one --qfav square, never resized
   *     span.qfav-mono                           the chip's monogram tile
   *     img.qfav-img                             a data: icon, shown once DECODED
   *
   * favtile.css styles it as .tab-fav > .tab-mono is styled (chrome.css). The
   * img is only ever given a data:image URL, so a tile never makes a request.
   */

  /** The origin for a bare host ("mail.google.com") or a full URL. */
  function tileOrigin(urlOrHost) {
    var s = String(urlOrHost == null ? '' : urlOrHost).trim();
    if (!s) return null;
    return originOf(/^https?:\/\//i.test(s) ? s : 'https://' + s);
  }

  /**
   * A logo tile, `size` CSS px square, held empty ('pending') until paintTile.
   * The caller's className rides along so its existing layout rules (margins,
   * flex) keep applying unchanged.
   */
  function tile(urlOrHost, opts) {
    var doc = root.document;
    var o = opts || {};
    var origin = tileOrigin(urlOrHost);
    var el = doc.createElement('span');
    el.className = 'qfav' + (o.className ? ' ' + o.className : '');
    el.style.setProperty('--qfav', (o.size || 16) + 'px');
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('data-state', 'pending');
    el.setAttribute('data-origin', origin || '');
    var mono = doc.createElement('span');
    mono.className = 'qfav-mono';
    mono.textContent = monogramFor(origin || String(urlOrHost || '')) || '?';
    var img = doc.createElement('img');
    img.className = 'qfav-img';
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    el.appendChild(mono);
    el.appendChild(img);
    return el;
  }

  /**
   * Give a tile its answer: a data:image URL shows the logo once it decodes;
   * anything else (null: no icon) shows the monogram. A tile already showing
   * a logo is never knocked back to its letter by a later "nothing".
   */
  function paintTile(el, data) {
    if (!el || !el.querySelector) return;
    var img = el.querySelector('img.qfav-img');
    if (!img) return;
    // An empty payload ("data:image/png;base64,") is no icon: the letter, never a blank box.
    if (typeof data === 'string' && isDataImage(data) && /,./.test(data)) {
      if (img.getAttribute('src') === data) return;
      // Pending stays pending (no letter flash) while it decodes; a letter
      // already up stays up until the logo is ready to replace it.
      img.onload = function () { el.setAttribute('data-state', 'icon'); };
      img.onerror = function () {
        img.removeAttribute('src');
        el.setAttribute('data-state', 'mono');
      };
      img.src = data;
      return;
    }
    if (el.getAttribute('data-state') !== 'icon') el.setAttribute('data-state', 'mono');
  }

  /**
   * The logo for an origin, as the tab strip would find it with no page to
   * ask: the disk cache, then the site's own well-known icons (once per
   * origin per run). `onAnswer(data|null)` is called with the cache's answer
   * and again if the site probe finds a logo later. Chrome renderer only.
   */
  function lookup(origin, onAnswer) {
    if (!origin) { onAnswer(null); return; }
    var r = resolver();
    var known = r.peek(origin);
    var first = known !== undefined ? Promise.resolve(known) : r.cached(origin);
    first.then(function (hit) {
      if (hit && hit.data) { onAnswer(hit.data); return null; }
      onAnswer(null);
      return r.probe(origin).then(function (pr) {
        if (pr && pr.entry && pr.entry.data) onAnswer(pr.entry.data);
      });
    }).catch(function () { onAnswer(null); });
  }

  /** A tile wired straight to lookup(): the bookmarks bar's logos. Chrome only. */
  function chromeTile(urlOrHost, opts) {
    var el = tile(urlOrHost, opts);
    lookup(el.getAttribute('data-origin') || null, function (data) { paintTile(el, data); });
    return el;
  }

  var exported = {
    originOf: originOf,
    monogramFor: monogramFor,
    tile: tile,
    chromeTile: chromeTile,
    lookup: lookup,
    paintTile: paintTile,
    tileOrigin: tileOrigin,
    orderCandidates: orderCandidates,
    createResolver: createResolver,
    resolver: resolver,
    normalise: normaliseInBrowser,
    WELL_KNOWN: WELL_KNOWN
  };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root && typeof root === 'object' && typeof root.document !== 'undefined') root.TabIcons = exported;
})(typeof window !== 'undefined' ? window : globalThis);
