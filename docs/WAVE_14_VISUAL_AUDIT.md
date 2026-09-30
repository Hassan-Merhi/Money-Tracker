# Wave 14 — Final page-by-page visual audit

Wave 14 is the final visual QA gate for Money Tracker.

## Required matrix

The automated browser audit covers the application at:

- phone: 390 × 844
- tablet: 834 × 1112
- desktop: 1440 × 1000
- light theme
- dark theme
- empty advanced workspace
- populated/extreme workspace

The populated workspace deliberately contains long names, long merchant/notes, very large values, multiple currencies, multiple accounts, current transactions, budgets, schedules, Bank Feed rows and a long person statement.

## Screens

The matrix captures and validates:

- authentication
- Dashboard
- People
- Person statement
- Accounts & Cash
- Transactions
- Bank Feed
- Insights & Budgets
- Scheduled & Reminders
- Reports & Exports
- Settings

## State and overlay coverage

Wave 14 also captures:

- loading and error states for async feature pages
- quick-add dialog
- transfer dialog
- add-person dialog
- account-detail dialog
- recurring-schedule dialog
- report export menu
- transaction row menu
- mobile More navigation
- import dialog

Every capture is checked for page-level horizontal overflow, card/panel overflow, viewport containment of dialogs/menus and dark-theme surface parity. Screenshots are retained by CI as the `wave14-visual-audit` artifact for review.

## Visual fixes included

The closure stylesheet intentionally loads last and normalizes visual behavior across feature modules. It fixes mobile dark-mode surfaces that still inherited hard-coded light backgrounds, contains long/extreme financial values, prevents overlays and menus from escaping the viewport, and lets dense action groups wrap instead of squeezing or forcing page-level horizontal scrolling.
