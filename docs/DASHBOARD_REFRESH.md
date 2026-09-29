# Responsive dashboard refresh

## What changed

- Teal-accented light and dark palettes, consistent local SVG icons, quieter borders,
  and clearer typographic hierarchy throughout the navigation shell.
- Three currency-separated debt summary cards. On phones, the net card spans the
  row below the two directional balances.
- Six recent debt entries in a responsive list instead of a horizontally scrolling
  table. Each row opens the existing transaction editor; dates, types, split
  participants, and attachment counts remain available.
- Outstanding people overview: up to four people alphabetically, with a total count
  and access to the full People page. Opposing balances in different currencies
  remain separate; there is no cross-currency ranking or conversion.
- Existing six quick actions, plus empty-state guidance for both new ledgers and
  ledgers that already have people.
- Five mobile navigation targets. Advanced mode uses a focus-managed **More** dialog
  for Bank Feed, Insights, Scheduled, Reports, and Settings. The sticky header keeps
  Add activity reachable without a floating button obscuring content.
- Existing skip link, route focus, visible focus rings, keyboard shortcuts, reduced
  motion, and modal focus handling are preserved.
- PWA shell v13 caches the new assets. No backend/schema changes or runtime packages.

`dashboard.css` is loaded after feature styles. It contains shared shell/palette
updates and dashboard-scoped presentation. `lib/dashboard-ui.js` contains pure,
unit-tested markup and navigation helpers; ledger math stays in `lib/ledger.js`.

## Validation performed

- `npm test`: 170 passing tests, including seven new dashboard regressions covering
  navigation, debt-only recent activity, ordering/limits, escaping, splits,
  multi-currency balances, and offline asset inclusion.
- `node --check app.js` and `git diff --check`.
- Real Chromium browser checks with Playwright against an isolated local database:
  - Dashboard at 320, 375, 390, 760, 768, 1024, 1440, and 1920 CSS pixels.
  - Light/dark screenshots, empty and populated ledgers.
  - Editing a recent entry, creating a debt, creating a person, and opening a statement.
  - Switching to Advanced mode, all five More destinations, Escape dismissal, and
    focus restoration to the More trigger.
  - Long person names/descriptions, large balances, multiple currencies, and negative
    net positions without page-level horizontal overflow.
  - Axe WCAG 2 A/AA and 2.1 AA scans at 390px and 1440px in both themes: zero violations
    on the populated dashboard.
  - No uncaught browser errors during these flows.

Browser tooling and fixture data were temporary and are not runtime dependencies.
These checks used Chromium, not physical iOS/Android devices or Safari.

## Reviewer checklist

1. Run `npm start`, sign in, and open the dashboard in Simple mode.
2. Check an empty ledger, then add people, debts, and repayments. Confirm dashboard
   amounts match the person statements. Add a second currency; it must not be merged.
3. Click a recent row and save an edit. Try all six quick actions and the N shortcut.
4. Resize to a phone width; there should be no horizontal dashboard scrolling and
   navigation/Add should remain reachable while scrolling.
5. Enable Advanced mode. On mobile, use More to reach every additional destination;
   close it with Escape and verify focus returns to its trigger.
6. Switch Appearance among Light, Dark, and System in Settings. Check keyboard focus
   and narrow screens with a long name/large balance.
7. For an already-installed PWA, accept the Update app prompt and verify that the new
   stylesheet/module are included in the offline shell. Financial writes still need
   a connection; the refresh does not introduce offline financial data storage.
