# Offline Block F — O20–O22

Offline Block F is the final offline verification and production-operations layer. It does not add a new ledger authority: the server remains authoritative, IndexedDB remains the durable local working copy/outbox, and every convergence test must end with the same ledger revision and records on server and device.

## O20 — Full offline test matrix

The release gate covers the complete offline lifecycle rather than isolated happy paths:

| Area | Required coverage |
| --- | --- |
| Cold launch | cached shell + authorized cached ledger, airplane-mode reload |
| Reads | dashboard, people, accounts, activity, reports |
| Writes | create/update/delete for supported core entities, durable reload |
| Sync | reconnect, foreground resume, worker/background path |
| Retry | dropped/replayed request, idempotent operation ID |
| Conflicts | remote edit, remote delete, keep-mine and keep-server rules |
| Tombstones | deleted IDs never resurrect accidentally |
| Transfers | atomic ledger transfer behavior and recorded FX |
| Attachments | offline create/delete, retry, missing-parent handling |
| Auth | expired offline lease, 401 preservation, account isolation |
| Storage | persistence fallback, recovery export, destructive discard guard |
| Updates | dirty-outbox update block, schema compatibility fail-closed |
| Migrations | v1→v4 additive path and v3→v4 durable-data preservation |
| Exports | offline PDF/XLSX with unsynced local-first data |
| Multi-device | isolated device stores converge after conflicts/retries |

Blocks A–E keep their dedicated browser gates. Block F adds cross-block multi-device and failure-mode scenarios and makes A–F a single release requirement.

## O21 — Sync integrity and convergence

The invariant is stronger than “sync returned 200”:

- operation IDs are idempotent: replaying the identical operation never duplicates money data;
- reusing an operation ID with different data is rejected;
- every accepted core operation advances the server ledger exactly once;
- a stale base revision becomes an explicit conflict rather than silently overwriting another device;
- conflict resolution rebases the remaining local queue on a fresh server snapshot;
- missing incremental history triggers a full authoritative refresh;
- after successful sync, local pending/failed/conflict counts are zero;
- local and server ledger revisions match;
- canonical people/accounts/entries/settings data converge;
- balances remain derived from the converged ledger, never from an independently synced balance field;
- retries, reloads and background/foreground hand-offs cannot create duplicate transactions.

## O22 — Production offline/sync monitoring

Production exposes privacy-safe aggregate sync telemetry in `/api/health` under `offlineSyncMonitor`.

Persisted counters:

- `pushAccepted`
- `pushReplayed`
- `pushConflict`
- `pushRejected`
- `attachmentAccepted`
- `attachmentReplayed`
- `attachmentConflict`
- `attachmentRejected`
- `pulls`
- `pullFullRefresh`

Each metric stores only a count and last timestamp. Monitoring never stores or emits user IDs, operation IDs, entity IDs, amounts, descriptions, filenames, attachment bytes, emails, or ledger payloads.

Production health also advertises `offlineBlockFVersion: 1`. Existing deployment smoke verifies health/build/service-worker/database/auth/read safety; Block F adds the sync-monitor contract so regressions are visible in the same operations surface.

## Definition of done

Block F is complete when:

- Offline A–E contract and browser gates remain green;
- Block F contract gate validates the matrix, convergence invariants and privacy boundary;
- isolated browser contexts reproduce a real remote-edit conflict and converge after resolution;
- identical operation replay is accepted once and reported as already processed thereafter;
- stale operation conflict is rejected without corrupting state;
- a deliberately missing incremental revision produces `requiresFullRefresh: true`;
- health monitoring records accepted, replay, conflict, pull and full-refresh events without financial/user payloads;
- post-convergence local and server revisions/data match with an empty outbox;
- accounting reconciliation, release gates and Wave 14 visual audit stay green;
- post-merge CI and Production Smoke pass on the exact final `main` SHA.
