import { expect, request } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BASE_URL='http://127.0.0.1:4173';
export const OWNER_EMAIL='wave14-owner@example.test';
export const OWNER_PASSWORD='correct horse battery staple';
export const VISUAL_DIR=fileURLToPath(new URL('../test-results/wave14-visual/',import.meta.url));
export const TODAY='2026-09-30';

export const VIEWPORTS=[
  {name:'mobile',viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true},
  {name:'tablet',viewport:{width:834,height:1112},deviceScaleFactor:1.5,hasTouch:true},
  {name:'desktop',viewport:{width:1440,height:1000},deviceScaleFactor:1}
];
export const THEMES=['light','dark'];
export const ROUTES=[
  {slug:'dashboard',hash:'#dashboard',heading:'Dashboard'},
  {slug:'people',hash:'#people',heading:'People'},
  {slug:'accounts',hash:'#accounts',heading:'Accounts & Cash'},
  {slug:'transactions',hash:'#transactions?period=all',heading:'Transactions'},
  {slug:'bank',hash:'#bank',heading:'Bank Feed',loading:'Loading bank feed'},
  {slug:'insights',hash:'#insights',heading:'Insights & Budgets'},
  {slug:'scheduled',hash:'#scheduled',heading:'Scheduled & Reminders',loading:'Loading recurring schedules'},
  {slug:'reports',hash:'#reports',heading:'Reports & Exports'},
  {slug:'settings',hash:'#settings',heading:'Settings'}
];

let api;
let csrfToken='';
let customExpenseCategoryId='';

function fileSlug(value=''){return String(value).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}

async function apiJson(response,label){
  const body=await response.json().catch(()=>({}));
  expect(response.ok(),label+' failed: '+JSON.stringify(body)).toBeTruthy();
  return body;
}

export async function setupApi(){
  mkdirSync(VISUAL_DIR,{recursive:true});
  api=await request.newContext({baseURL:BASE_URL});
  let auth=await api.post('/api/auth/login',{data:{email:OWNER_EMAIL,password:OWNER_PASSWORD}});
  if(auth.status()===401){
    auth=await api.post('/api/auth/register',{data:{email:OWNER_EMAIL,password:OWNER_PASSWORD}});
  }
  const session=await apiJson(auth,'authenticate Wave 14 owner');
  csrfToken=session.csrfToken;
  await apiJson(await api.post('/api/state/reset',{
    headers:{'x-csrf-token':csrfToken},
    data:{password:OWNER_PASSWORD}
  }),'reset Wave 14 workspace');
  await seedEmptyAdvancedState();
}
export async function disposeApi(){await api?.dispose();}
export async function currentState(){return await apiJson(await api.get('/api/state'),'GET /api/state');}
async function putState(state){
  return await apiJson(await api.put('/api/state',{headers:{'x-csrf-token':csrfToken},data:state}),'PUT /api/state');
}
async function post(path,data,label=path){
  return await apiJson(await api.post(path,{headers:{'x-csrf-token':csrfToken},data}),label);
}

export async function newPage(browser,view,theme,{authScreenshot=false}={}){
  const context=await browser.newContext({
    viewport:view.viewport,
    deviceScaleFactor:view.deviceScaleFactor,
    isMobile:view.isMobile||false,
    hasTouch:view.hasTouch||false
  });
  const page=await context.newPage(),browserErrors=[];
  await page.addInitScript(({theme})=>localStorage.setItem('mot-theme',theme),{theme});
  await page.goto('/');
  await expect(page.locator('#authForm')).toBeVisible();
  if(authScreenshot)await capture(page,'auth',view.name,theme,'auth');
  const login=await context.request.post('/api/auth/login',{data:{email:OWNER_EMAIL,password:OWNER_PASSWORD}});
  expect(login.ok(),'visual audit browser login').toBeTruthy();
  await page.reload();
  await expect(page.locator('#pageHeading')).toHaveText('Dashboard');
  page.on('pageerror',error=>browserErrors.push('pageerror: '+error.message));
  page.on('console',message=>{if(message.type()==='error')browserErrors.push('console: '+message.text());});
  await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}'});
  return {context,page,assertClean:()=>expect(browserErrors,'browser console/page errors').toEqual([])};
}

