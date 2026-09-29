import { createHash, randomUUID } from 'node:crypto';

const iso=()=>new Date().toISOString();
const hash=value=>createHash('sha256').update(String(value||'')).digest('hex');

export function createSecurityOps(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_events (
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      subject_hash TEXT NOT NULL DEFAULT '',
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      PRIMARY KEY(id)
    );
    CREATE INDEX IF NOT EXISTS idx_security_events_user_created ON security_events(user_id,created_at DESC);
  `);

  const sessionCols=new Set(db.prepare('PRAGMA table_info(sessions)').all().map(row=>row.name));
  if(!sessionCols.has('last_seen_at'))db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at TEXT');
  if(!sessionCols.has('user_agent_hash'))db.exec("ALTER TABLE sessions ADD COLUMN user_agent_hash TEXT NOT NULL DEFAULT ''");

  const q={
    insertEvent:db.prepare('INSERT INTO security_events(user_id,id,event_type,subject_hash,detail_json,created_at) VALUES(?,?,?,?,?,?)'),
    events:db.prepare('SELECT id,event_type AS eventType,detail_json AS detailJson,created_at AS createdAt FROM security_events WHERE user_id=? ORDER BY created_at DESC LIMIT ?'),
    cleanupEvents:db.prepare('DELETE FROM security_events WHERE created_at < ?'),
    sessions:db.prepare('SELECT token_hash AS tokenHash,created_at AS createdAt,expires_at AS expiresAt,last_seen_at AS lastSeenAt,user_agent_hash AS userAgentHash FROM sessions WHERE user_id=? ORDER BY COALESCE(last_seen_at,created_at) DESC'),
    sessionForTouch:db.prepare('SELECT last_seen_at AS lastSeenAt FROM sessions WHERE token_hash=?'),
    touchSession:db.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?'),
    revokeSession:db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash=?')
  };

  let lastCleanupAt=0;
  function maybeCleanup(){
    if(Date.now()-lastCleanupAt<60*60_000)return;
    cleanup();
  }

  function event(userId,eventType,{subject='',detail={}}={}){
    maybeCleanup();
    const safeType=String(eventType||'security_event').slice(0,80);
    const safeDetail={};
    for(const [key,value] of Object.entries(detail||{})){
      if(['password','token','csrf','cookie','authorization'].some(word=>key.toLowerCase().includes(word)))continue;
      safeDetail[String(key).slice(0,60)]=typeof value==='string'?value.slice(0,300):value;
    }
    q.insertEvent.run(userId||null,'security_'+randomUUID(),safeType,subject?hash(subject):'',JSON.stringify(safeDetail),iso());
  }

  function cleanup(){
    const cutoff=new Date(Date.now()-90*86400_000).toISOString();
    q.cleanupEvents.run(cutoff);
    lastCleanupAt=Date.now();
  }

  function listEvents(userId,limit=100){
    cleanup();
    const n=Math.max(1,Math.min(200,Number(limit)||100));
    return q.events.all(userId,n).map(row=>{
      let detail={};try{detail=JSON.parse(row.detailJson||'{}');}catch{}
      return {id:row.id,eventType:row.eventType,detail,createdAt:row.createdAt};
    });
  }

  function touch(tokenHash){
    const row=q.sessionForTouch.get(tokenHash);if(!row)return;
    const last=row.lastSeenAt?Date.parse(row.lastSeenAt):0;
    if(!last||Date.now()-last>5*60_000)q.touchSession.run(iso(),tokenHash);
  }

  function sessionId(tokenHash){return 'session_'+hash(tokenHash).slice(0,24);}
  function listSessions(userId,currentTokenHash){
    return q.sessions.all(userId).map(row=>({
      id:sessionId(row.tokenHash),
      current:row.tokenHash===currentTokenHash,
      createdAt:row.createdAt,
      lastSeenAt:row.lastSeenAt||row.createdAt,
      expiresAt:row.expiresAt,
      deviceFingerprint:row.userAgentHash?row.userAgentHash.slice(0,12):''
    }));
  }

  function revoke(userId,id,currentTokenHash){
    const row=q.sessions.all(userId).find(item=>sessionId(item.tokenHash)===id);
    if(!row)return false;
    if(row.tokenHash===currentTokenHash)throw Object.assign(new Error('Use Sign out to end the current session.'),{status:400});
    return Number(q.revokeSession.run(userId,row.tokenHash).changes||0)>0;
  }

  cleanup();
  return {event,listEvents,touch,listSessions,revoke,cleanup,hash};
}
