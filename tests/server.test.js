import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(),'mot-block-a-'));
process.env.DB_PATH = join(dir,'test.sqlite');
process.env.NODE_ENV = 'test';
const { server, db } = await import(`../server.mjs?test=${Date.now()}`);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;

async function request(path,{method='GET',body,cookie,csrf}={}){
  const headers={}; if(body!==undefined)headers['content-type']='application/json'; if(cookie)headers.cookie=cookie;if(csrf)headers['x-csrf-token']=csrf;
  const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json(); return {res,data,cookie:res.headers.get('set-cookie')?.split(';')[0]};
}
async function requestRaw(path,{method='GET',cookie,csrf}={}){
  const headers={}; if(cookie)headers.cookie=cookie;if(csrf)headers['x-csrf-token']=csrf;
  const res=await fetch(base+path,{method,headers});
  const data=Buffer.from(await res.arrayBuffer());
  return {res,data};
}

let cookie,csrf,state,attachmentId,secondUserEmail;

test('allows public signup only for the first owner account',async()=>{
  const before=await request('/api/auth/status'); assert.equal(before.res.status,200); assert.equal(before.data.registrationOpen,true);
  const email=`owner-${Date.now()}@example.com`;
  const r=await request('/api/auth/register',{method:'POST',body:{email,password:'correct horse battery staple'}});
  assert.equal(r.res.status,201); assert.ok(r.cookie?.startsWith('mot_session=')); assert.ok(r.data.csrfToken); assert.equal(r.data.user.isOwner,true);
  cookie=r.cookie; csrf=r.data.csrfToken;
  const me=await request('/api/auth/me',{cookie}); assert.equal(me.res.status,200); assert.equal(me.data.user.email,email); assert.equal(me.data.user.isOwner,true);
  const after=await request('/api/auth/status'); assert.equal(after.data.registrationOpen,false);
  const blocked=await request('/api/auth/register',{method:'POST',body:{email:`blocked-${Date.now()}@example.com`,password:'another secure password'}});
  assert.equal(blocked.res.status,403);
  const s=await request('/api/state',{cookie}); assert.equal(s.res.status,200); assert.equal(s.data.settings.displayName,'Money Tracker'); assert.deepEqual(s.data.people,[]);state=s.data;
});

test('rejects writes without CSRF',async()=>{
  const r=await request('/api/state',{method:'PUT',cookie,body:state}); assert.equal(r.res.status,403);
});

test('persists people accounts and transactions in the database',async()=>{
  const t=new Date().toISOString();
  state.people=[{id:'person_alice',name:'Alice',note:'Cousin',createdAt:t}];
  state.accounts=[{id:'account_bank',name:'Main Bank',type:'bank',currency:'USD',openingBalance:1000,createdAt:t}];
  state.entries=[{id:'entry_1',type:'paid_for_person',personId:'person_alice',accountId:'account_bank',amount:125,currency:'USD',date:'2026-09-28',merchant:'Amazon',description:'Order',createdAt:t,updatedAt:t}];
  const put=await request('/api/state',{method:'PUT',cookie,csrf,body:state}); assert.equal(put.res.status,200); assert.equal(put.data.version,state.version+1); state=put.data;
  const read=await request('/api/state',{cookie}); assert.equal(read.data.people[0].name,'Alice'); assert.equal(read.data.accounts[0].openingBalance,1000); assert.equal(read.data.entries[0].amount,125);
  const accountRow=db.prepare("SELECT opening_balance_minor AS openingMinor,typeof(opening_balance_minor) AS storageType FROM accounts WHERE user_id=? AND id='account_bank'").get(read.data.settings?db.prepare("SELECT id FROM users WHERE email LIKE 'owner-%' LIMIT 1").get().id:null);
  assert.equal(accountRow.openingMinor,100000);assert.equal(accountRow.storageType,'integer');
  const entryRow=db.prepare("SELECT amount_minor AS amountMinor,typeof(amount_minor) AS storageType FROM entries WHERE id='entry_1'").get();
  assert.equal(entryRow.amountMinor,12500);assert.equal(entryRow.storageType,'integer');
});


test('supports person debt activity without any bank or cash account',async()=>{
  const t=new Date().toISOString();
  state.entries.push({id:'entry_debt_only',type:'borrowed_from_person',personId:'person_alice',accountId:null,amount:40,currency:'USD',date:'2026-09-28',merchant:'',description:'Alice covered dinner',createdAt:t,updatedAt:t});
  const put=await request('/api/state',{method:'PUT',cookie,csrf,body:state});
  assert.equal(put.res.status,200);state=put.data;
  const entry=state.entries.find(e=>e.id==='entry_debt_only');
  assert.equal(entry.accountId,null);assert.equal(entry.currency,'USD');assert.equal(entry.amount,40);
});

