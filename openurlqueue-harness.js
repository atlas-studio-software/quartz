// openurlqueue-harness.js - pure-node test for openurlqueue.js (run: node openurlqueue-harness.js).
// Each command line goes through the same steps main.js's 'second-instance' and
// cold-start paths take: closetabs.commandPlan(requestFromArgv(argv), urlFromArgv(argv)),
// then openUrlTab(plan.url), which is createLinkOpener().open().
const path = require('path');
const { urlFromArgv } = require('./argvurl');
const closeTabs = require('./closetabs');
const { createOpenUrlQueue, createLinkOpener, noticeText, placeOf, MAX } = require('./openurlqueue');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
function ok(name, cond) { eq(name, !!cond, true); }

const EXE = path.join(__dirname, 'node_modules', 'electron', 'dist', 'Quartz.exe');
const ROOT = __dirname;

/** A fake main: the chrome is loading until ready(); sends and log lines are recorded. */
function fakeMain() {
  const sent = [], lines = [];
  let listening = false;
  const opener = createLinkOpener({
    isReady: () => listening,
    send: (payload) => sent.push(payload),
    log: (line) => lines.push(line),
  });
  return {
    sent, lines, opener,
    // What app.on('second-instance') does with one command line (minus raising the window).
    commandLine(...rest) {
      const argv = [EXE, ROOT, ...rest];
      const plan = closeTabs.commandPlan(closeTabs.requestFromArgv(argv), urlFromArgv(argv));
      opener.open(plan.url);
      return plan;
    },
    // 'did-finish-load': the chrome is listening, the parked links go.
    ready() { listening = true; opener.flush(); },
  };
}
const urls = (sent) => sent.map((p) => p.url);

// --- two links during startup both open, in arrival order ---
{
  const m = fakeMain();
  m.commandLine('https://first.test/a');
  m.commandLine('https://second.test/b');
  eq('startup: nothing is sent while the chrome loads', m.sent.length, 0);
  eq('startup: both wait', m.opener.size(), 2);
  m.ready();
  eq('startup: both open, oldest first', urls(m.sent), ['https://first.test/a', 'https://second.test/b']);
  ok('startup: every one is a foreground tab (the last ends on top)', m.sent.every((p) => p.background === false));
  ok('startup: no notice when nothing was dropped', m.sent.every((p) => !('notice' in p)));
  eq('startup: no log lines', m.lines, []);
  eq('startup: the queue is empty after the flush', m.opener.size(), 0);
  m.ready();
  eq('startup: a second did-finish-load sends nothing again', m.sent.length, 2);
}

// --- one link during startup: exactly today's single-URL payload ---
{
  const m = fakeMain();
  m.commandLine('https://only.test/');
  m.ready();
  eq('one link: same payload as before the queue', m.sent, [{ url: 'https://only.test/', background: false }]);
}

// --- the argv contract is unchanged: the LAST candidate of each call ---
{
  const m = fakeMain();
  m.commandLine('https://a1.test/', 'https://a2.test/');
  m.commandLine('--flag', 'https://b.test/');
  m.ready();
  eq('argv: last candidate per command line, one tab per line', urls(m.sent), ['https://a2.test/', 'https://b.test/']);
}

// --- 11 links during startup keep the newest 10 ---
{
  const m = fakeMain();
  for (let i = 1; i <= 11; i++) m.commandLine('https://site' + i + '.test/p?q=secret');
  eq('11 links: MAX is 10', MAX, 10);
  eq('11 links: 10 wait', m.opener.size(), 10);
  eq('11 links: one log line for the drop', m.lines.length, 1);
  ok('11 links: the line names the dropped host', /site1\.test/.test(m.lines[0]) && !/site2\.test/.test(m.lines[0]));
  ok('11 links: the line has no path or query', !/secret|\/p/.test(m.lines[0]));
  ok('11 links: the line is a sentence', /^[A-Z].*\.$/.test(m.lines[0]));
  m.ready();
  const want = [];
  for (let i = 2; i <= 11; i++) want.push('https://site' + i + '.test/p?q=secret');
  eq('11 links: the newest 10 open, oldest first', urls(m.sent), want);
  eq('11 links: only the last carries the notice', m.sent.map((p) => !!p.notice), [false, false, false, false, false, false, false, false, false, true]);
  eq('11 links: the notice words', (m.sent[9] || {}).notice, noticeText(1));
  eq('11 links: notice text', noticeText(1), '1 link was not opened: more than 10 arrived while Quartz was starting, so the oldest were dropped.');
}

