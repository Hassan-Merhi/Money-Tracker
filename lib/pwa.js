let deferredInstallPrompt=null;
let registration=null;
let updateWaiting=false;

function snapshot(){
  return {
    online:navigator.onLine,
    installable:Boolean(deferredInstallPrompt),
    installed:window.matchMedia?.('(display-mode: standalone)')?.matches||navigator.standalone===true,
    updateWaiting
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
    registration=await navigator.serviceWorker.register('/service-worker.js',{scope:'/'});
    updateWaiting=Boolean(registration.waiting);
    registration.addEventListener('updatefound',()=>{
      const worker=registration.installing;if(!worker)return;
      worker.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller){updateWaiting=true;emit();}});
    });
    navigator.serviceWorker.addEventListener('controllerchange',()=>{updateWaiting=false;emit();});
    window.addEventListener('focus',()=>registration?.update().catch(()=>{}));
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
  registration.waiting.postMessage({type:'SKIP_WAITING'});
  return true;
}
