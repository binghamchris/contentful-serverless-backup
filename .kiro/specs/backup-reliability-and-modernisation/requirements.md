# Requirements Document

## Introduction

This specification addresses the findings of a six-stream review of the event-driven Contentful backup system conducted on 2026-09-19. That review established two conclusions that shape everything below.

First, **the system cannot currently report its own failure**. Three independent mechanisms convert a failed backup into a successful-looking invocation: the Backup_Lambda catches every error and returns an HTTP-shaped `500` object rather than throwing (so the SQS event source mapping deletes the message and no failure is recorded anywhere); the SQS_Queue's `MessageRetentionPeriod` of 900 s is shorter than its `VisibilityTimeout` of 1800 s (so a crashed invocation's message is purged before redelivery is possible, making `maxReceiveCount` and the Dead_Letter_Queue unreachable); and the CloudFormation placeholder handler returns `true`, i.e. success.

Second, **the archives the system produces are not trustworthy**. The Backup_Lambda writes each export into a fixed `/tmp/backup` path and archives the whole directory, so on a warm execution environment every archive is a cumulative superset of earlier exports on that environment — multiple content files with no indication which is authoritative, assets since deleted from Contentful, and prior error logs. Separately, `contentful-export` reports asset download failures as warnings rather than errors, so an archive missing binary assets is uploaded and logged as a complete success.

Alongside these, the review found a deprecated Lambda runtime with a hard deploy deadline, a non-reproducible deployment path that can bake a developer's `.env` into a function package, several silent no-backup paths in the Filter_Lambda, a backup store whose stated retention policy frees no storage, a template that cannot be deployed twice in one account, and a test suite in which five tests cannot fail under any change to the source while three assert the defects above as correct.

## Governing Constraints

Three constraints, stated by the project owner, govern the whole design and are the reason several conventional answers are rejected below.

**Contentful quota is scarce and shared.** Every backup run consumes Contentful API calls and traffic from a limited allowance that is also needed for editorial work and for the Amplify builds of the PaddelBuch and CloudyPandas frontends that consume the same space. A backup therefore has a real marginal cost that is not measured in dollars, and the system SHALL NOT perform a backup that is not required to protect a content change. In particular there SHALL be no scheduled, periodic or synthetic backup.

**Content changes are rare.** Intervals of several weeks to several months between changes are normal.

**Recurring AWS cost SHALL be zero at rest**, and the owner SHALL receive email only when action is genuinely required.

## Notification Philosophy

The three constraints above rule out both conventional monitoring answers.

**A staleness alarm cannot work.** Detecting "no backup recently" requires a threshold separating a broken system from a quiet one. When a legitimate quiet period is months long, no such threshold exists: any value low enough to detect a failure promptly fires constantly during normal operation, and any value high enough to avoid that does not detect a failure for months. The review's original 36-hour staleness alarm assumed a daily cadence and is withdrawn.

**A scheduled liveness backup is also rejected**, because it would consume Contentful quota on every run purely to prove the system works, competing directly with editorial work and frontend deployments.

**Detection is therefore event-driven and quota-free, on two axes.**

*Failures of attempted backups* reach the owner by email through two paths that between them cover every failure class: the Backup_Lambda publishes its own caught errors before rethrowing, and a Notifier_Lambda triggered by the Dead_Letter_Queue covers the crashes the function cannot report — timeout, out-of-memory termination and initialisation failure.

*Silent absence of a backup* is caught by the Coverage_Check: on each Amplify build notification the Filter_Lambda already runs, and already derives the timestamp of the last content change from the Last_Update_API — which is the website's own static output, not Contentful, and so costs no quota. One additional S3 listing lets it answer the question that matters: content changed at time T, so does a backup newer than T exist? If not, and enough time has elapsed that one should, the owner is emailed. Because the comparison is against *content recency* rather than wall-clock time, a six-month quiet period produces no notification, while a broken backup path is reported at the next build.

**The owner receives email only when action is required.** No success notifications, no recovery notifications, no digests, no routine traffic. Anything that trains the recipient to ignore the channel defeats the channel.

**No CloudWatch alarms, custom metrics, metric filters or dashboards are introduced.** This is a deliberate decision on both cost and alert-fatigue grounds, recorded in Requirement 11, which also records the residual risk it accepts.

## Scope

**In scope:** failure notification and backup-coverage verification; archive correctness and integrity; trigger reliability; runtime and dependency currency; deployment reproducibility; backup store lifecycle and policy hardening; template quality and multi-environment deployability; test suite efficacy; documentation accuracy.

**Explicitly out of scope**, at the project owner's direction:

- **Scheduled, periodic or synthetic backups of any kind.** A backup occurs only in response to a real content change. See the Governing Constraints and Requirement 9.
- **Restore capability.** No restore runbook, restore drill, RPO/RTO statement, disaster-recovery scope document, or backup-of-the-backup-prerequisites work. Requirement 13 still obliges the archive to carry enough self-description to *support* a future restore, because that is a property of the artefact rather than a restore procedure.
- **Licensing.** The project remains under CC BY-NC-SA 4.0. The review's finding that a Creative Commons licence is unsuitable for software is acknowledged and deliberately not acted upon.
- **Version-control protection of the existing work.** Already completed: `feat/project-quality-overhaul` is pushed with upstream tracking, and the prior spec's `requirements.md` and `design.md` are committed.
- **CloudWatch alarms, custom metrics, metric filters and dashboards.** See Requirement 11.

**Deliberate deferrals recorded rather than silently omitted** (see Requirement 55): a customer-managed KMS key for the Backup_Bucket; migration of the trigger from Amplify build notifications to Contentful webhooks; and off-site backup replication and S3 Object Lock, which Requirement 36 parameterises for later activation without a further specification.

## Glossary

- **Backup_Lambda**: the AWS Lambda function (`backup-lambda/index.js`) that exports a Contentful space and stores the resulting ZIP archive in the Backup_Bucket.
- **Filter_Lambda**: the AWS Lambda function (`filter-lambda/index.js`) that evaluates an Amplify build notification, enqueues a backup request when one is warranted, and performs the Coverage_Check.
- **Notifier_Lambda**: a new, small Lambda function invoked by the Dead_Letter_Queue, whose sole job is to publish a failure notification and record the failed message.
- **Coverage_Check**: the comparison, performed by the Filter_Lambda on each invocation, between the timestamp of the last content change and the timestamp of the newest object in the Backup_Bucket. Consumes no Contentful quota.
- **CloudFormation_Template**: `infrastructure/template.yaml`, defining all AWS resources for the system.
- **Build_Script**: `deploy/build-lambda.js`, which packages a Lambda function's code and dependencies and applies them with `lambda:UpdateFunctionCode`.
- **SSM_Parameter**: an AWS Systems Manager Parameter Store `SecureString` parameter holding a Contentful API token.
- **Backup_Bucket**: the S3 bucket holding backup archives.
- **SQS_Queue**: the FIFO queue decoupling the Filter_Lambda from the Backup_Lambda (`contentfulBackupQueue.fifo`).
- **Dead_Letter_Queue**: the FIFO queue receiving messages the Backup_Lambda repeatedly fails to process (`contentfulBackupDLQ.fifo`). Under this specification it is also the trigger for failure notification.
- **Event_Source_Mapping**: an `AWS::Lambda::EventSourceMapping` connecting a queue to a function.
- **Alert_Topic**: a new SNS topic, owned by this stack, carrying failure and coverage-gap notifications to the owner by email.
- **Amplify_Topic**: the SNS topic created manually in the Amplify console and passed in as `SnsTopicArn`. Not owned by this stack.
- **Last_Update_API**: the static JSON endpoint, published by the website build, that the Filter_Lambda queries for the most recent Contentful change timestamp. Served by the website, not by Contentful.
- **Backup_Manifest**: a machine-readable JSON file written into the root of each archive describing that archive's provenance and contents.
- **Placeholder_Handler**: the inline `Code.ZipFile` handler the CloudFormation_Template deploys before real code is applied by the Build_Script.
- **Prior_Spec**: `.kiro/specs/project-quality-overhaul`, completed 2026-03-20.

## Requirements

### Requirement 0: Supersede the Prior Specification's Non-Functional Constraint

**User Story:** As the project owner, I want this specification's reversal of the Prior_Spec's behaviour freeze to be explicit and recorded, so that a future reader sees a deliberate decision rather than unexplained drift.

The Prior_Spec's Requirement 0 froze the system as strictly non-functional. Several findings cannot be fixed within that constraint, and three currently-passing tests assert the frozen behaviour.

#### Acceptance Criteria

1. THIS specification SHALL supersede Prior_Spec Requirement 0 in full, and the superseding SHALL be recorded in this document and in the decision record required by Requirement 55.
2. THE following Prior_Spec acceptance criteria SHALL be reversed by name: 0.1 (end-to-end event flow unchanged — superseded only to the extent of adding the notification paths in Requirements 7, 8 and 9), 0.2 (Contentful export configuration unchanged), 0.4 (SQS deduplication behaviour unchanged), 0.6 (substring `SUCCEED` evaluation retained), 0.7 (message deleted only after successful upload), 3.1 and 3.2 (each Handler returns the SendResponse_Function result), and 9.3 (Backup_Lambda granted receive and delete on the Dead_Letter_Queue).
3. Prior_Spec criterion 0.5 (template parameters retain names, types and defaults, none removed) SHALL be relaxed only to the extent of ADDING parameters and TIGHTENING validation on existing ones; no existing parameter SHALL be renamed or removed, and no existing default SHALL change.
4. WHERE a test asserts a behaviour this specification reverses, THE test SHALL be rewritten to assert the new behaviour rather than deleted, and the rewrite SHALL reference the criterion that authorised it.
5. THE end-to-end event flow SHALL retain a single trigger — the Amplify build notification — and SHALL NOT gain a scheduled trigger.
6. THE number of Contentful export runs per content change SHALL NOT increase on the success path. THE additional exports caused by redelivery of a failed message SHALL be bounded by `maxReceiveCount` and stated in the per-change request budget required by criterion 57.6.
7. A ONE-TIME commissioning export, authorised by criterion 16.9 and counted in that budget, SHALL be the only export not triggered by a real content change.

---

## Part A — Failure Notification and Backup Coverage

### Requirement 1: The Backup Lambda Shall Fail Loudly

**User Story:** As an operator, I want a failed backup to be a failed Lambda invocation, so that AWS's own failure machinery engages instead of the failure being discarded.

#### Acceptance Criteria

1. WHEN any stage of the Backup_Lambda handler fails, THE Backup_Lambda SHALL throw rather than return a response object.
2. THE Backup_Lambda SHALL NOT return an HTTP-shaped object on any failure path, and `sendResponse` SHALL be retained only for the success return or removed entirely.
3. WHEN the S3 upload does not complete successfully, THE Backup_Lambda SHALL throw an error naming the upload stage.
4. THE Backup_Lambda SHALL NOT branch on `response['$metadata']['httpStatusCode']` to detect failure, because AWS SDK v3 rejects on non-2xx responses and those branches are unreachable.
5. WHEN the Backup_Lambda throws, THE error message and stack SHALL be logged before propagation, and the raw error object SHALL NOT be returned as a response body.

### Requirement 2: Message Lifecycle Shall Be Owned by the Event Source Mapping

**User Story:** As a developer, I want a single owner of SQS message lifecycle, so that success and failure reporting match what actually happened.

#### Acceptance Criteria

