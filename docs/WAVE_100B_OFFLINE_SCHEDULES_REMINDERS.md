# Wave 100B — Offline Schedules & Reminders

Wave 100B removes the server-only offline boundary from **Scheduled & Reminders** while preserving the ledger as the only money authority.

## Offline cache

IndexedDB schema **v6** adds:

- `recurringState` — cached recurring rules, reminder inbox state and worker metadata;
- `recurringQueue` — durable recurring operations.

After Scheduled & Reminders has been opened successfully while connected, the device can reopen the page after a reload or cold PWA launch without a network connection.

## Local reminders

Reminder timing is calculated from the cached rule and the ledger timezone using the same recurrence rules as the server.

While offline, Money Tracker can:

- show due, overdue and upcoming reminder-window items;
- synthesize the deterministic reminder identity `reminder_<ruleId>_<occurrenceDate>`;
- dismiss a reminder locally and keep that dismissal queued;
- preserve the dismissal across reloads;
- reconcile the inbox with the server reminder worker after reconnect.

The server worker remains active while the app is closed and continues to be authoritative for synchronized reminder inbox state.

## Offline schedule actions

After the recurring cache exists on the device, these actions can be captured offline:

- create a schedule;
- edit a schedule;
- pause or resume a schedule;
- delete a schedule;
- skip the current occurrence;
- dismiss a reminder;
- queue **Post now**.

Create/edit/pause/resume/delete/skip/dismiss update the cached schedule/reminder view immediately.

## Money safety

**Post now never fabricates a local ledger transaction while disconnected.**

When an occurrence is posted offline:

1. the recurring post intent is written to `recurringQueue`;
2. the schedule is visibly marked **Queued: post**;
3. the cached ledger and balances remain unchanged;
4. reconnect sends the operation to `POST /api/sync/recurring`;
5. the server verifies the exact occurrence and ledger revision;
6. the operation may rebase the ledger revision once only if the recurring rule itself and occurrence are unchanged;
7. the server transaction creates one ledger entry, advances the rule and acknowledges the occurrence reminder atomically;
8. normal ledger pull/full-refresh updates the local snapshot.

If another device edits or advances that schedule occurrence, the queued operation becomes an explicit conflict instead of posting a duplicate.

## Idempotency and conflicts

Every recurring outbox row has an immutable operation ID. The server stores the request hash and accepted result in the existing `sync_operations` table.

- identical replay returns the original result;
- a posted occurrence cannot create two ledger entries;
- a reused operation ID with different data is rejected;
- update/delete/skip/post can use the server rule `updatedAt` as the conflict base;
- Settings exposes targeted **Use server** resolution for recurring conflicts;
- resolving one recurring conflict removes only that rule's related queued operations and preserves unrelated offline work.

## Background sync

The service worker may safely drain recurring operations that do not create ledger money:

- create;
- update;
- delete;
- skip;
- reminder acknowledgment.

A queued recurring **post** requests foreground sync instead. This guarantees the resulting ledger revision and transaction are pulled into the local ledger before the device reports itself fully synced.

## Recovery and account safety

Recurring outbox rows participate in:

- pending sync counts;
- logout protection;
- user-switch protection;
- destructive cache-clear protection;
- retry failed;
- recovery JSON export;
- explicit destructive discard.

No password, CSRF token, session cookie or server session secret is stored in recurring offline state.

## Production monitoring

`/api/health` publishes `offlineWave100BVersion: 1`.

Aggregate-only metrics add:

- `recurringAccepted`;
- `recurringReplayed`;
- `recurringConflict`;
- `recurringRejected`.

No schedule title, amount, rule ID, reminder ID, transaction description or user identity is exposed by sync telemetry.

## Definition of done

Wave 100B is complete when:

- schedules/reminders reopen from cache with the network disabled;
- due reminders are generated locally from the cached schedule and timezone;
- create/edit/pause/resume/delete/skip/dismiss survive offline reload;
- queued post survives reload and does not alter ledger balances early;
- reconnect advances the correct occurrence and posts exactly once;
- lost-response replay cannot duplicate a recurring ledger entry;
- stale schedule edits become explicit recurring conflicts;
- targeted conflict resolution preserves unrelated queued work;
- safe non-ledger recurring operations can drain through Background Sync;
- v5 → v6 migration preserves all prior offline stores and queues;
- recovery/logout/account-switch protections include recurring work;
- contract, server, browser, accounting, visual and production gates are green;
- production serves the exact green `main` SHA with `offlineWave100BVersion: 1`.
