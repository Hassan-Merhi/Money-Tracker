import { fromMinor, MONEY_STORAGE_VERSION, toMinor } from './money.js';

function columns(db,table){return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name));}
function accountMapForUser(rows=[]){return new Map(rows.map(row=>[row.id,row]));}
function currencyForEntry(entry,accounts){
  if(entry.type==='account_transfer')return accounts.get(entry.fromAccountId)?.currency||'USD';
  return String(entry.currency||accounts.get(entry.accountId)?.currency||'USD').toUpperCase();
}
function splitStorage(splits,currency){
  return (Array.isArray(splits)?splits:[]).map(split=>({
    personId:split.personId,
    amountMinor:toMinor(split.amount,currency,{allowNegative:false,allowZero:false}),
    note:String(split.note||'')
  }));
}
function splitApi(splits,currency){
  return (Array.isArray(splits)?splits:[]).map(split=>({
    personId:split.personId,
    amount:fromMinor(Number(split.amountMinor),currency),
    note:String(split.note||'')
  }));
}
export function decodeStoredSplits(value,currency){
  let splits=[];try{splits=JSON.parse(value||'[]');}catch{}
  if(!Array.isArray(splits))return [];
  if(splits.every(split=>Number.isSafeInteger(Number(split?.amountMinor))))return splitApi(splits,currency);
  return splits.map(split=>({personId:split?.personId,amount:Number(split?.amount||0),note:String(split?.note||'')}));
}

export function accountFromStorage(row){
  return {...row,openingBalance:fromMinor(Number(row.openingBalanceMinor),row.currency)};
}

export function accountToStorage(account){
  return {...account,openingBalanceMinor:toMinor(account.openingBalance,account.currency)};
}

export function entryToStorage(entry,accountById){
  const accounts=accountById instanceof Map?accountById:accountMapForUser(accountById||[]);
  if(entry.type==='account_transfer'){
    const fromCurrency=accounts.get(entry.fromAccountId)?.currency;
    const toCurrency=accounts.get(entry.toAccountId)?.currency;
    if(!fromCurrency||!toCurrency)throw new Error('Transfer account currency is missing.');
    const fromAmountMinor=toMinor(entry.fromAmount,fromCurrency,{allowNegative:false,allowZero:false});
    const toAmountMinor=toMinor(entry.toAmount,toCurrency,{allowNegative:false,allowZero:false});
    return {
      amountMinor:fromAmountMinor,
      fromAmountMinor,
      toAmountMinor,
      signedAmountMinor:null,
      splitJson:'[]'
    };
  }
  const currency=currencyForEntry(entry,accounts);
  const amountMinor=toMinor(entry.amount,currency,{allowNegative:false});
  const signedAmountMinor=entry.signedAmount==null?null:toMinor(entry.signedAmount,currency);
  return {
    amountMinor,
    fromAmountMinor:null,
    toAmountMinor:null,
    signedAmountMinor,
    splitJson:JSON.stringify(splitStorage(entry.splits,currency))
  };
}

export function entryFromStorage(row,accountById){
  const accounts=accountById instanceof Map?accountById:accountMapForUser(accountById||[]);
  if(row.type==='account_transfer'){
    const fromCurrency=accounts.get(row.fromAccountId)?.currency||'USD';
    const toCurrency=accounts.get(row.toAccountId)?.currency||fromCurrency;
    const fromAmount=fromMinor(Number(row.fromAmountMinor),fromCurrency);
    const toAmount=fromMinor(Number(row.toAmountMinor),toCurrency);
    return {...row,amount:fromAmount,fromAmount,toAmount,signedAmount:null,splits:[]};
  }
  const currency=currencyForEntry(row,accounts);
  return {
    ...row,
    amount:fromMinor(Number(row.amountMinor),currency),
    fromAmount:null,
    toAmount:null,
    signedAmount:row.signedAmountMinor==null?null:fromMinor(Number(row.signedAmountMinor),currency),
    splits:decodeStoredSplits(row.splitJson,currency)
  };
}

export function templateToStorage(template,accountById){
  const storage=entryToStorage(template,accountById);
  const out={...template,moneyStorageVersion:MONEY_STORAGE_VERSION};
  delete out.amount;delete out.fromAmount;delete out.toAmount;delete out.signedAmount;delete out.splits;
  return {
    ...out,
    amountMinor:storage.amountMinor,
    fromAmountMinor:storage.fromAmountMinor,
    toAmountMinor:storage.toAmountMinor,
    signedAmountMinor:storage.signedAmountMinor,
    splits:JSON.parse(storage.splitJson)
  };
}

export function templateFromStorage(template,accountById){
  if(!template||typeof template!=='object')return {};
  if(Number(template.moneyStorageVersion)!==MONEY_STORAGE_VERSION){
    return {...template};
  }
  const row={
    ...template,
    splitJson:JSON.stringify(template.splits||[])
  };
  const api=entryFromStorage(row,accountById);
  const out={...template,...api};
  delete out.moneyStorageVersion;delete out.amountMinor;delete out.fromAmountMinor;delete out.toAmountMinor;delete out.signedAmountMinor;delete out.splitJson;
  return out;
}

