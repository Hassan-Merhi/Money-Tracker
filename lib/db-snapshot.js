import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

function stamp(value=new Date()) {
  return value.toISOString().replace(/[:.]/g,'-');
}
function sqlQuote(value) {
  return String(value).replaceAll("'","''");
}
function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
export function schemaManifest(db) {
  const rows=db.prepare(`SELECT type,name,tbl_name AS tableName,sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type,name`).all();
  return rows.map(row=>({
    type:row.type,
    name:row.name,
    tableName:row.tableName,
    sql:String(row.sql||'').replace(/\s+/g,' ').trim()
  }));
}
export function schemaFingerprint(db) {
  return createHash('sha256').update(JSON.stringify(schemaManifest(db))).digest('hex');
}
export function createDatabaseSnapshot(db,{dataDir,dbPath,label='manual',createdAt=new Date()}={}) {
  if(!db||!dataDir||!dbPath) throw new Error('Snapshot requires db, dataDir and dbPath.');
  const backupDir=join(dataDir,'backups');
  mkdirSync(backupDir,{recursive:true});
  const safeLabel=String(label||'manual').replace(/[^a-zA-Z0-9_-]+/g,'-').slice(0,80)||'manual';
  const filename=`${safeLabel}-${stamp(createdAt)}.sqlite`;
  const snapshotPath=join(backupDir,filename);
  if(existsSync(snapshotPath)) throw new Error('Snapshot path already exists.');
  db.exec(`VACUUM INTO '${sqlQuote(snapshotPath)}'`);
  const bytes=statSync(snapshotPath).size;
  const sha256=sha256File(snapshotPath);
  const schemaSha256=schemaFingerprint(db);
  const metadata={
    version:1,
    label:safeLabel,
    createdAt:createdAt.toISOString(),
    sourceDatabase:basename(dbPath),
    snapshotFile:filename,
    bytes,
    sha256,
    schemaSha256
  };
  writeFileSync(snapshotPath+'.json',JSON.stringify(metadata,null,2)+'\n',{mode:0o600});
  return {...metadata,path:snapshotPath,metadataPath:snapshotPath+'.json'};
}
