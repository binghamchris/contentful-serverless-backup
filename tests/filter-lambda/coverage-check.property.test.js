'use strict';

// Pure-function tests for the Coverage_Check decision logic. No I/O, no stubs.
// Validates: Requirements 30.x-34.x, 9.16, plus task-7 oracle hardening
// (Number.isFinite guards, invalid dates, empty/absent fields, non-objects).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { decide, toEpoch, parseStoreState, ARCHIVE_KEY } = require('../../filter-lambda/coverage-check');

const MIN = 60 * 1000;
const base = {
  now: 1_000_000_000_000,
  graceMs: 30 * MIN,
  skewMs: 5000,
  reNotifyMs: 6 * 60 * MIN,
  statusCaptured: true,
  branchMatches: true,
  storeState: {},
};
const iso = (epoch) => new Date(epoch).toISOString();

describe('ARCHIVE_KEY: anchored, excludes partial and staging keys', () => {
  it('matches a final key and rejects partial/staging/other', () => {
    assert.match('2026/09/20/2026-09-20_04-52-00.336Z.zip', ARCHIVE_KEY);
    assert.doesNotMatch('2026/09/20/2026-09-20_04-52-00.336Z.partial.zip', ARCHIVE_KEY);
    // A staging key ends with the SAME .336Z.zip tail — it must be excluded by
    // the leading ^\d{4} anchor, not by the tail. (Regression: an end-anchored
    // pattern let this leak in and read as a covering archive.)
    assert.doesNotMatch('staging/2026/09/20/2026-09-20_04-52-00.336Z.zip', ARCHIVE_KEY);
    assert.doesNotMatch('notes.txt', ARCHIVE_KEY);
  });
});

describe('toEpoch: Number.isFinite guard', () => {
  it('returns null for invalid, empty, absent and non-date inputs', () => {
    for (const bad of [undefined, null, '', 'not-a-date', {}, [], NaN, 'Invalid Date']) {
      assert.equal(toEpoch(bad), null, `${JSON.stringify(bad)} must be null`);
    }
  });
  it('returns a finite epoch for a valid ISO string', () => {
    assert.equal(typeof toEpoch('2026-09-20T00:00:00.000Z'), 'number');
  });
});

describe('parseStoreState: initial/unparseable -> no suppression', () => {
  it('returns {} for absent, empty, malformed, and non-object JSON', () => {
    for (const bad of [undefined, null, '', '{bad', '42', '"x"', '[]']) {
      assert.deepEqual(parseStoreState(bad), {});
    }
  });
});

describe('Enqueue table (design.md)', () => {
  const content = base.now - 60 * MIN; // an hour ago, past grace

  it('success + branch + content usable + no archive -> enqueue', () => {
    assert.equal(decide({ ...base, contentTs: iso(content), archiveOutcome: { kind: 'none' } }).enqueue, true);
  });
  it('success + archive older than content -> enqueue', () => {
    const r = decide({ ...base, contentTs: iso(content), archiveOutcome: { kind: 'found', at: iso(content - 10 * MIN) } });
    assert.equal(r.enqueue, true);
  });
  it('success + archive newer than content -> no enqueue', () => {
    const r = decide({ ...base, contentTs: iso(content), archiveOutcome: { kind: 'found', at: iso(content + 10 * MIN) } });
    assert.equal(r.enqueue, false);
  });
  it('indeterminate listing -> enqueue (fail open)', () => {
    assert.equal(decide({ ...base, contentTs: iso(content), archiveOutcome: { kind: 'indeterminate' } }).enqueue, true);
  });
  it('content unusable + no recent verified archive -> enqueue (fail open)', () => {
    assert.equal(decide({ ...base, contentTs: null, archiveOutcome: { kind: 'none' } }).enqueue, true);
  });
  it('content unusable + a verified archive within grace -> suppressed', () => {
    const r = decide({ ...base, contentTs: null, archiveOutcome: { kind: 'found', at: iso(base.now - 5 * MIN) } });
    assert.equal(r.enqueue, false);
  });
  it('wrong branch -> no enqueue (but coverage still evaluated)', () => {
    const r = decide({ ...base, branchMatches: false, contentTs: iso(content), archiveOutcome: { kind: 'none' } });
    assert.equal(r.enqueue, false);
  });
  it('status not captured -> no enqueue', () => {
    const r = decide({ ...base, statusCaptured: false, contentTs: iso(content), archiveOutcome: { kind: 'none' } });
    assert.equal(r.enqueue, false);
  });
});

