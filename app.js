import { icon, mobilePages, recentDebtEntries, activityMarkup, peopleOverviewMarkup } from './lib/dashboard-ui.js';
import { currentUser, registrationStatus, login, register, listUsers, createUserAccount, resetUserPassword, deleteUserAccount, changePassword, revokeOtherSessions, listSessions, revokeSession, listSecurityEvents, runtimeStatus, createServerSnapshot, deleteMyAccount, logout, loadState, updateSettings, createPerson, updatePerson, removePerson, createAccount, updateAccount, removeAccount, createEntry, updateEntry, removeEntry, exportFullBackup, restoreFullBackup, resetState, listAttachments, uploadAttachment, deleteAttachment, attachmentUrl, uid, getSyncStatus, syncPendingOperations, discardPendingChangesAndReload } from './lib/store.js';
import { personBalances, accountBalances, totalsFromBalances, personDelta, accountDelta, runningStatement, PERSON_ENTRY_TYPES, entryTouchesPerson, SPLIT_ENTRY_TYPE, validateSplit } from './lib/ledger.js';
import { CURRENCIES, money, today, dateInTimeZone, escapeHtml, downloadText, balancesText, prettyType } from './lib/utils.js';
import { currencyExponent, fromMinor, sumMinor, toMinor } from './lib/money.js';
import { renderReports, exportPersonPdf } from './lib/reports-ui.js';
import { filterTransactionList, dateRangeForPreset } from './lib/reporting.js';
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
let routeFocusPending = false;
let modalReturnFocus = null;
let modalSequence = 0;
let a11yFieldSequence = 0;
let pwa = {online:navigator.onLine,installable:false,installed:false,updateWaiting:false};
let syncInfo = {pending:0,failed:0,conflicts:0,online:navigator.onLine};

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
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',effective==='dark'?'#0e191d':'#f5f7f8');
}
function saveThemePreference(preference){
  const value=['system','light','dark'].includes(preference)?preference:'system';
  try{localStorage.setItem(THEME_KEY,value);}catch{}
  applyTheme(value);
}
applyTheme();
themeMedia?.addEventListener?.('change',()=>{if(themePreference()==='system')applyTheme('system');});
window.addEventListener('moneytracker:pwa',event=>{pwa=event.detail||pwa;if(state)render();});
window.addEventListener('moneytracker:sync',event=>{
  const detail=event.detail||{};
  syncInfo={...syncInfo,...detail};
  if(detail.state)state=detail.state;
  if(Number(detail.reopenedFeedItems)>0)showToast('Bank Feed row reopened - the posted amount no longer matches this transaction.');
  if(state)render();
});
window.addEventListener('moneytracker:state-replaced',event=>{if(event.detail){state=event.detail;if(user)render();}});

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [page, query=''] = raw.split('?');
  return { page, params: new URLSearchParams(query) };
}

window.addEventListener('hashchange', () => { closeAllEntryMenus(); route = parseRoute(); routeFocusPending=true; if (state) render(); });
document.querySelector('.skip-link')?.addEventListener('click',event=>{
  event.preventDefault();
  const main=document.querySelector('#main');
  if(!main)return;
  main.focus({preventScroll:true});
  main.scrollIntoView({block:'start'});
});

async function runMutation(action,message='') {
  if (saving) { showToast('Saving the previous change…'); return false; }
  saving = true;
  try {
    state = await action(state.version);
    syncInfo = await getSyncStatus().catch(()=>syncInfo);
    if (Number(state?.reopenedFeedItems)>0) showToast('Bank Feed row reopened - the posted amount no longer matches this transaction.');
    else if (syncInfo.conflicts||syncInfo.failed) showToast('Saved on this device, but sync needs attention.');
    else if (!navigator.onLine&&syncInfo.pending) showToast(`Saved offline · ${syncInfo.pending} change${syncInfo.pending===1?'':'s'} queued.`);
    else if (message) showToast(message);
    render();
    return true;
  } catch (error) {
    if (error.status === 409) {
      state = await loadState();
      syncInfo = await getSyncStatus().catch(()=>syncInfo);
      render();
      showToast('Another tab changed the data. I reloaded the latest safe version.');
    } else if (error.status === 401) {
      user = null; state = null; showAuth('Your session expired. Sign in again. Unsynced device changes were preserved.');
    } else { showToast(error.message || 'Could not save.'); }
    return false;
  } finally { saving = false; }
}

function showToast(message) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role','status');
  el.setAttribute('aria-live','polite');
  el.setAttribute('aria-atomic','true');
  el.textContent = message;
  document.body.appendChild(el);
  toastTimer = setTimeout(() => el.remove(), 2600);
}

function wireFieldLabels(root=document){
  root.querySelectorAll?.('.field').forEach(field=>{
    const label=field.querySelector('label'),control=field.querySelector('input,select,textarea');
    if(!label||!control)return;
    if(!control.id)control.id='mot-field-'+(++a11yFieldSequence);
    if(!label.htmlFor)label.htmlFor=control.id;
  });
}

