import { createCategory, updateCategory, archiveCategory, restoreCategory, saveBudget, deleteBudget, loadState } from './lib/store.js';
import { insightsSnapshot, monthKey, categoryOptionsForType } from './lib/insights.js';
import { CURRENCIES, money, escapeHtml } from './lib/utils.js';

function categoryLabel(category){
  return `${category?.icon?category.icon+' ':''}${category?.name||'Uncategorized'}`;
}
function monthLabel(month){
  try{return new Intl.DateTimeFormat(undefined,{year:'numeric',month:'long'}).format(new Date(month+'-01T00:00:00'));}
  catch{return month;}
}
function currencyLines(totals,key){
  const rows=Object.entries(totals||{}).filter(([,v])=>Math.abs(Number(v[key]||0))>0.000001);
  return rows.length?rows.map(([currency,v])=>`<div>${money(v[key],currency)}</div>`).join(''):'0';
}
function categorySelect(state,selected='',kind='expense'){
  const categories=categoryOptionsForType(state.categories,kind==='income'?'account_income':'account_expense');
  return `<option value="">Uncategorized</option>`+categories.map(c=>`<option value="${c.id}" ${c.id===selected?'selected':''}>${escapeHtml(categoryLabel(c))}</option>`).join('');
}
function activeExpenseCategories(state){
  return categoryOptionsForType(state.categories,'account_expense');
}

function openCategoryModal(existing,state,ctx){
  ctx.openModal(existing?'Edit category':'Add category',`<form id="gCategoryForm" class="form-grid">
    <div class="field"><label>Icon</label><input class="input" name="icon" maxlength="8" value="${escapeHtml(existing?.icon||'')}" placeholder="e.g. 🍽️"></div>
    <div class="field"><label>Name</label><input class="input" name="name" maxlength="60" required value="${escapeHtml(existing?.name||'')}" placeholder="e.g. Groceries"></div>
    <div class="field span-2"><label>Category type</label><select class="select" name="kind"><option value="expense" ${existing?.kind==='expense'?'selected':''}>Expense</option><option value="income" ${existing?.kind==='income'?'selected':''}>Income</option><option value="both" ${existing?.kind==='both'?'selected':''}>Both</option></select><div class="muted tiny">Expense categories can have monthly budgets. Both works for either expense or income.</div></div>
  </form>`,()=>document.querySelector('#gCategoryForm')?.requestSubmit());
  document.querySelector('#gCategoryForm')?.addEventListener('submit',async event=>{
    event.preventDefault();const fd=new FormData(event.currentTarget),payload={name:fd.get('name').trim(),icon:fd.get('icon').trim(),kind:fd.get('kind')};
    try{
      if(existing)await updateCategory(existing.id,payload);else await createCategory(payload);
      ctx.closeModal();ctx.showToast(existing?'Category updated.':'Category added.');ctx.replaceState(await loadState());
    }catch(error){ctx.showToast(error.message||'Could not save category.');}
  });
}

function openBudgetModal(existing,state,ctx){
  const categories=activeExpenseCategories(state);
  if(!categories.length){ctx.showToast('Add an expense category before creating a budget.');return;}
  ctx.openModal(existing?'Edit monthly budget':'Add monthly budget',`<form id="gBudgetForm" class="form-grid">
    <div class="field span-2"><label>Expense category</label><select class="select" name="categoryId" required>${categories.map(c=>`<option value="${c.id}" ${c.id===existing?.categoryId?'selected':''}>${escapeHtml(categoryLabel(c))}</option>`).join('')}</select></div>
    <div class="field"><label>Currency</label><select class="select" name="currency">${CURRENCIES.map(c=>`<option value="${c}" ${c===(existing?.currency||state.settings.defaultCurrency)?'selected':''}>${c}</option>`).join('')}</select></div>
    <div class="field"><label>Monthly limit</label><input class="input" name="monthlyLimit" type="number" min="0.01" step="any" required value="${existing?.monthlyLimit??''}" placeholder="0.00"></div>
  </form>`,()=>document.querySelector('#gBudgetForm')?.requestSubmit());
  document.querySelector('#gBudgetForm')?.addEventListener('submit',async event=>{
    event.preventDefault();const fd=new FormData(event.currentTarget);
    try{
      await saveBudget({categoryId:fd.get('categoryId'),currency:fd.get('currency'),monthlyLimit:Number(fd.get('monthlyLimit'))});
      ctx.closeModal();ctx.showToast(existing?'Budget updated.':'Budget added.');ctx.replaceState(await loadState());
    }catch(error){ctx.showToast(error.message||'Could not save budget.');}
  });
}

