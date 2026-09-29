# 100/100 Release Program — Wave 0 Baseline

Baseline date: 2026-09-29

## Release freeze

The project is now in release-finalization mode.

Until Wave 15 is complete:
- no new product features;
- allowed changes are bug fixes, test repairs, release hardening, accessibility, performance, recovery, production verification, and documentation required by the 100/100 program;
- every discovered defect must be assigned to a numbered wave below before work starts;
- main is not considered releasable while any required release gate is red.

At the Wave 0 baseline there were no open pull requests.

## Source and production baseline

Repository: Hassan-Merhi/Money-Tracker
Branch: main
Baseline source commit: cafd8971496b0c2ca04f6f438ee10a38cd983d3e
Commit message: Prevent stale mixed-version Activity assets

Production Render service:
- name: money-owed-tracker
- service id: srv-dat92be0tbcc73achnf0
- branch: main
- auto deploy: enabled on commit
- region: Frankfurt
- runtime: Node
- persistent disk: /var/data, 1 GB
- public URL: https://money-owed-tracker.onrender.com
- live deploy at baseline: dep-datu5onkbs3c73ca9a9g
- live deploy commit: cafd8971496b0c2ca04f6f438ee10a38cd983d3e
- production commit matched GitHub main at baseline
- startup logs reported EXACT_MONEY_READY and LANE_A/B/C/D_READY
- production served the current activity-v2 assets successfully to an iPhone Safari client after deployment

Production configuration drift discovered in Wave 0:
- render.yaml declares healthCheckPath /api/health, but the live Render service configuration currently reports an empty health-check path.
- package.json requests Node >=22.13 <23; Render selected Node 22.23.3, which satisfies the declared range.

## Current release-gate baseline

Latest GitHub Actions run at baseline:
- workflow: Money Tracker CI
- run id: 36595734505
- result: failed
- tests: 237
- passing: 228
- failing: 9

The failing tests are recorded below. Wave 0 classification is based on the current source and the recent intentional product changes. Wave 1 owns the actual fixes and must prove the classification by returning the complete gate to green.

| ID | Failing check | Baseline diagnosis | Owner wave |
| --- | --- | --- | --- |
| CI-001 | dashboard assets are local, loaded last, and included in the upgraded offline shell | stale assertion expects PWA cache v13; service worker is v15 | Wave 1 |
| CI-002 | dashboard mounts both widgets only in Advanced mode with a revision-safe state replacement | stale exact-markup assertion; Dashboard structure changed and the Simple-mode Advanced teaser was intentionally removed | Wave 1 |
| CI-003 | transactions page preserves category filters and defaults date filtering to this month | behavior is present; assertion still looks for the old mobile-table CSS selector in mobile.css while Activity now has dedicated activity.css | Wave 1 |
| CI-004 | recurring widget shows due/overdue items and posts with the mounted revision, then refreshes on conflict | test fixture omits settings.timezone required by current timezone-aware recurring UI | Wave 1 |
| CI-005 | service worker forces Lane A client refresh and caches exact-money dependency | stale assertion expects PWA cache v13; service worker is v15 | Wave 1 |
| CI-006 | Lane B client has persisted modes and no hard-coded debt-only flag | stale assertion requires “Enable Advanced mode”; product requirement now keeps mode switching in Settings only | Wave 1 |
| CI-007 | current PWA cache includes the Lane C resilience controller and core finance modules | stale assertion expects PWA cache v13; service worker is v15 | Wave 1 |
| CI-008 | Lane D PWA v13 keeps stale-while-revalidate work alive | stale assertion expects PWA cache v13; service worker is v15 | Wave 1 |
| CI-009 | reportingSnapshot leaves every spend, income, person and monthly figure untouched | stale reporting contract still expects monthly; reporting now exposes receivablesMovement, cashFlow, and transferFlow separately | Wave 1 |

Additional release drift assigned during Wave 0:
- REL-001 — PWA version metadata is inconsistent: service-worker.js uses money-tracker-debt-v15, README says v13, and /api/health currently reports pwaCacheVersion 11. Owner: Wave 1 and Wave 5.
- REL-002 — live Render health-check path differs from render.yaml. Owner: Wave 13.
- REL-003 — main is deployable while CI is red. Release process must prevent treating a red build as a release candidate. Owner: Wave 1 and Wave 15.

## UI route inventory

Routing is hash-based.

Simple mode routes:
- #dashboard
- #people
- #person?id=...
- #transactions
- #reports
- #settings

Advanced mode adds:
- #accounts
- #bank
- #insights
- #scheduled

Advanced mode still includes the Simple routes. The app redirects Advanced-only routes back to Dashboard when Simple mode is active.

PWA:
- start route: /#dashboard
- shortcuts: Dashboard, Transactions/Activity, Reports
- display mode: standalone

## API inventory

Public/runtime:
- GET/ANY /api/health
- GET /api/auth/status
- POST /api/auth/register
- POST /api/auth/login

Authenticated identity/session:
- GET /api/auth/me
- GET /api/auth/sessions
- DELETE /api/auth/sessions/:id
- POST /api/auth/sessions/revoke-others
- POST /api/auth/logout
- POST /api/auth/password
- GET /api/security/events
- DELETE /api/account

Owner-managed users:
- GET /api/users
- POST /api/users
- POST /api/users/:id/password
- DELETE /api/users/:id

Ledger/settings:
- GET /api/state
- PUT /api/state
- POST /api/state/reset
- PUT /api/settings