1. THE Backup_Lambda SHALL NOT call `DeleteMessageCommand`, and the `deleteMessageAsync` function SHALL be removed.
2. THE Backup_Lambda IAM role SHALL RETAIN `sqs:ReceiveMessage`, `sqs:DeleteMessage` and `sqs:GetQueueAttributes`, scoped to the SQS_Queue ARN only, because an SQS Event_Source_Mapping polls the queue using the function's own execution role. These three actions are the body of the AWS-managed `AWSLambdaSQSQueueExecutionRole` policy, and removing them would silently detach the trigger rather than tighten least privilege.
3. WHAT criterion 2.1 removes is the Backup_Lambda code's own call, not the permission. A test SHALL assert that all three actions are present on the Backup_Lambda role and scoped to the source queue, so a future least-privilege sweep cannot delete them again.
4. THE Backup_Lambda IAM role SHALL NOT retain any grant on the Dead_Letter_Queue, which no Backup_Lambda code path reads. This reverses Prior_Spec criterion 9.3, and the reversal SHALL be recorded.
5. WHEN the Backup_Lambda returns successfully, THE Event_Source_Mapping SHALL be the sole mechanism deleting the triggering message.

### Requirement 3: Queue Retention, Visibility and Redrive Shall Be Coherent

**User Story:** As an operator, I want a failed backup to be retried and then land in the Dead_Letter_Queue, so that failures are preserved and can trigger a notification rather than being silently purged.

#### Acceptance Criteria

1. THE SQS_Queue `MessageRetentionPeriod` SHALL be at least twice `VisibilityTimeout` multiplied by `maxReceiveCount`. THE margin is expressed as a factor so it is assertable; "with margin" alone would be satisfied by one second.
2. THE `maxReceiveCount` SHALL be declared with permitted values that bound it, because it multiplies Contentful export attempts under criterion 0.6, sets the dead-letter latency in criterion 3.6, and drives the retention arithmetic above.
3. THE SQS_Queue `VisibilityTimeout` SHALL remain at least six times the Backup_Lambda `Timeout`, preserving Prior_Spec Requirement 20.
4. THE CloudFormation_Template SHALL carry an inline comment recording the three-way coupling between the Backup_Lambda `Timeout`, the `VisibilityTimeout` and the `MessageRetentionPeriod`.
5. WHEN the Backup_Lambda fails `maxReceiveCount` times for one message, THE message SHALL arrive in the Dead_Letter_Queue.
6. THE Dead_Letter_Queue SHALL declare a `RedriveAllowPolicy` naming the SQS_Queue as its only permitted source. THIS restricts which queues may designate it as their dead-letter target — its default permits all — and is therefore a security tightening. IT does NOT enable an operator to replay a message, and criterion 39.5 records why replay from that queue is unavailable.
7. THE design SHALL state the worst-case notification latency for each failure class, given that a crash-path notification waits for `maxReceiveCount` redeliveries while a caught-error notification is immediate.
8. THE design SHALL state how many Contentful export attempts a single failing message causes, since each retry consumes quota, and SHALL justify `maxReceiveCount` against that cost.

### Requirement 4: Placeholder Code Shall Fail Closed

**User Story:** As an operator, I want a function whose real code was never applied to be immediately obvious, so that an incomplete or reverted deployment cannot masquerade as a working system.

#### Acceptance Criteria

1. THE Placeholder_Handler in the CloudFormation_Template SHALL throw an error identifying itself as undeployed placeholder code, for every function it is used for.
2. THE Placeholder_Handler SHALL NOT return a value that Lambda or an Event_Source_Mapping would interpret as success.
3. WHEN a Placeholder_Handler is invoked for the Backup_Lambda, THE resulting failure SHALL reach the owner through Requirement 7.
4. WHEN a Placeholder_Handler is live for the Filter_Lambda, such that no backup is ever requested, THE condition SHALL be caught by the Filter_Lambda's `OnFailure` destination required by criterion 8.2, because the placeholder throws. IT SHALL NOT be attributed to the Coverage_Check, which runs inside the Filter_Lambda and therefore cannot execute when that function is the placeholder.
5. THE CloudFormation_Template SHALL expose a parameter controlling whether the Backup_Lambda's Event_Source_Mapping is enabled, defaulting to `true` to preserve current behaviour, so a first deployment can be performed with the mapping disabled.
6. THE deployment documentation SHALL instruct the operator to deploy with the mapping disabled on a first deployment and to enable it only after code has been applied.

### Requirement 5: Log Groups Shall Be Stack-Managed with Bounded Retention

**User Story:** As the project owner, I want log groups declared in the template with a retention period, so that log cost is bounded and teardown is clean.

#### Acceptance Criteria

1. THE CloudFormation_Template SHALL declare an `AWS::Logs::LogGroup` for every Lambda function in the system, including the Notifier_Lambda.
2. EACH log group SHALL set `RetentionInDays` from a template parameter with a documented default.
3. EACH Lambda function SHALL declare `DependsOn` its log group, so the service cannot create the group implicitly first and fail the stack operation.
4. EACH Lambda function SHALL set `LoggingConfig` with `LogFormat: JSON` and an explicit `ApplicationLogLevel`, so log verbosity is changeable without a code deployment.
5. THE log groups SHALL use the Infrequent Access log class, which halves ingestion cost and supports the on-demand Logs Insights querying criterion 11.6 relies on. THE design SHALL record that this class does NOT support direct log-stream retrieval, metric filters or Embedded Metric Format — the last two making criteria 11.3 and 11.5 self-enforcing — and that storage and query charges are identical between classes, so only ingestion differs. THE design SHALL record the measured ingestion prices for both classes rather than assuming the difference.
6. BECAUSE a log group's class cannot be changed after creation, and because the existing log groups were created implicitly outside the stack, THE functions SHALL be pointed at NEW stack-created log groups using the `LoggingConfig.LogGroup` property with a stack-scoped name. THE name collision that would otherwise fail the next stack update therefore never arises, and the new groups can be created in the chosen class, which adopting the existing groups by resource import would permanently foreclose.
7. THE deployment documentation SHALL name the one residual manual step this leaves: the old implicitly-created log groups are orphaned, retain no expiry, and continue to accrue storage charges, so they require a one-time deletion outside CloudFormation. THIS specification SHALL NOT claim full automation of log-group management.
8. THE log-writing IAM grants required by criterion 40.2 SHALL be scoped to the new stack-scoped log group names, not to the default `/aws/lambda/<function name>` paths.
9. ONCE log groups are declared, THE `logs:CreateLogGroup` permission SHALL be removed from both existing IAM roles.
10. THE Backup_Lambda SHALL set the export library's verbose renderer, which emits one line per event, in place of the default in-place renderer that redraws the whole task list with carriage returns on every tick — each redraw otherwise becoming its own JSON log envelope under criterion 5.4. THE resulting volume reduction SHALL be measured and recorded, not assumed.

### Requirement 6: A Dedicated Alert Channel Shall Exist

**User Story:** As the project owner, I want notifications delivered to me by email on a channel of their own, so that I notice them and they are not mixed into build-notification traffic.

#### Acceptance Criteria

1. THE CloudFormation_Template SHALL create a **standard** SNS topic owned by this stack to serve as the Alert_Topic. IT SHALL NOT be a FIFO topic, which Lambda does not accept as an asynchronous on-failure destination.
2. THE Alert_Topic SHALL be encrypted at rest using at minimum the AWS-managed SNS key, PROVIDED that every publisher can still publish under that key.
3. BECAUSE publishing to an encrypted topic requires the publishing principal to hold `kms:GenerateDataKey*` and `kms:Decrypt` on the topic's key, and the AWS-managed key's policy cannot be edited, THE design SHALL empirically verify that each publisher role can publish before relying on the AWS-managed key. WHERE it cannot, the design SHALL choose between a customer-managed key, whose cost SHALL be stated and which reopens the deferral recorded in criterion 42.10, and an unencrypted topic, which reopens the audit finding acknowledged in criterion 39.2. THE choice SHALL be recorded and SHALL NOT be left to discovery during verification.
4. THE CloudFormation_Template SHALL accept an alert email address as a validated parameter and subscribe it to the Alert_Topic. THE subscription SHALL be condition-gated on a parameter, so a validation stack deployed under Requirement 41 can supply a non-owner address or omit the subscription and therefore not email the owner.
5. THE Alert_Topic SHALL NOT be the Amplify_Topic.
6. THE deployment documentation SHALL state that an email subscription remains unconfirmed until the recipient acts, that CloudFormation reports success regardless, and that confirmation SHALL be verified as a post-deployment step.
7. THE Alert_Topic ARN SHALL be published as a stack output.
8. THE Alert_Topic SHALL carry only backup failures (Requirement 7), filter invocation failures (Requirement 8), coverage gaps (Requirement 9), and a manually initiated verification publication under criterion 10.1 which the design SHALL label as such. Its permitted publishers SHALL be enumerated in the design, and nothing else SHALL publish to it.

### Requirement 7: Backup Failures Shall Notify by Email Without Polling

**User Story:** As the project owner, I want an email when a backup fails and at no other time, so that anything arriving in my inbox means my attention is genuinely required.

#### Acceptance Criteria

1. WHEN the Backup_Lambda catches a failure AND the triggering SQS record's `ApproximateReceiveCount` is 1, THE Backup_Lambda SHALL publish a notification to the Alert_Topic before rethrowing. ON a redelivery of the same message it SHALL rethrow without publishing, so redelivery does not multiply email.
2. THE publication SHALL NOT suppress or replace the throw; the retry and dead-letter machinery required by Requirement 3 SHALL still engage.
3. IF the publication itself fails, THEN THE Backup_Lambda SHALL log that failure and SHALL still throw, so a broken notification path cannot swallow the original error.
4. WHEN a message arrives in the Dead_Letter_Queue, THE Notifier_Lambda SHALL be invoked by an Event_Source_Mapping on that queue and SHALL publish a notification to the Alert_Topic. A FIFO queue is a permitted Lambda event source.
5. BECAUSE all messages share a constant `MessageGroupId`, a Notifier_Lambda that throws would block every subsequent failure notification in that group until the message succeeds or expires — up to the Dead_Letter_Queue's full retention period. TO prevent that, the Dead_Letter_Queue SHALL declare its own `RedrivePolicy` to a terminal second-level queue with a low `maxReceiveCount`, so a message the Notifier_Lambda cannot process is moved aside rather than blocking the group. THE second-level queue SHALL add no recurring cost at rest.
6. A test SHALL assert that a Notifier_Lambda failure cannot indefinitely block notification of subsequent failures.
7. THE Notifier_Lambda SHALL exist specifically to cover the failure classes in which the Backup_Lambda cannot report for itself: function timeout, out-of-memory termination, and initialisation failure.
8. THE Notifier_Lambda SHALL log the full failed message body before returning, so the forensic record survives in its log group once the message is consumed.
9. THE Notifier_Lambda SHALL NOT call Contentful, and SHALL NOT trigger a backup.
10. THE owner SHALL receive at most ONE email per failed message from the caught-error path, regardless of how many times that message is redelivered, and at most ONE from the Dead_Letter_Queue path. THIS bound SHALL be achieved from the `ApproximateReceiveCount` attribute already present on the SQS record, requiring no stored state. A test SHALL assert the bound.
11. THE notification content SHALL carry enough context to act without opening the console: the failing phase, the UTC timestamp, the Contentful space and environment, the error message, and the log stream identifier together with the query needed to read it. WHERE the log group uses a class that does not support direct log-stream retrieval, the notification SHALL give a Logs Insights query rather than a bare stream name, per criterion 5.5.
12. EACH role publishing to the Alert_Topic SHALL be granted `sns:Publish` scoped to that topic, together with the `kms:GenerateDataKey*` and `kms:Decrypt` actions that publishing to the encrypted topic requires, constrained by a `kms:ViaService` condition naming the SNS service endpoint. NO other SNS or KMS action SHALL be granted.
13. NO CloudWatch alarm SHALL be required for any failure to reach the owner.
14. THE system SHALL NOT send email on success, on recovery from failure, or as a periodic digest.

### Requirement 8: Asynchronous Filter Failures Shall Notify

**User Story:** As the project owner, I want to know when an Amplify notification was dropped, so that a backup which was never even requested is not invisible.

#### Acceptance Criteria

