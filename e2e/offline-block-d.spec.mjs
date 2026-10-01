import { test, expect } from '@playwright/test';

test.describe.configure({mode:'serial'});

const EMAIL='offline-d-owner@example.test';
const PASSWORD='correct horse battery staple';

async function loginStore(page){
  await page.evaluate(async creds=>{
    const store=await import('/lib/store.js');
    await store.login(creds.email,creds.password);
  },{email:EMAIL,password:PASSWORD});
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
  return await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    return await store.loadState();
  });
}

test('Offline Block D: expired offline authorization locks UI but preserves the local ledger',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
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
    if(!state.people.some(row=>row.id==='person_offline_d_security')){
      state=await store.createPerson({
        id:'person_offline_d_security',name:'Offline D Security',note:'must stay cached',
        openingBalance:0,currency:'USD',direction:'to_me'
      },state.version);
    }
  });

  const before=await page.evaluate(async()=>{
    const db=await import('/lib/offline-db.js');
    const info=await db.offlineAccessInfo();
    const request=indexedDB.open(db.OFFLINE_DB.name,db.OFFLINE_DB.version);
    await new Promise((resolve,reject)=>{
      request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{
        const database=request.result,tx=database.transaction('meta','readwrite'),store=tx.objectStore('meta');
        const get=store.get('active-user');
        get.onsuccess=()=>store.put({...get.result,verifiedAt:'2026-09-20T00:00:00.000Z'});
        tx.oncomplete=()=>{database.close();resolve();};
        tx.onerror=()=>reject(tx.error);
      };
    });
    return {valid:info.valid};
  });
  expect(before.valid).toBe(true);

  await context.setOffline(true);
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.getByRole('heading',{name:'Money Owed Tracker'})).toBeVisible();
  await expect(page.locator('.auth-message')).toContainText('online sign-in check');

  const preserved=await page.evaluate(async()=>{
    const db=await import('/lib/offline-db.js');
    const [user,state,access]=await Promise.all([db.loadAuthorizedUser(),db.loadStateSnapshot(),db.offlineAccessInfo()]);
    return {
      email:user?.email||'',
      hasPerson:state?.people?.some(row=>row.id==='person_offline_d_security')||false,
      valid:access.valid
    };
  });
  expect(preserved).toEqual({email:EMAIL,hasPerson:true,valid:false});

  await context.setOffline(false);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:'Sign in'}).click();
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
  const refreshed=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const status=await store.getSyncStatus();
    return status.offlineAccess;
  });
  expect(refreshed.valid).toBe(true);
  expect(Date.parse(refreshed.expiresAt)).toBeGreaterThan(Date.now());

  await context.close();
});

test('Offline Block D: failed work can be exported, retried, and sync health is visible',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await page.goto('/');
  await loginStore(page);
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');

  await context.setOffline(true);
  const queued=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const state=await db.loadStateSnapshot();
    await store.createPerson({
      id:'person_offline_d_recovery',name:'Offline D Recovery',note:'retry me',
      openingBalance:0,currency:'USD',direction:'to_me'
    },state.version);
    const status=await store.getSyncStatus();
    const op=status.queue.find(row=>row.entityId==='person_offline_d_recovery');
    await db.updateQueuedOperation(op.operationId,{status:'failed',lastError:'Synthetic recoverable failure'});
    const recovery=await store.exportPendingSyncRecovery();
    return {
      operationId:op.operationId,
      recoveryVersion:recovery.recoveryVersion,
      queueCount:recovery.queue.length,
      hasSnapshot:recovery.snapshot?.people?.some(row=>row.id==='person_offline_d_recovery')||false,
      attachmentQueue:Array.isArray(recovery.attachmentQueue),
      hasSecrets:Object.keys(recovery).some(key=>/password|csrf|cookie/i.test(key))
    };
  });
  expect(queued.recoveryVersion).toBe(1);
  expect(queued.queueCount).toBeGreaterThan(0);
  expect(queued.hasSnapshot).toBe(true);
  expect(queued.attachmentQueue).toBe(true);
  expect(queued.hasSecrets).toBe(false);

  await page.evaluate(()=>{location.hash='#settings';});
  await expect(page.locator('#pageHeading')).toHaveText('Settings');
  await expect(page.locator('#retrySync')).toBeVisible();
  await expect(page.locator('#exportSyncRecovery')).toBeVisible();
  await expect(page.locator('#main')).toContainText('Offline access');
  await expect(page.locator('#main')).toContainText('Offline storage');
  await expect(page.locator('#main')).toContainText('Background Sync');

  const storage=await page.evaluate(async()=>{
    const pwa=await import('/lib/pwa.js');
    await pwa.refreshPwaStorage();
    const before=pwa.pwaStatus();
    const requested=await pwa.requestPersistentStorage();
    const after=pwa.pwaStatus();
    return {supported:before.storage.supported,requested,persisted:after.storage.persisted,quota:Number(after.storage.quota||0)};
  });
  expect(typeof storage.supported).toBe('boolean');
  expect(typeof storage.requested).toBe('boolean');
  expect(['boolean','object']).toContain(typeof storage.persisted);

  await context.setOffline(false);
  await page.locator('#retrySync').click();
  await expect.poll(()=>page.evaluate(async()=>{const store=await import('/lib/store.js');return (await store.getSyncStatus()).pending;}),{timeout:10000}).toBe(0);
  const final=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const status=await store.getSyncStatus();
    const server=await (await fetch('/api/state',{credentials:'same-origin'})).json();
    return {
      failed:status.failed,
      conflicts:status.conflicts,
      lastSyncedAt:status.lastSyncedAt,
      serverHas:server.people.some(row=>row.id==='person_offline_d_recovery')
    };
  });
  expect(final.failed).toBe(0);
  expect(final.conflicts).toBe(0);
  expect(final.serverHas).toBe(true);
  expect(Date.parse(final.lastSyncedAt)).toBeGreaterThan(0);

  await context.close();
});

