import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('Wave 2 keeps Simple mode phone layouts inside the viewport and preserves a global Add action',()=>{
  const mobile=read('mobile.css'),app=read('app.js');
  assert.match(mobile,/html,body\{max-width:100%;overflow-x:hidden\}/);
  assert.match(mobile,/\.top-actions #quickEntry\{[\s\S]*?display:inline-flex!important/);
  const hardening=mobile.slice(mobile.indexOf('Waves 2–3'));
  assert.match(hardening,/\.stats\.debt-stats\{[\s\S]*?grid-template-columns:repeat\(2,minmax\(0,1fr\)\)[\s\S]*?overflow:visible/);
  assert.match(hardening,/\.stats\.debt-stats>\.stat:nth-child\(3\)\{grid-column:1\/-1\}/);
  assert.match(hardening,/\.form-grid\{grid-template-columns:1fr!important\}/);
  assert.match(app,/id="quickEntry"/);
  assert.match(app,/account-detail-actions/);
});

test('Wave 2 Reports stay simple in Simple mode and use card tables on phones',()=>{
  const reports=read('lib/reports-ui.js'),mobile=read('mobile.css');
  assert.match(reports,/const advanced = state\.settings\?\.appMode === 'advanced'/);
  assert.match(reports,/const filters = advanced \? routeFilters : \{\.\.\.routeFilters,accountId:'',categoryId:'',type:'',currency:''\}/);
  assert.match(reports,/advanced\?[\s\S]*?report-more-filters/);
  assert.match(reports,/mobile-card-table-wrap/);
  assert.match(reports,/data-label="Person"/);
  assert.match(reports,/data-label="Net person change"/);
  assert.match(mobile,/\.mobile-card-table thead\{display:none\}/);
  assert.match(mobile,/\.report-table-wrap\{overflow:visible!important\}/);
});

test('Wave 2 Settings user management is a labeled mobile card list',()=>{
  const app=read('app.js');
  assert.match(app,/table-wrap mobile-card-table-wrap/);
  assert.match(app,/table mobile-card-table/);
  assert.match(app,/data-label="Email" data-mobile-wide="true"/);
  assert.match(app,/data-label="Role"/);
  assert.match(app,/data-label="Created"/);
});

test('Wave 3 Bank Feed, Insights, recurring and import flows have phone-safe structures',()=>{
  const mobile=read('mobile.css'),bank=read('block-f-bank-feed.js'),insights=read('block-g-insights.js'),recurring=read('block-e-recurring.js'),importer=read('block-c-import.js');
  assert.match(mobile,/\.bank-status-tabs\{[\s\S]*?grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(mobile,/\.account-detail-actions\{/);
  assert.match(mobile,/\.recurring-meta\{display:grid;grid-template-columns:1fr 1fr\}/);
  assert.match(bank,/mobile-card-table/);
  assert.match(bank,/data-label="Duplicates"/);
  assert.match(insights,/mobile-card-table/);
  assert.match(insights,/data-label="Expenses"/);
  assert.match(importer,/mobile-card-table/);
  assert.match(importer,/data-label="Merchant \/ source"/);
  assert.match(importer,/data-label="Person \/ account"/);
  assert.match(recurring,/recurring-grid|recurring-card/);
});

test('Wave 3 import and advanced table cards carry labels instead of requiring horizontal scanning',()=>{
  const importer=read('block-c-import.js'),bank=read('block-f-bank-feed.js'),insights=read('block-g-insights.js');
  assert.match(importer,/data-label="\$\{escapeHtml\(h\)\}"/);
  assert.match(importer,/data-label="Expected"/);
  assert.match(importer,/data-label="Delta"/);
  assert.match(bank,/data-label="Imported" data-mobile-wide="true"/);
  assert.match(insights,/data-label="Month" data-mobile-wide="true"/);
  assert.match(insights,/data-label="Net"/);
});

test('mobile asset URLs move together so installed phones do not mix old and new UI files',()=>{
  const html=read('index.html'),sw=read('service-worker.js');
  assert.match(html,/money-tracker-build/);
  for(const path of ['./mobile.css','./activity.css','./app.js'])assert.ok(html.includes(path),path);
  for(const path of ['/mobile.css','/activity.css','/app.js'])assert.ok(sw.includes("'"+path+"'"),path);
  assert.doesNotMatch(html,/mobile-v\\d+/);
  assert.match(sw,/shellUrl/);
});
