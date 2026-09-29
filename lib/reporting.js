import { accountBalances, personBalances, personDelta, PERSON_ENTRY_TYPES, entryTouchesPerson, SPLIT_ENTRY_TYPE } from './ledger.js';
import { fromMinor, sumMinor, toMinor } from './money.js';

const exact=(value,currency='USD')=>fromMinor(toMinor(value||0,currency),currency);
const addExact=(a,b,currency='USD')=>fromMinor(sumMinor([toMinor(a||0,currency),toMinor(b||0,currency)]),currency);

export function inDateRange(entry,from='',to=''){
  const date=String(entry?.date||'');
  if(!date)return false;
  return (!from||date>=from)&&(!to||date<=to);
}

export function dateRangeForPreset(preset='this_month',anchorDate='',customFrom='',customTo=''){
  const anchor=/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)?anchorDate:new Date().toISOString().slice(0,10);
  const [year,month]=anchor.split('-').map(Number);
  const pad=value=>String(value).padStart(2,'0');
  const monthBounds=(y,monthIndex)=>{
    const lastDay=new Date(Date.UTC(y,monthIndex+1,0)).getUTCDate();
    return {from:`${y}-${pad(monthIndex+1)}-01`,to:`${y}-${pad(monthIndex+1)}-${pad(lastDay)}`};
  };
  if(preset==='all')return {from:'',to:''};
  if(preset==='custom')return {from:customFrom||'',to:customTo||''};
  if(preset==='last_30_days'){
    const end=new Date(`${anchor}T00:00:00Z`),start=new Date(end);
    start.setUTCDate(start.getUTCDate()-29);
    return {from:start.toISOString().slice(0,10),to:anchor};
  }
  if(preset==='last_month'){
    const previous=new Date(Date.UTC(year,month-2,1));
    return monthBounds(previous.getUTCFullYear(),previous.getUTCMonth());
  }
  return monthBounds(year,month-1);
}

export function filteredEntries(state,{from='',to='',personId='',accountId='',categoryId='',type='',currency=''}={}){
  return (state?.entries||[]).filter(entry=>{
    if(!inDateRange(entry,from,to))return false;
    if(personId&&!entryTouchesPerson(entry,personId))return false;
    if(accountId&&entry.accountId!==accountId&&entry.fromAccountId!==accountId&&entry.toAccountId!==accountId)return false;
    if(categoryId&&entry.categoryId!==categoryId)return false;
    if(type&&entry.type!==type)return false;
    if(currency){
      const accountsById=new Map((state?.accounts||[]).map(a=>[a.id,a]));
      const currencies=new Set([
        entry.currency,
        accountsById.get(entry.accountId)?.currency,
        accountsById.get(entry.fromAccountId)?.currency,
        accountsById.get(entry.toAccountId)?.currency
      ].filter(Boolean));
      if(!currencies.has(currency))return false;
    }
    return true;
  });
}

// Transactions drill-down uses the same person-touch semantics as the ledger (including splits).
// Category IDs remain valid after archival; "uncategorized" is a route-only sentinel.
// People metadata is accepted as caller context, but must not gate historical ID matches.
export function filterTransactionList(entries,{type='',personId='',categoryId='',people=[],from='',to=''}={}){
  return (entries||[]).filter(entry=>
    inDateRange(entry,from,to)&&
    (!type||entry.type===type)&&
    (!personId||entryTouchesPerson(entry,personId))&&
    (!categoryId||(categoryId==='uncategorized'?!entry.categoryId:entry.categoryId===categoryId))
  );
}

