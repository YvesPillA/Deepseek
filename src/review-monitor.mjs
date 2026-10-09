import {readState} from './state-reader.mjs';
import {sessionEvents} from './stored-session.mjs';
import {reviewEligibility} from './review-scheduler.mjs';

/** Account for this exact message, not an unrelated/old turn end. DSH records
 * normalized inbox splices; cancellation and turn consumption are distinct.
 */
export function reviewRunEvidence(events,messageId) {
  const queues={'next-turn':[],'next-step':[]};let open=null,claimed=null,outcome='unknown';
  for(const e of events) {
    if(e.type==='turn/start')open=e.data.turn;
    if(e.type==='agent/inbox/spliced') {
      const {target,start,removedCount=0,inserted,outcome:reason}=e.data;
      const queue=queues[target];
      if(!queue || !Array.isArray(inserted) || !Number.isInteger(start) || !Number.isInteger(removedCount) || start<0 || start>queue.length || removedCount<0 || removedCount>queue.length-start)return {outcome:'unknown',turn:null};
      const removed=queue.splice(start,removedCount,...inserted.map(m=>m.id));
      if(inserted.some(m=>m.id===messageId))outcome='pending';
      if(removed.includes(messageId)) {
        if(reason==='canceled')outcome='dropped';
        else if(open!==null){claimed=open;outcome='running';}
        else outcome='unknown';
      }
    }
    if(e.type==='turn/end') {
      if(claimed!==null && e.data.turn===claimed)outcome='ended';
      if(e.data.turn===open)open=null;
    }
  }
  return {outcome,turn:claimed};
}
export function reviewRunOutcome(events,messageId) {return reviewRunEvidence(events,messageId).outcome;}

/** Explicit poll, using persisted deadlines and host-bound reviewer identity.
 * Uncertain delivery is never timed out into a second send.
 */
export class ReviewMonitor {
  #store;#controller;#lookup;#retire;#now;#timeout;
  constructor(store,controller,{lookup,retire,now=Date.now,timeoutMs=600000}) {
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>86400000)throw new Error('Invalid review timeout');
    this.#store=store;this.#controller=controller;this.#lookup=lookup;this.#retire=retire;this.#now=now;this.#timeout=timeoutMs;
  }
  async poll() {
    for(const job of Object.values(readState(this.#store).outbox??{})) {
      if(job.status!=='delivered' || reviewEligibility(readState(this.#store),job)!=='ready')continue;
      await this.#store.dispatchRuntime({type:'watch-review',id:job.id,now:this.#now(),timeoutMs:this.#timeout});
      const agent=this.#lookup(job);if(!agent)continue;
      const watch=readState(this.#store).reviewWatches[job.id];
      const outcome=reviewRunOutcome(sessionEvents(agent.session),job.messageId);
      const ended=agent.status==='idle' && ['ended','dropped'].includes(outcome);
      if(!ended && this.#now()<watch.deadline)continue;
      const s=job.subject;
      const failed=await this.#controller.reviewFaultIfCurrent(agent,{round:s.round,generation:s.generation,attempt:s.attempt,
        error:ended?'监督回合结束但未提交有效结论。':'监督审查超过宿主设定时限。'});
      // Record the failure first to invalidate late votes, then drain before retry.
      if(failed)await this.#retire(job,agent);
    }
  }
}
