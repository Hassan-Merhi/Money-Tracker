const DEFAULT_TIMEOUT_MS=10_000;
const DEFAULT_WAIT_MS=12*60_000;
const DEFAULT_INTERVAL_MS=10_000;

function invariant(condition,message){
  if(!condition)throw new Error(message);
}

function normalizedBaseUrl(value){
  const url=new URL(String(value||'').trim());
  invariant(['http:','https:'].includes(url.protocol),'Production smoke URL must use HTTP(S).');
  url.pathname='/';
  url.search='';
  url.hash='';
  return url.toString().replace(/\/$/,'');
}

async function request(baseUrl,path,{method='GET',headers={},body,timeoutMs=DEFAULT_TIMEOUT_MS}={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetch(new URL(path,baseUrl),{
      method,
      headers:{'user-agent':'money-tracker-wave13-smoke/1',...headers},
      body,
      redirect:'follow',
      cache:'no-store',
      signal:controller.signal
    });
    const text=await response.text();
    let json=null;
    if((response.headers.get('content-type')||'').includes('application/json')){
      try{json=JSON.parse(text);}catch{}
    }
    return {response,status:response.status,headers:response.headers,text,json,url:response.url};
  }finally{
    clearTimeout(timer);
  }
}

function assertStatus(result,status,label){
  invariant(result.status===status,`${label} returned HTTP ${result.status}, expected ${status}.`);
}

function parsePwaVersion(source){
  return {
    version:Number(/version:(\d+)/.exec(source)?.[1]||0),
    cacheName:/cacheName:'([^']+)'/.exec(source)?.[1]||''
  };
}

function criticalAssetsFromHtml(html){
  const assets=new Set([
    '/styles.css',
    '/dashboard.css',
    '/mobile.css',
    '/activity.css',
    '/desktop-tablet.css',
    '/app.js',
    '/service-worker.js',
    '/pwa-version.js',
    '/manifest.webmanifest',
    '/assets/icon.svg'
  ]);
  for(const match of String(html).matchAll(/(?:href|src)=["']([^"'#]+)["']/g)){
    const raw=match[1];
    if(raw.startsWith('./'))assets.add('/'+raw.slice(2));
    else if(raw.startsWith('/'))assets.add(raw);
  }
  return [...assets];
}

function safeCookie(setCookie){
  return String(setCookie||'').split(';')[0].trim();
}

async function authenticatedReadChecks(baseUrl,credentials,timeoutMs){
  const login=await request(baseUrl,'/api/auth/login',{
    method:'POST',
    timeoutMs,
    headers:{'content-type':'application/json','origin':baseUrl},
    body:JSON.stringify({email:credentials.email,password:credentials.password})
  });
  assertStatus(login,200,'Authenticated smoke login');
  invariant(login.json?.csrfToken,'Authenticated smoke login did not return a CSRF token.');
  const cookie=safeCookie(login.headers.get('set-cookie'));
  invariant(cookie.startsWith('mot_session='),'Authenticated smoke login did not return the session cookie.');

  const common={timeoutMs,headers:{cookie}};
  const me=await request(baseUrl,'/api/auth/me',common);
  assertStatus(me,200,'Authenticated /api/auth/me');
  invariant(Boolean(me.json?.user?.id),'Authenticated /api/auth/me returned no user.');

  const state=await request(baseUrl,'/api/state',common);
  assertStatus(state,200,'Authenticated /api/state');
  invariant(Array.isArray(state.json?.people),'Production state read is missing people[].');
  invariant(Array.isArray(state.json?.accounts),'Production state read is missing accounts[].');
  invariant(Array.isArray(state.json?.entries),'Production state read is missing entries[].');
  invariant(state.json?.settings&&typeof state.json.settings==='object','Production state read is missing settings.');

  const sessions=await request(baseUrl,'/api/auth/sessions',common);
  assertStatus(sessions,200,'Authenticated /api/auth/sessions');
  invariant(Array.isArray(sessions.json?.sessions),'Authenticated sessions read returned an invalid payload.');

  const logout=await request(baseUrl,'/api/auth/logout',{
    method:'POST',
    timeoutMs,
    headers:{cookie,'x-csrf-token':login.json.csrfToken,'origin':baseUrl},
    body:''
  });
  assertStatus(logout,200,'Authenticated smoke logout');

  return {
    email:me.json.user.email||null,
    people:state.json.people.length,
    accounts:state.json.accounts.length,
    entries:state.json.entries.length,
    sessions:sessions.json.sessions.length
  };
}

async function waitForExpectedDeployment(baseUrl,{expectedCommit='',waitMs=DEFAULT_WAIT_MS,intervalMs=DEFAULT_INTERVAL_MS,timeoutMs=DEFAULT_TIMEOUT_MS}={}){
  const deadline=Date.now()+Math.max(0,waitMs);
  let lastError=null;
  for(;;){
    try{
      const health=await request(baseUrl,'/api/health',{timeoutMs});
      if(health.status===200&&health.json?.ok===true){
        const liveCommit=String(health.json?.deployment?.gitCommit||'');
        if(!expectedCommit||liveCommit===expectedCommit)return health;
        lastError=new Error(`Production is healthy but still serves commit ${liveCommit||'unknown'}; waiting for ${expectedCommit}.`);
      }else{
        lastError=new Error(`Production health returned HTTP ${health.status}.`);
      }
    }catch(error){
      lastError=error;
    }
    if(Date.now()>=deadline)throw lastError||new Error('Production did not become ready before the smoke-test deadline.');
    await new Promise(resolve=>setTimeout(resolve,Math.min(intervalMs,Math.max(100,deadline-Date.now()))));
  }
}

