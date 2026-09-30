import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('Wave 15 exposes a dedicated final release-candidate gate',()=>{
  const pkg=JSON.parse(read('package.json'));
  assert.equal(
    pkg.scripts['test:wave15'],
    'node --test tests/release-wave-15-final-rc.test.js tests/release-wave-7-import-export.test.js tests/wave8-security.test.js tests/wave9-recovery.test.js tests/release-wave-5-pwa.test.js tests/release-wave-13-production-smoke.test.js tests/release-wave-14-visual-audit.test.js'
  );
  const ci=read('.github/workflows/ci.yml');
  assert.match(ci,/Run Wave 15 final release-candidate gate/);
  assert.match(ci,/npm run test:wave15/);
  assert.match(ci,/npm run accounting:check/);
  assert.match(ci,/npm run test:wave10/);
  assert.match(ci,/npm run test:wave14/);
});

test('Wave 15 signs off recovery, import/export, PWA, security, visual and production contracts',()=>{
  for(const path of [
    'tests/release-wave-7-import-export.test.js',
    'tests/wave8-security.test.js',
    'tests/wave9-recovery.test.js',
    'tests/release-wave-5-pwa.test.js',
    'tests/release-wave-13-production-smoke.test.js',
    'tests/release-wave-14-visual-audit.test.js',
    'tests/lane-d-client.test.js',
    'tests/lane-d-server.test.js'
  ]) assert.equal(existsSync(new URL('../'+path,import.meta.url)),true,path+' must exist');

  const laneD=read('server.mjs');
  assert.match(laneD,/LANE_D_READY[^\n]+waves:\[11,12,15\]/);
  assert.match(laneD,/laneDVersion:1/);
});

test('Wave 15 requires exact production identity and healthy runtime diagnostics',()=>{
  const smoke=read('lib/production-smoke.js');
  const workflow=read('.github/workflows/production-smoke.yml');
  assert.match(smoke,/waitForExpectedDeployment/);
  assert.match(smoke,/deployment\?\.gitCommit===expectedCommit/);
  assert.match(smoke,/sqliteQuickCheck==='ok'/);
  assert.match(smoke,/foreignKeyViolations/);
  assert.match(smoke,/pwaCacheName/);
  assert.match(smoke,/Anonymous \/api\/state boundary/);
  assert.match(workflow,/head_branch == 'main'/);
  assert.match(workflow,/EXPECTED_COMMIT_SHA/);
  assert.match(workflow,/Verify deployed production/);
});

test('Wave 15 release documentation defines a blocker-only 100\/100 policy',()=>{
  const doc=read('docs/WAVE_15_FINAL_RELEASE_CANDIDATE.md');
  assert.match(doc,/P0\/P1\/P2/);
  assert.match(doc,/backup and recovery/i);
  assert.match(doc,/import and export/i);
  assert.match(doc,/PWA/i);
  assert.match(doc,/security/i);
  assert.match(doc,/accounting/i);
  assert.match(doc,/browser E2E/i);
  assert.match(doc,/production commit/i);
  assert.match(doc,/100\/100/);
});
