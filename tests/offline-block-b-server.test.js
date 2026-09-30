import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mot-offline-b-'));
process.env.DB_PATH=join(dir,'test.sqlite');
process.env.NODE_ENV='test';

const {server,db}=await import('../server.mjs?offlineb='+Date.now());
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
let cookie='',csrf='',initialRevision=0,syncRevision=0;
const email='offline-b-'+Date.now()+'@example.test';
const password='correct horse battery staple';

async function request(path,{method='GET',body,cookie:useCookie=cookie,csrf:useCsrf=csrf}={}){
  const headers={};
  if(body!==undefined)headers['content-type']='application/json';
  if(useCookie)headers.cookie=useCookie;
  if(useCsrf&&method!=='GET')headers['x-csrf-token']=useCsrf;
  const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json().catch(()=>({}));
  return {res,data,cookie:res.headers.get('set-cookie')?.split(';')[0]||''};
}

test.after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  try{db.close();}catch{}
  rmSync(dir,{recursive:true,force:true});
});

test('Offline Block B server registers a ledger and exposes sync capability',async()=>{
  const registered=await request('/api/auth/register',{
    method:'POST',
    body:{email,password},
    cookie:'',
    csrf:''
  });
  assert.equal(registered.res.status,201);
  cookie=registered.cookie;
  csrf=registered.data.csrfToken;

  const state=(await request('/api/state')).data;
  initialRevision=state.version;
  assert.ok(Number.isInteger(initialRevision));

  const health=await request('/api/health');
  assert.equal(health.res.status,200);
  assert.equal(health.data.offlineBlockBVersion,1);
});

const personOperation=()=>({
  operationId:'op_offline_person_1',
  entity:'person',
  entityId:'person_offline_alice',
  operation:'create',
  baseRevision:initialRevision,
  payload:{
    id:'person_offline_alice',
    name:'Offline Alice',
    note:'Created without a network',
    openingBalance:25,
    currency:'USD',
    direction:'to_me',
    openingEntryId:'entry_offline_opening',
    openingDate:'2026-09-30'
  }
});

test('O4/O5 push applies a queued person plus opening balance atomically',async()=>{
  const pushed=await request('/api/sync/push',{method:'POST',body:{operation:personOperation()}});
  assert.equal(pushed.res.status,201);
  assert.equal(pushed.data.status,'accepted');
  assert.equal(pushed.data.revision,initialRevision+1);
  syncRevision=pushed.data.revision;

  const state=(await request('/api/state')).data;
  assert.equal(state.version,syncRevision);
  assert.equal(state.people.filter(row=>row.id==='person_offline_alice').length,1);
  const opening=state.entries.filter(row=>row.id==='entry_offline_opening');
  assert.equal(opening.length,1);
  assert.equal(opening[0].type,'person_adjustment');
  assert.equal(opening[0].amount,25);
  assert.equal(opening[0].signedAmount,25);
});

test('O6 retrying the same operation after a lost response is idempotent',async()=>{
  const replay=await request('/api/sync/push',{method:'POST',body:{operation:personOperation()}});
  assert.equal(replay.res.status,200);
  assert.equal(replay.data.alreadyProcessed,true);
  assert.equal(replay.data.revision,syncRevision);

  const state=(await request('/api/state')).data;
  assert.equal(state.version,syncRevision);
  assert.equal(state.people.filter(row=>row.id==='person_offline_alice').length,1);
  assert.equal(state.entries.filter(row=>row.id==='entry_offline_opening').length,1);
});

test('O6 rejects reuse of an operation id for different data',async()=>{
  const changed=personOperation();
  changed.payload={...changed.payload,name:'Different Alice'};
  const reused=await request('/api/sync/push',{method:'POST',body:{operation:changed}});
  assert.equal(reused.res.status,409);
  assert.match(reused.data.error,/already used for different data/i);

  const state=(await request('/api/state')).data;
  assert.equal(state.version,syncRevision);
  assert.equal(state.people.find(row=>row.id==='person_offline_alice').name,'Offline Alice');
});

