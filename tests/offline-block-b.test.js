import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT=dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const read=path=>readFileSync(join(ROOT,path),'utf8');

test('Offline Block B documents O4-O6 scope and safety boundaries',()=>{
  const doc=read('docs/OFFLINE_BLOCK_B.md');
  for(const marker of ['O4','O5','O6','syncQueue','operationId','baseRevision','/api/sync/push','/api/sync/pull','idempotency','O9','O10']) {
    assert.ok(doc.includes(marker),marker);
  }
  assert.match(doc,/server remains the source of truth/i);
  assert.match(doc,/Account transfers remain online-only until O9/i);
  assert.match(doc,/Unsynced changes are never silently removed/i);
});

test('Offline Block B O4 upgrades IndexedDB without replacing the Block A ledger stores',()=>{
  const source=read('lib/offline-db.js');
  assert.match(source,/version: [3-9][0-9]*/);
  for(const store of ['meta','people','accounts','entries','categories','budgets','syncQueue','syncState']) {
    assert.ok(source.includes("'"+store+"'"),store);
  }
  assert.match(source,/enqueueLocalMutation/);
  assert.match(source,/operationId,identity,entity,entityId,operation/);
  assert.match(source,/baseRevision/);
  assert.match(source,/attempts:0/);
  assert.match(source,/status:'pending'/);
  assert.match(source,/lastError:''/);
  assert.match(source,/head\.head\.version=baseRevision\+1/);
  assert.match(source,/Number\(a\.baseRevision\)-Number\(b\.baseRevision\)/);
});

