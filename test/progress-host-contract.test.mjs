import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {ProjectProgress} from '../src/project-progress.mjs';

const requireDsh=createRequire(path.join(process.env.DSH_TEST_INSTALL??'C:/example/dsh/node/node_modules/@deepseek-ai/dsh','package.json'));
const load=async name=>import(pathToFileURL(requireDsh.resolve(name)).href);

test('official host session events and live query observations drive project progress with real event and message values',async()=>{
  const {Context}=await load('@deepseek-ai/cordis'),{SessionStore}=await load('@deepseek-ai/dsh-session');
  const {SessionQueryEngine}=await load('@deepseek-ai/dsh-session-query'),{createToolResultMessage}=await load('@deepseek-ai/dsh-llm');
  const ctx=new Context(),agents=new Map();ctx.provide('agents',agents);
  const sessions=ctx.plugin(SessionStore);await sessions;
  // The concrete base implements exact live observation. No search backend,
  // persistence, model factory or user profile is needed by this contract.
  const query=ctx.plugin(SessionQueryEngine);await query;
  const session=ctx.get('sessions').create('offline-progress-owned');
  agents.set(session.id,{id:session.id,session,status:'running'});
  const p={id:'p',status:'running',configVersion:1,controlVersion:0,reviewers:[],milestones:{m:{id:'m',status:'work',deps:[],planVersion:1}},
    tasks:{t:{id:'t',title:'Draw SVG',status:'running',milestone:'m',configVersion:1,planVersion:1,attempt:1}},rounds:{},audit:[]};
  const state={revision:1,projects:{p},runtimeAgents:{executor:{sessionId:session.id,binding:{role:'executor',project:'p',task:'t',configVersion:1,planVersion:1,taskAttempt:1}}}};
  const progress=new ProjectProgress(ctx,()=>state);
  try {
    session.append('turn/start',{turn:0});session.append('step/start',{turn:0,step:0});
    session.append('tool/call',{turn:0,step:0,callId:'write-svg',name:'foreman_files',arguments:JSON.stringify({action:'write',path:'sample.svg',text:'PRIVATE_SOURCE'})});
    assert.equal(progress.snapshot(state).p.latestAction.status,'running');
    session.append('tool/result',{turn:0,step:0,message:createToolResultMessage({callId:'write-svg',isError:false,content:[{type:'text',text:'PRIVATE_TOOL_RESULT'}]})},{surfaceOp:'append'});
    const projection=progress.snapshot(state).p;
    assert.equal(projection.latestAction.status,'success');assert.match(projection.latestAction.action,/sample.svg/);
    assert.equal(state.revision,1);assert(!JSON.stringify(projection).includes('PRIVATE'));
    const observation=await ctx.get('sessionQuery').observeSession(session.id,{projectionMode:'none'});
    try {
      assert.equal(observation.source,'live');assert.equal(observation.header.id,session.id);
      assert.equal(typeof observation.events.at(-1).time,'number');
      assert.equal(observation.events.at(-1).data.message.toolCallId,'write-svg');
      assert.equal(typeof observation[Symbol.dispose],'function');
    } finally {observation[Symbol.dispose]();}
    await progress.flush();assert.equal(progress.snapshot(state).p.latestAction.status,'success');
    const second=new ProjectProgress(ctx,()=>state);
    try {second.snapshot(state);await second.flush();assert.equal(second.snapshot(state).p.latestAction.status,'success');}
    finally {await second.close();}
  } finally {await progress.close();await query.dispose();await sessions.dispose();}
});
