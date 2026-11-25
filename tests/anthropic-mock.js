// tests/anthropic-mock.js — a MOCK Anthropic API for claudeanswer-harness.js and claudeanswer-e2e.js.
// Never the real API. A local http server answering:
//   GET  /v1/models     a model list for a good key, 401 for anything else (Check key)
//   POST /v1/messages   a streamed (SSE) answer in the shapes the docs show (streaming + web
//                       search pages, read 2026-10-17)
// The KEY decides auth: 'sk-ant-api03-good…' passes, anything else gets 401 authentication_error.
// The QUERY (the last user message) picks the scenario: "mock:<name> …" or, by default, 'ok'.
// Every request is recorded: method, path, the auth headers, the parsed body, and whether the
// client hung up before the answer ended (`aborted`).
'use strict';
const OK_GAP_MS = 150;
const http = require('http');

const GOOD_KEY_PREFIX = 'sk-ant-api03-good';

const URL_A = 'https://en.wikipedia.org/wiki/Quartz';
const URL_B = 'https://www.britannica.com/science/quartz';

function scenarioOf(body) {
  const msgs = body && Array.isArray(body.messages) ? body.messages : [];
  let last = null;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === 'user') { last = msgs[i]; break; }
  const text = last && typeof last.content === 'string' ? last.content : '';
  const m = /^mock:([a-z0-9-]+)/i.exec(text);
  return m ? m[1].toLowerCase() : 'ok';
}

