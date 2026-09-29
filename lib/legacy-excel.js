import { parseMoneyValue } from './money-parse.js';

const UNKNOWN_DATE='1900-01-01';
const LEGACY_PREFIX='LegacyExcel:';

function norm(v=''){return String(v??'').trim().toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function money(v){return parseMoneyValue(v);}
function asText(v=''){return String(v??'').replace(/\u00a0/g,' ').trim();}
function excelDate(v){
  if(typeof v==='number'&&v>1000&&v<100000){const d=new Date(Date.UTC(1899,11,30)+Math.round(v)*86400000);return d.toISOString().slice(0,10);}
  const s=asText(v);if(!s)return '';
  if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;
  const m=s.match(/(?:^|\D)(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})(?:\D|$)/);
  if(m){let y=Number(m[3]);if(y<100)y+=y>=70?1900:2000;const mo=Number(m[1]),da=Number(m[2]);if(mo>=1&&mo<=12&&da>=1&&da<=31)return `${String(y).padStart(4,'0')}-${String(mo).padStart(2,'0')}-${String(da).padStart(2,'0')}`;}
  return '';
}
function hashText(input=''){
  let a=0x811c9dc5,b=0x9e3779b9;const s=String(input);
  for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);a^=c;a=Math.imul(a,0x01000193);b^=(c+i);b=Math.imul(b,0x85ebca6b);}
  return `${(a>>>0).toString(16).padStart(8,'0')}${(b>>>0).toString(16).padStart(8,'0')}`;
}
function clone(v){return typeof structuredClone==='function'?structuredClone(v):JSON.parse(JSON.stringify(v));}
function sourceMerchant(sheet,identity){return `${LEGACY_PREFIX}${hashText(`${sheet}|${identity}`)}:${String(sheet).slice(0,48)}`.slice(0,100);}
function cleanPersonName(value){
  let s=asText(value).replace(/\s+payments?$/i,'').replace(/\s+courses?$/i,'').trim();
  const n=norm(s);
  if(n==='abdallah s money'||n==='abdallah money')return 'ABDALLAH';
  if(n.includes('shandrek')||n.includes('shandrie')||n.includes('shandreik'))return 'SHANDRIEKA';
  return s||'Legacy';
}
function firstRowFromHeaders(headers=[]){return headers.map((h,i)=>String(h)===`Column ${i+1}`?'':String(h));}
export function sheetMatrix(sheet){const h=sheet?.headers||[];return [firstRowFromHeaders(h),...(sheet?.rows||[]).map(r=>h.map(k=>r?.[k]??''))];}
function ledgerHeaderIndex(m){for(let r=0;r<Math.min(5,m.length);r++){const row=m[r].map(norm);if(row.filter(x=>x==='narration').length&&row.some(x=>x==='paid')&&row.some(x=>x==='owe'))return r;}return -1;}
function addRecord(out,record){if(record.amount>0&&Number.isFinite(record.amount))out.push(record);}
function identityCounter(){const map=new Map();return base=>{const n=(map.get(base)||0)+1;map.set(base,n);return `${base}#${n}`;};}

function parseLedgerSheet(sheet){
  const m=sheetMatrix(sheet),hr=ledgerHeaderIndex(m);
  if(hr<0) return {records:[], statedTotals:[]};
  const headers=m[hr].map(norm),records=[],nextId=identityCounter();
  const statedMap=new Map(); // personName -> {personName, stated, currency, sourceSheet}
  for(let c=0;c<headers.length-2;c++){
    if(headers[c]!=='narration'||headers[c+1]!=='paid'||headers[c+2]!=='owe')continue;
    // Find total column if exists
    let totalC=-1;
    if(headers[c+3]==='total') totalC=c+3;
    else{
      for(let k=c+3;k<Math.min(headers.length,c+6);k++) if(headers[k]==='total'){ totalC=k; break; }
    }
    let section='';for(let r=hr-1;r>=0&&!section;r--)section=asText(m[r]?.[c]);section=section||sheet.name;
    const person=cleanPersonName(section);
    for(let r=hr+1;r<m.length;r++){
      const narration=asText(m[r]?.[c]),paid=money(m[r]?.[c+1]),owe=money(m[r]?.[c+2]);
      const p=Number.isFinite(paid)?Math.abs(paid):0,o=Number.isFinite(owe)?Math.abs(owe):0;
      const totalVal = totalC>=0 ? money(m[r]?.[totalC]) : NaN;
      if(!narration&&!p&&!o&&!Number.isFinite(totalVal))continue;
      if(/^total\b/i.test(narration)){
        // Capture stated total instead of discarding
        if(Number.isFinite(totalVal)){
          // Stated is -total to match expected sign (total column is negative of balance)
          const stated = -totalVal;
          statedMap.set(person, {personName:person, stated, currency:'USD', sourceSheet:sheet.name});
        }
        continue;
      }
      const date=excelDate(narration)||UNKNOWN_DATE,dateUnknown=date===UNKNOWN_DATE;
      const base=`${norm(section)}|row${r+1}`;
      if(p)addRecord(records,{kind:'person_adjustment',personName:person,amount:p,signedAmount:p,date,dateUnknown,description:narration||'Legacy paid amount',sourceSheet:sheet.name,identity:nextId(`${base}|paid`)});
      if(o)addRecord(records,{kind:'person_adjustment',personName:person,amount:o,signedAmount:-o,date,dateUnknown,description:narration||'Legacy owed amount',sourceSheet:sheet.name,identity:nextId(`${base}|owe`)});
    }
  }
  return {records, statedTotals:Array.from(statedMap.values())};
}

