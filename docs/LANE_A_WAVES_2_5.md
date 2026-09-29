# Lane A — Waves 2, 3, 4, and 5

Lane A is complete only when all four waves pass together.

## Wave 2 — Proper Ledger API

Daily settings, people, accounts, transactions, and transfers use revision-safe row-level REST mutations. The legacy full-state write remains only for bulk import/restore/reset compatibility.

## Wave 3 — Complete Backup & Recovery

The server-generated backup contract is version 2 and includes all user-owned application data:

- settings metadata
- people
- accounts
- exact-money transactions and split storage
- attachments, including file bytes
- recurring schedules
- categories
- budgets
- Bank Feed items
- Bank Feed rules

Passwords, password hashes, sessions, and rate-limit/security state are deliberately excluded.

Every exported backup includes a SHA-256 integrity digest over a canonical payload. Restore rejects a modified/corrupted file before changing data.

Restore runs inside one SQLite transaction. Existing user-owned app data is replaced only if the complete backup can be inserted and foreign-key validation succeeds.

The older partial JSON restore endpoint remains for compatibility, but Settings uses the complete backup endpoint.

## Wave 4 — Account & Session Lifecycle

Authenticated users can:

- change their password after proving the current password;
- automatically revoke all other sessions when the password changes;
- revoke all other sessions without changing the password;
- permanently delete their own account after password verification and typing DELETE.

The owner can:

- create secondary users;
- reset a secondary user's password;
- revoke all sessions for that user during the reset;
- delete a secondary user and all data owned by that user.

The owner account cannot be manipulated through secondary-user controls. An owner cannot self-delete while secondary users still exist.

## Wave 5 — Durable Security & Operational Hardening

Authentication throttling is persisted in SQLite instead of process memory. Keys contain a SHA-256 hash of the request scope and client address; raw client IPs are not stored in the rate-limit table.

Scopes have independent limits for registration, login, password changes, and account deletion.

CI runs with read-only repository permissions and a hard timeout. Browser/server syntax checks include the complete-backup module.

Health reports:

- exact-money schema version
- integer money storage readiness
- atomic ledger API version
- full backup version
- durable rate-limit readiness

Startup logs emit both EXACT_MONEY_READY and LANE_A_READY.

## Release gates

Lane A is releasable only when the latest branch CI passes, combined staging boots with both readiness markers, staging health exposes the expected versions, no continuing staging errors are present, main CI passes after merge, production reports the same readiness fields, registration remains locked, and no continuing post-cutover errors are present.
