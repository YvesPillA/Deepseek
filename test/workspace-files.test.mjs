import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {initialState,transition} from '../src/core.mjs';
import {Controller} from '../src/controller.mjs';
import {ArtifactStore} from '../src/artifacts.mjs';
import {WorkspaceFiles} from '../src/workspace-files.mjs';

async function fixture(captureWrapper=f=>f) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-files-'));
  const work=path.join(root,'work'),protectedRoot=path.join(root,'host');
  await fs.mkdir(work);await fs.mkdir(protectedRoot);
  let state=initialState(),files;
  const store={snapshot:()=>structuredClone(state),dispatch:async(a,c)=>state=transition(state,a,c)};
  const c=new Controller(store,{captureArtifact:p=>files.capture(p)});
  await c.userCommand({type:'create',id:'p',objective:'Implement',workspace:work,reviewers:[{id:'r',name:'Review',responsibility:'Quality',criteria:'Tests pass'}]});
  const manager={id:'manager'},reviewer={id:'reviewer'},a={id:'a'},b={id:'b'};
  c.bind(manager,{role:'coordinator',project:'p',configVersion:1});c.bind(reviewer,{role:'reviewer',project:'p',reviewer:'r'});
  for(const id of ['a','b']) {
    await c.modelCommand(manager,{type:'propose',definition:{id,title:id,criteria:'Working',deps:[]}});
    const r=Object.values(c.view('p').rounds).at(-1);
    await c.modelCommand(reviewer,{type:'vote',round:r.id,generation:1,pass:true,findings:'Plan checked'});
    await c.modelCommand(manager,{type:'task',id,milestone:id,title:id,instructions:'Implement'});
  }
  for(const agent of [a,b]){c.bind(agent,{role:'executor',project:'p',task:agent.id,configVersion:1,planVersion:1});await c.assign(manager,agent,agent.id);}
  const artifacts=new ArtifactStore(path.join(protectedRoot,'artifacts'));
  files=new WorkspaceFiles(c,{protectedRoots:[protectedRoot],artifacts:{capture:captureWrapper(p=>artifacts.capture(p))}});
  return {root,work,protectedRoot,c,manager,reviewer,a,b,files,artifacts,close:()=>fs.rm(root,{recursive:true,force:true})};
}

test('file capability rejects path escapes, Windows aliases, protected roots, junctions and hardlinks',async()=>{
  const f=await fixture();try {
    for(const relative of ['../secret','/absolute','C:/secret','a\\b','file:stream','NUL.txt','COM1','a.','a ','a//b','.git/config','.CoDeX/settings','.agent-presets/x'])
      await assert.rejects(f.files.run(f.a,{action:'write',path:relative,text:'bad',expectedHash:null}),/path/);
    await fs.writeFile(path.join(f.protectedRoot,'secret'),'protected');
    await fs.symlink(f.protectedRoot,path.join(f.work,'junction'),'junction');
    await assert.rejects(f.files.run(f.a,{action:'read',path:'junction/secret'}),/links/);
    await fs.link(path.join(f.protectedRoot,'secret'),path.join(f.work,'linked'));
    await assert.rejects(f.files.run(f.a,{action:'read',path:'linked'}),/single-link/);
    await assert.rejects(f.files.capture({workspace:f.root}),/overlaps/);
    assert.equal(await fs.readFile(path.join(f.protectedRoot,'secret'),'utf8'),'protected');
  } finally {await f.close();}
});

test('excluded dependency directories cannot receive unreviewed executor changes',async()=>{
  const f=await fixture();try {
    await fs.mkdir(path.join(f.work,'node_modules'));
    await fs.writeFile(path.join(f.work,'node_modules','existing.txt'),'untouched');
    for(const relative of ['node_modules/new.txt','src/NoDe_MoDuLeS/new.txt'])
      await assert.rejects(f.files.run(f.a,{action:'write',path:relative,text:'bad',expectedHash:null}),/protected workspace path/);
    await assert.rejects(f.files.run(f.a,{action:'delete',path:'node_modules/existing.txt',expectedHash:null}),/protected workspace path/);
    assert.equal(await fs.readFile(path.join(f.work,'node_modules','existing.txt'),'utf8'),'untouched');
    assert(!(await f.files.run(f.a,{action:'list',path:''})).entries.some(e=>e.name==='node_modules'));
  } finally {await f.close();}
});