describe('Boundary conditions (kill off-by-one mutants)', () => {
  const skew = base.skewMs;
  const content = base.now - 60 * MIN; // past grace

  it('archive exactly at (content - skew): NOT enqueued, and covered', () => {
    // enqueue uses archiveEpoch < content - skew; at equality it must be false.
    const r = decide({ ...base, contentTs: iso(content), archiveOutcome: { kind: 'found', at: content - skew } });
    assert.equal(r.enqueue, false, 'archive exactly at the skew boundary is NOT stale -> no enqueue');
    // coverage uses archiveEpoch >= content - skew; at equality it must be covered.
    assert.equal(r.coverage.notify, false, 'archive exactly at the skew boundary counts as covering');
  });

  it('archive one ms BELOW (content - skew): enqueued and a gap', () => {
    const r = decide({ ...base, contentTs: iso(content), archiveOutcome: { kind: 'found', at: content - skew - 1 } });
    assert.equal(r.enqueue, true, 'just past the boundary is stale -> enqueue');
    assert.equal(r.coverage.notify, true, 'just past the boundary is a gap');
  });

  it('content exactly at the grace boundary: NOT yet notified', () => {
    // graceElapsed uses now - content > grace; at exact equality it must be false.
    const atBoundary = base.now - base.graceMs; // now - content === grace
    const r = decide({ ...base, contentTs: iso(atBoundary), archiveOutcome: { kind: 'none' } });
    assert.equal(r.coverage.notify, false, 'at exactly one grace period, do not notify yet');
  });

  it('content one ms past the grace boundary: notified', () => {
    const pastBoundary = base.now - base.graceMs - 1;
    const r = decide({ ...base, contentTs: iso(pastBoundary), archiveOutcome: { kind: 'none' } });
    assert.equal(r.coverage.notify, true, 'one ms past grace -> notify');
  });
});

describe('Coverage-email conditions (design.md)', () => {
  const content = base.now - 60 * MIN; // past grace

  it('none + past grace + no suppression -> notify', () => {
    assert.equal(decide({ ...base, contentTs: iso(content), archiveOutcome: { kind: 'none' } }).coverage.notify, true);
  });
  it('found covering content -> no notify', () => {
    const r = decide({ ...base, contentTs: iso(content), archiveOutcome: { kind: 'found', at: iso(content + MIN) } });
    assert.equal(r.coverage.notify, false);
  });
  it('within grace -> no notify', () => {
    const recent = base.now - 5 * MIN;
    assert.equal(decide({ ...base, contentTs: iso(recent), archiveOutcome: { kind: 'none' } }).coverage.notify, false);
  });
  it('enqueue recorded within grace for this state -> suppressed', () => {
    const stateKey = String(content);
    const store = { enqueuedContentChange: stateKey, enqueuedAt: iso(base.now - 2 * MIN) };
    const r = decide({ ...base, storeState: store, contentTs: iso(content), archiveOutcome: { kind: 'none' } });
    assert.equal(r.coverage.notify, false);
  });
  it('notified within re-notify interval for this state -> suppressed', () => {
    const stateKey = String(content);
    const store = { notifiedContentChange: stateKey, notifiedAt: iso(base.now - 10 * MIN) };
    const r = decide({ ...base, storeState: store, contentTs: iso(content), archiveOutcome: { kind: 'none' } });
    assert.equal(r.coverage.notify, false);
  });
  it('indeterminate listing -> never notify', () => {
    assert.equal(decide({ ...base, contentTs: iso(content), archiveOutcome: { kind: 'indeterminate' } }).coverage.notify, false);
  });
  it('content unusable -> never notify (indeterminate)', () => {
    assert.equal(decide({ ...base, contentTs: null, archiveOutcome: { kind: 'none' } }).coverage.notify, false);
  });
  it('equal timestamps count as covered', () => {
    const r = decide({ ...base, contentTs: iso(content), archiveOutcome: { kind: 'found', at: iso(content) } });
    assert.equal(r.coverage.notify, false);
  });
});

describe('Property: decide never throws and always returns finite-guarded booleans', () => {
  it('for arbitrary content ts, outcomes and store states', () => {
    const dateish = fc.oneof(
      fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
      fc.constant(null), fc.constant(undefined), fc.constant(''),
      fc.constant('not-a-date'), fc.integer(), fc.object()
    );
    fc.assert(
      fc.property(
        dateish,
        fc.constantFrom('found', 'none', 'indeterminate'),
        dateish,
        fc.boolean(), fc.boolean(),
        fc.oneof(fc.object(), fc.constant({}), fc.constant(null)),
        (contentTs, kind, at, statusCaptured, branchMatches, storeState) => {
          const r = decide({
            ...base, contentTs,
            archiveOutcome: kind === 'found' ? { kind, at } : { kind },
            statusCaptured, branchMatches, storeState: storeState || {},
          });
          assert.equal(typeof r.enqueue, 'boolean');
          assert.equal(typeof r.coverage.notify, 'boolean');
        }
      ),
      { numRuns: 500 }
    );
  });
});
