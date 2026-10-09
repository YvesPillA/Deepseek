import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openApplication,openHostApplication} from '../src/application.mjs';

const project=(id,workspace)=>({type:'create',id,workspace,objective:'Implement a program',reviewers:[{id:'r',name:'Quality',responsibility:'Behavior',criteria:'Correct'}]});
async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-app-'));
  const config={storageRoot:path.join(root,'journal'),dshHome:path.join(root,'dsh'),sessionRoot:path.join(root,'sessions')};
  const work=path.join(root,'work');
  for(const dir of [config.dshHome,config.sessionRoot,work])await fs.mkdir(dir);
  const app=await openApplication(config);
  return {root,work,config,app,close:async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});}};
}

function nativeServices({probeOutput='foreman-native-probe',mode='windows-job'}={}) {
  const calls=[];
  return {calls,sandbox:{confine:async argv=>{calls.push('confine');return {argv:['trusted-runner',...argv],enforcement:'partial'};}},
    subprocess:{resolveExecutable:async command=>command,selectContainmentMode:()=>mode,spawn:()=>{
      calls.push('spawn');return {done:Promise.resolve({exitCode:0}),waitForExit:async()=>{},terminate:async()=>{},
        collected:{stdout:{readFrom:()=>({text:probeOutput,lossy:false})},stderr:{readFrom:()=>({text:'',lossy:false})}}};
    }}};
}

test('unconfigured application is diagnostics-only and rejects incomplete protection settings',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-app-diag-'));
  const app=await openApplication({storageRoot:root});
  try {
    assert.equal(app.filePipelineConfigured,false);
    await assert.rejects(app.controller.userCommand(project('p',root)),/diagnostics only/);
    assert.equal(app.store.snapshot().revision,0);
    await assert.rejects(openApplication({storageRoot:path.join(root,'other'),dshHome:root}),/Both absolute/);
  } finally {await app.close();await fs.rm(root,{recursive:true,force:true});}
});

test('optional verification assembly checks daemon protections and cleans up a failed startup',async()=>{
  const f=await fixture();await f.app.close();
  const verification={executable:process.execPath,image:'sha256:'+'a'.repeat(64)};let app;
  try {
    await assert.rejects(openApplication({...f.config,verification},{runCli:async()=>({exitCode:1,stdout:'',stderr:'Cannot connect'})}),/engine is unavailable/);
    await assert.rejects(openApplication({...f.config,verification},{runCli:async()=>({exitCode:0,stdout:JSON.stringify({OSType:'windows'})})}),/Linux resource/);
    app=await openApplication({...f.config,verification},{runCli:async args=>{
      assert.equal(args[0],'info');return {exitCode:0,stdout:JSON.stringify({OSType:'linux',MemoryLimit:true,PidsLimit:true,CpuCfsQuota:true,SecurityOptions:['name=seccomp,profile=builtin']})};
    }});
    assert(app.verification);const closing=app.close();assert.equal(app.close(),closing);await closing;
    await assert.rejects(app.verification.run({id:'fake'},{command:'node',args:[]}),/closed/);
  } finally {await app?.close();await f.close();}
});

test('desktop host remains diagnostics-only when Docker is down; invalid protections still fail',async()=>{
  const f=await fixture();await f.app.close();let app;
  const config={...f.config,verification:{executable:process.execPath,image:'sha256:'+'a'.repeat(64)}};
  try {
    app=await openHostApplication(config,{runCli:async()=>({exitCode:1,stdout:'',stderr:'Unavailable'})});
    assert.equal(app.verification,undefined);assert(app.startupIssue.includes('Docker'));assert(app.filePipelineConfigured);
    await app.close();
    await assert.rejects(openHostApplication(config,{runCli:async()=>({exitCode:0,stdout:JSON.stringify({OSType:'windows'})})}),/Linux resource/);
  }finally{await app?.close();await f.close();}
});

test('native assembly probes DSH services without Docker or dependency-image configuration',async()=>{
  const f=await fixture();await f.app.close();let app;const native=nativeServices();
  try {
    app=await openApplication({...f.config,verification:{backend:'native'}},{...native,runCli:()=>{throw Error('Docker must not be called');}});
    assert(app.verification);assert.equal(app.verificationBackend,'native');assert.equal(app.verificationCapabilities.enforcement,'partial');
    assert.equal(app.dependencies,undefined);assert.equal(app.provisioner,undefined);assert(native.calls.includes('spawn'));
    assert.deepEqual(app.store.snapshot().verificationContainers??{},{});
    assert.equal(await fs.stat(path.join(f.config.storageRoot,'docker-cli')).then(()=>true,error=>error.code!=='ENOENT'),false);
  } finally {await app?.close();await f.close();}
});

