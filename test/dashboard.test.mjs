import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {initialState,transition} from '../src/core.mjs';
import {dashboardSnapshot,dashboardHandler,alertSnapshot} from '../src/dashboard.mjs';
import {readinessSnapshot} from '../src/readiness.mjs';

const requireDsh=createRequire(path.join(process.env.DSH_TEST_INSTALL??'C:/example/dsh/node/node_modules/@deepseek-ai/dsh','package.json'));
const requireLocal=createRequire(new URL('../package.json',import.meta.url));
const requireClient=name=>name==='react'||name.startsWith('react-dom/')?requireLocal(name):requireDsh(name);
const React=requireLocal('react'),{renderToStaticMarkup}=requireLocal('react-dom/server');
test('client module discovery can resolve the package manifest through the public export',()=>{
  const local=createRequire(new URL('../package.json',import.meta.url));
  const manifest=local('dsh-foreman-next/package.json');assert.equal(manifest.dsh.client.platform,'web');assert.equal(manifest.exports['./client'],'./client/index.js');
});
async function client(){let api;vm.runInNewContext(await fs.readFile(new URL('../client/index.js',import.meta.url),'utf8'),{AbortController,setTimeout,clearTimeout,window:{__ModuleLoader__:{load:module=>{assert.equal(module.id,'dsh-foreman-next');api=module.factory(requireClient);}}}});return api;}
function state(){
  let s=transition(initialState(),{role:'user'},{type:'create',id:'p',objective:'示例项目 <img src=x onerror=alert(1)>',workspace:'D:/example',reviewers:[{id:'r',name:'质量',responsibility:'功能完整',criteria:'通过行为测试'}]});
  s=transition(s,{role:'coordinator',project:'p'},{type:'propose',project:'p',definition:{id:'a',title:'基础功能',criteria:'符合要求',deps:[]}});
  s.projects.p.audit.push({secret:'PRIVATE_AUDIT'});s.runtimeAgents={secret:'PRIVATE_SESSION'};s.outbox={secret:'PRIVATE_MESSAGE'};
  s.dependencyBuilds={b:{id:'context-test',project:'p',status:'uncertain',fingerprint:'a'.repeat(64),configVersion:1,confirmation:'PRIVATE_CONFIRMATION',context:'PRIVATE_PATH'}};
  s.projects.p.notifications.push({id:'n',kind:'decision',message:'等待裁决',acknowledged:false});
  return s;
}
test('dashboard projection is detached and excludes storage, sessions and command audit',()=>{
  const s=state(),data=dashboardSnapshot(s,{readyForProjects:false});
  assert.equal(data.projects[0].rounds[0].reviewers[0].vote,null);
  assert.equal(data.projects[0].notifications[0].message,'等待裁决');
  assert(!JSON.stringify(data).includes('PRIVATE_'));
  data.projects[0].reviewers[0].criteria='Bypass';assert.equal(s.projects.p.reviewers[0].criteria,'通过行为测试');
});
test('dashboard RPC cannot accept mutations and checks request cancellation',async()=>{
  let reads=0;const handler=dashboardHandler(()=>{reads++;return {revision:12};});
  for(const [endpoint,payload] of [['create',{}],['snapshot',{type:'deliver'}],['snapshot',null],['snapshot',[]]])assert.equal((await handler(endpoint,payload)).ok,false);
  const abort=new AbortController();abort.abort();assert.equal((await handler('snapshot',{},abort.signal)).error.code,'cancelled');
  assert.equal(reads,0);assert.deepEqual(await handler('snapshot',{}),{ok:true,value:{revision:12}});
});
test('actual React renders status, decisions, reviewer criteria and escapes project content',async()=>{
  const api=await client();
  const html=renderToStaticMarkup(React.createElement(api.ForemanView,{data:dashboardSnapshot(state(),{readyForProjects:false}),selected:'p'}));
  for(const text of ['尚未启用接项目','等待裁决','基础功能','质量','通过行为测试','尚无结论','结果不明，等待核对','context-test'])assert(html.includes(text),text);
  assert(!html.includes('<img'));assert(html.includes('&lt;img'));
  const empty=renderToStaticMarkup(React.createElement(api.ForemanView,{data:dashboardSnapshot(initialState(),{readyForProjects:false})}));
  assert(empty.includes('还没有项目'));
});
test('client registers the rc.2 main panel and sidebar entry with narrow authenticated project-card actions',async()=>{
  const api=await client();let request;const entries=[];
  api.apply({slots:{inject:(name,fn)=>{assert(['main','sidebar.panellist','shell.overlay'].includes(name));fn();},register:(e,c)=>{entries.push([e,c]);}},
    connection:{rpc:{call:async(...args)=>{request=args;return {ok:true,value:{revision:9}};}}}});
  const [entry,component]=entries[0];assert.equal(entries.length,3);
  assert.equal(entry.name,'main');assert.equal(entry.key,'foreman-next');assert.equal(component,api.ForemanPanel);
  assert(renderToStaticMarkup(React.createElement(component,{load:entry.inject().load})).includes('新工头模式'));
  const signal=new AbortController().signal;assert.equal((await entry.inject().load(signal)).revision,9);
  assert.equal(request[0],'/foreman-next');assert.equal(request[1],'snapshot');assert.equal(Object.keys(request[2]).length,0);assert.equal(request[3],signal);
  assert.equal(entries[1][0].name,'sidebar.panellist');assert.equal(entries[1][0].id,'foreman-next');assert.equal(entries[1][1],api.ForemanPanelIcon);
  assert.equal(entries[2][0].name,'shell.overlay');assert.equal(entries[2][1],api.ForemanAlerts);
  await entries[2][0].inject().load(signal);assert.equal(request[1],'alerts');assert.equal(Object.keys(request[2]).length,0);
  await entry.inject().manage({endpoint:'archive',project:'p',archiveVersion:0},signal);
  assert.equal(request[1],'archive');assert.deepEqual(Object.keys(request[2]).sort(),['archiveVersion','project']);assert.equal(request[2].project,'p');assert.equal(request[3],signal);
  await assert.rejects(entry.inject().manage({endpoint:'deliver',project:'p',archiveVersion:0},signal),/Unsupported/);
});

