import {readState} from './state-reader.mjs';
import {createHash} from 'node:crypto';

export const EXECUTION_PROTOCOL='foreman-execution-v1';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const active=p=>p?.status==='running' && !p.paused;
const ready=(p,m)=>m?.status==='work' && m.deps.every(id=>p.milestones[id]?.status==='passed');

/** Tasks are assigned through Controller.assign after a real executor is created.
 * This function only proposes candidates, it cannot grant an identity or start a model.
 */
export function pendingAssignments(state) {
  return Object.values(state.projects).flatMap(p=>!active(p)?[]:Object.values(p.tasks)
    .filter(t=>t.status==='pending' && ready(p,p.milestones[t.milestone]) &&
      t.planVersion===p.milestones[t.milestone].planVersion && t.configVersion===p.configVersion)
    .map(t=>({project:p.id,task:t.id,milestone:t.milestone,planVersion:t.planVersion,configVersion:t.configVersion,taskAttempt:t.attempt??1})));
}

export function executionEligibility(state,job) {
  const s=job.subject;if(s?.protocol!==EXECUTION_PROTOCOL)return 'unmanaged';
  const p=state.projects[job.project],t=p?.tasks[s.task],m=p?.milestones[s.milestone];
  if(p?.paused)return 'blocked';
  if(!active(p)||!t||!m||t.status!=='running'||t.assigned!==job.recipient||t.milestone!==s.milestone)return 'stale';
  if(p.configVersion!==s.configVersion||m.planVersion!==s.planVersion||t.configVersion!==s.configVersion||t.planVersion!==s.planVersion)return 'stale';
  if((t.attempt??1)!==(s.taskAttempt??1))return 'stale';
  return ready(p,m)?'ready':'blocked';
}

export function planExecutionDeliveries(state) {
  const result=[];
  for(const p of Object.values(state.projects))for(const t of Object.values(p.tasks)) {
    if(t.status!=='running'||!t.assigned)continue;
    const subject={kind:'task',protocol:EXECUTION_PROTOCOL,task:t.id,milestone:t.milestone,planVersion:t.planVersion,configVersion:t.configVersion,taskAttempt:t.attempt??1};
    const id='task:'+hash({project:p.id,recipient:t.assigned,subject});
    const job={type:'enqueue',id,project:p.id,recipient:t.assigned,messageId:id,subject,
      text:`执行项目 ${p.id} 的任务 ${t.id}，所属里程碑 ${t.milestone}。通过受限任务工具读取任务和当前授权后实施。提交完成结果与验证证据；不得修改监督规则、代签或自行交付。如依赖或授权已失效，停止相关任务并反馈执行负责人。`};
    if(executionEligibility(state,job)==='ready')result.push(job);
  }
  return result;
}

export async function syncExecutionQueue(store) {
  for(const job of Object.values(readState(store).outbox??{}))
    if(job.status==='queued' && executionEligibility(readState(store),job)==='stale')
      await store.dispatchOutbox({type:'cancel',id:job.id});
  for(const job of planExecutionDeliveries(readState(store)))await store.dispatchOutbox(job);
}
