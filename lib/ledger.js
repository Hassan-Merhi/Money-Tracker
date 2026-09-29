import { fromMinor, sumMinor, toMinor } from './money.js';

export const SPLIT_ENTRY_TYPE = 'split_paid_for_people';

export const PERSON_ENTRY_TYPES = [
  'paid_for_person',
  'received_from_person',
  'borrowed_from_person',
  'paid_to_person',
  'person_adjustment',
  SPLIT_ENTRY_TYPE
];

function splitForPerson(entry, personId) {
  return Array.isArray(entry?.splits) ? entry.splits.find(split => split.personId === personId) : null;
}

function currencyOf(entry){return String(entry?.currency||'USD').toUpperCase();}

function personDeltaMinor(entry, personId=null) {
  const currency=currencyOf(entry);
  if (entry.type === SPLIT_ENTRY_TYPE) {
    if (personId) return toMinor(splitForPerson(entry, personId)?.amount || 0,currency);
    return sumMinor((entry.splits||[]).map(split=>toMinor(split.amount||0,currency)));
  }
  const amount=toMinor(entry.amount||0,currency);
  switch (entry.type) {
    case 'paid_for_person': return amount;
    case 'received_from_person': return -amount;
    case 'borrowed_from_person': return -amount;
    case 'paid_to_person': return amount;
    case 'person_adjustment': return toMinor(entry.signedAmount ?? entry.amount ?? 0,currency);
    default: return 0;
  }
}

function accountDeltaMinor(entry, account) {
  const currency=String(account?.currency||entry?.currency||'USD').toUpperCase();
  if(entry.type==='account_transfer'){
    if(entry.fromAccountId===account.id)return -toMinor(entry.fromAmount??entry.amount??0,currency);
    if(entry.toAccountId===account.id)return toMinor(entry.toAmount??entry.amount??0,currency);
    return 0;
  }
  if(entry.accountId!==account.id)return 0;
  const amount=toMinor(entry.amount||0,currency);
  switch(entry.type){
    case 'paid_for_person':
    case SPLIT_ENTRY_TYPE:
    case 'paid_to_person':
    case 'account_expense':
      return -amount;
    case 'received_from_person':
    case 'borrowed_from_person':
    case 'account_income':
      return amount;
    case 'account_adjustment':
      return toMinor(entry.signedAmount??entry.amount??0,currency);
    default:return 0;
  }
}

export function entryTouchesPerson(entry, personId) {
  if (!entry || !personId) return false;
  if (entry.type === SPLIT_ENTRY_TYPE) return !!splitForPerson(entry, personId);
  return entry.personId === personId && PERSON_ENTRY_TYPES.includes(entry.type);
}

export function personDelta(entry, personId = null) {
  const currency=currencyOf(entry);
  return fromMinor(personDeltaMinor(entry,personId),currency);
}

export function accountDelta(entry, accountId) {
  if (entry.type === 'account_transfer') {
    if (entry.fromAccountId === accountId) return -Number(entry.fromAmount ?? entry.amount ?? 0);
    if (entry.toAccountId === accountId) return Number(entry.toAmount ?? entry.amount ?? 0);
    return 0;
  }
  if (entry.accountId !== accountId) return 0;
  switch (entry.type) {
    case 'paid_for_person':
    case SPLIT_ENTRY_TYPE:
    case 'paid_to_person':
    case 'account_expense':
      return -Number(entry.amount||0);
    case 'received_from_person':
    case 'borrowed_from_person':
    case 'account_income':
      return Number(entry.amount||0);
    case 'account_adjustment':
      return Number(entry.signedAmount ?? entry.amount ?? 0);
    default:return 0;
  }
}

export function personBalances(entries, people) {
  const minors={};
  for(const person of people)minors[person.id]={};
  for(const entry of entries){
    const currency=currencyOf(entry);
    if(entry.type===SPLIT_ENTRY_TYPE){
      for(const split of entry.splits||[]){
        if(!split.personId)continue;
        minors[split.personId]||={};
        minors[split.personId][currency]=sumMinor([minors[split.personId][currency]||0,toMinor(split.amount||0,currency)]);
      }
      continue;
    }
    if(!entry.personId||!PERSON_ENTRY_TYPES.includes(entry.type))continue;
    minors[entry.personId]||={};
    minors[entry.personId][currency]=sumMinor([minors[entry.personId][currency]||0,personDeltaMinor(entry)]);
  }
  const out={};
  for(const [personId,currencies] of Object.entries(minors)){
    out[personId]={};
    for(const [currency,minor] of Object.entries(currencies))out[personId][currency]=fromMinor(minor,currency);
  }
  return out;
}

