import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {JournalStore} from '../src/store.mjs';
import {Controller} from '../src/controller.mjs';
import {ArtifactStore} from '../src/artifacts.mjs';
import {WorkspaceFiles} from '../src/workspace-files.mjs';
import {VerificationService} from '../src/verification-service.mjs';

async function fixture(during,{native=false}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-verify-service-')),work=path.join(root,'work'),host=path.join(root,'host');
  await fs.mkdir(work);await fs.mkdir(host);await fs.writeFile(path.join(work,'source.txt'),'before');
  const store=await JournalStore.open(host),artifacts=new ArtifactStore(path.join(host,'artifacts'));let files;
  const c=new Controller(store,{captureArtifact:p=>files.capture(p)});
  files=new WorkspaceFiles(c,{artifacts,protectedRoots:[host]});
  await c.userCommand({type:'create',id:'p',objective:'Verify',workspace:work,reviewers:[{id:'r',name:'Reviewer',responsibility:'Tests',criteria:'Pass'}]});
  const coordinator={id:'c'},reviewer={id:'r'},executor={id:'e'};
  c.bind(coordinator,{role:'coordinator',project:'p',configVersion:1});c.bind(reviewer,{role:'reviewer',project:'p',reviewer:'r'});
  await c.modelCommand(coordinator,{type:'propose',definition:{id:'m',title:'Milestone',criteria:'Pass',deps:[]}});
  const round=Object.values(c.view('p').rounds)[0];await c.modelCommand(reviewer,{type:'vote',round:round.id,generation:1,pass:true,findings:'Plan verified'});
  await c.modelCommand(coordinator,{type:'task',id:'t',milestone:'m',title:'Task',instructions:'Implement'});
  c.bind(executor,{role:'executor',project:'p',task:'t',configVersion:1,planVersion:1,taskAttempt:1});await c.assign(coordinator,executor,'t');
  const result={exitCode:0,stdout:'PASS',stderr:'',truncated:false,oomKilled:false};
  const backend={kind:native?'native':'docker',close:async()=>{},run:async(input,_request,{recordOwnership})=>{
    assert.equal(Buffer.from(JSON.parse(input).files.find(f=>f.path==='source.txt').base64,'base64').toString(),'before');
    const name=(native?'dsh-foreman-native-':'dsh-foreman-run-')+randomUUID(),image='sha256:'+'a'.repeat(64);
    const entry=native?{name,backend:'native',directory:path.join(root,'snapshot')}:{name,image};
    await recordOwnership({...entry,status:'reserved'});
    await recordOwnership(native?{...entry,status:'running'}:{...entry,id:'b'.repeat(64),status:'created'});
    await during({c,files,executor});await recordOwnership({...entry,status:'removed'});return result;
  }};
  const service=new VerificationService({controller:c,store,files,artifacts,backend});
  return {c,store,service,executor,reviewer,coordinator,artifacts,files,close:async()=>{await service.close();await c.close();await store.close();await fs.rm(root,{recursive:true,force:true});}};
}
test('verification releases the write barrier and persists results against the original snapshot',async()=>{
  const f=await fixture(async({files,executor})=>{
    const read=await files.run(executor,{action:'read',path:'source.txt'});
    await files.run(executor,{action:'write',path:'source.txt',text:'after',expectedHash:read.hash});
  });
  try {
    const result=await f.service.run(f.executor,{command:'node',args:['--test']});
    assert.equal(result.exitCode,0);assert.equal((await f.artifacts.read(result.reference,'source.txt')).toString(),'before');
    const saved=f.store.snapshot().verificationContainers[result.verification];assert.equal(saved.reference,result.reference);assert.equal(saved.result.stdout,'PASS');
    await assert.rejects(f.service.run(f.reviewer,{command:'node',args:[]}),/ownership/);
  } finally {await f.close();}
});
test('a completed task cannot accept a late verification result',async()=>{
  const f=await fixture(async({c,executor})=>c.modelCommand(executor,{type:'complete',task:'t',result:'Already completed'}));
  try {
    await assert.rejects(f.service.run(f.executor,{command:'node',args:['--test']}),/ownership/);
    const record=Object.values(f.store.snapshot().verificationContainers)[0];assert.equal(record.status,'removed');assert.equal(record.result,undefined);
  } finally {await f.close();}
});

