'use strict';

// The Coverage_Check as a PURE function, plus the archive-key pattern and the
// suppression-state helpers. No I/O — the Filter handler does the listing,
// fetching and SSM reads/writes and passes the results in, so this module is
// exhaustively unit-testable.
//
// Design contract (design.md, Coverage_Check section):
//   decide({ contentTs, archiveOutcome, now, grace, skew, statusCaptured,
//            branchMatches, storeState }) -> { enqueue, coverage }
//   - Three archive outcomes: found(at) | none | indeterminate.
//   - Number.isFinite guards on every timestamp.
//   - Skew applied identically to enqueue and coverage so they never disagree.
//   - Enqueue table and coverage-email conditions per the design.
//
// Requirements: 30.x, 31.x, 32.x, 33.x, 34.x, 9.16.

// Anchored archive-key pattern. Anchored at BOTH ends against the whole key:
// a final key is YYYY/MM/DD/...<ms>Z.zip. The leading ^\d{4} anchor excludes
// any "staging/..." key, and the .<ms>Z.zip tail excludes ".partial.zip".
// MUST NOT be relaxed; a unit test asserts both exclusions.
const ARCHIVE_KEY = /^\d{4}\/\d{2}\/\d{2}\/[^/]*\.\d{3}Z\.zip$/;

// Parse an ISO timestamp to epoch ms, or null if unusable. Must NEVER throw —
// a pathological value (e.g. an object whose toString is not callable) makes
// `new Date(value)` throw "Cannot convert object to primitive value", so the
// conversion is guarded.
function toEpoch(value) {
  if (value === null || value === undefined) return null;
  try {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

// Parse the suppression store's 4-field JSON. An initial/unparseable value is
// "no suppression" — never a throw.
function parseStoreState(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// A content "state" identity — the content timestamp, as a string, is the key
// the store records enqueues and notifications against.
function contentStateKey(contentTs) {
  const e = toEpoch(contentTs);
  return e === null ? null : String(e);
}

/**
 * Decide the enqueue and coverage-email outcomes.
 *
 * @param {object} p
 * @param {*} p.contentTs        Max content timestamp across both endpoints, or null if unusable.
 * @param {object} p.archiveOutcome  { kind: 'found'|'none'|'indeterminate', at?: <ts> }
 * @param {number} p.now         Epoch ms "now".
 * @param {number} p.graceMs     Grace period in ms.
 * @param {number} p.skewMs      Clock-skew tolerance in ms (applied both sides).
 * @param {number} p.reNotifyMs  Re-notify interval in ms.
 * @param {boolean} p.statusCaptured  Whether the build status regex matched a success.
 * @param {boolean} p.branchMatches   Whether the build branch matches TargetBranch.
 * @param {object} p.storeState  Parsed suppression store.
 * @param {boolean} p.hasVerifiedArchiveWithinGrace  found & recent, for the fail-open case.
 * @returns {{enqueue: boolean, coverage: {notify: boolean, reason: string}}}
 */
function decide(p) {
  const {
    contentTs, archiveOutcome, now, graceMs, skewMs, reNotifyMs,
    statusCaptured, branchMatches, storeState = {},
  } = p;

  const contentEpoch = toEpoch(contentTs);
  const contentUsable = contentEpoch !== null;
  const outcome = (archiveOutcome && archiveOutcome.kind) || 'indeterminate';
  const archiveEpoch = outcome === 'found' ? toEpoch(archiveOutcome.at) : null;

  // ---- enqueue decision -------------------------------------------------
  let enqueue = false;
  if (branchMatches && statusCaptured) {
    if (contentUsable) {
      if (outcome === 'found' && archiveEpoch !== null) {
        // Enqueue only if the newest archive is older than content minus skew.
        enqueue = archiveEpoch < contentEpoch - skewMs;
      } else if (outcome === 'none') {
        enqueue = true; // no archive at all, content is fresh -> back it up
      } else if (outcome === 'indeterminate') {
        enqueue = true; // fail open: cannot tell, so err toward backing up
      }
    } else {
      // Content timestamp unusable -> fail open, UNLESS a verified archive
      // exists within grace (a recent good backup suppresses the fail-open).
      const recentVerified =
        outcome === 'found' && archiveEpoch !== null && archiveEpoch > now - graceMs;
      enqueue = !recentVerified;
    }
  }

  // ---- coverage-email decision -----------------------------------------
  // Runs regardless of branch/status (the coverage question is independent).
  let notify = false;
  let reason = 'no gap';

  if (!contentUsable) {
    reason = 'content timestamp unusable — indeterminate, no email';
  } else if (outcome === 'indeterminate') {
    reason = 'archive listing indeterminate — no email';
  } else {
    const stateKey = String(contentEpoch);
    const archiveCoversContent =
      outcome === 'found' && archiveEpoch !== null && archiveEpoch >= contentEpoch - skewMs;
    const gap = outcome === 'none' || !archiveCoversContent;
    const graceElapsed = now - contentEpoch > graceMs;

    const enqueuedAt = toEpoch(storeState.enqueuedAt);
    const enqueuedForThisState =
      storeState.enqueuedContentChange === stateKey &&
      enqueuedAt !== null && enqueuedAt > now - graceMs;

    const notifiedAt = toEpoch(storeState.notifiedAt);
    const notifiedForThisState =
      storeState.notifiedContentChange === stateKey &&
      notifiedAt !== null && notifiedAt > now - reNotifyMs;

    if (!gap) {
      reason = 'archive covers content';
    } else if (!graceElapsed) {
      reason = 'within grace period';
    } else if (enqueuedForThisState) {
      reason = 'enqueue recorded within grace — pipeline in flight';
    } else if (notifiedForThisState) {
      reason = 'already notified within re-notify interval';
    } else {
      notify = true;
      reason = outcome === 'none' ? 'no archive covers a real content change' : 'newest archive predates content change';
    }
  }

  return { enqueue, coverage: { notify, reason } };
}

module.exports = { ARCHIVE_KEY, toEpoch, parseStoreState, contentStateKey, decide };
