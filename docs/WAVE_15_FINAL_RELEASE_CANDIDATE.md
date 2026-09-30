# Wave 15 — Final release candidate / 100/100 gate

Wave 15 is a blocker-only release-closure pass. It adds no bookkeeping features. A release candidate is accepted only when every automated release gate is green and there is no known unresolved P0, P1, or P2 defect.

## 100/100 release criteria

The exact candidate commit must satisfy all of the following:

- **Core CI:** the complete Node test suite is green.
- **Accounting:** `npm run accounting:check` passes, including ledger math, exact-money storage, reports, PDF/XLSX, Bank Feed reconciliation, and migration regressions.
- **Backup and recovery:** Wave 9 recovery plus Lane D large-backup round trips are green; snapshot/restore tooling remains syntax-checked.
- **Import and export:** Wave 7 import/export, legacy Excel, XLSX round trips, reporting, PDF and import-server coverage are green.
- **PWA:** Wave 5 integrity checks are green and the browser suite verifies install/update/offline behavior.
- **Security:** Wave 8 security, Lane C security/session/runtime contracts, auth boundaries, CSRF/origin protections and retention tests are green.
- **Accessibility and scale:** Lane D plus Waves 11 and 12 are green.
- **Browser E2E:** Wave 10 release-critical Chromium workflows are green.
- **Visual closure:** Wave 14 phone/tablet/desktop light/dark matrix is green.
- **Production smoke:** the post-main workflow verifies the exact production commit, health endpoint, critical assets, service worker/PWA identity, SQLite quick-check, foreign-key integrity and anonymous auth boundaries.
- **Production deployment:** Render reports the candidate commit live and healthy.
- **Blocker audit:** GitHub has no known unresolved P0/P1/P2 issue applicable to the candidate.

A candidate that misses any item is not 100/100 and must not be called complete.

## Dedicated Wave 15 gate

Run:

```bash
npm run test:wave15
```

This explicitly reruns the highest-risk release contracts for import/export, security, recovery, PWA, production smoke wiring and the final visual-audit contract. CI still runs the full suite, accounting reconciliation, Lane D, browser E2E and the full Wave 14 visual matrix independently.

## Production identity rule

The release is not signed off merely because GitHub CI is green. After merge, the automatic Production Smoke workflow waits for Render and requires `/api/health` to publish the same Git commit SHA as the merged `main` commit. It also verifies runtime and PWA health before passing.

## Final blocker policy

Wave 15 does not hide, downgrade or waive defects to reach 100/100. Any reproducible data-loss, accounting, authentication/authorization, recovery, import/export corruption, broken primary workflow, severe responsive failure, or deployment-integrity defect at P0/P1/P2 blocks release until fixed and reverified.