export function exportRows(state,filters={}){
  const entries=filteredEntries(state,filters);
  const peopleById=new Map((state?.people||[]).map(p=>[p.id,p]));
  const accountsById=new Map((state?.accounts||[]).map(a=>[a.id,a]));
  const categoriesById=new Map((state?.categories||[]).map(c=>[c.id,c]));
  return entries.map(entry=>{
    const splitPeople=(entry.splits||[]).map(split=>peopleById.get(split.personId)?.name||'Unknown');
    const splitIds=(entry.splits||[]).map(split=>split.personId||'');
    const attachments=Array.isArray(entry.attachments)?entry.attachments:[];
    return {
      'Entry ID':entry.id,
      Date:entry.date,
      Type:entry.type,
      'Person ID':entry.type===SPLIT_ENTRY_TYPE?splitIds.join(' + '):(entry.personId||''),
      Person:entry.type===SPLIT_ENTRY_TYPE?splitPeople.join(' + '):(peopleById.get(entry.personId)?.name||''),
      'Account ID':entry.accountId||'',
      Account:accountsById.get(entry.accountId)?.name||'',
      'From Account ID':entry.fromAccountId||'',
      'From Account':accountsById.get(entry.fromAccountId)?.name||'',
      'To Account ID':entry.toAccountId||'',
      'To Account':accountsById.get(entry.toAccountId)?.name||'',
      Amount:Number(entry.amount||0),
      Currency:entry.currency||accountsById.get(entry.accountId)?.currency||'',
      'From Amount':entry.fromAmount??'',
      'To Amount':entry.toAmount??'',
      Merchant:entry.merchant||'',
      'Category ID':entry.categoryId||'',
      Category:categoriesById.get(entry.categoryId)?.name||'',
      Description:entry.description||'',
      'Split Details':entry.type===SPLIT_ENTRY_TYPE?(entry.splits||[]).map(split=>`${peopleById.get(split.personId)?.name||'Unknown'}: ${Number(split.amount||0)}${split.note?` (${split.note})`:''}`).join(' | '):'',
      Attachments:Number(entry.attachmentCount||attachments.length||0),
      'Attachment IDs':attachments.map(a=>a.id).join(' | '),
      'Attachment Names':attachments.map(a=>a.name).join(' | '),
      'Created At':entry.createdAt||'',
      'Updated At':entry.updatedAt||''
    };
  });
}

