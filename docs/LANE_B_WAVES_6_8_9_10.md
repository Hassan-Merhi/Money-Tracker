# Lane B — Waves 6, 8, 9, and 10

Lane B is complete only when all four product waves pass together on branch CI, staging, main CI, and production.

## Wave 6 — Simple / Advanced Money Mode

The old hard-coded debt-only flag is removed.

Each user now has:
- `app_mode`: `simple` or `advanced`
- `timezone`: an IANA timezone used by recurring reminders

Simple mode keeps the debt-first experience and hides Accounts, Bank Feed, Insights/Budgets, and Scheduled transactions without deleting any data.

Advanced mode exposes the full money system:
- accounts and cash
- transfers
- account-only income/expenses
- Bank Feed
- categories and budgets
- recurring schedules and reminders

Users can switch modes from Settings or enable Advanced mode directly from the Simple-mode dashboard. Switching modes does not mutate financial records.

## Wave 8 — Server Recurring Reminder Worker

Recurring schedules remain review-first: the server never silently posts a financial ledger entry.

The server now maintains a durable `recurring_notifications` inbox. The worker:
- evaluates active schedules using each user's IANA timezone;
- creates reminders when the local date enters the configured reminder window;
- uses a unique rule/occurrence constraint so repeated worker runs cannot create duplicate reminders;
- runs on server startup and then hourly while the service is running;
- exposes worker status through `/api/health`;
- automatically acknowledges an occurrence reminder after the occurrence is posted or skipped;
- removes reminder data when a rule or user dataset is deleted.

The Scheduled page shows the durable reminder inbox. Browser notifications remain an optional convenience layer.

Production uses a persistent-disk Render service rather than an ephemeral local worker process; deployment verification must confirm the service remains continuously available for the hourly worker.

## Wave 9 — Bank Feed Production Completion

Bank Feed now includes:
- CSV/XLSX/XLSM review-first ingestion;
- common international statement header aliases;
- European-formatted amount parsing;
- exact-money duplicate fingerprints;
- import batches/history with total/imported/duplicate/invalid counts;
- reconciliation stats for Pending / Posted / Ignored;
- priority-ranked classification rules;
- deterministic tie-breaking by match length and update time;
- exact transfer matching;
- two-sided transfer deduplication;
- reversible posting.

Undo Posting deletes the generated ledger entry, removes its attachments, and reopens every Bank Feed row linked to the entry. For matched two-sided transfers, both statement rows reopen together while the single transfer entry is removed.

Bank import history and rule priority are included in the complete backup.

Live bank-provider OAuth/open-banking connections remain a separate future integration; Lane B completes the production file-ingestion workflow.

## Wave 10 — Reports / PDF / Excel v2

Reports preserve exact currency arithmetic and add filters for:
- date range
- person
- account
- category
- transaction type
- currency

The report screen also exposes monthly movement and configured budgets.

Transaction export rows now include:
- stable Entry ID
- Person ID
- Account / From Account / To Account IDs
- Category ID
- attachment IDs and names
- Created At / Updated At timestamps
- split details and normal audit-facing descriptive fields

The XLSX workbook now contains:
- Metadata
- Overview
- Outstanding
- People
- Accounts
- Categories
- Budgets
- Spending
- Monthly
- Transactions

XLSX files use frozen header rows, autofilters, column widths, and styled headers. A regression test exports a real Money Tracker workbook and parses it back through the app's XLSX reader to verify transaction IDs and attachment references survive the file boundary.

PDF reports include current balances, categories, budgets, monthly movement, and auditable transaction lines with stable entry IDs.

## Backup integration

Complete backup v2 now also preserves:
- user app mode
- user timezone
- recurring reminder inbox
- Bank Feed import batches/history

Backup integrity and transactional restore protections from Lane A remain unchanged.

## Release gates

Lane B is complete only when:
- there is no `DEBT_ONLY_MODE` in current application code;
- switching Simple ↔ Advanced preserves hidden accounts and transactions;
- recurring worker idempotency/timezone tests pass;
- posting/skipping recurring occurrences acknowledges the handled reminder;
- Bank Feed batch history, priority rules, undo, and matched-transfer undo tests pass;
- report v2 filter/export/PDF/XLSX/round-trip tests pass;
- all existing Wave 0 / Wave 1 / Lane A regressions remain green;
- dedicated Lane B staging logs `EXACT_MONEY_READY`, `LANE_A_READY`, and `LANE_B_READY`;
- staging health reports Lane B version 1 and a healthy recurring worker;
- a fresh production SQLite snapshot is verified immediately before release;
- main CI passes after merge;
- production reports the same readiness values with registration still locked;
- there are no continuing post-cutover application errors.
