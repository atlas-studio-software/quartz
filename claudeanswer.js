// claudeanswer.js — the AI answer at the top of Quartz's own search results page, written by
// Claude through the user's own Anthropic API key (main process). The Google-AI-Overviews half of
// Quartz results; bravesearch.js stays the results list underneath it.
//
// search.html is a bundled, preload-less file:// guest. It never sees the key. It asks over ONE
// console line and is answered by executeJavaScript, the same pattern bravesearch.js uses:
//
//   in    quartz-search:answer {"q":"...","seq":N,"mode":"auto"|"deep"|"ask",
//                               "history":[{"role":"user"|"assistant","text":"..."}]}
//         quartz-search:answer-stop {"seq":N}
//   out   window.__applyAnswer(obj), one call per step:
//         { seq, phase:'start', model, modelLabel, mode }
//         { seq, phase:'delta', text }            appended text (markdown subset, [n] markers)
//         { seq, phase:'done', text, citations:[{n,url,title,host}],
//           usage:{input,output,searches,cacheRead,cacheWrite}, costUsd, model, modelLabel, mode,
//           cached, truncated, searchErrors }     `text` is the whole final answer: it REPLACES
//                                                 what the deltas built
//         { seq, phase:'fail', state, title, detail, retry, settings }
//         { seq, phase:'off', reason:'no-key'|'manual'|'not-question' }   nothing was spent
//
//   `mode`: "auto" is the page's own ask on load (honours the Settings mode), "ask" is the user
//   clicking "Ask Claude", "deep" is "Deeper answer" (more searches, a longer answer; the same
//   model). Only ONE answer streams
//   per page: a new seq aborts the old fetch and the old seq gets nothing more; a navigation or
//   a closed tab aborts it too. `fail.state` is one of 'no-key' | 'bad-key' | 'rate-limited' |
//   'overloaded' | 'no-credit' | 'cap-reached' | 'offline' | 'server' | 'bad-answer' |
//   'stopped', each with a plain-English title and a detail that quotes what Anthropic (or the
//   network) actually answered. Nothing here falls back on its own.
//
//   ONE MODEL (requested 10-17: "only haiku"). Every answer, quick and deep, is Claude Haiku 5.5
//   (ANSWER_MODEL) at high effort. No server-side fallback is ever requested, so there is exactly
//   one 'start' per seq and its model is always Haiku. If a stream reports another model in
//   message_start, or carries a fallback block anyway, the answer fails 'bad-answer' and none of
//   that model's text is shown.
//
// Only a guest whose URL is OUR search.html is heard, checked per message as bravesearch.js does,
// so no web page can spend the user's credit by printing the same line.
//
// THE KEY. Pasted in Settings > Search, kept in <userData>/claude-answer.json ENCRYPTED with
// Electron safeStorage (DPAPI on Windows, bound to the user's Windows account). If safeStorage cannot
// encrypt, the key is refused, never written in the clear. describe() answers `hasKey` and a mask;
// there is no channel that returns it, it is never logged, and it leaves this process only as the
// x-api-key header to api.anthropic.com.
//
// THE API (docs read 2026-10-17, platform.claude.com/docs):
//   POST /v1/messages, stream:true (SSE: message_start, content_block_start/delta/stop with
//   text_delta, citations_delta, input_json_delta, thinking_delta, signature_delta; message_delta
//   carries CUMULATIVE usage; message_stop; ping; error).
//   Grounding is Anthropic's own server-side web search tool, web_search_20250305 (basic, called
//   directly: no code-execution sandbox to spin up, which keeps the quick answer quick), with a
//   small max_uses. Its citations (web_search_result_location: url, title, cited_text) become the
//   [n] markers and the citations list. Brave's results are NOT sent to Claude: Brave's API terms
//   do not grant AI/LLM use of Search Results (see docs/engineering-notes.md).
//   GET /v1/models is "Check key": it costs nothing.
//
// COST. Every answer is priced from the usage Anthropic returns times the published prices
// (PRICES below, checked on PRICES_CHECKED) plus $10 per 1,000 web searches, and added to this
// month's total in claude-answer.json. At the monthly cap (default $150) answers stop with
// 'cap-reached'. This is QUARTZ'S OWN ESTIMATE: Quartz cannot see the real credit balance.
//
// TESTS: create({ apiBase }) points it at a mock server. main.js passes QUARTZ_CLAUDE_API only to
// a --test-profile instance, so a live Quartz always talks to api.anthropic.com itself.
'use strict';

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const LINE_ANSWER = 'quartz-search:answer ';
const LINE_STOP = 'quartz-search:answer-stop ';
const PAGE_FILE = 'search.html';
const STORE_FILE = 'claude-answer.json';
const KEYS_URL = 'https://platform.claude.com/settings/keys';
const BILLING_URL = 'https://platform.claude.com/settings/billing';
const CAPABILITIES_URL = 'https://platform.claude.com/settings/capabilities';
const PRICES_CHECKED = '2026-10-17';

/** The ONLY model that ever answers (requested 10-17: "only haiku"). Quick and "Deeper answer" both. */
const ANSWER_MODEL = 'claude-haiku-5-5';
const ANSWER_MODEL_LABEL = 'Claude Haiku 5.5';
/** What message_start may report: the id itself, or a dated snapshot of it. Anything else is
 *  another model and is refused. */
const ANSWER_MODEL_RE = /^claude-haiku-5-5(-\d{8})?$/;

/** USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing (5-minute cache
 *  writes). `upTo` is the prompt-length ceiling for that row (Haiku 5.5 is priced by prompt length:
 *  over 100,000 prompt tokens, the whole request pays the second row). */
const PRICES = {
  'claude-haiku-5-5': [
    { upTo: 100000, in: 0.10, out: 0.50, cacheWrite: 0.125, cacheRead: 0.01 },
    { upTo: Infinity, in: 0.50, out: 2.50, cacheWrite: 0.625, cacheRead: 0.05 },
  ],
};
/** A model the table does not know (only ever a refused, non-Haiku stream's partial cost) is priced
 *  as the dearest current one, so the estimate errs high. */
const PRICE_UNKNOWN = [{ upTo: Infinity, in: 10, out: 50, cacheWrite: 12.50, cacheRead: 1 }];
const SEARCH_USD = 10 / 1000;

/** The one model, as Settings describes it. No server-side fallback exists for Haiku 5.5, and none
 *  is ever requested. */
const MODELS = [
  { id: ANSWER_MODEL, label: ANSWER_MODEL_LABEL, note: 'high effort; about a tenth of a cent an answer plus $0.01 a search' },
];
const MODEL_IDS = MODELS.map((m) => m.id);
const MODES = [
  { id: 'every', name: 'Answer every search' },
  { id: 'questions', name: 'Only questions' },
  { id: 'manual', name: 'Only when I ask' },
];
const MODE_IDS = MODES.map((m) => m.id);
const DEFAULTS = { mode: 'every', capUsd: 150, autoModel: ANSWER_MODEL, deepModel: ANSWER_MODEL };
const CAP_MAX = 10000;

/** What one request may spend. Thinking is adaptive (the default on Haiku 5.5) and counts toward
 *  max_tokens, so the ceiling leaves it room while still keeping a runaway answer short. Both are
 *  Haiku at HIGH effort (requested 10-17); "Deeper" means more searching and a longer answer, not
 *  another model. */
const PLAN = {
  quick: { model: ANSWER_MODEL, maxTokens: 4096, maxUses: 2, effort: 'high' },
  deep: { model: ANSWER_MODEL, maxTokens: 8192, maxUses: 4, effort: 'high' },
};

