// Opt-in paid integration fixture, isolated from the user's installed profile.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {selectDshRuntime,parseRuntimeYaml,modelProfilePatch} from './dsh-runtime.mjs';
import {openApplication} from '../src/application.mjs';
import {UserControl} from '../src/user-control.mjs';
import {createOuterComposer} from '../src/outer-tools.mjs';
import {dashboardSnapshot} from '../src/dashboard.mjs';
import {DshAgentDriver} from '../src/controller.mjs';
import {ForemanRuntime} from '../src/runtime.mjs';
import {RuntimeLoop} from '../src/runtime-loop.mjs';
import {smokeRoute,profileModelSettings,boundedModelFetch,validateNativeModelAuthorization,validateNativeModelResume,persistBatchLedger} from './model-smoke-support.mjs';
import {freshMarker,validateNativeModelEntry,claimNativeModelFresh} from './native-model-entry.mjs';
import {initializeNativeModelChat,nativeModelFixtureComposerContext} from './native-model-chat-entry.mjs';
export const name='foreman-native-model-ui';
export const inject=['agents','sessions','sessionPersistence','userQuestions','workspaceRegistry','sessionTitle'];
export async function apply(ctx,config) {
  const root=await fs.realpath(config.root),work=path.join(root,'work');
  assert.equal(path.dirname(root),path.resolve('C:/example/foreman-tests'));
  assert.match(path.basename(root),/^native-model-ui-[a-zA-Z0-9_-]+$/);
  assert.equal(path.resolve(process.env.DSH_HOME??''),path.join(root,'home'));
  assert(['authorized-native-model-ui-40-4096-600000','prepared-native-model-ui',freshMarker].includes(await fs.readFile(path.join(root,'fixture-marker'),'utf8')));
  const requireDsh=selectDshRuntime().requireDsh;
  const settings=profileModelSettings(parseRuntimeYaml({requireDsh},await fs.readFile(path.join(root,'home/profiles/web/cordis.patch.yml'),'utf8')));
  const {route,ref}=smokeRoute(settings);
  const batch=process.env.FOREMAN_UI_BATCH;
  assert.match(batch??'',/^[a-zA-Z0-9_-]{1,60}$/,'Explicit authorized batch required');
  const auth=validateNativeModelAuthorization(JSON.parse(await fs.readFile(path.join(root,'run-authorization-'+batch+'.json'),'utf8')),{root,batch});
  const entry=process.env.FOREMAN_UI_ENTRY??'resume';
  const entryState=await validateNativeModelEntry(root,{entry,batch,auth});
  assert.equal(ref,'DEEPSEEK_API_KEY');
  assert.equal(process.env.FOREMAN_UI_LAUNCHER,'C:\\example\\dsh\\launch.cmd','Use the approved local launcher');
  let secret=process.env[ref];
  if(!secret||/[%\r\n]/.test(secret))throw Error('Cannot safely resolve approved credential');
  const priorSecret=process.env[ref];process.env[ref]=secret;secret=undefined;
  const ledgerPath=path.join(root,'requests-'+batch+'.json');
  const lockPath=path.join(root,'requests-'+batch+'.lock');
  const lock=await fs.open(lockPath,'wx');
  const originalFetch=globalThis.fetch;let app,cleanupInstalled=false;
  const releaseLock=async()=>{await lock.close();await fs.unlink(lockPath);};
  const persistLedger=value=>persistBatchLedger(ledgerPath,value);
  try {
  await lock.writeFile(String(process.pid));
  if(entry==='fresh')await claimNativeModelFresh(root,{batch,nonce:entryState.nonce});
  let ledger;try{ledger=JSON.parse(await fs.readFile(ledgerPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;ledger={batch,calls:0,deadline:auth.expiresAt};}
  assert(ledger.batch===batch&&Number.isSafeInteger(ledger.calls)&&ledger.calls>=0&&ledger.calls<40&&ledger.deadline===auth.expiresAt&&ledger.deadline>Date.now(),'Authorized batch exhausted');
  await persistLedger(ledger);
  const priorCalls=ledger.calls;let ledgerWrites=Promise.resolve();
  const network=boundedModelFetch(async(url,options)=>{ledger.calls=priorCalls+network.count();const record={...ledger};ledgerWrites=ledgerWrites.then(()=>persistLedger(record));await ledgerWrites;return originalFetch(url,options);},{maxRequests:40-priorCalls,durationMs:ledger.deadline-Date.now()});
  globalThis.fetch=network.fetch;
  app=await openApplication({storageRoot:path.join(root,'journal'),dshHome:path.join(root,'home'),sessionRoot:path.join(root,'home/sessions'),
    verification:{executable:path.join(process.env.LOCALAPPDATA,'Programs/DockerDesktop/resources/bin/docker.exe'),image:'sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553'}});
  let handle,closed=false;
  const selectedRuntime=selectDshRuntime();
  const report={root,batch,entry,runtime:{root:selectedRuntime.root,version:selectedRuntime.version},status:'waiting-for-chat',networkRequests:priorCalls,modelTurns:0};
  const save=async()=>{report.networkRequests=priorCalls+network.count();report.projects=Object.values(app.store.snapshot().projects).map(p=>({id:p.id,status:p.status,milestones:p.milestones,tasks:p.tasks,reviewers:p.reviewers}));await fs.writeFile(path.join(root,'report-'+batch+'.json'),JSON.stringify(report,null,2));};
  const model={...route,maxTokens:4096};
  const driver=new DshAgentDriver(ctx,app.controller,{compose:app.compose});
  const runtime=new ForemanRuntime(app.store,app.controller,driver,ctx,{model,reviewTimeoutMs:180000,executionTimeoutMs:180000});
  const loop=new RuntimeLoop({create:async()=>runtime,enabled:()=>!closed});
  const control=new UserControl(app.controller,{agents:ctx.get('agents'),userQuestions:ctx.get('userQuestions')},{canStart:()=>!!app.verification});
  const stop=async reason=>{
    if(closed)return;closed=true;report.status=reason;
    control.close();await loop.close();await handle?.dispose();await save();
  };
  ctx.effect(()=>async()=>{clearTimeout(deadline);clearInterval(progress);try{await stop('stopped');await app.close();}finally{globalThis.fetch=originalFetch;if(priorSecret===undefined)delete process.env[ref];else process.env[ref]=priorSecret;await releaseLock();}});
  cleanupInstalled=true;
  const deadline=setTimeout(()=>{void stop('request-window-ended');},Math.max(1,ledger.deadline-Date.now()));
  const progress=setInterval(()=>{void save();},3000);
  const outerFile=path.join(root,'outer-session.txt');
  let resumeId;try{resumeId=(await fs.readFile(outerFile,'utf8')).trim();assert.match(resumeId,/^[a-f0-9-]{36}$/);}catch(error){if(error.code!=='ENOENT')throw error;}
  const options={...(resumeId?{resumeSessionId:resumeId}:{sessionId:randomUUID(),meta:{cwd:work}}),agentOptions:model,
    setup:async (agentCtx,agent)=>{
      await createOuterComposer(control,{snapshot:()=>dashboardSnapshot(app.store.snapshot(),{readyForProjects:!!app.verification,blockers:app.verification?[]:[{message:app.startupIssue}]})})(nativeModelFixtureComposerContext(agentCtx,work),{contains:candidate=>candidate===agent});
      agentCtx.get('tools').guard(exec=>{
        if(exec.name!=='foreman_user_request')return;
        try {const command=JSON.parse(exec.arguments.command);
          if(command.type==='create'&&command.id!=='chat')return 'This fixture requires create.id="chat". Preserve the proposed reviewers and retry with that ID; it has not created a project.';
          if(command.type==='create'&&path.resolve(command.workspace)!==work)return 'This fixture requires create.workspace="'+work.replaceAll('\\','/')+'". No other workspace is authorized.';
          if(command.type!=='create'&&command.project!=='chat')return 'This fixture requires command.project="chat".';
        }catch{return 'Invalid integration request';}
      });
    }};
  handle=await ctx.get('agents')[resumeId?'resume':'create'](options);
  await fs.writeFile(outerFile,handle.agent.id);
  report.session=handle.agent.id;
  if(!resumeId)report.chatEntry=await initializeNativeModelChat(ctx,handle.agent);
  await ctx.get('sessions').flush(handle.agent.session);
  const workspace=await ctx.get('workspaceRegistry').create(work,'新工头聊天入口验收');await workspace.attachSession(handle.agent.id);
  report.workspaceId=workspace.id;
  ctx.on('llm/stream',async function*(options,next){
    if(closed)throw Error('Integration has stopped');
    report.modelTurns++;await save();
    yield* next();
    await save();
  });
  report.verificationReady=!!app.verification;report.status='running';await save();loop.start();
  }catch(error){if(!cleanupInstalled){await app?.close();globalThis.fetch=originalFetch;if(priorSecret===undefined)delete process.env[ref];else process.env[ref]=priorSecret;await releaseLock();}throw error;}
}
