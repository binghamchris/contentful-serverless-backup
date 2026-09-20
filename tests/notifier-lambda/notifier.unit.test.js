'use strict';

// Notifier tests driving both envelope shapes from committed fixtures.
// Validates: Requirements 7.4-7.14, 8.1-8.8, 17.1-17.6.

const Module = require('node:module');
const originalResolve = Module._resolveFilename;

let publishes = [];
const stubs = {
  '@aws-sdk/client-sns': {
    SNSClient: class { send(cmd) { publishes.push(cmd.params); return Promise.resolve({}); } },
    PublishCommand: class { constructor(p) { this.params = p; } },
  },
};
Module._resolveFilename = function (request, parent, ...rest) {
  if (stubs[request] !== undefined) return request;
  return originalResolve.call(this, request, parent, ...rest);
};
for (const [name, exp] of Object.entries(stubs)) {
  require.cache[name] = { id: name, filename: name, loaded: true, exports: exp };
}

process.env.ALERT_TOPIC_ARN = 'arn:aws:sns:eu-central-1:1:alerts';
process.env.SPACE_ID = 'space-x';
process.env.SPACE_ENV = 'master';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { handler, classifyEnvelope, logsInsightsQuery } = require('../../notifier-lambda/index.js');

const fixture = (name) => JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8')
);

describe('Notifier: both envelope shapes', () => {
  beforeEach(() => { publishes = []; });

  it('classifies the DLQ SQS-batch shape and publishes with the content contract', async () => {
    const event = fixture('dlq-sqs-batch.json');
    const res = await handler(event);
    assert.equal(res.statusCode, 200);
    assert.equal(publishes.length, 1);
    const msg = publishes[0].Message;
    assert.match(msg, /Envelope shape: sqs/);
    assert.match(msg, /Failing phase: export/);
    assert.match(msg, /Space: space-x {2}Environment: master/);
    assert.match(msg, /11111111-2222-3333-4444-555555555555/);
    assert.match(msg, /Logs Insights query/);
  });

  it('classifies the async OnFailure shape', async () => {
    const event = fixture('async-onfailure.json');
    const res = await handler(event);
    assert.equal(res.statusCode, 200);
    assert.equal(publishes.length, 1);
    assert.match(publishes[0].Message, /Envelope shape: async/);
    assert.match(publishes[0].Message, /aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
  });

  it('still reports an unrecognised envelope rather than swallowing it', async () => {
    await handler({ something: 'unexpected' });
    assert.equal(publishes.length, 1);
    assert.match(publishes[0].Message, /Envelope shape: unknown/);
  });

  it('never references Contentful API calls in its dependencies', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'notifier-lambda', 'index.js'), 'utf8');
    assert.ok(!src.includes('contentful-export'), 'Notifier must not import contentful-export');
    assert.ok(!/SendMessageCommand|SQSClient/.test(src), 'Notifier must not enqueue a backup');
  });
});

describe('Notifier: Logs Insights query is INFREQUENT_ACCESS-safe', () => {
  it('uses only fields/filter/sort/limit, no unsupported commands', () => {
    const q = logsInsightsQuery('abc');
    for (const unsupported of ['stats ', 'dedup ', 'pattern ', 'diff ', 'unmask']) {
      assert.ok(!q.includes(unsupported), `query must not use ${unsupported}`);
    }
    assert.match(q, /filter messageId = "abc"/);
  });

  it('escapes quotes/backslashes in the messageId', () => {
    const q = logsInsightsQuery('a"b\\c');
    assert.ok(!q.includes('a"b'), 'must escape embedded quotes');
  });
});
