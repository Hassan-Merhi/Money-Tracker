import { test, expect } from '@playwright/test';
import { buildXlsx } from '../lib/xlsx.js';

test.describe.configure({mode:'serial'});
test.setTimeout(90000);

const EMAIL='wave100i-owner@example.test';
const PASSWORD='correct horse battery staple';

async function registerOwner(page){
  await page.goto('/');
  await page.getByRole('button',{name:'Create account'}).first().click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:'Create account'}).click();
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
}

test('Wave 100I: XLSX ledger import applies atomically offline, survives reload, and converges once',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  page.on('dialog',async dialog=>{await dialog.accept();});
  await registerOwner(page);

  const baseline=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    let state=await store.loadState();
    state=await store.updateSettings({
      defaultCurrency:state.settings.defaultCurrency,
      appMode:'advanced',
      timezone:state.settings.timezone||'UTC'
    },state.version);
    return {version:state.version,people:state.people.length,entries:state.entries.length};
  });

  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);

  const workbook=buildXlsx([{name:'People',rows:[
    ['Name','Note','Currency','Balance','Direction','Date','Description'],
    ['Wave 100I Alice','Imported fully offline','USD',25,'They owe me','2026-10-01','Offline opening balance']
  ]}],{title:'Wave 100I offline import'});

  await context.setOffline(true);
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');

  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('moneytracker:open-import')));
  await expect(page.locator('#impFile')).toBeAttached();
  await page.locator('#impFile').setInputFiles({
    name:'wave100i-people.xlsx',
    mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer:Buffer.from(workbook)
  });

  await expect(page.getByText('1 row detected')).toBeVisible();
  await expect(page.locator('#impMode')).toHaveValue('people');
  await page.locator('#impReview').click();

  await expect.poll(()=>page.evaluate(async()=>{
    const db=await import('/lib/offline-db.js');
    const store=await import('/lib/store.js');
    const user=await db.loadAuthorizedUser();
    const identity=user.id||user.email;
    const state=await db.loadStateSnapshot();
    const queue=await db.listQueuedOperations(identity);
    const person=state.people.find(row=>row.name==='Wave 100I Alice');
    const entries=state.entries.filter(row=>row.personId===person?.id&&row.description==='Offline opening balance');
    const status=await store.getSyncStatus();
    return {
      version:state.version,
      queue:queue.map(row=>({entity:row.entity,operation:row.operation,baseRevision:row.baseRevision})),
      person:Boolean(person),
      entryCount:entries.length,
      amount:entries[0]?.signedAmount||0,
      pending:status.pending
    };
  })).toEqual({
    version:baseline.version+2,
    queue:[
      {entity:'person',operation:'create',baseRevision:baseline.version},
      {entity:'entry',operation:'create',baseRevision:baseline.version+1}
    ],
    person:true,
    entryCount:1,
    amount:25,
    pending:2
  });

  await page.reload({waitUntil:'domcontentloaded'});
  const persisted=await page.evaluate(async()=>{
    const db=await import('/lib/offline-db.js');
    const user=await db.loadAuthorizedUser();
    const state=await db.loadStateSnapshot();
    const person=state.people.find(row=>row.name==='Wave 100I Alice');
    return {
      person:Boolean(person),
      entry:state.entries.some(row=>row.personId===person?.id&&row.description==='Offline opening balance'),
      queue:(await db.listQueuedOperations(user.id||user.email)).length
    };
  });
  expect(persisted).toEqual({person:true,entry:true,queue:2});

  await context.setOffline(false);
  const converged=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    await store.syncPendingOperations({source:'wave100i-offline-import'});
    const user=await db.loadAuthorizedUser();
    const server=await (await fetch('/api/state',{credentials:'same-origin',cache:'no-store'})).json();
    const people=server.people.filter(row=>row.name==='Wave 100I Alice');
    const entries=server.entries.filter(row=>row.personId===people[0]?.id&&row.description==='Offline opening balance');
    return {
      queue:(await db.listQueuedOperations(user.id||user.email)).length,
      people:people.length,
      entries:entries.length,
      amount:entries[0]?.signedAmount||0,
      version:server.version
    };
  });

  expect(converged.queue).toBe(0);
  expect(converged.people).toBe(1);
  expect(converged.entries).toBe(1);
  expect(converged.amount).toBe(25);
  expect(converged.version).toBe(baseline.version+2);

  await context.close();
});
