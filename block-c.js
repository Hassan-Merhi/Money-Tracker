import { loadState, saveState, uid, previewSpreadsheet } from './lib/store.js';
import { CURRENCIES, escapeHtml, today } from './lib/utils.js';

let workbookPreview=null;
let selectedSheetIndex=0;
let currentState=null;
let injecting=false;

function norm(v=''){return String(v).trim().toLowerCase().replace(/[^a-z0-9]+/g,' ');}
function byName(list,name){const n=norm(name);return list.find(x=>norm(x.name)===n);}
function guessHeader(headers,aliases){const scored=headers.map(h=>{const n=norm(h);let score=0;for(const a of aliases){const aa=norm(a);if(n===aa)score=Math.max(score,100);else if(n.includes(aa)||aa.includes(n))score=Math.max(score,50);}return {h,score};}).sort((a,b)=>b.score-a.score);return scored[0]?.score?scored[0].h:'';}
function mapSelect(id,label,headers,aliases,required=false){const guessed=guessHeader(headers,aliases);return `<div class="bc-field"><label>${label}${required?' *':''}</label><select id="${id}"><option value="">Not mapped</option>${headers.map(h=>`<option value="${escapeHtml(h)}" ${h===guessed?'selected':''}>${escapeHtml(h)}</option>`).join('')}</select></div>`;}
function rowValue(row,id){const key=document.querySelector(`#${id}`)?.value;return key?row[key]:'';}
function parseMoney(v){if(typeof v==='number')return Number.isFinite(v)?v:NaN;const s=String(v??'').trim().replace(/\s/g,'').replace(/,/g,'');const n=Number(s);return Number.isFinite(n)?n:NaN;}
function dateValue(v){
  if(typeof v==='number'&&v>1000&&v<100000){const d=new Date(Date.UTC(1899,11,30)+Math.round(v)*86400000);return d.toISOString().slice(0,10);}
  const s=String(v??'').trim(); if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;
  const d=new Date(s); return Number.isNaN(d.getTime())?'':d.toISOString().slice(0,10);
}
function currencyValue(v,fallback='USD'){const c=String(v||fallback).trim().toUpperCase();return /^[A-Z]{3,5}$/.test(c)?c:fallback;}
function accountType(v){const n=norm(v);if(n.includes('cash'))return 'cash';if(n.includes('card'))return 'card';if(n.includes('wallet'))return 'wallet';if(n.includes('bank'))return 'bank';return 'other';}
function txnType(v){
  const n=norm(v); const map={paid_for_person:['paid for person','paid for someone','purchase for','i paid'],received_from_person:['received from person','received repayment','paid me back','got paid back'],borrowed_from_person:['borrowed from person','borrowed','loan from'],paid_to_person:['paid person back','paid to person','repaid','paid them back'],person_adjustment:['person adjustment','balance adjustment','opening balance'],account_transfer:['account transfer','transfer']};
  if(['paid_for_person','received_from_person','borrowed_from_person','paid_to_person','person_adjustment','account_transfer'].includes(String(v)))return String(v);
  for(const [type,aliases] of Object.entries(map))if(aliases.some(a=>n===norm(a)||n.includes(norm(a))))return type; return '';
}
function directionSign(v,rawAmount){const n=norm(v);if(n.includes('i owe')||n.includes('owe them')||n.includes('negative')||n==='debt')return -1;if(n.includes('they owe')||n.includes('owed to me')||n.includes('positive'))return 1;return Number(rawAmount)<0?-1:1;}

