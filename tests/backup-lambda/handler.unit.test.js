'use strict';

// Unit tests for the backup-lambda handler on its TARGET contract.
// Validates: Requirements 0.2, 1.1-1.5, 2.1-2.5, 7.1-7.3, 22.x, 46.x, 14.x.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// --- stub harness ----------------------------------------------------------
let capturedExportOptions;
let s3Commands;
let snsCommands;
let exportBehaviour; // () => Promise<result> | throws
let listBehaviour;   // (key) => Contents entry or null

function makeStubs() {
  return {
    'contentful-export': (options) => {
      capturedExportOptions = options;
      return exportBehaviour();
    },
    archiver: {
      // archiver 8 exports classes, not a callable default.
      ZipArchive: class {
        on() { return this; }
        pipe() { return this; }
        directory() { return this; }
        file() { return this; }
        finalize() { return Promise.resolve(); }
      },
    },
    '@aws-sdk/client-s3': {
      S3Client: class { send(cmd) { s3Commands.push(cmd); return Promise.resolve(cmd.__list ? listBehaviour(cmd) : {}); } },
      CopyObjectCommand: class { constructor(p) { this.params = p; this.__copy = true; } },
      ListObjectsV2Command: class { constructor(p) { this.params = p; this.__list = true; } },
    },
    '@aws-sdk/lib-storage': {
      Upload: class {
        constructor({ params }) { this.params = params; }
        done() {
          // Simulate the PassThrough receiving bytes so the byte counter is > 0.
          const body = this.params.Body;
          if (body && typeof body.write === 'function') { body.write(Buffer.from('zipdata')); body.end(); }
          return Promise.resolve({});
        }
      },
    },
    '@aws-sdk/client-ssm': {
      SSMClient: class {
        send() {
          return Promise.resolve({ Parameters: [
            { ARN: 'arn:mgmt', Value: 'mgmt-token' },
            { ARN: 'arn:delivery', Value: 'delivery-token' },
          ] });
        }
      },
      GetParametersCommand: class { constructor(p) { this.params = p; } },
    },
    '@aws-sdk/client-sns': {
      SNSClient: class { send(cmd) { snsCommands.push(cmd); return Promise.resolve({}); } },
      PublishCommand: class { constructor(p) { this.params = p; this.__publish = true; } },
    },
    fs: {
      existsSync: () => true,
      mkdirSync: () => {},
      statSync: () => ({ size: 10 }),
      rmSync: () => {},
      writeFileSync: () => {},
    },
  };
}

const originalResolve = Module._resolveFilename;
const stubs = makeStubs();
Module._resolveFilename = function (request, parent, ...rest) {
  if (stubs[request] !== undefined) return request;
  return originalResolve.call(this, request, parent, ...rest);
};
for (const [name, exp] of Object.entries(stubs)) {
  require.cache[name] = { id: name, filename: name, loaded: true, exports: exp };
}

process.env.S3_BUCKET_NAME = 'test-bucket';
process.env.S3_STORAGE_CLASS = 'STANDARD';
process.env.MANAGEMENT_TOKEN_ARN = 'arn:mgmt';
process.env.DELIVERY_TOKEN_ARN = 'arn:delivery';
process.env.SPACE_ID = 'space';
process.env.SPACE_ENV = 'master';
process.env.ALERT_TOPIC_ARN = 'arn:aws:sns:eu-central-1:1:alerts';

const { handler, generateS3Key, reconcileAssets } = require('../../backup-lambda/index.js');

const recordWith = (receiveCount) => ({
  receiptHandle: 'rh',
  attributes: { ApproximateReceiveCount: String(receiveCount) },
});
const eventWith = (receiveCount = 1) => ({ Records: [recordWith(receiveCount)] });

