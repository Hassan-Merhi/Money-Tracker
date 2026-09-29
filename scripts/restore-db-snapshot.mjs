import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

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
const metadata=JSON.parse(readFileSync(metadataPath,'utf8'));
const actual=createHash('sha256').update(readFileSync(snapshotPath)).digest('hex');
if(actual!==metadata.sha256) throw new Error('Snapshot checksum does not match its metadata. Restore aborted.');

const dataDir=process.env.DATA_DIR||dirname(snapshotPath);
const dbPath=process.env.DB_PATH||join(dataDir,'ledger.sqlite');
const rollbackPath=dbPath+'.pre-restore';
if(existsSync(dbPath)) renameSync(dbPath,rollbackPath);
try{
  copyFileSync(snapshotPath,dbPath);
  console.log(JSON.stringify({
    restored:true,
    source:basename(snapshotPath),
    destination:dbPath,
    sha256:actual,
    previousDatabase:existsSync(rollbackPath)?rollbackPath:null
  },null,2));
}catch(error){
  if(existsSync(rollbackPath)&&!existsSync(dbPath)) renameSync(rollbackPath,dbPath);
  throw error;
}
