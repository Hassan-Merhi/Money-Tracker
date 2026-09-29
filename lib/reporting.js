import { accountBalances, personBalances, personDelta, PERSON_ENTRY_TYPES, entryTouchesPerson, SPLIT_ENTRY_TYPE } from './ledger.js';
import { fromMinor, sumMinor, toMinor } from './money.js';

const exact=(value,currency='USD')=>fromMinor(toMinor(value||0,currency),currency);
const addExact=(a,b,currency='USD')=>fromMinor(sumMinor([toMinor(a||0,currency),toMinor(b||0,currency)]),currency);

export function inDateRange(entry, from='', to='') {
  const date = String(entry?.date || '');
  if (!date) return false;
  return (!from || date >= from) && (!to || date <= to);
}

export function filteredEntries(state, {from='', to='', personId='', accountId=''}={}) {
  return (state?.entries || []).filter(entry => {
    if (!inDateRange(entry, from, to)) return false;
    if (personId && !entryTouchesPerson(entry, personId)) return false;
    if (accountId && entry.accountId !== accountId && entry.fromAccountId !== accountId && entry.toAccountId !== accountId) return false;
    return true;
  });
}

export function reportingSnapshot(state, filters={}) {
  const entries = filteredEntries(state, filters);
  const people = state?.people || [];
  const accounts = state?.accounts || [];
  const peopleById = new Map(people.map(p => [p.id, p]));
  const accountsById = new Map(accounts.map(a => [a.id, a]));
  const categoriesById = new Map((state?.categories || []).map(c => [c.id, c]));
  const balances = personBalances(state?.entries || [], people);
  const accountBalanceMap = accountBalances(state?.entries || [], accounts);

  const activity = {};
  const merchants = {};
  const monthly = {};
  const personalCashFlow = {};
  const categorySpending = {};
  let transactionCount = 0;

  for (const entry of entries) {
    transactionCount++;
    const month = String(entry.date || '').slice(0, 7) || 'Unknown';
    monthly[month] ||= {};

    if (entry.type === 'account_transfer') {
      const from = accountsById.get(entry.fromAccountId);
      const to = accountsById.get(entry.toAccountId);
      if (from) monthly[month][from.currency] = addExact(monthly[month][from.currency]||0,-Number(entry.fromAmount||0),from.currency);
      if (to) monthly[month][to.currency] = addExact(monthly[month][to.currency]||0,Number(entry.toAmount||0),to.currency);
      continue;
    }

    if (entry.type === 'account_expense' || entry.type === 'account_income') {
      const currency = entry.currency || accountsById.get(entry.accountId)?.currency || 'USD';
      personalCashFlow[currency] ||= {expense:0,income:0,net:0};
      const amount=Number(entry.amount||0);
      if(entry.type==='account_expense'){
        personalCashFlow[currency].expense=addExact(personalCashFlow[currency].expense,amount,currency);
        const category=categoriesById.get(entry.categoryId);
        const categoryName=category?.name||'Uncategorized', categoryIcon=category?.icon||'';
        const categoryKey=`${currency}::${entry.categoryId||'uncategorized'}`;
        categorySpending[categoryKey] ||= {categoryId:entry.categoryId||null,categoryName,categoryIcon,currency,amount:0,count:0};
        categorySpending[categoryKey].amount=addExact(categorySpending[categoryKey].amount,amount,currency);
        categorySpending[categoryKey].count++;
        if(entry.merchant){
          const key = `${currency}::${entry.merchant.trim()}`;
          merchants[key] ||= { merchant: entry.merchant.trim(), currency, amount:0, count:0 };
          merchants[key].amount = addExact(merchants[key].amount,amount,currency);
          merchants[key].count++;
        }
      }else personalCashFlow[currency].income=addExact(personalCashFlow[currency].income,amount,currency);
      personalCashFlow[currency].net=addExact(personalCashFlow[currency].income,-personalCashFlow[currency].expense,currency);
      monthly[month][currency]=addExact(monthly[month][currency]||0,entry.type==='account_income'?amount:-amount,currency);
    }
    if (!PERSON_ENTRY_TYPES.includes(entry.type)) continue;
    const currency = entry.currency || 'USD';
    const delta = entry.type === SPLIT_ENTRY_TYPE && filters.personId ? personDelta(entry, filters.personId) : personDelta(entry);
    activity[currency] ||= { charged:0, recovered:0, borrowed:0, repaid:0, netPersonChange:0 };
    activity[currency].netPersonChange = addExact(activity[currency].netPersonChange,delta,currency);
    if (entry.type === 'paid_for_person' || entry.type === SPLIT_ENTRY_TYPE) activity[currency].charged = addExact(activity[currency].charged,(entry.type === SPLIT_ENTRY_TYPE && filters.personId ? personDelta(entry, filters.personId) : Number(entry.amount || 0)),currency);
    if (entry.type === 'received_from_person') activity[currency].recovered = addExact(activity[currency].recovered,Number(entry.amount || 0),currency);
    if (entry.type === 'borrowed_from_person') activity[currency].borrowed = addExact(activity[currency].borrowed,Number(entry.amount || 0),currency);
    if (entry.type === 'paid_to_person') activity[currency].repaid = addExact(activity[currency].repaid,Number(entry.amount || 0),currency);

    if (entry.merchant && ['paid_for_person','paid_to_person',SPLIT_ENTRY_TYPE].includes(entry.type)) {
      const key = `${currency}::${entry.merchant.trim()}`;
      merchants[key] ||= { merchant: entry.merchant.trim(), currency, amount:0, count:0 };
      merchants[key].amount = addExact(merchants[key].amount,(entry.type === SPLIT_ENTRY_TYPE && filters.personId ? personDelta(entry, filters.personId) : Number(entry.amount || 0)),currency);
      merchants[key].count++;
    }
    monthly[month][currency] = addExact(monthly[month][currency]||0,delta,currency);
  }

  const outstanding = [];
  for (const person of people) {
    for (const [currency, amount] of Object.entries(balances[person.id] || {})) {
      if(toMinor(amount,currency)===0)continue;
      outstanding.push({personId:person.id,personName:person.name,currency,amount:exact(amount,currency),direction:amount>0?'owes_me':'i_owe'});
    }
  }
  outstanding.sort((a,b) => Math.abs(b.amount) - Math.abs(a.amount) || a.personName.localeCompare(b.personName));

  const accountRows = accounts.map(account => ({
    accountId: account.id,
    name: account.name,
    type: account.type,
    currency: account.currency,
    openingBalance:exact(account.openingBalance||0,account.currency),
    balance:exact(accountBalanceMap[account.id]||0,account.currency)
  }));

  return {
    filters:{from:filters.from||'',to:filters.to||'',personId:filters.personId||'',accountId:filters.accountId||''},
    transactionCount,
    activity,
    personalCashFlow,
    categorySpending:Object.values(categorySpending).sort((a,b)=>b.amount-a.amount||a.categoryName.localeCompare(b.categoryName)),
    outstanding,
    accounts: accountRows,
    merchants: Object.values(merchants).sort((a,b)=>b.amount-a.amount).slice(0,12),
    monthly: Object.entries(monthly).sort(([a],[b])=>a.localeCompare(b)).map(([month,currencies])=>({month,currencies})),
    selectedPerson: filters.personId ? peopleById.get(filters.personId) || null : null
  };
}

