// Deterministic native-question provider to verify delivery wiring after REAL
// model approval. No LLM calls; does not represent a human clicking the DSH UI.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {openApplication} from '../src/application.mjs';
import {UserControl} from '../src/user-control.mjs';
import {createOuterComposer} from '../src/outer-tools.mjs';
const supplied=process.argv[2];
if(!supplied||!path.isAbsolute(supplied))throw Error('Absolute model-smoke root required');
const root=await fs.realpath(supplied);
if(path.dirname(root)!==path.resolve('C:/example/foreman-tests')||!/^foreman-model-smoke-[a-zA-Z0-9_-]+$/.test(path.basename(root)))throw Error('Only isolated model smoke projects accepted');
const app=await openApplication({storageRoot:path.join(root,'journal'),dshHome:'C:/example/dsh/home',sessionRoot:path.join(root,'sessions')});
const requireDsh=createRequire('C:/example/dsh/node/node_modules/@deepseek-ai/dsh/package.json');
const load=async name=>import(pathToFileURL(requireDsh.resolve('@deepseek-ai/'+name)).href);
const [{Context},{AgentRegistry},{Session},{createScope},{ToolRuntime},{SystemPrompt},{UserQuestionService}]=await Promise.all([
  load('cordis'),load('dsh-agent'),load('dsh-session'),load('dsh-scope'),load('dsh-tools'),load('dsh-system-prompt'),load('dsh-user-questions')]);
const ctx=new Context(),fibers=[];let scope,detach,unregister,control;
try {
  assert.equal(app.controller.view('p').status,'approved','Real model final approval is required first');
  for(const plugin of [AgentRegistry,ToolRuntime,SystemPrompt,UserQuestionService]){const f=ctx.plugin(plugin,{});fibers.push(f);await f;}
  const agent={id:'delivery-test',session:Session.create('delivery-test')};scope=createScope(ctx,agent);agent.ctx=scope.ctx.extend({agent});
  detach=ctx.get('agents').enter(agent);ctx.get('agents').announce(agent);
  let confirmation;
  unregister=ctx.get('userQuestions').registerProvider({ask:async q=>{
    assert.equal(q.agent,agent);assert.equal(q.questions[0].header,'确认最终交付');confirmation=q.questions[0].id;
    return {answers:[{id:confirmation,selected:['确认执行']}]};
  }});
  control=new UserControl(app.controller,{agents:ctx.get('agents'),userQuestions:ctx.get('userQuestions')});
  await createOuterComposer(control,{snapshot:()=>({})})(agent.ctx);
  const result=await agent.ctx.get('tools').execute({callId:'deliver-smoke',name:'foreman_user_request',arguments:{command:JSON.stringify({type:'deliver',project:'p'})},agent,signal:new AbortController().signal});
  assert(!result.isError,JSON.stringify(result));assert.equal(app.controller.view('p').status,'delivered');
  await fs.writeFile(path.join(root,'delivery-report.json'),JSON.stringify({testedAt:new Date().toISOString(),status:'delivered',root,confirmation,
    realModelPriorApproval:true,realDshToolRuntime:true,realUserQuestionService:true,approvalSource:'deterministic-test-provider',modelRequests:0},null,2));
  console.log('Final model-approved project -> native outer confirmation -> delivered: PASS');
}finally{control?.close();unregister?.();detach?.();await scope?.dispose();for(const f of fibers.reverse())await f.dispose();await app.close();}
