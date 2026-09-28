import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLegacyWorkbook, applyLegacyWorkbook } from '../lib/legacy-excel.js';

const baseState=()=>({version:1,settings:{displayName:'Ledger',defaultCurrency:'USD'},people:[],accounts:[],entries:[]});
function ids(){let n=0;return prefix=>`${prefix}_${++n}`;}

function dakikWorkbook(){
  return {sheets:[
    {name:'DAKIK PAYMENTS',headers:['HAMZA','Column 2','Column 3','Column 4','Column 5','Column 6','Column 7','ABDALLAH','Column 9','Column 10','Column 11','Column 12','Column 13','Column 14',"Abdallah's Money",'Column 16','Column 17','Column 18'],rows:[
      {'HAMZA':'NARRATION','Column 2':'PAID','Column 3':'OWE','Column 4':'TOTAL','ABDALLAH':'NARRATION','Column 9':'PAID','Column 10':'OWE','Column 11':'TOTAL',"Abdallah's Money":'NARRATION','Column 16':'PAID','Column 17':'OWE','Column 18':'TOTAL'},
      {'HAMZA':'EBAY OLD STUFF','Column 2':900,'Column 4':-900,'ABDALLAH':'LOCK THING','Column 9':250,'Column 11':-250,"Abdallah's Money":'KAMEL GAVE ME','Column 17':4700,'Column 18':4700}
    ]},
    {name:'DEBT PAYMENTS',headers:['MARIAM PAYMENTS','Column 2','Column 3','Column 4','Column 5','Column 6','SOJOUD PAYMENTS','Column 8','Column 9','Column 10'],rows:[
      {'MARIAM PAYMENTS':'NARRATION','Column 2':'PAID','Column 3':'OWE','Column 4':'TOTAL','SOJOUD PAYMENTS':'NARRATION','Column 8':'PAID','Column 9':'OWE','Column 10':'TOTAL'},
      {'MARIAM PAYMENTS':'Khyar','Column 2':20,'Column 4':-20,'SOJOUD PAYMENTS':'MONEY IN LEBANON FOR CONGO','Column 9':200,'Column 10':200}
    ]},
    {name:'COURSE PAYMENTS',headers:['SUMMER A COURSES'],rows:[]}
  ]};
}

test('legacy workbook detection recognizes side-by-side ledgers and skips duplicate summary sheets',()=>{
  const analysis=analyzeLegacyWorkbook(dakikWorkbook());
  assert.equal(analysis.recognized,true);
  assert.equal(analysis.records.length,5);
  assert.ok(analysis.ignoredSheets.some(x=>x.sheet==='COURSE PAYMENTS'));
});

test('legacy paid/owe columns convert to Money Tracker balance signs and consolidate Abdallah ledgers',()=>{
  const out=applyLegacyWorkbook({state:baseState(),workbook:dakikWorkbook(),uidFactory:ids(),nowIso:()=> '2026-09-28T00:00:00.000Z'});
  assert.equal(out.result.entries,5);
  assert.equal(out.result.people,4);
  const hamza=out.state.people.find(p=>p.name==='HAMZA');
  const abdallah=out.state.people.find(p=>p.name==='ABDALLAH');
  assert.equal(out.state.entries.find(e=>e.personId===hamza.id).signedAmount,900);
  assert.equal(out.state.entries.filter(e=>e.personId===abdallah.id).reduce((sum,e)=>sum+e.signedAmount,0),250-4700);
  assert.ok(out.state.entries.every(e=>e.merchant.startsWith('LegacyExcel:')));
});

test('legacy re-import skips unchanged rows and updates a corrected amount in place',()=>{
  const workbook=dakikWorkbook(),uid=ids();
  const first=applyLegacyWorkbook({state:baseState(),workbook,uidFactory:uid,nowIso:()=> '2026-09-28T00:00:00.000Z'});
  const second=applyLegacyWorkbook({state:first.state,workbook,uidFactory:uid,nowIso:()=> '2026-09-28T00:00:00.000Z'});
  assert.equal(second.result.entries,0);
  assert.equal(second.result.updated,0);
  assert.equal(second.result.skipped,5);
  workbook.sheets[0].rows[1]['Column 2']=950;
  const corrected=applyLegacyWorkbook({state:second.state,workbook,uidFactory:uid,nowIso:()=> '2026-09-29T00:00:00.000Z'});
  assert.equal(corrected.result.entries,0);
  assert.equal(corrected.result.updated,1);
  assert.equal(corrected.state.entries.length,5);
  assert.ok(corrected.state.entries.some(e=>e.signedAmount===950));
});

