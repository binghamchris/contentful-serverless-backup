// Property: generateS3Key always produces a final key that the Coverage_Check's
// anchored ARCHIVE_KEY pattern matches, for any valid Date. Replaces the
// tautological "sendResponse returns {statusCode, body}" test (which only
// restated the function's definition). Validates: Requirements 33.x, 34.x.

const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const stubs = {
  'contentful-export': () => {},
  archiver: { ZipArchive: class { on() { return this; } pipe() { return this; } directory() { return this; } file() { return this; } finalize() { return Promise.resolve(); } } },
  '@aws-sdk/client-s3': { S3Client: class {}, CopyObjectCommand: class {}, ListObjectsV2Command: class {} },
  '@aws-sdk/lib-storage': { Upload: class { done() { return Promise.resolve({}); } } },
  '@aws-sdk/client-ssm': { SSMClient: class {}, GetParametersCommand: class {} },
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
const fc = require('fast-check');
const { generateS3Key } = require('../../backup-lambda/index.js');

// The same anchored pattern the Coverage_Check uses: ends .<ms>Z.zip so it
// excludes .partial.zip and any staging key.
const ARCHIVE_KEY = /\.\d{3}Z\.zip$/;

describe('Property: generated final key matches the coverage archive pattern', () => {
  it('ends .<ms>Z.zip for any valid timestamp', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01T00:00:00.000Z'), max: new Date('2100-01-01T00:00:00.000Z'), noInvalidDate: true }),
        (date) => {
          const { zipFilename, s3Path } = generateS3Key(date);
          assert.match(zipFilename, ARCHIVE_KEY, `filename ${zipFilename} must match the archive pattern`);
          // Path is date-partitioned YYYY/MM/DD with no colons or 'T'.
          assert.match(s3Path, /^\d{4}\/\d{2}\/\d{2}$/, `path ${s3Path} must be YYYY/MM/DD`);
          const fullKey = `${s3Path}/${zipFilename}`;
          assert.match(fullKey, ARCHIVE_KEY);
        }
      ),
      { numRuns: 200 }
    );
  });
});
