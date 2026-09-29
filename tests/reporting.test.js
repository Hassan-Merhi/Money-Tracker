import test from 'node:test';
import assert from 'node:assert/strict';
import { reportingSnapshot, workbookSheets, exportRows, filterTransactionList, dateRangeForPreset } from '../lib/reporting.js';
import { readFileSync } from 'node:fs';
import { renderReports } from '../lib/reports-ui.js';
import { buildPdfReport } from '../lib/pdf.js';
import { escapeHtml } from '../lib/utils.js';
import { currencyExponent } from '../lib/money.js';

const t='2026-09-01T00:00:00Z';
const state={
  settings:{displayName:'Family Ledger',defaultCurrency:'USD',appMode:'advanced',timezone:'Asia/Beirut'},
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
  assert.deepEqual(sheets.map(s=>s.name),['Metadata','Overview','Outstanding','People','Accounts','Categories','Budgets','Spending','Monthly','Transactions']);
  assert.ok(sheets.at(-1).rows[0].includes('Merchant'));
  assert.ok(sheets.at(-1).rows[0].includes('Category'));
  assert.ok(sheets.at(-1).rows[0].includes('Entry ID'));
  assert.ok(sheets.at(-1).rows[0].includes('Attachment IDs'));
  assert.ok(sheets.find(s=>s.name==='Metadata').rows.some(row=>row.includes('Asia/Beirut')));
  assert.equal(exportRows(state).length,3);
});


test('person-filtered reports use only that persons split allocation',()=>{
  const splitState={...state,entries:[...state.entries,{id:'e4',type:'split_paid_for_people',accountId:'a1',amount:30,currency:'USD',date:'2026-09-20',merchant:'Store',description:'Shared order',splits:[{personId:'p1',amount:10,note:'Cable'},{personId:'p2',amount:20,note:'Case'}],attachmentCount:2,createdAt:t,updatedAt:t}]};
  const s=reportingSnapshot(splitState,{personId:'p1'});
  assert.equal(s.transactionCount,3);
  assert.equal(s.activity.USD.charged,130);
  assert.equal(s.activity.USD.recovered,20);
  assert.equal(s.activity.USD.netPersonChange,110);
  assert.equal(s.merchants.find(row=>row.merchant==='Store').amount,10);
  const row=exportRows(splitState).find(item=>item.Type==='split_paid_for_people');
  assert.match(row.Person,/Alice/);
  assert.match(row['Split Details'],/Bob: 20/);
  assert.equal(row.Attachments,2);
});


test('bank-imported account expenses appear in category and merchant reports without affecting person activity',()=>{
  const withExpense={...state,categories:[{id:'category_food',name:'Food',kind:'expense',icon:'🍽️',archived:false}],budgets:[{id:'budget_food',categoryId:'category_food',currency:'USD',monthlyLimit:100}],entries:[...state.entries,{id:'e-bank',type:'account_expense',personId:null,accountId:'a1',amount:45,currency:'USD',date:'2026-09-22',merchant:'Grocer',description:'Food',categoryId:'category_food',createdAt:t,updatedAt:t}]};
  const s=reportingSnapshot(withExpense);
  assert.equal(s.transactionCount,4);
  assert.equal(s.activity.USD.netPersonChange,50);
  assert.equal(s.personalCashFlow.USD.expense,45);
  assert.equal(s.categorySpending.find(row=>row.categoryId==='category_food').amount,45);
  assert.equal(s.merchants.find(row=>row.merchant==='Grocer').amount,45);
  assert.equal(s.accounts[0].balance,905);
  const exported=exportRows(withExpense).find(row=>row.Type==='account_expense');assert.equal(exported.Category,'Food');
  const sheets=workbookSheets(withExpense);assert.ok(sheets.find(sheet=>sheet.name==='Budgets').rows.some(row=>row.includes('Food')));
});


