import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openApplication} from '../src/application.mjs';
import {UserControl} from '../src/user-control.mjs';
import {npmProfile,DEPENDENCY_LABEL} from '../src/dependency-profile.mjs';
const base='sha256:'+'a'.repeat(64),image='sha256:'+'b'.repeat(64);
const pkg=JSON.stringify({name:'fixture',dependencies:{example:'1.0.0'}});
const lock=JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:{example:'1.0.0'}},'node_modules/example':{version:'1.0.0',resolved:'https://registry.npmjs.org/example/-/example-1.0.0.tgz',integrity:'sha512-'+'a'.repeat(86)+'=='}}});
const profile=npmProfile(pkg,lock),request={type:'build-dependencies',project:'p'};
const yes=q=>({answers:[{id:q.questions[0].id,selected:['确认执行']}]});
async function fixture(ask=yes) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-provision-')),work=path.join(root,'work'),builds=path.join(root,'builds'),plugins=path.join(root,'plugins');
  const config={storageRoot:path.join(root,'journal'),dshHome:path.join(root,'dsh'),sessionRoot:path.join(root,'sessions'),verification:{executable:process.execPath,image:base,dependencyBuildRoot:builds,provisioning:{baseReference:'node@'+base,buildxDirectory:plugins}}};
  for(const dir of [work,builds,plugins,config.dshHome,config.sessionRoot])await fs.mkdir(dir);
  await fs.writeFile(path.join(plugins,process.platform==='win32'?'docker-buildx.exe':'docker-buildx'),'test double');
  await fs.writeFile(path.join(work,'package.json'),pkg);await fs.writeFile(path.join(work,'package-lock.json'),lock);await fs.writeFile(path.join(work,'private-source.js'),'not sent');
  const calls=[];let behavior;let app;
  const cli=async(args,options)=>{
    calls.push(args);
    if(args[0]==='info')return {exitCode:0,stdout:JSON.stringify({OSType:'linux',MemoryLimit:true,PidsLimit:true,CpuCfsQuota:true,SecurityOptions:['seccomp']})};
    if(args[1]==='build') {assert.equal(Object.values(app.store.snapshot().dependencyBuilds).at(-1).status,'building');if(behavior)return behavior(args,options);}
    return {exitCode:0,stdout:args[0]==='image'?JSON.stringify([{Id:image,Os:'linux',Config:{Labels:{[DEPENDENCY_LABEL]:profile.fingerprint}}}]):'',stderr:''};
  };
  app=await openApplication(config,{runCli:cli});
  await app.controller.userCommand({type:'create',id:'p',objective:'Build dependencies',workspace:work,reviewers:[{id:'r',name:'R',responsibility:'Tests',criteria:'Pass'}]});
  const outer={id:'outer'},control=new UserControl(app.controller,{agents:{get:id=>id===outer.id?outer:undefined,roots:()=>[outer]},userQuestions:{ask}},{dependencies:app.dependencies,provisioner:app.provisioner});
  const revoke=control.bindRoot(outer);
  return {app,control,outer,revoke,root,work,builds,calls,config,cli,setBehavior:fn=>behavior=fn,
    close:async()=>{control.close();await app.close();await fs.rm(root,{recursive:true,force:true});}};
}
test('native online build approval transfers only locked manifests and does not approve image use',async()=>{
  let f;f=await fixture(q=>{if(q.questions[0].header==='允许联网构建依赖'){assert.equal(f.calls.filter(c=>c[0]==='buildx').length,0);assert(q.questions[0].detail.includes('最多10分钟'));}return yes(q);});
  try {
    const result=await f.control.request(f.outer,request),id=result.build.candidate;
    assert.equal(result.build.status,'ready');assert.equal(f.app.store.snapshot().dependencyBuilds[id].status,'ready');
    assert.equal(f.app.store.snapshot().dependencyImages?.p,undefined);
    assert.equal(await fs.readFile(path.join(f.builds,id,'package-lock.json'),'utf8'),lock);
    await assert.rejects(fs.stat(path.join(f.builds,id,'private-source.js')),/ENOENT/);
    assert.match(await fs.readFile(path.join(f.builds,id,'.dockerignore'),'utf8'),/^\*\n!Dockerfile/);
    await f.control.request(f.outer,{type:'use-dependency-image',project:'p',candidate:id});
    assert.equal(f.app.store.snapshot().dependencyImages.p.image,image);
    assert.equal(f.app.store.snapshot().projects.p.notifications.filter(n=>!n.resolved).length,0);
  }finally{await f.close();}
});
test('decline, stale manifests, stale settings, scope revocation and forged roots cannot launch builds',async()=>{
  for(const mode of ['decline','manifest','config','revoke']) {
    let f;f=await fixture(async q=>{
      if(mode==='decline')return {answers:[{id:q.questions[0].id,selected:['返回调整']}]};
      if(mode==='manifest')await fs.writeFile(path.join(f.work,'package.json'),pkg+' ');
      if(mode==='config')await f.app.controller.userCommand({type:'configure',project:'p',objective:'changed'});
      if(mode==='revoke')f.revoke();return yes(q);
    });
    try {
      await assert.rejects(f.control.request({id:'outer'},request),/bound live/);
      if(mode==='decline')assert.equal((await f.control.request(f.outer,request)).applied,false);
      else await assert.rejects(f.control.request(f.outer,request));
      assert.equal(f.calls.filter(c=>c[0]==='buildx').length,0);assert.equal(Object.keys(f.app.store.snapshot().dependencyBuilds??{}).length,0);
    }finally{await f.close();}
  }
});
test('uncertain builds block repeat requests and reconciliation only inspects exact owned tag',async()=>{
  const f=await fixture();
  try {
    f.setBehavior(async()=>{throw Error('connection lost');});
    await assert.rejects(f.control.request(f.outer,request),/connection lost/);
    const record=Object.values(f.app.store.snapshot().dependencyBuilds)[0];assert.equal(record.status,'uncertain');
    await assert.rejects(f.control.request(f.outer,request),/unresolved/);
    await assert.rejects(f.control.recoverDependencyBuild(f.outer,'wrong',record.id),/recoverable/);
    const start=f.calls.length;
    const ready=await f.control.recoverDependencyBuild(f.outer,'p',record.id);
    assert.equal(ready.status,'ready');assert.deepEqual(f.calls.slice(start),[['image','inspect','dsh-foreman-deps:'+record.id.slice(8)]]);
    // Repair a missing report even after the journal's ready commit succeeded.
    await fs.unlink(path.join(f.builds,record.id,'report.json'));
    await f.control.recoverDependencyBuild(f.outer,'p',record.id);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.builds,record.id,'report.json'))).status,'ready');
  }finally{await f.close();}
});
test('closing aborts a running build, drains its journal writes, and never auto-retries',async()=>{
  const f=await fixture();let entered;const running=new Promise(r=>entered=r);
  try {
    f.setBehavior((args,{signal})=>new Promise((resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));
    const pending=f.control.request(f.outer,request);const failed=assert.rejects(pending,/stopped/);
    await running;await f.app.provisioner.close();await failed;
    assert.equal(Object.values(f.app.store.snapshot().dependencyBuilds)[0].status,'uncertain');
    await assert.rejects(f.control.request(f.outer,request),/closed/);
    assert.equal(f.calls.filter(c=>c[1]==='build').length,1);
  }finally{await f.close();}
});
test('an interrupted pre-launch reservation can release its slot without any Docker operation',async()=>{
  const f=await fixture();
  try {
    const id='context-'+randomUUID();
    await f.app.store.dispatchRuntime({type:'dependency-build-record',record:{id,project:'p',configVersion:1,status:'authorized',fingerprint:profile.fingerprint,baseReference:'node@'+base,confirmation:'foreman-confirm-'+randomUUID()}});
    const count=f.calls.length;
    assert.equal((await f.control.recoverDependencyBuild(f.outer,'p',id)).status,'failed');assert.equal(f.calls.length,count);
    assert.equal((await f.control.request(f.outer,request)).build.status,'ready');
  }finally{await f.close();}
});
test('two confirmed tickets cannot race to launch two builds and consumed tickets cannot be replayed',async()=>{
  const f=await fixture();let entered,finish;const running=new Promise(r=>entered=r);
  try {
    const a=await f.app.provisioner.prepare(request),b=await f.app.provisioner.prepare(request),options={authorize:()=>{}};
    f.setBehavior(()=>new Promise(r=>{finish=()=>r({exitCode:0,stdout:'',stderr:''});entered();}));
    const first=f.app.provisioner.confirm(a,'foreman-confirm-'+randomUUID(),options);await running;
    await assert.rejects(f.app.provisioner.confirm(b,'foreman-confirm-'+randomUUID(),options),/unresolved/);
    await assert.rejects(f.app.provisioner.confirm(a,'foreman-confirm-'+randomUUID(),options),/consumed/);
    finish();await first;assert.equal(f.calls.filter(c=>c[1]==='build').length,1);
  }finally{finish?.();await f.close();}
});
test('uncertain build ownership survives a closed application and cold recovery never rebuilds',async()=>{
  const f=await fixture();let reopened;
  try {
    f.setBehavior(async()=>{throw Error('lost connection');});await assert.rejects(f.control.request(f.outer,request));
    const id=Object.keys(f.app.store.snapshot().dependencyBuilds)[0];
    f.control.close();await f.app.close();
    reopened=await openApplication(f.config,{runCli:f.cli});
    await assert.rejects(reopened.provisioner.prepare(request),/unresolved/);
    const count=f.calls.filter(c=>c[1]==='build').length;
    await reopened.provisioner.recover('p',id,{authorize:()=>{}});
    assert.equal(reopened.store.snapshot().dependencyBuilds[id].status,'ready');
    assert.equal(f.calls.filter(c=>c[1]==='build').length,count);
    assert.equal(reopened.store.snapshot().dependencyImages?.p,undefined);
  }finally{await reopened?.close();await f.close();}
});