function createExactAccounts(db){
  db.exec(`CREATE TABLE accounts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    currency TEXT NOT NULL,
    opening_balance_minor INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id,id)
  )`);
}
function createExactEntries(db){
  db.exec(`CREATE TABLE entries (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    person_id TEXT,
    account_id TEXT,
    from_account_id TEXT,
    to_account_id TEXT,
    amount_minor INTEGER NOT NULL DEFAULT 0,
    currency TEXT,
    from_amount_minor INTEGER,
    to_amount_minor INTEGER,
    signed_amount_minor INTEGER,
    date TEXT NOT NULL,
    merchant TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    split_json TEXT NOT NULL DEFAULT '[]',
    category_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id,id),
    FOREIGN KEY (user_id,person_id) REFERENCES people(user_id,id),
    FOREIGN KEY (user_id,account_id) REFERENCES accounts(user_id,id),
    FOREIGN KEY (user_id,from_account_id) REFERENCES accounts(user_id,id),
    FOREIGN KEY (user_id,to_account_id) REFERENCES accounts(user_id,id)
  );
  CREATE INDEX idx_entries_user_date ON entries(user_id,date,created_at);
  CREATE INDEX idx_entries_user_person ON entries(user_id,person_id);
  CREATE INDEX idx_entries_user_account ON entries(user_id,account_id);`);
}

function migrateRecurringTemplates(db){
  if(!columns(db,'recurring_rules').has('template_json'))return;
  const accounts=db.prepare('SELECT user_id AS userId,id,currency FROM accounts').all();
  const maps=new Map();
  for(const account of accounts){
    if(!maps.has(account.userId))maps.set(account.userId,new Map());
    maps.get(account.userId).set(account.id,account);
  }
  const rows=db.prepare('SELECT user_id AS userId,id,template_json AS templateJson FROM recurring_rules').all();
  const update=db.prepare('UPDATE recurring_rules SET template_json=? WHERE user_id=? AND id=?');
  for(const row of rows){
    let raw={};try{raw=JSON.parse(row.templateJson||'{}');}catch{continue;}
    if(Number(raw.moneyStorageVersion)===MONEY_STORAGE_VERSION)continue;
    const accountById=maps.get(row.userId)||new Map();
    const stored=templateToStorage(raw,accountById);
    update.run(JSON.stringify(stored),row.userId,row.id);
  }
}

export function ensureCoreExactMoneySchema(db){
  const accountCols=columns(db,'accounts'),entryCols=columns(db,'entries');
  const exact=accountCols.has('opening_balance_minor')&&entryCols.has('amount_minor')&&entryCols.has('from_amount_minor')&&entryCols.has('to_amount_minor')&&entryCols.has('signed_amount_minor');
  if(!exact){
    const accountRows=db.prepare('SELECT * FROM accounts').all();
    const entryRows=db.prepare('SELECT * FROM entries').all();
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('BEGIN IMMEDIATE');
    try{
      db.exec('DROP INDEX IF EXISTS idx_entries_user_date; DROP INDEX IF EXISTS idx_entries_user_person; DROP INDEX IF EXISTS idx_entries_user_account;');
      db.exec('ALTER TABLE entries RENAME TO entries_wave1_legacy;');
      db.exec('ALTER TABLE accounts RENAME TO accounts_wave1_legacy;');
      createExactAccounts(db);createExactEntries(db);
      const insertAccount=db.prepare('INSERT INTO accounts(user_id,id,name,type,currency,opening_balance_minor,created_at) VALUES(?,?,?,?,?,?,?)');
      const accountsByUser=new Map();
      for(const row of accountRows){
        const api={id:row.id,currency:row.currency,openingBalance:Number(row.opening_balance||0)};
        const stored=accountToStorage(api);
        insertAccount.run(row.user_id,row.id,row.name,row.type,row.currency,stored.openingBalanceMinor,row.created_at);
        if(!accountsByUser.has(row.user_id))accountsByUser.set(row.user_id,new Map());
        accountsByUser.get(row.user_id).set(row.id,{id:row.id,currency:row.currency});
      }
      const insertEntry=db.prepare(`INSERT INTO entries(user_id,id,type,person_id,account_id,from_account_id,to_account_id,amount_minor,currency,from_amount_minor,to_amount_minor,signed_amount_minor,date,merchant,description,category_id,split_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for(const row of entryRows){
        let splits=[];try{splits=JSON.parse(row.split_json||'[]');}catch{}
        const api={
          id:row.id,type:row.type,personId:row.person_id,accountId:row.account_id,fromAccountId:row.from_account_id,toAccountId:row.to_account_id,
          amount:Number(row.amount||0),currency:row.currency,fromAmount:row.from_amount==null?null:Number(row.from_amount),toAmount:row.to_amount==null?null:Number(row.to_amount),
          signedAmount:row.signed_amount==null?null:Number(row.signed_amount),splits
        };
        const stored=entryToStorage(api,accountsByUser.get(row.user_id)||new Map());
        insertEntry.run(row.user_id,row.id,row.type,row.person_id,row.account_id,row.from_account_id,row.to_account_id,stored.amountMinor,row.currency,stored.fromAmountMinor,stored.toAmountMinor,stored.signedAmountMinor,row.date,row.merchant,row.description,row.category_id||null,stored.splitJson,row.created_at,row.updated_at);
      }
      db.exec('DROP TABLE entries_wave1_legacy; DROP TABLE accounts_wave1_legacy;');
      const fk=db.prepare('PRAGMA foreign_key_check').all();
      if(fk.length)throw new Error('Exact-money migration failed foreign-key verification.');
      db.exec('COMMIT');
    }catch(error){
      db.exec('ROLLBACK');
      throw error;
    }finally{
      db.exec('PRAGMA foreign_keys=ON');
    }
  }
  migrateRecurringTemplates(db);
}

export function markExactMoneySchema(db){
  db.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);');
  db.prepare("INSERT INTO app_meta(key,value) VALUES('money_schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(MONEY_STORAGE_VERSION));
}

export function exactMoneySchemaVersion(db){
  try{return Number(db.prepare("SELECT value FROM app_meta WHERE key='money_schema_version'").get()?.value||0);}catch{return 0;}
}
