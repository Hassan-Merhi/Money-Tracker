import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountBalances } from '../lib/ledger.js';

const dir=mkdtempSync(join(tmpdir(),'mot-block-f-bank-'));
process.env.DB_PATH=join(dir,'test.sqlite');
process.env.NODE_ENV='test';
const {server,db}=await import(`../server.mjs?blockf=${Date.now()}`);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let cookie='',csrf='',state;

async function request(path,{method='GET',body,cookie:useCookie=cookie,csrf:useCsrf=csrf}={}){
  const headers={};if(body!==undefined)headers['content-type']='application/json';if(useCookie)headers.cookie=useCookie;if(useCsrf&&method!=='GET')headers['x-csrf-token']=useCsrf;
  const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json();return {res,data,cookie:res.headers.get('set-cookie')?.split(';')[0]};
}

test('registers and seeds an account/person for bank feed posting',async()=>{
  const r=await request('/api/auth/register',{method:'POST',body:{email:`bank-${Date.now()}@example.com`,password:'correct horse battery staple',displayName:'Bank Feed Test'},cookie:'',csrf:''});
  assert.equal(r.res.status,201);cookie=r.cookie;csrf=r.data.csrfToken;
  state=(await request('/api/state')).data;
  const t=new Date().toISOString();
  state.accounts=[{id:'account_bank',name:'Main Bank',type:'bank',currency:'USD',openingBalance:1000,createdAt:t},{id:'account_cash',name:'Cash',type:'cash',currency:'USD',openingBalance:50,createdAt:t}];
  state.people=[{id:'person_alice',name:'Alice',note:'',createdAt:t}];
  const saved=await request('/api/state',{method:'PUT',body:state});assert.equal(saved.res.status,200);state=saved.data;
});

test('imports statement rows and skips duplicate re-imports',async()=>{
  const rows=[
    {date:'2026-09-27',description:'AMAZON ORDER',merchant:'Amazon',signedAmount:-25,currency:'USD',externalId:'tx-1'},
    {date:'2026-09-28',description:'PAYROLL',merchant:'Employer',signedAmount:500,currency:'USD',externalId:'tx-2'}
  ];
  const first=await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_bank',sourceName:'statement.csv',rows}});
  assert.equal(first.res.status,200);assert.equal(first.data.imported,2);assert.equal(first.data.skipped,0);assert.equal(first.data.items.length,2);
  const second=await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_bank',sourceName:'statement-again.csv',rows}});
  assert.equal(second.res.status,200);assert.equal(second.data.imported,0);assert.equal(second.data.skipped,2);
});

test('posts an expense atomically into the ledger and updates account balance',async()=>{
  const feed=(await request('/api/bank-feed')).data;
  const expense=feed.items.find(i=>i.externalId==='tx-1');
  const posted=await request(`/api/bank-feed/${expense.id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'expense',note:'Personal Amazon order',saveRule:true,ruleMatchText:'amazon'}});
  assert.equal(posted.res.status,200);state=posted.data.state;
  const entry=state.entries.find(e=>e.id===posted.data.entryId);assert.equal(entry.type,'account_expense');assert.equal(entry.accountId,'account_bank');assert.equal(entry.amount,25);
  assert.equal(accountBalances(state.entries,state.accounts).account_bank,975);
  assert.equal(posted.data.item.status,'posted');assert.equal(posted.data.rules[0].matchText,'amazon');
});

test('posting is stale-safe and direction-safe',async()=>{
  const feed=(await request('/api/bank-feed')).data;
  const income=feed.items.find(i=>i.externalId==='tx-2');
  const wrong=await request(`/api/bank-feed/${income.id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'expense'}});
  assert.equal(wrong.res.status,400);
  const stale=await request(`/api/bank-feed/${income.id}/post`,{method:'POST',body:{expectedRevision:state.version-1,classification:'income'}});
  assert.equal(stale.res.status,409);
  const ok=await request(`/api/bank-feed/${income.id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'income'}});
  assert.equal(ok.res.status,200);state=ok.data.state;
  assert.equal(accountBalances(state.entries,state.accounts).account_bank,1475);
});

test('saved rules auto-classify future matching rows and person posting works',async()=>{
  const imported=await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_bank',sourceName:'next.csv',rows:[{date:'2026-09-29',description:'Amazon Marketplace',merchant:'Amazon',signedAmount:-40,currency:'USD',externalId:'tx-3'}]}});
  assert.equal(imported.res.status,200);
  const item=imported.data.items.find(i=>i.externalId==='tx-3');assert.equal(item.suggestedType,'expense');
  const post=await request(`/api/bank-feed/${item.id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'paid_for_person',personId:'person_alice',saveRule:true,ruleMatchText:'marketplace'}});
  assert.equal(post.res.status,200);state=post.data.state;
  const entry=state.entries.find(e=>e.id===post.data.entryId);assert.equal(entry.type,'paid_for_person');assert.equal(entry.personId,'person_alice');
});

test('supports ignore and reopen without changing the ledger revision',async()=>{
  const imported=await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_bank',sourceName:'misc.csv',rows:[{date:'2026-09-30',description:'Card verification',signedAmount:-1,currency:'USD',externalId:'tx-4'}]}});
  const item=imported.data.items.find(i=>i.externalId==='tx-4'),before=state.version;
  const ignored=await request(`/api/bank-feed/${item.id}/ignore`,{method:'POST',body:{}});assert.equal(ignored.data.item.status,'ignored');
  const reopened=await request(`/api/bank-feed/${item.id}/reopen`,{method:'POST',body:{}});assert.equal(reopened.data.item.status,'pending');
  const after=(await request('/api/state')).data;assert.equal(after.version,before);
});

test('bank feed is isolated per user',async()=>{
  const r=await request('/api/auth/register',{method:'POST',body:{email:`other-bank-${Date.now()}@example.com`,password:'another secure password',displayName:'Other'},cookie:'',csrf:''});
  const otherCookie=r.cookie,otherCsrf=r.data.csrfToken;
  const other=await request('/api/bank-feed',{cookie:otherCookie,csrf:otherCsrf});assert.equal(other.res.status,200);assert.deepEqual(other.data.items,[]);assert.deepEqual(other.data.rules,[]);
});

test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
