# Decision Record — Backup Reliability & Modernisation

This records the load-bearing decisions, the deferrals, and the claims the
original review had to correct. It is the companion to `requirements.md` and
`design.md` under `.kiro/specs/backup-reliability-and-modernisation/`.

## Corrected claims (things the original system got wrong)

- **Silent success on failure.** The Backup handler `return`ed a 500 response
  object on every failure path. The event-source mapping reads a clean return as
  success and deletes the message, so failures were silently discarded. Fixed:
  every failure now **throws**; `sendResponse` survives only on the success path.
- **DLQ was unreachable.** The source queue's `MessageRetentionPeriod` (900 s)
  was shorter than its `VisibilityTimeout` (1800 s), so a failing message aged
  out before it could reach the DLQ. Fixed: visibility ≥ 6× the 900 s Backup
  timeout, retention 14 days, with the coupling recorded inline.
- **`MemorySize: 450` was not a tuned value.** The largest current backup
  consumes ~950 MB, so the function was being OOM-killed on its largest runs — a
  cause of the silent-failure symptom. Interim raised to 1536 MB; the
  commissioning export measures the final and flags any approach to ~70% of
  Lambda's 10240 MB / 900 s ceilings.
- **Truthiness / NaN no-backup path.** The Filter used `if (!latestUpdate)` (a
  valid epoch-0 reads as falsy) and `new Date(undefined)` → `NaN`, so an unusable
  timestamp silently produced "no backup needed". Fixed: `Number.isFinite`
  guards throughout and fail-open on any unusable response.
- **Unanchored status match.** `message.includes("SUCCEED")` matched the word
  anywhere in any field. Fixed: an anchored regex with a capture group keyed to
  `jobStatus`.
- **`getConfig` resolved prototype-chain names** (`configs['constructor']` is
  truthy). Fixed: own-property lookup.
- **Vacuous tests.** Several tests grepped source text or restated a function's
  definition; the `uploadFile` test enshrined the removed HTTP-200 anti-pattern;
  a generator deliberately excluded the very prototype keys that would expose a
  bug. All replaced with behavioural tests.
- **Asset reconciliation was locale-hardcoded to `en-US`.** The size-completeness
  check (Requirement 15) read `file['en-US']`, but the production space uses
  `en-GB`, so the lookup fell through and EVERY asset was skipped — the check was
  a silent no-op on that space, and a truncated or missing asset would have
  passed undetected. Found while investigating an unexpected archive-size change
  (below). Fixed to iterate every locale's file entry; regression tests added.

## Findings from the production commissioning run

Only discoverable against the real account and the real Contentful space — the
argument for front-loading the commissioning deploy:

- **Six bugs the unit suite could not catch**, each fixed and committed: the flat
  `EphemeralStorageSize` (CloudFormation execute-time validation), a `toEpoch`
  throw on a non-primitive value (fast-check), the deploy credential-guard
  false-positive on a vendored SDK file, the bucket policy denying the function's
  own upload, and the en-GB reconciliation no-op.
- **Measured memory was 378 MB, not the assumed ~950 MB** — the streaming
  redesign removed the old buffer-everything memory. Finals: 768 MB / 1024 MB.
- **Archive-size "growth" was not a defect.** An identical-content backup grew
  67 MB → 87.6 MB. The archive is ~96% already-compressed binary
  (PDF/JPEG/GIF/PNG); only the ~2.3 MB JSON is compressible (already ~9×). The
  older, smaller zip held *larger, more-compressible superseded* versions of the
  same assets; the API's declared `details.size` matches the new archive exactly,
  so the new backup is the faithful one. Measured ceiling: `zip -9` saves 0.2%,
  `zstd -19` ~4.7% (~4 MB) — fractions of a cent/month in DEEP_ARCHIVE.
  **Compression left as-is (deflate level 9).** The real storage lever is a
  faster DEEP_ARCHIVE transition or cross-backup asset dedup (future project),
  not the compressor.

## Key decisions

- **Keep the laptop `UpdateFunctionCode` deploy** (owner's choice), made
  reproducible and gated rather than moved to CI/OIDC.
- **Published-state export only** (`includeDrafts: false`) — shifts load onto the
  CDA rate-limit allowance.
- **Email-on-failure only** — no CloudWatch alarms, metrics, dashboards, or
  scheduled/synthetic backups (Contentful quota is scarce and shared). Enforced
  structurally by an invariant test.
- **Staging-then-promote**: a verified archive is copied to the coverage-visible
  key; a bad archive never lands under a conforming key, without any role holding
  `s3:DeleteObject`. `GetObject` is granted on the staging prefix only.
- **Grace-bounded stateful suppression** (SSM, 4-field value) fixes the
  permanent-silent-failure hole: an enqueue suppresses the coverage email for one
  grace period only, so a broken pipeline is reported rather than masked forever.
- **`maxAllowedLimit` stays 200** (not raised to the 1000 ceiling): the binding
  constraint is Contentful's 7 MiB response ceiling, whose remedy is to *lower*
  this. Adaptive halving to a floor of 50 handles size errors at runtime.
- **Replication and Object Lock are OFF-by-default opt-ins**, never required to
  deploy.
- **No current-version expiry** in the lifecycle (S3 has no "newest object"
  predicate; the newest archive must be retained unconditionally).

## Deferrals and residuals

- **Sizing/grace finals and the tags question** are set by the one-time
  commissioning export (task 14/15), not desk-decided.
- **Last-write-wins on the SSM store** (no compare-and-swap on the free tier): a
  lost sub-record can cause at most one extra email per re-notify interval —
  never silence. DynamoDB would give CAS at the cost of a resource this workload
  does not otherwise need; rejected.
- **npm audit residual**: the pinned deps carry transitive `@smithy` /
  `fast-xml-parser` advisories inside the AWS SDK. **RESOLVED.** The one CRITICAL
  was `fast-xml-parser` (GHSA-m7jm-9gc2-mpf2, a DOCTYPE-entity regex-injection
  encoding bypass, CVSS 9.3), transitive in `@aws-sdk/core`. It parsed only AWS
  API XML responses, never attacker-controlled input (this app reads Contentful
  JSON), so it was never reachable here — but it has now been cleared properly:
  the AWS SDK was bumped `3.709 → 3.1136`, which **drops the `fast-xml-parser`
  dependency entirely** (it no longer appears in any function's tree). All four
  manifests audit clean (0 vulnerabilities), the pipeline was re-tested and
  redeployed to prod, and the CI audit gate was **re-armed as a hard fail on
  CRITICAL** (it had been temporarily report-only while the advisory was
  unfixable). The weekly scheduled audit still surfaces any new advisory.
- **The SSE-header bucket policy** and **the induced-failure email matrix** are
  proven at deploy time (tasks 14/16), not by unit tests.
- Excluded by the owner: restore functionality, licence change, git branch
  protection (already in place), S3 access logging.
