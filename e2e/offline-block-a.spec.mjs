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

  await page.locator('[data-nav="people"]').first().click();
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

  await page.reload({waitUntil:'domcontentloaded'});
  await expectHeading(page,'Dashboard');
  await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  await page.reload({waitUntil:'domcontentloaded'});
  await expectHeading(page,'Dashboard');
  await expect(page.locator('.connection-pill')).toContainText('Offline');
  await expect(page.locator('.connection-pill')).toContainText('read only');

  await page.evaluate(()=>{location.hash='#people';});
  await expectHeading(page,'People');
  await expect(page.getByRole('link',{name:/Offline Alice/})).toBeVisible();

  await page.evaluate(()=>{location.hash='#reports';});
  await expectHeading(page,'Reports & Exports');
  await expect(page.locator('#main')).toBeVisible();

  await context.setOffline(false);
  await context.close();
});