function iconFor(page) {
  return icon(page);
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

function renderOfflineServerFeature(main,title,detail){
  main.innerHTML=`<section class="card panel"><div class="empty"><strong>${escapeHtml(title)} needs a connection</strong>${escapeHtml(detail)}<div class="muted tiny" style="margin-top:8px">Your cached ledger remains available in Dashboard, People, Accounts, Activity, Insights and Reports.</div></div></section>`;
}

function connectionStatusText(){
  const pending=Number(syncInfo?.pending||0),issues=Number(syncInfo?.failed||0)+Number(syncInfo?.conflicts||0);
  if(!pwa.online)return pending?`● Offline · ${pending} queued`:'● Offline · changes save locally';
  if(issues)return `● Sync issue · ${pending} queued`;
  if(pending)return `● Syncing · ${pending} queued`;
  return '● Online · synced';
}
function connectionStatusClass(){
  return !pwa.online||syncInfo?.failed||syncInfo?.conflicts?'offline':'online';
}

function render() {
  closeAllEntryMenus();
  const hiddenInSimpleMode=['accounts','bank','insights','scheduled'];
  const advanced=advancedMode();
  if(!advanced && hiddenInSimpleMode.includes(route.page)){location.hash='#dashboard';return;}
  const navPage = route.page === 'person' ? 'people' : route.page;
  const visiblePages=advanced?['dashboard','people','accounts','transactions','bank','insights','scheduled','reports','settings']:['dashboard','people','transactions','reports','settings'];
  const mobileNavPages=mobilePages(advanced);
  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark">${icon('insights')}</div><div><h1>Money Tracker</h1><small>A little more clarity.</small></div></div>
        <div class="nav-caption">WORKSPACE</div><nav class="nav" aria-label="Primary navigation">${visiblePages.map(p => `<button data-nav="${p}" class="${navPage===p?'active':''}"${navPage===p?' aria-current="page"':''}><span class="nav-icon">${iconFor(p)}</span>${titleFor(p)}</button>`).join('')}</nav>
        <div class="sidebar-foot"><span class="mode-label">${advanced?'Advanced workspace':'Simple workspace'}</span><strong>${escapeHtml(user?.email || '')}</strong><button class="sidebar-logout" id="logoutBtn">Sign out</button></div>
      </aside>
      <section class="content">
        <header class="topbar">
          <div class="topbar-title"><h2 id="pageHeading" tabindex="-1">${titleFor(route.page)}</h2><p>${subFor(route.page)}</p></div>
          <div class="top-actions"><span class="connection-pill ${connectionStatusClass()}" role="status" aria-live="polite">${connectionStatusText()}</span>${pwa.updateWaiting?'<button class="btn" id="applyUpdate">Update app</button>':''}${advanced?`<button class="btn" id="quickTransfer">⇄ Transfer</button>`:''}<button class="btn primary" id="quickEntry">${icon('plus')} Add activity</button></div>
        </header>
        <main class="main" id="main" aria-labelledby="pageHeading" tabindex="-1"></main>
      </section>
      <nav class="mobile-nav" aria-label="Mobile navigation">${mobileNavPages.map(p => `<button data-nav="${p}" class="${navPage===p?'active':''}"${navPage===p?' aria-current="page"':''}><span>${iconFor(p)}</span>${p==='dashboard'?'Home':p==='transactions'?'Activity':p==='reports'?'Reports':titleFor(p).split(' ')[0]}</button>`).join('')}${advanced?`<button id="mobileMore" class="${!mobileNavPages.includes(navPage)?'active':''}" aria-label="More navigation" aria-haspopup="dialog"><span>${icon('more')}</span>More</button>`:''}</nav>
    </div>`;

  document.querySelectorAll('[data-nav]').forEach(btn => btn.addEventListener('click', () => location.hash = `#${btn.dataset.nav}`));
  document.querySelector('#mobileMore')?.addEventListener('click',()=>{
    const pages=visiblePages.filter(p=>!mobileNavPages.includes(p));
    openModal('Your workspace',`<nav class="more-nav" aria-label="More navigation">${pages.map(p=>`<button class="btn ${navPage===p?'selected':''}" data-more-nav="${p}"${navPage===p?' aria-current="page"':''}>${iconFor(p)}${titleFor(p)}${icon('arrow')}</button>`).join('')}</nav>`,null,false);
    document.querySelectorAll('[data-more-nav]').forEach(button=>button.addEventListener('click',()=>{closeModal();location.hash=`#${button.dataset.moreNav}`;}));
  });
  document.querySelector('#applyUpdate')?.addEventListener('click',()=>{if(activatePwaUpdate())showToast('Updating Money Tracker…');});
  document.querySelector('#quickEntry')?.addEventListener('click', () => openQuickMenu());
  document.querySelector('#quickTransfer')?.addEventListener('click', () => openTransferModal());
  document.querySelector('#logoutBtn')?.addEventListener('click', async () => { try { await logout(); user=null; state=null; showAuth(); } catch(error) { showToast(error.message||'Could not sign out.'); } });

  const main = document.querySelector('#main');
  if (route.page === 'dashboard') renderDashboard(main);
  else if (route.page === 'people') renderPeople(main);
  else if (route.page === 'accounts') renderAccounts(main);
  else if (route.page === 'transactions') renderTransactions(main);
  else if (route.page === 'bank') pwa.online?renderBankFeedPage(main,state,{showToast,replaceState(next){state=next;render();}}):renderOfflineServerFeature(main,'Bank Feed','Bank Feed remains server-only while core ledger changes can now be saved offline and synced later.');
  else if (route.page === 'insights') renderInsightsPage(main,state,route,{openModal,closeModal,showToast,replaceState(next){state=next;render();}});
  else if (route.page === 'scheduled') pwa.online?renderRecurringPage(main,state,{openModal,closeModal,showToast,replaceState(next){state=next;render();}}):renderOfflineServerFeature(main,'Scheduled & Reminders','Recurring rules and reminder inboxes remain server-only while core ledger changes can sync offline.');
  else if (route.page === 'reports') renderReports(main,state,route,{money,escapeHtml,today});
  else if (route.page === 'settings') renderSettings(main);
  else if (route.page === 'person') renderPerson(main, route.params.get('id'));
  else { location.hash = '#dashboard'; }
  wireFieldLabels(main);
  if(routeFocusPending){
    routeFocusPending=false;
    requestAnimationFrame(()=>document.querySelector('#pageHeading')?.focus());
  }
}

function currencyTotalsMarkup(totals, key, fallback='0') {
  const rows = Object.entries(totals).filter(([,v]) => Math.abs(v[key] || 0) > 0.000001);
  if (!rows.length) return `<span>${fallback}</span>`;
  return `<div class="currency-lines">${rows.map(([c,v]) => `<div>${money(v[key],c)}</div>`).join('')}</div>`;
}

function renderDashboard(main) {
  const pBalances = personBalances(state.entries, state.people);
  const totals = totalsFromBalances(pBalances);
  const recent = recentDebtEntries(state.entries);
  const overview = peopleOverviewMarkup(state.people, pBalances);
  const dateLabel = new Intl.DateTimeFormat(undefined, {weekday:'long', month:'long', day:'numeric'}).format(new Date());
  main.innerHTML = `<div class="dashboard">
    <div class="dashboard-intro"><div><div class="eyebrow">YOUR MONEY, AT A GLANCE</div><h2>A clearer picture.</h2><p>Keep track of what’s owed. Make room for what’s next.</p></div><div class="dashboard-date">${icon('scheduled')}<span>${escapeHtml(dateLabel)}</span></div></div>
    <div class="grid stats debt-stats">
      <section class="card stat good"><div class="stat-top"><h3 class="stat-label">People owe me</h3><div class="stat-icon">${icon('up')}</div></div><div class="stat-value">${currencyTotalsMarkup(totals,'owedToMe',money(0,state.settings.defaultCurrency))}</div><div class="stat-note"><span class="stat-dot"></span>Money to receive</div></section>
      <section class="card stat bad"><div class="stat-top"><h3 class="stat-label">I owe people</h3><div class="stat-icon">${icon('down')}</div></div><div class="stat-value">${currencyTotalsMarkup(totals,'iOwe',money(0,state.settings.defaultCurrency))}</div><div class="stat-note"><span class="stat-dot"></span>Money to pay back</div></section>
      <section class="card stat net"><div class="stat-top"><h3 class="stat-label">Net position</h3><div class="stat-icon">${icon('net')}</div></div><div class="stat-value">${currencyTotalsMarkup(totals,'net',money(0,state.settings.defaultCurrency))}</div><div class="stat-note">Owed to you minus what you owe</div></section>
    </div>
    <div class="dashboard-columns${advancedMode()?'':' single-column'}">
      <div class="dashboard-primary">
        <section class="card panel activity-panel">
          <div class="panel-head"><div><h3>Recent activity</h3><p>The latest in your money story</p></div><a class="text-link" href="#transactions">View all ${icon('arrow')}</a></div>
          ${recent.length ? activityMarkup(recent,state.people) : `<div class="dashboard-empty"><span class="empty-icon">${icon('transactions')}</span><h4>A fresh start for your finances</h4><p>Your debts and repayments will show up here.<br>${state.people.length?'Record your first debt or repayment to get started.':'Start with someone you exchange money with.'}</p><button class="btn primary" data-action="${state.people.length?'activity':'person'}">${icon('plus')} ${state.people.length?'Add activity':'Add your first person'}</button></div>`}
          ${recent.length ? '<a class="activity-footer" href="#transactions">See all transactions '+icon('arrow')+'</a>' : ''}
        </section>
        <section class="card panel people-overview"><div class="panel-head"><div><h3>People & balances <span class="count-badge">${overview.count}</span></h3><p>Outstanding balances, by person</p></div><a class="text-link" href="#people">All people ${icon('arrow')}</a></div>${overview.markup || `<div class="people-empty">${icon('check')}<div><strong>${state.people.length?'You’re all settled up.':'Good records start with people.'}</strong><p>${state.people.length?'No outstanding balances right now.':'Add a person to keep every balance in one place.'}</p></div></div>`}</section>
      </div>
      ${advancedMode()?`<div class="dashboard-secondary">
        <section class="card panel" id="dashboardRecurring"></section>
        <section class="card panel" id="dashboardBudgets"></section>
        <section class="workspace-note"><span class="note-icon">${icon('insights')}</span><h3>The bigger picture</h3><p>Explore your spending, categories and monthly budgets.</p><a class="text-link" href="#insights">Open insights ${icon('arrow')}</a></section>
      </div>`:''}
    </div>
    <div class="dashboard-caption">${icon('check')} Your balances, all in one place. <span>${advancedMode()?'Advanced':'Simple'} workspace</span></div>
  </div>`;
  if(advancedMode()){
    const ctx={showToast,replaceState(next){state=next;render();}};
    mountRecurringDashboardWidget(main.querySelector('#dashboardRecurring'),state,ctx);
    mountBudgetDashboardWidget(main.querySelector('#dashboardBudgets'),state);
  }
  main.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => {
    const a=b.dataset.action;
    if (a==='person') openPersonModal(); else if(a==='activity') openQuickMenu(); else openTransactionModal(null,{type:a});
  }));
  main.querySelectorAll('[data-dashboard-entry]').forEach(b=>b.addEventListener('click',()=>openTransactionModal(state.entries.find(e=>e.id===b.dataset.dashboardEntry))));
}

function renderPeople(main) {
  const balances = personBalances(state.entries,state.people);
  const query = (route.params.get('q')||'').toLowerCase();
  const people = [...state.people].filter(p => !query || `${p.name} ${p.note||''}`.toLowerCase().includes(query)).sort((a,b)=>a.name.localeCompare(b.name));
  main.innerHTML = `
    <section class="people-page" aria-label="People">
      <div class="people-toolbar">
        <div class="people-search-wrap"><input id="peopleSearch" class="input search people-search" type="search" inputmode="search" autocomplete="off" aria-label="Search people" placeholder="Search people…" value="${escapeHtml(route.params.get('q')||'')}"></div>
        <div class="people-toolbar-actions"><button class="btn people-import-btn" id="peopleImport" type="button" aria-label="Import people and statement data" title="Import people and statement data">•••</button><button class="btn primary people-add-btn" id="addPerson" type="button" aria-label="Add person">${icon('plus')}<span>Add person</span></button></div>
      </div>
      ${people.length ? `<div class="people-grid">${people.map(p=>personCard(p,balances[p.id]||{})).join('')}</div>` : `<div class="card hero-empty empty"><div class="big">👥</div><h3>${query?'No matching people':'Add the people you exchange money with'}</h3><p>Each person gets a separate running statement. Positive means they owe you. Negative means you owe them.</p><button class="btn primary" id="emptyAddPerson">＋ Add person</button></div>`}
    </section>`;
  main.querySelector('#addPerson')?.addEventListener('click',()=>openPersonModal());
  main.querySelector('#peopleImport')?.addEventListener('click',()=>{
    openModal('Import people & statements',`<div class="quick-menu"><button class="quick" id="peoplePasteExcel"><span class="qicon">▦</span><strong>Paste Excel rows</strong><small>Fast entry for person statement rows</small></button><button class="quick" id="peopleImportFile"><span class="qicon">↑</span><strong>Import Excel / CSV</strong><small>Preview and map a spreadsheet file</small></button></div>`,null,false);
    document.querySelector('#peoplePasteExcel')?.addEventListener('click',()=>{closeModal();window.dispatchEvent(new CustomEvent('moneytracker:open-quick-import'));});
    document.querySelector('#peopleImportFile')?.addEventListener('click',()=>{closeModal();window.dispatchEvent(new CustomEvent('moneytracker:open-import'));});
  });
  main.querySelector('#emptyAddPerson')?.addEventListener('click',()=>openPersonModal());
  main.querySelector('#peopleSearch')?.addEventListener('input', e => {
    const q=e.target.value.trim(); location.hash = q ? `#people?q=${encodeURIComponent(q)}` : '#people';
  });
  main.querySelectorAll('[data-person]').forEach(c=>c.addEventListener('click',()=>location.hash=`#person?id=${c.dataset.person}`));
}

function personCard(p,balance) {
  const values=Object.values(balance);
  const netSign=values.reduce((a,b)=>a+b,0);
  const note=p.note||'Personal statement';
  const noteClass=p.note?'person-card-note':'person-card-note person-default-note';
  return `<a class="card person-card" data-person="${p.id}" href="#person?id=${encodeURIComponent(p.id)}" aria-label="View statement for ${escapeHtml(p.name)}"><div class="person-card-main"><div class="avatar">${escapeHtml(p.name.slice(0,2).toUpperCase())}</div><div class="person-card-copy"><h3>${escapeHtml(p.name)}</h3><p class="${noteClass}">${escapeHtml(note)}</p></div></div><div class="person-card-balance"><div class="balance ${netSign>0?'positive':netSign<0?'negative':''}">${balancesText(balance)}</div><span class="person-card-arrow" aria-hidden="true">${icon('arrow')}</span></div></a>`;
}

