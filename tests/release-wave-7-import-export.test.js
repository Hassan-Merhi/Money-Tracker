import test from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx } from '../lib/xlsx.js';
import { parseWorkbook } from '../lib/xlsx-import.js';
import { applyImport } from '../lib/importer.js';
import { workbookSheets } from '../lib/reporting.js';
import { buildPdfReport } from '../lib/pdf.js';

function ids(){let n=0;return prefix=>`${prefix}_wave7_${++n}`;}
const t='2026-09-29T12:00:00Z';

function sourceState(){
  return {
    version:1,
    settings:{displayName:'Wave 7',defaultCurrency:'USD',appMode:'advanced',timezone:'America/New_York'},
    people:[{id:'alice',name:'Alice',note:'',createdAt:t},{id:'bob',name:'Bob',note:'',createdAt:t}],
    accounts:[
      {id:'bank',name:'Bank',type:'bank',currency:'USD',openingBalance:100,createdAt:t},
      {id:'cash',name:'Cash',type:'cash',currency:'USD',openingBalance:50,createdAt:t},
      {id:'euro',name:'Euro',type:'bank',currency:'EUR',openingBalance:25,createdAt:t}
    ],
    categories:[{id:'food',name:'Food',kind:'expense',icon:'',archived:false}],
    budgets:[],
    entries:[
      {id:'pa',type:'person_adjustment',personId:'alice',accountId:null,amount:20,signedAmount:-20,currency:'USD',date:'2026-09-20',merchant:'',description:'Negative person adjustment',splits:[],createdAt:t,updatedAt:t},
      {id:'aa',type:'account_adjustment',accountId:'bank',amount:5,signedAmount:-5,currency:'USD',date:'2026-09-21',merchant:'',description:'Negative account adjustment',splits:[],createdAt:t,updatedAt:t},
      {id:'same',type:'account_transfer',fromAccountId:'bank',toAccountId:'cash',fromAmount:5,toAmount:5,amount:5,currency:null,date:'2026-09-22',merchant:'',description:'Same currency',splits:[],createdAt:t,updatedAt:t},
      {id:'cross',type:'account_transfer',fromAccountId:'bank',toAccountId:'euro',fromAmount:10,toAmount:9.2,amount:10,currency:null,date:'2026-09-23',merchant:'',description:'Cross currency',splits:[],createdAt:t,updatedAt:t},
      {id:'split',type:'split_paid_for_people',accountId:'bank',amount:12.34,currency:'USD',date:'2026-09-24',merchant:'Shop',description:'Shared',splits:[{personId:'alice',amount:2.34,note:'Tea'},{personId:'bob',amount:10,note:'Book'}],createdAt:t,updatedAt:t},
      {id:'expense',type:'account_expense',accountId:'bank',amount:7.89,currency:'USD',date:'2026-09-25',merchant:'Cafe',categoryId:'food',description:'Lunch',splits:[],createdAt:t,updatedAt:t}
    ]
  };
}

const transactionMapping={
  date:'Date',type:'Type',person:'Person',account:'Account',amount:'Amount',currency:'Currency',
  fromAccount:'From Account',toAccount:'To Account',fromCurrency:'From Currency',toCurrency:'To Currency',
  fromAmount:'From Amount',toAmount:'To Amount',signedAmount:'Signed Amount',direction:'Direction',
  merchant:'Merchant',category:'Category',description:'Description',splitDetails:'Split Details'
};

test('Wave 7: exported XLSX carries adjustment signs and both transfer currencies through re-import',()=>{
  const source=sourceState();
  const bytes=buildXlsx(workbookSheets(source),{title:'Wave 7 round trip'});
  const parsed=parseWorkbook(Buffer.from(bytes));
  const txn=parsed.sheets.find(sheet=>sheet.name==='Transactions');
  assert.ok(txn);
  const exportedCross=txn.rows.find(row=>row['Entry ID']==='cross');
  assert.equal(exportedCross['From Currency'],'USD');
  assert.equal(exportedCross['To Currency'],'EUR');
  const exportedPersonAdjustment=txn.rows.find(row=>row['Entry ID']==='pa');
  assert.equal(exportedPersonAdjustment['Signed Amount'],-20);

  const destination={
    version:1,settings:{displayName:'Destination',defaultCurrency:'USD'},
    people:[],accounts:[],categories:[{id:'food2',name:'Food',kind:'expense',icon:'',archived:false}],budgets:[],entries:[]
  };
  const imported=applyImport({state:destination,rows:txn.rows,mode:'transactions',mapping:transactionMapping,uidFactory:ids(),nowIso:()=>t});
  assert.equal(imported.result.entries,source.entries.length);
  assert.equal(imported.result.skipped,0);

  const personAdjustment=imported.state.entries.find(e=>e.type==='person_adjustment');
  const accountAdjustment=imported.state.entries.find(e=>e.type==='account_adjustment');
  assert.equal(personAdjustment.signedAmount,-20);
  assert.equal(accountAdjustment.signedAmount,-5);

  const cross=imported.state.entries.find(e=>e.type==='account_transfer'&&e.description==='Cross currency');
  const from=imported.state.accounts.find(a=>a.id===cross.fromAccountId);
  const to=imported.state.accounts.find(a=>a.id===cross.toAccountId);
  assert.equal(from.currency,'USD');
  assert.equal(to.currency,'EUR');
  assert.equal(cross.fromAmount,10);
  assert.equal(cross.toAmount,9.2);
});