function start(opts) {
  const o = opts || {};
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const rec = { method: req.method, path: String(req.url || ''), key: String(req.headers['x-api-key'] || ''), version: String(req.headers['anthropic-version'] || ''), beta: String(req.headers['anthropic-beta'] || ''), body: null, aborted: false, finished: false, scenario: '' };
    requests.push(rec);
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { rec.body = raw ? JSON.parse(raw) : null; } catch { rec.body = { unparsable: raw.slice(0, 200) }; }
      res.on('close', () => { if (!rec.finished) rec.aborted = true; });
      route(rec, req, res);
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  function json(res, rec, status, obj, extra) {
    res.writeHead(status, Object.assign({ 'content-type': 'application/json', 'request-id': 'req_mock_' + requests.length }, extra || {}));
    res.end(JSON.stringify(obj));
    rec.finished = true;
  }
  function apiError(res, rec, status, type, message, extra) {
    json(res, rec, status, { type: 'error', error: { type, message } }, extra);
  }

  function route(rec, req, res) {
    const p = rec.path.split('?')[0];
    if (rec.key.indexOf(GOOD_KEY_PREFIX) !== 0) return apiError(res, rec, 401, 'authentication_error', 'invalid x-api-key');
    if (req.method === 'GET' && p === '/v1/models') {
      const ids = (o.models || ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']);
      return json(res, rec, 200, { data: ids.map((id) => ({ type: 'model', id, display_name: id })), has_more: false, first_id: ids[0], last_id: ids[ids.length - 1] });
    }
    if (req.method !== 'POST' || p !== '/v1/messages') return apiError(res, rec, 404, 'not_found_error', 'Not found');
    const sc = scenarioOf(rec.body);
    rec.scenario = sc;
    const model = rec.body && rec.body.model;
    switch (sc) {
      case '401': return apiError(res, rec, 401, 'authentication_error', 'invalid x-api-key');
      case '403': return apiError(res, rec, 403, 'permission_error', 'Your API key does not have permission to use the specified resource.');
      case '429': return apiError(res, rec, 429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit', { 'retry-after': '7' });
      case '529': return apiError(res, rec, 529, 'overloaded_error', 'Overloaded');
      case '500': return apiError(res, rec, 500, 'api_error', 'Internal server error');
      case '404': return apiError(res, rec, 404, 'not_found_error', 'model: ' + model);
      case '402': return apiError(res, rec, 402, 'billing_error', 'Your account has a billing problem. Please check Plans & Billing.');
      case 'credit': return apiError(res, rec, 400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.');
      case 'spendlimit': return apiError(res, rec, 400, 'invalid_request_error', 'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.');
      case 'websearch-off': return apiError(res, rec, 400, 'invalid_request_error', 'Web search is not enabled for this organization.');
      case 'garbage':
        res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>captive portal</html>'); rec.finished = true; return;
      case 'noheaders': return;   // never answers: the client's headers timeout
      default: return stream(rec, res, sc, model);
    }
  }

  /* the 'ok' answer's pause before its last text block (ms): longer than claudeanswer.js DELTA_FLUSH_MS */
  function stream(rec, res, sc, model) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'request-id': 'req_mock_' + requests.length });
    const q = [];   // [delayMs, text]
    const ev = (type, data, delay) => q.push([delay || 0, 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n']);
    const startMsg = (inTok, m) => ev('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: m || model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inTok, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } });
    const text = (i, pieces, citations, delay) => {
      ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      for (const c of citations || []) ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'citations_delta', citation: c } });
      for (const p of pieces) ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: p } }, delay);
      ev('content_block_stop', { type: 'content_block_stop', index: i });
    };
    const search = (i, query, results) => {
      ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'server_tool_use', id: 'srvtoolu_mock' + i, name: 'web_search', input: {} } });
      const js = JSON.stringify({ query });
      ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: js.slice(0, 5) } });
      ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: js.slice(5) } });
      ev('content_block_stop', { type: 'content_block_stop', index: i });
      q.push([20, ': a comment line, as SSE allows\n\n']);
      ev('ping', { type: 'ping' });
      ev('content_block_start', { type: 'content_block_start', index: i + 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_mock' + i, content: results } });
      ev('content_block_stop', { type: 'content_block_stop', index: i + 1 });
    };
    const results = [
      { type: 'web_search_result', url: URL_A, title: 'Quartz - Wikipedia', encrypted_content: 'ENC_A_' + 'x'.repeat(40), page_age: 'October 1, 2026' },
      { type: 'web_search_result', url: URL_B, title: 'Quartz | Britannica', encrypted_content: 'ENC_B_' + 'y'.repeat(40), page_age: 'May 2, 2026' },
    ];
    const citeA = { type: 'web_search_result_location', url: URL_A, title: 'Quartz - Wikipedia', encrypted_index: 'EIDX_A', cited_text: 'Quartz is a hard, crystalline mineral composed of silica' };
    const citeB = { type: 'web_search_result_location', url: URL_B, title: 'Quartz | Britannica', encrypted_index: 'EIDX_B', cited_text: 'quartz crystals vibrate at a precise frequency' };
    const end = (stop, usage, details) => {
      ev('message_delta', { type: 'message_delta', delta: Object.assign({ stop_reason: stop, stop_sequence: null }, details ? { stop_details: details } : {}), usage });
      ev('message_stop', { type: 'message_stop' });
    };
    const lastIsAssistant = rec.body && Array.isArray(rec.body.messages) && rec.body.messages.length && rec.body.messages[rec.body.messages.length - 1].role === 'assistant';
    let destroyAfter = false;
    let hang = false;

    switch (sc) {
      case 'nosearch':
        startMsg(900);
        text(0, ['Paris is ', 'the capital ', 'of France.']);
        end('end_turn', { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 12 });
        break;
      case 'long':
        startMsg(900);
        text(0, ['A long answer that is well over the hold limit. '.repeat(4), 'It keeps going ', 'and going.'], null, 90);
        end('end_turn', { input_tokens: 900, output_tokens: 60 });
        break;
      case 'stream-overloaded':
        startMsg(800);
        text(0, ['Half an answer that is long enough to stream straight to the page before the error lands, ', 'so the page has some text.']);
        ev('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
        break;
      case 'empty':
        startMsg(700);
        end('end_turn', { input_tokens: 700, output_tokens: 3 });
        break;
      case 'refusal':
        startMsg(700);
        text(0, ['Here is how to']);
        end('refusal', { input_tokens: 700, output_tokens: 5 }, { type: 'refusal', category: 'cyber', explanation: 'This request was flagged by a safety classifier.' });
        break;
      case 'maxtokens':
        startMsg(700);
        text(0, ['An answer that runs out of room before it ends because the ceiling was hit mid-sentence and so the ']);
        end('max_tokens', { input_tokens: 700, output_tokens: 1024 });
        break;
      case 'slow':
        startMsg(800);
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A slow answer that is long enough to be streamed out right away, well past the hold limit for lead-ins, so the page sees it before the end. '.repeat(2) } });
        for (let i = 0; i < 40; i++) ev('ping', { type: 'ping' }, 500);
        ev('content_block_stop', { type: 'content_block_stop', index: 0 });
        end('end_turn', { input_tokens: 800, output_tokens: 40 });
        break;
      case 'silent':
        startMsg(800);
        hang = true;   // headers and message_start, then nothing at all: the idle timeout
        break;
      case 'drop':
        startMsg(800);
        text(0, ['Text that is long enough to stream before the connection drops in the middle of the answer, so some is shown. ']);
        destroyAfter = true;
        break;
      case 'search-error':
        startMsg(800);
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_err', name: 'web_search', input: {} } });
        ev('content_block_stop', { type: 'content_block_stop', index: 0 });
        ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_err', content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests' } } });
        ev('content_block_stop', { type: 'content_block_stop', index: 1 });
        text(2, ['From what I know, quartz is silicon dioxide.']);
        end('end_turn', { input_tokens: 800, output_tokens: 15, server_tool_use: { web_search_requests: 0 } });
        break;
      case 'pause':
        if (!lastIsAssistant) {
          startMsg(1000);
          search(0, 'quartz', results);
          end('pause_turn', { input_tokens: 4000, output_tokens: 30, server_tool_use: { web_search_requests: 1 } });
        } else {
          startMsg(4100);
          text(0, ['Quartz is silica'], [citeA]);
          text(1, ['.']);
          end('end_turn', { input_tokens: 4100, output_tokens: 20 });
        }
        break;
      case 'fallback':
        // A fallback block Quartz never asked for: the client must refuse the rest.
        startMsg(900);
        text(0, ['Partial text from Haiku that is long enough to stream out before an unasked-for fallback switches models mid-answer. ']);
        ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model }, to: { model: 'claude-opus-4-8' } } });
        ev('content_block_stop', { type: 'content_block_stop', index: 1 });
        text(2, ['Answer from the fallback model.']);
        end('end_turn', { input_tokens: 900, output_tokens: 40 });
        break;
      case 'wrong-model':
        // message_start reports a model other than the one asked for.
        startMsg(900, 'claude-sonnet-5-5');
        text(0, ['An answer written by some other model, long enough that it would be shown at once if it were not refused. ']);
        end('end_turn', { input_tokens: 900, output_tokens: 30 });
        break;
      case 'no-model':
        ev('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 1 } } });
        text(0, ['An answer from a stream that never said which model wrote it.']);
        end('end_turn', { input_tokens: 900, output_tokens: 20 });
        break;
      case 'big':
        startMsg(150000);
        text(0, ['A long-context answer.']);
        end('end_turn', { input_tokens: 150000, output_tokens: 1000 });
        break;
      case 'markdown':
        startMsg(900);
        text(0, ['**Quartz** is silica.\n\n- Hard: 7 on Mohs\n- Used in `watches`\n\n<script>alert(1)</script>']);
        end('end_turn', { input_tokens: 900, output_tokens: 30 });
        break;
      case 'ok':
      default:
        startMsg(1200);
        text(0, ['I\'ll search for ', 'that.']);   // the lead-in Quartz must drop
        search(1, 'quartz mineral', results);
        text(3, ['Quartz is a hard mineral ', 'made of silica'], [citeA]);
        text(4, [', and it keeps time in watches'], [citeB, citeA]);
        // A real pause before the last block, well past claudeanswer.js's 40 ms delta window, so the
        // answer reaches the page in more than one delta on any machine. Without it the stream's only
        // pacing was the 2 ms chunk splits, which last ~15 ms each at Windows' default timer
        // resolution but ~2 ms when something on the machine has raised it, and then the whole
        // answer fit in one window.
        text(5, [' because it vibrates at a steady frequency.'], null, OK_GAP_MS);
        end('end_turn', { input_tokens: 5200, cache_creation_input_tokens: 600, cache_read_input_tokens: 0, output_tokens: 120, server_tool_use: { web_search_requests: 1 } });
        break;
    }

    // Write the events, splitting some across chunk boundaries so the client's SSE parser is tested.
    let i = 0;
    const next = () => {
      if (res.destroyed) return;
      if (i >= q.length) {
        if (destroyAfter) { res.socket && res.socket.destroy(); return; }
        if (hang) return;
        rec.finished = true; res.end(); return;
      }
      const [delay, chunk] = q[i++];
      const go = () => {
        if (res.destroyed) return;
        if (chunk.length > 30 && i % 3 === 0) {
          const cut = Math.floor(chunk.length / 2);
          res.write(chunk.slice(0, cut));
          setTimeout(() => { if (!res.destroyed) { res.write(chunk.slice(cut)); next(); } }, 2);
        } else { res.write(chunk); next(); }
      };
      if (delay) setTimeout(go, delay); else setImmediate(go);
    };
    next();
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      base: 'http://127.0.0.1:' + server.address().port,
      requests,
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    }));
  });
}

module.exports = { start, GOOD_KEY_PREFIX, URL_A, URL_B, OK_GAP_MS };