export function exportRows(state, filters={}) {
  const entries = filteredEntries(state, filters);
  const peopleById = new Map((state?.people||[]).map(p=>[p.id,p]));
  const accountsById = new Map((state?.accounts||[]).map(a=>[a.id,a]));
  const categoriesById = new Map((state?.categories||[]).map(c=>[c.id,c]));
  return entries.map(entry => ({
    Date: entry.date,
    Type: entry.type,
    Person: entry.type === SPLIT_ENTRY_TYPE ? (entry.splits || []).map(split => peopleById.get(split.personId)?.name || 'Unknown').join(' + ') : peopleById.get(entry.personId)?.name || '',
    Account: accountsById.get(entry.accountId)?.name || '',
    'From Account': accountsById.get(entry.fromAccountId)?.name || '',
    'To Account': accountsById.get(entry.toAccountId)?.name || '',
    Amount: Number(entry.amount || 0),
    Currency: entry.currency || accountsById.get(entry.accountId)?.currency || '',
    'From Amount': entry.fromAmount ?? '',
    'To Amount': entry.toAmount ?? '',
    Merchant: entry.merchant || '',
    Category: categoriesById.get(entry.categoryId)?.name || '',
    Description: entry.description || '',
    'Split Details': entry.type === SPLIT_ENTRY_TYPE ? (entry.splits || []).map(split => `${peopleById.get(split.personId)?.name || 'Unknown'}: ${Number(split.amount || 0)}${split.note ? ` (${split.note})` : ''}`).join(' | ') : '',
    Attachments: Number(entry.attachmentCount || 0)
  }));
}

