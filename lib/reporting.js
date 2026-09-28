import { accountBalances, personBalances, personDelta, PERSON_ENTRY_TYPES } from './ledger.js';

const round = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function inDateRange(entry, from='', to='') {
  const date = String(entry?.date || '');
  if (!date) return false;
  return (!from || date >= from) && (!to || date <= to);
}

export function filteredEntries(state, {from='', to='', personId='', accountId=''}={}) {
  return (state?.entries || []).filter(entry => {
    if (!inDateRange(entry, from, to)) return false;
    if (personId && entry.personId !== personId) return false;
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
  const balances = personBalances(state?.entries || [], people);
  const accountBalanceMap = accountBalances(state?.entries || [], accounts);

  const activity = {};
  const merchants = {};
  const monthly = {};
  let transactionCount = 0;

  for (const entry of entries) {
    transactionCount++;
    const month = String(entry.date || '').slice(0, 7) || 'Unknown';
    monthly[month] ||= {};

    if (entry.type === 'account_transfer') {
      const from = accountsById.get(entry.fromAccountId);
      const to = accountsById.get(entry.toAccountId);
      if (from) monthly[month][from.currency] = round((monthly[month][from.currency] || 0) - Number(entry.fromAmount || 0));
      if (to) monthly[month][to.currency] = round((monthly[month][to.currency] || 0) + Number(entry.toAmount || 0));
      continue;
    }

    if (!PERSON_ENTRY_TYPES.includes(entry.type)) continue;
    const currency = entry.currency || 'USD';
    const delta = personDelta(entry);
    activity[currency] ||= { charged:0, recovered:0, borrowed:0, repaid:0, netPersonChange:0 };
    activity[currency].netPersonChange = round(activity[currency].netPersonChange + delta);
    if (entry.type === 'paid_for_person') activity[currency].charged = round(activity[currency].charged + Number(entry.amount || 0));
    if (entry.type === 'received_from_person') activity[currency].recovered = round(activity[currency].recovered + Number(entry.amount || 0));
    if (entry.type === 'borrowed_from_person') activity[currency].borrowed = round(activity[currency].borrowed + Number(entry.amount || 0));
    if (entry.type === 'paid_to_person') activity[currency].repaid = round(activity[currency].repaid + Number(entry.amount || 0));

    if (entry.merchant && ['paid_for_person','paid_to_person'].includes(entry.type)) {
      const key = `${currency}::${entry.merchant.trim()}`;
      merchants[key] ||= { merchant: entry.merchant.trim(), currency, amount:0, count:0 };
      merchants[key].amount = round(merchants[key].amount + Number(entry.amount || 0));
      merchants[key].count++;
    }
    monthly[month][currency] = round((monthly[month][currency] || 0) + delta);
  }

  const outstanding = [];
  for (const person of people) {
    for (const [currency, amount] of Object.entries(balances[person.id] || {})) {
      if (Math.abs(amount) < 0.000001) continue;
      outstanding.push({personId:person.id, personName:person.name, currency, amount:round(amount), direction:amount>0?'owes_me':'i_owe'});
    }
  }
  outstanding.sort((a,b) => Math.abs(b.amount) - Math.abs(a.amount) || a.personName.localeCompare(b.personName));

  const accountRows = accounts.map(account => ({
    accountId: account.id,
    name: account.name,
    type: account.type,
    currency: account.currency,
    openingBalance: round(account.openingBalance || 0),
    balance: round(accountBalanceMap[account.id] || 0)
  }));

  return {
    filters:{from:filters.from||'',to:filters.to||'',personId:filters.personId||'',accountId:filters.accountId||''},
    transactionCount,
    activity,
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
  return entries.map(entry => ({
    Date: entry.date,
    Type: entry.type,
    Person: peopleById.get(entry.personId)?.name || '',
    Account: accountsById.get(entry.accountId)?.name || '',
    'From Account': accountsById.get(entry.fromAccountId)?.name || '',
    'To Account': accountsById.get(entry.toAccountId)?.name || '',
    Amount: Number(entry.amount || 0),
    Currency: entry.currency || accountsById.get(entry.accountId)?.currency || '',
    'From Amount': entry.fromAmount ?? '',
    'To Amount': entry.toAmount ?? '',
    Merchant: entry.merchant || '',
    Description: entry.description || ''
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
    for (const [currency,amount] of rows) people.push([p.name,p.note||'',currency,round(amount),amount>0?'They owe me':amount<0?'I owe them':'Settled']);
  }
  const accounts = [['Account','Type','Currency','Opening Balance','Current Balance'], ...snap.accounts.map(a=>[a.name,a.type,a.currency,a.openingBalance,a.balance])];
  const transactions = [Object.keys(exportRows(state,filters)[0] || {Date:'',Type:'',Person:'',Account:'','From Account':'','To Account':'',Amount:'',Currency:'','From Amount':'','To Amount':'',Merchant:'',Description:''})];
  const rowObjects = exportRows(state,filters);
  for (const row of rowObjects) transactions.push(Object.values(row));
  const outstanding = [['Person','Currency','Amount','Direction'], ...snap.outstanding.map(r=>[r.personName,r.currency,Math.abs(r.amount),r.direction==='owes_me'?'They owe me':'I owe them'])];
  return [
    {name:'Overview',rows:overview},
    {name:'Outstanding',rows:outstanding},
    {name:'People',rows:people},
    {name:'Accounts',rows:accounts},
    {name:'Transactions',rows:transactions}
  ];
}
