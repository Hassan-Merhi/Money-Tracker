export const PERSON_ENTRY_TYPES = [
  'paid_for_person',
  'received_from_person',
  'borrowed_from_person',
  'paid_to_person',
  'person_adjustment'
];

export function personDelta(entry) {
  const amount = Number(entry.amount || 0);
  switch (entry.type) {
    case 'paid_for_person': return amount;
    case 'received_from_person': return -amount;
    case 'borrowed_from_person': return -amount;
    case 'paid_to_person': return amount;
    case 'person_adjustment': return Number(entry.signedAmount ?? amount ?? 0);
    default: return 0;
  }
}

export function accountDelta(entry, accountId) {
  const amount = Number(entry.amount || 0);
  if (entry.type === 'account_transfer') {
    if (entry.fromAccountId === accountId) return -Number(entry.fromAmount ?? amount);
    if (entry.toAccountId === accountId) return Number(entry.toAmount ?? amount);
    return 0;
  }

  if (entry.accountId !== accountId) return 0;
  switch (entry.type) {
    case 'paid_for_person': return -amount;
    case 'received_from_person': return amount;
    case 'borrowed_from_person': return amount;
    case 'paid_to_person': return -amount;
    case 'account_adjustment': return Number(entry.signedAmount ?? amount ?? 0);
    default: return 0;
  }
}

export function personBalances(entries, people) {
  const out = {};
  for (const person of people) out[person.id] = {};
  for (const entry of entries) {
    if (!entry.personId || !PERSON_ENTRY_TYPES.includes(entry.type)) continue;
    const currency = entry.currency || 'USD';
    out[entry.personId] ||= {};
    out[entry.personId][currency] = (out[entry.personId][currency] || 0) + personDelta(entry);
  }
  return out;
}

export function accountBalances(entries, accounts) {
  const out = {};
  for (const account of accounts) {
    out[account.id] = Number(account.openingBalance || 0);
    for (const entry of entries) out[account.id] += accountDelta(entry, account.id);
  }
  return out;
}

export function totalsByCurrency(entries) {
  const totals = {};
  for (const entry of entries) {
    if (!entry.personId || !PERSON_ENTRY_TYPES.includes(entry.type)) continue;
    const currency = entry.currency || 'USD';
    totals[currency] ||= { owedToMe: 0, iOwe: 0, net: 0 };
    totals[currency].net += personDelta(entry);
  }
  return totals;
}

export function totalsFromBalances(balanceMap) {
  const totals = {};
  for (const currencies of Object.values(balanceMap)) {
    for (const [currency, amount] of Object.entries(currencies)) {
      totals[currency] ||= { owedToMe: 0, iOwe: 0, net: 0 };
      if (amount > 0) totals[currency].owedToMe += amount;
      if (amount < 0) totals[currency].iOwe += Math.abs(amount);
      totals[currency].net += amount;
    }
  }
  return totals;
}

export function runningStatement(entries, personId, currency) {
  const rows = entries
    .filter(e => e.personId === personId && PERSON_ENTRY_TYPES.includes(e.type) && (!currency || (e.currency || 'USD') === currency))
    .sort((a, b) => new Date(a.date + 'T00:00:00').getTime() - new Date(b.date + 'T00:00:00').getTime() || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  let running = 0;
  return rows.map(entry => {
    const delta = personDelta(entry);
    running += delta;
    return { ...entry, delta, running };
  });
}

export function validateTransfer(fromAccount, toAccount, fromAmount, toAmount) {
  if (!fromAccount || !toAccount) return 'Choose both accounts.';
  if (fromAccount.id === toAccount.id) return 'Choose two different accounts.';
  if (!(Number(fromAmount) > 0) || !(Number(toAmount) > 0)) return 'Transfer amounts must be greater than zero.';
  return '';
}
