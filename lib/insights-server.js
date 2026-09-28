import { randomUUID } from 'node:crypto';

const DEFAULT_CATEGORIES=[
  ['category_food','Food','expense','🍽️'],
  ['category_shopping','Shopping','expense','🛍️'],
  ['category_transport','Transport','expense','🚗'],
  ['category_bills','Bills & utilities','expense','🧾'],
  ['category_entertainment','Entertainment','expense','🎬'],
  ['category_health','Health','expense','🩺'],
  ['category_travel','Travel','expense','✈️'],
  ['category_other_expense','Other expense','expense','•'],
  ['category_salary','Salary','income','💼'],
  ['category_refund','Refund','income','↩️'],
  ['category_other_income','Other income','income','＋']
];

function now(){return new Date().toISOString();}
function safe(value,max=80){return String(value??'').trim().slice(0,max);}
function validCurrency(value){return /^[A-Z]{3,5}$/.test(String(value||''));}
function err(message,status=400){return Object.assign(new Error(message),{status});}

export function createInsightsService(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id,id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_user_name ON categories(user_id, lower(name));
    CREATE TABLE IF NOT EXISTS budgets (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      currency TEXT NOT NULL,
      monthly_limit REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id,id),
      UNIQUE (user_id,category_id,currency)
    );
    CREATE INDEX IF NOT EXISTS idx_budgets_user ON budgets(user_id,category_id,currency);
  `);

  const q={
    categories:db.prepare("SELECT id,name,kind,icon,archived,created_at AS createdAt,updated_at AS updatedAt FROM categories WHERE user_id=? ORDER BY archived,name COLLATE NOCASE"),
    category:db.prepare("SELECT id,name,kind,icon,archived,created_at AS createdAt,updated_at AS updatedAt FROM categories WHERE user_id=? AND id=?"),
    categoryCount:db.prepare('SELECT COUNT(*) AS count FROM categories WHERE user_id=?'),
    insertCategory:db.prepare('INSERT INTO categories(user_id,id,name,kind,icon,archived,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)'),
    insertCategoryExact:db.prepare('INSERT INTO categories(user_id,id,name,kind,icon,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)'),
    updateCategory:db.prepare('UPDATE categories SET name=?,kind=?,icon=?,updated_at=? WHERE user_id=? AND id=?'),
    archiveCategory:db.prepare('UPDATE categories SET archived=1,updated_at=? WHERE user_id=? AND id=?'),
    restoreCategory:db.prepare('UPDATE categories SET archived=0,updated_at=? WHERE user_id=? AND id=?'),
    budgets:db.prepare("SELECT id,category_id AS categoryId,currency,monthly_limit AS monthlyLimit,created_at AS createdAt,updated_at AS updatedAt FROM budgets WHERE user_id=? ORDER BY currency,category_id"),
    budgetByKey:db.prepare("SELECT id,category_id AS categoryId,currency,monthly_limit AS monthlyLimit,created_at AS createdAt,updated_at AS updatedAt FROM budgets WHERE user_id=? AND category_id=? AND currency=?"),
    budgetById:db.prepare("SELECT id,category_id AS categoryId,currency,monthly_limit AS monthlyLimit,created_at AS createdAt,updated_at AS updatedAt FROM budgets WHERE user_id=? AND id=?"),
    upsertBudget:db.prepare('INSERT INTO budgets(user_id,id,category_id,currency,monthly_limit,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,category_id,currency) DO UPDATE SET monthly_limit=excluded.monthly_limit,updated_at=excluded.updated_at'),
    deleteBudget:db.prepare('DELETE FROM budgets WHERE user_id=? AND id=?'),
    deleteCategoryBudgets:db.prepare('DELETE FROM budgets WHERE user_id=? AND category_id=?'),
    deleteAllBudgets:db.prepare('DELETE FROM budgets WHERE user_id=?'),
    deleteAllCategories:db.prepare('DELETE FROM categories WHERE user_id=?'),
    insertBudgetExact:db.prepare('INSERT INTO budgets(user_id,id,category_id,currency,monthly_limit,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
  };

  function ensureDefaults(userId){
    if(Number(q.categoryCount.get(userId)?.count||0)>0)return;
    const stamp=now();
    db.exec('BEGIN IMMEDIATE');
    try{
      if(Number(q.categoryCount.get(userId)?.count||0)===0){
        for(const [id,name,kind,icon] of DEFAULT_CATEGORIES) q.insertCategory.run(userId,id,name,kind,icon,stamp,stamp);
      }
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }

  function categoryForUser(userId,id){
    if(!id)return null;
    return q.category.get(userId,String(id))||null;
  }

  function cleanCategory(input){
    const name=safe(input?.name,60),kind=String(input?.kind||'expense'),icon=safe(input?.icon,8);
    if(!name)throw err('Category name is required.');
    if(!['expense','income','both'].includes(kind))throw err('Choose a valid category type.');
    return {name,kind,icon};
  }

  function list(userId){
    ensureDefaults(userId);
    return {categories:q.categories.all(userId).map(row=>({...row,archived:!!row.archived})),budgets:q.budgets.all(userId)};
  }

  return {
    ensureDefaults,
    list,
    categoryForUser,
    validateCategory(userId,id,{kind=null,active=false}={}){
      if(!id)return null;
      const category=categoryForUser(userId,id);
      if(!category)throw err('Choose a valid category.');
      if(active&&category.archived)throw err('That category is archived.');
      if(kind&&category.kind!==kind&&category.kind!=='both')throw err(kind==='expense'?'Choose an expense category.':'Choose an income category.');
      return category;
    },
    createCategory(userId,input){
      ensureDefaults(userId);
      if(Number(q.categoryCount.get(userId)?.count||0)>=250)throw err('You can keep up to 250 categories.');
      const clean=cleanCategory(input),id='category_'+randomUUID(),stamp=now();
      try{q.insertCategory.run(userId,id,clean.name,clean.kind,clean.icon,stamp,stamp);}
      catch(error){if(String(error.message).includes('UNIQUE'))throw err('A category with that name already exists.');throw error;}
      return {...q.category.get(userId,id),archived:false};
    },
    updateCategory(userId,id,input){
      ensureDefaults(userId);
      const existing=categoryForUser(userId,id);if(!existing)throw err('Category not found.',404);
      const clean=cleanCategory(input);
      try{q.updateCategory.run(clean.name,clean.kind,clean.icon,now(),userId,id);}
      catch(error){if(String(error.message).includes('UNIQUE'))throw err('A category with that name already exists.');throw error;}
      return {...q.category.get(userId,id),archived:!!q.category.get(userId,id).archived};
    },
    archiveCategory(userId,id){
      const existing=categoryForUser(userId,id);if(!existing)throw err('Category not found.',404);
      q.archiveCategory.run(now(),userId,id);q.deleteCategoryBudgets.run(userId,id);
      const row=q.category.get(userId,id);return {...row,archived:true};
    },
    restoreCategory(userId,id){
      const existing=categoryForUser(userId,id);if(!existing)throw err('Category not found.',404);
      q.restoreCategory.run(now(),userId,id);
      const row=q.category.get(userId,id);return {...row,archived:false};
    },
    saveBudget(userId,input){
      ensureDefaults(userId);
      const categoryId=String(input?.categoryId||''),currency=String(input?.currency||'').toUpperCase(),limit=Number(input?.monthlyLimit);
      const category=this.validateCategory(userId,categoryId,{kind:'expense',active:true});
      if(!category)throw err('Choose an expense category.');
      if(!validCurrency(currency))throw err('Choose a valid currency.');
      if(!(limit>0)||!Number.isFinite(limit)||limit>1e15)throw err('Monthly budget must be greater than zero.');
      const existing=q.budgetByKey.get(userId,categoryId,currency),id=existing?.id||('budget_'+randomUUID()),stamp=now();
      q.upsertBudget.run(userId,id,categoryId,currency,limit,existing?.createdAt||stamp,stamp);
      return q.budgetByKey.get(userId,categoryId,currency);
    },
    deleteBudget(userId,id){
      const result=q.deleteBudget.run(userId,String(id||''));if(!Number(result.changes))throw err('Budget not found.',404);return {ok:true};
    },
    replace(userId,categories=[],budgets=[]){
      if(!Array.isArray(categories)||!Array.isArray(budgets)||categories.length>250||budgets.length>1000)throw err('Invalid category or budget backup.');
      const cleanCategories=[],seenIds=new Set(),seenNames=new Set(),stamp=now();
      for(const raw of categories){
        const id=String(raw?.id||''),name=safe(raw?.name,60),kind=String(raw?.kind||'expense'),icon=safe(raw?.icon,8),archived=!!raw?.archived;
        if(!/^category_[A-Za-z0-9_-]+$/.test(id)||seenIds.has(id)||!name||!['expense','income','both'].includes(kind))throw err('Invalid category backup record.');
        const nameKey=name.toLowerCase();if(seenNames.has(nameKey))throw err('Duplicate category names in backup.');
        seenIds.add(id);seenNames.add(nameKey);cleanCategories.push({id,name,kind,icon,archived,createdAt:String(raw?.createdAt||stamp),updatedAt:String(raw?.updatedAt||stamp)});
      }
      const categoryMap=new Map(cleanCategories.map(row=>[row.id,row])),cleanBudgets=[],budgetKeys=new Set();
      for(const raw of budgets){
        const id=String(raw?.id||''),categoryId=String(raw?.categoryId||''),currency=String(raw?.currency||'').toUpperCase(),monthlyLimit=Number(raw?.monthlyLimit),category=categoryMap.get(categoryId),key=categoryId+'::'+currency;
        if(!/^budget_[A-Za-z0-9_-]+$/.test(id)||!category||category.archived||(category.kind!=='expense'&&category.kind!=='both')||!validCurrency(currency)||!(monthlyLimit>0)||!Number.isFinite(monthlyLimit)||monthlyLimit>1e15||budgetKeys.has(key))throw err('Invalid budget backup record.');
        budgetKeys.add(key);cleanBudgets.push({id,categoryId,currency,monthlyLimit,createdAt:String(raw?.createdAt||stamp),updatedAt:String(raw?.updatedAt||stamp)});
      }
      q.deleteAllBudgets.run(userId);q.deleteAllCategories.run(userId);
      for(const row of cleanCategories)q.insertCategoryExact.run(userId,row.id,row.name,row.kind,row.icon,row.archived?1:0,row.createdAt,row.updatedAt);
      for(const row of cleanBudgets)q.insertBudgetExact.run(userId,row.id,row.categoryId,row.currency,row.monthlyLimit,row.createdAt,row.updatedAt);
      if(!cleanCategories.length){for(const [id,name,kind,icon] of DEFAULT_CATEGORIES)q.insertCategoryExact.run(userId,id,name,kind,icon,0,stamp,stamp);}
      return {categories:q.categories.all(userId).map(row=>({...row,archived:!!row.archived})),budgets:q.budgets.all(userId)};
    },
    reset(userId){q.deleteAllBudgets.run(userId);q.deleteAllCategories.run(userId);}
  };
}