function statementDate(value){
  const v=String(value||'');
  const d=new Date(/^\d{4}-\d{2}-\d{2}$/.test(v)?`${v}T00:00:00`:v);
  if(Number.isNaN(d.getTime()))return escapeHtml(v);
  return escapeHtml(new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric'}).format(d));
}

function entryMenuMarkup(entryId) {
  return `<div class="entry-menu-wrap" data-entry-menu>
    <button class="entry-menu-trigger icon-btn" type="button" aria-label="Transaction actions" aria-haspopup="true" aria-expanded="false" data-menu-trigger="${entryId}" title="Transaction actions">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="12" cy="5" r="2.2"></circle>
        <circle cx="12" cy="12" r="2.2"></circle>
        <circle cx="12" cy="19" r="2.2"></circle>
      </svg>
    </button>
    <div class="entry-menu-popover" data-menu-popover="${entryId}" hidden role="menu" aria-label="Transaction actions">
      <button type="button" class="entry-menu-item" role="menuitem" data-edit-entry="${entryId}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        <span>Edit</span>
      </button>
      <button type="button" class="entry-menu-item danger" role="menuitem" data-delete-entry="${entryId}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        <span>Delete</span>
      </button>
    </div>
  </div>`;
}

function statementNotesMarkup(e) {
  const desc = (e.description || '').trim();
  const merchant = (e.merchant || '').trim();
  const category = state.categories?.find(x => x.id === e.categoryId);
  let html = '';
  if (desc) {
    html += `<div class="statement-desc"><strong>${escapeHtml(desc)}</strong></div>`;
    if (merchant) {
      html += `<div class="statement-merchant muted tiny">${escapeHtml(merchant)}</div>`;
    }
  } else if (merchant) {
    html += `<div class="statement-merchant statement-desc"><strong>${escapeHtml(merchant)}</strong></div>`;
  }
  if (category) {
    html += `<div class="statement-category-tag attachment-count">${escapeHtml((category.icon ? category.icon + ' ' : '') + category.name)}</div>`;
  }
  if (e.attachmentCount) {
    html += `<div class="statement-attachment-tag attachment-count">📎 ${e.attachmentCount}</div>`;
  }
  return html;
}

function statementTypePill(type, delta) {
  let color = '';
  let icon = '';
  if (type === 'paid_for_person') { color = 'green'; icon = '↗'; }
  else if (type === 'split_paid_for_people') { color = 'green'; icon = '👥'; }
  else if (type === 'received_from_person') { color = 'blue'; icon = '💵'; }
  else if (type === 'borrowed_from_person') { color = 'red'; icon = '↘'; }
  else if (type === 'paid_to_person') { color = 'amber'; icon = '✅'; }
  else if (type === 'person_adjustment') {
    color = delta >= 0 ? 'green' : 'red';
    icon = '±';
  }
  return `<span class="pill ${color} statement-type-pill"><span class="pill-icon" aria-hidden="true">${icon}</span><span>${escapeHtml(prettyType(type))}</span></span>`;
}

function renderPerson(main, personId) {
  const person = state.people.find(p => p.id === personId);
  if (!person) { main.innerHTML = '<div class="empty">Person not found.</div>'; return; }
  const balances = personBalances(state.entries, state.people)[person.id] || {};
  const personEntries = runningStatement(state.entries, person.id).sort((a,b) => new Date(b.date) - new Date(a.date) || new Date(b.createdAt) - new Date(a.createdAt));

  const balanceEntries = Object.entries(balances).filter(([c, v]) => {
    try { return toMinor(v, c) !== 0; } catch { return Number(v) !== 0; }
  });
  const defaultCurrency = state.settings?.defaultCurrency || 'USD';
  const primaryCurrency = balanceEntries.length ? balanceEntries[0][0] : defaultCurrency;
  const primaryVal = balances[primaryCurrency] ?? 0;

  let heroClass = 'settled';
  let heroBadgeText = 'Settled';
  let heroBadgeClass = '';
  let heroAmount = money(0, primaryCurrency);
  let heroExplanation = `All transactions with ${escapeHtml(person.name)} are currently settled.`;

  if (balanceEntries.length === 1) {
    if (primaryVal > 0) {
      heroClass = 'positive';
      heroBadgeText = 'Owes you';
      heroBadgeClass = 'green';
      heroAmount = `+${money(primaryVal, primaryCurrency)}`;
      heroExplanation = `${escapeHtml(person.name)} owes you ${money(primaryVal, primaryCurrency)}.`;
    } else if (primaryVal < 0) {
      heroClass = 'negative';
      heroBadgeText = 'You owe';
      heroBadgeClass = 'red';
      heroAmount = `-${money(Math.abs(primaryVal), primaryCurrency)}`;
      heroExplanation = `You owe ${escapeHtml(person.name)} ${money(Math.abs(primaryVal), primaryCurrency)}.`;
    }
  } else if (balanceEntries.length > 1) {
    heroClass = 'settled';
    heroBadgeText = 'Multiple currencies';
    heroBadgeClass = '';
    heroAmount = `${balanceEntries.length} currencies`;
    heroExplanation = `Balances with ${escapeHtml(person.name)} are kept separate by currency.`;
  }

  const multiCurrencyHtml = balanceEntries.length > 1 ? `
    <div class="statement-currency-chips">
      ${balanceEntries.map(([c, v]) => `<span class="pill ${v > 0 ? 'green' : v < 0 ? 'red' : ''}">${v > 0 ? 'Owes you' : 'You owe'} · ${money(Math.abs(v), c)}</span>`).join('')}
    </div>` : '';

  const totalTransactions = personEntries.length;
  const lastActiveDate = personEntries[0] ? personEntries[0].date : 'No activity';

  main.innerHTML = `
    <div class="statement-nav">
      <a class="statement-back-link" href="#people">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
        <span>Back to People</span>
      </a>
    </div>

    <div class="detail-header statement-header">
      <div class="detail-title statement-person-title">
        <div class="avatar statement-avatar">${escapeHtml(person.name.slice(0,2).toUpperCase())}</div>
        <div class="statement-person-info">
          <div class="statement-name-badge">
            <h2>${escapeHtml(person.name)}</h2>
            <span class="pill ${heroBadgeClass}">${heroBadgeText}</span>
          </div>
          <p class="statement-person-note">${escapeHtml(person.note || 'Personal statement & running balance')}</p>
        </div>
      </div>
      <div class="page-actions statement-header-actions">
        <button class="btn" id="personPdf" title="Export PDF statement">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span>PDF statement</span>
        </button>
        <button class="btn" id="editPerson" title="Edit person">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          <span>Edit</span>
        </button>
        <button class="btn primary" id="personTxn" title="Add transaction with this person">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          <span>Add transaction</span>
        </button>
      </div>
    </div>

    <div class="card statement-hero-card">
      <div class="statement-hero-main">
        <div class="statement-hero-label">Current Statement Balance</div>
        <div class="statement-hero-balance ${heroClass}">
          <span class="statement-balance-amount">${heroAmount}</span>
          <span class="pill ${heroBadgeClass}">${heroBadgeText}</span>
        </div>
        <p class="statement-hero-desc">${heroExplanation}</p>
        ${multiCurrencyHtml}
      </div>
      <div class="statement-hero-stats">
        <div class="statement-stat-box">
          <span class="statement-stat-label">Transactions</span>
          <span class="statement-stat-value">${totalTransactions}</span>
        </div>
        <div class="statement-stat-box">
          <span class="statement-stat-label">Last activity</span>
          <span class="statement-stat-value">${lastActiveDate}</span>
        </div>
      </div>
    </div>

    <section class="card panel statement-panel">
      <div class="panel-head statement-panel-head">
        <div class="statement-panel-title-area">
          <div class="statement-title-wrap">
            <h3>Statement Ledger</h3>
            <span class="pill statement-count-pill">${totalTransactions}</span>
          </div>
          <p class="muted">Chronological ledger with real-time running balance. Positive (+) increases what they owe.</p>
        </div>
        ${totalTransactions > 1 ? `
        <div class="statement-filter-bar">
          <div class="statement-search-wrap">
            <svg class="search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="search" id="statementSearch" class="input statement-search-input" placeholder="Filter statement…" aria-label="Filter statement entries">
          </div>
        </div>` : ''}
      </div>
      <div id="statementContent">
        ${personEntries.length ? statementTable(personEntries) : `<div class="empty statement-empty"><strong>No statement entries yet</strong>Record the first purchase, repayment, borrowing or opening balance for ${escapeHtml(person.name)}.<div style="margin-top:14px"><button class="btn primary" id="emptyPersonTxn">＋ Add transaction</button></div></div>`}
      </div>
    </section>`;

  const bindActions = (container) => {
    container.querySelectorAll('[data-edit-entry]').forEach(b => b.addEventListener('click', () => openTransactionModal(state.entries.find(e => e.id === b.dataset.editEntry))));
    container.querySelectorAll('[data-delete-entry]').forEach(b => b.addEventListener('click', () => deleteEntry(b.dataset.deleteEntry)));
  };

  main.querySelector('#personTxn')?.addEventListener('click', () => openTransactionModal(null, { personId: person.id }));
  main.querySelector('#emptyPersonTxn')?.addEventListener('click', () => openTransactionModal(null, { personId: person.id }));
  main.querySelector('#personPdf')?.addEventListener('click', () => exportPersonPdf(state, person, today));
  main.querySelector('#editPerson')?.addEventListener('click', () => openPersonModal(person));
  bindActions(main);

  const searchInput = main.querySelector('#statementSearch');
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      const q = e.target.value.toLowerCase().trim();
      const filtered = q ? personEntries.filter(entry => {
        const text = `${entry.description || ''} ${entry.merchant || ''} ${entry.date || ''} ${prettyType(entry.type) || ''}`.toLowerCase();
        return text.includes(q);
      }) : personEntries;
      const content = main.querySelector('#statementContent');
      if (content) {
        content.innerHTML = filtered.length ? statementTable(filtered) : `<div class="empty"><strong>No matching transactions</strong>No statement records matching “${escapeHtml(q)}”.</div>`;
        bindActions(content);
      }
    });
  }
}

