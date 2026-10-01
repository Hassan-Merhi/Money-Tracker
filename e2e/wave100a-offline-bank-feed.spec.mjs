import { test, expect } from '@playwright/test';

test.describe.configure({mode:'serial'});

const EMAIL='wave100a-owner@example.test';
const PASSWORD='correct horse battery staple';

async function loginStore(page){
  await page.goto('/');
  await page.evaluate(async creds=>{
    const store=await import('/lib/store.js');
    await store.login(creds.email,creds.password);
  },{email:EMAIL,password:PASSWORD});
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
}

async function registerOwner(page){
  await page.goto('/');
  await page.getByRole('button',{name:'Create account'}).first().click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:'Create account'}).click();
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
}

test('Wave 100A: cached Bank Feed survives airplane-mode reload and converges queued ignore + post',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await registerOwner(page);

  const seeded=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    let state=await store.loadState();
    state=await store.createAccount({
      id:'account_wave100a',name:'Wave 100A Bank',type:'bank',currency:'USD',openingBalance:500,createdAt:new Date().toISOString()
    },state.version);
    const imported=await store.importBankFeed({
      accountId:'account_wave100a',
      sourceName:'wave100a.csv',
      rows:[{date:'2026-10-01',description:'Offline coffee',merchant:'Cafe',signedAmount:-12,currency:'USD',externalId:'wave100a-row'}]
    });
    const cached=await store.listBankFeed({limit:100,offset:0});
    return {version:state.version,itemId:imported.items.find(row=>row.externalId==='wave100a-row')?.id||'',cached:cached.items.some(row=>row.externalId==='wave100a-row')};
  });
  expect(seeded.itemId).toBeTruthy();
  expect(seeded.cached).toBe(true);

  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  const offlineIgnore=await page.evaluate(async itemId=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const before=await store.listBankFeed({limit:100,offset:0});
    const ignored=await store.ignoreBankFeedItem(itemId);
    const after=await store.listBankFeed({status:'ignored',limit:100,offset:0});
    const user=await db.loadAuthorizedUser();
    const queue=await db.listBankFeedQueue(user.id||user.email);
    return {
      beforeCached:before.offline?.cached===true,
      queued:ignored.queued===true,
      rowStatus:after.items.find(row=>row.id===itemId)?.status||'',
      queueActions:queue.map(row=>row.action)
    };
  },seeded.itemId);
  expect(offlineIgnore.beforeCached).toBe(true);
  expect(offlineIgnore.queued).toBe(true);
  expect(offlineIgnore.rowStatus).toBe('ignored');
  expect(offlineIgnore.queueActions).toEqual(['ignore']);

  await page.reload({waitUntil:'domcontentloaded'});
  await page.evaluate(()=>{location.hash='#bank';});
  await expect(page.locator('#pageHeading')).toHaveText('Bank Feed');
  await expect(page.getByText('Bank Feed needs a connection')).toHaveCount(0);
  await expect(page.locator('.bank-feed-section')).toBeVisible();
  const persistedIgnore=await page.evaluate(async itemId=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const feed=await store.listBankFeed({status:'ignored',limit:100,offset:0});
    const user=await db.loadAuthorizedUser();
    return {
      found:feed.items.some(row=>row.id===itemId&&row.status==='ignored'),
      queued:(await db.listBankFeedQueue(user.id||user.email)).length
    };
  },seeded.itemId);
  expect(persistedIgnore).toEqual({found:true,queued:1});

  await context.setOffline(false);
  const ignoreConverged=await page.evaluate(async itemId=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    await store.syncPendingOperations({source:'wave100a-ignore'});
    const user=await db.loadAuthorizedUser();
    const server=await (await fetch('/api/bank-feed?limit=500&offset=0',{credentials:'same-origin',cache:'no-store'})).json();
    return {
      queued:(await db.listBankFeedQueue(user.id||user.email)).length,
      serverStatus:server.items.find(row=>row.id===itemId)?.status||''
    };
  },seeded.itemId);
  expect(ignoreConverged).toEqual({queued:0,serverStatus:'ignored'});

  const remoteContext=await browser.newContext({viewport:{width:1280,height:800}});
  const remote=await remoteContext.newPage();
  await loginStore(remote);

  const beforePost=await page.evaluate(async itemId=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    await store.reopenBankFeedItem(itemId);
    await store.listBankFeed({limit:100,offset:0});
    const state=await db.loadStateSnapshot();
    return {version:state.version,entries:state.entries.length};
  },seeded.itemId);

  await context.setOffline(true);
  const queuedPost=await page.evaluate(async({itemId,version})=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const result=await store.postBankFeedItem(itemId,{expectedRevision:version,classification:'expense',note:'Queued offline coffee'});
    const state=await db.loadStateSnapshot();
    const user=await db.loadAuthorizedUser();
    const feed=await store.listBankFeed({limit:100,offset:0});
    return {
      queued:result.queued===true,
      version:state.version,
      entries:state.entries.length,
      pendingAction:feed.items.find(row=>row.id===itemId)?.pendingAction||'',
      queue:(await db.listBankFeedQueue(user.id||user.email)).map(row=>row.action)
    };
  },{itemId:seeded.itemId,version:beforePost.version});
  expect(queuedPost.queued).toBe(true);
  expect(queuedPost.version).toBe(beforePost.version);
  expect(queuedPost.entries).toBe(beforePost.entries);
  expect(queuedPost.pendingAction).toBe('post');
  expect(queuedPost.queue).toEqual(['post']);

  const remoteRevision=await remote.evaluate(async()=>{
    const store=await import('/lib/store.js');
    let state=await store.loadState();
    state=await store.createPerson({id:'wave100a_remote_revision',name:'Remote Revision',note:'forces safe Bank Feed rebase',openingBalance:0,currency:'USD',direction:'to_me'},state.version);
    return state.version;
  });
  expect(remoteRevision).toBeGreaterThan(beforePost.version);

  await page.reload({waitUntil:'domcontentloaded'});
  const persistedPost=await page.evaluate(async itemId=>{
    const store=await import('/lib/store.js');
    const feed=await store.listBankFeed({limit:100,offset:0});
    return feed.items.find(row=>row.id===itemId)?.pendingAction||'';
  },seeded.itemId);
  expect(persistedPost).toBe('post');

  await context.setOffline(false);
  const postConverged=await page.evaluate(async({itemId,beforeEntries})=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    await store.syncPendingOperations({source:'wave100a-post'});
    const user=await db.loadAuthorizedUser();
    const local=await db.loadStateSnapshot();
    const serverState=await (await fetch('/api/state',{credentials:'same-origin',cache:'no-store'})).json();
    const serverFeed=await (await fetch('/api/bank-feed?limit=500&offset=0',{credentials:'same-origin',cache:'no-store'})).json();
    return {
      queue:(await db.listBankFeedQueue(user.id||user.email)).length,
      localVersion:local.version,
      serverVersion:serverState.version,
      localEntries:local.entries.length,
      serverEntries:serverState.entries.length,
      beforeEntries,
      feedStatus:serverFeed.items.find(row=>row.id===itemId)?.status||'',
      postedEntryId:serverFeed.items.find(row=>row.id===itemId)?.postedEntryId||''
    };
  },{itemId:seeded.itemId,beforeEntries:beforePost.entries});

  expect(postConverged.queue).toBe(0);
  expect(postConverged.feedStatus).toBe('posted');
  expect(postConverged.postedEntryId).toBeTruthy();
  expect(postConverged.localVersion).toBe(postConverged.serverVersion);
  expect(postConverged.localEntries).toBe(postConverged.serverEntries);
  expect(postConverged.localEntries).toBe(postConverged.beforeEntries+1);

  await context.setOffline(true);
  const queuedImport=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const result=await store.importBankFeed({
      accountId:'account_wave100a',
      sourceName:'offline-import.csv',
      rows:[{date:'2026-10-01',description:'Queued offline import',merchant:'Offline CSV',signedAmount:-4,currency:'USD',externalId:'wave100a-offline-import'}]
    });
    const user=await db.loadAuthorizedUser();
    const queue=await db.listBankFeedQueue(user.id||user.email);
    return {queued:result.queued===true,actions:queue.map(row=>row.action)};
  });
  expect(queuedImport).toEqual({queued:true,actions:['import']});
  await context.setOffline(false);
  const importConverged=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    await store.syncPendingOperations({source:'wave100a-import'});
    const user=await db.loadAuthorizedUser();
    const server=await (await fetch('/api/bank-feed?limit=500&offset=0',{credentials:'same-origin',cache:'no-store'})).json();
    return {
      queued:(await db.listBankFeedQueue(user.id||user.email)).length,
      imported:server.items.some(row=>row.externalId==='wave100a-offline-import')
    };
  });
  expect(importConverged).toEqual({queued:0,imported:true});

  await remoteContext.close();
  await context.close();
});