function categoriesMarkup(state){
  const active=(state.categories||[]).filter(c=>!c.archived),archived=(state.categories||[]).filter(c=>c.archived);
  const row=c=>`<div class="g-category-row">
    <div class="g-category-name"><span class="g-category-icon">${escapeHtml(c.icon||'•')}</span><div><strong>${escapeHtml(c.name)}</strong><small>${c.kind==='both'?'Expense & income':c.kind[0].toUpperCase()+c.kind.slice(1)}</small></div></div>
    <div class="page-actions">${c.archived?`<button class="btn small" data-g-restore="${c.id}">Restore</button>`:`<button class="btn small" data-g-edit-category="${c.id}">Edit</button><button class="btn small danger" data-g-archive="${c.id}">Archive</button>`}</div>
  </div>`;
  return `<section class="card panel g-manage-card">
    <div class="panel-head"><div><h3>Categories</h3><p>Categories stay attached to historical transactions even when archived.</p></div><button class="btn small" id="gAddCategory">＋ Category</button></div>
    <div class="g-category-list">${active.map(row).join('')}${archived.length?`<details class="g-archived"><summary>Archived categories (${archived.length})</summary>${archived.map(row).join('')}</details>`:''}</div>
  </section>`;
}

function budgetMarkup(snapshot,state){
  return `<section class="card panel g-manage-card">
    <div class="panel-head"><div><h3>Monthly budgets</h3><p>Budgets are per expense category and currency.</p></div><button class="btn small" id="gAddBudget">＋ Budget</button></div>
    ${snapshot.budgetRows.length?`<div class="g-budget-list">${snapshot.budgetRows.map(row=>`<div class="g-budget-row">
      <div class="g-budget-top"><div><strong>${escapeHtml((row.categoryIcon?row.categoryIcon+' ':'')+row.categoryName)}</strong><small>${money(row.spent,row.currency)} of ${money(row.monthlyLimit,row.currency)}</small></div><span class="pill ${row.status==='over'?'red':row.status==='near'?'amber':'green'}">${row.status==='over'?'Over budget':row.status==='near'?'Near limit':'On track'}</span></div>
      <div class="g-progress"><span style="width:${Math.min(100,Math.max(0,row.percent))}%"></span></div>
      <div class="g-budget-bottom"><span>${row.remaining>=0?`${money(row.remaining,row.currency)} remaining`:`${money(Math.abs(row.remaining),row.currency)} over`}</span><div class="page-actions"><button class="btn small" data-g-edit-budget="${row.id}">Edit</button><button class="btn small danger" data-g-delete-budget="${row.id}">Remove</button></div></div>
    </div>`).join('')}</div>`:'<div class="empty compact-empty">No monthly budgets yet. Add one for an expense category you want to control.</div>'}
  </section>`;
}