export function accountBalances(entries, accounts) {
  const out={};
  for(const account of accounts){
    let minor=toMinor(account.openingBalance||0,account.currency);
    for(const entry of entries)minor=sumMinor([minor,accountDeltaMinor(entry,account)]);
    out[account.id]=fromMinor(minor,account.currency);
  }
  return out;
}

export function totalsFromBalances(balanceMap) {
  const minors={};
  for(const currencies of Object.values(balanceMap)){
    for(const [currency,amount] of Object.entries(currencies)){
      minors[currency]||={owedToMe:0,iOwe:0,net:0};
      const minor=toMinor(amount,currency);
      if(minor>0)minors[currency].owedToMe=sumMinor([minors[currency].owedToMe,minor]);
      if(minor<0)minors[currency].iOwe=sumMinor([minors[currency].iOwe,-minor]);
      minors[currency].net=sumMinor([minors[currency].net,minor]);
    }
  }
  const totals={};
  for(const [currency,row] of Object.entries(minors))totals[currency]={
    owedToMe:fromMinor(row.owedToMe,currency),
    iOwe:fromMinor(row.iOwe,currency),
    net:fromMinor(row.net,currency)
  };
  return totals;
}

export function runningStatement(entries, personId, currency) {
  const rows=[];
  for(const entry of entries){
    if(!entryTouchesPerson(entry,personId))continue;
    if(currency&&currencyOf(entry)!==currency)continue;
    if(entry.type===SPLIT_ENTRY_TYPE){
      const split=splitForPerson(entry,personId);
      rows.push({...entry,personId,amount:Number(split?.amount||0),splitNote:split?.note||'',description:split?.note?[entry.description,split.note].filter(Boolean).join(' · '):entry.description});
    }else rows.push(entry);
  }
  rows.sort((a,b)=>new Date(a.date+'T00:00:00').getTime()-new Date(b.date+'T00:00:00').getTime()||new Date(a.createdAt).getTime()-new Date(b.createdAt).getTime());
  const runningByCurrency={};
  return rows.map(entry=>{
    const rowCurrency=currencyOf(entry);
    const deltaMinor=entry.type===SPLIT_ENTRY_TYPE?toMinor(entry.amount||0,rowCurrency):personDeltaMinor(entry);
    runningByCurrency[rowCurrency]=sumMinor([runningByCurrency[rowCurrency]||0,deltaMinor]);
    return {...entry,delta:fromMinor(deltaMinor,rowCurrency),running:fromMinor(runningByCurrency[rowCurrency]||0,rowCurrency)};
  });
}

export function validateTransfer(fromAccount, toAccount, fromAmount, toAmount) {
  if (!fromAccount || !toAccount) return 'Choose both accounts.';
  if (fromAccount.id === toAccount.id) return 'Choose two different accounts.';
  try{
    const fromMinor=toMinor(fromAmount,fromAccount.currency,{allowNegative:false,allowZero:false});
    const toMinorValue=toMinor(toAmount,toAccount.currency,{allowNegative:false,allowZero:false});
    if(fromMinor<=0||toMinorValue<=0)return 'Transfer amounts must be greater than zero.';
    if(String(fromAccount.currency||'').toUpperCase()===String(toAccount.currency||'').toUpperCase()&&fromMinor!==toMinorValue)return 'Same-currency transfers must use the same amount.';
  }catch(error){return error.message;}
  return '';
}

export function validateSplit(splits, total, currency='USD') {
  if (!Array.isArray(splits) || splits.length < 2) return 'Add at least two people to the split.';
  const seen=new Set();let sum=0;
  try{
    for(const split of splits){
      if(!split.personId)return 'Choose a person for every split row.';
      if(seen.has(split.personId))return 'Each person can appear only once in a split.';
      seen.add(split.personId);
      const minor=toMinor(split.amount,currency,{allowNegative:false,allowZero:false});
      sum=sumMinor([sum,minor]);
    }
    if(sum!==toMinor(total,currency,{allowNegative:false,allowZero:false}))return 'Split amounts must add up to the transaction total.';
  }catch(error){return error.message;}
  return '';
}
