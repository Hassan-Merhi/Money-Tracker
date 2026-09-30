import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const work=mkdtempSync(join(tmpdir(),'mot-browser-e2e-'));
const dataDir=join(work,'data');
const profileDir=join(work,'chrome');
const downloadDir=join(work,'downloads');
mkdirSync(dataDir,{recursive:true});
mkdirSync(profileDir,{recursive:true});
mkdirSync(downloadDir,{recursive:true});
const dbPath=join(dataDir,'ledger.sqlite');
const csvPath=join(work,'bank.csv');
writeFileSync(csvPath,'Date,Description,Amount\n2026-09-30,Coffee shop,-12.34\n');

const BUILD_A='a11111111111';
const BUILD_B='b22222222222';
const email='browser-e2e@example.com';
const password='browser e2e password';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){
  const server=createNetServer();
  await new Promise((resolvePromise,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolvePromise));
  const port=server.address().port;
  await new Promise(resolvePromise=>server.close(resolvePromise));
  return port;
}
async function waitHttp(url,{timeout=15000}={}){
  const started=Date.now();
  let last;
  while(Date.now()-started<timeout){
    try{
      const response=await fetch(url);
      if(response.ok)return response;
      last=new Error('HTTP '+response.status);
    }catch(error){last=error;}
    await sleep(120);
  }
  throw last||new Error('Timed out waiting for '+url);
}
function findChrome(){
  if(process.env.CHROME_PATH)return process.env.CHROME_PATH;
  for(const name of ['google-chrome','google-chrome-stable','chromium','chromium-browser']){
    const result=spawnSync('which',[name],{encoding:'utf8'});
    if(result.status===0&&result.stdout.trim())return result.stdout.trim();
  }
  throw new Error('Chromium/Chrome is required for Wave 10 browser E2E.');
}
async function waitExit(child,timeout=8000){
  if(child.exitCode!==null)return;
  await Promise.race([
    new Promise(resolvePromise=>child.once('exit',resolvePromise)),
    sleep(timeout).then(()=>{throw new Error('Process did not exit in time.');})
  ]);
}

let appProcess=null;
let appLogs='';
const appPort=await freePort();
const base=`http://127.0.0.1:${appPort}`;

async function startApp(version){
  if(appProcess)throw new Error('App is already running.');
  appLogs='';
  appProcess=spawn(process.execPath,['server.mjs'],{
    cwd:ROOT,
    env:{...process.env,PORT:String(appPort),NODE_ENV:'test',DATA_DIR:dataDir,DB_PATH:dbPath,TEST_ASSET_VERSION:version},
    stdio:['ignore','pipe','pipe']
  });
  appProcess.stdout.on('data',chunk=>{appLogs+=chunk;});
  appProcess.stderr.on('data',chunk=>{appLogs+=chunk;});
  appProcess.once('exit',code=>{if(code&&code!==0)appLogs+=`\nserver exit ${code}`;});
  await waitHttp(base+'/api/health');
}
async function stopApp(){
  if(!appProcess)return;
  const child=appProcess;
  appProcess=null;
  if(child.exitCode===null)child.kill('SIGTERM');
  try{await waitExit(child);}catch{
    child.kill('SIGKILL');
    await waitExit(child).catch(()=>{});
  }
}

class Cdp {
  constructor(url){
    this.url=url;
    this.ws=null;
    this.nextId=1;
    this.pending=new Map();
    this.listeners=new Map();
  }
  async connect(){
    this.ws=new WebSocket(this.url);
    await new Promise((resolvePromise,reject)=>{
      const timer=setTimeout(()=>reject(new Error('CDP websocket timeout')),10000);
      this.ws.addEventListener('open',()=>{clearTimeout(timer);resolvePromise();},{once:true});
      this.ws.addEventListener('error',event=>{clearTimeout(timer);reject(event.error||new Error('CDP websocket error'));},{once:true});
    });
    this.ws.addEventListener('message',event=>{
      const message=JSON.parse(String(event.data));
      if(message.id){
        const pending=this.pending.get(message.id);
        if(!pending)return;
        this.pending.delete(message.id);
        if(message.error)pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result||{});
        return;
      }
      const handlers=this.listeners.get(message.method)||[];
      for(const handler of handlers)Promise.resolve(handler(message.params||{})).catch(()=>{});
    });
  }
  send(method,params={}){
    if(!this.ws||this.ws.readyState!==WebSocket.OPEN)throw new Error('CDP is not connected.');
    const id=this.nextId++;
    return new Promise((resolvePromise,reject)=>{
      this.pending.set(id,{resolve:resolvePromise,reject,method});
      this.ws.send(JSON.stringify({id,method,params}));
    });
  }
  on(method,handler){
    const handlers=this.listeners.get(method)||[];
    handlers.push(handler);
    this.listeners.set(method,handlers);
  }
  close(){try{this.ws?.close();}catch{}}
}

