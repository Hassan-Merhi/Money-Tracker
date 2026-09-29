# Lane D — Waves 11, 12, and 15

Lane D is the final quality, scale, and release-closure lane. It does not add a new bookkeeping model; it makes the completed product safe to use with a keyboard, safe to grow, and difficult to release with known regressions.

## Wave 11 — Accessibility / Interaction Hardening

Money Tracker now includes:

- a keyboard-visible **Skip to main content** link;
- explicit primary and mobile navigation labels;
- `aria-current="page"` on the active destination;
- page-heading focus after SPA route changes;
- labelled main content and live connection state;
- polite live-region toast announcements;
- automatic programmatic association for form labels and controls;
- modal dialog labelling, initial focus, focus trapping, Escape close, backdrop close, and focus return;
- keyboard activation for account cards;
- person cards rendered as real links;
- visible `:focus-visible` focus treatment;
- minimum coarse-pointer targets for compact controls;
- `prefers-reduced-motion` handling.

## Wave 12 — Scale / Performance / Data Lifecycle

### Coherent storage and recovery limits

All bounded user data limits live in `lib/data-limits.js`. Complete-backup validation uses the same limits as write paths.

Current limits include:

- 10,000 people
- 1,000 accounts
- 50,000 ledger entries
- 10,000 attachments
- 96 MB total attachment storage per account
- 500 recurring rules
- 6,000 recurring notification rows, with acknowledged history retained to 5,000 per user
- 500 Bank Feed rules
- 5,000 Bank Feed import batches
- 50,000 Bank Feed rows
- 256 MB complete-backup restore request body

This closes the class of defects where the server could create a valid backup that its own restore path rejected at much smaller historical caps.

### Bank Feed correctness at scale

- Pending / Posted / Ignored totals are aggregate queries over the full table, not the 5,000-row UI window.
- Bank Feed imports are transactional.
- Duplicate fingerprints are checked before storage-cap enforcement.
- Import batches retain the newest 5,000 rows.
- A valid rule priority of `0` remains `0` in the UI.

### Retention and cache efficiency

- acknowledged recurring reminder history is pruned by age and per-user retained count;
- the 90-day security-event policy is enforced during continued server operation and security-history reads;
- static files emit ETags and answer matching conditional requests with HTTP 304;
- PWA cache contract advances to `money-tracker-debt-v10`;
- stale-while-revalidate work is attached to the service-worker fetch event lifetime with `event.waitUntil()`.

## Wave 15 — Release / QA Closure

Lane D adds dedicated client and server regression suites plus an explicit `npm run test:lane-d` CI gate.

The release suite reproduces the historical recovery thresholds by verifying one complete backup round trip with:

- more than 5,000 Bank Feed rows;
- more than 2,000 recurring notifications;
- more than 1,000 Bank Feed import batches.

It also verifies:

- Lane D health readiness and PWA v10;
- conditional ETag requests;
- continuous security-event retention;
- full-table Bank Feed reconciliation totals;
- recurring-history retention;
- future attachment quota enforcement;
- accessibility source contracts.

Startup emits:

`LANE_D_READY {"waves":[11,12,15],"accessibility":true,"scaleHardening":true,"coherentRecoveryLimits":true,"releaseQa":true}`

Health reports `laneDVersion: 1` and `pwaCacheVersion: 10`.

## Release gates

Lane D is complete only when:

- all existing Wave 0 / Wave 1 / Lane A / Lane B / Lane C tests remain green;
- all Lane D client and server tests pass;
- JavaScript syntax checks include `lib/data-limits.js`;
- no unresolved automated P1/P2 review finding from Lanes A–C remains applicable;
- the exact Lane D branch head passes CI;
- staging boots with EXACT_MONEY_READY, LANE_A_READY, LANE_B_READY, LANE_C_READY, and LANE_D_READY;
- staging health reports Lane D v1 / PWA v10 and healthy SQLite diagnostics;
- staging shows no continuing application errors;
- a fresh production SQLite snapshot is verified immediately before merge;
- main CI passes after merge;
- production reports Lane D v1 / PWA v10, healthy runtime diagnostics, healthy recurring worker, and registration locked;
- there are no continuing post-cutover errors.
