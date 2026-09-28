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

export function entryTouchesPerson(entry, personId) {
  if (!entry || !personId) return false;
  if (entry.type === SPLIT_ENTRY_TYPE) return !!splitForPerson(entry, personId);
  return entry.personId === personId && PERSON_ENTRY_TYPES.includes(entry.type);
}

export function personDelta(entry, personId = null) {
  const amount = Number(entry.amount || 0);
  if (entry.type === SPLIT_ENTRY_TYPE) {
    if (personId) return Number(splitForPerson(entry, personId)?.amount || 0);
    return (entry.splits || []).reduce((sum, split) => sum + Number(split.amount || 0), 0);
  }
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
    case 'paid_for_person':
    case SPLIT_ENTRY_TYPE:
      return -amount;
    case 'received_from_person':
    case 'borrowed_from_person':
      return amount;
    case 'paid_to_person':
    case 'account_expense':
      return -amount;
    case 'account_income':
      return amount;
    case 'account_adjustment':
      return Number(entry.signedAmount ?? amount ?? 0);
    default:
      return 0;
  }
}

export function personBalances(entries, people) {
  const out = {};
  for (const person of people) out[person.id] = {};
  for (const entry of entries) {
    const currency = entry.currency || 'USD';
    if (entry.type === SPLIT_ENTRY_TYPE) {
      for (const split of entry.splits || []) {
        if (!split.personId) continue;
        out[split.personId] ||= {};
        out[split.personId][currency] = (out[split.personId][currency] || 0) + Number(split.amount || 0);
      }
      continue;
    }
    if (!entry.personId || !PERSON_ENTRY_TYPES.includes(entry.type)) continue;
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
    if (!PERSON_ENTRY_TYPES.includes(entry.type)) continue;
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
  const rows = [];
  for (const entry of entries) {
    if (!entryTouchesPerson(entry, personId)) continue;
    if (currency && (entry.currency || 'USD') !== currency) continue;
    if (entry.type === SPLIT_ENTRY_TYPE) {
      const split = splitForPerson(entry, personId);
      rows.push({
        ...entry,
        personId,
        amount: Number(split?.amount || 0),
        splitNote: split?.note || '',
        description: split?.note ? [entry.description, split.note].filter(Boolean).join(' · ') : entry.description
      });
    } else {
      rows.push(entry);
    }
  }
  rows.sort((a, b) => new Date(a.date + 'T00:00:00').getTime() - new Date(b.date + 'T00:00:00').getTime() || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  let running = 0;
  return rows.map(entry => {
    const delta = entry.type === SPLIT_ENTRY_TYPE ? Number(entry.amount || 0) : personDelta(entry);
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

export function validateSplit(splits, total) {
  if (!Array.isArray(splits) || splits.length < 2) return 'Add at least two people to the split.';
  const seen = new Set();
  let sum = 0;
  for (const split of splits) {
    if (!split.personId) return 'Choose a person for every split row.';
    if (seen.has(split.personId)) return 'Each person can appear only once in a split.';
    seen.add(split.personId);
    const amount = Number(split.amount);
    if (!(amount > 0)) return 'Every split amount must be greater than zero.';
    sum += amount;
  }
  if (Math.abs(sum - Number(total || 0)) > 0.005) return 'Split amounts must add up to the transaction total.';
  return '';
}
