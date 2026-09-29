import { normalizeMoney, sumMinor, toMinor } from './money.js';

export const IMPORT_MODES=['people','accounts','transactions'];

export function normalize(value=''){return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
export function guessHeader(headers,aliases){
  let best='',score=0;
  for(const header of headers||[]){const n=normalize(header);for(const alias of aliases||[]){const a=normalize(alias);const s=n===a?100:(n&&a&&(n.includes(a)||a.includes(n))?50:0);if(s>score){score=s;best=header;}}}
  return best;
}
export function detectImportMode(headers=[]){
  const h=headers.map(normalize);
  if(h.some(x=>x==='date'||x.includes('transaction date'))&&h.some(x=>x==='amount'||x.includes('amount')))return 'transactions';
  if(h.some(x=>x.includes('opening balance'))&&h.some(x=>x==='type'||x.includes('account type')))return 'accounts';
  return 'people';
}
export function parseMoney(value){if(typeof value==='number')return Number.isFinite(value)?value:NaN;const n=Number(String(value??'').trim().replace(/\s/g,'').replace(/,/g,''));return Number.isFinite(n)?n:NaN;}
export function dateValue(value){
  if(typeof value==='number'&&value>1000&&value<100000){const d=new Date(Date.UTC(1899,11,30)+Math.round(value)*86400000);return d.toISOString().slice(0,10);}
  const s=String(value??'').trim();if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;
  const slash=/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(s);
  if(slash){
    const a=Number(slash[1]),b=Number(slash[2]),year=Number(slash[3]);
    const day=a>12?a:b>12?b:a,month=a>12?b:b>12?a:b;
    const d=new Date(Date.UTC(year,month-1,day));
    if(d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day)return d.toISOString().slice(0,10);
    return '';
  }
  const d=new Date(s);return Number.isNaN(d.getTime())?'':d.toISOString().slice(0,10);
}
export function currencyValue(value,fallback='USD'){const c=String(value||fallback).trim().toUpperCase();return /^[A-Z]{3,5}$/.test(c)?c:fallback;}
export function accountType(value){const n=normalize(value);if(n.includes('bank'))return 'bank';if(n.includes('cash'))return 'cash';if(n.includes('card'))return 'card';if(n.includes('wallet'))return 'wallet';return 'other';}
export function transactionType(value){
  const raw=String(value||'');if(['paid_for_person','received_from_person','borrowed_from_person','paid_to_person','person_adjustment','account_transfer','split_paid_for_people','account_expense','account_income'].includes(raw))return raw;
  const n=normalize(raw),map={paid_for_person:['paid for person','paid for someone','purchase for','i paid'],received_from_person:['received from person','received repayment','paid me back','got paid back'],borrowed_from_person:['borrowed from person','borrowed','loan from'],paid_to_person:['paid person back','paid to person','repaid','paid them back'],person_adjustment:['person adjustment','balance adjustment','opening balance'],account_transfer:['account transfer','transfer'],account_adjustment:['account adjustment'],account_expense:['account expense','expense','bank expense','personal expense'],account_income:['account income','income','bank income','deposit'],split_paid_for_people:['split paid for people','split purchase','split paid for','shared purchase']};
  for(const [type,aliases] of Object.entries(map))if(aliases.some(a=>n===normalize(a)||n.includes(normalize(a))))return type;return '';
}
export function directionSign(value,rawAmount=0){const n=normalize(value);if(n.includes('i owe')||n.includes('owe them')||n.includes('negative')||n==='debt')return -1;if(n.includes('they owe')||n.includes('owed to me')||n.includes('positive'))return 1;return Number(rawAmount)<0?-1:1;}

function cloneState(state){return typeof structuredClone==='function'?structuredClone(state):JSON.parse(JSON.stringify(state));}
function column(row,mapping,key){const name=mapping?.[key];return name?row?.[name]:'';}
function findPerson(state,name){const n=normalize(name);return state.people.find(p=>normalize(p.name)===n);}
function findAccount(state,name,currency){const n=normalize(name);return state.accounts.find(a=>normalize(a.name)===n&&(!currency||a.currency===currency));}
function findCategory(state,name,type){const n=normalize(name);if(!n)return null;const wanted=type==='account_income'?'income':'expense';return (state.categories||[]).find(c=>normalize(c.name)===n&&(c.kind===wanted||c.kind==='both'));}
function splitKey(splits=[]){return JSON.stringify((splits||[]).map(s=>[s.personId,Number(s.amount||0),s.note||'']).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));}
function duplicateKey(e){return [e.date,e.type,e.personId||'',e.accountId||'',e.fromAccountId||'',e.toAccountId||'',e.currency||'',Number(e.amount||0),Number(e.fromAmount||0),Number(e.toAmount||0),Number(e.signedAmount||0),e.categoryId||'',e.description||'',e.merchant||'',splitKey(e.splits)].join('|');}
export function parseSplitDetails(value=''){
  const out=[];
  for(const part of String(value||'').split('|').map(x=>x.trim()).filter(Boolean)){
    const m=/^(.+?):\s*(-?[\d,]+(?:\.\d+)?)\s*(?:\((.*)\))?$/.exec(part);
    if(!m)return [];
    const amount=Math.abs(parseMoney(m[2])); if(!(amount>0))return [];
    out.push({name:m[1].trim(),amount,note:String(m[3]||'').trim()});
  }
  return out;
}

