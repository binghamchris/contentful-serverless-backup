'use strict';

// Notifier Lambda handler.
//
// The terminus of every failure path. Consumes the DLQ (SQS batch shape) and
// can also receive an async-invocation failure record (Filter OnFailure shape).
// It formats and publishes a failure notification and NEVER calls Contentful
// and NEVER triggers a backup.
//
// Design contract (design.md + tasks 11):
//   - Discriminate the SQS-batch shape from the async-invocation-record shape.
//   - Log the full failed body.
//   - Publish a formatted notification: failing phase where knowable, UTC
//     timestamp, space/environment, error, and a Logs Insights query over the
//     correlating messageId (INFREQUENT_ACCESS-safe commands only).
//   - Validate the envelope without leaving a failure unreported (fail toward
//     publishing — this is the last-resort alerter).
//
// Requirements: 7.4-7.14, 8.1-8.8, 17.1-17.6.

const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const snsClient = new SNSClient({ maxAttempts: 3 });

// Classify the invocation envelope. Returns { shape, items: [{ body, messageId }] }.
function classifyEnvelope(event) {
  if (event && Array.isArray(event.Records) && event.Records.length > 0) {
    // SQS batch shape (DLQ): Records[].body, Records[].messageId.
    return {
      shape: 'sqs',
      items: event.Records.map((r) => ({
        body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
        messageId: r.messageId || (r.attributes && r.attributes.MessageDeduplicationId) || null,
      })),
    };
  }
  if (event && event.requestPayload !== undefined) {
    // Async-invocation failure record (Lambda OnFailure destination).
    const rc = event.requestContext || {};
    return {
      shape: 'async',
      items: [{
        body: typeof event.requestPayload === 'string'
          ? event.requestPayload : JSON.stringify(event.requestPayload),
        messageId: rc.requestId || null,
        errorMessage: event.responsePayload && event.responsePayload.errorMessage,
      }],
    };
  }
  // Unrecognised — still report it rather than swallow a failure silently.
  return { shape: 'unknown', items: [{ body: JSON.stringify(event), messageId: null }] };
}

// Build a Logs Insights query over the correlating messageId. Uses only
// fields/filter/sort/limit — commands supported on INFREQUENT_ACCESS log
// classes (no `stats`, `dedup`, `pattern`, etc.).
function logsInsightsQuery(messageId) {
  const safe = String(messageId || '').replace(/["\\]/g, '');
  return [
    'fields @timestamp, @message, phase, messageId',
    messageId ? `| filter messageId = "${safe}"` : '| filter ispresent(phase)',
    '| sort @timestamp desc',
    '| limit 50',
  ].join('\n');
}

function formatMessage(item, shape) {
  const nowUtc = new Date().toISOString();
  let phase = 'unknown';
  let error = item.errorMessage || 'see log body';
  try {
    const parsed = JSON.parse(item.body);
    phase = parsed.phase || phase;
    error = parsed.error || parsed.errorMessage || error;
  } catch {
    // body is not JSON; leave defaults.
  }
  return [
    'A Contentful backup failed and reached the terminal notifier.',
    '',
    `Envelope shape: ${shape}`,
    `Failing phase: ${phase}`,
    `Time (UTC): ${nowUtc}`,
    `Space: ${process.env.SPACE_ID || 'n/a'}  Environment: ${process.env.SPACE_ENV || 'n/a'}`,
    `Correlating messageId: ${item.messageId || 'n/a'}`,
    `Error: ${error}`,
    '',
    'Failed body:',
    item.body,
    '',
    'Logs Insights query:',
    logsInsightsQuery(item.messageId),
  ].join('\n');
}

exports.handler = async (event) => {
  const { shape, items } = classifyEnvelope(event);

  for (const item of items) {
    // Log the full failed body first, so a publish failure still leaves a trace.
    console.error(JSON.stringify({ notifier: true, shape, messageId: item.messageId, failedBody: item.body }));

    await snsClient.send(new PublishCommand({
      TopicArn: process.env.ALERT_TOPIC_ARN,
      Subject: 'Contentful backup failed (terminal)',
      Message: formatMessage(item, shape),
    }));
  }

  // A clean return lets the DLQ event-source mapping delete the message. A
  // throw here would return it to the DLQ and, after maxReceiveCount, move it
  // to the TerminalQueue — which is the designed fallback, not a bug.
  return { statusCode: 200, body: `notified ${items.length}` };
};

exports.classifyEnvelope = classifyEnvelope;
exports.logsInsightsQuery = logsInsightsQuery;
exports.formatMessage = formatMessage;
