function cleanCurrency(value){
  const currency=String(value||'').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency)?currency:'';
}

function accountCurrency(accountsById,id){
  return cleanCurrency(accountsById.get(id)?.currency);
}

export function transactionFxRate(entry,accounts=[]){
  if(entry?.type!=='account_transfer')return null;
  const accountsById=accounts instanceof Map?accounts:new Map((accounts||[]).map(row=>[row.id,row]));
  const fromCurrency=cleanCurrency(entry.fromCurrency)||accountCurrency(accountsById,entry.fromAccountId);
  const toCurrency=cleanCurrency(entry.toCurrency)||accountCurrency(accountsById,entry.toAccountId);
  const fromAmount=Number(entry.fromAmount);
  const toAmount=Number(entry.toAmount);
  if(!fromCurrency||!toCurrency||fromCurrency===toCurrency||!Number.isFinite(fromAmount)||!Number.isFinite(toAmount)||fromAmount<=0||toAmount<0)return null;
  const rate=toAmount/fromAmount;
  if(!Number.isFinite(rate)||rate<=0)return null;
  return {
    entryId:String(entry.id||''),
    date:String(entry.date||''),
    fromCurrency,
    toCurrency,
    pair:`${fromCurrency}/${toCurrency}`,
    fromAmount,
    toAmount,
    rate,
    inverseRate:rate?1/rate:null,
    source:'recorded_transfer'
  };
}

export function historicalFxRates(entries=[],accounts=[]){
  return (entries||[])
    .map(entry=>transactionFxRate(entry,accounts))
    .filter(Boolean)
    .sort((a,b)=>String(a.date).localeCompare(String(b.date))||String(a.entryId).localeCompare(String(b.entryId)));
}

export function formatFxRate(rate,{maximumFractionDigits=8}={}){
  const value=Number(rate);
  if(!Number.isFinite(value))return '';
  return value.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits});
}

export const FX_POLICY=Object.freeze({
  mode:'recorded-transfers-only',
  note:'Currencies stay separate. Cross-currency rates come only from the amounts recorded on each transfer; Money Tracker never invents or fetches a live rate for offline reports.'
});
