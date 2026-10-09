// One-time, stopped-host upgrade. Preserve originals before uninstall/reinstall.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {acquireWriterGuard} from '../src/writer-guard.mjs';
import {installLocal,rollbackLocal} from './install-local.mjs';
const home='C:/example/dsh/home',storage=path.resolve(home,'storages/foreman-next');
const oldReceipt='artifacts/install-receipt-20260915-r2.json';
const receipt='artifacts/install-receipt-20260920.json';
try{await fs.stat(receipt);throw Error('Upgrade receipt already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
const guard=await acquireWriterGuard(path.join(storage,'writer.guard'));
if(!guard)throw Error('Windows exclusive writer guard required');
try {
  const old=JSON.parse(await fs.readFile(oldReceipt,'utf8'));
  const hash=b=>createHash('sha256').update(b).digest('hex');
  for(const file of old.files)if(hash(await fs.readFile(file.path))!==file.sha256)throw Error('Installed file changed');
  if(hash(await fs.readFile(old.patch))!==old.afterHash)throw Error('Profile changed');
  const backup=await fs.mkdtemp(path.resolve('artifacts/upgrade-backup-20260920-'));
  for(const [source,name] of [[path.join(home,'profiles/node_modules/dsh-foreman-next'),'plugin'],
    [path.join(home,'.agent-presets/foreman-next'),'preset'],[storage,'storage']]) {
    if(await fs.realpath(source)!==path.resolve(source))throw Error('Linked upgrade source');
    await fs.cp(source,path.join(backup,name),{recursive:true,errorOnExist:true,force:false});
  }
  await fs.copyFile(old.patch,path.join(backup,'cordis.patch.yml'));
  await fs.copyFile(oldReceipt,path.join(backup,'old-receipt.json'));
  for(const file of old.files) {
    const module=path.resolve(home,'profiles/node_modules/dsh-foreman-next');
    const preset=path.resolve(home,'.agent-presets/foreman-next');
    const root=file.path.startsWith(module+path.sep)?module:preset;
    const saved=path.join(backup,root===module?'plugin':'preset',path.relative(root,file.path));
    if(hash(await fs.readFile(saved))!==file.sha256)throw Error('Backup hash mismatch');
  }
  if(hash(await fs.readFile(path.join(backup,'storage/state.jsonl')))!==hash(await fs.readFile(path.join(storage,'state.jsonl'))))throw Error('Journal backup mismatch');
  await fs.writeFile(path.join(backup,'upgrade.json'),JSON.stringify({backup,oldReceipt,receipt,journalBytes:(await fs.stat(path.join(storage,'state.jsonl'))).size,completed:false},null,2));
  const config=JSON.parse(await fs.readFile('artifacts/host-config-candidate-20260920.json','utf8'));
  await fs.mkdir(config.verification.dependencyBuildRoot,{recursive:true});
  await rollbackLocal(oldReceipt);
  const result=await installLocal({home,release:'artifacts/releases/candidate-EGwQlO',receipt,
    hostOptions:{verification:config.verification,scheduler:config.scheduler}});
  await fs.writeFile(path.join(backup,'upgrade.json'),JSON.stringify({backup,oldReceipt,receipt,completed:true,readyForProjects:false},null,2));
  console.log(JSON.stringify({...result,backup},null,2));
}finally{guard.close();}
