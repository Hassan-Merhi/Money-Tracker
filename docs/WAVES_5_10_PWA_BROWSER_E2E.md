# Release Waves 5 & 10 — PWA Integrity and Browser E2E

Date: 2026-09-30

## Wave 5 — PWA / cache integrity

### Defects found

1. The current offline shell still used cache version 16 after later release waves changed cached files such as `block-c-import.js` and `lib/ledger.js`. Installed clients therefore had no guaranteed worker-update event for those changes.
2. The PWA version was duplicated between the service worker, health response, tests, and README.
3. Runtime cache reads used `caches.match()`, which searches all caches instead of explicitly reading the active shell cache.
4. Worker/update checks did not explicitly bypass the HTTP cache.

### Completed runtime contract

- `pwa-version.js` is the only file that owns the numeric PWA shell version.
- The service worker loads that contract using `importScripts('/pwa-version.js')`.
- Server health derives `pwaCacheVersion` and `pwaCacheName` from the same file.
- Both `service-worker.js` and `pwa-version.js` are served with `Cache-Control: no-cache`.
- Service-worker registration uses `updateViaCache:'none'` and performs explicit update checks on initialization, focus, and return to a visible tab.
- The active worker reads only its named current cache; stale caches are deleted during activation.
- Network refreshes for static assets use `cache:'no-store'`, avoiding a stale HTTP-cache layer underneath the Cache API.
- The shell version advances to v17 because cached release assets changed after v16.

### Wave 5 release gate

`npm run test:wave5` proves:

- one authoritative numeric cache version;
- every CORE shell file exists;
- every local bootstrap asset from `index.html` is in the offline shell;
- stale-cache cleanup exists;
- runtime reads use only the current cache;
- explicit update activation and controller reload behavior remain intact;
- service-worker/version resources are update-safe.

Wave 10 also performs the runtime half of this gate in a real browser by inspecting the installed cache and switching the browser offline.

## Wave 10 — real-browser E2E

Wave 10 uses Playwright Chromium against a disposable local Money Tracker server and SQLite database. It does not mutate production data.

### Desktop workflow

The browser test covers:

- first-owner registration;
- Simple-mode People navigation;
- person creation with an opening balance;
- person debt activity creation;
- person statement rendering;
- Activity filtering;
- switching from Simple to Advanced mode;
- account creation;
- same-currency account transfer;
- post-transfer account balances;
- Bank Feed, Insights & Budgets, Scheduled & Reminders, and Reports route rendering;
- browser console and uncaught page-error cleanliness.

### Mobile workflow

A real mobile Chromium context uses a 390 × 844 viewport with touch/mobile emulation and covers:

- login;
- bottom navigation;
- People creation;
- Activity filtering;
- Reports;
- More → Settings navigation;
- horizontal-overflow assertions after each critical page transition;
- browser console and uncaught page-error cleanliness.

### PWA browser workflow

The real browser test also verifies:

- an active controlling service worker;
- the authoritative current cache name;
- the current offline cache contains `index.html`, `lib/ledger.js`, `block-c-import.js`, and `pwa-version.js`;
- cached static resources still load when the browser is forced offline;
- `/api/*` requests are not served from the offline cache.

## CI gates

- `npm run test:wave5` runs in the standard test job.
- `npm run test:wave10` runs in a separate Chromium job after the normal test job passes.
- Playwright uses version 1.63.0, pinned in `devDependencies`.
- Browser traces, screenshots, videos, and the HTML report are retained/uploaded when the browser job fails.
- The normal full tests, Lane D, Waves 11–12, accounting reconciliation, and syntax checks remain mandatory.

Waves 5 and 10 are complete only when the exact pull-request head passes both CI jobs and the merged `main` commit passes both jobs again.
