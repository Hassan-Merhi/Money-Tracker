import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATA_LIMITS } from '../lib/data-limits.js';

const dir=mkdtempSync(join(tmpdir(),'mot-wave100g-'));
process.env.DB_PATH=join(dir,'test.sqlite');
process.env.DATA_DIR=dir;
process.env.NODE_ENV='test';

const {server,db}=await import(`../server.mjs?wave100g=${Date.now()}`);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;

let cookie='',csrf='',userId='';
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

test('Wave 100G server publishes scale ceilings',async()=>{
  const health=await request('/api/health');
  assert.equal(health.res.status,200);
  assert.equal(health.data.offlineWave100GVersion,1);
  assert.equal(health.data.dataLimits.entries,50000);
  assert.equal(health.data.dataLimits.attachments,10000);
  assert.equal(health.data.dataLimits.syncChangeRevisions,DATA_LIMITS.syncChangeRevisions);
});

test('Wave 100G registers a scale-test owner',async()=>{
  const registered=await request('/api/auth/register',{
    method:'POST',
    body:{email:`wave100g-${Date.now()}@example.test`,password},
    cookie:'',csrf:''
  });
  assert.equal(registered.res.status,201);
  cookie=registered.cookie;
  csrf=registered.data.csrfToken;
  userId=db.prepare('SELECT id FROM users LIMIT 1').get().id;
  assert.ok(userId);
});

test('Wave 100G old sync cursors fall back after bounded delta retention while recent cursors stay incremental',async()=>{
  const current=DATA_LIMITS.syncChangeRevisions+2;
  db.prepare('UPDATE users SET revision=? WHERE id=?').run(current,userId);
  const stamp=new Date().toISOString();
  const insert=db.prepare('INSERT INTO sync_changes(user_id,revision,entity,entity_id,operation,payload_json,created_at) VALUES(?,?,?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  try{
    for(let revision=3;revision<=current;revision++){
      insert.run(userId,revision,'settings','settings','update',JSON.stringify({displayName:`Revision ${revision}`}),stamp);
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}

  const stale=await request('/api/sync/pull?sinceRevision=0');
  assert.equal(stale.res.status,200);
  assert.equal(stale.data.currentRevision,current);
  assert.equal(stale.data.requiresFullRefresh,true);
  assert.equal(stale.data.changes.length,0);

  const recent=await request(`/api/sync/pull?sinceRevision=${current-5}`);
  assert.equal(recent.res.status,200);
  assert.equal(recent.data.requiresFullRefresh,false);
  assert.deepEqual(recent.data.changes.map(row=>row.revision),[current-4,current-3,current-2,current-1,current]);
});

test('Wave 100G accepted sync prunes only old deltas and preserves processed-operation idempotency',async()=>{
  const before=Number(db.prepare('SELECT revision FROM users WHERE id=?').get(userId).revision);
  const operation={
    operationId:'op_wave100g_prune',
    entity:'person',
    entityId:'person_wave100g_prune',
    operation:'create',
    baseRevision:before,
    payload:{id:'person_wave100g_prune',name:'Scale Prune Person',note:'retention proof'}
  };
  const pushed=await request('/api/sync/push',{method:'POST',body:{operation}});
  assert.equal(pushed.res.status,201);
  assert.equal(pushed.data.revision,before+1);

  const stats=db.prepare('SELECT COUNT(*) AS count,MIN(revision) AS minRevision,MAX(revision) AS maxRevision FROM sync_changes WHERE user_id=?').get(userId);
  assert.equal(Number(stats.count),DATA_LIMITS.syncChangeRevisions);
  assert.equal(Number(stats.maxRevision),before+1);
  assert.equal(Number(stats.minRevision),(before+1)-DATA_LIMITS.syncChangeRevisions+1);

  const replay=await request('/api/sync/push',{method:'POST',body:{operation}});
  assert.equal(replay.res.status,200);
  assert.equal(replay.data.alreadyProcessed,true);
  const state=(await request('/api/state')).data;
  assert.equal(state.people.filter(row=>row.id==='person_wave100g_prune').length,1);

  const stale=await request('/api/sync/pull?sinceRevision=0');
  assert.equal(stale.data.requiresFullRefresh,true);
  const recent=await request(`/api/sync/pull?sinceRevision=${pushed.data.revision-3}`);
  assert.equal(recent.data.requiresFullRefresh,false);
  assert.equal(recent.data.currentRevision,pushed.data.revision);
});

after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  try{db.close();}catch{}
  rmSync(dir,{recursive:true,force:true});
});