async function download(path,filename){
  const res=await fetch(path,{credentials:'same-origin'}); if(!res.ok){let m='Download failed.';try{m=(await res.json()).error||m}catch{}throw new Error(m);} const blob=await res.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function injectButtons(){
  if(injecting)return; injecting=true;
  try{
    document.querySelectorAll('.nav').forEach(nav=>{
      if(nav.querySelector('[data-doc-center]'))return;const b=document.createElement('button');b.type='button';b.dataset.docCenter='1';b.innerHTML='<span class="nav-icon">⇩</span>Data & Documents';b.addEventListener('click',openCenter);nav.appendChild(b);
    });
    document.querySelectorAll('.mobile-nav').forEach(nav=>{
      if(nav.querySelector('[data-doc-center]'))return;nav.classList.add('bc-six');const b=document.createElement('button');b.type='button';b.dataset.docCenter='1';b.innerHTML='<span>⇩</span>Data';b.addEventListener('click',openCenter);nav.appendChild(b);
    });
    const settings=document.querySelector('.settings-grid');
    if(settings&&!settings.querySelector('[data-block-c-card]')){
      const s=document.createElement('section');s.className='card settings-card';s.dataset.blockCCard='1';s.innerHTML='<h3>Data & documents</h3><p class="muted">Import Excel/CSV opening balances and ledger rows, export a real Excel workbook, and create PDF statements.</p><button class="btn primary" type="button">Open data center</button>';s.querySelector('button').addEventListener('click',openCenter);settings.prepend(s);
    }
  } finally {injecting=false;}
}
new MutationObserver(injectButtons).observe(document.documentElement,{childList:true,subtree:true});
window.addEventListener('DOMContentLoaded',injectButtons); injectButtons();

async function openCenter(){
  try{currentState=await loadState();}catch(e){alert(e.message||'Could not load ledger.');return;}
  closeCenter(); const wrap=document.createElement('div');wrap.className='bc-backdrop';wrap.innerHTML=`<div class="bc-shell" role="dialog" aria-modal="true"><header class="bc-head"><div><div class="bc-kicker">BLOCK C</div><h2>Data & Documents</h2><p>Bring existing balances in, take your ledger out, and generate statements.</p></div><button class="bc-close" aria-label="Close">×</button></header><div class="bc-body"><section class="bc-grid"><article class="bc-card"><div class="bc-icon">X</div><h3>Excel workbook</h3><p>Export people, accounts, transactions and instructions in a real .xlsx workbook.</p><button class="btn primary" id="bcExportExcel">Download Excel</button><button class="btn" id="bcTemplate">Download import template</button></article><article class="bc-card"><div class="bc-icon">PDF</div><h3>PDF reports</h3><p>Create a clean ledger summary or a person-by-person statement.</p><button class="btn primary" id="bcSummaryPdf">Ledger summary PDF</button><button class="btn" id="bcPersonPdf">Person statement…</button></article><article class="bc-card bc-wide"><div class="bc-icon">↑</div><h3>Import Excel or CSV</h3><p>Upload a workbook or CSV, preview it, map columns, and append the rows only after review.</p><label class="bc-drop" for="bcFile"><strong>Choose .xlsx, .xlsm or .csv</strong><span>No ledger changes happen during preview.</span></label><input id="bcFile" type="file" accept=".xlsx,.xlsm,.csv,text/csv" hidden><div id="bcImportArea"></div></article></section></div></div>`;document.body.appendChild(wrap);
  wrap.querySelector('.bc-close').onclick=closeCenter;wrap.addEventListener('click',e=>{if(e.target===wrap)closeCenter();});
  wrap.querySelector('#bcExportExcel').onclick=()=>runButton(wrap.querySelector('#bcExportExcel'),()=>download('/api/export/ledger.xlsx',`money-ledger-${today()}.xlsx`));
  wrap.querySelector('#bcTemplate').onclick=()=>runButton(wrap.querySelector('#bcTemplate'),()=>download('/api/export/import-template.xlsx','money-ledger-import-template.xlsx'));
  wrap.querySelector('#bcSummaryPdf').onclick=()=>runButton(wrap.querySelector('#bcSummaryPdf'),()=>download('/api/export/summary.pdf',`money-ledger-summary-${today()}.pdf`));
  wrap.querySelector('#bcPersonPdf').onclick=openPersonPdf;
  wrap.querySelector('#bcFile').addEventListener('change',e=>handleFile(e.target.files?.[0]));
}
function closeCenter(){document.querySelector('.bc-backdrop')?.remove();workbookPreview=null;selectedSheetIndex=0;}
async function runButton(button,fn){const before=button.textContent;button.disabled=true;button.textContent='Working…';try{await fn();}catch(e){alert(e.message||'Something went wrong.');}finally{button.disabled=false;button.textContent=before;}}

function openPersonPdf(){
  if(!currentState.people.length){alert('Add a person first.');return;}
  const body=document.querySelector('#bcImportArea'); body.innerHTML=`<div class="bc-subcard"><h4>Person statement PDF</h4><div class="bc-fields"><div class="bc-field"><label>Person</label><select id="bcPdfPerson">${currentState.people.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select></div><div class="bc-field"><label>Currency</label><select id="bcPdfCurrency"><option value="">All / automatic</option>${CURRENCIES.map(c=>`<option>${c}</option>`).join('')}</select></div></div><button class="btn primary" id="bcMakePersonPdf">Download statement</button></div>`;
  body.querySelector('#bcMakePersonPdf').onclick=()=>{const p=body.querySelector('#bcPdfPerson').value,c=body.querySelector('#bcPdfCurrency').value;const person=currentState.people.find(x=>x.id===p);download(`/api/export/person.pdf?personId=${encodeURIComponent(p)}${c?`&currency=${encodeURIComponent(c)}`:''}`,`${(person?.name||'person').replace(/[^a-z0-9]+/gi,'-').toLowerCase()}-statement.pdf`).catch(e=>alert(e.message));};
}

function parseCsv(text){
  const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const ch=text[i];if(quoted){if(ch==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(ch==='"')quoted=false;else cell+=ch;}else if(ch==='"')quoted=true;else if(ch===','){row.push(cell);cell='';}else if(ch==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=ch;}if(cell||row.length){row.push(cell);rows.push(row);}const headers=(rows.shift()||[]).map((h,i)=>String(h).trim()||`Column ${i+1}`);return {sheets:[{name:'CSV',headers,rows:rows.filter(r=>r.some(v=>String(v).trim())).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??''])))}]};
}
async function handleFile(file){
  if(!file)return; const area=document.querySelector('#bcImportArea'); area.innerHTML='<div class="bc-loading">Reading file…</div>';
  try{
    if(file.size>8_000_000)throw new Error('Keep imports under 8 MB per file.');
    if(file.name.toLowerCase().endsWith('.csv')) workbookPreview=parseCsv(await file.text());
    else {const bytes=new Uint8Array(await file.arrayBuffer());let binary='';const step=0x8000;for(let i=0;i<bytes.length;i+=step)binary+=String.fromCharCode(...bytes.subarray(i,i+step));workbookPreview=await previewSpreadsheet(file.name,btoa(binary));}
    selectedSheetIndex=Math.max(0,workbookPreview.sheets.findIndex(s=>s.rows?.length));renderPreview();
  }catch(e){area.innerHTML=`<div class="bc-error">${escapeHtml(e.message||'Could not read this file.')}</div>`;}
}

