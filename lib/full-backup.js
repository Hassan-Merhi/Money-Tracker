import { createHash } from 'node:crypto';
import { DATA_LIMITS } from './data-limits.js';

const BACKUP_VERSION=2;

const TABLES=[
  {name:'people',max:DATA_LIMITS.people},
  {name:'accounts',max:DATA_LIMITS.accounts},
  {name:'categories',max:DATA_LIMITS.categories},
  {name:'budgets',max:DATA_LIMITS.budgets},
  {name:'entries',max:DATA_LIMITS.entries},
  {name:'attachments',max:DATA_LIMITS.attachments},
  {name:'recurring_rules',max:DATA_LIMITS.recurringRules},
  {name:'recurring_notifications',max:DATA_LIMITS.recurringNotifications},
  {name:'bank_rules',max:DATA_LIMITS.bankRules},
  {name:'bank_import_batches',max:DATA_LIMITS.bankImportBatches},
  {name:'bank_feed_items',max:DATA_LIMITS.bankFeedItems}
];
const DELETE_ORDER=['bank_feed_items','bank_import_batches','bank_rules','recurring_notifications','attachments','recurring_rules','entries','budgets','categories','people','accounts'];
const INSERT_ORDER=['people','accounts','categories','budgets','entries','attachments','recurring_rules','recurring_notifications','bank_rules','bank_import_batches','bank_feed_items'];

function fail(message,status=400){return Object.assign(new Error(message),{status});}
function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
function backupHash(payload){return createHash('sha256').update(canonical(payload)).digest('hex');}
function tableColumns(db,name){return db.prepare(`PRAGMA table_info(${name})`).all().map(r=>r.name);}
function encodeValue(value){
  if(value instanceof Uint8Array||Buffer.isBuffer(value))return {__type:'base64',data:Buffer.from(value).toString('base64')};
  return value;
}
function decodeValue(value){
  if(value&&typeof value==='object'&&value.__type==='base64'){
    const s=String(value.data||'');
    if(!s||s.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(s))throw fail('Invalid backup binary data.');
    const decoded=Buffer.from(s,'base64');
    if(decoded.toString('base64')!==s)throw fail('Invalid backup binary data.');
    return decoded;
  }
  return value;
}

