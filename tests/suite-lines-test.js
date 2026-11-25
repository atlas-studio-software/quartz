// tests/suite-lines-test.js - which lines run-suite.js lifts under a failing test (tools/suite-lines.js).
// Every FAIL line, whatever its prefix, and HARNESS ERROR lines; never a PASS line or the summary line;
// at most the cap; LF and CRLF alike. Run: node tests/suite-lines-test.js.
// One summary line: "suite-lines: N passed, M failed".
'use strict';
const { failLines, isFailLine, DEFAULT_MAX, SUMMARY } = require('../tools/suite-lines');

let pass = 0, fail = 0;
function check(ok, what, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + what + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A real run where nothing was lifted: the FAIL line carries the test's own "[debugport-e2e] " tag.
const debugport = [
  '[debugport-e2e] A: holding 9481 in this process (pid 2816)',
  '[debugport-e2e] A: quartz pid 3272',
  '[debugport-e2e] FAIL crashed: Error: timed out waiting for A cdp.json',
  '    at waitFor (D:\\a\\quartz\\quartz\\debugport-e2e.js:68:9)',
  '[debugport-e2e] could not delete the temp profile ...: EPERM ...',
  'debugport-e2e: 0 passed, 1 failed',
].join('\n');
check(same(failLines(debugport), ['[debugport-e2e] FAIL crashed: Error: timed out waiting for A cdp.json']),
  'debugport-e2e output: its tagged FAIL crashed line is lifted, nothing else', failLines(debugport));

const lifted = [
  ['FAIL x', 'plain'],
  ['       FAIL x', 'indented'],
  ['\tFAIL x', 'tab-indented'],
  ['[a-b] FAIL crashed: Error: boom', 'bracketed tag'],
  ['[e2e] [step 3] FAIL two tags', 'two bracketed tags'],
  ['watch-e2e: FAIL the pane came up', 'a name: label'],
  ['FAIL', 'the bare word'],
  ['HARNESS ERROR', 'HARNESS ERROR alone'],
  ['HARNESS ERROR: cannot read fixtures', 'HARNESS ERROR with detail'],
  ['[x] HARNESS ERROR: boom', 'tagged HARNESS ERROR'],
  ['FAIL x\r', 'a line still carrying its CR'],
];
for (const [l, why] of lifted) check(isFailLine(l), 'lifted: ' + why, l);

const kept = [
  ['PASS x', 'a PASS line'],
  ['[debugport-e2e] ok   A: on at N+1', 'a tagged ok line'],
  ['x: 3 passed, 1 failed', 'the summary line'],
  ['debugport-e2e: 0 passed, 1 failed', 'a summary line with a hyphenated name'],
  ['smoke: 12 ok, 2 failed', "smoke's summary form"],
  ['FAILED x', 'FAILED is not the word FAIL'],
  ['FAILURES: 0', 'FAILURES is not the word FAIL'],
  ['[x] the step did not FAIL', 'FAIL mid-sentence'],
  ['    at waitFor (D:\\a\\debugport-e2e.js:68:9)', 'a stack line'],
  ['', 'an empty line'],
  ['SKIP x: no GPU', 'a SKIP line (shown by its own rule)'],
];
for (const [l, why] of kept) check(!isFailLine(l), 'not lifted: ' + why, l);
check(SUMMARY.test('x: 3 passed, 1 failed') && SUMMARY.test('debugport-e2e: 0 passed, 1 failed'), 'SUMMARY still reads both summary lines');

// CRLF input: same lines, no stray CR left on them.
const crlf = 'PASS a\r\n[t] FAIL b: why\r\n  FAIL c\r\nHARNESS ERROR d\r\nt: 1 passed, 3 failed\r\n';
check(same(failLines(crlf), ['[t] FAIL b: why', '  FAIL c', 'HARNESS ERROR d']), 'CRLF input: three lines lifted, no CR left', failLines(crlf));
const mixed = 'FAIL a\nFAIL b\r\nFAIL c';
check(same(failLines(mixed), ['FAIL a', 'FAIL b', 'FAIL c']), 'mixed LF / CRLF input', failLines(mixed));

// The cap: at most 8 by default (the suite's), or what is asked, in output order.
const many = Array.from({ length: 12 }, (_, i) => '[t] FAIL check ' + i).join('\n');
check(DEFAULT_MAX === 8 && failLines(many).length === 8 && failLines(many)[0] === '[t] FAIL check 0' && failLines(many)[7] === '[t] FAIL check 7', 'capped at 8 by default, the first 8 in order', failLines(many).length);
check(failLines(many, 3).length === 3 && failLines(many, 0).length === 0, 'an explicit cap is honoured (3, 0)');
check(same(failLines(''), []) && same(failLines(null), []) && same(failLines(undefined), []), 'empty or missing output lifts nothing');

console.log('suite-lines: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