export function workbookSheets(state, filters={}) {
  const snap = reportingSnapshot(state, filters);
  const peopleBalances = personBalances(state?.entries || [], state?.people || []);
  const overview = [
    ['Money Tracker Report'],
    ['Ledger', state?.settings?.displayName || 'My Ledger'],
    ['From', filters.from || 'All time'],
    ['To', filters.to || 'All time'],
    ['Transactions', snap.transactionCount],
    [],
    ['Currency','Charged for others','Recovered','Borrowed','Repaid','Net person change'],
    ...Object.entries(snap.activity).map(([c,v])=>[c,v.charged,v.recovered,v.borrowed,v.repaid,v.netPersonChange])
  ];
  const people = [['Person','Note','Currency','Balance','Direction']];
  for (const p of state?.people || []) {
    const balances = peopleBalances[p.id] || {};
    const rows = Object.entries(balances);
    if (!rows.length) people.push([p.name,p.note||'',state?.settings?.defaultCurrency||'USD',0,'Settled']);
    for (const [currency,amount] of rows) people.push([p.name,p.note||'',currency,exact(amount,currency),amount>0?'They owe me':amount<0?'I owe them':'Settled']);
  }
  const accounts = [['Account','Type','Currency','Opening Balance','Current Balance'], ...snap.accounts.map(a=>[a.name,a.type,a.currency,a.openingBalance,a.balance])];
  const categories = [['Category','Kind','Icon','Archived'], ...(state?.categories||[]).map(c=>[c.name,c.kind,c.icon||'',c.archived?'Yes':'No'])];
  const budgets = [['Category','Currency','Monthly Limit'], ...(state?.budgets||[]).map(b=>[(state?.categories||[]).find(c=>c.id===b.categoryId)?.name||'Unknown',b.currency,Number(b.monthlyLimit||0)])];
  const spending = [['Category','Currency','Amount','Transactions'], ...snap.categorySpending.map(r=>[r.categoryName,r.currency,r.amount,r.count])];
  const transactions = [Object.keys(exportRows(state,filters)[0] || {Date:'',Type:'',Person:'',Account:'','From Account':'','To Account':'',Amount:'',Currency:'','From Amount':'','To Amount':'',Merchant:'',Category:'',Description:'','Split Details':'',Attachments:''})];
  const rowObjects = exportRows(state,filters);
  for (const row of rowObjects) transactions.push(Object.values(row));
  const outstanding = [['Person','Currency','Amount','Direction'], ...snap.outstanding.map(r=>[r.personName,r.currency,Math.abs(r.amount),r.direction==='owes_me'?'They owe me':'I owe them'])];
  return [
    {name:'Overview',rows:overview},
    {name:'Outstanding',rows:outstanding},
    {name:'People',rows:people},
    {name:'Accounts',rows:accounts},
    {name:'Categories',rows:categories},
    {name:'Budgets',rows:budgets},
    {name:'Spending',rows:spending},
    {name:'Transactions',rows:transactions}
  ];
}
