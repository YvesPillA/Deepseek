// Read-only preflight before the launcher reads the approved credential source.
import fs from 'node:fs/promises';
import path from 'node:path';
import {validateNativeModelAuthorization,validateNativeModelResume} from './model-smoke-support.mjs';
import {validateNativeModelEntry} from './native-model-entry.mjs';

const [rootArg,batch,mode]=process.argv.slice(2);
if(mode!==undefined&&!['--fresh','--resume'].includes(mode))throw Error('Explicit fresh or resume entry required');
if(!rootArg || !/^[a-zA-Z0-9_-]{1,60}$/.test(batch??''))throw Error('Root and batch required');
const root=await fs.realpath(rootArg);
if(path.dirname(root)!==path.resolve('C:/example/foreman-tests') || !/^native-model-ui-[a-zA-Z0-9_-]+$/.test(path.basename(root)))throw Error('Invalid native-model-ui root');
const auth=JSON.parse(await fs.readFile(path.join(root,'run-authorization-'+batch+'.json'),'utf8'));
validateNativeModelAuthorization(auth,{root,batch});
await validateNativeModelEntry(root,{entry:mode==='--fresh'?'fresh':'resume',batch,auth});
const ledgerPath=path.join(root,'requests-'+batch+'.json');
try {
  const ledger=JSON.parse(await fs.readFile(ledgerPath,'utf8'));
  if(ledger.batch!==batch || !Number.isSafeInteger(ledger.calls) || ledger.calls<0 || ledger.calls>=40 || ledger.deadline!==auth.expiresAt)throw Error('Authorized batch exhausted');
}catch(error){if(error.code!=='ENOENT')throw error;}
