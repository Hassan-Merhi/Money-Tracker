import { test, expect } from '@playwright/test';

test.describe.configure({mode:'serial'});

const EMAIL='wave100a-owner@example.test';
const PASSWORD='correct horse battery staple';

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

  await context.close();
});
