import test from 'node:test';
import assert from 'node:assert/strict';
import { dateInTimeZone, today } from '../lib/utils.js';

// 2026-09-29 15:00 UTC: still the 29th in UTC and Beirut (UTC+3), already the 30th in Auckland (NZDT, UTC+13).
const instant=new Date('2026-09-29T15:00:00Z');

test('dateInTimeZone returns the local calendar date for UTC, Asia/Beirut and Pacific/Auckland',()=>{
  assert.equal(dateInTimeZone('UTC',instant),'2026-09-29');
  assert.equal(dateInTimeZone('Asia/Beirut',instant),'2026-09-29');
  assert.equal(dateInTimeZone('Pacific/Auckland',instant),'2026-09-30');
});

test('dateInTimeZone rolls over at local midnight',()=>{
  assert.equal(dateInTimeZone('Asia/Beirut',new Date('2026-09-29T20:59:59Z')),'2026-09-29');
  assert.equal(dateInTimeZone('Asia/Beirut',new Date('2026-09-29T21:00:00Z')),'2026-09-30');
  // UTC+13 user at 09:00 local is still "yesterday" in UTC
  const nzMorning=new Date('2026-09-29T20:00:00Z');
  assert.equal(nzMorning.toISOString().slice(0,10),'2026-09-29');
  assert.equal(dateInTimeZone('Pacific/Auckland',nzMorning),'2026-09-30');
  // west of UTC lags behind
  assert.equal(dateInTimeZone('America/Los_Angeles',new Date('2026-09-29T03:00:00Z')),'2026-09-28');
});

test('dateInTimeZone always yields ISO YYYY-MM-DD and defaults to now',()=>{
  assert.match(dateInTimeZone('Asia/Beirut'),/^\d{4}-\d{2}-\d{2}$/);
  assert.match(dateInTimeZone('Pacific/Auckland',new Date('2026-01-05T00:00:00Z')),/^2026-01-05$/);
});

test('dateInTimeZone falls back to the UTC today() for a missing or invalid zone',()=>{
  for(const zone of ['Not/AZone','',undefined,null,'   ']){
    const before=today(),value=dateInTimeZone(zone),after=today();
    assert.ok(value===before||value===after,String(zone));
  }
  assert.equal(dateInTimeZone('Not/AZone',instant),today());
});

test('today() is unchanged and stays UTC based',()=>{
  assert.equal(today(),new Date().toISOString().slice(0,10));
});
