import { applyPulledChanges, cacheAttachmentList, clearOfflineData, discardAttachmentQueue, discardQueuedOperations, enqueueLocalMutation, getLastServerRevision, getOfflineAttachment, isLedgerState, listAttachmentQueue, listOfflineAttachments, listQueuedOperations, loadAuthorizedUser, loadStateSnapshot, markOfflineAttachmentSynced, markSyncSuccess, offlineAccessInfo, pendingOperationCount, pruneAttachmentQueueForMissingEntries, queueOfflineAttachmentCreate, queueOfflineAttachmentDelete, queuedBaseRecord, queuedRecoveryBundle, rebaseQueuedOperations, removeAttachmentQueue, removeOfflineAttachment, removeQueuedOperation, retryFailedQueuedOperations, saveAuthorizedUser, saveStateSnapshot, setLastServerRevision, syncRuntimeInfo, updateAttachmentQueue, updateQueuedOperation, discardBankFeedQueue, enqueueBankFeedOperation, listBankFeedQueue, loadBankFeedSnapshot, removeBankFeedQueue, saveBankFeedSnapshot, updateBankFeedQueue } from './offline-db.js';
export const initialState = {
  version: 1,
  settings: { defaultCurrency: 'USD', displayName: 'My Ledger' },
  people: [], accounts: [], entries: []
};
let csrfToken = '';
let authenticatedIdentity = '';

