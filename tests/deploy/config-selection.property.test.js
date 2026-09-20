// Feature: project-quality-overhaul, Property 7: Build script config selection maps arguments to correct Lambda configuration
// Validates: Requirements 14.1, 14.3

// Stub out heavy dependencies before requiring deploy/build-lambda.js
// getConfig is a pure function and doesn't use any of these, but the module
// requires them at top level and has an async IIFE that runs on require.
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const stubs = {
  'dotenv': { config: () => {} },
  'archiver': () => ({ on() { return this; }, pipe() { return this; }, file() { return this; }, finalize() { return Promise.resolve(); } }),
  '@aws-sdk/credential-providers': { fromIni: () => ({}) },
  '@aws-sdk/client-lambda': { LambdaClient: class {}, UpdateFunctionCodeCommand: class {}, TagResourceCommand: class {}, ListVersionsByFunctionCommand: class {}, DeleteFunctionCommand: class {} },
  '@aws-sdk/client-cloudformation': { CloudFormationClient: class {}, DescribeStacksCommand: class {} },
};
Module._resolveFilename = function (request, parent, ...rest) {
  if (stubs[request] !== undefined) return request;
  return originalResolve.call(this, request, parent, ...rest);
};
for (const [name, exp] of Object.entries(stubs)) {
  require.cache[name] = { id: name, filename: name, loaded: true, exports: exp };
}

// Stub process.exit (no-op) and set argv[2] to "backup" so the IIFE gets a valid config,
// enters the try block, hits the AdmZip stub error, falls into catch, calls process.exit
// (no-op), and the async IIFE resolves cleanly — no unhandled rejection.
const originalExit = process.exit;
const originalArgv = process.argv;
process.exit = () => {};
process.argv = ['node', 'build-lambda.js', 'backup'];

// Silence the console output from the IIFE ("Writing zip..." and "ERROR: ...")
const originalLog = console.log;
console.log = () => {};

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { getConfig } = require('../../deploy/build-lambda.js');

// Restore all globals after module load
process.exit = originalExit;
process.argv = originalArgv;
console.log = originalLog;

const expectedConfigs = {
  backup: { lambdaPath: '../backup-lambda/', outputKey: 'BackupFunctionName', zipFileName: 'backup-lambda.zip' },
  filter: { lambdaPath: '../filter-lambda/', outputKey: 'FilterFunctionName', zipFileName: 'filter-lambda.zip' },
  notifier: { lambdaPath: '../notifier-lambda/', outputKey: 'NotifierFunctionName', zipFileName: 'notifier-lambda.zip' },
};

describe('Property 7: Build script config selection maps arguments to correct Lambda configuration', () => {
  it('should return correct config for valid Lambda identifiers', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('backup', 'filter', 'notifier'),
        (target) => {
          const config = getConfig(target);
          const expected = expectedConfigs[target];

          assert.notEqual(config, null, `getConfig("${target}") should not return null`);
          assert.equal(config.lambdaPath, expected.lambdaPath,
            `lambdaPath for "${target}" should be "${expected.lambdaPath}"`);
          assert.equal(config.outputKey, expected.outputKey,
            `outputKey for "${target}" should be "${expected.outputKey}"`);
          assert.equal(config.zipFileName, expected.zipFileName,
            `zipFileName for "${target}" should be "${expected.zipFileName}"`);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return null for invalid identifiers, INCLUDING prototype-chain names', () => {
    fc.assert(
      fc.property(
        // Deliberately NOT excluding prototype keys: getConfig now does an
        // own-property lookup, so "constructor"/"toString"/etc. must resolve
        // to null. Excluding them (the previous behaviour) hid the
        // prototype-inheritance bug this generator should catch.
        fc.string().filter((s) => s !== 'backup' && s !== 'filter'),
        (target) => {
          const config = getConfig(target);
          assert.equal(config, null,
            `getConfig("${target}") should return null for invalid identifier`);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('explicitly rejects every Object.prototype name', () => {
    for (const poison of Object.getOwnPropertyNames(Object.prototype)) {
      assert.equal(getConfig(poison), null, `getConfig("${poison}") must be null`);
    }
  });
});
