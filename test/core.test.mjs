import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialState, transition, projectView } from '../src/core.mjs';
import { JournalStore } from '../src/store.mjs';

const user = {role:'user'};
const manager = {role:'coordinator',project:'p',id:'manager'};
const worker = {role:'executor',project:'p',id:'worker'};
const reviewer = id => ({role:'reviewer',project:'p',id:'agent-'+id,reviewer:id});
const create = {type:'create',id:'p',objective:'Build the requested application',workspace:'D:/project',reviewers:[{id:'quality',name:'质量',responsibility:'Code quality',criteria:'Test behavior and report evidence'},{id:'functional',name:'功能',responsibility:'Requirements',criteria:'All requested behavior works'}]};
function fixture() {
  let state = transition(initialState(), user, create);
  const cmd = (actor, command) => state = transition(state, actor, {project:'p',...command});
  const project = () => state.projects.p;
  const latest = () => Object.values(project().rounds).at(-1);
  const vote = (id, pass, extra={}) => cmd(reviewer(id),{type:'vote',round:latest().id,generation:latest().generation,pass,findings:'Inspected artifact and requirements',...extra});
  const all = (pass=true) => { vote('quality',pass); vote('functional',pass); };
  const plan = (id='a',deps=[]) => {cmd(manager,{type:'propose',definition:{id,title:id,criteria:'Working and tested',deps}});all();};
  const work = (m='a',task='t') => {
    cmd(manager,{type:'task',milestone:m,id:task,title:task,instructions:'Implement and report verification'});
    cmd(manager,{type:'assign',task,agentId:'worker'});
    cmd(worker,{type:'complete',task,result:'Implementation and tests complete'});
  };
  const submit = (m='a',artifact='sha256:abc') => cmd(manager,{type:'submit',milestone:m,artifact});
  return {cmd,project,latest,vote,all,plan,work,submit,state:()=>state};
}

test('archive and unarchive preserve terminal history and never reopen execution or reuse IDs',()=>{
  for(const status of ['cancelled','delivered']) {
    const f=fixture();f.plan();f.work();
    if(status==='delivered'){f.submit();f.all();f.cmd(manager,{type:'final',artifact:'final:archive-fixture'});f.all();f.cmd(user,{type:'deliver'});}
    else f.cmd(user,{type:'cancel'});
    const before=structuredClone(f.project());
    f.cmd(user,{type:'archive'});const archived=f.project();
    assert.equal(f.state().version,1);assert.equal(archived.archived,true);assert.equal(archived.status,status);assert.equal(archived.archiveVersion,1);
    assert.equal(typeof archived.archivedAt,'string');
    for(const field of ['workspace','reviewers','milestones','tasks','rounds','configVersion','denialLimit','patrolEvery','faultRetries'])assert.deepEqual(archived[field],before[field],field);
    assert.deepEqual(archived.audit.slice(0,-1),before.audit);assert.equal(archived.audit.at(-1).command.type,'archive');
    const exact=JSON.stringify(f.state());
    for(const actor of [manager,worker,reviewer('quality')])assert.throws(()=>f.cmd(actor,{type:'unarchive'}),/User authorization/);
    assert.throws(()=>f.cmd(user,{type:'configure',objective:'New goal'}),/archived/);assert.throws(()=>f.cmd(user,{type:'cancel'}),/archived/);
    assert.throws(()=>f.cmd(user,{type:'archive'}),/already archived/);assert.equal(JSON.stringify(f.state()),exact);
    f.cmd(user,{type:'unarchive'});assert.equal(f.project().archived,false);assert.equal(f.project().archiveVersion,2);assert.equal(f.project().status,status);
    assert.throws(()=>f.cmd(manager,{type:'propose',definition:{id:'new',title:'New',criteria:'New',deps:[]}}),/closed/);
    assert.throws(()=>transition(f.state(),user,create),/already exists/);
  }
});

test('legacy v1 projects remain visible and cannot be archived while active or final approval is pending',()=>{
  const f=fixture();assert.equal(f.project().archived,undefined);
  for(const actor of [manager,worker,reviewer('quality')])assert.throws(()=>f.cmd(actor,{type:'archive'}),/User authorization/);
  assert.throws(()=>f.cmd(user,{type:'archive'}),/Only cancelled or delivered/);
  f.plan();f.work();f.submit();f.all();f.cmd(manager,{type:'final',artifact:'final:archive-fixture'});f.all();
  assert.equal(f.project().status,'approved');assert.throws(()=>f.cmd(user,{type:'archive'}),/Only cancelled or delivered/);
});

