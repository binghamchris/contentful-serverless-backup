// IAM invariant: no role holds s3:GetObject / s3:GetObjectVersion on the
// archive (final) prefix. GetObject is permitted ONLY on the staging prefix,
// for the CopyObject promotion. Validates: Requirements 50.8, 16.x.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadTemplate, resourcesOfType } = require('../helpers/cfn-template');

const template = loadTemplate();

describe('Req 50.8: GetObject only on the staging prefix', () => {
  const roles = resourcesOfType(template, 'AWS::IAM::Role');

  it('no role grants GetObject/GetObjectVersion on the archive prefix', () => {
    for (const roleName of roles) {
      const statements = (template.Resources[roleName].Properties.Policies || [])
        .flatMap((p) => p.PolicyDocument.Statement);
      for (const s of statements) {
        const actions = [].concat(s.Action);
        const grantsGet = actions.some((a) => a === 's3:GetObject' || a === 's3:GetObjectVersion' || a === 's3:*');
        if (!grantsGet) continue;
        const resources = [].concat(s.Resource).map((r) => JSON.stringify(r));
        for (const r of resources) {
          // A GetObject grant must be scoped to the staging prefix.
          if (r.includes('BackupBucket') || r.includes('S3BackupBucketName')) {
            assert.ok(
              r.includes('staging'),
              `${roleName} grants GetObject on a non-staging bucket resource: ${r}`
            );
          }
        }
      }
    }
  });

  it('the Backup role DOES grant GetObject on the staging prefix', () => {
    const statements = template.Resources.BackupLambdaRole.Properties.Policies
      .flatMap((p) => p.PolicyDocument.Statement);
    const getStmt = statements.find((s) => [].concat(s.Action).includes('s3:GetObject'));
    assert.ok(getStmt, 'Backup role must grant s3:GetObject for promotion');
    assert.ok(JSON.stringify(getStmt.Resource).includes('staging'), 'must be scoped to staging/*');
  });
});
