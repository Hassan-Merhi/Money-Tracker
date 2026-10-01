# Wave 100G — Scale & Longevity

Wave 100G hardens Money Tracker for years of use at the declared storage ceilings rather than only small development datasets.

## Declared ceilings

The production contract keeps the existing account limits and publishes the important scale values in `/api/health`:

- 10,000 people;
- 1,000 accounts;
- 50,000 ledger transactions;
- 10,000 attachments;
- 100 MB attachment storage;
- 50,000 Bank Feed rows;
- 10,000 retained sync-change revisions.

These are safety ceilings, not targets that must be reached before cleanup.

## Server hot-path hardening

Deleting or validating a person/account no longer builds the complete application state just to discover whether a ledger row references it.

Dedicated SQLite queries now check:

- direct person references;
- split-person references through SQLite JSON traversal;
- account, source-account and destination-account references.

This avoids loading 50,000 transactions plus attachment metadata for a single reference check.

Full-state construction also derives attachment counts from the already-loaded attachment metadata instead of running a second full attachment aggregation query.

## Search and reporting

Wave 100D introduced local search, but the first implementation rebuilt people/account/category lookup maps for every searched row.

Wave 100G builds those lookup maps once per search/filter pass and reuses them for:

- Activity;
- Reports;
- Bank Feed;
- Scheduled & Reminders.

Currency filtering likewise builds the account lookup map once.

Report workbooks precompute full-ledger person/account balances once and pass them into the reporting snapshot instead of rescanning the ledger for person balances a second time.

The dedicated gate exercises the declared 50k transaction ceiling and a large multi-year report/export fixture.

## IndexedDB v8

Offline schema v8 is an additive index-only migration.

It adds:

- `syncQueue.byIdentity`;
- `attachmentQueue.byIdentity`;
- `bankFeedQueue.byIdentity`;
- `recurringQueue.byIdentity`;
- `tombstones.byIdentity`;
- `fxRates.byIdentity`;
- `attachments.byIdentity`;
- `attachments.byIdentityEntry`.

No durable row is rewritten solely for v8.

Hot paths now use these indexes for attachment lists/cache accounting, queue reads/retry/discard operations, and device-recovery collection.

An upgrade from v4+ does not rebuild the FX cache merely because indexes were added. Older pre-FX schemas still receive the existing safe FX backfill.

## Sync-history longevity

`sync_operations` and tombstones remain durable because deleting them could allow an old retry to duplicate a money mutation or resurrect deleted data.

Only `sync_changes` is safely bounded.

Money Tracker keeps the latest 10,000 ledger revisions of delta history. When a client is older than retained history, the existing pull protocol detects incomplete revision coverage and requests a full refresh.

This keeps delta-history growth bounded without weakening idempotency or deletion safety.

## Deep queue and lifecycle

The 100G browser gate builds a deep offline queue, closes/reopens normal sync cycles, drains it against the real server path, repeats sync after convergence, and verifies:

- zero pending work;
- zero failed work;
- zero conflicts;
- one server record per operation ID;
- no duplication after repeated sync.

The same browser gate verifies v8 indexes with large attachment metadata/queue fixtures.

## PWA and production contract

Wave 100G uses:

- PWA shell **v37**;
- IndexedDB **v8**;
- `offlineWave100GVersion: 1` in `/api/health`.

Production smoke requires the 50,000 transaction ceiling and 10,000-revision sync-history window to be published.

## Definition of done

Wave 100G is complete when:

- 50k-entry search/report/accounting-scale gates pass;
- large workbook generation remains within the release performance budget;
- person/account reference checks avoid whole-state loads;
- IndexedDB v8 migrates atomically and exposes the expected indexes;
- large attachment metadata and deep queue reads use indexed paths;
- old sync cursors fall back to full refresh after delta pruning;
- recent sync cursors still receive deltas;
- processed operation IDs remain replay-safe after history pruning;
- repeated deep-queue sync converges with no duplicates;
- Offline A–F and Waves 100A–100F remain green;
- accounting and visual gates remain green;
- production serves the exact green `main` SHA with `offlineWave100GVersion: 1`, PWA v37 and offline DB v8.
