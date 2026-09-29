import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseWorkbook } from './lib/xlsx-import.js';
import { nextRecurringDate } from './lib/recurring.js';
import { createRecurringReminderService, safeTimeZone } from './lib/recurring-worker.js';
import { createBankFeedService } from './lib/bank-server.js';
import { createInsightsService } from './lib/insights-server.js';
import { createDatabaseSnapshot } from './lib/db-snapshot.js';
import { exportFullBackup, restoreFullBackup } from './lib/full-backup.js';
import { normalizeMoney, toMinor } from './lib/money.js';
import { accountFromStorage, accountToStorage, ensureCoreExactMoneySchema, entryFromStorage, entryToStorage, exactMoneySchemaVersion, markExactMoneySchema, templateFromStorage, templateToStorage } from './lib/money-storage.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || join(DATA_DIR, 'ledger.sqlite');
const SESSION_DAYS = 30;
const BODY_LIMIT = 1_000_000;
const ATTACHMENT_BODY_LIMIT = 12_000_000;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set(['image/jpeg','image/png','image/webp','image/gif','application/pdf','text/plain']);
const isProd = process.env.NODE_ENV === 'production';

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT 'My Ledger',
  password_hash TEXT NOT NULL,
  default_currency TEXT NOT NULL DEFAULT 'USD',
  app_mode TEXT NOT NULL DEFAULT 'simple',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  is_owner INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limits (
  key_hash TEXT PRIMARY KEY,
  window_start_ms INTEGER NOT NULL,
  count INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS people (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS accounts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  currency TEXT NOT NULL,
  opening_balance_minor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS entries (
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, person_id) REFERENCES people(user_id, id),
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id),
  FOREIGN KEY (user_id, from_account_id) REFERENCES accounts(user_id, id),
  FOREIGN KEY (user_id, to_account_id) REFERENCES accounts(user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries(user_id, date, created_at);
CREATE INDEX IF NOT EXISTS idx_entries_user_person ON entries(user_id, person_id);
CREATE INDEX IF NOT EXISTS idx_entries_user_account ON entries(user_id, account_id);
CREATE TABLE IF NOT EXISTS attachments (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_attachments_user_entry ON attachments(user_id, entry_id);
CREATE TABLE IF NOT EXISTS recurring_rules (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  frequency TEXT NOT NULL,
  interval_value INTEGER NOT NULL DEFAULT 1,
  anchor_date TEXT NOT NULL,
  next_due_date TEXT,
  end_date TEXT,
  remind_days_before INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  template_json TEXT NOT NULL,
  last_posted_at TEXT,
  last_occurrence_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_recurring_user_due ON recurring_rules(user_id, is_active, next_due_date);
`);
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(row => row.name));
if (!userColumns.has('is_owner')) db.exec("ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0");
if (!userColumns.has('app_mode')) db.exec("ALTER TABLE users ADD COLUMN app_mode TEXT NOT NULL DEFAULT 'simple'");
if (!userColumns.has('timezone')) db.exec("ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'");
const ownerCount = Number(db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_owner=1').get()?.count || 0);
if (!ownerCount) db.prepare("UPDATE users SET is_owner=1 WHERE id=(SELECT id FROM users ORDER BY created_at LIMIT 1)").run();

const entryColumns = new Set(db.prepare('PRAGMA table_info(entries)').all().map(row => row.name));
if (!entryColumns.has('split_json')) db.exec("ALTER TABLE entries ADD COLUMN split_json TEXT NOT NULL DEFAULT '[]'");
if (!entryColumns.has('category_id')) db.exec("ALTER TABLE entries ADD COLUMN category_id TEXT");
ensureCoreExactMoneySchema(db);

const insights = createInsightsService(db);

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id,email,display_name,default_currency,app_mode,timezone,is_owner AS isOwner,revision,created_at FROM users WHERE id = ?'),
  userCount: db.prepare('SELECT COUNT(*) AS count FROM users'),
  managedUsers: db.prepare('SELECT id,email,is_owner AS isOwner,created_at AS createdAt FROM users ORDER BY created_at'),
  createUser: db.prepare('INSERT INTO users(id,email,display_name,password_hash,default_currency,is_owner,revision,created_at) VALUES(?,?,?,?,?,?,1,?)'),
  sessionByHash: db.prepare(`SELECT s.token_hash,s.csrf_token,s.expires_at,u.id AS user_id,u.email,u.display_name,u.default_currency,u.app_mode,u.timezone,u.is_owner,u.revision
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`),
  insertSession: db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash=?'),
  cleanupSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id=?'),
  userSecret: db.prepare('SELECT id,email,password_hash,is_owner AS isOwner FROM users WHERE id=?'),
  updatePassword: db.prepare('UPDATE users SET password_hash=? WHERE id=?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id=?'),
  otherUserCount: db.prepare('SELECT COUNT(*) AS count FROM users WHERE id<>?'),
  rateLimitUpsert: db.prepare(`INSERT INTO rate_limits(key_hash,window_start_ms,count,updated_at) VALUES(?,?,1,?)
    ON CONFLICT(key_hash) DO UPDATE SET
      count=CASE WHEN excluded.window_start_ms-rate_limits.window_start_ms>=? THEN 1 ELSE rate_limits.count+1 END,
      window_start_ms=CASE WHEN excluded.window_start_ms-rate_limits.window_start_ms>=? THEN excluded.window_start_ms ELSE rate_limits.window_start_ms END,
      updated_at=excluded.updated_at`),
  rateLimitRead: db.prepare('SELECT window_start_ms AS windowStartMs,count FROM rate_limits WHERE key_hash=?'),
  cleanupRateLimits: db.prepare('DELETE FROM rate_limits WHERE updated_at < ?'),
  people: db.prepare('SELECT id,name,note,created_at AS createdAt FROM people WHERE user_id=? ORDER BY name COLLATE NOCASE'),
  personById: db.prepare('SELECT id,name,note,created_at AS createdAt FROM people WHERE user_id=? AND id=?'),
  personCount: db.prepare('SELECT COUNT(*) AS count FROM people WHERE user_id=?'),
  updatePerson: db.prepare('UPDATE people SET name=?,note=? WHERE user_id=? AND id=?'),
  deletePersonRow: db.prepare('DELETE FROM people WHERE user_id=? AND id=?'),
  accounts: db.prepare('SELECT id,name,type,currency,opening_balance_minor AS openingBalanceMinor,created_at AS createdAt FROM accounts WHERE user_id=? ORDER BY created_at'),
  accountById: db.prepare('SELECT id,name,type,currency,opening_balance_minor AS openingBalanceMinor,created_at AS createdAt FROM accounts WHERE user_id=? AND id=?'),
  accountCount: db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE user_id=?'),
  updateAccount: db.prepare('UPDATE accounts SET name=?,type=?,opening_balance_minor=? WHERE user_id=? AND id=?'),
  deleteAccountRow: db.prepare('DELETE FROM accounts WHERE user_id=? AND id=?'),
  entries: db.prepare(`SELECT id,type,person_id AS personId,account_id AS accountId,from_account_id AS fromAccountId,to_account_id AS toAccountId,
    amount_minor AS amountMinor,currency,from_amount_minor AS fromAmountMinor,to_amount_minor AS toAmountMinor,signed_amount_minor AS signedAmountMinor,date,merchant,description,category_id AS categoryId,split_json AS splitJson,created_at AS createdAt,updated_at AS updatedAt
    FROM entries WHERE user_id=? ORDER BY date, created_at`),
  deleteEntries: db.prepare('DELETE FROM entries WHERE user_id=?'),
  deletePeople: db.prepare('DELETE FROM people WHERE user_id=?'),
  deleteAccounts: db.prepare('DELETE FROM accounts WHERE user_id=?'),
  insertPerson: db.prepare('INSERT INTO people(user_id,id,name,note,created_at) VALUES(?,?,?,?,?)'),
  insertAccount: db.prepare('INSERT INTO accounts(user_id,id,name,type,currency,opening_balance_minor,created_at) VALUES(?,?,?,?,?,?,?)'),
  insertEntry: db.prepare(`INSERT INTO entries(user_id,id,type,person_id,account_id,from_account_id,to_account_id,amount_minor,currency,from_amount_minor,to_amount_minor,signed_amount_minor,date,merchant,description,category_id,split_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  updateEntry: db.prepare(`UPDATE entries SET type=?,person_id=?,account_id=?,from_account_id=?,to_account_id=?,amount_minor=?,currency=?,from_amount_minor=?,to_amount_minor=?,signed_amount_minor=?,date=?,merchant=?,description=?,category_id=?,split_json=?,updated_at=? WHERE user_id=? AND id=?`),
  deleteEntry: db.prepare('DELETE FROM entries WHERE user_id=? AND id=?'),
  entryCount: db.prepare('SELECT COUNT(*) AS count FROM entries WHERE user_id=?'),
  entryExists: db.prepare('SELECT id FROM entries WHERE user_id=? AND id=?'),
  attachmentCounts: db.prepare('SELECT entry_id AS entryId, COUNT(*) AS count FROM attachments WHERE user_id=? GROUP BY entry_id'),
  attachmentsForEntry: db.prepare('SELECT id,entry_id AS entryId,name,mime_type AS mimeType,size_bytes AS sizeBytes,created_at AS createdAt FROM attachments WHERE user_id=? AND entry_id=? ORDER BY created_at'),
  attachmentById: db.prepare('SELECT id,entry_id AS entryId,name,mime_type AS mimeType,size_bytes AS sizeBytes,data,created_at AS createdAt FROM attachments WHERE user_id=? AND id=?'),
  insertAttachment: db.prepare('INSERT INTO attachments(user_id,id,entry_id,name,mime_type,size_bytes,data,created_at) VALUES(?,?,?,?,?,?,?,?)'),
  deleteAttachment: db.prepare('DELETE FROM attachments WHERE user_id=? AND id=?'),
  deleteEntryAttachments: db.prepare('DELETE FROM attachments WHERE user_id=? AND entry_id=?'),
  deleteOrphanAttachments: db.prepare('DELETE FROM attachments WHERE user_id=? AND entry_id NOT IN (SELECT id FROM entries WHERE user_id=?)'),
  deleteAttachments: db.prepare('DELETE FROM attachments WHERE user_id=?'),
  recurringRules: db.prepare('SELECT id,title,frequency,interval_value AS interval,anchor_date AS anchorDate,next_due_date AS nextDueDate,end_date AS endDate,remind_days_before AS remindDaysBefore,is_active AS isActive,template_json AS templateJson,last_posted_at AS lastPostedAt,last_occurrence_date AS lastOccurrenceDate,created_at AS createdAt,updated_at AS updatedAt FROM recurring_rules WHERE user_id=? ORDER BY CASE WHEN next_due_date IS NULL THEN 1 ELSE 0 END,next_due_date,title COLLATE NOCASE'),
  recurringRuleById: db.prepare('SELECT id,title,frequency,interval_value AS interval,anchor_date AS anchorDate,next_due_date AS nextDueDate,end_date AS endDate,remind_days_before AS remindDaysBefore,is_active AS isActive,template_json AS templateJson,last_posted_at AS lastPostedAt,last_occurrence_date AS lastOccurrenceDate,created_at AS createdAt,updated_at AS updatedAt FROM recurring_rules WHERE user_id=? AND id=?'),
  recurringCount: db.prepare('SELECT COUNT(*) AS count FROM recurring_rules WHERE user_id=?'),
  insertRecurring: db.prepare('INSERT INTO recurring_rules(user_id,id,title,frequency,interval_value,anchor_date,next_due_date,end_date,remind_days_before,is_active,template_json,last_posted_at,last_occurrence_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
  updateRecurring: db.prepare('UPDATE recurring_rules SET title=?,frequency=?,interval_value=?,anchor_date=?,next_due_date=?,end_date=?,remind_days_before=?,is_active=?,template_json=?,updated_at=? WHERE user_id=? AND id=?'),
  deleteRecurring: db.prepare('DELETE FROM recurring_rules WHERE user_id=? AND id=?'),
  advanceRecurring: db.prepare('UPDATE recurring_rules SET next_due_date=?,is_active=?,last_posted_at=?,last_occurrence_date=?,updated_at=? WHERE user_id=? AND id=? AND next_due_date=?'),
  updateUserState: db.prepare('UPDATE users SET display_name=?,default_currency=?,app_mode=?,timezone=?,revision=revision+1 WHERE id=? AND revision=?'),
  updateUserSettingsValues: db.prepare('UPDATE users SET display_name=?,default_currency=?,app_mode=?,timezone=? WHERE id=?'),
  bumpRevision: db.prepare('UPDATE users SET revision=revision+1 WHERE id=? AND revision=?'),
  deleteAllData: db.prepare('DELETE FROM entries WHERE user_id=?'),
  deleteAllRecurring: db.prepare('DELETE FROM recurring_rules WHERE user_id=?'),
};

const bankFeed = createBankFeedService(db);
const recurringReminders = createRecurringReminderService(db);
markExactMoneySchema(db);
console.log('EXACT_MONEY_READY '+JSON.stringify({version:exactMoneySchemaVersion(db),storage:'integer-minor-units'}));
console.log('LANE_A_READY '+JSON.stringify({waves:[2,3,4,5],ledgerApiVersion:1,fullBackupVersion:2,durableRateLimits:true}));
console.log('LANE_B_READY '+JSON.stringify({waves:[6,8,9,10],appModes:true,serverRecurringReminders:true,bankFeedHistory:true,reportingVersion:2}));

if (process.env.WAVE0_BACKUP_ON_START === '1') {
  const snapshot=createDatabaseSnapshot(db,{dataDir:DATA_DIR,dbPath:DB_PATH,label:'wave0-pre-exact-money'});
  console.log('WAVE0_BACKUP_CREATED '+JSON.stringify({
    snapshotFile:snapshot.snapshotFile,
    bytes:snapshot.bytes,
    sha256:snapshot.sha256,
    schemaSha256:snapshot.schemaSha256
  }));
}

function nowIso() { return new Date().toISOString(); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function safeStr(value, max=180) { return String(value ?? '').trim().slice(0,max); }
function validCurrency(v) { return /^[A-Z]{3,5}$/.test(String(v || '')); }
function validDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)); }
function finite(v) { const n=Number(v); return Number.isFinite(n) ? n : null; }
function exactMoney(v,currency,options={}) {
  try{return normalizeMoney(v,currency,options);}
  catch(error){throw new Error(error.message||'Invalid money amount.');}
}
function idOk(v, prefix) { return typeof v === 'string' && v.startsWith(`${prefix}_`) && v.length <= 80 && /^[a-zA-Z0-9_-]+$/.test(v); }

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
function verifyPassword(password, stored) {
  try {
    const [kind,salt64,hash64] = String(stored).split('$');
    if (kind !== 'scrypt') return false;
    const expected = Buffer.from(hash64, 'base64url');
    const actual = scryptSync(password, Buffer.from(salt64, 'base64url'), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}
function cookie(token, maxAge=SESSION_DAYS*86400) {
  return `mot_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isProd ? '; Secure' : ''}`;
}
function clearCookie() { return `mot_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? '; Secure' : ''}`; }
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (isProd) res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
}
function json(res, status, value, extra={}) {
  securityHeaders(res); Object.entries(extra).forEach(([k,v])=>res.setHeader(k,v));
  const body = JSON.stringify(value); res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(body);
}
function fail(res,status,message){ json(res,status,{error:message}); }
async function bodyJson(req, limit=BODY_LIMIT) {
  return await new Promise((resolve,reject)=>{
    const chunks=[]; let size=0;
    req.on('data',c=>{ size+=c.length; if(size>limit){reject(Object.assign(new Error('Request is too large.'),{status:413})); req.destroy(); return;} chunks.push(c); });
    req.on('end',()=>{ try{ resolve(chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{}); }catch{ reject(Object.assign(new Error('invalid json'),{status:400})); } });
    req.on('error',reject);
  });
}
function createSession(userId) {
  q.cleanupSessions.run(nowIso());
  const token=randomBytes(32).toString('base64url');
  const csrf=randomBytes(24).toString('base64url');
  const expires=new Date(Date.now()+SESSION_DAYS*86400_000).toISOString();
  q.insertSession.run(sha256(token),userId,csrf,expires,nowIso());
  return {token,csrf,expires};
}
function auth(req) {
  const token=parseCookies(req).mot_session; if(!token) return null;
  const row=q.sessionByHash.get(sha256(token)); if(!row) return null;
  if(row.expires_at < nowIso()){ q.deleteSession.run(row.token_hash); return null; }
  return row;
}
function requireAuth(req,res,{csrf=false}={}) {
  const a=auth(req); if(!a){fail(res,401,'Sign in required.'); return null;}
  if(csrf && req.headers['x-csrf-token'] !== a.csrf_token){fail(res,403,'Security token mismatch. Refresh and try again.'); return null;}
  return a;
}

function requestIp(req){
  return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();
}
function rateLimited(req,scope='auth',{limit=30,windowMs=10*60_000}={}) {
  const now=Date.now(),key=sha256(scope+'|'+requestIp(req)),stamp=nowIso();
  q.rateLimitUpsert.run(key,now,stamp,windowMs,windowMs);
  const row=q.rateLimitRead.get(key);
  if(Number(row?.count||0)===1)q.cleanupRateLimits.run(new Date(Date.now()-24*60*60_000).toISOString());
  return Number(row?.count||0)>limit;
}

function validateState(input, user) {
  if(!input || typeof input!=='object') throw new Error('Invalid state.');
  const settings=input.settings||{};
  const displayName=safeStr(settings.displayName || user.display_name || 'My Ledger',80) || 'My Ledger';
  const defaultCurrency=String(settings.defaultCurrency||user.default_currency||'USD').toUpperCase();
  const appMode=['simple','advanced'].includes(String(settings.appMode||user.app_mode||'simple'))?String(settings.appMode||user.app_mode||'simple'):'simple';
  const timezone=safeTimeZone(settings.timezone||user.timezone||'UTC');
  if(!validCurrency(defaultCurrency)) throw new Error('Invalid default currency.');
  const people=Array.isArray(input.people)?input.people:[];
  const accounts=Array.isArray(input.accounts)?input.accounts:[];
  const entries=Array.isArray(input.entries)?input.entries:[];
  if(people.length>10000||accounts.length>1000||entries.length>50000) throw new Error('Ledger is too large.');
  const pSeen=new Set(), aSeen=new Set(), eSeen=new Set();
  const cleanPeople=people.map(p=>{
    if(!idOk(p.id,'person')||pSeen.has(p.id)) throw new Error('Invalid person record.'); pSeen.add(p.id);
    const name=safeStr(p.name,100); if(!name) throw new Error('Every person needs a name.');
    return {id:p.id,name,note:safeStr(p.note,1000),createdAt:p.createdAt||nowIso()};
  });
  const allowedAccountTypes=new Set(['bank','cash','card','wallet','other']);
  const cleanAccounts=accounts.map(a=>{
    if(!idOk(a.id,'account')||aSeen.has(a.id)) throw new Error('Invalid account record.'); aSeen.add(a.id);
    const name=safeStr(a.name,100), type=String(a.type||'other'), currency=String(a.currency||defaultCurrency).toUpperCase();
    if(!name||!allowedAccountTypes.has(type)||!validCurrency(currency)) throw new Error('Invalid account record.');
    const openingBalance=exactMoney(a.openingBalance??0,currency);
    return {id:a.id,name,type,currency,openingBalance,createdAt:a.createdAt||nowIso()};
  });
  const allowedTypes=new Set(['paid_for_person','received_from_person','borrowed_from_person','paid_to_person','person_adjustment','account_transfer','split_paid_for_people','account_expense','account_income']);
  const accountById=new Map(cleanAccounts.map(a=>[a.id,a]));
  const cleanEntries=entries.map(e=>{
    if(!idOk(e.id,'entry')||eSeen.has(e.id)||!allowedTypes.has(e.type)) throw new Error('Invalid transaction record.'); eSeen.add(e.id);
    const amount=finite(e.amount);
    if(amount===null||amount<0) throw new Error('Invalid transaction amount.');
    const base={
      id:e.id,type:e.type,personId:e.personId||null,accountId:e.accountId||null,fromAccountId:e.fromAccountId||null,toAccountId:e.toAccountId||null,
      amount,currency:e.currency?String(e.currency).toUpperCase():null,
      fromAmount:e.fromAmount==null?null:finite(e.fromAmount),toAmount:e.toAmount==null?null:finite(e.toAmount),signedAmount:e.signedAmount==null?null:finite(e.signedAmount),
      date:String(e.date||''),merchant:safeStr(e.merchant,100),description:safeStr(e.description,500),categoryId:e.categoryId||null,splits:[],
      createdAt:e.createdAt||nowIso(),updatedAt:e.updatedAt||nowIso()
    };
    if(!validDate(base.date)) throw new Error('Invalid transaction date.');
    if(e.type==='account_transfer'){
      const from=accountById.get(base.fromAccountId),to=accountById.get(base.toAccountId);
      if(!from||!to||base.fromAccountId===base.toAccountId||!(base.fromAmount>0)||!(base.toAmount>0)) throw new Error('Invalid account transfer.');
      base.fromAmount=exactMoney(base.fromAmount,from.currency,{allowNegative:false,allowZero:false});
      base.toAmount=exactMoney(base.toAmount,to.currency,{allowNegative:false,allowZero:false});
      base.personId=null;base.accountId=null;base.currency=null;base.signedAmount=null;base.amount=base.fromAmount;base.categoryId=null;
    } else if(e.type==='split_paid_for_people'){
      if(!(amount>0)) throw new Error('Split transaction amount is missing.');
      if(base.accountId&&!aSeen.has(base.accountId)) throw new Error('Split transaction account is invalid.');
      if(base.accountId)base.currency=accountById.get(base.accountId).currency;
      else if(!validCurrency(base.currency))throw new Error('Split transaction currency is missing.');
      base.amount=exactMoney(amount,base.currency,{allowNegative:false,allowZero:false});
      const source=Array.isArray(e.splits)?e.splits:[];
      if(source.length<2||source.length>100) throw new Error('A split needs at least two people.');
      const seenPeople=new Set(); let splitTotalMinor=0;
      base.splits=source.map(split=>{
        const personId=String(split?.personId||'');
        if(!pSeen.has(personId)||seenPeople.has(personId)) throw new Error('Invalid split allocation.');
        seenPeople.add(personId);
        const splitAmount=exactMoney(split?.amount,base.currency,{allowNegative:false,allowZero:false});
        splitTotalMinor+=toMinor(splitAmount,base.currency);
        if(!Number.isSafeInteger(splitTotalMinor))throw new Error('Split total is too large to store safely.');
        return {personId,amount:splitAmount,note:safeStr(split?.note,180)};
      });
      if(splitTotalMinor!==toMinor(base.amount,base.currency)) throw new Error('Split amounts must equal the transaction total.');
      base.personId=null;base.signedAmount=null;base.fromAccountId=null;base.toAccountId=null;base.fromAmount=null;base.toAmount=null;base.categoryId=null;
    } else if(e.type==='account_expense'||e.type==='account_income'){
      const account=accountById.get(base.accountId);
      if(!account||!(amount>0)) throw new Error('Account-only transaction account is missing.');
      if(base.categoryId) insights.validateCategory(user.user_id,base.categoryId,{kind:e.type==='account_income'?'income':'expense'});
      base.personId=null;base.currency=account.currency;base.amount=exactMoney(amount,base.currency,{allowNegative:false,allowZero:false});base.signedAmount=null;
      base.fromAccountId=null;base.toAccountId=null;base.fromAmount=null;base.toAmount=null;
    } else {
      if(!pSeen.has(base.personId)) throw new Error('Transaction person is missing.');
      if(e.type==='person_adjustment'){
        base.accountId=null;
        if(!(amount>0)||base.signedAmount===null||!validCurrency(base.currency)) throw new Error('Invalid balance adjustment.');
        base.amount=exactMoney(amount,base.currency,{allowNegative:false,allowZero:false});
        base.signedAmount=exactMoney(base.signedAmount,base.currency,{allowZero:false});
        if(Math.abs(toMinor(base.signedAmount,base.currency))!==toMinor(base.amount,base.currency))throw new Error('Invalid balance adjustment.');
      } else {
        if(!(amount>0)) throw new Error('Transaction amount is missing.');
        if(base.accountId){
          const account=accountById.get(base.accountId);if(!account)throw new Error('Transaction account is invalid.');
          base.currency=account.currency;
        } else if(!validCurrency(base.currency)) throw new Error('Transaction currency is missing.');
        base.amount=exactMoney(amount,base.currency,{allowNegative:false,allowZero:false});
        base.signedAmount=null;
      }
      base.fromAccountId=null;base.toAccountId=null;base.fromAmount=null;base.toAmount=null;base.categoryId=null;
    }
    return base;
  });
  return {settings:{displayName,defaultCurrency,appMode,timezone},people:cleanPeople,accounts:cleanAccounts,entries:cleanEntries};
}

const RECURRING_TYPES = new Set(['paid_for_person','received_from_person','borrowed_from_person','paid_to_person','person_adjustment','account_transfer','split_paid_for_people','account_expense','account_income']);
const RECURRING_FREQUENCIES = new Set(['daily','weekly','monthly','yearly']);

function accountCurrencyMap(userId) {
  return new Map(q.accounts.all(userId).map(row=>[row.id,row]));
}

function recurringRow(row,userId) {
  if(!row) return null;
  let stored={}; try{stored=JSON.parse(row.templateJson||'{}');}catch{}
  const template=templateFromStorage(stored,accountCurrencyMap(userId));
  const {templateJson,...rest}=row;
  return {...rest,isActive:!!row.isActive,template};
}

function loadRecurringRules(userId) {
  return q.recurringRules.all(userId).map(row=>recurringRow(row,userId));
}

function cleanRecurringTemplate(raw,userId,defaultCurrency='USD') {
  if(!raw || typeof raw!=='object' || !RECURRING_TYPES.has(raw.type)) throw new Error('Choose a valid recurring transaction type.');
  const people=new Set(q.people.all(userId).map(row=>row.id));
  const accountById=accountCurrencyMap(userId);
  const amount=finite(raw.amount);
  const base={
    type:raw.type,personId:raw.personId||null,accountId:raw.accountId||null,fromAccountId:raw.fromAccountId||null,toAccountId:raw.toAccountId||null,
    amount,currency:raw.currency?String(raw.currency).toUpperCase():null,
    fromAmount:raw.fromAmount==null?null:finite(raw.fromAmount),toAmount:raw.toAmount==null?null:finite(raw.toAmount),signedAmount:raw.signedAmount==null?null:finite(raw.signedAmount),
    merchant:safeStr(raw.merchant,100),description:safeStr(raw.description,500),categoryId:raw.categoryId||null,splits:[]
  };
  if(amount===null || amount<0) throw new Error('Invalid recurring amount.');
  if(raw.type==='account_transfer'){
    const from=accountById.get(base.fromAccountId),to=accountById.get(base.toAccountId);
    if(!from||!to||base.fromAccountId===base.toAccountId||!(base.fromAmount>0)||!(base.toAmount>0)) throw new Error('Choose two different accounts and valid transfer amounts.');
    base.fromAmount=exactMoney(base.fromAmount,from.currency,{allowNegative:false,allowZero:false});
    base.toAmount=exactMoney(base.toAmount,to.currency,{allowNegative:false,allowZero:false});
    base.personId=null;base.accountId=null;base.currency=null;base.signedAmount=null;base.amount=base.fromAmount;base.categoryId=null;
  } else if(raw.type==='split_paid_for_people'){
    if(!(amount>0)) throw new Error('Choose an amount for the recurring split.');
    if(base.accountId&&!accountById.has(base.accountId)) throw new Error('Choose a valid account or leave it blank.');
    base.currency=base.accountId?accountById.get(base.accountId).currency:String(base.currency||defaultCurrency).toUpperCase();
    if(!validCurrency(base.currency))throw new Error('Choose a valid currency.');
    base.amount=exactMoney(amount,base.currency,{allowNegative:false,allowZero:false});
    const source=Array.isArray(raw.splits)?raw.splits:[];
    if(source.length<2||source.length>100) throw new Error('A recurring split needs at least two people.');
    const seen=new Set();let totalMinor=0;
    base.splits=source.map(split=>{
      const personId=String(split?.personId||'');
      if(!people.has(personId)||seen.has(personId)) throw new Error('Invalid recurring split allocation.');
      seen.add(personId);
      const splitAmount=exactMoney(split?.amount,base.currency,{allowNegative:false,allowZero:false});
      totalMinor+=toMinor(splitAmount,base.currency);if(!Number.isSafeInteger(totalMinor))throw new Error('Recurring split total is too large.');
      return {personId,amount:splitAmount,note:safeStr(split?.note,180)};
    });
    if(totalMinor!==toMinor(base.amount,base.currency)) throw new Error('Recurring split amounts must equal the total.');
    base.personId=null;base.signedAmount=null;base.fromAccountId=null;base.toAccountId=null;base.fromAmount=null;base.toAmount=null;base.categoryId=null;
  } else if(raw.type==='account_expense'||raw.type==='account_income'){
    const account=accountById.get(base.accountId);
    if(!account||!(amount>0)) throw new Error('Choose an account and amount for the recurring transaction.');
    if(base.categoryId) insights.validateCategory(userId,base.categoryId,{kind:raw.type==='account_income'?'income':'expense',active:true});
    base.personId=null;base.currency=account.currency;base.amount=exactMoney(amount,base.currency,{allowNegative:false,allowZero:false});base.signedAmount=null;
    base.fromAccountId=null;base.toAccountId=null;base.fromAmount=null;base.toAmount=null;
  } else {
    if(!people.has(base.personId)) throw new Error('Choose a person for the recurring transaction.');
    if(raw.type==='person_adjustment'){
      base.accountId=null;base.currency=String(base.currency||defaultCurrency).toUpperCase();
      if(!(amount>0)||base.signedAmount===null||!validCurrency(base.currency)) throw new Error('Invalid recurring balance adjustment.');
      base.amount=exactMoney(amount,base.currency,{allowNegative:false,allowZero:false});
      base.signedAmount=exactMoney(base.signedAmount,base.currency,{allowZero:false});
      if(Math.abs(toMinor(base.signedAmount,base.currency))!==toMinor(base.amount,base.currency))throw new Error('Invalid recurring balance adjustment.');
    } else {
      if(!(amount>0)) throw new Error('Choose an amount for the recurring transaction.');
      if(base.accountId){
        const account=accountById.get(base.accountId);if(!account) throw new Error('Choose a valid account or leave it blank.');
        base.currency=account.currency;
      }else{
        base.currency=String(base.currency||defaultCurrency).toUpperCase();if(!validCurrency(base.currency))throw new Error('Choose a valid currency.');
      }
      base.amount=exactMoney(amount,base.currency,{allowNegative:false,allowZero:false});base.signedAmount=null;
    }
    base.fromAccountId=null;base.toAccountId=null;base.fromAmount=null;base.toAmount=null;base.categoryId=null;
  }
  return base;
}

function cleanRecurringRule(input,userId,defaultCurrency='USD',{existing=null}={}) {
  if(!input || typeof input!=='object') throw new Error('Invalid recurring schedule.');
  const id=existing?.id || (idOk(input.id,'rule')?input.id:'rule_'+randomUUID());
  if(!idOk(id,'rule')) throw new Error('Invalid recurring schedule id.');
  const title=safeStr(input.title,100); if(!title) throw new Error('Give this schedule a name.');
  const frequency=String(input.frequency||'monthly');
  const interval=Number(input.interval||1);
  if(!RECURRING_FREQUENCIES.has(frequency)||!Number.isInteger(interval)||interval<1||interval>99) throw new Error('Choose a valid recurring frequency.');
  const nextDueDate=input.nextDueDate==null||input.nextDueDate===''?null:String(input.nextDueDate);
  if(nextDueDate!==null&&!validDate(nextDueDate)) throw new Error('Choose a valid next due date.');
  const isActive=input.isActive!==false;
  if(isActive&&!nextDueDate) throw new Error('Active schedules need a next due date.');
  const anchorDate=String(input.anchorDate||nextDueDate||existing?.anchorDate||'');
  if(!validDate(anchorDate)) throw new Error('Choose a valid recurrence anchor date.');
  const endDate=input.endDate?String(input.endDate):null;
  if(endDate&&!validDate(endDate)) throw new Error('Choose a valid end date.');
  if(isActive&&nextDueDate&&endDate&&endDate<nextDueDate) throw new Error('End date cannot be before the next due date.');
  const remindDaysBefore=Number(input.remindDaysBefore||0);
  if(!Number.isInteger(remindDaysBefore)||remindDaysBefore<0||remindDaysBefore>30) throw new Error('Reminder lead time must be between 0 and 30 days.');
  const template=cleanRecurringTemplate(input.template,userId,defaultCurrency);
  return {id,title,frequency,interval,anchorDate,nextDueDate,endDate,remindDaysBefore,isActive,template};
}

function assertRecurringReferences(userId,cleanState) {
  const people=new Set(cleanState.people.map(row=>row.id));
  const accounts=new Set(cleanState.accounts.map(row=>row.id));
  const categories=new Set(insights.list(userId).categories.map(row=>row.id));
  for(const rule of loadRecurringRules(userId)){
    const t=rule.template||{};
    const personIds=t.type==='split_paid_for_people'?(t.splits||[]).map(split=>split.personId):(t.personId?[t.personId]:[]);
    const accountIds=[t.accountId,t.fromAccountId,t.toAccountId].filter(Boolean);
    if(personIds.some(id=>!people.has(id))||accountIds.some(id=>!accounts.has(id))) throw new Error('A recurring schedule still uses a person or account you are trying to delete. Update or delete that schedule first.');
    if(t.categoryId&&!categories.has(t.categoryId))throw new Error('A recurring schedule still uses a category missing from this backup. Restore that category or update the schedule first.');
  }
}

function recurringEntryFromTemplate(template,date) {
  const stamp=nowIso();
  return {id:'entry_'+randomUUID(),...template,date,createdAt:stamp,updatedAt:stamp};
}

function insertLedgerEntry(userId,e) {
  const storage=entryToStorage(e,accountCurrencyMap(userId));
  q.insertEntry.run(userId,e.id,e.type,e.personId,e.accountId,e.fromAccountId,e.toAccountId,storage.amountMinor,e.currency,storage.fromAmountMinor,storage.toAmountMinor,storage.signedAmountMinor,e.date,e.merchant,e.description,e.categoryId||null,storage.splitJson,e.createdAt,e.updatedAt);
}

function advanceRecurringRule(userId,row,occurrenceDate,{posted=false}={}) {
  if(!row?.nextDueDate||row.nextDueDate!==occurrenceDate) throw Object.assign(new Error('This schedule already moved to another occurrence. Refresh and try again.'),{status:409});
  const next=nextRecurringDate(occurrenceDate,row.frequency,row.interval,row.anchorDate);
  const complete=!!row.endDate && next>row.endDate;
  const stamp=nowIso();
  const result=q.advanceRecurring.run(complete?null:next,complete?0:1,posted?stamp:row.lastPostedAt||null,posted?occurrenceDate:row.lastOccurrenceDate||null,stamp,userId,row.id,occurrenceDate);
  if(Number(result.changes)!==1) throw Object.assign(new Error('This schedule changed in another tab. Refresh and try again.'),{status:409});
}

function loadState(userId) {
  const u=q.userById.get(userId); if(!u) return null;
  insights.ensureDefaults(userId);
  const counts=new Map(q.attachmentCounts.all(userId).map(row=>[row.entryId,Number(row.count||0)]));
  const accounts=q.accounts.all(userId).map(accountFromStorage);
  const accountById=new Map(accounts.map(row=>[row.id,row]));
  const entries=q.entries.all(userId).map(row=>{
    const api=entryFromStorage(row,accountById);
    const {splitJson,amountMinor,fromAmountMinor,toAmountMinor,signedAmountMinor,...entry}=api;
    return {...entry,attachmentCount:counts.get(row.id)||0};
  });
  const meta=insights.list(userId);
  return {version:u.revision,settings:{displayName:u.display_name,defaultCurrency:u.default_currency,appMode:u.app_mode||'simple',timezone:u.timezone||'UTC'},people:q.people.all(userId),accounts,entries,categories:meta.categories,budgets:meta.budgets};
}

function saveState(user, input) {
  const expected=Number(input.version); if(!Number.isInteger(expected)) throw Object.assign(new Error('Missing ledger version.'),{status:400});
  let clean; try{clean=validateState(input,user);assertRecurringReferences(user.user_id,clean);}catch(error){throw Object.assign(error,{status:400});}
  db.exec('BEGIN IMMEDIATE');
  try{
    const upd=q.updateUserState.run(clean.settings.displayName,clean.settings.defaultCurrency,clean.settings.appMode,clean.settings.timezone,user.user_id,expected);
    if(Number(upd.changes)!==1) throw Object.assign(new Error('This ledger changed in another tab. Refresh and try again.'),{status:409});
    q.deleteEntries.run(user.user_id); q.deletePeople.run(user.user_id); q.deleteAccounts.run(user.user_id);
    for(const p of clean.people) q.insertPerson.run(user.user_id,p.id,p.name,p.note,p.createdAt);
    const accountById=new Map(clean.accounts.map(a=>[a.id,a]));
    for(const a of clean.accounts){
      const storage=accountToStorage(a);q.insertAccount.run(user.user_id,a.id,a.name,a.type,a.currency,storage.openingBalanceMinor,a.createdAt);
    }
    for(const e of clean.entries){
      const storage=entryToStorage(e,accountById);
      q.insertEntry.run(user.user_id,e.id,e.type,e.personId,e.accountId,e.fromAccountId,e.toAccountId,storage.amountMinor,e.currency,storage.fromAmountMinor,storage.toAmountMinor,storage.signedAmountMinor,e.date,e.merchant,e.description,e.categoryId||null,storage.splitJson,e.createdAt,e.updatedAt);
    }
    q.deleteOrphanAttachments.run(user.user_id,user.user_id);
    bankFeed.reopenOrphans(user.user_id);bankFeed.reconcileReferences(user.user_id);
    db.exec('COMMIT');
  }catch(err){db.exec('ROLLBACK');throw err;}
  return loadState(user.user_id);
}


function ledgerError(message,status=400){return Object.assign(new Error(message),{status});}
function expectedLedgerRevision(body){
  const expected=Number(body?.expectedRevision);
  if(!Number.isInteger(expected))throw ledgerError('Missing ledger revision.');
  return expected;
}
function withLedgerMutation(userId,expected,mutate){
  db.exec('BEGIN IMMEDIATE');
  try{
    const current=Number(q.userById.get(userId)?.revision);
    if(current!==expected)throw ledgerError('This ledger changed in another tab. Refresh and try again.',409);
    const result=mutate();
    const bumped=q.bumpRevision.run(userId,expected);
    if(Number(bumped.changes)!==1)throw ledgerError('This ledger changed in another tab. Refresh and try again.',409);
    db.exec('COMMIT');
    return result;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
function cleanPersonInput(input,{existing=null}={}){
  const id=existing?.id||(idOk(input?.id,'person')?input.id:'person_'+randomUUID());
  if(!idOk(id,'person'))throw ledgerError('Invalid person record.');
  const name=safeStr(input?.name,100),note=safeStr(input?.note,1000);
  if(!name)throw ledgerError('Every person needs a name.');
  return {id,name,note,createdAt:existing?.createdAt||nowIso()};
}
function cleanAccountInput(input,{existing=null,defaultCurrency='USD'}={}){
  const id=existing?.id||(idOk(input?.id,'account')?input.id:'account_'+randomUUID());
  if(!idOk(id,'account'))throw ledgerError('Invalid account record.');
  const name=safeStr(input?.name,100),type=String(input?.type||'other');
  const currency=String(existing?.currency||input?.currency||defaultCurrency).toUpperCase();
  if(!name||!['bank','cash','card','wallet','other'].includes(type)||!validCurrency(currency))throw ledgerError('Invalid account record.');
  if(existing&&input?.currency&&String(input.currency).toUpperCase()!==existing.currency)throw ledgerError('Account currency cannot be changed after creation.');
  const openingBalance=exactMoney(input?.openingBalance??existing?.openingBalance??0,currency);
  return {id,name,type,currency,openingBalance,createdAt:existing?.createdAt||nowIso()};
}
function ledgerValidationState(userId){
  const u=q.userById.get(userId);if(!u)throw ledgerError('Account not found.',404);
  return {
    version:u.revision,
    settings:{displayName:u.display_name,defaultCurrency:u.default_currency},
    people:q.people.all(userId),
    accounts:q.accounts.all(userId).map(accountFromStorage),
    entries:[]
  };
}
function cleanLedgerEntry(user,input,{existing=null}={}){
  const id=existing?.id||(idOk(input?.id,'entry')?input.id:'entry_'+randomUUID());
  if(!idOk(id,'entry'))throw ledgerError('Invalid transaction record.');
  const stamp=nowIso();
  const candidate={...input,id,createdAt:existing?.createdAt||input?.createdAt||stamp,updatedAt:stamp};
  try{
    const refs=ledgerValidationState(user.user_id);
    return validateState({...refs,entries:[candidate]},user).entries[0];
  }catch(error){throw ledgerError(error.message||'Invalid transaction.',400);}
}
function updateLedgerEntryRow(userId,entry){
  const storage=entryToStorage(entry,accountCurrencyMap(userId));
  const result=q.updateEntry.run(entry.type,entry.personId,entry.accountId,entry.fromAccountId,entry.toAccountId,storage.amountMinor,entry.currency,storage.fromAmountMinor,storage.toAmountMinor,storage.signedAmountMinor,entry.date,entry.merchant,entry.description,entry.categoryId||null,storage.splitJson,entry.updatedAt,userId,entry.id);
  if(Number(result.changes)!==1)throw ledgerError('Transaction not found.',404);
}
function currentEntry(userId,id){return loadState(userId).entries.find(entry=>entry.id===id)||null;}
function personUsedByEntry(userId,id){
  return loadState(userId).entries.some(entry=>entry.personId===id||(entry.type==='split_paid_for_people'&&(entry.splits||[]).some(split=>split.personId===id)));
}
function accountUsedByEntry(userId,id){
  return loadState(userId).entries.some(entry=>entry.accountId===id||entry.fromAccountId===id||entry.toAccountId===id);
}
function personUsedByRecurring(userId,id){
  return loadRecurringRules(userId).some(rule=>rule.template?.personId===id||(rule.template?.type==='split_paid_for_people'&&(rule.template?.splits||[]).some(split=>split.personId===id)));
}
function accountUsedByRecurring(userId,id){
  return loadRecurringRules(userId).some(rule=>[rule.template?.accountId,rule.template?.fromAccountId,rule.template?.toAccountId].includes(id));
}
function assertPersonDeletable(userId,id){
  if(personUsedByEntry(userId,id))throw ledgerError('Delete this person’s transactions first.');
  if(personUsedByRecurring(userId,id))throw ledgerError('A recurring schedule still uses this person. Update or delete that schedule first.');
  if(db.prepare('SELECT 1 FROM bank_rules WHERE user_id=? AND person_id=? LIMIT 1').get(userId,id)||db.prepare('SELECT 1 FROM bank_feed_items WHERE user_id=? AND suggested_person_id=? LIMIT 1').get(userId,id))throw ledgerError('Bank Feed data still uses this person. Remove or reclassify it first.');
}
function assertAccountDeletable(userId,id){
  if(accountUsedByEntry(userId,id))throw ledgerError('Delete or move this account’s transactions first.');
  if(accountUsedByRecurring(userId,id))throw ledgerError('A recurring schedule still uses this account. Update or delete that schedule first.');
  if(db.prepare('SELECT 1 FROM bank_feed_items WHERE user_id=? AND (account_id=? OR suggested_target_account_id=?) LIMIT 1').get(userId,id,id)||db.prepare('SELECT 1 FROM bank_rules WHERE user_id=? AND target_account_id=? LIMIT 1').get(userId,id))throw ledgerError('Bank Feed data still uses this account. Remove or reclassify it first.');
}

const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
function staticFile(req,res,url){
  let p=decodeURIComponent(url.pathname); if(p==='/'||!extname(p))p='/index.html';
  const safe=normalize(p).replace(/^(\.\.[/\\])+/, ''); const file=join(ROOT,safe);
  if(!file.startsWith(ROOT)||!existsSync(file)||file.includes(`${join(ROOT,'data')}`)){fail(res,404,'Not found.');return;}
  securityHeaders(res); res.setHeader('Content-Type',mime[extname(file)]||'application/octet-stream'); res.setHeader('Cache-Control',extname(file)==='.html'?'no-cache':'public, max-age=300'); res.writeHead(200);res.end(readFileSync(file));
}

if(process.env.NODE_ENV!=='test'){
  try{recurringReminders.process();}catch(error){console.error('RECURRING_REMINDER_WORKER_ERROR',error);}
  const recurringTimer=setInterval(()=>{try{recurringReminders.process();}catch(error){console.error('RECURRING_REMINDER_WORKER_ERROR',error);}},60*60*1000);
  recurringTimer.unref?.();
}

export const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/api/health'){return json(res,200,{ok:true,moneySchemaVersion:exactMoneySchemaVersion(db),moneyStorage:'integer-minor-units',ledgerApiVersion:1,fullBackupVersion:2,durableRateLimits:true,laneBVersion:1,recurringWorker:recurringReminders.status()});}
    if(url.pathname==='/api/auth/status'&&req.method==='GET'){
      return json(res,200,{registrationOpen:Number(q.userCount.get()?.count||0)===0});
    }
    if(url.pathname==='/api/auth/register'&&req.method==='POST'){
      if(rateLimited(req,'register',{limit:10,windowMs:10*60_000}))return fail(res,429,'Too many attempts. Try again later.');
      const b=await bodyJson(req), email=safeStr(b.email,254).toLowerCase(), password=String(b.password||'');
      if(!/^\S+@\S+\.\S+$/.test(email))return fail(res,400,'Enter a valid email.');
      if(password.length<10||password.length>200)return fail(res,400,'Password must be at least 10 characters.');
      const id=`user_${randomUUID()}`, created=nowIso(), display='Money Tracker', passwordHash=hashPassword(password);
      db.exec('BEGIN IMMEDIATE');
      try{
        if(Number(q.userCount.get()?.count||0)>0)throw Object.assign(new Error('Account creation is locked. Sign in and add another account from Settings.'),{status:403});
        if(q.userByEmail.get(email))throw Object.assign(new Error('An account with that email already exists.'),{status:409});
        q.createUser.run(id,email,display,passwordHash,'USD',1,created);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      const session=createSession(id); return json(res,201,{user:{id,email,displayName:display,defaultCurrency:'USD',isOwner:true},csrfToken:session.csrf}, {'Set-Cookie':cookie(session.token)});
    }
    if(url.pathname==='/api/auth/login'&&req.method==='POST'){
      if(rateLimited(req,'login',{limit:20,windowMs:10*60_000}))return fail(res,429,'Too many attempts. Try again later.');
      const b=await bodyJson(req), email=safeStr(b.email,254).toLowerCase(), password=String(b.password||''), u=q.userByEmail.get(email);
      if(!u||!verifyPassword(password,u.password_hash))return fail(res,401,'Email or password is incorrect.');
      const s=createSession(u.id); return json(res,200,{user:{id:u.id,email:u.email,displayName:u.display_name,defaultCurrency:u.default_currency,isOwner:Boolean(u.is_owner)},csrfToken:s.csrf}, {'Set-Cookie':cookie(s.token)});
    }
    if(url.pathname==='/api/auth/me'&&req.method==='GET'){
      const a=requireAuth(req,res); if(!a)return; return json(res,200,{user:{id:a.user_id,email:a.email,displayName:a.display_name,defaultCurrency:a.default_currency,isOwner:Boolean(a.is_owner)},csrfToken:a.csrf_token});
    }
    if(url.pathname==='/api/auth/logout'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return; q.deleteSession.run(a.token_hash); return json(res,200,{ok:true},{'Set-Cookie':clearCookie()});
    }
    if(url.pathname==='/api/auth/password'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true});if(!a)return;
      if(rateLimited(req,'password-change',{limit:10,windowMs:15*60_000}))return fail(res,429,'Too many password attempts. Try again later.');
      const body=await bodyJson(req),currentPassword=String(body.currentPassword||''),newPassword=String(body.newPassword||''),u=q.userSecret.get(a.user_id);
      if(!u||!verifyPassword(currentPassword,u.password_hash))return fail(res,403,'Current password is incorrect.');
      if(newPassword.length<10||newPassword.length>200)return fail(res,400,'New password must be at least 10 characters.');
      if(currentPassword===newPassword)return fail(res,400,'Choose a different new password.');
      db.exec('BEGIN IMMEDIATE');
      try{
        q.updatePassword.run(hashPassword(newPassword),a.user_id);
        q.deleteOtherSessions.run(a.user_id,a.token_hash);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      return json(res,200,{ok:true,otherSessionsRevoked:true});
    }
    if(url.pathname==='/api/auth/sessions/revoke-others'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true});if(!a)return;
      const result=q.deleteOtherSessions.run(a.user_id,a.token_hash);
      return json(res,200,{ok:true,revoked:Number(result.changes||0)});
    }
    if(url.pathname==='/api/account'&&req.method==='DELETE'){
      const a=requireAuth(req,res,{csrf:true});if(!a)return;
      if(rateLimited(req,'account-delete',{limit:5,windowMs:30*60_000}))return fail(res,429,'Too many account deletion attempts. Try again later.');
      const body=await bodyJson(req),password=String(body.password||''),confirmation=String(body.confirmation||''),u=q.userSecret.get(a.user_id);
      if(confirmation!=='DELETE')return fail(res,400,'Type DELETE to confirm account deletion.');
      if(!u||!verifyPassword(password,u.password_hash))return fail(res,403,'Password is incorrect.');
      if(u.isOwner&&Number(q.otherUserCount.get(a.user_id)?.count||0)>0)return fail(res,400,'Delete the additional user accounts before deleting the owner account.');
      q.deleteUser.run(a.user_id);
      return json(res,200,{ok:true},{'Set-Cookie':clearCookie()});
    }
    if(url.pathname==='/api/users'&&req.method==='GET'){
      const a=requireAuth(req,res); if(!a)return;
      if(!a.is_owner)return fail(res,403,'Only the owner can manage user accounts.');
      return json(res,200,{users:q.managedUsers.all().map(row=>({...row,isOwner:Boolean(row.isOwner)}))});
    }
    if(url.pathname==='/api/users'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      if(!a.is_owner)return fail(res,403,'Only the owner can manage user accounts.');
      const b=await bodyJson(req), email=safeStr(b.email,254).toLowerCase(), password=String(b.password||'');
      if(!/^\S+@\S+\.\S+$/.test(email))return fail(res,400,'Enter a valid email.');
      if(password.length<10||password.length>200)return fail(res,400,'Password must be at least 10 characters.');
      if(q.userByEmail.get(email))return fail(res,409,'An account with that email already exists.');
      const id=`user_${randomUUID()}`, createdAt=nowIso(), display='Money Tracker';
      q.createUser.run(id,email,display,hashPassword(password),a.default_currency,0,createdAt);
      return json(res,201,{user:{id,email,isOwner:false,createdAt}});
    }
    if(url.pathname.startsWith('/api/users/')){
      const a=requireAuth(req,res,{csrf:true});if(!a)return;
      if(!a.is_owner)return fail(res,403,'Only the owner can manage user accounts.');
      const parts=url.pathname.slice('/api/users/'.length).split('/').filter(Boolean),id=decodeURIComponent(parts[0]||''),action=parts[1]||'';
      if(!/^user_[A-Za-z0-9_-]+$/.test(id))return fail(res,400,'Invalid user account.');
      const target=q.userSecret.get(id);if(!target)return fail(res,404,'User account not found.');
      if(target.isOwner)return fail(res,400,'The owner account cannot be changed through secondary-user controls.');
      if(action==='password'&&req.method==='POST'){
        const body=await bodyJson(req),password=String(body.password||'');
        if(password.length<10||password.length>200)return fail(res,400,'Password must be at least 10 characters.');
        db.exec('BEGIN IMMEDIATE');
        try{q.updatePassword.run(hashPassword(password),id);q.deleteUserSessions.run(id);db.exec('COMMIT');}
        catch(error){db.exec('ROLLBACK');throw error;}
        return json(res,200,{ok:true,sessionsRevoked:true});
      }
      if(!action&&req.method==='DELETE'){
        q.deleteUser.run(id);
        return json(res,200,{ok:true});
      }
      return fail(res,405,'User account action not supported.');
    }
    if(url.pathname==='/api/settings'&&req.method==='PUT'){
      const a=requireAuth(req,res,{csrf:true});if(!a)return;
      const body=await bodyJson(req),expected=expectedLedgerRevision(body);
      const current=q.userById.get(a.user_id);
      const displayName=safeStr(body.displayName??current.display_name,80)||'My Ledger';
      const defaultCurrency=String(body.defaultCurrency??current.default_currency).toUpperCase();
      const appMode=['simple','advanced'].includes(String(body.appMode??current.app_mode))?String(body.appMode??current.app_mode):'simple';
      const timezone=safeTimeZone(body.timezone??current.timezone??'UTC');
      if(!validCurrency(defaultCurrency))return fail(res,400,'Invalid default currency.');
      withLedgerMutation(a.user_id,expected,()=>q.updateUserSettingsValues.run(displayName,defaultCurrency,appMode,timezone,a.user_id));
      return json(res,200,loadState(a.user_id));
    }
    if(url.pathname==='/api/people'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true});if(!a)return;
      const body=await bodyJson(req),expected=expectedLedgerRevision(body);
      if(Number(q.personCount.get(a.user_id)?.count||0)>=10000)return fail(res,400,'You can keep up to 10,000 people.');
      const person=cleanPersonInput(body);
      if(q.personById.get(a.user_id,person.id))return fail(res,409,'That person id already exists.');
      withLedgerMutation(a.user_id,expected,()=>{
        q.insertPerson.run(a.user_id,person.id,person.name,person.note,person.createdAt);
        const openingRaw=body.openingBalance??body.opening??0,opening=finite(openingRaw);
        if(opening===null||opening<0)throw ledgerError('Opening balance must be zero or greater.');
        if(opening>0){
          if(Number(q.entryCount.get(a.user_id)?.count||0)>=50000)throw ledgerError('You can keep up to 50,000 transactions.');
          const currency=String(body.currency||a.default_currency||'USD').toUpperCase();
          if(!validCurrency(currency))throw ledgerError('Choose a valid currency.');
          const amount=exactMoney(opening,currency,{allowNegative:false,allowZero:false});
          const signedAmount=(body.direction==='i_owe'?-1:1)*amount;
          const date=validDate(body.openingDate)?body.openingDate:new Date().toISOString().slice(0,10);
          const openingEntry=cleanLedgerEntry(a,{id:idOk(body.openingEntryId,'entry')?body.openingEntryId:undefined,type:'person_adjustment',personId:person.id,accountId:null,amount,currency,signedAmount,date,merchant:'',description:'Opening balance',splits:[]});
          insertLedgerEntry(a.user_id,openingEntry);
        }
      });
      return json(res,201,loadState(a.user_id));
    }
    if(url.pathname.startsWith('/api/people/')){
      const a=requireAuth(req,res,{csrf:true});if(!a)return;
      const id=decodeURIComponent(url.pathname.slice('/api/people/'.length));
      if(!idOk(id,'person'))return fail(res,400,'Invalid person.');
      const existing=q.personById.get(a.user_id,id);if(!existing)return fail(res,404,'Person not found.');
      if(req.method==='PUT'){
        const body=await bodyJson(req),expected=expectedLedgerRevision(body),person=cleanPersonInput({...body,id},{existing});
        withLedgerMutation(a.user_id,expected,()=>{
          const changed=q.updatePerson.run(person.name,person.note,a.user_id,id);
          if(Number(changed.changes)!==1)throw ledgerError('Person not found.',404);
        });
        return json(res,200,loadState(a.user_id));
      }
      if(req.method==='DELETE'){
        const body=await bodyJson(req),expected=expectedLedgerRevision(body);
        withLedgerMutation(a.user_id,expected,()=>{
          assertPersonDeletable(a.user_id,id);
          const changed=q.deletePersonRow.run(a.user_id,id);
          if(Number(changed.changes)!==1)throw ledgerError('Person not found.',404);
        });
        return json(res,200,loadState(a.user_id));
      }
      return fail(res,405,'Person action not supported.');
    }
    if(url.pathname==='/api/accounts'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true});if(!a)return;
      const body=await bodyJson(req),expected=expectedLedgerRevision(body);
      if(Number(q.accountCount.get(a.user_id)?.count||0)>=1000)return fail(res,400,'You can keep up to 1,000 accounts.');
      const account=cleanAccountInput(body,{defaultCurrency:a.default_currency});
      if(q.accountById.get(a.user_id,account.id))return fail(res,409,'That account id already exists.');
      withLedgerMutation(a.user_id,expected,()=>{
        const storage=accountToStorage(account);
        q.insertAccount.run(a.user_id,account.id,account.name,account.type,account.currency,storage.openingBalanceMinor,account.createdAt);
      });
      return json(res,201,loadState(a.user_id));
    }
    if(url.pathname.startsWith('/api/accounts/')){
      const a=requireAuth(req,res,{csrf:true});if(!a)return;
      const id=decodeURIComponent(url.pathname.slice('/api/accounts/'.length));
      if(!idOk(id,'account'))return fail(res,400,'Invalid account.');
      const raw=q.accountById.get(a.user_id,id);if(!raw)return fail(res,404,'Account not found.');
      const existing=accountFromStorage(raw);
      if(req.method==='PUT'){
        const body=await bodyJson(req),expected=expectedLedgerRevision(body),account=cleanAccountInput({...body,id},{existing,defaultCurrency:a.default_currency});
        withLedgerMutation(a.user_id,expected,()=>{
          const storage=accountToStorage(account);
          const changed=q.updateAccount.run(account.name,account.type,storage.openingBalanceMinor,a.user_id,id);
          if(Number(changed.changes)!==1)throw ledgerError('Account not found.',404);
        });
        return json(res,200,loadState(a.user_id));
      }
      if(req.method==='DELETE'){
        const body=await bodyJson(req),expected=expectedLedgerRevision(body);
        withLedgerMutation(a.user_id,expected,()=>{
          assertAccountDeletable(a.user_id,id);
          const changed=q.deleteAccountRow.run(a.user_id,id);
          if(Number(changed.changes)!==1)throw ledgerError('Account not found.',404);
        });
        return json(res,200,loadState(a.user_id));
      }
      return fail(res,405,'Account action not supported.');
    }
    if(url.pathname==='/api/entries'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true});if(!a)return;
      const body=await bodyJson(req),expected=expectedLedgerRevision(body);
      if(Number(q.entryCount.get(a.user_id)?.count||0)>=50000)return fail(res,400,'You can keep up to 50,000 transactions.');
      const entry=cleanLedgerEntry(a,body);
      if(q.entryExists.get(a.user_id,entry.id))return fail(res,409,'That transaction id already exists.');
      withLedgerMutation(a.user_id,expected,()=>insertLedgerEntry(a.user_id,entry));
      return json(res,201,loadState(a.user_id));
    }
    if(url.pathname.startsWith('/api/entries/')){
      const a=requireAuth(req,res,{csrf:true});if(!a)return;
      const id=decodeURIComponent(url.pathname.slice('/api/entries/'.length));
      if(!idOk(id,'entry'))return fail(res,400,'Invalid transaction.');
      const existing=currentEntry(a.user_id,id);if(!existing)return fail(res,404,'Transaction not found.');
      if(req.method==='PUT'){
        const body=await bodyJson(req),expected=expectedLedgerRevision(body),entry=cleanLedgerEntry(a,{...body,id},{existing});
        withLedgerMutation(a.user_id,expected,()=>updateLedgerEntryRow(a.user_id,entry));
        return json(res,200,loadState(a.user_id));
      }
      if(req.method==='DELETE'){
        const body=await bodyJson(req),expected=expectedLedgerRevision(body);
        withLedgerMutation(a.user_id,expected,()=>{
          q.deleteEntryAttachments.run(a.user_id,id);
          const changed=q.deleteEntry.run(a.user_id,id);
          if(Number(changed.changes)!==1)throw ledgerError('Transaction not found.',404);
          bankFeed.reopenOrphans(a.user_id);
        });
        return json(res,200,loadState(a.user_id));
      }
      return fail(res,405,'Transaction action not supported.');
    }
    if(url.pathname==='/api/attachments'&&req.method==='GET'){
      const a=requireAuth(req,res); if(!a)return;
      const entryId=String(url.searchParams.get('entry')||'');
      if(!idOk(entryId,'entry'))return fail(res,400,'Choose a valid transaction.');
      return json(res,200,{attachments:q.attachmentsForEntry.all(a.user_id,entryId)});
    }
    if(url.pathname==='/api/attachments'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      const b=await bodyJson(req,ATTACHMENT_BODY_LIMIT), entryId=String(b.entryId||''), name=safeStr(b.name,180), mimeType=String(b.mimeType||'application/octet-stream').toLowerCase();
      if(!idOk(entryId,'entry')||!q.entryExists.get(a.user_id,entryId))return fail(res,400,'Transaction not found.');
      if(!name||!ALLOWED_ATTACHMENT_TYPES.has(mimeType))return fail(res,400,'Use a JPG, PNG, WebP, GIF, PDF, or text file.');
      let data; try{data=Buffer.from(String(b.data||''),'base64');}catch{return fail(res,400,'Invalid attachment data.');}
      if(!data.length||data.length>MAX_ATTACHMENT_BYTES)return fail(res,413,'Attachments must be 8 MB or smaller.');
      const id=`attachment_${randomUUID()}`, createdAt=nowIso();
      q.insertAttachment.run(a.user_id,id,entryId,name,mimeType,data.length,data,createdAt);
      return json(res,201,{attachment:{id,entryId,name,mimeType,sizeBytes:data.length,createdAt}});
    }
    if(url.pathname.startsWith('/api/attachments/')&&req.method==='GET'){
      const a=requireAuth(req,res); if(!a)return;
      const id=decodeURIComponent(url.pathname.slice('/api/attachments/'.length)), row=q.attachmentById.get(a.user_id,id);
      if(!row)return fail(res,404,'Attachment not found.');
      securityHeaders(res);res.writeHead(200,{'Content-Type':row.mimeType,'Content-Length':String(row.sizeBytes),'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(row.name)}`,'Cache-Control':'private, max-age=300'});res.end(row.data);return;
    }
    if(url.pathname.startsWith('/api/attachments/')&&req.method==='DELETE'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      const id=decodeURIComponent(url.pathname.slice('/api/attachments/'.length));
      const result=q.deleteAttachment.run(a.user_id,id);
      if(!Number(result.changes))return fail(res,404,'Attachment not found.');
      return json(res,200,{ok:true});
    }

    if(url.pathname==='/api/recurring/reminders'&&req.method==='GET'){
      const a=requireAuth(req,res);if(!a)return;
      recurringReminders.process();
      return json(res,200,{reminders:recurringReminders.list(a.user_id),worker:recurringReminders.status()});
    }
    if(url.pathname.startsWith('/api/recurring/reminders/')&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true});if(!a)return;
      const id=decodeURIComponent(url.pathname.slice('/api/recurring/reminders/'.length));
      return json(res,200,{ok:recurringReminders.acknowledge(a.user_id,id)});
    }
    if(url.pathname==='/api/recurring'&&req.method==='GET'){
      const a=requireAuth(req,res); if(!a)return; return json(res,200,{rules:loadRecurringRules(a.user_id)});
    }
    if(url.pathname==='/api/recurring'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      if(Number(q.recurringCount.get(a.user_id)?.count||0)>=500)return fail(res,400,'You can keep up to 500 recurring schedules.');
      const body=await bodyJson(req); let clean;
      try{clean=cleanRecurringRule(body,a.user_id,a.default_currency);}catch(error){return fail(res,400,error.message);}
      const stamp=nowIso();
      q.insertRecurring.run(a.user_id,clean.id,clean.title,clean.frequency,clean.interval,clean.anchorDate,clean.nextDueDate,clean.endDate,clean.remindDaysBefore,clean.isActive?1:0,JSON.stringify(templateToStorage(clean.template,accountCurrencyMap(a.user_id))),null,null,stamp,stamp);
      return json(res,201,{rule:recurringRow(q.recurringRuleById.get(a.user_id,clean.id),a.user_id)});
    }
    if(url.pathname.startsWith('/api/recurring/')){
      const a=requireAuth(req,res,{csrf:req.method!=='GET'}); if(!a)return;
      const parts=url.pathname.slice('/api/recurring/'.length).split('/').filter(Boolean);
      const id=decodeURIComponent(parts[0]||''), action=parts[1]||'';
      if(!idOk(id,'rule'))return fail(res,400,'Invalid recurring schedule.');
      const row=q.recurringRuleById.get(a.user_id,id); if(!row)return fail(res,404,'Recurring schedule not found.');
      if(!action&&req.method==='PUT'){
        const body=await bodyJson(req); let clean;
        try{clean=cleanRecurringRule({...body,id},a.user_id,a.default_currency,{existing:row});}catch(error){return fail(res,400,error.message);}
        q.updateRecurring.run(clean.title,clean.frequency,clean.interval,clean.anchorDate,clean.nextDueDate,clean.endDate,clean.remindDaysBefore,clean.isActive?1:0,JSON.stringify(templateToStorage(clean.template,accountCurrencyMap(a.user_id))),nowIso(),a.user_id,id);
        return json(res,200,{rule:recurringRow(q.recurringRuleById.get(a.user_id,id),a.user_id)});
      }
      if(!action&&req.method==='DELETE'){
        q.deleteRecurring.run(a.user_id,id); recurringReminders.deleteRule(a.user_id,id); return json(res,200,{ok:true});
      }
      if(action==='post'&&req.method==='POST'){
        const body=await bodyJson(req), expected=Number(body.expectedRevision), occurrenceDate=String(body.occurrenceDate||''), transactionDate=String(body.transactionDate||occurrenceDate);
        if(!Number.isInteger(expected)||!validDate(occurrenceDate)||!validDate(transactionDate))return fail(res,400,'Invalid recurring post request.');
        db.exec('BEGIN IMMEDIATE');
        try{
          const current=q.recurringRuleById.get(a.user_id,id);
          if(!current||!current.isActive)throw Object.assign(new Error('This recurring schedule is paused or complete.'),{status:400});
          const storedTemplate=JSON.parse(current.templateJson||'{}');
          const template=cleanRecurringTemplate(templateFromStorage(storedTemplate,accountCurrencyMap(a.user_id)),a.user_id,a.default_currency);
          if(current.nextDueDate!==occurrenceDate)throw Object.assign(new Error('This occurrence was already handled. Refresh and try again.'),{status:409});
          const bumped=q.bumpRevision.run(a.user_id,expected);
          if(Number(bumped.changes)!==1)throw Object.assign(new Error('This ledger changed in another tab. Refresh and try again.'),{status:409});
          const entry=recurringEntryFromTemplate(template,transactionDate); insertLedgerEntry(a.user_id,entry);
          advanceRecurringRule(a.user_id,current,occurrenceDate,{posted:true});
          recurringReminders.acknowledgeOccurrence(a.user_id,id,occurrenceDate);
          db.exec('COMMIT');
          return json(res,200,{state:loadState(a.user_id),rule:recurringRow(q.recurringRuleById.get(a.user_id,id),a.user_id),entryId:entry.id});
        }catch(error){db.exec('ROLLBACK');throw error;}
      }
      if(action==='skip'&&req.method==='POST'){
        const body=await bodyJson(req), occurrenceDate=String(body.occurrenceDate||'');
        if(!validDate(occurrenceDate))return fail(res,400,'Invalid recurring occurrence.');
        db.exec('BEGIN IMMEDIATE');
        try{
          const current=q.recurringRuleById.get(a.user_id,id);
          if(!current||!current.isActive)throw Object.assign(new Error('This recurring schedule is paused or complete.'),{status:400});
          advanceRecurringRule(a.user_id,current,occurrenceDate,{posted:false});
          recurringReminders.acknowledgeOccurrence(a.user_id,id,occurrenceDate);
          db.exec('COMMIT');
          return json(res,200,{rule:recurringRow(q.recurringRuleById.get(a.user_id,id),a.user_id)});
        }catch(error){db.exec('ROLLBACK');throw error;}
      }
      return fail(res,405,'Recurring schedule action not supported.');
    }
    if(url.pathname==='/api/categories'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      const body=await bodyJson(req); return json(res,201,{category:insights.createCategory(a.user_id,body),...insights.list(a.user_id)});
    }
    if(url.pathname.startsWith('/api/categories/')){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      const parts=url.pathname.slice('/api/categories/'.length).split('/').filter(Boolean),id=decodeURIComponent(parts[0]||''),action=parts[1]||'';
      if(!idOk(id,'category'))return fail(res,400,'Invalid category.');
      if(!action&&req.method==='PUT'){
        const body=await bodyJson(req),newKind=String(body?.kind||'expense');
        const supports=type=>newKind==='both'||(type==='account_expense'&&newKind==='expense')||(type==='account_income'&&newKind==='income');
        const incompatibleEntry=q.entries.all(a.user_id).find(entry=>entry.categoryId===id&&!supports(entry.type));
        const incompatibleRule=loadRecurringRules(a.user_id).find(rule=>rule.template?.categoryId===id&&!supports(rule.template?.type));
        if(incompatibleEntry||incompatibleRule)return fail(res,400,'That category type is already used by transactions or recurring schedules. Use “Both” or keep its current type.');
        const category=insights.updateCategory(a.user_id,id,body);bankFeed.reconcileReferences(a.user_id);
        return json(res,200,{category,...insights.list(a.user_id)});
      }
      if(action==='archive'&&req.method==='POST'){
        if(loadRecurringRules(a.user_id).some(rule=>rule.isActive&&rule.template?.categoryId===id))return fail(res,400,'An active recurring schedule still uses this category. Update or pause that schedule first.');
        const category=insights.archiveCategory(a.user_id,id);bankFeed.reconcileReferences(a.user_id);
        return json(res,200,{category,...insights.list(a.user_id)});
      }
      if(action==='restore'&&req.method==='POST')return json(res,200,{category:insights.restoreCategory(a.user_id,id),...insights.list(a.user_id)});
      return fail(res,405,'Category action not supported.');
    }
    if(url.pathname==='/api/budgets'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      const body=await bodyJson(req); return json(res,200,{budget:insights.saveBudget(a.user_id,body),...insights.list(a.user_id)});
    }
    if(url.pathname.startsWith('/api/budgets/')&&req.method==='DELETE'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      const id=decodeURIComponent(url.pathname.slice('/api/budgets/'.length)); return json(res,200,{...insights.deleteBudget(a.user_id,id),...insights.list(a.user_id)});
    }
    if(url.pathname==='/api/bank-feed'&&req.method==='GET'){
      const a=requireAuth(req,res); if(!a)return; return json(res,200,bankFeed.list(a.user_id));
    }
    if(url.pathname==='/api/bank-feed/import'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      const body=await bodyJson(req,12_000_000); return json(res,200,bankFeed.importRows(a.user_id,body));
    }
    if(url.pathname==='/api/bank-rules'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      const body=await bodyJson(req); return json(res,201,{rule:bankFeed.createRule(a.user_id,body)});
    }
    if(url.pathname.startsWith('/api/bank-rules/')&&req.method==='DELETE'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      const id=decodeURIComponent(url.pathname.slice('/api/bank-rules/'.length)); return json(res,200,bankFeed.deleteRule(a.user_id,id));
    }
    if(url.pathname.startsWith('/api/bank-feed/')){
      const a=requireAuth(req,res,{csrf:req.method!=='GET'}); if(!a)return;
      const parts=url.pathname.slice('/api/bank-feed/'.length).split('/').filter(Boolean);
      const id=decodeURIComponent(parts[0]||''),action=parts[1]||'';
      if(action==='post'&&req.method==='POST'){
        const body=await bodyJson(req),result=bankFeed.post(a.user_id,id,body);
        return json(res,200,{...result,state:loadState(a.user_id)});
      }
      if(action==='undo'&&req.method==='POST'){
        const body=await bodyJson(req),result=bankFeed.undo(a.user_id,id,body);
        return json(res,200,{...result,state:loadState(a.user_id)});
      }
      if(action==='ignore'&&req.method==='POST')return json(res,200,{item:bankFeed.ignore(a.user_id,id)});
      if(action==='reopen'&&req.method==='POST')return json(res,200,{item:bankFeed.reopen(a.user_id,id)});
      if(!action&&req.method==='DELETE')return json(res,200,bankFeed.remove(a.user_id,id));
      return fail(res,405,'Bank feed action not supported.');
    }
    if(url.pathname==='/api/backup/full'&&req.method==='GET'){
      const a=requireAuth(req,res);if(!a)return;
      return json(res,200,exportFullBackup(db,a.user_id));
    }
    if(url.pathname==='/api/backup/full/restore'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true});if(!a)return;
      const body=await bodyJson(req,140_000_000);
      restoreFullBackup(db,a.user_id,body);
      bankFeed.reconcileReferences(a.user_id);
      return json(res,200,{ok:true,state:loadState(a.user_id)});
    }
    if(url.pathname==='/api/backup/restore'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      const body=await bodyJson(req,12_000_000);
      if(!body||typeof body!=='object'||!Array.isArray(body.people)||!Array.isArray(body.accounts)||!Array.isArray(body.entries))return fail(res,400,'That file is not a valid ledger backup.');
      db.exec('BEGIN IMMEDIATE');
      try{
        insights.replace(a.user_id,Array.isArray(body.categories)?body.categories:[],Array.isArray(body.budgets)?body.budgets:[]);
        const clean=validateState({...body,version:a.revision},a);assertRecurringReferences(a.user_id,clean);
        const upd=q.updateUserState.run(clean.settings.displayName,clean.settings.defaultCurrency,a.user_id,a.revision);
        if(Number(upd.changes)!==1)throw Object.assign(new Error('This ledger changed in another tab. Refresh and try again.'),{status:409});
        q.deleteEntries.run(a.user_id);q.deletePeople.run(a.user_id);q.deleteAccounts.run(a.user_id);
        for(const p of clean.people)q.insertPerson.run(a.user_id,p.id,p.name,p.note,p.createdAt);
        const restoreAccountById=new Map(clean.accounts.map(account=>[account.id,account]));
        for(const account of clean.accounts){const storage=accountToStorage(account);q.insertAccount.run(a.user_id,account.id,account.name,account.type,account.currency,storage.openingBalanceMinor,account.createdAt);}
        for(const e of clean.entries){const storage=entryToStorage(e,restoreAccountById);q.insertEntry.run(a.user_id,e.id,e.type,e.personId,e.accountId,e.fromAccountId,e.toAccountId,storage.amountMinor,e.currency,storage.fromAmountMinor,storage.toAmountMinor,storage.signedAmountMinor,e.date,e.merchant,e.description,e.categoryId||null,storage.splitJson,e.createdAt,e.updatedAt);}
        q.deleteOrphanAttachments.run(a.user_id,a.user_id);
        bankFeed.reopenOrphans(a.user_id);bankFeed.reconcileReferences(a.user_id);
        db.exec('COMMIT');
        return json(res,200,loadState(a.user_id));
      }catch(error){db.exec('ROLLBACK');throw error;}
    }
    if(url.pathname==='/api/state'&&req.method==='GET'){
      const a=requireAuth(req,res); if(!a)return; return json(res,200,loadState(a.user_id));
    }
    if(url.pathname==='/api/state'&&req.method==='PUT'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return; const b=await bodyJson(req); const state=saveState(a,b); return json(res,200,state);
    }
    if(url.pathname==='/api/state/reset'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      q.deleteAllRecurring.run(a.user_id); recurringReminders.reset(a.user_id); const state=loadState(a.user_id); const blank={...state,people:[],accounts:[],entries:[]}; saveState(a,blank); q.deleteAttachments.run(a.user_id); bankFeed.reset(a.user_id); insights.reset(a.user_id); return json(res,200,loadState(a.user_id));
    }
    if(url.pathname==='/api/import/xlsx/preview'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      const body=await bodyJson(req,12_000_000), filename=safeStr(body.filename,180), encoded=String(body.dataBase64||'');
      if(!encoded||encoded.length>11_000_000)return fail(res,400,'Spreadsheet is too large.');
      const data=Buffer.from(encoded,'base64');
      if(!data.length||data.length>8_000_000)return fail(res,400,'Spreadsheet is too large.');
      let parsed; try{parsed=parseWorkbook(data,{limitRows:5000,limitCols:100});}catch{return fail(res,400,'Could not read this XLSX file.');}
      return json(res,200,{filename,sheets:parsed.sheets});
    }
    if(url.pathname.startsWith('/api/')) return fail(res,404,'API route not found.');
    return staticFile(req,res,url);
  }catch(err){
    const status=err.status||500; if(status>=500)console.error(err); return fail(res,status,status>=500?'Server error.':err.message);
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const port=Number(process.env.PORT||4173); server.listen(port,'0.0.0.0',()=>console.log(`Money Owed Tracker listening on http://0.0.0.0:${port}`));
}
