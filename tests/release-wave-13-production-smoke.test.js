import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { runProductionSmoke } from '../lib/production-smoke.js';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

function fixtureServer({commit='abc123',brokenAsset=false}={}){
  const version=39;
  const html='<!doctype html><title>Money Owed Tracker</title><link rel="stylesheet" href="./styles.css"><script type="module" src="./app.js?v=mobile-v3"></script>';
  return http.createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/api/health'){
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({
        ok:true,wave13Version:1,offlineWave100AVersion:1,offlineWave100BVersion:1,offlineWave100CVersion:1,offlineWave100DVersion:1,offlineWave100EVersion:1,offlineWave100FVersion:1,offlineWave100GVersion:1,offlineWave100HVersion:1,offlineWave100IVersion:1,buildVersion:'pwa-39+'+commit.slice(0,12),
        pwaCacheVersion:version,pwaCacheName:'money-tracker-debt-v39',
        deployment:{provider:'test',gitCommit:commit},
        dataLimits:{entries:50000,syncChangeRevisions:10000},runtime:{ok:true,sqliteQuickCheck:'ok',foreignKeyViolations:0,dbBytes:123}
      }));return;
    }
    if(path==='/api/auth/status'){res.setHeader('content-type','application/json');res.end(JSON.stringify({registrationOpen:false}));return;}
    if(path==='/api/auth/me'||path==='/api/state'){res.statusCode=401;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:'Sign in required.'}));return;}
    if(path==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end(html);return;}
    if(path==='/service-worker.js'){res.setHeader('service-worker-allowed','/');res.setHeader('content-type','text/javascript');res.end("importScripts('/pwa-version.js');");return;}
    if(path==='/pwa-version.js'){res.setHeader('content-type','text/javascript');res.end("self.MONEY_TRACKER_PWA=Object.freeze({version:39,cacheName:'money-tracker-debt-v39'});");return;}
    if(path==='/manifest.webmanifest'){res.setHeader('content-type','application/manifest+json');res.end(JSON.stringify({name:'Money Owed Tracker',start_url:'/'}));return;}
    if(brokenAsset&&path==='/styles.css'){res.statusCode=404;res.end('missing');return;}
    if(['/styles.css','/dashboard.css','/mobile.css','/activity.css','/desktop-tablet.css','/app.js','/assets/icon.svg'].includes(path)){res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/plain');res.end('ok');return;}
    res.statusCode=404;res.end('not found');
  });
}

async function withServer(server,fn){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  try{return await fn('http://127.0.0.1:'+address.port);}
  finally{await new Promise(resolve=>server.close(resolve));}
}

test('Wave 13 smoke runner validates health, build identity, assets, PWA, DB and auth boundaries',async()=>{
  await withServer(fixtureServer(),async baseUrl=>{
    const report=await runProductionSmoke({baseUrl,expectedCommit:'abc123',waitMs:0,intervalMs:10});
    assert.equal(report.ok,true);
    assert.equal(report.gitCommit,'abc123');
    assert.equal(report.database.sqliteQuickCheck,'ok');
    assert.equal(report.authentication.boundaries,true);
    assert.ok(report.assetsChecked>=8);
  });
});

test('Wave 13 fails a stale deployment commit',async()=>{
  await withServer(fixtureServer({commit:'oldsha'}),async baseUrl=>{
    await assert.rejects(
      runProductionSmoke({baseUrl,expectedCommit:'newsha',waitMs:0,intervalMs:10}),
      /waiting for newsha/
    );
  });
});

test('Wave 13 fails when a critical production asset is missing',async()=>{
  await withServer(fixtureServer({brokenAsset:true}),async baseUrl=>{
    await assert.rejects(
      runProductionSmoke({baseUrl,expectedCommit:'abc123',waitMs:0,intervalMs:10}),
      /Asset \/styles\.css returned HTTP 404/
    );
  });
});

test('Wave 13 is wired into production startup, Render and GitHub deployment verification',()=>{
  const server=read('server.mjs');
  const render=read('render.yaml');
  const workflow=read('.github/workflows/production-smoke.yml');
  assert.match(server,/WAVE13_PRODUCTION_SMOKE_OK/);
  assert.match(server,/PRODUCTION_SMOKE_ON_START/);
  assert.match(server,/RENDER_GIT_COMMIT/);
  assert.match(render,/healthCheckPath: \/api\/health/);
  assert.match(render,/PRODUCTION_SMOKE_ON_START/);
  assert.match(workflow,/workflow_run:/);
  assert.match(workflow,/head_branch == 'main'/);
  assert.match(workflow,/EXPECTED_COMMIT_SHA/);
  assert.match(workflow,/node scripts\/production-smoke\.mjs/);
});

test('Wave 13 health publishes deploy identity without secrets',()=>{
  const server=read('server.mjs');
  assert.match(server,/wave13Version:1/);
  assert.match(server,/buildVersion:BUILD_VERSION/);
  assert.match(server,/gitCommit:DEPLOYMENT_GIT_COMMIT/);
  assert.doesNotMatch(server,/PRODUCTION_SMOKE_PASSWORD[^\n]*health/);
});
