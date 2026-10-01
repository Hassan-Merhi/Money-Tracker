import { test, expect } from '@playwright/test';

test.describe.configure({mode:'serial'});

const EMAIL='wave100c-owner@example.test';
const PASSWORD='correct horse battery staple';
let serverAttachmentId='';

async function registerOwner(page){
  await page.goto('/');
  await page.getByRole('button',{name:'Create account'}).first().click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:'Create account'}).click();
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
  await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    let state=await store.loadState();
    if(state.settings.appMode!=='advanced')state=await store.updateSettings({appMode:'advanced',defaultCurrency:'USD',timezone:'Asia/Beirut'},state.version);
    if(!state.accounts.some(row=>row.id==='account_wave100c'))state=await store.createAccount({id:'account_wave100c',name:'Wave 100C Bank',type:'bank',currency:'USD',openingBalance:500},state.version);
    if(!state.entries.some(row=>row.id==='entry_wave100c'))state=await store.createEntry({id:'entry_wave100c',type:'account_expense',accountId:'account_wave100c',amount:5,currency:'USD',date:'2026-10-01',merchant:'Attachment Cache',description:'Wave 100C host',splits:[]},state.version);
  });
}

async function loginStore(page){
  await page.goto('/');
  await page.evaluate(async creds=>{
    const store=await import('/lib/store.js');
    await store.login(creds.email,creds.password);
  },{email:EMAIL,password:PASSWORD});
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
}

