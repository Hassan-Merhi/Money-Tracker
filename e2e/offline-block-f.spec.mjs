import { test, expect } from '@playwright/test';

test.describe.configure({mode:'serial'});

const EMAIL='offline-f-owner@example.test';
const PASSWORD='correct horse battery staple';

async function registerOwner(page){
  await page.goto('/');
  await page.getByRole('button',{name:'Create account'}).first().click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:'Create account'}).click();
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
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

test('Offline Block F: two isolated devices conflict, resolve and converge; replay and full-refresh monitoring stay correct',async({browser})=>{
  const contextA=await browser.newContext({viewport:{width:390,height:844}});
  const contextB=await browser.newContext({viewport:{width:1280,height:800}});
  const a=await contextA.newPage();
  const b=await contextB.newPage();

  await registerOwner(a);
  await a.evaluate(async()=>{
    const store=await import('/lib/store.js');
    let state=await store.loadState();
    state=await store.createPerson({
      id:'person_converge_f',name:'Original F',note:'base',
      openingBalance:0,currency:'USD',direction:'to_me'
    },state.version);
  });
  await a.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await expect.poll(()=>a.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);

  await loginStore(b);

  const base=await a.evaluate(async()=>{
    const db=await import('/lib/offline-db.js');
    const state=await db.loadStateSnapshot();
    return {version:state.version,name:state.people.find(row=>row.id==='person_converge_f')?.name};
  });
  expect(base.name).toBe('Original F');

  await contextA.setOffline(true);
  await a.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const state=await db.loadStateSnapshot();
    await store.updatePerson('person_converge_f',{name:'Device A Offline',note:'local edit'},state.version);
  });
  const pendingOffline=await a.evaluate(async()=>{
    const store=await import('/lib/store.js');
    return await store.getSyncStatus();
  });
  expect(pendingOffline.pending).toBeGreaterThan(0);

  await b.evaluate(async()=>{
    const store=await import('/lib/store.js');
    let state=await store.loadState();
    await store.updatePerson('person_converge_f',{name:'Device B Online',note:'remote edit'},state.version);
  });

  await contextA.setOffline(false);
  await a.evaluate(async()=>{
    const store=await import('/lib/store.js');
    await store.syncPendingOperations({source:'offline-f-convergence'});
  });
  const conflict=await a.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const status=await store.getSyncStatus();
    const user=await db.loadAuthorizedUser();
    const queue=await db.listQueuedOperations(user.id||user.email);
    return {
      status,
      operationId:queue.find(row=>row.entity==='person'&&row.entityId==='person_converge_f')?.operationId||''
    };
  });
  expect(conflict.status.conflicts).toBeGreaterThan(0);
  expect(conflict.operationId).toBeTruthy();

  await a.evaluate(async operationId=>{
    const store=await import('/lib/store.js');
    await store.resolveSyncConflict(operationId,'keep_mine');
  },conflict.operationId);

  const converged=await a.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const local=await db.loadStateSnapshot();
    const server=await (await fetch('/api/state',{credentials:'same-origin',cache:'no-store'})).json();
    const status=await store.getSyncStatus();
    return {
      localVersion:local.version,
      serverVersion:server.version,
      localName:local.people.find(row=>row.id==='person_converge_f')?.name,
      serverName:server.people.find(row=>row.id==='person_converge_f')?.name,
      pending:status.pending,conflicts:status.conflicts,failed:status.failed
    };
  });
  expect(converged.localVersion).toBe(converged.serverVersion);
  expect(converged.localName).toBe('Device A Offline');
  expect(converged.serverName).toBe('Device A Offline');
  expect({pending:converged.pending,conflicts:converged.conflicts,failed:converged.failed}).toEqual({pending:0,conflicts:0,failed:0});

  const remoteDevice=await b.evaluate(async()=>{
    const state=await (await fetch('/api/state',{credentials:'same-origin',cache:'no-store'})).json();
    return {version:state.version,name:state.people.find(row=>row.id==='person_converge_f')?.name};
  });
  expect(remoteDevice).toEqual({version:converged.serverVersion,name:'Device A Offline'});

  const gapAndReplay=await b.evaluate(async()=>{
    const auth=await (await fetch('/api/auth/me',{credentials:'same-origin',cache:'no-store'})).json();
    const headers={'Content-Type':'application/json','X-CSRF-Token':auth.csrfToken};
    const before=await (await fetch('/api/state',{credentials:'same-origin',cache:'no-store'})).json();

    const gapResponse=await fetch('/api/people/person_converge_f',{
      method:'PUT',credentials:'same-origin',headers,
      body:JSON.stringify({name:'Gap Edit F',note:'direct endpoint creates a history gap',expectedRevision:before.version})
    });
    if(!gapResponse.ok)throw new Error('Could not create sync-history gap: '+gapResponse.status);
    const afterGap=await gapResponse.json();

    const pull=await (await fetch('/api/sync/pull?sinceRevision='+encodeURIComponent(String(before.version)),{
      credentials:'same-origin',cache:'no-store'
    })).json();

    const operation={
      operationId:'op_f_idempotent_replay',
      entity:'person',entityId:'person_replay_f',operation:'create',
      payload:{id:'person_replay_f',name:'Replay Once F',note:'idempotency',openingBalance:0,currency:'USD',direction:'to_me'},
      baseRevision:afterGap.version
    };
    const firstResponse=await fetch('/api/sync/push',{method:'POST',credentials:'same-origin',headers,body:JSON.stringify({operation})});
    const first=await firstResponse.json();
    const replayResponse=await fetch('/api/sync/push',{method:'POST',credentials:'same-origin',headers,body:JSON.stringify({operation})});
    const replay=await replayResponse.json();

    const staleOperation={
      operationId:'op_f_stale_conflict',
      entity:'person',entityId:'person_stale_f',operation:'create',
      payload:{id:'person_stale_f',name:'Must Not Land F',note:'stale',openingBalance:0,currency:'USD',direction:'to_me'},
      baseRevision:afterGap.version
    };
    const staleResponse=await fetch('/api/sync/push',{method:'POST',credentials:'same-origin',headers,body:JSON.stringify({operation:staleOperation})});
    const stale=await staleResponse.json();

    const finalState=await (await fetch('/api/state',{credentials:'same-origin',cache:'no-store'})).json();
    const health=await (await fetch('/api/health',{cache:'no-store'})).json();
    return {
      beforeVersion:before.version,
      afterGapVersion:afterGap.version,
      pull,
      firstStatus:firstResponse.status,first,
      replayStatus:replayResponse.status,replay,
      staleStatus:staleResponse.status,stale,
      replayRows:finalState.people.filter(row=>row.id==='person_replay_f').length,
      staleRows:finalState.people.filter(row=>row.id==='person_stale_f').length,
      health
    };
  });

  expect(gapAndReplay.afterGapVersion).toBe(gapAndReplay.beforeVersion+1);
  expect(gapAndReplay.pull.requiresFullRefresh).toBe(true);
  expect(gapAndReplay.firstStatus).toBe(201);
  expect(gapAndReplay.first.alreadyProcessed).not.toBe(true);
  expect(gapAndReplay.replayStatus).toBe(200);
  expect(gapAndReplay.replay.alreadyProcessed).toBe(true);
  expect(gapAndReplay.replayRows).toBe(1);
  expect(gapAndReplay.staleStatus).toBe(409);
  expect(gapAndReplay.staleRows).toBe(0);

  expect(gapAndReplay.health.offlineBlockFVersion).toBe(1);
  expect(gapAndReplay.health.offlineSyncMonitor.version).toBe(1);
  expect(gapAndReplay.health.offlineSyncMonitor.privacy).toBe('aggregate-only-no-ledger-payloads');
  const metrics=gapAndReplay.health.offlineSyncMonitor.metrics;
  expect(metrics.pushAccepted.count).toBeGreaterThan(0);
  expect(metrics.pushReplayed.count).toBeGreaterThan(0);
  expect(metrics.pushConflict.count).toBeGreaterThan(0);
  expect(metrics.pulls.count).toBeGreaterThan(0);
  expect(metrics.pullFullRefresh.count).toBeGreaterThan(0);

  const monitorText=JSON.stringify(gapAndReplay.health.offlineSyncMonitor);
  for(const secret of ['offline-f-owner@example.test','person_converge_f','person_replay_f','Gap Edit F','Replay Once F'])expect(monitorText).not.toContain(secret);

  await contextA.close();
  await contextB.close();
});
