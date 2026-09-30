import { runProductionSmoke } from '../lib/production-smoke.js';

const baseUrl=process.env.PRODUCTION_URL||process.env.RENDER_EXTERNAL_URL||'https://money-owed-tracker.onrender.com';
const expectedCommit=process.env.EXPECTED_COMMIT_SHA||process.env.RENDER_GIT_COMMIT||'';
const email=process.env.PRODUCTION_SMOKE_EMAIL||process.env.SMOKE_EMAIL||'';
const password=process.env.PRODUCTION_SMOKE_PASSWORD||process.env.SMOKE_PASSWORD||'';
const waitMs=Number(process.env.PRODUCTION_SMOKE_WAIT_MS||12*60_000);
const intervalMs=Number(process.env.PRODUCTION_SMOKE_INTERVAL_MS||10_000);

try{
  const report=await runProductionSmoke({
    baseUrl,
    expectedCommit,
    waitMs,
    intervalMs,
    credentials:email&&password?{email,password}:null
  });
  console.log('WAVE13_PRODUCTION_SMOKE_OK '+JSON.stringify(report));
}catch(error){
  console.error('WAVE13_PRODUCTION_SMOKE_FAILED '+JSON.stringify({
    baseUrl,
    expectedCommit:expectedCommit||null,
    message:String(error?.message||error)
  }));
  process.exitCode=1;
}