test('O5 pull returns complete incremental changes for sync-managed revisions',async()=>{
  const pulled=await request('/api/sync/pull?sinceRevision='+initialRevision);
  assert.equal(pulled.res.status,200);
  assert.equal(pulled.data.requiresFullRefresh,false);
  assert.equal(pulled.data.currentRevision,syncRevision);
  assert.equal(pulled.data.cursor,syncRevision);

  const person=pulled.data.changes.find(row=>row.entity==='person'&&row.entityId==='person_offline_alice');
  const opening=pulled.data.changes.find(row=>row.entity==='entry'&&row.entityId==='entry_offline_opening');
  assert.equal(person.operation,'create');
  assert.equal(person.payload.name,'Offline Alice');
  assert.equal(opening.operation,'create');
  assert.equal(opening.payload.amount,25);
  assert.equal(person.revision,syncRevision);
  assert.equal(opening.revision,syncRevision);
});

test('O5 rejects stale queued revisions without mutating the ledger',async()=>{
  const stale={
    operationId:'op_stale_person_1',
    entity:'person',
    entityId:'person_stale',
    operation:'create',
    baseRevision:initialRevision,
    payload:{id:'person_stale',name:'Stale Person',note:''}
  };
  const response=await request('/api/sync/push',{method:'POST',body:{operation:stale}});
  assert.equal(response.res.status,409);
  assert.match(response.data.error,/changed before the offline change could sync/i);

  const state=(await request('/api/state')).data;
  assert.equal(state.version,syncRevision);
  assert.equal(state.people.some(row=>row.id==='person_stale'),false);
});

test('O5 keeps server validation failures atomic and revision-stable',async()=>{
  const invalid={
    operationId:'op_invalid_person_1',
    entity:'person',
    entityId:'person_invalid',
    operation:'create',
    baseRevision:syncRevision,
    payload:{id:'person_invalid',name:'',note:'bad'}
  };
  const response=await request('/api/sync/push',{method:'POST',body:{operation:invalid}});
  assert.equal(response.res.status,400);
  assert.match(response.data.error,/needs a name/i);

  const state=(await request('/api/state')).data;
  assert.equal(state.version,syncRevision);
  assert.equal(state.people.some(row=>row.id==='person_invalid'),false);
});

test('O5 requests a full refresh when a non-sync server mutation creates a revision gap',async()=>{
  const settings=await request('/api/settings',{
    method:'PUT',
    body:{defaultCurrency:'USD',appMode:'simple',timezone:'UTC',expectedRevision:syncRevision}
  });
  assert.equal(settings.res.status,200);
  assert.equal(settings.data.version,syncRevision+1);

  const pulled=await request('/api/sync/pull?sinceRevision='+syncRevision);
  assert.equal(pulled.res.status,200);
  assert.equal(pulled.data.currentRevision,syncRevision+1);
  assert.equal(pulled.data.requiresFullRefresh,true);
  assert.deepEqual(pulled.data.changes,[]);
});


test('O5 hardening rejects queued deletion of an existing account transfer',async()=>{
  let state=(await request('/api/state')).data;
  if(state.settings.appMode!=='advanced'){
    const settings=await request('/api/settings',{method:'PUT',body:{appMode:'advanced',defaultCurrency:state.settings.defaultCurrency||'USD',timezone:state.settings.timezone||'UTC',expectedRevision:state.version}});
    assert.equal(settings.res.status,200);
    state=settings.data;
  }

  let response=await request('/api/accounts',{method:'POST',body:{expectedRevision:state.version,id:'account_offline_transfer_a',name:'Offline Transfer A',type:'cash',currency:'USD',openingBalance:100}});
  assert.equal(response.res.status,201);state=response.data;
  response=await request('/api/accounts',{method:'POST',body:{expectedRevision:state.version,id:'account_offline_transfer_b',name:'Offline Transfer B',type:'cash',currency:'USD',openingBalance:0}});
  assert.equal(response.res.status,201);state=response.data;
  response=await request('/api/entries',{method:'POST',body:{
    expectedRevision:state.version,id:'entry_offline_transfer_guard',type:'account_transfer',
    fromAccountId:'account_offline_transfer_a',toAccountId:'account_offline_transfer_b',
    amount:10,fromAmount:10,toAmount:10,date:'2026-09-30',merchant:'',description:'Guarded transfer'
  }});
  assert.equal(response.res.status,201);state=response.data;

  const revisionBefore=state.version;
  const blocked=await request('/api/sync/push',{method:'POST',body:{operation:{
    operationId:'op_transfer_delete_guard',
    entity:'entry',
    entityId:'entry_offline_transfer_guard',
    operation:'delete',
    baseRevision:revisionBefore,
    payload:{id:'entry_offline_transfer_guard'}
  }}});
  assert.equal(blocked.res.status,400);
  assert.match(blocked.data.error,/atomic-transfer phase/i);

  const after=(await request('/api/state')).data;
  assert.equal(after.version,revisionBefore);
  assert.equal(after.entries.some(row=>row.id==='entry_offline_transfer_guard'),true);
});

