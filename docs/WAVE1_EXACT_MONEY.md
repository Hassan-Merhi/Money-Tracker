# Wave 1 — Exact Money Engine

## Goal

Money Tracker no longer uses binary floating-point values as the authoritative representation of money. SQLite stores monetary quantities as integer minor units, while the API and UI continue to exchange normal decimal amounts.

## Storage contract

Money-bearing fields now use INTEGER columns:

- `accounts.opening_balance_minor`
- `entries.amount_minor`
- `entries.from_amount_minor`
- `entries.to_amount_minor`
- `entries.signed_amount_minor`
- `budgets.monthly_limit_minor`
- `bank_feed_items.signed_amount_minor`
- split allocations are stored as `amountMinor` inside `entries.split_json`
- recurring templates are stored with `moneyStorageVersion: 1` and integer minor-unit fields

The legacy REAL columns are removed by the migration.

## Currency precision

`lib/money.js` defines the currency exponent used for storage.

- Zero decimal currencies include JPY, KRW, VND and other ISO zero-decimal currencies.
- Three decimal currencies include KWD, BHD, JOD and others.
- Four decimal currencies include CLF and UYW.
- Other supported codes default to two decimal places.

Money Tracker rejects unsupported extra precision instead of silently rounding it. For example, USD 1.001 is invalid, while KWD 1.234 is valid.

## Migration

At startup, `ensureCoreExactMoneySchema`, `ensureInsightsExactMoneySchema`, and `ensureBankFeedExactMoneySchema` detect the Wave 0 schema and transactionally rebuild the relevant tables using integer minor units.

Recurring template JSON is migrated to the versioned exact-money representation.

After every migration succeeds, `app_meta.money_schema_version` is set to `1`. Startup logs:

`EXACT_MONEY_READY {"version":1,"storage":"integer-minor-units"}`

and `/api/health` reports the same schema version.

## Application behavior

- Existing API/UI decimal values remain compatible.
- Account and person balance calculations sum minor-unit integers.
- Running statements sum exact integer amounts.
- Split totals compare exact integer allocations.
- Equal-split buttons divide minor units and distribute remainder units deterministically.
- Budgets and insight totals use exact integer accumulation.
- Report aggregation uses currency-aware exact addition.
- Bank statement fingerprints use normalized integer amounts.
- Bank transfer matching uses exact integer equality instead of tolerance comparisons.
- Spreadsheet imports reject invalid currency precision before saving.

## Safety and rollback

Wave 0 created the pre-migration recovery tooling and snapshot capability. Before production Wave 1 deployment, create and verify a fresh pre-Wave-1 snapshot on the production persistent disk.

If production startup does not reach `EXACT_MONEY_READY`, do not accept the migration as complete. Roll application code back to the Wave 0 commit and restore the verified pre-Wave-1 database snapshot with the offline restore procedure if required.

## Verification gates

Wave 1 is complete only when:

- all unit/integration/import/report/recurring/bank tests pass;
- legacy REAL-to-INTEGER migration tests pass;
- unsupported currency precision is rejected;
- the Wave 0 balance fixture is unchanged;
- Wave 1 staging reports `moneySchemaVersion: 1`;
- a fresh production snapshot exists immediately before migration;
- production starts and logs `EXACT_MONEY_READY`;
- production health reports integer minor-unit storage;
- registration remains locked and existing user data remains readable;
- no post-cutover server errors are present.
