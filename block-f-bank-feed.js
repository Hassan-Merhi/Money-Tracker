import {
  listBankFeed, importBankFeed, postBankFeedItem, ignoreBankFeedItem, reopenBankFeedItem,
  deleteBankFeedItem, createBankRule, deleteBankRule, previewSpreadsheet, loadState
} from './lib/store.js';
import { parseBankCsv, suggestBankMapping, normalizeBankRows, bankDirectionLabel } from './lib/bank-feed.js';
import { categoryOptionsForType } from './lib/insights.js';
import { escapeHtml, money } from './lib/utils.js';

let feed={items:[],rules:[]};
let draft=null;
let selectedAccountId='';
let statusFilter='pending';

const PERSON_ACTIONS=new Set(['paid_for_person','received_from_person','borrowed_from_person','paid_to_person']);
const ACTIONS=[
  ['expense','Personal expense'],
  ['income','Account income'],
  ['paid_for_person','Paid for someone'],
  ['received_from_person','Got paid back'],
  ['borrowed_from_person','Borrowed from person'],
  ['paid_to_person','Paid person back'],
  ['transfer','Transfer between my accounts']
];

function actionOptions(selected=''){
  return ACTIONS.map(([value,label])=>`<option value="${value}" ${selected===value?'selected':''}>${label}</option>`).join('');
}
function accountName(state,id){return state.accounts.find(a=>a.id===id)?.name||'Missing account';}
function personName(state,id){return state.people.find(p=>p.id===id)?.name||'Missing person';}
function categoryName(state,id){const c=state.categories?.find(row=>row.id===id);return c?((c.icon?c.icon+' ':'')+c.name):'Uncategorized';}
function categoryOptions(state,action,selected=''){
  const type=action==='income'?'account_income':'account_expense';
  const categories=categoryOptionsForType(state.categories||[],type);
  const archived=(state.categories||[]).find(c=>c.id===selected&&c.archived);
  return '<option value="">Uncategorized</option>'+categories.map(c=>`<option value="${c.id}" ${c.id===selected?'selected':''}>${escapeHtml((c.icon?c.icon+' ':'')+c.name)}</option>`).join('')+(archived?`<option value="${archived.id}" selected>${escapeHtml((archived.icon?archived.icon+' ':'')+archived.name)} (archived)</option>`:'');
}
function bytesToBase64(buffer){
  const bytes=new Uint8Array(buffer);let binary='';const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,Math.min(bytes.length,i+chunk)));
  return btoa(binary);
}
function headersOptions(headers,selected){
  return `<option value="">Not used</option>`+headers.map(h=>`<option value="${escapeHtml(h)}" ${h===selected?'selected':''}>${escapeHtml(h)}</option>`).join('');
}
function activeSheet(){
  if(!draft)return null;
  return draft.sheets?.[draft.sheetIndex||0]||null;
}
function setDraftSheet(index){
  if(!draft)return;
  draft.sheetIndex=index;
  const sheet=activeSheet();
  draft.mapping=suggestBankMapping(sheet?.headers||[]);
}
function merchantRuleText(item){
  const text=String(item.merchant||item.description||'').trim();
  return text.slice(0,80);
}

async function readStatementFile(file,ctx){
  if(!file)return;
  try{
    if(file.size>8*1024*1024)throw new Error('Bank statement files must be 8 MB or smaller.');
    const lower=file.name.toLowerCase();
    if(lower.endsWith('.csv')){
      const parsed=parseBankCsv(await file.text());
      draft={filename:file.name,sheets:[{name:'CSV',...parsed}],sheetIndex:0};
    }else if(lower.endsWith('.xlsx')||lower.endsWith('.xlsm')){
      const preview=await previewSpreadsheet(file.name,bytesToBase64(await file.arrayBuffer()));
      draft={filename:file.name,sheets:preview.sheets||[],sheetIndex:0};
    }else throw new Error('Use a CSV, XLSX, or XLSM bank statement.');
    const first=(draft.sheets||[]).findIndex(s=>(s.rows||[]).length);
    if(first>=0)draft.sheetIndex=first;
    setDraftSheet(draft.sheetIndex||0);
    if(!activeSheet()?.rows?.length)throw new Error('No statement rows were found.');
  }catch(error){
    draft=null;ctx.showToast(error.message||'Could not read that bank statement.');
  }
}

