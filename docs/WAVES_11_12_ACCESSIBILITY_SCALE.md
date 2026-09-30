# Release Waves 11–12 — Accessibility and Scale Completion

Date: 2026-09-30

## Wave 11 — Accessibility

The release audit rechecked the current post-security/recovery UI rather than relying only on the earlier Lane D pass.

### Defects found and fixed

1. The standalone Excel/CSV importer used modal semantics but did not provide a programmatic dialog name, focus trap, Escape handling, or focus return.
2. Import mapping labels were visually present but not explicitly associated with their select controls.
3. The quick-paste input and dynamic importer status needed explicit accessible naming/live announcements.
4. The light-theme positive-state green was only about 3.38:1 against white, below the 4.5:1 WCAG AA target for normal text.

### Completed accessibility contract

- main app and importer dialogs are named with `aria-labelledby`;
- dialogs trap Tab/Shift+Tab, close with Escape, and restore focus to the invoking control;
- importer mapping labels use `for`/ID associations;
- non-visible-context importer controls have explicit accessible names;
- importer preview/status regions announce changes politely;
- positive-state text uses a darker light-theme green that exceeds 4.5:1 on white and the positive pill background;
- existing skip link, page-heading focus, live toasts, visible focus rings, coarse-pointer targets, and reduced-motion behavior remain covered.

## Wave 12 — Performance / scale

### Defects found and fixed

1. `accountBalances()` recomputed every ledger entry once for every account. At the declared limits this could mean roughly 50 million account/entry checks for one balance refresh.
2. Editing one transaction called `loadState()` just to find that entry, duplicating a full-ledger load before the mutation.
3. `PUT /api/state`, which is still used by bulk import flows, inherited the historical 1 MB generic request limit even though the supported ledger ceiling is 50,000 entries.

### Completed scale contract

- account balance recomputation is now O(accounts + entries) and traverses the ledger once;
- a dedicated `entryById` query resolves the transaction being edited without loading the whole state first;
- bulk state writes use a dedicated 64 MB ceiling, while complete backup restore retains its larger 256 MB ceiling;
- the existing bounded storage limits remain authoritative: 10,000 people, 1,000 accounts, 50,000 entries, 10,000 attachments / 100 MB, 500 recurring rules, 50,000 Bank Feed rows, and related history caps;
- Bank Feed list rendering remains paginated while aggregate status/account statistics query the full table.

## Release gates

Wave 11 and Wave 12 are complete only when:

- the dedicated `npm run test:wave11-12` gate passes;
- the full repository test suite remains green;
- Lane D and accounting reconciliation gates remain green;
- JavaScript syntax checks remain green;
- the exact PR head passes CI;
- the merged `main` commit passes CI again.