test('report v2 filters by category type and currency',()=>{
  const s={...state,categories:[{id:'cat_food',name:'Food',kind:'expense',icon:'',archived:false}],entries:[
    ...state.entries,
    {id:'e4',type:'account_expense',personId:null,accountId:'a1',amount:12,currency:'USD',categoryId:'cat_food',date:'2026-09-20',merchant:'Cafe',description:'Lunch',createdAt:t,updatedAt:t},
    {id:'e5',type:'account_income',personId:null,accountId:'a1',amount:30,currency:'USD',date:'2026-09-21',merchant:'Work',description:'Refund',createdAt:t,updatedAt:t}
  ]};
  const filtered=reportingSnapshot(s,{categoryId:'cat_food',type:'account_expense',currency:'USD'});
  assert.equal(filtered.transactionCount,1);
  assert.equal(filtered.transactions[0]['Entry ID'],'e4');
  assert.equal(filtered.transactions[0]['Category ID'],'cat_food');
});

test('export rows include stable ids timestamps and attachment references',()=>{
  const withAttachment={...state,entries:[{...state.entries[0],attachmentCount:1,attachments:[{id:'att_1',name:'receipt.pdf',mimeType:'application/pdf',sizeBytes:100,createdAt:t}]}]};
  const row=exportRows(withAttachment)[0];
  assert.equal(row['Entry ID'],'e1');
  assert.equal(row['Person ID'],'p1');
  assert.equal(row['Account ID'],'a1');
  assert.equal(row['Attachment IDs'],'att_1');
  assert.equal(row['Attachment Names'],'receipt.pdf');
  assert.equal(row['Created At'],t);
});

const wave0=JSON.parse(readFileSync(new URL('./fixtures/wave0-ledger-baseline.json',import.meta.url),'utf8'));
const waveSnap=reportingSnapshot(wave0);
const seriesValue=(rows,currency,month='2026-09')=>rows.find(r=>r.month===month)?.currencies[currency];

test('receivables movement contains only person deltas (including split allocations)',()=>{
  assert.equal(seriesValue(waveSnap.receivablesMovement,'USD'),75);
  assert.equal(seriesValue(waveSnap.receivablesMovement,'EUR'),30);
  assert.equal(seriesValue(waveSnap.receivablesMovement,'LBP'),undefined);
  assert.deepEqual(reportingSnapshot(wave0,{type:'account_income'}).receivablesMovement,[]);
  assert.equal(seriesValue(reportingSnapshot(wave0,{personId:'person_alice',type:'split_paid_for_people'}).receivablesMovement,'USD'),40);
});

test('personal cash flow contains only account income less expenses, never person or transfer effects',()=>{
  assert.deepEqual(waveSnap.cashFlow,[{month:'2026-09',currencies:{USD:45}}]);
  assert.equal(waveSnap.cashFlow[0].currencies.USD,waveSnap.personalCashFlow.USD.net);
  assert.deepEqual(reportingSnapshot(wave0,{type:'paid_for_person'}).cashFlow,[]);
  assert.deepEqual(reportingSnapshot(wave0,{type:'account_transfer'}).cashFlow,[]);
  assert.equal(seriesValue(reportingSnapshot(wave0,{type:'account_expense'}).cashFlow,'USD'),-25);
});

test('transfer flow includes both legs, cancels same-currency transfers, excludes income and receivables',()=>{
  // The USD->LBP outgoing leg stays in USD; only the USD->USD transfer cancels.
  assert.deepEqual(waveSnap.transferFlow,[{month:'2026-09',currencies:{USD:-10,LBP:900000}}]);
  assert.deepEqual(reportingSnapshot(wave0,{type:'account_income'}).transferFlow,[]);
  assert.deepEqual(reportingSnapshot(wave0,{type:'paid_for_person'}).transferFlow,[]);
  assert.deepEqual(reportingSnapshot(wave0,{from:'2026-09-18',to:'2026-09-18'}).transferFlow,[{month:'2026-09',currencies:{USD:0}}]);
  assert.deepEqual(reportingSnapshot(wave0,{from:'2026-09-21',to:'2026-09-21'}).transferFlow,[{month:'2026-09',currencies:{USD:-10,LBP:900000}}]);
  assert.equal(Object.hasOwn(waveSnap,'monthly'),false);
});