const MAX_QUERY = 1000;
const HISTORY_MAX_TURNS = 8;
const HISTORY_MAX_TURN_CHARS = 1500;
const HISTORY_MAX_CHARS = 6000;
const HOLD_CHARS = 160;           // a short uncited block may be a "Let me search" lead-in: held
const HEADERS_TIMEOUT_MS = 20000; // no response headers in this long: give up
const IDLE_TIMEOUT_MS = 30000;    // no bytes at all (Anthropic pings while it searches)
const TOTAL_TIMEOUT_MS = 90000;
const MAX_CONTINUES = 2;          // pause_turn continuations for one answer
const DELTA_FLUSH_MS = 40;        // deltas are coalesced into at most ~25 page calls a second
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 30;

/** Short and frozen, so it sits in the cached prefix (tools + this block). The date and the mode
 *  go in a second block after the cache breakpoint. */
const SYSTEM_PROMPT = [
  'You write the answer box at the top of a web search results page in the Quartz browser. The user typed a search; answer it.',
  '',
  'Rules:',
  '- Put the answer in the first sentence. Then add only what helps: one short paragraph, or a few "- " bullets.',
  '- Keep it short: usually under 120 words. No headings, tables, links, images or emoji.',
  '- Use the web search tool when the answer depends on current, local or specific facts you are not sure of. Do not write anything before searching, and do not describe the search.',
  '- Sources are cited automatically from the search results you use. Do not write citation markers like [1], URLs or a source list yourself.',
  '- If the sources disagree, or you are not sure, say so plainly in one line. Never invent facts, numbers or quotes.',
  '- If the search is a site or app name, say in one line what it is. If it is too vague to answer, say what it most likely means.',
  '- Formatting: plain paragraphs, "- " bullets, **bold** for the key fact, `code` for code only.',
  '- No filler: no greetings, no "Great question", no offers of further help.',
].join('\n');

/* ---------------------------------------------------------------- pure helpers */

/** Last four characters behind bullets (bravesearch.js's rule): a short key is all bullets. */
function maskKey(key) {
  const s = String(key == null ? '' : key);
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return '••••' + s.slice(-4);
}

/** A key as pasted, or '' when it cannot be one (whitespace inside, control chars, absurd length). */
function cleanKey(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 300 || /[\s\u0000-\u001f\u007f]/.test(s)) return '';
  return s;
}

