import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.describe.configure({mode:'serial'});

const EMAIL='offline-e-owner@example.test';
const PASSWORD='correct horse battery staple';

async function loginStore(page){
  await page.evaluate(async creds=>{
    const store=await import('/lib/store.js');
    await store.login(creds.email,creds.password);
  },{email:EMAIL,password:PASSWORD});
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
}

async function downloadBytes(page,buttonId){
  await page.locator('#reportExportTrigger').click();
  const downloadPromise=page.waitForEvent('download');
  await page.locator(buttonId).click();
  const download=await downloadPromise,path=await download.path();
  return {download,bytes:await readFile(path)};
}

test('Offline Block E: cached reports export PDF/XLSX offline and retain recorded FX plus unsynced changes',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true});
  const page=await context.newPage();
  await page.goto('/');
  await page.getByRole('button',{name:'Create account'}).first().click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:'Create account'}).click();
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');

  await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    let state=await store.loadState();
    state=await store.updateSettings({appMode:'advanced',defaultCurrency:'USD'},state.version);
    state=await store.createAccount({id:'acct_usd_e',name:'USD Bank',type:'bank',currency:'USD',openingBalance:1000},state.version);
    state=await store.createAccount({id:'acct_eur_e',name:'EUR Wallet',type:'cash',currency:'EUR',openingBalance:0},state.version);
    state=await store.createEntry({
      id:'entry_fx_e',type:'account_transfer',fromAccountId:'acct_usd_e',toAccountId:'acct_eur_e',
      fromAmount:100,toAmount:92,amount:100,currency:'USD',date:'2026-10-01',
      merchant:'',description:'Recorded FX transfer',categoryId:null,splits:[]
    },state.version);
  });
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    let state=await db.loadStateSnapshot();
    await store.createEntry({
      id:'entry_unsynced_export_e',type:'account_expense',personId:null,accountId:'acct_usd_e',
      amount:7,currency:'USD',date:'2026-10-01',merchant:'Offline Cafe',
      description:'Queued coffee for offline export',categoryId:null,splits:[]
    },state.version);
  });

  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
  await page.evaluate(()=>{location.hash='#reports';});
  await expect(page.locator('#pageHeading')).toHaveText('Reports & Exports');
  await expect(page.locator('#main')).toContainText('generated entirely on this device');
  await expect(page.locator('#main')).toContainText('USD/EUR');
  await expect(page.locator('#main')).toContainText('1 USD = 0.92 EUR');

  const pdf=await downloadBytes(page,'#exportPdf');
  expect(pdf.download.suggestedFilename()).toMatch(/\.pdf$/);
  expect(pdf.bytes.subarray(0,8).toString('utf8')).toContain('%PDF-1.4');
  expect(pdf.bytes.toString('utf8')).toContain('Recorded FX rates');
  expect(pdf.bytes.toString('utf8')).toContain('Offline Cafe');

  const xlsx=await downloadBytes(page,'#exportXlsx');
  expect(xlsx.download.suggestedFilename()).toMatch(/\.xlsx$/);
  expect(Array.from(xlsx.bytes.subarray(0,4))).toEqual([0x50,0x4b,0x03,0x04]);
  const xlsxText=xlsx.bytes.toString('utf8');
  expect(xlsxText).toContain('FX Rates');
  expect(xlsxText).toContain('recorded_transfer');
  expect(xlsxText).toContain('Queued coffee for offline export');

  const status=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    return await store.getSyncStatus();
  });
  expect(status.pending).toBeGreaterThan(0);
  await context.close();
});

