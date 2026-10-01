import { historicalFxRates } from './fx.js';

export const OFFLINE_DB = Object.freeze({
  name: 'money-tracker-offline',
  version: 7,
  stores: Object.freeze(['meta','people','accounts','entries','categories','budgets','syncQueue','syncState','tombstones','attachments','attachmentQueue','fxRates','bankFeedState','bankFeedQueue','recurringState','recurringQueue'])
});

const META_STORE='meta';
const LEDGER_STORES=['people','accounts','entries','categories','budgets'];
const SYNC_QUEUE_STORE='syncQueue';
const SYNC_STATE_STORE='syncState';
const TOMBSTONE_STORE='tombstones';
const ATTACHMENT_STORE='attachments';
const ATTACHMENT_QUEUE_STORE='attachmentQueue';
const FX_RATE_STORE='fxRates';
const BANK_FEED_STATE_STORE='bankFeedState';
const BANK_FEED_QUEUE_STORE='bankFeedQueue';
const BANK_FEED_CACHE_KEY='bank-feed';
const RECURRING_STATE_STORE='recurringState';
const RECURRING_QUEUE_STORE='recurringQueue';
const RECURRING_CACHE_KEY='recurring';
const SCHEMA_INFO_KEY='schema-info';
const ACTIVE_USER_KEY='active-user';
const STATE_HEAD_KEY='state-head';
const SYNC_BASE_KEY='sync-base';
const LAST_SYNC_KEY='last-sync';
export const OFFLINE_ACCESS_MAX_AGE_MS=7*24*60*60*1000;
export const OFFLINE_ATTACHMENT_CACHE_LIMIT_BYTES=100*1024*1024;

function supported(){
  return typeof indexedDB!=='undefined';
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

function pendingStatus(value){
  return ['pending','failed','conflict'].includes(String(value||'pending'));
}

let databasePromise=null;

async function finishPostOpenMigrations(db){
  const schema=await requestResult(db.transaction(META_STORE,'readonly').objectStore(META_STORE).get(SCHEMA_INFO_KEY)).catch(()=>null);
  if(!schema||Number(schema.version)!==OFFLINE_DB.version||schema.postOpenComplete)return;
  const tx=db.transaction([META_STORE,'accounts','entries',FX_RATE_STORE],'readwrite');
  const meta=tx.objectStore(META_STORE),activeRequest=meta.get(ACTIVE_USER_KEY),accountsRequest=tx.objectStore('accounts').getAll(),entriesRequest=tx.objectStore('entries').getAll();
  const [active,accounts,entries]=await Promise.all([requestResult(activeRequest),requestResult(accountsRequest),requestResult(entriesRequest)]);
  const fx=tx.objectStore(FX_RATE_STORE);
  fx.clear();
  if(active?.identity)for(const row of historicalFxRates(entries||[],accounts||[]))fx.put({...row,identity:active.identity});
  meta.put({...schema,postOpenComplete:true,fxBackfilledAt:new Date().toISOString(),fxRateCount:active?.identity?historicalFxRates(entries||[],accounts||[]).length:0});
  await transactionDone(tx);
}

export function openOfflineDatabase(){
  if(!supported()) return Promise.resolve(null);
  if(databasePromise) return databasePromise;
  databasePromise=new Promise((resolve,reject)=>{
    const request=indexedDB.open(OFFLINE_DB.name,OFFLINE_DB.version);
    request.onupgradeneeded=event=>{
      const db=request.result,tx=request.transaction,fromVersion=Number(event.oldVersion||0);
      // Versioned, additive migrations only. IndexedDB commits this upgrade transaction atomically:
      // if any migration step fails, the previous database remains intact.
      if(fromVersion<1){
        if(!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE,{keyPath:'key'});
        for(const name of LEDGER_STORES)if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:'id'});
      }
      if(fromVersion<2){
        if(!db.objectStoreNames.contains(SYNC_QUEUE_STORE))db.createObjectStore(SYNC_QUEUE_STORE,{keyPath:'operationId'});
        if(!db.objectStoreNames.contains(SYNC_STATE_STORE))db.createObjectStore(SYNC_STATE_STORE,{keyPath:'key'});
        if(!db.objectStoreNames.contains(TOMBSTONE_STORE))db.createObjectStore(TOMBSTONE_STORE,{keyPath:'key'});
      }
      if(fromVersion<3){
        if(!db.objectStoreNames.contains(ATTACHMENT_STORE))db.createObjectStore(ATTACHMENT_STORE,{keyPath:'id'});
        if(!db.objectStoreNames.contains(ATTACHMENT_QUEUE_STORE))db.createObjectStore(ATTACHMENT_QUEUE_STORE,{keyPath:'operationId'});
      }
      if(fromVersion<4){
        if(!db.objectStoreNames.contains(FX_RATE_STORE))db.createObjectStore(FX_RATE_STORE,{keyPath:'entryId'});
      }
      if(fromVersion<5){
        if(!db.objectStoreNames.contains(BANK_FEED_STATE_STORE))db.createObjectStore(BANK_FEED_STATE_STORE,{keyPath:'key'});
        if(!db.objectStoreNames.contains(BANK_FEED_QUEUE_STORE))db.createObjectStore(BANK_FEED_QUEUE_STORE,{keyPath:'operationId'});
      }
      if(fromVersion<6){
        if(!db.objectStoreNames.contains(RECURRING_STATE_STORE))db.createObjectStore(RECURRING_STATE_STORE,{keyPath:'key'});
        if(!db.objectStoreNames.contains(RECURRING_QUEUE_STORE))db.createObjectStore(RECURRING_QUEUE_STORE,{keyPath:'operationId'});
      }
      if(fromVersion<7&&db.objectStoreNames.contains(ATTACHMENT_STORE)){
        const attachmentStore=tx.objectStore(ATTACHMENT_STORE),cursorRequest=attachmentStore.openCursor();
        cursorRequest.onsuccess=event=>{
          const cursor=event.target.result;if(!cursor)return;
          const row=cursor.value||{},hasData=Boolean(row.data);
          cursor.update({
            ...row,
            offlinePinned:Boolean(row.offlinePinned||(hasData&&row.synced===false)),
            offlinePolicy:row.offlinePolicy||(hasData?(row.synced===false?'local':'legacy'):'metadata'),
            cachedAt:row.cachedAt||(hasData?(row.createdAt||new Date().toISOString()):null),
            lastAccessedAt:row.lastAccessedAt||(hasData?(row.createdAt||new Date().toISOString()):null)
          });
          cursor.continue();
        };
      }
      // Defensive repair for databases created by pre-versioned builds without deleting any records.
      if(!db.objectStoreNames.contains(META_STORE))db.createObjectStore(META_STORE,{keyPath:'key'});
      for(const name of LEDGER_STORES)if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:'id'});
      if(!db.objectStoreNames.contains(SYNC_QUEUE_STORE))db.createObjectStore(SYNC_QUEUE_STORE,{keyPath:'operationId'});
      if(!db.objectStoreNames.contains(SYNC_STATE_STORE))db.createObjectStore(SYNC_STATE_STORE,{keyPath:'key'});
      if(!db.objectStoreNames.contains(TOMBSTONE_STORE))db.createObjectStore(TOMBSTONE_STORE,{keyPath:'key'});
      if(!db.objectStoreNames.contains(ATTACHMENT_STORE))db.createObjectStore(ATTACHMENT_STORE,{keyPath:'id'});
      if(!db.objectStoreNames.contains(ATTACHMENT_QUEUE_STORE))db.createObjectStore(ATTACHMENT_QUEUE_STORE,{keyPath:'operationId'});
      if(!db.objectStoreNames.contains(FX_RATE_STORE))db.createObjectStore(FX_RATE_STORE,{keyPath:'entryId'});
      if(!db.objectStoreNames.contains(BANK_FEED_STATE_STORE))db.createObjectStore(BANK_FEED_STATE_STORE,{keyPath:'key'});
      if(!db.objectStoreNames.contains(BANK_FEED_QUEUE_STORE))db.createObjectStore(BANK_FEED_QUEUE_STORE,{keyPath:'operationId'});
      if(!db.objectStoreNames.contains(RECURRING_STATE_STORE))db.createObjectStore(RECURRING_STATE_STORE,{keyPath:'key'});
      if(!db.objectStoreNames.contains(RECURRING_QUEUE_STORE))db.createObjectStore(RECURRING_QUEUE_STORE,{keyPath:'operationId'});
      tx.objectStore(META_STORE).put({key:SCHEMA_INFO_KEY,version:OFFLINE_DB.version,fromVersion,migratedAt:new Date().toISOString(),strategy:'additive-atomic'});
    };
    request.onsuccess=async()=>{
      const db=request.result;
      db.onversionchange=()=>{db.close();databasePromise=null;};
      try{
        await finishPostOpenMigrations(db);
        resolve(db);
      }catch(error){
        db.close();databasePromise=null;reject(error);
      }
    };
    request.onerror=()=>{databasePromise=null;reject(request.error||new Error('Could not open offline database.'));};
    request.onblocked=()=>{databasePromise=null;reject(new Error('Offline database upgrade is blocked by another Money Tracker tab.'));};
  });
  return databasePromise;
}

function userIdentity(user){
  return String(user?.id||user?.email||'').trim();
}

