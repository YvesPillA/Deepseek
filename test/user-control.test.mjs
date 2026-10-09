import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/controller.mjs';
import {initialState,transition} from '../src/core.mjs';
import {UserControl} from '../src/user-control.mjs';

const setup={type:'create',id:'p',workspace:'D:/project',objective:'Build application',reviewers:[{id:'r',name:'Quality',responsibility:'Check correctness',criteria:'Requested behavior passes'}]};
function fixture(ask,options={canStart:()=>true}) {
  let state=initialState();const store={snapshot:()=>structuredClone(state),dispatch:async(a,c)=>state=transition(state,a,c)};
  const c=new Controller(store,{captureArtifact:async()=> 'snapshot:test'});
  const root={id:'outer'},live=new Map([[root.id,root]]);
  const ctx={agents:{get:id=>live.get(id),roots:()=>[...live.values()]},userQuestions:{ask}};
  const control=new UserControl(c,ctx,options);control.bindRoot(root);
  return {c,root,live,control,state:()=>state};
}
const yes=request=>({answers:[{id:request.questions[0].id,selected:['确认执行']}]});

test('live outer archive and restore require exact native human answers and preserve ended state',async()=>{
  let shown;const f=fixture(async q=>{shown=q;return yes(q);},{canStart:()=>false});
  await f.c.userCommand(setup);await f.c.userCommand({type:'cancel',project:'p'});
  assert.equal((await f.control.request(f.root,{type:'archive',project:'p'})).applied,true);
  const p=f.state().projects.p;assert.equal(p.archived,true);assert.equal(p.status,'cancelled');
  assert.match(shown.questions[0].detail,/项目ID：p/);assert.match(shown.questions[0].detail,/全部保留/);
  assert.equal(p.audit.at(-1).command.userApproval.questionId,shown.questions[0].id);
  assert.equal((await f.control.request(f.root,{type:'unarchive',project:'p'})).applied,true);
  assert.equal(f.state().projects.p.archived,false);assert.equal(f.state().projects.p.status,'cancelled');assert.match(shown.questions[0].detail,/不重新启动任务/);
  await assert.rejects(f.control.request(f.root,{type:'archive',project:'p',deleteFiles:true}),/unexpected fields/);
});

test('declined and concurrent archive confirmations cannot hide or restore stale project state',async()=>{
  const declined=fixture(async q=>({answers:[{id:q.questions[0].id,selected:['返回调整']}]}));
  await declined.c.userCommand(setup);await declined.c.userCommand({type:'cancel',project:'p'});
  assert.equal((await declined.control.request(declined.root,{type:'archive',project:'p'})).applied,false);assert.notEqual(declined.state().projects.p.archived,true);
  let answer,shown;const f=fixture(q=>{shown=q;return new Promise(resolve=>answer=resolve);});
  await f.c.userCommand(setup);await f.c.userCommand({type:'cancel',project:'p'});
  const pending=f.control.request(f.root,{type:'archive',project:'p'});
  while(!answer)await new Promise(resolve=>setImmediate(resolve));
  await f.c.userCommand({type:'archive',project:'p'});await f.c.userCommand({type:'unarchive',project:'p'});
  answer(yes(shown));await assert.rejects(pending,/changed while awaiting/);assert.equal(f.state().projects.p.archived,false);
});

test('project execution roles and forged outer identities cannot request archive confirmation',async()=>{
  for(const role of ['coordinator','executor','reviewer']) {
    let asks=0;const f=fixture(async q=>{asks++;return yes(q);});await f.c.userCommand(setup);
    f.c.bind(f.root,{role,project:'p',...(role==='reviewer'?{reviewer:'r'}:{})});await f.c.userCommand({type:'cancel',project:'p'});
    await assert.rejects(f.control.request(f.root,{type:'archive',project:'p'}),/cannot act/);
    await assert.rejects(f.control.request({id:f.root.id},{type:'archive',project:'p'}),/bound live/);
    assert.equal(asks,0);assert.notEqual(f.state().projects.p.archived,true);
  }
});

