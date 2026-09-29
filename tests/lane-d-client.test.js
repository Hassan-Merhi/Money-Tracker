import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('Lane D adds keyboard navigation focus and live-region accessibility',()=>{
  const html=read('index.html'),app=read('app.js'),css=read('styles.css');
  assert.match(html,/class="skip-link" href="#main"/);
  assert.match(app,/aria-label="Primary navigation"/);
  assert.match(app,/aria-current="page"/);
  assert.match(app,/aria-labelledby="pageHeading"/);
  assert.match(app,/role="status"/);
  assert.match(app,/wireFieldLabels/);
  assert.match(app,/document\.querySelector\('\.skip-link'\)\?\.addEventListener\('click'/);
  assert.match(app,/event\.preventDefault\(\)/);
  assert.match(app,/event\.key==='Escape'/);
  assert.match(app,/event\.key!=='Tab'/);
  assert.match(app,/modalReturnFocus/);
  assert.match(css,/:focus-visible/);
  assert.match(css,/prefers-reduced-motion:reduce/);
});

test('Lane D makes dashboard cards keyboard reachable',()=>{
  const app=read('app.js');
  assert.match(app,/person-card[^\n]+href="#person\?id=/);
  assert.match(app,/account-card[^\n]+role="button" tabindex="0"/);
  assert.match(app,/event\.key==='Enter'\|\|event\.key===' '/);
});

test('Lane D PWA v13 keeps stale-while-revalidate work alive',()=>{
  const sw=read('service-worker.js');
  assert.match(sw,/money-tracker-debt-v13/);
  assert.match(sw,/event\.waitUntil\(revalidatePromise/);
  assert.match(sw,/staleWhileRevalidate\(event\.request,revalidatePromise\)/);
});

test('Lane D preserves an explicit Bank Feed rule priority of zero',()=>{
  const bank=read('block-f-bank-feed.js');
  assert.match(bank,/rule\.priority\?\?100/);
  assert.doesNotMatch(bank,/rule\.priority\|\|100/);
});

test('Lane D centralizes bounded storage and recovery limits',()=>{
  const limits=read('lib/data-limits.js'),backup=read('lib/full-backup.js'),server=read('server.mjs'),bank=read('lib/bank-server.js');
  assert.match(limits,/bankFeedItems:50000/);
  assert.match(limits,/bankImportBatches:5000/);
  assert.match(limits,/attachmentBytes:100\*1024\*1024/);
  assert.match(backup,/DATA_LIMITS\.bankFeedItems/);
  assert.match(backup,/DATA_LIMITS\.attachmentBytes/);
  assert.match(server,/DATA_LIMITS\.fullBackupBodyBytes/);
  assert.match(bank,/DATA_LIMITS\.bankImportBatches/);
});

test('person statement has modern mobile/desktop design with 3-dots actions and no dash on notes',()=>{
  const app=read('app.js'),css=read('styles.css'),mobileCss=read('mobile.css');
  assert.match(app,/statement-back-link/);
  assert.match(app,/statement-hero-card/);
  assert.match(app,/statement-hero-balance/);
  assert.match(app,/entry-menu-trigger/);
  assert.match(app,/data-menu-trigger/);
  assert.match(app,/data-menu-popover/);
  assert.match(app,/positionEntryMenuPopover/);
  assert.match(app,/closeAllEntryMenus/);
  assert.match(app,/statementNotesMarkup/);
  assert.doesNotMatch(app,/strong>\$\{escapeHtml\(e\.description\|\|['"—-]\)\}<\/strong>/);
  assert.match(css,/\.statement-hero-card/);
  assert.match(css,/\.entry-menu-trigger/);
  assert.match(css,/\.entry-menu-popover/);
  assert.match(mobileCss,/\.statement-table-wrap\.mobile-ledger-table/);
  assert.match(mobileCss,/html\[data-theme="dark"\]\s+\.statement-table-wrap\.mobile-ledger-table/);
});
