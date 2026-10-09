import {readState} from './state-reader.mjs';
import {deliveryEligibility} from './delivery-policy.mjs';
import {readStoredSession,sessionEvents} from './stored-session.mjs';

const ownedSource=source=>source?.kind==='plugin:dsh-foreman-next' ||
  (source?.kind==='plugin' && source.plugin==='dsh-foreman-next' && Object.keys(source).length===2);
const matches=(message,job)=>message.id===job.messageId && message.role==='user' &&
  ownedSource(message.source) &&
  message.content?.length===1 && message.content[0].type==='text' && message.content[0].text===job.text;

/** Inspect the append-only inbox history, not the current queue or compacted chat.
 * Consumption/cancellation removes pending input but never erases its delivery.
 */
export function receiptEvidence(events,job) {
  let found=false;
  for(const event of events) {
    if(event.type!=='agent/inbox/spliced')continue;
    for(const message of event.data.inserted??[])if(message.id===job.messageId) {
      if(!matches(message,job))throw new Error('DSH delivery identity has conflicting content');
      found=true;
    }
  }
  return found?'present':'unknown';
}

/** Host-only bridge. resolve creates/resumes a host-owned agent; lookup never creates.
 * The read handle exposes the persistence log view. Flush is the durability
 * barrier; reading an unflushed live snapshot cannot prove a durable receipt.
 */
export class DshTransport {
  #store;#driver;#ctx;#resolve;#lookup;
  constructor(store,driver,ctx,{resolve,lookup}) {
    this.#store=store;this.#driver=driver;this.#ctx=ctx;this.#resolve=resolve;this.#lookup=lookup;
  }
  eligible(job) {return deliveryEligibility(readState(this.#store),job)==='ready';}
  async deliver(job) {
    if(!this.eligible(job))throw new Error('DSH delivery authorization expired');
    const agent=await this.#resolve(job);
    if(!this.eligible(job))throw new Error('DSH delivery authorization expired during agent creation');
    const recorded=receiptEvidence(sessionEvents(agent.session),job);
    if(recorded==='present') {
      if(!await this.#ctx.sessions.flush(agent.session))throw new Error('No durable session flush');
    } else await this.#driver.send(agent,{id:job.messageId,text:job.text});
    // Flush listeners alone are insufficient: verify this exact envelope in storage.
    const stored=await readStoredSession(this.#ctx.sessionPersistence,agent.id);
    if(stored.meta.id!==agent.id || receiptEvidence(stored.events,job)!=='present')throw new Error('DSH receipt is not durable');
  }
  async probe(job) {
    const target=this.#lookup(job);
    if(!target)return 'unknown';
    // A live buffered insertion may exist after a failed flush. Persist before probing.
    if(target.agent && !await this.#ctx.sessions.flush(target.agent.session))return 'unknown';
    const stored=await readStoredSession(this.#ctx.sessionPersistence,target.sessionId);
    if(stored.meta.id!==target.sessionId)return 'unknown';
    const evidence=receiptEvidence(stored.events,job);
    if(evidence==='present')return evidence;
    // Cold/missing/truncated history cannot prove absence. A live owned session,
    // fully flushed and matching the entire stored prefix, can.
    const live=target.agent?sessionEvents(target.agent.session):undefined;
    if(live && stored.events.length===live.length && stored.events.every((e,i)=>e.seq===i && JSON.stringify(e)===JSON.stringify(live[i])))return 'absent';
    return 'unknown';
  }
}