1. THE CloudFormation_Template SHALL declare an `AWS::Lambda::EventInvokeConfig` on the Filter_Lambda with an explicit maximum retry attempts value within the permitted range 0 to 2, an explicit maximum event age within the permitted range 60 to 21600 seconds, and an `OnFailure` destination.
2. THE `OnFailure` destination SHALL be the Notifier_Lambda, NOT the Alert_Topic directly, because an asynchronous invocation record delivered straight to an email subscription renders as raw nested JSON and contains no log stream identifier, so it cannot satisfy the content contract in criterion 7.11. THE Notifier_Lambda SHALL format a human-readable message and publish it to the Alert_Topic.
3. THE Notifier_Lambda SHALL discriminate the two envelope shapes it can receive — an SQS `Records` batch from the Dead_Letter_Queue and an asynchronous invocation record from this destination — and SHALL handle each, per criterion 22.5.
4. THE Filter_Lambda role SHALL be granted `lambda:InvokeFunction` on the Notifier_Lambda only.
5. ONE malformed event SHALL produce at most one email.
6. THE CloudFormation_Template SHALL NOT declare an `EventInvokeConfig` or `DestinationConfig` on the Backup_Lambda, because its Event_Source_Mapping invokes it synchronously and such configuration would be inert.
7. THE design SHALL record that asymmetry and its reason.
8. THE Filter_Lambda SHALL continue to throw on error rather than returning a response object, which is the behaviour that makes criterion 8.1 effective. This reverses Prior_Spec criterion 3.2, authorised by criterion 0.2.

### Requirement 9: Backup Coverage Shall Be Verified Without Consuming Contentful Quota

**User Story:** As the project owner, I want to be told when content has changed but no backup covers it, so that a silently broken backup path is caught — without spending Contentful quota to find out.

#### Acceptance Criteria

1. THE Filter_Lambda SHALL perform the Coverage_Check on every invocation, comparing the timestamp of the last content change against the export timestamp **parsed from the key** of the newest backup object.
2. THE comparison SHALL use the key-derived timestamp and SHALL NOT use the object's `LastModified`. THE key timestamp is the moment the export began; `LastModified` is the moment the upload completed, which is later. Using `LastModified` would report a change as covered by an archive whose export started before that change. THE key basis is also unaffected by storage-class transitions, restores and re-uploads.
3. THE Backup_Lambda SHALL continue to write object keys in a fixed-width, zero-padded, lexicographically time-ordered form, recorded under criterion 13.3, so the greatest conforming key is the newest backup.
4. THE Coverage_Check SHALL enumerate objects with a full paginated listing, with no delimiter, SHALL ignore every key not matching the documented archive pattern, and SHALL bound the enumeration by a documented maximum page count. THE design SHALL record that the expected object count over the full retention period is two orders of magnitude below one page, so a single request suffices, and SHALL NOT adopt a bounded backward prefix walk, which would return nothing after a legitimate long quiet period and misreport a broken path as indeterminate.
5. THE Coverage_Check SHALL yield exactly three outcomes: **found** (a conforming key exists), **none** (the listing succeeded and no conforming key exists), and **indeterminate** (the listing failed, the page bound was exceeded, or the content timestamp could not be derived).
6. THE Coverage_Check SHALL make no Contentful API call, and SHALL derive the content timestamp solely from the Last_Update_API response it already retrieves.
7. WHEN the outcome is **found** AND the last content change is newer than the key-derived backup timestamp, AND more time has elapsed since that change than a configured grace period, THEN THE Filter_Lambda SHALL publish a coverage-gap notification to the Alert_Topic.
8. WHEN the outcome is **none** AND a valid content change timestamp exists, THE absent backup SHALL be treated as a backup timestamp of negative infinity — a determinate gap, not an indeterminate result — and SHALL notify subject to the same grace period.
9. WHEN the outcome is **indeterminate**, THE Filter_Lambda SHALL log the reason and SHALL NOT notify, so an inability to check never becomes routine email traffic.
10. IF this invocation enqueues a backup for the content state under comparison, THEN NO coverage-gap notification SHALL be published for that state, because the same invocation is closing the gap.
11. EQUAL timestamps SHALL be treated as covered and SHALL NOT notify. THE comparison SHALL apply a documented clock-skew tolerance, subtracted from the content timestamp, because the two timestamps originate from independent clocks.
12. THE grace period SHALL be a template parameter with a documented default and a bounded range, long enough to accommodate a build plus a backup in flight, so a backup that is merely in progress does not notify.
13. WHEN a backup newer than the last content change exists, NO notification SHALL be sent.
14. WHEN no content change has occurred since the newest backup, NO notification SHALL be sent, however long that period is. A quiet space SHALL never notify.
15. THE Coverage_Check SHALL NOT itself enqueue a backup, trigger an export, or otherwise consume Contentful quota, and SHALL NOT create a loop with the Filter_Lambda's own enqueue decision.
16. REPEATED notification for one unresolved gap SHALL be bounded so a persistent gap does not email on every subsequent build. THE suppression state SHALL be held in a store the CloudFormation_Template declares and which adds no recurring charge at rest; the Filter_Lambda role SHALL be granted read and write access to that one store only, and criterion 40.6 SHALL name it.
17. THE Coverage_Check SHALL run regardless of whether a backup is warranted, so a build requiring no backup still verifies coverage. THIS SHALL NOT be read as forbidding the suppression required by criterion 9.10.
18. THE Filter_Lambda IAM role SHALL be granted `s3:ListBucket` on the Backup_Bucket, and deliberately NOT `s3:ListBucketVersions`, so noncurrent versions and delete markers are invisible to the check and an expired archive correctly disappears from view. THE role SHALL NOT be granted `s3:GetObject`.
19. THE Filter_Lambda SHALL accept the Last_Update_API endpoint and the bucket listing prefix through configuration, so criterion 10.4 can create a coverage gap for verification without deleting an archive.
20. THE design SHALL state what the Coverage_Check cannot detect — principally the Filter_Lambda never being invoked at all, because the Amplify_Topic is wrong, dead or unsubscribed — and SHALL record that a frontend deployment of either consuming site exercises it.
21. THE notification content SHALL state the last content change timestamp, the newest backup timestamp, the elapsed gap, and the literal command an operator runs to enqueue a backup manually, with a content-derived `MessageDeduplicationId` per criterion 20.1 and a constant `MessageGroupId` per criterion 20.4. EVERY flag in that command SHALL be written out literally, and its Contentful quota cost SHALL be stated, so a coverage-gap email carries a sanctioned remedy rather than only a diagnosis.

### Requirement 10: The Notification Paths Shall Be Verified

**User Story:** As the project owner, I want proof that a failure actually reaches my inbox, because with no alarms the notification paths are the only thing standing between a failure and silence.

#### Acceptance Criteria

1. THE verification SHALL confirm the Alert_Topic email subscription is confirmed and that a test publication is received. THIS publication is sanctioned by criterion 6.8 and SHALL be labelled as a verification message.
2. THE verification SHALL deliberately induce a caught backup failure and confirm that an email arrives containing the context required by criterion 7.11. IT SHALL be induced at a phase BEFORE the export — by revoking the S3 write, or by supplying an invalid token — so no Contentful quota is consumed.
3. THE verification SHALL deliberately induce a failure the function cannot catch, and confirm that the Dead_Letter_Queue path produces an email. IT SHALL be induced by constraining the function's own limits, such as a one-second timeout against a synthetic record naming a non-existent space, so the failure occurs before content transfer and consumes no quota.
4. THE verification SHALL deliberately create a coverage gap and confirm that the Coverage_Check produces an email. IT SHALL be created using the configuration hooks required by criterion 9.19 — pointing the listing prefix at an empty prefix, or the Last_Update_API at a fixture — and SHALL NOT require deleting an archive, for which no role holds permission.
5. THE verification SHALL confirm that a successful backup produces NO email.
6. THE verification SHALL confirm that a build requiring no backup, against a bucket already holding a newer archive, produces NO email.
7. THE verification SHALL confirm that a redelivery of an already-reported failed message produces NO second email, per criterion 7.10.
8. NO step of this verification SHALL require a Contentful export, and the design SHALL state the route for each step.
9. THE verification results SHALL be recorded under `docs/`.
10. THE documentation SHALL define a manual check of the notification paths performed at commissioning and after any change to a notification path, and explicitly NOT on a calendar interval, because a recurring verification email would be exactly the routine traffic criterion 7.14 forbids.

### Requirement 11: Observability Shall Carry No Standing Cost and No Quota Cost

**User Story:** As the project owner, I want no recurring charge for monitoring, no Contentful quota spent on monitoring, and no routine notifications, so that the system costs nothing at rest and the alert channel keeps my attention.

#### Acceptance Criteria

1. THE CloudFormation_Template SHALL declare no `AWS::CloudWatch::Alarm`.
2. THE CloudFormation_Template SHALL declare no `AWS::CloudWatch::CompositeAlarm`.
3. THE CloudFormation_Template SHALL declare no `AWS::Logs::MetricFilter`.
4. THE CloudFormation_Template SHALL declare no `AWS::CloudWatch::Dashboard`.
5. NO code in this system SHALL publish a CloudWatch custom metric, whether by an explicit metric API call or by Embedded Metric Format.
6. OPERATIONAL values — archive size, export duration, entity counts, asset success and failure counts, and the intervals computed by the Filter_Lambda — SHALL be emitted as fields within structured log lines and recorded in the Backup_Manifest, remaining queryable on demand, and SHALL NOT be promoted to metrics.
7. THE CloudFormation_Template SHALL declare no scheduled rule, scheduled event, or any other time-based trigger.
8. NO component SHALL call the Contentful API for the purpose of monitoring, health-checking or verification.
9. THE observability introduced by this specification SHALL add no recurring monthly charge at rest, other than log ingestion and log storage bounded by Requirement 5, and the suppression store permitted by criterion 9.16, which SHALL be chosen from mechanisms that carry no charge at rest.
10. THE design SHALL state the request volume generated by each Event_Source_Mapping's continuous polling, and SHALL name the free-tier allowance the zero-cost claim depends on, so "zero at rest" is derived from measured prices rather than asserted.
11. THE log level parameter required by criterion 5.4 SHALL be constrained so it cannot be set above the level at which the operational values in criterion 11.6 are emitted. BECAUSE those log lines are the sole record of those values, raising the level would destroy the only observability this specification provides.
12. THE design SHALL record the residual risk this accepts: with no alarm and no schedule, the system is only observed when an Amplify build occurs, so a chain broken upstream of the Filter_Lambda is undetected until the next build of either consuming site, and a broken notification path is itself undetected until the manual check in criterion 10.10.
13. THE design SHALL record the measured unit prices that motivated this decision, so a future reader can re-evaluate it against current rates.
14. IF a future change reintroduces an alarm, a custom metric, a metric filter, a dashboard or a schedule, THEN its recurring cost — in both currency and Contentful quota — SHALL be stated in that change.

---

## Part B — Archive Correctness and Integrity

### Requirement 12: Each Invocation Shall Use an Isolated Working Directory

**User Story:** As the project owner, I want each archive to contain exactly one export, so that an archive is unambiguous and does not grow without bound.

#### Acceptance Criteria

