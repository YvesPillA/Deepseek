import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {planDesktopRelease,releasePlanSummary,applyDesktopReleaseConfig,rollbackDesktopReleaseConfig,selectDesktopModel} from '../scripts/prepare-desktop-release.mjs';
import {upgradeDesktopRc2} from '../scripts/upgrade-local-rc2.mjs';
import {acquireWriterGuard} from '../src/writer-guard.mjs';

const runtimeRoot='C:/example/dsh-runtime';
const req=createRequire(path.join(runtimeRoot,'package.json'));
const boot=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href);
const sha=b=>createHash('sha256').update(b).digest('hex');
const stopped=async()=>{},guard=async()=>({close(){}});
async function fixture({installed=true,flow=false,expression=false}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-release-prep-'));
  const home=path.join(root,'home'),profileDir=path.join(home,'profiles','desktop'),release=path.join(root,'candidate-fixture');
  await fs.mkdir(profileDir,{recursive:true});await fs.mkdir(path.join(home,'storages','foreman-next'),{recursive:true});
  await fs.mkdir(path.join(home,'sessions'),{recursive:true});await fs.mkdir(release);
  const packageFile=path.join(profileDir,'package.json'),patch=path.join(profileDir,'cordis.patch.yml');
  await fs.writeFile(packageFile,JSON.stringify({name:'fixture-profile',private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}},custom:'keep'}));
  const rows=[{id:'agent-default-model',name:'@deepseek-ai/dsh-agent-default-model',config:{provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'high',secret:'fixture-default-never-copy'}}];
  await fs.writeFile(patch,flow?JSON.stringify(rows):req('yaml').stringify(rows)+(expression?'# user expression stays inert\n- insert:\n    - id: inert-fixture\n      name: unused-fixture\n      config: !!js "(() => { globalThis.FOREMAN_PLAN_EVALUATED = true; return {}; })()"\n':''));
  await fs.writeFile(path.join(profileDir,'cordis.yml'),'official-root-byte-witness');
  const files={
    'package.json':JSON.stringify({name:'dsh-foreman-next',version:'0.1.0',files:['src','presets'],peerDependencies:{'@deepseek-ai/dsh-scope':'0.1.7-rc.2 || 0.2.0-rc.2'}}),
    'src/readiness.mjs':'export const state={readyForProjects:false};\n',
    'presets/foreman-next/preset.yml':'name: 新工头模式\ndescription: fixture only\n',
    'presets/foreman-next/agent.cordis.yml':'- id: foreman-next-outer\n  name: dsh-foreman-next/outer\n'
  };
  for(const [name,bytes] of Object.entries(files)){await fs.mkdir(path.dirname(path.join(release,name)),{recursive:true});await fs.writeFile(path.join(release,name),bytes);}
  await fs.writeFile(path.join(release,'release-manifest.json'),JSON.stringify({name:'dsh-foreman-next',version:'0.1.0',installed:false,readyForProjects:false,files:Object.entries(files).map(([name,bytes])=>({path:name,sha256:sha(bytes)}))}));
  const sourceEvidence={};for(const kind of ['desktopUI','recovery','projectFinal','regression']){sourceEvidence[kind]=path.join(root,kind+'.txt');await fs.writeFile(sourceEvidence[kind],'TEST FIXTURE ONLY '+kind);}
  const input={home,profileDir,release,runtimeRoot,resourcesPath:'C:/example/dsh-desktop/resources',dockerExecutable:process.execPath,verificationImage:'sha256:'+'a'.repeat(64),sourceEvidence};
  if(installed)await upgradeDesktopRc2({...input,assertStopped:stopped,acquireGuard:guard});
  return {root,input,home,profileDir,patch,packageFile,async close(){assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});}};
}
const options=p=>({expectedPatchHash:p.patchBeforeHash,expectedPackageHash:p.packageHash,expectedReviewHash:p.reviewHash,assertStopped:stopped,acquireGuard:guard});
async function withFixture(fn,configuration){const f=await fixture(configuration);try{await fn(f);}finally{await f.close();}}

test('read-only plan selects actual account route and keeps expressions inert and secrets out of summary',()=>withFixture(async f=>{
  const before=await fs.readFile(f.patch),pkg=await fs.readFile(f.packageFile),root=await fs.readFile(path.join(f.profileDir,'cordis.yml'));
  const p=await planDesktopRelease(f.input),summary=releasePlanSummary(p);
  assert.deepEqual(p.selection,{provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'high'});
  assert.equal(p.providerRegistration.registered,true);assert.equal(p.providerRegistration.authentication,'not-checked');assert(p.installedMatches);
  assert(!JSON.stringify(summary).includes('fixture-default-never-copy'));assert.equal(globalThis.FOREMAN_PLAN_EVALUATED,undefined);
  assert(p.afterPatch.subarray(0,before.length).equals(before));assert.equal(p.draft.approved,false);
  assert((await fs.readFile(f.patch)).equals(before));assert((await fs.readFile(f.packageFile)).equals(pkg));assert((await fs.readFile(path.join(f.profileDir,'cordis.yml'))).equals(root));
  await assert.rejects(fs.stat(p.protectedDirectory),{code:'ENOENT'});
},{expression:true}));

