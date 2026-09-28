import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mot-block-g-'));
process.env.DB_PATH=join(dir,'test.sqlite');
process.env.NODE_ENV='test';
const {server,db}=await import(`../server.mjs?blockg=${Date.now()}`);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let cookie='',csrf='',state,customCategoryId='',budgetId='';

async function request(path,{method='GET',body,cookie:useCookie=cookie,csrf:useCsrf=csrf}={}){
  const headers={};if(body!==undefined)headers['content-type']='application/json';if(useCookie)headers.cookie=useCookie;if(useCsrf&&method!=='GET')headers['x-csrf-token']=useCsrf;
  const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json();return {res,data,cookie:res.headers.get('set-cookie')?.split(';')[0]};
}

test('new ledgers receive default categories without changing empty ledger data',async()=>{
  const reg=await request('/api/auth/register',{method:'POST',body:{email:`blockg-${Date.now()}@example.com`,password:'correct horse battery staple',displayName:'G Test'},cookie:'',csrf:''});
  assert.equal(reg.res.status,201);cookie=reg.cookie;csrf=reg.data.csrfToken;
  state=(await request('/api/state')).data;
  assert.deepEqual(state.people,[]);assert.deepEqual(state.accounts,[]);assert.deepEqual(state.entries,[]);
  assert.ok(state.categories.some(c=>c.id==='category_food'&&c.kind==='expense'));
  assert.ok(state.categories.some(c=>c.id==='category_salary'&&c.kind==='income'));
  assert.deepEqual(state.budgets,[]);
});

test('category and budget APIs require CSRF and persist user-scoped metadata',async()=>{
  const denied=await request('/api/categories',{method:'POST',body:{name:'Coffee',kind:'expense',icon:'☕'},csrf:''});
  assert.equal(denied.res.status,403);
  const created=await request('/api/categories',{method:'POST',body:{name:'Coffee',kind:'expense',icon:'☕'}});
  assert.equal(created.res.status,201);customCategoryId=created.data.category.id;
  assert.equal(created.data.category.name,'Coffee');

  const budget=await request('/api/budgets',{method:'POST',body:{categoryId:customCategoryId,currency:'USD',monthlyLimit:100}});
  assert.equal(budget.res.status,200);budgetId=budget.data.budget.id;
  assert.equal(budget.data.budget.monthlyLimit,100);

  const updated=await request('/api/budgets',{method:'POST',body:{categoryId:customCategoryId,currency:'USD',monthlyLimit:125}});
  assert.equal(updated.res.status,200);assert.equal(updated.data.budget.id,budgetId);assert.equal(updated.data.budget.monthlyLimit,125);
});

test('categorized account expenses persist while wrong category types are rejected',async()=>{
  const t=new Date().toISOString();
  state=(await request('/api/state')).data;
  state.accounts=[{id:'account_bank',name:'Bank',type:'bank',currency:'USD',openingBalance:500,createdAt:t}];
  state.entries=[{id:'entry_coffee',type:'account_expense',personId:null,accountId:'account_bank',amount:12,currency:'USD',date:'2026-09-28',merchant:'Cafe',description:'Coffee',categoryId:customCategoryId,createdAt:t,updatedAt:t}];
  let saved=await request('/api/state',{method:'PUT',body:state});assert.equal(saved.res.status,200);state=saved.data;
  assert.equal(state.entries[0].categoryId,customCategoryId);

  const salary=state.categories.find(c=>c.id==='category_salary');
  const bad={...state,entries:state.entries.map(e=>({...e,categoryId:salary.id}))};
  const rejected=await request('/api/state',{method:'PUT',body:bad});assert.equal(rejected.res.status,400);
  const retype=await request(`/api/categories/${customCategoryId}`,{method:'PUT',body:{name:'Coffee',kind:'income',icon:'☕'}});
  assert.equal(retype.res.status,400);
});

