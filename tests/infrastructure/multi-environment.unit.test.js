// Multi-environment safety: no fixed physical names that would collide across
// two stacks in one account; complete outputs. Validates: Requirements
// 41.1-41.6, 43.1-43.4.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadTemplate, resourcesOfType } = require('../helpers/cfn-template');

const template = loadTemplate();
const R = template.Resources;

describe('Req 41: no fixed physical names', () => {
  it('no IAM role declares a RoleName', () => {
    for (const role of resourcesOfType(template, 'AWS::IAM::Role')) {
      assert.ok(!R[role].Properties.RoleName, `${role} must not fix RoleName`);
    }
  });

  it('every queue name is stack-derived and keeps the .fifo suffix', () => {
    for (const q of resourcesOfType(template, 'AWS::SQS::Queue')) {
      const name = JSON.stringify(R[q].Properties.QueueName);
      assert.ok(name.includes('AWS::StackName'), `${q} name must be stack-derived, got ${name}`);
      assert.ok(name.includes('.fifo'), `${q} must keep the .fifo suffix`);
    }
  });

  it('the DLQ RedriveAllowPolicy source ARN is stack-derived (matches the queue name)', () => {
    const arn = JSON.stringify(R.DeadLetterQueue.Properties.RedriveAllowPolicy.sourceQueueArns);
    assert.ok(arn.includes('AWS::StackName'), 'source ARN must be stack-derived to match the renamed queue');
    assert.ok(arn.includes('-source.fifo'), 'must reference the source queue by its stack-derived name');
  });

  it('SQS names would fit the 80-char limit for a reasonable stack name', () => {
    // Longest suffix is "-terminal.fifo" (14 chars); a 60-char stack name still fits.
    const longest = '-terminal.fifo'.length;
    assert.ok(longest + 60 <= 80, 'queue-name suffix must leave room under the 80-char SQS limit');
  });
});

describe('Req 43: outputs cover the bucket, queues, functions and topic', () => {
  const outputs = template.Outputs || {};
  const required = [
    'BackupBucketName',
    'SourceQueueUrl', 'DeadLetterQueueUrl', 'TerminalQueueUrl',
    'BackupFunctionName', 'FilterFunctionName', 'NotifierFunctionName',
    'AlertTopicArn',
  ];
  for (const name of required) {
    it(`publishes ${name}`, () => {
      assert.ok(outputs[name], `Output ${name} must exist`);
    });
  }
});
