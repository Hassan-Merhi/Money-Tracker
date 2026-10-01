import { currencyExponent, toMinor } from './money.js';
import { prettyType } from './utils.js';
import { runningStatement } from './ledger.js';
const encoder=new TextEncoder();
function pdfEsc(value=''){return String(value).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').replace(/[\r\n]+/g,' ');}
function ascii(value=''){return String(value).normalize('NFKD').replace(/[^\x20-\x7E]/g,'?');}
function fmtMoney(amount,currency){const n=Number(amount||0),digits=currencyExponent(currency);return `${currency} ${n.toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits})}`;}
function pdfDate(value=''){const m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})/);if(!m)return String(value||'');const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];return `${Number(m[3])} ${months[Number(m[2])-1]} ${m[1]}`;}
const HELVETICA_WIDTHS={[0x20]:278,0x21:278,0x22:355,0x23:556,0x24:556,0x25:889,0x26:667,0x27:191,0x28:333,0x29:333,0x2a:389,0x2b:584,0x2c:278,0x2d:333,0x2e:278,0x2f:278,0x30:556,0x31:556,0x32:556,0x33:556,0x34:556,0x35:556,0x36:556,0x37:556,0x38:556,0x39:556,0x3a:278,0x3b:278,0x3c:584,0x3d:584,0x3e:584,0x3f:556,0x40:1015,0x41:667,0x42:667,0x43:722,0x44:722,0x45:667,0x46:611,0x47:778,0x48:722,0x49:278,0x4a:500,0x4b:667,0x4c:556,0x4d:833,0x4e:722,0x4f:778,0x50:667,0x51:778,0x52:722,0x53:667,0x54:611,0x55:722,0x56:667,0x57:944,0x58:667,0x59:667,0x5a:611,0x5b:278,0x5c:278,0x5d:278,0x5e:469,0x5f:556,0x60:333,0x61:556,0x62:556,0x63:500,0x64:556,0x65:556,0x66:278,0x67:556,0x68:556,0x69:222,0x6a:222,0x6b:500,0x6c:222,0x6d:833,0x6e:556,0x6f:556,0x70:556,0x71:556,0x72:333,0x73:500,0x74:278,0x75:556,0x76:500,0x77:722,0x78:500,0x79:500,0x7a:500,0x7b:334,0x7c:260,0x7d:334,0x7e:584};
function helvWidth(text,size){let w=0;for(const ch of String(text))w+=HELVETICA_WIDTHS[ch.codePointAt(0)]??556;return w*size/1000;}
function clip(value=''){
  const s=String(value||'').replace(/\s+/g,' ').trim(),max=356;
  if(helvWidth(s,8)<=max)return s;
  let out=s;
  while(out.length>1&&helvWidth(`${out}...`,8)>max)out=out.slice(0,-1);
  return `${out}...`;
}
function linesForReport(state,snapshot,{personName='',personId=''}={}){
  const lines=[];
  lines.push({text:personName?`Statement - ${personName}`:'Money Tracker Report',size:20,bold:true,gap:9});
  lines.push({text:state?.settings?.displayName||'My Ledger',size:11,gap:12});
  if(snapshot.filters.from||snapshot.filters.to)lines.push({text:`Period: ${snapshot.filters.from||'Beginning'} to ${snapshot.filters.to||'Today'}`,size:10,gap:12});
  lines.push({text:personName?`Coverage: all time - ${snapshot.transactionCount} ${snapshot.transactionCount===1?'entry':'entries'}`:`Transactions in period: ${snapshot.transactionCount}`,size:11,bold:true,gap:10});
  if(personName){
    lines.push({text:'Current balance',size:13,bold:true,gap:8});
    const outstanding=snapshot.outstanding.filter(r=>r.personName===personName);
    if(!outstanding.length)lines.push({text:'You are settled up - no outstanding balance.',size:10,gap:12});
    for(const row of outstanding)lines.push({text:row.direction==='owes_me'?`${personName} owes you ${fmtMoney(Math.abs(row.amount),row.currency)}`:`You owe ${personName} ${fmtMoney(Math.abs(row.amount),row.currency)}`,size:11,bold:true,gap:8});
  }
  for(const [currency,v] of Object.entries(snapshot.activity)){
    if(personName)lines.push({text:`${currency}: you paid for them ${fmtMoney(v.charged,currency)}, they paid you back ${fmtMoney(v.recovered,currency)}, you borrowed ${fmtMoney(v.borrowed,currency)}, you repaid ${fmtMoney(v.repaid,currency)}`,size:9,gap:6});
    else lines.push({text:`${currency}: charged ${fmtMoney(v.charged,currency)}, recovered ${fmtMoney(v.recovered,currency)}, borrowed ${fmtMoney(v.borrowed,currency)}, repaid ${fmtMoney(v.repaid,currency)}`,size:9,gap:6});
  }
  if(!personName){
    lines.push({text:'Outstanding balances',size:13,bold:true,gap:8});
    const outstanding=snapshot.outstanding;
    if(!outstanding.length)lines.push({text:'No outstanding balances.',size:10,gap:6});
    for(const row of outstanding.slice(0,30))lines.push({text:`${row.personName}: ${row.direction==='owes_me'?'owes you':'you owe'} ${fmtMoney(Math.abs(row.amount),row.currency)}`,size:10,gap:6});
  }
  if(!personName){
    lines.push({text:'Accounts',size:13,bold:true,gap:8});
    for(const a of snapshot.accounts.slice(0,20))lines.push({text:`${a.name} (${a.type}) - ${fmtMoney(a.balance,a.currency)}`,size:10,gap:6});
        if(snapshot.categorySpending?.length){lines.push({text:'Personal spending by category',size:13,bold:true,gap:8});for(const row of snapshot.categorySpending.slice(0,14))lines.push({text:`${row.categoryName}: ${fmtMoney(row.amount,row.currency)} across ${row.count} transaction${row.count===1?'':'s'}`,size:10,gap:6});}
    if(snapshot.budgets?.length){lines.push({text:'Budgets',size:13,bold:true,gap:8});for(const row of snapshot.budgets.slice(0,20))lines.push({text:`${row.categoryName}: ${fmtMoney(row.monthlyLimit,row.currency)} monthly`,size:10,gap:6});}
    if(snapshot.fxRates?.length){lines.push({text:'Recorded FX rates',size:13,bold:true,gap:8});for(const row of snapshot.fxRates.slice(-20))lines.push({text:`${row.date}: ${row.fromCurrency} ${row.fromAmount} -> ${row.toCurrency} ${row.toAmount} | 1 ${row.fromCurrency} = ${Number(row.rate).toLocaleString('en-US',{maximumFractionDigits:8})} ${row.toCurrency}`,size:9,gap:5});lines.push({text:'FX policy: recorded transfer amounts only; no live conversion is applied.',size:8,color:'0.45 0.48 0.52',gap:8});}
    for(const [label,series] of [['Receivables movement',snapshot.receivablesMovement],['Personal cash flow',snapshot.cashFlow],['Transfer flow',snapshot.transferFlow]]){
      if(!series?.length)continue;
      lines.push({text:label,size:13,bold:true,gap:8});
      for(const row of series.slice(-12))for(const [currency,value] of Object.entries(row.currencies))lines.push({text:`${row.month}: ${fmtMoney(value,currency)}`,size:9,gap:5});
    }
  }
  if(personId){
    const rows=runningStatement(state?.entries||[],personId);
    lines.push({text:`Statement activity - ${rows.length} ${rows.length===1?'entry':'entries'}, oldest first`,size:13,bold:true,gap:8});
    if(!rows.length)lines.push({text:'No statement entries yet.',size:10,gap:6});
    for(const row of rows.slice(0,150)){
      const currency=row.currency||'USD';
      const dMinor=toMinor(row.delta,currency);
      const dir=dMinor>0?'They owe you more':dMinor<0?'You owe them more':'No change';
      lines.push({parts:[
        {x:48,text:pdfDate(row.date)},
        {x:128,text:prettyType(row.type)},
        {x:252,text:dir},
        {x:428,text:fmtMoney(Math.abs(row.delta||0),currency)}
      ],size:9,gap:4});
      lines.push({parts:[
        {x:48,text:clip(row.description||row.merchant||'')},
        {x:428,text:`Now ${fmtMoney(row.running||0,currency)}`}
      ],size:8,color:'0.45 0.48 0.52',gap:10});
    }
  }else if(snapshot.transactions?.length){
    lines.push({text:'Transactions',size:13,bold:true,gap:8});
    for(const row of snapshot.transactions.slice(0,120)){
      const currency=row.Currency||'',amount=Number(row.Amount||row['From Amount']||0),who=row.Person||row.Merchant||row.Description||'';
      lines.push({text:`${row.Date} | ${row.Type} | ${who} | ${currency?fmtMoney(amount,currency):amount} | ID ${row['Entry ID']}`,size:8,gap:4});
    }
  }
  lines.push({text:'Generated by Money Tracker',size:8,gap:0});
  return lines;
}
function pageContent(lines,pageNo,pageCount){
  let y=792;const out=['q','0.96 0.97 0.99 rg','36 760 540 54 re f','Q'];
  for(const line of lines){
    y-=line.gap??6;
    const size=line.size||10;
    if(Array.isArray(line.parts)){
      for(const part of line.parts){
        const font=part.bold?'F2':'F1';
        const color=part.color||line.color||'0.12 0.15 0.2';
        out.push(`BT /${font} ${part.size||size} Tf ${color} rg ${part.x??48} ${y} Td (${pdfEsc(ascii(part.text))}) Tj ET`);
      }
    }else{
      const font=line.bold?'F2':'F1';
      const color=line.color||'0.12 0.15 0.2';
      out.push(`BT /${font} ${size} Tf ${color} rg 48 ${y} Td (${pdfEsc(ascii(line.text))}) Tj ET`);
    }
    y-=size;
  }
  out.push(`BT /F1 8 Tf 0.45 0.48 0.52 rg 48 28 Td (Page ${pageNo} of ${pageCount}) Tj ET`);
  return out.join('\n');
}
export function buildPdfReport(state,snapshot,options={}){
  const all=linesForReport(state,snapshot,options), pages=[]; let current=[], used=0;
  for(const line of all){const h=(line.size||10)+(line.gap??6);if(current.length&&used+h>690){pages.push(current);current=[];used=0;}current.push(line);used+=h;}if(current.length||!pages.length)pages.push(current);
  const objects=[null];
  objects[1]='<< /Type /Catalog /Pages 2 0 R >>';
  const pageIds=[], contentIds=[]; let next=5;
  for(let i=0;i<pages.length;i++){pageIds.push(next++);contentIds.push(next++);}
  objects[2]=`<< /Type /Pages /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[4]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
  for(let i=0;i<pages.length;i++){
    const content=pageContent(pages[i],i+1,pages.length), contentBytes=encoder.encode(content);
    objects[pageIds[i]]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentIds[i]} 0 R >>`;
    objects[contentIds[i]]=`<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`;
  }
  let pdf='%PDF-1.4\n%MoneyTracker\n', offsets=[0];
  for(let i=1;i<objects.length;i++){offsets[i]=encoder.encode(pdf).length;pdf+=`${i} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=encoder.encode(pdf).length;pdf+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`;for(let i=1;i<objects.length;i++)pdf+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
  pdf+=`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return encoder.encode(pdf);
}
