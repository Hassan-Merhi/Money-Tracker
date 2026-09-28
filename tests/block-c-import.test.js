import test from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx } from '../lib/xlsx.js';
import { parseWorkbook } from '../lib/xlsx-import.js';
import { applyImport, detectImportMode, guessHeader } from '../lib/importer.js';

const baseState=()=>({version:1,settings:{displayName:'Ledger',defaultCurrency:'USD'},people:[],accounts:[],entries:[]});
function ids(){let n=0;return prefix=>`${prefix}_${++n}`;}

test('Block D workbook output can be parsed back for import',()=>{
  const bytes=buildXlsx([{name:'People',rows:[['Name','Balance'],['Alice',12.5]]}],{title:'Round trip'});
  const parsed=parseWorkbook(Buffer.from(bytes));
  assert.equal(parsed.sheets[0].name,'People');
  assert.deepEqual(parsed.sheets[0].headers,['Name','Balance']);
  assert.equal(parsed.sheets[0].rows[0].Balance,12.5);
});

test('import mode and header suggestions recognize common sheets',()=>{
  assert.equal(detectImportMode(['Date','Type','Amount']),'transactions');
  assert.equal(detectImportMode(['Account Name','Type','Currency','Opening Balance']),'accounts');
  assert.equal(guessHeader(['Person Name','Balance'],['name','person']),'Person Name');
});

test('people import creates signed opening balances',()=>{
  const out=applyImport({state:baseState(),rows:[{Name:'Alice',Balance:50,Direction:'I owe them',Currency:'USD'}],mode:'people',mapping:{name:'Name',balance:'Balance',direction:'Direction',currency:'Currency'},uidFactory:ids(),today:()=> '2026-09-28',nowIso:()=> '2026-09-28T00:00:00.000Z'});
  assert.equal(out.result.people,1);assert.equal(out.result.entries,1);
  assert.equal(out.state.entries[0].type,'person_adjustment');assert.equal(out.state.entries[0].signedAmount,-50);
});

test('account import matches by name and currency',()=>{
  const uid=ids();
  let out=applyImport({state:baseState(),rows:[{Name:'Bank',Currency:'USD',Type:'Bank',Opening:100},{Name:'Bank',Currency:'EUR',Type:'Bank',Opening:20}],mode:'accounts',mapping:{name:'Name',currency:'Currency',type:'Type',openingBalance:'Opening'},uidFactory:uid});
  assert.equal(out.state.accounts.length,2);
  out=applyImport({state:out.state,rows:[{Name:'Bank',Currency:'USD',Type:'Bank',Opening:999}],mode:'accounts',mapping:{name:'Name',currency:'Currency',type:'Type',openingBalance:'Opening'},uidFactory:uid});
  assert.equal(out.result.accounts,0);assert.equal(out.result.skipped,1);assert.equal(out.state.accounts.length,2);
});

test('transaction import creates dependencies and skips an obvious duplicate',()=>{
  const uid=ids(),rows=[{Date:'2026-09-28',Type:'paid_for_person',Person:'Alice',Account:'Bank',Amount:25,Currency:'USD',Description:'Amazon'}],mapping={date:'Date',type:'Type',person:'Person',account:'Account',amount:'Amount',currency:'Currency',description:'Description'};
  let out=applyImport({state:baseState(),rows,mode:'transactions',mapping,uidFactory:uid});
  assert.equal(out.result.people,1);assert.equal(out.result.accounts,1);assert.equal(out.result.entries,1);
  out=applyImport({state:out.state,rows,mode:'transactions',mapping,uidFactory:uid});
  assert.equal(out.result.entries,0);assert.equal(out.result.skipped,1);
});

test('transfer import creates two accounts without changing people',()=>{
  const out=applyImport({state:baseState(),rows:[{Date:'2026-09-28',Type:'account_transfer',From:'Bank',To:'Cash',Amount:100,Currency:'USD','From Amount':100,'To Amount':100}],mode:'transactions',mapping:{date:'Date',type:'Type',fromAccount:'From',toAccount:'To',amount:'Amount',currency:'Currency',fromAmount:'From Amount',toAmount:'To Amount'},uidFactory:ids()});
  assert.equal(out.result.accounts,2);assert.equal(out.result.people,0);assert.equal(out.result.entries,1);
  assert.equal(out.state.entries[0].currency,null);
});
