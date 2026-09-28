import { inflateRawSync } from 'node:zlib';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function xmlEscape(value='') {
  return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[ch]));
}
function xmlDecode(value='') {
  return String(value)
    .replace(/&#(x?[0-9a-f]+);/gi, (_,n) => String.fromCodePoint(n[0].toLowerCase()==='x' ? parseInt(n.slice(1),16) : parseInt(n,10)))
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
}

function colName(index) {
  let n=index+1, out='';
  while(n){ n--; out=String.fromCharCode(65+(n%26))+out; n=Math.floor(n/26); }
  return out;
}

let crcTable;
function makeCrcTable(){
  const table=new Uint32Array(256);
  for(let n=0;n<256;n++){
    let c=n;
    for(let k=0;k<8;k++) c=(c&1)?0xedb88320^(c>>>1):c>>>1;
    table[n]=c>>>0;
  }
  return table;
}
function crc32(buf){
  crcTable ||= makeCrcTable();
  let c=0xffffffff;
  for(const b of buf) c=crcTable[(c^b)&0xff]^(c>>>8);
  return (c^0xffffffff)>>>0;
}
function u16(n){const b=Buffer.allocUnsafe(2);b.writeUInt16LE(n>>>0);return b;}
function u32(n){const b=Buffer.allocUnsafe(4);b.writeUInt32LE(n>>>0);return b;}

export function zipStore(files){
  const locals=[]; const centrals=[]; let offset=0;
  for(const file of files){
    const name=Buffer.from(file.name,'utf8'); const data=Buffer.isBuffer(file.data)?file.data:Buffer.from(file.data,'utf8'); const crc=crc32(data);
    const local=Buffer.concat([
      u32(0x04034b50),u16(20),u16(0x0800),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),name,data
    ]);
    locals.push(local);
    const central=Buffer.concat([
      u32(0x02014b50),u16(20),u16(20),u16(0x0800),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),name
    ]);
    centrals.push(central); offset+=local.length;
  }
  const centralDir=Buffer.concat(centrals);
  const end=Buffer.concat([u32(0x06054b50),u16(0),u16(0),u16(files.length),u16(files.length),u32(centralDir.length),u32(offset),u16(0)]);
  return Buffer.concat([...locals,centralDir,end]);
}

export function unzipEntries(buffer, {maxFiles=200,maxUncompressed=20_000_000}={}){
  const buf=Buffer.isBuffer(buffer)?buffer:Buffer.from(buffer);
  const entries=new Map(); let pos=0,total=0,count=0;
  while(pos+4<=buf.length && buf.readUInt32LE(pos)===0x04034b50){
    if(++count>maxFiles) throw new Error('Workbook has too many files.');
    const flags=buf.readUInt16LE(pos+6), method=buf.readUInt16LE(pos+8), compSize=buf.readUInt32LE(pos+18), uncompSize=buf.readUInt32LE(pos+22), nameLen=buf.readUInt16LE(pos+26), extraLen=buf.readUInt16LE(pos+28);
    if(flags&0x08) throw new Error('Unsupported XLSX ZIP layout.');
    const name=buf.subarray(pos+30,pos+30+nameLen).toString('utf8');
    const start=pos+30+nameLen+extraLen, end=start+compSize;
    if(end>buf.length) throw new Error('Corrupt XLSX archive.');
    let data;
    if(method===0) data=buf.subarray(start,end);
    else if(method===8) data=inflateRawSync(buf.subarray(start,end));
    else throw new Error('Unsupported XLSX compression method.');
    if(uncompSize && data.length!==uncompSize) throw new Error('Corrupt XLSX entry.');
    total+=data.length; if(total>maxUncompressed) throw new Error('Workbook is too large.');
    entries.set(name,data); pos=end;
  }
  if(!entries.size) throw new Error('Not a valid XLSX file.');
  return entries;
}

function sheetXml(headers, rows){
  const all=[headers,...rows.map(row=>headers.map(h=>row[h] ?? ''))];
  const rowsXml=all.map((row,ri)=>{
    const cells=row.map((value,ci)=>{
      const ref=`${colName(ci)}${ri+1}`;
      if(typeof value==='number' && Number.isFinite(value)) return `<c r="${ref}" s="${ri===0?1:0}"><v>${value}</v></c>`;
      const text=xmlEscape(value==null?'':value);
      return `<c r="${ref}" t="inlineStr" s="${ri===0?1:0}"><is><t xml:space="preserve">${text}</t></is></c>`;
    }).join('');
    return `<row r="${ri+1}">${cells}</row>`;
  }).join('');
  const width=Math.min(60,Math.max(12,...headers.map(h=>String(h).length+2)));
  return `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${Math.max(1,headers.length)}" width="${width}" customWidth="1"/></cols><sheetData>${rowsXml}</sheetData><autoFilter ref="A1:${colName(Math.max(0,headers.length-1))}${Math.max(1,all.length)}"/></worksheet>`;
}

