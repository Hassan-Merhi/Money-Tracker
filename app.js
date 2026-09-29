import { currentUser, registrationStatus, login, register, listUsers, createUserAccount, resetUserPassword, deleteUserAccount, changePassword, revokeOtherSessions, listSessions, revokeSession, listSecurityEvents, runtimeStatus, createServerSnapshot, deleteMyAccount, logout, loadState, updateSettings, createPerson, updatePerson, removePerson, createAccount, updateAccount, removeAccount, createEntry, updateEntry, removeEntry, exportFullBackup, restoreFullBackup, resetState, listAttachments, uploadAttachment, deleteAttachment, attachmentUrl, uid } from './lib/store.js';
import { personBalances, accountBalances, totalsFromBalances, personDelta, accountDelta, runningStatement, PERSON_ENTRY_TYPES, entryTouchesPerson, SPLIT_ENTRY_TYPE, validateSplit } from './lib/ledger.js';
import { CURRENCIES, money, today, escapeHtml, downloadText, balancesText, prettyType } from './lib/utils.js';
import { currencyExponent, fromMinor, sumMinor, toMinor } from './lib/money.js';
import { renderReports, exportPersonPdf } from './lib/reports-ui.js';
import { renderRecurringPage, mountRecurringDashboardWidget } from './block-e-recurring.js';
import { renderBankFeedPage } from './block-f-bank-feed.js';
import { renderInsightsPage, mountBudgetDashboardWidget } from './block-g-insights.js';
import { categoryOptionsForType } from './lib/insights.js';
import { initPwa, pwaStatus, installPwa, activatePwaUpdate } from './lib/pwa.js';

let state = null;
let user = null;
let route = parseRoute();
let toastTimer;
let saving = false;
let pwa = {online:navigator.onLine,installable:false,installed:false,updateWaiting:false};

const app = document.querySelector('#app');
const advancedMode=()=>state?.settings?.appMode==='advanced';
const THEME_KEY='mot-theme';
const themeMedia=window.matchMedia?.('(prefers-color-scheme: dark)');

function themePreference(){
  try{
    const value=localStorage.getItem(THEME_KEY);
    return ['system','light','dark'].includes(value)?value:'system';
  }catch{return 'system';}
}
function applyTheme(preference=themePreference()){
  const effective=preference==='system'?(themeMedia?.matches?'dark':'light'):preference;
  document.documentElement.dataset.theme=effective;
  document.documentElement.style.colorScheme=effective;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',effective==='dark'?'#0b1120':'#111827');
}
function saveThemePreference(preference){
  const value=['system','light','dark'].includes(preference)?preference:'system';
  try{localStorage.setItem(THEME_KEY,value);}catch{}
  applyTheme(value);
}
applyTheme();
themeMedia?.addEventListener?.('change',()=>{if(themePreference()==='system')applyTheme('system');});
window.addEventListener('moneytracker:pwa',event=>{pwa=event.detail||pwa;if(state)render();});

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [page, query=''] = raw.split('?');
  return { page, params: new URLSearchParams(query) };
}

window.addEventListener('hashchange', () => { route = parseRoute(); if (state) render(); });

async function runMutation(action,message='') {
  if (saving) { showToast('Saving the previous change…'); return false; }
  saving = true;
  try {
    state = await action(state.version);
    if (message) showToast(message);
    render();
    return true;
  } catch (error) {
    if (error.status === 409) {
      state = await loadState();
      render();
      showToast('Another tab changed the data. I reloaded the latest version.');
    } else if (error.status === 401) {
      user = null; state = null; showAuth('Your session expired. Sign in again.');
    } else { showToast(error.message || 'Could not save.'); }
    return false;
  } finally { saving = false; }
}

function showToast(message) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  toastTimer = setTimeout(() => el.remove(), 2600);
}

function iconFor(page) {
  return ({dashboard:'⌂',people:'◉',accounts:'▣',transactions:'↕',bank:'🏦',insights:'◫',scheduled:'⏰',reports:'▤',settings:'⚙'})[page] || '•';
}

function titleFor(page) {
  return ({dashboard:'Dashboard',people:'People',accounts:'Accounts & Cash',transactions:'Transactions',bank:'Bank Feed',insights:'Insights & Budgets',scheduled:'Scheduled & Reminders',reports:'Reports & Exports',settings:'Settings',person:'Person statement'})[page] || 'Money Tracker';
}

function subFor(page) {
  return ({
    dashboard:'See exactly who owes you and who you owe.',
    people:'Track each person separately with a clean running statement.',
    accounts:'Bank accounts, cash, cards and transfers between them.',
    transactions:'Every debt, repayment, and balance change between you and a person.',
    bank:'Import statements, auto-classify rows, and review them before posting.',
    insights:'Categorize personal cash flow, set monthly budgets, and see spending trends.',
    scheduled:'Recurring transactions, due dates and reminders you review before posting.',
    reports:'Analyze balances and create Excel workbooks and polished PDF reports.',
    settings:'Account, security, currency defaults and backup controls.',
    person:'A chronological statement with a running balance.'
  })[page] || '';
}

function render() {
  const hiddenInSimpleMode=['accounts','bank','insights','scheduled'];
  const advanced=advancedMode();
  if(!advanced && hiddenInSimpleMode.includes(route.page)){location.hash='#dashboard';return;}
  const navPage = route.page === 'person' ? 'people' : route.page;
  const visiblePages=advanced?['dashboard','people','accounts','transactions','bank','insights','scheduled','reports','settings']:['dashboard','people','transactions','reports','settings'];
  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark">M</div><div><h1>Money Tracker</h1><small>Who owes who</small></div></div>
        <nav class="nav">${visiblePages.map(p => `<button data-nav="${p}" class="${navPage===p?'active':''}"><span class="nav-icon">${iconFor(p)}</span>${titleFor(p)}</button>`).join('')}</nav>
        <div class="sidebar-foot"><strong>${escapeHtml(user?.email || '')}</strong><br>${advanced?'Advanced money mode · accounts, bank feed & schedules':'Simple mode · focused debt tracking'}<br><button class="sidebar-logout" id="logoutBtn">Sign out</button></div>
      </aside>
      <section class="content">
        <header class="topbar">
          <div class="topbar-title"><h2>${titleFor(route.page)}</h2><p>${subFor(route.page)}</p></div>
          <div class="top-actions"><span class="connection-pill ${pwa.online?'online':'offline'}">${pwa.online?'● Online':'● Offline'}</span>${pwa.updateWaiting?'<button class="btn" id="applyUpdate">Update app</button>':''}${advanced?`<button class="btn" id="quickTransfer">⇄ Transfer</button>`:''}<button class="btn primary" id="quickEntry">＋ Add</button></div>
        </header>
        <main class="main" id="main"></main>
      </section>
      <button class="mobile-fab" id="mobileQuickEntry" aria-label="Add debt transaction">＋</button>
      <nav class="mobile-nav" style="grid-template-columns:repeat(${visiblePages.length},1fr)">${visiblePages.map(p => `<button data-nav="${p}" class="${navPage===p?'active':''}"><span>${iconFor(p)}</span>${p==='transactions'?'Activity':p==='reports'?'Reports':titleFor(p).split(' ')[0]}</button>`).join('')}</nav>
    </div>`;

  document.querySelectorAll('[data-nav]').forEach(btn => btn.addEventListener('click', () => location.hash = `#${btn.dataset.nav}`));
  document.querySelector('#applyUpdate')?.addEventListener('click',()=>{if(activatePwaUpdate())showToast('Updating Money Tracker…');});
  document.querySelector('#quickEntry')?.addEventListener('click', () => openQuickMenu());
  document.querySelector('#mobileQuickEntry')?.addEventListener('click', () => openQuickMenu());
  document.querySelector('#quickTransfer')?.addEventListener('click', () => openTransferModal());
  document.querySelector('#logoutBtn')?.addEventListener('click', async () => { try { await logout(); } catch {} user=null; state=null; showAuth(); });

  const main = document.querySelector('#main');
  if (route.page === 'dashboard') renderDashboard(main);
  else if (route.page === 'people') renderPeople(main);
  else if (route.page === 'accounts') renderAccounts(main);
  else if (route.page === 'transactions') renderTransactions(main);
  else if (route.page === 'bank') renderBankFeedPage(main,state,{showToast,replaceState(next){state=next;render();}});
  else if (route.page === 'insights') renderInsightsPage(main,state,route,{openModal,closeModal,showToast,replaceState(next){state=next;render();}});
  else if (route.page === 'scheduled') renderRecurringPage(main,state,{openModal,closeModal,showToast,replaceState(next){state=next;render();}});
  else if (route.page === 'reports') renderReports(main,state,route,{money,escapeHtml,today});
  else if (route.page === 'settings') renderSettings(main);
  else if (route.page === 'person') renderPerson(main, route.params.get('id'));
  else { location.hash = '#dashboard'; }
}

