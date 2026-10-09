import {randomUUID} from 'node:crypto';
import {deliveryEligibility} from './delivery-policy.mjs';
import {readStoredSession,isMissingStoredSession} from './stored-session.mjs';
const check=(ok,message)=>{if(!ok)throw Error(message);};
export async function assertEmptySession(persistence,id,signal) {
  let stored;try{stored=await readStoredSession(persistence,id,{signal});}
  catch(e){if(isMissingStoredSession(e,id))return;throw e;}
  check(stored?.meta?.id===id&&Array.isArray(stored.events)&&stored.events.length===0,'Persisted session content exists; use normal recovery');
}
export function recoveryTarget(state,project,notification) {
  const p=state.projects[project];check(p && ['running','final-review'].includes(p.status),'Project is not active');
  const entry=Object.entries(state.runtimeIncidents??{}).find(([key,v])=>key.startsWith(project+':agent:')&&v.notificationId===notification&&v.message!==null);
  check(entry && p.notifications.some(n=>n.id===notification&&!n.resolved),'No active session recovery incident');
  const key=entry[0].slice((project+':agent:').length),record=state.runtimeAgents?.[key];
  check(record && record.binding.project===project && record.binding.configVersion===p.configVersion && record.phase==='starting','Only an uncheckpointed current session can be replaced');
  const b=record.binding;
  if(b.role==='executor') {const t=p.tasks[b.task],m=p.milestones[t?.milestone];check(t && ['pending','running'].includes(t.status)&&t.configVersion===b.configVersion&&m?.planVersion===b.planVersion&&(t.attempt??1)===(b.taskAttempt??1),'Task changed');}
  if(b.role==='reviewer'){const r=p.rounds[b.round];check(r?.status==='open'&&r.generation===b.generation&&!Object.hasOwn(r.votes,b.reviewer)&&(r.attempts[b.reviewer]??0)+1===b.attempt,'Review changed');}
  check(!p.audit.some(a=>a.actorId===record.sessionId),'Session has recorded project actions; use normal recovery');
  const jobs=Object.values(state.outbox??{}).filter(j=>b.role==='reviewer'?j.id===key:b.role==='coordinator'?j.recipient===key:j.recipient===record.sessionId);
  check(jobs.every(j=>['queued','uncertain','sending','cancelled'].includes(j.status)),'Session already has confirmed delivery');
  check(jobs.filter(j=>j.status!=='cancelled').every(j=>deliveryEligibility(state,j)!=='stale'),'Delivery authorization changed');
  return {key,record,jobs,notification};
}
export function replaceEmptySession(previous,command) {
  const target=recoveryTarget(previous,command.project,command.notification);
  check(JSON.stringify(target)===command.basis,'Session recovery state changed');
  check(/^foreman-confirm-[a-f0-9-]{36}$/.test(command.confirmation??''),'Native recovery confirmation required');
  check(/^[a-f0-9-]{36}$/.test(command.sessionId??'')&&!Object.values(previous.runtimeAgents).some(a=>a.sessionId===command.sessionId),'Fresh session identity required');
  const state=structuredClone(previous),record=state.runtimeAgents[target.key],oldId=record.sessionId;
  state.sessionRecoveries??=[];state.sessionRecoveries.push({project:command.project,notification:command.notification,confirmation:command.confirmation,old:structuredClone(target),replacement:command.sessionId});
  record.sessionId=command.sessionId;record.phase='reserved';
  for(const j of target.jobs)if(j.status!=='cancelled') {
    const job=state.outbox[j.id];
    // This is a user-authorized replacement, never fabricated non-delivery evidence.
    if(record.binding.role==='executor')job.status='cancelled';
    else Object.assign(job,{status:'queued',token:null,owner:null,reason:null});
  }
  if(record.binding.role==='executor') {const t=state.projects[command.project].tasks[record.binding.task];if(t.assigned===oldId)t.assigned=command.sessionId;}
  const incident=state.runtimeIncidents[command.project+':agent:'+target.key];incident.message=null;
  const n=state.projects[command.project].notifications.find(n=>n.id===command.notification);n.resolved=true;n.acknowledged=true;
  state.revision++;return state;
}

// All dependencies are host capabilities. Never expose this object to a model.
export class SessionRecovery {
  #controller;#store;#maintenance;#ctx;#tickets=new WeakMap();
  constructor({controller,store,maintenance,context}){this.#controller=controller;this.#store=store;this.#maintenance=maintenance;this.#ctx=context;}
  async #empty(id,signal) {
    return assertEmptySession(this.#ctx().sessionPersistence,id,signal);
  }
  async prepare(command) {
    check(command?.type==='recover-empty-session'&&Object.keys(command).every(k=>['type','project','notification'].includes(k)),'Invalid recovery request');
    const target=recoveryTarget(this.#store.snapshot(),command.project,command.notification);
    await this.#empty(target.record.sessionId);
    const ticket=Object.freeze({command:structuredClone(command),detail:`项目：${this.#controller.view(command.project).objective}\n角色：${target.record.binding.role}\n${target.record.binding.task?'任务：'+target.record.binding.task+'\n':''}当前没有可恢复的持久会话内容。缺少日志不能证明旧消息从未执行。确认后短暂停止并排空工头代理，撤销旧身份，以新会话接替；保留工作文件、监督规则、否决次数和故障历史。已有文件可能包含未记录的修改，新代理必须先检查现状再继续。此操作不是批准成品或重置验收。`});
    this.#tickets.set(ticket,{...command,sessionId:target.record.sessionId,basis:JSON.stringify(target)});return ticket;
  }
  async confirm(ticket,confirmation,{authorize,signal}) {
    authorize();const saved=this.#tickets.get(ticket);check(saved,'Unknown or consumed session recovery confirmation');this.#tickets.delete(ticket);
    return this.#maintenance(()=>this.#controller.projectTransaction(saved.project,async()=>{
      authorize();signal?.throwIfAborted();
      check(!this.#ctx().agents.get(saved.sessionId),'Old session is still resident');
      await this.#empty(saved.sessionId,signal);authorize();
      const result=await this.#store.dispatchRuntime({type:'replace-empty-session',project:saved.project,notification:saved.notification,basis:saved.basis,sessionId:randomUUID(),confirmation});
      return {replaced:true,project:saved.project,revision:result.revision};
    }));
  }
}
