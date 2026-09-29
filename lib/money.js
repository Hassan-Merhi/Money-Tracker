const ZERO_DECIMAL = new Set([
  'BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','UYI','VND','VUV','XAF','XOF','XPF'
]);
const THREE_DECIMAL = new Set(['BHD','IQD','JOD','KWD','LYD','OMR','TND']);
const FOUR_DECIMAL = new Set(['CLF','UYW']);

export const MONEY_STORAGE_VERSION = 1;

export function currencyExponent(currency='USD') {
  const code=String(currency||'USD').toUpperCase();
  if(ZERO_DECIMAL.has(code))return 0;
  if(THREE_DECIMAL.has(code))return 3;
  if(FOUR_DECIMAL.has(code))return 4;
  return 2;
}

export function moneyFactor(currency='USD') {
  return 10 ** currencyExponent(currency);
}

export function toMinor(value,currency='USD',{allowNegative=true,allowZero=true}={}) {
  const n=Number(value);
  if(!Number.isFinite(n))throw new Error('Money amount must be a finite number.');
  if(!allowNegative&&n<0)throw new Error('Money amount cannot be negative.');
  if(!allowZero&&n===0)throw new Error('Money amount must be greater than zero.');
  const factor=moneyFactor(currency);
  const scaled=n*factor;
  const minor=Math.round(scaled);
  const tolerance=Math.max(1e-7,Math.abs(scaled)*Number.EPSILON*16);
  if(Math.abs(scaled-minor)>tolerance){
    throw new Error(`${String(currency||'USD').toUpperCase()} supports at most ${currencyExponent(currency)} decimal place${currencyExponent(currency)===1?'':'s'}.`);
  }
  if(!Number.isSafeInteger(minor))throw new Error('Money amount is too large to store safely.');
  return minor;
}

export function fromMinor(value,currency='USD') {
  const minor=Number(value);
  if(!Number.isSafeInteger(minor))throw new Error('Stored money amount is not a safe integer.');
  return minor/moneyFactor(currency);
}

export function normalizeMoney(value,currency='USD',options={}) {
  return fromMinor(toMinor(value,currency,options),currency);
}

export function addMinor(a,b) {
  const out=Number(a)+Number(b);
  if(!Number.isSafeInteger(out))throw new Error('Money total is too large to store safely.');
  return out;
}

export function sumMinor(values=[]) {
  let total=0;
  for(const value of values) total=addMinor(total,Number(value)||0);
  return total;
}

export function sameMoney(a,b,currency='USD') {
  try{return toMinor(a,currency)===toMinor(b,currency);}catch{return false;}
}

export function sumMoney(values,currency='USD') {
  return fromMinor(sumMinor((values||[]).map(value=>toMinor(value,currency))),currency);
}
