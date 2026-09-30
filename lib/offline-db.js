export const OFFLINE_DB = Object.freeze({
  name: 'money-tracker-offline',
  version: 1,
  stores: Object.freeze(['meta','people','accounts','entries','categories','budgets'])
});

const META_STORE='meta';
const DATA_STORES=OFFLINE_DB.stores.filter(name=>name!==META_STORE);
const ACTIVE_USER_KEY='active-user';
const STATE_HEAD_KEY='state-head';

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

let databasePromise=null;

export function openOfflineDatabase(){
  if(!supported()) return Promise.resolve(null);
  if(databasePromise) return databasePromise;
  databasePromise=new Promise((resolve,reject)=>{
    const request=indexedDB.open(OFFLINE_DB.name,OFFLINE_DB.version);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE,{keyPath:'key'});
      for(const name of DATA_STORES){
        if(!db.objectStoreNames.contains(name)) db.createObjectStore(name,{keyPath:'id'});
      }
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

async function clearDataStores(db,{includeMeta=false}={}){
  const names=includeMeta?[...OFFLINE_DB.stores]:DATA_STORES;
  const tx=db.transaction(names,'readwrite');
  for(const name of names) tx.objectStore(name).clear();
  await transactionDone(tx);
}

export async function saveAuthorizedUser(user){
  const identity=userIdentity(user);
  if(!identity) return false;
  const db=await openOfflineDatabase();
  if(!db) return false;
  const current=await requestResult(db.transaction(META_STORE,'readonly').objectStore(META_STORE).get(ACTIVE_USER_KEY)).catch(()=>null);
  if(current?.identity&&current.identity!==identity) await clearOfflineData();
  const activeDb=await openOfflineDatabase();
  if(!activeDb) return false;
  const tx=activeDb.transaction(META_STORE,'readwrite');
  tx.objectStore(META_STORE).put({key:ACTIVE_USER_KEY,identity,user:cloneValue(user),savedAt:new Date().toISOString(),schemaVersion:OFFLINE_DB.version});
  await transactionDone(tx);
  return true;
}

export async function loadAuthorizedUser(){
  const db=await openOfflineDatabase();
  if(!db) return null;
  const record=await requestResult(db.transaction(META_STORE,'readonly').objectStore(META_STORE).get(ACTIVE_USER_KEY));
  return record?.user?cloneValue(record.user):null;
}

export async function saveStateSnapshot(state){
  if(!isLedgerState(state)) return false;
  const db=await openOfflineDatabase();
  if(!db) return false;
  const userRecord=await requestResult(db.transaction(META_STORE,'readonly').objectStore(META_STORE).get(ACTIVE_USER_KEY)).catch(()=>null);
  if(!userRecord?.identity) return false;

  const clean=splitState(cloneValue(state));
  const tx=db.transaction(OFFLINE_DB.stores,'readwrite');
  for(const name of DATA_STORES) tx.objectStore(name).clear();
  for(const row of clean.people) if(row?.id) tx.objectStore('people').put(row);
  for(const row of clean.accounts) if(row?.id) tx.objectStore('accounts').put(row);
  for(const row of clean.entries) if(row?.id) tx.objectStore('entries').put(row);
  for(const row of clean.categories) if(row?.id) tx.objectStore('categories').put(row);
  for(const row of clean.budgets) if(row?.id) tx.objectStore('budgets').put(row);
  tx.objectStore(META_STORE).put({
    key:STATE_HEAD_KEY,
    identity:userRecord.identity,
    head:clean.head,
    savedAt:new Date().toISOString(),
    schemaVersion:OFFLINE_DB.version
  });
  await transactionDone(tx);
  return true;
}

export async function loadStateSnapshot(){
  const db=await openOfflineDatabase();
  if(!db) return null;
  const tx=db.transaction(OFFLINE_DB.stores,'readonly');
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
  await transactionDone(tx);
  if(!userRecord?.identity||!head?.head||head.identity!==userRecord.identity) return null;
  return cloneValue({...head.head,people,accounts,entries,categories,budgets});
}

export async function offlineSnapshotInfo(){
  const db=await openOfflineDatabase();
  if(!db) return {available:false,savedAt:null,version:null,schemaVersion:OFFLINE_DB.version};
  const tx=db.transaction(META_STORE,'readonly');
  const userRequest=tx.objectStore(META_STORE).get(ACTIVE_USER_KEY);
  const headRequest=tx.objectStore(META_STORE).get(STATE_HEAD_KEY);
  const [user,head]=await Promise.all([requestResult(userRequest),requestResult(headRequest)]);
  await transactionDone(tx);
  const available=Boolean(user?.identity&&head?.identity===user.identity&&head?.head);
  return {available,savedAt:available?head.savedAt:null,version:available?Number(head.head.version)||null:null,schemaVersion:OFFLINE_DB.version};
}

export async function clearOfflineData(){
  const db=await openOfflineDatabase();
  if(!db) return false;
  await clearDataStores(db,{includeMeta:true});
  return true;
}
