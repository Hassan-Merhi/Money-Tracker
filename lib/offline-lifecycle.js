const CHANNEL_NAME='money-tracker-lifecycle-v1';
const STORAGE_KEY='money-tracker-lifecycle-signal-v1';
const sourceId=globalThis.crypto?.randomUUID?.()||('source_'+Math.random().toString(36).slice(2));
let channel=null;
let initialized=false;

function safeIdentity(value){return String(value||'').trim();}
function emitPeer(detail){
  if(typeof window==='undefined')return;
  window.dispatchEvent(new CustomEvent('moneytracker:peer-change',{detail}));
}
function accept(message){
  if(!message||message.sourceId===sourceId)return;
  const identity=safeIdentity(message.identity);
  if(!identity)return;
  emitPeer({
    sourceId:String(message.sourceId||''),
    identity,
    kind:String(message.kind||'working-set'),
    version:Number.isFinite(Number(message.version))?Number(message.version):null,
    at:String(message.at||''),
    source:String(message.source||'peer')
  });
}

export function initOfflineLifecycle(){
  if(initialized||typeof window==='undefined')return offlineLifecycleCapabilities();
  initialized=true;
  if(typeof BroadcastChannel!=='undefined'){
    try{
      channel=new BroadcastChannel(CHANNEL_NAME);
      channel.addEventListener('message',event=>accept(event.data));
    }catch{channel=null;}
  }
  window.addEventListener('storage',event=>{
    if(event.key!==STORAGE_KEY||!event.newValue)return;
    try{accept(JSON.parse(event.newValue));}catch{}
  });
  return offlineLifecycleCapabilities();
}

export function announceOfflineChange({identity,kind='working-set',version=null,source='window'}={}){
  const cleanIdentity=safeIdentity(identity);
  if(!cleanIdentity)return false;
  const message={
    sourceId,identity:cleanIdentity,kind:String(kind||'working-set'),
    version:Number.isFinite(Number(version))?Number(version):null,
    at:new Date().toISOString(),source:String(source||'window')
  };
  try{channel?.postMessage(message);}catch{}
  if(typeof window!=='undefined'){
    try{
      localStorage.setItem(STORAGE_KEY,JSON.stringify(message));
      localStorage.removeItem(STORAGE_KEY);
    }catch{}
  }
  return true;
}

export async function withOfflineSyncLock(identity,task){
  const cleanIdentity=safeIdentity(identity);
  if(typeof task!=='function')throw new Error('A sync task is required.');
  const locks=globalThis.navigator?.locks;
  if(cleanIdentity&&locks?.request){
    return await locks.request('money-tracker-sync:'+cleanIdentity,{mode:'exclusive'},async()=>await task());
  }
  return await task();
}

export function offlineLifecycleCapabilities(){
  return {
    sourceId,
    broadcastChannel:typeof BroadcastChannel!=='undefined',
    storageEvents:typeof window!=='undefined'&&typeof localStorage!=='undefined',
    webLocks:Boolean(globalThis.navigator?.locks?.request)
  };
}
