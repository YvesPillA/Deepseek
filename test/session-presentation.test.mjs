import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {SessionPresentation,internalSessionMeta,internalSessionTitle,retiredSession} from '../src/session-presentation.mjs';
import {DshAgentDriver} from '../src/controller.mjs';
import {readStoredSession} from '../src/stored-session.mjs';
const project={id:'p',status:'running',configVersion:1,tasks:{t:{title:'实现',status:'running',attempt:1,planVersion:1}},
  reviewers:[{id:'quality',name:'质量监督'}],rounds:{round:{kind:'plan',milestone:'M1',status:'open',generation:2,votes:{},attempts:{}}}};
const record=(key,role='coordinator',id=key)=>({key,sessionId:id,phase:'ready',binding:{project:'p',role,configVersion:1,
  ...(role==='executor'?{task:'t',taskAttempt:1,planVersion:1}:role==='reviewer'?{round:'round',reviewer:'quality',generation:2,attempt:1}:{})}});

test('internal names identify role, task, reviewer and exact review activation without claiming a parent',()=>{
  assert.deepEqual(internalSessionMeta,{origin:'subagent'});
  assert.match(internalSessionTitle(record('c').binding,project),/新工头 · p · 执行负责人 c1/);
  assert.match(internalSessionTitle(record('e','executor').binding,project),/执行 t a1 · 实现/);
  assert.match(internalSessionTitle(record('r','reviewer').binding,project),/监督 quality · M1 规划 g2 a1 round · 质量监督/);
  assert.match(internalSessionTitle(record('r','reviewer').binding,{...project,rounds:{round:{...project.rounds.round,kind:'acceptance'}}}),/M1 验收/);
  const title=internalSessionTitle({...record('r','reviewer').binding,project:'中'.repeat(1000)},
    {...project,reviewers:[{id:'quality',name:'\u202e\n监'.repeat(1000)}]});
  assert(title.length<150);assert(!/[\n\u202e]/u.test(title));
});

test('only an exact reserved identity receives a durable name; resume preserves manual titles',async()=>{
  const r=record('c'),state={projects:{p:project},runtimeAgents:{c:r}},events=[];
  const session={id:'c',events},agent={id:'c',session};let renames=0,flushes=0;
  const ctx={sessionTitle:{get:()=>events.find(e=>e.type==='session/title'),rename:(_session,title)=>{
    renames++;events.push({type:'session/title',data:{title}});}},sessions:{flush:async()=>{flushes++;return true;}}};
  const presentation=new SessionPresentation(ctx,()=>state);
  await presentation.present(agent,r);await presentation.present(agent,r);
  assert.equal(renames,1);assert.equal(flushes,1);
  await assert.rejects(presentation.present({...agent,id:'outer'},r),/ownership/);
  const manual={...ctx,sessionTitle:{get:()=>({title:'用户自定义'}),rename:()=>assert.fail('No manual-title overwrite')}};
  await new SessionPresentation(manual,()=>state).present(agent,r);
  events.length=0;ctx.sessions.flush=async()=>false;
  await assert.rejects(new SessionPresentation(ctx,()=>state).present(agent,r),/durably flushed/);
});

test('late title service supplies a name once without repeatedly scanning long session history',async()=>{
  const r=record('c'),state={projects:{p:project},runtimeAgents:{c:r}},agent={id:'c',session:{id:'c',events:[]}};
  let scans=0;const ctx={sessions:{flush:async()=>true}},presentation=new SessionPresentation(ctx,()=>state);
  await presentation.present(agent,r);assert.equal(agent.session.events.length,0);
  ctx.sessionTitle={get:()=>{scans++;return null;},rename:(session,title)=>session.events.push({type:'session/title',data:{title}})};
  await presentation.present(agent,r);await presentation.present(agent,r);assert.equal(scans,1);assert.equal(agent.session.events.length,1);
});