const chromePath=findChrome();
const debugPort=await freePort();
let chrome=null;
let cdp=null;
const browserErrors=[];
const downloads=[];

async function startChrome(){
  chrome=spawn(chromePath,[
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--window-size=1440,1000',
    base+'/'
  ],{stdio:['ignore','pipe','pipe']});
  let chromeLog='';
  chrome.stderr.on('data',chunk=>{chromeLog+=chunk;});
  chrome.stdout.on('data',chunk=>{chromeLog+=chunk;});
  await waitHttp(`http://127.0.0.1:${debugPort}/json/version`);
  let target;
  for(let i=0;i<80&&!target;i++){
    const list=await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    target=list.find(item=>item.type==='page'&&item.webSocketDebuggerUrl);
    if(!target)await sleep(100);
  }
  if(!target)throw new Error('No Chrome page target found. '+chromeLog);
  cdp=new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  for(const domain of ['Page','Runtime','Network','DOM','Log'])await cdp.send(domain+'.enable').catch(()=>{});
  await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDir,eventsEnabled:true}).catch(async()=>{
    await cdp.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDir}).catch(()=>{});
  });
  cdp.on('Browser.downloadWillBegin',event=>downloads.push(event));
  cdp.on('Page.downloadWillBegin',event=>downloads.push(event));
  cdp.on('Runtime.exceptionThrown',event=>browserErrors.push(event.exceptionDetails?.exception?.description||event.exceptionDetails?.text||'Runtime exception'));
  cdp.on('Log.entryAdded',event=>{if(event.entry?.level==='error')browserErrors.push(event.entry.text);});
  cdp.on('Page.javascriptDialogOpening',async()=>{await cdp.send('Page.handleJavaScriptDialog',{accept:true}).catch(()=>{});});
}