function breakdownMarkup(snapshot,state){
  const byCurrency={};
  for(const row of snapshot.categoryRows){byCurrency[row.currency]||=[];byCurrency[row.currency].push(row);}
  for(const row of snapshot.uncategorized){byCurrency[row.currency]||=[];byCurrency[row.currency].push({categoryId:'',name:'Uncategorized',icon:'?',currency:row.currency,amount:row.amount,count:row.count});}
  const groups=Object.entries(byCurrency);
  return groups.length?groups.map(([currency,rows])=>{
    const max=Math.max(...rows.map(r=>r.amount),1);
    return `<div class="g-breakdown-group"><div class="g-breakdown-currency">${currency}</div>${rows.sort((a,b)=>b.amount-a.amount).map(row=>`<button class="g-breakdown-row" data-g-category-filter="${row.categoryId||'uncategorized'}">
      <span class="g-breakdown-label">${escapeHtml(row.icon||'•')} ${escapeHtml(row.name)}<small>${row.count} transaction${row.count===1?'':'s'}</small></span>
      <span class="g-breakdown-bar"><i style="width:${Math.round(row.amount/max*100)}%"></i></span>
      <strong>${money(row.amount,currency)}</strong>
    </button>`).join('')}</div>`;
  }).join(''):'<div class="empty"><strong>No personal expenses this month</strong>Account expenses will appear here once categorized or imported from Bank Feed.</div>';
}

function trendMarkup(snapshot){
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Month</th><th>Currency</th><th class="right">Expenses</th><th class="right">Income</th><th class="right">Net</th></tr></thead><tbody>${snapshot.trend.flatMap(row=>{const pairs=Object.entries(row.totals);return pairs.length?pairs.map(([currency,v])=>`<tr><td>${escapeHtml(monthLabel(row.month))}</td><td>${currency}</td><td class="right">${money(v.expense,currency)}</td><td class="right">${money(v.income,currency)}</td><td class="right strong ${v.net>=0?'amount-pos':'amount-neg'}">${money(v.net,currency)}</td></tr>`):[`<tr><td>${escapeHtml(monthLabel(row.month))}</td><td>—</td><td class="right">0</td><td class="right">0</td><td class="right">0</td></tr>`]}).join('')}</tbody></table></div>`;
}

function bind(main,state,ctx,month){
  main.querySelector('#gMonth')?.addEventListener('change',e=>{const q=new URLSearchParams();q.set('month',e.target.value);location.hash='#insights?'+q;});
  main.querySelector('#gAddCategory')?.addEventListener('click',()=>openCategoryModal(null,state,ctx));
  main.querySelectorAll('[data-g-edit-category]').forEach(btn=>btn.addEventListener('click',()=>openCategoryModal(state.categories.find(c=>c.id===btn.dataset.gEditCategory),state,ctx)));
  main.querySelectorAll('[data-g-archive]').forEach(btn=>btn.addEventListener('click',async()=>{const category=state.categories.find(c=>c.id===btn.dataset.gArchive);if(!category||!confirm(`Archive “${category.name}”? Historical transactions keep this category, but it will disappear from new-entry choices and its budget will be removed.`))return;try{await archiveCategory(category.id);ctx.showToast('Category archived.');ctx.replaceState(await loadState());}catch(error){ctx.showToast(error.message||'Could not archive category.');}}));
  main.querySelectorAll('[data-g-restore]').forEach(btn=>btn.addEventListener('click',async()=>{try{await restoreCategory(btn.dataset.gRestore);ctx.showToast('Category restored.');ctx.replaceState(await loadState());}catch(error){ctx.showToast(error.message||'Could not restore category.');}}));
  main.querySelector('#gAddBudget')?.addEventListener('click',()=>openBudgetModal(null,state,ctx));
  main.querySelectorAll('[data-g-edit-budget]').forEach(btn=>btn.addEventListener('click',()=>openBudgetModal(state.budgets.find(b=>b.id===btn.dataset.gEditBudget),state,ctx)));
  main.querySelectorAll('[data-g-delete-budget]').forEach(btn=>btn.addEventListener('click',async()=>{if(!confirm('Remove this monthly budget?'))return;try{await deleteBudget(btn.dataset.gDeleteBudget);ctx.showToast('Budget removed.');ctx.replaceState(await loadState());}catch(error){ctx.showToast(error.message||'Could not remove budget.');}}));
  main.querySelectorAll('[data-g-category-filter]').forEach(btn=>btn.addEventListener('click',()=>{const value=btn.dataset.gCategoryFilter;location.hash=`#transactions?category=${encodeURIComponent(value)}`; }));
}

