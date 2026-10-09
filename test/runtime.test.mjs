import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JournalStore} from '../src/store.mjs';
import {Controller,DshAgentDriver} from '../src/controller.mjs';
import {ForemanRuntime} from '../src/runtime.mjs';
import {DshTransport,receiptEvidence} from '../src/dsh-transport.mjs';
import {UserControl} from '../src/user-control.mjs';
import {SessionRecovery} from '../src/session-recovery.mjs';

const project={type:'create',id:'p',objective:'Build a small program',workspace:'D:/project',reviewers:[{id:'r',name:'Quality',responsibility:'Check behavior',criteria:'Tests pass'}]};
test('native empty-session takeover preserves supervision and resumes coordinator, reviewer and executor with fresh identities',async()=>{
  for(const role of ['coordinator','reviewer','executor']) {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-takeover-'));let store=await JournalStore.open(dir),h=harness(store);let control;
    try {
      if(role==='executor')await prepareExecution(h,store);
      else {await h.controller.userCommand(project);if(role==='reviewer'){await h.runtime.tick();await h.command('coordinator',{type:'propose',definition:{id:'a',title:'A',criteria:'Pass',deps:[]}});}}
      const normalFlush=h.ctx.sessions.flush;h.ctx.sessions.flush=async session=>h.live.has(session.id)&&h.controller.identity(h.live.get(session.id)).role===role?false:normalFlush(session);
      await h.runtime.tick();
      const record=Object.values(store.snapshot().runtimeAgents).find(r=>r.binding.role===role),notification=store.snapshot().runtimeIncidents['p:agent:'+record.key].notificationId;
      assert.equal(record.phase,'starting');assert.equal(h.disk.has(record.sessionId),false);
      const disk=h.disk,before=store.snapshot().projects.p;
      const recovery=new SessionRecovery({controller:h.controller,store,context:()=>({sessionPersistence:h.ctx.sessionPersistence,agents:{get:id=>h.live.get(id)}}),maintenance:async op=>{await h.runtime.close();return op();}});
      const outer={id:'outer'},ctx={agents:{get:id=>id==='outer'?outer:undefined,roots:()=>[outer]},userQuestions:{ask:async q=>({answers:[{id:q.questions[0].id,selected:['确认执行']}]})}};
      control=new UserControl(h.controller,ctx,{recovery});control.bindRoot(outer);
      assert.equal((await control.request(outer,{type:'recover-empty-session',project:'p',notification})).applied,true);
      const next=store.snapshot().runtimeAgents[record.key];assert.notEqual(next.sessionId,record.sessionId);assert.equal(next.phase,'reserved');
      assert.deepEqual(store.snapshot().projects.p.reviewers,before.reviewers);assert.deepEqual(store.snapshot().projects.p.milestones,before.milestones);
      assert.equal(store.snapshot().sessionRecoveries.length,1);control.close();await store.close();
      store=await JournalStore.open(dir);h=harness(store,disk);await h.runtime.tick();await h.runtime.tick();
      assert.equal(h.find(role).id,next.sessionId);assert(!h.live.has(record.sessionId));
      assert.equal(h.find(role).session.events.filter(e=>e.type==='agent/inbox/spliced').length,1);
    }finally{control?.close();await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
  }
});
test('empty-session confirmation fails closed on decline, new persisted content, changed rules, revoked outer and stop failure',async()=>{
  for(const mode of ['decline','content','config','revoke','stop']) {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-takeover-refuse-')),store=await JournalStore.open(dir),h=harness(store);let control;
    try {
      await h.controller.userCommand(project);h.ctx.sessions.flush=async()=>false;await h.runtime.tick();
      const record=Object.values(store.snapshot().runtimeAgents)[0],notification=store.snapshot().projects.p.notifications[0].id;
      const recovery=new SessionRecovery({controller:h.controller,store,context:()=>({sessionPersistence:h.ctx.sessionPersistence,agents:{get:id=>h.live.get(id)}}),maintenance:async op=>{if(mode==='stop')throw Error('stop failed');await h.runtime.close();return op();}});
      const outer={id:'outer'};let revoke;
      control=new UserControl(h.controller,{agents:{get:id=>id==='outer'?outer:undefined,roots:()=>[outer]},userQuestions:{ask:async q=>{
        if(mode==='content')h.disk.set(record.sessionId,[{seq:0,type:'some-event'}]);
        if(mode==='config')await h.controller.userCommand({type:'configure',project:'p',objective:'Changed'});
        if(mode==='revoke')revoke();
        return {answers:[{id:q.questions[0].id,selected:[mode==='decline'?'返回调整':'确认执行']}]};
      }}},{recovery});revoke=control.bindRoot(outer);
      const command={type:'recover-empty-session',project:'p',notification};
      await assert.rejects(control.request({id:'outer'},command),/bound live/);
      if(mode==='decline')assert.equal((await control.request(outer,command)).applied,false);else await assert.rejects(control.request(outer,command));
      assert.equal(store.snapshot().runtimeAgents[record.key].sessionId,record.sessionId);assert.equal(store.snapshot().sessionRecoveries,undefined);
    }finally{control?.close();await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
  }
});
async function prepareExecution(h,store) {
  await h.controller.userCommand(project);await h.runtime.tick();
  await h.command('coordinator',{type:'propose',definition:{id:'a',title:'Program',criteria:'Working',deps:[]}});await h.runtime.tick();
  const round=Object.values(store.snapshot().projects.p.rounds).at(-1);
  await h.command('reviewer',{type:'vote',round:round.id,generation:1,pass:true,findings:'Plan checked'});await h.runtime.tick();
  await h.command('coordinator',{type:'task',milestone:'a',id:'t',title:'Implement',instructions:'Implement'});
}
function harness(store,disk=new Map(),runtimeOptions={}) {
  const live=new Map();let sends=0,creates=0,resumes=0;
  const controller=new Controller(store,{captureArtifact:async()=> 'snapshot:trusted-test'});
  const ctx={agents:{
    async create(options){creates++;return make(options.sessionId,options,false);},
    async resume(options){resumes++;return make(options.resumeSessionId,options,true);},
  },sessions:{async flush(session){disk.set(session.id,structuredClone(session.events));return true;}},
    sessionPersistence:{async readFrom(id){if(!disk.has(id))throw new Error(`session "${id}" not found`);return {meta:{id},events:structuredClone(disk.get(id))};}}};
  async function make(id,options,resume) {
    if(resume && !disk.has(id))throw new Error('Session not persisted');
    const session={id,events:structuredClone(disk.get(id)??[])};
    const agent={id,session,followup(message){sends++;session.events.push({seq:session.events.length,type:'agent/inbox/spliced',data:{inserted:[message]}});}};
    const setup=await options.setup({agent});setup.commit();live.set(id,agent);
    return {agent,dispose:async()=>live.delete(id)};
  }
  const driver=new DshAgentDriver(ctx,controller,{compose:async()=>{}});
  const runtime=new ForemanRuntime(store,controller,driver,ctx,{model:{model:'test-no-api'},...runtimeOptions});
  const find=role=>[...live.values()].filter(a=>controller.identity(a).role===role).at(-1);
  const command=(role,c)=>controller.modelCommand(find(role),c);
  return {controller,ctx,driver,runtime,live,disk,find,command,stats:()=>({sends,creates,resumes})};
}

test('runtime drives planning, assignment, supervision and final approval without transport self-approval',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-runtime-'));const store=await JournalStore.open(dir);const h=harness(store);
  try {
    await h.controller.userCommand(project);await h.runtime.tick();
    await h.command('coordinator',{type:'propose',definition:{id:'a',title:'Program',criteria:'Working',deps:[]}});
    await h.runtime.tick();
    let round=Object.values(store.snapshot().projects.p.rounds).at(-1);
    assert.equal(round.status,'open');
    await h.command('reviewer',{type:'vote',round:round.id,generation:1,pass:true,findings:'Plan covers requested behavior'});
    await h.runtime.tick();
    await h.command('coordinator',{type:'task',milestone:'a',id:'t',title:'Implement',instructions:'Implement and verify'});
    await h.runtime.tick();
    assert.equal(store.snapshot().projects.p.tasks.t.assigned,h.find('executor').id);
    await h.command('executor',{type:'complete',task:'t',result:'Implemented; tests pass'});
    await h.runtime.tick();
    await h.command('coordinator',{type:'submit',milestone:'a'});await h.runtime.tick();
    round=Object.values(store.snapshot().projects.p.rounds).at(-1);
    await h.command('reviewer',{type:'vote',round:round.id,generation:1,pass:true,findings:'Verified trusted snapshot'});
    await h.runtime.tick();await h.command('coordinator',{type:'final'});await h.runtime.tick();
    round=Object.values(store.snapshot().projects.p.rounds).at(-1);
    assert.equal(store.snapshot().projects.p.status,'final-review');
    await h.command('reviewer',{type:'vote',round:round.id,generation:1,pass:true,findings:'All requirements verified'});
    await h.controller.userCommand({type:'deliver',project:'p'});await h.runtime.tick();
    assert.equal(h.live.size,0);assert.deepEqual(h.runtime.diagnostics(),[]);
  } finally {await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('durable session mapping resumes an assigned worker without creating or sending a duplicate',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-resume-'));let store=await JournalStore.open(dir);let h=harness(store);
  try {
    await h.controller.userCommand(project);await h.runtime.tick();
    await h.command('coordinator',{type:'propose',definition:{id:'a',title:'Program',criteria:'Working',deps:[]}});await h.runtime.tick();
    const round=Object.values(store.snapshot().projects.p.rounds).at(-1);
    await h.command('reviewer',{type:'vote',round:round.id,generation:1,pass:true,findings:'Plan checked'});await h.runtime.tick();
    await h.command('coordinator',{type:'task',milestone:'a',id:'t',title:'Implement',instructions:'Implement'});await h.runtime.tick();
    const id=h.find('executor').id,disk=h.disk;
    await h.runtime.close();await store.close();store=await JournalStore.open(dir);h=harness(store,disk);
    await h.runtime.tick();assert.equal(h.find('executor').id,id);
    assert.equal(h.stats().creates,0);assert.equal(h.stats().sends,0);
    await h.command('executor',{type:'complete',task:'t',result:'Done after restart'});
  } finally {await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('execution deadline survives restart and disabled new watches; retry requires coordinator decision',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-execution-deadline-'));let store=await JournalStore.open(dir);
  let now=0,h=harness(store,new Map(),{now:()=>now,executionTimeoutMs:100});
  try {
    await prepareExecution(h,store);await h.runtime.tick();
    const watch=Object.values(store.snapshot().executionWatches)[0];assert.equal(watch.deadline,100);
    const disk=h.disk;await h.runtime.close();await store.close();store=await JournalStore.open(dir);
    now=99;h=harness(store,disk,{now:()=>now,executionTimeoutMs:null});await h.runtime.tick();
    const old=h.find('executor');old.status='running';
    assert.equal(store.snapshot().projects.p.tasks.t.status,'running');
    now=100;await h.runtime.tick();
    const p=store.snapshot().projects.p;
    assert.equal(p.tasks.t.status,'failed');assert.equal(p.tasks.t.failures.length,1);assert.equal(p.milestones.a.denials,0);
    await assert.rejects(h.controller.modelCommand(old,{type:'complete',task:'t',result:'Late result'}),/identity/);
    const creates=h.stats().creates;await h.runtime.tick();assert.equal(h.stats().creates,creates);
    await assert.rejects(h.command('coordinator',{type:'submit',milestone:'a'}),/tasks must complete/);
    await h.command('coordinator',{type:'retry-task',task:'t',reason:'Inspect partial files before retry'});await h.runtime.tick();
    assert.equal(h.controller.identity(h.find('executor')).taskAttempt,2);
    now=100000;await h.runtime.tick();assert.equal(store.snapshot().projects.p.tasks.t.status,'running');
    assert.equal(Object.keys(store.snapshot().executionWatches).length,1);
  } finally {await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('unknown execution delivery gets no deadline and cannot auto-retry',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-execution-uncertain-'));const store=await JournalStore.open(dir);let now=0;
  const h=harness(store,new Map(),{now:()=>now,executionTimeoutMs:10});
  try {
    await prepareExecution(h,store);
    const flush=h.ctx.sessions.flush;h.ctx.sessions.flush=async session=>session.events.length?false:flush(session);await h.runtime.tick();
    const sends=h.stats().sends;now=10000;await h.runtime.tick();
    assert.equal(Object.keys(store.snapshot().executionWatches??{}).length,0);
    assert.equal(store.snapshot().projects.p.tasks.t.status,'running');assert.equal(h.stats().sends,sends);
  } finally {await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('receipt probe requires physical persistence; cleared inbox still proves prior delivery',async()=>{
  const job={messageId:'m',text:'Work'};
  const message={id:'m',role:'user',content:[{type:'text',text:'Work'}],source:{kind:'plugin',plugin:'dsh-foreman-next'}};
  const events=[{seq:0,type:'agent/inbox/spliced',data:{inserted:[message]}},{seq:1,type:'agent/inbox/spliced',data:{inserted:[],removedCount:1,outcome:'canceled'}}];
  assert.equal(receiptEvidence(events,job),'present');
  assert.throws(()=>receiptEvidence(events,{...job,text:'Altered'}),/conflicting/);
  let stored=[],flush=true;
  const agent={session:{events}};
  const ctx={sessions:{flush:async()=>flush},sessionPersistence:{readFrom:async()=>({meta:{id:'s'},events:stored})}};
  const port=new DshTransport({},null,ctx,{lookup:()=>({sessionId:'s',agent})});
  assert.equal(await port.probe(job),'unknown');
  stored=events;assert.equal(await port.probe(job),'present');
  flush=false;assert.equal(await port.probe(job),'unknown');
  flush=true;agent.session.events=[];stored=[];assert.equal(await port.probe(job),'absent');
});

test('review timeout survives restart; initial plus three retries pauses once without denials',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-timeout-'));let store=await JournalStore.open(dir);
  let now=0,h=harness(store,new Map(),{now:()=>now,reviewTimeoutMs:100});
  try {
    await h.controller.userCommand(project);await h.runtime.tick();
    await h.command('coordinator',{type:'propose',definition:{id:'a',title:'Program',criteria:'Working',deps:[]}});await h.runtime.tick();
    const round=Object.values(store.snapshot().projects.p.rounds).at(-1),disk=h.disk;
    const oldDeadline=Object.values(store.snapshot().reviewWatches)[0].deadline;
    await h.runtime.close();await store.close();store=await JournalStore.open(dir);
    now=50;h=harness(store,disk,{now:()=>now,reviewTimeoutMs:999});await h.runtime.tick();
    assert.equal(Object.values(store.snapshot().reviewWatches)[0].deadline,oldDeadline);
    for(let attempt=1;attempt<=4;attempt++) {
      now=attempt===1?100:now+999;
      await h.runtime.tick();
      assert.equal(store.snapshot().projects.p.rounds[round.id].attempts.r,attempt);
    }
    const p=store.snapshot().projects.p;
    assert.equal(p.rounds[round.id].status,'faulted');assert.equal(p.milestones.a.denials,0);
    assert.equal(p.notifications.filter(n=>n.kind==='fault').length,1);
    const count=h.stats().creates;now+=10000;await h.runtime.tick();assert.equal(h.stats().creates,count);
  } finally {await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('a consumed review ending without a verdict is retried and its old identity revoked',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-no-verdict-'));const store=await JournalStore.open(dir);const h=harness(store);
  try {
    await h.controller.userCommand(project);await h.runtime.tick();
    await h.command('coordinator',{type:'propose',definition:{id:'a',title:'Program',criteria:'Working',deps:[]}});await h.runtime.tick();
    const old=h.find('reviewer'),r=Object.values(store.snapshot().projects.p.rounds).at(-1);
    old.session.events[0].data.target='next-turn';old.session.events[0].data.start=0;
    old.session.events.push({type:'turn/start',data:{turn:1}},{type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
    old.status='idle';await h.runtime.tick();
    assert.equal(store.snapshot().projects.p.rounds[r.id].attempts.r,1);
    assert.notEqual(h.find('reviewer').id,old.id);
    assert.throws(()=>h.controller.identity(old),/identity/);
  } finally {await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('unknown delivery cannot trigger a review deadline or another review attempt',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-uncertain-review-'));const store=await JournalStore.open(dir);let now=0;
  const h=harness(store,new Map(),{now:()=>now,reviewTimeoutMs:10});
  try {
    await h.controller.userCommand(project);await h.runtime.tick();
    await h.command('coordinator',{type:'propose',definition:{id:'a',title:'Program',criteria:'Working',deps:[]}});
    h.ctx.sessions.flush=async()=>false;await h.runtime.tick();const sends=h.stats().sends;
    now=10000;await h.runtime.tick();
    assert.equal(h.stats().sends,sends);assert.equal(Object.keys(store.snapshot().reviewWatches??{}).length,0);
    assert.deepEqual(Object.values(store.snapshot().projects.p.rounds).at(-1).attempts,{});
  } finally {await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('executor failure survives restart; coordinator retry creates a new attempt and revokes late results',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-execution-fault-'));let store=await JournalStore.open(dir),h=harness(store);
  try {
    await h.controller.userCommand(project);await h.runtime.tick();
    await h.command('coordinator',{type:'propose',definition:{id:'a',title:'Program',criteria:'Working',deps:[]}});await h.runtime.tick();
    const r=Object.values(store.snapshot().projects.p.rounds).at(-1);
    await h.command('reviewer',{type:'vote',round:r.id,generation:1,pass:true,findings:'Plan checked'});await h.runtime.tick();
    await h.command('coordinator',{type:'task',milestone:'a',id:'t',title:'Implement',instructions:'Implement'});await h.runtime.tick();
    const old=h.find('executor');
    old.session.events[0].data.target='next-turn';old.session.events[0].data.start=0;
    old.session.events.push({type:'turn/start',data:{turn:1}},{type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},{type:'turn/end',data:{turn:1,reason:{kind:'error'}}});
    old.status='idle';await h.runtime.tick();
    let p=store.snapshot().projects.p;
    assert.equal(p.tasks.t.status,'failed');assert.equal(p.tasks.t.failures.length,1);assert.equal(p.completions,0);assert.equal(p.milestones.a.denials,0);
    await assert.rejects(h.controller.modelCommand(old,{type:'complete',task:'t',result:'Late'}),/identity/);
    await assert.rejects(h.command('coordinator',{type:'submit',milestone:'a'}),/tasks must complete/);
    const count=h.stats().sends;await h.runtime.tick();assert.equal(h.stats().sends,count);
    const disk=h.disk;await h.runtime.close();await store.close();store=await JournalStore.open(dir);h=harness(store,disk);
    await h.runtime.tick();assert.equal(store.snapshot().projects.p.tasks.t.status,'failed');
    await h.command('coordinator',{type:'retry-task',task:'t',reason:'Inspect partial output and fix the reported failure'});await h.runtime.tick();
    const next=h.find('executor');assert.notEqual(next.id,old.id);
    assert.equal(h.controller.identity(next).taskAttempt,2);
    await h.command('executor',{type:'complete',task:'t',result:'Recovered and verified'});
    p=store.snapshot().projects.p;assert.equal(p.tasks.t.attempt,2);assert.equal(p.tasks.t.failures.length,1);assert.equal(p.completions,1);
  } finally {await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('dependency approval gates failed-task retries and wakes the coordinator after permission changes',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-dependency-wake-')),store=await JournalStore.open(dir),h=harness(store);
  try {
    await prepareExecution(h,store);await h.runtime.tick();const worker=h.find('executor'),fingerprint='a'.repeat(64);
    await store.dispatchRuntime({type:'dependency-needed',project:'p',configVersion:1,fingerprint,task:'t',taskAttempt:1});
    await assert.rejects(h.command('executor',{type:'complete',task:'t',result:'Skipped verification'}),/waiting for dependency/);
    worker.session.events[0].data.target='next-turn';worker.session.events[0].data.start=0;
    worker.session.events.push({type:'turn/start',data:{turn:1}},{type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
    worker.status='idle';await h.runtime.tick();
    assert.equal(store.snapshot().projects.p.tasks.t.status,'failed');
    await assert.rejects(h.command('coordinator',{type:'retry-task',task:'t',reason:'Too early'}),/waiting for dependency/);
    const sent=h.stats().sends;await h.runtime.tick();assert.equal(h.stats().sends,sent);
    await store.dispatchRuntime({type:'approve-dependency-image',project:'p',configVersion:1,expectedRevision:0,image:'sha256:'+'b'.repeat(64),fingerprint,confirmation:'foreman-confirm-11111111-1111-4111-8111-111111111111'});
    await h.runtime.tick();assert(h.stats().sends>sent,'approval must create a coordinator wake');
    await h.command('coordinator',{type:'retry-task',task:'t',reason:'Dependencies now approved'});await h.runtime.tick();
    assert.equal(store.snapshot().projects.p.tasks.t.attempt,2);assert.equal(store.snapshot().projects.p.milestones.a.denials,0);
  }finally{await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('stalled coordinator produces one durable notification and later progress resolves it',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-stalled-coordinator-'));let store=await JournalStore.open(dir),h=harness(store);
  try {
    await h.controller.userCommand(project);await h.runtime.tick();const boss=h.find('coordinator');
    boss.session.events[0].data.target='next-turn';boss.session.events[0].data.start=0;
    boss.session.events.push({type:'turn/start',data:{turn:1}},{type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
    boss.status='idle';await h.runtime.tick();await h.runtime.tick();
    assert.equal(store.snapshot().projects.p.notifications.filter(n=>n.kind==='fault').length,1);
    boss.session.events.forEach((event,seq)=>{event.seq=seq;});
    const disk=h.disk;await h.ctx.sessions.flush(boss.session);await h.runtime.close();await store.close();
    store=await JournalStore.open(dir);h=harness(store,disk);await h.runtime.tick();
    assert.equal(store.snapshot().projects.p.notifications[0].acknowledged,false);
    await h.command('coordinator',{type:'propose',definition:{id:'a',title:'Program',criteria:'Working',deps:[]}});await h.runtime.tick();
    assert.equal(store.snapshot().projects.p.notifications[0].resolved,true);
  } finally {await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('missing persisted session raises one incident without duplicate agents, then resolves on recovery',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-recovery-incident-'));let store=await JournalStore.open(dir),h=harness(store);
  try {
    await h.controller.userCommand(project);await h.runtime.tick();
    const id=h.find('coordinator').id,disk=h.disk,events=disk.get(id);
    await h.runtime.close();await store.close();disk.delete(id);
    store=await JournalStore.open(dir);h=harness(store,disk);await h.runtime.tick();
    const revision=store.snapshot().revision;await h.runtime.tick();
    assert.equal(store.snapshot().revision,revision);
    assert.equal(store.snapshot().projects.p.notifications.length,1);assert.equal(h.stats().creates,0);
    disk.set(id,events);await h.runtime.tick();assert.equal(h.find('coordinator').id,id);
    assert.equal(store.snapshot().projects.p.notifications[0].resolved,true);
  } finally {await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('a reservation persisted before creation begins can safely create its original session after restart',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-reserved-'));let store=await JournalStore.open(dir),h=harness(store);
  try {
    await h.controller.userCommand(project);
    await store.dispatchRuntime({type:'reserve-agent',key:'coordinator:p:1',sessionId:'reserved-session',binding:{role:'coordinator',project:'p',configVersion:1}});
    await h.runtime.close();await store.close();store=await JournalStore.open(dir);h=harness(store);
    await h.runtime.tick();assert.equal(h.find('coordinator').id,'reserved-session');
    assert.equal(h.stats().creates,1);assert.equal(h.stats().resumes,0);
    assert.equal(store.snapshot().runtimeAgents['coordinator:p:1'].phase,'starting');
    assert(h.disk.has('reserved-session'));await h.runtime.tick();assert.equal(h.stats().creates,1);
  } finally {await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('creation intent without physical session never authorizes another create',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-starting-'));const store=await JournalStore.open(dir),h=harness(store);
  try {
    await h.controller.userCommand(project);
    await store.dispatchRuntime({type:'reserve-agent',key:'coordinator:p:1',sessionId:'ambiguous-session',binding:{role:'coordinator',project:'p',configVersion:1}});
    await store.dispatchRuntime({type:'begin-agent',key:'coordinator:p:1',sessionId:'ambiguous-session'});
    await h.runtime.tick();await h.runtime.tick();
    assert.equal(h.stats().creates,0);assert.equal(h.stats().sends,0);
    assert.equal(store.snapshot().runtimeAgents['coordinator:p:1'].phase,'starting');
    assert.equal(store.snapshot().projects.p.notifications.length,1);
  } finally {await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('new agent with failed physical checkpoint is revoked before any model message',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-checkpoint-'));const store=await JournalStore.open(dir),h=harness(store);
  try {
    await h.controller.userCommand(project);h.ctx.sessions.flush=async()=>false;
    await h.runtime.tick();assert.equal(h.stats().creates,1);assert.equal(h.stats().sends,0);assert.equal(h.live.size,0);
    assert.equal(store.snapshot().runtimeAgents['coordinator:p:1'].phase,'starting');
    await h.runtime.tick();assert.equal(h.stats().creates,1);assert.equal(h.stats().sends,0);
  } finally {await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('native user-confirmed coordinator recovery sends one new wake without resetting supervision',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-user-wake-'));let store=await JournalStore.open(dir),h=harness(store);
  try {
    await h.controller.userCommand(project);await h.runtime.tick();const boss=h.find('coordinator');
    boss.session.events[0].data.target='next-turn';boss.session.events[0].data.start=0;
    boss.session.events.push({type:'turn/start',data:{turn:1}},{type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
    boss.status='idle';await h.runtime.tick();
    const notification=store.snapshot().projects.p.notifications[0].id,root={id:'outer'};
    const control=new UserControl(h.controller,{agents:{get:()=>root,roots:()=>[root]},userQuestions:{ask:async q=>({answers:[{id:q.questions[0].id,selected:['确认执行']}]})}});control.bindRoot(root);
    const command={type:'resume-coordinator',project:'p',notification,reason:'请重新读取目标，提交第一个里程碑方案。'};
    await assert.rejects(h.controller.modelCommand(boss,command),/This role cannot issue/);
    await control.request(root,command);await h.runtime.tick();await h.runtime.tick();
    assert.equal(h.stats().sends,2);assert.equal(h.find('coordinator').id,boss.id);
    const p=store.snapshot().projects.p;assert.equal(p.coordinatorWake,1);assert.equal(p.configVersion,1);assert.equal(p.denialLimit,3);assert.equal(p.notifications[0].resolved,true);
    await assert.rejects(control.request(root,command),/active coordinator-stall/);
    assert.equal(Object.values(store.snapshot().outbox).filter(j=>j.text.includes(command.reason)).length,1);
    const disk=h.disk;await h.runtime.close();await store.close();store=await JournalStore.open(dir);h=harness(store,disk);await h.runtime.tick();
    assert.equal(h.stats().sends,0);assert.equal(store.snapshot().projects.p.coordinatorWake,1);
  } finally {await h.runtime.close();await store.close();await fs.rm(dir,{recursive:true,force:true});}
});