test('record deletion uses native human confirmation, strict fields and no startup gate',async()=>{
  let shown,approve=false,asks=0;const f=fixture(async q=>{shown=q;asks++;return approve?yes(q):{answers:[{id:q.questions[0].id,selected:['返回调整']}]};},{canStart:()=>false});
  await f.c.userCommand(setup);await f.c.userCommand({type:'cancel',project:'p'});
  await assert.rejects(f.control.request(f.root,{type:'delete-project',project:'p'}),/Archive the project/);assert.equal(asks,0);
  await f.c.userCommand({type:'archive',project:'p'});
  for(const extra of [{deleteFiles:true},{source:'dsh-panel-operator'}])await assert.rejects(f.control.request(f.root,{type:'delete-project',project:'p',...extra}),/unexpected fields/);
  assert.equal((await f.control.request(f.root,{type:'delete-project',project:'p'})).applied,false);assert.notEqual(f.state().projects.p.deleted,true);
  for(const text of ['删除记录，文件保留','不再提供恢复入口','外层聊天不会删除','原始日志不会被擦除'])assert(shown.questions[0].detail.includes(text),text);
  approve=true;assert.equal((await f.control.request(f.root,{type:'delete-project',project:'p'})).applied,true);assert.equal(f.state().projects.p.deleted,true);
  assert.equal(f.state().projects.p.audit.at(-1).command.userApproval.source,'dsh-user-questions');
  await assert.rejects(f.control.request(f.root,{type:'unarchive',project:'p'}),/deleted/);assert.equal(asks,2);
});

test('execution identities cannot delete records even when bound as outer roots',async()=>{
  for(const role of ['coordinator','executor','reviewer']) {
    let asks=0;const f=fixture(async q=>{asks++;return yes(q);});await f.c.userCommand(setup);await f.c.userCommand({type:'cancel',project:'p'});await f.c.userCommand({type:'archive',project:'p'});
    f.c.bind(f.root,{role,project:'p',...(role==='reviewer'?{reviewer:'r'}:{})});await assert.rejects(f.control.request(f.root,{type:'delete-project',project:'p'}),/cannot act/);assert.equal(asks,0);assert.notEqual(f.state().projects.p.deleted,true);
  }
});

test('approved setup records the exact reviewed configuration and human question reference',async()=>{
  let shown;const f=fixture(async request=>{shown=request;return yes(request);});
  assert.equal((await f.control.request(f.root,setup)).applied,true);
  const p=f.state().projects.p;assert.equal(p.reviewers[0].criteria,setup.reviewers[0].criteria);
  assert.match(shown.questions[0].detail,/每完成 3 个任务/);
  assert.equal(p.audit[0].command.userApproval.questionId,shown.questions[0].id);
});

test('decline, custom edits, wrong IDs and ambiguous answers do not create a project',async()=>{
  for(const response of [q=>({id:q.id,selected:['返回调整']}),q=>({id:q.id,selected:['确认执行'],custom:'先把巡查改成5个任务'}),()=>({id:'wrong',selected:['确认执行']}),q=>({id:q.id,selected:['确认执行','返回调整']})]) {
    const f=fixture(async request=>({answers:[response(request.questions[0])]}));
    assert.equal((await f.control.request(f.root,setup)).applied,false);assert.equal(f.state().revision,0);
  }
});

test('native question cancellation declines only while the outer agent remains live',async()=>{
  const cancelled=Object.assign(new Error('the user cancelled ask_user_question'),{code:'ASK_CANCELLED'});
  const f=fixture(async()=>{throw cancelled;});
  assert.equal((await f.control.request(f.root,setup)).applied,false);
  assert.equal(f.state().revision,0);
  const other=fixture(async()=>{throw Object.assign(new Error('provider failed'),{code:'ASK_FAILED'});});
  await assert.rejects(other.control.request(other.root,setup),/provider failed/);
  assert.equal(other.state().revision,0);
  let rejectQuestion;const late=fixture(()=>new Promise((_,reject)=>{rejectQuestion=reject;}));
  const pending=late.control.request(late.root,setup);
  while(!rejectQuestion)await new Promise(r=>setImmediate(r));
  late.control.close();rejectQuestion(cancelled);
  await assert.rejects(pending,/closed/);
  assert.equal(late.state().revision,0);
});

test('default gate, forged identity and bound execution roots cannot request confirmation',async()=>{
  let calls=0;const f=fixture(async q=>{calls++;return yes(q);},{});
  await assert.rejects(f.control.request(f.root,setup),/not enabled/);
  await assert.rejects(f.control.request({id:f.root.id},setup),/bound live/);
  await f.c.userCommand(setup);f.c.bind(f.root,{role:'coordinator',project:'p'});
  await assert.rejects(f.control.request(f.root,{type:'cancel',project:'p'}),/cannot act/);
  assert.equal(calls,0);
});

