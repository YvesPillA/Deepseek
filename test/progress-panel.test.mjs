import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createRequire} from 'node:module';

const requireLocal=createRequire(new URL('../package.json',import.meta.url));
const React=requireLocal('react'),{renderToStaticMarkup}=requireLocal('react-dom/server');
async function client(){let api;vm.runInNewContext(await fs.readFile(new URL('../client/index.js',import.meta.url),'utf8'),{AbortController,setTimeout,clearTimeout,window:{__ModuleLoader__:{load:module=>{api=module.factory(requireLocal);}}}});return api;}
const project=()=>({id:'project-2',objective:'交付 SVG 动画',workspace:'D:/example',status:'running',configVersion:1,controlVersion:3,settings:{patrolEvery:3,denialLimit:3,faultRetries:3},completions:0,nextPatrol:3,notifications:[],reviewers:[],rounds:[{id:'plan',kind:'plan',milestone:'svg',status:'closed',outcome:'passed',reviewers:[]}],milestones:[{id:'svg',title:'SVG 动画',criteria:'成品可播放',status:'work',denials:0,limit:3,blockedBy:[],tasks:[{id:'draw',title:'绘制动画',status:'running',attempt:1}]}]});
const data=p=>({readiness:{readyForProjects:true},projects:[p],archivedProjects:[]});
const render=(api,p,props={})=>renderToStaticMarkup(React.createElement(api.ForemanView,{data:data(p),onRequestAction:()=>{},...props}));

test('progress distinguishes implementation from a passed plan and uses real task counts',async()=>{
  const api=await client(),html=render(api,project());
  for(const text of ['项目执行进度','项目 ID：','project-2','已完成任务 0 / 1','实现中','规划已通过，可开始实现','规划通过不代表成品验收通过','当前没有可确认的活动信息','尚无活动记录','尚无验证记录'])assert(html.includes(text),text);
  assert(!html.includes('可执行'));assert(!html.includes('0%'));
  assert(html.indexOf('项目执行进度')<html.indexOf('项目设置'));
});

test('progress shows bounded public activity, verification and escaped timeline text',async()=>{
  const api=await client(),p=project();p.progress={phase:'work',completedTasks:1,totalTasks:2,lastActivityAt:'2026-10-08T14:53:06.000Z',activeAgents:[{name:'执行者',role:'executor',taskTitle:'绘制动画',status:'running'}],latestAction:{actor:'执行者',action:'写入文件',result:'已写入 animation.svg <script>secret</script>',status:'completed'},latestVerification:{title:'播放检查',status:'failed',exitCode:1,summary:'第 3 帧存在缺口'},timeline:Array.from({length:8},(_,i)=>({id:String(i),at:'2026-10-08T14:53:06.000Z',title:'进展-'+i}))};
  const html=render(api,p);for(const text of ['已完成任务 1 / 2','执行者','绘制动画','写入文件','播放检查','退出码 1','第 3 帧存在缺口','进展-4','2026-10-08T14:53:06.000Z'])assert(html.includes(text),text);
  assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert(!html.includes('进展-5'));
});

test('project control is two step and respects requested vs drained pause and terminal status',async()=>{
  const api=await client(),p=project();let html=render(api,p);assert(html.includes('暂停项目'));assert(html.includes('取消项目'));assert(!html.includes('确认暂停项目'));
  html=render(api,p,{pendingAction:{endpoint:'pause',project:p.id,controlVersion:3}});assert(html.includes('确认暂停项目'));assert(html.includes('请求停止当前执行活动'));assert(html.includes('返回'));
  p.paused=true;p.pauseStatus='requested';html=render(api,p);assert(html.includes('正在暂停，等待执行活动停止'));assert(!html.includes('继续项目'));assert(!html.includes('>暂停项目<'));assert(html.includes('取消项目'));
  p.pauseStatus='drained';html=render(api,p);assert(html.includes('已暂停'));assert(html.includes('继续项目'));assert(!html.includes('>暂停项目<'));
  html=render(api,p,{pendingAction:{endpoint:'cancel',project:p.id,controlVersion:3}});assert(html.includes('确认取消项目'));assert(html.includes('取消后不能继续执行'));assert(html.includes('工作区文件和审查记录保留'));
  for(const status of ['cancelled','delivered']){p.status=status;html=render(api,p);assert(!html.includes('>取消项目<'));assert(!html.includes('>继续项目<'));assert(html.includes('从列表归档'));}
});

test('a dependency-blocked milestone remains waiting even if a stale running task exists',async()=>{
  const api=await client(),p=project();p.milestones[0].blockedBy=['base'];p.milestones.push({id:'base',title:'基础结构',status:'review',denials:0,limit:3,criteria:'结构检查',blockedBy:[],tasks:[]});
  const html=render(api,p);assert(html.includes('等待依赖'));assert(html.includes('等待依赖：基础结构'));
});

test('public activity success and unknown outcomes are translated without implying acceptance',async()=>{
  const api=await client(),p=project();p.progress={phase:'pausing',activeAgents:[{name:'执行者',status:'停止中'}],latestAction:{action:'写入文件',status:'success',result:'工具执行成功'},latestVerification:{title:'本机验证',status:'unknown',summary:'验证结果待确认'},timeline:[{title:'查看验收制品',status:'success'}]};
  const html=render(api,p);for(const text of ['执行成功','结果待确认','停止中','正在暂停，等待执行活动停止'])assert(html.includes(text),text);
  assert(!html.includes(' · success'));assert(!html.includes(' · unknown'));assert(!html.includes('当前没有可确认的活动信息'));
});

test('cancellation still draining and milestone decisions are distinct from stopped project state',async()=>{
  const api=await client(),p=project();p.status='cancelled';p.progress={phase:'cancelling',activeAgents:[{name:'执行者',status:'停止中'}]};
  let html=render(api,p);assert(html.includes('已请求取消，正在停止执行活动'));assert(html.includes('停止中'));assert(!html.includes('>继续项目<'));assert(!html.includes('>暂停项目<'));
  p.status='running';p.progress={phase:'decision'};html=render(api,p);assert(html.includes('相关里程碑等待裁决，其他任务可继续'));assert(html.includes('>暂停项目<'));assert(!html.includes('>继续项目<'));
});

test('pause resume and cancel RPC only send displayed project and controlVersion',async()=>{
  const api=await client(),entries=[];let request;
  api.apply({slots:{inject:(name,fn)=>fn(),register:(entry,component)=>entries.push([entry,component])},connection:{rpc:{call:async(...args)=>{request=args;return {ok:true,value:{revision:12}};}}}});
  const manage=entries[0][0].inject().manage,signal=new AbortController().signal;
  for(const endpoint of ['pause','resume','cancel']){await manage({endpoint,project:'project-2',controlVersion:3,archiveVersion:999,command:'deliver',role:'user'},signal);assert.equal(request[0],'/foreman-next');assert.equal(request[1],endpoint);assert.equal(request[2].project,'project-2');assert.equal(request[2].controlVersion,3);assert.deepEqual(Object.keys(request[2]).sort(),['controlVersion','project']);assert.equal(request[3],signal);}
  await assert.rejects(manage({endpoint:'arbitrary',project:'project-2',controlVersion:3},signal),/Unsupported/);
});
