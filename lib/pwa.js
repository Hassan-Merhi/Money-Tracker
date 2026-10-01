let deferredInstallPrompt=null;
let registration=null;
let updateWaiting=false;
let activatingUpdate=false;
let resumeTimer=null;
let updateInfo={version:null,offlineDbVersion:null,compatible:null,reason:''};
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
    update:{...updateInfo},
    storage:{...storageState},
    backgroundSync:{...backgroundState}
  };
}
function emit(){window.dispatchEvent(new CustomEvent('moneytracker:pwa',{detail:snapshot()}));}
function requestResumeSync(reason){
  clearTimeout(resumeTimer);
  resumeTimer=setTimeout(()=>window.dispatchEvent(new CustomEvent('moneytracker:sync-request',{detail:{reason}})),120);
}

async function waitingWorkerInfo(worker=registration?.waiting){
  if(!worker)return null;
  if(typeof MessageChannel==='undefined')return null;
  return await new Promise(resolve=>{
    const channel=new MessageChannel();
    const timer=setTimeout(()=>resolve(null),1200);
    channel.port1.onmessage=event=>{clearTimeout(timer);resolve(event.data||null);};
    try{worker.postMessage({type:'GET_UPDATE_INFO'},[channel.port2]);}catch{clearTimeout(timer);resolve(null);}
  });
}

async function refreshUpdateInfo(currentOfflineDbVersion=null){
  updateWaiting=Boolean(registration?.waiting);
  if(!updateWaiting){
    updateInfo={version:null,offlineDbVersion:null,compatible:null,reason:''};
    emit();return snapshot();
  }
  const info=await waitingWorkerInfo();
  const targetDb=Number(info?.offlineDbVersion);
  const currentDb=Number(currentOfflineDbVersion);
  const compatible=!Number.isInteger(targetDb)||!Number.isInteger(currentDb)||targetDb<=currentDb;
  updateInfo={
    version:Number.isInteger(Number(info?.version))?Number(info.version):null,
    offlineDbVersion:Number.isInteger(targetDb)?targetDb:null,
    compatible,
    reason:compatible?'':'Reload the current app once before applying this update so its offline database migration can run safely.'
  };
  emit();return snapshot();
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

export async function initPwa({offlineDbVersion=null}={}){
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
    backgroundState={
      ...backgroundState,
      supported:Boolean(registration.sync?.register),
      periodicSupported:Boolean(registration.periodicSync?.register)
    };
    await refreshUpdateInfo(offlineDbVersion);
    registration.update().catch(()=>{});
    registration.addEventListener('updatefound',()=>{
      const worker=registration.installing;if(!worker)return;
      worker.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)void refreshUpdateInfo(offlineDbVersion);});
    });
    navigator.serviceWorker.addEventListener('controllerchange',()=>{updateWaiting=false;updateInfo={version:null,offlineDbVersion:null,compatible:null,reason:''};emit();if(activatingUpdate)location.reload();});
    navigator.serviceWorker.addEventListener('message',event=>{
      if(event.data?.type==='MONEY_TRACKER_SYNC_REQUEST')requestResumeSync(event.data.reason||'service-worker');
    });
    window.addEventListener('focus',()=>{registration?.update().catch(()=>{});requestResumeSync('focus');void refreshUpdateInfo(offlineDbVersion);});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){registration?.update().catch(()=>{});requestResumeSync('visible');void refreshUpdateInfo(offlineDbVersion);}});
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

export function canActivatePwaUpdate({pendingCount=0,currentOfflineDbVersion=null}={}){
  if(!registration?.waiting)return {allowed:false,reason:'No app update is waiting.'};
  if(Number(pendingCount)>0)return {allowed:false,reason:'Sync or resolve queued offline changes before updating the app.'};
  const target=Number(updateInfo.offlineDbVersion),current=Number(currentOfflineDbVersion);
  if(Number.isInteger(target)&&Number.isInteger(current)&&target>current)return {allowed:false,reason:updateInfo.reason||'The offline database must migrate before this update can activate.'};
  return {allowed:true,reason:''};
}

export function activatePwaUpdate(options={}){
  const check=canActivatePwaUpdate(options);
  if(!check.allowed)return check;
  activatingUpdate=true;
  registration.waiting.postMessage({type:'SKIP_WAITING'});
  return {allowed:true,reason:''};
}