function parseTroy(sheet){
  if(!/troy/i.test(sheet.name))return {records:[], statedTotals:[]};
  const m=sheetMatrix(sheet);let hr=-1;for(let r=0;r<Math.min(6,m.length);r++){const row=m[r].map(norm);if(row.includes('course name')&&row.some(x=>x==='paid')&&row.some(x=>x==='balance')){hr=r;break;}}
  if(hr<0)return {records:[], statedTotals:[]};
  const records=[],nextId=identityCounter(),person='SHANDRIEKA';
  const rowh=m[hr].map(norm),nameC=rowh.indexOf('course name'),paidC=rowh.indexOf('paid'),oweC=rowh.indexOf('owe'),balC=rowh.indexOf('balance');
  let lastBalance=null;
  let statedTotals=[];
  const statedMap=new Map();
  for(let r=hr+1;r<m.length;r++){
    const desc=asText(m[r]?.[nameC]);if(!desc)continue;
    const paid=paidC>=0?money(m[r]?.[paidC]):NaN,owe=oweC>=0?money(m[r]?.[oweC]):NaN,bal=balC>=0?money(m[r]?.[balC]):NaN;
    const base=`row${r}`;
    if(Number.isFinite(bal)) lastBalance=bal;
    if(/^total courses/i.test(desc)){
      // On total courses row emit only balance record, never owe/paid
      if(Number.isFinite(bal)&&bal!==0){
        addRecord(records,{kind:'person_adjustment',personName:person,amount:Math.abs(bal),signedAmount:Math.abs(bal),date:UNKNOWN_DATE,dateUnknown:true,description:desc,sourceSheet:sheet.name,identity:nextId(`${base}|charge`)});
        // Capture stated total as -balance (to match expected sign)
        statedMap.set(person, {personName:person, stated:-bal, currency:'USD', sourceSheet:sheet.name});
      }
      continue;
    }
    if(Number.isFinite(owe)&&Math.abs(owe)>0)addRecord(records,{kind:'person_adjustment',personName:person,amount:Math.abs(owe),signedAmount:Math.abs(owe),date:excelDate(desc)||UNKNOWN_DATE,dateUnknown:!excelDate(desc),description:desc,sourceSheet:sheet.name,identity:nextId(`${base}|owe`)});
    if(Number.isFinite(paid)&&Math.abs(paid)>0)addRecord(records,{kind:'person_adjustment',personName:person,amount:Math.abs(paid),signedAmount:-Math.abs(paid),date:excelDate(desc)||UNKNOWN_DATE,dateUnknown:!excelDate(desc),description:desc,sourceSheet:sheet.name,identity:nextId(`${base}|payment`)});
  }
  // If we have lastBalance, use it as final stated total (overwrites total courses if present)
  if(Number.isFinite(lastBalance)){
    statedMap.set(person, {personName:person, stated:-lastBalance, currency:'USD', sourceSheet:sheet.name});
  }
  return {records, statedTotals:Array.from(statedMap.values())};
}

