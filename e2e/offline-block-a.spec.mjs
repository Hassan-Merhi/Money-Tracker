import { test, expect } from '@playwright/test';

const EMAIL='offline-a-owner@example.test';
const PASSWORD='correct horse battery staple';

async function expectHeading(page,name){
  await expect(page.locator('#pageHeading')).toHaveText(name);
}

test('Offline Block A: cached ledger reopens and renders without a network',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  page.on('dialog',dialog=>dialog.accept().catch(()=>{}));

  await page.goto('/');
  await page.getByRole('button',{name:'Create account'}).first().click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:'Create account'}).click();
  await expectHeading(page,'Dashboard');

  await page.evaluate(()=>{location.hash='#people';});
  await expectHeading(page,'People');
  await page.locator('#addPerson').click();
  const modal=page.locator('.modal');
  await modal.getByLabel('Name').fill('Offline Alice');
  await modal.getByLabel('Opening balance',{exact:true}).fill('125');
  await modal.getByRole('button',{name:'Save'}).click();
  await expect(page.getByRole('link',{name:/Offline Alice/})).toBeVisible();

  await page.evaluate(()=>{location.hash='#dashboard';});
  await expectHeading(page,'Dashboard');
  await page.evaluate(async()=>{
    if(!('serviceWorker' in navigator))throw new Error('Service worker unavailable');
    await navigator.serviceWorker.ready;
  });
  await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  await page.reload({waitUntil:'domcontentloaded'});
  await expectHeading(page,'Dashboard');
  await expect(page.locator('.connection-pill')).toContainText('Offline');
  await expect(page.locator('.connection-pill')).toContainText('changes save locally');

  await page.evaluate(()=>{location.hash='#people';});
  await expectHeading(page,'People');
  await expect(page.getByRole('link',{name:/Offline Alice/})).toBeVisible();

  await page.evaluate(()=>{location.hash='#reports';});
  await expectHeading(page,'Reports & Exports');
  await expect(page.locator('#main')).toBeVisible();

  await context.setOffline(false);

  await context.clearCookies();
  const unauthorizedStatus=await page.evaluate(async()=>{
    const {listSessions}=await import('/lib/store.js');
    try{await listSessions();return 200;}
    catch(error){return Number(error?.status||0);}
  });
  expect(unauthorizedStatus).toBe(401);
  await expect.poll(()=>page.evaluate(async()=>Boolean(await (await import('/lib/offline-db.js')).loadAuthorizedUser()))).toBe(false);

  await context.setOffline(true);
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.getByRole('heading',{name:'Money Owed Tracker'})).toBeVisible();
  await expect(page.getByRole('link',{name:/Offline Alice/})).toHaveCount(0);

  await context.setOffline(false);
  await context.close();
});

test('Offline Block A: stale state cannot cross an active user boundary',async({browser})=>{
  const context=await browser.newContext();
  const page=await context.newPage();
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const db=await import('/lib/offline-db.js');
    await db.clearOfflineData();
    const base=settings=>({version:1,settings:{displayName:settings,defaultCurrency:'USD',appMode:'simple',timezone:'UTC'},people:[],accounts:[],entries:[],categories:[],budgets:[]});
    await db.saveAuthorizedUser({id:'user_A',email:'a@example.test'});
    await db.saveStateSnapshot({...base('A ledger'),people:[{id:'person_A',name:'A Person'}]},'user_A');
    await db.saveAuthorizedUser({id:'user_B',email:'b@example.test'});
    const savedB=await db.saveStateSnapshot({...base('B ledger'),people:[{id:'person_B',name:'B Person'}]},'user_B');
    const staleA=await db.saveStateSnapshot({...base('STALE A'),people:[{id:'person_leak',name:'Leaked A'}]},'user_A');
    const active=await db.loadAuthorizedUser();
    const snapshot=await db.loadStateSnapshot();
    return {savedB,staleA,activeId:active?.id,displayName:snapshot?.settings?.displayName,people:snapshot?.people?.map(row=>row.id)};
  });
  expect(result).toEqual({savedB:true,staleA:false,activeId:'user_B',displayName:'B ledger',people:['person_B']});
  await context.close();
});
