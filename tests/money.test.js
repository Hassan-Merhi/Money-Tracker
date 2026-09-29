import test from 'node:test';
import assert from 'node:assert/strict';
import { currencyExponent, fromMinor, normalizeMoney, sumMinor, toMinor } from '../lib/money.js';

test('currency precision rules cover zero two three and four decimal currencies',()=>{
  assert.equal(currencyExponent('JPY'),0);
  assert.equal(currencyExponent('USD'),2);
  assert.equal(currencyExponent('KWD'),3);
  assert.equal(currencyExponent('CLF'),4);
  assert.equal(currencyExponent('LBP'),2);
});

test('integer minor units eliminate common binary floating point drift',()=>{
  const total=sumMinor([toMinor(0.1,'USD'),toMinor(0.2,'USD')]);
  assert.equal(total,30);
  assert.equal(fromMinor(total,'USD'),0.3);
  assert.equal(toMinor(10.29,'USD'),1029);
  assert.equal(toMinor(1.234,'KWD'),1234);
});

test('money normalization rejects unsupported fractional precision instead of rounding silently',()=>{
  assert.equal(normalizeMoney(10.29,'USD'),10.29);
  assert.equal(normalizeMoney(100,'JPY'),100);
  assert.throws(()=>toMinor(10.291,'USD'),/at most 2 decimal/);
  assert.throws(()=>toMinor(1.2,'JPY'),/at most 0 decimal/);
  assert.throws(()=>toMinor(Number.MAX_SAFE_INTEGER,'USD'),/too large/);
});
