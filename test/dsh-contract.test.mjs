import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as hostPlugin from '../src/host.mjs';
import {DshAgentDriver} from '../src/controller.mjs';
import {receiptEvidence} from '../src/dsh-transport.mjs';
import {sessionEvents} from '../src/stored-session.mjs';
import {createRoleComposer} from '../src/role-tools.mjs';
import {Controller} from '../src/controller.mjs';
import {initialState,transition} from '../src/core.mjs';
import {UserControl} from '../src/user-control.mjs';
import {createOuterComposer} from '../src/outer-tools.mjs';
import * as outerPlugin from '../src/outer-entry.mjs';
import {JournalStore} from '../src/store.mjs';
import {validateVerificationCommand} from '../src/container-verifier.mjs';
import {VerificationService} from '../src/verification-service.mjs';

const install=process.env.DSH_TEST_INSTALL ?? 'C:/example/dsh/node/node_modules/@deepseek-ai/dsh';
const requireDsh=createRequire(path.join(install,'package.json'));
const loadDsh=async name=>import(pathToFileURL(requireDsh.resolve(name)).href);

test('real scoped DSH tools enforce role guards and do not leak to sibling agents',async()=>{
  const {Context}=await loadDsh('@deepseek-ai/cordis');
  const {SystemPrompt}=await loadDsh('@deepseek-ai/dsh-system-prompt');
  const {ToolRuntime}=await loadDsh('@deepseek-ai/dsh-tools');
  const {createScope}=await loadDsh('@deepseek-ai/dsh-scope');
  const {Session}=await loadDsh('@deepseek-ai/dsh-session');
  const ctx=new Context();const prompt=ctx.plugin(SystemPrompt,{});await prompt;
  const tools=ctx.plugin(ToolRuntime,{mode:'native'});await tools;
  let state=initialState();
  const store={snapshot:()=>structuredClone(state),dispatch:async(a,c)=>state=transition(state,a,c)};
  const controller=new Controller(store,{captureArtifact:async()=>{throw new Error('Not connected');}});
  await controller.userCommand({type:'create',id:'p',objective:'Program',workspace:'D:/project',reviewers:[{id:'r',name:'Quality',responsibility:'Tests',criteria:'Pass'}]});
  const agent={id:'manager',session:Session.create('manager')},sibling={id:'other',session:Session.create('other')};
  const scope=createScope(ctx,agent),otherScope=createScope(ctx,sibling);
  agent.ctx=scope.ctx.extend({agent});sibling.ctx=otherScope.ctx.extend({agent:sibling});
  const binding={role:'coordinator',project:'p',configVersion:1};controller.bind(agent,binding);
  let forbiddenRan=false;
  try {
    await createRoleComposer(controller)(agent.ctx,binding);
    agent.ctx.get('tools').register({name:'unexpected_shell',description:'Forbidden',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=>{forbiddenRan=true;return 'bad';}});
    const execute=(who,name,args={})=>who.ctx.get('tools').execute({callId:'test-'+name,name,arguments:args,agent:who,signal:new AbortController().signal});
    assert.equal((await execute(agent,'foreman_read')).isError,false);
    assert.equal((await execute(sibling,'foreman_read')).isError,true);
    assert.equal((await execute(agent,'unexpected_shell')).isError,true);assert.equal(forbiddenRan,false);
    assert.equal((await execute(agent,'foreman_command',{command:JSON.stringify({type:'configure',objective:'Bypass'})})).isError,true);
    assert.equal((await execute(agent,'foreman_command',{command:JSON.stringify({type:'propose',definition:{id:'a',title:'Program',criteria:'Tests',deps:[]}})})).isError,false);
    await controller.userCommand({type:'configure',project:'p',objective:'Revised'});
    assert.equal((await execute(agent,'foreman_read')).isError,true);
  } finally {await scope.dispose();await otherScope.dispose();await tools.dispose();await prompt.dispose();}
});