function cloneValue(value){
  if(value===undefined) return undefined;
  if(typeof structuredClone==='function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function splitState(state){
  const people=Array.isArray(state?.people)?state.people:[];
  const accounts=Array.isArray(state?.accounts)?state.accounts:[];
  const entries=Array.isArray(state?.entries)?state.entries:[];
  const categories=Array.isArray(state?.categories)?state.categories:[];
  const budgets=Array.isArray(state?.budgets)?state.budgets:[];
  const head={...state};
  delete head.people;delete head.accounts;delete head.entries;delete head.categories;delete head.budgets;
  return {head,people,accounts,entries,categories,budgets};
}

export function isLedgerState(value){
  return Boolean(value&&typeof value==='object'&&Number.isFinite(Number(value.version))&&value.settings&&Array.isArray(value.people)&&Array.isArray(value.accounts)&&Array.isArray(value.entries));
}

async function queuedRows(db){
  return await requestResult(db.transaction(SYNC_QUEUE_STORE,'readonly').objectStore(SYNC_QUEUE_STORE).getAll());
}
async function attachmentQueuedRows(db){
  return await requestResult(db.transaction(ATTACHMENT_QUEUE_STORE,'readonly').objectStore(ATTACHMENT_QUEUE_STORE).getAll());
}
async function bankFeedQueuedRows(db){
  return await requestResult(db.transaction(BANK_FEED_QUEUE_STORE,'readonly').objectStore(BANK_FEED_QUEUE_STORE).getAll());
}
async function recurringQueuedRows(db){
  return await requestResult(db.transaction(RECURRING_QUEUE_STORE,'readonly').objectStore(RECURRING_QUEUE_STORE).getAll());
}

export async function pendingOperationCount(expectedIdentity=''){
  const db=await openOfflineDatabase();
  if(!db) return 0;
  const identity=String(expectedIdentity||'').trim();
  const [rows,attachmentRows,bankFeedRows,recurringRows]=await Promise.all([queuedRows(db),attachmentQueuedRows(db),bankFeedQueuedRows(db),recurringQueuedRows(db)]);
  return [...rows,...attachmentRows,...bankFeedRows,...recurringRows].filter(row=>(!identity||row.identity===identity)&&pendingStatus(row.status)).length;
}

export async function saveAuthorizedUser(user){
  const identity=userIdentity(user);
  if(!identity) return false;
  const db=await openOfflineDatabase();
  if(!db) return false;

  return await new Promise((resolve,reject)=>{
    const tx=db.transaction(OFFLINE_DB.stores,'readwrite');
    const meta=tx.objectStore(META_STORE);
    const currentRequest=meta.get(ACTIVE_USER_KEY);
    let blockedError=null;

    currentRequest.onerror=()=>reject(currentRequest.error||new Error('Could not read the active offline user.'));
    currentRequest.onsuccess=()=>{
      const current=currentRequest.result;
      if(current?.identity&&current.identity!==identity){
        const queueRequest=tx.objectStore(SYNC_QUEUE_STORE).getAll();
        const attachmentQueueRequest=tx.objectStore(ATTACHMENT_QUEUE_STORE).getAll();
        const bankFeedQueueRequest=tx.objectStore(BANK_FEED_QUEUE_STORE).getAll();
        const recurringQueueRequest=tx.objectStore(RECURRING_QUEUE_STORE).getAll();
        const inspect=()=>{
          if(queueRequest.readyState!=='done'||attachmentQueueRequest.readyState!=='done'||bankFeedQueueRequest.readyState!=='done'||recurringQueueRequest.readyState!=='done')return;
          const pending=[...(queueRequest.result||[]),...(attachmentQueueRequest.result||[]),...(bankFeedQueueRequest.result||[]),...(recurringQueueRequest.result||[])].filter(row=>row.identity===current.identity&&pendingStatus(row.status));
          if(pending.length){
            blockedError=Object.assign(new Error('This device has unsynced changes for another account. Sign back into that account and sync them before switching users.'),{code:'OFFLINE_PENDING_USER_SWITCH'});
            tx.abort();
            return;
          }
          for(const name of OFFLINE_DB.stores) tx.objectStore(name).clear();
          meta.put({key:SCHEMA_INFO_KEY,version:OFFLINE_DB.version,fromVersion:OFFLINE_DB.version,migratedAt:new Date().toISOString(),strategy:'retained-after-user-clear',postOpenComplete:true});
          meta.put({key:ACTIVE_USER_KEY,identity,user:cloneValue(user),savedAt:new Date().toISOString(),verifiedAt:new Date().toISOString(),schemaVersion:OFFLINE_DB.version});
        };
        queueRequest.onerror=()=>reject(queueRequest.error||new Error('Could not inspect pending offline changes.'));
        attachmentQueueRequest.onerror=()=>reject(attachmentQueueRequest.error||new Error('Could not inspect pending offline attachments.'));
        bankFeedQueueRequest.onerror=()=>reject(bankFeedQueueRequest.error||new Error('Could not inspect pending Bank Feed changes.'));
        recurringQueueRequest.onerror=()=>reject(recurringQueueRequest.error||new Error('Could not inspect pending recurring changes.'));
        queueRequest.onsuccess=inspect;
        attachmentQueueRequest.onsuccess=inspect;
        bankFeedQueueRequest.onsuccess=inspect;
        recurringQueueRequest.onsuccess=inspect;
        return;
      }
      meta.put({key:ACTIVE_USER_KEY,identity,user:cloneValue(user),savedAt:new Date().toISOString(),verifiedAt:new Date().toISOString(),schemaVersion:OFFLINE_DB.version});
    };
    tx.oncomplete=()=>resolve(true);
    tx.onerror=()=>reject(tx.error||new Error('Could not save the active offline user.'));
    tx.onabort=()=>blockedError?reject(blockedError):reject(tx.error||new Error('Saving the active offline user was aborted.'));
  });
}

export async function loadAuthorizedUser(){
  const db=await openOfflineDatabase();
  if(!db) return null;
  const record=await requestResult(db.transaction(META_STORE,'readonly').objectStore(META_STORE).get(ACTIVE_USER_KEY));
  return record?.user?cloneValue(record.user):null;
}

export async function offlineAccessInfo(maxAgeMs=OFFLINE_ACCESS_MAX_AGE_MS){
  const db=await openOfflineDatabase();
  if(!db)return {available:false,valid:false,identity:'',verifiedAt:null,expiresAt:null,remainingMs:0,maxAgeMs};
  const record=await requestResult(db.transaction(META_STORE,'readonly').objectStore(META_STORE).get(ACTIVE_USER_KEY));
  const identity=String(record?.identity||''),verifiedAt=record?.verifiedAt||record?.savedAt||null;
  const verifiedMs=verifiedAt?Date.parse(verifiedAt):NaN,ageMs=Number.isFinite(verifiedMs)?Math.max(0,Date.now()-verifiedMs):Infinity;
  const valid=Boolean(identity&&record?.user&&Number.isFinite(ageMs)&&ageMs<=maxAgeMs);
  const expiresAt=Number.isFinite(verifiedMs)?new Date(verifiedMs+maxAgeMs).toISOString():null;
  return {available:Boolean(identity&&record?.user),valid,identity,verifiedAt,expiresAt,remainingMs:valid?Math.max(0,maxAgeMs-ageMs):0,maxAgeMs};
}

export async function saveStateSnapshot(state,expectedIdentity=''){
  if(!isLedgerState(state)) return false;
  const identity=String(expectedIdentity||'').trim();
  if(!identity) return false;
  const db=await openOfflineDatabase();
  if(!db) return false;
  const clean=splitState(cloneValue(state));

  return await new Promise((resolve,reject)=>{
    const tx=db.transaction([META_STORE,...LEDGER_STORES,TOMBSTONE_STORE,FX_RATE_STORE],'readwrite');
    const meta=tx.objectStore(META_STORE);
    const activeRequest=meta.get(ACTIVE_USER_KEY);
    let identityMismatch=false;

    activeRequest.onerror=()=>reject(activeRequest.error||new Error('Could not verify the active offline user.'));
    activeRequest.onsuccess=()=>{
      if(activeRequest.result?.identity!==identity){
        identityMismatch=true;
        tx.abort();
        return;
      }
      for(const name of LEDGER_STORES) tx.objectStore(name).clear();
      tx.objectStore(TOMBSTONE_STORE).clear();
      tx.objectStore(FX_RATE_STORE).clear();
      for(const row of historicalFxRates(clean.entries,clean.accounts))tx.objectStore(FX_RATE_STORE).put({...row,identity});
      for(const row of clean.people) if(row?.id) tx.objectStore('people').put(row);
      for(const row of clean.accounts) if(row?.id) tx.objectStore('accounts').put(row);
      for(const row of clean.entries) if(row?.id) tx.objectStore('entries').put(row);
      for(const row of clean.categories) if(row?.id) tx.objectStore('categories').put(row);
      for(const row of clean.budgets) if(row?.id) tx.objectStore('budgets').put(row);
      meta.put({
        key:STATE_HEAD_KEY,
        identity,
        head:clean.head,
        savedAt:new Date().toISOString(),
        schemaVersion:OFFLINE_DB.version
      });
    };
    tx.oncomplete=()=>resolve(true);
    tx.onerror=()=>reject(tx.error||new Error('Could not save the offline ledger snapshot.'));
    tx.onabort=()=>identityMismatch?resolve(false):reject(tx.error||new Error('Saving the offline ledger snapshot was aborted.'));
  });
}

export async function offlineSchemaInfo(){
  const db=await openOfflineDatabase();
  if(!db)return {available:false,version:0,targetVersion:OFFLINE_DB.version,stores:[]};
  const record=await requestResult(db.transaction(META_STORE,'readonly').objectStore(META_STORE).get(SCHEMA_INFO_KEY));
  return {available:true,version:db.version,targetVersion:OFFLINE_DB.version,stores:Array.from(db.objectStoreNames),migration:record?cloneValue(record):null};
}

export async function offlineFxRates(expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  const db=await openOfflineDatabase();
  if(!db)return [];
  const rows=await requestResult(db.transaction(FX_RATE_STORE,'readonly').objectStore(FX_RATE_STORE).getAll());
  return rows.filter(row=>!identity||row.identity===identity).sort((a,b)=>String(a.date).localeCompare(String(b.date))||String(a.entryId).localeCompare(String(b.entryId))).map(cloneValue);
}

async function rebuildFxRateCache(expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  if(!identity)return false;
  const state=await loadStateSnapshot();
  if(!state)return false;
  const db=await openOfflineDatabase();
  if(!db)return false;
  const tx=db.transaction([META_STORE,FX_RATE_STORE],'readwrite'),meta=tx.objectStore(META_STORE);
  const active=await requestResult(meta.get(ACTIVE_USER_KEY));
  if(active?.identity!==identity){tx.abort();return false;}
  const store=tx.objectStore(FX_RATE_STORE);
  store.clear();
  for(const row of historicalFxRates(state.entries,state.accounts))store.put({...row,identity});
  await transactionDone(tx);
  return true;
}

export async function loadStateSnapshot(){
  const db=await openOfflineDatabase();
  if(!db) return null;
  const tx=db.transaction([META_STORE,...LEDGER_STORES],'readonly');
  const done=transactionDone(tx);
  const meta=tx.objectStore(META_STORE);
  const userRequest=meta.get(ACTIVE_USER_KEY);
  const headRequest=meta.get(STATE_HEAD_KEY);
  const peopleRequest=tx.objectStore('people').getAll();
  const accountsRequest=tx.objectStore('accounts').getAll();
  const entriesRequest=tx.objectStore('entries').getAll();
  const categoriesRequest=tx.objectStore('categories').getAll();
  const budgetsRequest=tx.objectStore('budgets').getAll();
  const [userRecord,head,people,accounts,entries,categories,budgets]=await Promise.all([
    requestResult(userRequest),requestResult(headRequest),requestResult(peopleRequest),requestResult(accountsRequest),requestResult(entriesRequest),requestResult(categoriesRequest),requestResult(budgetsRequest)
  ]);
  await done;
  if(!userRecord?.identity||!head?.head||head.identity!==userRecord.identity) return null;
  return cloneValue({...head.head,people,accounts,entries,categories,budgets});
}

export async function enqueueLocalMutation(spec,expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  if(!identity) throw new Error('Sign in before saving offline changes.');
  const db=await openOfflineDatabase();
  if(!db) throw new Error('Offline storage is unavailable in this browser.');
  const operationId=String(spec?.operationId||('op_'+crypto.randomUUID()));
  const entity=String(spec?.entity||'');
  const operation=String(spec?.operation||'');
  const entityId=String(spec?.entityId||spec?.localRecord?.id||'');
  if(!['settings','person','account','entry'].includes(entity)||!['create','update','delete'].includes(operation)||(entity==='settings'&&operation!=='update')) throw new Error('Unsupported offline mutation.');

  await new Promise((resolve,reject)=>{
    const tx=db.transaction([META_STORE,...LEDGER_STORES,SYNC_QUEUE_STORE,SYNC_STATE_STORE,TOMBSTONE_STORE],'readwrite');
    const meta=tx.objectStore(META_STORE);
    const activeRequest=meta.get(ACTIVE_USER_KEY);
    const headRequest=meta.get(STATE_HEAD_KEY);
    const recordStore=entity==='person'?'people':entity==='account'?'accounts':entity==='entry'?'entries':'';
    const recordRequest=recordStore?tx.objectStore(recordStore).get(entityId):null;
    let failure=null;

    const maybeApply=()=>{
      if(activeRequest.readyState!=='done'||headRequest.readyState!=='done'||(recordRequest&&recordRequest.readyState!=='done')) return;
      const active=activeRequest.result,head=headRequest.result;
      if(active?.identity!==identity||head?.identity!==identity||!head?.head){
        failure=new Error('The offline ledger is not ready for this account. Reconnect once and try again.');
        tx.abort();
        return;
      }
      const baseRevision=Number(head.head.version);
      if(!Number.isInteger(baseRevision)){
        failure=new Error('Offline ledger revision is invalid.');
        tx.abort();
        return;
      }
      if(Number.isInteger(Number(spec?.expectedRevision))&&Number(spec.expectedRevision)!==baseRevision){
        failure=Object.assign(new Error('This offline ledger changed in another tab. Reload and try again.'),{status:409});
        tx.abort();
        return;
      }
      const stamp=new Date().toISOString();
      const baseRecord=entity==='settings'?cloneValue(head.head.settings||{}):cloneValue(recordRequest?.result??null);
      if(entity==='settings'){
        head.head.settings={...(head.head.settings||{}),...(cloneValue(spec.localRecord||spec.payload)||{})};
      }else{
        const storeName=entity==='person'?'people':entity==='account'?'accounts':'entries';
        if(operation==='delete'){
          tx.objectStore(storeName).delete(entityId);
          tx.objectStore(TOMBSTONE_STORE).put({key:entity+':'+entityId,identity,entity,entityId,deletedAt:stamp,baseRevision,operationId});
        }else if(spec.localRecord?.id){
          tx.objectStore(storeName).put(cloneValue(spec.localRecord));
          tx.objectStore(TOMBSTONE_STORE).delete(entity+':'+entityId);
        }
      }
      for(const effect of Array.isArray(spec?.extraLedgerRecords)?spec.extraLedgerRecords:[]){
        if(LEDGER_STORES.includes(effect?.store)&&effect?.record?.id) tx.objectStore(effect.store).put(cloneValue(effect.record));
      }
      head.head.version=baseRevision+1;
      meta.put({...head,savedAt:stamp,schemaVersion:OFFLINE_DB.version});
      tx.objectStore(SYNC_QUEUE_STORE).put({
        operationId,identity,entity,entityId,operation,
        payload:cloneValue(spec.payload)||{},
        localRecord:cloneValue(spec.localRecord)||null,
        extraLedgerRecords:cloneValue(spec.extraLedgerRecords)||[],
        baseRecord,
        baseRevision,
        createdAt:stamp,
        attempts:0,
        status:'pending',
        lastError:''
      });
      const syncStore=tx.objectStore(SYNC_STATE_STORE);
      const baseRequest=syncStore.get(SYNC_BASE_KEY);
      baseRequest.onsuccess=()=>{
        if(!baseRequest.result||baseRequest.result.identity!==identity){
          syncStore.put({key:SYNC_BASE_KEY,identity,serverRevision:baseRevision,updatedAt:stamp});
        }
      };
    };
    activeRequest.onerror=()=>reject(activeRequest.error||new Error('Could not verify offline user.'));
    headRequest.onerror=()=>reject(headRequest.error||new Error('Could not read offline ledger head.'));
    if(recordRequest)recordRequest.onerror=()=>reject(recordRequest.error||new Error('Could not read the offline ledger record.'));
    activeRequest.onsuccess=maybeApply;
    headRequest.onsuccess=maybeApply;
    if(recordRequest)recordRequest.onsuccess=maybeApply;
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error||new Error('Could not save offline change.'));
    tx.onabort=()=>reject(failure||tx.error||new Error('Saving the offline change was aborted.'));
  });

  let state=null;
  try{state=await loadStateSnapshot();}catch{}
  if(entity==='entry')await rebuildFxRateCache(identity).catch(()=>{});
  return {operationId,state,committed:true};
}

