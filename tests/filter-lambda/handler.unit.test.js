// Unit tests for filter-lambda handler
// Validates: Requirements 0.4, 3.2, 13.3

let capturedSqsCommands = [];
let mockSqsStatusCode = 200;

const Module = require('node:module');
const originalResolve = Module._resolveFilename;

const stubs = {
  '@aws-sdk/client-sqs': {
    SQSClient: class {
      send(cmd) {
        capturedSqsCommands.push(cmd);
        return Promise.resolve({ '$metadata': { httpStatusCode: mockSqsStatusCode } });
      }
    },
    SendMessageCommand: class {
      constructor(params) {
        this.params = params;
      }
    },
  },
};

Module._resolveFilename = function (request, parent, ...rest) {
  if (stubs[request] !== undefined) return request;
  return originalResolve.call(this, request, parent, ...rest);
};
for (const [name, exp] of Object.entries(stubs)) {
  require.cache[name] = { id: name, filename: name, loaded: true, exports: exp };
}

// Set required env vars
process.env.SQS_QUEUE_URL = 'https://sqs.test/queue';
process.env.LAST_UPDATE_WINDOW = '10';
process.env.LAST_UPDATE_API_URL = 'https://api.test/updates';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { handler, sendResponse } = require('../../filter-lambda/index.js');

// Mock global fetch for getLastUpdateTimestamp
const recentTimestamp = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 minutes ago
const originalFetch = globalThis.fetch;

describe('Filter Lambda handler unit tests', () => {
  beforeEach(() => {
    capturedSqsCommands = [];
    mockSqsStatusCode = 200;
    // Mock fetch to return a recent timestamp so backup is triggered
    globalThis.fetch = () => Promise.resolve({
      json: () => Promise.resolve({
        table1: { lastUpdatedAt: recentTimestamp },
      }),
    });
  });

  // Restore fetch after all tests (best effort)
  // Not strictly needed since this is a test process

  describe('Req 3.2: Handler returns sendResponse result', () => {
    it('should return an object with statusCode and body on success', async () => {
      const event = { Records: [{ Sns: { Message: 'Build status: SUCCEED' } }] };
      const result = await handler(event);
      assert.ok(result, 'handler should return a value');
      assert.equal(typeof result.statusCode, 'number');
      assert.equal(typeof result.body, 'string');
      assert.equal(result.statusCode, 200);
    });

    it('should return 200 with no backup message when build did not succeed', async () => {
      const event = { Records: [{ Sns: { Message: 'Build status: FAILED' } }] };
      const result = await handler(event);
      assert.equal(result.statusCode, 200);
      assert.ok(result.body.includes('No backup required'));
    });

    it('should return 500 when SQS send fails', async () => {
      mockSqsStatusCode = 500;
      const event = { Records: [{ Sns: { Message: 'Build SUCCEED' } }] };
      const result = await handler(event);
      assert.equal(result.statusCode, 500);
      assert.ok(result.body.includes('Failed to queue backup'));
    });
  });

  describe('Req 0.4: SQS message deduplication and group IDs', () => {
    it('should use MessageDeduplicationId "backup" and MessageGroupId "backup"', async () => {
      const event = { Records: [{ Sns: { Message: 'Build SUCCEED' } }] };
      await handler(event);
      assert.equal(capturedSqsCommands.length, 1, 'should send exactly one SQS message');
      const cmd = capturedSqsCommands[0];
      assert.equal(cmd.params.MessageDeduplicationId, 'backup');
      assert.equal(cmd.params.MessageGroupId, 'backup');
    });
  });

  describe('Req 13.3: No sync-fetch in filter-lambda package.json', () => {
    it('should not have sync-fetch as a dependency', () => {
      const pkgPath = path.join(__dirname, '../../filter-lambda/package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
      };
      assert.ok(!('sync-fetch' in allDeps), 'sync-fetch should not be in any dependency list');
    });
  });
});