function parseUwa(sheet){
  if(!/uwa/i.test(sheet.name))return {records:[], statedTotals:[]};
  const m=sheetMatrix(sheet);let hr=-1;for(let r=0;r<Math.min(6,m.length);r++){const row=m[r].map(norm);if(row.includes('amount due')&&row.includes('amount paid')){hr=r;break;}}
  if(hr<0)return {records:[], statedTotals:[]};
  const h=m[hr].map(norm),codeC=h.indexOf('course number'),nameC=h.indexOf('course name'),dueC=h.indexOf('amount due'),dateC=h.indexOf('date paid'),paidC=h.indexOf('amount paid');
  const records=[],nextId=identityCounter(),person='SHANDRIEKA';
  let totalPaid=null;
  let totalDue=null;
  let lastDue=null;
  for(let r=hr+1;r<m.length;r++){
    const code=asText(m[r]?.[codeC]),name=asText(m[r]?.[nameC]);
    if(/^total paid|^left to receive/i.test(code||name)){
      const paid=money(m[r]?.[paidC]);
      const due=money(m[r]?.[dueC]);
      if(Number.isFinite(paid)) totalPaid=paid;
      if(Number.isFinite(due)) totalDue=due;
      break;
    }
    const due=money(m[r]?.[dueC]),paid=money(m[r]?.[paidC]),date=excelDate(m[r]?.[dateC]);
    if(Number.isFinite(due)&&Math.abs(due)>0) lastDue=due;
    if(Number.isFinite(due)&&Math.abs(due)>0&&name){const desc=`UWA course${code?` ${code}`:''}: ${name}`;addRecord(records,{kind:'person_adjustment',personName:person,amount:Math.abs(due),signedAmount:Math.abs(due),date:UNKNOWN_DATE,dateUnknown:true,description:desc,sourceSheet:sheet.name,identity:nextId(`course|row${r}|due`)});}
    if(Number.isFinite(paid)&&Math.abs(paid)>0){const desc=`UWA payment${name?` — ${name}`:''}`;addRecord(records,{kind:'person_adjustment',personName:person,amount:Math.abs(paid),signedAmount:-Math.abs(paid),date:date||UNKNOWN_DATE,dateUnknown:!date,description:desc,sourceSheet:sheet.name,identity:nextId(`payment|row${r}|${date||r}`)});}
  }
  const statedTotals=[];
  if(Number.isFinite(totalPaid)){
    // For UWA, total paid is sum of payments, stated final balance would be totalDue - totalPaid if available, else -totalPaid
    // We will capture stated as (totalDue!=null? totalDue - totalPaid : -totalPaid) to allow reconciliation
    let stated;
    if(Number.isFinite(totalDue)){
      stated = totalDue - totalPaid;
    }else{
      // If no totalDue, use -totalPaid as stated (payment side)
      stated = -totalPaid;
    }
    statedTotals.push({personName:person, stated, currency:'USD', sourceSheet:sheet.name, note:'UWA total'});
  }else if(Number.isFinite(lastDue)){
    // fallback: use last due as stated?
    statedTotals.push({personName:person, stated:lastDue, currency:'USD', sourceSheet:sheet.name});
  }
  return {records, statedTotals};
}

function parseMonthlySpending(sheet){
  if(!/monthly spending/i.test(sheet.name))return {records:[], statedTotals:[]};
  const m=sheetMatrix(sheet);let hr=-1;for(let r=0;r<Math.min(5,m.length);r++){const row=m[r].map(norm);if(row.includes('date')&&row.includes('narration')&&row.includes('amount')&&row.includes('total')){hr=r;break;}}
  if(hr<0)return {records:[], statedTotals:[]};
  const h=m[hr].map(norm),dateC=h.indexOf('date'),narrC=h.indexOf('narration'),amtC=h.indexOf('amount'),records=[],nextId=identityCounter();
  for(let r=hr+1;r<m.length;r++){
    const desc=asText(m[r]?.[narrC]),amt=money(m[r]?.[amtC]);if(!desc||!Number.isFinite(amt)||Math.abs(amt)<=0)continue;
    const date=excelDate(m[r]?.[dateC])||UNKNOWN_DATE,n=norm(desc),income=/money for the month|funding|received|deposit|credit|income/.test(n);
    addRecord(records,{kind:income?'account_income':'account_expense',accountName:'MONTHLY SPENDING',accountType:'cash',amount:Math.abs(amt),date,dateUnknown:date===UNKNOWN_DATE,description:desc,sourceSheet:sheet.name,identity:nextId(`${norm(desc)}|${r}|${income?'in':'out'}`)});
  }
  return {records, statedTotals:[]};
}

