import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openApplication} from '../src/application.mjs';
import {DshAgentDriver} from '../src/controller.mjs';
import {ForemanRuntime} from '../src/runtime.mjs';
import {UserControl} from '../src/user-control.mjs';
import {deliveryEligibility} from '../src/delivery-policy.mjs';

const project=workspace=>({type:'create',id:'p',workspace,objective:'Build an SVG animation',reviewers:['visual','tech'].map(id=>({id,name:id,responsibility:id,criteria:'Requested behavior'}))});
const yes=q=>({answers:[{id:q.questions[0].id,selected:['确认执行']}]});
async function fixture({dispose,createDelay}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-pause-')),work=path.join(root,'work'),home=path.join(root,'home'),sessions=path.join(root,'sessions');
  for(const dir of [work,home,sessions])await fs.mkdir(dir);
  const config={storageRoot:path.join(root,'journal'),dshHome:home,sessionRoot:sessions},app=await openApplication(config);
  const live=new Map(),disk=new Map();let sends=0,now=0;
  const ctx={agents:{get:id=>live.get(id),create:options=>make(options.sessionId,options,false),resume:options=>make(options.resumeSessionId,options,true)},
    sessions:{flush:async session=>{disk.set(session.id,structuredClone(session.events));return true;}},
    sessionPersistence:{readFrom:async id=>{if(!disk.has(id))throw Error('Session not persisted');return {meta:{id},events:structuredClone(disk.get(id))};}}};
  async function make(id,options,resume) {
    if(createDelay)await createDelay();if(resume && !disk.has(id))throw Error('Session not persisted');
    const session={id,events:structuredClone(disk.get(id)??[])};
    const agent={id,status:'idle',session,followup:message=>{sends++;session.events.push({seq:session.events.length,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:0,inserted:[message]}});}};
    const setup=await options.setup({agent});setup.commit();live.set(id,agent);
    return {agent,dispose:async()=>{await dispose?.(agent);live.delete(id);}};
  }
  const driver=new DshAgentDriver(ctx,app.controller,{compose:async()=>{}});
  const runtime=new ForemanRuntime(app.store,app.controller,driver,ctx,{model:{model:'no-api'},reviewTimeoutMs:100,executionTimeoutMs:100,now:()=>now});
  const actor=(role,subject)=>[...live.values()].find(a=>{const b=app.controller.identity(a);return b.role===role && (!subject || b.task===subject || b.reviewer===subject);});
  const command=(role,c,subject)=>app.controller.modelCommand(actor(role,subject),c);
  const controls=[];
  const control=ask=>{
    const outer={id:'outer'},user=new UserControl(app.controller,{agents:{get:id=>id===outer.id?outer:undefined,roots:()=>[outer]},userQuestions:{ask}},{canStart:()=>true});
    user.bindRoot(outer);controls.push(user);return {user,outer};
  };
  return {root,work,config,app,ctx,runtime,driver,live,disk,actor,command,control,sends:()=>sends,setNow:n=>now=n,
    close:async()=>{for(const c of controls)c.close();await runtime.close();await app.close();assert(path.relative(os.tmpdir(),root).startsWith('foreman-pause-'));await fs.rm(root,{recursive:true,force:true});}};
}
async function plan(f) {
  await f.app.controller.userCommand(project(f.work));await f.runtime.tick();
  await f.command('coordinator',{type:'propose',definition:{id:'m',title:'Animation',criteria:'Loop',deps:[]}});await f.runtime.tick();
  return Object.values(f.app.controller.view('p').rounds).at(-1);
}
async function execution(f) {
  const r=await plan(f);for(const id of ['visual','tech'])await f.command('reviewer',{type:'vote',round:r.id,generation:1,pass:true,findings:'Plan checked'},id);
  await f.runtime.tick();await f.command('coordinator',{type:'task',id:'t',milestone:'m',title:'Implement',instructions:'Implement animation'});await f.runtime.tick();
}

