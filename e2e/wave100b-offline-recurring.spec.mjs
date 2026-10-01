import { test, expect } from '@playwright/test';

test.describe.configure({mode:'serial'});

const EMAIL='wave100b-owner@example.test';
const PASSWORD='correct horse battery staple';

async function registerOwner(page){
  await page.goto('/');
  await page.getByRole('button',{name:'Create account'}).first().click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:'Create account'}).click();
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
  await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    let state=await store.loadState();
    state=await store.updateSettings({defaultCurrency:'USD',appMode:'advanced',timezone:'Asia/Beirut'},state.version);
    state=await store.createAccount({id:'account_wave100b',name:'Wave 100B Bank',type:'bank',currency:'USD',openingBalance:500},state.version);
  });
}

async function loginStore(page){
  await page.goto('/');
  await page.evaluate(async creds=>{
    const store=await import('/lib/store.js');
    await store.login(creds.email,creds.password);
  },{email:EMAIL,password:PASSWORD});
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
}

function rule(id,title,amount=10){
  return {
    id,title,frequency:'monthly',interval:1,anchorDate:'2026-10-01',nextDueDate:'2026-10-01',endDate:null,
    remindDaysBefore:30,isActive:true,
    template:{type:'account_expense',accountId:'account_wave100b',amount,merchant:title,description:'Wave 100B offline recurring'}
  };
}

test('Wave 100B: schedules and reminders survive airplane-mode edits, dismissals and reload',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await registerOwner(page);

  const seeded=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    await store.createRecurringRule({
      id:'rule_wave100b_existing',title:'Existing monthly',frequency:'monthly',interval:1,
      anchorDate:'2026-10-01',nextDueDate:'2026-10-01',endDate:null,remindDaysBefore:30,isActive:true,
      template:{type:'account_expense',accountId:'account_wave100b',amount:8,merchant:'Existing',description:'Existing recurring'}
    });
    const rules=await store.listRecurringRules();
    const reminders=await store.listRecurringReminders();
    return {rules:rules.rules.length,reminderId:reminders.reminders.find(r=>r.ruleId==='rule_wave100b_existing')?.id||''};
  });
  expect(seeded.rules).toBeGreaterThan(0);
  expect(seeded.reminderId).toContain('reminder_');

  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await context.setOffline(true);
  await page.evaluate(()=>{location.hash='#scheduled';});
  await expect(page.locator('#pageHeading')).toHaveText('Scheduled & Reminders');
  await expect(page.locator('.recurring-note')).toContainText('Offline reminders are active');
  await expect(page.getByText('Scheduled & Reminders needs a connection')).toHaveCount(0);

  const offline=await page.evaluate(async reminderId=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    let rules=(await store.listRecurringRules()).rules;
    const existing=rules.find(r=>r.id==='rule_wave100b_existing');
    await store.acknowledgeRecurringReminder(reminderId);
    await store.updateRecurringRule(existing.id,{...existing,title:'Edited offline'});
    rules=(await store.listRecurringRules()).rules;
    const edited=rules.find(r=>r.id==='rule_wave100b_existing');
    await store.skipRecurringRule(edited.id,{occurrenceDate:'2026-10-01'});
    await store.createRecurringRule(rule('rule_wave100b_created_offline','Created offline',5));
    const user=await db.loadAuthorizedUser();
    const queue=await db.listRecurringQueue(user.id||user.email);
    const view=await store.listRecurringRules();
    const reminders=await store.listRecurringReminders();
    return {
      actions:queue.map(r=>r.action),
      existing:view.rules.find(r=>r.id==='rule_wave100b_existing'),
      created:view.rules.find(r=>r.id==='rule_wave100b_created_offline'),
      reminderStillVisible:reminders.reminders.some(r=>r.id===reminderId),
      pending:view.offline?.queued
    };
  },seeded.reminderId);

  for(const action of ['ack_reminder','update','skip','create'])expect(offline.actions).toContain(action);
  expect(offline.existing.title).toBe('Edited offline');
  expect(offline.existing.nextDueDate).toBe('2026-11-01');
  expect(offline.created.title).toBe('Created offline');
  expect(offline.reminderStillVisible).toBe(false);
  expect(offline.pending).toBeGreaterThanOrEqual(4);

  await page.reload({waitUntil:'domcontentloaded'});
  await page.evaluate(()=>{location.hash='#scheduled';});
  await expect(page.locator('#pageHeading')).toHaveText('Scheduled & Reminders');
  await expect(page.locator('#main')).toContainText('Edited offline');
  await expect(page.locator('#main')).toContainText('Created offline');

  await context.setOffline(false);
  await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    await store.syncPendingOperations({source:'wave100b-offline-actions'});
  });
  await expect.poll(()=>page.evaluate(async()=>{const store=await import('/lib/store.js');return (await store.getSyncStatus()).pending;}),{timeout:10000}).toBe(0);

  const converged=await page.evaluate(async reminderId=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const serverRules=await (await fetch('/api/recurring',{credentials:'same-origin',cache:'no-store'})).json();
    const serverReminders=await (await fetch('/api/recurring/reminders',{credentials:'same-origin',cache:'no-store'})).json();
    const user=await db.loadAuthorizedUser();
    return {
      queue:(await db.listRecurringQueue(user.id||user.email)).length,
      existing:serverRules.rules.find(r=>r.id==='rule_wave100b_existing'),
      created:serverRules.rules.find(r=>r.id==='rule_wave100b_created_offline'),
      reminderVisible:serverReminders.reminders.some(r=>r.id===reminderId)
    };
  },seeded.reminderId);
  expect(converged.queue).toBe(0);
  expect(converged.existing.title).toBe('Edited offline');
  expect(converged.existing.nextDueDate).toBe('2026-11-01');
  expect(converged.created.title).toBe('Created offline');
  expect(converged.reminderVisible).toBe(false);

  await context.close();
});

