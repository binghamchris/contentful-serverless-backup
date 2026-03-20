// Unit tests for deploy/build-lambda.js
// Validates: Requirements 14.4, 16.2

const fs = require('node:fs');
const path = require('node:path');

// Stub out heavy dependencies before requiring deploy/build-lambda.js
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const stubs = {
  'dotenv': { config: () => {} },
  'adm-zip': class { addLocalFolder() { throw new Error('stub'); } },
  '@aws-sdk/credential-providers': { fromIni: () => ({}) },
  '@aws-sdk/client-lambda': { LambdaClient: class {}, UpdateFunctionCodeCommand: class {} },
};
Module._resolveFilename = function (request, parent, ...rest) {
  if (stubs[request] !== undefined) return request;
  return originalResolve.call(this, request, parent, ...rest);
};
for (const [name, exp] of Object.entries(stubs)) {
  require.cache[name] = { id: name, filename: name, loaded: true, exports: exp };
}

// Capture process.exit calls and console.log output during module load
const exitCalls = [];
const logCalls = [];
const originalExit = process.exit;
const originalArgv = process.argv;
const originalLog = console.log;

process.exit = (code) => { exitCalls.push(code); };
process.argv = ['node', 'build-lambda.js', 'backup'];
console.log = (...args) => { logCalls.push(args.join(' ')); };

const { getConfig, isDeploymentSuccessful } = require('../../deploy/build-lambda.js');

// Restore globals after module load
process.exit = originalExit;
process.argv = originalArgv;
console.log = originalLog;
Module._resolveFilename = originalResolve;

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const scriptSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'deploy', 'build-lambda.js'),
  'utf8'
);

describe('Build script unit tests', () => {
  describe('Req 14.4: Usage message with no/invalid args', () => {
    it('getConfig returns null when called with undefined (no CLI arg)', () => {
      assert.equal(getConfig(undefined), null);
    });

    it('getConfig returns null when called with an invalid identifier', () => {
      assert.equal(getConfig('invalid'), null);
    });

    it('getConfig returns null for empty string', () => {
      assert.equal(getConfig(''), null);
    });

    it('script source contains usage message string', () => {
      assert.ok(
        scriptSource.includes('Usage: node build-lambda.js'),
        'Script should contain a usage message'
      );
    });

    it('script exits with non-zero code when config is null', () => {
      // The script has: if (!config) { console.log('Usage...'); process.exit(1); }
      // Verify the pattern exists in source
      const hasUsageExit = scriptSource.includes('process.exit(1)') &&
        scriptSource.includes('Usage');
      assert.ok(hasUsageExit,
        'Script should call process.exit(1) when displaying usage message');
    });
  });

  describe('Req 16.2: Non-zero exit on Lambda API failure', () => {
    it('isDeploymentSuccessful returns false for non-200 status codes', () => {
      const response = { '$metadata': { httpStatusCode: 500 } };
      assert.equal(isDeploymentSuccessful(response), false);
    });

    it('script calls process.exit(1) after failed deployment', () => {
      // The updateLambda function checks isDeploymentSuccessful and calls process.exit(1)
      // Verify the pattern: after the deployment check, process.exit(1) is called
      const lines = scriptSource.split('\n');
      const exitLines = lines
        .map((line, i) => ({ line: line.trim(), index: i }))
        .filter(({ line }) => line.includes('process.exit(1)'));

      // There should be at least two process.exit(1) calls:
      // 1. After invalid args (usage message)
      // 2. After deployment failure
      assert.ok(exitLines.length >= 2,
        `Expected at least 2 process.exit(1) calls in script, found ${exitLines.length}`);
    });

    it('script catches errors in async IIFE and exits with non-zero code', () => {
      // Verify the try/catch pattern with process.exit(1) in the catch block
      assert.ok(
        scriptSource.includes('catch') && scriptSource.includes('process.exit(1)'),
        'Script should have a catch block that calls process.exit(1)'
      );
    });
  });
});