function validCurrency(value){return /^[A-Z]{3,5}$/.test(String(value||''));}
function validDate(value){return /^\d{4}-\d{2}-\d{2}$/.test(String(value||''))&&!Number.isNaN(Date.parse(String(value)+'T00:00:00Z'));}
function validStoredId(value){return typeof value==='string'&&value.length>0&&value.length<=120&&/^[A-Za-z0-9_-]+$/.test(value);}
function safeInt(value,{min=Number.MIN_SAFE_INTEGER,max=Number.MAX_SAFE_INTEGER,nullable=false}={}){
  if(nullable&&(value===null||value===undefined))return true;
  return Number.isSafeInteger(value)&&value>=min&&value<=max;
}
function parseJson(value,label,shape='object'){
  if(typeof value!=='string')throw fail('Invalid '+label+' backup data.');
  let parsed;try{parsed=JSON.parse(value);}catch{throw fail('Invalid '+label+' backup data.');}
  if(shape==='array'&&!Array.isArray(parsed))throw fail('Invalid '+label+' backup data.');
  if(shape==='object'&&(!parsed||typeof parsed!=='object'||Array.isArray(parsed)))throw fail('Invalid '+label+' backup data.');
  return parsed;
}
function validTimeZone(value){
  const zone=String(value||'');
  try{new Intl.DateTimeFormat('en-US',{timeZone:zone}).format(new Date());return zone;}catch{throw fail('Backup timezone is invalid.');}
}
function validateRecord(table,row){
  const requireId=(field='id')=>{if(!validStoredId(row[field]))throw fail('Invalid '+table+' backup data.');};
  switch(table){
    case 'people':
      requireId();
      if(typeof row.name!=='string'||!row.name.trim()||row.name.length>100)throw fail('Invalid people backup data.');
      break;
    case 'accounts':
      requireId();
      if(typeof row.name!=='string'||!row.name.trim()||!['bank','cash','card','wallet','other'].includes(row.type)||!validCurrency(row.currency)||!safeInt(row.opening_balance_minor))throw fail('Invalid accounts backup data.');
      break;
    case 'categories':
      requireId();
      if(typeof row.name!=='string'||!row.name.trim()||!['expense','income','both'].includes(row.kind)||![0,1].includes(row.archived))throw fail('Invalid categories backup data.');
      break;
    case 'budgets':
      requireId();
      if(!validStoredId(row.category_id)||!validCurrency(row.currency)||!safeInt(row.monthly_limit_minor,{min:1}))throw fail('Invalid budgets backup data.');
      break;
    case 'entries': {
      requireId();
      const allowed=new Set(['paid_for_person','received_from_person','borrowed_from_person','paid_to_person','person_adjustment','account_transfer','split_paid_for_people','account_expense','account_income','account_adjustment']);
      if(!allowed.has(row.type)||!safeInt(row.amount_minor,{min:0})||!safeInt(row.from_amount_minor,{nullable:true})||!safeInt(row.to_amount_minor,{nullable:true})||!safeInt(row.signed_amount_minor,{nullable:true})||!validDate(row.date))throw fail('Invalid entries backup data.');
      const splits=parseJson(row.split_json,'entries','array');
      if(splits.some(split=>!split||typeof split!=='object'||!validStoredId(split.personId)||!Number.isSafeInteger(split.amountMinor)))throw fail('Invalid entries backup data.');
      if(row.type!=='account_transfer'&&!validCurrency(row.currency))throw fail('Invalid entries backup data.');
      break;
    }
    case 'attachments':
      requireId();
      if(!validStoredId(row.entry_id)||typeof row.name!=='string'||!row.name||typeof row.mime_type!=='string'||!Buffer.isBuffer(row.data)||!safeInt(row.size_bytes,{min:1,max:8*1024*1024})||row.data.length!==row.size_bytes)throw fail('Invalid attachments backup data.');
      break;
    case 'recurring_rules':
      requireId();
      if(typeof row.title!=='string'||!row.title.trim()||!safeInt(row.interval_value,{min:1,max:1000})||!safeInt(row.remind_days_before,{min:0,max:365})||![0,1].includes(row.is_active)||!validDate(row.anchor_date)||(row.next_due_date!==null&&!validDate(row.next_due_date))||(row.end_date!==null&&!validDate(row.end_date)))throw fail('Invalid recurring_rules backup data.');
      parseJson(row.template_json,'recurring_rules','object');
      break;
    case 'recurring_notifications':
      requireId();
      if(!validStoredId(row.rule_id)||!validDate(row.occurrence_date)||!validDate(row.remind_on_date)||!['pending','acknowledged'].includes(row.status))throw fail('Invalid recurring_notifications backup data.');
      break;
    case 'bank_rules':
      requireId();
      if(typeof row.match_text!=='string'||!row.match_text.trim()||typeof row.classification!=='string'||!row.classification.trim()||!safeInt(row.priority,{min:-100000,max:100000}))throw fail('Invalid bank_rules backup data.');
      break;
    case 'bank_import_batches':
      requireId();
      if(!validStoredId(row.account_id)||!safeInt(row.total_rows,{min:0})||!safeInt(row.imported_rows,{min:0})||!safeInt(row.skipped_rows,{min:0})||!safeInt(row.invalid_rows,{min:0})||row.imported_rows+row.skipped_rows+row.invalid_rows>row.total_rows)throw fail('Invalid bank_import_batches backup data.');
      break;
    case 'bank_feed_items':
      requireId();
      if(!validStoredId(row.account_id)||typeof row.fingerprint!=='string'||!row.fingerprint||!validDate(row.txn_date)||!safeInt(row.signed_amount_minor)||!validCurrency(row.currency)||!['pending','posted','ignored'].includes(row.status))throw fail('Invalid bank_feed_items backup data.');
      break;
  }
}
function validateReferences(clean){
  const people=new Set(clean.people.map(row=>row.id)),accounts=new Set(clean.accounts.map(row=>row.id)),categories=new Set(clean.categories.map(row=>row.id));
  const entries=new Set(clean.entries.map(row=>row.id));
  const has=(set,id)=>id===null||id===undefined||id===''||set.has(id);
  for(const row of clean.budgets)if(!categories.has(row.category_id))throw fail('Backup contains broken category references.');
  for(const row of clean.entries){
    if(!has(people,row.person_id)||!has(accounts,row.account_id)||!has(accounts,row.from_account_id)||!has(accounts,row.to_account_id)||!has(categories,row.category_id))throw fail('Backup contains broken transaction references.');
    const splits=parseJson(row.split_json,'entries','array');
    if(splits.some(split=>!people.has(split.personId)))throw fail('Backup contains broken split references.');
  }
  for(const row of clean.attachments)if(!entries.has(row.entry_id))throw fail('Backup contains broken attachment references.');
  for(const row of clean.recurring_rules){
    const template=parseJson(row.template_json,'recurring_rules','object');
    if(!has(people,template.personId)||!has(accounts,template.accountId)||!has(accounts,template.fromAccountId)||!has(accounts,template.toAccountId)||!has(categories,template.categoryId))throw fail('Backup contains broken recurring references.');
    if(Array.isArray(template.splits)&&template.splits.some(split=>!people.has(split.personId)))throw fail('Backup contains broken recurring split references.');
  }
  // Recurring notifications and Bank Feed history intentionally tolerate stale optional
  // references: their readers use LEFT JOIN/reconciliation so legacy history remains recoverable.
  // Core ledger, attachment, budget and recurring-template references are validated above.
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
    validateRecord(table,out);
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
  const user=db.prepare('SELECT email,display_name AS displayName,default_currency AS defaultCurrency,app_mode AS appMode,timezone,created_at AS createdAt FROM users WHERE id=?').get(userId);
  if(!user)throw fail('Account not found.',404);
  const data={};
  for(const table of TABLES)data[table.name]=rowsFor(db,table.name,userId);
  const payload={
    backupVersion:BACKUP_VERSION,
    app:'money-owed-tracker',
    moneySchemaVersion:1,
    exportedAt:new Date().toISOString(),
    user,
    data
  };
  return {...payload,sha256:backupHash(payload)};
}

