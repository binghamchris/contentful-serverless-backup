'use strict';

// Guards the js-yaml 5 migration of the CloudFormation intrinsic-tag schema.
// js-yaml 5 removed the `Type` constructor and `DEFAULT_SCHEMA.extend()` that
// the v4 helper used; tags are now built with defineScalarTag /
// defineSequenceTag / defineMappingTag and composed into a `Schema`.
//
// The parsed SHAPE must stay identical to the v4 output, because every
// infrastructure test asserts against it (e.g. { 'Fn::Sub': '...' }). These
// cases pin that shape for all three YAML node kinds so a future schema change
// cannot silently alter how the template is read.
// Validates: Requirement 45.6.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const { CFN_SCHEMA, loadTemplate } = require('../helpers/cfn-template');

const parse = (src) => yaml.load(src, { schema: CFN_SCHEMA });

describe('js-yaml 5 CFN schema: intrinsic tags parse to the Fn:: shape', () => {
  it('SCALAR form: !Sub / !Ref / !GetAtt', () => {
    assert.deepEqual(parse('v: !Sub "a-${X}"'), { v: { 'Fn::Sub': 'a-${X}' } });
    assert.deepEqual(parse('v: !Ref MyThing'), { v: { 'Fn::Ref': 'MyThing' } });
    assert.deepEqual(parse('v: !GetAtt Role.Arn'), { v: { 'Fn::GetAtt': 'Role.Arn' } });
  });

  it('SEQUENCE form: !If / !Join / !Equals', () => {
    assert.deepEqual(parse('v: !If [Cond, true, false]'), { v: { 'Fn::If': ['Cond', true, false] } });
    assert.deepEqual(parse('v: !Join ["-", [a, b]]'), { v: { 'Fn::Join': ['-', ['a', 'b']] } });
    assert.deepEqual(parse('v: !Equals [!Ref P, "yes"]'), {
      v: { 'Fn::Equals': [{ 'Fn::Ref': 'P' }, 'yes'] },
    });
  });

  it('MAPPING form is supported for every intrinsic', () => {
    assert.deepEqual(parse('v: !Sub\n  k: val'), { v: { 'Fn::Sub': { k: 'val' } } });
  });

  it('nested intrinsics compose (a sequence containing scalars)', () => {
    const out = parse('v: !Join ["/", [!Ref Bucket, !Sub "${Prefix}/x"]]');
    assert.deepEqual(out, {
      v: { 'Fn::Join': ['/', [{ 'Fn::Ref': 'Bucket' }, { 'Fn::Sub': '${Prefix}/x' }]] },
    });
  });

  it('plain YAML (no tags) is unaffected by the custom schema', () => {
    assert.deepEqual(parse('a: 1\nb: two\nc: true\nd:\n  - x\n  - y'), {
      a: 1, b: 'two', c: true, d: ['x', 'y'],
    });
  });

  it('the real template still parses to the expected structure', () => {
    const t = loadTemplate();
    assert.ok(t.Resources && t.Parameters, 'template must have Resources and Parameters');
    // Spot-check one of each node kind as it appears in the real template.
    assert.deepEqual(t.Resources.BackupLogGroup.Properties.LogGroupName,
      { 'Fn::Sub': '/aws/lambda/${AWS::StackName}/backup' });
    assert.deepEqual(t.Resources.BackupLambdaSQSTrigger.Properties.Enabled,
      { 'Fn::If': ['MappingsEnabled', true, false] });
    assert.deepEqual(t.Resources.BackupLambdaFunc.Properties.Role,
      { 'Fn::GetAtt': 'BackupLambdaRole.Arn' });
  });
});