function str(value, max) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function hostOf(href) {
  try { return new URL(href).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** http(s) only, as a normalised href, or ''. A citation never links anywhere else. */
function webHref(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch { return ''; }
}

function modelLabel(id) {
  const m = MODELS.find((x) => x.id === id);
  return m ? m.label : String(id || 'Claude');
}

/** "auto" | "ask" | "deep" from the page; anything else is not honoured. */
function cleanMode(value) {
  if (value == null) return 'auto';
  return value === 'auto' || value === 'ask' || value === 'deep' ? value : '';
}

/**
 * The follow-up history the page sent -> at most HISTORY_MAX_TURNS turns, each at most
 * HISTORY_MAX_TURN_CHARS, HISTORY_MAX_CHARS in all, newest kept, starting with a user turn.
 * Anything malformed is dropped rather than half-honoured.
 */
function capHistory(history) {
  if (!Array.isArray(history)) return [];
  const clean = [];
  for (const h of history) {
    if (!h || typeof h !== 'object') continue;
    if (h.role !== 'user' && h.role !== 'assistant') continue;
    let text = typeof h.text === 'string' ? h.text.trim() : '';
    if (!text) continue;
    if (text.length > HISTORY_MAX_TURN_CHARS) text = text.slice(0, HISTORY_MAX_TURN_CHARS - 1) + '…';
    clean.push({ role: h.role, text });
  }
  const kept = [];
  let total = 0;
  for (let i = clean.length - 1; i >= 0 && kept.length < HISTORY_MAX_TURNS; i--) {
    if (total + clean[i].text.length > HISTORY_MAX_CHARS) break;
    total += clean[i].text.length;
    kept.unshift(clean[i]);
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

/** One answer line -> { q, seq, mode, history }, or null for anything that is not well formed. */
function parseAnswerLine(line) {
  if (typeof line !== 'string' || line.indexOf(LINE_ANSWER) !== 0) return null;
  let msg;
  try { msg = JSON.parse(line.slice(LINE_ANSWER.length)); } catch { return null; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const q = typeof msg.q === 'string' ? msg.q.replace(/\s+/g, ' ').trim() : '';
  if (!q || q.length > MAX_QUERY) return null;
  const mode = cleanMode(msg.mode);
  if (!mode) return null;
  const seq = Number(msg.seq);
  if (!Number.isFinite(seq)) return null;
  return { q, seq, mode, history: capHistory(msg.history) };
}

/** One stop line -> { seq }, or null. */
function parseStopLine(line) {
  if (typeof line !== 'string' || line.indexOf(LINE_STOP) !== 0) return null;
  let msg;
  try { msg = JSON.parse(line.slice(LINE_STOP.length)); } catch { return null; }
  if (!msg || typeof msg !== 'object') return null;
  const seq = Number(msg.seq);
  return Number.isFinite(seq) ? { seq } : null;
}

const QUESTION_START = /^(who|whom|whose|what|whats|what's|when|where|why|how|which|is|are|am|was|were|do|does|did|can|could|should|would|will|shall|may|might|must|has|have|had|define|explain|compare|tell me|meaning of|difference between)\b/i;
const QUESTION_ANY = /\?\s*$|\b(how to|how do|how does|how much|how many|what is|what are|vs\.?|versus|meaning of|definition of|difference between|explained?)\b/i;

/** "Only questions" mode: the search reads as a question, not a site name or a bare topic. */
function looksLikeQuestion(q) {
  const s = String(q == null ? '' : q).trim();
  if (!s) return false;
  return QUESTION_START.test(s) || QUESTION_ANY.test(s);
}

/** The price row for one request of `model` whose prompt was `promptTokens` long. */
function priceRow(model, promptTokens) {
  const rows = PRICES[model] || PRICE_UNKNOWN;
  for (const r of rows) if (promptTokens <= r.upTo) return r;
  return rows[rows.length - 1];
}

function num(v) { return Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0; }

/** The usage block of one request, as plain numbers. */
function usageOf(u) {
  const x = u && typeof u === 'object' ? u : {};
  const stu = x.server_tool_use && typeof x.server_tool_use === 'object' ? x.server_tool_use : {};
  return {
    input: num(x.input_tokens),
    output: num(x.output_tokens),
    cacheRead: num(x.cache_read_input_tokens),
    cacheWrite: num(x.cache_creation_input_tokens),
    searches: num(stu.web_search_requests),
  };
}

/** USD for one request's usage on `model`: tokens at the published rates plus web searches. */
function estimateCost(model, usage) {
  const u = usage || {};
  const prompt = num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
  const r = priceRow(model, prompt);
  const tokens = (num(u.input) * r.in + num(u.cacheWrite) * r.cacheWrite + num(u.cacheRead) * r.cacheRead + num(u.output) * r.out) / 1e6;
  return tokens + num(u.searches) * SEARCH_USD;
}

function roundUsd(v) { return Math.round(num(v) * 1e6) / 1e6; }

/** 'YYYY-MM' in local time: the month the user's credit renews in is their own calendar month. */
function monthId(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function monthLabel(id) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(id || ''));
  if (!m) return '';
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return names[Number(m[2]) - 1] + ' ' + m[1];
}

function anthropicSaid(status, json, headers) {
  const err = json && json.error && typeof json.error === 'object' ? json.error : null;
  const type = err && typeof err.type === 'string' ? err.type : '';
  const message = err && typeof err.message === 'string' ? str(err.message, 300) : '';
  let rid = '';
  try { rid = headers && typeof headers.get === 'function' ? String(headers.get('request-id') || '') : ''; } catch { rid = ''; }
  return 'Anthropic answered ' + status + (type ? ' ' + type : '') + (message ? ': "' + message + '"' : '') +
    (rid ? ' (request ' + str(rid, 60) + ')' : '') + '.';
}

/** A non-200 answer -> { state, title, detail, retry, settings }. Always says what Anthropic said. */
function classifyStatus(status, json, headers) {
  const err = json && json.error && typeof json.error === 'object' ? json.error : {};
  const type = typeof err.type === 'string' ? err.type : '';
  const message = typeof err.message === 'string' ? err.message : '';
  const said = anthropicSaid(status, json, headers);
  if (status === 401 || type === 'authentication_error') {
    return { state: 'bad-key', title: 'Claude refused the key', detail: said + ' Check the key in Settings > Search, or make a new one at platform.claude.com/settings/keys.', retry: false, settings: true };
  }
  if (status === 403 || type === 'permission_error') {
    return { state: 'bad-key', title: 'This key is not allowed to do that', detail: said + ' The key\'s workspace may not have access to this model or to web search.', retry: false, settings: true };
  }
  if (status === 402 || type === 'billing_error' || /credit balance|billing|purchase credits|insufficient (funds|credit)/i.test(message)) {
    return { state: 'no-credit', title: 'The Anthropic account is out of credit', detail: said + ' Add credit or check billing at platform.claude.com/settings/billing.', retry: false, settings: false };
  }
  if (/usage limit|spend(ing)? limit|monthly limit/i.test(message)) {
    return { state: 'no-credit', title: 'The Anthropic account hit its spend limit', detail: said + ' The limit is set in the Claude Console (platform.claude.com/settings/limits).', retry: false, settings: false };
  }
  if (status === 429 || type === 'rate_limit_error') {
    let after = '';
    try { after = headers && typeof headers.get === 'function' ? String(headers.get('retry-after') || '') : ''; } catch { after = ''; }
    const secs = Number(after);
    return { state: 'rate-limited', title: 'Too many answers at once', detail: said + (Number.isFinite(secs) && secs > 0 ? ' Anthropic asks to wait ' + Math.ceil(secs) + ' s.' : ' Wait a moment and try again.'), retry: true, settings: false };
  }
  if (status === 529 || type === 'overloaded_error') {
    return { state: 'overloaded', title: 'Claude is busy right now', detail: said + ' This is on Anthropic\'s side; try again in a moment.', retry: true, settings: false };
  }
  if (status === 404 || type === 'not_found_error') {
    return { state: 'server', title: 'Anthropic does not know that model', detail: said + ' Pick another model in Settings > Search.', retry: false, settings: true };
  }
  if (/web.?search/i.test(message) && /not (enabled|allowed|available)|disabled/i.test(message)) {
    return { state: 'server', title: 'Web search is turned off for this Anthropic account', detail: said + ' An admin can turn it on at platform.claude.com/settings/capabilities.', retry: false, settings: false };
  }
  if (status === 400 || status === 413 || type === 'invalid_request_error' || type === 'request_too_large') {
    return { state: 'server', title: 'Anthropic refused the request', detail: said, retry: false, settings: false };
  }
  return { state: 'server', title: 'Anthropic had a problem', detail: said + ' Try again in a moment.', retry: true, settings: false };
}

/** An `error` event inside a 200 stream -> the same verdict shape. */
function classifyStreamError(error) {
  const e = error && typeof error === 'object' ? error : {};
  const type = typeof e.type === 'string' ? e.type : 'api_error';
  const status = type === 'overloaded_error' ? 529 : type === 'rate_limit_error' ? 429 : type === 'authentication_error' ? 401
    : type === 'permission_error' ? 403 : type === 'billing_error' ? 402 : type === 'not_found_error' ? 404
      : type === 'invalid_request_error' ? 400 : 500;
  const v = classifyStatus(status, { error: e }, null);
  v.detail = v.detail.replace(/^Anthropic answered \d+/, 'Anthropic stopped mid-answer with');
  return v;
}

/** A dropped kept-alive connection (worth one fresh try before any byte came back). */
function isDroppedConnection(err) {
  const cause = err && err.cause;
  const code = String((cause && cause.code) || (err && err.code) || '');
  return /ECONNRESET|EPIPE|UND_ERR_SOCKET|SOCKET/i.test(code + ' ' + String((cause && cause.message) || ''));
}

function classifyNetworkError(err, why, limits) {
  if (why === 'stopped') {
    return { state: 'stopped', title: 'Stopped', detail: 'You stopped this answer. What Claude had written so far stays above; the tokens it used still count toward the month.', retry: true, settings: false };
  }
  if (why === 'headers' || why === 'idle' || why === 'total') {
    const L = limits || { headers: HEADERS_TIMEOUT_MS, idle: IDLE_TIMEOUT_MS, total: TOTAL_TIMEOUT_MS };
    const secs = Math.round(L[why] / 100) / 10;
    const what = why === 'headers' ? 'did not start answering within ' + secs + ' seconds'
      : why === 'idle' ? 'went quiet for ' + secs + ' seconds mid-answer' : 'was still answering after ' + secs + ' seconds';
    return { state: 'offline', title: 'Claude took too long', detail: 'Anthropic ' + what + ', so Quartz gave up. Try again.', retry: true, settings: false };
  }
  const cause = err && err.cause;
  const code = String((cause && (cause.code || (cause.errors && cause.errors[0] && cause.errors[0].code))) || (err && err.code) || '');
  const text = String((err && err.message) || '') + ' ' + String((cause && cause.message) || '');
  let reason;
  if (/ENOTFOUND|EAI_AGAIN|NAME_NOT_RESOLVED/i.test(code + text)) reason = 'the name api.anthropic.com could not be looked up, so this computer looks offline (' + (code || 'DNS') + ')';
  else if (/ECONNREFUSED|CONNECTION_REFUSED/i.test(code + text)) reason = 'the connection was refused (' + (code || 'refused') + ')';
  else if (/INTERNET_DISCONNECTED|ENETUNREACH|EHOSTUNREACH|NETWORK_CHANGED/i.test(code + text)) reason = 'there is no network connection (' + (code || 'offline') + ')';
  else if (/ECONNRESET|EPIPE|SOCKET|terminated|other side closed/i.test(code + text)) reason = 'the connection dropped (' + (code || 'reset') + ')';
  else if (/CERT|SSL|TLS/i.test(code + text)) reason = 'the secure connection failed (' + (code || 'TLS') + ')';
  else reason = 'the request failed (' + (code || str(text, 120) || 'unknown error') + ')';
  return { state: 'offline', title: 'Can\'t reach Claude', detail: 'Quartz could not reach Anthropic: ' + reason + '. Check the connection and try again.', retry: true, settings: false };
}

/* ---------------------------------------------------------------- the stream reader */

/** Server-sent events from a fetch body: calls onEvent({ event, data }) per complete event. */
function sseParser(onEvent) {
  let buf = '';
  function flushBlock(block) {
    let event = '';
    const data = [];
    for (const raw of block.split(/\r?\n/)) {
      if (!raw || raw[0] === ':') continue;
      const i = raw.indexOf(':');
      const field = i < 0 ? raw : raw.slice(0, i);
      const value = i < 0 ? '' : raw.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (!data.length) return;
    let json = null;
    try { json = JSON.parse(data.join('\n')); } catch { json = undefined; }
    onEvent({ event, data: json });
  }
  return {
    push(text) {
      buf += text;
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        flushBlock(block);
      }
    },
    end() { if (buf.trim()) flushBlock(buf); buf = ''; },
  };
}

/**
 * Reads one Messages stream into (a) the content blocks exactly as Anthropic sent them, for a
 * pause_turn continuation, and (b) the text the page is shown. Hooks:
 *   onText(piece)     text to append on the page
 * Only Haiku may answer: if message_start names another model, or a fallback block arrives (none is
 * ever requested), `foreign` says so in plain words, nothing more is shown, and the caller stops
 * reading and fails the answer 'bad-answer'.
 * Display rules: a short, uncited text block is HELD until we know what follows it; if a search
 * follows, it was a "Let me look that up" lead-in and is dropped. A cited block's [n] markers are
 * appended when the block ends. Citations number by first use of each URL.
 */
function createAccumulator(hooks, shared) {
  const h = hooks || {};
  const onText = typeof h.onText === 'function' ? h.onText : () => {};
  const st = shared || newDisplay();
  const blocks = [];
  let model = '';
  let usage = {};
  let stopReason = null;
  let stopDetails = null;
  let error = null;
  let sawStart = false;
  let sawStop = false;
  let foreign = '';     // why this stream is not Haiku's answer, or ''
  let bad = 0;
  let cur = null;       // the text block now streaming: { index, text, cited, held, ns }
  let pending = null;   // a held block that has ended: decided by whatever comes next

  function emit(t) {
    if (foreign) return;
    let piece = String(t || '');
    if (!st.text) piece = piece.replace(/^\s+/, '');
    if (!piece) return;
    st.text += piece;
    onText(piece);
  }
  function release(b) {
    if (!b || !b.held) return;
    b.held = false;
    emit(b.text);
  }
  function decidePending(nextIsSearch) {
    if (!pending) return;
    const p = pending;
    pending = null;
    if (nextIsSearch) { p.dropped = true; return; }
    release(p);
  }
  function cite(c) {
    if (!c || typeof c !== 'object') return 0;
    const url = webHref(c.url);
    if (!url) return 0;
    if (!st.cites.has(url)) {
      const n = st.list.length + 1;
      st.cites.set(url, n);
      st.list.push({ n, url, title: str(c.title, 200) || hostOf(url), host: hostOf(url) });
    }
    return st.cites.get(url);
  }
  function markers(b) {
    if (!b.ns.length) return '';
    return (/\s$/.test(st.text) ? '' : ' ') + b.ns.map((n) => '[' + n + ']').join('');
  }

  function feed(ev) {
    const d = ev && ev.data;
    if (d === undefined) { bad++; return; }
    if (!d || typeof d !== 'object') return;
    const type = d.type || ev.event;
    if (type === 'ping') return;
    if (type === 'error') { error = d.error || { type: 'api_error', message: 'unknown stream error' }; return; }
    if (foreign && type !== 'message_delta' && type !== 'message_stop') return;   // not Haiku: only usage is still read
    if (type === 'message_start') {
      sawStart = true;
      const m = d.message || {};
      model = typeof m.model === 'string' ? m.model : '';
      usage = Object.assign({}, m.usage || {});
      if (!ANSWER_MODEL_RE.test(model)) {
        foreign = model
          ? 'Anthropic answered with ' + str(model, 60) + ', not ' + ANSWER_MODEL_LABEL + '. Quartz only shows answers written by ' + ANSWER_MODEL_LABEL + ', so it stopped reading.'
          : 'Anthropic\'s answer did not say which model wrote it. Quartz only shows answers written by ' + ANSWER_MODEL_LABEL + ', so it stopped reading.';
      }
      return;
    }
    if (type === 'message_delta') {
      decidePending(false);
      if (d.delta && typeof d.delta === 'object') {
        if ('stop_reason' in d.delta) stopReason = d.delta.stop_reason;
        if (d.delta.stop_details) stopDetails = d.delta.stop_details;
      }
      if (d.usage && typeof d.usage === 'object') {
        for (const k of Object.keys(d.usage)) if (d.usage[k] != null) usage[k] = d.usage[k];   // cumulative
        const its = Array.isArray(d.usage.iterations) ? d.usage.iterations : [];
        if (!foreign && its.some((x) => x && x.type === 'fallback_message')) {
          foreign = 'Anthropic says another model took over part of this answer. Quartz only shows answers written by ' + ANSWER_MODEL_LABEL + ', so it stopped reading.';
        }
      }
      return;
    }
    if (type === 'message_stop') { decidePending(false); sawStop = true; return; }
    if (type === 'content_block_start') {
      const cb = d.content_block && typeof d.content_block === 'object' ? JSON.parse(JSON.stringify(d.content_block)) : { type: 'unknown' };
      blocks[d.index] = cb;
      if (cb.type === 'server_tool_use' || cb.type === 'tool_use') { decidePending(true); cb._json = ''; return; }
      if (cb.type === 'fallback') {
        // Quartz never asks for a fallback. If one comes anyway, the rest is another model's text.
        decidePending(true);
        const to = cb.to && typeof cb.to.model === 'string' ? str(cb.to.model, 60) : 'another model';
        foreign = 'Anthropic switched this answer from ' + ANSWER_MODEL_LABEL + ' to ' + to + ' partway through. Quartz only shows answers written by ' + ANSWER_MODEL_LABEL + ', so it stopped reading.';
        if (to !== 'another model') model = to;
        cur = null;
        return;
      }
      if (cb.type === 'web_search_tool_result') {
        decidePending(true);
        const c = cb.content;
        if (c && !Array.isArray(c) && typeof c === 'object' && c.error_code) st.searchErrors.push(String(c.error_code));
        else if (Array.isArray(c)) st.searchesSeen++;
        return;
      }
      if (cb.type === 'text') {
        decidePending(false);
        cur = { index: d.index, text: '', cited: false, held: true, ns: [] };
        if (Array.isArray(cb.citations)) for (const c of cb.citations) { const n = cite(c); if (n && cur.ns.indexOf(n) < 0) cur.ns.push(n); }
        if (cur.ns.length) cur.cited = true;
        if (typeof cb.text === 'string' && cb.text) { cur.text = cb.text; }
        if (cur.cited) release(cur);
        return;
      }
      return;   // thinking, redacted_thinking, code execution results: kept for a continuation, never shown
    }
    if (type === 'content_block_delta') {
      const blk = blocks[d.index];
      const dl = d.delta || {};
      if (!blk) return;
      if (dl.type === 'text_delta' && typeof dl.text === 'string') {
        blk.text = (blk.text || '') + dl.text;
        if (cur && cur.index === d.index) {
          if (cur.held) {
            cur.text += dl.text;
            if (cur.cited || cur.text.length > HOLD_CHARS) release(cur);
          } else {
            cur.text += dl.text;
            emit(dl.text);
          }
        }
        return;
      }
      if (dl.type === 'citations_delta' && dl.citation) {
        if (!Array.isArray(blk.citations)) blk.citations = [];
        blk.citations.push(dl.citation);
        if (cur && cur.index === d.index) {
          const n = cite(dl.citation);
          if (n && cur.ns.indexOf(n) < 0) cur.ns.push(n);
          if (n) { cur.cited = true; release(cur); }
        }
        return;
      }
      if (dl.type === 'input_json_delta' && typeof dl.partial_json === 'string') { blk._json = (blk._json || '') + dl.partial_json; return; }
      if (dl.type === 'thinking_delta' && typeof dl.thinking === 'string') { blk.thinking = (blk.thinking || '') + dl.thinking; return; }
      if (dl.type === 'signature_delta' && typeof dl.signature === 'string') { blk.signature = dl.signature; return; }
      return;
    }
    if (type === 'content_block_stop') {
      const blk = blocks[d.index];
      if (blk && '_json' in blk) {
        if (blk._json) { try { blk.input = JSON.parse(blk._json); } catch { /* keep what came */ } }
        delete blk._json;
      }
      if (cur && cur.index === d.index) {
        if (cur.held) pending = cur;
        else if (cur.ns.length) emit(markers(cur));
        cur = null;
      }
    }
  }

  /** The stream ended: anything still held is shown (nothing followed it). */
  function finish() {
    if (foreign) { cur = null; pending = null; return; }
    if (cur) { release(cur); if (cur.ns.length) emit(markers(cur)); cur = null; }
    decidePending(false);
  }

  return {
    feed, finish,
    result: () => ({
      blocks: blocks.filter(Boolean),
      model, usage: usageOf(usage), rawUsage: usage, stopReason, stopDetails, error, sawStart, sawStop, foreign, badEvents: bad,
    }),
  };
}

function newDisplay() { return { text: '', cites: new Map(), list: [], searchErrors: [], searchesSeen: 0 }; }

/* ---------------------------------------------------------------- the module */

function create(deps) {
  const d = deps || {};
  const electronApp = d.app || null;
  const fetchImpl = typeof d.fetch === 'function' ? d.fetch : (typeof fetch === 'function' ? fetch : null);
  const apiBase = String(d.apiBase || API_BASE).replace(/\/+$/, '');
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const isBundledPage = typeof d.isBundledPage === 'function' ? d.isBundledPage : () => false;
  const log = typeof d.log === 'function' ? d.log : (...a) => console.log('[claude-answer]', ...a);
  const timers = d.timers || { setTimeout, clearTimeout };
  // Test seam: shorter waits against a mock that goes quiet. A live Quartz uses the constants.
  const T = Object.assign({ headers: HEADERS_TIMEOUT_MS, idle: IDLE_TIMEOUT_MS, total: TOTAL_TIMEOUT_MS }, d.timeouts || {});
  const safe = () => {
    if (d.safeStorage) return d.safeStorage;
    try { return require('electron').safeStorage || null; } catch { return null; }
  };
  const storeFile = d.storePath || (() => {
    if (!electronApp || typeof electronApp.getPath !== 'function') return '';
    try { return path.join(electronApp.getPath('userData'), STORE_FILE); } catch { return ''; }
  });

  let loaded = false;
  let key = '';
  let keyEnc = '';
  let keyError = '';
  let cfg = Object.assign({}, DEFAULTS);
  let month = { id: monthId(now()), spentUsd: 0, answers: 0 };
  let last = null;           // { state, ok, title, detail, at }: the newest real outcome, for Settings
  const active = new Map();  // contents id -> job
  const cache = new Map();   // in memory only: Back / reload / a theme change do not pay twice

  function canEncrypt() {
    const s = safe();
    try { return !!(s && typeof s.isEncryptionAvailable === 'function' && s.isEncryptionAvailable()); } catch { return false; }
  }

  function load() {
    if (loaded) return;
    loaded = true;
    const file = storeFile();
    if (!file) return;
    let json = null;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    if (!json || typeof json !== 'object') return;
    if (json.cfg && typeof json.cfg === 'object') cfg = cleanCfg(Object.assign({}, DEFAULTS, json.cfg));
    if (json.month && typeof json.month === 'object' && /^\d{4}-\d{2}$/.test(String(json.month.id || ''))) {
      month = { id: json.month.id, spentUsd: num(json.month.spentUsd), answers: Math.floor(num(json.month.answers)) };
    }
    if (typeof json.keyEnc === 'string' && json.keyEnc) {
      keyEnc = json.keyEnc;
      const s = safe();
      try {
        if (!s || typeof s.decryptString !== 'function') throw new Error('no safeStorage');
        key = cleanKey(s.decryptString(Buffer.from(keyEnc, 'base64')));
        if (!key) throw new Error('empty');
      } catch {
        key = '';
        keyError = 'The saved Claude key could not be decrypted (Windows keeps it for the account that saved it). Paste it again.';
      }
    }
  }

  function save() {
    const file = storeFile();
    if (!file) return false;
    const body = JSON.stringify({ v: 1, keyEnc: keyEnc || undefined, cfg, month }, null, 2);
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      log('store write failed:', (err && err.code) || 'unknown');   // never the key itself
      return false;
    }
  }

  function rollMonth() {
    const id = monthId(now());
    if (month.id !== id) { month = { id, spentUsd: 0, answers: 0 }; save(); }
  }

  function cleanCfg(c) {
    const out = Object.assign({}, DEFAULTS);
    if (MODE_IDS.indexOf(c.mode) >= 0) out.mode = c.mode;
    const cap = Number(c.capUsd);
    if (Number.isFinite(cap) && cap > 0 && cap <= CAP_MAX) out.capUsd = Math.round(cap * 100) / 100;
    // Only Haiku answers: a stored config naming any other model (an older build offered Sonnet and
    // Opus) is read back as Haiku, and the next save writes Haiku.
    out.autoModel = ANSWER_MODEL;
    out.deepModel = ANSWER_MODEL;
    return out;
  }

  function describe() {
    load();
    rollMonth();
    return {
      hasKey: !!key,
      keyMask: maskKey(key),
      keyError: keyError || '',
      canEncrypt: canEncrypt(),
      mode: cfg.mode,
      modes: MODES.map((m) => Object.assign({}, m)),
      capUsd: cfg.capUsd,
      autoModel: cfg.autoModel,
      deepModel: cfg.deepModel,
      models: MODELS.map((m) => ({ id: m.id, label: m.label, note: m.note })),
      answerModel: ANSWER_MODEL,
      answerModelLabel: ANSWER_MODEL_LABEL,
      effort: PLAN.quick.effort,
      month: {
        id: month.id, label: monthLabel(month.id),
        spentUsd: roundUsd(month.spentUsd), answers: month.answers,
        capUsd: cfg.capUsd, capReached: month.spentUsd >= cfg.capUsd,
      },
      last: last ? Object.assign({}, last) : null,
      keysUrl: KEYS_URL,
      billingUrl: BILLING_URL,
      pricesChecked: PRICES_CHECKED,
    };
  }

  function setKey(raw) {
    load();
    const next = cleanKey(raw);
    const typed = String(raw == null ? '' : raw).trim();
    if (typed && !next) return Object.assign(describe(), { error: 'That does not look like a key: it has spaces or odd characters in it.' });
    if (/^sk-ant-admin/i.test(next)) return Object.assign(describe(), { error: 'That is an Admin API key. Answers need an ordinary API key (sk-ant-api…): make one at platform.claude.com/settings/keys.' });
    if (next && next === key) return describe();
    if (next) {
      if (!canEncrypt()) {
        return Object.assign(describe(), { error: 'Windows could not encrypt the key (safeStorage is unavailable), so Quartz did not store it. Nothing was written.' });
      }
      let enc = '';
      try { enc = safe().encryptString(next).toString('base64'); } catch { enc = ''; }
      if (!enc) return Object.assign(describe(), { error: 'Windows could not encrypt the key, so Quartz did not store it. Nothing was written.' });
      keyEnc = enc;
      key = next;
    } else {
      keyEnc = '';
      key = '';
    }
    keyError = '';
    last = null;
    cache.clear();
    for (const job of active.values()) abortJob(job, 'superseded');
    if (!save()) return Object.assign(describe(), { error: 'The key could not be written to the profile folder.' });
    return describe();
  }

  function setConfig(patch) {
    load();
    const p = patch && typeof patch === 'object' ? patch : {};
    const want = Object.assign({}, cfg);
    const errors = [];
    if (p.mode !== undefined) { if (MODE_IDS.indexOf(p.mode) >= 0) want.mode = p.mode; else errors.push('unknown answer mode'); }
    if (p.capUsd !== undefined) {
      const cap = Number(String(p.capUsd).replace(/[$,\s]/g, ''));
      if (Number.isFinite(cap) && cap > 0 && cap <= CAP_MAX) want.capUsd = Math.round(cap * 100) / 100;
      else errors.push('the monthly cap must be a dollar amount above $0 and at most $' + CAP_MAX.toLocaleString('en-US'));
    }
    for (const k of ['autoModel', 'deepModel']) {
      if (p[k] !== undefined && MODEL_IDS.indexOf(p[k]) < 0) errors.push('answers only use ' + ANSWER_MODEL_LABEL);
    }
    if (errors.length) return Object.assign(describe(), { error: 'Not saved: ' + errors.join('; ') + '.' });
    cfg = cleanCfg(want);
    if (!save()) return Object.assign(describe(), { error: 'The setting could not be written to the profile folder.' });
    return describe();
  }

  /** No anthropic-beta header is ever sent: in particular never the server-side fallback beta. */
  function headers() {
    return { 'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json' };
  }

  /** Settings' "Check key": GET /v1/models, which costs nothing. Also says whether Claude Haiku 5.5,
   *  the only model that answers, is open to this key. */
  async function test() {
    load();
    if (!key) return Object.assign(describe(), { check: { ok: false, state: 'no-key', title: 'No key saved', detail: 'Paste a key first.' } });
    if (!fetchImpl) return Object.assign(describe(), { check: Object.assign({ ok: false }, classifyNetworkError(new Error('no fetch in this build'))) });
    let res;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ctrl ? timers.setTimeout(() => ctrl.abort(), T.headers) : null;
    let check;
    try {
      res = await fetchImpl(apiBase + '/v1/models?limit=100', { method: 'GET', headers: headers(), signal: ctrl ? ctrl.signal : undefined });
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { json = null; }
      if (res.status !== 200) {
        const v = classifyStatus(res.status, json, res.headers);
        check = { ok: false, state: v.state, title: v.title, detail: v.detail };
      } else {
        const ids = json && Array.isArray(json.data) ? json.data.map((m) => m && m.id).filter(Boolean) : null;
        if (!ids) {
          check = { ok: false, state: 'bad-answer', title: 'Anthropic\'s answer could not be read', detail: 'Anthropic answered 200, but not with a model list Quartz understands.' };
        } else {
          check = ids.indexOf(ANSWER_MODEL) < 0
            ? { ok: false, state: 'server', title: 'The key works, but not for ' + ANSWER_MODEL_LABEL, detail: 'Anthropic accepted the key, but its model list has no ' + ANSWER_MODEL_LABEL + ' (' + ANSWER_MODEL + '), the only model Quartz answers with. Check the key\'s workspace at platform.claude.com.' }
            : { ok: true, state: 'ok', title: 'The key works', detail: 'Anthropic accepted it, and ' + ANSWER_MODEL_LABEL + ' is open to it. Checking costs nothing; it cannot show your credit balance.' };
        }
      }
    } catch (err) {
      const v = classifyNetworkError(err, ctrl && ctrl.signal.aborted ? 'headers' : '', T);
      check = { ok: false, state: v.state, title: v.title, detail: v.detail };
    } finally {
      if (t) timers.clearTimeout(t);
    }
    last = { state: check.state, ok: !!check.ok, title: check.title, detail: check.detail, at: now() };
    if (!check.ok) log('check failed:', check.state);
    return Object.assign(describe(), { check });
  }

  /* --- one answer ------------------------------------------------------------------------- */

  function contextBlock(mode) {
    const d0 = new Date(now());
    const date = d0.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    return 'Today is ' + date + '.' + (mode === 'deep'
      ? ' The user asked for a deeper answer: be thorough and precise, but still lead with the answer and stay under about 300 words.'
      : '');
  }

  /** Never carries `fallbacks`, and never needs a beta header. */
  function requestBody(mode, messages) {
    const plan = mode === 'deep' ? PLAN.deep : PLAN.quick;
    return {
      model: plan.model,
      max_tokens: plan.maxTokens,
      stream: true,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: contextBlock(mode) },
      ],
      messages,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: plan.maxUses }],
      output_config: { effort: plan.effort },
    };
  }

  function cacheKey(model, mode, q, history) {
    return model + '\n' + (mode === 'deep' ? 'deep' : 'quick') + '\n' + q + '\n' + JSON.stringify(history);
  }
  function prune() {
    const t = now();
    for (const [k, v] of cache) if (t - v.at > CACHE_TTL_MS) cache.delete(k);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  function abortJob(job, why) {
    if (!job || job.done) return;
    if (!job.why) job.why = why;
    try { job.ctrl.abort(); } catch { /* already */ }
  }

  /** The page side of one answer: start / coalesced deltas / one final call, for one seq. */
  function makeOut(send, seq) {
    let buf = '';
    let timer = null;
    let closed = false;
    function flush() {
      if (timer) { timers.clearTimeout(timer); timer = null; }
      if (buf && !closed) { const t = buf; buf = ''; send({ seq, phase: 'delta', text: t }); }
    }
    return {
      send(obj) { if (!closed) { flush(); send(Object.assign({ seq }, obj)); } },
      delta(t) { if (closed) return; buf += t; if (!timer) timer = timers.setTimeout(flush, DELTA_FLUSH_MS); },
      final(obj) { if (closed) return; flush(); closed = true; send(Object.assign({ seq }, obj)); },
      close() { if (timer) timers.clearTimeout(timer); timer = null; buf = ''; closed = true; },
    };
  }

  /** One streamed request. Resolves { acc, http: verdict|null, why }; never throws. */
  async function streamOnce(job, body, display, out) {
    const acc = createAccumulator({ onText: (t) => out.delta(t) }, display);
    let res = null;
    for (let attempt = 0; ; attempt++) {
      job.stage = 'headers';
      armTimer(job, 'headers', T.headers);
      try {
        res = await fetchImpl(apiBase + '/v1/messages', { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: job.ctrl.signal });
        break;
      } catch (err) {
        if (attempt === 0 && !job.ctrl.signal.aborted && isDroppedConnection(err)) continue;
        return { acc, net: classifyNetworkError(err, job.why, T), err };
      }
    }
    if (res.status !== 200) {
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { json = null; }
      return { acc, http: classifyStatus(res.status, json, res.headers) };
    }
    const ctype = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
    if (!/event-stream/i.test(ctype)) {
      let peek = '';
      try { peek = str(await res.text(), 80); } catch { peek = ''; }
      return { acc, bad: 'Anthropic answered 200, but not with a stream (' + (ctype || 'no content type') + (peek ? ': "' + peek + '"' : '') + ').' };
    }
    const parser = sseParser((ev) => acc.feed(ev));
    const decoder = new TextDecoder('utf-8');
    armTimer(job, 'idle', T.idle);
    try {
      if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
        for await (const chunk of res.body) {
          armTimer(job, 'idle', T.idle);
          parser.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
          const r = acc.result();
          if (r.error || r.sawStop || r.foreign) break;
        }
      } else {
        parser.push(await res.text());
      }
      parser.end();
      if (acc.result().foreign) { try { job.ctrl.abort(); } catch { /* already */ } }   // stop another model's stream
    } catch (err) {
      parser.end();
      acc.finish();
      return { acc, net: classifyNetworkError(err, job.why, T), err, mid: true };
    }
    acc.finish();
    return { acc };
  }

  function armTimer(job, which, ms) {
    if (job.idleTimer) timers.clearTimeout(job.idleTimer);
    job.idleTimer = timers.setTimeout(() => abortJob(job, which), ms);
  }

  /** A partial answer that failed or was stopped still cost something: what we can see of it. */
  function partialCost(model, r, display) {
    if (!r.sawStart) return 0;
    const u = Object.assign({}, r.usage);
    u.output = Math.max(u.output, Math.ceil(display.text.length / 4));
    u.searches = Math.max(u.searches, display.searchesSeen);
    return estimateCost(r.foreign ? (r.model || 'unknown') : model, u);
  }

  function addSpend(usd, counted) {
    rollMonth();
    month.spentUsd = num(month.spentUsd) + num(usd);
    if (counted) month.answers += 1;
    save();
  }

  function remember(state, title, detail) {
    last = { state, ok: state === 'ok', title, detail: detail || '', at: now() };
  }

  /**
   * One answer for one page, as the page asked for it. `send(obj)` delivers to the page.
   * Resolves when that answer is finished (done, fail, off, or superseded). Never throws.
   */
  async function answer(input, send, slot) {
    load();
    rollMonth();
    const req = { q: input.q, seq: input.seq, mode: cleanMode(input.mode) || 'auto', history: capHistory(input.history) };
    const id = slot == null ? 'default' : slot;
    const old = active.get(id);
    if (old) { abortJob(old, 'superseded'); active.delete(id); }
    const out = makeOut(send, req.seq);
    const explicit = req.mode !== 'auto';

    if (!key) {
      if (!explicit) { out.final({ phase: 'off', reason: 'no-key' }); return; }
      out.final(Object.assign({ phase: 'fail' }, {
        state: 'no-key', title: 'No Claude key yet',
        detail: (keyError ? keyError + ' ' : '') + 'AI answers come from Claude through your own Anthropic API key. Make one at platform.claude.com/settings/keys, paste it in Settings > Search, then press Try again.',
        retry: true, settings: true,
      }));
      return;
    }
    if (!explicit && cfg.mode === 'manual') { out.final({ phase: 'off', reason: 'manual' }); return; }
    if (!explicit && cfg.mode === 'questions' && !looksLikeQuestion(req.q)) { out.final({ phase: 'off', reason: 'not-question' }); return; }
    if (month.spentUsd >= cfg.capUsd) {
      const v = {
        state: 'cap-reached', title: 'This month\'s answer budget is used up',
        detail: 'Quartz estimates $' + roundUsd(month.spentUsd).toFixed(2) + ' spent on answers in ' + monthLabel(month.id) +
          ', and your cap is $' + cfg.capUsd.toFixed(2) + '. Answers start again next month, or raise the cap in Settings > Search. (This is Quartz\'s own estimate; it cannot see your real credit balance.)',
        retry: false, settings: true,
      };
      remember(v.state, v.title, v.detail);
      out.final(Object.assign({ phase: 'fail' }, v));
      return;
    }

    const model = ANSWER_MODEL;   // quick and deep alike (requested 10-17: "only haiku")
    const answerMode = req.mode === 'deep' ? 'deep' : 'quick';
    prune();
    const ck = cacheKey(model, answerMode, req.q, req.history);
    const hit = cache.get(ck);
    if (hit && now() - hit.at <= CACHE_TTL_MS) {
      out.send({ phase: 'start', model, modelLabel: modelLabel(model), mode: req.mode });
      out.final(Object.assign({}, hit.done, { mode: req.mode, cached: true, costUsd: 0 }));
      return;
    }
    if (!fetchImpl) { out.final(Object.assign({ phase: 'fail' }, classifyNetworkError(new Error('no fetch in this build')))); return; }

    const job = { seq: req.seq, mode: req.mode, ctrl: new AbortController(), why: '', done: false, idleTimer: null };
    active.set(id, job);
    const totalTimer = timers.setTimeout(() => abortJob(job, 'total'), T.total);
    out.send({ phase: 'start', model, modelLabel: modelLabel(model), mode: req.mode });

    const messages = req.history.map((h) => ({ role: h.role, content: h.text }));
    messages.push({ role: 'user', content: req.q });
    const display = newDisplay();
    const usageSum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0 };
    let costUsd = 0;
    let verdict = null;
    let stopReason = null;
    let stopDetails = null;
    try {
      let convo = messages;
      for (let turn = 0; ; turn++) {
        const body = requestBody(req.mode, convo);
        const r = await streamOnce(job, body, display, out);
        const res = r.acc.result();
        if (job.why === 'superseded') {
          out.close();
          const spent = roundUsd(costUsd + (r.http || r.bad ? 0 : partialCost(model, res, display)));
          if (spent > 0) addSpend(spent, false);
          return;
        }
        if (r.http) { verdict = r.http; break; }
        if (r.bad) { verdict = { state: 'bad-answer', title: 'Claude\'s answer could not be read', detail: r.bad, retry: true, settings: false }; break; }
        if (r.net) { verdict = r.net; costUsd += partialCost(model, res, display); break; }
        if (res.error) { verdict = classifyStreamError(res.error); costUsd += partialCost(model, res, display); break; }
        if (!res.sawStart) {
          verdict = { state: 'bad-answer', title: 'Claude\'s answer could not be read', detail: 'Anthropic answered 200, but the stream had no message in it' + (res.badEvents ? ' (' + res.badEvents + ' unreadable events)' : '') + '.', retry: true, settings: false };
          break;
        }
        if (res.foreign) {
          // Another model answered (or took over): refuse it, plainly. Its tokens still cost.
          costUsd += partialCost(model, res, display);
          verdict = { state: 'bad-answer', title: 'Not an answer from ' + ANSWER_MODEL_LABEL, detail: res.foreign + ' Try again.', retry: true, settings: false };
          break;
        }
        costUsd += estimateCost(model, res.usage);
        for (const k of Object.keys(usageSum)) usageSum[k] += res.usage[k];
        stopReason = res.stopReason;
        stopDetails = res.stopDetails;
        if (!res.sawStop && !res.stopReason) {
          verdict = { state: 'offline', title: 'The answer was cut off', detail: 'The connection to Anthropic ended before the answer finished. Try again.', retry: true, settings: false };
          break;
        }
        if (stopReason === 'pause_turn' && turn < MAX_CONTINUES) {
          convo = messages.concat([{ role: 'assistant', content: res.blocks.map(stripInternal) }]);
          continue;
        }
        break;
      }
    } finally {
      timers.clearTimeout(totalTimer);
      if (job.idleTimer) timers.clearTimeout(job.idleTimer);
      job.done = true;
      if (active.get(id) === job) active.delete(id);
    }

    costUsd = roundUsd(costUsd);
    if (verdict) {
      if (job.why === 'stopped') verdict = classifyNetworkError(null, 'stopped');
      if (costUsd > 0) addSpend(costUsd, false);
      remember(verdict.state, verdict.title, verdict.detail);
      log('answer failed:', verdict.state);   // the state only: never the key, never the query
      out.final(Object.assign({ phase: 'fail', costUsd }, verdict));
      return;
    }
    addSpend(costUsd, true);
    const text = display.text.replace(/\s+$/, '');
    if (stopReason === 'refusal') {
      const cat = stopDetails && stopDetails.category ? ' (' + str(String(stopDetails.category), 40) + ')' : '';
      const why = stopDetails && stopDetails.explanation ? ' Anthropic said: "' + str(String(stopDetails.explanation), 200) + '"' : '';
      const v = { state: 'bad-answer', title: 'Claude declined to answer this one', detail: 'Claude stopped with a refusal' + cat + '.' + why + ' The results below are unaffected.', retry: false, settings: false };
      remember(v.state, v.title, v.detail);
      log('answer failed:', 'refusal');
      out.final(Object.assign({ phase: 'fail', costUsd }, v));
      return;
    }
    if (!text) {
      const v = {
        state: 'bad-answer', title: 'Claude came back without an answer',
        detail: 'Anthropic finished (' + (stopReason || 'no stop reason') + ') but wrote no text' +
          (display.searchErrors.length ? '; web search said: ' + display.searchErrors.join(', ') : '') + '. Try again.',
        retry: true, settings: false,
      };
      remember(v.state, v.title, v.detail);
      log('answer failed:', 'empty');
      out.final(Object.assign({ phase: 'fail', costUsd }, v));
      return;
    }
    const done = {
      phase: 'done',
      text,
      citations: display.list.map((c) => Object.assign({}, c)),
      usage: { input: usageSum.input + usageSum.cacheRead + usageSum.cacheWrite, output: usageSum.output, searches: usageSum.searches, cacheRead: usageSum.cacheRead, cacheWrite: usageSum.cacheWrite },
      costUsd,
      model,
      modelLabel: modelLabel(model),
      mode: req.mode,
      cached: false,
      truncated: stopReason === 'max_tokens' || stopReason === 'pause_turn',
      searchErrors: display.searchErrors.slice(),
      estimate: 'Quartz\'s own estimate at published prices',
    };
    remember('ok', 'Answers are working', '');
    cache.set(ck, { at: now(), done });
    prune();
    out.final(done);
  }

  function stripInternal(b) {
    const c = Object.assign({}, b);
    delete c._json;
    return c;
  }

  /** The page pressed Stop. Only the answer with that seq stops; a stale stop is ignored. */
  function stopAnswer(seq, slot) {
    const id = slot == null ? 'default' : slot;
    const job = active.get(id);
    if (!job || job.seq !== seq) return false;
    abortJob(job, 'stopped');
    return true;
  }

  /* --- the guest side ------------------------------------------------------------------------ */

  function isSearchPage(url) {
    if (!isBundledPage(url)) return false;
    try { return path.basename(new URL(url).pathname).toLowerCase() === PAGE_FILE; } catch { return false; }
  }
  function messageOf(first, args) {
    if (first && typeof first === 'object' && typeof first.message === 'string') return first.message;
    if (typeof args[2] === 'string') return args[2];
    if (typeof args[1] === 'string') return args[1];
    return '';
  }
  function pushTo(contents, obj) {
    if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) return;
    let url = '';
    try { url = contents.getURL(); } catch { return; }
    if (!isSearchPage(url)) return;   // it navigated away while Claude was answering
    let json;
    try { json = JSON.stringify(obj); } catch { return; }
    try {
      const p = contents.executeJavaScript('window.__applyAnswer && window.__applyAnswer(' + json + ')');
      if (p && typeof p.catch === 'function') p.catch(() => { /* the page went away */ });
    } catch { /* destroyed mid-call */ }
  }
  function slotOf(contents) {
    try { return 'wc' + contents.id; } catch { return 'wc?'; }
  }
  /** One console line from one guest. True when it was an answer line from our page. */
  function handleGuestLine(contents, line) {
    if (typeof line !== 'string' || line.indexOf('quartz-search:answer') !== 0) return false;
    let url = '';
    try { url = contents.getURL(); } catch { return false; }
    if (!isSearchPage(url)) return false;
    const stop = parseStopLine(line);
    if (stop) { stopAnswer(stop.seq, slotOf(contents)); return true; }
    const req = parseAnswerLine(line);
    if (!req) return false;
    answer(req, (obj) => pushTo(contents, obj), slotOf(contents)).catch((err) => {
      log('answer crashed:', (err && err.name) || 'error');
      pushTo(contents, Object.assign({ seq: req.seq, phase: 'fail' }, { state: 'server', title: 'Quartz hit a problem writing the answer', detail: 'Quartz\'s answer code failed (' + str(String((err && err.message) || 'unknown'), 120) + '). The results below are unaffected.', retry: true, settings: false }));
    });
    return true;
  }
  function abortFor(contents) {
    const job = active.get(slotOf(contents));
    if (job) abortJob(job, 'superseded');
  }
  function watchGuest(contents) {
    if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) return;
    contents.on('console-message', function (details) {
      try { handleGuestLine(contents, messageOf(details, arguments)); } catch (err) {
        log('guest line failed:', (err && err.message) || 'error');
      }
    });
    // A new page (or a reload) starts its seqs again, so whatever the old one asked for stops here.
    contents.on('did-start-navigation', function (details) {
      const a = arguments;
      const main = details && typeof details === 'object' && 'isMainFrame' in details ? details.isMainFrame : a[3];
      const same = details && typeof details === 'object' && 'isSameDocument' in details ? details.isSameDocument : a[2];
      if (main !== false && !same) abortFor(contents);
    });
    contents.on('destroyed', () => abortFor(contents));
  }
  function registerIpc(ipcMain, isChromeSender) {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return;
    const gate = typeof isChromeSender === 'function' ? isChromeSender : () => false;
    ipcMain.handle('claude-answer:describe', (event) => (gate(event) ? describe() : null));
    ipcMain.handle('claude-answer:set-key', (event, k) => (gate(event) ? setKey(k) : null));
    ipcMain.handle('claude-answer:set-config', (event, p) => (gate(event) ? setConfig(p) : null));
    ipcMain.handle('claude-answer:test', (event) => (gate(event) ? test() : null));
  }

  if (electronApp && typeof electronApp.on === 'function') {
    electronApp.on('web-contents-created', (_event, contents) => {
      try { if (contents && contents.getType() === 'webview') watchGuest(contents); } catch { /* died already */ }
    });
  }
  if (d.ipcMain) registerIpc(d.ipcMain, d.isChromeSender);

  return {
    describe, setKey, setConfig, test, answer, stopAnswer, handleGuestLine, watchGuest, registerIpc,
    /** Quit: abort whatever is streaming; the in-memory answer cache goes with the process. */
    stop: () => { for (const job of active.values()) abortJob(job, 'superseded'); active.clear(); cache.clear(); },
    state: () => ({ active: active.size, cacheEntries: cache.size, apiBase }),
  };
}

module.exports = {
  create,
  DELTA_FLUSH_MS,
  maskKey,
  cleanKey,
  capHistory,
  parseAnswerLine,
  parseStopLine,
  looksLikeQuestion,
  estimateCost,
  priceRow,
  usageOf,
  classifyStatus,
  classifyStreamError,
  classifyNetworkError,
  sseParser,
  createAccumulator,
  monthId,
  API_BASE,
  API_VERSION,
  LINE_ANSWER,
  LINE_STOP,
  STORE_FILE,
  KEYS_URL,
  PRICES,
  PRICES_CHECKED,
  SEARCH_USD,
  ANSWER_MODEL,
  ANSWER_MODEL_LABEL,
  MODELS,
  MODES,
  DEFAULTS,
  PLAN,
  SYSTEM_PROMPT,
  HISTORY_MAX_TURNS,
  HISTORY_MAX_CHARS,
  HOLD_CHARS,
};
