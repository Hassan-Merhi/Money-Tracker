export const OFFLINE_DB = Object.freeze({
  name: 'money-tracker-offline',
  version: 3,
  stores: Object.freeze(['meta','people','accounts','entries','categories','budgets','syncQueue','syncState','tombstones','attachments','attachmentQueue'])
});

const META_STORE='meta';
const LEDGER_STORES=['people','accounts','entries','categories','budgets'];
const SYNC_QUEUE_STORE='syncQueue';
const SYNC_STATE_STORE='syncState';
const TOMBSTONE_STORE='tombstones';
const ATTACHMENT_STORE='attachments';
const ATTACHMENT_QUEUE_STORE='attachmentQueue';
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
      if(!db.objectStoreNames.contains(TOMBSTONE_STORE)) db.createObjectStore(TOMBSTONE_STORE,{keyPath:'key'});
      if(!db.objectStoreNames.contains(ATTACHMENT_STORE)) db.createObjectStore(ATTACHMENT_STORE,{keyPath:'id'});
      if(!db.objectStoreNames.contains(ATTACHMENT_QUEUE_STORE)) db.createObjectStore(ATTACHMENT_QUEUE_STORE,{keyPath:'operationId'});
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
async function attachmentQueuedRows(db){
  return await requestResult(db.transaction(ATTACHMENT_QUEUE_STORE,'readonly').objectStore(ATTACHMENT_QUEUE_STORE).getAll());
}

export async function pendingOperationCount(expectedIdentity=''){
  const db=await openOfflineDatabase();
  if(!db) return 0;
  const identity=String(expectedIdentity||'').trim();
  const [rows,attachmentRows]=await Promise.all([queuedRows(db),attachmentQueuedRows(db)]);
  return [...rows,...attachmentRows].filter(row=>(!identity||row.identity===identity)&&pendingStatus(row.status)).length;
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
        const inspect=()=>{
          if(queueRequest.readyState!=='done'||attachmentQueueRequest.readyState!=='done')return;
          const pending=[...(queueRequest.result||[]),...(attachmentQueueRequest.result||[])].filter(row=>row.identity===current.identity&&pendingStatus(row.status));
          if(pending.length){
            blockedError=Object.assign(new Error('This device has unsynced changes for another account. Sign back into that account and sync them before switching users.'),{code:'OFFLINE_PENDING_USER_SWITCH'});
            tx.abort();
            return;
          }
          for(const name of OFFLINE_DB.stores) tx.objectStore(name).clear();
          meta.put({key:ACTIVE_USER_KEY,identity,user:cloneValue(user),savedAt:new Date().toISOString(),schemaVersion:OFFLINE_DB.version});
        };
        queueRequest.onerror=()=>reject(queueRequest.error||new Error('Could not inspect pending offline changes.'));
        attachmentQueueRequest.onerror=()=>reject(attachmentQueueRequest.error||new Error('Could not inspect pending offline attachments.'));
        queueRequest.onsuccess=inspect;
        attachmentQueueRequest.onsuccess=inspect;
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
    const tx=db.transaction([META_STORE,...LEDGER_STORES,TOMBSTONE_STORE],'readwrite');
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
  for(const original of rows){
    if(dropped.has(original.operationId))continue;
    const row=cloneValue(original);
    row.baseRevision=revision;
    row.baseRecord=ledgerRecord(projected,row.entity,row.entityId);
    if(row.operationId===targetId&&strategy==='keep_mine'){
      row.status='pending';row.lastError='';delete row.conflict;
    }else if(row.status==='conflict'&&row.operationId!==targetId){
      // Preserve unrelated explicit conflicts. They still block until the user resolves them.
    }else if(row.status!=='failed'){
      row.status='pending';row.lastError='';delete row.conflict;
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
        status:'pending'
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
      const pendingCreate=(queueRequest.result||[]).find(row=>row.identity===identity&&row.attachmentId===id&&row.operation==='create');
      if(!attachment.synced&&pendingCreate){
        cancelledCreate=true;
        queueStore.delete(pendingCreate.operationId);
        tx.objectStore(ATTACHMENT_STORE).delete(id);
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
  return {operationId:cancelledCreate?null:operationId,cancelledCreate};
}

export async function listAttachmentQueue(expectedIdentity=''){
  const identity=String(expectedIdentity||'').trim();
  const db=await openOfflineDatabase();
  if(!db)return [];
  const rows=await requestResult(db.transaction(ATTACHMENT_QUEUE_STORE,'readonly').objectStore(ATTACHMENT_QUEUE_STORE).getAll());
  return rows.filter(row=>!identity||row.identity===identity).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))||String(a.operationId).localeCompare(String(b.operationId))).map(cloneValue);
}

export async function updateAttachmentQueue(operationId,patch={}){
  const db=await openOfflineDatabase();if(!db)return false;
  const tx=db.transaction(ATTACHMENT_QUEUE_STORE,'readwrite'),store=tx.objectStore(ATTACHMENT_QUEUE_STORE);
  const row=await requestResult(store.get(operationId));if(!row){await transactionDone(tx);return false;}
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
  const tx=db.transaction([META_STORE,SYNC_QUEUE_STORE,ATTACHMENT_QUEUE_STORE],'readonly');
  const done=transactionDone(tx);
  const userRequest=tx.objectStore(META_STORE).get(ACTIVE_USER_KEY);
  const headRequest=tx.objectStore(META_STORE).get(STATE_HEAD_KEY);
  const queueRequest=tx.objectStore(SYNC_QUEUE_STORE).getAll();
  const attachmentQueueRequest=tx.objectStore(ATTACHMENT_QUEUE_STORE).getAll();
  const [user,head,queue,attachmentQueue]=await Promise.all([requestResult(userRequest),requestResult(headRequest),requestResult(queueRequest),requestResult(attachmentQueueRequest)]);
  await done;
  const available=Boolean(user?.identity&&head?.identity===user.identity&&head?.head);
  const pending=[...(queue||[]),...(attachmentQueue||[])].filter(row=>row.identity===user?.identity&&pendingStatus(row.status)).length;
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
      const attachmentQueueRequest=tx.objectStore(ATTACHMENT_QUEUE_STORE).getAll();
      const inspect=()=>{
        if(queueRequest.readyState!=='done'||attachmentQueueRequest.readyState!=='done')return;
        const pending=[...(queueRequest.result||[]),...(attachmentQueueRequest.result||[])].filter(row=>(!activeIdentity||row.identity===activeIdentity)&&pendingStatus(row.status));
        if(pending.length){
          blockedError=Object.assign(new Error('Unsynced offline changes are still stored on this device.'),{code:'OFFLINE_PENDING_CHANGES'});
          tx.abort();return;
        }
        clearAll();
      };
      queueRequest.onerror=()=>reject(queueRequest.error||new Error('Could not inspect pending offline changes.'));
      attachmentQueueRequest.onerror=()=>reject(attachmentQueueRequest.error||new Error('Could not inspect pending offline attachments.'));
      queueRequest.onsuccess=inspect;
      attachmentQueueRequest.onsuccess=inspect;
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
