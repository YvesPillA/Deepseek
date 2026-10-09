import test from 'node:test';
import assert from 'node:assert/strict';
import {ProjectProgress} from '../src/project-progress.mjs';

function fixture() {
  const p={id:'p',status:'running',configVersion:1,controlVersion:0,reviewers:[{id:'visual',name:'视觉监督'}],
    milestones:{m:{id:'m',title:'单文件交付',status:'work',planVersion:1,deps:[]}},
    tasks:{t:{id:'t',title:'制作SVG',milestone:'m',status:'running',planVersion:1,configVersion:1,attempt:1}},rounds:{},audit:[]};
  const state={revision:1,projects:{p},runtimeAgents:{exec:{sessionId:'private-session',binding:{project:'p',role:'executor',configVersion:1,planVersion:1,task:'t',taskAttempt:1}}},verificationRuns:{}};
  const session={id:'private-session',seq:0,snapshotEvents(){throw Error('Deprecated reader prohibited');}};
  const agent={id:session.id,status:'running',session},agents=new Map([[session.id,agent]]),sessions=new Map([[session.id,session]]);
  let observer;
  const ctx={agents,sessions,on(name,fn){assert.equal(name,'session/event');observer=fn;return ()=>{observer=null;};}};
  const progress=new ProjectProgress(ctx,()=>state);
  const at=Date.parse('2026-10-08T14:00:00Z');
  const emit=(type,data={},advance=1000)=>{const event={seq:session.seq++,time:at+session.seq*advance,type,data};observer?.(session,event);return event;};
  const call=(name,args={},callId='call')=>emit('tool/call',{name,arguments:JSON.stringify(args),callId});
  const result=(callId='call',content={},isError=false,error)=>emit('tool/result',{message:{toolCallId:callId,isError,content:[{type:'text',text:JSON.stringify(content)}]},error});
  const view=()=>progress.snapshot(state).p;
  return {p,state,session,agent,agents,sessions,ctx,progress,emit,call,result,view,get observer(){return observer;}};
}

test('core phases distinguish planning approval, execution, acceptance and drained pause',async()=>{
  const f=fixture();try {
    f.p.rounds.plan={id:'plan',kind:'plan',status:'closed',outcome:'passed',votes:{visual:{pass:true}}};
    assert.equal(f.view().phase,'work');assert.equal(f.view().completedTasks,0);assert.equal(f.view().totalTasks,1);
    f.p.tasks.t.status='completed';f.p.milestones.m.status='review';f.p.rounds.acceptance={id:'a',kind:'acceptance',status:'open',votes:{}};
    assert.equal(f.view().phase,'review');assert.equal(f.view().completedTasks,1);
    f.p.paused=true;f.p.pauseStatus='requested';f.p.controlVersion=1;
    assert.equal(f.view().phase,'pausing');assert.equal(f.view().activeAgents[0].status,'停止中');
    f.p.pauseStatus='drained';assert.equal(f.view().phase,'paused');assert.deepEqual(f.view().activeAgents,[]);
    f.p.paused=false;f.p.status='cancelled';assert.equal(f.view().phase,'cancelling');assert.equal(f.view().activeAgents[0].status,'停止中');
    f.agents.clear();assert.deepEqual(f.view().activeAgents,[]);
    assert.equal(f.view().phase,'cancelling');f.p.controlDrainVersion=1;assert.equal(f.view().phase,'cancelled');
    f.p.status='delivered';assert.equal(f.view().phase,'delivered');
    f.p.status='approved';assert.equal(f.view().phase,'approved');
    f.p.status='running';f.p.rounds={};f.p.tasks={};f.p.milestones={};assert.equal(f.view().phase,'planning');
    f.p.milestones.m={status:'passed'};assert.equal(f.view().phase,'idle');
    f.p.milestones.m.status='paused';assert.equal(f.view().phase,'decision');
    f.p.deleted=true;assert.deepEqual(Object.keys(f.progress.snapshot(f.state)),[]);
  } finally {await f.progress.close();}
});