test('rejects money with precision the currency cannot store',async()=>{
  const t=new Date().toISOString();
  const invalid={...state,entries:[...state.entries,{id:'entry_bad_precision',type:'paid_for_person',personId:'person_alice',accountId:null,amount:1.001,currency:'USD',date:'2026-09-28',merchant:'',description:'Too precise',createdAt:t,updatedAt:t}]};
  const put=await request('/api/state',{method:'PUT',cookie,csrf,body:invalid});
  assert.equal(put.res.status,400);assert.match(put.data.error,/at most 2 decimal/);
});

test('persists validated split allocations',async()=>{
  const t=new Date().toISOString();
  state.people.push({id:'person_bob',name:'Bob',note:'Friend',createdAt:t});
  const invalid={...state,entries:[...state.entries,{id:'entry_bad_split',type:'split_paid_for_people',accountId:'account_bank',amount:100,currency:'USD',date:'2026-09-28',merchant:'Shop',description:'Bad split',splits:[{personId:'person_alice',amount:40},{personId:'person_bob',amount:50}],createdAt:t,updatedAt:t}]};
  const bad=await request('/api/state',{method:'PUT',cookie,csrf,body:invalid});
  assert.equal(bad.res.status,400);

  state.entries.push({id:'entry_split',type:'split_paid_for_people',accountId:'account_bank',amount:100,currency:'USD',date:'2026-09-28',merchant:'Shop',description:'Shared order',splits:[{personId:'person_alice',amount:40,note:'Item A'},{personId:'person_bob',amount:60,note:'Item B'}],createdAt:t,updatedAt:t});
  const put=await request('/api/state',{method:'PUT',cookie,csrf,body:state});
  assert.equal(put.res.status,200); state=put.data;
  const split=state.entries.find(entry=>entry.id==='entry_split');
  assert.deepEqual(split.splits,[{personId:'person_alice',amount:40,note:'Item A'},{personId:'person_bob',amount:60,note:'Item B'}]);
  const stored=JSON.parse(db.prepare("SELECT split_json AS splitJson FROM entries WHERE id='entry_split'").get().splitJson);
  assert.deepEqual(stored.map(row=>row.amountMinor),[4000,6000]);assert.equal(Object.hasOwn(stored[0],'amount'),false);
});

test('stores authenticated receipt attachments outside ledger state',async()=>{
  const noCsrf=await request('/api/attachments',{method:'POST',cookie,body:{entryId:'entry_split',name:'receipt.txt',mimeType:'text/plain',data:Buffer.from('receipt').toString('base64')}});
  assert.equal(noCsrf.res.status,403);
  const upload=await request('/api/attachments',{method:'POST',cookie,csrf,body:{entryId:'entry_split',name:'receipt.txt',mimeType:'text/plain',data:Buffer.from('receipt').toString('base64')}});
  assert.equal(upload.res.status,201); attachmentId=upload.data.attachment.id;
  const list=await request('/api/attachments?entry=entry_split',{cookie});
  assert.equal(list.res.status,200); assert.equal(list.data.attachments.length,1); assert.equal(list.data.attachments[0].name,'receipt.txt');
  const raw=await requestRaw(`/api/attachments/${attachmentId}`,{cookie});
  assert.equal(raw.res.status,200); assert.equal(raw.data.toString(),'receipt');
  const refreshed=await request('/api/state',{cookie});
  assert.equal(refreshed.data.entries.find(entry=>entry.id==='entry_split').attachmentCount,1);
});

test('blocks stale-tab overwrites with optimistic revision checks',async()=>{
  const stale={...state,version:state.version-1};
  const r=await request('/api/state',{method:'PUT',cookie,csrf,body:stale}); assert.equal(r.res.status,409);
});


test('atomic ledger API requires CSRF and rejects stale revisions',async()=>{
  const noCsrf=await request('/api/people',{method:'POST',cookie,body:{expectedRevision:state.version,id:'person_no_csrf',name:'No CSRF'}});
  assert.equal(noCsrf.res.status,403);
  const staleVersion=state.version-1;
  const stale=await request('/api/people',{method:'POST',cookie,csrf,body:{expectedRevision:staleVersion,id:'person_stale_api',name:'Stale'}});
  assert.equal(stale.res.status,409);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM people WHERE id='person_stale_api'").get().count,0);
});