test('project pause drains owned agents, blocks old file writes, and resumes unfinished work with fresh delivery identities',async()=>{
  const f=await fixture();try {
    await execution(f);const c=f.app.controller,executor=f.actor('executor'),coordinator=f.actor('coordinator');
    await f.app.files.run(executor,{action:'write',path:'sample.svg',text:'partial animation',expectedHash:null});
    const before=c.view('p'),jobs=Object.values(f.app.store.snapshot().outbox),sends=f.sends();
    await c.userCommand({type:'pause',project:'p'});const paused=c.view('p');
    assert.equal(paused.status,'running');assert.equal(paused.paused,true);assert.equal(paused.pauseStatus,'drained');
    assert.equal(paused.controlVersion,1);assert.equal(paused.controlDrainVersion,1);assert.equal(f.live.size,0);
    assert.deepEqual(paused.tasks,before.tasks);assert.deepEqual(paused.rounds,before.rounds);assert.deepEqual(paused.milestones,before.milestones);
    await assert.rejects(f.app.files.run(executor,{action:'write',path:'late.svg',text:'late',expectedHash:null}),/stale agent/);
    f.setNow(10000);await f.runtime.tick();assert.equal(f.sends(),sends);assert.deepEqual(c.view('p').tasks,before.tasks);
    assert(jobs.filter(j=>['task','review','coordinator'].includes(j.subject.kind)).every(j=>deliveryEligibility(f.app.store.snapshot(),j)==='blocked'));
    await c.userCommand({type:'resume',project:'p'});assert.equal(c.view('p').controlVersion,2);await f.runtime.tick();
    const current=c.view('p'),replacement=f.actor('executor');assert(replacement);assert.notEqual(replacement.id,executor.id);
    assert.notEqual(f.actor('coordinator').id,coordinator.id);assert.equal(current.tasks.t.attempt,2);assert.equal(current.tasks.t.status,'running');
    assert.deepEqual(current.tasks.t.failures,before.tasks.t.failures);assert.equal(current.completions,before.completions);
    assert.equal(await fs.readFile(path.join(f.work,'sample.svg'),'utf8'),'partial animation');
    await f.command('executor',{type:'complete',task:'t',result:'continued'});assert.equal(c.view('p').completions,1);
  } finally {await f.close();}
});

test('pause during partially voted planning keeps authenticated votes and retries only missing voters with a new generation',async()=>{
  const f=await fixture();try {
    const first=await plan(f),c=f.app.controller;
    await f.command('reviewer',{type:'vote',round:first.id,generation:1,pass:false,findings:'Plan incomplete'},'visual');
    await f.command('reviewer',{type:'vote',round:first.id,generation:1,pass:false,findings:'Missing requirement'},'tech');await f.runtime.tick();
    await f.command('coordinator',{type:'propose',definition:{id:'m',title:'Animation',criteria:'Complete loop',deps:[]}});await f.runtime.tick();
    const current=Object.values(c.view('p').rounds).at(-1),oldReviewer=f.actor('reviewer','tech');
    await f.command('reviewer',{type:'vote',round:current.id,generation:1,pass:true,findings:'Corrected plan'},'visual');
    const before=c.view('p');await c.userCommand({type:'pause',project:'p'});f.setNow(10000);await f.runtime.tick();
    assert.deepEqual(c.view('p').rounds,before.rounds);assert.equal(c.view('p').milestones.m.denials,1);
    await c.userCommand({type:'resume',project:'p'});await f.runtime.tick();
    const round=c.view('p').rounds[current.id];assert.equal(round.generation,2);assert.deepEqual(round.votes,before.rounds[current.id].votes);
    assert.equal(c.view('p').rounds[first.id].generation,1);assert.equal(c.view('p').rounds[first.id].status,'closed');
    assert.equal(f.actor('reviewer','visual'),undefined);assert.notEqual(f.actor('reviewer','tech').id,oldReviewer.id);
    await f.command('reviewer',{type:'vote',round:current.id,generation:2,pass:true,findings:'Corrected plan'},'tech');
    assert.equal(c.view('p').rounds[current.id].outcome,'passed');assert.equal(c.view('p').milestones.m.denials,1);
  } finally {await f.close();}
});

test('native chat pause, resume and cancel need exact confirmation and preserve control ABA boundaries',async()=>{
  const f=await fixture();try {
    await execution(f);let approve=false,shown;const {user,outer}=f.control(async q=>{shown=q;return approve?yes(q):{answers:[{id:q.questions[0].id,selected:['返回调整']}]};});
    const before=f.app.store.snapshot();assert.equal((await user.request(outer,{type:'pause',project:'p'})).applied,false);assert.deepEqual(f.app.store.snapshot(),before);
    assert.match(shown.questions[0].detail,/暂停项目/);assert.match(shown.questions[0].detail,/项目ID：p/);
    approve=true;assert.equal((await user.request(outer,{type:'pause',project:'p'})).applied,true);
    const stale=await f.app.controller.prepareUserCommand({type:'resume',project:'p'});
    assert.equal((await user.request(outer,{type:'resume',project:'p'})).applied,true);await f.runtime.tick();
    await user.request(outer,{type:'pause',project:'p'});
    await assert.rejects(f.app.controller.confirmUserCommand(stale,'stale-ABA'),/changed while awaiting/);
    assert.equal(f.app.controller.view('p').controlVersion,3);
    assert.equal((await user.request(outer,{type:'cancel',project:'p'})).applied,true);
    assert.equal(f.app.controller.view('p').status,'cancelled');assert.equal(f.app.controller.view('p').controlVersion,4);
    assert.equal(f.app.controller.view('p').controlDrainVersion,4);assert.equal(f.live.size,0);
    await assert.rejects(user.request(outer,{type:'resume',project:'p'}),/closed/);
  } finally {await f.close();}
});

