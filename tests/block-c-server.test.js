import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTemplateWorkbook } from '../lib/xlsx.js';

const dir=mkdtempSync(join(tmpdir(),'mot-block-c-server-'));
process.env.DB_PATH=join(dir,'test.sqlite');
process.env.NODE_ENV='test';
const {server,db}=await import(`../server.mjs?blockc=${Date.now()}`);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;

let cookie='',csrf='',state;
async function jsonRequest(path,{method='GET',body,useAuth=true,useCsrf=false}={}){
  const headers={};
  if(body!==undefined)headers['content-type']='application/json';
  if(useAuth&&cookie)headers.cookie=cookie;
  if(useCsrf&&csrf)headers['x-csrf-token']=csrf;
  const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json().catch(()=>null);
  return {res,data};
}

test('Block C setup creates an authenticated ledger',async()=>{
  const res=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:`blockc-${Date.now()}@example.com`,password:'correct horse battery staple',displayName:'Block C Ledger'})});
  assert.equal(res.status,201);
  cookie=res.headers.get('set-cookie')?.split(';')[0]||'';
  const data=await res.json(); csrf=data.csrfToken; assert.ok(cookie&&csrf);
  const loaded=await jsonRequest('/api/state'); assert.equal(loaded.res.status,200); state=loaded.data;
});

test('Excel template downloads and can be previewed securely',async()=>{
  const template=await fetch(base+'/api/export/import-template.xlsx',{headers:{cookie}});
  assert.equal(template.status,200); assert.match(template.headers.get('content-type')||'',/spreadsheetml/);
  const bytes=Buffer.from(await template.arrayBuffer()); assert.equal(bytes.subarray(0,2).toString('hex'),'504b');

  const preview=await jsonRequest('/api/import/xlsx/preview',{method:'POST',useCsrf:true,body:{filename:'template.xlsx',dataBase64:importTemplateWorkbook().toString('base64')}});
  assert.equal(preview.res.status,200);
  assert.deepEqual(preview.data.sheets.map(s=>s.name),['README','People','Accounts','Transactions']);
});

test('invalid spreadsheet preview is a 400 and not a server error',async()=>{
  const preview=await jsonRequest('/api/import/xlsx/preview',{method:'POST',useCsrf:true,body:{filename:'bad.xlsx',dataBase64:Buffer.from('not a workbook').toString('base64')}});
  assert.equal(preview.res.status,400);
});

test('full Excel and PDF exports reflect saved ledger state',async()=>{
  const now=new Date().toISOString();
  state.people=[{id:'person_alice',name:'Alice',note:'Cousin',createdAt:now}];
  state.accounts=[{id:'account_bank',name:'Bank',type:'bank',currency:'USD',openingBalance:1000,createdAt:now}];
  state.entries=[{id:'entry_amazon',type:'paid_for_person',personId:'person_alice',accountId:'account_bank',amount:125,currency:'USD',date:'2026-09-28',merchant:'Amazon',description:'Order',createdAt:now,updatedAt:now}];
  const saved=await jsonRequest('/api/state',{method:'PUT',useCsrf:true,body:state}); assert.equal(saved.res.status,200); state=saved.data;

  const xlsx=await fetch(base+'/api/export/ledger.xlsx',{headers:{cookie}}); assert.equal(xlsx.status,200); assert.equal(Buffer.from(await xlsx.arrayBuffer()).subarray(0,2).toString('hex'),'504b');
  const summary=await fetch(base+'/api/export/summary.pdf',{headers:{cookie}}); assert.equal(summary.status,200); assert.equal(Buffer.from(await summary.arrayBuffer()).subarray(0,5).toString('latin1'),'%PDF-');
  const person=await fetch(base+'/api/export/person.pdf?personId=person_alice&currency=USD',{headers:{cookie}}); assert.equal(person.status,200); assert.equal(Buffer.from(await person.arrayBuffer()).subarray(0,5).toString('latin1'),'%PDF-');
});

test('exports still require authentication',async()=>{
  const r=await fetch(base+'/api/export/ledger.xlsx'); assert.equal(r.status,401);
});

test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
