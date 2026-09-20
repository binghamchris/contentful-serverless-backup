'use strict';

// Filter Lambda handler.
//
// Task 9 (fail open, robust HTTP, two endpoints, structured status/branch) and
// task 10 (Coverage_Check + SSM suppression store) composed here. Folds task
// 8's SDK-v3 and task 7's generator/oracle test repairs for this function.
//
// Design contract (design.md, Filter section + Coverage_Check section):
//   - All AWS clients: explicit connectionTimeout, requestTimeout, maxAttempts:2.
//   - Fetches carry AbortSignal timeouts + status + shape checks + bounded retry.
//   - An overall handler deadline that RETURNS (fail open, no email) on exhaustion.
//   - Envelope: zero records -> throw; unrecognised body -> fail open, no email.
//   - Anchored status regex with a capture group; fail open on no match.
//   - Branch from the sanitised leftmost DNS label vs TargetBranch.
//   - contentTs = max across BOTH LastUpdate endpoints; no truthiness test.
//   - Steps 4 (fetch) and 5 (list) run regardless of branch/status.
//   - Coverage_Check decides enqueue + coverage email; SSM store bounds suppression.
//
// Requirements: 18.x, 19.x, 20.x, 21.x, 22.x, 9.16, 30-34.

const {
  SQSClient, SendMessageCommand,
} = require('@aws-sdk/client-sqs');
const {
  S3Client, ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const {
  SSMClient, GetParameterCommand, PutParameterCommand,
} = require('@aws-sdk/client-ssm');
const {
  SNSClient, PublishCommand,
} = require('@aws-sdk/client-sns');
const {
  ARCHIVE_KEY, toEpoch, parseStoreState, decide,
} = require('./coverage-check');

// Explicit timeouts, never SDK defaults — a throttled call on defaults can
// consume tens of seconds and a Filter timeout is an unhandled crash that
// emails on every slow build.
const AWS_CFG = {
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 2000, requestTimeout: 4000 },
};
const sqsClient = new SQSClient(AWS_CFG);
const s3Client = new S3Client(AWS_CFG);
const ssmClient = new SSMClient(AWS_CFG);
const snsClient = new SNSClient(AWS_CFG);

// Anchored: captures a build status token. Fail open on no match.
const STATUS_RE = /"?jobStatus"?\s*[:=]\s*"?(SUCCEED|FAILED|CANCELLED|STARTED)\b/i;

const DEFAULTS = {
  graceMs: 30 * 60 * 1000,     // 30 min
  skewMs: 5 * 1000,            // 5 s (NTP scale)
  reNotifyMs: 6 * 60 * 60 * 1000, // 6 h
  handlerDeadlineMs: 25 * 1000,   // under the 30s function timeout
  fetchTimeoutMs: 3000,
  fetchAttempts: 2,
  minArchiveBytes: 128,
};

// --- helpers ---------------------------------------------------------------

// Fetch one last-update endpoint, fail-open to null on ANY unusable response.
async function fetchLatestTimestamp(url, deadlineAt) {
  if (!url) return null;
  for (let attempt = 0; attempt < DEFAULTS.fetchAttempts; attempt += 1) {
    if (Date.now() > deadlineAt) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULTS.fetchTimeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'AWS-Lambda-Filter-Function/2.0' },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = await res.json();
      return maxTimestampFrom(json); // null if no usable timestamp — fail open
    } catch {
      clearTimeout(timer);
      // fall through to retry / return null
    }
  }
  return null;
}

