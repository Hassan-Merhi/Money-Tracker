import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecurringReminderService } from '../lib/recurring-worker.js';

test('recurring reminder worker is timezone-aware and idempotent',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mot-recurring-worker-')),db=new DatabaseSync(join(dir,'worker.sqlite'));
  try{
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE users(id TEXT PRIMARY KEY,timezone TEXT NOT NULL);
      CREATE TABLE recurring_rules(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,id TEXT NOT NULL,title TEXT NOT NULL,next_due_date TEXT,remind_days_before INTEGER NOT NULL DEFAULT 0,is_active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(user_id,id));
    `);
    db.prepare('INSERT INTO users VALUES(?,?)').run('u1','Asia/Beirut');
    db.prepare('INSERT INTO recurring_rules VALUES(?,?,?,?,?,?)').run('u1','rule_1','Rent','2026-09-30',2,1);
    const service=createRecurringReminderService(db);
    const now=new Date('2026-09-28T22:30:00.000Z'); // Sep 29 in Beirut
    const first=service.process(now);assert.equal(first.created,1);
    const second=service.process(now);assert.equal(second.created,0);
    const reminders=service.list('u1');assert.equal(reminders.length,1);assert.equal(reminders[0].occurrenceDate,'2026-09-30');
    assert.equal(service.acknowledge('u1',reminders[0].id),true);
    assert.equal(service.list('u1').length,0);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