function statementTable(entries){
  return `<div class="table-wrap mobile-ledger-table statement-table-wrap"><table class="table statement-table"><thead><tr><th>Date</th><th>Type</th><th>Notes & details</th><th class="right">Change</th><th class="right">Running balance</th><th class="right statement-actions-head"></th></tr></thead><tbody>${entries.map(e=>{
    const d = Number.isFinite(e.delta) ? e.delta : personDelta(e, e.personId);
    const c = e.currency || 'USD';
    return `<tr>
      <td data-label="Date" class="statement-date-cell"><time datetime="${escapeHtml(e.date)}">${statementDate(e.date)}</time></td>
      <td data-label="Type" class="statement-type-cell">${statementTypePill(e.type, d)}</td>
      <td data-label="Notes" class="statement-notes-cell">${statementNotesMarkup(e)}</td>
      <td data-label="Change" class="right statement-change-cell ${d >= 0 ? 'amount-pos' : 'amount-neg'}"><span class="statement-change-value">${d >= 0 ? '+' : ''}${money(d, c)}</span></td>
      <td data-label="Running balance" class="right strong statement-running-cell"><span class="statement-running-value">${money(e.running || 0, c)}</span></td>
      <td class="actions statement-actions-cell">${entryMenuMarkup(e.id)}</td>
    </tr>`;
  }).join('')}</tbody></table></div>`;
}

function renderAccounts(main) {
  const balances=accountBalances(state.entries,state.accounts);
  main.innerHTML=`<div class="panel-head"><div><p class="muted">Opening balance + all linked money movements.</p></div><div class="page-actions"><button class="btn" id="transferBtn">⇄ Transfer</button><button class="btn primary" id="addAccount">＋ Add account</button></div></div>
  ${state.accounts.length?`<div class="accounts-grid">${state.accounts.map(a=>`<div class="card account-card" data-account="${a.id}" role="button" tabindex="0"><div class="account-top"><div><h3>${escapeHtml(a.name)}</h3><p>${escapeHtml(a.type)} · ${escapeHtml(a.currency)}</p></div><span class="pill">${a.type==='cash'?'Cash':'Account'}</span></div><div class="balance ${balances[a.id]<0?'negative':''}">${money(balances[a.id]||0,a.currency)}</div><div class="muted tiny">Opening: ${money(a.openingBalance||0,a.currency)}</div></div>`).join('')}</div>`:`<div class="card hero-empty empty"><div class="big">🏦</div><h3>Add your bank accounts and cash</h3><p>When you pay for someone, receive money, borrow, repay or transfer funds, the linked account balance updates automatically.</p><button class="btn primary" id="emptyAddAccount">＋ Add account</button></div>`}`;
  main.querySelector('#addAccount')?.addEventListener('click',()=>openAccountModal());
  main.querySelector('#emptyAddAccount')?.addEventListener('click',()=>openAccountModal());
  main.querySelector('#transferBtn')?.addEventListener('click',()=>openTransferModal());
  main.querySelectorAll('[data-account]').forEach(c=>{
    const open=()=>openAccountDetail(c.dataset.account);
    c.addEventListener('click',open);
    c.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
  });
}

function openAccountDetail(accountId){
  const a=state.accounts.find(x=>x.id===accountId); if(!a)return;
  const balances=accountBalances(state.entries,state.accounts);
  const entries=state.entries.filter(e=>e.accountId===a.id||e.fromAccountId===a.id||e.toAccountId===a.id).sort((x,y)=>new Date(y.date)-new Date(x.date)||new Date(y.createdAt)-new Date(x.createdAt));
  openModal(`${a.name} · ${money(balances[a.id]||0,a.currency)}`, `${entries.length?transactionTable(entries,{compact:true}):'<div class="empty">No activity yet.</div>'}<div class="account-detail-actions"><button class="btn" id="modalAdjustAccount">Adjust balance</button><button class="btn" id="modalEditAccount">Edit account</button><button class="btn danger" id="modalDeleteAccount">Delete account</button></div>`, null, false);
  document.querySelector('#modalAdjustAccount')?.addEventListener('click',()=>{closeModal();openTransactionModal(null,{type:'account_adjustment',accountId:a.id})});
  document.querySelector('#modalEditAccount')?.addEventListener('click',()=>{closeModal();openAccountModal(a)});
  document.querySelector('#modalDeleteAccount')?.addEventListener('click',()=>deleteAccount(a.id));
}

function renderTransactions(main) {
  const type=route.params.get('type')||'',person=route.params.get('person')||'',category=route.params.get('category')||'';
  const period=route.params.get('period')||'this_month',customFrom=route.params.get('from')||'',customTo=route.params.get('to')||'';
  const anchor=dateInTimeZone(state.settings?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');
  const range=dateRangeForPreset(period,anchor,customFrom,customTo);
  const visible=state.entries.filter(e=>advancedMode()||PERSON_ENTRY_TYPES.includes(e.type));
  const entries=filterTransactionList(visible,{type,personId:person,categoryId:category,people:state.people,from:range.from,to:range.to})
    .sort((a,b)=>new Date(b.date)-new Date(a.date)||new Date(b.createdAt)-new Date(a.createdAt));
  const categoryFilter=advancedMode()?`<select class='select' id='filterCategory' aria-label='Filter by category'><option value=''>All categories</option><option value='uncategorized' ${category==='uncategorized'?'selected':''}>Uncategorized</option>${(state.categories||[]).map(c=>`<option value='${escapeHtml(c.id)}' ${category===c.id?'selected':''}>${escapeHtml(c.name)}${c.archived?' (archived)':''}</option>`).join('')}</select>`:'';
  const customDateFilters=period==='custom'?`<div class='field activity-date-field'><label for='filterFrom'>From</label><input class='input' id='filterFrom' type='date' value='${escapeHtml(customFrom||range.from)}'></div><div class='field activity-date-field'><label for='filterTo'>To</label><input class='input' id='filterTo' type='date' value='${escapeHtml(customTo||range.to)}'></div>`:'';
  main.innerHTML=`<div class='panel-head activity-toolbar'><div class='filters activity-filters'><select class='select' id='filterType' aria-label='Filter by activity type'><option value=''>${advancedMode()?'All activity':'All debt activity'}</option>${entryTypeOptions(type,true)}</select><select class='select' id='filterPerson' aria-label='Filter by person'><option value=''>All people</option>${state.people.map(p=>`<option value='${escapeHtml(p.id)}' ${person===p.id?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}</select><select class='select' id='filterPeriod' aria-label='Filter by date'><option value='this_month' ${period==='this_month'?'selected':''}>This month</option><option value='last_month' ${period==='last_month'?'selected':''}>Last month</option><option value='last_30_days' ${period==='last_30_days'?'selected':''}>Last 30 days</option><option value='all' ${period==='all'?'selected':''}>All time</option><option value='custom' ${period==='custom'?'selected':''}>Custom dates</option></select>${categoryFilter}${customDateFilters}</div><button class='btn primary' id='addTxn'>＋ Add</button></div>
  <section class='card panel activity-list-panel'>${entries.length?transactionTable(entries):'<div class="empty"><strong>No matching activity</strong>Change the filters or date range, or add a transaction.</div>'}</section>`;
  const update=()=>{
    const q=new URLSearchParams();
    const t=main.querySelector('#filterType')?.value||'',p=main.querySelector('#filterPerson')?.value||'',c=main.querySelector('#filterCategory')?.value||'',d=main.querySelector('#filterPeriod')?.value||'this_month';
    if(t)q.set('type',t);if(p)q.set('person',p);if(c)q.set('category',c);if(d!=='this_month')q.set('period',d);
    if(d==='custom'){
      const defaults=dateRangeForPreset('this_month',anchor);
      const f=main.querySelector('#filterFrom')?.value||customFrom||defaults.from,to=main.querySelector('#filterTo')?.value||customTo||defaults.to;
      if(f)q.set('from',f);if(to)q.set('to',to);
    }
    location.hash=`#transactions${q.toString()?'?'+q:''}`;
  };
  ['#filterType','#filterPerson','#filterCategory','#filterPeriod','#filterFrom','#filterTo'].forEach(s=>main.querySelector(s)?.addEventListener('change',update));
  main.querySelector('#addTxn')?.addEventListener('click',()=>openQuickMenu());
  main.querySelectorAll('[data-edit-entry]').forEach(b=>b.addEventListener('click',()=>openTransactionModal(state.entries.find(e=>e.id===b.dataset.editEntry))));
  main.querySelectorAll('[data-delete-entry]').forEach(b=>b.addEventListener('click',()=>deleteEntry(b.dataset.deleteEntry)));
}