async function evaluate(expression){
  const response=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});
  if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description||response.exceptionDetails.text||'Browser evaluation failed.');
  return response.result?.value;
}
async function waitFor(expression,label,{timeout=12000,interval=80}={}){
  const started=Date.now();
  let last;
  while(Date.now()-started<timeout){
    try{
      const value=await evaluate(expression);
      if(value)return value;
      last=value;
    }catch(error){last=error;}
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}. Last: ${last instanceof Error?last.message:String(last)}`);
}
const jsString=value=>JSON.stringify(String(value));

async function click(selector){
  const s=jsString(selector);
  await waitFor(`Boolean(document.querySelector(${s}))`,selector);
  const ok=await evaluate(`(()=>{const el=document.querySelector(${s});if(!el)return false;el.click();return true;})()`);
  assert.equal(ok,true,`click ${selector}`);
}
async function fill(selector,value,{change=true}={}){
  const s=jsString(selector),v=jsString(value);
  await waitFor(`Boolean(document.querySelector(${s}))`,selector);
  await evaluate(`(()=>{const el=document.querySelector(${s});const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;setter?setter.call(el,${v}):(el.value=${v});el.dispatchEvent(new Event('input',{bubbles:true}));${change?"el.dispatchEvent(new Event('change',{bubbles:true}));":''}return el.value;})()`);
}
async function state(){
  return await evaluate(`fetch('/api/state',{cache:'no-store'}).then(async r=>{if(!r.ok)throw new Error('state '+r.status);return r.json();})`);
}
async function health(){
  return await evaluate(`fetch('/api/health',{cache:'no-store'}).then(r=>r.json())`);
}
async function waitState(predicate,label,timeout=12000){
  const source=typeof predicate==='function'?predicate.toString():String(predicate);
  return waitFor(`fetch('/api/state',{cache:'no-store'}).then(r=>r.json()).then(s=>(${source})(s))`,label,{timeout});
}
async function setFile(selector,path){
  const doc=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});
  const node=await cdp.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector});
  if(!node.nodeId)throw new Error('File input not found: '+selector);
  await cdp.send('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[resolve(path)]});
}
async function waitDownload(extension,fromCount){
  const started=Date.now();
  while(Date.now()-started<12000){
    const match=downloads.slice(fromCount).find(item=>String(item.suggestedFilename||'').toLowerCase().endsWith(extension));
    if(match)return match;
    await sleep(80);
  }
  throw new Error(`Expected ${extension} download; got ${JSON.stringify(downloads.slice(fromCount))}`);
}
async function navigateHash(hash){
  await evaluate(`location.hash=${jsString(hash)}`);
  await waitFor(`location.hash===${jsString(hash)}`,hash);
  await sleep(120);
}

try{
  await startApp(BUILD_A);
  await startChrome();
  await waitFor(`Boolean(document.querySelector('#authForm'))`,'auth form');

  // Register owner in the real browser.
  await click('[data-auth-tab="register"]');
  await fill('#authForm [name="email"]',email);
  await fill('#authForm [name="password"]',password);
  await click('#authForm button[type="submit"]');
  await waitFor(`document.querySelector('#pageHeading')?.textContent==='Dashboard'`,'dashboard after registration');
  assert.equal((await state()).people.length,0);

  // Simple mode: person -> debt -> repayment.
  await navigateHash('#people');
  await click('#addPerson');
  await fill('#personForm [name="name"]','Alice Browser');
  await fill('#personForm [name="note"]','Wave 10 E2E');
  await click('#modalSave');
  await waitState(s=>s.people?.some(p=>p.name==='Alice Browser'),'Alice person created');
  let current=await state();
  const alice=current.people.find(p=>p.name==='Alice Browser');
  assert.ok(alice?.id);

  await click('#quickEntry');
  await click('[data-fast-type="paid_for_person"]');
  await fill('#txnPerson',alice.id);
  await fill('#txnAmount','125.50');
  await fill('#txnForm [name="merchant"]','Amazon');
  await fill('#txnForm [name="description"]','Browser debt');
  await click('#modalSave');
  await waitState(s=>s.entries?.some(e=>e.type==='paid_for_person'&&e.personId===alice.id&&e.amount===125.5),'debt entry saved');

  await click('#quickEntry');
  await click('[data-fast-type="received_from_person"]');
  await fill('#txnPerson',alice.id);
  await fill('#txnAmount','25.50');
  await fill('#txnForm [name="description"]','Browser repayment');
  await click('#modalSave');
  await waitState(s=>s.entries?.some(e=>e.type==='received_from_person'&&e.personId===alice.id&&e.amount===25.5),'repayment saved');

  // Statement, PDF, edit and delete.
  await navigateHash(`#person?id=${encodeURIComponent(alice.id)}`);
  await waitFor(`document.querySelector('.statement-hero-balance')?.textContent.includes('100')`,'statement balance 100');
  let before=downloads.length;
  await click('#personPdf');
  await waitDownload('.pdf',before);

  current=await state();
  const debt=current.entries.find(e=>e.type==='paid_for_person'&&e.personId===alice.id);
  const repayment=current.entries.find(e=>e.type==='received_from_person'&&e.personId===alice.id);
  await click(`[data-menu-trigger="${debt.id}"]`);
  await click(`[data-edit-entry="${debt.id}"]`);
  await fill('#txnAmount','150.50');
  await fill('#txnForm [name="description"]','Browser debt edited');
  await click('#modalSave');
  await waitState(s=>s.entries?.some(e=>e.id===debt.id&&e.amount===150.5),'edited debt');

  await click(`[data-menu-trigger="${repayment.id}"]`);
  await click(`[data-delete-entry="${repayment.id}"]`);
  await waitState(s=>!s.entries?.some(e=>e.id===repayment.id),'repayment deleted');
  await waitFor(`document.querySelector('.statement-hero-balance')?.textContent.includes('150')`,'statement after edit/delete');

  // Import is reachable from People without returning it to Reports/Settings.
  await navigateHash('#people');
  await click('#peopleImport');
  await click('#peoplePasteExcel');
  await waitFor(`Boolean(document.querySelector('#impQuickPaste'))`,'quick paste importer');
  await fill('#impQuickPaste','Name\tAmount\tDirection\tMerchant / Source\tDate\tDescription\tCurrency\nBob Browser\t40\tThey owe me\tImported\t30/09/2026\tQuick paste\tUSD',{change:false});
  await click('#impQuickApply');
  await waitState(s=>s.people?.some(p=>p.name==='Bob Browser'),'quick paste imported person',16000);
  current=await state();
  assert.ok(current.entries.some(e=>e.description==='Quick paste'));

  // Switch to Advanced and verify persistence across reload.
  await navigateHash('#settings');
  await fill('#settingMode','advanced');
  await click('#saveSettings');
  await waitState(s=>s.settings?.appMode==='advanced','Advanced mode persisted');
  await cdp.send('Page.reload',{ignoreCache:false});
  await waitFor(`Boolean(document.querySelector('#pageHeading'))`,'reload after mode switch');
  assert.equal((await state()).settings.appMode,'advanced');
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-nav="accounts"]'))`),true);

  // Accounts and same-currency transfer.
  await navigateHash('#accounts');
  for(const [name,opening] of [['Cash Browser A','500'],['Cash Browser B','100']]){
    await click('#addAccount');
    await fill('#accountForm [name="name"]',name);
    await fill('#accountForm [name="type"]','cash');
    await fill('#accountForm [name="currency"]','USD');
    await fill('#accountForm [name="openingBalance"]',opening);
    await click('#modalSave');
    await waitState(s=>s.accounts?.some(a=>a.name===name),name+' created');
  }
  current=await state();
  const accountA=current.accounts.find(a=>a.name==='Cash Browser A');
  const accountB=current.accounts.find(a=>a.name==='Cash Browser B');
  await click('#transferBtn');
  await fill('#fromAccount',accountA.id);
  await fill('#toAccount',accountB.id);
  await fill('#transferForm [name="fromAmount"]','50');
  await fill('#transferForm [name="toAmount"]','50');
  await fill('#transferForm [name="description"]','Browser transfer');
  await click('#modalSave');
  await waitState(s=>s.entries?.some(e=>e.type==='account_transfer'&&e.description==='Browser transfer'),'transfer saved');

  // Reports export through the actual three-dot menu.
  await navigateHash('#reports');
  before=downloads.length;
  await click('#reportExportTrigger');
  await click('#exportPdf');
  await waitDownload('.pdf',before);
  before=downloads.length;
  await click('#reportExportTrigger');
  await click('#exportXlsx');
  await waitDownload('.xlsx',before);

  // Bank Feed file import -> post -> undo.
  await navigateHash('#bank');
  await waitFor(`Boolean(document.querySelector('#bankFile'))`,'Bank Feed file input');
  await fill('#bankAccount',accountA.id);
  await setFile('#bankFile',csvPath);
  await waitFor(`Boolean(document.querySelector('#bankImportNow'))`,'Bank Feed mapping preview',{timeout:16000});
  await click('#bankImportNow');
  await waitFor(`Boolean(document.querySelector('.bank-post'))`,'pending Bank Feed row',{timeout:16000});
  await click('.bank-post');
  await waitState(s=>s.entries?.some(e=>e.type==='account_expense'&&Math.abs(e.amount-12.34)<0.000001),'Bank Feed expense posted',16000);
  await click('[data-bank-status="posted"]');
  await waitFor(`Boolean(document.querySelector('.bank-undo'))`,'posted Bank Feed row');
  await click('.bank-undo');
  await waitState(s=>!s.entries?.some(e=>e.type==='account_expense'&&Math.abs(e.amount-12.34)<0.000001),'Bank Feed posting undone',16000);

  // Phone viewport and navigation containment.
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true,screenWidth:390,screenHeight:844});
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  await cdp.send('Page.reload',{ignoreCache:false});
  await waitFor(`Boolean(document.querySelector('.mobile-nav'))`,'mobile nav');
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth+1`),true,'phone viewport must not overflow horizontally');
  assert.equal(await evaluate(`document.querySelectorAll('.mobile-nav button').length`),5);
  await click('.mobile-nav [data-nav="people"]');
  await waitFor(`document.querySelector('#pageHeading')?.textContent==='People'`,'mobile People');
  await click('#mobileMore');
  await waitFor(`Boolean(document.querySelector('[data-more-nav="reports"]'))`,'mobile More sheet');
  await click('[data-more-nav="reports"]');
  await waitFor(`document.querySelector('#pageHeading')?.textContent==='Reports'`,'mobile Reports');

  // PWA cache/offline shell on the first build.
  await waitFor(`navigator.serviceWorker?.ready.then(()=>true).catch(()=>false)`,'service worker ready',{timeout:20000});
  if(!(await evaluate(`Boolean(navigator.serviceWorker.controller)`))){
    await cdp.send('Page.reload',{ignoreCache:false});
    await waitFor(`Boolean(navigator.serviceWorker.controller)`,'service worker controller',{timeout:20000});
  }
  let activeHealth=await health();
  assert.equal(activeHealth.assetVersion,BUILD_A);
  assert.equal(await evaluate(`caches.keys().then(keys=>keys.includes('money-tracker-shell-${BUILD_A}'))`),true);
  assert.equal(await evaluate(`navigator.serviceWorker.getRegistration().then(r=>Boolean(r?.active))`),true);

  await cdp.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
  await cdp.send('Page.reload',{ignoreCache:false});
  await waitFor(`document.title==='Money Owed Tracker'&&document.querySelector('#app')?.textContent.length>0`,'offline app shell',{timeout:20000});
  assert.equal(await evaluate(`navigator.onLine`),false);
  await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await cdp.send('Page.reload',{ignoreCache:false});
  await waitFor(`Boolean(document.querySelector('#pageHeading'))`,'online reconnect',{timeout:20000});

  // Build update: same origin, new release fingerprint, waiting worker, apply, reload.
  await stopApp();
  await startApp(BUILD_B);
  assert.equal((await (await fetch(base+'/api/health')).json()).assetVersion,BUILD_B);
  await evaluate(`navigator.serviceWorker.getRegistration().then(r=>r?.update())`);
  await waitFor(`Boolean(document.querySelector('#applyUpdate')||document.querySelector('#settingsApplyUpdate'))`,'PWA update ready',{timeout:25000});
  const applySelector=await evaluate(`document.querySelector('#applyUpdate')?'#applyUpdate':'#settingsApplyUpdate'`);
  await click(applySelector);
  await waitFor(`document.querySelector('meta[name="money-tracker-build"]')?.content==='${BUILD_B}'`,'new build after update',{timeout:25000});
  await waitFor(`caches.keys().then(keys=>keys.includes('money-tracker-shell-${BUILD_B}'))`,'new PWA cache',{timeout:25000});
  activeHealth=await health();
  assert.equal(activeHealth.assetVersion,BUILD_B);

  // Logout/login proves session lifecycle and persisted ledger survive reload/update.
  await navigateHash('#settings');
  await click('#settingsLogout');
  await waitFor(`Boolean(document.querySelector('#authForm'))`,'logged out');
  await fill('#authForm [name="email"]',email);
  await fill('#authForm [name="password"]',password);
  await click('#authForm button[type="submit"]');
  await waitFor(`document.querySelector('#pageHeading')?.textContent==='Dashboard'`,'logged back in',{timeout:16000});
  current=await state();
  assert.ok(current.people.some(p=>p.name==='Alice Browser'));
  assert.ok(current.people.some(p=>p.name==='Bob Browser'));
  assert.ok(current.accounts.some(a=>a.name==='Cash Browser A'));
  assert.ok(current.entries.some(e=>e.type==='account_transfer'&&e.description==='Browser transfer'));

  const meaningfulErrors=browserErrors.filter(message=>!/(Failed to fetch|net::ERR_INTERNET_DISCONNECTED)/i.test(message));
  assert.deepEqual(meaningfulErrors,[],`browser console/runtime errors:\n${meaningfulErrors.join('\n')}`);

  console.log(JSON.stringify({
    ok:true,
    browser:chromePath,
    people:current.people.length,
    accounts:current.accounts.length,
    entries:current.entries.length,
    downloads:downloads.map(item=>item.suggestedFilename),
    builds:[BUILD_A,BUILD_B]
  }));
} catch(error){
  console.error('WAVE10_BROWSER_E2E_FAILED');
  console.error(error?.stack||error);
  if(appLogs)console.error('\nSERVER LOGS\n'+appLogs);
  process.exitCode=1;
} finally {
  try{cdp?.close();}catch{}
  if(chrome?.exitCode===null)chrome.kill('SIGTERM');
  await stopApp().catch(()=>{});
  rmSync(work,{recursive:true,force:true});
}
