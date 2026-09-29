import { reportingSnapshot, workbookSheets } from './reporting.js';
import { buildXlsx } from './xlsx.js';
import { buildPdfReport } from './pdf.js';
import { fromMinor, sumMinor, toMinor } from './money.js';

function downloadBytes(filename, bytes, type='application/octet-stream') {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function safeFilePart(value='report') {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60) || 'report';
}

function totalsFromOutstanding(rows) {
  const minors={};
  for(const row of rows){
    const currency=row.currency;minors[currency]||={owedToMe:0,iOwe:0};
    const amount=toMinor(row.amount,currency);
    if(amount>0)minors[currency].owedToMe=sumMinor([minors[currency].owedToMe,amount]);
    if(amount<0)minors[currency].iOwe=sumMinor([minors[currency].iOwe,-amount]);
  }
  return Object.fromEntries(Object.entries(minors).map(([currency,v])=>[currency,{owedToMe:fromMinor(v.owedToMe,currency),iOwe:fromMinor(v.iOwe,currency)}]));
}

function moneyLines(totals, key, money) {
  const rows = Object.entries(totals).filter(([,value]) => Math.abs(value[key] || 0) > 0.000001);
  return rows.length ? rows.map(([currency,value]) => `<div>${money(value[key],currency)}</div>`).join('') : '0';
}

function filtersFromRoute(route) {
  return {
    from: route.params.get('from') || '',
    to: route.params.get('to') || '',
    personId: route.params.get('person') || '',
    accountId: route.params.get('account') || '',
    categoryId: route.params.get('category') || '',
    type: route.params.get('type') || '',
    currency: route.params.get('currency') || ''
  };
}

function reportFilename(state, suffix, today) {
  return `${safeFilePart(state.settings?.displayName || 'my-ledger')}-${suffix}-${today()}`;
}

export function exportPersonPdf(state, person, today) {
  const snapshot = reportingSnapshot(state, { personId: person.id });
  const bytes = buildPdfReport(state, snapshot, { personName: person.name, personId: person.id });
  downloadBytes(`${reportFilename(state, safeFilePart(person.name), today)}-statement.pdf`, bytes, 'application/pdf');
}