function transactionTable(entries,{compact=false}={}){
  const head=`<div class='activity-list-head' role='row'><div role='columnheader'>Date</div><div role='columnheader'>Type</div><div role='columnheader'>Person / transfer</div><div role='columnheader'>Notes</div><div role='columnheader' class='activity-head-amount'>Amount</div>${compact?'':"<div role='columnheader' aria-label='Actions'></div>"}</div>`;
  const rows=entries.map(e=>{
    const p=state.people.find(x=>x.id===e.personId); const from=state.accounts.find(x=>x.id===e.fromAccountId); const to=state.accounts.find(x=>x.id===e.toAccountId); const acc=state.accounts.find(x=>x.id===e.accountId);
    const splitNames=e.type===SPLIT_ENTRY_TYPE?(e.splits||[]).map(split=>state.people.find(x=>x.id===split.personId)?.name||'Unknown').join(', '):'';
    const personText=e.type==='account_transfer'?`${escapeHtml(from?.name||'Unknown')} → ${escapeHtml(to?.name||'Unknown')}`:e.type===SPLIT_ENTRY_TYPE?escapeHtml(splitNames):(e.type==='account_expense'||e.type==='account_income'||e.type==='account_adjustment')?escapeHtml(acc?.name||'Account only'):escapeHtml(p?.name||'—');
    const amt=e.type==='account_transfer'?`${money(e.fromAmount||e.amount,from?.currency||e.currency||'USD')}${from?.currency!==to?.currency?` → ${money(e.toAmount||e.amount,to?.currency||e.currency||'USD')}`:''}`:e.type==='account_adjustment'?`${Number(e.signedAmount)<0?'−':'+'}${money(e.amount,e.currency||acc?.currency||'USD')}`:money(e.amount,e.currency||acc?.currency||'USD');
    const category=state.categories?.find(x=>x.id===e.categoryId);
    return `<div class='activity-list-row' role='row'>
      <div class='activity-date-cell' role='cell'><span class='activity-mobile-label'>Date</span><time datetime='${escapeHtml(e.date)}'>${escapeHtml(e.date)}</time></div>
      <div class='activity-type-cell' role='cell'><span class='activity-mobile-label'>Type</span><span class='pill'>${prettyType(e.type)}</span></div>
      <div class='activity-person-cell' role='cell'><span class='activity-mobile-label'>Person / transfer</span><span>${personText}</span></div>
      <div class='activity-notes-cell' role='cell'><span class='activity-mobile-label'>Notes</span><span class='activity-note-text'>${escapeHtml(e.description||e.merchant||'—')}</span>${category?`<div class='attachment-count'>${escapeHtml((category.icon?category.icon+' ':'')+category.name)}</div>`:''}${e.attachmentCount?`<div class='attachment-count'>📎 ${e.attachmentCount} attachment${e.attachmentCount===1?'':'s'}</div>`:''}</div>
      <div class='activity-amount-cell strong' role='cell'><span class='activity-mobile-label'>Amount</span><span class='activity-amount'>${amt}</span></div>
      ${compact?'':`<div class='activity-actions-cell' role='cell'>${entryMenuMarkup(e.id)}</div>`}
    </div>`;
  }).join('');
  return `<div class='activity-list ${compact?'activity-list-compact':''}' role='table' aria-label='Activity'>${head}<div class='activity-list-body' role='rowgroup'>${rows}</div></div>`;
}

function renderSettings(main) {
  main.innerHTML=`<div class="settings-grid">
    <section class="card settings-card"><h3>General</h3><div class="form-grid">
      <div class="field"><label>Default currency</label><select id="settingCurrency" class="select">${currencyOptions(state.settings.defaultCurrency)}</select></div>
      <div class="field"><label>App mode</label><select id="settingMode" class="select"><option value="simple" ${state.settings.appMode!=='advanced'?'selected':''}>Simple — debts only</option><option value="advanced" ${state.settings.appMode==='advanced'?'selected':''}>Advanced — full money system</option></select></div>
      <div class="field"><label>Appearance</label><select id="settingTheme" class="select"><option value="system" ${themePreference()==='system'?'selected':''}>System</option><option value="light" ${themePreference()==='light'?'selected':''}>Light</option><option value="dark" ${themePreference()==='dark'?'selected':''}>Dark</option></select></div>
      <div class="field"><label>Timezone</label><input class="input" id="settingTimezone" value="${escapeHtml(state.settings.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC')}" readonly><span class="muted tiny">Used by server-side recurring reminders.</span></div>
    </div><div class="warning" style="margin-top:12px"><strong>Simple mode</strong> hides accounts, Bank Feed, budgets and schedules without deleting them. Switch back to Advanced at any time.</div><div style="margin-top:14px"><button class="btn primary" id="saveSettings">Save settings</button></div></section>
    <section class="card settings-card"><h3>App & offline</h3><p class="muted">Core people, account and transaction changes save to this device first. When a connection returns, the durable sync queue sends each change once.</p><div class="pwa-status-grid"><div><span class="pill ${pwa.online?'green':'red'}">${pwa.online?'Online':'Offline'}</span><div class="muted tiny">Connection</div></div><div><span class="pill ${pwa.installed?'green':''}">${pwa.installed?'Installed':'Browser'}</span><div class="muted tiny">App mode</div></div><div><span class="pill ${pwa.updateWaiting?'amber':''}">${pwa.updateWaiting?'Update ready':'Up to date'}</span><div class="muted tiny">PWA version</div></div></div><div class="pwa-status-grid" style="margin-top:12px"><div><span class="pill ${syncInfo.pending?'amber':'green'}">${syncInfo.pending||0} queued</span><div class="muted tiny">Pending sync</div></div><div><span class="pill ${syncInfo.conflicts?'red':''}">${syncInfo.conflicts||0} conflicts</span><div class="muted tiny">Conflicts</div></div><div><span class="pill ${syncInfo.failed?'red':''}">${syncInfo.failed||0} failed</span><div class="muted tiny">Rejected changes</div></div></div><div class="page-actions" style="margin-top:14px">${pwa.online&&syncInfo.pending?'<button class="btn primary" id="syncNow">Sync now</button>':''}${pwa.online&&(syncInfo.conflicts||syncInfo.failed)?'<button class="btn danger" id="discardSync">Discard queued changes & reload server</button>':''}${pwa.installable?'<button class="btn primary" id="installApp">Install Money Tracker</button>':''}${pwa.updateWaiting?'<button class="btn" id="settingsApplyUpdate">Apply update</button>':''}</div></section>
    ${user?.isOwner?`<section class="card settings-card"><h3>User accounts</h3><p class="muted">Public account creation locks after the first owner account. You can reset or delete secondary sign-in accounts here.</p><div id="managedUsers" class="muted">Loading accounts…</div><form id="addUserForm" class="form-grid" style="margin-top:14px"><div class="field"><label>Email</label><input class="input" name="email" type="email" autocomplete="off" required></div><div class="field"><label>Password</label><input class="input" name="password" type="password" minlength="10" autocomplete="new-password" required></div><div class="span-2"><button class="btn primary" type="submit">＋ Create account</button></div></form></section>`:''}
    ${user?.isOwner?'<section class="card settings-card"><h3>Operations & integrity</h3><p class="muted">Owner-only database integrity status and server snapshot controls.</p><div id="runtimeStatus" class="muted">Loading diagnostics…</div><div class="page-actions" style="margin-top:14px"><button class="btn" id="refreshRuntime">Refresh diagnostics</button><button class="btn primary" id="serverSnapshot">Create server snapshot</button></div></section>':''}
    <section class="card settings-card"><h3>Security</h3><p class="muted">Signed in as <strong>${escapeHtml(user?.email||'')}</strong>. Password changes revoke every other session automatically.</p>
      <form id="passwordForm" class="form-grid" style="margin-top:14px"><div class="field"><label>Current password</label><input class="input" name="currentPassword" type="password" autocomplete="current-password" required></div><div class="field"><label>New password</label><input class="input" name="newPassword" type="password" minlength="10" autocomplete="new-password" required></div><div class="span-2 page-actions"><button class="btn primary" type="submit">Change password</button><button class="btn" type="button" id="revokeSessions">Sign out other devices</button><button class="btn" type="button" id="settingsLogout">Sign out this device</button></div></form>
      <div class="settings-subsection"><h4>Active sessions</h4><div id="activeSessions" class="muted">Loading sessions…</div></div>
      <div class="settings-subsection"><h4>Recent security activity</h4><div id="securityEvents" class="muted">Loading activity…</div></div>
    </section>
    <section class="card settings-card"><h3>Danger zone</h3><p class="muted">For your protection, both destructive actions require your current password. Delete all app data keeps your login. Delete account removes this login and all of its data permanently.</p><div class="page-actions"><button class="btn danger" id="resetData">Delete all app data</button><button class="btn danger" id="deleteMyAccount">Delete my account</button></div></section>
  </div>`;
  main.querySelector('#saveSettings')?.addEventListener('click',async()=>{const defaultCurrency=main.querySelector('#settingCurrency').value,appMode=main.querySelector('#settingMode').value,timezone=Intl.DateTimeFormat().resolvedOptions().timeZone||state.settings.timezone||'UTC';saveThemePreference(main.querySelector('#settingTheme').value);const saved=await runMutation(version=>updateSettings({defaultCurrency,appMode,timezone},version),'Settings saved.');if(saved&&appMode==='advanced')showToast('Advanced mode enabled — accounts, Bank Feed, budgets and schedules are now available.');});
  main.querySelector('#settingTheme')?.addEventListener('change',event=>applyTheme(event.target.value));
  main.querySelector('#syncNow')?.addEventListener('click',async()=>{try{await syncPendingOperations();syncInfo=await getSyncStatus();state=await loadState();render();showToast(syncInfo.pending?'Sync paused. Check the queued change status.':'Everything is synced.');}catch(error){showToast(error.message||'Could not sync.');}});
  main.querySelector('#discardSync')?.addEventListener('click',async()=>{if(!confirm('Discard every queued offline change on this device and reload the server copy?'))return;try{state=await discardPendingChangesAndReload();syncInfo=await getSyncStatus();render();showToast('Queued device changes were discarded and the server copy was reloaded.');}catch(error){showToast(error.message||'Could not reload the server copy.');}});
  main.querySelector('#installApp')?.addEventListener('click',async()=>{const accepted=await installPwa();showToast(accepted?'Money Tracker installation started.':'Installation was not completed.');});
  main.querySelector('#settingsApplyUpdate')?.addEventListener('click',()=>{if(activatePwaUpdate())showToast('Updating Money Tracker…');});
  main.querySelector('#settingsLogout')?.addEventListener('click',()=>document.querySelector('#logoutBtn')?.click());
  main.querySelector('#revokeSessions')?.addEventListener('click',async()=>{try{const result=await revokeOtherSessions();showToast(`${result.revoked||0} other session${result.revoked===1?'':'s'} signed out.`);}catch(error){showToast(error.message||'Could not revoke sessions.');}});
  main.querySelector('#passwordForm')?.addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,fd=new FormData(form),button=form.querySelector('button[type=submit]');button.disabled=true;try{await changePassword(fd.get('currentPassword'),fd.get('newPassword'));form.reset();showToast('Password changed. Other devices were signed out.');}catch(error){showToast(error.message||'Could not change password.');}finally{button.disabled=false;}});
  main.querySelector('#exportBackup')?.addEventListener('click',async()=>{try{const backup=await exportFullBackup();downloadText(`money-tracker-complete-backup-${today()}.json`,JSON.stringify(backup,null,2));showToast('Complete backup exported.');}catch(error){showToast(error.message||'Could not export backup.');}});
  main.querySelector('#importBackup')?.addEventListener('click',()=>main.querySelector('#backupFile').click());
  main.querySelector('#openReports')?.addEventListener('click',()=>{location.hash='#reports';});
  main.querySelector('#backupFile')?.addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{const parsed=JSON.parse(await file.text());if(Number(parsed.backupVersion)!==2||parsed.app!=='money-owed-tracker')throw new Error('That file is not a complete Money Tracker backup.');openCompleteBackupRestoreModal(parsed);}catch(error){showToast(error.message||'Could not read that backup.');}finally{e.target.value='';}});
  main.querySelector('#resetData')?.addEventListener('click',()=>openDeleteDataModal());
  main.querySelector('#deleteMyAccount')?.addEventListener('click',()=>openDeleteAccountModal());
  refreshSecurityPanel(main);
  if(user?.isOwner){
    refreshManagedUsers(main);
    refreshRuntimePanel(main);
    main.querySelector('#refreshRuntime')?.addEventListener('click',()=>refreshRuntimePanel(main));
    main.querySelector('#serverSnapshot')?.addEventListener('click',async()=>{const button=main.querySelector('#serverSnapshot');button.disabled=true;try{const result=await createServerSnapshot();showToast('Server snapshot created · '+result.snapshotFile);await refreshRuntimePanel(main);}catch(error){showToast(error.message||'Could not create server snapshot.');}finally{button.disabled=false;}});
    main.querySelector('#addUserForm')?.addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,fd=new FormData(form),button=form.querySelector('button[type=submit]');button.disabled=true;try{await createUserAccount(fd.get('email'),fd.get('password'));form.reset();showToast('Account created.');await refreshManagedUsers(main);}catch(error){showToast(error.message||'Could not create account.');}finally{button.disabled=false;}});
  }
}

