# Wave 13 — Production smoke-test system

Wave 13 turns production verification into a deployment gate instead of a manual checklist.

## What is verified

Every production start runs a one-shot HTTP smoke suite against the newly started process. It verifies:

- `/api/health` returns healthy runtime diagnostics.
- the live build publishes its Render/Git commit and a deterministic build version.
- SQLite `quick_check` is `ok`, foreign-key violations are zero, and the DB can be read.
- the application shell and critical CSS/JS/icon assets are present.
- `service-worker.js` is served with root scope and consumes the authoritative PWA version.
- `pwa-version.js` matches the cache version/name published by health.
- the web app manifest is valid.
- the public auth-status read works.
- protected reads (`/api/auth/me`, `/api/state`) reject anonymous access.
- when dedicated smoke credentials are configured, login, `/api/auth/me`, `/api/state`, session listing, and logout are exercised without mutating ledger data.

If the startup smoke fails in production, the process exits non-zero. Render therefore cannot promote an instance that fails the Wave 13 contract.

## External post-deploy verification

`.github/workflows/production-smoke.yml` runs after the main CI workflow succeeds on `main`. It polls production until `/api/health` reports the exact commit SHA that triggered the deployment, then runs the same smoke suite over the public URL. This catches problems that a loopback startup check cannot, including routing, TLS, proxy/cache, and public asset delivery.

The workflow uses `vars.PRODUCTION_URL` when present and otherwise defaults to the Blueprint service URL `https://money-owed-tracker.onrender.com`.

Optional repository secrets:

- `PRODUCTION_SMOKE_EMAIL`
- `PRODUCTION_SMOKE_PASSWORD`

When both are configured, authenticated production reads are included. Without them, authentication boundaries and all non-mutating public/database checks remain mandatory.

## Manual run

```bash
PRODUCTION_URL=https://money-owed-tracker.onrender.com \
EXPECTED_COMMIT_SHA=<commit> \
node scripts/production-smoke.mjs
```

To disable only the startup smoke for emergency diagnosis, set `PRODUCTION_SMOKE_ON_START=0`. The default Render Blueprint explicitly keeps it enabled.
