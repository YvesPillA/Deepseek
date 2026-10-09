import path from 'node:path';
import {randomUUID} from 'node:crypto';
import { Controller, DshAgentDriver } from './controller.mjs';
import {openHostApplication} from './application.mjs';
import {dashboardSnapshot,dashboardHandler,alertSnapshot} from './dashboard.mjs';
import {UserControl} from './user-control.mjs';
import {createOuterComposer} from './outer-tools.mjs';
import {registerOuterEntry} from './outer-link.mjs';
import {createManagedRuntime} from './managed-runtime.mjs';
import {SessionRecovery} from './session-recovery.mjs';
import {readinessSnapshot} from './readiness.mjs';
import {verifyReleaseApproval} from './release-approval.mjs';

export const name = 'foreman-next';
export const inject = ['agents','sessions'];

/** Host-plane plugin entry. Exposes only authenticated terminal-card actions, never a general user-command RPC or shell.
 * Runtime composition and UI authorization are integration gates, not prompt assertions.
 * All methods below are trusted same-process capabilities; never publish them through
 * Creator-mode service inspection to execution/observer agents.
 */
export async function apply(ctx, config) {
  if (!config || typeof config.storageRoot !== 'string' || !path.isAbsolute(config.storageRoot)) throw new Error('foreman-next: absolute storageRoot required');
  let scopedAgent;try{scopedAgent=ctx.agent;}catch{}
  if (scopedAgent) throw new Error('foreman-next must be mounted on the host plane');
  if(config.verification?.backend==='native') {
    ctx.inject(['sandbox','subprocess'],nativeCtx=>mountHost(nativeCtx,config,{sandbox:nativeCtx.get('sandbox'),subprocess:nativeCtx.get('subprocess')}));
    return;
  }
  return mountHost(ctx,config);
}

async function mountHost(ctx,config,options) {
  const application=await openHostApplication(config,options);
  const releaseApproval=await verifyReleaseApproval({approvalPath:config.releaseApprovalPath,
    dshHome:config.dshHome,storageRoot:config.storageRoot,verificationImage:config.verification?.image,
    verificationBackend:config.verification?.backend??'docker'});
  const {store,controller}=application;
  let userControl,scheduler,sessionContext,dashboardConnected=false,projectManagementConnected=false;
  const recovery=new SessionRecovery({controller,store,context:()=>{if(!sessionContext)throw Error('Session persistence is unavailable');return sessionContext;},
    maintenance:operation=>{if(!scheduler)throw Error('Runtime scheduler is unavailable');return scheduler.runStopped(operation);}});
  const service = Object.freeze({
    list: () => Object.values(store.snapshot().projects).filter(p=>!p.archived && !p.deleted).map(p=>({id:p.id,objective:p.objective,status:p.status,notificationCount:p.notifications.filter(n=>!n.acknowledged&&n.kind!=='record').length})),
    view: id => controller.view(id),
    snapshot:()=>dashboardSnapshot(store.snapshot(),service.readiness()),
    readiness: () => readinessSnapshot({application,scheduler,sessionContext,userControl,dashboardConnected,projectManagementConnected,agentOptions:config.scheduler?.agentOptions,releaseApproval}),
  });
  try {
    ctx.provide('foremanNext',service);
    ctx.effect(() => async()=>{userControl?.close();try{await application.verification?.close();}finally{try{await scheduler?.close();}finally{await application.close();}}}, 'foreman-next.close');
    ctx.inject(['sessionPersistence'],runtimeCtx=>{
      sessionContext={agents:runtimeCtx.get('agents'),sessionPersistence:runtimeCtx.get('sessionPersistence')};
      const options=config.scheduler??{};
      const loop=createManagedRuntime(application,{agents:runtimeCtx.get('agents'),sessions:runtimeCtx.get('sessions'),sessionPersistence:runtimeCtx.get('sessionPersistence'),
          get sessionTitle(){return runtimeCtx.get('sessionTitle');},get workspaceRegistry(){return runtimeCtx.get('workspaceRegistry');}},
        {intervalMs:options.intervalMs,reviewTimeoutMs:options.reviewTimeoutMs,executionTimeoutMs:options.executionTimeoutMs,agentOptions:options.agentOptions,
          enabled:()=>!!userControl && service.readiness().readyForProjects});
      scheduler=loop;
      runtimeCtx.effect(()=>{
        loop.start();return async()=>{await loop.close();if(scheduler===loop){scheduler=undefined;sessionContext=undefined;}};
      },'foreman-next.scheduler');
    });
    ctx.inject(['userQuestions'],questionCtx=>{
      const control=new UserControl(controller,{agents:questionCtx.get('agents'),userQuestions:questionCtx.get('userQuestions')},
        {canStart:()=>service.readiness().readyForProjects,dependencies:application.dependencies,provisioner:application.provisioner,recovery});
      userControl=control;
      questionCtx.effect(()=>{
        const unlink=registerOuterEntry(service,createOuterComposer(control,{snapshot:service.snapshot}));
        return ()=>{unlink();control.close();if(userControl===control)userControl=undefined;};
      },'foreman-next.user-control');
    });
    ctx.inject(['connection','webServer'],connectionCtx=>{
      const connection=connectionCtx.root.get('connection'),operator=connection.operator;
      const lifetime=new AbortController();
      // Only the authenticated operator carrier may alter terminal-project
      // display metadata. No general controller or model command is exposed.
      const action=type=>async({project,archiveVersion},signal,peer)=>{
        const combined=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;
        const authorize=()=>{
          combined.throwIfAborted();
          if(!operator || peer!==operator || connection.operator!==operator || typeof operator.ctx?.fiber?.assertActive!=='function')throw Error('Authenticated operator required');
          operator.ctx.fiber.assertActive();
          if((controller.view(project).archiveVersion??0)!==archiveVersion)throw Error('项目显示状态已改变，请刷新后重试。');
        };
        authorize();
        const ticket=await controller.prepareUserCommand({type,project});
        await controller.confirmUserCommand(ticket,'foreman-panel-'+randomUUID(),{authorize,source:'dsh-panel-operator'});
      };
      const actions=operator && typeof operator.ctx?.fiber?.assertActive==='function'
        ?{operator,archive:action('archive'),unarchive:action('unarchive'),'delete-project':action('delete-project')}:undefined;
      const dispose=connection.rpc.handle('/foreman-next',dashboardHandler(service.snapshot,()=>alertSnapshot(store.snapshot()),actions));
      dashboardConnected=true;
      projectManagementConnected=!!actions;
      connectionCtx.effect(()=>async()=>{lifetime.abort(new Error('Dashboard scope disposed'));dashboardConnected=false;projectManagementConnected=false;await dispose();},'foreman-next.dashboard');
    });
  } catch(e) {await application.close();throw e;}
}

export { Controller, DshAgentDriver };