export async function openRoute(page,route){
  await page.evaluate(hash=>{location.hash=hash;},route.hash);
  await expect(page.locator('#pageHeading')).toHaveText(route.heading);
  if(route.loading)await expect(page.getByText(new RegExp(route.loading))).toHaveCount(0,{timeout:10_000});
  await page.waitForTimeout(80);
}

export async function capture(page,state,device,theme,name){
  mkdirSync(VISUAL_DIR,{recursive:true});
  await page.screenshot({path:VISUAL_DIR+`${state}__${device}__${theme}__${fileSlug(name)}.png`,fullPage:true,animations:'disabled'});
}

export async function expectVisualIntegrity(page,label){
  const result=await page.evaluate(()=>{
    const doc=document.documentElement,body=document.body;
    const pageOverflow={doc:doc.scrollWidth-doc.clientWidth,body:body.scrollWidth-body.clientWidth};
    const overflow=[];
    document.querySelectorAll('.card,.panel,.settings-card,.person-card,.account-card,.recurring-card,.bank-row,.g-manage-card,.modal,.imp-shell,.report-toolbar,.detail-header').forEach((el,index)=>{
      const rect=el.getBoundingClientRect();if(rect.width<1||rect.height<1)return;
      const style=getComputedStyle(el),excess=el.scrollWidth-el.clientWidth;
      if(excess>3&&!['auto','scroll','hidden','clip'].includes(style.overflowX))overflow.push({index,cls:el.className,excess});
    });
    const viewportIssues=[];
    document.querySelectorAll('.modal,.imp-shell,.report-export-menu:not([hidden]),.entry-menu-popover:not([hidden])').forEach(el=>{
      const rect=el.getBoundingClientRect();if(rect.width<1||rect.height<1)return;
      if(rect.left<-2||rect.right>innerWidth+2||rect.width>innerWidth+2)viewportIssues.push({cls:el.className,left:rect.left,right:rect.right,width:rect.width,viewport:innerWidth});
    });
    const darkIssues=[];
    if(document.documentElement.dataset.theme==='dark'){
      document.querySelectorAll('.card,.panel,.modal,.imp-shell,.bank-rule-item,.g-category-row,.g-budget-row,.report-export-menu:not([hidden]),.entry-menu-popover:not([hidden]),.pill.amber,.pill.blue').forEach(el=>{
        const rect=el.getBoundingClientRect();if(rect.width<1||rect.height<1)return;
        const bg=getComputedStyle(el).backgroundColor,rgb=bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);if(!rgb)return;
        if((Number(rgb[1])+Number(rgb[2])+Number(rgb[3]))/3>225)darkIssues.push({cls:el.className,bg});
      });
    }
    return {pageOverflow,overflow,viewportIssues,darkIssues};
  });
  expect(result.pageOverflow.doc,label+' document horizontal overflow').toBeLessThanOrEqual(2);
  expect(result.pageOverflow.body,label+' body horizontal overflow').toBeLessThanOrEqual(2);
  expect(result.overflow,label+' component overflow: '+JSON.stringify(result.overflow.slice(0,8))).toEqual([]);
  expect(result.viewportIssues,label+' overlay viewport issues: '+JSON.stringify(result.viewportIssues)).toEqual([]);
  expect(result.darkIssues,label+' dark-theme light surfaces: '+JSON.stringify(result.darkIssues.slice(0,8))).toEqual([]);
}

export async function seedEmptyAdvancedState(){
  const state=await currentState();
  await putState({...state,settings:{...state.settings,displayName:'Visual Audit Workspace',defaultCurrency:'USD',appMode:'advanced',timezone:'Asia/Beirut'},people:[],accounts:[],entries:[]});
}

