I'll read the design document and requirements to audit for internal consistency.## Audit: pass 5 vs passes 1–4 and the requirements

Verdict up front: **pass 5's supersession clause resolves almost none of these.** It says "supersedes the earlier passes wherever they conflict" — which (a) does not reach `requirements.md` at all, (b) does not help where pass 5 contradicts *itself*, and (c) does not help a task-writer who reads only the section that covers their task. Passes 1–4 are written as settled prose with reasoning attached, so a task-writer reading pass 2's suppression section finds an argument *for* the rule pass 5.1 deletes, with no marker that it is dead.

Twelve live items, ordered by how badly a task-writer can get it wrong. Two are critical because supersession genuinely cannot resolve them.

---

### A. CRITICAL — `requirements.md` was never updated, but pass 5 claims it was

Pass 5.1 states: *"This became **Requirement 9's** governing correction and the requirements are updated to match: criterion 9.10 now reads as time-bounded suppression, and the 'what no path covers' section (criterion 11.12) no longer claims the enqueue path is safe."*

Neither is true. `/Users/chrisbingham/Documents/GitHub/contentful-serverless-backup/.kiro/specs/backup-reliability-and-modernisation/requirements.md` still reads, verbatim:

> 9.10. IF this invocation enqueues a backup for the content state under comparison, THEN NO coverage-gap notification SHALL be published for that state, **because the same invocation is closing the gap**.

And criterion 47.7 still mandates a *test* of the unconditional rule:

> 47.7. A test SHALL assert that an invocation which enqueues a backup for the content state under comparison publishes NO coverage-gap notification for that state, per criterion 9.10.

No pass-5 concept appears anywhere in `requirements.md` — I grepped for `.partial.zip`, `enqueuedAt`, "maximum across", `CRC64`, `includeExperienceOrchestration`, "150 day": zero hits. The pass-5 commit (`1368090`) touched the design only.

This is the finding that matters most, because **a task-writer normally treats `requirements.md` as authoritative over `design.md`**. Pass 5's clause supersedes *earlier passes*; it claims no authority over the requirements, and asserts falsely that they already agree. Under 5.1, a build whose enqueue record is older than the grace period both enqueues *and* notifies — which directly fails criterion 47.7's test and violates 9.10 as written. Six requirement criteria are affected: 4.1, 4.2, 9.10, 13.4, 34.9/34.10 (with 42.9), 47.7.

**Recommendation:** amend `requirements.md` for real, or add an explicit precedence banner at the top of pass 5 stating which requirement criteria it overrides pending amendment. Without one of those, tasks.md will be written against the requirements and silently reimplement the permanent-silent-failure defect pass 5 exists to close.

---

### B. CRITICAL — pass 5 contradicts itself on lifecycle (5.5 vs 5.11)

5.5: *"THE lifecycle configuration SHALL NOT expire current object versions at all."*

5.11: *"`BackupRetentionDays` SHALL be bounded so no permitted value places an object in Glacier Flexible Retrieval for less than its 90-day minimum given the 60-day transition — i.e. a minimum retention of ~150 days."*

If current versions are never expired, `BackupRetentionDays` expires nothing, no object ever leaves Glacier, the 90-day minimum is satisfied by construction, and the ~150-day bound is meaningless. If it *does* expire something, 5.5 is wrong. Pass 4 declares `BackupRetentionDays` and `NoncurrentVersionRetentionDays` as separate parameters (line 503), so 5.11 cannot be read as quietly meaning the noncurrent one.

Supersession cannot resolve this: both statements are in pass 5. A task-writer must guess whether `BackupRetentionDays` still exists, and if so what it governs.

**Recommendation:** decide explicitly. Either delete `BackupRetentionDays` and move the ~150-day Glacier bound onto `NoncurrentVersionRetentionDays`, or state that current versions *are* expired at `BackupRetentionDays` and withdraw 5.5. This also has to be reconciled with requirement 34.6, which demands a test asserting the minimum-duration property "across the whole permitted parameter domain" — untestable while the domain is undefined.

---

### 1. Suppression — pass 2 still argues for the rule pass 5.1 deletes