test('Wave 100B: offline recurring post does not change money early and safely rebases ledger revision',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await loginStore(page);

  const setup=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    await store.createRecurringRule({
      id:'rule_wave100b_post',title:'Post after reconnect',frequency:'monthly',interval:1,
      anchorDate:'2026-10-01',nextDueDate:'2026-10-01',endDate:null,remindDaysBefore:30,isActive:true,
      template:{type:'account_expense',accountId:'account_wave100b',amount:13,merchant:'Wave Post',description:'Must post once'}
    });
    await Promise.all([store.listRecurringRules(),store.listRecurringReminders()]);
    const state=await db.loadStateSnapshot();
    return {version:state.version,entries:state.entries.length};
  });

  await context.setOffline(true);
  const queued=await page.evaluate(async version=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const result=await store.postRecurringRule('rule_wave100b_post',{expectedRevision:version,occurrenceDate:'2026-10-01',transactionDate:'2026-10-01'});
    const state=await db.loadStateSnapshot();
    const user=await db.loadAuthorizedUser();
    const view=await store.listRecurringRules();
    return {
      queued:result.queued===true,
      entries:state.entries.length,
      version:state.version,
      action:(await db.listRecurringQueue(user.id||user.email)).map(r=>r.action),
      pendingAction:view.rules.find(r=>r.id==='rule_wave100b_post')?.pendingAction||''
    };
  },setup.version);
  expect(queued.queued).toBe(true);
  expect(queued.entries).toBe(setup.entries);
  expect(queued.version).toBe(setup.version);
  expect(queued.action).toContain('post');
  expect(queued.pendingAction).toBe('post');

  await page.reload({waitUntil:'domcontentloaded'});
  await page.evaluate(()=>{location.hash='#scheduled';});
  await expect(page.locator('#pageHeading')).toHaveText('Scheduled & Reminders');
  await expect(page.locator('#main')).toContainText('Post queued');

  const remoteContext=await browser.newContext({viewport:{width:1280,height:800}});
  const remote=await remoteContext.newPage();
  await loginStore(remote);
  const remoteVersion=await remote.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const state=await store.loadState();
    const next=await store.createPerson({id:'person_wave100b_remote_revision',name:'Remote revision',note:'forces post rebase',openingBalance:0,currency:'USD',direction:'to_me'},state.version);
    return next.version;
  });
  expect(remoteVersion).toBeGreaterThan(setup.version);

  await context.setOffline(false);
  await page.evaluate(async()=>{const store=await import('/lib/store.js');await store.syncPendingOperations({source:'wave100b-post'});});
  await expect.poll(()=>page.evaluate(async()=>{const store=await import('/lib/store.js');return (await store.getSyncStatus()).pending;}),{timeout:10000}).toBe(0);

  const final=await page.evaluate(async beforeEntries=>{
    const db=await import('/lib/offline-db.js');
    const store=await import('/lib/store.js');
    const user=await db.loadAuthorizedUser();
    const local=await db.loadStateSnapshot();
    const server=await (await fetch('/api/state',{credentials:'same-origin',cache:'no-store'})).json();
    const recurring=await (await fetch('/api/recurring',{credentials:'same-origin',cache:'no-store'})).json();
    return {
      queue:(await db.listRecurringQueue(user.id||user.email)).length,
      localVersion:local.version,serverVersion:server.version,
      localEntries:local.entries.length,serverEntries:server.entries.length,beforeEntries,
      postedCount:server.entries.filter(e=>e.merchant==='Wave Post').length,
      nextDueDate:recurring.rules.find(r=>r.id==='rule_wave100b_post')?.nextDueDate||null
    };
  },setup.entries);
  expect(final.queue).toBe(0);
  expect(final.localVersion).toBe(final.serverVersion);
  expect(final.localEntries).toBe(final.serverEntries);
  expect(final.serverEntries).toBe(final.beforeEntries+1);
  expect(final.postedCount).toBe(1);
  expect(final.nextDueDate).toBe('2026-11-01');

  await remoteContext.close();
  await context.close();
});

