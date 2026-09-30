import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT=dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const read=path=>readFileSync(join(ROOT,path),'utf8');

test('Offline Block A O0: architecture audit documents boundaries',()=>{
  const audit=read('docs/OFFLINE_BLOCK_A.md');
  for(const marker of ['READ','CREATE / UPDATE / DELETE','DERIVED','SERVER-ONLY','O0','O1','O2','O3']) assert.ok(audit.includes(marker),marker);
  assert.ok(audit.includes('/api/state'));
  assert.ok(audit.includes('/api/auth/me'));
  assert.ok(audit.includes('Bank Feed'));
  assert.ok(audit.includes('Scheduled'));
});

test('Offline Block A O1: install shell includes iOS metadata, PNG icons and offline data module',()=>{
  const html=read('index.html'),manifest=JSON.parse(read('manifest.webmanifest')),sw=read('service-worker.js');
  assert.match(html,/apple-mobile-web-app-capable/);
  assert.match(html,/apple-touch-icon/);
  assert.ok(manifest.icons.some(icon=>icon.src==='/assets/icon-192.png'&&icon.sizes==='192x192'));
  assert.ok(manifest.icons.some(icon=>icon.src==='/assets/icon-512.png'&&icon.sizes==='512x512'));
  assert.ok(existsSync(join(ROOT,'assets/icon-192.png')));
  assert.ok(existsSync(join(ROOT,'assets/icon-512.png')));
  assert.match(sw,/\/lib\/offline-db\.js/);
  assert.match(sw,/\/assets\/icon-192\.png/);
  assert.match(sw,/\/assets\/icon-512\.png/);
  assert.match(sw,/url\.pathname\.startsWith\('\/api\/'\)/);
});

test('Offline Block A O2: IndexedDB schema has normalized core ledger stores and metadata',()=>{
  const source=read('lib/offline-db.js');
  assert.match(source,/name: 'money-tracker-offline'/);
  assert.match(source,/version: 1/);
  for(const store of ['meta','people','accounts','entries','categories','budgets']) assert.ok(source.includes("'"+store+"'"),store);
  assert.match(source,/createObjectStore\(META_STORE,\{keyPath:'key'\}\)/);
  assert.match(source,/createObjectStore\(name,\{keyPath:'id'\}\)/);
  assert.match(source,/STATE_HEAD_KEY='state-head'/);
  assert.match(source,/schemaVersion:OFFLINE_DB\.version/);
  assert.match(source,/saveStateSnapshot/);
  assert.match(source,/loadStateSnapshot/);
  assert.match(source,/clearOfflineData/);
});

test('Offline Block A O3: authenticated reads fall back to local snapshots only on network failure',()=>{
  const store=read('lib/store.js');
  assert.match(store,/loadAuthorizedUser/);
  assert.match(store,/loadStateSnapshot/);
  assert.match(store,/if\(e\.offline\)/);
  assert.match(store,/const cached=await loadAuthorizedUser/);
  assert.match(store,/const cached=await loadStateSnapshot/);
  assert.match(store,/if\(e\.status===401\)\{ await clearOfflineData/);
  assert.match(store,/finally \{ csrfToken=''; await clearOfflineData/);
  assert.match(store,/if \(isLedgerState\(data\)\) await saveStateSnapshot/);
});

test('Offline Block A stays read-only and does not fake server-only features',()=>{
  const app=read('app.js');
  assert.match(app,/Offline mode is read-only for now\. Reconnect to save changes\./);
  assert.ok(app.includes('Offline · read only'));
  assert.ok(app.includes("renderOfflineServerFeature(main,'Bank Feed'"));
  assert.ok(app.includes("renderOfflineServerFeature(main,'Scheduled & Reminders'"));
  assert.match(app,/cached ledger remains available in Dashboard, People, Accounts, Activity, Insights and Reports/i);
});
