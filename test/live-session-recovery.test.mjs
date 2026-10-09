import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {openApplication} from '../src/application.mjs';
import {DshAgentDriver} from '../src/controller.mjs';
import {SessionRecovery,assertEmptySession} from '../src/session-recovery.mjs';
import {UserControl} from '../src/user-control.mjs';

const requireDsh=createRequire(path.join(process.env.DSH_TEST_INSTALL??'C:/example/dsh/node/node_modules/@deepseek-ai/dsh','package.json'));
const load=async name=>import(pathToFileURL(requireDsh.resolve('@deepseek-ai/'+name)).href);

test('installed DSH drains a live empty agent, revokes it, and lets its replacement submit a plan without model calls',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-live-recovery-'));
  const work=path.join(root,'work'),home=path.join(root,'home'),sessions=path.join(home,'sessions');
  await fs.mkdir(work);await fs.mkdir(sessions,{recursive:true});
  const app=await openApplication({storageRoot:path.join(root,'journal'),dshHome:home,sessionRoot:sessions});
  const [{Context},{SessionStore},{default:JsonlSessionPersistence},{AgentRegistry},{LlmRuntime},{ToolRuntime},{SystemPrompt},{AgentLoop},{Session},{default:SessionProjectionRegistry}]=await Promise.all([
    load('cordis'),load('dsh-session'),load('dsh-session-persistence-jsonl'),load('dsh-agent'),load('dsh-llm'),load('dsh-tools'),load('dsh-system-prompt'),load('dsh-agent-loop'),load('dsh-session'),load('dsh-session-projection')]);
  const ctx=new Context(),fibers=[];let oldDriver,newDriver,control,detach,requests=0;
  try {
    for(const [plugin,config] of [[SessionStore,{}],[SessionProjectionRegistry,{}],[JsonlSessionPersistence,{root:sessions}],[AgentRegistry,{}],[LlmRuntime,{}],[ToolRuntime,{mode:'native'}],[SystemPrompt,{}],[AgentLoop,{agents:[]}]]) {
      const fiber=ctx.plugin(plugin,config);fibers.push(fiber);await fiber;
    }
    ctx.on('llm/stream',async function*(){requests++;throw Error('No model calls allowed in recovery test');});
    await app.controller.userCommand({type:'create',id:'p',objective:'Live recovery fixture',workspace:work,reviewers:[{id:'r',name:'Quality',responsibility:'Tests',criteria:'Pass'}]});
    const binding={role:'coordinator',project:'p',configVersion:1},key='coordinator:p:1',oldId=randomUUID();
    await app.store.dispatchRuntime({type:'reserve-agent',key,sessionId:oldId,binding});
    await app.store.dispatchRuntime({type:'begin-agent',key,sessionId:oldId});
    oldDriver=new DshAgentDriver(ctx,app.controller,{compose:app.compose});
    const old=await oldDriver.create(binding,{cwd:work,sessionId:oldId});
    assert.equal(ctx.get('agents').get(oldId),old);
    assert.equal(await oldDriver.checkpoint(old),false);
    await assertEmptySession(ctx.get('sessionPersistence'),oldId);
    await app.store.dispatchRuntime({type:'incident',project:'p',key:'agent:'+key,message:'Injected interruption before first durable inbox delivery'});
    const notification=app.store.snapshot().runtimeIncidents['p:agent:'+key].notificationId;
    const before=app.controller.view('p');let drained=false;
    const recovery=new SessionRecovery({controller:app.controller,store:app.store,context:()=>ctx,
      maintenance:async operation=>{await oldDriver.close();drained=true;assert.equal(ctx.get('agents').get(oldId),undefined);return operation();}});
    const outerId=randomUUID(),outer={id:outerId,session:Session.create(outerId)};detach=ctx.get('agents').enter(outer);
    control=new UserControl(app.controller,{agents:ctx.get('agents'),userQuestions:{ask:async q=>({answers:[{id:q.questions[0].id,selected:['确认执行']}]})}},{recovery});
    control.bindRoot(outer);
    assert.equal((await control.request(outer,{type:'recover-empty-session',project:'p',notification})).applied,true);
    assert.equal(drained,true);assert.throws(()=>app.controller.identity(old));
    const record=app.store.snapshot().runtimeAgents[key];assert.notEqual(record.sessionId,oldId);
    assert.deepEqual(app.controller.view('p').reviewers,before.reviewers);
    assert.deepEqual(app.controller.view('p').milestones,before.milestones);
    newDriver=new DshAgentDriver(ctx,app.controller,{compose:app.compose});
    const replacement=await newDriver.create(binding,{cwd:work,sessionId:record.sessionId});
    const command={type:'propose',definition:{id:'next',title:'Continue',criteria:'Replacement can submit a plan',deps:[]}};
    await assert.rejects(app.controller.modelCommand(old,command));
    const result=await replacement.ctx.get('tools').execute({callId:randomUUID(),name:'foreman_command',arguments:{command:JSON.stringify(command)},agent:replacement,signal:new AbortController().signal});
    assert.equal(result.isError,false,JSON.stringify(result));
    assert(app.controller.view('p').milestones.next);
    assert(app.controller.view('p').audit.some(a=>a.actorId===record.sessionId));
    assert.equal(app.store.snapshot().sessionRecoveries.length,1);
    assert.equal(requests,0);
  } finally {
    control?.close();detach?.();await newDriver?.close();await oldDriver?.close();
    for(const fiber of fibers.reverse())await fiber.dispose();await app.close();
    await fs.rm(root,{recursive:true,force:true});
  }
});
