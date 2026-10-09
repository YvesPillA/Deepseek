import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import * as host from '../src/host.mjs';
import {JournalStore} from '../src/store.mjs';
const requireDsh=createRequire(path.join(process.env.DSH_TEST_INSTALL??'C:/example/dsh/node/node_modules/@deepseek-ai/dsh','package.json'));
test('authenticated panel archives only terminal display metadata and rejects stale, forged and disposed requests',async()=>{
  const {Context}=await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/cordis')).href);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-panel-archive-')),ctx=new Context();
  const store=await JournalStore.open(root);
  for(const id of ['ended','active'])await store.dispatch({role:'user'},{type:'create',id,objective:id,workspace:path.join(root,id),reviewers:[{id:'r',name:'Review',responsibility:'Behavior',criteria:'Works'}]});
  await store.dispatch({role:'user'},{type:'cancel',project:'ended'});await store.close();
  let handler,operatorActive=true;
  const operator={ctx:{fiber:{assertActive(){if(!operatorActive)throw Error('Operator disposed');}}}};
  ctx.provide('agents',{});ctx.provide('sessions',{});ctx.provide('webServer',{});
  ctx.provide('connection',{operator,rpc:{handle(channel,value){assert.equal(channel,'/foreman-next');handler=value;return ()=>{};}}});
  const fiber=ctx.plugin(host,{storageRoot:root});
  try {
    await fiber;const service=ctx.get('foremanNext');assert.equal(typeof handler,'function');
    assert.equal(service.readiness().projectManagementConfigured,true);assert.equal(service.readiness().userInterface,true);
    assert.equal((await handler('archive',{project:'ended',archiveVersion:0},undefined,{...operator})).ok,false);
    assert.equal((await handler('archive',{project:'active',archiveVersion:0},undefined,operator)).ok,false);
    assert.equal((await handler('archive',{project:'ended',archiveVersion:0},undefined,operator)).ok,true);
    assert.equal(service.view('ended').status,'cancelled');assert.equal(service.view('ended').archived,true);
    assert.equal(service.view('ended').audit.at(-1).command.userApproval.source,'dsh-panel-operator');
    assert.deepEqual(service.list().map(p=>p.id),['active']);
    assert.equal((await handler('unarchive',{project:'ended',archiveVersion:0},undefined,operator)).ok,false);
    assert.equal((await handler('unarchive',{project:'ended',archiveVersion:1},undefined,operator)).ok,true);
    assert.equal(service.view('ended').status,'cancelled');assert.equal(service.view('ended').archiveVersion,2);
    assert.equal((await handler('delete-project',{project:'ended',archiveVersion:2},undefined,operator)).ok,false);
    assert.equal((await handler('archive',{project:'ended',archiveVersion:2},undefined,operator)).ok,true);
    assert.equal((await handler('delete-project',{project:'ended',archiveVersion:2},undefined,operator)).ok,false);
    assert.equal((await handler('delete-project',{project:'ended',archiveVersion:3},undefined,operator)).ok,true);
    assert.equal(service.view('ended').deleted,true);assert.equal(service.view('ended').archiveVersion,4);
    assert.equal(service.view('ended').audit.at(-1).command.userApproval.source,'dsh-panel-operator');
    assert.equal((await handler('unarchive',{project:'ended',archiveVersion:4},undefined,operator)).ok,false);
    assert.equal(service.snapshot().archivedProjects.length,0);assert.deepEqual(service.list().map(p=>p.id),['active']);
    assert.equal((await handler('archive',{project:'ended',archiveVersion:0},undefined,operator)).ok,false);
    const abort=new AbortController();abort.abort();
    assert.equal((await handler('archive',{project:'ended',archiveVersion:2},abort.signal,operator)).ok,false);
    operatorActive=false;
    assert.equal((await handler('archive',{project:'ended',archiveVersion:2},undefined,operator)).ok,false);
    operatorActive=true;await fiber.dispose();
    assert.equal((await handler('archive',{project:'ended',archiveVersion:2},undefined,operator)).ok,false);
    const reopened=await JournalStore.open(root);
    try {const state=reopened.snapshot();assert.equal(state.projects.ended.archived,true);assert.equal(state.projects.ended.deleted,true);assert.equal(state.projects.ended.archiveVersion,4);assert.equal(state.projects.active.status,'running');}
    finally {await reopened.close();}
  } finally {await fiber.dispose();await fs.rm(root,{recursive:true,force:true});}
});
for(const explicit of [false,true])test(`host release gate stays closed with ${explicit?'self-reported approval and an unapproved record':'no approval path'}`,async()=>{
  const {Context}=await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/cordis')).href);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-host-readiness-')),ctx=new Context();
  ctx.provide('agents',{});ctx.provide('sessions',{});
  const approvalPath=path.join(root,'release-approval.json');
  if(explicit)await fs.writeFile(approvalPath,JSON.stringify({version:1,approved:false}));
  const sessionRoot=path.join(root,'sessions');await fs.mkdir(sessionRoot);
  const fiber=ctx.plugin(host,{storageRoot:root,dshHome:root,sessionRoot,readyForProjects:true,releaseApproval:{valid:true},
    ...(explicit?{releaseApprovalPath:approvalPath}:{})});
  try {
    // Do not configure a verifier for this diagnostic Host; this test exercises
    // the real host entry and its approval handoff, with no container or model.
    await fiber;
    const service=ctx.get('foremanNext');assert(service);
    const readiness=service.readiness();assert.equal(readiness.readyForProjects,false);
    assert(readiness.blockers.some(item=>item.id==='release-validation'));
    assert.equal(service.snapshot().readiness.readyForProjects,false);
    assert(!JSON.stringify(service.snapshot()).includes('release-approval.json'));
  } finally {await fiber.dispose();await fs.rm(root,{recursive:true,force:true});}
});

test('native host follows sandbox/subprocess dependency lifetime and exposes failed startup diagnostics',async()=>{
  const {Context}=await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/cordis')).href);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-native-host-')),ctx=new Context();
  ctx.provide('agents',{});ctx.provide('sessions',{});
  const sessionRoot=path.join(root,'sessions');await fs.mkdir(sessionRoot);
  const fiber=ctx.plugin(host,{storageRoot:root,dshHome:root,sessionRoot,verification:{backend:'native'}});
  let providers,reopened;
  try {
    await fiber;assert.equal(ctx.get('foremanNext'),undefined);
    providers=ctx.plugin({name:'native-host-test-services',apply:providerCtx=>{
      providerCtx.provide('sandbox',{confine:async()=>{throw Error('A weaker provider must not execute');}});
      providerCtx.provide('subprocess',{spawn:()=>{throw Error('No command may run');},resolveExecutable:async command=>command,
        selectContainmentMode:()=> 'fallback'});
    }});
    await providers;
    const deadline=Date.now()+5000;
    while(!ctx.get('foremanNext') && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    const service=ctx.get('foremanNext');assert(service);
    const readiness=service.readiness();assert.equal(readiness.verificationBackend,'native');assert.equal(readiness.readyForProjects,false);
    assert(readiness.blockers.find(blocker=>blocker.id==='verification').message.includes('本机验证'));
    await providers.dispose();assert.equal(ctx.get('foremanNext'),undefined);
    reopened=await JournalStore.open(root);await reopened.close();
  } finally {await reopened?.close();await providers?.dispose();await fiber.dispose();await fs.rm(root,{recursive:true,force:true});}
});
