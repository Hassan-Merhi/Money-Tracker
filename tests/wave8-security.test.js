import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mot-wave8-'));
process.env.DB_PATH=join(dir,'test.sqlite');
process.env.DATA_DIR=dir;
process.env.NODE_ENV='test';
const {server,db}=await import(`../server.mjs?wave8=${Date.now()}`);
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

const ownerPassword='wave eight owner password';
let cookie='',csrf='';

test('Wave 8 registers the owner and exposes hardened session cookies',async()=>{
  const r=await request('/api/auth/register',{method:'POST',body:{email:`wave8-${Date.now()}@example.com`,password:ownerPassword}});
  assert.equal(r.res.status,201);
  const setCookie=r.res.headers.get('set-cookie')||'';
  assert.match(setCookie,/HttpOnly/i);
  assert.match(setCookie,/SameSite=Lax/i);
  cookie=r.cookie;csrf=r.data.csrfToken;
});

test('destructive restore rejects missing CSRF and cross-site requests before data changes',async()=>{
  let state=(await request('/api/state',{cookie})).data;
  const created=await request('/api/people',{method:'POST',cookie,csrf,body:{expectedRevision:state.version,id:'person_wave8_guard',name:'Guarded'}});
  assert.equal(created.res.status,201);state=created.data;
  const exported=await request('/api/backup/full',{cookie});
  assert.equal(exported.res.status,200);

  const noCsrf=await request('/api/backup/full/restore',{method:'POST',cookie,body:{backup:exported.data,password:ownerPassword,confirmation:'RESTORE'}});
  assert.equal(noCsrf.res.status,403);
  const crossSite=await request('/api/backup/full/restore',{
    method:'POST',cookie,csrf,
    headers:{origin:'https://evil.example','sec-fetch-site':'cross-site'},
    body:{backup:exported.data,password:ownerPassword,confirmation:'RESTORE'}
  });
  assert.equal(crossSite.res.status,403);
  const after=await request('/api/state',{cookie});
  assert.equal(after.data.people.some(person=>person.id==='person_wave8_guard'),true);
});

test('owner password reset for a secondary user requires owner re-authentication',async()=>{
  const email=`wave8-secondary-${Date.now()}@example.com`,oldPassword='secondary old password',newPassword='secondary replacement password';
  const created=await request('/api/users',{method:'POST',cookie,csrf,body:{email,password:oldPassword}});
  assert.equal(created.res.status,201);
  const id=created.data.user.id;
  const login=await request('/api/auth/login',{method:'POST',body:{email,password:oldPassword}});
  assert.equal(login.res.status,200);

  const missing=await request(`/api/users/${id}/password`,{method:'POST',cookie,csrf,body:{password:newPassword}});
  assert.equal(missing.res.status,403);
  assert.equal((await request('/api/state',{cookie:login.cookie})).res.status,200);

  const wrong=await request(`/api/users/${id}/password`,{method:'POST',cookie,csrf,body:{password:newPassword,currentPassword:'wrong owner password'}});
  assert.equal(wrong.res.status,403);
  assert.equal((await request('/api/state',{cookie:login.cookie})).res.status,200);

  const changed=await request(`/api/users/${id}/password`,{method:'POST',cookie,csrf,body:{password:newPassword,currentPassword:ownerPassword}});
  assert.equal(changed.res.status,200);
  assert.equal((await request('/api/state',{cookie:login.cookie})).res.status,401);
  assert.equal((await request('/api/auth/login',{method:'POST',body:{email,password:oldPassword}})).res.status,401);
  assert.equal((await request('/api/auth/login',{method:'POST',body:{email,password:newPassword}})).res.status,200);
});

test('secondary-user deletion requires typed confirmation and the owner password',async()=>{
  const email=`wave8-delete-${Date.now()}@example.com`,password='secondary delete password';
  const created=await request('/api/users',{method:'POST',cookie,csrf,body:{email,password}});
  assert.equal(created.res.status,201);
  const id=created.data.user.id;

  const noConfirmation=await request(`/api/users/${id}`,{method:'DELETE',cookie,csrf,body:{currentPassword:ownerPassword}});
  assert.equal(noConfirmation.res.status,400);
  const wrongPassword=await request(`/api/users/${id}`,{method:'DELETE',cookie,csrf,body:{currentPassword:'wrong owner password',confirmation:'DELETE'}});
  assert.equal(wrongPassword.res.status,403);
  assert.equal((await request('/api/auth/login',{method:'POST',body:{email,password}})).res.status,200);

  const deleted=await request(`/api/users/${id}`,{method:'DELETE',cookie,csrf,body:{currentPassword:ownerPassword,confirmation:'DELETE'}});
  assert.equal(deleted.res.status,200);
  assert.equal((await request('/api/auth/login',{method:'POST',body:{email,password}})).res.status,401);
});

test('complete restore requires RESTORE plus the current password and preserves data on failure',async()=>{
  let state=(await request('/api/state',{cookie})).data;
  const exported=await request('/api/backup/full',{cookie});
  assert.equal(exported.res.status,200);
  const backup=exported.data;

  const added=await request('/api/people',{method:'POST',cookie,csrf,body:{expectedRevision:state.version,id:'person_wave8_after_backup',name:'Must survive rejected restore'}});
  assert.equal(added.res.status,201);

  const noConfirm=await request('/api/backup/full/restore',{method:'POST',cookie,csrf,body:{backup,password:ownerPassword,confirmation:'NO'}});
  assert.equal(noConfirm.res.status,400);
  const wrongPassword=await request('/api/backup/full/restore',{method:'POST',cookie,csrf,body:{backup,password:'wrong owner password',confirmation:'RESTORE'}});
  assert.equal(wrongPassword.res.status,403);
  let current=(await request('/api/state',{cookie})).data;
  assert.equal(current.people.some(person=>person.id==='person_wave8_after_backup'),true);

  const restored=await request('/api/backup/full/restore',{method:'POST',cookie,csrf,body:{backup,password:ownerPassword,confirmation:'RESTORE'}});
  assert.equal(restored.res.status,200);
  current=restored.data.state;
  assert.equal(current.people.some(person=>person.id==='person_wave8_after_backup'),false);

  const events=await request('/api/security/events',{cookie});
  assert.equal(events.res.status,200);
  assert.ok(events.data.events.some(event=>event.eventType==='destructive_reauth_failed'));
  assert.ok(events.data.events.some(event=>event.eventType==='complete_backup_restored'));
});

after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  db.close();
  rmSync(dir,{recursive:true,force:true});
});
