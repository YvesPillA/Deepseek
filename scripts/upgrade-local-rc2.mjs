// Stopped-host, offline rc.2 upgrade. Only the foreman package and Web user patch change.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {acquireWriterGuard} from '../src/writer-guard.mjs';

const runtimeRequire=createRequire(path.join(process.env.DSH_RUNTIME_ROOT??'C:/example/dsh/node/node_modules/@deepseek-ai/dsh','package.json'));
const yaml=runtimeRequire('yaml');
const execFileAsync=promisify(execFile);
const sha256=b=>createHash('sha256').update(b).digest('hex');
const ensure=(ok,message)=>{if(!ok)throw Error(message);};
const moduleName='dsh-foreman-next';
const ownIds=new Set(['foreman-next-host','preset-foreman-next']);
const safeRelative=p=>typeof p==='string'&&!p.includes('\\')&&!p.includes(':')&&p.split('/').every(s=>s&&s!=='.'&&s!=='..');
const safeFile=p=>safeRelative(p)&&(['package.json','README.md'].includes(p)||/^(src|client|presets)\//.test(p));

async function ordinaryFile(file) {
  const stat=await fs.lstat(file);
  ensure(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,`Expected ordinary file: ${file}`);
  return fs.readFile(file);
}
async function ordinaryDirectory(dir) {
  const stat=await fs.lstat(dir);
  ensure(stat.isDirectory()&&!stat.isSymbolicLink()&&await fs.realpath(dir)===path.resolve(dir),`Expected ordinary directory: ${dir}`);
}
async function absent(file) {try{await fs.lstat(file);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}}
async function inventory(root) {
  await ordinaryDirectory(root);
  const files=[];
  async function scan(dir,relative='') {
    for(const item of await fs.readdir(dir,{withFileTypes:true})) {
      const file=path.join(dir,item.name),name=relative?relative+'/'+item.name:item.name;
      if(item.isDirectory()) {await ordinaryDirectory(file);await scan(file,name);}
      else {
        ensure(item.isFile()&&!item.isSymbolicLink()&&safeRelative(name),'Linked or special package entry');
        files.push({path:name,sha256:sha256(await ordinaryFile(file))});
      }
    }
  }
  await scan(root);
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}
function rowsIn(patches) {
  const found=[];
  const walk=items=>{for(const row of items){if(row&&typeof row==='object'){if(typeof row.id==='string')found.push(row);if(Array.isArray(row.insert))walk(row.insert);
    if(Array.isArray(row.config)&&(row.group===true||['cordis:group','@deepseek-ai/cordis-plugin-group'].includes(row.name)))walk(row.config);}}};
  walk(patches);return found;
}
async function releaseFiles(release) {
  await ordinaryDirectory(release);
  const manifest=JSON.parse(await ordinaryFile(path.join(release,'release-manifest.json')));
  ensure(manifest.name===moduleName&&manifest.installed===false&&manifest.readyForProjects===false,'Release manifest is not gated foreman code');
  ensure(Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=256,'Invalid release file count');
  const seen=new Set(),files=[];
  for(const entry of manifest.files){
    ensure(safeFile(entry.path)&&!seen.has(entry.path)&&/^[a-f0-9]{64}$/.test(entry.sha256),'Unsafe release entry');
    seen.add(entry.path);
    const file=path.join(release,entry.path);
    ensure(await fs.realpath(file)===path.resolve(file),'Linked release source');
    const bytes=await ordinaryFile(file);
    ensure(bytes.length<=4*1024*1024&&sha256(bytes)===entry.sha256,'Release file hash mismatch');
    files.push({path:entry.path,bytes,sha256:entry.sha256});
  }
  ensure(seen.has('package.json')&&seen.has('src/readiness.mjs')&&seen.has('presets/foreman-next/preset.yml')&&seen.has('presets/foreman-next/agent.cordis.yml'),'Incomplete rc.2 release');
  const readiness=files.find(f=>f.path==='src/readiness.mjs').bytes.toString();
  ensure(/readyForProjects:\s*false\b/.test(readiness)||
    (seen.has('src/release-approval.mjs')&&readiness.includes("import {isReleaseApprovalValid} from './release-approval.mjs'")&&
      /const releaseValid=isReleaseApprovalValid\(releaseApproval\)/.test(readiness)&&/readyForProjects:\s*releaseValid\s*&&\s*blockers\.length===0/.test(readiness)),
    'Release project gate must default closed or require branded host approval');
  const pkg=JSON.parse(files.find(f=>f.path==='package.json').bytes);
  ensure(pkg.name===moduleName&&pkg.peerDependencies?.['@deepseek-ai/dsh-scope']?.includes('0.1.7-rc.2'),'Release is not rc.2 compatible');
  return {manifest,files};
}
function profileAfter(before,files,home) {
  const patch=yaml.parse(before.toString());
  ensure(Array.isArray(patch),'Web profile patch must be an array');
  const own=rowsIn(patch).filter(r=>ownIds.has(r.id));
  const host=own.filter(r=>r.id==='foreman-next-host');
  ensure(host.length===1&&host[0].name===moduleName&&host[0].config&&typeof host[0].config==='object','Expected exactly one existing foreman host');
  ensure(own.every(r=>r.id==='foreman-next-host'),'Existing foreman preset needs manual review');
  ensure(typeof host[0].config.dshHome==='string'&&typeof host[0].config.storageRoot==='string'&&
    path.resolve(host[0].config.dshHome)===home&&
    path.resolve(host[0].config.storageRoot)===path.join(home,'storages','foreman-next'),'Unexpected foreman storage/home');
  ensure(host[0].config.readyForProjects!==true,'Project gate must remain closed');
  const preset=yaml.parse(files.find(f=>f.path==='presets/foreman-next/preset.yml').bytes.toString());
  const plugins=yaml.parse(files.find(f=>f.path==='presets/foreman-next/agent.cordis.yml').bytes.toString());
  ensure(preset?.name==='新工头模式'&&typeof preset.description==='string'&&Array.isArray(plugins)&&plugins.length===1&&plugins[0]?.name==='dsh-foreman-next/outer','Unexpected preset contents');
  // The existing host row already names this package; keep its settings byte-for-byte.
  const addition=[{insert:[{id:'preset-foreman-next',name:'@deepseek-ai/dsh-agent-preset',config:{id:'foreman-next',name:preset.name,description:preset.description,plugins}}]}];
  const suffix=(before.length&&before.at(-1)===10?'':'\n')+'# New foreman rc.2: explicit preset; project gate stays closed.\n'+yaml.stringify(addition);
  const after=Buffer.concat([before,Buffer.from(suffix)]);
  const parsed=yaml.parse(after.toString());
  ensure(Array.isArray(parsed)&&rowsIn(parsed).filter(r=>r.id==='preset-foreman-next').length===1,'Invalid composed profile');
  return {after,hostConfigKeys:Object.keys(host[0].config).sort()};
}
export async function planRc2({home,release}) {
  await ordinaryDirectory(path.resolve(home));
  await ordinaryDirectory(path.resolve(release));
  home=await fs.realpath(home);release=await fs.realpath(release);
  await ordinaryDirectory(home);
  ensure(release!==home&&!release.startsWith(home+path.sep),'Release must live outside the installation home');
  const moduleRoot=path.join(home,'profiles','node_modules',moduleName);
  const patch=path.join(home,'profiles','web','cordis.patch.yml');
  for(const dir of [path.join(home,'profiles'),path.dirname(moduleRoot),path.dirname(patch)])await ordinaryDirectory(dir);
  await ordinaryDirectory(moduleRoot);
  const before=await ordinaryFile(patch),{files,manifest}=await releaseFiles(release);
  const {after,hostConfigKeys}=profileAfter(before,files,home);
  const existing=await inventory(moduleRoot);
  return {home,release,moduleRoot,patch,beforeHash:sha256(before),afterHash:sha256(after),before,after,
    files,existing,hostConfigKeys,version:manifest.version,
    change:{replacePackageFiles:files.map(f=>f.path),removeOldPackageFiles:existing.map(x=>x.path).filter(f=>!files.some(x=>x.path===f)),appendProfileRows:['preset-foreman-next'],preserve:['sessions','storages','keys','host config','other profile entries','.agent-presets']}};
}

export async function assertNoDshNode(home,{run=execFileAsync}={}) {
  ensure(process.platform==='win32','Stopped-host check requires Windows');
  const executable=path.resolve('C:/example/dsh/node/node.exe').toLowerCase();
  const script='$ErrorActionPreference = "Stop"; try { $p=Get-CimInstance Win32_Process -Filter "name = \'node.exe\'"; $p | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq $env:FOREMAN_NODE_EXE -and $_.ProcessId -ne [int]$env:FOREMAN_SELF_PID } | Select-Object -ExpandProperty ProcessId } catch { exit 1 }';
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
    {env:{...process.env,FOREMAN_NODE_EXE:executable,FOREMAN_SELF_PID:String(process.pid)},timeout:15000});
  ensure(!stdout.trim(),`DSH Node process is still running; stop it before upgrade`);
  // The path is checked in profileAfter; keeping this argument documents which home is being changed.
  ensure(home===path.resolve(home),'Invalid home');
}
async function writeTree(root,files){for(const f of files){const dest=path.join(root,f.path);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,f.bytes,{flag:'wx'});ensure(sha256(await ordinaryFile(dest))===f.sha256,'Staged package hash mismatch');}}

