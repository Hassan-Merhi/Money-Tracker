export const OFFLINE_RECOVERY_VERSION=2;
export const OFFLINE_RECOVERY_KIND='offline-working-set';
export const OFFLINE_RECOVERY_MAX_ATTACHMENT_BYTES=100*1024*1024;
export const OFFLINE_RECOVERY_MAX_SINGLE_ATTACHMENT_BYTES=8*1024*1024;

function jsonSafe(value){
  if(value===undefined)return null;
  if(value===null||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(jsonSafe);
  const out={};
  for(const key of Object.keys(value).sort()){
    const child=value[key];
    if(child!==undefined)out[key]=jsonSafe(child);
  }
  return out;
}

export function canonicalRecoveryJson(value){
  return JSON.stringify(jsonSafe(value));
}

export async function recoverySha256(value){
  if(!globalThis.crypto?.subtle)throw new Error('Secure checksum support is unavailable in this browser.');
  const bytes=new TextEncoder().encode(typeof value==='string'?value:canonicalRecoveryJson(value));
  const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

export function recoveryCore(archive){
  return {
    app:archive?.app,
    recoveryVersion:Number(archive?.recoveryVersion||0),
    recoveryKind:archive?.recoveryKind,
    generatedAt:archive?.generatedAt,
    schemaVersion:Number(archive?.schemaVersion||0),
    identity:archive?.identity,
    payload:archive?.payload
  };
}

export async function sealOfflineRecoveryArchive(core){
  const normalized=recoveryCore(core);
  return {...normalized,sha256:await recoverySha256(normalized)};
}

function array(value,label){
  if(!Array.isArray(value))throw new Error(`Recovery file is missing ${label}.`);
  return value;
}

function idSet(rows=[]){
  return new Set(rows.map(row=>String(row?.id||'')).filter(Boolean));
}

function queueIdentities(rows,label,identity){
  const seen=new Set();
  for(const row of rows){
    if(!row||typeof row!=='object')throw new Error(`Recovery ${label} contains an invalid row.`);
    if(String(row.identity||'')!==identity)throw new Error(`Recovery ${label} belongs to a different offline account.`);
    const operationId=String(row.operationId||'');
    if(!operationId)throw new Error(`Recovery ${label} contains an operation without an ID.`);
    if(seen.has(operationId))throw new Error(`Recovery ${label} contains a duplicate operation ID.`);
    seen.add(operationId);
  }
}

function approximateBase64Bytes(value=''){
  const text=String(value||'');
  if(!text)return 0;
  const padding=text.endsWith('==')?2:text.endsWith('=')?1:0;
  return Math.max(0,Math.floor(text.length*3/4)-padding);
}

export function validateOfflineRecoveryPayload(payload,identity){
  if(!payload||typeof payload!=='object')throw new Error('Recovery file payload is missing.');
  const snapshot=payload.snapshot;
  if(!snapshot||typeof snapshot!=='object'||!Number.isFinite(Number(snapshot.version))||!snapshot.settings||!Array.isArray(snapshot.people)||!Array.isArray(snapshot.accounts)||!Array.isArray(snapshot.entries)){
    throw new Error('Recovery file does not contain a valid offline ledger snapshot.');
  }
  const people=array(snapshot.people,'people'),accounts=array(snapshot.accounts,'accounts'),entries=array(snapshot.entries,'entries');
  array(snapshot.categories||[],'categories');array(snapshot.budgets||[],'budgets');
  const personIds=idSet(people),accountIds=idSet(accounts),entryIds=idSet(entries);
  if(personIds.size!==people.length||accountIds.size!==accounts.length||entryIds.size!==entries.length)throw new Error('Recovery ledger contains duplicate record IDs.');

  const queue=array(payload.queue,'ledger queue'),attachmentQueue=array(payload.attachmentQueue,'attachment queue'),bankFeedQueue=array(payload.bankFeedQueue,'Bank Feed queue'),recurringQueue=array(payload.recurringQueue,'recurring queue');
  queueIdentities(queue,'ledger queue',identity);queueIdentities(attachmentQueue,'attachment queue',identity);queueIdentities(bankFeedQueue,'Bank Feed queue',identity);queueIdentities(recurringQueue,'recurring queue',identity);

  const attachments=array(payload.attachments,'attachments'),tombstones=array(payload.tombstones,'tombstones'),syncState=array(payload.syncState,'sync metadata'),fxRates=array(payload.fxRates,'FX cache');
  let attachmentBytes=0;
  for(const row of attachments){
    if(String(row?.identity||'')!==identity)throw new Error('Recovery attachment belongs to a different offline account.');
    if(!row.id||!row.entryId)throw new Error('Recovery attachment metadata is incomplete.');
    if(row.data){
      const bytes=Number(row.sizeBytes)||approximateBase64Bytes(row.data);
      if(bytes>OFFLINE_RECOVERY_MAX_SINGLE_ATTACHMENT_BYTES)throw new Error('Recovery file contains an attachment larger than 8 MB.');
      attachmentBytes+=bytes;
    }
  }
  if(attachmentBytes>OFFLINE_RECOVERY_MAX_ATTACHMENT_BYTES)throw new Error('Recovery file contains more than 100 MB of attachment data.');
  for(const row of tombstones)if(String(row?.identity||'')!==identity)throw new Error('Recovery tombstone belongs to a different offline account.');
  for(const row of syncState)if(String(row?.identity||'')!==identity)throw new Error('Recovery sync metadata belongs to a different offline account.');
  for(const row of fxRates)if(String(row?.identity||'')!==identity)throw new Error('Recovery FX data belongs to a different offline account.');

  if(payload.bankFeedSnapshot!=null&&typeof payload.bankFeedSnapshot!=='object')throw new Error('Recovery Bank Feed cache is invalid.');
  if(payload.recurringSnapshot!=null&&typeof payload.recurringSnapshot!=='object')throw new Error('Recovery recurring cache is invalid.');

  return {
    ledger:{people:people.length,accounts:accounts.length,entries:entries.length,categories:(snapshot.categories||[]).length,budgets:(snapshot.budgets||[]).length,version:Number(snapshot.version)},
    pending:queue.length+attachmentQueue.length+bankFeedQueue.length+recurringQueue.length,
    queues:{ledger:queue.length,attachments:attachmentQueue.length,bankFeed:bankFeedQueue.length,recurring:recurringQueue.length},
    attachments:{count:attachments.length,bytes:attachmentBytes,pinned:attachments.filter(row=>row.offlinePinned||row.offlinePolicy==='local').length},
    tombstones:tombstones.length,
    cachedBankFeed:Array.isArray(payload.bankFeedSnapshot?.items)?payload.bankFeedSnapshot.items.length:0,
    cachedRecurring:Array.isArray(payload.recurringSnapshot?.rules)?payload.recurringSnapshot.rules.length:0,
    syncState:syncState.length,
    fxRates:fxRates.length
  };
}

export async function verifyOfflineRecoveryArchive(archive,{expectedIdentity='',maxSchemaVersion=Infinity}={}){
  if(!archive||typeof archive!=='object')throw new Error('That file is not a Money Tracker offline recovery archive.');
  if(archive.app!=='money-owed-tracker'||Number(archive.recoveryVersion)!==OFFLINE_RECOVERY_VERSION||archive.recoveryKind!==OFFLINE_RECOVERY_KIND){
    throw new Error('That file is not a supported Money Tracker offline recovery archive.');
  }
  const identity=String(archive.identity||'').trim();
  if(!identity)throw new Error('Recovery file has no offline account identity.');
  if(expectedIdentity&&identity!==String(expectedIdentity))throw new Error('This recovery file belongs to a different Money Tracker account.');
  const schemaVersion=Number(archive.schemaVersion||0);
  if(!Number.isInteger(schemaVersion)||schemaVersion<1)throw new Error('Recovery file has an invalid offline schema version.');
  if(schemaVersion>Number(maxSchemaVersion))throw new Error('This recovery file was created by a newer Money Tracker offline schema. Update the app before restoring it.');
  if(!/^[a-f0-9]{64}$/i.test(String(archive.sha256||'')))throw new Error('Recovery file checksum is missing or invalid.');
  const expected=await recoverySha256(recoveryCore(archive));
  if(expected!==String(archive.sha256).toLowerCase())throw new Error('Recovery file checksum does not match. The file may be damaged or modified.');
  const preview=validateOfflineRecoveryPayload(archive.payload,identity);
  return {ok:true,identity,schemaVersion,generatedAt:archive.generatedAt||null,preview,sha256:expected};
}
