# Event-Driven Contentful Backups for AWS Amplify-hosted Apps
A solution for efficently backing up entries and assets from [Contentful](https://www.contentful.com) where the frontend is hosted on [AWS Amplify](https://aws.amazon.com/amplify/).

This solution follows an event-driven architecture pattern which leverages SNS notifications emitted by AWS Amplify during the build process to trigger the backup process. These notifications are processed by a small AWS Lambda function (the **filter**) which determines whether a backup is required, and if so queues the backup via an AWS SQS FIFO queue.

The SQS queue uses message deduplication to avoid repeated backups in a short period. A larger Lambda function (the **backup**) processes messages from the queue and performs the backup: it exports the space's **published** content and assets, archives them, streams the archive to a **staging** key in S3, verifies it, and only then promotes it to a final, coverage-visible key. A third Lambda function (the **notifier**) consumes the dead-letter queue and is the terminal alerter for any backup that fails.

## Reliability and notification philosophy

- **Fail loudly, never silently.** Every failure path in the backup and filter
  functions throws (returning the message to the queue), so a failure reaches the
  dead-letter queue and, through it, the notifier. The notifier's placeholder
  publishes rather than throws, so even an un-deployed notifier fails *open*.
- **Email on failure only.** There are no CloudWatch alarms, metrics, dashboards
  or scheduled/synthetic backups — Contentful API quota is scarce and shared with
  editorial work and frontend builds. A single SNS topic carries failure alerts.
- **Coverage check.** Independently of whether a build warrants a backup, the
  filter compares the newest archive against the content's last-update timestamp
  and emails if a real content change appears uncovered — with grace-bounded,
  stateful suppression so a genuinely in-flight backup is not reported, but a
  *broken* pipeline is.

## The two data-flow paths

1. **Backup path:** Amplify build → SNS → filter (decides) → SQS → backup
   (export → archive → stage → verify → promote → S3). On failure: → DLQ →
   notifier → alert email.
2. **Coverage path:** filter lists the bucket and compares the newest archive key
   timestamp against the max last-update timestamp across the site's static
   `Last_Update_API` endpoint(s); emits a coverage-gap alert when warranted.

## The `Last_Update_API` contract

The filter reads a JSON document (per the `LastUpdateUrl`, and optionally a second
`LastUpdateUrlSecondary`) whose top-level values each carry a `lastUpdatedAt` ISO
timestamp. The filter takes the **maximum** across all entries and both endpoints;
any unusable response (non-object, missing/unparseable timestamp, error) is
treated as *fail-open* (no silent no-backup). See `filter-lambda/README.md`.

## S3 archive layout

Final archives are keyed `YYYY/MM/DD/YYYY-MM-DD_HH-mm-ss.sssZ.zip` (UTC). The
fixed-width, zero-padded key makes byte order equal chronological order, so the
greatest conforming key is the newest archive. Staging copies live under a
`staging/` prefix that the coverage check ignores and a short-TTL lifecycle rule
reaps.

## Repository Structure
This repository contains the following directories, each of which has its own readme.

- `backup-lambda`: Code for the Lambda function which performs the backups of Contentful.
- `deploy`: The CloudFormation template location is `infrastructure/template.yaml`; this directory holds the reproducible, gated script that deploys each function's code and dependencies via `UpdateFunctionCode`.
- `filter-lambda`: Code for the Lambda function which processes SNS notifications from AWS Amplify to determine when backups are required, and runs the coverage check.
- `notifier-lambda`: Code for the terminal notifier Lambda, which consumes the dead-letter queue and emails on any failed backup.

## License
This work is licensed under a [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License][cc-by-nc-sa].
[![CC BY-NC-SA 4.0][cc-by-nc-sa-image]][cc-by-nc-sa]

[cc-by-nc-sa]: http://creativecommons.org/licenses/by-nc-sa/4.0/
[cc-by-nc-sa-image]: https://licensebuttons.net/l/by-nc-sa/4.0/88x31.png
[cc-by-nc-sa-shield]: https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg

Full license details can be found here: https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode