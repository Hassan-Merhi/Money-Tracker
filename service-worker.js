const CACHE='money-tracker-debt-v15';
const CORE=[
  '/','/index.html','/styles.css','/dashboard.css','/mobile.css?v=activity-v2','/activity.css?v=activity-v2','/lib/dashboard-ui.js','/theme-init.js','/app.js?v=activity-v2',
  '/block-c-import.js','/block-c-import.css','/block-e-recurring.js','/block-e-recurring.css',
  '/block-f-bank-feed.js','/block-f-bank-feed.css','/block-g-insights.js','/block-g-insights.css',
  '/manifest.webmanifest','/assets/icon.svg',
  '/lib/ledger.js','/lib/money.js','/lib/store.js','/lib/utils.js','/lib/pwa.js',
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

async function networkFirst(request){
  try{
    const response=await fetch(request);
    if(response?.ok){const cache=await caches.open(CACHE);cache.put(request,response.clone()).catch(()=>{});}
    return response;
  }catch{
    return await caches.match(request)||await caches.match('/index.html')||Response.error();
  }
}

function fetchAndCache(request){
  return fetch(request).then(async response=>{
    if(response?.ok){const cache=await caches.open(CACHE);await cache.put(request,response.clone()).catch(()=>{});}
    return response;
  }).catch(()=>null);
}

async function staleWhileRevalidate(request,revalidatePromise){
  const cached=await caches.match(request);
  return cached||await revalidatePromise||Response.error();
}

self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(event.request.mode==='navigate'){event.respondWith(networkFirst(event.request));return;}
  event.respondWith(networkFirst(event.request));
});
