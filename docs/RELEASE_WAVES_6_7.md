# Release Waves 6–7 — Accounting and Import/Export Hardening

Date: 2026-09-29

## Wave 6 — Ledger/accounting audit

### Scope
- Every balance-changing transaction type.
- Person, account, dashboard, recurring, and import entry paths.
- Same-currency and cross-currency transfers.
- Exact minor-unit tie-outs and currency isolation.

### Defect found and fixed
A same-currency account transfer could previously debit one amount and credit a different amount. That violated Accounting Invariant I6 and could create or destroy value between two accounts in the same currency.

The invariant is now enforced in:
- the shared ledger transfer validator;
- the browser transfer form;
- server ledger validation used by state saves and atomic entry writes;
- recurring transfer template validation;
- spreadsheet transaction imports.

Cross-currency transfers still permit different source and destination amounts.

### Wave 6 release gate
- Same-currency mismatch is rejected.
- Equal same-currency transfer conserves aggregate account value exactly.
- Cross-currency transfer remains supported.
- Dashboard totals tie to person balances in integer minor units.
- Server and recurring entry paths are covered by automated regression tests.

## Wave 7 — Import/export torture tests

### Scope
- XLSX export → parse → transaction re-import.
- Cross-currency transfers.
- Positive/negative adjustments.
- Split transactions and duplicate/update semantics.
- Malformed XLSX rejection.
- High-volume PDF report generation.

### Defects found and fixed
1. XLSX transaction exports omitted signed adjustment values. Negative person/account adjustments could therefore re-import in the positive direction.
2. XLSX transaction exports omitted source/destination currencies for transfers. A cross-currency transfer could therefore re-import into incorrectly typed accounts.
3. Split allocation notes were part of duplicate identity. Correcting only a split note could create a duplicate instead of updating the existing transaction.
4. Spreadsheet imports did not independently carry source and destination transfer currencies and did not reject non-conserving same-currency transfers before save.

The transaction export contract now includes:
- From Currency
- To Currency
- Signed Amount
- Direction

The manual spreadsheet mapper and import template expose the matching fields.

### Wave 7 release gate
- Exported negative adjustments preserve direction on re-import.
- Exported cross-currency transfers preserve both account currencies and both amounts.
- Same-currency transfer mismatches are rejected at import preparation.
- Split-note-only corrections update rather than duplicate.
- Invalid XLSX input fails closed.
- Large PDF generation remains structurally valid.
- Full repository CI and accounting reconciliation must be green before merge.