function importMarkup(state){
  const sheet=activeSheet(),headers=sheet?.headers||[],mapping=draft?.mapping||{};
  return `<section class="card panel bank-import">
    <div class="panel-head"><div><h3>Import bank statement</h3><p>CSV or Excel · rows go to a review inbox before they affect balances.</p></div></div>
    <div class="bank-import-grid">
      <div class="field"><label>Ledger account</label><select class="select" id="bankAccount">${state.accounts.map(a=>`<option value="${a.id}" ${a.id===(selectedAccountId||state.accounts[0]?.id)?'selected':''}>${escapeHtml(a.name)} · ${a.currency}</option>`).join('')}</select></div>
      <div class="field"><label>Statement file</label><input class="input file-input" id="bankFile" type="file" accept=".csv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></div>
    </div>
    ${draft?`<div class="bank-mapping">
      <div class="bank-mapping-head"><div><strong>${escapeHtml(draft.filename)}</strong><div class="muted tiny">${(sheet?.rows||[]).length} rows ready to map</div></div>
      ${draft.sheets.length>1?`<select class="select small-select" id="bankSheet">${draft.sheets.map((s,i)=>`<option value="${i}" ${i===draft.sheetIndex?'selected':''}>${escapeHtml(s.name)}</option>`).join('')}</select>`:''}</div>
      <div class="mapping-grid">
        <div class="field"><label>Date *</label><select class="select" data-map="date">${headersOptions(headers,mapping.date)}</select></div>
        <div class="field"><label>Description *</label><select class="select" data-map="description">${headersOptions(headers,mapping.description)}</select></div>
        <div class="field"><label>Merchant / payee</label><select class="select" data-map="merchant">${headersOptions(headers,mapping.merchant)}</select></div>
        <div class="field"><label>Signed amount</label><select class="select" data-map="amount">${headersOptions(headers,mapping.amount)}</select></div>
        <div class="field"><label>Debit / money out</label><select class="select" data-map="debit">${headersOptions(headers,mapping.debit)}</select></div>
        <div class="field"><label>Credit / money in</label><select class="select" data-map="credit">${headersOptions(headers,mapping.credit)}</select></div>
        <div class="field"><label>Transaction ID</label><select class="select" data-map="externalId">${headersOptions(headers,mapping.externalId)}</select></div>
        <div class="field"><label>Currency</label><select class="select" data-map="currency">${headersOptions(headers,mapping.currency)}</select></div>
        <div class="field"><label>Date order</label><select class="select" id="bankDateOrder"><option value="auto">Auto</option><option value="dmy">Day / month / year</option><option value="mdy">Month / day / year</option></select></div>
        <div class="field"><label>If using one Amount column</label><select class="select" id="bankAmountDirection"><option value="inflow_positive">Positive = money in</option><option value="outflow_positive">Positive = money out</option></select></div>
      </div>
      <div class="warning bank-map-note">Map either one signed <strong>Amount</strong> column or separate <strong>Debit</strong> and <strong>Credit</strong> columns. Re-importing the same rows is safe: duplicates are skipped.</div>
      <div class="page-actions bank-map-actions"><button class="btn primary" id="bankImportNow">Import into review inbox</button><button class="btn" id="bankCancelDraft">Cancel</button></div>
    </div>`:''}
  </section>`;
}

