import { statSync, statfsSync } from 'node:fs';
import { createDatabaseSnapshot } from './db-snapshot.js';

export function createRuntimeOps(db,{dataDir,dbPath}){
  let cached=null,cachedAt=0;

  function diagnostics({force=false}={}){
    if(!force&&cached&&Date.now()-cachedAt<30_000)return cached;
    const quick=String(db.prepare('PRAGMA quick_check').get()?.quick_check||db.prepare('PRAGMA quick_check').get()?.['quick_check']||'unknown');
    const fkRows=db.prepare('PRAGMA foreign_key_check').all();
    let dbBytes=0,diskFreeBytes=null,diskTotalBytes=null;
    try{dbBytes=Number(statSync(dbPath).size||0);}catch{}
    try{
      const fs=statfsSync(dataDir);
      diskFreeBytes=Number(fs.bavail)*Number(fs.bsize);
      diskTotalBytes=Number(fs.blocks)*Number(fs.bsize);
    }catch{}
    cached={
      ok:quick==='ok'&&fkRows.length===0,
      sqliteQuickCheck:quick,
      foreignKeyViolations:fkRows.length,
      dbBytes,
      diskFreeBytes,
      diskTotalBytes,
      checkedAt:new Date().toISOString()
    };
    cachedAt=Date.now();
    return cached;
  }

  function snapshot(label='lane-c-manual'){
    return createDatabaseSnapshot(db,{dataDir,dbPath,label});
  }

  return {diagnostics,snapshot};
}