function normalizeSheetName(name,index){
  const clean=String(name||`Sheet ${index+1}`).replace(/[\\/?*\[\]:]/g,' ').trim().slice(0,31);
  return clean||`Sheet ${index+1}`;
}

export function createWorkbook(sheets){
  if(!Array.isArray(sheets)||!sheets.length) throw new Error('At least one sheet is required.');
  const clean=sheets.map((s,i)=>({name:normalizeSheetName(s.name,i),headers:Array.isArray(s.headers)?s.headers.map(String):[],rows:Array.isArray(s.rows)?s.rows:[]}));
  const workbookSheets=clean.map((s,i)=>`<sheet name="${xmlEscape(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('');
  const rels=clean.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('');
  const overrides=clean.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const files=[
    {name:'[Content_Types].xml',data:`${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>`},
    {name:'_rels/.rels',data:`${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
    {name:'xl/workbook.xml',data:`${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`},
    {name:'xl/_rels/workbook.xml.rels',data:`${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`},
    {name:'xl/styles.xml',data:`${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`}
  ];
  clean.forEach((s,i)=>files.push({name:`xl/worksheets/sheet${i+1}.xml`,data:sheetXml(s.headers,s.rows)}));
  return zipStore(files);
}

function relMap(xml){
  const out=new Map();
  for(const m of xml.matchAll(/<Relationship\b([^>]+)\/?\s*>/g)){
    const attrs=m[1], id=/\bId="([^"]+)"/.exec(attrs)?.[1], target=/\bTarget="([^"]+)"/.exec(attrs)?.[1];
    if(id&&target) out.set(id,target);
  }
  return out;
}
function sharedStrings(xml){
  const out=[];
  for(const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)){
    let text=''; for(const t of si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text+=xmlDecode(t[1]); out.push(text);
  }
  return out;
}
function parseSheet(xml, shared, limitRows=5000){
  const rowMap=new Map(); let maxCol=0;
  for(const cm of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)){
    const attrs=cm[1], body=cm[2], ref=/\br="([A-Z]+)(\d+)"/.exec(attrs); if(!ref)continue;
    const rowNum=Number(ref[2]); if(rowNum>limitRows+50) continue;
    let ci=0; for(const ch of ref[1]) ci=ci*26+(ch.charCodeAt(0)-64); ci--; maxCol=Math.max(maxCol,ci);
    const type=/\bt="([^"]+)"/.exec(attrs)?.[1]||''; let value='';
    if(type==='inlineStr'){
      for(const t of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) value+=xmlDecode(t[1]);
    } else {
      const raw=/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
      if(type==='s') value=shared[Number(raw)] ?? '';
      else if(type==='b') value=raw==='1';
      else if(type==='str') value=xmlDecode(raw);
      else value=raw===''?'':(Number.isFinite(Number(raw))?Number(raw):xmlDecode(raw));
    }
    if(!rowMap.has(rowNum)) rowMap.set(rowNum,new Map()); rowMap.get(rowNum).set(ci,value);
  }
  const nums=[...rowMap.keys()].sort((a,b)=>a-b); if(!nums.length)return {headers:[],rows:[]};
  const headerNum=nums.find(n=>[...rowMap.get(n).values()].some(v=>String(v).trim()!=='')); if(!headerNum)return {headers:[],rows:[]};
  const hmap=rowMap.get(headerNum), headers=[]; const seen=new Map();
  for(let i=0;i<=maxCol;i++){
    let h=String(hmap.get(i)??'').trim(); if(!h)h=`Column ${colName(i)}`;
    const count=(seen.get(h)||0)+1; seen.set(h,count); if(count>1)h=`${h} ${count}`; headers.push(h);
  }
  const rows=[];
  for(const n of nums){
    if(n<=headerNum)continue; const map=rowMap.get(n); const obj={}; let nonempty=false;
    headers.forEach((h,i)=>{const v=map.get(i)??''; obj[h]=v; if(String(v).trim()!=='')nonempty=true;});
    if(nonempty)rows.push(obj); if(rows.length>=limitRows)break;
  }
  return {headers,rows};
}

