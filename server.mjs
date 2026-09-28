import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { personBalances, accountBalances, runningStatement } from './lib/ledger.js';
import { ledgerWorkbook, importTemplateWorkbook, parseWorkbook } from './lib/xlsx.js';
import { summaryPdf, personStatementPdf } from './lib/pdf.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || join(DATA_DIR, 'ledger.sqlite');
const SESSION_DAYS = 30;
const BODY_LIMIT = 1_000_000;
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
`);

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
    amount,currency,from_amount AS fromAmount,to_amount AS toAmount,signed_amount AS signedAmount,date,merchant,description,created_at AS createdAt,updated_at AS updatedAt
    FROM entries WHERE user_id=? ORDER BY date, created_at`),
  deleteEntries: db.prepare('DELETE FROM entries WHERE user_id=?'),
  deletePeople: db.prepare('DELETE FROM people WHERE user_id=?'),
  deleteAccounts: db.prepare('DELETE FROM accounts WHERE user_id=?'),
  insertPerson: db.prepare('INSERT INTO people(user_id,id,name,note,created_at) VALUES(?,?,?,?,?)'),
  insertAccount: db.prepare('INSERT INTO accounts(user_id,id,name,type,currency,opening_balance,created_at) VALUES(?,?,?,?,?,?,?)'),
  insertEntry: db.prepare(`INSERT INTO entries(user_id,id,type,person_id,account_id,from_account_id,to_account_id,amount,currency,from_amount,to_amount,signed_amount,date,merchant,description,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  updateUserState: db.prepare('UPDATE users SET display_name=?, default_currency=?, revision=revision+1 WHERE id=? AND revision=?'),
  deleteAllData: db.prepare('DELETE FROM entries WHERE user_id=?'),
};

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
function binary(res,status,buffer,type,filename){
  securityHeaders(res);
  res.setHeader('Content-Type',type);
  res.setHeader('Content-Disposition',`attachment; filename="${String(filename).replace(/[^a-zA-Z0-9._-]/g,'-')}"`);
  res.setHeader('Cache-Control','no-store');
  res.writeHead(status);
  res.end(buffer);
}
async function bodyJson(req, limit=BODY_LIMIT) {
  return await new Promise((resolve,reject)=>{
    const chunks=[]; let size=0;
    req.on('data',c=>{ size+=c.length; if(size>limit){reject(Object.assign(new Error('too large'),{status:413})); req.destroy(); return;} chunks.push(c); });
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
  const allowedTypes=new Set(['paid_for_person','received_from_person','borrowed_from_person','paid_to_person','person_adjustment','account_transfer']);
  const accountById=new Map(cleanAccounts.map(a=>[a.id,a]));
  const cleanEntries=entries.map(e=>{
    if(!idOk(e.id,'entry')||eSeen.has(e.id)||!allowedTypes.has(e.type)) throw new Error('Invalid transaction record.'); eSeen.add(e.id);
    const amount=finite(e.amount); if(amount===null||amount<0||amount>1e15) throw new Error('Invalid transaction amount.');
    const base={id:e.id,type:e.type,personId:e.personId||null,accountId:e.accountId||null,fromAccountId:e.fromAccountId||null,toAccountId:e.toAccountId||null,amount,currency:e.currency?String(e.currency).toUpperCase():null,fromAmount:e.fromAmount==null?null:finite(e.fromAmount),toAmount:e.toAmount==null?null:finite(e.toAmount),signedAmount:e.signedAmount==null?null:finite(e.signedAmount),date:String(e.date||''),merchant:safeStr(e.merchant,100),description:safeStr(e.description,500),createdAt:e.createdAt||nowIso(),updatedAt:e.updatedAt||nowIso()};
    if(!validDate(base.date)) throw new Error('Invalid transaction date.');
    if(e.type==='account_transfer'){
      if(!aSeen.has(base.fromAccountId)||!aSeen.has(base.toAccountId)||base.fromAccountId===base.toAccountId||!(base.fromAmount>0)||!(base.toAmount>0)) throw new Error('Invalid account transfer.');
      base.personId=null;base.accountId=null;base.currency=null;base.signedAmount=null;base.amount=base.fromAmount;
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

function loadState(userId) {
  const u=q.userById.get(userId); if(!u) return null;
  return {version:u.revision,settings:{displayName:u.display_name,defaultCurrency:u.default_currency},people:q.people.all(userId),accounts:q.accounts.all(userId),entries:q.entries.all(userId)};
}
function saveState(user, input) {
  const expected=Number(input.version); if(!Number.isInteger(expected)) throw Object.assign(new Error('Missing ledger version.'),{status:400});
  const clean=validateState(input,user);
  db.exec('BEGIN IMMEDIATE');
  try{
    const upd=q.updateUserState.run(clean.settings.displayName,clean.settings.defaultCurrency,user.user_id,expected);
    if(Number(upd.changes)!==1) throw Object.assign(new Error('This ledger changed in another tab. Refresh and try again.'),{status:409});
    q.deleteEntries.run(user.user_id); q.deletePeople.run(user.user_id); q.deleteAccounts.run(user.user_id);
    for(const p of clean.people) q.insertPerson.run(user.user_id,p.id,p.name,p.note,p.createdAt);
    for(const a of clean.accounts) q.insertAccount.run(user.user_id,a.id,a.name,a.type,a.currency,a.openingBalance,a.createdAt);
    for(const e of clean.entries) q.insertEntry.run(user.user_id,e.id,e.type,e.personId,e.accountId,e.fromAccountId,e.toAccountId,e.amount,e.currency,e.fromAmount,e.toAmount,e.signedAmount,e.date,e.merchant,e.description,e.createdAt,e.updatedAt);
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
    if(url.pathname==='/api/state'&&req.method==='GET'){
      const a=requireAuth(req,res); if(!a)return; return json(res,200,loadState(a.user_id));
    }
    if(url.pathname==='/api/state'&&req.method==='PUT'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return; const b=await bodyJson(req); const state=saveState(a,b); return json(res,200,state);
    }
    if(url.pathname==='/api/state/reset'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      const state=loadState(a.user_id); const blank={...state,people:[],accounts:[],entries:[]}; const saved=saveState(a,blank); return json(res,200,saved);
    }
    if(url.pathname==='/api/export/ledger.xlsx'&&req.method==='GET'){
      const a=requireAuth(req,res); if(!a)return;
      const state=loadState(a.user_id), pb=personBalances(state.entries,state.people);
      return binary(res,200,ledgerWorkbook(state,{peopleBalances:pb}),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','money-ledger.xlsx');
    }
    if(url.pathname==='/api/export/import-template.xlsx'&&req.method==='GET'){
      const a=requireAuth(req,res); if(!a)return;
      return binary(res,200,importTemplateWorkbook(),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','money-ledger-import-template.xlsx');
    }
    if(url.pathname==='/api/export/summary.pdf'&&req.method==='GET'){
      const a=requireAuth(req,res); if(!a)return;
      const state=loadState(a.user_id), pb=personBalances(state.entries,state.people), ab=accountBalances(state.entries,state.accounts);
      return binary(res,200,summaryPdf(state,{personBalances:pb,accountBalances:ab}),'application/pdf','money-ledger-summary.pdf');
    }
    if(url.pathname==='/api/export/person.pdf'&&req.method==='GET'){
      const a=requireAuth(req,res); if(!a)return;
      const state=loadState(a.user_id), personId=url.searchParams.get('personId'), requested=url.searchParams.get('currency')||'';
      const person=state.people.find(p=>p.id===personId); if(!person)return fail(res,404,'Person not found.');
      const pb=personBalances(state.entries,state.people), selected=requested||Object.keys(pb[person.id]||{})[0]||state.settings.defaultCurrency;
      const rows=runningStatement(state.entries,person.id,selected);
      return binary(res,200,personStatementPdf(state,person,{currency:selected,rows}),'application/pdf','person-statement.pdf');
    }
    if(url.pathname==='/api/import/xlsx/preview'&&req.method==='POST'){
      const a=requireAuth(req,res,{csrf:true}); if(!a)return;
      const b=await bodyJson(req,12_000_000), filename=safeStr(b.filename,180), encoded=String(b.dataBase64||'');
      if(!encoded||encoded.length>11_000_000)return fail(res,400,'Spreadsheet is too large.');
      const data=Buffer.from(encoded,'base64'); if(!data.length||data.length>8_000_000)return fail(res,400,'Spreadsheet is too large.');
      let parsed; try{parsed=parseWorkbook(data,{limitRows:5000});}catch{return fail(res,400,'Could not read this XLSX file.');}
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
