import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accountBalances } from '../lib/ledger.js';
import { DATA_LIMITS } from '../lib/data-limits.js';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('Wave 12: account balance recomputation traverses the ledger once, not once per account',()=>{
  const accounts=Array.from({length:1000},(_,i)=>({id:`account_${i}`,currency:'USD',openingBalance:1000}));
  const rows=[
    {type:'account_expense',accountId:'account_0',amount:5,currency:'USD'},
    {type:'account_transfer',fromAccountId:'account_0',toAccountId:'account_999',fromAmount:10,toAmount:10,amount:10},
    {type:'account_income',accountId:'account_999',amount:2,currency:'USD'}
  ];
  let iteratorCount=0;
  const entries={
    [Symbol.iterator](){iteratorCount++;return rows[Symbol.iterator]();}
  };
  const balances=accountBalances(entries,accounts);
  assert.equal(iteratorCount,1);
  assert.equal(balances.account_0,985);
  assert.equal(balances.account_999,1012);
});

test('Wave 12: account balances handle the declared 50k-entry / 1k-account ceiling',()=>{
  const accounts=Array.from({length:DATA_LIMITS.accounts},(_,i)=>({id:`account_${i}`,currency:'USD',openingBalance:1000}));
  const entries=Array.from({length:DATA_LIMITS.entries},(_,i)=>({type:'account_expense',accountId:`account_${i%DATA_LIMITS.accounts}`,amount:1,currency:'USD'}));
  const balances=accountBalances(entries,accounts);
  assert.equal(Object.keys(balances).length,DATA_LIMITS.accounts);
  assert.equal(balances.account_0,950);
  assert.equal(balances[`account_${DATA_LIMITS.accounts-1}`],950);
});

test('Wave 12: bulk state writes have room for a ledger at the declared storage ceiling',()=>{
  const server=read('server.mjs');
  assert.ok(DATA_LIMITS.stateBodyBytes>=64*1024*1024);
  assert.match(server,/bodyJson\(req,DATA_LIMITS\.stateBodyBytes\)/);
});

test('Wave 12: single-entry edits do not load the entire ledger to find one transaction',()=>{
  const server=read('server.mjs');
  assert.match(server,/entryById: db\.prepare/);
  const current=/function currentEntry\(userId,id\)\{([\s\S]*?)\n\}/.exec(server)?.[1]||'';
  assert.match(current,/q\.entryById\.get\(userId,id\)/);
  assert.doesNotMatch(current,/loadState\(/);
});

test('Wave 12: Bank Feed remains paginated while aggregate totals stay full-table',()=>{
  const source=read('lib/bank-server.js');
  assert.match(source,/LIMIT \? OFFSET \?/);
  assert.match(source,/statusCounts:db\.prepare/);
  assert.match(source,/pageCount:db\.prepare/);
  assert.match(source,/limit=Math\.max\(1,Math\.min\(500/);
});
