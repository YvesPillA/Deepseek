import { randomUUID } from 'node:crypto';
import { projectView, transition } from './core.mjs';
import {readState} from './state-reader.mjs';
import {readStoredSession,sessionEvents} from './stored-session.mjs';

const allowed = {
  coordinator: new Set(['propose','task','retry-task','submit','final']),
  executor: new Set(['complete']),
  reviewer: new Set(['vote'])
};
const ensure = (value, reason) => { if (!value) throw new Error(reason); };
const approvalBasis=p=>p?JSON.stringify({status:p.status,configVersion:p.configVersion,objective:p.objective,workspace:p.workspace,
  archived:p.archived===true,deleted:p.deleted===true,archiveVersion:p.archiveVersion??0,
  coordinatorWake:p.coordinatorWake,
  reviewers:p.reviewers,milestones:p.milestones,rounds:Object.values(p.rounds).map(r=>({id:r.id,status:r.status,generation:r.generation}))}):null;

/** Authority-bearing controller. Only the trusted host holds bind/revoke/user methods.
 * Model tools call modelCommand with exec.agent's actual object, not a supplied agent id.
 * No authority-bearing object is returned by view() or serialized into prompts.
 */
export class Controller {
  #store; #bindings = new WeakMap(); #live = new Map(); #capture; #serial = Promise.resolve();
  #validateWorkspace;
  #closing;#closed=false;
  #prepared=new WeakMap();
  constructor(store, { captureArtifact, validateWorkspace }) { this.#store = store; this.#capture = captureArtifact;this.#validateWorkspace=validateWorkspace; }
  bind(agent, binding) {
    ensure(!this.#closing && !this.#closed,'Controller is closing or closed');
    ensure(agent && typeof agent === 'object' && typeof agent.id === 'string', 'Need exact live DSH agent');
    ensure(allowed[binding.role], 'Unknown agent role');
    ensure(!this.#bindings.has(agent), 'Agent already bound');
    const p = this.view(binding.project);
    if(binding.role === 'reviewer') ensure(p.reviewers.some(r=>r.id===binding.reviewer), 'Reviewer is not in locked roster');
    const principal = Object.freeze({...structuredClone(binding),id:agent.id});
    ensure(!this.#live.has(agent.id), 'Agent identity already resident');
    this.#bindings.set(agent,principal); this.#live.set(agent.id,agent);
    return () => {this.#bindings.delete(agent); if(this.#live.get(agent.id)===agent)this.#live.delete(agent.id);};
  }
  identity(agent) {
    const principal = this.#bindings.get(agent);
    ensure(principal && this.#live.get(principal.id)===agent, 'Unregistered or stale agent identity');
    return principal;
  }
  view(project) {return projectView(readState(this.#store),project);}
  viewFor(agent) { return this.view(this.identity(agent).project); }
  #serialize(fn) {
    if(this.#closing || this.#closed)return Promise.reject(new Error('Controller is closing or closed'));
    const op = this.#serial.then(fn); this.#serial = op.catch(()=>{}); return op;
  }
  close() {
    if(this.#closing)return this.#closing;
    this.#closing=(async()=>{await this.#serial;this.#closed=true;this.#live.clear();this.#bindings=new WeakMap();})();
    return this.#closing;
  }
  async userCommand(command) {
    // Never bind this method to a model-facing tool or unauthenticated HTTP endpoint.
    const frozen=structuredClone(command);
    return this.#serialize(async()=>{
      if(frozen.type==='create' && this.#validateWorkspace)
        frozen.workspace=await this.#validateWorkspace(frozen.workspace,this.#store.snapshot().projects);
      return this.#store.dispatch({role:'user'},frozen);
    });
  }
  prepareUserCommand(raw) {
    const command=structuredClone(raw);
    return this.#serialize(async()=>{
      const state=this.#store.snapshot();
      if(command.type==='create' && this.#validateWorkspace)command.workspace=await this.#validateWorkspace(command.workspace,state.projects);
      transition(state,{role:'user'},command); // Validate before asking, without committing.
      const ticket=Object.freeze({command:structuredClone(command)});
      this.#prepared.set(ticket,{command,basis:approvalBasis(state.projects[command.project??command.id])});
      return ticket;
    });
  }
  confirmUserCommand(ticket,questionId,{authorize=()=>{},source='dsh-user-questions'}={}) {
    return this.#serialize(async()=>{
      authorize();
      const prepared=this.#prepared.get(ticket);ensure(prepared,'Unknown or consumed user confirmation');
      ensure(['dsh-user-questions','dsh-panel-operator'].includes(source),'Unknown human confirmation source');
      ensure(source!=='dsh-panel-operator' || ['archive','unarchive','delete-project'].includes(prepared.command.type),'Panel operator confirmation is limited to project archive, display restore and record deletion');
      this.#prepared.delete(ticket);
      const command=structuredClone(prepared.command),state=this.#store.snapshot();
      ensure(approvalBasis(state.projects[command.project??command.id])===prepared.basis,'Project changed while awaiting confirmation; review the updated proposal');
      if(command.type==='create' && this.#validateWorkspace) {
        const canonical=await this.#validateWorkspace(command.workspace,state.projects);
        ensure(canonical===command.workspace,'Workspace changed while awaiting confirmation; review the updated location');
      }
      authorize();
      ensure(typeof questionId==='string' && questionId.length>0,'Human confirmation reference required');
      command.userApproval={source,questionId};
      return this.#store.dispatch({role:'user'},command);
    });
  }
  executorFiles(agent, operation) {
    // The same queue orders state changes, file mutations and capture+review commit.
    // operation is a trusted host closure, never code supplied by a model.
    return this.#serialize(async()=>{
      const actor=this.identity(agent),p=this.view(actor.project),t=p.tasks[actor.task],m=p.milestones[t?.milestone];
      ensure(actor.role==='executor' && t?.status==='running' && t.assigned===actor.id,'No active task ownership');
      ensure((actor.taskAttempt??1)===(t.attempt??1),'Task attempt has expired');
      ensure(actor.configVersion===p.configVersion && t.configVersion===p.configVersion &&
        actor.planVersion===m?.planVersion && t.planVersion===m.planVersion,'Task version has expired');
      ensure(p.status==='running' && m.status==='work' && m.deps.every(id=>p.milestones[id].status==='passed'),'Task is not executable');
      if(this.#validateWorkspace)await this.#validateWorkspace(p.workspace,this.#store.snapshot().projects,p.id);
      return operation(p);
    });
  }
  projectTransaction(project,operation) {
    // Trusted host closure only. Shares the file/command barrier; never a tool.
    return this.#serialize(async()=>{
      const p=this.view(project);
      ensure(p && !['cancelled','delivered'].includes(p.status),'Project is closed or absent');
      if(this.#validateWorkspace)await this.#validateWorkspace(p.workspace,this.#store.snapshot().projects,p.id);
      return operation({project:p,store:this.#store,capture:()=>this.#capture(p)});
    });
  }
  modelCommand(agent, raw) {
    const command=structuredClone(raw);
    return this.#serialize(async()=>{
      const actor = this.identity(agent);
      const project=this.view(actor.project);
      ensure(project.deleted!==true,'Project record is deleted');
      ensure(project.archived!==true,'Project is archived; restore its display first');
      if(actor.configVersion!==undefined)ensure(actor.configVersion===project.configVersion,'Agent configuration has expired');
      if(actor.role==='executor' && actor.task!==undefined)ensure(command.task===actor.task,'Executor is bound to another task');
      if(actor.role==='reviewer' && actor.round!==undefined) {
        const round=project.rounds[actor.round];
        ensure(command.round===actor.round && command.generation===actor.generation && round?.generation===actor.generation &&
          actor.attempt===(round.attempts[actor.reviewer]??0)+1,'Review assignment has expired');
      }
      ensure(allowed[actor.role].has(command.type), 'This role cannot issue that command');
      ensure(command.project===undefined || command.project===actor.project, 'Cross-project command');
      ensure(!['actor','role','agentId','reviewer','artifact','userApproval'].some(k=>Object.hasOwn(command,k)), 'Authority or artifact fields cannot be supplied by a model');
      command.project=actor.project;
      if(['submit','final'].includes(command.type)) {
        if(this.#validateWorkspace)await this.#validateWorkspace(project.workspace,this.#store.snapshot().projects,project.id);
        // Trusted driver captures an immutable artifact; model-provided hashes are never accepted.
        command.artifact=await this.#capture(this.view(actor.project),command.milestone ?? null);
      }
      if(command.type==='complete') {
        const task=project.tasks[command.task];
        if(task?.status==='running' && project.completions+1>=project.nextPatrol)
          {
            if(this.#validateWorkspace)await this.#validateWorkspace(project.workspace,this.#store.snapshot().projects,project.id);
            command.artifact=await this.#capture(project,null);
          }
      }
      await this.#store.dispatch(actor,command);
      return this.view(actor.project);
    });
  }
  assign(coordinator, worker, task) {
    return this.#serialize(async()=>{
      const a=this.identity(coordinator), b=this.identity(worker);
      ensure(a.role==='coordinator' && b.role==='executor' && a.project===b.project, 'Invalid delegation');
      const p=this.view(a.project);
      ensure((a.configVersion===undefined || a.configVersion===p.configVersion) && (b.configVersion===undefined || b.configVersion===p.configVersion),'Delegation configuration has expired');
      ensure(b.task===undefined || b.task===task,'Executor is bound to another task');
      ensure((b.taskAttempt??1)===(p.tasks[task]?.attempt??1),'Delegation attempt has expired');
      await this.#store.dispatch(a,{type:'assign',project:a.project,task,agentId:b.id});
    });
  }
  reviewFault(agent, {round,generation,attempt,error}) {
    return this.#serialize(async()=>{
      const actor=this.identity(agent);ensure(actor.role==='reviewer','Reviewer required');
      await this.#store.dispatch(actor,{type:'review-fault',project:actor.project,round,generation,attempt,error});
    });
  }
  reviewFaultIfCurrent(agent, {round,generation,attempt,error}) {
    return this.#serialize(async()=>{
      const actor=this.identity(agent);ensure(actor.role==='reviewer','Reviewer required');
      const p=this.view(actor.project),r=p.rounds[round];
      if(!r || !['running','final-review'].includes(p.status) || r.status!=='open' || r.votes[actor.reviewer] ||
        p.configVersion!==actor.configVersion || actor.round!==round || actor.generation!==generation || actor.attempt!==attempt ||
        r.generation!==generation || (r.attempts[actor.reviewer]??0)+1!==attempt)return false;
      await this.#store.dispatch(actor,{type:'review-fault',project:actor.project,round,generation,attempt,error});return true;
    });
  }
  async executionFaultIfCurrent(agent,{task,taskAttempt,error},stop) {
    const actor=this.identity(agent);ensure(actor.role==='executor' && actor.task===task,'Executor task required');
    // Stop outside the command queue: disposal may need to drain an in-flight tool.
    // The driver revokes identity first. Failed tasks become retryable only after drain.
    await stop();
    return this.#serialize(async()=>{
      const p=this.view(actor.project),t=p.tasks[task];
      if(p.status!=='running' || !t || t.status!=='running' || t.assigned!==actor.id ||
        (t.attempt??1)!==taskAttempt || (actor.taskAttempt??1)!==taskAttempt || t.configVersion!==p.configVersion || actor.configVersion!==p.configVersion ||
        t.planVersion!==p.milestones[t.milestone].planVersion)return false;
      await this.#store.dispatch(actor,{type:'task-fault',project:actor.project,task,taskAttempt,error});return true;
    });
  }
}

