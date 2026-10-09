import test from 'node:test';
import assert from 'node:assert/strict';
import {ContainerVerifier,verificationInput,validateVerificationCommand} from '../src/container-verifier.mjs';
const image='sha256:'+'a'.repeat(64),id='b'.repeat(64),command={command:'node',args:['--test'],timeoutMs:100};
const input=Buffer.from(JSON.stringify({...command,files:[]}));
function fixture(overrides={}) {
  const calls=[],records=[];
  const runCli=async(args,options)=>{
    calls.push({args,options});
    if(overrides[args[0]])return overrides[args[0]](args,options);
    if(args[0]==='image')return {exitCode:0,stdout:JSON.stringify([{Id:image,Os:'linux',Config:{}}])};
    if(args[0]==='create')return {exitCode:0,stdout:id};
    if(args[0]==='start')return {exitCode:0,stdout:'PASS',stderr:''};
    if(args[0]==='inspect')return {exitCode:0,stdout:JSON.stringify({Status:'exited',Running:false,ExitCode:0})};
    if(args[0]==='rm')return {exitCode:0,stdout:''};
    if(args[0]==='container')return {exitCode:0,stdout:id};
    throw Error('Unexpected CLI command');
  };
  return {verifier:new ContainerVerifier({runCli,image}),calls,records,recordOwnership:async r=>records.push(r)};
}
test('container verification uses only a pinned image and snapshot stdin, then confirms cleanup',async()=>{
  const f=fixture();const result=await f.verifier.run(input,command,{recordOwnership:f.recordOwnership});
  assert.equal(result.exitCode,0);assert.deepEqual(f.records.map(r=>r.status),['reserved','created','removed']);
  const create=f.calls.find(c=>c.args[0]==='create').args;
  for(const flag of ['--network=none','--read-only','--cap-drop=ALL','--pull=never','--user=65534:65534'])assert(create.includes(flag));
  for(const flag of ['--volume','--mount','--privileged','--env-file','--use-api-socket'])assert(!create.includes(flag));
  assert.deepEqual(JSON.parse(f.calls.find(c=>c.args[0]==='start').options.input),{...JSON.parse(input),preparedDependencies:false});
  assert.equal(f.calls.at(-1).args[3],f.records[0].name);
});
test('image volumes and mutable image tags are refused before execution',async()=>{
  assert.throws(()=>new ContainerVerifier({runCli:()=>{},image:'node:latest'}),/Pinned/);
  const f=fixture({image:async()=>({exitCode:0,stdout:JSON.stringify([{Id:image,Os:'linux',Config:{Volumes:{'/host':{}}}}])})});
  await assert.rejects(f.verifier.run(input,command,{recordOwnership:f.recordOwnership}),/without declared volumes/);
  assert(!f.calls.some(c=>c.args[0]==='start'));
});
test('ambiguous create still cleans the durably reserved exact name; failed cleanup is never success',async()=>{
  const f=fixture({create:async()=>{throw Error('Lost response');}});
  await assert.rejects(f.verifier.run(input,command,{recordOwnership:f.recordOwnership}),/Lost response/);
  assert.deepEqual(f.records.map(r=>r.status),['reserved','removed']);
  const bad=fixture({rm:async()=>({exitCode:1,stdout:''})});
  await assert.rejects(bad.verifier.run(input,command,{recordOwnership:bad.recordOwnership}),/cleanup/);
  assert.equal(bad.records.at(-1).status,'created');
});
test('shutdown aborts active verification but cleanup uses an independent signal',async()=>{
  let started;const start=new Promise(r=>started=r);
  const f=fixture({start:async(_args,{signal})=>{started();return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const pending=f.verifier.run(input,command,{recordOwnership:f.recordOwnership});const rejected=assert.rejects(pending,/shutting down/);
  await start;await f.verifier.close();await rejected;
  assert.equal(f.calls.at(-1).options.signal,undefined);
  await assert.rejects(f.verifier.run(input,command,{recordOwnership:f.recordOwnership}),/closed/);
});
test('snapshot payload validates paths and content bounds without sending host metadata',async()=>{
  const artifacts={verify:async()=>({files:[{path:'src/a.js'}]}),read:async()=>Buffer.from('ok')};
  const result=JSON.parse(await verificationInput(artifacts,'trusted',command));
  assert.deepEqual(result.files,[{path:'src/a.js',base64:'b2s='}]);
  await assert.rejects(verificationInput(artifacts,'trusted',command,{maxBytes:1}),/too large/);
  for(const p of ['../host','/absolute','C:/host','a\\b'])await assert.rejects(verificationInput({...artifacts,verify:async()=>({files:[{path:p}]})},'trusted',command),/Unsafe/);
  assert.throws(()=>validateVerificationCommand({...command,mount:'C:/'}),/Invalid/);
});

test('a payload cannot change the reviewed argv or deadline; failed pre-create cleanup can prove absence',async()=>{
  const f=fixture();await assert.rejects(f.verifier.run(Buffer.from(JSON.stringify({...command,timeoutMs:999,files:[]})),command,{recordOwnership:f.recordOwnership}),/differs/);
  assert.equal(f.calls.length,0);assert.equal(f.records.length,0);
  const absent=fixture({image:async()=>{throw Error('No image');},rm:async()=>({exitCode:1,stdout:''}),container:async()=>({exitCode:0,stdout:''})});
  await assert.rejects(absent.verifier.run(input,command,{recordOwnership:absent.recordOwnership}),/No image/);
  assert.equal(absent.records.at(-1).status,'removed');
});
