import {readState} from './state-reader.mjs';
import {sessionEvents} from './stored-session.mjs';
import {randomUUID} from 'node:crypto';
import {DeliveryPump} from './outbox.mjs';
import {DshTransport} from './dsh-transport.mjs';
import {pendingAssignments,syncExecutionQueue} from './execution-scheduler.mjs';
import {syncReviewQueue,REVIEW_PROTOCOL} from './review-scheduler.mjs';
import {syncCoordinatorQueue,COORDINATOR_PROTOCOL,coordinatorKey} from './coordinator-scheduler.mjs';
import {deliveryEligibility} from './delivery-policy.mjs';
import {ReviewMonitor} from './review-monitor.mjs';
import {ExecutionMonitor} from './execution-monitor.mjs';
import {reviewRunOutcome} from './review-monitor.mjs';
import {SessionPresentation,internalSessionMeta,retiredSession} from './session-presentation.mjs';

/** Explicit tick, owned by the host. No model-facing service and no background timer.
 * Production mounting remains gated on audited composition, tool guards and user UI.
 */
export class ForemanRuntime {
  #store;#controller;#driver;#model;#live=new Map();#pump;#active;#closed=false;#recovered=false;#errors=new Map();
  #monitor;#executionMonitor;#closing;#presentation;#ctx;#releaseControl;#controlDrains=new Map();#controlFailures=new Map();
  constructor(store,controller,driver,ctx,{model,reviewTimeoutMs=600000,executionTimeoutMs=null,now=Date.now}) {
    this.#store=store;this.#controller=controller;this.#driver=driver;this.#model=structuredClone(model);
    this.#ctx=ctx;
    this.#releaseControl=controller.setProjectQuiescer((project,version)=>this.#quiesceProject(project,version));
    this.#presentation=new SessionPresentation(ctx,()=>readState(store));
    this.#pump=new DeliveryPump(store,new DshTransport(store,driver,ctx,{
      resolve:job=>this.#resolve(job),lookup:job=>this.#lookup(job),
    }));
    this.#monitor=new ReviewMonitor(store,controller,{timeoutMs:reviewTimeoutMs,now,
      lookup:job=>this.#lookup(job)?.agent,
      retire:async(job,agent)=>{await this.#driver.dispose(agent);this.#live.delete(this.#key(job));},
    });
    this.#executionMonitor=new ExecutionMonitor(store,controller,{timeoutMs:executionTimeoutMs,now,
      lookup:job=>this.#lookup(job)?.agent,
      retire:async(job,agent)=>{await this.#driver.dispose(agent);this.#live.delete(this.#key(job));},
    });
  }
  diagnostics(){return [...this.#errors].map(([key,error])=>({key,error}));}
  async #drainProject(project,version) {
    const state=readState(this.#store),p=state.projects[project];
    if(!p || p.controlVersion!==version || !(p.paused || p.status==='cancelled'))throw Error('Project control changed while draining');
    if(this.#controlFailures.has(project))throw this.#controlFailures.get(project);
    for(const [key,agent] of this.#live) {
      if(readState(this.#store).runtimeAgents?.[key]?.binding.project!==project)continue;
      try {await this.#driver.dispose(agent);this.#live.delete(key);}
      catch(error){this.#controlFailures.set(project,error);throw error;}
    }
    // A missing local handle does not prove absence from the official registry.
    // Never stop an unrelated/unowned live agent or acknowledge an unknown owner.
    const owned=Object.values(readState(this.#store).runtimeAgents??{}).filter(r=>r.binding.project===project);
    if(owned.length && typeof this.#ctx.agents?.get!=='function')throw Error('Official live agent lookup is unavailable; project drain is unverified');
    if(typeof this.#ctx.agents?.get==='function')for(const r of owned)
      if(r.binding.project===project && this.#ctx.agents.get(r.sessionId))throw Error('An owned project session is still resident');
    await this.#store.dispatchRuntime({type:'project-control-drained',project,controlVersion:version});
  }
  #quiesceProject(project,version) {
    if(this.#closed)return Promise.reject(Error('Runtime is closed'));
    const key=project+':'+version;
    if(this.#controlDrains.has(key))return this.#controlDrains.get(key);
    const active=this.#active;
    const operation=(async()=>{try{await active;}catch{}if(this.#closed)throw Error('Runtime is closed');await this.#drainProject(project,version);})();
    this.#controlDrains.set(key,operation);
    void operation.then(()=>this.#controlDrains.delete(key),()=>this.#controlDrains.delete(key));return operation;
  }
  #key(job) {
    if(job.subject.protocol===REVIEW_PROTOCOL)return job.id;
    if(job.subject.protocol===COORDINATOR_PROTOCOL)return job.recipient;
    const record=Object.values(readState(this.#store).runtimeAgents??{}).find(a=>a.sessionId===job.recipient);
    if(!record)throw new Error('No reserved executor for delivery');
    return record.key;
  }
  #lookup(job) {
    const key=this.#key(job),record=readState(this.#store).runtimeAgents?.[key];
    return record?{sessionId:record.sessionId,agent:this.#live.get(key)}:null;
  }
  async #ensure(key,binding) {
    if(this.#closed)throw new Error('Runtime closed');
    const desired=this.#controller.view(binding.project);
    if(desired.paused || ['cancelled','delivered'].includes(desired.status))throw Error('Project is stopped');
    if(desired.controlVersion)binding={...binding,controlVersion:desired.controlVersion};
    if(this.#live.has(key)) {
      const agent=this.#live.get(key);
      await this.#presentation.present(agent,readState(this.#store).runtimeAgents[key]);
      return agent;
    }
    const previous=readState(this.#store).runtimeAgents?.[key];
    let record=previous;
    if(!record) {
      const state=await this.#store.dispatchRuntime({type:'reserve-agent',key,sessionId:randomUUID(),binding});
      record=state.runtimeAgents[key];
    }
    // Only a reservation with proof that creation never began can create.
    // Starting/legacy records must resume: missing files alone prove nothing.
    const fresh=record.phase==='reserved';
    const project=this.#controller.view(record.binding.project);
    if(project.paused || ['cancelled','delivered'].includes(project.status))throw Error('Project is stopped');
    let agent;
    try {
      if(fresh)await this.#store.dispatchRuntime({type:'begin-agent',key,sessionId:record.sessionId});
      agent=await this.#driver.create(record.binding,{
        cwd:project.workspace,model:this.#model,sessionId:record.sessionId,sessionMeta:internalSessionMeta,
        ...(!fresh?{persistedSessionId:record.sessionId}:{}),
      });
      const current=this.#controller.view(record.binding.project);
      if(current.paused || ['cancelled','delivered'].includes(current.status)) {
        await this.#driver.dispose(agent);agent=null;throw Error('Project stopped during agent creation');
      }
      await this.#presentation.present(agent,record);
      if(await this.#driver.checkpoint(agent))await this.#store.dispatchRuntime({type:'ready-agent',key,sessionId:record.sessionId});
      this.#live.set(key,agent);this.#errors.delete(key);
      await this.#store.dispatchRuntime({type:'incident',project:record.binding.project,key:'agent:'+key,message:null});
      return agent;
    } catch(e){
      if(agent){await this.#driver.dispose(agent);this.#live.delete(key);}
      this.#errors.set(key,e.message);
      const stopped=this.#controller.view(record.binding.project);
      if(!stopped.paused && !['cancelled','delivered'].includes(stopped.status))
        await this.#store.dispatchRuntime({type:'incident',project:record.binding.project,key:'agent:'+key,message:`代理会话创建或恢复失败：${e.message}`.slice(0,4000)});
      throw e;
    }
  }
  async #resolve(job) {
    const key=this.#key(job),s=job.subject;
    if(s.protocol===REVIEW_PROTOCOL)return this.#ensure(key,{role:'reviewer',project:job.project,reviewer:s.reviewer,
      configVersion:s.configVersion,round:s.round,generation:s.generation,attempt:s.attempt});
    if(s.protocol===COORDINATOR_PROTOCOL)return this.#ensure(key,{role:'coordinator',project:job.project,configVersion:s.configVersion});
    const record=readState(this.#store).runtimeAgents[key];
    return this.#ensure(key,record.binding);
  }
  tick({limit=2,assignLimit=2}={}) {
    if(this.#closed)return Promise.reject(new Error('Runtime closed'));
    if(!Number.isSafeInteger(assignLimit)||assignLimit<0||assignLimit>10)return Promise.reject(new Error('Invalid assignment limit'));
    if(this.#active)return this.#active;
    this.#active=this.#tick(limit,assignLimit).finally(()=>{this.#active=null;});return this.#active;
  }
  async #tick(limit,assignLimit) {
    if(!this.#recovered){await this.#pump.recover();this.#recovered=true;}
    // Revoke stopped/configuration-obsolete worlds before considering new work.
    for(const [key,agent] of this.#live) {
      if(this.#closed)return;
      // Disposal revokes authority before draining. A failed disposal must not
      // make the next tick crash while inspecting its retained live handle.
      const state=readState(this.#store),binding=state.runtimeAgents?.[key]?.binding,p=state.projects[binding?.project];
      if(p?.paused || p?.status==='cancelled' && p.controlVersion>0)continue; // Drained and acknowledged as one control operation below.
      if(!p || retiredSession({binding},readState(this.#store))) {
        await this.#driver.dispose(agent);this.#live.delete(key);
      }
    }
    for(const p of Object.values(readState(this.#store).projects))if((p.paused || p.status==='cancelled') && p.controlVersion>0 &&
      p.controlDrainVersion!==p.controlVersion) {
      try {
        await this.#drainProject(p.id,p.controlVersion);this.#errors.delete('project-control:'+p.id);
        await this.#store.dispatchRuntime({type:'incident',project:p.id,key:'project-control',message:null});
      } catch(error) {
        this.#errors.set('project-control:'+p.id,error.message);
        await this.#store.dispatchRuntime({type:'incident',project:p.id,key:'project-control',
          message:('项目已停止派发，但旧代理排空未确认；暂不可恢复。请重启宿主并核对旧代理已退出后再继续。'+error.message).slice(0,4000)});
      }
    }
    await this.#archiveRetired();
    for(const job of Object.values(readState(this.#store).outbox??{})) {
      if(this.#closed)return;
      if(job.status!=='delivered' || deliveryEligibility(readState(this.#store),job)!=='ready')continue;
      try {await this.#resolve(job);}catch(e){this.#errors.set(`resume:${job.id}`,e.message);}
    }
    for(const candidate of pendingAssignments(readState(this.#store)).slice(0,assignLimit)) {
      if(this.#closed)return;
      const {project,task,configVersion,planVersion,taskAttempt}=candidate;
      try {
        const coordinator=await this.#ensure(coordinatorKey(this.#controller.view(project)),{role:'coordinator',project,configVersion});
        const worker=await this.#ensure(`executor:${project}:${task}:${configVersion}:${planVersion}:${taskAttempt}`,{role:'executor',project,task,configVersion,planVersion,taskAttempt});
        await this.#controller.assign(coordinator,worker,task);
        this.#errors.delete(`assignment:${project}:${task}`);
      } catch(e){this.#errors.set(`assignment:${project}:${task}`,e.message);}
    }
    if(this.#closed)return;
    await this.#monitor.poll();
    if(this.#closed)return;
    await this.#executionMonitor.poll();
    if(this.#closed)return;
    await syncExecutionQueue(this.#store);await syncReviewQueue(this.#store);await syncCoordinatorQueue(this.#store);
    if(this.#closed)return;
    await this.#pump.drain({limit});
    if(this.#closed)return;
    await this.#monitor.poll();
    await this.#executionMonitor.poll();
    await this.#checkCoordinatorProgress();
    if(!this.#closed)await this.#archiveRetired();
  }
  async #archiveRetired() {
    for(const key of [...this.#errors.keys()])if(key.startsWith('presentation:'))this.#errors.delete(key);
    for(const issue of await this.#presentation.archiveRetired({isActive:()=>!this.#closed})??[])this.#errors.set('presentation:'+issue.key,issue.error);
  }
  async #checkCoordinatorProgress() {
    for(const job of Object.values(readState(this.#store).outbox??{})) {
      if(job.subject.protocol!==COORDINATOR_PROTOCOL || job.status!=='delivered')continue;
      const key='stalled:'+job.id;
      if(readState(this.#store).projects[job.project]?.paused)continue;
      if(deliveryEligibility(readState(this.#store),job)!=='ready') {
        await this.#store.dispatchRuntime({type:'incident',project:job.project,key,message:null});continue;
      }
      const actor=this.#lookup(job)?.agent;if(!actor)continue;
      const p=this.#controller.view(job.project),cursor=job.subject.auditStart;
      if(!Number.isSafeInteger(cursor))continue; // Old development jobs lack an evidence boundary.
      const progress=p.audit.slice(cursor).some(a=>a.actor==='coordinator' && a.actorId===actor.id);
      if(progress) {await this.#store.dispatchRuntime({type:'incident',project:job.project,key,message:null});continue;}
      if(actor.status==='idle' && ['ended','dropped'].includes(reviewRunOutcome(sessionEvents(actor.session),job.messageId)))
        await this.#store.dispatchRuntime({type:'incident',project:job.project,key,message:'执行负责人已结束当前回合，但没有提交计划、任务或验收申请，需要检查并恢复。'});
    }
  }
  close() {
    if(this.#closing)return this.#closing;
    this.#closed=true;
    this.#releaseControl?.();
    this.#closing=(async()=>{
      const results=await Promise.allSettled([this.#driver.close(),this.#active,this.#pump.close()]);
      await Promise.allSettled([...this.#controlDrains.values()]);
      this.#live.clear();
      const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);
      if(errors.length)throw new AggregateError(errors,'Runtime shutdown failed');
    })();return this.#closing;
  }
}
