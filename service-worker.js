importScripts('/pwa-version.js');
const CACHE=self.MONEY_TRACKER_PWA.cacheName;
const OFFLINE_DB_NAME='money-tracker-offline';
const ACTIVE_USER_KEY='active-user';
const SYNC_BASE_KEY='sync-base';
const LAST_SYNC_KEY='last-sync';
const CORE=[
  '/','/index.html','/pwa-version.js','/styles.css','/dashboard.css','/mobile.css?v=mobile-v3','/activity.css?v=mobile-v3','/desktop-tablet.css?v=wave4-v1','/visual-audit.css?v=wave14-v1','/lib/dashboard-ui.js','/theme-init.js','/app.js?v=mobile-v3',
  '/block-c-import.js','/block-c-import.css','/block-e-recurring.js','/block-e-recurring.css',
  '/block-f-bank-feed.js','/block-f-bank-feed.css','/block-g-insights.js','/block-g-insights.css',
  '/manifest.webmanifest','/assets/icon.svg','/assets/icon-192.png','/assets/icon-512.png',
  '/lib/ledger.js','/lib/money.js','/lib/money-parse.js','/lib/fx.js','/lib/store.js','/lib/offline-db.js','/lib/utils.js','/lib/pwa.js',
  '/lib/recurring.js','/lib/recurring-rule-form.js','/lib/bank-feed.js','/lib/insights.js',
  '/lib/reporting.js','/lib/xlsx.js','/lib/importer.js','/lib/legacy-excel.js','/lib/pdf.js','/lib/reports-ui.js'
];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE)));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});

async function requestClientSync(reason){
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  for(const client of windows)client.postMessage({type:'MONEY_TRACKER_SYNC_REQUEST',reason});
}

function requestResult(request){
  return new Promise((resolve,reject)=>{
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error||new Error('Offline database request failed.'));
  });
}
function transactionDone(transaction){
  return new Promise((resolve,reject)=>{
    transaction.oncomplete=()=>resolve();
    transaction.onerror=()=>reject(transaction.error||new Error('Offline database transaction failed.'));
    transaction.onabort=()=>reject(transaction.error||new Error('Offline database transaction was aborted.'));
  });
}
function userIdentity(user){return String(user?.id||user?.email||'').trim();}

async function openOfflineDb(){
  return await new Promise((resolve,reject)=>{
    const request=indexedDB.open(OFFLINE_DB_NAME);
    let missing=false;
    request.onupgradeneeded=()=>{
      missing=true;
      request.transaction?.abort();
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>missing?resolve(null):reject(request.error||new Error('Could not open offline database.'));
  });
}
async function readStore(db,name){
  return await requestResult(db.transaction(name,'readonly').objectStore(name).getAll());
}
async function readRow(db,name,key){
  return await requestResult(db.transaction(name,'readonly').objectStore(name).get(key));
}
async function deleteRow(db,name,key){
  const tx=db.transaction(name,'readwrite');
  tx.objectStore(name).delete(key);
  await transactionDone(tx);
}
async function updateRow(db,name,key,patch){
  const tx=db.transaction(name,'readwrite'),store=tx.objectStore(name);
  const row=await requestResult(store.get(key));
  if(!row){await transactionDone(tx);return false;}
  store.put({...row,...patch});
  await transactionDone(tx);
  return true;
}
async function refreshVerifiedUser(db,user){
  const identity=userIdentity(user);
  if(!identity)return false;
  const tx=db.transaction('meta','readwrite'),store=tx.objectStore('meta');
  const active=await requestResult(store.get(ACTIVE_USER_KEY));
  if(!active||active.identity!==identity){await transactionDone(tx);return false;}
  const stamp=new Date().toISOString();
  store.put({...active,user:{...active.user,...user},savedAt:stamp,verifiedAt:stamp});
  await transactionDone(tx);
  return true;
}
async function markWorkerSync(db,identity,revision,source){
  const tx=db.transaction('syncState','readwrite'),store=tx.objectStore('syncState'),stamp=new Date().toISOString();
  if(Number.isInteger(Number(revision)))store.put({key:SYNC_BASE_KEY,identity,serverRevision:Number(revision),updatedAt:stamp});
  store.put({key:LAST_SYNC_KEY,identity,lastSyncedAt:stamp,serverRevision:Number.isInteger(Number(revision))?Number(revision):null,source});
  await transactionDone(tx);
}
async function updateWorkerAttachment(db,id,metadata){
  const tx=db.transaction('attachments','readwrite'),store=tx.objectStore('attachments');
  const row=await requestResult(store.get(id));
  if(row)store.put({...row,...metadata,synced:true,status:'synced'});
  await transactionDone(tx);
}
function sortedLedgerQueue(rows){
  return [...rows].sort((a,b)=>Number(a.baseRevision)-Number(b.baseRevision)||String(a.createdAt).localeCompare(String(b.createdAt))||String(a.operationId).localeCompare(String(b.operationId)));
}
function sortedAttachmentQueue(rows){
  return [...rows].sort((a,b)=>{
    if(a.attachmentId===b.attachmentId&&a.operation!==b.operation)return a.operation==='create'?-1:1;
    return String(a.createdAt).localeCompare(String(b.createdAt))||String(a.operationId).localeCompare(String(b.operationId));
  });
}
function sortedBankFeedQueue(rows){
  return [...rows].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))||String(a.operationId).localeCompare(String(b.operationId)));
}
function sortedRecurringQueue(rows){
  return [...rows].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))||String(a.operationId).localeCompare(String(b.operationId)));
}
async function saveWorkerBankFeedSnapshot(db,identity,snapshot){
  if(!db.objectStoreNames.contains('bankFeedState'))return false;
  const tx=db.transaction('bankFeedState','readwrite');
  tx.objectStore('bankFeedState').put({key:'bank-feed',identity,snapshot:{...snapshot,cachedAt:new Date().toISOString()},savedAt:new Date().toISOString()});
  await transactionDone(tx);return true;
}
async function saveWorkerRecurringSnapshot(db,identity,snapshot){
  if(!db.objectStoreNames.contains('recurringState'))return false;
  const tx=db.transaction('recurringState','readwrite');
  tx.objectStore('recurringState').put({key:'recurring',identity,snapshot:{...snapshot,cachedAt:new Date().toISOString()},savedAt:new Date().toISOString()});
  await transactionDone(tx);return true;
}
async function responseData(response){
  try{return await response.json();}catch{return {};}
}