function detectMode(sheet){const h=sheet.headers.map(norm);if(h.some(x=>x.includes('opening balance'))&&h.some(x=>x==='type'))return 'accounts';if(h.some(x=>x==='date')&&h.some(x=>x==='amount'))return 'transactions';return 'people';}
function renderPreview(){
  const area=document.querySelector('#bcImportArea');if(!area||!workbookPreview)return;const sheet=workbookPreview.sheets[selectedSheetIndex]||workbookPreview.sheets[0];const mode=detectMode(sheet);const previewRows=sheet.rows.slice(0,5);
  area.innerHTML=`<div class="bc-subcard"><div class="bc-preview-head"><div><h4>Import preview</h4><p>${sheet.rows.length} data row${sheet.rows.length===1?'':'s'} detected.</p></div><select id="bcSheet">${workbookPreview.sheets.map((s,i)=>`<option value="${i}" ${i===selectedSheetIndex?'selected':''}>${escapeHtml(s.name)} (${s.rows.length})</option>`).join('')}</select></div><div class="bc-preview-table"><table><thead><tr>${sheet.headers.slice(0,8).map(h=>`<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${previewRows.map(r=>`<tr>${sheet.headers.slice(0,8).map(h=>`<td>${escapeHtml(r[h]??'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="bc-fields"><div class="bc-field"><label>Import this sheet as</label><select id="bcMode"><option value="people" ${mode==='people'?'selected':''}>People / opening balances</option><option value="accounts" ${mode==='accounts'?'selected':''}>Accounts</option><option value="transactions" ${mode==='transactions'?'selected':''}>Transactions</option></select></div></div><div id="bcMapping"></div><div class="bc-review-note">Imports append to the current ledger. Existing people/accounts are matched by name so obvious duplicates are avoided.</div><button class="btn primary" id="bcApply">Review & import rows</button></div>`;
  area.querySelector('#bcSheet').onchange=e=>{selectedSheetIndex=Number(e.target.value);renderPreview();}; area.querySelector('#bcMode').onchange=renderMapping; area.querySelector('#bcApply').onclick=reviewImport; renderMapping();
}
function renderMapping(){
  const sheet=workbookPreview.sheets[selectedSheetIndex], mode=document.querySelector('#bcMode')?.value||'people', h=sheet.headers;let html='';
  if(mode==='people') html=`<div class="bc-fields">${mapSelect('mapName','Name',h,['name','person','contact'],true)}${mapSelect('mapBalance','Balance / amount',h,['balance','amount','owed','opening balance'],true)}${mapSelect('mapDirection','Direction',h,['direction','owes','who owes','balance direction'])}${mapSelect('mapCurrency','Currency',h,['currency','curr'])}${mapSelect('mapNote','Note',h,['note','notes','description'])}</div>`;
  if(mode==='accounts') html=`<div class="bc-fields">${mapSelect('mapName','Account name',h,['name','account','account name'],true)}${mapSelect('mapType','Type',h,['type','account type'])}${mapSelect('mapCurrency','Currency',h,['currency','curr'])}${mapSelect('mapOpening','Opening balance',h,['opening balance','balance','opening'])}</div>`;
  if(mode==='transactions') html=`<div class="bc-fields">${mapSelect('mapDate','Date',h,['date','transaction date'],true)}${mapSelect('mapType','Type',h,['type','transaction type'],true)}${mapSelect('mapPerson','Person',h,['person','name','contact'])}${mapSelect('mapAccount','Account',h,['account','account name'])}${mapSelect('mapAmount','Amount',h,['amount','value','total'],true)}${mapSelect('mapCurrency','Currency',h,['currency','curr'])}${mapSelect('mapMerchant','Merchant / source',h,['merchant','source','store','vendor'])}${mapSelect('mapDescription','Description',h,['description','note','memo','details'])}${mapSelect('mapFrom','From account',h,['from account','source account'])}${mapSelect('mapTo','To account',h,['to account','destination account'])}${mapSelect('mapFromAmount','From amount',h,['from amount','source amount'])}${mapSelect('mapToAmount','To amount',h,['to amount','destination amount'])}${mapSelect('mapSigned','Signed amount',h,['signed amount','signed'])}</div>`;
  document.querySelector('#bcMapping').innerHTML=html;
}

function cloneState(s){return typeof structuredClone==='function'?structuredClone(s):JSON.parse(JSON.stringify(s));}
function importPeople(rows,state){let people=0,entries=0,skipped=0;const errors=[];for(let i=0;i<rows.length;i++){
  const r=rows[i],name=String(rowValue(r,'mapName')||'').trim(),raw=parseMoney(rowValue(r,'mapBalance'));if(!name){skipped++;errors.push(`Row ${i+2}: missing name.`);continue;}const amount=Number.isFinite(raw)?Math.abs(raw):0,currency=currencyValue(rowValue(r,'mapCurrency'),state.settings.defaultCurrency),note=String(rowValue(r,'mapNote')||'').trim();let p=byName(state.people,name);if(!p){p={id:uid('person'),name,note,createdAt:new Date().toISOString()};state.people.push(p);people++;}else if(note&&!p.note)p.note=note;if(amount>0){const sign=directionSign(rowValue(r,'mapDirection'),raw);state.entries.push({id:uid('entry'),type:'person_adjustment',personId:p.id,accountId:null,amount,currency,signedAmount:sign*amount,date:today(),merchant:'',description:'Imported opening balance',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});entries++;}}
  return {people,entries,accounts:0,skipped,errors};
}
function importAccounts(rows,state){let accounts=0,skipped=0;const errors=[];for(let i=0;i<rows.length;i++){
  const r=rows[i],name=String(rowValue(r,'mapName')||'').trim();if(!name){skipped++;errors.push(`Row ${i+2}: missing account name.`);continue;}const currency=currencyValue(rowValue(r,'mapCurrency'),state.settings.defaultCurrency);if(state.accounts.some(a=>norm(a.name)===norm(name)&&a.currency===currency)){skipped++;continue;}const opening=parseMoney(rowValue(r,'mapOpening'));state.accounts.push({id:uid('account'),name,type:accountType(rowValue(r,'mapType')),currency,openingBalance:Number.isFinite(opening)?opening:0,createdAt:new Date().toISOString()});accounts++;}
  return {people:0,entries:0,accounts,skipped,errors};
}
function importTransactions(rows,state){let people=0,accounts=0,entries=0,skipped=0;const errors=[];const duplicateKey=e=>[e.date,e.type,e.personId||'',e.accountId||'',e.fromAccountId||'',e.toAccountId||'',Number(e.amount||0),e.description||''].join('|');const existing=new Set(state.entries.map(duplicateKey));
  const getPerson=name=>{if(!name)return null;let p=byName(state.people,name);if(!p){p={id:uid('person'),name:String(name).trim(),note:'Imported',createdAt:new Date().toISOString()};state.people.push(p);people++;}return p;};
  const getAccount=(name,currency)=>{if(!name)return null;let a=state.accounts.find(x=>norm(x.name)===norm(name)&&x.currency===currency);if(!a){a={id:uid('account'),name:String(name).trim(),type:'other',currency,openingBalance:0,createdAt:new Date().toISOString()};state.accounts.push(a);accounts++;}return a;};
  for(let i=0;i<rows.length;i++){
    const r=rows[i],type=txnType(rowValue(r,'mapType')),date=dateValue(rowValue(r,'mapDate')),raw=parseMoney(rowValue(r,'mapAmount')),amount=Math.abs(raw),currency=currencyValue(rowValue(r,'mapCurrency'),state.settings.defaultCurrency);if(!type||!date||!(amount>0)){skipped++;errors.push(`Row ${i+2}: needs a valid date, supported type, and positive amount.`);continue;}const desc=String(rowValue(r,'mapDescription')||'').trim(),merchant=String(rowValue(r,'mapMerchant')||'').trim(),now=new Date().toISOString();let e={id:uid('entry'),type,amount,date,merchant,description:desc,createdAt:now,updatedAt:now};
    if(type==='account_transfer'){
      const from=getAccount(String(rowValue(r,'mapFrom')||'').trim(),currency),to=getAccount(String(rowValue(r,'mapTo')||'').trim(),currency),fa=Math.abs(parseMoney(rowValue(r,'mapFromAmount'))||amount),ta=Math.abs(parseMoney(rowValue(r,'mapToAmount'))||amount);if(!from||!to||from.id===to.id||!(fa>0)||!(ta>0)){skipped++;errors.push(`Row ${i+2}: transfer needs different from/to accounts and amounts.`);continue;}e={...e,personId:null,accountId:null,fromAccountId:from.id,toAccountId:to.id,fromAmount:fa,toAmount:ta,amount:fa,currency:null,signedAmount:null};
    }else{
      const person=getPerson(String(rowValue(r,'mapPerson')||'').trim());if(!person){skipped++;errors.push(`Row ${i+2}: person is required for this transaction type.`);continue;}e.personId=person.id;e.fromAccountId=null;e.toAccountId=null;e.fromAmount=null;e.toAmount=null;
      if(type==='person_adjustment'){const signed=parseMoney(rowValue(r,'mapSigned'));e.accountId=null;e.currency=currency;e.signedAmount=Number.isFinite(signed)&&signed!==0?(signed<0?-amount:amount):directionSign('',raw)*amount;}
      else {const account=getAccount(String(rowValue(r,'mapAccount')||'').trim(),currency);if(!account){skipped++;errors.push(`Row ${i+2}: account is required for this transaction type.`);continue;}e.accountId=account.id;e.currency=account.currency;e.signedAmount=null;}
    }
    const key=duplicateKey(e);if(existing.has(key)){skipped++;continue;}existing.add(key);state.entries.push(e);entries++;
  }
  return {people,accounts,entries,skipped,errors};
}

async function reviewImport(){
  const mode=document.querySelector('#bcMode').value,sheet=workbookPreview.sheets[selectedSheetIndex];if(!document.querySelector('#mapName')?.value&&mode!=='transactions'){alert('Map the required name column first.');return;}if(mode==='transactions'&&(!document.querySelector('#mapDate')?.value||!document.querySelector('#mapType')?.value||!document.querySelector('#mapAmount')?.value)){alert('Map Date, Type and Amount first.');return;}
  const next=cloneState(currentState);let result;try{result=mode==='people'?importPeople(sheet.rows,next):mode==='accounts'?importAccounts(sheet.rows,next):importTransactions(sheet.rows,next);}catch(e){alert(e.message||'Could not prepare import.');return;}
  const details=[result.people?`${result.people} new people`:'',result.accounts?`${result.accounts} new accounts`:'',result.entries?`${result.entries} new ledger entries`:'',result.skipped?`${result.skipped} skipped`:''].filter(Boolean).join(', ');const issues=result.errors.slice(0,6).join('\n');
  if(!result.people&&!result.accounts&&!result.entries){alert(`Nothing to import. ${details}${issues?`\n\n${issues}`:''}`);return;}
  if(!confirm(`Apply this import?\n\n${details}.${issues?`\n\nFirst issues:\n${issues}`:''}\n\nThis will append to your current ledger.`))return;
  const btn=document.querySelector('#bcApply');await runButton(btn,async()=>{currentState=await saveState(next);alert(`Import complete: ${details}.`);closeCenter();location.hash='#dashboard';});
}
