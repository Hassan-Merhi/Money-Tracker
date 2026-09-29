import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureBankFeedExactMoneySchema, ensureCoreExactMoneySchema, ensureInsightsExactMoneySchema, exactMoneySchemaVersion, markExactMoneySchema } from '../lib/money-storage.js';

function typeMap(db,table){return new Map(db.prepare(`PRAGMA table_info(${table})`).all().map(row=>[row.name,String(row.type).toUpperCase()]));}

test('Wave 1 migrates every authoritative REAL money field to integer minor units',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mot-wave1-migrate-')),dbPath=join(dir,'legacy.sqlite'),db=new DatabaseSync(dbPath);
  try{
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,password_hash TEXT,display_name TEXT,default_currency TEXT,is_owner INTEGER,revision INTEGER,created_at TEXT);
      CREATE TABLE people(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,id TEXT NOT NULL,name TEXT,note TEXT,created_at TEXT,PRIMARY KEY(user_id,id));
      CREATE TABLE accounts(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,id TEXT NOT NULL,name TEXT,type TEXT,currency TEXT,opening_balance REAL NOT NULL DEFAULT 0,created_at TEXT,PRIMARY KEY(user_id,id));
      CREATE TABLE entries(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,id TEXT NOT NULL,type TEXT,person_id TEXT,account_id TEXT,from_account_id TEXT,to_account_id TEXT,amount REAL NOT NULL DEFAULT 0,currency TEXT,from_amount REAL,to_amount REAL,signed_amount REAL,date TEXT,merchant TEXT,description TEXT,split_json TEXT NOT NULL DEFAULT '[]',category_id TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(user_id,id));
      CREATE INDEX idx_entries_user_date ON entries(user_id,date,created_at);
      CREATE INDEX idx_entries_user_person ON entries(user_id,person_id);
      CREATE INDEX idx_entries_user_account ON entries(user_id,account_id);
      CREATE TABLE recurring_rules(user_id TEXT,id TEXT,title TEXT,frequency TEXT,interval_value INTEGER,anchor_date TEXT,next_due_date TEXT,end_date TEXT,remind_days_before INTEGER,is_active INTEGER,template_json TEXT,last_posted_at TEXT,last_occurrence_date TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(user_id,id));
      CREATE TABLE categories(user_id TEXT,id TEXT,name TEXT,kind TEXT,icon TEXT,archived INTEGER,created_at TEXT,updated_at TEXT,PRIMARY KEY(user_id,id));
      CREATE TABLE budgets(user_id TEXT,id TEXT,category_id TEXT,currency TEXT,monthly_limit REAL,created_at TEXT,updated_at TEXT,PRIMARY KEY(user_id,id),UNIQUE(user_id,category_id,currency));
      CREATE INDEX idx_budgets_user ON budgets(user_id,category_id,currency);
      CREATE TABLE bank_feed_items(user_id TEXT,id TEXT,account_id TEXT,fingerprint TEXT,source_name TEXT,external_id TEXT,txn_date TEXT,description TEXT,merchant TEXT,signed_amount REAL,currency TEXT,status TEXT,suggested_type TEXT,suggested_person_id TEXT,suggested_target_account_id TEXT,suggested_category_id TEXT,posted_entry_id TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(user_id,id),UNIQUE(user_id,fingerprint));
      CREATE INDEX idx_bank_feed_user_status_date ON bank_feed_items(user_id,status,txn_date DESC);
      CREATE TABLE bank_rules(user_id TEXT,id TEXT,match_text TEXT,classification TEXT,person_id TEXT,target_account_id TEXT,category_id TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(user_id,id));
    `);
    const stamp='2026-09-29T00:00:00.000Z';
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run('user_1','a@b.com','x','Ledger','USD',1,1,stamp);
    db.prepare('INSERT INTO people VALUES(?,?,?,?,?)').run('user_1','person_a','Alice','',stamp);
    db.prepare('INSERT INTO people VALUES(?,?,?,?,?)').run('user_1','person_b','Bob','',stamp);
    db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?,?)').run('user_1','account_usd','Bank','bank','USD',1000.10,stamp);
    db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?,?)').run('user_1','account_kwd','KWD Cash','cash','KWD',1.234,stamp);
    db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'user_1','entry_split','split_paid_for_people',null,'account_usd',null,null,0.3,'USD',null,null,null,'2026-09-29','Shop','Split',JSON.stringify([{personId:'person_a',amount:0.1,note:''},{personId:'person_b',amount:0.2,note:''}]),null,stamp,stamp
    );
    db.prepare('INSERT INTO recurring_rules VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'user_1','rule_1','Monthly','monthly',1,'2026-09-29','2026-10-29',null,0,1,JSON.stringify({type:'paid_for_person',personId:'person_a',accountId:'account_usd',amount:10.29,currency:'USD',merchant:'Amazon',description:'Recurring',splits:[]}),null,null,stamp,stamp
    );
    db.prepare('INSERT INTO categories VALUES(?,?,?,?,?,?,?,?)').run('user_1','category_food','Food','expense','',0,stamp,stamp);
    db.prepare('INSERT INTO budgets VALUES(?,?,?,?,?,?,?)').run('user_1','budget_1','category_food','USD',123.45,stamp,stamp);
    db.prepare('INSERT INTO bank_feed_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'user_1','bank_1','account_usd','fp','statement.csv','','2026-09-29','Lunch','Cafe',-12.34,'USD','pending','expense',null,null,'category_food',null,stamp,stamp
    );

    ensureCoreExactMoneySchema(db);
    ensureInsightsExactMoneySchema(db);
    ensureBankFeedExactMoneySchema(db);
    markExactMoneySchema(db);

    const accountCols=typeMap(db,'accounts'),entryCols=typeMap(db,'entries'),budgetCols=typeMap(db,'budgets'),feedCols=typeMap(db,'bank_feed_items');
    assert.equal(accountCols.get('opening_balance_minor'),'INTEGER');
    assert.equal(accountCols.has('opening_balance'),false);
    for(const name of ['amount_minor','from_amount_minor','to_amount_minor','signed_amount_minor'])assert.equal(entryCols.get(name),'INTEGER');
    for(const old of ['amount','from_amount','to_amount','signed_amount'])assert.equal(entryCols.has(old),false);
    assert.equal(budgetCols.get('monthly_limit_minor'),'INTEGER');
    assert.equal(budgetCols.has('monthly_limit'),false);
    assert.equal(feedCols.get('signed_amount_minor'),'INTEGER');
    assert.equal(feedCols.has('signed_amount'),false);

    assert.equal(db.prepare("SELECT opening_balance_minor v FROM accounts WHERE id='account_usd'").get().v,100010);
    assert.equal(db.prepare("SELECT opening_balance_minor v FROM accounts WHERE id='account_kwd'").get().v,1234);
    const entry=db.prepare("SELECT amount_minor AS amountMinor,split_json AS splitJson FROM entries WHERE id='entry_split'").get();
    assert.equal(entry.amountMinor,30);
    assert.deepEqual(JSON.parse(entry.splitJson).map(x=>x.amountMinor),[10,20]);
    assert.equal(db.prepare("SELECT monthly_limit_minor v FROM budgets WHERE id='budget_1'").get().v,12345);
    assert.equal(db.prepare("SELECT signed_amount_minor v FROM bank_feed_items WHERE id='bank_1'").get().v,-1234);
    const template=JSON.parse(db.prepare("SELECT template_json v FROM recurring_rules WHERE id='rule_1'").get().v);
    assert.equal(template.moneyStorageVersion,1);
    assert.equal(template.amountMinor,1029);
    assert.equal(Object.hasOwn(template,'amount'),false);
    assert.equal(exactMoneySchemaVersion(db),1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
