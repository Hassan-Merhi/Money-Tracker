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

test('editing a posted entry amount reopens its feed row and decreases posted stats',async()=>{
  const imported=await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_bank',sourceName:'edit.csv',rows:[{date:'2026-09-30',description:'Editable expense',signedAmount:-45,currency:'USD',externalId:'edit-amount'}]}});
  const row=imported.data.items.find(i=>i.externalId==='edit-amount');const posted=await request(`/api/bank-feed/${row.id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'expense'}});assert.equal(posted.res.status,200);state=posted.data.state;
  const entry=state.entries.find(e=>e.id===posted.data.entryId);const edited=await request(`/api/entries/${entry.id}`,{method:'PUT',body:{...entry,amount:60,expectedRevision:state.version}});assert.equal(edited.res.status,200);assert.equal(edited.data.reopenedFeedItems,1);state=edited.data;
  const feed=(await request('/api/bank-feed')).data;assert.equal(feed.items.find(i=>i.id===row.id).status,'pending');assert.equal(feed.stats.posted,3);
});

test('description-only edits preserve posted links while reclassification reopens them',async()=>{
  const imported=await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_bank',sourceName:'edit.csv',rows:[{date:'2026-09-30',description:'Description safe expense',signedAmount:-12,currency:'USD',externalId:'edit-description'}]}});
  const row=imported.data.items.find(i=>i.externalId==='edit-description');const posted=await request(`/api/bank-feed/${row.id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'expense'}});state=posted.data.state;
  let entry=state.entries.find(e=>e.id===posted.data.entryId);let edit=await request(`/api/entries/${entry.id}`,{method:'PUT',body:{...entry,description:'New note text',merchant:'New merchant',expectedRevision:state.version}});assert.equal(edit.res.status,200);assert.equal(edit.data.reopenedFeedItems,0);state=edit.data;
  entry=state.entries.find(e=>e.id===posted.data.entryId);edit=await request(`/api/entries/${entry.id}`,{method:'PUT',body:{...entry,type:'account_income',expectedRevision:state.version}});assert.equal(edit.res.status,200);assert.equal(edit.data.reopenedFeedItems,1);state=edit.data;
  const feed=(await request('/api/bank-feed')).data;assert.equal(feed.items.find(i=>i.id===row.id).status,'pending');
});

test('bank-feed listing paginates within a status and keeps global stats',async()=>{
  const first=await request('/api/bank-feed?status=pending&limit=1&offset=0'),second=await request('/api/bank-feed?status=pending&limit=1&offset=1');
  assert.equal(first.res.status,200);assert.equal(first.data.page.limit,1);assert.equal(first.data.page.returned,1);assert.equal(first.data.page.total,first.data.stats.pending);assert.notEqual(first.data.items[0].id,second.data.items[0].id);assert.equal(first.data.stats.posted,3);
});

test('same-amount transfers with distinct descriptions remain separate movements',async()=>{
  const rowsA=[{date:'2026-09-25',description:'Ski trip',signedAmount:-30,currency:'USD',externalId:'rent-out'}];
  const rowsB=[{date:'2026-09-25',description:'University tuition',signedAmount:-30,currency:'USD',externalId:'travel-out'}];
  await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_bank',sourceName:'out.csv',rows:[...rowsA,...rowsB]}});
  await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_cash',sourceName:'in.csv',rows:[{date:'2026-09-25',description:'Ski trip',signedAmount:30,currency:'USD',externalId:'rent-in'},{date:'2026-09-25',description:'University tuition',signedAmount:30,currency:'USD',externalId:'travel-in'}]}});
  let feed=(await request('/api/bank-feed')).data;const row=id=>feed.items.find(i=>i.externalId===id);
  const a=await request(`/api/bank-feed/${row('rent-out').id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'transfer',targetAccountId:'account_cash'}});assert.equal(a.res.status,200);state=a.data.state;
  const b=await request(`/api/bank-feed/${row('travel-out').id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'transfer',targetAccountId:'account_cash'}});assert.equal(b.res.status,200);state=b.data.state;
  const c=await request(`/api/bank-feed/${row('rent-in').id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'transfer',targetAccountId:'account_bank'}});assert.equal(c.res.status,200);assert.equal(c.data.linkedExistingTransfer,true);state=c.data.state;
  const d=await request(`/api/bank-feed/${row('travel-in').id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'transfer',targetAccountId:'account_bank'}});assert.equal(d.res.status,200);assert.equal(d.data.linkedExistingTransfer,true);state=d.data.state;
  assert.notEqual(c.data.entryId,d.data.entryId);
  feed=(await request('/api/bank-feed')).data;
  for(const id of ['rent-out','travel-out','rent-in','travel-in'])assert.equal(row(id).status,'posted');
});