function userIdentity(user){ return String(user?.id||user?.email||'').trim(); }
function browserOnline(){ return typeof navigator==='undefined'||navigator.onLine!==false; }
async function localSnapshot(expectedIdentity=authenticatedIdentity){
  try{
    const [snapshot,cachedUser]=await Promise.all([loadStateSnapshot(),loadAuthorizedUser()]);
    if(expectedIdentity&&userIdentity(cachedUser)!==expectedIdentity)return null;
    return snapshot;
  }catch{return null;}
}
function cloneLocal(value){
  if(typeof structuredClone==='function')return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
function projectLocalMutation(snapshot,spec){
  const next=cloneLocal(snapshot);
  if(spec.entity==='settings'){
    next.settings={...(next.settings||{}),...(cloneLocal(spec.localRecord||spec.payload)||{})};
  }else{
    const listName=spec.entity==='person'?'people':spec.entity==='account'?'accounts':'entries';
    const rows=Array.isArray(next[listName])?next[listName]:[];
    if(spec.operation==='delete')next[listName]=rows.filter(row=>row.id!==spec.entityId);
    else if(spec.localRecord?.id){
      const record=cloneLocal(spec.localRecord),index=rows.findIndex(row=>row.id===record.id);
      if(index>=0){const copy=rows.slice();copy[index]=record;next[listName]=copy;}
      else next[listName]=[...rows,record];
    }
  }
  for(const effect of Array.isArray(spec.extraLedgerRecords)?spec.extraLedgerRecords:[]){
    if(!['people','accounts','entries','categories','budgets'].includes(effect?.store)||!effect?.record?.id)continue;
    const rows=Array.isArray(next[effect.store])?next[effect.store]:[];
    const record=cloneLocal(effect.record),index=rows.findIndex(row=>row.id===record.id);
    if(index>=0){const copy=rows.slice();copy[index]=record;next[effect.store]=copy;}
    else next[effect.store]=[...rows,record];
  }
  next.version=Number(snapshot.version)+1;
  return next;
}

function canonicalConflictValue(value){
  if(Array.isArray(value))return value.map(canonicalConflictValue);
  if(!value||typeof value!=='object')return value;
  const out={};
  for(const key of Object.keys(value).sort()){
    if(key==='attachmentCount'||key==='attachments'||key==='updatedAt')continue;
    out[key]=canonicalConflictValue(value[key]);
  }
  return out;
}
function sameConflictRecord(a,b){
  return JSON.stringify(canonicalConflictValue(a))===JSON.stringify(canonicalConflictValue(b));
}

function emitSyncStatus(detail={}){
  if(typeof window==='undefined')return;
  window.dispatchEvent(new CustomEvent('moneytracker:sync',{detail}));
}
export async function getSyncStatus(){
  const identity=authenticatedIdentity||userIdentity(await loadAuthorizedUser().catch(()=>null));
  const [queue,attachmentQueue,bankFeedQueue,runtime,offlineAccess]=identity?await Promise.all([
    listQueuedOperations(identity).catch(()=>[]),
    listAttachmentQueue(identity).catch(()=>[]),
    listBankFeedQueue(identity).catch(()=>[]),
    syncRuntimeInfo(identity).catch(()=>({lastSyncedAt:null,lastSyncSource:'',serverRevision:null})),
    offlineAccessInfo().catch(()=>({available:false,valid:false,expiresAt:null,remainingMs:0}))
  ]):[[],[],[],{lastSyncedAt:null,lastSyncSource:'',serverRevision:null},{available:false,valid:false,expiresAt:null,remainingMs:0}];
  const all=[...queue,...attachmentQueue,...bankFeedQueue];
  return {
    pending:all.filter(row=>['pending','failed','conflict'].includes(row.status)).length,
    failed:all.filter(row=>row.status==='failed').length,
    conflicts:[...queue,...bankFeedQueue].filter(row=>row.status==='conflict').length,
    attempts:all.reduce((sum,row)=>sum+Number(row.attempts||0),0),
    online:browserOnline(),
    lastSyncedAt:runtime.lastSyncedAt,
    lastSyncSource:runtime.lastSyncSource,
    serverRevision:runtime.serverRevision,
    offlineAccess,
    queue,
    attachmentQueue,
    bankFeedQueue
  };
}
async function publishSyncStatus(extra={}){
  const status=await getSyncStatus();
  const state=await loadStateSnapshot().catch(()=>null);
  emitSyncStatus({...status,...extra,state});
  return status;
}
async function adoptAuthenticatedUser(data){
  const nextIdentity=userIdentity(data?.user);
  const previousIdentity=authenticatedIdentity,previousCsrf=csrfToken;
  try{
    if(data?.user)await saveAuthorizedUser(data.user);
  }catch(error){
    if(error?.code==='OFFLINE_PENDING_USER_SWITCH'){
      authenticatedIdentity=nextIdentity;csrfToken=data?.csrfToken||'';
      try{await api('/api/auth/logout',{method:'POST',body:'{}'});}catch{}
      authenticatedIdentity=previousIdentity;csrfToken=previousCsrf;
      throw error;
    }
  }
  authenticatedIdentity=nextIdentity;csrfToken=data?.csrfToken||'';
  return data?.user||null;
}
function unauthenticatedAuthPath(path){ return ['/api/auth/login','/api/auth/register','/api/auth/status'].includes(path); }

async function api(path, options={}) {
  const requestIdentity=authenticatedIdentity;
  const headers = { 'Accept':'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers||{}) };
  if (options.method && !['GET','HEAD'].includes(options.method)) headers['X-CSRF-Token'] = csrfToken;
  let res;
  try{res=await fetch(path,{...options,headers,credentials:'same-origin'});}
  catch(error){
    const offline=new Error(browserOnline()?'Could not reach Money Tracker. Try again.':'You are offline. This server feature needs a connection.');
    offline.offline=true;throw offline;
  }
  const data = await res.json().catch(()=>({}));
  if (!res.ok) {
    if(res.status===401&&requestIdentity&&!unauthenticatedAuthPath(path)){
      const pending=await pendingOperationCount(requestIdentity).catch(()=>0);
      if(!pending)await clearOfflineData(requestIdentity).catch(()=>{});
      else await publishSyncStatus({authRequired:true}).catch(()=>{});
      if(authenticatedIdentity===requestIdentity){authenticatedIdentity='';csrfToken='';}
    }
    const err=new Error(data.error||`Request failed (${res.status})`); err.status=res.status; err.payload=data; throw err;
  }
  if (isLedgerState(data)&&requestIdentity) {
    const pending=await pendingOperationCount(requestIdentity).catch(()=>0);
    if(!pending){
      await saveStateSnapshot(data,requestIdentity).catch(()=>{});
      await setLastServerRevision(requestIdentity,Number(data.version)).catch(()=>{});
    }
  }
  return data;
}

export async function currentUser() {
  const cachedBefore=await loadAuthorizedUser().catch(()=>null);
  const cachedIdentity=userIdentity(cachedBefore);
  try {
    const data=await api('/api/auth/me');
    return await adoptAuthenticatedUser(data);
  } catch (e) {
    if(e.status===401){
      const pending=cachedIdentity?await pendingOperationCount(cachedIdentity).catch(()=>0):0;
      if(cachedIdentity&&!pending) await clearOfflineData(cachedIdentity).catch(()=>{});
      authenticatedIdentity='';csrfToken='';
      return null;
    }
    if(e.offline&&cachedBefore){
      const access=await offlineAccessInfo().catch(()=>({valid:false,expiresAt:null}));
      if(!access.valid){
        authenticatedIdentity='';csrfToken='';
        const expired=new Error('Offline access needs an online sign-in check. Reconnect once to verify this device, then offline access will be available again.');
        expired.offline=true;expired.code='OFFLINE_AUTH_EXPIRED';expired.expiresAt=access.expiresAt||null;
        throw expired;
      }
      authenticatedIdentity=cachedIdentity;
      await publishSyncStatus({offlineAccess:true}).catch(()=>{});
      return cachedBefore;
    }
    throw e;
  }
}
export async function registrationStatus(){ return await api('/api/auth/status'); }
export async function login(email,password){ const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email,password})});return await adoptAuthenticatedUser(d); }
export async function register(email,password){ const d=await api('/api/auth/register',{method:'POST',body:JSON.stringify({email,password})});return await adoptAuthenticatedUser(d); }
export async function listUsers(){ return await api('/api/users'); }
export async function createUserAccount(email,password){ return await api('/api/users',{method:'POST',body:JSON.stringify({email,password})}); }
export async function resetUserPassword(id,password,currentPassword){ return await api('/api/users/'+encodeURIComponent(id)+'/password',{method:'POST',body:JSON.stringify({password,currentPassword})}); }
export async function deleteUserAccount(id,currentPassword,confirmation='DELETE'){ return await api('/api/users/'+encodeURIComponent(id),{method:'DELETE',body:JSON.stringify({currentPassword,confirmation})}); }
export async function changePassword(currentPassword,newPassword){ return await api('/api/auth/password',{method:'POST',body:JSON.stringify({currentPassword,newPassword})}); }
export async function revokeOtherSessions(){ return await api('/api/auth/sessions/revoke-others',{method:'POST',body:'{}'}); }
export async function listSessions(){ return await api('/api/auth/sessions'); }
export async function revokeSession(id){ return await api('/api/auth/sessions/'+encodeURIComponent(id),{method:'DELETE',body:'{}'}); }
export async function listSecurityEvents(){ return await api('/api/security/events'); }
export async function runtimeStatus(){ return await api('/api/ops/status'); }
export async function createServerSnapshot(){ return await api('/api/ops/snapshot',{method:'POST',body:'{}'}); }
export async function deleteMyAccount(password,confirmation){
  const identity=authenticatedIdentity;
  if(identity&&await pendingOperationCount(identity).catch(()=>0))throw new Error('Sync or discard the offline changes on this device before deleting the account.');
  const result=await api('/api/account',{method:'DELETE',body:JSON.stringify({password,confirmation})});
  csrfToken='';authenticatedIdentity='';
  if(identity) await clearOfflineData(identity,{force:true}).catch(()=>{});
  return result;
}
export async function logout(){
  const identity=authenticatedIdentity;
  if(identity&&await pendingOperationCount(identity).catch(()=>0))throw new Error('You have unsynced offline changes. Reconnect and sync them before signing out.');
  try {
    await api('/api/auth/logout',{method:'POST',body:'{}'});
  } catch(error) {
    if(error.status!==401) throw error;
  }
  csrfToken='';authenticatedIdentity='';
  if(identity) await clearOfflineData(identity,{force:true}).catch(()=>{});
}
async function syncAttachmentOperations(identity){
  await pruneAttachmentQueueForMissingEntries(identity).catch(()=>{});
  let queue=await listAttachmentQueue(identity);
  const blocker=queue.find(row=>row.status==='failed');
  if(blocker)return {lastError:blocker.lastError||'An attachment needs attention.'};

  for(const operation of queue){
    if(operation.status!=='pending')continue;
    const claimed=await updateAttachmentQueue(operation.operationId,{attempts:Number(operation.attempts||0)+1,lastError:''});
    if(!claimed)continue;
    const finalIntent=(await listAttachmentQueue(identity)).find(row=>row.attachmentId===operation.attachmentId);
    if(!finalIntent||finalIntent.operationId!==operation.operationId||finalIntent.operation!==operation.operation)continue;
    try{
      const result=await api('/api/sync/attachments',{method:'POST',body:JSON.stringify({operation})});
      if(operation.operation==='create')await markOfflineAttachmentSynced(operation.attachmentId,result.attachment||{},identity);
      else await removeOfflineAttachment(operation.attachmentId);
      await removeAttachmentQueue(operation.operationId);
    }catch(error){
      if(error.status===401){
        await updateAttachmentQueue(operation.operationId,{status:'pending',lastError:'Sign in again to resume attachment sync.'}).catch(()=>{});
        await publishSyncStatus({authRequired:true,lastError:'Sign in again to resume attachment sync.'}).catch(()=>{});
        throw error;
      }
      if(error.offline){
        await updateAttachmentQueue(operation.operationId,{status:'pending',lastError:error.message||'Connection lost during attachment sync.'}).catch(()=>{});
        return {lastError:error.message||'Attachment sync paused.'};
      }
      await updateAttachmentQueue(operation.operationId,{status:'failed',lastError:error.message||'The server rejected this attachment.'}).catch(()=>{});
      return {lastError:error.message||'Attachment sync paused.'};
    }
  }
  return {};
}

