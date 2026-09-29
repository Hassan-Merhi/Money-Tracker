# Wave 0 import contract

Baseline commit: `aafd33227f4f3411781bb17be1bd920274884ea2`

This document freezes import behavior before the exact-money migration.

## Supported input behavior

- Browser CSV import with column mapping.
- Server-protected `.xlsx` / `.xlsm` preview and parsing.
- People and signed opening balances.
- Accounts and opening balances.
- Person debt transactions with or without an account.
- Transfers, balance adjustments, split purchases, account expenses, and account income.
- Category names from Money Tracker exports are mapped to compatible existing categories.
- Re-imports skip obvious duplicates.
- Money Tracker's own exported transaction workbook can round-trip back through Block C.

## Legacy Courses.xlsx-style workbook behavior

The importer recognizes the established legacy layout used before Money Tracker:

- side-by-side person ledgers;
- Troy/UWA course ledgers;
- shipping;
- monthly spending;
- safe Cash Money rows;
- summary sheets such as COURSE PAYMENTS are ignored when importing them would double-count;
- unchanged legacy rows are skipped on re-import;
- corrected legacy rows update in place rather than creating a second obligation.

## Regression gates

The following existing automated tests are part of the Wave 0 import baseline and must remain green through Wave 1:

- `tests/block-c-import.test.js`
- `tests/block-c-import-server.test.js`
- `tests/legacy-excel-import.test.js`
- `tests/xlsx.test.js`
- bank statement parser tests in `tests/bank-feed.test.js`

Any intentional Wave 1 format change must keep the same financial result for these fixtures even if the internal representation changes from floating-point to exact money.
