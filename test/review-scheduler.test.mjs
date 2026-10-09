import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,transition} from '../src/core.mjs';
import {outboxTransition} from '../src/outbox.mjs';
import {planReviewDeliveries,reviewEligibility,syncReviewQueue} from '../src/review-scheduler.mjs';

function fixture() {
  let s=transition(initialState(),{role:'user'},{type:'create',id:'p',objective:'Build application',workspace:'D:/work',reviewers:['a','b'].map(id=>({id,name:id,responsibility:'Independent review',criteria:'Evidence required'}))});
  const command=(actor,c)=>{s=transition(s,actor,{project:'p',...c});};
  command({role:'coordinator',project:'p'},{type:'propose',definition:{id:'m',title:'Milestone',criteria:'Tested',deps:[]}});
  return {get state(){return s;},command,
    store:{snapshot:()=>structuredClone(s),dispatchOutbox:async c=>{s=outboxTransition(s,c);return structuredClone(s);}},
    round:()=>Object.values(s.projects.p.rounds)[0]};
}

test('each missing supervisor receives one stable job; repeated sync does not grow journal',async()=>{
  const f=fixture();await syncReviewQueue(f.store);const before=f.state.revision;
  assert.equal(Object.keys(f.state.outbox).length,2);
  await syncReviewQueue(f.store);assert.equal(f.state.revision,before);
  const r=f.round();f.command({role:'reviewer',project:'p',reviewer:'a'},{type:'vote',round:r.id,generation:1,pass:true,findings:'Reviewed evidence'});
  await syncReviewQueue(f.store);
  assert.equal(Object.values(f.state.outbox).filter(j=>j.status==='queued').length,1);
  assert.equal(planReviewDeliveries(f.state)[0].subject.reviewer,'b');
});

test('locked rule changes invalidate queued review, including atomic claim after earlier eligibility check',async()=>{
  const f=fixture();await syncReviewQueue(f.store);const job=Object.values(f.state.outbox)[0];
  assert.equal(reviewEligibility(f.state,job),'ready');
  f.command({role:'user'},{type:'configure',objective:'Changed requirement'});
  await assert.rejects(f.store.dispatchOutbox({type:'claim',id:job.id,owner:'host'}),/stale/);
  await syncReviewQueue(f.store);assert(Object.values(f.state.outbox).every(j=>j.status==='cancelled'));
});

test('review faults schedule a new attempt identity without repeating successful reviewers',async()=>{
  const f=fixture();await syncReviewQueue(f.store);const before=Object.values(f.state.outbox);const r=f.round();
  f.command({role:'reviewer',project:'p',reviewer:'a'},{type:'review-fault',round:r.id,generation:1,attempt:1,error:'Provider failure'});
  await syncReviewQueue(f.store);
  const fresh=planReviewDeliveries(f.state).find(j=>j.subject.reviewer==='a');
  assert.equal(fresh.subject.attempt,2);assert(!before.some(j=>j.id===fresh.id));
  assert.equal(f.state.outbox[before.find(j=>j.subject.reviewer==='a').id].status,'cancelled');
});

test('faulted round waits for user recovery; generation bump invalidates old queued jobs',async()=>{
  const f=fixture();await syncReviewQueue(f.store);const jobs=Object.values(f.state.outbox),r=f.round();
  for(let i=1;i<=4;i++)f.command({role:'reviewer',project:'p',reviewer:'a'},{type:'review-fault',round:r.id,generation:1,attempt:i,error:'timeout'});
  assert.deepEqual(planReviewDeliveries(f.state),[]);
  assert.equal(reviewEligibility(f.state,jobs.find(j=>j.subject.reviewer==='b')),'blocked');
  f.command({role:'user'},{type:'resume-review',round:r.id});await syncReviewQueue(f.store);
  assert(jobs.every(j=>f.state.outbox[j.id].status==='cancelled'));
  assert(planReviewDeliveries(f.state).every(j=>j.subject.generation===2));
});