test('people API creates and edits one person without rewriting unrelated ledger rows',async()=>{
  db.exec(`
    CREATE TABLE IF NOT EXISTS lane_a_mutation_probe(kind TEXT NOT NULL);
    DELETE FROM lane_a_mutation_probe;
    DROP TRIGGER IF EXISTS lane_a_probe_entry_delete;
    DROP TRIGGER IF EXISTS lane_a_probe_account_delete;
    DROP TRIGGER IF EXISTS lane_a_probe_person_delete;
    CREATE TRIGGER lane_a_probe_entry_delete AFTER DELETE ON entries BEGIN INSERT INTO lane_a_mutation_probe(kind) VALUES('entry_delete'); END;
    CREATE TRIGGER lane_a_probe_account_delete AFTER DELETE ON accounts BEGIN INSERT INTO lane_a_mutation_probe(kind) VALUES('account_delete'); END;
    CREATE TRIGGER lane_a_probe_person_delete AFTER DELETE ON people BEGIN INSERT INTO lane_a_mutation_probe(kind) VALUES('person_delete'); END;
  `);
  const beforeVersion=state.version;
  const created=await request('/api/people',{method:'POST',cookie,csrf,body:{expectedRevision:state.version,id:'person_charlie',name:'Charlie',note:'API person'}});
  assert.equal(created.res.status,201);assert.equal(created.data.version,beforeVersion+1);state=created.data;
  assert.equal(state.people.find(p=>p.id==='person_charlie').note,'API person');
  assert.deepEqual(db.prepare('SELECT kind FROM lane_a_mutation_probe').all(),[]);

  const updated=await request('/api/people/person_charlie',{method:'PUT',cookie,csrf,body:{expectedRevision:state.version,name:'Charles',note:'Updated atomically'}});
  assert.equal(updated.res.status,200);state=updated.data;
  assert.equal(state.people.find(p=>p.id==='person_charlie').name,'Charles');
  assert.deepEqual(db.prepare('SELECT kind FROM lane_a_mutation_probe').all(),[]);
});

test('people API creates opening balance atomically and enforces dependency-safe deletion',async()=>{
  const beforeVersion=state.version;
  const created=await request('/api/people',{method:'POST',cookie,csrf,body:{
    expectedRevision:state.version,id:'person_dana',name:'Dana',note:'Opening debt',openingBalance:12.34,currency:'USD',direction:'i_owe',openingEntryId:'entry_dana_open',openingDate:'2026-09-29'
  }});
  assert.equal(created.res.status,201);assert.equal(created.data.version,beforeVersion+1);state=created.data;
  const opening=state.entries.find(e=>e.id==='entry_dana_open');
  assert.equal(opening.type,'person_adjustment');assert.equal(opening.amount,12.34);assert.equal(opening.signedAmount,-12.34);
  const stored=db.prepare("SELECT amount_minor AS amountMinor,signed_amount_minor AS signedMinor FROM entries WHERE id='entry_dana_open'").get();
  assert.equal(stored.amountMinor,1234);assert.equal(stored.signedMinor,-1234);

  const blocked=await request('/api/people/person_dana',{method:'DELETE',cookie,csrf,body:{expectedRevision:state.version}});
  assert.equal(blocked.res.status,400);assert.match(blocked.data.error,/transactions first/);

  const delEntry=await request('/api/entries/entry_dana_open',{method:'DELETE',cookie,csrf,body:{expectedRevision:state.version}});
  assert.equal(delEntry.res.status,200);state=delEntry.data;
  const delPerson=await request('/api/people/person_dana',{method:'DELETE',cookie,csrf,body:{expectedRevision:state.version}});
  assert.equal(delPerson.res.status,200);state=delPerson.data;
  assert.equal(state.people.some(p=>p.id==='person_dana'),false);
});

test('accounts API creates updates and deletes a single account with exact money storage',async()=>{
  const created=await request('/api/accounts',{method:'POST',cookie,csrf,body:{expectedRevision:state.version,id:'account_cash_api',name:'API Cash',type:'cash',currency:'USD',openingBalance:50.25}});
  assert.equal(created.res.status,201);state=created.data;
  assert.equal(db.prepare("SELECT opening_balance_minor AS v FROM accounts WHERE id='account_cash_api'").get().v,5025);

  const updated=await request('/api/accounts/account_cash_api',{method:'PUT',cookie,csrf,body:{expectedRevision:state.version,name:'API Cashbox',type:'cash',openingBalance:75.5}});
  assert.equal(updated.res.status,200);state=updated.data;
  assert.equal(state.accounts.find(a=>a.id==='account_cash_api').openingBalance,75.5);
  assert.equal(db.prepare("SELECT opening_balance_minor AS v FROM accounts WHERE id='account_cash_api'").get().v,7550);

  const badCurrency=await request('/api/accounts/account_cash_api',{method:'PUT',cookie,csrf,body:{expectedRevision:state.version,name:'API Cashbox',type:'cash',currency:'EUR',openingBalance:75.5}});
  assert.equal(badCurrency.res.status,400);assert.match(badCurrency.data.error,/currency cannot be changed/);

  const removed=await request('/api/accounts/account_cash_api',{method:'DELETE',cookie,csrf,body:{expectedRevision:state.version}});
  assert.equal(removed.res.status,200);state=removed.data;
  assert.equal(state.accounts.some(a=>a.id==='account_cash_api'),false);
});

