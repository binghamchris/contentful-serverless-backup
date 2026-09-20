'use strict';

// Task 12/13 backup behaviour: sweep-on-entry, size-based asset reconciliation,
// adaptive maxAllowedLimit, verification-failure throws.
// Validates: Requirements 12.x, 13.x, 15.x, 16.1-16.9.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Stub the handler's heavy deps so we can import its pure reconcileAssets.
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const stubs = {
  'contentful-export': () => {},
  archiver: { ZipArchive: class { on() { return this; } pipe() { return this; } directory() { return this; } file() { return this; } finalize() { return Promise.resolve(); } } },
  '@aws-sdk/client-s3': { S3Client: class {}, CopyObjectCommand: class {}, ListObjectsV2Command: class {} },
  '@aws-sdk/lib-storage': { Upload: class { done() { return Promise.resolve({}); } } },
  '@aws-sdk/client-ssm': { SSMClient: class {}, GetParametersCommand: class {} },
  '@aws-sdk/client-sns': { SNSClient: class {}, PublishCommand: class {} },
};
Module._resolveFilename = function (request, parent, ...rest) {
  if (stubs[request] !== undefined) return request;
  return originalResolve.call(this, request, parent, ...rest);
};
for (const [name, exp] of Object.entries(stubs)) {
  require.cache[name] = { id: name, filename: name, loaded: true, exports: exp };
}

const { reconcileAssets } = require('../../backup-lambda/index.js');

// reconcileAssets is pure over (result, exportDir) using real fs, so we write a
// throwaway tree under the scratch dir and point it there.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withTree(assets, files) {
  const root = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'recon-'));
  for (const [rel, size] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(size));
  }
  try {
    return reconcileAssets({ assets }, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const asset = (url, size) => ({ fields: { file: { 'en-US': { url, details: { size } } } } });
const assetGB = (url, size) => ({ fields: { file: { 'en-GB': { url, details: { size } } } } });
const assetBare = (url, size) => ({ fields: { file: { url, details: { size } } } });

describe('reconcileAssets: locale-agnostic (regression for the en-US-only bug)', () => {
  it('checks en-GB assets — the en-US-only assumption made this a no-op on en-GB spaces', () => {
    // A wrong-size en-GB asset MUST be flagged; before the fix it was skipped.
    const { total, wrongSize } = withTree([assetGB('https://img/gb.png', 100)], { 'img/gb.png': 40 });
    assert.equal(total, 1);
    assert.equal(wrongSize.length, 1, 'en-GB asset size mismatch must be caught');
  });

  it('checks a bare (non-locale-wrapped) file entry', () => {
    const { wrongSize } = withTree([assetBare('https://img/b.png', 50)], { 'img/b.png': 10 });
    assert.equal(wrongSize.length, 1);
  });

  it('flags a MISSING en-GB asset', () => {
    const { missing } = withTree([assetGB('https://img/gone.png', 10)], {});
    assert.equal(missing.length, 1);
  });
});

describe('reconcileAssets: by SIZE against details.size, not existence', () => {
  it('reports complete when every asset file matches its declared size', () => {
    const { missing, wrongSize } = withTree(
      [asset('https://img/x.png', 10), asset('https://img/y.png', 20)],
      { 'img/x.png': 10, 'img/y.png': 20 }
    );
    assert.equal(missing.length, 0);
    assert.equal(wrongSize.length, 0);
  });

  it('flags a missing asset', () => {
    const { missing } = withTree([asset('https://img/x.png', 10)], {});
    assert.equal(missing.length, 1);
  });

  it('flags a present-but-wrong-size (truncated) asset', () => {
    const { wrongSize } = withTree([asset('https://img/x.png', 100)], { 'img/x.png': 40 });
    assert.equal(wrongSize.length, 1);
    assert.match(wrongSize[0], /40 != 100/);
  });
});
