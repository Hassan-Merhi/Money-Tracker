import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mot-lane-c-'));
process.env.DB_PATH=join(dir,'test.sqlite');
process.env.DATA_DIR=dir;
process.env.NODE_ENV='test';
const {server,db}=await import(`../server.mjs?laneC=${Date.now()}`);
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

let ownerCookie='',ownerCsrf='',ownerEmail='',otherCookie='',otherCsrf='';

test('Lane C health exposes runtime diagnostics and hardened headers',async()=>{
  const r=await request('/api/health');
  assert.equal(r.res.status,200);
  assert.equal(r.data.laneCVersion,1);
  assert.ok(Number.isInteger(r.data.pwaCacheVersion)&&r.data.pwaCacheVersion>0);
  assert.equal(r.data.pwaCacheName,`money-tracker-debt-v${r.data.pwaCacheVersion}`);
  assert.equal(r.data.runtime.sqliteQuickCheck,'ok');
  assert.equal(r.data.runtime.foreignKeyViolations,0);
  assert.equal(r.res.headers.get('cross-origin-opener-policy'),'same-origin');
  assert.equal(r.res.headers.get('cross-origin-resource-policy'),'same-origin');
  assert.match(r.res.headers.get('x-request-id')||'',/^[0-9a-f-]{36}$/i);
});

test('service worker and manifest are served with update-safe cache policy',async()=>{
  const sw=await fetch(base+'/service-worker.js');
  assert.equal(sw.status,200);
  assert.match(sw.headers.get('cache-control')||'',/no-cache/);
  assert.equal(sw.headers.get('service-worker-allowed'),'/');
  const version=await fetch(base+'/pwa-version.js');
  assert.equal(version.status,200);
  assert.match(version.headers.get('cache-control')||'',/no-cache/);
  const manifest=await fetch(base+'/manifest.webmanifest');
  assert.equal(manifest.status,200);
  assert.match(manifest.headers.get('cache-control')||'',/no-cache/);
});

test('owner registration creates current session and security history',async()=>{
  ownerEmail=`lane-c-${Date.now()}@example.com`;
  const reg=await request('/api/auth/register',{method:'POST',body:{email:ownerEmail,password:'correct horse battery staple'}});
  assert.equal(reg.res.status,201);ownerCookie=reg.cookie;ownerCsrf=reg.data.csrfToken;
  const sessions=await request('/api/auth/sessions',{cookie:ownerCookie});
  assert.equal(sessions.res.status,200);assert.equal(sessions.data.sessions.length,1);assert.equal(sessions.data.sessions[0].current,true);
  const events=await request('/api/security/events',{cookie:ownerCookie});
  assert.equal(events.res.status,200);
  assert.ok(events.data.events.some(e=>e.eventType==='owner_registered'));
});

test('cross-site mutations are rejected before state changes',async()=>{
  const state=(await request('/api/state',{cookie:ownerCookie})).data;
  const blocked=await request('/api/settings',{
    method:'PUT',cookie:ownerCookie,csrf:ownerCsrf,
    headers:{'sec-fetch-site':'cross-site','origin':'https://evil.example'},
    body:{expectedRevision:state.version,defaultCurrency:'EUR'}
  });
  assert.equal(blocked.res.status,403);
  assert.match(blocked.data.error,/cross-site/i);
  const current=(await request('/api/state',{cookie:ownerCookie})).data;
  assert.equal(current.settings.defaultCurrency,'USD');
  const events=await request('/api/security/events',{cookie:ownerCookie});
  assert.ok(events.data.events.some(e=>e.eventType==='blocked_cross_site_mutation'));
});

test('multiple sessions can be inspected and individually revoked',async()=>{
  const login=await request('/api/auth/login',{method:'POST',body:{email:ownerEmail,password:'correct horse battery staple'}});
  assert.equal(login.res.status,200);const secondCookie=login.cookie;
  let sessions=(await request('/api/auth/sessions',{cookie:ownerCookie})).data.sessions;
  assert.equal(sessions.length,2);
  const other=sessions.find(s=>!s.current);assert.ok(other);
  const revoked=await request('/api/auth/sessions/'+other.id,{method:'DELETE',cookie:ownerCookie,csrf:ownerCsrf,body:{}});
  assert.equal(revoked.res.status,200);assert.equal(revoked.data.ok,true);
  const denied=await request('/api/state',{cookie:secondCookie});
  assert.equal(denied.res.status,401);
  sessions=(await request('/api/auth/sessions',{cookie:ownerCookie})).data.sessions;
  assert.equal(sessions.length,1);
});

test('complete backup deliberately excludes sessions and security activity',async()=>{
  const backup=await request('/api/backup/full',{cookie:ownerCookie});
  assert.equal(backup.res.status,200);
  assert.equal('sessions' in backup.data.data,false);
  assert.equal('security_events' in backup.data.data,false);
  const events=await request('/api/security/events',{cookie:ownerCookie});
  assert.ok(events.data.events.some(e=>e.eventType==='complete_backup_exported'));
});

test('owner can run diagnostics and create a verified server snapshot',async()=>{
  const status=await request('/api/ops/status',{cookie:ownerCookie});
  assert.equal(status.res.status,200);assert.equal(status.data.runtime.ok,true);assert.equal(status.data.laneCVersion,1);
  const snap=await request('/api/ops/snapshot',{method:'POST',cookie:ownerCookie,csrf:ownerCsrf,body:{}});
  assert.equal(snap.res.status,201);
  assert.match(snap.data.sha256,/^[a-f0-9]{64}$/);
  assert.match(snap.data.schemaSha256,/^[a-f0-9]{64}$/);
  assert.equal(existsSync(join(dir,'backups',snap.data.snapshotFile)),true);
  const events=await request('/api/security/events',{cookie:ownerCookie});
  assert.ok(events.data.events.some(e=>e.eventType==='server_snapshot_created'));
});

test('non-owner cannot access operational diagnostics',async()=>{
  const email=`lane-c-other-${Date.now()}@example.com`;
  const created=await request('/api/users',{method:'POST',cookie:ownerCookie,csrf:ownerCsrf,body:{email,password:'another secure password'}});
  assert.equal(created.res.status,201);
  const login=await request('/api/auth/login',{method:'POST',body:{email,password:'another secure password'}});
  assert.equal(login.res.status,200);otherCookie=login.cookie;otherCsrf=login.data.csrfToken;
  const status=await request('/api/ops/status',{cookie:otherCookie});
  assert.equal(status.res.status,403);
  const snap=await request('/api/ops/snapshot',{method:'POST',cookie:otherCookie,csrf:otherCsrf,body:{}});
  assert.equal(snap.res.status,403);
});

test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
