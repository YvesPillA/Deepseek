import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {ArtifactStore} from '../src/artifacts.mjs';
import {JournalStore} from '../src/store.mjs';
import {ContainerVerifier,verificationInput} from '../src/container-verifier.mjs';
import {dockerCli} from '../src/docker-cli.mjs';
import {verificationRecorder,recoverVerificationContainers} from '../src/verification-ledger.mjs';
import {ProjectVerifier} from '../src/project-verifier.mjs';
import {profileFromFiles} from '../src/dependency-profile.mjs';
const image=process.argv[2],root=fileURLToPath(new URL('../artifacts/dependency-smoke/',import.meta.url));
const work=fileURLToPath(new URL('../artifacts/npm-fixture/',import.meta.url)),configDirectory=path.join(root,'cli-config');await fs.mkdir(configDirectory,{recursive:true});
const cli=dockerCli({executable:path.join(process.env.LOCALAPPDATA,'Programs/DockerDesktop/resources/bin/docker.exe'),configDirectory});
const store=await JournalStore.open(path.join(root,'journal')),backend=new ContainerVerifier({runCli:cli,image});
const router=new ProjectVerifier({store,runCli:cli,baseImage:'sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553'});
try {
  if(!store.snapshot().projects.p)await store.dispatch({role:'user'},{type:'create',id:'p',objective:'Offline dependency smoke fixture',workspace:work,reviewers:[{id:'r',name:'Test',responsibility:'Test',criteria:'Pass'}]});
  if(!store.snapshot().projects.q)await store.dispatch({role:'user'},{type:'create',id:'q',objective:'Unapproved isolation fixture',workspace:work+'-unapproved',reviewers:[{id:'r',name:'Test',responsibility:'Test',criteria:'Pass'}]});
  await recoverVerificationContainers(store,cli);
  const artifacts=new ArtifactStore(path.join(root,'snapshots')),reference=await artifacts.capture(work),request={command:'node',args:['test.cjs'],timeoutMs:10000};
  const input=await verificationInput(artifacts,reference,request),recorder=()=>verificationRecorder(store,{project:'p',reference,request});
  // Deterministic host test fixture, not evidence of a real user's approval.
  await store.dispatchRuntime({type:'approve-dependency-image',project:'p',configVersion:store.snapshot().projects.p.configVersion,
    expectedRevision:store.snapshot().dependencyImages?.p?.revision??0,image,fingerprint:profileFromFiles(JSON.parse(input).files).fingerprint,
    confirmation:'foreman-confirm-11111111-1111-4111-8111-111111111111'});
  await assert.rejects(router.run(input,request,{project:'q',recordOwnership:()=>assert.fail('unapproved project started verification')}),/human-approved/);
  const result=await router.run(input,request,{project:'p',recordOwnership:recorder()});
  assert.equal(result.exitCode,0,result.stderr);assert(result.stdout.includes('dependency loaded offline'));
  const changed=JSON.parse(input),pkg=changed.files.find(f=>f.path==='package.json');pkg.base64=Buffer.from(Buffer.from(pkg.base64,'base64').toString()+' ').toString('base64');
  await assert.rejects(backend.run(Buffer.from(JSON.stringify(changed)),request,{recordOwnership:recorder()}),/does not match/);
  assert(Object.values(store.snapshot().verificationContainers).every(r=>r.status==='removed'));
  await fs.writeFile(path.join(root,'report.json'),JSON.stringify({testedAt:new Date().toISOString(),image,reference,offlineDependencyPassed:true,installScriptNotRun:true,changedManifestRejected:true,containersCleaned:true,projectRouting:true,unapprovedProjectRejected:true,approvalSource:'deterministic-host-fixture'},null,2));
  console.log('Prepared dependency + offline execution + scripts disabled + stale profile refusal: PASS');
} finally {try{await router.close();}finally{await backend.close();await store.close();}}
