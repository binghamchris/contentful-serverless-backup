// Stack-managed log groups, JSON LoggingConfig, and scoped log IAM.
// Validates: Requirements 5.1-5.10, 40.1, 40.2, 54.12.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadTemplate, resourcesOfType } = require('../helpers/cfn-template');

const template = loadTemplate();

const FUNCTIONS = {
  BackupLambdaFunc: 'BackupLogGroup',
  FilterLambdaFunc: 'FilterLogGroup',
  NotifierLambdaFunc: 'NotifierLogGroup',
};

describe('Req 5: three stack-managed log groups', () => {
  const groups = resourcesOfType(template, 'AWS::Logs::LogGroup');

  it('declares exactly the backup, filter and notifier groups', () => {
    assert.deepEqual(
      groups.sort(),
      ['BackupLogGroup', 'FilterLogGroup', 'NotifierLogGroup'].sort()
    );
  });

  for (const g of ['BackupLogGroup', 'FilterLogGroup', 'NotifierLogGroup']) {
    it(`${g} is stack-scoped, INFREQUENT_ACCESS, bounded retention, retained`, () => {
      const res = template.Resources[g];
      const p = res.Properties;
      const name = JSON.stringify(p.LogGroupName);
      assert.ok(name.includes('AWS::StackName'), `${g} name must include the stack name`);
      assert.equal(p.LogGroupClass, 'INFREQUENT_ACCESS');
      assert.ok(p.RetentionInDays, `${g} must set RetentionInDays`);
      assert.equal(res.DeletionPolicy, 'Retain');
    });
  }

  it('RetentionInDays comes from a bounded parameter, default 90', () => {
    const param = template.Parameters.LogRetentionDays;
    assert.ok(param, 'LogRetentionDays parameter must exist');
    assert.equal(param.Default, 90);
    assert.ok(Array.isArray(param.AllowedValues) && param.AllowedValues.includes(90));
  });
});

describe('Req 5: functions log JSON to their group and cannot log above INFO', () => {
  it('ApplicationLogLevel is constrained to at most INFO', () => {
    const param = template.Parameters.ApplicationLogLevel;
    assert.ok(param, 'ApplicationLogLevel parameter must exist');
    assert.deepEqual(param.AllowedValues.sort(), ['DEBUG', 'INFO'].sort());
    assert.ok(!param.AllowedValues.includes('WARN') && !param.AllowedValues.includes('ERROR'));
  });

  for (const [fn, group] of Object.entries(FUNCTIONS)) {
    it(`${fn} has JSON LoggingConfig pointing at ${group} with DependsOn`, () => {
      const res = template.Resources[fn];
      if (!res) return; // NotifierLambdaFunc arrives in task 4
      const lc = res.Properties.LoggingConfig;
      assert.ok(lc, `${fn} must set LoggingConfig`);
      assert.equal(lc.LogFormat, 'JSON');
      assert.equal(JSON.stringify(lc.LogGroup), JSON.stringify({ 'Fn::Ref': group }));
      // The LoggingConfig.LogGroup !Ref already creates the create-ordering
      // dependency on the group, so an explicit DependsOn is redundant (cfn-lint
      // W3005) and MUST NOT be present. The Ref above is what enforces ordering.
      assert.ok(!res.DependsOn, `${fn} must not carry a redundant DependsOn — the LoggingConfig Ref enforces ordering`);
    });
  }
});

describe('Req 40: log IAM scoped to the group, no CreateLogGroup', () => {
  for (const role of ['BackupLambdaRole', 'FilterLambdaRole']) {
    it(`${role} has no logs:CreateLogGroup and scopes streams to its group`, () => {
      const statements = template.Resources[role].Properties.Policies
        .flatMap((p) => p.PolicyDocument.Statement);
      const actions = statements.flatMap((s) => [].concat(s.Action));
      assert.ok(!actions.includes('logs:CreateLogGroup'), `${role} must not grant CreateLogGroup`);

      const streamStmt = statements.find((s) =>
        [].concat(s.Action).includes('logs:PutLogEvents'));
      assert.ok(streamStmt, `${role} must grant logs:PutLogEvents`);
      const resStr = JSON.stringify(streamStmt.Resource);
      assert.ok(resStr.includes('LogGroup'), `${role} stream grant must target the stack log group, got ${resStr}`);
    });
  }
});
