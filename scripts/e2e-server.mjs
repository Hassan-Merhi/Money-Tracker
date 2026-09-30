import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'money-tracker-e2e-'));
process.env.DB_PATH=join(dir,'ledger.sqlite');
process.env.DATA_DIR=dir;
process.env.NODE_ENV='test';
const port=Number(process.env.PORT||4173);

const {server,db}=await import(`../server.mjs?e2e=${Date.now()}`);

await new Promise((resolve,reject)=>{
  server.once('error',reject);
  server.listen(port,'127.0.0.1',resolve);
});
console.log(`E2E_READY http://127.0.0.1:${port}`);

let closing=false;
async function close(code=0){
  if(closing)return;
  closing=true;
  await new Promise(resolve=>server.close(resolve));
  try{db.close();}catch{}
  rmSync(dir,{recursive:true,force:true});
  process.exit(code);
}
process.on('SIGTERM',()=>void close(0));
process.on('SIGINT',()=>void close(0));
