import {validateVerificationCommand} from './container-verifier.mjs';

/** This callback is held by the host, not handed to an agent. A reservation is
 * fsynced before the container backend can attempt creation. */
export function verificationRecorder(store,{project,reference,request,backend='docker'}) {
  if(!['docker','native'].includes(backend))throw Error('Unknown verification backend');
  request=validateVerificationCommand(request);let name;
  return async entry=>{
    if((entry.backend==='native')!==(backend==='native'))throw Error('Verification recorder backend changed');
    if(name && name!==entry.name)throw new Error('Recorder belongs to another verification');
    if(!name && entry.status!=='reserved')throw new Error('Reservation required first');
    await store.dispatchRuntime({type:backend==='native'?'native-verification-record':'verification-record',entry:structuredClone(entry),project,reference,request});
    name=entry.name;
  };
}

/** A new journal owner must not report a crashed native run as successful or
 * assume its temporary directory is safe to delete. Retain its identity and
 * mark it interrupted; only fresh, drained-and-removed runs produce evidence. */
export async function recoverNativeVerifications(store) {
  let interrupted=0;
  for(const record of Object.values(store.snapshot().verificationRuns??{})) {
    if(!['reserved','running'].includes(record.status))continue;
    await store.dispatchRuntime({type:'native-verification-record',entry:{name:record.name,backend:'native',directory:record.directory,status:'interrupted'}});
    interrupted++;
  }
  return {interrupted};
}

/** Called before enabling a future verification service after restart. Only
 * exact journal-owned names/IDs may be removed; never prune the Docker daemon. */
export async function recoverVerificationContainers(store,runCli) {
  const failures=[];
  for(const record of Object.values(store.snapshot().verificationContainers??{})) {
    if(record.status==='removed')continue;
    try {
      if(!/^dsh-foreman-run-[a-f0-9-]{36}$/.test(record.name))throw new Error('Invalid saved container name');
      const listing=await runCli(['container','ls','--all','--filter',`name=^/${record.name}$`,'--format={{.ID}} -- {{.Names}}'],{timeoutMs:10000,maxOutputBytes:65536});
      if(listing.exitCode!==0)throw new Error('Cannot query owned containers');
      if(listing.stdout.trim()) {
        const inspected=await runCli(['inspect',record.name],{timeoutMs:10000,maxOutputBytes:65536});
        if(inspected.exitCode!==0)throw new Error('Cannot inspect reserved container');
        const values=JSON.parse(inspected.stdout),container=values[0];
        if(values.length!==1 || container.Name!=='/'+record.name || container.Image!==record.image ||
          container.Config?.Labels?.['dsh-foreman.verification']!=='true' || record.id && record.id!==container.Id)
          throw new Error('Container identity does not match durable ownership');
        if(!/^[a-f0-9]{64}$/.test(container.Id))throw new Error('Invalid inspected container ID');
        const removed=await runCli(['rm','-f','-v',container.Id],{timeoutMs:10000,maxOutputBytes:65536});
        if(removed.exitCode!==0)throw new Error('Owned container cleanup failed');
      }
      await store.dispatchRuntime({type:'verification-record',entry:{name:record.name,image:record.image,status:'removed'}});
    } catch(e){failures.push({name:record.name,error:e.message});}
  }
  if(failures.length)throw new Error('Verification recovery requires attention: '+JSON.stringify(failures));
}