test('Wave 100C: v6 attachment rows migrate safely to v7 policy metadata',async({browser})=>{
  const context=await browser.newContext();
  const page=await context.newPage();
  await page.goto('/pwa-version.js');
  const result=await page.evaluate(async()=>{
    await new Promise((resolve,reject)=>{
      const req=indexedDB.open('money-tracker-offline',6);
      req.onupgradeneeded=()=>{
        const db=req.result;
        if(!db.objectStoreNames.contains('meta'))db.createObjectStore('meta',{keyPath:'key'});
        if(!db.objectStoreNames.contains('attachments'))db.createObjectStore('attachments',{keyPath:'id'});
      };
      req.onerror=()=>reject(req.error);
      req.onsuccess=()=>{
        const db=req.result,tx=db.transaction(['meta','attachments'],'readwrite');
        tx.objectStore('meta').put({key:'active-user',identity:'migration-user',user:{id:'migration-user',email:'migration@example.test'},savedAt:'2026-10-01T00:00:00.000Z',verifiedAt:'2026-10-01T00:00:00.000Z'});
        tx.objectStore('attachments').put({id:'attachment_legacy_synced',entryId:'entry_migration',name:'legacy.txt',mimeType:'text/plain',sizeBytes:6,data:btoa('legacy'),createdAt:'2026-09-30T00:00:00.000Z',identity:'migration-user',synced:true,status:'synced'});
        tx.objectStore('attachments').put({id:'attachment_local_pending',entryId:'entry_migration',name:'local.txt',mimeType:'text/plain',sizeBytes:5,data:btoa('local'),createdAt:'2026-09-30T00:00:01.000Z',identity:'migration-user',synced:false,status:'pending'});
        tx.oncomplete=()=>{db.close();resolve();};
        tx.onerror=()=>reject(tx.error);
      };
    });
    const dbmod=await import('/lib/offline-db.js');
    const opened=await dbmod.openOfflineDatabase();
    const tx=opened.transaction('attachments','readonly'),store=tx.objectStore('attachments');
    const read=id=>new Promise((resolve,reject)=>{const req=store.get(id);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
    const legacy=await read('attachment_legacy_synced'),local=await read('attachment_local_pending');
    return {version:opened.version,legacy:{offlinePinned:legacy.offlinePinned,offlinePolicy:legacy.offlinePolicy,hasData:Boolean(legacy.data)},local:{offlinePinned:local.offlinePinned,offlinePolicy:local.offlinePolicy,hasData:Boolean(local.data)}};
  });
  expect(result.version).toBe(7);
  expect(result.legacy).toEqual({offlinePinned:false,offlinePolicy:'legacy',hasData:true});
  expect(result.local).toEqual({offlinePinned:true,offlinePolicy:'local',hasData:true});
  await context.close();
});

test('Wave 100C: server attachment pins, survives airplane-mode reload, and unpins without deleting server file',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await registerOwner(page);

  const prepared=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const file=new File(['server-backed attachment body'],'server-copy.txt',{type:'text/plain'});
    await store.uploadAttachment('entry_wave100c',file);
    await store.syncPendingOperations({source:'wave100c-seed'});
    let listed=await store.listAttachments('entry_wave100c');
    const item=listed.attachments.find(row=>row.name==='server-copy.txt');
    await store.unpinAttachmentOffline(item.id);
    listed=await store.listAttachments('entry_wave100c');
    const metadataOnly=listed.attachments.find(row=>row.id===item.id);
    const server=await (await fetch('/api/attachments?entry=entry_wave100c',{credentials:'same-origin',cache:'no-store'})).json();
    return {id:item.id,metadataOnly:{offlineAvailable:metadataOnly.offlineAvailable,offlinePinned:metadataOnly.offlinePinned},serverCount:server.attachments.filter(row=>row.id===item.id).length};
  });
  serverAttachmentId=prepared.id;
  expect(prepared.serverCount).toBe(1);
  expect(prepared.metadataOnly.offlineAvailable).toBe(false);

  const pinned=await page.evaluate(async id=>{
    const store=await import('/lib/store.js');
    await store.pinAttachmentOffline(id);
    const listed=await store.listAttachments('entry_wave100c');
    const item=listed.attachments.find(row=>row.id===id);
    const status=await store.getAttachmentCacheStatus();
    return {offlineAvailable:item.offlineAvailable,offlinePinned:item.offlinePinned,localUrl:item.localUrl,cachedCount:status.cachedCount,pinnedCount:status.pinnedCount};
  },serverAttachmentId);
  expect(pinned.offlineAvailable).toBe(true);
  expect(pinned.offlinePinned).toBe(true);
  expect(pinned.localUrl).toContain('data:text/plain;base64,');
  expect(pinned.cachedCount).toBeGreaterThanOrEqual(1);
  expect(pinned.pinnedCount).toBeGreaterThanOrEqual(1);

  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await context.setOffline(true);
  await page.reload({waitUntil:'domcontentloaded'});
  const offline=await page.evaluate(async id=>{
    const store=await import('/lib/store.js');
    const listed=await store.listAttachments('entry_wave100c');
    const item=listed.attachments.find(row=>row.id===id);
    return {offlineAvailable:item?.offlineAvailable||false,offlinePinned:item?.offlinePinned||false,body:item?.localUrl?atob(item.localUrl.split(',')[1]):''};
  },serverAttachmentId);
  expect(offline).toEqual({offlineAvailable:true,offlinePinned:true,body:'server-backed attachment body'});

  const unpinned=await page.evaluate(async id=>{
    const store=await import('/lib/store.js');
    await store.unpinAttachmentOffline(id);
    const item=(await store.listAttachments('entry_wave100c')).attachments.find(row=>row.id===id);
    return {offlineAvailable:item?.offlineAvailable||false,offlinePinned:item?.offlinePinned||false};
  },serverAttachmentId);
  expect(unpinned).toEqual({offlineAvailable:false,offlinePinned:false});

  await context.setOffline(false);
  const serverStillExists=await page.evaluate(async id=>{
    const list=await (await fetch('/api/attachments?entry=entry_wave100c',{credentials:'same-origin',cache:'no-store'})).json();
    const binary=await fetch('/api/attachments/'+encodeURIComponent(id),{credentials:'same-origin',cache:'no-store'});
    return {count:list.attachments.filter(row=>row.id===id).length,body:await binary.text()};
  },serverAttachmentId);
  expect(serverStillExists).toEqual({count:1,body:'server-backed attachment body'});
  await context.close();
});

