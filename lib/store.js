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
export async function login(email,password){ const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email,password})});csrfToken=d.csrfToken;return d.user; }
export async function register(email,password,displayName){ const d=await api('/api/auth/register',{method:'POST',body:JSON.stringify({email,password,displayName})});csrfToken=d.csrfToken;return d.user; }
export async function logout(){ await api('/api/auth/logout',{method:'POST',body:'{}'});csrfToken=''; }
export async function loadState(){ return await api('/api/state'); }
export async function saveState(state){ return await api('/api/state',{method:'PUT',body:JSON.stringify(state)}); }
export async function resetState(){ return await api('/api/state/reset',{method:'POST',body:'{}'}); }

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