People:
- POST /api/people
- PUT /api/people/:id
- DELETE /api/people/:id

Accounts:
- POST /api/accounts
- PUT /api/accounts/:id
- DELETE /api/accounts/:id

Entries:
- POST /api/entries
- PUT /api/entries/:id
- DELETE /api/entries/:id

Attachments:
- GET /api/attachments
- POST /api/attachments
- GET /api/attachments/:id
- DELETE /api/attachments/:id

Recurring schedules:
- GET /api/recurring
- POST /api/recurring
- PUT /api/recurring/:id
- DELETE /api/recurring/:id
- POST /api/recurring/:id/post
- POST /api/recurring/:id/skip
- GET /api/recurring/reminders
- POST /api/recurring/reminders/:id

Categories and budgets:
- POST /api/categories
- PUT /api/categories/:id
- POST /api/categories/:id/archive
- POST /api/categories/:id/restore
- POST /api/budgets
- DELETE /api/budgets/:id

Bank Feed:
- GET /api/bank-feed
- POST /api/bank-feed/import
- POST /api/bank-feed/:id/post
- POST /api/bank-feed/:id/undo
- POST /api/bank-feed/:id/ignore
- POST /api/bank-feed/:id/reopen
- DELETE /api/bank-feed/:id
- POST /api/bank-rules
- DELETE /api/bank-rules/:id

Imports/backups/operations:
- POST /api/import/xlsx/preview
- GET /api/backup/full
- POST /api/backup/full/restore
- POST /api/backup/restore
- GET /api/ops/status
- POST /api/ops/snapshot

Unknown /api paths return 404.

## Critical workflow inventory

These are the workflows that must remain represented through the remaining release waves:

1. Registration, login, logout, password change, session revocation, secondary-user lifecycle, self-account deletion.
2. Create/edit/delete person, opening debt balance, money owed to me, money I owe, repayments, borrowing, paybacks, person adjustments.
3. Person statement search, running balance, edit/delete transaction, statement PDF.
4. Create/edit/delete account, account opening balance, account income/expense, account adjustment.
5. Same-currency and cross-currency transfers.
6. Split purchases across multiple people with optional account charge and notes.
7. Receipt/file attachment upload, open, delete, ownership isolation, orphan cleanup.
8. Activity filtering by type, person, category, and date presets including This month and custom dates.
9. CSV/XLSX import preview, mapping, legacy workbook import, quick spreadsheet paste, duplicate handling, re-import.
10. Bank statement ingestion, review, classification, merchant/category rules, post/undo/ignore/reopen, transfer linking, reconciliation.
11. Recurring schedules, reminders, post/skip/pause/resume/edit/delete, timezone behavior.
12. Categories, budgets, spending insights, monthly trends.
13. Reports, person/account/date/category filters, PDF export, XLSX export, re-import of exported workbooks.
14. Simple/Advanced mode switching with hidden financial data preserved and Advanced controls hidden in Simple mode.
15. Complete backup/restore, database snapshot/restore, corruption rejection, recovery limits.
16. PWA install, offline shell, reconnect, update activation, stale-cache replacement.
17. Security events, operational diagnostics, request tracing, graceful shutdown/startup, persistent-disk survival.

## Release-wave ownership

Wave 1 — CI and release gate
- owns CI-001 through CI-009
- owns REL-001 test/metadata cleanup
- adds a hard green-gate expectation for release candidates

Wave 2 — Simple Mode mobile
- Dashboard, People, Person statement, Activity, Reports, Settings, Auth, transaction modals

Wave 3 — Advanced Mode mobile
- Accounts, Transfers, Bank Feed, Insights/Budgets, Scheduled, Advanced reporting/import/reconciliation

Wave 4 — Desktop/tablet polish
- responsive and visual consistency outside phone widths

Wave 5 — PWA/cache integrity
- owns the runtime side of REL-001
- one authoritative cache/build version and update contract

Wave 6 — Ledger/accounting audit
- all balance-changing workflows and cross-surface tie-outs

Wave 7 — Import/export torture tests
- import variants, duplicate semantics, malformed input, round trips, PDF/XLSX

Wave 8 — Security/destructive actions
- auth/session/CSRF/origin/isolation/destructive confirmation

Wave 9 — Backup/recovery
- full restore, snapshots, corruption/interruption/data-loss scenarios

Wave 10 — Browser E2E
- critical real-browser workflows in desktop and mobile viewports

Wave 11 — Accessibility
- keyboard, focus, labels, contrast, reduced motion, touch targets

Wave 12 — Performance/scale
- large realistic datasets and storage limits

Wave 13 — Production smoke/deployment
- owns REL-002
- health check, live build SHA, startup and safe production smoke checks

Wave 14 — Final page-by-page visual audit
- mobile/tablet/desktop, themes, empty/populated/error/loading/long-content states

Wave 15 — Release candidate
- owns REL-003
- no known P0/P1/P2 issues, all gates green, production verified, final sign-off checklist complete

## Wave 0 exit gate

- [x] Feature freeze defined.
- [x] Current main commit recorded.
- [x] Current production service and live commit recorded.
- [x] Production commit confirmed to match baseline main.
- [x] Current CI result and every failing test recorded.
- [x] Every current CI failure assigned to Wave 1.
- [x] UI routes inventoried.
- [x] API surface inventoried.
- [x] Critical user workflows inventoried.
- [x] Additional production/release drift recorded and assigned.
- [x] Remaining work mapped to Waves 1–15.
- [x] No open PRs existed at the baseline.

Wave 0 is complete when this document is merged to main.