test('mutating a model proposal while the human is reading cannot alter what gets approved',async()=>{
  let answer,shown;const f=fixture(q=>{shown=q;return new Promise(r=>answer=r);});
  const raw=structuredClone(setup),pending=f.control.request(f.root,raw);
  while(!answer)await new Promise(r=>setImmediate(r));
  raw.reviewers[0].criteria='Always approve';raw.objective='Different objective';
  await assert.rejects(f.control.request(f.root,setup),/already pending/);
  answer(yes(shown));await pending;
  assert.equal(f.state().projects.p.objective,setup.objective);
  assert.equal(f.state().projects.p.reviewers[0].criteria,setup.reviewers[0].criteria);
});

test('configuration changed during human review requires a fresh confirmation',async()=>{
  let answer,shown;const f=fixture(q=>{shown=q;return new Promise(r=>answer=r);});await f.c.userCommand(setup);
  const pending=f.control.request(f.root,{type:'configure',project:'p',objective:'Proposed objective'});
  while(!answer)await new Promise(r=>setImmediate(r));
  await f.c.userCommand({type:'configure',project:'p',objective:'Intervening change'});
  answer(yes(shown));await assert.rejects(pending,/changed while awaiting/);
  assert.equal(f.state().projects.p.objective,'Intervening change');
});

test('aborted or no-longer-live outer agent cannot commit a returned approval',async()=>{
  for(const mode of ['abort','dispose']) {
    let answer,shown;const f=fixture(q=>{shown=q;return new Promise(r=>answer=r);}),abort=new AbortController();
    const pending=f.control.request(f.root,setup,abort.signal);
    while(!answer)await new Promise(r=>setImmediate(r));
    if(mode==='abort')abort.abort();else f.live.clear();
    answer(yes(shown));await assert.rejects(pending);assert.equal(f.state().revision,0);
  }
});

test('approval queued behind workspace validation is re-authorized at the commit boundary',async()=>{
  for(const mode of ['abort','revoke','gate','relocate']) {
    let state=initialState(),validation=0,release,enter,enabled=true;
    const waiting=new Promise(r=>enter=r),abort=new AbortController();
    const controller=new Controller({snapshot:()=>structuredClone(state),dispatch:async(a,c)=>state=transition(state,a,c)},
      {captureArtifact:async()=>'',validateWorkspace:async workspace=>{if(++validation===2){enter();await new Promise(r=>release=r);}return mode==='relocate'&&validation===2?'D:/different':workspace;}});
    const root={id:'root'},control=new UserControl(controller,{agents:{get:()=>root,roots:()=>[root]},userQuestions:{ask:async q=>yes(q)}},{canStart:()=>enabled});
    const revoke=control.bindRoot(root),pending=control.request(root,setup,abort.signal);
    await waiting;
    if(mode==='abort')abort.abort();if(mode==='revoke')revoke();if(mode==='gate')enabled=false;
    release();await assert.rejects(pending);assert.equal(state.revision,0);
  }
});

test('closing control cancels an uncooperative provider and rejects late approval', {timeout:2000},async()=>{
  let answer,shown;const f=fixture(q=>{shown=q;return new Promise(r=>answer=r);});
  const pending=f.control.request(f.root,setup);
  while(!answer)await new Promise(r=>setImmediate(r));
  f.control.close();f.control.close();
  await assert.rejects(pending,/closed/);assert.equal(shown.signal.aborted,true);
  answer(yes(shown));await new Promise(r=>setImmediate(r));assert.equal(f.state().revision,0);
  assert.throws(()=>f.control.bindRoot({id:'replacement'}),/closed/);
  await assert.rejects(f.control.request(f.root,setup),/closed/);
});

test('revoking one outer scope cancels only its question, old disposer cannot revoke a new binding',{timeout:2000},async()=>{
  let shown,answer;const f=fixture(q=>{shown=q;return new Promise(r=>answer=r);});
  const second={id:'second'};f.live.set(second.id,second);
  const revoke=f.control.bindRoot(second),pending=f.control.request(second,setup);
  while(!answer)await new Promise(r=>setImmediate(r));
  revoke();await assert.rejects(pending,/disposed/);assert.equal(shown.signal.aborted,true);
  f.control.authorizeRoot(f.root);
  const newRevoke=f.control.bindRoot(second);revoke();f.control.authorizeRoot(second);
  newRevoke();assert.throws(()=>f.control.authorizeRoot(second),/bound live/);
  answer(yes(shown));assert.equal(f.state().revision,0);
});
