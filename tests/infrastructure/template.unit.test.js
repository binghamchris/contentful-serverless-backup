// Unit tests for CloudFormation template structure
// Validates: Requirements 7.1, 8.1, 9.1, 9.2, 9.3, 18.1, 19.1, 20.1, 0.5

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

// Reuse the same CFN_SCHEMA approach from template.property.test.js
const cfnTags = [
  'Ref', 'Sub', 'GetAtt', 'Join', 'Select', 'Split', 'If',
  'Equals', 'And', 'Or', 'Not', 'FindInMap', 'Base64',
  'Cidr', 'ImportValue', 'GetAZs', 'Condition', 'Transform',
].flatMap((fn) => {
  return ['scalar', 'sequence', 'mapping'].map((kind) =>
    new yaml.Type(`!${fn}`, {
      kind,
      construct: (data) => ({ [`Fn::${fn}`]: data }),
    })
  );
});

const CFN_SCHEMA = yaml.DEFAULT_SCHEMA.extend(cfnTags);

const templatePath = path.join(__dirname, '../../infrastructure/template.yaml');
const templateContent = fs.readFileSync(templatePath, 'utf8');
const template = yaml.load(templateContent, { schema: CFN_SCHEMA });

/**
 * Recursively collect all string values from an object tree.
 */
function collectStrings(obj) {
  const results = [];
  if (obj === null || obj === undefined) return results;
  if (typeof obj === 'string') return [obj];
  if (Array.isArray(obj)) {
    for (const item of obj) results.push(...collectStrings(item));
    return results;
  }
  if (typeof obj === 'object') {
    for (const val of Object.values(obj)) results.push(...collectStrings(val));
  }
  return results;
}

// Req 7.1: FilterLambdaRole has no s3:PutObject
describe('Req 7.1: FilterLambdaRole least-privilege', () => {
  it('should not grant s3:PutObject to FilterLambdaRole', () => {
    const filterRole = template.Resources.FilterLambdaRole;
    assert.ok(filterRole, 'FilterLambdaRole must exist');

    const policies = filterRole.Properties.Policies;
    const allActions = policies.flatMap((p) =>
      p.PolicyDocument.Statement.flatMap((s) => s.Action)
    );
    assert.ok(
      !allActions.includes('s3:PutObject'),
      `FilterLambdaRole should not have s3:PutObject, found actions: ${allActions.join(', ')}`
    );
  });
});

// Req 8.1: BackupBucket has BucketEncryption
describe('Req 8.1: BackupBucket encryption', () => {
  it('should have BucketEncryption configured on BackupBucket', () => {
    const bucket = template.Resources.BackupBucket;
    assert.ok(bucket, 'BackupBucket must exist');
    const encryption = bucket.Properties.BucketEncryption;
    assert.ok(encryption, 'BackupBucket must have BucketEncryption');
    const rules = encryption.ServerSideEncryptionConfiguration;
    assert.ok(Array.isArray(rules) && rules.length > 0, 'Must have at least one encryption rule');
    const algorithm = rules[0].ServerSideEncryptionByDefault.SSEAlgorithm;
    assert.ok(
      algorithm === 'AES256' || algorithm === 'aws:kms',
      `SSEAlgorithm must be AES256 or aws:kms, got: ${algorithm}`
    );
  });
});

// Req 9.1: DLQ resource exists
describe('Req 9.1: Dead Letter Queue resource', () => {
  it('should define a DeadLetterQueue resource', () => {
    const dlq = template.Resources.DeadLetterQueue;
    assert.ok(dlq, 'DeadLetterQueue resource must exist');
    assert.equal(dlq.Type, 'AWS::SQS::Queue');
    assert.equal(dlq.Properties.FifoQueue, true, 'DLQ must be a FIFO queue');
  });
});

// Req 9.2: RedrivePolicy on SQSQueue
describe('Req 9.2: SQSQueue RedrivePolicy', () => {
  it('should have a RedrivePolicy pointing to the DLQ', () => {
    const sqsQueue = template.Resources.SQSQueue;
    assert.ok(sqsQueue, 'SQSQueue must exist');
    const redrivePolicy = sqsQueue.Properties.RedrivePolicy;
    assert.ok(redrivePolicy, 'SQSQueue must have a RedrivePolicy');
    assert.ok(redrivePolicy.deadLetterTargetArn, 'RedrivePolicy must have deadLetterTargetArn');
    assert.ok(
      typeof redrivePolicy.maxReceiveCount === 'number' && redrivePolicy.maxReceiveCount > 0,
      `maxReceiveCount must be a positive number, got: ${redrivePolicy.maxReceiveCount}`
    );
  });
});

