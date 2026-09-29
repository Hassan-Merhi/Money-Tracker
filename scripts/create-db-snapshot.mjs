import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createDatabaseSnapshot } from '../lib/db-snapshot.js';

const dataDir=process.env.DATA_DIR||join(process.cwd(),'data');
const dbPath=process.env.DB_PATH||join(dataDir,'ledger.sqlite');
const label=process.argv[2]||'manual';
const db=new DatabaseSync(dbPath);
try{
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const result=createDatabaseSnapshot(db,{dataDir,dbPath,label});
  console.log(JSON.stringify(result,null,2));
}finally{
  db.close();
}
