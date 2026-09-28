import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseWorkbook } from './lib/xlsx-import.js';
import { nextRecurringDate } from './lib/recurring.js';
import { createBankFeedService } from './lib/bank-server.js';

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
  opening_balance REAL NOT NULL DEFAULT 0,
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
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT,
  from_amount REAL,
  to_amount REAL,
  signed_amount REAL,
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
const entryColumns = new Set(db.prepare('PRAGMA table_info(entries)').all().map(row => row.name));
if (!entryColumns.has('split_json')) db.exec("ALTER TABLE entries ADD COLUMN split_json TEXT NOT NULL DEFAULT '[]'");


const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id,email,display_name,default_currency,revision,created_at FROM users WHERE id = ?'),
  createUser: db.prepare('INSERT INTO users(id,email,display_name,password_hash,default_currency,revision,created_at) VALUES(?,?,?,?,?,1,?)'),
  sessionByHash: db.prepare(`SELECT s.token_hash,s.csrf_token,s.expires_at,u.id AS user_id,u.email,u.display_name,u.default_currency,u.revision
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`),
  insertSession: db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash=?'),
  cleanupSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  people: db.prepare('SELECT id,name,note,created_at AS createdAt FROM people WHERE user_id=? ORDER BY name COLLATE NOCASE'),
  accounts: db.prepare('SELECT id,name,type,currency,opening_balance AS openingBalance,created_at AS createdAt FROM accounts WHERE user_id=? ORDER BY created_at'),
  entries: db.prepare(`SELECT id,type,person_id AS personId,account_id AS accountId,from_account_id AS fromAccountId,to_account_id AS toAccountId,
    amount,currency,from_amount AS fromAmount,to_amount AS toAmount,signed_amount AS signedAmount,date,merchant,description,split_json AS splitJson,created_at AS createdAt,updated_at AS updatedAt
    FROM entries WHERE user_id=? ORDER BY date, created_at`),
  deleteEntries: db.prepare('DELETE FROM entries WHERE user_id=?'),
  deletePeople: db.prepare('DELETE FROM people WHERE user_id=?'),
  deleteAccounts: db.prepare('DELETE FROM accounts WHERE user_id=?'),
  insertPerson: db.prepare('INSERT INTO people(user_id,id,name,note,created_at) VALUES(?,?,?,?,?)'),
  insertAccount: db.prepare('INSERT INTO accounts(user_id,id,name,type,currency,opening_balance,created_at) VALUES(?,?,?,?,?,?,?)'),
  insertEntry: db.prepare(`INSERT INTO entries(user_id,id,type,person_id,account_id,from_account_id,to_account_id,amount,currency,from_amount,to_amount,signed_amount,date,merchant,description,split_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  entryExists: db.prepare('SELECT id FROM entries WHERE user_id=? AND id=?'),
  attachmentCounts: db.prepare('SELECT entry_id AS entryId, COUNT(*) AS count FROM attachments WHERE user_id=? GROUP BY entry_id'),
  attachmentsForEntry: db.prepare('SELECT id,entry_id AS entryId,name,mime_type AS mimeType,size_bytes AS sizeBytes,created_at AS createdAt FROM attachments WHERE user_id=? AND entry_id=? ORDER BY created_at'),
  attachmentById: db.prepare('SELECT id,entry_id AS entryId,name,mime_type AS mimeType,size_bytes AS sizeBytes,data,created_at AS createdAt FROM attachments WHERE user_id=? AND id=?'),
  insertAttachment: db.prepare('INSERT INTO attachments(user_id,id,entry_id,name,mime_type,size_bytes,data,created_at) VALUES(?,?,?,?,?,?,?,?)'),
  deleteAttachment: db.prepare('DELETE FROM attachments WHERE user_id=? AND id=?'),
  deleteOrphanAttachments: db.prepare('DELETE FROM attachments WHERE user_id=? AND entry_id NOT IN (SELECT id FROM entries WHERE user_id=?)'),
  deleteAttachments: db.prepare('DELETE FROM attachments WHERE user_id=?'),
  recurringRules: db.prepare('SELECT id,title,frequency,interval_value AS interval,anchor_date AS anchorDate,next_due_date AS nextDueDate,end_date AS endDate,remind_days_before AS remindDaysBefore,is_active AS isActive,template_json AS templateJson,last_posted_at AS lastPostedAt,last_occurrence_date AS lastOccurrenceDate,created_at AS createdAt,updated_at AS updatedAt FROM recurring_rules WHERE user_id=? ORDER BY CASE WHEN next_due_date IS NULL THEN 1 ELSE 0 END,next_due_date,title COLLATE NOCASE'),
  recurringRuleById: db.prepare('SELECT id,title,frequency,interval_value AS interval,anchor_date AS anchorDate,next_due_date AS nextDueDate,end_date AS endDate,remind_days_before AS remindDaysBefore,is_active AS isActive,template_json AS templateJson,last_posted_at AS lastPostedAt,last_occurrence_date AS lastOccurrenceDate,created_at AS createdAt,updated_at AS updatedAt FROM recurring_rules WHERE user_id=? AND id=?'),
  recurringCount: db.prepare('SELECT COUNT(*) AS count FROM recurring_rules WHERE user_id=?'),
  insertRecurring: db.prepare('INSERT INTO recurring_rules(user_id,id,title,frequency,interval_value,anchor_date,next_due_date,end_date,remind_days_before,is_active,template_json,last_posted_at,last_occurrence_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
  updateRecurring: db.prepare('UPDATE recurring_rules SET title=?,frequency=?,interval_value=?,anchor_date=?,next_due_date=?,end_date=?,remind_days_before=?,is_active=?,template_json=?,updated_at=? WHERE user_id=? AND id=?'),
  deleteRecurring: db.prepare('DELETE FROM recurring_rules WHERE user_id=? AND id=?'),
  advanceRecurring: db.prepare('UPDATE recurring_rules SET next_due_date=?,is_active=?,last_posted_at=?,last_occurrence_date=?,updated_at=? WHERE user_id=? AND id=? AND next_due_date=?'),
  updateUserState: db.prepare('UPDATE users SET display_name=?, default_currency=?, revision=revision+1 WHERE id=? AND revision=?'),
  bumpRevision: db.prepare('UPDATE users SET revision=revision+1 WHERE id=? AND revision=?'),
  deleteAllData: db.prepare('DELETE FROM entries WHERE user_id=?'),
};

const bankFeed = createBankFeedService(db);

function nowIso() { return new Date().toISOString(); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function safeStr(value, max=180) { return String(value ?? '').trim().slice(0,max); }
function validCurrency(v) { return /^[A-Z]{3,5}$/.test(String(v || '')); }
function validDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)); }
function finite(v) { const n=Number(v); return Number.isFinite(n) ? n : null; }
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

const attempts = new Map();
function rateLimited(req) {
  const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();
  const t=Date.now(); const row=attempts.get(ip)||{start:t,count:0};
  if(t-row.start>10*60_000){row.start=t;row.count=0;} row.count++; attempts.set(ip,row);
  return row.count>30;
}

function validateState(input, user) {
  if(!input || typeof input!=='object') throw new Error('Invalid state.');
  const settings=input.settings||{};
  const displayName=safeStr(settings.displayName || user.display_name || 'My Ledger',80) || 'My Ledger';
  const defaultCurrency=String(settings.defaultCurrency||user.default_currency||'USD').toUpperCase();
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
    const name=safeStr(a.name,100), type=String(a.type||'other'), currency=String(a.currency||defaultCurrency).toUpperCase(), opening=finite(a.openingBalance);
    if(!name||!allowedAccountTypes.has(type)||!validCurrency(currency)||opening===null||Math.abs(opening)>1e15) throw new Error('Invalid account record.');
    return {id:a.id,name,type,currency,openingBalance:opening,createdAt:a.createdAt||nowIso()};
  });
  const allowedTypes=new Set(['paid_for_person','received_from_person','borrowed_from_person','paid_to_person','person_adjustment','account_transfer','split_paid_for_people','account_expense','account_income']);
  const accountById=new Map(cleanAccounts.map(a=>[a.id,a]));
  const cleanEntries=entries.map(e=>{
    if(!idOk(e.id,'entry')||eSeen.has(e.id)||!allowedTypes.has(e.type)) throw new Error('Invalid transaction record.'); eSeen.add(e.id);
    const amount=finite(e.amount); if(amount===null||amount<0||amount>1e15) throw new Error('Invalid transaction amount.');
    const base={id:e.id,type:e.type,personId:e.personId||null,accountId:e.accountId||null,fromAccountId:e.fromAccountId||null,toAccountId:e.toAccountId||null,amount,currency:e.currency?String(e.currency).toUpperCase():null,fromAmount:e.fromAmount==null?null:finite(e.fromAmount),toAmount:e.toAmount==null?null:finite(e.toAmount),signedAmount:e.signedAmount==null?null:finite(e.signedAmount),date:String(e.date||''),merchant:safeStr(e.merchant,100),description:safeStr(e.description,500),splits:[],createdAt:e.createdAt||nowIso(),updatedAt:e.updatedAt||nowIso()};
    if(!validDate(base.date)) throw new Error('Invalid transaction date.');
    if(e.type==='account_transfer'){
      if(!aSeen.has(base.fromAccountId)||!aSeen.has(base.toAccountId)||base.fromAccountId===base.toAccountId||!(base.fromAmount>0)||!(base.toAmount>0)) throw new Error('Invalid account transfer.');
      base.personId=null;base.accountId=null;base.currency=null;base.signedAmount=null;base.amount=base.fromAmount;
    } else if(e.type==='split_paid_for_people'){
      if(!aSeen.has(base.accountId)||!(amount>0)) throw new Error('Split transaction account is missing.');
      const source=Array.isArray(e.splits)?e.splits:[];
      if(source.length<2||source.length>100) throw new Error('A split needs at least two people.');
      const seenPeople=new Set(); let splitTotal=0;
      base.splits=source.map(split=>{
        const personId=String(split?.personId||''), splitAmount=finite(split?.amount);
        if(!pSeen.has(personId)||seenPeople.has(personId)||!(splitAmount>0)||splitAmount>1e15) throw new Error('Invalid split allocation.');
        seenPeople.add(personId); splitTotal+=splitAmount;
        return {personId,amount:splitAmount,note:safeStr(split?.note,180)};
      });
      if(Math.abs(splitTotal-amount)>0.005) throw new Error('Split amounts must equal the transaction total.');
      base.personId=null;base.currency=accountById.get(base.accountId).currency;base.signedAmount=null;
      base.fromAccountId=null;base.toAccountId=null;base.fromAmount=null;base.toAmount=null;
    } else if(e.type==='account_expense'||e.type==='account_income'){
      if(!aSeen.has(base.accountId)||!(amount>0)) throw new Error('Account-only transaction account is missing.');
      base.personId=null;base.currency=accountById.get(base.accountId).currency;base.signedAmount=null;
      base.fromAccountId=null;base.toAccountId=null;base.fromAmount=null;base.toAmount=null;
    } else {
      if(!pSeen.has(base.personId)) throw new Error('Transaction person is missing.');
      if(e.type==='person_adjustment'){
        base.accountId=null;
        if(!(amount>0)||base.signedAmount===null||Math.abs(base.signedAmount)!==amount||!validCurrency(base.currency)) throw new Error('Invalid balance adjustment.');
      } else {
        if(!aSeen.has(base.accountId)||!(amount>0)) throw new Error('Transaction account is missing.');
        base.currency=accountById.get(base.accountId).currency; base.signedAmount=null;
      }
      base.fromAccountId=null;base.toAccountId=null;base.fromAmount=null;base.toAmount=null;
    }
    return base;
  });
  return {settings:{displayName,defaultCurrency},people:cleanPeople,accounts:cleanAccounts,entries:cleanEntries};
}


const RECURRING_TYPES = new Set(['paid_for_person','received_from_person','borrowed_from_person','paid_to_person','person_adjustment','account_transfer','split_paid_for_people']);
const RECURRING_FREQUENCIES = new Set(['daily','weekly','monthly','yearly']);

function recurringRow(row) {
  if(!row) return null;
  let template={}; try{template=JSON.parse(row.templateJson||'{}');}catch{}
  const {templateJson,...rest}=row;
  return {...rest,isActive:!!row.isActive,template};
}

function loadRecurringRules(userId) {
  return q.recurringRules.all(userId).map(recurringRow);
}

function cleanRecurringTemplate(raw,userId,defaultCurrency='USD') {
  if(!raw || typeof raw!=='object' || !RECURRING_TYPES.has(raw.type)) throw new Error('Choose a valid recurring transaction type.');
  const people=new Set(q.people.all(userId).map(row=>row.id));
  const accounts=q.accounts.all(userId);
  const accountById=new Map(accounts.map(row=>[row.id,row]));
  const amount=finite(raw.amount);
  const base={
    type:raw.type,
    personId:raw.personId||null,
    accountId:raw.accountId||null,
    fromAccountId:raw.fromAccountId||null,
    toAccountId:raw.toAccountId||null,
    amount,
    currency:raw.currency?String(raw.currency).toUpperCase():null,
    fromAmount:raw.fromAmount==null?null:finite(raw.fromAmount),
    toAmount:raw.toAmount==null?null:finite(raw.toAmount),
    signedAmount:raw.signedAmount==null?null:finite(raw.signedAmount),
    merchant:safeStr(raw.merchant,100),
    description:safeStr(raw.description,500),
    splits:[]
  };
  if(amount===null || amount<0 || amount>1e15) throw new Error('Invalid recurring amount.');
  if(raw.type==='account_transfer'){
    if(!accountById.has(base.fromAccountId)||!accountById.has(base.toAccountId)||base.fromAccountId===base.toAccountId||!(base.fromAmount>0)||!(base.toAmount>0)) throw new Error('Choose two different accounts and valid transfer amounts.');
    base.personId=null;base.accountId=null;base.currency=null;base.signedAmount=null;base.amount=base.fromAmount;
  } else if(raw.type==='split_paid_for_people'){
    if(!accountById.has(base.accountId)||!(amount>0)) throw new Error('Choose an account and amount for the recurring split.');
    const source=Array.isArray(raw.splits)?raw.splits:[];
    if(source.length<2||source.length>100) throw new Error('A recurring split needs at least two people.');
    const seen=new Set(); let total=0;
    base.splits=source.map(split=>{
      const personId=String(split?.personId||''), splitAmount=finite(split?.amount);
      if(!people.has(personId)||seen.has(personId)||!(splitAmount>0)||splitAmount>1e15) throw new Error('Invalid recurring split allocation.');
      seen.add(personId); total+=splitAmount;
      return {personId,amount:splitAmount,note:safeStr(split?.note,180)};
    });
    if(Math.abs(total-amount)>0.005) throw new Error('Recurring split amounts must equal the total.');
    base.personId=null;base.currency=accountById.get(base.accountId).currency;base.signedAmount=null;
    base.fromAccountId=null;base.toAccountId=null;base.fromAmount=null;base.toAmount=null;
  } else {
    if(!people.has(base.personId)) throw new Error('Choose a person for the recurring transaction.');
    if(raw.type==='person_adjustment'){
      base.accountId=null;
      base.currency=String(base.currency||defaultCurrency).toUpperCase();
      if(!(amount>0)||base.signedAmount===null||Math.abs(base.signedAmount)!==amount||!validCurrency(base.currency)) throw new Error('Invalid recurring balance adjustment.');
    } else {
      if(!accountById.has(base.accountId)||!(amount>0)) throw new Error('Choose an account and amount for the recurring transaction.');
      base.currency=accountById.get(base.accountId).currency;base.signedAmount=null;
    }
    base.fromAccountId=null;base.toAccountId=null;base.fromAmount=null;base.toAmount=null;
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
  for(const rule of loadRecurringRules(userId)){
    const t=rule.template||{};
    const personIds=t.type==='split_paid_for_people'?(t.splits||[]).map(split=>split.personId):(t.personId?[t.personId]:[]);
    const accountIds=[t.accountId,t.fromAccountId,t.toAccountId].filter(Boolean);
    if(personIds.some(id=>!people.has(id))||accountIds.some(id=>!accounts.has(id))) throw new Error('A recurring schedule still uses a person or account you are trying to delete. Update or delete that schedule first.');
  }
}

function recurringEntryFromTemplate(template,date) {
  const stamp=nowIso();
  return {id:'entry_'+randomUUID(),...template,date,createdAt:stamp,updatedAt:stamp};
}

function insertLedgerEntry(userId,e) {
  q.insertEntry.run(userId,e.id,e.type,e.personId,e.accountId,e.fromAccountId,e.toAccountId,e.amount,e.currency,e.fromAmount,e.toAmount,e.signedAmount,e.date,e.merchant,e.description,JSON.stringify(e.splits||[]),e.createdAt,e.updatedAt);
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
  const counts=new Map(q.attachmentCounts.all(userId).map(row=>[row.entryId,Number(row.count||0)]));
  const entries=q.entries.all(userId).map(row=>{
    let splits=[]; try{splits=JSON.parse(row.splitJson||'[]');}catch{}
    const {splitJson,...entry}=row;
    return {...entry,splits:Array.isArray(splits)?splits:[],attachmentCount:counts.get(row.id)||0};
  });
  return {version:u.revision,settings:{displayName:u.display_name,defaultCurrency:u.default_currency},people:q.people.all(userId),accounts:q.accounts.all(userId),entries};
}
function saveState(user, input) {
  const expected=Number(input.version); if(!Number.isInteger(expected)) throw Object.assign(new Error('Missing ledger version.'),{status:400});
  let clean; try{clean=validateState(input,user);assertRecurringReferences(user.user_id,clean);}catch(error){throw Object.assign(error,{status:400});}
  db.exec('BEGIN IMMEDIATE');
  try{
    const upd=q.updateUserState.run(clean.settings.displayName,clean.settings.defaultCurrency,user.user_id,expected);
    if(Number(upd.changes)!==1) throw Object.assign(new Error('This ledger changed in another tab. Refresh and try again.'),{status:409});
    q.deleteEntries.run(user.user_id); q.deletePeople.run(user.user_id); q.deleteAccounts.run(user.user_id);
    for(const p of clean.people) q.insertPerson.run(user.user_id,p.id,p.name,p.note,p.createdAt);
    for(const a of clean.accounts) q.insertAccount.run(user.user_id,a.id,a.name,a.type,a.currency,a.openingBalance,a.createdAt);
    for(const e of clean.entries) q.insertEntry.run(user.user_id,e.id,e.type,e.personId,e.accountId,e.fromAccountId,e.toAccountId,e.amount,e.currency,e.fromAmount,e.toAmount,e.signedAmount,e.date,e.merchant,e.description,JSON.stringify(e.splits||[]),e.createdAt,e.updatedAt);
    q.deleteOrphanAttachments.run(user.user_id,user.user_id);
    bankFeed.reopenOrphans(user.user_id);
    bankFeed.reconcileReferences(user.user_id);
    db.exec('COMMIT');
  }catch(err){db.exec('ROLLBACK');throw err;}
  return loadState(user.user_id);
}

const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
function staticFile(req,res,url){
  let p=decodeURIComponent(url.pathname); if(p==='/'||!extname(p))p='/index.html';
  const safe=normalize(p).replace(/^(\.\.[/\\])+/, ''); const file=join(ROOT,safe);
  if(!file.startsWith(ROOT)||!existsSync(file)||file.includes(`${join(ROOT,'data')}`)){fail(res,404,'Not found.');return;}
  securityHeaders(res); res.setHeader('Content-Type',mime[extname(file)]||'application/octet-stream'); res.setHeader('Cache-Control',extname(file)==='.html'?'no-cache':'public, max-age=300'); res.writeHead(200);res.end(readFileSync(file));
}

export const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/api/health'){return json(res,200,{ok:true});}
    if(url.pathname==='/api/auth/register'&&req.method==='POST'){
      if(rateLimited(req))return fail(res,429,'Too many attempts. Try again later.');
      const b=await bodyJson(req), email=safeStr(b.email,254).toLowerCase(), display=safeStr(b.displayName,80)||'My Ledger', password=String(b.password||'');
      if(!/^\S+@\S+\.\S+$/.test(email))return fail(res,400,'Enter a valid email.');
      if(password.length<10||password.length>200)return fail(res,400,'Password must be at least 10 characters.');
      if(q.userByEmail.get(email))return fail(res,409,'An account with that email already exists.');
      const id=`user_${randomUUID()}`, created=nowIso(); q.createUser.run(id,email,display,hashPassword(password),'USD',created);
      const s=createSession(id); return json(res,201,{user:{id,email,displayName:display,defaultCurrency:'USD'},csrfToken:s.csrf}, {'Set-Cookie':cookie(s.token)});
    }
    if(url.pathname==='/api/auth/login'&&req.method==='POST'){
      if(rateLimited(req))return fail(res,429,'Too many attempts. Try again later.');
      const b=await bodyJson(req), email=safeStr(b.email,254).toLowerCase(), password=String(b.password||''), u=q.userByEmail.get(email);
      if(!u||!verifyPassword(password,u.password_hash))return fail(res,401,'Email or password is incorrect.');
      const s=createSession(u.id); return json(res,200,{user:{id:u.id,email:u.email,displayName:u.display_name,defaultCurrency:u.default_currency},csrfToken:s.csrf}, {'Set-Cookie':cookie(s.token)});
    }
    if(url.pathname==='/api/auth/me'&&req.method==='GET'){
      const a=requireAuth(req,res); if(!a)return; return json(res,200,{user:{id:a.user_id,email:a.email,displayName:a.display_name,defaultCurrency:a.default_currency},csrfToken:a.csrf_token});
    }
    if(url.pathname==='/api/auth/logout'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return; q.deleteSession.run(a.token_hash); return json(res,200,{ok:true},{'Set-Cookie':clearCookie()});
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

    if(url.pathname==='/api/recurring'&&req.method==='GET'){
      const a=requireAuth(req,res); if(!a)return; return json(res,200,{rules:loadRecurringRules(a.user_id)});
    }
    if(url.pathname==='/api/recurring'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      if(Number(q.recurringCount.get(a.user_id)?.count||0)>=500)return fail(res,400,'You can keep up to 500 recurring schedules.');
      const body=await bodyJson(req); let clean;
      try{clean=cleanRecurringRule(body,a.user_id,a.default_currency);}catch(error){return fail(res,400,error.message);}
      const stamp=nowIso();
      q.insertRecurring.run(a.user_id,clean.id,clean.title,clean.frequency,clean.interval,clean.anchorDate,clean.nextDueDate,clean.endDate,clean.remindDaysBefore,clean.isActive?1:0,JSON.stringify(clean.template),null,null,stamp,stamp);
      return json(res,201,{rule:recurringRow(q.recurringRuleById.get(a.user_id,clean.id))});
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
        q.updateRecurring.run(clean.title,clean.frequency,clean.interval,clean.anchorDate,clean.nextDueDate,clean.endDate,clean.remindDaysBefore,clean.isActive?1:0,JSON.stringify(clean.template),nowIso(),a.user_id,id);
        return json(res,200,{rule:recurringRow(q.recurringRuleById.get(a.user_id,id))});
      }
      if(!action&&req.method==='DELETE'){
        q.deleteRecurring.run(a.user_id,id); return json(res,200,{ok:true});
      }
      if(action==='post'&&req.method==='POST'){
        const body=await bodyJson(req), expected=Number(body.expectedRevision), occurrenceDate=String(body.occurrenceDate||''), transactionDate=String(body.transactionDate||occurrenceDate);
        if(!Number.isInteger(expected)||!validDate(occurrenceDate)||!validDate(transactionDate))return fail(res,400,'Invalid recurring post request.');
        db.exec('BEGIN IMMEDIATE');
        try{
          const current=q.recurringRuleById.get(a.user_id,id);
          if(!current||!current.isActive)throw Object.assign(new Error('This recurring schedule is paused or complete.'),{status:400});
          const template=cleanRecurringTemplate(JSON.parse(current.templateJson||'{}'),a.user_id,a.default_currency);
          if(current.nextDueDate!==occurrenceDate)throw Object.assign(new Error('This occurrence was already handled. Refresh and try again.'),{status:409});
          const bumped=q.bumpRevision.run(a.user_id,expected);
          if(Number(bumped.changes)!==1)throw Object.assign(new Error('This ledger changed in another tab. Refresh and try again.'),{status:409});
          const entry=recurringEntryFromTemplate(template,transactionDate); insertLedgerEntry(a.user_id,entry);
          advanceRecurringRule(a.user_id,current,occurrenceDate,{posted:true});
          db.exec('COMMIT');
          return json(res,200,{state:loadState(a.user_id),rule:recurringRow(q.recurringRuleById.get(a.user_id,id)),entryId:entry.id});
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
          db.exec('COMMIT');
          return json(res,200,{rule:recurringRow(q.recurringRuleById.get(a.user_id,id))});
        }catch(error){db.exec('ROLLBACK');throw error;}
      }
      return fail(res,405,'Recurring schedule action not supported.');
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
      if(action==='ignore'&&req.method==='POST')return json(res,200,{item:bankFeed.ignore(a.user_id,id)});
      if(action==='reopen'&&req.method==='POST')return json(res,200,{item:bankFeed.reopen(a.user_id,id)});
      if(!action&&req.method==='DELETE')return json(res,200,bankFeed.remove(a.user_id,id));
      return fail(res,405,'Bank feed action not supported.');
    }
    if(url.pathname==='/api/state'&&req.method==='GET'){
      const a=requireAuth(req,res); if(!a)return; return json(res,200,loadState(a.user_id));
    }
    if(url.pathname==='/api/state'&&req.method==='PUT'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return; const b=await bodyJson(req); const state=saveState(a,b); return json(res,200,state);
    }
    if(url.pathname==='/api/state/reset'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      const state=loadState(a.user_id); const blank={...state,people:[],accounts:[],entries:[]}; const saved=saveState(a,blank); q.deleteAttachments.run(a.user_id); bankFeed.reset(a.user_id); return json(res,200,{...saved,entries:[]});
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
