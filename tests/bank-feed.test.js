import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBankCsv, parseBankDate, suggestBankMapping, normalizeBankRows } from '../lib/bank-feed.js';

test('parses quoted CSV bank statements',()=>{
  const parsed=parseBankCsv('Date,Description,Amount\n2026-09-01,"Shop, Beirut",-12.50\n');
  assert.deepEqual(parsed.headers,['Date','Description','Amount']);
  assert.equal(parsed.rows[0].Description,'Shop, Beirut');
});

test('suggests common statement columns',()=>{
  const m=suggestBankMapping(['Posting Date','Narrative','Debit','Credit','Currency']);
  assert.equal(m.date,'Posting Date'); assert.equal(m.description,'Narrative'); assert.equal(m.debit,'Debit'); assert.equal(m.credit,'Credit');
});

test('generic Amount stays a signed amount and is never misclassified as debit plus credit',()=>{
  const m=suggestBankMapping(['Date','Description','Amount']);
  assert.equal(m.date,'Date');
  assert.equal(m.description,'Description');
  assert.equal(m.amount,'Amount');
  assert.equal(m.debit,'');
  assert.equal(m.credit,'');
});

test('normalizes debit and credit rows into signed amounts',()=>{
  const rows=[
    {'Date':'28/09/2026','Memo':'Amazon','Debit':'25.40','Credit':'','CCY':'USD'},
    {'Date':'29/09/2026','Memo':'Salary','Debit':'','Credit':'1000','CCY':'USD'}
  ];
  const out=normalizeBankRows(rows,{date:'Date',description:'Memo',debit:'Debit',credit:'Credit',currency:'CCY'},{dateOrder:'dmy'});
  assert.equal(out.errors.length,0); assert.equal(out.items[0].signedAmount,-25.4); assert.equal(out.items[1].signedAmount,1000);
});

test('supports positive-outflow amount statements and date order',()=>{
  const rows=[{Date:'09/28/2026',Details:'Card purchase',Amount:'19.99'}];
  const out=normalizeBankRows(rows,{date:'Date',description:'Details',amount:'Amount'},{dateOrder:'mdy',amountDirection:'outflow_positive',fallbackCurrency:'USD'});
  assert.equal(out.items[0].date,'2026-09-28'); assert.equal(out.items[0].signedAmount,-19.99);
  assert.equal(parseBankDate('28/09/2026','dmy'),'2026-09-28');
});


test('parses semicolon-delimited bank CSV exports',()=>{
  const parsed=parseBankCsv('Date;Description;Amount\n2026-09-28;Coffee;-4.50\n');
  assert.deepEqual(parsed.headers,['Date','Description','Amount']);
  assert.equal(parsed.rows[0].Description,'Coffee');
  assert.equal(parsed.rows[0].Amount,'-4.50');
});


test('recognizes common international bank statement header variants',()=>{
  const m=suggestBankMapping(['Booking Date','Transaction Details','Debit Amount','Credit Amount','Currency Code','Bank ID']);
  assert.equal(m.date,'Booking Date');
  assert.equal(m.description,'Transaction Details');
  assert.equal(m.debit,'Debit Amount');
  assert.equal(m.credit,'Credit Amount');
  assert.equal(m.currency,'Currency Code');
  assert.equal(m.externalId,'Bank ID');
});

test('normalizes European-formatted statement amounts and withdrawal/deposit columns',()=>{
  const rows=[
    {'Value Date':'29.09.2026','Details':'Restaurant','Withdrawal Amount':'1.234,56','Deposit Amount':'','Currency':'EUR'},
    {'Value Date':'30.09.2026','Details':'Refund','Withdrawal Amount':'','Deposit Amount':'100,25','Currency':'EUR'}
  ];
  const mapping=suggestBankMapping(Object.keys(rows[0]));
  const out=normalizeBankRows(rows,mapping,{dateOrder:'dmy',fallbackCurrency:'EUR'});
  assert.equal(out.errors.length,0);
  assert.equal(out.items[0].signedAmount,-1234.56);
  assert.equal(out.items[1].signedAmount,100.25);
});

test('reconcileFeed matches posted signed amounts to ledger movements and excludes opening balances',async()=>{
  const {reconcileFeed}=await import('../lib/bank-feed.js');
  const accounts=[{id:'a',name:'Bank',currency:'USD'},{id:'b',name:'Cash',currency:'USD'}];
  const entries=[{id:'opening',type:'opening_balance',accountId:'a',amount:1000},{type:'account_expense',accountId:'a',amount:45},{type:'account_income',accountId:'a',amount:20},{type:'account_transfer',fromAccountId:'a',toAccountId:'b',fromAmount:10,toAmount:10}];
  const items=[{accountId:'a',status:'posted',signedAmount:-45},{accountId:'a',status:'posted',signedAmount:20},{accountId:'a',status:'posted',signedAmount:-10},{accountId:'b',status:'posted',signedAmount:10}];
  const result=reconcileFeed(items,entries,accounts);
  assert.equal(result[0].postedAmount,-35);assert.equal(result[0].ledgerAmount,-35);assert.equal(result[1].postedAmount,10);assert.equal(result[1].ledgerAmount,10);
});

test('reconcileFeed exposes edited-entry amount mismatches',async()=>{
  const {reconcileFeed}=await import('../lib/bank-feed.js');
  const [result]=reconcileFeed([{accountId:'a',status:'posted',signedAmount:-45}],[{type:'account_expense',accountId:'a',amount:60}],[{id:'a',name:'Bank',currency:'USD'}]);
  assert.equal(result.postedAmount,-45);assert.equal(result.ledgerAmount,-60);assert.notEqual(result.postedAmount,result.ledgerAmount);
});