export async function upgradeRc2({home,release,assertStopped=assertNoDshNode,acquireGuard=acquireWriterGuard,afterProfileCommit=async()=>{},restoreProfile=async(plan)=>{
  const pending=plan.patch+`.foreman-next-rc2.recover-${randomUUID()}`;
  await fs.writeFile(pending,plan.before,{flag:'wx'});
  await fs.rename(pending,plan.patch);
}}) {
  const plan=await planRc2({home,release});
  await assertStopped(plan.home);
  const guard=await acquireGuard(path.join(plan.home,'storages','foreman-next','writer.guard'));
  ensure(guard?.close,'Writer guard unavailable');
  let backup,staging,packageMoved=false,stageMoved=false,patchMoved=false;
  try {
    await assertStopped(plan.home);
    const locked=await planRc2({home:plan.home,release:plan.release});
    ensure(locked.beforeHash===plan.beforeHash,'Profile changed after planning');
    ensure(JSON.stringify(locked.existing)===JSON.stringify(plan.existing),'Installed package changed after planning');
    ensure(locked.files.every((f,i)=>f.sha256===plan.files[i]?.sha256),'Release changed after planning');
    const upgradesRoot=path.join(plan.home,'.foreman-next-upgrades');
    if(await absent(upgradesRoot))await fs.mkdir(upgradesRoot);
    await ordinaryDirectory(upgradesRoot);
    backup=path.join(upgradesRoot,randomUUID());
    await fs.mkdir(backup);
    staging=path.join(path.dirname(plan.moduleRoot),`.foreman-next-stage-${randomUUID()}`);
    await fs.mkdir(staging);
    await writeTree(staging,plan.files);
    await fs.writeFile(path.join(backup,'cordis.patch.yml'),plan.before,{flag:'wx'});
    ensure(sha256(await ordinaryFile(path.join(backup,'cordis.patch.yml')))===plan.beforeHash,'Profile backup mismatch');
    const pending=plan.patch+'.foreman-next-rc2.pending';
    ensure(await absent(pending),'Pending profile path exists');
    await fs.writeFile(pending,plan.after,{flag:'wx'});
    const receipt={format:'foreman-rc2-v1',home:plan.home,moduleRoot:plan.moduleRoot,patch:plan.patch,
      beforeHash:plan.beforeHash,afterHash:plan.afterHash,release:plan.release,files:plan.files.map(({path,sha256})=>({path,sha256})),
      oldFiles:plan.existing,completed:false};
    await fs.writeFile(path.join(backup,'receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx'});
    ensure(sha256(await ordinaryFile(plan.patch))===plan.beforeHash,'Profile changed during upgrade');
    ensure(JSON.stringify(await inventory(plan.moduleRoot))===JSON.stringify(plan.existing),'Installed package changed during upgrade');
    await fs.rename(plan.moduleRoot,path.join(backup,'old-plugin'));packageMoved=true;
    await fs.rename(staging,plan.moduleRoot);stageMoved=true;
    ensure(sha256(await ordinaryFile(plan.patch))===plan.beforeHash,'Profile changed during upgrade');
    await fs.rename(pending,plan.patch);patchMoved=true;
    await afterProfileCommit();
    receipt.completed=true;
    await fs.writeFile(path.join(backup,'receipt.json'),JSON.stringify(receipt,null,2));
    return {receipt:path.join(backup,'receipt.json'),backup,packageFiles:plan.files.length,
      profileRowsAdded:['preset-foreman-next'],readyForProjects:false};
  }catch(error){
    const recoveryErrors=[];
    let profileRestored=!patchMoved;
    if(patchMoved) {
      try {
        ensure(sha256(await ordinaryFile(plan.patch))===plan.afterHash,'Profile changed after upgrade; preserve new package');
        await restoreProfile(plan);
        profileRestored=true;
      }catch(recoveryError){recoveryErrors.push(recoveryError);}
    }
    // Keep the new package if the upgraded profile cannot safely be restored.
    if(profileRestored) {
      try {
        if(stageMoved){await fs.rename(plan.moduleRoot,staging);stageMoved=false;}
        if(packageMoved)await fs.rename(path.join(backup,'old-plugin'),plan.moduleRoot);
      }catch(recoveryError){recoveryErrors.push(recoveryError);}
    }
    if(recoveryErrors.length)throw new AggregateError([error,...recoveryErrors],
      'Upgrade interrupted; inspect package, profile and backup before retrying');
    throw error;
  }finally{guard.close();}
}

