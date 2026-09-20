// Queue timing chain, terminal queue, SSE and TLS-deny policies.
// Validates: Requirements 3.1-3.6, 39.1-39.7.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadTemplate, resourcesOfType } = require('../helpers/cfn-template');

const template = loadTemplate();
const R = template.Resources;

const sourceTimeout = R.SQSQueue.Properties.VisibilityTimeout;
const sourceRetention = R.SQSQueue.Properties.MessageRetentionPeriod;
const maxReceiveDefault = template.Parameters.MaxReceiveCount.Default;
const backupTimeout = R.BackupLambdaFunc.Properties.Timeout;

describe('Req 3: source queue timing chain is internally consistent', () => {
  it('VisibilityTimeout >= 6 x Backup Timeout', () => {
    assert.ok(
      sourceTimeout >= 6 * backupTimeout,
      `VisibilityTimeout ${sourceTimeout} must be >= 6 x Backup Timeout ${backupTimeout} (${6 * backupTimeout})`
    );
  });

  it('MessageRetentionPeriod >= 2 x VisibilityTimeout x MaxReceiveCount', () => {
    const need = 2 * sourceTimeout * maxReceiveDefault;
    assert.ok(
      sourceRetention >= need,
      `MessageRetentionPeriod ${sourceRetention} must be >= 2 x ${sourceTimeout} x ${maxReceiveDefault} = ${need}`
    );
  });

  it('redrive maxReceiveCount is the bounded parameter', () => {
    assert.deepEqual(
      R.SQSQueue.Properties.RedrivePolicy.maxReceiveCount,
      { 'Fn::Ref': 'MaxReceiveCount' }
    );
    const p = template.Parameters.MaxReceiveCount;
    assert.equal(p.Default, 2);
    assert.equal(p.MinValue, 1);
    assert.ok(p.MaxValue <= 10);
  });
});

describe('Req 39: terminal queue and DLQ redrive', () => {
  it('declares a TerminalQueue FIFO with no consumer', () => {
    const tq = R.TerminalQueue;
    assert.ok(tq, 'TerminalQueue must exist');
    assert.equal(tq.Type, 'AWS::SQS::Queue');
    assert.equal(tq.Properties.FifoQueue, true);
    const mappings = resourcesOfType(template, 'AWS::Lambda::EventSourceMapping')
      .filter((n) => JSON.stringify(R[n].Properties.EventSourceArn).includes('TerminalQueue'));
    assert.equal(mappings.length, 0, 'TerminalQueue must have no event-source mapping');
  });

  it('DLQ has short visibility and redrives to the TerminalQueue', () => {
    const dlq = R.DeadLetterQueue.Properties;
    assert.equal(dlq.VisibilityTimeout, 60);
    assert.ok(JSON.stringify(dlq.RedrivePolicy.deadLetterTargetArn).includes('TerminalQueue'));
    assert.equal(dlq.RedrivePolicy.maxReceiveCount, 2);
  });

  it('DLQ RedriveAllowPolicy names the source queue via !Sub, not !GetAtt', () => {
    const rap = R.DeadLetterQueue.Properties.RedriveAllowPolicy;
    assert.ok(rap, 'DLQ must set RedriveAllowPolicy');
    const arn = JSON.stringify(rap.sourceQueueArns);
    assert.ok(arn.includes('Fn::Sub'), 'source ARN must be built with !Sub to avoid a circular dependency');
    assert.ok(!arn.includes('Fn::GetAtt'), 'source ARN must not use !GetAtt (circular dependency)');
    assert.ok(arn.includes('contentfulBackupQueue.fifo'));
  });
});

describe('Req 39: SSE on all queues and a TLS-deny policy per queue', () => {
  const queues = ['SQSQueue', 'DeadLetterQueue', 'TerminalQueue'];

  for (const q of queues) {
    it(`${q} enables SqsManagedSseEnabled`, () => {
      assert.equal(R[q].Properties.SqsManagedSseEnabled, true);
    });
  }

  it('every queue has a QueuePolicy denying non-TLS access', () => {
    const policies = resourcesOfType(template, 'AWS::SQS::QueuePolicy');
    assert.equal(policies.length, 3, `expected 3 queue policies, got ${policies.length}`);
    for (const pol of policies) {
      const stmts = R[pol].Properties.PolicyDocument.Statement;
      const denyTls = stmts.find((s) =>
        s.Effect === 'Deny' &&
        s.Condition && s.Condition.Bool &&
        String(s.Condition.Bool['aws:SecureTransport']) === 'false');
      assert.ok(denyTls, `${pol} must deny non-TLS access`);
    }
  });
});
