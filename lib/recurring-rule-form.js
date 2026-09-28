import { createRecurringRule, updateRecurringRule } from './store.js';
import { CURRENCIES, money, today, escapeHtml } from './utils.js';
import { SPLIT_ENTRY_TYPE, validateSplit } from './ledger.js';

function account(state,id){ return state.accounts.find(a=>a.id===id); }
function person(state,id){ return state.people.find(p=>p.id===id); }
function accountOptions(state,selected){
  return state.accounts.map(a=>`<option value="${a.id}" ${a.id===selected?'selected':''}>${escapeHtml(a.name)} · ${a.currency}</option>`).join('');
}
function personOptions(state,selected){
  return state.people.map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${escapeHtml(p.name)}</option>`).join('');
}
function currencyOptions(selected){
  return CURRENCIES.map(c=>`<option value="${c}" ${c===selected?'selected':''}>${c}</option>`).join('');
}

export function summarizeRecurringTemplate(t={},state){
  if(t.type==='account_transfer'){
    const from=account(state,t.fromAccountId), to=account(state,t.toAccountId);
    return `${money(t.fromAmount,from?.currency||'USD')} ${escapeHtml(from?.name||'Unknown account')} → ${money(t.toAmount,to?.currency||'USD')} ${escapeHtml(to?.name||'Unknown account')}`;
  }
  if(t.type===SPLIT_ENTRY_TYPE){
    return `${money(t.amount,t.currency||account(state,t.accountId)?.currency||state.settings.defaultCurrency)} split between ${(t.splits||[]).length} people · ${escapeHtml(account(state,t.accountId)?.name||'Unknown account')}`;
  }
  const p=person(state,t.personId), a=account(state,t.accountId);
  return `${money(t.amount,t.currency||a?.currency||state.settings.defaultCurrency)} · ${escapeHtml(p?.name||'Unknown person')}${a?` · ${escapeHtml(a.name)}`:''}`;
}

function splitRow(state,split,index){
  return `<div class="split-row" data-rsplit-row>
    <select class="select" data-rsplit-person><option value="">Choose person</option>${personOptions(state,split.personId)}</select>
    <input class="input" data-rsplit-amount type="number" min="0.01" step="0.01" value="${split.amount??''}" placeholder="Amount">
    <input class="input split-note" data-rsplit-note maxlength="180" value="${escapeHtml(split.note||'')}" placeholder="Note (optional)">
    <button class="icon-btn" type="button" data-rsplit-remove="${index}" aria-label="Remove split">×</button>
  </div>`;
}

export function openRecurringRuleModal(existing,state,ctx,onSaved){
  if(!state.people.length){ctx.showToast('Add at least one person before creating a recurring schedule.');return;}
  const t=existing?.template||{};
  const defaultPerson=t.personId||state.people[0]?.id||'';
  const defaultAccount=t.accountId||state.accounts[0]?.id||'';
  const type=t.type||'paid_for_person';
  const defaultCurrency=t.currency||account(state,defaultAccount)?.currency||state.settings.defaultCurrency;
  const initialSplits=t.splits?.length?t.splits:state.people.slice(0,2).map(p=>({personId:p.id,amount:'',note:''}));
  const frequency=existing?.frequency||'monthly';
  ctx.openModal(existing?'Edit recurring schedule':'New recurring schedule',`<form id="recurringForm" class="form-grid recurring-form">
    <div class="field span-2"><label>Schedule name</label><input class="input" name="title" maxlength="100" required value="${escapeHtml(existing?.title||'')}" placeholder="e.g. Monthly cousin Amazon order"></div>
    <div class="field"><label>Repeat</label><select class="select" name="frequency"><option value="daily" ${frequency==='daily'?'selected':''}>Daily</option><option value="weekly" ${frequency==='weekly'?'selected':''}>Weekly</option><option value="monthly" ${frequency==='monthly'?'selected':''}>Monthly</option><option value="yearly" ${frequency==='yearly'?'selected':''}>Yearly</option></select></div>
    <div class="field"><label>Every</label><input class="input" name="interval" type="number" min="1" max="99" step="1" required value="${existing?.interval||1}"><div class="muted tiny">Number of repeat periods</div></div>
    <div class="field"><label>Next due date</label><input class="input" name="nextDueDate" type="date" required value="${existing?.nextDueDate||today()}"></div>
    <div class="field"><label>End date</label><input class="input" name="endDate" type="date" value="${existing?.endDate||''}"><div class="muted tiny">Optional</div></div>
    <div class="field span-2"><label>Remind me</label><select class="select" name="remindDaysBefore">${[0,1,2,3,5,7,14,30].map(n=>`<option value="${n}" ${Number(existing?.remindDaysBefore||0)===n?'selected':''}>${n===0?'On the due date':`${n} day${n===1?'':'s'} before`}</option>`).join('')}</select></div>
    <div class="field span-2 recurring-divider"><strong>Ledger transaction template</strong><span>Nothing posts automatically. Review each occurrence before posting.</span></div>
    <div class="field span-2"><label>Transaction type</label><select class="select" name="type" id="recurringType">
      <option value="paid_for_person" ${type==='paid_for_person'?'selected':''}>Paid for someone</option>
      <option value="${SPLIT_ENTRY_TYPE}" ${type===SPLIT_ENTRY_TYPE?'selected':''}>Split purchase</option>
      <option value="received_from_person" ${type==='received_from_person'?'selected':''}>Received repayment</option>
      <option value="borrowed_from_person" ${type==='borrowed_from_person'?'selected':''}>Borrowed from person</option>
      <option value="paid_to_person" ${type==='paid_to_person'?'selected':''}>Paid person back</option>
      <option value="person_adjustment" ${type==='person_adjustment'?'selected':''}>Balance adjustment</option>
      <option value="account_transfer" ${type==='account_transfer'?'selected':''}>Account transfer</option>
    </select></div>
    <div class="field" id="rPersonField"><label>Person</label><select class="select" name="personId"><option value="">Choose person</option>${personOptions(state,defaultPerson)}</select></div>
    <div class="field" id="rAccountField"><label>Account / cash</label><select class="select" name="accountId"><option value="">Choose account</option>${accountOptions(state,defaultAccount)}</select></div>
    <div class="field" id="rAmountField"><label>Amount</label><input class="input" id="rAmount" name="amount" type="number" min="0.01" step="0.01" value="${t.amount??''}" placeholder="0.00"></div>
    <div class="field" id="rCurrencyField"><label>Currency</label><select class="select" name="currency">${currencyOptions(defaultCurrency)}</select></div>
    <div class="field span-2" id="rDirectionField"><label>Adjustment means</label><select class="select" name="direction"><option value="to_me" ${(t.signedAmount??1)>=0?'selected':''}>They owe me more</option><option value="i_owe" ${(t.signedAmount??1)<0?'selected':''}>I owe them more</option></select></div>
    <div class="field" id="rFromField"><label>From account</label><select class="select" name="fromAccountId"><option value="">Choose account</option>${accountOptions(state,t.fromAccountId)}</select></div>
    <div class="field" id="rToField"><label>To account</label><select class="select" name="toAccountId"><option value="">Choose account</option>${accountOptions(state,t.toAccountId)}</select></div>
    <div class="field" id="rFromAmountField"><label>Amount leaving source</label><input class="input" name="fromAmount" type="number" min="0.01" step="0.01" value="${t.fromAmount??''}"></div>
    <div class="field" id="rToAmountField"><label>Amount arriving destination</label><input class="input" name="toAmount" type="number" min="0.01" step="0.01" value="${t.toAmount??''}"></div>
    <div class="field span-2" id="rSplitField">
      <div class="split-head"><div><label>Split between people</label><div class="muted tiny">The account is charged once; each person receives only their allocation.</div></div><div class="page-actions"><button class="btn small" type="button" id="rEqualSplit">Equal split</button><button class="btn small" type="button" id="rAddSplit">＋ Person</button></div></div>
      <div class="split-list" id="rSplitRows">${initialSplits.map((x,i)=>splitRow(state,x,i)).join('')}</div><div class="split-total" id="rSplitTotal"></div>
    </div>
    <div class="field"><label>Merchant / source</label><input class="input" name="merchant" maxlength="100" value="${escapeHtml(t.merchant||'')}" placeholder="e.g. Amazon"></div>
    <div class="field"><label>Note</label><input class="input" name="description" maxlength="500" value="${escapeHtml(t.description||'')}" placeholder="Recurring details"></div>
  </form>`,()=>document.querySelector('#recurringForm')?.requestSubmit());

  const form=document.querySelector('#recurringForm');
  const typeEl=form.querySelector('#recurringType');
  const amountEl=form.querySelector('#rAmount');
  const rows=form.querySelector('#rSplitRows');
  const readSplits=()=>[...rows.querySelectorAll('[data-rsplit-row]')].map(row=>({
    personId:row.querySelector('[data-rsplit-person]').value,
    amount:Number(row.querySelector('[data-rsplit-amount]').value||0),
    note:row.querySelector('[data-rsplit-note]').value.trim()
  }));
  const updateSplitTotal=()=>{
    const total=Number(amountEl.value||0),sum=readSplits().reduce((n,x)=>n+Number(x.amount||0),0),diff=total-sum;
    form.querySelector('#rSplitTotal').innerHTML=`Allocated <strong>${sum.toFixed(2)}</strong> of <strong>${total.toFixed(2)}</strong> · <span class="${Math.abs(diff)<=0.005?'amount-pos':'amount-neg'}">${Math.abs(diff)<=0.005?'Balanced':`${diff>0?'Remaining':'Over'} ${Math.abs(diff).toFixed(2)}`}</span>`;
  };
  const bindRows=()=>{
    rows.querySelectorAll('input,select').forEach(el=>el.addEventListener('input',updateSplitTotal));
    rows.querySelectorAll('[data-rsplit-remove]').forEach(button=>button.addEventListener('click',()=>{
      const draft=readSplits();draft.splice(Number(button.dataset.rsplitRemove),1);rows.innerHTML=draft.map((x,i)=>splitRow(state,x,i)).join('');bindRows();updateSplitTotal();
    }));
  };
  bindRows(); amountEl.addEventListener('input',updateSplitTotal);
  form.querySelector('#rAddSplit').addEventListener('click',()=>{const draft=readSplits();draft.push({personId:'',amount:'',note:''});rows.innerHTML=draft.map((x,i)=>splitRow(state,x,i)).join('');bindRows();updateSplitTotal();});
  form.querySelector('#rEqualSplit').addEventListener('click',()=>{
    const list=[...rows.querySelectorAll('[data-rsplit-row]')],total=Number(amountEl.value||0);
    if(!list.length||!(total>0)){ctx.showToast('Enter the total amount first.');return;}
    const cents=Math.round(total*100),base=Math.floor(cents/list.length),rem=cents-base*list.length;
    list.forEach((row,i)=>row.querySelector('[data-rsplit-amount]').value=((base+(i<rem?1:0))/100).toFixed(2));updateSplitTotal();
  });
  const sync=()=>{
    const kind=typeEl.value,transfer=kind==='account_transfer',split=kind===SPLIT_ENTRY_TYPE,adjust=kind==='person_adjustment';
    form.querySelector('#rPersonField').hidden=transfer||split;
    form.querySelector('#rAccountField').hidden=transfer||adjust;
    form.querySelector('#rAmountField').hidden=transfer;
    form.querySelector('#rCurrencyField').hidden=!adjust;
    form.querySelector('#rDirectionField').hidden=!adjust;
    for(const id of ['#rFromField','#rToField','#rFromAmountField','#rToAmountField']) form.querySelector(id).hidden=!transfer;
    form.querySelector('#rSplitField').hidden=!split;
    if(split) updateSplitTotal();
  };
  typeEl.addEventListener('change',sync);sync();

  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const fd=new FormData(form),kind=fd.get('type'),amount=Number(fd.get('amount')||0);
    let template={type:kind,merchant:fd.get('merchant').trim(),description:fd.get('description').trim()};
    if(kind==='account_transfer'){
      const from=fd.get('fromAccountId'),to=fd.get('toAccountId'),fromAmount=Number(fd.get('fromAmount')),toAmount=Number(fd.get('toAmount'));
      if(!from||!to||from===to||!(fromAmount>0)||!(toAmount>0)){ctx.showToast('Choose two different accounts and enter both transfer amounts.');return;}
      template={...template,fromAccountId:from,toAccountId:to,fromAmount,toAmount,amount:fromAmount};
    }else if(kind===SPLIT_ENTRY_TYPE){
      const splits=readSplits(),error=validateSplit(splits,amount);
      if(error){ctx.showToast(error);return;}
      if(!fd.get('accountId')){ctx.showToast('Choose the account used for this split.');return;}
      template={...template,accountId:fd.get('accountId'),amount,splits};
    }else{
      if(!fd.get('personId')){ctx.showToast('Choose a person.');return;}
      if(!(amount>0)){ctx.showToast('Enter an amount greater than zero.');return;}
      template={...template,personId:fd.get('personId'),amount};
      if(kind==='person_adjustment') template={...template,currency:fd.get('currency'),signedAmount:(fd.get('direction')==='i_owe'?-1:1)*amount};
      else{
        if(!fd.get('accountId')){ctx.showToast('Choose an account or cash source.');return;}
        template.accountId=fd.get('accountId');
      }
    }
    const nextDueDate=fd.get('nextDueDate');
    const rule={
      title:fd.get('title').trim(),
      frequency:fd.get('frequency'),
      interval:Number(fd.get('interval')),
      nextDueDate,
      endDate:fd.get('endDate')||null,
      remindDaysBefore:Number(fd.get('remindDaysBefore')),
      isActive:existing?.isActive!==false,
      anchorDate:existing&&existing.nextDueDate===nextDueDate?existing.anchorDate:nextDueDate,
      template
    };
    try{
      if(existing) await updateRecurringRule(existing.id,rule); else await createRecurringRule(rule);
      ctx.closeModal();ctx.showToast(existing?'Schedule updated.':'Recurring schedule created.');await onSaved?.();
    }catch(error){ctx.showToast(error.message||'Could not save this recurring schedule.');}
  });
}
