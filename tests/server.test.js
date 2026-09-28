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
