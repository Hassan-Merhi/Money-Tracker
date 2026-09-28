import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPdfReport } from '../lib/pdf.js';

const state={settings:{displayName:'Family Ledger'}};
const snap={filters:{from:'',to:''},transactionCount:2,activity:{USD:{charged:100,recovered:25,borrowed:0,repaid:0}},outstanding:[{personName:'Alice',direction:'owes_me',amount:75,currency:'USD'}],accounts:[{name:'Bank',type:'bank',balance:925,currency:'USD'}],merchants:[{merchant:'Amazon',amount:100,currency:'USD',count:1}]};

test('buildPdfReport produces a PDF with report text and xref',()=>{
  const b=buildPdfReport(state,snap);
  const text=new TextDecoder().decode(b);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.match(text,/Money Tracker Report/);
  assert.match(text,/Alice/);
  assert.match(text,/xref/);
  assert.ok(text.endsWith('%%EOF'));
});
