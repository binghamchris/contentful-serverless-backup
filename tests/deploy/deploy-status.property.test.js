// Feature: project-quality-overhaul, Property 8: Build script deployment status check returns success only for HTTP 200
// Validates: Requirements 5.1, 5.2

// Stub out heavy dependencies before requiring deploy/build-lambda.js
// isDeploymentSuccessful is a pure function and doesn't use any of these, but the module
// requires them at top level and has an async IIFE that runs on require.
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const stubs = {
  'dotenv': { config: () => {} },
  'archiver': { ZipArchive: class { on() { return this; } pipe() { return this; } file() { return this; } directory() { return this; } finalize() { return Promise.resolve(); } } },
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
const { isDeploymentSuccessful } = require('../../deploy/build-lambda.js');

// Restore all globals after module load
process.exit = originalExit;
process.argv = originalArgv;
console.log = originalLog;

describe('Property 8: Build script deployment status check returns success only for HTTP 200', () => {
  it('should return true only when httpStatusCode is exactly 200', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 599 }),
        (statusCode) => {
          const response = { '$metadata': { httpStatusCode: statusCode } };
          const result = isDeploymentSuccessful(response);

          if (statusCode === 200) {
            assert.equal(result, true,
              `isDeploymentSuccessful should return true for status 200, got ${result}`);
          } else {
            assert.equal(result, false,
              `isDeploymentSuccessful should return false for status ${statusCode}, got ${result}`);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
