const CACHE='money-tracker-auth-v2';
const ASSETS=['/','/index.html','/styles.css','/app.js','/block-c-import.js','/block-c-import.css','/block-e-recurring.js','/block-e-recurring.css','/block-f-bank-feed.js','/block-f-bank-feed.css','/lib/bank-feed.js','/block-g-insights.js','/block-g-insights.css','/lib/insights.js','/manifest.webmanifest','/assets/icon.svg','/lib/ledger.js','/lib/store.js','/lib/recurring.js','/lib/recurring-rule-form.js','/lib/utils.js','/lib/reporting.js','/lib/xlsx.js','/lib/importer.js','/lib/pdf.js','/lib/reports-ui.js'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'||new URL(e.request.url).pathname.startsWith('/api/'))return;
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).catch(()=>caches.match('/index.html'))); return;
  }
  e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r;})));
});
