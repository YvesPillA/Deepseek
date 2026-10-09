import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transition } from '../src/core.mjs';
import {Controller,DshAgentDriver} from '../src/controller.mjs';

function fixture() {
  let s=initialState();
  const store={snapshot:()=>structuredClone(s),dispatch:async(a,c)=>{s=transition(s,a,c);return structuredClone(s);}};
  const controller=new Controller(store,{captureArtifact:async()=> 'trusted:artifact'});
  return controller;
}
const project={type:'create',id:'p',objective:'Original objective',workspace:'D:/project',reviewers:[{id:'r',name:'Review',responsibility:'tests',criteria:'Tests must pass'}]};

test('archived projects reject model mutation before artifact capture and model roles cannot archive',async()=>{
  let state=initialState(),captures=0;
  const c=new Controller({snapshot:()=>structuredClone(state),dispatch:async(a,command)=>state=transition(state,a,command)},{captureArtifact:async()=>{captures++;return 'trusted:archive';}});
  await c.userCommand(project);const manager={id:'manager'};c.bind(manager,{role:'coordinator',project:'p'});
  await assert.rejects(c.modelCommand(manager,{type:'archive'}),/role/);await c.userCommand({type:'cancel',project:'p'});await c.userCommand({type:'archive',project:'p'});
  await assert.rejects(c.modelCommand(manager,{type:'final'}),/archived/);assert.equal(captures,0);
  await c.userCommand({type:'unarchive',project:'p'});assert.equal(c.view('p').status,'cancelled');assert.equal(c.view('p').archived,false);
});

test('panel receipt source is host-only and limited to archive/display restore',async()=>{
  let state=initialState();const c=new Controller({snapshot:()=>structuredClone(state),dispatch:async(a,command)=>state=transition(state,a,command)},{captureArtifact:async()=> 'fixture:receipt'});
  const createTicket=await c.prepareUserCommand(project);
  await assert.rejects(c.confirmUserCommand(createTicket,'panel-create',{source:'dsh-panel-operator'}),/limited to/);
  assert.equal(state.revision,0);
  await c.confirmUserCommand(createTicket,'native-create');assert.equal(state.projects.p.audit.at(-1).command.userApproval.source,'dsh-user-questions');
  // Synthetic approved state isolates receipt-source authorization; terminal
  // delivery and unanimous approval are covered by the real core workflow tests.
  state.projects.p.status='approved';const deliverTicket=await c.prepareUserCommand({type:'deliver',project:'p'});
  await assert.rejects(c.confirmUserCommand(deliverTicket,'panel-deliver',{source:'dsh-panel-operator'}),/limited to/);
  assert.equal(state.projects.p.status,'approved');await c.confirmUserCommand(deliverTicket,'native-deliver');
  const ticket=await c.prepareUserCommand({type:'archive',project:'p'}),before=structuredClone(state);
  await assert.rejects(c.confirmUserCommand(ticket,'bad-source',{source:'model'}),/Unknown human confirmation source/);assert.deepEqual(state,before);
  let checked=0;await c.confirmUserCommand(ticket,'dsh-panel-action-fixture',{source:'dsh-panel-operator',authorize:()=>checked++});
  assert(checked>=2);assert.equal(state.projects.p.archived,true);assert.deepEqual(state.projects.p.audit.at(-1).command.userApproval,{source:'dsh-panel-operator',questionId:'dsh-panel-action-fixture'});
  const restored=await c.prepareUserCommand({type:'unarchive',project:'p'});await c.confirmUserCommand(restored,'dsh-panel-restore-fixture',{source:'dsh-panel-operator'});
  assert.equal(state.projects.p.archived,false);assert.equal(state.projects.p.status,'delivered');
  await c.userCommand({type:'archive',project:'p'});const removal=await c.prepareUserCommand({type:'delete-project',project:'p'});
  await c.confirmUserCommand(removal,'dsh-panel-delete-fixture',{source:'dsh-panel-operator'});assert.equal(state.projects.p.deleted,true);
  assert.deepEqual(state.projects.p.audit.at(-1).command.userApproval,{source:'dsh-panel-operator',questionId:'dsh-panel-delete-fixture'});
});