async function refreshSecurityPanel(main){
  const sessionsHost=main.querySelector('#activeSessions'),eventsHost=main.querySelector('#securityEvents');
  try{
    const [sessionData,eventData]=await Promise.all([listSessions(),listSecurityEvents()]);
    if(sessionsHost)sessionsHost.innerHTML=sessionData.sessions.length?sessionData.sessions.map(item=>`<div class="security-row"><div><strong>${item.current?'This device':'Signed-in device'}</strong><div class="muted tiny">Last seen ${escapeHtml(String(item.lastSeenAt||'').replace('T',' ').slice(0,16))} · expires ${escapeHtml(String(item.expiresAt||'').slice(0,10))}</div></div>${item.current?'<span class="pill green">Current</span>':`<button class="btn small danger" data-revoke-session="${item.id}">Sign out</button>`}</div>`).join(''):'<div class="muted">No active sessions.</div>';
    sessionsHost?.querySelectorAll('[data-revoke-session]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{await revokeSession(button.dataset.revokeSession);showToast('Session signed out.');await refreshSecurityPanel(main);}catch(error){showToast(error.message||'Could not revoke session.');}finally{button.disabled=false;}}));
    if(eventsHost)eventsHost.innerHTML=eventData.events.length?eventData.events.slice(0,20).map(event=>`<div class="security-event"><strong>${escapeHtml(event.eventType.replaceAll('_',' '))}</strong><span class="muted tiny">${escapeHtml(String(event.createdAt||'').replace('T',' ').slice(0,16))}</span></div>`).join(''):'<div class="muted">No security activity yet.</div>';
  }catch(error){if(sessionsHost)sessionsHost.textContent=error.message||'Could not load sessions.';if(eventsHost)eventsHost.textContent='Could not load security activity.';}
}

async function refreshRuntimePanel(main){
  const host=main.querySelector('#runtimeStatus');if(!host)return;
  host.textContent='Checking database…';
  try{
    const data=await runtimeStatus(),r=data.runtime||{};
    host.innerHTML=`<div class="runtime-grid"><div><strong>${r.sqliteQuickCheck==='ok'?'Healthy':'Needs attention'}</strong><span>SQLite quick check</span></div><div><strong>${Number(r.foreignKeyViolations||0)}</strong><span>Foreign-key violations</span></div><div><strong>${Math.round(Number(r.dbBytes||0)/1024).toLocaleString()} KB</strong><span>Database size</span></div><div><strong>${r.diskFreeBytes==null?'—':(Number(r.diskFreeBytes)/1073741824).toFixed(2)+' GB'}</strong><span>Disk free</span></div></div><div class="muted tiny" style="margin-top:8px">Checked ${escapeHtml(String(r.checkedAt||'').replace('T',' ').slice(0,19))}</div>`;
  }catch(error){host.textContent=error.message||'Could not load diagnostics.';}
}

async function refreshManagedUsers(main){
  const host=main.querySelector('#managedUsers');if(!host)return;
  try{
    const data=await listUsers();
    host.innerHTML=`<div class="table-wrap mobile-card-table-wrap"><table class="table mobile-card-table"><thead><tr><th>Email</th><th>Role</th><th>Created</th><th></th></tr></thead><tbody>${data.users.map(account=>`<tr><td data-label="Email" data-mobile-wide="true"><strong>${escapeHtml(account.email)}</strong></td><td data-label="Role">${account.isOwner?'<span class="pill">Owner</span>':'User'}</td><td data-label="Created">${escapeHtml(String(account.createdAt||'').slice(0,10))}</td><td class="actions">${account.isOwner?'':`<button class="btn small" data-reset-user="${account.id}">Reset password</button> <button class="btn small danger" data-delete-user="${account.id}">Delete</button>`}</td></tr>`).join('')}</tbody></table></div>`;
    host.querySelectorAll('[data-reset-user]').forEach(button=>button.addEventListener('click',()=>openSecondaryPasswordResetModal(button.dataset.resetUser,main)));
    host.querySelectorAll('[data-delete-user]').forEach(button=>button.addEventListener('click',()=>openSecondaryDeleteModal(button.dataset.deleteUser,main)));
  }catch(error){host.textContent=error.message||'Could not load user accounts.';}
}

function openCompleteBackupRestoreModal(backup){
  openModal('Restore complete backup',`<form id="restoreBackupForm" class="form-grid">
    <div class="span-2 warning">Restoring replaces all app data for this login. The backup is checked for integrity and broken references before replacement begins.</div>
    <div class="field span-2"><label>Current password</label><input class="input" type="password" name="password" autocomplete="current-password" required></div>
    <div class="field span-2"><label>Type RESTORE to confirm</label><input class="input" name="confirmation" autocomplete="off" required></div>
  </form>`,()=>document.querySelector('#restoreBackupForm').requestSubmit());
  const saveButton=document.querySelector('#modalSave');
  if(saveButton){saveButton.textContent='Restore backup';saveButton.classList.remove('primary');saveButton.classList.add('danger');}
  document.querySelector('#restoreBackupForm')?.addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget,fd=new FormData(form),button=document.querySelector('#modalSave');
    if(button)button.disabled=true;
    try{
      const result=await restoreFullBackup(backup,fd.get('password'),fd.get('confirmation'));
      state=result.state;closeModal();showToast('Complete backup restored.');render();
    }catch(error){
      showToast(error.message||'Could not restore that backup.');
      form.querySelector('input[name="password"]')?.focus();
    }finally{if(button?.isConnected)button.disabled=false;}
  });
}

function openSecondaryPasswordResetModal(id,main){
  openModal('Reset user password',`<form id="secondaryPasswordForm" class="form-grid">
    <div class="span-2 warning">This signs the user out everywhere. Confirm with your current owner password.</div>
    <div class="field span-2"><label>New password</label><input class="input" type="password" name="password" minlength="10" autocomplete="new-password" required></div>
    <div class="field span-2"><label>Your current password</label><input class="input" type="password" name="currentPassword" autocomplete="current-password" required></div>
  </form>`,()=>document.querySelector('#secondaryPasswordForm').requestSubmit());
  document.querySelector('#secondaryPasswordForm')?.addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget,fd=new FormData(form),button=document.querySelector('#modalSave');
    if(button)button.disabled=true;
    try{
      await resetUserPassword(id,fd.get('password'),fd.get('currentPassword'));
      closeModal();showToast('Password reset and that user’s sessions were revoked.');await refreshManagedUsers(main);
    }catch(error){
      showToast(error.message||'Could not reset password.');
      form.querySelector('input[name="currentPassword"]')?.focus();
    }finally{if(button?.isConnected)button.disabled=false;}
  });
}

