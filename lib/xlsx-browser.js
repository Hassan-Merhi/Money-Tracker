const decoder=new TextDecoder('utf-8');

function asBytes(value){
  if(value instanceof Uint8Array)return value;
  if(value instanceof ArrayBuffer)return new Uint8Array(value);
  if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  throw new TypeError('Workbook bytes are required.');
}
function u16(view,offset){return view.getUint16(offset,true);}
function u32(view,offset){return view.getUint32(offset,true);}
function text(bytes){return decoder.decode(bytes);}

async function inflateRaw(bytes,maxOutputLength){
  if(typeof DecompressionStream!=='function')throw new Error('This browser cannot open compressed XLSX files offline. Update the browser or use CSV.');
  let stream;
  try{stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));}
  catch{throw new Error('This browser cannot open compressed XLSX files offline. Update the browser or use CSV.');}
  const out=new Uint8Array(await new Response(stream).arrayBuffer());
  if(out.byteLength>maxOutputLength)throw new Error('Workbook expands beyond the import limit.');
  return out;
}

export async function unzipWorkbookEntries(input,{maxFiles=250,maxUncompressed=20_000_000}={}){
  const bytes=asBytes(input),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const entries=new Map();let pos=0,total=0,count=0;
  while(pos+4<=bytes.length&&u32(view,pos)===0x04034b50){
    if(pos+30>bytes.length)throw new Error('Corrupt XLSX archive.');
    if(++count>maxFiles)throw new Error('Workbook has too many files.');
    const flags=u16(view,pos+6),method=u16(view,pos+8),compSize=u32(view,pos+18),uncompSize=u32(view,pos+22),nameLen=u16(view,pos+26),extraLen=u16(view,pos+28);
    if(flags&0x01)throw new Error('Encrypted XLSX files are not supported.');
    if(flags&0x08)throw new Error('Unsupported XLSX ZIP layout.');
    const nameStart=pos+30,nameEnd=nameStart+nameLen,start=nameEnd+extraLen,end=start+compSize;
    if(nameEnd>bytes.length||start>bytes.length||end>bytes.length)throw new Error('Corrupt XLSX archive.');
    const name=text(bytes.subarray(nameStart,nameEnd));
    if(uncompSize&&total+uncompSize>maxUncompressed)throw new Error('Workbook expands beyond the import limit.');
    let data;
    if(method===0)data=bytes.slice(start,end);
    else if(method===8)data=await inflateRaw(bytes.slice(start,end),Math.max(1,maxUncompressed-total));
    else throw new Error('Unsupported XLSX compression method.');
    if(uncompSize&&data.length!==uncompSize)throw new Error('Corrupt XLSX entry.');
    total+=data.length;if(total>maxUncompressed)throw new Error('Workbook expands beyond the import limit.');
    entries.set(name,data);pos=end;
  }
  if(!entries.size)throw new Error('Not a valid XLSX file.');
  return entries;
}

function xmlDecode(value=''){
  return String(value)
    .replace(/&#(x?[0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):parseInt(n,10)))
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
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
    let value='';for(const t of si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))value+=xmlDecode(t[1]);out.push(value);
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
  for(let i=0;i<=maxCol;i++){let h=String(header.get(i)??'').trim()||('Column '+(i+1));const n=(seen.get(h)||0)+1;seen.set(h,n);if(n>1)h=h+' '+n;headers.push(h);}
  const data=[];
  for(const n of rowNums){if(n<=headerNo)continue;const map=rows.get(n),obj={};let nonempty=false;headers.forEach((h,i)=>{const v=map.get(i)??'';obj[h]=v;if(String(v).trim()!=='')nonempty=true;});if(nonempty)data.push(obj);if(data.length>=limitRows)break;}
  return {headers,rows:data};
}
function normalizeSheetTarget(target=''){
  let path=String(target).replace(/\\/g,'/').replace(/^\//,'');
  if(path.startsWith('xl/'))return path;
  while(path.startsWith('../'))path=path.slice(3);
  path=path.replace(/^\.\//,'');
  return 'xl/'+path;
}

export async function parseWorkbookInBrowser(input,{limitRows=5000,limitCols=100,maxFiles=250,maxUncompressed=20_000_000}={}){
  const entries=await unzipWorkbookEntries(input,{maxFiles,maxUncompressed});
  const workbookBytes=entries.get('xl/workbook.xml'),relsBytes=entries.get('xl/_rels/workbook.xml.rels');
  if(!workbookBytes||!relsBytes)throw new Error('Workbook structure is missing.');
  const workbook=text(workbookBytes),rels=relationships(text(relsBytes));
  const shared=entries.get('xl/sharedStrings.xml')?sharedStrings(text(entries.get('xl/sharedStrings.xml'))):[];
  const sheets=[];
  for(const sm of workbook.matchAll(/<sheet\b([^>]+)\/?\s*>/g)){
    const attrs=sm[1],name=xmlDecode(/\bname="([^"]*)"/.exec(attrs)?.[1]||'Sheet'),rid=/\br:id="([^"]+)"/.exec(attrs)?.[1];if(!rid)continue;
    const target=rels.get(rid);if(!target)continue;
    const data=entries.get(normalizeSheetTarget(target));if(!data)continue;
    sheets.push({name,...parseSheet(text(data),shared,{limitRows,limitCols})});
  }
  if(!sheets.length)throw new Error('Workbook contains no readable sheets.');
  return {sheets};
}
