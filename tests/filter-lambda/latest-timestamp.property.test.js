// Feature: project-quality-overhaul, Property 6: getLastUpdateTimestamp returns the most recent timestamp
// Validates: Requirements 13.1

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
const { getLastUpdateTimestamp } = require('../../filter-lambda/index.js');

describe('Property 6: getLastUpdateTimestamp returns the most recent timestamp', () => {
  it('should return the maximum timestamp from a non-empty dictionary of ISO timestamps', async () => {
    const originalFetch = globalThis.fetch;

    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(
          fc.string({ minLength: 1 }),
          fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31') })
            .map(d => ({ lastUpdatedAt: d.toISOString() }))
        ).filter(dict => Object.keys(dict).length >= 1),
        async (dict) => {
          // Compute expected maximum Date
          const expectedMax = new Date(
            Math.max(...Object.values(dict).map(v => new Date(v.lastUpdatedAt).getTime()))
          );

          // Mock globalThis.fetch to return the generated dictionary
          globalThis.fetch = async () => ({
            json: async () => dict,
          });

          try {
            const result = await getLastUpdateTimestamp('http://test.example.com');
            assert.equal(result.getTime(), expectedMax.getTime(),
              `Expected ${expectedMax.toISOString()} but got ${result.toISOString()}`);
          } finally {
            globalThis.fetch = originalFetch;
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
