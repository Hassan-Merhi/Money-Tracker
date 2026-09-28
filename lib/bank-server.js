import { createHash, randomUUID } from 'node:crypto';

const CLASSIFICATIONS=new Set(['expense','income','paid_for_person','received_from_person','borrowed_from_person','paid_to_person','transfer']);

function sha(value){return createHash('sha256').update(String(value)).digest('hex');}
function now(){return new Date().toISOString();}
function safe(value,max=180){return String(value??'').trim().slice(0,max);}
function validDate(value){return /^\d{4}-\d{2}-\d{2}$/.test(String(value||''))&&!Number.isNaN(Date.parse(String(value)+'T00:00:00Z'));}
function validCurrency(value){return /^[A-Z]{3,5}$/.test(String(value||''));}
function finite(value){const n=Number(value);return Number.isFinite(n)?n:null;}
function error(message,status=400){return Object.assign(new Error(message),{status});}

export function createBankFeedService(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_feed_items (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      source_name TEXT NOT NULL DEFAULT '',
      external_id TEXT NOT NULL DEFAULT '',
      txn_date TEXT NOT NULL,
      description TEXT NOT NULL,
      merchant TEXT NOT NULL DEFAULT '',
      signed_amount REAL NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      suggested_type TEXT NOT NULL DEFAULT '',
      suggested_person_id TEXT,
      suggested_target_account_id TEXT,
      posted_entry_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id,id),
      UNIQUE (user_id,fingerprint)
    );
    CREATE INDEX IF NOT EXISTS idx_bank_feed_user_status_date ON bank_feed_items(user_id,status,txn_date DESC);
    CREATE TABLE IF NOT EXISTS bank_rules (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      match_text TEXT NOT NULL,
      classification TEXT NOT NULL,
      person_id TEXT,
      target_account_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id,id)
    );
    CREATE INDEX IF NOT EXISTS idx_bank_rules_user ON bank_rules(user_id,updated_at DESC);
  `);
  const feedColumns=new Set(db.prepare('PRAGMA table_info(bank_feed_items)').all().map(row=>row.name));
  if(!feedColumns.has('suggested_category_id'))db.exec('ALTER TABLE bank_feed_items ADD COLUMN suggested_category_id TEXT');
  const ruleColumns=new Set(db.prepare('PRAGMA table_info(bank_rules)').all().map(row=>row.name));
  if(!ruleColumns.has('category_id'))db.exec('ALTER TABLE bank_rules ADD COLUMN category_id TEXT');

  const q={
    accounts:db.prepare('SELECT id,name,type,currency FROM accounts WHERE user_id=? ORDER BY created_at'),
    people:db.prepare('SELECT id,name FROM people WHERE user_id=? ORDER BY name COLLATE NOCASE'),
    categories:db.prepare('SELECT id,name,kind,archived FROM categories WHERE user_id=? ORDER BY name COLLATE NOCASE'),
    items:db.prepare("SELECT id,account_id AS accountId,source_name AS sourceName,external_id AS externalId,txn_date AS date,description,merchant,signed_amount AS signedAmount,currency,status,suggested_type AS suggestedType,suggested_person_id AS suggestedPersonId,suggested_target_account_id AS suggestedTargetAccountId,suggested_category_id AS suggestedCategoryId,posted_entry_id AS postedEntryId,created_at AS createdAt,updated_at AS updatedAt FROM bank_feed_items WHERE user_id=? ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'ignored' THEN 1 ELSE 2 END,txn_date DESC,created_at DESC LIMIT 5000"),
    item:db.prepare("SELECT id,account_id AS accountId,source_name AS sourceName,external_id AS externalId,txn_date AS date,description,merchant,signed_amount AS signedAmount,currency,status,suggested_type AS suggestedType,suggested_person_id AS suggestedPersonId,suggested_target_account_id AS suggestedTargetAccountId,suggested_category_id AS suggestedCategoryId,posted_entry_id AS postedEntryId,created_at AS createdAt,updated_at AS updatedAt FROM bank_feed_items WHERE user_id=? AND id=?"),
    insertItem:db.prepare('INSERT OR IGNORE INTO bank_feed_items(user_id,id,account_id,fingerprint,source_name,external_id,txn_date,description,merchant,signed_amount,currency,status,suggested_type,suggested_person_id,suggested_target_account_id,suggested_category_id,posted_entry_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
    setStatus:db.prepare('UPDATE bank_feed_items SET status=?,posted_entry_id=?,updated_at=? WHERE user_id=? AND id=? AND status=?'),
    remove:db.prepare("DELETE FROM bank_feed_items WHERE user_id=? AND id=? AND status<>'posted'"),
    reopenOrphans:db.prepare("UPDATE bank_feed_items SET status='pending',posted_entry_id=NULL,updated_at=? WHERE user_id=? AND status='posted' AND posted_entry_id NOT IN (SELECT id FROM entries WHERE user_id=?)"),
    deleteMissingAccountItems:db.prepare("DELETE FROM bank_feed_items WHERE user_id=? AND status<>'posted' AND account_id NOT IN (SELECT id FROM accounts WHERE user_id=?)"),
    deleteBrokenRules:db.prepare("DELETE FROM bank_rules WHERE user_id=? AND ((person_id IS NOT NULL AND person_id NOT IN (SELECT id FROM people WHERE user_id=?)) OR (target_account_id IS NOT NULL AND target_account_id NOT IN (SELECT id FROM accounts WHERE user_id=?)))"),
    rules:db.prepare('SELECT id,match_text AS matchText,classification,person_id AS personId,target_account_id AS targetAccountId,category_id AS categoryId,created_at AS createdAt,updated_at AS updatedAt FROM bank_rules WHERE user_id=? ORDER BY updated_at DESC'),
    ruleCount:db.prepare('SELECT COUNT(*) AS count FROM bank_rules WHERE user_id=?'),
    insertRule:db.prepare('INSERT INTO bank_rules(user_id,id,match_text,classification,person_id,target_account_id,category_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'),
    deleteRule:db.prepare('DELETE FROM bank_rules WHERE user_id=? AND id=?'),
    deleteAllItems:db.prepare('DELETE FROM bank_feed_items WHERE user_id=?'),
    deleteAllRules:db.prepare('DELETE FROM bank_rules WHERE user_id=?'),
    userRevision:db.prepare('SELECT revision FROM users WHERE id=?'),
    linkedTransferCandidates:db.prepare("SELECT b.posted_entry_id AS postedEntryId,b.signed_amount AS signedAmount,b.txn_date AS date FROM bank_feed_items b WHERE b.user_id=? AND b.status='posted' AND b.account_id=? AND b.currency=? AND b.posted_entry_id IS NOT NULL AND ABS(b.signed_amount + ?) <= 0.005 AND ABS(julianday(b.txn_date)-julianday(?)) <= 3 AND (SELECT COUNT(*) FROM bank_feed_items linked WHERE linked.user_id=b.user_id AND linked.status='posted' AND linked.posted_entry_id=b.posted_entry_id)=1 ORDER BY ABS(julianday(b.txn_date)-julianday(?)) ASC,b.created_at DESC LIMIT 10"),
    transferEntryById:db.prepare("SELECT id,from_account_id AS fromAccountId,to_account_id AS toAccountId,from_amount AS fromAmount,to_amount AS toAmount FROM entries WHERE user_id=? AND id=? AND type='account_transfer'"),
    bumpRevision:db.prepare('UPDATE users SET revision=revision+1 WHERE id=? AND revision=?'),
    clearInvalidRuleCategories:db.prepare("UPDATE bank_rules SET category_id=NULL WHERE user_id=? AND category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.user_id=? AND c.id=bank_rules.category_id AND c.archived=0 AND (c.kind=bank_rules.classification OR c.kind='both'))"),
    clearInvalidSuggestedCategories:db.prepare("UPDATE bank_feed_items SET suggested_category_id=NULL WHERE user_id=? AND suggested_category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.user_id=? AND c.id=bank_feed_items.suggested_category_id AND c.archived=0 AND (c.kind=bank_feed_items.suggested_type OR c.kind='both'))"),
    insertEntry:db.prepare('INSERT INTO entries(user_id,id,type,person_id,account_id,from_account_id,to_account_id,amount,currency,from_amount,to_amount,signed_amount,date,merchant,description,category_id,split_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  };

  function cleanRule(userId,input){
    const matchText=safe(input?.matchText,120).toLowerCase();
    const classification=String(input?.classification||'');
    if(matchText.length<2)throw error('Rule match text must be at least 2 characters.');
    if(!CLASSIFICATIONS.has(classification))throw error('Choose a valid bank rule action.');
    const people=new Set(q.people.all(userId).map(r=>r.id)),accounts=new Set(q.accounts.all(userId).map(r=>r.id));
    const personId=input?.personId?String(input.personId):null,targetAccountId=input?.targetAccountId?String(input.targetAccountId):null;
    let categoryId=input?.categoryId?String(input.categoryId):null;
    if(['paid_for_person','received_from_person','borrowed_from_person','paid_to_person'].includes(classification)&&!people.has(personId))throw error('Choose a valid person for this rule.');
    if(classification==='transfer'&&!accounts.has(targetAccountId))throw error('Choose a valid transfer account for this rule.');
    if(['expense','income'].includes(classification)&&categoryId){const category=q.categories.all(userId).find(row=>row.id===categoryId&&!row.archived);if(!category||(category.kind!==classification&&category.kind!=='both'))throw error(classification==='expense'?'Choose a valid expense category.':'Choose a valid income category.');}
    if(!['expense','income'].includes(classification))categoryId=null;
    return {matchText,classification,personId,targetAccountId,categoryId};
  }

  function matchRule(userId,text){
    const hay=String(text||'').toLowerCase();
    return q.rules.all(userId).find(r=>hay.includes(String(r.matchText||'').toLowerCase()))||null;
  }

  function validatePost(userId,item,classification,personId,targetAccountId,categoryId){
    if(!CLASSIFICATIONS.has(classification))throw error('Choose what this bank transaction represents.');
    const accounts=q.accounts.all(userId),people=q.people.all(userId);
    const account=accounts.find(r=>r.id===item.accountId); if(!account)throw error('The linked account no longer exists.');
    const outgoing=Number(item.signedAmount)<0;
    if(['expense','paid_for_person','paid_to_person'].includes(classification)&&!outgoing)throw error('This action expects money leaving the account.');
    if(['income','received_from_person','borrowed_from_person'].includes(classification)&&outgoing)throw error('This action expects money entering the account.');
    if(['paid_for_person','received_from_person','borrowed_from_person','paid_to_person'].includes(classification)&&!people.some(r=>r.id===personId))throw error('Choose a valid person.');
    if(['expense','income'].includes(classification)&&categoryId){const category=q.categories.all(userId).find(r=>r.id===categoryId&&!r.archived);if(!category||(category.kind!==classification&&category.kind!=='both'))throw error(classification==='expense'?'Choose a valid expense category.':'Choose a valid income category.');}
    if(classification==='transfer'){
      const target=accounts.find(r=>r.id===targetAccountId);
      if(!target||target.id===account.id)throw error('Choose a different account for the transfer.');
      if(target.currency!==account.currency)throw error('Bank-feed transfers currently require accounts in the same currency.');
    }
    return account;
  }

  function entryFrom(item,classification,{personId=null,targetAccountId=null,categoryId=null,note='',merchant=''}={}){
    const amount=Math.abs(Number(item.signedAmount)),stamp=now();
    const base={id:'entry_'+randomUUID(),amount,date:item.date,merchant:safe(merchant||item.merchant||item.description,100),description:safe(note||item.description,500),createdAt:stamp,updatedAt:stamp,splits:[]};
    if(classification==='expense')return {...base,type:'account_expense',personId:null,accountId:item.accountId,fromAccountId:null,toAccountId:null,currency:item.currency,fromAmount:null,toAmount:null,signedAmount:null,categoryId};
    if(classification==='income')return {...base,type:'account_income',personId:null,accountId:item.accountId,fromAccountId:null,toAccountId:null,currency:item.currency,fromAmount:null,toAmount:null,signedAmount:null,categoryId};
    if(['paid_for_person','received_from_person','borrowed_from_person','paid_to_person'].includes(classification))return {...base,type:classification,personId,accountId:item.accountId,fromAccountId:null,toAccountId:null,currency:item.currency,fromAmount:null,toAmount:null,signedAmount:null};
    if(classification==='transfer'){
      const outgoing=Number(item.signedAmount)<0;
      return {...base,type:'account_transfer',personId:null,accountId:null,fromAccountId:outgoing?item.accountId:targetAccountId,toAccountId:outgoing?targetAccountId:item.accountId,currency:null,fromAmount:amount,toAmount:amount,signedAmount:null};
    }
    throw error('Unsupported bank feed action.');
  }

  function insertEntry(userId,e){
    q.insertEntry.run(userId,e.id,e.type,e.personId,e.accountId,e.fromAccountId,e.toAccountId,e.amount,e.currency,e.fromAmount,e.toAmount,e.signedAmount,e.date,e.merchant,e.description,e.categoryId||null,JSON.stringify(e.splits||[]),e.createdAt,e.updatedAt);
  }

  function existingTransferFor(userId,item,targetAccountId){
    const amount=Math.abs(Number(item.signedAmount)),outgoing=Number(item.signedAmount)<0;
    const candidates=q.linkedTransferCandidates.all(userId,targetAccountId,item.currency,Number(item.signedAmount),item.date,item.date);
    for(const candidate of candidates){
      const entry=q.transferEntryById.get(userId,candidate.postedEntryId);if(!entry)continue;
      const directionMatches=outgoing
        ? entry.fromAccountId===item.accountId&&entry.toAccountId===targetAccountId
        : entry.toAccountId===item.accountId&&entry.fromAccountId===targetAccountId;
      if(!directionMatches)continue;
      if(Math.abs(Number(entry.fromAmount)-amount)>0.005||Math.abs(Number(entry.toAmount)-amount)>0.005)continue;
      return entry;
    }
    return null;
  }

  return {
    list(userId){return {items:q.items.all(userId),rules:q.rules.all(userId)};},
    importRows(userId,{accountId,sourceName='',rows=[]}={}){
      const account=q.accounts.all(userId).find(r=>r.id===String(accountId||'')); if(!account)throw error('Choose a valid account before importing.');
      if(!Array.isArray(rows)||!rows.length||rows.length>5000)throw error('Import between 1 and 5,000 statement rows at a time.');
      let imported=0,skipped=0,invalid=0;const seen=new Map();
      for(const raw of rows){
        const date=String(raw?.date||''),description=safe(raw?.description,300),merchant=safe(raw?.merchant,120),externalId=safe(raw?.externalId,180),signedAmount=finite(raw?.signedAmount),currency=String(raw?.currency||account.currency).toUpperCase();
        if(!validDate(date)||!description||signedAmount===null||Math.abs(signedAmount)<0.000001||Math.abs(signedAmount)>1e15||!validCurrency(currency)||currency!==account.currency){invalid++;continue;}
        const core=externalId?`${account.id}|external|${externalId}`:`${account.id}|${date}|${Number(signedAmount).toFixed(8)}|${currency}|${description.toLowerCase()}|${merchant.toLowerCase()}`;
        const base=sha(core),ordinal=externalId?0:(seen.get(base)||0);seen.set(base,ordinal+1);const fingerprint=externalId?base:sha(base+'#'+ordinal);
        const rule=matchRule(userId,[merchant,description].filter(Boolean).join(' ')),suggestedType=rule?.classification||(signedAmount<0?'expense':'income'),stamp=now(),id='bank_'+randomUUID();
        const result=q.insertItem.run(userId,id,account.id,fingerprint,safe(sourceName,180),externalId,date,description,merchant,signedAmount,currency,'pending',suggestedType,rule?.personId||null,rule?.targetAccountId||null,rule?.categoryId||null,null,stamp,stamp);
        if(Number(result.changes))imported++;else skipped++;
      }
      return {imported,skipped,invalid,...this.list(userId)};
    },
    createRule(userId,input){
      if(Number(q.ruleCount.get(userId)?.count||0)>=500)throw error('You can keep up to 500 bank rules.');
      const clean=cleanRule(userId,input),id='bankrule_'+randomUUID(),stamp=now();
      q.insertRule.run(userId,id,clean.matchText,clean.classification,clean.personId,clean.targetAccountId,clean.categoryId,stamp,stamp);
      return q.rules.all(userId).find(r=>r.id===id);
    },
    deleteRule(userId,id){const r=q.deleteRule.run(userId,String(id||''));if(!Number(r.changes))throw error('Bank rule not found.',404);return {ok:true};},
    post(userId,id,body={}){
      const item=q.item.get(userId,id);if(!item)throw error('Bank feed item not found.',404);if(item.status!=='pending')throw error('This bank feed item was already handled.',409);
      const expected=Number(body.expectedRevision);if(!Number.isInteger(expected))throw error('Missing ledger revision.');
      const classification=String(body.classification||item.suggestedType||''),personId=body.personId?String(body.personId):null,targetAccountId=body.targetAccountId?String(body.targetAccountId):null,categoryId=body.categoryId?String(body.categoryId):(item.suggestedCategoryId||null);
      validatePost(userId,item,classification,personId,targetAccountId,categoryId);
      db.exec('BEGIN IMMEDIATE');
      try{
        const current=q.item.get(userId,id);if(!current||current.status!=='pending')throw error('This bank feed item was already handled.',409);
        const revision=Number(q.userRevision.get(userId)?.revision);if(revision!==expected)throw error('This ledger changed in another tab. Refresh and try again.',409);
        const linked=classification==='transfer'?existingTransferFor(userId,current,targetAccountId):null;
        if(linked){
          const moved=q.setStatus.run('posted',linked.id,now(),userId,id,'pending');if(Number(moved.changes)!==1)throw error('This bank feed item changed in another tab.',409);
          if(body.saveRule)this.createRule(userId,{matchText:body.ruleMatchText||current.merchant||current.description,classification,personId,targetAccountId,categoryId});
          db.exec('COMMIT');
          return {entryId:linked.id,linkedExistingTransfer:true,item:q.item.get(userId,id),rules:q.rules.all(userId)};
        }
        const bumped=q.bumpRevision.run(userId,expected);if(Number(bumped.changes)!==1)throw error('This ledger changed in another tab. Refresh and try again.',409);
        const entry=entryFrom(current,classification,{personId,targetAccountId,categoryId,note:body.note,merchant:body.merchant});insertEntry(userId,entry);
        const moved=q.setStatus.run('posted',entry.id,now(),userId,id,'pending');if(Number(moved.changes)!==1)throw error('This bank feed item changed in another tab.',409);
        if(body.saveRule)this.createRule(userId,{matchText:body.ruleMatchText||current.merchant||current.description,classification,personId,targetAccountId,categoryId});
        db.exec('COMMIT');
        return {entryId:entry.id,linkedExistingTransfer:false,item:q.item.get(userId,id),rules:q.rules.all(userId)};
      }catch(e){db.exec('ROLLBACK');throw e;}
    },
    ignore(userId,id){const item=q.item.get(userId,id);if(!item)throw error('Bank feed item not found.',404);const r=q.setStatus.run('ignored',null,now(),userId,id,'pending');if(!Number(r.changes))throw error('This bank feed item was already handled.',409);return q.item.get(userId,id);},
    reopen(userId,id){const item=q.item.get(userId,id);if(!item)throw error('Bank feed item not found.',404);const r=q.setStatus.run('pending',null,now(),userId,id,'ignored');if(!Number(r.changes))throw error('Only ignored items can be reopened.',409);return q.item.get(userId,id);},
    remove(userId,id){const r=q.remove.run(userId,id);if(!Number(r.changes))throw error('Posted feed items cannot be deleted.',409);return {ok:true};},
    reset(userId){q.deleteAllItems.run(userId);q.deleteAllRules.run(userId);},
    reopenOrphans(userId){q.reopenOrphans.run(now(),userId,userId);},
    reconcileReferences(userId){
      q.deleteMissingAccountItems.run(userId,userId);
      q.deleteBrokenRules.run(userId,userId,userId);
      q.clearInvalidRuleCategories.run(userId,userId);
      q.clearInvalidSuggestedCategories.run(userId,userId);
    }
  };
}
