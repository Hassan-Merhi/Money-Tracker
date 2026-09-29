import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPdfReport } from '../lib/pdf.js';

const state={settings:{displayName:'Family Ledger'}};
const snap={filters:{from:'',to:''},transactionCount:2,activity:{USD:{charged:100,recovered:25,borrowed:0,repaid:0}},categorySpending:[{categoryName:'Food',amount:20,currency:'USD',count:1}],outstanding:[{personName:'Alice',direction:'owes_me',amount:75,currency:'USD'}],accounts:[{name:'Bank',type:'bank',balance:925,currency:'USD'}],merchants:[{merchant:'Amazon',amount:100,currency:'USD',count:1}],budgets:[{categoryName:'Food',monthlyLimit:200,currency:'USD'}],receivablesMovement:[{month:'2026-09',currencies:{USD:75}}],cashFlow:[{month:'2026-09',currencies:{USD:-25}}],transferFlow:[{month:'2026-09',currencies:{USD:0}}],transactions:[{'Entry ID':'entry_1',Date:'2026-09-01',Type:'paid_for_person',Person:'Alice',Amount:100,Currency:'USD'}]};

test('person statement pdf uses plain-language balance and activity lines',()=>{
  const entries=[
    {id:'e1',type:'paid_for_person',personId:'p1',amount:100,currency:'USD',date:'2026-09-05',createdAt:'2026-09-05T00:00:00Z',description:'Groceries'},
    {id:'e2',type:'received_from_person',personId:'p1',amount:25,currency:'USD',date:'2026-09-12',createdAt:'2026-09-12T00:00:00Z',description:'Venmo'}
  ];
  const state={settings:{displayName:'Family Ledger'},entries};
  const snap={filters:{from:'',to:''},transactionCount:2,activity:{USD:{charged:100,recovered:25,borrowed:0,repaid:0}},categorySpending:[],outstanding:[{personId:'p1',personName:'Alice',amount:75,currency:'USD',direction:'owes_me'}],accounts:[],merchants:[],budgets:[],receivablesMovement:[],cashFlow:[],transferFlow:[],transactions:[]};
  const text=new TextDecoder().decode(buildPdfReport(state,snap,{personName:'Alice',personId:'p1'}));
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.match(text,/Statement - Alice/);
  assert.match(text,/Current balance/);
  assert.match(text,/Alice owes you USD 75\.00/);
  assert.match(text,/you paid for them USD 100\.00, they paid you back USD 25\.00/);
  assert.match(text,/5 Sep 2026/);
  assert.match(text,/They owe you more/);
  assert.match(text,/You owe them more/);
  assert.match(text,/Now USD 100\.00/);
  assert.match(text,/Now USD 75\.00/);
  assert.ok(!text.includes(' | '));
  assert.ok(text.endsWith('%%EOF'));
});

test('buildPdfReport produces a PDF with report text and xref',()=>{
  const b=buildPdfReport(state,snap);
  const text=new TextDecoder().decode(b);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.match(text,/Money Tracker Report/);
  assert.match(text,/Alice/);
  assert.match(text,/Personal spending by category/);
  assert.match(text,/Food/);
  assert.match(text,/Budgets/);
  assert.match(text,/Receivables movement/);
  assert.match(text,/Personal cash flow/);
  assert.match(text,/Transfer flow/);
  assert.match(text,/2026-09: USD 75\.00/);
  assert.match(text,/2026-09: USD -25\.00/);
  assert.doesNotMatch(text,/Monthly movement/);
  assert.match(text,/Transactions/);
  assert.match(text,/entry_1/);
  assert.match(text,/xref/);
  assert.ok(text.endsWith('%%EOF'));
});