test('entries API creates updates and deletes only the target transaction and cleans attachments',async()=>{
  db.prepare('DELETE FROM lane_a_mutation_probe').run();
  const created=await request('/api/entries',{method:'POST',cookie,csrf,body:{
    expectedRevision:state.version,id:'entry_api_atomic',type:'paid_for_person',personId:'person_charlie',accountId:null,amount:10.29,currency:'USD',date:'2026-09-29',merchant:'API',description:'Atomic create',splits:[]
  }});
  assert.equal(created.res.status,201);state=created.data;
  assert.equal(db.prepare("SELECT amount_minor AS v FROM entries WHERE id='entry_api_atomic'").get().v,1029);
  assert.deepEqual(db.prepare('SELECT kind FROM lane_a_mutation_probe').all(),[]);

  const updated=await request('/api/entries/entry_api_atomic',{method:'PUT',cookie,csrf,body:{
    expectedRevision:state.version,type:'paid_for_person',personId:'person_charlie',accountId:null,amount:11.31,currency:'USD',date:'2026-09-29',merchant:'API',description:'Atomic update',splits:[]
  }});
  assert.equal(updated.res.status,200);state=updated.data;
  assert.equal(state.entries.find(e=>e.id==='entry_api_atomic').amount,11.31);
  assert.equal(db.prepare("SELECT amount_minor AS v FROM entries WHERE id='entry_api_atomic'").get().v,1131);
  assert.deepEqual(db.prepare('SELECT kind FROM lane_a_mutation_probe').all(),[]);

  const upload=await request('/api/attachments',{method:'POST',cookie,csrf,body:{entryId:'entry_api_atomic',name:'atomic.txt',mimeType:'text/plain',data:Buffer.from('atomic').toString('base64')}});
  assert.equal(upload.res.status,201);
  const removed=await request('/api/entries/entry_api_atomic',{method:'DELETE',cookie,csrf,body:{expectedRevision:state.version}});
  assert.equal(removed.res.status,200);state=removed.data;
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE entry_id='entry_api_atomic'").get().count,0);
  assert.deepEqual(db.prepare('SELECT kind FROM lane_a_mutation_probe').all().map(row=>row.kind),['entry_delete']);

  const personRemoved=await request('/api/people/person_charlie',{method:'DELETE',cookie,csrf,body:{expectedRevision:state.version}});
  assert.equal(personRemoved.res.status,200);state=personRemoved.data;
});


test('dependency-safe deletes catch split allocations and linked account entries',async()=>{
  const splitBlocked=await request('/api/people/person_bob',{method:'DELETE',cookie,csrf,body:{expectedRevision:state.version}});
  assert.equal(splitBlocked.res.status,400);assert.match(splitBlocked.data.error,/transactions first/);
  const accountBlocked=await request('/api/accounts/account_bank',{method:'DELETE',cookie,csrf,body:{expectedRevision:state.version}});
  assert.equal(accountBlocked.res.status,400);assert.match(accountBlocked.data.error,/transactions first/);
});