function currencyTotalsMarkup(totals, key, fallback='0') {
  const rows = Object.entries(totals).filter(([,v]) => Math.abs(v[key] || 0) > 0.000001);
  if (!rows.length) return `<span>${fallback}</span>`;
  return `<div class="currency-lines">${rows.map(([c,v]) => `<div>${money(v[key],c)}</div>`).join('')}</div>`;
}

function renderDashboard(main) {
  const pBalances = personBalances(state.entries, state.people);
  const totals = totalsFromBalances(pBalances);
  const recent = [...state.entries].filter(e=>PERSON_ENTRY_TYPES.includes(e.type)).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)).slice(0,8);

  main.innerHTML = `
    <div class="grid stats debt-stats">
      <div class="card stat good"><div class="stat-top"><div class="stat-label">PEOPLE OWE ME</div><div class="stat-icon">↗</div></div><div class="stat-value">${currencyTotalsMarkup(totals,'owedToMe','0')}</div><div class="stat-note">Money you should receive</div></div>
      <div class="card stat bad"><div class="stat-top"><div class="stat-label">I OWE PEOPLE</div><div class="stat-icon">↘</div></div><div class="stat-value">${currencyTotalsMarkup(totals,'iOwe','0')}</div><div class="stat-note">Money you need to pay</div></div>
      <div class="card stat net"><div class="stat-top"><div class="stat-label">NET POSITION</div><div class="stat-icon">≈</div></div><div class="stat-value">${currencyTotalsMarkup(totals,'net','0')}</div><div class="stat-note">Owed to you minus what you owe</div></div>
    </div>
    ${advancedMode()?'':`<div class="card panel" style="margin-bottom:16px"><div class="panel-head"><div><h3>Simple mode is active</h3><p>Your accounts, Bank Feed, budgets and recurring schedules stay saved but hidden. Advanced mode unlocks the full money system without changing or deleting your debt records.</p></div><button class="btn primary" id="enableAdvanced">Enable Advanced mode</button></div></div>`}
    <div class="grid section-grid">
      <section class="card panel">
        <div class="panel-head"><div><h3>Recent activity</h3><p>Your latest debts and repayments</p></div><button class="btn small" data-go="transactions">View all</button></div>
        ${recent.length ? transactionTable(recent, {compact:true}) : `<div class="empty"><strong>No debt activity yet</strong>Add a person, then record what they owe you or what you owe them.</div>`}
      </section>
      <section class="card panel">
        <div class="panel-head"><div><h3>Quick actions</h3><p>No bank account needed</p></div></div>
        <div class="quick-grid">
          <button class="quick" data-action="paid_for_person"><span class="qicon">↗</span><strong>They owe me</strong><small>I paid for them / lent them money</small></button>
          <button class="quick" data-action="received_from_person"><span class="qicon">💵</span><strong>They paid me</strong><small>Reduce what they owe me</small></button>
          <button class="quick" data-action="borrowed_from_person"><span class="qicon">↘</span><strong>I owe them</strong><small>They paid for me / lent me money</small></button>
          <button class="quick" data-action="paid_to_person"><span class="qicon">✅</span><strong>I paid them</strong><small>Reduce what I owe them</small></button>
          <button class="quick" data-action="${SPLIT_ENTRY_TYPE}"><span class="qicon">👥</span><strong>Split between people</strong><small>One amount owed by multiple people</small></button>
          <button class="quick" data-action="person"><span class="qicon">👤</span><strong>Add a person</strong><small>Create a statement</small></button>
        </div>
      </section>
    </div>`;
  main.querySelector('#enableAdvanced')?.addEventListener('click',async()=>{const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone||state.settings.timezone||'UTC';const saved=await runMutation(version=>updateSettings({defaultCurrency:state.settings.defaultCurrency,appMode:'advanced',timezone},version),'Advanced mode enabled.');if(saved)location.hash='#dashboard';});
  main.querySelector('[data-go="transactions"]')?.addEventListener('click',()=>location.hash='#transactions');
  main.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => {
    const a=b.dataset.action;
    if (a==='person') openPersonModal(); else openTransactionModal(null,{type:a});
  }));
}

function renderPeople(main) {
  const balances = personBalances(state.entries,state.people);
  const query = (route.params.get('q')||'').toLowerCase();
  const people = [...state.people].filter(p => !query || `${p.name} ${p.note||''}`.toLowerCase().includes(query)).sort((a,b)=>a.name.localeCompare(b.name));
  main.innerHTML = `
    <div class="panel-head"><div class="filters"><input id="peopleSearch" class="input search" placeholder="Search people…" value="${escapeHtml(route.params.get('q')||'')}"></div><div class="page-actions"><button class="btn primary" id="addPerson">＋ Add person</button></div></div>
    ${people.length ? `<div class="people-grid">${people.map(p=>personCard(p,balances[p.id]||{})).join('')}</div>` : `<div class="card hero-empty empty"><div class="big">👥</div><h3>${query?'No matching people':'Add the people you exchange money with'}</h3><p>Each person gets a separate running statement. Positive means they owe you. Negative means you owe them.</p><button class="btn primary" id="emptyAddPerson">＋ Add person</button></div>`}`;
  main.querySelector('#addPerson')?.addEventListener('click',()=>openPersonModal());
  main.querySelector('#emptyAddPerson')?.addEventListener('click',()=>openPersonModal());
  main.querySelector('#peopleSearch')?.addEventListener('input', e => {
    const q=e.target.value.trim(); location.hash = q ? `#people?q=${encodeURIComponent(q)}` : '#people';
  });
  main.querySelectorAll('[data-person]').forEach(c=>c.addEventListener('click',()=>location.hash=`#person?id=${c.dataset.person}`));
}

function personCard(p,balance) {
  const values=Object.values(balance);
  const netSign=values.reduce((a,b)=>a+b,0);
  return `<div class="card person-card" data-person="${p.id}"><div class="person-top"><div style="display:flex;gap:11px;align-items:center"><div class="avatar">${escapeHtml(p.name.slice(0,2).toUpperCase())}</div><div><h3>${escapeHtml(p.name)}</h3><p>${escapeHtml(p.note||'Personal statement')}</p></div></div><span class="pill">View</span></div><div class="balance ${netSign>0?'positive':netSign<0?'negative':''}">${balancesText(balance)}</div></div>`;
}