test('archived terminal projects and their files survive journal reopen without changing another project',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-archive-')),journal=path.join(root,'journal'),workspace=path.join(root,'workspace'),sessions=path.join(root,'sessions');
  await fs.mkdir(workspace);await fs.mkdir(sessions);await fs.writeFile(path.join(workspace,'source.txt'),'user source remains');await fs.writeFile(path.join(sessions,'history.jsonl'),'session remains');
  let store=await JournalStore.open(journal);
  try {
    await store.dispatch(user,{...create,workspace});await store.dispatch(user,{...create,id:'other',workspace:path.join(root,'other')});
    const other=structuredClone(store.snapshot().projects.other);
    await store.dispatch(user,{type:'cancel',project:'p'});await store.dispatch(user,{type:'archive',project:'p'});
    const saved=store.snapshot();await store.close();store=await JournalStore.open(journal);
    assert.deepEqual(store.snapshot(),saved);assert.deepEqual(store.snapshot().projects.other,other);assert.equal(store.snapshot().version,1);
    await store.dispatch(user,{type:'unarchive',project:'p'});assert.equal(store.snapshot().projects.p.status,'cancelled');
    assert.equal(await fs.readFile(path.join(workspace,'source.txt'),'utf8'),'user source remains');assert.equal(await fs.readFile(path.join(sessions,'history.jsonl'),'utf8'),'session remains');
  } finally {await store.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});}
});

test('new and changed plans reject cancelled dependencies without mutating state',()=>{
  const f=fixture();f.plan('a');f.plan('b');
  f.cmd(user,{type:'cancel-milestone',milestone:'a'});
  for(const id of ['new','b']) {
    const before=f.state();
    assert.throws(()=>f.cmd(manager,{type:'propose',definition:{id,title:id,criteria:'Working',deps:['a']}}),/Cancelled dependency/);
    assert.deepEqual(f.state(),before);
  }
  f.work('b');
});

test('pending changed dependencies prevent cancellation, including faulted review',()=>{
  for(const faulted of [false,true]) {
    const f=fixture();f.plan('a');f.plan('b');
    f.cmd(manager,{type:'propose',definition:{id:'b',title:'b revised',criteria:'Working',deps:['a']}});
    if(faulted)for(let attempt=1;attempt<=4;attempt++)f.cmd(reviewer('quality'),{type:'review-fault',round:f.latest().id,generation:1,attempt,error:'Service failed'});
    assert.throws(()=>f.cmd(user,{type:'cancel-milestone',milestone:'a'}),/pending dependent/);
    if(faulted)f.cmd(user,{type:'resume-review',round:f.latest().id});
    f.all(false);
    f.cmd(user,{type:'cancel-milestone',milestone:'a'});
    assert.equal(f.project().milestones.a.status,'cancelled');
  }
});

test('execution identity cannot vote, configure, extend, deliver or act across projects', () => {
  const f=fixture(); f.plan(); f.work(); f.submit();
  for(const command of [{type:'vote',round:f.latest().id,generation:1,pass:true,findings:'self-approved'},{type:'configure',objective:'less work'},{type:'extend',milestone:'a',additional:3},{type:'deliver'}]) {
    const before=f.state(); assert.throws(()=>f.cmd(manager,command)); assert.deepEqual(f.state(),before);
  }
  assert.throws(()=>f.cmd({...manager,project:'another'},{type:'final',artifact:'x'}),/Cross-project/);
});

test('a round waits for all reviewers and counts multiple denials only once; third denial pauses', () => {
  const f=fixture(); f.plan(); f.work();
  for(let i=1;i<=3;i++) {
    f.submit(); f.vote('quality',false);
    assert.equal(f.project().milestones.a.denials,i-1);
    f.vote('functional',false);
    assert.equal(f.project().milestones.a.denials,i);
    assert.equal(f.project().milestones.a.status,i===3?'paused':'work');
  }
  assert.equal(f.project().notifications.filter(n=>n.kind==='decision').length,1);
  f.cmd(user,{type:'extend',milestone:'a',additional:2});
  assert.equal(f.project().milestones.a.denials,3);
  assert.equal(f.project().milestones.a.limit,5);
  assert.equal(f.project().notifications.find(n=>n.kind==='decision').resolved,true);
});

