// Feature: project-quality-overhaul, Property 4: Filter Lambda SUCCEED check
// Validates: Requirements 0.6

// Stub out heavy dependencies before requiring filter-lambda/index.js
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const stubs = {
  '@aws-sdk/client-sqs': { SQSClient: class {}, SendMessageCommand: class {} },
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
const { processMessageAsync } = require('../../filter-lambda/index.js');

describe('Property 4: Filter Lambda SUCCEED check', () => {
  it('should return false for any string that does not contain "SUCCEED"', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((s) => !s.includes('SUCCEED')),
        async (message) => {
          const record = { Sns: { Message: message } };
          const result = await processMessageAsync(record);
          assert.equal(result, false, `Expected false for message without "SUCCEED": "${message}"`);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return true for any string that contains "SUCCEED"', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(fc.string(), fc.string()).map(([prefix, suffix]) => prefix + 'SUCCEED' + suffix),
        async (message) => {
          const record = { Sns: { Message: message } };
          const result = await processMessageAsync(record);
          assert.equal(result, true, `Expected true for message containing "SUCCEED": "${message}"`);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return true iff the message contains "SUCCEED" (mixed)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.string(),
        fc.string(),
        async (includeSUCCEED, prefix, suffix) => {
          let message;
          if (includeSUCCEED) {
            message = prefix + 'SUCCEED' + suffix;
          } else {
            message = prefix + suffix;
            fc.pre(!message.includes('SUCCEED'));
          }
          const record = { Sns: { Message: message } };
          const result = await processMessageAsync(record);
          assert.equal(result, includeSUCCEED);
        }
      ),
      { numRuns: 100 }
    );
  });
});
