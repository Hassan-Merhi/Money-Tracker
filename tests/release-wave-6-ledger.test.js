import test from 'node:test';
import assert from 'node:assert/strict';
import { accountBalances, personBalances, totalsFromBalances, validateTransfer } from '../lib/ledger.js';
import { toMinor } from '../lib/money.js';

test('Wave 6: same-currency transfers must conserve money exactly',()=>{
  const usdA={id:'usd_a',currency:'USD'},usdB={id:'usd_b',currency:'USD'},eur={id:'eur',currency:'EUR'};
  assert.equal(validateTransfer(usdA,usdB,10,10),'');
  assert.match(validateTransfer(usdA,usdB,10,9.99),/same amount/i);
  assert.equal(validateTransfer(usdA,eur,10,9.25),'');
});

test('Wave 6: equal same-currency transfer leaves combined account value unchanged',()=>{
  const accounts=[
    {id:'a',currency:'USD',openingBalance:100.01},
    {id:'b',currency:'USD',openingBalance:25.99}
  ];
  const before=accountBalances([],accounts);
  const entries=[{id:'t',type:'account_transfer',fromAccountId:'a',toAccountId:'b',fromAmount:10.01,toAmount:10.01,amount:10.01,date:'2026-09-29'}];
  const after=accountBalances(entries,accounts);
  assert.equal(toMinor(before.a,'USD')+toMinor(before.b,'USD'),toMinor(after.a,'USD')+toMinor(after.b,'USD'));
  assert.equal(after.a,90);
  assert.equal(after.b,36);
});

test('Wave 6: dashboard totals tie exactly to per-person balances by currency',()=>{
  const people=[{id:'alice'},{id:'bob'},{id:'cara'}];
  const entries=[
    {type:'paid_for_person',personId:'alice',amount:100.01,currency:'USD'},
    {type:'received_from_person',personId:'alice',amount:0.01,currency:'USD'},
    {type:'borrowed_from_person',personId:'bob',amount:25,currency:'USD'},
    {type:'person_adjustment',personId:'cara',amount:1.234,signedAmount:1.234,currency:'KWD'}
  ];
  const balances=personBalances(entries,people),totals=totalsFromBalances(balances);
  assert.deepEqual(totals.USD,{owedToMe:100,iOwe:25,net:75});
  assert.deepEqual(totals.KWD,{owedToMe:1.234,iOwe:0,net:1.234});
  assert.equal(toMinor(totals.USD.net,'USD'),Object.values(balances).reduce((sum,row)=>sum+toMinor(row.USD||0,'USD'),0));
});