test('real DSH verification tools validate arguments, roles, cancellation and expired assignments offline',async()=>{
  const {Context}=await loadDsh('@deepseek-ai/cordis');
  const {SystemPrompt}=await loadDsh('@deepseek-ai/dsh-system-prompt');
  const {ToolRuntime}=await loadDsh('@deepseek-ai/dsh-tools');
  const {createScope}=await loadDsh('@deepseek-ai/dsh-scope');
  const {Session}=await loadDsh('@deepseek-ai/dsh-session');
  const ctx=new Context(),scopes=[];
  const prompt=ctx.plugin(SystemPrompt,{});await prompt;
  const tools=ctx.plugin(ToolRuntime,{mode:'native'});await tools;
  let state=initialState(),runs=0,reads=0;
  const store={snapshot:()=>structuredClone(state),dispatch:async(a,c)=>state=transition(state,a,c)};
  const controller=new Controller(store,{captureArtifact:async()=> 'sha256:offline'});
  const evidenceService=new VerificationService({controller,store});
  // Keep this contract test offline: use the production request validator and
  // evidence reader, replacing only the command run with a deterministic result.
  const verification={
    async run(agent,args,signal){validateVerificationCommand(args);runs++;assert.equal(agent.id,'executor');assert(signal instanceof AbortSignal);return {exitCode:0};},
    evidence(agent,args){const value=evidenceService.evidence(agent,args);reads++;assert.equal(agent.id,'reviewer');return value;}
  };
  const execute=(who,name,args,signal=new AbortController().signal)=>who.ctx.get('tools').execute({callId:'offline-'+name,name,arguments:args,agent:who,signal});
  const scoped=async(id,binding)=>{
    const agent={id,session:Session.create(id)},scope=createScope(ctx,agent);scopes.push(scope);
    agent.ctx=scope.ctx.extend({agent});controller.bind(agent,binding);
    await createRoleComposer(controller,{verification})(agent.ctx,binding);return agent;
  };
  try {
    await controller.userCommand({type:'create',id:'p',objective:'Program',workspace:'D:/project',reviewers:[{id:'r',name:'Review',responsibility:'Tests',criteria:'Pass'}]});
    const manager={id:'manager'},planner={id:'planner'};
    controller.bind(manager,{role:'coordinator',project:'p',configVersion:1});
    controller.bind(planner,{role:'reviewer',project:'p',reviewer:'r'});
    await controller.modelCommand(manager,{type:'propose',definition:{id:'a',title:'Program',criteria:'Tests',deps:[]}});
    let round=Object.values(controller.view('p').rounds).at(-1);
    const planning=await scoped('planning',{role:'reviewer',project:'p',reviewer:'r',round:round.id,generation:1,attempt:1,configVersion:1});
    assert.equal((await execute(planning,'foreman_evidence',{offset:0})).isError,true);
    await controller.modelCommand(planner,{type:'vote',round:round.id,generation:1,pass:true,findings:'Plan checked'});
    await controller.modelCommand(manager,{type:'task',id:'t',milestone:'a',title:'Implement',instructions:'Implement and test'});
    const worker=await scoped('executor',{role:'executor',project:'p',task:'t',configVersion:1,planVersion:1});
    await controller.assign(manager,worker,'t');
    const valid={command:'node',args:['test.js'],timeoutMs:1000};
    for(const args of [{...valid,timeoutMs:-1},{...valid,network:'host'},{...valid,args:[42]}])
      assert.equal((await execute(worker,'foreman_verify',args)).isError,true);
    assert.equal((await execute(worker,'foreman_evidence',{offset:0})).isError,true);
    const aborted=new AbortController();aborted.abort();
    assert.equal((await execute(worker,'foreman_verify',valid,aborted.signal)).isError,true);
    assert.equal(runs,0);
    assert.equal((await execute(worker,'foreman_verify',valid)).isError,false);assert.equal(runs,1);
    await controller.modelCommand(worker,{type:'complete',task:'t',result:'Done'});
    assert.equal((await execute(worker,'foreman_verify',valid)).isError,true);assert.equal(runs,1);
    await controller.modelCommand(manager,{type:'submit',milestone:'a'});
    round=Object.values(controller.view('p').rounds).at(-1);
    const reviewer=await scoped('reviewer',{role:'reviewer',project:'p',reviewer:'r',round:round.id,generation:1,attempt:1,configVersion:1});
    assert.equal((await execute(reviewer,'foreman_verify',valid)).isError,true);
    for(const args of [{offset:-1},{offset:0,reference:'other-snapshot'}])assert.equal((await execute(reviewer,'foreman_evidence',args)).isError,true);
    assert.equal(reads,0);
    assert.equal((await execute(reviewer,'foreman_evidence',{offset:0})).isError,false);assert.equal(reads,1);
    await controller.modelCommand(reviewer,{type:'vote',round:round.id,generation:1,pass:true,findings:'Checked'});
    assert.equal((await execute(reviewer,'foreman_evidence',{offset:0})).isError,true);assert.equal(reads,1);
  } finally {for(const scope of scopes.reverse())await scope.dispose();await tools.dispose();await prompt.dispose();}
});

