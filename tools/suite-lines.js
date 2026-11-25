// tools/suite-lines.js -- which lines of a test's output run-suite.js lifts under a FAIL (pure, no I/O).
//
// Every FAIL line a test prints is lifted, whatever comes before the word: nothing ("FAIL x"),
// indentation ("  FAIL x"), a bracketed tag ("[debugport-e2e] FAIL crashed: ..."), a "name:" label,
// or several of those. "HARNESS ERROR" lines likewise. The test's own summary line
// ("<name>: N passed, M failed") never is, and at most `max` lines come back (default 8).
// Tested by tests/suite-lines-test.js.
'use strict';

/** A test's summary line: "<name>: N passed, M failed" (or "smoke: N ok, M failed"). */
const SUMMARY = /^(?:\S.*?): (\d+) (?:passed|ok), (\d+) failed/;
/** Optional prefixes ([tag], name:, whitespace, any number of them), then FAIL or HARNESS ERROR as a word. */
const FAIL_LINE = /^(?:\s*\[[^\]\r\n]*\]|\s*[\w.@/-]+:(?=\s))*\s*(?:FAIL|HARNESS ERROR)\b/;

const DEFAULT_MAX = 8;

/** true when one output line (without its line ending) is a FAIL or HARNESS ERROR line to lift. */
function isFailLine(line) {
  const l = String(line).replace(/\r$/, '');
  return !SUMMARY.test(l.trim()) && FAIL_LINE.test(l);
}

/** The FAIL / HARNESS ERROR lines of a test's whole output (LF or CRLF), in order, at most `max`. */
function failLines(text, max) {
  const cap = Number.isInteger(max) && max >= 0 ? max : DEFAULT_MAX;
  return String(text || '').split(/\r?\n/).filter(isFailLine).slice(0, cap);
}

module.exports = { SUMMARY, FAIL_LINE, DEFAULT_MAX, isFailLine, failLines };