test('Offline Block E: v3 IndexedDB migrates atomically through current schema and preserves every durable queue class',async({browser})=>{
  const context=await browser.newContext();
  const page=await context.newPage();
  await page.goto('/manifest.webmanifest');

  const result=await page.evaluate(async()=>{
    const name='money-tracker-offline';
    await new Promise(resolve=>{
      const request=indexedDB.deleteDatabase(name);
      request.onsuccess=request.onerror=request.onblocked=()=>resolve();
    });
    const db=await new Promise((resolve,reject)=>{
      const request=indexedDB.open(name,3);
      request.onupgradeneeded=()=>{
        const d=request.result;
        d.createObjectStore('meta',{keyPath:'key'});
        for(const store of ['people','accounts','entries','categories','budgets'])d.createObjectStore(store,{keyPath:'id'});
        d.createObjectStore('syncQueue',{keyPath:'operationId'});
        d.createObjectStore('syncState',{keyPath:'key'});
        d.createObjectStore('tombstones',{keyPath:'key'});
        d.createObjectStore('attachments',{keyPath:'id'});
        d.createObjectStore('attachmentQueue',{keyPath:'operationId'});
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(['meta','people','accounts','entries','syncQueue','attachments','attachmentQueue'],'readwrite');
      tx.objectStore('meta').put({key:'active-user',identity:'migrator',user:{id:'migrator',email:'migration@example.test'},savedAt:'2026-10-01T00:00:00.000Z',verifiedAt:'2026-10-01T00:00:00.000Z',schemaVersion:3});
      tx.objectStore('meta').put({key:'state-head',identity:'migrator',head:{version:7,settings:{displayName:'Migrated',defaultCurrency:'USD',appMode:'advanced',timezone:'UTC'}},savedAt:'2026-10-01T00:00:00.000Z',schemaVersion:3});
      tx.objectStore('people').put({id:'p_migrate',name:'Preserved Person',note:'',createdAt:'2026-10-01T00:00:00.000Z'});
      tx.objectStore('accounts').put({id:'usd_migrate',name:'USD',type:'bank',currency:'USD',openingBalance:100});
      tx.objectStore('accounts').put({id:'eur_migrate',name:'EUR',type:'cash',currency:'EUR',openingBalance:0});
      tx.objectStore('entries').put({id:'fx_migrate',type:'account_transfer',fromAccountId:'usd_migrate',toAccountId:'eur_migrate',fromAmount:50,toAmount:46,date:'2026-09-30',createdAt:'2026-09-30T00:00:00.000Z',updatedAt:'2026-09-30T00:00:00.000Z'});
      tx.objectStore('syncQueue').put({operationId:'op_migrate',identity:'migrator',entity:'person',entityId:'p_pending',operation:'create',payload:{id:'p_pending',name:'Pending'},baseRevision:7,createdAt:'2026-10-01T00:00:00.000Z',attempts:0,status:'pending',lastError:''});
      tx.objectStore('attachments').put({id:'att_migrate',identity:'migrator',entryId:'fx_migrate',name:'proof.txt',mimeType:'text/plain',sizeBytes:4,data:'dGVzdA==',createdAt:'2026-10-01T00:00:00.000Z',synced:false,status:'pending'});
      tx.objectStore('attachmentQueue').put({operationId:'attop_migrate',identity:'migrator',attachmentId:'att_migrate',entryId:'fx_migrate',operation:'create',createdAt:'2026-10-01T00:00:00.000Z',attempts:0,status:'pending',lastError:''});
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });
    db.close();

    const offline=await import('/lib/offline-db.js?offline-e-migration=1');
    const opened=await offline.openOfflineDatabase();
    const [schema,state,queue,attachmentQueue,attachments,fx]=await Promise.all([
      offline.offlineSchemaInfo(),
      offline.loadStateSnapshot(),
      offline.listQueuedOperations('migrator'),
      offline.listAttachmentQueue('migrator'),
      offline.listOfflineAttachments('fx_migrate','migrator'),
      offline.offlineFxRates('migrator')
    ]);
    const transfer=state.entries.find(row=>row.id==='fx_migrate');
    await offline.enqueueLocalMutation({
      operationId:'op_fx_rebase_e',
      entity:'entry',
      entityId:'fx_migrate',
      operation:'update',
      expectedRevision:state.version,
      payload:{...transfer,toAmount:47},
      localRecord:{...transfer,toAmount:47,updatedAt:'2026-10-01T00:05:00.000Z'}
    },'migrator');
    const remoteState={...state,version:state.version+1,entries:state.entries.map(row=>row.id==='fx_migrate'?{...row,toAmount:45,updatedAt:'2026-10-01T00:06:00.000Z'}:row)};
    await offline.rebaseQueuedOperations(remoteState,'migrator',{operationId:'op_fx_rebase_e',strategy:'keep_server'});
    const fxAfterRebase=await offline.offlineFxRates('migrator');
    return {
      dbVersion:opened.version,
      stores:Array.from(opened.objectStoreNames),
      schema,
      person:state.people.find(row=>row.id==='p_migrate')?.name||'',
      stateVersion:state.version,
      queue:queue.map(row=>row.operationId),
      attachmentQueue:attachmentQueue.map(row=>row.operationId),
      attachments:attachments.map(row=>row.id),
      fx:fx.map(row=>({entryId:row.entryId,pair:row.pair,rate:row.rate,source:row.source})),
      fxAfterRebase:fxAfterRebase.map(row=>({entryId:row.entryId,rate:row.rate}))
    };
  });

  expect(result.dbVersion).toBe(6);
  expect(result.stores).toContain('bankFeedState');
  expect(result.stores).toContain('bankFeedQueue');
  expect(result.stores).toContain('recurringState');
  expect(result.stores).toContain('recurringQueue');
  expect(result.stores).toContain('fxRates');
  expect(result.schema.migration.fromVersion).toBe(3);
  expect(result.schema.migration.postOpenComplete).toBe(true);
  expect(result.person).toBe('Preserved Person');
  expect(result.stateVersion).toBe(7);
  expect(result.queue).toEqual(['op_migrate']);
  expect(result.attachmentQueue).toEqual(['attop_migrate']);
  expect(result.attachments).toEqual(['att_migrate']);
  expect(result.fx).toEqual([{entryId:'fx_migrate',pair:'USD/EUR',rate:0.92,source:'recorded_transfer'}]);
  expect(result.fxAfterRebase).toEqual([{entryId:'fx_migrate',rate:0.9}]);
  await context.close();
});

test('Offline Block E: update metadata is schema-aware and UI blocks update while outbox is dirty',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await page.goto('/');
  await loginStore(page);
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});

  const workerInfo=await page.evaluate(async()=>{
    const registration=await navigator.serviceWorker.ready,worker=registration.active||navigator.serviceWorker.controller;
    return await new Promise(resolve=>{
      const channel=new MessageChannel(),timer=setTimeout(()=>resolve(null),3000);
      channel.port1.onmessage=event=>{clearTimeout(timer);resolve(event.data);};
      worker.postMessage({type:'GET_UPDATE_INFO'},[channel.port2]);
    });
  });
  expect(workerInfo.version).toBe(32);
  expect(workerInfo.offlineDbVersion).toBe(6);
  expect(workerInfo.minMigratableOfflineDbVersion).toBe(1);

  await page.evaluate(()=>{location.hash='#settings';});
  await expect(page.locator('#pageHeading')).toHaveText('Settings');
  await page.evaluate(async()=>{
    const pwa=await import('/lib/pwa.js');
    const current=pwa.pwaStatus();
    window.dispatchEvent(new CustomEvent('moneytracker:pwa',{detail:{...current,updateWaiting:true,update:{version:null,offlineDbVersion:null,minMigratableOfflineDbVersion:null,compatible:false,reason:'Compatibility metadata unavailable'}}}));
  });
  const blockedButton=page.locator('#settingsApplyUpdate');
  await expect(blockedButton).toBeVisible();
  await expect(blockedButton).toBeDisabled();
  await expect(blockedButton).toHaveText('Update blocked');

  await context.setOffline(true);
  await page.evaluate(async()=>{
    const store=await import('/lib/store.js'),db=await import('/lib/offline-db.js');
    const state=await db.loadStateSnapshot();
    await store.createPerson({id:'person_update_block_e',name:'Do Not Lose Me',note:'pending update guard',openingBalance:0,currency:'USD',direction:'to_me'},state.version);
  });
  await page.reload({waitUntil:'domcontentloaded'});
  await page.evaluate(()=>{location.hash='#settings';});
  await expect(page.locator('#pageHeading')).toHaveText('Settings');

  await page.evaluate(async()=>{
    const pwa=await import('/lib/pwa.js');
    const current=pwa.pwaStatus();
    window.dispatchEvent(new CustomEvent('moneytracker:pwa',{detail:{...current,updateWaiting:true,update:{version:32,offlineDbVersion:6,compatible:true,reason:''}}}));
  });
  const updateButton=page.locator('#settingsApplyUpdate');
  await expect(updateButton).toBeVisible();
  await expect(updateButton).toBeDisabled();
  await expect(updateButton).toHaveText('Sync before update');

  const pending=await page.evaluate(async()=>{const store=await import('/lib/store.js');return (await store.getSyncStatus()).pending;});
  expect(pending).toBeGreaterThan(0);
  await context.close();
});
