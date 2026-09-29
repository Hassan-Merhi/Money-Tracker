const HEADER_ALIASES = {
  date: ['date','transaction date','posted date','posting date','value date','book date','booking date'],
  description: ['description','details','transaction','narrative','memo','payee','merchant description','reference'],
  merchant: ['merchant','payee','counterparty','vendor'],
  amount: ['amount','transaction amount','value','net amount'],
  debit: ['debit','debit amount','withdrawal','withdrawal amount','money out','outflow','charge','paid out'],
  credit: ['credit','credit amount','deposit','deposit amount','money in','inflow','paid in'],
  externalId: ['transaction id','reference id','reference','id','bank id'],
  currency: ['currency','ccy','curr','currency code']
};

export function normalizeBankHeader(value='') {
  return String(value ?? '').trim().toLowerCase().replace(/[_-]+/g,' ').replace(/\s+/g,' ');
}

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  let raw=String(value ?? '').trim();
  if (!raw) return NaN;
  const negative=/^\(.*\)$/.test(raw);
  raw=raw.replace(/[()]/g,'').replace(/[^0-9,.-]/g,'');
  if (!raw) return NaN;
  const lastComma=raw.lastIndexOf(','), lastDot=raw.lastIndexOf('.');
  if (lastComma>=0 && lastDot>=0) {
    if (lastComma>lastDot) raw=raw.replace(/\./g,'').replace(',','.');
    else raw=raw.replace(/,/g,'');
  } else if (lastComma>=0 && lastDot<0) {
    const decimals=raw.length-lastComma-1;
    raw=decimals>0 && decimals<=2 ? raw.replace(',','.') : raw.replace(/,/g,'');
  }
  const n=Number(raw);
  return Number.isFinite(n) ? (negative ? -Math.abs(n) : n) : NaN;
}

export function parseBankDate(value, order='auto') {
  if (typeof value === 'number' && value>1000 && value<100000) {
    const d=new Date(Date.UTC(1899,11,30)+Math.round(value)*86400000);
    return d.toISOString().slice(0,10);
  }
  const s=String(value ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Number.isNaN(Date.parse(s+'T00:00:00Z')) ? '' : s;
  let m=/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(s);
  if (m) {
    let a=Number(m[1]), b=Number(m[2]), y=Number(m[3]); if (y<100) y+=y>=70?1900:2000;
    let month,day;
    if (order==='dmy') { day=a;month=b; }
    else if (order==='mdy') { month=a;day=b; }
    else if (a>12) { day=a;month=b; }
    else if (b>12) { month=a;day=b; }
    else { month=a;day=b; }
    const iso=`${String(y).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    return Number.isNaN(Date.parse(iso+'T00:00:00Z')) ? '' : iso;
  }
  const d=new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0,10);
}

export function parseBankCsv(text) {
  const rows=[]; let row=[],cell='',quoted=false;
  const source=String(text ?? '').replace(/^\uFEFF/,'');
  const firstLine=source.split(/\r?\n/,1)[0]||'';
  const delimiter=[',',';','\t'].map(ch=>({ch,count:[...firstLine].filter(v=>v===ch).length})).sort((a,b)=>b.count-a.count)[0]?.ch||',';
  for (let i=0;i<source.length;i++) {
    const ch=source[i];
    if (quoted) {
      if (ch==='"' && source[i+1]==='"') { cell+='"';i++; }
      else if (ch==='"') quoted=false;
      else cell+=ch;
    } else if (ch==='"') quoted=true;
    else if (ch===delimiter) { row.push(cell);cell=''; }
    else if (ch==='\n') { row.push(cell);rows.push(row);row=[];cell=''; }
    else if (ch!=='\r') cell+=ch;
  }
  if (cell.length || row.length) { row.push(cell);rows.push(row); }
  const nonEmpty=rows.filter(r=>r.some(v=>String(v).trim()));
  if (!nonEmpty.length) return {headers:[],rows:[]};
  const headers=nonEmpty[0].map((v,i)=>String(v).trim()||`Column ${i+1}`);
  return {headers,rows:nonEmpty.slice(1).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??''])))};
}

export function suggestBankMapping(headers=[]) {
  const out={};
  const normalized=headers.map(h=>({raw:h,n:normalizeBankHeader(h)}));
  for (const [key,aliases] of Object.entries(HEADER_ALIASES)) {
    const exact=normalized.find(h=>aliases.some(a=>h.n===a));
    const partial=normalized.find(h=>aliases.some(a=>h.n.includes(a)||a.includes(h.n)));
    out[key]=(exact||partial)?.raw||'';
  }
  if (out.debit || out.credit) out.amount='';
  return out;
}

export function normalizeBankRows(rows=[],mapping={},options={}) {
  const fallbackCurrency=String(options.fallbackCurrency||'USD').toUpperCase();
  const amountDirection=options.amountDirection==='outflow_positive'?'outflow_positive':'inflow_positive';
  const dateOrder=['dmy','mdy'].includes(options.dateOrder)?options.dateOrder:'auto';
  const items=[],errors=[];
  rows.forEach((row,index)=>{
    const date=parseBankDate(row?.[mapping.date],dateOrder);
    const description=String(row?.[mapping.description] ?? row?.[mapping.merchant] ?? '').trim();
    const merchant=String(mapping.merchant ? row?.[mapping.merchant] ?? '' : '').trim();
    const externalId=String(mapping.externalId ? row?.[mapping.externalId] ?? '' : '').trim();
    const currency=String(mapping.currency ? row?.[mapping.currency] ?? fallbackCurrency : fallbackCurrency).trim().toUpperCase();
    let signedAmount=NaN;
    if (mapping.debit || mapping.credit) {
      const debit=Math.abs(parseNumber(mapping.debit ? row?.[mapping.debit] : '') || 0);
      const credit=Math.abs(parseNumber(mapping.credit ? row?.[mapping.credit] : '') || 0);
      signedAmount=credit-debit;
    } else if (mapping.amount) {
      const amount=parseNumber(row?.[mapping.amount]);
      if (Number.isFinite(amount)) signedAmount=amountDirection==='outflow_positive' ? -amount : amount;
    }
    if (!date || !description || !Number.isFinite(signedAmount) || Math.abs(signedAmount)<0.000001 || !/^[A-Z]{3,5}$/.test(currency)) {
      errors.push(`Row ${index+2}: needs a valid date, description, non-zero amount, and currency.`);
      return;
    }
    items.push({date,description:description.slice(0,300),merchant:merchant.slice(0,120),signedAmount:Number(signedAmount.toFixed(8)),currency,externalId:externalId.slice(0,180),sourceRow:index+2});
  });
  return {items,errors};
}

export function bankDirectionLabel(signedAmount) {
  return Number(signedAmount)<0 ? 'Money out' : 'Money in';
}
