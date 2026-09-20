# Backup reliability & modernisation

Implements the full `backup-reliability-and-modernisation` spec (20 tasks) and
deploys it to production. Fixes the silent-failure class of bugs the review
found, modernises the runtime and libraries, and hardens the pipeline end to end.

**Target:** `dev` · **Suite:** 184 pass / 0 fail on Node 24 · **Mutation score:**
100% on the core decision logic · **Status in prod:** live and verified on
`cloudypandas-backup-prod`.

## Why

The original system could fail silently: the backup handler returned a 500
object on failure (which the event-source mapping read as success and deleted
the message), the DLQ was unreachable (source retention < visibility timeout),
and the filter produced "no backup needed" on an unusable timestamp. Archives
could be recorded as complete while missing assets. The runtime was EOL and the
deploy was non-reproducible.

## What changed

**Reliability**
- Every failure path now **throws** (returns the message to the queue), so
  failures reach the DLQ and the terminal Notifier. Fail loudly, never silently.
- Corrected queue timing chain (visibility ≥ 6× timeout; retention ≥ 2× vis ×
  receiveCount) + a terminal queue behind the DLQ. Fixes the unreachable-DLQ bug.
- Grace-bounded **stateful coverage check** (SSM store): reports a *broken*
  pipeline instead of masking it forever, while suppressing a genuinely in-flight
  backup.
- Filter fails open on any unusable last-update response (fixes the epoch-0 and
  NaN silent-no-backup bugs); reads two endpoints; anchored status regex.
- Backup: staging-upload → verify → promote (a bad archive never lands under a
  coverage-visible key, with no delete permission on any role); asset
  reconciliation by size against `details.size`.

**Modernisation**
- `nodejs20.x` → `nodejs24.x`; `adm-zip` → `archiver`; buffered upload → streamed
  `@aws-sdk/lib-storage`; SDK v3 clients pinned; `.nvmrc` + `engines`; `npm ci`.

**Observability (no standing cost)**
- Email-on-failure only — no alarms, metrics, dashboards, or scheduled backups
  (Contentful quota is scarce). Enforced structurally by an invariant test.
- Stack-managed `INFREQUENT_ACCESS` log groups; a terminal Notifier for the DLQ.

**Infrastructure & deploy**
- S3 lifecycle (no current-version expiry, bounded noncurrent, abort-MPU, staging
  TTL); TLS-deny bucket policy; OFF-by-default replication & Object Lock;
  `BucketOwnerEnforced`.
- No fixed physical names; full stack outputs. Reproducible, gated deploy script
  (allow-list packaging, dirty-tree refusal, commit tagging, version pruning,
  names from stack outputs).
- CI (Node 24, suite + audit + cfn-lint, no creds); Dependabot across all four
  manifests; executable deploy docs verified by a doc-vs-template parity test.

## Verified in production (commissioning run, task 14/15)

Deployed to `cloudypandas-backup-prod` and ran a real backup of the largest
space end to end. Measured envelope: **peak memory 378 MB** (not the assumed
~950 MB — the streaming redesign removed the buffer-everything memory),
**duration 13.8 s**, archive 87.6 MB, 300 entries / 97 assets, 0 errors. Finals
set to 768 MB / 1024 MB ephemeral.

## Bugs the deployment caught that unit tests could not

1. Flat `EphemeralStorageSize` — CloudFormation execute-time validation error.
2. `toEpoch` threw on a non-primitive value — fast-check counterexample.
3. Deploy credential-guard false-positive on a vendored SDK file.
4. Bucket policy denied the function's own upload (SSE-header deny).
5. **Asset reconciliation hardcoded `en-US`** — a no-op on the `en-GB` prod space,
   so the completeness check silently checked nothing.
6. Mutation testing then found 4 assertion gaps (skew/grace boundaries, a
   defective staging-key test) — all closed; score now 100%.

## Testing

- `node --test 'tests/**/*.test.js'` — 184 pass, 0 fail on Node 24.
- `node scripts/mutation-pass.js` — 10/10 mutants killed on `coverage-check.js`.
- Full commissioning + retest against production (see
  `docs/backup-reliability-and-modernisation/commissioning-export.md`).

## Notes / follow-ups

- The new pipeline is **already live in prod** (mappings enabled) — merging this
  aligns the repo's default branch with what is deployed.
- npm audit residual: transitive `@smithy`/`fast-xml-parser` advisories in the
  AWS SDK (fewer highs than the old deps); CI gates on CRITICAL only.
- Not in this PR: restore functionality, cross-backup asset deduplication (the
  effective long-term storage lever), licence change.
