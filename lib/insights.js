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

function round(value){ return Math.round((Number(value||0)+Number.EPSILON)*100)/100; }
function addCurrency(map,currency,key,amount){
  const c=currency||'USD'; map[c]||={expense:0,income:0,net:0};
  map[c][key]=round((map[c][key]||0)+Number(amount||0));
  map[c].net=round(map[c].income-map[c].expense);
}
function categoryMeta(categories,id){
  return (categories||[]).find(c=>c.id===id)||null;
}

export function insightsSnapshot(state,month=monthKey(),{trendMonths=6}={}){
  const selected=monthKey(month),entries=state?.entries||[],categories=state?.categories||[],budgets=state?.budgets||[];
  const totals={},categoryMap=new Map(),uncategorized={},trend=[];
  const trendKeys=Array.from({length:Math.max(1,Number(trendMonths)||6)},(_,i)=>shiftMonth(selected,i-(Math.max(1,Number(trendMonths)||6)-1)));
  const trendMap=new Map(trendKeys.map(key=>[key,{}]));

  for(const entry of entries){
    if(!['account_expense','account_income'].includes(entry.type)) continue;
    const entryMonth=String(entry.date||'').slice(0,7);
    const currency=entry.currency||'USD',amount=Number(entry.amount||0);
    const key=entry.type==='account_expense'?'expense':'income';
    if(trendMap.has(entryMonth)) addCurrency(trendMap.get(entryMonth),currency,key,amount);
    if(entryMonth!==selected) continue;
    addCurrency(totals,currency,key,amount);
    if(entry.type==='account_expense'){
      const category=categoryMeta(categories,entry.categoryId);
      if(category){
        const mapKey=`${category.id}::${currency}`;
        const row=categoryMap.get(mapKey)||{categoryId:category.id,name:category.name,icon:category.icon||'',currency,amount:0,count:0,archived:!!category.archived};
        row.amount=round(row.amount+amount);row.count++;categoryMap.set(mapKey,row);
      }else{
        uncategorized[currency]||={currency,amount:0,count:0};
        uncategorized[currency].amount=round(uncategorized[currency].amount+amount);uncategorized[currency].count++;
      }
    }
  }

  for(const key of trendKeys) trend.push({month:key,totals:trendMap.get(key)||{}});

  const categoryRows=[...categoryMap.values()].sort((a,b)=>b.amount-a.amount||a.name.localeCompare(b.name));
  const budgetRows=budgets.map(budget=>{
    const category=categoryMeta(categories,budget.categoryId);
    const spent=round(categoryRows.filter(r=>r.categoryId===budget.categoryId&&r.currency===budget.currency).reduce((sum,row)=>sum+row.amount,0));
    const limit=round(budget.monthlyLimit),remaining=round(limit-spent),percent=limit>0?Math.max(0,Math.round(spent/limit*1000)/10):0;
    return {
      ...budget,
      categoryName:category?.name||'Unknown category',
      categoryIcon:category?.icon||'',
      categoryArchived:!!category?.archived,
      spent,remaining,percent,
      status:spent>limit?'over':percent>=80?'near':'ok'
    };
  }).sort((a,b)=>Number(b.percent)-Number(a.percent)||a.categoryName.localeCompare(b.categoryName));

  return {
    month:selected,
    totals,
    categoryRows,
    uncategorized:Object.values(uncategorized).sort((a,b)=>b.amount-a.amount),
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
