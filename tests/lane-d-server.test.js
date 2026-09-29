import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mot-lane-d-'));
process.env.DB_PATH=join(dir,'test.sqlite');
process.env.DATA_DIR=dir;
process.env.NODE_ENV='test';
const {server,db}=await import(`../server.mjs?laneD=${Date.now()}`);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;

async function request(path,{method='GET',body,cookie='',csrf='',headers={}}={}){
  const h={...headers};
  if(body!==undefined)h['content-type']='application/json';
  if(cookie)h.cookie=cookie;
  if(csrf)h['x-csrf-token']=csrf;
  const res=await fetch(base+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json().catch(()=>({}));
  return {res,data,cookie:res.headers.get('set-cookie')?.split(';')[0]};
}

let cookie='',csrf='',userId='';
const ownerPassword='correct horse battery staple';

test('Lane D health reports release readiness and PWA v16',async()=>{
  const r=await request('/api/health');
  assert.equal(r.res.status,200);
  assert.equal(r.data.laneDVersion,1);
  assert.equal(r.data.pwaCacheVersion,16);
  assert.equal(r.data.dataLimits.bankFeedItems,50000);
  assert.equal(r.data.dataLimits.attachmentBytes,100*1024*1024);
});

test('static assets support conditional ETag requests',async()=>{
  const first=await fetch(base+'/styles.css');
  assert.equal(first.status,200);
  const etag=first.headers.get('etag');
  assert.ok(etag);
  const second=await fetch(base+'/styles.css',{headers:{'if-none-match':etag}});
  assert.equal(second.status,304);
  assert.equal(second.headers.get('etag'),etag);
});

test('registers a Lane D owner',async()=>{
  const r=await request('/api/auth/register',{method:'POST',body:{email:`lane-d-${Date.now()}@example.com`,password:ownerPassword}});
  assert.equal(r.res.status,201);
  cookie=r.cookie;
  csrf=r.data.csrfToken;
  userId=db.prepare('SELECT id FROM users LIMIT 1').get().id;
});

test('security history reads purge records older than 90 days',async()=>{
  db.prepare("INSERT INTO security_events(user_id,id,event_type,subject_hash,detail_json,created_at) VALUES(?,?,?,?,?,?)")
    .run(userId,'security_expired','old_event','','{}','2020-01-01T00:00:00.000Z');
  const r=await request('/api/security/events',{cookie});
  assert.equal(r.res.status,200);
  assert.equal(r.data.events.some(event=>event.id==='security_expired'),false);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM security_events WHERE id='security_expired'").get().count),0);
});

test('Bank Feed stats count every row beyond the paginated UI page',async()=>{
  const stamp=new Date().toISOString();
  db.prepare('INSERT INTO accounts(user_id,id,name,type,currency,opening_balance_minor,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(userId,'account_scale','Scale Bank','bank','USD',0,stamp);
  db.exec('BEGIN IMMEDIATE');
  try{
    const insert=db.prepare("INSERT INTO bank_feed_items(user_id,id,account_id,fingerprint,source_name,external_id,txn_date,description,merchant,signed_amount_minor,currency,status,suggested_type,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for(let i=1;i<=5001;i++)insert.run(userId,'scale_'+i,'account_scale','scale_fp_'+i,'scale.csv','scale_ext_'+i,'2026-09-29','Scale row '+i,'',-100,'USD','pending','expense',stamp,stamp);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  const r=await request('/api/bank-feed?status=pending&limit=500&offset=0',{cookie});
  assert.equal(r.res.status,200);
  assert.equal(r.data.items.length,500);
  assert.equal(r.data.page.total,5001);
  assert.equal(r.data.stats.pending,5001);
});

test('recurring acknowledged history is trimmed while preserving a large restorable inbox',async()=>{
  const stamp=new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try{
    const insert=db.prepare("INSERT INTO recurring_notifications(user_id,id,rule_id,occurrence_date,remind_on_date,status,created_at,acknowledged_at) VALUES(?,?,?,?,?,'acknowledged',?,?)");
    for(let i=1;i<=5200;i++){
      const day=String((i%28)+1).padStart(2,'0');
      insert.run(userId,'ack_'+i,'rule_'+i,'2026-09-'+day,'2026-09-'+day,stamp,stamp);
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  const r=await request('/api/recurring/reminders',{cookie});
  assert.equal(r.res.status,200);
  const count=Number(db.prepare("SELECT COUNT(*) AS count FROM recurring_notifications WHERE user_id=? AND status='acknowledged'").get(userId).count);
  assert.equal(count,5000);
});

test('Bank Feed import history beyond the former 1,000-row restore cap remains recoverable',()=>{
  const stamp=new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try{
    const insert=db.prepare('INSERT INTO bank_import_batches(user_id,id,account_id,source_name,total_rows,imported_rows,skipped_rows,invalid_rows,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
    for(let i=1;i<=1200;i++)insert.run(userId,'batch_scale_'+i,'account_scale','history.csv',1,1,0,0,stamp);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM bank_import_batches WHERE user_id=?').get(userId).count),1200);
});

test('future attachment uploads enforce the complete-backup storage quota',async()=>{
  const stamp=new Date().toISOString();
  db.prepare("INSERT INTO entries(user_id,id,type,amount_minor,currency,date,merchant,description,split_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(userId,'entry_quota','person_adjustment',0,'USD','2026-09-29','','Quota test','[]',stamp,stamp);
  db.prepare('INSERT INTO attachments(user_id,id,entry_id,name,mime_type,size_bytes,data,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(userId,'attachment_quota_seed','entry_quota','seed.txt','text/plain',100*1024*1024,Buffer.from('x'),stamp);
  const r=await request('/api/attachments',{method:'POST',cookie,csrf,body:{entryId:'entry_quota',name:'next.txt',mimeType:'text/plain',data:Buffer.from('y').toString('base64')}});
  assert.equal(r.res.status,413);
  assert.match(r.data.error,/100 MB/i);
  // This row deliberately lies about its byte size to exercise quota accounting.
  // Remove the invalid synthetic row before the complete-backup round-trip gate.
  db.prepare("DELETE FROM attachments WHERE user_id=? AND id='attachment_quota_seed'").run(userId);
});

test('complete backup restores data beyond all former Lane A/B history caps',async()=>{
  const exported=await request('/api/backup/full',{cookie});
  assert.equal(exported.res.status,200);
  assert.ok(exported.data.data.bank_feed_items.length>5000);
  assert.ok(exported.data.data.recurring_notifications.length>2000);
  assert.ok(exported.data.data.bank_import_batches.length>1000);
  const restored=await request('/api/backup/full/restore',{method:'POST',cookie,csrf,body:{backup:exported.data,password:ownerPassword,confirmation:'RESTORE'}});
  assert.equal(restored.res.status,200);
  assert.equal(restored.data.ok,true);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM bank_feed_items WHERE user_id=?').get(userId).count),5001);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM bank_import_batches WHERE user_id=?').get(userId).count),1200);
});

after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  db.close();
  rmSync(dir,{recursive:true,force:true});
});