test('O5 hardening reports Bank Feed rows reopened by a synced entry edit',async()=>{
  let state=(await request('/api/state')).data;
  let response=await request('/api/accounts',{method:'POST',body:{expectedRevision:state.version,id:'account_offline_feed',name:'Offline Feed',type:'bank',currency:'USD',openingBalance:500}});
  assert.equal(response.res.status,201);state=response.data;

  const imported=await request('/api/bank-feed/import',{method:'POST',body:{
    accountId:'account_offline_feed',
    sourceName:'offline-sync.csv',
    rows:[{date:'2026-09-30',description:'SYNC EXPENSE',merchant:'Sync Shop',signedAmount:-25,currency:'USD',externalId:'offline-sync-row'}]
  }});
  assert.equal(imported.res.status,200);
  const item=imported.data.items.find(row=>row.externalId==='offline-sync-row');
  assert.ok(item);

  const posted=await request('/api/bank-feed/'+item.id+'/post',{method:'POST',body:{expectedRevision:state.version,classification:'expense'}});
  assert.equal(posted.res.status,200);state=posted.data.state;
  const entry=state.entries.find(row=>row.id===posted.data.entryId);
  assert.ok(entry);

  const pushed=await request('/api/sync/push',{method:'POST',body:{operation:{
    operationId:'op_bank_feed_reopen_1',
    entity:'entry',
    entityId:entry.id,
    operation:'update',
    baseRevision:state.version,
    payload:{...entry,amount:30}
  }}});
  assert.equal(pushed.res.status,201);
  assert.equal(pushed.data.reopenedFeedItems,1);

  const feed=(await request('/api/bank-feed')).data;
  assert.equal(feed.items.find(row=>row.id===item.id).status,'pending');
});


test('O5 hardening direct entry deletion returns the Bank Feed reopen count',async()=>{
  let state=(await request('/api/state')).data;
  const imported=await request('/api/bank-feed/import',{method:'POST',body:{
    accountId:'account_offline_feed',
    sourceName:'offline-delete.csv',
    rows:[{date:'2026-09-30',description:'DELETE SYNC EXPENSE',merchant:'Delete Shop',signedAmount:-18,currency:'USD',externalId:'offline-delete-row'}]
  }});
  assert.equal(imported.res.status,200);
  const item=imported.data.items.find(row=>row.externalId==='offline-delete-row');
  assert.ok(item);

  const posted=await request('/api/bank-feed/'+item.id+'/post',{method:'POST',body:{expectedRevision:state.version,classification:'expense'}});
  assert.equal(posted.res.status,200);state=posted.data.state;

  const deleted=await request('/api/entries/'+posted.data.entryId,{method:'DELETE',body:{expectedRevision:state.version}});
  assert.equal(deleted.res.status,200);
  assert.equal(deleted.data.reopenedFeedItems,1);

  const feed=(await request('/api/bank-feed')).data;
  assert.equal(feed.items.find(row=>row.id===item.id).status,'pending');
});
