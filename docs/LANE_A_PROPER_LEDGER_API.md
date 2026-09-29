# Lane A — Proper Ledger API

## Status target

Lane A replaces full-ledger rewrites for normal day-to-day edits with row-level, revision-safe API mutations.

The legacy `PUT /api/state` endpoint remains available only for intentional bulk workflows such as spreadsheet import compatibility and backup restore. Ordinary UI actions do not use it.

## Atomic API

All mutation routes require authentication, CSRF protection, and `expectedRevision`.

### Settings

- `PUT /api/settings`

Updates display/default-currency settings and bumps the ledger revision once.

### People

- `POST /api/people`
- `PUT /api/people/:id`
- `DELETE /api/people/:id`

Person creation can include an opening balance. The person row and optional opening adjustment are committed in one SQLite transaction and consume one ledger revision.

Deletion is rejected when transactions, split allocations, recurring rules, or Bank Feed data still reference the person.

### Accounts

- `POST /api/accounts`
- `PUT /api/accounts/:id`
- `DELETE /api/accounts/:id`

Account updates modify only the target account row. Currency is immutable after account creation. Deletion is rejected while transactions, recurring schedules, or Bank Feed data still reference the account.

### Entries / transfers

- `POST /api/entries`
- `PUT /api/entries/:id`
- `DELETE /api/entries/:id`

Transfers use the same entry API with `type: account_transfer`.

Entry validation reuses the authoritative exact-money and reference rules. Deletes also remove attachments for the deleted entry and reopen any Bank Feed item whose posted entry was removed.

## Concurrency contract

Every normal mutation sends the state version last read by the client as `expectedRevision`.

The server starts an immediate SQLite transaction, checks the current user revision, performs only the requested row mutation, increments the revision once, and commits.

A stale revision returns HTTP 409. The browser reloads current state instead of overwriting newer work.

## Bulk-write exceptions

These are intentionally still allowed to replace larger state sets:

- spreadsheet/legacy workbook import through `saveState`;
- JSON backup restore;
- full app-data reset;
- the legacy `PUT /api/state` compatibility endpoint.

They are not used by person/account/transaction/settings forms.

## Regression proof

Lane A tests install SQLite delete triggers on people, accounts, and entries. Creating or editing a person must leave those probes empty, proving normal edits no longer delete and reinsert unrelated ledger rows.

Additional coverage verifies:

- CSRF enforcement;
- stale-revision rejection;
- one revision bump per mutation;
- atomic person + opening balance creation;
- dependency-safe deletion;
- exact integer money storage through the new API;
- entry attachment cleanup;
- settings mutations without ledger rewrites;
- browser JavaScript syntax.

## Client cache

The service-worker cache version is bumped for Lane A and now explicitly caches `/lib/money.js`, ensuring the new atomic client and its exact-money dependency replace older cached application code.
