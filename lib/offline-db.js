export const OFFLINE_DB = Object.freeze({
  name: 'money-tracker-offline',
  version: 2,
  stores: Object.freeze(['meta','people','accounts','entries','categories','budgets','syncQueue','syncState'])
});

const META_STORE='meta';
const LEDGER_STORES=['people','accounts','entries','categories','budgets'];
const SYNC_QUEUE_STORE='syncQueue';
const SYNC_STATE_STORE='syncState';
const ACTIVE_USER_KEY='active-user';
const STATE_HEAD_KEY='state-head';
const SYNC_BASE_KEY='sync-base';

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

export function openOfflineDatabase(){
  if(!supported()) return Promise.resolve(null);
  if(databasePromise) return databasePromise;
  databasePromise=new Promise((resolve,reject)=>{
    const request=indexedDB.open(OFFLINE_DB.name,OFFLINE_DB.version);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE,{keyPath:'key'});
      for(const name of LEDGER_STORES){
        if(!db.objectStoreNames.contains(name)) db.createObjectStore(name,{keyPath:'id'});
      }
      if(!db.objectStoreNames.contains(SYNC_QUEUE_STORE)) db.createObjectStore(SYNC_QUEUE_STORE,{keyPath:'operationId'});
      if(!db.objectStoreNames.contains(SYNC_STATE_STORE)) db.createObjectStore(SYNC_STATE_STORE,{keyPath:'key'});
    };
    request.onsuccess=()=>{
      const db=request.result;
      db.onversionchange=()=>{db.close();databasePromise=null;};
      resolve(db);
    };
    request.onerror=()=>{databasePromise=null;reject(request.error||new Error('Could not open offline database.'));};
    request.onblocked=()=>reject(new Error('Offline database upgrade is blocked by another Money Tracker tab.'));
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

export async function pendingOperationCount(expectedIdentity=''){
  const db=await openOfflineDatabase();
  if(!db) return 0;
  const identity=String(expectedIdentity||'').trim();
  const rows=await queuedRows(db);
  return rows.filter(row=>(!identity||row.identity===identity)&&pendingStatus(row.status)).length;
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
        queueRequest.onerror=()=>reject(queueRequest.error||new Error('Could not inspect pending offline changes.'));
        queueRequest.onsuccess=()=>{
          const pending=(queueRequest.result||[]).filter(row=>row.identity===current.identity&&pendingStatus(row.status));
          if(pending.length){
            blockedError=Object.assign(new Error('This device has unsynced changes for another account. Sign back into that account and sync them before switching users.'),{code:'OFFLINE_PENDING_USER_SWITCH'});
            tx.abort();
            return;
          }
          for(const name of OFFLINE_DB.stores) tx.objectStore(name).clear();
          meta.put({key:ACTIVE_USER_KEY,identity,user:cloneValue(user),savedAt:new Date().toISOString(),schemaVersion:OFFLINE_DB.version});
        };
        return;
      }
      meta.put({key:ACTIVE_USER_KEY,identity,user:cloneValue(user),savedAt:new Date().toISOString(),schemaVersion:OFFLINE_DB.version});
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

export async function saveStateSnapshot(state,expectedIdentity=''){
  if(!isLedgerState(state)) return false;
  const identity=String(expectedIdentity||'').trim();
  if(!identity) return false;
  const db=await openOfflineDatabase();
  if(!db) return false;
  const clean=splitState(cloneValue(state));

  return await new Promise((resolve,reject)=>{
    const tx=db.transaction([META_STORE,...LEDGER_STORES],'readwrite');
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
    const tx=db.transaction([META_STORE,...LEDGER_STORES,SYNC_QUEUE_STORE,SYNC_STATE_STORE],'readwrite');
    const meta=tx.objectStore(META_STORE);
    const activeRequest=meta.get(ACTIVE_USER_KEY);
    const headRequest=meta.get(STATE_HEAD_KEY);
    let failure=null;

    const maybeApply=()=>{
      if(activeRequest.readyState!=='done'||headRequest.readyState!=='done') return;
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
      if(entity==='settings'){
        head.head.settings={...(head.head.settings||{}),...(cloneValue(spec.localRecord||spec.payload)||{})};
      }else{
        const storeName=entity==='person'?'people':entity==='account'?'accounts':'entries';
        if(operation==='delete') tx.objectStore(storeName).delete(entityId);
        else if(spec.localRecord?.id) tx.objectStore(storeName).put(cloneValue(spec.localRecord));
      }
      for(const effect of Array.isArray(spec?.extraLedgerRecords)?spec.extraLedgerRecords:[]){
        if(LEDGER_STORES.includes(effect?.store)&&effect?.record?.id) tx.objectStore(effect.store).put(cloneValue(effect.record));
      }
      head.head.version=baseRevision+1;
      meta.put({...head,savedAt:stamp,schemaVersion:OFFLINE_DB.version});
      tx.objectStore(SYNC_QUEUE_STORE).put({
        operationId,identity,entity,entityId,operation,
        payload:cloneValue(spec.payload)||{},
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
    activeRequest.onsuccess=maybeApply;
    headRequest.onsuccess=maybeApply;
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error||new Error('Could not save offline change.'));
    tx.onabort=()=>reject(failure||tx.error||new Error('Saving the offline change was aborted.'));
  });

  return {operationId,state:await loadStateSnapshot()};
}

export async function listQueuedOperations(expectedIdentity=''){
  const db=await openOfflineDatabase();
  if(!db) return [];
  const identity=String(expectedIdentity||'').trim();
  const rows=await queuedRows(db);
  return rows.filter(row=>!identity||row.identity===identity).sort((a,b)=>Number(a.baseRevision)-Number(b.baseRevision)||String(a.createdAt).localeCompare(String(b.createdAt))||String(a.operationId).localeCompare(String(b.operationId))).map(cloneValue);
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

export async function applyPulledChanges(changes,currentRevision,expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim(),revision=Number(currentRevision);
  if(!identity||!Number.isInteger(revision)) return false;
  const db=await openOfflineDatabase();
  if(!db) return false;
  return await new Promise((resolve,reject)=>{
    const tx=db.transaction([META_STORE,...LEDGER_STORES,SYNC_QUEUE_STORE,SYNC_STATE_STORE],'readwrite');
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
        failure=new Error('Cannot apply remote changes while local changes are still queued.');tx.abort();return;
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
        if(operation==='delete') tx.objectStore(storeName).delete(id);
        else if(change?.payload?.id){
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

export async function offlineSnapshotInfo(){
  const db=await openOfflineDatabase();
  if(!db) return {available:false,savedAt:null,version:null,schemaVersion:OFFLINE_DB.version,pending:0};
  const tx=db.transaction([META_STORE,SYNC_QUEUE_STORE],'readonly');
  const done=transactionDone(tx);
  const userRequest=tx.objectStore(META_STORE).get(ACTIVE_USER_KEY);
  const headRequest=tx.objectStore(META_STORE).get(STATE_HEAD_KEY);
  const queueRequest=tx.objectStore(SYNC_QUEUE_STORE).getAll();
  const [user,head,queue]=await Promise.all([requestResult(userRequest),requestResult(headRequest),requestResult(queueRequest)]);
  await done;
  const available=Boolean(user?.identity&&head?.identity===user.identity&&head?.head);
  const pending=(queue||[]).filter(row=>row.identity===user?.identity&&pendingStatus(row.status)).length;
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
    const clearAll=()=>{ for(const name of OFFLINE_DB.stores) tx.objectStore(name).clear(); };
    const checkPendingThenClear=activeIdentity=>{
      if(force){clearAll();return;}
      const queueRequest=tx.objectStore(SYNC_QUEUE_STORE).getAll();
      queueRequest.onerror=()=>reject(queueRequest.error||new Error('Could not inspect pending offline changes.'));
      queueRequest.onsuccess=()=>{
        const pending=(queueRequest.result||[]).filter(row=>(!activeIdentity||row.identity===activeIdentity)&&pendingStatus(row.status));
        if(pending.length){
          blockedError=Object.assign(new Error('Unsynced offline changes are still stored on this device.'),{code:'OFFLINE_PENDING_CHANGES'});
          tx.abort();return;
        }
        clearAll();
      };
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
