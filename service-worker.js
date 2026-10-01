importScripts('/pwa-version.js');
const CACHE=self.MONEY_TRACKER_PWA.cacheName;
const CORE=[
  '/','/index.html','/pwa-version.js','/styles.css','/dashboard.css','/mobile.css?v=mobile-v3','/activity.css?v=mobile-v3','/desktop-tablet.css?v=wave4-v1','/visual-audit.css?v=wave14-v1','/lib/dashboard-ui.js','/theme-init.js','/app.js?v=mobile-v3',
  '/block-c-import.js','/block-c-import.css','/block-e-recurring.js','/block-e-recurring.css',
  '/block-f-bank-feed.js','/block-f-bank-feed.css','/block-g-insights.js','/block-g-insights.css',
  '/manifest.webmanifest','/assets/icon.svg','/assets/icon-192.png','/assets/icon-512.png',
  '/lib/ledger.js','/lib/money.js','/lib/money-parse.js','/lib/store.js','/lib/offline-db.js','/lib/utils.js','/lib/pwa.js',
  '/lib/recurring.js','/lib/recurring-rule-form.js','/lib/bank-feed.js','/lib/insights.js',
  '/lib/reporting.js','/lib/xlsx.js','/lib/importer.js','/lib/legacy-excel.js','/lib/pdf.js','/lib/reports-ui.js'
];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE)));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});

self.addEventListener('message',event=>{
  if(event.data?.type==='SKIP_WAITING')self.skipWaiting();
});

async function requestClientSync(reason){
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  for(const client of windows)client.postMessage({type:'MONEY_TRACKER_SYNC_REQUEST',reason});
}

self.addEventListener('sync',event=>{
  if(event.tag==='money-tracker-sync')event.waitUntil(requestClientSync('background-sync'));
});

self.addEventListener('periodicsync',event=>{
  if(event.tag==='money-tracker-periodic-sync')event.waitUntil(requestClientSync('periodic-sync'));
});

async function currentCache(){return await caches.open(CACHE);}

async function networkFirst(request){
  const cache=await currentCache();
  try{
    const response=await fetch(request,{cache:'no-store'});
    if(response?.ok)cache.put(request,response.clone()).catch(()=>{});
    return response;
  }catch{
    return await cache.match(request)||await cache.match('/index.html')||Response.error();
  }
}

function fetchAndCache(request){
  return currentCache().then(cache=>fetch(request,{cache:'no-store'}).then(async response=>{
    if(response?.ok)await cache.put(request,response.clone()).catch(()=>{});
    return response;
  }).catch(()=>null));
}

async function staleWhileRevalidate(request,revalidatePromise){
  const cache=await currentCache();
  const cached=await cache.match(request);
  return cached||await revalidatePromise||Response.error();
}

self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(event.request.mode==='navigate'){event.respondWith(networkFirst(event.request));return;}
  const revalidatePromise=fetchAndCache(event.request);
  event.waitUntil(revalidatePromise.then(()=>undefined));
  event.respondWith(staleWhileRevalidate(event.request,revalidatePromise));
});
