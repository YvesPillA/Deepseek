import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Controller,DshAgentDriver} from '../src/controller.mjs';
import {JournalStore} from '../src/store.mjs';
import {ExecutionMonitor} from '../src/execution-monitor.mjs';
import {planExecutionDeliveries,pendingAssignments} from '../src/execution-scheduler.mjs';
import {readStoredSession} from '../src/stored-session.mjs';
import {UserControl} from '../src/user-control.mjs';

const requireDsh=createRequire(path.join(process.env.DSH_TEST_INSTALL??'C:/example/dsh/node/node_modules/@deepseek-ai/dsh','package.json'));
const load=async name=>import(pathToFileURL(requireDsh.resolve('@deepseek-ai/'+name)).href);
const runtimeVersion=requireDsh('@deepseek-ai/dsh-agent-loop/package.json').version;
const v2Contract={timeout:15000,skip:runtimeVersion==='0.2.0-rc.2'?false:`Requires the 0.2.0-rc.2 framework contract; selected ${runtimeVersion}`};
async function runtimeFixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-v2-runtime-'));
  const [{Context},{SessionStore,Session},{default:JsonlSessionPersistence},{AgentRegistry},{LlmRuntime},{ToolRuntime},{SystemPrompt},{AgentLoop},{default:SessionProjectionRegistry},{UserQuestionService}]=await Promise.all([
    load('cordis'),load('dsh-session'),load('dsh-session-persistence-jsonl'),load('dsh-agent'),load('dsh-llm'),load('dsh-tools'),load('dsh-system-prompt'),load('dsh-agent-loop'),load('dsh-session-projection'),load('dsh-user-questions')]);
  const ctx=new Context(),fibers=[];
  try {
    for(const [plugin,config] of [[SessionStore,{}],[SessionProjectionRegistry,{}],[JsonlSessionPersistence,{root:path.join(root,'sessions')}],[AgentRegistry,{}],[LlmRuntime,{}],[ToolRuntime,{mode:'native'}],[SystemPrompt,{}],[AgentLoop,{agents:[]}],[UserQuestionService,{}]]) {
      const fiber=ctx.plugin(plugin,config);fibers.push(fiber);await fiber;
    }
    let modelCalls=0;
    ctx.on('llm/stream',async function*(){modelCalls++;throw Error('Offline v2 contract test forbids model calls');});
    return {root,ctx,Session,modelCalls:()=>modelCalls,close:async()=>{
      for(const fiber of fibers.reverse())await fiber.dispose();await fs.rm(root,{recursive:true,force:true});
    }};
  } catch(error) {for(const fiber of fibers.reverse())await fiber.dispose();await fs.rm(root,{recursive:true,force:true});throw error;}
}

test('actual AgentLoop repairs a failed step without settling or redispatching its foreman task',v2Contract,async()=>{
  const f=await runtimeFixture();let store=await JournalStore.open(path.join(f.root,'journal')),driver;
  try {
    const controller=new Controller(store,{captureArtifact:async()=> 'snapshot:test'});
    await controller.userCommand({type:'create',id:'p',objective:'Check v2 recovery',workspace:f.root,reviewers:[{id:'r',name:'Quality',responsibility:'Verify',criteria:'Pass'}]});
    const boss={id:'boss'};controller.bind(boss,{role:'coordinator',project:'p',configVersion:1});
    await controller.modelCommand(boss,{type:'propose',definition:{id:'m',title:'Implement',criteria:'Working',deps:[]}});
    const round=Object.values(store.snapshot().projects.p.rounds).at(-1),reviewer={id:'reviewer'};
    controller.bind(reviewer,{role:'reviewer',project:'p',reviewer:'r',configVersion:1,round:round.id,generation:1,attempt:1});
    await controller.modelCommand(reviewer,{type:'vote',round:round.id,generation:1,pass:true,findings:'Plan checked'});
    await controller.modelCommand(boss,{type:'task',milestone:'m',id:'t',title:'Implement',instructions:'Inspect files'});
    driver=new DshAgentDriver(f.ctx,controller,{compose:async()=>{}});
    const worker=await driver.create({role:'executor',project:'p',task:'t',configVersion:1,planVersion:1,taskAttempt:1},{sessionId:randomUUID(),cwd:f.root});
    await controller.assign(boss,worker,'t');
    const job=planExecutionDeliveries(store.snapshot())[0];await store.dispatchOutbox(job);
    // Inject an internal scheduler fault at the real driver's step boundary.
    // The actual AgentLoop owns recovery, step/end, turn/end and idle transition.
    const {createAssistantMessage}=await load('dsh-llm');
    let stepCalls=0;
    worker.step=async()=>{
      stepCalls++;const {turn,step}=worker.phase;
      const blocks=['completed','unknown','not-started'].map(id=>({type:'tool-call',id,name:'fixture-write',arguments:'{}'}));
      worker.session.append('assistant/message',{turn,step,message:createAssistantMessage({content:blocks,source:{provider:'offline-fixture',model:'offline-fixture'}})},{surfaceOp:'append'});
      worker.session.append('tool/call',{turn,step,callId:'completed',name:'fixture-write',arguments:'{}'});
      worker.session.append('tool/result',{turn,step,message:{id:'actual-result',role:'tool',toolCallId:'completed',isError:false,source:{kind:'tool',callId:'completed'},content:[{type:'text',text:'success'}]}},{surfaceOp:'append'});
      worker.session.append('tool/call',{turn,step,callId:'unknown',name:'fixture-write',arguments:'{}'});
      await fs.writeFile(path.join(f.root,'partial.txt'),'Side effect survives the missing result');
      throw Error('Injected internal scheduler failure');
    };
    await driver.send(worker,{id:job.messageId,text:job.text});await worker.whenIdle();
    assert.equal(worker.status,'idle');assert.equal(stepCalls,1);await f.ctx.sessions.flush(worker.session);
    const stored=await readStoredSession(f.ctx.sessionPersistence,worker.id),results=stored.events.filter(e=>e.type==='tool/result');
    assert.equal(results.length,3);assert.equal(results[0].data.message.id,'actual-result');
    assert.deepEqual(results.slice(1).map(e=>[e.data.message.source.callId,e.data.error.code]),[['unknown','TOOL_OUTCOME_UNKNOWN'],['not-started','TOOL_NOT_STARTED']]);
    assert.equal(stored.events.at(-1).type,'turn/end');assert.equal(stored.events.at(-1).data.reason.kind,'error');
    const outboxJob={...job,status:'delivered'};
    const monitorStore={snapshot:()=>({...store.snapshot(),outbox:{[job.id]:outboxJob}})};
    const monitor=new ExecutionMonitor(monitorStore,controller,{lookup:()=>worker,retire:()=>driver.dispose(worker)});
    await monitor.poll();await monitor.poll();
    const task=store.snapshot().projects.p.tasks.t;
    assert.equal(task.status,'failed');assert.equal(task.attempt,1);assert.equal(task.failures.length,1);
    assert.match(task.failures[0].error,/TOOL_OUTCOME_UNKNOWN（callId=unknown）/);
    assert.match(task.failures[0].error,/TOOL_NOT_STARTED（callId=not-started）/);
    assert.equal(store.snapshot().projects.p.completions,0);assert.deepEqual(pendingAssignments(store.snapshot()),[]);
    assert.equal(f.ctx.agents.get(worker.id),undefined);assert.throws(()=>controller.identity(worker));
    assert.equal(await fs.readFile(path.join(f.root,'partial.txt'),'utf8'),'Side effect survives the missing result');
    await store.close();store=await JournalStore.open(path.join(f.root,'journal'));
    assert.deepEqual(store.snapshot().projects.p.tasks.t,task);assert.deepEqual(pendingAssignments(store.snapshot()),[]);
    assert.equal(f.modelCalls(),0);
  } finally {await driver?.close();await store.close();await f.close();}
});

