# Offline Block D — O11–O15

Offline Block D completes the runtime safety and recovery layer on top of Blocks A–C. The server remains authoritative; the browser owns only a bounded offline authorization, durable local working copy, queues, and recovery metadata.

## O11 — Offline authentication and security

- A successful online `/api/auth/me`, login, or registration refreshes the device's offline authorization timestamp.
- Offline authorization expires after **7 days** without an online verification.
- When the lease is expired, the cached ledger is preserved but is not opened. The user must reconnect and authenticate before offline access resumes.
- Passwords, CSRF tokens, and server session cookies are never written to IndexedDB.
- An authenticated server 401 still clears safe cached data when no unsynced changes exist, while queued work is preserved for re-authentication.
- Cross-user switching remains blocked while another account owns unsynced changes.

## O12 — Persistent browser storage

`lib/pwa.js` reports Storage API support, persistence state, estimated usage/quota, and storage pressure.

Settings exposes **Protect offline storage** when persistence is supported but not granted. The request is made from a user gesture. Browsers that do not grant persistence continue in best-effort mode without breaking connected operation.

## O13 — Sync UX

Settings shows:

- online/offline state;
- queued, failed, and conflicted operation counts;
- last successful sync time;
- offline authorization status and expiry;
- persistent-storage state and approximate quota use;
- Background Sync support/fallback state.

**Sync now** is available whenever online, even when the queue is empty, so it can also pull a newer server revision.

## O14 — Sync recovery

Recovery is explicit and data-loss resistant:

- failed (non-conflict) ledger and attachment operations can be reset to pending and retried;
- conflicts retain the O7 explicit resolution flow;
- users can export a private JSON recovery file before destructive discard;
- recovery exports include the current offline snapshot, ledger queue, attachment queue (including pending attachment payloads), tombstones, authorization metadata, and sync metadata;
- discard remains an explicit destructive action and reloads the authoritative server copy.

The recovery export does not contain passwords, CSRF tokens, or session cookies.

## O15 — Manual, reconnect, resume, and background sync

Sync is single-flight in `lib/store.js`: concurrent callers share one in-flight run, preventing duplicate foreground/reconnect/focus work.

Guaranteed foreground triggers:

- manual **Sync now**;
- browser `online`;
- app `pageshow`;
- window focus;
- visibility returning to visible.

Where the Background Sync API exists, Money Tracker registers `money-tracker-sync`. The service worker authenticates with the existing same-origin session, keeps the returned CSRF token only in worker memory, and can push pending ledger and attachment operations directly from IndexedDB even when no app window is open. It stops on stale/conflicted work so the foreground O7 resolver can make the decision, and signals any open clients after completion. Platforms without Background Sync use the foreground resume triggers above.

All retry paths keep O6 idempotency keys and O7 conflict detection intact.

## Definition of done

Block D is complete when all of the following are green:

- stale offline authorization refuses ledger access without deleting the cached ledger;
- re-authentication refreshes offline authorization;
- persistent-storage state and request UX work without becoming a connected-mode dependency;
- sync status exposes pending/failed/conflict counts and last-success time;
- retry/export/discard recovery paths are available;
- multiple resume signals cannot create parallel sync runs;
- reconnect/resume drains a valid queue;
- service-worker sync hooks can drain safe queued writes without an open window and still never cache authenticated API responses;
- Offline Blocks A–C remain green;
- full accounting, release, browser, visual, post-merge CI, and production smoke gates pass.