test('Wave 100A: incompatible remote Bank Feed change becomes a targeted conflict and Use server preserves unrelated work',async({browser})=>{
  const localContext=await browser.newContext({viewport:{width:390,height:844}});
  const remoteContext=await browser.newContext({viewport:{width:1280,height:800}});
  const local=await localContext.newPage(),remote=await remoteContext.newPage();
  await loginStore(local);
  await loginStore(remote);

  const setup=await local.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const state=await store.loadState();
    const imported=await store.importBankFeed({
      accountId:'account_wave100a',
      sourceName:'wave100a-conflict.csv',
      rows:[{date:'2026-10-01',description:'Conflict candidate',merchant:'Conflict Shop',signedAmount:-9,currency:'USD',externalId:'wave100a-conflict'}]
    });
    await store.listBankFeed({limit:100,offset:0});
    const item=imported.items.find(row=>row.externalId==='wave100a-conflict');
    return {itemId:item.id,revision:state.version,identity:(await db.loadAuthorizedUser()).id};
  });

  await localContext.setOffline(true);
  const queued=await local.evaluate(async({itemId,revision})=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const result=await store.postBankFeedItem(itemId,{expectedRevision:revision,classification:'expense',note:'local conflicting post'});
    const user=await db.loadAuthorizedUser();
    await store.createPerson({id:'wave100a_unrelated_local',name:'Unrelated Local Work',note:'must survive bank conflict resolution',openingBalance:0,currency:'USD',direction:'to_me'},revision);
    const bankQueue=await db.listBankFeedQueue(user.id||user.email);
    const ledgerQueue=await db.listQueuedOperations(user.id||user.email);
    return {operationId:result.operationId,bank:bankQueue.map(row=>row.action),ledger:ledgerQueue.map(row=>row.entityId)};
  },setup);
  expect(queued.bank).toEqual(['post']);
  expect(queued.ledger).toContain('wave100a_unrelated_local');

  await remote.evaluate(async itemId=>{
    const store=await import('/lib/store.js');
    await store.ignoreBankFeedItem(itemId);
  },setup.itemId);

  await localContext.setOffline(false);
  const conflicted=await local.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const result=await store.syncPendingOperations({source:'wave100a-conflict'});
    const status=await store.getSyncStatus();
    return {
      pending:status.pending,
      bankConflicts:(status.bankFeedQueue||[]).filter(row=>row.status==='conflict').map(row=>({id:row.operationId,action:row.action})),
      ledgerQueued:(status.queue||[]).map(row=>row.entityId),
      synced:result.synced===true
    };
  });
  expect(conflicted.bankConflicts).toEqual([{id:queued.operationId,action:'post'}]);
  expect(conflicted.ledgerQueued).toContain('wave100a_unrelated_local');
  expect(conflicted.synced).toBe(false);

  const resolved=await local.evaluate(async operationId=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    await store.resolveBankFeedConflict(operationId);
    const user=await db.loadAuthorizedUser();
    const status=await store.getSyncStatus();
    const feed=await store.listBankFeed({limit:100,offset:0});
    return {
      bankQueue:(await db.listBankFeedQueue(user.id||user.email)).length,
      ledgerQueue:(await db.listQueuedOperations(user.id||user.email)).length,
      bankConflicts:(status.bankFeedQueue||[]).filter(row=>row.status==='conflict').length,
      rowStatus:feed.items.find(row=>row.id==='${setup.itemId}')?.status||''
    };
  },queued.operationId);
  // Read the actual row separately because Playwright evaluate only receives one serialized argument.
  const finalState=await local.evaluate(async itemId=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const user=await db.loadAuthorizedUser();
    const feed=await store.listBankFeed({limit:100,offset:0});
    return {
      bankQueue:(await db.listBankFeedQueue(user.id||user.email)).length,
      ledgerQueue:(await db.listQueuedOperations(user.id||user.email)).length,
      rowStatus:feed.items.find(row=>row.id===itemId)?.status||'',
      localPerson:(await db.loadStateSnapshot()).people.some(row=>row.id==='wave100a_unrelated_local')
    };
  },setup.itemId);
  expect(resolved.bankQueue).toBe(0);
  expect(resolved.bankConflicts).toBe(0);
  expect(finalState.bankQueue).toBe(0);
  expect(finalState.ledgerQueue).toBe(0);
  expect(finalState.rowStatus).toBe('ignored');
  expect(finalState.localPerson).toBe(true);

  await remoteContext.close();
  await localContext.close();
});