export async function listQueuedOperations(expectedIdentity=''){
  const db=await openOfflineDatabase();
  if(!db) return [];
  const identity=String(expectedIdentity||'').trim();
  const rows=await queuedRows(db);
  return rows.filter(row=>!identity||row.identity===identity).sort((a,b)=>Number(a.baseRevision)-Number(b.baseRevision)||String(a.createdAt).localeCompare(String(b.createdAt))||String(a.operationId).localeCompare(String(b.operationId))).map(cloneValue);
}


function ledgerRecord(state,entity,entityId){
  if(entity==='settings')return cloneValue(state?.settings||{});
  const listName=entity==='person'?'people':entity==='account'?'accounts':entity==='entry'?'entries':'';
  if(!listName)return null;
  return cloneValue((Array.isArray(state?.[listName])?state[listName]:[]).find(row=>row?.id===entityId)||null);
}

function canonicalQueuedBase(value){
  if(Array.isArray(value))return value.map(canonicalQueuedBase);
  if(!value||typeof value!=='object')return value;
  const out={};
  for(const key of Object.keys(value).sort()){
    if(key==='attachmentCount'||key==='attachments'||key==='updatedAt')continue;
    out[key]=canonicalQueuedBase(value[key]);
  }
  return out;
}
function sameQueuedBase(a,b){
  return JSON.stringify(canonicalQueuedBase(a))===JSON.stringify(canonicalQueuedBase(b));
}

function projectQueuedMutation(state,row){
  const next=cloneValue(state);
  if(row.entity==='settings'){
    next.settings={...(next.settings||{}),...(cloneValue(row.localRecord||row.payload)||{})};
  }else{
    const listName=row.entity==='person'?'people':row.entity==='account'?'accounts':row.entity==='entry'?'entries':'';
    if(listName){
      const rows=Array.isArray(next[listName])?next[listName]:[];
      if(row.operation==='delete')next[listName]=rows.filter(item=>item.id!==row.entityId);
      else{
        const record=cloneValue(row.localRecord||row.payload);
        if(record?.id){
          const at=rows.findIndex(item=>item.id===record.id);
          if(at>=0){const copy=rows.slice();copy[at]=record;next[listName]=copy;}
          else next[listName]=[...rows,record];
        }
      }
    }
  }
  for(const effect of Array.isArray(row.extraLedgerRecords)?row.extraLedgerRecords:[]){
    if(!LEDGER_STORES.includes(effect?.store)||!effect?.record?.id)continue;
    const rows=Array.isArray(next[effect.store])?next[effect.store]:[];
    const record=cloneValue(effect.record),at=rows.findIndex(item=>item.id===record.id);
    if(at>=0){const copy=rows.slice();copy[at]=record;next[effect.store]=copy;}
    else next[effect.store]=[...rows,record];
  }
  return next;
}

export function queuedBaseRecord(state,entity,entityId){
  return ledgerRecord(state,entity,entityId);
}

export async function rebaseQueuedOperations(serverState,expectedIdentity='',resolution={}){
  if(!isLedgerState(serverState))throw new Error('A valid server ledger is required to rebase queued changes.');
  const identity=String(expectedIdentity||'').trim();
  if(!identity)throw new Error('Sign in before resolving sync conflicts.');
  const db=await openOfflineDatabase();
  if(!db)throw new Error('Offline storage is unavailable in this browser.');

  const rows=(await listQueuedOperations(identity)).filter(row=>pendingStatus(row.status));
  const targetId=String(resolution?.operationId||'');
  const strategy=String(resolution?.strategy||'');
  const target=targetId?rows.find(row=>row.operationId===targetId):null;
  if(targetId&&!target)throw new Error('That queued change no longer exists.');
  if(strategy&&!['keep_mine','keep_server'].includes(strategy))throw new Error('Choose how to resolve the conflict.');

  const dropped=new Set();
  if(target&&strategy==='keep_server'){
    let afterTarget=false;
    for(const row of rows){
      if(row.operationId===target.operationId)afterTarget=true;
      if(afterTarget&&row.entity===target.entity&&row.entityId===target.entityId)dropped.add(row.operationId);
    }
  }

  let projected=cloneValue(serverState);
  let revision=Number(serverState.version);
  const rebased=[];
  const automatic=!targetId&&!strategy;
  for(const original of rows){
    if(dropped.has(original.operationId))continue;
    const row=cloneValue(original);
    const projectedBase=ledgerRecord(projected,row.entity,row.entityId);

    // A remote delete makes a queued delete redundant. Drop it without consuming another revision.
    if(automatic&&row.operation==='delete'&&projectedBase==null){
      dropped.add(row.operationId);
      continue;
    }

    row.baseRevision=revision;
    if(automatic&&row.status!=='failed'&&!sameQueuedBase(original.baseRecord??null,projectedBase??null)){
      row.status='conflict';
      row.lastError='This item changed on another device while you were offline.';
      row.conflict={
        serverRevision:Number(serverState.version),
        baseRecord:cloneValue(original.baseRecord??null),
        localRecord:cloneValue(original.localRecord??original.payload??null),
        serverRecord:cloneValue(projectedBase??null),
        detectedAt:new Date().toISOString()
      };
      // Keep the original baseRecord as evidence for conflict resolution.
    }else{
      row.baseRecord=projectedBase;
      if(row.operationId===targetId&&strategy==='keep_mine'){
        row.status='pending';row.lastError='';delete row.conflict;
      }else if(row.status==='conflict'&&row.operationId!==targetId){
        // Preserve unrelated explicit conflicts. They still block until the user resolves them.
      }else if(row.status!=='failed'){
        row.status='pending';row.lastError='';delete row.conflict;
      }
    }
    projected=projectQueuedMutation(projected,row);
    revision+=1;
    projected.version=revision;
    rebased.push(row);
  }

  const split=splitState(projected);
  await new Promise((resolve,reject)=>{
    const tx=db.transaction([META_STORE,...LEDGER_STORES,SYNC_QUEUE_STORE,SYNC_STATE_STORE,TOMBSTONE_STORE],'readwrite');
    const activeRequest=tx.objectStore(META_STORE).get(ACTIVE_USER_KEY);
    let mismatch=false;
    activeRequest.onerror=()=>reject(activeRequest.error||new Error('Could not verify the active offline user.'));
    activeRequest.onsuccess=()=>{
      if(activeRequest.result?.identity!==identity){mismatch=true;tx.abort();return;}
      for(const name of LEDGER_STORES)tx.objectStore(name).clear();
      for(const row of split.people)if(row?.id)tx.objectStore('people').put(row);
      for(const row of split.accounts)if(row?.id)tx.objectStore('accounts').put(row);
      for(const row of split.entries)if(row?.id)tx.objectStore('entries').put(row);
      for(const row of split.categories)if(row?.id)tx.objectStore('categories').put(row);
      for(const row of split.budgets)if(row?.id)tx.objectStore('budgets').put(row);
      tx.objectStore(META_STORE).put({key:STATE_HEAD_KEY,identity,head:split.head,savedAt:new Date().toISOString(),schemaVersion:OFFLINE_DB.version});

      const queue=tx.objectStore(SYNC_QUEUE_STORE);
      const allRequest=queue.getAll();
      allRequest.onsuccess=()=>{
        for(const row of allRequest.result||[])if(row.identity===identity)queue.delete(row.operationId);
        for(const row of rebased)queue.put(row);
      };

      const tombstones=tx.objectStore(TOMBSTONE_STORE);
      tombstones.clear();
      for(const row of rebased){
        if(row.operation==='delete'){
          tombstones.put({
            key:row.entity+':'+row.entityId,
            identity,
            entity:row.entity,
            entityId:row.entityId,
            deletedAt:row.createdAt||new Date().toISOString(),
            baseRevision:row.baseRevision,
            operationId:row.operationId
          });
        }
      }
      tx.objectStore(SYNC_STATE_STORE).put({key:SYNC_BASE_KEY,identity,serverRevision:Number(serverState.version),updatedAt:new Date().toISOString()});
    };
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error||new Error('Could not rebase queued changes.'));
    tx.onabort=()=>mismatch?reject(new Error('Offline identity changed while resolving the conflict.')):reject(tx.error||new Error('Rebasing queued changes was aborted.'));
  });

  await rebuildFxRateCache(identity).catch(()=>{});
  return {state:await loadStateSnapshot(),queue:await listQueuedOperations(identity),dropped:[...dropped]};
}

