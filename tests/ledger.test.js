import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { insightsSnapshot } from '../lib/insights.js';
import { reportingSnapshot, exportRows } from '../lib/reporting.js';
import { personDelta, accountDelta, personBalances, accountBalances, runningStatement, validateTransfer, validateSplit, entryTouchesPerson } from '../lib/ledger.js';

test('paying for someone increases what they owe me and reduces my account', () => {
  const e = { type:'paid_for_person', amount:120, accountId:'bank', personId:'p1', currency:'USD' };
  assert.equal(personDelta(e), 120);
  assert.equal(accountDelta(e, 'bank'), -120);
});

test('receiving repayment reduces what they owe me and increases account', () => {
  const e = { type:'received_from_person', amount:40, accountId:'cash', personId:'p1', currency:'USD' };
  assert.equal(personDelta(e), -40);
  assert.equal(accountDelta(e, 'cash'), 40);
});

test('borrowing from person makes my balance negative and increases account', () => {
  const e = { type:'borrowed_from_person', amount:300, accountId:'bank', personId:'p1', currency:'USD' };
  assert.equal(personDelta(e), -300);
  assert.equal(accountDelta(e, 'bank'), 300);
});

test('paying a person back moves negative balance toward zero', () => {
  const e = { type:'paid_to_person', amount:125, accountId:'bank', personId:'p1', currency:'USD' };
  assert.equal(personDelta(e), 125);
  assert.equal(accountDelta(e, 'bank'), -125);
});

test('transfer supports different source and destination amounts', () => {
  const e = { type:'account_transfer', fromAccountId:'usd', toAccountId:'lbp', fromAmount:10, toAmount:900000 };
  assert.equal(accountDelta(e, 'usd'), -10);
  assert.equal(accountDelta(e, 'lbp'), 900000);
});

test('aggregate balances are correct', () => {
  const people = [{id:'p1'}];
  const accounts = [{id:'bank', openingBalance:1000}];
  const entries = [
    {type:'paid_for_person', amount:100, accountId:'bank', personId:'p1', currency:'USD'},
    {type:'received_from_person', amount:25, accountId:'bank', personId:'p1', currency:'USD'}
  ];
  assert.equal(personBalances(entries, people).p1.USD, 75);
  assert.equal(accountBalances(entries, accounts).bank, 925);
});

test('running statement orders chronologically', () => {
  const entries = [
    {id:'b', type:'received_from_person', amount:20, personId:'p1', currency:'USD', date:'2026-01-02', createdAt:'2026-01-02T00:00:00Z'},
    {id:'a', type:'paid_for_person', amount:50, personId:'p1', currency:'USD', date:'2026-01-01', createdAt:'2026-01-01T00:00:00Z'}
  ];
  const rows = runningStatement(entries, 'p1', 'USD');
  assert.deepEqual(rows.map(r => r.running), [50,30]);
});

test('running statement keeps running balance separate per currency', () => {
  const entries = [
    {id:'a', type:'paid_for_person', amount:100, personId:'p1', currency:'USD', date:'2026-01-01', createdAt:'2026-01-01T00:00:00Z'},
    {id:'b', type:'paid_for_person', amount:100, personId:'p1', currency:'EUR', date:'2026-01-02', createdAt:'2026-01-02T00:00:00Z'},
    {id:'c', type:'received_from_person', amount:25, personId:'p1', currency:'USD', date:'2026-01-03', createdAt:'2026-01-03T00:00:00Z'}
  ];
  const rows = runningStatement(entries, 'p1');
  assert.deepEqual(rows.map(r => r.running), [100,100,75]);
  assert.deepEqual(rows.map(r => r.delta), [100,100,-25]);
});

test('transfer validation blocks same account', () => {
  const a = {id:'x'};
  assert.ok(validateTransfer(a,a,1,1));
});


