# Money Tracker — Core Ledger + Block D Reporting

Block A is the secure core of the money-transfer / money-owed tracker. It tracks money people owe you, money you owe people, your bank/cash balances, transfers between accounts, repayments, transaction history, and per-person statements.

## Included in Block A

- Responsive desktop and mobile interface
- Installable PWA shell and service worker
- User registration, login, logout, and server-backed sessions
- Strong password hashing with Node `scrypt`
- HttpOnly, SameSite session cookies
- CSRF protection for writes
- Login/register rate limiting
- Per-user ledger isolation
- Request-size limits and input validation
- Optimistic revision checks to stop stale-tab overwrites
- Security headers
- SQLite-backed server persistence
- People and per-person running statements
- Positive person balance = they owe you
- Negative person balance = you owe them
- Accounts: bank, cash, card, wallet, and other
- Opening balances
- Paid-for-someone transactions
- Repayments received
- Borrowing from a person
- Repaying a person
- Manual balance adjustments
- Same-currency and cross-currency transfers
- Dashboard totals grouped by currency
- Transaction history and filters
- Automated ledger and server integration tests
- Render deployment blueprint

## Block C — Imports & Migration

Block C adds a safe migration path for existing money records without duplicating Block D's reporting/export features:

- Excel `.xlsx` / `.xlsm` upload with server-side workbook parsing
- CSV upload directly in the browser
- Import-template workbook generated from the existing Block D XLSX engine
- Preview of workbook sheets and sample rows before any ledger write
- Automatic column suggestions with manual mapping controls
- People + opening-balance imports
- Account + opening-balance imports
- Transaction-history imports, including account transfers and manual person adjustments
- Automatic creation of missing people/accounts when a valid transaction row needs them
- Matching by person name and account name + currency
- Obvious duplicate transaction skipping
- Optimistic revision protection remains active when the import is finally saved
- CSRF-protected XLSX preview endpoint
- 8 MB upload cap, row/column limits, ZIP expansion limits, and malformed-workbook rejection

## Block D — Reports & Exports

Block D adds a dedicated **Reports & Exports** workspace without changing the secure ledger model:

- Date, person, and account report filters
- Period activity summaries grouped by currency
- Current outstanding balance report
- Current account-balance report
- Top merchant/source summary
- Excel `.xlsx` export with five sheets: Overview, Outstanding, People, Accounts, and Transactions
- PDF summary reports
- One-click PDF statement export from an individual person's statement
- Dependency-free XLSX and PDF generation in the browser
- Report/export modules cached by the PWA for offline use

Report filters apply to activity and exported transaction rows. Current outstanding and account balances remain current ledger balances so historical filters do not accidentally present old balances as today's balances.

## Ledger rules

Personal balances use one sign convention everywhere:

- Positive: they owe you
- Negative: you owe them

Account balances start at their opening balance and then change through ledger transactions. Transfers move money between accounts without changing a person's statement.

## Run locally

Requires Node.js 22.13+ (the first Node 22 release line where `node:sqlite` is available without the experimental flag).

```bash
npm test
npm start
```

Then open `http://localhost:4173`.

## Tests

The full suite now contains 19 tests: the original 14 ledger/security tests plus Block D coverage for reporting calculations, date filtering, workbook structure, XLSX generation, and PDF generation.

## Render

`render.yaml` defines a Node web service with a persistent disk mounted at `/var/data` for the SQLite database. The health endpoint is `/api/health`.

## Outside this branch

Spreadsheet import is now implemented in Block C. Receipt/attachment capture, recurring reminders, and automatic bank/expense ingestion remain outside Blocks C/D and can evolve independently.