**Pass 2 stands entirely unamended.** Line 265 lists the notify condition as: *"this invocation is **not** enqueueing a backup for this same content state"* — instantaneous, no grace bound. Worse, line 270 *defends* it at length: *"The third condition is the one the earlier draft forbade… The criterion now requires the check to run regardless, which was its real intent, while permitting the one correlation that keeps the guarantee true."* And the test surface at line 317 closes with: *"an invocation that enqueues must not also notify."*

Against 5.1: *"THE coverage-gap notification is suppressed for a content state ONLY IF an enqueue for that same state was recorded within the grace period… an enqueue buys silence for one grace period, not forever."*

A task-writer reading pass 2 in isolation gets a coherent, well-argued, wrong spec — including a test assertion that fails under 5.1.

**Value shape is stated two ways, and the field names differ** (not just the field count):

| Source | Value |
|---|---|
| Pass 2, line 281 | `{ "lastNotifiedContentChange": …, "lastNotifiedAt": … }` |
| Pass 5.1 | `{ notifiedContentChange, notifiedAt, enqueuedContentChange, enqueuedAt }` |

An implementer picking pass 2's JSON gets keys that pass 5's rule cannot read. Pass 5 does not say pass 2's block is superseded, and does not restate the JSON as a literal.

**Two consequential knock-ons pass 5 never revisits:**