test('Offline Block D: reconnect and repeated resume signals share one sync run',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await page.goto('/');
  await loginStore(page);

  await context.setOffline(true);
  await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    let state=await db.loadStateSnapshot();
    state=await store.createPerson({
      id:'person_offline_d_resume_a',name:'Resume A',note:'',
      openingBalance:0,currency:'USD',direction:'to_me'
    },state.version);
    await store.createPerson({
      id:'person_offline_d_resume_b',name:'Resume B',note:'',
      openingBalance:0,currency:'USD',direction:'to_me'
    },state.version);
  });

  let pushes=0;
  await page.route('**/api/sync/push',async route=>{
    pushes+=1;
    if(pushes===1)await new Promise(resolve=>setTimeout(resolve,250));
    await route.continue();
  });

  await context.setOffline(false);
  await page.evaluate(()=>{
    for(const reason of ['focus','visible','pageshow','service-worker']){
      window.dispatchEvent(new CustomEvent('moneytracker:sync-request',{detail:{reason}}));
    }
  });

  await expect.poll(()=>page.evaluate(async()=>{const store=await import('/lib/store.js');return (await store.getSyncStatus()).pending;}),{timeout:10000}).toBe(0);
  expect(pushes).toBe(2);
  await page.unroute('**/api/sync/push');

  const result=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const pwa=await import('/lib/pwa.js');
    const status=await store.getSyncStatus();
    const server=await (await fetch('/api/state',{credentials:'same-origin'})).json();
    const bg=await pwa.registerBackgroundSync();
    return {
      attempts:status.attempts,
      lastSyncedAt:status.lastSyncedAt,
      backgroundRegistration:bg,
      backgroundSupported:pwa.pwaStatus().backgroundSync.supported,
      count:server.people.filter(row=>['person_offline_d_resume_a','person_offline_d_resume_b'].includes(row.id)).length
    };
  });
  expect(result.count).toBe(2);
  expect(Date.parse(result.lastSyncedAt)).toBeGreaterThan(0);
  expect(typeof result.backgroundRegistration).toBe('boolean');
  expect(typeof result.backgroundSupported).toBe('boolean');

  await context.close();
});


test('Offline Block D: service worker drains the durable outbox without foreground store sync',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await page.goto('/');
  await loginStore(page);
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await expect.poll(()=>page.evaluate(async()=>{
    const registration=await navigator.serviceWorker.ready;
    return Boolean(registration.active||navigator.serviceWorker.controller);
  })).toBe(true);

  const queued=await page.evaluate(async()=>{
    const db=await import('/lib/offline-db.js');
    const [state,user]=await Promise.all([db.loadStateSnapshot(),db.loadAuthorizedUser()]);
    const stamp=new Date().toISOString();
    await db.enqueueLocalMutation({
      operationId:'op_worker_background_person',
      entity:'person',
      entityId:'person_worker_background',
      operation:'create',
      expectedRevision:state.version,
      payload:{
        id:'person_worker_background',name:'Worker Background',note:'service worker queued write',
        openingBalance:0,currency:'USD',direction:'to_me'
      },
      localRecord:{id:'person_worker_background',name:'Worker Background',note:'service worker queued write',createdAt:stamp}
    },user.id);
    return (await db.listQueuedOperations(user.id)).filter(row=>row.operationId==='op_worker_background_person').length;
  });
  expect(queued).toBe(1);

  await page.evaluate(async()=>{
    const registration=await navigator.serviceWorker.ready;
    const worker=registration.active||navigator.serviceWorker.controller;
    worker.postMessage({type:'RUN_BACKGROUND_SYNC'});
  });

  await expect.poll(()=>page.evaluate(async()=>{
    const server=await (await fetch('/api/state',{credentials:'same-origin'})).json();
    return server.people.some(row=>row.id==='person_worker_background');
  }),{timeout:10000}).toBe(true);

  await expect.poll(()=>page.evaluate(async()=>{
    const db=await import('/lib/offline-db.js');
    const user=await db.loadAuthorizedUser();
    return (await db.listQueuedOperations(user.id)).filter(row=>row.operationId==='op_worker_background_person').length;
  }),{timeout:10000}).toBe(0);

  const health=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const status=await store.getSyncStatus();
    return {pending:status.pending,lastSyncedAt:status.lastSyncedAt};
  });
  expect(health.pending).toBe(0);
  expect(Date.parse(health.lastSyncedAt)).toBeGreaterThan(0);
  await context.close();
});
