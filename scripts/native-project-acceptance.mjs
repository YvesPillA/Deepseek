// Deterministic host role simulation with real Windows native command execution.
// No model, GUI, Docker, user profile or existing project is opened.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {openApplication} from '../src/application.mjs';

const actualRoot='C:/example/dsh-runtime';
const requireActual=createRequire(path.join(actualRoot,'package.json'));
const load=async name=>import(pathToFileURL(requireActual.resolve(name)).href);
const [{Context},{default:Sandbox},{default:Subprocess}]=await Promise.all([
  load('@deepseek-ai/cordis'),load('@deepseek-ai/dsh-sandbox-local'),load('@deepseek-ai/dsh-subprocess-local')]);
const reportPath=path.resolve(process.argv[2]??fileURLToPath(new URL('../artifacts/native-project-acceptance-node-20261008.json',import.meta.url)));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-native-project-'));
const work=path.join(root,'work'),dshHome=path.join(root,'dsh'),sessionRoot=path.join(root,'sessions');
for(const directory of [work,dshHome,sessionRoot])await fs.mkdir(directory);
const config={storageRoot:path.join(root,'journal'),dshHome,sessionRoot,verification:{backend:'native'}};
const ctx=new Context(),fibers=[];
let app,dockerCalls=0;
const report={startedAt:new Date().toISOString(),actualRuntimeRoot:actualRoot,root,reportPath,
  runtime:{node:process.versions.node,electron:process.versions.electron??null,executable:process.execPath},
  verificationConfig:config.verification,modelRequests:0,dockerCalls:0,
  roleDecisions:'Explicit deterministic host-script simulation; no LLM response or new human/UI approval is claimed.',
  passed:false,reopens:[],reviews:[]};
