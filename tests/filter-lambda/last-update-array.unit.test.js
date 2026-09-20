'use strict';

// Last_Update_API parsing: the real production endpoints return a JSON ARRAY of
// { table, lastUpdatedAt } objects, and where several tables are listed the
// LATEST timestamp must win. Regression for the bug where the Filter rejected
// arrays outright (contentTs=null -> no backup). Validates: Requirements 19.x.

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

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { maxTimestampFrom } = require('../../filter-lambda/index.js');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8'));
const epoch = (iso) => new Date(iso).getTime();

describe('maxTimestampFrom: real array shape, latest wins', () => {
  it('single-table array (cloudypandas) returns that table\'s timestamp', () => {
    const ts = maxTimestampFrom(fixture('last-update-api-response.json'));
    assert.equal(ts, epoch('2026-09-20T07:55:23+00:00'));
  });

  it('multi-table array (paddelbuch) returns the LATEST across all tables', () => {
    const ts = maxTimestampFrom(fixture('last-update-api-response-multi.json'));
    // spots @ 2026-09-19T16:36:00Z is the newest of the 13 tables
    assert.equal(ts, epoch('2026-09-19T16:36:00Z'));
  });

  // Regression guard: the latest must win REGARDLESS of its position in the
  // array and regardless of ordering. A naive "return the first / last / any"
  // implementation would pass a fixture where the newest happens to sit at one
  // end, so these place the newest deliberately first, middle, and last, and
  // also shuffle the order — only a true max survives all four.
  const T = {
    old1: '2023-01-01T00:00:00Z',
    old2: '2024-06-15T12:00:00Z',
    mid: '2025-03-03T03:03:03Z',
    newest: '2026-09-19T16:36:00Z',
  };
  const row = (table, ts) => ({ table, lastUpdatedAt: ts });

  it('newest FIRST in the array still wins', () => {
    const ts = maxTimestampFrom([row('a', T.newest), row('b', T.old1), row('c', T.mid), row('d', T.old2)]);
    assert.equal(ts, epoch(T.newest));
  });

  it('newest in the MIDDLE still wins', () => {
    const ts = maxTimestampFrom([row('a', T.old1), row('b', T.newest), row('c', T.old2), row('d', T.mid)]);
    assert.equal(ts, epoch(T.newest));
  });

  it('newest LAST still wins', () => {
    const ts = maxTimestampFrom([row('a', T.old1), row('b', T.mid), row('c', T.old2), row('d', T.newest)]);
    assert.equal(ts, epoch(T.newest));
  });

  it('is order-independent: any permutation yields the same max', () => {
    const rows = [row('a', T.old1), row('b', T.newest), row('c', T.mid), row('d', T.old2)];
    // brute-force a few permutations
    const perms = [
      rows,
      [rows[3], rows[2], rows[1], rows[0]],
      [rows[1], rows[3], rows[0], rows[2]],
      [rows[2], rows[0], rows[3], rows[1]],
    ];
    for (const p of perms) {
      assert.equal(maxTimestampFrom(p), epoch(T.newest), `permutation ${p.map((r) => r.table)} must still return newest`);
    }
  });

  it('two tables differing by ONE SECOND: the later one wins (fine-grained max, not first-seen)', () => {
    const earlier = maxTimestampFrom([row('a', '2026-09-20T07:55:22Z'), row('b', '2026-09-20T07:55:23Z')]);
    const swapped = maxTimestampFrom([row('b', '2026-09-20T07:55:23Z'), row('a', '2026-09-20T07:55:22Z')]);
    assert.equal(earlier, epoch('2026-09-20T07:55:23Z'));
    assert.equal(swapped, epoch('2026-09-20T07:55:23Z'), 'order must not change which timestamp wins');
  });

  it('still accepts the object-keyed shape (design-era form)', () => {
    const ts = maxTimestampFrom({
      pages: { lastUpdatedAt: '2026-09-20T04:48:12.000Z' },
      posts: { lastUpdatedAt: '2026-09-20T04:50:03.000Z' },
    });
    assert.equal(ts, epoch('2026-09-20T04:50:03.000Z'));
  });

  it('ignores entries with missing/unparseable timestamps, takes the max of the rest', () => {
    const ts = maxTimestampFrom([
      { table: 'a', lastUpdatedAt: 'not-a-date' },
      { table: 'b' },
      { table: 'c', lastUpdatedAt: '2026-01-02T00:00:00Z' },
      { table: 'd', lastUpdatedAt: '2026-05-06T00:00:00Z' },
    ]);
    assert.equal(ts, epoch('2026-05-06T00:00:00Z'));
  });

  it('returns null (fail open) for unusable payloads', () => {
    for (const bad of [null, undefined, 'a string', 42, [], {}, [{ table: 'x' }]]) {
      assert.equal(maxTimestampFrom(bad), null, `${JSON.stringify(bad)} -> null`);
    }
  });
});