test('native startup rejects missing or weaker services and returns host diagnostics after a failed probe',async()=>{
  const f=await fixture();await f.app.close();let app;
  const config={...f.config,verification:{backend:'native'}};
  try {
    await assert.rejects(openApplication(config),error=>error.code==='NATIVE_VERIFICATION_UNAVAILABLE');
    await assert.rejects(openApplication(config,nativeServices({mode:'fallback'})),error=>error.code==='NATIVE_VERIFICATION_UNAVAILABLE');
    app=await openHostApplication(config,nativeServices({probeOutput:'wrong marker'}));
    assert.equal(app.verification,undefined);assert.equal(app.verificationBackend,'native');assert(app.startupIssue.includes('本机验证'));
    await app.close();
    await assert.rejects(openHostApplication({...config,verification:{backend:'native',image:'sha256:'+'a'.repeat(64)}},nativeServices()),/does not accept Docker/);
    await assert.rejects(openHostApplication({...config,sessionRoot:undefined},nativeServices()),/Both absolute/);
  } finally {await app?.close();await f.close();}
});

test('project reservation is serialized and rejects aliases, nested workspaces and protected storage',async()=>{
  const f=await fixture();try {
    for(const dir of [f.root,f.config.dshHome,f.config.sessionRoot,f.config.storageRoot])
      await assert.rejects(f.app.controller.userCommand(project('blocked',dir)),/protected/);
    const attempts=await Promise.allSettled(['p','q'].map(id=>f.app.controller.userCommand(project(id,f.work))));
    assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
    const alias=path.join(f.root,'alias');await fs.symlink(f.work,alias,'junction');
    await assert.rejects(f.app.controller.userCommand(project('alias',alias)),/overlaps project/);
    const child=path.join(f.work,'child');await fs.mkdir(child);
    await assert.rejects(f.app.controller.userCommand(project('child',child)),/overlaps project/);
    await f.app.controller.userCommand({type:'cancel',project:'p'});
    await assert.rejects(f.app.controller.userCommand(project('reuse',f.work)),/overlaps project/);
    const independent=path.join(f.root,'independent');await fs.mkdir(independent);
    await f.app.controller.userCommand(project('independent',independent));
    assert.equal(Object.keys(f.app.store.snapshot().projects).length,2);
  } finally {await f.close();}
});

test('assembled application captures actual executor output for review and survives reopen',async()=>{
  const f=await fixture();let reopened;
  try {
    const {controller:c,files,artifacts}=f.app;
    await c.userCommand(project('p',f.work));
    const manager={id:'manager'},worker={id:'worker'},reviewer={id:'reviewer'};
    c.bind(manager,{role:'coordinator',project:'p',configVersion:1});c.bind(reviewer,{role:'reviewer',project:'p',reviewer:'r'});
    await c.modelCommand(manager,{type:'propose',definition:{id:'a',title:'Program',criteria:'Correct',deps:[]}});
    const round=Object.values(c.view('p').rounds).at(-1);
    await c.modelCommand(reviewer,{type:'vote',round:round.id,generation:1,pass:true,findings:'Plan matches objective'});
    await c.modelCommand(manager,{type:'task',milestone:'a',id:'t',title:'Write',instructions:'Implement'});
    c.bind(worker,{role:'executor',project:'p',task:'t',configVersion:1,planVersion:1});await c.assign(manager,worker,'t');
    await files.run(worker,{action:'write',path:'app.txt',text:'Delivered source',expectedHash:null});
    await c.modelCommand(worker,{type:'complete',task:'t',result:'Implemented'});
    await c.modelCommand(manager,{type:'submit',milestone:'a'});
    const reference=Object.values(c.view('p').rounds).at(-1).payload.artifact;
    assert.equal((await artifacts.read(reference,'app.txt')).toString(),'Delivered source');
    await f.app.close();
    await assert.rejects(c.userCommand(project('late',f.work)),/closed/);
    assert.throws(()=>c.identity(worker),/identity/);
    reopened=await openApplication(f.config);
    assert.equal(Object.values(reopened.controller.view('p').rounds).at(-1).payload.artifact,reference);
    assert.equal((await reopened.artifacts.read(reference,'app.txt')).toString(),'Delivered source');
  } finally {await reopened?.close();await f.close();}
});
