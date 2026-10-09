import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/controller.mjs';
import {initialState,transition} from '../src/core.mjs';
import {createRoleComposer} from '../src/role-tools.mjs';
import {planReviewDeliveries,reviewPhaseInstruction} from '../src/review-scheduler.mjs';
test('planning reviewers receive plan criteria without artifact or execution-evidence tools',async()=>{
  let state=initialState();const store={snapshot:()=>structuredClone(state),dispatch:async(a,c)=>state=transition(state,a,c)};
  const controller=new Controller(store,{captureArtifact:async()=>{throw Error('No plan artifact');}});
  await controller.userCommand({type:'create',id:'p',workspace:'D:/phase-test',objective:'Build',reviewers:[{id:'r',name:'Quality',responsibility:'Tests',criteria:'Tests pass'}]});
  const manager={id:'c'};controller.bind(manager,{role:'coordinator',project:'p',configVersion:1});
  await controller.modelCommand(manager,{type:'propose',definition:{id:'m',title:'Build',criteria:'Executable tests',deps:[]}});
  const round=Object.values(state.projects.p.rounds)[0],agent={id:'r'},binding={role:'reviewer',project:'p',reviewer:'r',round:round.id,generation:1,attempt:1,configVersion:1};
  controller.bind(agent,binding);let prompt;const tools=new Map();
  const ctx={agent,get:name=>name==='tools'?{restrict(){},presentAs(){},guard(){},register:t=>tools.set(t.name,t)}:{section:s=>prompt=s.text}};
  await createRoleComposer(controller,{artifacts:{},verification:{}})(ctx,binding);
  assert.deepEqual([...tools.keys()],['foreman_read','foreman_command']);
  assert((typeof prompt==='function'?prompt({}):prompt).includes('代码尚未开始实现'));
  const read=JSON.parse((await tools.get('foreman_read').execute({}, {agent})).text);
  assert.equal(read.round.kind,'plan');assert(read.phaseInstruction.includes('没有制品快照和执行证据是正常的'));
  assert(planReviewDeliveries(state)[0].text.includes('kind=plan'));assert(!planReviewDeliveries(state)[0].text.includes('这是成品验收'));
  assert(reviewPhaseInstruction('change').includes('规划/变更审查'));assert(reviewPhaseInstruction('acceptance').includes('本阶段必要证据缺失仍须否决'));
  await controller.close();
});

test('stage review exposes the current milestone and future dependencies without disclosing peer votes',async()=>{
  const agent={id:'r'},binding={role:'reviewer',project:'p',reviewer:'r',round:'stage',generation:1,attempt:1,configVersion:1};
  const p={status:'running',configVersion:1,objective:'Function, tests and docs',reviewers:[{id:'r',criteria:'Tests and docs'}],
    milestones:{m1:{id:'m1',criteria:'Function implemented and verified',deps:[]},m2:{id:'m2',criteria:'Test file and README',deps:['m1']}},
    rounds:{stage:{kind:'acceptance',milestone:'m1',status:'open',generation:1,attempts:{},votes:{other:{findings:'private peer vote'}},payload:{artifact:'snapshot'}}}};
  const controller={identity:()=>({...binding,controlVersion:0,id:agent.id}),view:()=>structuredClone(p)};
  const tools=new Map();let prompt;
  await createRoleComposer(controller,{artifacts:{},verification:{}})({agent,get:name=>name==='tools'?{restrict(){},presentAs(){},guard(){},register:t=>tools.set(t.name,t)}:{section:s=>prompt=s.text}},binding);
  const read=JSON.parse((await tools.get('foreman_read').execute({}, {agent})).text);
  assert.deepEqual(read.currentMilestone,p.milestones.m1);
  assert.deepEqual(read.milestones.m2.deps,['m1']);
  assert.equal(read.round.votes,undefined);
  assert((typeof prompt==='function'?prompt({}):prompt).includes('不是项目最终验收'));
  assert(read.phaseInstruction.includes('不得仅因明确归属后续里程碑'));
  assert(tools.has('foreman_evidence'));assert(tools.has('foreman_artifact'));
  assert(!reviewPhaseInstruction('final').includes('后续里程碑'));
});
