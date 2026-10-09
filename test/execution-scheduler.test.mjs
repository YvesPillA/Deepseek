import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,transition} from '../src/core.mjs';
import {outboxTransition,DeliveryPump} from '../src/outbox.mjs';
import {pendingAssignments,planExecutionDeliveries,syncExecutionQueue,executionEligibility} from '../src/execution-scheduler.mjs';
import {syncReviewQueue} from '../src/review-scheduler.mjs';

const manager={role:'coordinator',project:'p',id:'boss'};
function fixture() {
  let s=transition(initialState(),{role:'user'},{type:'create',id:'p',objective:'Build app',workspace:'D:/work',reviewers:[{id:'r',name:'r',responsibility:'tests',criteria:'Pass'}]});
  const cmd=(a,c)=>{s=transition(s,a,{project:'p',...c});};
  const plan=(id,deps=[])=>{
    cmd(manager,{type:'propose',definition:{id,title:id,criteria:'Pass',deps}});
    const r=Object.values(s.projects.p.rounds).at(-1);
    cmd({role:'reviewer',project:'p',reviewer:'r'},{type:'vote',round:r.id,generation:1,pass:true,findings:'Plan satisfies requirements'});
  };
  const task=(id,m='a')=>cmd(manager,{type:'task',id,milestone:m,title:id,instructions:'Implement and validate'});
  return {get state(){return s;},cmd,plan,task,store:{snapshot:()=>structuredClone(s),dispatchOutbox:async c=>{s=outboxTransition(s,c);return structuredClone(s);}}};
}

test('only approved independent tasks are assignment candidates; assigned tasks generate stable deliveries',async()=>{
  const f=fixture();f.plan('a');f.plan('b',['a']);f.plan('c');f.task('t');f.task('tc','c');
  assert.deepEqual(pendingAssignments(f.state).map(x=>x.task),['t','tc']);
  assert.throws(()=>f.task('tb','b'),/not executable/);
  f.cmd(manager,{type:'assign',task:'t',agentId:'worker'});
  await syncExecutionQueue(f.store);const revision=f.state.revision;
  await syncExecutionQueue(f.store);assert.equal(f.state.revision,revision);
  const job=planExecutionDeliveries(f.state)[0];assert.equal(job.recipient,'worker');
  assert.equal(executionEligibility(f.state,job),'ready');
});

test('a new plan invalidates old pending tasks and cannot reuse their completion to pass',()=>{
  const f=fixture();f.plan('a');f.task('old');
  f.plan('a');
  assert.deepEqual(pendingAssignments(f.state),[]);
  assert.throws(()=>f.cmd(manager,{type:'assign',task:'old',agentId:'w'}),/obsolete/);
  assert.throws(()=>f.cmd(manager,{type:'submit',milestone:'a',artifact:'hash'}),/tasks must complete/);
  f.task('new');assert.equal(pendingAssignments(f.state)[0].task,'new');
});

test('completed or cancelled work is not dispatched; stale claim rejected inside state transaction',async()=>{
  const f=fixture();f.plan('a');f.task('t');f.cmd(manager,{type:'assign',task:'t',agentId:'w'});
  await syncExecutionQueue(f.store);const job=Object.values(f.state.outbox)[0];
  f.cmd({role:'executor',project:'p',id:'w'},{type:'complete',task:'t',result:'Completed with evidence'});
  await assert.rejects(f.store.dispatchOutbox({type:'claim',id:job.id,owner:'host'}),/stale/);
  await syncExecutionQueue(f.store);assert.equal(f.state.outbox[job.id].status,'cancelled');
});

test('execution completion naturally feeds review queue; transport receipts do not grant acceptance',async()=>{
  const f=fixture();f.plan('a');f.task('t');f.cmd(manager,{type:'assign',task:'t',agentId:'w'});
  await syncExecutionQueue(f.store);let sent=0;
  const transport={async deliver(job){sent++;
    if(job.subject.kind==='task')f.cmd({role:'executor',project:'p',id:'w'},{type:'complete',task:'t',result:'Implemented and tested'});
  }};
  const pump=new DeliveryPump(f.store,transport);await pump.drain();
  assert.equal(sent,1);assert.equal(f.state.projects.p.milestones.a.status,'work');
  f.cmd(manager,{type:'submit',milestone:'a',artifact:'trusted:sha'});
  await syncReviewQueue(f.store);await pump.drain();await pump.close();
  assert.equal(sent,2);assert.equal(f.state.projects.p.milestones.a.status,'review');
});

test('a failed task retains scope, stale delivery cannot execute after retry, and only coordinator retries',async()=>{
  const f=fixture();f.plan('a');f.task('t');f.cmd(manager,{type:'assign',task:'t',agentId:'w'});
  await syncExecutionQueue(f.store);const old=Object.values(f.state.outbox)[0];
  const worker={role:'executor',project:'p',id:'w',taskAttempt:1};
  f.cmd(worker,{type:'task-fault',task:'t',taskAttempt:1,error:'Model ended without completion'});
  assert.throws(()=>f.cmd(worker,{type:'retry-task',task:'t',reason:'Self retry'}),/coordinator/);
  f.cmd(manager,{type:'retry-task',task:'t',reason:'Inspect partial implementation before retry'});
  f.cmd(manager,{type:'assign',task:'t',agentId:'w2'});
  assert.equal(executionEligibility(f.state,old),'stale');
  assert.throws(()=>f.cmd({...worker,id:'w2'},{type:'complete',task:'t',result:'Wrong attempt'}),/Stale task/);
  assert.equal(f.state.projects.p.completions,0);
});
