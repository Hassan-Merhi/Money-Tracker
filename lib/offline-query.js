export function normalizeSearchText(value=''){
  return String(value??'')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/[_/\\|.,:;()[\]{}+\-]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

export function searchTokens(query=''){
  const normalized=normalizeSearchText(query);
  return normalized?normalized.split(' ').filter(Boolean):[];
}

export function matchesSearchText(text,query=''){
  const tokens=searchTokens(query);
  if(!tokens.length)return true;
  const haystack=normalizeSearchText(text);
  return tokens.every(token=>haystack.includes(token));
}

function namesById(rows=[]){
  return new Map((rows||[]).map(row=>[row.id,row.name||row.title||'']));
}

export function peopleSearchText(person={}){
  return [person.name,person.note,person.currency,person.direction].filter(Boolean).join(' ');
}

export function entrySearchText(entry={},state={}){
  const people=namesById(state.people),accounts=namesById(state.accounts),categories=namesById(state.categories);
  const splitText=(entry.splits||[]).flatMap(split=>[people.get(split.personId),split.note,split.amount]).filter(Boolean);
  return [
    entry.id,entry.date,String(entry.type||'').replaceAll('_',' '),entry.description,entry.merchant,
    entry.amount,entry.signedAmount,entry.fromAmount,entry.toAmount,entry.currency,
    people.get(entry.personId),accounts.get(entry.accountId),accounts.get(entry.fromAccountId),accounts.get(entry.toAccountId),
    categories.get(entry.categoryId),...splitText
  ].filter(value=>value!==undefined&&value!==null&&value!=='').join(' ');
}

export function matchesEntrySearch(entry,state={},query=''){
  return matchesSearchText(entrySearchText(entry,state),query);
}

export function bankFeedSearchText(item={},state={}){
  const accounts=namesById(state.accounts),people=namesById(state.people),categories=namesById(state.categories);
  return [
    item.id,item.date,item.merchant,item.description,item.sourceName,item.externalId,item.currency,item.status,
    item.signedAmount,item.signedAmountMinor,item.suggestedType,
    accounts.get(item.accountId),accounts.get(item.suggestedTargetAccountId),
    people.get(item.suggestedPersonId),categories.get(item.suggestedCategoryId)
  ].filter(value=>value!==undefined&&value!==null&&value!=='').join(' ');
}

export function filterBankFeedItems(items=[],params={},state={}){
  const status=['pending','posted','ignored'].includes(String(params.status||''))?String(params.status):'';
  const accountId=String(params.accountId||''),from=String(params.from||''),to=String(params.to||''),query=String(params.q||'');
  return (items||[]).filter(item=>{
    if(status&&item.status!==status)return false;
    if(accountId&&item.accountId!==accountId)return false;
    const date=String(item.date||'');
    if(from&&date<from)return false;
    if(to&&date>to)return false;
    return matchesSearchText(bankFeedSearchText(item,state),query);
  });
}

export function recurringSearchText(rule={},state={}){
  const people=namesById(state.people),accounts=namesById(state.accounts),categories=namesById(state.categories),template=rule.template||{};
  return [
    rule.id,rule.title,rule.frequency,rule.anchorDate,rule.nextDueDate,rule.endDate,
    template.type,template.description,template.merchant,template.amount,template.currency,
    people.get(template.personId),accounts.get(template.accountId),accounts.get(template.fromAccountId),accounts.get(template.toAccountId),
    categories.get(template.categoryId)
  ].filter(value=>value!==undefined&&value!==null&&value!=='').join(' ');
}

export function filterRecurringRules(rules=[],params={},state={}){
  const query=String(params.q||''),status=String(params.status||'all');
  return (rules||[]).filter(rule=>{
    if(status==='active'&&!rule.isActive)return false;
    if(status==='paused'&&rule.isActive)return false;
    if(status==='complete'&&(rule.isActive||rule.nextDueDate))return false;
    return matchesSearchText(recurringSearchText(rule,state),query);
  });
}
