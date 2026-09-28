import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBankCsv, parseBankDate, suggestBankMapping, normalizeBankRows } from '../lib/bank-feed.js';

test('parses quoted CSV bank statements',()=>{
  const parsed=parseBankCsv('Date,Description,Amount\n2026-09-01,"Shop, Beirut",-12.50\n');
  assert.deepEqual(parsed.headers,['Date','Description','Amount']);
  assert.equal(parsed.rows[0].Description,'Shop, Beirut');
});

test('suggests common statement columns',()=>{
  const m=suggestBankMapping(['Posting Date','Narrative','Debit','Credit','Currency']);
  assert.equal(m.date,'Posting Date'); assert.equal(m.description,'Narrative'); assert.equal(m.debit,'Debit'); assert.equal(m.credit,'Credit');
});

test('normalizes debit and credit rows into signed amounts',()=>{
  const rows=[
    {'Date':'28/09/2026','Memo':'Amazon','Debit':'25.40','Credit':'','CCY':'USD'},
    {'Date':'29/09/2026','Memo':'Salary','Debit':'','Credit':'1000','CCY':'USD'}
  ];
  const out=normalizeBankRows(rows,{date:'Date',description:'Memo',debit:'Debit',credit:'Credit',currency:'CCY'},{dateOrder:'dmy'});
  assert.equal(out.errors.length,0); assert.equal(out.items[0].signedAmount,-25.4); assert.equal(out.items[1].signedAmount,1000);
});

test('supports positive-outflow amount statements and date order',()=>{
  const rows=[{Date:'09/28/2026',Details:'Card purchase',Amount:'19.99'}];
  const out=normalizeBankRows(rows,{date:'Date',description:'Details',amount:'Amount'},{dateOrder:'mdy',amountDirection:'outflow_positive',fallbackCurrency:'USD'});
  assert.equal(out.items[0].date,'2026-09-28'); assert.equal(out.items[0].signedAmount,-19.99);
  assert.equal(parseBankDate('28/09/2026','dmy'),'2026-09-28');
});
