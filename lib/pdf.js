function cleanText(value='') {
  return String(value).normalize('NFKD').replace(/[^\x20-\x7E]/g,'?');
}
function pdfEscape(value='') { return cleanText(value).replace(/([\\()])/g,'\\$1'); }
function moneyText(amount,currency='USD') {
  const n=Number(amount||0); return `${n<0?'-':''}${Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:currency==='LBP'?0:2,maximumFractionDigits:currency==='LBP'?0:2})} ${currency}`;
}
function wrap(text,max=88){
  const words=cleanText(text).split(/\s+/).filter(Boolean),lines=[];let line='';
  for(const w of words){const next=line?`${line} ${w}`:w;if(next.length>max&&line){lines.push(line);line=w;}else line=next;} if(line)lines.push(line); return lines.length?lines:[''];
}
function textCmd(x,y,text,size=10,bold=false){ return `BT /${bold?'F2':'F1'} ${size} Tf 0.12 0.15 0.2 rg ${x} ${y} Td (${pdfEscape(text)}) Tj ET\n`; }
function lightTextCmd(x,y,text,size=9){ return `BT /F1 ${size} Tf 0.42 0.45 0.5 rg ${x} ${y} Td (${pdfEscape(text)}) Tj ET\n`; }
function lineCmd(x1,y1,x2,y2){ return `0.88 0.89 0.91 RG 0.6 w ${x1} ${y1} m ${x2} ${y2} l S\n`; }

class PageBuilder {
  constructor(title,subtitle,pageNumber){
    this.content=''; this.y=742; this.pageNumber=pageNumber;
    this.content+='0.07 0.09 0.13 rg 36 778 28 28 re f\n';
    this.content+=`BT /F2 16 Tf 1 1 1 rg 44 786 Td (M) Tj ET\n`;
    this.content+=textCmd(76,790,title,16,true);
    if(subtitle) this.content+=lightTextCmd(76,775,subtitle,8.5);
    this.content+=lineCmd(36,764,576,764);
    this.content+=lightTextCmd(520,26,`Page ${pageNumber}`,8);
  }
  ensure(height,onNew){ if(this.y-height<54)return onNew(); return this; }
  heading(text){this.content+=textCmd(36,this.y,text,11.5,true);this.y-=18;return this;}
  row(left,right='',opts={}){
    const lines=wrap(left,opts.max||72); const needed=Math.max(16,lines.length*12+4); this.content+=textCmd(42,this.y,lines[0]||'',opts.size||9,!!opts.bold);
    if(right)this.content+=textCmd(430,this.y,right,opts.size||9,!!opts.rightBold);
    for(let i=1;i<lines.length;i++)this.content+=textCmd(42,this.y-i*11,lines[i],opts.size||9,false);
    this.y-=needed; if(opts.rule)this.content+=lineCmd(42,this.y+5,570,this.y+5); return this;
  }
  spacer(h=8){this.y-=h;return this;}
  summaryCard(label,value,x,width=168){
    this.content+='0.96 0.97 0.98 rg '+x+' '+(this.y-42)+' '+width+' 48 re f\n';
    this.content+=lightTextCmd(x+10,this.y-12,label.toUpperCase(),7.5);
    this.content+=textCmd(x+10,this.y-30,value,11,true); return this;
  }
}

