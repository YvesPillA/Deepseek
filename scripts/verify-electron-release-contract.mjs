// Read-only actual-runtime contract, run with the installed Electron executable
// and ELECTRON_RUN_AS_NODE=1. All approval/plugin/evidence files are disposable
// synthetic fixtures. This does not approve or activate the user's installation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {verifyReleaseApproval,isReleaseApprovalValid} from '../src/release-approval.mjs';
import {readinessSnapshot} from '../src/readiness.mjs';

assert.equal(typeof process.versions.electron,'string','Run this contract through the actual Electron executable');
assert.equal(typeof process.resourcesPath,'string');
const raw=createRequire(import.meta.url)('original-fs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const archive=path.join(process.resourcesPath,'app.asar');
const patched=await fs.lstat(archive),physical=await raw.promises.lstat(archive);
assert(patched.isDirectory(),'This contract must exercise Electron virtual archive behavior');
assert(physical.isFile(),'Actual runtime archive must be a physical ordinary file');
const archiveHash=createHash('sha256');
for await(const chunk of raw.createReadStream(archive))archiveHash.update(chunk);
const asarSha256=archiveHash.digest('hex');
// Pinned independent installation evidence from PROGRESS.md. These values are
// not inferred from the receipt or extracted runtime; the verifier reads ASAR.
assert.equal(asarSha256,'983ca71114e6dfd353fc79af5a1f9481a250ee64c2a3c757673029b811b23bc2');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-electron-readonly-'));
try {
  const storageRoot=path.join(root,'storage'),pluginRoot=path.join(root,'plugin');
  await fs.mkdir(storageRoot);await fs.mkdir(pluginRoot);
  const manifest={name:'dsh-foreman-next-contract-fixture',version:'0.0.0-fixture',files:[]};
  const manifestBytes=Buffer.from(JSON.stringify(manifest));
  await fs.writeFile(path.join(pluginRoot,'package.json'),manifestBytes);
  const evidence={};
  for(const kind of ['desktopUI','recovery','projectFinal','regression']) {
    const data=Buffer.from('Synthetic contract fixture only: '+kind),file=path.join(storageRoot,kind+'.txt');
    await fs.writeFile(file,data);evidence[kind]={path:file,sha256:hash(data)};
  }
  const verificationImage='sha256:'+'b'.repeat(64),approvalPath=path.join(storageRoot,'synthetic-contract-approval.json');
  const record={version:1,approved:true,runtime:{version:'0.2.0-rc.2',buildCommit:'04f392c9ddd144fa426da2045178797da6db6c11',asarSha256},
    plugin:{name:manifest.name,version:manifest.version,manifestSha256:hash(manifestBytes),files:[{path:'package.json',sha256:hash(manifestBytes)}]},verificationImage,evidence};
  await fs.writeFile(approvalPath,JSON.stringify(record));
  const input={approvalPath,storageRoot,verificationImage};
  const results={};
  for(const backend of ['docker','native']) {
  if(backend==='native') {
    record.version=2;delete record.verificationImage;
    record.verification={backend:'native',platform:'win32',sandbox:'windows-acl'};
    input.verificationBackend='native';delete input.verificationImage;
    await fs.writeFile(approvalPath,JSON.stringify(record));
  }
  // No runtime override: only the actual process supplies resourcesPath.
  const result=await verifyReleaseApproval(input,{pluginRoot});
  assert.equal(result.valid,true,JSON.stringify(result));assert(isReleaseApprovalValid(result));
  const assembled={releaseApproval:result,application:{filePipelineConfigured:true,verification:{}},
    scheduler:{status:()=>({started:true,closed:false,running:false})},sessionContext:{sessionPersistence:{open(){},flush(){}}},
    userControl:{},dashboardConnected:true,agentOptions:{provider:'contract-fixture',model:'contract-fixture'}};
  assert.equal(readinessSnapshot(assembled).readyForProjects,true);
  assert.equal(readinessSnapshot({...assembled,releaseApproval:{valid:true}}).readyForProjects,false);
  const wrongBackend=await verifyReleaseApproval({...input,verificationBackend:backend==='native'?'docker':'native',verificationImage},{pluginRoot});
  assert.equal(wrongBackend.valid,false,'Docker and native approvals must not substitute for one another');
  await fs.appendFile(evidence.regression.path,'tamper');
  assert.equal(isReleaseApprovalValid(result),false);
  assert.equal(readinessSnapshot(assembled).readyForProjects,false);
  const tampered=await verifyReleaseApproval(input,{pluginRoot});
  assert.equal(tampered.valid,false);assert.match(tampered.blockers[0].message,/evidence hash mismatch/);
  results[backend]={defaultRuntimePositive:true,brandedFixtureReadiness:true,evidenceTamperClosed:true,backendMismatchClosed:true};
  await fs.writeFile(evidence.regression.path,'Synthetic contract fixture only: regression');
  }
  console.log(JSON.stringify({contract:'actual-electron-read-only-synthetic-approval',passed:true,
    electron:process.versions.electron,node:process.versions.node,execPath:process.execPath,resourcesPath:process.resourcesPath,
    asarSha256,archiveBytes:physical.size,patchedArchiveIsDirectory:patched.isDirectory(),rawArchiveIsFile:physical.isFile(),
    backends:results,userInstallationApproved:false},null,2));
} finally {await fs.rm(root,{recursive:true,force:true});}
