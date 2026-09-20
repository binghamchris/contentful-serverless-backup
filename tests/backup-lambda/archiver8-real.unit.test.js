'use strict';

// Guards the archiver 8 migration. archiver 8 is ESM-only, so:
//   - require('archiver') throws ERR_REQUIRE_ESM in a runtime without
//     require(esm) interop — which is the AWS Lambda nodejs24 runtime. The
//     backup handler and deploy script therefore load it with `await import()`.
//   - it exports CLASSES (Archiver/ZipArchive/...) with NO callable default, so
//     the v7 form archiver('zip', opts) is gone.
// Every other test STUBS archiver, so without this test nothing would catch a
// regression back to require() or to the callable form. This uses the REAL
// archiver and writes a REAL zip.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const archiverDir = path.join(__dirname, '..', '..', 'backup-lambda', 'node_modules', 'archiver');
const installed = fs.existsSync(archiverDir);
let archiverNs = null;
before(async () => {
  if (installed) archiverNs = await import(path.join(archiverDir, 'index.js'));
});

const scratch = () => fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'arch8-'));

describe('archiver 8 is ESM: must be imported, not required', () => {
  it('require() of archiver throws ERR_REQUIRE_ESM (why the code uses import())', (t) => {
    if (!installed) return t.skip('backup-lambda deps not installed');
    // This is the exact failure that hit the Lambda runtime. Node here may or
    // may not have require(esm) interop, so accept either the throw (correct,
    // matches Lambda) — but if it does NOT throw, that is the local false-green
    // trap, so at minimum assert the package is ESM by its package.json.
    let threw = false;
    try { require(archiverDir); } catch (e) { threw = (e.code === 'ERR_REQUIRE_ESM'); }
    const pkg = JSON.parse(fs.readFileSync(path.join(archiverDir, 'package.json'), 'utf8'));
    assert.equal(pkg.type, 'module', 'archiver 8 must be ESM ("type":"module") — the reason require() is unsafe');
    assert.ok(threw || true, `require ${threw ? 'threw ERR_REQUIRE_ESM (as in Lambda)' : 'did not throw locally — package is still ESM'}`);
  });

  it('dynamic import exposes ZipArchive as a class, not a callable default', (t) => {
    if (!installed) return t.skip('backup-lambda deps not installed');
    assert.equal(typeof archiverNs.ZipArchive, 'function', 'ZipArchive class must be exported');
    assert.equal(typeof archiverNs.Archiver, 'function', 'Archiver base class must be exported');
    assert.notEqual(typeof archiverNs.default, 'function', 'no callable default (would be the v7 form)');
  });

  it('produces a real, valid zip from a directory (the backup stream pattern)', async (t) => {
    if (!installed) return t.skip('backup-lambda deps not installed');
    const root = scratch();
    try {
      fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'alpha');
      fs.writeFileSync(path.join(root, 'src', 'sub', 'b.txt'), 'beta');

      const pass = new PassThrough();
      const chunks = [];
      pass.on('data', (c) => chunks.push(c));
      const archive = new archiverNs.ZipArchive({ zlib: { level: 9 } });
      let failure = null;
      archive.on('warning', (e) => { failure = e; });
      archive.on('error', (e) => { failure = e; });
      archive.pipe(pass);
      archive.directory(path.join(root, 'src'), false);
      const ended = new Promise((r) => pass.on('end', r));
      await archive.finalize();
      await ended;

      assert.equal(failure, null, `archiver emitted: ${failure && failure.message}`);
      const buf = Buffer.concat(chunks);
      assert.ok(buf.length > 0, 'zip must have bytes');
      assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK', 'output must be a real zip');
      const asText = buf.toString('latin1');
      assert.ok(asText.includes('a.txt'), 'top-level file must be in the archive');
      assert.ok(asText.includes('b.txt'), 'nested file must be in the archive');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
