import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mot-block-e-'));
process.env.DB_PATH=join(dir,'test.sqlite');
process.env.NODE_ENV='test';
const {server,db}=await import(`../server.mjs?blockE=${Date.now()}`);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;

async function request(path,{method='GET',body,cookie,csrf}={}){
  const headers={};
  if(body!==undefined)headers['content-type']='application/json';
  if(cookie)headers.cookie=cookie;
  if(csrf)headers['x-csrf-token']=csrf;
  const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json();
  return {res,data,cookie:res.headers.get('set-cookie')?.split(';')[0]};
}

let cookie,csrf,state,rule;

test('creates a ledger owner and base records for recurring tests',async()=>{
  const reg=await request('/api/auth/register',{method:'POST',body:{email:`recurring-${Date.now()}@example.com`,password:'correct horse battery staple',displayName:'Recurring Ledger'}});
  assert.equal(reg.res.status,201);cookie=reg.cookie;csrf=reg.data.csrfToken;
  state=(await request('/api/state',{cookie})).data;
  const stamp=new Date().toISOString();
  state.people=[{id:'person_alice',name:'Alice',note:'',createdAt:stamp}];
  state.accounts=[{id:'account_bank',name:'Main Bank',type:'bank',currency:'USD',openingBalance:1000,createdAt:stamp}];
  const saved=await request('/api/state',{method:'PUT',cookie,csrf,body:state});
  assert.equal(saved.res.status,200);state=saved.data;
});

test('recurring writes require CSRF',async()=>{
  const denied=await request('/api/recurring',{method:'POST',cookie,body:{}});
  assert.equal(denied.res.status,403);
});

test('creates and lists a validated recurring transaction schedule',async()=>{
  const payload={
    title:'Monthly Alice order',
    frequency:'monthly',
    interval:1,
    anchorDate:'2026-01-31',
    nextDueDate:'2026-01-31',
    endDate:null,
    remindDaysBefore:3,
    isActive:true,
    template:{type:'paid_for_person',personId:'person_alice',accountId:'account_bank',amount:25,merchant:'Amazon',description:'Recurring order'}
  };
  const created=await request('/api/recurring',{method:'POST',cookie,csrf,body:payload});
  assert.equal(created.res.status,201);
  assert.equal(created.data.rule.title,'Monthly Alice order');
  assert.equal(created.data.rule.template.amount,25);
  rule=created.data.rule;
  const list=await request('/api/recurring',{cookie});
  assert.equal(list.res.status,200);
  assert.equal(list.data.rules.length,1);
  assert.equal(list.data.rules[0].id,rule.id);
});

test('posting an occurrence atomically adds one entry and advances month-end correctly',async()=>{
  const posted=await request(`/api/recurring/${rule.id}/post`,{method:'POST',cookie,csrf,body:{expectedRevision:state.version,occurrenceDate:'2026-01-31',transactionDate:'2026-01-31'}});
  assert.equal(posted.res.status,200);
  assert.equal(posted.data.state.version,state.version+1);
  assert.equal(posted.data.state.entries.length,1);
  assert.equal(posted.data.state.entries[0].type,'paid_for_person');
  assert.equal(posted.data.state.entries[0].personId,'person_alice');
  assert.equal(posted.data.state.entries[0].amount,25);
  assert.equal(posted.data.rule.nextDueDate,'2026-02-28');
  state=posted.data.state;rule=posted.data.rule;
});

test('replaying the same occurrence is rejected without a duplicate ledger entry',async()=>{
  const replay=await request(`/api/recurring/${rule.id}/post`,{method:'POST',cookie,csrf,body:{expectedRevision:state.version,occurrenceDate:'2026-01-31',transactionDate:'2026-01-31'}});
  assert.equal(replay.res.status,409);
  const current=await request('/api/state',{cookie});
  assert.equal(current.data.entries.length,1);
  assert.equal(current.data.version,state.version);
});

test('skipping advances the schedule without changing ledger revision or entries',async()=>{
  const skipped=await request(`/api/recurring/${rule.id}/skip`,{method:'POST',cookie,csrf,body:{occurrenceDate:'2026-02-28'}});
  assert.equal(skipped.res.status,200);
  assert.equal(skipped.data.rule.nextDueDate,'2026-03-31');
  rule=skipped.data.rule;
  const current=await request('/api/state',{cookie});
  assert.equal(current.data.entries.length,1);
  assert.equal(current.data.version,state.version);
});

test('paused schedules cannot be posted',async()=>{
  const paused=await request(`/api/recurring/${rule.id}`,{method:'PUT',cookie,csrf,body:{...rule,isActive:false}});
  assert.equal(paused.res.status,200);
  assert.equal(paused.data.rule.isActive,false);
  rule=paused.data.rule;
  const post=await request(`/api/recurring/${rule.id}/post`,{method:'POST',cookie,csrf,body:{expectedRevision:state.version,occurrenceDate:rule.nextDueDate,transactionDate:rule.nextDueDate}});
  assert.equal(post.res.status,400);
});

test('recurring rules prevent deleting referenced people or accounts',async()=>{
  const invalid={...state,people:[]};
  const saved=await request('/api/state',{method:'PUT',cookie,csrf,body:invalid});
  assert.equal(saved.res.status,400);
  assert.match(saved.data.error,/recurring schedule/i);
});

test('recurring rules are isolated per user',async()=>{
  const other=await request('/api/auth/register',{method:'POST',body:{email:`other-recurring-${Date.now()}@example.com`,password:'another secure password',displayName:'Other'}});
  assert.equal(other.res.status,201);
  const list=await request('/api/recurring',{cookie:other.cookie});
  assert.equal(list.res.status,200);
  assert.deepEqual(list.data.rules,[]);
});

test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