export function renderReports(main, state, route, { money, escapeHtml, today }) {
  const filters = filtersFromRoute(route);
  const snapshot = reportingSnapshot(state, filters);
  const outstandingTotals = totalsFromOutstanding(snapshot.outstanding);
  const accountMinorTotals={};
  for(const account of snapshot.accounts)accountMinorTotals[account.currency]=sumMinor([accountMinorTotals[account.currency]||0,toMinor(account.balance,account.currency)]);
  const accountTotals=Object.fromEntries(Object.entries(accountMinorTotals).map(([currency,value])=>[currency,fromMinor(value,currency)]));

  const activityRows = Object.entries(snapshot.activity);
  const outstandingRows = snapshot.outstanding.filter(row => !filters.personId || row.personId === filters.personId);
  const reportPeriod = filters.from || filters.to ? `${filters.from || 'Beginning'} → ${filters.to || 'Today'}` : 'All time';

  main.innerHTML = `
    <div class="panel-head">
      <div>
        <h3 style="margin:0">Reports & exports</h3>
        <p class="muted" style="margin:4px 0 0">Filter activity, review current balances, and export polished files.</p>
      </div>
      <div class="page-actions">
        <button class="btn" id="exportPdf">↓ PDF report</button>
        <button class="btn primary" id="exportXlsx">↓ Excel workbook</button>
      </div>
    </div>

    <section class="card panel" style="margin-bottom:16px">
      <div class="filters" style="margin-bottom:0">
        <div class="field"><label>From date</label><input class="input" type="date" id="reportFrom" value="${escapeHtml(filters.from)}"></div>
        <div class="field"><label>To date</label><input class="input" type="date" id="reportTo" value="${escapeHtml(filters.to)}"></div>
        <div class="field"><label>Person</label><select class="select" id="reportPerson"><option value="">All people</option>${state.people.map(p=>`<option value="${p.id}" ${filters.personId===p.id?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Account</label><select class="select" id="reportAccount"><option value="">All accounts</option>${state.accounts.map(a=>`<option value="${a.id}" ${filters.accountId===a.id?'selected':''}>${escapeHtml(a.name)} · ${escapeHtml(a.currency)}</option>`).join('')}</select></div>
        <div class="field"><label>Category</label><select class="select" id="reportCategory"><option value="">All categories</option>${(state.categories||[]).map(cat=>`<option value="${cat.id}" ${filters.categoryId===cat.id?'selected':''}>${escapeHtml((cat.icon?cat.icon+' ':'')+cat.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Type</label><select class="select" id="reportType"><option value="">All types</option>${['paid_for_person','received_from_person','borrowed_from_person','paid_to_person','person_adjustment','split_paid_for_people','account_expense','account_income','account_adjustment','account_transfer'].map(type=>`<option value="${type}" ${filters.type===type?'selected':''}>${escapeHtml(type.replaceAll('_',' '))}</option>`).join('')}</select></div>
        <div class="field"><label>Currency</label><select class="select" id="reportCurrency"><option value="">All currencies</option>${[...new Set([state.settings.defaultCurrency,...state.accounts.map(a=>a.currency),...state.entries.map(e=>e.currency).filter(Boolean)])].map(currency=>`<option value="${currency}" ${filters.currency===currency?'selected':''}>${escapeHtml(currency)}</option>`).join('')}</select></div>
        <div class="page-actions" style="align-items:end"><button class="btn primary" id="applyReportFilters">Apply</button><button class="btn" id="clearReportFilters">Clear</button></div>
      </div>
      <div class="muted tiny" style="margin-top:10px">Activity period: ${escapeHtml(reportPeriod)}. Outstanding balances and account balances are current ledger balances.</div>
    </section>

    <div class="grid stats">
      <div class="card stat"><div class="stat-top"><div class="stat-label">TRANSACTIONS IN PERIOD</div><div class="stat-icon">#</div></div><div class="stat-value">${snapshot.transactionCount}</div><div class="stat-note">Matching the active report filters</div></div>
      <div class="card stat good"><div class="stat-top"><div class="stat-label">CURRENTLY OWED TO ME</div><div class="stat-icon">↗</div></div><div class="stat-value">${moneyLines(outstandingTotals,'owedToMe',money)}</div><div class="stat-note">Current positive person balances</div></div>
      <div class="card stat bad"><div class="stat-top"><div class="stat-label">I CURRENTLY OWE</div><div class="stat-icon">↘</div></div><div class="stat-value">${moneyLines(outstandingTotals,'iOwe',money)}</div><div class="stat-note">Current negative person balances</div></div>
      <div class="card stat"><div class="stat-top"><div class="stat-label">ACCOUNT BALANCES</div><div class="stat-icon">▣</div></div><div class="stat-value">${Object.keys(accountTotals).length ? Object.entries(accountTotals).map(([currency,value])=>`<div>${money(value,currency)}</div>`).join('') : '0'}</div><div class="stat-note">Current banks, cash and wallets</div></div>
    </div>

    <div class="grid section-grid">
      <section class="card panel">
        <div class="panel-head"><div><h3>Activity by currency</h3><p>What moved during the selected period</p></div></div>
        ${activityRows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Currency</th><th class="right">Paid for people</th><th class="right">Recovered</th><th class="right">Borrowed</th><th class="right">Repaid</th><th class="right">Net person change</th></tr></thead><tbody>${activityRows.map(([currency,v])=>`<tr><td><strong>${escapeHtml(currency)}</strong></td><td class="right">${money(v.charged,currency)}</td><td class="right">${money(v.recovered,currency)}</td><td class="right">${money(v.borrowed,currency)}</td><td class="right">${money(v.repaid,currency)}</td><td class="right strong">${money(v.netPersonChange,currency)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><strong>No activity in this period</strong>Change the report filters or add transactions.</div>'}
      </section>

      <section class="card panel">
        <div class="panel-head"><div><h3>Top merchants / sources</h3><p>Largest tracked payment destinations</p></div></div>
        ${snapshot.merchants.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Merchant</th><th class="right">Transactions</th><th class="right">Amount</th></tr></thead><tbody>${snapshot.merchants.map(row=>`<tr><td><strong>${escapeHtml(row.merchant)}</strong></td><td class="right">${row.count}</td><td class="right strong">${money(row.amount,row.currency)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No merchant-tagged payments in this period.</div>'}
      </section>
    </div>

    <section class="card panel" style="margin-top:16px">
      <div class="panel-head"><div><h3>Personal spending by category</h3><p>Only account expenses in the selected period; money exchanged with people is excluded.</p></div></div>
      ${snapshot.categorySpending.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Category</th><th>Currency</th><th class="right">Transactions</th><th class="right">Amount</th></tr></thead><tbody>${snapshot.categorySpending.map(row=>`<tr><td><strong>${escapeHtml((row.categoryIcon?row.categoryIcon+' ':'')+row.categoryName)}</strong></td><td>${escapeHtml(row.currency)}</td><td class="right">${row.count}</td><td class="right strong">${money(row.amount,row.currency)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No personal account expenses in this period.</div>'}
    </section>

    <section class="card panel" style="margin-top:16px">
      <div class="panel-head"><div><h3>Current outstanding balances</h3><p>Who owes whom right now</p></div></div>
      ${outstandingRows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Person</th><th>Direction</th><th>Currency</th><th class="right">Amount</th></tr></thead><tbody>${outstandingRows.map(row=>`<tr><td><strong>${escapeHtml(row.personName)}</strong></td><td><span class="pill ${row.amount>0?'green':'red'}">${row.amount>0?'Owes you':'You owe'}</span></td><td>${escapeHtml(row.currency)}</td><td class="right strong">${money(Math.abs(row.amount),row.currency)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><strong>All settled</strong>No current outstanding balances match this view.</div>'}
    </section>
    <div class="grid section-grid" style="margin-top:16px">
      ${[
        ['Receivables movement',snapshot.receivablesMovement,'Monthly person-balance changes, including repayments and adjustments.'],
        ['Personal cash flow',snapshot.cashFlow,'Monthly account income minus personal expenses; excludes money exchanged with people and transfers.'],
        ['Transfer flow',snapshot.transferFlow,'Monthly outgoing and incoming transfer legs by currency. Same-currency transfers cancel; no currency conversion is applied.']
      ].map(([label,series,description])=>`<section class="card panel"><div class="panel-head"><div><h3>${label}</h3><p>${description}</p></div></div>
      ${series.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Month</th><th>Currency</th><th class="right">Net movement</th></tr></thead><tbody>${series.flatMap(row=>Object.entries(row.currencies).map(([currency,value])=>`<tr><td>${escapeHtml(row.month)}</td><td>${escapeHtml(currency)}</td><td class="right strong">${money(value,currency)}</td></tr>`)).join('')}</tbody></table></div>`:'<div class="empty">No activity for this measure in this view.</div>'}</section>`).join('')}
      <section class="card panel"><div class="panel-head"><div><h3>Budgets</h3><p>Configured monthly limits</p></div></div>
      ${snapshot.budgets.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Category</th><th>Currency</th><th class="right">Monthly limit</th></tr></thead><tbody>${snapshot.budgets.map(row=>`<tr><td>${escapeHtml(row.categoryName)}</td><td>${escapeHtml(row.currency)}</td><td class="right strong">${money(row.monthlyLimit,row.currency)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No budgets configured.</div>'}</section>
    </div>
  `;

  const apply = () => {
    const q = new URLSearchParams();
    const from = main.querySelector('#reportFrom').value;
    const to = main.querySelector('#reportTo').value;
    const person = main.querySelector('#reportPerson').value;
    const account = main.querySelector('#reportAccount').value;
    const category = main.querySelector('#reportCategory').value;
    const type = main.querySelector('#reportType').value;
    const currency = main.querySelector('#reportCurrency').value;
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (person) q.set('person', person);
    if (account) q.set('account', account);
    if (category) q.set('category', category);
    if (type) q.set('type', type);
    if (currency) q.set('currency', currency);
    location.hash = `#reports${q.toString() ? '?' + q : ''}`;
  };

  main.querySelector('#applyReportFilters')?.addEventListener('click', apply);
  main.querySelector('#clearReportFilters')?.addEventListener('click', () => { location.hash = '#reports'; });
  main.querySelector('#exportXlsx')?.addEventListener('click', () => {
    const bytes = buildXlsx(workbookSheets(state, filters), { title: `${state.settings?.displayName || 'My Ledger'} report` });
    downloadBytes(`${reportFilename(state,'report',today)}.xlsx`, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });
  main.querySelector('#exportPdf')?.addEventListener('click', () => {
    const bytes = buildPdfReport(state, snapshot);
    downloadBytes(`${reportFilename(state,'report',today)}.pdf`, bytes, 'application/pdf');
  });
}
