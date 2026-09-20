// Alert topic, fail-open Notifier placeholder, gated mappings, gated subscription.
// Validates: Requirements 4.1-4.6, 6.1-6.8, 7.4, 7.5, 7.6.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadTemplate, resourcesOfType } = require('../helpers/cfn-template');

const template = loadTemplate();
const R = template.Resources;

describe('Req 4: alert topic and its publishers', () => {
  it('declares an SSE-encrypted standard SNS AlertTopic', () => {
    const t = R.AlertTopic;
    assert.ok(t, 'AlertTopic must exist');
    assert.equal(t.Type, 'AWS::SNS::Topic');
    assert.ok(t.Properties.KmsMasterKeyId, 'AlertTopic must set a KMS key for SSE');
  });

  it('publishes the topic ARN as an output', () => {
    assert.ok(template.Outputs && template.Outputs.AlertTopicArn, 'AlertTopicArn output must exist');
  });

  it('enumerates permitted publishers as the three function roles', () => {
    const stmt = R.AlertTopicPolicy.Properties.PolicyDocument.Statement
      .find((s) => s.Effect === 'Allow' && [].concat(s.Action).includes('sns:Publish'));
    assert.ok(stmt, 'must have an Allow sns:Publish statement');
    const principals = JSON.stringify(stmt.Principal.AWS);
    for (const role of ['BackupLambdaRole', 'FilterLambdaRole', 'NotifierLambdaRole']) {
      assert.ok(principals.includes(role), `permitted publishers must include ${role}`);
    }
  });

  it('AlertEmail parameter is validated and the subscription is condition-gated', () => {
    const p = template.Parameters.AlertEmail;
    assert.ok(p.AllowedPattern, 'AlertEmail must have an AllowedPattern');
    const sub = R.AlertEmailSubscription;
    assert.ok(sub, 'AlertEmailSubscription must exist');
    assert.equal(sub.Condition, 'ShouldSubscribeAlertEmail');
    assert.ok(template.Conditions.ShouldSubscribeAlertEmail, 'gating condition must exist');
  });
});

describe('Req 6: Notifier placeholder publishes and does not throw', () => {
  it('NotifierLambdaFunc exists and its placeholder publishes to SNS', () => {
    const fn = R.NotifierLambdaFunc;
    assert.ok(fn, 'NotifierLambdaFunc must exist');
    const code = fn.Properties.Code.ZipFile;
    assert.ok(code.includes('PublishCommand'), 'placeholder must publish to SNS');
    assert.ok(!/throw\s/.test(code), 'Notifier placeholder must NOT throw (fail open)');
  });

  it('the two other functions placeholders DO throw (fail closed)', () => {
    for (const fn of ['BackupLambdaFunc', 'FilterLambdaFunc']) {
      const code = R[fn].Properties.Code.ZipFile;
      assert.ok(/throw\s/.test(code), `${fn} placeholder must throw`);
    }
  });
});

describe('Req 7: both mappings are gated by EventSourceMappingEnabled', () => {
  const mappings = resourcesOfType(template, 'AWS::Lambda::EventSourceMapping');

  it('there is a source-queue mapping and a DLQ->Notifier mapping', () => {
    const dlqMapping = mappings.find((n) =>
      JSON.stringify(R[n].Properties.EventSourceArn).includes('DeadLetterQueue'));
    assert.ok(dlqMapping, 'a DLQ->Notifier mapping must exist');
    // js-yaml parses `!GetAtt NotifierLambdaFunc.Arn` (dotted scalar) to the
    // string form Fn::GetAtt: "NotifierLambdaFunc.Arn".
    assert.ok(
      JSON.stringify(R[dlqMapping].Properties.FunctionName).includes('NotifierLambdaFunc'),
      'DLQ mapping must target the Notifier function'
    );
    assert.equal(R[dlqMapping].Properties.BatchSize, 1);
  });

  it('every mapping honours the MappingsEnabled condition', () => {
    for (const m of mappings) {
      assert.deepEqual(
        R[m].Properties.Enabled,
        { 'Fn::If': ['MappingsEnabled', true, false] },
        `${m} must gate Enabled on MappingsEnabled`
      );
    }
    assert.ok(template.Conditions.MappingsEnabled, 'MappingsEnabled condition must exist');
  });
});