test('Offline Block B O4 preserves unsynced changes across identity and cache boundaries',()=>{
  const offline=read('lib/offline-db.js');
  const store=read('lib/store.js');
  assert.match(offline,/OFFLINE_PENDING_USER_SWITCH/);
  assert.match(offline,/OFFLINE_PENDING_CHANGES/);
  assert.match(offline,/pendingOperationCount/);
  assert.match(store,/You have unsynced offline changes\. Reconnect and sync them before signing out\./);
  assert.doesNotMatch(store,/try \{ await api\('\/api\/auth\/logout',[\s\S]*?finally/);
  assert.match(store,/if\(error\.status!==401\) throw error/);
  assert.match(store,/Sync or discard the offline changes on this device before deleting the account\./);
  assert.match(store,/if\(!pending\)await clearOfflineData\(requestIdentity\)/);
  assert.match(store,/await publishSyncStatus\(\{authRequired:true\}\)/);
});

test('Offline Block B O4 core local-first guarantees remain after Block C expands supported writes',()=>{
  const store=read('lib/store.js');
  const app=read('app.js');
  assert.match(store,/async function queueCoreMutation/);
  for(const fn of ['updateSettings','createPerson','updatePerson','removePerson','createAccount','updateAccount','removeAccount','createEntry','updateEntry','removeEntry']) {
    assert.ok(store.includes('export async function '+fn+'('),fn);
  }
  assert.doesNotMatch(app,/Offline mode is read-only for now/);
  assert.match(app,/Saved offline ·/);
  assert.match(app,/Offline · changes save locally/);
  assert.match(store,/opening>0&&!person\.openingEntryId/);
  assert.match(store,/id:payload\.openingEntryId/);
});

test('Offline Block B O5 implements ordered revision push/pull with safe full-refresh fallback',()=>{
  const store=read('lib/store.js');
  const server=read('server.mjs');
  assert.match(store,/export async function syncPendingOperations/);
  assert.match(store,/\/api\/sync\/push/);
  assert.match(store,/\/api\/sync\/pull\?sinceRevision=/);
  assert.match(store,/operation\.status==='failed'\|\|operation\.status==='conflict'/);
  assert.match(server,/CREATE TABLE IF NOT EXISTS sync_changes/);
  assert.match(server,/idx_sync_changes_user_revision/);
  assert.match(server,/function pullSyncChanges/);
  assert.match(server,/revisionCoverage\.size!==current-sinceRevision/);
  assert.match(server,/requiresFullRefresh:true/);
  assert.match(server,/url\.pathname==='\/api\/sync\/push'/);
  assert.match(server,/url\.pathname==='\/api\/sync\/pull'/);
  assert.match(store,/const fresh=await api\('\/api\/state'\);[\s\S]*?await discardQueuedOperations\(identity\);[\s\S]*?await saveStateSnapshot\(fresh,identity\)/);
});

test('Offline Block B O6 stores replay results and hashes immutable operation payloads',()=>{
  const server=read('server.mjs');
  assert.match(server,/CREATE TABLE IF NOT EXISTS sync_operations/);
  assert.match(server,/PRIMARY KEY \(user_id, operation_id\)/);
  assert.match(server,/const requestHash=sha256/);
  assert.match(server,/prior\.requestHash!==requestHash/);
  assert.match(server,/alreadyProcessed:true/);
  assert.match(server,/insertProcessed\.run/);
  assert.match(server,/BEGIN IMMEDIATE/);
  assert.match(server,/offlineBlockBVersion:1/);
});

test('Offline Block B has a dedicated CI and browser gate and bumps the PWA cache',()=>{
  const pkg=JSON.parse(read('package.json'));
  const ci=read('.github/workflows/ci.yml');
  const version=read('pwa-version.js');
  assert.equal(pkg.scripts['test:offline-b'],'node --test tests/offline-block-b.test.js tests/offline-block-b-server.test.js');
  assert.equal(pkg.scripts['test:offline-b-e2e'],'playwright test e2e/offline-block-b.spec.mjs --workers=1');
  assert.match(ci,/Run Offline Block B contract gate/);
  assert.match(ci,/Run Offline Block B browser gate/);
  assert.match(version,/version:(?:2[5-9]|[3-9][0-9])/);
  assert.match(version,/money-tracker-debt-v(?:2[5-9]|[3-9][0-9])/);
});


test('Offline Block B hardening keeps auth failures retryable and connected writes resilient to IndexedDB errors',()=>{
  const store=read('lib/store.js');
  assert.match(store,/async function localSnapshot\(expectedIdentity=authenticatedIdentity\)/);
  assert.match(store,/userIdentity\(cachedUser\)!==expectedIdentity/);
  assert.match(store,/catch\{return null;\}/);
  assert.match(store,/error\?\.code==='OFFLINE_PENDING_USER_SWITCH'/);
  assert.match(store,/if\(browserOnline\(\)&&error\?\.status!==409\)return await directCoreMutation/);
  assert.match(store,/if\(error\.status===401\)\{[\s\S]*?status:'pending'[\s\S]*?authRequired:true/);
  assert.match(store,/const snapshot=await localSnapshot\(\)/);
  assert.match(store,/if\(!snapshot\)\{[\s\S]*?browserOnline\(\)[\s\S]*?directCoreMutation/);
});

test('Offline Block B hardening still propagates Bank Feed reopen counts',()=>{
  const server=read('server.mjs');
  const bank=read('lib/bank-server.js');
  assert.match(server,/reopenedFeedItems\+=bankFeed\.revalidatePosted/);
  assert.match(server,/reopenedFeedItems\+=bankFeed\.reopenOrphans/);
  assert.match(server,/reopenedFeedItems\};/);
  assert.match(bank,/reopenOrphans\(userId\)\{return Number\(q\.reopenOrphans\.run/);
});


test('Offline Block B hardening never turns a committed outbox write into a retryable create failure',()=>{
  const offline=read('lib/offline-db.js');
  const store=read('lib/store.js');
  assert.match(offline,/try\{state=await loadStateSnapshot\(\);\}catch\{\}/);
  assert.match(offline,/return \{operationId,state,committed:true\}/);
  assert.match(store,/function projectLocalMutation/);
  assert.match(store,/const optimistic=projectLocalMutation\(snapshot,spec\)/);
  assert.match(store,/await localSnapshot\(\)\|\|queued\.state\|\|optimistic/);
});

test('Offline Block B hardening transitions expired sync sessions to sign-in and surfaces delayed Bank Feed reopen warnings',()=>{
  const store=read('lib/store.js');
  const app=read('app.js');
  assert.match(store,/authRequired:true[\s\S]*?throw error/);
  assert.match(app,/if\(detail\.authRequired\)\{[\s\S]*?showAuth\('Your session expired/);
  assert.match(app,/detail\.reopenedFeedItems[\s\S]*?!saving[\s\S]*?Bank Feed row reopened/);
  assert.match(app,/const result=await syncPendingOperations\(\)[\s\S]*?result\?\.reopenedFeedItems/);
});

test('Offline Block B hardening returns reopened Bank Feed counts from direct entry deletes',()=>{
  const server=read('server.mjs');
  assert.match(server,/if\(req\.method==='DELETE'\)\{[\s\S]*?let reopenedFeedItems=0;[\s\S]*?reopenedFeedItems=bankFeed\.reopenOrphans/);
  assert.match(server,/return json\(res,200,\{\.\.\.loadState\(a\.user_id\),reopenedFeedItems\}\)/);
});
