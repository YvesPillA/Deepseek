import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoleComposer} from '../src/role-tools.mjs';
import {initialState,transition} from '../src/core.mjs';
import {planReviewDeliveries,reviewPhaseInstruction} from '../src/review-scheduler.mjs';

const fixture=()=>({id:'p',status:'running',configVersion:1,objective:'One complete SVG',audit:['internal'],
  reviewers:[{id:'r',responsibility:'Animation',criteria:'Exact requirements'}],
  milestones:{m:{id:'m',status:'work',criteria:'All locked criteria',deps:[],denials:1,limit:3}},
  tasks:{done:{id:'done',status:'completed',instructions:'long prior instructions',result:'full implementation evidence',failures:[]},
    running:{id:'running',status:'running',instructions:'precise live assignment',result:null,failures:['old failure'],dependencyWait:'permission'}},
  rounds:{passed:{id:'passed',status:'closed',kind:'acceptance',votes:{r:{pass:true,findings:'future recommendation',affected:['m']}}},
    denied:{id:'denied',status:'closed',kind:'plan',votes:{r:{pass:false,findings:'specific rework issue',affected:['m']}}},
    open:{id:'open',status:'open',kind:'acceptance',votes:{r:{pass:true,findings:'current advice'}},generation:1,attempts:{}}},
  notifications:['Permission changed'],failures:['fault']});
async function setup(p=fixture()) {
  const agent={id:'c',session:{surface:{replaceGeneration:0}}},binding={role:'coordinator',project:'p',configVersion:1},tools=new Map();let prompt,guard,eventListener;
  const controller={identity:subject=>{assert.equal(subject,agent);return {...binding,controlVersion:0,id:agent.id};},view:()=>structuredClone(p)};
  const ctx={agent,on:(name,fn)=>{assert.equal(name,'session/event');eventListener=fn;},get:name=>name==='tools'?{restrict(){},presentAs(){},guard:f=>guard=f,register:t=>tools.set(t.name,t)}:{section:s=>prompt=s.text}};
  await createRoleComposer(controller)(ctx,binding);
  return {agent,binding,tools,prompt,guard,p,event:(session,event)=>eventListener(session,event)};
}

test('coordinator summary preserves actionable requirements, failures and denial findings with complete history on demand',async()=>{
  const {agent,tools,prompt,p}=await setup();
  const view=JSON.parse((await tools.get('foreman_read').execute({}, {agent})).text);
  assert.deepEqual(view.reviewers,p.reviewers);assert.deepEqual(view.milestones,p.milestones);
  assert.deepEqual(view.tasks.running,p.tasks.running);
  assert.deepEqual(view.rounds.denied.votes,p.rounds.denied.votes);
  assert.deepEqual(view.rounds.open,p.rounds.open);
  assert.deepEqual(view.notifications,p.notifications);assert.deepEqual(view.failures,p.failures);
  assert.equal(view.audit,undefined);assert.equal(view.tasks.done.instructions,undefined);assert.equal(view.tasks.done.result,undefined);
  assert.deepEqual(view.tasks.done.detail,{kind:'task',id:'done',hasInstructions:true,hasResult:true});
  assert.equal(view.rounds.passed.votes.r.findings,undefined);assert.equal(view.rounds.passed.votes.r.hasFindings,true);
  assert.deepEqual(view.rounds.passed.votes.r.affected,['m']);
  const read=async(kind,id)=>JSON.parse((await tools.get('foreman_detail').execute({kind,id},{agent})).text);
  assert.deepEqual(await read('task','done'),p.tasks.done);
  assert.deepEqual(await read('round','passed'),p.rounds.passed);
  assert.deepEqual(await read('round','denied'),p.rounds.denied);
  assert.equal(p.tasks.done.instructions,'long prior instructions');
  assert(prompt.includes('一个完整里程碑'));assert(prompt.includes('结束本回合等待宿主唤醒'));
});

test('historical read is strictly bound to the live coordinator and current project',async()=>{
  const {agent,binding,tools,guard,p}=await setup(),tool=tools.get('foreman_detail');
  await assert.rejects(tool.execute({kind:'task',id:'done'},{agent:{id:'c'}}),/another agent/);
  await assert.rejects(tool.execute({kind:'task',id:'other-project:done'},{agent}),/outside this project/);
  await assert.rejects(tool.execute({kind:'task',id:'toString'},{agent}),/outside this project/);
  await assert.rejects(tool.execute({kind:'task',id:'done',project:'another'},{agent}),/Invalid detail/);
  binding.project='another';
  await assert.rejects(tool.execute({kind:'task',id:'done'},{agent}),/another assignment/);
  binding.project='p';p.configVersion=2;
  assert.match(guard({name:'foreman_detail',agent}),/expired/);
  await assert.rejects(tool.execute({kind:'task',id:'done'},{agent}),/expired/);
  p.configVersion=1;p.status='cancelled';
  await assert.rejects(tool.execute({kind:'task',id:'done'},{agent}),/closed/);
});