test('flow YAML profile supports inert host override',()=>withFixture(async f=>{const p=await planDesktopRelease(f.input);assert(p.afterPatch.length>p.beforePatch.length);assert.equal(p.selection.provider,'deepseek-account');},{flow:true}));

test('native plan and guarded apply preserve the actual model and remove every Docker configuration dependency',()=>withFixture(async f=>{
  const rows=req('yaml').parse(await fs.readFile(f.patch,'utf8'));
  const host=rows.flatMap(r=>r.insert??[r]).find(r=>r.id==='foreman-next-host');
  host.config.verification={backend:'docker',image:'sha256:'+'c'.repeat(64),executable:'Z:/missing/docker.exe',provisioning:{image:'old'},timeoutMs:12345};
  await fs.writeFile(f.patch,req('yaml').stringify(rows));
  f.input.verificationBackend='native';delete f.input.dockerExecutable;delete f.input.verificationImage;
  const before=await fs.readFile(f.patch),p=await planDesktopRelease(f.input),summary=releasePlanSummary(p);
  assert.equal(p.draft.version,2);assert.equal(p.draft.approved,false);assert(!Object.hasOwn(p.draft,'verificationImage'));
  assert.deepEqual(p.draft.verification,{backend:'native',platform:'win32',sandbox:'windows-acl'});
  assert.deepEqual(summary.hostConfigChanges.verification,{backend:'native'});
  assert.deepEqual(p.selection,{provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'high'});
  assert((await fs.readFile(f.patch)).equals(before),'plan must leave the profile unchanged');
  const applied=await applyDesktopReleaseConfig(f.input,options(p));
  assert.deepEqual(JSON.parse(await fs.readFile(applied.approvalPath)),p.draft);
  const final=boot.loadOptionalPatches('fixture',f.patch).at(-1).config;
  assert.deepEqual(final.verification,{backend:'native'});assert.deepEqual(final.scheduler.agentOptions,p.selection);
  await rollbackDesktopReleaseConfig(applied.receipt,{assertStopped:stopped,acquireGuard:guard});assert((await fs.readFile(f.patch)).equals(before));
}));

test('backend selection is bound into the reviewed plan and Docker retains pinned image requirements',()=>withFixture(async f=>{
  const docker=await planDesktopRelease(f.input);assert.equal(docker.draft.version,1);assert.equal(docker.draft.verificationImage,f.input.verificationImage);
  await assert.rejects(planDesktopRelease({...f.input,verificationBackend:'unknown'}),/backend/);
  await assert.rejects(planDesktopRelease({...f.input,verificationImage:undefined}),/Pinned verification image/);
  await assert.rejects(planDesktopRelease({...f.input,dockerExecutable:undefined}),/Absolute preparation paths/);
  const input={...f.input,verificationBackend:'native',dockerExecutable:'Z:/must-not-access/docker.exe',verificationImage:'not-an-image'};
  const native=await planDesktopRelease(input);assert.notEqual(native.reviewHash,docker.reviewHash);
  await assert.rejects(applyDesktopReleaseConfig(input,options(docker)),/plan changed since review/);
  const unchanged=await planDesktopRelease({...input,dockerExecutable:undefined,verificationImage:undefined});
  assert.equal(unchanged.reviewHash,native.reviewHash,'ignored Docker arguments cannot affect native identity');
}));

test('apply requires all four evidence records',()=>withFixture(async f=>{delete f.input.sourceEvidence.projectFinal;const p=await planDesktopRelease(f.input);assert.deepEqual(p.missing,['projectFinal']);await assert.rejects(applyDesktopReleaseConfig(f.input,options(p)),/All four/);assert((await fs.readFile(f.patch)).equals(p.beforePatch));}));

test('apply requires exact installed candidate',()=>withFixture(async f=>{const p=await planDesktopRelease(f.input);assert(!p.installedMatches);await assert.rejects(applyDesktopReleaseConfig(f.input,options(p)),/Install exact candidate/);},{installed:false}));

