import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mot-wave6-'));
process.env.DB_PATH=join(dir,'test.sqlite');
process.env.NODE_ENV='test';
const {server}=await import(`../server.mjs?wave6=${Date.now()}`);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;

async function request(path,{method='GET',body,cookie,csrf}={}){
  const headers={};if(body!==undefined)headers['content-type']='application/json';if(cookie)headers.cookie=cookie;if(csrf)headers['x-csrf-token']=csrf;
  const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json();return {res,data,cookie:res.headers.get('set-cookie')?.split(';')[0]};
}

let cookie,csrf,state;

test('Wave 6 server: seed two USD accounts and one EUR account',async()=>{
  const reg=await request('/api/auth/register',{method:'POST',body:{email:`wave6-${Date.now()}@example.com`,password:'correct horse battery staple'}});
  assert.equal(reg.res.status,201);cookie=reg.cookie;csrf=reg.data.csrfToken;
  state=(await request('/api/state',{cookie})).data;
  const t=new Date().toISOString();
  state.settings.appMode='advanced';
  state.accounts=[
    {id:'usd_bank',name:'USD Bank',type:'bank',currency:'USD',openingBalance:100,createdAt:t},
    {id:'usd_cash',name:'USD Cash',type:'cash',currency:'USD',openingBalance:50,createdAt:t},
    {id:'eur_bank',name:'EUR Bank',type:'bank',currency:'EUR',openingBalance:20,createdAt:t}
  ];
  const saved=await request('/api/state',{method:'PUT',cookie,csrf,body:state});
  assert.equal(saved.res.status,200);state=saved.data;
});

test('Wave 6 server: atomic entry API rejects a non-conserving same-currency transfer',async()=>{
  const bad=await request('/api/entries',{method:'POST',cookie,csrf,body:{
    expectedRevision:state.version,id:'entry_bad_transfer',type:'account_transfer',
    fromAccountId:'usd_bank',toAccountId:'usd_cash',fromAmount:10,toAmount:9.99,amount:10,
    date:'2026-09-29',description:'must fail'
  }});
  assert.equal(bad.res.status,400);
  assert.match(bad.data.error,/same-currency transfer amounts must match/i);
  const current=await request('/api/state',{cookie});
  assert.equal(current.data.entries.some(e=>e.id==='entry_bad_transfer'),false);
  assert.equal(current.data.version,state.version);
});

test('Wave 6 server: same-currency exact transfer and cross-currency transfer remain valid',async()=>{
  const same=await request('/api/entries',{method:'POST',cookie,csrf,body:{
    expectedRevision:state.version,id:'entry_same_transfer',type:'account_transfer',
    fromAccountId:'usd_bank',toAccountId:'usd_cash',fromAmount:10,toAmount:10,amount:10,date:'2026-09-29'
  }});
  assert.equal(same.res.status,201);state=same.data;
  const cross=await request('/api/entries',{method:'POST',cookie,csrf,body:{
    expectedRevision:state.version,id:'entry_cross_transfer',type:'account_transfer',
    fromAccountId:'usd_bank',toAccountId:'eur_bank',fromAmount:10,toAmount:9.2,amount:10,date:'2026-09-29'
  }});
  assert.equal(cross.res.status,201);state=cross.data;
});

test('Wave 6 server: recurring transfer validation rejects the same conservation violation',async()=>{
  const bad=await request('/api/recurring',{method:'POST',cookie,csrf,body:{
    title:'Bad transfer',frequency:'monthly',interval:1,anchorDate:'2026-10-01',nextDueDate:'2026-10-01',
    remindDaysBefore:0,isActive:true,
    template:{type:'account_transfer',fromAccountId:'usd_bank',toAccountId:'usd_cash',fromAmount:20,toAmount:19.99,amount:20}
  }});
  assert.equal(bad.res.status,400);
  assert.match(bad.data.error,/same-currency transfer amounts must match/i);
});

test.after(async()=>{await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});});