test('Troy and UWA course sheets become Shandrieka charges and repayments without importing summary totals',()=>{
  const workbook={sheets:[
    {name:'TROY UNIVERSITY',headers:['SHANDREKIA COURSES','Column 2','Column 3','Column 4'],rows:[
      {'SHANDREKIA COURSES':'COURSE NAME','Column 2':'PAID ','Column 3':'OWE','Column 4':'BALANCE'},
      {'SHANDREKIA COURSES':'TOTAL COURSES 2 x 300','Column 4':-600},
      {'SHANDREKIA COURSES':'PAID ON 6/16/25','Column 2':250,'Column 4':-350}
    ]},
    {name:'UWA SHANDRIEKA',headers:['PUBLIC ADMINISTRATION DEGREE','Column 2','Column 3','Column 4','Column 5','Column 6','Column 7','Column 8'],rows:[
      {'PUBLIC ADMINISTRATION DEGREE':'COURSE NUMBER','Column 2':'COURSE NAME','Column 3':'CREDITS','Column 4':'PROGRESS','Column 5':'AMOUNT DUE','Column 6':'PAID OFF','Column 7':'DATE PAID','Column 8':'AMOUNT PAID'},
      {'PUBLIC ADMINISTRATION DEGREE':'EH2311','Column 2':'AMERICAN LITERATURE I','Column 5':150,'Column 7':45796,'Column 8':100},
      {'PUBLIC ADMINISTRATION DEGREE':'TOTAL PAID','Column 8':100}
    ]}
  ]};
  const out=applyLegacyWorkbook({state:baseState(),workbook,uidFactory:ids(),nowIso:()=> '2026-09-28T00:00:00.000Z'});
  const person=out.state.people.find(p=>p.name==='SHANDRIEKA');
  assert.ok(person);
  const signed=out.state.entries.filter(e=>e.personId===person.id).map(e=>e.signedAmount).sort((a,b)=>a-b);
  assert.deepEqual(signed,[-250,-100,150,600]);
  assert.ok(out.state.entries.some(e=>e.date==='2025-06-16'));
  assert.ok(out.state.entries.some(e=>e.date==='2025-05-19'));
});

test('monthly spending and Cash Money sections import as account income/expense rows',()=>{
  const workbook={sheets:[
    {name:'MONTHLY SPENDING',headers:['JULY MONEY SPENDING','Column 2','Column 3','Column 4'],rows:[
      {'JULY MONEY SPENDING':'DATE','Column 2':'NARRATION','Column 3':'AMOUNT','Column 4':'TOTAL'},
      {'JULY MONEY SPENDING':45838,'Column 2':'MONEY FOR THE MONTH','Column 3':500,'Column 4':500},
      {'JULY MONEY SPENDING':45845,'Column 2':'GYM MEMBERSHIP','Column 3':120,'Column 4':380}
    ]},
    {name:'LUBUMBASHI MONEY PAYMENTS',headers:['MONEY TO FAM IN LEBANON','Column 2','Column 3','Column 4','Column 5','Column 6','Column 7','Column 8','Column 9','Column 10','Column 11','Column 12','Column 13','Column 14','Column 15','Column 16','Column 17','Column 18','Column 19','Column 20','Column 21','CASH MONEY','Column 23','Column 24','Column 25','Column 26'],rows:[
      {'MONEY TO FAM IN LEBANON':'DATE','Column 2':'AMOUNT','Column 3':'FEES','Column 4':'TOTAL','Column 7':'DATE','Column 8':'AMOUNT','Column 9':'FEES','Column 10':'TOTAL','Column 13':'DATE','Column 14':'AMOUNT','Column 15':'TOTAL','Column 18':'DATE','Column 19':'AMOUNT','Column 20':'TOTAL','CASH MONEY':'DATE','Column 23':'NARRATION','Column 24':'CREDIT','Column 25':'DEBIT','Column 26':'TOTAL'},
      {'CASH MONEY':45828,'Column 23':'CURRENT AMOUNT IN HAND','Column 24':290,'Column 26':290},
      {'CASH MONEY':45831,'Column 23':'FOOD GROCERIES','Column 25':61.2,'Column 26':228.8}
    ]}
  ]};
  const out=applyLegacyWorkbook({state:baseState(),workbook,uidFactory:ids(),nowIso:()=> '2026-09-28T00:00:00.000Z'});
  assert.deepEqual(out.state.accounts.map(a=>a.name).sort(),['CASH MONEY','MONTHLY SPENDING']);
  assert.deepEqual(out.state.entries.map(e=>e.type).sort(),['account_expense','account_expense','account_income','account_income']);
});