function renderPerson(main, personId) {
  const person=state.people.find(p=>p.id===personId);
  if(!person){ main.innerHTML='<div class="empty">Person not found.</div>'; return; }
  const balances=personBalances(state.entries,state.people)[person.id]||{};
  const personEntries=runningStatement(state.entries,person.id).sort((a,b)=>new Date(b.date)-new Date(a.date)||new Date(b.createdAt)-new Date(a.createdAt));
  main.innerHTML=`
    <div class="detail-header"><div class="detail-title"><div class="avatar">${escapeHtml(person.name.slice(0,2).toUpperCase())}</div><div><h2>${escapeHtml(person.name)}</h2><p>${escapeHtml(person.note||'Personal statement')}</p></div></div><div class="page-actions"><button class="btn" id="personPdf">↓ PDF statement</button><button class="btn" id="editPerson">✎ Edit</button><button class="btn primary" id="personTxn">＋ Add transaction</button></div></div>
    <div class="statement-summary">${Object.keys(balances).length?Object.entries(balances).map(([c,v])=>`<span class="pill ${v>0?'green':v<0?'red':''}">${v>0?'Owes you':v<0?'You owe':'Settled'} · ${money(Math.abs(v),c)}</span>`).join(''):'<span class="pill">Settled</span>'}</div>
    <section class="card panel"><div class="panel-head"><div><h3>Statement</h3><p>Positive change means the person owes you more; negative means less.</p></div></div>${personEntries.length?statementTable(personEntries):'<div class="empty"><strong>No statement entries yet</strong>Add the first purchase, repayment, borrowing or opening balance.</div>'}</section>`;
  main.querySelector('#personTxn')?.addEventListener('click',()=>openTransactionModal(null,{personId:person.id}));
  main.querySelector('#personPdf')?.addEventListener('click',()=>exportPersonPdf(state,person,today));
  main.querySelector('#editPerson')?.addEventListener('click',()=>openPersonModal(person));
  main.querySelectorAll('[data-edit-entry]').forEach(b=>b.addEventListener('click',()=>openTransactionModal(state.entries.find(e=>e.id===b.dataset.editEntry))));
  main.querySelectorAll('[data-delete-entry]').forEach(b=>b.addEventListener('click',()=>deleteEntry(b.dataset.deleteEntry)));
}

