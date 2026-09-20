#!/usr/bin/env node
'use strict';
// Targeted mutation pass for the pure-logic modules (coverage-check.js).
// A full Stryker rig is overkill for a one-time artifact and does not handle
// this suite's require-cache stubbing well; this applies a curated set of
// mutations to the source, runs the relevant tests against each mutant, and
// reports killed vs survived. A SURVIVED mutant = a gap in the assertions.
//
// Run: node scripts/mutation-pass.js

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const TARGET = path.join(REPO, 'filter-lambda', 'coverage-check.js');
const TESTS = [
  'tests/filter-lambda/coverage-check.property.test.js',
  'tests/filter-lambda/handler-helpers.unit.test.js',
];

const original = fs.readFileSync(TARGET, 'utf8');

// Each mutation: a literal find -> replace that changes behaviour. Chosen to hit
// the load-bearing operators of the enqueue/coverage decision.
const mutations = [
  { name: 'enqueue: < -> <= (archive older-than boundary)', find: 'archiveEpoch < contentEpoch - skewMs', repl: 'archiveEpoch <= contentEpoch - skewMs' },
  { name: 'enqueue none -> false (never enqueue on empty bucket)', find: "outcome === 'none') {\n        enqueue = true;", repl: "outcome === 'none') {\n        enqueue = false;" },
  { name: 'enqueue indeterminate -> false (fail closed)', find: "outcome === 'indeterminate') {\n        enqueue = true;", repl: "outcome === 'indeterminate') {\n        enqueue = false;" },
  { name: 'fail-open recentVerified negation dropped', find: 'enqueue = !recentVerified;', repl: 'enqueue = recentVerified;' },
  { name: 'coverage gap: >= -> > (equal-ts covered boundary)', find: 'archiveEpoch >= contentEpoch - skewMs', repl: 'archiveEpoch > contentEpoch - skewMs' },
  { name: 'coverage graceElapsed: > -> >=', find: 'now - contentEpoch > graceMs', repl: 'now - contentEpoch >= graceMs' },
  { name: 'toEpoch finite guard removed', find: 'return Number.isFinite(t) ? t : null;', repl: 'return t;' },
  { name: 'parseStoreState array guard removed', find: "typeof v === 'object' && !Array.isArray(v)", repl: "typeof v === 'object'" },
  { name: 'ARCHIVE_KEY start-anchor removed (staging leaks in)', find: 'const ARCHIVE_KEY = /^\\d{4}\\/\\d{2}\\/\\d{2}\\/[^/]*\\.\\d{3}Z\\.zip$/;', repl: 'const ARCHIVE_KEY = /\\d{3}Z\\.zip$/;' },
  { name: 'branchMatches ignored in enqueue', find: 'if (branchMatches && statusCaptured) {', repl: 'if (statusCaptured) {' },
];

function runTests() {
  execFileSync('node', ['--test', ...TESTS], { cwd: REPO, stdio: 'pipe' });
}

// Sanity: the unmutated suite must pass.
try { runTests(); } catch (e) {
  console.error('BASELINE FAILED — fix the suite before mutation testing.');
  process.exit(2);
}
console.log(`Baseline green. Applying ${mutations.length} mutations to coverage-check.js\n`);

let killed = 0; let survived = 0; const survivors = [];
for (const m of mutations) {
  if (!original.includes(m.find)) {
    console.log(`SKIP  (pattern not found): ${m.name}`);
    continue;
  }
  fs.writeFileSync(TARGET, original.replace(m.find, m.repl));
  let testFailed = false;
  try { runTests(); } catch { testFailed = true; }
  if (testFailed) { killed += 1; console.log(`KILLED   ${m.name}`); }
  else { survived += 1; survivors.push(m.name); console.log(`SURVIVED ${m.name}`); }
}
fs.writeFileSync(TARGET, original); // always restore

const total = killed + survived;
const score = total ? Math.round((killed / total) * 1000) / 10 : 0;
console.log(`\nMutation score: ${killed}/${total} killed (${score}%)`);
if (survivors.length) {
  console.log('Survivors (assertion gaps):');
  for (const s of survivors) console.log(`  - ${s}`);
}
process.exit(survived ? 1 : 0);
