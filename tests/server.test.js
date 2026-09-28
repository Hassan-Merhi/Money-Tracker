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

let cookie,csrf,state;

test('registers securely and starts with an empty scoped ledger',async()=>{
  const email=`owner-${Date.now()}@example.com`;
  const r=await request('/api/auth/register',{method:'POST',body:{email,password:'correct horse battery staple',displayName:'Family Ledger'}});
  assert.equal(r.res.status,201); assert.ok(r.cookie?.startsWith('mot_session=')); assert.ok(r.data.csrfToken);
  cookie=r.cookie; csrf=r.data.csrfToken;
  const me=await request('/api/auth/me',{cookie}); assert.equal(me.res.status,200); assert.equal(me.data.user.email,email);
  const s=await request('/api/state',{cookie}); assert.equal(s.res.status,200); assert.equal(s.data.settings.displayName,'Family Ledger'); assert.deepEqual(s.data.people,[]);state=s.data;
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

test('blocks stale-tab overwrites with optimistic revision checks',async()=>{
  const stale={...state,version:state.version-1};
  const r=await request('/api/state',{method:'PUT',cookie,csrf,body:stale}); assert.equal(r.res.status,409);
});

test('isolates a second user from the first user ledger',async()=>{
  const r=await request('/api/auth/register',{method:'POST',body:{email:`other-${Date.now()}@example.com`,password:'another secure password',displayName:'Other'}});
  assert.equal(r.res.status,201); const other=await request('/api/state',{cookie:r.cookie}); assert.equal(other.res.status,200); assert.deepEqual(other.data.people,[]); assert.deepEqual(other.data.entries,[]);
});

test('logout invalidates the server-side session',async()=>{
  const r=await request('/api/auth/logout',{method:'POST',cookie,csrf,body:{}}); assert.equal(r.res.status,200);
  const after=await request('/api/state',{cookie}); assert.equal(after.res.status,401);
});

test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