// Req 9.3: BackupLambdaRole has DLQ permissions
describe('Req 9.3: BackupLambdaRole DLQ permissions', () => {
  it('should grant BackupLambdaRole permissions on the DLQ', () => {
    const backupRole = template.Resources.BackupLambdaRole;
    assert.ok(backupRole, 'BackupLambdaRole must exist');

    const statements = backupRole.Properties.Policies.flatMap(
      (p) => p.PolicyDocument.Statement
    );

    // Find statements that reference the DLQ ARN
    const dlqStatements = statements.filter((s) => {
      const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
      return resources.some((r) => {
        if (typeof r === 'string') return r.includes('DeadLetterQueue');
        if (typeof r === 'object' && r !== null) {
          const str = JSON.stringify(r);
          return str.includes('DeadLetterQueue');
        }
        return false;
      });
    });

    assert.ok(dlqStatements.length > 0, 'Must have at least one IAM statement for DLQ');

    const dlqActions = dlqStatements.flatMap((s) => s.Action);
    const requiredActions = ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'];
    for (const action of requiredActions) {
      assert.ok(
        dlqActions.includes(action),
        `BackupLambdaRole must have ${action} on DLQ, found: ${dlqActions.join(', ')}`
      );
    }
  });
});

// Req 18.1: BackupLambdaFunctionName and FilterLambdaFunctionName parameters with correct defaults
describe('Req 18.1: Lambda function name parameters', () => {
  it('should define BackupLambdaFunctionName parameter with correct default', () => {
    const param = template.Parameters.BackupLambdaFunctionName;
    assert.ok(param, 'BackupLambdaFunctionName parameter must exist');
    assert.equal(param.Type, 'String');
    assert.equal(param.Default, 'contentful-backup');
  });

  it('should define FilterLambdaFunctionName parameter with correct default', () => {
    const param = template.Parameters.FilterLambdaFunctionName;
    assert.ok(param, 'FilterLambdaFunctionName parameter must exist');
    assert.equal(param.Type, 'String');
    assert.equal(param.Default, 'amplify-notification-filter');
  });
});

// Req 19.1: BackupBucket has VersioningConfiguration enabled
describe('Req 19.1: BackupBucket versioning', () => {
  it('should have VersioningConfiguration with Status Enabled', () => {
    const bucket = template.Resources.BackupBucket;
    assert.ok(bucket, 'BackupBucket must exist');
    const versioning = bucket.Properties.VersioningConfiguration;
    assert.ok(versioning, 'BackupBucket must have VersioningConfiguration');
    assert.equal(versioning.Status, 'Enabled', 'Versioning status must be Enabled');
  });
});

// Req 20.1: SQS VisibilityTimeout >= 1800
describe('Req 20.1: SQS VisibilityTimeout', () => {
  it('should have VisibilityTimeout >= 1800', () => {
    const sqsQueue = template.Resources.SQSQueue;
    assert.ok(sqsQueue, 'SQSQueue must exist');
    const timeout = sqsQueue.Properties.VisibilityTimeout;
    assert.ok(
      typeof timeout === 'number' && timeout >= 1800,
      `VisibilityTimeout must be >= 1800, got: ${timeout}`
    );
  });
});

// Req 0.5: All existing parameters retained
describe('Req 0.5: Existing parameters retained', () => {
  const requiredParameters = [
    'SnsTopicArn',
    'ContentfulSpaceId',
    'ContentfulDeliveryTokenArn',
    'ContentfulManagementTokenArn',
    'ContentfulSpaceEnvironment',
    'S3BackupBucketName',
    'InitialStorageClass',
    'LongTermStorageClass',
    'LastUpdateUrl',
    'LastUpdateWindow',
  ];

  for (const paramName of requiredParameters) {
    it(`should retain the ${paramName} parameter`, () => {
      assert.ok(
        template.Parameters[paramName],
        `Parameter ${paramName} must exist in the template`
      );
    });
  }
});