export async function cacheAttachmentList(entryId,attachments,expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  const db=await openOfflineDatabase();
  if(!db||!identity)return false;
  const tx=db.transaction([META_STORE,ATTACHMENT_STORE],'readwrite');
  const active=await requestResult(tx.objectStore(META_STORE).get(ACTIVE_USER_KEY));
  if(active?.identity!==identity){tx.abort();return false;}
  const store=tx.objectStore(ATTACHMENT_STORE);
  const existing=await requestResult(store.getAll());
  const byId=new Map(existing.map(row=>[row.id,row]));
  const serverIds=new Set((Array.isArray(attachments)?attachments:[]).filter(item=>item?.id&&item.entryId===entryId).map(item=>item.id));
  for(const row of existing){
    if(row.identity===identity&&row.entryId===entryId&&row.synced===true&&row.status==='synced'&&!serverIds.has(row.id))store.delete(row.id);
  }
  for(const item of Array.isArray(attachments)?attachments:[]){
    if(!item?.id||item.entryId!==entryId)continue;
    const previous=byId.get(item.id)||{};
    store.put({...previous,...cloneValue(item),identity,synced:true,status:'synced'});
  }
  await transactionDone(tx);
  return true;
}

export async function listOfflineAttachments(entryId,expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  const db=await openOfflineDatabase();
  if(!db)return [];
  const rows=await requestResult(db.transaction(ATTACHMENT_STORE,'readonly').objectStore(ATTACHMENT_STORE).getAll());
  return rows.filter(row=>(!identity||row.identity===identity)&&row.entryId===entryId&&row.status!=='deleted').map(cloneValue);
}

export async function getOfflineAttachment(id,expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  const db=await openOfflineDatabase();
  if(!db)return null;
  const row=await requestResult(db.transaction(ATTACHMENT_STORE,'readonly').objectStore(ATTACHMENT_STORE).get(id));
  if(!row||identity&&row.identity!==identity||row.status==='deleted')return null;
  return cloneValue(row);
}

export async function queueOfflineAttachmentCreate(record,expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  if(!identity)throw new Error('Sign in before saving offline attachments.');
  const db=await openOfflineDatabase();
  if(!db)throw new Error('Offline storage is unavailable in this browser.');
  const operationId=String(record?.operationId||('op_'+crypto.randomUUID()));
  const attachment=cloneValue(record);
  const stamp=new Date().toISOString();

  await new Promise((resolve,reject)=>{
    const tx=db.transaction([META_STORE,'entries',ATTACHMENT_STORE,ATTACHMENT_QUEUE_STORE],'readwrite');
    const activeRequest=tx.objectStore(META_STORE).get(ACTIVE_USER_KEY);
    const entryRequest=tx.objectStore('entries').get(attachment.entryId);
    let failure=null;
    const apply=()=>{
      if(activeRequest.readyState!=='done'||entryRequest.readyState!=='done')return;
      if(activeRequest.result?.identity!==identity){failure=new Error('Offline identity changed while saving the attachment.');tx.abort();return;}
      const entry=entryRequest.result;
      if(!entry){failure=new Error('Transaction not found.');tx.abort();return;}
      const stored={
        id:attachment.id,
        entryId:attachment.entryId,
        name:String(attachment.name||'attachment'),
        mimeType:String(attachment.mimeType||'application/octet-stream'),
        sizeBytes:Number(attachment.sizeBytes)||0,
        data:String(attachment.data||''),
        createdAt:attachment.createdAt||stamp,
        identity,
        synced:false,
        status:'pending',
        offlinePinned:true,
        offlinePolicy:'local',
        cachedAt:stamp,
        lastAccessedAt:stamp
      };
      tx.objectStore(ATTACHMENT_STORE).put(stored);
      tx.objectStore(ATTACHMENT_QUEUE_STORE).put({
        operationId,identity,operation:'create',attachmentId:stored.id,entryId:stored.entryId,
        payload:cloneValue(stored),createdAt:stamp,attempts:0,status:'pending',lastError:''
      });
      tx.objectStore('entries').put({...entry,attachmentCount:Number(entry.attachmentCount||0)+1});
    };
    activeRequest.onerror=()=>reject(activeRequest.error||new Error('Could not verify offline user.'));
    entryRequest.onerror=()=>reject(entryRequest.error||new Error('Could not read transaction for attachment.'));
    activeRequest.onsuccess=apply;entryRequest.onsuccess=apply;
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error||new Error('Could not save attachment offline.'));
    tx.onabort=()=>reject(failure||tx.error||new Error('Saving attachment offline was aborted.'));
  });
  return {operationId,attachment:await getOfflineAttachment(attachment.id,identity)};
}

export async function queueOfflineAttachmentDelete(id,expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  if(!identity)throw new Error('Sign in before removing attachments.');
  const db=await openOfflineDatabase();
  if(!db)throw new Error('Offline storage is unavailable in this browser.');
  const operationId='op_'+crypto.randomUUID();
  let cancelledCreate=false;

  await new Promise((resolve,reject)=>{
    const tx=db.transaction([META_STORE,'entries',ATTACHMENT_STORE,ATTACHMENT_QUEUE_STORE],'readwrite');
    const activeRequest=tx.objectStore(META_STORE).get(ACTIVE_USER_KEY);
    const attachmentRequest=tx.objectStore(ATTACHMENT_STORE).get(id);
    const queueRequest=tx.objectStore(ATTACHMENT_QUEUE_STORE).getAll();
    let failure=null;
    const apply=()=>{
      if(activeRequest.readyState!=='done'||attachmentRequest.readyState!=='done'||queueRequest.readyState!=='done')return;
      if(activeRequest.result?.identity!==identity){failure=new Error('Offline identity changed while removing the attachment.');tx.abort();return;}
      const attachment=attachmentRequest.result;
      if(!attachment||attachment.identity!==identity){failure=new Error('Attachment not found.');tx.abort();return;}
      const entryStore=tx.objectStore('entries');
      const entryRequest=entryStore.get(attachment.entryId);
      entryRequest.onsuccess=()=>{
        if(entryRequest.result)entryStore.put({...entryRequest.result,attachmentCount:Math.max(0,Number(entryRequest.result.attachmentCount||0)-1)});
      };
      const queueStore=tx.objectStore(ATTACHMENT_QUEUE_STORE);
      const pendingCreates=(queueRequest.result||[]).filter(row=>row.identity===identity&&row.attachmentId===id&&row.operation==='create');
      if(pendingCreates.length){
        // The create may already have committed remotely even if its response was lost.
        // Collapse every stale/duplicate create for this attachment into one idempotent delete.
        cancelledCreate=true;
        for(const pendingCreate of pendingCreates)queueStore.delete(pendingCreate.operationId);
        tx.objectStore(ATTACHMENT_STORE).delete(id);
        queueStore.put({
          operationId,identity,operation:'delete',attachmentId:id,entryId:attachment.entryId,
          payload:{id},createdAt:new Date().toISOString(),attempts:0,status:'pending',lastError:''
        });
        return;
      }
      tx.objectStore(ATTACHMENT_STORE).put({...attachment,status:'deleted'});
      queueStore.put({
        operationId,identity,operation:'delete',attachmentId:id,entryId:attachment.entryId,
        payload:{id},createdAt:new Date().toISOString(),attempts:0,status:'pending',lastError:''
      });
    };
    activeRequest.onerror=()=>reject(activeRequest.error||new Error('Could not verify offline user.'));
    attachmentRequest.onerror=()=>reject(attachmentRequest.error||new Error('Could not read attachment.'));
    queueRequest.onerror=()=>reject(queueRequest.error||new Error('Could not read attachment queue.'));
    activeRequest.onsuccess=apply;attachmentRequest.onsuccess=apply;queueRequest.onsuccess=apply;
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error||new Error('Could not queue attachment removal.'));
    tx.onabort=()=>reject(failure||tx.error||new Error('Removing attachment offline was aborted.'));
  });
  return {operationId,cancelledCreate};
}

export async function listAttachmentQueue(expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  const db=await openOfflineDatabase();
  if(!db)return [];
  const rows=await requestResult(db.transaction(ATTACHMENT_QUEUE_STORE,'readonly').objectStore(ATTACHMENT_QUEUE_STORE).getAll());
  return rows.filter(row=>!identity||row.identity===identity).sort((a,b)=>{
    if(a.attachmentId===b.attachmentId&&a.operation!==b.operation)return a.operation==='create'?-1:1;
    return String(a.createdAt).localeCompare(String(b.createdAt))||String(a.operationId).localeCompare(String(b.operationId));
  }).map(cloneValue);
}

export async function updateAttachmentQueue(operationId,patch={}){
  const db=await openOfflineDatabase();if(!db)return false;
  const tx=db.transaction(ATTACHMENT_QUEUE_STORE,'readwrite'),store=tx.objectStore(ATTACHMENT_QUEUE_STORE);
  const rowRequest=store.get(operationId),allRequest=store.getAll();
  const [row,all]=await Promise.all([requestResult(rowRequest),requestResult(allRequest)]);
  if(!row){await transactionDone(tx);return false;}
  if(row.operation==='create'&&(all||[]).some(item=>item.identity===row.identity&&item.attachmentId===row.attachmentId&&item.operation==='delete')){
    store.delete(operationId);
    await transactionDone(tx);
    return false;
  }
  store.put({...row,...cloneValue(patch),operationId:row.operationId});await transactionDone(tx);return true;
}

