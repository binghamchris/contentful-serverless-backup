'use strict';

// Bug 2: the real Amplify build notification is PROSE, not jobStatus JSON, and
// contains TWO urls (the app url and a console url). The status must be read
// from the prose, and the branch must come from the amplifyapp.com host (or the
// console /branches/ path) — never a naive first-url grab that could pick up
// the `console` host. Validates: Requirements 18.x, 21.x.

const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const stubs = {
  '@aws-sdk/client-sqs': { SQSClient: class {}, SendMessageCommand: class {} },
  '@aws-sdk/client-s3': { S3Client: class {}, ListObjectsV2Command: class {} },
  '@aws-sdk/client-ssm': { SSMClient: class {}, GetParameterCommand: class {}, PutParameterCommand: class {} },
  '@aws-sdk/client-sns': { SNSClient: class {}, PublishCommand: class {} },
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
const fs = require('node:fs');
const path = require('node:path');
const { STATUS_RE, branchFromAmplifyMessage } = require('../../filter-lambda/index.js');

const amplifyBody = () =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'amplify-sns-notification.json'), 'utf8'))
    .Records[0].Sns.Message;

describe('STATUS_RE: matches the real Amplify prose form', () => {
  it('captures SUCCEED from "Your build status is SUCCEED."', () => {
    const m = STATUS_RE.exec(amplifyBody());
    assert.ok(m && m[1].toUpperCase() === 'SUCCEED');
  });

  it('captures FAILED / CANCELLED from the same prose shape', () => {
    assert.equal(STATUS_RE.exec('Your build status is FAILED.')[1].toUpperCase(), 'FAILED');
    assert.equal(STATUS_RE.exec('Your build status is CANCELLED.')[1].toUpperCase(), 'CANCELLED');
  });

  it('still matches the jobStatus JSON form (back-compat)', () => {
    assert.equal(STATUS_RE.exec('{"jobStatus":"SUCCEED"}')[1].toUpperCase(), 'SUCCEED');
  });

  it('does NOT match the word SUCCEED in unrelated prose (no status wording)', () => {
    assert.equal(STATUS_RE.exec('the build did SUCCEED wonderfully according to the team'), null);
  });
});

describe('branchFromAmplifyMessage: robust against the console URL trap', () => {
  it('extracts the branch from the amplifyapp.com host, NOT the console host', () => {
    const branch = branchFromAmplifyMessage(amplifyBody());
    assert.equal(branch, 'main');            // from main.exampleappid00.amplifyapp.com
    assert.notEqual(branch, 'console');       // the trap: console.aws.amazon.com appears too
  });

  it('is not fooled if the console URL appears BEFORE the app URL', () => {
    const body = 'See https://console.aws.amazon.com/amplify/apps/x/branches/release?region=eu-central-1 ... app: https://release.exampleappid00.amplifyapp.com/. Your build status is SUCCEED.';
    assert.equal(branchFromAmplifyMessage(body), 'release');
  });

  it('falls back to the /branches/<name> console path when no amplifyapp host is present', () => {
    const body = 'Build done. Go to https://console.aws.amazon.com/amplify/apps/x/branches/feature-42?region=eu-central-1';
    assert.equal(branchFromAmplifyMessage(body), 'feature-42');
  });

  it('returns null for a body with no recognisable branch', () => {
    assert.equal(branchFromAmplifyMessage('a plain message with no urls'), null);
    for (const bad of [null, undefined, 42, {}]) assert.equal(branchFromAmplifyMessage(bad), null);
  });
});