async function syncBankFeedOperations(identity){
  let queue=await listBankFeedQueue(identity);
  const blocker=queue.find(row=>row.status==='failed'||row.status==='conflict');
  if(blocker)return {lastError:blocker.lastError||'A Bank Feed change needs attention.'};
  let ledgerChanged=false;
  for(const original of queue){
    if(original.status!=='pending')continue;
    let operation=original;
    await updateBankFeedQueue(operation.operationId,{attempts:Number(operation.attempts||0)+1,lastError:''});
    const push=async op=>await api('/api/sync/bank-feed',{method:'POST',body:JSON.stringify({operation:op})});
    try{
      let result;
      try{result=await push(operation);}
      catch(error){
        if(error.status===409&&['post','undo'].includes(operation.action)&&!operation.rebasedOnce){
          const [freshState,freshFeed]=await Promise.all([api('/api/state'),api('/api/bank-feed?limit=500&offset=0')]);
          const item=(freshFeed.items||[]).find(row=>row.id===operation.itemId);
          const compatible=operation.action==='post'?item?.status==='pending':item?.status==='posted';
          if(compatible){
            operation={...operation,payload:{...(operation.payload||{}),expectedRevision:Number(freshState.version)},rebasedOnce:true};
            await updateBankFeedQueue(operation.operationId,{payload:operation.payload,rebasedOnce:true,lastError:''});
            result=await push(operation);
          }else throw error;
        }else throw error;
      }
      if(['post','undo'].includes(operation.action))ledgerChanged=true;
      await removeBankFeedQueue(operation.operationId);
    }catch(error){
      if(error.status===401){
        await updateBankFeedQueue(operation.operationId,{status:'pending',lastError:'Sign in again to resume Bank Feed sync.'}).catch(()=>{});
        await publishSyncStatus({authRequired:true,lastError:'Sign in again to resume Bank Feed sync.'}).catch(()=>{});
        throw error;
      }
      if(error.offline){
        await updateBankFeedQueue(operation.operationId,{status:'pending',lastError:error.message||'Connection lost during Bank Feed sync.'}).catch(()=>{});
        return {lastError:error.message||'Bank Feed sync paused.'};
      }
      await updateBankFeedQueue(operation.operationId,{status:error.status===409?'conflict':'failed',lastError:error.message||'The server rejected this Bank Feed change.'}).catch(()=>{});
      return {lastError:error.message||'Bank Feed sync paused.'};
    }
  }
  try{
    const fresh=await api('/api/bank-feed?limit=500&offset=0');
    await saveBankFeedSnapshot(fresh,identity);
  }catch{}
  return {ledgerChanged};
}

async function recordLedgerConflict(operation,error,identity){
  let fresh=null,serverRecord=null;
  try{
    fresh=await api('/api/state');
    serverRecord=queuedBaseRecord(fresh,operation.entity,operation.entityId);
  }catch{}
  await updateQueuedOperation(operation.operationId,{
    status:'conflict',
    lastError:error.message||'This change conflicts with newer server data.',
    conflict:{
      serverRevision:Number(fresh?.version)||null,
      baseRecord:cloneLocal(operation.baseRecord??null),
      localRecord:cloneLocal(operation.localRecord??operation.payload??null),
      serverRecord:cloneLocal(serverRecord),
      detectedAt:new Date().toISOString()
    }
  }).catch(()=>{});
}

let syncInFlight=null;

