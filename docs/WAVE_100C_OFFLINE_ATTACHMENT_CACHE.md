# Wave 100C — Offline Attachment Cache

Wave 100C removes the remaining attachment-binary offline limitation without weakening attachment sync safety.

## Goal

Server attachments can be explicitly made available offline on a device. The server remains authoritative for the attachment itself; the device cache is only a local copy.

## IndexedDB v7

The offline database advances to **v7**. Existing attachment records are migrated in place without deleting data.

Attachment cache records track:

- `offlinePinned` — whether the user explicitly wants the file kept offline;
- `offlinePolicy` — `metadata`, `legacy`, `local`, or `pinned`;
- `cachedAt`;
- `lastAccessedAt`.

Unsynced/local-created files are classified as protected local copies. Existing synced binary rows from older versions become safe legacy cache rows and remain readable until explicitly removed or safely evicted.

## Save offline

When connected, a server attachment can be **Save offline**:

1. attachment metadata must already be cached for the signed-in user;
2. the binary is fetched from the authenticated attachment endpoint;
3. the normal 8 MB per-file limit is revalidated;
4. browser/device cache capacity is checked;
5. only safe unpinned server-backed cache rows may be evicted to create space;
6. the binary is persisted to IndexedDB with `offlinePinned: true`;
7. subsequent airplane-mode reloads can open the file from a local data URL.

## Remove offline copy

**Remove offline copy** removes only the device copy.

It does not:

- delete the server attachment;
- decrement the transaction attachment count;
- create a server sync operation.

The action is blocked when the file is still an unsynced local upload or its create operation is pending. Money Tracker will never discard the only known copy of an attachment.

## Cache safety and quota handling

The logical attachment cache limit is **100 MB per device user**, matching the server-side attachment storage ceiling.

Before pinning a new binary Money Tracker checks:

- current cached attachment bytes;
- safe evictable bytes;
- browser storage usage/quota when `navigator.storage.estimate()` is available.

Automatic cleanup may evict only rows that are all of the following:

- synchronized to the server;
- not pinned;
- not a protected local-created file;
- not referenced by a pending attachment create.

Pinned files and unsynced files are never auto-evicted.

Settings shows:

- cached attachment count;
- local attachment bytes;
- protected local-copy count;
- a bulk **Clear safe cached copies** action only when evictable bytes exist.

## Existing offline attachment behavior

Wave 100C preserves all Offline Block C guarantees:

- files created offline stay readable offline immediately;
- create/delete operations remain in the durable attachment outbox;
- attachment sync remains idempotent;
- a lost upload response cannot create duplicates;
- logout/account switching/destructive clearing cannot discard queued attachment work;
- attachment deletes still converge through tombstones/idempotent sync.

## Security and privacy

Attachment binaries remain isolated by authenticated user identity in IndexedDB.

No password, CSRF token, session cookie, or server session secret is stored with cached attachment binaries.

## Production contract

`/api/health` publishes `offlineWave100CVersion: 1`.

PWA shell version is **33** and offline database schema version is **7**.

## Definition of done

Wave 100C is complete when:

- a server attachment can be pinned online and opened after airplane-mode reload;
- unpin removes only the device copy and the server file remains unchanged;
- unsynced local files cannot lose their only binary copy;
- quota cleanup never removes pinned or pending local files;
- legacy cached binaries migrate safely to v7;
- cache status is visible in Settings;
- mobile and dark-mode attachment controls remain usable;
- Offline A–F, Wave 100A and Wave 100B gates stay green;
- dedicated 100C contract and browser tests are green;
- accounting and visual gates remain green;
- production serves the exact green `main` SHA with `offlineWave100CVersion: 1`, PWA v33, and offline DB v7.
