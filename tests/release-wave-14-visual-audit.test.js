import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('Wave 14 visual closure stylesheet loads last and is cached by the PWA',()=>{
  const html=read('index.html');
  const sw=read('service-worker.js');
  const previous=html.indexOf('./desktop-tablet.css?v=wave4-v1');
  const wave14=html.indexOf('./visual-audit.css?v=wave14-v1');
  assert.ok(previous>=0,'Wave 4 stylesheet must remain loaded');
  assert.ok(wave14>previous,'Wave 14 visual closure must load last');
  assert.match(sw,/\/visual-audit\.css\?v=wave14-v1/);
});

test('Wave 14 closes dark-mode parity at mobile widths',()=>{
  const css=read('visual-audit.css');
  assert.match(css,/html\[data-theme="dark"\] \.imp-shell/);
  assert.match(css,/html\[data-theme="dark"\] \.bank-rule-item/);
  assert.match(css,/html\[data-theme="dark"\] \.g-category-row/);
  assert.match(css,/html\[data-theme="dark"\] \.g-budget-row/);
  assert.match(css,/html\[data-theme="dark"\] \.pill\.amber/);
  assert.match(css,/@media \(max-width:760px\)/);
});

test('Wave 14 protects long names, large values, overlays and menus from viewport overflow',()=>{
  const css=read('visual-audit.css');
  assert.match(css,/\.stat-value,[\s\S]*?overflow-wrap:anywhere/);
  assert.match(css,/\.report-export-menu,\.entry-menu[\s\S]*?max-width:min\(320px,calc\(100vw - 24px\)\)/);
  assert.match(css,/\.modal-backdrop,\.imp-backdrop\{max-width:100vw;overflow-x:hidden\}/);
  assert.match(css,/\.bank-amount\{max-width:46vw/);
  assert.match(css,/\.recurring-card-top,[\s\S]*?flex-wrap:wrap/);
});

test('Wave 14 has a dedicated screenshot audit and CI artifact retention',()=>{
  const pkg=read('package.json');
  const ci=read('.github/workflows/ci.yml');
  const spec=[read('e2e/visual-audit-matrix.spec.mjs'),read('e2e/visual-audit-states.spec.mjs'),read('e2e/visual-audit-overlays.spec.mjs'),read('e2e/wave14-fixture.mjs')].join('\n');
  assert.match(pkg,/"test:wave14": "playwright test e2e\/visual-audit\.spec\.mjs --workers=1"/);
  assert.match(ci,/Run Wave 14 visual audit/);
  assert.match(ci,/wave14-visual-audit/);
  assert.match(ci,/test-results\/wave14-visual/);
  assert.match(spec,/mobile/);
  assert.match(spec,/tablet/);
  assert.match(spec,/desktop/);
  assert.match(spec,/light/);
  assert.match(spec,/dark/);
  assert.match(spec,/empty/);
  assert.match(spec,/populated/);
  assert.match(spec,/Loading bank feed/);
  assert.match(spec,/Could not load bank feed/);
});

test('Wave 14 advances the coherent PWA shell version',()=>{
  const version=read('pwa-version.js');
  assert.match(version,/version:20/);
  assert.match(version,/cacheName:'money-tracker-debt-v20'/);
});
