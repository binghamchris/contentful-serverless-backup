'use strict';

// Filter handler helper tests: fail-open fetch, branch sanitisation, anchored
// status regex. Widened generators (invalid dates, empty objects, absent
// fields, nulls, non-objects) and globalThis.fetch restored in teardown.
// Validates: Requirements 18.x-21.x, 48.x, 49.x.

const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const stubs = {
  '@aws-sdk/client-sqs': { SQSClient: class {}, SendMessageCommand: class {} },
  '@aws-sdk/client-s3': { S3Client: class {}, ListObjectsV2Command: class {} },
  '@aws-sdk/client-ssm': { SSMClient: class {}, GetParameterCommand: class {}, PutParameterCommand: class {} },
  '@aws-sdk/client-sns': { SNSClient: class {}, PublishCommand: class {} },
};
Module._resolveFilename = function (request, parent, ...rest) {
  if (stubs[request] !== undefined) return request;
  return originalResolve.call(this, request, parent, ...rest);
};
for (const [name, exp] of Object.entries(stubs)) {
  require.cache[name] = { id: name, filename: name, loaded: true, exports: exp };
}

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { fetchLatestTimestamp, branchFromUrl, STATUS_RE } = require('../../filter-lambda/index.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; }); // restore in teardown

const deadline = () => Date.now() + 10_000;

describe('branchFromUrl: leftmost sanitised DNS label', () => {
  it('extracts and sanitises the branch label', () => {
    assert.equal(branchFromUrl('https://main.d123.amplifyapp.com'), 'main');
    assert.equal(branchFromUrl('https://Feature_X.d123.amplifyapp.com'), 'feature-x');
  });
  it('returns null for absent, empty, non-string and malformed URLs', () => {
    for (const bad of [undefined, null, '', 42, {}, 'not a url', 'ftp://']) {
      assert.equal(branchFromUrl(bad), null, `${JSON.stringify(bad)} -> null`);
    }
  });
});

describe('STATUS_RE: anchored with a capture group', () => {
  it('captures the status token from a real Amplify body', () => {
    const m = STATUS_RE.exec('{"jobStatus":"SUCCEED","appId":"d1"}');
    assert.ok(m && m[1].toUpperCase() === 'SUCCEED');
  });
  it('does not match a non-status field that merely contains SUCCEED', () => {
    // Anchored to the jobStatus key, so "message":"build SUCCEEDED nicely" must not match.
    const m = STATUS_RE.exec('{"message":"the build SUCCEEDED nicely"}');
    assert.equal(m, null);
  });
  it('fails to match (fail open) on garbage', () => {
    assert.equal(STATUS_RE.exec('random text with no status'), null);
  });
});

describe('fetchLatestTimestamp: fail open on any unusable response', () => {
  it('returns the max lastUpdatedAt across tables', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ a: { lastUpdatedAt: '2026-09-20T00:00:00.000Z' }, b: { lastUpdatedAt: '2026-09-20T02:00:00.000Z' } }),
    });
    const ts = await fetchLatestTimestamp('https://api/last', deadline());
    assert.equal(ts, Date.parse('2026-09-20T02:00:00.000Z'));
  });

  it('returns null for a non-ok status, then no usable timestamp', async () => {
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
    assert.equal(await fetchLatestTimestamp('https://api/last', deadline()), null);
  });

  it('returns null for a null url', async () => {
    assert.equal(await fetchLatestTimestamp(null, deadline()), null);
  });

  it('property: never throws for widely varied response bodies', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant({}),                                  // empty object
          fc.constant({ a: {} }),                           // absent lastUpdatedAt
          fc.constant({ a: { lastUpdatedAt: null } }),      // null field
          fc.constant({ a: { lastUpdatedAt: 'bad' } }),     // invalid date
          fc.constant([]),                                  // array (non-object shape)
          fc.constant(null),                                // null body
          fc.constant('a string'),                          // non-object
          fc.object(),                                      // arbitrary object
          fc.record({ t: fc.record({ lastUpdatedAt: fc.date().map((d) => d.toISOString()) }) })
        ),
        async (bodyVal) => {
          globalThis.fetch = async () => ({ ok: true, json: async () => bodyVal });
          const ts = await fetchLatestTimestamp('https://api/last', deadline());
          // Oracle: result is either null or a finite epoch — never NaN, never throws.
          assert.ok(ts === null || Number.isFinite(ts), `unexpected ts: ${ts}`);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns null (not a hang) when fetch rejects', async () => {
    globalThis.fetch = async () => { throw new Error('network'); };
    assert.equal(await fetchLatestTimestamp('https://api/last', deadline()), null);
  });
});
