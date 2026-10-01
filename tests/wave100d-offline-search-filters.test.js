import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeSearchText, matchesSearchText, entrySearchText, filterBankFeedItems, filterRecurringRules } from '../lib/offline-query.js';
import { filteredEntries, filterTransactionList } from '../lib/reporting.js';

const ROOT=dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const read=path=>readFileSync(join(ROOT,path),'utf8');

const state={
  people:[{id:'person_ana',name:'Ána García',note:'Cousin'}],
  accounts:[{id:'account_card',name:'Travel Card',currency:'USD'},{id:'account_cash',name:'Cash Wallet',currency:'USD'}],
  categories:[{id:'cat_food',name:'Dining Out'}],
  entries:[
    {id:'entry_1',type:'account_expense',accountId:'account_card',amount:24.5,currency:'USD',date:'2026-10-01',merchant:'Café Central',description:'Lunch receipt',categoryId:'cat_food'},
    {id:'entry_2',type:'paid_for_person',personId:'person_ana',amount:19,currency:'USD',date:'2026-09-30',merchant:'Amazon',description:'Headphones'},
    {id:'entry_3',type:'split_paid_for_people',accountId:'account_cash',amount:30,currency:'USD',date:'2026-10-02',merchant:'Taxi',description:'Airport ride',splits:[{personId:'person_ana',amount:15,note:'Terminal share'}]}
  ]
};

test('Wave 100D normalizes accents, punctuation and compound tokens deterministically',()=>{
  assert.equal(normalizeSearchText('  Café—GARCÍA  '),'cafe garcia');
  assert.equal(matchesSearchText('Café Central · Ána García','cafe garcia'),true);
  assert.equal(matchesSearchText('Café Central · Ána García','cafe missing'),false);
});

test('Wave 100D Activity and Reports share local transaction search semantics',()=>{
  assert.match(entrySearchText(state.entries[0],state),/Travel Card/);
  assert.match(entrySearchText(state.entries[0],state),/Dining Out/);
  assert.deepEqual(filteredEntries(state,{q:'cafe dining'}).map(row=>row.id),['entry_1']);
  assert.deepEqual(filteredEntries(state,{q:'ana amazon',personId:'person_ana'}).map(row=>row.id),['entry_2']);
  assert.deepEqual(filterTransactionList(state.entries,{q:'ana terminal',people:state.people,accounts:state.accounts,categories:state.categories,from:'2026-10-01',to:'2026-10-31'}).map(row=>row.id),['entry_3']);
});

test('Wave 100D Bank Feed local filters compose search, status, account and date',()=>{
  const items=[
    {id:'bank_1',accountId:'account_card',date:'2026-10-01',merchant:'Café Central',description:'Breakfast',sourceName:'October CSV',status:'pending',currency:'USD'},
    {id:'bank_2',accountId:'account_cash',date:'2026-10-02',merchant:'Taxi',description:'Airport',sourceName:'October CSV',status:'posted',currency:'USD'},
    {id:'bank_3',accountId:'account_card',date:'2026-09-15',merchant:'Bookstore',description:'Guide',sourceName:'September CSV',status:'pending',currency:'USD'}
  ];
  const result=filterBankFeedItems(items,{q:'cafe october',status:'pending',accountId:'account_card',from:'2026-10-01',to:'2026-10-31'},state);
  assert.deepEqual(result.map(row=>row.id),['bank_1']);
});

test('Wave 100D recurring search and status filters use cached rule metadata',()=>{
  const rules=[
    {id:'rule_1',title:'Rent transfer',frequency:'monthly',isActive:true,nextDueDate:'2026-10-05',template:{type:'account_transfer',fromAccountId:'account_card',toAccountId:'account_cash',description:'Home rent'}},
    {id:'rule_2',title:'Paused Amazon',frequency:'monthly',isActive:false,nextDueDate:'2026-10-10',template:{type:'paid_for_person',personId:'person_ana',merchant:'Amazon'}},
    {id:'rule_3',title:'Old subscription',frequency:'monthly',isActive:false,nextDueDate:null,template:{type:'account_expense',accountId:'account_card'}}
  ];
  assert.deepEqual(filterRecurringRules(rules,{q:'travel cash',status:'active'},state).map(row=>row.id),['rule_1']);
  assert.deepEqual(filterRecurringRules(rules,{q:'ana amazon',status:'paused'},state).map(row=>row.id),['rule_2']);
  assert.deepEqual(filterRecurringRules(rules,{status:'complete'},state).map(row=>row.id),['rule_3']);
});

test('Wave 100D UI, production and CI contracts are wired',()=>{
  const app=read('app.js'),reports=read('lib/reports-ui.js'),bank=read('block-f-bank-feed.js'),recurring=read('block-e-recurring.js'),server=read('server.mjs'),smoke=read('lib/production-smoke.js'),version=read('pwa-version.js'),sw=read('service-worker.js'),pkg=JSON.parse(read('package.json')),ci=read('.github/workflows/ci.yml');
  assert.match(app,/id='filterSearch'/);
  assert.match(reports,/id="reportSearch"/);
  assert.match(bank,/id="bankSearch"/);
  assert.match(bank,/id="bankFilterAccount"/);
  assert.match(recurring,/id="recurringSearch"/);
  assert.match(recurring,/id="recurringStatusFilter"/);
  assert.match(server,/offlineWave100DVersion:1/);
  assert.match(smoke,/offlineWave100DVersion/);
  const pwaVersion=Number(/version:(\d+)/.exec(version)?.[1]||0);
  assert.ok(pwaVersion>=34,`Wave 100D requires PWA v34 or newer; found v${pwaVersion}.`);
  assert.match(version,new RegExp(`cacheName:'money-tracker-debt-v${pwaVersion}'`));
  const offlineDbVersion=Number(/offlineDbVersion:(\d+)/.exec(version)?.[1]||0);
  assert.ok(offlineDbVersion>=7);
  assert.match(sw,/\/lib\/offline-query\.js/);
  assert.equal(pkg.scripts['test:wave100d'],'node --test tests/wave100d-offline-search-filters.test.js');
  assert.equal(pkg.scripts['test:wave100d-e2e'],'playwright test e2e/wave100d-offline-search-filters.spec.mjs --workers=1');
  assert.match(ci,/Run Wave 100D Offline Search & Filters gate/);
  assert.match(ci,/Run Wave 100D Offline Search & Filters browser gate/);
});
