import { DATA_LIMITS } from './data-limits.js';

function dateOnlyInTimeZone(date,timeZone){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const map=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}
function shiftDate(value,days){
  const d=new Date(String(value)+'T00:00:00Z');
  d.setUTCDate(d.getUTCDate()+Number(days||0));
  return d.toISOString().slice(0,10);
}
function safeTimeZone(value){
  const tz=String(value||'UTC');
  try{new Intl.DateTimeFormat('en-US',{timeZone:tz}).format(new Date());return tz;}catch{return 'UTC';}
}

export function createRecurringReminderService(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_notifications (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      occurrence_date TEXT NOT NULL,
      remind_on_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      PRIMARY KEY(user_id,id),
      UNIQUE(user_id,rule_id,occurrence_date)
    );
    CREATE INDEX IF NOT EXISTS idx_recurring_notifications_user_status ON recurring_notifications(user_id,status,remind_on_date);
  `);
  const q={
    candidates:db.prepare(`SELECT r.user_id AS userId,r.id AS ruleId,r.title,r.next_due_date AS nextDueDate,r.remind_days_before AS remindDaysBefore,u.timezone
      FROM recurring_rules r JOIN users u ON u.id=r.user_id
      WHERE r.is_active=1 AND r.next_due_date IS NOT NULL`),
    insert:db.prepare(`INSERT OR IGNORE INTO recurring_notifications(user_id,id,rule_id,occurrence_date,remind_on_date,status,created_at)
      VALUES(?,?,?,?,?,'pending',?)`),
    list:db.prepare(`SELECT n.id,n.rule_id AS ruleId,n.occurrence_date AS occurrenceDate,n.remind_on_date AS remindOnDate,n.status,n.created_at AS createdAt,
      r.title,r.next_due_date AS currentNextDueDate
      FROM recurring_notifications n LEFT JOIN recurring_rules r ON r.user_id=n.user_id AND r.id=n.rule_id
      WHERE n.user_id=? AND n.status='pending'
      ORDER BY n.occurrence_date,n.created_at`),
    ack:db.prepare("UPDATE recurring_notifications SET status='acknowledged',acknowledged_at=? WHERE user_id=? AND id=? AND status='pending'"),
    ackOccurrence:db.prepare("UPDATE recurring_notifications SET status='acknowledged',acknowledged_at=? WHERE user_id=? AND rule_id=? AND occurrence_date=? AND status='pending'"),
    cleanupAcknowledged:db.prepare("DELETE FROM recurring_notifications WHERE status='acknowledged' AND acknowledged_at IS NOT NULL AND acknowledged_at < ?"),
    notificationUsers:db.prepare('SELECT DISTINCT user_id AS userId FROM recurring_notifications'),
    trimAcknowledged:db.prepare("DELETE FROM recurring_notifications WHERE user_id=? AND status='acknowledged' AND id NOT IN (SELECT id FROM recurring_notifications WHERE user_id=? AND status='acknowledged' ORDER BY COALESCE(acknowledged_at,created_at) DESC LIMIT ?)"),
    deleteRule:db.prepare('DELETE FROM recurring_notifications WHERE user_id=? AND rule_id=?'),
    reset:db.prepare('DELETE FROM recurring_notifications WHERE user_id=?')
  };
  let lastRunAt=null,lastCreated=0,lastError=null;
  function cleanup(now=new Date()){
    const cutoff=new Date(now.getTime()-180*86400_000).toISOString();
    q.cleanupAcknowledged.run(cutoff);
    for(const row of q.notificationUsers.all())q.trimAcknowledged.run(row.userId,row.userId,DATA_LIMITS.recurringAcknowledgedRetained);
  }
  function process(now=new Date()){
    let created=0;
    try{
      cleanup(now);
      for(const row of q.candidates.all()){
        const timezone=safeTimeZone(row.timezone),today=dateOnlyInTimeZone(now,timezone);
        const remindOn=shiftDate(row.nextDueDate,-Math.max(0,Number(row.remindDaysBefore||0)));
        if(today<remindOn)continue;
        const stamp=now.toISOString(),id=`reminder_${row.ruleId}_${row.nextDueDate}`.replace(/[^A-Za-z0-9_-]/g,'_');
        created+=Number(q.insert.run(row.userId,id,row.ruleId,row.nextDueDate,remindOn,stamp).changes||0);
      }
      cleanup(now);
      lastRunAt=now.toISOString();lastCreated=created;lastError=null;
      return {ok:true,created,lastRunAt};
    }catch(error){lastRunAt=now.toISOString();lastCreated=created;lastError=String(error?.message||error);throw error;}
  }
  return {
    process,
    list(userId){return q.list.all(userId);},
    acknowledge(userId,id){return Number(q.ack.run(new Date().toISOString(),userId,id).changes||0)>0;},
    acknowledgeOccurrence(userId,ruleId,occurrenceDate){q.ackOccurrence.run(new Date().toISOString(),userId,ruleId,occurrenceDate);},
    deleteRule(userId,ruleId){q.deleteRule.run(userId,ruleId);},
    reset(userId){q.reset.run(userId);},
    status(){return {lastRunAt,lastCreated,lastError,retainedAcknowledgedPerUser:DATA_LIMITS.recurringAcknowledgedRetained};}
  };
}

export {dateOnlyInTimeZone,safeTimeZone};