test('terminal sweeps archive owned inactive sessions only, preserving outer, other projects and active sessions',async()=>{
  const done={...project,status:'cancelled',archived:true},records={c:record('c'),e:record('e','executor'),r:record('r','reviewer'),o:{...record('o'),binding:{project:'other',role:'coordinator',configVersion:1}}};
  const state={projects:{p:done,other:project},runtimeAgents:records},archived=[],calls=[];
  const ctx={agents:{get:id=>id==='e'?{id}:undefined},workspaceRegistry:{archivedSessionIds:archived,archiveSession:async(id,options)=>{
    assert.deepEqual(options,{});calls.push(id);archived.push(id);}}};
  const p=new SessionPresentation(ctx,()=>state);assert.deepEqual(await p.archiveRetired(),[]);
  assert.deepEqual(calls,['c','r']);assert(!archived.includes('outer'));assert(!archived.includes('o'));assert(!archived.includes('e'));
  await p.archiveRetired();assert.equal(calls.length,2);assert.equal(state.projects.p.status,'cancelled');
  state.projects.p={...done,status:'running',archived:false};ctx.agents.get=()=>undefined;await p.archiveRetired();assert(!archived.includes('e'));
});

test('missing reservations, ambiguous identity, archive failures and closing scopes are fail-closed',async()=>{
  const records={c:record('c'),e:record('e','executor'),r:record('r','reviewer')};
  const state={projects:{p:{...project,status:'delivered'}},runtimeAgents:records};let active=true;const calls=[];
  const ctx={agents:{get:()=>undefined},workspaceRegistry:{archivedSessionIds:[],archiveSession:async id=>{
    calls.push(id);if(id==='c')throw Object.assign(Error('absent'),{name:'WorkspaceUnknownSessionError',sessionId:id});
    throw Error('disk failed');}}};
  const p=new SessionPresentation(ctx,()=>state),issues=await p.archiveRetired();
  assert.equal(issues.length,2);assert(issues.every(x=>x.error==='disk failed'));
  state.runtimeAgents.extra={...record('extra'),sessionId:'e'};
  assert((await p.archiveRetired()).some(x=>x.error==='Session ownership is ambiguous'));
  calls.length=0;delete state.runtimeAgents.extra;
  ctx.workspaceRegistry.archiveSession=async id=>{calls.push(id);active=false;};
  await p.archiveRetired({isActive:()=>active});assert.deepEqual(calls,['c']);
  await new SessionPresentation({},()=>state).archiveRetired();
  assert.match((await new SessionPresentation({...ctx,agents:{}},()=>state).archiveRetired())[0].error,/lookup is unavailable/);
});

test('role retirement tracks finished and obsolete task/review activations without revoking active coordinator',()=>{
  const state={projects:{p:structuredClone(project)}};
  for(const role of ['coordinator','executor','reviewer'])assert.equal(retiredSession(record('x',role),state),false);
  state.projects.p.tasks.t.attempt=2;assert.equal(retiredSession(record('e','executor'),state),true);
  state.projects.p.rounds.round.votes.quality={pass:true};assert.equal(retiredSession(record('r','reviewer'),state),true);
  assert.equal(retiredSession(record('c'),state),false);
  state.projects.p.configVersion=2;assert.equal(retiredSession(record('c'),state),true);
});

