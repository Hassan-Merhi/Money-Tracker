import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT=dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const read=path=>readFileSync(join(ROOT,path),'utf8');

test('Offline Block D documents O11-O15 and keeps server authority',()=>{
  const doc=read('docs/OFFLINE_BLOCK_D.md');
  for(const marker of ['O11','O12','O13','O14','O15','7 days','Protect offline storage','Sync now','recovery file','single-flight'])assert.ok(doc.includes(marker),marker);
  assert.match(doc,/server remains authoritative/i);
  assert.match(doc,/Passwords, CSRF tokens, and server session cookies are never written to IndexedDB/);
});

test('O11 uses a finite verified offline-access lease and preserves expired data',()=>{
  const offline=read('lib/offline-db.js'),store=read('lib/store.js');
  assert.match(offline,/OFFLINE_ACCESS_MAX_AGE_MS=7\*24\*60\*60\*1000/);
  assert.match(offline,/verifiedAt:new Date\(\)\.toISOString\(\)/);
  assert.match(offline,/export async function offlineAccessInfo/);
  assert.match(store,/OFFLINE_AUTH_EXPIRED/);
  assert.match(store,/Offline access needs an online sign-in check/);
  assert.doesNotMatch(offline,/csrfToken/);
  assert.doesNotMatch(offline,/password/i);
});

test('O12 exposes persistent-storage support without making it mandatory',()=>{
  const pwa=read('lib/pwa.js'),app=read('app.js');
  assert.match(pwa,/navigator\.storage\.persisted/);
  assert.match(pwa,/navigator\.storage\.estimate/);
  assert.match(pwa,/export async function requestPersistentStorage/);
  assert.match(app,/id="persistOffline"/);
  assert.match(app,/Protect offline storage/);
  assert.match(app,/best-effort offline copy/);
});

test('O13 sync UX exposes health, last successful sync, and manual sync',()=>{
  const offline=read('lib/offline-db.js'),store=read('lib/store.js'),app=read('app.js');
  assert.match(offline,/LAST_SYNC_KEY='last-sync'/);
  assert.match(offline,/export async function markSyncSuccess/);
  assert.match(offline,/export async function syncRuntimeInfo/);
  assert.match(store,/lastSyncedAt:runtime\.lastSyncedAt/);
  assert.match(app,/Last successful sync/);
  assert.match(app,/id="syncNow"/);
  assert.match(app,/Offline access/);
  assert.match(app,/Background Sync/);
});

test('O14 has retry, export, and explicit destructive discard recovery paths',()=>{
  const offline=read('lib/offline-db.js'),store=read('lib/store.js'),app=read('app.js');
  assert.match(offline,/export async function retryFailedQueuedOperations/);
  assert.match(offline,/export async function queuedRecoveryBundle/);
  assert.match(store,/export async function retryFailedSyncOperations/);
  assert.match(store,/export async function exportPendingSyncRecovery/);
  assert.match(store,/recoveryVersion:1/);
  assert.match(app,/id="retrySync"/);
  assert.match(app,/id="exportSyncRecovery"/);
  assert.match(app,/id="discardSync"/);
  assert.match(app,/Keep it private/);
});

test('O15 sync is single-flight and resume/background hooks are installed',()=>{
  const store=read('lib/store.js'),pwa=read('lib/pwa.js'),sw=read('service-worker.js');
  assert.match(store,/let syncInFlight=null/);
  assert.match(store,/if\(syncInFlight\)return await syncInFlight/);
  assert.match(pwa,/moneytracker:sync-request/);
  for(const reason of ['online','pageshow','focus','visible','service-worker'])assert.ok(pwa.includes(reason),reason);
  assert.match(pwa,/registration\.sync\.register\('money-tracker-sync'\)/);
  assert.match(sw,/self\.addEventListener\('sync'/);
  assert.match(sw,/money-tracker-sync/);
  assert.match(sw,/MONEY_TRACKER_SYNC_REQUEST/);
  assert.match(sw,/self\.addEventListener\('periodicsync'/);
});

test('Block D has dedicated gates, health marker, and PWA v27',()=>{
  const pkg=JSON.parse(read('package.json')),ci=read('.github/workflows/ci.yml'),version=read('pwa-version.js'),server=read('server.mjs');
  assert.equal(pkg.scripts['test:offline-d'],'node --test tests/offline-block-d.test.js');
  assert.equal(pkg.scripts['test:offline-d-e2e'],'playwright test e2e/offline-block-d.spec.mjs --workers=1');
  assert.match(ci,/Run Offline Block D contract gate/);
  assert.match(ci,/Run Offline Block D browser gate/);
  assert.match(version,/version:27/);
  assert.match(version,/money-tracker-debt-v27/);
  assert.match(server,/offlineBlockDVersion:1/);
});
