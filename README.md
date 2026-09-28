# Money Tracker — Block C

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


## Block C — Data & Documents

Block C adds a complete import/export and statement layer on top of the secure ledger:

- Real Excel (.xlsx) full-ledger export with People, Accounts, Transactions, and README sheets
- Downloadable Excel import template
- Excel (.xlsx/.xlsm) and CSV import preview
- Automatic column suggestions plus manual column mapping
- Append-only reviewed imports for people/opening balances, accounts, and transactions
- Duplicate avoidance for obvious matching people/accounts/transactions
- Ledger summary PDF export
- Per-person, per-currency PDF statements with running balances
- Authenticated export endpoints and CSRF-protected spreadsheet preview
- File-size and workbook expansion limits for safer imports
- No third-party runtime packages; XLSX/PDF generation uses Node built-ins

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

The suite includes the original 14 Block A tests plus Block C tests for XLSX round-trips, import templates, full-ledger workbook exports, and PDF generation.

## Render

`render.yaml` defines a Node web service with a persistent disk mounted at `/var/data` for the SQLite database. The health endpoint is `/api/health`.

## Next blocks

Still reserved for later blocks: receipt attachments, recurring reminders, automatic bank/expense feeds, and advanced reporting. Excel import/export and PDF statements are now included in Block C.
