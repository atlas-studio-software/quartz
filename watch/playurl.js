'use strict';
/*
 * watch/playurl.js -- one click from a Lumen tile to the video playing, as the right profile.
 * Pure functions over plain strings and items; no DOM, no Electron, no network.
 *
 * Loads three ways, like shape.js:
 *   - require('./watch/playurl') in main (watch-main.js), the adapters and the tests
 *   - <script src="watch/playurl.js"> in watch.html (window.LumenPlay)
 *   - <script src="watch/playurl.js"> in index.html, for the player layer (watch-player-extras.js)
 *
 * What is proven, and what is not (10-17):
 *   - Hulu: /watch/<uuid> plays the episode or film. The uuid is the one Hulu's own tile carries:
 *     personalization.eab "EAB::<uuid>::<n>::<n>", or metrics_info target_type episode|movie +
 *     target_id, or a tile href /watch/<uuid>. Source: crosswalknyc/behavioralgraph's hulu.py
 *     (tiles link /series/<uuid>, /movie/<uuid>, /watch/<uuid>); the eab and metrics_info fields
 *     are in hulu.js's fixture. Not checked against a signed-in account, so every /watch/ open
 *     carries the series page as its fallback and the layer falls back when the player refuses.
 *   - YouTube &t= and ESPN watch/player?id= were already direct (the adapters build them).
 *   - Disney+ /play/<id>: NOT used. The explore-era tiles carry actions[{ type: 'playback',
 *     deeplinkId }] (disney.js's fixture, from slyguy.disney.plus), but no captured shape or public
 *     source shows the web address that deeplinkId plays at; the old site's /video/<contentId>
 *     (Nagra's OpenTV deep-link page) takes a different, older id. A guessed URL would land on an
 *     error page on every click, so Disney+ keeps its title page (Resume is one click there).
 *   - Prime Video autoplay: only when Prime's OWN tile link already carries autoplay=1 (used as
 *     Prime wrote it). No captured shape shows that link and no public source documents the
 *     parameter, so Lumen never adds it by itself; the title page stays the default.
 *   - Profile pickers: Hulu /profiles (hulu.js: logged out it redirects to sign-in, so the path is
 *     real); Disney+ /select-profile (disney.js's picker test); YouTube /channel_switcher (YouTube's
 *     own "Switch account" page). Prime Video has no picker address on record: its profile menu is
 *     in the nav bar of every page, so "Switch profile" opens the home page and says where.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LumenPlay = api;
})(typeof self !== 'undefined' ? self : this, function () {
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var NAMES = { youtube: 'YouTube', disney: 'Disney+', hulu: 'Hulu', prime: 'Prime Video', espn: 'ESPN' };
  var DRM = { youtube: false, disney: true, hulu: true, prime: true, espn: true };
  var UP_NEXT_SEC = 10;

  function obj(x) { return x && typeof x === 'object' && !Array.isArray(x) ? x : null; }
  function str(x) { return typeof x === 'string' ? x : ''; }
  function num(x) { var n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x; return typeof n === 'number' && isFinite(n) ? n : null; }
  function parse(url) { try { return new URL(String(url || '')); } catch (e) { return null; } }
  function hostIs(host, domain) { return host === domain || host.slice(-(domain.length + 1)) === '.' + domain; }
  function fold(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

  /* ------------------------------------------------------------ profiles */

  var PROFILES = {
    disney: { url: 'https://www.disneyplus.com/select-profile', label: 'Switch profile', where: '' },
    hulu: { url: 'https://www.hulu.com/profiles', label: 'Switch profile', where: '' },
    youtube: { url: 'https://www.youtube.com/channel_switcher', label: 'Switch account', where: '' },
    prime: { url: 'https://www.primevideo.com/', label: 'Switch profile', where: 'Prime Video’s profile menu is at the top right of its page' }
  };
  /** The service's own profile picker: { url, label, where } or null (ESPN has no profiles). */
  function profilePage(service) { return PROFILES[service] ? { url: PROFILES[service].url, label: PROFILES[service].label, where: PROFILES[service].where } : null; }

  /** The letter an avatar without a picture shows. */
  function initial(name) {
    var m = /[A-Za-z0-9À-ɏ]/.exec(String(name || ''));
    return m ? m[0].toUpperCase() : '';
  }

  /*
   * A profile's picture, only when the service's own profile record names one outright (https, on
   * the service's own image hosts); '' otherwise and the chip shows the initial. Field names are
   * the ones the services' web apps are reported to use; none is verified signed in.
   */
  var AVATAR_HOSTS = {
    disney: ['disneyplus.com', 'bamgrid.com', 'disney-plus.net', 'dssott.com'],
    hulu: ['hulu.com', 'huluim.com', 'hulustream.com'],
    prime: ['media-amazon.com', 'ssl-images-amazon.com', 'images-amazon.com', 'primevideo.com'],
    youtube: ['ggpht.com', 'googleusercontent.com', 'ytimg.com']
  };
  function avatarOf(service, node) {
    var p = obj(node);
    if (!p) return '';
    var av = obj(p.avatar) || obj(p.profileAvatar) || obj(p.image) || {};
    var cands = [str(p.avatarUrl), str(p.avatar_url), str(p.avatar), str(p.imageUrl), str(p.image_url), str(av.url), str(av.imageUrl), str(av.image_url), str(av.path)];
    var hosts = AVATAR_HOSTS[service] || [];
    for (var i = 0; i < cands.length; i++) {
      var u = parse(cands[i]);
      if (!u || u.protocol !== 'https:') continue;
      for (var j = 0; j < hosts.length; j++) if (hostIs(u.hostname.toLowerCase(), hosts[j])) return u.href.slice(0, 600);
    }
    return '';
  }

  /* ------------------------------------------------------------ play URLs */

  function huluWatchUrl(id) { return UUID.test(str(id)) ? 'https://www.hulu.com/watch/' + str(id).toLowerCase() : ''; }

  /** The uuid Hulu's own tile plays: its eab, its metrics_info episode/movie, or a /watch/ href. '' when it names none. */
  function huluPlayId(raw) {
    var r = obj(raw);
    if (!r) return '';
    var p = obj(r.personalization) || {};
    var a = obj(r.actions) || {};
    var pb = obj(a.playback) || {};
    var eab = str(p.eab) || str(p.eab_id) || str(pb.eab_id) || str(pb.eabId) || str(r.eab_id);
    var m = /^EAB::([0-9a-f-]{36})::/i.exec(eab);
    if (m && UUID.test(m[1])) return m[1].toLowerCase();
    var b = obj(a.browse) || {};
    var hm = /\/watch\/([0-9a-f-]{36})(?:[\/?#]|$)/i.exec(str(b.href) || str(r.href));
    if (hm && UUID.test(hm[1])) return hm[1].toLowerCase();
    var mi = obj(r.metrics_info) || obj(r.metricsInfo) || {};
    var tt = str(mi.target_type) || str(mi.targetType);
    var tid = str(mi.target_id) || str(mi.targetId);
    if (/^(episode|movie)$/i.test(tt) && UUID.test(tid)) return tid.toLowerCase();
    return '';
  }

  /** Prime's own tile link, as Prime wrote it, when it already starts playback (autoplay=1). '' otherwise. */
  function primeAutoplayUrl(href, origin) {
    var base = str(origin) || 'https://www.primevideo.com';
    var u;
    try { u = new URL(str(href), base); } catch (e) { return ''; }
    if (u.protocol !== 'https:') return '';
    var h = u.hostname.toLowerCase();
    if (!(hostIs(h, 'primevideo.com') || /(^|\.)amazon\.[a-z.]+$/.test(h))) return '';
    if (u.searchParams.get('autoplay') !== '1') return '';
    if (!/\/detail\//.test(u.pathname)) return '';
    return u.href.slice(0, 600);
  }

  /*
   * Did the service's player refuse the direct link? info: { service, playUrl, url (where the view
   * landed), code (HTTP status of the main frame, 0 unknown), failed (a load error's words) }.
   * '' when the player took it; else the reason, in words that read after "<Service>'s player ...".
   * A sign-in page is not a refusal: the sign-in is what he needs, and the fallback would ask too.
   */
  var AUTH_HOSTS = ['auth.hulu.com', 'registerdisney.go.com', 'mydisney.com', 'accounts.google.com', 'na.account.amazon.com'];
  function refusal(info) {
    var x = obj(info) || {};
    var name = NAMES[x.service] || 'The service';
    var code = num(x.code);
    if (str(x.failed)) return name + '’s player didn’t load (' + str(x.failed).slice(0, 80) + ')';
    if (code !== null && code >= 400) return name + '’s player answered HTTP ' + code;
    var to = parse(x.url);
    var from = parse(x.playUrl);
    if (!to || !from) return '';
    var host = to.hostname.toLowerCase();
    for (var i = 0; i < AUTH_HOSTS.length; i++) if (hostIs(host, AUTH_HOSTS[i])) return '';
    if (/\/(login|signin|sign-in|welcome|ap\/signin)(\/|$)/i.test(to.pathname)) return '';
    if (/(^|\/)(404|error|errors|not-?found|unavailable|content-unavailable)(\/|$|\.)/i.test(to.pathname)) return name + ' sent the player to an error page (' + to.pathname.slice(0, 40) + ')';
    if (x.service === 'hulu' && /^\/watch\//.test(from.pathname) && !/^\/watch\//.test(to.pathname)) return 'Hulu sent the player to ' + (to.pathname.slice(0, 40) || '/') + ' instead of the episode';
    return '';
  }

  /* ------------------------------------------------------------ a player that went back */

  /*
   * Disney+ and Hulu (one platform) play at their own player address: Disney+ /play/<id>, Hulu
   * /watch/<id>. When either won't play a title in this browser it doesn't always say so: its
   * player can route straight back to its home page (or the page it came from) with nothing on
   * screen. The user, 11-06: "it just kept going back to the Disney home page". The layer watches
   * for it: the page reached the player address and left it again before any video started.
   */
  var PLAYER_PATH = { disney: /^\/play\/[^\/]+/i, hulu: /^\/watch\/[^\/]+/i };
  var BOUNCE_MS = 90000;   // longer than that at the player is watching, or waiting, not a refusal
  var NOT_A_BOUNCE = /\/(login|log-in|signin|sign-in|welcome|identity|select-profile|profiles|edit-profiles|account)(\/|$)/i;

  /** Is url the service's own player address (Disney+ /play/<id>, Hulu /watch/<id>)? */
  function inPlayer(service, url) {
    var re = PLAYER_PATH[service];
    var u = parse(url);
    return !!(re && u && (u.protocol === 'https:' || u.protocol === 'http:') && re.test(u.pathname));
  }

  /*
   * Did the service's player send the page away without playing? info: { service, from (the player
   * address), to (where the page went), ms (time spent at the player), played (a video started),
   * user (the layer's own Back did it), eme: { granted, refused, encrypted, licence } (what the page
   * did with Widevine, from drm-preload.js). '' when it isn't a refusal; else one whole sentence.
   */
  function bounced(info) {
    var x = obj(info) || {};
    var name = NAMES[x.service];
    if (!name || !PLAYER_PATH[x.service] || x.played === true || x.user === true) return '';
    if (!inPlayer(x.service, x.from) || inPlayer(x.service, x.to)) return '';
    var ms = num(x.ms);
    if (ms === null || ms < 0 || ms > BOUNCE_MS) return '';
    var to = parse(x.to);
    if (!to) return '';
    var host = to.hostname.toLowerCase();
    for (var i = 0; i < AUTH_HOSTS.length; i++) if (hostIs(host, AUTH_HOSTS[i])) return '';
    if (hostIs(host, 'disney.com') || NOT_A_BOUNCE.test(to.pathname)) return '';   // sign in or pick a profile first: that's what he needs
    var where = /^\/(home|hub\/home)?\/?$/i.test(to.pathname) ? 'its home page' : 'another page';
    var eme = obj(x.eme) || {};
    var why;
    if (str(eme.licence)) why = 'its licence server turned Quartz down (' + str(eme.licence).replace(/-/g, ' ') + ')';
    else if (eme.refused === true && eme.granted !== true) why = 'Quartz’s Widevine wasn’t available to it';
    else if (eme.encrypted === true || eme.granted === true) why = 'it never asked Quartz for a licence for this video';
    else why = 'it stopped before the video asked for Widevine';
    return name + ' went back to ' + where + ' instead of playing: ' + why + '. ' + name + ' does this when it won’t play a title in this browser. Edge can play it.';
  }

  /* ------------------------------------------------------------ resume words */

  /** "S2 E4", "S2:E4 The Bear", "S2 E4 · Bears" -> { s: 2, e: 4 }; "E4" -> { s: null, e: 4 }; else null. */
  function epOf(sub) {
    var t = str(sub);
    var m = /\bS(\d+)\s*[:.·-]?\s*E(\d+)\b/i.exec(t);
    if (m) return { s: Number(m[1]), e: Number(m[2]) };
    m = /\bSeason\s+(\d+)\D+Episode\s+(\d+)\b/i.exec(t);
    if (m) return { s: Number(m[1]), e: Number(m[2]) };
    m = /^E(\d+)\b/i.exec(t);
    if (m) return { s: null, e: Number(m[1]) };
    return null;
  }
  function epText(ep) { return ep ? (ep.s !== null ? 'S' + ep.s + ' E' + ep.e : 'E' + ep.e) : ''; }

  function minutesLeft(it) {
    var x = obj(it) || {};
    var d = num(x.durationSec), p = num(x.progress);
    if (d === null || d <= 0 || p === null) return null;
    return Math.round(d * (1 - Math.max(0, Math.min(1, p))) / 60);
  }
  function leftText(it) {
    var min = minutesLeft(it);
    if (min === null) return '';
    if (min < 1) return 'almost done';
    if (min < 60) return min + ' min left';
    var h = Math.floor(min / 60), r = min % 60;
    return h + ' h' + (r ? ' ' + r + ' min' : '') + ' left';
  }

  /** "Resume S2 E5 · 12 min left" for a resume tile, from what Lumen knows; '' when it knows neither part. */
  function resumeLabel(it) {
    var x = obj(it) || {};
    var ep = x.type === 'movie' ? null : epOf(x.subtitle);
    var left = leftText(x);
    if (!ep && !left) return '';
    return 'Resume' + (ep ? ' ' + epText(ep) : '') + (left ? ' · ' + left : '');
  }

  /* ------------------------------------------------------------ up next */

  /*
   * The next episode of what just ended, from the same service's own rows (its Continue watching
   * moves on once an episode is finished): the same show, a later episode, the nearest one first.
   * current: { id, service, title, subtitle }. items: that service's items, fresh from a re-read.
   */
  function upNextFor(current, items) {
    var c = obj(current);
    if (!c || !Array.isArray(items)) return null;
    var ep = epOf(c.subtitle);
    var t = fold(c.title);
    if (!t) return null;
    var best = null, bestKey = Infinity;
    for (var i = 0; i < items.length; i++) {
      var it = obj(items[i]);
      if (!it || it.service !== c.service || it.type === 'movie' || fold(it.title) !== t) continue;
      var e2 = epOf(it.subtitle);
      if (!e2) continue;
      var key;
      if (ep) {
        var a = (ep.s === null ? 0 : ep.s) * 10000 + ep.e;
        var b = (e2.s === null ? (ep.s === null ? 0 : ep.s) : e2.s) * 10000 + e2.e;
        if (b <= a) continue;
        key = b - a;
      } else {
        // No episode on the one that ended: only the same tile having moved on counts.
        if (it.id !== c.id || fold(it.subtitle) === fold(c.subtitle)) continue;
        key = 1;
      }
      if (it.kind !== 'resume') key += 0.5;   // his Continue row first
      if (key < bestKey) { bestKey = key; best = it; }
    }
    return best;
  }

  /* ------------------------------------------------------------ the layer's words */

  /** The quality note: { text: '720p, browser limit', why: one line } from the video's own height. */
  function qualityNote(service, height) {
    var h = Math.round(num(height) || 0);
    if (h <= 0) return null;
    var name = NAMES[service] || 'This service';
    if (DRM[service] && h <= 720) {
      return { text: h + 'p, browser limit', why: name + ' sends computer browsers at most 720p for protected video; 4K and HDR are on the TV app.' };
    }
    if (DRM[service]) return { text: h + 'p', why: name + ' is sending ' + h + 'p; 4K and HDR are on the TV app.' };
    return { text: h + 'p', why: 'The size ' + name + ' is sending now. ' + name + ' plays up to 4K in Quartz; pick it in the player’s settings.' };
  }

  /** The menu's "Open in Edge" choices, each with its plain reason. o: { refused: '' | reason, height }. */
  function edgeReasons(service, o) {
    var x = obj(o) || {};
    var out = [{ id: 'cast', label: 'Open in Edge to cast to a TV', why: 'Quartz has no Cast; Edge has it built in.' }];
    if (str(x.refused)) out.push({ id: 'licence', label: 'Open in Edge: licence refused', why: str(x.refused).slice(0, 160) });
    if (DRM[service]) out.push({ id: 'sharper', label: 'Open in Edge for a sharper picture', why: 'Edge may get 1080p where Quartz gets 720p (not yet compared side by side). 4K and HDR are on the TV app.' });
    return out;
  }

  return {
    UP_NEXT_SEC: UP_NEXT_SEC,
    NAMES: NAMES,
    profilePage: profilePage,
    initial: initial,
    avatarOf: avatarOf,
    huluWatchUrl: huluWatchUrl,
    huluPlayId: huluPlayId,
    primeAutoplayUrl: primeAutoplayUrl,
    refusal: refusal,
    inPlayer: inPlayer,
    bounced: bounced,
    BOUNCE_MS: BOUNCE_MS,
    epOf: epOf,
    epText: epText,
    leftText: leftText,
    resumeLabel: resumeLabel,
    upNextFor: upNextFor,
    qualityNote: qualityNote,
    edgeReasons: edgeReasons
  };
});