let backgroundSyncInFlight=null;
async function runBackgroundSync(source='background-sync'){
  if(backgroundSyncInFlight)return await backgroundSyncInFlight;
  backgroundSyncInFlight=(async()=>{
    const authResponse=await fetch('/api/auth/me',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
    if(!authResponse.ok){
      if(authResponse.status===401)await requestClientSync('background-auth-required');
      return false;
    }
    const auth=await responseData(authResponse),identity=userIdentity(auth.user);
    if(!identity||!auth.csrfToken)return false;
    const db=await openOfflineDb();
    if(!db)return false;
    try{
      const active=await readRow(db,'meta',ACTIVE_USER_KEY);
      if(active?.identity!==identity)return false;
      await refreshVerifiedUser(db,auth.user);

      let lastRevision=null,reopenedFeedItems=0;
      const headers={'Content-Type':'application/json','X-CSRF-Token':auth.csrfToken};

      for(const snapshot of sortedLedgerQueue((await readStore(db,'syncQueue')).filter(row=>row.identity===identity))){
        const operation=await readRow(db,'syncQueue',snapshot.operationId);
        if(!operation)continue;
        if(operation.status==='failed'||operation.status==='conflict'){
          await requestClientSync('background-needs-attention');
          return false;
        }
        if(operation.status!=='pending')continue;
        await updateRow(db,'syncQueue',operation.operationId,{attempts:Number(operation.attempts||0)+1,lastError:''});
        let response;
        try{
          response=await fetch('/api/sync/push',{method:'POST',credentials:'same-origin',headers,body:JSON.stringify({operation})});
        }catch(error){
          await updateRow(db,'syncQueue',operation.operationId,{status:'pending',lastError:'Connection lost during background sync.'}).catch(()=>{});
          throw error;
        }
        const data=await responseData(response);
        if(!response.ok){
          if(response.status===401){
            await updateRow(db,'syncQueue',operation.operationId,{status:'pending',lastError:'Sign in again to resume sync.'}).catch(()=>{});
            await requestClientSync('background-auth-required');
            return false;
          }
          if(response.status===409){
            await updateRow(db,'syncQueue',operation.operationId,{status:'pending',lastError:data.error||'Open Money Tracker to resolve this sync conflict.'}).catch(()=>{});
            await requestClientSync('background-conflict');
            return false;
          }
          await updateRow(db,'syncQueue',operation.operationId,{status:'failed',lastError:data.error||'The server rejected this offline change.'}).catch(()=>{});
          await requestClientSync('background-failed');
          return false;
        }
        reopenedFeedItems+=Number(data.reopenedFeedItems||0);
        if(Number.isInteger(Number(data.revision)))lastRevision=Number(data.revision);
        await deleteRow(db,'syncQueue',operation.operationId);
      }

      const ledgerRemaining=(await readStore(db,'syncQueue')).filter(row=>row.identity===identity&&['pending','failed','conflict'].includes(String(row.status||'pending')));
      if(ledgerRemaining.length){
        await requestClientSync('background-ledger-pending');
        return false;
      }

      if(db.objectStoreNames.contains('bankFeedQueue')){
        for(const snapshot of sortedBankFeedQueue((await readStore(db,'bankFeedQueue')).filter(row=>row.identity===identity))){
          const operation=await readRow(db,'bankFeedQueue',snapshot.operationId);
          if(!operation)continue;
          if(operation.status==='failed'||operation.status==='conflict'){
            await requestClientSync('background-needs-attention');
            return false;
          }
          if(operation.status!=='pending')continue;
          if(['post','undo'].includes(operation.action)){
            await requestClientSync('background-bank-feed-ledger');
            return false;
          }
          await updateRow(db,'bankFeedQueue',operation.operationId,{attempts:Number(operation.attempts||0)+1,lastError:''});
          let response;
          try{
            response=await fetch('/api/sync/bank-feed',{method:'POST',credentials:'same-origin',headers,body:JSON.stringify({operation})});
          }catch(error){
            await updateRow(db,'bankFeedQueue',operation.operationId,{status:'pending',lastError:'Connection lost during background Bank Feed sync.'}).catch(()=>{});
            throw error;
          }
          const data=await responseData(response);
          if(!response.ok){
            if(response.status===401){
              await updateRow(db,'bankFeedQueue',operation.operationId,{status:'pending',lastError:'Sign in again to resume Bank Feed sync.'}).catch(()=>{});
              await requestClientSync('background-auth-required');
              return false;
            }
            await updateRow(db,'bankFeedQueue',operation.operationId,{status:response.status===409?'conflict':'failed',lastError:data.error||'The server rejected this Bank Feed change.'}).catch(()=>{});
            await requestClientSync(response.status===409?'background-conflict':'background-failed');
            return false;
          }
          await deleteRow(db,'bankFeedQueue',operation.operationId);
        }
        try{
          const bankResponse=await fetch('/api/bank-feed?limit=500&offset=0',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
          if(bankResponse.ok)await saveWorkerBankFeedSnapshot(db,identity,await responseData(bankResponse));
        }catch{}
      }

      if(db.objectStoreNames.contains('recurringQueue')){
        for(const snapshot of sortedRecurringQueue((await readStore(db,'recurringQueue')).filter(row=>row.identity===identity))){
          const operation=await readRow(db,'recurringQueue',snapshot.operationId);
          if(!operation)continue;
          if(operation.status==='failed'||operation.status==='conflict'){
            await requestClientSync('background-needs-attention');
            return false;
          }
          if(operation.status!=='pending')continue;
          if(operation.action==='post'){
            await requestClientSync('background-recurring-ledger');
            return false;
          }
          await updateRow(db,'recurringQueue',operation.operationId,{attempts:Number(operation.attempts||0)+1,lastError:''});
          let response;
          try{
            response=await fetch('/api/sync/recurring',{method:'POST',credentials:'same-origin',headers,body:JSON.stringify({operation})});
          }catch(error){
            await updateRow(db,'recurringQueue',operation.operationId,{status:'pending',lastError:'Connection lost during background recurring sync.'}).catch(()=>{});
            throw error;
          }
          const data=await responseData(response);
          if(!response.ok){
            if(response.status===401){
              await updateRow(db,'recurringQueue',operation.operationId,{status:'pending',lastError:'Sign in again to resume recurring sync.'}).catch(()=>{});
              await requestClientSync('background-auth-required');
              return false;
            }
            await updateRow(db,'recurringQueue',operation.operationId,{status:response.status===409?'conflict':'failed',lastError:data.error||'The server rejected this recurring change.'}).catch(()=>{});
            await requestClientSync(response.status===409?'background-conflict':'background-failed');
            return false;
          }
          await deleteRow(db,'recurringQueue',operation.operationId);
          if(data?.rule?.updatedAt&&operation.ruleId){
            const remainingRecurring=await readStore(db,'recurringQueue');
            for(const later of remainingRecurring){
              if(later.identity===identity&&later.ruleId===operation.ruleId&&later.status==='pending'){
                await updateRow(db,'recurringQueue',later.operationId,{baseUpdatedAt:data.rule.updatedAt});
              }
            }
          }
        }
        try{
          const [rulesResponse,remindersResponse]=await Promise.all([
            fetch('/api/recurring',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}}),
            fetch('/api/recurring/reminders',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}})
          ]);
          if(rulesResponse.ok&&remindersResponse.ok){
            const rulesData=await responseData(rulesResponse),reminderData=await responseData(remindersResponse);
            await saveWorkerRecurringSnapshot(db,identity,{rules:rulesData.rules||[],reminders:reminderData.reminders||[],worker:reminderData.worker||{},acknowledgedReminderIds:[]});
          }
        }catch{}
      }

      for(const snapshot of sortedAttachmentQueue((await readStore(db,'attachmentQueue')).filter(row=>row.identity===identity))){
        const operation=await readRow(db,'attachmentQueue',snapshot.operationId);
        if(!operation)continue;
        if(operation.status==='failed'){
          await requestClientSync('background-needs-attention');
          return false;
        }
        if(operation.status!=='pending')continue;
        const all=await readStore(db,'attachmentQueue');
        if(operation.operation==='create'&&all.some(row=>row.identity===identity&&row.attachmentId===operation.attachmentId&&row.operation==='delete')){
          await deleteRow(db,'attachmentQueue',operation.operationId);
          continue;
        }
        await updateRow(db,'attachmentQueue',operation.operationId,{attempts:Number(operation.attempts||0)+1,lastError:''});
        let response;
        try{
          response=await fetch('/api/sync/attachments',{method:'POST',credentials:'same-origin',headers,body:JSON.stringify({operation})});
        }catch(error){
          await updateRow(db,'attachmentQueue',operation.operationId,{status:'pending',lastError:'Connection lost during background attachment sync.'}).catch(()=>{});
          throw error;
        }
        const data=await responseData(response);
        if(!response.ok){
          if(response.status===401){
            await updateRow(db,'attachmentQueue',operation.operationId,{status:'pending',lastError:'Sign in again to resume attachment sync.'}).catch(()=>{});
            await requestClientSync('background-auth-required');
            return false;
          }
          await updateRow(db,'attachmentQueue',operation.operationId,{status:'failed',lastError:data.error||'The server rejected this attachment.'}).catch(()=>{});
          await requestClientSync('background-failed');
          return false;
        }
        if(operation.operation==='create')await updateWorkerAttachment(db,operation.attachmentId,data.attachment||{});
        else await deleteRow(db,'attachments',operation.attachmentId);
        await deleteRow(db,'attachmentQueue',operation.operationId);
      }

      const remaining=[
        ...(await readStore(db,'syncQueue')),
        ...(await readStore(db,'attachmentQueue')),
        ...(db.objectStoreNames.contains('bankFeedQueue')?await readStore(db,'bankFeedQueue'):[]),
        ...(db.objectStoreNames.contains('recurringQueue')?await readStore(db,'recurringQueue'):[])
      ].filter(row=>row.identity===identity&&['pending','failed','conflict'].includes(String(row.status||'pending')));
      if(remaining.length){
        await requestClientSync('background-pending');
        return false;
      }
      await markWorkerSync(db,identity,lastRevision,source);
      await requestClientSync(reopenedFeedItems?'background-sync-reconciled':'background-sync-complete');
      return true;
    }finally{
      db.close();
    }
  })();
  try{return await backgroundSyncInFlight;}finally{backgroundSyncInFlight=null;}
}