export async function rollbackRc2(receiptPath,{assertStopped=assertNoDshNode,acquireGuard=acquireWriterGuard,beforeProfileCommit=async()=>{}}={}) {
  ensure(path.resolve(receiptPath)===await fs.realpath(receiptPath),'Linked receipt path');
  const receipt=JSON.parse(await ordinaryFile(receiptPath));
  ensure(receipt.format==='foreman-rc2-v1'&&receipt.completed===true,'Incomplete or foreign receipt');
  const home=await fs.realpath(receipt.home),backup=path.dirname(await fs.realpath(receiptPath));
  ensure(receipt.moduleRoot===path.join(home,'profiles','node_modules',moduleName)&&
    receipt.patch===path.join(home,'profiles','web','cordis.patch.yml')&&
    path.dirname(backup)===path.join(home,'.foreman-next-upgrades')&&
    path.basename(await fs.realpath(receiptPath))==='receipt.json','Receipt paths are outside the upgrade scope');
  await ordinaryDirectory(backup);
  await ordinaryDirectory(path.join(backup,'old-plugin'));
  await ordinaryDirectory(path.dirname(receipt.moduleRoot));
  await ordinaryDirectory(path.dirname(receipt.patch));
  await assertStopped(home);
  const guard=await acquireGuard(path.join(home,'storages','foreman-next','writer.guard'));
  ensure(guard?.close,'Writer guard unavailable');
  try {
    await assertStopped(home);
    ensure(sha256(await ordinaryFile(receipt.patch))===receipt.afterHash,'Profile changed since upgrade; manual merge required');
    const original=await ordinaryFile(path.join(backup,'cordis.patch.yml'));
    ensure(sha256(original)===receipt.beforeHash,'Profile backup mismatch');
    ensure(Array.isArray(receipt.files)&&receipt.files.length>0&&receipt.files.every(f=>safeFile(f.path)&&/^[a-f0-9]{64}$/.test(f.sha256)),'Unsafe new package record');
    const expectedNew=[...receipt.files].sort((a,b)=>a.path.localeCompare(b.path));
    ensure(JSON.stringify(await inventory(receipt.moduleRoot))===JSON.stringify(expectedNew),'Installed package changed');
    ensure(Array.isArray(receipt.oldFiles)&&receipt.oldFiles.length>0,'Old package inventory missing');
    for(const file of receipt.oldFiles){ensure(safeRelative(file.path)&&/^[a-f0-9]{64}$/.test(file.sha256),'Unsafe old package record');
    }
    const expectedOld=[...receipt.oldFiles].sort((a,b)=>a.path.localeCompare(b.path));
    ensure(JSON.stringify(await inventory(path.join(backup,'old-plugin')))===JSON.stringify(expectedOld),'Old package backup changed');
    const parked=path.join(backup,'rc2-plugin-rolled-back');
    ensure(await absent(parked),'Rollback already used');
    const pending=path.join(backup,'cordis.rollback.pending');
    await fs.writeFile(pending,original,{flag:'wx'});
    let newParked=false,oldRestored=false;
    try {
      ensure(sha256(await ordinaryFile(receipt.patch))===receipt.afterHash,'Profile changed during rollback; manual merge required');
      ensure(JSON.stringify(await inventory(receipt.moduleRoot))===JSON.stringify(expectedNew),'Installed package changed during rollback');
      await fs.rename(receipt.moduleRoot,parked);newParked=true;
      await fs.rename(path.join(backup,'old-plugin'),receipt.moduleRoot);oldRestored=true;
      await beforeProfileCommit();
      ensure(sha256(await ordinaryFile(receipt.patch))===receipt.afterHash,'Profile changed during rollback; manual merge required');
      await fs.rename(pending,receipt.patch);
    }catch(error) {
      try {
        if(oldRestored)await fs.rename(receipt.moduleRoot,path.join(backup,'old-plugin'));
        if(newParked)await fs.rename(parked,receipt.moduleRoot);
      }catch(recoveryError){throw new AggregateError([error,recoveryError],'Rollback interrupted; inspect package and profile before retrying');}
      throw error;
    }finally {if(!(await absent(pending)))await fs.unlink(pending);}
    return {rolledBack:true,backup,profileRestored:true,projectDataPreserved:true};
  }finally{guard.close();}
}

