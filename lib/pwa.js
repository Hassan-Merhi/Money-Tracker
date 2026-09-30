let deferredInstallPrompt=null;
let registration=null;
let updateWaiting=false;
let activatingUpdate=false;
const buildVersion=document.querySelector('meta[name="money-tracker-build"]')?.getAttribute('content')||'dev';

function snapshot(){
  return {
    online:navigator.onLine,
    installable:Boolean(deferredInstallPrompt),
    installed:window.matchMedia?.('(display-mode: standalone)')?.matches||navigator.standalone===true,
    updateWaiting,
    buildVersion
  };
}
function emit(){window.dispatchEvent(new CustomEvent('moneytracker:pwa',{detail:snapshot()}));}

export async function initPwa(){
  window.addEventListener('online',emit);
  window.addEventListener('offline',emit);
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredInstallPrompt=event;emit();});
  window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;emit();});
  if(!('serviceWorker' in navigator)){emit();return snapshot();}
  try{
    registration=await navigator.serviceWorker.register(`/service-worker.js?v=${encodeURIComponent(buildVersion)}`,{scope:'/',updateViaCache:'none'});
    updateWaiting=Boolean(registration.waiting);
    registration.addEventListener('updatefound',()=>{
      const worker=registration.installing;if(!worker)return;
      worker.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller){updateWaiting=true;emit();}});
    });
    navigator.serviceWorker.addEventListener('controllerchange',()=>{updateWaiting=false;emit();if(activatingUpdate)location.reload();});
    window.addEventListener('focus',()=>registration?.update().catch(()=>{}));
    setInterval(()=>registration?.update().catch(()=>{}),15*60_000);
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
