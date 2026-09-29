import { fromMinor, sumMinor, toMinor } from './money.js';

export function monthKey(value=new Date()) {
  if (typeof value === 'string' && /^\d{4}-\d{2}$/.test(value)) return value;
  const d=value instanceof Date?value:new Date(value);
  if(Number.isNaN(d.getTime())){const now=new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;}
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

export function shiftMonth(month,delta){
  const [year,mon]=String(month).split('-').map(Number);
  const d=new Date(Date.UTC(year,mon-1+Number(delta||0),1));
  return d.toISOString().slice(0,7);
}

function addCurrencyMinor(map,currency,key,minor){
  const c=currency||'USD';map[c]||={expense:0,income:0};
  map[c][key]=sumMinor([map[c][key]||0,minor]);
}
function publicTotals(map){
  const out={};
  for(const [currency,row] of Object.entries(map||{})){
    out[currency]={
      expense:fromMinor(row.expense||0,currency),
      income:fromMinor(row.income||0,currency),
      net:fromMinor((row.income||0)-(row.expense||0),currency)
    };
  }
  return out;
}
function categoryMeta(categories,id){return (categories||[]).find(c=>c.id===id)||null;}

export function insightsSnapshot(state,month=monthKey(),{trendMonths=6}={}){
  const selected=monthKey(month),entries=state?.entries||[],categories=state?.categories||[],budgets=state?.budgets||[];
  const totalsMinor={},categoryMap=new Map(),uncategorized=new Map(),trend=[];
  const count=Math.max(1,Number(trendMonths)||6);
  const trendKeys=Array.from({length:count},(_,i)=>shiftMonth(selected,i-(count-1)));
  const trendMap=new Map(trendKeys.map(key=>[key,{}]));

  for(const entry of entries){
    if(!['account_expense','account_income'].includes(entry.type))continue;
    const entryMonth=String(entry.date||'').slice(0,7),currency=String(entry.currency||'USD').toUpperCase();
    const amountMinor=toMinor(entry.amount||0,currency),key=entry.type==='account_expense'?'expense':'income';
    if(trendMap.has(entryMonth))addCurrencyMinor(trendMap.get(entryMonth),currency,key,amountMinor);
    if(entryMonth!==selected)continue;
    addCurrencyMinor(totalsMinor,currency,key,amountMinor);
    if(entry.type==='account_expense'){
      const category=categoryMeta(categories,entry.categoryId);
      if(category){
        const mapKey=`${category.id}::${currency}`,row=categoryMap.get(mapKey)||{categoryId:category.id,name:category.name,icon:category.icon||'',currency,amountMinor:0,count:0,archived:!!category.archived};
        row.amountMinor=sumMinor([row.amountMinor,amountMinor]);row.count++;categoryMap.set(mapKey,row);
      }else{
        const row=uncategorized.get(currency)||{currency,amountMinor:0,count:0};
        row.amountMinor=sumMinor([row.amountMinor,amountMinor]);row.count++;uncategorized.set(currency,row);
      }
    }
  }

  for(const key of trendKeys)trend.push({month:key,totals:publicTotals(trendMap.get(key)||{})});

  const categoryRows=[...categoryMap.values()].map(row=>({
    categoryId:row.categoryId,name:row.name,icon:row.icon,currency:row.currency,
    amount:fromMinor(row.amountMinor,row.currency),count:row.count,archived:row.archived
  })).sort((a,b)=>b.amount-a.amount||a.name.localeCompare(b.name));

  const budgetRows=budgets.map(budget=>{
    const category=categoryMeta(categories,budget.categoryId),currency=budget.currency;
    const spentMinor=sumMinor([...categoryMap.values()].filter(row=>row.categoryId===budget.categoryId&&row.currency===currency).map(row=>row.amountMinor));
    const limitMinor=toMinor(budget.monthlyLimit,currency,{allowNegative:false,allowZero:false});
    const remainingMinor=limitMinor-spentMinor;
    const percent=limitMinor>0?Math.max(0,Math.round(spentMinor/limitMinor*1000)/10):0;
    return {
      ...budget,
      categoryName:category?.name||'Unknown category',categoryIcon:category?.icon||'',categoryArchived:!!category?.archived,
      spent:fromMinor(spentMinor,currency),remaining:fromMinor(remainingMinor,currency),percent,
      status:spentMinor>limitMinor?'over':percent>=80?'near':'ok'
    };
  }).sort((a,b)=>Number(b.percent)-Number(a.percent)||a.categoryName.localeCompare(b.categoryName));

  return {
    month:selected,
    totals:publicTotals(totalsMinor),
    categoryRows,
    uncategorized:[...uncategorized.values()].map(row=>({currency:row.currency,amount:fromMinor(row.amountMinor,row.currency),count:row.count})).sort((a,b)=>b.amount-a.amount),
    budgetRows,
    trend,
    overBudgetCount:budgetRows.filter(r=>r.status==='over').length,
    nearBudgetCount:budgetRows.filter(r=>r.status==='near').length
  };
}

export function categoryOptionsForType(categories,type){
  const wanted=type==='account_income'?'income':'expense';
  return (categories||[]).filter(c=>!c.archived&&(c.kind===wanted||c.kind==='both')).sort((a,b)=>a.name.localeCompare(b.name));
}
