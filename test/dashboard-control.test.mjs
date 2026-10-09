import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardHandler,dashboardSnapshot} from '../src/dashboard.mjs';
import {initialState,transition} from '../src/core.mjs';

test('project pause/resume/cancel RPCs require the exact live operator and control version only',async()=>{
  let active=true,calls=[];
  const operator={ctx:{fiber:{assertActive(){assert(active,'disposed');}}}};
  const actions=Object.fromEntries(['pause','resume','cancel'].map(type=>[type,async(payload,signal,peer)=>{
    assert.equal(peer,operator);assert.equal(signal,abort.signal);calls.push({type,...payload});
  }]));
  const abort=new AbortController(),handler=dashboardHandler(()=>({revision:calls.length}),undefined,{operator,...actions});
  for(const type of Object.keys(actions)) {
    for(const peer of [undefined,{ctx:operator.ctx}])assert.equal((await handler(type,{project:'p',controlVersion:2},abort.signal,peer)).error.code,'forbidden');
    for(const payload of [{project:'p',archiveVersion:2},{project:'p',controlVersion:2,command:'deliver'},{project:'p',controlVersion:-1},{project:'p',controlVersion:2.5},{project:'p'}])
      assert.equal((await handler(type,payload,abort.signal,operator)).error.code,'bad-request');
    assert.equal((await handler(type,{project:'p',controlVersion:2},abort.signal,operator)).ok,true);
    assert.deepEqual(calls.at(-1),{type,project:'p',controlVersion:2});
  }
  assert.equal(calls.length,3);active=false;
  assert.equal((await handler('cancel',{project:'p',controlVersion:2},abort.signal,operator)).error.code,'forbidden');
  active=true;abort.abort();assert.equal((await handler('pause',{project:'p',controlVersion:2},abort.signal,operator)).error.code,'cancelled');
  assert.equal(calls.length,3);
});

test('activity snapshots refresh independently of committed project revision and stay detached',()=>{
  const s=transition(initialState(),{role:'user'},{type:'create',id:'p',objective:'Work',workspace:'D:/fixture',reviewers:[{id:'r',name:'Review',responsibility:'Quality',criteria:'Works'}]});
  const activity={p:{phase:'work',completedTasks:0,totalTasks:1,activeAgents:[],timeline:[{at:'2026-10-08T00:00:00.000Z',title:'模型开始响应'}]}};
  const first=dashboardSnapshot(s,{},activity);activity.p.timeline.unshift({at:'2026-10-08T00:01:00.000Z',title:'写入已完成'});
  const second=dashboardSnapshot(s,{},activity);assert.equal(first.revision,second.revision);
  assert.equal(first.projects[0].progress.timeline.length,1);assert.equal(second.projects[0].progress.timeline.length,2);
  second.projects[0].progress.timeline[0].title='changed';assert.equal(activity.p.timeline[0].title,'写入已完成');
  assert.equal(second.projects[0].controlVersion,0);assert.equal(second.projects[0].paused,false);
});