/** Uses DSH's real agent lifecycle, with composition delegated to an audited host callback.
 * The caller owns the plugin context. It must not be the execution coordinator's context:
 * that would grant lifecycle ownership over supervisors to an execution agent.
 */
export class DshAgentDriver {
  #ctx; #controller; #compose; #handles=new Map(); #closed=false;#abort=new AbortController();#creating=new Set();#disposing=new Map();#closing;
  constructor(hostContext, controller, {compose}) {
    let scoped;try{scoped=hostContext.agent;}catch{}
    ensure(!scoped, 'Supervisor owner must be a host context');
    this.#ctx=hostContext;this.#controller=controller;this.#compose=compose;
  }
  create(binding,options={}) {
    const operation=this.#create(binding,options);this.#creating.add(operation);
    void operation.then(()=>this.#creating.delete(operation),()=>this.#creating.delete(operation));return operation;
  }
  async #create(binding, {cwd,model,persistedSessionId,sessionId=randomUUID(),sessionMeta}={}) {
    ensure(!this.#closed,'Driver closed');
    ensure(sessionMeta===undefined || sessionMeta && typeof sessionMeta==='object' && !Array.isArray(sessionMeta) &&
      Object.keys(sessionMeta).length===1 && sessionMeta.origin==='subagent','Only internal-session classification metadata is allowed');
    let revoke;
    const setup=async (agentCtx,agent=agentCtx.agent)=>{
      await this.#compose(agentCtx,binding,agent);
      return {commit:()=>{revoke=this.#controller.bind(agent,binding);}};
    };
    let handle;
    try {
      handle=persistedSessionId
        ? await this.#ctx.agents.resume({resumeSessionId:persistedSessionId,agentOptions:model,setup,signal:this.#abort.signal})
        : await this.#ctx.agents.create({sessionId,meta:{...sessionMeta,cwd},agentOptions:model,setup,signal:this.#abort.signal});
      if(this.#closed) {await handle.dispose();revoke?.();throw new Error('Driver closed during creation');}
      this.#handles.set(handle.agent,{handle,revoke});return handle.agent;
    } catch(e) {revoke?.();throw e;}
  }
  async checkpoint(agent) {
    ensure(this.#handles.has(agent) && !this.#closed,'Driver does not own agent');
    ensure(await this.#ctx.sessions.flush(agent.session),'New session could not be durably flushed');
    // Empty sessions may materialize in rc.2. A flushed empty history is still
    // not a delivered message; the first inbox insertion proves delivery.
    const events=sessionEvents(agent.session);
    if(events.length===0)return false;
    const stored=await readStoredSession(this.#ctx.sessionPersistence,agent.id);
    ensure(stored.meta.id===agent.id && stored.events.length===events.length &&
      stored.events.every((e,i)=>e.seq===i && JSON.stringify(e)===JSON.stringify(events[i])), 'New session persistence does not match live history');
    return true;
  }
  async send(agent, {id,text}) {
    ensure(this.#handles.has(agent) && !this.#closed,'Driver does not own agent');
    // Stable command id is supplied by durable scheduler. The core treats duplicate results separately.
    agent.followup({id,role:'user',content:[{type:'text',text}],source:{kind:'plugin:dsh-foreman-next'}});
    const flushed=await this.#ctx.sessions.flush(agent.session);
    ensure(flushed,'No DSH session persistence listener; refuse to claim durable delivery');
    ensure(sessionEvents(agent.session).some(e=>e.type==='agent/inbox/spliced' && e.data.inserted?.some(m=>m.id===id)), 'No recorded DSH inbox insertion');
  }
  dispose(agent) {
    if(this.#disposing.has(agent))return this.#disposing.get(agent);
    const owned=this.#handles.get(agent);if(!owned)return;
    this.#handles.delete(agent);
    owned.revoke?.();
    const operation=Promise.resolve().then(()=>owned.handle.dispose());this.#disposing.set(agent,operation);
    void operation.then(()=>this.#disposing.delete(agent),()=>this.#disposing.delete(agent));return operation;
  }
  close() {
    if(this.#closing)return this.#closing;
    this.#closed=true;
    this.#abort.abort(new Error('Foreman agent driver is closing'));
    this.#closing=(async()=>{
      for(const agent of [...this.#handles.keys()])this.dispose(agent);
      const results=await Promise.allSettled([...this.#disposing.values()]);
      await Promise.allSettled([...this.#creating]);
      const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);
      if(errors.length)throw new AggregateError(errors,'Failed to dispose DSH agents');
    })();return this.#closing;
  }
}