self.addEventListener('message',event=>{
  if(event.data?.type==='GET_UPDATE_INFO'){
    const payload={type:'MONEY_TRACKER_UPDATE_INFO',version:self.MONEY_TRACKER_PWA.version,offlineDbVersion:self.MONEY_TRACKER_PWA.offlineDbVersion||null,minMigratableOfflineDbVersion:self.MONEY_TRACKER_PWA.minMigratableOfflineDbVersion||null};
    if(event.ports?.[0])event.ports[0].postMessage(payload);
    else event.source?.postMessage?.(payload);
    return;
  }
  if(event.data?.type==='SKIP_WAITING')self.skipWaiting();
  if(event.data?.type==='RUN_BACKGROUND_SYNC')event.waitUntil(runBackgroundSync('manual-worker'));
});

self.addEventListener('sync',event=>{
  if(event.tag==='money-tracker-sync')event.waitUntil(runBackgroundSync('background-sync'));
});

self.addEventListener('periodicsync',event=>{
  if(event.tag==='money-tracker-periodic-sync')event.waitUntil(runBackgroundSync('periodic-sync'));
});

async function currentCache(){return await caches.open(CACHE);}

async function networkFirst(request){
  const cache=await currentCache();
  try{
    const response=await fetch(request,{cache:'no-store'});
    if(response?.ok)cache.put(request,response.clone()).catch(()=>{});
    return response;
  }catch{
    return await cache.match(request)||await cache.match('/index.html')||Response.error();
  }
}

function fetchAndCache(request){
  return currentCache().then(cache=>fetch(request,{cache:'no-store'}).then(async response=>{
    if(response?.ok)await cache.put(request,response.clone()).catch(()=>{});
    return response;
  }).catch(()=>null));
}

async function staleWhileRevalidate(request,revalidatePromise){
  const cache=await currentCache();
  const cached=await cache.match(request);
  return cached||await revalidatePromise||Response.error();
}

self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(event.request.mode==='navigate'){event.respondWith(networkFirst(event.request));return;}
  const revalidatePromise=fetchAndCache(event.request);
  event.waitUntil(revalidatePromise.then(()=>undefined));
  event.respondWith(staleWhileRevalidate(event.request,revalidatePromise));
});
