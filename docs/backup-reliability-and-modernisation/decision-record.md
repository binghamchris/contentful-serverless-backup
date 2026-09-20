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
  `fast-xml-parser` advisories inside the AWS SDK (fewer *highs* than the old
  deps). Addressable by an SDK minor bump; CI fails only on CRITICAL.
- **The SSE-header bucket policy** and **the induced-failure email matrix** are
  proven at deploy time (tasks 14/16), not by unit tests.
- Excluded by the owner: restore functionality, licence change, git branch
  protection (already in place), S3 access logging.
