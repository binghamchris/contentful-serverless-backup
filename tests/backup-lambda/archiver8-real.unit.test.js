'use strict';

// Guards the archiver 8 migration. archiver 8 is ESM-only and exports CLASSES
// (Archiver/ZipArchive/...) with NO callable default, so the v7 form
// `archiver('zip', opts)` throws "archiver is not a function". Every other test
// STUBS archiver, so without this test nothing would catch a regression in the
// real import shape or in the class-based usage.
//
// This test uses the REAL archiver and writes a REAL zip.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

// Resolve the real archiver the backup Lambda bundles.
const archiverPath = path.join(__dirname, '..', '..', 'backup-lambda', 'node_modules', 'archiver');
let archiverNs = null;
try { archiverNs = require(archiverPath); } catch { /* deps not installed */ }

const scratch = () => fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'arch8-'));

describe('archiver 8 import shape (guards the ESM/class migration)', () => {
  it('exports ZipArchive as a constructor and NOT a callable default', (t) => {
    if (!archiverNs) return t.skip('backup-lambda deps not installed');
    assert.equal(typeof archiverNs, 'object', 'archiver 8 namespace is an object, not a function');
    assert.equal(typeof archiverNs.ZipArchive, 'function', 'ZipArchive class must be exported');
    assert.equal(typeof archiverNs.Archiver, 'function', 'Archiver base class must be exported');
    // The v7 form must NOT work — this is what broke and what we migrated away from.
    assert.notEqual(typeof archiverNs, 'function', 'a callable default would mean we are back on v7');
  });

  it('produces a real, valid zip from a directory (the backup stream pattern)', async (t) => {
    if (!archiverNs) return t.skip('backup-lambda deps not installed');
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
      // A real zip starts with the local file header magic "PK\u0003\u0004".
      assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK', 'output must be a real zip');
      // Entry names appear in the central directory, so both files must be present.
      const asText = buf.toString('latin1');
      assert.ok(asText.includes('a.txt'), 'top-level file must be in the archive');
      assert.ok(asText.includes('b.txt'), 'nested file must be in the archive');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
