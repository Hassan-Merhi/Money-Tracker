import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT=dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const read=path=>readFileSync(join(ROOT,path),'utf8');

test('Offline Block C documents O7-O10 and keeps the server authoritative',()=>{
  const doc=read('docs/OFFLINE_BLOCK_C.md');
  for(const marker of ['O7','O8','O9','O10','baseRecord','tombstones','Atomic offline transfers','attachmentQueue','Keep mine','Use server']) {
    assert.ok(doc.includes(marker),marker);
  }
  assert.match(doc,/server authoritative|authoritative server/i);
});

test('O7 stores conflict bases and supports automatic rebase plus explicit resolution',()=>{
  const offline=read('lib/offline-db.js'),store=read('lib/store.js'),app=read('app.js');
  assert.match(offline,/baseRecord/);
  assert.match(offline,/localRecord/);
  assert.match(offline,/export async function rebaseQueuedOperations/);
  assert.match(offline,/strategy==='keep_server'/);
  assert.match(offline,/strategy==='keep_mine'/);
  assert.match(store,/sameConflictRecord/);
  assert.match(store,/key==='updatedAt'/);
  assert.match(store,/changed before the offline change could sync/);
  assert.match(store,/await rebaseQueuedOperations\(fresh,identity\)/);
  assert.match(store,/export async function resolveSyncConflict/);
  assert.match(app,/data-strategy="keep_mine"/);
  assert.match(app,/data-strategy="keep_server"/);
  assert.match(store,/serverDeleted=\['update','delete'\]\.includes\(queued\.operation\)/);
  assert.match(store,/This record was deleted on another device/);
  assert.match(app,/serverDeleted=\['update','delete'\]\.includes\(row\.operation\)/);
  assert.match(app,/canKeepMine=row\.operation!=='create'&&!serverDeleted/);
  assert.match(store,/operation\.operation==='delete'&&serverRecord==null/);
  assert.match(offline,/function sameQueuedBase/);
  assert.match(offline,/key==='updatedAt'/);
  assert.match(offline,/automatic&&row\.status!=='failed'&&!sameQueuedBase/);
  assert.match(offline,/row\.status='conflict'/);
  assert.match(store,/if\(operation\.status==='failed'\|\|operation\.status==='conflict'\)/);
});

test('O8 upgrades IndexedDB to durable tombstones and server tombstones',()=>{
  const offline=read('lib/offline-db.js'),server=read('server.mjs');
  const dbVersion=Number(/version: (\d+)/.exec(offline)?.[1]||0);
  assert.ok(dbVersion>=3);
  for(const name of ['tombstones','attachments','attachmentQueue'])assert.ok(offline.includes("'"+name+"'"),name);
  assert.match(offline,/TOMBSTONE_STORE/);
  assert.match(offline,/operation==='delete'[\s\S]*?TOMBSTONE_STORE/);
  assert.match(offline,/serverRevision:Number\(change\?\.revision\)/);
  assert.match(server,/CREATE TABLE IF NOT EXISTS sync_tombstones/);
  assert.match(server,/tombstoneByEntity/);
  assert.match(server,/upsertTombstone/);
  assert.match(server,/deleted on another device/);
});

test('O9 transfers use the same single atomic entry operation as other ledger writes',()=>{
  const store=read('lib/store.js'),server=read('server.mjs');
  assert.doesNotMatch(store,/Offline transfers are reserved for the atomic-transfer phase/);
  assert.doesNotMatch(server,/Offline transfers are not enabled until the atomic-transfer phase/);
  assert.match(store,/createEntry\(entry,expectedRevision\)[\s\S]*?queueCoreMutation\(\{entity:'entry'/);
  assert.match(server,/function applySyncOperation[\s\S]*?BEGIN IMMEDIATE/);
  assert.match(server,/cleanLedgerEntry\(user,\{\.\.\.op\.payload,id:op\.entityId\}\)/);
});

test('O10 has a separate durable idempotent attachment outbox',()=>{
  const offline=read('lib/offline-db.js'),store=read('lib/store.js'),server=read('server.mjs'),app=read('app.js');
  assert.match(offline,/ATTACHMENT_QUEUE_STORE/);
  assert.match(offline,/queueOfflineAttachmentCreate/);
  assert.match(offline,/queueOfflineAttachmentDelete/);
  assert.match(offline,/create may already have committed remotely/);
  assert.match(offline,/if\(pendingCreates\.length\)/);
  assert.doesNotMatch(offline,/if\(!attachment\.synced&&pendingCreates\.length\)/);
  assert.match(offline,/pendingCreates[\s\S]*?for\(const pendingCreate of pendingCreates\)queueStore\.delete\(pendingCreate\.operationId\)[\s\S]*?operation:'delete'/);
  assert.match(offline,/row\.operation==='create'[\s\S]*?item\.operation==='delete'[\s\S]*?store\.delete\(operationId\)/);
  assert.match(offline,/pendingOperationCount[\s\S]*?attachmentQueuedRows/);
  assert.match(store,/syncAttachmentOperations/);
  assert.match(store,/const claimed=await updateAttachmentQueue/);
  assert.match(store,/if\(!claimed\)continue/);
  assert.match(store,/const finalIntent=\(await listAttachmentQueue\(identity\)\)\.find/);
  assert.match(store,/\/api\/sync\/attachments/);
  assert.match(store,/queueOfflineAttachmentCreate/);
  assert.match(store,/localUrl/);
  assert.match(server,/function applyAttachmentSyncOperation/);
  assert.match(server,/tombstoneByEntity\.get\(user\.user_id,'attachment'/);
  assert.match(server,/upsertTombstone\.run\(user\.user_id,'attachment'/);
  assert.match(server,/processedById/);
  assert.match(server,/url\.pathname==='\/api\/sync\/attachments'/);
  assert.match(app,/queued/);
  assert.match(app,/reconnect to open/);
  assert.match(store,/pendingOperationCount\(identity\)\.catch\(\(\)=>0\)/);
});

test('Block C has dedicated CI/browser gates and PWA v26',()=>{
  const pkg=JSON.parse(read('package.json')),ci=read('.github/workflows/ci.yml'),version=read('pwa-version.js'),server=read('server.mjs');
  assert.equal(pkg.scripts['test:offline-c'],'node --test tests/offline-block-c.test.js tests/offline-block-c-server.test.js');
  assert.equal(pkg.scripts['test:offline-c-e2e'],'playwright test e2e/offline-block-c.spec.mjs --workers=1');
  assert.match(ci,/Run Offline Block C contract gate/);
  assert.match(ci,/Run Offline Block C browser gate/);
  const match=version.match(/version:(\d+)/),cache=version.match(/money-tracker-debt-v(\d+)/);
  assert.ok(match&&Number(match[1])>=26);
  assert.equal(cache?.[1],match?.[1]);
  assert.match(server,/offlineBlockCVersion:1/);
});
