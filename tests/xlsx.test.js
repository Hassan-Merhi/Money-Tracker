import test from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx } from '../lib/xlsx.js';
import { parseWorkbook } from '../lib/xlsx-import.js';
import { workbookSheets } from '../lib/reporting.js';

test('buildXlsx creates a valid-looking OOXML zip with workbook parts',()=>{
  const b=buildXlsx([{name:'Overview',rows:[['Hello',123]]},{name:'People',rows:[['Name'],['Alice']]}]);
  assert.equal(b[0],0x50);
  assert.equal(b[1],0x4b);
  const text=new TextDecoder().decode(b);
  assert.match(text,/\[Content_Types\]\.xml/);
  assert.match(text,/xl\/workbook\.xml/);
  assert.match(text,/worksheets\/sheet2\.xml/);
  assert.match(text,/Alice/);
  assert.match(text,/autoFilter/);
  assert.match(text,/state="frozen"/);
  assert.match(text,/customWidth="1"/);
});


test('Money Tracker v2 workbook round-trips transaction ids and attachment references',()=>{
  const t='2026-09-29T00:00:00Z';
  const state={
    settings:{displayName:'Round Trip',defaultCurrency:'USD',appMode:'advanced',timezone:'Asia/Beirut'},
    people:[{id:'person_a',name:'Alice',note:'',createdAt:t}],
    accounts:[{id:'account_a',name:'Bank',type:'bank',currency:'USD',openingBalance:100,createdAt:t}],
    categories:[],budgets:[],
    entries:[{id:'entry_a',type:'paid_for_person',personId:'person_a',accountId:'account_a',amount:12.34,currency:'USD',date:'2026-09-29',merchant:'Shop',description:'Round trip',attachmentCount:1,attachments:[{id:'att_a',name:'receipt.pdf',mimeType:'application/pdf',sizeBytes:12,createdAt:t}],createdAt:t,updatedAt:t}]
  };
  const bytes=buildXlsx(workbookSheets(state),{title:'Round Trip'});
  const parsed=parseWorkbook(Buffer.from(bytes));
  const txn=parsed.sheets.find(sheet=>sheet.name==='Transactions');
  assert.ok(txn);
  assert.equal(txn.rows[0]['Entry ID'],'entry_a');
  assert.equal(txn.rows[0]['Person ID'],'person_a');
  assert.equal(txn.rows[0]['Account ID'],'account_a');
  assert.equal(txn.rows[0]['Attachment IDs'],'att_a');
  assert.equal(txn.rows[0]['Attachment Names'],'receipt.pdf');
  const metadata=parsed.sheets.find(sheet=>sheet.name==='Metadata');
  assert.ok(metadata.rows.some(row=>Object.values(row).includes('Asia/Beirut')));
});
