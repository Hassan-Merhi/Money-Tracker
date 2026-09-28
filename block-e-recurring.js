import {
  listRecurringRules,
  updateRecurringRule,
  deleteRecurringRule,
  postRecurringRule,
  skipRecurringRule,
  loadState
} from './lib/store.js';
import { recurringStatus, shouldRemind, recurrenceLabel } from './lib/recurring.js';
import { today, escapeHtml, prettyType } from './lib/utils.js';
import { openRecurringRuleModal, summarizeRecurringTemplate } from './lib/recurring-rule-form.js';

function formatDate(value){
  if(!value) return 'Complete';
  try { return new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric'}).format(new Date(value+'T00:00:00')); }
  catch { return value; }
}
function statusClass(key){ return key==='overdue'?'red':key==='due'?'amber':key==='upcoming'?'blue':''; }
async function refreshRules(){ return (await listRecurringRules()).rules || []; }

function scheduleCard(rule,state){
  const status=recurringStatus(rule,today());
  const disabled=!rule.isActive||!rule.nextDueDate;
  return `<article class="card recurring-card">
    <div class="recurring-card-top"><div>
      <div class="recurring-title-row"><h3>${escapeHtml(rule.title)}</h3><span class="pill ${statusClass(status.key)}">${escapeHtml(status.label)}</span></div>
      <p>${escapeHtml(recurrenceLabel(rule))}${rule.endDate?` · through ${escapeHtml(formatDate(rule.endDate))}`:''}</p>
    </div><button class="icon-btn" data-rule-edit="${rule.id}" aria-label="Edit schedule">✎</button></div>
    <div class="recurring-amount">${summarizeRecurringTemplate(rule.template,state)}</div>
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

async function postRule(rule,state,ctx){
  if(!rule?.nextDueDate||!confirm(`Post “${rule.title}” to the ledger dated ${today()}?`)) return;
  try{
    const result=await postRecurringRule(rule.id,{expectedRevision:state.version,occurrenceDate:rule.nextDueDate,transactionDate:today()});
    ctx.replaceState(result.state);
    ctx.showToast('Recurring transaction posted and next due date advanced.');
  }catch(error){
    if(error.status===409){ try{ctx.replaceState(await loadState());}catch{} }
    ctx.showToast(error.message||'Could not post this recurring transaction.');
  }
}
async function skipRule(rule,ctx,onDone){
  if(!rule?.nextDueDate||!confirm(`Skip the ${rule.nextDueDate} occurrence of “${rule.title}”?`)) return;
  try{ await skipRecurringRule(rule.id,{occurrenceDate:rule.nextDueDate}); ctx.showToast('Occurrence skipped.'); await onDone(); }
  catch(error){ ctx.showToast(error.message||'Could not skip this occurrence.'); }
}
async function toggleRule(rule,ctx,onDone){
  if(!rule) return;
  if(!rule.isActive&&!rule.nextDueDate){ ctx.showToast('Edit this completed schedule and choose a new due date before resuming.'); return; }
  try{ await updateRecurringRule(rule.id,{...rule,isActive:!rule.isActive}); ctx.showToast(rule.isActive?'Schedule paused.':'Schedule resumed.'); await onDone(); }
  catch(error){ ctx.showToast(error.message||'Could not update this schedule.'); }
}
async function removeRule(rule,ctx,onDone){
  if(!rule||!confirm(`Delete the schedule “${rule.title}”? Existing ledger transactions are not changed.`)) return;
  try{ await deleteRecurringRule(rule.id); ctx.showToast('Schedule deleted.'); await onDone(); }
  catch(error){ ctx.showToast(error.message||'Could not delete this schedule.'); }
}
function browserAlertButton(){
  if(!('Notification' in window)) return '<span class="muted tiny">Browser alerts are not supported here.</span>';
  if(Notification.permission==='granted') return '<button class="btn small" id="recurringNotify">Browser alerts enabled</button>';
  if(Notification.permission==='denied') return '<span class="muted tiny">Browser alerts are blocked in browser settings.</span>';
  return '<button class="btn small" id="recurringNotify">Enable browser alerts</button>';
}
function maybeNotify(rules){
  if(!('Notification' in window)||Notification.permission!=='granted') return;
  const attention=rules.filter(rule=>shouldRemind(rule,today()));
  if(!attention.length) return;
  const key='money-tracker-recurring-alert-'+today();
  if(localStorage.getItem(key)) return;
  localStorage.setItem(key,'1');
  const body=attention.length===1?`${attention[0].title} is due ${formatDate(attention[0].nextDueDate)}.`:`${attention.length} recurring items need your attention.`;
  new Notification('Money Tracker reminders',{body});
}

export async function renderRecurringPage(main,state,ctx){
  main.innerHTML='<div class="card panel"><div class="empty">Loading recurring schedules…</div></div>';
  let rules;
  try{ rules=await refreshRules(); }catch(error){ main.innerHTML=`<div class="card panel"><div class="warning">${escapeHtml(error.message||'Could not load recurring schedules.')}</div></div>`; return; }
  const attention=rules.filter(rule=>shouldRemind(rule,today())).length;
  const active=rules.filter(rule=>rule.isActive).length;
  const reload=()=>renderRecurringPage(main,state,ctx);
  main.innerHTML=`
    <div class="recurring-toolbar">
      <div class="grid stats recurring-stats">
        <div class="card stat ${attention?'bad':''}"><div class="stat-label">NEEDS ATTENTION</div><div class="stat-value">${attention}</div><div class="stat-note">Due, overdue, or inside reminder window</div></div>
        <div class="card stat"><div class="stat-label">ACTIVE SCHEDULES</div><div class="stat-value">${active}</div><div class="stat-note">${rules.length-active} paused or complete</div></div>
      </div>
      <div class="recurring-toolbar-actions">${browserAlertButton()}<button class="btn primary" id="newRecurring">＋ New schedule</button></div>
    </div>
    <div class="card panel recurring-note"><strong>Review before posting.</strong><span>Schedules never silently change your ledger. “Post now” creates the real transaction and advances the next due date atomically.</span></div>
    ${rules.length?`<div class="recurring-grid">${rules.map(rule=>scheduleCard(rule,state)).join('')}</div>`:`<div class="card hero-empty empty"><div class="big">⏰</div><h3>Create your first recurring schedule</h3><p>Use schedules for repeat repayments, purchases, transfers, and other regular money movements.</p><button class="btn primary" id="emptyRecurring">＋ New schedule</button></div>`}`;
  const openNew=()=>openRecurringRuleModal(null,state,ctx,reload);
  main.querySelector('#newRecurring')?.addEventListener('click',openNew);
  main.querySelector('#emptyRecurring')?.addEventListener('click',openNew);
  main.querySelector('#recurringNotify')?.addEventListener('click',async()=>{ if(!('Notification' in window))return; const p=await Notification.requestPermission(); if(p==='granted'){ctx.showToast('Browser alerts enabled while Money Tracker is open.');maybeNotify(rules);} reload(); });
  main.querySelectorAll('[data-rule-edit]').forEach(b=>b.addEventListener('click',()=>openRecurringRuleModal(rules.find(r=>r.id===b.dataset.ruleEdit),state,ctx,reload)));
  main.querySelectorAll('[data-rule-post]').forEach(b=>b.addEventListener('click',()=>postRule(rules.find(r=>r.id===b.dataset.rulePost),state,ctx)));
  main.querySelectorAll('[data-rule-skip]').forEach(b=>b.addEventListener('click',()=>skipRule(rules.find(r=>r.id===b.dataset.ruleSkip),ctx,reload)));
  main.querySelectorAll('[data-rule-toggle]').forEach(b=>b.addEventListener('click',()=>toggleRule(rules.find(r=>r.id===b.dataset.ruleToggle),ctx,reload)));
  main.querySelectorAll('[data-rule-delete]').forEach(b=>b.addEventListener('click',()=>removeRule(rules.find(r=>r.id===b.dataset.ruleDelete),ctx,reload)));
  maybeNotify(rules);
}

export async function mountRecurringDashboardWidget(host,state,ctx){
  if(!host) return;
  try{
    const rules=await refreshRules();
    const attention=rules.filter(rule=>shouldRemind(rule,today())).sort((a,b)=>(a.nextDueDate||'9999').localeCompare(b.nextDueDate||'9999')).slice(0,4);
    host.innerHTML=`<div class="panel-head"><div><h3>Scheduled reminders</h3><p>${attention.length?`${attention.length} item${attention.length===1?'':'s'} need attention`:'Nothing due inside your reminder windows'}</p></div><button class="btn small" id="dashboardSchedules">Manage</button></div>
      ${attention.length?`<div class="dashboard-reminders">${attention.map(rule=>{const status=recurringStatus(rule,today());return `<div class="dashboard-reminder"><div><strong>${escapeHtml(rule.title)} <span class="pill ${statusClass(status.key)}">${escapeHtml(status.label)}</span></strong><div class="muted tiny">${summarizeRecurringTemplate(rule.template,state)}</div></div><button class="btn small primary" data-dashboard-post="${rule.id}">Post</button></div>`;}).join('')}</div>`:'<div class="muted">Create schedules for repeat payments, purchases, and transfers.</div>'}`;
    host.querySelector('#dashboardSchedules')?.addEventListener('click',()=>location.hash='#scheduled');
    host.querySelectorAll('[data-dashboard-post]').forEach(b=>b.addEventListener('click',()=>postRule(rules.find(r=>r.id===b.dataset.dashboardPost),state,ctx)));
    maybeNotify(rules);
  }catch(error){ host.innerHTML=`<div class="muted">Scheduled reminders unavailable: ${escapeHtml(error.message||'load error')}</div>`; }
}