test('atomic entries API handles transfers and protects linked accounts',async()=>{
  let r=await request('/api/accounts',{method:'POST',cookie,csrf,body:{expectedRevision:state.version,id:'account_transfer_a',name:'Transfer A',type:'cash',currency:'USD',openingBalance:100}});
  assert.equal(r.res.status,201);state=r.data;
  r=await request('/api/accounts',{method:'POST',cookie,csrf,body:{expectedRevision:state.version,id:'account_transfer_b',name:'Transfer B',type:'cash',currency:'USD',openingBalance:0}});
  assert.equal(r.res.status,201);state=r.data;

  const created=await request('/api/entries',{method:'POST',cookie,csrf,body:{
    expectedRevision:state.version,id:'entry_transfer_api',type:'account_transfer',fromAccountId:'account_transfer_a',toAccountId:'account_transfer_b',
    amount:10,fromAmount:10,toAmount:10,date:'2026-09-29',merchant:'',description:'Atomic transfer'
  }});
  assert.equal(created.res.status,201);state=created.data;
  const stored=db.prepare("SELECT from_amount_minor AS fromMinor,to_amount_minor AS toMinor FROM entries WHERE id='entry_transfer_api'").get();
  assert.equal(stored.fromMinor,1000);assert.equal(stored.toMinor,1000);

  const blocked=await request('/api/accounts/account_transfer_a',{method:'DELETE',cookie,csrf,body:{expectedRevision:state.version}});
  assert.equal(blocked.res.status,400);assert.match(blocked.data.error,/transactions first/);

  const updated=await request('/api/entries/entry_transfer_api',{method:'PUT',cookie,csrf,body:{
    expectedRevision:state.version,type:'account_transfer',fromAccountId:'account_transfer_a',toAccountId:'account_transfer_b',
    amount:12.34,fromAmount:12.34,toAmount:12.34,date:'2026-09-29',merchant:'',description:'Updated transfer'
  }});
  assert.equal(updated.res.status,200);state=updated.data;
  const updatedStored=db.prepare("SELECT from_amount_minor AS fromMinor,to_amount_minor AS toMinor FROM entries WHERE id='entry_transfer_api'").get();
  assert.equal(updatedStored.fromMinor,1234);assert.equal(updatedStored.toMinor,1234);

  const deleted=await request('/api/entries/entry_transfer_api',{method:'DELETE',cookie,csrf,body:{expectedRevision:state.version}});
  assert.equal(deleted.res.status,200);state=deleted.data;
  r=await request('/api/accounts/account_transfer_a',{method:'DELETE',cookie,csrf,body:{expectedRevision:state.version}});assert.equal(r.res.status,200);state=r.data;
  r=await request('/api/accounts/account_transfer_b',{method:'DELETE',cookie,csrf,body:{expectedRevision:state.version}});assert.equal(r.res.status,200);state=r.data;
});

test('settings API is revision-safe and does not rewrite ledger tables',async()=>{
  db.prepare('DELETE FROM lane_a_mutation_probe').run();
  const beforeVersion=state.version;
  const changed=await request('/api/settings',{method:'PUT',cookie,csrf,body:{expectedRevision:state.version,defaultCurrency:'EUR'}});
  assert.equal(changed.res.status,200);assert.equal(changed.data.version,beforeVersion+1);assert.equal(changed.data.settings.defaultCurrency,'EUR');state=changed.data;
  assert.deepEqual(db.prepare('SELECT kind FROM lane_a_mutation_probe').all(),[]);

  const restored=await request('/api/settings',{method:'PUT',cookie,csrf,body:{expectedRevision:state.version,defaultCurrency:'USD'}});
  assert.equal(restored.res.status,200);state=restored.data;
  assert.equal(state.settings.defaultCurrency,'USD');
});

test('owner can create additional accounts from Settings API and data stays isolated',async()=>{
  secondUserEmail=`other-${Date.now()}@example.com`;
  const created=await request('/api/users',{method:'POST',cookie,csrf,body:{email:secondUserEmail,password:'another secure password'}});
  assert.equal(created.res.status,201); assert.equal(created.data.user.isOwner,false);
  const users=await request('/api/users',{cookie}); assert.equal(users.res.status,200); assert.equal(users.data.users.length,2);
  const loginOther=await request('/api/auth/login',{method:'POST',body:{email:secondUserEmail,password:'another secure password'}});
  assert.equal(loginOther.res.status,200); assert.equal(loginOther.data.user.isOwner,false);
  const other=await request('/api/state',{cookie:loginOther.cookie}); assert.equal(other.res.status,200); assert.deepEqual(other.data.people,[]); assert.deepEqual(other.data.entries,[]);
  const hidden=await request(`/api/attachments/${attachmentId}`,{cookie:loginOther.cookie}); assert.equal(hidden.res.status,404);
  const forbidden=await request('/api/users',{method:'POST',cookie:loginOther.cookie,csrf:loginOther.data.csrfToken,body:{email:`third-${Date.now()}@example.com`,password:'another secure password'}});
  assert.equal(forbidden.res.status,403);
});

test('logout invalidates the server-side session',async()=>{
  const r=await request('/api/auth/logout',{method:'POST',cookie,csrf,body:{}}); assert.equal(r.res.status,200);
  const after=await request('/api/state',{cookie}); assert.equal(after.res.status,401);
});

test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
