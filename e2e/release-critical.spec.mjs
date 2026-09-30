import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OWNER_EMAIL='wave10-owner@example.test';
const OWNER_PASSWORD='correct horse battery staple';
const PWA_VERSION_PATH=fileURLToPath(new URL('../pwa-version.js',import.meta.url));

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

async function appState(page){
  return page.evaluate(async()=>{
    const response=await fetch('/api/state',{cache:'no-store'});
    if(!response.ok)throw new Error('State request failed: '+response.status);
    return response.json();
  });
}

async function waitForState(page,predicate,message){
  await expect.poll(async()=>predicate(await appState(page)),{message,timeout:12_000}).toBe(true);
}

async function login(page){
  await page.goto('/');
  await page.getByLabel('Email').fill(OWNER_EMAIL);
  await page.getByLabel('Password').fill(OWNER_PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:'Sign in'}).click();
  await expectPageHeading(page,'Dashboard');
}

async function openHash(page,hash,heading){
  await page.evaluate(value=>{location.hash=value;},hash);
  await expectPageHeading(page,heading);
}

async function addPersonTransaction(page,values) {
  await page.locator('#personTxn').click();
  const modal=page.locator('.modal');
  await modal.getByLabel('Transaction type').selectOption(values.type);
  await modal.getByLabel('Total amount').fill(String(values.amount));
  if(values.merchant)await modal.getByLabel('Merchant / source').fill(values.merchant);
  await modal.getByLabel('Notes / details').fill(values.description);
  await modal.getByRole('button',{name:'Save'}).click();
  await expect(modal).toBeHidden();
  await waitForState(page,state=>state.entries.some(entry=>entry.type===values.type&&entry.description===values.description),values.description+' saved');
}

async function downloadFrom(page,click,suffix){
  const promise=page.waitForEvent('download');
  await click();
  const download=await promise;
  expect(download.suggestedFilename().toLowerCase()).toMatch(new RegExp('\\'+suffix+'$'));
  return download;
}

