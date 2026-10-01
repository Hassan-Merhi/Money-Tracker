import { test, expect } from '@playwright/test';

test.describe.configure({mode:'serial'});
test.setTimeout(120000);

const EMAIL='wave100g-owner@example.test';
const PASSWORD='correct horse battery staple';

async function ensureOwner(page){
  await page.goto('/');
  if(await page.locator('#pageHeading').count())return;
  const create=page.getByRole('button',{name:'Create account'}).first();
  const registrationOpen=await create.count()>0;
  if(registrationOpen)await create.click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:registrationOpen?'Create account':'Sign in'}).click();
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
}

test('Wave 100G: v7→v8 adds scale indexes and 10k attachment metadata stays queryable through indexed paths',async({browser})=>{
  const context=await browser.newContext();
  const page=await context.newPage();
  await page.goto('/manifest.webmanifest');

  const result=await page.evaluate(async()=>{
    const name='money-tracker-offline';
    await new Promise(resolve=>{
      const request=indexedDB.deleteDatabase(name);
      request.onsuccess=request.onerror=request.onblocked=()=>resolve();
    });

    const legacy=await new Promise((resolve,reject)=>{
      const request=indexedDB.open(name,7);
      request.onupgradeneeded=()=>{
        const db=request.result;
        db.createObjectStore('meta',{keyPath:'key'});
        for(const store of ['people','accounts','entries','categories','budgets'])db.createObjectStore(store,{keyPath:'id'});
        db.createObjectStore('syncQueue',{keyPath:'operationId'});
        db.createObjectStore('syncState',{keyPath:'key'});
        db.createObjectStore('tombstones',{keyPath:'key'});
        db.createObjectStore('attachments',{keyPath:'id'});
        db.createObjectStore('attachmentQueue',{keyPath:'operationId'});
        db.createObjectStore('fxRates',{keyPath:'entryId'});
        db.createObjectStore('bankFeedState',{keyPath:'key'});
        db.createObjectStore('bankFeedQueue',{keyPath:'operationId'});
        db.createObjectStore('recurringState',{keyPath:'key'});
        db.createObjectStore('recurringQueue',{keyPath:'operationId'});
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    await new Promise((resolve,reject)=>{
      const tx=legacy.transaction(['meta','people','accounts','entries'],'readwrite');
      tx.objectStore('meta').put({key:'active-user',identity:'scale-user',user:{id:'scale-user',email:'scale@example.test'},savedAt:'2026-10-01T00:00:00.000Z',verifiedAt:'2026-10-01T00:00:00.000Z',schemaVersion:7});
      tx.objectStore('meta').put({key:'state-head',identity:'scale-user',head:{version:1,settings:{displayName:'Scale',defaultCurrency:'USD',appMode:'advanced',timezone:'UTC'}},savedAt:'2026-10-01T00:00:00.000Z',schemaVersion:7});
      tx.objectStore('people').put({id:'person_seed',name:'Scale Seed',note:'',createdAt:'2026-10-01T00:00:00.000Z'});
      tx.objectStore('accounts').put({id:'account_seed',name:'Scale Cash',type:'cash',currency:'USD',openingBalance:0});
      for(let i=0;i<1000;i++)tx.objectStore('entries').put({id:'entry_'+i,type:'account_expense',accountId:'account_seed',amount:1,currency:'USD',date:'2026-10-01',merchant:'',description:'scale',createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'});
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });
    legacy.close();

    const offline=await import('/lib/offline-db.js?wave100g-indexes=1');
    const opened=await offline.openOfflineDatabase();
    const indexInfo={};
    for(const storeName of ['syncQueue','attachmentQueue','bankFeedQueue','recurringQueue','tombstones','fxRates','attachments']){
      const tx=opened.transaction(storeName,'readonly');
      indexInfo[storeName]=Array.from(tx.objectStore(storeName).indexNames);
    }

    const stamp='2026-10-01T00:00:00.000Z';
    await new Promise((resolve,reject)=>{
      const tx=opened.transaction(['attachments','syncQueue','attachmentQueue','bankFeedQueue','recurringQueue'],'readwrite');
      const attachments=tx.objectStore('attachments');
      for(let i=0;i<10000;i++)attachments.put({
        id:'att_scale_'+i,identity:'scale-user',entryId:'entry_'+(i%1000),
        name:'file-'+i+'.txt',mimeType:'text/plain',sizeBytes:10,data:'',
        createdAt:stamp,synced:true,status:'synced',offlinePinned:false,offlinePolicy:'metadata'
      });
      const ledger=tx.objectStore('syncQueue'),attachmentQueue=tx.objectStore('attachmentQueue'),bank=tx.objectStore('bankFeedQueue'),recurring=tx.objectStore('recurringQueue');
      for(let i=0;i<2500;i++){
        ledger.put({operationId:'op_scale_ledger_'+i,identity:'scale-user',entity:'person',entityId:'person_done_'+i,operation:'create',payload:{},baseRevision:i,createdAt:stamp,attempts:1,status:'done',lastError:''});
        attachmentQueue.put({operationId:'op_scale_attachment_'+i,identity:'scale-user',attachmentId:'att_scale_'+i,entryId:'entry_'+(i%1000),operation:'create',createdAt:stamp,attempts:1,status:'done',lastError:''});
      }
      for(let i=0;i<1000;i++){
        bank.put({operationId:'op_scale_bank_'+i,identity:'scale-user',itemId:'bank_'+i,action:'ignore',createdAt:stamp,attempts:1,status:'done',lastError:''});
        recurring.put({operationId:'op_scale_recurring_'+i,identity:'scale-user',ruleId:'rule_'+i,action:'update',queueOrder:i+1,createdAt:stamp,attempts:1,status:'done',lastError:''});
      }
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });

    const started=performance.now();
    const [targetAttachments,ledgerQueue,attachmentQueue,bankQueue,recurringQueue,pending,schema]=await Promise.all([
      offline.listOfflineAttachments('entry_42','scale-user'),
      offline.listQueuedOperations('scale-user'),
      offline.listAttachmentQueue('scale-user'),
      offline.listBankFeedQueue('scale-user'),
      offline.listRecurringQueue('scale-user'),
      offline.pendingOperationCount('scale-user'),
      offline.offlineSchemaInfo()
    ]);
    const elapsed=performance.now()-started;
    return {
      dbVersion:opened.version,indexInfo,schema,
      targetAttachments:targetAttachments.length,
      queues:[ledgerQueue.length,attachmentQueue.length,bankQueue.length,recurringQueue.length],
      pending,elapsed
    };
  });

  expect(result.dbVersion).toBe(8);
  expect(result.indexInfo.syncQueue).toContain('byIdentity');
  expect(result.indexInfo.attachmentQueue).toContain('byIdentity');
  expect(result.indexInfo.bankFeedQueue).toContain('byIdentity');
  expect(result.indexInfo.recurringQueue).toContain('byIdentity');
  expect(result.indexInfo.attachments).toContain('byIdentity');
  expect(result.indexInfo.attachments).toContain('byIdentityEntry');
  expect(result.schema.migration.fromVersion).toBe(7);
  expect(result.schema.migration.postOpenComplete).toBe(true);
  expect(result.targetAttachments).toBe(10);
  expect(result.queues).toEqual([2500,2500,1000,1000]);
  expect(result.pending).toBe(0);
  expect(result.elapsed).toBeLessThan(5000);
  await context.close();
});

test('Wave 100G: a 250-operation durable offline queue survives reload, drains, and repeated sync stays duplicate-free',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await ensureOwner(page);
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);

  const staged=await page.evaluate(async()=>{
    const offline=await import('/lib/offline-db.js');
    const user=await offline.loadAuthorizedUser();
    const identity=user.id||user.email;
    let state=await offline.loadStateSnapshot();
    for(let i=0;i<250;i++){
      const id='person_wave100g_'+String(i).padStart(3,'0');
      const stamp=new Date(Date.now()+i).toISOString();
      const result=await offline.enqueueLocalMutation({
        operationId:'op_wave100g_'+String(i).padStart(3,'0'),
        entity:'person',entityId:id,operation:'create',expectedRevision:state.version,
        payload:{id,name:'Scale Person '+i,note:'Deep queue longevity '+i},
        localRecord:{id,name:'Scale Person '+i,note:'Deep queue longevity '+i,createdAt:stamp}
      },identity);
      state=result.state;
    }
    return {pending:await offline.pendingOperationCount(identity),version:state.version};
  });
  expect(staged.pending).toBe(250);

  await page.reload({waitUntil:'domcontentloaded'});
  const afterReload=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const state=await db.loadStateSnapshot(),status=await store.getSyncStatus();
    return {pending:status.pending,count:state.people.filter(row=>row.id.startsWith('person_wave100g_')).length};
  });
  expect(afterReload).toEqual({pending:250,count:250});

  await context.setOffline(false);
  await expect.poll(()=>page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    return (await store.getSyncStatus()).pending;
  }),{timeout:60000,intervals:[250,500,1000]}).toBe(0);

  const converged=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    for(let i=0;i<3;i++)await store.syncPendingOperations({source:'wave100g-repeat-'+i});
    const local=await store.loadState(),status=await store.getSyncStatus();
    const server=await (await fetch('/api/state',{credentials:'same-origin',cache:'no-store'})).json();
    return {
      localCount:local.people.filter(row=>row.id.startsWith('person_wave100g_')).length,
      serverCount:server.people.filter(row=>row.id.startsWith('person_wave100g_')).length,
      uniqueServer:new Set(server.people.filter(row=>row.id.startsWith('person_wave100g_')).map(row=>row.id)).size,
      localVersion:local.version,serverVersion:server.version,
      pending:status.pending,failed:status.failed,conflicts:status.conflicts
    };
  });
  expect(converged.localCount).toBe(250);
  expect(converged.serverCount).toBe(250);
  expect(converged.uniqueServer).toBe(250);
  expect(converged.localVersion).toBe(converged.serverVersion);
  expect(converged.pending).toBe(0);
  expect(converged.failed).toBe(0);
  expect(converged.conflicts).toBe(0);
  await context.close();
});