async function syncPendingOperationsImpl({rebaseDepth=0,source='foreground'}={}){
  const identity=authenticatedIdentity;
  if(!identity)return await publishSyncStatus({authRequired:true});
  if(!browserOnline()){
    await publishSyncStatus();
    return await getSyncStatus();
  }

  let queue=await listQueuedOperations(identity);
  let reopenedFeedItems=0;
  for(const operation of queue){
    if(operation.status==='failed'||operation.status==='conflict'){
      await publishSyncStatus({lastError:operation.lastError||'A queued change needs attention.'});
      return await getSyncStatus();
    }
    if(operation.status!=='pending')continue;
    await updateQueuedOperation(operation.operationId,{attempts:Number(operation.attempts||0)+1,lastError:''});
    try{
      const pushed=await api('/api/sync/push',{method:'POST',body:JSON.stringify({operation})});
      reopenedFeedItems+=Number(pushed?.reopenedFeedItems||0);
      await removeQueuedOperation(operation.operationId);
    }catch(error){
      if(error.status===401){
        await updateQueuedOperation(operation.operationId,{status:'pending',lastError:'Sign in again to resume sync.'}).catch(()=>{});
        await publishSyncStatus({authRequired:true,lastError:'Sign in again to resume sync.'}).catch(()=>{});
        throw error;
      }
      if(error.offline){
        await updateQueuedOperation(operation.operationId,{status:'pending',lastError:error.message||'Connection lost during sync.'}).catch(()=>{});
        await publishSyncStatus({lastError:error.message||'Sync paused.'}).catch(()=>{});
        return await getSyncStatus();
      }
      if(error.status===409&&rebaseDepth<2){
        try{
          const fresh=await api('/api/state');
          const serverRecord=queuedBaseRecord(fresh,operation.entity,operation.entityId);
          if(operation.operation==='delete'&&serverRecord==null){
            await rebaseQueuedOperations(fresh,identity,{operationId:operation.operationId,strategy:'keep_server'});
            await publishSyncStatus({rebased:true,deleteAlreadyApplied:true});
            return await syncPendingOperationsImpl({rebaseDepth:rebaseDepth+1,source});
          }
          if(/changed before the offline change could sync/i.test(error.message||'')){
            await rebaseQueuedOperations(fresh,identity);
            await publishSyncStatus({rebased:true});
            return await syncPendingOperationsImpl({rebaseDepth:rebaseDepth+1,source});
          }
        }catch{}
      }
      if(error.status===409){
        await recordLedgerConflict(operation,error,identity);
      }else{
        await updateQueuedOperation(operation.operationId,{status:'failed',lastError:error.message||'The server rejected this offline change.'}).catch(()=>{});
      }
      await publishSyncStatus({lastError:error.message||'Sync paused.'}).catch(()=>{});
      return await getSyncStatus();
    }
  }

  queue=await listQueuedOperations(identity);
  if(queue.some(row=>['pending','failed','conflict'].includes(row.status))){
    await publishSyncStatus();
    return await getSyncStatus();
  }

  const bankFeedResult=await syncBankFeedOperations(identity);
  if(bankFeedResult.lastError){
    await publishSyncStatus({lastError:bankFeedResult.lastError});
    return await getSyncStatus();
  }

  let since=await getLastServerRevision(identity);
  if(since===null){
    const snapshot=await localSnapshot();
    since=Number(snapshot?.version)||0;
  }
  const pulled=await api('/api/sync/pull?sinceRevision='+encodeURIComponent(String(since)));
  if(pulled.requiresFullRefresh){
    const fresh=await api('/api/state');
    await saveStateSnapshot(fresh,identity);
    await setLastServerRevision(identity,Number(fresh.version));
  }else{
    await applyPulledChanges(pulled.changes||[],Number(pulled.currentRevision),identity);
  }

  const attachmentResult=await syncAttachmentOperations(identity);
  const remaining=await pendingOperationCount(identity).catch(()=>0);
  const fullySynced=!attachmentResult.lastError&&!bankFeedResult.lastError&&remaining===0;
  if(fullySynced){
    const finalRevision=await getLastServerRevision(identity).catch(()=>null);
    await markSyncSuccess(identity,{serverRevision:finalRevision,source}).catch(()=>{});
  }
  await publishSyncStatus({synced:fullySynced,reopenedFeedItems,lastError:attachmentResult.lastError||''});
  return {...await getSyncStatus(),reopenedFeedItems,synced:fullySynced};
}

export async function syncPendingOperations(options={}){
  if(syncInFlight)return await syncInFlight;
  syncInFlight=syncPendingOperationsImpl(options);
  try{return await syncInFlight;}finally{syncInFlight=null;}
}

export async function retryFailedSyncOperations(){
  const identity=authenticatedIdentity;
  if(!identity)throw new Error('Sign in before retrying sync.');
  const reset=await retryFailedQueuedOperations(identity);
  await publishSyncStatus({retryRequested:reset});
  if(browserOnline()&&reset)return await syncPendingOperations({source:'retry'});
  return {...await getSyncStatus(),retryRequested:reset};
}

export async function exportPendingSyncRecovery(){
  const identity=authenticatedIdentity||userIdentity(await loadAuthorizedUser().catch(()=>null));
  if(!identity)throw new Error('No offline account is available on this device.');
  const [bundle,snapshot,access,runtime]=await Promise.all([
    queuedRecoveryBundle(identity),
    loadStateSnapshot().catch(()=>null),
    offlineAccessInfo().catch(()=>null),
    syncRuntimeInfo(identity).catch(()=>null)
  ]);
  return {
    app:'money-owed-tracker',
    recoveryVersion:1,
    generatedAt:new Date().toISOString(),
    schema:'offline-block-d',
    identity,
    offlineAccess:access?{verifiedAt:access.verifiedAt,expiresAt:access.expiresAt,valid:access.valid}:null,
    syncRuntime:runtime,
    snapshot,
    queue:bundle.queue,
    attachmentQueue:bundle.attachmentQueue,
    bankFeedQueue:bundle.bankFeedQueue,
    tombstones:bundle.tombstones
  };
}