test('archived projects leave the default list and major alerts but retain their detached review history',()=>{
  const s=state();s.projects.p.archived=true;s.projects.p.archiveVersion=2;s.projects.p.archivedAt='2026-10-08T00:00:00.000Z';
  const data=dashboardSnapshot(s,{readyForProjects:true});assert.equal(data.projects.length,0);assert.equal(data.archivedProjects.length,1);
  assert.equal(data.archivedProjects[0].archiveVersion,2);assert.equal(data.archivedProjects[0].rounds.length,1);assert.equal(data.archivedProjects[0].archivedAt,s.projects.p.archivedAt);
  assert.equal(alertSnapshot(s).alerts.length,0);assert(!JSON.stringify(data).includes('PRIVATE_'));
  data.archivedProjects[0].reviewers[0].criteria='changed';assert.equal(s.projects.p.reviewers[0].criteria,'通过行为测试');
  assert.equal(dashboardSnapshot(state(),{}).projects[0].archiveVersion,0);
});

test('project-card RPC accepts only live exact operator and two narrow metadata actions',async()=>{
  let disposed=false,calls=0;
  const operator={ctx:{fiber:{assertActive(){if(disposed)throw Error('Disposed');}}}},signal=new AbortController().signal;
  const handler=dashboardHandler(()=>({revision:calls}),undefined,{operator,archive:async(payload,receivedSignal,peer)=>{
    assert.equal(payload.project,'p');assert.equal(payload.archiveVersion,0);assert.equal(receivedSignal,signal);assert.equal(peer,operator);calls++;
  },unarchive:async()=>{calls++;}});
  assert.equal((await handler('archive',{project:'p',archiveVersion:0},signal)).error.code,'forbidden');
  assert.equal((await handler('archive',{project:'p',archiveVersion:0},signal,{ctx:operator.ctx})).error.code,'forbidden');
  assert.equal((await dashboardHandler(()=>({}),undefined,{archive:async()=>calls++})('archive',{project:'p',archiveVersion:0},signal,operator)).error.code,'forbidden');
  for(const payload of [{project:'p',archiveVersion:0,command:'deliver'},{project:'p',archiveVersion:-1},{project:'p'},{project:'p',archiveVersion:0,agent:'outer'}])assert.equal((await handler('archive',payload,signal,operator)).error.code,'bad-request');
  assert.equal(calls,0);assert.deepEqual(await handler('archive',{project:'p',archiveVersion:0},signal,operator),{ok:true,value:{revision:1}});
  assert.deepEqual(await handler('unarchive',{project:'p',archiveVersion:1},signal,operator),{ok:true,value:{revision:2}});
  disposed=true;assert.equal((await handler('archive',{project:'p',archiveVersion:0},signal,operator)).error.code,'forbidden');assert.equal(calls,2);
  assert.equal((await dashboardHandler(()=>({}))('archive',{project:'p',archiveVersion:0},signal,operator)).error.code,'bad-request');
});

