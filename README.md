# Money Tracker — Debt Tracker

Money Tracker supports two persisted user modes:

- **Simple mode** keeps the debt-first experience focused on money people owe you and money you owe people.
- **Advanced mode** exposes accounts and cash, transfers, account income/expenses, Bank Feed, categories/budgets, recurring schedules, reminders, and the full reporting stack.

Switching modes never deletes hidden financial data. The app also runs as an installable PWA with an offline shell; financial changes remain server-authoritative and require a live connection.

## Responsive dashboard

The dashboard uses a teal-accented, theme-aware workspace with responsive balance
cards, editable recent activity, a per-person outstanding balance overview, and
quick actions. Desktop keeps the full sidebar; phones show five comfortable
navigation targets (Advanced tools are available from **More**). All totals remain
currency-separated and use the existing ledger calculations.

No runtime dependencies, external fonts, or analytics are required in production. The current PWA
shell version is owned only by `pwa-version.js`; the service worker and health endpoint both consume that contract so cache-version drift cannot recur.
See [dashboard QA notes](docs/DASHBOARD_REFRESH.md) for validation and review steps.

## Block A — Secure core

- One-time public owner registration, login/logout, owner-managed additional accounts from Settings, and server-backed sessions
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
- Sticky-header quick-add button on mobile (no floating control covering ledger content)
- Keyboard shortcut: **N** for quick add
- Quick-entry menu for common money actions
- Remembers the most recently used person locally for faster entry
- Rich transaction notes and merchant/source fields
- **Split debts:** one total can be allocated across multiple people without a bank account
- Equal-split helper plus per-person split amounts and notes
- Each person's statement receives only their split allocation; an account is optional
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
- Missing people can be created from valid debt transaction rows; accounts remain optional for person transactions
- Matching by person name and account name + currency
- Obvious duplicate transaction skipping
- Automatic recognition of the existing `Courses.xlsx`-style workbook, including side-by-side person ledgers, Troy/UWA course ledgers, shipping, monthly spending, and the safe Cash Money section
- Safe legacy re-imports: unchanged rows are skipped, corrected legacy rows update in place, and summary sheets such as `COURSE PAYMENTS` are ignored to prevent double-counting
- Re-import compatibility with Block D transaction exports, including `Split Details`, Block F account expense/income entries, and Block G category names
- CSRF protection, optimistic revision checks, 8 MB upload limit, ZIP expansion limits, row/column limits, and malformed-workbook rejection

## Block D — Reports & exports

- Monthly reports keep **Receivables movement** (person deltas), **Personal cash flow** (account income minus expenses), and **Transfer flow** (both transfer legs by currency) separate in Reports, PDF, and the Excel Monthly sheet with its Measure column. Same-currency transfers cancel; cross-currency legs stay in their original currencies.
- Date, person, and account report filters
- Period activity summaries grouped by currency
- Current outstanding and account-balance reports
- Top merchant/source summary
- Excel `.xlsx` export with Overview, Outstanding, People, Accounts, Categories, Budgets, Spending, and Transactions sheets
- PDF summary reports and one-click per-person PDF statements
- Categories, split allocations, and attachment counts included in exported transaction data
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
- Templates for payments, repayments, borrowing, paybacks, balance adjustments, account transfers, split purchases, categorized account expenses, and categorized account income
- Schedule reference protection prevents deleting a person/account still used by a recurring rule
- Recurring modules included in the PWA offline shell


## Block F — Bank statement ingestion & expense feed

- Dedicated **Bank Feed** page with a review inbox separate from posted ledger transactions
- CSV, semicolon-delimited CSV, `.xlsx`, and `.xlsm` statement ingestion
- Automatic statement column suggestions with manual mapping for date, description, merchant, amount, debit, credit, transaction ID, and currency
- Configurable day/month vs month/day parsing and signed-amount direction
- Separate debit/credit-column support
- Statement rows are normalized and validated before reaching the server
- User-scoped, server-persisted feed rows with deterministic duplicate detection, so re-importing the same statement safely skips duplicates
- Review-before-post workflow: imported rows never change balances until explicitly posted
- Account-only **expense** and **income** ledger entries for transactions that do not involve another person
- Review actions can instead classify a row as paid for someone, repayment received, borrowed money, paid someone back, or a same-currency transfer between your own accounts
- If both sides of the same transfer are imported from separate account statements, the second reviewed side links to the existing transfer instead of creating a duplicate ledger movement
- Transfer auto-linking compares the merchant/description text of both statement sides, so two same-amount transfers close together stay separate; an ambiguous match creates a new movement (recoverable with Undo) instead of silently merging two movements
- Merchant/description rules can remember classifications and expense/income categories for future imports
- Ignore, reopen, and delete controls for unposted feed rows
- Atomic posting updates the ledger revision and feed status together
- Direction validation prevents posting money-in rows as expenses or money-out rows as income/repayments
- Stale-tab revision checks, CSRF protection, per-user feed/rule isolation, and rule/reference cleanup
- Deleting a posted ledger entry reopens its feed item; deleting referenced accounts cleans unusable unposted rows/rules
- Editing a posted transaction re-checks its bank feed row and reopens it when the amount, account, currency, or date no longer matches
- The inbox is paginated (100 rows per page, Prev/Next with "showing X-Y of N") while the Pending/Posted/Ignored totals keep counting every stored row
- A per-account reconciliation panel compares imported statement rows with posted/ignored/pending rows and the signed posted totals with that account's ledger movements, excluding the opening balance and counting transfers on both accounts
- Bank-imported expenses participate in account balances, transaction editing/filtering, category budgets, exports, re-imports, and merchant/category reports
- Block F modules are included in the PWA offline shell


