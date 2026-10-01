import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { transactionFxRate, historicalFxRates, FX_POLICY } from '../lib/fx.js';
import { reportingSnapshot, exportRows, workbookSheets } from '../lib/reporting.js';
import { buildPdfReport } from '../lib/pdf.js';
import { buildXlsx } from '../lib/xlsx.js';

const ROOT=dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const read=path=>readFileSync(join(ROOT,path),'utf8');

const state={
  version:12,
  settings:{displayName:'Offline FX Ledger',defaultCurrency:'USD',appMode:'advanced',timezone:'UTC'},
  people:[],
  accounts:[
    {id:'usd',name:'USD Bank',type:'bank',currency:'USD',openingBalance:1000},
    {id:'eur',name:'EUR Wallet',type:'cash',currency:'EUR',openingBalance:0}
  ],
  categories:[],
  budgets:[],
  entries:[
    {id:'fx1',type:'account_transfer',fromAccountId:'usd',toAccountId:'eur',fromAmount:100,toAmount:92,date:'2026-10-01',description:'Travel transfer',createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'},
    {id:'same',type:'account_transfer',fromAccountId:'usd',toAccountId:'usd',fromAmount:10,toAmount:10,date:'2026-10-01',description:'Internal',createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'}
  ]
};

test('Offline Block E documents O16-O19 and their safety boundaries',()=>{
  const doc=read('docs/OFFLINE_BLOCK_E.md');
  for(const marker of ['O16','O17','O18','O19','PDF','Excel','recorded_transfer','service worker','IndexedDB','v3 → v4'])assert.ok(doc.includes(marker),marker);
  assert.match(doc,/does not invent a live exchange rate/i);
  assert.match(doc,/server remains authoritative/i);
});

test('O16 reports, PDF and XLSX are client-only builders',()=>{
  const ui=read('lib/reports-ui.js'),pdf=read('lib/pdf.js'),xlsx=read('lib/xlsx.js');
  assert.doesNotMatch(ui,/fetch\(/);
  assert.doesNotMatch(pdf,/fetch\(/);
  assert.doesNotMatch(xlsx,/fetch\(/);
  assert.match(ui,/remain available offline/);
  const snap=reportingSnapshot(state);
  const pdfBytes=buildPdfReport(state,snap);
  const xlsxBytes=buildXlsx(workbookSheets(state),{title:'offline'});
  assert.equal(new TextDecoder().decode(pdfBytes.slice(0,8)).startsWith('%PDF-1.4'),true);
  assert.deepEqual(Array.from(xlsxBytes.slice(0,4)),[0x50,0x4b,0x03,0x04]);
});

test('O17 derives FX only from recorded cross-currency transfer amounts',()=>{
  const rate=transactionFxRate(state.entries[0],state.accounts);
  assert.equal(rate.pair,'USD/EUR');
  assert.equal(rate.rate,0.92);
  assert.equal(rate.inverseRate,1/0.92);
  assert.equal(rate.source,'recorded_transfer');
  assert.equal(transactionFxRate(state.entries[1],state.accounts),null);
  assert.equal(transactionFxRate({...state.entries[0],fromAmount:0},state.accounts),null);
  assert.equal(FX_POLICY.mode,'recorded-transfers-only');
  assert.deepEqual(historicalFxRates(state.entries,state.accounts).map(row=>row.entryId),['fx1']);
});

test('O17 exposes recorded FX in snapshot, transaction export, workbook and PDF without collapsing currencies',()=>{
  const snap=reportingSnapshot(state);
  assert.equal(snap.fxRates.length,1);
  assert.equal(snap.fxRates[0].rate,0.92);
  assert.deepEqual(snap.transferFlow,[{month:'2026-10',currencies:{USD:-100,EUR:92}}]);
  const row=exportRows(state).find(item=>item['Entry ID']==='fx1');
  assert.equal(row['FX Pair'],'USD/EUR');
  assert.equal(row['FX Rate'],0.92);
  assert.equal(row['FX Rate Source'],'recorded_transfer');
  const sheets=workbookSheets(state);
  assert.ok(sheets.find(sheet=>sheet.name==='FX Rates'));
  assert.ok(sheets.find(sheet=>sheet.name==='Metadata').rows.some(row=>row[0]==='FX Policy'));
  const pdf=new TextDecoder().decode(buildPdfReport(state,snap));
  assert.match(pdf,/Recorded FX rates/);
  assert.match(pdf,/no live conversion is applied/);
});

test('O18 publishes update schema metadata and blocks activation around unsynced work',()=>{
  const pwa=read('lib/pwa.js'),sw=read('service-worker.js'),version=read('pwa-version.js'),app=read('app.js');
  const shellVersion=Number(version.match(/version:(\d+)/)?.[1]||0);
  assert.ok(shellVersion>=29);
  assert.match(version,/offlineDbVersion:6/);
  assert.match(version,/minMigratableOfflineDbVersion:1/);
  assert.match(sw,/GET_UPDATE_INFO/);
  assert.match(sw,/offlineDbVersion:self\.MONEY_TRACKER_PWA\.offlineDbVersion/);
  assert.match(sw,/minMigratableOfflineDbVersion:self\.MONEY_TRACKER_PWA\.minMigratableOfflineDbVersion/);
  assert.match(pwa,/waitingWorkerInfo/);
  assert.match(pwa,/pendingCount/);
  assert.match(pwa,/Sync or resolve queued offline changes before updating the app/);
  assert.match(pwa,/metadataValid/);
  assert.match(pwa,/targetDb>=currentDb/);
  assert.match(pwa,/updateInfo\.compatible!==true/);
  assert.match(pwa,/could not verify this update/);
  assert.match(app,/pendingCount:syncInfo\.pending/);
  assert.match(app,/Sync before update/);
  assert.match(app,/Update blocked/);
});

test('O19 migrations remain intact after the additive v5 Bank Feed extension',()=>{
  const offline=read('lib/offline-db.js');
  assert.match(offline,/version: 6/);
  assert.match(offline,/fromVersion<1/);
  assert.match(offline,/fromVersion<2/);
  assert.match(offline,/fromVersion<3/);
  assert.match(offline,/fromVersion<4/);
  assert.match(offline,/fromVersion<5/);
  assert.match(offline,/fromVersion<6/);
  assert.match(offline,/FX_RATE_STORE='fxRates'/);
  assert.match(offline,/strategy:'additive-atomic'/);
  assert.match(offline,/finishPostOpenMigrations/);
  assert.match(offline,/fxBackfilledAt/);
  assert.match(offline,/export async function offlineSchemaInfo/);
  assert.match(offline,/export async function offlineFxRates/);
  assert.match(offline,/applyPulledChanges[\s\S]*?rebuildFxRateCache\(identity\)/);
  assert.match(offline,/rebaseQueuedOperations[\s\S]*?await rebuildFxRateCache\(identity\)/);
  assert.match(offline,/strategy:'retained-after-user-clear'/);
});

test('Block E is wired into shell, health and CI gates',()=>{
  const sw=read('service-worker.js'),server=read('server.mjs'),ci=read('.github/workflows/ci.yml'),pkg=JSON.parse(read('package.json'));
  assert.match(sw,/\/lib\/fx\.js/);
  assert.match(server,/offlineBlockEVersion:1/);
  assert.equal(pkg.scripts['test:offline-e'],'node --test tests/offline-block-e.test.js');
  assert.equal(pkg.scripts['test:offline-e-e2e'],'playwright test e2e/offline-block-e.spec.mjs --workers=1');
  assert.match(ci,/Run Offline Block E contract gate/);
  assert.match(ci,/Run Offline Block E browser gate/);
  assert.match(ci,/node --check lib\/fx\.js/);
});
