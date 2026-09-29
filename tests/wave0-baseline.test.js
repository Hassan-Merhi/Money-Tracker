import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { accountBalances, personBalances, totalsFromBalances } from '../lib/ledger.js';
import { reportingSnapshot } from '../lib/reporting.js';
import { createDatabaseSnapshot, schemaFingerprint } from '../lib/db-snapshot.js';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/wave0-ledger-baseline.json',import.meta.url),'utf8'));

test('Wave 0 freezes every current ledger balance movement',()=>{
  const person=personBalances(fixture.entries,fixture.people);
  const accounts=accountBalances(fixture.entries,fixture.accounts);
  const totals=totalsFromBalances(person);
  assert.deepEqual(person,fixture.expected.personBalances);
  assert.deepEqual(accounts,fixture.expected.accountBalances);
  assert.deepEqual(totals,fixture.expected.totals);
});

test('Wave 0 freezes reporting cash-flow semantics',()=>{
  const report=reportingSnapshot(fixture);
  assert.deepEqual(report.personalCashFlow,fixture.expected.personalCashFlow);
  assert.equal(report.transactionCount,fixture.entries.length);
});

test('Wave 0 database snapshots are checksum-verifiable and preserve schema/data',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mot-wave0-'));
  const dbPath=join(dir,'ledger.sqlite');
  const db=new DatabaseSync(dbPath);
  try{
    db.exec("CREATE TABLE sample(id TEXT PRIMARY KEY, amount REAL NOT NULL); INSERT INTO sample VALUES ('a', 12.5);");
    const before=schemaFingerprint(db);
    const result=createDatabaseSnapshot(db,{dataDir:dir,dbPath,label:'wave0-test',createdAt:new Date('2026-09-29T00:00:00.000Z')});
    assert.equal(result.schemaSha256,before);
    const copy=new DatabaseSync(result.path,{readOnly:true});
    try{
      assert.deepEqual(copy.prepare('SELECT * FROM sample').all(),[{id:'a',amount:12.5}]);
      assert.equal(schemaFingerprint(copy),before);
    }finally{copy.close();}
    const metadata=JSON.parse(readFileSync(result.metadataPath,'utf8'));
    assert.equal(metadata.sha256,result.sha256);
    assert.equal(metadata.snapshotFile,'wave0-test-2026-09-29T00-00-00-000Z.sqlite');
  }finally{
    db.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