// Pure: extract the maximum lastUpdatedAt epoch from a Last_Update_API payload.
// Handles BOTH shapes seen in production and in the original design:
//   - an ARRAY of { table, lastUpdatedAt } objects (both prod endpoints), and
//   - an OBJECT keyed by table name whose values carry lastUpdatedAt.
// Any entry without a usable timestamp is ignored; returns null (fail open)
// when the payload is unusable or carries no parseable timestamp at all.
function maxTimestampFrom(json) {
  if (!json || typeof json !== 'object') return null;
  const entries = Array.isArray(json) ? json : Object.values(json);
  let maxEpoch = null;
  for (const entry of entries) {
    const e = toEpoch(entry && entry.lastUpdatedAt);
    if (e !== null && (maxEpoch === null || e > maxEpoch)) maxEpoch = e;
  }
  return maxEpoch;
}

// Sanitise a build's app URL to its Amplify branch (leftmost DNS label).
function branchFromUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const host = new URL(rawUrl).hostname;
    const label = host.split('.')[0];
    // Amplify sanitises branch names to [a-z0-9-]; mirror that.
    return label ? label.toLowerCase().replace(/[^a-z0-9-]/g, '-') : null;
  } catch {
    return null;
  }
}

// List the bucket, returning found(at)|none|indeterminate from the archive keys.
async function listArchiveOutcome(bucket) {
  try {
    let newest = null;
    let token;
    let pages = 0;
    do {
      // eslint-disable-next-line no-await-in-loop
      const res = await s3Client.send(new ListObjectsV2Command({
        Bucket: bucket, ContinuationToken: token,
      }));
      for (const o of res.Contents || []) {
        if (!ARCHIVE_KEY.test(o.Key)) continue; // excludes .partial.zip & staging keys
        if (typeof o.Size === 'number' && o.Size < DEFAULTS.minArchiveBytes) continue;
        // Newest by KEY timestamp (the tail of the key), not LastModified.
        const m = o.Key.match(/(\d{4})\/(\d{2})\/(\d{2})\/[^/]*?(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z\.zip$/);
        let epoch = null;
        if (m) {
          epoch = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
        }
        if (!Number.isFinite(epoch)) return { kind: 'indeterminate', reason: `unparseable archive key: ${o.Key}` };
        if (newest === null || epoch > newest) newest = epoch;
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
      pages += 1;
      if (pages > 1000) return { kind: 'indeterminate', reason: 'page bound exceeded' };
    } while (token);
    return newest === null ? { kind: 'none' } : { kind: 'found', at: newest };
  } catch (err) {
    return { kind: 'indeterminate', reason: `listing failed: ${err && err.message}` };
  }
}

async function readStore() {
  if (!process.env.SUPPRESSION_PARAM) return {};
  try {
    const res = await ssmClient.send(new GetParameterCommand({ Name: process.env.SUPPRESSION_PARAM }));
    return parseStoreState(res.Parameter && res.Parameter.Value);
  } catch {
    return {}; // initial/absent -> no suppression
  }
}

async function writeStore(next) {
  if (!process.env.SUPPRESSION_PARAM) return;
  try {
    await ssmClient.send(new PutParameterCommand({
      Name: process.env.SUPPRESSION_PARAM,
      Type: 'String',
      Overwrite: true,
      Value: JSON.stringify(next),
    }));
  } catch (err) {
    // Swallow — a throw here would itself email.
    console.error(`Suppression store write failed (swallowed): ${err && err.message}`);
  }
}

// --- handler ---------------------------------------------------------------

exports.handler = async (event) => {
  const startedAt = Date.now();
  const deadlineAt = startedAt + DEFAULTS.handlerDeadlineMs;

  // Envelope: zero records -> throw (async -> Notifier -> email).
  const records = event && event.Records;
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('Filter Lambda invoked with no records');
  }

  // Unrecognised body -> fail open (no email). The SNS message is a string.
  const sns = records[0] && records[0].Sns;
  const body = sns && typeof sns.Message === 'string' ? sns.Message : null;
  if (body === null) {
    console.log('Unrecognised record body — failing open, no email');
    return { statusCode: 200, body: 'ignored: unrecognised body' };
  }

  // Status: anchored regex with a capture group; fail open (statusCaptured=false)
  // when it does not match a success.
  const statusMatch = STATUS_RE.exec(body);
  const statusCaptured = !!statusMatch && statusMatch[1].toUpperCase() === 'SUCCEED';

  // Branch: leftmost sanitised DNS label of the app URL vs TargetBranch.
  let appUrl = null;
  try {
    const parsed = JSON.parse(body);
    appUrl = parsed && (parsed.appUrl || parsed.url || (parsed.detail && parsed.detail.appUrl));
  } catch {
    const m = body.match(/https?:\/\/[^\s"']+/);
    appUrl = m ? m[0] : null;
  }
  const branch = branchFromUrl(appUrl);
  const targetBranch = (process.env.TARGET_BRANCH || '').toLowerCase();
  // If no target configured, treat every branch as matching (opt-in narrowing).
  const branchMatches = !targetBranch || (branch !== null && branch === targetBranch);

  // Steps 4 & 5 run regardless of branch/status.
  const [tsA, tsB, archiveOutcome] = await Promise.all([
    fetchLatestTimestamp(process.env.LAST_UPDATE_API_URL, deadlineAt),
    fetchLatestTimestamp(process.env.LAST_UPDATE_API_URL_2, deadlineAt),
    listArchiveOutcome(process.env.S3_BUCKET_NAME),
  ]);

  if (Date.now() > deadlineAt) {
    console.log('Handler deadline exceeded — failing open, no email');
    return { statusCode: 200, body: 'deadline: fail open' };
  }

  // Max content timestamp across BOTH endpoints; no truthiness test.
  const candidates = [tsA, tsB].filter((e) => e !== null);
  const contentTs = candidates.length ? Math.max(...candidates) : null;

  const storeState = await readStore();
  const now = Date.now();

  const { enqueue, coverage } = decide({
    contentTs, archiveOutcome, now,
    graceMs: DEFAULTS.graceMs, skewMs: DEFAULTS.skewMs, reNotifyMs: DEFAULTS.reNotifyMs,
    statusCaptured, branchMatches, storeState,
  });

  const stateKey = contentTs !== null ? String(contentTs) : null;
  let nextStore = { ...storeState };

  if (enqueue) {
    // Dedup id derived from content state; constant group id.
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: process.env.SQS_QUEUE_URL,
      MessageBody: `Backup needed; content state ${stateKey}`,
      MessageDeduplicationId: stateKey || `nots-${now}`,
      MessageGroupId: 'backup',
    }));
    if (stateKey) {
      nextStore.enqueuedContentChange = stateKey;
      nextStore.enqueuedAt = new Date(now).toISOString();
    }
  }

  if (coverage.notify && process.env.ALERT_TOPIC_ARN) {
    await snsClient.send(new PublishCommand({
      TopicArn: process.env.ALERT_TOPIC_ARN,
      Subject: 'Contentful backup coverage gap',
      Message: `A content change appears uncovered by any backup archive.\nReason: ${coverage.reason}\nContent state: ${stateKey}`,
    }));
    if (stateKey) {
      nextStore.notifiedContentChange = stateKey;
      nextStore.notifiedAt = new Date(now).toISOString();
    }
  }

  if (enqueue || coverage.notify) {
    await writeStore(nextStore);
  }

  console.log(JSON.stringify({
    statusCaptured, branch, branchMatches, contentTs, archiveOutcome: archiveOutcome.kind,
    enqueue, coverageNotify: coverage.notify, coverageReason: coverage.reason,
    elapsedMs: Date.now() - startedAt,
  }));

  return { statusCode: 200, body: JSON.stringify({ enqueue, coverageNotify: coverage.notify }) };
};

// Named exports for testability.
exports.fetchLatestTimestamp = fetchLatestTimestamp;
exports.maxTimestampFrom = maxTimestampFrom;
exports.branchFromUrl = branchFromUrl;
exports.listArchiveOutcome = listArchiveOutcome;
exports.STATUS_RE = STATUS_RE;
