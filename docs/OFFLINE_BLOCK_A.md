# Offline Block A — Foundation (O0–O3)

Status: implemented on the `offline-block-a` branch.

## Scope

Block A intentionally delivers **offline launch + offline reads** only. Financial writes remain server-authoritative until later sync blocks add an outbox, idempotency, conflict handling and atomic transfer synchronization.

```text
Online:
UI → server API → server DB
             ↘ write-through IndexedDB snapshot

Offline:
UI → IndexedDB snapshot

Writes while offline:
blocked with a clear read-only message
```

## O0 — API and data-path audit

### READ

These are safe to expose through a previously saved local snapshot.

| Area | Server source | Offline Block A source |
| --- | --- | --- |
| Signed-in identity | `GET /api/auth/me` | IndexedDB active-user metadata |
| Main ledger state | `GET /api/state` | IndexedDB normalized state |
| Dashboard | derived from `/api/state` | local people/accounts/entries |
| People | derived from `/api/state` | local people |
| Person statement | derived from `/api/state` | local entries + people |
| Accounts & balances | derived from `/api/state` | local accounts + entries |
| Activity / transactions | derived from `/api/state` | local entries |
| Insights | derived from `/api/state` | local entries/categories/budgets |
| Reports | derived from `/api/state` | local ledger snapshot |

### CREATE / UPDATE / DELETE

These remain online-only in Block A. They already pass through `lib/store.js`, which is the boundary later offline-write/sync work can replace without rewriting page components.

- settings
- people
- accounts
- entries / transactions / transfers
- categories and budgets
- recurring schedules
- bank-feed mutations
- attachments
- backup/restore/reset
- account and security changes

Core mutation handlers stop immediately when the browser is offline. This prevents a false-success UI before the sync/outbox layer exists.

### DERIVED

No independent balance values are cached or edited. These continue to be recalculated from ledger records:

- person balances
- account balances
- net position
- statement running balances
- dashboard totals
- reports
- budget/insight calculations

This preserves the ledger as the source of financial truth.

### SERVER-ONLY

These intentionally do not masquerade as offline-capable in Block A:

- Bank Feed imports and feed pagination
- Scheduled/recurring rules and reminder inbox
- authentication changes and password operations
- user/session/security administration
- server snapshots and recovery operations
- cloud attachment download/upload
- remote production/runtime diagnostics

Bank Feed and Scheduled pages show an explicit connection-required panel while offline.

## O1 — PWA foundation

Existing PWA infrastructure was retained and hardened instead of replaced.

Implemented:

- versioned service worker shell cache
- offline navigation fallback
- current-cache-only runtime reads
- explicit service-worker update activation
- manifest with standalone display and shortcuts
- 192×192 and 512×512 PNG install icons
- maskable SVG icon retained
- iOS installed-app metadata
- Apple touch icon
- IndexedDB module included in the precached shell
- API routes excluded from Cache Storage so private ledger responses are not cached as generic HTTP assets

PWA cache version for this block: **21**.

## O2 — Local database

`lib/offline-db.js` owns the local offline schema.

Database: `money-tracker-offline`  
Schema version: `1`

Stores:

- `meta`
- `people`
- `accounts`
- `entries`
- `categories`
- `budgets`

The active authorized user and the state head (settings, revision/version, snapshot timestamp and schema version) are stored as metadata. Core collections are stored separately rather than as one opaque blob so later sync blocks can add per-record status/version/outbox behavior without replacing the database.

Only one active user's offline ledger is retained. Signing in as a different user clears the previous local ledger before saving the new identity.

Logout, confirmed account deletion, and an online 401 clear the local offline data.

No password, CSRF token or server session secret is stored in IndexedDB.

## O3 — Offline reads

Successful authenticated server responses write through to IndexedDB.

At startup:

1. attempt `GET /api/auth/me`;
2. on a genuine network failure, use the previously authorized local user;
3. attempt `GET /api/state`;
4. on a genuine network failure, reconstruct the state from IndexedDB;
5. render the normal application from that state.

If the device has never completed an online authenticated load, offline startup fails safely with an instruction to reconnect once.

Available offline after at least one successful online load:

- Dashboard
- People
- Person statements
- Accounts
- Activity / transactions
- Insights and budgets (read-only)
- Reports derived from the cached ledger
- local navigation, theme, filters and searches

The UI displays **Offline · read only**. Financial mutations remain blocked until Offline Block B introduces durable local writes and a sync outbox.

## Definition of done

- [x] Existing network paths audited and classified.
- [x] PWA launches from the cached application shell.
- [x] Install metadata includes desktop/mobile/iOS essentials.
- [x] Core authenticated ledger is written to IndexedDB.
- [x] Offline boot can recover the authorized identity without storing credentials.
- [x] Offline boot can reconstruct core ledger state.
- [x] Core financial views render from local data.
- [x] Balances remain derived; no independent cached balance becomes authoritative.
- [x] Server-only pages are explicit instead of failing ambiguously.
- [x] Offline writes are blocked until the sync/outbox phases.
- [x] Local data is cleared on logout, account deletion and invalid online session.
- [x] Automated contract tests cover O0–O3.
