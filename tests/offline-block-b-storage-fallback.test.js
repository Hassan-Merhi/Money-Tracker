import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.navigator={onLine:true};
globalThis.indexedDB={open(){throw new Error('IndexedDB denied');}};

const calls=[];
globalThis.fetch=async(path,options={})=>{
  calls.push({path:String(path),options});
  let body;
  if(String(path)==='/api/auth/me'){
    body={user:{id:'user_storage_fallback',email:'fallback@example.test'},csrfToken:'csrf-fallback'};
  }else if(String(path)==='/api/settings'){
    body={version:9,settings:{displayName:'Money Tracker',defaultCurrency:'EUR'},people:[],accounts:[],entries:[],categories:[],budgets:[]};
  }else if(String(path)==='/api/auth/logout'){
    body={ok:true};
  }else{
    body={version:9,settings:{displayName:'Money Tracker',defaultCurrency:'USD'},people:[],accounts:[],entries:[],categories:[],budgets:[]};
  }
  return {ok:true,status:200,json:async()=>body,headers:new Headers()};
};

const store=await import('../lib/store.js?storage-fallback='+Date.now());

test('connected auth remains usable when IndexedDB rejects',async()=>{
  const user=await store.currentUser();
  assert.equal(user.email,'fallback@example.test');
});

test('connected core writes fall back to atomic HTTP when IndexedDB rejects',async()=>{
  const state=await store.updateSettings({defaultCurrency:'EUR'},8);
  assert.equal(state.settings.defaultCurrency,'EUR');
  const call=calls.findLast(row=>row.path==='/api/settings');
  assert.ok(call);
  assert.equal(call.options.method,'PUT');
  assert.equal(call.options.headers['X-CSRF-Token'],'csrf-fallback');
  assert.equal(JSON.parse(call.options.body).expectedRevision,8);
});

test('logout remains available when offline storage itself is unavailable',async()=>{
  await store.logout();
  assert.equal(calls.at(-1).path,'/api/auth/logout');
});
