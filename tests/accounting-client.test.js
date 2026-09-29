import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read=file=>readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
const app=read('app.js');
const modal=(()=>{const start=app.indexOf('function openTransactionModal');const end=app.indexOf('function openTransferModal');assert.ok(start>0&&end>start);return app.slice(start,end);})();

test('A1: Simple mode hides, clears and disables the account field so nothing posts to it',()=>{
  assert.match(modal,/accEl\.disabled=true/);
  assert.match(modal,/accEl\.value=''/);
  assert.match(modal,/accEl\.disabled=false/,'field is re-enabled and restored when shown again');
  assert.match(modal,/heldAccount/);
});

test('A1: submit derives accountId from the disabled state and uses it for every entry',()=>{
  assert.match(modal,/const accountId=accEl\.disabled\?null:\(fd\.get\('accountId'\)\|\|null\)/);
  assert.match(modal,/accountId:t==='person_adjustment'\?null:accountId/);
  assert.equal(/fd\.get\('accountId'\)\|\|null\),amount/.test(modal),false);
  assert.match(modal,/state\.accounts\.find\(a=>a\.id===accountId\)/,'currency lookup uses the effective account');
});

test('A1: server guards simple-mode debt in cleanLedgerEntry, not validateState',()=>{
  const server=read('server.mjs');
  const clean=server.slice(server.indexOf('function cleanLedgerEntry'),server.indexOf('function updateLedgerEntryRow'));
  const validate=server.slice(server.indexOf('function validateState'),server.indexOf('const RECURRING_TYPES'));
  assert.match(clean,/app_mode==='simple'/);
  assert.match(clean,/Simple mode records debt without an account\. Switch to Advanced mode to charge an account\./);
  assert.equal(/Simple mode records debt/.test(validate),false);
  assert.equal(/SIMPLE_MODE_DEBT_TYPES/.test(validate),false);
});

test('A2: Advanced type list and fallback offer Account adjustment',()=>{
  const options=app.slice(app.indexOf('function entryTypeOptions'),app.indexOf('async function showAuth'));
  assert.match(options,/\['account_adjustment','Account adjustment'\]/);
  assert.equal(options.includes("const advanced=[['account_expense','Account expense'],['account_income','Account income'],['account_adjustment','Account adjustment']]"),true);
  assert.match(options,/fallback=\[\.\.\.advanced/);
});

test('A2: transaction modal treats account_adjustment as an adjustment',()=>{
  assert.match(modal,/acctAdjust=t==='account_adjustment'/);
  assert.match(modal,/Increase this account/);
  assert.match(modal,/Decrease this account/);
  assert.match(modal,/Choose the account to adjust/);
  assert.match(modal,/if\(t==='person_adjustment'\|\|acctAdjust\) item\.signedAmount=\(fd\.get\('direction'\)==='i_owe'\?-1:1\)\*amount/);
  assert.match(modal,/personId:\(split\|\|needsAccount\)\?null:person/);
  assert.match(modal,/categoryId:accountOnly\?/,'category only for expense/income');
  assert.match(modal,/splits:split\?splits:\[\]/);
  assert.match(modal,/currency:acc\?\.currency\|\|fd\.get\('currency'\)/);
});

test('A2: opening balance is locked in the account form once transactions exist',()=>{
  assert.match(app,/openingLocked/);
  assert.match(app,/Adjust balance/);
});

test('A2: server and importer know the account_adjustment type',()=>{
  const server=read('server.mjs');
  assert.match(server,/allowedTypes=new Set\(\[[^\]]*'account_adjustment'\]\)/);
  assert.match(server,/Post an account adjustment instead of changing the opening balance/);
  const importer=read('lib/importer.js');
  assert.match(importer,/account_adjustment:\['account adjustment'\]/);
});

test('B6: client date defaults use the ledger timezone',()=>{
  assert.match(app,/dateInTimeZone\(state\.settings\.timezone\)/);
  assert.equal((app.match(/\$\{existing\?\.date\|\|localToday\(\)\}/g)||[]).length,2,'transaction and transfer modal defaults');
  assert.match(app,/openingDate:localToday\(\)/);
  assert.match(read('block-e-recurring.js'),/state\.settings\.timezone/);
});

test('B9: dead totalsByCurrency helper is gone everywhere',()=>{
  for(const file of ['lib/ledger.js','app.js','server.mjs','lib/reporting.js','lib/insights.js'])assert.equal(/totalsByCurrency/.test(read(file)),false,file);
});