test.describe.serial('Wave 10 release-critical browser workflows',()=>{
  test('desktop: full daily workflow, import/export, Bank Feed and persistence',async({browser})=>{
    test.setTimeout(90_000);
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    const page=await context.newPage();
    page.on('dialog',dialog=>dialog.accept().catch(()=>{}));

    await page.goto('/');
    await expect(page.getByRole('heading',{name:'Money Owed Tracker'})).toBeVisible();

    await page.getByRole('button',{name:'Create account'}).first().click();
    await page.getByLabel('Email').fill(OWNER_EMAIL);
    await page.getByLabel('Password').fill(OWNER_PASSWORD);
    await page.locator('#authForm').getByRole('button',{name:'Create account'}).click();
    await expectPageHeading(page,'Dashboard');
    const assertClean=watchBrowser(page);

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

    await addPersonTransaction(page,{type:'paid_for_person',amount:'25.50',merchant:'Amazon',description:'Wave 10 browser debt'});
    await addPersonTransaction(page,{type:'received_from_person',amount:'20.50',description:'Wave 10 browser repayment'});
    await addPersonTransaction(page,{type:'borrowed_from_person',amount:'10',description:'Wave 10 browser borrowed'});
    await addPersonTransaction(page,{type:'paid_to_person',amount:'5',description:'Wave 10 browser paid them'});

    await downloadFrom(page,()=>page.locator('#personPdf').click(),'.pdf');

    let state=await appState(page);
    const debt=state.entries.find(entry=>entry.description==='Wave 10 browser debt');
    const repayment=state.entries.find(entry=>entry.description==='Wave 10 browser repayment');
    expect(debt).toBeTruthy();
    expect(repayment).toBeTruthy();

    await page.locator('[data-menu-trigger="'+debt.id+'"]').click();
    await page.locator('[data-edit-entry="'+debt.id+'"]').click();
    let modal=page.locator('.modal');
    await modal.getByLabel('Total amount').fill('30.50');
    await modal.getByLabel('Notes / details').fill('Wave 10 browser debt edited');
    await modal.getByRole('button',{name:'Save'}).click();
    await waitForState(page,s=>s.entries.some(entry=>entry.id===debt.id&&entry.amount===30.5&&entry.description==='Wave 10 browser debt edited'),'edited transaction persisted');

    await page.locator('[data-menu-trigger="'+repayment.id+'"]').click();
    await page.locator('[data-delete-entry="'+repayment.id+'"]').click();
    await waitForState(page,s=>!s.entries.some(entry=>entry.id===repayment.id),'deleted transaction removed');

    await page.locator('.statement-back-link').click();
    await expectPageHeading(page,'People');
    await page.locator('#peopleImport').click();
    await page.locator('#peoplePasteExcel').click();
    await expect(page.locator('#impQuickPaste')).toBeVisible();
    await page.locator('#impQuickPaste').fill('Name\tAmount\tDirection\tMerchant / Source\tDate\tDescription\tCurrency\nBob Browser\t40\tThey owe me\tImported\t30/09/2026\tQuick paste browser row\tUSD');
    await page.locator('#impQuickApply').click();
    await waitForState(page,s=>s.people.some(person=>person.name==='Bob Browser')&&s.entries.some(entry=>entry.description==='Quick paste browser row'),'spreadsheet paste imported into ledger');
    await expect(page.getByRole('link',{name:/Bob Browser/})).toBeVisible();

    await page.locator('.sidebar').getByRole('button',{name:'Transactions'}).click();
    await expectPageHeading(page,'Transactions');
    await page.getByLabel('Filter by date').selectOption('all');
    await expect(page.getByText('Wave 10 browser debt edited')).toBeVisible();

    await page.locator('.sidebar').getByRole('button',{name:'Settings'}).click();
    await expectPageHeading(page,'Settings');
    await page.getByLabel('App mode').selectOption('advanced');
    await page.getByRole('button',{name:'Save settings'}).click();
    await waitForState(page,s=>s.settings.appMode==='advanced','Advanced mode persisted');

    await page.reload();
    await expectPageHeading(page,'Settings');
    await expect(page.locator('.sidebar').getByRole('button',{name:'Accounts & Cash'})).toBeVisible();

    await page.locator('.sidebar').getByRole('button',{name:'Accounts & Cash'}).click();
    await expectPageHeading(page,'Accounts & Cash');
    for(const row of [['Checking','bank','500'],['Cash','cash','50']]){
      await page.locator('#addAccount').click();
      modal=page.locator('.modal');
      await modal.getByLabel('Account name').fill(row[0]);
      await modal.getByLabel('Type').selectOption(row[1]);
      await modal.getByLabel('Opening balance',{exact:true}).fill(row[2]);
      await modal.getByRole('button',{name:'Save'}).click();
      await waitForState(page,s=>s.accounts.some(account=>account.name===row[0]),row[0]+' account created');
    }

    state=await appState(page);
    const checking=state.accounts.find(account=>account.name==='Checking');
    const cash=state.accounts.find(account=>account.name==='Cash');
    expect(checking).toBeTruthy();
    expect(cash).toBeTruthy();

    await page.locator('#transferBtn').click();
    modal=page.locator('.modal');
    await modal.getByLabel('From account').selectOption(checking.id);
    await modal.getByLabel('To account').selectOption(cash.id);
    await modal.getByLabel('Amount leaving source').fill('20');
    await modal.getByLabel('Amount arriving destination').fill('20');
    await modal.getByLabel('Note').fill('Wave 10 transfer');
    await modal.getByRole('button',{name:'Save'}).click();
    await waitForState(page,s=>s.entries.some(entry=>entry.type==='account_transfer'&&entry.description==='Wave 10 transfer'),'transfer persisted');
    await expect(page.locator('.account-card').filter({hasText:'Checking'})).toContainText('480');
    await expect(page.locator('.account-card').filter({hasText:'Cash'})).toContainText('70');

    await openHash(page,'#reports','Reports & Exports');
    await downloadFrom(page,async()=>{await page.locator('#reportExportTrigger').click();await page.locator('#exportPdf').click();},'.pdf');
    await downloadFrom(page,async()=>{await page.locator('#reportExportTrigger').click();await page.locator('#exportXlsx').click();},'.xlsx');

    await openHash(page,'#bank','Bank Feed');
    await page.locator('#bankAccount').selectOption(checking.id);
    await page.locator('#bankFile').setInputFiles({
      name:'wave10-bank.csv',
      mimeType:'text/csv',
      buffer:Buffer.from('Date,Description,Amount\n2026-09-30,Coffee shop,-12.34\n')
    });
    await expect(page.locator('#bankImportNow')).toBeVisible();
    await expect(page.locator('[data-map="amount"]')).toHaveValue('Amount');
    await expect(page.locator('[data-map="debit"]')).toHaveValue('');
    await expect(page.locator('[data-map="credit"]')).toHaveValue('');
    await page.locator('#bankImportNow').click();
    await expect(page.locator('.bank-post')).toBeVisible({timeout:12_000});
    await page.locator('.bank-post').click();
    await waitForState(page,s=>s.entries.some(entry=>entry.type==='account_expense'&&Math.abs(entry.amount-12.34)<0.000001),'Bank Feed item posted');
    await page.locator('[data-bank-status="posted"]').click();
    await expect(page.locator('.bank-undo')).toBeVisible();
    await page.locator('.bank-undo').click();
    await waitForState(page,s=>!s.entries.some(entry=>entry.type==='account_expense'&&Math.abs(entry.amount-12.34)<0.000001),'Bank Feed posting undone');

    for(const row of [['#insights','Insights & Budgets'],['#scheduled','Scheduled & Reminders']]){
      await openHash(page,row[0],row[1]);
    }

    await openHash(page,'#settings','Settings');
    await page.locator('#settingsLogout').click();
    await expect(page.locator('#authForm')).toBeVisible();
    await page.getByLabel('Email').fill(OWNER_EMAIL);
    await page.getByLabel('Password').fill(OWNER_PASSWORD);
    await page.locator('#authForm').getByRole('button',{name:'Sign in'}).click();
    await expectPageHeading(page,'Dashboard');

    state=await appState(page);
    expect(state.settings.appMode).toBe('advanced');
    expect(state.people.some(person=>person.name==='Alice')).toBe(true);
    expect(state.people.some(person=>person.name==='Bob Browser')).toBe(true);
    expect(state.accounts.some(account=>account.name==='Checking')).toBe(true);
    expect(state.entries.some(entry=>entry.description==='Wave 10 transfer')).toBe(true);

    assertClean();
    await context.close();
  });

  test('mobile: real phone viewport can navigate and add data without horizontal overflow',async({browser})=>{
    test.setTimeout(60_000);
    const context=await browser.newContext({
      viewport:{width:390,height:844},
      deviceScaleFactor:3,
      isMobile:true,
      hasTouch:true
    });
    const page=await context.newPage();
    await login(page);
    const assertClean=watchBrowser(page);

    await expect(page.locator('.mobile-nav')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.locator('.mobile-nav').getByRole('button',{name:'People'}).click();
    await expectPageHeading(page,'People');
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
    await expect(page.getByText('Wave 10 browser debt edited')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.locator('.mobile-nav').getByRole('button',{name:'More navigation'}).click();
    await expect(page.getByRole('dialog',{name:'Your workspace'})).toBeVisible();
    await page.getByRole('button',{name:/Reports & Exports/}).click();
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

  test('PWA: current shell works offline and a real waiting update activates cleanly',async({browser})=>{
    test.setTimeout(75_000);
    const context=await browser.newContext({viewport:{width:1280,height:800}});
    const page=await context.newPage();
    await login(page);

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

    const original=readFileSync(PWA_VERSION_PATH,'utf8');
    const currentVersion=Number(/version:(\d+)/.exec(original)?.[1]||0);
    const nextVersion=currentVersion+1;
    const updated=original
      .replace(/version:\d+/,'version:'+nextVersion)
      .replace(/cacheName:'money-tracker-debt-v\d+'/,"cacheName:'money-tracker-debt-v"+nextVersion+"'");

    try{
      writeFileSync(PWA_VERSION_PATH,updated);
      await page.evaluate(()=>navigator.serviceWorker.getRegistration().then(registration=>registration?.update()));
      await expect(page.locator('#applyUpdate')).toBeVisible({timeout:20_000});
      await page.locator('#applyUpdate').click();
      await page.waitForFunction(version=>caches.keys().then(keys=>keys.includes('money-tracker-debt-v'+version)),nextVersion,{timeout:20_000});
      await expect(page.locator('#pageHeading')).toBeVisible();
      const keys=await page.evaluate(()=>caches.keys());
      expect(keys).toContain('money-tracker-debt-v'+nextVersion);
      expect(keys).not.toContain(cacheState.cacheName);
    } finally {
      writeFileSync(PWA_VERSION_PATH,original);
    }

    await context.close();
  });
});
