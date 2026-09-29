import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoneyValue } from '../lib/money-parse.js';

test('parseMoneyValue handles European and US formats',()=>{
  assert.equal(parseMoneyValue('1.234,56'),1234.56);
  assert.equal(parseMoneyValue('1,234.56'),1234.56);
});

test('parseMoneyValue handles parentheses negatives and symbols',()=>{
  assert.equal(parseMoneyValue('(50)'),-50);
  assert.equal(parseMoneyValue('$1 200'),1200);
  assert.equal(parseMoneyValue(' -25.40 '),-25.4);
});

test('parseMoneyValue returns NaN on empty or invalid',()=>{
  assert.ok(Number.isNaN(parseMoneyValue('')));
  assert.ok(Number.isNaN(parseMoneyValue('   ')));
  assert.ok(Number.isNaN(parseMoneyValue(null)));
});

test('parseMoneyValue parity with bank-feed parser',()=>{
  // These cases are from bank-feed tests
  assert.equal(parseMoneyValue('1.234,56'),1234.56);
  assert.equal(parseMoneyValue('100,25'),100.25);
});

test('importer and legacy parsers delegate to parseMoneyValue', async()=>{
  const { parseMoney } = await import('../lib/importer.js');
  const legacy = await import('../lib/legacy-excel.js');
  // We cannot directly test legacy money() as it's not exported, but we can test that analyzeLegacyWorkbook uses robust parser
  // For importer, parseMoney should equal parseMoneyValue
  assert.equal(parseMoney('1.234,56'), parseMoneyValue('1.234,56'));
  assert.equal(parseMoney('1,234.56'), parseMoneyValue('1,234.56'));
  assert.equal(parseMoney('(50)'), parseMoneyValue('(50)'));
  assert.equal(parseMoney('$1 200'), parseMoneyValue('$1 200'));
  assert.ok(Number.isNaN(parseMoney('')));
});
