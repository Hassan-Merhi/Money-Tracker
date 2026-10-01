import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importedStateMutations } from '../lib/store.js';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

function state(){
  const t='2026-10-01T00:00:00.000Z';
  return {
    version:7,
    settings:{displayName:'Ledger',defaultCurrency:'USD',appMode:'advanced',timezone:'Asia/Beirut'},
    people:[{id:'person_existing',name:'Existing',note:'',createdAt:t}],
    accounts:[],
    entries:[],
    categories:[],
    budgets:[]
  };
}

test('Wave 100I imported-state diff produces ordered create/update mutations',()=>{
  const before=state(),after=structuredClone(before),t='2026-10-01T01:00:00.000Z';
  after.people[0].note='Updated by legacy import';
  after.people.push({id:'person_imported',name:'Imported Person',note:'Offline XLSX',createdAt:t});
  after.accounts.push({id:'account_imported',name:'Imported Bank',type:'bank',currency:'USD',openingBalance:50,createdAt:t});
  after.entries.push({id:'entry_imported',type:'person_adjustment',personId:'person_imported',accountId:null,fromAccountId:null,toAccountId:null,amount:25,currency:'USD',fromAmount:null,toAmount:null,signedAmount:25,date:'2026-10-01',merchant:'',description:'Imported opening balance',createdAt:t,updatedAt:t});
  const specs=importedStateMutations(before,after);
  assert.deepEqual(specs.map(row=>[row.entity,row.operation,row.entityId]),[
    ['person','update','person_existing'],
    ['person','create','person_imported'],
    ['account','create','account_imported'],
    ['entry','create','entry_imported']
  ]);
  assert.ok(specs.every(row=>/^op_/.test(row.operationId)));
  assert.equal(specs.at(-1).payload.personId,'person_imported');
});

test('Wave 100I import diff rejects destructive or stale replacement semantics',()=>{
  const before=state();
  const deleted=structuredClone(before);deleted.people=[];
  assert.throws(()=>importedStateMutations(before,deleted),/cannot delete/i);
  const stale=structuredClone(before);stale.version=8;
  assert.throws(()=>importedStateMutations(before,stale),/ledger changed/i);
  const categoryChange=structuredClone(before);categoryChange.categories=[{id:'category_new',name:'Nope',kind:'expense'}];
  assert.throws(()=>importedStateMutations(before,categoryChange),/categories or budgets/i);
  const settingsChange=structuredClone(before);settingsChange.settings.displayName='Other';
  assert.throws(()=>importedStateMutations(before,settingsChange),/settings/i);
});

test('Wave 100I Block C parses workbooks locally and routes every apply path through the offline-aware commit',()=>{
  const block=read('block-c-import.js');
  assert.match(block,/parseWorkbookInBrowser/);
  assert.match(block,/commitImportedState/);
  assert.doesNotMatch(block,/previewSpreadsheet/);
  assert.doesNotMatch(block,/saveState\s*\(/);
  assert.ok((block.match(/commitImportedState\(prepared\.state\)/g)||[]).length===3);
  assert.match(block,/Import queued offline/);
  assert.match(block,/Legacy import queued offline/);
  assert.match(block,/Paste import queued offline/);
});

test('Wave 100I offline DB provides one atomic durable batch transaction',()=>{
  const db=read('lib/offline-db.js');
  assert.match(db,/export async function enqueueLocalMutations/);
  assert.match(db,/Offline import contains too many changes/);
  assert.match(db,/db\.transaction\(\[META_STORE,\.\.\.LEDGER_STORES,SYNC_QUEUE_STORE,SYNC_STATE_STORE,TOMBSTONE_STORE\],'readwrite'\)/);
  assert.match(db,/head\.head\.version=revision/);
  assert.match(db,/baseRevision:revision/);
});

test('Wave 100I production and CI contracts are wired',()=>{
  const version=read('pwa-version.js'),server=read('server.mjs'),smoke=read('lib/production-smoke.js'),pkg=JSON.parse(read('package.json')),ci=read('.github/workflows/ci.yml'),doc=read('docs/WAVE_100I_OFFLINE_IMPORT_MIGRATION.md'),readme=read('README.md');
  assert.match(version,/version:39/);
  assert.match(version,/cacheName:'money-tracker-debt-v39'/);
  assert.match(version,/offlineDbVersion:8/);
  assert.match(server,/offlineWave100IVersion:1/);
  assert.match(smoke,/offlineWave100IVersion/);
  assert.match(smoke,/pwaCacheVersion\|\|0\)>=39/);
  assert.equal(pkg.scripts['test:wave100i'],'node --test tests/wave100i-offline-import-migration.test.js');
  assert.equal(pkg.scripts['test:wave100i-e2e'],'playwright test e2e/wave100i-offline-import-migration.spec.mjs --workers=1');
  assert.match(ci,/Run Wave 100I Offline Import & Migration gate/);
  assert.match(ci,/Run Wave 100I Offline Import & Migration browser gate/);
  assert.match(readme,/on-device workbook parsing, including while offline/);
  for(const marker of ['PWA shell **v39**','IndexedDB **v8**','offlineWave100IVersion: 1','Quick Excel Paste'])assert.ok(doc.includes(marker),marker);
});