const requireDsh=createRequire(path.join(process.env.DSH_TEST_INSTALL??'C:/example/dsh/node/node_modules/@deepseek-ai/dsh','package.json'));
const load=async name=>import(pathToFileURL(requireDsh.resolve('@deepseek-ai/'+name)).href);
const version=requireDsh('@deepseek-ai/dsh-agent-loop/package.json').version;
test('actual 0.2 internal headers and log-backed titles preserve host roots; official archive survives restart without changing session bytes',
  {timeout:15000,skip:version==='0.2.0-rc.2'?false:'Requires actual 0.2 workspace registry'},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'foreman-presentation-'));
  const [{Context},{SessionStore},{default:Projection},{default:Persistence},{AgentRegistry},{LlmRuntime},{ToolRuntime},{SystemPrompt},{AgentLoop},
    {default:Title},{default:Storage},StorageJson,StorageDomain,{default:Workspace}]=await Promise.all([
    load('cordis'),load('dsh-session'),load('dsh-session-projection'),load('dsh-session-persistence-jsonl'),load('dsh-agent'),load('dsh-llm'),load('dsh-tools'),
    load('dsh-system-prompt'),load('dsh-agent-loop'),load('dsh-session-title'),load('dsh-storage'),load('dsh-storage-json'),load('dsh-storage-domain'),load('dsh-workspace')]);
  let ctx,fibers=[],driver,modelCalls=0;
  const mount=async()=>{
    ctx=new Context();fibers=[];
    for(const [plugin,config] of [[SessionStore,{}],[Projection,{}],[Persistence,{root:path.join(root,'sessions')}],[AgentRegistry,{}],[LlmRuntime,{}],
      [ToolRuntime,{mode:'native'}],[SystemPrompt,{}],[AgentLoop,{agents:[]}],[Title,{fallbackMaxWords:10,fallbackMaxBytes:128,maxTitleBytes:256}],
      [Storage,{}],[StorageJson,{root:path.join(root,'storage')}],[StorageDomain,{backend:'json',routes:{}}],[Workspace,{}]]) {
      const fiber=ctx.plugin(plugin,config);fibers.push(fiber);await fiber;
    }
    ctx.on('llm/stream',async function*(){modelCalls++;throw Error('No model calls allowed');});
  };
  const close=async()=>{await driver?.close();driver=undefined;for(const fiber of fibers.reverse())await fiber.dispose();fibers=[];};
  try {
    await mount();const id=randomUUID(),r=record('c','coordinator',id);
    const state={projects:{p:structuredClone(project)},runtimeAgents:{c:r}};
    driver=new DshAgentDriver(ctx,{bind:()=>()=>{}},{compose:async()=>{}});
    const agent=await driver.create(r.binding,{sessionId:id,cwd:root,sessionMeta:internalSessionMeta});
    assert.equal(agent.session.header.origin,'subagent');assert.equal(agent.session.header.parentSession,undefined);
    assert(ctx.agents.roots().includes(agent));assert.equal(ctx.agents.isOwnedBy(id,agent),false);
    const p=new SessionPresentation(ctx,()=>state);await p.present(agent,r);
    assert.match(ctx.sessionTitle.get(agent.session).title,/新工头 · p · 执行负责人/);
    assert.equal(await driver.checkpoint(agent),true);
    const stored=await readStoredSession(ctx.sessionPersistence,id);assert.equal(stored.meta.origin,'subagent');
    state.projects.p.status='cancelled';await p.archiveRetired();assert(!ctx.workspaceRegistry.archivedSessionIds.includes(id));
    await driver.dispose(agent);assert.deepEqual(await p.archiveRetired(),[]);assert(ctx.workspaceRegistry.archivedSessionIds.includes(id));
    assert.deepEqual(await readStoredSession(ctx.sessionPersistence,id),stored);
    await close();await mount();assert(ctx.workspaceRegistry.archivedSessionIds.includes(id));
    assert.deepEqual(await readStoredSession(ctx.sessionPersistence,id),stored);
    await ctx.workspaceRegistry.unarchiveSession(id);assert(!ctx.workspaceRegistry.archivedSessionIds.includes(id));
    assert.equal(ctx.agents.get(id),undefined);assert.deepEqual(await readStoredSession(ctx.sessionPersistence,id),stored);assert.equal(modelCalls,0);
  }finally{await close();await fs.rm(root,{recursive:true,force:true});}
});

test('actual 0.2 ordinary sidebar predicate excludes host internal headers and hides archived legacy rows',
  {skip:version==='0.2.0-rc.2'?false:'Requires actual 0.2 sidebar predicate'},async()=>{
  const client=await fs.readFile(path.join(path.dirname(requireDsh.resolve('@deepseek-ai/dsh-client-ui-workspace')),'client.js'),'utf8');
  const start=client.indexOf('function sessionVisible(session, current, archived, archivedFilter) {');
  assert(start>=0);const end=client.indexOf('\n\t\t}',start);assert(end>start);
  // Execute exactly the package-owned pure predicate; no renderer, browser,
  // user configuration, or local substitute of the visibility policy.
  const visible=new Function(`${client.slice(start,end+4)};return sessionVisible;`)();
  const archived=new Set(['legacy-internal']);
  for(const filter of ['default','show','only'])assert.equal(visible({id:'future-internal',origin:'subagent'},null,archived,filter),false);
  assert.equal(visible({id:'legacy-internal'},null,archived,'default'),false);
  assert.equal(visible({id:'legacy-internal'},null,archived,'only'),true);
  assert.equal(visible({id:'outer'},null,archived,'default'),true);
});
