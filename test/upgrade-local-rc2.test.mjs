import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {assertNoDshNode,planRc2,upgradeRc2,rollbackRc2} from '../scripts/upgrade-local-rc2.mjs';

const yaml=createRequire('C:/example/dsh/node/node_modules/@deepseek-ai/dsh/package.json')('yaml');
const hash=b=>createHash('sha256').update(b).digest('hex');
const stopped=async()=>{};
const guard=async()=>({close(){}});
test('stopped-host check fails closed on process inventory errors or a running DSH Node',async()=>{
  await assert.rejects(assertNoDshNode('C:\\example\\dsh\\home',{run:async(_exe,args)=>{
    assert(args.at(-1).includes('$ErrorActionPreference = "Stop"'));
    assert(args.at(-1).includes('catch { exit 1 }'));
    throw Error('CIM inventory failed');
  }}),/CIM inventory failed/);
  await assert.rejects(assertNoDshNode('C:\\example\\dsh\\home',{run:async()=>({stdout:'4321\n'})}),/DSH Node process is still running/);
});
async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-rc2-upgrade-'));
  const home=path.join(root,'home'),release=path.join(root,'release');
  const moduleRoot=path.join(home,'profiles/node_modules/dsh-foreman-next');
  const patch=path.join(home,'profiles/web/cordis.patch.yml');
  await fs.mkdir(path.dirname(patch),{recursive:true});
  await fs.mkdir(moduleRoot,{recursive:true});
  await fs.mkdir(path.join(home,'storages/foreman-next'),{recursive:true});
  await fs.mkdir(path.join(home,'sessions'),{recursive:true});
  await fs.mkdir(path.join(home,'.agent-presets/other-mode'),{recursive:true});
  await fs.writeFile(path.join(home,'.agent-presets/other-mode/preset.yml'),'name: Other mode\n');
  await fs.writeFile(path.join(home,'sessions/keep.jsonl'),'session stays');
  await fs.writeFile(path.join(home,'storages/foreman-next/state.jsonl'),'journal stays');
  await fs.writeFile(path.join(moduleRoot,'old.mjs'),'old plugin');
  const original=`# Personal profile; no deleted plugins restored\n- insert:\n    - id: foreman-next-host\n      name: dsh-foreman-next\n      config:\n        dshHome: ${home.replaceAll('\\','/')}\n        storageRoot: ${path.join(home,'storages/foreman-next').replaceAll('\\','/')}\n        sessionRoot: ${path.join(home,'sessions').replaceAll('\\','/')}\n- id: unrelated\n  config:\n    secret: placeholder-never-log\n`;
  await fs.writeFile(patch,original);
  await fs.mkdir(path.join(release,'presets/foreman-next'),{recursive:true});
  await fs.mkdir(path.join(release,'src'),{recursive:true});
  const releaseData={
    'package.json':JSON.stringify({name:'dsh-foreman-next',peerDependencies:{'@deepseek-ai/dsh-scope':'^0.1.7-rc.2'}}),
    'src/host.mjs':'export const version="rc2";\n',
    'src/readiness.mjs':'export const state={readyForProjects:false};\n',
    'presets/foreman-next/preset.yml':'name: 新工头模式\ndescription: 测试描述\norder: 40\n',
    'presets/foreman-next/agent.cordis.yml':'- id: foreman-next-outer\n  name: dsh-foreman-next/outer\n',
  };
  for(const [relative,data] of Object.entries(releaseData))await fs.writeFile(path.join(release,relative),data);
  await fs.writeFile(path.join(release,'release-manifest.json'),JSON.stringify({name:'dsh-foreman-next',version:'0.1.0',installed:false,readyForProjects:false,
    files:Object.entries(releaseData).map(([relative,data])=>({path:relative,sha256:hash(data)}))}));
  return {root,home,release,moduleRoot,patch,original};
}
test('rc.2 upgrade replaces only foreman package, appends preset and rolls back',async()=>{
  const f=await fixture();
  try {
    const plan=await planRc2(f);
    assert.deepEqual(plan.change.removeOldPackageFiles,['old.mjs']);
    assert.equal(await fs.readFile(f.patch,'utf8'),f.original);
    const result=await upgradeRc2({...f,assertStopped:stopped,acquireGuard:guard});
    const after=await fs.readFile(f.patch,'utf8');
    assert(after.startsWith(f.original));
    assert(after.includes('secret: placeholder-never-log'));
    const rows=yaml.parse(after).flatMap(r=>r.insert||[r]);
    assert.equal(rows.filter(r=>r.id==='foreman-next-host').length,1);
    assert.equal(rows.filter(r=>r.id==='preset-foreman-next').length,1);
    assert.deepEqual(rows.at(-1).config.plugins,[{id:'foreman-next-outer',name:'dsh-foreman-next/outer'}]);
    assert.equal(await fs.readFile(path.join(f.moduleRoot,'src/host.mjs'),'utf8'),'export const version="rc2";\n');
    await assert.rejects(fs.stat(path.join(f.moduleRoot,'old.mjs')),{code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(f.home,'sessions/keep.jsonl'),'utf8'),'session stays');
    assert.equal(await fs.readFile(path.join(f.home,'storages/foreman-next/state.jsonl'),'utf8'),'journal stays');
    assert.equal(await fs.readFile(path.join(f.home,'.agent-presets/other-mode/preset.yml'),'utf8'),'name: Other mode\n');
    await rollbackRc2(result.receipt,{assertStopped:stopped,acquireGuard:guard});
    assert.equal(await fs.readFile(f.patch,'utf8'),f.original);
    assert.equal(await fs.readFile(path.join(f.moduleRoot,'old.mjs'),'utf8'),'old plugin');
    await assert.rejects(fs.stat(path.join(f.moduleRoot,'src/host.mjs')),{code:'ENOENT'});
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('rc.2 upgrade refuses profile edits during preflight',async()=>{
  const f=await fixture();
  try {
    let calls=0;
    await assert.rejects(upgradeRc2({...f,assertStopped:async()=>{if(++calls===1)await fs.appendFile(f.patch,'# concurrent edit\n');},acquireGuard:guard}),/Profile changed after planning/);
    assert.equal(await fs.readFile(path.join(f.moduleRoot,'old.mjs'),'utf8'),'old plugin');
    assert((await fs.readFile(f.patch,'utf8')).endsWith('# concurrent edit\n'));
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('rc.2 upgrade refuses installed-package edits during preflight',async()=>{
  const f=await fixture();
  try {
    let calls=0;
    await assert.rejects(upgradeRc2({...f,assertStopped:async()=>{if(++calls===1)await fs.appendFile(path.join(f.moduleRoot,'old.mjs'),' edited');},acquireGuard:guard}),/Installed package changed after planning/);
    assert.equal(await fs.readFile(f.patch,'utf8'),f.original);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('rc.2 upgrade restores original package and profile after a late commit failure',async()=>{
  const f=await fixture();
  try {
    await assert.rejects(upgradeRc2({...f,assertStopped:stopped,acquireGuard:guard,
      afterProfileCommit:async()=>{throw Error('simulated receipt failure');}}),/simulated receipt failure/);
    assert.equal(await fs.readFile(f.patch,'utf8'),f.original);
    assert.equal(await fs.readFile(path.join(f.moduleRoot,'old.mjs'),'utf8'),'old plugin');
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('rc.2 upgrade retains new package if profile recovery fails',async()=>{
  const f=await fixture();
  try {
    await assert.rejects(upgradeRc2({...f,assertStopped:stopped,acquireGuard:guard,
      afterProfileCommit:async()=>{throw Error('simulated receipt failure');},
      restoreProfile:async()=>{throw Error('simulated profile recovery failure');}}),/Upgrade interrupted/);
    assert((await fs.readFile(f.patch,'utf8')).includes('preset-foreman-next'));
    assert.equal(await fs.readFile(path.join(f.moduleRoot,'src/host.mjs'),'utf8'),'export const version="rc2";\n');
    const backupRoot=path.join(f.home,'.foreman-next-upgrades');
    const [backupName]=await fs.readdir(backupRoot);
    assert.equal(await fs.readFile(path.join(backupRoot,backupName,'old-plugin/old.mjs'),'utf8'),'old plugin');
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('rc.2 rollback refuses later user edits',async()=>{
  const f=await fixture();
  try {
    const result=await upgradeRc2({...f,assertStopped:stopped,acquireGuard:guard});
    await fs.appendFile(f.patch,'# later user edit\n');
    await assert.rejects(rollbackRc2(result.receipt,{assertStopped:stopped,acquireGuard:guard}),/Profile changed since upgrade/);
    assert((await fs.readFile(f.patch,'utf8')).endsWith('# later user edit\n'));
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('rc.2 rollback recovers both packages when profile commit fails',async()=>{
  const f=await fixture();
  try {
    const result=await upgradeRc2({...f,assertStopped:stopped,acquireGuard:guard});
    const upgraded=await fs.readFile(f.patch,'utf8');
    await assert.rejects(rollbackRc2(result.receipt,{assertStopped:stopped,acquireGuard:guard,
      beforeProfileCommit:async()=>{throw Error('simulated profile commit failure');}}),/simulated profile commit failure/);
    assert.equal(await fs.readFile(f.patch,'utf8'),upgraded);
    assert.equal(await fs.readFile(path.join(f.moduleRoot,'src/host.mjs'),'utf8'),'export const version="rc2";\n');
    assert.equal(await fs.readFile(path.join(result.backup,'old-plugin/old.mjs'),'utf8'),'old plugin');
    await rollbackRc2(result.receipt,{assertStopped:stopped,acquireGuard:guard});
    assert.equal(await fs.readFile(f.patch,'utf8'),f.original);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('rc.2 rollback preserves a concurrent profile edit and restores the upgraded package',async()=>{
  const f=await fixture();
  try {
    const result=await upgradeRc2({...f,assertStopped:stopped,acquireGuard:guard});
    await assert.rejects(rollbackRc2(result.receipt,{assertStopped:stopped,acquireGuard:guard,
      beforeProfileCommit:async()=>{await fs.appendFile(f.patch,'# concurrent user edit\n');}}),/Profile changed during rollback/);
    assert((await fs.readFile(f.patch,'utf8')).endsWith('# concurrent user edit\n'));
    assert.equal(await fs.readFile(path.join(f.moduleRoot,'src/host.mjs'),'utf8'),'export const version="rc2";\n');
    assert.equal(await fs.readFile(path.join(result.backup,'old-plugin/old.mjs'),'utf8'),'old plugin');
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('rc.2 rollback rejects a linked old-package backup directory',async()=>{
  const f=await fixture();
  try {
    const result=await upgradeRc2({...f,assertStopped:stopped,acquireGuard:guard});
    const old=path.join(result.backup,'old-plugin');
    await fs.mkdir(path.join(old,'nested'));
    await fs.symlink(path.join(f.home,'sessions'),path.join(old,'nested','linked'),'junction');
    await assert.rejects(rollbackRc2(result.receipt,{assertStopped:stopped,acquireGuard:guard}),/Linked or special package entry/);
    assert.equal(await fs.readFile(path.join(f.moduleRoot,'src/host.mjs'),'utf8'),'export const version="rc2";\n');
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('rc.2 plan refuses linked release and installed-package directories',async()=>{
  const f=await fixture();
  try {
    const linkedRelease=path.join(f.root,'release-link');
    await fs.symlink(f.release,linkedRelease,'junction');
    await assert.rejects(planRc2({...f,release:linkedRelease}),/Expected ordinary directory/);
    await fs.mkdir(path.join(f.moduleRoot,'nested'));
    await fs.symlink(path.join(f.home,'sessions'),path.join(f.moduleRoot,'nested','linked'),'junction');
    await assert.rejects(planRc2(f),/Linked or special package entry/);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
if(process.env.FOREMAN_RC2_RELEASE) test('real staged rc.2 release upgrades and rolls back isolated home',async()=>{
  const f=await fixture();
  try {
    const result=await upgradeRc2({...f,release:process.env.FOREMAN_RC2_RELEASE,assertStopped:stopped});
    const pkg=JSON.parse(await fs.readFile(path.join(f.moduleRoot,'package.json'),'utf8'));
    assert.equal(pkg.name,'dsh-foreman-next');
    assert((await fs.readFile(path.join(f.moduleRoot,'client/index.js'),'utf8')).includes('sidebar.panellist'));
    await rollbackRc2(result.receipt,{assertStopped:stopped});
    assert.equal(await fs.readFile(f.patch,'utf8'),f.original);
    assert.equal(await fs.readFile(path.join(f.moduleRoot,'old.mjs'),'utf8'),'old plugin');
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('rc.2 upgrade rejects a stale preset row and a modified release',async()=>{
  const f=await fixture();
  try {
    await fs.appendFile(f.patch,'- insert:\n    - id: preset-foreman-next\n      name: other\n');
    await assert.rejects(planRc2(f),/Existing foreman preset/);
    await fs.writeFile(f.patch,f.original);
    await fs.appendFile(path.join(f.release,'src/host.mjs'),'tampered');
    await assert.rejects(planRc2(f),/hash mismatch/);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