1. THE Backup_Lambda SHALL export into a working directory unique to the invocation, not a fixed shared path.
2. THE Backup_Lambda SHALL remove its working directory in a `finally` block, regardless of success or failure.
3. BECAUSE a `finally` block does not run when Lambda terminates the execution environment for a timeout or an out-of-memory condition — precisely the two classes the Notifier_Lambda exists to cover under criterion 7.7 — THE Backup_Lambda SHALL, before creating its own working directory, remove any pre-existing directory under its configured working root left behind by an earlier terminated invocation. WITHOUT this, each such failure leaks a full export tree on a warm environment and ephemeral storage fills.
4. WHEN the Backup_Lambda runs on a warm execution environment previously used by another invocation, THE resulting archive SHALL contain only the current export.
5. THE archive SHALL NOT contain any content file, asset, or error log produced by a previous invocation.
6. THE ZIP archive SHALL be written outside the directory being archived, so a leftover archive cannot be nested into a subsequent one.
7. THE Backup_Lambda SHALL delete the local archive only after the upload is confirmed.
8. THE Backup_Lambda SHALL retry a failed upload a documented number of times within the same invocation, bounded by the remaining invocation time, before throwing — so a transient upload failure does not cost a further Contentful export through redelivery. EACH retry SHALL re-create the file read stream, because a streaming uploader consumes it and a reused stream would upload zero bytes.

### Requirement 13: Archives Shall Be Self-Describing and Verifiable

**User Story:** As the project owner, I want each archive to state what it is and to be provably intact, so that a corrupt or empty archive is distinguishable from a good one without opening it.

#### Acceptance Criteria

1. THE Backup_Lambda SHALL write a Backup_Manifest into the root of each archive.
2. THE Backup_Manifest SHALL record the Contentful space and environment, the UTC export timestamp, the export scope (published-state only, per Requirement 14), per-entity-type counts, asset download success and failure counts, the `contentful-export` version, and the deployed code's commit identifier.
3. THE Backup_Lambda SHALL write the export's content file under a fixed, documented name inside the archive, so the authoritative entry point is unambiguous. THE S3 object key format SHALL also be documented here, since criterion 9.3 depends on it being fixed-width and lexicographically time-ordered.
4. THE Backup_Lambda SHALL set a checksum algorithm and a content type on the S3 upload. WHERE the upload is multipart, the design SHALL record that the stored checksum is a composite of part checksums rather than a whole-object digest, and the Backup_Manifest SHALL NOT claim otherwise.
5. AFTER upload, THE Backup_Lambda SHALL verify the stored object by a `ListObjectsV2` call scoped to that exact key, reading `Key` and `Size` from the listing, and SHALL throw unless the object is present and its size matches the bytes uploaded. THIS call requires only `s3:ListBucket`, so it satisfies criterion 40.8's prohibition on `s3:GetObject`, which `HeadObject` would otherwise require. IT has a second virtue: an incomplete multipart upload does not appear in a general-purpose bucket listing, so a half-uploaded archive is correctly detected as absent.
6. THE Backup_Lambda IAM role SHALL be granted `s3:ListBucket` on the Backup_Bucket for this purpose, and SHALL NOT be granted `s3:GetObject` or `s3:GetObjectVersion`.
7. THE Backup_Lambda SHALL verify that no zero-byte files exist in the export tree before archiving.

### Requirement 14: The Export Shall Capture Published State Only

**User Story:** As the project owner, I want backups to contain published content, so that an archive represents the state the website actually served.

#### Acceptance Criteria

1. THE Backup_Lambda SHALL NOT set `includeDrafts` to `true`. This reverses Prior_Spec criterion 0.2.
2. THE Backup_Lambda SHALL continue to supply both the management token and the delivery token. BOTH are genuinely required: with `includeDrafts` removed, the export library constructs a Content Delivery API client and fetches entries and assets through it, while content types, editor interfaces, locales, tags and webhooks continue to come from the Management API. REMOVING `includeDrafts` is therefore precisely what activates the delivery token, which today is fetched, decrypted and then ignored.
3. THE Backup_Lambda IAM role SHALL retain `ssm:GetParameters` on both SSM_Parameters.
4. WHEN either token is absent or empty after parsing, THE Backup_Lambda SHALL throw immediately, naming which token is missing, rather than proceeding to an opaque authentication failure that consumes quota. THIS is load-bearing rather than defensive: the library validates only the management token, so a missing delivery token would silently fall back to a draft-inclusive Management API export.
5. THE Backup_Lambda SHALL raise `maxAllowedLimit` from its current value of 200 to the library and API maximum of 1000. AT 200 the export makes up to five times as many paged requests as necessary, so this single change is the largest available reduction in Contentful API consumption and directly serves criteria 0.6 and 57.6.
6. THE Backup_Manifest SHALL record that the archive is published-state only.
7. THE test that asserts `includeDrafts: true` SHALL be rewritten to assert published-state configuration, citing this requirement.
8. THE Backup_Lambda documentation SHALL state that unpublished editorial work is not captured.
9. THE design SHALL state the effect of the published-state switch on Contentful consumption, including that entries and assets move from the Management API to the Content Delivery API, which carries a separate rate-limit allowance — so the switch shifts the heaviest part of the load off the endpoint that editorial work and Amplify builds compete for.

### Requirement 15: Incomplete Asset Downloads Shall Be Detected and Not Reported as Success

**User Story:** As the project owner, I want an archive missing binary assets to be treated as a failure, so that a partial backup is never recorded as a complete one.

#### Acceptance Criteria

1. THE Backup_Lambda SHALL determine asset download completeness by comparing the asset set the export declares against the files actually written to the export tree. IT SHALL NOT attempt to read the counts from the export's return value: the library sets them on its internal task context and resolves with the content data only, so the counts are printed to a console table and discarded. NEITHER SHALL it attach a listener to the library's internal log emitter, which is undocumented internal API.
2. THE expected file set SHALL be derived from the asset URLs in the returned content data, resolved to the paths the library writes them to, and compared against the tree in a single walk. THAT one walk SHALL also satisfy the manifest counts in criterion 13.2 and the zero-byte check in criterion 13.7.
3. WHEN one or more expected asset files are missing or zero-length, THE Backup_Lambda SHALL treat the backup as incomplete and SHALL state how many are missing.
4. WHERE the shortfall is attributable to Contentful rate limiting, THE Backup_Lambda SHALL notify per criterion 17.6 and SHALL NOT throw, so the message is not redelivered. THE library already retries a rate-limited asset three times with exponential backoff, so an asset that still failed has exhausted that budget and a further full export is unlikely to succeed while costing the most quota. THE archive SHALL be recorded as incomplete in the Backup_Manifest.
5. FOR any other cause, THE Backup_Lambda SHALL throw, so the message is redelivered and retried.
6. THE Backup_Lambda SHALL NOT log an unconditional success message before the export outcome has been evaluated.
7. THE failure and success counts SHALL appear in the Backup_Manifest and in the structured log line, per criterion 11.6.
8. THE design SHALL record that the library classifies asset download errors as warnings and filters warnings out of the condition it throws on, so the export resolves normally and prints success — which is why explicit inspection is required.

### Requirement 16: Memory Use Shall Be Bounded and Storage Declared

**User Story:** As the project owner, I want the backup to keep working as the space grows, so that the system does not grow silently into failure.

#### Acceptance Criteria

1. THE Backup_Lambda SHALL stream the archive to S3 using a multipart-capable uploader rather than reading it entirely into memory.
2. THE Backup_Lambda SHALL NOT create a redundant copy of the archive buffer.
3. THE Backup_Lambda SHALL NOT retain the full export result in scope for longer than it is needed.
4. THE Backup_Lambda IAM role SHALL be granted `s3:AbortMultipartUpload`.
5. THE CloudFormation_Template SHALL declare `EphemeralStorageSize` explicitly, with the value's rationale recorded, and the design SHALL state its cost per invocation.
6. THE CloudFormation_Template SHALL record the rationale for `MemorySize` as an inline comment, the current value of 450 having no justification anywhere in the repository.
7. THE CloudFormation_Template SHALL declare `MemorySize` explicitly on EVERY function, including the Filter_Lambda and the Notifier_Lambda. THE Filter_Lambda currently declares none and so runs at the service default, which is an unstated configuration rather than a decision — and this specification gives it more work to do, adding an S3 listing and an SNS publish to its existing fetch.
8. EVERY function SHALL declare `ReservedConcurrentExecutions`. FOR the Backup_Lambda this makes explicit at the function the serialisation that FIFO with a single message group currently provides only as an emergent property, so a later change to the queue cannot silently remove it, and it bounds concurrent pressure on Contentful's rate limits.
9. THE Filter_Lambda's function `Timeout` SHALL be set such that the worst case of its whole sequence — the Last_Update_API request plus every retry and its backoff under criterion 19.4, the Coverage_Check listing, and any publication — completes with margin. THE design SHALL compute that budget rather than discover it, and SHALL state whether the current value suffices.
10. THE abortion of incomplete multipart uploads is required once, by criterion 34.3, and SHALL NOT be restated here with a possibly different value.
11. THE design SHALL state the tested size and duration envelope, and the documentation SHALL record it with its failure symptom.
12. THE measurement establishing that envelope SHALL be the one-time commissioning export authorised by criterion 0.7. ITS Contentful quota cost SHALL be stated in the per-change budget required by criterion 57.6 and recorded in the decision record, and no further untriggered export SHALL be performed.

### Requirement 17: Failures Shall Be Diagnosable by Phase

**User Story:** As an operator, I want the notification to tell me which stage failed, so that a Contentful outage is distinguishable from an S3 permission error without investigation.

#### Acceptance Criteria

1. THE Backup_Lambda SHALL identify each pipeline phase in its errors and logs: parameter retrieval, token validation, export, archive creation, upload, and verification.
2. WHEN a phase fails, THE thrown error SHALL carry the phase identifier.
3. THE phase identifier SHALL appear in the notification required by criterion 7.9.
4. THE Backup_Lambda SHALL NOT wrap the entire pipeline in a single undifferentiated handler that loses the failing phase.
5. THE phase SHALL be recorded as a structured log field and SHALL NOT be promoted to a metric dimension, per Requirement 11.
6. WHERE a phase failure is attributable to Contentful rate limiting or quota exhaustion, THE notification SHALL say so distinctly, because the remedy differs from every other failure.

---

## Part C — Trigger Reliability

### Requirement 18: The Filter Shall Fail Open

**User Story:** As the project owner, I want an unusable input to cause a backup rather than skip one, because a missed backup costs data whereas a redundant one costs a measurable but acceptable amount of quota.

#### Acceptance Criteria

1. WHEN the Last_Update_API response cannot be used to derive a valid timestamp, AND the notification's branch matches the configured target branch per criterion 21.4, THE Filter_Lambda SHALL enqueue a backup and log the reason at error level. FOR a non-matching branch it SHALL NOT enqueue, whatever the response, so a feature-branch build with a flaky endpoint cannot spend production quota.
2. THE Filter_Lambda SHALL treat each of the following as unusable and fail open: an empty JSON object, an entry missing `lastUpdatedAt`, an unparseable date, a value that is not an object, and a JSON error envelope.
3. THE Filter_Lambda SHALL NOT allow an invalid date to be compared numerically such that the comparison yields `false` and the backup is skipped.
4. THE Filter_Lambda SHALL collect all valid timestamps and select the maximum, such that one invalid entry cannot prevent a later valid entry from being considered.
5. THE Filter_Lambda SHALL NOT use a truthiness test to decide whether a candidate timestamp has been established, because an invalid date is a truthy object.
6. WHEN the configured window value is absent or non-numeric, THE Filter_Lambda SHALL fail open and log the condition.
7. THE Filter_Lambda SHALL record the computed interval since the last update as a structured log field, so the margin against the threshold is inspectable.
8. FAILING OPEN SHALL NOT generate a notification, because a redundant backup is not a condition requiring the owner's attention.
9. THE design SHALL state the Contentful quota cost of one redundant backup and SHALL confirm that failing open is the correct trade against a missed backup, given the constraint that quota is scarce.
10. THE Filter_Lambda SHALL NOT enqueue a fail-open backup when the Coverage_Check's listing already shows a conforming backup newer than the configured grace period. THIS bounds repeated fail-open across consecutive builds using the listing the Coverage_Check already performs, so it requires no stored state and no additional permission: the previous fail-open produced a backup, and the next build observes it.
11. A test SHALL assert both directions — that a repeated unusable response does not produce a backup per build once a recent backup exists, and that it does produce one when no recent backup exists.

