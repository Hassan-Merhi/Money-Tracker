import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mot-offline-c-'));
process.env.DB_PATH=join(dir,'test.sqlite');
process.env.NODE_ENV='test';

const {server,db}=await import('../server.mjs?offlinec='+Date.now());
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
let cookie='',csrf='';
const email='offline-c-'+Date.now()+'@example.test';
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

test('Offline Block C server completes O7-O10 safety invariants',async(t)=>{
  const registered=await request('/api/auth/register',{method:'POST',body:{email,password},cookie:'',csrf:''});
  assert.equal(registered.res.status,201);
  cookie=registered.cookie;csrf=registered.data.csrfToken;
  let state=(await request('/api/state')).data;

  await t.test('O7 stale revisions can be safely retried after an unrelated server change',async()=>{
    let response=await request('/api/settings',{method:'PUT',body:{appMode:'advanced',defaultCurrency:'USD',timezone:'UTC',expectedRevision:state.version}});
    assert.equal(response.res.status,200);state=response.data;
    response=await request('/api/people',{method:'POST',body:{id:'person_conflict_target',name:'Conflict Target',note:'base',expectedRevision:state.version}});
    assert.equal(response.res.status,201);state=response.data;
    const baseRevision=state.version;

    response=await request('/api/people',{method:'POST',body:{id:'person_unrelated_remote',name:'Remote Other',note:'',expectedRevision:state.version}});
    assert.equal(response.res.status,201);state=response.data;

    const operation={
      operationId:'op_conflict_rebase_1',
      entity:'person',
      entityId:'person_conflict_target',
      operation:'update',
      baseRevision,
      payload:{id:'person_conflict_target',name:'Conflict Target',note:'offline edit'}
    };
    const stale=await request('/api/sync/push',{method:'POST',body:{operation}});
    assert.equal(stale.res.status,409);
    assert.match(stale.data.error,/changed before the offline change could sync/i);

    operation.baseRevision=state.version;
    const rebased=await request('/api/sync/push',{method:'POST',body:{operation}});
    assert.equal(rebased.res.status,201);
    state=(await request('/api/state')).data;
    assert.equal(state.people.find(row=>row.id==='person_conflict_target').note,'offline edit');
    assert.equal(state.people.some(row=>row.id==='person_unrelated_remote'),true);
  });

  await t.test('O8 tombstones prevent deleted UUID resurrection',async()=>{
    let response=await request('/api/people',{method:'POST',body:{id:'person_tombstone_case',name:'Delete Me',note:'',expectedRevision:state.version}});
    assert.equal(response.res.status,201);state=response.data;

    const deletion={
      operationId:'op_tombstone_delete_1',
      entity:'person',
      entityId:'person_tombstone_case',
      operation:'delete',
      baseRevision:state.version,
      payload:{id:'person_tombstone_case'}
    };
    response=await request('/api/sync/push',{method:'POST',body:{operation:deletion}});
    assert.equal(response.res.status,201);state=(await request('/api/state')).data;
    assert.equal(state.people.some(row=>row.id==='person_tombstone_case'),false);

    const tomb=db.prepare('SELECT revision FROM sync_tombstones WHERE user_id=? AND entity=? AND entity_id=?').get(registered.data.user.id,'person','person_tombstone_case');
    assert.ok(Number.isInteger(Number(tomb?.revision)));

    const resurrect={
      operationId:'op_tombstone_resurrect_1',
      entity:'person',
      entityId:'person_tombstone_case',
      operation:'create',
      baseRevision:state.version,
      payload:{id:'person_tombstone_case',name:'Resurrected',note:''}
    };
    const blocked=await request('/api/sync/push',{method:'POST',body:{operation:resurrect}});
    assert.equal(blocked.res.status,409);
    assert.match(blocked.data.error,/deleted/i);
    const after=(await request('/api/state')).data;
    assert.equal(after.version,state.version);
    assert.equal(after.people.some(row=>row.id==='person_tombstone_case'),false);
  });

  await t.test('O9 transfer create/update/delete sync atomically and replay does not duplicate money movement',async()=>{
    let response=await request('/api/accounts',{method:'POST',body:{id:'account_transfer_from',name:'Transfer From',type:'bank',currency:'USD',openingBalance:100,expectedRevision:state.version}});
    assert.equal(response.res.status,201);state=response.data;
    response=await request('/api/accounts',{method:'POST',body:{id:'account_transfer_to',name:'Transfer To',type:'cash',currency:'USD',openingBalance:10,expectedRevision:state.version}});
    assert.equal(response.res.status,201);state=response.data;

    const createTransfer={
      operationId:'op_transfer_create_1',
      entity:'entry',
      entityId:'entry_offline_transfer_c',
      operation:'create',
      baseRevision:state.version,
      payload:{
        id:'entry_offline_transfer_c',type:'account_transfer',
        fromAccountId:'account_transfer_from',toAccountId:'account_transfer_to',
        amount:20,fromAmount:20,toAmount:20,date:'2026-09-30',merchant:'',description:'Offline transfer'
      }
    };
    const created=await request('/api/sync/push',{method:'POST',body:{operation:createTransfer}});
    assert.equal(created.res.status,201);
    state=(await request('/api/state')).data;
    const createdVersion=state.version;
    let transfers=state.entries.filter(row=>row.id==='entry_offline_transfer_c');
    assert.equal(transfers.length,1);
    assert.equal(transfers[0].fromAmount,20);
    assert.equal(transfers[0].toAmount,20);

    const replay=await request('/api/sync/push',{method:'POST',body:{operation:createTransfer}});
    assert.equal(replay.res.status,200);
    assert.equal(replay.data.alreadyProcessed,true);
    state=(await request('/api/state')).data;
    assert.equal(state.version,createdVersion);
    assert.equal(state.entries.filter(row=>row.id==='entry_offline_transfer_c').length,1);

    const updateTransfer={
      operationId:'op_transfer_update_1',
      entity:'entry',
      entityId:'entry_offline_transfer_c',
      operation:'update',
      baseRevision:state.version,
      payload:{...state.entries.find(row=>row.id==='entry_offline_transfer_c'),fromAmount:30,toAmount:30,amount:30}
    };
    response=await request('/api/sync/push',{method:'POST',body:{operation:updateTransfer}});
    assert.equal(response.res.status,201);state=(await request('/api/state')).data;
    assert.equal(state.entries.find(row=>row.id==='entry_offline_transfer_c').fromAmount,30);
    assert.equal(state.entries.find(row=>row.id==='entry_offline_transfer_c').toAmount,30);

    const deleteTransfer={
      operationId:'op_transfer_delete_1',
      entity:'entry',
      entityId:'entry_offline_transfer_c',
      operation:'delete',
      baseRevision:state.version,
      payload:{id:'entry_offline_transfer_c'}
    };
    response=await request('/api/sync/push',{method:'POST',body:{operation:deleteTransfer}});
    assert.equal(response.res.status,201);state=(await request('/api/state')).data;
    assert.equal(state.entries.some(row=>row.id==='entry_offline_transfer_c'),false);
    const tomb=db.prepare('SELECT revision FROM sync_tombstones WHERE user_id=? AND entity=? AND entity_id=?').get(registered.data.user.id,'entry','entry_offline_transfer_c');
    assert.equal(Number(tomb.revision),state.version);
  });

  await t.test('O10 attachment create/delete is idempotent and does not consume ledger revisions',async()=>{
    let response=await request('/api/entries',{method:'POST',body:{
      id:'entry_attachment_host',type:'account_expense',accountId:'account_transfer_from',amount:12,currency:'USD',
      date:'2026-09-30',merchant:'Receipt Shop',description:'Attachment host',expectedRevision:state.version
    }});
    assert.equal(response.res.status,201);state=response.data;
    const ledgerRevision=state.version;
    const data=Buffer.from('offline receipt body').toString('base64');
    const createAttachment={
      operationId:'op_attachment_create_1',
      operation:'create',
      attachmentId:'attachment_offline_c_1',
      entryId:'entry_attachment_host',
      payload:{
        id:'attachment_offline_c_1',entryId:'entry_attachment_host',name:'receipt.txt',mimeType:'text/plain',
        sizeBytes:Buffer.byteLength('offline receipt body'),data,createdAt:'2026-09-30T12:00:00.000Z'
      }
    };
    const created=await request('/api/sync/attachments',{method:'POST',body:{operation:createAttachment}});
    assert.equal(created.res.status,201);
    assert.equal(created.data.attachment.id,'attachment_offline_c_1');
    state=(await request('/api/state')).data;
    assert.equal(state.version,ledgerRevision);
    assert.equal(state.entries.find(row=>row.id==='entry_attachment_host').attachmentCount,1);

    const replay=await request('/api/sync/attachments',{method:'POST',body:{operation:createAttachment}});
    assert.equal(replay.res.status,200);
    assert.equal(replay.data.alreadyProcessed,true);
    let listed=(await request('/api/attachments?entry=entry_attachment_host')).data.attachments;
    assert.equal(listed.filter(row=>row.id==='attachment_offline_c_1').length,1);

    const deleteAttachment={
      operationId:'op_attachment_delete_1',
      operation:'delete',
      attachmentId:'attachment_offline_c_1',
      entryId:'entry_attachment_host',
      payload:{id:'attachment_offline_c_1'}
    };
    const deleted=await request('/api/sync/attachments',{method:'POST',body:{operation:deleteAttachment}});
    assert.equal(deleted.res.status,201);
    const deleteReplay=await request('/api/sync/attachments',{method:'POST',body:{operation:deleteAttachment}});
    assert.equal(deleteReplay.res.status,200);
    assert.equal(deleteReplay.data.alreadyProcessed,true);
    listed=(await request('/api/attachments?entry=entry_attachment_host')).data.attachments;
    assert.equal(listed.length,0);
    state=(await request('/api/state')).data;
    assert.equal(state.version,ledgerRevision);
    assert.equal(state.entries.find(row=>row.id==='entry_attachment_host').attachmentCount,0);
  });
});