test('apply copies protected ordinary evidence and unapproved draft; rollback restores exact user bytes',()=>withFixture(async f=>{
  const p=await planDesktopRelease(f.input),result=await applyDesktopReleaseConfig(f.input,options(p));
  assert.equal(result.approvalCreated,false);assert.equal(result.readyForProjects,false);
  assert.deepEqual(JSON.parse(await fs.readFile(result.approvalPath)),p.draft);
  for(const e of Object.values(p.draft.evidence)){assert.equal(sha(await fs.readFile(e.path)),e.sha256);assert.equal((await fs.stat(e.path)).nlink,1);}
  const composed=boot.composeEntries([boot.loadProfileDirectory('fixture',f.profileDir,path.join(runtimeRoot,'package.json'),{userLayer:false}).layers.flatMap(l=>l.patches),boot.loadOptionalPatches('fixture',f.patch)]);
  const walk=rows=>rows.flatMap(r=>[r,...r.group&&Array.isArray(r.config)?walk(r.config):[]]);
  const rows=walk(composed),host=rows.find(r=>r.id==='foreman-next-host');assert.deepEqual(host.config.scheduler.agentOptions,p.selection);assert.equal(rows.find(r=>r.id==='agent-default-model').config.secret,'fixture-default-never-copy');
  await rollbackDesktopReleaseConfig(result.receipt,{assertStopped:stopped,acquireGuard:guard});assert((await fs.readFile(f.patch)).equals(p.beforePatch));
}));

test('reviewed plan binds candidate, runtime, evidence and home patch hashes',()=>withFixture(async f=>{const p=await planDesktopRelease(f.input);await fs.appendFile(f.input.sourceEvidence.regression,' changed');await assert.rejects(applyDesktopReleaseConfig(f.input,options(p)),/plan changed since review/);}));

test('apply refuses concurrent profile/package/home patch/evidence changes',async()=>{
  for(const target of ['patch','package','home','evidence'])await withFixture(async f=>{
    const p=await planDesktopRelease(f.input),before=await fs.readFile(f.patch);
    await assert.rejects(applyDesktopReleaseConfig(f.input,{...options(p),beforeCommit:async()=>{
      if(target==='patch')await fs.appendFile(f.patch,'# concurrent\n');
      if(target==='package')await fs.appendFile(f.packageFile,' ');
      if(target==='home')await fs.writeFile(path.join(f.home,'cordis.patch.yml'),'[]\n');
      if(target==='evidence')await fs.appendFile(f.input.sourceEvidence.projectFinal,' concurrent');
    }}),/changed/);
    if(target!=='patch')assert((await fs.readFile(f.patch)).equals(before));
  });
});

test('profile lock, stopped host and writer guard failures refuse apply',async()=>{
  for(const target of ['lock','host','writer'])await withFixture(async f=>{
    const p=await planDesktopRelease(f.input);
    if(target==='lock')await fs.writeFile(path.join(f.profileDir,'lock'),'fixture lock');
    await assert.rejects(applyDesktopReleaseConfig(f.input,{...options(p),...target==='host'?{assertStopped:async()=>{throw Error('host running');}}:target==='writer'?{acquireGuard:async()=>{throw Error('writer busy');}}:{}}),/EEXIST|host running|writer busy/);
    assert((await fs.readFile(f.patch)).equals(p.beforePatch));
    if(target==='lock')assert.equal(await fs.readFile(path.join(f.profileDir,'lock'),'utf8'),'fixture lock');
    else await assert.rejects(fs.stat(path.join(f.profileDir,'lock')),{code:'ENOENT'});
  });
});

test('home host override cannot silently defeat release configuration',()=>withFixture(async f=>{
  await fs.writeFile(path.join(f.home,'cordis.patch.yml'),'- id: foreman-next-host\n  config:\n    readyForProjects: false\n');
  await assert.rejects(planDesktopRelease(f.input),/paths|path|must match/);
}));

test('valid higher priority home host config also rejects managed override and preserves user values',()=>withFixture(async f=>{
  const config={dshHome:f.home,storageRoot:path.join(f.home,'storages','foreman-next'),sessionRoot:path.join(f.home,'sessions'),readyForProjects:false,userField:'keep',scheduler:{intervalMs:3210}};
  await fs.writeFile(path.join(f.home,'cordis.patch.yml'),req('yaml').stringify([{id:'foreman-next-host',config}]));
  await assert.rejects(planDesktopRelease(f.input),/Home-level patch overrides/);
}));

