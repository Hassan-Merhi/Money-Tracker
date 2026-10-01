import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT=dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const read=path=>readFileSync(join(ROOT,path),'utf8');

test('Offline Block F documents O20-O22 and the cross-block release matrix',()=>{
  const doc=read('docs/OFFLINE_BLOCK_F.md');
  for(const marker of ['O20','O21','O22','Cold launch','Multi-device','Idempotent','full authoritative refresh','offlineSyncMonitor'])assert.ok(doc.includes(marker),marker);
  for(const marker of ['Cold launch','Reads','Writes','Sync','Retry','Conflicts','Tombstones','Transfers','Attachments','Auth','Storage','Updates','Migrations','Exports','Multi-device'])assert.ok(doc.includes(marker),marker);
  assert.match(doc,/server remains authoritative/i);
  assert.match(doc,/local and server ledger revisions match/i);
});

test('O21 keeps idempotency, conflict and convergence primitives wired',()=>{
  const server=read('server.mjs'),store=read('lib/store.js'),offline=read('lib/offline-db.js');
  assert.match(server,/processedById/);
  assert.match(server,/alreadyProcessed:true/);
  assert.match(server,/requestHash!==requestHash/);
  assert.match(server,/current!==op\.baseRevision/);
  assert.match(server,/requiresFullRefresh:true/);
  assert.match(store,/resolveSyncConflict/);
  assert.match(store,/rebaseQueuedOperations/);
  assert.match(store,/syncPendingOperations/);
  assert.match(offline,/pendingOperationCount/);
  assert.match(offline,/applyPulledChanges/);
  assert.match(offline,/setLastServerRevision/);
});

test('O22 health exposes aggregate-only persistent sync telemetry',()=>{
  const server=read('server.mjs');
  assert.match(server,/CREATE TABLE IF NOT EXISTS sync_metrics/);
  assert.match(server,/offlineBlockFVersion:1/);
  assert.match(server,/offlineSyncMonitor:offlineSyncMonitor\(\)/);
  for(const key of ['pushAccepted','pushReplayed','pushConflict','pushRejected','attachmentAccepted','attachmentReplayed','attachmentConflict','attachmentRejected','pulls','pullFullRefresh'])assert.ok(server.includes(key),key);
  assert.match(server,/privacy:'aggregate-only-no-ledger-payloads'/);
  const monitor=server.slice(server.indexOf('function offlineSyncMonitor'),server.indexOf('function applySyncOperation'));
  for(const forbidden of ['user_id','entity_id','operation_id','amount','description','filename','email','payload_json'])assert.doesNotMatch(monitor,new RegExp(forbidden,'i'));
});

test('Block F is wired into CI and keeps A-E as prerequisites',()=>{
  const ci=read('.github/workflows/ci.yml'),pkg=JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['test:offline-f'],'node --test tests/offline-block-f.test.js');
  assert.equal(pkg.scripts['test:offline-f-e2e'],'playwright test e2e/offline-block-f.spec.mjs --workers=1');
  assert.match(ci,/Run Offline Block F contract gate/);
  assert.match(ci,/Run Offline Block F browser gate/);
  for(const block of ['A','B','C','D','E'])assert.match(ci,new RegExp('Run Offline Block '+block+' browser gate'));
  assert.match(ci,/node --check e2e\/offline-block-f\.spec\.mjs/);
});
