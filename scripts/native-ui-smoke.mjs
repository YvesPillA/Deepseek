// Isolated, opt-in real browser confirmation fixture. Never installed in DSH.
// No model adapter is invoked: requests go through the actual outer tool and
// web user-question provider; the browser must answer them.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openApplication} from '../src/application.mjs';
import {UserControl} from '../src/user-control.mjs';
import {createOuterComposer} from '../src/outer-tools.mjs';
import {SessionRecovery,assertEmptySession} from '../src/session-recovery.mjs';
import {DshAgentDriver} from '../src/controller.mjs';
import {ForemanRuntime} from '../src/runtime.mjs';
import {RuntimeLoop} from '../src/runtime-loop.mjs';
import {sessionEvents} from '../src/stored-session.mjs';
import {selectDshRuntime} from './dsh-runtime.mjs';

export const name='foreman-native-ui-smoke';
export const inject=['agents','sessions','sessionPersistence','userQuestions','workspaceRegistry'];
export async function apply(ctx,config) {
  const root=await fs.realpath(config.root);
  assert.equal(path.dirname(root),path.resolve('C:/example/foreman-tests'));
  assert.match(path.basename(root),/^native-ui-smoke-[a-zA-Z0-9_-]+$/);
  assert.equal(path.resolve(process.env.DSH_HOME??''),path.join(root,'home'));
  assert.equal(await fs.readFile(path.join(root,'fixture-marker'),'utf8'),'isolated-native-ui-test');
  const app=await openApplication({storageRoot:path.join(root,'journal'),dshHome:path.join(root,'home'),sessionRoot:path.join(root,'home/sessions')});
  const abort=new AbortController();let handle,control,loop,oldAgent,oldId,enabled=false,firstRuntime=true;
  const runtimeSelection=selectDshRuntime();
  const report={root,runtime:{root:runtimeSelection.root,version:runtimeSelection.version},modelRequests:0,steps:[],status:'starting'};
  const save=()=>fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));
  ctx.effect(()=>async()=>{abort.abort();control?.close();await loop?.close();await handle?.dispose();await app.close();});
  const key='coordinator:ui:1',binding={role:'coordinator',project:'ui',configVersion:1};
  const compose=app.compose;
    // Deterministic local reply exercises AgentLoop -> tool -> controller after
    // recovery; it is not a DeepSeek response or evidence of model reasoning.
    let replied=false;
    // Terminal host middleware: never delegates to any network adapter.
    ctx.on('llm/stream',async function*(){
      if(!app.store.snapshot().sessionRecoveries?.length)throw Error('Fixture refuses model turns before recovery');
      if(replied){yield {type:'finish',reason:{kind:'stop'}};return;}
      replied=true;report.scriptedReplies=(report.scriptedReplies??0)+1;
      const block={type:'tool-call',id:'fixture-'+randomUUID(),name:'foreman_command',arguments:JSON.stringify({command:JSON.stringify({type:'propose',definition:{id:'recovered',title:'恢复后继续规划',criteria:'新代理通过调度与真实工具提交计划',deps:[]}})})};
      yield {type:'block-start',index:0,blockType:'tool-call'};
      yield {type:'block-end',index:0,block};
      yield {type:'finish',reason:{kind:'tool-calls'}};
    });
  loop=new RuntimeLoop({intervalMs:1000,enabled:()=>enabled,create:async()=>{
    const driver=new DshAgentDriver(ctx,app.controller,{compose});
    if(!firstRuntime)return new ForemanRuntime(app.store,app.controller,driver,ctx,{model:{provider:'deepseek-official',model:'deepseek-flash',maxTokens:4096}});
    firstRuntime=false;let injected=false;
    return {close:()=>driver.close(),tick:async()=>{
      if(injected)return;injected=true;oldId=randomUUID();
      try {
      await app.store.dispatchRuntime({type:'reserve-agent',key,sessionId:oldId,binding});
      await app.store.dispatchRuntime({type:'begin-agent',key,sessionId:oldId});
      oldAgent=await driver.create(binding,{cwd:path.join(root,'work'),sessionId:oldId});
      report.emptyCheckpointResult=await driver.checkpoint(oldAgent);
      // Full web profiles pin permission metadata before publishing an agent.
      // Reproduce loss of its first durable log without deleting the evidence.
      // Only this fresh fixture agent is eligible; it has executed no model turn.
      assert(sessionEvents(oldAgent.session).every(e=>['permission/preset','sandbox/mode','approval/policy'].includes(e.type)));
      report.initialEventTypes=sessionEvents(oldAgent.session).map(e=>e.type);
      for(const entry of await fs.readdir(path.join(root,'home/sessions'),{withFileTypes:true})) {
        if(!entry.isDirectory())continue;
        const candidate=path.join(root,'home/sessions',entry.name,oldId);
        try {await fs.rename(candidate,path.join(root,'archived-initial-session'));report.logLossInjected=true;break;}
        catch(error){if(error.code!=='ENOENT')throw error;}
      }
      await assertEmptySession(ctx.get('sessionPersistence'),oldId);
      await app.store.dispatchRuntime({type:'incident',project:'ui',key:'agent:'+key,message:'界面测试注入：真实代理已创建，首次持久投递之前中断。'});
      } catch(error) {report.injectionError=error.stack;await save();throw error;}
    }};
  }});
  const waitFor=async predicate=>{
    const deadline=Date.now()+15000;
    while(!predicate()){abort.signal.throwIfAborted();if(Date.now()>deadline)throw Error('Fixture progress timed out: '+JSON.stringify(loop.status()));await new Promise(r=>setTimeout(r,100));}
  };
  const recovery=new SessionRecovery({controller:app.controller,store:app.store,
    context:()=>({agents:ctx.get('agents'),sessionPersistence:ctx.get('sessionPersistence')}),
    maintenance:operation=>loop.runStopped(operation)});
  control=new UserControl(app.controller,{agents:ctx.get('agents'),userQuestions:ctx.get('userQuestions')},{canStart:()=>true,recovery});
  async function run() {
    handle=await ctx.get('agents').create({sessionId:randomUUID(),meta:{cwd:path.join(root,'work')},
      setup:async(agentCtx,agent)=>{
        await createOuterComposer(control,{snapshot:()=>({fixture:true})})(agentCtx,{contains:candidate=>candidate===agent});
      }});
    const agent=handle.agent;report.session=agent.id;
    agent.session.append('user/message',{id:randomUUID(),role:'user',content:[{type:'text',text:'新工头 · 零模型界面验收。依次测试：拒绝开局、确认开局、拒绝空会话接管、确认接管。只操作这个隔离测试项目。'}],source:{kind:'plugin:dsh-foreman-next'}},{surfaceOp:'append'});
    assert.equal(await ctx.get('sessions').flush(agent.session),true);
    const workspace=await ctx.get('workspaceRegistry').create(path.join(root,'work'),'新工头界面验收');
    await workspace.attachSession(agent.id);
    await save();
    const request=async(command,step)=>{
      report.status=step;await save();
      const result=await agent.ctx.get('tools').execute({callId:randomUUID(),name:'foreman_user_request',arguments:{command:JSON.stringify(command)},agent,signal:abort.signal});
      assert(!result.isError,JSON.stringify(result));
      report.steps.push({step,result});await save();
    };
    const create={type:'create',id:'ui',objective:'零模型界面验收：请第一轮选取消，第二轮确认。',workspace:path.join(root,'work'),
      reviewers:[{id:'quality',name:'测试监督',responsibility:'仅用于确认流程验收',criteria:'不启动执行任务'}],denialLimit:3,patrolEvery:3};
    await request(create,'decline-create');assert.equal(app.store.snapshot().projects.ui,undefined);
    await request(create,'approve-create');assert.equal(app.controller.view('ui').status,'running');
    enabled=true;loop.start();
    await waitFor(()=>!!app.store.snapshot().runtimeIncidents?.['ui:agent:'+key]);
    const notification=app.store.snapshot().runtimeIncidents['ui:agent:'+key].notificationId;
    const command={type:'recover-empty-session',project:'ui',notification};
    await request(command,'decline-recovery');assert.equal(app.store.snapshot().runtimeAgents[key].sessionId,oldId);
    assert.equal(ctx.get('agents').get(oldId),oldAgent);
    const before=app.controller.view('ui');
    await request(command,'approve-recovery');
    const state=app.store.snapshot();assert.notEqual(state.runtimeAgents[key].sessionId,oldId);
    assert(['reserved','starting','ready'].includes(state.runtimeAgents[key].phase));assert.deepEqual(app.controller.view('ui').reviewers,before.reviewers);
    assert.equal(state.sessionRecoveries.length,1);
    assert.equal(ctx.get('agents').get(oldId),undefined);assert.throws(()=>app.controller.identity(oldAgent));
    await waitFor(()=>!!app.controller.view('ui').milestones.recovered);
    await loop.close();
    const after=app.store.snapshot(),newId=state.runtimeAgents[key].sessionId;
    assert(after.projects.ui.audit.some(a=>a.actorId===newId));
    assert(Object.values(after.outbox).some(j=>j.recipient===key&&j.status==='delivered'));
    report.status='passed';report.oldSession=oldId;report.newSession=newId;
    report.liveAgentRevoked=true;report.runtimeLoopResumed=true;report.replacementPlanRecorded=true;await save();
  }
  // Allow the web provider to finish mounting before presenting the first card.
  const timer=setTimeout(()=>{run().catch(async error=>{report.status='failed';report.error=error.message;await save();});},1500);
  ctx.effect(()=>()=>clearTimeout(timer));
}