function feedRowMarkup(item,state){
  const account=accountName(state,item.accountId),isPending=item.status==='pending',suggested=item.suggestedType||(Number(item.signedAmount)<0?'expense':'income');
  const ruleText=merchantRuleText(item);
  return `<article class="card bank-row ${item.status}" data-bank-item="${item.id}">
    <div class="bank-row-main">
      <div class="bank-date">${escapeHtml(item.date)}</div>
      <div class="bank-description"><strong>${escapeHtml(item.merchant||item.description)}</strong>${item.merchant&&item.description!==item.merchant?`<span>${escapeHtml(item.description)}</span>`:''}<small>${escapeHtml(account)}${item.sourceName?` · ${escapeHtml(item.sourceName)}`:''}</small></div>
      <div class="bank-amount ${Number(item.signedAmount)<0?'out':'in'}"><strong>${Number(item.signedAmount)<0?'−':'+'}${money(Math.abs(item.signedAmount),item.currency)}</strong><small>${bankDirectionLabel(item.signedAmount)}</small></div>
      <div><span class="pill ${item.status==='posted'?'green':item.status==='ignored'?'':'amber'}">${escapeHtml(item.status)}</span></div>
    </div>
    ${isPending?`<div class="bank-review">
      <div class="field"><label>What is this?</label><select class="select bank-action">${actionOptions(suggested)}</select></div>
      <div class="field bank-person-wrap"><label>Person</label><select class="select bank-person"><option value="">Choose person</option>${state.people.map(p=>`<option value="${p.id}" ${p.id===item.suggestedPersonId?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}</select></div>
      <div class="field bank-target-wrap"><label>Other account</label><select class="select bank-target"><option value="">Choose account</option>${state.accounts.filter(a=>a.id!==item.accountId).map(a=>`<option value="${a.id}" ${a.id===item.suggestedTargetAccountId?'selected':''}>${escapeHtml(a.name)} · ${a.currency}</option>`).join('')}</select></div>
      <div class="field bank-category-wrap"><label>Category</label><select class="select bank-category">${categoryOptions(state,suggested,item.suggestedCategoryId||'')}</select></div>
      <div class="field bank-note-wrap"><label>Ledger note</label><input class="input bank-note" maxlength="500" value="${escapeHtml(item.description)}"></div>
      <label class="bank-rule-check"><input type="checkbox" class="bank-save-rule"> Remember a rule for <input class="input bank-rule-text" maxlength="120" value="${escapeHtml(ruleText)}" aria-label="Rule match text"></label>
      <div class="page-actions"><button class="btn primary bank-post">Post to ledger</button><button class="btn bank-ignore">Ignore</button><button class="btn danger bank-delete">Delete</button></div>
    </div>`:item.status==='ignored'?`<div class="bank-row-actions"><button class="btn small bank-reopen">Reopen</button><button class="btn small danger bank-delete">Delete</button></div>`:`<div class="bank-row-actions"><span class="muted tiny">Ledger entry: ${escapeHtml(item.postedEntryId||'posted')}</span></div>`}
  </article>`;
}

function rulesMarkup(state){
  return `<section class="card panel bank-rules">
    <div class="panel-head"><div><h3>Automatic rules</h3><p>Matching text pre-selects the right action next time you import a statement.</p></div></div>
    <form id="bankRuleForm" class="bank-rule-form">
      <input class="input" name="matchText" maxlength="120" placeholder="Contains text, e.g. AMAZON" required>
      <select class="select" name="classification">${actionOptions('expense')}</select>
      <select class="select" name="personId"><option value="">No person</option>${state.people.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>
      <select class="select" name="targetAccountId"><option value="">No transfer account</option>${state.accounts.map(a=>`<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}</select>
      <select class="select" name="categoryId" id="bankRuleCategory"><option value="">No category</option></select>
      <button class="btn" type="submit">Add rule</button>
    </form>
    <div class="bank-rule-list">${feed.rules.length?feed.rules.map(rule=>`<div class="bank-rule-item"><div><strong>Contains “${escapeHtml(rule.matchText)}”</strong><small>${escapeHtml(ACTIONS.find(a=>a[0]===rule.classification)?.[1]||rule.classification)}${rule.personId?` · ${escapeHtml(personName(state,rule.personId))}`:''}${rule.targetAccountId?` · ${escapeHtml(accountName(state,rule.targetAccountId))}`:''}${rule.categoryId?` · ${escapeHtml(categoryName(state,rule.categoryId))}`:''}</small></div><button class="btn small danger" data-delete-bank-rule="${rule.id}">Delete</button></div>`).join(''):'<div class="empty compact-empty">No rules yet. You can also create one while posting a feed item.</div>'}</div>
  </section>`;
}

function paint(main,state,ctx){
  if(!state.accounts.length){
    main.innerHTML='<div class="card hero-empty empty"><div class="big">🏦</div><h3>Add an account before importing a bank statement</h3><p>Bank feed rows must be linked to one of your bank, card, cash, or wallet accounts.</p><button class="btn primary" id="bankGoAccounts">Add an account</button></div>';
    main.querySelector('#bankGoAccounts')?.addEventListener('click',()=>location.hash='#accounts');return;
  }
  if(!selectedAccountId||!state.accounts.some(a=>a.id===selectedAccountId))selectedAccountId=state.accounts[0].id;
  const counts={pending:0,posted:0,ignored:0};feed.items.forEach(i=>counts[i.status]=(counts[i.status]||0)+1);
  const shown=feed.items.filter(i=>statusFilter==='all'||i.status===statusFilter);
  main.innerHTML=`
    <div class="grid stats bank-stats">
      <div class="card stat"><div class="stat-label">TO REVIEW</div><div class="stat-value">${counts.pending}</div><div class="stat-note">Rows waiting for a decision</div></div>
      <div class="card stat good"><div class="stat-label">POSTED</div><div class="stat-value">${counts.posted}</div><div class="stat-note">Rows already added to the ledger</div></div>
      <div class="card stat"><div class="stat-label">IGNORED</div><div class="stat-value">${counts.ignored}</div><div class="stat-note">Rows intentionally skipped</div></div>
      <div class="card stat net"><div class="stat-label">AUTO RULES</div><div class="stat-value">${feed.rules.length}</div><div class="stat-note">Merchant / description matches</div></div>
    </div>
    ${importMarkup(state)}
    <section class="bank-feed-section">
      <div class="panel-head"><div><h3>Bank feed inbox</h3><p>Nothing touches balances until you post it.</p></div><div class="segmented bank-status-tabs">${['pending','posted','ignored','all'].map(s=>`<button class="${statusFilter===s?'active':''}" data-bank-status="${s}">${s[0].toUpperCase()+s.slice(1)}</button>`).join('')}</div></div>
      <div class="bank-feed-list">${shown.length?shown.map(i=>feedRowMarkup(i,state)).join(''):'<div class="card empty"><strong>No items in this view</strong>Import a statement or switch the status filter.</div>'}</div>
    </section>
    ${rulesMarkup(state)}
  `;
  bind(main,state,ctx);
}

function syncRow(card){
  const action=card.querySelector('.bank-action')?.value||'expense';
  card.querySelector('.bank-person-wrap')?.classList.toggle('hidden',!PERSON_ACTIONS.has(action));
  card.querySelector('.bank-target-wrap')?.classList.toggle('hidden',action!=='transfer');
  card.querySelector('.bank-category-wrap')?.classList.toggle('hidden',!['expense','income'].includes(action));
  const category=card.querySelector('.bank-category');if(category&&['expense','income'].includes(action)){const selected=category.value;category.innerHTML=categoryOptions(window.__moneyTrackerStateForBank||{categories:[]},action,selected);}
}

function bind(main,state,ctx){
  window.__moneyTrackerStateForBank=state;
  main.querySelector('#bankAccount')?.addEventListener('change',e=>{selectedAccountId=e.target.value;});
  main.querySelector('#bankFile')?.addEventListener('change',async e=>{await readStatementFile(e.target.files?.[0],ctx);paint(main,state,ctx);});
  main.querySelector('#bankSheet')?.addEventListener('change',e=>{setDraftSheet(Number(e.target.value));paint(main,state,ctx);});
  main.querySelector('#bankCancelDraft')?.addEventListener('click',()=>{draft=null;paint(main,state,ctx);});
  main.querySelector('#bankImportNow')?.addEventListener('click',async()=>{
    const sheet=activeSheet();if(!sheet)return;
    const mapping={};main.querySelectorAll('[data-map]').forEach(el=>mapping[el.dataset.map]=el.value);
    if(!mapping.date||!mapping.description||(!mapping.amount&&!mapping.debit&&!mapping.credit)){ctx.showToast('Map Date, Description, and either Amount or Debit/Credit.');return;}
    const account=state.accounts.find(a=>a.id===(main.querySelector('#bankAccount')?.value||selectedAccountId));
    const normalized=normalizeBankRows(sheet.rows,mapping,{fallbackCurrency:account?.currency||state.settings.defaultCurrency,dateOrder:main.querySelector('#bankDateOrder')?.value,amountDirection:main.querySelector('#bankAmountDirection')?.value});
    if(!normalized.items.length){ctx.showToast(normalized.errors[0]||'No valid rows to import.');return;}
    try{
      const result=await importBankFeed({accountId:account.id,sourceName:`${draft.filename}${draft.sheets.length>1?' · '+sheet.name:''}`,rows:normalized.items});
      feed={items:result.items||[],rules:result.rules||[]};draft=null;statusFilter='pending';paint(main,state,ctx);
      const invalid=result.invalid+(normalized.errors?.length||0);
      ctx.showToast(`Imported ${result.imported} row${result.imported===1?'':'s'} · ${result.skipped} duplicate${result.skipped===1?'':'s'} skipped${invalid?' · '+invalid+' invalid':''}.`);
    }catch(error){ctx.showToast(error.message||'Could not import the statement.');}
  });
  main.querySelectorAll('[data-bank-status]').forEach(btn=>btn.addEventListener('click',()=>{statusFilter=btn.dataset.bankStatus;paint(main,state,ctx);}));
  main.querySelectorAll('[data-bank-item]').forEach(card=>{card.querySelector('.bank-action')?.addEventListener('change',()=>syncRow(card));syncRow(card);});
  main.querySelectorAll('.bank-post').forEach(btn=>btn.addEventListener('click',async()=>{
    const card=btn.closest('[data-bank-item]'),id=card.dataset.bankItem,action=card.querySelector('.bank-action').value;
    const payload={expectedRevision:state.version,classification:action,personId:card.querySelector('.bank-person')?.value||null,targetAccountId:card.querySelector('.bank-target')?.value||null,categoryId:card.querySelector('.bank-category')?.value||null,note:card.querySelector('.bank-note')?.value||'',saveRule:!!card.querySelector('.bank-save-rule')?.checked,ruleMatchText:card.querySelector('.bank-rule-text')?.value||''};
    btn.disabled=true;
    try{
      const result=await postBankFeedItem(id,payload);feed.items=feed.items.map(i=>i.id===id?result.item:i);feed.rules=result.rules||feed.rules;
      ctx.showToast(result.linkedExistingTransfer?'Matched the other side of an existing transfer; no duplicate was created.':'Bank transaction posted to the ledger.');ctx.replaceState(result.state);
    }catch(error){
      if(error.status===409){
        try{ctx.replaceState(await loadState());}catch{}
        ctx.showToast(error.message||'Could not post this bank transaction.');
        return;
      }
      ctx.showToast(error.message||'Could not post this bank transaction.');paint(main,state,ctx);
    }
  }));
  main.querySelectorAll('.bank-ignore').forEach(btn=>btn.addEventListener('click',async()=>{const id=btn.closest('[data-bank-item]').dataset.bankItem;try{const r=await ignoreBankFeedItem(id);feed.items=feed.items.map(i=>i.id===id?r.item:i);paint(main,state,ctx);}catch(error){ctx.showToast(error.message||'Could not ignore this row.');}}));
  main.querySelectorAll('.bank-reopen').forEach(btn=>btn.addEventListener('click',async()=>{const id=btn.closest('[data-bank-item]').dataset.bankItem;try{const r=await reopenBankFeedItem(id);feed.items=feed.items.map(i=>i.id===id?r.item:i);statusFilter='pending';paint(main,state,ctx);}catch(error){ctx.showToast(error.message||'Could not reopen this row.');}}));
  main.querySelectorAll('.bank-delete').forEach(btn=>btn.addEventListener('click',async()=>{const id=btn.closest('[data-bank-item]').dataset.bankItem;if(!confirm('Delete this unposted bank-feed row?'))return;try{await deleteBankFeedItem(id);feed.items=feed.items.filter(i=>i.id!==id);paint(main,state,ctx);}catch(error){ctx.showToast(error.message||'Could not delete this row.');}}));
  const ruleForm=main.querySelector('#bankRuleForm');
  const syncRuleCategory=()=>{if(!ruleForm)return;const action=ruleForm.elements.classification.value,el=ruleForm.elements.categoryId,selected=el.value;el.innerHTML=['expense','income'].includes(action)?categoryOptions(state,action,selected):'<option value="">No category</option>';el.disabled=!['expense','income'].includes(action);};
  ruleForm?.elements.classification.addEventListener('change',syncRuleCategory);syncRuleCategory();
  main.querySelector('#bankRuleForm')?.addEventListener('submit',async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget);
    try{const r=await createBankRule({matchText:fd.get('matchText'),classification:fd.get('classification'),personId:fd.get('personId')||null,targetAccountId:fd.get('targetAccountId')||null,categoryId:fd.get('categoryId')||null});feed.rules.unshift(r.rule);paint(main,state,ctx);ctx.showToast('Bank rule added.');}catch(error){ctx.showToast(error.message||'Could not add that rule.');}
  });
  main.querySelectorAll('[data-delete-bank-rule]').forEach(btn=>btn.addEventListener('click',async()=>{try{await deleteBankRule(btn.dataset.deleteBankRule);feed.rules=feed.rules.filter(r=>r.id!==btn.dataset.deleteBankRule);paint(main,state,ctx);}catch(error){ctx.showToast(error.message||'Could not delete that rule.');}}));
}

export async function renderBankFeedPage(main,state,ctx){
  main.innerHTML='<div class="card panel"><div class="muted">Loading bank feed…</div></div>';
  try{feed=await listBankFeed();paint(main,state,ctx);}catch(error){main.innerHTML=`<div class="card empty"><strong>Could not load bank feed</strong>${escapeHtml(error.message||'Try again.')}</div>`;}
}