const source="exports.sum = (values) => values.reduce((total,value) => total + value, 0);\n";
const tests="const test=require('node:test'); const assert=require('node:assert/strict'); const {sum}=require('./sum.cjs');\ntest('empty sum',()=>assert.equal(sum([]),0));\ntest('mixed numbers',()=>assert.equal(sum([2,-1,4]),5));\ntest('fractional numbers',()=>assert.equal(sum([0.25,0.75]),1));\n";
const options=()=>({sandbox:ctx.get('sandbox'),subprocess:ctx.get('subprocess'),runCli:()=>{dockerCalls++;throw Error('Docker is forbidden in this fixture');}});
const manager=()=>({id:'scripted-coordinator-'+report.reopens.length});
let coordinator;
async function reopen(phase) {
  const before=app.store.snapshot();await app.close();app=await openApplication(config,options());
  assert.deepEqual(app.store.snapshot(),before);
  report.reopens.push({phase,revision:before.revision,status:before.projects.p.status,runCount:Object.keys(before.verificationRuns??{}).length});
  if(before.projects.p.status!=='delivered'){
    coordinator=manager();app.controller.bind(coordinator,{role:'coordinator',project:'p',configVersion:1});
  }
}
async function review(round,{withEvidence}) {
  for(const reviewer of ['behavior','tests']) {
    const agent={id:`scripted-${round.kind}-${reviewer}-${report.reopens.length}`};
    app.controller.bind(agent,{role:'reviewer',project:'p',reviewer,round:round.id,generation:round.generation,attempt:1,configVersion:1});
    let evidence;
    if(withEvidence) {
      evidence=app.verification.evidence(agent,{offset:0});
      assert.equal(evidence.reference,report.commandResult.reference);assert.equal(evidence.total,1);
      assert.equal(evidence.evidence.id,report.commandResult.verification);assert.equal(evidence.evidence.backend,'native');
      assert.equal(evidence.evidence.exitCode,0);assert.equal(evidence.evidence.truncated,false);
      assert.equal(evidence.evidence.sandbox,'windows-acl');
    }
    await app.controller.modelCommand(agent,{type:'vote',round:round.id,generation:round.generation,pass:true,
      findings:withEvidence?'Scripted acceptance: source inspected and exact-snapshot native node:test evidence checked.':'Scripted plan acceptance: implementation and native test scope checked.'});
    report.reviews.push({round:round.id,kind:round.kind,reviewer,decisionSource:'deterministic-host-script',pass:true,...(evidence?{evidence}:{})});
  }
}
try {
  for(const plugin of [Subprocess,Sandbox]){const fiber=ctx.plugin(plugin,{});fibers.push(fiber);await fiber;}
  app=await openApplication(config,options());assert.equal(app.verification.kind,'native');
  report.capabilities=app.verificationCapabilities;
  await app.controller.userCommand({type:'create',id:'p',workspace:work,objective:'Native snapshot sum module and tests',
    reviewers:[{id:'behavior',name:'Behavior',responsibility:'Sum implementation',criteria:'Returns correct empty, mixed and fractional sums'},
      {id:'tests',name:'Tests',responsibility:'Recorded verification',criteria:'Three real node:test checks and exact snapshot evidence'}]});
  coordinator=manager();app.controller.bind(coordinator,{role:'coordinator',project:'p',configVersion:1});
  await app.controller.modelCommand(coordinator,{type:'propose',definition:{id:'m',title:'Sum implementation and test',criteria:'Three recorded native tests pass',deps:[]}});
  await review(Object.values(app.controller.view('p').rounds).at(-1),{withEvidence:false});
  await app.controller.modelCommand(coordinator,{type:'task',id:'t',milestone:'m',title:'Implement sum and tests',instructions:'Write module and test using file capability; run native verification'});
  const worker={id:'scripted-executor'};
  app.controller.bind(worker,{role:'executor',project:'p',task:'t',configVersion:1,planVersion:1,taskAttempt:1});
  await app.controller.assign(coordinator,worker,'t');
  for(const [name,text] of [['sum.cjs',source],['sum.test.cjs',tests]])await app.files.run(worker,{action:'write',path:name,text,expectedHash:null});
  const request={command:'node',args:['--test','--test-isolation=none','sum.test.cjs'],timeoutMs:30000};
  report.commandResult=await app.verification.run(worker,request,new AbortController().signal);
  assert.equal(report.commandResult.backend,'native');assert.equal(report.commandResult.exitCode,0,report.commandResult.stderr);
  assert.equal(report.commandResult.truncated,false);assert.match(report.commandResult.stdout,/(?:tests 3|1\.\.3)/);
  assert.match(report.commandResult.stdout,/(?:pass 3|ok 3)/);
  report.command=request;
  await app.controller.modelCommand(worker,{type:'complete',task:'t',result:'Source and three actual native tests completed'});
  await app.controller.modelCommand(coordinator,{type:'submit',milestone:'m'});
  await reopen('open-stage-review');
  await review(Object.values(app.controller.view('p').rounds).at(-1),{withEvidence:true});
  assert.equal(app.controller.view('p').milestones.m.status,'passed');
  await app.controller.modelCommand(coordinator,{type:'final'});
  await review(Object.values(app.controller.view('p').rounds).at(-1),{withEvidence:true});
  assert.equal(app.controller.view('p').status,'approved');
  await app.controller.userCommand({type:'deliver',project:'p'});
  assert.equal(app.controller.view('p').status,'delivered');
  await reopen('delivered');
  const state=app.store.snapshot(),run=state.verificationRuns[report.commandResult.verification];
  assert.equal(run.status,'removed');assert.equal(run.reference,report.commandResult.reference);assert.equal(run.result.exitCode,0);
  assert.deepEqual(state.verificationContainers??{},{});assert.equal(dockerCalls,0);
  report.persistedRun=run;report.finalState={status:state.projects.p.status,revision:state.revision,
    milestoneStatus:state.projects.p.milestones.m.status,taskStatus:state.projects.p.tasks.t.status,reviewRounds:Object.values(state.projects.p.rounds).map(round=>({id:round.id,kind:round.kind,status:round.status,votes:round.votes,reference:round.payload.artifact??null}))};
  report.snapshotManifest=await app.artifacts.verify(report.commandResult.reference);
  report.sourceHashes={};
  for(const name of ['sum.cjs','sum.test.cjs'])report.sourceHashes[name]=createHash('sha256').update(await app.artifacts.read(report.commandResult.reference,name)).digest('hex');
  assert.equal(await fs.stat(run.directory).then(()=>true,error=>error.code!=='ENOENT'),false);
  report.passed=true;
} catch(error){report.failure={message:error.message,stack:error.stack};process.exitCode=1;}
finally {
  try {await app?.close();for(const fiber of fibers.reverse())await fiber.dispose();}
  catch(error){report.cleanupFailure=error.message;report.passed=false;process.exitCode=1;}
  report.dockerCalls=dockerCalls;report.finishedAt=new Date().toISOString();
  await fs.writeFile(reportPath,JSON.stringify(report,null,2));
}
console.log(JSON.stringify({passed:report.passed,reportPath,root,status:report.finalState?.status,exitCode:report.commandResult?.exitCode,modelRequests:0,dockerCalls}));