export function renderInsightsPage(main,state,route,ctx){
  const selected=route.params.get('month')||monthKey();
  const snapshot=insightsSnapshot(state,selected,{trendMonths:6});
  main.innerHTML=`
    <div class="panel-head g-page-head"><div><h3>Spending & income insights</h3><p>Personal account expenses and income only. Transfers and money exchanged with people are kept out of budgets.</p></div><div class="field g-month-field"><label>Month</label><input class="input" id="gMonth" type="month" value="${escapeHtml(snapshot.month)}"></div></div>
    <div class="grid stats">
      <div class="card stat bad"><div class="stat-label">PERSONAL EXPENSES</div><div class="stat-value">${currencyLines(snapshot.totals,'expense')}</div><div class="stat-note">${escapeHtml(monthLabel(snapshot.month))}</div></div>
      <div class="card stat good"><div class="stat-label">ACCOUNT INCOME</div><div class="stat-value">${currencyLines(snapshot.totals,'income')}</div><div class="stat-note">Personal income entries</div></div>
      <div class="card stat net"><div class="stat-label">NET PERSONAL CASH FLOW</div><div class="stat-value">${currencyLines(snapshot.totals,'net')}</div><div class="stat-note">Income minus personal expenses</div></div>
      <div class="card stat"><div class="stat-label">BUDGET WATCH</div><div class="stat-value">${snapshot.overBudgetCount?snapshot.overBudgetCount+' over':snapshot.nearBudgetCount?snapshot.nearBudgetCount+' near':'On track'}</div><div class="stat-note">${snapshot.budgetRows.length} active monthly budget${snapshot.budgetRows.length===1?'':'s'}</div></div>
    </div>
    <div class="grid section-grid g-insight-grid">
      <section class="card panel"><div class="panel-head"><div><h3>Expenses by category</h3><p>Tap a category to open matching transactions</p></div></div>${breakdownMarkup(snapshot,state)}</section>
      <section class="card panel"><div class="panel-head"><div><h3>6-month trend</h3><p>Personal expense and income movement</p></div></div>${trendMarkup(snapshot)}</section>
    </div>
    <div class="g-manage-grid">${budgetMarkup(snapshot,state)}${categoriesMarkup(state)}</div>
  `;
  bind(main,state,ctx,snapshot.month);
}

export function mountBudgetDashboardWidget(container,state){
  if(!container)return;
  const snapshot=insightsSnapshot(state,monthKey(),{trendMonths:1});
  const attention=snapshot.budgetRows.filter(r=>r.status!=='ok').slice(0,4);
  container.innerHTML=`<div class="panel-head"><div><h3>Monthly budget watch</h3><p>Personal expenses this month</p></div><button class="btn small" data-open-insights>Insights</button></div>
    ${snapshot.budgetRows.length?(attention.length?attention.map(row=>`<div class="g-dashboard-budget"><div><strong>${escapeHtml((row.categoryIcon?row.categoryIcon+' ':'')+row.categoryName)}</strong><small>${money(row.spent,row.currency)} / ${money(row.monthlyLimit,row.currency)}</small></div><span class="pill ${row.status==='over'?'red':'amber'}">${row.status==='over'?'Over':'Near'}</span></div>`).join(''):'<div class="g-budget-ok">All monthly budgets are currently on track.</div>'):'<div class="muted tiny">No budgets yet. Add them in Insights.</div>'}`;
  container.querySelector('[data-open-insights]')?.addEventListener('click',()=>location.hash='#insights');
}
