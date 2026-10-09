import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {assertNoDesktopHost,planDesktopRc2,upgradeDesktopRc2,rollbackDesktopRc2} from '../scripts/upgrade-local-rc2.mjs';

const requireRuntime=createRequire(path.join(process.env.DSH_RUNTIME_ROOT??'C:/example/dsh-runtime','package.json'));
const yaml=requireRuntime('yaml'),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const stopped=async()=>{},guard=async()=>({close(){}}),options={assertStopped:stopped,acquireGuard:guard};
async function fixture({installed=false,missingPatch=false}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-desktop-upgrade-')),home=path.join(root,'home');
  const profileDir=path.join(home,'profiles','desktop'),release=path.join(root,'release'),moduleRoot=path.join(profileDir,'node_modules/dsh-foreman-next');
  await fs.mkdir(profileDir,{recursive:true});await fs.mkdir(release);
  const packageFile=path.join(profileDir,'package.json'),patch=path.join(profileDir,'cordis.patch.yml');
  const manifest={name:'dsh-profile-desktop',private:true,dependencies:{'user-plugin':'1.2.3'},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}},userSetting:'preserve'};
  const originalPackage=JSON.stringify(manifest,null,2),originalPatch='# Keep original comment\n- insert:\n    - id: user-plugin\n      name: user-plugin\n      config:\n        arbitrary: preserve\n';
  await fs.writeFile(packageFile,originalPackage);if(!missingPatch)await fs.writeFile(patch,originalPatch);
  await fs.mkdir(path.join(home,'profiles/web'),{recursive:true});await fs.writeFile(path.join(home,'profiles/web/cordis.patch.yml'),'old web untouched');
  await fs.mkdir(path.join(home,'sessions'));await fs.writeFile(path.join(home,'sessions/user.jsonl'),'user session');
  const releaseData={
    'package.json':await fs.readFile(new URL('../package.json',import.meta.url)),
    'src/host.mjs':'export const version="desktop-rc2";\n',
    'src/readiness.mjs':'export const state={readyForProjects:false};\n',
    'presets/foreman-next/preset.yml':await fs.readFile(new URL('../presets/foreman-next/preset.yml',import.meta.url)),
    'presets/foreman-next/agent.cordis.yml':await fs.readFile(new URL('../presets/foreman-next/agent.cordis.yml',import.meta.url)),
  };
  for(const [relative,bytes] of Object.entries(releaseData)){await fs.mkdir(path.dirname(path.join(release,relative)),{recursive:true});await fs.writeFile(path.join(release,relative),bytes);}
  await fs.writeFile(path.join(release,'release-manifest.json'),JSON.stringify({name:'dsh-foreman-next',version:'0.1.0',installed:false,readyForProjects:false,files:Object.entries(releaseData).map(([relative,bytes])=>({path:relative,sha256:hash(bytes)}))}));
  if(installed){await fs.mkdir(moduleRoot,{recursive:true});await fs.writeFile(path.join(moduleRoot,'old.mjs'),'old package');}
  return {root,home,profileDir,release,moduleRoot,packageFile,patch,originalPackage,originalPatch};
}
async function withFixture(fn,config){const f=await fixture(config);try {await fn(f);}finally{await fs.rm(f.root,{recursive:true,force:true});}}
test('Desktop plan requires explicit matching home/profile and makes no changes',()=>withFixture(async f=>{
  const p=await planDesktopRc2(f);assert.equal(p.moduleExists,false);assert.deepEqual(p.change.appendProfileRows,['foreman-next-host','preset-foreman-next']);
  assert.equal(await fs.readFile(f.patch,'utf8'),f.originalPatch);assert.equal(await fs.readFile(f.packageFile,'utf8'),f.originalPackage);
  await assert.rejects(planDesktopRc2({...f,home:undefined}),/Explicit absolute/);
  await assert.rejects(planDesktopRc2({...f,profileDir:path.join(f.home,'profiles/web')}),/does not belong/);
}));
for(const installed of [false,true])test(`Desktop ${installed?'upgrade':'first install'} preserves user plugin/data and rolls back both profile files`,()=>withFixture(async f=>{
  const result=await upgradeDesktopRc2({...f,...options}),after=await fs.readFile(f.patch,'utf8');
  assert(after.startsWith(f.originalPatch));assert.equal(result.readyForProjects,false);
  const pkg=JSON.parse(await fs.readFile(f.packageFile));assert.equal(pkg.dependencies['user-plugin'],'1.2.3');assert.equal(pkg.userSetting,'preserve');
  assert.equal(pkg.dependencies['dsh-foreman-next'],'file:'+f.release.replaceAll('\\','/'));
  const rows=yaml.parse(after).flatMap(r=>r.insert??[r]);assert.equal(rows.filter(r=>r.id==='foreman-next-host').length,1);assert.equal(rows.find(r=>r.id==='foreman-next-host').config.dshHome,f.home);
  assert.equal(await fs.readFile(path.join(f.home,'profiles/web/cordis.patch.yml'),'utf8'),'old web untouched');
  assert.equal(await fs.readFile(path.join(f.home,'sessions/user.jsonl'),'utf8'),'user session');
  const repeat=await planDesktopRc2(f);assert.deepEqual(repeat.change.appendProfileRows,[]);
  await rollbackDesktopRc2(result.receipt,options);
  assert.equal(await fs.readFile(f.patch,'utf8'),f.originalPatch);assert.equal(await fs.readFile(f.packageFile,'utf8'),f.originalPackage);
  if(installed)assert.equal(await fs.readFile(path.join(f.moduleRoot,'old.mjs'),'utf8'),'old package');else await assert.rejects(fs.stat(f.moduleRoot),{code:'ENOENT'});
},{installed}));
test('Desktop first installation supports an absent user patch and restores its absence',()=>withFixture(async f=>{
  const result=await upgradeDesktopRc2({...f,...options});assert.equal(yaml.parse(await fs.readFile(f.patch,'utf8')).length,1);
  await rollbackDesktopRc2(result.receipt,options);await assert.rejects(fs.stat(f.patch),{code:'ENOENT'});
},{missingPatch:true}));
test('Desktop preserves and extends a JSON or flow YAML patch without mixing document styles',()=>withFixture(async f=>{
  const before=JSON.stringify([{insert:[{id:'user-plugin',name:'user-plugin',config:{bracket:']'}}]}],null,2)+'\n';
  await fs.writeFile(f.patch,before);const result=await upgradeDesktopRc2({...f,...options});
  const after=JSON.parse(await fs.readFile(f.patch,'utf8'));assert.equal(after[0].insert[0].config.bracket,']');assert.equal(after.length,2);
  await rollbackDesktopRc2(result.receipt,options);assert.equal(await fs.readFile(f.patch,'utf8'),before);
}));
test('Desktop late upgrade failure restores both files and original package',()=>withFixture(async f=>{
  await assert.rejects(upgradeDesktopRc2({...f,...options,afterProfileCommit:async()=>{throw Error('receipt failure');}}),/receipt failure/);
  assert.equal(await fs.readFile(f.patch,'utf8'),f.originalPatch);assert.equal(await fs.readFile(f.packageFile,'utf8'),f.originalPackage);
  assert.equal(await fs.readFile(path.join(f.moduleRoot,'old.mjs'),'utf8'),'old package');
},{installed:true}));
test('Desktop rejects concurrent edits, active profile lock and stale host home',()=>withFixture(async f=>{
  let calls=0;await assert.rejects(upgradeDesktopRc2({...f,...options,assertStopped:async()=>{if(++calls===1)await fs.appendFile(f.patch,'# concurrent edit\n');}}),/profile changed/);
  await fs.writeFile(path.join(f.profileDir,'lock'),String(process.pid));await assert.rejects(upgradeDesktopRc2({...f,...options}),{code:'EEXIST'});await fs.unlink(path.join(f.profileDir,'lock'));
  await fs.writeFile(f.patch,yaml.stringify([{insert:[{id:'foreman-next-host',name:'dsh-foreman-next',config:{dshHome:'C:/example/dsh/home',storageRoot:'C:/example/dsh/home/storages/foreman-next'}}]}]));
  await assert.rejects(planDesktopRc2(f),/paths or gate need manual review/);
}));
test('Desktop rollback preserves later package.json edits and recovers on precommit failure',()=>withFixture(async f=>{
  const result=await upgradeDesktopRc2({...f,...options}),afterPackage=await fs.readFile(f.packageFile,'utf8');
  await assert.rejects(rollbackDesktopRc2(result.receipt,{...options,beforeProfileCommit:async()=>{throw Error('rollback failure');}}),/rollback failure/);
  assert.equal(await fs.readFile(f.packageFile,'utf8'),afterPackage);assert.equal(await fs.readFile(path.join(f.moduleRoot,'src/host.mjs'),'utf8'),'export const version="desktop-rc2";\n');
  await fs.appendFile(f.packageFile,'\n');await assert.rejects(rollbackDesktopRc2(result.receipt,options),/profile changed since upgrade/);
  assert.equal(await fs.readFile(f.packageFile,'utf8'),afterPackage+'\n');
}));
test('Desktop refuses linked profile/package directories',()=>withFixture(async f=>{
  const linked=path.join(f.root,'linked');await fs.symlink(f.home,linked,'junction');
  await assert.rejects(planDesktopRc2({...f,home:linked,profileDir:path.join(linked,'profiles/desktop')}),/ordinary directory/);
  await fs.mkdir(path.dirname(f.moduleRoot));await fs.symlink(f.release,f.moduleRoot,'junction');await assert.rejects(planDesktopRc2(f),/ordinary directory/);
}));
test('Desktop rejects foreman hidden in an existing group with a different home',()=>withFixture(async f=>{
  await fs.writeFile(f.patch,yaml.stringify([{insert:[{id:'group',name:'cordis:group',config:[{id:'foreman-next-host',name:'dsh-foreman-next',config:{dshHome:'C:/example/dsh/home',storageRoot:'C:/example/dsh/home/storages/foreman-next'}}]}]}]));
  await assert.rejects(planDesktopRc2(f),/paths or gate need manual review/);
}));
test('Desktop client declares only available modules in the actual installed runtime',async()=>{
  const pkg=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url)));assert.equal(pkg.dsh.client.platform,'web');
  for(const name of pkg.dsh.client.inject){const dep=JSON.parse(await fs.readFile(requireRuntime.resolve(name+'/package.json')));assert.equal(dep.dsh.client.platform,'web');}
  assert(!pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'));
});
test('Desktop process guard blocks Electron shell and fails closed on CIM error',async()=>{
  await assert.rejects(assertNoDesktopHost('D:/isolated/home',{run:async(_exe,args)=>{assert(args.at(-1).includes('DeepSeek Harness.exe'));assert(args.at(-1).includes('catch { exit 1 }'));throw Error('CIM failure');}}),/CIM failure/);
  await assert.rejects(assertNoDesktopHost('D:/isolated/home',{run:async()=>({stdout:'1234\n'})}),/still running/);
});
test('actual desktop runtime admits exact rc.2 peers and rejects untested GA',async()=>{
  const {evaluatePluginCompatibility,loadProfileDirectory}=await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-app-boot')).href);
  const pkg=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url)));
  assert.equal(evaluatePluginCompatibility(pkg,{},'0.2.0-rc.2'),undefined);assert.equal(evaluatePluginCompatibility(pkg,{},'0.1.7-rc.2'),undefined);
  assert(evaluatePluginCompatibility(pkg,{},'0.2.0'));assert(evaluatePluginCompatibility({...pkg,peerDependencies:{'@deepseek-ai/dsh-scope':'^0.1.7-rc.2'}},{},'0.2.0-rc.2'));
  await withFixture(async f=>{
    const p=await planDesktopRc2(f);for(const edit of p.edits)await fs.writeFile(edit.path,edit.after);
    const profile=loadProfileDirectory('desktop-test',f.profileDir,requireRuntime.resolve('@deepseek-ai/dsh/package.json'));
    assert.deepEqual(profile.skippedBundles,[]);assert.equal(profile.layers.length,2);
    assert(profile.patches.some(p=>p.insert?.some(r=>r.id==='preset-foreman-next')));
  });
});
test('actual desktop SlotCore accepts sidebar/main/overlay registration and cleans up',async()=>{
  const {SlotCore}=await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-client-ui-slots')).href);
  const local=createRequire(new URL('../package.json',import.meta.url));
  let client;vm.runInNewContext(await fs.readFile(new URL('../client/index.js',import.meta.url),'utf8'),{AbortController,setTimeout,clearTimeout,window:{__ModuleLoader__:{load:m=>{client=m.factory(name=>name==='react'?local(name):requireRuntime(name));}}}});
  const core=new SlotCore(),disposers=[];const unroot=core.register({name:'root',children:{main:{kind:'keyed',scope:'root'},'sidebar.panellist':{kind:'list',scope:'root'},'shell.overlay':{kind:'list',scope:'root'}}},()=>null);
  client.apply({slots:{inject:(_name,fn)=>fn(),register:(e,c)=>{const dispose=core.register(e,c);disposers.push(dispose);return dispose;}},connection:{rpc:{call:async()=>({ok:true,value:{}})}}});
  assert.equal(core.entriesOfSlot('sidebar.panellist')[0].options.id,'foreman-next');assert.equal(core.entriesOfSlot('main')[0].options.key,'foreman-next');
  for(const dispose of disposers)dispose();assert.equal(core.entriesOfSlot('shell.overlay').length,0);unroot();
});