export async function seedPopulatedExtremeState(){
  const category=await post('/api/categories',{name:'Extremely Long Visual Audit Category Name That Must Wrap Correctly',kind:'expense',icon:'🧾'},'create visual category');
  customExpenseCategoryId=category.category.id;
  const state=await currentState(),incomeCategory=state.categories.find(item=>item.kind==='income'||item.kind==='both');
  const people=[
    {id:'person_long',name:'Alexandria Very Long Family Name With Several Words And A Suffix The Third',note:'Long person note used to prove that cards, statements, menus and filters remain readable without horizontal scrolling.',createdAt:'2026-01-01T10:00:00.000Z'},
    {id:'person_eur',name:'European Multi Currency Contact',note:'EUR balance and long notes.',createdAt:'2026-01-02T10:00:00.000Z'},
    {id:'person_jpy',name:'Tokyo Yen Contact',note:'JPY values with no minor units.',createdAt:'2026-01-03T10:00:00.000Z'},
    {id:'person_gbp',name:'United Kingdom Sterling Contact',note:'GBP balance.',createdAt:'2026-01-04T10:00:00.000Z'}
  ];
  const accounts=[
    {id:'account_usd_primary',name:'Primary USD Bank Account With An Intentionally Very Long Display Name',type:'bank',currency:'USD',openingBalance:987654321012.34,createdAt:'2026-01-01T11:00:00.000Z'},
    {id:'account_usd_cash',name:'Emergency Cash USD',type:'cash',currency:'USD',openingBalance:123456789.01,createdAt:'2026-01-02T11:00:00.000Z'},
    {id:'account_eur',name:'European EUR Wallet With A Long Account Label',type:'wallet',currency:'EUR',openingBalance:876543210.98,createdAt:'2026-01-03T11:00:00.000Z'},
    {id:'account_jpy',name:'Tokyo JPY Cash Reserve',type:'cash',currency:'JPY',openingBalance:765432109876,createdAt:'2026-01-04T11:00:00.000Z'}
  ];
  const stamp='2026-09-30T09:30:00.000Z';
  const entries=[
    {id:'entry_usd_large',type:'paid_for_person',personId:'person_long',accountId:'account_usd_primary',amount:987654321.09,currency:'USD',date:TODAY,merchant:'A Merchant With A Very Long Name That Must Never Break The Layout On Small Screens',description:'Large USD purchase with a deliberately long description to exercise transaction cards and reports.',createdAt:stamp,updatedAt:stamp},
    {id:'entry_usd_repay',type:'received_from_person',personId:'person_long',accountId:'account_usd_primary',amount:12345678.9,currency:'USD',date:'2026-09-29',merchant:'International Transfer',description:'Large repayment against the long-name contact.',createdAt:stamp,updatedAt:stamp},
    {id:'entry_eur_borrow',type:'borrowed_from_person',personId:'person_eur',accountId:'account_eur',amount:87654321.12,currency:'EUR',date:'2026-09-28',merchant:'European Funding Source',description:'Large EUR borrowing example.',createdAt:stamp,updatedAt:stamp},
    {id:'entry_gbp_owe',type:'paid_to_person',personId:'person_gbp',amount:7654321.99,currency:'GBP',date:'2026-09-27',merchant:'Sterling Settlement',description:'GBP person-only transaction.',createdAt:stamp,updatedAt:stamp},
    {id:'entry_jpy_adjust',type:'person_adjustment',personId:'person_jpy',amount:654321098765,currency:'JPY',signedAmount:-654321098765,date:'2026-09-26',merchant:'',description:'Large negative JPY balance adjustment.',createdAt:stamp,updatedAt:stamp},
    {id:'entry_split',type:'split_paid_for_people',accountId:'account_usd_primary',amount:999999.99,currency:'USD',date:'2026-09-25',merchant:'Group Purchase With A Very Long Merchant Name',description:'Split purchase across two people.',splits:[{personId:'person_long',amount:600000,note:'Primary share.'},{personId:'person_eur',amount:399999.99,note:'Secondary share.'}],createdAt:stamp,updatedAt:stamp},
    {id:'entry_expense',type:'account_expense',accountId:'account_usd_primary',amount:12345678.9,currency:'USD',categoryId:customExpenseCategoryId,date:'2026-09-24',merchant:'Extremely Long Merchant Name For Category Spending Visual Regression',description:'Large categorized personal expense.',createdAt:stamp,updatedAt:stamp},
    {id:'entry_income',type:'account_income',accountId:'account_eur',amount:22334455.66,currency:'EUR',categoryId:incomeCategory?.id||null,date:'2026-09-23',merchant:'Consulting Income Europe',description:'Large EUR income.',createdAt:stamp,updatedAt:stamp},
    {id:'entry_account_adjust',type:'account_adjustment',accountId:'account_usd_cash',amount:100000,currency:'USD',signedAmount:-100000,date:'2026-09-22',merchant:'',description:'Cash correction.',createdAt:stamp,updatedAt:stamp},
    {id:'entry_transfer_usd',type:'account_transfer',fromAccountId:'account_usd_primary',toAccountId:'account_usd_cash',amount:250000,fromAmount:250000,toAmount:250000,date:'2026-09-21',merchant:'',description:'Large same-currency transfer.',createdAt:stamp,updatedAt:stamp},
    {id:'entry_transfer_fx',type:'account_transfer',fromAccountId:'account_usd_primary',toAccountId:'account_eur',amount:12345.67,fromAmount:12345.67,toAmount:11000,date:'2026-09-20',merchant:'FX Desk',description:'Cross-currency USD to EUR transfer.',createdAt:stamp,updatedAt:stamp}
  ];
  await putState({...state,settings:{...state.settings,displayName:'A Very Long Money Tracker Workspace Name Used For Final Visual Quality Assurance',defaultCurrency:'USD',appMode:'advanced',timezone:'Asia/Beirut'},people,accounts,entries});
  await post('/api/budgets',{categoryId:customExpenseCategoryId,currency:'USD',monthlyLimit:9876543210.99},'save visual budget');
  await post('/api/recurring',{title:'Monthly Recurring Schedule With A Very Long Name That Must Wrap Without Breaking Cards',frequency:'monthly',interval:1,anchorDate:TODAY,nextDueDate:TODAY,endDate:'2027-12-31',remindDaysBefore:7,isActive:true,template:{type:'account_expense',accountId:'account_usd_primary',amount:1234567.89,categoryId:customExpenseCategoryId,merchant:'Recurring Merchant With Long Name',description:'Recurring visual audit expense.'}},'create visual recurring rule');
  await post('/api/recurring',{title:'Cross Currency Transfer Schedule',frequency:'monthly',interval:1,anchorDate:'2026-10-15',nextDueDate:'2026-10-15',endDate:null,remindDaysBefore:3,isActive:true,template:{type:'account_transfer',fromAccountId:'account_usd_primary',toAccountId:'account_eur',amount:5000,fromAmount:5000,toAmount:4400,merchant:'FX Transfer',description:'Scheduled FX transfer.'}},'create transfer schedule');
  await post('/api/bank-feed/import',{accountId:'account_usd_primary',sourceName:'Visual Audit Statement September 2026 With A Long Source Name',rows:[
    {date:TODAY,description:'Bank row with an extremely long description that must render safely without widening the page',merchant:'Very Long Merchant Name For Bank Feed Rendering',signedAmount:-123456789.12,currency:'USD',externalId:'wave14-bank-1'},
    {date:'2026-09-29',description:'Salary deposit with a large amount',merchant:'Employer With Long Legal Company Name',signedAmount:987654321.01,currency:'USD',externalId:'wave14-bank-2'},
    {date:'2026-09-28',description:'Another pending expense for review',merchant:'Coffee And Groceries Combined Merchant',signedAmount:-456789.12,currency:'USD',externalId:'wave14-bank-3'}
  ]},'import visual bank feed');
  await post('/api/bank-rules',{matchText:'very long merchant name for bank feed',classification:'expense',categoryId:customExpenseCategoryId,priority:900},'create visual bank rule');
}
