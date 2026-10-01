import { test, expect } from '@playwright/test';

test.describe.configure({mode:'serial'});

const EMAIL='wave100e-owner@example.test';
const PASSWORD='correct horse battery staple';

async function registerOwner(page){
  await page.goto('/');
  await page.getByRole('button',{name:'Create account'}).first().click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:'Create account'}).click();
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
}

test('Wave 100E: checksummed offline recovery restores atomically and converges through normal sync',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await registerOwner(page);

  const seeded=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    let state=await store.loadState();
    state=await store.updateSettings({defaultCurrency:'USD',appMode:'advanced',timezone:'UTC'},state.version);
    state=await store.createPerson({id:'person_wave100e_seed',name:'Recovery Seed',note:'server baseline',openingBalance:0,currency:'USD',direction:'to_me'},state.version);
    state=await store.createAccount({id:'account_wave100e',name:'Recovery Cash',type:'cash',currency:'USD',openingBalance:250},state.version);
    const feed=await store.importBankFeed({
      accountId:'account_wave100e',sourceName:'recovery-feed.csv',
      rows:[{date:'2026-10-01',description:'Recovery bank row',merchant:'Recovery Shop',signedAmount:-11,currency:'USD',externalId:'wave100e-bank'}]
    });
    await store.createRecurringRule({
      id:'rule_wave100e',title:'Recovery schedule',frequency:'monthly',interval:1,
      anchorDate:'2026-10-05',nextDueDate:'2026-10-05',endDate:null,remindDaysBefore:3,isActive:true,
      template:{type:'account_expense',accountId:'account_wave100e',amount:9,merchant:'Recovery Merchant',description:'Recovery recurring'}
    });
    await store.listBankFeed({limit:500,offset:0});
    await store.listRecurringRules();
    await store.listRecurringReminders();
    return {bankId:feed.items.find(row=>row.externalId==='wave100e-bank').id};
  });

  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);

  const exported=await page.evaluate(async bankId=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    let state=await db.loadStateSnapshot();
    state=await store.createPerson({
      id:'person_wave100e_offline',name:'Recovered Offline Person',note:'must survive archive restore',
      openingBalance:0,currency:'USD',direction:'to_me'
    },state.version);
    state=await store.createEntry({
      id:'entry_wave100e_offline',type:'paid_for_person',personId:'person_wave100e_offline',
      amount:17,currency:'USD',date:'2026-10-01',merchant:'Recovery Café',description:'offline archived transaction'
    },state.version);
    await store.uploadAttachment('entry_wave100e_offline',new File(['offline recovery attachment'],'recovery.txt',{type:'text/plain'}));
    await store.ignoreBankFeedItem(bankId);
    const rules=(await store.listRecurringRules()).rules;
    const rule=rules.find(row=>row.id==='rule_wave100e');
    await store.updateRecurringRule(rule.id,{...rule,title:'Recovered schedule title'});
    const archive=await store.exportOfflineRecoveryArchive();
    const inspection=await store.inspectOfflineRecoveryArchive(archive);
    const status=await store.getSyncStatus(),access=await db.offlineAccessInfo();
    return {
      archive,
      preview:inspection.preview,
      pending:status.pending,
      verifiedAt:access.verifiedAt,
      noSecrets:!/csrfToken|mot_session|passwordHash|sessionCookie/i.test(JSON.stringify(archive))
    };
  },seeded.bankId);

  expect(exported.archive.recoveryVersion).toBe(2);
  expect(exported.archive.recoveryKind).toBe('offline-working-set');
  expect(exported.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(exported.preview.pending).toBeGreaterThanOrEqual(5);
  expect(exported.preview.attachments.count).toBeGreaterThanOrEqual(1);
  expect(exported.preview.cachedBankFeed).toBeGreaterThanOrEqual(1);
  expect(exported.preview.cachedRecurring).toBeGreaterThanOrEqual(1);
  expect(exported.noSecrets).toBe(true);

  const rejected=await page.evaluate(async archive=>{
    const store=await import('/lib/store.js');
    const recovery=await import('/lib/offline-recovery.js');
    const db=await import('/lib/offline-db.js');
    const before=await db.loadStateSnapshot(),beforePending=(await store.getSyncStatus()).pending;

    const tampered=structuredClone(archive);
    tampered.payload.snapshot.people.find(row=>row.id==='person_wave100e_offline').name='Tampered Name';
    let tamperError='';
    try{await store.inspectOfflineRecoveryArchive(tampered);}catch(error){tamperError=String(error?.message||error);}

    const wrongCore=recovery.recoveryCore(archive);
    wrongCore.identity='different_account';
    wrongCore.payload=structuredClone(archive.payload);
    wrongCore.payload.identity='different_account';
    for(const key of ['queue','syncState','tombstones','attachments','attachmentQueue','fxRates','bankFeedQueue','recurringQueue']){
      for(const row of wrongCore.payload[key]||[])row.identity='different_account';
    }
    const wrong=await recovery.sealOfflineRecoveryArchive(wrongCore);
    let identityError='';
    try{await store.inspectOfflineRecoveryArchive(wrong);}catch(error){identityError=String(error?.message||error);}

    const after=await db.loadStateSnapshot(),afterPending=(await store.getSyncStatus()).pending;
    return {
      tamperError,identityError,
      samePerson:before.people.find(row=>row.id==='person_wave100e_offline')?.name===after.people.find(row=>row.id==='person_wave100e_offline')?.name,
      samePending:beforePending===afterPending
    };
  },exported.archive);

  expect(rejected.tamperError).toContain('checksum does not match');
  expect(rejected.identityError).toContain('different Money Tracker account');
  expect(rejected.samePerson).toBe(true);
  expect(rejected.samePending).toBe(true);

  const mutated=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const state=await db.loadStateSnapshot();
    await store.createPerson({id:'person_wave100e_after',name:'After Archive',note:'must disappear after restore',openingBalance:0,currency:'USD',direction:'to_me'},state.version);
    return (await store.getSyncStatus()).pending;
  });
  expect(mutated).toBeGreaterThan(exported.pending);

  await page.evaluate(()=>{location.hash='#settings';});
  await expect(page.locator('#pageHeading')).toHaveText('Settings');
  await expect(page.locator('#exportOfflineArchive')).toBeVisible();
  await expect(page.locator('#importOfflineArchive')).toBeVisible();

  await page.locator('#offlineRecoveryFile').setInputFiles({
    name:'wave100e-recovery.json',
    mimeType:'application/json',
    buffer:Buffer.from(JSON.stringify(exported.archive))
  });
  await expect(page.locator('#restoreOfflineRecoveryForm')).toBeVisible();
  await expect(page.locator('.recovery-preview-grid')).toContainText('Queued operations');
  await expect(page.locator('.modal')).toContainText('Local-device recovery only.');

  await page.locator('#restoreOfflineRecoveryForm input[name="confirmation"]').fill('RESTORE OFFLINE');
  await page.locator('#modalSave').click();
  await expect(page.locator('#restoreOfflineRecoveryForm')).toHaveCount(0);

  const restored=await page.evaluate(async bankId=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const state=await db.loadStateSnapshot(),user=await db.loadAuthorizedUser(),status=await store.getSyncStatus(),access=await db.offlineAccessInfo();
    const identity=user.id||user.email;
    const attachment=(await db.listOfflineAttachments('entry_wave100e_offline',identity)).find(row=>row.name==='recovery.txt');
    const feed=await store.listBankFeed({limit:500,offset:0});
    const rules=(await store.listRecurringRules()).rules;
    return {
      archivedPerson:state.people.some(row=>row.id==='person_wave100e_offline'),
      afterPerson:state.people.some(row=>row.id==='person_wave100e_after'),
      archivedEntry:state.entries.some(row=>row.id==='entry_wave100e_offline'),
      pending:status.pending,
      attachmentBody:attachment?.data?atob(attachment.data):'',
      bankStatus:feed.items.find(row=>row.id===bankId)?.status||'',
      recurringTitle:rules.find(row=>row.id==='rule_wave100e')?.title||'',
      verifiedAt:access.verifiedAt
    };
  },seeded.bankId);

  expect(restored.archivedPerson).toBe(true);
  expect(restored.afterPerson).toBe(false);
  expect(restored.archivedEntry).toBe(true);
  expect(restored.pending).toBe(exported.pending);
  expect(restored.attachmentBody).toBe('offline recovery attachment');
  expect(restored.bankStatus).toBe('ignored');
  expect(restored.recurringTitle).toBe('Recovered schedule title');
  expect(restored.verifiedAt).toBe(exported.verifiedAt);

  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.locator('#pageHeading')).toHaveText('Settings');
  await page.evaluate(()=>{location.hash='#people?q=recovered%20offline';});
  await expect(page.locator('#main')).toContainText('Recovered Offline Person');
  await expect(page.locator('#main')).not.toContainText('After Archive');

  await context.setOffline(false);
  await expect.poll(()=>page.evaluate(async()=>{const store=await import('/lib/store.js');return (await store.getSyncStatus()).pending;}),{timeout:15000}).toBe(0);

  const converged=await page.evaluate(async bankId=>{
    const store=await import('/lib/store.js');
    await store.syncPendingOperations({source:'wave100e-idempotency'});
    const state=await (await fetch('/api/state',{credentials:'same-origin',cache:'no-store'})).json();
    const attachments=await (await fetch('/api/attachments?entry=entry_wave100e_offline',{credentials:'same-origin',cache:'no-store'})).json();
    const feed=await store.listBankFeed({limit:500,offset:0});
    const rules=(await store.listRecurringRules()).rules;
    return {
      pending:(await store.getSyncStatus()).pending,
      personCount:state.people.filter(row=>row.id==='person_wave100e_offline').length,
      entryCount:state.entries.filter(row=>row.id==='entry_wave100e_offline').length,
      attachmentCount:(attachments.attachments||[]).filter(row=>row.name==='recovery.txt').length,
      bankStatus:feed.items.find(row=>row.id===bankId)?.status||'',
      recurringTitle:rules.find(row=>row.id==='rule_wave100e')?.title||''
    };
  },seeded.bankId);

  expect(converged).toEqual({
    pending:0,
    personCount:1,
    entryCount:1,
    attachmentCount:1,
    bankStatus:'ignored',
    recurringTitle:'Recovered schedule title'
  });

  await context.close();
});