test('concurrent edits use compare-and-swap and single-file deletion needs the current hash',async()=>{
  const f=await fixture();try {
    const first=await f.files.run(f.a,{action:'write',path:'src/app.txt',text:'first',expectedHash:null});
    const results=await Promise.allSettled([f.a,f.b].map((a,i)=>f.files.run(a,{action:'write',path:'src/app.txt',text:'revision '+i,expectedHash:first.hash})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    await assert.rejects(f.files.run(f.a,{action:'delete',path:'src/app.txt',expectedHash:first.hash}),/changed/);
    const current=await f.files.run(f.a,{action:'read',path:'src/app.txt'});
    await f.files.run(f.a,{action:'delete',path:'src/app.txt',expectedHash:current.hash});
    await assert.rejects(f.files.run(f.a,{action:'read',path:'src/app.txt'}),/does not exist/);
    await assert.rejects(f.files.run(f.a,{action:'delete',path:'src',expectedHash:null}),/single-link/);
  } finally {await f.close();}
});

test('completed and revoked workers cannot write, including commands queued behind completion',async()=>{
  const f=await fixture();try {
    const completion=f.c.modelCommand(f.a,{type:'complete',task:'a',result:'Finished'});
    const write=f.files.run(f.a,{action:'write',path:'late.txt',text:'late',expectedHash:null});
    await completion;await assert.rejects(write,/ownership/);
    await assert.rejects(f.files.run(f.reviewer,{action:'write',path:'reviewer.txt',text:'bad',expectedHash:null}),/ownership/);
    await assert.rejects(f.files.run({id:f.b.id},{action:'list',path:''}),/identity/);
  } finally {await f.close();}
});

test('acceptance capture and commit form a barrier; independent later writes do not change review contents',async()=>{
  let entered,release;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
  const f=await fixture(capture=>async root=>{entered();await wait;return capture(root);});
  try {
    const first=await f.files.run(f.a,{action:'write',path:'app.txt',text:'reviewed',expectedHash:null});
    await f.c.modelCommand(f.a,{type:'complete',task:'a',result:'Done'});
    const submit=f.c.modelCommand(f.manager,{type:'submit',milestone:'a'});await started;
    let written=false;
    const later=f.files.run(f.b,{action:'write',path:'app.txt',text:'later branch',expectedHash:first.hash}).then(()=>written=true);
    assert.equal(written,false);release();await submit;await later;
    const review=Object.values(f.c.view('p').rounds).at(-1);
    assert.equal((await f.artifacts.read(review.payload.artifact,'app.txt')).toString(),'reviewed');
    assert.equal(await fs.readFile(path.join(f.work,'app.txt'),'utf8'),'later branch');
  } finally {release();await f.close();}
});

test('task-count patrol captures evidence without blocking subsequent independent file work',async()=>{
  const f=await fixture();try {
    await f.files.run(f.a,{action:'write',path:'evidence.txt',text:'patrol version',expectedHash:null});
    await f.c.modelCommand(f.a,{type:'complete',task:'a',result:'Done'});
    for(const id of ['c','d']) {
      await f.c.modelCommand(f.manager,{type:'task',id,milestone:'a',title:id,instructions:'Implement'});
      const agent={id};f.c.bind(agent,{role:'executor',project:'p',task:id,configVersion:1,planVersion:1});await f.c.assign(f.manager,agent,id);
      await f.c.modelCommand(agent,{type:'complete',task:id,result:'Done'});
    }
    const round=Object.values(f.c.view('p').rounds).at(-1);
    assert.equal(round.kind,'patrol');assert.equal(round.status,'open');
    assert.equal((await f.artifacts.read(round.payload.artifact,'evidence.txt')).toString(),'patrol version');
    await f.files.run(f.b,{action:'write',path:'later.txt',text:'Independent work continues',expectedHash:null});
    assert.equal(f.c.view('p').completions,3);
  } finally {await f.close();}
});
