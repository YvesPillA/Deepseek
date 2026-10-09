import {readState} from './state-reader.mjs';
import { createHash, randomUUID } from 'node:crypto';
import {deliveryEligibility} from './delivery-policy.mjs';

const assert = (ok,message) => { if(!ok)throw new Error(message); };
const nonempty = value => typeof value==='string' && value.length>0 && value.length<=20000;
const own = (o,k) => Object.hasOwn(o,k);

/** Trusted-host-only durable delivery transitions. Delivery != task completion or approval.
 * Sending is preceded by a synced claim. A crash/transport error makes outcome uncertain;
 * retries require positive evidence of non-delivery, not an elapsed timeout.
 */
export function outboxTransition(previous,command) {
  const state=structuredClone(previous);state.outbox ??= {};
  const box=state.outbox;
  assert(nonempty(command.id) && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,200}$/.test(command.id),'Invalid delivery id');
  if(command.type==='enqueue') {
    const {id,project,recipient,messageId,text,subject}=command;
    assert(own(state.projects,project),'Unknown delivery project');
    assert(nonempty(recipient)&&nonempty(messageId)&&nonempty(text),'Invalid delivery envelope');
    assert(subject && ['review','task','coordinator','notification'].includes(subject.kind),'Invalid delivery subject');
    const envelope={id,project,recipient,messageId,text,subject:structuredClone(subject)};
    const fingerprint=createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
    if(own(box,id)) {
      assert(box[id].fingerprint===fingerprint,'Delivery id already has different content');
      return previous;
    }
    box[id]={...envelope,fingerprint,status:'queued',attempt:0,token:null,owner:null,reason:null};
  } else {
    assert(own(box,command.id),'Unknown delivery');const job=box[command.id];
    if(command.type==='claim') {
      assert(job.status==='queued','Delivery is not queued');
      const eligibility=deliveryEligibility(state,job);
      if(!['ready','unmanaged'].includes(eligibility)) {
        const error=new Error(`Delivery is ${eligibility}`);error.code='DELIVERY_NOT_ELIGIBLE';throw error;
      }
      assert(!['cancelled','delivered'].includes(state.projects[job.project].status),'Project is closed');
      assert(nonempty(command.owner),'Worker owner required');
      job.attempt++;job.token=randomUUID();job.owner=command.owner;job.status='sending';job.reason=null;
    } else if(command.type==='recover') {
      // Called only after exclusive store ownership has been acquired by the new host.
      if(job.status!=='sending')return previous;
      job.status='uncertain';job.reason='Host stopped before delivery acknowledgement was recorded';
    } else if(command.type==='cancel') {
      assert(job.status==='queued','Active delivery must be reconciled/quiesced before cancellation');
      job.status='cancelled';
    } else {
      assert(nonempty(command.token)&&command.token===job.token,'Stale delivery token');
      if(command.type==='ack') {
        if(job.status==='delivered')return previous;
        assert(job.status==='sending','Delivery is not sending');job.status='delivered';
      } else if(command.type==='uncertain') {
        if(job.status==='uncertain')return previous;
        assert(job.status==='sending','Delivery is not sending');
        job.status='uncertain';job.reason=String(command.reason??'Unknown transport outcome').slice(0,20000);
      } else if(command.type==='reconcile') {
        assert(job.status==='uncertain','Delivery does not need reconciliation');
        assert(['present','absent','unknown'].includes(command.evidence),'Invalid delivery evidence');
        if(command.evidence==='present')job.status='delivered';
        if(command.evidence==='absent'){job.status='queued';job.token=null;job.owner=null;}
        if(command.evidence==='unknown')return previous;
        job.reason=null;
      } else if(command.type==='complete') {
        if(job.status==='completed')return previous;
        assert(job.status==='delivered','Only delivered jobs can complete');
        job.status='completed';
      } else throw new Error('Unknown outbox command');
    }
  }
  state.revision++;
  return state;
}

/** Delivery pump for an audited transport. No timers and no LLM calls of its own.
 * Port.probe must return absent ONLY after definitive durable non-delivery evidence.
 * A missing session, network failure, or unflushed log is unknown, never absent.
 */
export class DeliveryPump {
  #store;#port;#owner=randomUUID();#busy=false;#closed=false;#active;
  constructor(store,port){this.#store=store;this.#port=port;}
  async recover() {
    assert(!this.#busy,'Cannot recover while a pump is active');
    for(const job of Object.values(readState(this.#store).outbox??{}))
      if(job.status==='sending')await this.#store.dispatchOutbox({type:'recover',id:job.id});
  }
  async drain({limit=2}={}) {
    assert(Number.isSafeInteger(limit)&&limit>0&&limit<=20,'Invalid delivery batch size');
    if(this.#busy||this.#closed)return;
    this.#busy=true;
    this.#active=(async()=>{
      // Delivered jobs remain available to runtime recovery and monitors. They
      // need no pump action, so do not clone the full journal for each old receipt.
      const candidates=Object.values(readState(this.#store).outbox??{}).filter(j=>['queued','uncertain'].includes(j.status));
      let sent=0;
      for(const item of candidates) {
        if(this.#closed)break;
        const current=readState(this.#store);
        let job=current.outbox[item.id];
        if(!['queued','uncertain'].includes(job.status))continue;
        const eligibility=deliveryEligibility(current,job);
        if(eligibility==='stale' && job.status==='queued') {
          await this.#store.dispatchOutbox({type:'cancel',id:job.id});continue;
        }
        if(eligibility==='blocked')continue;
        const p=current.projects[job.project];
        if(['cancelled','delivered'].includes(p.status)) {
          if(job.status==='queued')await this.#store.dispatchOutbox({type:'cancel',id:job.id});
          continue; // Active agents require an explicit host cancellation/drain, not a fabricated receipt.
        }
        if(job.status==='uncertain') {
          let evidence='unknown';
          try {evidence=await this.#port.probe(structuredClone(job));} catch { /* stay uncertain */ }
          await this.#store.dispatchOutbox({type:'reconcile',id:job.id,token:job.token,evidence});
          job=readState(this.#store).outbox[item.id];
        }
        if(job.status!=='queued'||sent>=limit)continue;
        // Queue eligibility must also be checked by the host at execution time (dependencies, revisions).
        if(this.#port.eligible && !await this.#port.eligible(structuredClone(job)))continue;
        let state;
        try {state=await this.#store.dispatchOutbox({type:'claim',id:job.id,owner:this.#owner});}
        catch(e){if(e.code==='DELIVERY_NOT_ELIGIBLE')continue;throw e;}
        job=state.outbox[job.id];sent++;
        try {
          await this.#port.deliver(structuredClone(job));
          await this.#store.dispatchOutbox({type:'ack',id:job.id,token:job.token});
        } catch(e) {
          // Includes a failed acknowledgement fsync after successful transport.
          await this.#store.dispatchOutbox({type:'uncertain',id:job.id,token:job.token,reason:e.message});
        }
      }
    })();
    try {await this.#active;} finally {this.#busy=false;this.#active=null;}
  }
  async close(){this.#closed=true;await this.#active;}
}