test('operator disposal during an action and callback rejection cannot report successful card management',async()=>{
  let disposed=false;
  const operator={ctx:{fiber:{assertActive(){if(disposed)throw Error('Disposed');}}}};
  const handler=dashboardHandler(()=>({}),undefined,{operator,archive:async()=>{disposed=true;}});
  assert.equal((await handler('archive',{project:'p',archiveVersion:0},undefined,operator)).error.code,'forbidden');
  disposed=false;
  const failure=dashboardHandler(()=>({}),undefined,{operator,archive:async()=>{throw Error('Displayed archive version changed');}});
  assert.match((await failure('archive',{project:'p',archiveVersion:0},undefined,operator)).error.message,/version changed/);
});

test('actual 0.2 OperatorPeer scope authorizes the narrow callback and revokes after disposal',async()=>{
  const actualRequire=createRequire('C:/example/dsh-runtime/package.json');
  const {Context}=await import(pathToFileURL(actualRequire.resolve('@deepseek-ai/cordis')).href);
  const {OperatorPeer}=await import(pathToFileURL(actualRequire.resolve('@deepseek-ai/dsh-client-connection')).href);
  const peer=new OperatorPeer(new Context());let calls=0;
  const handler=dashboardHandler(()=>({revision:calls}),undefined,{operator:peer,archive:async()=>{calls++;}});
  try {assert.equal((await handler('archive',{project:'p',archiveVersion:0},undefined,peer)).ok,true);assert.equal(calls,1);}
  finally {await peer.dispose();}
  assert.equal((await handler('archive',{project:'p',archiveVersion:0},undefined,peer)).error.code,'forbidden');assert.equal(calls,1);
});

test('actual React shows archive only for ended projects and a recoverable archive view with explicit confirmation',async()=>{
  const api=await client(),s=state(),render=props=>renderToStaticMarkup(React.createElement(api.ForemanView,{onRequestAction:()=>{},...props}));
  assert(!render({data:dashboardSnapshot(s,{readyForProjects:true})}).includes('从列表归档'));
  s.projects.p.status='cancelled';
  const data=dashboardSnapshot(s,{readyForProjects:true});
  const ended=render({data,pendingAction:{endpoint:'archive',project:'p',archiveVersion:0}});
  for(const text of ['从列表归档','确认归档','保留项目文件、日志和审查记录'])assert(ended.includes(text),text);
  s.projects.p.archived=true;s.projects.p.archiveVersion=1;
  const archived=render({data:dashboardSnapshot(s,{readyForProjects:true}),showArchived:true,pendingAction:{endpoint:'unarchive',project:'p',archiveVersion:1}});
  for(const text of ['已归档（1）','恢复到项目列表','确认恢复显示','不会重启任务','基础功能','通过行为测试'])assert(archived.includes(text),text);
  const defaultList=render({data:dashboardSnapshot(s,{readyForProjects:true})});assert(!defaultList.includes('基础功能'));assert(defaultList.includes('已归档（1）'));
});

test('settings panel explains missing startup components without claiming configuration proves readiness',async()=>{
  const api=await client(),readiness=readinessSnapshot({application:{}});
  const html=renderToStaticMarkup(React.createElement(api.ForemanView,{data:dashboardSnapshot(initialState(),readiness)}));
  for(const text of ['尚未启用的原因','尚未配置 DSH','尚未明确配置子代理','宿主批准','已接入不代表真实项目验收已通过'])assert(html.includes(text),text);
});

