import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {verifyReleaseApproval,isReleaseApprovalValid} from '../src/release-approval.mjs';
import {readinessSnapshot} from '../src/readiness.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const archiveFs=process.versions.electron?createRequire(import.meta.url)('original-fs').promises:fs;
async function fixture(t,backend='docker') {
  if(process.versions.electron)assert(process.env.ELECTRON_RELEASE_TEST_TEMP,'Use scripts/test-electron-release-approval.mjs so cleanup runs after Electron releases ASAR handles');
  const root=await fs.mkdtemp(path.join(process.env.ELECTRON_RELEASE_TEST_TEMP??os.tmpdir(),'foreman-release-'));
  // Electron keeps mounted fixture archive handles open until process exit.
  // The Node parent runner removes only its own temp root after child exit.
  if(!process.versions.electron)t.after(()=>archiveFs.rm(root,{recursive:true,force:true}));
  const storageRoot=path.join(root,'storage'),dshHome=path.join(root,'home'),resourcesPath=path.join(root,'resources'),pluginRoot=path.join(root,'plugin');
  for(const dir of [storageRoot,dshHome,resourcesPath,pluginRoot])await fs.mkdir(dir);
  const appPackage={version:'0.2.0-rc.2',dshBuildCommit:'a'.repeat(40)};
  const payload=Buffer.from(JSON.stringify(appPackage)),header=Buffer.from(JSON.stringify({files:{'package.json':{size:payload.length,offset:'0'}}}));
  // A real ASAR header uses aligned Chromium Pickle payloads. Electron must
  // actually mount this fixture, so a Node-only byte layout cannot mask bugs.
  const paddedHeader=Buffer.alloc(Math.ceil(header.length/4)*4);header.copy(paddedHeader);
  const prefix=Buffer.alloc(16);prefix.writeUInt32LE(4,0);prefix.writeUInt32LE(8+paddedHeader.length,4);prefix.writeUInt32LE(4+paddedHeader.length,8);prefix.writeUInt32LE(header.length,12);
  const archive=Buffer.concat([prefix,paddedHeader,payload]);await archiveFs.writeFile(path.join(resourcesPath,'app.asar'),archive);
  const manifest={name:'dsh-foreman-next',version:'0.1.0',files:['src','client','presets','README.md']},manifestBytes=Buffer.from(JSON.stringify(manifest));
  const files={'package.json':manifestBytes,'src/host.mjs':Buffer.from('host code'),'client/index.js':Buffer.from('client code'),'presets/preset.yml':Buffer.from('preset config'),'README.md':Buffer.from('release docs')};
  for(const [name,data] of Object.entries(files)) {await fs.mkdir(path.dirname(path.join(pluginRoot,name)),{recursive:true});await fs.writeFile(path.join(pluginRoot,name),data);}
  const evidence={};
  for(const kind of ['desktopUI','recovery','projectFinal','regression']) {
    const file=path.join(storageRoot,kind+'.md'),data=Buffer.from(kind+' approved fixture evidence');
    await fs.writeFile(file,data);evidence[kind]={path:file,sha256:hash(data)};
  }
  const approvalPath=path.join(storageRoot,'release-approval.json'),verificationImage='sha256:'+'b'.repeat(64);
  const record={version:1,approved:true,runtime:{version:appPackage.version,buildCommit:appPackage.dshBuildCommit,asarSha256:hash(archive)},
    plugin:{name:manifest.name,version:manifest.version,manifestSha256:hash(manifestBytes),files:Object.entries(files).map(([name,data])=>({path:name,sha256:hash(data)}))},verificationImage,evidence};
  const input={approvalPath,storageRoot,dshHome,verificationImage},trusted={pluginRoot,runtime:()=>({resourcesPath,electron:'44.0.0'})};
  if(backend==='native') {
    input.verificationBackend='native';delete input.verificationImage;
    record.version=2;delete record.verificationImage;
    record.verification={backend:'native',platform:'win32',sandbox:'windows-acl'};
  }
  const write=()=>fs.writeFile(approvalPath,JSON.stringify(record));await write();
  return {root,input,trusted,record,write,pluginRoot,resourcesPath,storageRoot,verify:()=>verifyReleaseApproval(input,trusted)};
}
const assembled=releaseApproval=>({releaseApproval,application:{filePipelineConfigured:true,verification:{}},
  scheduler:{status:()=>({started:true,closed:false,running:false})},sessionContext:{sessionPersistence:{open(){},flush(){}}},
  userControl:{},dashboardConnected:true,agentOptions:{provider:'test-provider',model:'test-model'}});

