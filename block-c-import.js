import { loadState, saveState, uid, previewSpreadsheet } from './lib/store.js';
import { escapeHtml } from './lib/utils.js';
import { buildXlsx } from './lib/xlsx.js';
import { applyImport, detectImportMode, guessHeader } from './lib/importer.js';
import { analyzeLegacyWorkbook, applyLegacyWorkbook } from './lib/legacy-excel.js';

let state=null,preview=null,sheetIndex=0,injecting=false,legacyAnalysis=null,manualMode=false;
const q=s=>document.querySelector(s);

function downloadBytes(filename,bytes,type){const blob=new Blob([bytes],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),0);}
function templateWorkbook(){return buildXlsx([
  {name:'README',rows:[['Money Tracker import template'],['People: add Name, optional Note/Currency/Balance/Direction/Date. Direction: They owe me or I owe them.'],['Debt transactions: Account is optional. Use Person, Amount, Currency, Date, and Type.'],['Useful Type values: paid_for_person (they owe me), received_from_person (they paid me), borrowed_from_person (I owe them), paid_to_person (I paid them), person_adjustment, split_paid_for_people.'],['For split_paid_for_people, Account is optional; fill Amount, Currency, and Split Details like Alice: 10 | Bob: 15 (optional note).'],['Account/bank transaction types remain supported for later if you decide to enable account tracking.'],['Upload in Settings > Import & migration, preview, map columns, then confirm.']]},
  {name:'People',rows:[['Name','Note','Currency','Balance','Direction','Date','Description']]},
  {name:'Accounts',rows:[['Name','Type','Currency','Opening Balance']]},
  {name:'Transactions',rows:[['Date','Type','Person','Account','Amount','Currency','Merchant','Category','Description','From Account','To Account','From Amount','To Amount','Signed Amount','Direction','Split Details']]}
],{title:'Money Tracker Import Template'});}
function downloadTemplate(){downloadBytes('money-tracker-import-template.xlsx',templateWorkbook(),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');}

function inject(){
  if(injecting)return;injecting=true;
  try{
    const settings=document.querySelector('.settings-grid');
    if(settings&&!settings.querySelector('[data-import-card]')){const card=document.createElement('section');card.className='card settings-card';card.dataset.importCard='1';card.innerHTML='<h3>Import & migration</h3><p class="muted">Upload your existing money workbook exactly as it is. Known legacy layouts are recognized automatically; other Excel/CSV files can still use manual mapping.</p><div class="page-actions"><button class="btn primary" type="button" data-open-import>Import data</button><button class="btn" type="button" data-template>Download template</button></div>';card.querySelector('[data-open-import]').onclick=openImporter;card.querySelector('[data-template]').onclick=downloadTemplate;settings.prepend(card);}
    const exportBtn=document.querySelector('#exportXlsx');
    const actions=exportBtn?.parentElement;
    if(actions&&!actions.querySelector('[data-open-import]')){const b=document.createElement('button');b.className='btn';b.type='button';b.dataset.openImport='1';b.textContent='↑ Import data';b.onclick=openImporter;actions.prepend(b);}
  }finally{injecting=false;}
}
new MutationObserver(inject).observe(document.documentElement,{childList:true,subtree:true});window.addEventListener('DOMContentLoaded',inject);inject();

async function openImporter(){
  try{state=await loadState();}catch(e){alert(e.message||'Could not load ledger.');return;}
  closeImporter();preview=null;sheetIndex=0;legacyAnalysis=null;manualMode=false;
  const wrap=document.createElement('div');wrap.className='imp-backdrop';wrap.innerHTML=`<div class="imp-shell" role="dialog" aria-modal="true"><header class="imp-head"><div><div class="imp-kicker">BLOCK C</div><h2>Import & migration</h2><p>Preview first. Nothing changes until you confirm the import.</p></div><button class="imp-close" aria-label="Close">×</button></header><div class="imp-body"><div class="imp-steps"><span class="active">1 Upload</span><span>2 Map</span><span>3 Review</span><span>4 Apply</span></div><section class="imp-card"><div class="imp-actions"><button class="btn" id="impTemplate">↓ Import template</button></div><label class="imp-drop" for="impFile"><strong>Choose Excel or CSV</strong><span>.xlsx, .xlsm, or .csv · up to 8 MB</span></label><input id="impFile" type="file" accept=".xlsx,.xlsm,.csv,text/csv" hidden><div id="impArea"></div></section></div></div>`;document.body.appendChild(wrap);
  wrap.querySelector('.imp-close').onclick=closeImporter;wrap.addEventListener('click',e=>{if(e.target===wrap)closeImporter();});wrap.querySelector('#impTemplate').onclick=downloadTemplate;wrap.querySelector('#impFile').onchange=e=>readFile(e.target.files?.[0]);
}
function closeImporter(){document.querySelector('.imp-backdrop')?.remove();}

function parseCsv(text){const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const ch=text[i];if(quoted){if(ch==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(ch==='"')quoted=false;else cell+=ch;}else if(ch==='"')quoted=true;else if(ch===','){row.push(cell);cell='';}else if(ch==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=ch;}if(cell||row.length){row.push(cell);rows.push(row);}const headers=(rows.shift()||[]).map((h,i)=>String(h).trim()||`Column ${i+1}`);return {sheets:[{name:'CSV',headers,rows:rows.filter(r=>r.some(v=>String(v).trim())).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??''])))}]};}
async function readFile(file){
  if(!file)return;const area=q('#impArea');area.innerHTML='<div class="imp-status">Reading file…</div>';
  try{
    if(file.size>8_000_000)throw new Error('Keep imports under 8 MB per file.');
    if(file.name.toLowerCase().endsWith('.csv'))preview=parseCsv(await file.text());
    else{const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));preview=await previewSpreadsheet(file.name,btoa(binary));}
    legacyAnalysis=file.name.toLowerCase().endsWith('.csv')?null:analyzeLegacyWorkbook(preview);sheetIndex=Math.max(0,preview.sheets.findIndex(s=>s.rows?.length));if(legacyAnalysis?.recognized&&!manualMode)renderLegacyPreview();else renderPreview();
  }catch(e){area.innerHTML=`<div class="imp-error">${escapeHtml(e.message||'Could not read this file.')}</div>`;}
}

