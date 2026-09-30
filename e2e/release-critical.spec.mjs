import { test, expect } from '@playwright/test';

const OWNER_EMAIL='wave10-owner@example.test';
const OWNER_PASSWORD='correct horse battery staple';

function watchBrowser(page){
  const errors=[];
  page.on('pageerror',error=>errors.push('pageerror: '+error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push('console: '+message.text());});
  return ()=>expect(errors,'browser console/page errors').toEqual([]);
}

async function expectPageHeading(page,name){
  await expect(page.locator('#pageHeading')).toHaveText(name);
}

async function expectNoHorizontalOverflow(page){
  const metrics=await page.evaluate(()=>({
    scrollWidth:document.documentElement.scrollWidth,
    clientWidth:document.documentElement.clientWidth,
    bodyScrollWidth:document.body.scrollWidth
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth+1);
  expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.clientWidth+1);
}

async function login(page){
  await page.goto('/');
  await page.getByLabel('Email').fill(OWNER_EMAIL);
  await page.getByLabel('Password').fill(OWNER_PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:'Sign in'}).click();
  await expectPageHeading(page,'Dashboard');
}

test.describe.serial('Wave 10 release-critical browser workflows',()=>{
  test('desktop: owner signup, debt workflow, advanced accounts and transfers',async({browser})=>{
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    const page=await context.newPage();
    const assertClean=watchBrowser(page);

    await page.goto('/');
    await expect(page.getByRole('heading',{name:'Money Owed Tracker'})).toBeVisible();

    await page.getByRole('button',{name:'Create account'}).first().click();
    await page.getByLabel('Email').fill(OWNER_EMAIL);
    await page.getByLabel('Password').fill(OWNER_PASSWORD);
    await page.locator('#authForm').getByRole('button',{name:'Create account'}).click();
    await expectPageHeading(page,'Dashboard');

    await page.locator('.sidebar').getByRole('button',{name:'People'}).click();
    await expectPageHeading(page,'People');
    await page.locator('#addPerson').click();
    const personModal=page.locator('.modal');
    await personModal.getByLabel('Name').fill('Alice');
    await personModal.getByLabel('Opening balance',{exact:true}).fill('100');
    await personModal.getByRole('button',{name:'Save'}).click();
    await expect(page.getByRole('link',{name:/Alice/})).toBeVisible();

    await page.getByRole('link',{name:/Alice/}).click();
    await expectPageHeading(page,'Person statement');
    await page.locator('#personTxn').click();
    const txnModal=page.locator('.modal');
    await txnModal.getByLabel('Transaction type').selectOption('paid_for_person');
    await txnModal.getByLabel('Total amount').fill('25.50');
    await txnModal.getByLabel('Merchant / source').fill('Amazon');
    await txnModal.getByLabel('Notes / details').fill('Wave 10 browser purchase');
    await txnModal.getByRole('button',{name:'Save'}).click();
    await expect(page.getByText('Amazon')).toBeVisible();

    await page.locator('.sidebar').getByRole('button',{name:'Transactions'}).click();
    await expectPageHeading(page,'Transactions');
    await page.getByLabel('Filter by date').selectOption('all');
    await expect(page.getByText('Wave 10 browser purchase')).toBeVisible();

    await page.locator('.sidebar').getByRole('button',{name:'Settings'}).click();
    await expectPageHeading(page,'Settings');
    await page.getByLabel('App mode').selectOption('advanced');
    await page.getByRole('button',{name:'Save settings'}).click();
    await expect(page.locator('.sidebar').getByRole('button',{name:'Accounts & Cash'})).toBeVisible();

    await page.locator('.sidebar').getByRole('button',{name:'Accounts & Cash'}).click();
    await expectPageHeading(page,'Accounts & Cash');
    await page.locator('#addAccount').click();
    let modal=page.locator('.modal');
    await modal.getByLabel('Account name').fill('Checking');
    await modal.getByLabel('Opening balance',{exact:true}).fill('500');
    await modal.getByRole('button',{name:'Save'}).click();
    await expect(page.locator('.account-card').filter({hasText:'Checking'})).toBeVisible();

    await page.locator('#addAccount').click();
    modal=page.locator('.modal');
    await modal.getByLabel('Account name').fill('Cash');
    await modal.getByLabel('Type').selectOption('cash');
    await modal.getByLabel('Opening balance',{exact:true}).fill('50');
    await modal.getByRole('button',{name:'Save'}).click();
    await expect(page.locator('.account-card').filter({hasText:'Cash'})).toBeVisible();

    await page.locator('#transferBtn').click();
    modal=page.locator('.modal');
    await modal.getByLabel('From account').selectOption({label:/Checking · USD/});
    await modal.getByLabel('To account').selectOption({label:/Cash · USD/});
    await modal.getByLabel('Amount leaving source').fill('20');
    await modal.getByLabel('Amount arriving destination').fill('20');
    await modal.getByLabel('Note').fill('Wave 10 transfer');
    await modal.getByRole('button',{name:'Save'}).click();

    await expect(page.locator('.account-card').filter({hasText:'Checking'})).toContainText('480');
    await expect(page.locator('.account-card').filter({hasText:'Cash'})).toContainText('70');

    for(const [hash,heading] of [
      ['#bank','Bank Feed'],
      ['#insights','Insights & Budgets'],
      ['#scheduled','Scheduled & Reminders'],
      ['#reports','Reports & Exports']
    ]){
      await page.evaluate(value=>{location.hash=value;},hash);
      await expectPageHeading(page,heading);
    }

    assertClean();
    await context.close();
  });

  test('mobile: real phone viewport can navigate and add data without horizontal overflow',async({browser})=>{
    const context=await browser.newContext({
      viewport:{width:390,height:844},
      deviceScaleFactor:3,
      isMobile:true,
      hasTouch:true
    });
    const page=await context.newPage();
    const assertClean=watchBrowser(page);
    await login(page);

    await expect(page.locator('.mobile-nav')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.locator('.mobile-nav').getByRole('button',{name:'People'}).click();
    await expect(page.getByRole('heading',{name:'People'})).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.locator('#addPerson').click();
    const modal=page.locator('.modal');
    await modal.getByLabel('Name').fill('Mobile Person');
    await modal.getByRole('button',{name:'Save'}).click();
    await expect(page.getByRole('link',{name:/Mobile Person/})).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.locator('.mobile-nav').getByRole('button',{name:'Activity'}).click();
    await expectPageHeading(page,'Transactions');
    await page.getByLabel('Filter by date').selectOption('all');
    await expect(page.getByText('Wave 10 browser purchase')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.locator('.mobile-nav').getByRole('button',{name:'Reports'}).click();
    await expectPageHeading(page,'Reports & Exports');
    await expectNoHorizontalOverflow(page);

    await page.locator('.mobile-nav').getByRole('button',{name:'More navigation'}).click();
    await expect(page.getByRole('dialog',{name:'Your workspace'})).toBeVisible();
    await page.getByRole('button',{name:/Settings/}).click();
    await expectPageHeading(page,'Settings');
    await expectNoHorizontalOverflow(page);

    assertClean();
    await context.close();
  });

  test('PWA: current shell is installed, cached, and serves static assets offline without caching APIs',async({browser})=>{
    const context=await browser.newContext({viewport:{width:1280,height:800}});
    const page=await context.newPage();
    await page.goto('/');

    await page.waitForFunction(async()=>{
      if(!('serviceWorker' in navigator))return false;
      const registration=await navigator.serviceWorker.ready;
      return Boolean(registration.active&&navigator.serviceWorker.controller);
    });

    const cacheState=await page.evaluate(async()=>{
      const source=await fetch('/pwa-version.js',{cache:'no-store'}).then(response=>response.text());
      const cacheName=/cacheName:'([^']+)'/.exec(source)?.[1]||'';
      const keys=await caches.keys();
      const cache=await caches.open(cacheName);
      const requests=await cache.keys();
      return {
        cacheName,
        keys,
        urls:requests.map(request=>{
          const url=new URL(request.url);
          return url.pathname+url.search;
        })
      };
    });

    expect(cacheState.cacheName).toMatch(/^money-tracker-debt-v\d+$/);
    expect(cacheState.keys).toContain(cacheState.cacheName);
    expect(cacheState.urls).toContain('/index.html');
    expect(cacheState.urls).toContain('/lib/ledger.js');
    expect(cacheState.urls).toContain('/block-c-import.js');
    expect(cacheState.urls).toContain('/pwa-version.js');

    await context.setOffline(true);
    const offlineStatic=await page.evaluate(()=>fetch('/styles.css').then(response=>response.ok).catch(()=>false));
    const offlineApi=await page.evaluate(()=>fetch('/api/health').then(()=>true).catch(()=>false));
    expect(offlineStatic).toBe(true);
    expect(offlineApi).toBe(false);
    await context.setOffline(false);

    await context.close();
  });
});
