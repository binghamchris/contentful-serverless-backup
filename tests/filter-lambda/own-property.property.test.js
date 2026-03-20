// Feature: project-quality-overhaul, Property 5: Object iteration processes only own properties (filter-lambda)
// Validates: Requirements 11.2

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

describe('Property 5: Object iteration processes only own properties (filter-lambda)', () => {
  it('should process only own properties and ignore inherited prototype properties', async () => {
    const originalFetch = globalThis.fetch;

    await fc.assert(
      fc.asyncProperty(
        // Generate own properties: dictionary of table names to timestamps
        fc.dictionary(
          fc.string({ minLength: 1 }),
          fc.date({ min: new Date('2000-01-01'), max: new Date('2049-12-31') })
        ).filter(dict => Object.keys(dict).length >= 1),
        // Generate poison timestamps that are MUCH LATER than any own-property timestamp
        fc.integer({ min: 1, max: 5 }),
        async (ownTables, poisonCount) => {
          // Build own-property entries with lastUpdatedAt
          const ownEntries = {};
          for (const [key, date] of Object.entries(ownTables)) {
            ownEntries[key] = { lastUpdatedAt: date.toISOString() };
          }

          // Compute expected max from own properties only
          const expectedMax = new Date(
            Math.max(...Object.values(ownEntries).map(v => new Date(v.lastUpdatedAt).getTime()))
          );

          // Create prototype with poison properties that have timestamps far in the future
          const proto = {};
          for (let i = 0; i < poisonCount; i++) {
            const poisonKey = `__proto_poison_${i}__`;
            // Poison timestamps are in 2090+ so they'd be the max if iterated
            const poisonDate = new Date(`209${i}-06-15T00:00:00.000Z`);
            proto[poisonKey] = { lastUpdatedAt: poisonDate.toISOString() };
          }

          // Create the JSON object: inherits poison props, own props are the real data
          const jsonObj = Object.create(proto);
          for (const [key, value] of Object.entries(ownEntries)) {
            jsonObj[key] = value;
          }

          // Mock globalThis.fetch to return the crafted object
          globalThis.fetch = async () => ({
            json: async () => jsonObj,
          });

          try {
            const result = await getLastUpdateTimestamp('http://test.example.com');
            assert.equal(result.getTime(), expectedMax.getTime(),
              `Expected max from own properties ${expectedMax.toISOString()} but got ${result.toISOString()}. ` +
              'Inherited prototype properties may have leaked into iteration.');
          } finally {
            globalThis.fetch = originalFetch;
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