describe('Backup handler — target contract', () => {
  beforeEach(() => {
    capturedExportOptions = null;
    s3Commands = [];
    snsCommands = [];
    // default: export resolves with no assets; list finds the object at 7 bytes
    exportBehaviour = () => Promise.resolve({ assets: [] });
    listBehaviour = (cmd) => ({ Contents: [{ Key: cmd.params.Prefix, Size: 7 }] });
  });

  describe('Req 0.2 / 14: export options are published-state, ExO off, limit 200', () => {
    it('passes published-state options and never includeDrafts:true', async () => {
      await handler(eventWith());
      assert.ok(capturedExportOptions);
      assert.equal(capturedExportOptions.includeDrafts, false);
      assert.equal(capturedExportOptions.includeExperienceOrchestration, false);
      assert.equal(capturedExportOptions.maxAllowedLimit, 200);
      assert.equal(capturedExportOptions.downloadAssets, true);
    });
  });

  describe('Req 7 / 1: throws (never returns) on every failure path', () => {
    it('throws on export failure', async () => {
      exportBehaviour = () => Promise.reject(new Error('export boom'));
      await assert.rejects(handler(eventWith()), /export boom/);
    });

    it('throws when a token is missing (before spending quota)', async () => {
      stubs['@aws-sdk/client-ssm'].SSMClient.prototype.send = () =>
        Promise.resolve({ Parameters: [{ ARN: 'arn:mgmt', Value: 'only-mgmt' }] });
      await assert.rejects(handler(eventWith()), /token\(s\) missing/);
      // restore
      stubs['@aws-sdk/client-ssm'].SSMClient.prototype.send = () =>
        Promise.resolve({ Parameters: [
          { ARN: 'arn:mgmt', Value: 'mgmt-token' }, { ARN: 'arn:delivery', Value: 'delivery-token' }] });
    });

    it('throws when a staged object is missing after upload', async () => {
      listBehaviour = () => ({ Contents: [] });
      await assert.rejects(handler(eventWith()), /not found/);
    });

    it('throws when assets are incomplete', async () => {
      exportBehaviour = () => Promise.resolve({
        assets: [{ fields: { file: { url: 'https://images.ctfassets.net/x/missing.png' } } }],
      });
      // fs stub says every file exists at 10 bytes, so force a miss:
      stubs.fs.existsSync = () => false;
      await assert.rejects(handler(eventWith()), /incomplete/);
      stubs.fs.existsSync = () => true;
    });
  });

  describe('Req 46: publish once on first delivery, not on redelivery, not on success', () => {
    it('publishes when ApproximateReceiveCount == 1 and rethrows', async () => {
      exportBehaviour = () => Promise.reject(new Error('boom'));
      await assert.rejects(handler(eventWith(1)));
      const publishes = snsCommands.filter((c) => c.__publish);
      assert.equal(publishes.length, 1, 'exactly one alert on first delivery');
    });

    it('does NOT publish on redelivery (count > 1)', async () => {
      exportBehaviour = () => Promise.reject(new Error('boom'));
      await assert.rejects(handler(eventWith(3)));
      assert.equal(snsCommands.filter((c) => c.__publish).length, 0);
    });

    it('does NOT publish on success', async () => {
      await handler(eventWith(1));
      assert.equal(snsCommands.filter((c) => c.__publish).length, 0);
    });
  });

  describe('Req 2 / 22: message lifecycle and envelope validation', () => {
    it('throws on an empty Records envelope', async () => {
      await assert.rejects(handler({ Records: [] }), /no SQS records/);
      await assert.rejects(handler({}), /no SQS records/);
    });

    it('never issues an SQS DeleteMessage (the ESM deletes on clean return)', async () => {
      await handler(eventWith());
      const deletes = s3Commands.filter((c) => c && c.constructor && /Delete/.test(c.constructor.name));
      assert.equal(deletes.length, 0);
    });

    it('promotes staging -> final via CopyObject on success', async () => {
      await handler(eventWith());
      assert.ok(s3Commands.some((c) => c.__copy), 'a CopyObject must promote the archive');
    });
  });

  describe('generateS3Key: final key matches the coverage archive pattern', () => {
    it('ends .<ms>Z.zip', () => {
      const { zipFilename } = generateS3Key(new Date('2026-09-20T04:52:00.336Z'));
      assert.match(zipFilename, /\.\d{3}Z\.zip$/);
    });
  });

  describe('reconcileAssets: pure completeness check', () => {
    it('reports missing assets whose files are absent', () => {
      stubs.fs.existsSync = () => false;
      try {
        const { total, missing } = reconcileAssets(
          { assets: [{ fields: { file: { url: 'https://x/y.png' } } }] },
          '/tmp/backup'
        );
        assert.equal(total, 1);
        assert.equal(missing.length, 1);
      } finally {
        stubs.fs.existsSync = () => true;
      }
    });

    it('reports complete when every asset file is present', () => {
      const { total, missing } = reconcileAssets(
        { assets: [{ fields: { file: { url: 'https://x/y.png' } } }] },
        '/tmp/backup'
      );
      assert.equal(total, 1);
      assert.equal(missing.length, 0);
    });
  });
});
