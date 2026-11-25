'use strict';
// tests/watch-lumen-presshold-test.js -- a press on Lumen's services strip or its popover holds their
// redraw until the press's click has run (watch/presshold.js, wired in watch.js).
//
//   - with no press, a snapshot's redraw runs at once;
//   - during a press it waits (the button pressed stays the one released, so the click fires), and
//     only the latest waiting redraw runs, once, in the task AFTER the release (the click's own task);
//   - a press that is never released lets go after MAX_HOLD_MS; a stale release timer never ends a
//     newer press;
//   - watch.js draws the strip and the popover through the hold in applySnapshot and refreshAgo,
//     arms it in the capture phase for the strip and the popover only, and releases it on pointerup,
//     pointercancel and window blur; watch.html loads presshold.js before watch.js.
// Run by watch-harness.js (it picks up tests/watch-lumen-*-test.js), or alone: node tests/watch-lumen-presshold-test.js
var fs = require('fs');
var path = require('path');
var PH = require('../watch/presshold');

/* timers fired by hand: later(fn, ms) -> handle, run(ms) fires every timer due by then, in order */
function clock() {
  var t = 0, seq = 0, list = [];
  return {
    later: function (fn, ms) { var h = ++seq; list.push({ h: h, at: t + ms, fn: fn }); return h; },
    cancel: function (h) { list = list.filter(function (x) { return x.h !== h; }); },
    run: function (ms) {
      var end = t + ms;
      for (;;) {
        list.sort(function (a, b) { return a.at - b.at || a.h - b.h; });
        var x = list[0];
        if (!x || x.at > end) break;
        list.shift();
        t = x.at;
        x.fn();
      }
      t = end;
    },
    pending: function () { return list.length; }
  };
}

module.exports = async function (check) {
  var src = function (f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); };

  /* no press: at once */
  {
    var c = clock(), h = PH.create(c), n = 0;
    check(h.draw(function () { n++; }) === true && n === 1, 'no press: the redraw runs at once', n);
  }

  /* a press holds; the release lets the click run first; the latest redraw runs once */
  {
    var c2 = clock(), h2 = PH.create(c2), drawn = [];
    h2.press();
    check(h2.held() === true, 'a press holds the redraw');
    check(h2.draw(function () { drawn.push('a'); }) === false && h2.draw(function () { drawn.push('b'); }) === false && drawn.length === 0,
      'during the press nothing is redrawn (the pressed button stays in the page)', drawn);
    h2.release();
    check(drawn.length === 0 && h2.held() === true, 'at the release still nothing: the click runs in the release\'s own task', drawn);
    c2.run(0);
    check(drawn.join('') === 'b' && h2.held() === false, 'the task after the release: the latest redraw, once', drawn);
    c2.run(PH.MAX_HOLD_MS * 2);
    check(drawn.join('') === 'b' && c2.pending() === 0, 'no second redraw and no timer left behind', { drawn: drawn, timers: c2.pending() });
    var m = 0;
    check(h2.draw(function () { m++; }) === true && m === 1, 'after it: redraws run at once again', m);
  }

  /* a press with no redraw waiting: the release draws nothing */
  {
    var c3 = clock(), h3 = PH.create(c3), k = 0;
    h3.press(); h3.release(); c3.run(0);
    check(h3.held() === false && k === 0, 'a press with nothing waiting ends quietly');
  }

  /* the pointer lost: the hold lets go by itself */
  {
    var c4 = clock(), h4 = PH.create(c4), d4 = 0;
    h4.press();
    h4.draw(function () { d4++; });
    c4.run(PH.MAX_HOLD_MS - 1);
    check(d4 === 0, 'a press never released holds until MAX_HOLD_MS', d4);
    c4.run(1);
    check(d4 === 1 && h4.held() === false, 'then lets go and redraws (the strip is never left stale)', d4);
    check(PH.MAX_HOLD_MS >= 1000 && PH.MAX_HOLD_MS <= 30000, 'MAX_HOLD_MS is seconds, not minutes', PH.MAX_HOLD_MS);
  }

  /* a release's timer never ends a newer press */
  {
    var c5 = clock(), h5 = PH.create(c5), d5 = 0;
    h5.press(); h5.release();       // its timer is queued...
    h5.press();                     // ...and a second press comes before it fires
    h5.draw(function () { d5++; });
    c5.run(0);
    check(d5 === 0 && h5.held() === true, 'a stale release timer does not end the next press', d5);
    h5.release(); c5.run(0);
    check(d5 === 1 && h5.held() === false, 'the second press\'s release redraws', d5);
    check(c5.pending() === 0, 'every timer is fired or cancelled', c5.pending());
  }

  /* watch.js and watch.html use it */
  {
    var w = src('watch.js').replace(/\/\*[\s\S]*?\*\//g, '');
    var html = src('watch.html');
    var apply = (w.match(/function applySnapshot\(snap\) \{[\s\S]*?\n  \}/) || [''])[0];
    var ago = (w.match(/function refreshAgo\(\) \{[\s\S]*?\n  \}/) || [''])[0];
    check(/S\.hold\.draw\(drawStripPop\)/.test(apply) && !/renderStrip\(\)|fillPop\(\)/.test(apply), 'applySnapshot redraws the strip and the popover through the hold only', apply.slice(0, 400));
    check(/S\.hold\.draw\(drawStripPop\)/.test(ago) && !/renderStrip\(\)|fillPop\(\)/.test(ago), 'refreshAgo redraws them through the hold only', ago.slice(0, 400));
    check(/function drawStripPop\(\) \{\s*renderStrip\(\);\s*if \(!\$\.pop\.hidden\) \{ fillPop\(\); placePop\(\); \}\s*\}/.test(w), 'drawStripPop: the strip, then the open popover filled and placed');
    check(/addEventListener\('pointerdown', function \(e\) \{\s*if \(e\.button === 0 && e\.target && \(\$\.pills\.contains\(e\.target\) \|\| \$\.pop\.contains\(e\.target\)\)\) S\.hold\.press\(\);\s*\}, true\)/.test(w),
      'a primary press on the strip or the popover arms the hold, in the capture phase');
    check(/addEventListener\('pointerup', function \(\) \{ S\.hold\.release\(\); \}, true\)/.test(w) && /addEventListener\('pointercancel', function \(\) \{ S\.hold\.release\(\); \}, true\)/.test(w) &&
      /window\.addEventListener\('blur', function \(\) \{ S\.hold\.release\(\); \}\)/.test(w), 'pointerup, pointercancel and window blur release it');
    var iPh = html.indexOf('<script src="watch/presshold.js"></script>'), iW = html.indexOf('<script src="watch.js"></script>');
    check(iPh !== -1 && iW !== -1 && iPh < iW, 'watch.html loads watch/presshold.js before watch.js', { presshold: iPh, watch: iW });
  }
};

if (require.main === module) {
  var pass = 0;
  var fail = 0;
  module.exports(function (cond, label, detail) {
    if (cond) { pass++; return; }
    fail++;
    console.log('FAIL ' + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 300)));
  }).then(function () {
    console.log('watch-lumen-presshold-test: ' + pass + ' passed, ' + fail + ' failed');
    process.exitCode = fail ? 1 : 0;
  }, function (err) {
    console.log('watch-lumen-presshold-test threw: ' + String((err && err.stack) || err).slice(0, 400));
    process.exitCode = 1;
  });
}
