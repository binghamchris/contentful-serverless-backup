// Feature: project-quality-overhaul, Property 10: sendResponse produces a well-formed response object
// Validates: Requirements 3.1, 3.2, 12.1, 12.2

// Stub out heavy dependencies before requiring backup-lambda/index.js
// sendResponse is a pure function and doesn't use any of these
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const stubs = {
  'contentful-export': () => {},
  'adm-zip': class {},
  '@aws-sdk/client-s3': { S3Client: class {}, PutObjectCommand: class {} },
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

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { sendResponse } = require('../../backup-lambda/index.js');

describe('Property 10: sendResponse produces a well-formed response object', () => {
  it('should return a plain object with exactly statusCode and body matching inputs', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.string(),
        (status, body) => {
          const result = sendResponse(status, body);

          // The response is a plain object (not null, not an array)
          assert.equal(typeof result, 'object', 'Result should be an object');
          assert.ok(result !== null, 'Result should not be null');
          assert.ok(!Array.isArray(result), 'Result should not be an array');

          // The returned object has exactly two keys: statusCode and body
          const keys = Object.keys(result);
          assert.deepStrictEqual(keys.sort(), ['body', 'statusCode'],
            'Result should have exactly two keys: statusCode and body');

          // statusCode equals the input status
          assert.equal(result.statusCode, status,
            'statusCode should equal the input status');

          // body equals the input body
          assert.equal(result.body, body,
            'body should equal the input body');
        }
      ),
      { numRuns: 100 }
    );
  });
});
