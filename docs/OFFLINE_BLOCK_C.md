# Offline Block C — Conflicts, tombstones, atomic transfers and attachments

Offline Block C completes O7–O10 on top of the O4–O6 durable outbox.

## O7 — Conflict handling

Every queued ledger operation now stores the record it was based on (`baseRecord`) plus its local result. When a push receives a stale-revision 409, the client fetches the authoritative server ledger and compares the affected record:

- if that record itself did not change, the whole queued ledger is safely rebased onto the new server revision and sync retries automatically;
- if the same record changed, the operation becomes an explicit `conflict` with the base, local and server versions retained;
- Settings shows per-conflict **Keep mine** and **Use server** controls;
- Keep mine rebases the local branch on the current server record;
- Use server drops the conflicted operation and later queued operations for that same record, then rebuilds the local ledger from the server plus the remaining queue.

Unrelated queued operations keep their order and are not silently discarded.

## O8 — Tombstone deletes

IndexedDB schema v3 adds a `tombstones` store. Local deletes write a tombstone in the same read/write transaction that removes the visible record and appends the sync operation.

The server adds `sync_tombstones` keyed by user/entity/id. Deletes through both normal API routes and sync routes record the server revision. A deleted UUID cannot be silently recreated by a rebased stale operation; it becomes a conflict instead.

Pulled remote deletes are also stored as local tombstones so deletion state survives offline convergence until the next authoritative full snapshot.

## O9 — Atomic offline transfers

Account transfers are no longer a special online-only path. A transfer is one `entry` operation containing both source and destination amounts/accounts.

- local transfer create/update/delete is one IndexedDB transaction and one queued ledger revision;
- server sync applies the transfer in one SQLite `BEGIN IMMEDIATE` transaction;
- balance changes remain derived from the single transfer entry, so there is no possible “source posted / destination missing” half-transfer state;
- the same operation-id idempotency protection from O6 applies to transfer retries.

## O10 — Offline attachments

IndexedDB schema v3 also adds:

- `attachments` — metadata plus local file data for offline-created/cached files;
- `attachmentQueue` — a separate idempotent file outbox.

Attachments deliberately do not consume ledger revisions. Ledger operations sync first; attachment operations run only after the ledger queue is clear, which lets a file safely depend on a transaction created offline in the same session.

Offline attachment behavior:

- adding a file stores it locally immediately and increments the cached transaction attachment count;
- locally stored files remain openable offline through a data URL;
- deleting an attachment is queued locally and decrements the cached count;
- deleting a locally pending attachment replaces its create with an idempotent delete, because a lost response may mean the server already committed the upload;
- attachment operations survive reload, participate in logout/account-switch data-loss protection, and retry idempotently;
- the server uses the same processed-operation table to prevent duplicate file writes after lost responses.

Existing server-only attachments have their metadata cached when listed online. Their binary content still requires a connection unless the device already has a local copy.

## Safety boundaries

Bank Feed and Scheduled/Reminders remain server-only offline. Conflict resolution requires a connection because it must compare against the current authoritative server state.

## Definition of done

Block C is complete when:

- unrelated remote edits auto-rebase queued changes;
- same-record edits produce a visible, resolvable conflict;
- keep-mine and use-server converge without losing unrelated queued work;
- local and remote deletes preserve tombstones and cannot be resurrected by stale UUID reuse;
- transfer create/update/delete work offline and converge atomically;
- lost transfer responses do not duplicate money movement;
- attachment create/delete work offline, survive reload and sync after their transaction;
- lost attachment responses are idempotent;
- logout/account switching cannot discard queued attachments;
- Block A and Block B contracts remain green;
- dedicated server, browser and CI gates cover O7–O10.