// Desktop owns its own package project. These explicit commands never select a
// home from DSH_HOME or fall back to the older Web installation.
export async function assertNoDesktopHost(home,{run=execFileAsync}={}) {
  ensure(process.platform==='win32','Desktop stopped-host check requires Windows');
  const script='$ErrorActionPreference = "Stop"; try { Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne [int]$env:FOREMAN_SELF_PID -and ($_.Name -eq "DeepSeek Harness.exe" -or ($_.Name -eq "node.exe" -and (($_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant() -eq $env:FOREMAN_LEGACY_NODE) -or ($_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($env:FOREMAN_PROFILE))))) } | Select-Object -ExpandProperty ProcessId } catch { exit 1 }';
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,
    FOREMAN_SELF_PID:String(process.pid),FOREMAN_LEGACY_NODE:path.resolve('C:/example/dsh/node/node.exe').toLowerCase(),
    FOREMAN_PROFILE:path.join(home,'profiles','desktop').toLowerCase()},timeout:15000});
  ensure(!stdout.trim(),'Desktop or DSH host is still running; exit it before installation');
}
async function desktopLock(profileDir) {
  const file=path.join(profileDir,'lock'),handle=await fs.open(file,'wx',0o600);
  try {await handle.writeFile(`${process.pid}\n`);await handle.sync();}
  catch(error){await handle.close();await fs.unlink(file);throw error;}
  return {async close(){await handle.close();await fs.unlink(file);}};
}
function presetRow(files) {
  const preset=yaml.parse(files.find(f=>f.path==='presets/foreman-next/preset.yml').bytes.toString());
  const plugins=yaml.parse(files.find(f=>f.path==='presets/foreman-next/agent.cordis.yml').bytes.toString());
  ensure(preset?.name==='新工头模式'&&typeof preset.description==='string'&&Array.isArray(plugins)&&plugins.length===1&&plugins[0]?.name==='dsh-foreman-next/outer','Unexpected preset contents');
  return {id:'preset-foreman-next',name:'@deepseek-ai/dsh-agent-preset',config:{id:'foreman-next',name:preset.name,description:preset.description,plugins}};
}
export async function planDesktopRc2({home,profileDir,release}) {
  ensure(typeof home==='string'&&path.isAbsolute(home)&&typeof profileDir==='string'&&path.isAbsolute(profileDir),'Explicit absolute Desktop home and profileDir required');
  home=path.resolve(home);profileDir=path.resolve(profileDir);release=path.resolve(release);
  ensure(profileDir===path.join(home,'profiles','desktop'),'Desktop profile does not belong to the explicit home');
  for(const dir of [home,path.join(home,'profiles'),profileDir,release])await ordinaryDirectory(dir);
  ensure(release!==home&&!release.startsWith(home+path.sep),'Release must live outside the installation home');
  const {files,manifest}=await releaseFiles(release),pkg=JSON.parse(files.find(f=>f.path==='package.json').bytes);
  ensure(pkg.peerDependencies?.['@deepseek-ai/dsh-scope']==='0.1.7-rc.2 || 0.2.0-rc.2','Desktop release must declare only verified rc.2 runtimes');
  const patch=path.join(profileDir,'cordis.patch.yml'),packageFile=path.join(profileDir,'package.json');
  const beforePackage=await ordinaryFile(packageFile),profilePackage=JSON.parse(beforePackage);
  ensure(Array.isArray(profilePackage.dsh?.profile?.bundles)&&['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'].every(x=>profilePackage.dsh.profile.bundles.includes(x)),'Expected official Desktop base and Web bundles');
  ensure(profilePackage.dependencies===undefined||(profilePackage.dependencies&&typeof profilePackage.dependencies==='object'&&!Array.isArray(profilePackage.dependencies)),'Invalid Desktop dependencies');
  const patchExists=!(await absent(patch)),beforePatch=patchExists?await ordinaryFile(patch):Buffer.from('[]\n');
  const patches=yaml.parse(beforePatch.toString());ensure(Array.isArray(patches),'Desktop patch must be an array');
  const own=rowsIn(patches).filter(r=>ownIds.has(r.id));
  ensure(own.filter(r=>r.id==='foreman-next-host').length<=1&&own.filter(r=>r.id==='preset-foreman-next').length<=1,'Duplicate foreman Desktop rows');
  const host=own.find(r=>r.id==='foreman-next-host'),preset=own.find(r=>r.id==='preset-foreman-next');
  if(host)ensure(host.name===moduleName&&host.config?.readyForProjects!==true&&
    typeof host.config.dshHome==='string'&&path.resolve(host.config.dshHome)===home&&
    typeof host.config.storageRoot==='string'&&path.resolve(host.config.storageRoot)===path.join(home,'storages','foreman-next'),
    'Existing Desktop host paths or gate need manual review');
  const desiredPreset=presetRow(files);
  if(preset)ensure(JSON.stringify(preset)===JSON.stringify(desiredPreset),'Existing Desktop preset needs manual review');
  const additions=[];
  if(!host)additions.push({id:'foreman-next-host',name:moduleName,config:{dshHome:home,storageRoot:path.join(home,'storages','foreman-next'),sessionRoot:path.join(home,'sessions'),readyForProjects:false}});
  if(!preset)additions.push(desiredPreset);
  // Append to nonempty YAML without reserializing user rows or credentials.
  let afterPatch=beforePatch;
  if(additions.length) {
    const text=beforePatch.toString(),document=yaml.parseDocument(text);
    if(document.contents?.flow) {
      const end=document.contents.range[1]-1;ensure(text[end]===']','Unsupported Desktop flow patch');
      afterPatch=Buffer.from(text.slice(0,end)+(patches.length?',':'')+'\n'+JSON.stringify({insert:additions},null,2)+'\n'+text.slice(end));
    }else afterPatch=Buffer.from(text.replace(/\s*$/,'')+'\n# New foreman Desktop: project gate stays closed.\n'+yaml.stringify([{insert:additions}]));
  }
  ensure(Array.isArray(yaml.parse(afterPatch.toString())),'Invalid composed Desktop patch');
  const afterPackage=Buffer.from(JSON.stringify({...profilePackage,dependencies:{...profilePackage.dependencies,[moduleName]:'file:'+release.replaceAll('\\','/')}},null,2)+'\n');
  const moduleRoot=path.join(profileDir,'node_modules',moduleName),moduleExists=!(await absent(moduleRoot));
  if(!(await absent(path.dirname(moduleRoot))))await ordinaryDirectory(path.dirname(moduleRoot));
  const existing=moduleExists?await inventory(moduleRoot):[];
  const edits=[{path:packageFile,backupName:'package.json',existed:true,before:beforePackage,after:afterPackage},
    {path:patch,backupName:'cordis.patch.yml',existed:patchExists,before:beforePatch,after:afterPatch}].map(e=>({...e,beforeHash:sha256(e.before),afterHash:sha256(e.after)}));
  return {home,profileDir,release,moduleRoot,moduleExists,existing,files,edits,version:manifest.version,
    change:{profile:'desktop',replacePackageFiles:files.map(f=>f.path),appendProfileRows:additions.map(r=>r.id),profileDependency:moduleName,
      preserve:['other profile dependencies','bundle order','other patch entries','Web profile','sessions','storages','keys'],readyForProjects:false}};
}
async function assertDesktopUnchanged(plan,after=false) {
  for(const edit of plan.edits)ensure((!after&&!edit.existed)?await absent(edit.path):sha256(await ordinaryFile(edit.path))===(after?edit.afterHash:edit.beforeHash),'Desktop profile changed; manual merge required');
  ensure(plan.moduleExists?JSON.stringify(await inventory(plan.moduleRoot))===JSON.stringify(plan.existing):await absent(plan.moduleRoot),'Desktop package changed');
}
async function commitDesktopFile(edit,bytes) {
  const pending=edit.path+'.foreman-next-'+randomUUID();
  await fs.writeFile(pending,bytes,{flag:'wx'});
  try {await fs.rename(pending,edit.path);}finally {if(!(await absent(pending)))await fs.unlink(pending);}
}
export async function upgradeDesktopRc2({home,profileDir,release,assertStopped=assertNoDesktopHost,acquireGuard=acquireWriterGuard,afterProfileCommit=async()=>{}}) {
  const plan=await planDesktopRc2({home,profileDir,release});await assertStopped(plan.home);
  const profileLock=await desktopLock(plan.profileDir);let guard,backup,staging,movedOld=false,movedNew=false;const committed=[];
  try {
    await assertStopped(plan.home);await assertDesktopUnchanged(plan);
    const fresh=await planDesktopRc2({home:plan.home,profileDir:plan.profileDir,release:plan.release});
    ensure(JSON.stringify(fresh.files.map(f=>[f.path,f.sha256]))===JSON.stringify(plan.files.map(f=>[f.path,f.sha256])),'Release changed after planning');
    // Validate each ancestor before creating any installation or journal path.
    for(const dir of [path.join(plan.home,'storages'),path.join(plan.home,'storages','foreman-next'),path.dirname(plan.moduleRoot),path.join(plan.home,'.foreman-next-upgrades')]) {
      if(await absent(dir))await fs.mkdir(dir);await ordinaryDirectory(dir);
    }
    guard=await acquireGuard(path.join(plan.home,'storages','foreman-next','writer.guard'));ensure(guard?.close,'Writer guard unavailable');
    backup=path.join(plan.home,'.foreman-next-upgrades',randomUUID());await fs.mkdir(backup);
    staging=path.join(path.dirname(plan.moduleRoot),'.foreman-next-stage-'+randomUUID());await fs.mkdir(staging);await writeTree(staging,plan.files);
    const receipt={format:'foreman-desktop-rc2-v1',completed:false,home:plan.home,profileDir:plan.profileDir,moduleRoot:plan.moduleRoot,
      moduleExisted:plan.moduleExists,files:plan.files.map(({path,sha256})=>({path,sha256})),oldFiles:plan.existing,
      edits:plan.edits.map(({path,backupName,existed,beforeHash,afterHash})=>({path,backupName,existed,beforeHash,afterHash}))};
    for(const edit of plan.edits)await fs.writeFile(path.join(backup,edit.backupName),edit.before,{flag:'wx'});
    await fs.writeFile(path.join(backup,'receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx'});
    await assertStopped(plan.home);await assertDesktopUnchanged(plan);
    if(plan.moduleExists){await fs.rename(plan.moduleRoot,path.join(backup,'old-plugin'));movedOld=true;}
    await fs.rename(staging,plan.moduleRoot);movedNew=true;
    for(const edit of plan.edits){
      ensure(edit.existed?sha256(await ordinaryFile(edit.path))===edit.beforeHash:await absent(edit.path),'Desktop profile changed during commit');
      await commitDesktopFile(edit,edit.after);committed.push(edit);
    }
    await afterProfileCommit();receipt.completed=true;
    await fs.writeFile(path.join(backup,'receipt.json'),JSON.stringify(receipt,null,2));
    return {backup,receipt:path.join(backup,'receipt.json'),readyForProjects:false,profileRowsAdded:plan.change.appendProfileRows};
  }catch(error){
    const recoveryErrors=[];
    for(const edit of committed.reverse())try {
      ensure(sha256(await ordinaryFile(edit.path))===edit.afterHash,'Desktop profile changed after commit');
      if(edit.existed)await commitDesktopFile(edit,edit.before);else await fs.unlink(edit.path);
    }catch(e){recoveryErrors.push(e);}
    if(!recoveryErrors.length)try {
      if(movedNew)await fs.rename(plan.moduleRoot,staging);
      if(movedOld)await fs.rename(path.join(backup,'old-plugin'),plan.moduleRoot);
    }catch(e){recoveryErrors.push(e);}
    if(recoveryErrors.length)throw new AggregateError([error,...recoveryErrors],'Desktop upgrade interrupted; retain backup for manual recovery');
    throw error;
  }finally{try{await guard?.close();}finally{await profileLock.close();}}
}
export async function rollbackDesktopRc2(receiptPath,{assertStopped=assertNoDesktopHost,acquireGuard=acquireWriterGuard,beforeProfileCommit=async()=>{}}={}) {
  ensure(path.resolve(receiptPath)===await fs.realpath(receiptPath),'Linked receipt path');
  const receipt=JSON.parse(await ordinaryFile(receiptPath)),backup=path.dirname(receiptPath),home=path.resolve(receipt.home),profileDir=path.join(home,'profiles','desktop');
  ensure(receipt.format==='foreman-desktop-rc2-v1'&&receipt.completed===true&&receipt.profileDir===profileDir&&
    receipt.moduleRoot===path.join(profileDir,'node_modules',moduleName)&&path.dirname(backup)===path.join(home,'.foreman-next-upgrades')&&path.basename(receiptPath)==='receipt.json','Foreign Desktop receipt paths');
  for(const dir of [home,path.join(home,'profiles'),profileDir,path.dirname(receipt.moduleRoot),path.join(home,'storages'),path.join(home,'storages','foreman-next'),path.dirname(backup),backup])await ordinaryDirectory(dir);
  ensure(Array.isArray(receipt.edits)&&receipt.edits.length===2&&receipt.edits.every((e,i)=>e.backupName===['package.json','cordis.patch.yml'][i]&&e.path===path.join(profileDir,e.backupName)&&typeof e.existed==='boolean'&&/^[a-f0-9]{64}$/.test(e.beforeHash)&&/^[a-f0-9]{64}$/.test(e.afterHash)),'Unsafe Desktop profile record');
  for(const list of [receipt.files,receipt.oldFiles])ensure(Array.isArray(list)&&list.every(f=>safeRelative(f.path)&&/^[a-f0-9]{64}$/.test(f.sha256)),'Unsafe Desktop inventory');
  ensure(receipt.files.length>0&&typeof receipt.moduleExisted==='boolean','Missing Desktop package record');
  await assertStopped(home);const profileLock=await desktopLock(profileDir);let guard,parkedNew=false,restoredOld=false;const committed=[];
  const parked=path.join(backup,'desktop-plugin-rolled-back');
  try {
    await assertStopped(home);
    guard=await acquireGuard(path.join(home,'storages','foreman-next','writer.guard'));ensure(guard?.close,'Writer guard unavailable');
    for(const edit of receipt.edits){edit.before=await ordinaryFile(path.join(backup,edit.backupName));ensure(sha256(edit.before)===edit.beforeHash,'Desktop profile backup mismatch');
      edit.after=await ordinaryFile(edit.path);ensure(sha256(edit.after)===edit.afterHash,'Desktop profile changed since upgrade');}
    const sort=files=>[...files].sort((a,b)=>a.path.localeCompare(b.path));
    ensure(JSON.stringify(await inventory(receipt.moduleRoot))===JSON.stringify(sort(receipt.files)),'Desktop package changed since upgrade');
    if(receipt.moduleExisted)ensure(JSON.stringify(await inventory(path.join(backup,'old-plugin')))===JSON.stringify(sort(receipt.oldFiles)),'Desktop backup package changed');
    ensure(await absent(parked),'Desktop rollback already used');
    await fs.rename(receipt.moduleRoot,parked);parkedNew=true;
    if(receipt.moduleExisted){await fs.rename(path.join(backup,'old-plugin'),receipt.moduleRoot);restoredOld=true;}
    await beforeProfileCommit();
    for(const edit of receipt.edits)ensure(sha256(await ordinaryFile(edit.path))===edit.afterHash,'Desktop profile changed during rollback');
    for(const edit of receipt.edits){if(edit.existed)await commitDesktopFile(edit,edit.before);else await fs.unlink(edit.path);committed.push(edit);}
    return {rolledBack:true,backup,profileRestored:true,projectDataPreserved:true};
  }catch(error){
    const recoveryErrors=[];
    for(const edit of committed.reverse())try {
      ensure(edit.existed?sha256(await ordinaryFile(edit.path))===edit.beforeHash:await absent(edit.path),'Desktop profile changed after rollback commit');
      await commitDesktopFile(edit,edit.after);
    }catch(e){recoveryErrors.push(e);}
    if(!recoveryErrors.length)try {
      if(restoredOld)await fs.rename(receipt.moduleRoot,path.join(backup,'old-plugin'));
      if(parkedNew)await fs.rename(parked,receipt.moduleRoot);
    }catch(e){recoveryErrors.push(e);}
    if(recoveryErrors.length)throw new AggregateError([error,...recoveryErrors],'Desktop rollback interrupted; manual recovery required');
    throw error;
  }finally{try{await guard?.close();}finally{await profileLock.close();}}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [mode,...args]=process.argv.slice(2);
  if(mode==='plan'&&args.length===2){const p=await planRc2({home:args[0],release:args[1]});console.log(JSON.stringify({home:p.home,release:p.release,version:p.version,hostConfigKeys:p.hostConfigKeys,change:p.change,profileBeforeHash:p.beforeHash,profileAfterHash:p.afterHash},null,2));}
  else if(mode==='upgrade'&&args.length===2)console.log(JSON.stringify(await upgradeRc2({home:args[0],release:args[1]}),null,2));
  else if(mode==='rollback'&&args.length===1)console.log(JSON.stringify(await rollbackRc2(args[0]),null,2));
  else if(mode==='desktop-plan'&&args.length===3){const p=await planDesktopRc2({home:args[0],profileDir:args[1],release:args[2]});console.log(JSON.stringify({home:p.home,profileDir:p.profileDir,release:p.release,change:p.change,profileHashes:p.edits.map(e=>({path:e.path,before:e.beforeHash,after:e.afterHash}))},null,2));}
  else if(mode==='desktop-upgrade'&&args.length===3)console.log(JSON.stringify(await upgradeDesktopRc2({home:args[0],profileDir:args[1],release:args[2]}),null,2));
  else if(mode==='desktop-rollback'&&args.length===1)console.log(JSON.stringify(await rollbackDesktopRc2(args[0]),null,2));
  else throw Error('Usage: plan|upgrade HOME RELEASE | rollback RECEIPT | desktop-plan|desktop-upgrade HOME PROFILE RELEASE | desktop-rollback RECEIPT');
}