export async function removeAttachmentQueue(operationId){
  const db=await openOfflineDatabase();if(!db)return false;
  const tx=db.transaction(ATTACHMENT_QUEUE_STORE,'readwrite');tx.objectStore(ATTACHMENT_QUEUE_STORE).delete(operationId);await transactionDone(tx);return true;
}

export async function markOfflineAttachmentSynced(id,metadata,expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim(),db=await openOfflineDatabase();if(!db)return false;
  const tx=db.transaction(ATTACHMENT_STORE,'readwrite'),store=tx.objectStore(ATTACHMENT_STORE);
  const row=await requestResult(store.get(id));if(!row||identity&&row.identity!==identity){await transactionDone(tx);return false;}
  store.put({...row,...cloneValue(metadata),synced:true,status:'synced'});await transactionDone(tx);return true;
}


function attachmentDataBytes(row){
  const explicit=Number(row?.sizeBytes)||0;
  if(explicit>0)return explicit;
  const encoded=String(row?.data||'');
  return encoded?Math.floor(encoded.length*3/4):0;
}

export async function attachmentCacheInfo(expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim(),db=await openOfflineDatabase();
  if(!db)return {cachedBytes:0,pinnedBytes:0,evictableBytes:0,cachedCount:0,pinnedCount:0,localProtectedCount:0,limitBytes:OFFLINE_ATTACHMENT_CACHE_LIMIT_BYTES};
  const rows=await requestResult(db.transaction(ATTACHMENT_STORE,'readonly').objectStore(ATTACHMENT_STORE).getAll());
  let cachedBytes=0,pinnedBytes=0,evictableBytes=0,cachedCount=0,pinnedCount=0,localProtectedCount=0;
  for(const row of rows){
    if(identity&&row.identity!==identity)continue;
    if(row.status==='deleted'||!row.data)continue;
    const bytes=attachmentDataBytes(row);cachedBytes+=bytes;cachedCount++;
    const localProtected=row.synced===false||row.status==='pending'||row.offlinePolicy==='local';
    if(localProtected)localProtectedCount++;
    if(row.offlinePinned||localProtected){pinnedBytes+=bytes;pinnedCount++;}
    else if(row.synced===true&&row.status==='synced')evictableBytes+=bytes;
  }
  return {cachedBytes,pinnedBytes,evictableBytes,cachedCount,pinnedCount,localProtectedCount,limitBytes:OFFLINE_ATTACHMENT_CACHE_LIMIT_BYTES};
}

export async function saveAttachmentOfflineCopy(id,data,metadata={},expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim(),encoded=String(data||'');
  if(!identity||!encoded)throw new Error('Attachment data is required.');
  const db=await openOfflineDatabase();if(!db)throw new Error('Offline storage is unavailable in this browser.');
  const tx=db.transaction([META_STORE,ATTACHMENT_STORE],'readwrite'),meta=tx.objectStore(META_STORE),store=tx.objectStore(ATTACHMENT_STORE);
  const active=await requestResult(meta.get(ACTIVE_USER_KEY));
  if(active?.identity!==identity){tx.abort();throw new Error('Offline identity changed while caching the attachment.');}
  const existing=await requestResult(store.get(id));
  if(!existing||existing.identity!==identity){tx.abort();throw new Error('Attachment metadata is not cached on this device.');}
  if(existing.status==='deleted'){tx.abort();throw new Error('Attachment was deleted.');}
  const stamp=new Date().toISOString(),sizeBytes=Number(metadata.sizeBytes||existing.sizeBytes)||attachmentDataBytes({data:encoded});
  store.put({...existing,...cloneValue(metadata),id:existing.id,identity,data:encoded,sizeBytes,synced:true,status:'synced',offlinePinned:true,offlinePolicy:'pinned',cachedAt:stamp,lastAccessedAt:stamp});
  await transactionDone(tx);return true;
}

export async function removeAttachmentOfflineCopy(id,expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim(),db=await openOfflineDatabase();if(!db)return false;
  const tx=db.transaction([ATTACHMENT_STORE,ATTACHMENT_QUEUE_STORE],'readwrite'),store=tx.objectStore(ATTACHMENT_STORE),queue=tx.objectStore(ATTACHMENT_QUEUE_STORE);
  const [row,queued]=await Promise.all([requestResult(store.get(id)),requestResult(queue.getAll())]);
  if(!row||identity&&row.identity!==identity){await transactionDone(tx);return false;}
  const unsyncedCreate=(queued||[]).some(item=>item.identity===row.identity&&item.attachmentId===id&&item.operation==='create'&&pendingStatus(item.status));
  if(row.synced===false||row.status==='pending'||unsyncedCreate){
    tx.abort();
    const error=new Error('This file has not synced yet, so its only local copy cannot be removed.');
    error.code='ATTACHMENT_LOCAL_COPY_REQUIRED';
    throw error;
  }
  store.put({...row,data:'',offlinePinned:false,offlinePolicy:'metadata',cachedAt:null,lastAccessedAt:null,offlineCopyRemovedAt:new Date().toISOString()});
  await transactionDone(tx);return true;
}

export async function evictAttachmentCache(expectedIdentity='',options={}){
  const identity=String(expectedIdentity||'').trim(),targetBytes=Math.max(0,Number(options?.targetBytes)||0),clearAll=Boolean(options?.clearAll);
  const db=await openOfflineDatabase();if(!db)return {freedBytes:0,evicted:0};
  const tx=db.transaction([ATTACHMENT_STORE,ATTACHMENT_QUEUE_STORE],'readwrite'),store=tx.objectStore(ATTACHMENT_STORE),queue=tx.objectStore(ATTACHMENT_QUEUE_STORE);
  const [rows,queued]=await Promise.all([requestResult(store.getAll()),requestResult(queue.getAll())]);
  const protectedIds=new Set((queued||[]).filter(item=>pendingStatus(item.status)&&item.operation==='create').map(item=>item.attachmentId));
  const candidates=(rows||[]).filter(row=>{
    if(identity&&row.identity!==identity)return false;
    if(!row.data||row.status!=='synced'||row.synced!==true)return false;
    if(row.offlinePinned||row.offlinePolicy==='local'||protectedIds.has(row.id))return false;
    return true;
  }).sort((a,b)=>String(a.lastAccessedAt||a.cachedAt||a.createdAt||'').localeCompare(String(b.lastAccessedAt||b.cachedAt||b.createdAt||'')));
  let freedBytes=0,evicted=0;
  for(const row of candidates){
    if(!clearAll&&targetBytes>0&&freedBytes>=targetBytes)break;
    freedBytes+=attachmentDataBytes(row);evicted++;
    store.put({...row,data:'',offlinePolicy:'metadata',cachedAt:null,lastAccessedAt:null,evictedAt:new Date().toISOString()});
  }
  await transactionDone(tx);return {freedBytes,evicted};
}

export async function touchOfflineAttachment(id,expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim(),db=await openOfflineDatabase();if(!db)return false;
  const tx=db.transaction(ATTACHMENT_STORE,'readwrite'),store=tx.objectStore(ATTACHMENT_STORE),row=await requestResult(store.get(id));
  if(!row||identity&&row.identity!==identity||!row.data){await transactionDone(tx);return false;}
  store.put({...row,lastAccessedAt:new Date().toISOString()});await transactionDone(tx);return true;
}

export async function removeOfflineAttachment(id){
  const db=await openOfflineDatabase();if(!db)return false;
  const tx=db.transaction(ATTACHMENT_STORE,'readwrite');tx.objectStore(ATTACHMENT_STORE).delete(id);await transactionDone(tx);return true;
}

export async function pruneAttachmentQueueForMissingEntries(expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim(),db=await openOfflineDatabase();if(!db)return 0;
  const tx=db.transaction(['entries',ATTACHMENT_STORE,ATTACHMENT_QUEUE_STORE],'readwrite');
  const entries=await requestResult(tx.objectStore('entries').getAll());
  const attachments=await requestResult(tx.objectStore(ATTACHMENT_STORE).getAll());
  const queue=await requestResult(tx.objectStore(ATTACHMENT_QUEUE_STORE).getAll());
  const ids=new Set(entries.map(row=>row.id));let removed=0;
  for(const attachment of attachments){
    if((!identity||attachment.identity===identity)&&!ids.has(attachment.entryId)){tx.objectStore(ATTACHMENT_STORE).delete(attachment.id);removed++;}
  }
  for(const row of queue){
    if((!identity||row.identity===identity)&&row.entryId&&!ids.has(row.entryId))tx.objectStore(ATTACHMENT_QUEUE_STORE).delete(row.operationId);
  }
  await transactionDone(tx);return removed;
}


export async function loadBankFeedSnapshot(expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim(),db=await openOfflineDatabase();
  if(!db)return null;
  const row=await requestResult(db.transaction(BANK_FEED_STATE_STORE,'readonly').objectStore(BANK_FEED_STATE_STORE).get(BANK_FEED_CACHE_KEY));
  if(!row||identity&&row.identity!==identity)return null;
  return row.snapshot?cloneValue(row.snapshot):null;
}

export async function saveBankFeedSnapshot(snapshot,expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  if(!identity||!snapshot||typeof snapshot!=='object')return false;
  const db=await openOfflineDatabase();if(!db)return false;
  const tx=db.transaction([META_STORE,BANK_FEED_STATE_STORE],'readwrite');
  const active=await requestResult(tx.objectStore(META_STORE).get(ACTIVE_USER_KEY));
  if(active?.identity!==identity){tx.abort();return false;}
  tx.objectStore(BANK_FEED_STATE_STORE).put({key:BANK_FEED_CACHE_KEY,identity,snapshot:cloneValue(snapshot),savedAt:new Date().toISOString()});
  await transactionDone(tx);return true;
}

export async function enqueueBankFeedOperation(operation,snapshot,expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim(),operationId=String(operation?.operationId||'');
  if(!identity||!operationId.startsWith('op_'))throw new Error('Invalid offline Bank Feed operation.');
  const db=await openOfflineDatabase();if(!db)throw new Error('Offline storage is unavailable in this browser.');
  await new Promise((resolve,reject)=>{
    const tx=db.transaction([META_STORE,BANK_FEED_STATE_STORE,BANK_FEED_QUEUE_STORE],'readwrite');
    const activeRequest=tx.objectStore(META_STORE).get(ACTIVE_USER_KEY);let failure=null;
    activeRequest.onsuccess=()=>{
      if(activeRequest.result?.identity!==identity){failure=new Error('Offline identity changed while saving the Bank Feed change.');tx.abort();return;}
      tx.objectStore(BANK_FEED_QUEUE_STORE).put({...cloneValue(operation),operationId,identity,createdAt:operation.createdAt||new Date().toISOString(),attempts:Number(operation.attempts||0),status:operation.status||'pending',lastError:String(operation.lastError||'')});
      if(snapshot&&typeof snapshot==='object')tx.objectStore(BANK_FEED_STATE_STORE).put({key:BANK_FEED_CACHE_KEY,identity,snapshot:cloneValue(snapshot),savedAt:new Date().toISOString()});
    };
    activeRequest.onerror=()=>reject(activeRequest.error||new Error('Could not verify offline user.'));
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error||new Error('Could not queue the Bank Feed change.'));
    tx.onabort=()=>reject(failure||tx.error||new Error('Saving the Bank Feed change was aborted.'));
  });
  return {operationId};
}

