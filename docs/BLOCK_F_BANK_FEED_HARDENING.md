# Block F — Bank Feed hardening (posted-row revalidation, transfer disambiguation, inbox scale)

Three defects in the Bank Feed review inbox are closed here. They are independent of each
other, but together they make the inbox trustworthy at the size people actually import.

## A4 — A posted feed row stops matching its entry after an edit

Posting a feed row writes `status='posted'` and `posted_entry_id`, and creates one ledger
entry. Until now nothing re-checked that pair: editing the transaction through
`PUT /api/entries/:id` only touched the `entries` row, so a $45 feed row stayed "posted"
against a $60 ledger entry, and the POSTED counter kept claiming a match that no longer
existed. `reopenOrphans` only ran on delete.

`lib/bank-server.js` now exposes `revalidatePosted(userId, entryId)`. For every feed row
posted from that entry it recomputes the expected signed minor amount:

| Entry | Expected on the feed row's account |
| --- | --- |
| `account_expense`, `paid_for_person`, `paid_to_person`, `split_paid_for_people` | negative `amount_minor` |
| `account_income`, `received_from_person`, `borrowed_from_person` | positive `amount_minor` |
| `account_transfer` | negative `from_amount_minor` on `from_account_id`, positive `to_amount_minor` on `to_account_id` |

It also compares `account_id`, `currency`, and `txn_date` against `entry.date`. Any row that
no longer agrees goes back to `status='pending'` with `posted_entry_id=NULL`, and the
reopened ids are returned.

`server.mjs` calls it inside the same `withLedgerMutation` transaction as
`updateLedgerEntryRow`, so a row can never be left posted against a half-written entry, and
adds `reopenedFeedItems` to the response. `app.js` turns that count into the toast
"Bank Feed row reopened - the posted amount no longer matches this transaction."

Editing only the description or merchant keeps the row posted; changing the amount,
reclassifying expense to income, or moving the entry to another account reopens it.

## B1 — Transfer auto-linking could drop a ledger movement

`existingTransferFor` matched any posted row on the target account with the opposite sign,
the same currency, and a date within ±3 days, and linked to the first hit. Description was
ignored and ambiguity was never resolved, so two distinct same-amount transfers posted on
the same day could collapse into one movement — a ledger entry the user cannot recover.

Two changes:

1. **Text gate.** The merchant/description of both statement sides is normalized
   (lower-cased, non-alphanumerics collapsed). They must agree by containment or by at least
   50% token overlap of the smaller side, counting words of four characters or more
   ("transfer to cash" and "transfer from bank" share "transfer", which is 1 of 2 tokens).
2. **Ambiguity is not guessed.** If more than one candidate passes the gate,
   `existingTransferFor` returns `null` so the review creates a new transfer, and the
   ambiguity is logged.

Trade-off, deliberately: a duplicate movement is visible and recoverable through Undo,
while a silently merged movement is not. Creating the extra movement is therefore the safe
failure mode.

## A5 — The inbox cannot be reconciled at scale

`q.items` used a fixed `LIMIT 5000`, `DATA_LIMITS.bankFeedItems` is 50,000, and there was no
way to reach a row past the cut. The Lane D scale contract freezes the *totals* as full-table
aggregates, so only the item list paginates:

- `lib/bank-server.js` parameterizes the item query with `LIMIT ? OFFSET ?` and accepts a
  `status` filter. `list(userId,{status,limit,offset})` clamps an explicit page to 1–500
  rows and returns `page:{limit,offset,returned,total}` from a separate count query.
  A client that asks for no page still receives the historical 5,000-row window, which keeps
  the Lane D scale assertion (`items.length === 5000` while `stats.pending === 5001`) green.
- `GET /api/bank-feed` reads `status`, `limit`, and `offset` from the query string;
  `lib/store.js` `listBankFeed(params)` forwards them.
- `block-f-bank-feed.js` renders a pager (Prev/Next plus "showing X-Y of N") that operates
  inside the active status tab, and a reconciliation panel.
- `lib/bank-feed.js` exports the pure `reconcileFeed(items, entries, accounts)` used by that
  panel. It accepts either raw feed rows or the per-account aggregates the API returns, and
  returns one row per account reporting: imported rows, pending/posted/ignored, the signed
  posted total, the ledger movements, the difference, and whether the account balances. The
  opening balance is excluded and a transfer counts on both of its accounts.

With A4 in place, the posted total for an account equals that account's ledger movements
whenever every movement came from a statement, which is exactly the invariant the panel
surfaces.

## Gates

- `npm test` and `npm run test:lane-d` cover the three fixes: posted-row revalidation
  (amount edit, description-only edit, expense→income reclassification, transfer legs),
  the two-distinct-transfers and ambiguous-match transfer cases, and pagination plus
  `page.total` against the full-table stats.
- `npm run accounting:check` (new, also in CI) boots a throwaway ledger through the real API
  and asserts the money invariants end to end: integer minor-unit storage, one movement per
  transfer, feed posted totals equal to ledger movements, reopening on edit, and every
  pending row reachable through the pager.