test('host approval opens only a fully assembled gate and cannot be self-reported',async t=>{
  const f=await fixture(t),approval=await f.verify();assert.equal(approval.valid,true,JSON.stringify(approval));
  if(process.versions.electron) {
    assert.equal((await fs.lstat(path.join(f.resourcesPath,'app.asar'))).isDirectory(),true,'Electron mounts the legal fixture archive');
    assert.equal((await archiveFs.lstat(path.join(f.resourcesPath,'app.asar'))).isFile(),true,'original-fs observes the physical archive');
    assert.equal(JSON.parse(await fs.readFile(path.join(f.resourcesPath,'app.asar','package.json'),'utf8')).version,f.record.runtime.version);
  }
  assert(isReleaseApprovalValid(approval));assert(Object.isFrozen(approval));
  assert.equal(readinessSnapshot(assembled(approval)).readyForProjects,true);
  const missing=assembled(approval);missing.application.verification=undefined;
  assert.equal(readinessSnapshot(missing).readyForProjects,false);assert.equal(readinessSnapshot(missing).blockers[0].id,'verification');
  assert.equal(readinessSnapshot(assembled({valid:true,approved:true})).readyForProjects,false);
  assert.equal(readinessSnapshot(assembled(undefined)).readyForProjects,false);
  await fs.writeFile(path.join(f.storageRoot,'unrelated-journal.json'),'new journal state');
  assert(isReleaseApprovalValid(approval),'unrelated host writes must not invalidate acceptance');
});

test('missing, unapproved, malformed or incomplete acceptance records fail closed',async t=>{
  for(const variant of ['missing','declined','malformed','missing-evidence','bad-schema']) {
    const f=await fixture(t);
    if(variant==='missing')await fs.unlink(f.input.approvalPath);
    if(variant==='declined'){f.record.approved=false;await f.write();}
    if(variant==='malformed')await fs.writeFile(f.input.approvalPath,'{');
    if(variant==='missing-evidence'){delete f.record.evidence.recovery;await f.write();}
    if(variant==='bad-schema'){f.record.archivePath=path.join(f.resourcesPath,'app.asar');await f.write();}
    const value=await f.verify();assert.equal(value.valid,false,variant);assert(!isReleaseApprovalValid(value));
  }
});

test('archive, metadata, installed inventory, image and each acceptance hash are bound',async t=>{
  for(const backend of ['docker','native']) {
  for(const variant of ['archive','archive-bytes','version','build','manifest','plugin-name','plugin-file','added-file','missing-file','duplicate-file','unsafe-file','image','desktopUI','recovery','projectFinal','regression']) {
    const f=await fixture(t,backend);
    if(variant==='archive')f.record.runtime.asarSha256='c'.repeat(64);
    if(variant==='archive-bytes')await archiveFs.appendFile(path.join(f.resourcesPath,'app.asar'),'tampered raw bytes');
    if(variant==='version')f.record.runtime.version='0.1.7-rc.2';
    if(variant==='build')f.record.runtime.buildCommit='c'.repeat(40);
    if(variant==='manifest')f.record.plugin.manifestSha256='c'.repeat(64);
    if(variant==='plugin-name')f.record.plugin.name='other-plugin';
    if(variant==='plugin-file')await fs.writeFile(path.join(f.pluginRoot,'src/host.mjs'),'modified code');
    if(variant==='added-file')await fs.writeFile(path.join(f.pluginRoot,'src/extra.mjs'),'unapproved code');
    if(variant==='missing-file')f.record.plugin.files.pop();
    if(variant==='duplicate-file')f.record.plugin.files.push({...f.record.plugin.files[0]});
    if(variant==='unsafe-file')f.record.plugin.files[0].path='../outside';
    if(variant==='image')f.record.verificationImage='sha256:'+'c'.repeat(64);
    if(Object.hasOwn(f.record.evidence,variant))f.record.evidence[variant].sha256='c'.repeat(64);
    await f.write();assert.equal((await f.verify()).valid,false,variant);
  }
  }
});