test('split purchase charges one account once and allocates each person separately', () => {
  const people=[{id:'p1'},{id:'p2'}];
  const accounts=[{id:'bank',openingBalance:500}];
  const entry={id:'split1',type:'split_paid_for_people',accountId:'bank',amount:90,currency:'USD',date:'2026-09-28',createdAt:'2026-09-28T10:00:00Z',splits:[{personId:'p1',amount:40,note:'Shoes'},{personId:'p2',amount:50,note:'Book'}]};
  const balances=personBalances([entry],people);
  assert.equal(balances.p1.USD,40);
  assert.equal(balances.p2.USD,50);
  assert.equal(accountBalances([entry],accounts).bank,410);
  assert.equal(personDelta(entry,'p1'),40);
  assert.equal(personDelta(entry,'p2'),50);
  assert.equal(entryTouchesPerson(entry,'p2'),true);
  assert.equal(runningStatement([entry],'p1','USD')[0].description,'Shoes');
});

test('split validation rejects duplicates and totals that do not match', () => {
  assert.equal(validateSplit([{personId:'p1',amount:40},{personId:'p2',amount:60}],100),'');
  assert.match(validateSplit([{personId:'p1',amount:40},{personId:'p1',amount:60}],100),/only once/);
  assert.match(validateSplit([{personId:'p1',amount:40},{personId:'p2',amount:50}],100),/add up/);
});


test('account-only expenses and income change account balance without changing people',()=>{
  const accounts=[{id:'bank',openingBalance:1000}];
  const entries=[
    {type:'account_expense',amount:75,accountId:'bank',currency:'USD'},
    {type:'account_income',amount:200,accountId:'bank',currency:'USD'}
  ];
  assert.equal(accountDelta(entries[0],'bank'),-75);
  assert.equal(accountDelta(entries[1],'bank'),200);
  assert.equal(accountBalances(entries,accounts).bank,1125);
});


const mixedPeople=[{id:'p1',name:'Alice'},{id:'p2',name:'Bob'}];
const mixedAccounts=[
  {id:'usd',name:'Bank',type:'bank',currency:'USD',openingBalance:1000},
  {id:'lbp',name:'Cash LBP',type:'cash',currency:'LBP',openingBalance:500000},
  {id:'eur',name:'Euro',type:'bank',currency:'EUR',openingBalance:0}
];
const mixedCategories=[{id:'category_food',name:'Food',kind:'expense',icon:'',archived:false}];
const baseEntries=[
  {id:'e1',type:'paid_for_person',personId:'p1',accountId:'usd',amount:120,currency:'USD',date:'2026-09-01',merchant:'Amazon',createdAt:'2026-09-01T10:00:00Z'},
  {id:'e2',type:'received_from_person',personId:'p1',accountId:'lbp',amount:150000,currency:'LBP',date:'2026-09-02',createdAt:'2026-09-02T10:00:00Z'},
  {id:'e3',type:'borrowed_from_person',personId:'p2',accountId:'usd',amount:300,currency:'USD',date:'2026-09-03',createdAt:'2026-09-03T10:00:00Z'},
  {id:'e4',type:'paid_to_person',personId:'p2',accountId:'usd',amount:125,currency:'USD',date:'2026-09-04',createdAt:'2026-09-04T10:00:00Z'},
  {id:'e5',type:'person_adjustment',personId:'p1',accountId:null,amount:15,signedAmount:-15,currency:'USD',date:'2026-09-05',createdAt:'2026-09-05T10:00:00Z'},
  {id:'e6',type:'account_transfer',fromAccountId:'usd',toAccountId:'eur',fromAmount:100,toAmount:92,amount:100,date:'2026-09-06',createdAt:'2026-09-06T10:00:00Z'},
  {id:'e7',type:'split_paid_for_people',accountId:'usd',amount:90,currency:'USD',date:'2026-09-07',createdAt:'2026-09-07T10:00:00Z',splits:[{personId:'p1',amount:40},{personId:'p2',amount:50}]},
  {id:'e8',type:'account_expense',accountId:'usd',amount:75,currency:'USD',date:'2026-09-08',merchant:'Cafe',categoryId:'category_food',createdAt:'2026-09-08T10:00:00Z'},
  {id:'e9',type:'account_income',accountId:'lbp',amount:200000,currency:'LBP',date:'2026-09-09',createdAt:'2026-09-09T10:00:00Z'}
];
const adjustments=[
  {id:'a1',type:'account_adjustment',accountId:'usd',amount:50,signedAmount:50,currency:'USD',date:'2026-09-10',merchant:'',description:'Bank reconciliation',createdAt:'2026-09-10T10:00:00Z'},
  {id:'a2',type:'account_adjustment',accountId:'lbp',amount:25000,signedAmount:-25000,currency:'LBP',date:'2026-10-02',merchant:'',description:'Cash count',createdAt:'2026-10-02T10:00:00Z'}
];
const stateOf=entries=>({settings:{defaultCurrency:'USD'},people:mixedPeople,accounts:mixedAccounts,categories:mixedCategories,budgets:[],entries});