### Requirement 19: External HTTP Consumption Shall Be Robust

**User Story:** As an operator, I want a slow or broken endpoint to fail fast, so that a transient fault does not silently consume a backup opportunity.

#### Acceptance Criteria

1. THE Filter_Lambda SHALL apply an explicit request timeout well below its own function timeout, because the runtime's default HTTP timeouts exceed it.
2. THE Filter_Lambda SHALL check the response status before parsing, and SHALL NOT parse the body of an unsuccessful response as JSON.
3. THE Filter_Lambda SHALL validate the parsed response's shape before use.
4. THE Filter_Lambda SHALL retry a failed request a documented number of times with backoff before failing open.
5. THE Filter_Lambda SHALL NOT log the complete response body at a level that reaches CloudWatch by default.
6. THE Last_Update_API SHALL be understood and documented as the website's own static output, not a Contentful endpoint, so that requests to it carry no Contentful quota cost.

### Requirement 20: Deduplication Shall Be Derived from Content State

**User Story:** As the project owner, I want a genuinely newer content state to always produce exactly one backup, so that a second edit is not silently discarded and an unchanged state does not waste quota.

#### Acceptance Criteria

1. THE Filter_Lambda SHALL derive `MessageDeduplicationId` from the content state it observed, not from a constant. This reverses Prior_Spec criterion 0.4.
2. WHEN two requests represent the same content state, THE second SHALL NOT cause a Contentful export, regardless of the interval between them. SQS deduplication satisfies this only within its fixed five-minute window; beyond that window the Filter_Lambda SHALL NOT enqueue when the Coverage_Check's listing already shows a conforming backup newer than the content-change timestamp. THAT comparison is already computed, needs no stored state, and suppresses indefinitely rather than for five minutes.
3. WHEN two requests represent different content states, BOTH SHALL be enqueued regardless of how close together they occur.
4. THE Filter_Lambda SHALL retain a constant `MessageGroupId`, so backups remain serialised and cannot run concurrently against Contentful's rate limits.
5. THE Filter_Lambda SHALL NOT infer that a message was enqueued from a successful send response, because a deduplicated send also succeeds.
6. THE design SHALL record that SQS deduplication spans only five minutes, and that criterion 20.2's listing comparison is what extends the guarantee across builds further apart than that.
7. THE test asserting a constant deduplication identifier SHALL be rewritten to assert content-derived behaviour, citing this requirement.

### Requirement 21: Build Status Evaluation Shall Be Anchored and Branch-Scoped

**User Story:** As the project owner, I want build status and branch evaluated deliberately, so that a notification-format change cannot silently stop all backups and a feature-branch build cannot trigger a production one that spends quota.

#### Acceptance Criteria

1. THE Filter_Lambda SHALL extract the build status using a single documented, anchored regular expression with a capture group, applied to the SNS message body. THE Amplify build notification is human-readable prose intended for email delivery, not a structured event: it contains no status field, so structured field extraction is not available and SHALL NOT be claimed. AN anchored pattern with a captured status token is nevertheless materially stronger than the current unanchored substring test, which matches anywhere in the body including in a branch name or commit message. This reverses Prior_Spec criterion 0.6.
2. THE pattern SHALL be asserted against the committed Amplify fixture required by criterion 51.1, which is therefore load-bearing rather than illustrative.
3. WHEN the message does not match the pattern, such that no status token can be captured, THE Filter_Lambda SHALL fail open and log the condition at error level.
4. THE Filter_Lambda SHALL evaluate the notification's branch against a configured target branch, and SHALL NOT enqueue a backup for a non-matching branch. ALL other per-invocation work, including the Coverage_Check, SHALL still run — "no action" means no enqueue, not no evaluation.
5. THE branch is derivable only from the leftmost DNS label of the application URL in the message body, and Amplify sanitises a branch name into that label, so a slash becomes a hyphen. THE comparison SHALL therefore be made against the sanitised subdomain form, the sanitisation rule SHALL be documented, and the template parameter's description SHALL state which form to supply.
6. THE CloudFormation_Template SHALL expose the target branch as a parameter.
7. THE design SHALL record that Amplify configures notifications per branch, so branch filtering is largely already performed by which branches have notifications enabled, and that this in-code check is defence in depth.
8. THE existing property test asserting substring semantics SHALL be rewritten to assert anchored extraction and fail-open behaviour, citing this requirement.
9. THE design SHALL state that a false negative is silent and permanent whereas a false positive costs one redundant backup, and SHALL justify failing open on that basis.
10. THE design SHALL record that the notification wording is Amplify's and can change without notice, that nothing but the Coverage_Check would detect such a change, and that migrating the trigger to Contentful webhooks — deferred under the Scope section — would remove this fragility entirely.

### Requirement 22: Event Envelopes Shall Be Validated

**User Story:** As a developer, I want a malformed event to produce a clear error, so that a diagnostic failure is not indistinguishable from a logic failure.

#### Acceptance Criteria

1. THE Filter_Lambda SHALL validate that the event carries at least one record before accessing it. ONLY an event with ZERO records SHALL throw, with a named error.
2. A record that is present but whose body does not match the expected pattern SHALL be handled by criterion 21.3 — fail open, log at error level, no notification — and SHALL NOT throw. WITHOUT this partition, a benign upstream envelope change would exhaust retries and email the owner on every build.
3. THE Filter_Lambda SHALL iterate the records it is given rather than indexing the first unconditionally.
4. THE Backup_Lambda SHALL validate its event envelope and SHALL NOT raise an unhandled type error on a malformed event.
5. THE Backup_Lambda SHALL accept an SQS-delivered request as its only invocation shape, since no scheduled or synthetic trigger exists.
6. THE Notifier_Lambda SHALL validate its event envelope, SHALL discriminate the SQS batch shape from the asynchronous invocation record shape per criterion 8.3, and SHALL NOT fail in a way that leaves a failure unreported.
7. NO function SHALL access nested event properties without guarding the path.

---

## Part D — Platform and Dependency Currency

### Requirement 23: The Runtime Shall Be Supported

**User Story:** As the project owner, I want the functions on a supported Lambda runtime, so that the stack remains patched and deployable.

#### Acceptance Criteria

1. EVERY Lambda function in the system SHALL target `nodejs24.x`.
2. THE `arm64` architecture SHALL be retained.
3. THE design SHALL record that `nodejs20.x` passed deprecation on 2026-04-30, that function creation is blocked from 2027-02-01 and updates from 2027-03-03, and that the update block is the operative deadline because the template updates the functions on every deployment.
4. THE design SHALL record why `nodejs24.x` is preferred over `nodejs22.x` for identical migration effort.
5. THE full test suite SHALL pass on the target Node version.
6. THE migration SHALL verify the behaviour of global `fetch`, CommonJS resolution, and the built-in test runner on the target version.
7. THE migration SHALL be verified without repeatedly exporting from Contentful; the design SHALL state how the runtime change is validated within the quota constraint.

### Requirement 24: Contentful Tooling Shall Be Current

**User Story:** As the project owner, I want the export library current, so that known export failures are fixed and the library matches the runtime.

#### Acceptance Criteria

1. THE Backup_Lambda SHALL depend on a current major release of `contentful-export`.
2. THE upgrade SHALL be performed together with the runtime upgrade in Requirement 23, because the target library major requires a Node version the current runtime does not provide.
3. THE design SHALL record that the resolved version in the current lockfile is materially behind the published release.
4. THE upgrade SHALL verify that fixes for large-space export stalling and for asset-download error handling are present.
5. AFTER upgrading, THE resolved transitive dependency versions SHALL be verified against known advisories rather than assumed clean.
6. THE design SHALL state whether the new major changes the number of API requests an export makes, since that directly affects the quota constraint, or SHALL record that this was not determined.

### Requirement 25: AWS SDK Dependencies Shall Be Declared

**User Story:** As a developer, I want the SDK the code imports to be a declared dependency, so that the deployed package does not silently depend on runtime internals.

#### Acceptance Criteria

1. EACH Lambda's `package.json` SHALL declare every `@aws-sdk` package its code imports, including those added for notification publishing and bucket listing.
2. THE declared SDK packages SHALL be present in the corresponding lockfile and included in the deployment package.
3. THE design SHALL record that the current lockfiles contain no `@aws-sdk` entries and that both functions therefore ride the runtime-bundled SDK, whose version varies by runtime and region.
4. THE `filter-lambda` manifest and lockfile SHALL be reconciled; the lockfile currently carries packages the manifest does not declare and the code does not import.

### Requirement 26: Known Vulnerabilities Shall Be Remediated

**User Story:** As a security-conscious owner, I want current advisories resolved and the difference between end-of-life and exploitability stated, so that remediation is prioritised on real risk.

#### Acceptance Criteria

1. THE archive library SHALL be upgraded to a version clear of current advisories, as an isolated low-risk change.
2. WHERE the buffered upload is replaced by a stream under Requirement 16, THE archive library MAY be replaced by a streaming alternative, and the choice SHALL be recorded.
3. THE transitive advisories in the Backup_Lambda dependency tree SHALL be resolved, principally by the upgrade in Requirement 24.
4. THE advisories in the deploy tooling tree SHALL be resolved by advancing the AWS SDK past the affected range.
5. THE development dependencies carrying advisories SHALL be upgraded to patched versions.
6. THE documentation SHALL state, for each remediated item, whether a known advisory affected the pinned version and whether the vulnerable code path is reachable in this project.
7. WHERE an advisory affects a code path this project does not exercise, THE documentation SHALL say so rather than implying exploitability.

### Requirement 27: The Toolchain Shall Be Pinned and Installs Reproducible

**User Story:** As a developer, I want one declared Node version and lockfile-faithful installs, so that what is built locally matches what runs in Lambda.

#### Acceptance Criteria

1. THE repository SHALL declare the Node version in a version file at the repository root.
2. EVERY `package.json` SHALL declare an `engines` constraint consistent with the target runtime.
3. ALL documented and scripted installs SHALL use lockfile-faithful installation rather than a resolving install.
4. THE documentation SHALL NOT instruct the operator to run a resolving install before packaging.

### Requirement 28: Dependency Updates Shall Be Surveilled Automatically

**User Story:** As the project owner, I want to be told when a new advisory affects this repository, so that unchanged code does not quietly become vulnerable.

#### Acceptance Criteria

1. THE repository SHALL configure automated dependency update proposals covering every package manifest in the repository.
2. AWS SDK and related packages SHALL be grouped so they advance together.
3. THE Contentful export library SHALL NOT be grouped, so its major upgrades arrive as individually reviewable changes.
4. THE continuous integration workflow SHALL include a dependency audit step with a documented severity threshold.
5. THE audit SHALL also run on a schedule, so a newly published advisory against unchanged code is surfaced.
6. THESE notifications SHALL arrive through the repository host, not through the Alert_Topic, which criterion 6.7 reserves.
7. NO continuous integration or dependency automation SHALL call the Contentful API.

---

## Part E — Deployment Reproducibility

### Requirement 29: Deployment Packaging Shall Be Reproducible

**User Story:** As a developer, I want the deployment package built deterministically from declared contents, so that two people deploying one commit ship the same bytes and no unintended file is included.

#### Acceptance Criteria

1. THE Build_Script SHALL assemble the package from an explicit allow-list of paths, not by sweeping a directory.
2. THE Build_Script SHALL NOT include documentation, lockfiles, editor artefacts, environment files, or test fixtures in the package.
3. THE Build_Script SHALL fail if a `.env` file or any other credential-bearing file would be included.
4. THE Build_Script SHALL fail if production dependencies are not installed.
5. THE Build_Script SHALL install production dependencies only, targeting the deployed platform and architecture.
6. THE Build_Script SHALL fail if the working tree is dirty, so a deployed artefact always corresponds to a commit.
7. THE Build_Script SHALL support every function in the system, including the Notifier_Lambda, through the same parameterised path.
8. THE design SHALL record that repository ignore rules protect version control but not the package, which is why an allow-list is required.