test('Wave 7: import rejects a same-currency transfer that creates or destroys money',()=>{
  const row={Date:'2026-09-29',Type:'account_transfer',Amount:10,Currency:'USD','From Account':'Bank','To Account':'Cash','From Currency':'USD','To Currency':'USD','From Amount':10,'To Amount':9.99};
  const out=applyImport({state:{version:1,settings:{defaultCurrency:'USD'},people:[],accounts:[],entries:[]},rows:[row],mode:'transactions',mapping:transactionMapping,uidFactory:ids(),nowIso:()=>t});
  assert.equal(out.result.entries,0);
  assert.equal(out.result.skipped,1);
  assert.match(out.result.errors[0],/same-currency transfer amounts must match/i);
});

test('Wave 7: changing only a split note updates the existing transaction instead of duplicating it',()=>{
  const base={version:1,settings:{defaultCurrency:'USD'},people:[],accounts:[],entries:[]};
  const mapping={date:'Date',type:'Type',account:'Account',amount:'Amount',currency:'Currency',description:'Description',splitDetails:'Split Details'};
  const firstRow={Date:'2026-09-29',Type:'split_paid_for_people',Account:'Bank',Amount:30,Currency:'USD',Description:'Shared','Split Details':'Alice: 10 (Old note) | Bob: 20'};
  const uid=ids();
  const first=applyImport({state:base,rows:[firstRow],mode:'transactions',mapping,uidFactory:uid,nowIso:()=>t});
  assert.equal(first.result.entries,1);
  const second=applyImport({state:first.state,rows:[{...firstRow,'Split Details':'Alice: 10 (Corrected note) | Bob: 20'}],mode:'transactions',mapping,uidFactory:uid,nowIso:()=>t});
  assert.equal(second.result.entries,0);
  assert.equal(second.result.updated,1);
  assert.equal(second.state.entries.length,1);
  assert.equal(second.state.entries[0].splits.find(s=>second.state.people.find(p=>p.id===s.personId)?.name==='Alice').note,'Corrected note');
});

test('Wave 7: malformed XLSX inputs fail closed',()=>{
  assert.throws(()=>parseWorkbook(Buffer.from('not-an-xlsx')),/Not a valid XLSX file/);
  const fake=Buffer.alloc(30);fake.writeUInt32LE(0x04034b50,0);fake.writeUInt16LE(20,4);fake.writeUInt16LE(0,6);fake.writeUInt16LE(0,8);
  assert.throws(()=>parseWorkbook(fake),/(Corrupt XLSX archive|Workbook structure is missing|Not a valid XLSX file)/);
});

test('Wave 7: large PDF report build stays structurally valid',()=>{
  const transactions=Array.from({length:250},(_,i)=>({'Entry ID':`entry_${i}`,Date:'2026-09-29',Type:'paid_for_person',Person:'Alice',Amount:1.23,Currency:'USD',Description:`Long transaction row ${i} ${'x'.repeat(120)}`}));
  const snap={filters:{from:'',to:''},transactionCount:transactions.length,activity:{USD:{charged:307.5,recovered:0,borrowed:0,repaid:0}},categorySpending:[],outstanding:[{personName:'Alice',direction:'owes_me',amount:307.5,currency:'USD'}],accounts:[],merchants:[],budgets:[],receivablesMovement:[],cashFlow:[],transferFlow:[],transactions};
  const bytes=buildPdfReport({settings:{displayName:'Wave 7'}},snap);
  const text=new TextDecoder().decode(bytes);
  assert.match(text,/^%PDF-/);
  assert.match(text,/xref/);
  assert.match(text,/%%EOF/);
  assert.ok(bytes.length>1000);
});