test('accountDelta agrees with accountBalances on a mixed entry set',()=>{
  const entries=[...baseEntries,...adjustments];
  const balances=accountBalances(entries,mixedAccounts);
  for(const account of mixedAccounts){
    const summed=entries.reduce((sum,entry)=>sum+accountDelta(entry,account.id),account.openingBalance);
    assert.equal(balances[account.id],summed,`account ${account.id}`);
  }
});

test('account adjustment moves only its account by the signed amount',()=>{
  const before=accountBalances(baseEntries,mixedAccounts);
  const after=accountBalances([...baseEntries,adjustments[0]],mixedAccounts);
  assert.equal(after.usd,before.usd+50);
  assert.equal(after.lbp,before.lbp);
  assert.equal(after.eur,before.eur);
  const down=accountBalances([...baseEntries,adjustments[1]],mixedAccounts);
  assert.equal(down.lbp,before.lbp-25000);
  assert.equal(accountDelta(adjustments[0],'usd'),50);
  assert.equal(accountDelta(adjustments[0],'lbp'),0);
  assert.equal(accountDelta(adjustments[1],'lbp'),-25000);
});

test('account adjustment never touches people balances or statements',()=>{
  const before=personBalances(baseEntries,mixedPeople);
  const after=personBalances([...baseEntries,...adjustments],mixedPeople);
  assert.deepEqual(after,before);
  assert.equal(personDelta(adjustments[0]),0);
  assert.equal(entryTouchesPerson(adjustments[0],'p1'),false);
  assert.deepEqual(runningStatement([...baseEntries,...adjustments],'p1','USD').map(r=>r.id),['e1','e5','e7']);
});

test('insightsSnapshot ignores account adjustments',()=>{
  const before=insightsSnapshot(stateOf(baseEntries),'2026-09',{trendMonths:3});
  const after=insightsSnapshot(stateOf([...baseEntries,...adjustments]),'2026-09',{trendMonths:3});
  assert.deepEqual(after,before);
  const october=insightsSnapshot(stateOf([...baseEntries,...adjustments]),'2026-10',{trendMonths:3});
  assert.deepEqual(october.totals,{});
});

test('reportingSnapshot leaves every spend, income, person and monthly figure untouched',()=>{
  const before=reportingSnapshot(stateOf(baseEntries));
  const after=reportingSnapshot(stateOf([...baseEntries,...adjustments]));
  for(const key of ['activity','personalCashFlow','categorySpending','merchants','monthly','outstanding','budgets'])assert.deepEqual(after[key],before[key],key);
  assert.equal(after.monthly.some(row=>row.month==='2026-10'),false,'an adjustment must not create an empty month row');
  const usdBefore=before.accounts.find(a=>a.accountId==='usd').balance;
  assert.equal(after.accounts.find(a=>a.accountId==='usd').balance,usdBefore+50);
  assert.equal(after.accounts.find(a=>a.accountId==='lbp').balance,before.accounts.find(a=>a.accountId==='lbp').balance-25000);
});

test('account adjustments appear in transaction exports',()=>{
  const rows=exportRows(stateOf([...baseEntries,adjustments[0]]),{type:'account_adjustment'});
  assert.equal(rows.length,1);
  assert.equal(rows[0].Type,'account_adjustment');
  assert.equal(rows[0]['Account ID'],'usd');
  assert.equal(rows[0].Amount,50);
  assert.equal(rows[0].Currency,'USD');
});

test('dead totalsByCurrency helper is gone',()=>{
  const source=readFileSync(new URL('../lib/ledger.js',import.meta.url),'utf8');
  assert.equal(/totalsByCurrency/.test(source),false);
});