export function reportingSnapshot(state,filters={}){
  const entries=filteredEntries(state,filters);
  const people=state?.people||[],accounts=state?.accounts||[],categories=state?.categories||[];
  const peopleById=new Map(people.map(p=>[p.id,p])),accountsById=new Map(accounts.map(a=>[a.id,a])),categoriesById=new Map(categories.map(c=>[c.id,c]));
  const balances=personBalances(state?.entries||[],people),accountBalanceMap=accountBalances(state?.entries||[],accounts);
  const activity={},merchants={},receivablesMovement={},cashFlow={},transferFlow={},personalCashFlow={},categorySpending={};
  // Each series has one accounting meaning. Preserve zero-valued transfer legs too:
  // same-currency transfers net to zero, but were still present in the period.
  const addMovement=(series,month,currency,amount)=>{
    series[month]||={};
    series[month][currency]=addExact(series[month][currency]||0,amount,currency);
  };
  const monthlyRows=series=>Object.entries(series).sort(([a],[b])=>a.localeCompare(b)).map(([month,currencies])=>({month,currencies}));
  let transactionCount=0;

  for(const entry of entries){
    transactionCount++;
    if(entry.type==='account_adjustment')continue; // balance correction only: never a spend, income, person or reporting-movement figure
    const month=String(entry.date||'').slice(0,7)||'Unknown';
    if(entry.type==='account_transfer'){
      const from=accountsById.get(entry.fromAccountId),to=accountsById.get(entry.toAccountId);
      if(from)addMovement(transferFlow,month,from.currency,-Number(entry.fromAmount||0));
      if(to)addMovement(transferFlow,month,to.currency,Number(entry.toAmount||0));
      continue;
    }
    if(entry.type==='account_expense'||entry.type==='account_income'){
      const currency=entry.currency||accountsById.get(entry.accountId)?.currency||'USD';
      personalCashFlow[currency]||={expense:0,income:0,net:0};const amount=Number(entry.amount||0);
      if(entry.type==='account_expense'){
        personalCashFlow[currency].expense=addExact(personalCashFlow[currency].expense,amount,currency);
        const category=categoriesById.get(entry.categoryId),categoryName=category?.name||'Uncategorized',categoryIcon=category?.icon||'',categoryKey=`${currency}::${entry.categoryId||'uncategorized'}`;
        categorySpending[categoryKey]||={categoryId:entry.categoryId||null,categoryName,categoryIcon,currency,amount:0,count:0};
        categorySpending[categoryKey].amount=addExact(categorySpending[categoryKey].amount,amount,currency);categorySpending[categoryKey].count++;
        if(entry.merchant){const key=`${currency}::${entry.merchant.trim()}`;merchants[key]||={merchant:entry.merchant.trim(),currency,amount:0,count:0};merchants[key].amount=addExact(merchants[key].amount,amount,currency);merchants[key].count++;}
      }else personalCashFlow[currency].income=addExact(personalCashFlow[currency].income,amount,currency);
      personalCashFlow[currency].net=addExact(personalCashFlow[currency].income,-personalCashFlow[currency].expense,currency);
      addMovement(cashFlow,month,currency,entry.type==='account_income'?amount:-amount);
    }
    if(!PERSON_ENTRY_TYPES.includes(entry.type))continue;
    const currency=entry.currency||'USD',delta=entry.type===SPLIT_ENTRY_TYPE&&filters.personId?personDelta(entry,filters.personId):personDelta(entry);
    activity[currency]||={charged:0,recovered:0,borrowed:0,repaid:0,netPersonChange:0};
    activity[currency].netPersonChange=addExact(activity[currency].netPersonChange,delta,currency);
    if(entry.type==='paid_for_person'||entry.type===SPLIT_ENTRY_TYPE)activity[currency].charged=addExact(activity[currency].charged,entry.type===SPLIT_ENTRY_TYPE&&filters.personId?personDelta(entry,filters.personId):Number(entry.amount||0),currency);
    if(entry.type==='received_from_person')activity[currency].recovered=addExact(activity[currency].recovered,Number(entry.amount||0),currency);
    if(entry.type==='borrowed_from_person')activity[currency].borrowed=addExact(activity[currency].borrowed,Number(entry.amount||0),currency);
    if(entry.type==='paid_to_person')activity[currency].repaid=addExact(activity[currency].repaid,Number(entry.amount||0),currency);
    if(entry.merchant&&['paid_for_person','paid_to_person',SPLIT_ENTRY_TYPE].includes(entry.type)){const key=`${currency}::${entry.merchant.trim()}`;merchants[key]||={merchant:entry.merchant.trim(),currency,amount:0,count:0};merchants[key].amount=addExact(merchants[key].amount,entry.type===SPLIT_ENTRY_TYPE&&filters.personId?personDelta(entry,filters.personId):Number(entry.amount||0),currency);merchants[key].count++;}
    addMovement(receivablesMovement,month,currency,delta);
  }

  const outstanding=[];
  for(const person of people)for(const [currency,amount] of Object.entries(balances[person.id]||{})){if(toMinor(amount,currency)===0)continue;outstanding.push({personId:person.id,personName:person.name,currency,amount:exact(amount,currency),direction:amount>0?'owes_me':'i_owe'});}
  outstanding.sort((a,b)=>Math.abs(b.amount)-Math.abs(a.amount)||a.personName.localeCompare(b.personName));

  const accountRows=accounts.map(account=>({accountId:account.id,name:account.name,type:account.type,currency:account.currency,openingBalance:exact(account.openingBalance||0,account.currency),balance:exact(accountBalanceMap[account.id]||0,account.currency)}));
  const categoryRows=Object.values(categorySpending).sort((a,b)=>b.amount-a.amount||a.categoryName.localeCompare(b.categoryName));
  const budgetRows=(state?.budgets||[]).map(b=>({id:b.id,categoryId:b.categoryId,categoryName:categoriesById.get(b.categoryId)?.name||'Unknown',currency:b.currency,monthlyLimit:Number(b.monthlyLimit||0)}));

  return {
    filters:{from:filters.from||'',to:filters.to||'',personId:filters.personId||'',accountId:filters.accountId||'',categoryId:filters.categoryId||'',type:filters.type||'',currency:filters.currency||''},
    transactionCount,activity,personalCashFlow,categorySpending:categoryRows,outstanding,accounts:accountRows,
    merchants:Object.values(merchants).sort((a,b)=>b.amount-a.amount).slice(0,20),
    receivablesMovement:monthlyRows(receivablesMovement),cashFlow:monthlyRows(cashFlow),transferFlow:monthlyRows(transferFlow),
    budgets:budgetRows,
    transactions:exportRows(state,filters),
    selectedPerson:filters.personId?peopleById.get(filters.personId)||null:null,
    selectedCategory:filters.categoryId?categoriesById.get(filters.categoryId)||null:null
  };
}

