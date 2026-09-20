// Property: a caught backup failure publishes an alert on first delivery only.
// Replaces the obsolete "uploadFile returns true iff HTTP 200" test — that
// test enshrined the removed status-code-inspection anti-pattern that the
// redesign eliminated (failures now THROW; success/failure is never signalled
// by an HTTP status code). Validates: Requirements 46.1-46.10.

const Module = require('node:module');
const originalResolve = Module._resolveFilename;

let publishCount = 0;
const stubs = {
  'contentful-export': () => {},
  archiver: () => ({ on() { return this; }, pipe() { return this; }, directory() { return this; }, finalize() { return Promise.resolve(); } }),
  '@aws-sdk/client-s3': { S3Client: class {}, CopyObjectCommand: class {}, ListObjectsV2Command: class {} },
  '@aws-sdk/lib-storage': { Upload: class { done() { return Promise.resolve({}); } } },
  '@aws-sdk/client-ssm': { SSMClient: class {}, GetParametersCommand: class {} },
  '@aws-sdk/client-sns': {
    SNSClient: class { send() { publishCount += 1; return Promise.resolve({}); } },
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

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { publishFailureIfFirstDelivery } = require('../../backup-lambda/index.js');

describe('Property: alert publishes on first delivery only', () => {
  it('publishes iff ApproximateReceiveCount === 1, for any positive count', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 50 }), async (count) => {
        publishCount = 0;
        const record = { attributes: { ApproximateReceiveCount: String(count) } };
        const published = await publishFailureIfFirstDelivery(record, new Error('boom'));
        if (count === 1) {
          assert.equal(published, true);
          assert.equal(publishCount, 1);
        } else {
          assert.equal(published, false);
          assert.equal(publishCount, 0);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('never throws even when the count attribute is absent or malformed', async () => {
    for (const attributes of [undefined, {}, { ApproximateReceiveCount: 'x' }, { ApproximateReceiveCount: null }]) {
      const published = await publishFailureIfFirstDelivery({ attributes }, new Error('boom'));
      assert.equal(published, false);
    }
  });
});