export function parseWorkbook(buffer,{limitRows=5000}={}){
  const entries=unzipEntries(buffer);
  const workbook=entries.get('xl/workbook.xml')?.toString('utf8');
  const relsXml=entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if(!workbook||!relsXml) throw new Error('Workbook structure is missing.');
  const rels=relMap(relsXml), shared=entries.get('xl/sharedStrings.xml')?sharedStrings(entries.get('xl/sharedStrings.xml').toString('utf8')):[];
  const sheets=[];
  for(const sm of workbook.matchAll(/<sheet\b([^>]+)\/?\s*>/g)){
    const attrs=sm[1], name=xmlDecode(/\bname="([^"]*)"/.exec(attrs)?.[1]||'Sheet'), rid=/\br:id="([^"]+)"/.exec(attrs)?.[1];
    if(!rid)continue; let target=rels.get(rid); if(!target)continue;
    target=target.replace(/^\/?xl\//,''); const path=`xl/${target.replace(/^\.\//,'')}`; const data=entries.get(path); if(!data)continue;
    const parsed=parseSheet(data.toString('utf8'),shared,limitRows); sheets.push({name,...parsed});
  }
  if(!sheets.length) throw new Error('Workbook contains no readable sheets.');
  return {sheets};
}

export function ledgerWorkbook(state,{peopleBalances={}}={}){
  const personHeaders=['ID','Name','Note','Currency','Balance','Direction'];
  const peopleRows=[];
  for(const p of state.people||[]){
    const balances=peopleBalances[p.id]||{}; const currencies=Object.keys(balances).length?Object.keys(balances):[state.settings?.defaultCurrency||'USD'];
    for(const currency of currencies){ const amount=Number(balances[currency]||0); peopleRows.push({'ID':p.id,'Name':p.name,'Note':p.note||'','Currency':currency,'Balance':Math.abs(amount),'Direction':amount<0?'I owe them':'They owe me'}); }
  }
  const accountRows=(state.accounts||[]).map(a=>({'ID':a.id,'Name':a.name,'Type':a.type,'Currency':a.currency,'Opening Balance':Number(a.openingBalance||0)}));
  const peopleById=new Map((state.people||[]).map(p=>[p.id,p.name])), accountsById=new Map((state.accounts||[]).map(a=>[a.id,a.name]));
  const txnRows=(state.entries||[]).map(e=>({'ID':e.id,'Date':e.date,'Type':e.type,'Person':peopleById.get(e.personId)||'','Account':accountsById.get(e.accountId)||'','Amount':Number(e.amount||0),'Currency':e.currency||'','Merchant':e.merchant||'','Description':e.description||'','From Account':accountsById.get(e.fromAccountId)||'','To Account':accountsById.get(e.toAccountId)||'','From Amount':e.fromAmount??'','To Amount':e.toAmount??'','Signed Amount':e.signedAmount??''}));
  const readme=[
    {'Section':'Purpose','Details':'Use People for opening balances, Accounts for account setup, and Transactions for ledger history.'},
    {'Section':'Balance direction','Details':'They owe me = positive balance. I owe them = negative balance.'},
    {'Section':'Import','Details':'The app can import this workbook again or map another workbook in the Data & Documents center.'},
    {'Section':'Safety','Details':'Always review the import preview before applying rows to your ledger.'}
  ];
  return createWorkbook([
    {name:'README',headers:['Section','Details'],rows:readme},
    {name:'People',headers:personHeaders,rows:peopleRows},
    {name:'Accounts',headers:['ID','Name','Type','Currency','Opening Balance'],rows:accountRows},
    {name:'Transactions',headers:['ID','Date','Type','Person','Account','Amount','Currency','Merchant','Description','From Account','To Account','From Amount','To Amount','Signed Amount'],rows:txnRows}
  ]);
}

export function importTemplateWorkbook(){
  return createWorkbook([
    {name:'README',headers:['Section','Details'],rows:[
      {'Section':'People opening balances','Details':'Fill Name, Currency, Balance, and Direction. Direction must be “They owe me” or “I owe them”.'},
      {'Section':'Accounts','Details':'Type can be Bank, Cash, Card, Wallet, or Other.'},
      {'Section':'Transactions','Details':'Use transaction types: paid_for_person, received_from_person, borrowed_from_person, paid_to_person, person_adjustment, account_transfer.'}
    ]},
    {name:'People',headers:['Name','Note','Currency','Balance','Direction'],rows:[]},
    {name:'Accounts',headers:['Name','Type','Currency','Opening Balance'],rows:[]},
    {name:'Transactions',headers:['Date','Type','Person','Account','Amount','Currency','Merchant','Description','From Account','To Account','From Amount','To Amount','Signed Amount'],rows:[]}
  ]);
}
