// S3 lifecycle, ownership, bucket policy, and OFF-by-default durability gates.
// Validates: Requirements 34.1-34.11, 35.x, 36.x, 37.x, 38.x.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadTemplate, resourcesOfType } = require('../helpers/cfn-template');

const template = loadTemplate();
const bucket = template.Resources.BackupBucket;
const rules = bucket.Properties.LifecycleConfiguration.Rules;
const ruleById = (id) => rules.find((r) => r.Id === id);

describe('Req 34: lifecycle retains the newest, expires only noncurrent', () => {
  it('has NO current-version ExpirationInDays on any non-staging rule', () => {
    for (const r of rules) {
      if (r.Prefix === 'staging/') continue;
      assert.ok(!('ExpirationInDays' in r), `rule ${r.Id} must not expire current versions`);
    }
  });

  it('expires noncurrent versions, bounded above the transition', () => {
    const nc = ruleById('ExpireNoncurrentVersions');
    assert.ok(nc && nc.NoncurrentVersionExpiration, 'must expire noncurrent versions');
    const ncDays = template.Parameters.NoncurrentVersionRetentionDays;
    const transDays = template.Parameters.TransitionDays;
    assert.ok(ncDays.MinValue > transDays.Default, 'noncurrent retention floor must exceed the transition');
  });

  it('removes expired delete markers and aborts incomplete MPU after 1 day', () => {
    assert.ok(ruleById('RemoveExpiredDeleteMarkers').ExpiredObjectDeleteMarker === true);
    assert.equal(ruleById('AbortIncompleteMultipartUploads').AbortIncompleteMultipartUpload.DaysAfterInitiation, 1);
  });

  it('has a short-TTL expiry scoped to the staging prefix', () => {
    const staging = ruleById('ExpireStagingPrefix');
    assert.equal(staging.Prefix, 'staging/');
    assert.ok('ExpirationInDays' in staging);
  });

  it('transitions current objects to LongTermStorageClass', () => {
    const t = ruleById('TransitionCurrentToLongTerm');
    assert.ok(t.Transitions[0].StorageClass, 'must transition to a long-term class');
  });
});

describe('Req 35/36: ownership, retain, TLS+SSE policy', () => {
  it('sets BucketOwnerEnforced ownership', () => {
    assert.equal(bucket.Properties.OwnershipControls.Rules[0].ObjectOwnership, 'BucketOwnerEnforced');
  });

  it('retains the bucket on delete and replace', () => {
    assert.equal(bucket.DeletionPolicy, 'Retain');
    assert.equal(bucket.UpdateReplacePolicy, 'Retain');
  });

  it('has a bucket policy denying non-TLS access, and no SSE-header deny that would block default-encrypted uploads', () => {
    const stmts = template.Resources.BackupBucketPolicy.Properties.PolicyDocument.Statement;
    assert.ok(stmts.some((s) => s.Sid === 'DenyNonTLS' && s.Effect === 'Deny'));
    // The DenyUnencryptedPutObject statement was removed: it denied PutObject
    // requests that omit the SSE header, which blocked the Backup function's
    // own streamed upload. Bucket default encryption covers encryption at rest.
    assert.ok(
      !stmts.some((s) => s.Sid === 'DenyUnencryptedPutObject'),
      'the SSE-header PutObject deny must not be present (it blocked legitimate uploads)'
    );
  });

  it('declares NO LoggingConfiguration and NO second bucket', () => {
    assert.ok(!bucket.Properties.LoggingConfiguration, 'access logging must be absent');
    assert.equal(resourcesOfType(template, 'AWS::S3::Bucket').length, 1, 'exactly one bucket');
  });
});

describe('Req 37/38: replication and Object Lock are OFF-by-default opt-ins', () => {
  it('neither feature parameter is required to deploy (both default and off)', () => {
    for (const p of ['EnableReplication', 'EnableObjectLock']) {
      assert.equal(template.Parameters[p].Default, 'false', `${p} must default off`);
    }
    for (const p of ['ReplicationDestinationBucketArn', 'ReplicationRoleArn']) {
      assert.equal(template.Parameters[p].Default, '', `${p} must have an empty default`);
    }
  });

  it('replication and object lock use conditions with NoValue when off', () => {
    assert.ok(template.Conditions.ReplicationEnabled);
    assert.ok(template.Conditions.ObjectLockEnabled);
    const repl = JSON.stringify(bucket.Properties.ReplicationConfiguration);
    const lock = JSON.stringify(bucket.Properties.ObjectLockConfiguration);
    assert.ok(repl.includes('ReplicationEnabled') && repl.includes('AWS::NoValue'));
    assert.ok(lock.includes('ObjectLockEnabled') && lock.includes('AWS::NoValue'));
  });

  it('Object Lock retention is bounded against the noncurrent retention', () => {
    const lockDays = template.Parameters.ObjectLockRetentionDays;
    assert.ok(lockDays.MaxValue <= template.Parameters.NoncurrentVersionRetentionDays.MaxValue);
  });
});