test('Monthly workbook labels each measure without changing the sheet list',()=>{
  const sheets=workbookSheets(wave0);
  assert.deepEqual(sheets.map(s=>s.name),['Metadata','Overview','Outstanding','People','Accounts','Categories','Budgets','Spending','Monthly','Transactions']);
  assert.deepEqual(sheets.find(s=>s.name==='Monthly').rows,[
    ['Measure','Month','Currency','Net Movement'],
    ['Receivables movement','2026-09','USD',75],['Receivables movement','2026-09','EUR',30],
    ['Personal cash flow','2026-09','USD',45],
    ['Transfer flow','2026-09','USD',-10],['Transfer flow','2026-09','LBP',900000]
  ]);
});

const drillEntries=[
  {id:'food',type:'account_expense',categoryId:'food'},
  {id:'archived',type:'account_expense',categoryId:'old'},
  {id:'uncat',type:'account_expense',categoryId:null},
  {id:'missing',type:'account_income'},
  {id:'alice',type:'paid_for_person',personId:'alice',categoryId:'food'},
  {id:'split',type:'split_paid_for_people',splits:[{personId:'alice',amount:10},{personId:'bob',amount:20}],categoryId:'old'},
  {id:'bob',type:'paid_to_person',personId:'bob'}
];
const drillPeople=[{id:'alice',name:'Alice'},{id:'bob',name:'Bob'}];
const drillCategories=[{id:'food',name:'Food',archived:false},{id:'old',name:'Former category',archived:true}];
const drill=(filters={})=>filterTransactionList(drillEntries,{...filters,people:drillPeople}).map(e=>e.id);

test('transaction drill-down filters type and person, including split participants',()=>{
  assert.deepEqual(drill({type:'account_expense'}),['food','archived','uncat']);
  assert.deepEqual(drill({personId:'alice'}),['alice','split']);
  assert.deepEqual(drill({personId:'bob'}),['split','bob']);
  assert.deepEqual(drill({personId:'nobody'}),[]);
  assert.deepEqual(drill(),drillEntries.map(e=>e.id));
});

test('transaction drill-down filters active, archived and uncategorized categories by ID',()=>{
  assert.deepEqual(drill({categoryId:'food'}),['food','alice']);
  // Archived categories retain their IDs; filtering must not depend on current status.
  assert.deepEqual(drill({categoryId:drillCategories.find(c=>c.archived).id}),['archived','split']);
  assert.deepEqual(drill({categoryId:'uncategorized'}),['uncat','missing','bob']);
  assert.deepEqual(drill({categoryId:'other'}),[]);
  assert.deepEqual(filterTransactionList([{id:'empty',categoryId:''},{id:'tagged',categoryId:'food'}],{categoryId:'uncategorized'}).map(e=>e.id),['empty']);
});

test('transaction drill-down intersects type, person and category without mutating entries',()=>{
  const before=structuredClone(drillEntries);
  assert.deepEqual(drill({type:'split_paid_for_people',personId:'bob',categoryId:'old'}),['split']);
  assert.deepEqual(drill({type:'account_expense',categoryId:'uncategorized'}),['uncat']);
  assert.deepEqual(drill({type:'account_expense',personId:'alice',categoryId:'old'}),[]);
  assert.deepEqual(drillEntries,before);
});