function moneyText(value,currency='USD'){const n=Number(value||0);try{return new Intl.NumberFormat(undefined,{style:'currency',currency}).format(n);}catch{return `${currency} ${n.toFixed(2)}`;}}
function legacyEffect(record){
  const currency=state?.settings?.defaultCurrency||'USD',amount=moneyText(record.amount,currency);
  if(record.kind==='person_adjustment')return record.signedAmount>=0?`+${amount} they owe you`:`-${amount} they paid / you owe`;
  return record.kind==='account_income'?`+${amount} into account`:`-${amount} from account`;
}
function renderLegacyPreview(){
  const area=q('#impArea'),a=legacyAnalysis;if(!area||!a)return;
  const sample=a.records.slice(0,10),ignored=a.ignoredSheets||[];
  area.innerHTML=`<div class="imp-sub imp-legacy"><div class="imp-preview-head"><div><div class="imp-kicker">LEGACY EXCEL RECOGNIZED</div><h3>Your current workbook format is ready</h3><p>${a.records.length} transaction row${a.records.length===1?'':'s'} found across ${a.recognizedSheets.length} recognized sheet${a.recognizedSheets.length===1?'':'s'}.</p></div></div><div class="imp-legacy-stats"><div class="imp-legacy-stat"><strong>${a.records.length}</strong><span>transactions found</span></div><div class="imp-legacy-stat"><strong>${a.people.length}</strong><span>people detected</span></div><div class="imp-legacy-stat"><strong>${a.accounts.length}</strong><span>money accounts detected</span></div><div class="imp-legacy-stat"><strong>${a.unknownDates}</strong><span>legacy rows without dates</span></div></div><div class="imp-table"><table><thead><tr><th>Sheet</th><th>Person / account</th><th>Description</th><th>Effect</th><th>Date</th></tr></thead><tbody>${sample.map(r=>`<tr><td>${escapeHtml(r.sourceSheet)}</td><td>${escapeHtml(r.personName||r.accountName||'')}</td><td>${escapeHtml(r.description)}</td><td>${escapeHtml(legacyEffect(r))}</td><td>${escapeHtml(r.dateUnknown?'Legacy / no date':r.date)}</td></tr>`).join('')}</tbody></table></div>${a.unknownDates?`<div class="imp-note"><strong>${a.unknownDates} undated rows:</strong> your spreadsheet does not contain an exact date for these entries. They will be preserved as legacy rows and labeled “Legacy date not recorded” instead of inventing a date.</div>`:''}${ignored.length?`<div class="imp-note"><strong>Protected from double-counting:</strong> ${ignored.map(x=>`${escapeHtml(x.sheet)} — ${escapeHtml(x.reason)}`).join('<br>')}</div>`:''}<div class="imp-note">Re-uploading the same workbook is safe: unchanged rows are skipped. If you correct an already imported amount in the same legacy row, the existing imported entry is updated instead of duplicated.</div><div class="imp-actions imp-legacy-actions"><button class="btn" id="impManual">Use manual mapper instead</button><button class="btn primary" id="impLegacyReview">Review & import ${a.records.length}</button></div></div>`;
  q('#impManual').onclick=()=>{manualMode=true;renderPreview();};q('#impLegacyReview').onclick=reviewLegacy;
}
async function reviewLegacy(){
  let prepared;try{prepared=applyLegacyWorkbook({state,workbook:preview,uidFactory:uid});}catch(e){alert(e.message||'Could not prepare this legacy workbook.');return;}
  const r=prepared.result,parts=[r.people?`${r.people} new people`:'',r.accounts?`${r.accounts} new money accounts`:'',r.entries?`${r.entries} new entries`:'',r.updated?`${r.updated} corrected entries updated`:'',r.skipped?`${r.skipped} already imported / unchanged`:''].filter(Boolean);
  const changes=r.people+r.accounts+r.entries+r.updated;
  if(!changes){alert(`No new changes to import.${parts.length?`\n\n${parts.join(', ')}.`:''}`);return;}
  const warning=(r.warnings||[]).slice(0,6).join('\n');
  if(!confirm(`Import this legacy workbook?\n\n${parts.join(', ')}.${warning?`\n\nProtected/ignored sections:\n${warning}`:''}\n\nYour Excel file itself is not changed.`))return;
  const btn=q('#impLegacyReview'),before=btn.textContent;btn.disabled=true;btn.textContent='Importing…';
  try{state=await saveState(prepared.state);alert(`Legacy import complete: ${parts.join(', ')}.`);closeImporter();location.hash='#dashboard';}
  catch(e){alert(e.status===409?'The ledger changed in another tab. Reopen the importer and review again.':(e.message||'Could not save import.'));}
  finally{if(btn.isConnected){btn.disabled=false;btn.textContent=before;}}
}
function mappingSelect(id,label,headers,aliases,required=false){const guessed=guessHeader(headers,aliases);return `<div class="imp-field"><label>${label}${required?' *':''}</label><select id="${id}"><option value="">Not mapped</option>${headers.map(h=>`<option value="${escapeHtml(h)}" ${h===guessed?'selected':''}>${escapeHtml(h)}</option>`).join('')}</select></div>`;}
function renderPreview(){
  const area=q('#impArea'),sheet=preview?.sheets?.[sheetIndex];if(!area||!sheet)return;const mode=detectImportMode(sheet.headers),sample=sheet.rows.slice(0,5);
  area.innerHTML=`<div class="imp-sub"><div class="imp-preview-head"><div><h3>Preview</h3><p>${sheet.rows.length} row${sheet.rows.length===1?'':'s'} detected</p></div><select id="impSheet">${preview.sheets.map((s,i)=>`<option value="${i}" ${i===sheetIndex?'selected':''}>${escapeHtml(s.name)} (${s.rows.length})</option>`).join('')}</select></div><div class="imp-table"><table><thead><tr>${sheet.headers.slice(0,8).map(h=>`<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${sample.map(r=>`<tr>${sheet.headers.slice(0,8).map(h=>`<td>${escapeHtml(r[h]??'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div><div class="imp-field imp-mode"><label>Import this sheet as</label><select id="impMode"><option value="people" ${mode==='people'?'selected':''}>People / opening balances</option><option value="accounts" ${mode==='accounts'?'selected':''}>Accounts</option><option value="transactions" ${mode==='transactions'?'selected':''}>Transactions</option></select></div><div id="impMapping"></div><div class="imp-note">Existing people are matched by name and obvious duplicates are skipped. For debt transactions, the Account column is optional. You can import only Person, Date, Type, Amount, Currency, and notes.</div><button class="btn primary" id="impReview">Review & apply</button></div>`;
  q('#impSheet').onchange=e=>{sheetIndex=Number(e.target.value);renderPreview();};q('#impMode').onchange=renderMapping;q('#impReview').onclick=review;renderMapping();
}
function renderMapping(){
  const sheet=preview.sheets[sheetIndex],mode=q('#impMode')?.value||'people',h=sheet.headers;let html='';
  if(mode==='people')html=`<div class="imp-fields">${mappingSelect('mName','Name',h,['name','person','contact'],true)}${mappingSelect('mBalance','Opening balance',h,['balance','amount','owed','opening balance'])}${mappingSelect('mDirection','Direction',h,['direction','owes','who owes'])}${mappingSelect('mCurrency','Currency',h,['currency','curr'])}${mappingSelect('mNote','Note',h,['note','notes'])}${mappingSelect('mDate','Balance date',h,['date','balance date'])}${mappingSelect('mDescription','Description',h,['description','details','memo'])}</div>`;
  if(mode==='accounts')html=`<div class="imp-fields">${mappingSelect('mName','Account name',h,['account name','account','name'],true)}${mappingSelect('mType','Type',h,['type','account type'])}${mappingSelect('mCurrency','Currency',h,['currency','curr'])}${mappingSelect('mOpeningBalance','Opening balance',h,['opening balance','balance','opening'])}</div>`;
  if(mode==='transactions')html=`<div class="imp-fields">${mappingSelect('mDate','Date',h,['date','transaction date'],true)}${mappingSelect('mType','Type',h,['type','transaction type'],true)}${mappingSelect('mPerson','Person',h,['person','contact','name'])}${mappingSelect('mAccount','Account',h,['account','account name'])}${mappingSelect('mAmount','Amount',h,['amount','value','total'],true)}${mappingSelect('mCurrency','Currency',h,['currency','curr'])}${mappingSelect('mMerchant','Merchant / source',h,['merchant','source','vendor','store'])}${mappingSelect('mCategory','Category',h,['category','spending category','income category'])}${mappingSelect('mDescription','Description',h,['description','memo','details','note'])}${mappingSelect('mFromAccount','From account',h,['from account','source account'])}${mappingSelect('mToAccount','To account',h,['to account','destination account'])}${mappingSelect('mFromAmount','From amount',h,['from amount','source amount'])}${mappingSelect('mToAmount','To amount',h,['to amount','destination amount'])}${mappingSelect('mSignedAmount','Signed amount',h,['signed amount','signed'])}${mappingSelect('mDirection','Direction',h,['direction','owes'])}${mappingSelect('mSplitDetails','Split details',h,['split details','split allocations','allocations'])}</div>`;
  q('#impMapping').innerHTML=html;
}
function mapFromUi(){const out={};document.querySelectorAll('#impMapping select[id^="m"]').forEach(el=>{const key=el.id.slice(1);out[key.charAt(0).toLowerCase()+key.slice(1)]=el.value;});return out;}
function requiredMapped(mode,m){if(mode==='people')return !!m.name;if(mode==='accounts')return !!m.name;return !!(m.date&&m.type&&m.amount);}
async function review(){
  const mode=q('#impMode').value,mapping=mapFromUi();if(!requiredMapped(mode,mapping)){alert(mode==='transactions'?'Map Date, Type, and Amount first.':'Map the Name column first.');return;}
  const sheet=preview.sheets[sheetIndex];let prepared;try{prepared=applyImport({state,rows:sheet.rows,mode,mapping,uidFactory:uid});}catch(e){alert(e.message||'Could not prepare the import.');return;}
  const r=prepared.result,parts=[r.people?`${r.people} new people`:'',r.accounts?`${r.accounts} new accounts`:'',r.entries?`${r.entries} new entries`:'',r.skipped?`${r.skipped} skipped`:''].filter(Boolean);const issues=r.errors.slice(0,6).join('\n');
  if(!r.people&&!r.accounts&&!r.entries){alert(`Nothing to import.${parts.length?' '+parts.join(', '):''}${issues?`\n\n${issues}`:''}`);return;}
  if(!confirm(`Apply import?\n\n${parts.join(', ')}.${issues?`\n\nFirst issues:\n${issues}`:''}\n\nThis appends to your current ledger.`))return;
  const btn=q('#impReview'),before=btn.textContent;btn.disabled=true;btn.textContent='Applying…';
  try{state=await saveState(prepared.state);alert(`Import complete: ${parts.join(', ')}.`);closeImporter();location.hash='#dashboard';}
  catch(e){alert(e.status===409?'The ledger changed in another tab. Reopen the importer and review again.':(e.message||'Could not save import.'));}
  finally{if(btn.isConnected){btn.disabled=false;btn.textContent=before;}}
}