function openSecondaryDeleteModal(id,main){
  openModal('Delete user account',`<form id="secondaryDeleteForm" class="form-grid">
    <div class="span-2 warning">This permanently deletes this user login and all app data owned by it. This cannot be undone.</div>
    <div class="field span-2"><label>Your current password</label><input class="input" type="password" name="currentPassword" autocomplete="current-password" required></div>
    <div class="field span-2"><label>Type DELETE to confirm</label><input class="input" name="confirmation" autocomplete="off" required></div>
  </form>`,()=>document.querySelector('#secondaryDeleteForm').requestSubmit());
  const saveButton=document.querySelector('#modalSave');
  if(saveButton){saveButton.textContent='Delete user';saveButton.classList.remove('primary');saveButton.classList.add('danger');}
  document.querySelector('#secondaryDeleteForm')?.addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget,fd=new FormData(form),button=document.querySelector('#modalSave');
    if(button)button.disabled=true;
    try{
      await deleteUserAccount(id,fd.get('currentPassword'),fd.get('confirmation'));
      closeModal();showToast('User account deleted.');await refreshManagedUsers(main);
    }catch(error){
      showToast(error.message||'Could not delete user account.');
      form.querySelector('input[name="currentPassword"]')?.focus();
    }finally{if(button?.isConnected)button.disabled=false;}
  });
}

function openDeleteDataModal(){
  openModal('Delete all app data',`<form id="deleteDataForm" class="form-grid">
    <div class="span-2 warning">This permanently deletes all Money Tracker data for this login, including people, transactions, accounts, attachments, schedules, budgets and Bank Feed history. Your login stays active.</div>
    <div class="field span-2"><label>Current password</label><input class="input" type="password" name="password" autocomplete="current-password" required></div>
  </form>`,()=>document.querySelector('#deleteDataForm').requestSubmit());
  const saveButton=document.querySelector('#modalSave');
  if(saveButton){saveButton.textContent='Delete all app data';saveButton.classList.remove('primary');saveButton.classList.add('danger');}
  document.querySelector('#deleteDataForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget,fd=new FormData(form),button=document.querySelector('#modalSave');
    if(button)button.disabled=true;
    try{
      state=await resetState(fd.get('password'));
      closeModal();
      showToast('App data deleted.');
      location.hash='#dashboard';
      render();
    }catch(error){
      showToast(error.message||'Could not reset app data.');
      form.querySelector('input[name="password"]')?.focus();
    }finally{
      if(button?.isConnected)button.disabled=false;
    }
  });
}

function openDeleteAccountModal(){
  openModal('Delete my account',`<form id="deleteAccountForm" class="form-grid">
    <div class="span-2 warning">This permanently deletes this login and all data owned by it. This cannot be undone.</div>
    <div class="field span-2"><label>Current password</label><input class="input" type="password" name="password" autocomplete="current-password" required></div>
    <div class="field span-2"><label>Type DELETE to confirm</label><input class="input" name="confirmation" required autocomplete="off"></div>
  </form>`,()=>document.querySelector('#deleteAccountForm').requestSubmit());
  const saveButton=document.querySelector('#modalSave');
  if(saveButton){saveButton.textContent='Delete my account';saveButton.classList.remove('primary');saveButton.classList.add('danger');}
  document.querySelector('#deleteAccountForm').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,fd=new FormData(form),button=document.querySelector('#modalSave');if(button)button.disabled=true;try{await deleteMyAccount(fd.get('password'),fd.get('confirmation'));user=null;state=null;closeModal();await showAuth('Account deleted.');}catch(error){showToast(error.message||'Could not delete account.');form.querySelector('input[name="password"]')?.focus();}finally{if(button?.isConnected)button.disabled=false;}});
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
      saved=await runMutation(version=>createPerson({id,name,note,openingBalance:Number(fd.get('opening')||0),currency:fd.get('currency'),direction:fd.get('direction'),openingEntryId,openingDate:localToday()},version),'Person added.');
    }
    if(saved)closeModal();
  });
  if(existing){const foot=document.querySelector('.modal-foot');const del=document.createElement('button');del.type='button';del.className='btn danger';del.textContent='Delete person';del.style.marginRight='auto';del.onclick=()=>deletePerson(existing.id);foot.prepend(del);}
}

