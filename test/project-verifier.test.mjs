import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JournalStore} from '../src/store.mjs';
import {ProjectVerifier} from '../src/project-verifier.mjs';
import {npmProfile} from '../src/dependency-profile.mjs';
const base='sha256:'+'a'.repeat(64),dep='sha256:'+'b'.repeat(64);
const pkg=JSON.stringify({name:'fixture',dependencies:{example:'1.0.0'}});
const lock=JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:{example:'1.0.0'}},'node_modules/example':{
  version:'1.0.0',resolved:'https://registry.npmjs.org/example/-/example-1.0.0.tgz',integrity:'sha512-'+'a'.repeat(86)+'=='}}});
const fingerprint=npmProfile(pkg,lock).fingerprint;
const input=Buffer.from(JSON.stringify({files:[{path:'package.json',base64:Buffer.from(pkg).toString('base64')},{path:'package-lock.json',base64:Buffer.from(lock).toString('base64')}]}));
const confirmation='foreman-confirm-11111111-1111-4111-8111-111111111111';
const grant={type:'approve-dependency-image',project:'p',configVersion:1,expectedRevision:0,image:dep,fingerprint,confirmation};
async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-project-images-'));let store=await JournalStore.open(root);
  for(const id of ['p','q'])await store.dispatch({role:'user'},{type:'create',id,objective:'Test',workspace:path.join(root,id),reviewers:[{id:'r',name:'R',responsibility:'Tests',criteria:'Pass'}]});
  return {root,get store(){return store;},reopen:async()=>{await store.close();store=await JournalStore.open(root);},close:async()=>{await store.close();await fs.rm(root,{recursive:true,force:true});}};
}
test('dependency approval persists per project and rejects stale confirmation or model writes',async()=>{
  const f=await fixture();try {
    await assert.rejects(f.store.dispatch({role:'coordinator',project:'p',configVersion:1},grant));
    await f.store.dispatchRuntime(grant);
    await assert.rejects(f.store.dispatchRuntime({...grant,image:base}),/changed/);
    await assert.rejects(f.store.dispatchRuntime({...grant,expectedRevision:1,configVersion:2}),/expired/);
    await f.reopen();const saved=f.store.snapshot().dependencyImages;
    assert.equal(saved.p.image,dep);assert.equal(saved.p.confirmation,confirmation);assert.equal(saved.q,undefined);
  }finally{await f.close();}
});
test('project routing uses exact snapshot approval and freezes active image across replacements',async()=>{
  const f=await fixture(),calls=[],closed=[];let release;
  const blocked=new Promise(r=>release=r);
  const router=new ProjectVerifier({store:f.store,baseImage:base,createBackend:image=>({
    run:async()=>{calls.push(image);await blocked;return image;},close:async()=>{closed.push(image);release();}
  })});
  try {
    await assert.rejects(router.run(input,{}, {project:'p'}),/human-approved/);assert.equal(calls.length,0);
    await f.store.dispatchRuntime(grant);
    await assert.rejects(router.run(input,{}, {project:'q'}),/human-approved/);
    const changed=JSON.parse(input);changed.files[0].base64=Buffer.from(pkg+' ').toString('base64');
    await assert.rejects(router.run(Buffer.from(JSON.stringify(changed)),{}, {project:'p'}),/human-approved/);
    const old=router.run(input,{}, {project:'p'});
    await f.store.dispatchRuntime({...grant,expectedRevision:1,image:base});
    const next=router.run(input,{}, {project:'p'});
    assert.deepEqual(calls,[dep,base]);release();assert.equal(await old,dep);assert.equal(await next,base);
    const noDeps=await router.run(Buffer.from(JSON.stringify({files:[]})),{}, {project:'q'});assert.equal(noDeps,base);
    const closing=router.close();assert.equal(router.close(),closing);await closing;assert.equal(closed.length,2);
    await assert.rejects(router.run(input,{}, {project:'p'}),/closed/);
  } finally {release();await router.close();await f.close();}
});
test('dependency permission alerts persist, deduplicate and resolve only on matching approval',async()=>{
  const f=await fixture();try {
    const needed={type:'dependency-needed',project:'p',configVersion:1,fingerprint};
    await f.store.dispatchRuntime(needed);const revision=f.store.snapshot().revision;
    await f.store.dispatchRuntime(needed);assert.equal(f.store.snapshot().revision,revision);
    await f.reopen();assert.equal(f.store.snapshot().projects.p.notifications.filter(n=>!n.resolved).length,1);
    await f.store.dispatchRuntime({...grant,fingerprint:'c'.repeat(64)});
    assert.equal(f.store.snapshot().dependencyNeeds.p.resolved,false);
    await f.store.dispatchRuntime({...grant,expectedRevision:1});
    assert.equal(f.store.snapshot().dependencyNeeds.p.resolved,true);
    const done=f.store.snapshot().revision;await f.store.dispatchRuntime(needed);
    assert.equal(f.store.snapshot().revision,done,'late error cannot reopen an approved permission request');
  }finally{await f.close();}
});
test('observing removed or changed dependencies clears obsolete permission alerts without approving an image',async()=>{
  const f=await fixture();try {
    await f.store.dispatchRuntime({type:'dependency-needed',project:'p',configVersion:1,fingerprint});
    await f.store.dispatchRuntime({type:'dependency-profile-observed',project:'p',configVersion:1,fingerprint:null});
    assert.equal(f.store.snapshot().dependencyNeeds.p.resolved,true);assert.equal(f.store.snapshot().dependencyImages,undefined);
    assert.equal(f.store.snapshot().projects.p.dependencyWake,1);
    const revision=f.store.snapshot().revision;
    await f.store.dispatchRuntime({type:'dependency-profile-observed',project:'p',configVersion:1,fingerprint:null});
    assert.equal(f.store.snapshot().revision,revision);
  }finally{await f.close();}
});
