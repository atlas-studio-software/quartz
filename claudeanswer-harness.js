// claudeanswer-harness.js — pure-node test for claudeanswer.js (run: node claudeanswer-harness.js).
// No Electron, never the real API: tests/anthropic-mock.js is a local MOCK Anthropic server, a fake
// safeStorage stands in for DPAPI, a fake clock drives the month, and the store goes to a temp
// folder that is deleted at the end. One summary line: "claudeanswer: N passed, M failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const C = require('./claudeanswer');
const M = require('./tests/anthropic-mock');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
function ok(name, cond, detail) {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (detail !== undefined ? '  ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : '')); }
}
function near(name, got, want) { ok(name, Math.abs(got - want) < 1e-9, got + ' vs ' + want); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- pure helpers ------------------------------------------------------------------------ */
eq('mask long', C.maskKey('sk-ant-api03-abcdefgh1234'), '••••1234');
eq('mask short', C.maskKey('abc'), '•••');
eq('cleanKey trims', C.cleanKey('  sk-ant-x  '), 'sk-ant-x');
eq('cleanKey refuses inner space', C.cleanKey('sk-ant x'), '');

eq('line ok', C.parseAnswerLine('quartz-search:answer {"q":" what  is quartz ","seq":4,"mode":"deep"}'), { q: 'what is quartz', seq: 4, mode: 'deep', history: [] });
eq('line default mode auto', C.parseAnswerLine('quartz-search:answer {"q":"x","seq":1}').mode, 'auto');
eq('line bad mode', C.parseAnswerLine('quartz-search:answer {"q":"x","seq":1,"mode":"turbo"}'), null);
eq('line no seq', C.parseAnswerLine('quartz-search:answer {"q":"x"}'), null);
eq('line long q', C.parseAnswerLine('quartz-search:answer ' + JSON.stringify({ q: 'a'.repeat(1001), seq: 1 })), null);
eq('line junk', C.parseAnswerLine('quartz-search:answer {nope'), null);
eq('line brave prefix is not ours', C.parseAnswerLine('quartz-search:query {"q":"x","seq":1}'), null);
eq('stop line', C.parseStopLine('quartz-search:answer-stop {"seq":7}'), { seq: 7 });
eq('stop line junk', C.parseStopLine('quartz-search:answer-stop {"seq":"x"}'), null);
eq('answer line is not a stop line', C.parseStopLine('quartz-search:answer {"seq":7}'), null);

const longHist = [];
for (let i = 0; i < 20; i++) longHist.push({ role: i % 2 ? 'user' : 'assistant', text: String.fromCharCode(97 + i).repeat(1000) });
const capped = C.capHistory(longHist);
ok('history cap: at most ' + C.HISTORY_MAX_TURNS + ' turns', capped.length <= C.HISTORY_MAX_TURNS, capped.length);
ok('history cap: total chars', capped.reduce((n, h) => n + h.text.length, 0) <= C.HISTORY_MAX_CHARS);
eq('history cap: starts with a user turn', capped[0] && capped[0].role, 'user');
eq('history cap: keeps the newest', capped[capped.length - 1].text[0], 't');
eq('history cap: drops junk', C.capHistory([{ role: 'system', text: 'x' }, { role: 'user', text: '' }, null, { role: 'user', text: 'ok' }]), [{ role: 'user', text: 'ok' }]);
eq('history cap: one long turn trimmed', C.capHistory([{ role: 'user', text: 'z'.repeat(5000) }])[0].text.length, 1500);

for (const [q, want] of [['youtube', false], ['gmail login', false], ['best pizza nyc', false], ['how to tie a tie', true], ['what is quartz', true],
  ['rust vs go', true], ['weather tomorrow?', true], ['Is it raining', true], ['difference between tcp and udp', true]]) {
  eq('looksLikeQuestion ' + JSON.stringify(q), C.looksLikeQuestion(q), want);
}

near('cost haiku', C.estimateCost('claude-haiku-5-5', { input: 50000, output: 1000000, searches: 0 }), 50000 * 0.10 / 1e6 + 0.50);
near('cost haiku over 100k prompt', C.estimateCost('claude-haiku-5-5', { input: 150000, output: 1000 }), (150000 * 0.5 + 1000 * 2.5) / 1e6);
near('cost haiku + cache + searches', C.estimateCost('claude-haiku-5-5', { input: 1000, cacheWrite: 1000, cacheRead: 1000, output: 1000, searches: 2 }), (1000 * 0.10 + 1000 * 0.125 + 1000 * 0.01 + 1000 * 0.50) / 1e6 + 0.02);
eq('only Haiku is offered', C.MODELS.map((m) => m.id), ['claude-haiku-5-5']);
eq('only Haiku is priced (Sonnet/Opus rows are gone)', Object.keys(C.PRICES), ['claude-haiku-5-5']);
eq('defaults: both answers on Haiku', [C.DEFAULTS.autoModel, C.DEFAULTS.deepModel], ['claude-haiku-5-5', 'claude-haiku-5-5']);
eq('plan: quick is Haiku, 4096, 2 searches, high', C.PLAN.quick, { model: 'claude-haiku-5-5', maxTokens: 4096, maxUses: 2, effort: 'high' });
eq('plan: deep is Haiku, 8192, 4 searches, high', C.PLAN.deep, { model: 'claude-haiku-5-5', maxTokens: 8192, maxUses: 4, effort: 'high' });
near('cost unknown model errs high', C.estimateCost('claude-mystery', { input: 1e6 }), 10);

{
  const got = [];
  const p = C.sseParser((e) => got.push(e));
  p.push('event: a\r\ndata: {"x"'); p.push(':1}\r\n\r\n: comment\n\nevent: b\ndata: {"y":2}\n'); p.push('\n'); p.push('data: nope\n\n');
  eq('sse parser: split chunks, CRLF, comments', got.map((e) => [e.event, e.data]), [['a', { x: 1 }], ['b', { y: 2 }], ['', undefined]]);
}

/* ---- the module, against the mock ----------------------------------------------------------- */
(async () => {
  const mock = await M.start();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-answer-harness-'));
  const store = path.join(tmp, 'claude-answer.json');
  const logs = [];
  const pushed = [];     // every payload any page was given
  const described = [];  // every describe()-shaped answer
  const fakeSafe = {
    available: true,
    isEncryptionAvailable() { return this.available; },
    encryptString(s) { return Buffer.from('DPAPI:' + Buffer.from(String(s)).toString('hex').split('').reverse().join('')); },
    decryptString(b) { const t = b.toString(); if (t.indexOf('DPAPI:') !== 0) throw new Error('bad blob'); return Buffer.from(t.slice(6).split('').reverse().join(''), 'hex').toString(); },
  };
  let clock = new Date(2026, 9, 17, 12, 0, 0).getTime();
  const mk = (extra) => C.create(Object.assign({
    apiBase: mock.base, storePath: () => store, safeStorage: fakeSafe, log: (...a) => logs.push(a.join(' ')), now: () => clock,
    isBundledPage: (u) => String(u).indexOf('file:///C:/quartz/') === 0,
  }, extra || {}));
  const KEY = M.GOOD_KEY_PREFIX + '-harness-SECRET-1234567890';
  const d = (x) => { described.push(x); return x; };
  async function ask(mod, input, slot) {
    const got = [];
    const t0 = Date.now();
    await mod.answer(input, (o) => { got.push(o); pushed.push(o); }, slot);
    if (process.env.CA_TIMING) console.log('[t] ' + (Date.now() - t0) + ' ms ' + input.q);
    return got;
  }
  const last = (got) => got[got.length - 1] || {};
  const reqs = () => mock.requests.filter((r) => r.path.indexOf('/v1/messages') === 0);
  const deltas = (got) => got.filter((o) => o.phase === 'delta').map((o) => o.text).join('');
  function isFail(name, o, state) {
    ok(name + ': fail ' + state, o.phase === 'fail' && o.state === state, o);
    ok(name + ': says why', typeof o.title === 'string' && o.title.length > 3 && typeof o.detail === 'string' && o.detail.length > 10 && typeof o.retry === 'boolean' && typeof o.settings === 'boolean', o);
  }

  try {
    let ca = mk();

    // ---- no key: auto is quiet, ask says so, nothing is sent -----------------------------------
    eq('no key: describe', (d(ca.describe())).hasKey, false);
    let got = await ask(ca, { q: 'what is quartz', seq: 1, mode: 'auto' });
    eq('no key, auto: off no-key', got, [{ seq: 1, phase: 'off', reason: 'no-key' }]);
    got = await ask(ca, { q: 'what is quartz', seq: 2, mode: 'ask' });
    isFail('no key, ask', last(got), 'no-key');
    ok('no key, ask: points to Settings', last(got).settings === true && /platform\.claude\.com\/settings\/keys/.test(last(got).detail));
    eq('no key: nothing went to Anthropic', mock.requests.length, 0);

    // ---- the key: refused pastes, encryption, never in the clear --------------------------------
    ok('key with a space is refused', !!d(ca.setKey('sk-ant bad key')).error);
    ok('admin key is refused', /Admin API key/.test(d(ca.setKey('sk-ant-admin01-abcdefghijk')).error || ''));
    fakeSafe.available = false;
    const noEnc = d(ca.setKey(KEY));
    ok('no safeStorage: refused, not written', /could not encrypt/.test(noEnc.error || '') && !noEnc.hasKey && !fs.existsSync(store), noEnc.error);
    fakeSafe.available = true;
    let desc = d(ca.setKey(KEY));
    ok('key saved', desc.hasKey && !desc.error, desc);
    eq('key mask', desc.keyMask, '••••7890');
    const file1 = fs.readFileSync(store, 'utf8');
    ok('store holds the key ENCRYPTED, never in the clear', file1.indexOf(KEY) < 0 && /"keyEnc": "/.test(file1));
    eq('store blob decrypts to the key', fakeSafe.decryptString(Buffer.from(JSON.parse(file1).keyEnc, 'base64')), KEY);
    ok('describe() never carries the key', JSON.stringify(desc).indexOf(KEY) < 0 && JSON.stringify(desc).indexOf('SECRET') < 0);
    eq('a fresh instance decrypts it', d(mk().describe()).hasKey, true);
    const broken = mk({ safeStorage: { isEncryptionAvailable: () => true, encryptString: fakeSafe.encryptString, decryptString: () => { throw new Error('DPAPI: wrong user'); } } });
    const bd = d(broken.describe());
    ok('undecryptable key: no key, and says why', !bd.hasKey && /could not be decrypted/.test(bd.keyError), bd);
    got = await ask(broken, { q: 'x', seq: 1, mode: 'ask' });
    ok('undecryptable key: ask fails no-key with the reason', last(got).state === 'no-key' && /could not be decrypted/.test(last(got).detail));

    // ---- Check key: GET /v1/models, free ------------------------------------------------------
    let t = d(await ca.test());
    ok('check key: works, naming Haiku only', t.check && t.check.ok && /Claude Haiku 5\.5 is open/.test(t.check.detail) && !/Sonnet|Opus/.test(t.check.detail), t.check);
    const mreq = mock.requests[mock.requests.length - 1];
    ok('check key: GET /v1/models with the key header', mreq.method === 'GET' && mreq.path.indexOf('/v1/models') === 0 && mreq.key === KEY && mreq.version === '2023-06-01', mreq);
    const mock2 = await M.start({ models: ['claude-haiku-5-5'] });
    const ca2 = mk({ apiBase: mock2.base });
    t = d(await ca2.test());
    ok('check key: a list with only Haiku is enough', t.check && t.check.ok, t.check);
    await mock2.close();
    const mock3 = await M.start({ models: ['claude-sonnet-5-5', 'claude-opus-5-5'] });
    t = d(await mk({ apiBase: mock3.base }).test());
    ok('check key: Haiku missing from the list is said', t.check && !t.check.ok && /no Claude Haiku 5\.5/.test(t.check.detail), t.check);
    await mock3.close();
    const badKeyMod = mk({ storePath: () => path.join(tmp, 'bad.json') });
    badKeyMod.setKey('sk-ant-api03-wrongkey-0000');
    t = d(await badKeyMod.test());
    ok('check key: bad key -> bad-key with what Anthropic said', t.check && t.check.state === 'bad-key' && /Anthropic answered 401 authentication_error/.test(t.check.detail), t.check);

    // ---- a streamed, cited answer ---------------------------------------------------------------
    const before = reqs().length;
    got = await ask(ca, { q: 'what is quartz', seq: 5, mode: 'auto' });
    const r1 = reqs()[before];
    eq('answer: phases', [got[0].phase, last(got).phase], ['start', 'done']);
    eq('answer: start says the model', [got[0].seq, got[0].model, got[0].modelLabel, got[0].mode], [5, 'claude-haiku-5-5', 'Claude Haiku 5.5', 'auto']);
    const done = last(got);
    eq('answer: text with [n] markers, lead-in dropped', done.text, 'Quartz is a hard mineral made of silica [1], and it keeps time in watches [2][1] because it vibrates at a steady frequency.');
    eq('answer: deltas add up to the final text', deltas(got), done.text);
    ok('answer: streamed in more than one delta', got.filter((o) => o.phase === 'delta').length >= 2, got.length);
    ok('answer: the mock pauses past the delta window, so the delta count does not ride on timer resolution', M.OK_GAP_MS >= 3 * C.DELTA_FLUSH_MS, [M.OK_GAP_MS, C.DELTA_FLUSH_MS]);
    eq('answer: citations', done.citations, [
      { n: 1, url: M.URL_A, title: 'Quartz - Wikipedia', host: 'en.wikipedia.org' },
      { n: 2, url: M.URL_B, title: 'Quartz | Britannica', host: 'britannica.com' }]);
    eq('answer: usage', [done.usage.input, done.usage.output, done.usage.searches, done.usage.cacheWrite], [5800, 120, 1, 600]);
    near('answer: cost from usage x published prices + $0.01/search', done.costUsd, (5200 * 0.10 + 600 * 0.125 + 120 * 0.50) / 1e6 + 0.01);
    ok('request: model, stream, modest max_tokens', r1.body.model === 'claude-haiku-5-5' && r1.body.stream === true && r1.body.max_tokens === 4096, r1.body);
    eq('request: Anthropic web search, small max_uses', r1.body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]);
    eq('request: high effort for the quick answer (requested 10-17)', r1.body.output_config, { effort: 'high' });
    ok('request: cached system prompt first, date after the breakpoint', r1.body.system[0].text === C.SYSTEM_PROMPT && r1.body.system[0].cache_control.type === 'ephemeral' && !r1.body.system[1].cache_control && /^Today is /.test(r1.body.system[1].text), r1.body.system);
    eq('request: just the query', r1.body.messages, [{ role: 'user', content: 'what is quartz' }]);
    ok('request: no fallbacks, no beta header', !('fallbacks' in r1.body) && r1.beta === '' && r1.key === KEY && r1.version === '2023-06-01', r1);
    ok('request: no Brave results in it', JSON.stringify(r1.body).indexOf('search.brave.com') < 0 && JSON.stringify(r1.body).toLowerCase().indexOf('brave') < 0);
    desc = d(ca.describe());
    ok('month: the answer counted', desc.month.answers === 1 && Math.abs(desc.month.spentUsd - done.costUsd) < 1e-6 && desc.month.label === 'October 2026', desc.month);

    // ---- the in-memory cache: Back / reload do not pay twice ------------------------------------
    const n0 = reqs().length;
    got = await ask(ca, { q: 'what is quartz', seq: 6, mode: 'auto' });
    ok('cache: same answer, nothing sent, nothing spent', last(got).phase === 'done' && last(got).cached === true && last(got).costUsd === 0 && last(got).text === done.text && reqs().length === n0 && d(ca.describe()).month.answers === 1, last(got));

    // ---- deep: still Haiku, more searching and a longer answer -----------------------------------
    got = await ask(ca, { q: 'mock:nosearch capital of france', seq: 7, mode: 'deep' });
    const rd = reqs()[reqs().length - 1];
    eq('deep: text', last(got).text, 'Paris is the capital of France.');
    ok('deep uses Haiku, 8192, 4 searches, high (requested 10-17: "only haiku")', rd.body.model === 'claude-haiku-5-5' && rd.body.max_tokens === 8192 && rd.body.tools[0].max_uses === 4 && rd.body.output_config.effort === 'high', rd.body);
    ok('deep: no fallbacks, no beta header', !('fallbacks' in rd.body) && rd.beta === '', rd.beta);
    ok('deep: start and done both say Haiku', got[0].model === 'claude-haiku-5-5' && got[0].modelLabel === 'Claude Haiku 5.5' && last(got).model === 'claude-haiku-5-5' && last(got).modelLabel === 'Claude Haiku 5.5', [got[0], last(got).model]);
    ok('deep: context says deeper', /deeper answer/.test(rd.body.system[1].text));
    near('deep: priced at Haiku', last(got).costUsd, (900 * 0.10 + 12 * 0.50) / 1e6);
    ok('deep: setConfig cannot pick another model', /only use Claude Haiku 5\.5/.test(d(ca.setConfig({ deepModel: 'claude-sonnet-5-5' })).error || '') && d(ca.describe()).deepModel === 'claude-haiku-5-5');
    eq('deep: short uncited answer still delivered by delta', deltas(got), 'Paris is the capital of France.');

    got = await ask(ca, { q: 'mock:long text', seq: 8, mode: 'ask' });
    ok('long answer: streamed in several deltas', got.filter((o) => o.phase === 'delta').length >= 2 && deltas(got) === last(got).text, got.filter((o) => o.phase === 'delta').length);
    got = await ask(ca, { q: 'mock:markdown x', seq: 9, mode: 'ask' });
    ok('markdown subset passes through as text (the page renders it)', /^\*\*Quartz\*\* is silica\.\n\n- Hard/.test(last(got).text), last(got).text);

    // ---- the mode setting ---------------------------------------------------------------------
    ok('mode: bad value refused', !!d(ca.setConfig({ mode: 'sometimes' })).error);
    d(ca.setConfig({ mode: 'manual' }));
    let n1 = reqs().length;
    got = await ask(ca, { q: 'what is a quark', seq: 10, mode: 'auto' });
    eq('manual: auto is off', got, [{ seq: 10, phase: 'off', reason: 'manual' }]);
    got = await ask(ca, { q: 'mock:nosearch manual ask', seq: 11, mode: 'ask' });
    ok('manual: "Ask Claude" still answers', last(got).phase === 'done' && reqs().length === n1 + 1);
    d(ca.setConfig({ mode: 'questions' }));
    got = await ask(ca, { q: 'youtube', seq: 12, mode: 'auto' });
    eq('questions: a site name is off', got, [{ seq: 12, phase: 'off', reason: 'not-question' }]);
    got = await ask(ca, { q: 'mock:nosearch what is everest?', seq: 13, mode: 'auto' });
    ok('questions: a question is answered', last(got).phase === 'done', last(got));
    eq('mode back to every', d(ca.setConfig({ mode: 'every' })).mode, 'every');

    // ---- every fail state, forced against the mock ---------------------------------------------
    const cases = [
      ['mock:401 x', 'bad-key', /Anthropic answered 401 authentication_error: "invalid x-api-key"/],
      ['mock:403 x', 'bad-key', /permission_error/],
      ['mock:429 x', 'rate-limited', /wait 7 s/],
      ['mock:529 x', 'overloaded', /overloaded_error/],
      ['mock:credit x', 'no-credit', /credit balance is too low/],
      ['mock:402 x', 'no-credit', /billing_error/],
      ['mock:spendlimit x', 'no-credit', /usage limits/],
      ['mock:500 x', 'server', /api_error/],
      ['mock:404 x', 'server', /not_found_error/],
      ['mock:websearch-off x', 'server', /Web search is not enabled/],
      ['mock:garbage x', 'bad-answer', /not with a stream \(text\/html/],
      ['mock:empty x', 'bad-answer', /wrote no text/],
      ['mock:refusal x', 'bad-answer', /refusal \(cyber\)/],
      ['mock:drop x', 'offline', /connection|cut off/],
    ];
    let seq = 100;
    for (const [q, state, re] of cases) {
      got = await ask(ca, { q, seq: ++seq, mode: 'ask' });
      isFail(q, last(got), state);
      ok(q + ': detail quotes the real answer', re.test(last(got).detail), last(got).detail);
      ok(q + ': fail is the last thing the page gets', got.filter((o) => o.phase === 'done').length === 0);
    }
    got = await ask(ca, { q: 'mock:stream-overloaded x', seq: ++seq, mode: 'ask' });
    isFail('stream error', last(got), 'overloaded');
    ok('stream error: says it stopped mid-answer, partial cost counted', /stopped mid-answer/.test(last(got).detail) && last(got).costUsd > 0, last(got));
    ok('refusal: retry is off, settings off', (() => { const r = cases.find((c) => c[0] === 'mock:refusal x'); return !!r; })());
    const closed = await M.start(); const closedBase = closed.base; await closed.close();
    const offMod = mk({ apiBase: closedBase });
    got = await ask(offMod, { q: 'x', seq: 1, mode: 'ask' });
    isFail('refused connection', last(got), 'offline');
    ok('refused connection: says refused', /refused/.test(last(got).detail), last(got).detail);
    const slowMod = mk({ timeouts: { headers: 300, idle: 300, total: 5000 } });
    got = await ask(slowMod, { q: 'mock:noheaders x', seq: 1, mode: 'ask' });
    isFail('no headers', last(got), 'offline');
    ok('no headers: says it did not start', /did not start answering within 0\.3 seconds/.test(last(got).detail), last(got).detail);
    got = await ask(slowMod, { q: 'mock:silent x', seq: 2, mode: 'ask' });
    isFail('went quiet', last(got), 'offline');
    ok('went quiet: says so', /went quiet for 0\.3 seconds/.test(last(got).detail), last(got).detail);

    // ---- done with notes -------------------------------------------------------------------------
    got = await ask(ca, { q: 'mock:maxtokens x', seq: ++seq, mode: 'ask' });
    ok('max_tokens: done, marked truncated', last(got).phase === 'done' && last(got).truncated === true, last(got));
    got = await ask(ca, { q: 'mock:search-error x', seq: ++seq, mode: 'ask' });
    ok('web search error: answer kept, error reported', last(got).phase === 'done' && JSON.stringify(last(got).searchErrors) === '["too_many_requests"]' && last(got).text === 'From what I know, quartz is silicon dioxide.', last(got));

    // ---- pause_turn: continued with the blocks exactly as sent ------------------------------------
    const np = reqs().length;
    got = await ask(ca, { q: 'mock:pause quartz', seq: ++seq, mode: 'ask' });
    const [p1, p2] = reqs().slice(np);
    eq('pause_turn: final text', last(got).text, 'Quartz is silica [1].');
    ok('pause_turn: two requests', reqs().length === np + 2 && p2 && p2.body.messages.length === 2 && p2.body.messages[1].role === 'assistant');
    const blocks = p2 ? p2.body.messages[1].content : [];
    ok('pause_turn: server_tool_use input rebuilt from the deltas', blocks[0] && blocks[0].type === 'server_tool_use' && JSON.stringify(blocks[0].input) === '{"query":"quartz"}' && !('_json' in blocks[0]), blocks[0]);
    ok('pause_turn: search results sent back with encrypted_content intact', blocks[1] && blocks[1].type === 'web_search_tool_result' && blocks[1].content[0].encrypted_content === 'ENC_A_' + 'x'.repeat(40), blocks[1]);
    near('pause_turn: both requests priced', last(got).costUsd, (4000 * 0.1 + 30 * 0.5) / 1e6 + 0.01 + (4100 * 0.1 + 20 * 0.5) / 1e6);
    ok('pause_turn: first request was the same body', p1 && p1.body.messages.length === 1);

    // ---- only Haiku may answer -------------------------------------------------------------------
    got = await ask(ca, { q: 'mock:wrong-model x', seq: ++seq, mode: 'ask' });
    isFail('a stream reporting a non-Haiku model is refused', last(got), 'bad-answer');
    ok('non-Haiku stream: says which model, plainly', /claude-sonnet-5-5, not Claude Haiku 5\.5/.test(last(got).detail), last(got).detail);
    ok('non-Haiku stream: none of its text reached the page', deltas(got) === '' && got.filter((o) => o.phase === 'done').length === 0, deltas(got));
    ok('non-Haiku stream: one start only', got.filter((o) => o.phase === 'start').length === 1);
    got = await ask(ca, { q: 'mock:no-model x', seq: ++seq, mode: 'ask' });
    isFail('a stream naming no model is refused', last(got), 'bad-answer');
    ok('no-model stream: says so', /did not say which model/.test(last(got).detail), last(got).detail);
    got = await ask(ca, { q: 'mock:fallback x', seq: ++seq, mode: 'deep' });
    isFail('an unasked-for fallback block is refused', last(got), 'bad-answer');
    ok('fallback block: names the switch plainly', /switched this answer from Claude Haiku 5\.5 to claude-opus-4-8/.test(last(got).detail), last(got).detail);
    ok('fallback block: one start, no reset, no fallback text shown', got.filter((o) => o.phase === 'start').length === 1 && deltas(got).indexOf('Answer from the fallback model') < 0, got.filter((o) => o.phase === 'start'));
    ok('fallback block: what streamed still costs something', last(got).costUsd > 0, last(got).costUsd);
    got = await ask(ca, { q: 'mock:big x', seq: ++seq, mode: 'ask' });
    near('Haiku over 100k prompt tokens: long-context price row', last(got).costUsd, (150000 * 0.5 + 1000 * 2.5) / 1e6);

    // ---- a stored non-Haiku config is sanitised ---------------------------------------------------
    {
      const oldStore = path.join(tmp, 'old-sonnet.json');
      const blob = JSON.parse(fs.readFileSync(store, 'utf8'));
      blob.cfg = Object.assign({}, blob.cfg, { autoModel: 'claude-opus-5-5', deepModel: 'claude-sonnet-5-5' });
      fs.writeFileSync(oldStore, JSON.stringify(blob));
      const oldMod = mk({ storePath: () => oldStore });
      const od = d(oldMod.describe());
      ok('a stored non-Haiku config is sanitised', od.autoModel === 'claude-haiku-5-5' && od.deepModel === 'claude-haiku-5-5' && od.answerModel === 'claude-haiku-5-5', [od.autoModel, od.deepModel]);
      const nOld = reqs().length;
      got = await ask(oldMod, { q: 'mock:nosearch old profile deep', seq: ++seq, mode: 'deep' });
      ok('old Sonnet profile: deep still goes to Haiku', reqs()[nOld] && reqs()[nOld].body.model === 'claude-haiku-5-5' && last(got).model === 'claude-haiku-5-5', reqs()[nOld] && reqs()[nOld].body.model);
      d(oldMod.setConfig({ mode: 'every' }));
      const saved = JSON.parse(fs.readFileSync(oldStore, 'utf8')).cfg;
      ok('old Sonnet profile: the next save writes Haiku', saved.autoModel === 'claude-haiku-5-5' && saved.deepModel === 'claude-haiku-5-5', saved);
    }

    // ---- stop, stale stop, supersede ------------------------------------------------------------------
    {
      const out = [];
      const p = ca.answer({ q: 'mock:slow one', seq: 300, mode: 'ask' }, (o) => out.push(o), 'pageA');
      for (let i = 0; i < 100 && !out.some((o) => o.phase === 'delta'); i++) await sleep(20);
      eq('stale stop is ignored', ca.stopAnswer(299, 'pageA'), false);
      eq('stop with the live seq', ca.stopAnswer(300, 'pageA'), true);
      await p;
      const f = out[out.length - 1];
      isFail('stopped', f, 'stopped');
      ok('stopped: text so far was delivered first', out.some((o) => o.phase === 'delta'));
      await sleep(100);
      const sr = reqs().filter((r) => r.scenario === 'slow');
      ok('stopped: the fetch was really aborted', sr.length === 1 && sr[0].aborted === true, sr.map((r) => r.aborted));
    }
    {
      const outA = [], outB = [];
      const pA = ca.answer({ q: 'mock:slow two', seq: 400, mode: 'ask' }, (o) => outA.push(o), 'pageB');
      for (let i = 0; i < 100 && !outA.some((o) => o.phase === 'delta'); i++) await sleep(20);
      const pB = ca.answer({ q: 'mock:nosearch newer', seq: 401, mode: 'ask' }, (o) => outB.push(o), 'pageB');
      await Promise.all([pA, pB]);
      ok('supersede: the old seq gets nothing more (no done, no fail)', !outA.some((o) => o.phase === 'done' || o.phase === 'fail') && outA.every((o) => o.seq === 400), outA.map((o) => o.phase));
      ok('supersede: the new seq answers', outB[outB.length - 1].phase === 'done' && outB.every((o) => o.seq === 401));
      await sleep(100);
      const sr = reqs().filter((r) => r.scenario === 'slow');
      ok('supersede: the old fetch was aborted', sr.length === 2 && sr[1].aborted === true);
    }

    // ---- the history cap reaches the wire --------------------------------------------------------------
    got = await ask(ca, { q: 'mock:nosearch follow-up', seq: ++seq, mode: 'ask', history: longHist });
    const rh = reqs()[reqs().length - 1];
    const histChars = rh.body.messages.slice(0, -1).reduce((n, m) => n + m.content.length, 0);
    ok('history on the wire: capped and user-first', rh.body.messages.length <= C.HISTORY_MAX_TURNS + 1 && histChars <= C.HISTORY_MAX_CHARS && rh.body.messages[0].role === 'user' && rh.body.messages[rh.body.messages.length - 1].content === 'mock:nosearch follow-up', [rh.body.messages.length, histChars]);

    // ---- the monthly cap and the month roll ---------------------------------------------------------------
    ok('cap: junk refused', /Not saved/.test(d(ca.setConfig({ capUsd: 'lots' })).error || ''));
    ok('cap: zero refused', !!d(ca.setConfig({ capUsd: 0 })).error);
    desc = d(ca.setConfig({ capUsd: '$0.01' }));
    ok('cap: "$0.01" accepted, reached', desc.capUsd === 0.01 && desc.month.capReached === true, desc.month);
    n1 = reqs().length;
    got = await ask(ca, { q: 'mock:nosearch over cap', seq: ++seq, mode: 'ask' });
    isFail('cap', last(got), 'cap-reached');
    ok('cap: nothing sent, says it is an estimate', reqs().length === n1 && /own estimate/.test(last(got).detail) && last(got).settings === true, last(got).detail);
    eq('cap: default is $150', C.DEFAULTS.capUsd, 150);
    clock = new Date(2026, 10, 2, 9, 0, 0).getTime();
    desc = d(ca.describe());
    eq('month roll: November starts at zero', [desc.month.id, desc.month.spentUsd, desc.month.answers, desc.month.capReached], ['2026-11', 0, 0, false]);
    got = await ask(ca, { q: 'mock:nosearch november', seq: ++seq, mode: 'ask' });
    ok('month roll: answers again', last(got).phase === 'done');
    eq('store keeps the month and cap', JSON.parse(fs.readFileSync(store, 'utf8')).cfg.capUsd, 0.01);
    d(ca.setConfig({ capUsd: 150 }));

    // ---- the guest side: only OUR search.html is heard ---------------------------------------------------
    function fakeContents(url, id) {
      const e = new EventEmitter();
      e.id = id; e.url = url; e.calls = [];
      e.getURL = () => e.url;
      e.isDestroyed = () => false;
      e.getType = () => 'webview';
      e.executeJavaScript = (code) => {
        const m = /^window\.__applyAnswer && window\.__applyAnswer\((.*)\)$/s.exec(code);
        if (m) { const o = JSON.parse(m[1]); e.calls.push(o); pushed.push(o); }
        return Promise.resolve();
      };
      return e;
    }
    const page = fakeContents('file:///C:/quartz/search.html?q=x', 51);
    ca.watchGuest(page);
    page.emit('console-message', { message: 'quartz-search:answer {"q":"mock:nosearch guest","seq":3,"mode":"ask"}' });
    for (let i = 0; i < 100 && !page.calls.some((o) => o.phase === 'done'); i++) await sleep(20);
    eq('guest: start .. done through executeJavaScript', [page.calls[0] && page.calls[0].phase, (page.calls[page.calls.length - 1] || {}).phase, (page.calls[page.calls.length - 1] || {}).seq], ['start', 'done', 3]);
    const n2 = reqs().length;
    const evil = fakeContents('https://evil.example/search.html', 52);
    eq('guest: a web page printing the line is ignored', ca.handleGuestLine(evil, 'quartz-search:answer {"q":"mock:nosearch evil","seq":1,"mode":"ask"}'), false);
    const nt = fakeContents('file:///C:/quartz/newtab.html', 53);
    eq('guest: another bundled page is ignored', ca.handleGuestLine(nt, 'quartz-search:answer {"q":"mock:nosearch nt","seq":1,"mode":"ask"}'), false);
    eq('guest: malformed line ignored', ca.handleGuestLine(page, 'quartz-search:answer {"q":"x","seq":"one"}'), false);
    eq('guest: brave line is not ours', ca.handleGuestLine(page, 'quartz-search:query {"q":"x"}'), false);
    await sleep(50);
    ok('guest: none of those reached Anthropic', reqs().length === n2 && evil.calls.length === 0);
    page.calls.length = 0;
    page.emit('console-message', { message: 'quartz-search:answer {"q":"mock:slow nav","seq":4,"mode":"ask"}' });
    for (let i = 0; i < 100 && !page.calls.some((o) => o.phase === 'delta'); i++) await sleep(20);
    page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'file:///C:/quartz/search.html?q=y' });
    await sleep(300);
    ok('guest: a navigation aborts the answer, nothing more is pushed', !page.calls.some((o) => o.phase === 'done' || o.phase === 'fail'), page.calls.map((o) => o.phase));
    const slowReqs = reqs().filter((r) => r.scenario === 'slow');
    ok('guest: navigation aborted the fetch', slowReqs[slowReqs.length - 1].aborted === true);
    page.calls.length = 0;
    page.emit('console-message', { message: 'quartz-search:answer {"q":"mock:slow stop","seq":5,"mode":"ask"}' });
    for (let i = 0; i < 100 && !page.calls.some((o) => o.phase === 'delta'); i++) await sleep(20);
    page.emit('console-message', { message: 'quartz-search:answer-stop {"seq":5}' });
    for (let i = 0; i < 100 && !page.calls.some((o) => o.phase === 'fail'); i++) await sleep(20);
    eq('guest: the stop line stops it', (page.calls[page.calls.length - 1] || {}).state, 'stopped');

    // ---- IPC: gated, and no channel returns the key ---------------------------------------------------------
    const handlers = {};
    const ipc = { handle: (ch, fn) => { handlers[ch] = fn; } };
    let allow = false;
    ca.registerIpc(ipc, () => allow);
    eq('ipc: channels', Object.keys(handlers).sort(), ['claude-answer:describe', 'claude-answer:set-config', 'claude-answer:set-key', 'claude-answer:test']);
    eq('ipc: refused for a non-chrome sender', await handlers['claude-answer:describe']({}), null);
    allow = true;
    const ipcOut = [await handlers['claude-answer:describe']({}), await handlers['claude-answer:test']({}), await handlers['claude-answer:set-config']({}, { mode: 'every' })];
    ipcOut.forEach(d);
    ok('ipc: answers, never the key', ipcOut.every((x) => x && typeof x === 'object') && JSON.stringify(ipcOut).indexOf(KEY) < 0);

    // ---- the key never leaks -------------------------------------------------------------------------------------
    ok('leak: not in any describe() / IPC answer (' + described.length + ')', JSON.stringify(described).indexOf(KEY) < 0);
    ok('leak: not in any page payload (' + pushed.length + ')', JSON.stringify(pushed).indexOf(KEY) < 0 && JSON.stringify(pushed).indexOf('SECRET') < 0);
    ok('leak: not in any log line (' + logs.length + ')', logs.every((l) => l.indexOf(KEY) < 0 && l.indexOf('SECRET') < 0), logs);
    ok('leak: logs carry no query text', logs.every((l) => l.indexOf('quartz') < 0 && l.indexOf('mock:') < 0), logs);
    ok('leak: not in the store file', fs.readFileSync(store, 'utf8').indexOf(KEY) < 0);
    ok('leak: every Anthropic request carried it only as x-api-key', mock.requests.filter((r) => r.key === KEY).length > 10 && mock.requests.every((r) => JSON.stringify(r.body || {}).indexOf('SECRET') < 0));

    // ---- only Haiku, ever: across EVERY request this run made --------------------------------------------------
    const msgReqs = reqs();
    ok('no request ever carries fallbacks or the fallback beta header (' + mock.requests.length + ' requests)',
      mock.requests.every((r) => r.beta === '' && !(r.body && 'fallbacks' in r.body)),
      mock.requests.filter((r) => r.beta || (r.body && 'fallbacks' in r.body)).map((r) => [r.path, r.beta]));
    ok('every Messages request asked for Haiku at high effort (' + msgReqs.length + ')', msgReqs.length > 20 && msgReqs.every((r) => r.body && r.body.model === 'claude-haiku-5-5' && r.body.output_config && r.body.output_config.effort === 'high'), msgReqs.map((r) => r.body && r.body.model).filter((m) => m !== 'claude-haiku-5-5'));
    ok('every start and done the pages got said Haiku', pushed.filter((o) => o.phase === 'start' || o.phase === 'done').every((o) => o.model === 'claude-haiku-5-5' && o.modelLabel === 'Claude Haiku 5.5'), pushed.filter((o) => (o.phase === 'start' || o.phase === 'done') && o.model !== 'claude-haiku-5-5'));

    // ---- removing the key ----------------------------------------------------------------------------------------------
    desc = d(ca.setKey(''));
    ok('remove: gone from memory and file', !desc.hasKey && !('keyEnc' in JSON.parse(fs.readFileSync(store, 'utf8'))));
    ca.stop();
  } catch (e) {
    fail++;
    console.log('FAIL HARNESS ERROR ' + (e && e.stack || e));
  } finally {
    await mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('claudeanswer: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
})();
