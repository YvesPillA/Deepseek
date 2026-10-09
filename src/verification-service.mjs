import {validateVerificationCommand,verificationInput} from './container-verifier.mjs';
import {verificationRecorder} from './verification-ledger.mjs';
import {DependencyApprovalRequired} from './project-verifier.mjs';
import {profileFromFiles} from './dependency-profile.mjs';

/** Host-owned verification capability. Capture under the file barrier, run only
 * the detached snapshot outside that barrier, then re-authorize the result. */
export class VerificationService {
  #controller;#store;#files;#artifacts;#backend;#active=new Set();#closed=false;#closing;
  constructor({controller,store,files,artifacts,backend}) {
    this.#controller=controller;this.#store=store;this.#files=files;this.#artifacts=artifacts;this.#backend=backend;
  }
  get kind(){return this.#backend.kind==='native'?'native':'docker';}
  run(agent,raw,signal) {
    if(this.#closed)return Promise.reject(new Error('Verification service is closed'));
    const op=this.#run(agent,raw,signal);this.#active.add(op);
    void op.then(()=>this.#active.delete(op),()=>this.#active.delete(op));return op;
  }
  async #run(agent,raw,signal) {
    const request=validateVerificationCommand(raw);signal?.throwIfAborted();
    const actor=this.#controller.identity(agent);
    const {reference,input,workspaceRoot}=await this.#controller.executorFiles(agent,async p=>{
      const ref=await this.#files.capture(p);
      const payload=await verificationInput(this.#artifacts,ref,request);
      if(this.kind==='docker')await this.#store.dispatchRuntime({type:'dependency-profile-observed',project:actor.project,configVersion:actor.configVersion,
        fingerprint:profileFromFiles(JSON.parse(payload).files)?.fingerprint??null});
      return {reference:ref,input:payload,workspaceRoot:p.workspace};
    });
    await this.#controller.executorFiles(agent,()=>{signal?.throwIfAborted();if(this.#closed)throw Error('Verification service is closed');});
    let runName;
    const record=verificationRecorder(this.#store,{project:actor.project,reference,request,backend:this.kind});
    let rawResult;
    try {rawResult=await this.#backend.run(input,request,{project:actor.project,workspaceRoot,signal,recordOwnership:async entry=>{await record(entry);runName=entry.name;}});}
    catch(error) {
      if(error instanceof DependencyApprovalRequired)await this.#controller.executorFiles(agent,async p=>{
        signal?.throwIfAborted();if(this.#closed)throw Error('Verification service is closed');
        // An old snapshot cannot replace a newer dependency permission request.
        const current=await this.#files.capture(p),payload=await verificationInput(this.#artifacts,current,request);
        if(profileFromFiles(JSON.parse(payload).files)?.fingerprint===error.fingerprint)
          await this.#store.dispatchRuntime({type:'dependency-needed',project:actor.project,configVersion:actor.configVersion,fingerprint:error.fingerprint,task:actor.task,taskAttempt:actor.taskAttempt??1});
      });
      throw error;
    }
    const stdout=rawResult.stdout.slice(0,65536),stderr=rawResult.stderr.slice(0,65536-stdout.length);
    const result={...rawResult,stdout,stderr,truncated:rawResult.truncated || stdout.length+stderr.length<rawResult.stdout.length+rawResult.stderr.length};
    // Invalidated tasks can neither receive an authoritative success nor attach
    // their old verification to a replacement assignment. Captured files persist.
    await this.#controller.executorFiles(agent,async()=>{
      signal?.throwIfAborted();
      if(this.#closed)throw Error('Verification service is closed');
      await this.#store.dispatchRuntime({type:this.kind==='native'?'native-verification-result':'verification-result',name:runName,result});
    });
    return {reference,verification:runName,backend:this.kind,...result};
  }
  evidence(agent,{offset}={}) {
    if(this.#closed)throw Error('Verification service is closed');
    if(!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid evidence offset');
    const actor=this.#controller.identity(agent),p=this.#controller.view(actor.project),r=p.rounds[actor.round];
    if(actor.role!=='reviewer' || !['running','final-review'].includes(p.status) || actor.configVersion!==p.configVersion ||
      r?.status!=='open' || r.generation!==actor.generation || r.votes[actor.reviewer] ||
      actor.attempt!==(r.attempts[actor.reviewer]??0)+1)throw Error('Review assignment expired');
    const reference=r.payload.artifact;
    if(!reference)throw Error('Review has no captured artifact');
    const state=this.#store.snapshot();
    const entries=[...Object.values(state.verificationContainers??{}),...Object.values(state.verificationRuns??{})]
      .filter(e=>e.project===actor.project && e.reference===reference && e.status==='removed' && e.result);
    return structuredClone({reference,total:entries.length,nextOffset:offset+1<entries.length?offset+1:null,
      evidence:entries[offset]?{id:entries[offset].name,backend:entries[offset].backend??'docker',
        ...(entries[offset].backend==='native'?{sandbox:entries[offset].sandbox}:{image:entries[offset].image}),
        request:entries[offset].request,...entries[offset].result}:null});
  }
  close() {
    if(this.#closing)return this.#closing;this.#closed=true;
    this.#closing=(async()=>{await this.#backend.close();await Promise.allSettled([...this.#active]);})();return this.#closing;
  }
}
