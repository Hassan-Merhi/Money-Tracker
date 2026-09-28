# Money Tracker — Secure Ledger, Daily-Use App, Reporting & Recurring Reminders

Money Tracker is a server-backed personal ledger for tracking money people owe you, money you owe people, bank/cash balances, transfers, shared purchases, receipts, notes, statements, and exports.

## Block A — Secure core

- User registration, login, logout, and server-backed sessions
- Strong password hashing with Node `scrypt`
- HttpOnly, SameSite session cookies and CSRF protection
- Login/register rate limiting and request validation
- Per-user SQLite ledger isolation
- Optimistic revision checks to stop stale-tab overwrites
- Security headers and Render persistent-disk deployment
- People, accounts, opening balances, repayments, borrowing, paybacks, adjustments, transfers, dashboard totals, history, and statements

## Block B — Daily-use app

Block B makes the ledger practical for everyday use on desktop and mobile:

- Responsive desktop navigation and mobile bottom navigation
- Mobile floating quick-add button
- Keyboard shortcuts: **N** for quick add and **T** for transfer
- Quick-entry menu for common money actions
- Remembers the most recently used person/account locally for faster entry
- Rich transaction notes and merchant/source fields
- **Split purchases:** one account payment can be allocated across multiple people
- Equal-split helper plus per-person split amounts and notes
- Split purchases debit the paying account only once while each person's statement receives only their allocation
- **Receipt/file attachments:** JPG, PNG, WebP, GIF, PDF, and text up to 8 MB each
- Attachments use authenticated server endpoints and are stored separately from the ledger JSON state
- Attachment counts appear in transaction history/statements; files can be opened or removed from transaction editing
- Server-side split validation, attachment ownership isolation, and orphan cleanup
- Sticky mobile modal controls and larger touch targets

## Block C — Imports & migration

- Excel `.xlsx` / `.xlsm` upload with protected server-side workbook parsing
- CSV import directly in the browser
- Downloadable import template using the existing Block D XLSX engine
- Sheet/sample preview before any ledger write
- Automatic column suggestions plus manual mapping
- People and opening-balance imports
- Account and opening-balance imports
- Transaction history, transfers, adjustments, and Block B split-purchase imports
- Missing people/accounts can be created from valid transaction rows
- Matching by person name and account name + currency
- Obvious duplicate transaction skipping
- Re-import compatibility with Block D transaction exports, including `Split Details`
- CSRF protection, optimistic revision checks, 8 MB upload limit, ZIP expansion limits, row/column limits, and malformed-workbook rejection

## Block D — Reports & exports

- Date, person, and account report filters
- Period activity summaries grouped by currency
- Current outstanding and account-balance reports
- Top merchant/source summary
- Excel `.xlsx` export with Overview, Outstanding, People, Accounts, and Transactions sheets
- PDF summary reports and one-click per-person PDF statements
- Split allocations and attachment counts included in exported transaction data
- Dependency-free XLSX/PDF generation in the browser
- Reporting modules cached by the PWA for offline shell use

Report filters apply to activity and exported transaction rows. Current outstanding and account balances remain current ledger balances so historical filters do not accidentally present old balances as today's balances.

## Block E — Recurring schedules & reminders

- Server-persisted recurring transaction schedules isolated per user
- Daily, weekly, monthly, and yearly recurrence with configurable intervals
- Month-end and leap-day recurrence anchoring so dates advance predictably
- Due, overdue, and configurable reminder-window statuses
- Scheduled page plus a dashboard reminder widget
- Optional browser notifications while Money Tracker is open
- Review-before-post workflow: schedules never silently mutate the ledger
- Atomic **Post now** action creates one ledger transaction and advances the schedule together
- Optimistic ledger revision checks and occurrence checks prevent stale-tab or duplicate posting
- Skip, pause/resume, edit, and delete schedule controls
- Optional end dates and last-posted occurrence tracking
- Templates for payments, repayments, borrowing, paybacks, balance adjustments, account transfers, and split purchases
- Schedule reference protection prevents deleting a person/account still used by a recurring rule
- Recurring modules included in the PWA offline shell


## Ledger rules

- Positive personal balance: they owe you
- Negative personal balance: you owe them
- Account balances start at opening balance and then move through ledger transactions
- Transfers affect accounts only, never a person's balance
- A split purchase reduces the source account by the transaction total exactly once

## Run locally

Requires Node.js 22.13+.

```bash
npm test
npm start
```

Then open `http://localhost:4173`.

## Tests

The automated suite covers core ledger math, split allocation math and validation, authenticated server persistence, CSRF and user isolation, receipt attachments, reporting calculations and filters, XLSX generation, PDF generation, XLSX parsing, import mapping/deduplication, split-purchase migration, protected import previews, recurrence date math, recurring schedule isolation, atomic occurrence posting, duplicate-post rejection, skipping, pausing, and recurring reference protection.

## Render

`render.yaml` defines a Node web service with a persistent disk mounted at `/var/data` for the SQLite database. The health endpoint is `/api/health`.

## Still outside Blocks A/B/C/D/E

Automatic bank/expense ingestion remains a separate future block.