export async function getOfflineSecurityStatus(){
  return await offlineAccessInfo();
}

export async function resolveSyncConflict(operationId,strategy){
  const identity=authenticatedIdentity;
  if(!identity)throw new Error('Sign in before resolving conflicts.');
  if(!browserOnline())throw new Error('Reconnect before resolving a sync conflict.');
  if(!['keep_mine','keep_server'].includes(strategy))throw new Error('Choose whether to keep your change or use the server version.');
  const queued=(await listQueuedOperations(identity)).find(row=>row.operationId===operationId);
  if(!queued)throw new Error('That queued change no longer exists.');
  const serverDeleted=['update','delete'].includes(queued.operation)&&queued.conflict?.baseRecord!=null&&queued.conflict?.serverRecord==null;
  if(strategy==='keep_mine'&&(queued.operation==='create'||serverDeleted)){
    throw new Error(serverDeleted?'This record was deleted on another device. Use the server version, then recreate it as a new record if needed.':'This new record conflicts with an existing or previously deleted UUID. Use the server version and create a new record instead.');
  }
  const fresh=await api('/api/state');
  const result=await rebaseQueuedOperations(fresh,identity,{operationId,strategy});
  await pruneAttachmentQueueForMissingEntries(identity).catch(()=>{});
  await publishSyncStatus({conflictResolved:true,resolution:strategy,state:result.state});
  return await syncPendingOperations();
}

export async function discardPendingChangesAndReload(){
  const identity=authenticatedIdentity;
  if(!identity)throw new Error('Sign in first.');
  if(!browserOnline())throw new Error('Reconnect before reloading the server copy.');
  const fresh=await api('/api/state');
  await discardQueuedOperations(identity);
  await discardAttachmentQueue(identity);
  await discardBankFeedQueue(identity,{clearCache:true});
  await saveStateSnapshot(fresh,identity);
  await setLastServerRevision(identity,Number(fresh.version));
  await publishSyncStatus({discarded:true});
  return fresh;
}

async function directCoreMutation(spec,expectedRevision){
  const encoded=encodeURIComponent(spec.entityId||'');
  let path='',method='';
  if(spec.entity==='settings'){path='/api/settings';method='PUT';}
  else if(spec.entity==='person'){path=spec.operation==='create'?'/api/people':'/api/people/'+encoded;method=spec.operation==='create'?'POST':spec.operation==='update'?'PUT':'DELETE';}
  else if(spec.entity==='account'){path=spec.operation==='create'?'/api/accounts':'/api/accounts/'+encoded;method=spec.operation==='create'?'POST':spec.operation==='update'?'PUT':'DELETE';}
  else if(spec.entity==='entry'){path=spec.operation==='create'?'/api/entries':'/api/entries/'+encoded;method=spec.operation==='create'?'POST':spec.operation==='update'?'PUT':'DELETE';}
  else throw new Error('Unsupported ledger mutation.');
  return await api(path,{method,body:JSON.stringify({...spec.payload,expectedRevision})});
}

async function queueCoreMutation(spec,expectedRevision){
  const identity=authenticatedIdentity;
  if(!identity)throw new Error('Sign in before saving changes.');
  const snapshot=await localSnapshot();
  if(!snapshot){
    if(browserOnline())return await directCoreMutation(spec,expectedRevision);
    throw new Error('Offline storage is not ready yet. Reload while connected once and try again.');
  }
  const optimistic=projectLocalMutation(snapshot,spec);
  let queued;
  try{
    queued=await enqueueLocalMutation({...spec,expectedRevision},identity);
  }catch(error){
    if(browserOnline()&&error?.status!==409)return await directCoreMutation(spec,expectedRevision);
    throw error;
  }
  await publishSyncStatus({queued:true});
  const syncResult=browserOnline()?await syncPendingOperations():null;
  const next=await localSnapshot()||queued.state||optimistic;
  return syncResult?.reopenedFeedItems?{...next,reopenedFeedItems:syncResult.reopenedFeedItems}:next;
}

export async function loadState(){
  const identity=authenticatedIdentity;
  const pending=identity?await pendingOperationCount(identity).catch(()=>0):0;
  if(browserOnline()&&pending){
    await syncPendingOperations().catch(()=>{});
    const local=await loadStateSnapshot().catch(()=>null);
    if(local)return local;
  }
  if(browserOnline()) return await api('/api/state');
  const cached=await loadStateSnapshot().catch(()=>null);
  if(cached) return cached;
  const missing=new Error('You are offline and this device does not have a saved ledger yet. Reconnect once to make your ledger available offline.');
  missing.offline=true;
  throw missing;
}