test('pause does not claim drained or permit resume when official agent disposal fails',async()=>{
  let fail=false;const f=await fixture({dispose:async()=>{if(fail)throw Error('official stop failed');}});
  try {
    await execution(f);const before=f.app.controller.view('p');fail=true;
    await assert.rejects(f.app.controller.userCommand({type:'pause',project:'p'}),/排空失败/);
    const p=f.app.controller.view('p');assert.equal(p.paused,true);assert.equal(p.pauseStatus,'requested');assert.equal(p.controlDrainVersion,undefined);
    assert.deepEqual(p.tasks,before.tasks);assert.deepEqual(p.rounds,before.rounds);
    await assert.rejects(f.app.controller.prepareUserCommand({type:'resume',project:'p'}),/not finished draining/);
    await assert.rejects(f.app.controller.userCommand({type:'resume',project:'p'}),/排空失败/);
    assert.equal(f.app.controller.view('p').paused,true);
  } finally {fail=false;await f.close();}
});

test('pause waits for in-flight create, then resume uses a fresh coordinator even if old session never checkpointed',async()=>{
  let block=true,enter,release;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);
  const f=await fixture({createDelay:async()=>{if(block){enter();await wait;}}});
  try {
    await f.app.controller.userCommand(project(f.work));const tick=f.runtime.tick();await entered;
    let resolved=false;const pause=f.app.controller.userCommand({type:'pause',project:'p'}).then(()=>resolved=true);
    while(!f.app.controller.view('p').paused)await new Promise(r=>setImmediate(r));assert.equal(resolved,false);assert.equal(f.app.controller.view('p').pauseStatus,'requested');
    block=false;release();await tick;await pause;assert.equal(f.live.size,0);assert.equal(f.app.controller.view('p').pauseStatus,'drained');
    const old=Object.values(f.app.store.snapshot().runtimeAgents)[0];assert.equal(old.phase,'starting');assert.equal(f.disk.has(old.sessionId),false);
    await f.app.controller.userCommand({type:'resume',project:'p'});await f.runtime.tick();
    const next=f.actor('coordinator');assert(next);assert.notEqual(next.id,old.sessionId);
    await f.command('coordinator',{type:'propose',definition:{id:'m',title:'Program',criteria:'Correct',deps:[]}});
    assert.equal(Object.values(f.app.controller.view('p').rounds).length,1);
  } finally {block=false;release();await f.close();}
});

test('paused state survives journal reopen and private runtime ACK never counts as a fault or denial',async()=>{
  const f=await fixture();let reopened,runtime;
  try {
    await execution(f);await f.app.controller.userCommand({type:'pause',project:'p'});const before=f.app.controller.view('p');
    await f.runtime.close();await f.app.close();reopened=await openApplication(f.config);
    const driver=new DshAgentDriver(f.ctx,reopened.controller,{compose:async()=>{}});
    runtime=new ForemanRuntime(reopened.store,reopened.controller,driver,f.ctx,{model:{model:'no-api'}});
    await runtime.tick();assert.deepEqual(reopened.controller.view('p'),before);assert.equal(f.live.size,0);
    await reopened.controller.userCommand({type:'resume',project:'p'});await runtime.tick();
    assert.equal(reopened.controller.view('p').tasks.t.status,'running');assert.equal(reopened.controller.view('p').tasks.t.attempt,2);
    assert.deepEqual(reopened.controller.view('p').tasks.t.failures,before.tasks.t.failures);assert.equal(reopened.controller.view('p').milestones.m.denials,before.milestones.m.denials);
  } finally {await runtime?.close();await reopened?.close();await f.close();}
});