test('Wave 100C: safe eviction preserves pinned and unsynced local-only attachment data',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await loginStore(page);

  await page.evaluate(async id=>{const store=await import('/lib/store.js');await store.listAttachments('entry_wave100c');await store.pinAttachmentOffline(id);},serverAttachmentId);
  await context.setOffline(true);

  const safety=await page.evaluate(async pinnedId=>{
    const store=await import('/lib/store.js');
    const dbmod=await import('/lib/offline-db.js');
    const file=new File(['pending local only body'],'pending-local.txt',{type:'text/plain'});
    await store.uploadAttachment('entry_wave100c',file);
    const listed=await store.listAttachments('entry_wave100c');
    const pending=listed.attachments.find(row=>row.name==='pending-local.txt');
    let unpinError='';
    try{await store.unpinAttachmentOffline(pending.id);}catch(error){unpinError=String(error?.message||error);}

    const user=await dbmod.loadAuthorizedUser(),identity=user.id||user.email,db=await dbmod.openOfflineDatabase();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('attachments','readwrite');
      tx.objectStore('attachments').put({id:'attachment_wave100c_legacy',entryId:'entry_wave100c',name:'legacy-cache.txt',mimeType:'text/plain',sizeBytes:11,data:btoa('legacy cache'),createdAt:'2026-09-30T00:00:00.000Z',identity,synced:true,status:'synced',offlinePinned:false,offlinePolicy:'legacy',cachedAt:'2026-09-30T00:00:00.000Z',lastAccessedAt:'2026-09-30T00:00:00.000Z'});
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
    });
    const cleared=await store.clearEvictableAttachmentCache();
    const pinned=await dbmod.getOfflineAttachment(pinnedId,identity),local=await dbmod.getOfflineAttachment(pending.id,identity),legacy=await dbmod.getOfflineAttachment('attachment_wave100c_legacy',identity);
    return {
      pendingId:pending.id,
      unpinError,
      evicted:cleared.evicted,
      pinnedHasData:Boolean(pinned?.data),
      pendingHasData:Boolean(local?.data),
      legacyHasData:Boolean(legacy?.data),
      queue:(await dbmod.listAttachmentQueue(identity)).filter(row=>row.attachmentId===pending.id).map(row=>row.operation)
    };
  },serverAttachmentId);

  expect(safety.unpinError).toContain('not synced yet');
  expect(safety.evicted).toBeGreaterThanOrEqual(1);
  expect(safety.pinnedHasData).toBe(true);
  expect(safety.pendingHasData).toBe(true);
  expect(safety.legacyHasData).toBe(false);
  expect(safety.queue).toEqual(['create']);

  await context.setOffline(false);
  await page.evaluate(async()=>{const store=await import('/lib/store.js');await store.syncPendingOperations({source:'wave100c-local-upload'});});
  await expect.poll(()=>page.evaluate(async()=>{const store=await import('/lib/store.js');return (await store.getSyncStatus()).attachmentQueue.length;}),{timeout:10000}).toBe(0);

  const afterSync=await page.evaluate(async id=>{
    const store=await import('/lib/store.js');
    await store.unpinAttachmentOffline(id);
    const item=(await store.listAttachments('entry_wave100c')).attachments.find(row=>row.id===id);
    return {offlineAvailable:item?.offlineAvailable||false,serverCount:(await (await fetch('/api/attachments?entry=entry_wave100c',{credentials:'same-origin',cache:'no-store'})).json()).attachments.filter(row=>row.id===id).length};
  },safety.pendingId);
  expect(afterSync).toEqual({offlineAvailable:false,serverCount:1});
  await context.close();
});
