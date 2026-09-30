import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';

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
  assert.match(sw,/\/lib\/money-parse\.js/);
  assert.match(sw,/\/assets\/icon-192\.png/);
  assert.match(sw,/\/assets\/icon-512\.png/);
  assert.match(sw,/url\.pathname\.startsWith\('\/api\/'\)/);
});

test('Offline Block A O1: every relative dependency in the cached client module graph is precached',()=>{
  const sw=read('service-worker.js');
  const core=/const CORE=\[([\s\S]*?)\];/.exec(sw)?.[1]||'';
  const urls=[...core.matchAll(/'([^']+)'/g)].map(match=>match[1]);
  const cached=new Set(urls.map(url=>url.split('?')[0]));
  const modules=[...cached].filter(path=>path.endsWith('.js')&&existsSync(join(ROOT,path.replace(/^\//,''))));
  for(const modulePath of modules){
    const source=read(modulePath.replace(/^\//,''));
    const imports=[...source.matchAll(/import\s+(?:[^'\"]+?\s+from\s+)?['\"]([^'\"]+)['\"]/g)].map(match=>match[1]).filter(specifier=>specifier.startsWith('.'));
    for(const specifier of imports){
      const dependency=posix.normalize(posix.join(posix.dirname(modulePath),specifier));
      assert.ok(cached.has(dependency),modulePath+' imports uncached dependency '+dependency);
    }
  }
});

test('Offline Block A O2: IndexedDB schema has normalized core ledger stores and metadata',()=>{
  const source=read('lib/offline-db.js');
  assert.match(source,/name: 'money-tracker-offline'/);
  assert.match(source,/version: 2/);
  for(const store of ['meta','people','accounts','entries','categories','budgets','syncQueue','syncState']) assert.ok(source.includes("'"+store+"'"),store);
  assert.match(source,/createObjectStore\(META_STORE,\{keyPath:'key'\}\)/);
  assert.match(source,/createObjectStore\(name,\{keyPath:'id'\}\)/);
  assert.match(source,/STATE_HEAD_KEY='state-head'/);
  assert.match(source,/schemaVersion:OFFLINE_DB\.version/);
  assert.match(source,/saveStateSnapshot\(state,expectedIdentity=''/);
  assert.match(source,/db\.transaction\(\[META_STORE,\.\.\.LEDGER_STORES\],'readwrite'\)/);
  assert.match(source,/activeRequest\.result\?\.identity!==identity/);
  assert.match(source,/identityMismatch=true;[\s\S]*?tx\.abort\(\)/);
  assert.match(source,/loadStateSnapshot/);
  assert.match(source,/clearOfflineData\(expectedIdentity=''/);
});

test('Offline Block A O3: authenticated reads are identity-bound and 401 responses invalidate matching local data',()=>{
  const store=read('lib/store.js');
  assert.match(store,/const requestIdentity=authenticatedIdentity/);
  assert.match(store,/res\.status===401&&requestIdentity/);
  assert.match(store,/clearOfflineData\(requestIdentity\)/);
  assert.match(store,/saveStateSnapshot\(data,requestIdentity\)/);
  assert.match(store,/const cachedBefore=await loadAuthorizedUser/);
  assert.match(store,/if\(e\.offline&&cachedBefore\)/);
  assert.match(store,/const cached=await loadStateSnapshot/);
  assert.match(store,/adoptAuthenticatedUser/);
});

test('Offline Block A cached-read foundation remains intact after Block B adds writes',()=>{
  const app=read('app.js');
  assert.doesNotMatch(app,/Offline mode is read-only for now/);
  assert.ok(app.includes('Offline · changes save locally'));
  assert.ok(app.includes("renderOfflineServerFeature(main,'Bank Feed'"));
  assert.ok(app.includes("renderOfflineServerFeature(main,'Scheduled & Reminders'"));
  assert.match(app,/cached ledger remains available in Dashboard, People, Accounts, Activity, Insights and Reports/i);
});
