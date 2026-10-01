# Wave 100E — Offline Recovery Restore

Wave 100E turns the existing offline recovery export from an audit-only file into a safe, restorable device working-set archive.

The server remains authoritative. A restore changes only IndexedDB on the current device. Restored queued operations are not marked accepted and must still pass the normal sync, idempotency, revision and conflict rules before they affect server state.

## Recovery archive format

The device recovery archive is:

- `app: money-owed-tracker`;
- `recoveryVersion: 2`;
- `recoveryKind: offline-working-set`;
- tagged with the current offline schema version;
- bound to the current offline account identity;
- protected with a SHA-256 checksum over canonical JSON.

The archive contains the complete device working set needed to resume offline work:

- current ledger snapshot;
- ledger sync queue;
- sync revision/runtime metadata;
- tombstones;
- attachment metadata and locally stored attachment binaries;
- attachment queue;
- FX cache;
- cached Bank Feed snapshot and Bank Feed queue;
- cached recurring/reminder snapshot and recurring queue.

It does **not** contain passwords, CSRF tokens, session cookies, server session secrets, or a transferable offline-authorization lease.

## Export

Settings → App & offline → Offline recovery exposes **Export device recovery**.

Export works from the current device state and does not require a server round trip.

The archive can contain private financial data and attachment contents, so it must be stored privately.

## Inspect / dry run

Before restore, Money Tracker verifies:

1. archive app/version/kind;
2. SHA-256 checksum;
3. offline schema compatibility;
4. same active Money Tracker identity;
5. ledger snapshot structure and duplicate IDs;
6. queue identity and operation IDs;
7. attachment identity, per-file 8 MB limit and total 100 MB cached-binary limit;
8. cached Bank Feed/recurring payload shape.

The confirmation modal shows a dry-run summary: transaction count, queued operations, attachment records, cached Bank Feed rows, cached schedules, and how much current queued work will be replaced.

## Transactional restore

Restore requires typing **RESTORE OFFLINE**.

The restore uses one IndexedDB transaction across the local working-set stores. Either the full local replacement commits or the previous local working set remains intact.

The active-user authorization record and schema metadata are preserved. The archive cannot replace the currently authenticated identity or extend its seven-day offline authorization.

Restored operation IDs, base revisions, statuses, tombstones and cached state are preserved exactly. This is required for idempotent replay and conflict handling after reconnect.

## Server safety

Restoring an archive does not call a server restore endpoint and does not claim success for any queued operation.

After reconnect:

- pending ledger operations use `/api/sync/push`;
- attachment operations use the existing attachment sync endpoint;
- Bank Feed operations use the existing Bank Feed sync endpoint;
- recurring operations use the existing recurring sync endpoint;
- stale revisions still become explicit conflicts;
- already-accepted operation IDs still replay idempotently rather than duplicating money movement.

## Tamper and identity protection

Checksum mismatch is rejected before IndexedDB is modified.

An archive for a different account is rejected even if its checksum is otherwise valid.

Archives created by a newer unsupported offline schema are rejected until the app is updated.

## PWA and production contract

Wave 100E uses:

- PWA shell **v35**;
- IndexedDB **v7** (no new durable store is required);
- `offlineWave100EVersion: 1` in `/api/health`.

The service-worker shell caches `/lib/offline-recovery.js`, so archive verification and restore remain available during offline use.

## Definition of done

Wave 100E is complete when:

- a checksummed device recovery archive can be exported offline;
- archive preview works without mutating state;
- tampered archives are rejected with no local change;
- another account's archive is rejected;
- restore is transactional and requires explicit confirmation;
- ledger snapshot, all four queue classes, tombstones, cached Bank Feed/recurring state, FX metadata and attachment binaries restore correctly;
- current authentication/authorization metadata is not imported from the archive;
- restored operations sync through the existing idempotent/conflict-aware paths;
- Offline A–F and Waves 100A–100D remain green;
- dedicated 100E contract/browser gates are green;
- accounting and visual gates remain green;
- production serves the exact green `main` SHA with `offlineWave100EVersion: 1`, PWA v35 and offline DB v7.
