// Unit tests for deploy/build-lambda.js
// Validates: Requirements 14.4, 16.2

// Stub out heavy dependencies before requiring deploy/build-lambda.js
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const stubs = {
  'dotenv': { config: () => {} },
  'archiver': { ZipArchive: class { on() { return this; } pipe() { return this; } file() { return this; } directory() { return this; } finalize() { return Promise.resolve(); } } },
  '@aws-sdk/credential-providers': { fromIni: () => ({}) },
  '@aws-sdk/client-lambda': {
    LambdaClient: class {}, UpdateFunctionCodeCommand: class {}, TagResourceCommand: class {},
    ListVersionsByFunctionCommand: class {}, DeleteFunctionCommand: class {},
  },
  '@aws-sdk/client-cloudformation': { CloudFormationClient: class {}, DescribeStacksCommand: class {} },
};
Module._resolveFilename = function (request, parent, ...rest) {
  if (stubs[request] !== undefined) return request;
  return originalResolve.call(this, request, parent, ...rest);
};
for (const [name, exp] of Object.entries(stubs)) {
  require.cache[name] = { id: name, filename: name, loaded: true, exports: exp };
}

const { getConfig, isDeploymentSuccessful, requireEnv, PACKAGE_ALLOWLIST, CREDENTIAL_PATTERNS } = require('../../deploy/build-lambda.js');

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

    it('returns a complete config for backup, filter and notifier', () => {
      for (const target of ['backup', 'filter', 'notifier']) {
        const cfg = getConfig(target);
        assert.ok(cfg, `${target} must resolve to a config`);
        assert.ok(cfg.lambdaPath && cfg.lambdaPath.includes(`${target}-lambda`), `${target} lambdaPath`);
        assert.ok(cfg.outputKey && /FunctionName$/.test(cfg.outputKey), `${target} reads a stack output`);
        assert.ok(cfg.zipFileName && cfg.zipFileName.endsWith('.zip'), `${target} zip file`);
      }
    });

    it('does not resolve a target via prototype-chain keys', () => {
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
      for (const code of [201, 400, 403, 500]) {
        assert.equal(isDeploymentSuccessful({ '$metadata': { httpStatusCode: code } }), false);
      }
    });
  });

  describe('Req 29/31: allow-list packaging and credential refusal', () => {
    it('the package allow-list excludes stray files and includes code + node_modules', () => {
      assert.ok(PACKAGE_ALLOWLIST.has('index.js'));
      assert.ok(PACKAGE_ALLOWLIST.has('node_modules'));
      assert.ok(!PACKAGE_ALLOWLIST.has('.env'), '.env must never be in the allow-list');
      assert.ok(!PACKAGE_ALLOWLIST.has('.git'), '.git must never be in the allow-list');
    });

    it('the credential patterns match .env, .pem, id_rsa and credentials files', () => {
      const matches = (name) => CREDENTIAL_PATTERNS.some((re) => re.test(name));
      for (const bad of ['.env', '.env.production', 'aws-credentials.json', 'server.pem', 'id_rsa', 'private.key']) {
        assert.ok(matches(bad), `${bad} must be recognised as credential-shaped`);
      }
      for (const ok of ['index.js', 'package.json', 'coverage-check.js']) {
        assert.ok(!matches(ok), `${ok} must not be flagged`);
      }
    });

    it('requireEnv throws a named message when a variable is absent', () => {
      delete process.env.__TEST_ABSENT__;
      assert.throws(() => requireEnv('__TEST_ABSENT__'), /__TEST_ABSENT__/);
    });

    it('does NOT false-positive on vendored SDK files named ...Credentials... in node_modules', () => {
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const { collectAllowedFiles } = require('../../deploy/build-lambda.js');
      const root = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'pkg-'));
      try {
        // A legitimate vendored file whose name matches /credentials/i, plus a
        // stray .pem in the function's OWN source under an allow-listed path.
        const vendored = path.join(root, 'node_modules/@aws-sdk/client-sso/dist-es/commands');
        fs.mkdirSync(vendored, { recursive: true });
        fs.writeFileSync(path.join(vendored, 'GetRoleCredentialsCommand.js'), '// sdk');
        fs.writeFileSync(path.join(root, 'index.js'), '// handler');
        const files = collectAllowedFiles(root).map((f) => f.rel);
        assert.ok(files.some((r) => r.includes('GetRoleCredentialsCommand.js')),
          'vendored credentials-named SDK file must be packaged, not refused');
        assert.ok(files.some((r) => r === 'index.js'), 'the handler must be packaged');

        // A credential-shaped file inside node_modules is tolerated (vendored);
        // the same name OUTSIDE node_modules would be refused.
        fs.writeFileSync(path.join(root, 'node_modules', 'server.pem'), 'x');
        assert.doesNotThrow(() => collectAllowedFiles(root),
          'a .pem inside node_modules must not trip the guard');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