test('Wave 100B: stale recurring edit becomes targeted conflict and unrelated schedule work survives resolution',async({browser})=>{
  const localContext=await browser.newContext({viewport:{width:390,height:844}});
  const remoteContext=await browser.newContext({viewport:{width:1280,height:800}});
  const local=await localContext.newPage(),remote=await remoteContext.newPage();
  await loginStore(local);
  await loginStore(remote);

  await local.evaluate(async()=>{
    const store=await import('/lib/store.js');
    await store.createRecurringRule({
      id:'rule_wave100b_conflict',title:'Conflict base',frequency:'monthly',interval:1,
      anchorDate:'2026-10-01',nextDueDate:'2026-10-01',endDate:null,remindDaysBefore:1,isActive:true,
      template:{type:'account_expense',accountId:'account_wave100b',amount:3,merchant:'Conflict',description:''}
    });
    await Promise.all([store.listRecurringRules(),store.listRecurringReminders()]);
  });

  await localContext.setOffline(true);
  const queued=await local.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const base=(await store.listRecurringRules()).rules.find(r=>r.id==='rule_wave100b_conflict');
    const update=await store.updateRecurringRule(base.id,{...base,title:'Local offline edit'});
    await store.createRecurringRule({
      id:'rule_wave100b_unrelated',title:'Unrelated offline',frequency:'monthly',interval:1,
      anchorDate:'2026-10-01',nextDueDate:'2026-10-01',endDate:null,remindDaysBefore:1,isActive:true,
      template:{type:'account_expense',accountId:'account_wave100b',amount:2,merchant:'Unrelated',description:''}
    });
    const user=await db.loadAuthorizedUser(),queue=await db.listRecurringQueue(user.id||user.email);
    return {updateOp:update.operationId,actions:queue.map(r=>({id:r.operationId,action:r.action,ruleId:r.ruleId}))};
  });
  expect(queued.actions.some(r=>r.ruleId==='rule_wave100b_conflict'&&r.action==='update')).toBe(true);
  expect(queued.actions.some(r=>r.ruleId==='rule_wave100b_unrelated'&&r.action==='create')).toBe(true);

  await remote.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const base=(await store.listRecurringRules()).rules.find(r=>r.id==='rule_wave100b_conflict');
    await store.updateRecurringRule(base.id,{...base,title:'Remote wins'});
  });

  await localContext.setOffline(false);
  const conflicted=await local.evaluate(async()=>{
    const store=await import('/lib/store.js');
    await store.syncPendingOperations({source:'wave100b-conflict'});
    const status=await store.getSyncStatus();
    return {
      conflicts:(status.recurringQueue||[]).filter(r=>r.status==='conflict').map(r=>({id:r.operationId,ruleId:r.ruleId})),
      queued:(status.recurringQueue||[]).map(r=>({ruleId:r.ruleId,status:r.status}))
    };
  });
  expect(conflicted.conflicts).toEqual([{id:queued.updateOp,ruleId:'rule_wave100b_conflict'}]);
  expect(conflicted.queued.some(r=>r.ruleId==='rule_wave100b_unrelated')).toBe(true);

  const resolved=await local.evaluate(async operationId=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    await store.resolveRecurringConflict(operationId);
    const user=await db.loadAuthorizedUser();
    const rules=await store.listRecurringRules();
    const server=await (await fetch('/api/recurring',{credentials:'same-origin',cache:'no-store'})).json();
    return {
      queue:(await db.listRecurringQueue(user.id||user.email)).length,
      localTitle:rules.rules.find(r=>r.id==='rule_wave100b_conflict')?.title||'',
      serverTitle:server.rules.find(r=>r.id==='rule_wave100b_conflict')?.title||'',
      unrelated:server.rules.some(r=>r.id==='rule_wave100b_unrelated')
    };
  },queued.updateOp);
  expect(resolved.queue).toBe(0);
  expect(resolved.localTitle).toBe('Remote wins');
  expect(resolved.serverTitle).toBe('Remote wins');
  expect(resolved.unrelated).toBe(true);

  await remoteContext.close();
  await localContext.close();
});
