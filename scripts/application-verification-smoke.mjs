// Real application + Docker check with deterministic role calls, no model API.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {openApplication} from '../src/application.mjs';
import {UserControl} from '../src/user-control.mjs';
import {createOuterComposer} from '../src/outer-tools.mjs';
const image=process.argv[2];
const build=process.argv[3]==='--build';
let candidate=process.argv[3];
const dependencyBuildRoot=fileURLToPath(new URL('../artifacts/npm-images/',import.meta.url));
const root=await fs.mkdtemp('C:/example/foreman-tests/foreman-verification-smoke-');
const work=path.join(root,'work'),dshHome=path.join(root,'dsh'),sessionRoot=path.join(root,'sessions');
for(const dir of [work,dshHome,sessionRoot])await fs.mkdir(dir);
const app=await openApplication({storageRoot:path.join(root,'journal'),dshHome,sessionRoot,
  verification:{executable:path.join(process.env.LOCALAPPDATA,'Programs/DockerDesktop/resources/bin/docker.exe'),image,...(candidate?{dependencyBuildRoot}:{}),
    ...(build?{provisioning:{baseReference:'node@'+image,buildxDirectory:path.join(process.env.LOCALAPPDATA,'Programs/DockerDesktop/resources/cli-plugins')}}:{})}});
const requireDsh=createRequire('C:/example/dsh/node/node_modules/@deepseek-ai/dsh/package.json');
const load=async name=>import(pathToFileURL(requireDsh.resolve(name)).href);
const [{Context},{ToolRuntime},{SystemPrompt},{createScope},{Session},{UserQuestionService},{AgentRegistry}]=await Promise.all([
  load('@deepseek-ai/cordis'),load('@deepseek-ai/dsh-tools'),load('@deepseek-ai/dsh-system-prompt'),load('@deepseek-ai/dsh-scope'),load('@deepseek-ai/dsh-session'),load('@deepseek-ai/dsh-user-questions'),load('@deepseek-ai/dsh-agent')]);