test('reviewer tools do not gain coordinator historical access or peer votes',async()=>{
  const p=fixture(),agent={id:'other'},binding={role:'reviewer',project:'p',reviewer:'other',round:'open',generation:1,attempt:1,configVersion:1},tools=new Map();let guard;
  const controller={identity:()=>({...binding,controlVersion:0,id:agent.id}),view:()=>structuredClone(p)};
  await createRoleComposer(controller)({agent,get:name=>name==='tools'?{restrict(){},presentAs(){},guard:f=>guard=f,register:t=>tools.set(t.name,t)}:{section(){}}},binding);
  assert(!tools.has('foreman_detail'));assert.match(guard({name:'foreman_detail',agent}),/outside the locked foreman role/);
  const view=JSON.parse((await tools.get('foreman_read').execute({}, {agent})).text);
  assert.equal(view.round.votes,undefined);assert.equal(view.tasks,undefined);
});

test('incremental coordinator reads recheck exact identity, project, configuration and cancellation',async()=>{
  const {agent,binding,tools,p}=await setup(),tool=tools.get('foreman_read');
  const full=JSON.parse((await tool.execute({},{agent})).text),args={sinceCursor:full._read.cursor};
  const unchanged=JSON.parse((await tool.execute(args,{agent})).text);
  assert.equal(unchanged._read.full,false);assert.deepEqual(unchanged.changes,[]);
  assert.equal(unchanged._read.baseCursor,full._read.cursor);
  await assert.rejects(tool.execute(args,{agent:{id:agent.id}}),/another agent/);
  binding.project='other';await assert.rejects(tool.execute(args,{agent}),/another assignment/);binding.project='p';
  p.configVersion=2;await assert.rejects(tool.execute(args,{agent}),/expired/);p.configVersion=1;
  p.status='cancelled';await assert.rejects(tool.execute(args,{agent}),/closed/);p.status='running';
  await assert.rejects(tool.execute({sinceCursor:full._read.cursor,project:'p'},{agent}),/Invalid read/);
  await assert.rejects(tool.execute({sinceCursor:'invalid'},{agent}),/Invalid read/);
  assert.equal(JSON.parse((await tool.execute({sinceCursor:'f'.repeat(64)},{agent})).text)._read.full,true);
  const another=await setup(p);
  assert.equal(JSON.parse((await another.tools.get('foreman_read').execute(args,{agent:another.agent})).text)._read.full,true);
  const reset=JSON.parse((await tool.execute({},{agent})).text);assert.equal(reset._read.full,true);
  assert.deepEqual(reset.reviewers,p.reviewers);assert.deepEqual(reset.rounds.denied.votes,p.rounds.denied.votes);
});

test('turn starts, compaction summaries and surface replacement force full state after model baseline loss',async()=>{
  const {agent,tools,event,p}=await setup(),tool=tools.get('foreman_read');
  const read=async cursor=>JSON.parse((await tool.execute(cursor?{sinceCursor:cursor}:{},{agent})).text);
  let full=await read();assert.equal((await read(full._read.cursor))._read.full,false);
  event({}, {type:'compaction/summary'});assert.equal((await read(full._read.cursor))._read.full,false);
  event(agent.session,{type:'compaction/summary'});full=await read(full._read.cursor);assert.equal(full._read.full,true);
  event(agent.session,{type:'turn/start'});full=await read(full._read.cursor);assert.equal(full._read.full,true);
  agent.session.surface.replaceGeneration++;const replaced=await read(full._read.cursor);assert.equal(replaced._read.full,true);
  assert.deepEqual(replaced.reviewers,p.reviewers);assert.deepEqual(replaced.rounds.denied.votes,p.rounds.denied.votes);
});