test('host user fields and scheduler/verification options survive configuration',()=>withFixture(async f=>{
  const config={dshHome:f.home,storageRoot:path.join(f.home,'storages','foreman-next'),sessionRoot:path.join(f.home,'sessions'),readyForProjects:false,userField:'keep',scheduler:{intervalMs:3210,agentOptions:{provider:'old',model:'old',secret:'discard'}},verification:{timeoutMs:12345}};
  const rows=req('yaml').parse(await fs.readFile(f.patch,'utf8'));
  rows.flatMap(r=>r.insert??[r]).find(r=>r.id==='foreman-next-host').config=config;
  await fs.writeFile(f.patch,req('yaml').stringify(rows));
  const p=await planDesktopRelease(f.input);const r=await applyDesktopReleaseConfig(f.input,options(p));
  const patchRows=boot.loadOptionalPatches('fixture',f.patch),last=patchRows.at(-1).config;
  assert.equal(last.userField,'keep');assert.equal(last.scheduler.intervalMs,3210);assert.equal(last.verification.timeoutMs,12345);assert.deepEqual(last.scheduler.agentOptions,p.selection);
  await rollbackDesktopReleaseConfig(r.receipt,{assertStopped:stopped,acquireGuard:guard});assert((await fs.readFile(f.patch)).equals(p.beforePatch));
}));

test('official API-key default route is also registered without reading or copying credentials',()=>withFixture(async f=>{
  await fs.appendFile(f.patch,'- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n');
  const p=await planDesktopRelease(f.input);assert.equal(p.providerRegistration.registered,true);assert.equal(p.selection.provider,'deepseek-official');assert.equal(p.providerRegistration.authentication,'not-checked');
}));

test('model route accepts only explicit official literal selection and unique active adapter',()=>{
  const model={id:'agent-default-model',name:'@deepseek-ai/dsh-agent-default-model',config:{provider:'deepseek-account',model:'deepseek-flash'}};
  const adapter={id:'llm-deepseek-account',name:'@deepseek-ai/dsh-llm-deepseek-account'};
  assert.deepEqual(selectDesktopModel([model,adapter]),model.config);
  assert.throws(()=>selectDesktopModel([{...model,config:{...model.config,model:{__jsExpr:'evil()'}}},adapter]),/literal/);
  assert.throws(()=>selectDesktopModel([model,{...adapter,disabled:true}]),/active official/);
  assert.throws(()=>selectDesktopModel([model,adapter,adapter]),/active official/);
  assert.throws(()=>selectDesktopModel([model,{...adapter,config:{baseURL:'https://third.party'}}]),/endpoint/);
});

test('official configured catalog rejects unknown selected model',()=>withFixture(async f=>{
  await fs.appendFile(f.patch,'- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: unknown-fixture-model\n');
  await assert.rejects(planDesktopRelease(f.input),/absent from official configured catalog/);
}));

test('protected release directory cannot overwrite any existing approval',()=>withFixture(async f=>{const p=await planDesktopRelease(f.input);await fs.mkdir(p.protectedDirectory,{recursive:true});await fs.writeFile(p.approvalPath,'existing witness');await assert.rejects(applyDesktopReleaseConfig(f.input,options(p)),/already exists/);assert.equal(await fs.readFile(p.approvalPath,'utf8'),'existing witness');}));

test('linked/hardlinked evidence and linked protected ancestors are refused',async()=>{
  for(const target of ['hardlink','junction'])await withFixture(async f=>{
    if(target==='hardlink'){const source=f.input.sourceEvidence.projectFinal;await fs.link(source,path.join(f.root,'duplicate.txt'));await assert.rejects(planDesktopRelease(f.input),/ordinary/);}
    else {const storage=path.join(f.home,'storages','foreman-next');await fs.rename(storage,path.join(f.root,'storage'));await fs.symlink(path.join(f.root,'storage'),storage,'junction');const p=await planDesktopRelease(f.input);await assert.rejects(applyDesktopReleaseConfig(f.input,options(p)),/ordinary/);}
  });
});

test('rollback refuses user modifications and concurrent package changes',async()=>{
  for(const target of ['patch','package'])await withFixture(async f=>{const p=await planDesktopRelease(f.input),r=await applyDesktopReleaseConfig(f.input,options(p));
    if(target==='patch')await fs.appendFile(f.patch,'# user edit\n');
    await assert.rejects(rollbackDesktopReleaseConfig(r.receipt,{assertStopped:stopped,acquireGuard:guard,beforeCommit:async()=>{if(target==='package')await fs.appendFile(f.packageFile,' ');}}),/changed/);
  });
});

test('actual Windows writer guard blocks configuration and permits guarded apply/rollback after release',()=>withFixture(async f=>{
  const p=await planDesktopRelease(f.input),held=await acquireWriterGuard(path.join(f.home,'storages','foreman-next','writer.guard'));
  try{await assert.rejects(applyDesktopReleaseConfig(f.input,{...options(p),acquireGuard:acquireWriterGuard}),/Writer lock|Cannot open/);}
  finally{await held.close();}
  const r=await applyDesktopReleaseConfig(f.input,{...options(p),acquireGuard:acquireWriterGuard});
  await rollbackDesktopReleaseConfig(r.receipt,{assertStopped:stopped,acquireGuard:acquireWriterGuard});
  assert((await fs.readFile(f.patch)).equals(p.beforePatch));
}));