const ctx=new Context(),scopes=[];
const promptFiber=ctx.plugin(SystemPrompt,{});await promptFiber;
const toolFiber=ctx.plugin(ToolRuntime,{mode:'ptc'});await toolFiber;
const registryFiber=ctx.plugin(AgentRegistry);await registryFiber;
const questionFiber=ctx.plugin(UserQuestionService,{});await questionFiber;
const outer={id:'outer'},control=new UserControl(app.controller,{agents:ctx.get('agents'),userQuestions:ctx.get('userQuestions')},{dependencies:app.dependencies,provisioner:app.provisioner});
let detachOuter;
let confirmations=0;
const unregister=ctx.get('userQuestions').registerProvider({ask:async q=>{
  // Explicit deterministic provider; this smoke test does not ask the human.
  assert.equal(q.agent,outer);assert(q.questions[0].detail.includes(build&&confirmations===0?'允许宿主通过 Docker 联网构建':'本操作不联网安装'));confirmations++;
  return {answers:[{id:q.questions[0].id,selected:['确认执行']}]};
}});
try {
  const c=app.controller,manager={id:'manager'},worker={id:'worker'},planner={id:'planner'},reviewer={id:'reviewer'};
  await c.userCommand({type:'create',id:'p',objective:'Real container verification flow',workspace:work,reviewers:[{id:'r',name:'Quality',responsibility:'Behavior',criteria:'Expected source passes recorded test'}]});
  c.bind(manager,{role:'coordinator',project:'p',configVersion:1});c.bind(planner,{role:'reviewer',project:'p',reviewer:'r'});
  await c.modelCommand(manager,{type:'propose',definition:{id:'m',title:'Implementation',criteria:'Test passes',deps:[]}});
  let round=Object.values(c.view('p').rounds).at(-1);
  await c.modelCommand(planner,{type:'vote',round:round.id,generation:1,pass:true,findings:'Plan checked'});
  await c.modelCommand(manager,{type:'task',id:'t',milestone:'m',title:'Implement',instructions:'Write and verify source'});
  c.bind(worker,{role:'executor',project:'p',task:'t',configVersion:1,planVersion:1,taskAttempt:1});await c.assign(manager,worker,'t');
  // Use installed DSH scopes and ToolRuntime, including native presentation
  // under a global Code Mode default and schema/output validation.
  async function toolsFor(agent,binding,isOuter=false) {
    agent.session=Session.create(agent.id);const scope=createScope(ctx,agent);scopes.push(scope);
    agent.ctx=scope.ctx.extend({agent});
    if(isOuter){detachOuter=ctx.get('agents').enter(agent);ctx.get('agents').announce(agent);await createOuterComposer(control,{snapshot:()=>({})})(agent.ctx);}
    else await app.compose(agent.ctx,binding);
    return async(name,args)=>{
      const result=await agent.ctx.get('tools').execute({callId:agent.id+'-'+name,name,arguments:args,agent,signal:new AbortController().signal});
      if(result.isError)throw Error(result.error.message);return result.value;
    };
  }
  const execute=await toolsFor(worker,c.identity(worker));
  const beforeInvalid=app.store.snapshot().revision;
  await assert.rejects(execute('foreman_verify',{command:'node',args:[],timeoutMs:-1}));
  await assert.rejects(execute('foreman_verify',{command:'node',args:[],timeoutMs:1000,network:'host'}));
  await assert.rejects(execute('foreman_evidence',{offset:0}));
  assert.equal(app.store.snapshot().revision,beforeInvalid,'Rejected tools must not reserve or start verification');
  await execute('foreman_files',{action:'write',path:'program.js',text:"require('node:assert/strict').equal(2+2,4);console.log('verified fixture')",expectedHash:null});
  if(candidate) {
    for(const name of ['package.json','package-lock.json','test.cjs']) {
      const text=await fs.readFile(new URL('../artifacts/npm-fixture/'+name,import.meta.url),'utf8');
      await execute('foreman_files',{action:'write',path:name,text,expectedHash:null});
    }
    await assert.rejects(execute('foreman_verify',{command:'node',args:['test.cjs'],timeoutMs:10000}),/human-approved/);
    assert(app.store.snapshot().projects.p.notifications.some(n=>!n.resolved && n.message?.includes('验证需要批准项目依赖')));
    await assert.rejects(execute('foreman_dependency_candidates',{}));
    const outerExecute=await toolsFor(outer,null,true);
    if(build) {
      await assert.rejects(execute('foreman_dependency_recover',{project:'p',candidate:'context-forged'}));
      const built=JSON.parse((await outerExecute('foreman_user_request',{command:JSON.stringify({type:'build-dependencies',project:'p'})})).text);
      assert.equal(built.build.status,'ready');candidate=built.build.candidate;
      assert.equal(app.store.snapshot().dependencyImages?.p,undefined);
    }
    const candidates=JSON.parse((await outerExecute('foreman_dependency_candidates',{})).text);assert(candidates.includes(candidate));
    const accepted=JSON.parse((await outerExecute('foreman_user_request',{command:JSON.stringify({type:'use-dependency-image',project:'p',candidate})})).text);
    assert.equal(accepted.applied,true);assert.equal(confirmations,build?2:1);
    assert.equal(app.store.snapshot().dependencyNeeds.p.resolved,true);
  }
  const result=JSON.parse((await execute('foreman_verify',{command:'node',args:[candidate?'test.cjs':'program.js'],timeoutMs:10000})).text);
  assert.equal(result.exitCode,0,result.stderr);assert(result.stdout.includes(candidate?'dependency loaded offline':'verified fixture'));
  await execute('foreman_command',{command:JSON.stringify({type:'complete',task:'t',result:'Source implemented and host verification recorded'})});
  await c.modelCommand(manager,{type:'submit',milestone:'m'});round=Object.values(c.view('p').rounds).at(-1);
  c.bind(reviewer,{role:'reviewer',project:'p',reviewer:'r',round:round.id,generation:1,attempt:1,configVersion:1});
  const review=await toolsFor(reviewer,c.identity(reviewer));
  const evidence=JSON.parse((await review('foreman_evidence',{offset:0})).text);
  assert.equal(evidence.reference,result.reference);assert.equal(evidence.evidence.exitCode,0);assert.equal(evidence.total,1);
  await assert.rejects(review('foreman_verify',{command:'node',args:[],timeoutMs:1000}));
  await assert.rejects(review('foreman_evidence',{offset:0,reference:'another-snapshot'}));
  await c.modelCommand(reviewer,{type:'vote',round:round.id,generation:1,pass:true,findings:'Fixture source and matching host evidence verified'});
  assert.equal(c.view('p').milestones.m.status,'passed');
  await assert.rejects(review('foreman_evidence',{offset:0}),/expired/);
  await fs.writeFile(new URL(build?'../artifacts/application-provisioning-report.json':candidate?'../artifacts/application-dependency-report.json':'../artifacts/application-verification-report.json',import.meta.url),JSON.stringify({testedAt:new Date().toISOString(),root,image,candidate,onlineBuild:build,dependencyImage:evidence.evidence.image,reference:result.reference,verification:result.verification,exitCode:result.exitCode,reviewPassed:true,realDshToolRuntime:true,realUserQuestionService:true,confirmations,approvalSource:'deterministic-test-provider'},null,2));
  console.log('Application -> real DSH ToolRuntime -> Docker -> supervisor evidence -> milestone approval: PASS');
} finally {control.close();unregister();detachOuter?.();await app.close();for(const scope of scopes)await scope.dispose();await questionFiber.dispose();await registryFiber.dispose();await toolFiber.dispose();await promptFiber.dispose();}
