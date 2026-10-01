import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildXlsx } from '../lib/xlsx.js';
import { parseWorkbookInBrowser } from '../lib/xlsx-browser.js';

const ROOT=dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const read=path=>readFileSync(join(ROOT,path),'utf8');

test('Wave 100H browser XLSX parser reads a normal workbook without server helpers',async()=>{
  const bytes=buildXlsx([{name:'Statement',rows:[
    ['Date','Description','Amount','Currency','Transaction ID'],
    ['2026-10-01','Offline XLSX coffee',-4.5,'USD','wave100h-xlsx-1'],
    ['2026-10-02','Offline XLSX salary',1000,'USD','wave100h-xlsx-2']
  ]}]);
  const parsed=await parseWorkbookInBrowser(bytes);
  const sheet=parsed.sheets.find(row=>row.name==='Statement');
  assert.ok(sheet);
  assert.deepEqual(sheet.headers,['Date','Description','Amount','Currency','Transaction ID']);
  assert.equal(sheet.rows.length,2);
  assert.equal(sheet.rows[0].Description,'Offline XLSX coffee');
  assert.equal(sheet.rows[0].Amount,-4.5);
  assert.equal(sheet.rows[1]['Transaction ID'],'wave100h-xlsx-2');
});

test('Wave 100H Bank Feed Excel preview is device-local and offline-capable',()=>{
  const bank=read('block-f-bank-feed.js');
  assert.match(bank,/parseWorkbookInBrowser/);
  assert.match(bank,/parsed on this device and queued safely even while offline/);
  assert.match(bank,/accept="\.csv,\.xlsx,\.xlsm/);
  assert.doesNotMatch(bank,/previewSpreadsheet/);
  assert.doesNotMatch(bank,/Excel statement preview needs a connection/);
  assert.doesNotMatch(read('lib/xlsx-browser.js'),/node:zlib|Buffer\.from|Buffer\.isBuffer/);
});

test('Wave 100H parser is part of the controlled PWA shell',()=>{
  const sw=read('service-worker.js'),version=read('pwa-version.js');
  assert.ok(sw.includes("'/lib/xlsx-browser.js'"));
  const shellVersion=Number(/version:(\d+)/.exec(version)?.[1]||0);
  assert.ok(shellVersion>=38,'Wave 100H requires PWA shell v38 or newer.');
  assert.match(version,/cacheName:'money-tracker-debt-v\d+'/);
  assert.match(version,/offlineDbVersion:8/);
});

test('Wave 100H production and CI contracts are wired',()=>{
  const server=read('server.mjs'),smoke=read('lib/production-smoke.js'),pkg=JSON.parse(read('package.json')),ci=read('.github/workflows/ci.yml'),doc=read('docs/WAVE_100H_OFFLINE_COMPLETENESS.md');
  assert.match(server,/offlineWave100HVersion:1/);
  assert.match(smoke,/offlineWave100HVersion/);
  const smokeFloor=Number(/pwaCacheVersion\\|\\|0\\)>=([0-9]+)/.exec(smoke)?.[1]||0);
  assert.ok(smokeFloor>=38,'Wave 100H requires production smoke to enforce PWA v38 or newer.');
  assert.equal(pkg.scripts['test:wave100h'],'node --test tests/wave100h-offline-completeness.test.js');
  assert.equal(pkg.scripts['test:wave100h-e2e'],'playwright test e2e/wave100h-offline-xlsx.spec.mjs --workers=1');
  assert.match(ci,/Run Wave 100H Offline Completeness gate/);
  assert.match(ci,/Run Wave 100H Offline Completeness browser gate/);
  for(const marker of ['offline XLSX/XLSM','PWA shell **v38**','IndexedDB **v8**','offlineWave100HVersion: 1'])assert.ok(doc.includes(marker),marker);
});

test('Wave 100H removes the stale README claim that all financial changes need a live connection',()=>{
  const readme=read('README.md');
  assert.match(readme,/offline-first PWA/);
  assert.doesNotMatch(readme,/financial changes remain server-authoritative and require a live connection/);
});
