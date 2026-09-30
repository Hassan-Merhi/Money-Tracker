import { test, expect } from '@playwright/test';

const EMAIL='offline-b-owner@example.test';
const PASSWORD='correct horse battery staple';

async function expectHeading(page,name){
  await expect(page.locator('#pageHeading')).toHaveText(name);
}

test('Offline Block B: local writes survive reload and a lost sync response retries exactly once',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  page.on('dialog',dialog=>dialog.accept().catch(()=>{}));

  await page.goto('/');
  await page.getByRole('button',{name:'Create account'}).first().click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:'Create account'}).click();
  await expectHeading(page,'Dashboard');

  await page.evaluate(async()=>{
    await navigator.serviceWorker.ready;
  });
  await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  await page.evaluate(()=>{location.hash='#people';});
  await expectHeading(page,'People');

  await page.locator('#addPerson').click();
  const modal=page.locator('.modal');
  await modal.getByLabel('Name').fill('Offline Bob');
  await modal.getByLabel('Opening balance',{exact:true}).fill('40');
  await modal.getByRole('button',{name:'Save'}).click();
  await expect(page.getByRole('link',{name:/Offline Bob/})).toBeVisible();
  await expect(page.locator('.connection-pill')).toContainText('1 queued');

  const queuedSecond=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const snapshot=await db.loadStateSnapshot();
    const person=snapshot.people.find(row=>row.name==='Offline Bob');
    const stamp=new Date().toISOString();
    await store.createEntry({
      id:'entry_offline_second',
      type:'paid_for_person',
      personId:person.id,
      accountId:null,
      amount:15,
      currency:'USD',
      date:'2026-09-30',
      merchant:'Offline shop',
      description:'Queued after the opening balance',
      splits:[],
      createdAt:stamp,
      updatedAt:stamp
    },snapshot.version);
    return await store.getSyncStatus();
  });
  expect(queuedSecond.pending).toBe(2);

  const transferGuard=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const snapshot=await db.loadStateSnapshot();
    try{
      await store.createEntry({
        id:'entry_offline_transfer',
        type:'account_transfer',
        fromAccountId:'account_a',
        toAccountId:'account_b',
        fromAmount:1,
        toAmount:1,
        amount:1,
        date:'2026-09-30'
      },snapshot.version);
      return '';
    }catch(error){
      return String(error?.message||error);
    }
  });
  expect(transferGuard).toContain('atomic-transfer phase');

  await page.reload({waitUntil:'domcontentloaded'});
  await expectHeading(page,'People');
  await expect(page.getByRole('link',{name:/Offline Bob/})).toBeVisible();
  await expect(page.locator('.connection-pill')).toContainText('2 queued');

  const durable=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const status=await store.getSyncStatus();
    const snapshot=await db.loadStateSnapshot();
    let logoutError='';
    try{await store.logout();}catch(error){logoutError=String(error?.message||error);}
    const cachedUser=await db.loadAuthorizedUser();
    return {
      pending:status.pending,
      personCount:snapshot.people.filter(row=>row.name==='Offline Bob').length,
      openingCount:snapshot.entries.filter(row=>row.description==='Opening balance').length,
      secondCount:snapshot.entries.filter(row=>row.id==='entry_offline_second').length,
      logoutError,
      cachedUser:cachedUser?.email||''
    };
  });
  expect(durable.pending).toBe(2);
  expect(durable.personCount).toBe(1);
  expect(durable.openingCount).toBe(1);
  expect(durable.secondCount).toBe(1);
  expect(durable.logoutError).toContain('unsynced offline changes');
  expect(durable.cachedUser).toBe(EMAIL);

  let dropped=false;
  await page.route('**/api/sync/push',async route=>{
    if(!dropped){
      dropped=true;
      await route.fetch();
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  await context.setOffline(false);
  await expect.poll(()=>dropped,{timeout:8000}).toBe(true);
  await page.unroute('**/api/sync/push');

  await expect.poll(()=>page.evaluate(async()=>{
    const {getSyncStatus}=await import('/lib/store.js');
    return (await getSyncStatus()).pending;
  })).toBe(2);

  const afterRetry=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    await store.syncPendingOperations();
    const first=await store.getSyncStatus();
    const response=await fetch('/api/state',{credentials:'same-origin'});
    const serverState=await response.json();
    await store.syncPendingOperations();
    const second=await store.getSyncStatus();
    return {
      firstPending:first.pending,
      secondPending:second.pending,
      people:serverState.people.filter(row=>row.name==='Offline Bob').length,
      opening:serverState.entries.filter(row=>row.description==='Opening balance').length,
      second:serverState.entries.filter(row=>row.id==='entry_offline_second').length,
      amountTotal:serverState.entries
        .filter(row=>row.personId===serverState.people.find(person=>person.name==='Offline Bob')?.id)
        .reduce((sum,row)=>sum+Number(row.amount||0),0)
    };
  });

  expect(afterRetry.firstPending).toBe(0);
  expect(afterRetry.secondPending).toBe(0);
  expect(afterRetry.people).toBe(1);
  expect(afterRetry.opening).toBe(1);
  expect(afterRetry.second).toBe(1);
  expect(afterRetry.amountTotal).toBe(55);

  await expect(page.locator('.connection-pill')).toContainText('Online · synced');

  await context.setOffline(true);
  const failedLogout=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    let error='';
    try{await store.logout();}catch(reason){error=String(reason?.message||reason);}
    const cached=await db.loadAuthorizedUser();
    const snapshot=await db.loadStateSnapshot();
    return {error,cachedEmail:cached?.email||'',hasPerson:snapshot?.people?.some(row=>row.name==='Offline Bob')||false};
  });
  expect(failedLogout.error).toContain('offline');
  expect(failedLogout.cachedEmail).toBe(EMAIL);
  expect(failedLogout.hasPerson).toBe(true);
  await expectHeading(page,'People');

  await context.setOffline(false);
  await context.close();
});