- Pass 2's cost table (line 307) says SSM `PutParameter` happens *"only when notifying"*. Under 5.1 it also happens on **every enqueue**. Cost is unaffected (standard throughput is free) but the sentence is now false, and the write frequency changes by orders of magnitude.
- Pass 2 line ~286 argues: *"Concurrency is last-write-wins: two frontends building at the same time write near-identical values, so the race is benign and needs no conditional write."* That argument held when the value was one record written by one code path. Under 5.1 the value holds **two independent sub-records written by different paths** — so two sites building simultaneously can have the notify-path write clobber a fresh `enqueuedAt` (⇒ spurious gap email) or the enqueue-path write clobber `notifiedAt` (⇒ duplicate email, breaching 9.16's repeat-suppression). The "benign race" conclusion does not survive 5.1 and pass 5 does not re-derive it.

**Recommendation:** rewrite pass 2's bullet 265, the paragraph at 270, the JSON at 281, the cost row at 307 and the test line at 317 in place; and add a sentence to 5.1 either justifying last-write-wins for a four-field value or requiring a conditional/read-modify-write.

---

### 2. Lifecycle — the pass 4 cost table and framing still describe the superseded design

Pass 4 cost table, lines 633–634:

| Item | Volume |
|---|---|
| S3 archive storage, Standard | **first 60 days** |
| S3 archive storage, Glacier Flexible | **days 60 → retention** |

"days 60 → retention" presupposes a retention terminus for current versions — the thing 5.5 removes. The 60-day transition day is stated as a fact here, while 5.11 makes it a *parameter* ("The transition day and `LongTermStorageClass` become the parameters the cost table already assumes") that pass 4's parameter list (line 503) does not declare.

Pass 4's closing cost paragraph is also stale in framing: *"Archive storage is the one that grows, and Requirement 34 is what makes it bounded… Adding noncurrent-version expiry converts an unbounded liability into a bounded one."* That happens to remain true (5.5 keeps noncurrent expiry), but it sits next to requirement 34's title — "Lifecycle Configuration Shall **Actually Expire Data**" — and 34.9's mandate that *"the retention parameter SHALL declare a minimum no shorter than the longest quiet interval the design records, and the configuration SHALL retain the newest archive unconditionally"*, with 34.10 requiring a test of both and 42.9 requiring the parameter to declare "the minimum required by criterion 34.9".

5.5 says *"criterion 34.9 is amended: the retention minimum is no longer the mitigation."* The requirement is not amended, so 42.9 and 34.10 still point at a minimum whose basis pass 5 removed — while 5.11 introduces a *different* minimum (~150 days) for a different reason. Two live minima, one parameter.

**Recommendation:** edit lines 633–634 to the parameterised form, add the transition-day and `LongTermStorageClass` parameters to line 503, and resolve which minimum 42.9 refers to once item B is settled.

---

### 3. Key format — the regex is already correct; the *outcome contract* is not

Good news on the narrow question: I executed pass 2's pattern against both key forms.

```
2026/09/19/2026-09-19_14-06-01.123Z.zip          → true
2026/09/19/2026-09-19_14-06-01.123Z.partial.zip  → false
```

The `\.zip$` anchor already excludes `.partial.zip`, so 5.2's exclusion works without a regex change. **But nothing in the document says so**, which is its own hazard: a task-writer told "add a `.partial.zip` exclusion" may edit a regex that is already right, and the plausible naive edit (`\.zip$` → `\.zip`) would break the anchoring that pass 2 spends a paragraph defending (*"The anchored pattern is not decoration"*).

The real contradiction is the surrounding code block (lines 176–196), which pass 5 leaves untouched while adding two requirements it fails:

- **5.2** requires *"`Size` above a documented floor from the listing"*. `newestArchive` never reads `Size`, and its return shape is `{ state: 'found', at, key }` — no size field, so the pure comparison function cannot apply the floor.
- **5.4** requires a key that *"matches the pattern but does not parse to a valid date"* to be treated as `indeterminate`. Line 194 returns `found` unconditionally: `return { state: 'found', at: timestampFromKey(newestKey), key: newestKey };` — with no `Number.isFinite` guard, which is precisely the `NaN < contentTs === false` silent-failure 5.4 identifies.

**Recommendation:** add one sentence to 5.2 stating the existing anchored pattern already excludes `.partial.zip` and must not be relaxed (plus a unit test asserting it), and replace pass 2's code block with one that carries `Size` and returns `indeterminate` on an unparseable timestamp. The block is the artefact an implementer will copy.

---

### 4. Content timestamp — pass 2's single endpoint is stated three times, unqualified

| Location | Text |
|---|---|
| Line 155 | *"The content timestamp comes from the Last_Update_API, which the filter already fetches. The archive timestamp comes from one S3 listing, **which is the only new call**."* |
| Line 229 | *"4. Fetch the Last_Update_API. Timeout, retries, status check, shape validation."* |
| Line 241 | *"The Last_Update_API URL is a **fixed template parameter**… So the filter always reads **the same endpoint — production's** — no matter which branch's build triggered the invocation."* |

5.3: *"THE Filter SHALL read the last-update timestamp as the **maximum across both consuming sites'** endpoints, from two template parameters."*

Line 241 is the dangerous one, because 5.3 explicitly *endorses* half of it (*"This preserves the deliberate decision that the URL is a fixed parameter rather than derived from the notification"*) while overturning the other half. A task-writer who reads line 241 as still-live — reasonable, since 5.3 cites it approvingly — implements one endpoint. Line 155's "the only new call" is now wrong by one fetch.

Pass 2's enqueue table also has no row for 5.3's new state: *"WHERE a payload carries its own build or publish timestamp older than the notifying build's start, the Filter SHALL treat it as stale, log it, and fail open on the enqueue side."* The table's "unusable" column is not the same condition as "parseable but stale".

**Filter time budget — pass 4 and 5.9 disagree on the input.** Pass 4 line 669: *"the filter now performs, in sequence: **an HTTP fetch** with a bounded timeout, up to two retries with backoff, one S3 listing, one SSM read, and possibly one SNS publish and one SSM write"* — and the invariant *"total time spent on Last_Update_API requests including all retries and backoff shall not exceed half the function timeout."*

5.9 reprices it: *"a cold start with four SDK clients, a fetch with retries against **two** endpoints (5.3), an S3 listing, an SSM read, and possibly a publish and an SSM write, in 30 s"*, splitting the fetch half two ways (*"per endpoint ≈ 3 s × 2 attempts + short backoff"*) and adding three things pass 4 omits: explicit `connectionTimeout`/`requestTimeout`/`maxAttempts: 2` on all AWS clients, an overall handler deadline, and fail-open-by-**return** on exhaustion.

The invariant itself is unchanged (still half the timeout), and both agree on 30 s. So the contradiction is in the *sequence description*, not the arithmetic — but pass 4's sequence is what a task-writer would size against.

**Recommendation:** amend lines 155, 229 and 241 to two endpoints, add the stale-payload row to pass 2's enqueue table, and replace pass 4's sequence sentence at 669 with a pointer to 5.9.

---

### 5. Numbers — one arithmetic error survives, and the cost table's headline figure is wrong

**The "four emails" / `maxReceiveCount 2` arithmetic is NOT fixed.** Pass 1 line 92:

> *"a naive publish-on-every-catch would email once per attempt and then once more from the Notifier — **four emails** for one broken backup."*

With 5.6 setting `maxReceiveCount: 2`, the arithmetic is 2 attempts + 1 Notifier = **three** emails. Four requires `maxReceiveCount: 3`. Earlier audit finding C4 is unaddressed — pass 5 never mentions it, so nothing supersedes line 92. It is only motivational prose (the `ApproximateReceiveCount == 1` gate is correct either way), but it is the sort of stated figure a task-writer copies into a test name or a doc, and it now contradicts a concrete pass-5 value.

**The cost table's SQS line and its total are both superseded.** Line 628: `| SQS FIFO requests | $0.50 / million | ESM polling — see below | **$0.00** *(free tier)* |`, and line 636: `| **Total new recurring, at rest** | | | **$0.00** |`. The supporting paragraph says *"roughly **260,000** FIFO requests/month… against a perpetual free tier of 1 million."*

5.11: *"An event source mapping runs 2–5 pollers, not one, so two enabled mappings are **0.5 M–1.3 M requests/month**… the pair may sit just above it, exposure under $0.20/month. The cost table drops the unconditional '$0.00 at rest' for a '≤ ~$0.20/month, to confirm against the first bill' line, and the customer-managed-key contingency ($1/month if the AWS-managed key path fails) is added to the table."*

5.11 says the table *"drops"* and *"adds"* — past tense, describing an edit that was never made. The table still shows `$0.00` twice and the 260,000 estimate, and has no CMK row. A task-writer building the cost-table artefact required by criterion 57.5 will reproduce the wrong figures, and the *zero-at-rest claim itself* (a headline property in the Overview, "Recurring AWS cost is zero at rest") is now conditional in a way the document does not reflect.

**Everything else in 5.6 checks out against the earlier passes and the requirements.** I verified each coupling:

| Value | Check |
|---|---|
| VisibilityTimeout 5400 s | = 6 × 900. Satisfies requirement 3.3 ("at least six times the Backup_Lambda `Timeout`") exactly ✓ |
| Retention 1209600 s (14 d) | Requirement 3.1 floor is 2 × 5400 × 2 = 21600 s (6 h). 14 d clears it with the margin 5.7 argues for ✓ |
| Worst-case latency ~3 h | 2 × 5400 s = 10800 s ✓ consistent with 5.6's own claim and requirement 3.7 |
| `MAX_PAGES` 5 | matches pass 2 line 176 ✓ |
| `maxAllowedLimit` 200 / 1000 / floor 50 | pass 3 says "down to a floor" without naming it; 5.6 names 50 — an addition, not a conflict ✓ |
| Filter/Notifier `Timeout` 30 s | pass 4 line 671 calls 30 s "the value to validate"; 5.6 fixes it. Compatible ✓ |
| Log retention 90 d | requirement 5.2 mandates a parameter with a documented default, no value ✓ |
| Published-version retention 3 | pass 4 says "a documented count" ✓ |
| Memory 450 → interim 1024 | pass 3 line ~469 describes 450 as the *current unjustified* value, not a spec value ✓ |

One soft gap: pass 3's sizing section derives `MemorySize`/`EphemeralStorageSize` from the commissioning export with no interim, which is circular (the export needs a deployed function). 5.6/5.13 fix it with a two-pass deployment. Pass 3 doesn't contradict that, but read alone it blocks the first deploy. A pointer from pass 3 to 5.13 would close it.

**Recommendation:** fix line 92 to "three emails", and actually apply 5.11's two table edits (SQS row → `≤ ~$0.20/month, confirm against first bill`; new CMK contingency row; adjust the total row and the 260,000 estimate).

---

### 6. Checksum — pass 3 still asserts the wrong reason, and so does a requirement `SHALL`

Pass 3 line 438:

> *"**On the checksum.** A multipart upload's stored checksum is a composite of part digests, not a digest of the whole object, so it cannot be compared against a locally computed whole-file hash."*

5.11: *"S3 does support a whole-object checksum on a multipart upload (CRC64NVME, the default), so the earlier 'composite, cannot compare' reasoning is **wrong**. Verification stays existence-and-size for a different reason: reading the stored checksum back needs a `GetObject`-family permission criterion 40.9 withholds."*

Same conclusion, different reason — which matters, because the reasons have different futures. Pass 3's reason is permanent (a composite digest can never be compared); pass 5's is a policy choice (grant `GetObject` and comparison becomes possible). A task-writer documenting the decision will document a false technical fact.

**And requirement 13.4 mandates writing the false claim down:**

> 13.4. …WHERE the upload is multipart, **the design SHALL record that the stored checksum is a composite of part checksums rather than a whole-object digest**, and the Backup_Manifest SHALL NOT claim otherwise.

That is a live `SHALL` instructing the implementer to record something pass 5 says is untrue. The second half (manifest claims no digest) survives; the first half must be amended.

**Recommendation:** replace pass 3 line 438 with 5.11's reason, and amend requirement 13.4's first clause.

---

### 7. Notifier placeholder — the general rule is unqualified in both documents

Pass 4 line 615: *"**The placeholder now throws.** A first deployment is therefore performed with `EventSourceMappingEnabled: false`… That single character change converts the worst failure mode in the old system into the most visible one."* No carve-out.

5.8: *"THE Notifier placeholder SHALL **publish** 'Notifier code was never applied', not throw… **This is the one placeholder that fails open.**"*

More seriously, requirement 4 is titled **"Placeholder Code Shall Fail Closed"** and criterion 4.1 reads:

> 4.1. THE Placeholder_Handler in the CloudFormation_Template SHALL throw an error identifying itself as undeployed placeholder code, **for every function it is used for**.

with 4.2 adding *"SHALL NOT return a value that Lambda or an Event_Source_Mapping would interpret as success."* A publishing Notifier placeholder violates both, literally and by the requirement's title. This is the clearest case where a task-writer following `requirements.md` implements the opposite of pass 5 — and the consequence is exactly the silence 5.8 exists to prevent, since on a first deployment all three functions are placeholders simultaneously.

**Recommendation:** qualify pass 4 line 615 in place ("…throws, with one exception: see 5.8"), and amend requirement 4.1 to carve out the Notifier. Note 5.8 also leaves a genuine choice open — *"gated by the same `EventSourceMappingEnabled` parameter as the backup mapping, **or a companion parameter**"* — which a task-writer must decide; pick one.

---

### 8. Diagram, Notifier count, and the resource/parameter tables

**The diagram is uncorrected.** Line 64 still reads `R -. cannot process .-> T[Terminal_Queue]`, exactly the edge 5.11 calls wrong: *"The flow diagram's `Notifier → Terminal_Queue` edge is wrong — SQS moves the message via the DLQ's redrive policy; the Notifier holds no `sqs:SendMessage`."* The components table at line 27 reinforces it in prose: *"`Terminal_Queue` — Catches messages the Notifier_Lambda itself cannot process"* (ambiguous rather than wrong, but it reads as an action by the Notifier). This one matters concretely: the diagram is the artefact someone consults when writing the IAM task, and it implies a `sqs:SendMessage` grant that requirement 40.7 forbids.

**"Two cases" vs "three failure classes", with the third never named.** Line 23: *"`Notifier_Lambda` — Formats and publishes failure notifications for **the two cases** the Backup_Lambda cannot report itself."* 5.11: *"The Notifier covers **three** failure classes plus the async path, not 'two'."* Pass 1's own topology table (lines 85–90) lists only two Notifier rows: DLQ arrival and Filter async exhaustion. 5.11 does not enumerate the third — the placeholder-publish path of 5.8 is the likely candidate, but that is inference. A task-writer cannot derive "three" from either document.

**Resources and parameters pass 5 adds that pass 4's tables do not list.** On the specific hypothesis in the brief: I found **no queue policies** anywhere in pass 5, nor in `requirements.md` (no `QueuePolicy`, no `aws:SecureTransport` on queues — requirement 37's TLS policy is the *bucket* policy, and requirement 39.1 uses SQS-managed SSE precisely to avoid key grants). So "two more queue policies" is not borne out. What pass 5 *does* add, absent from pass 4's table (lines 490–501) and parameter list (line 503):