export function restoreFullBackup(db,userId,input){
  if(!input||typeof input!=='object'||Number(input.backupVersion)!==BACKUP_VERSION||input.app!=='money-owed-tracker'||Number(input.moneySchemaVersion)!==1)throw fail('That file is not a complete Money Tracker backup.');
  const {sha256,...payload}=input;
  if(!/^[a-f0-9]{64}$/.test(String(sha256||''))||backupHash(payload)!==sha256)throw fail('Backup integrity check failed. The file may be corrupted or modified.');
  const data=input.data;if(!data||typeof data!=='object')throw fail('Backup data is missing.');
  const user=input.user||{},displayName=String(user.displayName||'Money Tracker').trim().slice(0,80)||'Money Tracker',defaultCurrency=String(user.defaultCurrency||'USD').toUpperCase(),appMode=String(user.appMode||'simple'),timezone=validTimeZone(String(user.timezone||'UTC').slice(0,100));
  if(!validCurrency(defaultCurrency))throw fail('Backup default currency is invalid.');
  if(!['simple','advanced'].includes(appMode))throw fail('Backup app mode is invalid.');
  const clean={};
  for(const table of TABLES)clean[table.name]=validateRows(db,table.name,data[table.name]??[],userId,table.max);
  validateReferences(clean);
  const attachmentBytes=clean.attachments.reduce((sum,row)=>sum+(row.data?.length||0),0);
  if(attachmentBytes>DATA_LIMITS.attachmentBytes)throw fail(`Backup attachments exceed the ${Math.floor(DATA_LIMITS.attachmentBytes/1024/1024)} MB storage limit.`,413);

  db.exec('BEGIN IMMEDIATE');
  try{
    for(const table of DELETE_ORDER)db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
    for(const table of INSERT_ORDER)insertRows(db,table,clean[table]);
    const updated=db.prepare('UPDATE users SET display_name=?,default_currency=?,app_mode=?,timezone=?,revision=revision+1 WHERE id=?').run(displayName,defaultCurrency,appMode,timezone,userId);
    if(Number(updated.changes)!==1)throw fail('Account not found.',404);
    const fk=db.prepare('PRAGMA foreign_key_check').all();
    if(fk.length)throw fail('Backup contains broken references.');
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return {ok:true};
}

export {BACKUP_VERSION,DATA_LIMITS};