test('driver uses installed AgentRegistry ownership and real durable Inbox events',async()=>{
  const {Context}=await loadDsh('@deepseek-ai/cordis');
  const {AgentRegistry}=await loadDsh('@deepseek-ai/dsh-agent');
  const {Session}=await loadDsh('@deepseek-ai/dsh-session');
  const ctx=new Context(),bindings=new WeakMap(),calls=[];
  const registryFiber=ctx.plugin(AgentRegistry);await registryFiber;
  ctx.provide('sessions',{flush:async()=>true});
  const remove=ctx.agents.setFactory({
    async createAgent(owner,options) {
      assert(owner.get('agents'));
      assert.equal(owner.get('agent'),undefined);
      assert.equal(options.meta.cwd,'D:/project');
      const session=Session.create(options.sessionId);
      const agent={id:session.id,session,followup:message=>session.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[message]})};
      const setup=await options.setup({agent});setup.commit();
      calls.push('create');return {agent,dispose:async()=>calls.push('dispose')};
    },
    async resume(owner,options) {
      calls.push('resume');
      return this.createAgent(owner,{...options,sessionId:options.resumeSessionId,meta:{cwd:'D:/project'}});
    }
  });
  const controller={bind:(a,b)=>{bindings.set(a,b);return ()=>bindings.delete(a);}};
  const driver=new DshAgentDriver(ctx,controller,{compose:async()=>{}});
  try {
    const agent=await driver.create({role:'reviewer',project:'p',reviewer:'r'},{cwd:'D:/project'});
    await driver.send(agent,{id:'receipt-1',text:'Review this'});
    assert.equal(receiptEvidence(sessionEvents(agent.session),{messageId:'receipt-1',text:'Review this'}),'present');
    await driver.dispose(agent);assert.equal(bindings.has(agent),false);
    await driver.create({role:'reviewer',project:'p',reviewer:'r'},{persistedSessionId:agent.id});
    assert(calls.includes('resume'));
  } finally {await driver.close();remove();await registryFiber.dispose();}
});

test('installed DSH message constructor accepts the driver provenance format', async()=>{
  const llm=await loadDsh('@deepseek-ai/dsh-llm');
  // Construction itself exercises this installed version's durable message value validation.
  const names=Object.keys(llm).filter(n=>/userMessage/i.test(n));
  assert(names.length>0,'Expected a user-message constructor in installed DSH');
  const make=llm[names.find(n=>n==='userMessage') ?? names[0]];
  const result=make({content:[{type:'text',text:'Inspect the milestone'}],source:{kind:'plugin:dsh-foreman-next'}});
  assert.equal(result.role,'user');assert.equal(result.source.kind,'plugin:dsh-foreman-next');
});

