import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoleComposer} from '../src/role-tools.mjs';

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
  const agent={id:'c'},binding={role:'coordinator',project:'p',configVersion:1},tools=new Map();let prompt,guard;
  const controller={identity:subject=>{assert.equal(subject,agent);return {...binding,id:agent.id};},view:()=>structuredClone(p)};
  const ctx={agent,get:name=>name==='tools'?{restrict(){},presentAs(){},guard:f=>guard=f,register:t=>tools.set(t.name,t)}:{section:s=>prompt=s.text}};
  await createRoleComposer(controller)(ctx,binding);
  return {agent,binding,tools,prompt,guard,p};
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
  const controller={identity:()=>({...binding,id:agent.id}),view:()=>structuredClone(p)};
  await createRoleComposer(controller)({agent,get:name=>name==='tools'?{restrict(){},presentAs(){},guard:f=>guard=f,register:t=>tools.set(t.name,t)}:{section(){}}},binding);
  assert(!tools.has('foreman_detail'));assert.match(guard({name:'foreman_detail',agent}),/outside the locked foreman role/);
  const view=JSON.parse((await tools.get('foreman_read').execute({}, {agent})).text);
  assert.equal(view.round.votes,undefined);assert.equal(view.tasks,undefined);
});
