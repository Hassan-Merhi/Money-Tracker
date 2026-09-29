import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activityMarkup, icon, mobilePages, peopleOverviewMarkup, recentDebtEntries } from '../lib/dashboard-ui.js';
import { personBalances } from '../lib/ledger.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('mobile navigation reserves a fifth slot for More only in Advanced mode', () => {
  assert.deepEqual(mobilePages(false), ['dashboard', 'people', 'transactions', 'reports', 'settings']);
  assert.deepEqual(mobilePages(true), ['dashboard', 'people', 'transactions', 'accounts']);
  const app = read('app.js');
  assert.match(app, /aria-label="More navigation" aria-haspopup="dialog"/);
  assert.match(app, /visiblePages.filter\(p=>!mobileNavPages.includes\(p\)\)/);
  assert.match(app, /closeModal\(\);location.hash=`#\$\{button.dataset.moreNav\}`/);
});

test('recent activity is debt-only, newest first, bounded, and does not mutate the ledger', () => {
  const entries = Array.from({length: 9}, (_, i) => ({id: String(i), type: 'paid_for_person', createdAt: `2026-09-${20 + i}T12:00:00Z`}));
  entries.push({id: 'income', type: 'account_income', createdAt: '2026-09-29T12:00:00Z'});
  const original = structuredClone(entries);
  assert.deepEqual(recentDebtEntries(entries).map(e => e.id), ['8', '7', '6', '5', '4', '3']);
  assert.deepEqual(entries, original);
  assert.deepEqual(recentDebtEntries([]), []);
});

test('activity rows expose editing, type, date, attachments, and escaped ledger text', () => {
  const markup = activityMarkup([{id: 'entry_1', type: 'received_from_person', personId: 'person_1', amount: 123.45, currency: 'USD', date: '2026-09-29', description: '<img src=x onerror=alert(1)>', attachmentCount: 2}], [{id: 'person_1', name: 'Alex <script>bad()</script>'}]);
  assert.match(markup, /<button class="activity-row" data-dashboard-entry="entry_1"/);
  assert.match(markup, /Received from person/);
  assert.match(markup, /datetime="2026-09-29"/);
  assert.match(markup, /2 attachments/);
  assert.match(markup, /123\.45/);
  assert.match(markup, /&lt;img/);
  assert.doesNotMatch(markup, /<script>|<img/);
});

test('split activity shows every participant and handles a missing person safely', () => {
  const markup = activityMarkup([{id: 'split', type: 'split_paid_for_people', splits: [{personId: 'a'}, {personId: 'missing'}], amount: 50, currency: 'EUR', date: '2026-09-29'}], [{id: 'a', name: 'Alice & Bob'}]);
  assert.match(markup, /Alice &amp; Bob, Unknown/);
  assert.match(markup, /Split purchase/);
});

test('people overview never nets unlike currencies or hides opposite-direction balances', () => {
  const people = [{id: 'person_1', name: 'Alex'}, {id: 'person_2', name: 'Settled'}];
  const entries = [
    {type: 'paid_for_person', personId: 'person_1', amount: 100, currency: 'USD'},
    {type: 'borrowed_from_person', personId: 'person_1', amount: 100, currency: 'EUR'},
  ];
  const overview = peopleOverviewMarkup(people, personBalances(entries, people));
  assert.equal(overview.count, 1);
  assert.match(overview.markup, /Owes you/);
  assert.match(overview.markup, /You owe/);
  assert.doesNotMatch(overview.markup, /Settled/);
  assert.match(overview.markup, /href="#person\?id=person_1"/);
});

test('people overview is bounded, alphabetized, escaped, and has an honest total', () => {
  const people = Array.from({length: 6}, (_, i) => ({id: `p${i}`, name: `${5 - i} <name>`}));
  const balances = Object.fromEntries(people.map(p => [p.id, {USD: 1}]));
  const {count, markup} = peopleOverviewMarkup(people, balances);
  assert.equal(count, 6);
  assert.equal((markup.match(/class="overview-person"/g) || []).length, 4);
  assert.ok(markup.indexOf('p5') < markup.indexOf('p4'));
  assert.match(markup, /&lt;name&gt;/);
  assert.doesNotMatch(markup, /<name>/);
  assert.deepEqual(peopleOverviewMarkup([], {}), {count: 0, markup: ''});
});

test('dashboard assets are local, loaded last, and included in the upgraded offline shell', () => {
  const html = read('index.html'), sw = read('service-worker.js');
  assert.ok(html.indexOf('dashboard.css') > html.indexOf('block-g-insights.css'));
  assert.match(sw, /money-tracker-debt-v13/);
  for (const path of ['/dashboard.css', '/lib/dashboard-ui.js']) assert.ok(sw.includes(`'${path}'`));
  assert.match(icon('people'), /aria-hidden="true"/);
  assert.doesNotMatch(icon('<script>'), /<script>/);
});