| Added by | Item | In pass 4? |
|---|---|---|
| 5.8 | DLQ event source mapping as a discretely gated resource (+ possible companion parameter) | Only as a sub-clause of the `DeadLetterQueue` row; the backup ESM isn't a row either |
| 5.11 | `AbortIncompleteMultipartUpload` one-day lifecycle rule | No (requirement 34.3 has it; pass 4's lifecycle description does not) |
| 5.11 | `LongTermStorageClass` parameter, transition-day parameter | **No** |
| 5.11 | Customer-managed-key contingency as a cost-table line | **No** |
| 5.3 | Second Last_Update_API URL parameter | **No** |
| 5.6 | `maxAllowedLimit` parameter; `maxReceiveCount` parameters for both queues (requirement 3.2 demands bounded) | **No** |
| 5.2 | Coverage-check `Size` floor (parameter or documented constant — unstated which) | **No** |
| 5.6 | Backup `Timeout`/`MemorySize`/`EphemeralStorageSize` — parameters or literals? 5.6's "a second stack update sets the final" implies parameters, but then requirement 42 demands bounds and defaults for each | Unstated in both |

**Recommendation:** rebuild pass 4's resource and parameter tables as the single authoritative inventory, or add a "resources and parameters pass 5 adds" subsection to 5.11 in the same table shape. Correct the mermaid edge to `Q -. redrive .-> T` and reword line 27. Enumerate the Notifier's third failure class or revert to "two".

---

### Additional: stale cross-references pass 5 says it fixed but did not

5.11 lists five citation corrections. Checking each against the live text:

| Correction | Status |
|---|---|
| KMS deferral → 42.13 | **Stale.** Pass 1 line 115 still cites `criterion 42.10`. (42.10 is the storage-class enumeration; 42.13 is the CMK deferral.) |
| Object Lock test → 36.15 | **Stale.** Pass 4 line 572 still cites `criterion 36.9`. (36.9 tests the default-disabled parameters; 36.15 tests the retention constraint.) |
| `s3:GetObject` prohibition → 40.9 | Design is already correct (lines 292, 436). **But `requirements.md` criterion 13.5 still cites `40.8`.** |
| Notification content contract → 7.11 | Design already correct (lines 98, 540). **But `requirements.md` criterion 17.3 still cites `7.9`.** |
| Commissioning export → 16.12 not 16.9 | **Ambiguous and hazardous.** Pass 4 line 669 cites 16.9 for the *Filter time budget*, where 16.9 is correct. The wrong citation is in `requirements.md` criterion 0.7 ("authorised by criterion 16.9"), which should be 16.12 — and 16.12 points back at 0.7, so the pair is currently circular. 5.11 names no location, so a task-writer "applying the fix" could corrupt the one correct use. |

**Recommendation:** apply the two design edits (lines 115, 572), apply the two requirements edits (13.5, 17.3), fix the 0.7 ↔ 16.12 circularity, and rewrite 5.11's cross-reference bullet to name file and line for each so it cannot be misapplied.

---

### What would make tasks.md writable without holding five passes in mind

Ranked by cost-to-benefit:

1. **Amend `requirements.md`** for 4.1/4.2, 9.10, 13.4, 34.9/34.10, 42.9, 47.7 — or add an explicit override table to pass 5. Highest value: without it the requirements actively instruct the opposite of pass 5 on three behaviours.
2. **Resolve 5.5 vs 5.11** on `BackupRetentionDays`. Nothing else can resolve it.
3. **Edit the ten stale passages in passes 1–4 in place** rather than relying on supersession: design lines 23, 27, 64, 92, 115, 155, 229, 241, 265, 270, 281, 284, 307, 317, 438, 572, 615, 628, 633, 634, 636, 669. Each is a one- or two-line edit; every one is a place a task-writer reading only that section implements the wrong thing.
4. **Replace pass 2's `newestArchive` code block and suppression JSON** with pass-5-conformant versions — these are the two artefacts an implementer copies literally.
5. **Add a "superseded — see 5.x" inline marker** at the head of each pass-1–4 section pass 5 touches, so the supersession is local rather than global.