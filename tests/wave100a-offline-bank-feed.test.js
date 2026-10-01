import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT=dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const read=path=>readFileSync(join(ROOT,path),'utf8');

test('Wave 100A documents cached Bank Feed reads, durable writes and safety boundary',()=>{
  const doc=read('docs/WAVE_100A_OFFLINE_BANK_FEED.md');
  for(const marker of ['bankFeedState','bankFeedQueue','CSV','XLSX','POST /api/sync/bank-feed','Background sync','offlineWave100AVersion'])assert.ok(doc.includes(marker),marker);
  assert.match(doc,/server remains authoritative/i);
  assert.match(doc,/do not fabricate a local balance/i);
  assert.match(doc,/latest \*\*500\*\*/);
});

test('Wave 100A adds IndexedDB v5 Bank Feed cache and outbox to data-loss guards',()=>{
  const offline=read('lib/offline-db.js');
  assert.match(offline,/version: 5/);
  assert.match(offline,/fromVersion<5/);
  assert.match(offline,/BANK_FEED_STATE_STORE='bankFeedState'/);
  assert.match(offline,/BANK_FEED_QUEUE_STORE='bankFeedQueue'/);
  assert.match(offline,/export async function loadBankFeedSnapshot/);
  assert.match(offline,/export async function enqueueBankFeedOperation/);
  assert.match(offline,/export async function listBankFeedQueue/);
  assert.match(offline,/pendingOperationCount[\s\S]*bankFeedRows/);
  assert.match(offline,/queuedRecoveryBundle[\s\S]*bankFeedQueue/);
  assert.match(offline,/clearOfflineData[\s\S]*bankFeedQueueRequest/);
});

test('Wave 100A keeps Bank Feed sync idempotent and ledger-changing actions foreground-authoritative',()=>{
  const server=read('server.mjs'),store=read('lib/store.js'),sw=read('service-worker.js'),app=read('app.js');
  assert.match(server,/function applyBankFeedSyncOperation/);
  assert.match(server,/requestHash!==requestHash/);
  assert.match(server,/\/api\/sync\/bank-feed/);
  assert.match(server,/offlineWave100AVersion:1/);
  for(const key of ['bankFeedAccepted','bankFeedReplayed','bankFeedConflict','bankFeedRejected'])assert.ok(server.includes(key),key);
  assert.match(store,/syncBankFeedOperations/);
  assert.match(store,/export async function resolveBankFeedConflict/);
  assert.match(store,/expectedRevision:Number\(freshState\.version\)/);
  assert.match(store,/saveBankFeedSnapshot/);
  assert.match(store,/pendingAction:'post'/);
  assert.match(sw,/background-bank-feed-ledger/);
  assert.match(sw,/\['post','undo'\]\.includes\(operation\.action\)/);
  assert.match(sw,/\/api\/sync\/bank-feed/);
  assert.match(app,/route\.page === 'bank'\) renderBankFeedPage/);
  assert.doesNotMatch(app,/Bank Feed remains server-only/);
  assert.match(app,/data-resolve-bank-conflict/);
  assert.match(app,/resolveBankFeedConflict/);
});

test('Wave 100A PWA schema and CI gates are wired',()=>{
  const version=read('pwa-version.js'),ci=read('.github/workflows/ci.yml'),pkg=JSON.parse(read('package.json'));
  assert.match(version,/version:31/);
  assert.match(version,/cacheName:'money-tracker-debt-v31'/);
  assert.match(version,/offlineDbVersion:5/);
  assert.equal(pkg.scripts['test:wave100a'],'node --test tests/wave100a-offline-bank-feed.test.js tests/bank-feed-server.test.js');
  assert.equal(pkg.scripts['test:wave100a-e2e'],'playwright test e2e/wave100a-offline-bank-feed.spec.mjs --workers=1');
  assert.match(ci,/Run Wave 100A Offline Bank Feed gate/);
  assert.match(ci,/Run Wave 100A Offline Bank Feed browser gate/);
  assert.match(ci,/node --check e2e\/wave100a-offline-bank-feed\.spec\.mjs/);
});
