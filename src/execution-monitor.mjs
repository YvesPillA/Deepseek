import {readState} from './state-reader.mjs';
import {executionEligibility} from './execution-scheduler.mjs';
import {reviewRunEvidence} from './review-monitor.mjs';
import {sessionEvents} from './stored-session.mjs';

/** Detect missing results and optional host-configured wall-clock deadlines.
 * Stop and drain before reporting failure; only the coordinator can retry.
 */
export class ExecutionMonitor {
  #store;#controller;#lookup;#retire;#now;#timeout;
  constructor(store,controller,{lookup,retire,now=Date.now,timeoutMs=null}) {
    if(timeoutMs!==null && (!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>86400000))throw new Error('Invalid execution timeout');
    this.#store=store;this.#controller=controller;this.#lookup=lookup;this.#retire=retire;
    this.#now=now;this.#timeout=timeoutMs;
  }
  async poll() {
    for(const job of Object.values(readState(this.#store).outbox??{})) {
      if(job.status!=='delivered' || executionEligibility(readState(this.#store),job)!=='ready')continue;
      if(this.#timeout!==null)await this.#store.dispatchRuntime({type:'watch-execution',id:job.id,now:this.#now(),timeoutMs:this.#timeout});
      const watch=readState(this.#store).executionWatches?.[job.id];
      const agent=this.#lookup(job);
      if(!agent)continue;
      const events=sessionEvents(agent.session),run=reviewRunEvidence(events,job.messageId);
      const ended=agent.status==='idle' && ['ended','dropped'].includes(run.outcome);
      if(!ended && (!watch || this.#now()<watch.deadline))continue;
      // Repaired tool results describe uncertainty, not task completion or permission
      // to repeat a task. Preserve only this message's claimed turn for its owner.
      const recovery=ended && run.outcome==='ended' && run.turn!==null?events.filter(e=>e.type==='tool/result' && e.data.turn===run.turn &&
        ['TOOL_OUTCOME_UNKNOWN','TOOL_NOT_STARTED'].includes(e.data.error?.code)):[];
      const detail=recovery.length?'\n本回合工具恢复记录：'+recovery.slice(0,10).map(e=>
        `${e.data.error.code}（callId=${String(e.data.message?.source?.callId??'unknown').slice(0,200)}）`).join('；')+
        '。TOOL_OUTCOME_UNKNOWN 不能证明未产生副作用，须先核查现有文件或外部状态；TOOL_NOT_STARTED 只证明该工具调用未开始，不能据此重跑整个任务。':'';
      await this.#controller.executionFaultIfCurrent(agent,{task:job.subject.task,taskAttempt:job.subject.taskAttempt??1,error:ended?
        '执行回合结束但未提交任务完成结果，请执行负责人检查现有文件后安排恢复。'+detail:
        '执行任务超过宿主设定时限，已停止该执行代理；请执行负责人检查保留的文件后决定是否重试。'},()=>this.#retire(job,agent));
    }
  }
}