export async function listBankFeedQueue(expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim(),db=await openOfflineDatabase();if(!db)return [];
  const rows=await requestResult(db.transaction(BANK_FEED_QUEUE_STORE,'readonly').objectStore(BANK_FEED_QUEUE_STORE).getAll());
  return rows.filter(row=>!identity||row.identity===identity).sort((a,b)=>Number(a.queueOrder||0)-Number(b.queueOrder||0)||String(a.createdAt).localeCompare(String(b.createdAt))||String(a.operationId).localeCompare(String(b.operationId))).map(cloneValue);
}

export async function updateBankFeedQueue(operationId,patch={}){
  const db=await openOfflineDatabase();if(!db)return false;
  const tx=db.transaction(BANK_FEED_QUEUE_STORE,'readwrite'),store=tx.objectStore(BANK_FEED_QUEUE_STORE);
  const row=await requestResult(store.get(operationId));if(!row){await transactionDone(tx);return false;}
  store.put({...row,...cloneValue(patch),operationId:row.operationId});await transactionDone(tx);return true;
}

export async function removeBankFeedQueue(operationId){
  const db=await openOfflineDatabase();if(!db)return false;
  const tx=db.transaction(BANK_FEED_QUEUE_STORE,'readwrite');tx.objectStore(BANK_FEED_QUEUE_STORE).delete(operationId);await transactionDone(tx);return true;
}

export async function discardBankFeedQueue(expectedIdentity='',options={}){
  const identity=String(expectedIdentity||'').trim(),db=await openOfflineDatabase();if(!db)return false;
  const stores=options?.clearCache?[BANK_FEED_QUEUE_STORE,BANK_FEED_STATE_STORE]:[BANK_FEED_QUEUE_STORE];
  const tx=db.transaction(stores,'readwrite'),queue=tx.objectStore(BANK_FEED_QUEUE_STORE),rows=await requestResult(queue.getAll());
  for(const row of rows)if(!identity||row.identity===identity)queue.delete(row.operationId);
  if(options?.clearCache){
    const state=tx.objectStore(BANK_FEED_STATE_STORE),cached=await requestResult(state.get(BANK_FEED_CACHE_KEY));
    if(cached&&(!identity||cached.identity===identity))state.delete(BANK_FEED_CACHE_KEY);
  }
  await transactionDone(tx);return true;
}


export async function loadRecurringSnapshot(expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim(),db=await openOfflineDatabase();if(!db)return null;
  const row=await requestResult(db.transaction(RECURRING_STATE_STORE,'readonly').objectStore(RECURRING_STATE_STORE).get(RECURRING_CACHE_KEY));
  if(!row||identity&&row.identity!==identity)return null;
  return row.snapshot?cloneValue(row.snapshot):null;
}

export async function saveRecurringSnapshot(snapshot,expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  if(!identity||!snapshot||typeof snapshot!=='object')return false;
  const db=await openOfflineDatabase();if(!db)return false;
  const tx=db.transaction([META_STORE,RECURRING_STATE_STORE],'readwrite');
  const active=await requestResult(tx.objectStore(META_STORE).get(ACTIVE_USER_KEY));
  if(active?.identity!==identity){tx.abort();return false;}
  tx.objectStore(RECURRING_STATE_STORE).put({key:RECURRING_CACHE_KEY,identity,snapshot:cloneValue(snapshot),savedAt:new Date().toISOString()});
  await transactionDone(tx);return true;
}

export async function enqueueRecurringOperation(operation,snapshot,expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim(),operationId=String(operation?.operationId||'');
  if(!identity||!operationId.startsWith('op_'))throw new Error('Invalid offline recurring operation.');
  const db=await openOfflineDatabase();if(!db)throw new Error('Offline storage is unavailable in this browser.');
  await new Promise((resolve,reject)=>{
    const tx=db.transaction([META_STORE,RECURRING_STATE_STORE,RECURRING_QUEUE_STORE],'readwrite');
    const activeRequest=tx.objectStore(META_STORE).get(ACTIVE_USER_KEY),queueStore=tx.objectStore(RECURRING_QUEUE_STORE),rowsRequest=queueStore.getAll();
    let failure=null,written=false;
    const write=()=>{
      if(written||activeRequest.readyState!=='done'||rowsRequest.readyState!=='done')return;
      if(activeRequest.result?.identity!==identity){failure=new Error('Offline identity changed while saving the recurring change.');tx.abort();return;}
      written=true;
      const queueOrder=(rowsRequest.result||[]).filter(row=>row.identity===identity).reduce((max,row)=>Math.max(max,Number(row.queueOrder||0)),0)+1;
      queueStore.put({...cloneValue(operation),operationId,identity,queueOrder,createdAt:operation.createdAt||new Date().toISOString(),attempts:Number(operation.attempts||0),status:operation.status||'pending',lastError:String(operation.lastError||'')});
      if(snapshot&&typeof snapshot==='object')tx.objectStore(RECURRING_STATE_STORE).put({key:RECURRING_CACHE_KEY,identity,snapshot:cloneValue(snapshot),savedAt:new Date().toISOString()});
    };
    activeRequest.onsuccess=write;rowsRequest.onsuccess=write;
    activeRequest.onerror=()=>reject(activeRequest.error||new Error('Could not verify offline user.'));
    rowsRequest.onerror=()=>reject(rowsRequest.error||new Error('Could not inspect the recurring queue.'));
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error||new Error('Could not queue the recurring change.'));
    tx.onabort=()=>reject(failure||tx.error||new Error('Saving the recurring change was aborted.'));
  });
  return {operationId};
}

export async function listRecurringQueue(expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim(),db=await openOfflineDatabase();if(!db)return [];
  const rows=await requestResult(db.transaction(RECURRING_QUEUE_STORE,'readonly').objectStore(RECURRING_QUEUE_STORE).getAll());
  return rows.filter(row=>!identity||row.identity===identity).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))||String(a.operationId).localeCompare(String(b.operationId))).map(cloneValue);
}

export async function updateRecurringQueue(operationId,patch={}){
  const db=await openOfflineDatabase();if(!db)return false;
  const tx=db.transaction(RECURRING_QUEUE_STORE,'readwrite'),store=tx.objectStore(RECURRING_QUEUE_STORE);
  const row=await requestResult(store.get(operationId));if(!row){await transactionDone(tx);return false;}
  store.put({...row,...cloneValue(patch),operationId:row.operationId});await transactionDone(tx);return true;
}

export async function removeRecurringQueue(operationId){
  const db=await openOfflineDatabase();if(!db)return false;
  const tx=db.transaction(RECURRING_QUEUE_STORE,'readwrite');tx.objectStore(RECURRING_QUEUE_STORE).delete(operationId);await transactionDone(tx);return true;
}

export async function discardRecurringQueue(expectedIdentity='',options={}){
  const identity=String(expectedIdentity||'').trim(),db=await openOfflineDatabase();if(!db)return false;
  const stores=options?.clearCache?[RECURRING_QUEUE_STORE,RECURRING_STATE_STORE]:[RECURRING_QUEUE_STORE];
  const tx=db.transaction(stores,'readwrite'),queue=tx.objectStore(RECURRING_QUEUE_STORE),rows=await requestResult(queue.getAll());
  for(const row of rows)if(!identity||row.identity===identity)queue.delete(row.operationId);
  if(options?.clearCache){
    const state=tx.objectStore(RECURRING_STATE_STORE),cached=await requestResult(state.get(RECURRING_CACHE_KEY));
    if(cached&&(!identity||cached.identity===identity))state.delete(RECURRING_CACHE_KEY);
  }
  await transactionDone(tx);return true;
}

export async function updateQueuedOperation(operationId,patch={}){
  const db=await openOfflineDatabase();
  if(!db) return false;
  const tx=db.transaction(SYNC_QUEUE_STORE,'readwrite');
  const store=tx.objectStore(SYNC_QUEUE_STORE);
  const row=await requestResult(store.get(operationId));
  if(!row){await transactionDone(tx);return false;}
  store.put({...row,...cloneValue(patch),operationId:row.operationId});
  await transactionDone(tx);
  return true;
}

export async function removeQueuedOperation(operationId){
  const db=await openOfflineDatabase();
  if(!db) return false;
  const tx=db.transaction(SYNC_QUEUE_STORE,'readwrite');
  tx.objectStore(SYNC_QUEUE_STORE).delete(operationId);
  await transactionDone(tx);
  return true;
}

export async function getLastServerRevision(expectedIdentity=''){
  const db=await openOfflineDatabase();
  if(!db) return null;
  const identity=String(expectedIdentity||'').trim();
  const row=await requestResult(db.transaction(SYNC_STATE_STORE,'readonly').objectStore(SYNC_STATE_STORE).get(SYNC_BASE_KEY));
  if(!row||identity&&row.identity!==identity) return null;
  return Number.isInteger(Number(row.serverRevision))?Number(row.serverRevision):null;
}

export async function setLastServerRevision(expectedIdentity,revision){
  const identity=String(expectedIdentity||'').trim(),value=Number(revision);
  if(!identity||!Number.isInteger(value)) return false;
  const db=await openOfflineDatabase();
  if(!db) return false;
  const tx=db.transaction([META_STORE,SYNC_STATE_STORE],'readwrite');
  const active=await requestResult(tx.objectStore(META_STORE).get(ACTIVE_USER_KEY));
  if(active?.identity!==identity){tx.abort();return false;}
  tx.objectStore(SYNC_STATE_STORE).put({key:SYNC_BASE_KEY,identity,serverRevision:value,updatedAt:new Date().toISOString()});
  await transactionDone(tx);
  return true;
}

export async function markSyncSuccess(expectedIdentity,details={}){
  const identity=String(expectedIdentity||'').trim();
  if(!identity)return false;
  const db=await openOfflineDatabase();
  if(!db)return false;
  const tx=db.transaction([META_STORE,SYNC_STATE_STORE],'readwrite');
  const active=await requestResult(tx.objectStore(META_STORE).get(ACTIVE_USER_KEY));
  if(active?.identity!==identity){tx.abort();return false;}
  const stamp=new Date().toISOString();
  tx.objectStore(SYNC_STATE_STORE).put({
    key:LAST_SYNC_KEY,identity,lastSyncedAt:stamp,
    serverRevision:Number.isInteger(Number(details.serverRevision))?Number(details.serverRevision):null,
    source:String(details.source||'foreground')
  });
  await transactionDone(tx);
  return true;
}

