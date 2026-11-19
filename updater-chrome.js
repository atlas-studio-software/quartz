/*
 * updater-chrome.js -- in-app updates, the chrome's half (index.html loads it before settings.js).
 *
 * 1. THE CARD. A release that is out, an update in progress, an update that failed, or "Quartz is
 *    now on vX" after the restart: one card in the corner of the chrome, built from the same parts
 *    as the Lumen Alerts card (watch-alerts.css: .lumen-alert*), so it looks like every other
 *    Quartz notice. Neutral greys, the accent only on the Update button, no glow; it fades in once
 *    and then holds still. Update / Later when the button is offered; otherwise the sentence saying
 *    exactly why not, and the commands to do it by hand.
 *
 * 2. SETTINGS > ABOUT > UPDATES. settings.js gives this file its field and DOM helpers
 *    (QuartzUpdates.renderAbout(field, helpers)): the "Check for updates" switch, the state in one
 *    sentence (including why a check failed, e.g. "Couldn't check for updates: no internet"), Check
 *    now, and the same Update button or reason as the card.
 *
 * 3. THE RESTART. When main says the update is in (updates:restart), a plain one goes through
 *    window.restartBrowser() (session written first, then app:restart); a swap asks main to quit
 *    for the swap helper. Main restarts by itself if neither arrives.
 */