export function workbookSheets(state,filters={}){
  const snap=reportingSnapshot(state,filters),peopleBalances=personBalances(state?.entries||[],state?.people||[]);
  const metadata=[
    ['Money Tracker Export','v2'],
    ['Ledger',state?.settings?.displayName||'My Ledger'],
    ['Generated At',new Date().toISOString()],
    ['App Mode',state?.settings?.appMode||'simple'],
    ['Timezone',state?.settings?.timezone||'UTC'],
    ['From',filters.from||'All time'],['To',filters.to||'All time'],
    ['Person Filter',snap.selectedPerson?.name||'All'],
    ['Account Filter',(state?.accounts||[]).find(a=>a.id===filters.accountId)?.name||'All'],
    ['Category Filter',snap.selectedCategory?.name||'All'],
    ['Type Filter',filters.type||'All'],
    ['Currency Filter',filters.currency||'All']
  ];
  const overview=[['Money Tracker Report'],['Ledger',state?.settings?.displayName||'My Ledger'],['Transactions',snap.transactionCount],[],['Currency','Charged for others','Recovered','Borrowed','Repaid','Net person change'],...Object.entries(snap.activity).map(([c,v])=>[c,v.charged,v.recovered,v.borrowed,v.repaid,v.netPersonChange])];
  const people=[['Person ID','Person','Note','Currency','Balance','Direction']];
  for(const p of state?.people||[]){const balances=peopleBalances[p.id]||{},rows=Object.entries(balances);if(!rows.length)people.push([p.id,p.name,p.note||'',state?.settings?.defaultCurrency||'USD',0,'Settled']);for(const [currency,amount] of rows)people.push([p.id,p.name,p.note||'',currency,exact(amount,currency),amount>0?'They owe me':amount<0?'I owe them':'Settled']);}
  const accounts=[['Account ID','Account','Type','Currency','Opening Balance','Current Balance'],...snap.accounts.map(a=>[a.accountId,a.name,a.type,a.currency,a.openingBalance,a.balance])];
  const categories=[['Category ID','Category','Kind','Icon','Archived'],...(state?.categories||[]).map(c=>[c.id,c.name,c.kind,c.icon||'',c.archived?'Yes':'No'])];
  const budgets=[['Budget ID','Category ID','Category','Currency','Monthly Limit'],...(state?.budgets||[]).map(b=>[b.id,b.categoryId,(state?.categories||[]).find(c=>c.id===b.categoryId)?.name||'Unknown',b.currency,Number(b.monthlyLimit||0)])];
  const spending=[['Category ID','Category','Currency','Amount','Transactions'],...snap.categorySpending.map(r=>[r.categoryId||'',r.categoryName,r.currency,r.amount,r.count])];
  const monthly=[['Measure','Month','Currency','Net Movement']];
  for(const [measure,series] of [['Receivables movement',snap.receivablesMovement],['Personal cash flow',snap.cashFlow],['Transfer flow',snap.transferFlow]])
    for(const row of series)for(const [currency,value] of Object.entries(row.currencies))monthly.push([measure,row.month,currency,value]);
  const outstanding=[['Person ID','Person','Currency','Amount','Direction'],...snap.outstanding.map(r=>[r.personId,r.personName,r.currency,Math.abs(r.amount),r.direction==='owes_me'?'They owe me':'I owe them'])];
  const rowObjects=snap.transactions,transactionHeaders=Object.keys(rowObjects[0]||{'Entry ID':'',Date:'',Type:'','Person ID':'',Person:'','Account ID':'',Account:'','From Account ID':'','From Account':'','To Account ID':'','To Account':'',Amount:'',Currency:'','From Amount':'','To Amount':'',Merchant:'','Category ID':'',Category:'',Description:'','Split Details':'',Attachments:'','Attachment IDs':'','Attachment Names':'','Created At':'','Updated At':''});
  const transactions=[transactionHeaders,...rowObjects.map(row=>transactionHeaders.map(key=>row[key]??''))];
  return [
    {name:'Metadata',rows:metadata},{name:'Overview',rows:overview},{name:'Outstanding',rows:outstanding},{name:'People',rows:people},{name:'Accounts',rows:accounts},{name:'Categories',rows:categories},{name:'Budgets',rows:budgets},{name:'Spending',rows:spending},{name:'Monthly',rows:monthly},{name:'Transactions',rows:transactions}
  ];
}
