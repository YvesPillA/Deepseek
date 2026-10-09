import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDependencies,recoverDependencyBuild} from '../src/dependency-build.mjs';
import {DEPENDENCY_LABEL} from '../src/dependency-profile.mjs';
const record={status:'prepared',tag:'dsh-foreman-deps:11111111-1111-4111-8111-111111111111',fingerprint:'a'.repeat(64),context:'D:/private/context'};
const image={Id:'sha256:'+'b'.repeat(64),Os:'linux',Config:{Labels:{[DEPENDENCY_LABEL]:record.fingerprint}}};
const ok={exitCode:0,stdout:'',stderr:'',truncated:false};
test('dependency build persists intent before BuildKit and verifies the loaded image',async()=>{
  const states=[],calls=[];
  const cli=async args=>{
    calls.push(args);
    if(args[1]==='build') {assert.equal(states.at(-1).status,'building');assert(args.includes('--builder=default'));assert(args.includes('--load'));}
    return args[0]==='image'?{...ok,stdout:JSON.stringify([image])}:ok;
  };
  const ready=await buildDependencies({cli,record,persist:async s=>states.push(s),saveLog:async()=>{}});
  assert.equal(ready.image,image.Id);assert.equal(states.at(-1).status,'ready');assert.equal(calls.length,3);
  await assert.rejects(buildDependencies({cli,record,persist:async()=>{throw Error('disk full');},saveLog:async()=>{}}),/disk full/);
  assert.equal(calls.length,4,'failed durable intent permits version query only');
});
test('uncertain build recovery inspects exact tag without rebuilding or accepting changed identity',async()=>{
  const states=[];
  await assert.rejects(buildDependencies({record,persist:async s=>states.push(s),saveLog:async()=>{},cli:async args=>{
    if(args[1]==='build')throw Error('timeout');return ok;
  }}),/timeout/);
  assert.equal(states.at(-1).status,'uncertain');
  const cli=async args=>{assert.deepEqual(args,['image','inspect',record.tag]);return {...ok,stdout:JSON.stringify([image])};};
  const ready=await recoverDependencyBuild({cli,record:states.at(-1),persist:async s=>states.push(s)});
  assert.equal(ready.status,'ready');
  for(const bad of [{...image,Config:{Labels:{}}},{...image,Os:'windows'},{...image,Config:{...image.Config,Volumes:{'/data':{}}}}]) {
    await assert.rejects(recoverDependencyBuild({record:ready,cli:async()=>({...ok,stdout:JSON.stringify([bad])}),persist:async()=>assert.fail('must not persist')}),/mismatch/);
  }
  await assert.rejects(recoverDependencyBuild({record:{...ready,image:'sha256:'+'c'.repeat(64)},cli,persist:async()=>{}}),/changed/);
  await assert.rejects(recoverDependencyBuild({record:states[0],cli:async()=>({...ok,exitCode:1}),persist:async()=>{}}),/uncertain/);
});
test('missing Buildx and definite build failure never report readiness',async()=>{
  let writes=0;
  await assert.rejects(buildDependencies({record,cli:async()=>({...ok,exitCode:1}),persist:async()=>writes++,saveLog:async()=>{}}),/Buildx/);
  assert.equal(writes,0);
  const states=[];
  await assert.rejects(buildDependencies({record,cli:async args=>({...ok,exitCode:args[1]==='build'?1:0}),persist:async s=>states.push(s),saveLog:async()=>{}}),/failed/);
  assert.equal(states.at(-1).status,'failed');
});
