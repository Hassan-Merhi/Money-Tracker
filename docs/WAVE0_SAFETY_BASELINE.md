# Wave 0 — Safety freeze and baseline

Status target: complete before any exact-money schema migration.

## Production baseline

- Repository: `Hassan-Merhi/Money-Tracker`
- Production branch: `main`
- Pre-Wave-0 production commit: `aafd33227f4f3411781bb17be1bd920274884ea2`
- Production URL: `https://money-owed-tracker.onrender.com`
- Runtime: Node 22.x
- Render region: Frankfurt
- Production service has one persistent 1 GB disk mounted at `/var/data`.
- Production `DATA_DIR=/var/data`.
- Default database path therefore resolves to `/var/data/ledger.sqlite`.
- SQLite runs with foreign keys enabled, WAL journaling, and a 5 second busy timeout.
- The public health endpoint is `/api/health`.

Do not place production user data into the repository or staging.

## Safety controls added in Wave 0

1. `lib/db-snapshot.js` creates a consistent SQLite snapshot using `VACUUM INTO`, SHA-256 checksum metadata, and a schema fingerprint.
2. `scripts/create-db-snapshot.mjs` permits an explicit manual snapshot.
3. `scripts/restore-db-snapshot.mjs` refuses to restore without an explicit offline confirmation flag and validates the snapshot checksum first.
4. `tests/fixtures/wave0-ledger-baseline.json` freezes the expected result of every current money movement.
5. `tests/wave0-baseline.test.js` freezes person balances, account balances, reporting cash flow, and backup integrity.
6. `docs/baselines/wave0-schema.sql` records the pre-migration schema and every money-bearing REAL column.
7. `docs/baselines/wave0-import-contract.md` freezes current Excel/CSV/legacy import behavior.

## One-time production snapshot

The server contains an opt-in startup hook controlled only by:

`WAVE0_BACKUP_ON_START=1`

When enabled, startup creates a timestamped snapshot under:

`/var/data/backups/`

and logs a `WAVE0_BACKUP_CREATED` record containing file name, byte count, SHA-256, and schema SHA-256. The flag must immediately be returned to `0` after one verified snapshot.

The snapshot itself stays on Render's persistent disk and is intentionally excluded from Git.

## Staging rule

All Wave 1 migration development must run against a staging service/database and the Wave 0 fixture first. Never point staging at `/var/data/ledger.sqlite` from production and never copy production credentials into staging.

## Rollback procedure for a future money migration

1. Stop writes / take the production service offline.
2. Record the failing deploy commit.
3. Verify the desired snapshot's `.json` metadata and SHA-256.
4. Run:
   `node scripts/restore-db-snapshot.mjs /var/data/backups/<snapshot>.sqlite --confirm-offline-restore`
5. Revert application code to the last known-good commit.
6. Start the service.
7. Verify `/api/health`, login, dashboard balances, people statements, attachments, imports, reports, Bank Feed references, categories/budgets, and recurring schedules.
8. Keep the automatically renamed `ledger.sqlite.pre-restore` file until verification is complete.
9. Do not delete the Wave 0 snapshot until the exact-money migration has passed final certification.

## Wave 0 exit gate

Wave 0 is complete only when:

- the Wave 0 branch has passed the full CI suite;
- staging is reachable and healthy from the Wave 0 branch;
- the safe snapshot code is merged to `main`;
- a one-time snapshot of the live persistent database has been created and its checksum/schema hash confirmed from production logs;
- the snapshot flag has been disabled again;
- production health is green after the final restart;
- the current ledger/import regression suite is green on `main`.
