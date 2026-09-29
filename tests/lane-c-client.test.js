import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Lane C PWA cache v9 includes the resilience controller and core finance modules',()=>{
  const sw=readFileSync(new URL('../service-worker.js',import.meta.url),'utf8');
  assert.match(sw,/money-tracker-debt-v9/);
  assert.match(sw,/\/lib\/pwa\.js/);
  assert.match(sw,/SKIP_WAITING/);
  assert.match(sw,/networkFirst/);
  assert.match(sw,/staleWhileRevalidate/);
  assert.match(sw,/pathname\.startsWith\('\/api\/'\)/);
});

test('manifest defines install scope identity and useful shortcuts',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../manifest.webmanifest',import.meta.url),'utf8'));
  assert.equal(manifest.id,'/');
  assert.equal(manifest.scope,'/');
  assert.equal(manifest.display,'standalone');
  assert.ok(manifest.shortcuts.some(item=>item.url.includes('#transactions')));
  assert.ok(manifest.shortcuts.some(item=>item.url.includes('#reports')));
});

test('app exposes PWA connectivity update session security and operations controls',()=>{
  const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  assert.match(app,/initPwa/);
  assert.match(app,/connection-pill/);
  assert.match(app,/Install Money Tracker/);
  assert.match(app,/Active sessions/);
  assert.match(app,/Recent security activity/);
  assert.match(app,/Operations & integrity/);
  assert.match(app,/Create server snapshot/);
});

test('store exposes Lane C security and operational APIs',()=>{
  const store=readFileSync(new URL('../lib/store.js',import.meta.url),'utf8');
  assert.match(store,/\/api\/auth\/sessions/);
  assert.match(store,/\/api\/security\/events/);
  assert.match(store,/\/api\/ops\/status/);
  assert.match(store,/\/api\/ops\/snapshot/);
  assert.match(store,/You are offline/);
});


test('theme bootstrap is external so script CSP does not block it',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.match(html,/theme-init\.js/);
  assert.equal(/<script>/.test(html),false);
  const sw=readFileSync(new URL('../service-worker.js',import.meta.url),'utf8');
  assert.match(sw,/theme-init\.js/);
});
