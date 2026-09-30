import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeAssetVersion, stampHtmlAssets, stampModuleImports, stampServiceWorker } from '../lib/release-assets.js';

const fixture=mkdtempSync(join(tmpdir(),'mot-wave5-fixture-'));
mkdirSync(join(fixture,'lib'));
writeFileSync(join(fixture,'index.html'),'<link rel="stylesheet" href="./app.css"><script type="module" src="./app.js"></script>');
writeFileSync(join(fixture,'app.css'),'body{display:block}');
writeFileSync(join(fixture,'app.js'),"import {x} from './lib/x.js'; console.log(x);");
writeFileSync(join(fixture,'lib','x.js'),'export const x=1;');

test('release asset fingerprint is deterministic and changes with browser content',()=>{
  const first=computeAssetVersion(fixture);
  const second=computeAssetVersion(fixture);
  assert.match(first,/^[a-f0-9]{12}$/);
  assert.equal(first,second);
  writeFileSync(join(fixture,'app.css'),'body{display:grid}');
  assert.notEqual(computeAssetVersion(fixture),first);
});

test('release stamping gives HTML, module imports and service worker one version',()=>{
  const version='abc123def456';
  const html=stampHtmlAssets('<meta name="money-tracker-build" content="__ASSET_VERSION__"><link href="./a.css?v=old"><script src="./a.js"></script>',version);
  assert.match(html,/content="abc123def456"/);
  assert.match(html,/\.\/a\.css\?v=abc123def456/);
  assert.match(html,/\.\/a\.js\?v=abc123def456/);
  const js=stampModuleImports("import x from './x.js'; import('./lazy.js?old=1'); import '../side.js';",version);
  assert.match(js,/\.\/x\.js\?v=abc123def456/);
  assert.match(js,/\.\/lazy\.js\?v=abc123def456/);
  assert.match(js,/\.\.\/side\.js\?v=abc123def456/);
  assert.equal(stampServiceWorker("const V='__ASSET_VERSION__';",version),"const V='abc123def456';");
});

const dir=mkdtempSync(join(tmpdir(),'mot-wave5-server-'));
process.env.DB_PATH=join(dir,'server.sqlite');
process.env.DATA_DIR=dir;
process.env.NODE_ENV='test';
const {server,db}=await import(`../server.mjs?wave5=${Date.now()}`);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;

test('server stamps one fingerprint through health, HTML, modules and service worker',async()=>{
  const healthRes=await fetch(base+'/api/health');
  assert.equal(healthRes.status,200);
  const health=await healthRes.json();
  assert.match(health.assetVersion,/^[a-f0-9]{12}$/);
  assert.equal(health.pwaCacheVersion,health.assetVersion);
  assert.ok(health.buildId);

  const htmlRes=await fetch(base+'/');
  const html=await htmlRes.text();
  assert.match(html,new RegExp(`money-tracker-build" content="${health.assetVersion}"`));
  for(const asset of ['styles.css','dashboard.css','mobile.css','activity.css','app.js','block-c-import.js']){
    assert.ok(html.includes(`${asset}?v=${health.assetVersion}`),asset);
  }
  assert.match(htmlRes.headers.get('cache-control')||'',/no-cache/);

  const appRes=await fetch(base+`/app.js?v=${health.assetVersion}`);
  const app=await appRes.text();
  assert.match(app,new RegExp(`dashboard-ui\\.js\\?v=${health.assetVersion}`));
  assert.match(app,new RegExp(`store\\.js\\?v=${health.assetVersion}`));
  assert.match(appRes.headers.get('cache-control')||'',/max-age=31536000/);
  assert.match(appRes.headers.get('cache-control')||'',/immutable/);

  const staleAppRes=await fetch(base+'/app.js?v=stale-build');
  assert.doesNotMatch(staleAppRes.headers.get('cache-control')||'',/immutable/);
  assert.match(await staleAppRes.text(),new RegExp(`store\\.js\\?v=${health.assetVersion}`));

  const swRes=await fetch(base+`/service-worker.js?v=${health.assetVersion}`);
  const sw=await swRes.text();
  assert.match(sw,new RegExp(`const ASSET_VERSION='${health.assetVersion}'`));
  assert.match(sw,new RegExp(`money-tracker-shell-\\$\\{ASSET_VERSION\\}`));
  assert.match(sw,/requestVersion!==ASSET_VERSION/);
  assert.match(swRes.headers.get('cache-control')||'',/no-cache/);
  assert.equal(swRes.headers.get('service-worker-allowed'),'/');
});

test('versioned static assets have stable ETags and support 304 responses',async()=>{
  const health=await (await fetch(base+'/api/health')).json();
  const first=await fetch(base+`/mobile.css?v=${health.assetVersion}`);
  assert.equal(first.status,200);
  const etag=first.headers.get('etag');
  assert.ok(etag);
  const second=await fetch(base+`/mobile.css?v=${health.assetVersion}`,{headers:{'if-none-match':etag}});
  assert.equal(second.status,304);
});

test('raw sources contain no manually bumped mobile or numeric PWA cache versions',()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const html=readFileSync(join(root,'index.html'),'utf8');
  const sw=readFileSync(join(root,'service-worker.js'),'utf8');
  const pwa=readFileSync(join(root,'lib','pwa.js'),'utf8');
  assert.doesNotMatch(html,/mobile-v\d+|activity-v\d+/);
  assert.match(html,/money-tracker-build/);
  assert.match(sw,/__ASSET_VERSION__/);
  assert.doesNotMatch(sw,/money-tracker-debt-v\d+/);
  assert.match(pwa,/service-worker\.js\?v=\$\{encodeURIComponent\(buildVersion\)\}/);
  assert.match(pwa,/updateViaCache:'none'/);
});

after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  db.close();
  rmSync(dir,{recursive:true,force:true});
  rmSync(fixture,{recursive:true,force:true});
});