test('resuming one review resolves its notification without hiding a different faulted review',()=>{
  const f=fixture();
  for(const id of ['a','b']) {
    f.cmd(manager,{type:'propose',definition:{id,title:id,criteria:'Pass',deps:[]}});
    for(let attempt=1;attempt<=4;attempt++)f.cmd(reviewer('quality'),{type:'review-fault',round:f.latest().id,generation:1,attempt,error:'Service failed'});
  }
  const rounds=Object.values(f.project().rounds);
  f.cmd(user,{type:'resume-review',round:rounds[0].id});
  assert.equal(f.project().notifications.find(n=>n.round===rounds[0].id).resolved,true);
  assert.equal(f.project().notifications.find(n=>n.round===rounds[1].id).resolved,undefined);
  f.cmd(user,{type:'cancel'});assert(f.project().notifications.every(n=>n.resolved));
});

test('plan changes and acceptance share milestone denial counter',()=>{
  const f=fixture();f.plan();f.work();f.submit();f.all(false);
  f.cmd(manager,{type:'propose',definition:{id:'a',title:'a revised',criteria:'Working and tested',deps:[]}});f.all(false);
  f.submit();f.all(false);
  assert.equal(f.project().milestones.a.status,'paused');
  assert.equal(f.project().milestones.a.planVersion,1);
});

test('paused milestone blocks its dependents, independent work continues',()=>{
  const f=fixture();f.plan('a');f.plan('b',['a']);f.plan('c');f.work('a','ta');
  for(let i=0;i<3;i++){f.submit('a');f.all(false);}
  assert.throws(()=>f.work('b','tb'),/not executable/);
  f.work('c','tc');
  assert.deepEqual(projectView(f.state(),'p').milestones.b.blockedBy,['a']);
});

test('every third distinct completed task triggers non-blocking patrol; no duplicate counting',()=>{
  const f=fixture();f.plan();
  f.work('a','t1');f.work('a','t2');f.work('a','t3');
  assert.equal(f.latest().kind,'patrol');
  f.cmd(worker,{type:'complete',task:'t3',result:'duplicate message'});
  assert.equal(f.project().completions,3);
  f.work('a','t4'); // Patrol does not stop execution.
  f.all(false);
  assert.equal(f.project().milestones.a.denials,0);
  f.submit();
});

test('review failures retry separately; stale responses cannot settle a resumed review',()=>{
  const f=fixture();f.plan();f.work();f.submit();const rid=f.latest().id;
  for(let i=1;i<=4;i++)f.cmd(reviewer('quality'),{type:'review-fault',round:rid,generation:1,attempt:i,error:'Network timeout'});
  assert.equal(f.latest().status,'faulted');assert.equal(f.project().milestones.a.denials,0);
  assert.throws(()=>f.vote('functional',true),/not open/);
  f.cmd(user,{type:'resume-review',round:rid});
  assert.throws(()=>f.cmd(reviewer('quality'),{type:'vote',round:rid,generation:1,pass:true,findings:'old reply'}),/Stale/);
  f.all();assert.equal(f.project().milestones.a.status,'passed');
});

test('final rejection reopens affected milestone and invalidates descendants approvals',()=>{
  const f=fixture();f.plan();f.work();f.submit();f.all();
  f.plan('b',['a']);f.work('b','tb');f.submit('b');f.all();
  f.cmd(manager,{type:'final',artifact:'final:version1'});
  f.vote('quality',false,{affected:['a']});f.vote('functional',true);
  assert.equal(f.project().milestones.a.denials,1);
  assert.equal(f.project().milestones.a.status,'work');assert.equal(f.project().milestones.b.status,'work');
  assert.throws(()=>f.cmd(user,{type:'deliver'}),/Final approval/);
});

test('no final delivery before unanimous approval; duplicate votes rejected',()=>{
  const f=fixture();f.plan();f.work();f.submit();f.vote('quality',true);
  assert.throws(()=>f.vote('quality',true),/already voted/);f.vote('functional',true);
  f.cmd(manager,{type:'final',artifact:'final:version1'});f.vote('quality',true);
  assert.throws(()=>f.cmd(user,{type:'deliver'}));f.vote('functional',true);
  f.cmd(user,{type:'deliver'});assert.equal(f.project().status,'delivered');
});

