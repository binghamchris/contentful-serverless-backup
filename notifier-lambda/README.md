# Notifier Lambda

The **terminal notifier** for the Contentful backup pipeline. It is the last
resort on every failure path: when a backup message exhausts its source-queue
redrive it lands on the dead-letter queue (DLQ), which triggers this function.

## What it does

- **Discriminates two envelope shapes.** The DLQ delivers an SQS batch
  (`Records[].body`); a Lambda `OnFailure` destination delivers an
  async-invocation record (`requestPayload` / `responsePayload`). The handler
  handles both and reports an unrecognised envelope rather than swallowing it.
- **Logs the full failed body first**, so a subsequent publish failure still
  leaves a trace in the log.
- **Publishes a formatted alert** to the alert SNS topic carrying: the failing
  phase (where knowable), a UTC timestamp, the space/environment, the error, the
  correlating `messageId`, and a CloudWatch Logs Insights query over that
  `messageId`. The query uses only `fields`/`filter`/`sort`/`limit` so it runs on
  the `INFREQUENT_ACCESS` log class (which does not support `stats`, `dedup`,
  `pattern`, and similar commands).

## What it deliberately does NOT do

- It **never calls Contentful** and **never enqueues a backup**. It only reports.
- Its **placeholder publishes rather than throws** (unlike the other two
  functions). If its real code were never deployed, throwing would make the
  last-resort alerter itself silent — so the placeholder fails *open*, emitting a
  "code never applied" alert.
- A Notifier throw returns the message to the DLQ; after the DLQ's own
  `maxReceiveCount` it moves to the **terminal queue** (the designed fallback for
  a message that cannot even be notified on), never blocking the queue.

## Environment

- `ALERT_TOPIC_ARN` — the SNS topic to publish alerts to.
- `SPACE_ID`, `SPACE_ENV` — included in the alert for context.
