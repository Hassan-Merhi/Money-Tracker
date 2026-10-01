import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  OFFLINE_RECOVERY_KIND, OFFLINE_RECOVERY_VERSION,
  sealOfflineRecoveryArchive, verifyOfflineRecoveryArchive
} from '../lib/offline-recovery.js';

const ROOT=dirname(fileURLToPath(new URL('../package.json',import.meta.url)));
const read=path=>readFileSync(join(ROOT,path),'utf8');

function payload(identity='user_wave100e'){
  return {
    identity,
    snapshot:{
      version:7,
      settings:{defaultCurrency:'USD',displayName:'Recovery test'},
      people:[{id:'person_1',name:'Recovery Person'}],
      accounts:[{id:'account_1',name:'Cash',currency:'USD'}],
      entries:[{id:'entry_1',type:'paid_for_person',personId:'person_1',amount:5,currency:'USD',date:'2026-10-01'}],
      categories:[],budgets:[]
    },
    queue:[{operationId:'op_ledger_1',identity,entity:'entry',entityId:'entry_1',operation:'create',status:'pending'}],
    syncState:[{key:'sync-base',identity,serverRevision:6}],
    tombstones:[{key:'person:old',identity,entity:'person',entityId:'old',synced:false}],
    attachments:[{id:'att_1',entryId:'entry_1',identity,name:'receipt.txt',mimeType:'text/plain',sizeBytes:7,data:btoa('receipt'),synced:false,status:'pending',offlinePinned:true,offlinePolicy:'local'}],
    attachmentQueue:[{operationId:'op_attachment_1',identity,attachmentId:'att_1',entryId:'entry_1',operation:'create',status:'pending'}],
    fxRates:[{entryId:'entry_1',identity,date:'2026-10-01',rate:1}],
    bankFeedSnapshot:{items:[{id:'bank_1',status:'pending'}],cachedAt:'2026-10-01T00:00:00.000Z'},
    bankFeedQueue:[{operationId:'op_bank_1',identity,action:'ignore',itemId:'bank_1',status:'pending'}],
    recurringSnapshot:{rules:[{id:'rule_1',title:'Rent',isActive:true}],reminders:[],worker:{}},
    recurringQueue:[{operationId:'op_recurring_1',identity,ruleId:'rule_1',action:'update',status:'pending'}]
  };
}

test('Wave 100E seals and verifies a same-account offline working-set archive',async()=>{
  const core={
    app:'money-owed-tracker',
    recoveryVersion:OFFLINE_RECOVERY_VERSION,
    recoveryKind:OFFLINE_RECOVERY_KIND,
    generatedAt:'2026-10-01T10:30:00.000Z',
    schemaVersion:7,
    identity:'user_wave100e',
    payload:payload()
  };
  const archive=await sealOfflineRecoveryArchive(core);
  assert.match(archive.sha256,/^[a-f0-9]{64}$/);
  const verified=await verifyOfflineRecoveryArchive(archive,{expectedIdentity:'user_wave100e',maxSchemaVersion:7});
  assert.equal(verified.ok,true);
  assert.equal(verified.preview.pending,4);
  assert.equal(verified.preview.ledger.entries,1);
  assert.equal(verified.preview.attachments.count,1);
  assert.equal(verified.preview.cachedBankFeed,1);
  assert.equal(verified.preview.cachedRecurring,1);
});

test('Wave 100E rejects tampering, wrong identity and newer schema before restore',async()=>{
  const archive=await sealOfflineRecoveryArchive({
    app:'money-owed-tracker',recoveryVersion:2,recoveryKind:'offline-working-set',
    generatedAt:'2026-10-01T10:30:00.000Z',schemaVersion:7,identity:'user_wave100e',payload:payload()
  });
  const tampered=structuredClone(archive);
  tampered.payload.snapshot.people[0].name='Tampered';
  await assert.rejects(verifyOfflineRecoveryArchive(tampered,{expectedIdentity:'user_wave100e',maxSchemaVersion:7}),/checksum does not match/i);
  await assert.rejects(verifyOfflineRecoveryArchive(archive,{expectedIdentity:'other_user',maxSchemaVersion:7}),/different Money Tracker account/i);
  const newer=await sealOfflineRecoveryArchive({...archive,schemaVersion:99});
  await assert.rejects(verifyOfflineRecoveryArchive(newer,{expectedIdentity:'user_wave100e',maxSchemaVersion:7}),/newer Money Tracker offline schema/i);
});

test('Wave 100E validates attachment safety limits and queue identity',async()=>{
  const bad=payload();
  bad.attachmentQueue[0].identity='other_user';
  const archive=await sealOfflineRecoveryArchive({
    app:'money-owed-tracker',recoveryVersion:2,recoveryKind:'offline-working-set',
    generatedAt:'2026-10-01T10:30:00.000Z',schemaVersion:7,identity:'user_wave100e',payload:bad
  });
  await assert.rejects(verifyOfflineRecoveryArchive(archive,{expectedIdentity:'user_wave100e',maxSchemaVersion:7}),/different offline account/i);
});

test('Wave 100E wires transactional local restore, UI, PWA and production contracts',()=>{
  const offline=read('lib/offline-db.js'),store=read('lib/store.js'),app=read('app.js'),sw=read('service-worker.js'),version=read('pwa-version.js'),server=read('server.mjs'),smoke=read('lib/production-smoke.js'),pkg=JSON.parse(read('package.json')),ci=read('.github/workflows/ci.yml'),doc=read('docs/WAVE_100E_OFFLINE_RECOVERY_RESTORE.md');
  assert.match(offline,/export async function offlineWorkingSetBundle/);
  assert.match(offline,/export async function restoreOfflineWorkingSet/);
  assert.match(offline,/db\.transaction\(stores,'readwrite'\)/);
  assert.match(store,/export async function exportOfflineRecoveryArchive/);
  assert.match(store,/export async function inspectOfflineRecoveryArchive/);
  assert.match(store,/export async function restoreOfflineRecoveryArchive/);
  assert.match(store,/RESTORE OFFLINE/);
  assert.match(app,/id="exportOfflineArchive"/);
  assert.match(app,/id="importOfflineArchive"/);
  assert.match(app,/id="offlineRecoveryFile"/);
  assert.match(app,/Local-device recovery only/);
  assert.match(sw,/\/lib\/offline-recovery\.js/);
  const pwaVersion=Number(/version:(\d+)/.exec(version)?.[1]||0);
  assert.ok(pwaVersion>=35,`Wave 100E requires PWA v35 or newer; found v${pwaVersion}.`);
  assert.match(version,new RegExp(`cacheName:'money-tracker-debt-v${pwaVersion}'`));
  const offlineDbVersion=Number(/offlineDbVersion:(\d+)/.exec(version)?.[1]||0);
  assert.ok(offlineDbVersion>=7);
  assert.match(server,/offlineWave100EVersion:1/);
  assert.match(smoke,/offlineWave100EVersion/);
  assert.match(doc,/server remains authoritative/i);
  assert.match(doc,/does \*\*not\*\* contain passwords, CSRF tokens, session cookies/i);
  assert.equal(pkg.scripts['test:wave100e'],'node --test tests/wave100e-offline-recovery-restore.test.js');
  assert.equal(pkg.scripts['test:wave100e-e2e'],'playwright test e2e/wave100e-offline-recovery-restore.spec.mjs --workers=1');
  assert.match(ci,/Run Wave 100E Offline Recovery Restore gate/);
  assert.match(ci,/Run Wave 100E Offline Recovery Restore browser gate/);
});