test('passed closed round payloads are available on demand while unresolved and denied material stays inline',async()=>{
  const p=fixture();
  Object.assign(p,{denialLimit:3,patrolEvery:3,faultRetries:3});
  p.rounds.passed.outcome='passed';p.rounds.passed.payload={artifact:'sha256:accepted',planVersion:1};
  p.rounds.plan={id:'plan',kind:'plan',status:'closed',outcome:'passed',payload:{definition:{id:'m',criteria:'Approved complete definition',deps:[]}},votes:{r:{pass:true,findings:'Approved'}}};
  p.rounds.denied.outcome='rejected';p.rounds.denied.payload={definition:{id:'m',criteria:'Must fix missing tests'}};
  p.rounds.open.payload={artifact:'sha256:current',planVersion:1};
  p.rounds.faulted={id:'faulted',kind:'change',status:'faulted',payload:{definition:{criteria:'Pending technical recovery'}},votes:{}};
  p.rounds.unknown={id:'unknown',kind:'plan',status:'closed',payload:{definition:{criteria:'No recorded outcome'}},votes:{}};
  const original=structuredClone(p),{agent,tools}=await setup(p);
  const view=JSON.parse((await tools.get('foreman_read').execute({},{agent})).text);
  for(const id of ['passed','plan']) {
    assert.equal(view.rounds[id].payload,undefined);
    assert.deepEqual(view.rounds[id].detail,{kind:'round',id,hasPayload:true});
    assert.deepEqual(JSON.parse((await tools.get('foreman_detail').execute({kind:'round',id},{agent})).text),original.rounds[id]);
  }
  for(const id of ['denied','open','faulted','unknown'])assert.deepEqual(view.rounds[id].payload,original.rounds[id].payload);
  for(const key of ['objective','reviewers','milestones','denialLimit','patrolEvery','faultRetries'])assert.deepEqual(view[key],original[key]);
  assert.deepEqual(view.tasks.running,original.tasks.running);
  assert.deepEqual(p,original,'projection must never mutate live state or historical payloads');
});

test('real core settlement marks accepted planning and acceptance payloads with outcome passed',async()=>{
  const user={role:'user'},manager={role:'coordinator',project:'p',id:'c'},reviewer={role:'reviewer',project:'p',reviewer:'r',id:'r'},worker={role:'executor',project:'p',id:'w'};
  let state=transition(initialState(),user,{type:'create',id:'p',workspace:'D:/fixture',objective:'Deliver exact scope',reviewers:[{id:'r',name:'Review',responsibility:'Quality',criteria:'Working and verified'}]});
  const command=(actor,c)=>state=transition(state,actor,{project:'p',...c});
  const latest=()=>Object.values(state.projects.p.rounds).at(-1);
  const approve=()=>command(reviewer,{type:'vote',round:latest().id,generation:latest().generation,pass:true,findings:'Inspected exact material'});
  command(manager,{type:'propose',definition:{id:'m',title:'Complete task',criteria:'Working and verified',deps:[]}});approve();
  const plan=structuredClone(latest());assert.equal(plan.outcome,'passed');assert.equal(plan.passed,undefined);
  command(manager,{type:'task',milestone:'m',id:'t',title:'Implement',instructions:'Implement and verify'});
  command(manager,{type:'assign',task:'t',agentId:'w'});command(worker,{type:'complete',task:'t',result:'Implemented and verified'});
  command(manager,{type:'submit',milestone:'m',artifact:'sha256:exact'});approve();
  const acceptance=structuredClone(latest());assert.equal(acceptance.outcome,'passed');
  const p=state.projects.p,original=structuredClone(p),{agent,tools}=await setup(p);
  const view=JSON.parse((await tools.get('foreman_read').execute({},{agent})).text);
  for(const round of [plan,acceptance]) {
    assert.equal(view.rounds[round.id].payload,undefined);assert.equal(view.rounds[round.id].detail.hasPayload,true);
    assert.deepEqual(JSON.parse((await tools.get('foreman_detail').execute({kind:'round',id:round.id},{agent})).text),round);
  }
  assert.deepEqual(view.reviewers,original.reviewers);assert.equal(view.denialLimit,3);assert.equal(view.patrolEvery,3);assert.equal(view.faultRetries,3);
  assert.deepEqual(view.milestones,original.milestones);assert.deepEqual(p,original);
});

test('review wakeups retain assignment and refer to unchanged authoritative phase instructions without duplicating them',()=>{
  for(const kind of ['plan','change','acceptance','patrol','final']) {
    const p=fixture();p.rounds={open:{...p.rounds.open,kind,votes:{},milestone:'m',payload:{planVersion:1}}};
    p.milestones.m.status=kind==='final'?'passed':'review';p.milestones.m.planVersion=1;
    const [job]=planReviewDeliveries({projects:{p}});assert(job,kind);
    assert(job.text.includes('foreman_read'));assert(job.text.includes('generation=1'));assert(job.text.includes('kind='+kind));
    assert(job.text.includes('监督者 r'));assert(job.text.includes('轮次 open'));assert(job.text.includes('foreman_command 提交 vote'));
    assert(job.text.includes('角色系统说明'));assert(job.text.includes('phaseInstruction'));
    assert(!job.text.includes(reviewPhaseInstruction(kind)));
    assert.deepEqual(p.reviewers,fixture().reviewers);
  }
});
