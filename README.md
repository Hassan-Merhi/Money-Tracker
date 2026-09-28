# Money Tracker — Block A

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

The current Block A suite contains 14 tests covering ledger behavior, registration, CSRF protection, database persistence, stale-update protection, user isolation, and logout/session invalidation.

## Render

`render.yaml` defines a Node web service with a persistent disk mounted at `/var/data` for the SQLite database. The health endpoint is `/api/health`.

## Next blocks

Not part of Block A: Excel import/export, polished PDF statements, receipt attachments, recurring reminders, automatic expense imports, and advanced reporting. Those can build on the ledger and security foundation here.
