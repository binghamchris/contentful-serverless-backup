// Feature: project-quality-overhaul, Property 5: Object iteration processes only own properties (backup-lambda)
// Validates: Requirements 11.1

// Stub out heavy dependencies before requiring backup-lambda/index.js
// parseSSMParameters is a pure function and doesn't use any of these
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
const { parseSSMParameters } = require('../../backup-lambda/index.js');

describe('Property 5: Object iteration processes only own properties (backup-lambda)', () => {
  it('should process only own properties and ignore inherited prototype properties', () => {
    fc.assert(
      fc.property(
        // Generate distinct ARNs for management and delivery
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        // Generate real token values (own properties)
        fc.string(),
        fc.string(),
        // Generate poison token values (inherited properties)
        fc.string(),
        fc.string(),
        (managementArn, deliveryArn, managementToken, deliveryToken, poisonToken1, poisonToken2) => {
          // ARNs must be distinct
          fc.pre(managementArn !== deliveryArn);

          // Create a prototype with poison properties that have the SAME ARNs
          // but DIFFERENT values — if inherited props leak through, the result
          // would contain poison values instead of the real ones
          const proto = {
            0: { ARN: managementArn, Value: poisonToken1 },
            1: { ARN: deliveryArn, Value: poisonToken2 },
          };

          // Ensure poison values differ from real values so we can detect leakage
          fc.pre(poisonToken1 !== managementToken || poisonToken2 !== deliveryToken);

          // Create parameters object inheriting from proto, then set own properties
          const parameters = Object.create(proto);
          parameters[0] = { ARN: managementArn, Value: managementToken };
          parameters[1] = { ARN: deliveryArn, Value: deliveryToken };

          const result = parseSSMParameters(parameters, managementArn, deliveryArn);

          // Verify only own-property values are used, not inherited poison values
          assert.equal(result.contentfulManagementToken, managementToken,
            'Management token should come from own property, not inherited');
          assert.equal(result.contentfulDeliveryToken, deliveryToken,
            'Delivery token should come from own property, not inherited');
        }
      ),
      { numRuns: 100 }
    );
  });
});
