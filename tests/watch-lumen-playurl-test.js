'use strict';
// tests/watch-lumen-playurl-test.js -- watch/playurl.js (straight to the player, the fallback, resume words,
// up next, the layer's notes) and the adapters' and main's use of it. Fixtures only; run by watch-harness.js.
var fs = require('fs');
var path = require('path');
var P = require('../watch/playurl');
var shape = require('../watch/shape');
var hulu = require('../watch/adapters/hulu');
var disney = require('../watch/adapters/disney');
var prime = require('../watch/adapters/prime');
var WatchMain = require('../watch-main');

var FIX = path.join(__dirname, 'watch-fixtures');
function fx(name) { return JSON.parse(fs.readFileSync(path.join(FIX, name + '.json'), 'utf8')); }
var BEAR_EP = '60da223c-d2a0-411a-95c9-665a839371f9';
var X_MOVIE = '3fbf22c6-aa72-4f9d-a34e-618687012de4';

// One read as the reader view hands it over (tests/watch-adapter-hulu.js's stepFrom, the same shape).
function huluRead(home, over) {
  var finalUrl = 'https://www.hulu.com' + home.finalPath;
  var step = { ok: true, url: 'https://www.hulu.com/hub/home', finalUrl: finalUrl, title: home.title, status: 200,
    extracted: { url: finalUrl, title: home.title, login: false },
    captures: (home.captures || []).map(function (c) { return { url: (/^\/v\d+\/users\//.test(c.path) ? 'https://home.hulu.com' : 'https://discover.hulu.com') + c.path, status: c.status || 200, json: c.json }; }),
    error: null };
  for (var k in (over || {})) step[k] = over[k];
  return { now: Date.parse('2026-10-17T20:00:00Z'), steps: { home: step } };
}

module.exports = async function (check) {
  /* ---- Hulu: the play id and URL ---- */
  check(P.huluPlayId({ personalization: { eab: 'EAB::' + BEAR_EP + '::215066976::302377370' } }) === BEAR_EP, 'hulu: the eab names the episode');
  check(P.huluPlayId({ actions: { browse: { href: '/watch/' + X_MOVIE } } }) === X_MOVIE, 'hulu: a /watch/ href names it');
  check(P.huluPlayId({ metrics_info: { target_type: 'episode', target_id: BEAR_EP } }) === BEAR_EP, 'hulu: metrics_info episode target names it');
  check(P.huluPlayId({ metrics_info: { target_type: 'series', target_id: BEAR_EP } }) === '', 'hulu: a series target is not something to play');
  check(P.huluPlayId({ personalization: { eab: 'EAB::not-a-uuid::1::2' } }) === '' && P.huluPlayId(null) === '', 'hulu: junk names nothing');
  check(P.huluWatchUrl(BEAR_EP) === 'https://www.hulu.com/watch/' + BEAR_EP, 'hulu: /watch/<uuid>');
  check(P.huluWatchUrl('../../x') === '' && P.huluWatchUrl('') === '', 'hulu: no URL from a non-uuid');

  var res = shape.cleanResult(hulu.parse(huluRead(fx('hulu-home'))));
  var bear = res.items.filter(function (i) { return i.title === 'The Bear' && i.kind === 'resume'; })[0];
  check(bear && bear.playUrl === 'https://www.hulu.com/watch/' + BEAR_EP && /\/series\//.test(bear.url), 'hulu adapter: The Bear (Keep Watching) plays /watch/<episode>, its series page is the fallback', bear && { url: bear.url, playUrl: bear.playUrl });
  var xm = res.items.filter(function (i) { return i.title === 'X' && i.kind === 'resume'; })[0];
  check(xm && xm.playUrl === 'https://www.hulu.com/watch/' + X_MOVIE, 'hulu adapter: a film in Keep Watching plays /watch/<film>', xm && xm.playUrl);
  check(res.items.filter(function (i) { return i.kind !== 'resume' && i.playUrl; }).length === 0, 'hulu adapter: only Continue tiles go straight to the player');
  check(res.profile === 'Alex' && !res.avatar, 'hulu adapter: the profile name, and no picture when Hulu names none', { profile: res.profile, avatar: res.avatar });
  var picked = shape.cleanResult(hulu.parse(huluRead(fx('hulu-home'), { finalUrl: 'https://secure.hulu.com/profiles/select' })));
  check(picked.state === 'error' && picked.picker === true && /who's watching/.test(picked.reason), 'hulu adapter: the picker is flagged picker (Pick profile)', picked);

  /* ---- Disney+: the picker flag, no /play/ guess ---- */
  var dPick = shape.cleanResult(disney.parse({ now: Date.now(), steps: { home: { name: 'home', url: 'https://www.disneyplus.com/home', finalUrl: 'https://www.disneyplus.com/select-profile', status: 200, title: "Who's Watching? | Disney+", extracted: { url: 'https://www.disneyplus.com/select-profile', title: '', login: false }, captures: [], error: null } } }));
  check(dPick.state === 'error' && dPick.picker === true, 'disney adapter: /select-profile is flagged picker', dPick);

  /* ---- Prime: only its own autoplay link ---- */
  check(P.primeAutoplayUrl('/detail/B0ABCDEF12/ref=atv_cw?autoplay=1&t=812') === 'https://www.primevideo.com/detail/B0ABCDEF12/ref=atv_cw?autoplay=1&t=812', 'prime: its own autoplay link, as written');
  check(P.primeAutoplayUrl('/detail/B0ABCDEF12/') === '', 'prime: a plain title link stays the title page');
  check(P.primeAutoplayUrl('https://evil.example/detail/B0ABCDEF12?autoplay=1') === '' && P.primeAutoplayUrl('http://www.primevideo.com/detail/B0ABCDEF12?autoplay=1') === '', 'prime: never another host, never http');

  /* ---- shape keeps playUrl only on the same service ---- */
  var base = { service: 'hulu', kind: 'resume', title: 'T', url: 'https://www.hulu.com/series/' + BEAR_EP };
  check(shape.cleanItem(Object.assign({}, base, { playUrl: 'https://www.hulu.com/watch/' + BEAR_EP })).playUrl === 'https://www.hulu.com/watch/' + BEAR_EP, 'shape: playUrl kept on the same service');
  check(!('playUrl' in shape.cleanItem(Object.assign({}, base, { playUrl: 'https://www.youtube.com/watch?v=x' }))), 'shape: playUrl on another service dropped');
  check(!('playUrl' in shape.cleanItem(Object.assign({}, base, { playUrl: 'javascript:alert(1)' }))), 'shape: a non-https playUrl dropped');
  check(shape.cleanResult({ state: 'ok', items: [], avatar: 'http://x/y.png' }).avatar === undefined, 'shape: an http avatar dropped');
  check(shape.cleanResult({ state: 'ok', items: [], picker: true }).picker === undefined, 'shape: picker only on an error');

  /* ---- a player that went back without playing (Disney+ /play/<id> straight back to /home) ---- */
  var DP = 'https://www.disneyplus.com/play/9ba0f41b-6173-4ff1-8967-71cad0620244';
  var DHOME = 'https://www.disneyplus.com/home';
  check(P.inPlayer('disney', DP) && P.inPlayer('hulu', 'https://www.hulu.com/watch/' + BEAR_EP) && P.inPlayer('disney', 'http://127.0.0.1:5000/play/x'), 'player: the player addresses');
  check(!P.inPlayer('disney', DHOME) && !P.inPlayer('disney', 'https://www.disneyplus.com/browse/entity-x') && !P.inPlayer('disney', 'https://www.disneyplus.com/play/') &&
    !P.inPlayer('prime', 'https://www.primevideo.com/play/x') && !P.inPlayer('youtube', 'https://www.youtube.com/watch?v=x') && !P.inPlayer('disney', 'not a url'), 'player: anything else is not');
  var bb = P.bounced({ service: 'disney', from: DP, to: DHOME, ms: 4000, played: false, eme: null });
  check(/^Disney\+ went back to its home page instead of playing: it stopped before the video asked for Widevine\. .*Edge can play it\.$/.test(bb), 'bounce: home, no Widevine seen', bb);
  check(/never asked Quartz for a licence/.test(P.bounced({ service: 'disney', from: DP, to: DHOME, ms: 4000, eme: { granted: true } })), 'bounce: Widevine granted, no licence asked');
  check(/licence server turned Quartz down \(no licence\)/.test(P.bounced({ service: 'disney', from: DP, to: DHOME, ms: 4000, eme: { granted: true, licence: 'no-licence' } })), 'bounce: the licence outcome says it');
  check(/Widevine wasn’t available/.test(P.bounced({ service: 'disney', from: DP, to: DHOME, ms: 4000, eme: { refused: true } })), 'bounce: Widevine refused');
  check(/went back to another page/.test(P.bounced({ service: 'disney', from: DP, to: 'https://www.disneyplus.com/browse/entity-x', ms: 4000 })), 'bounce: back to the title page');
  check(/^Hulu went back to its home page/.test(P.bounced({ service: 'hulu', from: 'https://www.hulu.com/watch/' + BEAR_EP, to: 'https://www.hulu.com/hub/home', ms: 2000 })), 'bounce: Hulu too');
  check(P.bounced({ service: 'disney', from: DP, to: DHOME, ms: 4000, played: true }) === '', 'bounce: not after a video played');
  check(P.bounced({ service: 'disney', from: DP, to: DHOME, ms: 4000, user: true }) === '', 'bounce: not his own Back');
  check(P.bounced({ service: 'disney', from: DP, to: DHOME, ms: P.BOUNCE_MS + 1 }) === '' && P.bounced({ service: 'disney', from: DP, to: DHOME }) === '', 'bounce: not after a long stay, not without a time');
  check(P.bounced({ service: 'disney', from: DP, to: DP + '?x=1', ms: 1000 }) === '' && P.bounced({ service: 'disney', from: DHOME, to: DHOME, ms: 1000 }) === '', 'bounce: only out of the player');
  check(P.bounced({ service: 'disney', from: DP, to: 'https://www.disneyplus.com/select-profile', ms: 1000 }) === '' &&
    P.bounced({ service: 'disney', from: DP, to: 'https://www.disneyplus.com/identity/login', ms: 1000 }) === '' &&
    P.bounced({ service: 'disney', from: DP, to: 'https://login.disney.com/x', ms: 1000 }) === '', 'bounce: a sign-in or profile pick is not one');
  check(P.bounced({ service: 'prime', from: 'https://www.primevideo.com/play/x', to: 'https://www.primevideo.com/', ms: 1000 }) === '' && P.bounced(null) === '', 'bounce: only the services with a player address');

  /* ---- the fallback ---- */
  var play = 'https://www.hulu.com/watch/' + BEAR_EP;
  check(P.refusal({ service: 'hulu', playUrl: play, url: play, code: 200 }) === '', 'refusal: the player took it');
  check(/HTTP 404/.test(P.refusal({ service: 'hulu', playUrl: play, url: play, code: 404 })), 'refusal: an HTTP error');
  check(/didn’t load/.test(P.refusal({ service: 'hulu', playUrl: play, url: play, failed: 'ERR_CONNECTION_REFUSED' })), 'refusal: a failed load');
  check(/instead of the episode/.test(P.refusal({ service: 'hulu', playUrl: play, url: 'https://www.hulu.com/hub/home', code: 200 })), 'refusal: Hulu sent the player home');
  check(/error page/.test(P.refusal({ service: 'prime', playUrl: 'https://www.primevideo.com/detail/B0X?autoplay=1', url: 'https://www.primevideo.com/errors/404', code: 200 })), 'refusal: an error page');
  check(P.refusal({ service: 'hulu', playUrl: play, url: 'https://auth.hulu.com/web/login?next=/watch/x', code: 200 }) === '', 'refusal: a sign-in page is not a refusal');
  check(P.refusal({ service: 'hulu', playUrl: 'http://127.0.0.1:5000/watch/' + BEAR_EP, url: 'http://127.0.0.1:5000/watch/' + BEAR_EP + '?play=1', code: 200 }) === '', 'refusal: still on /watch/ (rebased) is fine');

  /* ---- resume words ---- */
  check(P.resumeLabel({ subtitle: 'S2 E5 · Bears', progress: 0.6, durationSec: 1800 }) === 'Resume S2 E5 · 12 min left', 'resume: "Resume S2 E5 · 12 min left"');
  check(P.resumeLabel({ type: 'movie', subtitle: 'Horror, 2022', progress: 0.35, durationSec: 6300 }) === 'Resume · 1 h 8 min left', 'resume: a film says time left only');
  check(P.resumeLabel({ subtitle: 'S1:E3', progress: null }) === 'Resume S1 E3', 'resume: the episode alone when the time is unknown');
  check(P.resumeLabel({ subtitle: 'Some channel' }) === '', 'resume: nothing known -> no label (the old line stays)');

  /* ---- up next ---- */
  var cur = { id: 'hulu:s1', service: 'hulu', title: 'The Bear', subtitle: 'S4 E3 · Bears' };
  var items = [
    { id: 'hulu:s1', service: 'hulu', kind: 'resume', type: 'show', title: 'The Bear', subtitle: 'S4 E4 · Next', url: 'https://www.hulu.com/series/s1' },
    { id: 'hulu:s1b', service: 'hulu', kind: 'rec', type: 'show', title: 'The Bear', subtitle: 'S4 E6', url: 'https://www.hulu.com/series/s1' },
    { id: 'hulu:old', service: 'hulu', kind: 'resume', type: 'show', title: 'The Bear', subtitle: 'S4 E2', url: 'https://www.hulu.com/series/s1' },
    { id: 'disney:b', service: 'disney', kind: 'resume', type: 'show', title: 'The Bear', subtitle: 'S4 E4', url: 'https://www.disneyplus.com/browse/entity-x' }
  ];
  var nx = P.upNextFor(cur, items);
  check(nx && nx.subtitle === 'S4 E4 · Next', 'up next: the nearest later episode, same service', nx);
  check(P.upNextFor(cur, items.slice(2)) === null, 'up next: an earlier episode or another service is never next');
  check(P.upNextFor({ id: 'hulu:m', service: 'hulu', title: 'X', subtitle: '' }, [{ id: 'hulu:m', service: 'hulu', type: 'movie', title: 'X', subtitle: '' }]) === null, 'up next: a film has none');
  check(P.upNextFor({ id: 'hulu:s1', service: 'hulu', title: 'The Bear', subtitle: 'Bears' }, [{ id: 'hulu:s1', service: 'hulu', kind: 'resume', title: 'The Bear', subtitle: 'S4 E4' }]).subtitle === 'S4 E4', 'up next: no episode on record -> the same tile, moved on');

  /* ---- the layer's words ---- */
  var q = P.qualityNote('hulu', 720);
  check(q && q.text === '720p, browser limit' && /720p/.test(q.why) && /TV app/.test(q.why), 'quality: "720p, browser limit" with its reason', q);
  check(P.qualityNote('youtube', 1080).text === '1080p' && P.qualityNote('hulu', 0) === null, 'quality: YouTube says its height; no height, no note');
  var er = P.edgeReasons('disney', { refused: 'Disney+ refused to license this video' });
  check(er.map(function (r) { return r.id; }).join(',') === 'cast,licence,sharper' && er.every(function (r) { return r.why; }), 'menu: Edge for cast, a refused licence, a sharper picture, each with a reason');
  check(P.edgeReasons('youtube', {}).map(function (r) { return r.id; }).join(',') === 'cast', 'menu: YouTube has no browser cap: cast only');

  /* ---- profiles ---- */
  check(P.profilePage('hulu').url === 'https://www.hulu.com/profiles' && P.profilePage('disney').url === 'https://www.disneyplus.com/select-profile' && P.profilePage('espn') === null, 'profiles: the services\' own pickers; ESPN has none');
  check(/top right/.test(P.profilePage('prime').where), 'profiles: Prime says where its menu is');
  check(P.avatarOf('hulu', { avatar: { url: 'https://img.hulu.com/user/v3/avatar/1.png' } }) === 'https://img.hulu.com/user/v3/avatar/1.png', 'profiles: a picture on the service\'s own host');
  check(P.avatarOf('hulu', { avatarUrl: 'https://evil.example/a.png' }) === '' && P.avatarOf('hulu', { avatarUrl: 'http://img.hulu.com/a.png' }) === '', 'profiles: never another host, never http');
  check(P.initial('alex') === 'A' && P.initial('') === '', 'profiles: the initial');

  /* ---- main: the page's lines ---- */
  var L = WatchMain.LINE_PREFIX;
  var o = WatchMain.parseGuestLine(L + 'open ' + JSON.stringify({ url: play, fallback: 'https://www.hulu.com/series/x', item: { id: 'hulu:x', title: 'The Bear', subtitle: 'S4 E3' } }));
  check(o && o.fallback === 'https://www.hulu.com/series/x' && o.item && o.item.id === 'hulu:x', 'main: open keeps the fallback and the item', o);
  var o2 = WatchMain.parseGuestLine(L + 'open ' + JSON.stringify({ url: play, fallback: 'https://www.youtube.com/', item: { id: 'disney:x', title: 'T' } }));
  check(o2 && o2.fallback === '' && o2.item === null, 'main: a fallback or item on another service is dropped', o2);
  check(WatchMain.parseGuestLine(L + 'profile {"service":"hulu"}').service === 'hulu' && WatchMain.parseGuestLine(L + 'profile {"service":"espn"}') === null, 'main: profile for a service with a picker only');
};
