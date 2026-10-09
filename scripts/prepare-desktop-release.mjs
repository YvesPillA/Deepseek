// Host-only release preparation. Never imported by the plugin or exposed as a tool/RPC.
// Planning reads files only. Configuration does not issue an approved release record.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {planDesktopRc2,assertNoDesktopHost} from './upgrade-local-rc2.mjs';
import {acquireWriterGuard} from '../src/writer-guard.mjs';

const check=(ok,message)=>{if(!ok)throw Error(message);};
const hash=b=>createHash('sha256').update(b).digest('hex');
const imagePattern=/^sha256:[a-f0-9]{64}$/;
const evidenceKinds=['desktopUI','recovery','projectFinal','regression'];
async function ordinary(file,kind='file') {
  check(typeof file==='string'&&path.isAbsolute(file),'Absolute preparation paths required');
  file=path.resolve(file);let cursor=path.parse(file).root;
  for(const part of ['',...path.relative(cursor,file).split(path.sep).filter(Boolean)]) {
    if(part)cursor=path.join(cursor,part);
    const stat=await fs.lstat(cursor);
    check(!stat.isSymbolicLink()&&(cursor===file&&kind==='file'?stat.isFile()&&stat.nlink===1:stat.isDirectory()),'Preparation path must be ordinary and contain no links');
  }
  check(await fs.realpath(file)===file,'Preparation path changed target');return file;
}
async function read(file) {await ordinary(file);return fs.readFile(file);}
async function optional(file) {try{return await read(file);}catch(e){if(e.code==='ENOENT')return undefined;throw e;}}
async function hashFile(file) {
  await ordinary(file);const handle=await fs.open(file,'r');
  try {const digest=createHash('sha256');for await(const bytes of handle.createReadStream({autoClose:false}))digest.update(bytes);return digest.digest('hex');}
  finally {await handle.close();}
}
export async function desktopArchiveIdentity(resourcesPath) {
  await ordinary(resourcesPath,'directory');const archive=path.join(resourcesPath,'app.asar');await ordinary(archive);
  const asarSha256=await hashFile(archive),handle=await fs.open(archive,'r');
  try {
    const prefix=Buffer.alloc(16);check((await handle.read(prefix,0,16,0)).bytesRead===16,'Invalid actual Desktop archive');
    const headerSize=prefix.readUInt32LE(4),jsonSize=prefix.readUInt32LE(12);
    check(headerSize>=8&&headerSize<=32*1024*1024&&jsonSize>0&&jsonSize<=headerSize-8,'Invalid actual Desktop archive header');
    const header=Buffer.alloc(jsonSize);check((await handle.read(header,0,jsonSize,16)).bytesRead===jsonSize,'Truncated Desktop archive');
    const entry=JSON.parse(header.toString()).files?.['package.json'],offset=Number(entry?.offset);
    check(entry&&!entry.link&&!entry.unpacked&&Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(entry.size)&&entry.size>0&&entry.size<=1024*1024,'Invalid actual Desktop package');
    const bytes=Buffer.alloc(entry.size);check((await handle.read(bytes,0,entry.size,8+headerSize+offset)).bytesRead===entry.size,'Truncated Desktop package');
    const pkg=JSON.parse(bytes.toString()),buildCommit=pkg.dshBuildCommit??pkg.buildCommit;
    check(pkg.version==='0.2.0-rc.2'&&/^[a-f0-9]{40}$/.test(buildCommit??''),'Only actual verified 0.2.0-rc.2 Desktop is supported');
    return {version:pkg.version,buildCommit,asarSha256};
  }finally{await handle.close();}
}
function entries(rows) {
  const found=[];for(const row of rows){found.push(row);if(row?.group&&Array.isArray(row.config))found.push(...entries(row.config));}return found;
}
export function selectDesktopModel(rows) {
  const matches=entries(rows).filter(r=>r?.id==='agent-default-model');
  check(matches.length===1&&matches[0].name==='@deepseek-ai/dsh-agent-default-model'&&!matches[0].disabled,'Exactly one active Desktop default-model entry required');
  const source=matches[0].config,selection={};
  for(const key of ['provider','model','reasoningEffort'])if(source?.[key]!==undefined) {
    check(typeof source[key]==='string'&&source[key].trim()&&source[key].length<=160,'Desktop model selection must be explicit literal strings');selection[key]=source[key];
  }
  check(selection.provider&&selection.model,'Desktop provider and model required');
  const route=selection.provider==='deepseek-account'?['llm-deepseek-account','@deepseek-ai/dsh-llm-deepseek-account']:
    selection.provider==='deepseek-official'?['llm-deepseek','@deepseek-ai/dsh-llm-deepseek-api-key']:null;
  check(route,'Reviewed official Desktop provider required');
  const adapters=entries(rows).filter(r=>r?.id===route[0]),adapter=adapters[0];
  check(adapters.length===1&&adapter?.name===route[1]&&!adapter.disabled,'Exactly one active official Desktop adapter required');
  check(adapter.config?.baseURL===undefined||adapter.config.baseURL==='https://api.deepseek.com/anthropic','Official Desktop Messages endpoint required');
  check(adapter.config?.protocol===undefined,'Official Desktop adapter protocol must remain fixed');
  return selection; // Explicit whitelist: never return or copy any adapter config or key.
}
async function registeredRoute(runtimeRoot,rows,selection) {
  const req=createRequire(path.join(runtimeRoot,'package.json'));
  const packageName=selection.provider==='deepseek-account'?'@deepseek-ai/dsh-llm-deepseek-account':'@deepseek-ai/dsh-llm-deepseek-api-key';
  const adapterId=selection.provider==='deepseek-account'?'llm-deepseek-account':'llm-deepseek';
  const adapterRow=entries(rows).find(r=>r.id===adapterId&&r.name===packageName&&!r.disabled);
  const adapter=await import(pathToFileURL(req.resolve(packageName)).href);
  const transport=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm-deepseek')).href);
  // Only protocol/catalog facts enter the offline registration fixture. No
  // account service, credentials, environment, discovery or inference is used.
  const safe={baseURL:'https://api.deepseek.com/anthropic'};
  if(adapterRow.config?.models!==undefined) {
    check(Array.isArray(adapterRow.config.models)&&adapterRow.config.models.every(m=>typeof m?.id==='string'),'Literal official model catalog required');
    safe.models=adapterRow.config.models.map(m=>({id:m.id}));
  }
  if(selection.provider==='deepseek-official')safe.apiKeyEnv={get:()=> 'DEEPSEEK_API_KEY'};
  const providers=[],registered=[];
  adapter.apply({fiber:{entry:{options:{id:adapterRow.id}}},get:key=>key==='launchEnvironment'?{get:()=>undefined}:undefined,
    inject:()=>{},on:()=>{},logger:{warn:()=>{}},llm:{registerConfigurableProviders:p=>providers.push(...p),registerAdapter:p=>{registered.push(...p);return {replace(){}};}}},safe);
  check(providers.some(p=>p.provider===selection.provider)&&registered.includes(selection.provider),'Official provider registration mismatch');
  const connection=transport.resolveAdapterOptions({...safe,apiKeyEnv:undefined});
  check(connection.models.some(m=>m.id===selection.model),'Selected model is absent from official configured catalog');
  return {provider:selection.provider,adapter:packageName,registered:true,catalogModel:selection.model,authentication:'not-checked',connectivity:'not-checked',
    readiness:'Final Electron host must confirm provider availability; account sign-in and inference were not probed.'};
}
async function composeDesktop({runtimeRoot,profileDir,home,profilePatch}) {
  const requireRuntime=createRequire(path.join(runtimeRoot,'package.json'));
  const boot=await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-app-boot')).href);
  const {entryListSchema}=await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/cordis-plugin-include')).href);
  // loadProfile()/CLI --dump-config normalize profiles and rewrite cordis.yml; do not use them here.
  const loaded=boot.loadProfileDirectory('foreman-release-plan',profileDir,path.join(runtimeRoot,'package.json'),{userLayer:false});
  check(!loaded.skippedBundles.length,'Desktop bundle compatibility/resolution blocked');
  const yaml=requireRuntime('yaml'),jsYaml=requireRuntime('js-yaml'),homePatch=await optional(path.join(home,'cordis.patch.yml'));
  // Parse !!js with the actual host dialect without evaluating it. Loader's optional parser is read-only.
  const profileRows=profilePatch===undefined?(boot.loadOptionalPatches('foreman-release-plan',path.join(profileDir,'cordis.patch.yml'))??[]):jsYaml.load(profilePatch.toString(),{schema:entryListSchema});
  const homeRows=homePatch===undefined?[]:boot.loadOptionalPatches('foreman-release-plan',path.join(home,'cordis.patch.yml'));
  const warnings=[],rows=boot.composeEntries([...loaded.layers.map(l=>l.patches),profileRows,homeRows],line=>warnings.push(line));
  return {rows,warnings,yaml,jsYaml,entryListSchema,loaded,homePatchHash:homePatch===undefined?null:hash(homePatch)};
}
export async function planDesktopRelease(input) {
  const {home,profileDir,release,runtimeRoot,resourcesPath,dockerExecutable,verificationImage,verificationBackend='docker',sourceEvidence={}}=input;
  check(['docker','native'].includes(verificationBackend),'Reviewed verification backend required');
  if(verificationBackend==='native')check(process.platform==='win32','Native release requires the Windows host');
  check(typeof runtimeRoot==='string'&&path.isAbsolute(runtimeRoot),'Explicit actual extracted runtime root required');
  for(const directory of [home,profileDir,release,runtimeRoot])await ordinary(directory,'directory');
  if(verificationBackend==='docker') {
    check(imagePattern.test(verificationImage??''),'Pinned verification image required');await ordinary(dockerExecutable);
  }
  const upgrade=await planDesktopRc2({home,profileDir,release});
  for(const file of upgrade.files)await ordinary(path.join(upgrade.release,file.path));
  const beforePatch=upgrade.edits.find(e=>e.backupName==='cordis.patch.yml').after;
  const composed=await composeDesktop({...input,profilePatch:beforePatch});
  const selection=selectDesktopModel(composed.rows),hosts=entries(composed.rows).filter(r=>r?.id==='foreman-next-host');
  const providerRegistration=await registeredRoute(runtimeRoot,composed.rows,selection);
  check(hosts.length===1&&hosts[0].name==='dsh-foreman-next'&&!hosts[0].disabled,'Exactly one active foreman Desktop host required');
  const config=hosts[0].config;
  check(config&&typeof config==='object'&&!Array.isArray(config)&&!config.__jsExpr,'Literal foreman configuration required');
  for(const key of ['verification','scheduler'])check(config[key]===undefined||config[key]&&typeof config[key]==='object'&&!Array.isArray(config[key])&&!config[key].__jsExpr,'Literal managed foreman sections required');
  check(path.resolve(config.dshHome)===upgrade.home&&path.resolve(config.storageRoot)===path.join(upgrade.home,'storages','foreman-next')&&path.resolve(config.sessionRoot)===path.join(upgrade.home,'sessions'),'Foreman protection paths must match Desktop home');
  check(config.readyForProjects!==true,'Legacy project switch must stay false');
  const releaseId=path.basename(upgrade.release);check(/^[a-zA-Z0-9_-]{1,100}$/.test(releaseId),'Safe candidate directory name required');
  const protectedDirectory=path.join(config.storageRoot,'releases',releaseId),approvalPath=path.join(protectedDirectory,'release-approval.json');
  const verification=verificationBackend==='native'?{backend:'native'}:
    {...config.verification,backend:'docker',executable:path.resolve(dockerExecutable),image:verificationImage};
  const managed={releaseApprovalPath:approvalPath,verification,scheduler:{...config.scheduler,agentOptions:selection},readyForProjects:false};
  const desired={...config,...managed},override={id:'foreman-next-host',name:'dsh-foreman-next',config:desired};
  const text=beforePatch.toString(),document=composed.yaml.parseDocument(text);check(!document.errors.length&&composed.yaml.isSeq(document.contents),'Invalid future Desktop patch');
  const overrideText=composed.jsYaml.dump([override],{schema:composed.entryListSchema});
  // Preserve user bytes and !!js tags; only the new host override is serialized
  // through the official non-evaluating schema.
  let afterPatch;
  if(document.contents.flow) {
    const end=document.contents.range[1]-1;check(text[end]===']','Unsupported Desktop flow patch');
    const encoded=composed.jsYaml.dump(override,{schema:composed.entryListSchema,flowLevel:0});
    afterPatch=Buffer.from(text.slice(0,end)+(document.contents.items.length?',':'')+'\n'+encoded+'\n'+text.slice(end));
  }else afterPatch=Buffer.concat([beforePatch,Buffer.from((beforePatch.at(-1)===10?'':'\n')+'# Foreman release configuration; approval remains false.\n'+overrideText)]);
  // A home patch has higher priority; refuse to publish a configuration it would replace.
  const final=await composeDesktop({...input,profilePatch:afterPatch});
  const actual=entries(final.rows).filter(r=>r?.id==='foreman-next-host');
  check(actual.length===1&&JSON.stringify(actual[0].config)===JSON.stringify(desired),'Home-level patch overrides prepared foreman configuration');
  const runtime=await desktopArchiveIdentity(resourcesPath),metadata=JSON.parse(await read(path.join(path.dirname(path.resolve(runtimeRoot)),'source-metadata.json'))),evidence={},missing=[];
  check(metadata.sourceSha256===runtime.asarSha256&&metadata.version===runtime.version&&metadata.buildCommit===runtime.buildCommit&&path.resolve(metadata.source)===path.join(path.resolve(resourcesPath),'app.asar'),'Extracted routing runtime must match the actual Desktop archive');
  for(const kind of evidenceKinds) {
    if(!sourceEvidence[kind]){missing.push(kind);continue;}
    check(path.isAbsolute(sourceEvidence[kind]),'Absolute acceptance source required');
    const source=path.resolve(sourceEvidence[kind]),sha256=await hashFile(source);
    evidence[kind]={path:path.join(protectedDirectory,'evidence',kind+path.extname(source)),sha256};
  }
  const pkgBytes=upgrade.files.find(f=>f.path==='package.json').bytes,pkg=JSON.parse(pkgBytes);
  const verificationIdentity=verificationBackend==='native'?{verification:{backend:'native',platform:'win32',sandbox:'windows-acl'}}:{verificationImage};
  const draft={version:verificationBackend==='native'?2:1,approved:false,runtime,plugin:{name:pkg.name,version:pkg.version,manifestSha256:hash(pkgBytes),files:upgrade.files.map(({path,sha256})=>({path,sha256}))},...verificationIdentity,evidence};
  const expectedInstalled=upgrade.files.map(({path,sha256})=>({path,sha256})).sort((a,b)=>a.path.localeCompare(b.path));
  const installedMatches=JSON.stringify(upgrade.existing)===JSON.stringify(expectedInstalled);
  const reviewHash=hash(JSON.stringify({home:upgrade.home,profileDir:upgrade.profileDir,draft,patchBeforeHash:hash(beforePatch),patchAfterHash:hash(afterPatch),packageHash:upgrade.edits.find(e=>e.backupName==='package.json').afterHash,homePatchHash:final.homePatchHash}));
  return {upgrade,input,afterPatch,beforePatch,draft,missing,installedMatches,protectedDirectory,approvalPath,selection,providerRegistration,reviewHash,
    patchBeforeHash:hash(beforePatch),patchAfterHash:hash(afterPatch),packageHash:upgrade.edits.find(e=>e.backupName==='package.json').afterHash,
    homePatchHash:final.homePatchHash,modelSource:'actual bundle + desktop patch + home patch; literal agent-default-model whitelist',warnings:final.warnings};
}
export function releasePlanSummary(plan) {
  return {readOnly:true,installedMatches:plan.installedMatches,readyForProjects:false,missingEvidence:plan.missing,
    runtime:plan.draft.runtime,selection:plan.selection,providerRegistration:plan.providerRegistration,reviewHash:plan.reviewHash,modelSource:plan.modelSource,
    hostConfigChanges:{releaseApprovalPath:plan.approvalPath,verification:plan.draft.version===2?{backend:'native'}:{backend:'docker',executable:path.resolve(plan.input.dockerExecutable),image:plan.draft.verificationImage},scheduler:{agentOptions:plan.selection},readyForProjects:false},
    protectedDirectory:plan.protectedDirectory,patchBeforeHash:plan.patchBeforeHash,patchAfterHash:plan.patchAfterHash,packageHash:plan.packageHash,homePatchHash:plan.homePatchHash,
    upgradeChange:plan.upgrade.change,approvalDraft:plan.draft,warnings:plan.warnings,
    limitations:['Draft is explicitly unapproved and cannot open readiness.','Evidence hashes bind bytes; a human host reviewer must decide actual acceptance.','Only actual Electron startup can issue the private readiness brand.','No Docker daemon, model authentication, UI or project launch is performed by this plan.']};
}
async function lock(profileDir) {
  const file=path.join(profileDir,'lock'),handle=await fs.open(file,'wx',0o600);
  try{await handle.writeFile(`${process.pid}\n`);await handle.sync();}catch(e){await handle.close();await fs.unlink(file);throw e;}
  return {async close(){await handle.close();await fs.unlink(file);}};
}
async function atomic(file,bytes) {
  const pending=file+'.foreman-release-'+randomUUID();const handle=await fs.open(pending,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  try{await fs.rename(pending,file);}finally{await fs.rm(pending,{force:true});}
}
export async function applyDesktopReleaseConfig(input,{expectedPatchHash,expectedPackageHash,expectedReviewHash,assertStopped=assertNoDesktopHost,acquireGuard=acquireWriterGuard,beforeCommit=async()=>{}}={}) {
  check([expectedPatchHash,expectedPackageHash,expectedReviewHash].every(h=>/^[a-f0-9]{64}$/.test(h??'')),'Reviewed expected patch/package/release hashes required');
  await ordinary(input.home,'directory');await ordinary(input.profileDir,'directory');
  await assertStopped(input.home);const profileLock=await lock(input.profileDir);let guard;
  try {
    await assertStopped(input.home);const plan=await planDesktopRelease(input);
    check(plan.installedMatches,'Install exact candidate before configuring Desktop');check(!plan.missing.length,'All four real acceptance evidence sources are required before configuration');
    check(plan.reviewHash===expectedReviewHash,'Release plan changed since review');
    const patch=path.join(plan.upgrade.profileDir,'cordis.patch.yml'),packageFile=path.join(plan.upgrade.profileDir,'package.json');
    const before=await read(patch);
    check(hash(before)===expectedPatchHash&&plan.patchBeforeHash===expectedPatchHash&&hash(await read(packageFile))===expectedPackageHash&&plan.packageHash===expectedPackageHash,'Desktop profile changed since review');
    await ordinary(plan.upgrade.home,'directory');await ordinary(path.join(plan.upgrade.home,'storages','foreman-next'),'directory');
    guard=await acquireGuard(path.join(plan.upgrade.home,'storages','foreman-next','writer.guard'));check(guard?.close,'Writer guard unavailable');
    const backupRoot=path.join(plan.upgrade.home,'.foreman-next-upgrades');await ordinary(backupRoot,'directory');
    const backup=path.join(backupRoot,'release-config-'+randomUUID());await fs.mkdir(backup);
    await durableNew(path.join(backup,'cordis.patch.yml'),before);
    const receipt={format:'foreman-desktop-release-config-v1',home:plan.upgrade.home,profileDir:plan.upgrade.profileDir,patch,packageFile,packageHash:expectedPackageHash,beforeHash:expectedPatchHash,afterHash:plan.patchAfterHash,approvalPath:plan.approvalPath,reviewHash:expectedReviewHash,completed:false};
    const receiptPath=path.join(backup,'receipt.json');await durableNew(receiptPath,Buffer.from(JSON.stringify(receipt,null,2)));
    await beforeCommit();await assertStopped(input.home);
    check(hash(await read(patch))===expectedPatchHash&&hash(await read(packageFile))===expectedPackageHash,'Desktop profile changed during configuration');
    const fresh=await planDesktopRelease(input);check(fresh.installedMatches&&fresh.reviewHash===expectedReviewHash,'Release inputs changed during configuration');
    const releases=path.dirname(plan.protectedDirectory);
    if(await optionalDirectory(releases)===false)await fs.mkdir(releases);
    await ordinary(releases,'directory');
    check(await optionalDirectory(plan.protectedDirectory)===false,'Protected release directory already exists; review it manually');
    const staging=path.join(releases,'.prepare-'+randomUUID());await fs.mkdir(staging);
    let published=false;
    try {
      await fs.mkdir(path.join(staging,'evidence'));
      for(const kind of evidenceKinds) {
        const bytes=await read(input.sourceEvidence[kind]);check(hash(bytes)===plan.draft.evidence[kind].sha256,'Acceptance evidence changed during copy');
        await durableNew(path.join(staging,'evidence',path.basename(plan.draft.evidence[kind].path)),bytes);
      }
      await durableNew(path.join(staging,'release-approval.json'),Buffer.from(JSON.stringify(plan.draft,null,2)+'\n'));
      await assertStopped(input.home);
      const last=await planDesktopRelease(input);check(last.installedMatches&&last.reviewHash===expectedReviewHash&&hash(await read(patch))===expectedPatchHash&&hash(await read(packageFile))===expectedPackageHash,'Release inputs changed before configuration commit');
      await fs.rename(staging,plan.protectedDirectory);published=true;
    }finally {if(!published){check(path.dirname(path.resolve(staging))===releases&&path.basename(staging).startsWith('.prepare-'),'Unsafe staging cleanup target');await fs.rm(staging,{recursive:true,force:true});}}
    await atomic(patch,plan.afterPatch);
    try{receipt.completed=true;await atomic(receiptPath,Buffer.from(JSON.stringify(receipt,null,2)));}
    catch(error){check(hash(await read(patch))===plan.patchAfterHash,'Configuration receipt failed and profile changed; inspect backup');await atomic(patch,before);throw error;}
    return {configured:true,readyForProjects:false,approvalCreated:false,unapprovedDraftCreated:true,approvalPath:plan.approvalPath,receipt:receiptPath};
  }finally{try{await guard?.close();}finally{await profileLock.close();}}
}
async function optionalDirectory(directory) {try{await ordinary(directory,'directory');return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function durableNew(file,bytes) {const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
export async function rollbackDesktopReleaseConfig(receiptPath,{assertStopped=assertNoDesktopHost,acquireGuard=acquireWriterGuard,beforeCommit=async()=>{}}={}) {
  const receipt=JSON.parse(await read(receiptPath)),home=path.resolve(receipt.home??''),profileDir=path.join(home,'profiles','desktop'),backup=path.dirname(path.resolve(receiptPath));
  check(receipt.format==='foreman-desktop-release-config-v1'&&receipt.completed===true&&receipt.home===home&&receipt.profileDir===profileDir&&receipt.patch===path.join(profileDir,'cordis.patch.yml')&&receipt.packageFile===path.join(profileDir,'package.json')&&path.dirname(backup)===path.join(home,'.foreman-next-upgrades')&&path.basename(backup).startsWith('release-config-')&&path.basename(receiptPath)==='receipt.json','Foreign release configuration receipt');
  check([receipt.beforeHash,receipt.afterHash,receipt.packageHash,receipt.reviewHash].every(h=>/^[a-f0-9]{64}$/.test(h??'')),'Invalid release configuration hashes');
  await ordinary(home,'directory');await ordinary(profileDir,'directory');
  await assertStopped(home);const profileLock=await lock(profileDir);let guard;
  try {
    await assertStopped(home);const before=await read(path.join(backup,'cordis.patch.yml'));
    check(hash(before)===receipt.beforeHash&&hash(await read(receipt.patch))===receipt.afterHash&&hash(await read(receipt.packageFile))===receipt.packageHash,'Configuration or backup changed since apply');
    guard=await acquireGuard(path.join(home,'storages','foreman-next','writer.guard'));check(guard?.close,'Writer guard unavailable');
    await beforeCommit();await assertStopped(home);
    check(hash(await read(receipt.patch))===receipt.afterHash&&hash(await read(receipt.packageFile))===receipt.packageHash&&hash(await read(path.join(backup,'cordis.patch.yml')))===receipt.beforeHash,'Configuration changed during rollback');await atomic(receipt.patch,before);
    return {rolledBack:true,profileRestored:true,approvalRemoved:false};
  }finally{try{await guard?.close();}finally{await profileLock.close();}}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [mode,file,patchHash,packageHash,reviewHash]=process.argv.slice(2);
  if(mode==='rollback'&&file&&!patchHash)console.log(JSON.stringify(await rollbackDesktopReleaseConfig(file),null,2));
  else {
    check(['plan','apply'].includes(mode)&&file,'Usage: plan INPUT_JSON | apply INPUT_JSON EXPECTED_PATCH_HASH EXPECTED_PACKAGE_HASH EXPECTED_REVIEW_HASH | rollback RECEIPT');
    const input=JSON.parse(await read(path.resolve(file)));
    if(mode==='plan')console.log(JSON.stringify(releasePlanSummary(await planDesktopRelease(input)),null,2));
    else console.log(JSON.stringify(await applyDesktopReleaseConfig(input,{expectedPatchHash:patchHash,expectedPackageHash:packageHash,expectedReviewHash:reviewHash}),null,2));
  }
}