export const QUICK_PASTE_COLUMNS=['Name','Amount','Direction','Merchant / Source','Date','Description','Currency'];

function parseClipboardGrid(text=''){
  const source=String(text??'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  if(!source.trim())return [];
  const delimiter=source.includes('\t')?'\t':',',rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<source.length;i++){
    const ch=source[i];
    if(quoted){
      if(ch==='"'&&source[i+1]==='"'){cell+='"';i++;}
      else if(ch==='"')quoted=false;
      else cell+=ch;
      continue;
    }
    if(ch==='"'){quoted=true;continue;}
    if(ch===delimiter){row.push(cell);cell='';continue;}
    if(ch==='\n'){row.push(cell);if(row.some(v=>String(v).trim()))rows.push(row);row=[];cell='';continue;}
    cell+=ch;
  }
  row.push(cell);if(row.some(v=>String(v).trim()))rows.push(row);
  return rows;
}
function quickHeaderIndex(headers,aliases){const normalized=headers.map(normalize);for(const alias of aliases){const i=normalized.indexOf(normalize(alias));if(i>=0)return i;}return -1;}
function quickDirectionSign(value,rawAmount=0){
  const raw=String(value??'').trim(),n=normalize(raw);
  if(raw==='+')return 1;if(raw==='-')return -1;
  if(['they owe me','owes me','owe me','owed to me','add','plus','increase'].some(x=>n===normalize(x)||n.includes(normalize(x))))return 1;
  if(['took from them','i took from them','they paid me','paid me','received from them','payment from them','subtract','minus','reduce','decrease'].some(x=>n===normalize(x)||n.includes(normalize(x))))return -1;
  if(!n&&Number(rawAmount)<0)return -1;
  return 0;
}
export function parseQuickPaste(text=''){
  const grid=parseClipboardGrid(text),errors=[];if(!grid.length)return {rows:[],errors,totalRows:0,headerDetected:false};
  const first=grid[0].map(v=>String(v||'').trim()),nameHeader=quickHeaderIndex(first,['name','person','person name','contact']),amountHeader=quickHeaderIndex(first,['amount','total','total amount','balance']);
  const headerDetected=nameHeader>=0&&amountHeader>=0,headers=headerDetected?first:QUICK_PASTE_COLUMNS,dataRows=headerDetected?grid.slice(1):grid;
  const indexes={
    name:headerDetected?quickHeaderIndex(headers,['name','person','person name','contact']):0,
    amount:headerDetected?quickHeaderIndex(headers,['amount','total','total amount','balance']):1,
    direction:headerDetected?quickHeaderIndex(headers,['direction','effect','action','owe direction','owed direction']):2,
    merchant:headerDetected?quickHeaderIndex(headers,['merchant / source','merchant source','merchant','source','vendor','store']):3,
    date:headerDetected?quickHeaderIndex(headers,['date','transaction date']):4,
    description:headerDetected?quickHeaderIndex(headers,['description','note','notes','memo','details']):5,
    currency:headerDetected?quickHeaderIndex(headers,['currency','curr']):6
  };
  const rows=[];
  dataRows.forEach((cells,index)=>{
    const rowNumber=index+(headerDetected?2:1),at=key=>indexes[key]>=0?String(cells[indexes[key]]??'').trim():'';
    const name=at('name'),raw=parseMoney(at('amount')),direction=at('direction'),sign=quickDirectionSign(direction,raw),date=dateValue(at('date'));
    if(!name){errors.push(`Row ${rowNumber}: missing person name.`);return;}
    if(!Number.isFinite(raw)||raw===0){errors.push(`Row ${rowNumber}: amount must be a non-zero number.`);return;}
    if(!sign){errors.push(`Row ${rowNumber}: direction must be “They owe me” or “Took from them” (aliases like “They paid me” also work).`);return;}
    if(!date){errors.push(`Row ${rowNumber}: add a valid date (YYYY-MM-DD or DD/MM/YYYY).`);return;}
    rows.push({
      Person:name,
      Amount:Math.abs(raw),
      Direction:sign>0?'They owe me':'Took from them',
      'Signed Amount':sign*Math.abs(raw),
      Merchant:at('merchant'),
      Date:date,
      Description:at('description'),
      Currency:at('currency'),
      Type:'person_adjustment'
    });
  });
  return {rows,errors,totalRows:dataRows.length,headerDetected};
}
export function applyQuickPasteImport({state,text='',uidFactory,nowIso=()=>new Date().toISOString()}){
  const parsed=parseQuickPaste(text);
  const prepared=applyImport({
    state,
    rows:parsed.rows,
    mode:'transactions',
    mapping:{person:'Person',amount:'Amount',direction:'Direction',signedAmount:'Signed Amount',merchant:'Merchant',date:'Date',description:'Description',currency:'Currency',type:'Type'},
    uidFactory,
    nowIso
  });
  prepared.result.sourceRows=parsed.totalRows;
  prepared.result.validRows=parsed.rows.length;
  prepared.result.headerDetected=parsed.headerDetected;
  prepared.result.skipped+=parsed.errors.length;
  prepared.result.errors=[...parsed.errors,...prepared.result.errors];
  return prepared;
}