test('a V3 foreman inbox receipt survives the installed V4 migration without another send',async()=>{
  const {createSessionFormatCatalogWithChildren}=await loadDsh('@deepseek-ai/dsh-session-format-catalog');
  const reader=createSessionFormatCatalogWithChildren([]).createRestore({type:'session',version:3,id:'old',createdAt:1,delegationDepth:0,isSeeded:false},{recovery:'strict',validation:'current'});
  const job={messageId:'old-receipt',text:'Review this'};
  const oldMessage={id:job.messageId,role:'user',content:[{type:'text',text:job.text}],source:{kind:'plugin',plugin:'dsh-foreman-next'}};
  reader.decodeRow({type:'agent/inbox/spliced',seq:0,time:1,data:{target:'next-turn',start:0,inserted:[oldMessage]}});
  const migrated=reader.finish().events;
  assert.equal(migrated[0].data.inserted[0].source.kind,'plugin:dsh-foreman-next');
  assert.equal(receiptEvidence(migrated,job),'present');
  assert.equal(receiptEvidence([{type:'agent/inbox/spliced',data:{inserted:[oldMessage]}}],job),'present');
  assert.throws(()=>receiptEvidence(migrated,{...job,text:'Changed'}),/conflicting/);
});

test('host entry mounts on actual Cordis and disposes its journal lock', async()=>{
  const {Context}=await loadDsh('@deepseek-ai/cordis');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-cordis-test-'));
  const ctx=new Context();
  let handler,removed=false;
  try {
    ctx.provide('agents',{});ctx.provide('sessions',{});
    ctx.provide('webServer',{});
    ctx.provide('connection',{rpc:{handle(channel,callback){assert.equal(channel,'/foreman-next');handler=callback;return async()=>{removed=true;};}}});
    let modelCalls=0;
    ctx.get('agents').create=()=>{modelCalls++;throw new Error('Must remain gated');};
    ctx.provide('sessionPersistence',{readFrom:async()=>{throw new Error('Must remain gated');}});
    const fiber=ctx.plugin(hostPlugin,{storageRoot:dir,scheduler:{enabled:true,intervalMs:50}});
    await fiber;
    const service=ctx.get('foremanNext');
    assert(service,'foremanNext must activate');
    assert.deepEqual(service.list(),[]);
    assert.equal(service.readiness().readyForProjects,false);
    assert(service.readiness().checks.find(c=>c.id==='dashboard').configured);
    assert(service.readiness().blockers.some(b=>b.id==='model'));
    await new Promise(r=>setTimeout(r,15));
    assert.equal(service.readiness().scheduler.started,true);
    assert.equal(service.readiness().automaticScheduler,false);assert.equal(modelCalls,0);
    assert(handler,'Optional Connection injection should mount');
    assert.equal((await handler('snapshot',{})).value.projects.length,0);
    assert.equal((await handler('deliver',{project:'p'})).ok,false);
    await fiber.dispose();
    assert.equal(removed,true);
    assert.equal(service.readiness().checks.find(c=>c.id==='dashboard').configured,false);
    await assert.rejects(fs.stat(path.join(dir,'writer.lock')),{code:'ENOENT'});
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('outer tools use the actual DSH confirmation service and are revoked with their scope',async()=>{
  const {Context}=await loadDsh('@deepseek-ai/cordis');
  const {SystemPrompt}=await loadDsh('@deepseek-ai/dsh-system-prompt');
  const {ToolRuntime}=await loadDsh('@deepseek-ai/dsh-tools');
  const {createScope}=await loadDsh('@deepseek-ai/dsh-scope');
  const {Session}=await loadDsh('@deepseek-ai/dsh-session');
  const {UserQuestionService}=await loadDsh('@deepseek-ai/dsh-user-questions');
  const ctx=new Context(),root={id:'outer',session:Session.create('outer')},sibling={id:'sibling',session:Session.create('sibling')};
  ctx.provide('agents',{get:id=>[root,sibling].find(a=>a.id===id),roots:()=>[root,sibling]});
  const prompt=ctx.plugin(SystemPrompt,{}),tools=ctx.plugin(ToolRuntime,{}),questions=ctx.plugin(UserQuestionService,{});await Promise.all([prompt,tools,questions]);
  let state=initialState(),asked=0;
  const store={snapshot:()=>structuredClone(state),dispatch:async(a,c)=>state=transition(state,a,c)};
  const controller=new Controller(store,{captureArtifact:async()=>{throw new Error('Not connected');}});
  const control=new UserControl(controller,{agents:ctx.get('agents'),userQuestions:ctx.get('userQuestions')},{canStart:()=>true});
  const unregister=ctx.on('user-questions/request',async q=>{asked++;assert.equal(q.agent,root);assert.match(q.questions[0].detail,asked===1?/质量/:/项目ID：p/);return {answers:[{id:q.questions[0].id,selected:['确认执行']}]};});
  const scope=createScope(ctx,root),other=createScope(ctx,sibling);root.ctx=scope.ctx.extend({agent:root});sibling.ctx=other.ctx.extend({agent:sibling});
  const execute=(who,name,args={})=>who.ctx.get('tools').execute({callId:'outer-test',name,arguments:args,agent:who,signal:new AbortController().signal});
  let forbidden=false;
  try {
    await createOuterComposer(control,{snapshot:()=>({revision:state.revision})})(root.ctx);
    root.ctx.get('tools').register({name:'write_file',description:'Forbidden',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=>{forbidden=true;return 'bad';}});
    assert.equal((await execute(root,'write_file')).isError,true);assert.equal(forbidden,false);
    assert.equal((await execute(sibling,'foreman_status')).isError,true);
    assert.equal((await execute(root,'foreman_user_request',{command:JSON.stringify({type:'create',id:'p',objective:'Example',workspace:'D:/example',reviewers:[{id:'r',name:'质量',responsibility:'检查功能',criteria:'行为正确'}]})})).isError,false);
    assert.equal(asked,1);assert.equal(state.projects.p.audit[0].command.userApproval.source,'dsh-user-questions');
    assert.equal((await execute(root,'foreman_user_request',{command:JSON.stringify({type:'propose',project:'p'})})).isError,true);
    await controller.userCommand({type:'cancel',project:'p'});
    assert.equal((await execute(sibling,'foreman_user_request',{command:JSON.stringify({type:'archive',project:'p'})})).isError,true);
    assert.equal((await execute(root,'foreman_user_request',{command:JSON.stringify({type:'archive',project:'p'})})).isError,false);
    assert.equal(state.projects.p.archived,true);assert.equal(state.projects.p.status,'cancelled');
    assert.equal(state.projects.p.audit.at(-1).command.userApproval.source,'dsh-user-questions');
    assert.equal((await execute(root,'foreman_user_request',{command:JSON.stringify({type:'unarchive',project:'p'})})).isError,false);
    assert.equal(state.projects.p.archived,false);assert.equal(state.projects.p.status,'cancelled');assert.equal(asked,3);
    assert.equal((await execute(root,'foreman_user_request',{command:JSON.stringify({type:'archive',project:'p'})})).isError,false);
    assert.equal((await execute(sibling,'foreman_user_request',{command:JSON.stringify({type:'delete-project',project:'p'})})).isError,true);
    assert.equal((await execute(root,'foreman_user_request',{command:JSON.stringify({type:'delete-project',project:'p'})})).isError,false);
    assert.equal(state.projects.p.deleted,true);assert.equal(state.projects.p.status,'cancelled');assert.equal(asked,5);assert.equal(state.projects.p.audit.at(-1).command.userApproval.source,'dsh-user-questions');
    assert.equal((await execute(root,'foreman_user_request',{command:JSON.stringify({type:'unarchive',project:'p'})})).isError,true);assert.equal(asked,5);
    await scope.dispose();assert.throws(()=>control.authorizeRoot(root),/bound live/);
  } finally {await scope.dispose();await other.dispose();unregister();await questions.dispose();await tools.dispose();await prompt.dispose();await controller.close();}
});

test('host and outer plugin mount together and host disposal cancels a pending native confirmation',{timeout:5000},async()=>{
  const {Context}=await loadDsh('@deepseek-ai/cordis');
  const {SystemPrompt}=await loadDsh('@deepseek-ai/dsh-system-prompt');
  const {ToolRuntime}=await loadDsh('@deepseek-ai/dsh-tools');
  const {createScope}=await loadDsh('@deepseek-ai/dsh-scope');
  const {Session}=await loadDsh('@deepseek-ai/dsh-session');
  const {UserQuestionService}=await loadDsh('@deepseek-ai/dsh-user-questions');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-outer-host-'));
  const seed=await JournalStore.open(dir);
  await seed.dispatch({role:'user'},{type:'create',id:'p',objective:'Existing offline project',workspace:'D:/example',reviewers:[{id:'r',name:'Quality',responsibility:'Behavior',criteria:'Pass'}]});await seed.close();
  const ctx=new Context(),root={id:'outer-mounted',session:Session.create('outer-mounted')};
  ctx.provide('agents',{get:id=>id===root.id?root:undefined,roots:()=>[root]});ctx.provide('sessions',{});
  const prompt=ctx.plugin(SystemPrompt,{}),tools=ctx.plugin(ToolRuntime,{}),questions=ctx.plugin(UserQuestionService,{});await Promise.all([prompt,tools,questions]);
  let answer,shown;
  const unregister=ctx.on('user-questions/request',q=>{shown=q;return new Promise(r=>answer=r);});
  const host=ctx.plugin(hostPlugin,{storageRoot:dir});await host;
  const scope=createScope(ctx,root);root.ctx=scope.ctx.extend({agent:root});
  const outer=root.ctx.plugin(outerPlugin);await outer;
  const execute=(name,args={})=>root.ctx.get('tools').execute({callId:'mounted-'+name,name,arguments:args,agent:root,signal:new AbortController().signal});
  try {
    assert.equal((await execute('foreman_status')).isError,false);
    const misplaced=root.ctx.plugin(hostPlugin,{storageRoot:dir});
    await assert.rejects(Promise.resolve(misplaced),/host plane/);await misplaced.dispose();
    const publicService=ctx.get('foremanNext');
    assert.deepEqual(Object.keys(publicService).sort(),['list','readiness','snapshot','view']);
    assert.equal((await execute('foreman_user_request',{command:JSON.stringify({type:'create',id:'new'})})).isError,true);
    assert.equal(answer,undefined,'Production startup gate must reject before a question');
    const pending=execute('foreman_user_request',{command:JSON.stringify({type:'cancel',project:'p'})});
    while(!answer)await new Promise(r=>setImmediate(r));
    await host.dispose();assert.equal(shown.signal.aborted,true);
    assert.equal((await pending).isError,true);
    answer({answers:[{id:shown.questions[0].id,selected:['确认执行']}]});await new Promise(r=>setImmediate(r));
    assert.equal((await execute('foreman_status')).isError,true);
    const restored=await JournalStore.open(dir);assert.equal(restored.snapshot().projects.p.status,'running');await restored.close();
  } finally {await outer.dispose();await scope.dispose();await host.dispose();unregister();await questions.dispose();await tools.dispose();await prompt.dispose();await fs.rm(dir,{recursive:true,force:true});}
});

test('one standing outer preset serves separate roots, excludes children and revokes on disposal or preset switch',{timeout:5000},async()=>{
  const {Context}=await loadDsh('@deepseek-ai/cordis');
  const {SystemPrompt}=await loadDsh('@deepseek-ai/dsh-system-prompt');
  const {ToolRuntime}=await loadDsh('@deepseek-ai/dsh-tools');
  const {createScope,bindScopeParent}=await loadDsh('@deepseek-ai/dsh-scope');
  const {Session}=await loadDsh('@deepseek-ai/dsh-session');
  const {AgentRegistry}=await loadDsh('@deepseek-ai/dsh-agent');
  const {UserQuestionService}=await loadDsh('@deepseek-ai/dsh-user-questions');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-standing-'));
  const seed=await JournalStore.open(dir);await seed.dispatch({role:'user'},{type:'create',id:'p',objective:'Offline',workspace:'D:/example',reviewers:[{id:'r',name:'Quality',responsibility:'Behavior',criteria:'Pass'}]});await seed.close();
  const ctx=new Context();ctx.provide('sessions',{});
  const dependencies=[ctx.plugin(SystemPrompt,{}),ctx.plugin(ToolRuntime,{}),ctx.plugin(UserQuestionService,{}),ctx.plugin(AgentRegistry)];await Promise.all(dependencies);
  const host=ctx.plugin(hostPlugin,{storageRoot:dir});await host;
  const key={},standing=createScope(ctx,key),outer=standing.ctx.plugin(outerPlugin);await outer;
  const agents=['first','second','child','other'].map(id=>({id,session:Session.create(id)}));
  const scopes=agents.map(a=>createScope(ctx,a));agents.forEach((a,i)=>a.ctx=scopes[i].ctx.extend({agent:a}));
  const parents=agents.slice(0,3).map(a=>bindScopeParent(a,key));
  const registry=ctx.get('agents'),detach=agents.map((a,i)=>registry.enter(a,i===2?agents[0]:undefined));agents.forEach(a=>registry.announce(a));
  let answer,shown;
  const unregister=ctx.on('user-questions/request',q=>{shown=q;return new Promise(r=>answer=r);});
  const execute=(agent,name='foreman_status',args={})=>agent.ctx.get('tools').execute({callId:'standing-'+agent.id,name,arguments:args,agent,signal:new AbortController().signal});
  try {
    const firstRead=await execute(agents[0]);assert.equal(firstRead.isError,false,JSON.stringify(firstRead));assert.equal((await execute(agents[1])).isError,false);
    let extraRan=false;
    ctx.get('tools').register({name:'late_global_shell',description:'Forbidden late capability',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=>{extraRan=true;return 'bad';}});
    assert.equal((await execute(agents[0],'late_global_shell')).isError,true);assert.equal(extraRan,false);
    assert.equal((await execute(agents[2])).isError,true);assert.equal((await execute(agents[3])).isError,true);
    const first=execute(agents[0],'foreman_user_request',{command:JSON.stringify({type:'cancel',project:'p'})});
    while(!answer)await new Promise(r=>setImmediate(r));detach[0]();
    assert.equal((await first).isError,true);assert.equal(shown.signal.aborted,true);
    assert.equal((await execute(agents[1])).isError,false);
    answer({answers:[{id:shown.questions[0].id,selected:['确认执行']}]});answer=undefined;
    const second=execute(agents[1],'foreman_user_request',{command:JSON.stringify({type:'cancel',project:'p'})});
    while(!answer)await new Promise(r=>setImmediate(r));parents[1].rebind({});
    answer({answers:[{id:shown.questions[0].id,selected:['确认执行']}]});assert.equal((await second).isError,true);
    assert.equal(ctx.get('foremanNext').view('p').status,'running');
  } finally {unregister();detach.forEach(fn=>fn());await outer.dispose();await standing.dispose();for(const scope of scopes)await scope.dispose();await host.dispose();for(const fiber of dependencies.reverse())await fiber.dispose();await fs.rm(dir,{recursive:true,force:true});}
});
