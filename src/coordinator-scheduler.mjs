import {readState} from './state-reader.mjs';
import {createHash} from 'node:crypto';
export const COORDINATOR_PROTOCOL='foreman-coordinator-v1';
export const coordinatorKey=p=>`coordinator:${p.id}:${p.configVersion}`+(p.controlVersion?`:control:${p.controlVersion}`:'');
const signal=p=>createHash('sha256').update(JSON.stringify({
  config:p.configVersion,
  ...(p.coordinatorWake?{userWake:p.coordinatorWake}:{}),
  ...(p.dependencyWake?{dependencyWake:p.dependencyWake}:{}),
  tasks:Object.values(p.tasks).filter(t=>['completed','failed'].includes(t.status)).map(t=>[t.id,t.status,t.attempt??1]),
  reviews:Object.values(p.rounds).filter(r=>['closed','faulted','stale'].includes(r.status)).map(r=>[r.id,r.status,r.generation]),
  milestones:Object.values(p.milestones).filter(m=>['paused','cancelled'].includes(m.status)).map(m=>[m.id,m.status,m.limit]),
})).digest('hex');

export function coordinatorEligibility(state,job) {
  if(job.subject?.protocol!==COORDINATOR_PROTOCOL)return 'unmanaged';
  const p=state.projects[job.project];
  if(p?.paused)return 'blocked';
  return p?.status==='running' && job.subject.signal===signal(p)?'ready':'stale';
}
export async function syncCoordinatorQueue(store) {
  for(const j of Object.values(readState(store).outbox??{}))if(j.status==='queued' && coordinatorEligibility(readState(store),j)==='stale')
    await store.dispatchOutbox({type:'cancel',id:j.id});
  for(const p of Object.values(readState(store).projects))if(!p.paused && p.status==='running') {
    const subject={kind:'coordinator',protocol:COORDINATOR_PROTOCOL,signal:signal(p),configVersion:p.configVersion};
    const id=`coordinator:${p.id}:${subject.signal}`;
    if(readState(store).outbox?.[id])continue;
    subject.auditStart=p.audit.length;
    await store.dispatchOutbox({type:'enqueue',id,project:p.id,recipient:coordinatorKey(p),messageId:id,subject,
      text:`你是项目 ${p.id} 的执行负责人。读取当前项目及监督意见，规划、分解任务或安排返工；独立且获批的里程碑继续推进。只通过受限工具提交计划、任务和验收申请。监督规则由用户锁定。没有可执行动作则结束本回合等待宿主唤醒，不重复读状态轮询，不提前提交尚未完成的任务。保留状态基线时可用 foreman_read 的 sinceCursor 只取变化；丢失基线或上下文压缩后用 {} 重新取全量。已完成任务或已关闭审查的全文仅在需要时用 foreman_detail 读取。日常进度不向用户推送；权限或重大问题通过规定通道上报。${p.coordinatorRecovery?'\n最近一次用户确认的恢复说明：'+p.coordinatorRecovery.reason:''}`});
  }
}