test('record deletion confirmations reject archive ABA, concurrent deletion and revoked operator before commit',async()=>{
  const c=fixture();await c.userCommand(project);const manager={id:'manager'};c.bind(manager,{role:'coordinator',project:'p'});
  await c.userCommand({type:'cancel',project:'p'});await c.userCommand({type:'archive',project:'p'});
  const stale=await c.prepareUserCommand({type:'delete-project',project:'p'});
  await c.userCommand({type:'unarchive',project:'p'});await c.userCommand({type:'archive',project:'p'});
  await assert.rejects(c.confirmUserCommand(stale,'stale',{source:'dsh-panel-operator'}),/changed while awaiting/);assert.notEqual(c.view('p').deleted,true);
  const revoked=await c.prepareUserCommand({type:'delete-project',project:'p'});let checks=0;
  await assert.rejects(c.confirmUserCommand(revoked,'revoked',{source:'dsh-panel-operator',authorize:()=>{if(++checks===2)throw Error('Operator disposed');}}),/Operator disposed/);assert.notEqual(c.view('p').deleted,true);
  const first=await c.prepareUserCommand({type:'delete-project',project:'p'}),second=await c.prepareUserCommand({type:'delete-project',project:'p'});
  await c.confirmUserCommand(first,'native-delete');await assert.rejects(c.confirmUserCommand(second,'second'),/changed while awaiting/);
  await assert.rejects(c.modelCommand(manager,{type:'final'}),/record is deleted/);await assert.rejects(c.prepareUserCommand({type:'unarchive',project:'p'}),/deleted/);
  assert.equal(c.view('p').audit.filter(a=>a.command.type==='delete-project').length,1);
});

test('controller rejects forged identities, roles and model-provided approval fields',async()=>{
  const c=fixture();await c.userCommand(project);
  const agent={id:'executor-manager'};const revoke=c.bind(agent,{role:'coordinator',project:'p'});
  await assert.rejects(c.modelCommand({id:agent.id},{type:'propose'}),/identity/);
  await assert.rejects(c.modelCommand(agent,{type:'vote',role:'reviewer'}),/role/);
  await assert.rejects(c.modelCommand(agent,{type:'propose',actor:{role:'user'}}),/Authority/);
  await assert.rejects(c.modelCommand(agent,{type:'final',artifact:'fake:hash'}),/artifact/);
  const detached=c.viewFor(agent);detached.reviewers[0].criteria='Always pass';
  assert.equal(c.view('p').reviewers[0].criteria,'Tests must pass');
  revoke();assert.throws(()=>c.identity(agent),/identity/);
});

test('DSH driver creates supervisor under host ownership and handles setup commit, flush and dispose',async()=>{
  const c=fixture();await c.userCommand(project);
  const calls=[];
  const host={agents:{async create(options){
    assert.deepEqual(options.meta,{origin:'subagent',cwd:'D:/project'});
    calls.push('create');
    const agent={id:options.sessionId,session:{events:[]},followup(message){calls.push(['message',message]);this.session.events.push({type:'agent/inbox/spliced',data:{inserted:[message]}});}};
    const setup=await options.setup({agent});setup.commit();
    return {agent,async dispose(){calls.push('dispose');}};
  }},sessions:{async flush(){calls.push('flush');return true;}}};
  const driver=new DshAgentDriver(host,c,{compose:async()=>{calls.push('compose');}});
  for(const sessionMeta of [{origin:'user'},{origin:'subagent',cwd:'D:/untrusted'},{origin:'subagent',parentSession:'fake-parent'}])
    await assert.rejects(driver.create({role:'reviewer',project:'p',reviewer:'r'},{sessionMeta}),/classification metadata/);
  assert.equal(calls.length,0);
  const agent=await driver.create({role:'reviewer',project:'p',reviewer:'r'},{cwd:'D:/project',sessionMeta:{origin:'subagent'}});
  assert.equal(c.identity(agent).role,'reviewer');
  await driver.send(agent,{id:'message-id',text:'Review the snapshot'});
  assert.equal(calls.at(-1),'flush');await driver.close();
  assert.throws(()=>c.identity(agent),/identity/);assert.equal(calls.at(-1),'dispose');
  assert.throws(()=>new DshAgentDriver({...host,agent:{}},c,{compose(){}}),/host context/);
});