(function () {
  'use strict';
  var api = window.api && window.api.updates;
  var st = null;            // main's last state
  var readErr = '';         // why state() could not be read
  var stack = null;
  var card = null;
  var dismissed = {};       // card keys the user closed this run (failed / updated)
  var renderers = [];       // Settings fields to redraw on a push
  var test = { cards: [], restarts: [] };
  window.__updatesTest = test;

  var STAGES = [['downloading', 'Downloading'], ['installing', 'Installing'], ['restarting', 'Restarting']];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function button(label, cls, act, onClick) {
    var b = el('button', cls, label);
    b.type = 'button';
    if (act) b.setAttribute('data-act', act);
    b.addEventListener('click', onClick);
    return b;
  }
  function why(err) {
    var m = String((err && err.message) || err || '').replace(/^Error invoking remote method '[^']*': (Error: )?/, '').trim();
    return m || 'no reason was given';
  }
  function clock(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function toast(text) {
    var t = window.Toast;
    if (t && typeof t.show === 'function') { try { t.show(text, 4000); } catch (e) { /* the card still says it */ } }
  }
  function youHave(s) {
    var c = s.current || {};
    return (c.version ? 'v' + c.version : 'this version') + (c.sha ? ' (' + c.sha + ')' : '');
  }

  /* --- actions ------------------------------------------------------------------------------ */

  function take(p, what) {
    return Promise.resolve(p).then(function (s) { if (s && s.status) apply(s); return s; },
      function (e) { var m = what + ': ' + why(e); toast(m); readErr = m; redrawAll(); });
  }
  function doUpdate() {
    if (!api) return;
    // Drawn at once, before main's first push: the click visibly took.
    if (st) apply(Object.assign({}, st, { status: 'updating', progress: { stage: 'downloading', text: 'Starting the update…' } }));
    Promise.resolve(api.update()).then(function (r) {
      if (r && r.state) apply(r.state);
    }, function (e) { readErr = 'The update could not start: ' + why(e); toast(readErr); ask(); });
  }
  function doLater() { if (api) take(api.later(), 'Later did not stick'); }
  function doCheck() { if (api) { if (st) apply(Object.assign({}, st, { status: 'checking' })); take(api.check(), 'Couldn\'t check for updates'); } }
  function doOpenLog() { if (api) Promise.resolve(api.openLog()).catch(function (e) { toast('The log could not be shown: ' + why(e)); }); }
  function copy(lines) {
    var text = lines.join('\r\n');
    try {
      navigator.clipboard.writeText(text).then(function () { toast('Commands copied'); }, function (e) { toast('Copy failed: ' + why(e)); });
    } catch (e) { toast('Copy failed: ' + why(e)); }
  }

  /* --- the card ----------------------------------------------------------------------------- */

  function ensureStack() {
    if (stack && stack.isConnected) return stack;
    stack = el('div', 'lumen-alerts qup-stack');
    stack.setAttribute('role', 'region');
    stack.setAttribute('aria-label', 'Quartz updates');
    document.body.appendChild(stack);
    return stack;
  }

  function closeCard() {
    if (!card) return;
    var c = card;
    card = null;
    c.classList.remove('is-up');
    window.setTimeout(function () { if (c.parentNode) c.parentNode.removeChild(c); }, 200);
  }

  /** What the card should say for this state, or null for no card. */
  function cardKey(s) {
    if (!s) return '';
    var tag = s.release ? s.release.tag : '';
    if (s.status === 'available' && !s.snoozed) return 'available:' + tag + ':' + (s.canUpdate ? 1 : 0) + ':' + s.blocked;
    if (s.status === 'updating') return 'updating:' + tag;
    if (s.status === 'failed' && s.failure) return 'failed:' + s.failure.at;
    // "Now on vX" stays until OK or Later, even once the first check after the restart says current.
    if (s.updated && s.status !== 'available') return 'updated:' + s.updated.tag;
    return '';
  }

  function manualBlock(lines) {
    var wrap = el('div', 'qup-manual');
    wrap.appendChild(el('div', 'qup-manual-head', 'To update by hand, in a terminal:'));
    wrap.appendChild(el('pre', 'qup-cmd', lines.join('\n')));
    return wrap;
  }

  function steps(stage) {
    var row = el('ol', 'qup-steps');
    var reached = true;
    STAGES.forEach(function (sg) {
      var li = el('li', 'qup-step', sg[1]);
      if (sg[0] === stage) { li.className += ' is-now'; li.setAttribute('aria-current', 'step'); reached = false; }
      else if (reached) li.className += ' is-done';
      row.appendChild(li);
    });
    return row;
  }

  function drawCard(s) {
    var key = cardKey(s);
    if (!key || dismissed[key]) { closeCard(); return; }
    var kind = key.split(':')[0];
    if (card && card.getAttribute('data-key') === key && kind !== 'updating') return;
    if (!document.body) return;
    var fresh = !card;
    var c = card || el('div', 'lumen-alert qup-card');
    c.textContent = '';
    c.setAttribute('role', kind === 'failed' ? 'alert' : 'status');
    c.setAttribute('data-key', key);
    c.setAttribute('data-status', kind);
    var rel = s.release || {};
    var head = el('div', 'lumen-alert-head');
    head.appendChild(el('span', 'lumen-alert-src', 'Quartz · Update'));
    if (kind !== 'updating') {
      var x = el('button', 'lumen-alert-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', kind === 'available' ? 'Later' : 'Dismiss');
      x.addEventListener('click', function () { if (kind === 'available') doLater(); else { dismissed[key] = true; closeCard(); } });
      head.appendChild(x);
    }
    c.appendChild(head);
    var acts = el('div', 'lumen-alert-acts');

    if (kind === 'available') {
      c.appendChild(el('div', 'lumen-alert-title', 'Quartz ' + rel.tag + ' is out'));
      c.appendChild(el('div', 'lumen-alert-body', 'You have ' + youHave(s) + '.'));
      if (s.canUpdate) {
        if (s.needsNpm) c.appendChild(el('div', 'lumen-alert-body', 'This release changes Quartz\'s dependencies, so the update runs npm ci. That can take several minutes.'));
        // A copy with no release key yet installs this one unchecked: said, never silent.
        if (s.signature && s.signature.state === 'unpinned') c.appendChild(el('div', 'lumen-alert-note qup-sig', s.signature.text));
        acts.appendChild(button('Update', 'lumen-alert-btn is-primary', 'update', doUpdate));
      } else if (s.download) {
        // An installed copy (Quartz-Setup.exe): the new installer is the update.
        c.appendChild(el('div', 'lumen-alert-body', 'This copy was installed with Quartz-Setup.exe. Download the new installer and run it: it replaces this copy and keeps your tabs, logins and settings.'));
        acts.appendChild(button('Download the installer', 'lumen-alert-btn is-primary', 'download', function () { openUrl(s.download); }));
      } else {
        c.appendChild(el('div', 'lumen-alert-note', 'No Update button: ' + s.blocked + '.'));
        if (s.manual && s.manual.length) {
          c.appendChild(manualBlock(s.manual));
          acts.appendChild(button('Copy commands', 'lumen-alert-btn', 'copy', function () { copy(s.manual); }));
        }
      }
      acts.appendChild(button('Later', 'lumen-alert-btn', 'later', doLater));
      if (rel.url) acts.appendChild(button('What\'s new', 'lumen-alert-btn', 'notes', function () { openUrl(rel.url); }));
    } else if (kind === 'updating') {
      var p = s.progress || {};
      c.appendChild(el('div', 'lumen-alert-title', 'Updating to ' + (rel.tag || 'the new release')));
      c.appendChild(steps(p.stage));
      c.appendChild(el('div', 'lumen-alert-body qup-progress', p.text || ''));
    } else if (kind === 'failed') {
      c.appendChild(el('div', 'lumen-alert-title', s.failure.withdrawn ? 'This update is no longer offered' : 'The update didn\'t finish'));
      c.appendChild(el('div', 'lumen-alert-body', s.failure.reason + '.'));
      c.appendChild(el('div', 'lumen-alert-note', 'Log: ' + s.failure.log));
      acts.appendChild(button('Show the log', 'lumen-alert-btn', 'log', doOpenLog));
      if (s.release && s.canUpdate) acts.appendChild(button('Try again', 'lumen-alert-btn', 'update', doUpdate));
    } else if (kind === 'updated') {
      c.appendChild(el('div', 'lumen-alert-title', 'Quartz is now on ' + s.updated.tag));
      c.appendChild(el('div', 'lumen-alert-body', 'Updated from ' + s.updated.from + ' to ' + s.updated.to + '. Your tabs are where you left them.'));
      acts.appendChild(button('OK', 'lumen-alert-btn', 'ok', function () { dismissed[key] = true; closeCard(); }));
    }
    if (acts.children.length) c.appendChild(acts);
    if (fresh) {
      c.addEventListener('keydown', function (e) { if (e.key === 'Escape' && card) { var xb = card.querySelector('.lumen-alert-x'); if (xb) xb.click(); } });
      ensureStack().appendChild(c);
      card = c;
      window.requestAnimationFrame(function () { c.classList.add('is-up'); });
    }
    test.cards.push({ status: s.status, key: key, text: c.textContent.slice(0, 400) });
  }

  function openUrl(url) {
    // app.js is a classic script, so its createTab(url) is a global.
    try { if (typeof window.createTab === 'function' && window.createTab(url)) return; } catch (e) { /* said below */ }
    toast('The release page could not be opened: ' + url);
  }

  /* --- Settings > About > Updates ---------------------------------------------------------- */

  function statusLine(s) {
    if (!s) return readErr || 'Updates: asking…';
    var at = s.checkedAt ? ' Checked at ' + clock(s.checkedAt) + '.' : '';
    var next = s.nextAt ? ' Next check at ' + clock(s.nextAt) + '.' : '';
    switch (s.status) {
      case 'off': return 'Updates are off: ' + s.off + '.';
      case 'idle': return s.enabled ? 'Quartz checks for a new release shortly after it starts, then every 6 hours.' + next
        : 'Quartz does not check for updates by itself. Check now still works.';
      case 'checking': return 'Checking for updates…';
      case 'current': return 'Up to date: you have ' + youHave(s) + (s.ahead ? ', ahead of' : ', and') + ' the latest release is ' + s.release.tag + '.' + at + next;
      case 'none': return 'No release has been published yet.' + at + next;
      case 'error': return 'Couldn\'t check for updates: ' + s.error + '.' + at + next;
      case 'available': return 'Quartz ' + s.release.tag + ' is out. You have ' + youHave(s) + '.' + at;
      case 'updating': return (s.progress && s.progress.text) || 'Updating…';
      case 'failed': return (s.failure && s.failure.withdrawn ? 'The update was not installed: ' : 'The last update didn\'t finish: ') + (s.failure ? s.failure.reason : 'no reason was given') + '.';
      case 'updated': return 'Quartz is now on ' + s.updated.tag + ' (updated from ' + s.updated.from + ').';
      default: return 'Updates: ' + s.status;
    }
  }

  function drawField(field, h) {
    field.textContent = '';
    var s = st;
    if (!api) { field.appendChild(h.el('p', 'set-hint', 'Updates: this window has no updater bridge; restart Quartz.')); return; }
    if (s) {
      var sw = h.switchRow('Check for updates', !!s.enabled, function (on) { take(api.setEnabled(on), 'That setting could not be saved'); });
      if (s.status === 'off') { sw.disabled = true; sw.setAttribute('aria-disabled', 'true'); }
      field.appendChild(sw);
    }
    var line = h.el('p', 'set-hint qup-about-line', statusLine(s));
    line.setAttribute('data-updates-status', s ? s.status : 'unknown');
    field.appendChild(line);
    if (readErr && s) field.appendChild(h.el('p', 'set-hint qup-about-err', readErr));
    if (!s) return;
    // The release tag's signature: checked and trusted, or not checked (no key yet). A refused one is
    // already the first reason in "No Update button" below.
    if (s.status === 'available' && s.signature && s.signature.state !== 'refused') {
      var sig = h.el('p', 'set-hint qup-about-sig', s.signature.text);
      sig.setAttribute('data-signature', s.signature.state);
      field.appendChild(sig);
    }
    if (s.status === 'available' && s.download) {
      field.appendChild(h.el('p', 'set-hint', 'This copy was installed with Quartz-Setup.exe: download the new installer and run it over this one. Your tabs, logins and settings stay.'));
    } else if (s.status === 'available' && !s.canUpdate) {
      field.appendChild(h.el('p', 'set-hint', 'No Update button: ' + s.blocked + '.'));
      if (s.manual && s.manual.length) field.appendChild(manualBlock(s.manual));
    }
    if (s.status === 'failed' && s.failure) field.appendChild(h.el('p', 'set-hint', 'Log: ' + s.failure.log));
    var row = h.el('div', 'qup-about-acts');
    if (s.status === 'available' && s.canUpdate) row.appendChild(h.textButton('Update to ' + s.release.tag, 'set-btn', doUpdate));
    if (s.status === 'available' && s.download) row.appendChild(h.textButton('Download the ' + s.release.tag + ' installer', 'set-btn', function () { openUrl(s.download); }));
    if (s.status !== 'off') {
      var chk = h.textButton(s.status === 'checking' ? 'Checking…' : 'Check now', 'set-btn', doCheck);
      if (s.status === 'checking' || s.status === 'updating') chk.disabled = true;
      row.appendChild(chk);
    }
    if (s.status === 'failed' || s.status === 'error') row.appendChild(h.textButton('Show the log', 'set-btn', doOpenLog));
    if (row.children.length) field.appendChild(row);
  }

  function redrawAll() {
    renderers = renderers.filter(function (r) { return r.field.isConnected; });
    renderers.forEach(function (r) { try { drawField(r.field, r.h); } catch (e) { r.field.textContent = 'Updates: ' + why(e); } });
  }

  function apply(s) {
    st = s;
    readErr = '';
    try { drawCard(s); } catch (e) { /* Settings still says it */ }
    redrawAll();
  }

  function ask() {
    if (!api) return;
    Promise.resolve(api.state()).then(function (s) { if (s) apply(s); },
      function (e) { readErr = 'Updates: the main process did not answer (' + why(e) + ')'; redrawAll(); });
  }

  if (api) {
    api.onState(apply);
    api.onRestart(function (m) {
      test.restarts.push(m && m.mode);
      if (m && m.mode === 'swap') { api.restartNow(); return; }
      var done = false;
      try { done = typeof window.restartBrowser === 'function' && window.restartBrowser() !== false; } catch (e) { done = false; }
      if (!done) api.restartNow();
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ask); else ask();
  }

  window.QuartzUpdates = {
    /** Settings > About: draw the Updates rows into field with settings.js's helpers. */
    renderAbout: function (field, helpers) {
      renderers.push({ field: field, h: helpers });
      drawField(field, helpers);
      ask();
    },
  };
})();