test('native v2 has its own host identity and cannot substitute for Docker v1 approval',async t=>{
  const docker=await fixture(t),native=await fixture(t,'native');
  const value=await native.verify();assert.equal(value.valid,true,JSON.stringify(value));assert(isReleaseApprovalValid(value));
  assert.equal(readinessSnapshot(assembled(value)).readyForProjects,true);
  assert.equal((await verifyReleaseApproval({...docker.input,verificationBackend:'native'},docker.trusted)).valid,false);
  assert.equal((await verifyReleaseApproval({...native.input,verificationBackend:'docker',verificationImage:docker.input.verificationImage},native.trusted)).valid,false);
  assert.equal((await verifyReleaseApproval({...native.input,verificationBackend:undefined},native.trusted)).valid,false,'unspecified backend remains Docker');
  assert.equal((await verifyReleaseApproval({...docker.input,verificationBackend:'docker'},docker.trusted)).valid,true,'explicit Docker supports historical v1');
  assert.equal((await verifyReleaseApproval({...native.input,verificationBackend:'other'},native.trusted)).valid,false);
  for(const variant of ['backend','platform','sandbox','missing','extra','declined','version','image']) {
    const f=await fixture(t,'native');
    if(['backend','platform','sandbox'].includes(variant))f.record.verification[variant]='incorrect';
    if(variant==='missing')delete f.record.verification.sandbox;
    if(variant==='extra')f.record.verification.image=docker.input.verificationImage;
    if(variant==='declined')f.record.approved=false;
    if(variant==='version')f.record.version=1;
    if(variant==='image')f.record.verificationImage=docker.input.verificationImage;
    await f.write();assert.equal((await f.verify()).valid,false,variant);
  }
});

test('CLI/Web cannot use a receipt archive path to impersonate Electron',async t=>{
  const f=await fixture(t);
  const noElectron=await verifyReleaseApproval(f.input,{pluginRoot:f.pluginRoot,runtime:()=>({resourcesPath:f.resourcesPath})});
  assert.equal(noElectron.valid,false);assert.match(noElectron.blockers[0].message,/actual Electron/);
  const noResources=await verifyReleaseApproval(f.input,{pluginRoot:f.pluginRoot,runtime:()=>({electron:'44.0.0'})});
  assert.equal(noResources.valid,false);
  assert.equal((await verifyReleaseApproval({...f.input,archivePath:path.join(f.resourcesPath,'app.asar')},{pluginRoot:f.pluginRoot,runtime:()=>({})})).valid,false);
});

