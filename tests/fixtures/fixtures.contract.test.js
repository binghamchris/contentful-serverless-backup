'use strict';

// Contract fixtures parse and match what the code expects. These are the
// committed shapes the handlers are written against. Validates: Req 54.x, 56.x.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ARCHIVE_KEY, toEpoch } = require('../../filter-lambda/coverage-check');

const fixture = (name) => JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8')
);

describe('Contract fixtures', () => {
  it('amplify-sns-notification: an SNS record with a parseable success body', () => {
    const f = fixture('amplify-sns-notification.json');
    const msg = JSON.parse(f.Records[0].Sns.Message);
    assert.equal(msg.jobStatus, 'SUCCEED');
    assert.ok(msg.appUrl.startsWith('https://main.'));
  });

  it('sqs-fifo-record: a Backup input with ApproximateReceiveCount', () => {
    const f = fixture('sqs-fifo-record.json');
    assert.equal(Number(f.Records[0].attributes.ApproximateReceiveCount), 1);
  });

  it('last-update-api-response: every lastUpdatedAt parses to a finite epoch', () => {
    const f = fixture('last-update-api-response.json');
    // Real shape: an ARRAY of { table, lastUpdatedAt } objects.
    assert.ok(Array.isArray(f), 'the Last_Update_API payload is a JSON array');
    const epochs = f.map((v) => toEpoch(v.lastUpdatedAt));
    assert.ok(epochs.every((e) => Number.isFinite(e)));
    assert.equal(Math.max(...epochs), toEpoch('2026-09-20T07:55:23+00:00'));
  });

  it('s3-listing: ARCHIVE_KEY matches exactly the two conforming final keys', () => {
    const f = fixture('s3-listing.json');
    const conforming = f.Contents.filter((o) => ARCHIVE_KEY.test(o.Key)).map((o) => o.Key);
    assert.equal(conforming.length, 2, `expected 2 conforming keys, got ${conforming.join(', ')}`);
    // The staging key, the manifest and nothing else must be excluded.
    assert.ok(!conforming.some((k) => k.startsWith('staging/')), 'staging key must be excluded');
    assert.ok(!conforming.includes('manifest.json'), 'manifest must be excluded');
  });

  it('dlq-sqs-batch and async-onfailure: both parse and carry a correlating id', () => {
    const dlq = fixture('dlq-sqs-batch.json');
    assert.ok(dlq.Records[0].messageId);
    const async_ = fixture('async-onfailure.json');
    assert.ok(async_.requestContext.requestId);
    assert.ok(async_.requestPayload);
  });
});
