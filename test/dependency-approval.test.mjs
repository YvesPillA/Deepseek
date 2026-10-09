import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openApplication} from '../src/application.mjs';
import {UserControl} from '../src/user-control.mjs';
import {npmProfile,dependencyDockerfile,DEPENDENCY_LABEL} from '../src/dependency-profile.mjs';
const base='sha256:'+'a'.repeat(64),image='sha256:'+'b'.repeat(64),candidate='context-fixture';
const pkg=JSON.stringify({name:'fixture',dependencies:{example:'1.0.0'}});
const lock=JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:{example:'1.0.0'}},'node_modules/example':{
  version:'1.0.0',resolved:'https://registry.npmjs.org/example/-/example-1.0.0.tgz',integrity:'sha512-'+'a'.repeat(86)+'=='}}});
const profile=npmProfile(pkg,lock),request={type:'use-dependency-image',project:'p',candidate};
const yes=q=>({answers:[{id:q.questions[0].id,selected:['确认执行']}]});
async function fixture(ask=yes) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-dep-approval-'));
  const work=path.join(root,'work'),builds=path.join(root,'builds'),dir=path.join(builds,candidate);
  const config={storageRoot:path.join(root,'journal'),dshHome:path.join(root,'dsh'),sessionRoot:path.join(root,'sessions'),
    verification:{executable:process.execPath,image:base,dependencyBuildRoot:builds}};
  for(const p of [work,dir,config.dshHome,config.sessionRoot])await fs.mkdir(p,{recursive:true});
  for(const p of [work,dir]){await fs.writeFile(path.join(p,'package.json'),pkg);await fs.writeFile(path.join(p,'package-lock.json'),lock);}
  await fs.writeFile(path.join(dir,'Dockerfile'),dependencyDockerfile('node@'+base,profile));
  const report={status:'ready',image,fingerprint:profile.fingerprint,baseReference:'node@'+base};
  await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(report));
  const calls=[];let inspectOverride;
  const app=await openApplication(config,{runCli:async args=>{
    calls.push(args);if(args[0]==='info')return {exitCode:0,stdout:JSON.stringify({OSType:'linux',MemoryLimit:true,PidsLimit:true,CpuCfsQuota:true,SecurityOptions:['seccomp']})};
    assert.deepEqual(args,['image','inspect',image]);
    return {exitCode:0,stdout:JSON.stringify([inspectOverride??{Id:image,Os:'linux',Config:{Labels:{[DEPENDENCY_LABEL]:profile.fingerprint}}}])};
  }});
  await app.controller.userCommand({type:'create',id:'p',objective:'Dependency approval',workspace:work,reviewers:[{id:'r',name:'R',responsibility:'Tests',criteria:'Pass'}]});
  const outer={id:'outer'},live=new Map([[outer.id,outer]]);
  const control=new UserControl(app.controller,{agents:{get:id=>live.get(id),roots:()=>[...live.values()]},userQuestions:{ask}},{dependencies:app.dependencies});
  const revoke=control.bindRoot(outer);
  return {app,outer,control,revoke,root,work,dir,report,calls,setImage:v=>inspectOverride=v,
    close:async()=>{control.close();await app.close();await fs.rm(root,{recursive:true,force:true});}};
}
test('native dependency confirmation applies only a validated host candidate and exact current manifests',async()=>{
  let shown;const f=await fixture(q=>{shown=q;return yes(q);});
  try {
    assert.deepEqual(await f.control.dependencyCandidates(f.outer),[candidate]);
    assert.equal((await f.control.request(f.outer,request)).applied,true);
    const record=f.app.store.snapshot().dependencyImages.p;
    assert.equal(record.image,image);assert.equal(record.confirmation,shown.questions[0].id);
    assert(shown.questions[0].detail.includes('本操作不联网安装'));
    assert.equal(f.calls.filter(c=>c[0]==='image').length,2);
    await assert.rejects(f.control.request({id:'outer'},request),/bound live/);
    await assert.rejects(f.control.request(f.outer,{...request,image}),/unexpected/);
    await assert.rejects(f.app.controller.userCommand({type:'create',id:'bad',objective:'x',workspace:f.dir,reviewers:[{id:'r',name:'R',responsibility:'T',criteria:'P'}]}),/protected/);
  }finally{await f.close();}
});
test('dependency confirmation rejects decline, stale manifests, candidate changes, config changes and revoked scope',async()=>{
  for(const mode of ['decline','manifest','candidate','config','revoke','competing']) {
    let f;f=await fixture(async q=>{
      if(mode==='decline')return {answers:[{id:q.questions[0].id,selected:['返回调整']}]};
      if(mode==='manifest')await fs.writeFile(path.join(f.work,'package.json'),pkg+' ');
      if(mode==='candidate')await fs.writeFile(path.join(f.dir,'report.json'),JSON.stringify({...f.report,status:'building'}));
      if(mode==='config')await f.app.controller.userCommand({type:'configure',project:'p',objective:'changed'});
      if(mode==='revoke')f.revoke();
      if(mode==='competing')await f.app.store.dispatchRuntime({type:'approve-dependency-image',project:'p',configVersion:1,expectedRevision:0,image,
        fingerprint:profile.fingerprint,confirmation:'foreman-confirm-11111111-1111-4111-8111-111111111111'});
      return yes(q);
    });
    try {
      if(mode==='decline')assert.equal((await f.control.request(f.outer,request)).applied,false);
      else await assert.rejects(f.control.request(f.outer,request));
      assert.equal(f.app.store.snapshot().dependencyImages?.p?.revision,mode==='competing'?1:undefined);
    }finally{await f.close();}
  }
});
test('invalid candidates never reach confirmation and a confirmation ticket is single-use',async()=>{
  let asks=0;const f=await fixture(q=>{asks++;return yes(q);});
  try {
    await assert.rejects(f.control.request(f.outer,{...request,candidate:'../outside'}),/Invalid/);
    f.setImage({Id:image,Os:'linux',Config:{Labels:{[DEPENDENCY_LABEL]:profile.fingerprint},Volumes:{'/data':{}}}});
    await assert.rejects(f.control.request(f.outer,request),/identity/);assert.equal(asks,0);
    f.setImage(undefined);
    const ticket=await f.app.dependencies.prepare(request);
    ticket.command.candidate='changed'; // Display copy never carries authority.
    const receipt='foreman-confirm-11111111-1111-4111-8111-111111111111';
    await f.app.dependencies.confirm(ticket,receipt,{authorize:()=>{}});
    await assert.rejects(f.app.dependencies.confirm(ticket,receipt,{authorize:()=>{}}),/consumed/);
  }finally{await f.close();}
});
