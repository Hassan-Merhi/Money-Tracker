# Wave 100D — Offline Search & Filters

Wave 100D makes search and filter behavior deterministic from device-local data so the same views continue to work after a successful cached session, including while offline.

## Scope

The local query layer covers:

- People search;
- Activity text search plus type/person/category/date filters;
- Person statement search;
- Reports text search plus period/person/account/category/type/currency filters;
- Bank Feed text/status/account/date filters over the cached feed window;
- Scheduled & Reminders text/status filters;
- existing Insights month filtering.

## Query semantics

`lib/offline-query.js` is the shared deterministic query engine.

Search is:

- case-insensitive;
- accent/diacritic-insensitive;
- whitespace-normalized;
- token based: every typed token must be present somewhere in the searchable record text;
- local-only while offline, with no network fallback and no invented data.

Activity and Reports search across transaction fields plus related local metadata, including:

- date and transaction type;
- merchant and description;
- person names;
- account names;
- category names;
- split people/notes;
- amount/currency fields.

Because Activity and Reports query the current IndexedDB-backed ledger snapshot, unsynced offline ledger changes are searchable immediately.

## Bank Feed

Bank Feed search/filtering is performed by the same local query path online and offline for cached rows.

Supported filters:

- status;
- text search;
- account;
- from date;
- to date.

Money Tracker keeps the latest 500 Bank Feed rows in the offline snapshot. Offline search is intentionally limited to that cached window and never claims to search server rows that are not on the device.

## Scheduled & Reminders

Cached recurring schedules support:

- text search across title, frequency, dates, template type/merchant/description and linked person/account/category names;
- status filters for Active, Paused and Complete.

The filter operates against the same cached/optimistic schedule snapshot used by Wave 100B, so queued offline schedule edits appear in filtered results immediately.

## Routing and reload behavior

Activity and Reports store search/filter state in the hash query string. Reloading the PWA offline reproduces the same result set.

People keeps its existing route-backed search.

Bank Feed and Scheduled filters remain in the current app session and are recomputed locally after each cached refresh.

## Safety

Search and filters never mutate ledger state.

They do not:

- alter balances;
- create sync operations;
- change server revisions;
- fetch live FX;
- fabricate uncached Bank Feed rows;
- bypass the seven-day offline authorization lease.

## Production contract

`/api/health` publishes `offlineWave100DVersion: 1`.

PWA shell version is **34**. IndexedDB remains **v7** because Wave 100D adds query behavior but no new durable store/schema.

## Definition of done

Wave 100D is complete when:

- People/Activity/Reports searches use normalized local matching;
- Activity text search composes correctly with type/person/category/date filters;
- report exports use the same filtered transaction set visible in Reports;
- Bank Feed cached search composes with status/account/date;
- Scheduled cached search composes with status;
- unsynced local transactions can be found while offline;
- an offline reload preserves route-backed Activity/Report filters;
- mobile/tablet/desktop filter layouts remain usable;
- Offline A–F and Waves 100A–100C remain green;
- dedicated Wave 100D contract/browser gates are green;
- accounting and visual gates remain green;
- production serves the exact green `main` SHA with `offlineWave100DVersion: 1` and PWA v34.
