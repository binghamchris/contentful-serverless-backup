// Unit tests for CloudFormation template structure
// Validates: Requirements 7.1, 8.1, 9.1, 9.2, 9.3, 18.1, 19.1, 20.1, 0.5

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadTemplate } = require('../helpers/cfn-template');

const template = loadTemplate();
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
    // maxReceiveCount is now the bounded MaxReceiveCount parameter (Ref),
    // not a literal; the numeric bound is asserted in queue-timing.unit.test.js.
    const mrc = redrivePolicy.maxReceiveCount;
    const isRefOrPositive =
      (typeof mrc === 'object' && mrc !== null && 'Fn::Ref' in mrc) ||
      (typeof mrc === 'number' && mrc > 0);
    assert.ok(
      isRefOrPositive,
      `maxReceiveCount must be a positive number or a parameter Ref, got: ${JSON.stringify(mrc)}`
    );
  });
});

// Req 9.3: DLQ consumption permissions belong to the NOTIFIER role (the DLQ
// consumer), NOT the Backup role — the redesign moved dead-letter handling to
// the Notifier. The Backup role must NOT hold DLQ grants (task 6).
describe('Req 9.3: DLQ permissions on the Notifier, not the Backup role', () => {
  it('should grant the NotifierLambdaRole receive/delete/getattributes on the DLQ', () => {
    const notifierRole = template.Resources.NotifierLambdaRole;
    assert.ok(notifierRole, 'NotifierLambdaRole must exist');

    const statements = notifierRole.Properties.Policies.flatMap(
      (p) => p.PolicyDocument.Statement
    );
    const dlqStatements = statements.filter((s) => {
      const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
      return resources.some((r) => JSON.stringify(r).includes('DeadLetterQueue'));
    });
    assert.ok(dlqStatements.length > 0, 'Notifier must have an IAM statement for the DLQ');

    const dlqActions = dlqStatements.flatMap((s) => s.Action);
    for (const action of ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes']) {
      assert.ok(dlqActions.includes(action), `Notifier must have ${action} on the DLQ`);
    }
  });

  it('should NOT grant the Backup role any DLQ permissions', () => {
    const backupRole = JSON.stringify(template.Resources.BackupLambdaRole);
    assert.ok(!backupRole.includes('DeadLetterQueue'), 'Backup role must not reference the DLQ');
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