## Block G — Categories, budgets & spending insights

- First-class expense/income categories with sensible defaults plus custom categories
- Category types can be **Expense**, **Income**, or **Both**
- Categories can be renamed, edited, archived, and restored without losing historical transaction labels
- Category lifecycle protection prevents incompatible type changes once history or recurring schedules depend on a category
- Active recurring schedules prevent accidental category archival until the schedule is updated or paused
- Monthly budgets are scoped to an expense category and currency
- Budget progress shows spent, remaining/over amount, percentage used, and near/over-limit status
- Dedicated **Insights & Budgets** page with month selection, personal expenses, account income, net personal cash flow, category breakdown, and six-month trends
- Dashboard budget-watch widget highlights near-limit and over-budget categories
- Personal expense/income analytics deliberately exclude transfers and money exchanged with people so debt tracking does not distort spending budgets
- Manual account expense/income entry supports categories directly
- Transaction history can filter by category, including uncategorized and archived historical categories
- Bank Feed review supports category selection and category-aware merchant/description rules
- Recurring account expense/income schedules support categories and revalidate them before posting
- Reports include personal category spending; PDF reports include a category-spending section
- Excel exports include **Categories**, **Budgets**, and **Spending** sheets plus a Category column in Transactions
- Block C migration can map exported Category names back to existing compatible categories; unknown categories safely import as uncategorized with a warning
- JSON backup restore preserves exact category IDs and monthly budgets atomically with the core ledger
- Older JSON backups without category metadata remain restorable and receive the default category set
- Ledger reset also removes recurring schedules, Bank Feed data, custom categories, and budgets, then reseeds defaults
- Category/budget APIs remain CSRF-protected and isolated per user
- Block G modules are included in the PWA offline shell

## Ledger rules

- Positive personal balance: they owe you
- Negative personal balance: you owe them
- Account balances start at opening balance and then move through ledger transactions
- Transfers affect accounts only, never a person's balance
- Account expenses reduce the linked account without changing a person's balance and may count toward a category budget
- Account income increases the linked account without changing a person's balance
- Budgets and spending insights count only account expense/income entries; person debt flows and transfers are excluded
- A split purchase reduces the source account by the transaction total exactly once

## Run locally

Requires Node.js 22.13+.

```bash
npm test
npm start
```

Then open `http://localhost:4173`.

## Tests

```bash
npm test                 # Full suite
npm run test:lane-d      # Lane D release gate
npm run accounting:check # Money, ledger, migration, reporting, Wave 0, PDF and XLSX regressions
```

The automated suite covers core ledger math, exact-money storage, account-only income/expenses, categories/budgets, recurring schedules/reminders, Bank Feed import/history/undo, full backup/restore, session lifecycle, security-event behavior, cross-site mutation rejection, runtime diagnostics, server snapshots, PWA install/offline/update contracts, reporting/PDF/XLSX round-trips, imports, attachments, user isolation, and production release regressions.

## Render

`render.yaml` defines a Node web service with a persistent disk mounted at `/var/data` for the SQLite database. The health endpoint is `/api/health`.

## Lane C — Resilience, security & operations

- PWA cache v9 with install/update handling, offline shell fallback, online/offline state, and update-safe cache headers
- Controlled service-worker upgrades with automatic reload after activation
- Same-origin Fetch Metadata and Origin enforcement layered on top of CSRF
- Security event history with sensitive-field filtering and 90-day retention
- Active-session visibility plus individual non-current session revocation
- Cross-origin opener/resource response hardening and CSP worker/manifest directives
- Per-request UUID tracing for server errors
- SQLite quick-check / foreign-key diagnostics in health
- Owner-only operational diagnostics and verified server snapshots
- Graceful SIGTERM/SIGINT shutdown with WAL checkpointing
- `LANE_C_READY` startup readiness marker and Lane C health versioning

## Still outside current scope

Live bank-provider connections (OAuth/open-banking APIs), background provider syncing, and provider-specific credential management remain outside the current scope. The current app supports statement-file ingestion, automatic classification/category rules, review-before-post, budgets, and personal cash-flow insights without storing bank credentials.


## Lane D — final quality and scale closure

Lane D completes Waves **11, 12, and 15**: accessibility/interaction hardening, scale/data-lifecycle hardening, and release/QA closure.

Highlights:
- keyboard and screen-reader navigation, focus-safe dialogs, labelled form controls, visible focus, reduced-motion support;
- coherent storage and complete-backup limits from one shared contract;
- Bank Feed full-table reconciliation totals and transactional scale limits;
- Bank Feed pagination, posted-row revalidation, and transfer-link disambiguation;
- bounded recurring/import history and continuously enforced security-event retention;
- PWA cache v11 with reliable stale-while-revalidate updates;
- ETag/304 static delivery;
- dedicated Lane D regression and release gates in CI.

See `docs/LANE_D_WAVES_11_12_15.md` for the full contract and release checklist.