test('live events change progress without journal commits and calls never prove a successful write',async()=>{
  const f=fixture();try {
    f.emit('step/start',{turn:1,step:1});assert.equal(f.view().activeAgents[0].status,'等待模型响应');
    f.call('foreman_files',{action:'write',path:'sample-artwork.svg',text:'PRIVATE_SOURCE_SECRET'});
    assert.equal(f.view().latestAction.status,'running');assert.match(f.view().latestAction.action,/写入文件：sample-artwork.svg/);
    f.result('call',{hash:'private-hash',text:'PRIVATE_CONTENT_SECRET'});
    assert.equal(f.view().latestAction.status,'success');assert.equal(f.state.revision,1);
    f.call('foreman_files',{action:'delete',path:'sample-artwork.svg'},'delete');f.result('delete',{},true,{message:'PRIVATE_ERROR_SECRET'});
    assert.equal(f.view().latestAction.status,'failed');
    f.call('foreman_files',{action:'write',path:'other.svg'},'unknown');f.result('unknown',{},true,{code:'TOOL_OUTCOME_UNKNOWN',message:'PRIVATE_ERROR_SECRET'});
    assert.equal(f.view().latestAction.status,'unknown');
    const projected=f.view(),json=JSON.stringify(projected);
    assert(!json.includes('PRIVATE'));assert(!json.includes('private-session'));assert(!json.includes('private-hash'));
    assert(!Object.hasOwn(projected,'percent'));
    projected.timeline[0].title='changed';assert.notEqual(f.view().timeline[0].title,'changed');
    f.emit('turn/end',{reason:{kind:'completed'}});f.agent.status='idle';assert.equal(f.view().activeAgents[0].status,'等待任务或审查结果');
  } finally {await f.progress.close();}
});

test('safe summaries reject foreign live identities, stale bindings and private or unsafe paths',async()=>{
  const f=fixture();try {
    f.call('foreman_files',{action:'read',path:'D:/private/secret.txt'});f.result();
    assert.equal(f.view().latestAction.action,'读取文件');
    for(const path of ['../secret','a\\secret','/absolute','a:stream','a//b']) {
      f.call('foreman_files',{action:'read',path});f.result();assert.equal(f.view().latestAction.action,'读取文件');
    }
    const before=f.view().lastActivityAt;
    f.observer({...f.session},{seq:900,time:Date.now(),type:'tool/call',data:{name:'foreman_verify',callId:'foreign'}});
    assert.equal(f.view().lastActivityAt,before);
    f.p.tasks.t.attempt=2;f.call('foreman_files',{action:'write',path:'stale.svg'});
    assert.equal(f.view().latestAction,null);assert.deepEqual(f.view().activeAgents,[]);
    f.p.tasks.t.attempt=1;f.p.controlVersion=1;f.call('foreman_verify');assert.deepEqual(f.view().activeAgents,[]);
    f.p.controlVersion=0;f.p.configVersion=2;f.call('foreman_verify');assert.equal(f.view().latestAction,null);
    f.p.configVersion=1;f.state.runtimeAgents.duplicate={...f.state.runtimeAgents.exec};
    assert.deepEqual(f.view().activeAgents,[]);
  } finally {await f.progress.close();}
});

