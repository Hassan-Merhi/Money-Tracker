import { loadState, saveState, uid, previewSpreadsheet } from './lib/store.js';
import { escapeHtml } from './lib/utils.js';
import { buildXlsx } from './lib/xlsx.js';
import { applyImport, applyQuickPasteImport, detectImportMode, guessHeader, parseQuickPaste } from './lib/importer.js';
import { analyzeLegacyWorkbook, applyLegacyWorkbook } from './lib/legacy-excel.js';
import { currencyExponent } from './lib/money.js';

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
  }finally{injecting=false;}
}
new MutationObserver(inject).observe(document.documentElement,{childList:true,subtree:true});window.addEventListener('DOMContentLoaded',inject);inject();

function quickPasteEffect(row){
  const amount=moneyText(row.Amount,row.Currency||state?.settings?.defaultCurrency||'USD');
  return Number(row['Signed Amount'])>=0?`+${amount} they owe you`:`-${amount} taken / paid from them`;
}
function renderQuickPastePreview(){
  const host=q('#impQuickPreview'),text=q('#impQuickPaste')?.value||'';if(!host)return;
  const parsed=parseQuickPaste(text);
  if(!String(text).trim()){host.innerHTML='<div class="imp-status">Paste rows above to preview them before importing.</div>';return;}
  const sample=parsed.rows.slice(0,10),issues=parsed.errors.slice(0,6);
  host.innerHTML=`<div class="imp-quick-summary"><strong>${parsed.rows.length}</strong> valid row${parsed.rows.length===1?'':'s'}${parsed.errors.length?` · <span>${parsed.errors.length} issue${parsed.errors.length===1?'':'s'}</span>`:''}</div>${sample.length?`<div class="imp-table"><table><thead><tr><th>Person</th><th>Amount</th><th>Direction</th><th>Merchant / source</th><th>Date</th></tr></thead><tbody>${sample.map(r=>`<tr><td>${escapeHtml(r.Person)}</td><td>${escapeHtml(String(r.Amount))}</td><td>${escapeHtml(quickPasteEffect(r))}</td><td>${escapeHtml(r.Merchant||'')}</td><td>${escapeHtml(r.Date)}</td></tr>`).join('')}</tbody></table></div>`:''}${issues.length?`<div class="imp-error"><strong>Fix or skip these rows:</strong><br>${issues.map(escapeHtml).join('<br>')}${parsed.errors.length>issues.length?'<br>…':''}</div>`:''}`;
}
async function openQuickImporter(){
  try{state=await loadState();}catch(e){alert(e.message||'Could not load ledger.');return;}
  closeImporter();
  const wrap=document.createElement('div');wrap.className='imp-backdrop';wrap.innerHTML=`<div class="imp-shell imp-quick-shell" role="dialog" aria-modal="true"><header class="imp-head"><div><div class="imp-kicker">QUICK EXCEL PASTE</div><h2>Paste rows into person statements</h2><p>Copy from a normal Excel sheet and paste. No special workbook format needed.</p></div><button class="imp-close" aria-label="Close">×</button></header><div class="imp-body"><section class="imp-card"><div class="imp-quick-columns"><span>Name</span><span>Amount</span><span>Direction</span><span>Merchant / Source</span><span>Date</span><span>Description <em>optional</em></span><span>Currency <em>optional</em></span></div><div class="imp-note"><strong>Direction:</strong> use “They owe me” to add to the person’s balance, or “Took from them” / “They paid me” to subtract from it. Date accepts YYYY-MM-DD or DD/MM/YYYY. A header row is optional; without one, use the column order shown above.</div><textarea id="impQuickPaste" class="imp-quick-paste" spellcheck="false" placeholder="Name&#9;Amount&#9;Direction&#9;Merchant / Source&#9;Date&#9;Description&#9;Currency&#10;Adam&#9;120&#9;They owe me&#9;Amazon&#9;29/09/2026&#9;Order 123&#9;USD&#10;Adam&#9;40&#9;Took from them&#9;Cash&#9;30/09/2026&#9;Partial payment&#9;USD"></textarea><div class="imp-actions imp-quick-actions"><button class="btn" type="button" id="impQuickPreviewBtn">Preview</button><button class="btn primary" type="button" id="impQuickApply">Import valid rows</button></div><div id="impQuickPreview"><div class="imp-status">Paste rows above to preview them before importing.</div></div></section></div></div>`;document.body.appendChild(wrap);
  wrap.querySelector('.imp-close').onclick=closeImporter;wrap.addEventListener('click',e=>{if(e.target===wrap)closeImporter();});q('#impQuickPreviewBtn').onclick=renderQuickPastePreview;q('#impQuickApply').onclick=reviewQuickPaste;q('#impQuickPaste').addEventListener('paste',()=>setTimeout(renderQuickPastePreview,0));
}
async function reviewQuickPaste(){
  const text=q('#impQuickPaste')?.value||'';if(!text.trim()){alert('Paste Excel rows first.');return;}
  let prepared;try{prepared=applyQuickPasteImport({state,text,uidFactory:uid});}catch(e){alert(e.message||'Could not prepare the pasted rows.');return;}
  const r=prepared.result,parts=[r.people?`${r.people} new people`:'',r.entries?`${r.entries} statement entries`:'',r.updated?`${r.updated} updated`:'',r.skipped?`${r.skipped} skipped`:''].filter(Boolean),issues=(r.errors||[]).slice(0,8);
  if(!r.entries && !r.updated){alert(`Nothing to import.${issues.length?`\n\n${issues.join('\n')}`:''}`);return;}
  if(!confirm(`Import these pasted rows?\n\n${parts.join(', ')}.${issues.length?`\n\nRows with issues will be skipped:\n${issues.join('\n')}`:''}\n\nEach valid row will appear on that person's statement.`))return;
  const btn=q('#impQuickApply'),before=btn.textContent;btn.disabled=true;btn.textContent='Importing…';
  try{state=await saveState(prepared.state);alert(`Paste import complete: ${parts.join(', ')}.`);closeImporter();location.hash='#people';}
  catch(e){alert(e.status===409?'The ledger changed in another tab. Reopen the paste importer and review again.':(e.message||'Could not save import.'));}
  finally{if(btn.isConnected){btn.disabled=false;btn.textContent=before;}}
}

