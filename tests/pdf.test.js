import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPdfReport } from '../lib/pdf.js';

const state={settings:{displayName:'Family Ledger'}};
const snap={filters:{from:'',to:''},transactionCount:2,activity:{USD:{charged:100,recovered:25,borrowed:0,repaid:0}},categorySpending:[{categoryName:'Food',amount:20,currency:'USD',count:1}],outstanding:[{personName:'Alice',direction:'owes_me',amount:75,currency:'USD'}],accounts:[{name:'Bank',type:'bank',balance:925,currency:'USD'}],merchants:[{merchant:'Amazon',amount:100,currency:'USD',count:1}],budgets:[{categoryName:'Food',monthlyLimit:200,currency:'USD'}],monthly:[{month:'2026-09',currencies:{USD:-25}}],transactions:[{'Entry ID':'entry_1',Date:'2026-09-01',Type:'paid_for_person',Person:'Alice',Amount:100,Currency:'USD'}]};

test('buildPdfReport produces a PDF with report text and xref',()=>{
  const b=buildPdfReport(state,snap);
  const text=new TextDecoder().decode(b);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.match(text,/Money Tracker Report/);
  assert.match(text,/Alice/);
  assert.match(text,/Personal spending by category/);
  assert.match(text,/Food/);
  assert.match(text,/Budgets/);
  assert.match(text,/Monthly movement/);
  assert.match(text,/Transactions/);
  assert.match(text,/entry_1/);
  assert.match(text,/xref/);
  assert.ok(text.endsWith('%%EOF'));
});
