export const initialState = {
  version: 1,
  settings: { defaultCurrency: 'USD', displayName: 'My Ledger' },
  people: [], accounts: [], entries: []
};
let csrfToken = '';

async function api(path, options={}) {
  const headers = { 'Accept':'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers||{}) };
  if (options.method && !['GET','HEAD'].includes(options.method)) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(path, {...options, headers, credentials:'same-origin'});
  const data = await res.json().catch(()=>({}));
  if (!res.ok) { const err=new Error(data.error||`Request failed (${res.status})`); err.status=res.status; throw err; }
  return data;
}

export async function currentUser() {
  try { const data=await api('/api/auth/me'); csrfToken=data.csrfToken; return data.user; }
  catch (e) { if(e.status===401)return null; throw e; }
}
export async function registrationStatus(){ return await api('/api/auth/status'); }
export async function login(email,password){ const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email,password})});csrfToken=d.csrfToken;return d.user; }
export async function register(email,password){ const d=await api('/api/auth/register',{method:'POST',body:JSON.stringify({email,password})});csrfToken=d.csrfToken;return d.user; }
export async function listUsers(){ return await api('/api/users'); }
export async function createUserAccount(email,password){ return await api('/api/users',{method:'POST',body:JSON.stringify({email,password})}); }
export async function resetUserPassword(id,password){ return await api('/api/users/'+encodeURIComponent(id)+'/password',{method:'POST',body:JSON.stringify({password})}); }
export async function deleteUserAccount(id){ return await api('/api/users/'+encodeURIComponent(id),{method:'DELETE',body:'{}'}); }
export async function changePassword(currentPassword,newPassword){ return await api('/api/auth/password',{method:'POST',body:JSON.stringify({currentPassword,newPassword})}); }
export async function revokeOtherSessions(){ return await api('/api/auth/sessions/revoke-others',{method:'POST',body:'{}'}); }
export async function deleteMyAccount(password,confirmation){ return await api('/api/account',{method:'DELETE',body:JSON.stringify({password,confirmation})}); }
export async function logout(){ await api('/api/auth/logout',{method:'POST',body:'{}'});csrfToken=''; }
export async function loadState(){ return await api('/api/state'); }
export async function updateSettings(settings,expectedRevision){ return await api('/api/settings',{method:'PUT',body:JSON.stringify({...settings,expectedRevision})}); }
export async function createPerson(person,expectedRevision){ return await api('/api/people',{method:'POST',body:JSON.stringify({...person,expectedRevision})}); }
export async function updatePerson(id,person,expectedRevision){ return await api('/api/people/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify({...person,expectedRevision})}); }
export async function removePerson(id,expectedRevision){ return await api('/api/people/'+encodeURIComponent(id),{method:'DELETE',body:JSON.stringify({expectedRevision})}); }
export async function createAccount(account,expectedRevision){ return await api('/api/accounts',{method:'POST',body:JSON.stringify({...account,expectedRevision})}); }
export async function updateAccount(id,account,expectedRevision){ return await api('/api/accounts/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify({...account,expectedRevision})}); }
export async function removeAccount(id,expectedRevision){ return await api('/api/accounts/'+encodeURIComponent(id),{method:'DELETE',body:JSON.stringify({expectedRevision})}); }
export async function createEntry(entry,expectedRevision){ return await api('/api/entries',{method:'POST',body:JSON.stringify({...entry,expectedRevision})}); }
export async function updateEntry(id,entry,expectedRevision){ return await api('/api/entries/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify({...entry,expectedRevision})}); }
export async function removeEntry(id,expectedRevision){ return await api('/api/entries/'+encodeURIComponent(id),{method:'DELETE',body:JSON.stringify({expectedRevision})}); }
export async function saveState(state){ return await api('/api/state',{method:'PUT',body:JSON.stringify(state)}); }
export async function resetState(){ return await api('/api/state/reset',{method:'POST',body:'{}'}); }
export async function exportFullBackup(){ return await api('/api/backup/full'); }
export async function restoreFullBackup(backup){ return await api('/api/backup/full/restore',{method:'POST',body:JSON.stringify(backup)}); }
export async function restoreBackup(backup){ return await api('/api/backup/restore',{method:'POST',body:JSON.stringify(backup)}); }
export async function listRecurringRules(){ return await api('/api/recurring'); }
export async function createRecurringRule(rule){ return await api('/api/recurring',{method:'POST',body:JSON.stringify(rule)}); }
export async function updateRecurringRule(id,rule){ return await api('/api/recurring/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify(rule)}); }
export async function deleteRecurringRule(id){ return await api('/api/recurring/'+encodeURIComponent(id),{method:'DELETE',body:'{}'}); }
export async function postRecurringRule(id,payload){ return await api('/api/recurring/'+encodeURIComponent(id)+'/post',{method:'POST',body:JSON.stringify(payload)}); }
export async function skipRecurringRule(id,payload){ return await api('/api/recurring/'+encodeURIComponent(id)+'/skip',{method:'POST',body:JSON.stringify(payload)}); }
export async function listRecurringReminders(){ return await api('/api/recurring/reminders'); }
export async function acknowledgeRecurringReminder(id){ return await api('/api/recurring/reminders/'+encodeURIComponent(id),{method:'POST',body:'{}'}); }
export async function previewSpreadsheet(filename,dataBase64){ return await api('/api/import/xlsx/preview',{method:'POST',body:JSON.stringify({filename,dataBase64})}); }
export async function listBankFeed(){ return await api('/api/bank-feed'); }
export async function importBankFeed(payload){ return await api('/api/bank-feed/import',{method:'POST',body:JSON.stringify(payload)}); }
export async function postBankFeedItem(id,payload){ return await api('/api/bank-feed/'+encodeURIComponent(id)+'/post',{method:'POST',body:JSON.stringify(payload)}); }
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