### Requirement 30: Deployment Shall Validate Its Inputs

**User Story:** As a developer, I want a misconfigured deployment to fail immediately with a clear message, so that I am not debugging an opaque API error.

#### Acceptance Criteria

1. THE Build_Script SHALL validate that every required environment variable is present and non-empty before making any AWS call, and SHALL name the missing variable.
2. THE Build_Script SHALL construct its AWS client with an explicit region.
3. THE `.env` example file SHALL document every variable the Build_Script reads, including the region.
4. WHEN a required value is missing, THE Build_Script SHALL exit non-zero with a message naming the variable and its purpose.

### Requirement 31: Deployments Shall Be Traceable and Reversible

**User Story:** As an operator, I want to know which commit is running and be able to return to the previous one, so that a bad deployment is recoverable.

#### Acceptance Criteria

1. THE Build_Script SHALL publish an immutable function version on each deployment.
2. THE Build_Script SHALL record the deployed commit identifier on the function as a resource tag or in the function `Description`, and SHALL NOT record it in an environment variable. THE functions' environment variables are CloudFormation-managed, so writing one would register as stack drift and be silently reverted on the next stack update — in a way indistinguishable from the placeholder reversion Requirement 32 exists to detect. THE deploying principal's documented permissions SHALL include whichever action the chosen mechanism requires.
3. THE immutable version required by criterion 31.1 SHALL be published by the same code-update call rather than a separate publish call, since that call accepts a publish flag.
4. THE Build_Script SHALL report the published version number on completion.
5. THE documentation SHALL give a rollback procedure that retrieves a previously published version's artefact and reapplies it.
6. THE design SHALL record why a Lambda alias is not used, given that CloudFormation cannot manage an alias pointing at the unpublished version and a script-managed alias would reintroduce the drift this specification removes.
7. THE Build_Script or a companion command SHALL retain a documented number of published versions and delete those older, because published versions accumulate code storage permanently and are chargeable beyond the account-wide allowance. THE per-version storage figure SHALL appear in the cost table required by criterion 57.5.

### Requirement 32: Undeployed Placeholder Code Shall Be Detected

**User Story:** As an operator, I want to be told if a stack operation reverted a function to placeholder code, so that a silent reversion cannot go unnoticed.

#### Acceptance Criteria

1. THE Build_Script or a companion verification command SHALL compare each deployed function's code identity against the placeholder's, and SHALL fail loudly on a match.
2. THE documentation SHALL instruct the operator to run the verification after every stack update.
3. THE documentation SHALL enumerate the circumstances in which a stack operation can reinstate placeholder code, including that changing a function-name parameter forces replacement.
4. THE design SHALL record that a live placeholder is caught at runtime by criterion 4.3 for the Backup_Lambda and by criterion 4.4 for the Filter_Lambda, and that with no schedule this deployment-time check is the only proactive detection available.

### Requirement 33: Deployment Documentation Shall Be Executable as Written

**User Story:** As an operator following the documentation, I want the deployment to succeed, so that I am not blocked by an omitted requirement.

#### Acceptance Criteria

1. THE deployment documentation SHALL give the literal deployment command, with every flag written out rather than relying on shell variable expansion.
2. THE command SHALL include the named-IAM capability, without which the deployment is rejected outright.
3. THE command SHALL include the template path, the stack name, the region and the profile.
4. EVERY template parameter SHALL be documented, including its default and any permitted values.
5. THE documentation SHALL state the ordered relationship between the stack deployment and the code deployment, including the interval during which the system is deployed but not functional.
6. A test SHALL assert that the documented parameter list matches the template's parameters exactly, so the two cannot drift.

---

## Part F — Backup Store Durability

### Requirement 34: Lifecycle Configuration Shall Actually Expire Data

**User Story:** As the project owner, I want the stated retention period to free storage, so that I am not billed indefinitely for data I believe has expired.

#### Acceptance Criteria

1. THE Backup_Bucket lifecycle configuration SHALL expire non-current object versions after a documented period.
2. THE lifecycle configuration SHALL remove expired object delete markers.
3. THE lifecycle configuration SHALL abort incomplete multipart uploads after a documented period.
4. THE design SHALL record that on a versioning-enabled bucket an expiration rule creates a delete marker rather than freeing storage, which is why non-current version expiry is required, and that the present configuration therefore retains all expired data indefinitely.
5. THE retention period SHALL be exposed as a template parameter rather than hard-coded.
6. THE retention and transition parameters SHALL be constrained, by their permitted values, such that no selectable combination places an object in a storage class for less than that class's minimum billable duration. THIS replaces any obligation merely to confirm the absence of early-deletion charges, which would be unsatisfiable while the enumerations still permit a combination that incurs them — an object starting in an archive class and transitioning out before that class's minimum is one such. A test SHALL assert the property across the whole permitted parameter domain, and this criterion depends on the enumerations being narrowed first under criteria 42.7 and 42.8.
7. THE `LongTermStorageClass` parameter description SHALL state the retrieval latency implication of the archive classes.
8. THE design SHALL state the expected steady-state storage volume and cost as a function of archive size and the observed frequency of content change, and SHALL record which of those inputs remains unmeasured.
9. THE lifecycle configuration SHALL NOT expire an object in a way that could leave the Coverage_Check finding no backup for a space that is simply quiet. TO enforce this rather than merely state it, the retention parameter SHALL declare a minimum no shorter than the longest quiet interval the design records, and the configuration SHALL retain the newest archive unconditionally. WITHOUT that, a retention period shorter than a quiet interval expires every archive, the listing reports **none** under criterion 9.8, and the owner is emailed a coverage gap on every subsequent build for a space that is merely quiet — breaching criteria 9.14 and 57.12 through a legitimate configuration value.
10. A test SHALL assert the retention parameter's minimum and the unconditional retention of the newest archive.
11. THE design SHALL record that archive storage classes add a per-object metadata and index overhead plus a per-object transition request charge, so for many small archives the transition can cost more than it saves, and SHALL state the break-even archive size.

### Requirement 35: Replacement and Deletion Shall Be Safe

**User Story:** As the project owner, I want no stack operation able to destroy my backups, so that a parameter change cannot target the bucket holding every archive.

#### Acceptance Criteria

1. THE Backup_Bucket SHALL declare `UpdateReplacePolicy: Retain` in addition to its existing `DeletionPolicy: Retain`.
2. THE design SHALL record that `DeletionPolicy` governs only stack deletion, that replacement is governed by `UpdateReplacePolicy`, and that its default is to delete.
3. THE Dead_Letter_Queue SHALL declare a retention policy on stack deletion, so failed-backup evidence is not discarded with the stack.
4. THE log groups SHALL declare a retention policy on stack deletion.
5. THE documentation SHALL identify every template property whose change forces replacement of a resource holding state.

### Requirement 36: Off-Site Durability Shall Be Parameterised for Later Activation

**User Story:** As the project owner, I want replication and immutability available without another specification, so that I can switch them on when a second account is ready.

#### Acceptance Criteria

1. THE CloudFormation_Template SHALL express cross-region and cross-account replication as a condition-gated configuration, disabled by default.
2. WHEN replication is enabled, THE configuration SHALL NOT propagate delete markers to the destination.
3. THE CloudFormation_Template SHALL express object immutability as a condition-gated configuration, disabled by default.
4. WITH both features disabled, THE template SHALL be a no-op against the existing deployed stack, and no existing resource SHALL be replaced or modified as a result of their presence.
5. WITH both features disabled, THEY SHALL add no recurring cost.
6. THE design SHALL record the two constraints that actually apply to object immutability, neither of which is resource replacement: both the enabling property and its configuration are updatable in place on an existing bucket with no interruption, so the literal bucket name is no obstacle and criterion 36.4 is achievable.
7. THE FIRST constraint is irreversibility: once enabled, immutability cannot be disabled and versioning cannot be suspended. A parameter that switches on but never off is not a symmetric toggle, and the parameter description and documentation SHALL say so.
8. THE SECOND constraint is a direct conflict with Requirement 34: a default retention blocks deletion of a version until its retain-until date, including the noncurrent-version expiry that criterion 34.1 requires to stop unbounded storage growth. THE default retention period SHALL therefore be constrained against the retention parameter in Requirement 34, and the design SHALL state which mode is intended and why — one where an authorised principal can override, or one where nobody can until the date passes.
9. A test SHALL assert that an enabled immutability retention cannot exceed the lifecycle retention it would otherwise block.
10. THE documentation SHALL state what each feature protects against and what activating it requires, including its cost.
11. THE design SHALL record that with both disabled, the backups share a region, an account and a blast radius with the system they protect.
12. NEITHER feature, when enabled, SHALL consume Contentful quota, since both operate on stored objects.

### Requirement 37: Transport and Object Policy Shall Be Enforced

**User Story:** As a security-conscious owner, I want the bucket to enforce its own invariants, so that correct behaviour does not depend on every client being well-behaved.

#### Acceptance Criteria

1. THE CloudFormation_Template SHALL attach a bucket policy denying requests not made over TLS.
2. THE bucket policy SHALL deny object writes that do not carry the expected server-side encryption, expressed so that it cannot deny the Backup_Lambda's own upload. TWO hazards SHALL be avoided: the bucket relies on default encryption and an SDK relying on that default sends no encryption header, so a deny conditioned on the header's absence would reject every legitimate write; and a multipart upload carries the header only on the initiating call, so its part uploads — authorised as the same write action — would also be rejected.
3. THE Backup_Lambda SHALL set the server-side encryption value explicitly on its upload, so the header is always present including on the initiating multipart call, and the policy SHALL be expressed as a mismatch test rather than an absence test.
4. THE bucket policy SHALL be proven against a real multipart upload before it is merged, in the same way criterion 37.8 protects the Coverage_Check's listing.
5. THE Backup_Bucket SHALL set ownership controls that disable access control lists.
6. THE design SHALL state that the TLS denial closes a defence-in-depth gap rather than an active exposure, since SDK traffic is already encrypted.
7. THE bucket policy SHALL be expressed as conditions on requests, not as denials of named principals.
8. THE bucket policy SHALL NOT deny the Filter_Lambda's listing required by criterion 9.18, nor the Backup_Lambda's verification listing required by criterion 13.5.

### Requirement 38: Access to Backups Shall Be Auditable

**User Story:** As the project owner, I want a record of who read, listed or deleted a backup, so that I can answer that question when it matters.

#### Acceptance Criteria

1. THE CloudFormation_Template SHALL configure access recording for the Backup_Bucket.
2. THE recording destination SHALL NOT be the Backup_Bucket itself.
3. THE recording mechanism SHALL be one that carries no per-event charge. A per-event mechanism SHALL NOT be selected on any justification, because criteria 11.9 and 57.5 permit no such recurring charge, and the Coverage_Check generates a listing event on every build of either consuming site.
4. THE recording destination SHALL have its own bounded retention, and its storage SHALL appear in the cost table required by criterion 57.5, since access records are neither archives nor CloudWatch Logs and fall outside the existing exclusions.
5. THE design SHALL account for the listing traffic the Coverage_Check adds, since it occurs on every build.

### Requirement 39: Queue Confidentiality and Operability

**User Story:** As a security-conscious owner, I want queue encryption and a working redrive path, so that an audit finding is closed and a failed backup can be replayed.

#### Acceptance Criteria

