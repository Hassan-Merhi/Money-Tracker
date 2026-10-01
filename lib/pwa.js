let deferredInstallPrompt=null;
let registration=null;
let updateWaiting=false;
let activatingUpdate=false;
let resumeTimer=null;
let storageState={
  supported:Boolean(navigator.storage),
  persisted:null,
  usage:0,
  quota:0,
  usageRatio:0,
  persistenceRequested:false
};
let backgroundState={
  supported:false,
  periodicSupported:false,
  registered:false,
  lastRegisteredAt:null
};

function snapshot(){
  return {
    online:navigator.onLine,
    installable:Boolean(deferredInstallPrompt),
    installed:window.matchMedia?.('(display-mode: standalone)')?.matches||navigator.standalone===true,
    updateWaiting,
    storage:{...storageState},
    backgroundSync:{...backgroundState}
  };
}
function emit(){window.dispatchEvent(new CustomEvent('moneytracker:pwa',{detail:snapshot()}));}
function requestResumeSync(reason){
  clearTimeout(resumeTimer);
  resumeTimer=setTimeout(()=>window.dispatchEvent(new CustomEvent('moneytracker:sync-request',{detail:{reason}})),120);
}

export async function refreshPwaStorage(){
  if(!navigator.storage){
    storageState={...storageState,supported:false,persisted:null,usage:0,quota:0,usageRatio:0};
    emit();return snapshot();
  }
  try{
    const [persisted,estimate]=await Promise.all([
      navigator.storage.persisted?.().catch(()=>false)??false,
      navigator.storage.estimate?.().catch(()=>({}))??{}
    ]);
    const usage=Number(estimate?.usage)||0,quota=Number(estimate?.quota)||0;
    storageState={...storageState,supported:true,persisted:Boolean(persisted),usage,quota,usageRatio:quota>0?usage/quota:0};
  }catch{}
  emit();return snapshot();
}

export async function requestPersistentStorage(){
  if(!navigator.storage?.persist)return false;
  storageState={...storageState,persistenceRequested:true};emit();
  let granted=false;
  try{granted=Boolean(await navigator.storage.persist());}catch{}
  await refreshPwaStorage();
  return granted||storageState.persisted===true;
}

export async function registerBackgroundSync(){
  if(!registration)return false;
  backgroundState={
    ...backgroundState,
    supported:Boolean(registration.sync?.register),
    periodicSupported:Boolean(registration.periodicSync?.register)
  };
  if(!registration.sync?.register){emit();return false;}
  try{
    await registration.sync.register('money-tracker-sync');
    backgroundState={...backgroundState,registered:true,lastRegisteredAt:new Date().toISOString()};
    emit();return true;
  }catch{
    backgroundState={...backgroundState,registered:false};emit();return false;
  }
}

export async function initPwa(){
  window.addEventListener('online',()=>{emit();requestResumeSync('online');});
  window.addEventListener('offline',emit);
  window.addEventListener('pageshow',()=>requestResumeSync('pageshow'));
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredInstallPrompt=event;emit();});
  window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;emit();void refreshPwaStorage();});
  window.addEventListener('moneytracker:sync',event=>{if(Number(event.detail?.pending||0)>0)void registerBackgroundSync();});
  void refreshPwaStorage();
  if(!('serviceWorker' in navigator)){emit();return snapshot();}
  try{
    registration=await navigator.serviceWorker.register('/service-worker.js',{scope:'/',updateViaCache:'none'});
    updateWaiting=Boolean(registration.waiting);
    backgroundState={
      ...backgroundState,
      supported:Boolean(registration.sync?.register),
      periodicSupported:Boolean(registration.periodicSync?.register)
    };
    registration.update().catch(()=>{});
    registration.addEventListener('updatefound',()=>{
      const worker=registration.installing;if(!worker)return;
      worker.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller){updateWaiting=true;emit();}});
    });
    navigator.serviceWorker.addEventListener('controllerchange',()=>{updateWaiting=false;emit();if(activatingUpdate)location.reload();});
    navigator.serviceWorker.addEventListener('message',event=>{
      if(event.data?.type==='MONEY_TRACKER_SYNC_REQUEST')requestResumeSync(event.data.reason||'service-worker');
    });
    window.addEventListener('focus',()=>{registration?.update().catch(()=>{});requestResumeSync('focus');});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){registration?.update().catch(()=>{});requestResumeSync('visible');}});
    if(registration.periodicSync?.register){
      registration.periodicSync.register('money-tracker-periodic-sync',{minInterval:12*60*60*1000}).catch(()=>{});
    }
  }catch{}
  emit();
  return snapshot();
}

export function pwaStatus(){return snapshot();}

export async function installPwa(){
  if(!deferredInstallPrompt)return false;
  const prompt=deferredInstallPrompt;deferredInstallPrompt=null;
  await prompt.prompt();
  const choice=await prompt.userChoice.catch(()=>null);
  emit();
  return choice?.outcome==='accepted';
}

export function activatePwaUpdate(){
  if(!registration?.waiting)return false;
  activatingUpdate=true;registration.waiting.postMessage({type:'SKIP_WAITING'});
  return true;
}
