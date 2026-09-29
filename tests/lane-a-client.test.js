import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const calls=[];
globalThis.fetch=async (path,options={})=>{
  calls.push({path:String(path),options});
  const body=String(path)==='/api/auth/me'
    ? {user:{id:'user_test',email:'test@example.com'},csrfToken:'csrf-lane-a'}
    : {version:9,settings:{displayName:'Money Tracker',defaultCurrency:'USD'},people:[],accounts:[],entries:[],categories:[],budgets:[]};
  return {ok:true,status:200,json:async()=>body,headers:new Headers()};
};

const store=await import(`../lib/store.js?lane-a-client=${Date.now()}`);

function last(){
  const call=calls.at(-1);
  return {...call,body:call.options?.body?JSON.parse(call.options.body):null};
}
function assertMutation(path,method,expectedRevision=8){
  const call=last();
  assert.equal(call.path,path);
  assert.equal(call.options.method,method);
  assert.equal(call.options.headers['X-CSRF-Token'],'csrf-lane-a');
  assert.equal(call.body.expectedRevision,expectedRevision);
}

test('browser store sends all daily ledger mutations to atomic endpoints',async()=>{
  await store.currentUser();

  await store.updateSettings({defaultCurrency:'EUR'},8);
  assertMutation('/api/settings','PUT');

  await store.createPerson({id:'person_a',name:'Alice'},8);
  assertMutation('/api/people','POST');

  await store.updatePerson('person_a',{name:'Alice Updated'},8);
  assertMutation('/api/people/person_a','PUT');

  await store.removePerson('person_a',8);
  assertMutation('/api/people/person_a','DELETE');

  await store.createAccount({id:'account_a',name:'Cash',type:'cash',currency:'USD',openingBalance:0},8);
  assertMutation('/api/accounts','POST');

  await store.updateAccount('account_a',{name:'Cashbox',type:'cash',openingBalance:5},8);
  assertMutation('/api/accounts/account_a','PUT');

  await store.removeAccount('account_a',8);
  assertMutation('/api/accounts/account_a','DELETE');

  await store.createEntry({id:'entry_a',type:'paid_for_person',personId:'person_a',amount:10,currency:'USD',date:'2026-09-29'},8);
  assertMutation('/api/entries','POST');

  await store.updateEntry('entry_a',{type:'paid_for_person',personId:'person_a',amount:11,currency:'USD',date:'2026-09-29'},8);
  assertMutation('/api/entries/entry_a','PUT');

  await store.removeEntry('entry_a',8);
  assertMutation('/api/entries/entry_a','DELETE');
});

test('daily app code no longer imports or calls whole-state save',()=>{
  const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  assert.equal(/\bsaveState\b/.test(app),false);
  assert.equal(/\/api\/state/.test(app),false);
  assert.match(app,/runMutation\(/);
  assert.match(app,/createPerson\(/);
  assert.match(app,/createEntry\(/);
});

test('bulk spreadsheet import intentionally keeps compatibility state save',()=>{
  const importer=readFileSync(new URL('../block-c-import.js',import.meta.url),'utf8');
  assert.match(importer,/saveState\(prepared\.state\)/);
});

test('service worker forces Lane A client refresh and caches exact-money dependency',()=>{
  const sw=readFileSync(new URL('../service-worker.js',import.meta.url),'utf8');
  assert.match(sw,/money-tracker-debt-v11/);
  assert.match(sw,/'\/lib\/money\.js'/);
});


test('backup and account lifecycle browser APIs use protected endpoints',async()=>{
  await store.exportFullBackup();
  assert.equal(last().path,'/api/backup/full');
  assert.equal(last().options.method,undefined);

  await store.restoreFullBackup({backupVersion:2,app:'money-owed-tracker',user:{},data:{}});
  assert.equal(last().path,'/api/backup/full/restore');
  assert.equal(last().options.method,'POST');
  assert.equal(last().options.headers['X-CSRF-Token'],'csrf-lane-a');

  await store.changePassword('old password value','new password value');
  assert.equal(last().path,'/api/auth/password');
  assert.equal(last().options.method,'POST');
  assert.equal(last().options.headers['X-CSRF-Token'],'csrf-lane-a');

  await store.revokeOtherSessions();
  assert.equal(last().path,'/api/auth/sessions/revoke-others');
  assert.equal(last().options.method,'POST');

  await store.resetUserPassword('user_other','replacement password');
  assert.equal(last().path,'/api/users/user_other/password');
  assert.equal(last().options.method,'POST');

  await store.deleteUserAccount('user_other');
  assert.equal(last().path,'/api/users/user_other');
  assert.equal(last().options.method,'DELETE');

  await store.deleteMyAccount('password','DELETE');
  assert.equal(last().path,'/api/account');
  assert.equal(last().options.method,'DELETE');
});


test('Lane B client has persisted modes and no hard-coded debt-only flag',()=>{
  const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  assert.equal(app.includes('DEBT_ONLY_MODE'),false);
  assert.match(app,/appMode==='advanced'/);
  assert.match(app,/Enable Advanced mode/);
});

test('Lane B recurring and Bank Feed clients expose durable reminder and undo actions',async()=>{
  await store.listRecurringReminders();
  assert.equal(last().path,'/api/recurring/reminders');
  await store.acknowledgeRecurringReminder('reminder_1');
  assert.equal(last().path,'/api/recurring/reminders/reminder_1');
  assert.equal(last().options.method,'POST');
  await store.undoBankFeedItem('bank_1',{expectedRevision:8});
  assert.equal(last().path,'/api/bank-feed/bank_1/undo');
  assert.equal(last().options.method,'POST');
  assert.equal(last().body.expectedRevision,8);
});
