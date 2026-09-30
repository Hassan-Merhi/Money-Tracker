const ASSET_VERSION='__ASSET_VERSION__';
const CACHE=`money-tracker-shell-${ASSET_VERSION}`;
const CORE_SOURCE=[
  '/','/index.html','/styles.css','/dashboard.css','/mobile.css','/activity.css','/lib/dashboard-ui.js','/theme-init.js','/app.js',
  '/block-c-import.js','/block-c-import.css','/block-e-recurring.js','/block-e-recurring.css',
  '/block-f-bank-feed.js','/block-f-bank-feed.css','/block-g-insights.js','/block-g-insights.css',
  '/manifest.webmanifest','/assets/icon.svg',
  '/lib/ledger.js','/lib/money.js','/lib/store.js','/lib/utils.js','/lib/pwa.js',
  '/lib/recurring.js','/lib/recurring-rule-form.js','/lib/bank-feed.js','/lib/insights.js',
  '/lib/reporting.js','/lib/xlsx.js','/lib/importer.js','/lib/legacy-excel.js','/lib/pdf.js','/lib/reports-ui.js'
];
const VERSIONED_EXT=/\.(?:js|css|svg|png|ico)$/;
const shellUrl=path=>VERSIONED_EXT.test(path)?`${path}?v=${encodeURIComponent(ASSET_VERSION)}`:path;
const CORE=CORE_SOURCE.map(shellUrl);

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE)));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE&&key.startsWith('money-tracker-')).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
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
  const requestVersion=url.searchParams.get('v');
  if(event.request.mode==='navigate'||requestVersion!==ASSET_VERSION){
    event.respondWith(networkFirst(event.request));
    return;
  }
  const revalidatePromise=fetchAndCache(event.request);
  event.waitUntil(revalidatePromise.then(()=>undefined));
  event.respondWith(staleWhileRevalidate(event.request,revalidatePromise));
});
