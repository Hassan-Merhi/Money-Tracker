import { currentUser, login, register, logout, loadState, saveState, resetState, uid } from './lib/store.js';
import { personBalances, accountBalances, totalsFromBalances, personDelta, accountDelta, runningStatement, PERSON_ENTRY_TYPES } from './lib/ledger.js';
import { CURRENCIES, money, today, escapeHtml, downloadText, balancesText, prettyType } from './lib/utils.js';

let state = null;
let user = null;
let route = parseRoute();
let toastTimer;
let saving = false;

const app = document.querySelector('#app');

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [page, query=''] = raw.split('?');
  return { page, params: new URLSearchParams(query) };
}

window.addEventListener('hashchange', () => { route = parseRoute(); if (state) render(); });

async function persist(message) {
  if (saving) { showToast('Saving the previous change…'); return; }
  saving = true;
  try {
    state = await saveState(state);
    if (message) showToast(message);
    render();
  } catch (error) {
    if (error.status === 409) {
      state = await loadState();
      render();
      showToast('Another tab changed the ledger. I reloaded the latest version.');
    } else if (error.status === 401) {
      user = null; state = null; renderAuth('Your session expired. Sign in again.');
    } else { showToast(error.message || 'Could not save.'); }
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
  return ({dashboard:'⌂',people:'◉',accounts:'▣',transactions:'↕',settings:'⚙'})[page] || '•';
}

function titleFor(page) {
  return ({dashboard:'Dashboard',people:'People',accounts:'Accounts & Cash',transactions:'Transactions',settings:'Settings',person:'Person statement'})[page] || 'My Ledger';
}

function subFor(page) {
  return ({
    dashboard:'See exactly what is owed and where your money sits.',
    people:'Track each person separately with a clean running statement.',
    accounts:'Bank accounts, cash, cards and transfers between them.',
    transactions:'Every movement that affects a person or one of your accounts.',
    settings:'Account, security, currency defaults and backup controls.',
    person:'A chronological statement with a running balance.'
  })[page] || '';
}

function render() {
  const navPage = route.page === 'person' ? 'people' : route.page;
  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark">M</div><div><h1>${escapeHtml(state.settings.displayName || 'My Ledger')}</h1><small>Money owed tracker</small></div></div>
        <nav class="nav">${['dashboard','people','accounts','transactions','settings'].map(p => `<button data-nav="${p}" class="${navPage===p?'active':''}"><span class="nav-icon">${iconFor(p)}</span>${titleFor(p)}</button>`).join('')}</nav>
        <div class="sidebar-foot"><strong>${escapeHtml(user?.email || '')}</strong><br>Block A · secure server ledger<br><button class="sidebar-logout" id="logoutBtn">Sign out</button></div>
      </aside>
      <section class="content">
        <header class="topbar">
          <div class="topbar-title"><h2>${titleFor(route.page)}</h2><p>${subFor(route.page)}</p></div>
          <div class="top-actions"><button class="btn" id="quickTransfer">⇄ Transfer</button><button class="btn primary" id="quickEntry">＋ Add transaction</button></div>
        </header>
        <main class="main" id="main"></main>
      </section>
      <nav class="mobile-nav">${['dashboard','people','accounts','transactions','settings'].map(p => `<button data-nav="${p}" class="${navPage===p?'active':''}"><span>${iconFor(p)}</span>${p==='transactions'?'Activity':titleFor(p).split(' ')[0]}</button>`).join('')}</nav>
    </div>`;

  document.querySelectorAll('[data-nav]').forEach(btn => btn.addEventListener('click', () => location.hash = `#${btn.dataset.nav}`));
  document.querySelector('#quickEntry')?.addEventListener('click', () => openTransactionModal());
  document.querySelector('#quickTransfer')?.addEventListener('click', () => openTransferModal());
  document.querySelector('#logoutBtn')?.addEventListener('click', async () => { try { await logout(); } catch {} user=null; state=null; renderAuth(); });

  const main = document.querySelector('#main');
  if (route.page === 'dashboard') renderDashboard(main);
  else if (route.page === 'people') renderPeople(main);
  else if (route.page === 'accounts') renderAccounts(main);
  else if (route.page === 'transactions') renderTransactions(main);
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
  const aBalances = accountBalances(state.entries, state.accounts);
  const liquid = {};
  for (const acc of state.accounts) liquid[acc.currency] = (liquid[acc.currency] || 0) + (aBalances[acc.id] || 0);
  const recent = [...state.entries].sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)).slice(0,8);

  main.innerHTML = `
    <div class="grid stats">
      <div class="card stat good"><div class="stat-top"><div class="stat-label">PEOPLE OWE ME</div><div class="stat-icon">↗</div></div><div class="stat-value">${currencyTotalsMarkup(totals,'owedToMe','0')}</div><div class="stat-note">Positive personal balances</div></div>
      <div class="card stat bad"><div class="stat-top"><div class="stat-label">I OWE PEOPLE</div><div class="stat-icon">↘</div></div><div class="stat-value">${currencyTotalsMarkup(totals,'iOwe','0')}</div><div class="stat-note">Amounts you need to repay</div></div>
      <div class="card stat net"><div class="stat-top"><div class="stat-label">NET PERSONAL POSITION</div><div class="stat-icon">≈</div></div><div class="stat-value">${currencyTotalsMarkup(totals,'net','0')}</div><div class="stat-note">Owed to you minus what you owe</div></div>
      <div class="card stat"><div class="stat-top"><div class="stat-label">ACCOUNT BALANCES</div><div class="stat-icon">▣</div></div><div class="stat-value">${Object.keys(liquid).length ? Object.entries(liquid).map(([c,v])=>`<div>${money(v,c)}</div>`).join('') : '0'}</div><div class="stat-note">Banks, cash and wallets combined by currency</div></div>
    </div>
    <div class="grid section-grid">
      <section class="card panel">
        <div class="panel-head"><div><h3>Recent activity</h3><p>Your latest ledger movements</p></div><button class="btn small" data-go="transactions">View all</button></div>
        ${recent.length ? transactionTable(recent, {compact:true}) : `<div class="empty"><strong>No transactions yet</strong>Start with “Add transaction” when you buy something for someone, receive money, borrow, or repay.</div>`}
      </section>
      <section class="card panel">
        <div class="panel-head"><div><h3>Quick actions</h3><p>Common actions in one tap</p></div></div>
        <div class="quick-grid">
          <button class="quick" data-action="paid_for_person"><span class="qicon">🛒</span><strong>I paid for someone</strong><small>They owe you more</small></button>
          <button class="quick" data-action="received_from_person"><span class="qicon">💵</span><strong>I got paid back</strong><small>They owe you less</small></button>
          <button class="quick" data-action="borrowed_from_person"><span class="qicon">🤝</span><strong>I borrowed money</strong><small>You owe them more</small></button>
          <button class="quick" data-action="paid_to_person"><span class="qicon">✅</span><strong>I paid them back</strong><small>You owe them less</small></button>
          <button class="quick" data-action="person"><span class="qicon">👤</span><strong>Add a person</strong><small>Create a new statement</small></button>
          <button class="quick" data-action="account"><span class="qicon">🏦</span><strong>Add an account</strong><small>Bank, cash or wallet</small></button>
        </div>
      </section>
    </div>`;
  main.querySelector('[data-go="transactions"]')?.addEventListener('click',()=>location.hash='#transactions');
  main.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => {
    const a=b.dataset.action;
    if (a==='person') openPersonModal(); else if(a==='account') openAccountModal(); else openTransactionModal(null,{type:a});
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
  const personEntries=state.entries.filter(e=>e.personId===person.id && PERSON_ENTRY_TYPES.includes(e.type)).sort((a,b)=>new Date(b.date)-new Date(a.date)||new Date(b.createdAt)-new Date(a.createdAt));
  main.innerHTML=`
    <div class="detail-header"><div class="detail-title"><div class="avatar">${escapeHtml(person.name.slice(0,2).toUpperCase())}</div><div><h2>${escapeHtml(person.name)}</h2><p>${escapeHtml(person.note||'Personal statement')}</p></div></div><div class="page-actions"><button class="btn" id="editPerson">✎ Edit</button><button class="btn primary" id="personTxn">＋ Add transaction</button></div></div>
    <div class="statement-summary">${Object.keys(balances).length?Object.entries(balances).map(([c,v])=>`<span class="pill ${v>0?'green':v<0?'red':''}">${v>0?'Owes you':v<0?'You owe':'Settled'} · ${money(Math.abs(v),c)}</span>`).join(''):'<span class="pill">Settled</span>'}</div>
    <section class="card panel"><div class="panel-head"><div><h3>Statement</h3><p>Positive change means the person owes you more; negative means less.</p></div></div>${personEntries.length?statementTable(personEntries):'<div class="empty"><strong>No statement entries yet</strong>Add the first purchase, repayment, borrowing or opening balance.</div>'}</section>`;
  main.querySelector('#personTxn')?.addEventListener('click',()=>openTransactionModal(null,{personId:person.id}));
  main.querySelector('#editPerson')?.addEventListener('click',()=>openPersonModal(person));
  main.querySelectorAll('[data-edit-entry]').forEach(b=>b.addEventListener('click',()=>openTransactionModal(state.entries.find(e=>e.id===b.dataset.editEntry))));
  main.querySelectorAll('[data-delete-entry]').forEach(b=>b.addEventListener('click',()=>deleteEntry(b.dataset.deleteEntry)));
}

