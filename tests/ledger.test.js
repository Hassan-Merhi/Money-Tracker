import test from 'node:test';
import assert from 'node:assert/strict';
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