async function openImporter(){
  try{state=await loadState();}catch(e){alert(e.message||'Could not load ledger.');return;}
  closeImporter();preview=null;sheetIndex=0;legacyAnalysis=null;manualMode=false;
  const wrap=document.createElement('div');wrap.className='imp-backdrop';wrap.innerHTML=`<div class="imp-shell" role="dialog" aria-modal="true"><header class="imp-head"><div><div class="imp-kicker">BLOCK C</div><h2>Import & migration</h2><p>Preview first. Nothing changes until you confirm the import.</p></div><button class="imp-close" aria-label="Close">×</button></header><div class="imp-body"><div class="imp-steps"><span class="active">1 Upload</span><span>2 Map</span><span>3 Review</span><span>4 Apply</span></div><section class="imp-card"><div class="imp-actions"><button class="btn" id="impTemplate">↓ Import template</button></div><label class="imp-drop" for="impFile"><strong>Choose Excel or CSV</strong><span>.xlsx, .xlsm, or .csv · up to 8 MB</span></label><input id="impFile" type="file" accept=".xlsx,.xlsm,.csv,text/csv" hidden><div id="impArea"></div></section></div></div>`;document.body.appendChild(wrap);
  wrap.querySelector('.imp-close').onclick=closeImporter;wrap.addEventListener('click',e=>{if(e.target===wrap)closeImporter();});wrap.querySelector('#impTemplate').onclick=downloadTemplate;wrap.querySelector('#impFile').onchange=e=>readFile(e.target.files?.[0]);
}
function closeImporter(){document.querySelector('.imp-backdrop')?.remove();}

function parseCsv(text){const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const ch=text[i];if(quoted){if(ch==='\"'&&text[i+1]==='\"'){cell+='\"';i++;}else if(ch==='\"')quoted=false;else cell+=ch;}else if(ch==='\"')quoted=true;else if(ch===','){row.push(cell);cell='';}else if(ch==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=ch;}if(cell||row.length){row.push(cell);rows.push(row);}const headers=(rows.shift()||[]).map((h,i)=>String(h).trim()||`Column ${i+1}`);return {sheets:[{name:'CSV',headers,rows:rows.filter(r=>r.some(v=>String(v).trim())).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??''])))}]};}
async function readFile(file){
  if(!file)return;const area=q('#impArea');area.innerHTML='<div class="imp-status">Reading file…</div>';
  try{
    if(file.size>8_000_000)throw new Error('Keep imports under 8 MB per file.');
    if(file.name.toLowerCase().endsWith('.csv'))preview=parseCsv(await file.text());
    else{const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));preview=await previewSpreadsheet(file.name,btoa(binary));}
    legacyAnalysis=file.name.toLowerCase().endsWith('.csv')?null:analyzeLegacyWorkbook(preview);sheetIndex=Math.max(0,preview.sheets.findIndex(s=>s.rows?.length));if(legacyAnalysis?.recognized&&!manualMode)renderLegacyPreview();else renderPreview();
  }catch(e){area.innerHTML=`<div class="imp-error">${escapeHtml(e.message||'Could not read this file.')}</div>`;}
}