function statementTable(entries){
  const grouped={};
  for(const e of entries){ const c=e.currency||'USD'; grouped[c]=runningStatement(state.entries,e.personId,c); }
  const runningById={}; Object.values(grouped).flat().forEach(r=>runningById[r.id]=r.running);
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Type</th><th>Description</th><th class="right">Change</th><th class="right">Running balance</th><th></th></tr></thead><tbody>${entries.map(e=>{const d=personDelta(e);const c=e.currency||'USD';return `<tr><td>${escapeHtml(e.date)}</td><td><span class="pill">${prettyType(e.type)}</span></td><td><strong>${escapeHtml(e.description||'—')}</strong>${e.merchant?`<div class="muted tiny">${escapeHtml(e.merchant)}</div>`:''}</td><td class="right ${d>=0?'amount-pos':'amount-neg'}">${d>=0?'+':''}${money(d,c)}</td><td class="right strong">${money(runningById[e.id]||0,c)}</td><td class="actions"><button class="btn small" data-edit-entry="${e.id}">Edit</button> <button class="btn small danger" data-delete-entry="${e.id}">Delete</button></td></tr>`}).join('')}</tbody></table></div>`;
}

function renderAccounts(main) {
  const balances=accountBalances(state.entries,state.accounts);
  main.innerHTML=`<div class="panel-head"><div><p class="muted">Opening balance + all linked ledger movements.</p></div><div class="page-actions"><button class="btn" id="transferBtn">⇄ Transfer</button><button class="btn primary" id="addAccount">＋ Add account</button></div></div>
  ${state.accounts.length?`<div class="accounts-grid">${state.accounts.map(a=>`<div class="card account-card" data-account="${a.id}"><div class="account-top"><div><h3>${escapeHtml(a.name)}</h3><p>${escapeHtml(a.type)} · ${escapeHtml(a.currency)}</p></div><span class="pill">${a.type==='Cash'?'Cash':'Account'}</span></div><div class="balance ${balances[a.id]<0?'negative':''}">${money(balances[a.id]||0,a.currency)}</div><div class="muted tiny">Opening: ${money(a.openingBalance||0,a.currency)}</div></div>`).join('')}</div>`:`<div class="card hero-empty empty"><div class="big">🏦</div><h3>Add your bank accounts and cash</h3><p>When you pay for someone, receive money, borrow, repay or transfer funds, the linked account balance updates automatically.</p><button class="btn primary" id="emptyAddAccount">＋ Add account</button></div>`}`;
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
  const type=route.params.get('type')||''; const person=route.params.get('person')||''; const account=route.params.get('account')||'';
  let entries=[...state.entries].sort((a,b)=>new Date(b.date)-new Date(a.date)||new Date(b.createdAt)-new Date(a.createdAt));
  if(type) entries=entries.filter(e=>e.type===type); if(person) entries=entries.filter(e=>e.personId===person); if(account) entries=entries.filter(e=>e.accountId===account||e.fromAccountId===account||e.toAccountId===account);
  main.innerHTML=`<div class="panel-head"><div class="filters"><select class="select" id="filterType"><option value="">All types</option>${entryTypeOptions(type)}</select><select class="select" id="filterPerson"><option value="">All people</option>${state.people.map(p=>`<option value="${p.id}" ${person===p.id?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}</select><select class="select" id="filterAccount"><option value="">All accounts</option>${state.accounts.map(a=>`<option value="${a.id}" ${account===a.id?'selected':''}>${escapeHtml(a.name)}</option>`).join('')}</select></div><button class="btn primary" id="addTxn">＋ Add transaction</button></div>
  <section class="card panel">${entries.length?transactionTable(entries):'<div class="empty"><strong>No matching transactions</strong>Try another filter or add a new transaction.</div>'}</section>`;
  const update=()=>{const q=new URLSearchParams();const t=main.querySelector('#filterType').value,p=main.querySelector('#filterPerson').value,a=main.querySelector('#filterAccount').value;if(t)q.set('type',t);if(p)q.set('person',p);if(a)q.set('account',a);location.hash=`#transactions${q.toString()?'?'+q:''}`};
  ['#filterType','#filterPerson','#filterAccount'].forEach(s=>main.querySelector(s)?.addEventListener('change',update));
  main.querySelector('#addTxn')?.addEventListener('click',()=>openTransactionModal());
  main.querySelectorAll('[data-edit-entry]').forEach(b=>b.addEventListener('click',()=>openTransactionModal(state.entries.find(e=>e.id===b.dataset.editEntry))));
  main.querySelectorAll('[data-delete-entry]').forEach(b=>b.addEventListener('click',()=>deleteEntry(b.dataset.deleteEntry)));
}

function transactionTable(entries,{compact=false}={}){
  const pb=personBalances(state.entries,state.people); const ab=accountBalances(state.entries,state.accounts);
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Type</th><th>Person / transfer</th><th>Description</th><th class="right">Amount</th>${compact?'':'<th></th>'}</tr></thead><tbody>${entries.map(e=>{
    const p=state.people.find(x=>x.id===e.personId); const from=state.accounts.find(x=>x.id===e.fromAccountId); const to=state.accounts.find(x=>x.id===e.toAccountId); const acc=state.accounts.find(x=>x.id===e.accountId);
    const personText=e.type==='account_transfer'?`${escapeHtml(from?.name||'Unknown')} → ${escapeHtml(to?.name||'Unknown')}`:escapeHtml(p?.name||'—');
    const amt=e.type==='account_transfer'?`${money(e.fromAmount||e.amount,from?.currency||e.currency||'USD')}${from?.currency!==to?.currency?` → ${money(e.toAmount||e.amount,to?.currency||e.currency||'USD')}`:''}`:money(e.amount,e.currency||acc?.currency||'USD');
    return `<tr><td>${escapeHtml(e.date)}</td><td><span class="pill">${prettyType(e.type)}</span></td><td>${personText}</td><td>${escapeHtml(e.description||e.merchant||'—')}</td><td class="right strong">${amt}</td>${compact?'':`<td class="actions"><button class="btn small" data-edit-entry="${e.id}">Edit</button> <button class="btn small danger" data-delete-entry="${e.id}">Delete</button></td>`}</tr>`}).join('')}</tbody></table></div>`;
}

function renderSettings(main) {
  main.innerHTML=`<div class="settings-grid">
    <section class="card settings-card"><h3>General</h3><div class="form-grid"><div class="field span-2"><label>Ledger name</label><input id="settingName" class="input" maxlength="80" value="${escapeHtml(state.settings.displayName||'My Ledger')}"></div><div class="field"><label>Default currency</label><select id="settingCurrency" class="select">${currencyOptions(state.settings.defaultCurrency)}</select></div></div><div style="margin-top:14px"><button class="btn primary" id="saveSettings">Save settings</button></div></section>
    <section class="card settings-card"><h3>Security</h3><p class="muted">Signed in as <strong>${escapeHtml(user?.email||'')}</strong>. Sessions use an HttpOnly cookie; ledger writes require a CSRF token and are isolated to your account.</p><button class="btn" id="settingsLogout">Sign out on this device</button></section>
    <section class="card settings-card"><h3>Backup</h3><p class="muted">JSON backup is included as a safety bridge. Excel/PDF imports and polished exports belong to later blocks.</p><div class="page-actions"><button class="btn" id="exportBackup">↓ Export backup</button><button class="btn" id="importBackup">↑ Import backup</button><input type="file" id="backupFile" accept="application/json" hidden></div></section>
    <section class="card settings-card"><h3>Ledger rules</h3><div class="warning"><strong>Balance rule:</strong> positive personal balance = they owe you. Negative personal balance = you owe them. Transfers affect accounts only and never change a person’s balance.</div></section>
    <section class="card settings-card"><h3>Danger zone</h3><p class="muted">This permanently deletes your people, accounts and transactions from the server database. Your login remains active.</p><button class="btn danger" id="resetData">Delete all ledger data</button></section>
  </div>`;
  main.querySelector('#saveSettings')?.addEventListener('click',()=>{state.settings.displayName=main.querySelector('#settingName').value.trim()||'My Ledger';state.settings.defaultCurrency=main.querySelector('#settingCurrency').value;persist('Settings saved.');});
  main.querySelector('#settingsLogout')?.addEventListener('click',()=>document.querySelector('#logoutBtn')?.click());
  main.querySelector('#exportBackup')?.addEventListener('click',()=>downloadText(`my-ledger-backup-${today()}.json`,JSON.stringify({...state,version:undefined},null,2)));
  main.querySelector('#importBackup')?.addEventListener('click',()=>main.querySelector('#backupFile').click());
  main.querySelector('#backupFile')?.addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{const parsed=JSON.parse(await file.text());if(!Array.isArray(parsed.people)||!Array.isArray(parsed.accounts)||!Array.isArray(parsed.entries))throw new Error();state={...state,settings:{...state.settings,...parsed.settings},people:parsed.people,accounts:parsed.accounts,entries:parsed.entries};await persist('Backup imported.');}catch(error){showToast(error.message||'That file is not a valid ledger backup.');}});
  main.querySelector('#resetData')?.addEventListener('click',async()=>{if(confirm('Permanently delete all people, accounts and transactions?')){try{state=await resetState();showToast('Ledger data deleted.');location.hash='#dashboard';render();}catch(error){showToast(error.message||'Could not reset ledger.');}}});
}

function openPersonModal(existing=null){
  const isEdit=!!existing;
  openModal(isEdit?'Edit person':'Add person',`<form id="personForm" class="form-grid">
    <div class="field span-2"><label>Name</label><input class="input" name="name" required maxlength="80" value="${escapeHtml(existing?.name||'')}" placeholder="e.g. Ahmad"></div>
    <div class="field span-2"><label>Note</label><input class="input" name="note" maxlength="120" value="${escapeHtml(existing?.note||'')}" placeholder="e.g. Cousin / Amazon purchases"></div>
    ${isEdit?'':`<div class="field"><label>Opening balance</label><input class="input" name="opening" type="number" step="0.01" min="0" placeholder="0"></div><div class="field"><label>Currency</label><select class="select" name="currency">${currencyOptions(state.settings.defaultCurrency)}</select></div><div class="field span-2"><label>Opening balance means</label><select class="select" name="direction"><option value="to_me">They already owe me</option><option value="i_owe">I already owe them</option></select></div>`}
  </form>`,()=>document.querySelector('#personForm').requestSubmit());
  document.querySelector('#personForm').addEventListener('submit',e=>{e.preventDefault();const fd=new FormData(e.currentTarget);const name=fd.get('name').trim();if(!name)return;if(existing){existing.name=name;existing.note=fd.get('note').trim();persist('Person updated.');}else{const id=uid('person');state.people.push({id,name,note:fd.get('note').trim(),createdAt:new Date().toISOString()});const opening=Number(fd.get('opening')||0);if(opening>0){const sign=fd.get('direction')==='i_owe'?-1:1;state.entries.push({id:uid('entry'),type:'person_adjustment',personId:id,amount:opening,signedAmount:sign*opening,currency:fd.get('currency'),date:today(),description:'Opening balance',createdAt:new Date().toISOString()});}persist('Person added.');}closeModal();});
  if(existing){const foot=document.querySelector('.modal-foot');const del=document.createElement('button');del.type='button';del.className='btn danger';del.textContent='Delete person';del.style.marginRight='auto';del.onclick=()=>deletePerson(existing.id);foot.prepend(del);}
}

function openAccountModal(existing=null){
  const isEdit=!!existing;
  openModal(isEdit?'Edit account':'Add account',`<form id="accountForm" class="form-grid">
    <div class="field span-2"><label>Account name</label><input class="input" name="name" required maxlength="80" value="${escapeHtml(existing?.name||'')}" placeholder="e.g. Bank Audi USD / Cash USD"></div>
    <div class="field"><label>Type</label><select class="select" name="type">${['Bank','Cash','Card','Wallet','Other'].map(x=>`<option ${existing?.type===x?'selected':''}>${x}</option>`).join('')}</select></div>
    <div class="field"><label>Currency</label><select class="select" name="currency" ${isEdit?'disabled':''}>${currencyOptions(existing?.currency||state.settings.defaultCurrency)}</select></div>
    <div class="field span-2"><label>Opening balance</label><input class="input" name="openingBalance" type="number" step="0.01" value="${existing?.openingBalance??0}"><span class="muted tiny">Use the actual balance at the point you start tracking this account.</span></div>
  </form>`,()=>document.querySelector('#accountForm').requestSubmit());
  document.querySelector('#accountForm').addEventListener('submit',e=>{e.preventDefault();const fd=new FormData(e.currentTarget);const name=fd.get('name').trim();if(!name)return;if(existing){existing.name=name;existing.type=fd.get('type');existing.openingBalance=Number(fd.get('openingBalance')||0);persist('Account updated.');}else{state.accounts.push({id:uid('account'),name,type:fd.get('type'),currency:fd.get('currency'),openingBalance:Number(fd.get('openingBalance')||0),createdAt:new Date().toISOString()});persist('Account added.');}closeModal();});
}

function openTransactionModal(existing=null,prefill={}){
  if(existing?.type==='account_transfer'){openTransferModal(existing);return;}
  const type=existing?.type||prefill.type||'paid_for_person'; const personId=existing?.personId||prefill.personId||state.people[0]?.id||''; const accountId=existing?.accountId||state.accounts[0]?.id||'';
  const inferredCurrency=existing?.currency||state.accounts.find(a=>a.id===accountId)?.currency||state.settings.defaultCurrency;
  openModal(existing?'Edit transaction':'Add transaction',`<form id="txnForm" class="form-grid">
    <div class="field span-2"><label>Transaction type</label><select class="select" name="type" id="txnType">${entryTypeOptions(type,false)}</select></div>
    <div class="field"><label>Person</label><select class="select" name="personId" id="txnPerson" required><option value="">Choose person</option>${state.people.map(p=>`<option value="${p.id}" ${p.id===personId?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}</select></div>
    <div class="field" id="txnAccountField"><label>Account / cash</label><select class="select" name="accountId" id="txnAccount"><option value="">Choose account</option>${state.accounts.map(a=>`<option value="${a.id}" ${a.id===accountId?'selected':''}>${escapeHtml(a.name)} · ${a.currency}</option>`).join('')}</select></div>
    <div class="field"><label>Amount</label><input class="input" name="amount" type="number" min="0.000001" step="0.01" required value="${existing?.amount??''}" placeholder="0.00"></div>
    <div class="field" id="currencyField"><label>Currency</label><select class="select" name="currency" id="txnCurrency">${currencyOptions(inferredCurrency)}</select></div>
    <div class="field"><label>Date</label><input class="input" name="date" type="date" required value="${existing?.date||today()}"></div>
    <div class="field"><label>Merchant / source</label><input class="input" name="merchant" maxlength="100" value="${escapeHtml(existing?.merchant||'')}" placeholder="e.g. Amazon"></div>
    <div class="field span-2"><label>Description</label><input class="input" name="description" maxlength="180" value="${escapeHtml(existing?.description||'')}" placeholder="e.g. Headphones for cousin"></div>
    <div class="field span-2" id="adjustDirection" style="display:none"><label>Adjustment means</label><select class="select" name="direction"><option value="to_me" ${(existing?.signedAmount??1)>=0?'selected':''}>They owe me more</option><option value="i_owe" ${(existing?.signedAmount??1)<0?'selected':''}>I owe them more</option></select></div>
  </form>`,()=>document.querySelector('#txnForm').requestSubmit());

  const form=document.querySelector('#txnForm'),typeEl=form.querySelector('#txnType'),accEl=form.querySelector('#txnAccount'),curEl=form.querySelector('#txnCurrency');
  const sync=()=>{const t=typeEl.value;const adjust=t==='person_adjustment';form.querySelector('#txnAccountField').style.display=adjust?'none':'grid';form.querySelector('#adjustDirection').style.display=adjust?'grid':'none';if(!adjust&&accEl.value){const a=state.accounts.find(x=>x.id===accEl.value);if(a){curEl.value=a.currency;curEl.disabled=true}}else curEl.disabled=false;};
  typeEl.addEventListener('change',sync);accEl.addEventListener('change',sync);sync();
  form.addEventListener('submit',e=>{e.preventDefault();const fd=new FormData(form);const t=fd.get('type');const person=fd.get('personId');const amount=Number(fd.get('amount'));if(!person||!(amount>0)){showToast('Choose a person and enter an amount.');return}if(t!=='person_adjustment'&&!fd.get('accountId')){showToast('Choose the account or cash used.');return}const acc=state.accounts.find(a=>a.id===fd.get('accountId'));const item={id:existing?.id||uid('entry'),type:t,personId:person,accountId:t==='person_adjustment'?null:fd.get('accountId'),amount,currency:acc?.currency||fd.get('currency'),date:fd.get('date'),merchant:fd.get('merchant').trim(),description:fd.get('description').trim(),createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};if(t==='person_adjustment') item.signedAmount=(fd.get('direction')==='i_owe'?-1:1)*amount;if(existing){Object.assign(existing,item);}else state.entries.push(item);persist(existing?'Transaction updated.':'Transaction added.');closeModal();});
}

function openTransferModal(existing=null){
  const fromId=existing?.fromAccountId||state.accounts[0]?.id||''; const toId=existing?.toAccountId||state.accounts.find(a=>a.id!==fromId)?.id||'';
  openModal(existing?'Edit transfer':'Transfer money',`<form id="transferForm" class="form-grid">
    <div class="field"><label>From account</label><select class="select" name="fromAccountId" id="fromAccount" required><option value="">Choose</option>${state.accounts.map(a=>`<option value="${a.id}" ${a.id===fromId?'selected':''}>${escapeHtml(a.name)} · ${a.currency}</option>`).join('')}</select></div>
    <div class="field"><label>To account</label><select class="select" name="toAccountId" id="toAccount" required><option value="">Choose</option>${state.accounts.map(a=>`<option value="${a.id}" ${a.id===toId?'selected':''}>${escapeHtml(a.name)} · ${a.currency}</option>`).join('')}</select></div>
    <div class="field"><label>Amount leaving source</label><input class="input" name="fromAmount" type="number" min="0.000001" step="0.01" required value="${existing?.fromAmount??existing?.amount??''}" placeholder="0.00"></div>
    <div class="field"><label>Amount arriving destination</label><input class="input" name="toAmount" type="number" min="0.000001" step="0.01" required value="${existing?.toAmount??existing?.amount??''}" placeholder="0.00"></div>
    <div class="field"><label>Date</label><input class="input" name="date" type="date" required value="${existing?.date||today()}"></div>
    <div class="field"><label>Note</label><input class="input" name="description" maxlength="180" value="${escapeHtml(existing?.description||'')}" placeholder="e.g. ATM withdrawal"></div>
    <div class="field span-2"><div class="warning">For same-currency transfers, enter the same amount twice. For currency exchange, enter the actual amount that left and the actual amount that arrived.</div></div>
  </form>`,()=>document.querySelector('#transferForm').requestSubmit());
  document.querySelector('#transferForm').addEventListener('submit',e=>{e.preventDefault();const fd=new FormData(e.currentTarget);const from=fd.get('fromAccountId'),to=fd.get('toAccountId'),fa=Number(fd.get('fromAmount')),ta=Number(fd.get('toAmount'));if(!from||!to||from===to){showToast('Choose two different accounts.');return}if(!(fa>0)||!(ta>0)){showToast('Enter both transfer amounts.');return}const item={id:existing?.id||uid('entry'),type:'account_transfer',fromAccountId:from,toAccountId:to,fromAmount:fa,toAmount:ta,amount:fa,date:fd.get('date'),description:fd.get('description').trim(),createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};if(existing)Object.assign(existing,item);else state.entries.push(item);persist(existing?'Transfer updated.':'Transfer saved.');closeModal();});
}

function openModal(title,body,onSave=null,showFooter=true){
  closeModal();const back=document.createElement('div');back.className='modal-backdrop';back.innerHTML=`<div class="modal" role="dialog" aria-modal="true"><div class="modal-head"><h3>${title}</h3><button class="icon-btn" id="modalClose" aria-label="Close">×</button></div><div class="modal-body">${body}</div>${showFooter?`<div class="modal-foot"><button class="btn" id="modalCancel">Cancel</button><button class="btn primary" id="modalSave">Save</button></div>`:''}</div>`;document.body.appendChild(back);back.querySelector('#modalClose')?.addEventListener('click',closeModal);back.querySelector('#modalCancel')?.addEventListener('click',closeModal);back.querySelector('#modalSave')?.addEventListener('click',()=>onSave?.());back.addEventListener('click',e=>{if(e.target===back)closeModal()});
}
function closeModal(){document.querySelector('.modal-backdrop')?.remove()}

function deleteEntry(id){const e=state.entries.find(x=>x.id===id);if(!e)return;if(confirm('Delete this transaction? Balances will recalculate immediately.')){state.entries=state.entries.filter(x=>x.id!==id);persist('Transaction deleted.');closeModal();}}
function deletePerson(id){const linked=state.entries.some(e=>e.personId===id);if(linked){showToast('Delete this person’s transactions first.');return}if(confirm('Delete this person?')){state.people=state.people.filter(p=>p.id!==id);persist('Person deleted.');closeModal();location.hash='#people';}}
function deleteAccount(id){const linked=state.entries.some(e=>e.accountId===id||e.fromAccountId===id||e.toAccountId===id);if(linked){showToast('Delete or move this account’s transactions first.');return}if(confirm('Delete this account?')){state.accounts=state.accounts.filter(a=>a.id!==id);persist('Account deleted.');closeModal();}}

function currencyOptions(selected){return CURRENCIES.map(c=>`<option value="${c}" ${selected===c?'selected':''}>${c}</option>`).join('')}
function entryTypeOptions(selected,includeTransfer=true){
  const types=[['paid_for_person','Paid for someone'],['received_from_person','Received repayment'],['borrowed_from_person','Borrowed from person'],['paid_to_person','Paid person back'],['person_adjustment','Balance adjustment']];
  if(includeTransfer)types.push(['account_transfer','Account transfer']);
  return types.map(([v,l])=>`<option value="${v}" ${selected===v?'selected':''}>${l}</option>`).join('');
}

function renderAuth(message='') {
  app.innerHTML=`<div class="auth-shell"><div class="auth-card card"><div class="auth-brand"><div class="brand-mark">M</div><div><h1>Money Owed Tracker</h1><p>Secure personal ledger for money owed to you and money you owe.</p></div></div>${message?`<div class="auth-message">${escapeHtml(message)}</div>`:''}<div class="auth-tabs"><button class="active" data-auth-tab="login">Sign in</button><button data-auth-tab="register">Create account</button></div><form id="authForm" class="auth-form"><div class="field register-only" hidden><label>Ledger name</label><input class="input" name="displayName" maxlength="80" value="My Ledger"></div><div class="field"><label>Email</label><input class="input" name="email" type="email" autocomplete="email" required></div><div class="field"><label>Password</label><input class="input" name="password" type="password" autocomplete="current-password" minlength="10" required></div><button class="btn primary full" type="submit">Sign in</button><p class="auth-hint">Passwords are hashed on the server. A password of 10+ characters is required.</p></form></div></div>`;
  let mode='login'; const form=app.querySelector('#authForm');
  app.querySelectorAll('[data-auth-tab]').forEach(btn=>btn.addEventListener('click',()=>{mode=btn.dataset.authTab;app.querySelectorAll('[data-auth-tab]').forEach(b=>b.classList.toggle('active',b===btn));form.querySelector('.register-only').hidden=mode!=='register';form.querySelector('button[type=submit]').textContent=mode==='register'?'Create account':'Sign in';form.password.autocomplete=mode==='register'?'new-password':'current-password';}));
  form.addEventListener('submit',async e=>{e.preventDefault();const fd=new FormData(form),button=form.querySelector('button[type=submit]');button.disabled=true;button.textContent=mode==='register'?'Creating…':'Signing in…';try{user=mode==='register'?await register(fd.get('email'),fd.get('password'),fd.get('displayName')):await login(fd.get('email'),fd.get('password'));state=await loadState();location.hash='#dashboard';render();}catch(error){renderAuth(error.message||'Could not sign in.');}finally{button.disabled=false;}});
}

async function boot(){
  app.innerHTML='<div class="boot">Loading your ledger…</div>';
  try{user=await currentUser();if(!user){renderAuth();return;}state=await loadState();render();}catch(error){renderAuth(error.message||'Could not load your ledger.');}
}

if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(()=>{}));}
boot();
