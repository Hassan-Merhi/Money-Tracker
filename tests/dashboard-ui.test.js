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
  assert.match(sw, /MONEY_TRACKER_PWA\.cacheName/);
  for (const path of ['/dashboard.css', '/lib/dashboard-ui.js']) assert.ok(sw.includes(`'${path}'`));
  assert.match(icon('people'), /aria-hidden="true"/);
  assert.doesNotMatch(icon('<script>'), /<script>/);
});


test('dashboard mounts both widgets only in Advanced mode with a revision-safe state replacement',()=>{
  const app=read('app.js');
  const dashboard=app.slice(app.indexOf('function renderDashboard('),app.indexOf('function renderPeople('));
  assert.match(dashboard,/advancedMode\(\)\?`<div class="dashboard-secondary">[\s\S]*?id="dashboardRecurring"[\s\S]*?id="dashboardBudgets"[\s\S]*?<\/div>`:''/);
  assert.match(dashboard,/if\(advancedMode\(\)\)\{[\s\S]*?const ctx=\{showToast,replaceState\(next\)\{state=next;render\(\);\}\};[\s\S]*?mountRecurringDashboardWidget\(main\.querySelector\('#dashboardRecurring'\),state,ctx\);[\s\S]*?mountBudgetDashboardWidget\(main\.querySelector\('#dashboardBudgets'\),state\);/);
  assert.doesNotMatch(dashboard,/id="enableAdvanced"/);
  assert.match(app,/id="settingMode"/); // Mode switching belongs in Settings only.
  const recurring=read('block-e-recurring.js');
  assert.match(recurring,/expectedRevision:state.version/);
  assert.match(recurring,/ctx.replaceState\(result.state\)/);
  assert.match(recurring,/data-dashboard-post/);
});

test('transactions page preserves category filters and defaults date filtering to this month',()=>{
  const app=read('app.js');
  const transactions=app.slice(app.indexOf('function renderTransactions('),app.indexOf('function transactionTable('));
  assert.match(transactions,/route.params.get\('category'\)/);
  assert.match(transactions,/route.params.get\('period'\)\|\|'this_month'/);
  assert.match(transactions,/route.params.get\('from'\)/);
  assert.match(transactions,/route.params.get\('to'\)/);
  assert.match(transactions,/filterTransactionList\(visible,\{type,personId:person,categoryId:category,people:state.people,accounts:state.accounts,categories:state.categories\|\|\[\],from:range.from,to:range.to,q:textQuery\}\)/);
  assert.match(transactions,/id=['"]filterPeriod['"]/);
  assert.match(transactions,/This month/);
  assert.match(transactions,/Custom dates/);
  assert.match(transactions,/id=['"]filterCategory['"]/);
  assert.match(transactions,/c.archived\?' \(archived\)'/);
  for(const key of ['q','type','person','category'])assert.ok(transactions.includes(`q.set('${key}'`));
  assert.ok(transactions.includes("q.set('period'"));
  assert.ok(transactions.includes("q.set('from'"));
  assert.ok(transactions.includes("q.set('to'"));
  const activity=read('activity.css');
  assert.match(activity,/\.activity-list-head\{display:none\}/);
  assert.match(activity,/activity-toolbar>#addTxn\{display:none!important\}/);
  assert.match(read('block-g-insights.js'),/row.categoryId\|\|'uncategorized'/);
});

// Exercise the existing widgets, not just their newly wired call sites.
test('recurring widget shows due/overdue items and posts with the mounted revision, then refreshes on conflict',async t=>{
  const { mountRecurringDashboardWidget }=await import('../block-e-recurring.js');
  const { today }=await import('../lib/utils.js');
  const original={window:globalThis.window,confirm:globalThis.confirm};
  globalThis.window={};globalThis.confirm=()=>true;
  t.after(()=>{for(const [key,value] of Object.entries(original))value===undefined?delete globalThis[key]:globalThis[key]=value;});
  const date=today(),yesterday=new Date(date+'T12:00:00');yesterday.setDate(yesterday.getDate()-1);
  const previous=`${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`;
  const rules=[['due',date],['overdue',previous]].map(([id,nextDueDate])=>({id,title:id,nextDueDate,isActive:true,remindDaysBefore:0,template:{type:'paid_for_person',personId:'p1',amount:10,currency:'USD'}}));
  const mounted={version:7,settings:{timezone:'UTC'},people:[{id:'p1',name:'Alice'}],accounts:[]},next={...mounted,version:8};
  const calls=[],replacements=[],toasts=[],buttons=rules.map(rule=>({dataset:{dashboardPost:rule.id},addEventListener(event,handler){this.click=handler;}}));
  const host={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>buttons};
  let conflict=false;
  t.mock.method(globalThis,'fetch',async(path,options={})=>{
    calls.push({path,body:options.body?JSON.parse(options.body):null});
    if(path==='/api/recurring')return {ok:true,json:async()=>({rules})};
    if(path==='/api/state')return {ok:true,json:async()=>next};
    assert.equal(path,'/api/recurring/due/post');
    return conflict?{ok:false,status:409,json:async()=>({error:'Ledger changed. Try again.'})}:{ok:true,json:async()=>({state:next})};
  });
  await mountRecurringDashboardWidget(host,mounted,{replaceState:s=>replacements.push(s),showToast:s=>toasts.push(s)});
  assert.match(host.innerHTML,/Scheduled reminders/);
  assert.match(host.innerHTML,/Due today/);
  assert.match(host.innerHTML,/1 day overdue/);
  await buttons[0].click();
  assert.deepEqual(calls.at(-1).body,{expectedRevision:7,occurrenceDate:date,transactionDate:date});
  assert.deepEqual(replacements,[next]);
  assert.match(toasts.at(-1),/posted/);
  conflict=true;
  await buttons[0].click();
  assert.equal(calls.at(-1).path,'/api/state');
  assert.deepEqual(replacements,[next,next]);
  assert.match(toasts.at(-1),/Ledger changed/);
});

test('budget widget shows near/over budgets and its Insights link works',async t=>{
  const { mountBudgetDashboardWidget }=await import('../block-g-insights.js');
  const { today }=await import('../lib/utils.js');
  const original=globalThis.location;
  globalThis.location={hash:''};
  t.after(()=>{if(original===undefined)delete globalThis.location;else globalThis.location=original;});
  const button={addEventListener(event,handler){this.click=handler;}};
  const host={innerHTML:'',querySelector:()=>button};
  const state={categories:[{id:'near',name:'Near category'},{id:'over',name:'Over category'}],
    budgets:['near','over'].map(categoryId=>({id:categoryId,categoryId,currency:'USD',monthlyLimit:100})),
    entries:[['near',85],['over',110]].map(([categoryId,amount])=>({type:'account_expense',categoryId,amount,currency:'USD',date:today()}))};
  mountBudgetDashboardWidget(host,state);
  assert.match(host.innerHTML,/Monthly budget watch/);
  assert.match(host.innerHTML,/>Near</);
  assert.match(host.innerHTML,/>Over</);
  button.click();
  assert.equal(globalThis.location.hash,'#insights');
});
