import test from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx } from '../lib/xlsx.js';
import { parseWorkbook } from '../lib/xlsx-import.js';
import { applyImport, applyQuickPasteImport, dateValue, detectImportMode, guessHeader, parseQuickPaste, parseSplitDetails } from '../lib/importer.js';

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

test('debt transaction import works without an Account column',()=>{
  const rows=[{Date:'2026-09-28',Type:'borrowed_from_person',Person:'Alice',Amount:75,Currency:'USD',Description:'Covered dinner'}];
  const mapping={date:'Date',type:'Type',person:'Person',amount:'Amount',currency:'Currency',description:'Description'};
  const out=applyImport({state:baseState(),rows,mode:'transactions',mapping,uidFactory:ids()});
  assert.equal(out.result.people,1);assert.equal(out.result.accounts,0);assert.equal(out.result.entries,1);
  assert.equal(out.state.entries[0].accountId,null);assert.equal(out.state.entries[0].currency,'USD');
});

test('transfer import creates two accounts without changing people',()=>{
  const out=applyImport({state:baseState(),rows:[{Date:'2026-09-28',Type:'account_transfer',From:'Bank',To:'Cash',Amount:100,Currency:'USD','From Amount':100,'To Amount':100}],mode:'transactions',mapping:{date:'Date',type:'Type',fromAccount:'From',toAccount:'To',amount:'Amount',currency:'Currency',fromAmount:'From Amount',toAmount:'To Amount'},uidFactory:ids()});
  assert.equal(out.result.accounts,2);assert.equal(out.result.people,0);assert.equal(out.result.entries,1);
  assert.equal(out.state.entries[0].currency,null);
});


test('Block D split details round-trip into a Block B split purchase',()=>{
  assert.deepEqual(parseSplitDetails('Alice: 10 (Food) | Bob: 15'),[
    {name:'Alice',amount:10,note:'Food'},
    {name:'Bob',amount:15,note:''}
  ]);
  const out=applyImport({
    state:baseState(),
    rows:[{Date:'2026-09-28',Type:'split_paid_for_people',Account:'Bank',Amount:25,Currency:'USD','Split Details':'Alice: 10 (Food) | Bob: 15',Description:'Shared order'}],
    mode:'transactions',
    mapping:{date:'Date',type:'Type',account:'Account',amount:'Amount',currency:'Currency',splitDetails:'Split Details',description:'Description'},
    uidFactory:ids()
  });
  assert.equal(out.result.people,2);
  assert.equal(out.result.accounts,1);
  assert.equal(out.result.entries,1);
  assert.equal(out.state.entries[0].type,'split_paid_for_people');
  assert.deepEqual(out.state.entries[0].splits.map(s=>s.amount),[10,15]);
});


test('Block D bank expense and income rows round-trip through transaction import',()=>{
  const rows=[
    {Date:'2026-09-27',Type:'account_expense',Account:'Bank',Amount:25,Currency:'USD',Merchant:'Amazon',Description:'Personal order'},
    {Date:'2026-09-28',Type:'account_income',Account:'Bank',Amount:500,Currency:'USD',Merchant:'Employer',Description:'Payroll'}
  ];
  const mapping={date:'Date',type:'Type',account:'Account',amount:'Amount',currency:'Currency',merchant:'Merchant',description:'Description'};
  const out=applyImport({state:baseState(),rows,mode:'transactions',mapping,uidFactory:ids()});
  assert.equal(out.result.accounts,1);
  assert.equal(out.result.people,0);
  assert.equal(out.result.entries,2);
  assert.deepEqual(out.state.entries.map(e=>e.type),['account_expense','account_income']);
  assert.ok(out.state.entries.every(e=>e.accountId===out.state.accounts[0].id));
});


test('categorized account expense export rows re-import into matching existing categories',()=>{
  const state=baseState();
  state.categories=[
    {id:'category_food',name:'Food',kind:'expense',icon:'🍽️',archived:false},
    {id:'category_salary',name:'Salary',kind:'income',icon:'💼',archived:false}
  ];
  const rows=[
    {Date:'2026-09-28',Type:'account_expense',Account:'Bank',Amount:20,Currency:'USD',Category:'Food',Description:'Lunch'},
    {Date:'2026-09-28',Type:'account_income',Account:'Bank',Amount:300,Currency:'USD',Category:'Salary',Description:'Pay'}
  ];
  const out=applyImport({state,rows,mode:'transactions',mapping:{date:'Date',type:'Type',account:'Account',amount:'Amount',currency:'Currency',category:'Category',description:'Description'},uidFactory:ids()});
  assert.equal(out.result.entries,2);
  assert.deepEqual(out.state.entries.map(e=>e.categoryId),['category_food','category_salary']);
});

test('unknown imported categories do not block account expense migration',()=>{
  const state=baseState();state.categories=[{id:'category_food',name:'Food',kind:'expense',icon:'',archived:false}];
  const out=applyImport({state,rows:[{Date:'2026-09-28',Type:'account_expense',Account:'Bank',Amount:20,Currency:'USD',Category:'Unknown'}],mode:'transactions',mapping:{date:'Date',type:'Type',account:'Account',amount:'Amount',currency:'Currency',category:'Category'},uidFactory:ids()});
  assert.equal(out.result.entries,1);assert.equal(out.state.entries[0].categoryId,null);assert.match(out.result.errors[0],/uncategorized/);
});