export async function syncRuntimeInfo(expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  const db=await openOfflineDatabase();
  if(!db)return {lastSyncedAt:null,lastSyncSource:'',serverRevision:null};
  const row=await requestResult(db.transaction(SYNC_STATE_STORE,'readonly').objectStore(SYNC_STATE_STORE).get(LAST_SYNC_KEY));
  if(!row||identity&&row.identity!==identity)return {lastSyncedAt:null,lastSyncSource:'',serverRevision:null};
  return {lastSyncedAt:row.lastSyncedAt||null,lastSyncSource:row.source||'',serverRevision:Number.isInteger(Number(row.serverRevision))?Number(row.serverRevision):null};
}

export async function retryFailedQueuedOperations(expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  const db=await openOfflineDatabase();
  if(!db)return 0;
  const tx=db.transaction([SYNC_QUEUE_STORE,ATTACHMENT_QUEUE_STORE,BANK_FEED_QUEUE_STORE,RECURRING_QUEUE_STORE],'readwrite');
  let reset=0;
  for(const name of [SYNC_QUEUE_STORE,ATTACHMENT_QUEUE_STORE,BANK_FEED_QUEUE_STORE,RECURRING_QUEUE_STORE]){
    const store=tx.objectStore(name),rows=await requestResult(store.getAll());
    for(const row of rows){
      if((!identity||row.identity===identity)&&row.status==='failed'){
        store.put({...row,status:'pending',lastError:'',retryRequestedAt:new Date().toISOString()});
        reset++;
      }
    }
  }
  await transactionDone(tx);
  return reset;
}


export async function offlineWorkingSetBundle(expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  const db=await openOfflineDatabase();
  if(!db)throw new Error('Offline storage is unavailable in this browser.');
  const stores=[META_STORE,...LEDGER_STORES,SYNC_QUEUE_STORE,SYNC_STATE_STORE,TOMBSTONE_STORE,ATTACHMENT_STORE,ATTACHMENT_QUEUE_STORE,FX_RATE_STORE,BANK_FEED_STATE_STORE,BANK_FEED_QUEUE_STORE,RECURRING_STATE_STORE,RECURRING_QUEUE_STORE];
  const tx=db.transaction(stores,'readonly'),meta=tx.objectStore(META_STORE);
  const requests={
    active:meta.get(ACTIVE_USER_KEY),head:meta.get(STATE_HEAD_KEY),
    people:tx.objectStore('people').getAll(),accounts:tx.objectStore('accounts').getAll(),entries:tx.objectStore('entries').getAll(),categories:tx.objectStore('categories').getAll(),budgets:tx.objectStore('budgets').getAll(),
    queue:tx.objectStore(SYNC_QUEUE_STORE).getAll(),syncState:tx.objectStore(SYNC_STATE_STORE).getAll(),tombstones:tx.objectStore(TOMBSTONE_STORE).getAll(),
    attachments:tx.objectStore(ATTACHMENT_STORE).getAll(),attachmentQueue:tx.objectStore(ATTACHMENT_QUEUE_STORE).getAll(),fxRates:tx.objectStore(FX_RATE_STORE).getAll(),
    bankFeedState:tx.objectStore(BANK_FEED_STATE_STORE).get(BANK_FEED_CACHE_KEY),bankFeedQueue:tx.objectStore(BANK_FEED_QUEUE_STORE).getAll(),
    recurringState:tx.objectStore(RECURRING_STATE_STORE).get(RECURRING_CACHE_KEY),recurringQueue:tx.objectStore(RECURRING_QUEUE_STORE).getAll()
  };
  const values=await Promise.all(Object.values(requests).map(requestResult));
  await transactionDone(tx);
  const data=Object.fromEntries(Object.keys(requests).map((key,index)=>[key,values[index]]));
  const activeIdentity=String(data.active?.identity||'');
  if(!activeIdentity||!data.head?.head||data.head.identity!==activeIdentity)throw new Error('No complete offline working set is available on this device.');
  if(identity&&activeIdentity!==identity)throw new Error('Offline identity changed while creating the recovery archive.');
  const same=row=>String(row?.identity||'')===activeIdentity;
  return {
    identity:activeIdentity,
    snapshot:cloneValue({...data.head.head,people:data.people||[],accounts:data.accounts||[],entries:data.entries||[],categories:data.categories||[],budgets:data.budgets||[]}),
    queue:(data.queue||[]).filter(same).map(cloneValue),
    syncState:(data.syncState||[]).filter(same).map(cloneValue),
    tombstones:(data.tombstones||[]).filter(same).map(cloneValue),
    attachments:(data.attachments||[]).filter(same).map(cloneValue),
    attachmentQueue:(data.attachmentQueue||[]).filter(same).map(cloneValue),
    fxRates:(data.fxRates||[]).filter(same).map(cloneValue),
    bankFeedSnapshot:data.bankFeedState?.identity===activeIdentity&&data.bankFeedState?.snapshot?cloneValue(data.bankFeedState.snapshot):null,
    bankFeedQueue:(data.bankFeedQueue||[]).filter(same).map(cloneValue),
    recurringSnapshot:data.recurringState?.identity===activeIdentity&&data.recurringState?.snapshot?cloneValue(data.recurringState.snapshot):null,
    recurringQueue:(data.recurringQueue||[]).filter(same).map(cloneValue)
  };
}

export async function restoreOfflineWorkingSet(payload,expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  if(!identity)throw new Error('No offline account is active on this device.');
  if(!payload||!isLedgerState(payload.snapshot))throw new Error('Recovery payload does not contain a valid ledger snapshot.');
  const identityRows=[payload.queue,payload.syncState,payload.tombstones,payload.attachments,payload.attachmentQueue,payload.fxRates,payload.bankFeedQueue,payload.recurringQueue];
  for(const rows of identityRows){
    if(!Array.isArray(rows))throw new Error('Recovery payload is missing required offline data.');
    if(rows.some(row=>String(row?.identity||'')!==identity))throw new Error('Recovery payload contains data for a different offline account.');
  }
  const db=await openOfflineDatabase();
  if(!db)throw new Error('Offline storage is unavailable in this browser.');
  const clean=splitState(cloneValue(payload.snapshot));
  const stores=[META_STORE,...LEDGER_STORES,SYNC_QUEUE_STORE,SYNC_STATE_STORE,TOMBSTONE_STORE,ATTACHMENT_STORE,ATTACHMENT_QUEUE_STORE,FX_RATE_STORE,BANK_FEED_STATE_STORE,BANK_FEED_QUEUE_STORE,RECURRING_STATE_STORE,RECURRING_QUEUE_STORE];
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(stores,'readwrite'),meta=tx.objectStore(META_STORE),activeRequest=meta.get(ACTIVE_USER_KEY);
    let failure=null;
    activeRequest.onerror=()=>reject(activeRequest.error||new Error('Could not verify the active offline account.'));
    activeRequest.onsuccess=()=>{
      if(activeRequest.result?.identity!==identity){
        failure=new Error('This recovery archive belongs to a different active offline account.');
        tx.abort();return;
      }
      for(const name of [...LEDGER_STORES,SYNC_QUEUE_STORE,SYNC_STATE_STORE,TOMBSTONE_STORE,ATTACHMENT_STORE,ATTACHMENT_QUEUE_STORE,FX_RATE_STORE,BANK_FEED_STATE_STORE,BANK_FEED_QUEUE_STORE,RECURRING_STATE_STORE,RECURRING_QUEUE_STORE])tx.objectStore(name).clear();
      for(const row of clean.people)if(row?.id)tx.objectStore('people').put(cloneValue(row));
      for(const row of clean.accounts)if(row?.id)tx.objectStore('accounts').put(cloneValue(row));
      for(const row of clean.entries)if(row?.id)tx.objectStore('entries').put(cloneValue(row));
      for(const row of clean.categories)if(row?.id)tx.objectStore('categories').put(cloneValue(row));
      for(const row of clean.budgets)if(row?.id)tx.objectStore('budgets').put(cloneValue(row));
      meta.put({key:STATE_HEAD_KEY,identity,head:clean.head,savedAt:new Date().toISOString(),schemaVersion:OFFLINE_DB.version,recoveredAt:new Date().toISOString()});
      for(const row of payload.queue)tx.objectStore(SYNC_QUEUE_STORE).put(cloneValue(row));
      for(const row of payload.syncState)if([SYNC_BASE_KEY,LAST_SYNC_KEY].includes(String(row?.key||'')))tx.objectStore(SYNC_STATE_STORE).put(cloneValue(row));
      for(const row of payload.tombstones)if(row?.key)tx.objectStore(TOMBSTONE_STORE).put(cloneValue(row));
      for(const row of payload.attachments)if(row?.id)tx.objectStore(ATTACHMENT_STORE).put(cloneValue(row));
      for(const row of payload.attachmentQueue)tx.objectStore(ATTACHMENT_QUEUE_STORE).put(cloneValue(row));
      for(const row of payload.fxRates)if(row?.entryId)tx.objectStore(FX_RATE_STORE).put(cloneValue(row));
      if(payload.bankFeedSnapshot&&typeof payload.bankFeedSnapshot==='object')tx.objectStore(BANK_FEED_STATE_STORE).put({key:BANK_FEED_CACHE_KEY,identity,snapshot:cloneValue(payload.bankFeedSnapshot),savedAt:new Date().toISOString(),recoveredAt:new Date().toISOString()});
      for(const row of payload.bankFeedQueue)tx.objectStore(BANK_FEED_QUEUE_STORE).put(cloneValue(row));
      if(payload.recurringSnapshot&&typeof payload.recurringSnapshot==='object')tx.objectStore(RECURRING_STATE_STORE).put({key:RECURRING_CACHE_KEY,identity,snapshot:cloneValue(payload.recurringSnapshot),savedAt:new Date().toISOString(),recoveredAt:new Date().toISOString()});
      for(const row of payload.recurringQueue)tx.objectStore(RECURRING_QUEUE_STORE).put(cloneValue(row));
    };
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error||new Error('Could not restore the offline working set.'));
    tx.onabort=()=>reject(failure||tx.error||new Error('Restoring the offline working set was aborted.'));
  });
  return await loadStateSnapshot();
}

export async function queuedRecoveryBundle(expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  const db=await openOfflineDatabase();
  if(!db)throw new Error('Offline storage is unavailable in this browser.');
  const tx=db.transaction([META_STORE,SYNC_QUEUE_STORE,ATTACHMENT_QUEUE_STORE,BANK_FEED_QUEUE_STORE,RECURRING_QUEUE_STORE,TOMBSTONE_STORE],'readonly');
  const [active,queue,attachmentQueue,bankFeedQueue,recurringQueue,tombstones]=await Promise.all([
    requestResult(tx.objectStore(META_STORE).get(ACTIVE_USER_KEY)),
    requestResult(tx.objectStore(SYNC_QUEUE_STORE).getAll()),
    requestResult(tx.objectStore(ATTACHMENT_QUEUE_STORE).getAll()),
    requestResult(tx.objectStore(BANK_FEED_QUEUE_STORE).getAll()),
    requestResult(tx.objectStore(RECURRING_QUEUE_STORE).getAll()),
    requestResult(tx.objectStore(TOMBSTONE_STORE).getAll())
  ]);
  await transactionDone(tx);
  if(identity&&active?.identity!==identity)throw new Error('Offline identity changed while creating the recovery file.');
  return {
    identity:active?.identity||'',
    queue:(queue||[]).filter(row=>!identity||row.identity===identity).map(cloneValue),
    attachmentQueue:(attachmentQueue||[]).filter(row=>!identity||row.identity===identity).map(cloneValue),
    bankFeedQueue:(bankFeedQueue||[]).filter(row=>!identity||row.identity===identity).map(cloneValue),
    recurringQueue:(recurringQueue||[]).filter(row=>!identity||row.identity===identity).map(cloneValue),
    tombstones:(tombstones||[]).filter(row=>!identity||row.identity===identity).map(cloneValue)
  };
}

