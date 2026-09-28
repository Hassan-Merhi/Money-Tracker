import test from 'node:test';
import assert from 'node:assert/strict';
import { reportingSnapshot, workbookSheets, exportRows } from '../lib/reporting.js';

const t='2026-09-01T00:00:00Z';
const state={
  settings:{displayName:'Family Ledger',defaultCurrency:'USD'},
  people:[{id:'p1',name:'Alice',note:'Cousin',createdAt:t},{id:'p2',name:'Bob',note:'',createdAt:t}],
  accounts:[{id:'a1',name:'Bank',type:'bank',currency:'USD',openingBalance:1000,createdAt:t}],
  entries:[
    {id:'e1',type:'paid_for_person',personId:'p1',accountId:'a1',amount:120,currency:'USD',date:'2026-09-01',merchant:'Amazon',description:'Headphones',createdAt:t,updatedAt:t},
    {id:'e2',type:'received_from_person',personId:'p1',accountId:'a1',amount:20,currency:'USD',date:'2026-09-10',merchant:'',description:'Part payment',createdAt:t,updatedAt:t},
    {id:'e3',type:'borrowed_from_person',personId:'p2',accountId:'a1',amount:50,currency:'USD',date:'2026-09-15',merchant:'',description:'Loan',createdAt:t,updatedAt:t}
  ]
};

test('report snapshot calculates activity and outstanding balances',()=>{
  const s=reportingSnapshot(state);
  assert.equal(s.transactionCount,3);
  assert.deepEqual(s.activity.USD,{charged:120,recovered:20,borrowed:50,repaid:0,netPersonChange:50});
  assert.equal(s.outstanding.find(r=>r.personName==='Alice').amount,100);
  assert.equal(s.outstanding.find(r=>r.personName==='Bob').amount,-50);
  assert.equal(s.accounts[0].balance,950);
});

test('date filters affect report activity but not current outstanding balances',()=>{
  const s=reportingSnapshot(state,{from:'2026-09-10',to:'2026-09-30'});
  assert.equal(s.transactionCount,2);
  assert.equal(s.activity.USD.recovered,20);
  assert.equal(s.activity.USD.borrowed,50);
  assert.equal(s.outstanding.find(r=>r.personName==='Alice').amount,100);
});

test('workbook contains expected sheets and transaction columns',()=>{
  const sheets=workbookSheets(state);
  assert.deepEqual(sheets.map(s=>s.name),['Overview','Outstanding','People','Accounts','Transactions']);
  assert.ok(sheets.at(-1).rows[0].includes('Merchant'));
  assert.equal(exportRows(state).length,3);
});