test('archiving a category removes its budget but preserves historical categorization',async()=>{
  const archived=await request(`/api/categories/${customCategoryId}/archive`,{method:'POST',body:{}});
  assert.equal(archived.res.status,200);assert.equal(archived.data.category.archived,true);
  assert.equal(archived.data.budgets.some(b=>b.id===budgetId),false);
  state=(await request('/api/state')).data;
  assert.equal(state.entries.find(e=>e.id==='entry_coffee').categoryId,customCategoryId);
  assert.equal(state.categories.find(c=>c.id===customCategoryId).archived,true);

  const restored=await request(`/api/categories/${customCategoryId}/restore`,{method:'POST',body:{}});
  assert.equal(restored.res.status,200);assert.equal(restored.data.category.archived,false);
  await request('/api/budgets',{method:'POST',body:{categoryId:customCategoryId,currency:'USD',monthlyLimit:150}});
  state=(await request('/api/state')).data;
});

test('categorized recurring account expenses post into the ledger',async()=>{
  const due='2026-09-28';
  const created=await request('/api/recurring',{method:'POST',body:{
    title:'Monthly coffee',frequency:'monthly',interval:1,nextDueDate:due,anchorDate:due,endDate:null,remindDaysBefore:0,isActive:true,
    template:{type:'account_expense',accountId:'account_bank',amount:15,merchant:'Cafe',description:'Recurring coffee',categoryId:customCategoryId}
  }});
  assert.equal(created.res.status,201);
  const rule=created.data.rule;
  const posted=await request(`/api/recurring/${rule.id}/post`,{method:'POST',body:{expectedRevision:state.version,occurrenceDate:due,transactionDate:due}});
  assert.equal(posted.res.status,200);state=posted.data.state;
  const entry=state.entries.find(e=>e.description==='Recurring coffee');
  assert.equal(entry.type,'account_expense');assert.equal(entry.categoryId,customCategoryId);
  const archiveBlocked=await request(`/api/categories/${customCategoryId}/archive`,{method:'POST',body:{}});
  assert.equal(archiveBlocked.res.status,400);
  assert.match(archiveBlocked.data.error,/recurring schedule/i);
});

test('atomic JSON backup restore preserves category IDs and budgets',async()=>{
  state=(await request('/api/state')).data;
  const backup=JSON.parse(JSON.stringify({...state,version:undefined}));
  const edited=await request(`/api/categories/${customCategoryId}`,{method:'PUT',body:{name:'Coffee changed',kind:'expense',icon:'C'}});
  assert.equal(edited.res.status,200);
  const restored=await request('/api/backup/restore',{method:'POST',body:backup});
  assert.equal(restored.res.status,200);state=restored.data;
  assert.equal(state.categories.find(c=>c.id===customCategoryId).name,'Coffee');
  assert.ok(state.budgets.some(b=>b.categoryId===customCategoryId&&b.monthlyLimit===150));
  assert.ok(state.entries.some(e=>e.categoryId===customCategoryId));
});

test('categories and budgets are isolated by user',async()=>{
  const reg=await request('/api/auth/register',{method:'POST',body:{email:`blockg-other-${Date.now()}@example.com`,password:'another secure password',displayName:'Other'},cookie:'',csrf:''});
  assert.equal(reg.res.status,201);
  const other=(await request('/api/state',{cookie:reg.cookie,csrf:reg.data.csrfToken})).data;
  assert.equal(other.categories.some(c=>c.id===customCategoryId),false);
  assert.deepEqual(other.budgets,[]);
  assert.ok(other.categories.some(c=>c.id==='category_food'));
});

test('ledger reset clears custom insight metadata and recurring data, then reseeds defaults',async()=>{
  const reset=await request('/api/state/reset',{method:'POST',body:{}});
  assert.equal(reset.res.status,200);state=reset.data;
  assert.deepEqual(state.people,[]);assert.deepEqual(state.accounts,[]);assert.deepEqual(state.entries,[]);assert.deepEqual(state.budgets,[]);
  assert.equal(state.categories.some(c=>c.id===customCategoryId),false);
  assert.ok(state.categories.some(c=>c.id==='category_food'));
  const recurring=await request('/api/recurring');assert.deepEqual(recurring.data.rules,[]);
});

test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
