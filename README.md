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

Requires Node.js 22.5+.

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

Block D intentionally does not implement spreadsheet import, receipt/attachment capture, recurring reminders, or automatic bank/expense ingestion. Those features can evolve independently on their own build branches while this reporting block remains mergeable against the secure core.
