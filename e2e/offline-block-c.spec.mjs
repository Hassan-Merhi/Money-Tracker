import { test, expect } from '@playwright/test';

test.describe.configure({mode:'serial'});

const EMAIL='offline-c-owner@example.test';
const PASSWORD='correct horse battery staple';

async function moduleCall(page,fn,arg){
  return await page.evaluate(async({fn,arg})=>{
    const store=await import('/lib/store.js');
    if(fn==='register'){await store.register(arg.email,arg.password);return await store.loadState();}
    if(fn==='login'){await store.login(arg.email,arg.password);return await store.loadState();}
    if(fn==='load')return await store.loadState();
    throw new Error('Unknown helper action');
  },{fn,arg});
}

test('Offline Block C: two-device conflicts auto-rebase or resolve explicitly',async({browser})=>{
  const contextA=await browser.newContext({viewport:{width:390,height:844}});
  const pageA=await contextA.newPage();
  await pageA.goto('/');
  let stateA=await moduleCall(pageA,'register',{email:EMAIL,password:PASSWORD});

  stateA=await pageA.evaluate(async state=>{
    const store=await import('/lib/store.js');
    return await store.createPerson({
      id:'person_block_c_conflict',
      name:'Block C Person',
      note:'base',
      openingBalance:0,
      currency:'USD',
      direction:'to_me'
    },state.version);
  },stateA);

  const contextB=await browser.newContext({viewport:{width:390,height:844}});
  const pageB=await contextB.newPage();
  await pageB.goto('/');
  let stateB=await moduleCall(pageB,'login',{email:EMAIL,password:PASSWORD});

  // Unrelated server change: A should auto-rebase without a user-visible conflict.
  await contextA.setOffline(true);
  stateA=await pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const state=await db.loadStateSnapshot();
    const person=state.people.find(row=>row.id==='person_block_c_conflict');
    return await store.updatePerson(person.id,{name:person.name,note:'offline auto-rebase'},state.version);
  });

  stateB=await pageB.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const state=await store.loadState();
    return await store.createPerson({
      id:'person_block_c_unrelated',
      name:'Remote Unrelated',
      note:'',
      openingBalance:0,
      currency:'USD',
      direction:'to_me'
    },state.version);
  });

  await contextA.setOffline(false);
  await expect.poll(()=>pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const status=await store.getSyncStatus();
    return {pending:status.pending,conflicts:status.conflicts};
  }),{timeout:10000}).toEqual({pending:0,conflicts:0});

  let server=await pageA.evaluate(async()=>{
    const response=await fetch('/api/state',{credentials:'same-origin'});
    return await response.json();
  });
  expect(server.people.find(row=>row.id==='person_block_c_conflict').note).toBe('offline auto-rebase');
  expect(server.people.some(row=>row.id==='person_block_c_unrelated')).toBe(true);

  // Same-record edit: A must stop and surface a conflict.
  await pageA.evaluate(async()=>{const store=await import('/lib/store.js');await store.loadState();});
  await pageB.evaluate(async()=>{const store=await import('/lib/store.js');await store.loadState();});
  await contextA.setOffline(true);
  await pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const state=await db.loadStateSnapshot();
    const person=state.people.find(row=>row.id==='person_block_c_conflict');
    await store.updatePerson(person.id,{name:person.name,note:'keep mine value'},state.version);
  });
  await pageB.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const state=await store.loadState();
    const person=state.people.find(row=>row.id==='person_block_c_conflict');
    await store.updatePerson(person.id,{name:person.name,note:'server competing value'},state.version);
  });
  await contextA.setOffline(false);

  const conflict=await expect.poll(()=>pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const status=await store.getSyncStatus();
    return status.queue.find(row=>row.status==='conflict')||null;
  }),{timeout:10000}).not.toBeNull();

  const conflictId=await pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const status=await store.getSyncStatus();
    return status.queue.find(row=>row.status==='conflict')?.operationId||'';
  });
  expect(conflictId).toContain('op_');

  await pageA.evaluate(()=>{location.hash='#settings';});
  await expect(pageA.locator('[data-resolve-conflict][data-strategy="keep_mine"]')).toBeVisible();

  await pageA.evaluate(async operationId=>{
    const store=await import('/lib/store.js');
    await store.resolveSyncConflict(operationId,'keep_mine');
  },conflictId);

  await expect.poll(()=>pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');
    return (await store.getSyncStatus()).conflicts;
  })).toBe(0);
  server=await pageA.evaluate(async()=>await (await fetch('/api/state',{credentials:'same-origin'})).json());
  expect(server.people.find(row=>row.id==='person_block_c_conflict').note).toBe('keep mine value');

  // A second conflict proves "use server" discards the local branch for that record.
  await pageA.evaluate(async()=>{const store=await import('/lib/store.js');await store.loadState();});
  await pageB.evaluate(async()=>{const store=await import('/lib/store.js');await store.loadState();});
  await contextA.setOffline(true);
  await pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const state=await db.loadStateSnapshot(),person=state.people.find(row=>row.id==='person_block_c_conflict');
    await store.updatePerson(person.id,{name:person.name,note:'discard my value'},state.version);
  });
  await pageB.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const state=await store.loadState(),person=state.people.find(row=>row.id==='person_block_c_conflict');
    await store.updatePerson(person.id,{name:person.name,note:'keep server value'},state.version);
  });
  await contextA.setOffline(false);
  await expect.poll(()=>pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');return (await store.getSyncStatus()).conflicts;
  }),{timeout:10000}).toBe(1);
  const secondConflict=await pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');return (await store.getSyncStatus()).queue.find(row=>row.status==='conflict')?.operationId||'';
  });
  await pageA.evaluate(async operationId=>{
    const store=await import('/lib/store.js');await store.resolveSyncConflict(operationId,'keep_server');
  },secondConflict);
  server=await pageA.evaluate(async()=>await (await fetch('/api/state',{credentials:'same-origin'})).json());
  expect(server.people.find(row=>row.id==='person_block_c_conflict').note).toBe('keep server value');

  // Server deletion wins the UUID. "Keep mine" must not loop or resurrect it.
  await pageA.evaluate(async()=>{const store=await import('/lib/store.js');await store.loadState();});
  await pageB.evaluate(async()=>{const store=await import('/lib/store.js');await store.loadState();});
  await contextA.setOffline(true);
  await pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const state=await db.loadStateSnapshot(),person=state.people.find(row=>row.id==='person_block_c_conflict');
    await store.updatePerson(person.id,{name:person.name,note:'must not resurrect'},state.version);
  });
  await pageB.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const state=await store.loadState();
    await store.removePerson('person_block_c_conflict',state.version);
  });
  await contextA.setOffline(false);
  await expect.poll(()=>pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');return (await store.getSyncStatus()).conflicts;
  }),{timeout:10000}).toBe(1);
  const deletedConflict=await pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');return (await store.getSyncStatus()).queue.find(row=>row.status==='conflict')?.operationId||'';
  });
  await pageA.evaluate(()=>{location.hash='#settings';});
  await expect(pageA.locator('[data-resolve-conflict][data-strategy="keep_mine"]')).toHaveCount(0);
  await expect(pageA.locator('[data-resolve-conflict][data-strategy="keep_server"]')).toBeVisible();
  const keepMineError=await pageA.evaluate(async operationId=>{
    const store=await import('/lib/store.js');
    try{await store.resolveSyncConflict(operationId,'keep_mine');return '';}catch(error){return String(error?.message||error);}
  },deletedConflict);
  expect(keepMineError).toContain('deleted on another device');
  await pageA.evaluate(async operationId=>{
    const store=await import('/lib/store.js');await store.resolveSyncConflict(operationId,'keep_server');
  },deletedConflict);
  server=await pageA.evaluate(async()=>await (await fetch('/api/state',{credentials:'same-origin'})).json());
  expect(server.people.some(row=>row.id==='person_block_c_conflict')).toBe(false);

  // If both devices delete the same record, the intended state already converged.
  await pageA.evaluate(async()=>{const store=await import('/lib/store.js');await store.loadState();});
  await pageB.evaluate(async()=>{const store=await import('/lib/store.js');await store.loadState();});
  await contextA.setOffline(true);
  await pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    const state=await db.loadStateSnapshot();
    await store.removePerson('person_block_c_unrelated',state.version);
  });
  await pageB.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const state=await store.loadState();
    await store.removePerson('person_block_c_unrelated',state.version);
  });
  await contextA.setOffline(false);
  await expect.poll(()=>pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const status=await store.getSyncStatus();
    return {pending:status.pending,conflicts:status.conflicts};
  }),{timeout:10000}).toEqual({pending:0,conflicts:0});
  server=await pageA.evaluate(async()=>await (await fetch('/api/state',{credentials:'same-origin'})).json());
  expect(server.people.some(row=>row.id==='person_block_c_unrelated')).toBe(false);

  await contextB.close();
  await contextA.close();
});