function statementTable(entries){
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Type</th><th>Notes</th><th class="right">Change</th><th class="right">Running balance</th><th></th></tr></thead><tbody>${entries.map(e=>{const d=Number.isFinite(e.delta)?e.delta:personDelta(e,e.personId);const c=e.currency||'USD';return `<tr><td>${escapeHtml(e.date)}</td><td><span class="pill">${prettyType(e.type)}</span></td><td><strong>${escapeHtml(e.description||'—')}</strong>${e.merchant?`<div class="muted tiny">${escapeHtml(e.merchant)}</div>`:''}${e.attachmentCount?`<div class="attachment-count">📎 ${e.attachmentCount}</div>`:''}</td><td class="right ${d>=0?'amount-pos':'amount-neg'}">${d>=0?'+':''}${money(d,c)}</td><td class="right strong">${money(e.running||0,c)}</td><td class="actions"><button class="btn small" data-edit-entry="${e.id}">Edit</button> <button class="btn small danger" data-delete-entry="${e.id}">Delete</button></td></tr>`}).join('')}</tbody></table></div>`;
}

function renderAccounts(main) {
  const balances=accountBalances(state.entries,state.accounts);
  main.innerHTML=`<div class="panel-head"><div><p class="muted">Opening balance + all linked money movements.</p></div><div class="page-actions"><button class="btn" id="transferBtn">⇄ Transfer</button><button class="btn primary" id="addAccount">＋ Add account</button></div></div>
  ${state.accounts.length?`<div class="accounts-grid">${state.accounts.map(a=>`<div class="card account-card" data-account="${a.id}"><div class="account-top"><div><h3>${escapeHtml(a.name)}</h3><p>${escapeHtml(a.type)} · ${escapeHtml(a.currency)}</p></div><span class="pill">${a.type==='cash'?'Cash':'Account'}</span></div><div class="balance ${balances[a.id]<0?'negative':''}">${money(balances[a.id]||0,a.currency)}</div><div class="muted tiny">Opening: ${money(a.openingBalance||0,a.currency)}</div></div>`).join('')}</div>`:`<div class="card hero-empty empty"><div class="big">🏦</div><h3>Add your bank accounts and cash</h3><p>When you pay for someone, receive money, borrow, repay or transfer funds, the linked account balance updates automatically.</p><button class="btn primary" id="emptyAddAccount">＋ Add account</button></div>`}`;
  main.querySelector('#addAccount')?.addEventListener('click',()=>openAccountModal());
  main.querySelector('#emptyAddAccount')?.addEventListener('click',()=>openAccountModal());
  main.querySelector('#transferBtn')?.addEventListener('click',()=>openTransferModal());
  main.querySelectorAll('[data-account]').forEach(c=>c.addEventListener('click',()=>openAccountDetail(c.dataset.account)));
}

function openAccountDetail(accountId){
  const a=state.accounts.find(x=>x.id===accountId); if(!a)return;
  const balances=accountBalances(state.entries,state.accounts);
  const entries=state.entries.filter(e=>e.accountId===a.id||e.fromAccountId===a.id||e.toAccountId===a.id).sort((x,y)=>new Date(y.date)-new Date(x.date)||new Date(y.createdAt)-new Date(x.createdAt));
  openModal(`${escapeHtml(a.name)} · ${money(balances[a.id]||0,a.currency)}`, `${entries.length?transactionTable(entries,{compact:true}):'<div class="empty">No activity yet.</div>'}<div style="margin-top:16px;display:flex;gap:8px"><button class="btn" id="modalEditAccount">Edit account</button><button class="btn danger" id="modalDeleteAccount">Delete account</button></div>`, null, false);
  document.querySelector('#modalEditAccount')?.addEventListener('click',()=>{closeModal();openAccountModal(a)});
  document.querySelector('#modalDeleteAccount')?.addEventListener('click',()=>deleteAccount(a.id));
}

function renderTransactions(main) {
  const type=route.params.get('type')||''; const person=route.params.get('person')||'';
  let entries=[...state.entries].filter(e=>advancedMode()?true:PERSON_ENTRY_TYPES.includes(e.type)).sort((a,b)=>new Date(b.date)-new Date(a.date)||new Date(b.createdAt)-new Date(a.createdAt));
  if(type) entries=entries.filter(e=>e.type===type); if(person) entries=entries.filter(e=>entryTouchesPerson(e,person));
  main.innerHTML=`<div class="panel-head"><div class="filters"><select class="select" id="filterType"><option value="">All debt activity</option>${entryTypeOptions(type,false)}</select><select class="select" id="filterPerson"><option value="">All people</option>${state.people.map(p=>`<option value="${p.id}" ${person===p.id?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}</select></div><button class="btn primary" id="addTxn">＋ Add</button></div>
  <section class="card panel">${entries.length?transactionTable(entries):'<div class="empty"><strong>No matching debt activity</strong>Add what someone owes you, what you owe them, or a repayment.</div>'}</section>`;
  const update=()=>{const q=new URLSearchParams();const t=main.querySelector('#filterType').value,p=main.querySelector('#filterPerson').value;if(t)q.set('type',t);if(p)q.set('person',p);location.hash=`#transactions${q.toString()?'?'+q:''}`};
  ['#filterType','#filterPerson'].forEach(s=>main.querySelector(s)?.addEventListener('change',update));
  main.querySelector('#addTxn')?.addEventListener('click',()=>openQuickMenu());
  main.querySelectorAll('[data-edit-entry]').forEach(b=>b.addEventListener('click',()=>openTransactionModal(state.entries.find(e=>e.id===b.dataset.editEntry))));
  main.querySelectorAll('[data-delete-entry]').forEach(b=>b.addEventListener('click',()=>deleteEntry(b.dataset.deleteEntry)));
}

function transactionTable(entries,{compact=false}={}){
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Type</th><th>Person / transfer</th><th>Notes</th><th class="right">Amount</th>${compact?'':'<th></th>'}</tr></thead><tbody>${entries.map(e=>{
    const p=state.people.find(x=>x.id===e.personId); const from=state.accounts.find(x=>x.id===e.fromAccountId); const to=state.accounts.find(x=>x.id===e.toAccountId); const acc=state.accounts.find(x=>x.id===e.accountId);
    const splitNames=e.type===SPLIT_ENTRY_TYPE?(e.splits||[]).map(split=>state.people.find(x=>x.id===split.personId)?.name||'Unknown').join(', '):'';
    const personText=e.type==='account_transfer'?`${escapeHtml(from?.name||'Unknown')} → ${escapeHtml(to?.name||'Unknown')}`:e.type===SPLIT_ENTRY_TYPE?escapeHtml(splitNames):(e.type==='account_expense'||e.type==='account_income')?escapeHtml(acc?.name||'Account only'):escapeHtml(p?.name||'—');
    const amt=e.type==='account_transfer'?`${money(e.fromAmount||e.amount,from?.currency||e.currency||'USD')}${from?.currency!==to?.currency?` → ${money(e.toAmount||e.amount,to?.currency||e.currency||'USD')}`:''}`:money(e.amount,e.currency||acc?.currency||'USD');
    const category=state.categories?.find(x=>x.id===e.categoryId);
    return `<tr><td>${escapeHtml(e.date)}</td><td><span class="pill">${prettyType(e.type)}</span></td><td>${personText}</td><td>${escapeHtml(e.description||e.merchant||'—')}${category?`<div class="attachment-count">${escapeHtml((category.icon?category.icon+' ':'')+category.name)}</div>`:''}${e.attachmentCount?`<div class="attachment-count">📎 ${e.attachmentCount} attachment${e.attachmentCount===1?'':'s'}</div>`:''}</td><td class="right strong">${amt}</td>${compact?'':`<td class="actions"><button class="btn small" data-edit-entry="${e.id}">Edit</button> <button class="btn small danger" data-delete-entry="${e.id}">Delete</button></td>`}</tr>`}).join('')}</tbody></table></div>`;
}

function renderSettings(main) {
  main.innerHTML=`<div class="settings-grid">
    <section class="card settings-card"><h3>General</h3><div class="form-grid">
      <div class="field"><label>Default currency</label><select id="settingCurrency" class="select">${currencyOptions(state.settings.defaultCurrency)}</select></div>
      <div class="field"><label>App mode</label><select id="settingMode" class="select"><option value="simple" ${state.settings.appMode!=='advanced'?'selected':''}>Simple — debts only</option><option value="advanced" ${state.settings.appMode==='advanced'?'selected':''}>Advanced — full money system</option></select></div>
      <div class="field"><label>Appearance</label><select id="settingTheme" class="select"><option value="system" ${themePreference()==='system'?'selected':''}>System</option><option value="light" ${themePreference()==='light'?'selected':''}>Light</option><option value="dark" ${themePreference()==='dark'?'selected':''}>Dark</option></select></div>
      <div class="field"><label>Timezone</label><input class="input" id="settingTimezone" value="${escapeHtml(state.settings.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC')}" readonly><span class="muted tiny">Used by server-side recurring reminders.</span></div>
    </div><div class="warning" style="margin-top:12px"><strong>Simple mode</strong> hides accounts, Bank Feed, budgets and schedules without deleting them. Switch back to Advanced at any time.</div><div style="margin-top:14px"><button class="btn primary" id="saveSettings">Save settings</button></div></section>
    ${user?.isOwner?`<section class="card settings-card"><h3>User accounts</h3><p class="muted">Public account creation locks after the first owner account. You can reset or delete secondary sign-in accounts here.</p><div id="managedUsers" class="muted">Loading accounts…</div><form id="addUserForm" class="form-grid" style="margin-top:14px"><div class="field"><label>Email</label><input class="input" name="email" type="email" autocomplete="off" required></div><div class="field"><label>Password</label><input class="input" name="password" type="password" minlength="10" autocomplete="new-password" required></div><div class="span-2"><button class="btn primary" type="submit">＋ Create account</button></div></form></section>`:''}
    <section class="card settings-card"><h3>Security</h3><p class="muted">Signed in as <strong>${escapeHtml(user?.email||'')}</strong>. Password changes revoke every other session automatically.</p>
      <form id="passwordForm" class="form-grid" style="margin-top:14px"><div class="field"><label>Current password</label><input class="input" name="currentPassword" type="password" autocomplete="current-password" required></div><div class="field"><label>New password</label><input class="input" name="newPassword" type="password" minlength="10" autocomplete="new-password" required></div><div class="span-2 page-actions"><button class="btn primary" type="submit">Change password</button><button class="btn" type="button" id="revokeSessions">Sign out other devices</button><button class="btn" type="button" id="settingsLogout">Sign out this device</button></div></form>
    </section>
    <section class="card settings-card"><h3>Complete backup & recovery</h3><p class="muted">This backup includes people, accounts, transactions, attachments, recurring schedules, categories, budgets, Bank Feed items/rules, and settings. Passwords and active sessions are never exported.</p><div class="page-actions"><button class="btn" id="exportBackup">↓ Export complete backup</button><button class="btn" id="importBackup">↑ Restore complete backup</button><button class="btn" id="openReports">Open reports</button><input type="file" id="backupFile" accept="application/json" hidden></div></section>
    <section class="card settings-card"><h3>Balance rules</h3><div class="warning"><strong>Balance rule:</strong> positive personal balance = they owe you. Negative personal balance = you owe them. Transfers affect accounts only and never change a person’s balance.</div></section>
    <section class="card settings-card"><h3>Danger zone</h3><p class="muted">Delete all app data keeps your login. Delete account removes this login and all of its data permanently.</p><div class="page-actions"><button class="btn danger" id="resetData">Delete all app data</button><button class="btn danger" id="deleteMyAccount">Delete my account</button></div></section>
  </div>`;
  main.querySelector('#saveSettings')?.addEventListener('click',async()=>{const defaultCurrency=main.querySelector('#settingCurrency').value,appMode=main.querySelector('#settingMode').value,timezone=Intl.DateTimeFormat().resolvedOptions().timeZone||state.settings.timezone||'UTC';saveThemePreference(main.querySelector('#settingTheme').value);const saved=await runMutation(version=>updateSettings({defaultCurrency,appMode,timezone},version),'Settings saved.');if(saved&&appMode==='advanced')showToast('Advanced mode enabled — accounts, Bank Feed, budgets and schedules are now available.');});
  main.querySelector('#settingTheme')?.addEventListener('change',event=>applyTheme(event.target.value));
  main.querySelector('#settingsLogout')?.addEventListener('click',()=>document.querySelector('#logoutBtn')?.click());
  main.querySelector('#revokeSessions')?.addEventListener('click',async()=>{try{const result=await revokeOtherSessions();showToast(`${result.revoked||0} other session${result.revoked===1?'':'s'} signed out.`);}catch(error){showToast(error.message||'Could not revoke sessions.');}});
  main.querySelector('#passwordForm')?.addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,fd=new FormData(form),button=form.querySelector('button[type=submit]');button.disabled=true;try{await changePassword(fd.get('currentPassword'),fd.get('newPassword'));form.reset();showToast('Password changed. Other devices were signed out.');}catch(error){showToast(error.message||'Could not change password.');}finally{button.disabled=false;}});
  main.querySelector('#exportBackup')?.addEventListener('click',async()=>{try{const backup=await exportFullBackup();downloadText(`money-tracker-complete-backup-${today()}.json`,JSON.stringify(backup,null,2));showToast('Complete backup exported.');}catch(error){showToast(error.message||'Could not export backup.');}});
  main.querySelector('#importBackup')?.addEventListener('click',()=>main.querySelector('#backupFile').click());
  main.querySelector('#openReports')?.addEventListener('click',()=>{location.hash='#reports';});
  main.querySelector('#backupFile')?.addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{const parsed=JSON.parse(await file.text());if(Number(parsed.backupVersion)!==2||parsed.app!=='money-owed-tracker')throw new Error('That file is not a complete Money Tracker backup.');if(!confirm('Restore this complete backup? Current app data for this login will be replaced.'))return;const result=await restoreFullBackup(parsed);state=result.state;showToast('Complete backup restored.');render();}catch(error){showToast(error.message||'Could not restore that backup.');}finally{e.target.value='';}});
  main.querySelector('#resetData')?.addEventListener('click',async()=>{if(confirm('Permanently delete all Money Tracker app data for this login?')){try{state=await resetState();showToast('App data deleted.');location.hash='#dashboard';render();}catch(error){showToast(error.message||'Could not reset app data.');}}});
  main.querySelector('#deleteMyAccount')?.addEventListener('click',()=>openDeleteAccountModal());
  if(user?.isOwner){
    refreshManagedUsers(main);
    main.querySelector('#addUserForm')?.addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,fd=new FormData(form),button=form.querySelector('button[type=submit]');button.disabled=true;try{await createUserAccount(fd.get('email'),fd.get('password'));form.reset();showToast('Account created.');await refreshManagedUsers(main);}catch(error){showToast(error.message||'Could not create account.');}finally{button.disabled=false;}});
  }
}

async function refreshManagedUsers(main){
  const host=main.querySelector('#managedUsers');if(!host)return;
  try{
    const data=await listUsers();
    host.innerHTML=`<div class="table-wrap"><table class="table"><thead><tr><th>Email</th><th>Role</th><th>Created</th><th></th></tr></thead><tbody>${data.users.map(account=>`<tr><td><strong>${escapeHtml(account.email)}</strong></td><td>${account.isOwner?'<span class="pill">Owner</span>':'User'}</td><td>${escapeHtml(String(account.createdAt||'').slice(0,10))}</td><td class="actions">${account.isOwner?'':`<button class="btn small" data-reset-user="${account.id}">Reset password</button> <button class="btn small danger" data-delete-user="${account.id}">Delete</button>`}</td></tr>`).join('')}</tbody></table></div>`;
    host.querySelectorAll('[data-reset-user]').forEach(button=>button.addEventListener('click',async()=>{const password=prompt('Enter a new password (10+ characters) for this account:');if(!password)return;try{await resetUserPassword(button.dataset.resetUser,password);showToast('Password reset and that user’s sessions were revoked.');}catch(error){showToast(error.message||'Could not reset password.');}}));
    host.querySelectorAll('[data-delete-user]').forEach(button=>button.addEventListener('click',async()=>{if(!confirm('Delete this user account and all of its app data?'))return;try{await deleteUserAccount(button.dataset.deleteUser);showToast('User account deleted.');await refreshManagedUsers(main);}catch(error){showToast(error.message||'Could not delete user account.');}}));
  }catch(error){host.textContent=error.message||'Could not load user accounts.';}
}

function openDeleteAccountModal(){
  openModal('Delete my account',`<form id="deleteAccountForm" class="form-grid">
    <div class="span-2 warning">This permanently deletes this login and all data owned by it. This cannot be undone.</div>
    <div class="field span-2"><label>Current password</label><input class="input" type="password" name="password" autocomplete="current-password" required></div>
    <div class="field span-2"><label>Type DELETE to confirm</label><input class="input" name="confirmation" required autocomplete="off"></div>
  </form>`,()=>document.querySelector('#deleteAccountForm').requestSubmit());
  document.querySelector('#deleteAccountForm').addEventListener('submit',async event=>{event.preventDefault();const fd=new FormData(event.currentTarget);try{await deleteMyAccount(fd.get('password'),fd.get('confirmation'));user=null;state=null;closeModal();await showAuth('Account deleted.');}catch(error){showToast(error.message||'Could not delete account.');}});
}

function openPersonModal(existing=null){
  const isEdit=!!existing;
  openModal(isEdit?'Edit person':'Add person',`<form id="personForm" class="form-grid">
    <div class="field span-2"><label>Name</label><input class="input" name="name" required maxlength="80" value="${escapeHtml(existing?.name||'')}" placeholder="e.g. Ahmad"></div>
    <div class="field span-2"><label>Note</label><input class="input" name="note" maxlength="120" value="${escapeHtml(existing?.note||'')}" placeholder="e.g. Cousin / Amazon purchases"></div>
    ${isEdit?'':`<div class="field"><label>Opening balance</label><input class="input" name="opening" type="number" step="any" min="0" placeholder="0"></div><div class="field"><label>Currency</label><select class="select" name="currency">${currencyOptions(state.settings.defaultCurrency)}</select></div><div class="field span-2"><label>Opening balance means</label><select class="select" name="direction"><option value="to_me">They already owe me</option><option value="i_owe">I already owe them</option></select></div>`}
  </form>`,()=>document.querySelector('#personForm').requestSubmit());
  document.querySelector('#personForm').addEventListener('submit',async e=>{
    e.preventDefault();
    const fd=new FormData(e.currentTarget),name=String(fd.get('name')||'').trim(),note=String(fd.get('note')||'').trim();
    if(!name)return;
    let saved=false;
    if(existing){
      saved=await runMutation(version=>updatePerson(existing.id,{name,note},version),'Person updated.');
    }else{
      const id=uid('person'),openingEntryId=uid('entry');
      saved=await runMutation(version=>createPerson({id,name,note,openingBalance:Number(fd.get('opening')||0),currency:fd.get('currency'),direction:fd.get('direction'),openingEntryId,openingDate:today()},version),'Person added.');
    }
    if(saved)closeModal();
  });
  if(existing){const foot=document.querySelector('.modal-foot');const del=document.createElement('button');del.type='button';del.className='btn danger';del.textContent='Delete person';del.style.marginRight='auto';del.onclick=()=>deletePerson(existing.id);foot.prepend(del);}
}

function openAccountModal(existing=null){
  const isEdit=!!existing;
  openModal(isEdit?'Edit account':'Add account',`<form id="accountForm" class="form-grid">
    <div class="field span-2"><label>Account name</label><input class="input" name="name" required maxlength="80" value="${escapeHtml(existing?.name||'')}" placeholder="e.g. Bank Audi USD / Cash USD"></div>
    <div class="field"><label>Type</label><select class="select" name="type">${[['bank','Bank'],['cash','Cash'],['card','Card'],['wallet','Wallet'],['other','Other']].map(([v,l])=>`<option value="${v}" ${existing?.type===v?'selected':''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label>Currency</label><select class="select" name="currency" ${isEdit?'disabled':''}>${currencyOptions(existing?.currency||state.settings.defaultCurrency)}</select></div>
    <div class="field span-2"><label>Opening balance</label><input class="input" name="openingBalance" type="number" step="any" value="${existing?.openingBalance??0}"><span class="muted tiny">Use the actual balance at the point you start tracking this account.</span></div>
  </form>`,()=>document.querySelector('#accountForm').requestSubmit());
  document.querySelector('#accountForm').addEventListener('submit',async e=>{
    e.preventDefault();
    const fd=new FormData(e.currentTarget),name=String(fd.get('name')||'').trim();if(!name)return;
    const payload={name,type:fd.get('type'),openingBalance:Number(fd.get('openingBalance')||0)};
    let saved=false;
    if(existing)saved=await runMutation(version=>updateAccount(existing.id,payload,version),'Account updated.');
    else saved=await runMutation(version=>createAccount({...payload,id:uid('account'),currency:fd.get('currency')},version),'Account added.');
    if(saved)closeModal();
  });
}

function lastUsed() {
  try { return JSON.parse(localStorage.getItem('mot-last-entry') || '{}'); } catch { return {}; }
}
function rememberUsed(personId,accountId,type) {
  try { localStorage.setItem('mot-last-entry',JSON.stringify({personId,accountId,type})); } catch {}
}

function openQuickMenu(){
  const recent=lastUsed();
  const actions=[
    ['paid_for_person','↗','They owe me','I paid for them or lent them money'],
    ['received_from_person','💵','They paid me','Reduce what they owe me'],
    ['borrowed_from_person','↘','I owe them','They paid for me or lent me money'],
    ['paid_to_person','✅','I paid them','Reduce what I owe them'],
    [SPLIT_ENTRY_TYPE,'👥','Split between people','One amount owed by multiple people'],
    ['person_adjustment','±','Adjust balance','Set or correct a person balance']
  ];
  openModal('Add debt activity',`<div class="quick-menu">${actions.map(([type,icon,title,note])=>`<button class="quick" data-fast-type="${type}"><span class="qicon">${icon}</span><strong>${title}</strong><small>${note}</small></button>`).join('')}</div><div class="shortcut-hint">Keyboard: <kbd>N</kbd> add debt activity</div>`,null,false);
  document.querySelectorAll('[data-fast-type]').forEach(button=>button.addEventListener('click',()=>{const type=button.dataset.fastType;closeModal();openTransactionModal(null,{type,personId:recent.personId});}));
}

function splitRowMarkup(split,index){
  return `<div class="split-row" data-split-row>
    <select class="select" data-split-person aria-label="Split person"><option value="">Choose person</option>${state.people.map(p=>`<option value="${p.id}" ${split.personId===p.id?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}</select>
    <input class="input" data-split-amount type="number" min="0" step="any" value="${split.amount??''}" placeholder="Amount" aria-label="Split amount">
    <input class="input split-note" data-split-note maxlength="180" value="${escapeHtml(split.note||'')}" placeholder="Note (optional)" aria-label="Split note">
    <button class="icon-btn" type="button" data-remove-split="${index}" aria-label="Remove split">×</button>
  </div>`;
}

async function refreshAttachmentPanel(entryId){
  const panel=document.querySelector('#attachmentPanel'); if(!panel||!entryId)return;
  panel.innerHTML='<div class="muted tiny">Loading attachments…</div>';
  try{
    const data=await listAttachments(entryId), attachments=data.attachments||[];
    panel.innerHTML=attachments.length?attachments.map(a=>`<div class="attachment-item"><a href="${attachmentUrl(a.id)}" target="_blank" rel="noopener">📎 ${escapeHtml(a.name)}</a><span class="muted tiny">${Math.max(1,Math.round(a.sizeBytes/1024))} KB</span><button class="btn small danger" type="button" data-delete-attachment="${a.id}">Remove</button></div>`).join(''):'<div class="muted tiny">No receipts or files attached yet.</div>';
    panel.querySelectorAll('[data-delete-attachment]').forEach(button=>button.addEventListener('click',async()=>{if(!confirm('Remove this attachment?'))return;try{await deleteAttachment(button.dataset.deleteAttachment);const entry=state.entries.find(e=>e.id===entryId);if(entry)entry.attachmentCount=Math.max(0,Number(entry.attachmentCount||0)-1);await refreshAttachmentPanel(entryId);showToast('Attachment removed.');}catch(error){showToast(error.message||'Could not remove attachment.');}}));
  }catch(error){panel.innerHTML=`<div class="warning">${escapeHtml(error.message||'Could not load attachments.')}</div>`;}
}

function openTransactionModal(existing=null,prefill={}){
  if(existing?.type==='account_transfer'){openTransferModal(existing);return;}
  const recent=lastUsed();
  const type=existing?.type||prefill.type||recent.type||'paid_for_person';
  const personId=existing?.personId||prefill.personId||recent.personId||state.people[0]?.id||'';
  const accountId=existing?.accountId||prefill.accountId||recent.accountId||state.accounts[0]?.id||'';
  const inferredCurrency=existing?.currency||state.accounts.find(a=>a.id===accountId)?.currency||state.settings.defaultCurrency;
  const seedSplits=existing?.splits?.length?existing.splits:state.people.slice(0,2).map(p=>({personId:p.id,amount:'',note:''}));
  openModal(existing?'Edit transaction':'Add transaction',`<form id="txnForm" class="form-grid">
    <div class="field span-2"><label>Transaction type</label><select class="select" name="type" id="txnType">${entryTypeOptions(type,false)}</select></div>
    <div class="field" id="txnPersonField"><label>Person</label><select class="select" name="personId" id="txnPerson"><option value="">Choose person</option>${state.people.map(p=>`<option value="${p.id}" ${p.id===personId?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}</select></div>
    <div class="field" id="txnAccountField"><label>Account / cash</label><select class="select" name="accountId" id="txnAccount"><option value="">Choose account</option>${state.accounts.map(a=>`<option value="${a.id}" ${a.id===accountId?'selected':''}>${escapeHtml(a.name)} · ${a.currency}</option>`).join('')}</select></div>
    <div class="field"><label>Total amount</label><input class="input" id="txnAmount" name="amount" type="number" min="0.000001" step="any" required value="${existing?.amount??''}" placeholder="0.00" inputmode="decimal"></div>
    <div class="field" id="currencyField"><label>Currency</label><select class="select" name="currency" id="txnCurrency">${currencyOptions(inferredCurrency)}</select></div>
    <div class="field"><label>Date</label><input class="input" name="date" type="date" required value="${existing?.date||today()}"></div>
    <div class="field"><label>Merchant / source</label><input class="input" name="merchant" maxlength="100" value="${escapeHtml(existing?.merchant||'')}" placeholder="e.g. Amazon" autocomplete="off"></div>
    <div class="field" id="txnCategoryField"><label>Category</label><select class="select" name="categoryId" id="txnCategory"></select></div>
    <div class="field span-2"><label>Notes / details</label><textarea class="textarea compact-textarea" name="description" maxlength="500" placeholder="e.g. Headphones, order #123, delivery details…">${escapeHtml(existing?.description||'')}</textarea></div>
    <div class="field span-2" id="splitSection" hidden>
      <div class="split-head"><div><label>Split between people</label><div class="muted tiny">${advancedMode()?'The account is charged once; each person gets only their allocated amount.':'Divide the total across people. No bank account is needed.'}</div></div><div class="page-actions"><button class="btn small" type="button" id="equalSplit">Equal split</button><button class="btn small" type="button" id="addSplitRow">＋ Person</button></div></div>
      <div class="split-list" id="splitRows">${seedSplits.map(splitRowMarkup).join('')}</div>
      <div class="split-total" id="splitTotal"></div>
    </div>
    <div class="field span-2" id="adjustDirection" style="display:none"><label>Adjustment means</label><select class="select" name="direction"><option value="to_me" ${(existing?.signedAmount??1)>=0?'selected':''}>They owe me more</option><option value="i_owe" ${(existing?.signedAmount??1)<0?'selected':''}>I owe them more</option></select></div>
    <div class="field span-2"><label>Receipt / attachment</label><input class="input file-input" id="txnFiles" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain"><div id="fileSelection" class="muted tiny">JPG, PNG, WebP, GIF, PDF or text · max 8 MB each</div></div>
    ${existing?`<div class="field span-2"><label>Attached files</label><div id="attachmentPanel" class="attachment-panel"></div></div>`:''}
  </form>`,()=>document.querySelector('#txnForm').requestSubmit());

  const form=document.querySelector('#txnForm'),typeEl=form.querySelector('#txnType'),personEl=form.querySelector('#txnPerson'),accEl=form.querySelector('#txnAccount'),curEl=form.querySelector('#txnCurrency'),amountEl=form.querySelector('#txnAmount'),categoryEl=form.querySelector('#txnCategory'),splitSection=form.querySelector('#splitSection'),splitRows=form.querySelector('#splitRows');
  const fillCategories=()=>{const t=typeEl.value,current=categoryEl.value||existing?.categoryId||'';const choices=categoryOptionsForType(state.categories||[],t);const archived=(state.categories||[]).find(x=>x.id===current&&x.archived);categoryEl.innerHTML='<option value="">Uncategorized</option>'+choices.map(cat=>`<option value="${cat.id}" ${cat.id===current?'selected':''}>${escapeHtml((cat.icon?cat.icon+' ':'')+cat.name)}</option>`).join('')+(archived?`<option value="${archived.id}" selected>${escapeHtml((archived.icon?archived.icon+' ':'')+archived.name)} (archived)</option>`:'');};
  const readSplits=()=>[...splitRows.querySelectorAll('[data-split-row]')].map(row=>({personId:row.querySelector('[data-split-person]').value,amount:Number(row.querySelector('[data-split-amount]').value||0),note:row.querySelector('[data-split-note]').value.trim()}));
  const splitCurrency=()=>state.accounts.find(a=>a.id===accEl.value)?.currency||curEl.value||state.settings.defaultCurrency;
  const updateSplitTotal=()=>{const rows=readSplits(),currency=splitCurrency(),digits=currencyExponent(currency),total=Number(amountEl.value||0);try{const totalMinor=toMinor(total,currency),sumMinorValue=sumMinor(rows.map(row=>toMinor(Number(row.amount||0),currency))),diffMinor=totalMinor-sumMinorValue,sum=fromMinor(sumMinorValue,currency),diff=fromMinor(Math.abs(diffMinor),currency);form.querySelector('#splitTotal').innerHTML=`Allocated <strong>${sum.toFixed(digits)}</strong> of <strong>${fromMinor(totalMinor,currency).toFixed(digits)}</strong> · <span class="${diffMinor===0?'amount-pos':'amount-neg'}">${diffMinor===0?'Balanced':`${diffMinor>0?'Remaining':'Over'} ${diff.toFixed(digits)}`}</span>`;}catch{form.querySelector('#splitTotal').textContent='Enter valid amounts for the selected currency.';}};
  const bindSplitRows=()=>{splitRows.querySelectorAll('input,select').forEach(el=>el.addEventListener('input',updateSplitTotal));splitRows.querySelectorAll('[data-remove-split]').forEach(button=>button.addEventListener('click',()=>{const draft=readSplits();draft.splice(Number(button.dataset.removeSplit),1);splitRows.innerHTML=draft.map(splitRowMarkup).join('');bindSplitRows();updateSplitTotal();}));};
  form.querySelector('#addSplitRow').addEventListener('click',()=>{const draft=readSplits();draft.push({personId:'',amount:'',note:''});splitRows.innerHTML=draft.map(splitRowMarkup).join('');bindSplitRows();updateSplitTotal();});
  form.querySelector('#equalSplit').addEventListener('click',()=>{const rows=[...splitRows.querySelectorAll('[data-split-row]')],total=Number(amountEl.value||0),currency=splitCurrency();if(!rows.length||!(total>0)){showToast('Enter the total amount first.');return;}try{const totalMinor=toMinor(total,currency,{allowNegative:false,allowZero:false}),base=Math.floor(totalMinor/rows.length),remainder=totalMinor-base*rows.length,digits=currencyExponent(currency);rows.forEach((row,i)=>row.querySelector('[data-split-amount]').value=fromMinor(base+(i<remainder?1:0),currency).toFixed(digits));updateSplitTotal();}catch(error){showToast(error.message);}});
  amountEl.addEventListener('input',updateSplitTotal);
  bindSplitRows();

  const sync=()=>{const t=typeEl.value,adjust=t==='person_adjustment',split=t===SPLIT_ENTRY_TYPE,accountOnly=t==='account_expense'||t==='account_income';form.querySelector('#txnPersonField').style.display=(split||accountOnly)?'none':'grid';personEl.required=!split&&!accountOnly;form.querySelector('#txnAccountField').style.display=(!advancedMode()&&!accountOnly)?'none':(adjust?'none':'grid');form.querySelector('#txnCategoryField').style.display=accountOnly?'grid':'none';form.querySelector('#adjustDirection').style.display=adjust?'grid':'none';splitSection.hidden=!split;if(!adjust&&accEl.value){const a=state.accounts.find(x=>x.id===accEl.value);if(a){curEl.value=a.currency;curEl.disabled=true}}else curEl.disabled=false;if(split)updateSplitTotal();};
  typeEl.addEventListener('change',()=>{fillCategories();sync();});accEl.addEventListener('change',sync);fillCategories();sync();
  const filesEl=form.querySelector('#txnFiles');filesEl.addEventListener('change',()=>{const files=[...(filesEl.files||[])];form.querySelector('#fileSelection').textContent=files.length?files.map(file=>`${file.name} (${Math.max(1,Math.round(file.size/1024))} KB)`).join(' · '):'JPG, PNG, WebP, GIF, PDF or text · max 8 MB each';});
  if(existing) refreshAttachmentPanel(existing.id);

  form.addEventListener('submit',async e=>{
    e.preventDefault();
    const fd=new FormData(form),t=fd.get('type'),split=t===SPLIT_ENTRY_TYPE,accountOnly=t==='account_expense'||t==='account_income',person=fd.get('personId'),amount=Number(fd.get('amount')),files=[...(filesEl.files||[])];
    if(!(amount>0)){showToast('Enter an amount greater than zero.');return}
    if(!split&&!accountOnly&&!person){showToast('Choose a person.');return}
    if((t==='account_expense'||t==='account_income')&&!fd.get('accountId')){showToast('Choose the account or cash used.');return}
    if(files.some(file=>file.size>8*1024*1024)){showToast('Each attachment must be 8 MB or smaller.');return}
    const splits=split?readSplits():[];
    const acc=state.accounts.find(a=>a.id===fd.get('accountId'));
    if(split){const error=validateSplit(splits,amount,acc?.currency||fd.get('currency')||state.settings.defaultCurrency);if(error){showToast(error);return}}
    const item={id:existing?.id||uid('entry'),type:t,personId:(split||accountOnly)?null:person,accountId:t==='person_adjustment'?null:(fd.get('accountId')||null),amount,currency:acc?.currency||fd.get('currency'),date:fd.get('date'),merchant:fd.get('merchant').trim(),description:fd.get('description').trim(),categoryId:accountOnly?(fd.get('categoryId')||null):null,splits:split?splits:[],attachmentCount:existing?.attachmentCount||0,createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    if(t==='person_adjustment') item.signedAmount=(fd.get('direction')==='i_owe'?-1:1)*amount;
    rememberUsed((split||accountOnly)?'':person,item.accountId,t);
    const saved=await runMutation(version=>existing?updateEntry(existing.id,item,version):createEntry(item,version),'');
    if(!saved)return;
    try{
      for(const file of files) await uploadAttachment(item.id,file);
      if(files.length) state=await loadState();
      closeModal();
      render();
      showToast(existing?`Transaction updated${files.length?' with attachments':''}.`:`Transaction added${files.length?' with attachments':''}.`);
    }catch(error){closeModal();showToast(`Transaction saved, but an attachment failed: ${error.message||'upload error'}`);}
  });
}


function openTransferModal(existing=null){
  const fromId=existing?.fromAccountId||state.accounts[0]?.id||''; const toId=existing?.toAccountId||state.accounts.find(a=>a.id!==fromId)?.id||'';
  openModal(existing?'Edit transfer':'Transfer money',`<form id="transferForm" class="form-grid">
    <div class="field"><label>From account</label><select class="select" name="fromAccountId" id="fromAccount" required><option value="">Choose</option>${state.accounts.map(a=>`<option value="${a.id}" ${a.id===fromId?'selected':''}>${escapeHtml(a.name)} · ${a.currency}</option>`).join('')}</select></div>
    <div class="field"><label>To account</label><select class="select" name="toAccountId" id="toAccount" required><option value="">Choose</option>${state.accounts.map(a=>`<option value="${a.id}" ${a.id===toId?'selected':''}>${escapeHtml(a.name)} · ${a.currency}</option>`).join('')}</select></div>
    <div class="field"><label>Amount leaving source</label><input class="input" name="fromAmount" type="number" min="0.000001" step="any" required value="${existing?.fromAmount??existing?.amount??''}" placeholder="0.00"></div>
    <div class="field"><label>Amount arriving destination</label><input class="input" name="toAmount" type="number" min="0.000001" step="any" required value="${existing?.toAmount??existing?.amount??''}" placeholder="0.00"></div>
    <div class="field"><label>Date</label><input class="input" name="date" type="date" required value="${existing?.date||today()}"></div>
    <div class="field"><label>Note</label><input class="input" name="description" maxlength="180" value="${escapeHtml(existing?.description||'')}" placeholder="e.g. ATM withdrawal"></div>
    <div class="field span-2"><div class="warning">For same-currency transfers, enter the same amount twice. For currency exchange, enter the actual amount that left and the actual amount that arrived.</div></div>
  </form>`,()=>document.querySelector('#transferForm').requestSubmit());
  document.querySelector('#transferForm').addEventListener('submit',async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),from=fd.get('fromAccountId'),to=fd.get('toAccountId'),fa=Number(fd.get('fromAmount')),ta=Number(fd.get('toAmount'));
    if(!from||!to||from===to){showToast('Choose two different accounts.');return}
    if(!(fa>0)||!(ta>0)){showToast('Enter both transfer amounts.');return}
    const item={id:existing?.id||uid('entry'),type:'account_transfer',fromAccountId:from,toAccountId:to,fromAmount:fa,toAmount:ta,amount:fa,date:fd.get('date'),description:String(fd.get('description')||'').trim(),merchant:'',splits:[],createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    const saved=await runMutation(version=>existing?updateEntry(existing.id,item,version):createEntry(item,version),existing?'Transfer updated.':'Transfer saved.');
    if(saved)closeModal();
  });
}

function openModal(title,body,onSave=null,showFooter=true){
  closeModal();const back=document.createElement('div');back.className='modal-backdrop';back.innerHTML=`<div class="modal" role="dialog" aria-modal="true"><div class="modal-head"><h3>${title}</h3><button class="icon-btn" id="modalClose" aria-label="Close">×</button></div><div class="modal-body">${body}</div>${showFooter?`<div class="modal-foot"><button class="btn" id="modalCancel">Cancel</button><button class="btn primary" id="modalSave">Save</button></div>`:''}</div>`;document.body.appendChild(back);back.querySelector('#modalClose')?.addEventListener('click',closeModal);back.querySelector('#modalCancel')?.addEventListener('click',closeModal);back.querySelector('#modalSave')?.addEventListener('click',()=>onSave?.());back.addEventListener('click',e=>{if(e.target===back)closeModal()});
}
function closeModal(){document.querySelector('.modal-backdrop')?.remove()}

async function deleteEntry(id){const e=state.entries.find(x=>x.id===id);if(!e)return;if(confirm('Delete this transaction? Balances will recalculate immediately.')){const saved=await runMutation(version=>removeEntry(id,version),'Transaction deleted.');if(saved)closeModal();}}
async function deletePerson(id){const linked=state.entries.some(e=>entryTouchesPerson(e,id));if(linked){showToast('Delete this person’s transactions first.');return}if(confirm('Delete this person?')){const saved=await runMutation(version=>removePerson(id,version),'Person deleted.');if(saved){closeModal();location.hash='#people';}}}
async function deleteAccount(id){const linked=state.entries.some(e=>e.accountId===id||e.fromAccountId===id||e.toAccountId===id);if(linked){showToast('Delete or move this account’s transactions first.');return}if(confirm('Delete this account?')){const saved=await runMutation(version=>removeAccount(id,version),'Account deleted.');if(saved)closeModal();}}

function currencyOptions(selected){return CURRENCIES.map(c=>`<option value="${c}" ${selected===c?'selected':''}>${c}</option>`).join('')}
function entryTypeOptions(selected,includeTransfer=true){
  const debtTypes=[['paid_for_person','They owe me'],['received_from_person','They paid me'],['borrowed_from_person','I owe them'],['paid_to_person','I paid them'],[SPLIT_ENTRY_TYPE,'Split between people'],['person_adjustment','Balance adjustment']];
  const advanced=[['account_expense','Account expense'],['account_income','Account income']];
  let types=advancedMode()?[...debtTypes,...advanced]:[...debtTypes];
  if(advancedMode()&&includeTransfer)types.push(['account_transfer','Account transfer']);
  if(selected&&!types.some(([v])=>v===selected)){
    const fallback=[...advanced,['account_transfer','Account transfer']].find(([v])=>v===selected);
    if(fallback)types.push(fallback);
  }
  return types.map(([v,l])=>`<option value="${v}" ${selected===v?'selected':''}>${l}</option>`).join('');
}

async function showAuth(message=''){
  let registrationOpen=false;
  try{registrationOpen=Boolean((await registrationStatus()).registrationOpen);}catch{}
  renderAuth(message,registrationOpen);
}

function renderAuth(message='',registrationOpen=false) {
  app.innerHTML=`<div class="auth-shell"><div class="auth-card card"><div class="auth-brand"><div class="brand-mark">M</div><div><h1>Money Owed Tracker</h1><p>Track money people owe you and money you owe.</p></div></div>${message?`<div class="auth-message">${escapeHtml(message)}</div>`:''}${registrationOpen?`<div class="auth-tabs"><button class="active" data-auth-tab="login">Sign in</button><button data-auth-tab="register">Create account</button></div>`:'<div class="auth-tabs"><button class="active">Sign in</button></div>'}<form id="authForm" class="auth-form"><div class="field"><label>Email</label><input class="input" name="email" type="email" autocomplete="email" required></div><div class="field"><label>Password</label><input class="input" name="password" type="password" autocomplete="current-password" minlength="10" required></div><button class="btn primary full" type="submit">Sign in</button><p class="auth-hint">${registrationOpen?'Create the owner account once. After that, extra accounts can only be added from Settings.':'Additional accounts can only be created by the owner from Settings.'}</p></form></div></div>`;
  let mode='login'; const form=app.querySelector('#authForm');
  app.querySelectorAll('[data-auth-tab]').forEach(btn=>btn.addEventListener('click',()=>{mode=btn.dataset.authTab||'login';app.querySelectorAll('[data-auth-tab]').forEach(b=>b.classList.toggle('active',b===btn));form.querySelector('button[type=submit]').textContent=mode==='register'?'Create account':'Sign in';form.password.autocomplete=mode==='register'?'new-password':'current-password';}));
  form.addEventListener('submit',async e=>{e.preventDefault();const fd=new FormData(form),button=form.querySelector('button[type=submit]');button.disabled=true;button.textContent=mode==='register'?'Creating…':'Signing in…';try{user=mode==='register'?await register(fd.get('email'),fd.get('password')):await login(fd.get('email'),fd.get('password'));state=await loadState();location.hash='#dashboard';render();}catch(error){showAuth(error.message||'Could not sign in.');}finally{button.disabled=false;}});
}

async function boot(){
  app.innerHTML='<div class="boot">Loading Money Tracker…</div>';
  try{user=await currentUser();if(!user){await showAuth();return;}state=await loadState();render();}catch(error){showAuth(error.message||'Could not load Money Tracker.');}
}

document.addEventListener('keydown',event=>{
  if(!state)return;
  if(event.defaultPrevented||event.ctrlKey||event.metaKey||event.altKey)return;
  const target=event.target;
  if(target?.matches?.('input,textarea,select,[contenteditable="true"]'))return;
  if(document.querySelector('.modal-backdrop'))return;
  if(event.key.toLowerCase()==='n'){event.preventDefault();openQuickMenu();}
  if(advancedMode()&&event.key.toLowerCase()==='t'){event.preventDefault();openTransferModal();}
});

if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(()=>{}));}
boot();