test('approval and evidence require protected absolute paths without links',async t=>{
  const f=await fixture(t),outside=path.join(f.root,'outside.json');await fs.copyFile(f.input.approvalPath,outside);
  assert.equal((await verifyReleaseApproval({...f.input,approvalPath:outside},f.trusted)).valid,false);
  assert.equal((await verifyReleaseApproval({...f.input,approvalPath:'release-approval.json'},f.trusted)).valid,false);
  f.record.evidence.recovery.path=outside;f.record.evidence.recovery.sha256=hash(await fs.readFile(outside));await f.write();
  assert.equal((await f.verify()).valid,false);
  const other=await fixture(t),alias=path.join(other.storageRoot,'alias');
  await fs.symlink(other.resourcesPath,alias,process.platform==='win32'?'junction':'dir');
  await fs.copyFile(other.input.approvalPath,path.join(other.resourcesPath,'receipt.json'));
  assert.equal((await verifyReleaseApproval({...other.input,approvalPath:path.join(alias,'receipt.json')},other.trusted)).valid,false);
  const pluginAlias=path.join(other.root,'plugin-alias');await fs.symlink(other.pluginRoot,pluginAlias,process.platform==='win32'?'junction':'dir');
  assert.equal((await verifyReleaseApproval(other.input,{...other.trusted,pluginRoot:pluginAlias})).valid,false);
  const linked=await fixture(t),evidence=linked.record.evidence.regression.path;
  await fs.link(evidence,path.join(linked.storageRoot,'hard-linked-report.md'));
  assert.equal((await linked.verify()).valid,false,'hard-linked acceptance evidence is rejected');
  const runtimeAlias=path.join(other.root,'runtime-alias');await fs.symlink(other.resourcesPath,runtimeAlias,process.platform==='win32'?'junction':'dir');
  assert.equal((await verifyReleaseApproval(other.input,{...other.trusted,runtime:()=>({resourcesPath:runtimeAlias,electron:'44.0.0'})})).valid,false,'runtime resources junction is rejected');
  const linkedArchive=await fixture(t);await archiveFs.link(path.join(linkedArchive.resourcesPath,'app.asar'),path.join(linkedArchive.root,'archive-copy'));
  assert.equal((await linkedArchive.verify()).valid,false,'physical runtime archive hardlink is rejected');
});

test('protected records and plugin roots cannot enter Electron virtual archives',async t=>{
  const f=await fixture(t),virtual=path.join(f.resourcesPath,'app.asar'),input={...f.input,dshHome:f.resourcesPath};
  const attempts=[
    verifyReleaseApproval({...input,approvalPath:path.join(virtual,'package.json')},f.trusted),
    verifyReleaseApproval({...input,dshHome:virtual},f.trusted),
    verifyReleaseApproval(input,{...f.trusted,pluginRoot:virtual}),
  ];
  for(const pending of attempts) {
    const value=await pending;assert.equal(value.valid,false);
    if(process.versions.electron)assert.match(value.blockers[0].message,/cannot use Electron virtual archives/);
  }
  f.record.evidence.projectFinal.path=path.join(virtual,'package.json');await f.write();
  const value=await verifyReleaseApproval(input,f.trusted);assert.equal(value.valid,false);
  if(process.versions.electron)assert.match(value.blockers[0].message,/cannot use Electron virtual archives/);
});

test('cached acceptance revokes after target/evidence changes without rehashing the archive',async t=>{
  for(const backend of ['docker','native']) {
  for(const kind of ['approval','archive','plugin','evidence','inventory']) {
    const f=await fixture(t,backend),value=await f.verify();assert(isReleaseApprovalValid(value));
    if(kind==='approval')await fs.writeFile(f.input.approvalPath,'{}');
    if(kind==='archive') {
      const archive=path.join(f.resourcesPath,'app.asar');
      const virtualBefore=process.versions.electron?await fs.lstat(archive):undefined;
      await archiveFs.appendFile(archive,'changed');
      if(virtualBefore) {
        const virtualAfter=await fs.lstat(archive);
        assert.equal(virtualAfter.isDirectory(),true);
        assert.equal(virtualAfter.size,virtualBefore.size,'patched archive stats hide the raw byte-size change');
        assert.equal((await archiveFs.lstat(archive)).size>virtualBefore.size,true);
      }
    }
    if(kind==='plugin')await fs.appendFile(path.join(f.pluginRoot,'client/index.js'),'changed');
    if(kind==='evidence')await fs.appendFile(f.record.evidence.projectFinal.path,'changed');
    if(kind==='inventory')await fs.writeFile(path.join(f.pluginRoot,'src/extra.mjs'),'added');
    assert.equal(isReleaseApprovalValid(value),false,kind);
    assert.equal(readinessSnapshot(assembled(value)).readyForProjects,false,kind);
    await f.write();assert.equal(isReleaseApprovalValid(value),false,'revoked objects stay revoked');
  }
  }
});
