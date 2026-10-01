import { test, expect } from '@playwright/test';

test.describe.configure({mode:'serial'});

const EMAIL='wave100d-owner@example.test';
const PASSWORD='correct horse battery staple';

async function registerOwner(page){
  await page.goto('/');
  await page.getByRole('button',{name:'Create account'}).first().click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:'Create account'}).click();
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
}

test('Wave 100D: local search and compound filters survive airplane-mode reload including unsynced work',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await registerOwner(page);

  const seeded=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    let state=await store.loadState();
    state=await store.updateSettings({defaultCurrency:'USD',appMode:'advanced',timezone:'UTC'},state.version);
    state=await store.createPerson({id:'person_wave100d_ana',name:'Ána García',note:'Cousin',openingBalance:0,currency:'USD',direction:'to_me'},state.version);
    state=await store.createAccount({id:'account_wave100d_card',name:'Travel Card',type:'bank',currency:'USD',openingBalance:500},state.version);
    state=await store.createAccount({id:'account_wave100d_cash',name:'Cash Wallet',type:'cash',currency:'USD',openingBalance:100},state.version);
    state=await store.createEntry({id:'entry_wave100d_online',type:'paid_for_person',personId:'person_wave100d_ana',amount:12,currency:'USD',date:'2026-09-20',merchant:'Amazon',description:'Older headphones'},state.version);

    await store.importBankFeed({
      accountId:'account_wave100d_card',sourceName:'October card.csv',
      rows:[{date:'2026-10-01',description:'Breakfast receipt',merchant:'Café Grocer',signedAmount:-8,currency:'USD',externalId:'wave100d-card'}]
    });
    await store.importBankFeed({
      accountId:'account_wave100d_cash',sourceName:'October cash.csv',
      rows:[{date:'2026-10-02',description:'Airport ride',merchant:'Taxi',signedAmount:-20,currency:'USD',externalId:'wave100d-cash'}]
    });

    await store.createRecurringRule({
      id:'rule_wave100d_rent',title:'Rent transfer',frequency:'monthly',interval:1,anchorDate:'2026-10-05',nextDueDate:'2026-10-05',endDate:null,remindDaysBefore:3,isActive:true,
      template:{type:'account_transfer',fromAccountId:'account_wave100d_card',toAccountId:'account_wave100d_cash',amount:100,description:'Home rent'}
    });
    await store.createRecurringRule({
      id:'rule_wave100d_amazon',title:'Amazon for Ána',frequency:'monthly',interval:1,anchorDate:'2026-10-10',nextDueDate:'2026-10-10',endDate:null,remindDaysBefore:3,isActive:true,
      template:{type:'paid_for_person',personId:'person_wave100d_ana',amount:15,merchant:'Amazon',description:'Monthly order'}
    });
    const rules=(await store.listRecurringRules()).rules;
    const amazon=rules.find(row=>row.id==='rule_wave100d_amazon');
    await store.updateRecurringRule(amazon.id,{...amazon,isActive:false});
    await store.listRecurringRules();
    await store.listRecurringReminders();
    await store.listBankFeed({limit:500,offset:0});
    return {version:(await store.loadState()).version};
  });
  expect(seeded.version).toBeGreaterThan(1);

  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  const localEntry=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const state=await db.loadStateSnapshot();
    const next=await store.createEntry({
      id:'entry_wave100d_offline',type:'paid_for_person',personId:'person_wave100d_ana',
      amount:27,currency:'USD',date:'2026-10-01',merchant:'Offline Café',description:'Coffee receipt created offline'
    },state.version);
    const status=await store.getSyncStatus();
    return {exists:next.entries.some(row=>row.id==='entry_wave100d_offline'),pending:status.pending};
  });
  expect(localEntry.exists).toBe(true);
  expect(localEntry.pending).toBeGreaterThan(0);

  await page.reload({waitUntil:'domcontentloaded'});

  await page.evaluate(()=>{location.hash='#people?q=ana%20garcia';});
  await expect(page.locator('#pageHeading')).toHaveText('People');
  await expect(page.locator('#main')).toContainText('Ána García');

  await page.evaluate(()=>{location.hash='#transactions?period=all&q=offline%20cafe&person=person_wave100d_ana';});
  await expect(page.locator('#pageHeading')).toHaveText('Transactions');
  await expect(page.locator('#filterSearch')).toHaveValue('offline cafe');
  await expect(page.locator('#main')).toContainText('Offline Café');
  await expect(page.locator('#main')).not.toContainText('Older headphones');

  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.locator('#pageHeading')).toHaveText('Transactions');
  await expect(page.locator('#filterSearch')).toHaveValue('offline cafe');
  await expect(page.locator('#main')).toContainText('Offline Café');

  await page.evaluate(()=>{location.hash='#reports?period=all&q=offline%20cafe&person=person_wave100d_ana';});
  await expect(page.locator('#pageHeading')).toHaveText('Reports & Exports');
  await expect(page.locator('#reportSearch')).toHaveValue('offline cafe');
  const txnStat=page.locator('.report-stats .stat').filter({hasText:'TRANSACTIONS IN PERIOD'});
  await expect(txnStat.locator('.stat-value')).toHaveText('1');

  await page.evaluate(()=>{location.hash='#bank';});
  await expect(page.locator('#pageHeading')).toHaveText('Bank Feed');
  await expect(page.locator('.bank-offline-status')).toContainText('Offline Bank Feed');
  await page.locator('#bankSearch').fill('cafe grocer october');
  await page.locator('#bankFilterAccount').selectOption('account_wave100d_card');
  await page.locator('#bankFilterFrom').fill('2026-10-01');
  await page.locator('#bankFilterTo').fill('2026-10-31');
  await expect(page.locator('.bank-feed-list')).toContainText('Café Grocer');
  await expect(page.locator('.bank-feed-list')).not.toContainText('Taxi');

  await page.evaluate(()=>{location.hash='#scheduled';});
  await expect(page.locator('#pageHeading')).toHaveText('Scheduled & Reminders');
  await expect(page.locator('.recurring-note')).toContainText('Offline reminders are active');
  await page.locator('#recurringSearch').fill('amazon ana');
  await page.locator('#recurringStatusFilter').selectOption('paused');
  await expect(page.locator('#main')).toContainText('Amazon for Ána');
  await expect(page.locator('#main')).not.toContainText('Rent transfer');

  const direct=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const state=await db.loadStateSnapshot();
    const reporting=await import('/lib/reporting.js');
    const feed=await store.listBankFeed({q:'cafe grocer october',accountId:'account_wave100d_card',from:'2026-10-01',to:'2026-10-31',status:'pending',limit:100,offset:0});
    return {
      reportIds:reporting.filteredEntries(state,{q:'offline cafe',personId:'person_wave100d_ana'}).map(row=>row.id),
      bankIds:feed.items.map(row=>row.externalId),
      cached:feed.offline?.cached===true
    };
  });
  expect(direct.reportIds).toContain('entry_wave100d_offline');
  expect(direct.bankIds).toEqual(['wave100d-card']);
  expect(direct.cached).toBe(true);

  await context.close();
});
