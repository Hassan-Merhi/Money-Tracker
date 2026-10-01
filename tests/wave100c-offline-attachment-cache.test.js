import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT=dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const read=path=>readFileSync(join(ROOT,path),'utf8');

test('Wave 100C documents the offline attachment cache authority and safety boundary',()=>{
  const doc=read('docs/WAVE_100C_OFFLINE_ATTACHMENT_CACHE.md');
  for(const marker of ['IndexedDB v7','offlinePinned','offlinePolicy','Save offline','Remove offline copy','100 MB','offlineWave100CVersion'])assert.ok(doc.includes(marker),marker);
  assert.match(doc,/server remains authoritative/i);
  assert.match(doc,/never discard the only known copy/i);
  assert.match(doc,/Pinned files and unsynced files are never auto-evicted/i);
});

test('Wave 100C adds attachment cache policy, quota-safe eviction and local-copy protection',()=>{
  const offline=read('lib/offline-db.js'),store=read('lib/store.js');
  const dbVersion=Number(/version: (\d+)/.exec(offline)?.[1]||0);
  assert.ok(dbVersion>=7);
  assert.match(offline,/fromVersion<7/);
  for(const field of ['offlinePinned','offlinePolicy','cachedAt','lastAccessedAt'])assert.ok(offline.includes(field),field);
  for(const fn of ['attachmentCacheInfo','saveAttachmentOfflineCopy','removeAttachmentOfflineCopy','evictAttachmentCache','touchOfflineAttachment'])assert.ok(offline.includes(`export async function ${fn}`),fn);
  assert.match(offline,/ATTACHMENT_LOCAL_COPY_REQUIRED/);
  assert.match(offline,/row\.synced===false\|\|row\.status==='pending'/);
  assert.match(offline,/row\.offlinePinned\|\|row\.offlinePolicy==='local'/);
  assert.match(offline,/OFFLINE_ATTACHMENT_CACHE_LIMIT_BYTES=100\*1024\*1024/);
  assert.match(store,/navigator\.storage\?\.estimate/);
  assert.match(store,/prepareAttachmentCacheCapacity/);
  assert.match(store,/export async function pinAttachmentOffline/);
  assert.match(store,/export async function unpinAttachmentOffline/);
  assert.match(store,/export async function clearEvictableAttachmentCache/);
  assert.match(store,/fetch\(attachmentUrl\(id\)/);
  assert.match(store,/removeAttachmentOfflineCopy/);
});

test('Wave 100C exposes user controls without changing server-delete semantics',()=>{
  const app=read('app.js'),styles=read('styles.css');
  assert.match(app,/Save offline/);
  assert.match(app,/Remove offline copy/);
  assert.match(app,/Clear safe cached copies/);
  assert.match(app,/The server attachment is unchanged/);
  assert.match(app,/data-pin-attachment/);
  assert.match(app,/data-unpin-attachment/);
  assert.match(app,/data-delete-attachment/);
  assert.match(styles,/attachment-actions/);
  assert.match(styles,/attachment-item/);
});

test('Wave 100C production/PWA and CI contracts are wired',()=>{
  const version=read('pwa-version.js'),server=read('server.mjs'),smoke=read('lib/production-smoke.js'),pkg=JSON.parse(read('package.json')),ci=read('.github/workflows/ci.yml');
  const pwaVersion=Number(/version:(\d+)/.exec(version)?.[1]||0);
  assert.ok(pwaVersion>=33,`Wave 100C requires PWA v33 or newer; found v${pwaVersion}.`);
  assert.match(version,new RegExp(`cacheName:'money-tracker-debt-v${pwaVersion}'`));
  const offlineDbVersion=Number(/offlineDbVersion:(\d+)/.exec(version)?.[1]||0);
  assert.ok(offlineDbVersion>=7);
  assert.match(server,/offlineWave100CVersion:1/);
  assert.match(smoke,/offlineWave100CVersion/);
  assert.equal(pkg.scripts['test:wave100c'],'node --test tests/wave100c-offline-attachment-cache.test.js');
  assert.equal(pkg.scripts['test:wave100c-e2e'],'playwright test e2e/wave100c-offline-attachment-cache.spec.mjs --workers=1');
  assert.match(ci,/Run Wave 100C Offline Attachment Cache gate/);
  assert.match(ci,/Run Wave 100C Offline Attachment Cache browser gate/);
  assert.match(ci,/node --check e2e\/wave100c-offline-attachment-cache\.spec\.mjs/);
});
