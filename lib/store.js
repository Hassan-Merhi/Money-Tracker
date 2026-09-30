import { applyPulledChanges, clearOfflineData, discardQueuedOperations, enqueueLocalMutation, getLastServerRevision, isLedgerState, listQueuedOperations, loadAuthorizedUser, loadStateSnapshot, pendingOperationCount, removeQueuedOperation, saveAuthorizedUser, saveStateSnapshot, setLastServerRevision, updateQueuedOperation } from './offline-db.js';
export const initialState = {
  version: 1,
  settings: { defaultCurrency: 'USD', displayName: 'My Ledger' },
  people: [], accounts: [], entries: []
};
let csrfToken = '';
let authenticatedIdentity = '';

function userIdentity(user){ return String(user?.id||user?.email||'').trim(); }
function browserOnline(){ return typeof navigator==='undefined'||navigator.onLine!==false; }
function emitSyncStatus(detail={}){
  if(typeof window==='undefined')return;
  window.dispatchEvent(new CustomEvent('moneytracker:sync',{detail}));
}
export async function getSyncStatus(){
  const identity=authenticatedIdentity||userIdentity(await loadAuthorizedUser().catch(()=>null));
  const queue=identity?await listQueuedOperations(identity).catch(()=>[]):[];
  const pending=queue.filter(row=>['pending','failed','conflict'].includes(row.status)).length;
  return {
    pending,
    failed:queue.filter(row=>row.status==='failed').length,
    conflicts:queue.filter(row=>row.status==='conflict').length,
    attempts:queue.reduce((sum,row)=>sum+Number(row.attempts||0),0),
    online:browserOnline(),
    queue
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
    authenticatedIdentity=nextIdentity;csrfToken=data?.csrfToken||'';
    try{await api('/api/auth/logout',{method:'POST',body:'{}'});}catch{}
    authenticatedIdentity=previousIdentity;csrfToken=previousCsrf;
    throw error;
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
      authenticatedIdentity=cachedIdentity;
      await publishSyncStatus().catch(()=>{});
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
  if(identity&&await pendingOperationCount(identity))throw new Error('Sync or discard the offline changes on this device before deleting the account.');
  const result=await api('/api/account',{method:'DELETE',body:JSON.stringify({password,confirmation})});
  csrfToken='';authenticatedIdentity='';
  if(identity) await clearOfflineData(identity,{force:true}).catch(()=>{});
  return result;
}
export async function logout(){
  const identity=authenticatedIdentity;
  if(identity&&await pendingOperationCount(identity))throw new Error('You have unsynced offline changes. Reconnect and sync them before signing out.');
  try { await api('/api/auth/logout',{method:'POST',body:'{}'}); }
  finally {
    csrfToken='';authenticatedIdentity='';
    if(identity) await clearOfflineData(identity,{force:true}).catch(()=>{});
  }
}
export async function syncPendingOperations(){
  const identity=authenticatedIdentity;
  if(!identity)return await publishSyncStatus({authRequired:true});
  let queue=await listQueuedOperations(identity);
  if(!queue.length){
    await publishSyncStatus();
    return await getSyncStatus();
  }
  if(!browserOnline()){
    await publishSyncStatus();
    return await getSyncStatus();
  }

  const blocker=queue.find(row=>row.status==='failed'||row.status==='conflict');
  if(blocker){
    await publishSyncStatus({lastError:blocker.lastError||'A queued change needs attention.'});
    return await getSyncStatus();
  }

  for(const operation of queue){
    if(operation.status!=='pending')continue;
    await updateQueuedOperation(operation.operationId,{attempts:Number(operation.attempts||0)+1,lastError:''});
    try{
      await api('/api/sync/push',{method:'POST',body:JSON.stringify({operation})});
      await removeQueuedOperation(operation.operationId);
    }catch(error){
      if(error.offline){
        await updateQueuedOperation(operation.operationId,{status:'pending',lastError:error.message||'Connection lost during sync.'}).catch(()=>{});
      }else if(error.status===409){
        await updateQueuedOperation(operation.operationId,{status:'conflict',lastError:error.message||'This change conflicts with newer server data.'}).catch(()=>{});
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

  let since=await getLastServerRevision(identity);
  if(since===null){
    const snapshot=await loadStateSnapshot();
    since=Number(snapshot?.version)||0;
  }
  const pulled=await api('/api/sync/pull?sinceRevision='+encodeURIComponent(String(since)));
  if(pulled.requiresFullRefresh){
    await api('/api/state');
  }else{
    await applyPulledChanges(pulled.changes||[],Number(pulled.currentRevision),identity);
  }
  await publishSyncStatus({synced:true});
  return await getSyncStatus();
}

export async function discardPendingChangesAndReload(){
  const identity=authenticatedIdentity;
  if(!identity)throw new Error('Sign in first.');
  if(!browserOnline())throw new Error('Reconnect before reloading the server copy.');
  await discardQueuedOperations(identity);
  const fresh=await api('/api/state');
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
  const snapshot=await loadStateSnapshot();
  if(!snapshot){
    if(browserOnline())return await directCoreMutation(spec,expectedRevision);
    throw new Error('Offline storage is not ready yet. Reload while connected once and try again.');
  }
  const queued=await enqueueLocalMutation({...spec,expectedRevision},identity);
  await publishSyncStatus({queued:true});
  if(browserOnline())await syncPendingOperations();
  return await loadStateSnapshot()||queued.state;
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
  const snapshot=await loadStateSnapshot();
  const localRecord={...(snapshot?.settings||{}),...settings};
  return await queueCoreMutation({entity:'settings',entityId:'settings',operation:'update',payload:settings,localRecord},expectedRevision);
}
export async function createPerson(person,expectedRevision){
  const snapshot=await loadStateSnapshot(),stamp=new Date().toISOString();
  const localRecord={id:person.id,name:String(person.name||''),note:String(person.note||''),createdAt:person.createdAt||stamp};
  const extraLedgerRecords=[];
  const opening=Number(person.openingBalance??person.opening??0);
  if(opening>0){
    const currency=String(person.currency||snapshot?.settings?.defaultCurrency||'USD').toUpperCase();
    const signedAmount=(person.direction==='i_owe'?-1:1)*opening;
    extraLedgerRecords.push({store:'entries',record:{
      id:person.openingEntryId||uid('entry'),type:'person_adjustment',personId:person.id,accountId:null,
      fromAccountId:null,toAccountId:null,amount:opening,currency,fromAmount:null,toAmount:null,signedAmount,
      date:person.openingDate||new Date().toISOString().slice(0,10),merchant:'',description:'Opening balance',
      categoryId:null,splits:[],attachmentCount:0,attachments:[],createdAt:stamp,updatedAt:stamp
    }});
  }
  return await queueCoreMutation({entity:'person',entityId:person.id,operation:'create',payload:person,localRecord,extraLedgerRecords},expectedRevision);
}
export async function updatePerson(id,person,expectedRevision){
  const snapshot=await loadStateSnapshot(),existing=snapshot?.people?.find(row=>row.id===id);
  if(snapshot&&!existing)throw new Error('Person not found.');
  return await queueCoreMutation({entity:'person',entityId:id,operation:'update',payload:{...person,id},localRecord:existing?{...existing,...person,id}:null},expectedRevision);
}
export async function removePerson(id,expectedRevision){ return await queueCoreMutation({entity:'person',entityId:id,operation:'delete',payload:{id}},expectedRevision); }
export async function createAccount(account,expectedRevision){
  const localRecord={...account,createdAt:account.createdAt||new Date().toISOString()};
  return await queueCoreMutation({entity:'account',entityId:account.id,operation:'create',payload:account,localRecord},expectedRevision);
}
export async function updateAccount(id,account,expectedRevision){
  const snapshot=await loadStateSnapshot(),existing=snapshot?.accounts?.find(row=>row.id===id);
  if(snapshot&&!existing)throw new Error('Account not found.');
  return await queueCoreMutation({entity:'account',entityId:id,operation:'update',payload:{...account,id},localRecord:existing?{...existing,...account,id,currency:existing.currency}:null},expectedRevision);
}
export async function removeAccount(id,expectedRevision){ return await queueCoreMutation({entity:'account',entityId:id,operation:'delete',payload:{id}},expectedRevision); }
export async function createEntry(entry,expectedRevision){
  if(entry?.type==='account_transfer'){
    if(!browserOnline())throw new Error('Offline transfers are reserved for the atomic-transfer phase. Reconnect to save this transfer.');
    return await api('/api/entries',{method:'POST',body:JSON.stringify({...entry,expectedRevision})});
  }
  const stamp=new Date().toISOString(),localRecord={...entry,createdAt:entry.createdAt||stamp,updatedAt:stamp};
  return await queueCoreMutation({entity:'entry',entityId:entry.id,operation:'create',payload:entry,localRecord},expectedRevision);
}
export async function updateEntry(id,entry,expectedRevision){
  if(entry?.type==='account_transfer'){
    if(!browserOnline())throw new Error('Offline transfers are reserved for the atomic-transfer phase. Reconnect to edit this transfer.');
    return await api('/api/entries/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify({...entry,expectedRevision})});
  }
  const snapshot=await loadStateSnapshot(),existing=snapshot?.entries?.find(row=>row.id===id);
  if(snapshot&&!existing)throw new Error('Transaction not found.');
  const localRecord=existing?{...existing,...entry,id,createdAt:existing.createdAt,updatedAt:new Date().toISOString()}:null;
  return await queueCoreMutation({entity:'entry',entityId:id,operation:'update',payload:{...entry,id},localRecord},expectedRevision);
}
export async function removeEntry(id,expectedRevision){ return await queueCoreMutation({entity:'entry',entityId:id,operation:'delete',payload:{id}},expectedRevision); }

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
export async function listBankFeed(params={}){ const query=new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined&&v!==null&&v!=='')); return await api('/api/bank-feed'+(query.size?'?'+query:'')); }
export async function importBankFeed(payload){ return await api('/api/bank-feed/import',{method:'POST',body:JSON.stringify(payload)}); }
export async function postBankFeedItem(id,payload){ return await api('/api/bank-feed/'+encodeURIComponent(id)+'/post',{method:'POST',body:JSON.stringify(payload)}); }
export async function undoBankFeedItem(id,payload){ return await api('/api/bank-feed/'+encodeURIComponent(id)+'/undo',{method:'POST',body:JSON.stringify(payload)}); }
export async function ignoreBankFeedItem(id){ return await api('/api/bank-feed/'+encodeURIComponent(id)+'/ignore',{method:'POST',body:'{}'}); }
export async function reopenBankFeedItem(id){ return await api('/api/bank-feed/'+encodeURIComponent(id)+'/reopen',{method:'POST',body:'{}'}); }
export async function deleteBankFeedItem(id){ return await api('/api/bank-feed/'+encodeURIComponent(id),{method:'DELETE',body:'{}'}); }
export async function createBankRule(rule){ return await api('/api/bank-rules',{method:'POST',body:JSON.stringify(rule)}); }
export async function deleteBankRule(id){ return await api('/api/bank-rules/'+encodeURIComponent(id),{method:'DELETE',body:'{}'}); }
export async function createCategory(category){ return await api('/api/categories',{method:'POST',body:JSON.stringify(category)}); }
export async function updateCategory(id,category){ return await api('/api/categories/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify(category)}); }
export async function archiveCategory(id){ return await api('/api/categories/'+encodeURIComponent(id)+'/archive',{method:'POST',body:'{}'}); }
export async function restoreCategory(id){ return await api('/api/categories/'+encodeURIComponent(id)+'/restore',{method:'POST',body:'{}'}); }
export async function saveBudget(budget){ return await api('/api/budgets',{method:'POST',body:JSON.stringify(budget)}); }
export async function deleteBudget(id){ return await api('/api/budgets/'+encodeURIComponent(id),{method:'DELETE',body:'{}'}); }

export async function listAttachments(entryId){
  return await api(`/api/attachments?entry=${encodeURIComponent(entryId)}`);
}

export async function uploadAttachment(entryId,file){
  if (!file) throw new Error('Choose a file.');
  if (file.size > 8 * 1024 * 1024) throw new Error('Attachments must be 8 MB or smaller.');
  const data = await new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload=()=>resolve(String(reader.result||'').split(',').pop()||'');
    reader.onerror=()=>reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
  return await api('/api/attachments',{method:'POST',body:JSON.stringify({
    entryId,
    name:file.name,
    mimeType:file.type || 'application/octet-stream',
    data
  })});
}

export async function deleteAttachment(id){
  return await api(`/api/attachments/${encodeURIComponent(id)}`,{method:'DELETE',body:'{}'});
}

export function attachmentUrl(id){
  return `/api/attachments/${encodeURIComponent(id)}`;
}

export function uid(prefix='id'){ return `${prefix}_${crypto.randomUUID()}`; }

if(typeof window!=='undefined'){
  window.addEventListener('online',async()=>{
    if(!authenticatedIdentity)return;
    try{
      const data=await api('/api/auth/me');
      csrfToken=data.csrfToken||csrfToken;
      await syncPendingOperations();
    }catch{}
  });
}
