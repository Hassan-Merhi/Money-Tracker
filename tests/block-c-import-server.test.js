import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildXlsx } from '../lib/xlsx.js';

const dir=mkdtempSync(join(tmpdir(),'mot-block-c-import-'));
process.env.DB_PATH=join(dir,'test.sqlite');
process.env.NODE_ENV='test';
const {server,db}=await import(`../server.mjs?blockcimport=${Date.now()}`);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let cookie='',csrf='';

async function register(){
  const res=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:`import-${Date.now()}@example.com`,password:'correct horse battery staple',displayName:'Import Test'})});
  assert.equal(res.status,201);cookie=res.headers.get('set-cookie')?.split(';')[0]||'';const data=await res.json();csrf=data.csrfToken;
}

test('xlsx preview requires authentication and CSRF',async()=>{
  await register();
  const bytes=buildXlsx([{name:'People',rows:[['Name','Balance'],['Alice',10]]}]);
  const body=JSON.stringify({filename:'people.xlsx',dataBase64:Buffer.from(bytes).toString('base64')});
  const noCsrf=await fetch(base+'/api/import/xlsx/preview',{method:'POST',headers:{cookie,'content-type':'application/json'},body});
  assert.equal(noCsrf.status,403);
  const ok=await fetch(base+'/api/import/xlsx/preview',{method:'POST',headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json'},body});
  assert.equal(ok.status,200);const parsed=await ok.json();assert.equal(parsed.sheets[0].rows[0].Name,'Alice');
});

test('malformed workbook is rejected as a client error',async()=>{
  const res=await fetch(base+'/api/import/xlsx/preview',{method:'POST',headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify({filename:'bad.xlsx',dataBase64:Buffer.from('not xlsx').toString('base64')})});
  assert.equal(res.status,400);
});

test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