test('one failed project drain does not block independent project dispatch on subsequent ticks',async()=>{
  const blocked=new Set();const f=await fixture({dispose:async agent=>{if(blocked.has(agent.id))throw Error('owned stop failed');}});
  try {
    await execution(f);for(const a of f.live.values())blocked.add(a.id);
    await assert.rejects(f.app.controller.userCommand({type:'pause',project:'p'}),/排空失败/);
    const work=path.join(f.root,'other');await fs.mkdir(work);await f.app.controller.userCommand({...project(work),id:'q'});
    await f.runtime.tick();await f.runtime.tick();
    assert.equal(f.app.controller.view('p').pauseStatus,'requested');
    assert(f.runtime.diagnostics().some(e=>e.key==='project-control:p'));
    const record=Object.values(f.app.store.snapshot().runtimeAgents).find(r=>r.binding.project==='q' && r.binding.role==='coordinator');
    const coordinator=f.live.get(record.sessionId);assert(coordinator);
    await f.app.controller.modelCommand(coordinator,{type:'propose',definition:{id:'m',title:'Independent',criteria:'Correct',deps:[]}});
    await f.runtime.tick();assert.equal(Object.values(f.app.controller.view('q').rounds).length,1);
    const reviewers=Object.values(f.app.store.snapshot().runtimeAgents).filter(r=>r.binding.project==='q' && r.binding.role==='reviewer');
    assert.equal(reviewers.length,2);assert(reviewers.every(r=>f.live.has(r.sessionId)));
  } finally {blocked.clear();await f.close();}
});

test('missing official agent lookup cannot acknowledge a cold paused project with durable owned sessions',async()=>{
  const f=await fixture();let cold;
  try {
    await execution(f);await f.app.controller.userCommand({type:'pause',project:'p'});
    await f.runtime.close();
    // A legacy/cold caller has persisted requested state but no resident handles.
    // There must still be positive official-registry evidence before ACK.
    await f.app.store.dispatch({role:'user'},{type:'resume',project:'p'});
    await f.app.store.dispatch({role:'user'},{type:'pause',project:'p'});
    const ctx={...f.ctx,agents:{create:f.ctx.agents.create,resume:f.ctx.agents.resume}};
    cold=new ForemanRuntime(f.app.store,f.app.controller,new DshAgentDriver(ctx,f.app.controller,{compose:async()=>{}}),ctx,{model:{model:'no-api'}});
    await cold.tick();assert.equal(f.app.controller.view('p').pauseStatus,'requested');
    assert.notEqual(f.app.controller.view('p').controlDrainVersion,f.app.controller.view('p').controlVersion);
    assert(cold.diagnostics().some(e=>/lookup is unavailable/.test(e.error)));
    await assert.rejects(f.app.controller.userCommand({type:'resume',project:'p'}),/排空失败/);
  } finally {await cold?.close();await f.close();}
});

test('pausing acceptance, final review and approved delivery preserves completed work and phase',async()=>{
  const f=await fixture();try {
    await execution(f);const c=f.app.controller;
    await f.command('executor',{type:'complete',task:'t',result:'Implemented and verified'});await f.runtime.tick();
    await f.command('coordinator',{type:'submit',milestone:'m'});await f.runtime.tick();
    let r=Object.values(c.view('p').rounds).at(-1);
    await f.command('reviewer',{type:'vote',round:r.id,generation:r.generation,pass:true,findings:'Acceptance checked'},'visual');
    const completed=structuredClone(c.view('p').tasks.t);
    await c.userCommand({type:'pause',project:'p'});await c.userCommand({type:'resume',project:'p'});await f.runtime.tick();
    assert.deepEqual(c.view('p').tasks.t,completed);assert.equal(f.actor('executor'),undefined);assert.equal(f.actor('reviewer','visual'),undefined);
    r=c.view('p').rounds[r.id];await f.command('reviewer',{type:'vote',round:r.id,generation:r.generation,pass:true,findings:'Acceptance checked'},'tech');await f.runtime.tick();
    await f.command('coordinator',{type:'final'});await f.runtime.tick();r=Object.values(c.view('p').rounds).at(-1);
    await f.command('reviewer',{type:'vote',round:r.id,generation:r.generation,pass:true,findings:'Final checked'},'visual');
    await c.userCommand({type:'pause',project:'p'});assert.equal(c.view('p').status,'final-review');
    await c.userCommand({type:'resume',project:'p'});await f.runtime.tick();assert.equal(c.view('p').status,'final-review');
    assert.equal(f.actor('reviewer','visual'),undefined);r=c.view('p').rounds[r.id];
    await f.command('reviewer',{type:'vote',round:r.id,generation:r.generation,pass:true,findings:'Final checked'},'tech');
    assert.equal(c.view('p').status,'approved');const closed=structuredClone(c.view('p').rounds);
    await c.userCommand({type:'pause',project:'p'});await assert.rejects(c.userCommand({type:'deliver',project:'p'}),/paused/);
    await c.userCommand({type:'resume',project:'p'});await f.runtime.tick();
    assert.equal(c.view('p').status,'approved');assert.deepEqual(c.view('p').rounds,closed);assert.deepEqual(c.view('p').tasks.t,completed);
    await c.userCommand({type:'deliver',project:'p'});assert.equal(c.view('p').status,'delivered');
  } finally {await f.close();}
});
