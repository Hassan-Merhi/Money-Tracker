import {
  listRecurringRules,
  createRecurringRule,
  updateRecurringRule,
  deleteRecurringRule,
  postRecurringRule,
  skipRecurringRule,
  loadState
} from './lib/store.js';
import { recurringStatus, shouldRemind, recurrenceLabel } from './lib/recurring.js';
import { CURRENCIES, money, today, escapeHtml, prettyType } from './lib/utils.js';
import { SPLIT_ENTRY_TYPE, validateSplit } from './lib/ledger.js';

function accountName(state,id){ return state.accounts.find(a=>a.id===id)?.name || 'Unknown account'; }
function personName(state,id){ return state.people.find(p=>p.id===id)?.name || 'Unknown person'; }
function formatDate(value){
  if(!value) return 'Complete';
  try{return new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric'}).format(new Date(value+'T00:00:00'));}
  catch{return value;}
}
function statusClass(key){ return key==='overdue'?'red':key==='due'?'amber':key==='upcoming'?'blue':''; }

function templateSummary(rule,state){
  const t=rule.template||{};
  if(t.type==='account_transfer') return `${money(t.fromAmount, state.accounts.find(a=>a.id===t.fromAccountId)?.currency||'USD')} ${escapeHtml(accountName(state,t.fromAccountId))} → ${money(t.toAmount,state.accounts.find(a=>a.id===t.toAccountId)?.currency||'USD')} ${escapeHtml(accountName(state,t.toAccountId))}`;
  if(t.type===SPLIT_ENTRY_TYPE) return `${money(t.amount,t.currency)} split between ${(t.splits||[]).length} people · ${escapeHtml(accountName(state,t.accountId))}`;
  const who=personName(state,t.personId), amount=money(t.amount,t.currency||state.settings.defaultCurrency);
  return `${amount} · ${escapeHtml(who)}${t.accountId?` · ${escapeHtml(accountName(state,t.accountId))}`:''}`;
}

function scheduleCard(rule,state){
  const status=recurringStatus(rule,today());
  const disabled=!rule.isActive||!rule.nextDueDate;
  return `<article class="card recurring-card" data-rule-card="${rule.id}">
    <div class="recurring-card-top">
      <div>
        <div class="recurring-title-row"><h3>${escapeHtml(rule.title)}</h3><span class="pill ${statusClass(status.key)}">${escapeHtml(status.label)}</span></div>
        <p>${escapeHtml(recurrenceLabel(rule))}${rule.endDate?` · through ${escapeHtml(formatDate(rule.endDate))}`:''}</p>
      </div>
      <button class="icon-btn" data-rule-edit="${rule.id}" aria-label="Edit schedule">✎</button>
    </div>
    <div class="recurring-amount">${templateSummary(rule,state)}</div>
    <div class="recurring-meta">
      <span><strong>Next:</strong> ${escapeHtml(formatDate(rule.nextDueDate))}</span>
      <span><strong>Reminder:</strong> ${Number(rule.remindDaysBefore||0)===0?'on due date':`${rule.remindDaysBefore} day${rule.remindDaysBefore===1?'':'s'} before`}</span>
      <span><strong>Type:</strong> ${escapeHtml(prettyType(rule.template?.type||''))}</span>
    </div>
    ${rule.lastOccurrenceDate?`<div class="muted tiny recurring-last">Last posted occurrence: ${escapeHtml(formatDate(rule.lastOccurrenceDate))}</div>`:''}
    <div class="recurring-actions">
      <button class="btn primary small" data-rule-post="${rule.id}" ${disabled?'disabled':''}>Post now</button>
      <button class="btn small" data-rule-skip="${rule.id}" ${disabled?'disabled':''}>Skip</button>
      <button class="btn small" data-rule-toggle="${rule.id}">${rule.isActive?'Pause':'Resume'}</button>
      <button class="btn small danger" data-rule-delete="${rule.id}">Delete</button>
    </div>
  </article>`;
}

async function refreshRules(){
  const data=await listRecurringRules();
  return data.rules||[];
}

async function postRule(rule,state,ctx){
  if(!rule.nextDueDate) return;
  if(!confirm(`Post “${rule.title}” to the ledger dated ${today()}?`)) return;
  try{
    const result=await postRecurringRule(rule.id,{expectedRevision:state.version,occurrenceDate:rule.nextDueDate,transactionDate:today()});
    ctx.replaceState(result.state);
    ctx.showToast('Recurring transaction posted and next due date advanced.');
  }catch(error){
    if(error.status===409){
      try{ctx.replaceState(await loadState());}catch{}
    }
    ctx.showToast(error.message||'Could not post this recurring transaction.');
  }
}

async function skipRule(rule,ctx,onDone){
  if(!rule.nextDueDate||!confirm(`Skip the ${rule.nextDueDate} occurrence of “${rule.title}”?`)) return;
  try{await skipRecurringRule(rule.id,{occurrenceDate:rule.nextDueDate});ctx.showToast('Occurrence skipped.');await onDone?.();}
