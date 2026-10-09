// Opt-in real DeepSeek integration, using an isolated test project and sessions.
// Never imports the user's launcher as code or writes its credentials/config.
import fs from 'node:fs/promises';
import path from 'node:path';
import {selectDshRuntime,parseRuntimeYaml,modelProfilePatch} from './dsh-runtime.mjs';
import {pathToFileURL} from 'node:url';
import {openApplication} from '../src/application.mjs';
import {DshAgentDriver} from '../src/controller.mjs';
import {ForemanRuntime} from '../src/runtime.mjs';
import {smokeRoute,profileModelSettings,boundedModelFetch,parallelObjective} from './model-smoke-support.mjs';
const requireDsh=selectDshRuntime().requireDsh;
const load=async name=>import(pathToFileURL(requireDsh.resolve('@deepseek-ai/'+name)).href);
const settings=profileModelSettings(parseRuntimeYaml({requireDsh},await fs.readFile(modelProfilePatch(),'utf8')));
const {route,ref,adapter,config:adapterConfig}=smokeRoute(settings);
let secret=process.env[ref];
if(!secret) {
  const launcher=await fs.readFile('C:/example/dsh/launch.cmd','utf8');
  const match=launcher.match(new RegExp('^\\s*@?set\\s+"?'+ref+'=([^\\r\\n]*)$','mi'));
  secret=match?.[1]?.trim().replace(/"$/,'');
}
if(!secret || /[%\r\n]/.test(secret))throw Error('Configured credential could not be resolved safely');
const args=process.argv.slice(2),resume=args[0]==='--resume',parallel=args[0]==='--parallel';
if(args.length && !(resume&&(args.length===2 || (args.length===4 && args[2]==='--resume-review' && /^[a-zA-Z0-9_-]{1,80}$/.test(args[3])))) && !(parallel&&args.length===1))throw Error('Usage: model-smoke.mjs [--parallel | --resume ABSOLUTE_TEST_ROOT [--resume-review ROUND_ID]]');
const resumeReview=resume&&args.length===4?args[3]:null;
let root;
if(resume) {
  if(!path.isAbsolute(args[1]))throw Error('Absolute test root required');
  root=await fs.realpath(args[1]);
  if(path.dirname(root)!==path.resolve('C:/example/foreman-tests') || !/^foreman-model-smoke-[a-zA-Z0-9_-]+$/.test(path.basename(root)))throw Error('Only an existing model smoke project can be resumed');
}else root=await fs.mkdtemp('C:/example/foreman-tests/foreman-model-smoke-');
const work=path.join(root,'work'),sessionRoot=path.join(root,'sessions');
if(!resume){await fs.mkdir(work);await fs.mkdir(sessionRoot);}
const baseImage='sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553';
const app=await openApplication({storageRoot:path.join(root,'journal'),dshHome:'C:/example/dsh/home',sessionRoot,
  verification:{executable:path.join(process.env.LOCALAPPDATA,'Programs/DockerDesktop/resources/bin/docker.exe'),image:baseImage}});
const [{Context},{SessionStore},{JsonlSessionPersistence},{AgentRegistry},{LlmRuntime},pi,{ToolRuntime},{SystemPrompt},{AgentLoop}]=await Promise.all([
  load('cordis'),load('dsh-session'),load('dsh-session-persistence-jsonl'),load('dsh-agent'),load('dsh-llm'),load(adapter),load('dsh-tools'),load('dsh-system-prompt'),load('dsh-agent-loop')]);
const ctx=new Context(),fibers=[];let runtime,calls=0,last='',stopReason='deadline';
async function mount(plugin,config){const fiber=ctx.plugin(plugin,config);fibers.push(fiber);await fiber;}
const deadline=Date.now()+10*60*1000;
const originalFetch=globalThis.fetch,network=boundedModelFetch(originalFetch);
globalThis.fetch=network.fetch;
const reportPath=path.join(root,resume?'report-resume-'+Date.now()+'.json':'report.json');
await fs.writeFile(reportPath,JSON.stringify({status:'starting',root,provider:route.provider,model:route.model},null,2));
try {
  ctx.provide('credentials',{resolve:async key=>key===ref?{value:secret,source:'host-launcher'}:undefined});
  await mount(SessionStore);await mount(JsonlSessionPersistence,{root:sessionRoot});await mount(AgentRegistry);
  await mount(LlmRuntime);await mount(pi,adapterConfig);
  await mount(ToolRuntime,{mode:'ptc'});await mount(SystemPrompt,{});
  ctx.on('llm/stream',async function*(options,next){
    if(calls>=40 || Date.now()>deadline)throw Error('Integration request limit reached');
    calls++;console.log(JSON.stringify({event:'model-request',calls,provider:route.provider,model:route.model}));
    yield* next();
  });
  await mount(AgentLoop,{agents:[],maxParallelToolCalls:2});
  const driver=new DshAgentDriver({agents:ctx.get('agents'),sessions:ctx.get('sessions'),sessionPersistence:ctx.get('sessionPersistence')},app.controller,{compose:app.compose});
  runtime=new ForemanRuntime(app.store,app.controller,driver,{sessions:ctx.get('sessions'),sessionPersistence:ctx.get('sessionPersistence')},
    {model:{provider:route.provider,model:route.model,maxTokens:4096},reviewTimeoutMs:180000,executionTimeoutMs:240000});
  // Approved user test scope; model agents independently plan, implement and vote.
  if(resume) {
    const p=app.controller.view('p');
    if(path.resolve(p.workspace)!==path.resolve(work)||p.reviewers.length!==2)throw Error('Unexpected resume project');
    // Explicit user-authorized technical recovery, never an inferred vote or
    // a reset of milestone denial counts. Core validates the selected round.
    if(resumeReview)await app.controller.userCommand({type:'resume-review',project:'p',round:resumeReview});
  }else await app.controller.userCommand({type:'create',id:'p',workspace:work,
    objective:parallel?parallelObjective:'实现一个无第三方依赖的 Node.js 小项目：calculator.cjs 导出 add(a,b) 函数，只接受有限 number，其他输入抛 TypeError；test.cjs 用 node:assert/strict 检查正常、负数、小数及非法输入；README.md 写运行方法 node test.cjs。由执行负责人自行规划一个里程碑和一个任务，执行者实现并用 foreman_verify 运行测试，监督者按职责验收。里程碑通过后执行负责人必须提交 final。不要添加 package.json 或 npm 依赖。',
    reviewers:[{id:'behavior',name:'功能监督',responsibility:parallel?'检查 add、slug 和集成行为':'检查 add 输入输出与错误处理',criteria:parallel?'add和slug行为符合项目需求，非法输入处理正确，各阶段快照与验证证据对应':'有限数值求和正确，非数值与 Infinity/NaN 抛 TypeError，快照与执行证据对应'},
      {id:'quality',name:'质量监督',responsibility:'检查可维护性、测试与运行说明',criteria:'无第三方依赖，测试覆盖需求，README 运行说明可用，有对应快照的成功验证证据'}],denialLimit:3,patrolEvery:3,faultRetries:1});
  let resumedCoordinator=false;
  while(Date.now()<deadline) {
    await runtime.tick();
    const p=app.controller.view('p');
    if(resume && !resumedCoordinator) {
      const stalled=p.notifications.find(n=>!n.resolved && !n.acknowledged && n.message?.includes('执行负责人已结束当前回合'));
      if(stalled) {
        // The user explicitly resumed this bounded smoke task; real product
        // recovery still uses the native outer confirmation workflow.
        await app.controller.userCommand({type:'resume-coordinator',project:'p',notification:stalled.id,reason:'用户要求继续此前因模型请求额度停止的测试，请读取当前状态并推进最终验收。'});
        resumedCoordinator=true;
      }
    }
    const compact={status:p.status,calls,tasks:Object.values(p.tasks).map(t=>[t.id,t.status]),milestones:Object.values(p.milestones).map(m=>[m.id,m.status,m.denials]),errors:runtime.diagnostics()};
    const text=JSON.stringify(compact);if(text!==last){console.log(text);last=text;await fs.writeFile(path.join(root,'status.json'),text);}
    if(p.status==='approved'){stopReason='approved';break;}
    if(calls>=40){stopReason='request-limit';break;}
    if(Object.values(p.milestones).some(m=>m.status==='paused')){stopReason='user-decision-required';break;}
    await new Promise(r=>setTimeout(r,750));
  }
} finally {
  await runtime?.close();
  const state=app.store.snapshot();
  await fs.writeFile(reportPath,JSON.stringify({status:stopReason,root,calls,provider:route.provider,model:route.model,project:state.projects.p??null,
    verificationCount:Object.values(state.verificationContainers??{}).filter(v=>v.result).length,networkRequests:network.count(),
    observedRejectedRounds:Object.values(state.projects.p?.rounds??{}).filter(r=>r.outcome==='rejected').length,
    scenario:parallel?'parallel':'existing-or-calculator',realModel:true,resumed:resume,finalDeliveryPerformed:false},null,2));
  await app.close();for(const f of fibers.reverse())await f.dispose();
  console.log('Report: '+reportPath);
  globalThis.fetch=originalFetch;
}
