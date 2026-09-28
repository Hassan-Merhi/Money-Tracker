import test from 'node:test';
import assert from 'node:assert/strict';
import { insightsSnapshot, shiftMonth, categoryOptionsForType } from '../lib/insights.js';

const state={
  categories:[
    {id:'category_food',name:'Food',kind:'expense',icon:'🍽️',archived:false},
    {id:'category_salary',name:'Salary',kind:'income',icon:'💼',archived:false},
    {id:'category_both',name:'General',kind:'both',icon:'•',archived:false}
  ],
  budgets:[{id:'budget_food',categoryId:'category_food',currency:'USD',monthlyLimit:100}],
  entries:[
    {type:'account_expense',amount:30,currency:'USD',date:'2026-09-03',categoryId:'category_food'},
    {type:'account_expense',amount:80,currency:'USD',date:'2026-09-20',categoryId:'category_food'},
    {type:'account_expense',amount:10,currency:'USD',date:'2026-09-22',categoryId:null},
    {type:'account_income',amount:500,currency:'USD',date:'2026-09-25',categoryId:'category_salary'},
    {type:'paid_for_person',amount:50,currency:'USD',date:'2026-09-26',categoryId:'category_food'},
    {type:'account_expense',amount:20,currency:'USD',date:'2026-08-15',categoryId:'category_food'}
  ]
};

test('insights count only personal expense/income ledger types',()=>{
  const s=insightsSnapshot(state,'2026-09',{trendMonths:2});
  assert.deepEqual(s.totals.USD,{expense:120,income:500,net:380});
  assert.equal(s.categoryRows.find(r=>r.categoryId==='category_food').amount,110);
  assert.equal(s.uncategorized[0].amount,10);
});

test('monthly budgets report progress and over-budget status',()=>{
  const s=insightsSnapshot(state,'2026-09');
  const b=s.budgetRows[0];
  assert.equal(b.spent,110);assert.equal(b.remaining,-10);assert.equal(b.percent,110);assert.equal(b.status,'over');
  assert.equal(s.overBudgetCount,1);
});

test('trend includes previous months without mixing person debt flows',()=>{
  const s=insightsSnapshot(state,'2026-09',{trendMonths:2});
  assert.deepEqual(s.trend.map(r=>r.month),['2026-08','2026-09']);
  assert.equal(s.trend[0].totals.USD.expense,20);
  assert.equal(s.trend[1].totals.USD.income,500);
  assert.equal(shiftMonth('2026-01',-1),'2025-12');
});

test('category choices respect expense/income/both and archived state',()=>{
  const archived=[...state.categories,{id:'category_old',name:'Old',kind:'expense',archived:true}];
  assert.deepEqual(categoryOptionsForType(archived,'account_expense').map(c=>c.id),['category_food','category_both']);
  assert.deepEqual(categoryOptionsForType(archived,'account_income').map(c=>c.id),['category_both','category_salary']);
});
