# Wave 100F — Hostile Connectivity & Lifecycle

Wave 100F hardens Money Tracker against the failure modes that happen outside clean online/offline transitions: slow links, dropped responses, temporary server failures, multiple tabs, service-worker overlap, page termination, stale in-memory state, and queued conflicts.

## Goals

Money Tracker must preserve money correctness when:

- a sync request is delayed;
- a response is lost after the server already committed the operation;
- the server temporarily returns 408, 425, 429, 500, 502, 503 or 504;
- the page is reloaded or killed while work is queued;
- two tabs try to sync the same durable outbox;
- the service worker and a foreground tab wake at the same time;
- one tab changes the local working set while another tab is open;
- an app update is waiting while unsynced work exists;
- a remote edit creates a real conflict.

## Retryable failures

The following HTTP statuses are treated as transient for offline-capable sync paths:

- 408 Request Timeout
- 425 Too Early
- 429 Too Many Requests
- 500 Internal Server Error
- 502 Bad Gateway
- 503 Service Unavailable
- 504 Gateway Timeout

A transient response does **not** turn queued work into a permanent failed row.

The operation remains `pending` with its original operation ID and payload. This preserves idempotent replay. A later foreground/background sync retries the same durable operation.

Supported Bank Feed and Scheduled/Reminder mutations also fall back to their durable local queue when these transient HTTP responses happen while the browser still reports itself online.

Permanent validation errors remain failures. Real 409 conflicts remain explicit conflicts.

## Cross-tab and service-worker coordination

`lib/offline-lifecycle.js` adds two browser coordination primitives.

### Shared sync lock

Where the Web Locks API is available, foreground tabs and the service worker acquire the same per-account lock:

`money-tracker-sync:<identity>`

Only one context drains the durable outbox at a time.

If Web Locks are unavailable, Money Tracker falls back to the existing server idempotency and IndexedDB transaction guarantees. Correctness does not depend on Web Locks.

Browser-held locks are released automatically if a tab/process is terminated.

### Peer working-set notifications

Tabs announce privacy-safe working-set events through BroadcastChannel, with a `storage` event fallback.

Messages contain only:

- account identity key used internally for same-account filtering;
- event kind;
- local ledger version when available;
- timestamp/source metadata.

They do **not** contain amounts, names, descriptions, attachments or ledger payloads.

A visible peer tab reloads the latest IndexedDB working set and sync status. If a modal is open or a local save is in progress, refresh is deferred until it is safe so form input is not destroyed.

## Lost response after commit

A server-accepted operation may have its HTTP response lost.

The client keeps the same operation ID in IndexedDB because it never observed success.

On retry, the server's processed-operation/idempotency table returns the previously accepted result instead of applying the money mutation twice. The queue then drains normally.

## Page kill / reload

Queued work lives in IndexedDB, not process memory.

Closing/reloading a page does not remove:

- ledger operations;
- attachment operations and local-only binary copies;
- Bank Feed operations;
- recurring operations;
- tombstones/conflicts.

The next controlled page or service worker can resume the same operation IDs.

## Service-worker update safety

The existing Wave E update guard remains authoritative.

A waiting service worker cannot be activated while the durable pending count is non-zero. Wave 100F additionally verifies this under hostile-lifecycle conditions so an app update cannot strand queued work between versions.

## Conflict recovery

True stale-revision conflicts still stop automatic replay.

Conflict resolution remains user-directed:

- **Keep mine** rebases only supported conflict shapes;
- **Use server** drops the conflicted local chain and refreshes authoritative state;
- unrelated queued work is preserved.

Temporary 5xx/429 responses are never mislabeled as conflicts.

## PWA and production contract

Wave 100F uses:

- PWA shell **v36**;
- IndexedDB **v7**;
- `offlineWave100FVersion: 1` in `/api/health`.

The service-worker shell caches `/lib/offline-lifecycle.js`.

## Dedicated hostile browser matrix

The Wave 100F browser gate covers:

1. slow/throttled sync requests;
2. one response lost after server commit, followed by idempotent replay;
3. transient 503 keeping the operation pending rather than failed;
4. closing/reopening the page with queued work;
5. two tabs attempting foreground sync at the same time;
6. peer-tab state refresh from the shared IndexedDB working set;
7. service-worker/manual foreground overlap using the same lock;
8. update activation blocked while queued work exists;
9. a real remote-edit conflict and explicit recovery;
10. final local/server convergence with zero pending/failed/conflict rows.

## Definition of done

Wave 100F is complete when:

- transient connectivity/server failures never silently lose or duplicate money work;
- duplicate/lost-response retries remain idempotent;
- multi-tab/service-worker sync is serialized where Web Locks exist and remains correct without it;
- stale open tabs adopt peer IndexedDB changes safely;
- app kill/reload preserves queued work;
- update activation remains blocked while work is dirty;
- real conflicts are recoverable without discarding unrelated work;
- Offline A–F and Waves 100A–100E remain green;
- dedicated 100F contract/browser gates are green;
- accounting and visual gates remain green;
- production serves the exact green `main` SHA with `offlineWave100FVersion: 1`, PWA v36 and offline DB v7.
