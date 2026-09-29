import { escapeHtml, money, prettyType } from './utils.js';
import { PERSON_ENTRY_TYPES, SPLIT_ENTRY_TYPE } from './ledger.js';

// Small, local SVGs keep the shell consistent without fonts or external requests.
export function icon(name) {
  const paths = {
    dashboard: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3"/>',
    accounts: '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18m-6 5h3"/>',
    transactions: '<path d="M7 3v18m-4-4 4 4 4-4M17 21V3m-4 4 4-4 4 4"/>',
    bank: '<path d="m3 8 9-5 9 5H3Zm2 3v7m7-7v7m7-7v7M3 21h18"/>',
    insights: '<path d="M4 3v18h17M9 16v-5m5 5V7m5 9v-3"/>',
    scheduled: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5h3"/>',
    reports: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 13h8m-8 4h5"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    up: '<path d="M6 18 18 6M6 6h12v12"/>',
    down: '<path d="M18 6 6 18M6 6v12h12"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    net: '<path d="M4 8h16M4 16h16m-4-4 4 4-4 4M8 4 4 8l4 4"/>',
  };
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.dashboard}</svg>`;
}

export function mobilePages(advanced) {
  return advanced ? ['dashboard', 'people', 'transactions', 'accounts'] : ['dashboard', 'people', 'transactions', 'reports', 'settings'];
}

export function recentDebtEntries(entries) {
  return entries.filter(e => PERSON_ENTRY_TYPES.includes(e.type))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 6);
}

export function activityMarkup(entries, people) {
  const names = new Map(people.map(p => [p.id, p.name]));
  return `<ul class="activity-list">${entries.map(e => {
    const split = e.type === SPLIT_ENTRY_TYPE;
    const name = split ? (e.splits || []).map(s => names.get(s.personId) || 'Unknown').join(', ') : names.get(e.personId) || 'Unknown';
    const received = ['received_from_person', 'paid_to_person'].includes(e.type);
    const label = prettyType(e.type);
    return `<li><button class="activity-row" data-dashboard-entry="${escapeHtml(e.id)}" aria-label="${escapeHtml(`View ${label}: ${name}, ${money(e.amount, e.currency)}, ${e.date}`)}">
      <span class="activity-icon ${received ? 'settlement' : ''}">${icon(split ? 'people' : received ? 'check' : 'transactions')}</span>
      <span class="activity-detail"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(e.description || label)}</span><small>${escapeHtml(label)}${e.attachmentCount ? ` · ${e.attachmentCount} attachment${e.attachmentCount === 1 ? '' : 's'}` : ''}</small></span>
      <span class="activity-amount"><strong>${escapeHtml(money(e.amount, e.currency))}</strong><time datetime="${escapeHtml(e.date)}">${escapeHtml(e.date)}</time></span>
      <span class="activity-arrow">${icon('arrow')}</span>
    </button></li>`;
  }).join('')}</ul>`;
}

export function peopleOverviewMarkup(people, balances) {
  // Keep currencies separate: never rank or net people across unlike currencies.
  const outstanding = people.filter(p => Object.values(balances[p.id] || {}).some(v => v !== 0))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { count: outstanding.length, markup: outstanding.slice(0, 4).map(p => `<a class="overview-person" href="#person?id=${encodeURIComponent(p.id)}">
    <span class="avatar">${escapeHtml(p.name.slice(0, 2).toUpperCase())}</span>
    <span class="overview-person-name"><strong>${escapeHtml(p.name)}</strong><small>View statement</small></span>
    <span class="overview-balances">${Object.entries(balances[p.id]).filter(([, v]) => v !== 0).map(([currency, value]) => `<span class="${value > 0 ? 'amount-pos' : 'amount-neg'}">${escapeHtml(money(Math.abs(value), currency))}<small>${value > 0 ? 'Owes you' : 'You owe'}</small></span>`).join('')}</span>
  </a>`).join('') };
}
