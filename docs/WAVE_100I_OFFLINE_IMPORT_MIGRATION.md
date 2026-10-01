# Wave 100I — Offline Import & Migration

Wave 100I makes the complete Block C import workflow usable without a network connection while preserving the existing server-authoritative accounting and sync model.

## Scope

The following import paths now work on an authorized offline device:

- normal CSV import;
- normal XLSX/XLSM import;
- legacy workbook detection and migration;
- Quick Excel Paste.

XLSX/XLSM files are parsed directly in the browser with `lib/xlsx-browser.js`; Block C no longer calls `/api/import/xlsx/preview`.

## Durable import batch

Offline import apply does not overwrite the ledger wholesale. `commitImportedState()` diffs the reviewed import result against the current cached ledger and converts only imported changes into ordered person, account, and transaction mutations.

`enqueueLocalMutations()` writes the full mutation set in one IndexedDB transaction:

- every queued operation receives the exact sequential base revision it will require;
- people and accounts are queued before dependent transactions;
- the local ledger and durable sync outbox are committed atomically;
- if another tab changes the ledger before the batch commits, the entire import aborts with a stale-revision error;
- imports cannot delete existing records or change settings, categories, or budgets;
- the FX cache is rebuilt after imported transaction changes.

When the browser is online, the existing server-side whole-state import save remains in use, preserving its atomic server validation. The durable mutation batch is used only for offline apply.

## Reconnect and conflict behavior

After reconnect, the existing ledger sync engine replays each imported mutation through `/api/sync/push`.

This keeps all existing guarantees:

- server validation and data limits;
- optimistic revision checks;
- idempotent operation IDs;
- automatic safe rebase when unrelated remote work advanced the ledger;
- targeted conflicts when the same imported record changed elsewhere;
- no silent overwrite of remote changes.

## PWA and release contract

Wave 100I uses:

- PWA shell **v39**;
- IndexedDB **v8**;
- `offlineWave100IVersion: 1` in `/api/health`.

No IndexedDB schema bump is required because the existing ledger queue stores the import operations.

## Dedicated gates

The Wave 100I Node gate verifies:

- Block C has no server XLSX preview dependency;
- all three apply paths use `commitImportedState()`;
- imported-state diffing creates deterministic ordered mutations;
- deletion, settings/category/budget mutation, and stale-version replacement are rejected;
- the atomic batch queue exists in the offline database layer;
- PWA v39, health, production-smoke, package scripts, and CI wiring.

The browser gate verifies a real XLSX people/opening-balance import in airplane mode:

1. open Block C from an authorized cached ledger;
2. choose an XLSX file while fully offline;
3. preview and map it locally;
4. confirm the import;
5. verify both the new person and opening-balance transaction exist locally;
6. verify both mutations are in the durable queue;
7. reload while still offline and verify the import remains;
8. reconnect and sync;
9. verify the server contains exactly one person and exactly one opening-balance transaction;
10. verify the queue is empty.

## Definition of done

Wave 100I is complete when normal Excel/CSV imports, legacy workbook migration, and Quick Excel Paste no longer require connectivity to preview and apply; offline apply is atomic locally, revision-safe, durable across reload, and converges through the existing server sync path without duplication; all earlier offline, accounting, release, browser, and visual gates remain green; and production serves the exact green `main` SHA with `offlineWave100IVersion: 1`, PWA v39, and offline DB v8.