function openAccountModal(existing=null){
  const isEdit=!!existing;
  const openingLocked=isEdit&&state.entries.some(e=>e.accountId===existing.id||e.fromAccountId===existing.id||e.toAccountId===existing.id);
  openModal(isEdit?'Edit account':'Add account',`<form id="accountForm" class="form-grid">
    <div class="field span-2"><label>Account name</label><input class="input" name="name" required maxlength="80" value="${escapeHtml(existing?.name||'')}" placeholder="e.g. Bank Audi USD / Cash USD"></div>
    <div class="field"><label>Type</label><select class="select" name="type">${[['bank','Bank'],['cash','Cash'],['card','Card'],['wallet','Wallet'],['other','Other']].map(([v,l])=>`<option value="${v}" ${existing?.type===v?'selected':''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label>Currency</label><select class="select" name="currency" ${isEdit?'disabled':''}>${currencyOptions(existing?.currency||state.settings.defaultCurrency)}</select></div>
    <div class="field span-2"><label>Opening balance</label><input class="input" name="openingBalance" type="number" step="any" value="${existing?.openingBalance??0}" ${openingLocked?'readonly':''}><span class="muted tiny">${openingLocked?'This account has transactions, so the opening balance is locked. Use “Adjust balance” on the account to correct it.':'Use the actual balance at the point you start tracking this account.'}</span></div>
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

function localToday(){return state?.settings?.timezone?dateInTimeZone(state.settings.timezone):today();}
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
    <div class="field"><label>Date</label><input class="input" name="date" type="date" required value="${existing?.date||localToday()}"></div>
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

  let heldAccount=accEl.value;
  const setAdjustLabels=acct=>{const wrap=form.querySelector('#adjustDirection'),[toMe,iOwe]=wrap.querySelectorAll('option');toMe.textContent=acct?'Increase this account':'They owe me more';iOwe.textContent=acct?'Decrease this account':'I owe them more';};
  const sync=()=>{
    const t=typeEl.value,adjust=t==='person_adjustment',acctAdjust=t==='account_adjustment',split=t===SPLIT_ENTRY_TYPE,accountOnly=t==='account_expense'||t==='account_income';
    const needsAccount=accountOnly||acctAdjust,showAccount=!adjust&&(advancedMode()||needsAccount);
    form.querySelector('#txnPersonField').style.display=(split||needsAccount)?'none':'grid';personEl.required=!split&&!needsAccount;
    form.querySelector('#txnAccountField').style.display=showAccount?'grid':'none';
    // A hidden account field must never post: clear + disable it, and restore when it is shown again.
    if(showAccount){if(accEl.disabled){accEl.disabled=false;if(!accEl.value)accEl.value=heldAccount;}heldAccount=accEl.value;}
    else if(!accEl.disabled){heldAccount=accEl.value||heldAccount;accEl.disabled=true;accEl.value='';}
    form.querySelector('#txnCategoryField').style.display=accountOnly?'grid':'none';
    form.querySelector('#adjustDirection').style.display=(adjust||acctAdjust)?'grid':'none';setAdjustLabels(acctAdjust);
    splitSection.hidden=!split;
    if(!adjust&&accEl.value){const a=state.accounts.find(x=>x.id===accEl.value);if(a){curEl.value=a.currency;curEl.disabled=true}}else curEl.disabled=false;
    if(split)updateSplitTotal();
  };
  typeEl.addEventListener('change',()=>{fillCategories();sync();});accEl.addEventListener('change',sync);fillCategories();sync();
  const filesEl=form.querySelector('#txnFiles');filesEl.addEventListener('change',()=>{const files=[...(filesEl.files||[])];form.querySelector('#fileSelection').textContent=files.length?files.map(file=>`${file.name} (${Math.max(1,Math.round(file.size/1024))} KB)`).join(' · '):'JPG, PNG, WebP, GIF, PDF or text · max 8 MB each';});
  if(existing) refreshAttachmentPanel(existing.id);

  form.addEventListener('submit',async e=>{
    e.preventDefault();
    const fd=new FormData(form),t=fd.get('type'),split=t===SPLIT_ENTRY_TYPE,accountOnly=t==='account_expense'||t==='account_income',acctAdjust=t==='account_adjustment',needsAccount=accountOnly||acctAdjust,person=fd.get('personId'),amount=Number(fd.get('amount')),files=[...(filesEl.files||[])];
    const accountId=accEl.disabled?null:(fd.get('accountId')||null);
    if(!(amount>0)){showToast('Enter an amount greater than zero.');return}
    if(!split&&!needsAccount&&!person){showToast('Choose a person.');return}
    if(needsAccount&&!accountId){showToast(acctAdjust?'Choose the account to adjust.':'Choose the account or cash used.');return}
    if(files.some(file=>file.size>8*1024*1024)){showToast('Each attachment must be 8 MB or smaller.');return}
    const splits=split?readSplits():[];
    const acc=state.accounts.find(a=>a.id===accountId);
    if(split){const error=validateSplit(splits,amount,acc?.currency||fd.get('currency')||state.settings.defaultCurrency);if(error){showToast(error);return}}
    const item={id:existing?.id||uid('entry'),type:t,personId:(split||needsAccount)?null:person,accountId:t==='person_adjustment'?null:accountId,amount,currency:acc?.currency||fd.get('currency'),date:fd.get('date'),merchant:fd.get('merchant').trim(),description:fd.get('description').trim(),categoryId:accountOnly?(fd.get('categoryId')||null):null,splits:split?splits:[],attachmentCount:existing?.attachmentCount||0,createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    if(t==='person_adjustment'||acctAdjust) item.signedAmount=(fd.get('direction')==='i_owe'?-1:1)*amount;
    rememberUsed((split||needsAccount)?'':person,item.accountId||recent.accountId||'',t);
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
    <div class="field"><label>Date</label><input class="input" name="date" type="date" required value="${existing?.date||localToday()}"></div>
    <div class="field"><label>Note</label><input class="input" name="description" maxlength="180" value="${escapeHtml(existing?.description||'')}" placeholder="e.g. ATM withdrawal"></div>
    <div class="field span-2"><div class="warning">For same-currency transfers, enter the same amount twice. For currency exchange, enter the actual amount that left and the actual amount that arrived.</div></div>
  </form>`,()=>document.querySelector('#transferForm').requestSubmit());
  document.querySelector('#transferForm').addEventListener('submit',async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),from=fd.get('fromAccountId'),to=fd.get('toAccountId'),fa=Number(fd.get('fromAmount')),ta=Number(fd.get('toAmount'));
    if(!from||!to||from===to){showToast('Choose two different accounts.');return}
    if(!(fa>0)||!(ta>0)){showToast('Enter both transfer amounts.');return}
    const fromAccount=state.accounts.find(account=>account.id===from),toAccount=state.accounts.find(account=>account.id===to);
    if(fromAccount?.currency===toAccount?.currency&&toMinor(fa,fromAccount.currency)!==toMinor(ta,toAccount.currency)){showToast('Same-currency transfers must use the same amount.');return}
    const item={id:existing?.id||uid('entry'),type:'account_transfer',fromAccountId:from,toAccountId:to,fromAmount:fa,toAmount:ta,amount:fa,date:fd.get('date'),description:String(fd.get('description')||'').trim(),merchant:'',splits:[],createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    const saved=await runMutation(version=>existing?updateEntry(existing.id,item,version):createEntry(item,version),existing?'Transfer updated.':'Transfer saved.');
    if(saved)closeModal();
  });
}

function openModal(title,body,onSave=null,showFooter=true){
  const existing=document.querySelector('.modal-backdrop');
  const active=document.activeElement instanceof HTMLElement?document.activeElement:null;
  const previousReturn=modalReturnFocus;
  if(existing)closeModal(false);
  modalReturnFocus=previousReturn?.isConnected?previousReturn:(active?.isConnected?active:null);
  const titleId='modal-title-'+(++modalSequence),back=document.createElement('div');
  back.className='modal-backdrop';
  back.innerHTML=`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="${titleId}" tabindex="-1"><div class="modal-head"><h3 id="${titleId}">${escapeHtml(title)}</h3><button class="icon-btn" id="modalClose" aria-label="Close">×</button></div><div class="modal-body">${body}</div>${showFooter?`<div class="modal-foot"><button class="btn" id="modalCancel">Cancel</button><button class="btn primary" id="modalSave">Save</button></div>`:''}</div>`;
  document.body.appendChild(back);
  wireFieldLabels(back);
  const dialog=back.querySelector('.modal');
  const focusable=()=>[...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(el=>!el.hidden);
  back.querySelector('#modalClose')?.addEventListener('click',()=>closeModal());
  back.querySelector('#modalCancel')?.addEventListener('click',()=>closeModal());
  back.querySelector('#modalSave')?.addEventListener('click',()=>onSave?.());
  back.addEventListener('click',event=>{if(event.target===back)closeModal();});
  back.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();closeModal();return;}
    if(event.key!=='Tab')return;
    const items=focusable();
    if(!items.length){event.preventDefault();dialog.focus();return;}
    const first=items[0],last=items.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  });
  requestAnimationFrame(()=>focusable()[0]?.focus()||dialog.focus());
}
function closeModal(restoreFocus=true){
  closeAllEntryMenus();
  const back=document.querySelector('.modal-backdrop');
  if(!back)return;
  back.remove();
  const target=modalReturnFocus;
  modalReturnFocus=null;
  if(restoreFocus&&target?.isConnected)requestAnimationFrame(()=>target.focus());
}

async function deleteEntry(id){const e=state.entries.find(x=>x.id===id);if(!e)return;if(confirm('Delete this transaction? Balances will recalculate immediately.')){const saved=await runMutation(version=>removeEntry(id,version),'Transaction deleted.');if(saved)closeModal();}}
async function deletePerson(id){const linked=state.entries.some(e=>entryTouchesPerson(e,id));if(linked){showToast('Delete this person’s transactions first.');return}if(confirm('Delete this person?')){const saved=await runMutation(version=>removePerson(id,version),'Person deleted.');if(saved){closeModal();location.hash='#people';}}}
async function deleteAccount(id){const linked=state.entries.some(e=>e.accountId===id||e.fromAccountId===id||e.toAccountId===id);if(linked){showToast('Delete or move this account’s transactions first.');return}if(confirm('Delete this account?')){const saved=await runMutation(version=>removeAccount(id,version),'Account deleted.');if(saved)closeModal();}}

function currencyOptions(selected){return CURRENCIES.map(c=>`<option value="${c}" ${selected===c?'selected':''}>${c}</option>`).join('')}
function entryTypeOptions(selected,includeTransfer=true){
  const debtTypes=[['paid_for_person','They owe me'],['received_from_person','They paid me'],['borrowed_from_person','I owe them'],['paid_to_person','I paid them'],[SPLIT_ENTRY_TYPE,'Split between people'],['person_adjustment','Balance adjustment']];
  const advanced=[['account_expense','Account expense'],['account_income','Account income'],['account_adjustment','Account adjustment']];
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
  app.innerHTML=`<div class="auth-shell"><div class="auth-card card"><div class="auth-brand"><div class="brand-mark">M</div><div><h1>Money Owed Tracker</h1><p>Track money people owe you and money you owe.</p></div></div>${message?`<div class="auth-message" role="alert">${escapeHtml(message)}</div>`:''}${registrationOpen?`<div class="auth-tabs"><button class="active" data-auth-tab="login">Sign in</button><button data-auth-tab="register">Create account</button></div>`:'<div class="auth-tabs"><button class="active">Sign in</button></div>'}<form id="authForm" class="auth-form"><div class="field"><label>Email</label><input class="input" name="email" type="email" autocomplete="email" required></div><div class="field"><label>Password</label><input class="input" name="password" type="password" autocomplete="current-password" minlength="10" required></div><button class="btn primary full" type="submit">Sign in</button><p class="auth-hint">${registrationOpen?'Create the owner account once. After that, extra accounts can only be added from Settings.':'Additional accounts can only be created by the owner from Settings.'}</p></form></div></div>`;
  wireFieldLabels(app);
  let mode='login'; const form=app.querySelector('#authForm');
  app.querySelectorAll('[data-auth-tab]').forEach(btn=>btn.addEventListener('click',()=>{mode=btn.dataset.authTab||'login';app.querySelectorAll('[data-auth-tab]').forEach(b=>b.classList.toggle('active',b===btn));form.querySelector('button[type=submit]').textContent=mode==='register'?'Create account':'Sign in';form.password.autocomplete=mode==='register'?'new-password':'current-password';}));
  form.addEventListener('submit',async e=>{e.preventDefault();const fd=new FormData(form),button=form.querySelector('button[type=submit]');button.disabled=true;button.textContent=mode==='register'?'Creating…':'Signing in…';try{user=mode==='register'?await register(fd.get('email'),fd.get('password')):await login(fd.get('email'),fd.get('password'));state=await loadState();location.hash='#dashboard';render();}catch(error){showAuth(error.message||'Could not sign in.');}finally{button.disabled=false;}});
}

let entryMenuInitialized = false;
function initEntryMenuListeners() {
  if (entryMenuInitialized) return;
  entryMenuInitialized = true;

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-menu-trigger]');
    if (trigger) {
      event.preventDefault();
      event.stopPropagation();
      const entryId = trigger.dataset.menuTrigger;
      const popover = document.querySelector(`[data-menu-popover="${entryId}"]`);
      if (!popover) return;
      const isAlreadyOpen = !popover.hidden;

      closeAllEntryMenus();

      if (!isAlreadyOpen) {
        popover.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        positionEntryMenuPopover(trigger, popover);
      }
      return;
    }

    const menuItem = event.target.closest('.entry-menu-item');
    if (menuItem) {
      closeAllEntryMenus();
      return;
    }

    if (!event.target.closest('.entry-menu-popover')) {
      closeAllEntryMenus();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeAllEntryMenus();
    }
  });

  window.addEventListener('resize', closeAllEntryMenus);
  window.addEventListener('scroll', closeAllEntryMenus, { passive: true });
}

function positionEntryMenuPopover(trigger, popover) {
  const rect = trigger.getBoundingClientRect();
  const popoverWidth = 140;
  const popoverHeight = 88;
  const spaceBelow = window.innerHeight - rect.bottom;
  const showAbove = spaceBelow < popoverHeight + 10 && rect.top > popoverHeight + 10;

  popover.style.position = 'fixed';
  popover.style.zIndex = '300';

  if (showAbove) {
    popover.style.top = 'auto';
    popover.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 4)}px`;
  } else {
    popover.style.top = `${Math.max(8, rect.bottom + 4)}px`;
    popover.style.bottom = 'auto';
  }

  const rightSpace = window.innerWidth - rect.right;
  if (rect.right - popoverWidth < 8) {
    popover.style.right = 'auto';
    popover.style.left = '8px';
  } else {
    popover.style.left = 'auto';
    popover.style.right = `${Math.max(8, rightSpace)}px`;
  }
}

function closeAllEntryMenus() {
  document.querySelectorAll('[data-menu-popover]').forEach(p => {
    p.hidden = true;
  });
  document.querySelectorAll('[data-menu-trigger]').forEach(t => {
    t.setAttribute('aria-expanded', 'false');
  });
}

async function boot(){
  initEntryMenuListeners();
  app.innerHTML='<div class="boot">Loading Money Tracker…</div>';
  try{user=await currentUser();if(!user){await showAuth();return;}state=await loadState();syncInfo=await getSyncStatus().catch(()=>syncInfo);render();}catch(error){showAuth(error.message||'Could not load Money Tracker.');}
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

initPwa().then(status=>{pwa=status;if(state)render();}).catch(()=>{});
boot();
