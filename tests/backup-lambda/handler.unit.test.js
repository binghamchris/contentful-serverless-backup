// Unit tests for backup-lambda handler
// Validates: Requirements 0.2, 0.7, 1.3, 3.1

// Track mock calls for assertions
let capturedExportOptions = null;
let s3SendCalls = [];
let sqsSendCalls = [];
let ssmSendCalls = [];
let mockS3StatusCode = 200;
let mockSqsStatusCode = 200;

const Module = require('node:module');
const originalResolve = Module._resolveFilename;

const stubs = {
  'contentful-export': (options) => {
    capturedExportOptions = options;
    return Promise.resolve({});
  },
  'adm-zip': class {
    addLocalFolder() {}
    writeZip() {}
  },
  '@aws-sdk/client-s3': {
    S3Client: class {
      send(cmd) {
        s3SendCalls.push(cmd);
        return Promise.resolve({ '$metadata': { httpStatusCode: mockS3StatusCode } });
      }
    },
    PutObjectCommand: class {
      constructor(params) { this.params = params; }
    },
  },
  '@aws-sdk/client-sqs': {
    SQSClient: class {
      send(cmd) {
        sqsSendCalls.push(cmd);
        return Promise.resolve({ '$metadata': { httpStatusCode: mockSqsStatusCode } });
      }
    },
    DeleteMessageCommand: class {
      constructor(params) { this.params = params; }
    },
  },
  '@aws-sdk/client-ssm': {
    SSMClient: class {
      send() {
        ssmSendCalls.push('getParameters');
        return Promise.resolve({
          Parameters: [
            { ARN: 'arn:mgmt', Value: 'mgmt-token-value' },
            { ARN: 'arn:delivery', Value: 'delivery-token-value' },
          ],
        });
      }
    },
    GetParametersCommand: class {
      constructor(params) { this.params = params; }
    },
  },
  fs: {
    existsSync: () => true,
    mkdirSync: () => {},
    readFileSync: () => Buffer.from('fake-zip-content'),
    unlinkSync: () => {},
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
process.env.S3_BUCKET_NAME = 'test-bucket';
process.env.S3_STORAGE_CLASS = 'STANDARD';
process.env.SQS_QUEUE_URL = 'https://sqs.test/queue';
process.env.MANAGEMENT_TOKEN_ARN = 'arn:mgmt';
process.env.DELIVERY_TOKEN_ARN = 'arn:delivery';
process.env.SPACE_ID = 'test-space-id';
process.env.SPACE_ENV = 'master';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { handler, parseSSMParameters } = require('../../backup-lambda/index.js');

const mockEvent = {
  Records: [{ receiptHandle: 'test-receipt-handle' }],
};

describe('Backup Lambda handler unit tests', () => {
  beforeEach(() => {
    capturedExportOptions = null;
    s3SendCalls = [];
    sqsSendCalls = [];
    ssmSendCalls = [];
    mockS3StatusCode = 200;
    mockSqsStatusCode = 200;
  });

  describe('Req 0.2: Contentful export options', () => {
    it('should pass correct options to contentful-export', async () => {
      await handler(mockEvent);
      assert.ok(capturedExportOptions, 'contentfulExport should have been called');

      const expectedKeys = [
        'spaceId', 'environmentId', 'managementToken', 'deliveryToken',
        'contentFile', 'exportDir', 'useVerboseRenderer', 'saveFile',
        'includeDrafts', 'downloadAssets', 'maxAllowedLimit',
      ];
      for (const key of expectedKeys) {
        assert.ok(key in capturedExportOptions, `options should contain key "${key}"`);
      }
      assert.equal(capturedExportOptions.spaceId, 'test-space-id');
      assert.equal(capturedExportOptions.environmentId, 'master');
      assert.equal(capturedExportOptions.managementToken, 'mgmt-token-value');
      assert.equal(capturedExportOptions.deliveryToken, 'delivery-token-value');
      assert.equal(capturedExportOptions.useVerboseRenderer, false);
      assert.equal(capturedExportOptions.saveFile, true);
      assert.equal(capturedExportOptions.includeDrafts, true);
      assert.equal(capturedExportOptions.downloadAssets, true);
      assert.equal(capturedExportOptions.maxAllowedLimit, 200);
    });
  });

  describe('Req 3.1: Handler returns sendResponse result', () => {
    it('should return an object with statusCode and body on success', async () => {
      const result = await handler(mockEvent);
      assert.ok(result, 'handler should return a value');
      assert.equal(typeof result.statusCode, 'number');
      assert.equal(typeof result.body, 'string');
      assert.equal(result.statusCode, 200);
    });

    it('should return 500 when S3 upload fails', async () => {
      mockS3StatusCode = 500;
      const result = await handler(mockEvent);
      assert.equal(result.statusCode, 500);
      assert.ok(result.body.includes('Failed to upload'), `body should mention upload failure, got: ${result.body}`);
    });
  });

  describe('Req 0.7: SQS delete called only after successful S3 upload', () => {
    it('should call SQS delete after successful S3 upload', async () => {
      await handler(mockEvent);
      assert.equal(s3SendCalls.length, 1, 'S3 send should be called once');
      assert.equal(sqsSendCalls.length, 1, 'SQS send should be called once after upload');
    });

    it('should NOT call SQS delete when S3 upload fails', async () => {
      mockS3StatusCode = 500;
      await handler(mockEvent);
      assert.equal(s3SendCalls.length, 1, 'S3 send should be called once');
      assert.equal(sqsSendCalls.length, 0, 'SQS send should NOT be called when upload fails');
    });
  });

  describe('Req 1.3: Unknown ARN in SSM response is skipped', () => {
    it('should return undefined tokens for unknown ARNs', () => {
      const parameters = [
        { ARN: 'arn:unknown-1', Value: 'unknown-value-1' },
        { ARN: 'arn:unknown-2', Value: 'unknown-value-2' },
      ];
      const result = parseSSMParameters(parameters, 'arn:mgmt', 'arn:delivery');
      assert.equal(result.contentfulManagementToken, undefined);
      assert.equal(result.contentfulDeliveryToken, undefined);
    });

    it('should correctly parse known ARNs and skip unknown ones', () => {
      const parameters = [
        { ARN: 'arn:unknown', Value: 'skip-me' },
        { ARN: 'arn:mgmt', Value: 'mgmt-token' },
        { ARN: 'arn:also-unknown', Value: 'skip-me-too' },
        { ARN: 'arn:delivery', Value: 'delivery-token' },
      ];
      const result = parseSSMParameters(parameters, 'arn:mgmt', 'arn:delivery');
      assert.equal(result.contentfulManagementToken, 'mgmt-token');
      assert.equal(result.contentfulDeliveryToken, 'delivery-token');
    });
  });
});
