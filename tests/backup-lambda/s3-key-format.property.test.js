// Feature: project-quality-overhaul, Property 3: S3 object key format is deterministic and correct
// Validates: Requirements 0.3

// Stub out heavy dependencies before requiring backup-lambda/index.js
// generateS3Key is a pure function and doesn't use any of these
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const stubs = {
  'contentful-export': () => {},
  archiver: () => ({ on() { return this; }, pipe() { return this; }, directory() { return this; }, finalize() { return Promise.resolve(); } }),
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

const pad = (n, len = 2) => String(n).padStart(len, '0');

describe('Property 3: S3 object key format is deterministic and correct', () => {
  it('should produce s3Path matching YYYY/MM/DD from UTC date values', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31') }),
        (date) => {
          const { s3Path } = generateS3Key(date);
          const expectedPath = `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;
          assert.equal(s3Path, expectedPath, `s3Path should be ${expectedPath}, got ${s3Path}`);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should produce zipFilename matching YYYY-MM-DD_HH-mm-ss.sssZ.zip', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31') }),
        (date) => {
          const { zipFilename } = generateS3Key(date);
          const y = date.getUTCFullYear();
          const mo = pad(date.getUTCMonth() + 1);
          const d = pad(date.getUTCDate());
          const h = pad(date.getUTCHours());
          const mi = pad(date.getUTCMinutes());
          const s = pad(date.getUTCSeconds());
          const ms = pad(date.getUTCMilliseconds(), 3);
          const expected = `${y}-${mo}-${d}_${h}-${mi}-${s}.${ms}Z.zip`;
          assert.equal(zipFilename, expected, `zipFilename should be ${expected}, got ${zipFilename}`);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should be deterministic: same date always produces same output', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31') }),
        (date) => {
          const result1 = generateS3Key(date);
          const result2 = generateS3Key(date);
          assert.deepStrictEqual(result1, result2, 'generateS3Key should be deterministic');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should produce datePrefix matching YYYY-MM-DD', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31') }),
        (date) => {
          const { datePrefix } = generateS3Key(date);
          const expected = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
          assert.equal(datePrefix, expected, `datePrefix should be ${expected}, got ${datePrefix}`);
        }
      ),
      { numRuns: 100 }
    );
  });
});
