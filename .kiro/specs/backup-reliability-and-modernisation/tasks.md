# Implementation Plan

Each task is one focused, independently verifiable unit, builds on the tasks before it, and carries its own verification. Every task is committed on the `feat/project-quality-overhaul` feature branch before the next begins, one commit per task, with a green build and full test suite (`node --test 'tests/**/*.test.js'`) as the gate — per the project's spec-task-commit and protected-branch conventions.

**Ordering is deliberate and load-bearing.** Four constraints the design and requirements impose, which a naive top-to-bottom order would violate:

- **The dependency change is atomic** (task 8). The runtime, `contentful-export` major, `archiver` replacement and streamed upload land in one commit, because the library needs the newer runtime and splitting them reds the suite between commits (criterion 57.9, and the design's closing note).
- **Queue timing lands with, not after, fail-loudly** (tasks 3–4 before 5). Until retention exceeds `visibility × maxReceiveCount`, a thrown failure is purged before redelivery and the dead-letter path — and every uncatchable-failure email — is unreachable. Making the Backup_Lambda throw (task 5) without the timing fix (task 3) would ship a half-working failure path.
- **Log groups migrate before the functions reference them** (task 2 before any function change), and `logs:CreateLogGroup` is removed in the same task that scopes the new grants, or a function locks itself out of its own logs.
- **The commissioning deployment is front-loaded** (task 14) because five design decisions are gated on it — the KMS grant, the sizing envelope, the tags question, the build durations, the `maxAllowedLimit` headroom — and only a real AWS deploy resolves them. Everything after task 14 consumes its measured outputs.

Tasks 1–7 are template and test-harness work that requires **no dependency change and no AWS**, so they are safe to land first and leave the suite green throughout. Task 8 is the atomic cutover. Tasks 9–13 are the code mechanisms. Task 14 commissions. Tasks 15–20 finalise, harden, and document.

---

## Phase 1 — Template and harness (no dependency change, no AWS)

- [x] **1. Shared test harness and template invariants.**
  - Extract the duplicated `require.cache` stubbing preamble into one shared test helper, and the duplicated `CFN_SCHEMA` YAML-parsing block into one shared module both infrastructure test files import.
  - Add a `cfn-lint` (and a policy scan — `cfn-guard` or `checkov`) npm script that runs against `infrastructure/template.yaml`.
  - Add template-invariant tests that the template declares no alarm, no composite alarm, no metric filter, no dashboard and no scheduled/time-based trigger, and that no source file publishes a custom metric — enforcing the no-standing-cost, no-quota observability decision structurally so it cannot erode.
  - _Requirements: 45.6, 44.1, 44.2, 11.1–11.7, 50.3, 50.4_

- [x] **2. Declare stack-managed log groups and cut the functions over.**
  - Add three `AWS::Logs::LogGroup` resources at stack-scoped names (`/aws/lambda/${AWS::StackName}/{backup,filter,notifier}`), `LogGroupClass: INFREQUENT_ACCESS`, `RetentionInDays` from a bounded `LogRetentionDays` parameter (default 90, `AllowedValues` from CloudWatch's accepted set), `DeletionPolicy: Retain`.
  - Set `LoggingConfig` (`LogFormat: JSON`, an `ApplicationLogLevel` parameter constrained so it cannot rise above `INFO`, `LogGroup` pointing at the new group) on every function, with `DependsOn` on its group.
  - Scope every `logs:CreateLogStream`/`logs:PutLogEvents` grant to the new group ARN and **remove `logs:CreateLogGroup`** from both existing roles.
  - Document the one residual manual step: the two orphaned implicit log groups must be deleted by hand.
  - _Requirements: 5.1–5.10, 40.1, 40.2, 54.12_

- [x] **3. Correct the queue timing chain and add the terminal queue.**
  - Set `SQSQueue` `VisibilityTimeout: 5400`, `MessageRetentionPeriod: 1209600`; `MaxReceiveCount` a bounded parameter (default 2). Add the inline comment recording the `Timeout → VisibilityTimeout → MessageRetentionPeriod` coupling.
  - Add `TerminalQueue` (FIFO, no consumer). Set the `DeadLetterQueue` `VisibilityTimeout: 60`, its own `RedrivePolicy` to `TerminalQueue` with `maxReceiveCount: 2`, and `RedriveAllowPolicy` naming `SQSQueue` (source ARN built with `!Sub`, not `!GetAtt`, to avoid the circular dependency).
  - Enable `SqsManagedSseEnabled` on all three queues; add a non-TLS-deny `AWS::SQS::QueuePolicy` per queue.
  - _Requirements: 3.1–3.6, 39.1–39.7_
  - _Verify: a test asserting `MessageRetentionPeriod ≥ 2 × VisibilityTimeout × MaxReceiveCount`, `VisibilityTimeout ≥ 6 × Backup Timeout`, and a policy on each of the three queues._

- [x] **4. Alert channel, fail-closed placeholder (except the Notifier), and gated mappings.**
  - Add the `AlertTopic` (standard SNS, SSE with at least the AWS-managed key), a validated `AlertEmail` parameter, and a `SubscribeAlertEmail`-gated email subscription so a validation stack can omit it; publish the topic ARN as an output. Enumerate its permitted publishers.
  - Change both existing functions' inline placeholder to `throw`. Add the `NotifierLambdaFunc` with a placeholder that **publishes** "code never applied" and does not throw.
  - Add an `EventSourceMappingEnabled` parameter (default `true`) gating **both** the source-queue mapping and the new DLQ→Notifier mapping (`BatchSize: 1`).
  - _Requirements: 4.1–4.6, 6.1–6.8, 7.4, 7.5, 7.6_
  - _Verify: a template test asserting the DLQ→Notifier mapping exists, both mappings honour the parameter, and the subscription is condition-gated._

- [x] **5. Backup_Lambda: throw on every failure path.**
  - Remove `sendResponse` from all failure paths (retain only on success or delete it); `throw`, never return, on any failure. Remove the unreachable `$metadata.httpStatusCode` branches. Log message and stack before propagating; never return the raw error object.
  - Publish to the Alert_Topic before rethrowing **only when `ApproximateReceiveCount == 1`**.
  - _Requirements: 1.1–1.5, 7.1, 7.2, 7.3, 0.2, 46.1–46.10_
  - _Verify: `assert.rejects` on upload failure, export failure, parameter failure; a test that a publish happens once on first delivery and not on redelivery, and none on success._

- [x] **6. Backup_Lambda: message lifecycle and event-envelope validation.**
  - Remove `deleteMessageAsync` and its call; drop `sqs:DeleteMessage`/`ReceiveMessage`/`GetQueueAttributes` from the role's *code use* while **retaining** them as the ESM's poll grant (with the comment and the presence test). Drop all DLQ grants from the Backup role.
  - Validate the event envelope in all three functions (zero records → throw; unrecognised record body → fail open, no email; guard nested paths).
  - _Requirements: 2.1–2.5, 22.1–22.7_
  - _Verify: a test asserting the three SQS actions are present and scoped to the source queue; envelope-validation tests per function._

- [x] **7. Repair the vacuous tests and widen the generators.**
  - Replace the four source-text-grep assertions in `tests/deploy/build-script.unit.test.js` and the completed-migration assertions with behavioural tests; repair the shadowed-poison prototype test; replace the tautological response-shape test; use or remove the dead `collectStrings`.
  - Widen the date/dictionary generators to include invalid dates, empty objects, absent fields, nulls and non-objects; make oracles assert `Number.isFinite`; correct `getConfig` to an own-property check and stop excluding inherited names; restore `globalThis.fetch` in teardown.
  - _Requirements: 45.1–45.5, 48.1–48.6, 49.1–49.6_

---

## Phase 2 — The atomic dependency change

- [x] **8. Runtime, export library, archive library, and SDK — one commit.**
  - Confirm the resolved `contentful-export` 8.x version against npm; confirm it ships CJS (verified in design — no ESM conversion needed). Set both functions to `nodejs24.x` (arm64 kept).
  - Replace `adm-zip` with `archiver`; declare `@aws-sdk/client-s3`, `-sqs`, `-ssm`, `-sns`, `@aws-sdk/lib-storage`, `contentful-export`, `archiver` as pinned dependencies in each Lambda's `package.json`; reconcile the `filter-lambda` manifest/lock.
  - Add `.nvmrc` (`24`) and `engines` to all four manifests; switch documented and scripted installs to `npm ci`.
  - Record the design-obligation facts (runtime deprecation dates and why the update block is operative; why 24 over 22 — noting 26 is preview; whether the major changes request count).
  - _Requirements: 23.1–23.7, 24.1–24.6, 25.1–25.4, 26.1–26.5, 27.1–27.4, 55.1–55.8_
  - _Verify: the full suite passes on Node 24 in one commit; `npm audit --omit=dev` counts recorded._

---

## Phase 3 — Code mechanisms

- [x] **9. Filter_Lambda: fail open, robust HTTP, two endpoints, structured status/branch.**
  - Fail open on any unusable last-update response (empty object, missing `lastUpdatedAt`, unparseable date, non-object, error envelope, absent/non-numeric window); collect all valid timestamps and take the **max across both** `LastUpdateUrl` parameters; no truthiness test for an established timestamp; stale-payload guard (payload older than the notifying build → stale, fail open).
  - Explicit `connectionTimeout`/`requestTimeout`/`maxAttempts: 2` on all AWS clients; `AbortSignal` timeout + status check + shape validation + bounded retries on the fetch; an overall handler deadline that **returns** (fail open, no email) on exhaustion.
  - Anchored regex with a capture group for build status (fail open on no match); branch from the sanitised leftmost DNS label against a `TargetBranch` parameter (no enqueue on mismatch; Coverage_Check still runs); `MessageDeduplicationId` derived from content state, constant `MessageGroupId`.
  - _Requirements: 18.1–18.11, 19.1–19.6, 20.1–20.7, 21.1–21.10, 22.x_
  - _Verify: tests for every unusable response; anchored-regex against the committed Amplify fixture; a slow-endpoint test asserting fail-open-by-return, not timeout._

- [x] **10. The Coverage_Check as a pure function, plus the SSM suppression store.**
  - Implement the comparison as a pure function returning both the enqueue and the coverage decisions, taking `(contentTs, archiveOutcome, now, grace, skew, statusCaptured, branchMatches, storeState)`. Three outcomes; `Number.isFinite` guard; minimum-size filter; skew applied identically to enqueue and coverage.
  - Add `SuppressionParameter` (SSM standard); grace-bounded stateful suppression (`{notifiedContentChange, notifiedAt, enqueuedContentChange, enqueuedAt}`); record enqueue on enqueue; swallow a post-publish `PutParameter` failure; treat an initial/unparseable value as "no suppression".
  - Grant the Filter `s3:ListBucket` (not `ListBucketVersions`), `ssm:GetParameter`/`PutParameter` on the one ARN, `sns:Publish` + `kms:ViaService`-scoped KMS, `lambda:InvokeFunction` on the Notifier.
  - _Requirements: 9.1–9.21, 40.6_
  - _Verify: Requirement 47's tests (all three outcomes, quiet-space silence, empty-bucket notify, enqueue-within-grace vs older-than-grace, unparseable key); the criterion 49.5 property test over full timestamp ordering._

- [ ] **11. Notifier_Lambda: real code, both envelope shapes, content contract.**
  - Discriminate the SQS-batch shape (DLQ) from the async-invocation-record shape (Filter `OnFailure`); log the full failed body; publish a formatted notification with the content contract (failing phase where knowable, UTC timestamp, space/environment, error, and a Logs Insights query over the correlating `messageId` — avoiding the IA-unsupported commands); never call Contentful, never trigger a backup; validate its envelope without leaving a failure unreported.
  - Have the Backup_Lambda log `messageId` and phase as structured fields so the query has a field to filter on.
  - _Requirements: 7.4–7.14, 8.1–8.8, 17.1–17.6_
  - _Verify: tests driving both envelope shapes from committed fixtures; a test that a Notifier failure moves to the terminal queue rather than blocking._

- [ ] **12. Backup_Lambda: working directory, export config, asset reconciliation.**
  - Per-invocation working dir with an injectable root; sweep-on-entry; archive written outside the archived tree.
  - Remove `includeDrafts` (both tokens supplied, fail-fast on either missing); `includeExperienceOrchestration: false`; `useVerboseRenderer: true`; `maxAllowedLimit` a parameter (default 200, ceiling 1000) with adaptive halving to 50 on a response-size error; validate tokens before the export.
  - Asset reconciliation by **size against `details.size`** (not existence); rate-limit shortfall notifies without throwing and records `complete: false`, any other shortfall throws; manifest with the fixed content-file name and per-entity counts.
  - _Requirements: 12.1–12.8, 13.1–13.7, 14.1–14.11, 15.1–15.8, 16.3, 17.x_
  - _Verify: the twice-against-one-scratch-dir test (exactly one export in the second archive); a fixture export tree with a missing and a wrong-size asset._

- [ ] **13. Backup_Lambda: streamed staging upload, verify, promote.**
  - Stream `archiver` → `lib-storage` `Upload` → staging prefix; drop the export result before archiving; in-invocation upload retry re-creating the stream; verify the staged object by `ListObjectsV2` on the exact key (present, size); `CopyObject` to the final key; leave staged objects to a short-TTL lifecycle rule.
  - Grant `s3:PutObject`, `s3:AbortMultipartUpload`, `s3:ListBucket`, `s3:GetObject` on the **staging prefix only**; no `GetObject` on the archive prefix.
  - _Requirements: 13.4, 13.5, 16.1–16.9_
  - _Verify: `assert.rejects` on verification failure; a test that no role holds `s3:GetObject`/`GetObjectVersion` on the archive prefix._

---

## Phase 4 — Commission, then finalise

- [ ] **14. First deployment and the one-time commissioning export.**
  - Deploy the stack with `EventSourceMappingEnabled: false` and interim `MemorySize`/`EphemeralStorageSize` (**1536**/2048 — 1536, not 1024, because the largest current backup already consumes ~950 MB and 1024 would OOM on the first run). Confirm the email subscription; run the KMS smoke-test publication **from each of the three roles**; enable the mappings.
  - Run the single commissioning export through the queue. Record under `docs/`: the size/duration envelope **with actual peak memory and duration flagged against ~70% of Lambda's 10240 MB / 900 s ceilings**, each site's build duration, the largest `maxAllowedLimit` that succeeds (one adaptive run), and whether tags survive the published-state switch. Assert the function runs on arm64.
  - _Requirements: 0.7, 10.1–10.10, 16.11, 16.12, 34.8_
  - _Verify: all of Requirement 10 (each induced failure emails; success and no-backup-needed produce no email); results committed under `docs/`._

- [ ] **15. Finalise the sizing and the tags decision (second stack update).**
  - Set `MemorySize`/`EphemeralStorageSize` from the measured envelope; set the grace period from the measured build durations; decide the `maxAllowedLimit` default and the tags/published-state question from the commissioning record, amending the design decision record if tags are dropped.
  - _Requirements: 14.x (tags), 16.5, 16.6, 42.7_

- [ ] **16. S3 lifecycle, bucket policy, and conditional durability features.**
  - Lifecycle: **no current-version expiry**; `NoncurrentVersionExpiration` bounded ≥ ~150 days against the transition; `ExpiredObjectDeleteMarker`; `AbortIncompleteMultipartUpload` (1 day); short-TTL expiry on the staging prefix; transition at `TransitionDays` (default 60) to `LongTermStorageClass`.
  - `UpdateReplacePolicy: Retain` on the bucket; `OwnershipControls: BucketOwnerEnforced`; the TLS-and-SSE-header bucket policy (mismatch test, proven against a real multipart upload); **no** access logging.
  - Condition-gated replication and Object Lock, `!Ref AWS::NoValue` when off, every supporting parameter defaulted and every supporting resource gated; Object Lock retention bounded against the noncurrent retention.
  - _Requirements: 34.1–34.11, 35.1–35.5, 36.1–36.18, 37.1–37.8, 38.1–38.7_
  - _Verify: tests for noncurrent expiry, no current-version expiry, the required-parameter set excluding both features' params, and no `LoggingConfiguration` / no second bucket._

- [ ] **17. Multi-environment: remove fixed physical names; outputs; tags.**
  - Remove `RoleName` from both roles; derive queue names from the stack (FIFO suffix, ≤80 chars); publish outputs for the bucket, all three queues, all three function names, the Alert_Topic; document stack-level cost-allocation tags.
  - _Requirements: 41.1–41.6, 43.1–43.4_
  - _Verify: the property test widened to all physical names, including via a parameter default._

- [ ] **18. Deployment script: reproducible, gated, traceable.**
  - Allow-list packaging; refuse on dirty tree, absent `node_modules`, or a matched credential file; `npm ci --omit=dev`; validate every env var with a named message; explicit region; `Publish: true`; record the commit as a function **tag**; prune to 3 published versions; read function names from stack outputs; a placeholder-SHA verification command; sweep the identical dead status-code branch in `build-lambda.js`.
  - _Requirements: 29.1–29.8, 30.1–30.4, 31.1–31.7, 32.1–32.4_

- [ ] **19. CI, dependency surveillance, and executable deployment docs.**
  - A CI workflow (push + PR) that runs `npm ci`, the full suite, the linters, `cfn-lint`/policy scan, and `npm audit --omit=dev` at a documented threshold — no deploy, no long-lived credentials, no Contentful call, on Node 24; scheduled audit re-run; Dependabot across all four manifests (`@aws-sdk` grouped, `contentful-export` ungrouped).
  - Rewrite the deployment docs to be executable as written (literal command with `--capabilities CAPABILITY_NAMED_IAM`, region, profile, template path; every parameter documented; the ordered two-pass deployment and the subscription-confirmation gate).
  - _Requirements: 28.1–28.7, 33.1–33.6, 44.3, 53.1–53.6_
  - _Verify: a doc test asserting the documented parameter list matches the template exactly, and that no doc references the former template location._

- [ ] **20. Documentation, decision record, changelog, contract fixtures, efficacy.**
  - Root and per-function READMEs corrected (structure, architecture including both new paths, the notification philosophy, the Last_Update_API contract, the S3 key format and archive layout); the Notifier README; the decision record capturing every deferral and the corrected-claims list; changelog; `.editorconfig`; `.gitignore` fixes (stale `/test`, `.kiro` tracking, `.env.example` negation).
  - Commit the four contract fixtures (Amplify notification, SQS FIFO record, Last_Update_API response, S3 listing, and the async invocation record); add coverage measurement (`node --test --experimental-test-coverage`) and a one-time mutation pass recorded under `docs/`.
  - _Requirements: 50.1–50.11, 51.1–51.6, 52.1–52.4, 54.1–54.12, 55.5, 56.1–56.7, 57.x_

---

## Note on the atomic constraint

Tasks 5, 6, 9, 12 and 13 change function *code* that runs on the *old* runtime and old libraries until task 8. This is intentional and safe: those tasks are exercised by the unit tests (which run on the local Node 24 already) and are not deployed until task 14. Task 8 is the single commit where the deployed runtime and the bundled libraries move together. No task between 1 and 13 deploys, so the "system must remain able to produce a backup" constraint (criterion 57.11) is satisfied by the *repository* staying green, not by each commit being independently deployable — which is the reading criterion 57.11 was reconciled to.