1. BOTH queues SHALL enable SQS-managed server-side encryption, which carries no per-key monthly charge and requires no KMS grant on any consuming role. A KMS-based option SHALL NOT be used, because an encrypted queue would additionally require a decrypt grant on the consuming function's execution role, which criteria 40.6 and 40.7 enumerate exhaustively.
2. THE design SHALL state that the message body carries no credentials, so this closes an audit finding rather than a live exposure.
3. BOTH queues SHALL declare a resource policy denying non-TLS access.
4. THE Dead_Letter_Queue's redrive-source declaration SHALL be expressed without creating a circular template dependency. BECAUSE the source queue's own redrive policy already references the Dead_Letter_Queue by attribute, the reverse reference SHALL construct the source queue's ARN as a string from the partition, region, account and stack-derived queue name, which creates no dependency edge.
5. THE design SHALL record that the Notifier_Lambda's consumption of the Dead_Letter_Queue makes redrive from that queue permanently unavailable: an event source mapping deletes each message within seconds of arrival, long before a human reads the email. THIS is a stated limitation, not an alternative to be weighed — the mitigation is criterion 7.8's logging of the full message body and criterion 9.21's manual enqueue command.
6. THE redrive-source declaration SHALL NOT be described as what enables an operator to replay a message. IT declares which source queues may designate this queue as their dead-letter target, and its default already permits all, so adding it is a security tightening rather than an enablement.
7. THE documentation SHALL state that re-enqueueing a backup causes a further Contentful export and therefore consumes quota, so an operator does so deliberately rather than reflexively.

### Requirement 40: IAM Grants Shall Be Least Privilege

**User Story:** As a security-conscious owner, I want each role to hold only what its code uses, so that a compromised function has the smallest possible reach.

#### Acceptance Criteria

1. NO role SHALL grant a logs action against an account-wide wildcard resource.
2. EVERY log action SHALL be scoped to the specific log group the function writes to.
3. THE template SHALL express decryption permission for the SSM parameters conditionally, so that re-creating the parameters under a customer-managed key does not break retrieval.
4. THE design SHALL record that no explicit decryption grant is required for the default service key, that the permission is conferred by the key policy, and that adding an unconditional wildcard grant would therefore be an over-grant.
5. THE design SHALL record that a decryption failure is presently swallowed, and that Requirements 1 and 7 are what make such a failure visible.
6. THE Filter_Lambda role SHALL hold exactly: `sqs:SendMessage` on the SQS_Queue; `s3:ListBucket` on the Backup_Bucket; `sns:Publish` on the Alert_Topic with the KMS actions criterion 7.12 requires; `lambda:InvokeFunction` on the Notifier_Lambda per criterion 8.4; read and write on the single suppression store criterion 9.16 declares; and its own log-group writes.
7. THE Notifier_Lambda role SHALL hold exactly: its queue-consumption actions on the Dead_Letter_Queue; `sns:Publish` on the Alert_Topic with the KMS actions criterion 7.12 requires; and its own log-group writes.
8. THE Backup_Lambda role SHALL hold exactly: the three SQS actions criterion 2.2 requires on the SQS_Queue; `s3:PutObject` and `s3:AbortMultipartUpload` on the Backup_Bucket; `s3:ListBucket` on the Backup_Bucket for the verification in criterion 13.5; `ssm:GetParameters` on both token parameters with the conditional decrypt grant in criterion 40.3; `sns:Publish` on the Alert_Topic with the KMS actions criterion 7.12 requires; and its own log-group writes.
9. NO role SHALL be granted `s3:GetObject` or `s3:GetObjectVersion` on the Backup_Bucket, since no code path reads object contents and both the Coverage_Check and the upload verification require listing only.
10. EVERY IAM grant remaining after this work SHALL be traceable to a code path that uses it, or be documented as deliberately retained.
11. THE three SQS actions retained under criterion 2.2 SHALL be recorded as deliberately retained, since they are required by the service rather than by the function's own code.

---

## Part G — Template Quality

### Requirement 41: The Stack Shall Be Deployable More Than Once

**User Story:** As a developer, I want to deploy a second instance of this system in one account, so that I can validate changes without touching the production stack.

#### Acceptance Criteria

1. NO IAM role SHALL declare a fixed physical name.
2. NEITHER queue SHALL declare a fixed physical name; queue names SHALL be derived from the stack while preserving the FIFO suffix requirement and the length limit.
3. THE design SHALL record that the prior specification's multi-environment objective was not achieved because only function names were parameterised, and that the property test passed because it scanned only function names.
4. THE property test SHALL be widened from function names to all physical resource names.
5. THE design SHALL state the migration consequence of renaming an existing queue, including that messages in flight in the replaced queue are lost.
6. A SECOND deployment SHALL target either a non-production Contentful space or be deployed with its Event_Source_Mapping disabled by the parameter criterion 4.5 provides. THIS is normative, not advisory: a recommendation cannot discharge the Governing Constraints' prohibition on a backup that is not required, and a second stack against the production space would double quota consumption.

### Requirement 42: Parameters Shall Be Validated and Enumerations Safe

**User Story:** As an operator, I want a mistyped or unusable parameter value rejected at deployment time, so that a typo does not become a silently broken system.

#### Acceptance Criteria

1. EVERY ARN parameter SHALL declare a pattern constraint with a constraint description.
2. THE URL parameter SHALL require a secure scheme.
3. THE bucket name parameter SHALL declare a pattern consistent with S3 naming rules.
4. THE alert email parameter SHALL declare a pattern constraint.
5. THE update window parameter SHALL declare a minimum no lower than the worst-case observed Amplify build duration for either consuming site, plus margin, and a maximum. THE design SHALL record those measured durations and justify the default against them. WITHOUT this bound the existing 10-minute default is a permanent no-backup path: the Filter_Lambda runs only when a build completes, so a content change whose build takes longer than the window is never backed up at all, and the Coverage_Check would then report that design defect as a recurring coverage gap rather than a late backup.
6. WHERE criterion 0.3 forbids changing an existing parameter's default, the minimum introduced here SHALL be treated as the carve-out that criterion permits by tightening validation, and the design SHALL state whether the current default satisfies the new minimum.
7. THE coverage grace period parameter SHALL declare a minimum and a maximum.
8. THE clock-skew tolerance parameter required by criterion 9.11 SHALL declare a minimum and a maximum.
9. THE retention parameter SHALL declare the minimum required by criterion 34.9, and the log retention parameter SHALL declare permitted values drawn from the set CloudWatch Logs accepts, so a value the service rejects cannot be supplied.
10. THE initial storage class enumeration SHALL NOT offer a class that is invalid for a general-purpose bucket, nor a deprecated class that costs more than the default.
11. THE storage class parameters SHALL be constrained so that an impossible transition cannot be selected, and so that no permitted combination breaches criterion 34.6's minimum-duration constraint.
12. THE template SHALL group and label its parameters for the console, since deployment is performed by hand.
13. THE design SHALL record the decision not to mask any parameter, on the grounds that none carries a secret, and SHALL record the deferral of a customer-managed key with its rationale, noting that criterion 6.3 may reopen that deferral.

### Requirement 43: The Stack Shall Publish Its Interface and Attribute Its Cost

**User Story:** As an operator, I want the stack to expose its own resource identifiers and carry cost attribution, so that tooling need not hard-code names and I can see what the system costs.

#### Acceptance Criteria

1. THE CloudFormation_Template SHALL publish outputs for the bucket, both queues, every function name, and the Alert_Topic.
2. THE Build_Script SHALL take the function names from the stack rather than from a duplicated configuration value, or the design SHALL record why it does not.
3. THE deployment documentation SHALL instruct the operator to apply stack-level tags, which propagate to taggable resources.
4. THE documentation SHALL state that the tag keys must also be activated for cost reporting, which is a separate manual step.

### Requirement 44: Infrastructure Shall Be Statically Analysed

**User Story:** As a developer, I want the template checked by a tool that knows the resource schemas, so that a schema or security error is caught before deployment.

#### Acceptance Criteria

1. THE repository SHALL include a template linting step invocable as a project script.
2. THE repository SHALL include a policy or security scanning step for the template.
3. BOTH SHALL run in continuous integration.
4. THE design SHALL record that the existing template tests assert only the requirements previously written and would pass most of this specification's findings.

---

## Part H — Test Suite Efficacy

### Requirement 45: Vacuous Tests Shall Be Removed or Repaired

**User Story:** As a developer, I want every test capable of failing, so that a green suite is evidence rather than decoration.

#### Acceptance Criteria

1. THE tests that assert against the presence of literal strings in a source file rather than that source's behaviour SHALL be replaced with behavioural tests.
2. THE prototype-pollution test whose poison keys are shadowed by its own generated keys SHALL be repaired so that an incorrect iteration strategy genuinely fails it.
3. THE tests asserting a completed one-time migration, which can never fail again, SHALL be replaced or removed.
4. THE tautological response-shape test SHALL be replaced with one asserting an invariant the implementation could violate.
5. THE dead helper function in the template test file SHALL be either used or removed.
6. THE duplicated stubbing preamble SHALL be extracted into a shared helper.

### Requirement 46: Failure Paths Shall Be Covered

**User Story:** As a developer, I want the failure behaviour asserted, so that the defects this specification fixes cannot return.

#### Acceptance Criteria

1. A test SHALL assert that the Backup_Lambda rejects when the upload fails, rather than resolving with an error-shaped object.
2. A test SHALL assert that the Backup_Lambda rejects on export failure, on parameter-retrieval failure, and on verification failure.
3. A test SHALL assert that a missing or empty token causes an immediate, named failure before any Contentful call is attempted.
4. A test SHALL assert that incomplete asset downloads cause a rejection.
5. A test SHALL assert that a notification is published before the Backup_Lambda rethrows, and that a publication failure does not suppress the throw.
6. A test SHALL assert that a successful backup publishes NO notification.
7. A test SHALL assert that the Notifier_Lambda publishes for a message it receives and logs that message's body.
8. A test SHALL assert that the Filter_Lambda enqueues a backup for every unusable Last_Update_API response enumerated in Requirement 18.
9. A test SHALL assert that an unrecognised build-notification format causes a backup rather than a skip.
10. NO test SHALL make a real Contentful API call.

### Requirement 47: The Coverage Check Shall Be Covered

**User Story:** As a developer, I want the coverage logic asserted at its boundaries, so that it neither cries wolf during a quiet period nor stays silent when a backup is genuinely missing.

#### Acceptance Criteria

1. A test SHALL assert that a content change newer than the newest backup, older than the grace period, produces a notification.
2. A test SHALL assert that a content change newer than the newest backup but within the grace period produces NO notification.
3. A test SHALL assert that a backup newer than the last content change produces NO notification.
4. A test SHALL assert that a long quiet period with no content change produces NO notification, however old the newest backup is.
5. A test SHALL assert that an empty Backup_Bucket combined with a real content change is treated as the determinate **none** outcome and produces a notification once the grace period has elapsed, per criterion 9.8.
6. A test SHALL assert that a listing failure or an exceeded page bound is treated as **indeterminate** and produces NO notification, per criterion 9.9. THE distinction between an empty listing and a failed listing SHALL be asserted explicitly, since both once read as "cannot determine".
7. A test SHALL assert that an invocation which enqueues a backup for the content state under comparison publishes NO coverage-gap notification for that state, per criterion 9.10.
8. A test SHALL assert that equal timestamps produce NO notification, and SHALL cover the clock-skew tolerance at its boundary, per criterion 9.11.
9. A test SHALL assert that the Coverage_Check does not enqueue a backup.
10. A test SHALL assert that the Coverage_Check runs for a build whose branch does not match the target, per criterion 21.4.
11. A test SHALL assert the repeat-suppression behaviour required by criterion 9.16.
12. A test SHALL assert that a key not matching the documented archive pattern is ignored, so an unrelated object cannot be mistaken for the newest backup.
13. A test SHALL assert that the comparison uses the key-derived timestamp and not the object's last-modified time, per criterion 9.2.

### Requirement 48: Filesystem and Lifecycle Behaviour Shall Be Covered

**User Story:** As a developer, I want the working-directory behaviour exercised against a real filesystem, so that the contamination defect is observable in a test.

#### Acceptance Criteria