export function createPdf({title='Money Tracker',subtitle='',build}){
  const pages=[]; let page=new PageBuilder(title,subtitle,1); pages.push(page);
  const ctx={
    page:()=>page,
    newPage(){page=new PageBuilder(title,subtitle,pages.length+1);pages.push(page);return page;},
    ensure(h){if(page.y-h<54)this.newPage();return page;}
  };
  build(ctx);
  const objects=[]; const add=(body)=>{objects.push(body);return objects.length;};
  const catalogId=add(''); const pagesId=add(''); const f1=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); const f2=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pageIds=[];
  for(const p of pages){
    const stream=Buffer.from(p.content,'latin1'); const contentId=add(`<< /Length ${stream.length} >>\nstream\n${p.content}endstream`);
    const pageId=add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contentId} 0 R >>`); pageIds.push(pageId);
  }
  objects[catalogId-1]=`<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId-1]=`<< /Type /Pages /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const chunks=[Buffer.from('%PDF-1.4\n%MoneyTracker\n','latin1')]; const offsets=[0]; let length=chunks[0].length;
  objects.forEach((obj,i)=>{offsets[i+1]=length;const b=Buffer.from(`${i+1} 0 obj\n${obj}\nendobj\n`,'latin1');chunks.push(b);length+=b.length;});
  const xref=length; let tail=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(let i=1;i<=objects.length;i++)tail+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
  tail+=`trailer\n<< /Size ${objects.length+1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`; chunks.push(Buffer.from(tail,'latin1'));
  return Buffer.concat(chunks);
}

export function summaryPdf(state,{personBalances={},accountBalances={}}={}){
  const generated=new Date().toISOString().slice(0,10); const totals={};
  for(const currs of Object.values(personBalances)){for(const [c,nRaw] of Object.entries(currs)){const n=Number(nRaw||0);totals[c]||={owed:0,iOwe:0,net:0};if(n>0)totals[c].owed+=n;if(n<0)totals[c].iOwe+=Math.abs(n);totals[c].net+=n;}}
  return createPdf({title:state.settings?.displayName||'My Ledger',subtitle:`Ledger summary - generated ${generated}`,build(ctx){
    let p=ctx.page(); p.heading('Personal position');
    const currencies=Object.keys(totals); if(!currencies.length)p.row('No personal balances yet.');
    for(const c of currencies){ctx.ensure(70);p=ctx.page();const t=totals[c];p.row(c,'', {bold:true});p.row('People owe me',moneyText(t.owed,c));p.row('I owe people',moneyText(t.iOwe,c));p.row('Net position',moneyText(t.net,c),{rule:true});}
    ctx.ensure(40);p=ctx.page();p.spacer(6).heading('People');
    if(!(state.people||[]).length)p.row('No people yet.');
    for(const person of state.people||[]){const parts=Object.entries(personBalances[person.id]||{}).filter(([,n])=>Math.abs(Number(n))>1e-9).map(([c,n])=>moneyText(n,c));ctx.ensure(28);p=ctx.page();p.row(person.name,parts.join(' | ')||'Settled',{rule:true});}
    ctx.ensure(40);p=ctx.page();p.spacer(8).heading('Accounts');
    if(!(state.accounts||[]).length)p.row('No accounts yet.');
    for(const a of state.accounts||[]){ctx.ensure(28);p=ctx.page();p.row(`${a.name} (${a.type})`,moneyText(accountBalances[a.id]||0,a.currency),{rule:true});}
    ctx.ensure(40);p=ctx.page();p.spacer(8).heading('Recent activity'); const recent=[...(state.entries||[])].sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,40);
    if(!recent.length)p.row('No transactions yet.');
    for(const e of recent){ctx.ensure(38);p=ctx.page();p.row(`${e.date} - ${e.description||e.merchant||e.type}`,e.currency?moneyText(e.amount,e.currency):'',{rule:true,max:62});}
  }});
}

export function personStatementPdf(state,person,{currency,rows=[]}={}){
  const selected=currency||rows[0]?.currency||state.settings?.defaultCurrency||'USD'; const filtered=rows.filter(r=>!currency||r.currency===currency); const current=filtered.length?filtered[filtered.length-1].running:0; const generated=new Date().toISOString().slice(0,10);
  return createPdf({title:person.name,subtitle:`Statement - ${selected} - generated ${generated}`,build(ctx){
    let p=ctx.page(); p.summaryCard('Current balance',moneyText(current,selected),36,260); p.summaryCard('Transactions',String(filtered.length),312,264); p.y-=62;
    p.row(current>0?'They owe you':'You owe them',current===0?'Settled':moneyText(Math.abs(current),selected),{bold:true,rightBold:true,rule:true}); p.spacer(10);p.heading('Statement activity');
    if(!filtered.length)p.row('No activity for this currency.');
    for(const r of filtered){ctx.ensure(46);p=ctx.page();const delta=Number(r.delta||0);p.row(`${r.date}  ${r.description||r.merchant||r.type}`,`${delta>=0?'+':''}${moneyText(delta,selected)}`,{bold:false,rightBold:true,max:58});p.row(`Running balance`,moneyText(r.running,selected),{size:8,rule:true});}
    ctx.ensure(34);p=ctx.page();p.spacer(10).row('Balance convention','Positive = they owe you; negative = you owe them.',{size:8});
  }});
}