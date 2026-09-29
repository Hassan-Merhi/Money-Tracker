# Lane C — Waves 7, 13, and 14

Lane C is the final cross-cutting resilience, security, privacy, and operations lane.

## Wave 7 — PWA / Offline / Update Resilience

Money Tracker remains server-authoritative for financial writes. Offline mode never queues or invents financial mutations.

The PWA now provides:

- cache contract `money-tracker-debt-v9`
- complete shell pre-cache including the PWA controller and CSP-safe theme bootstrap
- network-first navigation with cached shell fallback
- stale-while-revalidate static assets
- API routes excluded from service-worker caching
- explicit install handling through `beforeinstallprompt`
- standalone/install state reporting
- online/offline connection state in the app shell
- friendly offline mutation errors
- controlled service-worker activation with an **Update app** action
- automatic reload after the waiting worker takes control
- update checks when the app regains focus
- service worker and manifest served with `Cache-Control: no-cache`
- service-worker scope explicitly allowed at `/`
- PWA manifest identity, scope, display fallback, finance/productivity categories, and Dashboard / Transactions / Reports shortcuts

The offline shell is for navigation and viewing cached application assets only. Ledger changes require a live connection.

## Wave 13 — Security / Privacy Hardening

Lane C adds defense-in-depth without exporting or exposing authentication secrets.

### Same-origin mutation enforcement

Authenticated state-changing requests now require:

- a valid session
- the existing CSRF token
- same-origin Fetch Metadata when the browser provides `Sec-Fetch-Site`
- a matching request `Origin` host when Origin is present

Blocked cross-site and CSRF failures are recorded as security events.

### Security response headers

Responses now include the existing CSP, frame, MIME, referrer, permissions, and HSTS controls plus:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Resource-Policy: same-origin`
- CSP `worker-src`, `manifest-src`, and `font-src` directives
- HSTS preload eligibility in production

The inline theme bootstrap was moved to `theme-init.js`, so `script-src 'self'` no longer blocks it.

### Session visibility and control

Sessions now store:

- created time
- last-seen time
- a one-way user-agent fingerprint

The app exposes current and other active sessions. A user can revoke one non-current session without terminating every other device.

No session token or token hash is returned to the browser. Public session IDs are derived identifiers.

### Security events

A 90-day user-scoped security event ledger records meaningful authentication and recovery actions such as:

- owner registration
- successful and failed login for known accounts
- blocked cross-site mutations
- rejected CSRF tokens
- password changes
- individual session revocation
- revoke-all-other-sessions
- secondary-user creation, password reset, and deletion
- backup export / restore
- app-data reset
- server snapshot creation
- logout

Sensitive field names such as password, token, cookie, CSRF, and authorization are filtered before event details are stored.

Complete user backups deliberately exclude:

- passwords / password hashes
- active sessions
- rate-limit state
- security-event history

These are security/operational records, not portable financial data.

## Wave 14 — Operations / Diagnostics / Recovery

### Runtime integrity

`/api/health` now reports Lane C readiness plus cached database diagnostics:

- `laneCVersion: 1`
- `pwaCacheVersion: 9`
- SQLite `quick_check`
- foreign-key violation count
- database file size
- free / total filesystem capacity when available
- diagnostic timestamp
- recurring worker status

A failed SQLite quick check or foreign-key check makes health return HTTP 503.

### Owner operations

Owner-only `/api/ops/status` forces a fresh integrity check.

Owner-only `/api/ops/snapshot` creates a verified SQLite snapshot using the existing snapshot engine and returns:

- snapshot filename
- bytes
- SHA-256
- schema SHA-256

Snapshot creation is recorded in the security-event ledger.

### Request tracing

Every HTTP request receives an `X-Request-Id` UUID. Server-side 5xx logs include the request ID, path, status, and sanitized error message so a public failure can be correlated with Render logs.

### Graceful shutdown

Production handles SIGTERM and SIGINT by:

1. stopping the recurring reminder interval
2. stopping new HTTP work
3. checkpointing the SQLite WAL
4. closing SQLite
5. exiting cleanly

A hard timeout prevents a hung shutdown.

Startup emits:

`LANE_C_READY {"waves":[7,13,14],"pwaResilience":true,"securityEvents":true,"sessionControl":true,"runtimeDiagnostics":true,"manualSnapshots":true}`

## Release Gates

Lane C is complete only when:

- the full test suite passes on the exact branch head
- browser/server syntax checks include all Lane C modules
- PWA v9 and CSP-safe theme bootstrap tests pass
- service worker and manifest return no-cache headers
- cross-site mutation tests prove no financial state changes occur
- session listing/revoke and security event tests pass
- backup tests prove sessions/security events remain excluded
- runtime diagnostics report SQLite healthy with zero FK violations
- owner snapshot endpoint produces a real checksummed file
- non-owner operations access is rejected
- dedicated Lane C staging boots with EXACT_MONEY_READY, LANE_A_READY, LANE_B_READY, and LANE_C_READY
- staging health reports Lane C v1 / PWA v9 and a healthy database
- staging has no continuing post-cutover errors
- a fresh verified production snapshot is created immediately before merge
- main CI passes after merge
- production reports Lane C v1, PWA v9, healthy runtime diagnostics, healthy recurring worker, registration locked, and no continuing post-cutover errors
