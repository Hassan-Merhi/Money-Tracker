import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mot-wave100b-'));
process.env.DB_PATH=join(dir,'test.sqlite');
process.env.NODE_ENV='test';
const {server,db}=await import(`../server.mjs?wave100b=${Date.now()}`);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let cookie='',csrf='';

async function request(path,{method='GET',body}={}){
  const headers={Accept:'application/json'};
  if(body!==undefined)headers['content-type']='application/json';
  if(cookie)headers.cookie=cookie;
  if(csrf&&method!=='GET')headers['x-csrf-token']=csrf;
  const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json().catch(()=>({}));
  const setCookie=res.headers.get('set-cookie');
  if(setCookie)cookie=setCookie.split(';')[0];
  return {res,data};
}

function expenseRule(id,title='Offline rent',amount=12,nextDueDate='2026-10-01'){
  return {
    id,title,frequency:'monthly',interval:1,anchorDate:nextDueDate,nextDueDate,endDate:null,
    remindDaysBefore:30,isActive:true,
    template:{type:'account_expense',accountId:'account_wave100b',amount,merchant:'Wave 100B',description:'Recurring offline test'}
  };
}

test('Wave 100B recurring sync is idempotent, conflict-aware and ledger-safe',async()=>{
  const reg=await request('/api/auth/register',{method:'POST',body:{email:`wave100b-${Date.now()}@example.test`,password:'correct horse battery staple'}});
  assert.equal(reg.res.status,201);csrf=reg.data.csrfToken;

  let state=(await request('/api/state')).data;
  let r=await request('/api/accounts',{method:'POST',body:{expectedRevision:state.version,id:'account_wave100b',name:'Wave 100B Bank',type:'bank',currency:'USD',openingBalance:100}});
  assert.equal(r.res.status,201);state=r.data;

  const createOp={
    operationId:'op_wave100b_create_once',action:'create',ruleId:'rule_wave100b_create',reminderId:'',baseUpdatedAt:'',
    payload:expenseRule('rule_wave100b_create','Create once',4)
  };
  const created=await request('/api/sync/recurring',{method:'POST',body:{operation:createOp}});
  assert.equal(created.res.status,201);
  assert.equal(created.data.status,'accepted');
  assert.equal(created.data.rule.id,'rule_wave100b_create');
  const createReplay=await request('/api/sync/recurring',{method:'POST',body:{operation:createOp}});
  assert.equal(createReplay.res.status,200);
  assert.equal(createReplay.data.alreadyProcessed,true);
  let rules=(await request('/api/recurring')).data.rules;
  assert.equal(rules.filter(x=>x.id==='rule_wave100b_create').length,1);

  const reused=await request('/api/sync/recurring',{method:'POST',body:{operation:{...createOp,payload:{...createOp.payload,title:'Different payload'}}}});
  assert.equal(reused.res.status,409);

  const original=rules.find(x=>x.id==='rule_wave100b_create');
  await new Promise(resolve=>setTimeout(resolve,5));
  const remote=await request('/api/recurring/rule_wave100b_create',{method:'PUT',body:{...original,title:'Changed remotely'}});
  assert.equal(remote.res.status,200);
  const staleUpdate={
    operationId:'op_wave100b_stale_update',action:'update',ruleId:'rule_wave100b_create',reminderId:'',
    baseUpdatedAt:original.updatedAt,payload:{...original,title:'Offline stale edit'}
  };
  const stale=await request('/api/sync/recurring',{method:'POST',body:{operation:staleUpdate}});
  assert.equal(stale.res.status,409);
  rules=(await request('/api/recurring')).data.rules;
  assert.equal(rules.find(x=>x.id==='rule_wave100b_create').title,'Changed remotely');

  const postCreate={
    operationId:'op_wave100b_post_rule_create',action:'create',ruleId:'rule_wave100b_post',reminderId:'',baseUpdatedAt:'',
    payload:expenseRule('rule_wave100b_post','Post once',7.5)
  };
  r=await request('/api/sync/recurring',{method:'POST',body:{operation:postCreate}});
  assert.equal(r.res.status,201);
  const postRule=r.data.rule;
  state=(await request('/api/state')).data;
  const beforeVersion=state.version,beforeEntries=state.entries.length;
  const postOp={
    operationId:'op_wave100b_post_once',action:'post',ruleId:'rule_wave100b_post',reminderId:'',
    baseUpdatedAt:postRule.updatedAt,
    payload:{expectedRevision:beforeVersion,occurrenceDate:'2026-10-01',transactionDate:'2026-10-01'}
  };
  const posted=await request('/api/sync/recurring',{method:'POST',body:{operation:postOp}});
  assert.equal(posted.res.status,201);
  assert.ok(posted.data.entryId);
  const afterFirst=(await request('/api/state')).data;
  assert.equal(afterFirst.version,beforeVersion+1);
  assert.equal(afterFirst.entries.length,beforeEntries+1);
  assert.equal(afterFirst.entries.filter(x=>x.id===posted.data.entryId).length,1);
  const postReplay=await request('/api/sync/recurring',{method:'POST',body:{operation:postOp}});
  assert.equal(postReplay.res.status,200);
  assert.equal(postReplay.data.alreadyProcessed,true);
  const afterReplay=(await request('/api/state')).data;
  assert.equal(afterReplay.version,afterFirst.version);
  assert.equal(afterReplay.entries.filter(x=>x.id===posted.data.entryId).length,1);
  rules=(await request('/api/recurring')).data.rules;
  assert.equal(rules.find(x=>x.id==='rule_wave100b_post').nextDueDate,'2026-11-01');

  const reminderCreate={
    operationId:'op_wave100b_reminder_rule',action:'create',ruleId:'rule_wave100b_reminder',reminderId:'',baseUpdatedAt:'',
    payload:expenseRule('rule_wave100b_reminder','Reminder once',2)
  };
  r=await request('/api/sync/recurring',{method:'POST',body:{operation:reminderCreate}});
  assert.equal(r.res.status,201);
  const reminderData=(await request('/api/recurring/reminders')).data;
  const reminder=reminderData.reminders.find(x=>x.ruleId==='rule_wave100b_reminder');
  assert.ok(reminder);
  const ackOp={
    operationId:'op_wave100b_ack_once',action:'ack_reminder',ruleId:'rule_wave100b_reminder',reminderId:reminder.id,baseUpdatedAt:'',
    payload:{ruleId:'rule_wave100b_reminder',occurrenceDate:reminder.occurrenceDate}
  };
  const ack=await request('/api/sync/recurring',{method:'POST',body:{operation:ackOp}});
  assert.equal(ack.res.status,201);
  const ackReplay=await request('/api/sync/recurring',{method:'POST',body:{operation:ackOp}});
  assert.equal(ackReplay.res.status,200);
  assert.equal(ackReplay.data.alreadyProcessed,true);
  const remindersAfter=(await request('/api/recurring/reminders')).data.reminders;
  assert.equal(remindersAfter.some(x=>x.id===reminder.id),false);

  const health=(await request('/api/health')).data;
  assert.equal(health.offlineWave100BVersion,1);
  for(const key of ['recurringAccepted','recurringReplayed','recurringConflict','recurringRejected'])assert.ok(health.offlineSyncMonitor.metrics[key],key);
  assert.ok(health.offlineSyncMonitor.metrics.recurringAccepted.count>=4);
  assert.ok(health.offlineSyncMonitor.metrics.recurringReplayed.count>=3);
  assert.ok(health.offlineSyncMonitor.metrics.recurringConflict.count>=2);
});

test.after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  db.close();
  rmSync(dir,{recursive:true,force:true});
});
