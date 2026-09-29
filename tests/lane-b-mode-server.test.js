import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mot-lane-b-mode-'));
process.env.DB_PATH=join(dir,'test.sqlite');
process.env.NODE_ENV='test';
const {server,db}=await import(`../server.mjs?laneBMode=${Date.now()}`);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let cookie='',csrf='',state;

async function request(path,{method='GET',body}={}){
  const headers={};if(body!==undefined)headers['content-type']='application/json';if(cookie)headers.cookie=cookie;if(csrf&&method!=='GET')headers['x-csrf-token']=csrf;
  const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json();return {res,data,cookie:res.headers.get('set-cookie')?.split(';')[0]};
}

test('Simple and Advanced modes persist without deleting hidden financial data',async()=>{
  const reg=await request('/api/auth/register',{method:'POST',body:{email:`mode-${Date.now()}@example.com`,password:'correct horse battery staple',displayName:'Mode Ledger'}});
  assert.equal(reg.res.status,201);cookie=reg.cookie;csrf=reg.data.csrfToken;
  state=(await request('/api/state')).data;
  assert.equal(state.settings.appMode,'simple');

  let r=await request('/api/accounts',{method:'POST',body:{expectedRevision:state.version,id:'account_bank',name:'Bank',type:'bank',currency:'USD',openingBalance:100}});
  assert.equal(r.res.status,201);state=r.data;
  r=await request('/api/people',{method:'POST',body:{expectedRevision:state.version,id:'person_alice',name:'Alice'}});
  assert.equal(r.res.status,201);state=r.data;
  r=await request('/api/entries',{method:'POST',body:{expectedRevision:state.version,id:'entry_advanced',type:'account_expense',accountId:'account_bank',amount:12.34,currency:'USD',date:'2026-09-29',merchant:'Cafe',description:'Hidden in simple mode'}});
  assert.equal(r.res.status,201);state=r.data;

  r=await request('/api/settings',{method:'PUT',body:{expectedRevision:state.version,appMode:'advanced',timezone:'Asia/Beirut',defaultCurrency:'USD'}});
  assert.equal(r.res.status,200);state=r.data;
  assert.equal(state.settings.appMode,'advanced');assert.equal(state.settings.timezone,'Asia/Beirut');
  assert.equal(state.accounts.length,1);assert.equal(state.entries.some(e=>e.id==='entry_advanced'),true);

  r=await request('/api/settings',{method:'PUT',body:{expectedRevision:state.version,appMode:'simple',timezone:'Asia/Beirut',defaultCurrency:'USD'}});
  assert.equal(r.res.status,200);state=r.data;
  assert.equal(state.settings.appMode,'simple');
  assert.equal(state.accounts.length,1);assert.equal(state.entries.some(e=>e.id==='entry_advanced'),true);

  const raw=db.prepare('SELECT app_mode AS appMode,timezone FROM users LIMIT 1').get();
  assert.equal(raw.appMode,'simple');assert.equal(raw.timezone,'Asia/Beirut');
});

test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