test('Offline Block C: later queued remote edits are detected before they can be overwritten',async({browser})=>{
  const contextA=await browser.newContext({viewport:{width:390,height:844}});
  const contextB=await browser.newContext({viewport:{width:390,height:844}});
  const pageA=await contextA.newPage(),pageB=await contextB.newPage();
  await pageA.goto('/');await pageB.goto('/');
  let stateA=await moduleCall(pageA,'login',{email:EMAIL,password:PASSWORD});
  let stateB=await moduleCall(pageB,'login',{email:EMAIL,password:PASSWORD});

  for(const spec of [
    {id:'person_queue_safe_prefix',name:'Queue Safe Prefix'},
    {id:'person_queue_later_conflict',name:'Queue Later Conflict'}
  ]){
    if(!stateA.people.some(row=>row.id===spec.id)){
      stateA=await pageA.evaluate(async({state,spec})=>{
        const store=await import('/lib/store.js');
        return await store.createPerson({id:spec.id,name:spec.name,note:'base',openingBalance:0,currency:'USD',direction:'to_me'},state.version);
      },{state:stateA,spec});
    }
  }
  stateB=await pageB.evaluate(async()=>{const store=await import('/lib/store.js');return await store.loadState();});

  await contextA.setOffline(true);
  await pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    let state=await db.loadStateSnapshot();
    let person=state.people.find(row=>row.id==='person_queue_safe_prefix');
    state=await store.updatePerson(person.id,{name:person.name,note:'safe prefix local'},state.version);
    person=state.people.find(row=>row.id==='person_queue_later_conflict');
    await store.updatePerson(person.id,{name:person.name,note:'later local value'},state.version);
  });

  await pageB.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const state=await store.loadState();
    const person=state.people.find(row=>row.id==='person_queue_later_conflict');
    await store.updatePerson(person.id,{name:person.name,note:'later remote value'},state.version);
  });

  await contextA.setOffline(false);
  await expect.poll(()=>pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const status=await store.getSyncStatus();
    return {pending:status.pending,conflicts:status.conflicts,conflictId:status.queue.find(row=>row.status==='conflict')?.entityId||''};
  }),{timeout:10000}).toEqual({pending:1,conflicts:1,conflictId:'person_queue_later_conflict'});

  const server=await pageA.evaluate(async()=>await (await fetch('/api/state',{credentials:'same-origin'})).json());
  expect(server.people.find(row=>row.id==='person_queue_safe_prefix').note).toBe('safe prefix local');
  expect(server.people.find(row=>row.id==='person_queue_later_conflict').note).toBe('later remote value');

  const operationId=await pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');
    return (await store.getSyncStatus()).queue.find(row=>row.status==='conflict')?.operationId||'';
  });
  await pageA.evaluate(async operationId=>{
    const store=await import('/lib/store.js');
    await store.resolveSyncConflict(operationId,'keep_server');
  },operationId);
  await expect.poll(()=>pageA.evaluate(async()=>{const store=await import('/lib/store.js');return (await store.getSyncStatus()).pending;})).toBe(0);

  await contextB.close();await contextA.close();
});