function parseLubumbashiCash(sheet){
  if(!/lubumbashi money payments/i.test(sheet.name))return {records:[], statedTotals:[]};
  const m=sheetMatrix(sheet);let hr=-1;for(let r=0;r<Math.min(5,m.length);r++){const row=m[r].map(norm);if(row.includes('narration')&&row.includes('credit')&&row.includes('debit')){hr=r;break;}}
  if(hr<0)return {records:[], statedTotals:[]};
  const h=m[hr].map(norm);let c=h.indexOf('narration');if(c<0)return {records:[], statedTotals:[]};
  const dateC=c-1,creditC=h.indexOf('credit',c),debitC=h.indexOf('debit',c),records=[],nextId=identityCounter();
  for(let r=hr+1;r<m.length;r++){
    const desc=asText(m[r]?.[c]),credit=money(m[r]?.[creditC]),debit=money(m[r]?.[debitC]),date=excelDate(m[r]?.[dateC])||UNKNOWN_DATE;if(!desc&&!Number.isFinite(credit)&&!Number.isFinite(debit))continue;
    if(Number.isFinite(credit)&&Math.abs(credit)>0)addRecord(records,{kind:'account_income',accountName:'CASH MONEY',accountType:'cash',amount:Math.abs(credit),date,dateUnknown:date===UNKNOWN_DATE,description:desc||'Legacy cash credit',sourceSheet:sheet.name,identity:nextId(`${norm(desc)||r}|credit`)});
    if(Number.isFinite(debit)&&Math.abs(debit)>0)addRecord(records,{kind:'account_expense',accountName:'CASH MONEY',accountType:'cash',amount:Math.abs(debit),date,dateUnknown:date===UNKNOWN_DATE,description:desc||'Legacy cash debit',sourceSheet:sheet.name,identity:nextId(`${norm(desc)||r}|debit`)});
  }
  return {records, statedTotals:[]};
}

function normalizeParseResult(result){
  if(Array.isArray(result)) return {records:result, statedTotals:[]};
  if(result && typeof result==='object' && Array.isArray(result.records)) return {records:result.records, statedTotals: result.statedTotals||[]};
  return {records:[], statedTotals:[]};
}

export function analyzeLegacyWorkbook(workbook){
  const sheets=workbook?.sheets||[],records=[];const recognized=[];const ignored=[];
  const allStatedTotals=[];
  for(const sheet of sheets){
    const n=norm(sheet.name);let parsed={records:[], statedTotals:[]};
    if(n==='course payments'){ignored.push({sheet:sheet.name,reason:'Summary sheet skipped to avoid double-counting detailed course ledgers.'});continue;}
    if(n.includes('troy'))parsed=normalizeParseResult(parseTroy(sheet));
    else if(n.includes('uwa'))parsed=normalizeParseResult(parseUwa(sheet));
    else if(n.includes('monthly spending'))parsed=normalizeParseResult(parseMonthlySpending(sheet));
    else if(n.includes('lubumbashi money payments'))parsed=normalizeParseResult(parseLubumbashiCash(sheet));
    else parsed=normalizeParseResult(parseLedgerSheet(sheet));
    if(parsed.records.length){records.push(...parsed.records);recognized.push({sheet:sheet.name,count:parsed.records.length});}
    else if(/money|payment|course|shipping|debt|dakik|spending/i.test(sheet.name))ignored.push({sheet:sheet.name,reason:'No safe transaction pattern was found; left untouched.'});
    if(parsed.statedTotals && parsed.statedTotals.length) allStatedTotals.push(...parsed.statedTotals);
  }
  const people=[...new Set(records.filter(r=>r.kind==='person_adjustment').map(r=>r.personName))];
  const accounts=[...new Set(records.filter(r=>r.kind!=='person_adjustment').map(r=>r.accountName))];
  const unknownDates=records.filter(r=>r.dateUnknown).length;
  const signatureHits=sheets.filter(s=>/DAKIK PAYMENTS|DEBT PAYMENTS|TROY UNIVERSITY|UWA SHANDRIEKA|COURSE PAYMENTS|LUBUMBASHI MONEY PAYMENTS|MONTHLY SPENDING|shipping/i.test(s.name)).length;

  // Compute expectedBalances per person (signed sum)
  const expectedMap=new Map();
  for(const rec of records){
    if(rec.kind!=='person_adjustment') continue;
    const cur = expectedMap.get(rec.personName) || 0;
    expectedMap.set(rec.personName, cur + Number(rec.signedAmount||0));
  }
  const expectedBalances = Array.from(expectedMap.entries()).map(([personName, expected])=>({personName, expected, currency:'USD'}));

  // Aggregate statedTotals per person (sum if multiple sheets)
  const statedMap=new Map();
  for(const st of allStatedTotals){
    const cur = statedMap.get(st.personName) || 0;
    statedMap.set(st.personName, cur + Number(st.stated||0));
  }

  // Build reconciliation array - only for persons where stated exists
  const reconciliation = Array.from(statedMap.entries()).map(([personName, stated])=>{
    const expected = expectedMap.get(personName) || 0;
    const delta = expected - stated;
    return {personName, expected, stated, delta};
  });

  return {
    recognized:records.length>0&&(signatureHits>=2||recognized.length>=3),
    records,
    recognizedSheets:recognized,
    ignoredSheets:ignored,
    people,
    accounts,
    unknownDates,
    statedTotals: allStatedTotals,
    expectedBalances,
    reconciliation
  };
}

