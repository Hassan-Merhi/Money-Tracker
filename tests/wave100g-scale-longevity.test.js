import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DATA_LIMITS } from '../lib/data-limits.js';
import { filteredEntries, reportingSnapshot, workbookSheets } from '../lib/reporting.js';
import { buildXlsx } from '../lib/xlsx.js';

const ROOT=dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const read=path=>readFileSync(join(ROOT,path),'utf8');

function scaleState(entryCount=DATA_LIMITS.entries){
  const people=Array.from({length:DATA_LIMITS.people},(_,i)=>({id:`person_${i}`,name:`Person ${i}`,note:i%97===0?'long lived contact':''}));
  const accounts=Array.from({length:DATA_LIMITS.accounts},(_,i)=>({id:`account_${i}`,name:`Account ${i}`,type:'bank',currency:'USD',openingBalance:1000}));
  const categories=Array.from({length:DATA_LIMITS.categories},(_,i)=>({id:`category_${i}`,name:`Category ${i}`,kind:'expense'}));
  const entries=Array.from({length:entryCount},(_,i)=>{
    const date=`${2018+(i%9)}-${String((i%12)+1).padStart(2,'0')}-${String((i%28)+1).padStart(2,'0')}`;
    if(i%10===0)return {id:`entry_${i}`,type:'account_transfer',fromAccountId:`account_${i%1000}`,toAccountId:`account_${(i+1)%1000}`,fromAmount:2,toAmount:2,amount:2,date,description:'Scale transfer',createdAt:date+'T00:00:00Z',updatedAt:date+'T00:00:00Z'};
    if(i%3===0)return {id:`entry_${i}`,type:'account_expense',accountId:`account_${i%1000}`,amount:1,currency:'USD',date,merchant:i===entryCount-1?'Needle Merchant':(i%1000===0?'Needle Merchant':'Merchant'),description:'Scale expense',categoryId:`category_${i%250}`,createdAt:date+'T00:00:00Z',updatedAt:date+'T00:00:00Z'};
    return {id:`entry_${i}`,type:i%2?'paid_for_person':'received_from_person',personId:`person_${i%10000}`,amount:1,currency:'USD',date,merchant:i===entryCount-1?'Needle Merchant':'',description:'Scale person row',createdAt:date+'T00:00:00Z',updatedAt:date+'T00:00:00Z'};
  });
  if(entries.length){
    entries[entries.length-1]={...entries[entries.length-1],personId:'person_9999',type:'paid_for_person',merchant:'Needle Merchant',currency:'USD',amount:1};
  }
  return {version:entryCount+1,settings:{displayName:'Scale Ledger',defaultCurrency:'USD',appMode:'advanced',timezone:'UTC'},people,accounts,categories,budgets:[],entries};
}

test('Wave 100G keeps 50k-entry local search/filter work bounded',()=>{
  const state=scaleState(DATA_LIMITS.entries);
  const started=performance.now();
  const rows=filteredEntries(state,{q:'needle person 9999',currency:'USD'});
  const elapsed=performance.now()-started;
  assert.ok(rows.some(row=>row.id===`entry_${DATA_LIMITS.entries-1}`));
  assert.ok(elapsed<5000,`50k search/filter took ${elapsed.toFixed(0)}ms; expected <5000ms.`);
});

test('Wave 100G builds a multi-year 20k reporting snapshot without duplicate full-ledger map construction',()=>{
  const state=scaleState(20000);
  const started=performance.now();
  const snapshot=reportingSnapshot(state,{from:'2019-01-01',to:'2026-12-31'});
  const elapsed=performance.now()-started;
  assert.ok(snapshot.transactionCount>10000);
  assert.ok(snapshot.receivablesMovement.length>=12);
  const reportYears=new Set(snapshot.receivablesMovement.map(row=>String(row.month).slice(0,4)));
  assert.ok(reportYears.size>=4,'Expected multi-year receivables coverage.');
  assert.equal(snapshot.accounts.length,DATA_LIMITS.accounts);
  assert.ok(elapsed<10000,`20k reporting snapshot took ${elapsed.toFixed(0)}ms; expected <10000ms.`);
});

