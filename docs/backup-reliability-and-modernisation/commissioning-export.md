# Commissioning Export — measured envelope (task 14)

Run against the **production** `cloudypandas-backup-prod` stack, Contentful space
`v0b8l2m66vx4` / `master` (the largest space, most assets), on 2026-09-20.
Profile `cloudypandas-prod` (owner-authorised override of the `-dev` rule for
tasks 14/15 only). Two runs: the first failed at the staging upload (a bucket-policy
bug, since fixed — see below); the second succeeded end-to-end.

## Measured envelope (successful run, requestId 55a096f6…)

| Metric | Value | Ceiling | % of ceiling |
|---|---|---|---|
| **Max memory used** | **378 MB** | 10240 MB | **3.7%** |
| Configured memory | 1536 MB | — | — |
| **Duration** | **13.83 s** (billed 14.96 s) | 900 s | **1.5%** |
| Init (cold start) | 1.12 s | — | — |
| Archive size | **87.6 MB** (`stagedBytes` 87,626,192) | — | — |
| `maxAllowedLimit` used | 200 (no adaptive halving needed) | 1000 | — |

Exported entities: **300 entries, 97 assets** (all downloaded, 0 errors, 0
warnings that mattered), 11 content types, 11 editor interfaces, 2 locales, 3
webhooks, 1 role, **0 tags**, 0 releases.

## Trend / ceiling analysis (the 70% obligation)

Both memory (3.7%) and duration (1.5%) are **far** below the ~70% flag threshold
against Lambda's 10240 MB / 900 s ceilings. The design's fear — that ~950 MB peak
was close to the memory ceiling — did **not** materialise on this space: actual
peak was **378 MB**, roughly a quarter of the 1536 MB interim and nowhere near
the 950 MB figure that drove the interim sizing. This is a strong, reassuring
result: the space is nowhere near outgrowing Lambda, and there is enormous
headroom on both axes.

**Implication for task 15 (finalise sizing):** the interim 1536 MB is far more
than needed. A sensible final is **512 MB** (comfortably above the 378 MB peak
with headroom for growth) — but note memory also buys CPU, and the 13.8 s
duration is partly CPU-bound (archiving 87 MB). Recommend setting final memory to
**768 MB** (2× peak, keeps archiving fast) and **ephemeral 1024 MB** (the export
tree + 87 MB archive fit easily; measured `/tmp` use was well under 2048). Grace
period: the run completes in ~15 s, so a grace of a few minutes is ample.

## The ~950 MB discrepancy — worth noting

The interim sizing assumed a ~950 MB peak (owner-reported). The measured peak on
the actual largest space is 378 MB. Possible explanations: the 950 MB figure was
from the *old* buffered-everything code (adm-zip materialised the whole zip in
memory, then read it back into a Buffer), which the new streamed path eliminates
— exactly the memory the streaming redesign was meant to remove. If so, the
streaming change alone cut peak memory ~2.5×, which the new measurement now
confirms empirically.

## Bug found and fixed during commissioning

`BackupBucketPolicy`'s `DenyUnencryptedPutObject` denied the function's own
streamed upload (the request omits the SSE header; bucket default encryption
already covers it). Fixed in commit 6d39e0c — statement removed, DenyNonTLS
kept. The failed first run cost one export's worth of Contentful quota.

## Operational notes for the deploy runbook

- The stack-managed log groups are `INFREQUENT_ACCESS` class: `get-log-events`
  and `filter-log-events` are **rejected** on them. Read logs via CloudWatch Logs
  Insights (`start-query`/`get-query-results`) — which is exactly why the Notifier
  builds an Insights query and avoids IA-unsupported commands.
- A failed stack update **orphans** the `Retain`-policy log groups; their names
  then collide on the next deploy (`ResourceExistenceCheck` early-validation
  failure). Delete the orphaned groups before retrying.

## Finalised sizing (task 15) and retest

Applied the measured finals and redeployed the locale-fixed code (commit
`2c2dc8d`, function version 2), then retested with one export:

| Metric | Interim | Final | Retest actual |
|---|---|---|---|
| MemorySize | 1536 MB | **768 MB** | peak 338 MB (44% util) |
| EphemeralStorage | 2048 MB | **1024 MB** | fits easily |
| Duration | 13.8 s @ 1536 MB | — | **26.2 s @ 768 MB** |

The retest succeeded end-to-end (archive promoted to
`2026/09/20/2026-09-20_05-53-10.359Z.zip`, 0 errors) and the locale-fixed
reconciliation ran for real against the 97 en-GB assets (no shortfall).

Note the duration doubled (13.8 s → 26.2 s) at half the memory: Lambda scales
CPU with memory, so archiving the ~88 MB is CPU-bound and slower at 768 MB.
This is the intended cost/speed trade — 26 s is still 2.9% of the 900 s ceiling.
If backup latency ever matters, raising memory buys proportional speed; for an
infrequent backup it does not, so 768 MB is the right economy.

**Tags:** the space has 0 tags, so the published-state switch loses nothing —
decision settled, no design amendment needed.