1. THE Backup_Lambda SHALL accept its working directory location through configuration so a test can direct it at a scratch location.
2. A test SHALL invoke the handler twice against the same scratch location and assert that the second archive contains exactly one export.
3. A test SHALL assert that the working directory is removed after both a successful and a failed invocation.
4. THE tests covering this behaviour SHALL NOT stub the filesystem or the archive library in a way that makes the behaviour unobservable.
5. ALL scratch directories SHALL be created under the test runner's temporary location and removed on completion.

### Requirement 49: Generators Shall Explore Adversarial Input

**User Story:** As a developer, I want property tests that generate the inputs which actually break the code, so that the risky space is explored rather than excluded.

#### Acceptance Criteria

1. THE date and dictionary generators SHALL include invalid dates, empty objects, absent fields, null values and non-object values, rather than filtering them out.
2. THE property test oracles SHALL assert that a derived date is valid, because an equality assertion between two invalid results passes.
3. THE configuration-selection generator SHALL NOT exclude inherited property names; the implementation SHALL instead be corrected to use an own-property check.
4. THE status-code generators SHALL include absent metadata and non-numeric values.
5. THE Coverage_Check SHALL be property-tested across the full ordering of content and backup timestamps, including equality and clock-skew cases.
6. WHERE upgrading the property testing library surfaces new counterexamples, THOSE SHALL be treated as findings about the code rather than as test breakage.

### Requirement 50: Template Invariants Shall Be Enforced by Test

**User Story:** As a developer, I want the template's internal consistency asserted, so that two requirements cannot silently cancel each other out again and so that the no-cost, no-quota decisions cannot erode unnoticed.

#### Acceptance Criteria

1. A test SHALL assert that the queue's message retention exceeds its visibility timeout multiplied by the maximum receive count.
2. A test SHALL assert that the visibility timeout is at least six times the function timeout.
3. A test SHALL assert that the template declares no alarm, no composite alarm, no metric filter and no dashboard, enforcing Requirement 11.
4. A test SHALL assert that the template declares no scheduled rule or other time-based trigger, enforcing criterion 11.7.
5. A test SHALL assert that no source file publishes a custom metric, enforcing criterion 11.5.
6. A test SHALL assert that the Dead_Letter_Queue has an Event_Source_Mapping to the Notifier_Lambda.
7. A test SHALL assert that every role granted `sns:Publish` is scoped to the Alert_Topic alone.
8. A test SHALL assert that NO role holds `s3:GetObject` or `s3:GetObjectVersion` on the Backup_Bucket, and that the Filter_Lambda and Backup_Lambda roles each hold `s3:ListBucket`. SCOPING this to the Filter_Lambda alone would miss the Backup_Lambda, where the verification in criterion 13.5 is the likelier place such a grant would be added.
9. A test SHALL assert that no resource whose name must be unique per account or per region declares a fixed physical name, INCLUDING via a parameter default. AN exemption for parameter defaults would swallow the requirement: moving a queue name into a default would pass the test while leaving the stack undeployable twice — structurally the same defect criterion 41.3 records against the prior attempt.
10. A test SHALL assert that every internal template reference resolves to a declared logical identifier or parameter.
11. A test SHALL assert that the lifecycle configuration expires non-current versions.

### Requirement 51: External Contracts Shall Be Fixtured

**User Story:** As a developer, I want tests driven by real payload shapes, so that a format assumption is recorded and testable.

#### Acceptance Criteria

1. THE repository SHALL contain a representative Amplify build-notification payload as a committed fixture.
2. THE repository SHALL contain a representative SQS FIFO record as a committed fixture.
3. THE repository SHALL contain a representative Last_Update_API response as a committed fixture.
4. THE repository SHALL contain a representative S3 listing response as a committed fixture, for the Coverage_Check.
5. EVERY handler SHALL be tested against the fixtures that apply to it.
6. THE fixtures SHALL contain no real account identifiers, tokens or personal data.

### Requirement 52: Test Efficacy Shall Be Measured

**User Story:** As the project owner, I want a number describing how much the tests actually protect, so that suite quality is observable rather than asserted.

#### Acceptance Criteria

1. THE project SHALL measure and report test coverage using the runtime's built-in capability, adding no dependency.
2. THE project SHALL include a linting configuration whose rules would have caught the residual defects in Requirement 55.
3. A mutation analysis SHALL be performed at least once, and the surviving mutants SHALL be recorded under `docs/`.
4. THE recorded result SHALL name each test that survives every mutation, as the measurable form of Requirement 45.

### Requirement 53: Changes Shall Be Verified Automatically

**User Story:** As the project owner, I want the suite to run without a human remembering to run it, so that a broken change cannot be committed unnoticed.

#### Acceptance Criteria

1. THE repository SHALL define a continuous integration workflow that runs on push and on pull request.
2. THE workflow SHALL install dependencies from lockfiles, run the full test suite, run the linters, and run the template analysis from Requirement 44.
3. THE workflow SHALL run the dependency audit from Requirement 28.
4. THE workflow SHALL NOT deploy, and SHALL NOT require long-lived AWS credentials.
5. THE workflow SHALL run on the Node version declared in Requirement 27.
6. THE workflow SHALL incur no AWS charge and SHALL consume no Contentful quota.

---

## Part I — Documentation and Hygiene

### Requirement 54: Documentation Shall Be Accurate

**User Story:** As a newcomer to this repository, I want the documentation to describe the system that exists, so that I am not sent to files and procedures that do not work.

#### Acceptance Criteria

1. THE root README's repository structure section SHALL list every top-level directory and SHALL NOT reference the relocated template's former location.
2. THE root README SHALL NOT claim documentation exists where it does not.
3. THE root README's architecture description SHALL include the parameter store dependency, the Last_Update_API dependency, the dead-letter queue, the notification paths, the Coverage_Check, and the conditions under which a backup does and does not occur.
4. THE root README SHALL state the notification philosophy: email on failure or coverage gap only, no alarms, no metrics, no schedule, and no monitoring that consumes Contentful quota.
5. THE root README SHALL state the Contentful quota constraint as a design driver, so a future contributor does not reintroduce a scheduled backup.
6. THE Filter_Lambda documentation SHALL specify the Last_Update_API contract completely enough to implement against, including the JSON shape, a worked example, the timestamp format, and the fail-open behaviour on an unusable response.
7. THE Filter_Lambda documentation SHALL describe the Coverage_Check, its grace period, and the conditions under which it notifies and does not.
8. THE Filter_Lambda documentation SHALL state that its output is conditional, naming both conditions.
9. THE Backup_Lambda documentation SHALL record the S3 key format, the archive's internal layout including the manifest, the working directory, and the tested size and duration envelope with its failure symptom.
10. THE Notifier_Lambda SHALL have documentation describing its trigger, its output, and the failure classes it exists to cover.
11. A test SHALL assert that no documentation file references the former template location.
12. ALL new documentation SHALL be created under `docs/`, except files conventionally located at the repository root.

### Requirement 55: Residual Code Defects Shall Be Swept

**User Story:** As a developer, I want the defect classes the prior specification fixed one instance of to be eliminated everywhere, so that the codebase does not read as half-modernised.

#### Acceptance Criteria

1. THE first-party source under `backup-lambda/`, `filter-lambda/`, `deploy/` and `tests/` SHALL contain no remaining `new Buffer` construction, including the `new Buffer.from(...)` form at the archive-read site, which evaluates correctly only by accident.
2. THAT same source SHALL contain no remaining loose equality comparison.
3. THAT same source SHALL contain no remaining `var` declaration where block scoping is correct, including the message binding in the Filter_Lambda's record handling.
4. THAT same source SHALL contain no unused variable, unused binding, or unreachable branch — including the unused content-file path and date-prefix bindings and the retained-but-unused export result in the Backup_Lambda.
5. THE unreachable status-code branch removed from the Backup_Lambda by criterion 1.4 SHALL also be removed from `deploy/build-lambda.js`, which contains the identical dead check. THE existing deploy-status property test asserts that branch, so it SHALL be removed rather than strengthened — criterion 49.4 SHALL apply its generators to whatever check remains, not preserve a branch that cannot execute.
6. THE typographical error in the Backup_Lambda README's description of the Contentful space identifier SHALL be corrected.
7. THE linting configuration from criterion 52.2 SHALL enforce each of the above, so the class cannot recur.
8. THE `await` applied to the synchronous archive-creation call SHALL be removed so the call's blocking nature is not disguised.

### Requirement 56: Decisions and Changes Shall Be Recorded

**User Story:** As the project owner, I want the reasoning behind this work recorded in the repository, so that a future reader can tell a deliberate decision from an oversight, and so that nobody reintroduces a scheduled backup.

#### Acceptance Criteria

1. THE repository SHALL contain a changelog recording changes that affect the archive format, the backup's content scope, the notification behaviour, or the deployment procedure.
2. THE changelog SHALL record that the archive's content scope changes to published-state only.
3. THE repository SHALL contain a decision record under `docs/` capturing: the supersession in Requirement 0; the Contentful quota constraint and the consequent prohibition on scheduled, periodic or synthetic backups; the decision to notify by event-driven email with no alarms, metrics, metric filters or dashboards, together with the measured unit prices and the alert-fatigue reasoning; the rejection of a staleness alarm and of a scheduled liveness backup, and the adoption of the Coverage_Check in their place; the deployment model choice and the absence of an alias; the deferral of a customer-managed key; the deferral of replication and immutability; the deferral of the webhook trigger migration; the retention of the current licence despite the review's finding; and the exclusion of restore capability from this specification.
4. EACH deferral SHALL record what was deferred, why, and what activating it would require, including its cost in currency and in Contentful quota.
5. THE decision record SHALL state plainly what the system cannot detect, so that the accepted risk is inherited knowingly.
6. THE repository SHALL contain an editor configuration file.
7. THE repository ignore rules SHALL be corrected: the stale test path rule removed, the specification directory's tracking made explicit, and the environment example file protected against a future tightening of the environment file pattern.

---

## Non-Functional Requirements

### Requirement 57: Operating Constraints

#### Acceptance Criteria

1. ALL infrastructure SHALL be expressed as CloudFormation YAML under `infrastructure/`, per the project's infrastructure standard. No other infrastructure tooling SHALL be introduced.
2. ALL tests SHALL use the Node built-in test runner with the existing property testing library, under `tests/<area>/`.
3. ALL AWS command examples SHALL name an explicit region and a profile, per the project's command standards.
4. NO change SHALL introduce a recurring monthly AWS charge that is not stated, justified and quantified in the design against prices retrieved from the AWS Price List API.
5. THE design SHALL present a per-item cost table for everything this specification adds, and the total recurring addition SHALL be zero at rest excluding log ingestion, log storage, S3 storage for archives, S3 storage for the access records required by Requirement 38, and published-version code storage bounded by criterion 31.7. THE table SHALL name any free-tier allowance the zero-at-rest claim depends on.
6. NO change SHALL increase the number of Contentful API requests made per content change, and the design SHALL present a per-change request budget showing this.
7. NO component SHALL call Contentful other than the Backup_Lambda performing an export in response to a real content change.
8. THE work SHALL proceed on a feature branch, one commit per completed task, and SHALL NOT be committed to a protected branch.
9. EVERY task SHALL leave the build and the full test suite passing before it is committed.
10. NO credential, account identifier, space identifier or token SHALL be committed at any point.
11. AT every commit, THE repository SHALL be in a state from which a working system can be deployed: no task SHALL leave the codebase unable to produce a backup. THIS constrains the repository, not the deployed stack — criterion 33.5 owns the interval during which a stack is deployed but its real code is not yet applied, and the two SHALL NOT be read as conflicting.
12. THE atomic change set comprising the runtime upgrade, the export library major, the archive library replacement and the streamed upload SHALL land together, because separating them would leave the suite failing between commits in breach of criterion 57.9.
13. THE owner SHALL receive no email from this system during normal operation.
