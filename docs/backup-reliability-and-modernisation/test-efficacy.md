# Test Efficacy — coverage and mutation

## Coverage (`node --test --experimental-test-coverage`)

Measured on Node v24.11.0 against the full suite (176 tests, 0 failing).

| File | line % | branch % | funcs % |
|---|---|---|---|
| backup-lambda/index.js | 95.07 | 77.78 | 84.21 |
| filter-lambda/coverage-check.js | 97.16 | 96.23 | 75.00 |
| filter-lambda/index.js | 44.04 | 92.86 | 28.57 |
| notifier-lambda/index.js | 98.31 | 67.86 | 100.00 |
| deploy/build-lambda.js | 37.82 | 75.00 | 25.00 |
| **all files** | **74.22** | **84.29** | **67.86** |

### Reading the numbers

- The **pure decision logic** — `coverage-check.js` (the enqueue/coverage
  tables), the backup handler's reconciliation and key generation, the
  Notifier's classification and query building — is exercised at 95–98%. That is
  where the correctness lives and where the review found the silent-failure bugs.
- `filter-lambda/index.js` (44%) and `deploy/build-lambda.js` (38%) are low
  because their **end-to-end orchestration bodies** wire together AWS I/O
  (multi-client fan-out, the CloudFormation-output lookup, the real multipart
  upload). Those paths are only fully exercised by the commissioning deploy
  (spec task 14) and the induced-failure email matrix (requirement 10); the pure
  helpers they compose (`fetchLatestTimestamp`, `branchFromUrl`, `getConfig`,
  `collectAllowedFiles`, the credential patterns) are unit-covered.

The intent is high coverage of the logic that can fail silently, not a single
headline number inflated by exercising glue against mocks.

## Mutation pass — RUN (targeted, one-time)

A targeted mutation pass over the pure-logic module `filter-lambda/coverage-check.js`
(`scripts/mutation-pass.js`) applies 10 curated mutations to the load-bearing
operators of the enqueue/coverage decision and runs the relevant tests against
each mutant. A full Stryker rig was rejected as overkill for a one-time artifact
that also does not handle this suite's require-cache stubbing well.

**Result: 10/10 killed (100%)** — after closing 4 gaps the first run exposed:

| Mutation | First run | After fix |
|---|---|---|
| enqueue `<` → `<=` (skew boundary) | SURVIVED | KILLED |
| coverage `>=` → `>` (equal-ts covered) | SURVIVED | KILLED |
| grace `>` → `>=` (grace boundary) | SURVIVED | KILLED |
| ARCHIVE_KEY start-anchor removed (staging leaks in) | SURVIVED | KILLED |
| enqueue none/indeterminate → false | KILLED | KILLED |
| fail-open negation dropped | KILLED | KILLED |
| toEpoch finite guard removed | KILLED | KILLED |
| parseStoreState array guard removed | KILLED | KILLED |
| branchMatches ignored | KILLED | KILLED |

The four survivors were genuine assertion gaps: the suite passed but did not pin
the skew/grace boundaries, and the ARCHIVE_KEY test mutated the staging key to a
non-conforming name before asserting (so it never proved a *conforming* staging
key is excluded — the exact staging-leak bug found in production). All four now
have boundary-precise regression tests. Re-run any time with
`node scripts/mutation-pass.js`.