// --- 13 links: three drops, counted on screen ---
{
  const m = fakeMain();
  for (let i = 1; i <= 13; i++) m.commandLine('https://s' + i + '.test/');
  eq('13 links: three log lines', m.lines.length, 3);
  m.ready();
  eq('13 links: s4..s13 open', urls(m.sent)[0], 'https://s4.test/');
  ok('13 links: the notice says 3', /^3 links were not opened/.test((m.sent[m.sent.length - 1] || {}).notice));
}

// --- a link after ready behaves as today: sent at once, foreground ---
{
  const m = fakeMain();
  m.ready();
  m.commandLine('https://later.test/');
  eq('after ready: sent at once with the same payload', m.sent, [{ url: 'https://later.test/', background: false }]);
  eq('after ready: nothing parked', m.opener.size(), 0);
  m.commandLine('https://later2.test/');
  eq('after ready: each link straight away', urls(m.sent), ['https://later.test/', 'https://later2.test/']);
}

// --- order holds if the chrome reloads with links parked ---
{
  const sent = [];
  let listening = false;
  const o = createLinkOpener({ isReady: () => listening, send: (p) => sent.push(p), log: () => {} });
  o.open('https://early.test/');
  listening = true;           // listening again, but the flush has not run yet
  o.open('https://next.test/');
  eq('order: a parked link goes before a newer one', urls(sent), ['https://early.test/', 'https://next.test/']);
}

// --- non-http(s) addresses are still refused ---
{
  const m = fakeMain();
  for (const bad of ['javascript:alert(1)', 'ftp://example.com/x', 'data:text/html,hi', 'mailto:a@b.test', 'quartz://x', 'hello', 'ftp://x/y.html', 'javascript:x.html']) {
    m.commandLine(bad);
  }
  m.ready();
  eq('refused: nothing opens from other schemes', m.sent, []);
  eq('refused: argvurl never hands them over, so no log line', m.lines, []);
  // What argvurl.js accepts besides http(s) is unchanged (file: URLs and .htm(l) paths).
  const f = fakeMain();
  f.commandLine('file:///C:/x.html');
  f.ready();
  eq('file: URLs still open as before', urls(f.sent), ['file:///C:/x.html']);
}

// --- the queue refuses on its own too (a bug upstream cannot park a script) ---
{
  const lines = [];
  const q = createOpenUrlQueue({ log: (l) => lines.push(l) });
  eq('queue: javascript: refused', q.park('javascript:alert(1)').ok, false);
  eq('queue: data: refused', q.park('data:text/html,x').ok, false);
  eq('queue: non-string refused', q.park(42).ok, false);
  eq('queue: http: with no host refused', q.park('http:///x').ok, false);
  eq('queue: nothing parked', q.size(), 0);
  eq('queue: one sentence per refusal', lines.length, 4);
  ok('queue: refusal words', /^A link from a command line was refused: only an http\(s\) or file: address/.test(lines[0]));
  eq('queue: https accepted', q.park('https://x.test/').ok, true);
  eq('queue: null link is ignored by the opener', (() => { const s = []; const o = createLinkOpener({ isReady: () => true, send: (p) => s.push(p) }); o.open(null); o.open(''); return s.length; })(), 0);
}

// --- small pieces ---
eq('placeOf: host only', placeOf('https://www.example.com:8443/a?b'), 'example.com:8443');
eq('placeOf: a local file', placeOf('file:///C:/x.html'), 'a local file');
eq('noticeText: nothing dropped', noticeText(0), '');
eq('max option', (() => { const q = createOpenUrlQueue({ max: 2 }); q.park('https://a.test/'); q.park('https://b.test/'); q.park('https://c.test/'); return q.drain().map((p) => p.url); })(), ['https://b.test/', 'https://c.test/']);

console.log(`openurlqueue: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