export async function applyPulledChanges(changes,currentRevision,expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim(),revision=Number(currentRevision);
  if(!identity||!Number.isInteger(revision)) return false;
  const db=await openOfflineDatabase();
  if(!db) return false;
  const applied=await new Promise((resolve,reject)=>{
    const tx=db.transaction([META_STORE,...LEDGER_STORES,SYNC_QUEUE_STORE,SYNC_STATE_STORE,TOMBSTONE_STORE],'readwrite');
    const activeRequest=tx.objectStore(META_STORE).get(ACTIVE_USER_KEY);
    const queueRequest=tx.objectStore(SYNC_QUEUE_STORE).getAll();
    const headRequest=tx.objectStore(META_STORE).get(STATE_HEAD_KEY);
    const entriesRequest=tx.objectStore('entries').getAll();
    let failure=null;
    const apply=()=>{
      if(activeRequest.readyState!=='done'||queueRequest.readyState!=='done'||headRequest.readyState!=='done'||entriesRequest.readyState!=='done') return;
      if(activeRequest.result?.identity!==identity||headRequest.result?.identity!==identity){
        failure=new Error('Offline identity changed while applying sync results.');tx.abort();return;
      }
      if((queueRequest.result||[]).some(row=>row.identity===identity&&pendingStatus(row.status))){
        failure=Object.assign(new Error('Cannot apply remote changes while local changes are still queued.'),{code:'OFFLINE_PENDING_CHANGES'});tx.abort();return;
      }
      const head=headRequest.result;
      const cachedEntries=new Map((entriesRequest.result||[]).map(row=>[row.id,row]));
      for(const change of Array.isArray(changes)?changes:[]){
        const entity=String(change?.entity||''),operation=String(change?.operation||''),id=String(change?.entityId||'');
        if(entity==='settings'&&change?.payload){
          head.head.settings={...(head.head.settings||{}),...cloneValue(change.payload)};
          continue;
        }
        const storeName=entity==='person'?'people':entity==='account'?'accounts':entity==='entry'?'entries':'';
        if(!storeName) continue;
        if(operation==='delete'){
          tx.objectStore(storeName).delete(id);
          tx.objectStore(TOMBSTONE_STORE).put({
            key:entity+':'+id,
            identity,
            entity,
            entityId:id,
            deletedAt:change?.createdAt||new Date().toISOString(),
            serverRevision:Number(change?.revision)||revision,
            synced:true
          });
        }else if(change?.payload?.id){
          tx.objectStore(TOMBSTONE_STORE).delete(entity+':'+id);
          const payload=cloneValue(change.payload);
          if(entity==='entry'){
            const previous=cachedEntries.get(id)||{};
            tx.objectStore(storeName).put({...previous,...payload});
            cachedEntries.set(id,{...previous,...payload});
          }else tx.objectStore(storeName).put(payload);
        }
      }
      head.head.version=revision;
      tx.objectStore(META_STORE).put({...head,savedAt:new Date().toISOString(),schemaVersion:OFFLINE_DB.version});
      tx.objectStore(SYNC_STATE_STORE).put({key:SYNC_BASE_KEY,identity,serverRevision:revision,updatedAt:new Date().toISOString()});
    };
    for(const req of [activeRequest,queueRequest,headRequest,entriesRequest]){req.onsuccess=apply;req.onerror=()=>reject(req.error||new Error('Could not apply sync changes.'));}
    tx.oncomplete=()=>resolve(true);
    tx.onerror=()=>reject(tx.error||new Error('Could not apply sync changes.'));
    tx.onabort=()=>reject(failure||tx.error||new Error('Applying sync changes was aborted.'));
  });
  if(applied&&(Array.isArray(changes)?changes:[]).some(change=>['entry','account'].includes(String(change?.entity||''))))await rebuildFxRateCache(identity).catch(()=>{});
  return applied;
}

export async function discardQueuedOperations(expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  const db=await openOfflineDatabase();
  if(!db) return false;
  const tx=db.transaction(SYNC_QUEUE_STORE,'readwrite');
  const store=tx.objectStore(SYNC_QUEUE_STORE);
  const rows=await requestResult(store.getAll());
  for(const row of rows) if(!identity||row.identity===identity) store.delete(row.operationId);
  await transactionDone(tx);
  return true;
}


export async function discardAttachmentQueue(expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  const db=await openOfflineDatabase();if(!db)return false;
  const tx=db.transaction([ATTACHMENT_STORE,ATTACHMENT_QUEUE_STORE],'readwrite');
  const queue=tx.objectStore(ATTACHMENT_QUEUE_STORE),attachments=tx.objectStore(ATTACHMENT_STORE);
  const [queueRows,attachmentRows]=await Promise.all([requestResult(queue.getAll()),requestResult(attachments.getAll())]);
  for(const row of queueRows)if(!identity||row.identity===identity)queue.delete(row.operationId);
  for(const row of attachmentRows)if(!identity||row.identity===identity)attachments.delete(row.id);
  await transactionDone(tx);return true;
}

export async function offlineSnapshotInfo(){
  const db=await openOfflineDatabase();
  if(!db) return {available:false,savedAt:null,version:null,schemaVersion:OFFLINE_DB.version,pending:0};
  const tx=db.transaction([META_STORE,SYNC_QUEUE_STORE,ATTACHMENT_QUEUE_STORE,BANK_FEED_QUEUE_STORE,RECURRING_QUEUE_STORE],'readonly');
  const done=transactionDone(tx);
  const userRequest=tx.objectStore(META_STORE).get(ACTIVE_USER_KEY);
  const headRequest=tx.objectStore(META_STORE).get(STATE_HEAD_KEY);
  const queueRequest=tx.objectStore(SYNC_QUEUE_STORE).getAll();
  const attachmentQueueRequest=tx.objectStore(ATTACHMENT_QUEUE_STORE).getAll();
  const bankFeedQueueRequest=tx.objectStore(BANK_FEED_QUEUE_STORE).getAll();
  const recurringQueueRequest=tx.objectStore(RECURRING_QUEUE_STORE).getAll();
  const [user,head,queue,attachmentQueue,bankFeedQueue,recurringQueue]=await Promise.all([requestResult(userRequest),requestResult(headRequest),requestResult(queueRequest),requestResult(attachmentQueueRequest),requestResult(bankFeedQueueRequest),requestResult(recurringQueueRequest)]);
  await done;
  const available=Boolean(user?.identity&&head?.identity===user.identity&&head?.head);
  const pending=[...(queue||[]),...(attachmentQueue||[]),...(bankFeedQueue||[]),...(recurringQueue||[])].filter(row=>row.identity===user?.identity&&pendingStatus(row.status)).length;
  return {available,savedAt:available?head.savedAt:null,version:available?Number(head.head.version)||null:null,schemaVersion:OFFLINE_DB.version,pending};
}

export async function clearOfflineData(expectedIdentity='',options={}){
  const db=await openOfflineDatabase();
  if(!db) return false;
  const identity=String(expectedIdentity||'').trim();
  const force=options?.force===true;

  return await new Promise((resolve,reject)=>{
    const tx=db.transaction(OFFLINE_DB.stores,'readwrite');
    const meta=tx.objectStore(META_STORE);
    let identityMismatch=false,blockedError=null;
    const clearAll=()=>{ for(const name of OFFLINE_DB.stores) tx.objectStore(name).clear(); meta.put({key:SCHEMA_INFO_KEY,version:OFFLINE_DB.version,fromVersion:OFFLINE_DB.version,migratedAt:new Date().toISOString(),strategy:'retained-after-user-clear',postOpenComplete:true}); };
    const checkPendingThenClear=activeIdentity=>{
      if(force){clearAll();return;}
      const queueRequest=tx.objectStore(SYNC_QUEUE_STORE).getAll();
      const attachmentQueueRequest=tx.objectStore(ATTACHMENT_QUEUE_STORE).getAll();
      const bankFeedQueueRequest=tx.objectStore(BANK_FEED_QUEUE_STORE).getAll();
      const recurringQueueRequest=tx.objectStore(RECURRING_QUEUE_STORE).getAll();
      const inspect=()=>{
        if(queueRequest.readyState!=='done'||attachmentQueueRequest.readyState!=='done'||bankFeedQueueRequest.readyState!=='done'||recurringQueueRequest.readyState!=='done')return;
        const pending=[...(queueRequest.result||[]),...(attachmentQueueRequest.result||[]),...(bankFeedQueueRequest.result||[]),...(recurringQueueRequest.result||[])].filter(row=>(!activeIdentity||row.identity===activeIdentity)&&pendingStatus(row.status));
        if(pending.length){
          blockedError=Object.assign(new Error('Unsynced offline changes are still stored on this device.'),{code:'OFFLINE_PENDING_CHANGES'});
          tx.abort();return;
        }
        clearAll();
      };
      queueRequest.onerror=()=>reject(queueRequest.error||new Error('Could not inspect pending offline changes.'));
      attachmentQueueRequest.onerror=()=>reject(attachmentQueueRequest.error||new Error('Could not inspect pending offline attachments.'));
      bankFeedQueueRequest.onerror=()=>reject(bankFeedQueueRequest.error||new Error('Could not inspect pending Bank Feed changes.'));
      recurringQueueRequest.onerror=()=>reject(recurringQueueRequest.error||new Error('Could not inspect pending recurring changes.'));
      queueRequest.onsuccess=inspect;
      attachmentQueueRequest.onsuccess=inspect;
      bankFeedQueueRequest.onsuccess=inspect;
      recurringQueueRequest.onsuccess=inspect;
    };

    if(identity){
      const activeRequest=meta.get(ACTIVE_USER_KEY);
      activeRequest.onerror=()=>reject(activeRequest.error||new Error('Could not verify the active offline user.'));
      activeRequest.onsuccess=()=>{
        if(activeRequest.result?.identity!==identity){identityMismatch=true;tx.abort();return;}
        checkPendingThenClear(identity);
      };
    }else{
      checkPendingThenClear('');
    }

    tx.oncomplete=()=>resolve(true);
    tx.onerror=()=>reject(tx.error||new Error('Could not clear offline data.'));
    tx.onabort=()=>identityMismatch?resolve(false):blockedError?reject(blockedError):reject(tx.error||new Error('Clearing offline data was aborted.'));
  });
}
