import test from 'node:test';
import assert from 'node:assert/strict';
import { nextRecurringDate, daysBetween, recurringStatus, shouldRemind, recurrenceLabel } from '../lib/recurring.js';

test('advances daily and weekly schedules', () => {
  assert.equal(nextRecurringDate('2026-09-28','daily',2),'2026-09-30');
  assert.equal(nextRecurringDate('2026-09-28','weekly',2),'2026-10-12');
});

test('monthly schedules keep the anchor day across short months', () => {
  assert.equal(nextRecurringDate('2026-01-31','monthly',1,'2026-01-31'),'2026-02-28');
  assert.equal(nextRecurringDate('2026-02-28','monthly',1,'2026-01-31'),'2026-03-31');
});

test('yearly schedules clamp leap day safely', () => {
  assert.equal(nextRecurringDate('2028-02-29','yearly',1,'2028-02-29'),'2029-02-28');
  assert.equal(nextRecurringDate('2031-02-28','yearly',1,'2028-02-29'),'2032-02-29');
});

test('reminder status distinguishes overdue, due and upcoming', () => {
  const base={isActive:true,nextDueDate:'2026-09-28',remindDaysBefore:3};
  assert.equal(recurringStatus({...base,nextDueDate:'2026-09-27'},'2026-09-28').key,'overdue');
  assert.equal(recurringStatus(base,'2026-09-28').key,'due');
  assert.equal(recurringStatus({...base,nextDueDate:'2026-09-30'},'2026-09-28').key,'upcoming');
  assert.equal(shouldRemind({...base,nextDueDate:'2026-10-01'},'2026-09-28'),true);
  assert.equal(shouldRemind({...base,nextDueDate:'2026-10-02'},'2026-09-28'),false);
});

test('recurrence labels are readable', () => {
  assert.equal(recurrenceLabel({frequency:'monthly',interval:1}),'Every month');
  assert.equal(recurrenceLabel({frequency:'weekly',interval:2}),'Every 2 weeks');
  assert.equal(daysBetween('2026-09-28','2026-10-01'),3);
});