test('supervisor evidence is paged, detached, and restricted to the live review snapshot',async()=>{
  const f=await fixture(async()=>{});
  try {
    const verified=await f.service.run(f.executor,{command:'node',args:['--test']});
    await f.c.modelCommand(f.executor,{type:'complete',task:'t',result:'Implemented'});
    await f.c.modelCommand(f.coordinator,{type:'submit',milestone:'m'});
    const round=Object.values(f.c.view('p').rounds).at(-1),reviewer={id:'current-reviewer'};
    f.c.bind(reviewer,{role:'reviewer',project:'p',reviewer:'r',round:round.id,generation:1,attempt:1,configVersion:1});
    const page=f.service.evidence(reviewer,{offset:0});assert.equal(page.total,1);assert.equal(page.reference,verified.reference);assert.equal(page.evidence.stdout,'PASS');
    page.evidence.stdout='Forged';assert.equal(f.service.evidence(reviewer,{offset:0}).evidence.stdout,'PASS');
    assert.equal(f.service.evidence(reviewer,{offset:1}).evidence,null);
    assert.throws(()=>f.service.evidence(f.executor,{offset:0}),/expired/);
    await f.c.modelCommand(reviewer,{type:'vote',round:round.id,generation:1,pass:true,findings:'Verified source and host evidence'});
    assert.throws(()=>f.service.evidence(reviewer,{offset:0}),/expired/);
  } finally {await f.close();}
});

test('service close drains an active run and refuses a result returned after shutdown',async()=>{
  let entered,release;const started=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);
  const f=await fixture(async()=>{entered();await blocked;});
  try {
    const pending=f.service.run(f.executor,{command:'node',args:[]});const rejected=assert.rejects(pending,/closed/);
    await started;let drained=false;const closing=f.service.close().then(()=>{drained=true;});
    await new Promise(r=>setImmediate(r));assert.equal(drained,false);
    release();await closing;await rejected;
    const record=Object.values(f.store.snapshot().verificationContainers)[0];assert.equal(record.status,'removed');assert.equal(record.result,undefined);
  } finally {release();await f.close();}
});

test('native verification uses independent durable evidence and never demands Docker dependency images',async()=>{
  const f=await fixture(async()=>{},{native:true});
  try {
    // Native projects must not enter Docker manifest parsing/provisioning, even
    // when they use a package manager whose lockfile differs from that backend.
    await f.files.run(f.executor,{action:'write',path:'package-lock.json',text:'native lockfile fixture',expectedHash:null});
    const verified=await f.service.run(f.executor,{command:'node',args:['--test']});
    assert.equal(verified.backend,'native');assert.equal(f.service.kind,'native');
    assert.equal(f.store.snapshot().verificationContainers,undefined);
    assert.equal(f.store.snapshot().dependencyProfiles,undefined);
    assert.equal(f.store.snapshot().verificationRuns[verified.verification].result.stdout,'PASS');
    await f.c.modelCommand(f.executor,{type:'complete',task:'t',result:'Native command verified'});
    await f.c.modelCommand(f.coordinator,{type:'submit',milestone:'m'});
    const round=Object.values(f.c.view('p').rounds).at(-1),reviewer={id:'native-reviewer'};
    f.c.bind(reviewer,{role:'reviewer',project:'p',reviewer:'r',round:round.id,generation:1,attempt:1,configVersion:1});
    const page=f.service.evidence(reviewer,{offset:0});
    assert.equal(page.total,1);assert.equal(page.reference,verified.reference);assert.equal(page.evidence.backend,'native');
    assert.equal(page.evidence.sandbox,'windows-acl');assert.equal(page.evidence.image,undefined);assert.equal(page.evidence.directory,undefined);
    page.evidence.stdout='forged';assert.equal(f.service.evidence(reviewer,{offset:0}).evidence.stdout,'PASS');
  }finally{await f.close();}
});

test('native completion cannot attach evidence after its execution assignment expires',async()=>{
  const f=await fixture(async({c,executor})=>c.modelCommand(executor,{type:'complete',task:'t',result:'Already completed'}),{native:true});
  try {
    await assert.rejects(f.service.run(f.executor,{command:'node',args:[]}),/ownership/);
    const record=Object.values(f.store.snapshot().verificationRuns)[0];assert.equal(record.status,'removed');assert.equal(record.result,undefined);
  }finally{await f.close();}
});
