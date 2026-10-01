import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { offlineLifecycleCapabilities, withOfflineSyncLock } from '../lib/offline-lifecycle.js';

const ROOT=dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const read=path=>readFileSync(join(ROOT,path),'utf8');

test('Wave 100F lifecycle helper degrades safely without browser coordination APIs',async()=>{
  const caps=offlineLifecycleCapabilities();
  assert.equal(typeof caps.broadcastChannel,'boolean');
  assert.equal(typeof caps.storageEvents,'boolean');
  assert.equal(typeof caps.webLocks,'boolean');
  let calls=0;
  const value=await withOfflineSyncLock('test-user',async()=>{calls++;return 42;});
  assert.equal(value,42);
  assert.equal(calls,1);
});

test('Wave 100F treats only retryable HTTP/network failures as transient',()=>{
  const store=read('lib/store.js'),worker=read('service-worker.js');
  assert.match(store,/TRANSIENT_SYNC_STATUSES=new Set\(\[408,425,429,500,502,503,504\]\)/);
  assert.match(store,/function transientSyncError/);
  assert.match(store,/status:'pending',lastError:message/);
  assert.match(store,/if\(!transientSyncError\(error\)\)throw error/);
  assert.match(worker,/TRANSIENT_SYNC_STATUSES=new Set\(\[408,425,429,500,502,503,504\]\)/);
  assert.match(worker,/function transientResponse/);
  assert.match(worker,/background-transient/);
  assert.doesNotMatch(store,/TRANSIENT_SYNC_STATUSES=new Set\([^\n]*409/);
});

test('Wave 100F serializes foreground and worker sync under one per-account Web Lock',()=>{
  const lifecycle=read('lib/offline-lifecycle.js'),store=read('lib/store.js'),worker=read('service-worker.js');
  assert.match(lifecycle,/money-tracker-sync:'\+cleanIdentity/);
  assert.match(lifecycle,/locks\.request/);
  assert.match(store,/withOfflineSyncLock\(identity,task\)/);
  assert.match(worker,/money-tracker-sync:'\+identity/);
  assert.match(worker,/withWorkerSyncLock\(identity/);
  assert.match(worker,/locks\.request/);
});

test('Wave 100F broadcasts payload-free peer working-set signals and defers unsafe UI refresh',()=>{
  const lifecycle=read('lib/offline-lifecycle.js'),store=read('lib/store.js'),app=read('app.js');
  assert.match(lifecycle,/BroadcastChannel/);
  assert.match(lifecycle,/money-tracker-lifecycle-signal-v1/);
  assert.match(lifecycle,/moneytracker:peer-change/);
  for(const forbidden of ['amount','description','merchant','attachment','payload'])assert.doesNotMatch(lifecycle,new RegExp(`message\\[[^\\]]*${forbidden}`, 'i'));
  assert.match(store,/announceOfflineChange/);
  assert.match(store,/kind:'ledger-queued'/);
  assert.match(store,/kind:'attachment-queued'/);
  assert.match(store,/kind:'bank-feed-queued'/);
  assert.match(store,/kind:'recurring-queued'/);
  assert.match(app,/moneytracker:peer-change/);
  assert.match(app,/loadCachedState/);
  assert.match(app,/saving\|\|document\.querySelector\('\.modal-backdrop'\)/);
  assert.match(app,/peerRefreshPending/);
});

test('Wave 100F PWA, production and CI contracts are wired',()=>{
  const doc=read('docs/WAVE_100F_HOSTILE_CONNECTIVITY_LIFECYCLE.md'),version=read('pwa-version.js'),sw=read('service-worker.js'),server=read('server.mjs'),smoke=read('lib/production-smoke.js'),pkg=JSON.parse(read('package.json')),ci=read('.github/workflows/ci.yml');
  for(const marker of ['slow/throttled','lost after server commit','two tabs','service worker','409','Web Locks','PWA shell **v36**'])assert.ok(doc.toLowerCase().includes(marker.toLowerCase()),marker);
  assert.match(version,/version:36/);
  assert.match(version,/cacheName:'money-tracker-debt-v36'/);
  assert.match(version,/offlineDbVersion:7/);
  assert.match(sw,/\/lib\/offline-lifecycle\.js/);
  assert.match(server,/offlineWave100FVersion:1/);
  assert.match(smoke,/offlineWave100FVersion/);
  assert.equal(pkg.scripts['test:wave100f'],'node --test tests/wave100f-hostile-connectivity-lifecycle.test.js');
  assert.equal(pkg.scripts['test:wave100f-e2e'],'playwright test e2e/wave100f-connectivity.spec.mjs e2e/wave100f-lifecycle.spec.mjs e2e/wave100f-conflict.spec.mjs --workers=1');
  assert.match(ci,/Run Wave 100F Hostile Connectivity & Lifecycle gate/);
  assert.match(ci,/Run Wave 100F Hostile Connectivity & Lifecycle browser gate/);
  assert.match(ci,/node --check e2e\/wave100f-connectivity\.spec\.mjs/);
  assert.match(ci,/node --check e2e\/wave100f-lifecycle\.spec\.mjs/);
  assert.match(ci,/node --check e2e\/wave100f-conflict\.spec\.mjs/);
  assert.match(ci,/node --check lib\/offline-lifecycle\.js/);
});
