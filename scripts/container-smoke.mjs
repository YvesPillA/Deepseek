// Explicit real-Docker integration check. Not part of offline node --test.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {ArtifactStore} from '../src/artifacts.mjs';
import {JournalStore} from '../src/store.mjs';
import {ContainerVerifier,verificationInput} from '../src/container-verifier.mjs';
import {dockerCli} from '../src/docker-cli.mjs';
import {verificationRecorder,recoverVerificationContainers} from '../src/verification-ledger.mjs';

const image=process.argv[2];
if(!/^sha256:[a-f0-9]{64}$/.test(image??''))throw Error('Pass a pinned local image ID');
const root=fileURLToPath(new URL('../artifacts/container-smoke/',import.meta.url));
const work=path.join(root,'source'),configDirectory=path.join(root,'cli-config');
await fs.mkdir(work,{recursive:true});await fs.mkdir(configDirectory,{recursive:true});
await fs.writeFile(path.join(work,'fixture.txt'),'snapshot fixture');
const executable=path.join(process.env.LOCALAPPDATA,'Programs/DockerDesktop/resources/bin/docker.exe');
process.env.FOREMAN_SMOKE_SECRET='must-not-reach-container';
const cli=dockerCli({executable,configDirectory}),store=await JournalStore.open(path.join(root,'journal'));
const verifier=new ContainerVerifier({runCli:cli,image}),results=[];
try {
  if(!store.snapshot().projects.smoke)await store.dispatch({role:'user'},{type:'create',id:'smoke',objective:'Disposable Docker integration fixture',workspace:work,reviewers:[{id:'r',name:'Fixture reviewer',responsibility:'Test only',criteria:'No project delivery'}]});
  await recoverVerificationContainers(store,cli);
  const artifacts=new ArtifactStore(path.join(root,'snapshots')),reference=await artifacts.capture(work);
  async function run(name,code,{timeoutMs=10000,expected=0,truncated=false}={}) {
    const request={command:'node',args:['-e',code],timeoutMs};
    const input=await verificationInput(artifacts,reference,request);
    const result=await verifier.run(input,request,{recordOwnership:verificationRecorder(store,{project:'smoke',reference,request})});
    assert.equal(result.exitCode,expected,name+': '+result.stderr);assert.equal(result.truncated,truncated,name);
    results.push({name,exitCode:result.exitCode,truncated:result.truncated,stdout:result.stdout.slice(0,2000)});
    console.log(name+': PASS');
  }
  await run('source-and-isolation',[
    "const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os')",
    "assert.equal(fs.readFileSync('/work/fixture.txt','utf8'),'snapshot fixture')",
    "assert.equal(process.getuid(),65534);assert.equal(process.env.FOREMAN_SMOKE_SECRET,undefined)",
    "for(const p of ['/var/run/docker.sock','/host','/mnt/c','/mnt/d'])assert(!fs.existsSync(p),p)",
    "assert.throws(()=>fs.writeFileSync('/etc/foreman-test','bad'))",
    "assert(Object.values(os.networkInterfaces()).flat().every(i=>i.internal))",
    "const status=fs.readFileSync('/proc/self/status','utf8')",
    "const field=name=>status.split(String.fromCharCode(10)).find(l=>l.startsWith(name+':')).split(':')[1].trim()",
    "assert.equal(BigInt('0x'+field('CapEff')),0n);assert.equal(field('NoNewPrivs'),'1');assert.equal(field('Seccomp'),'2')",
    "assert.equal(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),'536870912');assert.equal(fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),'128')",
    "fs.writeFileSync('/work/generated.txt','container-only');console.log('snapshot, uid, environment, mounts, network, rootfs and process restrictions verified')",
  ].join(';'));
  assert.equal(await fs.readFile(path.join(work,'fixture.txt'),'utf8'),'snapshot fixture');
  await assert.rejects(fs.access(path.join(work,'generated.txt')));
  await run('nonzero-exit','process.exit(7)',{expected:7});
  await run('timeout','setInterval(()=>{},1000)',{timeoutMs:200,expected:124});
  await run('bounded-output',"process.stdout.write('x'.repeat(2*1024*1024))",{truncated:true});
  const cancelRequest={command:'node',args:['-e','setInterval(()=>{},1000)'],timeoutMs:10000};
  const abort=new AbortController();let cancelTimer;
  const cancelRecorder=verificationRecorder(store,{project:'smoke',reference,request:cancelRequest});
  try {
    await assert.rejects(verifier.run(await verificationInput(artifacts,reference,cancelRequest),cancelRequest,{signal:abort.signal,recordOwnership:async entry=>{
      await cancelRecorder(entry);if(entry.status==='created')cancelTimer=setTimeout(()=>abort.abort(new Error('Smoke cancellation')),500);
    }}),/Smoke cancellation/);
  } finally {clearTimeout(cancelTimer);}
  results.push({name:'cancellation',passed:true});console.log('cancellation: PASS');
  const abandonedName='dsh-foreman-run-'+randomUUID();
  const abandonedRecorder=verificationRecorder(store,{project:'smoke',reference,request:cancelRequest});
  await abandonedRecorder({name:abandonedName,image,status:'reserved'});
  const abandoned=await cli(['create','--pull=never','--name',abandonedName,'--label','dsh-foreman.verification=true','--network=none','--read-only','--entrypoint=/usr/local/bin/node',image,'--version']);
  assert.equal(abandoned.exitCode,0,abandoned.stderr);
  // Deliberately omit created ID: a restart can see this same lost-response gap.
  await recoverVerificationContainers(store,cli);
  assert.equal(store.snapshot().verificationContainers[abandonedName].status,'removed');
  results.push({name:'reserved-container-recovery',passed:true});console.log('reserved-container-recovery: PASS');
  assert.equal(Object.values(store.snapshot().verificationContainers).filter(r=>r.status!=='removed').length,0);
  for(const record of Object.values(store.snapshot().verificationContainers)) {
    const response=await cli(['container','ls','--all','--filter','name=^/'+record.name+'$','--format={{.ID}}']);
    assert.equal(response.exitCode,0);assert.equal(response.stdout.trim(),'');
  }
  await fs.writeFile(path.join(root,'report.json'),JSON.stringify({testedAt:new Date().toISOString(),image,reference,results,cleanupConfirmed:true},null,2));
  console.log('All real-container checks passed; report saved.');
} finally {await verifier.close();await store.close();}
