import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { schemaFingerprint } from '../lib/db-snapshot.js';

const args=process.argv.slice(2);
const snapshotArg=args.find(arg=>!arg.startsWith('--'));
const confirmed=args.includes('--confirm-offline-restore');
if(!snapshotArg||!confirmed){
  console.error('Usage: node scripts/restore-db-snapshot.mjs <snapshot.sqlite> --confirm-offline-restore');
  console.error('The Money Tracker service MUST be stopped before this command is used.');
  process.exit(2);
}

const snapshotPath=resolve(snapshotArg);
const metadataPath=snapshotPath+'.json';
if(!existsSync(snapshotPath)||!existsSync(metadataPath)) throw new Error('Snapshot or metadata file not found.');

function sha256File(path){
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function inspectDatabase(path,expectedSchemaSha256){
  const db=new DatabaseSync(path);
  try{
    db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON;');
    const quickRow=db.prepare('PRAGMA quick_check').get();
    const quick=String(Object.values(quickRow||{})[0]||'unknown');
    if(quick!=='ok')throw new Error('Snapshot SQLite quick_check failed: '+quick);
    const fk=db.prepare('PRAGMA foreign_key_check').all();
    if(fk.length)throw new Error('Snapshot contains foreign-key violations.');
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
    for(const required of ['users','people','accounts','entries'])if(!tables.has(required))throw new Error('Snapshot is missing required Money Tracker table: '+required);
    const schemaSha256=schemaFingerprint(db);
    if(expectedSchemaSha256&&schemaSha256!==expectedSchemaSha256)throw new Error('Snapshot schema fingerprint does not match its metadata.');
    return {quickCheck:quick,foreignKeyViolations:fk.length,schemaSha256};
  }finally{
    db.close();
  }
}
function uniqueRollbackPath(dbPath){
  const base=dbPath+'.pre-restore-'+new Date().toISOString().replace(/[:.]/g,'-');
  let candidate=base,index=1;
  while(existsSync(candidate)||existsSync(candidate+'-wal')||existsSync(candidate+'-shm'))candidate=base+'-'+index++;
  return candidate;
}
function removeIfExists(path){if(existsSync(path))unlinkSync(path);}

const metadata=JSON.parse(readFileSync(metadataPath,'utf8'));
if(Number(metadata.version)!==1)throw new Error('Unsupported snapshot metadata version.');
if(metadata.snapshotFile!==basename(snapshotPath))throw new Error('Snapshot filename does not match its metadata.');
const bytes=statSync(snapshotPath).size;
if(Number(metadata.bytes)!==bytes)throw new Error('Snapshot size does not match its metadata.');
const actual=sha256File(snapshotPath);
if(!/^[a-f0-9]{64}$/.test(String(metadata.sha256||''))||actual!==metadata.sha256)throw new Error('Snapshot checksum does not match its metadata. Restore aborted.');
if(!/^[a-f0-9]{64}$/.test(String(metadata.schemaSha256||'')))throw new Error('Snapshot schema fingerprint is missing or invalid.');
const sourceInspection=inspectDatabase(snapshotPath,metadata.schemaSha256);

const dataDir=process.env.DATA_DIR||dirname(snapshotPath);
const dbPath=process.env.DB_PATH||join(dataDir,'ledger.sqlite');
mkdirSync(dirname(dbPath),{recursive:true});
const rollbackPath=existsSync(dbPath)?uniqueRollbackPath(dbPath):null;
const tempPath=dbPath+'.restore-'+process.pid+'-'+Date.now()+'.tmp';
const activeSidecars=['-wal','-shm'];
const movedSidecars=[];

try{
  copyFileSync(snapshotPath,tempPath);
  if(sha256File(tempPath)!==actual)throw new Error('Snapshot copy verification failed.');
  inspectDatabase(tempPath,metadata.schemaSha256);

  if(rollbackPath){
    renameSync(dbPath,rollbackPath);
    for(const suffix of activeSidecars){
      const active=dbPath+suffix;
      if(existsSync(active)){
        const rollback=rollbackPath+suffix;
        renameSync(active,rollback);
        movedSidecars.push({active,rollback});
      }
    }
  }else{
    for(const suffix of activeSidecars)removeIfExists(dbPath+suffix);
  }

  renameSync(tempPath,dbPath);
  const restoredInspection=inspectDatabase(dbPath,metadata.schemaSha256);
  if(sha256File(dbPath)!==actual)throw new Error('Restored database checksum verification failed.');

  console.log(JSON.stringify({
    restored:true,
    source:basename(snapshotPath),
    destination:dbPath,
    bytes,
    sha256:actual,
    schemaSha256:restoredInspection.schemaSha256,
    sqliteQuickCheck:restoredInspection.quickCheck,
    foreignKeyViolations:restoredInspection.foreignKeyViolations,
    previousDatabase:rollbackPath,
    previousSidecars:movedSidecars.map(item=>item.rollback),
    sourceValidated:true
  },null,2));
}catch(error){
  removeIfExists(tempPath);
  removeIfExists(dbPath+'-wal');
  removeIfExists(dbPath+'-shm');
  if(rollbackPath&&existsSync(rollbackPath)){
    removeIfExists(dbPath);
    renameSync(rollbackPath,dbPath);
    for(const item of movedSidecars)if(existsSync(item.rollback))renameSync(item.rollback,item.active);
  }
  throw error;
}
