# Wave 100H — Offline Completeness & Release Closure

Wave 100H closes the last known user-facing offline import gap after Waves 100A–100G and turns the expanded offline program into a single release-gated contract.

## Offline XLSX/XLSM Bank Feed import

Bank Feed Excel statement preview no longer requires a server round trip.

`lib/xlsx-browser.js` parses XLSX/XLSM workbook structure directly on the device. It supports the OOXML parts Money Tracker needs for statement preview:

- workbook and relationship discovery;
- shared strings and inline strings;
- numbers, booleans and text cells;
- multiple sheets;
- ZIP stored and DEFLATE entries;
- the same 5,000-row / 100-column preview limits used by the server parser.

The browser parser also retains defensive limits:

- 8 MB selected statement file limit in the Bank Feed UI;
- at most 250 ZIP members;
- at most 20 MB expanded workbook content;
- encrypted workbooks are rejected;
- unsupported ZIP layouts/compression methods fail explicitly.

CSV, XLSX and XLSM statements can therefore be selected, mapped and queued while the device is offline.

## Money safety

Wave 100H does not create a second accounting authority.

An offline Bank Feed import still follows the Wave 100A durable outbox:

1. the workbook is parsed locally;
2. normalized statement rows are queued in IndexedDB;
3. no ledger balance changes during import preview or queueing;
4. reconnect replays the same durable Bank Feed import operation;
5. server duplicate detection and idempotency remain authoritative;
6. posted ledger mutations still use the existing revision-checked sync path.

## PWA closure

The browser XLSX parser is part of the controlled service-worker shell so it is available after an offline reload.

Wave 100H uses:

- PWA shell **v38**;
- IndexedDB **v8**;
- `offlineWave100HVersion: 1` in `/api/health`.

No IndexedDB schema change is required because this wave removes a read/preview dependency rather than adding durable data.

## Documentation correction

The README now describes the application as offline-first rather than claiming every financial change requires a live connection.

Authentication, owner administration and final server synchronization still require the server by design. Authorized offline working sets, durable queues, local reports/exports and supported mutations continue to follow the existing seven-day device authorization and conflict/idempotency rules.

## Dedicated gates

The Wave 100H Node gate verifies:

- browser XLSX parsing without Node-only `zlib` or `Buffer` dependencies;
- Bank Feed no longer calls the server preview helper;
- the parser is cached by the PWA;
- PWA v38 / IndexedDB v8 contracts;
- health and production-smoke 100H markers;
- CI and package scripts.

The browser gate runs the real application in airplane mode and verifies that an XLSX statement:

- previews locally;
- auto-maps normal bank headers;
- queues an import while offline;
- survives the durable queue path;
- syncs after reconnect;
- appears exactly once in the server Bank Feed.

## Definition of done

Wave 100H is complete when:

- CSV, XLSX and XLSM Bank Feed statement preview no longer depends on connectivity;
- offline XLSX/XLSM import uses the same normalized Bank Feed rows as online import;
- workbook safety limits remain enforced client-side;
- no Node-only parser dependency enters the browser bundle;
- the XLSX parser is in the service-worker precache;
- the durable import queue survives offline use and converges after reconnect without duplication;
- Offline A–F and Waves 100A–100G remain green;
- accounting, release and visual gates remain green;
- production serves the exact green `main` SHA with `offlineWave100HVersion: 1`, PWA v38 and offline DB v8.