test('monthly series are sorted, exact and disjoint even when months have different entry types',()=>{
  const s=reportingSnapshot({...state,entries:[
    {type:'account_income',amount:0.1,currency:'USD',date:'2026-10-02'},
    {type:'account_income',amount:0.2,currency:'USD',date:'2026-10-01'},
    {type:'paid_for_person',personId:'p1',amount:0.3,currency:'USD',date:'2026-09-01'},
    {type:'account_expense',amount:0.1,currency:'USD',date:'2026-08-01'}
  ]});
  assert.deepEqual(s.cashFlow,[{month:'2026-08',currencies:{USD:-0.1}},{month:'2026-10',currencies:{USD:0.3}}]);
  assert.deepEqual(s.receivablesMovement,[{month:'2026-09',currencies:{USD:0.3}}]);
  assert.deepEqual(s.transferFlow,[]);
});

test('every entry contributes to only its own monthly measure',()=>{
  for(const entry of wave0.entries){
    const s=reportingSnapshot({...wave0,entries:[entry]});
    const expected=entry.type==='account_transfer'?'transferFlow':['account_expense','account_income'].includes(entry.type)?'cashFlow':'receivablesMovement';
    for(const key of ['receivablesMovement','cashFlow','transferFlow'])assert.equal(s[key].length,key===expected?1:0,`${entry.id}: ${key}`);
  }
});

test('Reports and PDF publish three labelled measures with exact fixture values',()=>{
  const main={innerHTML:'',querySelector:()=>null};
  renderReports(main,wave0,{params:new URLSearchParams()},{money:(v,c)=>`${c} ${v}`,escapeHtml,today:()=> '2026-09-29'});
  const pdf=new TextDecoder().decode(buildPdfReport(wave0,waveSnap));
  const expected=[['Receivables movement',{USD:75,EUR:30}],['Personal cash flow',{USD:45}],['Transfer flow',{USD:-10,LBP:900000}]];
  for(let i=0;i<expected.length;i++){
    const [label,values]=expected[i];
    const panel=main.innerHTML.split(`<h3>${label}</h3>`)[1]?.split('</section>')[0];
    assert.ok(panel,`${label} panel exists`);
    const pdfSection=pdf.split(`(${label})`)[1]?.split(`(${expected[i+1]?.[0]||'Transactions'})`)[0];
    assert.ok(pdfSection,`${label} PDF section exists`);
    for(const [currency,value] of Object.entries(values)){
      assert.ok(panel.includes(`${currency} ${value}`));
      assert.ok(pdfSection.includes(`2026-09: ${currency} ${value.toLocaleString('en-US',{minimumFractionDigits:currencyExponent(currency),maximumFractionDigits:currencyExponent(currency)})}`));
    }
    assert.equal((panel.match(/<tr><td>/g)||[]).length,Object.keys(values).length);
  }
  assert.doesNotMatch(main.innerHTML,/Monthly movement/);
  assert.doesNotMatch(pdf,/Monthly movement/);
});


test('activity date presets produce calendar-safe ranges',()=>{
  assert.deepEqual(dateRangeForPreset('this_month','2026-09-29'),{from:'2026-09-01',to:'2026-09-30'});
  assert.deepEqual(dateRangeForPreset('last_month','2026-09-29'),{from:'2026-08-01',to:'2026-08-31'});
  assert.deepEqual(dateRangeForPreset('last_30_days','2026-09-29'),{from:'2026-08-31',to:'2026-09-29'});
  assert.deepEqual(dateRangeForPreset('all','2026-09-29'),{from:'',to:''});
  assert.deepEqual(dateRangeForPreset('custom','2026-09-29','2026-09-05','2026-09-18'),{from:'2026-09-05',to:'2026-09-18'});
});

test('transaction list date filter composes with activity filters',()=>{
  const rows=filterTransactionList(state.entries,{from:'2026-09-10',to:'2026-09-14',personId:'p1'});
  assert.deepEqual(rows.map(row=>row.id),['e2']);
  assert.equal(filterTransactionList(state.entries,{from:'2026-09-11',to:'2026-09-14'}).length,0);
});