test('global alert projection includes only unresolved major issues and exposes no project internals',async()=>{
  const s=state();s.projects.p.notifications.push(
    {id:'record',kind:'record',message:'Routine progress'},
    {id:'done',kind:'fault',message:'Resolved',resolved:true},
    {id:'seen',kind:'decision',message:'Acknowledged',acknowledged:true},
    {id:'final',kind:'delivery',message:'Ready for delivery'});
  const data=alertSnapshot(s);assert.deepEqual(data.alerts.map(a=>a.id),['n','final']);
  assert(!JSON.stringify(data).includes('PRIVATE_'));assert(!JSON.stringify(data).includes('D:/example'));
  data.alerts[0].message='Altered';assert.equal(s.projects.p.notifications[0].message,'等待裁决');
  const handler=dashboardHandler(()=>{throw new Error('Must use compact route');},()=>alertSnapshot(s));
  assert.equal((await handler('alerts',{})).value.alerts.length,2);
  assert.equal((await handler('alerts',{acknowledge:'n'})).ok,false);
  const api=await client(),html=renderToStaticMarkup(React.createElement(api.AlertView,{alerts:alertSnapshot(s).alerts,stale:true}));
  assert(html.includes('暂时收起'));assert(html.includes('连接暂时不可用'));assert(!html.includes('<img'));
});

test('installed DSH SlotCore accepts overlay beside existing entries and removes it on disposal',async()=>{
  const {SlotCore}=await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-client-ui-slots')).href);
  const core=new SlotCore(),disposers=[];
  const root=core.register({name:'root',children:{'shell.overlay':{kind:'list',scope:'root'},'main':{kind:'keyed',scope:'root'},'sidebar.panellist':{kind:'list',scope:'root'}}},()=>null);
  const existing=core.register({name:'shell.overlay',id:'shipped-feature'},()=>null);
  const api=await client();api.apply({slots:{inject:(_name,fn)=>fn(),register:(entry,component)=>{const d=core.register(entry,component);disposers.push(d);return d;}},connection:{rpc:{}}});
  assert.equal(core.entriesOfSlot('shell.overlay').length,2);
  assert.equal(core.entriesOfSlot('main')[0].options.key,'foreman-next');
  assert.equal(core.entriesOfSlot('sidebar.panellist')[0].options.id,'foreman-next');
  for(const dispose of disposers)dispose();
  assert.equal(core.entriesOfSlot('shell.overlay').length,1);existing();root();
});

test('alert feed is serial, dismissal does not mutate host state, changed or recurring incidents resurface',async()=>{
  const {createAlertFeed}=await client();let next,delay,view,calls=0;
  const item={project:'p',id:'n',kind:'decision',objective:'Project',message:'Need decision'};
  let alerts=[item];const feed=createAlertFeed(async()=>{calls++;return {alerts};},{schedule:(fn,ms)=>{next=fn;delay=ms;return 1;},cancel:()=>{next=null;}});
  feed.start(v=>view=v);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);assert.equal(delay,5000);assert.equal(view.alerts.length,1);
  feed.dismiss();assert.equal(view.alerts.length,0);assert.equal(alerts.length,1);
  await next();assert.equal(view.alerts.length,0);
  alerts=[{...item,message:'Changed requirement'}];await next();assert.equal(view.alerts.length,1);
  feed.dismiss();alerts=[];await next();alerts=[item];await next();assert.equal(view.alerts.length,1);
  feed.close();assert.equal(next,null);
});

test('alert feed backs off on failure and ignores a late response after unmount',async()=>{
  const {createAlertFeed}=await client();let next,delay,resolve,signal,emits=0,fail=true;
  const feed=createAlertFeed(s=>{signal=s;if(fail)return Promise.reject(new Error('Offline'));return new Promise(r=>{resolve=r;});},
    {schedule:(fn,ms)=>{next=fn;delay=ms;return 1;},cancel:()=>{next=null;}});
  feed.start(()=>emits++);await new Promise(r=>setImmediate(r));assert.equal(delay,10000);
  await next();assert.equal(delay,20000);fail=false;
  const pending=next();feed.close();assert.equal(signal.aborted,true);const previous=emits;
  resolve({alerts:[]});await pending;assert.equal(emits,previous);assert.equal(next,null);
});