test('cycles, active edits and invalid identifiers are refused transactionally',()=>{
  const f=fixture();f.plan();f.plan('b',['a']);
  assert.throws(()=>f.cmd(manager,{type:'propose',definition:{id:'a',title:'a',criteria:'ok',deps:['b']}}),/cycle/);
  assert.throws(()=>f.cmd(manager,{type:'propose',definition:{id:'__proto__',title:'a',criteria:'ok',deps:[]}}),/Invalid id/);
  f.cmd(manager,{type:'task',milestone:'a',id:'t',title:'t',instructions:'implement'});
  f.cmd(manager,{type:'assign',task:'t',agentId:'worker'});
  assert.throws(()=>f.cmd(manager,{type:'propose',definition:{id:'a',title:'a',criteria:'changed',deps:[]}}),/running tasks/);
  assert.throws(()=>f.cmd({...worker,id:'impostor'},{type:'complete',task:'t',result:'done'}),/ownership/);
});

test('changing locked user requirements invalidates previous approvals but preserves counts',()=>{
  const f=fixture();f.plan();f.work();f.submit();f.all(false);f.submit();f.all();
  f.cmd(user,{type:'configure',objective:'Build application with new requested feature'});
  assert.equal(f.project().milestones.a.status,'work');assert.equal(f.project().milestones.a.denials,1);assert.equal(f.project().configVersion,2);
});

test('concurrent plan proposals cannot reserve a dependency cycle',()=>{
  const f=fixture();f.plan('a');f.plan('b');
  f.cmd(manager,{type:'propose',definition:{id:'a',title:'a',criteria:'tested',deps:['b']}});
  const before=f.state();
  assert.throws(()=>f.cmd(manager,{type:'propose',definition:{id:'b',title:'b',criteria:'tested',deps:['a']}}),/cycle/);
  assert.deepEqual(f.state(),before);
  f.all(false); // Once rejected, its reserved edge no longer blocks the other proposal.
  f.cmd(manager,{type:'propose',definition:{id:'b',title:'b',criteria:'tested',deps:['a']}});f.all();
  assert.deepEqual(f.project().milestones.b.deps,['a']);
});

test('faulted plan reviews retain their reserved dependency edges',()=>{
  const f=fixture();f.plan('a');f.plan('b');
  f.cmd(manager,{type:'propose',definition:{id:'a',title:'a',criteria:'tested',deps:['b']}});
  for(let attempt=1;attempt<=4;attempt++)f.cmd(reviewer('quality'),{type:'review-fault',round:f.latest().id,generation:1,attempt,error:'timeout'});
  assert.throws(()=>f.cmd(manager,{type:'propose',definition:{id:'b',title:'b',criteria:'tested',deps:['a']}}),/cycle/);
});

test('cancelling scope invalidates open, faulted and approved final reviews',()=>{
  for(const status of ['open','faulted','approved']) {
    const f=fixture();f.plan('a');f.work();f.submit();f.all();
    f.plan('b');f.work('b','tb');f.submit('b');f.all();
    f.cmd(manager,{type:'final',artifact:'final:old-scope'});
    const review=f.latest().id;
    if(status==='approved')f.all();
    if(status==='faulted')for(let attempt=1;attempt<=4;attempt++)f.cmd(reviewer('quality'),{type:'review-fault',round:review,generation:1,attempt,error:'timeout'});
    f.cmd(user,{type:'cancel-milestone',milestone:'b'});
    assert.equal(f.project().status,'running');
    assert.throws(()=>f.cmd(user,{type:'deliver'}),/Final approval/);
    if(status!=='approved')assert.equal(f.project().rounds[review].status,'stale');
    f.cmd(manager,{type:'final',artifact:'final:new-scope'});f.all();
    f.cmd(user,{type:'deliver'});
  }
});

test('persistent store serializes commands, refuses second writer and preserves counters on reopen',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-test-'));
  const store=await JournalStore.open(dir);
  try {
    await assert.rejects(JournalStore.open(dir),/Writer lock/);
    await store.dispatch(user,create);
    const defs=['a','b','c'].map(id=>store.dispatch(manager,{type:'propose',project:'p',definition:{id,title:id,criteria:'tests pass',deps:[]}}));
    await Promise.all(defs); assert.equal(store.snapshot().revision,4);
    await assert.rejects(store.dispatch(manager,{type:'deliver',project:'p'}));
    await store.close();
    await fs.appendFile(path.join(dir,'state.jsonl'),'{"torn');
    const recovered=await JournalStore.open(dir);
    assert.equal(recovered.snapshot().revision,4); assert.equal(Object.keys(recovered.snapshot().projects.p.rounds).length,3);
    await recovered.close();
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