test('a supervisor cannot submit another round or reply after its technical retry was replaced',async()=>{
  const c=fixture();await c.userCommand(project);
  const manager={id:'manager'};c.bind(manager,{role:'coordinator',project:'p',configVersion:1});
  await c.modelCommand(manager,{type:'propose',definition:{id:'a',title:'A',criteria:'Tests',deps:[]}});
  const first=Object.values(c.view('p').rounds).at(-1);
  const old={id:'review-old'};c.bind(old,{role:'reviewer',project:'p',reviewer:'r',configVersion:1,round:first.id,generation:1,attempt:1});
  await c.modelCommand(manager,{type:'propose',definition:{id:'b',title:'B',criteria:'Tests',deps:[]}});
  const other=Object.values(c.view('p').rounds).at(-1);
  await assert.rejects(c.modelCommand(old,{type:'vote',round:other.id,generation:1,pass:true,findings:'Wrong round'}),/assignment/);
  await c.reviewFault(old,{round:first.id,generation:1,attempt:1,error:'Timeout'});
  await assert.rejects(c.modelCommand(old,{type:'vote',round:first.id,generation:1,pass:true,findings:'Late reply'}),/assignment/);
  const replacement={id:'review-new'};c.bind(replacement,{role:'reviewer',project:'p',reviewer:'r',configVersion:1,round:first.id,generation:1,attempt:2});
  await c.modelCommand(replacement,{type:'vote',round:first.id,generation:1,pass:true,findings:'New attempt checked plan'});
  assert.equal(c.view('p').milestones.a.status,'work');
  await c.userCommand({type:'configure',project:'p',objective:'Revised'});
  await assert.rejects(c.modelCommand(manager,{type:'task',milestone:'a',id:'t',title:'T',instructions:'Old configuration'}),/configuration/);
});

test('a queued valid verdict wins over a timeout observation made before it committed',async()=>{
  const c=fixture();await c.userCommand(project);
  const manager={id:'manager'};c.bind(manager,{role:'coordinator',project:'p',configVersion:1});
  await c.modelCommand(manager,{type:'propose',definition:{id:'a',title:'A',criteria:'Tests',deps:[]}});
  const round=Object.values(c.view('p').rounds).at(-1),agent={id:'review'};
  c.bind(agent,{role:'reviewer',project:'p',reviewer:'r',configVersion:1,round:round.id,generation:1,attempt:1});
  const vote=c.modelCommand(agent,{type:'vote',round:round.id,generation:1,pass:true,findings:'Verified'});
  const timeout=c.reviewFaultIfCurrent(agent,{round:round.id,generation:1,attempt:1,error:'Timeout observed'});
  await vote;assert.equal(await timeout,false);
  assert.deepEqual(c.view('p').rounds[round.id].attempts,{});
  assert.equal(c.view('p').milestones.a.status,'work');
});

test('driver shutdown aborts in-flight creation before waiting and is idempotent',{timeout:2000},async()=>{
  const c=fixture();let signal;
  const driver=new DshAgentDriver({agents:{create:async options=>{signal=options.signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}},c,{compose:async()=>{}});
  const creating=driver.create({role:'coordinator',project:'p'});
  const rejected=assert.rejects(creating,/closing/);
  const closing=driver.close();assert.equal(driver.close(),closing);await closing;await rejected;assert.equal(signal.aborted,true);
  await assert.rejects(driver.create({role:'coordinator',project:'p'}),/closed/i);
});

test('driver close also drains an agent whose disposal already began',{timeout:2000},async()=>{
  const c=fixture();await c.userCommand(project);let release,disposals=0;
  const driver=new DshAgentDriver({agents:{create:async options=>{
    const agent={id:options.sessionId};const setup=await options.setup({agent});setup.commit();
    return {agent,dispose:()=>{disposals++;return new Promise(r=>release=r);}};
  }}},c,{compose:async()=>{}});
  const agent=await driver.create({role:'coordinator',project:'p'});
  const disposing=driver.dispose(agent);let closed=false;const closing=driver.close().then(()=>closed=true);
  await new Promise(r=>setImmediate(r));assert.equal(closed,false);assert.equal(disposals,1);assert.throws(()=>c.identity(agent),/identity/);
  release();await disposing;await closing;assert.equal(closed,true);
});
