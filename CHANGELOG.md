# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — backup reliability & modernisation

Branch: `feat/project-quality-overhaul`. Tasks 1–13 and 16–19 of the
`backup-reliability-and-modernisation` spec; the live commissioning deploy
(task 14) and sizing finalisation (task 15) remain.

### Fixed
- Backup failures were silently discarded (handler returned a 500 object the
  event-source mapping read as success). Failures now throw.
- The dead-letter queue was unreachable (source retention < visibility timeout).
  Timing chain corrected; a terminal queue added behind the DLQ.
- The Filter silently produced "no backup needed" on an unusable last-update
  response (truthiness test + `NaN` date). Now fails open with finite guards.
- Unanchored build-status matching; `getConfig` prototype-chain resolution.
- `MemorySize` was below the workload's ~950 MB peak (OOM on large runs).

### Added
- Grace-bounded stateful coverage check (SSM suppression store) that reports a
  broken pipeline instead of masking it forever.
- Terminal Notifier Lambda handling both DLQ and async-OnFailure envelopes.
- Staging-upload → verify → promote pipeline with size-based asset
  reconciliation.
- Stack-managed log groups, alert SNS topic, gated event-source mappings,
  OFF-by-default replication and Object Lock.
- CI workflow (Node 24), Dependabot across all four manifests, executable deploy
  docs, contract fixtures, and a no-cost-observability invariant test.

### Changed
- Runtime `nodejs20.x` → `nodejs24.x`; `adm-zip` → `archiver`; buffered upload →
  streamed `@aws-sdk/lib-storage`; SDK v3 clients pinned.
- Deploy script made reproducible and gated (allow-list packaging, dirty-tree
  refusal, commit tag, version pruning, names from stack outputs).
- All fixed physical names removed; full stack outputs published.
