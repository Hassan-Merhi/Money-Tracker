# Security & Recovery Operations

## Recovery

Before a risky migration or major release, create a verified SQLite snapshot using the existing snapshot tooling.

For user-level recovery, use the Complete Backup export from Settings. A complete backup is versioned and SHA-256 verified before restore. Restore is transactional.

If a restore fails, do not retry with a modified file unless its integrity source is trusted. The failed restore leaves the existing user data unchanged.

## Password or session incident

If a user suspects a stolen session:

1. Change the account password from Settings. This revokes all other sessions.
2. If a password change is not needed, use Sign out other devices.
3. The owner can reset a secondary user's password, which revokes that user's sessions.

## Authentication abuse

Registration, login, password-change, and account-delete attempts are independently throttled. Rate-limit counters live in SQLite and survive application restarts.

Repeated 429 responses should be treated as an abuse signal. Do not disable throttling to work around a user login issue.

## Deployment verification

A healthy Lane A process logs:

EXACT_MONEY_READY {"version":1,"storage":"integer-minor-units"}

and:

LANE_A_READY {"waves":[2,3,4,5],"ledgerApiVersion":1,"fullBackupVersion":2,"durableRateLimits":true}

The public health endpoint must report matching readiness values.

## Incident containment

For a suspected application compromise:

1. Preserve the current database snapshot and relevant Render logs.
2. Rotate affected external secrets in Render.
3. Revoke affected user sessions by changing/resetting passwords.
4. Deploy only a known-good commit with green CI.
5. Verify /api/health and startup readiness markers.
6. Review post-cutover error logs before returning the service to normal use.

Do not include passwords, session cookies, CSRF tokens, attachment contents, or raw backup payloads in incident tickets or public logs.