test('execution recovery details only include the delivered message claimed turn',async()=>{
  const job={id:'j',project:'p',recipient:'w',messageId:'msg',status:'delivered',subject:{protocol:'foreman-execution-v1',task:'t',milestone:'m',configVersion:1,planVersion:1,taskAttempt:2}};
  const state={outbox:{j:job},projects:{p:{status:'running',configVersion:1,milestones:{m:{status:'work',planVersion:1,deps:[]}},tasks:{t:{status:'running',assigned:'w',milestone:'m',configVersion:1,planVersion:1,attempt:2}}}}};
  const result=(turn,id)=>({type:'tool/result',data:{turn,error:{code:'TOOL_OUTCOME_UNKNOWN'},message:{source:{callId:id}}}});
  const events=[{type:'turn/start',data:{turn:1}},result(1,'old-call'),{type:'turn/end',data:{turn:1}},
    {type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{id:'msg'}]}},
    {type:'turn/start',data:{turn:2}},{type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},result(2,'current-call'),{type:'turn/end',data:{turn:2}},
    {type:'turn/start',data:{turn:3}},result(3,'later-call'),{type:'turn/end',data:{turn:3}}];
  let fault;
  await new ExecutionMonitor({snapshot:()=>state},{executionFaultIfCurrent:async(_agent,details)=>{fault=details;}},{lookup:()=>({status:'idle',session:{snapshotEvents:()=>events}}),retire:()=>{}}).poll();
  assert.equal(fault.taskAttempt,2);assert.match(fault.error,/current-call/);assert.doesNotMatch(fault.error,/old-call|later-call/);
});

test('actual legacy UserQuestions approval stays blocking and checks live runtime ownership',v2Contract,async()=>{
  const f=await runtimeFixture(),store=await JournalStore.open(path.join(f.root,'journal'));
  let control,detachRoot,detachChild;
  try {
    const controller=new Controller(store,{captureArtifact:async()=> 'snapshot:test'});
    const root={id:randomUUID()};root.session=f.Session.create(root.id);detachRoot=f.ctx.agents.enter(root);
    const child={id:randomUUID()};child.session=f.Session.create(child.id);detachChild=f.ctx.agents.enter(child,root);
    let answer,shown;
    f.ctx.on('user-questions/request',(request)=>{shown=request;return new Promise(resolve=>{answer=resolve;});},{global:true});
    control=new UserControl(controller,{agents:f.ctx.agents,userQuestions:f.ctx.userQuestions},{canStart:()=>true});control.bindRoot(root);
    const request=control.request(root,{type:'create',id:'p',objective:'Legacy approval',workspace:f.root,reviewers:[{id:'r',name:'Quality',responsibility:'Check',criteria:'Pass'}]});
    while(!answer)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(store.snapshot().revision,0);assert.equal(shown.agent,root);assert.equal(shown.questions[0].intent.kind,'plan-review');
    answer({answers:[{id:shown.questions[0].id,selected:['确认执行']}]});assert.equal((await request).applied,true);
    await assert.rejects(f.ctx.userQuestions.ask({agent:{...root},questions:shown.questions}),error=>error.code==='CALLER_NOT_LIVE');
    await assert.rejects(f.ctx.userQuestions.ask({agent:child,questions:shown.questions}),error=>error.code==='DELEGATED_CALLER');
    const tool=await load('dsh-tool-ask-user');assert.equal(tool.Config({}).mode,'legacy');
    assert.equal(f.modelCalls(),0);
  } finally {control?.close();detachChild?.();detachRoot?.();await store.close();await f.close();}
});
