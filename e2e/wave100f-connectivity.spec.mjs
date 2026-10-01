import { test, expect } from '@playwright/test';

const EMAIL='wave100f-owner@example.test';
const PASSWORD='correct horse battery staple';

async function ensureOwner(page){
  await page.goto('/');
  if(await page.locator('#pageHeading').count())return;
  const create=page.getByRole('button',{name:'Create account'}).first();
  if(await create.count())await create.click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:await create.count()?'Create account':'Sign in'}).click();
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
}

test('Wave 100F connectivity: transient failures and a lost accepted response remain retryable/idempotent',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await ensureOwner(page);

  const seeded=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    let state=await store.loadState();
    state=await store.updateSettings({defaultCurrency:'USD',appMode:'advanced',timezone:'UTC'},state.version);
    state=await store.createAccount({id:'account_wave100f',name:'Hostile Cash',type:'cash',currency:'USD',openingBalance:200},state.version);
    const feed=await store.importBankFeed({
      accountId:'account_wave100f',sourceName:'hostile.csv',
      rows:[{date:'2026-10-01',description:'Hostile connectivity row',merchant:'Retry Shop',signedAmount:-8,currency:'USD',externalId:'wave100f-bank'}]
    });
    await store.createRecurringRule({
      id:'rule_wave100f',title:'Hostile schedule',frequency:'monthly',interval:1,
      anchorDate:'2026-10-05',nextDueDate:'2026-10-05',endDate:null,remindDaysBefore:3,isActive:true,
      template:{type:'account_expense',accountId:'account_wave100f',amount:9,merchant:'Retry Merchant',description:'Hostile recurring'}
    });
    await store.listBankFeed({limit:500,offset:0});
    await store.listRecurringRules();
    return {bankId:feed.items.find(row=>row.externalId==='wave100f-bank').id};
  });

  let first503=true;
  await page.route('**/api/sync/push',async route=>{
    if(first503&&route.request().method()==='POST'){
      first503=false;
      await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic temporary outage'})});
      return;
    }
    await route.continue();
  });
  const transient=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const before=await store.loadState();
    await store.createPerson({id:'person_wave100f_503',name:'Retryable 503',note:'must remain pending',openingBalance:0,currency:'USD',direction:'to_me'},before.version);
    const status=await store.getSyncStatus();
    const row=status.queue.find(item=>item.entityId==='person_wave100f_503');
    return {failed:status.failed,rowStatus:row?.status,lastError:row?.lastError||''};
  });
  expect(transient.rowStatus).toBe('pending');
  expect(transient.failed).toBe(0);
  expect(transient.lastError).toContain('temporary');
  await page.unroute('**/api/sync/push');
  await page.evaluate(async()=>{const store=await import('/lib/store.js');await store.syncPendingOperations({source:'wave100f-retry-503'});});
  await expect.poll(()=>page.evaluate(async()=>{const store=await import('/lib/store.js');return (await store.getSyncStatus()).pending;}),{timeout:10000}).toBe(0);

  let proxyLost=true,acceptedStatus=0;
  await page.route('**/api/sync/push',async route=>{
    if(proxyLost&&route.request().method()==='POST'){
      proxyLost=false;
      const response=await route.fetch();
      acceptedStatus=response.status();
      await route.fulfill({status:504,contentType:'application/json',body:JSON.stringify({error:'Synthetic proxy response loss'})});
      return;
    }
    await route.continue();
  });
  const lost=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const before=await store.loadState();
    await store.createPerson({id:'person_wave100f_lost',name:'Lost Response Once',note:'server accepts before client sees failure',openingBalance:0,currency:'USD',direction:'to_me'},before.version);
    const status=await store.getSyncStatus();
    const server=await (await fetch('/api/state',{credentials:'same-origin',cache:'no-store'})).json();
    return {
      pending:status.queue.filter(row=>row.entityId==='person_wave100f_lost'&&row.status==='pending').length,
      serverCount:server.people.filter(row=>row.id==='person_wave100f_lost').length
    };
  });
  expect(acceptedStatus).toBe(201);
  expect(lost).toEqual({pending:1,serverCount:1});
  await page.unroute('**/api/sync/push');

  const replayed=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    await store.syncPendingOperations({source:'wave100f-lost-response-replay'});
    const status=await store.getSyncStatus();
    const server=await (await fetch('/api/state',{credentials:'same-origin',cache:'no-store'})).json();
    const health=await (await fetch('/api/health',{cache:'no-store'})).json();
    return {
      pending:status.pending,failed:status.failed,conflicts:status.conflicts,
      serverCount:server.people.filter(row=>row.id==='person_wave100f_lost').length,
      replayCount:Number(health.offlineSyncMonitor?.metrics?.pushReplayed?.count||0)
    };
  });
  expect(replayed.pending).toBe(0);
  expect(replayed.failed).toBe(0);
  expect(replayed.conflicts).toBe(0);
  expect(replayed.serverCount).toBe(1);
  expect(replayed.replayCount).toBeGreaterThan(0);

  await page.route('**/api/bank-feed/**',async route=>{
    if(route.request().method()==='POST'&&route.request().url().endsWith('/ignore')){
      await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary Bank Feed outage'})});
      return;
    }
    await route.continue();
  });
  await page.route('**/api/recurring/rule_wave100f',async route=>{
    if(route.request().method()==='PUT'){
      await route.fulfill({status:429,contentType:'application/json',body:JSON.stringify({error:'Temporary recurring throttle'})});
      return;
    }
    await route.continue();
  });
  const fallback=await page.evaluate(async bankId=>{
    const store=await import('/lib/store.js');
    await store.ignoreBankFeedItem(bankId);
    const rule=(await store.listRecurringRules()).rules.find(row=>row.id==='rule_wave100f');
    await store.updateRecurringRule(rule.id,{...rule,title:'Queued after 429'});
    const status=await store.getSyncStatus();
    return {
      bank:status.bankFeedQueue.find(row=>row.itemId===bankId)?.status||'',
      recurring:status.recurringQueue.find(row=>row.ruleId==='rule_wave100f')?.status||'',
      failed:status.failed
    };
  },seeded.bankId);
  expect(fallback).toEqual({bank:'pending',recurring:'pending',failed:0});
  await page.unroute('**/api/bank-feed/**');
  await page.unroute('**/api/recurring/rule_wave100f');
  await page.evaluate(async()=>{const store=await import('/lib/store.js');await store.syncPendingOperations({source:'wave100f-feature-retry'});});
  await expect.poll(()=>page.evaluate(async()=>{const store=await import('/lib/store.js');return (await store.getSyncStatus()).pending;}),{timeout:10000}).toBe(0);

  const final=await page.evaluate(async bankId=>{
    const store=await import('/lib/store.js');
    const feed=await store.listBankFeed({limit:500,offset:0});
    const rule=(await store.listRecurringRules()).rules.find(row=>row.id==='rule_wave100f');
    return {bankStatus:feed.items.find(row=>row.id===bankId)?.status,ruleTitle:rule?.title};
  },seeded.bankId);
  expect(final).toEqual({bankStatus:'ignored',ruleTitle:'Queued after 429'});
  await context.close();
});
