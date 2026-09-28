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
  const s=String(value??'').trim();if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;const d=new Date(s);return Number.isNaN(d.getTime())?'':d.toISOString().slice(0,10);
}
export function currencyValue(value,fallback='USD'){const c=String(value||fallback).trim().toUpperCase();return /^[A-Z]{3,5}$/.test(c)?c:fallback;}
export function accountType(value){const n=normalize(value);if(n.includes('bank'))return 'bank';if(n.includes('cash'))return 'cash';if(n.includes('card'))return 'card';if(n.includes('wallet'))return 'wallet';return 'other';}
export function transactionType(value){
  const raw=String(value||'');if(['paid_for_person','received_from_person','borrowed_from_person','paid_to_person','person_adjustment','account_transfer'].includes(raw))return raw;
  const n=normalize(raw),map={paid_for_person:['paid for person','paid for someone','purchase for','i paid'],received_from_person:['received from person','received repayment','paid me back','got paid back'],borrowed_from_person:['borrowed from person','borrowed','loan from'],paid_to_person:['paid person back','paid to person','repaid','paid them back'],person_adjustment:['person adjustment','balance adjustment','opening balance'],account_transfer:['account transfer','transfer']};
  for(const [type,aliases] of Object.entries(map))if(aliases.some(a=>n===normalize(a)||n.includes(normalize(a))))return type;return '';
}
export function directionSign(value,rawAmount=0){const n=normalize(value);if(n.includes('i owe')||n.includes('owe them')||n.includes('negative')||n==='debt')return -1;if(n.includes('they owe')||n.includes('owed to me')||n.includes('positive'))return 1;return Number(rawAmount)<0?-1:1;}

function cloneState(state){return typeof structuredClone==='function'?structuredClone(state):JSON.parse(JSON.stringify(state));}
function column(row,mapping,key){const name=mapping?.[key];return name?row?.[name]:'';}
function findPerson(state,name){const n=normalize(name);return state.people.find(p=>normalize(p.name)===n);}
function findAccount(state,name,currency){const n=normalize(name);return state.accounts.find(a=>normalize(a.name)===n&&(!currency||a.currency===currency));}
function duplicateKey(e){return [e.date,e.type,e.personId||'',e.accountId||'',e.fromAccountId||'',e.toAccountId||'',Number(e.amount||0),Number(e.fromAmount||0),Number(e.toAmount||0),e.description||'',e.merchant||''].join('|');}

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
      const raw=parseMoney(column(row,mapping,'balance'));if(!Number.isFinite(raw)||Math.abs(raw)<1e-12)return;
      const amount=Math.abs(raw),currency=currencyValue(column(row,mapping,'currency'),defaultCurrency),sign=directionSign(column(row,mapping,'direction'),raw),created=now();
      next.entries.push({id:id('entry'),type:'person_adjustment',personId:person.id,accountId:null,fromAccountId:null,toAccountId:null,amount,currency,fromAmount:null,toAmount:null,signedAmount:sign*amount,date:dateValue(column(row,mapping,'date'))||today(),merchant:'',description:String(column(row,mapping,'description')||'Imported opening balance').trim()||'Imported opening balance',createdAt:created,updatedAt:created});result.entries++;
    });
  }

  if(mode==='accounts'){
    rows.forEach((row,index)=>{
      const name=String(column(row,mapping,'name')||'').trim();if(!name){result.skipped++;result.errors.push(`Row ${index+2}: missing account name.`);return;}
      const currency=currencyValue(column(row,mapping,'currency'),defaultCurrency);if(findAccount(next,name,currency)){result.skipped++;return;}
      const opening=parseMoney(column(row,mapping,'openingBalance'));next.accounts.push({id:id('account'),name,type:accountType(column(row,mapping,'type')),currency,openingBalance:Number.isFinite(opening)?opening:0,createdAt:now()});result.accounts++;
    });
  }

  if(mode==='transactions'){
    const existing=new Set(next.entries.map(duplicateKey));
    rows.forEach((row,index)=>{
      const type=transactionType(column(row,mapping,'type')),date=dateValue(column(row,mapping,'date')),raw=parseMoney(column(row,mapping,'amount')),amount=Math.abs(raw),currency=currencyValue(column(row,mapping,'currency'),defaultCurrency);
      if(!type||!date||!(amount>0)){result.skipped++;result.errors.push(`Row ${index+2}: needs a valid date, supported type, and positive amount.`);return;}
      const created=now(),description=String(column(row,mapping,'description')||'').trim(),merchant=String(column(row,mapping,'merchant')||'').trim();let entry={id:id('entry'),type,amount,date,merchant,description,createdAt:created,updatedAt:created};
      if(type==='account_transfer'){
        const fromName=String(column(row,mapping,'fromAccount')||'').trim(),toName=String(column(row,mapping,'toAccount')||'').trim();const fa=Math.abs(parseMoney(column(row,mapping,'fromAmount'))||amount),ta=Math.abs(parseMoney(column(row,mapping,'toAmount'))||amount);
        if(!fromName||!toName||normalize(fromName)===normalize(toName)||!(fa>0)||!(ta>0)){result.skipped++;result.errors.push(`Row ${index+2}: transfer needs different from/to accounts and amounts.`);return;}const from=getAccount(fromName,currency),to=getAccount(toName,currency);
        if(from.id===to.id){result.skipped++;result.errors.push(`Row ${index+2}: transfer accounts resolve to the same account.`);return;}
        entry={...entry,personId:null,accountId:null,fromAccountId:from.id,toAccountId:to.id,fromAmount:fa,toAmount:ta,amount:fa,currency:null,signedAmount:null};
      }else{
        const personName=String(column(row,mapping,'person')||'').trim();if(!personName){result.skipped++;result.errors.push(`Row ${index+2}: person is required for this transaction type.`);return;}
        const accountName=String(column(row,mapping,'account')||'').trim();if(type!=='person_adjustment'&&!accountName){result.skipped++;result.errors.push(`Row ${index+2}: account is required for this transaction type.`);return;}const person=getPerson(personName);
        entry={...entry,personId:person.id,fromAccountId:null,toAccountId:null,fromAmount:null,toAmount:null};
        if(type==='person_adjustment'){
          const signed=parseMoney(column(row,mapping,'signedAmount'));entry.accountId=null;entry.currency=currency;entry.signedAmount=Number.isFinite(signed)&&signed!==0?(signed<0?-amount:amount):directionSign(column(row,mapping,'direction'),raw)*amount;
        }else{
          const account=getAccount(accountName,currency);entry.accountId=account.id;entry.currency=account.currency;entry.signedAmount=null;
        }
      }
      const key=duplicateKey(entry);if(existing.has(key)){result.skipped++;return;}existing.add(key);next.entries.push(entry);result.entries++;
    });
  }
  return {state:next,result};
}