export function applyImport({state,rows=[],mode,mapping={},uidFactory,nowIso=()=>new Date().toISOString(),today=()=>new Date().toISOString().slice(0,10)}){
  if(!IMPORT_MODES.includes(mode))throw new Error('Unsupported import mode.');
  if(typeof uidFactory!=='function')throw new Error('Import ID generator is required.');
  const next=cloneState(state),result={people:0,accounts:0,entries:0,skipped:0,errors:[]};
  const defaultCurrency=next.settings?.defaultCurrency||'USD';
  const id=prefix=>uidFactory(prefix),now=()=>nowIso();

  const getPerson=name=>{if(!String(name||'').trim())return null;let p=findPerson(next,name);if(!p){p={id:id('person'),name:String(name).trim(),note:'Imported',createdAt:now()};next.people.push(p);result.people++;}return p;};
  const getAccount=(name,currency)=>{if(!String(name||'').trim())return null;let a=findAccount(next,name,currency);if(!a){a={id:id('account'),name:String(name).trim(),type:'other',currency,openingBalance:0,createdAt:now()};next.accounts.push(a);result.accounts++;}return a;};

  if(mode==='people'){
    rows.forEach((row,index)=>{
      const name=String(column(row,mapping,'name')||'').trim();if(!name){result.skipped++;result.errors.push(`Row ${index+2}: missing name.`);return;}
      let person=findPerson(next,name);const note=String(column(row,mapping,'note')||'').trim();
      if(!person){person={id:id('person'),name,note,createdAt:now()};next.people.push(person);result.people++;}else if(note&&!person.note)person.note=note;
      const raw=parseMoney(column(row,mapping,'balance'));if(!Number.isFinite(raw)||raw===0)return;
      const currency=currencyValue(column(row,mapping,'currency'),defaultCurrency),sign=directionSign(column(row,mapping,'direction'),raw),created=now();let amount;
      try{amount=normalizeMoney(Math.abs(raw),currency,{allowNegative:false,allowZero:false});}catch(error){result.skipped++;result.errors.push(`Row ${index+2}: ${error.message}`);return;}
      next.entries.push({id:id('entry'),type:'person_adjustment',personId:person.id,accountId:null,fromAccountId:null,toAccountId:null,amount,currency,fromAmount:null,toAmount:null,signedAmount:sign*amount,date:dateValue(column(row,mapping,'date'))||today(),merchant:'',description:String(column(row,mapping,'description')||'Imported opening balance').trim()||'Imported opening balance',createdAt:created,updatedAt:created});result.entries++;
    });
  }

  if(mode==='accounts'){
    rows.forEach((row,index)=>{
      const name=String(column(row,mapping,'name')||'').trim();if(!name){result.skipped++;result.errors.push(`Row ${index+2}: missing account name.`);return;}
      const currency=currencyValue(column(row,mapping,'currency'),defaultCurrency);if(findAccount(next,name,currency)){result.skipped++;return;}
      const opening=parseMoney(column(row,mapping,'openingBalance'));let openingBalance=0;
      if(Number.isFinite(opening)){try{openingBalance=normalizeMoney(opening,currency);}catch(error){result.skipped++;result.errors.push(`Row ${index+2}: ${error.message}`);return;}}
      next.accounts.push({id:id('account'),name,type:accountType(column(row,mapping,'type')),currency,openingBalance,createdAt:now()});result.accounts++;
    });
  }

  if(mode==='transactions'){
    const existingCounts=new Map();
    for(const prior of next.entries){
      const key=duplicateKey(prior);
      existingCounts.set(key,(existingCounts.get(key)||0)+1);
    }
    rows.forEach((row,index)=>{
      const type=transactionType(column(row,mapping,'type')),date=dateValue(column(row,mapping,'date')),raw=parseMoney(column(row,mapping,'amount')),currency=currencyValue(column(row,mapping,'currency'),defaultCurrency);
      if(!type||!date||!(Math.abs(raw)>0)){result.skipped++;result.errors.push(`Row ${index+2}: needs a valid date, supported type, and positive amount.`);return;}
      let amount;try{amount=normalizeMoney(Math.abs(raw),currency,{allowNegative:false,allowZero:false});}catch(error){result.skipped++;result.errors.push(`Row ${index+2}: ${error.message}`);return;}
      const created=now(),description=String(column(row,mapping,'description')||'').trim(),merchant=String(column(row,mapping,'merchant')||'').trim();let entry={id:id('entry'),type,amount,date,merchant,description,createdAt:created,updatedAt:created};
      if(type==='account_transfer'){
        const fromName=String(column(row,mapping,'fromAccount')||'').trim(),toName=String(column(row,mapping,'toAccount')||'').trim();let fa=Math.abs(parseMoney(column(row,mapping,'fromAmount'))||amount),ta=Math.abs(parseMoney(column(row,mapping,'toAmount'))||amount);
        if(!fromName||!toName||normalize(fromName)===normalize(toName)||!(fa>0)||!(ta>0)){result.skipped++;result.errors.push(`Row ${index+2}: transfer needs different from/to accounts and amounts.`);return;}
        try{fa=normalizeMoney(fa,currency,{allowNegative:false,allowZero:false});ta=normalizeMoney(ta,currency,{allowNegative:false,allowZero:false});}catch(error){result.skipped++;result.errors.push(`Row ${index+2}: ${error.message}`);return;}
        const from=getAccount(fromName,currency),to=getAccount(toName,currency);
        if(from.id===to.id){result.skipped++;result.errors.push(`Row ${index+2}: transfer accounts resolve to the same account.`);return;}
        entry={...entry,personId:null,accountId:null,fromAccountId:from.id,toAccountId:to.id,fromAmount:fa,toAmount:ta,amount:fa,currency:null,signedAmount:null,splits:[]};
      }else if(type==='split_paid_for_people'){
        const accountName=String(column(row,mapping,'account')||'').trim(),details=String(column(row,mapping,'splitDetails')||'').trim();
        if(!details){result.skipped++;result.errors.push(`Row ${index+2}: split purchase needs Split Details.`);return;}
        const parsed=parseSplitDetails(details);
        if(parsed.length<2){result.skipped++;result.errors.push(`Row ${index+2}: Split Details must contain at least two allocations like "Alice: 10 | Bob: 15".`);return;}
        const account=accountName?getAccount(accountName,currency):null,splitCurrency=account?.currency||currency;let splitMinors;
        try{splitMinors=parsed.map(s=>toMinor(s.amount,splitCurrency,{allowNegative:false,allowZero:false}));}catch(error){result.skipped++;result.errors.push(`Row ${index+2}: ${error.message}`);return;}
        if(sumMinor(splitMinors)!==toMinor(amount,splitCurrency)){result.skipped++;result.errors.push(`Row ${index+2}: split allocations must equal the transaction amount.`);return;}
        const splits=parsed.map((s,i)=>({personId:getPerson(s.name).id,amount:normalizeMoney(s.amount,splitCurrency,{allowNegative:false,allowZero:false}),note:s.note}));
        entry={...entry,personId:null,accountId:account?.id||null,fromAccountId:null,toAccountId:null,fromAmount:null,toAmount:null,currency:splitCurrency,signedAmount:null,splits};
      }else if(type==='account_adjustment'){
        const accountName=String(column(row,mapping,'account')||'').trim();
        if(!accountName){result.skipped++;result.errors.push(`Row ${index+2}: account is required for this transaction type.`);return;}
        const account=getAccount(accountName,currency),signed=parseMoney(column(row,mapping,'signedAmount'));
        entry={...entry,personId:null,accountId:account.id,fromAccountId:null,toAccountId:null,fromAmount:null,toAmount:null,currency:account.currency,signedAmount:Number.isFinite(signed)&&signed!==0?(signed<0?-amount:amount):directionSign(column(row,mapping,'direction'),raw)*amount,categoryId:null,splits:[]};
      }else if(type==='account_expense'||type==='account_income'){
        const accountName=String(column(row,mapping,'account')||'').trim();
        if(!accountName){result.skipped++;result.errors.push(`Row ${index+2}: account is required for this transaction type.`);return;}
        const account=getAccount(accountName,currency),categoryName=String(column(row,mapping,'category')||'').trim(),category=categoryName?findCategory(next,categoryName,type):null;
        if(categoryName&&!category)result.errors.push(`Row ${index+2}: category “${categoryName}” was not found or has the wrong type; imported as uncategorized.`);
        entry={...entry,personId:null,accountId:account.id,fromAccountId:null,toAccountId:null,fromAmount:null,toAmount:null,currency:account.currency,signedAmount:null,categoryId:category?.id||null,splits:[]};
      }else{
        const personName=String(column(row,mapping,'person')||'').trim();if(!personName){result.skipped++;result.errors.push(`Row ${index+2}: person is required for this transaction type.`);return;}
        const accountName=String(column(row,mapping,'account')||'').trim();const person=getPerson(personName);
        entry={...entry,personId:person.id,fromAccountId:null,toAccountId:null,fromAmount:null,toAmount:null,splits:[]};
        if(type==='person_adjustment'){
          const signed=parseMoney(column(row,mapping,'signedAmount'));entry.accountId=null;entry.currency=currency;entry.signedAmount=Number.isFinite(signed)&&signed!==0?(signed<0?-amount:amount):directionSign(column(row,mapping,'direction'),raw)*amount;
        }else{
          const account=accountName?getAccount(accountName,currency):null;entry.accountId=account?.id||null;entry.currency=account?.currency||currency;entry.signedAmount=null;
        }
      }
      const key=duplicateKey(entry),remaining=existingCounts.get(key)||0;
      if(remaining>0){
        existingCounts.set(key,remaining-1);
        result.skipped++;
        return;
      }
      next.entries.push(entry);result.entries++;
    });
  }
  return {state:next,result};
}