test('ambiguous transfer candidates create a new movement instead of guessing',async()=>{
  await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_bank',sourceName:'ambiguous-out.csv',rows:[{date:'2026-09-25',description:'Shared movement',signedAmount:-22,currency:'USD',externalId:'ambiguous-out-1'},{date:'2026-09-26',description:'Shared movement',signedAmount:-22,currency:'USD',externalId:'ambiguous-out-2'}]}});
  await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_cash',sourceName:'ambiguous-in.csv',rows:[{date:'2026-09-26',description:'Shared movement',signedAmount:22,currency:'USD',externalId:'ambiguous-in'}]}});
  let feed=(await request('/api/bank-feed')).data;const find=id=>feed.items.find(i=>i.externalId===id);
  for(const id of ['ambiguous-out-1','ambiguous-out-2']){const result=await request(`/api/bank-feed/${find(id).id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'transfer',targetAccountId:'account_cash'}});assert.equal(result.res.status,200);state=result.data.state;}
  const before=state.entries.length;const result=await request(`/api/bank-feed/${find('ambiguous-in').id}/post`,{method:'POST',body:{expectedRevision:state.version,classification:'transfer',targetAccountId:'account_bank'}});
  assert.equal(result.res.status,200);assert.equal(result.data.linkedExistingTransfer,false);assert.equal(result.data.state.entries.length,before+1);state=result.data.state;
});


test('Wave 100A Bank Feed sync ignore is idempotent and rejects operation-id reuse',async()=>{
  const imported=await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_bank',sourceName:'wave100a-ignore.csv',rows:[{date:'2026-10-01',description:'Offline ignore candidate',signedAmount:-3,currency:'USD',externalId:'wave100a-ignore'}]}});
  assert.equal(imported.res.status,200);
  const item=imported.data.items.find(row=>row.externalId==='wave100a-ignore');
  assert.ok(item);
  const operation={operationId:'op_wave100a_ignore_once',action:'ignore',itemId:item.id,ruleId:'',payload:{}};
  const first=await request('/api/sync/bank-feed',{method:'POST',body:{operation}});
  assert.equal(first.res.status,201);
  assert.equal(first.data.alreadyProcessed,undefined);
  const replay=await request('/api/sync/bank-feed',{method:'POST',body:{operation}});
  assert.equal(replay.res.status,200);
  assert.equal(replay.data.alreadyProcessed,true);
  const feed=(await request('/api/bank-feed')).data;
  assert.equal(feed.items.find(row=>row.id===item.id)?.status,'ignored');
  const reused=await request('/api/sync/bank-feed',{method:'POST',body:{operation:{...operation,action:'reopen'}}});
  assert.equal(reused.res.status,409);
});

test('Wave 100A Bank Feed synced post advances the ledger exactly once across replay',async()=>{
  const imported=await request('/api/bank-feed/import',{method:'POST',body:{accountId:'account_bank',sourceName:'wave100a-post.csv',rows:[{date:'2026-10-01',description:'Offline post once',signedAmount:-11,currency:'USD',externalId:'wave100a-post'}]}});
  assert.equal(imported.res.status,200);
  const item=imported.data.items.find(row=>row.externalId==='wave100a-post');
  const before=(await request('/api/state')).data;
  const operation={operationId:'op_wave100a_post_once',action:'post',itemId:item.id,ruleId:'',payload:{expectedRevision:before.version,classification:'expense',note:'Wave 100A offline post'}};
  const first=await request('/api/sync/bank-feed',{method:'POST',body:{operation}});
  assert.equal(first.res.status,201);
  assert.equal(first.data.status,'accepted');
  const afterFirst=(await request('/api/state')).data;
  assert.equal(afterFirst.version,before.version+1);
  assert.equal(afterFirst.entries.filter(row=>row.id===first.data.entryId).length,1);
  const replay=await request('/api/sync/bank-feed',{method:'POST',body:{operation}});
  assert.equal(replay.res.status,200);
  assert.equal(replay.data.alreadyProcessed,true);
  const afterReplay=(await request('/api/state')).data;
  assert.equal(afterReplay.version,afterFirst.version);
  assert.equal(afterReplay.entries.filter(row=>row.id===first.data.entryId).length,1);
  const feed=(await request('/api/bank-feed')).data;
  assert.equal(feed.items.find(row=>row.id===item.id)?.status,'posted');
  const health=(await request('/api/health')).data;
  assert.equal(health.offlineWave100AVersion,1);
  assert.ok(health.offlineSyncMonitor.metrics.bankFeedAccepted.count>=2);
  assert.ok(health.offlineSyncMonitor.metrics.bankFeedReplayed.count>=2);
  assert.ok(health.offlineSyncMonitor.metrics.bankFeedConflict.count>=1);
  state=afterReplay;
});


test('Wave 100A queued statement import is idempotent across replay',async()=>{
  const operation={
    operationId:'op_wave100a_import_once',
    action:'import',
    itemId:'',
    ruleId:'',
    payload:{
      accountId:'account_bank',
      sourceName:'wave100a-offline-import.csv',
      rows:[{date:'2026-10-01',description:'Offline import once',merchant:'Offline CSV',signedAmount:-6,currency:'USD',externalId:'wave100a-import-once'}]
    }
  };
  const first=await request('/api/sync/bank-feed',{method:'POST',body:{operation}});
  assert.equal(first.res.status,201);
  assert.equal(first.data.imported,1);
  const replay=await request('/api/sync/bank-feed',{method:'POST',body:{operation}});
  assert.equal(replay.res.status,200);
  assert.equal(replay.data.alreadyProcessed,true);
  assert.equal(replay.data.imported,1);
  const feed=(await request('/api/bank-feed')).data;
  assert.equal(feed.items.filter(row=>row.externalId==='wave100a-import-once').length,1);
});

test('ledger reset also clears bank feed rows and rules',async()=>{
  const before=(await request('/api/bank-feed')).data;
  assert.ok(before.items.length>0);
  assert.ok(before.rules.length>0);
  const reset=await request('/api/state/reset',{method:'POST',body:{password:'correct horse battery staple'}});
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
