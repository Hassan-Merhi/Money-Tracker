import { test, expect } from '@playwright/test';
import { buildXlsx } from '../lib/xlsx.js';

test.describe.configure({mode:'serial'});
test.setTimeout(90000);

const EMAIL='wave100h-owner@example.test';
const PASSWORD='correct horse battery staple';

async function registerOwner(page){
  await page.goto('/');
  await page.getByRole('button',{name:'Create account'}).first().click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:'Create account'}).click();
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
}

test('Wave 100H: XLSX statement previews and queues in airplane mode, then converges once',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await registerOwner(page);

  await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    let state=await store.loadState();
    state=await store.updateSettings({
      defaultCurrency:state.settings.defaultCurrency,
      appMode:'advanced',
      timezone:state.settings.timezone||'UTC'
    },state.version);
    await store.createAccount({
      id:'account_wave100h',
      name:'Wave 100H Bank',
      type:'bank',
      currency:'USD',
      openingBalance:500,
      createdAt:new Date().toISOString()
    },state.version);
  });

  await page.evaluate(()=>{location.hash='#bank';});
  await expect(page.locator('#pageHeading')).toHaveText('Bank Feed');
  await expect(page.locator('#bankFile')).toBeVisible();
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);

  const workbook=buildXlsx([{name:'Statement',rows:[
    ['Date','Description','Amount','Currency','Transaction ID'],
    ['2026-10-01','Offline XLSX coffee',-9.75,'USD','wave100h-xlsx-1']
  ]}],{title:'Wave 100H offline statement'});

  await context.setOffline(true);
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.locator('#pageHeading')).toHaveText('Bank Feed');
  await expect(page.locator('#bankFile')).toBeVisible();

  await page.locator('#bankFile').setInputFiles({
    name:'wave100h-statement.xlsx',
    mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer:Buffer.from(workbook)
  });

  await expect(page.getByText('1 rows ready to map')).toBeVisible();
  await expect(page.locator('#bankImportNow')).toBeVisible();
  await page.locator('#bankImportNow').click();

  await expect.poll(()=>page.evaluate(async()=>{
    const db=await import('/lib/offline-db.js');
    const user=await db.loadAuthorizedUser();
    const identity=user.id||user.email;
    const queue=await db.listBankFeedQueue(identity);
    const row=queue.find(item=>item.action==='import');
    return row?{
      count:queue.length,
      action:row.action,
      sourceName:row.payload?.sourceName||'',
      description:row.payload?.rows?.[0]?.description||'',
      externalId:row.payload?.rows?.[0]?.externalId||''
    }:null;
  })).toEqual({
    count:1,
    action:'import',
    sourceName:'wave100h-statement.xlsx',
    description:'Offline XLSX coffee',
    externalId:'wave100h-xlsx-1'
  });

  await page.reload({waitUntil:'domcontentloaded'});
  const persisted=await page.evaluate(async()=>{
    const db=await import('/lib/offline-db.js');
    const user=await db.loadAuthorizedUser();
    const queue=await db.listBankFeedQueue(user.id||user.email);
    return queue.filter(row=>row.action==='import').length;
  });
  expect(persisted).toBe(1);

  await context.setOffline(false);
  const converged=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    await store.syncPendingOperations({source:'wave100h-offline-xlsx'});
    const user=await db.loadAuthorizedUser();
    const queue=await db.listBankFeedQueue(user.id||user.email);
    const server=await (await fetch('/api/bank-feed?limit=500&offset=0',{credentials:'same-origin',cache:'no-store'})).json();
    const matches=server.items.filter(row=>row.externalId==='wave100h-xlsx-1');
    return {
      queue:queue.length,
      matches:matches.length,
      description:matches[0]?.description||'',
      amount:matches[0]?.signedAmount||0,
      status:matches[0]?.status||''
    };
  });

  expect(converged).toEqual({
    queue:0,
    matches:1,
    description:'Offline XLSX coffee',
    amount:-9.75,
    status:'pending'
  });

  await context.close();
});
