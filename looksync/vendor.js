#!/usr/bin/env node
'use strict';
/*
 * looksync/vendor.js - copies the shared look module into Quartz.
 *
 *   node looksync/vendor.js [commit]     re-copy from ~/look-sync at <commit> (default: the pinned one)
 *   node looksync/vendor.js --check      prove the vendored copies are byte-identical to the pinned commit
 *
 * The three files are copied AS THEY ARE, with a header naming the source
 * commit in front. accent.browser.js is the same accent.js wrapped so the
 * file:// pages (index.html, newtab.html) can load it with a <script> tag:
 * it runs inside a function scope (its top-level consts never collide with a
 * page's globals) and leaves window.LookAccent = { tokens, ... }.
 * wash.browser.js is look-sync.js's pure block (seeds, ranges, washAlpha:
 * the one tint rule every app shares) wrapped the same way, for index.html:
 * window.LookWash = { washAlpha, SEED, RANGES, WASH_CEIL }.
 * Never edit a vendored copy: change ~/look-sync, run its tests, re-copy.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PINNED = '3fa3800';
const SRC_REPO = process.env.LOOK_SYNC_REPO || path.join(require('os').homedir(), 'look-sync');
// fake-writer.js is the test tool looksync-e2e drives the shared file with (it needs ./look-sync).
const FILES = ['look-sync.js', 'accent.js', 'windows-mode.js', 'fake-writer.js'];
const HERE = __dirname;

function header(commit, file) {
  return '/* VENDORED from ~/look-sync commit ' + commit + ' (' + file + '), Owen-Silva/look-sync.\n' +
    '   Do not edit this copy: change ~/look-sync, run its tests, then `node looksync/vendor.js <commit>`. */\n';
}

function show(commit, file) {
  return execFileSync('git', ['-C', SRC_REPO, 'show', commit + ':' + file], { encoding: 'utf8' });
}

function build(commit) {
  const out = {};
  for (const f of FILES) {
    const src = show(commit, f);
    // a #! line must stay the first line, or node will not parse the file
    const bang = /^#![^\n]*\n/.exec(src);
    out[f] = bang ? bang[0] + header(commit, f) + src.slice(bang[0].length) : header(commit, f) + src;
  }
  const acc = show(commit, 'accent.js');
  out['accent.browser.js'] = header(commit, 'accent.js, wrapped for <script> pages') +
    '(function () {\nvar module = { exports: {} };\n' + acc +
    '\nwindow.LookAccent = module.exports;\n})();\n';
  // wash.browser.js: look-sync.js's pure block (the seeds, ranges and
  // washAlpha, between its "pure (browser-safe)" markers), wrapped the same
  // way; it leaves window.LookWash = { washAlpha, SEED, RANGES, WASH_CEIL }.
  const ls = show(commit, 'look-sync.js');
  const m = /\/\/ ==== pure \(browser-safe\): begin ====\r?\n([\s\S]*?)\/\/ ==== pure \(browser-safe\): end ====/.exec(ls);
  if (!m) throw new Error('look-sync.js at ' + commit + ' has no pure (browser-safe) block');
  out['wash.browser.js'] = header(commit, 'look-sync.js pure block: washAlpha, wrapped for <script> pages') +
    "(function () {\n'use strict';\n" + m[1] +
    'window.LookWash = { washAlpha: washAlpha, SEED: SEED, RANGES: RANGES, WASH_CEIL: WASH_CEIL };\n})();\n';
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  const commit = process.argv.slice(2).find(a => !a.startsWith('--')) || PINNED;
  let full;
  try { full = execFileSync('git', ['-C', SRC_REPO, 'rev-parse', '--short', commit], { encoding: 'utf8' }).trim(); }
  catch (err) { console.error('vendor: cannot read ' + SRC_REPO + ' at ' + commit + ': ' + err.message); process.exit(2); }
  const files = build(full);
  let bad = 0;
  for (const [name, text] of Object.entries(files)) {
    const dest = path.join(HERE, name);
    if (check) {
      const have = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
      const ok = have === text;
      if (!ok) bad++;
      console.log((ok ? 'same   ' : 'DIFFERS') + ' ' + name);
    } else {
      fs.writeFileSync(dest, text);
      console.log('wrote ' + name + ' from ' + full);
    }
  }
  if (check) {
    console.log('vendor check: ' + (Object.keys(files).length - bad) + '/' + Object.keys(files).length + ' identical to ' + full);
    process.exit(bad ? 1 : 0);
  }
}

main();
