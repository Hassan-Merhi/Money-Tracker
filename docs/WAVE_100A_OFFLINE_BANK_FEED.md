# Wave 100A — Offline Bank Feed

Wave 100A removes the Bank Feed's read-only offline boundary without creating a second accounting authority. The server remains authoritative for synchronized ledger state; the browser stores a bounded Bank Feed working copy and a durable Bank Feed outbox.

## Cached Bank Feed reads

After Bank Feed has been opened successfully while connected, the browser stores the latest **500** feed rows together with rules, import history, status totals and account statistics in IndexedDB.

While offline, the Bank Feed can:

- open from the saved device cache;
- filter and page through cached rows;
- show pending, posted and ignored rows;
- keep cached rule suggestions available;
- survive reloads and cold PWA launches.

The UI clearly labels cached Bank Feed data and reports queued, failed and conflicted Bank Feed operations.

## Durable Bank Feed outbox

IndexedDB schema **v5** adds:

- `bankFeedState` — the cached recent Bank Feed working copy;
- `bankFeedQueue` — durable Bank Feed operations.

The queue participates in the same data-loss safeguards as ledger and attachment queues:

- logout is blocked while Bank Feed work is unsynced;
- account switching is blocked while another account owns queued Bank Feed work;
- account deletion and cache clearing cannot silently discard queued Bank Feed work;
- retry resets failed Bank Feed work to pending;
- recovery export includes the Bank Feed queue.

## Offline actions

The following actions can be captured offline after the Bank Feed has been cached once:

- ignore;
- reopen;
- delete an unposted feed row;
- create a Bank Feed rule;
- delete a Bank Feed rule;
- queue a CSV statement import;
- classify and queue **Post to ledger**;
- queue **Undo posting**.

CSV parsing and normalization are client-side and therefore available offline. XLSX statement preview remains explicitly connection-required because the current XLSX preview parser is server-side; the UI tells the user to use CSV for offline statement import.

## Ledger safety

Bank Feed actions that affect money do not fabricate a local balance.

For **Post to ledger** and **Undo posting**:

1. the offline intent is stored durably;
2. the UI shows the action as queued;
3. the cached ledger remains unchanged while disconnected;
4. on reconnect, the server applies the operation inside its existing revision-checked SQLite transaction;
5. the client then pulls or performs a full authoritative refresh;
6. balances are derived from the refreshed ledger.

If the ledger revision moved while the device was offline, the client may rebase the queued post/undo once only when the same Bank Feed row is still in the expected state. Otherwise the operation becomes an explicit conflict.

## Idempotent server sync

`POST /api/sync/bank-feed` accepts a durable Bank Feed operation ID. The server hashes the complete operation and stores the accepted result in the existing `sync_operations` table.

A lost response can therefore be retried safely:

- the identical operation ID and payload returns the original result;
- the Bank Feed mutation is not repeated;
- a ledger posting is not duplicated;
- the ledger revision is not incremented twice;
- reusing an operation ID for different data is rejected with HTTP 409.

## Background sync

The service worker may drain Bank Feed operations that do **not** change the ledger, such as ignore, reopen, delete, rules and imports.

Queued **post** and **undo** operations intentionally request foreground sync instead. This guarantees that any money-changing Bank Feed operation is followed by the normal ledger pull/full-refresh path before the device treats the local ledger as current.

## Production monitoring

`/api/health` publishes `offlineWave100AVersion: 1`.

The existing privacy-safe aggregate monitor adds:

- `bankFeedAccepted`;
- `bankFeedReplayed`;
- `bankFeedConflict`;
- `bankFeedRejected`.

No Bank Feed description, amount, account, operation ID, row ID or user identity is exposed by this telemetry.

## Definition of done

Wave 100A is complete when:

- cached Bank Feed rows open and filter with the network disabled;
- offline Bank Feed changes survive a full reload;
- CSV statement imports can be queued offline;
- XLSX offline limitation is explicit rather than failing ambiguously;
- post/undo never fake local money changes before sync;
- reconnect applies queued Bank Feed work in order;
- a lost response cannot duplicate a Bank Feed action or ledger posting;
- stale post/undo work rebases only when safe and otherwise becomes visible conflict;
- logout/account switching/recovery include Bank Feed queue protection;
- service-worker background sync drains only non-ledger Bank Feed work;
- IndexedDB v4 → v5 preserves all prior offline data;
- contract, server and browser tests are green;
- the exact merged `main` SHA passes CI and Production Smoke.
