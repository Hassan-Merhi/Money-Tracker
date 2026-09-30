import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('Wave 4 stylesheet is loaded last and cached by the PWA shell',()=>{
  const html=read('index.html');
  const sw=read('service-worker.js');
  const activityIndex=html.indexOf('./activity.css?v=mobile-v3');
  const wave4Index=html.indexOf('./desktop-tablet.css?v=wave4-v1');
  assert.ok(activityIndex>=0,'activity stylesheet should remain present');
  assert.ok(wave4Index>activityIndex,'Wave 4 stylesheet must load after page-specific styles');
  assert.match(sw,/\/desktop-tablet\.css\?v=wave4-v1/);
});

test('Wave 4 explicitly owns tablet shell widths without changing phone navigation',()=>{
  const css=read('desktop-tablet.css');
  assert.match(css,/@media \(min-width: 761px\)/);
  assert.match(css,/@media \(min-width: 761px\) and \(max-width: 900px\)/);
  assert.match(css,/grid-template-columns: 188px minmax\(0, 1fr\)/);
  assert.doesNotMatch(css,/\.mobile-nav\s*\{/);
});

test('Wave 4 polishes dashboard, reports, tables and dialogs at tablet and desktop widths',()=>{
  const css=read('desktop-tablet.css');
  assert.match(css,/\.dashboard \.debt-stats/);
  assert.match(css,/\.dashboard \.debt-stats > \.stat:nth-child\(3\)/);
  assert.match(css,/\.report-filter-row/);
  assert.match(css,/\.report-more-grid/);
  assert.match(css,/\.table-wrap,[\s\S]*?overscroll-behavior-inline: contain/);
  assert.match(css,/\.modal \{[\s\S]*?width: min\(720px, calc\(100vw - 56px\)\)/);
  assert.match(css,/\.imp-shell \{[\s\S]*?width: min\(1040px, calc\(100vw - 56px\)\)/);
});

test('Wave 4 includes tablet-specific feature layouts instead of relying on desktop grids',()=>{
  const css=read('desktop-tablet.css');
  const tablet=css.slice(css.indexOf('@media (min-width: 761px) and (max-width: 900px)'));
  assert.match(tablet,/\.bank-import-grid \{[\s\S]*?grid-template-columns: 1fr/);
  assert.match(tablet,/\.mapping-grid,[\s\S]*?\.bank-rule-form \{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(tablet,/\.report-filter-row \{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(tablet,/\.dashboard-secondary \{[\s\S]*?grid-template-columns: 1fr/);
});

test('Wave 4 restores light/dark parity for feature surfaces that hard-code light colors',()=>{
  const css=read('desktop-tablet.css');
  assert.match(css,/html\[data-theme="dark"\] \{[\s\S]*?color-scheme: dark/);
  assert.match(css,/html\[data-theme="dark"\] \.imp-shell/);
  assert.match(css,/html\[data-theme="dark"\] \.bank-rule-item/);
  assert.match(css,/html\[data-theme="dark"\] \.g-category-row/);
  assert.match(css,/html\[data-theme="dark"\] \.report-export-menu/);
});

test('Wave 4 advances the coherent PWA shell version',()=>{
  const version=read('pwa-version.js');
  assert.match(version,/version:19/);
  assert.match(version,/cacheName:'money-tracker-debt-v19'/);
});
