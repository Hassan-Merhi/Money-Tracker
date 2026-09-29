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
  assert.equal(first.res.status,200);assert.equal(first.data.imported,2);assert.equal(first.data.skipped,0);assert.equal(first.data.items.length,2);assert.equal(first.data.history.length,1);assert.equal(first.data.stats.pending,2);assert.ok(first.data.batchId);
  const second=await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_bank',sourceName:'statement-again.csv',rows}});
  assert.equal(second.res.status,200);assert.equal(second.data.imported,0);assert.equal(second.data.skipped,2);assert.equal(second.data.history.length,2);assert.equal(second.data.history[0].skippedRows,2);
});

test('posts an expense atomically into the ledger and updates account balance',async()=>{
  const feed=(await request('/api/bank-feed')).data;
  const expense=feed.items.find(i=>i.externalId==='tx-1');
  const posted=await request(`/api/bank-feed/${expense.id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'expense',categoryId:'category_shopping',note:'Personal Amazon order',saveRule:true,ruleMatchText:'amazon'}});
  assert.equal(posted.res.status,200);state=posted.data.state;
  const entry=state.entries.find(e=>e.id===posted.data.entryId);assert.equal(entry.type,'account_expense');assert.equal(entry.accountId,'account_bank');assert.equal(entry.amount,25);assert.equal(entry.categoryId,'category_shopping');
  assert.equal(accountBalances(state.entries,state.accounts).account_bank,975);
  assert.equal(posted.data.item.status,'posted');assert.equal(posted.data.rules[0].matchText,'amazon');assert.equal(posted.data.rules[0].categoryId,'category_shopping');
});

test('posted Bank Feed rows can be undone and safely reposted',async()=>{
  let feed=(await request('/api/bank-feed')).data;
  const expense=feed.items.find(i=>i.externalId==='tx-1');
  const beforeEntry=expense.postedEntryId;
  const undone=await request(`/api/bank-feed/${expense.id}/undo`,{method:'POST',body:{expectedRevision:state.version}});
  assert.equal(undone.res.status,200);state=undone.data.state;
  assert.equal(undone.data.reopenedItems,1);
  assert.equal(state.entries.some(e=>e.id===beforeEntry),false);
  assert.equal(undone.data.items.find(i=>i.id===expense.id).status,'pending');
  assert.equal(undone.data.stats.pending>=1,true);
  assert.equal(accountBalances(state.entries,state.accounts).account_bank,1000);

  const repost=await request(`/api/bank-feed/${expense.id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'expense',categoryId:'category_shopping',note:'Personal Amazon order'}});
  assert.equal(repost.res.status,200);state=repost.data.state;
  assert.equal(accountBalances(state.entries,state.accounts).account_bank,975);
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
  const item=imported.data.items.find(i=>i.externalId==='tx-3');assert.equal(item.suggestedType,'expense');assert.equal(item.suggestedCategoryId,'category_shopping');
  const post=await request(`/api/bank-feed/${item.id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'paid_for_person',personId:'person_alice',saveRule:true,ruleMatchText:'marketplace'}});
  assert.equal(post.res.status,200);state=post.data.state;
  const entry=state.entries.find(e=>e.id===post.data.entryId);assert.equal(entry.type,'paid_for_person');assert.equal(entry.personId,'person_alice');
});

test('higher-priority and more-specific rules win when several rules match',async()=>{
  let r=await request('/api/bank-rules',{method:'POST',body:{matchText:'priority shop',classification:'expense',categoryId:'category_shopping',priority:10}});
  assert.equal(r.res.status,201);
  r=await request('/api/bank-rules',{method:'POST',body:{matchText:'priority shop vip',classification:'paid_for_person',personId:'person_alice',priority:900}});
  assert.equal(r.res.status,201);
  const imported=await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_bank',sourceName:'priority.csv',rows:[{date:'2026-09-30',description:'PRIORITY SHOP VIP purchase',signedAmount:-7,currency:'USD',externalId:'priority-1'}]}});
  assert.equal(imported.res.status,200);
  const item=imported.data.items.find(i=>i.externalId==='priority-1');
  assert.equal(item.suggestedType,'paid_for_person');
  assert.equal(item.suggestedPersonId,'person_alice');
  const ordered=imported.data.rules.filter(rule=>rule.matchText.startsWith('priority shop'));
  assert.equal(ordered[0].priority,900);
});

test('supports ignore and reopen without changing the ledger revision',async()=>{
  const imported=await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_bank',sourceName:'misc.csv',rows:[{date:'2026-09-30',description:'Card verification',signedAmount:-1,currency:'USD',externalId:'tx-4'}]}});
  const item=imported.data.items.find(i=>i.externalId==='tx-4'),before=state.version;
  const ignored=await request(`/api/bank-feed/${item.id}/ignore`,{method:'POST',body:{}});assert.equal(ignored.data.item.status,'ignored');
  const reopened=await request(`/api/bank-feed/${item.id}/reopen`,{method:'POST',body:{}});assert.equal(reopened.data.item.status,'pending');
  const after=(await request('/api/state')).data;assert.equal(after.version,before);
});

test('posting both statement sides of one transfer creates only one ledger movement',async()=>{
  const beforeBalances=accountBalances(state.entries,state.accounts),beforeEntries=state.entries.length;
  const imported=await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_bank',sourceName:'bank-transfer.csv',rows:[{date:'2026-09-30',description:'Transfer to cash',signedAmount:-100,currency:'USD',externalId:'transfer-out'}]}});
  assert.equal(imported.res.status,200);
  const importedOther=await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_cash',sourceName:'cash-transfer.csv',rows:[{date:'2026-09-30',description:'Transfer from bank',signedAmount:100,currency:'USD',externalId:'transfer-in'}]}});
  assert.equal(importedOther.res.status,200);
  let feed=(await request('/api/bank-feed')).data;
  const outgoing=feed.items.find(i=>i.externalId==='transfer-out'),incoming=feed.items.find(i=>i.externalId==='transfer-in');
  const first=await request(`/api/bank-feed/${outgoing.id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'transfer',targetAccountId:'account_cash'}});
  assert.equal(first.res.status,200);assert.equal(first.data.linkedExistingTransfer,false);state=first.data.state;
  assert.equal(state.entries.length,beforeEntries+1);
  assert.equal(accountBalances(state.entries,state.accounts).account_bank,beforeBalances.account_bank-100);
  assert.equal(accountBalances(state.entries,state.accounts).account_cash,beforeBalances.account_cash+100);
  const revisionAfterFirst=state.version,entriesAfterFirst=state.entries.length;
  const second=await request(`/api/bank-feed/${incoming.id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'transfer',targetAccountId:'account_bank'}});
  assert.equal(second.res.status,200);assert.equal(second.data.linkedExistingTransfer,true);state=second.data.state;
  assert.equal(state.version,revisionAfterFirst);
  assert.equal(state.entries.length,entriesAfterFirst);
  assert.equal(second.data.entryId,first.data.entryId);
  feed=(await request('/api/bank-feed')).data;
  assert.equal(feed.items.find(i=>i.id===outgoing.id).postedEntryId,first.data.entryId);
  assert.equal(feed.items.find(i=>i.id===incoming.id).postedEntryId,first.data.entryId);
});

test('undoing either side of a matched transfer reopens both statement rows and removes one ledger transfer',async()=>{
  let feed=(await request('/api/bank-feed')).data;
  const outgoing=feed.items.find(i=>i.externalId==='transfer-out'),incoming=feed.items.find(i=>i.externalId==='transfer-in');
  assert.equal(outgoing.status,'posted');assert.equal(incoming.status,'posted');assert.equal(outgoing.postedEntryId,incoming.postedEntryId);
  const entryId=outgoing.postedEntryId,before=state.entries.length;
  const undone=await request(`/api/bank-feed/${incoming.id}/undo`,{method:'POST',body:{expectedRevision:state.version}});
  assert.equal(undone.res.status,200);state=undone.data.state;
  assert.equal(undone.data.reopenedItems,2);
  assert.equal(state.entries.length,before-1);
  assert.equal(state.entries.some(e=>e.id===entryId),false);
  assert.equal(undone.data.items.find(i=>i.id===outgoing.id).status,'pending');
  assert.equal(undone.data.items.find(i=>i.id===incoming.id).status,'pending');
});

test('deleting an account cleans unposted feed rows and rules that reference it',async()=>{
  const t=new Date().toISOString();
  const added=await request('/api/state',{method:'PUT',body:{...state,accounts:[...state.accounts,{id:'account_unused',name:'Unused Wallet',type:'wallet',currency:'USD',openingBalance:0,createdAt:t}]}});
  assert.equal(added.res.status,200);state=added.data;
  const imported=await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_unused',sourceName:'unused.csv',rows:[{date:'2026-09-30',description:'Unused row',signedAmount:-5,currency:'USD',externalId:'unused-orphan'}]}});
  assert.equal(imported.res.status,200);
  const rule=await request('/api/bank-rules',{method:'POST',body:{matchText:'move unused',classification:'transfer',targetAccountId:'account_unused'}});
  assert.equal(rule.res.status,201);
  const saved=await request('/api/state',{method:'PUT',body:{...state,accounts:state.accounts.filter(a=>a.id!=='account_unused')}});
  assert.equal(saved.res.status,200);state=saved.data;
  const feed=(await request('/api/bank-feed')).data;
  assert.equal(feed.items.some(item=>item.externalId==='unused-orphan'),false);
  assert.equal(feed.rules.some(item=>item.targetAccountId==='account_unused'),false);
});

test('ledger reset also clears bank feed rows and rules',async()=>{
  const before=(await request('/api/bank-feed')).data;
  assert.ok(before.items.length>0);
  assert.ok(before.rules.length>0);
  const reset=await request('/api/state/reset',{method:'POST',body:{}});
  assert.equal(reset.res.status,200);state=reset.data;
  const after=(await request('/api/bank-feed')).data;
  assert.deepEqual(after.items,[]);
  assert.deepEqual(after.rules,[]);
  assert.deepEqual(after.history,[]);
  assert.deepEqual(after.stats,{pending:0,posted:0,ignored:0});
});

test('bank feed is isolated per user',async()=>{
  const email=`other-bank-${Date.now()}@example.com`;
  const created=await request('/api/users',{method:'POST',body:{email,password:'another secure password'}});
  assert.equal(created.res.status,201);
  const login=await request('/api/auth/login',{method:'POST',body:{email,password:'another secure password'},cookie:'',csrf:''});
  assert.equal(login.res.status,200);
  const other=await request('/api/bank-feed',{cookie:login.cookie,csrf:login.data.csrfToken});assert.equal(other.res.status,200);assert.deepEqual(other.data.items,[]);assert.deepEqual(other.data.rules,[]);
});

test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
