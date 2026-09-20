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

## Mutation pass — status: PENDING (one-time)

The spec calls for a one-time mutation pass (e.g. Stryker) to prove the suite
kills injected faults, recorded here. It is **not yet run**: it is a one-off
tooling step best run once the deploy-dependent paths (tasks 14–16) are
exercised, so the mutation report reflects the whole system rather than only the
pure modules. Two faults the suite already demonstrably kills, found during
implementation, are recorded as evidence the assertions bite:

- Relaxing `ARCHIVE_KEY` to an end-anchored suffix let a `staging/` key read as a
  covering archive — caught by the s3-listing contract fixture test.
- An array slipping through `parseStoreState` (missing `!Array.isArray` guard) —
  caught by the coverage-check property test.
- `getConfig` resolving prototype-chain names — caught by the config-selection
  property test (which previously *excluded* those inputs, hiding the fault).