test('verification cleanup is distinct from an exit result and a new pending call wins over old runs',async()=>{
  const f=fixture();try {
    f.state.verificationRuns.run={name:'run',project:'p',status:'removed',backend:'native',request:{command:'node',args:['PRIVATE_SCRIPT']}};
    assert.equal(f.view().latestVerification.status,'unknown');
    f.state.verificationRuns.run.result={exitCode:0,truncated:false,oomKilled:false,stdout:'PRIVATE_STDOUT',stderr:'PRIVATE_STDERR'};
    assert.equal(f.view().latestVerification.status,'success');assert.match(f.view().latestVerification.summary,/仍需监督验收/);
    f.call('foreman_verify',{command:'node',args:['PRIVATE_SCRIPT']});
    assert.equal(f.view().latestVerification.status,'running');
    f.result('call',{verification:'new-run',exitCode:1,truncated:false,stdout:'PRIVATE_STDOUT'});
    assert.equal(f.view().latestVerification.status,'failed');assert.equal(f.view().latestVerification.exitCode,1);
    f.state.verificationRuns['new-run']={name:'new-run',project:'p',status:'removed',result:{exitCode:0,truncated:true}};
    assert.equal(f.view().latestVerification.status,'failed');assert.match(f.view().latestVerification.summary,/截断/);
    f.call('foreman_verify',{},'third');assert.equal(f.view().latestVerification.status,'running');
    assert(!JSON.stringify(f.view()).includes('PRIVATE'));
  } finally {await f.progress.close();}
});

test('async official observations seed one bounded live tail, are disposed, and keep completed activity',async()=>{
  const f=fixture();let reads=0,disposals=0;
  try {
    const rows=[];for(let i=0;i<300;i++)rows.push({seq:i,time:Date.parse('2026-10-08T13:00:00Z')+i,type:'step/start',data:{turn:1,step:i}});
    rows.push({seq:300,time:Date.parse('2026-10-08T13:01:00Z'),type:'tool/call',data:{name:'foreman_files',callId:'seed',arguments:JSON.stringify({action:'write',path:'seed.svg',text:'PRIVATE_SOURCE'})}});
    rows.push({seq:301,time:Date.parse('2026-10-08T13:01:01Z'),type:'tool/result',data:{message:{toolCallId:'seed',isError:false,content:[]}}});
    f.ctx.sessionQuery={async observeSession(id,options){reads++;assert.equal(id,f.session.id);assert.equal(options.projectionMode,'none');return {source:'live',header:{id},events:rows,[Symbol.dispose](){disposals++;}};}};
    f.view();await f.progress.flush();assert.equal(reads,1);assert.equal(disposals,1);
    assert.equal(f.view().latestAction.status,'success');assert.match(f.view().latestAction.action,/seed.svg/);
    for(let i=0;i<10;i++)f.view();assert.equal(reads,1);
    f.p.tasks.t.status='completed';f.agents.clear();f.sessions.clear();
    assert.equal(f.view().latestAction.status,'success');assert.deepEqual(f.view().activeAgents,[]);
  } finally {await f.progress.close();}
});

test('late hydration cannot replace new activity, and close aborts and drains seed reads',async()=>{
  const f=fixture();let release,disposed=0;
  try {
    f.ctx.sessionQuery={observeSession:()=>new Promise(r=>release=r)};
    f.view();f.call('foreman_files',{action:'write',path:'current.svg'},'current');f.result('current');
    release({source:'live',header:{id:f.session.id},events:[
      {seq:400,time:Date.parse('2026-10-08T13:00:00Z'),type:'tool/call',data:{name:'foreman_verify',callId:'old',arguments:'{}'}},
      {seq:401,time:Date.parse('2026-10-08T13:00:01Z'),type:'tool/result',data:{message:{toolCallId:'old',content:[{type:'text',text:'{"exitCode":0,"truncated":false}'}]}}},
    ],[Symbol.dispose](){disposed++;}});
    await f.progress.flush();assert.match(f.view().latestAction.action,/current.svg/);assert.equal(disposed,1);
    const waiting=fixture();let releaseWaiting;
    waiting.ctx.sessionQuery={observeSession:()=>new Promise(r=>releaseWaiting=r)};
    waiting.view();waiting.emit('step/start',{turn:2,step:1});
    releaseWaiting({source:'live',header:{id:waiting.session.id},events:[
      {seq:400,time:Date.parse('2026-10-08T13:00:00Z'),type:'tool/call',data:{name:'foreman_verify',callId:'old',arguments:'{}'}},
      {seq:401,time:Date.parse('2026-10-08T13:00:01Z'),type:'tool/result',data:{message:{toolCallId:'old',content:[]}}},
    ],[Symbol.dispose](){}});
    await waiting.progress.flush();assert.equal(waiting.view().activeAgents[0].status,'等待模型响应');await waiting.progress.close();
    const closing=fixture();let aborted=false;
    closing.ctx.sessionQuery={observeSession:(_id,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('PRIVATE_READ_FAILURE'));},{once:true}))};
    closing.view();await closing.progress.close();assert(aborted);assert.equal(closing.observer,null);
  } finally {await f.progress.close();}
});