export async function runProductionSmoke({
  baseUrl,
  expectedCommit='',
  waitMs=DEFAULT_WAIT_MS,
  intervalMs=DEFAULT_INTERVAL_MS,
  timeoutMs=DEFAULT_TIMEOUT_MS,
  credentials=null
}={}){
  const base=normalizedBaseUrl(baseUrl);
  const health=await waitForExpectedDeployment(base,{expectedCommit,waitMs,intervalMs,timeoutMs});
  const healthBody=health.json;

  invariant(healthBody.runtime?.ok===true,'Health reports runtime diagnostics as unhealthy.');
  invariant(healthBody.runtime?.sqliteQuickCheck==='ok','SQLite quick_check is not ok.');
  invariant(Number(healthBody.runtime?.foreignKeyViolations||0)===0,'SQLite foreign-key violations were reported.');
  invariant(Number(healthBody.pwaCacheVersion)>0,'Health did not publish the PWA cache version.');
  invariant(String(healthBody.pwaCacheName||'')===`money-tracker-debt-v${healthBody.pwaCacheVersion}`,'Health PWA cache contract is inconsistent.');
  invariant(Number(healthBody.wave13Version||0)>=1,'Health did not publish the Wave 13 production-smoke contract.');
  invariant(Number(healthBody.offlineWave100AVersion||0)>=1,'Health did not publish the Wave 100A Offline Bank Feed contract.');
  invariant(Boolean(healthBody.buildVersion),'Health did not publish buildVersion.');
  if(expectedCommit)invariant(healthBody.deployment?.gitCommit===expectedCommit,'Live commit does not match the expected deployment.');

  const root=await request(base,'/',{timeoutMs});
  assertStatus(root,200,'Application shell');
  invariant((root.headers.get('content-type')||'').includes('text/html'),'Application shell is not HTML.');
  invariant(root.text.includes('Money Owed Tracker'),'Application shell is missing the product title.');

  const assets=criticalAssetsFromHtml(root.text);
  const checkedAssets=[];
  for(const asset of assets){
    const result=await request(base,asset,{timeoutMs});
    assertStatus(result,200,`Asset ${asset}`);
    invariant(result.text.length>0,`Asset ${asset} is empty.`);
    checkedAssets.push(asset);
  }

  const sw=await request(base,'/service-worker.js',{timeoutMs});
  assertStatus(sw,200,'Service worker');
  invariant(sw.headers.get('service-worker-allowed')==='/' ,'Service worker is not allowed to control the application root.');
  invariant(/importScripts\(['"]\/pwa-version\.js['"]\)/.test(sw.text),'Service worker does not consume the authoritative PWA version.');

  const pwa=await request(base,'/pwa-version.js',{timeoutMs});
  assertStatus(pwa,200,'PWA version');
  const parsed=parsePwaVersion(pwa.text);
  invariant(parsed.version===Number(healthBody.pwaCacheVersion),'Live pwa-version.js does not match /api/health.');
  invariant(parsed.cacheName===String(healthBody.pwaCacheName),'Live PWA cache name does not match /api/health.');

  const manifest=await request(base,'/manifest.webmanifest',{timeoutMs});
  assertStatus(manifest,200,'Web app manifest');
  const manifestJson=JSON.parse(manifest.text);
  invariant(Boolean(manifestJson.name||manifestJson.short_name),'Web app manifest has no app name.');
  invariant(Boolean(manifestJson.start_url),'Web app manifest has no start_url.');

  const authStatus=await request(base,'/api/auth/status',{timeoutMs});
  assertStatus(authStatus,200,'Auth status');
  invariant(typeof authStatus.json?.registrationOpen==='boolean','Auth status returned an invalid payload.');

  const anonymousMe=await request(base,'/api/auth/me',{timeoutMs});
  assertStatus(anonymousMe,401,'Anonymous /api/auth/me boundary');
  const anonymousState=await request(base,'/api/state',{timeoutMs});
  assertStatus(anonymousState,401,'Anonymous /api/state boundary');

  let authenticatedReads=null;
  if(credentials?.email&&credentials?.password){
    authenticatedReads=await authenticatedReadChecks(base,credentials,timeoutMs);
  }

  return {
    ok:true,
    baseUrl:base,
    buildVersion:healthBody.buildVersion,
    gitCommit:healthBody.deployment?.gitCommit||null,
    provider:healthBody.deployment?.provider||null,
    pwaCacheVersion:healthBody.pwaCacheVersion,
    database:{
      sqliteQuickCheck:healthBody.runtime.sqliteQuickCheck,
      foreignKeyViolations:healthBody.runtime.foreignKeyViolations,
      dbBytes:healthBody.runtime.dbBytes
    },
    assetsChecked:checkedAssets.length,
    authentication:{
      boundaries:true,
      authenticatedReads:Boolean(authenticatedReads),
      readSummary:authenticatedReads
    }
  };
}
