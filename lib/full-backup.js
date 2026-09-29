const BACKUP_VERSION=2;

const TABLES=[
  {name:'people',max:10000},
  {name:'accounts',max:1000},
  {name:'categories',max:250},
  {name:'budgets',max:1000},
  {name:'entries',max:50000},
  {name:'attachments',max:10000},
  {name:'recurring_rules',max:500},
  {name:'bank_rules',max:500},
  {name:'bank_feed_items',max:5000}
];
const DELETE_ORDER=['bank_feed_items','bank_rules','attachments','recurring_rules','entries','budgets','categories','people','accounts'];
const INSERT_ORDER=['people','accounts','categories','budgets','entries','attachments','recurring_rules','bank_rules','bank_feed_items'];

function fail(message,status=400){return Object.assign(new Error(message),{status});}
function tableColumns(db,name){return db.prepare(`PRAGMA table_info(${name})`).all().map(r=>r.name);}
function encodeValue(value){
  if(value instanceof Uint8Array||Buffer.isBuffer(value))return {__type:'base64',data:Buffer.from(value).toString('base64')};
  return value;
}
function decodeValue(value){
  if(value&&typeof value==='object'&&value.__type==='base64'){
    const s=String(value.data||'');if(!/^[A-Za-z0-9+/]*={0,2}$/.test(s))throw fail('Invalid backup binary data.');
    return Buffer.from(s,'base64');
  }
  return value;
}
function rowsFor(db,table,userId){
  return db.prepare(`SELECT * FROM ${table} WHERE user_id=?`).all(userId).map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,encodeValue(v)])));
}
function validateRows(db,table,rows,userId,max){
  if(!Array.isArray(rows)||rows.length>max)throw fail(`Invalid ${table} backup data.`);
  const columns=new Set(tableColumns(db,table)),allowed=new Set([...columns].filter(c=>c!=='user_id'));
  return rows.map(raw=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw fail(`Invalid ${table} backup record.`);
    for(const key of Object.keys(raw))if(key!=='user_id'&&!allowed.has(key))throw fail(`Unsupported ${table} backup field.`);
    const out={};
    for(const col of allowed)if(Object.hasOwn(raw,col))out[col]=decodeValue(raw[col]);
    out.user_id=userId;
    return out;
  });
}
function insertRows(db,table,rows){
  if(!rows.length)return;
  const columns=tableColumns(db,table);
  const statement=db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
  for(const row of rows){
    const missing=columns.filter(col=>!Object.hasOwn(row,col));
    if(missing.length)throw fail(`Backup record for ${table} is missing required data.`);
    statement.run(...columns.map(col=>row[col]));
  }
}

export function exportFullBackup(db,userId){
  const user=db.prepare('SELECT email,display_name AS displayName,default_currency AS defaultCurrency,created_at AS createdAt FROM users WHERE id=?').get(userId);
  if(!user)throw fail('Account not found.',404);
  const data={};
  for(const table of TABLES)data[table.name]=rowsFor(db,table.name,userId);
  return {
    backupVersion:BACKUP_VERSION,
    app:'money-owed-tracker',
    exportedAt:new Date().toISOString(),
    user,
    data
  };
}

export function restoreFullBackup(db,userId,input){
  if(!input||typeof input!=='object'||Number(input.backupVersion)!==BACKUP_VERSION||input.app!=='money-owed-tracker')throw fail('That file is not a complete Money Tracker backup.');
  const data=input.data;if(!data||typeof data!=='object')throw fail('Backup data is missing.');
  const user=input.user||{},displayName=String(user.displayName||'Money Tracker').trim().slice(0,80)||'Money Tracker',defaultCurrency=String(user.defaultCurrency||'USD').toUpperCase();
  if(!/^[A-Z]{3,5}$/.test(defaultCurrency))throw fail('Backup default currency is invalid.');
  const clean={};
  for(const table of TABLES)clean[table.name]=validateRows(db,table.name,data[table.name]??[],userId,table.max);
  const attachmentBytes=clean.attachments.reduce((sum,row)=>sum+(row.data?.length||0),0);
  if(attachmentBytes>100*1024*1024)throw fail('Backup attachments exceed the 100 MB restore limit.',413);

  db.exec('BEGIN IMMEDIATE');
  try{
    for(const table of DELETE_ORDER)db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
    for(const table of INSERT_ORDER)insertRows(db,table,clean[table]);
    const updated=db.prepare('UPDATE users SET display_name=?,default_currency=?,revision=revision+1 WHERE id=?').run(displayName,defaultCurrency,userId);
    if(Number(updated.changes)!==1)throw fail('Account not found.',404);
    const fk=db.prepare('PRAGMA foreign_key_check').all();
    if(fk.length)throw fail('Backup contains broken references.');
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return {ok:true};
}

export {BACKUP_VERSION};
