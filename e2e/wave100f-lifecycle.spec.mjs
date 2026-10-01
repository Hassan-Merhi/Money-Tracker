import { test, expect } from '@playwright/test';

const EMAIL='wave100f-owner@example.test';
const PASSWORD='correct horse battery staple';

async function ensureOwner(page){
  await page.goto('/');
  if(await page.locator('#pageHeading').count())return;
  const create=page.getByRole('button',{name:'Create account'}).first(),registrationOpen=await create.count()>0;
  if(registrationOpen)await create.click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:registrationOpen?'Create account':'Sign in'}).click();
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
}

test('Wave 100F lifecycle: slow multi-tab/worker sync, peer refresh, page kill and update guard keep one durable outbox',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const pageA=await context.newPage();
  await ensureOwner(pageA);
  await pageA.evaluate(async()=>{await navigator.serviceWorker.ready;});

  const pageB=await context.newPage();
  await pageB.goto('/');
  await expect(pageB.locator('#pageHeading')).toHaveText('Dashboard');
  await pageB.evaluate(()=>{location.hash='#people';});
  await expect(pageB.locator('#pageHeading')).toHaveText('People');

  const caps=await pageA.evaluate(async()=>{const lifecycle=await import('/lib/offline-lifecycle.js');return lifecycle.offlineLifecycleCapabilities();});
  expect(caps.webLocks).toBe(true);

  await pageA.evaluate(async()=>{
    const db=await import('/lib/offline-db.js');
    const lifecycle=await import('/lib/offline-lifecycle.js');
    const [state,user]=await Promise.all([db.loadStateSnapshot(),db.loadAuthorizedUser()]);
    const identity=user.id||user.email,stamp=new Date().toISOString();
    const result=await db.enqueueLocalMutation({
      operationId:'op_wave100f_peer',
      entity:'person',entityId:'person_wave100f_peer',operation:'create',
      expectedRevision:state.version,
      payload:{id:'person_wave100f_peer',name:'Peer Refresh Person',note:'slow multi-tab sync',openingBalance:0,currency:'USD',direction:'to_me'},
      localRecord:{id:'person_wave100f_peer',name:'Peer Refresh Person',note:'slow multi-tab sync',createdAt:stamp}
    },identity);
    lifecycle.announceOfflineChange({identity,kind:'ledger-queued',version:result.state?.version,source:'wave100f-test'});
  });
  await expect(pageB.locator('#main')).toContainText('Peer Refresh Person');

  let slowPushes=0;
  await context.route('**/api/sync/push',async route=>{
    slowPushes++;
    await new Promise(resolve=>setTimeout(resolve,350));
    await route.continue();
  });
  const syncA=pageA.evaluate(async()=>{const store=await import('/lib/store.js');return await store.syncPendingOperations({source:'wave100f-first-tab'});});
  await pageA.waitForTimeout(60);
  const syncB=pageB.evaluate(async()=>{const store=await import('/lib/store.js');return await store.syncPendingOperations({source:'wave100f-second-tab'});});
  await Promise.all([syncA,syncB]);
  await context.unroute('**/api/sync/push');
  expect(slowPushes).toBe(1);

  await pageA.evaluate(async()=>{
    const db=await import('/lib/offline-db.js');
    const [state,user]=await Promise.all([db.loadStateSnapshot(),db.loadAuthorizedUser()]);
    const stamp=new Date().toISOString();
    await db.enqueueLocalMutation({
      operationId:'op_wave100f_worker',
      entity:'person',entityId:'person_wave100f_worker',operation:'create',
      expectedRevision:state.version,
      payload:{id:'person_wave100f_worker',name:'Worker Lock Person',note:'worker and foreground race',openingBalance:0,currency:'USD',direction:'to_me'},
      localRecord:{id:'person_wave100f_worker',name:'Worker Lock Person',note:'worker and foreground race',createdAt:stamp}
    },user.id||user.email);
  });

  const foreground=pageA.evaluate(async()=>{const store=await import('/lib/store.js');return await store.syncPendingOperations({source:'wave100f-foreground-overlap'});});
  const workerSignal=pageA.evaluate(async()=>{
    const registration=await navigator.serviceWorker.ready;
    const worker=registration.active||navigator.serviceWorker.controller;
    worker.postMessage({type:'RUN_BACKGROUND_SYNC'});
    return true;
  });
  await Promise.all([foreground,workerSignal]);
  await expect.poll(()=>pageA.evaluate(async()=>{const store=await import('/lib/store.js');return (await store.getSyncStatus()).pending;}),{timeout:10000}).toBe(0);
  const workerResult=await pageA.evaluate(async()=>{
    const server=await (await fetch('/api/state',{credentials:'same-origin',cache:'no-store'})).json();
    return server.people.filter(row=>row.id==='person_wave100f_worker').length;
  });
  expect(workerResult).toBe(1);

  await context.setOffline(true);
  await pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const state=await db.loadStateSnapshot();
    await store.createPerson({id:'person_wave100f_kill',name:'Survive Page Kill',note:'durable lifecycle',openingBalance:0,currency:'USD',direction:'to_me'},state.version);
  });

  await pageA.evaluate(()=>{location.hash='#settings';});
  await expect(pageA.locator('#pageHeading')).toHaveText('Settings');
  await pageA.evaluate(async()=>{
    const pwa=await import('/lib/pwa.js');
    const current=pwa.pwaStatus();
    window.dispatchEvent(new CustomEvent('moneytracker:pwa',{detail:{...current,updateWaiting:true,update:{version:36,offlineDbVersion:7,compatible:true,reason:''}}}));
  });
  await expect(pageA.locator('#settingsApplyUpdate')).toBeVisible();
  await expect(pageA.locator('#settingsApplyUpdate')).toBeDisabled();
  await expect(pageA.locator('#settingsApplyUpdate')).toHaveText('Sync before update');

  await pageA.close();
  await pageB.close();

  const pageC=await context.newPage();
  await pageC.goto('/');
  await expect(pageC.locator('#pageHeading')).toHaveText('Dashboard');
  const recovered=await pageC.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const state=await db.loadStateSnapshot(),status=await store.getSyncStatus();
    return {
      hasPerson:state.people.some(row=>row.id==='person_wave100f_kill'),
      queued:status.queue.filter(row=>row.entityId==='person_wave100f_kill'&&row.status==='pending').length
    };
  });
  expect(recovered).toEqual({hasPerson:true,queued:1});

  await context.setOffline(false);
  await expect.poll(()=>pageC.evaluate(async()=>{const store=await import('/lib/store.js');return (await store.getSyncStatus()).pending;}),{timeout:12000}).toBe(0);
  const afterKill=await pageC.evaluate(async()=>{
    const server=await (await fetch('/api/state',{credentials:'same-origin',cache:'no-store'})).json();
    return server.people.filter(row=>row.id==='person_wave100f_kill').length;
  });
  expect(afterKill).toBe(1);
  await context.close();
});