test('bounded detached timeline uses explicit durable stage semantics and never includes raw audit commands',async()=>{
  const f=fixture();try {
    f.p.rounds.plan={kind:'plan',status:'closed',outcome:'passed',votes:{}};
    f.p.audit.push({id:'private-audit-id',time:'2026-10-08T12:00:00Z',actor:'reviewer',actorId:'PRIVATE_ACTOR',command:{type:'vote',round:'plan',pass:true,findings:'PRIVATE_REASONING'}});
    assert.equal(f.view().timeline[0].title,'规划审查通过');assert.equal(f.view().phase,'work');
    for(let i=0;i<50;i++){f.call('foreman_files',{action:'read',path:`safe-${i}.svg`},'call'+i);f.result('call'+i);}
    const projected=f.view();assert.equal(projected.timeline.length,12);
    assert(projected.timeline.every((item,index)=>index===0||projected.timeline[index-1].at>=item.at));
    assert(!JSON.stringify(projected).includes('PRIVATE'));assert(!JSON.stringify(projected).includes('private-audit-id'));
    f.p.audit=[];f.state.runtimeAgents={};assert.equal(f.view().latestAction,null);
  } finally {await f.progress.close();}
});

test('observation disposal failures are contained and foreign prepared observations never hydrate a live agent',async()=>{
  const f=fixture();try {
    let disposals=0;
    f.ctx.sessionQuery={async observeSession(id){return {source:'prepared',header:{id},get events(){assert.fail('Do not inspect a nonlive source');},[Symbol.dispose](){disposals++;throw Error('PRIVATE_DISPOSE_ERROR');}};}};
    f.view();await f.progress.flush();assert.equal(disposals,1);assert.equal(f.view().latestAction,null);
    assert(!JSON.stringify(f.view()).includes('PRIVATE'));await f.progress.close();
    f.view();assert.equal(disposals,1);
  } finally {await f.progress.close();}
});

test('pause drains record actual tool outcomes and never leave unanswered stopped calls labelled running',async()=>{
  const f=fixture();try {
    f.call('foreman_files',{action:'write',path:'paused.svg'});
    f.p.paused=true;f.p.pauseStatus='requested';f.p.controlVersion=1;
    f.result('call',{},true,{code:'TOOL_OUTCOME_UNKNOWN',message:'PRIVATE_ERROR'});
    assert.equal(f.view().latestAction.status,'unknown');assert.equal(f.view().activeAgents[0].status,'停止中');
    f.p.paused=false;f.p.pauseStatus=undefined;f.p.controlVersion=0;
    f.call('foreman_verify',{},'verify');assert.equal(f.view().latestAction.status,'running');
    f.p.paused=true;f.p.pauseStatus='drained';f.p.controlVersion=1;
    assert.equal(f.view().latestAction.status,'unknown');assert.equal(f.view().latestVerification.status,'unknown');
    assert(!f.view().timeline.some(i=>i.status==='running'));
    f.p.paused=false;f.p.status='cancelled';f.agents.clear();f.sessions.clear();
    assert.equal(f.view().latestAction.status,'unknown');assert.deepEqual(f.view().activeAgents,[]);
    assert(!JSON.stringify(f.view()).includes('PRIVATE'));
  } finally {await f.progress.close();}
});
