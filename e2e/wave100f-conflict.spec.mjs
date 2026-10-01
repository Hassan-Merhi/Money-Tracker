import { test, expect } from '@playwright/test';

const EMAIL='wave100f-owner@example.test';
const PASSWORD='correct horse battery staple';

async function loginOwner(page){
  await page.goto('/');
  if(await page.locator('#pageHeading').count())return;
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.locator('#authForm').getByRole('button',{name:'Sign in'}).click();
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
}

test('Wave 100F conflict: remote divergence remains explicit and use-server recovery preserves unrelated work',async({browser})=>{
  const localContext=await browser.newContext({viewport:{width:390,height:844}});
  const local=await localContext.newPage();
  await loginOwner(local);

  const baseline=await local.evaluate(async()=>{
    const store=await import('/lib/store.js');
    let state=await store.loadState();
    state=await store.createPerson({id:'person_wave100f_conflict',name:'Conflict Base',note:'before divergence',openingBalance:0,currency:'USD',direction:'to_me'},state.version);
    return state.version;
  });
  expect(baseline).toBeGreaterThan(1);

  const remoteContext=await browser.newContext({viewport:{width:390,height:844}});
  const remote=await remoteContext.newPage();
  await loginOwner(remote);
  await remote.evaluate(async()=>{const store=await import('/lib/store.js');await store.loadState();});

  await localContext.setOffline(true);
  await local.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    let state=await db.loadStateSnapshot();
    state=await store.updatePerson('person_wave100f_conflict',{name:'Local Offline Name',note:'local divergent edit'},state.version);
    await store.createPerson({id:'person_wave100f_unrelated',name:'Unrelated Queued Person',note:'must survive conflict recovery',openingBalance:0,currency:'USD',direction:'to_me'},state.version);
  });

  const remoteVersion=await remote.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const state=await store.loadState();
    const next=await store.updatePerson('person_wave100f_conflict',{name:'Remote Authoritative Name',note:'remote edit wins in this test'},state.version);
    return next.version;
  });
  expect(remoteVersion).toBeGreaterThan(baseline);

  await localContext.setOffline(false);
  await expect.poll(()=>local.evaluate(async()=>{const store=await import('/lib/store.js');return (await store.getSyncStatus()).conflicts;}),{timeout:12000}).toBeGreaterThan(0);

  const conflicted=await local.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const status=await store.getSyncStatus();
    const target=status.queue.find(row=>row.entityId==='person_wave100f_conflict'&&row.status==='conflict');
    return {
      operationId:target?.operationId||'',
      unrelatedPending:status.queue.some(row=>row.entityId==='person_wave100f_unrelated'&&row.status==='pending'),
      failed:status.failed
    };
  });
  expect(conflicted.operationId).toMatch(/^op_/);
  expect(conflicted.unrelatedPending).toBe(true);
  expect(conflicted.failed).toBe(0);

  await local.evaluate(async operationId=>{
    const store=await import('/lib/store.js');
    await store.resolveSyncConflict(operationId,'keep_server');
  },conflicted.operationId);

  await expect.poll(()=>local.evaluate(async()=>{const store=await import('/lib/store.js');return (await store.getSyncStatus()).pending;}),{timeout:12000}).toBe(0);
  const final=await local.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const localState=await store.loadState();
    const server=await (await fetch('/api/state',{credentials:'same-origin',cache:'no-store'})).json();
    const status=await store.getSyncStatus();
    return {
      localName:localState.people.find(row=>row.id==='person_wave100f_conflict')?.name,
      serverName:server.people.find(row=>row.id==='person_wave100f_conflict')?.name,
      unrelatedCount:server.people.filter(row=>row.id==='person_wave100f_unrelated').length,
      pending:status.pending,failed:status.failed,conflicts:status.conflicts
    };
  });
  expect(final).toEqual({
    localName:'Remote Authoritative Name',
    serverName:'Remote Authoritative Name',
    unrelatedCount:1,
    pending:0,failed:0,conflicts:0
  });

  await localContext.close();
  await remoteContext.close();
});