test('transaction import compares split allocations in exact currency units',()=>{
  const out=applyImport({
    state:baseState(),
    rows:[{Date:'2026-09-28',Type:'split_paid_for_people',Account:'Bank',Amount:0.3,Currency:'USD','Split Details':'Alice: 0.1 | Bob: 0.2'}],
    mode:'transactions',
    mapping:{date:'Date',type:'Type',account:'Account',amount:'Amount',currency:'Currency',splitDetails:'Split Details'},
    uidFactory:ids()
  });
  assert.equal(out.result.entries,1);
  assert.deepEqual(out.state.entries[0].splits.map(s=>s.amount),[0.1,0.2]);
  assert.equal(out.result.errors.length,0);
});

test('transaction import rejects unsupported currency precision before save',()=>{
  const out=applyImport({
    state:baseState(),
    rows:[{Date:'2026-09-28',Type:'paid_for_person',Person:'Alice',Amount:1.001,Currency:'USD'}],
    mode:'transactions',
    mapping:{date:'Date',type:'Type',person:'Person',amount:'Amount',currency:'Currency'},
    uidFactory:ids()
  });
  assert.equal(out.result.entries,0);
  assert.equal(out.result.skipped,1);
  assert.match(out.result.errors[0],/at most 2 decimal/);
});


test('quick Excel paste accepts normal tab-separated rows with an optional header',()=>{
  const parsed=parseQuickPaste([
    'Name\tAmount\tDirection\tMerchant / Source\tDate\tDescription\tCurrency',
    'Adam\t120.50\tThey owe me\tAmazon\t29/09/2026\tOrder 123\tUSD',
    'Adam\t40\tTook from them\tCash\t30/09/2026\tPartial payment\tUSD'
  ].join('\n'));
  assert.equal(parsed.headerDetected,true);
  assert.equal(parsed.totalRows,2);
  assert.equal(parsed.errors.length,0);
  assert.deepEqual(parsed.rows.map(row=>row['Signed Amount']),[120.5,-40]);
  assert.deepEqual(parsed.rows.map(row=>row.Date),['2026-09-29','2026-09-30']);
  assert.deepEqual(parsed.rows.map(row=>row.Merchant),['Amazon','Cash']);
});

test('quick Excel paste supports positional rows when the header is not copied',()=>{
  const parsed=parseQuickPaste('Alice\t15\tThey paid me\tCash\t2026-09-29\tRepayment\tUSD');
  assert.equal(parsed.headerDetected,false);
  assert.equal(parsed.rows.length,1);
  assert.equal(parsed.rows[0].Person,'Alice');
  assert.equal(parsed.rows[0]['Signed Amount'],-15);
});

test('quick paste applies directly to person statements and safely skips exact re-imports',()=>{
  const uid=ids(),text=[
    'Name\tAmount\tDirection\tMerchant / Source\tDate',
    'Adam\t120\tThey owe me\tAmazon\t29/09/2026',
    'Adam\t40\tTook from them\tCash\t30/09/2026'
  ].join('\n');
  let out=applyQuickPasteImport({state:baseState(),text,uidFactory:uid,nowIso:()=> '2026-09-29T10:00:00.000Z'});
  assert.equal(out.result.people,1);
  assert.equal(out.result.entries,2);
  assert.deepEqual(out.state.entries.map(e=>e.type),['person_adjustment','person_adjustment']);
  assert.deepEqual(out.state.entries.map(e=>e.signedAmount),[120,-40]);
  assert.deepEqual(out.state.entries.map(e=>e.merchant),['Amazon','Cash']);
  out=applyQuickPasteImport({state:out.state,text,uidFactory:uid,nowIso:()=> '2026-09-29T10:05:00.000Z'});
  assert.equal(out.result.entries,0);
  assert.equal(out.result.skipped,2);
});

test('person-adjustment duplicate detection keeps opposite directions as separate rows',()=>{
  const rows=[
    {Date:'2026-09-29',Type:'person_adjustment',Person:'Adam',Amount:25,Currency:'USD',Direction:'They owe me',Merchant:'Cash'},
    {Date:'2026-09-29',Type:'person_adjustment',Person:'Adam',Amount:25,Currency:'USD',Direction:'I owe them',Merchant:'Cash'}
  ];
  const out=applyImport({state:baseState(),rows,mode:'transactions',mapping:{date:'Date',type:'Type',person:'Person',amount:'Amount',currency:'Currency',direction:'Direction',merchant:'Merchant'},uidFactory:ids()});
  assert.equal(out.result.entries,2);
  assert.deepEqual(out.state.entries.map(e=>e.signedAmount),[25,-25]);
});

test('quick paste reports invalid direction and date instead of silently guessing',()=>{
  const parsed=parseQuickPaste([
    'Name\tAmount\tDirection\tMerchant / Source\tDate',
    'Adam\t20\tMaybe\tAmazon\t29/09/2026',
    'Bob\t10\tThey owe me\tStore\tnot-a-date'
  ].join('\n'));
  assert.equal(parsed.rows.length,0);
  assert.equal(parsed.errors.length,2);
  assert.match(parsed.errors[0],/direction/i);
  assert.match(parsed.errors[1],/valid date/i);
});

test('date parser accepts ISO and day-first dates used in ordinary spreadsheets',()=>{
  assert.equal(dateValue('2026-09-29'),'2026-09-29');
  assert.equal(dateValue('29/09/2026'),'2026-09-29');
  assert.equal(dateValue('05/04/2026'),'2026-04-05');
});