function moneyText(value,currency='USD'){const n=Number(value||0);try{return new Intl.NumberFormat(undefined,{style:'currency',currency,minimumFractionDigits:currencyExponent(currency),maximumFractionDigits:currencyExponent(currency)}).format(n);}catch{return `${currency} ${n.toFixed(currencyExponent(currency))}`;}}
function legacyEffect(record){
  const currency=state?.settings?.defaultCurrency||'USD',amount=moneyText(record.amount,currency);
  if(record.kind==='person_adjustment')return record.signedAmount>=0?`+${amount} they owe you`:`-${amount} they paid / you owe`;
  return record.kind==='account_income'?`+${amount} into account`:`-${amount} from account`;
}
function renderLegacyPreview(){
  const area=q('#impArea'),a=legacyAnalysis;if(!area||!a)return;
  const sample=a.records.slice(0,10),ignored=a.ignoredSheets||[];
  const reconciliation = a.reconciliation||[];
  const expectedBalances = a.expectedBalances||[];
  const hasMismatch = reconciliation.some(r=>Math.abs(r.delta)>0.000001);
  const reconciliationTable = reconciliation.length ? `<div class="imp-reconciliation"><h4>Reconciliation — expected vs stated totals</h4><div class="imp-table"><table><thead><tr><th>Person</th><th>Expected (sum of details)</th><th>Stated (from total rows)</th><th>Delta</th></tr></thead><tbody>${reconciliation.map(r=>`<tr class="${Math.abs(r.delta)>0.000001?'imp-mismatch':''}"><td>${escapeHtml(r.personName)}</td><td>${escapeHtml(moneyText(r.expected, state?.settings?.defaultCurrency||'USD'))}</td><td>${escapeHtml(moneyText(r.stated, state?.settings?.defaultCurrency||'USD'))}</td><td>${escapeHtml(moneyText(r.delta, state?.settings?.defaultCurrency||'USD'))}</td></tr>`).join('')}</tbody></table></div>${hasMismatch?`<div class="imp-error">Reconciliation mismatch detected for: ${escapeHtml(reconciliation.filter(r=>Math.abs(r.delta)>0.000001).map(r=>r.personName).join(', '))}. You will need to explicitly confirm these people before import.</div>`:''}</div>` : '';
  area.innerHTML=`<div class="imp-sub imp-legacy"><div class="imp-preview-head"><div><div class="imp-kicker">LEGACY EXCEL RECOGNIZED</div><h3>Your current workbook format is ready</h3><p>${a.records.length} transaction row${a.records.length===1?'':'s'} found across ${a.recognizedSheets.length} recognized sheet${a.recognizedSheets.length===1?'':'s'}.</p></div></div><div class="imp-legacy-stats"><div class="imp-legacy-stat"><strong>${a.records.length}</strong><span>transactions found</span></div><div class="imp-legacy-stat"><strong>${a.people.length}</strong><span>people detected</span></div><div class="imp-legacy-stat"><strong>${a.accounts.length}</strong><span>money accounts detected</span></div><div class="imp-legacy-stat"><strong>${a.unknownDates}</strong><span>legacy rows without dates</span></div></div><div class="imp-table"><table><thead><tr><th>Sheet</th><th>Person / account</th><th>Description</th><th>Effect</th><th>Date</th></tr></thead><tbody>${sample.map(r=>`<tr><td>${escapeHtml(r.sourceSheet)}</td><td>${escapeHtml(r.personName||r.accountName||'')}</td><td>${escapeHtml(r.description)}</td><td>${escapeHtml(legacyEffect(r))}</td><td>${escapeHtml(r.dateUnknown?'Legacy / no date':r.date)}</td></tr>`).join('')}</tbody></table></div>${reconciliationTable}${a.unknownDates?`<div class="imp-note"><strong>${a.unknownDates} undated rows:</strong> your spreadsheet does not contain an exact date for these entries. They will be preserved as legacy rows and labeled “Legacy date not recorded” instead of inventing a date.</div>`:''}${ignored.length?`<div class="imp-note"><strong>Protected from double-counting:</strong> ${ignored.map(x=>`${escapeHtml(x.sheet)} — ${escapeHtml(x.reason)}`).join('<br>')}</div>`:''}<div class="imp-note">Re-uploading the same workbook is safe: unchanged rows are skipped. If you correct an already imported amount in the same legacy row, the existing imported entry is updated instead of duplicated.</div><div class="imp-actions imp-legacy-actions"><button class="btn" id="impManual">Use manual mapper instead</button><button class="btn primary" id="impLegacyReview">Review & import ${a.records.length}</button></div></div>`;
  q('#impManual').onclick=()=>{manualMode=true;renderPreview();};q('#impLegacyReview').onclick=reviewLegacy;
}
async function reviewLegacy(){
  let prepared;try{prepared=applyLegacyWorkbook({state,workbook:preview,uidFactory:uid});}catch(e){alert(e.message||'Could not prepare this legacy workbook.');return;}
  const r=prepared.result,parts=[r.people?`${r.people} new people`:'',r.accounts?`${r.accounts} new money accounts`:'',r.entries?`${r.entries} new entries`:'',r.updated?`${r.updated} corrected entries updated`:'',r.skipped?`${r.skipped} already imported / unchanged`:''].filter(Boolean);
  const changes=r.people+r.accounts+r.entries+r.updated;
  if(!changes){alert(`No new changes to import.${parts.length?`\n\n${parts.join(', ')}.`:''}`);return;}
  const warning=(r.warnings||[]).slice(0,6).join('\n');
  const reconciliation = legacyAnalysis?.reconciliation||[];
  const mismatches = reconciliation.filter(m=>Math.abs(m.delta)>0.000001);
  if(!confirm(`Import this legacy workbook?\n\n${parts.join(', ')}.${warning?`\n\nProtected/ignored sections:\n${warning}`:''}\n\nYour Excel file itself is not changed.`))return;
  if(mismatches.length){
    const names = mismatches.map(m=>m.personName).join(', ');
    const expectedList = mismatches.map(m=>`${m.personName}: expected ${moneyText(m.expected, state?.settings?.defaultCurrency||'USD')} vs stated ${moneyText(m.stated, state?.settings?.defaultCurrency||'USD')} delta ${moneyText(m.delta, state?.settings?.defaultCurrency||'USD')}`).join('\n');
    if(!confirm(`Reconciliation mismatch detected for: ${names}\n\n${expectedList}\n\nThese people have a difference between expected (sum of detail rows) and stated (total row). Do you want to proceed anyway?`)) return;
    // Require explicit extra confirmation naming the people
    const typed = prompt(`To confirm import with mismatches for ${names}, please type the names of the affected people separated by comma (e.g. "${names}"):`);
    if(!typed){
      alert('Import cancelled — explicit confirmation naming the people with mismatches is required.');
      return;
    }
    const typedLower = typed.toLowerCase();
    const missing = mismatches.filter(m=>!typedLower.includes(m.personName.toLowerCase()));
    if(missing.length){
      alert(`Confirmation failed — you must name all people with mismatches: ${names}. Missing: ${missing.map(m=>m.personName).join(', ')}`);
      return;
    }
  }
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
  const r=prepared.result,parts=[r.people?`${r.people} new people`:'',r.accounts?`${r.accounts} new accounts`:'',r.entries?`${r.entries} new entries`:'',r.updated?`${r.updated} updated`:'',r.skipped?`${r.skipped} skipped`:''].filter(Boolean);const issues=r.errors.slice(0,6).join('\n');
  if(!r.people&&!r.accounts&&!r.entries&&!r.updated){alert(`Nothing to import.${parts.length?' '+parts.join(', '):''}${issues?`\n\n${issues}`:''}`);return;}
  if(!confirm(`Apply import?\n\n${parts.join(', ')}.${issues?`\n\nFirst issues:\n${issues}`:''}\n\nThis appends to your current ledger.`))return;
  const btn=q('#impReview'),before=btn.textContent;btn.disabled=true;btn.textContent='Applying…';
  try{state=await saveState(prepared.state);alert(`Import complete: ${parts.join(', ')}.`);closeImporter();location.hash='#dashboard';}
  catch(e){alert(e.status===409?'The ledger changed in another tab. Reopen the importer and review again.':(e.message||'Could not save import.'));}
  finally{if(btn.isConnected){btn.disabled=false;btn.textContent=before;}}
}
