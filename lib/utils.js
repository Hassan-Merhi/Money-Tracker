import { currencyExponent, toMinor } from './money.js';

export const CURRENCIES = ['USD', 'LBP', 'EUR', 'GBP', 'AED', 'SAR'];

export function money(amount, currency = 'USD') {
  try {
    const digits=currencyExponent(currency);return new Intl.NumberFormat(undefined,{style:'currency',currency,minimumFractionDigits:digits,maximumFractionDigits:digits}).format(Number(amount||0));
  } catch {
    return `${Number(amount||0).toFixed(currencyExponent(currency))} ${currency}`;
  }
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

// Calendar date (YYYY-MM-DD) for `date` as seen in an IANA time zone. Falls back to
// the UTC date from today() when the zone is missing or invalid.
export function dateInTimeZone(timeZone, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(date);
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    if (!map.year || !map.month || !map.day) return today();
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return today();
  }
}

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[ch]));
}

export function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function balancesText(balanceObj = {}) {
  const parts = Object.entries(balanceObj).filter(([currency,v]) => { try{return toMinor(v,currency)!==0;}catch{return Number(v)!==0;} }).map(([c,v]) => money(v, c));
  return parts.length ? parts.join(' · ') : 'Settled';
}

export function prettyType(type) {
  return ({
    paid_for_person: 'Paid for person',
    split_paid_for_people: 'Split purchase',
    received_from_person: 'Received from person',
    borrowed_from_person: 'Borrowed from person',
    paid_to_person: 'Paid person back',
    person_adjustment: 'Balance adjustment',
    account_transfer: 'Account transfer',
    account_expense: 'Account expense',
    account_income: 'Account income',
    account_adjustment: 'Account adjustment'
  })[type] || type;
}
