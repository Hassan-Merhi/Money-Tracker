# Waves 8–9 — Security and Recovery Completion

Date: 2026-09-29

## Wave 8 — Security and destructive actions

Completed controls:
- Mutating authenticated APIs continue to require CSRF tokens and same-origin requests.
- Current-password re-authentication now protects complete backup restore, legacy backup restore, secondary-user password reset, and secondary-user deletion.
- Secondary-user deletion also requires an explicit `DELETE` confirmation.
- Complete and legacy restores require an explicit `RESTORE` confirmation.
- Failed destructive re-authentication is recorded in security activity without logging passwords or tokens.
- Sensitive re-authentication attempts are durably rate-limited.
- The Settings UI uses password/typed-confirmation modals instead of a simple browser confirm for the newly hardened actions.
- Existing protections remain in force for password change, app-data deletion, account deletion, session revocation, owner-only operations, user isolation, security headers, cookie flags, origin checks, and CSRF checks.

Exit gate:
- [x] Authentication/session controls audited.
- [x] CSRF and origin enforcement covered.
- [x] User-owned data isolation preserved.
- [x] Destructive account/data actions require explicit confirmation.
- [x] Owner administration of secondary users requires re-authentication.
- [x] Restore operations require re-authentication and typed confirmation.
- [x] Dedicated Wave 8 regression coverage added.

## Wave 9 — Backup and recovery

Completed controls:
- Complete backups retain their SHA-256 integrity envelope and now receive semantic validation before replacement.
- Restore rejects unsupported money-schema versions, invalid timezones/app modes/currencies, malformed binary payloads, attachment size mismatches, invalid stored values, malformed JSON payloads, and broken cross-table references.
- Complete restore remains transactional and runs a foreign-key check before commit.
- Snapshot restore validates metadata, byte size, SHA-256, schema fingerprint, SQLite `quick_check`, required Money Tracker tables, and foreign keys before the live database is moved.
- Snapshot restore stages and validates a temporary copy before activation.
- The prior live database is retained under a unique rollback name.
- Live WAL/SHM sidecars are moved with the rollback copy so stale journal data cannot replay against the restored snapshot.
- Final restored-database verification is performed, with rollback restoration on failure.
- Corrupt snapshots abort before the live database is touched.
- Manual server snapshot creation is rate-limited to reduce accidental disk exhaustion.

Exit gate:
- [x] Complete-backup round trip preserved.
- [x] Corrupt/tampered backup rejection covered.
- [x] Broken-reference rejection covered.
- [x] Attachment recovery validation covered.
- [x] Snapshot checksum/schema/SQLite validation covered.
- [x] Offline rollback copy preserved.
- [x] WAL/SHM stale-sidecar scenario covered.
- [x] Corrupt snapshot leaves the live database untouched.
- [x] Focused Wave 8/9 gate added to `package.json`.

The release-wide `npm test` gate remains authoritative in addition to `npm run test:wave8-9`.
