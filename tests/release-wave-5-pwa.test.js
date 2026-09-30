import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT=dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const read=path=>readFileSync(join(ROOT,path),'utf8');

function contract(){
  const source=read('pwa-version.js');
  const version=Number(/version:(\d+)/.exec(source)?.[1]||0);
  const cacheName=/cacheName:'([^']+)'/.exec(source)?.[1]||'';
  return {version,cacheName};
}

test('Wave 5: one file owns the numeric PWA cache version',()=>{
  const {version,cacheName}=contract(),sw=read('service-worker.js'),server=read('server.mjs');
  assert.ok(Number.isInteger(version)&&version>0);
  assert.equal(cacheName,`money-tracker-debt-v${version}`);
  assert.match(sw,/importScripts\('\/pwa-version\.js'\)/);
  assert.match(sw,/MONEY_TRACKER_PWA\.cacheName/);
  assert.doesNotMatch(sw,/money-tracker-debt-v\d+/);
  assert.match(server,/PWA_VERSION_SOURCE=readFileSync\(join\(ROOT,'pwa-version\.js'\)/);
  assert.match(server,/pwaCacheVersion:PWA_CACHE_VERSION/);
  assert.match(server,/pwaCacheName:PWA_CACHE_NAME/);
  assert.doesNotMatch(server,/pwaCacheVersion:\d+/);
});

test('Wave 5: every offline-shell asset exists and the HTML bootstrap assets are cached',()=>{
  const sw=read('service-worker.js'),html=read('index.html');
  const core=/const CORE=\[([\s\S]*?)\];/.exec(sw)?.[1]||'';
  const urls=[...core.matchAll(/'([^']+)'/g)].map(match=>match[1]);
  assert.ok(urls.length>15);
  for(const url of urls){
    const pathname=url.split('?')[0];
    if(pathname==='/')continue;
    assert.ok(existsSync(join(ROOT,pathname.replace(/^\//,''))),`Missing CORE asset ${url}`);
  }
  const bootstrap=[...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)]
    .map(match=>'/'+match[1])
    .filter(url=>!url.includes('manifest.webmanifest')&&!url.includes('assets/icon.svg'));
  for(const url of bootstrap)assert.ok(urls.includes(url),`HTML bootstrap asset not in CORE: ${url}`);
  assert.ok(urls.includes('/pwa-version.js'));
});

test('Wave 5: activation deletes stale shell caches and runtime reads only the current cache',()=>{
  const sw=read('service-worker.js');
  assert.match(sw,/keys\.filter\(key=>key!==CACHE\).*caches\.delete/);
  assert.match(sw,/async function currentCache\(\)\{return await caches\.open\(CACHE\);\}/);
  assert.match(sw,/const cached=await cache\.match\(request\)/);
  assert.doesNotMatch(sw,/const cached=await caches\.match\(request\)/);
  assert.match(sw,/fetch\(request,\{cache:'no-store'\}\)/);
});

test('Wave 5: update activation remains explicit and reloads only after controller change',()=>{
  const pwa=read('lib/pwa.js'),sw=read('service-worker.js');
  assert.match(pwa,/registration\.addEventListener\('updatefound'/);
  assert.match(pwa,/navigator\.serviceWorker\.addEventListener\('controllerchange'/);
  assert.match(pwa,/registration\.waiting\.postMessage\(\{type:'SKIP_WAITING'\}\)/);
  assert.match(sw,/event\.data\?\.type==='SKIP_WAITING'/);
  assert.match(sw,/self\.skipWaiting\(\)/);
});

test('Wave 5: service worker and version contract are served update-safe',()=>{
  const server=read('server.mjs');
  assert.match(server,/base==='service-worker\.js'\|\|base==='pwa-version\.js'/);
  assert.match(server,/\?'no-cache':'public, max-age=300'/);
});