test('Wave 100G keeps large workbook generation within a release budget',()=>{
  const state=scaleState(5000);
  const started=performance.now();
  const sheets=workbookSheets(state);
  const bytes=buildXlsx(sheets,{title:'Wave 100G scale'});
  const elapsed=performance.now()-started;
  const transactions=sheets.find(sheet=>sheet.name==='Transactions');
  assert.equal(transactions.rows.length,5001);
  assert.ok(bytes.length>100000);
  assert.ok(elapsed<15000,`5k XLSX generation took ${elapsed.toFixed(0)}ms; expected <15000ms.`);
});

test('Wave 100G removes repeated whole-ledger and lookup-map scale scans',()=>{
  const server=read('server.mjs'),reporting=read('lib/reporting.js'),query=read('lib/offline-query.js');
  assert.match(server,/entryUsesPerson: db\.prepare/);
  assert.match(server,/entryUsesAccount: db\.prepare/);
  const person=/function personUsedByEntry\(userId,id\)\{([\s\S]*?)\n\}/.exec(server)?.[1]||'';
  const account=/function accountUsedByEntry\(userId,id\)\{([\s\S]*?)\n\}/.exec(server)?.[1]||'';
  assert.match(person,/q\.entryUsesPerson\.get/);
  assert.match(account,/q\.entryUsesAccount\.get/);
  assert.doesNotMatch(person,/loadState\(/);
  assert.doesNotMatch(account,/loadState\(/);
  assert.match(query,/export function buildSearchContext/);
  assert.match(reporting,/const searchContext=q\?buildSearchContext\(state\):null/);
  assert.match(reporting,/reportingSnapshot\(state,filters,\{peopleBalances,accountBalances:accountBalanceMap\}\)/);
});

test('Wave 100G uses indexed offline schema v8 and bounded sync delta history',()=>{
  const offline=read('lib/offline-db.js'),server=read('server.mjs'),limits=read('lib/data-limits.js');
  assert.match(offline,/version: 8/);
  for(const marker of [
    "ensureIndex(SYNC_QUEUE_STORE,'byIdentity','identity')",
    "ensureIndex(ATTACHMENT_QUEUE_STORE,'byIdentity','identity')",
    "ensureIndex(BANK_FEED_QUEUE_STORE,'byIdentity','identity')",
    "ensureIndex(RECURRING_QUEUE_STORE,'byIdentity','identity')",
    "ensureIndex(ATTACHMENT_STORE,'byIdentityEntry',['identity','entryId'])"
  ])assert.ok(offline.includes(marker),marker);
  assert.match(offline,/postOpenComplete:fromVersion===0\|\|fromVersion>=4/);
  assert.match(limits,/syncChangeRevisions:10000/);
  assert.match(server,/deleteChangesThrough/);
  assert.match(server,/revision-DATA_LIMITS\.syncChangeRevisions/);
});

test('Wave 100G production and CI contracts are wired',()=>{
  const doc=read('docs/WAVE_100G_SCALE_LONGEVITY.md'),version=read('pwa-version.js'),server=read('server.mjs'),smoke=read('lib/production-smoke.js'),pkg=JSON.parse(read('package.json')),ci=read('.github/workflows/ci.yml');
  for(const marker of ['50,000 ledger transactions','10,000 attachments','IndexedDB v8','10,000 ledger revisions','full refresh'])assert.ok(doc.includes(marker),marker);
  assert.match(version,/version:37/);
  assert.match(version,/cacheName:'money-tracker-debt-v37'/);
  assert.match(version,/offlineDbVersion:8/);
  assert.match(server,/offlineWave100GVersion:1/);
  assert.match(server,/syncChangeRevisions:DATA_LIMITS\.syncChangeRevisions/);
  assert.match(smoke,/offlineWave100GVersion/);
  assert.equal(pkg.scripts['test:wave100g'],'node --test tests/wave100g-scale-longevity.test.js tests/wave100g-scale-server.test.js');
  assert.equal(pkg.scripts['test:wave100g-e2e'],'playwright test e2e/wave100g-scale-longevity.spec.mjs --workers=1');
  assert.match(ci,/Run Wave 100G Scale & Longevity gate/);
  assert.match(ci,/Run Wave 100G Scale & Longevity browser gate/);
});
