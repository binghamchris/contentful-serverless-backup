// Feature: project-quality-overhaul, Property 2: Upload status check returns true only for HTTP 200
// Validates: Requirements 2.1, 2.2

// Mutable status code that the mock S3Client.send() will return
let mockHttpStatusCode = 200;

// Stub out heavy dependencies before requiring backup-lambda/index.js
// uploadFile uses s3Client.send(), so the S3Client mock must have a working send method
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const stubs = {
  'contentful-export': () => {},
  'adm-zip': class {},
  '@aws-sdk/client-s3': {
    S3Client: class {
      send() {
        return Promise.resolve({ '$metadata': { httpStatusCode: mockHttpStatusCode } });
      }
    },
    PutObjectCommand: class {},
  },
  '@aws-sdk/client-sqs': { SQSClient: class {}, DeleteMessageCommand: class {} },
  '@aws-sdk/client-ssm': { SSMClient: class {}, GetParametersCommand: class {} },
};
Module._resolveFilename = function (request, parent, ...rest) {
  if (stubs[request] !== undefined) return request;
  return originalResolve.call(this, request, parent, ...rest);
};
for (const [name, exp] of Object.entries(stubs)) {
  require.cache[name] = { id: name, filename: name, loaded: true, exports: exp };
}

// Set required env vars that uploadFile reads
process.env.S3_BUCKET_NAME = 'test-bucket';
process.env.S3_STORAGE_CLASS = 'STANDARD';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { uploadFile } = require('../../backup-lambda/index.js');

describe('Property 2: Upload status check returns true only for HTTP 200', () => {
  it('should return true iff HTTP status code is exactly 200', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 599 }),
        async (statusCode) => {
          mockHttpStatusCode = statusCode;
          const result = await uploadFile(Buffer.from('test'), 'test-key');
          if (statusCode === 200) {
            assert.equal(result, true, `Expected true for status 200, got ${result}`);
          } else {
            assert.equal(result, false, `Expected false for status ${statusCode}, got ${result}`);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
