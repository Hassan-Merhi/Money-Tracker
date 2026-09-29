import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseSnapshot } from '../lib/db-snapshot.js';

const dir=mkdtempSync(join(tmpdir(),'mot-wave9-'));
process.env.DB_PATH=join(dir,'server.sqlite');
process.env.DATA_DIR=dir;
process.env.NODE_ENV='test';
const {server,db}=await import(`../server.mjs?wave9=${Date.now()}`);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;

async function request(path,{method='GET',body,cookie='',csrf=''}={}){
  const headers={};
  if(body!==undefined)headers['content-type']='application/json';
  if(cookie)headers.cookie=cookie;
  if(csrf)headers['x-csrf-token']=csrf;
  const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json().catch(()=>({}));
  return {res,data,cookie:res.headers.get('set-cookie')?.split(';')[0]};
}
function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
function resign(backup){
  const copy=structuredClone(backup);
  delete copy.sha256;
  const sha256=createHash('sha256').update(canonical(copy)).digest('hex');
  return {...copy,sha256};
}
function stateShape(state){
  return {
    people:state.people.map(row=>row.id).sort(),
    accounts:state.accounts.map(row=>row.id).sort(),
    entries:state.entries.map(row=>row.id).sort()
  };
}
function createRecoveryDatabase(path,value){
  const recoveryDb=new DatabaseSync(path);
  recoveryDb.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE people(user_id TEXT NOT NULL REFERENCES users(id),id TEXT NOT NULL,PRIMARY KEY(user_id,id));
    CREATE TABLE accounts(user_id TEXT NOT NULL REFERENCES users(id),id TEXT NOT NULL,PRIMARY KEY(user_id,id));
    CREATE TABLE entries(user_id TEXT NOT NULL REFERENCES users(id),id TEXT NOT NULL,PRIMARY KEY(user_id,id));
    CREATE TABLE recovery_probe(value TEXT NOT NULL);
  `);
  recoveryDb.prepare('INSERT INTO users(id) VALUES(?)').run('user_recovery');
  recoveryDb.prepare('INSERT INTO recovery_probe(value) VALUES(?)').run(value);
  return recoveryDb;
}

const ownerPassword='wave nine owner password';
let cookie='',csrf='',backup=null,baseline=null;

test('Wave 9 builds a complete restorable fixture',async()=>{
  const registered=await request('/api/auth/register',{method:'POST',body:{email:`wave9-${Date.now()}@example.com`,password:ownerPassword}});
  assert.equal(registered.res.status,201);cookie=registered.cookie;csrf=registered.data.csrfToken;
  let state=(await request('/api/state',{cookie})).data;
  let r=await request('/api/people',{method:'POST',cookie,csrf,body:{expectedRevision:state.version,id:'person_wave9',name:'Recovery Person'}});
  assert.equal(r.res.status,201);state=r.data;
  r=await request('/api/entries',{method:'POST',cookie,csrf,body:{expectedRevision:state.version,id:'entry_wave9',type:'paid_for_person',personId:'person_wave9',accountId:null,amount:12.34,currency:'USD',date:'2026-09-29',merchant:'Recovery',description:'Fixture',splits:[]}});
  assert.equal(r.res.status,201);state=r.data;
  const attachment=await request('/api/attachments',{method:'POST',cookie,csrf,body:{entryId:'entry_wave9',name:'receipt.txt',mimeType:'text/plain',data:Buffer.from('recovery receipt').toString('base64')}});
  assert.equal(attachment.res.status,201);
  const exported=await request('/api/backup/full',{cookie});
  assert.equal(exported.res.status,200);
  backup=exported.data;
  baseline=stateShape((await request('/api/state',{cookie})).data);
  assert.ok(backup.data.attachments.length>0);
});

test('complete restore rejects semantically invalid but correctly re-signed backups atomically',async()=>{
  const invalidTimezone=structuredClone(backup);
  invalidTimezone.user.timezone='Mars/Phobos';
  let r=await request('/api/backup/full/restore',{method:'POST',cookie,csrf,body:{backup:resign(invalidTimezone),password:ownerPassword,confirmation:'RESTORE'}});
  assert.equal(r.res.status,400);assert.match(r.data.error,/timezone/i);
  assert.deepEqual(stateShape((await request('/api/state',{cookie})).data),baseline);

  const malformedBinary=structuredClone(backup);
  malformedBinary.data.attachments[0].data={__type:'base64',data:'!!!!'};
  r=await request('/api/backup/full/restore',{method:'POST',cookie,csrf,body:{backup:resign(malformedBinary),password:ownerPassword,confirmation:'RESTORE'}});
  assert.equal(r.res.status,400);assert.match(r.data.error,/binary/i);
  assert.deepEqual(stateShape((await request('/api/state',{cookie})).data),baseline);

  const brokenReference=structuredClone(backup);
  brokenReference.data.entries[0].person_id='person_missing';
  r=await request('/api/backup/full/restore',{method:'POST',cookie,csrf,body:{backup:resign(brokenReference),password:ownerPassword,confirmation:'RESTORE'}});
  assert.equal(r.res.status,400);assert.match(r.data.error,/reference/i);
  assert.deepEqual(stateShape((await request('/api/state',{cookie})).data),baseline);

  const sizeMismatch=structuredClone(backup);
  sizeMismatch.data.attachments[0].size_bytes+=1;
  r=await request('/api/backup/full/restore',{method:'POST',cookie,csrf,body:{backup:resign(sizeMismatch),password:ownerPassword,confirmation:'RESTORE'}});
  assert.equal(r.res.status,400);assert.match(r.data.error,/attachments/i);
  assert.deepEqual(stateShape((await request('/api/state',{cookie})).data),baseline);

  const valid=await request('/api/backup/full/restore',{method:'POST',cookie,csrf,body:{backup,password:ownerPassword,confirmation:'RESTORE'}});
  assert.equal(valid.res.status,200);
  assert.deepEqual(stateShape(valid.data.state),baseline);
});

test('offline snapshot restore verifies the image and quarantines stale WAL/SHM sidecars',()=>{
  const recoveryDir=mkdtempSync(join(dir,'snapshot-ok-'));
  const livePath=join(recoveryDir,'ledger.sqlite');
  const recoveryDb=createRecoveryDatabase(livePath,'snapshotted');
  const snapshot=createDatabaseSnapshot(recoveryDb,{dataDir:recoveryDir,dbPath:livePath,label:'wave9-good'});
  recoveryDb.prepare('UPDATE recovery_probe SET value=?').run('newer-live-data');
  recoveryDb.close();
  writeFileSync(livePath+'-wal','stale wal that must never replay');
  writeFileSync(livePath+'-shm','stale shm that must never replay');

  const script=join(process.cwd(),'scripts','restore-db-snapshot.mjs');
  const run=spawnSync(process.execPath,[script,snapshot.path,'--confirm-offline-restore'],{
    encoding:'utf8',
    env:{...process.env,DB_PATH:livePath,DATA_DIR:recoveryDir,NODE_ENV:'test'}
  });
  assert.equal(run.status,0,run.stderr||run.stdout);
  const result=JSON.parse(run.stdout);
  assert.equal(result.restored,true);
  assert.equal(result.sourceValidated,true);
  assert.equal(result.sqliteQuickCheck,'ok');
  assert.equal(result.foreignKeyViolations,0);
  assert.ok(result.previousDatabase&&existsSync(result.previousDatabase));
  assert.equal(result.previousSidecars.length,2);
  assert.ok(result.previousSidecars.every(existsSync));
  assert.equal(existsSync(livePath+'-wal'),false);
  assert.equal(existsSync(livePath+'-shm'),false);

  const restored=new DatabaseSync(livePath);
  assert.equal(restored.prepare('SELECT value FROM recovery_probe').get().value,'snapshotted');
  restored.close();
  const previous=new DatabaseSync(result.previousDatabase);
  assert.equal(previous.prepare('SELECT value FROM recovery_probe').get().value,'newer-live-data');
  previous.close();
});

test('corrupt snapshot aborts before the live database is moved',()=>{
  const recoveryDir=mkdtempSync(join(dir,'snapshot-bad-'));
  const livePath=join(recoveryDir,'ledger.sqlite');
  const recoveryDb=createRecoveryDatabase(livePath,'snapshot-copy');
  const snapshot=createDatabaseSnapshot(recoveryDb,{dataDir:recoveryDir,dbPath:livePath,label:'wave9-corrupt'});
  recoveryDb.prepare('UPDATE recovery_probe SET value=?').run('live-must-survive');
  recoveryDb.close();

  const bytes=readFileSync(snapshot.path);
  bytes[bytes.length-1]^=0xff;
  writeFileSync(snapshot.path,bytes);

  const script=join(process.cwd(),'scripts','restore-db-snapshot.mjs');
  const run=spawnSync(process.execPath,[script,snapshot.path,'--confirm-offline-restore'],{
    encoding:'utf8',
    env:{...process.env,DB_PATH:livePath,DATA_DIR:recoveryDir,NODE_ENV:'test'}
  });
  assert.notEqual(run.status,0);
  assert.match(run.stderr+run.stdout,/checksum/i);
  const live=new DatabaseSync(livePath);
  assert.equal(live.prepare('SELECT value FROM recovery_probe').get().value,'live-must-survive');
  live.close();
});

after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  db.close();
  rmSync(dir,{recursive:true,force:true});
});
