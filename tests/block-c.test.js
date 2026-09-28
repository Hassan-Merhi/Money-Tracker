import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbook, parseWorkbook, ledgerWorkbook, importTemplateWorkbook } from '../lib/xlsx.js';
import { createPdf, summaryPdf, personStatementPdf } from '../lib/pdf.js';

test('xlsx writer produces a readable workbook with typed values',()=>{
  const buf=createWorkbook([{name:'Test',headers:['Name','Amount'],rows:[{Name:'Alice',Amount:12.5},{Name:'Bob & Co',Amount:9}]}]);
  assert.equal(buf.subarray(0,2).toString('hex'),'504b');
  const parsed=parseWorkbook(buf); assert.equal(parsed.sheets[0].name,'Test'); assert.deepEqual(parsed.sheets[0].headers,['Name','Amount']); assert.equal(parsed.sheets[0].rows[0].Name,'Alice'); assert.equal(parsed.sheets[0].rows[0].Amount,12.5); assert.equal(parsed.sheets[0].rows[1].Name,'Bob & Co');
});

test('template workbook contains the expected import sheets',()=>{
  const parsed=parseWorkbook(importTemplateWorkbook());
  assert.deepEqual(parsed.sheets.map(s=>s.name),['README','People','Accounts','Transactions']);
});

test('ledger workbook exports people accounts and transactions',()=>{
  const state={settings:{defaultCurrency:'USD'},people:[{id:'person_1',name:'Alice',note:'Cousin'}],accounts:[{id:'account_1',name:'Bank',type:'bank',currency:'USD',openingBalance:100}],entries:[{id:'entry_1',date:'2026-09-28',type:'paid_for_person',personId:'person_1',accountId:'account_1',amount:10,currency:'USD',description:'Amazon'}]};
  const parsed=parseWorkbook(ledgerWorkbook(state,{peopleBalances:{person_1:{USD:10}}}));
  assert.equal(parsed.sheets.find(s=>s.name==='People').rows[0].Balance,10);
  assert.equal(parsed.sheets.find(s=>s.name==='Transactions').rows[0].Person,'Alice');
});

test('pdf generator emits a structurally valid PDF header and xref',()=>{
  const pdf=createPdf({title:'Test',build(ctx){ctx.page().heading('Hello').row('One','Two');}});
  const text=pdf.toString('latin1'); assert.ok(text.startsWith('%PDF-1.4')); assert.ok(text.includes('xref')); assert.ok(text.endsWith('%%EOF\n'));
});

test('summary and person statement PDFs render ledger data',()=>{
  const state={settings:{displayName:'Family Ledger',defaultCurrency:'USD'},people:[{id:'p1',name:'Alice'}],accounts:[{id:'a1',name:'Bank',type:'bank',currency:'USD'}],entries:[]};
  const summary=summaryPdf(state,{personBalances:{p1:{USD:25}},accountBalances:{a1:100}}).toString('latin1');
  assert.ok(summary.includes('Family Ledger')); assert.ok(summary.includes('Alice'));
  const statement=personStatementPdf(state,state.people[0],{currency:'USD',rows:[{date:'2026-09-28',description:'Amazon',delta:25,running:25,currency:'USD'}]}).toString('latin1');
  assert.ok(statement.includes('Alice')); assert.ok(statement.includes('Amazon'));
});
