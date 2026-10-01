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
    currency: route.params.get('currency') || '',
    q: route.params.get('q') || '',
    period: route.params.get('period') || ''
  };
}

function isoParts(value) {
  const [year,month,day] = String(value || '').split('-').map(Number);
  return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day) ? {year,month,day} : null;
}

function monthRange(todayIso, offset=0) {
  const parts = isoParts(todayIso);
  if (!parts) return { from:'', to:'' };
  const index = parts.year * 12 + (parts.month - 1) + offset;
  const year = Math.floor(index / 12);
  const monthIndex = index - year * 12;
  const month = monthIndex + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2,'0');
  return { from:`${year}-${mm}-01`, to:`${year}-${mm}-${String(lastDay).padStart(2,'0')}` };
}

function periodRange(period, todayIso) {
  if (period === 'this_month') return monthRange(todayIso, 0);
  if (period === 'last_month') return monthRange(todayIso, -1);
  if (period === 'this_year') {
    const parts = isoParts(todayIso);
    if (parts) return { from:`${parts.year}-01-01`, to:`${parts.year}-12-31` };
  }
  return { from:'', to:'' };
}

function activePeriod(filters, todayIso) {
  if (['all','this_month','last_month','this_year','custom'].includes(filters.period)) return filters.period;
  if (!filters.from && !filters.to) return 'all';
  for (const period of ['this_month','last_month','this_year']) {
    const range = periodRange(period, todayIso);
    if (filters.from === range.from && filters.to === range.to) return period;
  }
  return 'custom';
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
  const routeFilters = filtersFromRoute(route);
  const advanced = state.settings?.appMode === 'advanced';
  const filters = advanced ? routeFilters : {...routeFilters,accountId:'',categoryId:'',type:'',currency:''};
  const snapshot = reportingSnapshot(state, filters);
  const outstandingTotals = totalsFromOutstanding(snapshot.outstanding);
  const accountMinorTotals={};
  for(const account of snapshot.accounts)accountMinorTotals[account.currency]=sumMinor([accountMinorTotals[account.currency]||0,toMinor(account.balance,account.currency)]);
  const accountTotals=Object.fromEntries(Object.entries(accountMinorTotals).map(([currency,value])=>[currency,fromMinor(value,currency)]));

  const activityRows = Object.entries(snapshot.activity);
  const outstandingRows = snapshot.outstanding.filter(row => !filters.personId || row.personId === filters.personId);
  const todayIso = today();
  const period = activePeriod(filters, todayIso);
  const reportPeriod = filters.from || filters.to ? `${filters.from || 'Beginning'} → ${filters.to || 'Today'}` : 'All time';
  const advancedFilterCount = advanced ? [filters.accountId,filters.categoryId,filters.type,filters.currency].filter(Boolean).length : 0;
  const hasAnyFilter = Boolean(filters.from || filters.to || filters.personId || filters.q || advancedFilterCount);

  main.innerHTML = `
    <div class="reports-page">
      <div class="report-toolbar">
        <p class="muted">Current balances and activity, with simple filters when you need them. PDF and Excel exports are generated entirely on this device and remain available offline.</p>
        <div class="report-export-menu-wrap">
          <button class="report-export-trigger" id="reportExportTrigger" type="button" aria-label="Export report" aria-haspopup="menu" aria-expanded="false">•••</button>
          <div class="report-export-menu" id="reportExportMenu" role="menu" hidden>
            <button type="button" id="exportPdf" role="menuitem"><span>PDF report</span><small>Download PDF</small></button>
            <button type="button" id="exportXlsx" role="menuitem"><span>Excel workbook</span><small>Download XLSX</small></button>
          </div>
        </div>
      </div>

      <section class="card report-filter-card">
        <div class="report-filter-row">
          <div class="field report-filter-field report-search-field">
            <label>Search</label>
            <input class="input search" id="reportSearch" type="search" inputmode="search" autocomplete="off" placeholder="Merchant, note, person, account…" value="${escapeHtml(filters.q||'')}">
          </div>
          <div class="field report-filter-field">
            <label>Period</label>
            <select class="select" id="reportPeriod">
              <option value="all" ${period==='all'?'selected':''}>All time</option>
              <option value="this_month" ${period==='this_month'?'selected':''}>This month</option>
              <option value="last_month" ${period==='last_month'?'selected':''}>Last month</option>
              <option value="this_year" ${period==='this_year'?'selected':''}>This year</option>
              <option value="custom" ${period==='custom'?'selected':''}>Custom dates</option>
            </select>
          </div>
          <div class="field report-filter-field">
            <label>Person</label>
            <select class="select" id="reportPerson"><option value="">All people</option>${state.people.map(p=>`<option value="${p.id}" ${filters.personId===p.id?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}</select>
          </div>
          <button class="report-reset" id="clearReportFilters" type="button" ${hasAnyFilter?'':'hidden'}>Reset</button>
        </div>

        <div class="report-custom-dates" id="reportCustomDates" ${period==='custom'?'':'hidden'}>
          <div class="field"><label>From</label><input class="input" type="date" id="reportFrom" value="${escapeHtml(filters.from)}"></div>
          <div class="field"><label>To</label><input class="input" type="date" id="reportTo" value="${escapeHtml(filters.to)}"></div>
          <button class="btn primary" id="applyCustomDates" type="button">Apply dates</button>
        </div>

        ${advanced?`<details class="report-more-filters" ${advancedFilterCount?'open':''}>
          <summary>More filters${advancedFilterCount?` <span>${advancedFilterCount}</span>`:''}</summary>
          <div class="report-more-grid">
            <div class="field"><label>Account</label><select class="select" id="reportAccount"><option value="">All accounts</option>${state.accounts.map(a=>`<option value="${a.id}" ${filters.accountId===a.id?'selected':''}>${escapeHtml(a.name)} · ${escapeHtml(a.currency)}</option>`).join('')}</select></div>
            <div class="field"><label>Category</label><select class="select" id="reportCategory"><option value="">All categories</option>${(state.categories||[]).map(cat=>`<option value="${cat.id}" ${filters.categoryId===cat.id?'selected':''}>${escapeHtml((cat.icon?cat.icon+' ':'')+cat.name)}</option>`).join('')}</select></div>
            <div class="field"><label>Type</label><select class="select" id="reportType"><option value="">All types</option>${['paid_for_person','received_from_person','borrowed_from_person','paid_to_person','person_adjustment','split_paid_for_people','account_expense','account_income','account_adjustment','account_transfer'].map(type=>`<option value="${type}" ${filters.type===type?'selected':''}>${escapeHtml(type.replaceAll('_',' '))}</option>`).join('')}</select></div>
            <div class="field"><label>Currency</label><select class="select" id="reportCurrency"><option value="">All currencies</option>${[...new Set([state.settings.defaultCurrency,...state.accounts.map(a=>a.currency),...state.entries.map(e=>e.currency).filter(Boolean)])].map(currency=>`<option value="${currency}" ${filters.currency===currency?'selected':''}>${escapeHtml(currency)}</option>`).join('')}</select></div>
          </div>
        </details>`:''}
        <div class="report-period-note">Activity: ${escapeHtml(reportPeriod)} · balances are current.</div>
      </section>

      <div class="grid stats report-stats">
      <div class="card stat"><div class="stat-top"><div class="stat-label">TRANSACTIONS IN PERIOD</div><div class="stat-icon">#</div></div><div class="stat-value">${snapshot.transactionCount}</div><div class="stat-note">Matching the active report filters</div></div>
      <div class="card stat good"><div class="stat-top"><div class="stat-label">CURRENTLY OWED TO ME</div><div class="stat-icon">↗</div></div><div class="stat-value">${moneyLines(outstandingTotals,'owedToMe',money)}</div><div class="stat-note">Current positive person balances</div></div>
      <div class="card stat bad"><div class="stat-top"><div class="stat-label">I CURRENTLY OWE</div><div class="stat-icon">↘</div></div><div class="stat-value">${moneyLines(outstandingTotals,'iOwe',money)}</div><div class="stat-note">Current negative person balances</div></div>
      <div class="card stat"><div class="stat-top"><div class="stat-label">ACCOUNT BALANCES</div><div class="stat-icon">▣</div></div><div class="stat-value">${Object.keys(accountTotals).length ? Object.entries(accountTotals).map(([currency,value])=>`<div>${money(value,currency)}</div>`).join('') : '0'}</div><div class="stat-note">Current banks, cash and wallets</div></div>
    </div>

      <section class="card panel report-panel">
        <div class="panel-head"><div><h3>Activity by currency</h3><p>What moved during the selected period</p></div></div>
        ${activityRows.length ? `<div class="table-wrap report-table-wrap mobile-card-table-wrap"><table class="table mobile-card-table"><thead><tr><th>Currency</th><th class="right">Paid for people</th><th class="right">Recovered</th><th class="right">Borrowed</th><th class="right">Repaid</th><th class="right">Net person change</th></tr></thead><tbody>${activityRows.map(([currency,v])=>`<tr><td data-label="Currency" data-mobile-wide="true"><strong>${escapeHtml(currency)}</strong></td><td data-label="Paid for people" class="right">${money(v.charged,currency)}</td><td data-label="Recovered" class="right">${money(v.recovered,currency)}</td><td data-label="Borrowed" class="right">${money(v.borrowed,currency)}</td><td data-label="Repaid" class="right">${money(v.repaid,currency)}</td><td data-label="Net person change" class="right strong">${money(v.netPersonChange,currency)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><strong>No activity in this period</strong>Change the report filters or add transactions.</div>'}
      </section>

    <section class="card panel report-panel">
      <div class="panel-head"><div><h3>Personal spending by category</h3><p>Only account expenses in the selected period; money exchanged with people is excluded.</p></div></div>
      ${snapshot.categorySpending.length ? `<div class="table-wrap report-table-wrap mobile-card-table-wrap"><table class="table mobile-card-table"><thead><tr><th>Category</th><th>Currency</th><th class="right">Transactions</th><th class="right">Amount</th></tr></thead><tbody>${snapshot.categorySpending.map(row=>`<tr><td data-label="Category" data-mobile-wide="true"><strong>${escapeHtml((row.categoryIcon?row.categoryIcon+' ':'')+row.categoryName)}</strong></td><td data-label="Currency">${escapeHtml(row.currency)}</td><td data-label="Transactions" class="right">${row.count}</td><td data-label="Amount" class="right strong">${money(row.amount,row.currency)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No personal account expenses in this period.</div>'}
    </section>

    <section class="card panel report-panel">
      <div class="panel-head"><div><h3>Recorded FX rates</h3><p>Cross-currency transfers use the exact amounts recorded on each transaction. No live rate is fetched or guessed offline.</p></div></div>
      ${snapshot.fxRates?.length ? `<div class="table-wrap report-table-wrap mobile-card-table-wrap"><table class="table mobile-card-table"><thead><tr><th>Date</th><th>Pair</th><th class="right">From</th><th class="right">To</th><th class="right">Rate</th></tr></thead><tbody>${snapshot.fxRates.slice().reverse().map(row=>`<tr><td data-label="Date" data-mobile-wide="true">${escapeHtml(row.date)}</td><td data-label="Pair"><strong>${escapeHtml(row.pair)}</strong></td><td data-label="From" class="right">${money(row.fromAmount,row.fromCurrency)}</td><td data-label="To" class="right">${money(row.toAmount,row.toCurrency)}</td><td data-label="Rate" class="right strong">1 ${escapeHtml(row.fromCurrency)} = ${Number(row.rate).toLocaleString('en-US',{maximumFractionDigits:8})} ${escapeHtml(row.toCurrency)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No cross-currency transfers in this report period.</div>'}
      <div class="muted tiny" style="margin-top:10px">Currencies remain separate everywhere else in reports and balances.</div>
    </section>

    <section class="card panel report-panel">
      <div class="panel-head"><div><h3>Current outstanding balances</h3><p>Who owes whom right now</p></div></div>
      ${outstandingRows.length ? `<div class="table-wrap report-table-wrap mobile-card-table-wrap"><table class="table mobile-card-table"><thead><tr><th>Person</th><th>Direction</th><th>Currency</th><th class="right">Amount</th></tr></thead><tbody>${outstandingRows.map(row=>`<tr><td data-label="Person" data-mobile-wide="true"><strong>${escapeHtml(row.personName)}</strong></td><td data-label="Direction"><span class="pill ${row.amount>0?'green':'red'}">${row.amount>0?'Owes you':'You owe'}</span></td><td data-label="Currency">${escapeHtml(row.currency)}</td><td data-label="Amount" class="right strong">${money(Math.abs(row.amount),row.currency)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><strong>All settled</strong>No current outstanding balances match this view.</div>'}
    </section>
    <div class="grid section-grid report-section-grid">
      ${[
        ['Receivables movement',snapshot.receivablesMovement,'Monthly person-balance changes, including repayments and adjustments.'],
        ['Personal cash flow',snapshot.cashFlow,'Monthly account income minus personal expenses; excludes money exchanged with people and transfers.'],
        ['Transfer flow',snapshot.transferFlow,'Monthly outgoing and incoming transfer legs by currency. Same-currency transfers cancel; no currency conversion is applied.']
      ].map(([label,series,description])=>`<section class="card panel"><div class="panel-head"><div><h3>${label}</h3><p>${description}</p></div></div>
      ${series.length?`<div class="table-wrap report-table-wrap mobile-card-table-wrap"><table class="table mobile-card-table"><thead><tr><th>Month</th><th>Currency</th><th class="right">Net movement</th></tr></thead><tbody>${series.flatMap(row=>Object.entries(row.currencies).map(([currency,value])=>`<tr><td data-label="Month" data-mobile-wide="true">${escapeHtml(row.month)}</td><td data-label="Currency">${escapeHtml(currency)}</td><td data-label="Net movement" class="right strong">${money(value,currency)}</td></tr>`)).join('')}</tbody></table></div>`:'<div class="empty">No activity for this measure in this view.</div>'}</section>`).join('')}
      <section class="card panel"><div class="panel-head"><div><h3>Budgets</h3><p>Configured monthly limits</p></div></div>
      ${snapshot.budgets.length?`<div class="table-wrap report-table-wrap mobile-card-table-wrap"><table class="table mobile-card-table"><thead><tr><th>Category</th><th>Currency</th><th class="right">Monthly limit</th></tr></thead><tbody>${snapshot.budgets.map(row=>`<tr><td data-label="Category" data-mobile-wide="true">${escapeHtml(row.categoryName)}</td><td data-label="Currency">${escapeHtml(row.currency)}</td><td data-label="Monthly limit" class="right strong">${money(row.monthlyLimit,row.currency)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No budgets configured.</div>'}</section>
    </div>
    </div>
  `;

  const buildRoute = ({ customDates=false }={}) => {
    const q = new URLSearchParams();
    const selectedPeriod = main.querySelector('#reportPeriod')?.value || 'all';
    let from='';
    let to='';
    if (selectedPeriod === 'custom') {
      from = customDates ? (main.querySelector('#reportFrom')?.value || '') : filters.from;
      to = customDates ? (main.querySelector('#reportTo')?.value || '') : filters.to;
    } else {
      ({from,to} = periodRange(selectedPeriod, todayIso));
    }
    const person = main.querySelector('#reportPerson')?.value || '';
    const account = main.querySelector('#reportAccount')?.value || '';
    const category = main.querySelector('#reportCategory')?.value || '';
    const type = main.querySelector('#reportType')?.value || '';
    const currency = main.querySelector('#reportCurrency')?.value || '';
    const textQuery = main.querySelector('#reportSearch')?.value.trim() || '';
    if (textQuery) q.set('q', textQuery);
    if (selectedPeriod !== 'all') q.set('period', selectedPeriod);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (person) q.set('person', person);
    if (account) q.set('account', account);
    if (category) q.set('category', category);
    if (type) q.set('type', type);
    if (currency) q.set('currency', currency);
    return `#reports${q.toString() ? '?' + q : ''}`;
  };

  const applyInstantFilters = () => { location.hash = buildRoute(); };
  const periodSelect = main.querySelector('#reportPeriod');
  const customDates = main.querySelector('#reportCustomDates');
  periodSelect?.addEventListener('change', () => {
    const custom = periodSelect.value === 'custom';
    if (custom) {
      customDates.hidden = false;
      requestAnimationFrame(()=>main.querySelector('#reportFrom')?.focus());
      return;
    }
    applyInstantFilters();
  });
  main.querySelector('#reportPerson')?.addEventListener('change', applyInstantFilters);
  main.querySelector('#reportSearch')?.addEventListener('input', event=>{clearTimeout(event.currentTarget._filterTimer);event.currentTarget._filterTimer=setTimeout(applyInstantFilters,180);});
  ['#reportAccount','#reportCategory','#reportType','#reportCurrency'].forEach(selector=>main.querySelector(selector)?.addEventListener('change', applyInstantFilters));
  main.querySelector('#applyCustomDates')?.addEventListener('click', () => { location.hash = buildRoute({customDates:true}); });
  main.querySelector('#clearReportFilters')?.addEventListener('click', () => { location.hash = '#reports'; });

  const exportTrigger = main.querySelector('#reportExportTrigger');
  const exportMenu = main.querySelector('#reportExportMenu');
  const closeExportMenu = () => {
    if (!exportMenu || !exportTrigger) return;
    exportMenu.hidden = true;
    exportTrigger.setAttribute('aria-expanded','false');
  };
  exportTrigger?.addEventListener('click', event => {
    event.stopPropagation();
    const open = exportMenu.hidden;
    exportMenu.hidden = !open;
    exportTrigger.setAttribute('aria-expanded', String(open));
  });
  exportMenu?.addEventListener('click', event => event.stopPropagation());
  main.addEventListener?.('click', closeExportMenu, { once:false });
  exportTrigger?.addEventListener('keydown', event=>{if(event.key==='Escape')closeExportMenu();});

  main.querySelector('#exportXlsx')?.addEventListener('click', () => {
    closeExportMenu();
    const bytes = buildXlsx(workbookSheets(state, filters), { title: `${state.settings?.displayName || 'My Ledger'} report` });
    downloadBytes(`${reportFilename(state,'report',today)}.xlsx`, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });
  main.querySelector('#exportPdf')?.addEventListener('click', () => {
    closeExportMenu();
    const bytes = buildPdfReport(state, snapshot);
    downloadBytes(`${reportFilename(state,'report',today)}.pdf`, bytes, 'application/pdf');
  });
}
