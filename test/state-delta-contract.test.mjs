import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {createRoleComposer} from '../src/role-tools.mjs';

test('official DSH session events and committed surface replacements invalidate coordinator delta baselines offline',async t=>{
  const install=process.env.DSH_TEST_INSTALL??'C:/example/dsh/node/node_modules/@deepseek-ai/dsh';
  const requireDsh=createRequire(path.join(install,'package.json')),load=async name=>import(pathToFileURL(requireDsh.resolve(name)).href);
  const [{Context},{Session,SessionStore}]=await Promise.all([load('@deepseek-ai/cordis'),load('@deepseek-ai/dsh-session')]);
  if(typeof Session.create('capability').surface?.replaceGeneration!=='number')return t.skip('Current default DSH lacks the official surface replacement generation; use DSH_TEST_INSTALL=0.2');
  const ctx=new Context(),service=ctx.plugin(SessionStore);await service;
  const agent={id:'coordinator',session:ctx.get('sessions').create('coordinator')},tools=new Map();
  const binding={role:'coordinator',project:'p',configVersion:1};
  const p={id:'p',status:'running',configVersion:1,objective:'locked '.repeat(100),reviewers:[{id:'r',criteria:'locked'}],tasks:{},milestones:{},rounds:{}};
  const controller={identity:who=>{assert.equal(who,agent);return binding;},view:()=>structuredClone(p)};
  const composeCtx={on:ctx.on.bind(ctx),get:name=>name==='tools'?{restrict(){},presentAs(){},guard(){},register:tool=>tools.set(tool.name,tool)}:{section(){}}};
  try {
    await createRoleComposer(controller)(composeCtx,binding,agent);
    const read=async cursor=>JSON.parse((await tools.get('foreman_read').execute(cursor?{sinceCursor:cursor}:{},{agent})).text);
    let full=await read();assert.equal((await read(full._read.cursor))._read.full,false);
    agent.session.append('turn/start',{turn:1});full=await read(full._read.cursor);assert.equal(full._read.full,true);
    agent.session.append('compaction/summary',{summary:'baseline was discarded'});full=await read(full._read.cursor);assert.equal(full._read.full,true);
    const prior=agent.session.append('user/message',{role:'user',content:[{type:'text',text:'prior baseline'}]},{surfaceOp:'append'});
    agent.session.append('user/message',{role:'user',content:[{type:'text',text:'compacted baseline'}]},
      {surfaceOp:{op:'replace',startSeq:prior.seq,endSeq:prior.seq},sourceEventSeqs:[prior.seq]});
    assert(agent.session.surface.replaceGeneration>0);
    assert.equal((await read(full._read.cursor))._read.full,true);
  } finally {await service.dispose();}
});
