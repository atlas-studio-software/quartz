// openurlqueue.js - links that reach Quartz before the chrome is listening.
// Pure: no Electron, so openurlqueue-harness.js runs it under plain node.
//
// A link arrives as one command line (our own argv, or a second instance's via
// the single-instance lock); argvurl.js takes the LAST candidate on that line.
// Until index.html has finished loading nothing listens for 'open-url', so the
// link waits here. Several links can arrive in that window (two quick clicks in
// another app while Quartz starts): each one waits, in arrival order, up to MAX.
// Past that the OLDEST is dropped, and that is said in quartz.log and, once the
// chrome is up, on screen.
//
// When the chrome is ready, every waiting link becomes its own foreground tab
// in arrival order, so the LAST one ends up in front: the same result as one
// link, and the same as the clicks would have given had Quartz been running.

const MAX = 10;

// What urlFromArgv can return: an http(s) URL or a file: URL (an .htm(l) path
// is turned into one there). Anything else is refused here as well, so a bug
// upstream cannot park a javascript: or data: address for the chrome.
const ACCEPTED = /^(https?:\/\/[^\s/]|file:)/i;

/** Where a link points, without the rest of its address (log lines carry no paths or queries). */
function placeOf(url) {
  const u = String(url || '');
  if (/^file:/i.test(u)) return 'a local file';
  try {
    const x = new URL(u);
    return x.hostname.replace(/^www\./i, '') + (x.port ? ':' + x.port : '');
  } catch (_) {
    return 'an unreadable address';
  }
}

/** The on-screen words for links dropped while Quartz started. */
function noticeText(dropped, max = MAX) {
  if (!(dropped > 0)) return '';
  const what = dropped === 1 ? '1 link was' : dropped + ' links were';
  return `${what} not opened: more than ${max} arrived while Quartz was starting, so the oldest were dropped.`;
}

/**
 * createOpenUrlQueue({ max, log }) -> { park, drain, size }
 *   park(url)  -> { ok: true, dropped: url | null } | { ok: false, reason }
 *   drain()    -> [{ url, background: false, notice? }] in arrival order; the
 *                 LAST carries `notice` when links were dropped. Empties the queue.
 * `log(line)` gets one sentence per drop or refusal.
 */
function createOpenUrlQueue(opts = {}) {
  const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : MAX;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  let urls = [];
  let dropped = 0;

  function park(url) {
    if (typeof url !== 'string' || !ACCEPTED.test(url.trim())) {
      const reason = 'only an http(s) or file: address can open a tab from a command line';
      log(`A link from a command line was refused: ${reason}.`);
      return { ok: false, reason };
    }
    urls.push(url);
    let gone = null;
    if (urls.length > max) {
      gone = urls.shift();
      dropped++;
      log(`A link to ${placeOf(gone)} was not opened: more than ${max} links arrived while Quartz was starting, so the oldest was dropped.`);
    }
    return { ok: true, dropped: gone };
  }

  function drain() {
    const list = urls.map((url) => ({ url, background: false }));
    if (list.length && dropped) list[list.length - 1].notice = noticeText(dropped, max);
    urls = [];
    dropped = 0;
    return list;
  }

  return { park, drain, size: () => urls.length };
}

/**
 * createLinkOpener({ isReady, send, log, max }) -> { open, flush, size }
 * main.js's half: open(url) sends { url, background: false } at once when the
 * chrome is listening (isReady()), after anything still parked so the order
 * holds; otherwise it parks the link. flush() sends every parked link, oldest
 * first, and is called when the chrome finishes loading.
 */
function createLinkOpener(opts) {
  const isReady = opts.isReady;
  const send = opts.send;
  const queue = createOpenUrlQueue({ max: opts.max, log: opts.log });

  function flush() {
    for (const payload of queue.drain()) send(payload);
  }

  function open(url) {
    if (!url) return;
    if (!isReady()) { queue.park(url); return; }
    flush();
    send({ url, background: false });
  }

  return { open, flush, size: queue.size };
}

module.exports = { createOpenUrlQueue, createLinkOpener, noticeText, placeOf, MAX };