export async function updateSettings(settings,expectedRevision){
  const snapshot=await localSnapshot();
  const localRecord={...(snapshot?.settings||{}),...settings};
  return await queueCoreMutation({entity:'settings',entityId:'settings',operation:'update',payload:settings,localRecord},expectedRevision);
}
export async function createPerson(person,expectedRevision){
  const snapshot=await localSnapshot(),stamp=new Date().toISOString();
  const opening=Number(person.openingBalance??person.opening??0);
  const payload=opening>0&&!person.openingEntryId?{...person,openingEntryId:uid('entry')}:{...person};
  const localRecord={id:payload.id,name:String(payload.name||''),note:String(payload.note||''),createdAt:payload.createdAt||stamp};
  const extraLedgerRecords=[];
  if(opening>0){
    const currency=String(payload.currency||snapshot?.settings?.defaultCurrency||'USD').toUpperCase();
    const signedAmount=(payload.direction==='i_owe'?-1:1)*opening;
    extraLedgerRecords.push({store:'entries',record:{
      id:payload.openingEntryId,type:'person_adjustment',personId:payload.id,accountId:null,
      fromAccountId:null,toAccountId:null,amount:opening,currency,fromAmount:null,toAmount:null,signedAmount,
      date:payload.openingDate||new Date().toISOString().slice(0,10),merchant:'',description:'Opening balance',
      categoryId:null,splits:[],attachmentCount:0,attachments:[],createdAt:stamp,updatedAt:stamp
    }});
  }
  return await queueCoreMutation({entity:'person',entityId:payload.id,operation:'create',payload,localRecord,extraLedgerRecords},expectedRevision);
}
export async function updatePerson(id,person,expectedRevision){
  const snapshot=await localSnapshot(),existing=snapshot?.people?.find(row=>row.id===id);
  if(snapshot&&!existing)throw new Error('Person not found.');
  return await queueCoreMutation({entity:'person',entityId:id,operation:'update',payload:{...person,id},localRecord:existing?{...existing,...person,id}:null},expectedRevision);
}
export async function removePerson(id,expectedRevision){ return await queueCoreMutation({entity:'person',entityId:id,operation:'delete',payload:{id}},expectedRevision); }
export async function createAccount(account,expectedRevision){
  const localRecord={...account,createdAt:account.createdAt||new Date().toISOString()};
  return await queueCoreMutation({entity:'account',entityId:account.id,operation:'create',payload:account,localRecord},expectedRevision);
}
export async function updateAccount(id,account,expectedRevision){
  const snapshot=await localSnapshot(),existing=snapshot?.accounts?.find(row=>row.id===id);
  if(snapshot&&!existing)throw new Error('Account not found.');
  return await queueCoreMutation({entity:'account',entityId:id,operation:'update',payload:{...account,id},localRecord:existing?{...existing,...account,id,currency:existing.currency}:null},expectedRevision);
}
export async function removeAccount(id,expectedRevision){ return await queueCoreMutation({entity:'account',entityId:id,operation:'delete',payload:{id}},expectedRevision); }
export async function createEntry(entry,expectedRevision){
  const stamp=new Date().toISOString(),localRecord={...entry,createdAt:entry.createdAt||stamp,updatedAt:stamp};
  return await queueCoreMutation({entity:'entry',entityId:entry.id,operation:'create',payload:entry,localRecord},expectedRevision);
}
export async function updateEntry(id,entry,expectedRevision){
  const snapshot=await localSnapshot(),existing=snapshot?.entries?.find(row=>row.id===id);
  if(snapshot&&!existing)throw new Error('Transaction not found.');
  const localRecord=existing?{...existing,...entry,id,createdAt:existing.createdAt,updatedAt:new Date().toISOString()}:null;
  return await queueCoreMutation({entity:'entry',entityId:id,operation:'update',payload:{...entry,id},localRecord},expectedRevision);
}
export async function removeEntry(id,expectedRevision){
  const snapshot=await localSnapshot();
  const existing=snapshot?.entries?.find(row=>row.id===id);
  if(snapshot&&!existing)throw new Error('Transaction not found.');
  return await queueCoreMutation({entity:'entry',entityId:id,operation:'delete',payload:{id}},expectedRevision);
}