test('Offline Block C: server-generated updatedAt does not create a false queued conflict',async({browser})=>{
  const contextA=await browser.newContext({viewport:{width:390,height:844}});
  const contextB=await browser.newContext({viewport:{width:390,height:844}});
  const pageA=await contextA.newPage(),pageB=await contextB.newPage();
  await pageA.goto('/');await pageB.goto('/');
  let stateA=await moduleCall(pageA,'login',{email:EMAIL,password:PASSWORD});
  await moduleCall(pageB,'login',{email:EMAIL,password:PASSWORD});

  if(!stateA.accounts.some(row=>row.id==='account_conflict_timestamp')){
    stateA=await pageA.evaluate(async state=>{
      const store=await import('/lib/store.js');
      return await store.createAccount({id:'account_conflict_timestamp',name:'Conflict Timestamp',type:'cash',currency:'USD',openingBalance:100},state.version);
    },stateA);
  }
  if(!stateA.entries.some(row=>row.id==='entry_conflict_timestamp')){
    stateA=await pageA.evaluate(async state=>{
      const store=await import('/lib/store.js');
      return await store.createEntry({
        id:'entry_conflict_timestamp',type:'account_expense',accountId:'account_conflict_timestamp',
        amount:10,currency:'USD',date:'2026-09-30',merchant:'Timestamp Shop',description:'base timestamp record',splits:[]
      },state.version);
    },stateA);
  }
  await pageB.evaluate(async()=>{const store=await import('/lib/store.js');await store.loadState();});

  await contextA.setOffline(true);
  await pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    let state=await db.loadStateSnapshot();
    let entry=state.entries.find(row=>row.id==='entry_conflict_timestamp');
    state=await store.updateEntry(entry.id,{...entry,description:'offline timestamp edit one'},state.version);
    entry=state.entries.find(row=>row.id==='entry_conflict_timestamp');
    await store.updateEntry(entry.id,{...entry,description:'offline timestamp edit two'},state.version);
  });

  let pushCount=0;
  await pageA.route('**/api/sync/push',async route=>{
    pushCount+=1;
    if(pushCount===1){
      const response=await route.fetch();
      await pageB.evaluate(async()=>{
        const store=await import('/lib/store.js');
        let state=await store.loadState();
        if(!state.people.some(row=>row.id==='person_timestamp_unrelated')){
          state=await store.createPerson({
            id:'person_timestamp_unrelated',name:'Timestamp Unrelated',note:'',
            openingBalance:0,currency:'USD',direction:'to_me'
          },state.version);
        }
        return state.version;
      });
      await route.fulfill({response});
      return;
    }
    await route.continue();
  });

  await contextA.setOffline(false);
  await expect.poll(()=>pageA.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const status=await store.getSyncStatus();
    return {pending:status.pending,conflicts:status.conflicts};
  }),{timeout:10000}).toEqual({pending:0,conflicts:0});
  await pageA.unroute('**/api/sync/push');

  const server=await pageA.evaluate(async()=>await (await fetch('/api/state',{credentials:'same-origin'})).json());
  expect(server.entries.find(row=>row.id==='entry_conflict_timestamp').description).toBe('offline timestamp edit two');
  expect(server.people.some(row=>row.id==='person_timestamp_unrelated')).toBe(true);

  await contextB.close();await contextA.close();
});