function equalEntry(a,b){
  const keys=['type','personId','accountId','amount','currency','signedAmount','date','merchant'];
  return keys.every(k=>(a?.[k]??null)===(b?.[k]??null));
}
function normalizeName(v){return norm(v);}

export function applyLegacyWorkbook({state,workbook,uidFactory,nowIso=()=>new Date().toISOString()}){
  if(typeof uidFactory!=='function')throw new Error('Import ID generator is required.');
  const analysis=analyzeLegacyWorkbook(workbook);if(!analysis.recognized)throw new Error('This does not look like the legacy money workbook.');
  const next=clone(state),defaultCurrency=next.settings?.defaultCurrency||'USD',result={people:0,accounts:0,entries:0,updated:0,skipped:0,warnings:analysis.ignoredSheets.map(x=>`${x.sheet}: ${x.reason}`),analysis};
  const stamp=()=>nowIso();
  const personMap=new Map((next.people||[]).map(p=>[normalizeName(p.name),p]));
  const accountMap=new Map((next.accounts||[]).map(a=>[`${normalizeName(a.name)}|${a.currency}`,a]));
  const sourceMap=new Map((next.entries||[]).filter(e=>String(e.merchant||'').startsWith(LEGACY_PREFIX)).map(e=>[e.merchant,e]));
  function getPerson(name){const key=normalizeName(name);let p=personMap.get(key);if(!p){p={id:uidFactory('person'),name,note:'Imported from legacy Excel',createdAt:stamp()};next.people.push(p);personMap.set(key,p);result.people++;}return p;}
  function getAccount(name,type='other'){const key=`${normalizeName(name)}|${defaultCurrency}`;let a=accountMap.get(key);if(!a){a={id:uidFactory('account'),name,type,currency:defaultCurrency,openingBalance:0,createdAt:stamp()};next.accounts.push(a);accountMap.set(key,a);result.accounts++;}return a;}
  for(const record of analysis.records){
    const merchant=sourceMerchant(record.sourceSheet,record.identity),created=stamp();let entry;
    const desc=record.dateUnknown?`${record.description} · Legacy date not recorded`:record.description;
    if(record.kind==='person_adjustment'){
      const p=getPerson(record.personName);entry={id:uidFactory('entry'),type:'person_adjustment',personId:p.id,accountId:null,fromAccountId:null,toAccountId:null,amount:record.amount,currency:defaultCurrency,fromAmount:null,toAmount:null,signedAmount:record.signedAmount,date:record.date,merchant,description:desc,categoryId:null,splits:[],createdAt:created,updatedAt:created};
    }else{
      const a=getAccount(record.accountName,record.accountType);entry={id:uidFactory('entry'),type:record.kind,personId:null,accountId:a.id,fromAccountId:null,toAccountId:null,amount:record.amount,currency:a.currency,fromAmount:null,toAmount:null,signedAmount:null,date:record.date,merchant,description:desc,categoryId:null,splits:[],createdAt:created,updatedAt:created};
    }
    const existing=sourceMap.get(merchant);
    if(existing){
      const candidate={...entry,id:existing.id,createdAt:existing.createdAt||entry.createdAt,updatedAt:existing.updatedAt||entry.updatedAt};
      const isEqual = equalEntry(existing,candidate);
      const descDiff = (existing.description||'') !== (candidate.description||'');
      if(isEqual && !descDiff){result.skipped++;continue;}
      // If equalEntry true but description differs, or not equal, update
      const idx=next.entries.findIndex(e=>e.id===existing.id);if(idx>=0){candidate.updatedAt=created;next.entries[idx]=candidate;sourceMap.set(merchant,candidate);result.updated++;continue;}
    }
    next.entries.push(entry);sourceMap.set(merchant,entry);result.entries++;
  }
  return {state:next,result};
}

export { UNKNOWN_DATE, LEGACY_PREFIX };
