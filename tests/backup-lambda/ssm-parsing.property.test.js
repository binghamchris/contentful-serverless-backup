// Feature: project-quality-overhaul, Property 1: SSM token parsing assigns each token to its correct variable
// Validates: Requirements 1.1, 1.2

// Stub out heavy dependencies before requiring backup-lambda/index.js
// parseSSMParameters is a pure function and doesn't use any of these
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
const { parseSSMParameters } = require('../../backup-lambda/index.js');

describe('Property 1: SSM token parsing assigns each token to its correct variable', () => {
  it('should assign each token to its correct variable for any random token pairs in any order', () => {
    fc.assert(
      fc.property(
        // Generate distinct management and delivery ARNs
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        // Generate random token values
        fc.string(),
        fc.string(),
        // Generate a boolean to control parameter order
        fc.boolean(),
        (managementArn, deliveryArn, managementToken, deliveryToken, reverseOrder) => {
          // ARNs must be distinct to test correct assignment
          fc.pre(managementArn !== deliveryArn);

          const mgmtParam = { ARN: managementArn, Value: managementToken };
          const dlvParam = { ARN: deliveryArn, Value: deliveryToken };

          // Put parameters in random order
          const parameters = reverseOrder
            ? [dlvParam, mgmtParam]
            : [mgmtParam, dlvParam];

          const result = parseSSMParameters(parameters, managementArn, deliveryArn);

          assert.equal(result.contentfulManagementToken, managementToken,
            'Management token should be assigned correctly');
          assert.equal(result.contentfulDeliveryToken, deliveryToken,
            'Delivery token should be assigned correctly');
        }
      ),
      { numRuns: 100 }
    );
  });
});