test('Offline Block C: transfers and attachments survive offline reload and converge',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await page.goto('/');
  let state=await moduleCall(page,'login',{email:EMAIL,password:PASSWORD});

  state=await page.evaluate(async state=>{
    const store=await import('/lib/store.js');
    let next=state;
    if(next.settings.appMode!=='advanced')next=await store.updateSettings({appMode:'advanced',defaultCurrency:'USD',timezone:'UTC'},next.version);
    next=await store.createAccount({id:'account_block_c_from',name:'Offline From',type:'bank',currency:'USD',openingBalance:200},next.version);
    next=await store.createAccount({id:'account_block_c_to',name:'Offline To',type:'cash',currency:'USD',openingBalance:20},next.version);
    next=await store.createEntry({
      id:'entry_block_c_attachment_host',type:'account_expense',accountId:'account_block_c_from',
      amount:10,currency:'USD',date:'2026-09-30',merchant:'Receipt Host',description:'Attachment host',splits:[]
    },next.version);
    return next;
  },state);

  await context.setOffline(true);
  const offlineResult=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const db=await import('/lib/offline-db.js');
    let state=await db.loadStateSnapshot();
    state=await store.createEntry({
      id:'entry_block_c_transfer',type:'account_transfer',
      fromAccountId:'account_block_c_from',toAccountId:'account_block_c_to',
      amount:35,fromAmount:35,toAmount:35,date:'2026-09-30',merchant:'',description:'Offline atomic transfer'
    },state.version);
    const file=new File(['offline attachment body'],'offline-receipt.txt',{type:'text/plain'});
    await store.uploadAttachment('entry_block_c_attachment_host',file);
    const attachments=await store.listAttachments('entry_block_c_attachment_host');
    const status=await store.getSyncStatus();
    return {
      transferCount:state.entries.filter(row=>row.id==='entry_block_c_transfer').length,
      pending:status.pending,
      attachmentPending:status.attachmentQueue.filter(row=>row.status==='pending').length,
      attachmentCount:attachments.attachments.length,
      hasLocalUrl:Boolean(attachments.attachments[0]?.localUrl)
    };
  });
  expect(offlineResult.transferCount).toBe(1);
  expect(offlineResult.pending).toBeGreaterThanOrEqual(2);
  expect(offlineResult.attachmentPending).toBe(1);
  expect(offlineResult.attachmentCount).toBe(1);
  expect(offlineResult.hasLocalUrl).toBe(true);

  await page.reload({waitUntil:'domcontentloaded'});
  await expect.poll(()=>page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const attachments=await store.listAttachments('entry_block_c_attachment_host');
    const state=await store.loadState();
    return {
      transfer:state.entries.filter(row=>row.id==='entry_block_c_transfer').length,
      attachments:attachments.attachments.length,
      local:Boolean(attachments.attachments[0]?.localUrl)
    };
  })).toEqual({transfer:1,attachments:1,local:true});

  await context.setOffline(false);
  await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    await store.syncPendingOperations();
  });
  await expect.poll(()=>page.evaluate(async()=>{
    const store=await import('/lib/store.js');return (await store.getSyncStatus()).pending;
  }),{timeout:10000}).toBe(0);

  let server=await page.evaluate(async()=>await (await fetch('/api/state',{credentials:'same-origin'})).json());
  expect(server.entries.filter(row=>row.id==='entry_block_c_transfer').length).toBe(1);
  let serverAttachments=await page.evaluate(async()=>await (await fetch('/api/attachments?entry=entry_block_c_attachment_host',{credentials:'same-origin'})).json());
  expect(serverAttachments.attachments.filter(row=>row.name==='offline-receipt.txt').length).toBe(1);

  const attachmentId=serverAttachments.attachments.find(row=>row.name==='offline-receipt.txt').id;
  await context.setOffline(true);
  await page.evaluate(async id=>{
    const store=await import('/lib/store.js');
    await store.deleteAttachment(id);
  },attachmentId);
  await page.reload({waitUntil:'domcontentloaded'});
  await expect.poll(()=>page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    return (await store.listAttachments('entry_block_c_attachment_host')).attachments.length;
  })).toBe(0);

  await context.setOffline(false);
  await page.evaluate(async()=>{const store=await import('/lib/store.js');await store.syncPendingOperations();});
  await expect.poll(()=>page.evaluate(async()=>{
    const store=await import('/lib/store.js');return (await store.getSyncStatus()).pending;
  }),{timeout:10000}).toBe(0);
  serverAttachments=await page.evaluate(async()=>await (await fetch('/api/attachments?entry=entry_block_c_attachment_host',{credentials:'same-origin'})).json());
  expect(serverAttachments.attachments.length).toBe(0);

  // A lost create response is ambiguous: the server may have committed it.
  // Deleting locally must replace the create with an idempotent delete so no orphan survives.
  let droppedAttachmentResponse=false;
  await page.route('**/api/sync/attachments',async route=>{
    if(!droppedAttachmentResponse){
      droppedAttachmentResponse=true;
      await route.fetch();
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  const ambiguous=await page.evaluate(async()=>{
    const store=await import('/lib/store.js');
    const file=new File(['ambiguous committed attachment'],'ambiguous.txt',{type:'text/plain'});
    await store.uploadAttachment('entry_block_c_attachment_host',file);
    const listed=await store.listAttachments('entry_block_c_attachment_host');
    const status=await store.getSyncStatus();
    const item=listed.attachments.find(row=>row.name==='ambiguous.txt');
    return {id:item?.id||'',pending:status.attachmentQueue.filter(row=>row.status==='pending').length};
  });
  expect(droppedAttachmentResponse).toBe(true);
  expect(ambiguous.id).toContain('attachment_');
  expect(ambiguous.pending).toBe(1);
  await page.unroute('**/api/sync/attachments');

  await context.setOffline(true);
  const afterAmbiguousDelete=await page.evaluate(async id=>{
    const store=await import('/lib/store.js');
    await store.deleteAttachment(id);
    const status=await store.getSyncStatus();
    const listed=await store.listAttachments('entry_block_c_attachment_host');
    return {
      attachmentCount:listed.attachments.length,
      queue:status.attachmentQueue.map(row=>({operation:row.operation,attachmentId:row.attachmentId,status:row.status}))
    };
  },ambiguous.id);
  expect(afterAmbiguousDelete.attachmentCount).toBe(0);
  expect(afterAmbiguousDelete.queue).toEqual([{operation:'delete',attachmentId:ambiguous.id,status:'pending'}]);

  await context.setOffline(false);
  await page.evaluate(async()=>{const store=await import('/lib/store.js');await store.syncPendingOperations();});
  await expect.poll(()=>page.evaluate(async()=>{const store=await import('/lib/store.js');return (await store.getSyncStatus()).pending;}),{timeout:10000}).toBe(0);
  serverAttachments=await page.evaluate(async()=>await (await fetch('/api/attachments?entry=entry_block_c_attachment_host',{credentials:'same-origin'})).json());
  expect(serverAttachments.attachments.some(row=>row.id===ambiguous.id)).toBe(false);

  await context.close();
});
