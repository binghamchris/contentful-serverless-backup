// Unit tests for deploy/build-lambda.js
// Validates: Requirements 14.4, 16.2

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

describe('Build script unit tests', () => {
  describe('Req 14.4: getConfig maps targets and rejects everything else', () => {
    it('returns null for undefined (no CLI arg)', () => {
      assert.equal(getConfig(undefined), null);
    });

    it('returns null for an invalid identifier', () => {
      assert.equal(getConfig('invalid'), null);
    });

    it('returns null for empty string', () => {
      assert.equal(getConfig(''), null);
    });

    it('returns a complete config for "backup" and "filter"', () => {
      for (const target of ['backup', 'filter']) {
        const cfg = getConfig(target);
        assert.ok(cfg, `${target} must resolve to a config`);
        assert.ok(cfg.lambdaPath && cfg.lambdaPath.includes(`${target}-lambda`), `${target} lambdaPath`);
        assert.ok(cfg.envVar, `${target} must name an env var`);
        assert.ok(cfg.zipFileName && cfg.zipFileName.endsWith('.zip'), `${target} zip file`);
      }
    });

    it('does not resolve a target via prototype-chain keys', () => {
      // A tautology-guard: getConfig must be an own-property lookup, so
      // inherited names like "constructor"/"toString" resolve to null.
      for (const poison of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
        assert.equal(getConfig(poison), null, `${poison} must not resolve to a config`);
      }
    });
  });

  describe('Req 16.2: isDeploymentSuccessful reflects the API status', () => {
    it('returns false for a non-200 status code', () => {
      assert.equal(isDeploymentSuccessful({ '$metadata': { httpStatusCode: 500 } }), false);
    });

    it('returns true only for a 200 status code', () => {
      assert.equal(isDeploymentSuccessful({ '$metadata': { httpStatusCode: 200 } }), true);
      for (const code of [201, 202, 400, 403, 404, 500, 503]) {
        assert.equal(
          isDeploymentSuccessful({ '$metadata': { httpStatusCode: code } }),
          false,
          `status ${code} must not read as successful`
        );
      }
    });
  });
});
