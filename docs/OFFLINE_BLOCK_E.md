# Offline Block E — O16–O19

Offline Block E completes the offline reporting, FX, update-safety, and client-schema-migration layer. The server remains authoritative for synced ledger state; reports and exports can be produced entirely from the durable local snapshot.

## O16 — Offline reports, PDF, and Excel

Reports remain client-generated from the same local ledger snapshot used by the app.

- Reports render with no network dependency after a successful cached launch.
- PDF reports are built locally by `lib/pdf.js`.
- Excel workbooks are built locally by `lib/xlsx.js`.
- Export buttons remain available while offline.
- Exports use the currently visible local ledger revision, including unsynced local-first changes.
- No authenticated API response is placed in Cache Storage.
- Person statements and full reports use the same deterministic accounting functions online and offline.

## O17 — FX handling

Money Tracker does not invent a live exchange rate.

- Currency balances remain separate by currency.
- A cross-currency transfer records both `fromAmount` and `toAmount`.
- Its historical FX rate is deterministically derived as `toAmount / fromAmount`.
- Reports, PDF, and Excel expose the recorded pair/rate and label the source `recorded_transfer`.
- Same-currency transfers have no FX rate.
- Invalid or incomplete transfer amounts never produce a guessed rate.
- IndexedDB v4 stores a derived FX cache for offline diagnostics and future offline conversion workflows.
- The ledger transaction remains the accounting source of truth; the FX cache can always be rebuilt.

## O18 — Safe service-worker updates

A newly installed service worker remains waiting until the user explicitly applies the update.

Before activation:

- the app queries the waiting worker for its PWA version and required offline database version;
- activation is blocked while any queued/failed/conflicted ledger or attachment work remains;
- the waiting worker advertises both its target DB schema and the oldest DB schema it can migrate from; unsupported upgrade jumps are blocked;
- update compatibility fails closed: missing/invalid worker schema metadata or a target schema older than the current device schema blocks activation instead of guessing;
- the existing controller stays active until the update is safe;
- successful activation reloads the app through `controllerchange`.

This keeps an update from stranding unsynced money changes between incompatible client schemas.

## O19 — IndexedDB migrations

Offline Block E introduced IndexedDB v4 with explicit additive migrations. Wave 100A subsequently extends the live schema to **v5** with additive Bank Feed cache/outbox stores; the v1–v4 migration guarantees below remain unchanged:

- **v1** — meta + ledger stores;
- **v2** — sync queue, sync state, tombstones;
- **v3** — attachment + attachment queue;
- **v4** — recorded FX cache;
- **v5** — Bank Feed cache + durable Bank Feed queue (Wave 100A).

IndexedDB commits `onupgradeneeded` atomically. If a migration fails, the prior database remains intact.

After opening v4 or any later schema, a one-time post-open migration backfills the FX cache from preserved account-transfer entries and records schema metadata in `meta/schema-info`.

Migration requirements:

- people, accounts, entries, categories, budgets survive;
- unsynced queue rows survive;
- attachment rows and attachment queue rows survive;
- active-user and state-head metadata survive;
- FX cache is rebuilt from the preserved ledger and refreshed after local mutation, pull, full snapshot replacement, and conflict rebase;
- migrations never clear user data;
- future tabs close on `versionchange` so a newer schema can proceed.

## Definition of done

Block E is complete when all of the following are green:

- reports render offline from cached state;
- offline PDF download begins and produces a valid PDF;
- offline Excel download begins and produces a valid XLSX/ZIP workbook;
- offline exports include unsynced local-first changes;
- cross-currency transfer rates are exported from recorded amounts only;
- mixed currencies remain separate and no live conversion is implied;
- v3 → v4 browser migration preserves ledger, outbox, attachments, and identity;
- migrated v4 FX cache is backfilled correctly;
- PWA update metadata includes its required DB schema;
- app-update activation is blocked while unsynced work exists;
- service-worker shell includes every transitive Block E module;
- Offline Blocks A–D remain green;
- accounting, release, visual, post-merge CI, and production smoke gates all pass.
