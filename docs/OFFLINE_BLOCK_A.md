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
- Scheduled/recurring rules and reminder inbox *(Block A boundary; superseded by Wave 100B offline schedules/reminders)*
- authentication changes and password operations
- user/session/security administration
- server snapshots and recovery operations
- cloud attachment download/upload
- remote production/runtime diagnostics

At the Block A milestone, Bank Feed and Scheduled pages showed explicit connection-required panels. Wave 100A later made Bank Feed offline-capable, and Wave 100B later made Scheduled & Reminders offline-capable.

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
- complete transitive client module graph included in the precached shell
- IndexedDB module included in the precached shell
- API routes excluded from Cache Storage so private ledger responses are not cached as generic HTTP assets

PWA cache version for this block: **22**.

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

Only one active user's offline ledger is retained. Signing in as a different user clears the previous local ledger before saving the new identity. Snapshot writes carry the request-time user identity and are rejected if the active offline identity changed before the response completed, preventing stale cross-tab responses from crossing user boundaries.

Logout, confirmed account deletion, and authenticated 401 responses clear only the matching user's local offline data. Identity-checked clearing prevents a stale tab from wiping a newer user's offline cache.

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
- [x] PWA launches from the cached application shell, including a cold second launch with the network already unavailable.
- [x] Install metadata includes desktop/mobile/iOS essentials.
- [x] Core authenticated ledger is written to IndexedDB.
- [x] Offline boot can recover the authorized identity without storing credentials.
- [x] Offline boot can reconstruct core ledger state.
- [x] Core financial views render from local data.
- [x] Balances remain derived; no independent cached balance becomes authoritative.
- [x] Server-only pages are explicit instead of failing ambiguously.
- [x] Offline writes are blocked until the sync/outbox phases.
- [x] Local data is cleared on logout, account deletion and any authenticated 401 without crossing active-user boundaries.
- [x] Stale state responses cannot overwrite another user's active offline snapshot.
- [x] Automated checks verify every relative dependency in the cached client module graph is precached.
- [x] Automated contract tests cover O0–O3.
