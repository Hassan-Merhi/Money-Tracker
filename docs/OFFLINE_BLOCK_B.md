# Offline Block B — Local writes, sync protocol and idempotency

Offline Block B completes O4–O6. The server remains the source of truth, while the browser can safely accept core ledger changes without a connection and synchronize them later.

## O4 — Local-first writes

Core ledger writes now save to IndexedDB before any network request:

- settings updates
- people create/update/delete
- accounts create/update/delete
- non-transfer ledger entries create/update/delete

Each local write updates the cached ledger immediately and appends a durable record to `syncQueue` with:

- `operationId`
- `identity`
- `entity`
- `entityId`
- `operation`
- `payload`
- `baseRevision`
- `createdAt`
- `attempts`
- `status`
- `lastError`

The optimistic local ledger revision advances with every queued mutation, so multiple offline changes preserve their order.

Queued changes survive refreshes and cold offline launches. The UI shows queued, failed and conflict counts and offers manual sync when connected.

## O5 — Revision push/pull sync

The server exposes:

- `POST /api/sync/push` — validates and applies one ordered queued operation
- `GET /api/sync/pull?sinceRevision=N` — returns server changes since a known revision

A push is accepted only when its `baseRevision` equals the current server ledger revision. The mutation and revision increment run inside one SQLite `BEGIN IMMEDIATE` transaction.

Successful sync mutations are recorded in `sync_changes`. Pull uses the ledger revision as the cursor. If the server revision history contains a change made through a legacy/server-only path that is not represented in `sync_changes`, pull returns `requiresFullRefresh: true` instead of pretending the incremental log is complete. The client then reloads the authoritative server state.

The queue stops on the first failed or conflicting operation so later dependent writes cannot be applied out of order.

## O6 — Idempotency

Every queued operation gets an immutable `operationId`. The server stores processed operations in `sync_operations` together with a SHA-256 request hash and the original result.

If the response is lost after the server commits, retrying the same operation:

1. finds the processed operation,
2. verifies the payload/hash is identical,
3. returns the recorded result,
4. does not run the money mutation again,
5. does not increment the ledger revision again.

Reusing an operation ID for different data returns HTTP 409.

## Identity and data-loss protections

Unsynced changes are never silently removed:

- signing out is blocked while queued changes exist;
- deleting the signed-in account is blocked until queued changes are synced or explicitly discarded;
- switching to another account on the same browser is blocked when the current identity has pending, failed or conflicting changes;
- an authenticated 401 preserves queued local data instead of clearing it;
- destructive cache clearing requires an explicit force path after the queue is empty or the user explicitly chose to discard it.

A successful login for another server account is rolled back if the local account switch would strand unsynced data.

## Scope boundary

Block B deliberately does **not** make every feature offline-capable.

- Account transfers remain online-only until O9, where atomic offline transfer semantics are implemented.
- Attachments remain online-only until O10.
- Bank Feed and Scheduled & Reminders remain server-only while offline.
- Block B records conflicts and validation failures safely, but automated conflict resolution belongs to O7.
- Tombstone-based delete convergence belongs to O8.

This boundary is intentional: a temporarily unavailable feature is safer than a half-posted transfer or a duplicated financial transaction.

## Definition of done

Block B is complete when:

- local core writes work with the network disabled;
- queued changes survive a full page reload;
- reconnecting pushes the queue in order;
- a lost push response and retry cannot duplicate a transaction;
- server validation failures remain visible and queued;
- stale server revisions become explicit conflicts rather than silent overwrites;
- logout/user switching cannot discard unsynced work;
- pull can incrementally converge or safely request a full refresh;
- existing Block A offline-read guarantees remain intact;
- CI includes contract, server and browser tests for O4–O6.


## Post-merge hardening

The final Block B gate also covers follow-up recovery cases found in review:

- HTTP 401 during sync leaves the operation `pending`, preserves local data, and resumes after sign-in;
- connected writes fall back to the existing atomic HTTP endpoints when IndexedDB cannot be opened or read;
- existing account transfers cannot be updated, reclassified, or deleted through the offline queue before O9;
- synced transaction edits/deletes propagate the count of reopened Bank Feed rows so the UI keeps the reconciliation warning;
- these client changes ship with PWA cache version 25.
