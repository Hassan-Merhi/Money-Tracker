import { inflateRawSync } from 'node:zlib';

function xmlDecode(value='') {
  return String(value)
    .replace(/&#(x?[0-9a-f]+);/gi, (_,n) => String.fromCodePoint(n[0].toLowerCase()==='x' ? parseInt(n.slice(1),16) : parseInt(n,10)))
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
}

export function unzipEntries(buffer,{maxFiles=250,maxUncompressed=20_000_000}={}){
  const buf=Buffer.isBuffer(buffer)?buffer:Buffer.from(buffer);
  const entries=new Map(); let pos=0,total=0,count=0;
  while(pos+4<=buf.length && buf.readUInt32LE(pos)===0x04034b50){
    if(++count>maxFiles)throw new Error('Workbook has too many files.');
    const flags=buf.readUInt16LE(pos+6),method=buf.readUInt16LE(pos+8),compSize=buf.readUInt32LE(pos+18),uncompSize=buf.readUInt32LE(pos+22),nameLen=buf.readUInt16LE(pos+26),extraLen=buf.readUInt16LE(pos+28);
    if(flags&0x08)throw new Error('Unsupported XLSX ZIP layout.');
    const name=buf.subarray(pos+30,pos+30+nameLen).toString('utf8');
    const start=pos+30+nameLen+extraLen,end=start+compSize;
    if(end>buf.length)throw new Error('Corrupt XLSX archive.');
    if(uncompSize&&total+uncompSize>maxUncompressed)throw new Error('Workbook expands beyond the import limit.');
    let data;
    if(method===0)data=buf.subarray(start,end);
    else if(method===8)data=inflateRawSync(buf.subarray(start,end),{maxOutputLength:Math.max(1,maxUncompressed-total)});
    else throw new Error('Unsupported XLSX compression method.');
    if(uncompSize&&data.length!==uncompSize)throw new Error('Corrupt XLSX entry.');
    total+=data.length;if(total>maxUncompressed)throw new Error('Workbook expands beyond the import limit.');
    entries.set(name,data);pos=end;
  }
  if(!entries.size)throw new Error('Not a valid XLSX file.');
  return entries;
}

function relationships(xml){
  const out=new Map();
  for(const m of xml.matchAll(/<Relationship\b([^>]+)\/?\s*>/g)){
    const id=/\bId="([^"]+)"/.exec(m[1])?.[1],target=/\bTarget="([^"]+)"/.exec(m[1])?.[1];
    if(id&&target)out.set(id,target);
  }
  return out;
}
function sharedStrings(xml){
  const out=[];
  for(const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)){
    let text='';for(const t of si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))text+=xmlDecode(t[1]);out.push(text);
  }
  return out;
}
function parseSheet(xml,shared,{limitRows=5000,limitCols=100}={}){
  const rows=new Map();let maxCol=0;
  for(const cell of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)){
    const ref=/\br="([A-Z]+)(\d+)"/.exec(cell[1]);if(!ref)continue;
    const rowNo=Number(ref[2]);if(rowNo>limitRows+50)continue;
    let col=0;for(const ch of ref[1])col=col*26+(ch.charCodeAt(0)-64);col--;if(col>=limitCols)continue;maxCol=Math.max(maxCol,col);
    const type=/\bt="([^"]+)"/.exec(cell[1])?.[1]||'';let value='';
    if(type==='inlineStr'){for(const t of cell[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))value+=xmlDecode(t[1]);}
    else{const raw=/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell[2])?.[1]??'';if(type==='s')value=shared[Number(raw)]??'';else if(type==='b')value=raw==='1';else if(type==='str')value=xmlDecode(raw);else value=raw===''?'':(Number.isFinite(Number(raw))?Number(raw):xmlDecode(raw));}
    if(!rows.has(rowNo))rows.set(rowNo,new Map());rows.get(rowNo).set(col,value);
  }
  const rowNums=[...rows.keys()].sort((a,b)=>a-b);if(!rowNums.length)return {headers:[],rows:[]};
  const headerNo=rowNums.find(n=>[...rows.get(n).values()].some(v=>String(v).trim()!==''));if(!headerNo)return {headers:[],rows:[]};
  const headers=[],seen=new Map(),header=rows.get(headerNo);
  for(let i=0;i<=maxCol;i++){let h=String(header.get(i)??'').trim()||`Column ${i+1}`;const n=(seen.get(h)||0)+1;seen.set(h,n);if(n>1)h=`${h} ${n}`;headers.push(h);}
  const data=[];
  for(const n of rowNums){if(n<=headerNo)continue;const map=rows.get(n),obj={};let nonempty=false;headers.forEach((h,i)=>{const v=map.get(i)??'';obj[h]=v;if(String(v).trim()!=='')nonempty=true;});if(nonempty)data.push(obj);if(data.length>=limitRows)break;}
  return {headers,rows:data};
}

export function parseWorkbook(buffer,{limitRows=5000,limitCols=100}={}){
  const entries=unzipEntries(buffer);
  const workbook=entries.get('xl/workbook.xml')?.toString('utf8'),relsXml=entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if(!workbook||!relsXml)throw new Error('Workbook structure is missing.');
  const rels=relationships(relsXml),shared=entries.get('xl/sharedStrings.xml')?sharedStrings(entries.get('xl/sharedStrings.xml').toString('utf8')):[];
  const sheets=[];
  for(const sm of workbook.matchAll(/<sheet\b([^>]+)\/?\s*>/g)){
    const attrs=sm[1],name=xmlDecode(/\bname="([^"]*)"/.exec(attrs)?.[1]||'Sheet'),rid=/\br:id="([^"]+)"/.exec(attrs)?.[1];if(!rid)continue;
    let target=rels.get(rid);if(!target)continue;target=target.replace(/^\/?xl\//,'').replace(/^\.\//,'');
    const data=entries.get(`xl/${target}`);if(!data)continue;
    sheets.push({name,...parseSheet(data.toString('utf8'),shared,{limitRows,limitCols})});
  }
  if(!sheets.length)throw new Error('Workbook contains no readable sheets.');
  return {sheets};
}