export async function saveState(state){ return await api('/api/state',{method:'PUT',body:JSON.stringify(state)}); }
export async function resetState(password){ return await api('/api/state/reset',{method:'POST',body:JSON.stringify({password})}); }
export async function exportFullBackup(){ return await api('/api/backup/full'); }
export async function restoreFullBackup(backup,password,confirmation='RESTORE'){ return await api('/api/backup/full/restore',{method:'POST',body:JSON.stringify({backup,password,confirmation})}); }
export async function restoreBackup(backup,password,confirmation='RESTORE'){ return await api('/api/backup/restore',{method:'POST',body:JSON.stringify({backup,password,confirmation})}); }
export async function listRecurringRules(){ return await api('/api/recurring'); }
export async function createRecurringRule(rule){ return await api('/api/recurring',{method:'POST',body:JSON.stringify(rule)}); }
export async function updateRecurringRule(id,rule){ return await api('/api/recurring/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify(rule)}); }
export async function deleteRecurringRule(id){ return await api('/api/recurring/'+encodeURIComponent(id),{method:'DELETE',body:'{}'}); }
export async function postRecurringRule(id,payload){ return await api('/api/recurring/'+encodeURIComponent(id)+'/post',{method:'POST',body:JSON.stringify(payload)}); }
export async function skipRecurringRule(id,payload){ return await api('/api/recurring/'+encodeURIComponent(id)+'/skip',{method:'POST',body:JSON.stringify(payload)}); }
export async function listRecurringReminders(){ return await api('/api/recurring/reminders'); }
export async function acknowledgeRecurringReminder(id){ return await api('/api/recurring/reminders/'+encodeURIComponent(id),{method:'POST',body:'{}'}); }
export async function previewSpreadsheet(filename,dataBase64){ return await api('/api/import/xlsx/preview',{method:'POST',body:JSON.stringify({filename,dataBase64})}); }
function bankFeedView(snapshot,params={},queue=[]){
  const status=['pending','posted','ignored'].includes(String(params.status||''))?String(params.status):'';
  const limit=Math.max(1,Math.min(500,Number(params.limit)||100)),offset=Math.max(0,Number(params.offset)||0);
  const all=Array.isArray(snapshot?.items)?snapshot.items:[],filtered=status?all.filter(row=>row.status===status):all;
  return {
    ...(cloneLocal(snapshot||{})),
    items:filtered.slice(offset,offset+limit),
    page:{limit,offset,returned:Math.max(0,Math.min(limit,filtered.length-offset)),total:filtered.length},
    offline:{cached:!browserOnline(),cachedAt:snapshot?.cachedAt||null,queued:queue.filter(row=>['pending','failed','conflict'].includes(row.status)).length,failed:queue.filter(row=>row.status==='failed').length,conflicts:queue.filter(row=>row.status==='conflict').length}
  };
}
async function cacheBankFeedResult(result,identity){
  if(!identity||!result||typeof result!=='object')return;
  const previous=await loadBankFeedSnapshot(identity).catch(()=>null);
  const merged={...(previous||{}),...cloneLocal(result),cachedAt:new Date().toISOString()};
  if(Array.isArray(result.items))merged.items=cloneLocal(result.items);
  if(!Array.isArray(merged.rules))merged.rules=[];
  if(!Array.isArray(merged.history))merged.history=[];
  await saveBankFeedSnapshot(merged,identity).catch(()=>{});
}
function optimisticBankFeed(snapshot,action,{itemId='',ruleId='',payload={}}={}){
  const next=cloneLocal(snapshot||{items:[],rules:[],history:[],stats:{pending:0,posted:0,ignored:0},accountStats:[]});
  next.items=Array.isArray(next.items)?next.items:[];
  next.rules=Array.isArray(next.rules)?next.rules:[];
  next.stats={pending:Number(next.stats?.pending||0),posted:Number(next.stats?.posted||0),ignored:Number(next.stats?.ignored||0)};
  const index=next.items.findIndex(row=>row.id===itemId),item=index>=0?next.items[index]:null;
  if(action==='ignore'&&item?.status==='pending'){next.items[index]={...item,status:'ignored',pendingAction:'ignore'};next.stats.pending=Math.max(0,next.stats.pending-1);next.stats.ignored++;}
  else if(action==='reopen'&&item?.status==='ignored'){next.items[index]={...item,status:'pending',pendingAction:'reopen'};next.stats.ignored=Math.max(0,next.stats.ignored-1);next.stats.pending++;}
  else if(action==='delete'&&item&&item.status!=='posted'){next.items.splice(index,1);next.stats[item.status]=Math.max(0,Number(next.stats[item.status]||0)-1);}
  else if(action==='post'&&item?.status==='pending')next.items[index]={...item,pendingAction:'post',pendingPayload:cloneLocal(payload)};
  else if(action==='undo'&&item?.status==='posted')next.items[index]={...item,pendingAction:'undo'};
  else if(action==='create_rule')next.rules=[{id:ruleId,...cloneLocal(payload),offlinePending:true},...next.rules.filter(row=>row.id!==ruleId)];
  else if(action==='delete_rule')next.rules=next.rules.filter(row=>row.id!==ruleId);
  else if(action==='import')next.pendingImports=Number(next.pendingImports||0)+1;
  return next;
}
async function queueBankFeedMutation(action,{itemId='',ruleId='',payload={}}={}){
  const identity=authenticatedIdentity;
  if(!identity)throw new Error('Sign in before changing Bank Feed.');
  const snapshot=await loadBankFeedSnapshot(identity).catch(()=>null);
  if(!snapshot)throw new Error('Open Bank Feed once while connected before using it offline.');
  const operation={operationId:uid('op'),action,itemId,ruleId,payload:cloneLocal(payload),createdAt:new Date().toISOString(),status:'pending',attempts:0,lastError:''};
  const next=optimisticBankFeed(snapshot,action,{itemId,ruleId,payload});
  await enqueueBankFeedOperation(operation,next,identity);
  await publishSyncStatus({bankFeedQueued:true});
  return {...bankFeedView(next,{},await listBankFeedQueue(identity)),queued:true,operationId:operation.operationId,state:await localSnapshot()};
}
async function directBankMutation(action,{itemId='',ruleId='',payload={}}={}){
  if(action==='import')return await api('/api/bank-feed/import',{method:'POST',body:JSON.stringify(payload)});
  if(action==='post')return await api('/api/bank-feed/'+encodeURIComponent(itemId)+'/post',{method:'POST',body:JSON.stringify(payload)});
  if(action==='undo')return await api('/api/bank-feed/'+encodeURIComponent(itemId)+'/undo',{method:'POST',body:JSON.stringify(payload)});
  if(action==='ignore')return await api('/api/bank-feed/'+encodeURIComponent(itemId)+'/ignore',{method:'POST',body:'{}'});
  if(action==='reopen')return await api('/api/bank-feed/'+encodeURIComponent(itemId)+'/reopen',{method:'POST',body:'{}'});
  if(action==='delete')return await api('/api/bank-feed/'+encodeURIComponent(itemId),{method:'DELETE',body:'{}'});
  if(action==='create_rule')return await api('/api/bank-rules',{method:'POST',body:JSON.stringify({...payload,id:ruleId})});
  if(action==='delete_rule')return await api('/api/bank-rules/'+encodeURIComponent(ruleId),{method:'DELETE',body:'{}'});
  throw new Error('Unsupported Bank Feed action.');
}
async function bankFeedMutation(action,args={}){
  const identity=authenticatedIdentity;
  if(browserOnline()){
    try{
      const result=await directBankMutation(action,args);
      if(identity){
        if(result?.items)await cacheBankFeedResult(result,identity);
        else{
          const cached=await loadBankFeedSnapshot(identity).catch(()=>null);
          if(cached)await saveBankFeedSnapshot(optimisticBankFeed(cached,action,args),identity).catch(()=>{});
        }
      }
      return result;
    }catch(error){if(!error.offline)throw error;}
  }
  return await queueBankFeedMutation(action,args);
}
export async function listBankFeed(params={}){
  const identity=authenticatedIdentity;
  if(browserOnline()){
    const query=new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined&&v!==null&&v!==''));
    const result=await api('/api/bank-feed'+(query.size?'?'+query:''));
    if(identity){
      try{
        const recent=(params.status||Number(params.offset||0)>0||Number(params.limit||100)<500)?await api('/api/bank-feed?limit=500&offset=0'):result;
        await cacheBankFeedResult(recent,identity);
      }catch{await cacheBankFeedResult(result,identity);}
      const queue=await listBankFeedQueue(identity).catch(()=>[]);
      return {...result,offline:{cached:false,queued:queue.filter(row=>['pending','failed','conflict'].includes(row.status)).length,failed:queue.filter(row=>row.status==='failed').length,conflicts:queue.filter(row=>row.status==='conflict').length}};
    }
    return result;
  }
  const cached=identity?await loadBankFeedSnapshot(identity).catch(()=>null):null;
  if(!cached){const error=new Error('Bank Feed is not cached on this device yet. Reconnect and open Bank Feed once.');error.offline=true;throw error;}
  const queue=await listBankFeedQueue(identity).catch(()=>[]);
  return bankFeedView(cached,params,queue);
}
export async function importBankFeed(payload){ return await bankFeedMutation('import',{payload}); }
export async function postBankFeedItem(id,payload){ return await bankFeedMutation('post',{itemId:id,payload}); }
export async function undoBankFeedItem(id,payload){ return await bankFeedMutation('undo',{itemId:id,payload}); }
export async function ignoreBankFeedItem(id){ return await bankFeedMutation('ignore',{itemId:id}); }
export async function reopenBankFeedItem(id){ return await bankFeedMutation('reopen',{itemId:id}); }
export async function deleteBankFeedItem(id){ return await bankFeedMutation('delete',{itemId:id}); }
export async function createBankRule(rule){ const ruleId=rule?.id||uid('bankrule');return await bankFeedMutation('create_rule',{ruleId,payload:{...rule,id:ruleId}}); }
export async function deleteBankRule(id){ return await bankFeedMutation('delete_rule',{ruleId:id}); }
export async function createCategory(category){ return await api('/api/categories',{method:'POST',body:JSON.stringify(category)}); }
export async function updateCategory(id,category){ return await api('/api/categories/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify(category)}); }
export async function archiveCategory(id){ return await api('/api/categories/'+encodeURIComponent(id)+'/archive',{method:'POST',body:'{}'}); }
export async function restoreCategory(id){ return await api('/api/categories/'+encodeURIComponent(id)+'/restore',{method:'POST',body:'{}'}); }
export async function saveBudget(budget){ return await api('/api/budgets',{method:'POST',body:JSON.stringify(budget)}); }
export async function deleteBudget(id){ return await api('/api/budgets/'+encodeURIComponent(id),{method:'DELETE',body:'{}'}); }

export async function listAttachments(entryId){
  const identity=authenticatedIdentity;
  let serverAttachments=[];
  if(browserOnline()){
    try{
      const result=await api('/api/attachments?entry='+encodeURIComponent(entryId));
      serverAttachments=Array.isArray(result?.attachments)?result.attachments:[];
      if(identity)await cacheAttachmentList(entryId,serverAttachments,identity).catch(()=>{});
    }catch(error){
      if(!error.offline)throw error;
    }
  }
  const local=identity?await listOfflineAttachments(entryId,identity).catch(()=>[]):[];
  const merged=new Map(serverAttachments.map(item=>[item.id,{...item,synced:true,status:'synced'}]));
  for(const item of local){
    if(item.status==='deleted'){merged.delete(item.id);continue;}
    merged.set(item.id,{...merged.get(item.id),...item});
  }
  return {
    attachments:[...merged.values()].map(item=>({
      ...item,
      localUrl:item.data?('data:'+(item.mimeType||'application/octet-stream')+';base64,'+item.data):null,
      offlineAvailable:Boolean(item.data),
      pending:item.status==='pending'||item.synced===false
    }))
  };
}

async function fileDataBase64(file){
  return await new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result||'').split(',').pop()||'');
    reader.onerror=()=>reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

export async function uploadAttachment(entryId,file){
  if(!file)throw new Error('Choose a file.');
  if(file.size>8*1024*1024)throw new Error('Attachments must be 8 MB or smaller.');
  const data=await fileDataBase64(file);
  const identity=authenticatedIdentity;
  if(!identity)throw new Error('Sign in before adding attachments.');
  const record={
    id:uid('attachment'),
    entryId,
    name:file.name,
    mimeType:file.type||'application/octet-stream',
    sizeBytes:file.size,
    data,
    createdAt:new Date().toISOString()
  };
  try{
    await queueOfflineAttachmentCreate(record,identity);
  }catch(error){
    if(browserOnline()){
      return await api('/api/attachments',{method:'POST',body:JSON.stringify({entryId,name:file.name,mimeType:file.type||'application/octet-stream',data})});
    }
    throw error;
  }
  await publishSyncStatus({attachmentQueued:true});
  if(browserOnline())await syncPendingOperations();
  const saved=await getOfflineAttachment(record.id,identity).catch(()=>null);
  return {attachment:saved||record,queued:!browserOnline()};
}

export async function deleteAttachment(id){
  const identity=authenticatedIdentity;
  if(!identity)throw new Error('Sign in before removing attachments.');
  const local=await getOfflineAttachment(id,identity).catch(()=>null);
  if(!local){
    if(browserOnline())return await api('/api/attachments/'+encodeURIComponent(id),{method:'DELETE',body:'{}'});
    throw new Error('This attachment is not stored on this device.');
  }
  await queueOfflineAttachmentDelete(id,identity);
  await publishSyncStatus({attachmentQueued:true});
  if(browserOnline())await syncPendingOperations();
  return {ok:true};
}

export function attachmentUrl(id){
  return '/api/attachments/'+encodeURIComponent(id);
}

export function uid(prefix='id'){ return `${prefix}_${crypto.randomUUID()}`; }

if(typeof window!=='undefined'){
  window.addEventListener('online',async()=>{
    if(!authenticatedIdentity)return;
    try{
      const data=await api('/api/auth/me');
      csrfToken=data.csrfToken||csrfToken;
      await saveAuthorizedUser(data.user).catch(()=>{});
      await syncPendingOperations({source:'online'});
    }catch{}
  });
}
