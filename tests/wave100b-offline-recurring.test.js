import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT=dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const read=path=>readFileSync(join(ROOT,path),'utf8');

test('Wave 100B documents the offline recurring authority boundary',()=>{
  const doc=read('docs/WAVE_100B_OFFLINE_SCHEDULES_REMINDERS.md');
  for(const marker of ['recurringState','recurringQueue','POST /api/sync/recurring','offlineWave100BVersion','Background sync','Post now never fabricates'])assert.ok(doc.includes(marker),marker);
  assert.match(doc,/ledger as the only money authority/i);
  assert.match(doc,/exactly once|at most one|cannot create two ledger entries/i);
});

test('Wave 100B adds IndexedDB v6 recurring cache/outbox to every data-loss guard',()=>{
  const offline=read('lib/offline-db.js');
  assert.match(offline,/version: 6/);
  assert.match(offline,/fromVersion<6/);
  assert.match(offline,/RECURRING_STATE_STORE='recurringState'/);
  assert.match(offline,/RECURRING_QUEUE_STORE='recurringQueue'/);
  for(const fn of ['loadRecurringSnapshot','saveRecurringSnapshot','enqueueRecurringOperation','listRecurringQueue','updateRecurringQueue','removeRecurringQueue','discardRecurringQueue'])assert.ok(offline.includes(`export async function ${fn}`),fn);
  assert.match(offline,/pendingOperationCount[\s\S]*recurringRows/);
  assert.match(offline,/queuedRecoveryBundle[\s\S]*recurringQueue/);
  assert.match(offline,/clearOfflineData[\s\S]*recurringQueueRequest/);
  assert.match(offline,/saveAuthorizedUser[\s\S]*recurringQueueRequest/);
});

test('Wave 100B sync is idempotent, recurring conflicts are targeted, and recurring post stays foreground-authoritative',()=>{
  const server=read('server.mjs'),store=read('lib/store.js'),sw=read('service-worker.js'),app=read('app.js');
  assert.match(server,/function applyRecurringSyncOperation/);
  assert.match(server,/\/api\/sync\/recurring/);
  assert.match(server,/recurringAccepted/);
  assert.match(server,/recurringReplayed/);
  assert.match(server,/recurringConflict/);
  assert.match(server,/offlineWave100BVersion:1/);
  assert.match(store,/async function syncRecurringOperations/);
  assert.match(store,/operation\.action==='post'/);
  assert.match(store,/expectedRevision:Number\(freshState\.version\)/);
  assert.match(store,/export async function resolveRecurringConflict/);
  assert.match(sw,/background-recurring-ledger/);
  assert.match(sw,/\/api\/sync\/recurring/);
  assert.match(sw,/remainingRecurring[\s\S]*baseUpdatedAt:data\.rule\.updatedAt/);
  assert.match(app,/route\.page === 'scheduled'\) renderRecurringPage/);
  assert.doesNotMatch(app,/Recurring rules and reminder inboxes remain server-only/);
  assert.match(app,/data-resolve-recurring-conflict/);
});

test('Wave 100B PWA and CI gates are wired',()=>{
  const version=read('pwa-version.js'),pkg=JSON.parse(read('package.json')),ci=read('.github/workflows/ci.yml');
  assert.match(version,/version:32/);
  assert.match(version,/cacheName:'money-tracker-debt-v32'/);
  assert.match(version,/offlineDbVersion:6/);
  assert.equal(pkg.scripts['test:wave100b'],'node --test tests/wave100b-offline-recurring.test.js tests/wave100b-recurring-server.test.js');
  assert.equal(pkg.scripts['test:wave100b-e2e'],'playwright test e2e/wave100b-offline-recurring.spec.mjs --workers=1');
  assert.match(ci,/Run Wave 100B Offline Schedules gate/);
  assert.match(ci,/Run Wave 100B Offline Schedules browser gate/);
  assert.match(ci,/node --check e2e\/wave100b-offline-recurring\.spec\.mjs/);
});
